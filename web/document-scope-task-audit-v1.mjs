/** Assistant scope audits can only remove task reuse. Original model coverage
 * and fact admission stay immutable; Rust validates each sealed DEFER. */
const need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
export function readScopeTaskAuditDeferrals({store,core,libraryId,taskRef,coverage}){
 const hash=v=>core('primitives','hash',v).canonical_hash;
 const records=store.listRecords('document_scope_task_audit_deferral').filter(r=>r.library_id===libraryId&&r.task_ref===taskRef);
 const origins=store.listRecords('document_scope_task_audit_origin').filter(r=>r.library_id===libraryId&&r.task_ref===taskRef);
 need(records.length===origins.length,'DOCUMENT_SCOPE_TASK_AUDIT_ORIGIN_CHANGED');
 return records.sort((a,b)=>a.task_id.localeCompare(b.task_id)).map(r=>{
  const origin=store.getRecord('document_scope_task_audit_origin',r.origin_record_id);
  need(origin&&hash(origin)===r.origin_sha256&&origin.actor==='ASSISTANT_SCOPE_AUDIT'&&origin.action==='DEFER'&&origin.task_id===r.task_id&&origin.coverage_record_id===coverage.id&&r.coverage_record_id===coverage.id&&origin.coverage_receipt_hash===coverage.receipt.receipt_hash&&r.coverage_receipt_hash===coverage.receipt.receipt_hash&&origin.decision_sha256===hash(r.decision)&&origin.reason===r.decision.reason&&r.decision.actor==='ASSISTANT_SCOPE_AUDIT'&&r.decision.action==='DEFER','DOCUMENT_SCOPE_TASK_AUDIT_ORIGIN_CHANGED');
  return structuredClone(r.decision);
 });
}
