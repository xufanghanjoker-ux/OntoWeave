/** Presentation is derived; legacy task records are never rewritten to look successful. */
import { sha } from './engine.mjs';
export function taskIssues(job, decisions=[]) {
  const gate=job.result?.gate, incomplete=gate?.action==='REVIEW_INCOMPLETE';
  const issues=gate?.issues || [];
  const user_decisions=incomplete?[]:issues.filter(i=>i.resolution==='NEEDS_USER').map((i,n)=>({...i,id:i.issue_id || 'issue_'+sha([i.code,i.target,i.cq_ids,n]).slice(0,16)}));
  const evidence_requests=incomplete?[]:issues.filter(i=>i.resolution==='WAIT_EVIDENCE').map((i,n)=>({...i,id:i.issue_id || 'evidence_'+sha([i.code,i.target,n]).slice(0,16)}));
  const buckets=new Map();
  for(const c of job.result?.claims || []) {
    const predicate=job.result.schema?.predicates.find(p=>p.id===c.predicate_id);
    if(predicate?.cardinality!=='ONE'||c.modality!=='CURRENT'||c.comparator!=='EQ'||!c.effective_from)continue;
    const key=JSON.stringify([c.subject_id,c.predicate_id,c.scope,c.unit,c.effective_from]);
    const values=buckets.get(key)||[];values.push(c);buckets.set(key,values);
  }
  const conflicts=[...buckets.entries()].filter(([,cs])=>new Set(cs.map(c=>JSON.stringify(c.value))).size>1)
    .map(([key,claims])=>({id:'conflict_'+sha(key).slice(0,20),status:'PRESERVED',claims,notice:'保留多方原文，不自动选定事实值；无需为了建库而消除冲突。'}));
  return {version:job.id,user_decisions,evidence_requests,conflicts,decisions,
    processing_history:job.result?.repairs || job.repairs || [],
    system_diagnostics:taskDiagnostics(job)};
}
export function taskDiagnostics(job) {
  const budgetPaused=['FAILED','PAUSED'].includes(job.status)&&job.error_details?.code==='BUDGET_EXHAUSTED';
  const incomplete=job.result?.gate?.action==='REVIEW_INCOMPLETE';
  const systemIssue=(job.result?.gate?.issues || []).some(i=>!['NEEDS_USER','WAIT_EVIDENCE'].includes(i.resolution));
  const category=budgetPaused?'PAUSED_BUDGET':job.status==='READY'?'READY':incomplete||job.status==='FAILED'||job.status==='INTERRUPTED'||systemIssue?'SYSTEM_FAILURE'
    :job.status==='REVIEW_REQUIRED'?'NEEDS_USER':job.status;
  const stage=job.failed_stage || job.events?.filter(e=>e.calls || e.status==='FAILED').at(-1)?.stage || job.stage;
  const unknown=(job.error_details?.billing_status==='UNKNOWN'||['MODEL_TIMEOUT','MODEL_NETWORK_ERROR','MODEL_RESPONSE_READ_ERROR','MODEL_RESPONSE_INVALID_JSON'].includes(job.error_details?.code)||job.status==='INTERRUPTED'||job.status==='FAILED'&&!job.error_details?.code);
  return {task_id:job.id,category,failed_stage:stage,code:job.error_details?.code || (incomplete?'REVIEW_PROTOCOL_INVALID':null),
    reason:incomplete?job.result.gate.reason:job.error || job.result?.gate?.reason || null,
    message:budgetPaused?'自定义调用额度已用完，任务已暂停；已完成阶段保留，重新授权后可继续，无需重新上传资料。':category==='SYSTEM_FAILURE'?'系统处理未完成；不代表资料有错，无需为技术故障修改资料。':category==='NEEDS_USER'?'有业务决定或证据需要确认。':category==='READY'?'知识库可查询；来源陈述不等于独立事实核实。':'处理中或尚未开始。',
    checkpoints:(job.checkpoints || job.result?.checkpoints || []).map(c=>({key:c.key,fingerprint:c.fingerprint,metadata:c.metadata})),
    completed_stages:[...new Set((job.events || []).filter(e=>e.calls || e.reused).map(e=>e.stage))],
    protocol_errors:job.error_details?.diagnostics || job.error_details?.cause?.diagnostics || (Array.isArray(job.error_details?.cause)?job.error_details.cause:null) || job.result?.gate?.diagnostics || [],
    requires_unknown_resend_confirmation:unknown,
    allowed_actions:budgetPaused?['RESUME']:category==='SYSTEM_FAILURE'||job.status==='CANCELLED'?['RESUME','FULL_REBUILD']:category==='NEEDS_USER'?['DECIDE','REVISE']:[],
    legacy_notice:!(job.checkpoints || []).length?'旧任务没有可验证检查点时，从最早可安全执行的阶段开始；不冒充已恢复。':null};
}
