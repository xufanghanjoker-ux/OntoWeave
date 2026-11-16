/** Query execution state and observations. No per-question call or money quota. */
import {clone,hash,id,need,textField} from './cq-discovery-store-v2.mjs';

const KIND='native_query_operation_v1';
const ACTIVE=new Set(['RUNNING','ANSWER_STAGED']);
const executionKeys=new Set(['timeout_ms','max_request_bytes','max_response_bytes','max_sse_frame_bytes','max_sse_events','max_semantic_bytes']);
export const DEFAULT_QUERY_EXECUTION=Object.freeze({timeout_ms:300000,max_request_bytes:2097152,max_response_bytes:8388608,max_sse_frame_bytes:8388608,max_sse_events:100000,max_semantic_bytes:8388608});

export function createNativeQueryOperation({store,queryId=id('native_query'),libraryId,input,execution={},now=()=>Date.now()}) {
  need(store&&['getRecord','putRecord','transaction'].every(k=>typeof store[k]==='function')&&textField(queryId)&&textField(libraryId)&&input&&typeof input==='object','NATIVE_QUERY_OPERATION_INPUT_INVALID');
  need(Object.keys(execution).every(k=>executionKeys.has(k)),'NATIVE_QUERY_EXECUTION_FIELD_FORBIDDEN');
  const selected={...DEFAULT_QUERY_EXECUTION,...execution};
  need(Object.values(selected).every(n=>Number.isSafeInteger(n)&&n>0),'NATIVE_QUERY_EXECUTION_INVALID');
  const binding=hash({queryId,libraryId,input,execution:selected}),controller=new AbortController();
  const save=value=>store.putRecord(KIND,queryId,clone(value));
  const state=()=>clone(store.getRecord(KIND,queryId));
  store.transaction(()=>{
    const previous=store.getRecord(KIND,queryId);
    if(previous){
      need(previous.binding===binding,'NATIVE_QUERY_OPERATION_CONFLICT');
      if(previous.attempts.some(a=>a.outcome==='STARTED')){
        previous.attempts=previous.attempts.map(a=>a.outcome==='STARTED'?{...a,outcome:'UNKNOWN',reason:'NATIVE_QUERY_RESTART_UNKNOWN',ended_at:now()}:a);
        previous.status='UNKNOWN_HOLD';previous.reason='NATIVE_QUERY_RESTART_UNKNOWN';previous.ended_at=now();save(previous);
      }
    } else save({query_id:queryId,library_id:libraryId,binding,input:clone(input),execution:selected,status:'RUNNING',created_at:now(),ended_at:null,attempts:[],progress:[],answer:null,answer_ref:null});
  });
  if(!ACTIVE.has(state().status))controller.abort(state().reason??state().status);
  function stop(reason,status='FAILED') {
    need(textField(reason)&&['FAILED','UNKNOWN_HOLD','CANCELLED','INTERRUPTED','STALE'].includes(status),'NATIVE_QUERY_STOP_INVALID');
    const result=store.transaction(()=>{
      const value=state();if(!ACTIVE.has(value.status))return value;
      value.status=status;value.reason=reason;value.ended_at=now();
      if(['CANCELLED','INTERRUPTED','UNKNOWN_HOLD'].includes(status))value.attempts=value.attempts.map(a=>a.outcome==='STARTED'?{...a,outcome:'UNKNOWN',reason,ended_at:now()}:a);
      save(value);return value;
    });
    controller.abort(reason);return result;
  }
  function assertActive() {
    const value=state();need(ACTIVE.has(value.status),'NATIVE_QUERY_'+value.status);
    if(now()-value.created_at>=value.execution.timeout_ms){stop('NATIVE_QUERY_TIMEOUT','INTERRUPTED');need(false,'NATIVE_QUERY_TIMEOUT');}
    return value;
  }
  // Deadline persistence must occur before a caller's mutation transaction:
  // throwing in that transaction would otherwise roll the terminal state back.
  function activeState(){const value=state();need(ACTIVE.has(value.status),'NATIVE_QUERY_'+value.status);return value;}
  function beginRequest({kind,role,requestMetadata={}}) {
    assertActive();need(['GENERATION','EMBEDDING','RERANK'].includes(kind)&&textField(role),'NATIVE_QUERY_REQUEST_INPUT_INVALID');
    return store.transaction(()=>{
      const value=activeState();need(value.status==='RUNNING','NATIVE_QUERY_ANSWER_ALREADY_STAGED');
      const request_ref=id('native_query_request');
      value.attempts.push({request_ref,kind,role,metadata:clone(requestMetadata),outcome:'STARTED',started_at:now(),usage:null});save(value);
      return {request_ref,signal:controller.signal,remaining_ms:Math.max(1,value.execution.timeout_ms-(now()-value.created_at))};
    });
  }
  function settle(requestRef,outcome,{usage=null,reason=null}={}) {
    return store.transaction(()=>{
      const value=state(),request=value.attempts.find(a=>a.request_ref===requestRef);need(request,'NATIVE_QUERY_REQUEST_UNKNOWN');
      if(request.outcome!=='STARTED'){need(request.outcome===outcome,'NATIVE_QUERY_REQUEST_ALREADY_SETTLED');return clone(request);}
      Object.assign(request,{outcome,usage:clone(usage),reason,ended_at:now()});
      if(outcome!=='RETURNED'&&ACTIVE.has(value.status)){value.status=outcome==='UNKNOWN'?'UNKNOWN_HOLD':'FAILED';value.reason=reason??'NATIVE_QUERY_REQUEST_'+outcome;value.ended_at=now();controller.abort(value.reason);}
      save(value);return clone(request);
    });
  }
  function recordProgress({tool_name,args_hash,evidence_refs=[],result_hash=null}) {
    need(textField(tool_name)&&textField(args_hash)&&Array.isArray(evidence_refs)&&evidence_refs.every(textField),'NATIVE_QUERY_PROGRESS_INVALID');
    assertActive();
    return store.transaction(()=>{
      const value=activeState(),key=hash({tool_name,args_hash}),prior=value.progress.filter(p=>p.key===key),known=new Set(prior.flatMap(p=>p.evidence_refs));
      const fresh=[...new Set(evidence_refs)].filter(ref=>!known.has(ref)),repeated=prior.length>0&&fresh.length===0;
      const entry={key,tool_name,args_hash,evidence_refs:[...new Set(evidence_refs)],new_evidence_refs:fresh,result_hash,repeated,at:now()};value.progress.push(entry);save(value);
      return {progress:prior.length===0||fresh.length>0,repeated,should_stop:repeated,new_evidence_refs:fresh};
    });
  }
  function stageAnswer(answer) {
    need(answer&&typeof answer==='object','NATIVE_QUERY_ANSWER_INVALID');
    assertActive();
    return store.transaction(()=>{
      const value=activeState(),answer_ref='native-query-answer:'+hash({queryId,answer});
      if(value.answer_ref){need(value.answer_ref===answer_ref,'NATIVE_QUERY_ANSWER_CONFLICT');return {answer_ref,status:value.status};}
      value.answer=clone(answer);value.answer_ref=answer_ref;value.status='ANSWER_STAGED';value.answer_staged_at=now();save(value);return {answer_ref,status:value.status};
    });
  }
  function confirmAnswer({runtime_receipt,evidence_validated}={}) {
    if(state().status!=='COMPLETED')assertActive();
    return store.transaction(()=>{
      const existing=state();
      if(existing.status==='COMPLETED'){
        need(evidence_validated===true&&hash(existing.runtime_receipt)===hash(runtime_receipt),'NATIVE_QUERY_CONFIRMATION_CONFLICT');
        return {answer_ref:existing.answer_ref,status:existing.status,answer:clone(existing.answer)};
      }
      const value=activeState();need(value.status==='ANSWER_STAGED'&&value.answer_ref,'NATIVE_QUERY_ANSWER_NOT_STAGED');
      need(evidence_validated===true,'NATIVE_QUERY_ANSWER_EVIDENCE_UNCONFIRMED');
      need(runtime_receipt?.status==='SUCCEEDED'&&['HOST_ACCEPTED_ROLE_OUTPUT','NATIVE_TURN_COMPLETED'].includes(runtime_receipt.completion_source),'NATIVE_QUERY_RUNTIME_UNCONFIRMED');
      need(!runtime_receipt.query_id||runtime_receipt.query_id===queryId,'NATIVE_QUERY_RUNTIME_QUERY_MISMATCH');
      need(!runtime_receipt.model_binding?.binding_ref||!value.input.model_binding?.binding_ref||runtime_receipt.model_binding.binding_ref===value.input.model_binding.binding_ref,'NATIVE_QUERY_RUNTIME_MODEL_MISMATCH');
      need(value.attempts.every(a=>a.outcome==='RETURNED'),'NATIVE_QUERY_REQUESTS_UNSETTLED');
      value.status='COMPLETED';value.runtime_receipt=clone(runtime_receipt);value.ended_at=now();save(value);return {answer_ref:value.answer_ref,status:value.status,answer:clone(value.answer)};
    });
  }
  return Object.freeze({state,assertActive,beginRequest,recordReturned:(ref,data)=>settle(ref,'RETURNED',data),recordFailed:(ref,data)=>settle(ref,'FAILED',data),recordUnknown:(ref,data)=>settle(ref,'UNKNOWN',data),recordProgress,stageAnswer,confirmAnswer,cancel:(reason='NATIVE_QUERY_USER_CANCELLED')=>stop(reason,'CANCELLED'),stop,signal:controller.signal});
}
