/** Product composition: trusted host state and I/O, with Rust domain decisions. */
import {createCandidateRecovery} from './candidate-recovery-v1.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {createSourceCore} from './source-core-client-v1.mjs';
import {createSourceFirstService} from './source-first-service-v1.mjs';
import {createSourceLearningStore} from './source-learning-store-v1.mjs';
import {createSourceLearningWorker} from './source-learning-worker-v1.mjs';
import {createSourceProductBudgets} from './source-product-budgets-v1.mjs';
import {createSourceModels} from './source-models-v1.mjs';
import {assertLibraryActive} from './library-management.mjs';
import{createSourceProcessingState}from'./source-processing-state-v1.mjs';
import {sourceKey} from './knowledge-governance.mjs';
import {hydrateSource} from './source-document-adapter-v1.mjs';
import {createDocumentScopeHost} from './document-scope-host-v1.mjs';
import {scopeCoverageInput} from './document-scope-publication-v1.mjs';
const clone=structuredClone;
const fail=code=>Object.assign(Error(code),{code,status:409});
const need=(ok,code)=>{if(!ok)throw fail(code);};
const textSha=text=>createHash('sha256').update(text).digest('hex');
export function createSourceProductHost({store,governance,core:injectedCore,coreBinary,expectedCoreSha256,models:injectedModels,fetchImpl,onOperation=()=>{},saveDraft=job=>store.saveTask(job),pollMs=1000,structuredReviewDefault=false,splitReviewDefault=false,splitStrictReviewDefault=false,candidateMvpDefault=false,fineAnswerCitations=false,automaticExecution=false,localResolutionDefault=false,incrementalReviewDefault=false,documentFirstDefault=false,compactSourceBatches=false,strictAnswerOutputDefault=false,strictLearningOutputDefault=false,partialScopePublicationDefault=false,resolveDocument}){
 const controller=injectedModels?null:createSourceModels({fetchImpl,store}),models=injectedModels??controller.models;
 need(typeof models==='function','SOURCE_PRODUCT_MODELS_REQUIRED');
 const core=injectedCore??createSourceCore({coreBinary,expectedSha256:expectedCoreSha256??null});
 const hash=value=>core('primitives','hash',value).canonical_hash,key=(a,b)=>JSON.stringify([a,b]);
 let product,candidateProduct,repository,worker,draining=null,closed=false;
 need(typeof automaticExecution==='boolean','SOURCE_AUTOMATIC_EXECUTION_OPTION_INVALID');
 need(typeof partialScopePublicationDefault==='boolean'&&(!partialScopePublicationDefault||documentFirstDefault),'SOURCE_PARTIAL_SCOPE_REQUIREMENT_INVALID');
 const budgets=createSourceProductBudgets({store,core});
 const reserveCall=scope=>{
  const prepared=scope.budgetContext.operation==='SOURCE_LEARNING'
   ?worker.prepare({libraryId:scope.sourceStamp.base_id,question:scope.budgetContext.question,rebuildSourceScope:scope.budgetContext.rebuild_source_scope??false,proposalPolicyVersion:scope.budgetContext.proposal_policy_version??(scope.budgetContext.rebuild_source_scope?'source-learning-product-rebuild-v1':'source-learning-product-v1')})
   :product.prepare({libraryId:scope.sourceStamp.base_id,question:scope.budgetContext.question});
  return budgets.reserve(scope,prepared);
 };
 const baseService=createSourceFirstService({store,governance,core,models,reserveCall,readEmbeddingBudget:({budgetId})=>budgets.read(budgetId),providerOutputDefault:automaticExecution,fineAnswerCitations,strictAnswerOutputDefault});
 const readCoverageInput=({libraryId,taskRef})=>scopeCoverageInput({store,core,libraryId,taskRef,assessment:partialScopePublicationDefault?repository.assessPartialCandidatePublication({libraryId,taskRef}):repository.assessCandidatePublication({libraryId,taskRef}),partialScopePublication:partialScopePublicationDefault});
 const documentScope=documentFirstDefault?createDocumentScopeHost({store,core,models,prepareSource:args=>baseService.prepare(args),readCoverageInput,readScopeTaskRestriction:args=>repository.assessDocumentScopeTaskRestriction(args),onOperation,partialScopePublicationDefault}):null;
 function readRuntime({libraryId,job=null,graphRevision,readPurpose}={}){
  if(job&&['LEARNING_FINISH_ATTEMPT','LEARNING_STATUS','LEARNING_CLOSE'].includes(readPurpose)){
   // Finishing an already returned call is an observation, never permission to send or commit.
   const context=store.getRecord('source_learning_worker_artifact',JSON.stringify([libraryId,job.task_ref,'EXTRACTION_CONTEXT']))??{};
   const grants=store.listRecords('source_learning_grant').filter(g=>g.library_id===libraryId&&g.revoked!==true).map(g=>g.grant);
   return {context,runtime:{current_snapshot:job.snapshot,grants,persisted_job_sha256:job.job_sha256,persisted_revision:job.revision,support_hold_candidate_sha256:[],graph_record_sha256:null,commit_record_sha256:null,index_record_sha256:null,index_payload_sha256:null}};
  }
  const base=baseService.prepare({libraryId,question:job?.request?.raw_question??'Read current source directory'});
  const head=store.getRecord('source_graph_head',libraryId);
  const revision=graphRevision===undefined?(head?.active_graph_revision??null):graphRevision;
  if(revision!==null){
   const version=store.getRecord('source_graph_version',key(libraryId,revision));need(version?.library_id===libraryId,'SOURCE_RUNTIME_GRAPH_NOT_STORED');
   const wanted={...base.snapshot,graph_revision:revision};need(hash(wanted)===hash(version.write_set.read_snapshot),'SOURCE_LEARNING_SOURCE_STALE');
   if(readPurpose==='READ_ACTIVE')need(head?.active_graph_revision===revision,'SOURCE_RUNTIME_ACTIVE_CHANGED');
   if(['READ_COMMITTED','INDEX_BUILD_INPUT','INDEX_PREPARE','INDEX_CONFIRM'].includes(readPurpose))need(head?.committed_graph_revision===revision,'SOURCE_RUNTIME_COMMITTED_CHANGED');
  }
  const snapshot={...base.snapshot,graph_revision:revision},context=structuredClone(base.context);context.authority.allowed_snapshots=[snapshot];
  const grants=store.listRecords('source_learning_grant').filter(g=>g.library_id===libraryId&&g.revoked!==true).map(g=>g.grant);
  const holds=store.listRecords('source_learning_support_hold').filter(g=>g.library_id===libraryId).map(g=>g.candidate_sha256);
  return {context,runtime:{current_snapshot:snapshot,grants,persisted_job_sha256:job?.job_sha256??null,persisted_revision:job?.revision??0,support_hold_candidate_sha256:holds,graph_record_sha256:null,commit_record_sha256:null,index_record_sha256:null,index_payload_sha256:null}};
 }
 repository=createSourceLearningStore({store,core,readRuntime,requireDocumentScopePublication:documentFirstDefault,partialScopePublicationDefault});
 candidateProduct=createSourceFirstService({store,governance,core,models,reserveCall,readEmbeddingBudget:({budgetId})=>budgets.read(budgetId),providerOutputDefault:automaticExecution,fineAnswerCitations,strictAnswerOutputDefault,readGraphSnapshot:args=>repository.readGraphSnapshot(args)});
 product=createSourceFirstService({store,governance,core,models,reserveCall,readEmbeddingBudget:({budgetId})=>budgets.read(budgetId),providerOutputDefault:automaticExecution,fineAnswerCitations,strictAnswerOutputDefault,readGraphSnapshot:args=>repository.readPublishedSnapshot(args)??repository.readGraphSnapshot(args)});
 worker=createSourceLearningWorker({store,repository,core,models,reserveCall,prepareSource:args=>{
  const p=candidateProduct.prepare(args),scope=documentScope?.forQuestion(args);
  return scope?{...p,documentScope:scope}:p;
 },readRuntime,compactSourceBatches,assessDocumentScope:documentScope?({libraryId,taskRef})=>documentScope.assessCoverage({libraryId,taskRef,readInput:()=>readCoverageInput({libraryId,taskRef})}):null,structuredReviewDefault,splitReviewDefault,splitStrictReviewDefault,candidateMvpDefault,localResolutionDefault,incrementalReviewDefault,providerOutputDefault:automaticExecution,strictLearningOutputDefault,partialScopePublicationDefault});
 const processing=createSourceProcessingState({store,core,readCurrent:libraryId=>baseService.prepare({libraryId,question:'Read processing source directory'})});
 function prepared({libraryId,question,operation,rebuildSourceScope=false,proposalPolicyVersion,documentScopePlanId}){need(['ASK','LEARN'].includes(operation)&&typeof rebuildSourceScope==='boolean'&&(operation==='LEARN'||rebuildSourceScope===false),'SOURCE_OPERATION_INVALID');if(documentScopePlanId!==undefined)need(documentScope?.forQuestion({libraryId,question,planId:documentScopePlanId}),'DOCUMENT_SCOPE_PLAN_REQUIRED');return operation==='ASK'?product.prepare({libraryId,question}):worker.prepare({libraryId,question,rebuildSourceScope,proposalPolicyVersion});}
 function graphSnapshot({libraryId}){
  assertLibraryActive(store,libraryId);need(governance.baseFor(libraryId),'SOURCE_LIBRARY_NOT_FOUND');
  const head=repository.head({libraryId});
  const empty=(status,reasonCode)=>({contract_version:'lightog-source-product-graph/0.1',status,library_id:libraryId,graph_revision:null,index_status:'NONE',index_mode:null,retrieval_available:false,published_graph_revision:null,publication_status:'NOT_PUBLISHED',snapshot:null,builds:[],evidence_sets:[],source_texts:[],reason_code:reasonCode,model_calls:0,publication_performed:false,learning_started:false});
  if(!head?.committed_graph_revision)return empty('EMPTY','NO_COMMITTED_GRAPH');
  const staleCodes=new Set(['SOURCE_DIRECTORY_EMPTY','SOURCE_DIRECTORY_TEXT_MISSING','SOURCE_DIRECTORY_TEXT_INVALID','SOURCE_DIRECTORY_HASH_CHANGED','SOURCE_DIRECTORY_KEY_CHANGED','SOURCE_DIRECTORY_REF_AMBIGUOUS','SOURCE_LEARNING_SOURCE_STALE','SOURCE_LEARNING_READ_SNAPSHOT_MISMATCH','SOURCE_SNAPSHOT_MISMATCH','SOURCE_REVISION_MISMATCH','EVIDENCE_HASH_MISMATCH']);
  try{
   let projection,indexStatus=head.index_state==='PENDING'?'PENDING':'UNAVAILABLE',indexMode=null,indexReason=null;
   if(head.index_state==='READY'&&head.active_graph_revision===head.committed_graph_revision){
    try{projection=repository.readGraphSnapshot({libraryId});if(projection){indexStatus='READY';indexMode=projection.index_ack.mode;}else indexReason='ACTIVE_PROJECTION_NOT_CURRENT';}
    catch(error){if(!['SOURCE_LEARNING_ACTIVE_INDEX_RECORD_MISSING','SOURCE_LEARNING_ACTIVE_INDEX_PAYLOAD_CHANGED','SOURCE_LEARNING_ACTIVE_PROJECTION_CHANGED'].includes(error.code))throw error;indexReason=error.code;}
   }
   // projectCommitted revalidates the immutable bundle and current source scope;
   // an older active graph is never used as a substitute for the latest commit.
   projection??=repository.projectCommitted({libraryId});
   need(projection.graph_revision===head.committed_graph_revision,'SOURCE_GRAPH_COMMITTED_REVISION_CHANGED');
   const builds=clone(projection.write_set.builds),sets=new Map();for(const build of builds)for(const es of build.evidence_sets)sets.set(hash(es),clone(es));
   return {...(projection.graph_trust?{graph_trust:clone(projection.graph_trust)}:{}),contract_version:'lightog-source-product-graph/0.1',status:indexStatus==='READY'?'READY':indexStatus==='PENDING'?'COMMITTED_INDEX_PENDING':'COMMITTED_INDEX_UNAVAILABLE',library_id:libraryId,graph_revision:projection.graph_revision,index_status:indexStatus,index_mode:indexMode,retrieval_available:indexStatus==='READY',active_retrieval_graph_revision:head.active_graph_revision??null,published_graph_revision:null,publication_status:'NOT_PUBLISHED',snapshot:clone(projection.snapshot),builds,evidence_sets:[...sets.values()],source_texts:clone(projection.context.source_texts),projection_receipt:clone(projection.projection_receipt),reason_code:indexReason,original_build_snapshots_preserved:true,semantic_support_certified:false,model_calls:0,publication_performed:false,learning_started:false};
  }catch(error){return empty(staleCodes.has(error.code)?'SOURCE_INVALIDATED':'GRAPH_UNAVAILABLE',error.code??'SOURCE_GRAPH_READ_FAILED');}
 }
 function publishedGraphSnapshot({libraryId}){
  assertLibraryActive(store,libraryId);need(governance.baseFor(libraryId),'SOURCE_LIBRARY_NOT_FOUND');
  const projection=repository.readPublishedSnapshot({libraryId});
  if(!projection)return{contract_version:'lightog-source-published-graph/0.1',status:'EMPTY',library_id:libraryId,publication_status:'NOT_PUBLISHED',published_graph_revision:null,graph_revision:null,index_status:'NONE',retrieval_available:false,builds:[],evidence_sets:[],source_texts:[],publication_performed:false};
  const builds=clone(projection.write_set.builds),sets=new Map();for(const build of builds)for(const es of build.evidence_sets)sets.set(hash(es),clone(es));
  return{contract_version:'lightog-source-published-graph/0.1',status:'READY',library_id:libraryId,publication_status:'PUBLISHED',published_graph_revision:projection.graph_revision,graph_revision:projection.graph_revision,index_status:'READY',retrieval_available:true,snapshot:clone(projection.snapshot),builds,evidence_sets:[...sets.values()],source_texts:clone(projection.context.source_texts),publication_receipt:clone(projection.publication_receipt),semantic_review_status:'INDEPENDENT_MODEL_SUPPORTED',publication_performed:true,...(projection.publication_policy?{publication_policy:projection.publication_policy,scope_availability:projection.scope_availability,whole_scope_complete:false,coverage_complete:false,document_scope_review:clone(projection.document_scope_review)}:{})};
 }
 function candidatePreview({libraryId}){
  assertLibraryActive(store,libraryId);
  const state=governance.baseFor(libraryId);need(state,'SOURCE_LIBRARY_NOT_FOUND');
  const rows=store.listRecords('source_candidate_incremental_ledger').filter(r=>r.library_id===libraryId&&r.ledger?.entries?.length);
  for(const row of rows.reverse()){
   const job=store.getRecord('source_learning_job',key(libraryId,row.task_ref))?.job;
   if(!job||job.snapshot.source_epoch!==state.source_epoch)continue;
   const original=store.getRecord('source_learning_worker_artifact',JSON.stringify([libraryId,row.task_ref,'EXTRACTION_CONTEXT']));
   const plan=store.getRecord('source_learning_worker_artifact',JSON.stringify([libraryId,row.task_ref,'EXTRACTION_BATCH_PLAN']));
   if(!original||!plan||plan.receipt_sha256!==row.ledger.plan_sha256)continue;
   try{
    core('incremental_graph_v1','validate',{ledger:row.ledger});
    const live=readRuntime({libraryId,job,graphRevision:job.snapshot.graph_revision,readPurpose:'INCREMENTAL_PREVIEW'});
    need(hash(live.runtime.current_snapshot)===hash(job.snapshot),'INCREMENTAL_PREVIEW_SOURCE_CHANGED');
    const context=clone(original);for(const entry of row.ledger.entries)if(entry.status==='ACCOUNTED'){const es=plan.batches[entry.batch_index]?.evidence_set;need(es,'INCREMENTAL_PREVIEW_BATCH_MISSING');context.examples[es.evidence_set_id]=es;}
    const projected=core('incremental_graph_v1','project',{ledger:row.ledger,trusted_context:context});
    const sets=new Map();for(const es of Object.values(context.examples??{}))if(es?.fragments)sets.set(es.evidence_set_id,es);
    return {contract_version:'lightog-source-candidate-preview/0.1',status:'CANDIDATE_PREVIEW',library_id:libraryId,graph_revision:row.ledger.ledger_sha256,index_status:'NOT_PUBLISHED',retrieval_available:false,snapshot:clone(job.snapshot),builds:[{task_ref:row.task_ref,graph:projected.build.graph}],evidence_sets:[...sets.values()],source_texts:clone(live.context.source_texts),progress:core('incremental_graph_v1','progress',{ledger:row.ledger}),semantic_support_certified:false,publication_performed:false};
   }catch(error){if(['SOURCE_LEARNING_SOURCE_STALE','INCREMENTAL_PREVIEW_SOURCE_CHANGED','SOURCE_SNAPSHOT_MISMATCH'].includes(error.code))return null;throw error;}
  }
  return null;
 }
 function queueStatus(libraryId,taskRef){return store.listRecords('source_product_queue').filter(q=>q.library_id===libraryId&&(!taskRef||q.task_ref===taskRef)).map(q=>{const job=repository.get({libraryId,taskRef:q.task_ref});return {...q,job:{task_ref:job.task_ref,stage:job.stage,revision:job.revision,snapshot:job.snapshot,attempts:job.attempts.map(a=>({attempt_id:a.attempt_id,phase:a.phase,request_sha256:a.request_sha256,outcome:a.outcome,request_id:a.request_id,response_sha256:a.response_sha256,...(a.outcome==='CACHED_KNOWN_RESPONSE'?{cache_origin:{task_ref:a.cache_binding?.replay?.provenance?.origin?.task_ref??null,phase:a.cache_binding?.replay?.provenance?.origin?.phase??null,request_id:a.cache_binding?.replay?.provenance?.origin?.request_id??null,receipt_sha256:a.cache_binding?.replay?.receipt_sha256??null}}:{})})),index_ack:job.index_ack}};});}
 async function drain(){
  if(closed||draining)return draining;
  draining=(async()=>{
   for(const row of store.listRecords('source_product_queue').filter(q=>['QUEUED','RUNNING','WAIT_MODEL_CONFIGURATION'].includes(q.status))){
    if(closed)break;
    const expected=store.getRecord('source_learning_worker_scope',key(row.library_id,row.task_ref))?.scope?.modelBindings,current=models();
    const ready=expected&&['generation','embedding','reranker'].every(role=>{const a=expected[role],b=current[role];return a?b&&a.model===b.model&&a.config_revision===b.config_revision&&(role!=='embedding'||a.dimensions===b.dimensions&&(a.model_revision??null)===(b.model_revision??null)):!b;});
    if(expected&&!ready){store.putRecord('source_product_queue',row.id,{...row,status:'WAIT_MODEL_CONFIGURATION'});continue;}
    onOperation(1);store.putRecord('source_product_queue',row.id,{...row,status:'RUNNING'});
    try{const result=await worker.run({libraryId:row.library_id,taskRef:row.task_ref,budgetId:row.budget_id,rebuildSourceScope:row.rebuild_source_scope??false,allowNewProvider:row.recovery_mode!=='INDEX_RETURNED_ONLY'});store.putRecord('source_product_queue',row.id,{...row,status:result.job?.attempts?.some(a=>['STARTED','UNKNOWN'].includes(a.outcome))?'UNKNOWN_NO_RETRY':result.job?.stage==='COMPLETED'?'COMPLETED':['SCAN_COMPLETED_WITH_ISSUES','CORRECTION_MATERIALIZED_NO_GRAPH'].includes(result.status)?'COMPLETED_WITH_ISSUES':'SETTLED',result_status:result.status??result.job?.stage??null,error_code:result.error_code??null,finished_at:new Date().toISOString()});}
    catch(error){store.putRecord('source_product_queue',row.id,{...row,status:'BLOCKED',error_code:error.code??'SOURCE_LEARNING_FAILED',finished_at:new Date().toISOString()});}
    finally{onOperation(-1);}
   }
   for(const row of store.listRecords('source_candidate_recovery_queue').filter(r=>r.status==='QUEUED')){
    if(closed)break;onOperation(1);store.putRecord('source_candidate_recovery_queue',row.id,{...row,status:'RUNNING'});
    try{const result=await recoverCandidates({libraryId:row.library_id,taskRef:row.task_ref});store.putRecord('source_candidate_recovery_queue',row.id,{...row,status:result.status==='FORMAL_GRAPH_PUBLISHED'?'COMPLETED':'WAIT_REVIEW',result_status:result.status});}
    catch(error){store.putRecord('source_candidate_recovery_queue',row.id,{...row,status:'BLOCKED',error_code:error.code??'RECOVERY_FAILED'});}finally{onOperation(-1);}
   }
  })();try{await draining;}finally{draining=null;}
 }
 const recoverCandidates=createCandidateRecovery({store,core,models,repository});
 const timer=pollMs>0?setInterval(()=>{void drain();},pollMs):null;timer?.unref?.();
 return Object.freeze({
  validateReplayMapping({libraryId,taskRef,originJob}){const saved=store.getRecord('source_learning_worker_artifact',JSON.stringify([libraryId,taskRef,'REPLAY_ORIGIN'])),expected=originJob.attempts.filter(a=>a.phase.startsWith('EXTRACTION_')&&a.outcome==='RETURNED');need(saved&&hash(saved.origin_job)===hash(originJob)&&saved.batches?.length===expected.length&&new Set(saved.batches.map(b=>b.origin_phase)).size===expected.length&&expected.every(a=>saved.batches.some(b=>b.origin_phase===a.phase&&b.original_request_archive&&b.original_response_archive&&b.original_prepared&&b.original_context)),'SOURCE_REPLAY_PREFIX_MAPPING_MISSING');return true;},
  enqueueReplay({libraryId,originTaskRef}){
   assertLibraryActive(store,libraryId);const originJob=repository.get({libraryId,taskRef:originTaskRef}),current=product.prepare({libraryId,question:originJob.request.raw_question});need(hash({base_ref:originJob.snapshot.base_ref,source_epoch:originJob.snapshot.source_epoch,sources:originJob.snapshot.sources})===hash({base_ref:current.snapshot.base_ref,source_epoch:current.snapshot.source_epoch,sources:current.snapshot.sources}),'SOURCE_REPLAY_SOURCE_CHANGED');
   const applicationId=key(libraryId,originTaskRef),previous=store.getRecord('source_proposal_replay_application',applicationId);if(previous){need(previous.origin_job_sha256===originJob.job_sha256,'SOURCE_REPLAY_ORIGIN_CHANGED');this.validateReplayMapping({libraryId,taskRef:previous.task_ref,originJob});return{...previous,deduplicated:true};}
   const existing=store.listRecords('source_learning_job').map(r=>r.job).filter(j=>j?.snapshot?.base_ref===libraryId&&j.snapshot.source_epoch===current.snapshot.source_epoch&&j.request.policy_version==='source-learning-product-candidate-mvp-batched-replay-local-v1'&&j.request.request_ref==='replay:'+originTaskRef);need(existing.length<=1,'SOURCE_REPLAY_JOB_AMBIGUOUS');if(existing.length){this.validateReplayMapping({libraryId,taskRef:existing[0].task_ref,originJob});const q=store.getRecord('source_product_queue',key(libraryId,existing[0].task_ref)),recovered={id:applicationId,library_id:libraryId,origin_task_ref:originTaskRef,origin_job_sha256:originJob.job_sha256,task_ref:existing[0].task_ref,queue_status:q?.status??'EXISTING_JOB_QUEUE_UNAVAILABLE',recovered_existing_job:true,new_provider_calls:0};store.putRecord('source_proposal_replay_application',applicationId,recovered);return recovered;}
   need(!['QUEUED','RUNNING'].includes(store.getRecord('source_product_queue',key(libraryId,originTaskRef))?.status),'SOURCE_REPLAY_ORIGIN_STILL_RUNNING');
   need(['WAIT_REVIEW','WAIT_EVIDENCE','DEFERRED','FAILED','STOPPED','SUPERSEDED','COMPLETED'].includes(originJob.stage)&&originJob.attempts.every(a=>a.outcome==='RETURNED'),'SOURCE_REPLAY_ORIGIN_NOT_QUIESCENT');
   need(!queueStatus(libraryId).some(q=>q.task_ref!==originTaskRef&&(['QUEUED','RUNNING','WAIT_MODEL_CONFIGURATION','UNKNOWN_NO_RETRY'].includes(q.status)||['COMMITTING','INDEX_PENDING'].includes(q.job.stage))),'SOURCE_REPLAY_WRITER_BUSY');
   const get=name=>store.getRecord('source_learning_worker_artifact',JSON.stringify([libraryId,originTaskRef,name])),plan=get('EXTRACTION_BATCH_PLAN'),context=get('EXTRACTION_CONTEXT');need(plan&&context,'SOURCE_REPLAY_ORIGIN_PLAN_MISSING');const attempts=originJob.attempts.filter(a=>a.phase.startsWith('EXTRACTION_')).sort((a,b)=>a.phase.localeCompare(b.phase));need(attempts.length>0&&attempts.every((a,i)=>a.phase==='EXTRACTION_'+String(i).padStart(3,'0')),'SOURCE_REPLAY_NONCONTIGUOUS_PREFIX');const batches=attempts.map(a=>{const suffix=a.phase.slice('EXTRACTION_'.length),ctx=clone(context),es=plan.batches[Number(suffix)].evidence_set;ctx.examples[es.evidence_set_id]=es;const request=get('REQUEST_'+a.phase),response=get('RESPONSE_'+a.phase),prepared=get('BATCH_PREPARED_'+suffix);need(request&&response&&prepared&&hash(response.response)===a.response_sha256&&hash(request.request)===a.request_sha256,'SOURCE_REPLAY_ORIGINAL_ARCHIVE_CHANGED');return{origin_phase:a.phase,original_request_archive:request,original_response_archive:response,original_prepared:prepared,original_context:ctx};});
   const question=originJob.request.raw_question,requestId='replay:'+originTaskRef,proposalPolicyVersion='source-learning-product-candidate-mvp-batched-replay-local-v1',p=worker.prepare({libraryId,question,requestId,proposalPolicyVersion});need(hash(p.request.cq_seeds)===hash(originJob.request.cq_seeds),'SOURCE_REPLAY_CQ_CHANGED');const execution=budgets.autoAuthorize({prepared:p,executionKey:requestId});
   return store.transaction(()=>{const grant={request_ref:requestId,question_sha256:textSha(question),base_ref:libraryId,source_epoch:p.snapshot.source_epoch,access_mode:'LEARN',learning_requested:true};store.putRecord('source_learning_grant',key(libraryId,requestId),{library_id:libraryId,grant,budget_id:execution.id,revoked:false});const made=worker.enqueue({libraryId,question,requestId,budgetId:execution.id,proposalPolicyVersion}),job=made.job;worker.saveReplayOrigin({libraryId,taskRef:job.task_ref,origin:{origin_job:originJob,batches}});const id=key(libraryId,job.task_ref);if(!store.getRecord('source_product_queue',id))store.putRecord('source_product_queue',id,{id,library_id:libraryId,task_ref:job.task_ref,budget_id:execution.id,rebuild_source_scope:false,status:'QUEUED',created_at:new Date().toISOString(),cached_origin_task_ref:originTaskRef});const result={id:applicationId,library_id:libraryId,origin_task_ref:originTaskRef,origin_job_sha256:originJob.job_sha256,task_ref:job.task_ref,queue_status:store.getRecord('source_product_queue',id).status,cached_prefix_batches:batches.length,new_suffix_batches:plan.batches.length-batches.length,new_provider_calls:0};store.putRecord('source_proposal_replay_application',applicationId,result);return result;});
  },
  async recoverCandidates({libraryId,taskRef}){assertLibraryActive(store,libraryId);return recoverCandidates({libraryId,taskRef});},
  recoverKnownPaused({libraryId}={}){
   const items=[];if(!models().generation||!models().embedding)return{items,model_calls:0};
   for(const row of store.listRecords('source_product_queue')){
    if(libraryId&&row.library_id!==libraryId)continue;
    if(row.status==='SETTLED'&&row.error_code==='SOURCE_LEARNING_BASE_GRAPH_MISSING'){
     const id=key(row.library_id,row.task_ref),marker=store.getRecord('source_first_graph_recovery',id);
     if(marker)continue;
     const job=store.getRecord('source_learning_job',id)?.job,state=governance.baseFor(row.library_id);
     const artifact=name=>store.getRecord('source_learning_worker_artifact',JSON.stringify([row.library_id,row.task_ref,name]));
     if(!job||job.stage!=='WAIT_REVIEW'||job.snapshot.source_epoch!==state?.source_epoch||job.attempts.some(a=>!['RETURNED','CACHED_KNOWN_RESPONSE'].includes(a.outcome))||!artifact('GATE_INPUT')||artifact('EXTRACTION_BATCH_PROGRESS')?.complete!==true||row.rebuild_source_scope!==true)continue;
     if(repository.head({libraryId:row.library_id})?.committed_graph_revision)continue;
     if(store.listRecords('source_product_queue').some(q=>q.library_id===row.library_id&&q.task_ref!==row.task_ref&&['QUEUED','RUNNING','WAIT_MODEL_CONFIGURATION','UNKNOWN_NO_RETRY'].includes(q.status)))continue;
     try{
      assertLibraryActive(store,row.library_id);repository.get({libraryId:row.library_id,taskRef:row.task_ref});
      store.transaction(()=>{
       const live=store.getRecord('source_product_queue',row.id),current=store.getRecord('source_learning_job',id)?.job;
       need(live?.status==='SETTLED'&&live.error_code===row.error_code&&current?.job_sha256===job.job_sha256&&!store.getRecord('source_first_graph_recovery',id),'SOURCE_FIRST_GRAPH_RECOVERY_CHANGED');
       store.putRecord('source_first_graph_recovery',id,{id,library_id:row.library_id,task_ref:row.task_ref,previous_queue:clone(live),job_sha256:job.job_sha256,mode:'REUSE_GENERATION_COMMIT_AND_INDEX',created_at:new Date().toISOString()});
       store.putRecord('source_product_queue',row.id,{...live,status:'QUEUED',recovery_mode:'REUSE_GENERATION_COMMIT_AND_INDEX'});
      });items.push({task_ref:row.task_ref,status:'QUEUED',mode:'REUSE_GENERATION_COMMIT_AND_INDEX',new_generation_calls:0});
     }catch(error){items.push({task_ref:row.task_ref,status:'NOT_ENQUEUED',error_code:error.code??'SOURCE_FIRST_GRAPH_RECOVERY_FAILED'});}
     continue;
    }
    if(row.status==='SETTLED'&&(row.error_code==='SOURCE_CORE_REQUEST_BINDING'||row.error_code==='SOURCE_LEARNING_RESOURCE_LIMIT'&&row.recovery_mode==='INDEX_RETURNED_ONLY')){
     const recoveryId=key(row.library_id,row.task_ref),secondRecovery=row.error_code==='SOURCE_LEARNING_RESOURCE_LIMIT',markerId=secondRecovery?JSON.stringify([row.library_id,row.task_ref,'SOURCE_LEARNING_RESOURCE_LIMIT']):recoveryId;
     if(store.getRecord('source_index_returned_recovery',markerId))continue;
     if(secondRecovery&&!store.getRecord('source_index_returned_recovery',recoveryId))continue;
     const archived=store.getRecord('source_learning_job',recoveryId)?.job,state=governance.baseFor(row.library_id);
     if(!archived||archived.stage!=='INDEX_PENDING'||archived.snapshot.source_epoch!==state?.source_epoch||archived.attempts.some(a=>!['RETURNED','CACHED_KNOWN_RESPONSE'].includes(a.outcome)))continue;
     try{
      assertLibraryActive(store,row.library_id);const current=baseService.prepare({libraryId:row.library_id,question:archived.request.raw_question}),sourceScope=s=>({base_ref:s.base_ref,source_epoch:s.source_epoch,sources:s.sources});
      need(hash(sourceScope(current.snapshot))===hash(sourceScope(archived.snapshot)),'SOURCE_INDEX_RECOVERY_SOURCE_CHANGED');
      const job=repository.get({libraryId:row.library_id,taskRef:row.task_ref}),head=repository.head({libraryId:row.library_id});
      need(job.job_sha256===archived.job_sha256&&head?.committed_graph_revision===job.commit_receipt?.output_graph_revision&&head.index_state==='PENDING','SOURCE_INDEX_RECOVERY_COMMIT_CHANGED');
      need(!store.listRecords('source_product_queue').some(q=>{if(q.library_id!==row.library_id||q.task_ref===row.task_ref)return false;const other=store.getRecord('source_learning_job',key(q.library_id,q.task_ref))?.job;return other?.snapshot?.source_epoch===job.snapshot.source_epoch&&(['QUEUED','RUNNING','WAIT_MODEL_CONFIGURATION','UNKNOWN_NO_RETRY'].includes(q.status)||['COMMITTING','INDEX_PENDING'].includes(other.stage));}),'SOURCE_INDEX_RECOVERY_WRITER_BUSY');
      store.transaction(()=>{
       const live=store.getRecord('source_product_queue',row.id),liveJob=store.getRecord('source_learning_job',recoveryId)?.job;
       need(live?.status==='SETTLED'&&live.error_code===row.error_code&&(!secondRecovery||live.recovery_mode==='INDEX_RETURNED_ONLY')&&liveJob?.job_sha256===job.job_sha256,'SOURCE_INDEX_RECOVERY_STATE_CHANGED');
       need(!store.getRecord('source_index_returned_recovery',markerId),'SOURCE_INDEX_RECOVERY_ALREADY_RECORDED');
       const marker={id:markerId,recovery_error_code:row.error_code,previous_recovery_marker_id:live.recovery_marker_id??null,library_id:row.library_id,task_ref:row.task_ref,job_sha256:job.job_sha256,source_snapshot:job.snapshot,committed_graph_revision:head.committed_graph_revision,budget_id:row.budget_id,previous_queue:clone(live),created_at:new Date().toISOString(),mode:'INDEX_RETURNED_ONLY',new_provider_calls_allowed:false};
       store.putRecord('source_index_returned_recovery',markerId,marker);store.putRecord('source_product_queue',row.id,{...live,status:'QUEUED',recovery_mode:'INDEX_RETURNED_ONLY',recovery_marker_id:markerId});
      });items.push({task_ref:row.task_ref,status:'QUEUED',mode:'INDEX_RETURNED_ONLY',new_provider_calls:0});
     }catch(error){items.push({task_ref:row.task_ref,status:'NOT_ENQUEUED',error_code:error.code??'SOURCE_INDEX_RECOVERY_PREPARE_FAILED',model_calls:0});}
     continue;
    }
    if(store.getRecord('source_proposal_replay_application',key(row.library_id,row.task_ref)))continue;
    if(row.error_code!=='REQUIRED_OCCURRENCE_REGISTRY_INVALID'||!['SETTLED','BLOCKED'].includes(row.status))continue;
    const origin=store.getRecord('source_learning_job',key(row.library_id,row.task_ref))?.job,state=governance.baseFor(row.library_id);
    if(!origin||origin.request.policy_version!=='source-learning-product-candidate-mvp-batched-v1'||origin.snapshot.source_epoch!==state?.source_epoch||origin.attempts.some(a=>a.outcome!=='RETURNED'))continue;
    try{items.push(this.enqueueReplay({libraryId:row.library_id,originTaskRef:row.task_ref}));}catch(error){items.push({origin_task_ref:row.task_ref,status:'NOT_ENQUEUED',error_code:error.code??'SOURCE_REPLAY_PREPARE_FAILED',model_calls:0});}
   }return{items,model_calls:0};
  },
  applyReviewCorrection({libraryId,item,decision}){
   assertLibraryActive(store,libraryId);const applicationId=key(libraryId,decision.decision_id),prior=store.getRecord('source_correction_application',applicationId);if(prior)return clone(prior);
   const current=candidateProduct.prepare({libraryId,question:'Validate source correction'});core('source_human_review_v1','validate_decision',{contract_version:'lightog-source-human-review/0.1',item,decision,current_snapshot:current.snapshot,source_texts:current.context.source_texts});
   const existing=store.listRecords('source_learning_job').map(r=>r.job).filter(j=>j?.snapshot?.base_ref===libraryId&&j.request.policy_version==='source-learning-product-candidate-correction-v1'&&j.request.request_ref===decision.decision_id&&j.snapshot.source_epoch===current.snapshot.source_epoch);need(existing.length<=1,'SOURCE_CORRECTION_JOB_AMBIGUOUS');if(existing.length){const q=store.getRecord('source_product_queue',key(libraryId,existing[0].task_ref)),recovered={id:applicationId,library_id:libraryId,decision_id:decision.decision_id,task_ref:existing[0].task_ref,queue_status:q?.status??'EXISTING_JOB_QUEUE_UNAVAILABLE',is_correction:true,recovered_existing_job:true,semantic_support_certified:false};store.putRecord('source_correction_application',applicationId,recovered);return recovered;}
   if(queueStatus(libraryId).some(q=>['QUEUED','RUNNING','WAIT_MODEL_CONFIGURATION','UNKNOWN_NO_RETRY'].includes(q.status)||['COMMITTING','INDEX_PENDING'].includes(q.job.stage))){const error=fail('SOURCE_CORRECTION_WRITER_BUSY');error.details={application_outcome:'NOT_ENQUEUED',retryable:true};throw error;}
   const originJob=repository.get({libraryId,taskRef:item.origin.task_ref}),phase=item.origin.batch_phase,suffix=phase==='EXTRACTION'?null:phase.slice('EXTRACTION_'.length),artifact=name=>store.getRecord('source_learning_worker_artifact',JSON.stringify([libraryId,originJob.task_ref,name]));
   const originalMaterialized=artifact(suffix===null?'MATERIALIZED':'MATERIALIZED_'+suffix),originalPrepared=artifact(suffix===null?'EXTRACTION_PREPARED':'BATCH_PREPARED_'+suffix),originalContext=artifact('EXTRACTION_CONTEXT'),originalResponse=artifact('RESPONSE_'+phase);need(originalMaterialized&&originalPrepared&&originalContext&&originalResponse,'SOURCE_CORRECTION_ORIGIN_ARTIFACT_MISSING');
   const latest=new Map();for(const row of store.listRecords('product_review_decision').filter(r=>r.library_id===libraryId&&r.item?.origin?.task_ref===item.origin.task_ref&&r.item.origin.batch_phase===phase&&r.decision?.action!=='DEFER').sort((a,b)=>(a.created_at??'').localeCompare(b.created_at??'')))latest.set(row.item.origin.registry_index,{item:row.item,decision:row.decision});latest.set(item.origin.registry_index,{item,decision});
   const correction={decisions:[...latest.values()],origin_job:originJob,original_response:originalResponse,original_prepared:originalPrepared,original_context:originalContext,original_materialized:originalMaterialized,original_unit_id:originalMaterialized.unit_id};
   const question=originJob.request.raw_question,requestId=decision.decision_id,proposalPolicyVersion='source-learning-product-candidate-correction-v1',preparedCorrection=worker.prepare({libraryId,question,requestId,proposalPolicyVersion}),execution=budgets.autoAuthorize({prepared:preparedCorrection,executionKey:'correction:'+decision.decision_id});
   return store.transaction(()=>{const request=preparedCorrection.request,grant={request_ref:request.request_ref,question_sha256:textSha(question),base_ref:libraryId,source_epoch:preparedCorrection.snapshot.source_epoch,access_mode:'LEARN',learning_requested:true};store.putRecord('source_learning_grant',key(libraryId,request.request_ref),{library_id:libraryId,grant,budget_id:execution.id,revoked:false});const created=worker.enqueue({libraryId,question,requestId,budgetId:execution.id,proposalPolicyVersion}),job=created.job;worker.saveCorrectionInput({libraryId,taskRef:job.task_ref,correction});const id=key(libraryId,job.task_ref);store.putRecord('source_product_queue',id,{id,library_id:libraryId,task_ref:job.task_ref,budget_id:execution.id,rebuild_source_scope:false,status:'QUEUED',created_at:new Date().toISOString(),is_correction:true});const result={id:applicationId,library_id:libraryId,decision_id:decision.decision_id,task_ref:job.task_ref,queue_status:'QUEUED',is_correction:true,semantic_support_certified:false};store.putRecord('source_correction_application',applicationId,result);return result;});
  },
  processingProgress:args=>{assertLibraryActive(store,args.libraryId);const progress=processing.processingProgress(args);return{...progress,items:progress.items.map(item=>{
   if(item.stage!=='COMPLETED'||!store.getRecord('source_candidate_incremental_ledger',key(args.libraryId,item.task_ref)))return item;
   return{...item,publication_assessment:repository.assessCandidatePublication({libraryId:args.libraryId,taskRef:item.task_ref})};
  })};},readReviewItems:args=>{assertLibraryActive(store,args.libraryId);return processing.readReviewItems(args);},
  prepare:args=>product.prepare(args),graph:graphSnapshot,publishedGraph:publishedGraphSnapshot,candidatePreview,repository,worker,budgets,
  deferCandidateForSourceAudit(args){need(partialScopePublicationDefault&&documentScope,'SOURCE_PARTIAL_SCOPE_DISABLED');assertLibraryActive(store,args.libraryId);return repository.deferCandidateForSourceAudit(args);},
  deferDocumentScopeTaskForSourceAudit(args){
   need(partialScopePublicationDefault&&documentScope,'SOURCE_PARTIAL_SCOPE_DISABLED');assertLibraryActive(store,args.libraryId);
   const job=repository.get(args);need(job.stage==='COMPLETED'&&job.attempts.every(a=>a.outcome==='RETURNED'),'SOURCE_PARTIAL_SCOPE_KNOWN_COMPLETED_JOB_REQUIRED');
   need(!queueStatus(args.libraryId).some(r=>['QUEUED','RUNNING','UNKNOWN_NO_RETRY'].includes(r.status)),'SOURCE_PARTIAL_SCOPE_WRITER_BUSY');
   return repository.deferDocumentScopeTaskForSourceAudit(args);
  },
  async reassessVerifiedDocumentScope({libraryId,taskRef,expectedPublishedGraphRevision=null,reviewProtocol=null,requestReason=null,requestId=null,expectedGenerationModel=null}){
   need(partialScopePublicationDefault&&documentScope,'SOURCE_PARTIAL_SCOPE_DISABLED');assertLibraryActive(store,libraryId);
   const job=repository.get({libraryId,taskRef});need(job.stage==='COMPLETED'&&job.attempts.every(a=>a.outcome==='RETURNED'),'SOURCE_PARTIAL_SCOPE_KNOWN_COMPLETED_JOB_REQUIRED');
   need(!queueStatus(libraryId).some(r=>['QUEUED','RUNNING','UNKNOWN_NO_RETRY'].includes(r.status)),'SOURCE_PARTIAL_SCOPE_WRITER_BUSY');
   const assessment=repository.assessPartialCandidatePublication({libraryId,taskRef});
   if(!assessment.ready_for_scope_review)return{status:'PARTIAL_SCOPE_FACT_REVIEW_PENDING',graph_published:false,assessment,model_calls_added:0,whole_scope_complete:false};
   // This observes immutable, known extraction/review returns. In particular it
   // never invokes worker.run, changes its prompt policy, or re-extracts facts.
   const coverage=await documentScope.assessCoverage({libraryId,taskRef,readInput:()=>readCoverageInput({libraryId,taskRef}),reviewProtocol,requestReason,requestId,expectedGenerationModel});
   if(!coverage.partial_ready)return{status:'PARTIAL_SCOPE_NO_READY_TASKS',graph_published:false,coverage,whole_scope_complete:false,coverage_complete:false};
   const publication=repository.publishPartialReviewedCandidate({libraryId,taskRef,expectedPublishedGraphRevision});
   return{status:publication.scope_availability==='PARTIAL'?'PARTIALLY_READY':'READY',graph_published:true,publication,coverage,index_mode:'LEXICAL',extraction_calls_added:0,fact_review_calls_added:0,embedding_calls_added:0,whole_scope_complete:false,coverage_complete:false};
  },
  decideCandidateMeaning({libraryId,item,action,reason,requestId}){
   need(item?.kind==='SEMANTIC_CANDIDATE'&&item.origin?.task_ref&&Number.isSafeInteger(item.origin.batch_index)&&item.origin.candidate_id,'SOURCE_HUMAN_SEMANTIC_ITEM_INVALID');
   const recorded=repository.recordHumanCandidateDecision({libraryId,taskRef:item.origin.task_ref,batchIndex:item.origin.batch_index,candidateId:item.origin.candidate_id,action,reason,requestId,recoveryId:item.origin.recovery_id??null});
   const assessment=repository.assessCandidatePublication({libraryId,taskRef:item.origin.task_ref});
   if(item.origin.recovery_id&&action!=='DEFER'&&!assessment.ready_for_index){const id=key(libraryId,item.origin.task_ref);store.putRecord('source_candidate_recovery_queue',id,{id,library_id:libraryId,task_ref:item.origin.task_ref,status:'QUEUED',trigger_decision_id:recorded.decision.decision.decision_id});}
   let publication=null,scopeHold=partialScopePublicationDefault?'DOCUMENT_SCOPE_PARTIAL_REASSESSMENT_REQUIRED':null;if(assessment.ready_for_index&&!partialScopePublicationDefault){const prior=store.getRecord('source_graph_publication_head',libraryId)?.published_graph_revision??null;try{publication=repository.publishReviewedCandidate({libraryId,taskRef:item.origin.task_ref,expectedPublishedGraphRevision:prior});}catch(error){if(!error.code?.startsWith('DOCUMENT_SCOPE_')&&!error.code?.startsWith('SCOPE_COVERAGE_'))throw error;scopeHold=error.code;}}
   return{decision:recorded.decision,idempotent:recorded.idempotent,assessment,publication_status:publication?'PUBLISHED':scopeHold??assessment.status};
  },
  modelStatus:()=>controller?controller.status():{managed_externally:true},
  documentFirstEnabled:documentFirstDefault,
  adoptKnownDocumentNormalization:args=>{need(documentScope,'DOCUMENT_SCOPE_NOT_CONNECTED');return documentScope.adoptKnownNormalization(args);},
  routeDocumentQuestion:documentScope?args=>documentScope.routeQuestion({...args,readInput:()=>{
   const p=product.prepare(args),publication=store.getRecord('source_graph_publication',key(args.libraryId,p.snapshot.graph_revision));
   const review=publication?.document_scope_review?store.getRecord('document_scope_coverage',publication.document_scope_review.coverage_record_id??key(args.libraryId,publication.task_ref)):null;
   need(!review||review.receipt?.receipt_hash===publication.document_scope_review.receipt_hash,'DOCUMENT_SCOPE_REVIEW_BINDING_CHANGED');
   return{snapshot:p.snapshot,coverageReceipt:review?.receipt??null,...(partialScopePublicationDefault&&review?{scopeTaskRestriction:repository.assessDocumentScopeTaskRestriction({libraryId:args.libraryId,taskRef:review.task_ref})}:{})};
  }}):null,
  documentScopeStatus:({libraryId})=>{
   const view=documentScope?.view(libraryId)??null;if(!view||!partialScopePublicationDefault)return view;
   const scope=store.listRecords('source_learning_worker_scope').find(r=>r.scope?.libraryId===libraryId&&r.scope.document_scope?.plan_id===view.plan_id&&r.scope.document_scope?.source_epoch===view.source_epoch);
   if(!scope)return{...view,technical_candidate_count:null,pending_review_candidate_count:null};
   try{const a=repository.assessPartialCandidatePublication({libraryId,taskRef:scope.scope.taskRef});return{...view,technical_candidate_count:a.coverage?.quarantined_proposals??null,pending_review_candidate_count:a.coverage?.held_candidates??null};}
   catch(error){return{...view,technical_candidate_count:null,pending_review_candidate_count:null,errors:[...view.errors,{code:error.code??'SOURCE_PARTIAL_SCOPE_ASSESSMENT_UNAVAILABLE'}]};}
  },
  discoverDocumentScope:args=>{need(documentScope,'DOCUMENT_SCOPE_DISABLED');return documentScope.discover(args);},
  documentScopeQuestion:plan=>{need(documentScope,'DOCUMENT_SCOPE_DISABLED');return documentScope.buildQuestion(plan);},
  configureModel(role,config){need(controller,'SOURCE_MODELS_MANAGED_EXTERNALLY');return controller.configure(role,config);},
  configureModels(configs){need(controller,'SOURCE_MODELS_MANAGED_EXTERNALLY');return controller.configureMany(configs);},
  nativeEmbeddingRuntime(){need(controller,'SOURCE_MODELS_MANAGED_EXTERNALLY');return controller.nativeEmbeddingRuntime();},
  nativeModelRuntime(){need(controller,'SOURCE_MODELS_MANAGED_EXTERNALLY');return controller.nativeModelRuntime();},
  autoAuthorize(args){need(automaticExecution,'SOURCE_AUTOMATIC_EXECUTION_DISABLED');return budgets.autoAuthorize({prepared:prepared(args),executionKey:args.executionKey??args.requestId});},
  learningAdmission({response,question}){const operation=store.getRecord('source_first_operation',response?.operation_id);need(operation?.status==='COMPLETED'&&hash(operation.response)===hash(response),'SOURCE_LEARNING_ADMISSION_RESPONSE_NOT_PERSISTED');const q=question??response.answer?.question,p=typeof q==='string'?product.prepare({libraryId:response.library_id,question:q}):null;return core('source_execution_v1','learning_admission',{contract_version:'lightog-source-execution/0.1',response,current_snapshot:p?.snapshot??null});},
  readRuntime,
  preview(args){return budgets.preview(prepared(args));},
  confirm(args){return budgets.confirm({...args,prepared:prepared(args)});},
  authorizeAsk(args){return budgets.authorize({budgetId:args.budgetId,prepared:prepared({...args,operation:'ASK'})});},
  ask:args=>product.answer(args),
  enqueue({libraryId,question,requestId,budgetId,rebuildSourceScope=false,proposalPolicyVersion,documentScopePlanId}){
   if(documentScopePlanId!==undefined)need(documentScope?.forQuestion({libraryId,question,planId:documentScopePlanId}),'DOCUMENT_SCOPE_PLAN_REQUIRED');
   const p=worker.prepare({libraryId,question,requestId,rebuildSourceScope,proposalPolicyVersion});budgets.authorize({budgetId,prepared:p});
   return store.transaction(()=>{
    const request=p.request;need(request&&request.request_ref&&request.raw_question===question,'SOURCE_WORKER_REQUEST_REQUIRED');
    const grant={request_ref:request.request_ref,question_sha256:textSha(question),base_ref:libraryId,source_epoch:p.snapshot.source_epoch,access_mode:'LEARN',learning_requested:true};
    const grantId=key(libraryId,request.request_ref),old=store.getRecord('source_learning_grant',grantId);need(!old||hash(old.grant)===hash(grant),'SOURCE_LEARNING_REQUEST_REUSED');
    store.putRecord('source_learning_grant',grantId,{library_id:libraryId,grant,budget_id:budgetId,revoked:false});
    const result=worker.enqueue({libraryId,question,requestId,budgetId,rebuildSourceScope,proposalPolicyVersion}),job=result.job??result;
    need(job.task_ref,'SOURCE_WORKER_JOB_REQUIRED');const id=key(libraryId,job.task_ref),prior=store.getRecord('source_product_queue',id);
    if(!prior)store.putRecord('source_product_queue',id,{id,library_id:libraryId,task_ref:job.task_ref,budget_id:budgetId,rebuild_source_scope:rebuildSourceScope,status:'QUEUED',created_at:new Date().toISOString()});
    else if(!['RUNNING','QUEUED','UNKNOWN_NO_RETRY','COMPLETED'].includes(prior.status)&&budgetId!==prior.budget_id&&['QUEUED','RETRIEVING','EXTRACTING','VALIDATING','INDEX_PENDING'].includes(job.stage)&&!job.attempts.some(a=>['STARTED','UNKNOWN'].includes(a.outcome)))store.putRecord('source_product_queue',id,{...prior,budget_id:budgetId,status:'QUEUED',resumed_at:new Date().toISOString(),previous_budget_id:prior.budget_id,error_code:null});
    return {...result,queue_status:store.getRecord('source_product_queue',id).status};
   });
  },
  importLibrary({input,requestId}){
   need(input&&Array.isArray(input.sources),'SOURCE_IMPORT_INPUT_INVALID');
   input={...input,sources:input.sources.map(source=>{const documentId=source.document_id??source.parsing?.document_id;if(documentId!==undefined){const hydrated=hydrateSource({title:source.title,content:source.content,document_id:documentId},{getDocument:resolveDocument});return {...source,...hydrated,sha256:textSha(hydrated.content)};}need(!source.parsing,'SOURCE_CLIENT_PARSING_FORBIDDEN');return source;})};
   const id='import_'+requestId,prior=store.getRecord('source_product_import',id),digest=hash(input);if(prior){need(prior.input_sha256===digest,'SOURCE_IMPORT_REQUEST_REUSED');return {...prior,deduplicated:true};}
   return store.transaction(()=>{const job={id:randomUUID(),input,status:'DRAFT',stage:'DRAFT',events:[],internal_scope:true,created_at:new Date().toISOString()};saveDraft(job);const candidate=governance.begin(job);
    const row={library_id:candidate.base_id,task_id:job.id,input_sha256:digest,status:'SOURCE_IMPORTED_GRAPH_NOT_BUILT',model_calls:0};store.putRecord('source_product_import',id,row);return row;});
  },
  updateSource({libraryId,source,replaceSourceKey=null}){
   assertLibraryActive(store,libraryId);const state=governance.baseFor(libraryId);need(state,'SOURCE_LIBRARY_NOT_FOUND');
   source=hydrateSource(source,{getDocument:resolveDocument});
   need(typeof source.title==='string'&&source.title.trim()&&source.title.length<=180,'SOURCE_UPDATE_ARGUMENTS_INVALID');
   const normalized={title:source.title.trim(),content:source.content,source_role:'UPLOADED_ORIGIN_UNCONFIRMED',sha256:textSha(source.content),...(source.parsing?{parsing:source.parsing}:{})};
   normalized.id='source_'+hash(sourceKey(normalized)).slice(0,24);const newKey=sourceKey(normalized);
   need(replaceSourceKey===null||typeof replaceSourceKey==='string'&&/^src_[a-f0-9]{32}$/.test(replaceSourceKey),'SOURCE_REPLACEMENT_KEY_INVALID');
   const active=Object.values(state.sources).filter(s=>s.active).length;need(automaticExecution||replaceSourceKey!==null||state.sources[newKey]?.active||active<8,'SOURCE_DIRECTORY_LIMIT');
   const result=replaceSourceKey?governance.replaceSource(libraryId,replaceSourceKey,normalized):governance.addSource(libraryId,normalized);
   const unchanged=result.added===false||result.changed===false;return {library_id:libraryId,status:unchanged?'UNCHANGED':'SOURCE_UPDATED_REBUILD_REQUIRED',source_epoch:result.state.source_epoch,source_key:newKey,source_ref:unchanged?null:normalized.id,model_calls:0};
  },
  status({libraryId,taskRef}){assertLibraryActive(store,libraryId);const state=governance.baseFor(libraryId);need(state,'SOURCE_LIBRARY_NOT_FOUND');const items=queueStatus(libraryId,taskRef);if(taskRef)need(items.length===1,'SOURCE_LEARNING_JOB_NOT_FOUND');const head=store.getRecord('source_graph_head',libraryId),active=head?.active_graph_revision?store.getRecord('source_graph_version',key(libraryId,head.active_graph_revision)):null;return {library_id:libraryId,head:head?{...head,active_usable:Boolean(active&&active.write_set.source_scope.source_epoch===state.source_epoch)}:null,items};},
  drain,
  isBusy:()=>draining!==null,
  async whenIdle(){while(draining)await draining;},
  close(){closed=true;if(timer)clearInterval(timer);}
 });
}
