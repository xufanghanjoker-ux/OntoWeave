/** Conservative dependency closure. Never treats the absence of an issue as publication approval. */
import {sha,validateSchema,validateClaims,queryPlanIssues} from './engine.mjs';
import {validateExtension} from './learning-extension.mjs';
export function planComponentPublication(base,job,{allowUnchanged=false,allowNoIssues=false}={}){
  const no=reason=>({eligible:false,reason});
  if(!base||base.status!=='READY'||job.status!=='REVIEW_REQUIRED'||job.result?.review_stage!=='claims_review')return no('NO_PUBLISHED_BASE_OR_CLAIMS_REVIEW');
  if(sha([base.input.definitions,base.input.as_of])!==sha([job.input.definitions,job.input.as_of]))return no('GLOBAL_SEMANTICS_CHANGED');
  const schema=structuredClone(job.result.schema),prior=base.result.schema;
  const fields={entity_types:['id','label'],entities:['id','name','type'],predicates:['id','label','value_type','unit','cardinality'],cq_plans:['cq_id','template','subject_id','subject_ids','predicate_id','object_value','reason']};
  if(Object.keys(schema).some(k=>!fields[k])||Object.entries(fields).some(([key,allowed])=>schema[key]?.some(row=>Object.keys(row).some(k=>!allowed.includes(k)))))return no('UNSUPPORTED_DEPENDENCY_FIELDS');
  try{validateSchema(schema,job.input);validateExtension(schema,prior,{resolvableIds:prior.cq_plans.filter(p=>p.template==='UNKNOWN').map(p=>p.cq_id)});}catch{return no('NON_ADDITIVE_ONTOLOGY');}
  const predicates=schema.predicates.map(p=>p.id),parent=new Map(predicates.map(p=>[p,p]));
  const find=p=>parent.get(p)===p?p:find(parent.get(p));
  const join=items=>{const unique=[...new Set(items)].filter(p=>parent.has(p));for(const p of unique.slice(1))parent.set(find(p),find(unique[0]));};
  const entityRefs=new Map(schema.entities.map(e=>[e.id,new Set()]));
  const ref=(id,p)=>{if(entityRefs.has(id)&&parent.has(p))entityRefs.get(id).add(p);};
  for(const c of job.result.claims){ref(c.subject_id,c.predicate_id);if(schema.predicates.find(p=>p.id===c.predicate_id)?.value_type==='ENTITY')ref(c.value,c.predicate_id);}
  for(const p of schema.cq_plans){for(const id of [p.subject_id,...(p.subject_ids||[])])ref(id,p.predicate_id);if(schema.predicates.find(x=>x.id===p.predicate_id)?.value_type==='ENTITY')ref(p.object_value,p.predicate_id);}
  for(const entity of schema.entities)if(!prior.entities.some(e=>e.id===entity.id))join([...entityRefs.get(entity.id)]);
  for(const type of schema.entity_types)if(!prior.entity_types.some(t=>t.id===type.id))join(schema.entities.filter(e=>e.type===type.id).flatMap(e=>[...entityRefs.get(e.id)]));
  // Overlapping evidence is one dependency component, including cross-attribute statements.
  for(const [i,a] of job.result.claims.entries())for(const b of job.result.claims.slice(i+1))if(a.source_id===b.source_id&&a.start<b.end&&b.start<a.end)join([a.predicate_id,b.predicate_id]);
  const blocked=new Set(),issues=job.result.gate?.issues||[],issueRefs=[];if(!issues.length&&!allowNoIssues)return no('NO_BOUND_ISSUES');
  for(const issue of issues){
    let refs=[],match;
    if((match=issue.target?.match(/^\/claims\/(\d+)(?:\/|$)/))){const c=job.result.claims[Number(match[1])];if(c)refs=[c.predicate_id];}
    else if(issue.target==='/claims'&&issue.evidence_ids?.length)refs=job.result.claims.filter(c=>issue.evidence_ids.includes(c.evidence_id)).map(c=>c.predicate_id);
    else if((match=issue.target?.match(/^\/schema\/predicates\/(\d+)(?:\/|$)/)))refs=[schema.predicates[Number(match[1])]?.id];
    else if((match=issue.target?.match(/^\/schema\/cq_plans\/(\d+)(?:\/|$)/)))refs=[schema.cq_plans[Number(match[1])]?.predicate_id];
    else if((match=issue.target?.match(/^\/schema\/entities\/(\d+)(?:\/|$)/)))refs=[...(entityRefs.get(schema.entities[Number(match[1])]?.id)||[])];
    else return no('UNBOUNDED_ISSUE');
    if(!refs.length||refs.some(p=>!parent.has(p)))return no('UNBOUND_DEPENDENCY');
    for(const cqId of issue.cq_ids||[]){const p=schema.cq_plans.find(p=>p.cq_id===cqId);if(!p)return no('UNKNOWN_CQ_DEPENDENCY');if(p.predicate_id)refs.push(p.predicate_id);}
    join(refs);issueRefs.push(refs);
  }
  for(const refs of issueRefs)for(const p of refs)blocked.add(find(p));
  // Previously withheld dependencies stay withheld unless independently revalidated in this full candidate.
  const held=predicates.filter(p=>blocked.has(find(p))),safe=predicates.filter(p=>!blocked.has(find(p)));
  const signature=(result,p)=>sha([result.schema.predicates.find(x=>x.id===p)||null,result.claims.filter(c=>c.predicate_id===p).map(c=>[c.id,sha(c)]).sort(),result.schema.cq_plans.filter(x=>x.predicate_id===p)]);
  if(!allowUnchanged&&!safe.some(p=>signature(base.result,p)!==signature(job.result,p)))return {...no('NO_INDEPENDENT_CHANGE'),hold:{origin_task_id:job.id,held_predicate_ids:held,held_cq_ids:schema.cq_plans.filter(p=>held.includes(p.predicate_id)).map(p=>p.cq_id)}};
  const retainedPredicates=schema.predicates.filter(p=>safe.includes(p.id)||prior.predicates.some(old=>old.id===p.id));
  const heldCqs=schema.cq_plans.filter(p=>held.includes(p.predicate_id)).map(p=>p.cq_id);
  schema.predicates=retainedPredicates;
  schema.cq_plans=schema.cq_plans.map(p=>heldCqs.includes(p.cq_id)&&!prior.cq_plans.some(old=>old.cq_id===p.cq_id&&old.template!=='UNKNOWN')?
    {cq_id:p.cq_id,template:'UNKNOWN',subject_id:null,predicate_id:null,object_value:null,reason:'相关依赖正在核对，尚未发布。'}:p);
  const claims=job.result.claims.filter(c=>safe.includes(c.predicate_id));
  const needed=new Set([...prior.entities.map(e=>e.id),...claims.flatMap(c=>[c.subject_id,...(schema.predicates.find(p=>p.id===c.predicate_id)?.value_type==='ENTITY'?[c.value]:[])]),...schema.cq_plans.flatMap(p=>[p.subject_id,...(p.subject_ids||[]),...(schema.predicates.find(x=>x.id===p.predicate_id)?.value_type==='ENTITY'?[p.object_value]:[])])]);
  schema.entities=schema.entities.filter(e=>needed.has(e.id));const neededTypes=new Set([...prior.entity_types.map(t=>t.id),...schema.entities.map(e=>e.type)]);schema.entity_types=schema.entity_types.filter(t=>neededTypes.has(t.id));
  try{validateSchema(schema,job.input);if(queryPlanIssues(schema,job.input).length)return no('INCOMPLETE_QUERY_DEPENDENCIES');const checked=validateClaims({claims},schema,job.input,{collectErrors:true});if(checked.issues.length||checked.claims.length!==claims.length)return no('INVALID_COMPONENT_EVIDENCE');}catch{return no('INCOMPLETE_DEPENDENCIES');}
  const components=[...new Set(predicates.map(find))].map(root=>({id:'component_'+sha([job.id,root]).slice(0,24),predicate_ids:predicates.filter(p=>find(p)===root),issue_indexes:issueRefs.flatMap((refs,i)=>refs.some(p=>find(p)===root)?[i]:[]),status:blocked.has(root)?'HELD':'REVIEW_REQUIRED'}));
  const manifest={version:'dependency_components_v1',origin_task_id:job.id,base_task_id:base.id,source_hash:sha(job.input.sources),origin_result_hash:sha(job.result),safe_predicate_ids:safe,held_predicate_ids:held,held_cq_ids:heldCqs,components};
  return {eligible:true,candidate:{schema,claims},manifest,hash:sha(manifest)};
}
