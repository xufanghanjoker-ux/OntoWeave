/** Query-local deterministic seen-content projection; no semantic merging. */
import {clone,hash} from './cq-discovery-store-v2.mjs';
const semantic=['kind','original_kind','representation','index_origin','policy','subject_ref','object_ref','predicate','direction','attribute','raw_value','unit','rule_text','rule_name','participants','attributes','conditions','negation','modality','time_text','version_text','exceptions','warnings','text','statement','surface','name','label','aliases','description','source_refs','evidence','doc_ref','revision','start','end','origin_precision','mapping_precision','nodes','edges','steps','author','origin_layer','answer_authority','review_event_ref','review_source_revision_ref','human_sources','definition_sources','definition_selection_status','definition_selection_warnings'];
const pick=(row,keys)=>Object.fromEntries(keys.filter(k=>row[k]!==undefined).map(k=>[k,clone(row[k])]));
export const queryRecordBodyHash=row=>hash(pick(row,semantic));
function identity(row){
 if(row.fact_ref||row.knowledge_ref)return ['KNOWLEDGE',row.fact_ref??row.knowledge_ref];
 if(row.path_ref)return ['PATH',row.path_ref];
 if(row.doc_ref&&row.revision&&Number.isSafeInteger(row.start)&&Number.isSafeInteger(row.end))return ['SOURCE',row.doc_ref,row.revision,row.start,row.end];
 if(row.record_ref)return ['RECORD',row.record_ref];
 if(row.subject_ref&&row.surface)return ['ENTITY',row.subject_ref];
 return null;
}
export function createQueryIncremental({scope}){
 const seen=new Map(),delivered=new Map(),referenced=new Set();let totalNew=0,totalSeen=0;
 function remember(input){
  const ref=input.fact_ref??input.knowledge_ref;
  if(ref){
   referenced.add(ref);
   const full=Boolean(input.text?.trim?.()||input.rule_text?.trim?.()),summary=Boolean(input.statement?.trim?.()||Object.hasOwn(input,'raw_value'));
   if(full||summary)delivered.set(ref,{state:full?'FULL':'SUMMARY',body_sha256:queryRecordBodyHash(input),source_refs:clone(input.source_refs??[])});
  }
  for(const related of input.knowledge_refs??[])referenced.add(related);
  // Only actual nested fact bodies count; knowledge_refs alone never do.
  for(const step of input.steps??[])if(step.fact)remember(step.fact);
 }
 return {navigation(value){
  const states=value.records.map(record=>{const prior=delivered.get(record.record_ref),sameSource=prior&&hash(prior.source_refs)===hash(record.source_refs??[]);
   const state=sameSource&&prior.body_sha256===record.body_sha256?prior.state:sameSource&&prior.state==='SUMMARY'?'SUMMARY':'UNREAD';
   const {body_sha256,...metadata}=record;return {...metadata,delivery_state:state,reference_only:state==='UNREAD'};
  });
  const counts={full:0,summary:0,unread:0};for(const row of states)counts[row.delivery_state.toLowerCase()]++;
  const records=states.slice(0,24);for(const row of records)referenced.add(row.record_ref);
  return {...value,records,counts,records_truncated:states.length>records.length,records_limit:24,delivery_basis:'ACTUALLY_RETURNED_KNOWLEDGE_BODY_NOT_SOURCE_FULLTEXT',semantic_coverage:'NOT_CERTIFIED'};
 },coverage(){return {version:'query-delivery-coverage/1',full_records:[...delivered.values()].filter(r=>r.state==='FULL').length,summary_records:[...delivered.values()].filter(r=>r.state==='SUMMARY').length,reference_only_records:[...referenced].filter(ref=>!delivered.has(ref)).length,meaning:'COUNTS_ARE_RECORD_DELIVERY_NOT_USEFULNESS_OR_QUESTION_COVERAGE'};},project(result,{reread=false}={}){
  const counts={matched_records:0,new_records:0,seen_records:0,changed_records:0,reread_records:0},before=JSON.stringify(result);
  function row(input){
   const key=identity(input);if(!key)return clone(input);counts.matched_records++;remember(input);
   const id=hash({scope,key}),signature=hash({body:pick(input,semantic),citation_qualification:(input.citations??[]).map(c=>pick(c,['kind','representation','conditions','warnings','sources','records','human_sources','definition_sources','definition_selection_status','definition_selection_warnings']))}),previous=seen.get(id),duplicate=previous===signature;
   if(duplicate){counts.seen_records++;if(reread){counts.reread_records++;return {...clone(input),already_seen:true,explicit_reread:true};}
    return {...pick(input,['record_ref','fact_ref','knowledge_ref','subject_ref','path_ref','doc_ref','revision','start','end','kind','surface','name','label','aliases','types','exact_match','conditions','negation','modality','unit','time_text','version_text','exceptions','warnings','representation','source_refs','origin_precision','mapping_precision','citation_refs','citations','citation_markers','author','origin_layer','answer_authority','review_event_ref','review_source_revision_ref','human_sources','definition_sources','definition_selection_status','definition_selection_warnings']),already_seen:true,body_in_previous_result:true};
   }
   counts.new_records++;if(previous)counts.changed_records++;seen.set(id,signature);return clone(input);
  }
  function project(value){const out=clone(value);if(Array.isArray(value.items))out.items=value.items.map(row);if(Array.isArray(value.entities))out.entities=value.entities.map(row);if(value.neighbors)out.neighbors=project(value.neighbors);return out;}
  const out=project(result);totalNew+=counts.new_records;totalSeen+=counts.seen_records;
  out.incremental={...counts,total_new_records:totalNew,total_seen_records:totalSeen,has_next_page:Boolean(result.next_cursor),truncated:Boolean(result.truncated),coverage:'LOCAL_RESULTS_NOT_SEMANTIC_COVERAGE',zero_new_does_not_prove_absence:counts.new_records===0,record_counts_do_not_measure_usefulness:true,uncompressed_bytes:Buffer.byteLength(before)};
  if(counts.matched_records&&counts.new_records===0)out.status='NO_NEW_INFORMATION';
  out.incremental.delivered_bytes=0;for(let i=0;i<4;i++){const bytes=Buffer.byteLength(JSON.stringify(out));if(bytes===out.incremental.delivered_bytes)break;out.incremental.delivered_bytes=bytes;}return out;
 }};
}
