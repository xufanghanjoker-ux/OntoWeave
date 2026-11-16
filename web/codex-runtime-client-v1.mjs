/** Project-owned runtime port, not an implementation of OpenAI RPC methods.
 * CQ-1 has no process spawn, network, credential or provider implementation. */
import {id,need,clone} from './cq-discovery-store-v2.mjs';
import {createCQTools,CQ_TOOLS} from './lightog-cq-tools-v1.mjs';
export const RUNTIME_PORT='lightog_agent_runtime_v1';
export const PINNED_CODEX_VERSION='0.166.0-alpha.6';
export function discoveryMode(value='legacy_v1') {need(['legacy_v1','codex_v2'].includes(value),'CQ_MODE_INVALID');return value;}
export function createUnavailableCodexRuntime() {
  return {
    async capabilities(){return {port:RUNTIME_PORT,kind:'CODEX_UNCONNECTED',version:PINNED_CODEX_VERSION,model:'qwen3.8-flash',compatibility:'UNKNOWN',available:false,reason:'CQ2_NOT_CONNECTED_OR_AUTHORIZED',per_request_gate_verified:false};},
    async start(){need(false,'CQ_REAL_RUNTIME_DISABLED');},
    async *observe(){need(false,'CQ_REAL_RUNTIME_DISABLED');},
    async interrupt(){return {confirmed:false,reason:'NO_CONNECTED_RUNTIME'};}
  };
}
/** Fixture callback; no model client is supplied. Run with the offline IO tripwire. */
export function createOfflineCQRuntime(script) {
  const runs=new Map();let starts=0;
  return {
    get starts(){return starts;},
    async capabilities(){return {port:RUNTIME_PORT,kind:'OFFLINE_STUB',available:true,external_requests:0,per_request_gate_verified:false};},
    async start(job) {const handle={runtime_id:id('offline'),request_id:job.request_id};runs.set(handle.runtime_id,{job,interrupted:false});starts++;return handle;},
    async *observe(handle,afterEvent) {
      const run=runs.get(handle.runtime_id);need(run,'CQ_RUNTIME_HANDLE_UNKNOWN');
      if(run.finished||afterEvent)return; // A known event cursor never restarts the script.
      need(!run.executing,'CQ_RUNTIME_OBSERVER_ALREADY_ACTIVE');run.executing=true;
      try {await script(run.job,{isInterrupted:()=>run.interrupted});run.finished=true;yield {event_id:'1',type:'COMPLETED',usage:{input_tokens:0,output_tokens:0},external_requests:0};}
      catch(error){run.finished=true;yield {event_id:'1',type:error.knownFailure===true?'FAILED':'UNKNOWN',code:error.code??'OFFLINE_SCRIPT_INTERRUPTED',external_requests:0};}
    },
    async interrupt(handle){const run=runs.get(handle.runtime_id);if(run)run.interrupted=true;return {confirmed:!!run,remote_nonexecution_proven:false};}
  };
}
/** Opt-in offline seam; never mounted by the product scheduler. */
export async function runOfflineCQTask({host,catalog,runtime,taskId,mode='legacy_v1'}) {
  need(discoveryMode(mode)==='codex_v2','CQ_V2_NOT_SELECTED');
  let t=host.task(taskId);
  if(t.runtime_handle||t.requests.some(r=>['RESERVED','UNKNOWN'].includes(r.outcome)))return host.recover(taskId);
  if(['CANCELLED','STALE','UNKNOWN_HOLD','SUCCEEDED','FAILED'].includes(t.status))return t;
  const caps=await runtime.capabilities();
  if(!caps.available||caps.kind!=='OFFLINE_STUB')return host.waiting(taskId,caps.reason??'REAL_RUNTIME_NOT_IMPLEMENTED');
  const request_id=id('simulation'),reservation=host.reserve(taskId,{request_id,actor:'offline_main',input_tokens:0,output_tokens:0});
  if(!reservation.allowed)return host.task(taskId);
  const job={task_id:taskId,request_id,snapshot_id:t.snapshot_id,contract:t.runtime_binding.contract,model:t.runtime_binding.model,
    skill:{id:'lightog-cq-discovery',version:t.runtime_binding.skill_version},allowed_tools:[...CQ_TOOLS],resource_limits:clone(t.budget),
    purpose:t.purpose,seed_questions:clone(t.seed_questions),
    budget_kind:'OFFLINE_SIMULATION',work_units:clone(t.work_units),toolsFor:unitId=>createCQTools({host,catalog,taskId,workUnitId:unitId})};
  try {
    const handle=await runtime.start(job);host.setRuntimeHandle(taskId,handle);
    let terminal=false;
    for await(const e of runtime.observe(handle)) {
      if(e.type==='COMPLETED') {host.settle(taskId,request_id,{outcome:'RETURNED',...e.usage});terminal=true;break;}
      if(e.type==='FAILED'){host.settle(taskId,request_id,{outcome:'FAILED',input_tokens:0,output_tokens:0});terminal=true;break;}
      if(e.type==='UNKNOWN'){host.settle(taskId,request_id,{outcome:'UNKNOWN'});terminal=true;break;}
    }
    if(!terminal)host.settle(taskId,request_id,{outcome:'UNKNOWN'});
  } catch {host.settle(taskId,request_id,{outcome:'UNKNOWN'});}
  t=host.task(taskId);
  if(!['CANCELLED','STALE','UNKNOWN_HOLD','FAILED'].includes(t.status))host.finalize(taskId,t.draft_revision,'OFFLINE_SIMULATION');
  return host.task(taskId);
}
