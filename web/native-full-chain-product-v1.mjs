import {readNativeCQMaterials} from './native-chunked-cq-v1.mjs';
import {readNativeSimplifiedPartialGraph} from './native-simplified-partial-graph-v1.mjs';
import {createNativeSimplifiedConflictProduct} from './native-simplified-conflict-product-v1.mjs';
import {readNativeBuildProgress} from './native-build-progress-v1.mjs';
import {readNativeSettledCQImport} from './native-settled-cq-import-v1.mjs';
import {readNativeSettledSemanticImport} from './native-settled-semantic-import-v1.mjs';
import {createNativeLibraryApplication,LIBRARY_APPLICATION_MODE} from './native-library-application-v1.mjs';
import {createNativeLibraryPendingAnalysisProduct} from './native-library-pending-analysis-v1.mjs';
import {prepareNativeSavedStageRecovery,createNativeSavedStageRecovery,SAVED_STAGE_RECOVERY_MODE} from './native-saved-stage-recovery-v1.mjs';
import {listNativeLibraryReview,submitNativeLibraryReview,prepareNativeLibraryReviewApplication} from './native-library-review-v1.mjs';
import {GENERAL_KNOWLEDGE_POLICY} from './native-general-knowledge-v1.mjs';
import {prepareNativeProgressResume} from './native-progress-resume-v1.mjs';
import {PROGRESS_EXECUTION,NORMAL_NATIVE_LIMITS} from './native-execution-controls-v1.mjs';
/** Product adapter for the native chain. No credentials or provider calls at import. */
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createProductDocumentCatalog} from './document-catalog-v1.mjs';
import {hash} from './cq-discovery-store-v2.mjs';
import {assertLibraryActive} from './library-management.mjs';
import {NATIVE_BUILD_MODE} from './native-full-chain-http-v1.mjs';
import {DEFAULT_NATIVE_LIMITS} from './native-full-run-v1.mjs';
import {createNativeFamilyInput,normalizeNativeFamilyOutput,validateNativeFamilyOutput,materializeNativeFamilyRefs} from './native-family-input-adapter-v1.mjs';
import {DEMAND_FAMILY_POLICY} from './native-demand-family-v1.mjs';
import {prepareSimplifiedRecovery} from './native-simplified-recovery-v1.mjs';
import {prepareNativeProductConfirmedCQ} from './native-confirmed-cq-reuse-v1.mjs';
import {prepareNativeProductConfirmedCQDrafts} from './native-confirmed-cq-drafts-reuse-v1.mjs';
import {prepareNativeProductConfirmedPrefix} from './native-confirmed-prefix-reuse-v1.mjs';
import {prepareNativeProductConfirmedProposalRebuild} from './native-confirmed-proposal-rebuild-v1.mjs';
import {prepareNativeProductConfirmedHybridUpstream} from './native-confirmed-hybrid-upstream-v1.mjs';
import {prepareNativeProductConfirmedExtraction} from './native-confirmed-extraction-reuse-v1.mjs';
import {prepareNativeConfirmedSemanticPackages,readNativeSemanticPackagePage,snapshotNativeSemanticStages} from './native-semantic-package-v1.mjs';
import {prepareNativeProductOrganizationDrafts,describeNativeProductOrganizationDrafts} from './native-organization-drafts-product-v1.mjs';
import {ARGUMENT_NORMALIZATION} from './native-tool-arguments-v1.mjs';
import {readNativeBuildArtifacts} from './native-build-artifacts-read-v1.mjs';
const LIBRARY='native_product_library_v1',RUN='native_product_run_v1',REQUEST='native_product_request_v1',UNKNOWN_ACK='native_product_unknown_ack_v1';
const need=(ok,code,status=409)=>{if(!ok)throw Object.assign(Error(code),{code,status});};
const clone=structuredClone;
const semanticSkillPaths=[fileURLToPath(new URL('../docs/skill-drafts/lightog-semantic-discovery/SKILL.md',import.meta.url))];
const organizationSkillPaths=[fileURLToPath(new URL('../docs/skill-drafts/lightog-knowledge-organization/SKILL.md',import.meta.url))];
const relationReviewSkillPaths=[fileURLToPath(new URL('../docs/skill-drafts/lightog-relation-review/SKILL.md',import.meta.url))];
const terminal=new Set(['READY','SUCCEEDED','PARTIALLY_READY','FAILED','BLOCKED','CANCELLED','STALE','UNKNOWN_HOLD','STOPPED','COMPLETED']);

/** Read confirmed stages without constructing an upstream controller or replaying it. */
export function prepareNativeProductConfirmedUpstream(args){return prepareConfirmedUpstream(args,new Set());}
function prepareConfirmedUpstream({store,catalog,libraryId,snapshotId,upstreamRunId},seen){
  need(!seen.has(upstreamRunId)&&seen.size<32,'NATIVE_REUSE_LINEAGE_CYCLE');seen.add(upstreamRunId);
  const row=store.getRecord(RUN,upstreamRunId),ledger=store.getRecord('native_full_run_v1',upstreamRunId),state=store.getRecord('native_full_chain_state_v1',upstreamRunId);
  const rebuildOrigin=row?.rebuild_saved_proposals_from_run_id,reuseOrigin=row?.reuse_cq_family_from_run_id;
  if(rebuildOrigin||reuseOrigin){
    need(!rebuildOrigin||!reuseOrigin,'NATIVE_REUSE_LINEAGE_CHANGED');
    need(row.run_id===upstreamRunId&&row.library_id===libraryId&&row.snapshot_id===snapshotId&&state?.run_id===upstreamRunId&&state.library_id===libraryId&&state.snapshot_id===snapshotId&&ledger?.run_id===upstreamRunId,'NATIVE_REUSE_SOURCE_MISMATCH');
    need((['FAILED','SUCCEEDED','PARTIALLY_READY'].includes(row.status)||row.status==='STOPPED'&&state.input?.extraction_stage_policy==='SEMANTIC_THEN_ORGANIZE_V1')&&ledger.status===row.status&&Number.isFinite(row.ended_at)&&Number.isFinite(ledger.ended_at)&&Array.isArray(ledger.attempts)&&ledger.attempts.every(a=>a.outcome==='RETURNED'),'NATIVE_REUSE_UNCONFIRMED_RUN');
    need(catalog.isCurrent(snapshotId,libraryId),'NATIVE_REUSE_SOURCE_STALE');
    const source=catalog.get(snapshotId,libraryId),input=state.input,origin=rebuildOrigin??reuseOrigin;
    need(input&&hash(input)===hash(ledger.input)&&hash(state.limits)===hash(ledger.limits)&&ledger.binding===hash({input,limits:ledger.limits})&&input.library_ref===libraryId&&input.source_snapshot_ref===snapshotId&&input.source_fingerprint===source.fingerprint&&row.source_epoch===source.source_epoch,'NATIVE_REUSE_SOURCE_MISMATCH');
    need(/^nrun_[a-f0-9]{32}$/.test(origin)&&state.upstream_origin?.run_id===origin,'NATIVE_REUSE_LINEAGE_CHANGED');
    if(rebuildOrigin)need(row.execution_mode==='PROGRAM_RENORMALIZE_SAVED_PROPOSALS'&&state.execution_label==='PROGRAM_RENORMALIZE_SAVED_PROPOSALS'&&input.execution_mode==='PROGRAM_RENORMALIZE_SAVED_PROPOSALS'&&state.upstream_origin.mode==='PROGRAM_RENORMALIZE_SAVED_PROPOSALS'&&/^[a-f0-9]{64}$/.test(input.confirmed_proposal_rebuild_sha256??''),'NATIVE_REUSE_LINEAGE_CHANGED');
    else need(['REUSE_CONFIRMED_CQ_FAMILY','REUSE_CONFIRMED_SEMANTIC_PACKAGES','REUSE_CONFIRMED_ORGANIZATION_DRAFTS','PROGRESS_RESUME_V1'].includes(row.execution_mode)&&state.upstream_origin.mode==='EXPLICITLY_IMPORTED_CONFIRMED_OUTPUTS','NATIVE_REUSE_LINEAGE_CHANGED');
    const prepared=prepareConfirmedUpstream({store,catalog,libraryId,snapshotId,upstreamRunId:origin},seen);
    need(hash(state.cq_input)===hash(prepared.cq_input)&&hash(state.family_input)===hash(prepared.family_input)&&hash(state.families)===hash(prepared.families),'NATIVE_REUSE_LINEAGE_CONTENT_CHANGED');
    if(rebuildOrigin)need(prepared.hybrid_plan&&hash(state.proposal_rebuild_plan)===hash(prepared.hybrid_plan),'NATIVE_REUSE_LINEAGE_CHANGED');
    else need(input.confirmed_upstream_sha256===hash(prepared),'NATIVE_REUSE_LINEAGE_CHANGED');
    const artifact=(stage,payload)=>{const cp=ledger.checkpoints?.find(c=>c.stage===stage),a=cp&&store.getRecord('native_full_run_artifact_v1',cp.artifact_ref),body=a&&{run_id:a.run_id,stage:a.stage,payload:a.payload,parent_refs:a.parent_refs};need(a?.run_id===upstreamRunId&&a.stage===stage&&hash(a.payload)===hash(payload)&&a.content_hash===hash(body)&&cp.artifact_ref==='native_artifact_'+hash(body),'NATIVE_REUSE_ARTIFACT_CHANGED');return a;};
    const cqArtifact=artifact('CQ_IMPORTED_CONFIRMED',{cq_input:prepared.cq_input,upstream_run_id:origin}),familyArtifact=artifact('FAMILIES_IMPORTED_CONFIRMED',{families:prepared.families,upstream_run_id:origin});
    need(cqArtifact.parent_refs.includes(ledger.checkpoints.find(c=>c.stage==='SOURCE_READY')?.artifact_ref)&&familyArtifact.parent_refs.includes(cqArtifact.artifact_ref),'NATIVE_REUSE_ARTIFACT_CHANGED');
    return prepared;
  }
  if(row?.stop_after==='FAMILY'&&state?.upstream_origin?.mode==='EXPLICITLY_IMPORTED_CONFIRMED_CQ_ONLY'){
    return prepareNativeProductConfirmedPrefix({store,catalog,libraryId,snapshotId,upstreamRunId});
  }
  if(['DOCLING_HYBRID_CQ_V1','DOCLING_STRUCTURE_CQ_V2'].includes(state?.input?.cq_chunk_policy?.version)){
    return prepareNativeProductConfirmedHybridUpstream({store,catalog,libraryId,snapshotId,upstreamRunId});
  }
  need(row?.library_id===libraryId&&row.snapshot_id===snapshotId&&state?.library_id===libraryId&&state.snapshot_id===snapshotId&&state.run_id===upstreamRunId&&ledger?.run_id===upstreamRunId,'NATIVE_REUSE_SOURCE_MISMATCH');
  need(['FAILED','SUCCEEDED','PARTIALLY_READY'].includes(row.status)&&ledger.status===row.status&&ledger.attempts?.length>0&&ledger.attempts.every(a=>a.outcome==='RETURNED'),'NATIVE_REUSE_UNCONFIRMED_RUN');
  need(catalog.isCurrent(snapshotId,libraryId),'NATIVE_REUSE_SOURCE_STALE');
  const source=catalog.get(snapshotId,libraryId);
  need(source.documents?.length>0&&source.documents.every(d=>d.parser?.name==='docling'&&d.blocks?.length>0),'NATIVE_REUSE_DOCLING_REQUIRED');
  need(state.input&&ledger.input&&row.source_epoch===source.source_epoch&&hash(state.input)===hash(ledger.input)&&ledger.input.source_fingerprint===source.fingerprint&&ledger.input.source_snapshot_ref===snapshotId&&ledger.input.library_ref===libraryId,'NATIVE_REUSE_SOURCE_MISMATCH');
  const cq=state.cq_input,familyInput=state.family_input,families=state.families;
  need(cq?.run_id===upstreamRunId&&cq.source_snapshot_ref===snapshotId&&cq.items?.length>0&&families?.families?.length>0&&familyInput?.input_ref===families.input_ref,'NATIVE_REUSE_OUTPUTS_REQUIRED');
  need(cq.items.every(item=>Array.isArray(item.source_refs)&&item.source_refs.every(ref=>source.documents.some(d=>d.doc_id===ref.doc_ref&&d.revision===ref.revision))),'NATIVE_REUSE_SOURCE_MISMATCH');
  const cqState=store.getRecord('native_cq_source_adapter_v1',upstreamRunId);
  need(cqState?.binding===hash({runId:upstreamRunId,libraryId,snapshotId,source})&&hash(cqState.cq_input)===hash(cq)&&hash(store.getRecord('native_cq_input_v1',cq.input_ref))===hash(cq),'NATIVE_REUSE_CQ_CHANGED');
  for(const read of cqState.reads??[]){
    need(read.run_id===upstreamRunId&&read.source_snapshot_ref===snapshotId&&read.body_returned&&hash(store.getRecord('native_cq_read_receipt_v1',read.read_receipt_ref))===hash(read),'NATIVE_REUSE_READ_RECEIPT_CHANGED');
    const doc=source.documents.find(d=>d.doc_id===read.source_ref?.doc_ref&&d.revision===read.source_ref.revision);
    need(doc&&read.result?.units?.every(u=>Number.isSafeInteger(u.start)&&Number.isSafeInteger(u.end)&&u.end>u.start&&doc.blocks.some(b=>b.block_id===u.block_id&&u.start>=b.start&&u.end<=b.end)&&doc.content.slice(u.start,u.end)===u.text),'NATIVE_REUSE_READ_RECEIPT_CHANGED');
  }
  for(const doc of source.documents)for(const block of doc.blocks){
    const ranges=(cqState.reads??[]).filter(r=>r.source_ref.doc_ref===doc.doc_id&&r.source_ref.revision===doc.revision).flatMap(r=>r.result.units)
      .filter(u=>u.block_id===block.block_id).sort((a,b)=>a.start-b.start);
    let end=block.start;for(const range of ranges){if(range.start>end)break;end=Math.max(end,range.end);}
    need(end>=block.end,'NATIVE_REUSE_CQ_SCAN_INCOMPLETE');
  }
  const artifact=(stage,payload)=>{
    const checkpoint=ledger.checkpoints?.find(c=>c.stage===stage),value=checkpoint&&store.getRecord('native_full_run_artifact_v1',checkpoint.artifact_ref);
    const content=value&&{run_id:value.run_id,stage:value.stage,payload:value.payload,parent_refs:value.parent_refs};
    need(value?.run_id===upstreamRunId&&value.stage===stage&&hash(value.payload)===hash(payload)&&value.content_hash===hash(content)&&checkpoint.artifact_ref==='native_artifact_'+hash(content),'NATIVE_REUSE_ARTIFACT_CHANGED');
    return value;
  };
  const cqArtifact=artifact('CQ_SAVED',cq),familyArtifact=artifact('FAMILIES_SAVED',families);
  need(cqArtifact.parent_refs.includes(ledger.checkpoints.find(c=>c.stage==='SOURCE_READY')?.artifact_ref)&&familyArtifact.parent_refs.includes(cqArtifact.artifact_ref),'NATIVE_REUSE_ARTIFACT_CHANGED');
  for(const role of ['CQ','FAMILY']){
    const matches=(state.invocations??[]).filter(i=>i.role===role),invocation=matches[0],retainedMatches=invocation?store.listRecords('native_agent_invocation_v1').filter(i=>i.invocation_ref===invocation.invocation_ref&&i.run_id===upstreamRunId&&i.role===role):[],retained=retainedMatches[0];
    need(matches.length===1&&invocation.status==='SUCCEEDED'&&invocation.outcome==='RETURNED'&&invocation.origin==='CODEX_NATIVE_APP_SERVER'&&retainedMatches.length===1&&retained.status==='SUCCEEDED'&&retained.outcome==='RETURNED'&&hash(retained.request_refs)===hash(invocation.request_refs),'NATIVE_REUSE_INVOCATION_REQUIRED');
    need(invocation.request_refs?.length>0&&new Set(invocation.request_refs).size===invocation.request_refs.length&&invocation.request_refs.every(ref=>ledger.attempts.some(a=>a.request_ref===ref&&a.kind==='GENERATION'&&a.role===role&&a.outcome==='RETURNED')),'NATIVE_REUSE_REQUEST_BINDING_CHANGED');
  }
  need(hash(createNativeFamilyInput({runId:upstreamRunId,sourceSnapshotRef:snapshotId,inputs:[cq]}))===hash(familyInput),'NATIVE_REUSE_FAMILY_INPUT_CHANGED');
  if(state.input.knowledge_build_policy==='EXTRACT_AND_INDEX_V1'){
    const proposals=store.listRecords('native_family_output_normalization_v1').filter(p=>p.run_id===upstreamRunId);
    need(proposals.length===1&&proposals[0].input_ref===familyInput.input_ref,'NATIVE_REUSE_FAMILIES_CHANGED');
    const options={knowledgeBuildPolicy:'EXTRACT_AND_INDEX_V1'},normalized=normalizeNativeFamilyOutput({args:proposals[0].raw,...options}).normalized;
    need(hash(normalized)===hash(proposals[0].normalized),'NATIVE_REUSE_FAMILIES_CHANGED');
    const validated=validateNativeFamilyOutput({input:familyInput,args:normalized,...options});
    need(hash(materializeNativeFamilyRefs({input:familyInput,families:validated,...options}))===hash(families),'NATIVE_REUSE_FAMILIES_CHANGED');
  }else{
    const raw={...clone(families),families:families.families.map(({family_ref,...family})=>clone(family))};
    validateNativeFamilyOutput({input:familyInput,args:raw});
    need(hash(materializeNativeFamilyRefs({input:familyInput,families:raw}))===hash(families),'NATIVE_REUSE_FAMILIES_CHANGED');
  }
  return {upstream_run_id:upstreamRunId,source_snapshot_ref:snapshotId,cq_input:clone(cq),family_input:clone(familyInput),families:clone(families),cq_scan_status:'COMPLETE'};
}
export function createNativeFullChainProduct({store,governance,runtime,product,runtimeDirectory,documentStorage=resolve(runtimeDirectory,'../documents'),chainFactory,modelRuntime,onOperation=()=>{},temporalPublicationPort=null,familyPolicy=DEMAND_FAMILY_POLICY,defaultBuildFlowPolicy=null}) {
  need(familyPolicy===null||familyPolicy===DEMAND_FAMILY_POLICY,'NATIVE_FAMILY_POLICY_INVALID');
  need(temporalPublicationPort===null||temporalPublicationPort.policy==='DOCUMENT_BITEMPORAL_PUBLICATION_V1'
    &&typeof temporalPublicationPort.publishBuild==='function','NATIVE_TEMPORAL_PUBLICATION_PORT_INVALID');
  const catalog=createProductDocumentCatalog({store,governance,runtime}),live=new Map();
  let closed=false;
  const loadFactory=async()=>chainFactory??(await import('./native-full-chain-v1.mjs')).createNativeFullChain;
  const active=libraryId=>{assertLibraryActive(store,libraryId);need(governance.baseFor(libraryId),'SOURCE_LIBRARY_NOT_FOUND');};
  const rowFor=(libraryId,runId)=>{active(libraryId);const row=store.getRecord(RUN,runId);need(row?.library_id===libraryId,'NATIVE_RUN_NOT_FOUND',404);return row;};
  // A saved input is authoritative, including the absence of the new policy.
  const retainedFamilyPolicy=row=>{
    const retained=store.getRecord('native_full_run_v1',row.run_id);
    const policy=(retained?.input?retained.input.family_policy:row.family_policy)??null;
    need(policy===null||policy===DEMAND_FAMILY_POLICY,'NATIVE_FAMILY_POLICY_INVALID');
    return policy;
  };
  const config=()=>modelRuntime?.()??product.nativeModelRuntime?.()??null;
  const pendingAnalysis=createNativeLibraryPendingAnalysisProduct({store,catalog,runtimeDirectory:resolve(runtimeDirectory,'pending-analysis'),
    modelRuntime:config,onOperation,resolveBinding({libraryId,runId,revisionRef}){
      const row=rowFor(libraryId,runId),activeRevision=store.getRecord('native_library_knowledge_active_v1',libraryId);
      const review=listNativeLibraryReview({store,catalog,libraryId,snapshotId:row.snapshot_id,runId,revisionRef,currentRevisionRef:activeRevision?.revision_ref});
      return {review,revision:store.getRecord('native_library_knowledge_revision_v1',review.revision_ref)};
    }});
  function resumePlan(row){const prefix=prepareNativeProductConfirmedUpstream({store,catalog,libraryId:row.library_id,snapshotId:row.snapshot_id,upstreamRunId:row.run_id});return prepareNativeProgressResume({store,catalog,libraryId:row.library_id,snapshotId:row.snapshot_id,upstreamRunId:row.run_id,confirmedUpstream:prefix});}
  function resumeDescription(row){try{need(!store.listRecords(RUN).some(r=>r.library_id===row.library_id&&!terminal.has(r.status)),'NATIVE_LIBRARY_RUN_ACTIVE');need(!heldRows(row.library_id).length,'NATIVE_LIBRARY_UNKNOWN_HOLD');const plan=resumePlan(row);return {resume_available:true,resume_summary:{...plan.summary,capability:plan.capability}};}catch(error){return {resume_available:false,resume_summary:{reason:error.code??'NATIVE_RESUME_UNAVAILABLE'}};}}
  function publicConfiguration(){
    const status=product.modelStatus?.()??{};let configured=null,configurationError=null;
    try{configured=config();}catch(error){if(!/^NATIVE_(GENERATION|RESPONSES|EMBEDDING)_/.test(error.code??''))throw error;configurationError=error.code;}
    if(!configured&&typeof product.nativeEmbeddingRuntime==='function'){try{configured=product.nativeEmbeddingRuntime();}catch(error){if(!configurationError)configurationError=error.code??'NATIVE_EMBEDDING_CONFIGURATION_UNAVAILABLE';}}
    return {generation_configured:Boolean(configured?.upstream),embedding_configured:Boolean(configured?.embed&&configured?.embeddingSpace),generation:status.generation??null,embedding:status.embedding??null,configuration_error:configurationError};
  }
  function assertParsed(snapshot){need(snapshot.documents.length&&snapshot.documents.every(d=>d.parser?.name==='docling'),'NATIVE_DOCLING_DOCUMENT_REQUIRED',400);}
  function isCurrent(row){return catalog.isCurrent(row.snapshot_id,row.library_id);}
  function persist(row){store.putRecord(RUN,row.run_id,row);return row;}
  const publicRow=row=>({...clone(row),allow_format_repair_once:row.allow_format_repair_once===true});
  const repairPolicy=row=>({max_per_agent:row.allow_format_repair_once===true?1:0});
  // A new, explicitly requested FAMILY result may supersede the stopped stage.
  // Its predecessor's request outcome remains UNKNOWN and is never rewritten.
  function acceptedCQContinuation(row){
    const old=store.getRecord('native_full_chain_state_v1',row.run_id);
    return store.listRecords(RUN).some(next=>{
      if(next.library_id!==row.library_id||next.reuse_cq_from_run_id!==row.run_id||!['SUCCEEDED','PARTIALLY_READY'].includes(next.status))return false;
      const state=store.getRecord('native_full_chain_state_v1',next.run_id),ledger=store.getRecord('native_full_run_v1',next.run_id);
      return next.snapshot_id===row.snapshot_id&&state?.families&&old?.cq_input&&hash(state.cq_input)===hash(old.cq_input)&&ledger?.summary?.completion_scope==='CQ_FAMILY_ONLY'&&ledger.attempts.every(a=>a.outcome==='RETURNED');
    });
  }
  function heldRows(libraryId){return store.listRecords(RUN).filter(r=>r.library_id===libraryId&&r.status==='UNKNOWN_HOLD'&&!acceptedCQContinuation(r));}
  function reusableCQ(row){
    try{
      need(!acceptedCQContinuation(row),'NATIVE_CQ_CONTINUATION_NOT_AVAILABLE');
      need(!store.listRecords(RUN).some(r=>r.library_id===row.library_id&&!terminal.has(r.status)),'NATIVE_LIBRARY_RUN_ACTIVE');
      const value=prepareNativeProductConfirmedCQ({store,catalog,libraryId:row.library_id,snapshotId:row.snapshot_id,upstreamRunId:row.run_id,acknowledgeUnknown:true});
      return {available:true,upstream_run_id:value.upstream_run_id,cq_count:value.cq_input.items.length,requires_unknown_acknowledgement:value.prior_status==='UNKNOWN_HOLD',reason:null};
    }catch(error){return {available:false,reason:error.code??'NATIVE_CQ_CHECKPOINT_UNCONFIRMED'};}
  }
  function reusableCQDrafts(row){
    try{
      need(!store.listRecords(RUN).some(r=>r.library_id===row.library_id&&!terminal.has(r.status))&&!heldRows(row.library_id).length,'NATIVE_REUSE_LIBRARY_NOT_SETTLED');
      const value=prepareNativeProductConfirmedCQDrafts({store,catalog,libraryId:row.library_id,snapshotId:row.snapshot_id,upstreamRunId:row.run_id});
      return {available:true,upstream_run_id:value.upstream_run_id,cq_count:value.drafts.reduce((n,row)=>n+row.draft.items.length,0),window_count:value.drafts.length,reason:null};
    }catch(error){return {available:false,reason:error.code??'NATIVE_CQ_DRAFTS_UNCONFIRMED'};}
  }
  function rebuildableProposals(row){
    try{
      need(!store.listRecords(RUN).some(r=>r.library_id===row.library_id&&!terminal.has(r.status))&&!heldRows(row.library_id).length,'NATIVE_REUSE_LIBRARY_NOT_SETTLED');
      const value=prepareNativeProductConfirmedProposalRebuild({store,catalog,libraryId:row.library_id,snapshotId:row.snapshot_id,upstreamRunId:row.run_id});
      return {available:true,upstream_run_id:value.upstream_run_id,proposal_count:value.proposal_count,item_count:value.item_count,reason:null};
    }catch(error){return {available:false,upstream_run_id:row.run_id,proposal_count:0,item_count:0,reason:error.code??'NATIVE_PROPOSAL_REBUILD_UNCONFIRMED'};}
  }
  function prepareSemanticReuse(libraryId,runId){
    const visible=rowFor(libraryId,runId),upstream=prepareNativeProductConfirmedUpstream({store,catalog,libraryId,snapshotId:visible.snapshot_id,upstreamRunId:runId});
    const origin=visible.reuse_semantic_from_run_id??runId;
    const confirmed=prepareNativeConfirmedSemanticPackages({store,catalog,libraryId,snapshotId:visible.snapshot_id,upstreamRunId:origin});
    const sourcePrefix=prepareNativeProductConfirmedUpstream({store,catalog,libraryId,snapshotId:visible.snapshot_id,upstreamRunId:origin});
    need(hash(upstream)===hash(sourcePrefix),'NATIVE_SEMANTIC_REUSE_PREFIX_CHANGED');
    if(origin!==runId){const state=store.getRecord('native_full_chain_state_v1',runId);need(['REUSE_CONFIRMED_SEMANTIC_PACKAGES','REUSE_CONFIRMED_ORGANIZATION_DRAFTS'].includes(visible.execution_mode)&&state?.input?.semantic_package_origin_run_id===origin&&state.input.confirmed_semantic_packages_sha256===hash(confirmed),'NATIVE_SEMANTIC_REUSE_BINDING_CHANGED');}
    return {upstream,confirmed};
  }
  const prepareOrganizationDrafts=(libraryId,runId)=>prepareNativeProductOrganizationDrafts({store,catalog,libraryId,upstreamRunId:runId,prepareSemanticReuse:id=>prepareSemanticReuse(libraryId,id)});
  function semanticAcknowledgementScope(libraryId,runId,prepared,holds=heldRows(libraryId)){
    need(holds.length>0,'NATIVE_UNKNOWN_ACKNOWLEDGEMENT_NOT_REQUIRED');
    const source=rowFor(libraryId,runId);
    return {version:'SEMANTIC_NEW_RUN_UNKNOWN_ACK_V1',purpose:prepared.organizationDrafts?'NEW_RUN_FROM_CONFIRMED_ORGANIZATION_DRAFTS':'NEW_ORGANIZATION_FROM_CONFIRMED_SEMANTIC',library_id:libraryId,source_snapshot_ref:source.snapshot_id,semantic_origin_run_id:prepared.confirmed.upstream_run_id,confirmed_semantic_sha256:hash(prepared.confirmed),confirmed_upstream_sha256:hash(prepared.upstream),...(prepared.organizationDrafts?{organization_draft_origin_run_id:prepared.organizationDrafts.upstream_run_id,confirmed_organization_drafts_sha256:hash(prepared.organizationDrafts)}:{}),held_runs:holds.map(row=>({run_id:row.run_id,row_sha256:hash(row),ledger_sha256:hash(store.getRecord('native_full_run_v1',row.run_id)??null),state_sha256:hash(store.getRecord('native_full_chain_state_v1',row.run_id)??null)})).sort((a,b)=>a.run_id.localeCompare(b.run_id))};
  }
  const acknowledgementRef=scope=>'native_unknown_ack_'+hash(scope);
  function prepareSemanticAcknowledgement(libraryId,runId,prepared,ref){
    const scope=semanticAcknowledgementScope(libraryId,runId,prepared);
    need(acknowledgementRef(scope)===ref,'NATIVE_UNKNOWN_ACKNOWLEDGEMENT_CHANGED');
    return {...scope,acknowledgement_ref:ref};
  }
  function semanticRecovery(libraryId){
    const holds=heldRows(libraryId),held=holds.map(row=>({run_id:row.run_id,status:row.status,reason:row.reason??null,unsettled_requests:(store.getRecord('native_full_run_v1',row.run_id)?.attempts??[]).filter(a=>['RESERVED','UNKNOWN'].includes(a.outcome)).length}));
    const base={available:false,requires_unknown_acknowledgement:holds.length>0,hold_count:holds.length,holds:held,candidates:[]};
    if(!holds.length)return {...base,reason:'NATIVE_LIBRARY_NO_UNKNOWN_HOLD'};
    if(store.listRecords(RUN).some(row=>row.library_id===libraryId&&!terminal.has(row.status)))return {...base,reason:'NATIVE_LIBRARY_RUN_ACTIVE'};
    const candidates=[],seen=new Set(),rows=store.listRecords(RUN).filter(row=>row.library_id===libraryId&&terminal.has(row.status)&&row.status!=='UNKNOWN_HOLD').sort((a,b)=>b.created_at-a.created_at);
    for(const row of rows){try{
      const prepared=prepareSemanticReuse(libraryId,row.run_id),origin=prepared.confirmed.upstream_run_id;if(seen.has(origin))continue;
      const canonical=origin===row.run_id?prepared:prepareSemanticReuse(libraryId,origin),scope=semanticAcknowledgementScope(libraryId,origin,canonical,holds),stages=snapshotNativeSemanticStages({store,runId:origin});
      candidates.push({upstream_run_id:origin,window_count:canonical.confirmed.packages.length,item_count:stages.reduce((n,s)=>n+s.semantic.items,0),unknown_acknowledgement_ref:acknowledgementRef(scope)});seen.add(origin);
    }catch{ /* Unconfirmed history is never promoted into a recovery candidate. */ }}
    return {...base,available:candidates.length>0,candidates,reason:candidates.length?null:'NATIVE_SEMANTIC_RECOVERY_PACKAGE_REQUIRED'};
  }
  function organizationDraftRecovery(libraryId){
    const holds=heldRows(libraryId),base={available:false,requires_unknown_acknowledgement:holds.length>0,hold_count:holds.length,candidates:[]};
    if(store.listRecords(RUN).some(row=>row.library_id===libraryId&&!terminal.has(row.status)))return {...base,reason:'NATIVE_LIBRARY_RUN_ACTIVE'};
    const candidates=[];for(const row of store.listRecords(RUN).filter(r=>r.library_id===libraryId&&['FAILED','STOPPED'].includes(r.status)).sort((a,b)=>b.created_at-a.created_at)){
      try{const prepared=prepareOrganizationDrafts(libraryId,row.run_id),description=describeNativeProductOrganizationDrafts({store,prepared});candidates.push({...description,...(holds.length?{unknown_acknowledgement_ref:acknowledgementRef(semanticAcknowledgementScope(libraryId,row.run_id,prepared,holds))}:{})});}catch{ /* Only complete, settled saved drafts are selectable. */ }
    }
    return {...base,available:candidates.length>0,candidates,reason:candidates.length?null:'NATIVE_ORGANIZATION_DRAFTS_NOT_AVAILABLE'};
  }
  function reusableSemantic(row){
    try{
      need(!store.listRecords(RUN).some(r=>r.library_id===row.library_id&&!terminal.has(r.status))&&!heldRows(row.library_id).length,'NATIVE_REUSE_LIBRARY_NOT_SETTLED');
      const {confirmed}=prepareSemanticReuse(row.library_id,row.run_id);
      const stages=snapshotNativeSemanticStages({store,runId:confirmed.upstream_run_id});
      return {available:true,upstream_run_id:confirmed.upstream_run_id,window_count:confirmed.packages.length,item_count:stages.reduce((n,s)=>n+s.semantic.items,0),reason:null};
    }catch(error){return {available:false,reason:error.code??'NATIVE_SEMANTIC_REUSE_UNCONFIRMED'};}
  }
  function reusable(row){
    try{
      need(!store.listRecords(RUN).some(r=>r.library_id===row.library_id&&!terminal.has(r.status))&&!heldRows(row.library_id).length,'NATIVE_REUSE_LIBRARY_NOT_SETTLED');
      const ledger=store.getRecord('native_full_run_v1',row.run_id);
      need(['FAILED','SUCCEEDED','PARTIALLY_READY'].includes(row.status)&&ledger?.status===row.status&&Array.isArray(ledger.attempts)&&(ledger.attempts.length>0||row.rebuild_saved_proposals_from_run_id)&&ledger.attempts.every(a=>a.outcome==='RETURNED'),'NATIVE_REUSE_UNCONFIRMED_RUN');
      const value=prepareNativeProductConfirmedUpstream({store,catalog,libraryId:row.library_id,snapshotId:row.snapshot_id,upstreamRunId:row.run_id});
      let retained=null;
      // The normal product action starts the current domain extractor. Offer
      // saved extraction stages only when their semantic policy is compatible;
      // an old run can still supply its unchanged CQ/family prefix.
      if(row.status==='FAILED'&&row.reuse_cq_family_from_run_id&&ledger.input?.semantic_policy==='DOMAIN_KNOWLEDGE_V1'&&ledger.input?.extraction_window_policy?.version==='HYBRID_EXTRACTION_V1'){
        try{retained=prepareNativeProductConfirmedExtraction({store,catalog,libraryId:row.library_id,snapshotId:row.snapshot_id,upstreamRunId:row.run_id,confirmedPrefix:value});}catch{}
      }
      return {available:true,upstream_run_id:value.upstream_run_id,cq_count:value.cq_input.items.length,family_count:value.families.families.length,reason:null,
        ...(retained?.retained_windows?.length?{reuse_extraction_from_run_id:row.run_id,retained_windows:retained.retained_windows.length,retained_knowledge:retained.knowledge_count,partial_retained_windows:retained.retained_windows.filter(w=>w.partial).length}:{})};
    }catch(error){return {available:false,reason:error.code??'NATIVE_REUSE_OUTPUTS_UNCONFIRMED'};}
  }
  function noLegacyWriter(libraryId){
    need(!store.listRecords('product_learning_intent').some(r=>r.library_id===libraryId&&['WAITING','WAIT_MODEL_CONFIGURATION','DISCOVERING','SCOPE_PLANNED','RUNNING'].includes(r.status)),'NATIVE_LEGACY_WRITER_ACTIVE');
    need(!store.listRecords('source_product_queue').some(r=>r.library_id===libraryId&&['QUEUED','RUNNING','WAIT_MODEL_CONFIGURATION','UNKNOWN_NO_RETRY'].includes(r.status)),'NATIVE_LEGACY_WRITER_ACTIVE');
  }
  // A server restart is not authorization to replay an unfinished native run.
  store.transaction(()=>{for(const row of store.listRecords(RUN))if(['STARTING','RUNNING'].includes(row.status))persist({...row,status:'UNKNOWN_HOLD',reason:'NATIVE_PRODUCT_RESTART_NO_AUTOMATIC_REPLAY',ended_at:Date.now()});});
  async function controller(row){
    const existing=live.get(row.run_id);if(existing?.chain)return existing.chain;
    const factory=await loadFactory();
    // Rehydration only: query/status do not call chain.run or attach live models.
    if(row.execution_mode===LIBRARY_APPLICATION_MODE)return createNativeLibraryApplication({store,catalog,libraryId:row.library_id,snapshotId:row.snapshot_id,runId:row.run_id});
    if(row.execution_mode===SAVED_STAGE_RECOVERY_MODE)return createNativeSavedStageRecovery({store,catalog,libraryId:row.library_id,snapshotId:row.snapshot_id,runId:row.run_id});
    const retained=store.getRecord('native_full_run_v1',row.run_id);
    return factory({store,catalog,libraryId:row.library_id,snapshotId:row.snapshot_id,runId:row.run_id,...(row.settled_cq_import_ref?{settledCQImportRef:row.settled_cq_import_ref}:{}),...(row.build_flow_policy?{buildFlowPolicy:row.build_flow_policy}:{}),settledSemanticImportRef:row.settled_semantic_import_ref??null,familyPolicy:retainedFamilyPolicy(row),limits:retained?.limits??row.limits,executionPolicy:retained?.input?.execution_policy??row.execution_policy??null,generalKnowledgePolicy:retained?.input?.general_knowledge_policy??null,libraryKnowledgePolicy:retained?.input?.library_knowledge_policy??null,formatRepairPolicy:repairPolicy(row),cqChunkOptions:{documentStorage},stopAfter:row.stop_after??null,
      ...((retained?.input?.temporal_publication_policy||row.build_flow_policy)&&temporalPublicationPort?{temporalPublicationPort}:{}),
      ...(row.organization_relation_review_policy?{organizationRelationReviewPolicy:row.organization_relation_review_policy,relationReviewSkillPaths:row.relation_review_skill_paths,extractionStagePolicy:row.extraction_stage_policy,extractionReviewPolicy:row.extraction_review_policy}:{})});
  }
  function registration({libraryId}){
    active(libraryId);noLegacyWriter(libraryId);const state=governance.baseFor(libraryId),snapshot=catalog.freeze(libraryId,state.source_epoch);assertParsed(snapshot);
    const row={library_id:libraryId,build_mode:NATIVE_BUILD_MODE,snapshot_id:snapshot.snapshot_id,source_epoch:snapshot.source_epoch,status:'REGISTERED',registered_at:Date.now(),model_calls:0};
    store.putRecord(LIBRARY,libraryId,row);return clone(row);
  }
  return {
    catalog,
    artifacts(args){rowFor(args.libraryId,args.runId);return readNativeBuildArtifacts({store,catalog,...args});},
    validateInput(input){need(input?.sources?.length&&input.sources.every(s=>s.parsing?.parser==='docling'),'NATIVE_DOCLING_DOCUMENT_REQUIRED',400);},
    isNativeLibrary:libraryId=>store.getRecord(LIBRARY,libraryId)?.build_mode===NATIVE_BUILD_MODE,
    register:registration,
    async list({libraryId}){
      active(libraryId);const rows=store.listRecords(RUN).filter(r=>r.library_id===libraryId).sort((a,b)=>b.created_at-a.created_at);
      return {active_library_knowledge:store.getRecord('native_library_knowledge_active_v1',libraryId)??null,build_mode:store.getRecord(LIBRARY,libraryId)?.build_mode??null,registration:store.getRecord(LIBRARY,libraryId)??null,runs:rows.map((row,index)=>({...publicRow(row),...(index===0?{progress_summary:readNativeBuildProgress({store,row})}:{}),...resumeDescription(row),reusable_cq_family:reusable(row),reusable_cq:reusableCQ(row),reusable_cq_drafts:reusableCQDrafts(row),rebuildable_proposals:rebuildableProposals(row),reusable_semantic_packages:reusableSemantic(row)})),semantic_recovery:semanticRecovery(libraryId),organization_draft_recovery:organizationDraftRecovery(libraryId),configuration:publicConfiguration()};
    },
    async start({libraryId,requestId,limits,capability='HYBRID',allowFormatRepairOnce=false,reuseCQFamilyFromRunId=null,reuseExtractionFromRunId=null,stopAfter=null,reuseCQFromRunId=null,acknowledgeUnknown=false,reuseCQDraftsFromRunId=null,rebuildSavedProposalsFromRunId=null,reuseSemanticFromRunId=null,unknownAcknowledgementRef=null,reuseOrganizationDraftFromRunId=null,resumeFromRunId=null,settledSemanticImportRef=null,buildFlowPolicy=null,settledCQImportRef=null,recoverSimplifiedFromRunId=null}){
      active(libraryId);need(!closed,'NATIVE_PRODUCT_CLOSED');
      if(stopAfter==='CQ'){need(!recoverSimplifiedFromRunId&&!settledCQImportRef&&!settledSemanticImportRef&&!reuseCQFromRunId&&!reuseCQFamilyFromRunId&&!reuseExtractionFromRunId&&!reuseCQDraftsFromRunId&&!reuseSemanticFromRunId&&!reuseOrganizationDraftFromRunId&&!resumeFromRunId&&!rebuildSavedProposalsFromRunId,'NATIVE_CQ_ONLY_FRESH_SCOPE_REQUIRED',400);buildFlowPolicy=null;}
      if(buildFlowPolicy===null&&stopAfter!=='CQ'){const existing=store.getRecord(REQUEST,hash([libraryId,requestId]));buildFlowPolicy=existing?(store.getRecord(RUN,existing.run_id)?.build_flow_policy??null):defaultBuildFlowPolicy;}

      need(recoverSimplifiedFromRunId===null||/^nrun_[a-f0-9]{32}$/.test(recoverSimplifiedFromRunId)&&buildFlowPolicy==='SIMPLIFIED_SOURCE_BLOCK_V1'&&!reuseCQFromRunId&&!reuseCQFamilyFromRunId&&!reuseExtractionFromRunId&&!reuseCQDraftsFromRunId&&!resumeFromRunId&&!settledCQImportRef&&!settledSemanticImportRef&&!acknowledgeUnknown,'NATIVE_SIMPLIFIED_RECOVERY_SCOPE_INVALID',400);
      need(buildFlowPolicy===null||buildFlowPolicy==='SIMPLIFIED_SOURCE_BLOCK_V1','NATIVE_BUILD_FLOW_POLICY_INVALID',400);
      need(!settledCQImportRef||buildFlowPolicy==='SIMPLIFIED_SOURCE_BLOCK_V1'&&!reuseCQFromRunId&&!reuseCQFamilyFromRunId&&!reuseCQDraftsFromRunId,'NATIVE_CQ_IMPORT_SCOPE_CONFLICT',400);
      need(!buildFlowPolicy||!resumeFromRunId&&!reuseOrganizationDraftFromRunId&&!reuseSemanticFromRunId&&!reuseExtractionFromRunId&&!rebuildSavedProposalsFromRunId&&!settledSemanticImportRef&&!stopAfter,'NATIVE_SIMPLIFIED_REUSE_CONFLICT',400);
      need(settledSemanticImportRef===null||/^settled_semantic_import_[a-f0-9]{64}$/.test(settledSemanticImportRef),'NATIVE_SETTLED_IMPORT_REF_INVALID',400);
      need(!settledSemanticImportRef||!resumeFromRunId&&!reuseOrganizationDraftFromRunId&&!reuseSemanticFromRunId&&!reuseCQFamilyFromRunId&&!reuseExtractionFromRunId&&!reuseCQFromRunId&&!reuseCQDraftsFromRunId&&!rebuildSavedProposalsFromRunId&&!stopAfter&&!acknowledgeUnknown&&!unknownAcknowledgementRef,'NATIVE_SETTLED_IMPORT_SCOPE_CONFLICT',400);
      need(store.getRecord(LIBRARY,libraryId)?.build_mode===NATIVE_BUILD_MODE,'NATIVE_LIBRARY_MODE_REQUIRED');
      need(resumeFromRunId===null||/^nrun_[a-f0-9]{32}$/.test(resumeFromRunId),'NATIVE_REUSE_RUN_ID_INVALID',400);
      need(!resumeFromRunId||!reuseOrganizationDraftFromRunId&&!reuseSemanticFromRunId&&!reuseCQFamilyFromRunId&&!reuseExtractionFromRunId&&!reuseCQFromRunId&&!reuseCQDraftsFromRunId&&!rebuildSavedProposalsFromRunId&&!stopAfter&&!acknowledgeUnknown&&!unknownAcknowledgementRef,'NATIVE_UPSTREAM_INPUT_CONFLICT',400);
      if(resumeFromRunId)capability=rowFor(libraryId,resumeFromRunId).capability;
      need(['LEXICAL','VECTOR','HYBRID'].includes(capability),'NATIVE_CAPABILITY_INVALID',400);
      need(stopAfter===null||['CQ','FAMILY'].includes(stopAfter),'NATIVE_STOP_AFTER_INVALID',400);
      need(reuseSemanticFromRunId===null||/^nrun_[a-f0-9]{32}$/.test(reuseSemanticFromRunId),'NATIVE_REUSE_RUN_ID_INVALID',400);
      need(reuseOrganizationDraftFromRunId===null||/^nrun_[a-f0-9]{32}$/.test(reuseOrganizationDraftFromRunId),'NATIVE_REUSE_RUN_ID_INVALID',400);
      need(!reuseOrganizationDraftFromRunId||!stopAfter&&!reuseCQFromRunId&&!reuseCQFamilyFromRunId&&!reuseExtractionFromRunId&&!reuseCQDraftsFromRunId&&!rebuildSavedProposalsFromRunId&&!reuseSemanticFromRunId,'NATIVE_UPSTREAM_INPUT_CONFLICT',400);
      need(!reuseSemanticFromRunId||!stopAfter&&!reuseCQFromRunId&&!reuseCQFamilyFromRunId&&!reuseExtractionFromRunId&&!reuseCQDraftsFromRunId&&!rebuildSavedProposalsFromRunId,'NATIVE_UPSTREAM_INPUT_CONFLICT',400);
      need(rebuildSavedProposalsFromRunId===null||/^nrun_[a-f0-9]{32}$/.test(rebuildSavedProposalsFromRunId),'NATIVE_REUSE_RUN_ID_INVALID',400);
      need(!rebuildSavedProposalsFromRunId||!stopAfter&&!reuseCQFromRunId&&!reuseCQFamilyFromRunId&&!reuseExtractionFromRunId&&!reuseCQDraftsFromRunId&&!allowFormatRepairOnce,'NATIVE_UPSTREAM_INPUT_CONFLICT',400);
      need(!stopAfter||!reuseCQFamilyFromRunId,'NATIVE_DISCOVERY_REUSE_NOT_SUPPORTED',400);
      need(reuseCQFromRunId===null||/^nrun_[a-f0-9]{32}$/.test(reuseCQFromRunId),'NATIVE_REUSE_RUN_ID_INVALID',400);
      need(reuseCQDraftsFromRunId===null||/^nrun_[a-f0-9]{32}$/.test(reuseCQDraftsFromRunId),'NATIVE_REUSE_RUN_ID_INVALID',400);
      need(!reuseCQDraftsFromRunId||!reuseCQFromRunId&&!reuseCQFamilyFromRunId&&!reuseExtractionFromRunId,'NATIVE_UPSTREAM_INPUT_CONFLICT',400);
      need(typeof acknowledgeUnknown==='boolean'&&(!acknowledgeUnknown||reuseCQFromRunId||reuseSemanticFromRunId||reuseOrganizationDraftFromRunId),'NATIVE_UNKNOWN_ACKNOWLEDGEMENT_INVALID',400);
      need(unknownAcknowledgementRef===null||typeof unknownAcknowledgementRef==='string'&&/^native_unknown_ack_[a-f0-9]{64}$/.test(unknownAcknowledgementRef),'NATIVE_UNKNOWN_ACKNOWLEDGEMENT_INVALID',400);
      need(unknownAcknowledgementRef===null||(reuseSemanticFromRunId||reuseOrganizationDraftFromRunId)&&acknowledgeUnknown,'NATIVE_UNKNOWN_ACKNOWLEDGEMENT_INVALID',400);
      need(!(reuseSemanticFromRunId||reuseOrganizationDraftFromRunId)||!acknowledgeUnknown||unknownAcknowledgementRef,'NATIVE_UNKNOWN_ACKNOWLEDGEMENT_REQUIRED',400);
      need(!reuseCQFromRunId||(stopAfter==='FAMILY'||buildFlowPolicy==='SIMPLIFIED_SOURCE_BLOCK_V1')&&!reuseCQFamilyFromRunId,'NATIVE_CQ_CONTINUATION_SCOPE_REQUIRED',400);
      if(stopAfter)capability='LEXICAL';
      need(typeof allowFormatRepairOnce==='boolean','NATIVE_FORMAT_REPAIR_POLICY_INVALID',400);
      need(reuseCQFamilyFromRunId===null||/^nrun_[a-f0-9]{32}$/.test(reuseCQFamilyFromRunId),'NATIVE_REUSE_RUN_ID_INVALID',400);
      need(reuseExtractionFromRunId===null||/^nrun_[a-f0-9]{32}$/.test(reuseExtractionFromRunId),'NATIVE_REUSE_RUN_ID_INVALID',400);
      need(!reuseExtractionFromRunId||reuseCQFamilyFromRunId&&!stopAfter&&!reuseCQFromRunId,'NATIVE_EXTRACTION_REUSE_PREFIX_REQUIRED',400);
      const executionPolicy=limits===undefined?PROGRESS_EXECUTION:null,effectiveLimits=executionPolicy?clone(NORMAL_NATIVE_LIMITS):limits;
      need(executionPolicy||limits&&typeof limits==='object'&&!Array.isArray(limits),'NATIVE_LIMITS_INVALID',400);
      need(executionPolicy||Object.entries(limits).every(([k,v])=>Object.hasOwn(DEFAULT_NATIVE_LIMITS,k)&&Number.isSafeInteger(v)&&v>=0),'NATIVE_LIMITS_INVALID',400);
      // Replay and recovery inherit the persisted policy; old digests keep their original shape.
      const requestKey=hash([libraryId,requestId]),prior=store.getRecord(REQUEST,requestKey);
      const selectedFamilyPolicy=prior?retainedFamilyPolicy(rowFor(libraryId,prior.run_id)):resumeFromRunId?retainedFamilyPolicy(rowFor(libraryId,resumeFromRunId)):familyPolicy;
      const digest=hash({limits,capability,...(recoverSimplifiedFromRunId?{recover_simplified_from_run_id:recoverSimplifiedFromRunId}:{}),...(settledCQImportRef?{settled_cq_import_ref:settledCQImportRef}:{}),...(buildFlowPolicy?{build_flow_policy:buildFlowPolicy}:{}),...(settledSemanticImportRef?{settled_semantic_import_ref:settledSemanticImportRef}:{}),...(selectedFamilyPolicy?{family_policy:selectedFamilyPolicy}:{}),...(executionPolicy?{execution_policy:executionPolicy}:{}),...(resumeFromRunId?{resume_from_run_id:resumeFromRunId}:{}),...(stopAfter?{stop_after:stopAfter}:{}),...(allowFormatRepairOnce?{allow_format_repair_once:true}:{}),...(reuseCQFamilyFromRunId?{reuse_cq_family_from_run_id:reuseCQFamilyFromRunId}:{}),...(reuseExtractionFromRunId?{reuse_extraction_from_run_id:reuseExtractionFromRunId}:{}),...(reuseCQFromRunId?{reuse_cq_from_run_id:reuseCQFromRunId,acknowledge_unknown:acknowledgeUnknown}:{}),...(reuseCQDraftsFromRunId?{reuse_cq_drafts_from_run_id:reuseCQDraftsFromRunId}:{}),...(rebuildSavedProposalsFromRunId?{rebuild_saved_proposals_from_run_id:rebuildSavedProposalsFromRunId}:{}),...(reuseSemanticFromRunId?{reuse_semantic_from_run_id:reuseSemanticFromRunId,...(acknowledgeUnknown?{acknowledge_unknown:true,unknown_acknowledgement_ref:unknownAcknowledgementRef}:{})}:{}),...(reuseOrganizationDraftFromRunId?{reuse_organization_draft_from_run_id:reuseOrganizationDraftFromRunId,...(acknowledgeUnknown?{acknowledge_unknown:true,unknown_acknowledgement_ref:unknownAcknowledgementRef}:{})}:{})});
      if(prior){need(prior.digest===digest,'NATIVE_REQUEST_CONFLICT');return {...await this.status({libraryId,runId:prior.run_id}),idempotent:true};}
      const draftUpstream=reuseCQDraftsFromRunId?rowFor(libraryId,reuseCQDraftsFromRunId):null;
      const confirmedDrafts=draftUpstream?prepareNativeProductConfirmedCQDrafts({store,catalog,libraryId,snapshotId:draftUpstream.snapshot_id,upstreamRunId:reuseCQDraftsFromRunId}):null;
      const cqUpstream=reuseCQFromRunId?rowFor(libraryId,reuseCQFromRunId):null;
      const confirmedCQ=cqUpstream?prepareNativeProductConfirmedCQ({store,catalog,libraryId,snapshotId:cqUpstream.snapshot_id,upstreamRunId:reuseCQFromRunId,acknowledgeUnknown}):null;
      const permitsHold=r=>Boolean(confirmedCQ&&acknowledgeUnknown&&r.run_id===reuseCQFromRunId||(reuseSemanticFromRunId||reuseOrganizationDraftFromRunId)&&acknowledgeUnknown&&unknownAcknowledgementRef);
      need(heldRows(libraryId).every(permitsHold),'NATIVE_LIBRARY_UNKNOWN_HOLD');
      need(!store.listRecords(RUN).some(r=>r.library_id===libraryId&&!terminal.has(r.status)),'NATIVE_LIBRARY_RUN_ACTIVE');
      const confirmedProgressResume=resumeFromRunId?resumePlan(rowFor(libraryId,resumeFromRunId)):null;
      const settledCQImport=settledCQImportRef?readNativeSettledCQImport({store,catalog,libraryId,snapshotId:store.getRecord(LIBRARY,libraryId).snapshot_id,importRef:settledCQImportRef}):null;
      const settledImport=settledSemanticImportRef?readNativeSettledSemanticImport({store,catalog,libraryId,snapshotId:store.getRecord(LIBRARY,libraryId).snapshot_id,importRef:settledSemanticImportRef}):null;
      const semanticReuse=reuseOrganizationDraftFromRunId?prepareOrganizationDrafts(libraryId,reuseOrganizationDraftFromRunId):reuseSemanticFromRunId?prepareSemanticReuse(libraryId,reuseSemanticFromRunId):null;
      const confirmedOrganizationDrafts=semanticReuse?.organizationDrafts??null;
      const semanticAcknowledgement=semanticReuse&&acknowledgeUnknown?prepareSemanticAcknowledgement(libraryId,reuseOrganizationDraftFromRunId??reuseSemanticFromRunId,semanticReuse,unknownAcknowledgementRef):null;
      const confirmedSemanticPackages=settledImport?.semantic_packages??semanticReuse?.confirmed??null;
      const recoveryRow=recoverSimplifiedFromRunId?rowFor(libraryId,recoverSimplifiedFromRunId):null;
      const confirmedSimplifiedRecovery=recoveryRow?prepareSimplifiedRecovery({store,catalog,libraryId,snapshotId:recoveryRow.snapshot_id,upstreamRunId:recoverSimplifiedFromRunId}):null;
      const upstreamRow=reuseCQFamilyFromRunId?rowFor(libraryId,reuseCQFamilyFromRunId):null;
      const confirmedUpstream=confirmedSimplifiedRecovery?.prefix??settledCQImport?.prefix??settledImport?.prefix??confirmedProgressResume?.prefix??semanticReuse?.upstream??(upstreamRow?prepareNativeProductConfirmedUpstream({store,catalog,libraryId,snapshotId:upstreamRow.snapshot_id,upstreamRunId:reuseCQFamilyFromRunId}):null);
      const confirmedExtraction=reuseExtractionFromRunId?prepareNativeProductConfirmedExtraction({store,catalog,libraryId,snapshotId:upstreamRow.snapshot_id,upstreamRunId:reuseExtractionFromRunId,confirmedPrefix:confirmedUpstream}):null;
      const proposalOrigin=rebuildSavedProposalsFromRunId?rowFor(libraryId,rebuildSavedProposalsFromRunId):null;
      const confirmedProposalRebuild=proposalOrigin?prepareNativeProductConfirmedProposalRebuild({store,catalog,libraryId,snapshotId:proposalOrigin.snapshot_id,upstreamRunId:rebuildSavedProposalsFromRunId}):null;
      const configured=config()??{};need(confirmedProposalRebuild||typeof configured?.upstream==='function','NATIVE_GENERATION_NOT_CONFIGURED');
      if(capability!=='LEXICAL')need(typeof configured?.embed==='function'&&configured?.embeddingSpace,'NATIVE_EMBEDDING_NOT_CONFIGURED');
      const current=registration({libraryId}),runId='nrun_'+randomUUID().replaceAll('-','');
      const factory=await loadFactory();
      const extractionReviewPolicy=!buildFlowPolicy&&!stopAfter&&!confirmedProposalRebuild?'LOCAL_REVIEW_ONCE_V1':null;
      const extractionStagePolicy=!buildFlowPolicy&&!stopAfter&&!confirmedProposalRebuild&&!confirmedExtraction?'SEMANTIC_THEN_ORGANIZE_V1':null;
      const organizationRelationReviewPolicy=extractionStagePolicy&&extractionReviewPolicy?'INDEPENDENT_RELATION_REVIEW_V1':null;
      const generalKnowledgePolicy=executionPolicy&&!stopAfter&&!confirmedProposalRebuild&&!confirmedExtraction?GENERAL_KNOWLEDGE_POLICY:null,libraryKnowledgePolicy=generalKnowledgePolicy?'LIBRARY_KNOWLEDGE_V1':null;
      const row={run_id:runId,...(recoverSimplifiedFromRunId?{simplified_recovery_from_run_id:recoverSimplifiedFromRunId}:{}),...(settledCQImportRef?{settled_cq_import_ref:settledCQImportRef}:{}),...(buildFlowPolicy?{build_flow_policy:buildFlowPolicy}:{}),...(selectedFamilyPolicy?{family_policy:selectedFamilyPolicy}:{}),...(settledImport?{settled_semantic_import_ref:settledSemanticImportRef,imported_settled_from_run_id:settledImport.source_run_id,execution_mode:'IMPORT_SETTLED_SEMANTIC_V1'}:{}),...(generalKnowledgePolicy?{general_knowledge_policy:generalKnowledgePolicy,library_knowledge_policy:libraryKnowledgePolicy}:{}),library_id:libraryId,snapshot_id:current.snapshot_id,source_epoch:current.source_epoch,build_mode:NATIVE_BUILD_MODE,status:'STARTING',capability,limits:clone(effectiveLimits),...(executionPolicy?{execution_policy:executionPolicy}:{}),...(confirmedProgressResume?{resume_from_run_id:resumeFromRunId,execution_mode:'PROGRESS_RESUME_V1',resume_summary:clone(confirmedProgressResume.summary)}:{}),allow_format_repair_once:allowFormatRepairOnce,...(extractionStagePolicy?{extraction_stage_policy:extractionStagePolicy}:{}),...(extractionReviewPolicy?{extraction_review_policy:extractionReviewPolicy}:{}),...(stopAfter?{stop_after:stopAfter}:{}),...(confirmedProposalRebuild?{rebuild_saved_proposals_from_run_id:rebuildSavedProposalsFromRunId,execution_mode:'PROGRAM_RENORMALIZE_SAVED_PROPOSALS'}:{}),...(confirmedDrafts?{reuse_cq_drafts_from_run_id:reuseCQDraftsFromRunId,execution_mode:'REUSE_CONFIRMED_CQ_DRAFTS'}:{}),...(confirmedCQ?{reuse_cq_from_run_id:reuseCQFromRunId,acknowledge_unknown:acknowledgeUnknown,execution_mode:'REUSE_CONFIRMED_CQ_ONLY'}:{}),...(confirmedUpstream&&!settledImport&&!settledCQImport?{reuse_cq_family_from_run_id:confirmedUpstream.upstream_run_id,execution_mode:'REUSE_CONFIRMED_CQ_FAMILY'}:{}),...(confirmedExtraction?{reuse_extraction_from_run_id:reuseExtractionFromRunId}:{}),...(confirmedSemanticPackages&&!settledImport?{reuse_semantic_from_run_id:confirmedSemanticPackages.upstream_run_id,execution_mode:'REUSE_CONFIRMED_SEMANTIC_PACKAGES'}:{}),created_at:Date.now()};
      if(semanticAcknowledgement)Object.assign(row,{acknowledge_unknown:true,unknown_acknowledgement_ref:unknownAcknowledgementRef});
      if(confirmedOrganizationDrafts)Object.assign(row,{reuse_organization_draft_from_run_id:confirmedOrganizationDrafts.upstream_run_id,execution_mode:'REUSE_CONFIRMED_ORGANIZATION_DRAFTS',organization_draft_validation_sha256:hash(confirmedOrganizationDrafts),organization_draft_knowledge_count:confirmedOrganizationDrafts.windows.reduce((n,w)=>n+w.knowledge_count,0)});
      if(confirmedProgressResume){row.execution_mode='PROGRESS_RESUME_V1';if(confirmedProgressResume.resume_scope)row.resume_scope=confirmedProgressResume.resume_scope;}
      if(organizationRelationReviewPolicy)Object.assign(row,{organization_relation_review_policy:organizationRelationReviewPolicy,relation_review_skill_paths:clone(relationReviewSkillPaths)});
      let chain,duplicate;
      store.transaction(()=>{
        const already=store.getRecord(REQUEST,requestKey);if(already){need(already.digest===digest,'NATIVE_REQUEST_CONFLICT');duplicate=already.run_id;return;}
        need(heldRows(libraryId).every(permitsHold),'NATIVE_LIBRARY_UNKNOWN_HOLD');
        need(!store.listRecords(RUN).some(r=>r.library_id===libraryId&&!terminal.has(r.status)),'NATIVE_LIBRARY_RUN_ACTIVE');
        if(confirmedProgressResume)need(hash(resumePlan(rowFor(libraryId,resumeFromRunId)))===hash(confirmedProgressResume),'NATIVE_RESUME_PLAN_CHANGED');
        if(confirmedUpstream&&!confirmedSimplifiedRecovery)need(hash(confirmedUpstream)===hash(settledCQImport?readNativeSettledCQImport({store,catalog,libraryId,snapshotId:current.snapshot_id,importRef:settledCQImportRef}).prefix:settledImport?readNativeSettledSemanticImport({store,catalog,libraryId,snapshotId:current.snapshot_id,importRef:settledSemanticImportRef}).prefix:prepareNativeProductConfirmedUpstream({store,catalog,libraryId,snapshotId:current.snapshot_id,upstreamRunId:resumeFromRunId??reuseOrganizationDraftFromRunId??reuseSemanticFromRunId??reuseCQFamilyFromRunId})),'NATIVE_REUSE_UPSTREAM_CHANGED');
        if(confirmedSemanticPackages&&!settledImport)need(hash(semanticReuse)===hash(reuseOrganizationDraftFromRunId?prepareOrganizationDrafts(libraryId,reuseOrganizationDraftFromRunId):prepareSemanticReuse(libraryId,reuseSemanticFromRunId)),'NATIVE_SEMANTIC_REUSE_CHANGED');
        if(semanticAcknowledgement)need(hash(semanticAcknowledgement)===hash(prepareSemanticAcknowledgement(libraryId,reuseOrganizationDraftFromRunId??reuseSemanticFromRunId,semanticReuse,unknownAcknowledgementRef)),'NATIVE_UNKNOWN_ACKNOWLEDGEMENT_CHANGED');
        if(confirmedProposalRebuild)need(hash(confirmedProposalRebuild)===hash(prepareNativeProductConfirmedProposalRebuild({store,catalog,libraryId,snapshotId:current.snapshot_id,upstreamRunId:rebuildSavedProposalsFromRunId})),'NATIVE_REUSE_UPSTREAM_CHANGED');
        if(confirmedDrafts)need(hash(confirmedDrafts)===hash(prepareNativeProductConfirmedCQDrafts({store,catalog,libraryId,snapshotId:current.snapshot_id,upstreamRunId:reuseCQDraftsFromRunId})),'NATIVE_REUSE_UPSTREAM_CHANGED');
        if(confirmedCQ)need(hash(confirmedCQ)===hash(prepareNativeProductConfirmedCQ({store,catalog,libraryId,snapshotId:current.snapshot_id,upstreamRunId:reuseCQFromRunId,acknowledgeUnknown})),'NATIVE_REUSE_UPSTREAM_CHANGED');
        if(confirmedExtraction)need(hash(confirmedExtraction)===hash(prepareNativeProductConfirmedExtraction({store,catalog,libraryId,snapshotId:current.snapshot_id,upstreamRunId:reuseExtractionFromRunId,confirmedPrefix:confirmedUpstream})),'NATIVE_REUSE_UPSTREAM_CHANGED');
        if(confirmedSimplifiedRecovery)need(hash(confirmedSimplifiedRecovery)===hash(prepareSimplifiedRecovery({store,catalog,libraryId,snapshotId:current.snapshot_id,upstreamRunId:recoverSimplifiedFromRunId})),'NATIVE_SIMPLIFIED_RECOVERY_CHANGED');
        chain=factory({store,catalog,libraryId,snapshotId:current.snapshot_id,runId,...(settledCQImportRef?{settledCQImportRef}:{}),...(buildFlowPolicy?{buildFlowPolicy}:{}),settledSemanticImportRef,familyPolicy:selectedFamilyPolicy,limits:effectiveLimits,executionPolicy,generalKnowledgePolicy,libraryKnowledgePolicy,confirmedProgressResume,formatRepairPolicy:repairPolicy(row),generationBinding:confirmedProposalRebuild?null:configured.generation??null,cqChunkOptions:{documentStorage},stopAfter,
          ...(temporalPublicationPort?{temporalPublicationPort}:{}),
          ...(confirmedOrganizationDrafts?{confirmedOrganizationDrafts}:{}),...(confirmedSemanticPackages?{confirmedSemanticPackages}:{}),...(extractionStagePolicy?{extractionStagePolicy,semanticSkillPaths,organizationSkillPaths}:{}),...(organizationRelationReviewPolicy?{organizationRelationReviewPolicy,relationReviewSkillPaths}:{}),...(extractionReviewPolicy?{extractionReviewPolicy}:{}),...(confirmedProposalRebuild?{confirmedProposalRebuild}:{}),...(confirmedDrafts?{confirmedDrafts}:{}),...(confirmedSimplifiedRecovery?{confirmedSimplifiedRecovery}:{}),...(confirmedCQ?{confirmedCQ}:{}),...(confirmedUpstream?{confirmedUpstream}:{}),...(confirmedExtraction?{confirmedExtraction}:{}),...(configured.agentRunner?{agentRunner:configured.agentRunner}:{}),...(configured.embed?{embed:configured.embed,embeddingSpace:configured.embeddingSpace}:{})});
        if(confirmedProgressResume)store.putRecord('native_product_progress_resume_v1',runId,{run_id:runId,resume_from_run_id:resumeFromRunId,confirmed:clone(confirmedProgressResume),confirmation_sha256:hash(confirmedProgressResume)});
        if(confirmedOrganizationDrafts){const receipt={version:'PRODUCT_CONFIRMED_ORGANIZATION_DRAFTS_V1',run_id:runId,library_id:libraryId,source_snapshot_ref:current.snapshot_id,origin_run_id:confirmedOrganizationDrafts.upstream_run_id,confirmed:clone(confirmedOrganizationDrafts),validation_sha256:hash(confirmedOrganizationDrafts),created_at:row.created_at};store.putRecord('native_product_organization_draft_reuse_v1',runId,{...receipt,record_sha256:hash(receipt)});}
        if(semanticAcknowledgement){const receipt={...semanticAcknowledgement,run_id:runId,request_id:requestId,created_at:row.created_at};store.putRecord(UNKNOWN_ACK,runId,{...receipt,record_sha256:hash(receipt)});}
        persist(row);store.putRecord(REQUEST,requestKey,{digest,run_id:runId});
      });
      if(duplicate)return {...await this.status({libraryId,runId:duplicate}),idempotent:true};
      const handle={chain,promise:null};live.set(runId,handle);onOperation(1);
      handle.promise=(async()=>{
        try{
          persist({...row,status:'RUNNING'});
          await chain.run({runtimeDirectory:resolve(runtimeDirectory,runId),upstream:configured.upstream,capability});
          const snapshot=chain.snapshot(),status=snapshot.run?.status??snapshot.status??'BLOCKED';
          persist({...row,status:terminal.has(status)?status:'BLOCKED',reason:snapshot.run?.reason??snapshot.error?.code??(terminal.has(status)?null:'NATIVE_CHAIN_COMPLETION_UNCONFIRMED'),ended_at:Date.now()});
        }catch(error){const s=chain.snapshot(),status=s.run?.status??s.status;persist({...row,status:terminal.has(status)?status:'FAILED',reason:error.code??'NATIVE_CHAIN_FAILED',ended_at:Date.now()});}
        finally{onOperation(-1);}
      })();
      return {run_id:runId,library_id:libraryId,status:'STARTING',build_mode:NATIVE_BUILD_MODE,snapshot_id:current.snapshot_id,...(settledImport?{settled_semantic_import_ref:settledSemanticImportRef,imported_settled_from_run_id:settledImport.source_run_id,execution_mode:'IMPORT_SETTLED_SEMANTIC_V1'}:{}),...(selectedFamilyPolicy?{family_policy:selectedFamilyPolicy}:{}),...(executionPolicy?{execution_policy:executionPolicy}:{}),...(confirmedProgressResume?{resume_from_run_id:resumeFromRunId,resume_summary:confirmedProgressResume.summary}:{}),allow_format_repair_once:allowFormatRepairOnce,...(stopAfter?{stop_after:stopAfter}:{}),...(confirmedProposalRebuild?{rebuild_saved_proposals_from_run_id:rebuildSavedProposalsFromRunId,execution_mode:'PROGRAM_RENORMALIZE_SAVED_PROPOSALS'}:{}),...(confirmedDrafts?{reuse_cq_drafts_from_run_id:reuseCQDraftsFromRunId,execution_mode:'REUSE_CONFIRMED_CQ_DRAFTS'}:{}),...(confirmedCQ?{reuse_cq_from_run_id:reuseCQFromRunId,acknowledge_unknown:acknowledgeUnknown,execution_mode:'REUSE_CONFIRMED_CQ_ONLY'}:{}),...(confirmedUpstream&&!settledImport&&!settledCQImport?{reuse_cq_family_from_run_id:confirmedUpstream.upstream_run_id,execution_mode:'REUSE_CONFIRMED_CQ_FAMILY'}:{}),...(confirmedExtraction?{reuse_extraction_from_run_id:reuseExtractionFromRunId}:{}),...(confirmedSemanticPackages&&!settledImport?{reuse_semantic_from_run_id:confirmedSemanticPackages.upstream_run_id,execution_mode:'REUSE_CONFIRMED_SEMANTIC_PACKAGES'}:{}),...(confirmedOrganizationDrafts?{reuse_organization_draft_from_run_id:confirmedOrganizationDrafts.upstream_run_id,execution_mode:'REUSE_CONFIRMED_ORGANIZATION_DRAFTS',organization_draft_knowledge_count:row.organization_draft_knowledge_count,organization_draft_validation_sha256:row.organization_draft_validation_sha256}:{}),...(semanticAcknowledgement?{acknowledge_unknown:true,unknown_acknowledgement_ref:unknownAcknowledgementRef}:{}),...(confirmedProgressResume?{execution_mode:'PROGRESS_RESUME_V1'}:{})};
    },
    libraryReview({libraryId,runId,revisionRef}){
      const row=rowFor(libraryId,runId),current=store.getRecord('native_library_knowledge_active_v1',libraryId),review=listNativeLibraryReview({store,catalog,libraryId,snapshotId:row.snapshot_id,runId,revisionRef,currentRevisionRef:current?.revision_ref});
      return pendingAnalysis.annotate(review,store.getRecord('native_library_knowledge_revision_v1',review.revision_ref));
    },
    libraryReviewAnalysis(args){
      rowFor(args.libraryId,args.runId);return pendingAnalysis.status(args);
    },
    analyzeLibraryReview(args){
      const row=rowFor(args.libraryId,args.runId);need(!closed,'NATIVE_PRODUCT_CLOSED');need(isCurrent(row),'NATIVE_SOURCE_STALE');
      need(!store.listRecords(RUN).some(value=>value.library_id===args.libraryId&&!terminal.has(value.status)),'NATIVE_LIBRARY_RUN_ACTIVE');
      return pendingAnalysis.start(args);
    },
    previewLibraryReview({libraryId,runId,revisionRef}){
      const row=rowFor(libraryId,runId),current=store.getRecord('native_library_knowledge_active_v1',libraryId);
      return prepareNativeLibraryReviewApplication({store,catalog,libraryId,snapshotId:row.snapshot_id,runId,revisionRef,currentRevisionRef:current?.revision_ref});
    },
    decideLibraryReview({libraryId,runId,revisionRef,requestId,itemRef,action,reason,correction,definitionResolution}){
      const row=rowFor(libraryId,runId);need(isCurrent(row),'NATIVE_SOURCE_STALE');need(!store.listRecords(RUN).some(r=>r.library_id===libraryId&&!terminal.has(r.status)),'NATIVE_LIBRARY_RUN_ACTIVE');const current=store.getRecord('native_library_knowledge_active_v1',libraryId);
      return submitNativeLibraryReview({store,catalog,libraryId,snapshotId:row.snapshot_id,runId,revisionRef,currentRevisionRef:current?.revision_ref,requestId,itemRef,action,reason,...(correction===undefined?{}:{correction}),...(definitionResolution===undefined?{}:{definitionResolution})});
    },
    async applyLibraryReview({libraryId,runId,revisionRef,requestId,applicationRef}){
      const sourceRow=rowFor(libraryId,runId);need(!closed,'NATIVE_PRODUCT_CLOSED');const requestKey=hash([libraryId,requestId]),digest=hash({operation:LIBRARY_APPLICATION_MODE,source_run_id:runId,revision_ref:revisionRef,...(applicationRef===undefined?{}:{application_ref:applicationRef})}),prior=store.getRecord(REQUEST,requestKey);if(prior){need(prior.digest===digest,'NATIVE_REQUEST_CONFLICT');return {...await this.status({libraryId,runId:prior.run_id}),idempotent:true};}
      need(isCurrent(sourceRow),'NATIVE_SOURCE_STALE');need(!heldRows(libraryId).length,'NATIVE_LIBRARY_UNKNOWN_HOLD');need(!store.listRecords(RUN).some(r=>r.library_id===libraryId&&!terminal.has(r.status)),'NATIVE_LIBRARY_RUN_ACTIVE');const activeRevision=store.getRecord('native_library_knowledge_active_v1',libraryId),application=prepareNativeLibraryReviewApplication({store,catalog,libraryId,snapshotId:sourceRow.snapshot_id,runId,revisionRef,currentRevisionRef:activeRevision?.revision_ref}),targetRunId='nrun_'+randomUUID().replaceAll('-','');
      need(applicationRef===undefined||applicationRef===application.application_ref,'NATIVE_LIBRARY_REVIEW_APPLICATION_STALE');
      const embeddingRuntime=sourceRow.capability==='LEXICAL'?{}:(modelRuntime?.()??product.nativeEmbeddingRuntime?.()??config()??{});
      const row={run_id:targetRunId,library_id:libraryId,snapshot_id:sourceRow.snapshot_id,source_epoch:sourceRow.source_epoch,build_mode:NATIVE_BUILD_MODE,status:'STARTING',capability:sourceRow.capability,execution_mode:LIBRARY_APPLICATION_MODE,execution_policy:PROGRESS_EXECUTION,application_ref:application.application_ref,application_source_run_id:runId,source_library_revision_ref:application.source_revision_ref,created_at:Date.now(),generation_requests:0};let chain;
      store.transaction(()=>{need(!store.getRecord(REQUEST,requestKey),'NATIVE_REQUEST_CONFLICT');need(!store.listRecords(RUN).some(r=>r.library_id===libraryId&&!terminal.has(r.status)),'NATIVE_LIBRARY_RUN_ACTIVE');chain=createNativeLibraryApplication({store,catalog,libraryId,snapshotId:row.snapshot_id,runId:targetRunId,application,capability:row.capability,embed:embeddingRuntime.embed??null,embeddingSpace:embeddingRuntime.embeddingSpace??null});persist(row);store.putRecord(REQUEST,requestKey,{digest,run_id:targetRunId});});
      const handle={chain,promise:null};live.set(targetRunId,handle);onOperation(1);handle.promise=(async()=>{try{persist({...row,status:'RUNNING'});await chain.run();const result=chain.snapshot();persist({...row,status:result.run.status,reason:result.run.reason??null,ended_at:Date.now()});}catch(error){const state=chain.snapshot();persist({...row,status:terminal.has(state.run.status)?state.run.status:'FAILED',reason:error.code??'NATIVE_LIBRARY_APPLICATION_FAILED',ended_at:Date.now()});}finally{onOperation(-1);}})();return {...publicRow(row),generation_requests:0};
    },
    savedStageRecovery({libraryId,runId}){
      const row=rowFor(libraryId,runId),confirmedPrefix=prepareNativeProductConfirmedUpstream({store,catalog,libraryId,snapshotId:row.snapshot_id,upstreamRunId:runId}),plan=prepareNativeSavedStageRecovery({store,catalog,libraryId,snapshotId:row.snapshot_id,sourceRunId:runId,confirmedPrefix});
      return {available:true,source_run_id:runId,source_snapshot_ref:row.snapshot_id,capability:plan.capability,confirmation_sha256:plan.record_sha256,summary:plan.summary,source_failure:plan.source_failure,execution_mode:SAVED_STAGE_RECOVERY_MODE};
    },
    async recoverSavedStages({libraryId,runId,requestId}){
      const sourceRow=rowFor(libraryId,runId);need(!closed,'NATIVE_PRODUCT_CLOSED');need(/^[a-f0-9-]{36}$/.test(requestId??''),'NATIVE_REQUEST_ID_REQUIRED',400);
      const requestKey=hash([libraryId,requestId]),digest=hash({operation:SAVED_STAGE_RECOVERY_MODE,source_run_id:runId}),old=store.getRecord(REQUEST,requestKey);if(old){need(old.digest===digest,'NATIVE_REQUEST_CONFLICT');return {...await this.status({libraryId,runId:old.run_id}),idempotent:true};}
      noLegacyWriter(libraryId);need(!heldRows(libraryId).length,'NATIVE_LIBRARY_UNKNOWN_HOLD');need(!store.listRecords(RUN).some(r=>r.library_id===libraryId&&!terminal.has(r.status)),'NATIVE_LIBRARY_RUN_ACTIVE');
      const validateSource=()=>prepareNativeSavedStageRecovery({store,catalog,libraryId,snapshotId:sourceRow.snapshot_id,sourceRunId:runId,confirmedPrefix:prepareNativeProductConfirmedUpstream({store,catalog,libraryId,snapshotId:sourceRow.snapshot_id,upstreamRunId:runId})}),prepared=validateSource();
      // This action has no generation dependency, even when generation is unconfigured.
      const embeddingRuntime=sourceRow.capability==='LEXICAL'?{}:(product.nativeEmbeddingRuntime?.()??modelRuntime?.()??{});if(sourceRow.capability!=='LEXICAL')need(typeof embeddingRuntime.embed==='function'&&embeddingRuntime.embeddingSpace&&hash(embeddingRuntime.embeddingSpace)===hash(prepared.embedding_space),'NATIVE_EMBEDDING_NOT_CONFIGURED');
      const targetRunId='nrun_'+randomUUID().replaceAll('-',''),row={run_id:targetRunId,library_id:libraryId,snapshot_id:sourceRow.snapshot_id,source_epoch:sourceRow.source_epoch,build_mode:NATIVE_BUILD_MODE,status:'STARTING',capability:sourceRow.capability,execution_mode:SAVED_STAGE_RECOVERY_MODE,execution_policy:PROGRESS_EXECUTION,recovery_source_run_id:runId,recovery_summary:clone(prepared.summary),created_at:Date.now(),generation_requests:0};let chain;
      store.transaction(()=>{need(!store.getRecord(REQUEST,requestKey),'NATIVE_REQUEST_CONFLICT');need(!store.listRecords(RUN).some(r=>r.library_id===libraryId&&!terminal.has(r.status))&&!heldRows(libraryId).length,'NATIVE_LIBRARY_RUN_ACTIVE');need(hash(validateSource())===hash(prepared),'NATIVE_RECOVERY_INPUT_CHANGED');chain=createNativeSavedStageRecovery({store,catalog,libraryId,snapshotId:row.snapshot_id,runId:targetRunId,prepared,validateSource,embed:embeddingRuntime.embed??null,embeddingSpace:embeddingRuntime.embeddingSpace??null});persist(row);store.putRecord(REQUEST,requestKey,{digest,run_id:targetRunId});});
      const handle={chain,promise:null};live.set(targetRunId,handle);onOperation(1);handle.promise=(async()=>{try{persist({...row,status:'RUNNING'});await chain.run();const result=chain.snapshot();persist({...row,status:result.run.status,reason:result.run.reason??null,ended_at:Date.now()});}catch(error){const result=chain.snapshot();persist({...row,status:terminal.has(result.run.status)?result.run.status:'FAILED',reason:error.code??'NATIVE_RECOVERY_FAILED',ended_at:Date.now()});}finally{onOperation(-1);}})();return publicRow(row);
    },
    async conflicts({libraryId,runId,...body}){
      const row=rowFor(libraryId,runId);need(row.build_flow_policy==='SIMPLIFIED_SOURCE_BLOCK_V1','NATIVE_CONFLICT_FLOW_REQUIRED');need(isCurrent(row),'NATIVE_SOURCE_STALE');need(['SUCCEEDED','PARTIALLY_READY'].includes(row.status),'NATIVE_CONFLICT_BUILD_NOT_SETTLED');
      const configured=['prepare','revoke'].includes(body.operation)&&row.capability!=='LEXICAL'?(product.nativeEmbeddingRuntime?.()??config()??{}):{};return createNativeSimplifiedConflictProduct({store,catalog,libraryId,runId,snapshotId:row.snapshot_id,embed:configured.embed,embeddingSpace:configured.embeddingSpace,temporalPort:temporalPublicationPort?.simplified??null}).execute(body);
    },
    async status({libraryId,runId}){
      const row=rowFor(libraryId,runId),current=isCurrent(row);let snapshot=null;
      if(!current){const saved=store.getRecord('native_full_chain_state_v1',runId),ledger=store.getRecord('native_full_run_v1',runId);snapshot=saved?{...clone(saved),run:clone(ledger),source_current:false,build:saved.build?{...clone(saved.build),source_current:false}:null,readback:saved.readback?{...clone(saved.readback),verified:false,historically_verified:saved.readback.verified===true,source_current:false}:null}:null;}
      else if(row.status==='UNKNOWN_HOLD'){
        const saved=store.getRecord('native_full_chain_state_v1',runId),ledger=store.getRecord('native_full_run_v1',runId);
        if(saved){
          const stages=store.listRecords('native_extraction_window_stage_v1').filter(s=>s.parent_run_id===runId),records=new Map();
          for(const key of [runId,...stages.map(s=>s.stage_run_id)])for(const item of store.getRecord('native_knowledge_head_v1',key)?.knowledge??[])records.set(item.record_ref??hash(item),item);
          snapshot={...clone(saved),run:clone(ledger),build:saved.input?.build_flow_policy==='SIMPLIFIED_SOURCE_BLOCK_V1'?clone(saved.build??null):store.getRecord('native_knowledge_head_v1',runId)??saved.build??null,partial_organization:{knowledge:[...records.values()],knowledge_count:records.size,parent_graph_confirmed:false},...(saved.input?.extraction_stage_policy==='SEMANTIC_THEN_ORGANIZE_V1'?{semantic_stages:snapshotNativeSemanticStages({store,runId})}:{})};
        }
      }else try{snapshot=(await controller(row)).snapshot();}catch(error){if(row.status!=='FAILED')throw error;}
      const organizationDraftImports=store.listRecords('native_organization_draft_import_v1').filter(r=>r.run_id===runId||r.run_id?.startsWith(runId+'_window_'));
      const stageIds=new Set([runId,...store.listRecords('native_extraction_window_stage_v1').filter(r=>r.parent_run_id===runId).map(r=>r.stage_run_id)]);
      // Business-only audit projection. Never expose native response, wire or reasoning bodies.
      const pick=(record,keys)=>Object.fromEntries(keys.filter(key=>record[key]!==undefined).map(key=>[key,clone(record[key])]));
      const normalizations=store.listRecords(ARGUMENT_NORMALIZATION).filter(r=>stageIds.has(r.run_id)).map(r=>pick(r,['normalization_ref','request_ref','tool_name','status','warnings','raw_arguments','normalized_arguments','raw_arguments_sha256','normalized_arguments_sha256','raw_response_sha256','derived_response_sha256','delta_count','done_copy_count','scalar_tokens_preserved','semantic_equivalence_claimed','record_sha256','item_recovery','original_items_preserved']));
      const relationReviews=store.listRecords('native_organization_relation_review_v1').filter(r=>r.run_id===runId||stageIds.has(r.stage_run_id)).map(r=>pick(r,['stage_run_id','status','warnings','gaps','retained_texts','review_completed','findings']));
      const itemRecoveries=normalizations.filter(r=>r.status==='BUSINESS_ITEMS_RECOVERED'),unknownItemCounts=normalizations.some(r=>['BUSINESS_ITEMS_RECOVERED','UNPARSED_BUSINESS_RETAINED'].includes(r.status));
      const programOutputRecovery={normalizations,relation_reviews:relationReviews,recovered_count:normalizations.filter(r=>['FORMAT_REPAIRED','BUSINESS_ITEMS_RECOVERED'].includes(r.status)).length,item_recovered_batches:itemRecoveries.length,recovered_item_count:itemRecoveries.reduce((n,r)=>n+(r.item_recovery?.recovered_count??0),0),skipped_item_count:unknownItemCounts?null:0,bad_fragment_count:normalizations.reduce((n,r)=>n+(r.item_recovery?.bad_fragment_count??0),0),unrecovered_count:normalizations.filter(r=>['UNPARSED_REVIEW_RETAINED','UNPARSED_BUSINESS_RETAINED','UNRECOVERABLE'].includes(r.status)).length,partial_review_count:relationReviews.filter(r=>['PARTIAL','PARTIAL_WARN'].includes(r.status)).length};
      const progress_summary=readNativeBuildProgress({store,row});
      return {...publicRow(row),progress_summary,partial_summary:store.getRecord('native_simplified_partial_summary_v1',runId)??null,active_library_knowledge:store.getRecord('native_library_knowledge_active_v1',libraryId)??null,status:current?row.status:'STALE',source_current:current,snapshot:snapshot?{...snapshot,progress_summary}:null,...resumeDescription(row),reusable_cq_family:reusable(row),reusable_cq:reusableCQ(row),reusable_cq_drafts:reusableCQDrafts(row),rebuildable_proposals:rebuildableProposals(row),reusable_semantic_packages:reusableSemantic(row),semantic_recovery:semanticRecovery(libraryId),organization_draft_recovery:organizationDraftRecovery(libraryId),organization_draft_imports:organizationDraftImports,program_output_recovery:programOutputRecovery,configuration:publicConfiguration()};
    },
    cqMaterials({libraryId,runId,cqRef}){
      const row=rowFor(libraryId,runId);need(isCurrent(row),'NATIVE_SOURCE_STALE');
      return readNativeCQMaterials({store,runId,cqRef});
    },
    semanticPackage({libraryId,runId,windowRef,after=0,offset=0,maxChars=6000}){
      const row=rowFor(libraryId,runId);need(isCurrent(row),'NATIVE_SOURCE_STALE');
      need(store.getRecord('native_full_chain_state_v1',runId)?.input?.extraction_stage_policy==='SEMANTIC_THEN_ORGANIZE_V1','NATIVE_SEMANTIC_STAGE_NOT_ENABLED');
      return readNativeSemanticPackagePage({store,catalog,libraryId,snapshotId:row.snapshot_id,runId,windowRef,after,offset,max_chars:maxChars});
    },
    async graph({libraryId,runId,view}){
      const row=rowFor(libraryId,runId);need(isCurrent(row),'NATIVE_SOURCE_STALE');
      if(row.build_flow_policy==='SIMPLIFIED_SOURCE_BLOCK_V1'&&['UNKNOWN_HOLD','FAILED','STOPPED'].includes(row.status))return readNativeSimplifiedPartialGraph({store,catalog,row,view});
      need(row.status!=='UNKNOWN_HOLD','NATIVE_RUN_UNKNOWN_HOLD');
      return (await controller(row)).graph({view});
    },
    async query({libraryId,runId,...args}){
      const row=rowFor(libraryId,runId);need(isCurrent(row),'NATIVE_SOURCE_STALE');
      need(row.status!=='UNKNOWN_HOLD','NATIVE_RUN_UNKNOWN_HOLD');
      return (await controller(row)).query(args);
    },
    async whenIdle(){await Promise.allSettled([...live.values()].map(h=>h.promise));await pendingAnalysis.waitForIdle();},
    async close(){closed=true;await this.whenIdle();}
  };
}
