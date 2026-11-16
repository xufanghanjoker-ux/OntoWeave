import {clone,need} from './cq-discovery-store-v2.mjs';
import {SIMPLIFIED_LOCAL_FAILURES} from './native-simplified-completion-v1.mjs';
export const simplifiedGlobalFailure=code=>!SIMPLIFIED_LOCAL_FAILURES.has(code)&&/(?:SOURCE|FORBIDDEN|PERMISSION|REVOKED|AUTH_|STORAGE|SQLITE|CORRUPT|CHANGED|CONFLICT|BINDING|NO_REPLAY)/.test(code??'');
export function simplifiedScopedRun(parent,scope){
 let local=null;
 const own=value=>value.attempts.filter(a=>a.agent_scope===scope);
 const state=()=>{const value=parent.state();if(local&&['OPEN','RUNNING','UNKNOWN_HOLD'].includes(value.status))return {...value,...local,parent_status:value.status};if(value.status==='UNKNOWN_HOLD'&&own(value).length&&!own(value).some(a=>a.outcome==='UNKNOWN'))return {...value,status:'RUNNING',parent_status:'UNKNOWN_HOLD'};return value;};
 const assertOpen=()=>{const actual=parent.state();if(actual.status!=='UNKNOWN_HOLD')parent.assertOpen();const s=state();need(['OPEN','RUNNING'].includes(s.status),'NATIVE_RUN_'+s.status);return s;};
 return {...parent,state,assertOpen,reserve(args){parent.assertOpen();assertOpen();return parent.reserve(args);},stop(reason,status='STOPPED'){
  const value=parent.state(),attempts=own(value);if(SIMPLIFIED_LOCAL_FAILURES.has(reason)&&['OPEN','RUNNING','UNKNOWN_HOLD'].includes(value.status)&&attempts.length&&attempts.every(a=>a.outcome==='RETURNED')){local={status,reason,ended_at:Date.now()};return state();}return parent.stop(reason,status);
 }};
}
export function simplifiedPublicationRun(parent){return {...parent,assertOpen(){const s=parent.state();if(s.status==='UNKNOWN_HOLD')return s;return parent.assertOpen();},reserve(args){return parent.reserve(args);}};}
export function summarizeSimplifiedWindows({windows,run}){
 const count=status=>windows.filter(w=>w.status===status).length,unknown=run.attempts.filter(a=>a.outcome==='UNKNOWN').map(a=>a.request_ref),records=windows.reduce((n,w)=>n+w.saved_records,0),gaps=windows.some(w=>!['SAVED_SETTLED','PROGRAM_SAVED_SETTLED'].includes(w.status));
 const status=unknown.length?'UNKNOWN_HOLD':records===0&&gaps?'NO_USABLE_KNOWLEDGE':gaps?'PARTIAL':'COMPLETE';
 return {version:'SIMPLIFIED_PARTIAL_COMPLETION_V1',status,summary:`${windows.length}个窗口中，${(count('SAVED_SETTLED')+count('PROGRAM_SAVED_SETTLED'))}个完整保存，${count('PROGRAM_PARTIAL_SAVED')+count('PARTIAL_SAVED')}个部分保存，${count('UNSAVED')}个未保存，${count('NOT_EXECUTED')}个未执行；实际保留${records}条知识。`+(unknown.length?'未知请求保持未知，不自动重发。':''),total_windows:windows.length,saved_windows:(count('SAVED_SETTLED')+count('PROGRAM_SAVED_SETTLED')),partial_saved_windows:count('PROGRAM_PARTIAL_SAVED')+count('PARTIAL_SAVED'),unsaved_windows:count('UNSAVED'),not_executed_windows:count('NOT_EXECUTED'),unknown_windows:count('UNKNOWN'),saved_records:records,unknown_request_refs:unknown,windows:clone(windows),publication:{status:'NOT_STARTED',readback_verified:false,run_status_preserved:true}};
}
