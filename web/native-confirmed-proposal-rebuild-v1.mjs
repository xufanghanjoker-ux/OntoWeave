/** Read-only admission for renormalizing complete, returned Hybrid proposals. */
import {hash,clone,need} from './cq-discovery-store-v2.mjs';
import {prepareNativeProductConfirmedCQDrafts} from './native-confirmed-cq-drafts-reuse-v1.mjs';
import {createNativeFamilyInput,normalizeNativeFamilyOutput,validateNativeFamilyOutput,materializeNativeFamilyRefs} from './native-family-input-adapter-v1.mjs';
import {createNativeHybridExtractionWindowPlan} from './native-extraction-window-plan-v1.mjs';
import {createNativeWindowWorker} from './native-windowed-extraction-v1.mjs';
import {NATIVE_BUILD_TOOL_NAMES as N} from './native-build-host-v1.mjs';
import {domainRows} from './native-domain-knowledge-v1.mjs';

const check=(ok,suffix)=>need(ok,'NATIVE_PROPOSAL_REBUILD_'+suffix);
const immutable=(store,kind,id)=>{const row=store.getRecord(kind,id),{record_sha256,...body}=row??{};check(row&&record_sha256===hash(body),'RECORD_CHANGED');return row;};
const artifact=(store,ledger,stage,payload)=>{
 const cp=ledger.checkpoints?.find(c=>c.stage===stage),a=cp&&store.getRecord('native_full_run_artifact_v1',cp.artifact_ref);
 const body=a&&{run_id:a.run_id,stage:a.stage,payload:a.payload,parent_refs:a.parent_refs};
 check(a?.run_id===ledger.run_id&&a.stage===stage&&a.content_hash===hash(body)&&cp.artifact_ref==='native_artifact_'+hash(body)&&hash(a.payload)===hash(payload),'ARTIFACT_CHANGED');
 return a;
};

/** No controller construction, provider requests, or writes to retained records. */
export function prepareNativeProductConfirmedProposalRebuild({store,catalog,libraryId,snapshotId,upstreamRunId}){
 const row=store.getRecord('native_product_run_v1',upstreamRunId),state=store.getRecord('native_full_chain_state_v1',upstreamRunId),ledger=store.getRecord('native_full_run_v1',upstreamRunId);
 check(row?.library_id===libraryId&&row.snapshot_id===snapshotId&&state?.run_id===upstreamRunId&&state.library_id===libraryId&&state.snapshot_id===snapshotId&&ledger?.run_id===upstreamRunId,'SOURCE_MISMATCH');
 check(['SUCCEEDED','PARTIALLY_READY'].includes(row.status)&&ledger.status===row.status&&Number.isFinite(row.ended_at)&&Number.isFinite(ledger.ended_at),'RUN_NOT_SETTLED');
 check(ledger.attempts?.length>0&&ledger.attempts.every(a=>a.outcome==='RETURNED')&&new Set(ledger.attempts.map(a=>a.request_ref)).size===ledger.attempts.length,'REQUEST_UNCONFIRMED');
 check(catalog.isCurrent(snapshotId,libraryId),'SOURCE_STALE');
 const source=catalog.get(snapshotId,libraryId),input=state.input;
 check(source.documents?.length>0&&source.documents.every(d=>d.parser?.name==='docling'&&d.blocks?.length),'DOCLING_REQUIRED');
 check(input?.semantic_policy==='DOMAIN_KNOWLEDGE_V1'&&input.knowledge_build_policy==='EXTRACT_AND_INDEX_V1'&&input.extraction_window_policy?.version==='HYBRID_EXTRACTION_V1'&&hash(input)===hash(ledger.input)&&ledger.binding===hash({input,limits:ledger.limits})&&hash(state.limits)===hash(ledger.limits)&&input.source_snapshot_ref===snapshotId&&input.library_ref===libraryId&&input.source_fingerprint===source.fingerprint&&row.source_epoch===source.source_epoch,'INPUT_CHANGED');
 // This action accepts the settled Hybrid CQ path, including its explicit
 // retained-draft origin. It does not relax the older prefix-reuse gates.
 const plan=immutable(store,'native_chunked_cq_plan_v1',upstreamRunId).plan;
 const merge=immutable(store,'native_cq_chunk_merge_v1',upstreamRunId);
 const chunked=store.getRecord('native_chunked_cq_state_v1',upstreamRunId);
 check(plan.source_snapshot_ref===snapshotId&&plan.source_fingerprint===source.fingerprint&&merge.plan_ref===plan.plan_ref&&merge.run_id===upstreamRunId&&merge.source_snapshot_ref===snapshotId&&chunked?.status==='COMPLETED'&&hash(chunked.cq_input)===hash(state.cq_input)&&hash(merge.cq_input)===hash(state.cq_input),'CQ_CHANGED');
 if(input.confirmed_cq_drafts_sha256){
  const origin=state.upstream_origin?.run_id;
  const retained=prepareNativeProductConfirmedCQDrafts({store,catalog,libraryId,snapshotId,upstreamRunId:origin});
  check(hash(retained)===input.confirmed_cq_drafts_sha256&&hash(retained.hybrid_plan)===hash(plan),'CQ_ORIGIN_CHANGED');
 }
 const actors=store.listRecords('native_agent_invocation_v1').filter(a=>a.run_id===upstreamRunId);
 const copies=state.invocations??[];
 check(actors.length>0&&actors.length===copies.length&&actors.every(a=>a.origin==='CODEX_NATIVE_APP_SERVER'&&a.status==='SUCCEEDED'&&a.outcome==='RETURNED'&&Number.isFinite(a.ended_at)&&a.request_refs?.length>0&&a.request_refs.every(ref=>ledger.attempts.some(r=>r.request_ref===ref&&r.kind==='GENERATION'&&r.role===a.role&&r.outcome==='RETURNED'))&&copies.some(c=>c.invocation_ref===a.invocation_ref&&c.status===a.status&&hash(c.request_refs)===hash(a.request_refs))),'ACTOR_UNCONFIRMED');
 check(ledger.attempts.filter(a=>a.kind==='GENERATION').every(r=>actors.some(a=>a.request_refs.includes(r.request_ref))),'REQUEST_BINDING_CHANGED');
 const cq=state.cq_input,familyInput=state.family_input,families=state.families;
 check(cq?.items?.length>0&&cq.run_id===upstreamRunId&&cq.source_snapshot_ref===snapshotId&&cq.items.every(q=>q.source_refs?.length&&q.source_refs.every(r=>source.documents.some(d=>d.doc_id===r.doc_ref&&d.revision===r.revision))),'CQ_CHANGED');
 check(hash(createNativeFamilyInput({runId:upstreamRunId,sourceSnapshotRef:snapshotId,inputs:[cq]}))===hash(familyInput),'FAMILY_INPUT_CHANGED');
 const outputs=store.listRecords('native_family_output_normalization_v1').filter(p=>p.run_id===upstreamRunId),options={knowledgeBuildPolicy:'EXTRACT_AND_INDEX_V1'};
 check(outputs.length===1&&outputs[0].input_ref===familyInput.input_ref,'FAMILY_CHANGED');
 const normalized=normalizeNativeFamilyOutput({args:outputs[0].raw,...options}).normalized;
 check(hash(normalized)===hash(outputs[0].normalized)&&hash(materializeNativeFamilyRefs({input:familyInput,families:validateNativeFamilyOutput({input:familyInput,args:normalized,...options}),...options}))===hash(families),'FAMILY_CHANGED');
 const cqArtifact=artifact(store,ledger,'CQ_SAVED',cq),familyArtifact=artifact(store,ledger,'FAMILIES_SAVED',families);
 check(familyArtifact.parent_refs.includes(cqArtifact.artifact_ref),'ARTIFACT_CHANGED');
 const queue=store.getRecord('native_extraction_window_queue_v1',upstreamRunId);
 check(['COMPLETED','PARTIAL'].includes(queue?.status)&&queue.commit_complete===true&&Number.isFinite(queue.ended_at),'WINDOWS_NOT_SETTLED');
 const manifestRecord=immutable(store,'native_extraction_window_manifest_v1',queue.manifest_ref),manifest=manifestRecord.manifest;
 check(hash(manifest)===queue.manifest_sha256&&manifestRecord.manifest_sha256===queue.manifest_sha256&&manifestRecord.queue_binding===queue.binding&&hash(createNativeHybridExtractionWindowPlan({snapshot:source,hybridPlan:plan,cqInput:familyInput,familyInput,families}))===hash(manifest),'MANIFEST_CHANGED');
 const all=store.listRecords('native_knowledge_proposal_v1'),metas=store.listRecords('native_extraction_window_stage_v1').filter(m=>m.parent_run_id===upstreamRunId);
 const windows=manifest.windows.map(window=>{
  const stageRunId=upstreamRunId+'_window_'+hash(window.window_ref).slice(0,24),meta=metas.find(m=>m.stage_run_id===stageRunId);
  const actor=actors.find(a=>a.role==='EXTRACTION'&&a.agent_scope===window.window_ref),stage=store.getRecord('native_build_state_v1',stageRunId);
  check(meta?.window_ref===window.window_ref&&meta.window_sha256===hash(window)&&meta.library_id===libraryId&&meta.source_snapshot_ref===snapshotId&&actor&&stage?.extraction_complete===true,'STAGE_CHANGED');
  const proposals=all.filter(p=>p.run_id===stageRunId);
  check(proposals.length>0&&proposals.some(p=>p.name==='SUBMIT')&&proposals.every(p=>['SCOPE','SUBMIT'].includes(p.name)&&p.source_snapshot_ref===snapshotId&&p.semantic_policy==='DOMAIN_KNOWLEDGE_V1'&&p.raw_hash===hash(p.raw)&&p.proposal_ref==='knowledge_proposal_'+hash([stageRunId,p.identity,p.name])&&p.identity.invocation_ref===actor.invocation_ref&&hash(p.source_refs)===hash(window.source_refs)),'PROPOSAL_CHANGED');
  // Scope writes are safe only if no raw proposal depends on old generated IDs.
  // Current domain proposals normally have no scope. Refuse ambiguous histories.
  check(proposals.every(p=>p.name==='SUBMIT'&&p.base_scope_revision===null),'SCOPED_PROPOSALS_UNSUPPORTED');
  const ordered=[],remaining=[...proposals];let revision=null;
  while(remaining.length){const candidates=remaining.filter(p=>p.base_revision===revision);check(candidates.length===1,'PROPOSAL_ORDER_CHANGED');const p=candidates[0];ordered.push(clone(p));remaining.splice(remaining.indexOf(p),1);
   const count=domainRows(p.raw).length;check(count>0,'EMPTY_PROPOSAL');
   const receipt=store.getRecord('native_knowledge_receipt_v1',p.proposal_ref);
   check(receipt?.saved===true&&receipt.processed===true&&receipt.proposal_ref===p.proposal_ref&&receipt.received===count&&receipt.structured+receipt.text+receipt.skipped===count,'PROPOSAL_RECEIPT_MISSING');
   for(let offset=0;offset<count;offset+=16)check(store.getRecord('native_knowledge_subbatch_v1',p.proposal_ref+':'+offset)?.revision,'PROPOSAL_RECEIPT_MISSING');
   const last=store.getRecord('native_knowledge_subbatch_v1',p.proposal_ref+':'+(Math.floor((count-1)/16)*16));
   check(last?.revision,'PROPOSAL_RECEIPT_MISSING');revision=last.revision;
  }
  check(store.getRecord('native_knowledge_head_v1',stageRunId)?.revision===revision,'HEAD_CHANGED');
  return {window:clone(window),stage_run_id:stageRunId,proposals:ordered,gaps:clone(stage.gaps??[])};
 });
 check(metas.length===windows.length,'STAGE_CHANGED');
 const proposalCount=windows.reduce((n,w)=>n+w.proposals.length,0),itemCount=windows.reduce((n,w)=>n+w.proposals.reduce((m,p)=>m+domainRows(p.raw).length,0),0);
 return {version:'CONFIRMED_SAVED_PROPOSAL_REBUILD_V1',upstream_run_id:upstreamRunId,source_snapshot_ref:snapshotId,cq_input:clone(cq),family_input:clone(familyInput),families:clone(families),cq_scan_status:chunked.scan_status,hybrid_plan:clone(plan),windows,proposal_count:proposalCount,item_count:itemCount,gaps:clone(store.getRecord('native_build_state_v1',upstreamRunId)?.gaps??[]),semantic_completeness_certified:false};
}

/** Program SUBMIT of original raw objects, with fresh stage/call identities. */
export async function replayNativeConfirmedProposals({store,catalog,libraryId,snapshotId,parentRun,build,confirmed}){
 const runId=parentRun.state().run_id;
 for(const saved of confirmed.windows){
  parentRun.assertOpen();
  const local=createNativeWindowWorker({store,catalog,libraryId,snapshotId,parentRun,window:saved.window,cqInput:confirmed.family_input,families:confirmed.families,semanticPolicy:'DOMAIN_KNOWLEDGE_V1'});
  for(const p of saved.proposals){const result=await local.tools.call(N.SUBMIT,clone(p.raw),{invocation_ref:'program_proposal_rebuild_'+runId,tool_call_ref:p.proposal_ref});check(result.ok&&result.result?.saved===true,'SUBMIT_FAILED');}
  const finish=await local.tools.call(N.FINISH,{reason:'已保存的完整原始提案经当前程序重新规范化',gaps:saved.gaps});check(finish.ok,'FINISH_FAILED');
  build.ingestWindow({windowRef:saved.window.window_ref,stageRunId:local.stageRunId});
 }
 const finish=await build.call('EXTRACTION',N.FINISH,{reason:'已保存提案程序重建；语义完整性未认证',gaps:confirmed.gaps},{invocation_ref:'program_proposal_rebuild_'+runId,tool_call_ref:'finish'});
 check(finish.ok,'FINISH_FAILED');
 return {partial:confirmed.gaps.length>0};
}
