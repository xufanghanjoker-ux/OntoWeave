/** Query-only ordering: conservative duplicate display groups, optional rerank. */
import {clone,hash,need} from './cq-discovery-store-v2.mjs';
export const QUERY_RANKING_REVISION='native-query-bm25-rrf/2';
export const QUERY_DELIVERY_REVISION='native-query-display-rerank/2';
// Fixed before evaluation. This is a candidate window, not the delivery page size.
export const DEFAULT_RERANK_WINDOW=64;
const pick=(row,keys)=>Object.fromEntries(keys.filter(k=>row[k]!==undefined).map(k=>[k,row[k]]));
const duplicateFields=['kind','subject_ref','object_ref','predicate','direction','attribute','raw_value','unit','rule_text','rule_name','participants','attributes','conditions','negation','modality','exceptions','time_text','version_text','text','statement','source_refs','evidence','representation','policy','semantic_policy','warnings'];
export function validateQueryRerankResponse(response,count,binding){
 const fail=()=>{throw Object.assign(Error('QUERY_RERANK_RESPONSE_INVALID'),{code:'QUERY_RERANK_RESPONSE_INVALID',provider_response_received:true});};
 if(response?.status!=='COMPLETED'||response.model!==binding.model||response.config_revision!==binding.config_revision)fail();
 const scores=response.results,seen=new Set();
 if(!Array.isArray(scores)||scores.length!==count)fail();
 for(const row of scores){if(!row||!Number.isInteger(row.index)||row.index<0||row.index>=count||seen.has(row.index)||!Number.isFinite(row.score))fail();seen.add(row.index);}
 return scores;
}
export function consolidateQueryRows(rows){
 const kept=[],groups=new Map();
 for(const input of rows){
  const row=clone(input);
  // An identical source/body alone is not identity. Only an explicit shared
  // knowledge reference (or the same record identity) permits consolidation.
  const identity=row.knowledge_ref??row.fact_ref??row.record_ref;
  const key=hash({identity,...pick(row,duplicateFields)}),prior=groups.get(key);
  if(prior){prior.duplicate_record_refs.push(row.record_ref);continue;}
  row.duplicate_record_refs=[];groups.set(key,row);kept.push(row);
 }
 return kept;
}
export function createQueryRanking({reader,rerank,rerankBinding,enabled=false,candidateWindow=DEFAULT_RERANK_WINDOW,signal}={}){
 need(typeof enabled==='boolean'&&Number.isSafeInteger(candidateWindow)&&candidateWindow>=1&&candidateWindow<=256,'QUERY_RERANK_OPTIONS_INVALID');
 if(enabled)need(typeof rerank==='function'&&typeof rerankBinding?.model==='string'&&rerankBinding.model.length>0&&rerankBinding.config_revision!==undefined,'QUERY_RERANK_NOT_CONFIGURED');
 const cache=new Map();
 return async function order(rows,{query,type,cursor}){
  const candidates=type==='facts'?consolidateQueryRows(rows):clone(rows),base={ranking_revision:QUERY_RANKING_REVISION,delivery_revision:QUERY_DELIVERY_REVISION,rerank_enabled:enabled,candidate_window:candidateWindow,candidate_count:rows.length,unique_count:candidates.length,rerank_status:enabled?'SKIPPED_EMPTY_OR_ENUMERATE':'DISABLED'};
  // Entity localization keeps exact-name/alias priority and ambiguity semantics.
  // Only knowledge and source passages are candidates for this rerank protocol.
  if(enabled&&!['facts','sources'].includes(type))return {rows:candidates,trace:{...base,rerank_status:'SKIPPED_ENTITIES'}};
  if(!enabled||!query||!candidates.length)return {rows:candidates,trace:base};
  reader.assertCurrent();need(!signal?.aborted,'NATIVE_QUERY_CANCELLED');rerank.assertCurrent?.();
  const window=candidates.slice(0,candidateWindow),key=hash({query,type,scope:reader.scope(),candidates,binding:rerankBinding,candidateWindow});
  let result=cache.get(key);
  if(!result){
   need(!cursor,'NATIVE_QUERY_CURSOR_INVALID');
   need(!signal?.aborted,'NATIVE_QUERY_CANCELLED');reader.assertCurrent();
   const documents=window.map(row=>JSON.stringify(pick(row,['text','statement','kind','subject_ref','object_ref','predicate','attribute','raw_value','unit','rule_text','conditions','negation','modality','exceptions','time_text','version_text'])));
   const started=Date.now(),response=await rerank(query,documents,{signal,candidate_set_sha256:key,record_refs:window.map(r=>r.record_ref)});
   const scores=validateQueryRerankResponse(response,window.length,rerankBinding);
   reader.assertCurrent();need(!signal?.aborted,'NATIVE_QUERY_CANCELLED');
   const scored=scores.map(s=>({...window[s.index],rerank_score:s.score,pre_rerank_rank:window[s.index].rrf_rank??s.index+1}));
   scored.sort((a,b)=>b.rerank_score-a.rerank_score||a.pre_rerank_rank-b.pre_rerank_rank);
   result={rows:[...scored.map((r,i)=>({...r,rerank_rank:i+1})),...candidates.slice(candidateWindow)],trace:{...base,rerank_status:'COMPLETED',candidate_window:candidateWindow,reranked_count:window.length,candidate_set_sha256:key,model:rerankBinding.model,config_revision:rerankBinding.config_revision,usage:response.usage??null,elapsed_ms:Date.now()-started,bindings:scored.map((r,i)=>({record_ref:r.record_ref,pre_rerank_rank:r.pre_rerank_rank,rerank_rank:i+1,score:r.rerank_score}))}};
   // Reader-local bounded cache ensures continuation pages do not resend.
   if(cache.size>=32)cache.delete(cache.keys().next().value);cache.set(key,result);
  }
  return clone(result);
 };
}
