/** A receipt proves all completed model requests were covered by validated checkpoints. */
import { sha } from './engine.mjs';
import { continuationProfile } from './human-review-runner.mjs';

export function recoveryEligibility(job,{provider,receipt,attempts=[],candidate,state,budget}={}){
  const no=reason=>({eligible:false,reason});
  if(!job?.internal_scope||job.cancel_requested||job.status==='CANCELLED')return no('USER_STOPPED_OR_LEGACY');
  if(!provider)return no('MODEL_NOT_CONNECTED');
  if(!['INTERRUPTED','FAILED'].includes(job.status))return no('NOT_RECOVERABLE_STATE');
  if(job.status==='FAILED'&&job.error_details?.billing_status!=='NOT_SENT')return no('FAILED_REQUIRES_EXPLICIT_RECOVERY');
  if(!candidate||candidate.status!=='CANDIDATE'||!state)return no('NO_CANDIDATE');
  if(state.head_task_id!==candidate.expected_head||state.revision!==candidate.expected_revision)return no('STALE_BASE');
  if(state.source_epoch!==candidate.expected_source_epoch)return no('SOURCES_CHANGED');
  if(!budget||budget.max_calls!==null&&budget.used>=budget.max_calls)return no('BUDGET_EXHAUSTED');
  if(attempts.some(a=>['STARTED','INTERRUPTED','FAILED'].includes(a.status)))return no('UNKNOWN_REMOTE_REQUEST');
  const completed=attempts.filter(a=>a.status==='COMPLETED');
  const checkpoints=job.checkpoints||[];
  if(completed.length||checkpoints.length){
    if(!receipt||receipt.input_hash!==sha(job.input)||receipt.checkpoints_hash!==sha(checkpoints)
      ||receipt.repairs_hash!==sha(job.repairs||[]))return no('CHECKPOINT_RECEIPT_MISMATCH');
    if(receipt.profile_hash!==sha(continuationProfile(provider)))return no('MODEL_CHANGED');
    if(!Array.isArray(receipt.attempt_ids)||completed.some(a=>!receipt.attempt_ids.includes(a.id)))return no('UNBOUND_COMPLETED_REQUEST');
  }
  const boundary=sha([sha(job.input),sha(checkpoints),sha(job.repairs||[])]);
  if((job.safe_recovery_boundaries||[]).includes(boundary))return no('BOUNDARY_ALREADY_RETRIED');
  return {eligible:true,reason:'SAFE_VALIDATED_BOUNDARY',boundary};
}
