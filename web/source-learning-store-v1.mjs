/** SQLite owns durable state/readback. Rust owns learning/graph/index rules. */
import {randomUUID} from 'node:crypto';
import {searchPayload} from './source-retrieval-projection-v1.mjs';
import {assertScopePublication,scopeTaskRestriction} from './document-scope-publication-v1.mjs';
import {readScopeTaskAuditDeferrals} from './document-scope-task-audit-v1.mjs';
import {PARTIAL_SCOPE_READINESS_POLICY,resolveScopeCoverageRecord} from './document-scope-coverage-v1.mjs';
const VERSION='lightog-source-learning/0.1';
const fail=code=>Object.assign(Error(code),{code});
const need=(ok,code)=>{if(!ok)throw fail(code);};
const clone=structuredClone;
export function createSourceLearningStore({store,core,readRuntime,requireDocumentScopePublication=false,partialScopePublicationDefault=false}){
 need(store?.transaction&&typeof core==='function'&&typeof readRuntime==='function','SOURCE_LEARNING_HOST_REQUIRED');
 need(typeof requireDocumentScopePublication==='boolean','SOURCE_DOCUMENT_SCOPE_REQUIREMENT_INVALID');
 need(typeof partialScopePublicationDefault==='boolean'&&(!partialScopePublicationDefault||requireDocumentScopePublication),'SOURCE_PARTIAL_SCOPE_REQUIREMENT_INVALID');
 const hash=value=>core('primitives','hash',value).canonical_hash;
 const call=(op,payload)=>core('source_learning_v1',op,{contract_version:VERSION,...payload});
 const key=(libraryId,ref)=>JSON.stringify([libraryId,ref]);
 const head=libraryId=>store.getRecord('source_graph_head',libraryId);
 const version=(libraryId,revision)=>revision?store.getRecord('source_graph_version',key(libraryId,revision)):null;
 const observed=(libraryId,{job=null,graphRevision=null,readPurpose,readbacks={}}={})=>{
  need(typeof readPurpose==='string'&&readPurpose,'SOURCE_LEARNING_READ_PURPOSE_REQUIRED');
  const trusted=readRuntime({libraryId,job,graphRevision,readPurpose});
  need(trusted&&typeof trusted.then!=='function'&&trusted.context&&trusted.runtime,'SOURCE_LEARNING_SYNC_RUNTIME_REQUIRED');
  need(trusted.runtime.current_snapshot?.graph_revision===graphRevision,'SOURCE_LEARNING_RUNTIME_READ_REVISION_MISMATCH');
  return {context:trusted.context,runtime:{...trusted.runtime,persisted_job_sha256:job?.job_sha256??null,persisted_revision:job?.revision??0,...readbacks}};
 };
 const find=(libraryId,taskRef)=>{const row=store.getRecord('source_learning_job',key(libraryId,taskRef));need(row&&row.library_id===libraryId,'SOURCE_LEARNING_JOB_NOT_FOUND');return row.job;};
 const persistJob=(libraryId,job)=>{need(typeof job?.task_ref==='string','SOURCE_LEARNING_JOB_INVALID');store.putRecord('source_learning_job',key(libraryId,job.task_ref),{library_id:libraryId,job});};
 const immutable=(kind,id,value)=>{const prior=store.getRecord(kind,id);if(prior){need(hash(prior)===hash(value),'SOURCE_LEARNING_IMMUTABLE_RECORD_CHANGED');return prior;}store.putRecord(kind,id,value);return store.getRecord(kind,id);};
 const cas=(job,expected)=>need(typeof expected==='string'&&job.job_sha256===expected,'SOURCE_LEARNING_JOB_CAS_MISMATCH');
 function mutate(libraryId,taskRef,expectedJobSha256,op,payload){
  return store.transaction(()=>{const job=find(libraryId,taskRef);cas(job,expectedJobSha256);const indexStart=op==='begin_attempt'&&job.stage==='INDEX_PENDING';const closing=op==='step'&&['FAILED','STOPPED','SUPERSEDED'].includes(payload.next_stage);
   const result=call(op,{...payload,job,...observed(libraryId,{job,graphRevision:indexStart?job.commit_receipt.output_graph_revision:job.snapshot.graph_revision,readPurpose:indexStart?'INDEX_ATTEMPT':closing?'LEARNING_CLOSE':'LEARNING_'+op.toUpperCase()})});persistJob(libraryId,result.job);return result;});
 }
 function project(libraryId,graphRevision,readPurpose){
  const row=version(libraryId,graphRevision);need(row?.library_id===libraryId&&row.write_set,'SOURCE_LEARNING_GRAPH_RECORD_MISSING');
  return {...call('project_read',{write_set:row.write_set,read_snapshot:row.write_set.read_snapshot,...observed(libraryId,{graphRevision,readPurpose,readbacks:{graph_record_sha256:hash(row.write_set)}})}),write_set:row.write_set};
 }
 function assertLatestPending(libraryId,job,revision){const current=head(libraryId);need(current?.committed_graph_revision===revision&&job.commit_receipt?.output_graph_revision===revision,'SOURCE_LEARNING_INDEX_HEAD_SUPERSEDED');return current;}
 function indexReady({libraryId,taskRef,expectedJobSha256,validationPayload}){
  need(validationPayload?.trusted_index,'SOURCE_LEARNING_ACTUAL_INDEX_PAYLOAD_REQUIRED');validationPayload=clone(validationPayload);const indexPayload=clone(validationPayload.trusted_index);
  return store.transaction(()=>{
   const job=find(libraryId,taskRef);cas(job,expectedJobSha256);need(job.stage==='INDEX_PENDING','SOURCE_LEARNING_INDEX_STAGE_INVALID');const revision=job.commit_receipt.output_graph_revision,current=assertLatestPending(libraryId,job,revision),recordKey=key(libraryId,revision);need(!store.getRecord('source_index_generation',recordKey),'SOURCE_LEARNING_INDEX_GENERATION_ALREADY_EXISTS');
   const indexRef='slindex_'+randomUUID(),receipt=store.getRecord('source_graph_commit',key(libraryId,job.commit_receipt.receipt_ref));need(receipt,'SOURCE_LEARNING_COMMIT_RECORD_MISSING');const bundle=version(libraryId,revision)?.write_set;need(bundle,'SOURCE_LEARNING_GRAPH_RECORD_MISSING');
   // Real payload is stored/read before Rust derives ACK; rollback covers all.
   store.putRecord('source_index_generation',recordKey,{library_id:libraryId,status:'BUILDING',index_payload:indexPayload,validation_payload:validationPayload,index_ack:null});const readback=store.getRecord('source_index_generation',recordKey);
   need(hash(readback.index_payload)===hash(readback.validation_payload.trusted_index),'SOURCE_LEARNING_INDEX_READBACK_CHANGED');
   const prepared=call('prepare_index',{job,receipt,write_set:bundle,index_ref:indexRef,validation_payload:readback.validation_payload,...observed(libraryId,{job,graphRevision:revision,readPurpose:'INDEX_PREPARE',readbacks:{graph_record_sha256:hash(bundle),commit_record_sha256:hash(receipt),index_record_sha256:null,index_payload_sha256:hash(readback.index_payload)}})});
   store.putRecord('source_index_generation',recordKey,{...readback,status:'READY',index_ack:prepared.index_ack,projection_receipt:prepared.projection_receipt});const ready=store.getRecord('source_index_generation',recordKey);
   const confirmed=call('confirm_index',{job,receipt,write_set:bundle,index_ack:ready.index_ack,projection_receipt:ready.projection_receipt,validation_payload:ready.validation_payload,...observed(libraryId,{job,graphRevision:revision,readPurpose:'INDEX_CONFIRM',readbacks:{graph_record_sha256:hash(bundle),commit_record_sha256:hash(receipt),index_record_sha256:hash(ready.index_ack),index_payload_sha256:hash(ready.index_payload)}})});
   persistJob(libraryId,confirmed.job);store.putRecord('source_graph_head',libraryId,{...current,active_graph_revision:revision,index_state:'READY'});return {...confirmed,index_ack:ready.index_ack,projection_receipt:ready.projection_receipt,graph_revision:revision,index_status:'READY'};
  });
 }
 function candidateAssessmentInput(libraryId,taskRef){
  const row=store.getRecord('source_candidate_incremental_ledger',key(libraryId,taskRef));
  need(row?.library_id===libraryId,'SOURCE_LEARNING_INCREMENTAL_LEDGER_MISSING');
  const job=find(libraryId,taskRef),live=observed(libraryId,{job,graphRevision:job.snapshot.graph_revision,readPurpose:'INCREMENTAL_PUBLICATION_ASSESS'});
  const context=clone(live.context),plan=store.getRecord('source_learning_worker_artifact',JSON.stringify([libraryId,taskRef,'EXTRACTION_BATCH_PLAN']));
  need(plan?.receipt_sha256===row.ledger.plan_sha256,'SOURCE_LEARNING_INCREMENTAL_PLAN_CHANGED');
  for(const entry of row.ledger.entries)if(entry.status==='ACCOUNTED'){const es=plan.batches[entry.batch_index]?.evidence_set;need(es,'SOURCE_LEARNING_INCREMENTAL_PLAN_CHANGED');context.examples[es.evidence_set_id]=es;}
  const materializationReports=row.ledger.entries.filter(entry=>entry.status==='ACCOUNTED').map(entry=>{
   const suffix=String(entry.batch_index).padStart(3,'0');
   const materialized=store.getRecord('source_learning_worker_artifact',JSON.stringify([libraryId,taskRef,'MATERIALIZED_'+suffix]));
   return{batch_index:entry.batch_index,status:materialized?'PERSISTED':'MISSING',
    candidates_sha256:materialized?hash(materialized.candidates):null,
    quarantined:materialized?.quarantined??[],source_refs:[...new Set((store.getRecord('source_learning_worker_artifact',JSON.stringify([libraryId,taskRef,'BATCH_PREPARED_'+suffix]))?.payload?.evidence_menu??[]).map(f=>f.source_ref))].sort()};
  });
  const reviewBundles=store.listRecords('source_candidate_review_bundle').filter(r=>r.library_id===libraryId&&r.task_ref===taskRef).map(r=>({batch_index:r.batch_index,review_input:r.review_input}));
  const latest=new Map();for(const record of store.listRecords('source_candidate_human_decision').filter(r=>r.library_id===libraryId&&r.task_ref===taskRef&&!r.recovery_id).sort((a,b)=>(a.sequence??0)-(b.sequence??0)||a.created_at.localeCompare(b.created_at)))latest.set(record.decision.candidate_id,record.decision);
  const recoveries=store.listRecords('source_candidate_recovery').filter(r=>r.library_id===libraryId&&r.task_ref===taskRef).map(r=>{const latest=new Map();for(const h of store.listRecords('source_candidate_human_decision').filter(h=>h.recovery_id===r.id).sort((a,b)=>(a.sequence??0)-(b.sequence??0)))latest.set(h.decision.candidate_id,h.decision);return latest.size?{...r.bundle,human_decisions:[...latest.values()]}:r.bundle;});
  const sourceAudits=store.listRecords('source_candidate_source_audit_deferral').filter(r=>r.library_id===libraryId&&r.task_ref===taskRef).map(r=>{
   const origin=store.getRecord('source_candidate_source_audit_origin',r.origin_record_id),review=store.getRecord('source_candidate_review_bundle',JSON.stringify([libraryId,taskRef,r.batch_index]));
   need(origin&&hash(origin)===r.origin_sha256&&origin.actor==='ASSISTANT_SOURCE_AUDIT'&&origin.action==='DEFER'&&origin.decision_id===r.decision.decision_id&&origin.reason===r.decision.reason&&origin.source_snapshot_sha256===r.decision.source_snapshot_sha256&&review&&origin.review_input_sha256===hash(review.review_input),'SOURCE_AUDIT_ORIGIN_CHANGED');return r.decision;
  });
  return{ledger:row.ledger,current_snapshot:live.runtime.current_snapshot,recovery_bundles:recoveries,materialization_reports:materializationReports,review_bundles:reviewBundles,human_decisions:[...latest.values()],trusted_context:context,...(sourceAudits.length?{source_audit_deferrals:sourceAudits}:{})};
 }
 return Object.freeze({
  appendCandidateBatch({libraryId,taskRef,planSha256,batchCount,batchIndex,status,requestId,stagingInput,errorCode}){
   return store.transaction(()=>{
    const job=find(libraryId,taskRef);
    need(job.snapshot?.base_ref===libraryId,'SOURCE_LEARNING_INCREMENTAL_SOURCE_INVALID');
    // Re-read the live source scope in the same short transaction as the CAS.
    const live=observed(libraryId,{job,graphRevision:job.snapshot.graph_revision,readPurpose:'INCREMENTAL_CANDIDATE_APPEND'});
    need(hash(live.runtime.current_snapshot)===hash(job.snapshot),'SOURCE_LEARNING_INCREMENTAL_SOURCE_CHANGED');
    const recordKey=key(libraryId,taskRef),prior=store.getRecord('source_candidate_incremental_ledger',recordKey);
    const initial=core('incremental_graph_v1','init',{contract_version:'lightog-incremental-graph/0.1',task_ref:taskRef,source_snapshot:job.snapshot,plan_sha256:planSha256,batch_count:batchCount});
    if(prior)need(prior.library_id===libraryId&&prior.ledger.task_ref===taskRef&&prior.ledger.plan_sha256===planSha256&&prior.ledger.batch_count===batchCount&&hash(prior.ledger.source_snapshot)===hash(job.snapshot),'SOURCE_LEARNING_INCREMENTAL_PLAN_CHANGED');
    const result=core('incremental_graph_v1','append',{ledger:prior?.ledger??initial,batch_index:batchIndex,status,request_id:requestId,...(status==='ACCOUNTED'?{staging_input:stagingInput}:{error_code:errorCode})});
    if(!result.idempotent)store.putRecord('source_candidate_incremental_ledger',recordKey,{library_id:libraryId,task_ref:taskRef,ledger:result.ledger});
    return {...result,progress:core('incremental_graph_v1','progress',{ledger:result.ledger})};
   });
  },
  candidateProgress({libraryId,taskRef}){
   const row=store.getRecord('source_candidate_incremental_ledger',key(libraryId,taskRef));
   if(!row)return null;
   need(row.library_id===libraryId,'SOURCE_LEARNING_INCREMENTAL_LIBRARY_CHANGED');
   return core('incremental_graph_v1','progress',{ledger:row.ledger});
  },
  recordCandidateReview({libraryId,taskRef,batchIndex,reviewInput}){
   return store.transaction(()=>{
    const row=store.getRecord('source_candidate_incremental_ledger',key(libraryId,taskRef));
    need(row?.library_id===libraryId,'SOURCE_LEARNING_INCREMENTAL_LEDGER_MISSING');
    const job=find(libraryId,taskRef),live=observed(libraryId,{job,graphRevision:job.snapshot.graph_revision,readPurpose:'INCREMENTAL_REVIEW_RECORD'});
    need(hash(live.runtime.current_snapshot)===hash(job.snapshot),'SOURCE_LEARNING_INCREMENTAL_SOURCE_CHANGED');
    const result=core('incremental_graph_v1','review_batch',{ledger:row.ledger,batch_index:batchIndex,review_input:reviewInput});
    const id=JSON.stringify([libraryId,taskRef,batchIndex]),prior=store.getRecord('source_candidate_review_bundle',id);
    if(prior){need(hash(prior.review_input)===hash(reviewInput)&&hash(prior.review_result)===hash(result),'SOURCE_LEARNING_INCREMENTAL_REVIEW_CHANGED');return {...prior,idempotent:true};}
    const saved={library_id:libraryId,task_ref:taskRef,batch_index:batchIndex,entry_sha256:result.entry_sha256,review_input:clone(reviewInput),review_result:result};
    store.putRecord('source_candidate_review_bundle',id,saved);return {...saved,idempotent:false};
   });
  },
  recordHumanCandidateDecision({libraryId,taskRef,batchIndex,candidateId,action,reason,requestId,recoveryId=null}){
   return store.transaction(()=>{
    need(typeof requestId==='string'&&requestId,'SOURCE_HUMAN_SEMANTIC_REQUEST_INVALID');
    if(recoveryId){
     const recovery=store.getRecord('source_candidate_recovery',recoveryId);need(recovery?.library_id===libraryId&&recovery.task_ref===taskRef&&recovery.batch_index===batchIndex,'RECOVERY_RECORD_NOT_FOUND');
     const job=find(libraryId,taskRef),live=observed(libraryId,{job,graphRevision:job.snapshot.graph_revision,readPurpose:'RECOVERY_HUMAN_DECISION'});
     const decided=core('candidate_recovery_v1','decide',{bundle:recovery.bundle,current_snapshot:live.runtime.current_snapshot,candidate_id:candidateId,action,reason}).decision;
     const requestKey=JSON.stringify([libraryId,taskRef,requestId]),prior=store.getRecord('source_candidate_human_request',requestKey);
     if(prior){need(prior.decision_id===decided.decision_id,'SOURCE_HUMAN_SEMANTIC_REQUEST_REUSED');return{decision:store.getRecord('source_candidate_human_decision',decided.decision_id),idempotent:true};}
     const existing=store.listRecords('source_candidate_human_decision').filter(r=>r.recovery_id===recoveryId&&r.decision.candidate_id===candidateId).sort((a,b)=>(a.sequence??0)-(b.sequence??0)).at(-1);
     need(!existing||existing.decision.decision_id===decided.decision_id||existing.decision.action==='DEFER','SOURCE_HUMAN_SEMANTIC_ALREADY_DECIDED');
     const saved={library_id:libraryId,task_ref:taskRef,batch_index:batchIndex,recovery_id:recoveryId,decision:decided,sequence:(existing?.sequence??0)+1,created_at:new Date().toISOString()};store.putRecord('source_candidate_human_decision',decided.decision_id,saved);store.putRecord('source_candidate_human_request',requestKey,{library_id:libraryId,task_ref:taskRef,request_id:requestId,decision_id:decided.decision_id});return{decision:saved,idempotent:false};
    }
    const row=store.getRecord('source_candidate_incremental_ledger',key(libraryId,taskRef)),review=store.getRecord('source_candidate_review_bundle',JSON.stringify([libraryId,taskRef,batchIndex]));
    need(row?.library_id===libraryId&&review?.library_id===libraryId,'SOURCE_HUMAN_SEMANTIC_REVIEW_MISSING');
    const job=find(libraryId,taskRef),live=observed(libraryId,{job,graphRevision:job.snapshot.graph_revision,readPurpose:'INCREMENTAL_HUMAN_DECISION'});
    const decided=core('incremental_graph_v1','decide_human',{ledger:row.ledger,batch_index:batchIndex,candidate_id:candidateId,review_input:review.review_input,current_snapshot:live.runtime.current_snapshot,action,reason,actor:'LOCAL_OPERATOR'}).decision;
    const requestKey=JSON.stringify([libraryId,taskRef,requestId]),priorRequest=store.getRecord('source_candidate_human_request',requestKey);
    if(priorRequest){need(priorRequest.decision_id===decided.decision_id,'SOURCE_HUMAN_SEMANTIC_REQUEST_REUSED');return{decision:store.getRecord('source_candidate_human_decision',decided.decision_id),idempotent:true};}
    const existing=store.listRecords('source_candidate_human_decision').filter(r=>r.library_id===libraryId&&r.task_ref===taskRef&&r.decision.candidate_id===candidateId).sort((a,b)=>(a.sequence??0)-(b.sequence??0)).at(-1);
    need(!existing||existing.decision.decision_id===decided.decision_id||existing.decision.action==='DEFER','SOURCE_HUMAN_SEMANTIC_ALREADY_DECIDED');
    const saved={library_id:libraryId,task_ref:taskRef,batch_index:batchIndex,decision:decided,sequence:(existing?.sequence??0)+1,created_at:new Date().toISOString()};
    store.putRecord('source_candidate_human_decision',decided.decision_id,saved);
    store.putRecord('source_candidate_human_request',requestKey,{library_id:libraryId,task_ref:taskRef,request_id:requestId,decision_id:decided.decision_id});
    return{decision:saved,idempotent:false};
   });
  },
  recordCandidateRecovery({libraryId,taskRef,bundle}){
   return store.transaction(()=>{
    const job=find(libraryId,taskRef),live=observed(libraryId,{job,graphRevision:job.snapshot.graph_revision,readPurpose:'LOCAL_RECOVERY_RECORD'});
    need(hash(live.runtime.current_snapshot)===hash(bundle.recovery_input.current_snapshot)&&bundle.recovery_input.origin_job.task_ref===taskRef,'RECOVERY_SOURCE_CHANGED');
    const verified=core('candidate_recovery_v1','verify',bundle),input=bundle.recovery_input;
    const id=JSON.stringify([libraryId,taskRef,input.batch_index,input.mode,input.fact_index??null]);
    const row={id,library_id:libraryId,task_ref:taskRef,batch_index:input.batch_index,mode:input.mode,fact_index:input.fact_index??null,bundle:clone(bundle),verified};
    const prior=store.getRecord('source_candidate_recovery',id);if(prior){need(hash(prior)===hash(row),'RECOVERY_RECORD_CHANGED');return prior;}
    store.putRecord('source_candidate_recovery',id,row);
    // Replay the full assessment before committing the recovery record.
    core('incremental_graph_v1','assess_publication',candidateAssessmentInput(libraryId,taskRef));return row;
   });
  },
  deferCandidateForSourceAudit({libraryId,taskRef,batchIndex,candidateId,reason}){
   need(partialScopePublicationDefault,'SOURCE_PARTIAL_SCOPE_DISABLED');
   return store.transaction(()=>{
    const row=store.getRecord('source_candidate_incremental_ledger',key(libraryId,taskRef)),review=store.getRecord('source_candidate_review_bundle',JSON.stringify([libraryId,taskRef,batchIndex]));
    need(row?.library_id===libraryId&&review?.library_id===libraryId,'SOURCE_AUDIT_REVIEW_REQUIRED');
    const job=find(libraryId,taskRef),live=observed(libraryId,{job,graphRevision:job.snapshot.graph_revision,readPurpose:'SOURCE_AUDIT_DEFER'});
    const checked=core('incremental_graph_v1','defer_source_audit',{ledger:row.ledger,batch_index:batchIndex,candidate_id:candidateId,review_input:review.review_input,current_snapshot:live.runtime.current_snapshot,reason,actor:'ASSISTANT_SOURCE_AUDIT',action:'DEFER'}),decision=checked.decision;
    const id=JSON.stringify([libraryId,taskRef,candidateId]),prior=store.getRecord('source_candidate_source_audit_deferral',id);
    if(prior){need(hash(prior.decision)===hash(decision),'SOURCE_AUDIT_DEFERRAL_CHANGED');return{...prior,idempotent:true};}
    const origin={library_id:libraryId,task_ref:taskRef,batch_index:batchIndex,candidate_id:candidateId,decision_id:decision.decision_id,actor:'ASSISTANT_SOURCE_AUDIT',action:'DEFER',reason,review_input_sha256:hash(review.review_input),source_snapshot_sha256:hash(live.runtime.current_snapshot),created_at:new Date().toISOString(),source_audit_only:true};
    const record={id,library_id:libraryId,task_ref:taskRef,batch_index:batchIndex,candidate_id:candidateId,decision,origin_record_id:id,origin_sha256:hash(origin)};
    store.putRecord('source_candidate_source_audit_origin',id,origin);store.putRecord('source_candidate_source_audit_deferral',id,record);
    // The core replays every seal; this record can only remove an eligible fact.
    core('incremental_graph_v1','assess_partial_publication',candidateAssessmentInput(libraryId,taskRef));return{...record,idempotent:false};
   });
  },
  assessCandidatePublication({libraryId,taskRef}){
   return core('incremental_graph_v1','assess_publication',candidateAssessmentInput(libraryId,taskRef));
  },
  assessPartialCandidatePublication({libraryId,taskRef}){
   need(partialScopePublicationDefault,'SOURCE_PARTIAL_SCOPE_DISABLED');
   const input=candidateAssessmentInput(libraryId,taskRef);
   return{...core('incremental_graph_v1','assess_partial_publication',input),admission_input:input};
  },
  assessDocumentScopeTaskRestriction({libraryId,taskRef}){
   need(partialScopePublicationDefault,'SOURCE_PARTIAL_SCOPE_DISABLED');
   const {record:coverage}=resolveScopeCoverageRecord({store,core,libraryId,taskRef,partial:true});
   if(!coverage?.receipt)return null;
   const deferrals=readScopeTaskAuditDeferrals({store,core,libraryId,taskRef,coverage});if(!deferrals.length)return null;
   return scopeTaskRestriction({store,core,libraryId,taskRef,assessment:this.assessPartialCandidatePublication({libraryId,taskRef}),coverage});
  },
  deferDocumentScopeTaskForSourceAudit({libraryId,taskRef,coverageRecordId,expectedCoverageReceiptHash,taskId,reason,requestId,expectedPublishedGraphRevision}){
   need(partialScopePublicationDefault,'SOURCE_PARTIAL_SCOPE_DISABLED');
   need(typeof requestId==='string'&&/^[A-Za-z0-9_-]{1,96}$/.test(requestId)&&typeof expectedPublishedGraphRevision==='string','DOCUMENT_SCOPE_TASK_AUDIT_REQUEST_REQUIRED');
   return store.transaction(()=>{
    const {recordId,record:coverage}=resolveScopeCoverageRecord({store,core,libraryId,taskRef,partial:true});
    need(recordId===coverageRecordId&&coverage?.status==='RETURNED'&&coverage.receipt?.receipt_hash===expectedCoverageReceiptHash,'DOCUMENT_SCOPE_TASK_AUDIT_COVERAGE_CHANGED');
    const assessment=this.assessPartialCandidatePublication({libraryId,taskRef});
    const checked=core('incremental_graph_v1','defer_scope_task',{coverage_prepared:coverage.prepared,coverage_raw:coverage.response.content,coverage_receipt:coverage.receipt,current_snapshot:assessment.admission_input.current_snapshot,task_id:taskId,reason,actor:'ASSISTANT_SCOPE_AUDIT',action:'DEFER'}),decision=checked.decision;
    const id=JSON.stringify([libraryId,taskRef,expectedCoverageReceiptHash,taskId]),requestKey=JSON.stringify([libraryId,requestId]),requestBinding=hash({libraryId,taskRef,coverageRecordId,expectedCoverageReceiptHash,taskId,reason});
    const request=store.getRecord('document_scope_task_audit_request',requestKey);need(!request||request.binding_sha256===requestBinding,'DOCUMENT_SCOPE_TASK_AUDIT_REQUEST_REUSED');
    const prior=store.getRecord('document_scope_task_audit_deferral',id);
    if(prior){need(hash(prior.decision)===hash(decision),'DOCUMENT_SCOPE_TASK_AUDIT_CHANGED');const effective=this.assessDocumentScopeTaskRestriction({libraryId,taskRef}),published=store.getRecord('source_graph_publication_head',libraryId),record=published?store.getRecord('source_graph_publication',key(libraryId,published.published_graph_revision)):null;return{...prior,idempotent:true,effective_selection:effective,needs_republish:record?.document_scope_review?.scope_task_restriction?.restriction_hash!==effective.restriction_hash,model_calls_added:0};}
    need(store.getRecord('source_graph_publication_head',libraryId)?.published_graph_revision===expectedPublishedGraphRevision,'SOURCE_PUBLICATION_HEAD_CAS_MISMATCH');
    const origin={library_id:libraryId,task_ref:taskRef,task_id:taskId,coverage_record_id:recordId,coverage_receipt_hash:expectedCoverageReceiptHash,actor:'ASSISTANT_SCOPE_AUDIT',action:'DEFER',reason,request_id:requestId,decision_sha256:hash(decision),scope_audit_only:true,created_at:new Date().toISOString()};
    const record={id,library_id:libraryId,task_ref:taskRef,task_id:taskId,coverage_record_id:recordId,coverage_receipt_hash:expectedCoverageReceiptHash,decision,origin_record_id:id,origin_sha256:hash(origin)};
    store.putRecord('document_scope_task_audit_origin',id,origin);store.putRecord('document_scope_task_audit_deferral',id,record);store.putRecord('document_scope_task_audit_request',requestKey,{id:requestKey,library_id:libraryId,binding_sha256:requestBinding,deferral_record_id:id});
    return{...record,idempotent:false,effective_selection:this.assessDocumentScopeTaskRestriction({libraryId,taskRef}),needs_republish:true,model_calls_added:0};
   });
  },
  preparePartialPublication({libraryId,taskRef}){
   need(partialScopePublicationDefault,'SOURCE_PARTIAL_SCOPE_DISABLED');
   const job=find(libraryId,taskRef),current=head(libraryId);
   need(job.stage==='COMPLETED'&&current?.committed_graph_revision===job.commit_receipt?.output_graph_revision&&current.active_graph_revision===current.committed_graph_revision&&current.index_state==='READY','SOURCE_PUBLICATION_CANDIDATE_INDEX_NOT_READY');
   const assessmentInput=candidateAssessmentInput(libraryId,taskRef),assessment={...core('incremental_graph_v1','assess_partial_publication',assessmentInput),admission_input:assessmentInput};
   need(assessment.ready_for_scope_review===true,'SOURCE_PARTIAL_SCOPE_REVIEW_PENDING');
   const scopeReview=assertScopePublication({store,core,libraryId,taskRef,assessment,partialScopePublication:true});need(scopeReview,'DOCUMENT_SCOPE_REVIEW_REQUIRED');
   const {record:coverage}=resolveScopeCoverageRecord({store,core,libraryId,taskRef,partial:true});
   const active=this.readGraphSnapshot({libraryId});need(active?.write_set?.builds?.length===1&&active.write_set.builds[0].task_ref===taskRef,'SOURCE_PUBLICATION_UNREVIEWED_BASE_BUILDS');
   const coverageInput={assessment_input:assessmentInput,coverage_prepared:coverage.prepared,coverage_raw:coverage.response.content,coverage_receipt:coverage.receipt,...(scopeReview.scope_task_restriction?{task_scope_deferrals:readScopeTaskAuditDeferrals({store,core,libraryId,taskRef,coverage})}:{})};
   const prepared=core('incremental_graph_v1','partial_formal_bundle',{...coverageInput,candidate_write_set:active.write_set}),writeSet=prepared.write_set;
   const live=observed(libraryId,{job,graphRevision:null,readPurpose:'FORMAL_INDEX_BUILD'});
   need(hash({...live.runtime.current_snapshot,graph_revision:writeSet.output_graph_revision})===hash(writeSet.read_snapshot),'SOURCE_PUBLICATION_FORMAL_SOURCE_CHANGED');
   const context=clone(live.context);context.authority.allowed_snapshots=[writeSet.read_snapshot];
   const projection=call('project_read',{write_set:writeSet,read_snapshot:writeSet.read_snapshot,context,runtime:{...live.runtime,current_snapshot:writeSet.read_snapshot,graph_record_sha256:hash(writeSet)}});
   // A fresh deterministic lexical projection of the verified subset. This is
   // not a claim of vector parity and sends no embedding/model request.
   const validationPayload=call('project_index_payload',{validation_payload:searchPayload({question:job.request.raw_question,context:projection.context,evidenceSets:projection.evidence_sets,p2Build:projection.p2Build})}).validation_payload;
   const verified=call('validate_projection_index',{projection,validation_payload:validationPayload});
   const ack={contract_version:'lightog-incremental-formal-index/0.1',status:'READY',mode:'LEXICAL',task_ref:taskRef,graph_revision:writeSet.output_graph_revision,graph_digest:writeSet.graph_digest,index_payload_sha256:verified.index_payload_sha256,projection_receipt_sha256:verified.projection_receipt_sha256};
   const confirmed=core('incremental_graph_v1','confirm_partial_publication',{...coverageInput,candidate_build:writeSet.builds[0],index_ack:ack,candidate_graph_revision:writeSet.output_graph_revision});
   return{assessmentInput,assessment,scopeReview,active_revision:active.graph_revision,active_write_set_sha256:hash(active.write_set),writeSet,validationPayload,indexPayload:validationPayload.trusted_index,ack,projection,confirmed,scope_binding:prepared};
  },
  publishPartialReviewedCandidate({libraryId,taskRef,expectedPublishedGraphRevision=null}){
   const before=this.preparePartialPublication({libraryId,taskRef});
   return store.transaction(()=>{
    const published=store.getRecord('source_graph_publication_head',libraryId);need((published?.published_graph_revision??null)===expectedPublishedGraphRevision,'SOURCE_PUBLICATION_HEAD_CAS_MISMATCH');
    const live=this.preparePartialPublication({libraryId,taskRef});need(hash(live)===hash(before),'SOURCE_PUBLICATION_PREPARED_STATE_CHANGED');
    const revision=live.writeSet.output_graph_revision,receipt=live.confirmed.publication_receipt;
    immutable('source_graph_version',key(libraryId,revision),{library_id:libraryId,write_set:live.writeSet});
    immutable('source_index_generation',key(libraryId,revision),{library_id:libraryId,status:'READY',index_payload:live.indexPayload,validation_payload:live.validationPayload,index_ack:live.ack,projection_receipt:live.projection.projection_receipt});
    const record={library_id:libraryId,task_ref:taskRef,receipt,publication_policy:PARTIAL_SCOPE_READINESS_POLICY,scope_availability:live.scopeReview.all_supported?'READY':'PARTIAL',whole_scope_complete:false,coverage_complete:false,candidate_graph_revision:live.active_revision,source_snapshot:live.assessmentInput.current_snapshot,review_bundles_sha256:receipt.review_bundles_sha256,document_scope_review:live.scopeReview};
    const recordKey=key(libraryId,revision),prior=store.getRecord('source_graph_publication',recordKey);if(prior){need(hash(prior)===hash(record),'SOURCE_PUBLICATION_RECEIPT_CHANGED');return{...prior,idempotent:true};}
    store.putRecord('source_graph_publication',recordKey,record);store.putRecord('source_graph_publication_head',libraryId,{library_id:libraryId,published_graph_revision:revision,receipt_sha256:receipt.receipt_sha256,source_snapshot_sha256:receipt.source_snapshot_sha256,publication_policy:PARTIAL_SCOPE_READINESS_POLICY});return{...record,idempotent:false};
   });
  },
  publishReviewedCandidate({libraryId,taskRef,expectedPublishedGraphRevision=null}){
   const jobBefore=find(libraryId,taskRef),inputBefore=candidateAssessmentInput(libraryId,taskRef),assessmentBefore=core('incremental_graph_v1','assess_publication',inputBefore);
   need(assessmentBefore.ready_for_index===true,'SOURCE_PUBLICATION_REVIEW_PENDING');
   const scopeBefore=assertScopePublication({store,core,libraryId,taskRef,assessment:assessmentBefore});
   need(!requireDocumentScopePublication||scopeBefore,'DOCUMENT_SCOPE_REVIEW_REQUIRED');
   const activeBefore=this.readGraphSnapshot({libraryId});
   need(activeBefore?.write_set?.builds?.length===1&&activeBefore.write_set.builds[0].task_ref===taskRef,'SOURCE_PUBLICATION_UNREVIEWED_BASE_BUILDS');
   const filtered=assessmentBefore.coverage.excluded_candidates>0||inputBefore.recovery_bundles.length>0;
   let formal=null;
   if(filtered){
    const prepared=core('incremental_graph_v1','formal_bundle',{assessment_input:inputBefore,candidate_write_set:activeBefore.write_set});
    const writeSet=prepared.write_set;
    const live=observed(libraryId,{job:jobBefore,graphRevision:null,readPurpose:'FORMAL_INDEX_BUILD'});
    need(hash({...live.runtime.current_snapshot,graph_revision:writeSet.output_graph_revision})===hash(writeSet.read_snapshot),'SOURCE_PUBLICATION_FORMAL_SOURCE_CHANGED');
    const formalContext=clone(live.context);formalContext.authority.allowed_snapshots=[writeSet.read_snapshot];
    const projection=call('project_read',{write_set:writeSet,read_snapshot:writeSet.read_snapshot,context:formalContext,runtime:{...live.runtime,current_snapshot:writeSet.read_snapshot,graph_record_sha256:hash(writeSet)}});
    const validationPayload=call('project_index_payload',{validation_payload:searchPayload({question:jobBefore.request.raw_question,context:projection.context,evidenceSets:projection.evidence_sets,p2Build:projection.p2Build})}).validation_payload;
    const verified=call('validate_projection_index',{projection,validation_payload:validationPayload});
    const ack={contract_version:'lightog-incremental-formal-index/0.1',status:'READY',mode:'LEXICAL',
     task_ref:taskRef,graph_revision:writeSet.output_graph_revision,graph_digest:writeSet.graph_digest,
     index_payload_sha256:verified.index_payload_sha256,projection_receipt_sha256:verified.projection_receipt_sha256};
    formal={writeSet,validationPayload,indexPayload:validationPayload.trusted_index,ack,projection};
   }
   return store.transaction(()=>{
    const current=head(libraryId),published=store.getRecord('source_graph_publication_head',libraryId);
    need((published?.published_graph_revision??null)===expectedPublishedGraphRevision,'SOURCE_PUBLICATION_HEAD_CAS_MISMATCH');
    const job=find(libraryId,taskRef);
    need(job.stage==='COMPLETED'&&current?.committed_graph_revision===job.commit_receipt?.output_graph_revision&&current?.active_graph_revision===current.committed_graph_revision&&current.index_state==='READY','SOURCE_PUBLICATION_CANDIDATE_INDEX_NOT_READY');
    const assessmentInput=candidateAssessmentInput(libraryId,taskRef),assessment=core('incremental_graph_v1','assess_publication',assessmentInput);
    need(assessment.ready_for_index===true,'SOURCE_PUBLICATION_REVIEW_PENDING');
    const scopeReview=assertScopePublication({store,core,libraryId,taskRef,assessment});
    need(!requireDocumentScopePublication||scopeReview,'DOCUMENT_SCOPE_REVIEW_REQUIRED');
    need(hash(scopeReview)===hash(scopeBefore),'DOCUMENT_SCOPE_REVIEW_BINDING_CHANGED');
    const active=this.readGraphSnapshot({libraryId});need(active?.graph_revision===current.active_graph_revision,'SOURCE_PUBLICATION_ACTIVE_CHANGED');
    const matches=active.write_set.builds.filter(b=>b.task_ref===taskRef);need(matches.length===1&&active.write_set.builds.length===1,'SOURCE_PUBLICATION_UNREVIEWED_BASE_BUILDS');
    need(hash(assessmentInput)===hash(inputBefore)&&active.graph_revision===activeBefore.graph_revision&&hash(active.write_set)===hash(activeBefore.write_set),'SOURCE_PUBLICATION_PREPARED_STATE_CHANGED');
    let selected=active;
    if(formal){
     const replay=core('incremental_graph_v1','formal_bundle',{assessment_input:assessmentInput,candidate_write_set:active.write_set});
     need(hash(replay.write_set)===hash(formal.writeSet),'SOURCE_PUBLICATION_FORMAL_BUILD_CHANGED');
     const revision=formal.writeSet.output_graph_revision;
     immutable('source_graph_version',key(libraryId,revision),{library_id:libraryId,write_set:formal.writeSet});
     immutable('source_index_generation',key(libraryId,revision),{library_id:libraryId,status:'READY',index_payload:formal.indexPayload,validation_payload:formal.validationPayload,index_ack:formal.ack,projection_receipt:formal.projection.projection_receipt});
     selected={write_set:formal.writeSet,index_ack:formal.ack,graph_revision:revision};
    }
    const confirmed=core('incremental_graph_v1','confirm_publication',{assessment_input:assessmentInput,candidate_build:selected.write_set.builds[0],index_ack:selected.index_ack,candidate_graph_revision:selected.graph_revision});
    const receipt=confirmed.publication_receipt,recordKey=key(libraryId,receipt.graph_revision),prior=store.getRecord('source_graph_publication',recordKey);
    if(prior){need(hash(prior.receipt)===hash(receipt),'SOURCE_PUBLICATION_RECEIPT_CHANGED');return{...prior,idempotent:true};}
    const record={library_id:libraryId,task_ref:taskRef,receipt,candidate_graph_revision:active.graph_revision,source_snapshot:assessmentInput.current_snapshot,review_bundles_sha256:receipt.review_bundles_sha256,...(scopeReview?{document_scope_review:scopeReview}:{})};
    store.putRecord('source_graph_publication',recordKey,record);
    store.putRecord('source_graph_publication_head',libraryId,{library_id:libraryId,published_graph_revision:selected.graph_revision,receipt_sha256:receipt.receipt_sha256,source_snapshot_sha256:receipt.source_snapshot_sha256});
    return{...record,idempotent:false};
   });
  },
  get({libraryId,taskRef}){const job=find(libraryId,taskRef);call('validate',{job,...observed(libraryId,{job,graphRevision:job.snapshot.graph_revision,readPurpose:'LEARNING_STATUS'})});return clone(job);},
  head({libraryId}){return clone(head(libraryId));},
  create({libraryId,request,evidenceSet,sourceGap=null}){
   return store.transaction(()=>{const revision=evidenceSet?.snapshot?.graph_revision??null;
    const result=call('create',{request,evidence_set:evidenceSet,source_gap:sourceGap,...observed(libraryId,{graphRevision:revision,readPurpose:'LEARNING_CREATE'})});const id=key(libraryId,result.job.task_ref),old=store.getRecord('source_learning_job',id);
    if(old){need(old.library_id===libraryId&&old.job.idempotency_key===result.idempotency_key,'SOURCE_LEARNING_IDEMPOTENCY_CONFLICT');return {job:clone(old.job),idempotency_key:result.idempotency_key,status:'IDEMPOTENT_EXISTING_JOB',created:false};}
    persistJob(libraryId,result.job);return {...result,created:true};});
  },
  step({libraryId,taskRef,expectedJobSha256,nextStage}){return mutate(libraryId,taskRef,expectedJobSha256,'step',{next_stage:nextStage});},
  recordCachedProposal({libraryId,taskRef,expectedJobSha256,...result}){return store.transaction(()=>{const origin=find(libraryId,result.replay_input.origin_job.task_ref),queue=store.getRecord('source_product_queue',key(libraryId,origin.task_ref));need(hash(origin)===hash(result.replay_input.origin_job),'SOURCE_REPLAY_LIVE_ORIGIN_CHANGED');need(!['QUEUED','RUNNING'].includes(queue?.status),'SOURCE_REPLAY_ORIGIN_STILL_RUNNING');return mutate(libraryId,taskRef,expectedJobSha256,'record_cached_proposal',result);});},
  beginAttempt({libraryId,taskRef,expectedJobSha256,...attempt}){return mutate(libraryId,taskRef,expectedJobSha256,'begin_attempt',attempt);},
  finishAttempt({libraryId,taskRef,expectedJobSha256,...result}){return mutate(libraryId,taskRef,expectedJobSha256,'finish_attempt',result);},
  commitReviewed({libraryId,taskRef,expectedJobSha256,gateInput,candidateIds,rebuildSourceScope=false}){
   return store.transaction(()=>{
    let job=find(libraryId,taskRef);cas(job,expectedJobSha256);const previous=head(libraryId),base=version(libraryId,previous?.committed_graph_revision);
    const prepared=call('prepare_commit',{job,gate_input:gateInput,base_graph:base?.write_set??null,...(candidateIds?{candidate_ids:candidateIds}:{}),...(rebuildSourceScope?{rebuild_source_scope:true}:{}),...observed(libraryId,{job,graphRevision:job.snapshot.graph_revision,readPurpose:'LEARNING_COMMIT',readbacks:{graph_record_sha256:base?hash(base.write_set):null}})});job=prepared.job;persistJob(libraryId,job);
    const writeSet=immutable('source_graph_version',key(libraryId,prepared.write_set.output_graph_revision),{library_id:libraryId,write_set:prepared.write_set}).write_set;
    const plan=prepared.commit_plan,receipt={contract_version:'lightog-source-commit-receipt/0.1',receipt_ref:'slcommit_'+randomUUID(),task_ref:job.task_ref,idempotency_key:prepared.idempotency_key,commit_plan_sha256:plan.plan_sha256,input_snapshot_sha256:plan.input_snapshot_sha256,base_graph_digest:base?.write_set.graph_digest??null,output_graph_revision:writeSet.output_graph_revision,output_graph_digest:writeSet.graph_digest,write_set_sha256:hash(writeSet),index_state:'PENDING'};
    const saved=immutable('source_graph_commit',key(libraryId,receipt.receipt_ref),receipt);
    const confirmed=call('confirm_commit',{job,commit_plan:plan,persisted_write_set:writeSet,receipt:saved,...observed(libraryId,{job,graphRevision:job.snapshot.graph_revision,readPurpose:'LEARNING_COMMIT_CONFIRM',readbacks:{graph_record_sha256:hash(writeSet),commit_record_sha256:hash(saved),index_record_sha256:null,index_payload_sha256:null}})});
    persistJob(libraryId,confirmed.job);store.putRecord('source_graph_head',libraryId,{library_id:libraryId,committed_graph_revision:writeSet.output_graph_revision,active_graph_revision:previous?.active_graph_revision??null,receipt_ref:saved.receipt_ref,index_state:'PENDING'});
    return {...confirmed,receipt:saved,write_set:writeSet};
   });
  },
  commitCorrection({libraryId,taskRef,expectedJobSha256,correction}){
   return store.transaction(()=>{
    let job=find(libraryId,taskRef);cas(job,expectedJobSha256);const previous=head(libraryId),base=version(libraryId,previous?.committed_graph_revision);
    const prepared=call('prepare_correction_commit',{job,correction,base_graph:base?.write_set??null,...observed(libraryId,{job,graphRevision:job.snapshot.graph_revision,readPurpose:'LEARNING_COMMIT',readbacks:{graph_record_sha256:base?hash(base.write_set):null}})});job=prepared.job;persistJob(libraryId,job);if(!prepared.write_set)return prepared;
    const writeSet=immutable('source_graph_version',key(libraryId,prepared.write_set.output_graph_revision),{library_id:libraryId,write_set:prepared.write_set}).write_set;
    const plan=prepared.commit_plan,receipt={contract_version:'lightog-source-commit-receipt/0.1',receipt_ref:'slcommit_'+randomUUID(),task_ref:job.task_ref,idempotency_key:prepared.idempotency_key,commit_plan_sha256:plan.plan_sha256,input_snapshot_sha256:plan.input_snapshot_sha256,base_graph_digest:base?.write_set.graph_digest??null,output_graph_revision:writeSet.output_graph_revision,output_graph_digest:writeSet.graph_digest,write_set_sha256:hash(writeSet),index_state:'PENDING'};
    const saved=immutable('source_graph_commit',key(libraryId,receipt.receipt_ref),receipt);
    const confirmed=call('confirm_commit',{job,commit_plan:plan,persisted_write_set:writeSet,receipt:saved,...observed(libraryId,{job,graphRevision:job.snapshot.graph_revision,readPurpose:'LEARNING_COMMIT_CONFIRM',readbacks:{graph_record_sha256:hash(writeSet),commit_record_sha256:hash(saved),index_record_sha256:null,index_payload_sha256:null}})});
    persistJob(libraryId,confirmed.job);store.putRecord('source_graph_head',libraryId,{library_id:libraryId,committed_graph_revision:writeSet.output_graph_revision,active_graph_revision:previous?.active_graph_revision??null,receipt_ref:saved.receipt_ref,index_state:'PENDING'});
    return {...confirmed,receipt:saved,write_set:writeSet,correction_materialized:prepared.correction_materialized,correction_provenance:prepared.correction_provenance};
   });
  },
  projectCommitted({libraryId}){const current=head(libraryId);need(current?.committed_graph_revision,'SOURCE_LEARNING_GRAPH_NOT_COMMITTED');return project(libraryId,current.committed_graph_revision,'READ_COMMITTED');},
  indexReady,
  async refreshIndex({libraryId,taskRef,expectedJobSha256,buildIndex}){
   need(typeof buildIndex==='function','SOURCE_LEARNING_INDEX_BUILDER_REQUIRED');const job=find(libraryId,taskRef);cas(job,expectedJobSha256);need(job.stage==='INDEX_PENDING','SOURCE_LEARNING_INDEX_STAGE_INVALID');const revision=job.commit_receipt.output_graph_revision;assertLatestPending(libraryId,job,revision);
   const projection=project(libraryId,revision,'INDEX_BUILD_INPUT'),generated=await buildIndex({libraryId,job:clone(job),projection:clone(projection),writeSet:clone(projection.write_set)});
   return indexReady({libraryId,taskRef,expectedJobSha256,validationPayload:generated?.validationPayload});
  },
  readGraphSnapshot({libraryId}){
   const current=head(libraryId);if(!current?.active_graph_revision)return null;const revision=current.active_graph_revision,index=store.getRecord('source_index_generation',key(libraryId,revision));need(index?.library_id===libraryId&&index.status==='READY'&&index.index_ack?.status==='READY','SOURCE_LEARNING_ACTIVE_INDEX_RECORD_MISSING');
   need(index.index_ack.graph_revision===revision&&index.index_ack.index_payload_sha256===hash(index.index_payload)&&hash(index.validation_payload.trusted_index)===hash(index.index_payload),'SOURCE_LEARNING_ACTIVE_INDEX_PAYLOAD_CHANGED');
   let projection;try{projection=project(libraryId,revision,'READ_ACTIVE');}catch(e){if(['SOURCE_LEARNING_SOURCE_STALE','SOURCE_LEARNING_READ_SNAPSHOT_MISMATCH','SOURCE_SNAPSHOT_MISMATCH','SOURCE_REVISION_MISMATCH','EVIDENCE_HASH_MISMATCH'].includes(e.code))return null;throw e;}
   need(index.index_ack.projection_receipt_sha256===projection.projection_receipt.projection_sha256&&index.index_ack.read_snapshot_sha256===projection.projection_receipt.read_snapshot_sha256,'SOURCE_LEARNING_ACTIVE_PROJECTION_CHANGED');
   const workerScope=store.getRecord('source_learning_worker_scope',key(libraryId,index.index_ack.task_ref));
   return {...projection,index:clone(index.index_payload),validation_payload:clone(index.validation_payload),index_ack:clone(index.index_ack),index_model_bindings:workerScope?.scope?.modelBindings?clone(workerScope.scope.modelBindings):null,graph_revision:revision,index_status:'READY'};
  },
  readPublishedSnapshot({libraryId}){
   const published=store.getRecord('source_graph_publication_head',libraryId),revision=published?.published_graph_revision;
   if(!revision)return null;
   const record=store.getRecord('source_graph_publication',key(libraryId,revision)),index=store.getRecord('source_index_generation',key(libraryId,revision));
   need(record?.library_id===libraryId&&record.receipt?.graph_revision===revision&&record.receipt.receipt_sha256===published.receipt_sha256&&hash(record.source_snapshot)===published.source_snapshot_sha256,'SOURCE_PUBLICATION_RECORD_CHANGED');
   const unsigned=clone(record.receipt);delete unsigned.receipt_sha256;need(hash(unsigned)===record.receipt.receipt_sha256,'SOURCE_PUBLICATION_RECEIPT_CHANGED');
   need(index?.status==='READY'&&index.index_ack?.status==='READY'&&hash(index.index_ack)===record.receipt.index_ack_sha256&&hash(index.index_payload)===index.index_ack.index_payload_sha256&&hash(index.validation_payload.trusted_index)===hash(index.index_payload),'SOURCE_PUBLICATION_INDEX_CHANGED');
   let projection;try{projection=project(libraryId,revision,'READ_PUBLISHED');}catch(e){if(['SOURCE_DIRECTORY_EMPTY','SOURCE_DIRECTORY_TEXT_MISSING','SOURCE_DIRECTORY_TEXT_INVALID','SOURCE_DIRECTORY_HASH_CHANGED','SOURCE_DIRECTORY_KEY_CHANGED','SOURCE_DIRECTORY_REF_AMBIGUOUS','SOURCE_LEARNING_SOURCE_STALE','SOURCE_LEARNING_READ_SNAPSHOT_MISMATCH','SOURCE_SNAPSHOT_MISMATCH','SOURCE_REVISION_MISMATCH','EVIDENCE_HASH_MISMATCH'].includes(e.code))return null;throw e;}
   need(projection.write_set.builds.length===1&&projection.write_set.builds[0].task_ref===record.task_ref&&projection.write_set.builds[0].graph.graph_digest===record.receipt.graph_digest,'SOURCE_PUBLICATION_GRAPH_CHANGED');
   need(index.index_ack.graph_revision===revision&&index.index_ack.projection_receipt_sha256===projection.projection_receipt.projection_sha256,'SOURCE_PUBLICATION_PROJECTION_CHANGED');
   if(record.publication_policy===PARTIAL_SCOPE_READINESS_POLICY){
    if(!partialScopePublicationDefault)return null;
    try{
     const replay=this.preparePartialPublication({libraryId,taskRef:record.task_ref});
     need(hash(replay.writeSet)===hash(projection.write_set)&&hash(replay.ack)===hash(index.index_ack)&&hash(replay.confirmed.publication_receipt)===hash(record.receipt),'SOURCE_PARTIAL_PUBLICATION_REPLAY_CHANGED');
     need(hash(replay.scopeReview)===hash(record.document_scope_review)&&record.whole_scope_complete===false&&record.coverage_complete===false,'DOCUMENT_SCOPE_REVIEW_BINDING_CHANGED');
     need(record.scope_availability===(replay.scopeReview.all_supported?'READY':'PARTIAL')&&record.candidate_graph_revision===replay.active_revision&&record.review_bundles_sha256===record.receipt.review_bundles_sha256,'SOURCE_PARTIAL_PUBLICATION_METADATA_CHANGED');
    }catch(error){if(error.code?.startsWith('DOCUMENT_SCOPE_')||error.code?.startsWith('SCOPE_COVERAGE_')||error.code?.startsWith('INCREMENTAL_')||error.code?.startsWith('SOURCE_PARTIAL_'))return null;throw error;}
    return{...projection,index:clone(index.index_payload),index_ack:clone(index.index_ack),graph_revision:revision,index_status:'READY',index_model_bindings:null,publication_receipt:clone(record.receipt),publication_policy:record.publication_policy,scope_availability:record.scope_availability,whole_scope_complete:false,coverage_complete:false,document_scope_review:clone(record.document_scope_review)};
   }
   if(partialScopePublicationDefault)return null;
   // A former release may have omitted per-fact materialization quarantines.
   // Do not expose it as complete once the durable diagnostics reveal a gap.
   const assessment=this.assessCandidatePublication({libraryId,taskRef:record.task_ref});
   if(!assessment.ready_for_index)return null;
   try{const scopeReview=assertScopePublication({store,core,libraryId,taskRef:record.task_ref,assessment});need(!requireDocumentScopePublication||scopeReview,'DOCUMENT_SCOPE_REVIEW_REQUIRED');need(hash(scopeReview)===hash(record.document_scope_review??null),'DOCUMENT_SCOPE_REVIEW_BINDING_CHANGED');}
   catch(error){if(error.code?.startsWith('DOCUMENT_SCOPE_')||error.code?.startsWith('SCOPE_COVERAGE_'))return null;throw error;}
   const workerScope=store.getRecord('source_learning_worker_scope',key(libraryId,index.index_ack.task_ref));
   return{...projection,index:clone(index.index_payload),index_ack:clone(index.index_ack),graph_revision:revision,index_status:'READY',index_model_bindings:index.index_ack.mode==='LEXICAL'?null:workerScope?.scope?.modelBindings?clone(workerScope.scope.modelBindings):null,publication_receipt:clone(record.receipt)};
  }
 });
}
