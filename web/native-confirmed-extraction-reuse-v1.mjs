/** Read saved knowledge from a fully settled failed extraction, without retry. */
import {hash,clone,need,textField} from './cq-discovery-store-v2.mjs';
import {createNativeHybridExtractionWindowPlan} from './native-extraction-window-plan-v1.mjs';

const code=suffix=>'NATIVE_EXTRACTION_REUSE_'+suffix;
const ended=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const unique=values=>Array.isArray(values)&&new Set(values).size===values.length;
const sameSet=(a,b)=>unique(a)&&unique(b)&&hash([...a].sort())===hash([...b].sort());
const union=(rows,key)=>[...new Map(rows.map(row=>[row[key],row])).values()];
const readImmutable=(store,kind,id)=>{
  const value=store.getRecord(kind,id),{record_sha256,...body}=value??{};
  need(value&&record_sha256===hash(body),code('RECORD_CHANGED'));return value;
};

/** All reads; this function cannot change a run, a stage, or a knowledge record. */
export function prepareNativeProductConfirmedExtraction({store,catalog,libraryId,snapshotId,upstreamRunId,confirmedPrefix}){
  const row=store.getRecord('native_product_run_v1',upstreamRunId),ledger=store.getRecord('native_full_run_v1',upstreamRunId),state=store.getRecord('native_full_chain_state_v1',upstreamRunId);
  need(row?.run_id===upstreamRunId&&row.library_id===libraryId&&row.snapshot_id===snapshotId&&ledger?.run_id===upstreamRunId&&
    state?.run_id===upstreamRunId&&state.library_id===libraryId&&state.snapshot_id===snapshotId,code('SOURCE_MISMATCH'));
  need(row.status==='FAILED'&&ledger.status==='FAILED'&&ended(row.ended_at)&&ended(ledger.ended_at),code('ORIGIN_NOT_SETTLED'));
  need(catalog.isCurrent(snapshotId,libraryId),code('SOURCE_STALE'));
  const source=catalog.get(snapshotId,libraryId);
  need(source.library_id===libraryId&&source.snapshot_id===snapshotId&&source.documents?.length>0&&source.documents.every(d=>d.parser?.name==='docling'),code('DOCLING_REQUIRED'));
  need(confirmedPrefix?.version==='CONFIRMED_HYBRID_PREFIX_V1'&&confirmedPrefix.source_snapshot_ref===snapshotId&&
    row.reuse_cq_family_from_run_id===confirmedPrefix.upstream_run_id&&state.upstream_origin?.run_id===confirmedPrefix.upstream_run_id&&
    state.upstream_origin.cq_origin_run_id===confirmedPrefix.cq_origin_run_id&&
    hash(state.cq_input)===hash(confirmedPrefix.cq_input)&&hash(state.family_input)===hash(confirmedPrefix.family_input)&&hash(state.families)===hash(confirmedPrefix.families),code('PREFIX_CHANGED'));
  const input=state.input,policy=input?.extraction_window_policy;
  need(input?.knowledge_build_policy==='EXTRACT_AND_INDEX_V1'&&input.policy==='extract-and-index-v1'&&policy?.version==='HYBRID_EXTRACTION_V1'&&
    policy.window_tokens===8000&&policy.concurrency===4&&policy.token_count_strategy==='cl100k_base'&&policy.token_count_exact===true&&
    hash(input)===hash(ledger.input)&&ledger.binding===hash({input,limits:ledger.limits})&&hash(state.limits)===hash(ledger.limits)&&
    input.library_ref===libraryId&&input.source_snapshot_ref===snapshotId&&input.source_fingerprint===source.fingerprint&&row.source_epoch===source.source_epoch&&
    input.confirmed_upstream_sha256===hash(confirmedPrefix),code('INPUT_CHANGED'));
  const attempts=ledger.attempts;
  need(Array.isArray(attempts)&&attempts.length>0&&unique(attempts.map(a=>a.request_ref))&&
    attempts.every(a=>a.kind==='GENERATION'&&a.role==='EXTRACTION'&&a.outcome==='RETURNED'&&textField(a.agent_scope)),code('REQUEST_UNCONFIRMED'));

  const queue=store.getRecord('native_extraction_window_queue_v1',upstreamRunId);
  need(queue?.run_id===upstreamRunId&&queue.status==='FAILED'&&ended(queue.ended_at)&&queue.commit_complete===true&&queue.concurrency===4,code('QUEUE_NOT_SETTLED'));
  const manifestRecord=readImmutable(store,'native_extraction_window_manifest_v1',queue.manifest_ref),manifest=manifestRecord.manifest;
  need(manifestRecord.run_id===upstreamRunId&&manifestRecord.queue_binding===queue.binding&&manifestRecord.manifest_sha256===queue.manifest_sha256&&
    hash(manifest)===queue.manifest_sha256&&queue.manifest_ref==='window_manifest_'+hash([upstreamRunId,queue.manifest_sha256])&&
    queue.binding===hash({run_id:upstreamRunId,manifest_sha256:queue.manifest_sha256,concurrency:4,policy:'WINDOW_EXTRACTION_QUEUE_V1'}),code('MANIFEST_CHANGED'));
  const expected=createNativeHybridExtractionWindowPlan({snapshot:source,hybridPlan:confirmedPrefix.hybrid_plan,cqInput:state.family_input,familyInput:state.family_input,families:state.families});
  need(hash(expected)===hash(manifest),code('MANIFEST_CHANGED'));
  const windows=new Map(manifest.windows.map(w=>[w.window_ref,w]));
  const works=store.listRecords('native_extraction_window_work_v1').filter(w=>w.run_id===upstreamRunId);
  need(sameSet(works.map(w=>w.window_ref),[...windows.keys()]),code('WINDOW_WORK_CHANGED'));
  for(const work of works){
    const window=manifest.windows[work.ordinal];
    need(window?.window_ref===work.window_ref&&work.window_sha256===hash(window)&&work.queue_binding===queue.binding&&
      work.work_id==='window_work_'+hash([upstreamRunId,queue.manifest_sha256,work.ordinal,work.window_ref])&&
      ['PENDING','RETURNED','FAILED'].includes(work.status),code('WINDOW_WORK_CHANGED'));
  }

  const actors=store.listRecords('native_agent_invocation_v1').filter(a=>a.run_id===upstreamRunId),copies=state.invocations??[];
  need(actors.length>0&&actors.length===copies.length&&unique(actors.map(a=>a.agent_scope)),code('ACTOR_REQUIRED'));
  const actorsByWindow=new Map();
  for(const actor of actors){
    const matches=copies.filter(a=>a.invocation_ref===actor.invocation_ref),copy=matches[0];
    need(actor.role==='EXTRACTION'&&windows.has(actor.agent_scope)&&actor.origin==='CODEX_NATIVE_APP_SERVER'&&ended(actor.ended_at)&&
      ['SUCCEEDED','FAILED','STOPPED','CANCELLED'].includes(actor.status)&&matches.length===1&&copy.role===actor.role&&copy.origin===actor.origin&&
      copy.status===actor.status&&copy.ended_at===actor.ended_at&&copy.agent_scope===actor.agent_scope&&sameSet(actor.request_refs,copy.request_refs)&&actor.request_refs.length>0&&
      actor.request_refs.every(ref=>attempts.some(a=>a.request_ref===ref&&a.agent_scope===actor.agent_scope)),code('ACTOR_NOT_ENDED'));
    actorsByWindow.set(actor.agent_scope,actor);
  }
  need(sameSet(actors.flatMap(a=>a.request_refs),attempts.map(a=>a.request_ref)),code('REQUEST_BINDING_CHANGED'));

  const metas=store.listRecords('native_extraction_window_stage_v1').filter(m=>m.parent_run_id===upstreamRunId),retained=[],skipped=[];
  need(unique(metas.map(m=>m.window_ref))&&metas.every(m=>windows.has(m.window_ref)&&actorsByWindow.has(m.window_ref)),code('STAGE_BINDING_CHANGED'));
  const allProposals=store.listRecords('native_knowledge_proposal_v1');
  for(const window of manifest.windows){
    const meta=metas.find(m=>m.window_ref===window.window_ref);
    if(!meta){skipped.push({window_ref:window.window_ref,reason:'NOT_STARTED'});continue;}
    const stageRunId=meta.stage_run_id,actor=actorsByWindow.get(window.window_ref);
    need(stageRunId===upstreamRunId+'_window_'+hash(window.window_ref).slice(0,24)&&meta.window_sha256===hash(window)&&meta.source_snapshot_ref===snapshotId&&meta.library_id===libraryId,code('STAGE_BINDING_CHANGED'));
    const stage=store.getRecord('native_knowledge_head_v1',stageRunId),latestPlan=store.getRecord('native_knowledge_scope_v1',stageRunId),stageState=store.getRecord('native_build_state_v1',stageRunId);
    need(stageState?.run_id===stageRunId&&stageState.source_snapshot_ref===snapshotId&&stageState.knowledge_build_policy==='EXTRACT_AND_INDEX_V1'&&typeof stageState.extraction_complete==='boolean',code('STAGE_BINDING_CHANGED'));
    if(!stage?.knowledge?.length){skipped.push({window_ref:window.window_ref,stage_run_id:stageRunId,reason:'NO_SAVED_KNOWLEDGE'});continue;}
    if(!latestPlan||!(latestPlan.subjects?.length||latestPlan.tasks?.length)){skipped.push({window_ref:window.window_ref,stage_run_id:stageRunId,reason:'NO_SAVED_SCOPE'});continue;}
    const proposals=allProposals.filter(p=>p.run_id===stageRunId);
    need(proposals.length>0&&proposals.every(p=>p.source_snapshot_ref===snapshotId&&p.raw_hash===hash(p.raw)&&p.identity?.invocation_ref===actor.invocation_ref),code('STAGE_CHANGED'));
    const scopeHistory=proposals.filter(p=>p.name==='SCOPE').sort((a,b)=>a.proposal_ref.localeCompare(b.proposal_ref)).map(p=>{
      const receipt=store.getRecord('native_knowledge_receipt_v1',p.proposal_ref);
      need(receipt&&receipt.scope_revision==='scope_'+hash([p.proposal_ref,receipt.subjects,receipt.tasks]),code('STAGE_CHANGED'));return receipt;
    });
    need(scopeHistory.length>0&&scopeHistory.some(r=>hash(r)===hash(latestPlan)),code('STAGE_CHANGED'));
    const plan={...latestPlan,subjects:union(scopeHistory.flatMap(s=>s.subjects),'subject_ref'),tasks:union(scopeHistory.flatMap(s=>s.tasks),'task_ref'),warnings:scopeHistory.flatMap(s=>s.warnings??[])};
    const allowedCQ=new Set(state.family_input.items.map(q=>q.cq_ref)),tasks=new Set(plan.tasks.map(t=>t.task_ref)),subjects=new Set(plan.subjects.map(s=>s.subject_ref));
    need(plan.tasks.every(t=>Array.isArray(t.cq_refs)&&t.cq_refs.every(q=>allowedCQ.has(q))),code('STAGE_CHANGED'));
    const savedRecords=new Set();let knownHead=false;
    for(const proposal of proposals.filter(p=>p.name==='SUBMIT')){
      const rows=Array.isArray(proposal.raw.candidates)?proposal.raw.candidates:Array.isArray(proposal.raw.knowledge)?proposal.raw.knowledge:[];
      for(let index=0;index<rows.length;index++)savedRecords.add('knowledge_'+hash([proposal.proposal_ref,index]));
      const receipt=store.getRecord('native_knowledge_receipt_v1',proposal.proposal_ref);
      if(receipt?.saved===true&&receipt.revision===stage.revision)knownHead=true;
      for(let offset=0;offset<rows.length;offset+=16)if(store.getRecord('native_knowledge_subbatch_v1',proposal.proposal_ref+':'+offset)?.revision===stage.revision)knownHead=true;
    }
    need(knownHead&&unique(stage.knowledge.map(k=>k.record_ref))&&stage.knowledge.every(k=>savedRecords.has(k.record_ref)&&k.run_id===stageRunId&&k.source_snapshot_ref===snapshotId&&
      textField(k.text??k.statement)&&Array.isArray(k.task_refs)&&k.task_refs.every(t=>tasks.has(t))&&
      (k.kind==='TEXT'||subjects.has(k.subject_ref)||tasks.has(k.subject_ref))&&Array.isArray(k.source_refs)&&k.source_refs.length>0&&
      k.source_refs.every(ref=>ref.doc_ref===window.doc_ref&&ref.revision===window.revision)),code('HEAD_NOT_CONFIRMED'));
    const stageSha256=hash({meta,stage,scope:plan,scope_history:scopeHistory});
    retained.push({window_ref:window.window_ref,stage_run_id:stageRunId,source_parent_run_id:upstreamRunId,stage_sha256:stageSha256,
      knowledge_count:stage.knowledge.length,partial:stageState.extraction_complete!==true});
  }
  need(retained.length>0,code('NO_SAVED_WINDOWS'));
  return {version:'CONFIRMED_EXTRACTION_WINDOWS_V1',upstream_run_id:upstreamRunId,source_snapshot_ref:snapshotId,source_prefix_run_id:confirmedPrefix.upstream_run_id,
    retained_windows:retained,knowledge_count:retained.reduce((n,w)=>n+w.knowledge_count,0),partial_windows:retained.filter(w=>w.partial).length,
    complete_windows:retained.filter(w=>!w.partial).length,unretained_windows:skipped,total_windows:manifest.windows.length,
    prior_status:row.status,manifest_ref:queue.manifest_ref,manifest_sha256:queue.manifest_sha256,semantic_completeness_certified:false};
}
