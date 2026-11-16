/** Exact stored Host settlement evidence. No request, state transition, retry or DB write. */
import {clone,hash,need,textField} from './cq-discovery-store-v2.mjs';

const SCHEMA='MEMORY_MAINTENANCE_RUNTIME_OUTCOME_V1';
const OUTCOMES=new Set(['UNKNOWN','RETURNED','FAILED','UNSETTLED','UNAVAILABLE']);
const JOB_STATES=new Set(['RUNNING','PREPARED','FAILED','UNKNOWN']);
const RUN_STATES=new Set(['OPEN','RUNNING','SUCCEEDED','PARTIALLY_READY','FAILED','UNKNOWN_HOLD','STOPPED','CANCELLED','STALE']);
const REQUEST_OUTCOMES=new Set(['RETURNED','FAILED','UNKNOWN','RESERVED']);
const safeCode=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,95}$/.test(value)?value:null;
const scopeFor=attempt=>({library_id:attempt.library_id,record_ref:attempt.record_ref,attempt_ref:attempt.attempt_ref,
  semantic_manifest_sha256:attempt.semantic_reuse.manifest_sha256});
const signed=body=>({...body,outcome_sha256:hash(body)});
export const maintenanceActionRunRef=attempt=>'action_reorganization_'+hash([attempt.attempt_ref,attempt.semantic_reuse.manifest_sha256]);

export function checkMemoryMaintenanceRuntimeOutcome(value,{attempt}={}) {
  const {outcome_sha256,...body}=value??{};
  need(outcome_sha256===hash(body)&&value.schema_version===SCHEMA&&OUTCOMES.has(value.outcome)
    &&typeof value.verified==='boolean'&&value.source==='EXACT_ACTION_REUSE_JOB_AND_LEDGER',
  'MEMORY_RUNTIME_OUTCOME_INVALID');
  need(value.verified===(value.outcome!=='UNAVAILABLE'),'MEMORY_RUNTIME_OUTCOME_INVALID');
  need(value.schema_version===SCHEMA&&OUTCOMES.has(value.outcome)&&typeof value.verified==='boolean'
    &&hash(value.scope)===hash(scopeFor(attempt))&&value.expected_runtime_ref===maintenanceActionRunRef(attempt),
  'MEMORY_RUNTIME_OUTCOME_SCOPE_CHANGED');
  if(value.verified)need(value.runtime_ref===value.expected_runtime_ref&&/^[a-f0-9]{64}$/.test(value.evidence?.job_sha256??'')
    &&/^[a-f0-9]{64}$/.test(value.evidence?.ledger_sha256??'')
    &&value.evidence.job_ref===value.runtime_ref&&value.evidence.ledger_ref===value.runtime_ref
    &&value.evidence.scope_sha256===hash(value.scope)&&JOB_STATES.has(value.job_state)&&RUN_STATES.has(value.ledger_state),
    'MEMORY_RUNTIME_OUTCOME_EVIDENCE_REQUIRED');
  if(value.verified) {
    const counts=value.request_counts;
    need(counts&&['total','returned','failed','unknown','reserved'].every(key=>Number.isSafeInteger(counts[key])&&counts[key]>=0)
      &&counts.total>0&&counts.total<=100000&&counts.total===counts.returned+counts.failed+counts.unknown+counts.reserved,
    'MEMORY_RUNTIME_OUTCOME_COUNTS_INVALID');
    if(value.outcome==='UNKNOWN')need(counts.unknown>0||(counts.reserved>0&&value.ledger_state==='UNKNOWN_HOLD'),
      'MEMORY_RUNTIME_OUTCOME_UNKNOWN_UNPROVEN');
    if(value.outcome==='RETURNED')need(counts.returned===counts.total&&['SUCCEEDED','PARTIALLY_READY'].includes(value.ledger_state)
      &&value.job_state==='PREPARED','MEMORY_RUNTIME_OUTCOME_RETURNED_UNPROVEN');
  }
  need(Array.isArray(value.unknown_request_refs)&&value.unknown_request_refs.length<=64
    &&value.unknown_request_refs.every(textField)&&Buffer.byteLength(JSON.stringify(value))<=16384,
  'MEMORY_RUNTIME_OUTCOME_TOO_LARGE');
  return clone(value);
}

export function createMemoryMaintenanceOutcomeReader({store}={}) {
  need(typeof store?.getRecord==='function','MEMORY_RUNTIME_OUTCOME_STORE_REQUIRED');
  return function resolveRuntimeOutcome({attempt,runtime_failure_ref=attempt?.runtime_failure_ref}={}) {
    let scope=null,expected=null;
    const unavailable=code=>signed({schema_version:SCHEMA,source:'EXACT_ACTION_REUSE_JOB_AND_LEDGER',verified:false,
      outcome:'UNAVAILABLE',runtime_ref:null,expected_runtime_ref:expected,scope,job_state:null,ledger_state:null,
      reason_code:safeCode(code)??'MEMORY_RUNTIME_OUTCOME_UNAVAILABLE',request_counts:null,unknown_request_refs:[],
      unknown_refs_truncated:false,evidence:null});
    try {
      need(attempt&&[attempt.library_id,attempt.record_ref,attempt.attempt_ref].every(textField),
        'MEMORY_RUNTIME_OUTCOME_ATTEMPT_INVALID');
      const {manifest_sha256,...manifest}=attempt.semantic_reuse??{};
      need(/^[a-f0-9]{64}$/.test(manifest_sha256??'')&&manifest_sha256===hash(manifest),
        'MEMORY_RUNTIME_OUTCOME_MANIFEST_CHANGED');
      scope=scopeFor(attempt);expected=maintenanceActionRunRef(attempt);
      need(runtime_failure_ref===undefined||runtime_failure_ref===null||runtime_failure_ref===expected,
        'MEMORY_RUNTIME_OUTCOME_RUN_REF_CHANGED');
      const job=store.getRecord('native_action_organization_reuse_job_v1',expected);
      const ledger=store.getRecord('native_full_run_v1',expected);
      if(!job&&!ledger)return unavailable('MEMORY_RUNTIME_OUTCOME_NO_BOUND_RUN');
      need(job&&ledger,'MEMORY_RUNTIME_OUTCOME_INCOMPLETE_EVIDENCE');
      need(job.run_id===expected&&ledger.run_id===expected&&ledger.mode==='NATIVE_CQ_BUILD_V1'
        &&JOB_STATES.has(job.status)&&RUN_STATES.has(ledger.status), 'MEMORY_RUNTIME_OUTCOME_RUN_CHANGED');
      const input=ledger.input;
      need(input?.library_id===attempt.library_id&&input.source_record_ref===attempt.record_ref
        &&input.stage==='ORGANIZATION_ONLY'&&hash(input.semantic_reuse)===hash(attempt.semantic_reuse)
        &&(job.source_run_id===undefined||job.source_run_id===attempt.semantic_reuse.source_run_id)
        &&ledger.limits&&ledger.binding===hash({input:ledger.input,limits:ledger.limits}),
      'MEMORY_RUNTIME_OUTCOME_SCOPE_CHANGED');
      need(Array.isArray(ledger.attempts)&&ledger.attempts.length>0&&ledger.attempts.length<=100000
        &&ledger.attempts.every(request=>textField(request.request_ref)&&REQUEST_OUTCOMES.has(request.outcome))
        &&new Set(ledger.attempts.map(request=>request.request_ref)).size===ledger.attempts.length,
      'MEMORY_RUNTIME_OUTCOME_REQUESTS_INVALID');
      need(Buffer.byteLength(JSON.stringify(job))+Buffer.byteLength(JSON.stringify(ledger))<=33554432,
        'MEMORY_RUNTIME_OUTCOME_SOURCE_TOO_LARGE');
      const counts={total:ledger.attempts.length,returned:0,failed:0,unknown:0,reserved:0};
      for(const request of ledger.attempts)counts[request.outcome.toLowerCase()]++;
      let outcome='UNSETTLED';
      if(counts.unknown>0||(counts.reserved>0&&ledger.status==='UNKNOWN_HOLD'))outcome='UNKNOWN';
      else if(counts.reserved>0||['OPEN','RUNNING'].includes(ledger.status))outcome='UNSETTLED';
      else if(counts.failed>0||['FAILED','STOPPED','CANCELLED','STALE'].includes(ledger.status)||job.status==='FAILED')outcome='FAILED';
      else if(counts.returned===counts.total&&['SUCCEEDED','PARTIALLY_READY'].includes(ledger.status)&&job.status==='PREPARED')outcome='RETURNED';
      const unknowns=ledger.attempts.filter(request=>['UNKNOWN','RESERVED'].includes(request.outcome)).map(request=>request.request_ref);
      return signed({schema_version:SCHEMA,source:'EXACT_ACTION_REUSE_JOB_AND_LEDGER',verified:true,outcome,
        runtime_ref:expected,expected_runtime_ref:expected,scope,job_state:job.status,ledger_state:ledger.status,
        reason_code:safeCode(ledger.reason)??safeCode(job.error_code),request_counts:counts,
        unknown_request_refs:unknowns.slice(0,64),unknown_refs_truncated:unknowns.length>64,
        evidence:{job_ref:expected,job_sha256:hash(job),ledger_ref:expected,ledger_sha256:hash(ledger),
          ledger_binding:ledger.binding,scope_sha256:hash(scope)}});
    } catch(cause) {return unavailable(cause?.code);}
  };
}
