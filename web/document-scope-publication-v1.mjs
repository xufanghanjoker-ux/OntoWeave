/** Reconstruct the current coverage input from immutable discovery and reviewed
 * extraction artifacts. Both publication and readback use this same binding. */
import {validateDocumentScope} from './document-scope-v1.mjs';
import {validateScopeCoverage,scopeCoverageKernelInput,resolveScopeCoverageRecord,PARTIAL_SCOPE_READINESS_POLICY} from './document-scope-coverage-v1.mjs';
import {validateNormalizedScopeRun} from './document-family-normalization-host-v1.mjs';
import {readScopeTaskAuditDeferrals} from './document-scope-task-audit-v1.mjs';
const need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
export function scopeCoverageInput({store,core,libraryId,taskRef,assessment,partialScopePublication=false}){
 const hash=v=>core('primitives','hash',v).canonical_hash;
 const binding=store.getRecord('source_learning_worker_scope',JSON.stringify([libraryId,taskRef]))?.scope?.document_scope;
 if(!binding)return null;
 need((partialScopePublication?assessment.ready_for_scope_review===true:assessment.ready_for_index===true)&&assessment.build?.graph,'DOCUMENT_SCOPE_CANDIDATE_REVIEW_PENDING');
 const runs=store.listRecords('document_scope_run').filter(r=>r.library_id===libraryId&&r.plan?.plan_id===binding.plan_id&&r.status==='READY');
 need(runs.length===1,'DOCUMENT_SCOPE_PLAN_NOT_CURRENT');
 const run=runs[0],snapshot=assessment.build.graph.snapshot;
 validateNormalizedScopeRun({store,core,row:run,currentSnapshot:snapshot});
 validateDocumentScope({core,prepared:run.prepared,responses:run.responses,plan:run.plan,currentSnapshot:snapshot});
 const menu=new Map(),oldIds=new Map();
 function add(fragment){
  const id='sce_'+hash({source_ref:fragment.source_ref,source_revision:fragment.source_revision,span:fragment.span});
  const row={evidence_id:id,source_ref:fragment.source_ref,source_revision:fragment.source_revision,span:structuredClone(fragment.span)};
  if(menu.has(id))need(hash(menu.get(id))===hash(row),'DOCUMENT_SCOPE_MENU_COLLISION');else menu.set(id,row);
  return id;
 }
 for(const batch of run.prepared.batches)for(const fragment of batch.source_evidence_menu)add(fragment);
 const plan=store.getRecord('source_learning_worker_artifact',JSON.stringify([libraryId,taskRef,'EXTRACTION_BATCH_PLAN']));
 const context=store.getRecord('source_learning_worker_artifact',JSON.stringify([libraryId,taskRef,'EXTRACTION_CONTEXT']));
 const sets=[...(plan?.batches??[]).map(b=>b.evidence_set),...Object.values(context?.examples??{})].filter(es=>Array.isArray(es.fragments));
 for(const es of sets)for(const fragment of es.fragments){
  const id=add(fragment),key=JSON.stringify([es.evidence_set_id,fragment.id??fragment.evidence_id]);
  if(oldIds.has(key))need(oldIds.get(key)===id,'DOCUMENT_SCOPE_SUPPORT_AMBIGUOUS');else oldIds.set(key,id);
 }
 const candidates=assessment.build.graph.candidate_archive.map(c=>{
  const evidence_ids=c.evidence_ids.map(id=>{const mapped=oldIds.get(JSON.stringify([c.evidence_set_ref,id]));need(mapped,'DOCUMENT_SCOPE_SUPPORT_MISSING');return mapped;});
  return{...structuredClone(c),id:c.candidate_id,evidence_ids:[...new Set(evidence_ids)],description:c.description};
 });
 return{plan:run.plan,candidates,evidenceMenu:[...menu.values()].sort((a,b)=>a.evidence_id.localeCompare(b.evidence_id)),snapshot,...(partialScopePublication?{readinessPolicy:PARTIAL_SCOPE_READINESS_POLICY,admissionInput:assessment.admission_input}:{})};
}
export function scopeTaskRestriction({store,core,libraryId,taskRef,assessment,coverage}){
 const deferrals=readScopeTaskAuditDeferrals({store,core,libraryId,taskRef,coverage});
 if(!deferrals.length)return null;
 return core('incremental_graph_v1','restrict_scope_tasks',{assessment_input:assessment.admission_input,coverage_prepared:coverage.prepared,coverage_raw:coverage.response.content,coverage_receipt:coverage.receipt,task_scope_deferrals:deferrals});
}
export function assertScopePublication({store,core,libraryId,taskRef,assessment,partialScopePublication=false}){
 const input=scopeCoverageInput({store,core,libraryId,taskRef,assessment,partialScopePublication});if(!input)return null;
 const hash=v=>core('primitives','hash',v).canonical_hash;
 const {recordId,record}=resolveScopeCoverageRecord({store,core,libraryId,taskRef,partial:partialScopePublication});
 need(record?.status==='RETURNED'&&record.receipt&&record.response,'DOCUMENT_SCOPE_REVIEW_REQUIRED');
 const expected=scopeCoverageKernelInput({...input,reviewProtocol:record.review_protocol??null});
 need(hash(record.prepared.input)===hash(expected),'DOCUMENT_SCOPE_REVIEW_BINDING_CHANGED');
 const checked=validateScopeCoverage({core,prepared:record.prepared,raw:record.response,receipt:record.receipt,currentSnapshot:input.snapshot});
 need(partialScopePublication?checked.partial_ready===true:checked.ready_for_publication===true,'DOCUMENT_SCOPE_REVIEW_BLOCKED');
 if(partialScopePublication){
  const restriction=scopeTaskRestriction({store,core,libraryId,taskRef,assessment,coverage:record}),effective=restriction??record.receipt;
  need(effective.reusable_task_ids.length&&effective.publishable_candidate_ids.length,'DOCUMENT_SCOPE_REVIEW_BLOCKED');
  return{publication_policy:PARTIAL_SCOPE_READINESS_POLICY,coverage_record_id:recordId,plan_id:input.plan.plan_id,plan_sha256:hash(input.plan),receipt_hash:record.receipt.receipt_hash,eligible_pool_sha256:hash(input.candidates),source_snapshot_sha256:hash(input.snapshot),limited_available:checked.limited_available,all_supported:restriction?false:checked.all_supported,partial_available:true,supported_task_ids:effective.supported_task_ids,reusable_task_ids:effective.reusable_task_ids,selected_candidate_ids:effective.publishable_candidate_ids,unresolved_task_ids:effective.unresolved_task_ids,whole_scope_complete:false,coverage_complete:false,...(restriction?{scope_task_restriction:restriction,audit_deferred_task_ids:restriction.audit_deferred_task_ids,machine_supported_task_ids:record.receipt.supported_task_ids}:{})};
 }
 return{plan_id:input.plan.plan_id,receipt_hash:record.receipt.receipt_hash,limited_available:checked.limited_available,all_supported:checked.all_supported};
}
