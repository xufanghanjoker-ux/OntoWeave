/** Durable document-first discovery. Model semantics stay in proposals; Rust
 * validates the evidence menu, exact anchors and source-bound scope plan. */
import {randomUUID} from 'node:crypto';
import {prepareDocumentScope,validateDocumentScope,documentScopeQuestion} from './document-scope-v1.mjs';
import {prepareScopeCoverage,materializeScopeCoverage,validateScopeCoverage,scopeCoverageKernelInput,scopeCoverageRecordKey,resolveScopeCoverageRecord,PARTIAL_SCOPE_READINESS_POLICY,SOURCE_CANDIDATE_COVERAGE_PROTOCOL} from './document-scope-coverage-v1.mjs';
import {prepareFamilyRoute,materializeFamilyRoute,validateFamilyRoute} from './document-family-route-v1.mjs';
import {createFamilyNormalizationHost,validateNormalizedScopeRun} from './document-family-normalization-host-v1.mjs';
import {prepareFamilyNormalization,validateFamilyNormalization} from './document-family-normalize-v1.mjs';
const VERSION='lightog-document-scope-host/0.3';
const clone=structuredClone;
const fail=code=>Object.assign(Error(code),{code,status:409});
const need=(ok,code)=>{if(!ok)throw fail(code);};
export function createDocumentScopeHost({store,core,models,prepareSource,readCoverageInput=null,readScopeTaskRestriction=null,onOperation=()=>{},partialScopePublicationDefault=false}){
 need(typeof partialScopePublicationDefault==='boolean','DOCUMENT_SCOPE_PUBLICATION_POLICY_INVALID');
 const hash=value=>core('primitives','hash',value).canonical_hash;
 const familyNormalizer=createFamilyNormalizationHost({store,core,models,onOperation});
 const active=new Map();
 const sourceKey=p=>hash({source_stamp:p.sourceStamp,policy:VERSION,user_cqs:p.cqSeeds,definitions:p.budgetInput.definitions??''});
 function current(libraryId){return prepareSource({libraryId,question:'Discover document-supported competency questions and applicable subjects.'});}
 function view(libraryId){
  const p=current(libraryId),key=sourceKey(p),row=store.getRecord('document_scope_run',key);
  if(!row)return{status:'PENDING',phase:'DOCUMENT_DISCOVERY',source_epoch:p.snapshot.source_epoch,families:[],tasks:[],coverage:[],errors:[]};
  if(row.status==='READY')validateNormalizedScopeRun({store,core,row,currentSnapshot:p.snapshot});
  const plan=row.plan,subjects=new Map((plan?.subjects??[]).map(s=>[s.id,s]));
  const normalized=store.getRecord('document_family_normalization',row.normalization_id??row.id);
  let review=store.listRecords('document_scope_coverage').find(r=>r.library_id===libraryId&&r.plan_id===plan?.plan_id&&(r.readiness_policy??null)===(partialScopePublicationDefault?PARTIAL_SCOPE_READINESS_POLICY:null)),reviewStale=false;
  const reviewHead=partialScopePublicationDefault?store.listRecords('document_scope_coverage_head').find(r=>r.library_id===libraryId&&r.plan_id===plan?.plan_id):null;
  if(reviewHead){try{review=resolveScopeCoverageRecord({store,core,libraryId,taskRef:reviewHead.task_ref,partial:true}).record;}catch{review=null;reviewStale=true;}}
  let receipt=review?.receipt,restriction=null;
  if(receipt&&readCoverageInput){try{
   const fresh=readCoverageInput({libraryId,taskRef:review.task_ref});
   need(fresh&&hash(review.prepared.input)===hash(scopeCoverageKernelInput({...fresh,reviewProtocol:review.review_protocol??null})),'DOCUMENT_SCOPE_REVIEW_BINDING_CHANGED');
   validateScopeCoverage({core,prepared:review.prepared,raw:review.response,receipt,currentSnapshot:fresh.snapshot});
   if(partialScopePublicationDefault&&readScopeTaskRestriction)restriction=readScopeTaskRestriction({libraryId,taskRef:review.task_ref});
  }catch{receipt=null;reviewStale=true;}}
  const effective=restriction??receipt,partial=Boolean(partialScopePublicationDefault&&effective?.partial_ready),supported=effective?.supported_task_ids??receipt?.rows?.filter(r=>r.decision==='SUPPORTED').map(r=>r.task_id)??[];
  const auditDeferred=new Set(restriction?.audit_deferred_task_ids??[]),auditDecisions=new Map((restriction?.task_scope_deferrals??[]).map(d=>[d.task_id,d]));
  const observations=new Map((receipt?.row_observations??[]).map(r=>[r.task_id,r]));
  const coverage=clone(receipt?.rows??[]).map(r=>{const o=observations.get(r.task_id),decision=o?o.derived_decision:r.decision;return{...r,...(o?{decision,derived_decision:decision,decision_origin:'RUST_DERIVED',effective_status:o.effective_status,protocol_valid:o.protocol_valid,error_codes:clone(o.error_codes??[])}:{}),...(partialScopePublicationDefault?{execution_status:o?.effective_status==='PROTOCOL_HOLD'?'TECHNICAL_BLOCKED':({SUPPORTED:'READY',SOURCE_INSUFFICIENT:'SOURCE_INSUFFICIENT',EXTRACTION_GAP:'PENDING_EXTRACTION',UNKNOWN:'UNRESOLVED'})[decision]??'NOT_CHECKED'}:{}),...(auditDeferred.has(r.task_id)?{scope_audit_deferred:true,scope_audit_status:'DEFERRED',scope_audit_reason:auditDecisions.get(r.task_id)?.reason??null,model_effective_status:o?.effective_status??decision,effective_status:'TASK_DEFERRED',execution_status:'UNRESOLVED'}:{})};});
  return{...(plan?clone(plan):{}),status:row.status,phase:row.phase,source_epoch:p.snapshot.source_epoch,run_id:row.id,
   normalization:normalized?{status:normalized.status,original_proposals:normalized.prepared?.proposal_manifest?.length??null,canonical_families:plan?.families?.length??0,subjects:plan?.subjects?.length??0,all_proposals_accounted:normalized.receipt?.all_proposals_accounted??false,unresolved:clone(normalized.receipt?.unresolved??[]),scope_policy:'ALL_DISCOVERED_AFTER_NORMALIZATION',semantic_faithfulness_certified:false}:null,
   families:(plan?.families??[]).map(f=>({...f,question_template:f.question_template??f.question,subjects:(f.subjects??f.subject_ids?.map(id=>subjects.get(id)).filter(Boolean)??[]).map(s=>({...s,label:s.label??s.surface}))})),
   tasks:clone(plan?.tasks??[]),coverage,row_observations:clone(receipt?.row_observations??[]),review_protocol:review?.review_protocol??null,scope_publication_status:reviewStale?'NOT_CHECKED':partial&&!effective.ready_for_publication?'PARTIALLY_READY':effective?.ready_for_publication?(effective.limited_available?'LIMITED_AVAILABLE':'READY'):receipt?'BLOCKED':review?.status??'NOT_CHECKED',coverage_receipt_hash:receipt?.receipt_hash??null,...(partialScopePublicationDefault?{publication_policy:PARTIAL_SCOPE_READINESS_POLICY,partial_available:partial,supported_task_ids:clone(supported),reusable_task_ids:clone(effective?.reusable_task_ids??[]),selected_candidate_ids:clone(effective?.publishable_candidate_ids??[]),unresolved_task_ids:clone(effective?.unresolved_task_ids??[]),source_insufficient_task_ids:clone(receipt?.source_insufficient_task_ids??[]),covered_task_count:(effective?.reusable_task_ids??supported).length,total_task_count:plan?.tasks?.length??0,source_insufficient_task_count:receipt?.source_insufficient_task_ids?.length??coverage.filter(r=>r.decision==='SOURCE_INSUFFICIENT').length,unresolved_task_count:effective?.unresolved_task_ids?.length??coverage.filter(r=>['UNKNOWN','EXTRACTION_GAP'].includes(r.decision)).length,extraction_gap_task_count:receipt?.extraction_gap_task_ids?.length??coverage.filter(r=>r.decision==='EXTRACTION_GAP').length,unknown_task_count:receipt?.unknown_task_ids?.length??coverage.filter(r=>r.decision==='UNKNOWN').length,not_checked_task_count:receipt?0:plan?.tasks?.length??0,technical_blocked_task_count:receipt?.protocol_held_task_ids?.length??null,protocol_held_task_ids:clone(receipt?.protocol_held_task_ids??[]),...(restriction?{scope_task_restriction_hash:restriction.restriction_hash,audit_deferred_task_ids:clone(restriction.audit_deferred_task_ids),audit_deferred_task_count:restriction.audit_deferred_task_ids.length,machine_supported_task_ids:clone(receipt.supported_task_ids)}:{}),whole_scope_complete:false}:{}),errors:[...(row.error_code?[{code:row.error_code}]:[]),...(review?.error_code?[{code:review.error_code}]:[]),...(reviewStale?[{code:'DOCUMENT_SCOPE_REVIEW_BINDING_CHANGED'}]:[])],
   generated_cqs:(plan?.families??[]).map(f=>f.question??f.question_template).filter(q=>typeof q==='string'&&q.trim()),
   progress:{completed:row.batches_completed??0,total:row.batches_total??null},semantic_support_certified:false,coverage_complete:false};
 }
 async function discover({libraryId}){
  const initial=current(libraryId),id=sourceKey(initial);
  if(active.has(id))return active.get(id);
  const run=(async()=>{
   const existing=store.getRecord('document_scope_run',id);
   if(existing?.status==='READY'){
    validateNormalizedScopeRun({store,core,row:existing,currentSnapshot:initial.snapshot});
    validateDocumentScope({core,prepared:existing.prepared,responses:existing.responses,plan:existing.plan,currentSnapshot:initial.snapshot});
    return clone(existing.plan);
   }
   need(!['FAILED','UNKNOWN_NO_RETRY','SUPERSEDED','PARTIAL_SCOPE'].includes(existing?.status),'DOCUMENT_SCOPE_REQUIRES_EXPLICIT_RECOVERY');
   const configured=models().generation;need(configured?.complete,'DOCUMENT_SCOPE_MODEL_NOT_CONFIGURED');
   const prepared=existing?.discovery_prepared??existing?.prepared??prepareDocumentScope({core,snapshot:initial.snapshot,evidenceSet:initial.evidenceSet,context:initial.context,userCqs:initial.cqSeeds.map(q=>q.text),definitions:initial.budgetInput.definitions??''});
   const row=existing??{id,contract_version:VERSION,library_id:libraryId,source_stamp:initial.sourceStamp,model_binding:initial.modelBindings.generation,prepared,status:'RUNNING',phase:'DOCUMENT_DISCOVERY',batches_completed:0,batches_total:prepared.batches.length,created_at:new Date().toISOString()};
   store.putRecord('document_scope_run',id,row);
   const update=values=>{Object.assign(row,values);store.putRecord('document_scope_run',id,row);};
   const initialModelBinding=hash(initial.modelBindings.generation);
   const revalidate=()=>{const p=current(libraryId);need(sourceKey(p)===id&&hash(p.modelBindings.generation)===initialModelBinding,'DOCUMENT_SCOPE_SOURCE_OR_MODEL_CHANGED');return p;};
   try{
    const responses=[];
    for(const [index,batch] of prepared.batches.entries()){
     revalidate();
     const attemptId=hash({run:id,batch:batch.batch_id}),prior=store.getRecord('document_scope_attempt',attemptId);
     if(prior){need(prior.status==='RETURNED'&&prior.response,'DOCUMENT_SCOPE_UNKNOWN_NO_AUTOMATIC_RESEND');need(!['length','max_tokens'].includes(prior.response.finish_reason),'DOCUMENT_SCOPE_OUTPUT_TRUNCATED');responses.push({batch_id:batch.batch_id,raw:prior.response.content});continue;}
     const schema=core('provider_schema_v1','compile_qwen',{contract_version:'lightog-provider-schema/0.1',name:'document_scope',schema:batch.output_schema});
     const request={messages:batch.messages,response_format:schema.response_format,phase:'DOCUMENT_CQ_DISCOVERY_'+String(index).padStart(3,'0'),enable_thinking:false};
     const requestId=randomUUID(),attempt={id:attemptId,run_id:id,request_id:requestId,batch_id:batch.batch_id,request_sha256:hash(request),model_binding:initial.modelBindings.generation,status:'STARTED',started_at:new Date().toISOString()};
     store.putRecord('document_scope_attempt',attemptId,attempt);
     onOperation(1);
     let received=false;
     try{
      const response=await models().generation.complete(request.messages,{phase:request.phase,request_id:requestId,enable_thinking:false,response_format:request.response_format});received=true;
      // Persist the known return before semantic parsing or source revalidation.
      store.putRecord('document_scope_attempt',attemptId,{...attempt,status:'RETURNED',response:clone(response),returned_at:new Date().toISOString()});
      need(!['length','max_tokens'].includes(response.finish_reason),'DOCUMENT_SCOPE_OUTPUT_TRUNCATED');
      revalidate();responses.push({batch_id:batch.batch_id,raw:response.content});update({batches_completed:responses.length});
     }catch(error){
      if(!received)store.putRecord('document_scope_attempt',attemptId,{...attempt,status:'UNKNOWN_NO_RETRY',error_code:error.code??'DOCUMENT_SCOPE_PROVIDER_FAILED_OR_UNKNOWN'});
      throw error;
     }finally{onOperation(-1);}
    }
    revalidate();update({phase:'FAMILY_NORMALIZATION',normalization_required:true,discovery_prepared:prepared,discovery_responses:responses});
    const normalized=await familyNormalizer.normalize({runId:id,libraryId,preparedDiscovery:prepared,responses,modelBinding:initial.modelBindings.generation,revalidate});
    if(!normalized.receipt.ready_for_scope_build){update({status:'PARTIAL_SCOPE',normalization_id:normalized.id,plan:normalized.receipt.partial_plan??null,error_code:'DOCUMENT_FAMILY_NORMALIZATION_UNRESOLVED'});throw fail('DOCUMENT_FAMILY_NORMALIZATION_UNRESOLVED');}
    const plan=normalized.receipt.normalized_plan,normalizedPrepared={...normalized.receipt.normalized_prepared,kernel_prepared:normalized.receipt.normalized_prepared};
    need(!plan.pending_batches?.length,'DOCUMENT_SCOPE_BATCHES_INCOMPLETE');
    need(plan.families?.length&&plan.tasks?.length,'DOCUMENT_SCOPE_NO_SUPPORTED_TASKS');
    validateDocumentScope({core,prepared:normalizedPrepared,responses:normalized.receipt.normalized_responses,plan,currentSnapshot:revalidate().snapshot});
    update({status:'READY',phase:'SCOPE_PLANNED',plan,prepared:normalizedPrepared,responses:normalized.receipt.normalized_responses,normalization_id:normalized.id,batches_completed:responses.length,completed_at:new Date().toISOString()});return clone(plan);
   }catch(error){
    const unknown=[...store.listRecords('document_scope_attempt'),...store.listRecords('document_family_normalization')].some(a=>a.run_id===id&&['STARTED','UNKNOWN_NO_RETRY'].includes(a.status));
    update({status:error.code==='DOCUMENT_SCOPE_SOURCE_OR_MODEL_CHANGED'?'SUPERSEDED':unknown?'UNKNOWN_NO_RETRY':row.status==='PARTIAL_SCOPE'?'PARTIAL_SCOPE':'FAILED',error_code:error.code??'DOCUMENT_SCOPE_DISCOVERY_FAILED'});throw error;
   }
  })();
  active.set(id,run);try{return await run;}finally{active.delete(id);}
 }
 function buildQuestion(plan){
  need(plan?.families?.length&&plan.tasks?.length,'DOCUMENT_SCOPE_PLAN_REQUIRED');
  return documentScopeQuestion({core,plan}).question;
 }
 function forQuestion({libraryId,question,planId=null}){
  const p=current(libraryId),row=store.getRecord('document_scope_run',sourceKey(p));
  if(row?.status!=='READY')return null;
  validateNormalizedScopeRun({store,core,row,currentSnapshot:p.snapshot});
  validateDocumentScope({core,prepared:row.prepared,responses:row.responses,plan:row.plan,currentSnapshot:p.snapshot});
  const built=documentScopeQuestion({core,plan:row.plan,currentSnapshot:p.snapshot});
  if(planId!==null)need(planId===row.plan.plan_id&&question===built.question,'DOCUMENT_SCOPE_BUILD_BINDING_CHANGED');
  if(question!==built.question)return null;
  const subjects=new Map(row.plan.subjects.map(s=>[s.id,s]));
  return{plan_id:row.plan.plan_id,source_epoch:p.snapshot.source_epoch,plan:clone(row.plan),tasks:clone(row.plan.tasks),families:row.plan.families.map(f=>({id:f.id,label:f.label,question:f.question,target:f.target,operation:f.operation,conditions:f.conditions.map(c=>({text:c.text,evidence_ids:c.evidence_ids??c.evidence?.map(e=>e.evidence_id)})),subjects:f.subject_ids.map(id=>({id,surface:subjects.get(id)?.surface})),evidence_ids:f.evidence?.map(e=>e.evidence_id)??f.evidence_ids})),semantic_support_certified:false};
 }
 async function assessCoverage({libraryId,taskRef,readInput,reviewProtocol=null,requestReason=null,requestId=null,expectedGenerationModel=null}){
  const fresh=reviewProtocol!==null;
  if(fresh)need(partialScopePublicationDefault&&reviewProtocol===SOURCE_CANDIDATE_COVERAGE_PROTOCOL&&requestReason==='USER_REQUESTED_MODEL_CHANGE'&&typeof requestId==='string'&&requestId.trim()&&requestId.length<=256&&typeof expectedGenerationModel==='string'&&expectedGenerationModel.trim(),'DOCUMENT_SCOPE_FRESH_REVIEW_REQUEST_REQUIRED');
  else need(requestReason===null&&requestId===null&&expectedGenerationModel===null,'DOCUMENT_SCOPE_FRESH_REVIEW_PROTOCOL_REQUIRED');
  const input=()=>{const value=readInput();return value?{...value,...(fresh?{reviewProtocol}:{})}:value;};
  const initial=input();need(initial,'DOCUMENT_SCOPE_PLAN_REQUIRED');
  need((initial.readinessPolicy??null)===(partialScopePublicationDefault?PARTIAL_SCOPE_READINESS_POLICY:null),'DOCUMENT_SCOPE_PUBLICATION_POLICY_CHANGED');
  const provider=models().generation;need(provider?.complete,'DOCUMENT_SCOPE_MODEL_NOT_CONFIGURED');
  const modelBinding=current(libraryId).modelBindings.generation;if(fresh)need(modelBinding?.model===expectedGenerationModel,'DOCUMENT_SCOPE_FRESH_REVIEW_MODEL_MISMATCH');
  const id=scopeCoverageRecordKey(libraryId,taskRef,partialScopePublicationDefault,fresh?{reviewProtocol,modelSha256:hash(modelBinding),requestId}:null);
  const records=store.listRecords('document_scope_coverage'),sameScope=r=>r.library_id===libraryId&&r.plan_id===initial.plan.plan_id&&r.prepared?.input?.snapshot?.source_epoch===initial.snapshot.source_epoch&&hash(r.prepared.input.snapshot.sources)===hash(initial.snapshot.sources);
  need(!records.some(r=>sameScope(r)&&r.id!==id&&['STARTED','UNKNOWN_NO_RETRY'].includes(r.status)),'DOCUMENT_SCOPE_REVIEW_NO_AUTOMATIC_RESEND');
  const {prepared,messages,output_schema}=prepareScopeCoverage({core,...initial});
  const binding=hash({input:prepared.input,model:modelBinding});
  const revalidate=()=>need(hash({input:scopeCoverageKernelInput(input()),model:current(libraryId).modelBindings.generation})===binding,'DOCUMENT_SCOPE_REVIEW_BINDING_CHANGED');
  const activate=row=>{if(fresh)store.putRecord('document_scope_coverage_head',scopeCoverageRecordKey(libraryId,taskRef,true),{library_id:libraryId,task_ref:taskRef,plan_id:initial.plan.plan_id,coverage_record_id:id,receipt_hash:row.receipt.receipt_hash,record_sha256:hash(row),review_protocol:reviewProtocol,model_binding:clone(modelBinding)});};
  const prior=store.getRecord('document_scope_coverage',id);
  if(prior){need(prior.binding_sha256===binding,'DOCUMENT_SCOPE_REVIEW_BINDING_CHANGED');need(prior.status==='RETURNED'&&prior.receipt,'DOCUMENT_SCOPE_REVIEW_NO_AUTOMATIC_RESEND');revalidate();validateScopeCoverage({core,prepared:prior.prepared,raw:prior.response,receipt:prior.receipt,currentSnapshot:initial.snapshot});activate(prior);return clone(prior.receipt);}
  if(fresh)need(!records.some(r=>sameScope(r)&&r.review_protocol===reviewProtocol&&r.model_binding?.model===modelBinding?.model&&hash(r.prepared.input)===hash(prepared.input)),'DOCUMENT_SCOPE_SAME_MODEL_PROTOCOL_ALREADY_ATTEMPTED');
  const projection=core('provider_schema_v1','compile_qwen',{contract_version:'lightog-provider-schema/0.1',name:'document_scope_review',schema:output_schema});
  const options={phase:partialScopePublicationDefault?'DOCUMENT_SCOPE_REVIEW_PARTIAL':'DOCUMENT_SCOPE_REVIEW',request_id:randomUUID(),enable_thinking:false,max_tokens:12000,response_format:projection.response_format};
  const row={id,library_id:libraryId,task_ref:taskRef,plan_id:initial.plan.plan_id,...(partialScopePublicationDefault?{readiness_policy:PARTIAL_SCOPE_READINESS_POLICY}:{}),...(fresh?{review_protocol:reviewProtocol,request_reason:requestReason,review_request_id:requestId,expected_generation_model:expectedGenerationModel,model_binding:clone(modelBinding)}:{}),binding_sha256:binding,prepared,request_sha256:hash({messages,options}),request_id:options.request_id,status:'STARTED',started_at:new Date().toISOString()};
  store.putRecord('document_scope_coverage',id,row);onOperation(1);let received=false;
  try{
   revalidate();const response=await provider.complete(messages,options);received=true;
   Object.assign(row,{status:'RETURNED',response:clone(response),returned_at:new Date().toISOString()});store.putRecord('document_scope_coverage',id,row);
   revalidate();const receipt=materializeScopeCoverage({core,prepared,raw:response});
   Object.assign(row,{receipt});store.putRecord('document_scope_coverage',id,row);activate(row);return clone(receipt);
  }catch(error){
   const known=received||Boolean(error.provider_response_received)||Boolean(error.model_response);
   Object.assign(row,{status:known?'FAILED':'UNKNOWN_NO_RETRY',provider_outcome:known?'KNOWN_RETURNED_REJECTED':'UNKNOWN_NO_AUTOMATIC_RESEND',provider_response_received:known,error_code:error.code??'DOCUMENT_SCOPE_REVIEW_FAILED'});
   store.putRecord('document_scope_coverage',id,row);throw error;
  }
  finally{onOperation(-1);}
 }
 async function routeQuestion({libraryId,question,requestId,readInput}){
  const source=current(libraryId),run=store.getRecord('document_scope_run',sourceKey(source));
  if(run?.status!=='READY')return null;
  const input=()=>{const live=readInput();validateNormalizedScopeRun({store,core,row:run,currentSnapshot:live.snapshot});validateDocumentScope({core,prepared:run.prepared,responses:run.responses,plan:run.plan,currentSnapshot:live.snapshot});return{plan:run.plan,question,snapshot:live.snapshot,coverageReceipt:live.coverageReceipt??null,...(live.scopeTaskRestriction?{scopeTaskRestriction:live.scopeTaskRestriction}:{})};};
  const initial=input(),id=JSON.stringify([libraryId,requestId]);
  const binding=hash({input:initial,model:source.modelBindings.generation});
  const revalidate=()=>need(hash({input:input(),model:current(libraryId).modelBindings.generation})===binding,'DOCUMENT_FAMILY_ROUTE_BINDING_CHANGED');
  const prior=store.getRecord('document_family_route',id);
  if(prior){need(prior.binding_sha256===binding,'DOCUMENT_FAMILY_ROUTE_REQUEST_REUSED');need(prior.status==='RETURNED'&&prior.receipt,'DOCUMENT_FAMILY_ROUTE_NO_AUTOMATIC_RESEND');revalidate();validateFamilyRoute({core,prepared:prior.prepared,raw:prior.response,receipt:prior.receipt,currentSnapshot:initial.snapshot});return clone(prior.receipt);}
  const {prepared,messages,output_schema}=prepareFamilyRoute({core,...initial});
  const projection=core('provider_schema_v1','compile_qwen',{contract_version:'lightog-provider-schema/0.1',name:'document_family_route',schema:output_schema});
  const options={phase:'DOCUMENT_FAMILY_ROUTE',request_id:randomUUID(),enable_thinking:false,max_tokens:2500,response_format:projection.response_format};
  const row={id,library_id:libraryId,request_id:requestId,provider_request_id:options.request_id,binding_sha256:binding,prepared,request_sha256:hash({messages,options}),status:'STARTED',started_at:new Date().toISOString()};
  store.putRecord('document_family_route',id,row);let received=false;onOperation(1);
  try{
   revalidate();const response=await models().generation.complete(messages,options);received=true;
   Object.assign(row,{status:'RETURNED',response:clone(response),returned_at:new Date().toISOString()});store.putRecord('document_family_route',id,row);
   revalidate();const receipt=materializeFamilyRoute({core,prepared,raw:response});Object.assign(row,{receipt});store.putRecord('document_family_route',id,row);return clone(receipt);
  }catch(error){Object.assign(row,{status:received?'FAILED':'UNKNOWN_NO_RETRY',error_code:error.code??'DOCUMENT_FAMILY_ROUTE_FAILED'});store.putRecord('document_family_route',id,row);throw error;}
  finally{onOperation(-1);}
 }
 function adoptKnownNormalization({libraryId,preparedDiscovery,responses,normalizationPrepared,normalizationResponse,receipt,origin}){
  need(origin?.type==='KNOWN_RETURN_REPLAY'&&typeof origin.artifact_sha256==='string'&&/^[a-f0-9]{64}$/.test(origin.artifact_sha256),'DOCUMENT_SCOPE_REPLAY_ORIGIN_REQUIRED');
  const p=current(libraryId),id=sourceKey(p),prepared=prepareFamilyNormalization({core,preparedDiscovery,responses}).prepared;
  const discovery=preparedDiscovery.kernel_prepared??preparedDiscovery;
  need(hash(discovery.input.user_cqs)===hash(p.cqSeeds.map(q=>q.text.trim()).filter(Boolean))&&discovery.input.definitions===(p.budgetInput.definitions??''),'DOCUMENT_SCOPE_REPLAY_PURPOSE_CHANGED');
  need(hash(prepared)===hash(normalizationPrepared),'DOCUMENT_SCOPE_REPLAY_PREPARED_CHANGED');
  validateFamilyNormalization({core,prepared,raw:normalizationResponse,receipt,currentSnapshot:p.snapshot});
  const kernel=receipt.normalized_prepared,plan=receipt.normalized_plan??receipt.partial_plan;
  need(plan&&hash(preparedDiscovery.kernel_prepared??preparedDiscovery)===receipt.origin_discovery_prepared_sha256&&hash(responses)===receipt.origin_discovery_responses_sha256,'DOCUMENT_SCOPE_REPLAY_DISCOVERY_CHANGED');
  return store.transaction(()=>{
   need(hash(current(libraryId).sourceStamp)===hash(p.sourceStamp),'DOCUMENT_SCOPE_REPLAY_SOURCE_CHANGED');
   const prior=store.getRecord('document_scope_run',id);
   const priorNormalization=store.getRecord('document_family_normalization',id);
   if(priorNormalization)need(priorNormalization.status==='RETURNED'&&hash(priorNormalization.prepared)===hash(prepared)&&hash(priorNormalization.response)===hash(normalizationResponse)&&priorNormalization.receipt?.receipt_hash===receipt.receipt_hash,'DOCUMENT_SCOPE_REPLAY_NORMALIZATION_ALREADY_EXISTS');
   if(prior){need(prior.normalization_required&&prior.normalization_id===id&&hash(prior.plan)===hash(plan)&&store.getRecord('document_family_normalization',id)?.receipt?.receipt_hash===receipt.receipt_hash,'DOCUMENT_SCOPE_REPLAY_ALREADY_EXISTS');return{status:prior.status,plan_id:plan.plan_id,provider_calls_added:0,idempotent:true};}
   const now=new Date().toISOString();
   if(!priorNormalization)store.putRecord('document_family_normalization',id,{id,run_id:id,library_id:libraryId,status:'RETURNED',prepared,model_binding:origin.model_binding??null,response:clone(normalizationResponse),receipt:clone(receipt),replay_origin:clone(origin),actual_call:false,created_at:now,returned_at:now});
   const row={id,contract_version:VERSION,library_id:libraryId,source_stamp:p.sourceStamp,model_binding:origin.model_binding??null,status:receipt.ready_for_scope_build?'READY':'PARTIAL_SCOPE',phase:receipt.ready_for_scope_build?'SCOPE_PLANNED':'FAMILY_NORMALIZATION',normalization_required:true,normalization_id:id,discovery_prepared:clone(preparedDiscovery),discovery_responses:clone(responses),prepared:{...clone(kernel),kernel_prepared:clone(kernel)},responses:clone(receipt.normalized_responses),plan:clone(plan),batches_completed:responses.length,batches_total:responses.length,replay_origin:clone(origin),created_at:now};
   if(!receipt.ready_for_scope_build)row.error_code='DOCUMENT_FAMILY_NORMALIZATION_UNRESOLVED';
   store.putRecord('document_scope_run',id,row);
   if(receipt.ready_for_scope_build)validateNormalizedScopeRun({store,core,row,currentSnapshot:p.snapshot});
   return{status:row.status,plan_id:plan.plan_id,provider_calls_added:0,idempotent:false};
  });
 }
 return Object.freeze({view,discover,buildQuestion,forQuestion,assessCoverage,routeQuestion,adoptKnownNormalization});
}
