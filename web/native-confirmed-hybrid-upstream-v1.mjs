/** Confirm saved Hybrid CQ/family provenance without constructing a controller. */
import {hash,clone,need,textField} from './cq-discovery-store-v2.mjs';
import {prepareNativeProductConfirmedCQDrafts} from './native-confirmed-cq-drafts-reuse-v1.mjs';
import {createNativeFamilyInput,normalizeNativeFamilyOutput,validateNativeFamilyOutput,materializeNativeFamilyRefs} from './native-family-input-adapter-v1.mjs';

const check=(ok,suffix)=>need(ok,'NATIVE_HYBRID_UPSTREAM_'+suffix);
const unique=a=>Array.isArray(a)&&new Set(a).size===a.length;
const immutable=(store,kind,id)=>{const value=store.getRecord(kind,id),{record_sha256,...body}=value??{};check(value&&record_sha256===hash(body),'RECORD_CHANGED');return value;};

/** Only front-stage records are required; old knowledge/graph/index is irrelevant. */
export function prepareNativeProductConfirmedHybridUpstream({store,catalog,libraryId,snapshotId,upstreamRunId}){
 const row=store.getRecord('native_product_run_v1',upstreamRunId),state=store.getRecord('native_full_chain_state_v1',upstreamRunId),ledger=store.getRecord('native_full_run_v1',upstreamRunId);
 check(row?.run_id===upstreamRunId&&row.library_id===libraryId&&row.snapshot_id===snapshotId&&state?.run_id===upstreamRunId&&state.library_id===libraryId&&state.snapshot_id===snapshotId&&ledger?.run_id===upstreamRunId,'SOURCE_MISMATCH');
 check((['FAILED','SUCCEEDED','PARTIALLY_READY'].includes(row.status)||row.status==='STOPPED'&&state.input?.extraction_stage_policy==='SEMANTIC_THEN_ORGANIZE_V1')&&ledger.status===row.status&&Number.isFinite(row.ended_at)&&Number.isFinite(ledger.ended_at),'RUN_NOT_SETTLED');
 check(ledger.attempts?.length>0&&unique(ledger.attempts.map(a=>a.request_ref))&&ledger.attempts.every(a=>a.outcome==='RETURNED'),'REQUEST_UNCONFIRMED');
 check(catalog.isCurrent(snapshotId,libraryId),'SOURCE_STALE');
 const source=catalog.get(snapshotId,libraryId),input=state.input;
 check(source.documents?.length>0&&source.documents.every(d=>d.parser?.name==='docling'&&d.blocks?.length),'DOCLING_REQUIRED');
 check(input?.knowledge_build_policy==='EXTRACT_AND_INDEX_V1'&&['DOCLING_HYBRID_CQ_V1','DOCLING_STRUCTURE_CQ_V2'].includes(input.cq_chunk_policy?.version)&&hash(input)===hash(ledger.input)&&ledger.binding===hash({input,limits:ledger.limits})&&hash(state.limits)===hash(ledger.limits)&&input.library_ref===libraryId&&input.source_snapshot_ref===snapshotId&&input.source_fingerprint===source.fingerprint&&row.source_epoch===source.source_epoch,'INPUT_CHANGED');
 const cq=state.cq_input,familyInput=state.family_input,families=state.families;
 check(cq?.run_id===upstreamRunId&&cq.source_snapshot_ref===snapshotId&&cq.items?.length>0&&unique(cq.items.map(q=>q.cq_ref))&&families?.families?.length>0&&familyInput?.input_ref===families.input_ref,'OUTPUTS_REQUIRED');
 const sourceRefs=refs=>Array.isArray(refs)&&refs.length>0&&refs.every(r=>source.documents.some(d=>d.doc_id===r.doc_ref&&d.revision===r.revision));
 check(cq.items.every(q=>textField(q.question)&&sourceRefs(q.source_refs)),'CQ_CHANGED');
 const planRecord=immutable(store,'native_chunked_cq_plan_v1',upstreamRunId),plan=planRecord.plan;
 const chunked=store.getRecord('native_chunked_cq_state_v1',upstreamRunId),merge=immutable(store,'native_cq_chunk_merge_v1',upstreamRunId);
 const windows=plan?.windows??plan?.chunks;
 check(planRecord.run_id===upstreamRunId&&planRecord.source_snapshot_ref===snapshotId&&plan?.source_snapshot_ref===snapshotId&&plan.source_fingerprint===source.fingerprint&&Array.isArray(windows)&&windows.length>0&&unique(windows.map(w=>w.chunk_ref))&&windows.every(w=>source.documents.some(d=>d.doc_id===w.doc_ref&&d.revision===w.revision)),'PLAN_CHANGED');
 check(chunked?.run_id===upstreamRunId&&chunked.library_id===libraryId&&chunked.source_snapshot_ref===snapshotId&&chunked.status==='COMPLETED'&&Number.isFinite(chunked.ended_at)&&chunked.plan_ref===plan.plan_ref&&hash(chunked.cq_input)===hash(cq)&&hash(chunked.result?.cq_input)===hash(cq)&&['COMPLETE','PARTIAL'].includes(chunked.scan_status)&&chunked.chunks?.length===windows.length,'CQ_CHANGED');
 check(merge.run_id===upstreamRunId&&merge.source_snapshot_ref===snapshotId&&merge.plan_ref===plan.plan_ref&&hash(merge.cq_input)===hash(cq)&&cq.input_ref==='native_cq_input_'+hash([chunked.binding,merge.mode,merge.raw_proposal]),'MERGE_CHANGED');
 const actors=store.listRecords('native_agent_invocation_v1').filter(a=>a.run_id===upstreamRunId),copies=state.invocations??[];
 const actor=(role,scope=null,ref=null)=>{
  const found=actors.filter(a=>a.role===role&&(scope===null||a.agent_scope===scope)&&(ref===null||a.invocation_ref===ref));
  check(found.length===1,'ACTOR_UNCONFIRMED');const a=found[0],copy=copies.find(c=>c.invocation_ref===a.invocation_ref);
  check(a.origin==='CODEX_NATIVE_APP_SERVER'&&a.status==='SUCCEEDED'&&a.outcome==='RETURNED'&&Number.isFinite(a.ended_at)&&copy?.status===a.status&&copy.outcome==='RETURNED'&&copy.role===role&&copy.origin===a.origin&&hash(copy.request_refs)===hash(a.request_refs)&&unique(a.request_refs)&&a.request_refs.length>0&&a.request_refs.every(ref=>ledger.attempts.some(r=>r.request_ref===ref&&r.kind==='GENERATION'&&r.role===role&&r.outcome==='RETURNED'&&(scope===null||r.agent_scope===scope))),'ACTOR_UNCONFIRMED');
  return a;
 };
 let retained=null,draftOrigin=null;
 if(input.confirmed_cq_drafts_sha256){
  draftOrigin=state.upstream_origin?.run_id;
  check(state.upstream_origin?.mode==='EXPLICITLY_IMPORTED_CONFIRMED_CQ_DRAFTS'&&textField(draftOrigin)&&draftOrigin!==upstreamRunId,'DRAFT_ORIGIN_CHANGED');
  retained=prepareNativeProductConfirmedCQDrafts({store,catalog,libraryId,snapshotId,upstreamRunId:draftOrigin});
  check(hash(retained)===input.confirmed_cq_drafts_sha256&&hash(retained.hybrid_plan)===hash(plan),'DRAFT_ORIGIN_CHANGED');
 }
 const drafts=[];
 for(const window of windows){
  const chunk=chunked.chunks.find(c=>c.chunk_ref===window.chunk_ref),d=immutable(store,'native_cq_chunk_draft_v1',upstreamRunId+':'+window.chunk_ref),r=immutable(store,'native_cq_chunk_read_receipt_v1',d.read_receipt_ref);
  check(chunk?.status==='RETURNED'&&chunk.outcome==='RETURNED'&&d.run_id===upstreamRunId&&d.source_snapshot_ref===snapshotId&&d.chunk_ref===window.chunk_ref&&d.doc_ref===window.doc_ref&&d.revision===window.revision&&Array.isArray(d.items),'DRAFT_CHANGED');
  check(r.run_id===upstreamRunId&&r.source_snapshot_ref===snapshotId&&r.chunk_ref===window.chunk_ref&&r.read_receipt_ref===d.read_receipt_ref&&r.material_sha256===hash(window.contextualized_text)&&hash(r.source_ref)===hash({doc_ref:window.doc_ref,revision:window.revision})&&d.items.every(q=>textField(q.question)&&sourceRefs(q.source_refs)&&q.read_receipt_refs?.includes(r.read_receipt_ref)),'READ_RECEIPT_CHANGED');
  if(retained){
   const original=retained.drafts.find(o=>o.chunk_ref===window.chunk_ref)?.draft;
   check(original&&d.reuse_origin?.run_id===draftOrigin&&d.reuse_origin.chunk_ref===window.chunk_ref&&d.reuse_origin.record_sha256===original.record_sha256&&hash(d.reuse_origin.origin_cq_refs)===hash(original.items.map(q=>q.cq_ref))&&hash(d.raw_proposal)===hash(original.raw_proposal)&&d.items.length===original.items.length&&d.items.every((q,i)=>hash({question:q.question,notes:q.notes??null,source_hint:q.source_hint??null,source_refs:q.source_refs})===hash({question:original.items[i].question,notes:original.items[i].notes??null,source_hint:original.items[i].source_hint??null,source_refs:original.items[i].source_refs}))&&r.delivery==='HOST_REUSED_RETAINED_CQ_DRAFT'&&r.origin_run_id===draftOrigin&&r.origin_read_receipt_ref===original.read_receipt_ref,'DRAFT_ORIGIN_CHANGED');
  }else{
   check(!d.reuse_origin&&r.delivery!=='HOST_REUSED_RETAINED_CQ_DRAFT'&&chunk.receipt?.invocation_ref,'DRAFT_ORIGIN_CHANGED');
   const a=actor('CQ',window.chunk_ref,chunk.receipt.invocation_ref);
   check(chunk.receipt.status===a.status&&hash(chunk.receipt.request_refs)===hash(a.request_refs),'ACTOR_UNCONFIRMED');
  }
  drafts.push(...d.items.map(q=>({item:q,chunk_ref:window.chunk_ref})));
 }
 // Number after flattening, matching the saved merge's canonical draft order.
 const numbered=drafts.map((d,i)=>({...d,draft_ref:'draft_'+String(i+1).padStart(4,'0')}));
 check(hash(merge.drafts)===hash(numbered.map(d=>({draft_ref:d.draft_ref,origin_cq_ref:d.item.cq_ref,chunk_ref:d.chunk_ref})))&&merge.mapping?.length===cq.items.length&&unique(merge.mapping.map(m=>m.cq_ref)),'MERGE_CHANGED');
 const mapped=new Set();
 for(const m of merge.mapping){const q=cq.items.find(q=>q.cq_ref===m.cq_ref),origins=(m.source_draft_refs??[]).map(ref=>numbered.find(d=>d.draft_ref===ref));
  check(q&&unique(m.source_draft_refs)&&origins.length>0&&origins.every(Boolean)&&origins.every(d=>!mapped.has(d.draft_ref))&&hash(m.origin_cq_refs)===hash(origins.map(d=>d.item.cq_ref))&&hash(m.origin_chunk_refs)===hash([...new Set(origins.map(d=>d.chunk_ref))])&&hash(q.source_refs)===hash([...new Map(origins.flatMap(d=>d.item.source_refs).map(r=>[hash(r),r])).values()])&&hash(q.read_receipt_refs)===hash([...new Set(origins.flatMap(d=>d.item.read_receipt_refs))]),'MERGE_CHANGED');
  origins.forEach(d=>mapped.add(d.draft_ref));
 }
 check(mapped.size===numbered.length,'MERGE_CHANGED');
 if(merge.mode==='AGENT_REFERENCE_DECISIONS')actor('CQ','cq_merge_'+hash(plan.plan_ref).slice(0,32));
 else check((['HOST_EXACT_DEDUP','HOST_DRAFT_FALLBACK'].includes(merge.mode)||merge.mode==='HOST_CONSERVATIVE_RANGE_DEDUP_V1'&&plan.policy?.range_contract==='CQ_UNIT_RANGES_V1'),'MERGE_CHANGED');
 const familyActor=actor('FAMILY');
 check(ledger.attempts.filter(a=>a.kind==='GENERATION'&&a.role==='FAMILY').every(a=>familyActor.request_refs.includes(a.request_ref)),'REQUEST_BINDING_CHANGED');
 check(hash(createNativeFamilyInput({runId:upstreamRunId,sourceSnapshotRef:snapshotId,inputs:[cq]}))===hash(familyInput),'FAMILY_INPUT_CHANGED');
 const outputs=store.listRecords('native_family_output_normalization_v1').filter(p=>p.run_id===upstreamRunId),options={knowledgeBuildPolicy:'EXTRACT_AND_INDEX_V1'};
 check(outputs.length===1&&outputs[0].input_ref===familyInput.input_ref,'FAMILIES_CHANGED');
 const normalized=normalizeNativeFamilyOutput({args:outputs[0].raw,...options}).normalized;
 check(hash(normalized)===hash(outputs[0].normalized)&&hash(materializeNativeFamilyRefs({input:familyInput,families:validateNativeFamilyOutput({input:familyInput,args:normalized,...options}),...options}))===hash(families),'FAMILIES_CHANGED');
 const artifact=(stage,payload)=>{const cp=ledger.checkpoints?.find(c=>c.stage===stage),a=cp&&store.getRecord('native_full_run_artifact_v1',cp.artifact_ref),body=a&&{run_id:a.run_id,stage:a.stage,payload:a.payload,parent_refs:a.parent_refs};check(a?.run_id===upstreamRunId&&a.stage===stage&&hash(a.payload)===hash(payload)&&a.content_hash===hash(body)&&cp.artifact_ref==='native_artifact_'+hash(body),'ARTIFACT_CHANGED');return a;};
 const cqArtifact=artifact('CQ_SAVED',cq),familyArtifact=artifact('FAMILIES_SAVED',families);
 check(cqArtifact.parent_refs.includes(ledger.checkpoints.find(c=>c.stage==='SOURCE_READY')?.artifact_ref)&&familyArtifact.parent_refs.includes(cqArtifact.artifact_ref),'ARTIFACT_CHANGED');
 return {version:'CONFIRMED_HYBRID_CQ_FAMILY_V1',upstream_run_id:upstreamRunId,source_snapshot_ref:snapshotId,cq_input:clone(cq),family_input:clone(familyInput),families:clone(families),cq_scan_status:chunked.scan_status,hybrid_plan:clone(plan),cq_origin_run_id:upstreamRunId,cq_draft_origin_run_id:draftOrigin};
}
