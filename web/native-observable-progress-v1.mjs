/** Local invocation progress, using business payloads rather than generated IDs. */
import {hash,clone,need} from './cq-discovery-store-v2.mjs';
import {progressExecution} from './native-execution-controls-v1.mjs';
const ignored=new Set(['run_id','invocation_ref','tool_call_ref','mcp_request_id','mcp_session_ref','request_ref','request_refs','proposal_ref','proposal_refs','record_ref','knowledge_ref','semantic_ref','record_sha256','raw_sha256','created_at','updated_at','started_at','ended_at','at','usage','gaps','warnings','normalizations','processing_summary','processing_results','save_feedback','budget_hint','execution_budget_hint','remaining','argument_normalization_refs','feedback_generation','actual_connection_count']);
export function observableBusiness(value,key=''){
 if(Array.isArray(value)){const rows=value.map(v=>observableBusiness(v,key));return ['items','knowledge','saved_knowledge','expressions','findings','graph_connections'].includes(key)?[...new Map(rows.map(r=>[hash(r),r])).values()]:rows;}
 if(!value||typeof value!=='object')return value;
 return Object.fromEntries(Object.entries(value).filter(([k,v])=>!ignored.has(k)&&!(k==='revision'&&typeof v==='string'&&v.startsWith('knowledge_revision_'))).map(([k,v])=>[k,observableBusiness(v,k)]));
}
export function createNativeObservableProgress({store,run,invocationRef,now=()=>Date.now(),onStall=null}){
 if(!progressExecution(run.state()))return {observe(){}};
 const kind='native_agent_observable_progress_v1';
 return {observe({name,args,result,definition,observation,batchRef=null,batchComplete=true}){
  if(result?.ok===false)return;
  const body=result?.result??result,finish=body?.finished===true||body?.completed===true||body?.extraction_complete===true;
  const value=observation!==undefined?{name,observed:observableBusiness(observation)}:definition?.annotations?.readOnlyHint===true?{name,read:observableBusiness(body)}:
   /next_organization_focus/.test(name)?{name,phase:body?.phase,refs:body?.semantic_refs}:
   {name,args:observableBusiness(args),...(finish?{finished:true}:{})};
  const signature=hash(value),prior=store.getRecord(kind,invocationRef)??{invocation_ref:invocationRef,run_id:run.state().run_id,seen:[],stalled_calls:0,last_progress_at:now()},fresh=!prior.seen.includes(signature);
  // All calls from one model response share one opportunity to receive feedback.
  // Inspect every material state change, but charge at most one stalled round.
  const sameBatch=batchRef!==null&&prior.pending_batch?.request_ref===batchRef;
  const batchProgress=fresh||(sameBatch&&prior.pending_batch.made_progress===true);
  const state={...prior,seen:fresh?[...prior.seen,signature]:prior.seen,stalled_calls:batchComplete?(batchProgress?0:prior.stalled_calls+1):prior.stalled_calls,last_progress_at:fresh?now():prior.last_progress_at,last_tool:name,last_signature:signature,
   pending_batch:batchRef&&!batchComplete?{request_ref:batchRef,made_progress:batchProgress}:null,
   ...(batchComplete?{completed_rounds:(prior.completed_rounds??0)+1,last_completed_batch_ref:batchRef}:{}),counting_policy:'COMPLETED_RESPONSE_BATCH_V1'};
  store.putRecord(kind,invocationRef,clone(state));if(fresh)run.noteProgress?.();
  if(batchComplete&&state.stalled_calls>=run.state().limits.max_stalled_tool_calls){
   if(onStall?.({reason:'NATIVE_LOCAL_NO_PROGRESS',progress:clone(state)})===true)return {partial:true};
   run.stop('NATIVE_LOCAL_NO_PROGRESS','STOPPED');need(false,'NATIVE_LOCAL_NO_PROGRESS');
  }
 }};
}
