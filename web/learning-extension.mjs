/** Additive learning preserves published semantics and records exactly which extraction units ran. */
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

/** A plain multi-value attribute adds no identity or relation modeling decision.
 * This approves the candidate shape only; every new fact still needs source review.
 */
export function simpleAttributeExtension(schema,extension,requirements){
 if(!extension||extension.changedSourceIds?.length||!requirements?.length||!requirements.every(r=>r.mode==='ATTRIBUTE'))return false;
 const previous=extension.schema;
 if(!isDeepStrictEqual(schema.entity_types,previous.entity_types)||!isDeepStrictEqual(schema.entities,previous.entities))return false;
 try{validateExtension(schema,previous,{resolvableIds:extension.resolvableIds||[]});}catch{return false;}
 const added=schema.predicates.filter(p=>!previous.predicates.some(old=>old.id===p.id));
 if(!added.length||!added.every(p=>p.value_type==='STRING'&&p.cardinality==='MANY'&&!p.structural))return false;
 const plans=schema.cq_plans.filter(p=>!previous.cq_plans.some(old=>old.cq_id===p.cq_id));
 return plans.length>0&&plans.every(p=>p.template==='FACTS'&&added.some(a=>a.id===p.predicate_id)&&schema.entities.some(e=>e.id===p.subject_id)&&p.object_value===null);
}

export function evidenceLearningUnits(units,evidence,sources){
 assert(Array.isArray(evidence)&&evidence.length,'定向学习需要有效准入证据');
 for(const e of evidence){const source=sources.find(s=>s.id===e.source_id);assert(source&&source.sha256===e.source_sha256&&Number.isInteger(e.start)&&Number.isInteger(e.end)&&e.end>e.start&&source.content.slice(e.start,e.end)===e.quote,'定向学习的准入证据已失效');}
 const selected=units.filter(u=>evidence.some(e=>e.source_id===u.source_id&&e.start<u.end&&e.end>u.start));
 assert(selected.length,'准入证据没有对应资料窗口');return selected;
}

export function validateExtension(schema,previous,{resolvableIds=[]}={}){
  assert((previous.structural_predicate_ids||[]).every(id=>schema.structural_predicate_ids?.includes(id)),'持续学习不能撤下已发布结构谓词索引');
  for(const field of ['entity_types','entities','predicates','cq_plans']){
    const key=field==='cq_plans'?'cq_id':'id';
    for(const old of previous[field]){
      const candidate=schema[field].find(row=>row[key]===old[key]);
      if(field==='cq_plans'&&old.template==='UNKNOWN'&&resolvableIds.includes(old.cq_id)&&candidate)continue;
      const changed=candidate?Object.keys({...old,...candidate}).filter(k=>!isDeepStrictEqual(old[k],candidate[k])):['MISSING'];
      assert(candidate&&isDeepStrictEqual(candidate,old),'持续学习不能静默改写已有'+field+'，需独立修订流程；'+old[key]+' 差异字段：'+changed.join(',')+'。本次只追加，请逐字保留旧对象，包括reason等说明字段。');
    }
  }
  return schema;
}

export function extensionExtractionSchema(schema,previous,{targetPredicateIds=[]}={}){
  const oldPredicates=new Set(previous.predicates.map(p=>p.id));
  const predicates=schema.predicates.filter(p=>!oldPredicates.has(p.id)||targetPredicateIds.includes(p.id));
  const newSubjects=schema.entities.filter(e=>!previous.entities.some(old=>old.id===e.id));
  return {schema:{...schema,predicates:predicates.length?predicates:newSubjects.length?schema.predicates:[]},new_subject_ids:newSubjects.map(e=>e.id)};
}

export function selectLearningUnits(units,question){
  const tokens=[...new Set([...(question.match(/[A-Za-z0-9_-]{2,}/g)||[]),...[...question.matchAll(/[\p{Script=Han}]{2,}/gu)].flatMap(m=>{
    const chars=[...m[0]];return chars.slice(0,-1).map((_,i)=>chars.slice(i,i+2).join(''));
  })])];
  // A lexical match is a prioritization hint, never proof that other chunks contain no evidence.
  const matching=units.filter(unit=>tokens.some(token=>unit.text.toLowerCase().includes(token.toLowerCase())));
  return [...matching,...units.filter(unit=>!matching.includes(unit))];
}

/** Published facts are immutable inputs, not repair targets of an additive learning run. */
export function additiveReviewSelection(claims,retained=[]){
  const frozen=new Map(retained.map(c=>[c.id,c])),indices=[];
  for(const [index,claim] of claims.entries()){
    if(frozen.has(claim.id))assert(isDeepStrictEqual(claim,frozen.get(claim.id)),'新增学习不得改写已发布声明');
    else indices.push(index);
  }
  assert([...frozen.keys()].every(id=>claims.some(c=>c.id===id)),'新增学习不得丢失已发布声明');
  return {claims:indices.map(i=>claims[i]),indices};
}

/** Same-input published successors can supersede technical holds, never saved human decisions. */
export function resolveLearningHolds(store,job){
  if(job.status!=='READY'||job.result?.gate?.action!=='ACCEPT_CANDIDATE'||!job.learning)return [];
  const published=store.getRecord('library_candidate',job.id),state=published&&store.getRecord('library_state',published.base_id);
  if(published?.status!=='PUBLISHED'||state?.head_task_id!==job.id)return [];
  const ancestry=new Set([job.id]);let parent=job.revision?.parent_id;
  while(parent&&!ancestry.has(parent)){ancestry.add(parent);parent=store.getTask(parent)?.revision?.parent_id;}
  const resolved=[];
  for(const hold of store.listRecords('component_hold')){
    if(hold.status==='RESOLVED'||hold.base_id!==published.base_id||hold.source_epoch!==state.source_epoch)continue;
    const origin=store.getTask(hold.manifest?.origin_task_id||hold.id);
    if(!origin?.learning||origin.human_review||origin.component_submission||origin.learning.observation_id!==job.learning.observation_id||origin.learning.base_task_id!==job.learning.base_task_id||!isDeepStrictEqual(origin.input,job.input))continue;
    const issues=origin.result?.gate?.issues;
    const technical=issues?.length&&issues.every(i=>i.resolution==='AUTO_REVISE');
    // A changed-contract recheck is an explicit recorded path, not permission to
    // reinterpret arbitrary outstanding human decisions or unrelated candidates.
    const rechecked=issues?.length&&issues.every(i=>['AUTO_REVISE','NEEDS_USER'].includes(i.resolution))&&store.listRecords('review_contract_recheck').some(r=>r.parent_id===origin.id&&ancestry.has(r.task_id));
    if(!technical&&!rechecked)continue;
    store.putRecord('component_hold',hold.id,{...hold,status:'RESOLVED',resolved_by:job.id,resolution:technical?'SUPERSEDED_BY_REVALIDATED_LEARNING':'SUPERSEDED_BY_PUBLISHED_CONTRACT_RECHECK'});resolved.push(hold.id);
  }
  return resolved;
}
