import {readNativeConflictDecisions} from './native-knowledge-conflicts-v1.mjs';
/** Rust owns fact/time rules. This adapter owns authorization, snapshots, CAS and one SQLite connection. */
import {randomUUID} from 'node:crypto';
import {canonical,hash,clone,need,textField} from './cq-discovery-store-v2.mjs';
import {createMemoryRecordCore} from './native-memory-record-core-v1.mjs';
import {createMemoryPublicationCoordinator} from './native-memory-publication-v1.mjs';
import {createTemporalIndexView} from './native-temporal-index-view-v2.mjs';

const POLICY='RUST_TEMPORAL_CORE_V1';
const PLAN='native_temporal_fact_change_plan_v2',FACT='native_temporal_fact_version_v2',LINK='native_temporal_support_activation_v2';
const signed=body=>({...body,record_sha256:hash(body)});
const check=(value,code)=>{const {record_sha256,...body}=value??{};need(value&&record_sha256===hash(body),code);return value;};
const sync=(value,code)=>{need(!value||typeof value.then!=='function',code);return value;};
const key=(...parts)=>canonical(parts);
const noSystem=version=>Object.fromEntries(Object.entries(version).filter(([name])=>name!=='system'));
const ordered=(rows,name)=>[...rows].sort((a,b)=>a[name].localeCompare(b[name]));
const iso=value=>{
  if(value instanceof Date)value=value.toISOString();
  need(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value)), 'TEMPORAL_SYSTEM_CLOCK_INVALID');
  return new Date(value).toISOString();
};

export function createTemporalFactParticipant({store,core,authorize,clock=()=>new Date().toISOString(),
  rawCoreForLibrary=null,fault=()=>{},idFactory=()=>randomUUID(),preserveExisting=false,catalog=null,embeddingRuntime=null}={}) {
  const db=store?.db;
  need(db&&typeof core==='function'&&typeof authorize==='function'&&typeof clock==='function', 'TEMPORAL_HOST_REQUIRED');
  need(db.isTransaction===false,'TEMPORAL_FACTORY_REQUIRES_OUTSIDE_TRANSACTION');
  db.exec(`CREATE TABLE IF NOT EXISTS memory_knowledge_activation_events_v1 (
    library_id TEXT NOT NULL,activation_seq INTEGER NOT NULL,activation_ref TEXT NOT NULL UNIQUE,
    publication_ref TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(library_id,activation_seq),UNIQUE(library_id,publication_ref));
    CREATE TABLE IF NOT EXISTS memory_knowledge_activation_heads_v1 (library_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_knowledge_version_intervals_v1 (
    library_id TEXT NOT NULL,knowledge_version_ref TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(library_id,knowledge_version_ref));`);
  const rawCores=new Map();
  const rawFor=libraryId=>{
    if(rawCoreForLibrary)return rawCoreForLibrary(libraryId);
    if(!rawCores.has(libraryId))rawCores.set(libraryId,createMemoryRecordCore({db,libraryId,clock}));
    return rawCores.get(libraryId);
  };
  const views=createTemporalIndexView({store,rawCoreForLibrary:rawFor,preserveExisting,catalog,embeddingRuntime});
  let coordinator=null;
  const issuedViews=new Map();
  const auth=(libraryId,operation)=>{
    need(textField(libraryId),'TEMPORAL_LIBRARY_REQUIRED');
    need(sync(authorize({library_id:libraryId,operation}),'TEMPORAL_ASYNC_AUTH_FORBIDDEN')===true,'TEMPORAL_NOT_AUTHORIZED');
  };
  const outside=()=>need(db.isTransaction===false,'TEMPORAL_RULES_REQUIRE_OUTSIDE_TRANSACTION');
  const call=(operation,payload)=>{outside();return core('temporal_core_v1',operation,payload);};
  const inject=phase=>sync(fault(phase),'TEMPORAL_ASYNC_FAULT_FORBIDDEN');
  const allKind=(kind,libraryId)=>db.prepare('SELECT payload FROM workbench_records WHERE kind=?').all(kind)
    .map(row=>JSON.parse(row.payload)).filter(row=>row.library_id===libraryId).map(row=>check(row,'TEMPORAL_STORED_RECORD_CHANGED'));
  function immutable(kind,id,value) {
    const old=store.getRecord(kind,id);need(!old||hash(old)===hash(value),'TEMPORAL_IMMUTABLE_CONFLICT');
    if(!old)store.putRecord(kind,id,value);
    need(hash(store.getRecord(kind,id))===hash(value),'TEMPORAL_IMMUTABLE_READBACK_CHANGED');
  }
  function head(libraryId) {
    const row=db.prepare('SELECT payload FROM memory_knowledge_activation_heads_v1 WHERE library_id=?').get(libraryId);
    if(!row)return null;
    const value=check(JSON.parse(row.payload),'TEMPORAL_ACTIVATION_HEAD_CHANGED');
    need(value.fact_policy===POLICY,'TEMPORAL_LEGACY_ACTIVATION_NOT_READY');return value;
  }
  const kernelHead=libraryId=>{const value=head(libraryId);return {activation_seq:value?.activation_seq??0,activation_ref:value?.activation_ref??null};};
  function intervals(libraryId,selectedSeq=null) {
    let sql='SELECT payload FROM memory_knowledge_version_intervals_v1 WHERE library_id=? AND json_extract(payload,\'$.fact_policy\')=?';
    const args=[libraryId,POLICY];
    if(selectedSeq!==null){sql+=' AND json_extract(payload,\'$.recorded_from.activation_seq\')<=? AND (json_extract(payload,\'$.recorded_to\') IS NULL OR json_extract(payload,\'$.recorded_to.activation_seq\')>?)';args.push(selectedSeq,selectedSeq);}
    return db.prepare(sql+' ORDER BY knowledge_version_ref').all(...args).map(row=>check(JSON.parse(row.payload),'TEMPORAL_INTERVAL_CHANGED'));
  }
  function factWithSystem(libraryId,interval) {
    const body=check(store.getRecord(FACT,key(libraryId,interval.knowledge_version_ref)),'TEMPORAL_FACT_BODY_CHANGED');
    need(body.library_id===libraryId&&body.fact.fact_version_id===interval.knowledge_version_ref
      &&hash(body.fact)===interval.assertion_sha256,'TEMPORAL_FACT_INTERVAL_BINDING_CHANGED');
    need(interval.recorded_from?.activation_seq>0&&textField(interval.recorded_from.activated_at),'TEMPORAL_LEGACY_START_UNKNOWN');
    return {...clone(body.fact),system:{from_seq:interval.recorded_from.activation_seq,to_seq:interval.recorded_to?.activation_seq??null,
      recorded_from:interval.recorded_from.activated_at,recorded_to:interval.recorded_to?.activated_at??null}};
  }
  function snapshot(libraryId) {
    const selected=kernelHead(libraryId),versions=ordered(intervals(libraryId,selected.activation_seq).map(row=>factWithSystem(libraryId,row)),'fact_version_id');
    const ids=new Set(versions.map(row=>row.fact_version_id));
    const links=visibleLinks(libraryId,selected.activation_seq,ids);
    if(selected.activation_ref)validateMembership(libraryId,selected.activation_ref,versions,links);
    return {head:selected,versions,support_links:links};
  }
  function visibleLinks(libraryId,seq,ids) {
    const links=db.prepare('SELECT payload FROM workbench_records WHERE kind=? AND json_extract(payload,\'$.library_id\')=? AND json_extract(payload,\'$.system.from_seq\')<=? AND (json_extract(payload,\'$.system.to_seq\') IS NULL OR json_extract(payload,\'$.system.to_seq\')>?)')
      .all(LINK,libraryId,seq,seq).map(row=>check(JSON.parse(row.payload),'TEMPORAL_SUPPORT_LINK_CHANGED')).filter(row=>ids.has(row.link.fact_version_id));
    return ordered(links.map(row=>({...clone(row.link),system:clone(row.system)})),'support_link_id');
  }
  function validateMembership(libraryId,activationRef,versions,links) {
    const row=db.prepare('SELECT payload FROM memory_knowledge_activation_events_v1 WHERE library_id=? AND activation_ref=?').get(libraryId,activationRef);
    const event=check(row&&JSON.parse(row.payload),'TEMPORAL_EVENT_CHANGED');
    const library=check(store.getRecord('native_library_knowledge_revision_v1',event.view.library_revision_ref),'TEMPORAL_HISTORICAL_LIBRARY_CHANGED');
    need(library.record_sha256===event.view.library_revision_sha256,'TEMPORAL_HISTORICAL_LIBRARY_CHANGED');
    const expected=library.knowledge.filter(row=>row.temporal_fact).map(row=>row.temporal_fact.fact_version_id).sort();
    need(hash(expected)===hash(versions.map(row=>row.fact_version_id).sort()),'TEMPORAL_SYSTEM_SELECTION_MEMBERSHIP_CHANGED');
    const expectedLinks=ordered(library.knowledge.flatMap(row=>row.temporal_fact?.support_links??[]).map(noSystem),'support_link_id');
    need(hash(expectedLinks)===hash(ordered(links.map(noSystem),'support_link_id')),'TEMPORAL_SYSTEM_SUPPORT_MEMBERSHIP_CHANGED');
  }
  function sourcePin(libraryId,source) {
    need(source&&textField(source.source_version_id),'TEMPORAL_SOURCE_VERSION_REQUIRED');
    const raw=rawFor(libraryId).getRawRecord(source.source_version_id),{status,...body}=raw;
    need(raw.library_id===libraryId&&raw.record_ref===source.source_version_id,'TEMPORAL_SOURCE_SCOPE_CHANGED');
    if(source.kind==='HUMAN_REVISION')need(raw.source.kind==='HUMAN_TEXT','TEMPORAL_HUMAN_BASIS_REQUIRED');
    if(source.kind==='DOCUMENT')need(raw.source.kind==='DOCUMENT','TEMPORAL_DOCUMENT_BASIS_CHANGED');
    if(source.kind==='OBSERVATION')need(['HUMAN_TEXT','AGENT_REPORT','TOOL_RECEIPT'].includes(raw.source.kind),'TEMPORAL_OBSERVATION_BASIS_CHANGED');
    if(source.kind==='SOURCE_REVISION') {
      const registered=allKind('native_temporal_source_correction_basis_v1',libraryId).some(basis=>basis.source_version_id===raw.record_ref&&basis.source_body_sha256===hash(body));
      if(!registered){need(raw.version>1&&textField(raw.supersedes),'TEMPORAL_ACTUAL_SOURCE_REVISION_REQUIRED');
        const previous=rawFor(libraryId).getRawRecord(raw.supersedes);
        need(previous.logical_ref===raw.logical_ref&&previous.version<raw.version,'TEMPORAL_ACTUAL_SOURCE_REVISION_REQUIRED');}
    }
    need(source.quote===null||source.quote===undefined||textField(source.quote)&&raw.text.includes(source.quote),'TEMPORAL_SOURCE_QUOTE_CHANGED');
    return {source_version_id:raw.record_ref,version:raw.version,source_kind:raw.source.kind,body_sha256:hash(body)};
  }
  function collectSources(libraryId,versions,links,updates=[]) {
    const sources=[...versions.flatMap(row=>row.sources),...links.map(row=>row.source),
      ...updates.flatMap(update=>[...(update.assertion?.sources??[]),...(update.source?[update.source]:[]),...(update.basis?[update.basis]:[])])];
    return [...new Map(sources.map(source=>{const pin=sourcePin(libraryId,source);return [pin.source_version_id,pin];})).values()]
      .sort((a,b)=>a.source_version_id.localeCompare(b.source_version_id));
  }
  const groupDigest=(base,group)=>hash({versions:base.versions.filter(row=>row.state_group?.key===group),
    support_links:base.support_links.filter(link=>base.versions.some(row=>row.fact_version_id===link.fact_version_id&&row.state_group?.key===group))});
  function planFor(libraryId,requestId,provided=null) {
    const plan=check(store.getRecord(PLAN,key(libraryId,requestId)),'TEMPORAL_PLAN_NOT_FOUND_OR_CHANGED');
    need(plan.library_id===libraryId&&plan.request_id===requestId,'TEMPORAL_PLAN_SCOPE_CHANGED');
    if(provided)need(provided.plan_ref===plan.plan_ref&&provided.record_sha256===plan.record_sha256,'TEMPORAL_PLAN_BINDING_CHANGED');
    return plan;
  }
  function validateBase(plan) {
    const actual=snapshot(plan.library_id);
    need(hash(actual.head)===hash(plan.base.head),'TEMPORAL_HEAD_CAS_MISMATCH');
    need(hash(actual)===plan.host_base_sha256,'TEMPORAL_BASE_CAS_MISMATCH');
    for(const group of plan.host_group_digests)need(groupDigest(actual,group.key)===group.digest,'TEMPORAL_GROUP_CAS_MISMATCH');
    for(const expected of plan.source_pins)need(hash(sourcePin(plan.library_id,{source_version_id:expected.source_version_id}))===hash(expected),'TEMPORAL_SOURCE_CAS_MISMATCH');
    return actual;
  }
  function projectionContext(libraryId,context) {
    if(context===null||context===undefined)return null;
    need(context&&Object.keys(context).every(name=>['run_id','source_snapshot_ref','library_revision_ref','library_revision_sha256','capability','embedding_space'].includes(name)),'TEMPORAL_DOCUMENT_CONTEXT_INVALID');
    const revision=check(store.getRecord('native_library_knowledge_revision_v1',context.library_revision_ref),'TEMPORAL_DOCUMENT_REVISION_CHANGED');
    need(revision.library_id===libraryId&&revision.run_id===context.run_id&&revision.source_snapshot_ref===context.source_snapshot_ref
      &&revision.record_sha256===context.library_revision_sha256&&['LEXICAL','VECTOR','HYBRID'].includes(context.capability),'TEMPORAL_DOCUMENT_CONTEXT_INVALID');
    return clone(context);
  }
  function registerSourceCorrectionBasis({library_id,source_version_id,target_version_id,interpretation_ref,interpretation_sha256,quote}={}) {
    auth(library_id,'REGISTER_DOCUMENT_CORRECTION');outside();
    const stage=check(store.getRecord('native_document_temporal_interpretation_v1',interpretation_ref),'TEMPORAL_DOCUMENT_INTERPRETATION_CHANGED');
    need(stage.library_id===library_id&&stage.record_sha256===interpretation_sha256&&stage.finished===true,'TEMPORAL_DOCUMENT_INTERPRETATION_CHANGED');
    const binding=check(store.getRecord('native_document_temporal_binding_v1',interpretation_ref),'TEMPORAL_DOCUMENT_BINDING_CHANGED');
    need(binding.library_id===library_id&&binding.input_sha256===stage.input_sha256&&hash(binding.input)===binding.input_sha256,'TEMPORAL_DOCUMENT_BINDING_CHANGED');
    const raw=rawFor(library_id).getRawRecord(source_version_id),{status,...body}=raw;
    need(raw.source.kind==='DOCUMENT'&&textField(quote)&&raw.text.includes(quote),'TEMPORAL_DOCUMENT_CORRECTION_SOURCE_REQUIRED');
    const target=snapshot(library_id).versions.find(row=>row.fact_version_id===target_version_id);
    need(target&&!target.sources.some(source=>source.source_version_id===source_version_id),'TEMPORAL_DOCUMENT_CORRECTION_TARGET_CHANGED');
    const handle=binding.input.current.find(row=>row.fact.fact_version_id===target_version_id)?.ref;
    const evidence=binding.input.evidence.filter(row=>row.source_version_id===source_version_id&&row.quote===quote).map(row=>row.ref);
    need(handle&&stage.interpretations.some(row=>row.operation==='CORRECT'&&row.target_ref===handle
      &&row.authority?.kind==='SOURCE_EXPLICIT_CORRECTION'&&row.authority.evidence_refs?.some(ref=>evidence.includes(ref))),'TEMPORAL_DOCUMENT_CORRECTION_AUTHORITY_REQUIRED');
    const basis=signed({library_id,source_version_id,target_version_id,interpretation_ref,interpretation_sha256,quote,source_body_sha256:hash(body),
      authority:'EXPLICIT_NEW_DOCUMENT_CORRECTION',physical_source_revision:false});
    immutable('native_temporal_source_correction_basis_v1',key(library_id,source_version_id,target_version_id),basis);return clone(basis);
  }
  function prepareChangeSet({library_id,request_id,updates,expected_head,projection_context=null}={}) {
    auth(library_id,'PREPARE');outside();need(textField(request_id)&&Array.isArray(updates),'TEMPORAL_REQUEST_INVALID');
    const context=projectionContext(library_id,projection_context);
    const requestHash=hash({library_id,request_id,updates,expected_head:expected_head??null,...(context?{projection_context:context}:{})});
    const old=store.getRecord(PLAN,key(library_id,request_id));
    if(old){check(old,'TEMPORAL_PLAN_CHANGED');need(old.request_sha256===requestHash,'TEMPORAL_IDEMPOTENCY_CONFLICT');return clone(old);}
    const base=snapshot(library_id);
    if(expected_head)need(hash(expected_head)===hash(base.head),'TEMPORAL_HEAD_CAS_MISMATCH');
    collectSources(library_id,[],[],updates);
    for(const update of updates)if(update.kind==='CORRECT') {
      const target=base.versions.find(row=>row.fact_version_id===update.target_version_id);
      need(target,'TEMPORAL_CORRECTION_TARGET_NOT_CURRENT');
      for(const source of update.assertion?.sources??[])if(source.role==='SUPPORT'&&source.kind==='SOURCE_REVISION') {
        const revised=rawFor(library_id).getRawRecord(source.source_version_id);
        const visibleSources=[...target.sources,...base.support_links.filter(link=>link.fact_version_id===target.fact_version_id).map(link=>link.source)];
        const registered=store.getRecord('native_temporal_source_correction_basis_v1',key(library_id,source.source_version_id,target.fact_version_id));
        need(registered&&check(registered,'TEMPORAL_DOCUMENT_CORRECTION_BASIS_CHANGED')||visibleSources.some(old=>old.source_version_id===revised.supersedes),'TEMPORAL_SOURCE_REVISION_TARGET_CHANGED');
      }
    }
    const result=call('prepare_change_set',{request_id,library_id,base,updates});
    need(result.request_id===request_id&&result.library_id===library_id&&hash(result.base_head)===hash(base.head),'TEMPORAL_RUST_PLAN_BINDING_CHANGED');
    const closes=new Set(result.close_versions.map(row=>row.fact_version_id));
    const current=intervals(library_id,base.head.activation_seq).map(row=>factWithSystem(library_id,row));
    const preview=[...current.filter(row=>!closes.has(row.fact_version_id)),...result.new_versions];
    const links=[...base.support_links,...result.add_supports];
    const body={schema_version:'TEMPORAL_FACT_PLAN_V2',library_id,request_id,request_sha256:requestHash,
      base,host_base_sha256:hash(base),kernel_plan:result,preview_versions:preview,preview_support_links:links,...(context?{projection_context:context}:{}),
      source_pins:collectSources(library_id,preview,links,updates),
      host_group_digests:result.affected_group_digests.map(group=>({key:group.key,digest:groupDigest(base,group.key)}))};
    const plan=signed({...body,plan_ref:'temporal_plan_'+hash(body)});
    immutable(PLAN,key(library_id,request_id),plan);return clone(plan);
  }
  const preparedFor=(libraryId,requestId)=>check(store.getRecord('native_temporal_fact_prepared_v2',key(libraryId,requestId)),'TEMPORAL_PREPARED_NOT_FOUND_OR_CHANGED');
  const boundPlan=prepared=>{
    const bound=preparedFor(prepared.library_id,prepared.request_id);
    need(hash(bound.frame)===hash(prepared),'TEMPORAL_FRAME_CHANGED');return {bound,plan:planFor(prepared.library_id,prepared.request_id)};
  };
  async function prepareProjection({library_id,request_id,plan:provided,view_runtime=null}={}) {
    auth(library_id,'STAGE');outside();need(coordinator,'TEMPORAL_COORDINATOR_REQUIRED');
    const plan=planFor(library_id,request_id,provided);
    let bound=store.getRecord('native_temporal_fact_prepared_v2',key(library_id,request_id));
    if(!bound) {
      validateBase(plan);
      for(const fact of plan.kernel_plan.new_versions)immutable(FACT,key(library_id,fact.fact_version_id),signed({library_id,fact:noSystem(fact)}));
      const frame=await views.prepare({library_id,request_id,versions:plan.preview_versions,support_links:plan.preview_support_links,
        context:plan.projection_context??null,runtimeOverride:view_runtime});
      const complete={...frame,request_id,temporal_plan_ref:plan.plan_ref,temporal_plan_sha256:plan.record_sha256};
      bound=signed({library_id,request_id,frame:complete,view:views.bindings(frame)});
      immutable('native_temporal_fact_prepared_v2',key(library_id,request_id),bound);
    }
    check(bound,'TEMPORAL_PREPARED_CHANGED');
    return {prepared:clone(bound.frame),view:clone(bound.view)};
  }
  async function stagePrepared(args={}) {
    const {library_id,request_id}=args,bound=await prepareProjection(args);
    const receipt=await coordinator.stageFactChangeSet({library_id,processing_ref:request_id,prepared:bound.prepared});
    return {prepared:clone(bound.prepared),receipt};
  }
  function validatePrepared({library_id,processing_ref,prepared}) {
    need(prepared.library_id===library_id&&prepared.request_id===processing_ref,'TEMPORAL_PREPARED_SCOPE_CHANGED');
    const {plan}=boundPlan(prepared);validateBase(plan);const scoped=store.getRecord('native_simplified_temporal_operation_v1',processing_ref);if(scoped){check(scoped,'SIMPLIFIED_TEMPORAL_OPERATION_CHANGED');need(scoped.plan_sha256===plan.record_sha256&&scoped.library_id===library_id,'SIMPLIFIED_TEMPORAL_OPERATION_CHANGED');if(scoped.decision_scope){const scope=scoped.decision_scope,events=readNativeConflictDecisions({store,libraryId:library_id,revisionRef:scope.source_revision_ref,itemRefs:scope.item_refs}).map(d=>d.event_ref);need(hash(events)===hash(scope.event_refs),'NATIVE_CONFLICT_PREVIEW_STALE');}}return {verified:true};
  }
  function applyFactPublication(libraryId,{expected_commit_ref,bindings},{idempotency_key}) {
    need(db.isTransaction===true,'TEMPORAL_CALLER_TRANSACTION_REQUIRED');
    const raw=rawFor(libraryId),old=raw.getHead();
    need((old?.commit_ref??null)===expected_commit_ref,'TEMPORAL_CORE_HEAD_CAS_MISMATCH');
    const commit={schema_version:'MEMORY_RECORD_COMMIT_V1',library_id:libraryId,commit_ref:'mcommit_'+idFactory(),
      commit_seq:(old?.commit_seq??0)+1,parent_commit_ref:old?.commit_ref??null,published_at:null,staged_at:iso(clock()),
      publication_boundary:'UNCONFIRMED_CALLER_COMMIT',capability:'RECORD_ONLY',commit_kind:'FACT_PROJECTION_VIEW_ONLY',
      record_refs:clone(old?.record_refs??[]),record_states:clone(old?.record_states??{}),source_manifest:clone(old?.source_manifest??[]),
      bindings:{...(old?.bindings??{}),...bindings},gaps:['RAW_RECORD_HISTORY_BOUNDARY_UNSEALED']};
    db.prepare('INSERT INTO memory_record_commits_v1 VALUES(?,?,?,?,?)').run(libraryId,commit.commit_ref,commit.commit_seq,null,canonical(commit));
    db.prepare('INSERT INTO memory_record_heads_v1 VALUES(?,?) ON CONFLICT(library_id) DO UPDATE SET commit_ref=excluded.commit_ref').run(libraryId,commit.commit_ref);
    inject('AFTER_CORE_STAGE');return {commit,publication_staged:true,requires_outer_commit:true,raw_saved:false};
  }
  function eventByPublication(libraryId,publicationRef) {
    const row=db.prepare('SELECT payload FROM memory_knowledge_activation_events_v1 WHERE library_id=? AND publication_ref=?').get(libraryId,publicationRef);
    return row?check(JSON.parse(row.payload),'TEMPORAL_EVENT_CHANGED'):null;
  }
  function activateInTransaction({library_id,processing_ref,publication_ref,confirmation_ref,commit_ref,prepared}) {
    need(db.isTransaction===true,'TEMPORAL_CALLER_TRANSACTION_REQUIRED');
    const old=eventByPublication(library_id,publication_ref);if(old)return activationSummary(old);
    const {bound,plan}=boundPlan(prepared);validateBase(plan);
    const prior=head(library_id),at=iso(clock());
    need(!prior||at>=prior.activated_at,'TEMPORAL_CLOCK_REVERSED');
    const seq=(prior?.activation_seq??0)+1,activationRef='knowledge_activation_'+hash([library_id,publication_ref]);
    const tuple={activation_ref:activationRef,activation_seq:seq,activated_at:at};
    for(const close of plan.kernel_plan.close_versions) {
      const row=db.prepare('SELECT payload FROM memory_knowledge_version_intervals_v1 WHERE library_id=? AND knowledge_version_ref=?').get(library_id,close.fact_version_id);
      const interval=check(row&&JSON.parse(row.payload),'TEMPORAL_CLOSE_TARGET_CHANGED');
      need(interval.recorded_to===null,'TEMPORAL_CLOSE_TARGET_CHANGED');
      const {record_sha256,...body}=interval;
      db.prepare('UPDATE memory_knowledge_version_intervals_v1 SET payload=? WHERE library_id=? AND knowledge_version_ref=?')
        .run(canonical(signed({...body,recorded_to:tuple,close_reason:close.reason,close_basis:close.basis})),library_id,close.fact_version_id);
    }
    for(const fact of plan.kernel_plan.new_versions) {
      const interval=signed({schema_version:'MEMORY_KNOWLEDGE_VERSION_INTERVAL_V1',fact_policy:POLICY,library_id,
        knowledge_ref:fact.fact_id,knowledge_version_ref:fact.fact_version_id,assertion_sha256:hash(noSystem(fact)),policy:POLICY,warnings:[],
        recorded_from:tuple,recorded_to:null,recorded_from_status:'KNOWN'});
      db.prepare('INSERT INTO memory_knowledge_version_intervals_v1 VALUES(?,?,?)').run(library_id,fact.fact_version_id,canonical(interval));
    }
    for(const link of plan.kernel_plan.add_supports)immutable(LINK,key(library_id,link.support_link_id),signed({library_id,link:noSystem(link),
      system:{from_seq:seq,to_seq:null,recorded_from:at,recorded_to:null}}));
    const event=signed({schema_version:'MEMORY_KNOWLEDGE_ACTIVATION_EVENT_V1',fact_policy:POLICY,sealed:true,library_id,
      ...tuple,previous_activation_ref:prior?.activation_ref??null,publication_ref,confirmation_ref,commit_ref,request_id:processing_ref,
      time_semantics:'COMMITTED_LOGICAL_ACTIVATION',plan_ref:plan.plan_ref,plan_sha256:plan.record_sha256,
      view:bound.view,source_pins:plan.source_pins,warnings:plan.kernel_plan.warnings});
    db.prepare('INSERT INTO memory_knowledge_activation_events_v1 VALUES(?,?,?,?,?)').run(library_id,seq,activationRef,publication_ref,canonical(event));
    const next=signed({schema_version:'MEMORY_KNOWLEDGE_ACTIVATION_HEAD_V1',fact_policy:POLICY,library_id,...tuple,
      publication_ref,confirmation_ref,commit_ref,event_sha256:event.record_sha256});
    db.prepare('INSERT INTO memory_knowledge_activation_heads_v1 VALUES(?,?) ON CONFLICT(library_id) DO UPDATE SET payload=excluded.payload').run(library_id,canonical(next));
    const scoped=store.getRecord('native_simplified_temporal_operation_v1',processing_ref);if(scoped){check(scoped,'SIMPLIFIED_TEMPORAL_OPERATION_CHANGED');store.putRecord('native_simplified_temporal_links_v1',library_id,signed({library_id,operation_ref:processing_ref,activation:tuple,links:clone(scoped.next_links)}));}
    inject('AFTER_ACTIVATION');return activationSummary(event);
  }
  const activationSummary=event=>({activation_ref:event.activation_ref,activation_seq:event.activation_seq,activated_at:event.activated_at,event_sha256:event.record_sha256});
  const factPort=Object.freeze({mode:'NATIVE_PRODUCT',
    coreForLibrary:libraryId=>({...rawFor(libraryId),applyFactPublicationInTransaction:(request,host)=>applyFactPublication(libraryId,request,host)}),
    validatePrepared,
    applyInTransaction:args=>{const {bound}=boundPlan(args.prepared);const value=views.applyInTransaction({...args,prepared:bound.frame});inject('AFTER_INDEX_STAGE');return value;},
    readback:async args=>{inject('BEFORE_READBACK');return views.readback(args);},
    assertPreparedCurrent:args=>views.assertPreparedCurrent(args),activateInTransaction});
  async function confirmPrepared({library_id,request_id}={}) {
    auth(library_id,'CONFIRM');outside();need(coordinator,'TEMPORAL_COORDINATOR_REQUIRED');
    const receipt=coordinator.getForProcessing({library_id,processing_ref:request_id});
    need(textField(receipt.publication_ref),'TEMPORAL_PUBLICATION_NOT_FOUND');
    const result=await coordinator.confirmPending({publication_ref:receipt.publication_ref});
    if(result.state==='CONFIRMED')inject('AFTER_CONFIRM_COMMIT');
    return result;
  }
  function selectedEvent(libraryId,asOf) {
    let row;
    if(asOf===undefined||asOf===null){const value=head(libraryId);if(!value)return null;row=db.prepare('SELECT payload FROM memory_knowledge_activation_events_v1 WHERE library_id=? AND activation_ref=?').get(libraryId,value.activation_ref);}
    else if(Number.isSafeInteger(asOf.activation_seq)&&asOf.activation_seq>0)row=db.prepare('SELECT payload FROM memory_knowledge_activation_events_v1 WHERE library_id=? AND activation_seq=?').get(libraryId,asOf.activation_seq);
    else if(textField(asOf.activation_ref))row=db.prepare('SELECT payload FROM memory_knowledge_activation_events_v1 WHERE library_id=? AND activation_ref=?').get(libraryId,asOf.activation_ref);
    else if(textField(asOf.timestamp))row=db.prepare('SELECT payload FROM memory_knowledge_activation_events_v1 WHERE library_id=? AND json_extract(payload,\'$.activated_at\')<=? ORDER BY activation_seq DESC LIMIT 1').get(libraryId,iso(asOf.timestamp));
    else need(false,'TEMPORAL_AS_OF_INVALID');
    if(!row)return null;
    const event=check(JSON.parse(row.payload),'TEMPORAL_EVENT_CHANGED');
    need(event.fact_policy===POLICY&&event.sealed===true,'TEMPORAL_HISTORY_NOT_READY');
    const publication=coordinator?.getForProcessing({library_id:libraryId,processing_ref:event.request_id});
    need(publication?.state==='CONFIRMED'&&publication.confirmation_ref===event.confirmation_ref
      &&publication.fact_activation?.activation_ref===event.activation_ref,'TEMPORAL_ACTIVATION_NOT_READABLE');return event;
  }
  function readFacts({library_id,at=null,as_of=null,view_ref=null}={}) {
    auth(library_id,'READ');outside();let event,selection;
    if(view_ref){const fixed=issuedViews.get(view_ref);need(fixed&&fixed.library_id===library_id,'TEMPORAL_READ_VIEW_EXPIRED');event=selectedEvent(library_id,{activation_ref:fixed.activation_ref});selection=fixed.at;
      if(at!==null){const asked=typeof at==='string'?{value:at,precision:'EXACT',raw:at,basis:'QUERY'}:at;need(hash(asked)===hash(selection),'TEMPORAL_READ_VIEW_REQUEST_CHANGED');}
      if(as_of!==null)need(selectedEvent(library_id,as_of)?.activation_ref===event.activation_ref,'TEMPORAL_READ_VIEW_REQUEST_CHANGED');}
    else {event=selectedEvent(library_id,as_of);selection=typeof at==='string'?{value:at,precision:'EXACT',raw:at,basis:'QUERY'}:at;}
    if(!event)return {status:'NOT_READY',gaps:['NO_ACTIVATED_FACT_VERSION'],supported:[],possible:[],excluded:[]};
    const bound=preparedFor(library_id,event.request_id);
    need(hash(views.bindings(bound.frame))===hash(event.view),'TEMPORAL_HISTORICAL_VIEW_CHANGED');
    for(const source of event.source_pins)need(hash(sourcePin(library_id,{source_version_id:source.source_version_id}))===hash(source),'TEMPORAL_HISTORICAL_SOURCE_CHANGED');
    const versions=intervals(library_id,event.activation_seq).map(row=>factWithSystem(library_id,row));
    const links=visibleLinks(library_id,event.activation_seq,new Set(versions.map(row=>row.fact_version_id)));
    validateMembership(library_id,event.activation_ref,versions,links);
    const result=call('select_fact_versions',{selected_seq:event.activation_seq,at:selection,versions,support_links:links});
    const ref=view_ref??'temporal_read_view_'+hash({library_id,activation_ref:event.activation_ref,at:selection});
    issuedViews.set(ref,{library_id,activation_ref:event.activation_ref,at:clone(selection)});
    const sourceRecords=[...new Set([...result.supported,...result.possible].flatMap(row=>row.sources.map(source=>source.source_version_id)))].map(recordRef=>{
      const {status,...raw}=rawFor(library_id).getRawRecord(recordRef);return raw;
    });
    return {status:'READY',view_ref:ref,library_id,selected_activation:activationSummary(event),at:clone(selection),
      ...result,source_records:sourceRecords,view_bindings:clone(event.view),
      gaps:['FULLTEXT_NEIGHBOR_ONTOLOGY_REPLAY_NOT_PROMISED']};
  }
  async function publishChangeSet(args) {
    const plan=prepareChangeSet(args);
    const existing=coordinator?.getForProcessing({library_id:args.library_id,processing_ref:args.request_id});
    if(existing?.state==='CONFIRMED')return {...existing,replayed:true};
    const staged=await stagePrepared({...args,plan});
    if(staged.receipt.state==='CONFIRMED')return {...staged.receipt,replayed:true};
    return confirmPrepared(args);
  }
  return Object.freeze({factPort,rawCoreForLibrary:rawFor,prepareChangeSet,prepareProjection,stagePrepared,confirmPrepared,publishChangeSet,readFacts,registerSourceCorrectionBasis,
    normalizeTimes:({library_id,times,timezone_hints=[]})=>{auth(library_id,'NORMALIZE');return call('normalize_time',{times,...(timezone_hints.length?{timezone_hints}:{})});},
    attachCoordinator(value){need(!coordinator,'TEMPORAL_COORDINATOR_ALREADY_ATTACHED');need(value&&typeof value.stageFactChangeSet==='function','TEMPORAL_COORDINATOR_REQUIRED');coordinator=value;return value;},
    snapshot:({library_id})=>{auth(library_id,'SNAPSHOT');outside();return clone(snapshot(library_id));},
    get coordinator(){return coordinator;}});
}

/** K2 convenience factory. Production can attach the same participant to its existing coordinator. */
export function createTemporalSqliteV2(options) {
  const participant=createTemporalFactParticipant(options);
  const coordinator=createMemoryPublicationCoordinator({db:options.store.db,coreForLibrary:participant.rawCoreForLibrary,
    projectionPort:options.projectionPort??participant.factPort,factPort:participant.factPort,clock:options.clock});
  participant.attachCoordinator(coordinator);return participant;
}
