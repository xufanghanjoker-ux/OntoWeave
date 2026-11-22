/** Explicitly import saved window CQ drafts; never replay or rewrite the old run. */
import {hash,clone,need,textField} from './cq-discovery-store-v2.mjs';
import {snapshotNativeChunkedCQ,NATIVE_CHUNKED_CQ_RECORDS as K} from './native-chunked-cq-v1.mjs';

const code=suffix=>'NATIVE_CQ_DRAFT_REUSE_'+suffix;
const checked=(store,kind,key)=>{
 const row=store.getRecord(kind,key),{record_sha256,...body}=row??{};
 need(row&&record_sha256===hash(body),code('RECORD_CHANGED'));return row;
};

/** Pure read. Partial source mappings remain warnings; known saved drafts are usable. */
export function prepareNativeProductConfirmedCQDrafts({store,catalog,libraryId,snapshotId,upstreamRunId}){
 const row=store.getRecord('native_product_run_v1',upstreamRunId),ledger=store.getRecord('native_full_run_v1',upstreamRunId),state=store.getRecord('native_full_chain_state_v1',upstreamRunId);
 need(row?.run_id===upstreamRunId&&row.library_id===libraryId&&row.snapshot_id===snapshotId&&state?.library_id===libraryId&&state.snapshot_id===snapshotId&&ledger?.run_id===upstreamRunId,code('SOURCE_MISMATCH'));
 need(row.status==='FAILED'&&ledger.status===row.status&&Number.isFinite(row.ended_at)&&Number.isFinite(ledger.ended_at),code('RUN_NOT_SETTLED'));
 need(!state.cq_input,code('GLOBAL_CQ_ALREADY_SAVED'));
 need(catalog.isCurrent(snapshotId,libraryId),code('SOURCE_STALE'));
 const source=catalog.get(snapshotId,libraryId);
 need(['DOCLING_HYBRID_CQ_V1','DOCLING_STRUCTURE_CQ_V2'].includes(state.input?.cq_chunk_policy?.version)&&hash(state.input)===hash(ledger.input)&&ledger.input.source_fingerprint===source.fingerprint&&ledger.input.source_snapshot_ref===snapshotId&&row.source_epoch===source.source_epoch,code('SOURCE_MISMATCH'));
 need(Array.isArray(ledger.attempts)&&ledger.attempts.length>0&&ledger.attempts.every(a=>a.outcome==='RETURNED')&&new Set(ledger.attempts.map(a=>a.request_ref)).size===ledger.attempts.length,code('REQUEST_UNCONFIRMED'));
 const chunked=snapshotNativeChunkedCQ({store,runId:upstreamRunId}),planRecord=checked(store,K.plan,upstreamRunId),plan=planRecord.plan;
 const windows=plan?.windows??plan?.chunks;
 need(chunked?.library_id===libraryId&&chunked.source_snapshot_ref===snapshotId&&planRecord.source_snapshot_ref===snapshotId&&plan?.source_snapshot_ref===snapshotId&&plan.source_fingerprint===source.fingerprint&&plan.plan_ref===chunked.plan_ref&&Array.isArray(windows)&&windows.length>0&&chunked.chunks?.length===windows.length,code('PLAN_CHANGED'));
 const drafts=windows.map(window=>{
  need(source.documents.some(d=>d.doc_id===window.doc_ref&&d.revision===window.revision),code('SOURCE_MISMATCH'));
  const chunk=chunked.chunks.find(c=>c.chunk_ref===window.chunk_ref),draft=checked(store,K.draft,upstreamRunId+':'+window.chunk_ref);
  need(chunk?.status==='RETURNED'&&draft.run_id===upstreamRunId&&draft.source_snapshot_ref===snapshotId&&draft.chunk_ref===window.chunk_ref&&hash(chunk.draft)===hash(draft)&&Array.isArray(draft.items),code('DRAFT_CHANGED'));
  const read=checked(store,K.read,draft.read_receipt_ref);
  need(read.run_id===upstreamRunId&&read.source_snapshot_ref===snapshotId&&read.chunk_ref===window.chunk_ref&&read.material_sha256===hash(window.contextualized_text)&&hash(read.source_ref)===hash({doc_ref:window.doc_ref,revision:window.revision}),code('READ_RECEIPT_CHANGED'));
  const receipt=chunk.receipt,actor=receipt&&store.listRecords('native_agent_invocation_v1').find(i=>i.invocation_ref===receipt.invocation_ref&&i.run_id===upstreamRunId);
  need(receipt?.origin==='CODEX_NATIVE_APP_SERVER'&&receipt.status==='SUCCEEDED'&&receipt.outcome==='RETURNED'&&actor?.run_id===upstreamRunId&&actor.status==='SUCCEEDED'&&actor.outcome==='RETURNED'&&actor.agent_scope===window.chunk_ref&&hash(actor.request_refs)===hash(receipt.request_refs)&&actor.request_refs?.length>0&&actor.request_refs.every(ref=>ledger.attempts.some(a=>a.request_ref===ref&&a.role==='CQ'&&a.agent_scope===window.chunk_ref&&a.outcome==='RETURNED')),code('INVOCATION_UNCONFIRMED'));
  need(draft.items.every(item=>textField(item.question)&&item.read_receipt_refs?.includes(read.read_receipt_ref)&&Array.isArray(item.source_refs)&&item.source_refs.length>0&&item.source_refs.every(ref=>source.documents.some(d=>d.doc_id===ref.doc_ref&&d.revision===ref.revision))),code('DRAFT_CHANGED'));
  return {chunk_ref:window.chunk_ref,draft:clone(draft)};
 });
 need(drafts.some(row=>row.draft.items.length>0),code('DRAFTS_REQUIRED'));
 return {upstream_run_id:upstreamRunId,source_snapshot_ref:snapshotId,hybrid_plan:clone(plan),drafts};
}
