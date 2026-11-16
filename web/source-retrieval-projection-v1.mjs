/** Host projections only. All ranking, expansion, fusion and budgets execute Rust. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
export const contractVersion='lightog-hybrid-retrieval/0.1';
export const defaultOptions=Object.freeze({channel_top_k:20,result_top_k:12,rrf_k:60,max_graph_neighbors:12,max_context_utf16:16000,max_context_tokens:null,min_cosine:0});
export function projectRecords({evidenceSets,p2Build=null}){
 assert(Array.isArray(evidenceSets)&&evidenceSets.length,'Evidence sets required');
 const snapshot=evidenceSets[0].snapshot,fragments=new Map(),records=[],ownerRecords=new Map();
 for(const es of evidenceSets){assert(isDeepStrictEqual(es.snapshot,snapshot),'Cannot project mixed snapshots');for(const f of es.fragments){if(fragments.has(f.id))assert(isDeepStrictEqual(fragments.get(f.id),f),'Evidence ID collision');else{fragments.set(f.id,f);records.push({id:'doc:'+f.id,kind:'DOCUMENT',text:f.span.quote,entity_refs:[],evidence_ids:[f.id],status:'SOURCE',profile:null,embedding:null});}}}
 for(const p of p2Build?.profiles||[]){
  assert(isDeepStrictEqual(p.snapshot,snapshot),'Candidate profile snapshot mismatch');assert.equal(p.status,'DISCOVERY_HINT');
  assert(Array.isArray(p.evidence_refs)&&p.evidence_refs.length,'Candidate profile needs raw evidence');
  for(const ref of p.evidence_refs){const es=evidenceSets.find(es=>es.evidence_set_id===ref.evidence_set_ref);assert(es?.fragments.some(f=>f.id===ref.evidence_id),'Profile evidence unresolved');}
  const kind=p.kind==='ATTRIBUTE'?'RELATION':p.kind;assert(['ENTITY','RELATION','PATTERN'].includes(kind));
  const id='profile:'+p.id;assert(!records.some(r=>r.id===id),'Duplicate profile ID');
  records.push({id,kind,text:p.text,entity_refs:[...p.entity_refs],evidence_ids:[...new Set(p.evidence_refs.map(e=>e.evidence_id))],status:'DISCOVERY_HINT',profile:null,embedding:null});
  assert(!ownerRecords.has(p.owner_id),'Multiple records for one graph owner');ownerRecords.set(p.owner_id,id);
 }
 const edges=[];
 for(const statement of p2Build?.graph?.statements||[]){
  const relation=ownerRecords.get(statement.id);if(!relation)continue;
  for(const entity of [statement.subject_id,statement.object?.entity_id].filter(Boolean)){
   const target=ownerRecords.get(entity);if(target)edges.push({id:'edge:'+statement.id+':'+entity,source_record_id:relation,target_record_id:target,evidence_ids:[...new Set(statement.evidence_refs.map(e=>e.evidence_id))],status:'DISCOVERY_HINT'});
  }
 }
 for(const pattern of p2Build?.graph?.patterns||[]){
  const source=ownerRecords.get(pattern.id);if(!source)continue;
  for(const role of pattern.roles||[]){const target=ownerRecords.get(role.entity_id);if(target)edges.push({id:'edge:'+pattern.id+':'+role.entity_id+':'+role.role,source_record_id:source,target_record_id:target,evidence_ids:[...new Set(pattern.evidence_refs.map(e=>e.evidence_id))],status:'DISCOVERY_HINT'});}
 }
 return {snapshot,records,edges};
}
export function searchPayload({question,queries,context,evidenceSets,p2Build=null,options={},manifests=[],queryVectors=[],rerank=null,evidenceTokenCounts={},tokenizer=null}){
 const projected=projectRecords({evidenceSets,p2Build});
 return {contract_version:contractVersion,question,queries:queries||{document:question,entity:question,relation:question},snapshot:projected.snapshot,trusted_index:{records:projected.records,edges:projected.edges,manifests,context,evidence_token_counts:evidenceTokenCounts,tokenizer},query_vectors:queryVectors,rerank,options:{...defaultOptions,...options}};
}
