/** Reuse a completed family stage and its independently confirmed Hybrid CQ origin. */
import {hash,clone,need,textField} from './cq-discovery-store-v2.mjs';
import {prepareNativeProductConfirmedCQ} from './native-confirmed-cq-reuse-v1.mjs';
import {NATIVE_CHUNKED_CQ_RECORDS as K} from './native-chunked-cq-v1.mjs';
import {createNativeFamilyInput,normalizeNativeFamilyOutput,validateNativeFamilyOutput,materializeNativeFamilyRefs} from './native-family-input-adapter-v1.mjs';

const code=suffix=>'NATIVE_PREFIX_REUSE_'+suffix;
const ended=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const unique=value=>Array.isArray(value)&&new Set(value).size===value.length;
const sameSet=(a,b)=>unique(a)&&unique(b)&&hash([...a].sort())===hash([...b].sort());

/** Read-only: neither the original UNKNOWN nor any completed actor is resumed. */
export function prepareNativeProductConfirmedPrefix({store,catalog,libraryId,snapshotId,upstreamRunId}){
  const row=store.getRecord('native_product_run_v1',upstreamRunId),ledger=store.getRecord('native_full_run_v1',upstreamRunId),state=store.getRecord('native_full_chain_state_v1',upstreamRunId);
  need(row?.run_id===upstreamRunId&&row.library_id===libraryId&&row.snapshot_id===snapshotId&&ledger?.run_id===upstreamRunId&&
    state?.run_id===upstreamRunId&&state.library_id===libraryId&&state.snapshot_id===snapshotId,code('SOURCE_MISMATCH'));
  need(row.status==='SUCCEEDED'&&ledger.status==='SUCCEEDED'&&ended(row.ended_at)&&ended(ledger.ended_at)&&
    row.stop_after==='FAMILY'&&state.input?.stop_after==='FAMILY'&&ledger.summary?.completion_scope==='CQ_FAMILY_ONLY'&&
    ledger.summary.knowledge_built===false&&ledger.summary.readback_verified===false&&state.build===null&&state.readback===null,code('FRONT_STAGES_NOT_CONFIRMED'));
  need(catalog.isCurrent(snapshotId,libraryId),code('SOURCE_STALE'));
  const source=catalog.get(snapshotId,libraryId);
  need(source.library_id===libraryId&&source.snapshot_id===snapshotId&&source.documents?.length>0&&source.documents.every(d=>d.parser?.name==='docling'&&d.blocks?.length>0),code('DOCLING_REQUIRED'));
  need(hash(state.input)===hash(ledger.input)&&ledger.binding===hash({input:ledger.input,limits:ledger.limits})&&hash(state.limits)===hash(ledger.limits)&&
    row.source_epoch===source.source_epoch&&ledger.input.library_ref===libraryId&&ledger.input.source_snapshot_ref===snapshotId&&ledger.input.source_fingerprint===source.fingerprint,code('SOURCE_MISMATCH'));

  // A previously unresolved FAMILY is allowed only through this separately
  // completed, source-bound successor. No active/unknown knowledge build is.
  const productRows=store.listRecords('native_product_run_v1');
  for(const other of productRows.filter(r=>r.library_id===libraryId)){
    const run=store.getRecord('native_full_run_v1',other.run_id),attempts=run?.attempts??[];
    const knowledgeAttempt=attempts.some(a=>a.kind==='EMBEDDING'||['EXTRACTION','REVIEW','BUILD_INDEX'].includes(a.role));
    const pending=attempts.some(a=>(a.kind==='EMBEDDING'||['EXTRACTION','REVIEW','BUILD_INDEX'].includes(a.role))&&['RESERVED','UNKNOWN'].includes(a.outcome));
    need(!pending&&!(knowledgeAttempt&&['OPEN','STARTING','RUNNING','UNKNOWN_HOLD'].includes(other.status)),code('KNOWLEDGE_BUILD_UNSETTLED'));
  }
  const originRun=row.reuse_cq_from_run_id;
  need(textField(originRun)&&originRun!==upstreamRunId&&state.upstream_origin?.run_id===originRun&&
    state.upstream_origin.mode==='EXPLICITLY_IMPORTED_CONFIRMED_CQ_ONLY'&&row.execution_mode==='REUSE_CONFIRMED_CQ_ONLY',code('CQ_ORIGIN_REQUIRED'));
  const cq=state.cq_input,input=state.family_input,families=state.families;
  need(cq?.run_id===originRun&&cq.source_snapshot_ref===snapshotId&&cq.items?.length>0&&families?.families?.length>0&&
    input?.input_ref===families.input_ref&&state.cq_source_scan_status==='COMPLETE',code('OUTPUTS_REQUIRED'));
  need(hash(createNativeFamilyInput({runId:upstreamRunId,sourceSnapshotRef:snapshotId,inputs:[cq]}))===hash(input),code('FAMILY_INPUT_CHANGED'));

  const attempts=ledger.attempts;
  need(Array.isArray(attempts)&&attempts.length>0&&unique(attempts.map(a=>a.request_ref))&&
    attempts.every(a=>a.kind==='GENERATION'&&a.role==='FAMILY'&&a.outcome==='RETURNED'),code('REQUEST_UNCONFIRMED'));
  const actors=store.listRecords('native_agent_invocation_v1').filter(i=>i.run_id===upstreamRunId),copies=state.invocations??[];
  need(actors.length===1&&copies.length===1,code('FAMILY_INVOCATION_REQUIRED'));
  const actor=actors[0],copy=copies[0];
  need(actor.role==='FAMILY'&&copy.role==='FAMILY'&&actor.invocation_ref===copy.invocation_ref&&actor.origin==='CODEX_NATIVE_APP_SERVER'&&copy.origin===actor.origin&&
    actor.status==='SUCCEEDED'&&copy.status==='SUCCEEDED'&&actor.outcome==='RETURNED'&&copy.outcome==='RETURNED'&&
    ended(actor.ended_at)&&actor.ended_at===copy.ended_at&&sameSet(actor.request_refs,copy.request_refs)&&sameSet(actor.request_refs,attempts.map(a=>a.request_ref)),code('FAMILY_INVOCATION_REQUIRED'));

  const proposals=store.listRecords('native_family_output_normalization_v1').filter(p=>p.run_id===upstreamRunId);
  need(proposals.length===1&&proposals[0].input_ref===input.input_ref&&state.input.knowledge_build_policy==='EXTRACT_AND_INDEX_V1',code('FAMILIES_CHANGED'));
  const options={knowledgeBuildPolicy:'EXTRACT_AND_INDEX_V1'},normalized=normalizeNativeFamilyOutput({args:proposals[0].raw,...options}).normalized;
  need(hash(normalized)===hash(proposals[0].normalized),code('FAMILIES_CHANGED'));
  const validated=validateNativeFamilyOutput({input,args:normalized,...options});
  need(hash(materializeNativeFamilyRefs({input,families:validated,...options}))===hash(families),code('FAMILIES_CHANGED'));

  const artifact=(stage,payload)=>{
    const matches=ledger.checkpoints?.filter(c=>c.stage===stage)??[],checkpoint=matches[0];
    const value=checkpoint&&store.getRecord('native_full_run_artifact_v1',checkpoint.artifact_ref);
    const content=value&&{run_id:value.run_id,stage:value.stage,payload:value.payload,parent_refs:value.parent_refs};
    need(matches.length===1&&value?.run_id===upstreamRunId&&value.stage===stage&&hash(value.payload)===hash(payload)&&value.content_hash===hash(content)&&
      value.artifact_ref===checkpoint.artifact_ref&&checkpoint.artifact_ref==='native_artifact_'+hash(content)&&unique(value.parent_refs)&&
      value.parent_refs.every(ref=>ledger.checkpoints.some(c=>c.artifact_ref===ref)),code('ARTIFACT_CHANGED'));
    return value;
  };
  const sourceArtifact=artifact('SOURCE_READY',{snapshot_id:snapshotId,documents:source.documents.map(d=>({doc_ref:d.doc_id,revision:d.revision,parser:d.parser,warnings:d.warnings??[]}))});
  const cqArtifact=artifact('CQ_IMPORTED_CONFIRMED',{cq_input:cq,upstream_run_id:originRun});
  const familyArtifact=artifact('FAMILIES_SAVED',families);
  const complete=artifact('CQ_FAMILY_COMPLETE',{completion_scope:'CQ_FAMILY_ONLY',cq_count:cq.items.length,family_count:families.families.length});
  need(sourceArtifact.parent_refs.length===0&&cqArtifact.parent_refs.includes(sourceArtifact.artifact_ref)&&familyArtifact.parent_refs.includes(cqArtifact.artifact_ref)&&complete.parent_refs.includes(familyArtifact.artifact_ref)&&
    ledger.summary.cq_count===cq.items.length&&ledger.summary.family_count===families.families.length&&ledger.summary.source_scan_status==='COMPLETE',code('ARTIFACT_CHANGED'));

  // Only after proving the successful successor do we read the earlier CQ
  // stage with its explicit UNKNOWN acknowledgement. This never changes it.
  const confirmedCQ=prepareNativeProductConfirmedCQ({store,catalog,libraryId,snapshotId,upstreamRunId:originRun,acknowledgeUnknown:true});
  need(hash(confirmedCQ.cq_input)===hash(cq)&&state.input.confirmed_cq_sha256===hash(confirmedCQ)&&
    state.upstream_origin.prior_status===confirmedCQ.prior_status&&
    (confirmedCQ.prior_status!=='UNKNOWN_HOLD'||row.acknowledge_unknown===true),code('CQ_ORIGIN_CHANGED'));
  const retained=store.getRecord(K.plan,originRun),hybridPlan=retained?.plan;
  const {plan_sha256,...body}=hybridPlan??{};
  need(retained?.run_id===originRun&&retained.source_snapshot_ref===snapshotId&&hybridPlan?.source_snapshot_ref===snapshotId&&plan_sha256===hash(body)&&
    Array.isArray(hybridPlan.windows)&&hybridPlan.windows.length>0,code('HYBRID_PLAN_CHANGED'));
  return {version:'CONFIRMED_HYBRID_PREFIX_V1',upstream_run_id:upstreamRunId,source_snapshot_ref:snapshotId,
    cq_input:clone(cq),family_input:clone(input),families:clone(families),hybrid_plan:clone(hybridPlan),cq_origin_run_id:originRun,
    upstream_status:row.status,cq_scan_status:'COMPLETE',prior_cq_status:confirmedCQ.prior_status,
    prior_family_request_refs:clone(confirmedCQ.prior_family_request_refs)};
}
