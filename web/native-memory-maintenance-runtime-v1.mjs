/** S0 lifecycle increment. Frozen maintenance candidate remains unchanged. */
/** OFFLINE CANDIDATE. Explicit request queue over the actual organization-reuse port. */
import {createMemoryMaintenance} from './native-memory-maintenance-v1.mjs';

const fail=(code,status=409)=>Object.assign(new Error(code),{code,status});
const need=(condition,code,status)=>{if(!condition)throw fail(code,status);};
const text=value=>typeof value==='string'&&value.trim().length>0&&value.isWellFormed()&&!value.includes('\0');
const clone=value=>structuredClone(value);
function dto(attempt) {
  return {schema_version:'MEMORY_PRODUCT_MAINTENANCE_V1',library_id:attempt.library_id,record_ref:attempt.record_ref,
    attempt_ref:attempt.attempt_ref,request_id:attempt.request_id,state:attempt.state,
    created_at:attempt.created_at,started_at:attempt.started_at??null,finished_at:attempt.finished_at??null,
    source_processing_ref:attempt.source_processing_ref,source_publication_ref:attempt.source_publication_ref,
    source_quality:clone(attempt.source_quality),quality:clone(attempt.quality??null),
    runtime_ref:attempt.runtime_receipt?.run_id??attempt.runtime_failure_ref??null,error_code:attempt.error_code??null,
    semantic_invocations:attempt.semantic_invocations,semantic_reuse:{source_run_id:attempt.semantic_reuse.source_run_id,
      manifest_sha256:attempt.semantic_reuse.manifest_sha256,package_refs:clone(attempt.semantic_reuse.package_refs)},
    replacement_manifest_sha256:attempt.replacement_manifest.manifest_sha256,publication:clone(attempt.publication),
    ...(attempt.runtime_outcome?{runtime_outcome:clone(attempt.runtime_outcome)}:{}),
    ...(attempt.outcome_projected?{outcome_projected:true,stored_state:attempt.stored_state,stored_error_code:attempt.stored_error_code,
      stored_runtime_failure_ref:attempt.stored_runtime_failure_ref}:{}),
    ...(attempt.confirmation_projected?{confirmation_projected:true,stored_state:attempt.stored_state,stored_publication:clone(attempt.stored_publication)}:{})};
}

export function createMemoryMaintenanceRuntime({db,coreForLibrary,processing,publication,projection,libraryContext,
  resolveSourcePrepared,organizationPort=null,organizationPortFactory=null,modelRuntime=null,authorize,
  assertLibrary=()=>{},onOperation=()=>{},verifyActionPrepared,resolveRuntimeOutcome=null,clock}={}) {
  need(typeof authorize==='function'&&typeof assertLibrary==='function'&&typeof onOperation==='function',
    'MEMORY_MAINTENANCE_RUNTIME_HOST_REQUIRED');
  need(modelRuntime===null||typeof modelRuntime==='function','MEMORY_MAINTENANCE_MODEL_GETTER_INVALID');
  need(organizationPortFactory===null||typeof organizationPortFactory==='function','MEMORY_MAINTENANCE_PORT_FACTORY_INVALID');
  need(!(organizationPort&&organizationPortFactory),'MEMORY_MAINTENANCE_MULTIPLE_PORTS_FORBIDDEN');
  const validPort=port=>port?.mode==='NATIVE_CODEX'&&typeof port.verifyReuse==='function'&&typeof port.reorganize==='function';
  need(!organizationPort||validPort(organizationPort),'MEMORY_MAINTENANCE_ORGANIZATION_REUSE_PORT_REQUIRED');
  const ports=new Map();
  const ready=()=>{
    try {return !!(organizationPort||organizationPortFactory&&typeof modelRuntime?.()?.upstream==='function');}
    catch{return false;}
  };
  function portFor(args) {
    const {attempt}=args;
    if(ports.has(attempt.attempt_ref))return ports.get(attempt.attempt_ref);
    const snapshot=organizationPort?null:modelRuntime?.();
    need(organizationPort||organizationPortFactory&&typeof snapshot?.upstream==='function','MEMORY_MAINTENANCE_MODELS_UNAVAILABLE',503);
    const port=organizationPort??organizationPortFactory(snapshot,clone(args));
    need(validPort(port),'MEMORY_MAINTENANCE_ORGANIZATION_REUSE_PORT_REQUIRED',503);
    ports.set(attempt.attempt_ref,port);return port;
  }
  const lazyPort={mode:'NATIVE_CODEX',async verifyReuse(args){
    try{return await portFor(args).verifyReuse(args);}catch(cause){ports.delete(args.attempt.attempt_ref);throw cause;}
  },async reorganize(args){
    try{return await portFor(args).reorganize(args);}finally{ports.delete(args.attempt.attempt_ref);}
  }};
  const maintenance=createMemoryMaintenance({db,coreForLibrary,processing,publication,projection,libraryContext,
    resolveSourcePrepared,resolveRuntimeOutcome,organizationPort:lazyPort,...(verifyActionPrepared?{verifyActionPrepared}:{}),...(clock?{clock}:{})});
  let accepting=true,running=false,scheduled=false,closed=false,scheduledHandle=null;
  const queue=[],queued=new Set(),waiters=[],errors=[];
  function remember(cause,attempt){errors.push({attempt_ref:attempt.attempt_ref,code:typeof cause.code==='string'?cause.code:'MEMORY_MAINTENANCE_WORKER_FAILED'});if(errors.length>20)errors.shift();}
  const settle=()=>{if(!running&&!scheduled&&!queue.length)while(waiters.length)waiters.shift()();};
  async function work(){
    scheduled=false;scheduledHandle=null;
    if(running||closed){settle();return;}
    const attempt=queue.shift();if(!attempt){settle();return;}
    queued.delete(attempt.attempt_ref);running=true;let counted=false;
    try{assertLibrary(attempt.library_id);onOperation(1);counted=true;await maintenance.runOne({attempt_ref:attempt.attempt_ref});}
    catch(cause){remember(cause,attempt);}
    finally{ports.delete(attempt.attempt_ref);if(counted){try{onOperation(-1);}catch(cause){remember(cause,attempt);}}
      running=false;schedule();settle();}
  }
  function schedule(){if(!running&&!scheduled&&!closed&&queue.length){scheduled=true;scheduledHandle=setImmediate(work);}}
  function notify(attempt){
    if(attempt.state!=='QUEUED'||queued.has(attempt.attempt_ref))return;
    queued.add(attempt.attempt_ref);queue.push({attempt_ref:attempt.attempt_ref,library_id:attempt.library_id});schedule();
  }
  async function scope(args,action){
    need(text(args?.library_id),'MEMORY_MAINTENANCE_LIBRARY_REQUIRED',400);
    const principal=await authorize(args.auth,{library_id:args.library_id,action});
    need(principal,'MEMORY_MAINTENANCE_UNAUTHENTICATED',401);
    need(principal.library_id===args.library_id&&text(principal.principal_ref)
      &&['BROWSER','MCP','TRUSTED_TOOL'].includes(principal.channel),'MEMORY_MAINTENANCE_SCOPE_FORBIDDEN',403);
    need(Array.isArray(principal.permissions)&&principal.permissions.includes(action),'MEMORY_MAINTENANCE_PERMISSION_DENIED',403);
    assertLibrary(principal.library_id);return principal;
  }
  async function requestReorganization(args){
    need(accepting&&!closed,'MEMORY_MAINTENANCE_RUNTIME_CLOSED',503);
    const allowed=['auth','library_id','record_ref','request_id','reason','source_processing_ref','semantic_reuse','replacement_manifest'];
    need(args&&typeof args==='object'&&!Array.isArray(args)&&Object.keys(args).every(key=>allowed.includes(key)),
      'MEMORY_MAINTENANCE_INPUT_FIELD_INVALID',400);
    const principal=await scope(args,'write');
    need(accepting&&!closed,'MEMORY_MAINTENANCE_RUNTIME_CLOSED',503);
    need(ready(),'MEMORY_MAINTENANCE_MODELS_UNAVAILABLE',503);
    const {auth:_,...request}=args;
    const attempt=maintenance.enqueue({...request,library_id:principal.library_id});
    notify(attempt);return dto(attempt);
  }
  async function getAttempt(args){
    need(args&&typeof args==='object'&&!Array.isArray(args)&&Object.keys(args).every(key=>['auth','library_id','attempt_ref'].includes(key)),
      'MEMORY_MAINTENANCE_INPUT_FIELD_INVALID',400);
    const principal=await scope(args,'read');need(text(args.attempt_ref),'MEMORY_MAINTENANCE_ATTEMPT_REQUIRED',400);
    const attempt=maintenance.get({attempt_ref:args.attempt_ref});
    need(attempt&&attempt.library_id===principal.library_id,'MEMORY_MAINTENANCE_ATTEMPT_NOT_FOUND',404);
    return dto(attempt);
  }
  const drain=()=>!running&&!scheduled&&!queue.length?Promise.resolve():new Promise(resolve=>waiters.push(resolve));
  async function close({drain:finish=true}={}) {
    accepting=false;
    if(finish) await drain();
    closed=true;
    if(!finish) {
      if(scheduledHandle!==null)clearImmediate(scheduledHandle);
      scheduledHandle=null;scheduled=false;queue.length=0;queued.clear();
    }
    // A running attempt keeps one captured port across verifyReuse/reorganize and settles normally.
    if(!running)ports.clear();
    settle();
  }
  return Object.freeze({requestReorganization,getAttempt,maintenance,drain,close,
    readiness:()=>({available:accepting&&!closed&&ready(),closed,accepting,running,queue_length:queue.length,
      automatic_resume:false,execution_mode:ready()?'NATIVE_CODEX':'UNAVAILABLE',errors:clone(errors)})});
}
