/** Read a confirmed CQ stage without acknowledging or replaying unknown work. */
import {hash,clone,need,textField} from './cq-discovery-store-v2.mjs';
import {snapshotNativeChunkedCQ,NATIVE_CHUNKED_CQ_RECORDS as K} from './native-chunked-cq-v1.mjs';

const code=suffix=>'NATIVE_CQ_REUSE_'+suffix;
const unique=values=>Array.isArray(values)&&new Set(values).size===values.length;
const sameSet=(a,b)=>unique(a)&&unique(b)&&hash([...a].sort())===hash([...b].sort());
const ended=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const sameSources=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&hash(a.map(hash).sort())===hash(b.map(hash).sort());

/** No constructors, writes, model callbacks, retry, or UNKNOWN state mutation. */
export function prepareNativeProductConfirmedCQ({store,catalog,libraryId,snapshotId,upstreamRunId,acknowledgeUnknown=false}){
  need(typeof acknowledgeUnknown==='boolean',code('ACKNOWLEDGEMENT_INVALID'));
  const row=store.getRecord('native_product_run_v1',upstreamRunId);
  const ledger=store.getRecord('native_full_run_v1',upstreamRunId);
  const state=store.getRecord('native_full_chain_state_v1',upstreamRunId);
  need(row?.run_id===upstreamRunId&&row.library_id===libraryId&&row.snapshot_id===snapshotId&&
    ledger?.run_id===upstreamRunId&&state?.run_id===upstreamRunId&&state.library_id===libraryId&&state.snapshot_id===snapshotId,code('SOURCE_MISMATCH'));
  need(['UNKNOWN_HOLD','FAILED','STOPPED','BLOCKED','CANCELLED'].includes(row.status)&&ledger.status===row.status&&ended(row.ended_at)&&ended(ledger.ended_at),code('RUN_NOT_TERMINAL'));
  need(catalog.isCurrent(snapshotId,libraryId),code('SOURCE_STALE'));
  const source=catalog.get(snapshotId,libraryId);
  need(source.library_id===libraryId&&source.snapshot_id===snapshotId&&source.documents?.length>0&&
    source.documents.every(d=>d.parser?.name==='docling'&&d.blocks?.length>0),code('DOCLING_REQUIRED'));
  need(state.input&&ledger.input&&['DOCLING_HYBRID_CQ_V1','DOCLING_STRUCTURE_CQ_V2'].includes(state.input.cq_chunk_policy?.version)&&
    hash(state.input)===hash(ledger.input)&&ledger.binding===hash({input:ledger.input,limits:ledger.limits})&&
    hash(state.limits)===hash(ledger.limits)&&row.source_epoch===source.source_epoch&&
    ledger.input.library_ref===libraryId&&ledger.input.source_snapshot_ref===snapshotId&&ledger.input.source_fingerprint===source.fingerprint,code('SOURCE_MISMATCH'));
  const attempts=ledger.attempts;
  need(Array.isArray(attempts)&&attempts.length>0&&unique(attempts.map(a=>a.request_ref))&&
    attempts.every(a=>a.kind==='GENERATION'&&['CQ','FAMILY'].includes(a.role)&&['RETURNED','FAILED','UNKNOWN'].includes(a.outcome)),code('REQUEST_UNSETTLED'));
  need(attempts.every(a=>a.role==='FAMILY'||a.outcome==='RETURNED'),code('CQ_REQUEST_UNCONFIRMED'));
  const familyAttempts=attempts.filter(a=>a.role==='FAMILY');
  need(familyAttempts.length>0,code('FAMILY_ATTEMPT_REQUIRED'));
  need(state.families===null&&!ledger.checkpoints?.some(c=>c.stage==='FAMILIES_SAVED')&&
    !store.listRecords('native_family_output_normalization_v1').some(p=>p.run_id===upstreamRunId),code('FAMILY_ALREADY_SAVED'));

  const retainedActors=store.listRecords('native_agent_invocation_v1').filter(i=>i.run_id===upstreamRunId);
  const stateActors=state.invocations??[];
  const actor=(ref,role)=>{
    const retained=retainedActors.filter(i=>i.invocation_ref===ref&&i.role===role);
    const copied=stateActors.filter(i=>i.invocation_ref===ref&&i.role===role);
    need(retained.length===1&&copied.length===1,code('INVOCATION_REQUIRED'));
    const a=retained[0],b=copied[0];
    need(a.origin==='CODEX_NATIVE_APP_SERVER'&&b.origin===a.origin&&a.run_id===upstreamRunId&&b.run_id===upstreamRunId&&
      a.status===b.status&&a.outcome===b.outcome&&a.agent_scope===b.agent_scope&&a.ended_at===b.ended_at&&ended(a.ended_at)&&
      sameSet(a.request_refs,b.request_refs)&&a.request_refs.length>0,code('INVOCATION_CHANGED'));
    need(a.request_refs.every(ref=>attempts.some(r=>r.request_ref===ref&&r.kind==='GENERATION'&&r.role===role)),code('REQUEST_BINDING_CHANGED'));
    return a;
  };
  const families=retainedActors.filter(i=>i.role==='FAMILY');
  need(families.length===1&&stateActors.filter(i=>i.role==='FAMILY').length===1,code('FAMILY_ACTOR_REQUIRED'));
  const family=actor(families[0].invocation_ref,'FAMILY');
  need(['UNKNOWN','FAILED'].includes(family.status)&&sameSet(family.request_refs,familyAttempts.map(a=>a.request_ref)),code('FAMILY_ACTOR_NOT_ENDED'));
  const hasUnknown=row.status==='UNKNOWN_HOLD'||family.status==='UNKNOWN'||attempts.some(a=>a.outcome==='UNKNOWN');
  need(!hasUnknown||acknowledgeUnknown===true,code('UNKNOWN_ACKNOWLEDGEMENT_REQUIRED'));

  // The snapshot helper verifies immutable plan, drafts and merge record hashes.
  const chunked=snapshotNativeChunkedCQ({store,runId:upstreamRunId});
  const cq=state.cq_input,merge=chunked?.merge;
  need(chunked?.run_id===upstreamRunId&&chunked.library_id===libraryId&&chunked.source_snapshot_ref===snapshotId&&
    chunked.status==='COMPLETED'&&chunked.scan_status==='COMPLETE'&&chunked.chunks?.length>0&&chunked.chunks.every(c=>c.status==='RETURNED'),code('CQ_SCAN_INCOMPLETE'));
  need(cq?.run_id===upstreamRunId&&cq.source_snapshot_ref===snapshotId&&cq.items?.length>0&&
    hash(cq)===hash(chunked.cq_input)&&hash(cq)===hash(merge?.cq_input)&&hash(cq)===hash(chunked.result?.cq_input),code('CQ_CHANGED'));
  const planRecord=store.getRecord(K.plan,upstreamRunId),plan=planRecord?.plan;
  const work=plan?.windows??plan?.chunks;
  need(planRecord.run_id===upstreamRunId&&planRecord.source_snapshot_ref===snapshotId&&plan?.source_snapshot_ref===snapshotId&&plan.plan_ref===chunked.plan_ref&&
    Array.isArray(work)&&sameSet(work.map(c=>c.chunk_ref),chunked.chunks.map(c=>c.chunk_ref)),code('PLAN_CHANGED'));
  need(!plan.gaps?.length&&!plan.coverage?.some(c=>c.status==='UNREPRESENTED'),code('CQ_SCAN_INCOMPLETE'));

  const cqActors=retainedActors.filter(i=>i.role==='CQ'),scopeActors=new Map();
  const hostConservative=merge?.mode==='HOST_CONSERVATIVE_RANGE_DEDUP_V1'&&plan.policy?.range_contract==='CQ_UNIT_RANGES_V1';
  const hostExactMerge=hostConservative||merge?.mode==='HOST_EXACT_DEDUP';
  need(!hostExactMerge||hostConservative||work.length<=1||new Set(chunked.chunks.flatMap(c=>(c.draft?.items??[]).map(i=>hash({question:i.question,notes:i.notes??null})))).size<=1,code('MERGE_CHANGED'));
  need(cqActors.length===work.length+(hostExactMerge?0:1)&&stateActors.filter(i=>i.role==='CQ').length===cqActors.length,code('INVOCATION_REQUIRED'));
  for(const raw of cqActors){
    const a=actor(raw.invocation_ref,'CQ');
    need(a.status==='SUCCEEDED'&&a.outcome==='RETURNED'&&textField(a.agent_scope)&&!scopeActors.has(a.agent_scope)&&
      a.request_refs.every(ref=>attempts.some(r=>r.request_ref===ref&&r.role==='CQ'&&r.agent_scope===a.agent_scope&&r.outcome==='RETURNED')),code('CQ_INVOCATION_UNCONFIRMED'));
    scopeActors.set(a.agent_scope,a);
  }
  need(sameSet(cqActors.flatMap(a=>a.request_refs),attempts.filter(a=>a.role==='CQ').map(a=>a.request_ref)),code('REQUEST_BINDING_CHANGED'));
  const checkedReads=new Map(),originals=new Map();
  for(const chunk of chunked.chunks){
    const window=work.find(w=>w.chunk_ref===chunk.chunk_ref),a=scopeActors.get(chunk.chunk_ref),draft=chunk.draft;
    need(window&&source.documents.some(d=>d.doc_id===window.doc_ref&&d.revision===window.revision)&&
      a?.invocation_ref===chunk.receipt?.invocation_ref&&chunk.receipt.status==='SUCCEEDED'&&chunk.receipt.outcome==='RETURNED'&&
      sameSet(chunk.request_refs,a.request_refs)&&draft?.run_id===upstreamRunId&&draft.source_snapshot_ref===snapshotId&&draft.chunk_ref===chunk.chunk_ref,code('CHUNK_CHANGED'));
    const read=store.getRecord(K.read,draft.read_receipt_ref),{record_sha256,...body}=read??{};
    need(read?.run_id===upstreamRunId&&read.source_snapshot_ref===snapshotId&&read.chunk_ref===chunk.chunk_ref&&record_sha256===hash(body)&&
      hash(read.source_ref)===hash({doc_ref:window.doc_ref,revision:window.revision})&&read.material_sha256===hash(window.contextualized_text)&&
      sameSet(read.source_chunk_refs,window.source_chunk_refs??[window.chunk_ref]),code('READ_RECEIPT_CHANGED'));
    checkedReads.set(read.read_receipt_ref,read);
    for(const item of draft.items??[]){
      need(textField(item.cq_ref)&&!originals.has(item.cq_ref)&&item.read_receipt_refs?.includes(read.read_receipt_ref),code('DRAFT_CHANGED'));
      originals.set(item.cq_ref,{item,chunk_ref:chunk.chunk_ref});
    }
  }
  const mergeScope='cq_merge_'+hash(plan.plan_ref).slice(0,32),mergeActor=scopeActors.get(mergeScope);
  need((hostExactMerge?!mergeActor&&chunked.result?.merge_result?.execution_mode==='HOST_EXACT_DEDUP'&&chunked.result.merge_result.outcome==='RETURNED'&&chunked.result.merge_result.request_refs?.length===0:mergeActor?.invocation_ref===chunked.result?.merge_result?.receipt?.invocation_ref&&chunked.result.merge_result.outcome==='RETURNED')&&
    merge.run_id===upstreamRunId&&merge.source_snapshot_ref===snapshotId&&merge.plan_ref===plan.plan_ref&&
    Array.isArray(merge.drafts)&&Array.isArray(merge.mapping),code('MERGE_CHANGED'));
  const numbered=new Map();
  for(const draft of merge.drafts){
    need(textField(draft.draft_ref)&&!numbered.has(draft.draft_ref)&&originals.get(draft.origin_cq_ref)?.chunk_ref===draft.chunk_ref,code('MERGE_CHANGED'));
    numbered.set(draft.draft_ref,draft);
  }
  need(sameSet(merge.drafts.map(d=>d.origin_cq_ref),[...originals.keys()])&&
    sameSet(merge.mapping.map(m=>m.cq_ref),cq.items.map(i=>i.cq_ref)),code('MERGE_CHANGED'));
  const used=new Set();
  for(const mapping of merge.mapping){
    need(unique(mapping.source_draft_refs)&&mapping.source_draft_refs.every(ref=>numbered.has(ref)),code('MERGE_CHANGED'));
    const origins=mapping.source_draft_refs.map(ref=>{used.add(ref);return numbered.get(ref);});
    need(sameSet(mapping.origin_cq_refs,origins.map(o=>o.origin_cq_ref))&&
      sameSet(mapping.origin_chunk_refs,[...new Set(origins.map(o=>o.chunk_ref))]),code('MERGE_CHANGED'));
    const item=cq.items.find(i=>i.cq_ref===mapping.cq_ref),originItems=origins.map(o=>originals.get(o.origin_cq_ref).item);
    if(hostExactMerge)need(originItems.every(i=>hash({question:i.question,notes:i.notes??null})===hash({question:item.question,notes:item.notes??null})),code('MERGE_CHANGED'));
    const sources=[...new Map(originItems.flatMap(i=>i.source_refs).map(s=>[hash(s),s])).values()];
    need(sameSources(item.source_refs,sources)&&sameSet(item.read_receipt_refs,[...new Set(originItems.flatMap(i=>i.read_receipt_refs))])&&
      item.source_refs.every(ref=>source.documents.some(d=>d.doc_id===ref.doc_ref&&d.revision===ref.revision))&&
      item.read_receipt_refs.every(ref=>checkedReads.has(ref)),code('CQ_SOURCE_CHANGED'));
  }
  need(sameSet([...used],[...numbered.keys()]),code('MERGE_CHANGED'));

  const artifact=(stage,payload)=>{
    const matches=ledger.checkpoints?.filter(c=>c.stage===stage)??[],checkpoint=matches[0];
    const value=checkpoint&&store.getRecord('native_full_run_artifact_v1',checkpoint.artifact_ref);
    const content=value&&{run_id:value.run_id,stage:value.stage,payload:value.payload,parent_refs:value.parent_refs};
    need(matches.length===1&&value?.run_id===upstreamRunId&&value.stage===stage&&hash(value.payload)===hash(payload)&&
      value.content_hash===hash(content)&&value.artifact_ref===checkpoint.artifact_ref&&checkpoint.artifact_ref==='native_artifact_'+hash(content)&&
      unique(value.parent_refs)&&value.parent_refs.every(ref=>ledger.checkpoints.some(c=>c.artifact_ref===ref)),code('ARTIFACT_CHANGED'));
    return value;
  };
  const sourceArtifact=artifact('SOURCE_READY',{snapshot_id:snapshotId,documents:source.documents.map(d=>({doc_ref:d.doc_id,revision:d.revision,parser:d.parser,warnings:d.warnings??[]}))});
  const chunksArtifact=artifact('CHUNKS_READY',{plan_ref:plan.plan_ref,policy:plan.policy,chunk_count:plan.chunks.length,window_count:work.length,coverage:plan.coverage,warnings:plan.warnings});
  const cqArtifact=artifact('CQ_SAVED',cq);
  need(sourceArtifact.parent_refs.length===0&&chunksArtifact.parent_refs.includes(sourceArtifact.artifact_ref)&&cqArtifact.parent_refs.includes(sourceArtifact.artifact_ref),code('ARTIFACT_CHANGED'));
  return {upstream_run_id:upstreamRunId,source_snapshot_ref:snapshotId,cq_input:clone(cq),cq_scan_status:'COMPLETE',
    prior_status:row.status,prior_family_request_refs:familyAttempts.map(a=>a.request_ref)};
}
