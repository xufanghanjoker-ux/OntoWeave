/** Local, pure alignment over saved domain records. No model or persistence. */
import {hash,clone,need,textField} from './cq-discovery-store-v2.mjs';
import {createDomainGraph,DOMAIN_SEMANTIC_POLICY} from './native-domain-knowledge-v1.mjs';
const list=v=>Array.isArray(v)?v:[],object=v=>v&&typeof v==='object'&&!Array.isArray(v),refOf=r=>r?.record_ref??r?.knowledge_ref;
const unique=rows=>[...new Map(rows.map(r=>[hash(r),r])).values()];
const nameKey=v=>textField(v)?v.normalize('NFKC').trim().toLocaleLowerCase():'';
const names=e=>[e.name,e.label,...list(e.aliases)].map(nameKey).filter(Boolean);
const usable=d=>['USABLE','CONFIRMED','ACTIVE'].includes(d?.status)&&!d.requested_pending;
const kindOf=d=>d?.kind==='TYPE'?'CLASS':d?.kind;
const sourceOf=r=>({record_ref:refOf(r),record_sha256:hash(r),source_refs:clone(list(r.source_refs)),evidence_refs:unique([...list(r.evidence_refs),...list(r.evidence).map(e=>e.evidence_ref).filter(textField)]),...(r.statement||r.text?{text:r.statement??r.text}:{}),...Object.fromEntries(['conditions','exceptions','negation','modality','time_text','version_text','unit','raw_value','comparison'].filter(k=>Object.hasOwn(r,k)).map(k=>[k,clone(r[k])]))});
function occurrences(row){
 const result=[];if(row.domain?.definition&&textField(row.domain.definition.name)){const d=row.domain.definition;result.push({kind:kindOf(d),label:d.name,path:'domain.definition',definition_ref:d.definition_ref,proven:usable(d)});}
 for(const [index,e] of list(row.domain?.entities).entries())if(textField(e.entity_type))result.push({kind:'CLASS',label:e.entity_type,entity_id:e.id,path:'domain.entities.'+index,definition_ref:e.type_definition_ref,proven:e.type_alignment?.status==='ALIGNED'});
 if(row.kind==='RELATION'&&textField(row.predicate))result.push({kind:'RELATION',label:row.predicate,path:'predicate',definition_ref:row.predicate_definition_ref??row.ontology_alignment?.definition_ref,proven:row.ontology_alignment?.status==='ALIGNED'});
 if(row.domain?.relation&&textField(row.domain.relation.predicate))result.push({kind:'RELATION',label:row.domain.relation.predicate,path:'domain.relation.predicate',definition_ref:row.domain.relation.definition_ref??row.relation_ontology_alignment?.definition_ref,proven:row.relation_ontology_alignment?.status==='ALIGNED'});
 if(row.kind==='ATTRIBUTE'&&textField(row.attribute))result.push({kind:'ATTRIBUTE',label:row.attribute,path:'attribute',definition_ref:row.attribute_definition_ref??row.ontology_alignment?.definition_ref,proven:row.ontology_alignment?.status==='ALIGNED'});
 return result;
}
function validEvidence(decision,candidate){
 if(!textField(decision.reason))return false;
 const sides=[candidate.source,candidate.target?.source].filter(Boolean),sources=sides.flatMap(s=>list(s.source_refs)),evidence=sides.flatMap(s=>list(s.evidence_refs));
 const requestedSources=list(decision.source_refs),requestedEvidence=list(decision.evidence_refs);
 return requestedSources.length+requestedEvidence.length>0&&requestedSources.every(s=>sources.some(known=>hash(s)===hash(known)))&&requestedEvidence.every(ref=>evidence.includes(ref));
}
function rewriteEntity(row,from,to){
 const replace=id=>id===from?to:id;
 row.domain.entities=list(row.domain?.entities).map(e=>e.id===from?{...e,id:to,source_local_entity_id:from}:e);
 if(row.subject_ref)row.subject_ref=replace(row.subject_ref);if(row.object_ref)row.object_ref=replace(row.object_ref);
 if(row.domain?.relation){row.domain.relation.subject=replace(row.domain.relation.subject);row.domain.relation.object=replace(row.domain.relation.object);}
 row.participants=list(row.participants).map(p=>({...p,subject_ref:replace(p.subject_ref)}));
}
function bindDefinition(row,occurrence,definition,reason){
 const binding={status:'ALIGNED',definition_ref:definition.definition_ref,original_label:occurrence.label,reason};
 if(occurrence.path==='domain.definition'){row.domain.definition={...clone(definition),source_local_definition:clone(row.domain.definition)};delete row.domain.definition.source;}
 else if(occurrence.kind==='CLASS'){const e=row.domain.entities[Number(occurrence.path.split('.').at(-1))];if(e){e.entity_type=definition.name;e.type_definition_ref=definition.definition_ref;e.type_alignment=binding;}}
 else if(occurrence.path==='predicate'){row.predicate=definition.name;row.predicate_definition_ref=definition.definition_ref;row.ontology_alignment=binding;}
 else if(occurrence.path==='domain.relation.predicate'){row.domain.relation.predicate=definition.name;row.domain.relation.definition_ref=definition.definition_ref;row.relation_ontology_alignment=binding;}
 else{row.attribute=definition.name;row.attribute_definition_ref=definition.definition_ref;row.ontology_alignment=binding;}
}
/** knowledge is the changed batch; return knowledge is the complete derived view.
 * Decisions: {candidate_ref,action:same|different|reuse|pending,reason,
 * source_refs/evidence_refs}. Caller persists decisions/history and uses affected
 * refs to update indexes; this pure function does not manage conflict decisions.
 */
export function applySimplifiedAlignment({knowledge,previousKnowledge=[],decisions=[]}){
 need(Array.isArray(knowledge)&&Array.isArray(previousKnowledge)&&Array.isArray(decisions),'SIMPLIFIED_ALIGNMENT_INPUT_INVALID');
 for(const row of [...previousKnowledge,...knowledge])need(object(row)&&textField(refOf(row)),'SIMPLIFIED_ALIGNMENT_RECORD_REF_REQUIRED');
 const previous=new Map(previousKnowledge.map(r=>[refOf(r),clone(r)])),combined=new Map(previous),changed=new Set();
 for(const row of knowledge){const ref=refOf(row);if(!previous.has(ref)||hash(previous.get(ref))!==hash(row))changed.add(ref);combined.set(ref,clone(row));}
 const rows=[...combined.values()],candidates=[],applied=[],pending=[],entityEntries=[];
 for(const row of rows)for(const entity of list(row.domain?.entities))if(textField(entity?.id))entityEntries.push({row,entity});
 const definitions=rows.flatMap(row=>{const d=row.domain?.definition;return object(d)&&textField(d.definition_ref)?[{...clone(d),source:sourceOf(row)}]:[];});
 const definitionByRef=new Map();for(const d of definitions){const old=definitionByRef.get(d.definition_ref);if(!old)definitionByRef.set(d.definition_ref,d);else if(hash({...old,source:null,source_local_definition:null})!==hash({...d,source:null,source_local_definition:null}))definitionByRef.set(d.definition_ref,null);}
 const addCandidate=data=>{const c={...data,candidate_ref:'simplified_candidate_'+hash(data)};candidates.push(c);return c;};
 const newPending=(candidate,reason)=>pending.push({candidate_ref:candidate.candidate_ref,kind:candidate.kind,record_ref:candidate.record_ref,reason,source:clone(candidate.source),...(candidate.target?{target:clone(candidate.target)}:{})});
 // Candidate retrieval touches only new/changed mentions; matching names is a
 // recall operation. No canonical assignment follows from lexical similarity.
 for(const row of rows.filter(r=>changed.has(refOf(r)))){
  const source=sourceOf(row);
  for(const entity of list(row.domain?.entities)){
   if(!textField(entity?.id)){const c=addCandidate({kind:'ENTITY',record_ref:refOf(row),source,mention:clone(entity),problem:'ENTITY_ID_MISSING'});newPending(c,'ENTITY_ID_MISSING');continue;}
   const sameId=entityEntries.filter(e=>e.row!==row&&e.entity.id===entity.id);
   if(sameId.length)applied.push({kind:'ENTITY',record_ref:refOf(row),entity_id:entity.id,basis:'EXACT_HOST_ENTITY_ID',source});
   const matches=entityEntries.filter(e=>e.entity.id!==entity.id&&names(entity).some(n=>names(e.entity).includes(n))),dedup=new Map(matches.map(e=>[e.entity.id,e]));
   for(const target of dedup.values())addCandidate({kind:'ENTITY',record_ref:refOf(row),source,mention:clone(entity),target:{entity_id:target.entity.id,entity:clone(target.entity),source:sourceOf(target.row)}});
  }
  for(const occurrence of occurrences(row)){
   const target=definitionByRef.get(occurrence.definition_ref);
   if(target&&usable(target)&&kindOf(target)===occurrence.kind&&occurrence.proven){bindDefinition(row,occurrence,target,'EXACT_CONFIRMED_DEFINITION_REFERENCE');applied.push({kind:occurrence.kind,record_ref:refOf(row),path:occurrence.path,definition_ref:target.definition_ref,basis:'EXACT_CONFIRMED_DEFINITION_REFERENCE',source});continue;}
   const matches=definitions.filter(d=>kindOf(d)===occurrence.kind&&(d.definition_ref===occurrence.definition_ref||[d.name,...list(d.observed_labels),...list(d.aliases)].some(n=>nameKey(n)===nameKey(occurrence.label))));
   if(!matches.length){const c=addCandidate({kind:occurrence.kind,record_ref:refOf(row),source,occurrence:clone(occurrence),problem:occurrence.definition_ref?'DEFINITION_BINDING_UNCONFIRMED':'NEW_DEFINITION_CANDIDATE'});newPending(c,c.problem);}
   else for(const d of unique(matches))addCandidate({kind:occurrence.kind,record_ref:refOf(row),source,occurrence:clone(occurrence),target:{definition:clone(d),source:clone(d.source)}});
  }
 }
 const choices=new Map();
 for(const decision of decisions){const c=candidates.find(c=>c.candidate_ref===decision?.candidate_ref);
  if(!c){pending.push({reason:'DECISION_CANDIDATE_UNKNOWN_OR_STALE',decision:clone(decision)});continue;}
  if(!['same','different','reuse','pending'].includes(decision.action)||!validEvidence(decision,c)){pending.push({candidate_ref:c.candidate_ref,reason:'DECISION_BASIS_INVALID',decision:clone(decision),source:c.source});continue;}
  const existing=choices.get(c.candidate_ref);if(existing&&hash(existing)!==hash(decision)){choices.set(c.candidate_ref,null);pending.push({candidate_ref:c.candidate_ref,reason:'DECISION_CONFLICT',source:c.source});}else if(existing!==null)choices.set(c.candidate_ref,clone(decision));
 }
 // A mention/definition occurrence may have several recalled targets. Conflicting
 // positive targets are retained together; ordering never chooses a winner.
 const positives=new Map();
 for(const c of candidates){const d=choices.get(c.candidate_ref);if(!d||!['same','reuse'].includes(d.action))continue;const key=hash([c.record_ref,c.kind,c.mention?.id??c.occurrence?.path]);const group=positives.get(key)??[];group.push(c);positives.set(key,group);}
 const identityRedirects=new Map(),resolveIdentity=id=>{const seen=new Set();while(identityRedirects.has(id)&&!seen.has(id)){seen.add(id);id=identityRedirects.get(id);}return id;};
 const blocked=new Set([...positives.values()].filter(g=>g.length>1).flatMap(g=>g.map(c=>c.candidate_ref)));
 for(const c of candidates){if(c.problem)continue;const decision=choices.get(c.candidate_ref),row=combined.get(c.record_ref);
  if(blocked.has(c.candidate_ref)){newPending(c,'MULTIPLE_ALIGNMENT_TARGETS');continue;}
  if(!decision||decision.action==='pending'){newPending(c,c.kind==='ENTITY'?'ENTITY_IDENTITY_UNRESOLVED':'DEFINITION_MEANING_UNRESOLVED');continue;}
  if(decision.action==='different'){applied.push({candidate_ref:c.candidate_ref,kind:c.kind,record_ref:c.record_ref,action:'different',reason:decision.reason,source:c.source});continue;}
  if(c.kind==='ENTITY'&&decision.action==='same'&&textField(c.target?.entity_id)){
   const from=resolveIdentity(c.mention.id),to=resolveIdentity(c.target.entity_id);if(from===to){applied.push({candidate_ref:c.candidate_ref,kind:c.kind,record_ref:c.record_ref,action:'same',canonical_entity_id:to,reason:decision.reason,source:c.source});continue;}identityRedirects.set(from,to);
   for(const affected of rows.filter(r=>[r.subject_ref,r.object_ref,r.domain?.relation?.subject,r.domain?.relation?.object,...list(r.participants).map(p=>p.subject_ref)].includes(from)||list(r.domain?.entities).some(e=>e.id===from))){affected.simplified_alignment??={source_local:{domain:clone(affected.domain),subject_ref:affected.subject_ref??null,object_ref:affected.object_ref??null,participants:clone(affected.participants??[])},decisions:[]};rewriteEntity(affected,from,to);affected.simplified_alignment.decisions.push(clone(decision));changed.add(refOf(affected));}
  }else if(c.kind!=='ENTITY'&&decision.action==='reuse'&&c.target?.definition&&usable(c.target.definition)&&definitionByRef.get(c.target.definition.definition_ref)){
   row.simplified_alignment??={source_local:{domain:clone(row.domain),predicate:row.predicate??null,attribute:row.attribute??null},decisions:[]};bindDefinition(row,c.occurrence,c.target.definition,decision.reason);row.simplified_alignment.decisions.push(clone(decision));changed.add(c.record_ref);
  }else{newPending(c,'DECISION_TARGET_NOT_ADOPTABLE');continue;}
  applied.push({candidate_ref:c.candidate_ref,kind:c.kind,record_ref:c.record_ref,action:decision.action,reason:decision.reason,source:c.source,target:clone(c.target)});
 }
 const result=[...combined.values()],graph=createDomainGraph(result);
 // The existing graph's lexical definition summaries are observations, not
 // canonical ontology identities. Keep separate source-bound occurrences here.
 graph.definitions=result.filter(r=>r.semantic_policy===DOMAIN_SEMANTIC_POLICY).flatMap(row=>occurrences(row).map(o=>{const known=definitionByRef.get(o.definition_ref),confirmed=known&&usable(known)&&o.proven;return {id:confirmed?o.definition_ref:'observed_definition_'+hash([refOf(row),o.path,o.label]),kind:o.kind,name:o.label,definition_ref:confirmed?o.definition_ref:null,status:confirmed?'ALIGNED':'PENDING',record_refs:[refOf(row)],source_refs:clone(list(row.source_refs)),description:confirmed?known.description??null:null};}));
 const grouped=new Map();for(const d of graph.definitions){const old=grouped.get(d.id);grouped.set(d.id,old?{...d,record_refs:[...new Set([...old.record_refs,...d.record_refs])],source_refs:unique([...old.source_refs,...d.source_refs])}:d);}graph.definitions=[...grouped.values()];
 return {knowledge:result,graph,alignment:{pending:unique(pending),candidates,applied:unique(applied)},affected_record_refs:[...changed].sort()};
}

/** Host cursor paging for the local candidate tool; oversize rows use explicit
 * fragments rather than truncated business objects. No graph/history is added.
 */
export function pageSimplifiedAlignmentCandidates({candidates,after=0,offset=0,max_items=8,max_chars=12000}){
 need(Array.isArray(candidates)&&Number.isSafeInteger(after)&&after>=0&&Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(max_items)&&max_items>0&&Number.isSafeInteger(max_chars)&&max_chars>=256,'SIMPLIFIED_ALIGNMENT_PAGE_INVALID');
 const items=[];let chars=0,next_after=null,next_offset=0;
 for(let i=after;i<candidates.length;i++){
  const row=candidates[i],json=JSON.stringify(row);
  if(items.length>=max_items||chars+json.length>max_chars){
   if(items.length){next_after=i;break;}
   need(offset<json.length,'SIMPLIFIED_ALIGNMENT_PAGE_OFFSET_INVALID');let end=Math.min(json.length,offset+max_chars);if(end<json.length&&/[\uD800-\uDBFF]/.test(json[end-1])&&/[\uDC00-\uDFFF]/.test(json[end]))end--;
   items.push({candidate_ref:row.candidate_ref,fragment_json:json.slice(offset,end),offset,total_chars:json.length,complete:end===json.length});if(end<json.length){next_after=i;next_offset=end;}else if(i+1<candidates.length)next_after=i+1;break;
  }
  need(offset===0,'SIMPLIFIED_ALIGNMENT_PAGE_OFFSET_INVALID');items.push(clone(row));chars+=json.length;
 }
 return {items,total:candidates.length,next_after,next_offset,has_more:next_after!==null};
}
