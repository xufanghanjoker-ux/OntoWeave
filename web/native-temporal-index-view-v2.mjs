import {reconcileGraphDefinitions} from './native-definition-reconciliation-v1.mjs';
import {projectNativeSimplifiedCurrentKnowledge} from './native-simplified-graph-v1.mjs';
/** Derived graph/index participant. Rust alone interprets world time. */
import {canonical, clone, hash, need, textField} from './cq-discovery-store-v2.mjs';
import {createNativeBuildIndex} from './native-build-index-v1.mjs';
import {createDomainGraph, readDomainAttributes, DOMAIN_SEMANTIC_POLICY} from './native-domain-knowledge-v1.mjs';
import {projectTemporalKnowledgeRecord} from './native-temporal-knowledge-projection-v1.mjs';
import {registerMemorySourceBindings, readMemorySourceBinding} from './native-memory-source-binding-v1.mjs';
import {bindNativeActionEvidence} from './native-action-evidence-binding-v1.mjs';

const PLAN = 'native_temporal_index_plan_v2';
const REVISION = 'native_library_knowledge_revision_v1';
const ACTIVE = 'native_library_knowledge_active_v1';
const unique = values => [...new Set(values)];
const distinct = values => [...new Map(values.map(value => [canonical(value), value])).values()];
const same = (a, b) => hash(a) === hash(b);
const list=value=>Array.isArray(value)?value:[];
const normalizedSpace=value=>{if(!value)return null;const result={...clone(value),revision:value.revision??value.model_revision??null,
  distance:String(value.distance).toUpperCase(),normalization:value.normalization??'NONE'};delete result.model_revision;return result;};

/** Replace retrieval fragments only with the exact full source they already represent. */
export function mergeTemporalSourceRecords(retained,incoming){
 let rows=clone(retained);
 for(const source of incoming){
  const old=rows.filter(r=>r.record_ref===source.record_ref||r.knowledge_ref===source.record_ref&&r.retrieval_fragment);
  const fragments=old.filter(r=>r.retrieval_fragment&&r.record_ref!==source.record_ref);let end=0;
  for(const fragment of [...fragments].sort((a,b)=>a.retrieval_fragment.start-b.retrieval_fragment.start)){const span=fragment.retrieval_fragment;need(span.start===end&&Number.isInteger(span.end)&&span.end>span.start&&fragment.text===source.text.slice(span.start,span.end)&&same(fragment.source_refs,source.source_refs),'TEMPORAL_INDEX_SOURCE_FRAGMENT_REUSE_CONFLICT');end=span.end;}
  if(fragments.length)need(end===source.text.length,'TEMPORAL_INDEX_SOURCE_FRAGMENT_REUSE_CONFLICT');
  for(const prior of old.filter(r=>!r.retrieval_fragment||r.record_ref===source.record_ref))need(prior.text===source.text&&same(prior.source_refs,source.source_refs),'TEMPORAL_INDEX_SOURCE_REUSE_CONFLICT');
  const refs=new Set(old.map(r=>r.record_ref));rows=rows.filter(r=>!refs.has(r.record_ref));rows.push(clone(source));
 }
 return rows;
}
function immutable(store, kind, ref, value) {
  const previous = store.getRecord(kind, ref);
  need(!previous || same(previous, value), 'TEMPORAL_INDEX_IMMUTABLE_CONFLICT');
  if (!previous) store.putRecord(kind, ref, clone(value));
  need(same(store.getRecord(kind, ref), value), 'TEMPORAL_INDEX_IMMUTABLE_READBACK_CHANGED');
}
function signed(value) {
  const {record_sha256, ...body} = value ?? {};
  need(value && record_sha256 === hash(body), 'TEMPORAL_INDEX_LIBRARY_REVISION_CHANGED');
  return value;
}
const sourceRef = binding => ({kind: 'MEMORY_RECORD_SOURCE', record_ref: binding.record_ref,
  revision: binding.revision, source_kind: binding.source_kind, document_evidence_eligible: false});

function sourceSlot(original,incoming) {
  if(original.kind!=='ENTITY')return {kind:'RECORD'};
  const key=incoming.attribute??incoming.predicate,attributes=original.attributes;
  const matches=Array.isArray(attributes)?attributes.flatMap((value,index)=>readDomainAttributes([value]).some(a=>a.name===key)
    ?[{kind:'ENTITY_ATTRIBUTE',container:'LIST',index,key}]:[]):Object.entries(attributes??{}).flatMap(([name,value])=>
      readDomainAttributes({[name]:value}).some(a=>a.name===key)?[{kind:'ENTITY_ATTRIBUTE',container:'MAP',key:name}]:[]);
  need(matches.length===1,'TEMPORAL_LINEAGE_ATTRIBUTE_SLOT_UNRESOLVED');return matches[0];
}

/** Recover explicit producer ordinals, never join records by entity, text, predicate or value. */
function temporalLineage({store,libraryId,runId,versions,knowledge=[]}) {
  const byFact=new Map(),warnings=[];
  const add=(factId,binding)=>{const prior=byFact.get(factId)??[];byFact.set(factId,distinct([...prior,binding]));};
  for(const row of knowledge)if(row.temporal_fact&&row.temporal_lineage?.status==='EXACT_PROGRAM_BINDING'
    &&row.temporal_lineage.fact_id===row.temporal_fact.fact_id)for(const b of row.temporal_lineage.bindings??[])add(row.temporal_fact.fact_id,b);
  for(const row of (store.listRecords?.('native_simplified_temporal_operation_v1')??[]).filter(op=>op.library_id===libraryId)){
    const op=signed(row),request=op.request,plan=signed(store.getRecord('native_temporal_fact_change_plan_v2',canonical([libraryId,request.request_id]))),source=signed(store.getRecord(REVISION,op.source_revision_ref));
    need(source.run_id===op.run_id&&source.source_snapshot_ref===op.source_snapshot_ref&&source.record_sha256===op.source_revision_sha256&&plan.record_sha256===op.plan_sha256&&plan.request_sha256===hash(request),'SIMPLIFIED_TEMPORAL_LINEAGE_BINDING_CHANGED');
    for(const pin of op.update_bindings){const update=request.updates[pin.update_index],original=source.knowledge.find(k=>(k.knowledge_ref??k.record_ref)===pin.knowledge_ref);need(original&&update?.kind===pin.operation,'SIMPLIFIED_TEMPORAL_LINEAGE_UPDATE_CHANGED');let slot;if(original.kind==='ENTITY'&&pin.slot?.kind==='ENTITY_ATTRIBUTE'){const raw=pin.slot.container==='LIST'?original.attributes?.[pin.slot.index]:original.attributes?.[pin.slot.key],attribute=readDomainAttributes(pin.slot.container==='LIST'?[raw]:{[pin.slot.key]:raw})[0];need(attribute&&attribute.name===pin.slot.key&&attribute.name===pin.projected_knowledge.attribute&&hash(attribute.value)===hash(pin.projected_knowledge.raw_value),'SIMPLIFIED_TEMPORAL_LINEAGE_SLOT_CHANGED');slot=clone(pin.slot);}else slot=sourceSlot(original,pin.projected_knowledge);need(hash(slot)===hash(pin.slot),'SIMPLIFIED_TEMPORAL_LINEAGE_SLOT_CHANGED');const factId=update.kind==='ADD_FACT'?'fact_'+hash([libraryId,request.request_id,pin.update_index]):plan.base.versions.find(v=>v.fact_version_id===update.target_version_id)?.fact_id,version=plan.kernel_plan.new_versions.find(v=>v.fact_id===factId);need(version,'SIMPLIFIED_TEMPORAL_LINEAGE_KERNEL_CHANGED');add(factId,{knowledge_ref:pin.knowledge_ref,slot,source_slot_ref:canonical([pin.knowledge_ref,slot]),original_attribute_slot:slot.kind==='ENTITY_ATTRIBUTE'?slot:null,source_run_id:op.run_id,source_snapshot_ref:op.source_snapshot_ref,request_id:request.request_id,update_index:pin.update_index,operation:update.kind,kernel_fact_version_id:version.fact_version_id,binding_sha256:op.record_sha256,interpretation_sha256:op.record_sha256,plan_sha256:plan.record_sha256});}
  }
  const publications=store.listRecords?.('native_document_temporal_publication_v1')??[];
  const allOrigins=store.listRecords?.('native_document_temporal_origin_v1')??[];
  for(const saved of publications.filter(p=>p.library_id===libraryId&&(p.status==='CONFIRMED'||p.status==='PREPARED'&&p.run_id===runId)))try {
    const publication=signed(saved),request=publication.request;
    need(request?.library_id===libraryId&&Array.isArray(request.updates),'TEMPORAL_LINEAGE_REQUEST_INVALID');
    const binding=signed(store.getRecord('native_document_temporal_binding_v1',publication.run_id));
    const stage=signed(store.getRecord('native_document_temporal_interpretation_v1',publication.run_id));
    need(binding.library_id===libraryId&&binding.run_id===publication.run_id&&stage.library_id===libraryId&&stage.run_id===publication.run_id
      &&stage.finished===true&&stage.sealed===true&&binding.input_sha256===hash(binding.input)&&stage.input_sha256===binding.input_sha256
      &&hash(stage.input)===binding.input_sha256,'TEMPORAL_LINEAGE_STAGE_BINDING_CHANGED');
    const context=request.projection_context,source=signed(store.getRecord(REVISION,context?.library_revision_ref));
    need(source.library_id===libraryId&&source.run_id===publication.run_id&&source.source_snapshot_ref===binding.snapshot_id
      &&source.record_sha256===context.library_revision_sha256&&source.record_sha256===binding.library_revision_sha256,'TEMPORAL_LINEAGE_SOURCE_REVISION_CHANGED');
    const plan=signed(store.getRecord('native_temporal_fact_change_plan_v2',canonical([libraryId,request.request_id])));
    const requestHash=hash({library_id:libraryId,request_id:request.request_id,updates:request.updates,expected_head:request.expected_head??null,
      ...(context?{projection_context:context}:{})});
    need(plan.request_sha256===requestHash&&plan.library_id===libraryId&&plan.request_id===request.request_id
      &&plan.host_base_sha256===hash(plan.base),'TEMPORAL_LINEAGE_KERNEL_PLAN_CHANGED');
    const origins=publication.status==='PREPARED'?list(publication.origins):allOrigins.filter(o=>o.library_id===libraryId&&o.source_run_id===publication.run_id).map(signed);
    const accepted=[];
    for(const proposal of list(stage.interpretations)) {
      const items=list(binding.input.incoming).filter(k=>k.ref===proposal.knowledge_ref);if(items.length!==1)continue;
      const item=items[0],matches=origins.filter(o=>o.signature===item.signature&&o.operation===proposal.operation
        &&o.knowledge_ref===(item.knowledge.knowledge_ref??item.knowledge.record_ref));
      if(!matches.length)continue;
      need(matches.length===1,'TEMPORAL_LINEAGE_ORIGIN_AMBIGUOUS');accepted.push({proposal,item});
    }
    need(accepted.length===origins.length&&accepted.length===(publication.result?.summary.accepted??origins.length),'TEMPORAL_LINEAGE_ACCEPTED_ORDER_UNRESOLVED');
    const pending=[];let ordinal=0;
    for(const {proposal,item}of accepted) {
      const target=list(binding.input.current).find(f=>f.ref===proposal.target_ref)?.fact;
      const sourceIds=new Set(list(proposal.authority?.evidence_refs).map(ref=>list(binding.input.evidence).find(e=>e.ref===ref)?.source_version_id));
      const count=proposal.operation==='ADD_SUPPORT'?list(item.sources).filter(s=>!sourceIds.size||sourceIds.has(s.source_version_id)).length:1;
      need(count>0,'TEMPORAL_LINEAGE_UPDATE_COUNT_UNRESOLVED');
      const originals=list(source.knowledge).filter(k=>(k.knowledge_ref??k.record_ref)===(item.knowledge.knowledge_ref??item.knowledge.record_ref));
      const knowledgeRef=item.knowledge.knowledge_ref??item.knowledge.record_ref;let slot=null;
      try {need(originals.length===1,'TEMPORAL_LINEAGE_SOURCE_KNOWLEDGE_AMBIGUOUS');slot=sourceSlot(originals[0],item.knowledge);}
      catch(cause){warnings.push({code:cause.code??'TEMPORAL_LINEAGE_SLOT_UNRESOLVED',source_run_id:publication.run_id,incoming_ref:item.ref,knowledge_ref:knowledgeRef});}
      for(let offset=0;offset<count;offset++,ordinal++) {
        const update=request.updates[ordinal];need(update?.kind===proposal.operation,'TEMPORAL_LINEAGE_UPDATE_ORDER_UNRESOLVED');
        let factId;
        if(['ADD_FACT','STATE_CHANGE'].includes(update.kind))factId='fact_'+hash([libraryId,request.request_id,ordinal]);
        else {
          need(['CORRECT','ADD_SUPPORT'].includes(update.kind)&&target&&target.fact_version_id===update.target_version_id,'TEMPORAL_LINEAGE_TARGET_UNRESOLVED');
          const base=list(plan.base.versions).find(v=>v.fact_version_id===target.fact_version_id);need(base?.fact_id===target.fact_id,'TEMPORAL_LINEAGE_TARGET_UNRESOLVED');factId=target.fact_id;
        }
        const kernelVersions=list(plan.kernel_plan?.new_versions).filter(v=>v.fact_id===factId);
        const kernelVersion=kernelVersions.length===1?kernelVersions[0]:update.kind==='ADD_SUPPORT'?target:null;
        need(kernelVersion?.fact_id===factId,'TEMPORAL_LINEAGE_KERNEL_ID_UNRESOLVED');
        if(slot)pending.push([factId,{knowledge_ref:knowledgeRef,slot,source_slot_ref:canonical([knowledgeRef,slot]),original_attribute_slot:slot.kind==='ENTITY_ATTRIBUTE'?slot:null,
          source_run_id:publication.run_id,source_snapshot_ref:binding.snapshot_id,
          incoming_ref:item.ref,proposal_ref:proposal.raw_proposal_ref??null,request_id:request.request_id,update_index:ordinal,operation:update.kind,
          kernel_fact_version_id:kernelVersion.fact_version_id,binding_sha256:binding.record_sha256,interpretation_sha256:stage.record_sha256,plan_sha256:plan.record_sha256}]);
      }
    }
    need(ordinal===request.updates.length,'TEMPORAL_LINEAGE_UPDATE_COUNT_UNRESOLVED');
    for(const [factId,b]of pending)add(factId,b);
  } catch(cause){warnings.push({code:cause.code??'TEMPORAL_LINEAGE_UNRESOLVED',source_run_id:saved.run_id});}
  const lineage=versions.map(v=>{
    const bindings=byFact.get(v.fact_id)??[],sourceSlots=distinct(bindings.map(b=>({knowledge_ref:b.knowledge_ref,slot:b.slot,slot_ref:canonical([b.knowledge_ref,b.slot])})));
    if(!bindings.length)warnings.push({code:'TEMPORAL_LINEAGE_UNRESOLVED',fact_id:v.fact_id,fact_version_id:v.fact_version_id});
    return {schema:'TEMPORAL_KNOWLEDGE_LINEAGE_V1',fact_id:v.fact_id,fact_version_id:v.fact_version_id,
      status:bindings.length?'EXACT_PROGRAM_BINDING':'UNRESOLVED',source_knowledge_refs:unique(bindings.map(b=>b.knowledge_ref)),source_slots:sourceSlots,bindings};
  });
  return {lineage,warnings};
}

function temporalGraph(records) {
  const graph=createDomainGraph(records),byRef=new Map(records.map(r=>[r.knowledge_ref??r.record_ref,r]));
  const annotate=item=>{
    const rows=list(item.record_refs).map(ref=>byRef.get(ref)).filter(r=>r?.temporal_fact),times=rows.map(r=>({fact_id:r.temporal_fact.fact_id,
      fact_version_id:r.temporal_fact.fact_version_id,valid_time:clone(r.valid_time),asserted_valid_time:clone(r.asserted_valid_time),temporal_lineage:clone(r.temporal_lineage)}));
    return {...item,...(times.length?{temporal_versions:times}:{}),...(times.length===1?times[0]:{})};
  };
  return {...graph,edges:graph.edges.map(annotate),nodes:graph.nodes.map(n=>({...n,attributes:list(n.attributes).map(annotate)}))};
}

/** Separate read envelope over an immutable signed revision. Never writes a revision, graph or index. */
export function readTemporalKnowledgeProjection({store,libraryId,runId,revisionRef,revisionSha256}) {
  const revision=signed(store.getRecord(REVISION,revisionRef));
  need(revision.library_id===libraryId&&revision.run_id===runId&&revision.record_sha256===revisionSha256,'TEMPORAL_READ_PROJECTION_BASIS_CHANGED');
  const rows=list(revision.knowledge),versions=rows.filter(r=>r.temporal_fact).map(r=>r.temporal_fact),
    proof=temporalLineage({store,libraryId,runId,versions,knowledge:rows});
  let selection={policy:'EXACT_CONFIRMED_REVISION_MEMBERSHIP',confirmed:false,activation:null,is_current_library_revision:false};
  try {
    const events=store.db?.prepare('SELECT payload FROM memory_knowledge_activation_events_v1 WHERE library_id=?').all(libraryId)
      .map(r=>signed(JSON.parse(r.payload))).filter(e=>e.view.library_revision_ref===revisionRef&&e.view.library_revision_sha256===revisionSha256)??[];
    need(events.length===1&&new Set(versions.map(v=>v.fact_id)).size===versions.length,'TEMPORAL_PROJECTION_ADOPTION_UNRESOLVED');
    const event=events[0],pointer=store.getRecord(ACTIVE,libraryId);
    selection={...selection,confirmed:true,activation:{activation_ref:event.activation_ref,activation_seq:event.activation_seq,activated_at:event.activated_at},
      is_current_library_revision:pointer?.revision_ref===revisionRef&&pointer?.record_sha256===revisionSha256};
  }catch(cause){proof.warnings.push({code:cause.code??'TEMPORAL_PROJECTION_ADOPTION_UNRESOLVED'});}
  proof.lineage=proof.lineage.map(l=>({...l,adopted_in_bound_view:selection.confirmed,
    display_relation:selection.confirmed&&l.status==='EXACT_PROGRAM_BINDING'&&l.source_slots.length?'CURRENT_VERSION_OF_SOURCE_SLOT':'DERIVED_ONLY'}));
  const byVersion=new Map(proof.lineage.map(l=>[l.fact_version_id,l])),
    entities=rows.flatMap(r=>r.domain?.entities??[]),knowledge=rows.map(r=>projectTemporalKnowledgeRecord(r,{lineage:byVersion.get(r.temporal_fact?.fact_version_id),entities}));
  const current=projectNativeSimplifiedCurrentKnowledge(knowledge),currentGraph={...clone(revision.domain_graph??{}),...temporalGraph(current.knowledge),revision_ref:revisionRef};
  const currentBinding={schema:'CURRENT_LINEAGE_READ_BINDING_V1',status:selection.confirmed?'BOUND_CONFIRMED_REVISION':'UNCONFIRMED_DO_NOT_ADOPT',
    library_id:libraryId,run_id:runId,revision_ref:revisionRef,record_sha256:revisionSha256,activation:clone(selection.activation),
    is_current_library_revision:selection.is_current_library_revision,usable_for_current_view:selection.confirmed&&selection.is_current_library_revision,
    knowledge_sha256:hash(current.knowledge),graph_sha256:hash(currentGraph),replacements_sha256:hash(current.replacements)};
  const body={schema:'TEMPORAL_KNOWLEDGE_READ_PROJECTION_V1',basis:{library_id:libraryId,run_id:runId,revision_ref:revisionRef,record_sha256:revisionSha256},
    knowledge,temporal_graph:temporalGraph(knowledge.filter(r=>r.temporal_fact)),lineage:proof.lineage,selection,
    current_knowledge:current.knowledge,current_graph:currentGraph,current_lineage_projection:{policy:current.policy,replacements:current.replacements,warnings:current.warnings,
      binding:{...currentBinding,binding_sha256:hash(currentBinding)}},
    warnings:[...proof.warnings,...knowledge.flatMap(r=>list(r.temporal_projection?.warnings).map(code=>({code,record_ref:r.record_ref})))],
    historical_artifacts_modified:false};
  return {...body,projection_sha256:hash(body)};
}

// Existing graph entries and definitions remain the saved basis; temporal rows only add their own projection.
function mergeGraphs(saved, temporal) {
  need(saved&&Array.isArray(saved.nodes)&&Array.isArray(saved.edges)&&Array.isArray(saved.knowledge),'TEMPORAL_INDEX_EXISTING_GRAPH_REQUIRED');
  const nodes=new Map(saved.nodes.map(node=>[node.id,clone(node)]));
  for(const node of temporal.nodes) {
    const old=nodes.get(node.id);
    nodes.set(node.id,old?{...old,attributes:distinct([...(old.attributes??[]),...(node.attributes??[])]),
      rules:distinct([...(old.rules??[]),...(node.rules??[])]),record_refs:unique([...(old.record_refs??[]),...(node.record_refs??[])]),
      source_refs:distinct([...(old.source_refs??[]),...(node.source_refs??[])])}:clone(node));
  }
  const byId=(a,b)=>{const key=item=>item.id??item.definition_ref??'exact_'+hash(item),items=new Map(a.map(item=>[key(item),clone(item)]));
    for(const item of b)if(!items.has(key(item)))items.set(key(item),clone(item));return [...items.values()];};
  return {...clone(saved),nodes:[...nodes.values()],edges:byId(saved.edges,temporal.edges),
    definitions:[...(saved.definitions??[]),...(temporal.definitions??[])],knowledge:[...clone(saved.knowledge),...clone(temporal.knowledge)]};
}

export function createTemporalIndexView({store, rawCoreForLibrary, preserveExisting = false, catalog = null, embeddingRuntime = null}) {
  need(store?.db && ['getRecord', 'putRecord', 'transaction'].every(key => typeof store[key] === 'function')
    && typeof rawCoreForLibrary === 'function', 'TEMPORAL_INDEX_HOST_REQUIRED');
  const active = libraryId => clone(store.getRecord(ACTIVE, libraryId));
  function ensureSnapshot(libraryId) {
    const snapshotId = 'temporal_snapshot_' + hash(libraryId);
    const snapshot = {schema_version: 'MEMORY_PRODUCT_SNAPSHOT_V1', snapshot_id: snapshotId,
      source_snapshot_ref: snapshotId, library_id: libraryId, documents: [], source_epoch: 0,
      fingerprint: hash(['MEMORY_PRODUCT_SOURCE_FAMILY_V1', libraryId]), source_kind: 'MEMORY_RECORD_SOURCE',
      source_manifest_location: 'IMMUTABLE_LIBRARY_REVISION'};
    immutable(store, 'cq_v2_snapshot', snapshotId, snapshot);
    return snapshotId;
  }
  function assertSnapshot(plan) {
    const snapshot = store.getRecord('cq_v2_snapshot', plan.source_snapshot_ref);
    if(plan.preserved_library_basis) {
      need(snapshot?.library_id===plan.library_id&&snapshot.snapshot_id===plan.source_snapshot_ref
        &&hash(snapshot)===plan.source_snapshot_sha256,'TEMPORAL_INDEX_SOURCE_SNAPSHOT_CHANGED');
      if(catalog)need(same(catalog.get(plan.source_snapshot_ref,plan.library_id),snapshot)
        ,'TEMPORAL_INDEX_SOURCE_SNAPSHOT_CHANGED');
      return;
    }
    need(snapshot?.schema_version === 'MEMORY_PRODUCT_SNAPSHOT_V1' && snapshot.library_id === plan.library_id
      && snapshot.snapshot_id === plan.source_snapshot_ref && snapshot.source_snapshot_ref === snapshot.snapshot_id
      && Array.isArray(snapshot.documents) && snapshot.documents.length === 0 && snapshot.source_epoch === 0
      && snapshot.fingerprint === hash(['MEMORY_PRODUCT_SOURCE_FAMILY_V1', plan.library_id])
      && hash(snapshot) === plan.source_snapshot_sha256, 'TEMPORAL_INDEX_SOURCE_SNAPSHOT_CHANGED');
  }
  const indexFor = plan => createNativeBuildIndex({store, libraryId: plan.library_id, runId: plan.run_id,
    snapshotId: plan.source_snapshot_ref, assertOpen() {assertSnapshot(plan);}});

  function checkedSources(libraryId, refs) {
    const core = rawCoreForLibrary(libraryId);
    need(core && typeof core.getRawRecord === 'function', 'TEMPORAL_INDEX_RAW_CORE_REQUIRED');
    const raws = new Map();
    for (const source of refs) {
      need(source && textField(source.source_version_id) && ['SUPPORT', 'BACKGROUND'].includes(source.role)
        && ['DOCUMENT', 'OBSERVATION', 'HUMAN_REVISION', 'SOURCE_REVISION'].includes(source.kind), 'TEMPORAL_INDEX_SOURCE_INVALID');
      const raw = raws.get(source.source_version_id) ?? core.getRawRecord(source.source_version_id);
      need(raw?.schema_version === 'MEMORY_RECORD_V1' && raw.library_id === libraryId
        && raw.record_ref === source.source_version_id && Number.isSafeInteger(raw.version) && raw.version > 0
        && textField(raw.text), 'TEMPORAL_INDEX_RAW_SOURCE_CHANGED');
      if (source.kind === 'HUMAN_REVISION') need(raw.source?.kind === 'HUMAN_TEXT', 'TEMPORAL_INDEX_HUMAN_SOURCE_KIND_CHANGED');
      if (source.kind === 'DOCUMENT') need(raw.source?.kind === 'DOCUMENT', 'TEMPORAL_INDEX_DOCUMENT_SOURCE_KIND_CHANGED');
      if (source.quote !== null && source.quote !== undefined) need(textField(source.quote) && raw.text.includes(source.quote), 'TEMPORAL_INDEX_QUOTE_CHANGED');
      raws.set(raw.record_ref, raw);
    }
    const recordRefs = [...raws.keys()].sort();
    if (!recordRefs.length) return [];
    return registerMemorySourceBindings({store, coreForLibrary: rawCoreForLibrary, libraryId, recordRefs});
  }

  function knowledgeRecord(version, links, bySource, scope, projection={}) {
    const sources = distinct([...(version.sources ?? []), ...links.map(link => link.source)]);
    const support = sources.filter(source => source.role === 'SUPPORT');
    need(support.length > 0, 'TEMPORAL_INDEX_SUPPORT_REQUIRED');
    const source_refs = unique(support.map(source => source.source_version_id)).map(ref => {
      const binding = bySource.get(ref); need(binding, 'TEMPORAL_INDEX_SOURCE_BINDING_MISSING'); return sourceRef(binding);
    });
    const evidence = [], recordProofs = [];
    for (const source of support) {
      const binding = bySource.get(source.source_version_id);
      const bound = bindNativeActionEvidence({source_record_ref: binding.record_ref, revision: binding.revision, text: binding.text},
        {source_record_ref: binding.record_ref, revision: binding.revision, quote: source.quote ?? null,
          document_evidence_eligible: false});
      if (bound.evidence_binding.proof_scope === 'LOCATED_SOURCE_SPAN') {
        const {start, end} = bound.evidence_binding.span_utf16;
        // Quote validation happened against the actual immutable raw record, not a model offset.
        evidence.push({...bound, kind: 'MEMORY_RECORD_EVIDENCE',
          evidence_ref: 'temporal_evidence_' + hash([scope.library_id, binding.record_ref, binding.revision, start, end, bound.quote]),
          start, end, offset_unit: 'utf16_code_unit', mapping_precision: 'RECORD_EXACT_SPAN', position_disambiguated: true});
      } else {
        recordProofs.push({...bound, kind: 'MEMORY_RECORD_SOURCE_PROOF', quote: null,
          proof_ref: 'temporal_record_proof_' + hash([scope.library_id, binding.record_ref, binding.revision, bound.evidence_binding, bound.model_quote]),
          mapping_precision: 'SOURCE_RECORD_ONLY'});
      }
    }
    const content = version.content;
    need(content && textField(content.subject_ref) && textField(content.predicate) && Object.hasOwn(content, 'value')
      && typeof content.negated === 'boolean' && textField(content.modality), 'TEMPORAL_INDEX_FACT_CONTENT_INVALID');
    const text = [content.subject_ref, content.predicate, JSON.stringify(content.value),
      'conditions: ' + canonical(content.conditions ?? null), 'negated: ' + content.negated,
      'modality: ' + content.modality, 'valid_time: ' + canonical(version.valid_time)].join('\n');
    return projectTemporalKnowledgeRecord({...scope, record_ref: version.fact_version_id, knowledge_ref: version.fact_version_id,
      fact_ref: version.fact_version_id, fact_id: version.fact_id,
      representation: 'EXTRACTED_KNOWLEDGE', answer_authority: 'EXTRACTED_KNOWLEDGE',
      origin_layer: 'TEMPORAL_FACT_VERSION', semantic_policy: DOMAIN_SEMANTIC_POLICY,
      kind: 'TEXT', subject_ref: content.subject_ref, predicate: content.predicate,
      raw_value: clone(content.value), text, statement: text,
      conditions: clone(content.conditions ?? null), negation: content.negated, modality: content.modality,
      valid_time: clone(version.valid_time), asserted_valid_time: clone(version.asserted_valid_time),
      source_refs, source_record_refs: source_refs.map(source => source.record_ref),
      evidence: distinct(evidence), evidence_refs: unique(evidence.map(item => item.evidence_ref)),
      record_source_evidence: distinct(recordProofs),
      temporal_fact: {...clone(version), support_links: clone(links)},
      domain: {entities: [{id: content.subject_ref, name: content.subject_ref, label: content.subject_ref,
        kind: 'ENTITY', identity_policy: 'EXACT_SOURCE_LOCAL_REF_ONLY_NO_CANONICAL_MERGE', source_refs: clone(source_refs)}]}},projection);
  }

  async function prepare({library_id, request_id, versions, support_links,context=null,runtimeOverride=null}) {
    need(store.db.isTransaction === false, 'TEMPORAL_INDEX_PREPARE_REQUIRES_TRANSACTION_OUTSIDE');
    need(textField(library_id) && textField(request_id) && Array.isArray(versions) && Array.isArray(support_links), 'TEMPORAL_INDEX_PREPARE_INVALID');
    const ids = versions.map(version => version.fact_version_id);
    need(ids.every(textField) && new Set(ids).size === ids.length && versions.every(version => textField(version.fact_id)), 'TEMPORAL_INDEX_FACT_VERSION_INVALID');
    const candidateIds = new Set(ids), links = support_links.filter(link => candidateIds.has(link.fact_version_id));
    const sourceRefs = distinct([...versions.flatMap(version => version.sources ?? []), ...links.map(link => link.source)]);
    const bindings = checkedSources(library_id, sourceRefs), bySource = new Map(bindings.map(binding => [binding.record_ref, binding]));
    const before = active(library_id);
    const previous=before?signed(store.getRecord(REVISION,before.revision_ref)):null;
    if(previous)need(previous.library_id===library_id&&previous.run_id===before.run_id
      &&previous.source_snapshot_ref===before.source_snapshot_ref&&previous.record_sha256===before.record_sha256,'TEMPORAL_INDEX_LIBRARY_SCOPE_CHANGED');
    let preserved=null;
    if(preserveExisting&&previous) {
      const ref=previous.temporal_preserved_basis?.revision_ref??(previous.temporal_policy?null:previous.revision_ref);
      if(ref) {
        preserved=signed(store.getRecord(REVISION,ref));
        need(preserved.library_id===library_id&&preserved.run_id===before.run_id
          &&preserved.source_snapshot_ref===before.source_snapshot_ref,'TEMPORAL_INDEX_LIBRARY_SCOPE_CHANGED');
      }
    }
    const oldScope=before?{run_id:before.run_id,source_snapshot_ref:before.source_snapshot_ref}:null;
    let incoming=null;
    if(context) {
      incoming=signed(store.getRecord(REVISION,context.library_revision_ref));
      need(incoming.library_id===library_id&&incoming.run_id===context.run_id&&incoming.source_snapshot_ref===context.source_snapshot_ref
        &&incoming.record_sha256===context.library_revision_sha256,'TEMPORAL_DOCUMENT_REVISION_CHANGED');
      const incomingBasis=incoming.library_basis;
      need(incomingBasis?.revision_ref?before?.revision_ref===incomingBasis.revision_ref&&before.record_sha256===incomingBasis.record_sha256:!before,'TEMPORAL_INDEX_LIBRARY_ACTIVE_BASIS_CHANGED');
      const rebind=row=>{const value=clone(row);for(const [name,v]of Object.entries({library_id,run_id:context.run_id,source_snapshot_ref:context.source_snapshot_ref}))if(Object.hasOwn(value,name))value[name]=v;
        if(Array.isArray(value.evidence))value.evidence=value.evidence.map(rebind);return value;};
      const rows=new Map((incoming.policy==='SIMPLIFIED_LIBRARY_KNOWLEDGE_V1'?[]:preserved?.knowledge??[]).map(row=>[row.knowledge_ref??row.record_ref,rebind(row)]));
      for(const row of incoming.knowledge)rows.set(row.knowledge_ref??row.record_ref,rebind(row));
      const incomingGraph=incoming.domain_graph??{...createDomainGraph(incoming.knowledge),identity:clone(incoming.identity),ontology:clone(incoming.ontology),
        definitions:distinct([...(createDomainGraph(incoming.knowledge).definitions??[]),...(incoming.ontology?.definitions??[])]),revision_ref:incoming.revision_ref};
      const graph=incoming.policy==='SIMPLIFIED_LIBRARY_KNOWLEDGE_V1'?clone(incomingGraph):preserved?mergeGraphs(preserved.domain_graph,incomingGraph):clone(incomingGraph);
      const body={library_id,run_id:context.run_id,source_snapshot_ref:context.source_snapshot_ref,policy:incoming.policy==='SIMPLIFIED_LIBRARY_KNOWLEDGE_V1'?incoming.policy:'LIBRARY_KNOWLEDGE_V1',...(incoming.policy==='SIMPLIFIED_LIBRARY_KNOWLEDGE_V1'?{source_fingerprint:incoming.source_fingerprint,query_groups:clone(incoming.query_groups??[]),...(incoming.coverage?{coverage:clone(incoming.coverage)}:{})}:{}),
        knowledge:[...rows.values()],identity:clone(incoming.identity),ontology:clone(incoming.ontology),
        source_manifest:distinct([...(preserved?.source_manifest??[]),...(incoming.source_manifest??[])]),
        document_basis:{incoming_revision_ref:incoming.revision_ref,incoming_revision_sha256:incoming.record_sha256,
          previous_revision_ref:preserved?.revision_ref??null,previous_revision_sha256:preserved?.record_sha256??null,
          graph_projection:incoming.domain_graph?'SAVED_GRAPH':'PROGRAM_CREATE_DOMAIN_GRAPH_FROM_SAVED_KNOWLEDGE'}};
      const ref='temporal_document_preserved_'+hash(body),complete={...body,revision_ref:ref,
        domain_graph:{...graph,knowledge:[...rows.values()],revision_ref:ref,identity:body.identity,ontology:body.ontology}};
      preserved={...complete,record_sha256:hash(complete)};immutable(store,REVISION,ref,preserved);
    }
    const runId=context?.run_id??(preserved?before.run_id:'temporal_run_'+hash(library_id)),snapshotId=context?.source_snapshot_ref??(preserved?before.source_snapshot_ref:ensureSnapshot(library_id));
    need(context||!before||before.run_id===runId&&before.source_snapshot_ref===snapshotId,'TEMPORAL_INDEX_LIBRARY_SCOPE_CHANGED');
    const scope = {library_id, run_id: runId, source_snapshot_ref: snapshotId};
    const preservedBasis=preserved?{revision_ref:preserved.revision_ref,record_sha256:preserved.record_sha256}:null;
    const basis = {...scope, source_snapshot_sha256: hash(store.getRecord('cq_v2_snapshot', snapshotId)),
      ...(preservedBasis?{preserved_library_basis:preservedBasis}:{})};
    assertSnapshot(basis);
    if(catalog&&preserved)need(catalog.isCurrent(snapshotId,library_id),'TEMPORAL_INDEX_SOURCE_SNAPSHOT_STALE');
    const lineageProof=temporalLineage({store,libraryId:library_id,runId,versions,knowledge:previous?.knowledge??[]}),
      lineageByVersion=new Map(lineageProof.lineage.map(l=>[l.fact_version_id,l])),entities=[...list(previous?.knowledge),...list(preserved?.knowledge)].flatMap(r=>r.domain?.entities??[]);
    const temporalKnowledge = [...versions].sort((a,b) => a.fact_version_id.localeCompare(b.fact_version_id))
      .map(version => knowledgeRecord(version, links.filter(link => link.fact_version_id === version.fact_version_id), bySource, scope,
        {lineage:lineageByVersion.get(version.fact_version_id),entities}));
    const retained=clone(preserved?.knowledge??[]),knowledge=[...retained,...temporalKnowledge];
    const currentProjection=projectNativeSimplifiedCurrentKnowledge(knowledge),currentKnowledge=currentProjection.knowledge;
    const currentGraph=temporalGraph(currentKnowledge);let graphBase=preserved?{...clone(preserved.domain_graph),...currentGraph,
      definitions:distinct([...(preserved.domain_graph.definitions??[]),...(currentGraph.definitions??[])])}:currentGraph;
    const identity = clone(preserved?.identity??{policy: 'EXACT_SOURCE_LOCAL_REF_ONLY_NO_CANONICAL_MERGE', stage_status: 'SOURCE_LOCAL',
      entities: graphBase.nodes.map(node => ({id: node.id, name: node.name ?? node.id, source_refs: clone(node.source_refs ?? [])})),
      mappings: graphBase.nodes.map(node => ({source_local_ref: node.id, entity_ref: node.id, decision: 'EXACT_REF_ONLY'})), pending: []});
    let ontology = clone(preserved?.ontology??{policy: 'SOURCE_LOCAL_DEFINITIONS_ONLY_NO_ONTOLOGY_ADOPTION', stage_status: 'SOURCE_LOCAL',
      definitions: graphBase.definitions.map(definition => ({...clone(definition), status: 'SOURCE_LOCAL'})),
      definition_mappings: [], unbound_shapes: [], summary: {pending: 0, unbound: 0}});
    const definitionReconciliation=reconcileGraphDefinitions({graph:{...graphBase,identity,ontology,definitions:preserved?graphBase.definitions:ontology.definitions},ontology,knowledge,basis});
    graphBase=definitionReconciliation.graph;ontology=definitionReconciliation.ontology;
    const sourceManifest = distinct([...clone(preserved?.source_manifest??[]),...bindings.map(binding => ({kind: binding.kind, record_ref: binding.record_ref,
      version: binding.version, revision: binding.revision, source_kind: binding.source_kind,
      text_sha256: binding.text_sha256, source_ingested_at: binding.source_ingested_at,
      origin: binding.origin, document_evidence_eligible: false}))]);
    const seed = {...scope, request_id,...(definitionReconciliation.changed?{definition_reconciliation:definitionReconciliation.projection}:{}), policy: preserved?.policy==='SIMPLIFIED_LIBRARY_KNOWLEDGE_V1'?preserved.policy:'LIBRARY_KNOWLEDGE_V1',...(preserved?.policy==='SIMPLIFIED_LIBRARY_KNOWLEDGE_V1'?{source_fingerprint:preserved.source_fingerprint,query_groups:clone(preserved.query_groups??[]),...(preserved.coverage?{coverage:clone(preserved.coverage)}:{}),input_sha256:hash({libraryId:library_id,snapshotId,knowledge,cqInput:store.getRecord('native_library_knowledge_input_v1',runId)?.cq_input,families:store.getRecord('native_library_knowledge_input_v1',runId)?.families})}:{}),knowledge, identity, ontology,
      source_manifest: sourceManifest, ...(preservedBasis?{temporal_preserved_basis:preservedBasis}:{}),library_basis: {revision_ref: before?.revision_ref ?? null,
      record_sha256: before?.record_sha256 ?? null}, temporal_policy: 'RUST_WORLD_TIME_RULES_ONLY',
      temporal_projection:{schema:'TEMPORAL_KNOWLEDGE_PROJECTION_V1',lineage_warnings:lineageProof.warnings,current_lineage_projection:{policy:currentProjection.policy,replacements:currentProjection.replacements,warnings:currentProjection.warnings}}};
    const revisionRef = 'temporal_library_revision_' + hash(seed);
    const revisionBody = {...seed, revision_ref: revisionRef,
      domain_graph: {...graphBase, identity, ontology, definitions: preserved?graphBase.definitions:ontology.definitions,
        revision_ref: revisionRef, scope: 'CURRENT_COMPLETE_LIBRARY'}};
    const revision = {...revisionBody, record_sha256: hash(revisionBody)};
    immutable(store, REVISION, revisionRef, revision);
    const newSources = bindings.map(binding => {
      const evidence = {kind: 'MEMORY_RECORD_EVIDENCE', source_record_ref: binding.record_ref, revision: binding.revision,
        evidence_ref: 'temporal_verbatim_' + hash([library_id, binding.record_ref, binding.revision, binding.text_sha256]),
        start: 0, end: binding.text.length, quote: binding.text, offset_unit: 'utf16_code_unit', document_evidence_eligible: false};
      return {...scope, record_ref: binding.record_ref, representation: 'VERBATIM_SOURCE', text: binding.text,
        source_refs: [sourceRef(binding)], source_record_refs: [binding.record_ref], evidence: [evidence], evidence_refs: [evidence.evidence_ref]};
    });
    let oldSources=[],capability='LEXICAL',embeddingSpace=null,embed=null;const embeddingUsage=[];
    if(preserved&&oldScope) {
      const oldHead=store.getRecord('native_source_index_head_v1',canonical([library_id,oldScope.source_snapshot_ref,oldScope.run_id]));
      const oldPayload=oldHead&&store.getRecord('native_source_index_payload_v1',oldHead.payload_ref);
      need(oldPayload&&hash(oldPayload)===oldHead.payload_sha256,'TEMPORAL_INDEX_EXISTING_SOURCE_CHANGED');
      const rebind=row=>{const value=clone(row);for(const [name,v]of Object.entries(scope))if(Object.hasOwn(value,name))value[name]=v;
        if(Array.isArray(value.evidence))value.evidence=value.evidence.map(rebind);return value;};
      oldSources=oldPayload.records.map(rebind);
      const knowledgeHead=store.getRecord('native_knowledge_index_head_v1',canonical([library_id,oldScope.source_snapshot_ref,oldScope.run_id]));
      const knowledgePayload=knowledgeHead&&store.getRecord('native_knowledge_index_payload_v1',knowledgeHead.payload_ref);
      need(knowledgePayload&&hash(knowledgePayload)===knowledgeHead.payload_sha256
        &&knowledgePayload.capability===oldPayload.capability&&same(knowledgePayload.embedding_space,oldPayload.embedding_space),'TEMPORAL_INDEX_EXISTING_SPACE_CHANGED');
      capability=oldPayload.capability;embeddingSpace=clone(oldPayload.embedding_space);
    }
    if(context) {
      if(oldScope)need(capability===context.capability&&same(embeddingSpace,context.capability==='LEXICAL'?null:normalizedSpace(context.embedding_space)),'TEMPORAL_INDEX_EXISTING_SPACE_CHANGED');
      else {capability=context.capability;embeddingSpace=capability==='LEXICAL'?null:normalizedSpace(context.embedding_space);}
      const snapshot=store.getRecord('cq_v2_snapshot',snapshotId);
      for(const doc of snapshot.documents??[])if(textField(doc.content)) {
        const source={doc_ref:doc.doc_id,revision:doc.revision},ref='temporal_document_source_'+hash(source),evidence={...scope,...source,evidence_ref:ref+'_full',start:0,end:doc.content.length,quote:doc.content,offset_unit:'utf16_code_unit'};
        const fragments=oldSources.filter(r=>r.knowledge_ref===ref&&r.retrieval_fragment);if(fragments.length){let end=0;for(const fragment of [...fragments].sort((a,b)=>a.retrieval_fragment.start-b.retrieval_fragment.start)){const span=fragment.retrieval_fragment;need(span.start===end&&Number.isInteger(span.end)&&span.end>span.start&&fragment.text===doc.content.slice(span.start,span.end)&&same(fragment.source_refs,[source])&&fragment.representation==='VERBATIM_SOURCE','TEMPORAL_INDEX_SOURCE_FRAGMENT_REUSE_CONFLICT');end=span.end;}need(end===doc.content.length,'TEMPORAL_INDEX_SOURCE_FRAGMENT_REUSE_CONFLICT');const refs=new Set(fragments.map(r=>r.record_ref));oldSources=oldSources.filter(r=>!refs.has(r.record_ref));}
        const retained=oldSources.find(r=>r.record_ref===ref);if(retained){need(retained.text===doc.content&&retained.representation==='VERBATIM_SOURCE'&&same(retained.source_refs,[source]),'TEMPORAL_INDEX_SOURCE_REUSE_CONFLICT');}else oldSources.push({...scope,record_ref:ref,representation:'VERBATIM_SOURCE',text:doc.content,source_refs:[source],evidence:[evidence],evidence_refs:[evidence.evidence_ref]});
      }
    }
    const selectedEmbeddingRuntime=context&&runtimeOverride?()=>runtimeOverride:embeddingRuntime;
    if(capability!=='LEXICAL') {
        need(typeof selectedEmbeddingRuntime==='function','TEMPORAL_INDEX_EMBEDDING_NOT_READY');
        let configured;try{configured=selectedEmbeddingRuntime();}catch{need(false,'TEMPORAL_INDEX_EMBEDDING_NOT_READY');}
        need(typeof configured?.embed==='function'&&same(normalizedSpace(configured.embeddingSpace),embeddingSpace),'TEMPORAL_INDEX_EMBEDDING_SPACE_MISMATCH');
        const assertSpace=()=>{need(store.db.isTransaction===false,'TEMPORAL_INDEX_EMBEDDING_REQUIRES_TRANSACTION_OUTSIDE');
          need(same(normalizedSpace(selectedEmbeddingRuntime()?.embeddingSpace),embeddingSpace),'TEMPORAL_INDEX_EMBEDDING_SPACE_CHANGED');};
        embed=async(texts,options)=>{assertSpace();const response=await configured.embed(texts,options);assertSpace();
          const vectors=Array.isArray(response)?response:response?.vectors;need(Array.isArray(vectors),'TEMPORAL_INDEX_EMBEDDING_RESPONSE_INVALID');
          embeddingUsage.push({inputs:texts.length,input_type:options?.inputType??'document',embedding_space_sha256:hash(embeddingSpace),provider_usage:clone(response?.usage??null)});return vectors;};
    }
    const newRefs=new Set(newSources.map(row=>row.record_ref));
    const sources=mergeTemporalSourceRecords(oldSources,newSources);
    const indexPrepared = await indexFor(basis).prepareKnowledge({sources, knowledge:currentKnowledge, libraryKnowledge: revision,
      capability,embed,embeddingSpace});
    need(same(active(library_id), before), 'TEMPORAL_INDEX_LIBRARY_ACTIVE_BASIS_CHANGED');
    const planBody = {...basis, request_id, expected_active: before, revision_ref: revisionRef,
      revision_sha256: revision.record_sha256, index_prepared: indexPrepared,
      source_manifest_sha256: hash(sourceManifest), fact_versions_sha256: hash(versions), support_links_sha256: hash(links),
      execution_label: capability==='LEXICAL'?'ACTUAL_NATIVE_INDEX_LEXICAL_ZERO_EMBEDDING':'ACTUAL_NATIVE_INDEX_PRESERVED_SPACE_CACHE_REUSE',
      capability,embedding_space_sha256:embeddingSpace?hash(embeddingSpace):null,embedding_usage:embeddingUsage};
    const projectionRef = 'temporal_index_projection_' + hash(planBody);
    const plan = {...planBody, projection_ref: projectionRef, projection_sha256: hash(planBody)};
    immutable(store, PLAN, projectionRef, plan);
    return {library_id, knowledge_revision_ref: revisionRef, graph_revision_ref: revisionRef,
      source_index_revision: indexPrepared.source_index_revision, knowledge_index_revision: indexPrepared.knowledge_index_revision,
      projection_ref: projectionRef, projection_sha256: plan.projection_sha256};
  }

  function planFor(prepared) {
    const plan = store.getRecord(PLAN, prepared?.projection_ref), {projection_ref, projection_sha256, ...body} = plan ?? {};
    need(plan && projection_sha256 === hash(body) && projection_sha256 === prepared.projection_sha256
      && plan.library_id === prepared.library_id && plan.revision_ref === prepared.knowledge_revision_ref
      && plan.revision_ref === prepared.graph_revision_ref
      && plan.index_prepared.source_index_revision === prepared.source_index_revision
      && plan.index_prepared.knowledge_index_revision === prepared.knowledge_index_revision, 'TEMPORAL_INDEX_PLAN_CHANGED');
    assertSnapshot(plan);
    const revision = signed(store.getRecord(REVISION, plan.revision_ref));
    need(revision.record_sha256 === plan.revision_sha256 && revision.library_id === plan.library_id
      && revision.run_id === plan.run_id && revision.source_snapshot_ref === plan.source_snapshot_ref
      && hash(revision.source_manifest) === plan.source_manifest_sha256, 'TEMPORAL_INDEX_LIBRARY_BINDING_CHANGED');
    for (const [view, kind] of [['SOURCE', 'native_source_index_payload_v1'], ['EXTRACTED_KNOWLEDGE', 'native_knowledge_index_payload_v1']]) {
      const pin = plan.index_prepared.views[view], payload = store.getRecord(kind, pin.payload_ref);
      need(payload && hash(payload) === pin.payload_sha256 && payload.index_revision === pin.next_head.index_revision
        && payload.view === view && payload.capability === (plan.capability??'LEXICAL')
        &&(plan.embedding_space_sha256??null)===(payload.embedding_space?hash(payload.embedding_space):null), 'TEMPORAL_INDEX_PAYLOAD_CHANGED');
    }
    return {plan, revision};
  }
  function bindings(prepared) {
    const {plan, revision} = planFor(prepared);
    const pin = view => {const item = plan.index_prepared.views[view]; return {payload_ref: item.payload_ref,
      payload_sha256: item.payload_sha256, index_revision: item.next_head.index_revision};};
    return clone({run_id: plan.run_id, source_snapshot_ref: plan.source_snapshot_ref,
      library_revision_ref: revision.revision_ref, library_revision_sha256: revision.record_sha256,
      source_index: pin('SOURCE'), knowledge_index: pin('EXTRACTED_KNOWLEDGE'),
      graph_sha256: hash(revision.domain_graph), identity_sha256: hash(revision.identity), ontology_sha256: hash(revision.ontology)});
  }
  function applyInTransaction({library_id, prepared}) {
    need(store.db.isTransaction === true, 'TEMPORAL_INDEX_CALLER_TRANSACTION_REQUIRED');
    const {plan, revision} = planFor(prepared);
    if(catalog&&plan.preserved_library_basis)need(catalog.isCurrent(plan.source_snapshot_ref,library_id),'TEMPORAL_INDEX_SOURCE_SNAPSHOT_STALE');
    need(plan.library_id === library_id && same(active(library_id), plan.expected_active), 'TEMPORAL_INDEX_LIBRARY_ACTIVE_BASIS_CHANGED');
    const receipt = indexFor(plan).applyPreparedKnowledge(plan.index_prepared);
    store.putRecord(ACTIVE, library_id, {library_id, run_id: plan.run_id, source_snapshot_ref: plan.source_snapshot_ref,
      revision_ref: revision.revision_ref, record_sha256: revision.record_sha256,
      source_index_revision: prepared.source_index_revision, knowledge_index_revision: prepared.knowledge_index_revision,
      memory_projection_ref: prepared.projection_ref});
    if(revision.policy==='SIMPLIFIED_LIBRARY_KNOWLEDGE_V1'){
      const input=store.getRecord('native_library_knowledge_input_v1',plan.run_id);if(input)store.putRecord('native_library_knowledge_input_v1',plan.run_id,{...input,input_sha256:revision.input_sha256,knowledge:clone(revision.knowledge)});
      store.putRecord('native_library_knowledge_projection_v1',plan.run_id,{run_id:plan.run_id,library_id,revision_ref:revision.revision_ref,record_sha256:revision.record_sha256});
      const head=store.getRecord('native_knowledge_head_v1',plan.run_id);if(head)store.putRecord('native_knowledge_head_v1',plan.run_id,{...head,revision:'knowledge_revision_'+hash(revision.knowledge),knowledge:clone(revision.knowledge),temporal_projection_records:revision.knowledge.filter(row=>row.temporal_fact).length});
      const chain=store.getRecord('native_full_chain_state_v1',plan.run_id);if(chain)store.putRecord('native_full_chain_state_v1',plan.run_id,{...chain,build:{...chain.build,knowledge:clone(revision.knowledge),library_knowledge:clone(revision),library_revision_ref:revision.revision_ref,...indexFor(plan).snapshot()}});
    }
    need(active(library_id)?.memory_projection_ref === prepared.projection_ref, 'TEMPORAL_INDEX_POINTER_READBACK_CHANGED');
    return receipt;
  }
  function assertPreparedCurrent({library_id, prepared}) {
    const {plan, revision} = planFor(prepared), pointer = active(library_id);
    if(catalog&&plan.preserved_library_basis)need(catalog.isCurrent(plan.source_snapshot_ref,library_id),'TEMPORAL_INDEX_SOURCE_SNAPSHOT_STALE');
    need(plan.library_id === library_id && pointer?.memory_projection_ref === prepared.projection_ref
      && pointer.revision_ref === revision.revision_ref && pointer.record_sha256 === revision.record_sha256
      && pointer.run_id === plan.run_id && pointer.source_snapshot_ref === plan.source_snapshot_ref,
    'TEMPORAL_INDEX_ACTIVE_READBACK_CHANGED');
    const index = indexFor(plan), receipt = index.readPreparedKnowledge(plan.index_prepared);
    const graph = index.graph({view: 'EXTRACTED_KNOWLEDGE'}).domain_graph;
    need(receipt.verified === true && graph?.revision_ref === prepared.graph_revision_ref
      && same(graph, revision.domain_graph) && pointer.source_index_revision === receipt.source_index_revision
      && pointer.knowledge_index_revision === receipt.knowledge_index_revision, 'TEMPORAL_INDEX_GRAPH_READBACK_CHANGED');
    return {verified: true, library_id, knowledge_revision_ref: revision.revision_ref,
      graph_revision_ref: graph.revision_ref, source_index_revision: receipt.source_index_revision,
      knowledge_index_revision: receipt.knowledge_index_revision};
  }
  async function readback({library_id, prepared, commit_ref}) {
    need(textField(commit_ref) && rawCoreForLibrary(library_id).getHead()?.commit_ref === commit_ref,
      'TEMPORAL_INDEX_RAW_COMMIT_READBACK_CHANGED');
    const proof = assertPreparedCurrent({library_id, prepared}), {plan, revision} = planFor(prepared);
    return {...proof, evidence_refs: [revision.revision_ref, ...Object.values(plan.index_prepared.views).map(view => view.payload_ref)],
      execution_label: plan.execution_label};
  }
  return Object.freeze({prepare, applyInTransaction, readback, assertPreparedCurrent, bindings});
}
