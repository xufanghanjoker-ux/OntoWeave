/** Read-only, version-bound projections for the LightOG reading workspace.
 * All links come from retained identities. This module never infers knowledge,
 * matches by list position/name, or turns a processing window into paragraph evidence.
 */
import {readNativeDomainGraph} from './native-domain-graph-data-v1.mjs';
import {validateMemoryCurrentViewContract} from './lightog-current-view-contract-v1.mjs';
import {readNativePendingClassification,pendingRecordSources} from './lightog-pending-classification-v1.mjs';

const array = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const strings = value => array(value).filter(text);
const unique = values => [...new Set(values)];
const valueText = value => typeof value === 'string' ? value : '';
const refOf = row => row?.doc_ref ?? row?.doc_id ?? row?.source_ref ?? row?.key ?? row?.id;
const revisionOf = row => row?.revision ?? row?.source_revision ?? null;
const documentIdOf = row => row?.document_id ?? row?.source_document_id ?? row?.parser?.document_id ?? row?.parsing?.document_id ?? null;
const pages = input => Array.isArray(input) ? input.flatMap(value => object(value) && Array.isArray(value.items) ? value.items : [value]) : array(input?.items);
const hasMore = input => (Array.isArray(input) ? input.filter(page => Array.isArray(page?.items)).at(-1) : input)?.has_more === true;
const snapshotMatches = (a, b) => !a?.source_snapshot_ref || !b?.source_snapshot_ref || a.source_snapshot_ref === b.source_snapshot_ref;
const sameVersion = (a, b) => text(refOf(a)) && refOf(a) === refOf(b) && text(revisionOf(a)) && revisionOf(a) === revisionOf(b) && snapshotMatches(a, b);

export const lightogDocumentKey = (docRef, revision = null) => text(docRef) ? docRef + '@' + (text(revision) ? revision : '') : null;

const buildStageSpecs=[
 ['SOURCE','资料解析',['SOURCE_READY'],[]],
 ['CHUNKS','统一分块',['CHUNKS_READY','CHUNKS_IMPORTED_CONFIRMED'],[]],
 ['CQ','CQ 整理',['CQ_SAVED','CQ_IMPORTED_CONFIRMED'],['CQ']],
 ['FAMILY','问题归族',['FAMILIES_SAVED','FAMILIES_IMPORTED_CONFIRMED','CQ_FAMILY_COMPLETE'],['FAMILY']],
 ['EXTRACTION','知识抽取与局部对齐',['ADOPTION_RECORDED','LIBRARY_KNOWLEDGE_FORMED','LIBRARY_KNOWLEDGE_REUSED','SIMPLIFIED_SOURCE_BLOCKS_SAVED'],['SCOPE','EXTRACTION','REVIEW','SEMANTIC','ORGANIZATION','IDENTITY','ONTOLOGY']],
 ['TEMPORAL','时态发布',['TEMPORAL_PUBLICATION_CONFIRMED','SIMPLIFIED_TEMPORAL_PUBLICATION_CONFIRMED'],['TEMPORAL']],
 ['INDEX','图谱与索引发布',['INDEX_COMMITTED','READBACK_VERIFIED'],['INDEX','EMBEDDING']]
];
const buildStateLabels={NOT_STARTED:'未开始',RUNNING:'进行中',COMPLETED:'完成',PARTIAL:'部分完成',INTERRUPTED:'已中断',UNKNOWN:'请求结果未知',UNRECORDED:'未记录',REUSED:'已复用'};
const finiteCount=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const timestamp=value=>typeof value==='number'&&Number.isFinite(value)?value:typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
const roleStage=row=>row.kind==='EMBEDDING'?'INDEX':buildStageSpecs.find(spec=>spec[3].includes(row.role))?.[0]??(/TEMPORAL|DOCUMENT_TIME/.test(row.role??'')?'TEMPORAL':/INDEX|EMBEDDING|READBACK/.test(row.role??'')?'INDEX':/EXTRACTION|SEMANTIC|ORGANIZATION|ONTOLOGY|LIBRARY_KNOWLEDGE|ALIGNMENT|REVIEW/.test(row.role??'')?'EXTRACTION':null);
function buildUsage(attempts){
 const fields={input_tokens:['input_tokens','prompt_tokens'],output_tokens:['output_tokens','completion_tokens'],total_tokens:['total_tokens'],cached_tokens:['cached_tokens','cache_read_input_tokens','cache_hit_tokens']};
 return Object.fromEntries(Object.entries(fields).map(([key,aliases])=>{
  const values=attempts.map(attempt=>{const u=attempt.outcome==='RETURNED'?attempt.usage:null;return aliases.map(alias=>finiteCount(u?.[alias])).find(value=>value!==null)??(key==='cached_tokens'?finiteCount(u?.cached_input_tokens??u?.prompt_tokens_details?.cached_tokens??u?.input_tokens_details?.cached_tokens):null);});
  const known=values.filter(value=>value!==null);return [key,{value:known.length?known.reduce((a,b)=>a+b,0):null,partial:known.length>0&&known.length<attempts.length}];
 }));
}

/** Read-only progress. Missing historic timings stay missing; terminal runs never use the browser clock. */
export function projectLightogBuildProgress(run,{now=Date.now()}={}){
 const snapshot=run?.snapshot??{},ledger=snapshot.run??{},status=run?.status??ledger.status??null;
 const live=['STARTING','OPEN','RUNNING'].includes(status),unknown=['UNKNOWN','UNKNOWN_HOLD'].includes(status),interrupted=['FAILED','STOPPED','BLOCKED'].includes(status),terminal=Boolean(status&&!live);
 const checkpoints=array(ledger.checkpoints),attempts=array(ledger.attempts),invocations=array(snapshot.invocations);
 const candidate=run?.progress_summary??snapshot.progress_summary,summary=candidate?.version==='NATIVE_BUILD_PROGRESS_V1'&&candidate.run_id===run?.run_id?candidate:null;
 const metricIds={SOURCE:'upload_parse',CHUNKS:'chunking',CQ:'cq',FAMILY:'family',EXTRACTION:'extraction_local_alignment',TEMPORAL:'temporal_publication',INDEX:'graph_index_readback'};
 const metrics=array(summary?.stages),lastCheckpoint=Math.max(-1,...buildStageSpecs.flatMap((spec,index)=>checkpoints.some(cp=>spec[2].includes(cp.stage))?[index]:[]));
 const observed=[...attempts,...invocations].filter(row=>roleStage(row)).sort((a,b)=>(timestamp(a.sent_at??a.started_at)??0)-(timestamp(b.sent_at??b.started_at)??0));
 const failed=observed.filter(row=>['FAILED','STOPPED','UNKNOWN','UNKNOWN_HOLD'].includes(row.status??row.outcome)),lastObserved=(unknown||interrupted?failed.at(-1):null)??observed.at(-1);
 const observedIndex=buildStageSpecs.findIndex(spec=>spec[0]===roleStage(lastObserved??{})),phaseIndex=buildStageSpecs.findIndex(spec=>spec[0]===roleStage({role:ledger.phase}));
 const currentIndex=(unknown||interrupted)&&failed.length?observedIndex:(unknown||interrupted)&&phaseIndex>=0?phaseIndex:observedIndex>=0||lastCheckpoint>=0?Math.max(observedIndex,lastCheckpoint+1):-1,reason=run?.reason??ledger.reason??snapshot.error?.code??null;
 const stages=buildStageSpecs.map(([id,label,saved,roles],index)=>{
  const metric=metrics.find(row=>row.stage===metricIds[id])??{},cp=checkpoints.filter(row=>saved.includes(row.stage)),calls=attempts.filter(row=>roleStage(row)===id),agents=invocations.filter(row=>roleStage(row)===id);
  let state=cp.length?'COMPLETED':live&&index===currentIndex?'RUNNING':unknown&&index===currentIndex?'UNKNOWN':interrupted&&index===currentIndex?'INTERRUPTED':status==='PARTIALLY_READY'&&index===currentIndex?'PARTIAL':'NOT_STARTED';
  if(!cp.length&&!live&&!unknown&&!interrupted&&!['PARTIALLY_READY',null].includes(status))state='UNRECORDED';
  if(metric.status&&Object.hasOwn(buildStateLabels,({UNKNOWN_HOLD:'UNKNOWN',FAILED:'INTERRUPTED',STOPPED:'INTERRUPTED',UNMEASURED:'UNRECORDED'})[metric.status]??metric.status))state=metric.status==='UNMEASURED'&&cp.length?'COMPLETED':({UNKNOWN_HOLD:'UNKNOWN',FAILED:'INTERRUPTED',STOPPED:'INTERRUPTED',UNMEASURED:'UNRECORDED'})[metric.status]??metric.status;
  if(terminal&&state==='RUNNING')state=unknown?'UNKNOWN':interrupted?'INTERRUPTED':'PARTIAL';
  const starts=(summary?[timestamp(metric.started_at)]:agents.map(row=>timestamp(row.started_at))).filter(value=>value!==null);
  const ends=(summary?[timestamp(metric.ended_at)]:[...agents.map(row=>timestamp(row.ended_at)),...cp.map(row=>timestamp(row.ended_at??row.at))]).filter(value=>value!==null);
  const started=starts.length?Math.min(...starts):null,ended=ends.length?Math.max(...ends):null;
  const elapsed=finiteCount(metric.duration_ms)??finiteCount(metric.elapsed_ms)??(summary?null:live&&state==='RUNNING'&&started!==null?Math.max(0,now-started):started!==null&&ended!==null&&ended>=started?ended-started:null);
  const windows=id==='CQ'?snapshot.chunked_cq?.chunks:id==='EXTRACTION'?snapshot.extraction_windows?.windows:null;
  const total=finiteCount(metric.counts?.windows_total??metric.counts?.total_windows)??finiteCount(id==='CQ'?snapshot.chunk_plan_summary?.window_count:id==='EXTRACTION'?snapshot.extraction_windows?.total_windows:null);
  const complete=finiteCount(metric.counts?.windows_saved??metric.counts?.completed_windows)??(Array.isArray(windows)?windows.filter(w=>['COMPLETED','SAVED','RETURNED','READY'].includes(w.status)).length:null);
  const usage=buildUsage(calls);
  for(const key of Object.keys(usage)){const value=finiteCount(metric.usage?.[key==='cached_tokens'?'cached_input_tokens':key]);if(summary)usage[key]={value,partial:value!==null&&Boolean(metric.usage?.returned_without_usage||metric.usage?.unknown_without_usage||metric.usage?.inflight_without_usage)};}
  const requests=metric.requests,generation=finiteCount(requests?.generation_attempts??requests?.generation_sent),embedding=finiteCount(requests?.embedding_attempts??requests?.embedding_sent),requestCount=generation!==null&&embedding!==null?generation+embedding:null;
  return {id,label,state,state_label:buildStateLabels[state],started_at:started,ended_at:ended,elapsed_ms:elapsed,
   timing_basis:summary?(metric.measurement_kind??'阶段记录'):starts.length&&agents.length?'已记录的 Agent 调用跨度':'阶段记录',completed_windows:complete,total_windows:total,
   request_count:requestCount??(Array.isArray(ledger.attempts)?calls.length:null),requests:requests??null,agent_count:finiteCount(metric.counts?.actors_total)??(agents.length||null),usage,
   checkpoints:cp.map(row=>({stage:row.stage,artifact_ref:row.artifact_ref??null})),reason:['UNKNOWN','INTERRUPTED','PARTIAL'].includes(state)?reason:null};
 });
 const compact=[['source','资料解析',['SOURCE']],['chunks','统一分块',['CHUNKS']],['needs','知识需求整理',['CQ','FAMILY']],['knowledge','知识抽取与局部对齐',['EXTRACTION']],['publish','图谱与索引发布',['INDEX','TEMPORAL']]].map(([id,label,ids])=>{
  const members=stages.filter(row=>ids.includes(row.id)),states=members.map(row=>row.state);
  const state=['UNKNOWN','INTERRUPTED','RUNNING','PARTIAL'].find(value=>states.includes(value))??(states.every(value=>['COMPLETED','REUSED'].includes(value))?(states.includes('REUSED')?'REUSED':'COMPLETED'):states.some(value=>['COMPLETED','REUSED'].includes(value))?'PARTIAL':states.includes('UNRECORDED')?'UNRECORDED':'NOT_STARTED');
  return {id,label,state,state_label:buildStateLabels[state]};
 });
 const active=stages.find(row=>['UNKNOWN','INTERRUPTED','RUNNING','PARTIAL'].includes(row.state));
 const friendly=reason==='EXTERNAL_DESTINATION_NOT_ADMITTED'?`运行被外呼控制层阻断，${unknown?'当前请求结果未确认':'后续处理已停止'}。`:unknown?'请求结果尚未确认，系统已暂停后续处理。':interrupted?'本批整理已中断，后续阶段未继续执行。':status==='PARTIALLY_READY'?'已有部分结果可查看，仍有未完成内容。':null;
 return {status,live,terminal,run_id:run?.run_id??ledger.run_id??null,reason,active_stage:active?.label??null,stages,compact,
  summary:friendly?`${active?(['CQ','FAMILY'].includes(active.id)?'知识需求整理':active.label)+'：':''}${friendly}已保存的资料和阶段产物保留，不会自动重试。`:null,
  retained_checkpoints:checkpoints.map(row=>({stage:row.stage,artifact_ref:row.artifact_ref??null})),
  created_at:timestamp(run?.created_at??ledger.created_at),ended_at:timestamp(run?.ended_at??ledger.ended_at)};
}

function normalizedDocuments({documents, blocks, sources}) {
  const retained = pages(documents), rows = retained.map(row => ({row, origin: 'FROZEN_SOURCE'}));
  // Current source rows are a readability fallback, never a replacement for a frozen revision.
  for (const source of array(sources)) {
    const ref = refOf(source);
    const duplicate = retained.some(row => {
      // A true source revision is distinct from the source-record routing scheme.
      // Preserve different explicit revisions even if their immutable original is shared.
      if (text(source.revision) && text(row.revision) && source.revision !== row.revision) return false;
      const savedId = documentIdOf(row), currentId = documentIdOf(source);
      if (text(savedId) && text(currentId)) return savedId === currentId;
      return refOf(row) === ref && text(source.revision) && row.revision === source.revision;
    });
    if (!text(ref) || duplicate) continue;
    rows.push({row: source, origin: 'CURRENT_SOURCE'});
  }
  const result = [], seen = new Set();
  for (const {row, origin} of rows) {
    if (!object(row) || !text(refOf(row))) continue;
    const docRef = refOf(row), revision = revisionOf(row), key = lightogDocumentKey(docRef, revision);
    if (seen.has(key)) continue;
    seen.add(key);
    const body = valueText(row.text ?? row.content ?? row.parsing?.content);
    // A source can be opened immediately after upload, before any native run.
    // Parser offsets address its retained content; do not reuse them over an edited body.
    const parserBodyMatches = !text(row.parsing?.content) || row.parsing.content === body;
    const parserBlocks = origin === 'CURRENT_SOURCE' && parserBodyMatches ? array(row.parsing?.blocks).flatMap(block => {
      const {start, end} = block;
      const valid = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && end <= body.length;
      if (!valid || !text(block.block_id)) return [];
      return [{...block, doc_ref: docRef, revision, text: body.slice(start, end), offset_unit: row.parsing?.offset_unit ?? 'utf16_code_unit'}];
    }) : [];
    const bodyBlocks = [...parserBlocks, ...pages(blocks).filter(block => sameVersion(row, block))].flatMap(block => {
      const id = block.block_id ?? block.ref ?? block.id;
      if (!text(id)) return [];
      const start = Number.isSafeInteger(block.start) && block.start >= 0 ? block.start : null;
      const end = Number.isSafeInteger(block.end) && block.end >= (start ?? 0) ? block.end : null;
      const blockText = valueText(block.text ?? block.content);
      const offsetsValid = start !== null && end !== null && end <= body.length && body.slice(start, end) === blockText;
      return [{...block, id, block_id: id, text: blockText, start, end, offsets_valid: offsetsValid, provenance: array(block.provenance), record: block}];
    });
    const deduped = [...new Map(bodyBlocks.map(block => [block.id, block])).values()];
    deduped.sort((a, b) => (a.start ?? Number.MAX_SAFE_INTEGER) - (b.start ?? Number.MAX_SAFE_INTEGER));
    const expected = Number.isSafeInteger(row.block_count) ? row.block_count : origin === 'CURRENT_SOURCE' && parserBodyMatches && Array.isArray(row.parsing?.blocks) ? row.parsing.blocks.length : null;
    const complete = expected !== null ? deduped.length >= expected : !hasMore(blocks) && deduped.length > 0;
    const documentId = documentIdOf(row);
    result.push({key, doc_ref: docRef, revision, title: row.title ?? row.name ?? row.filename ?? docRef,
      document_id: text(documentId) ? documentId : null, text: body, blocks: deduped,
      block_count: expected ?? deduped.length, blocks_complete: complete,
      parse_status: row.parse_status ?? (body ? 'READABLE' : 'NOT_RETAINED'),
      source_snapshot_ref: row.source_snapshot_ref ?? null,
      origin, revision_namespace: origin === 'CURRENT_SOURCE' && !text(row.revision) && text(row.source_revision) ? 'SOURCE_RECORD' : text(row.revision) ? 'FROZEN_SOURCE' : 'UNKNOWN',
      warnings: unique([...array(row.warnings), ...array(row.parsing?.warnings)]), record: row});
  }
  return result;
}

function sourceIdentity(ref) {
  const docRef = ref?.doc_ref ?? ref?.source_ref;
  return {doc_ref: text(docRef) ? docRef : null, revision: text(ref?.revision) ? ref.revision : null};
}

function explicitBlockRefs(value) {
  return unique([value?.block_id, value?.block_ref, ...strings(value?.block_refs), ...strings(value?.source_block_refs)].filter(text));
}

function checkedSegment(segment, document) {
  if (!object(segment)) return null;
  const start = segment.start, end = segment.end, quote = segment.quote;
  const valid = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start &&
    text(quote) && end <= document.text.length && document.text.slice(start, end) === quote;
  if (!valid) return null;
  const blocks = document.blocks.filter(block => block.offsets_valid && block.start < end && block.end > start);
  return {start, end, quote, evidence_ref: segment.evidence_ref ?? null,
    block_ids: blocks.map(block => block.id),
    block_ranges: blocks.map(block => ({block_id: block.id, start: Math.max(start, block.start) - block.start, end: Math.min(end, block.end) - block.start}))};
}

/** Every returned source is independent. Quotes from separate documents are never merged. */
export function resolveLightogSources(record, model) {
  if(object(record?.source)&&(Array.isArray(record.source.source_refs)||text(record.source.record_ref)))
    record=pendingRecordSources(record,array(model?.knowledge).map(k=>k.record)).source_record;
  if(model?.library_knowledge?.policy==='MEMORY_CURRENT_VIEW_V1'){
    const recordRefs=array(record?.source_refs).filter(ref=>ref?.kind==='MEMORY_RECORD_SOURCE');
    if(recordRefs.length){
      const labels={DOCUMENT:'资料记录',HUMAN_TEXT:'人工陈述',AGENT_REPORT:'Agent报告',TOOL_RECEIPT:'工具回执'};
      const retained=recordRefs.map(ref=>{
        const available=text(ref.record_ref)&&text(ref.revision)&&Object.hasOwn(labels,ref.source_kind)&&ref.document_evidence_eligible===false;
        return {kind:'MEMORY_RECORD_SOURCE',record_ref:ref.record_ref??null,revision:ref.revision??null,source_kind:ref.source_kind??null,document_evidence_eligible:false,available,title:labels[ref.source_kind]??'原始记录',granularity:'RECORD',read_status:'NOT_READ',action_label:available?'打开原始记录':null,...(!available?{reason:'MEMORY_RECORD_SOURCE_UNCONFIRMED'}:{})};
      });
      const documentRefs=array(record.source_refs).filter(ref=>ref?.kind!=='MEMORY_RECORD_SOURCE'),documentEvidence=array(record.evidence).filter(e=>text(e?.doc_ref??e?.source_ref));
      return [...retained,...(documentRefs.length||documentEvidence.length?resolveLightogSources({...record,source_refs:documentRefs,evidence:documentEvidence},model):[])];
    }
  }
  const refs = array(record?.source_refs).filter(object), evidence = array(record?.evidence).filter(object);
  const identities = [...refs];
  for (const e of evidence) {
    const id = sourceIdentity(e);
    if (id.doc_ref && id.revision && !identities.some(ref => {const r = sourceIdentity(ref); return r.doc_ref === id.doc_ref && r.revision === id.revision;})) identities.push(e);
  }
  if (!identities.length) return [{doc_ref: null, revision: null, document_key: null, document_id: null,
    title: '来源未绑定', available: false, granularity: 'UNBOUND', block_ids: [], segments: [],
    quote: valueText(record?.model_quote ?? record?.quote), quotes: [], reason: 'SOURCE_IDENTITY_MISSING', action_label: null}];
  const grouped = new Map();
  for (const ref of identities) {
    const identity = sourceIdentity(ref), key = lightogDocumentKey(identity.doc_ref, identity.revision) ?? 'unbound';
    const row = grouped.get(key) ?? {identity, refs: []}; row.refs.push(ref); grouped.set(key, row);
  }
  return [...grouped].map(([key, group]) => {
    const {doc_ref, revision} = group.identity;
    // A source without revision is deliberately not redirected to whichever document is current.
    const document = doc_ref && revision ? model.documentByKey.get(key) : null;
    const bound = document && document.revision_namespace === 'FROZEN_SOURCE' && group.refs.every(ref => snapshotMatches(ref, document));
    if (!bound) return {doc_ref, revision, document_key: key === 'unbound' ? null : key,
      document_id: null, title: group.refs.find(ref => text(ref.filename ?? ref.title))?.filename ?? group.refs.find(ref => text(ref.title))?.title ?? doc_ref ?? '来源未绑定',
      available: false, granularity: doc_ref ? 'UNAVAILABLE' : 'UNBOUND', block_ids: [], segments: [], quote: '', quotes: [],
      reason: !doc_ref ? 'SOURCE_IDENTITY_MISSING' : !revision ? 'SOURCE_REVISION_MISSING' : document?.revision_namespace !== 'FROZEN_SOURCE' && document ? 'SOURCE_REVISION_NAMESPACE_MISMATCH' : document ? 'SOURCE_SNAPSHOT_MISMATCH' : 'SOURCE_VERSION_NOT_RETAINED', action_label: null};
    const matchingEvidence = evidence.filter(e => {
      const id = sourceIdentity(e); return id.doc_ref === doc_ref && id.revision === revision && snapshotMatches(e, document);
    });
    const segments = matchingEvidence.flatMap(e => [e, e.span, ...array(e.spans)]).map(e => checkedSegment(e, document)).filter(Boolean);
    const spanKeys = new Set();
    const savedSegments = segments.filter(segment => {const id = segment.start + ':' + segment.end; if (spanKeys.has(id)) return false; spanKeys.add(id); return true;});
    const requestedBlocks = unique(group.refs.flatMap(ref => [...explicitBlockRefs(ref), ref.unit_ref].filter(text)));
    const blockIds = unique([...savedSegments.flatMap(segment => segment.block_ids), ...document.blocks.filter(block => requestedBlocks.includes(block.id) || requestedBlocks.includes(block.ref)).map(block => block.id)]);
    const unitRefs = unique(group.refs.map(ref => ref.unit_ref).filter(text));
    const units = model.units.filter(unit => sameVersion(unit, document) && unitRefs.includes(unit.window_ref ?? unit.chunk_ref ?? unit.ref ?? unit.id));
    const granularity = savedSegments.length ? 'SPAN' : blockIds.length ? 'BLOCK' : units.length ? 'UNIT' : 'DOCUMENT';
    const unverifiedQuotes = unique(matchingEvidence.flatMap(e => [e.quote, e.span?.quote, ...array(e.spans).map(span => span?.quote)]).filter(text));
    const quotes = savedSegments.map(segment => segment.quote);
    return {doc_ref, revision, document_key: document.key, document_id: document.document_id, title: document.title, available: true,
      granularity, block_ids: blockIds, segments: savedSegments, quote: quotes[0] ?? '', quotes,
      unverified_quotes: unverifiedQuotes.filter(quote => !quotes.includes(quote)),
      unit_refs: units.map(unit => unit.window_ref ?? unit.chunk_ref ?? unit.ref ?? unit.id),
      container_block_ids: unique(units.flatMap(unit => strings(unit.source_block_refs))),
      reason: granularity === 'DOCUMENT' ? (matchingEvidence.length ? 'SAVED_QUOTE_POSITION_UNVERIFIED' : 'DOCUMENT_CONTEXT_ONLY') : null,
      action_label: granularity === 'SPAN' ? '在原文中查看' : granularity === 'BLOCK' ? '查看对应段落' : granularity === 'UNIT' ? '查看对应资料片段' : '打开对应资料'};
  });
}

function suppliedDefinitions(graph, run, library = null) {
  if(library)return array(library.ontology?.definitions);
  const supplied = graph?.domain_graph?.definitions ?? graph?.domain_graph?.ontology ?? run?.snapshot?.build?.domain_definitions;
  if (Array.isArray(supplied)) return supplied;
  if (!object(supplied)) return [];
  return Object.entries(supplied).flatMap(([group, definitions]) => array(definitions).map(row => ({...row,
    kind: row.kind ?? ({types: 'TYPE', entity_types: 'TYPE', classes: 'TYPE', relations: 'RELATION', relation_types: 'RELATION', predicates: 'RELATION', attributes: 'ATTRIBUTE', rules: 'RULE'}[group])})));
}

const definitionRefs = record => unique([record?.definition_ref, record?.definition_id, record?.type_ref,
  record?.predicate_ref, record?.attribute_ref, record?.rule_ref, record?.type_definition_ref, ...(record?.ontology_alignment?.status==='ALIGNED'?[record.ontology_alignment.definition_ref]:[]), ...(record?.relation_ontology_alignment?.status==='ALIGNED'?[record.relation_ontology_alignment.definition_ref]:[]), ...array(record?.ontology_types).map(type=>type.definition_ref), ...strings(record?.type_definition_refs), ...strings(record?.definition_refs)].filter(text));

/** A distinct confirmed current-view policy. No legacy build metadata is synthesized. */
export function lightogMemoryCurrentBinding(currentView,libraryId=null){
  const checked=validateMemoryCurrentViewContract(currentView,{libraryId});
  if(checked.status!=='READY')return {status:'MISMATCH',record:null,binding_policy:'MEMORY_CURRENT_VIEW_V1',reason:checked.reason,reason_code:checked.diagnostic.code,diagnostic:checked.diagnostic};
  const dto=currentView,b=dto.binding;
  // The full immutable revision and both definition representations are retained, not re-signed.
  const record={policy:'MEMORY_CURRENT_VIEW_V1',library_id:dto.library_id,revision_ref:b.library_revision_ref,source_snapshot_ref:b.source_snapshot_ref,record_sha256:b.record_sha256,knowledge:dto.knowledge,identity:dto.identity,ontology:dto.ontology,domain_graph:dto.domain_graph,binding:b,document_review_binding:dto.document_review_binding??null,pending_classification_policy:dto.pending_classification_policy??null,pending_issues:dto.pending_issues??[]};
  return {status:'READY',record,binding_policy:'MEMORY_CURRENT_VIEW_V1',reason:null};
}

/** Bind only a complete same-run envelope. A status summary is not a second projection. */
export function lightogLibraryBinding({run=null,graph=null,libraryId=null,currentView=null}={}) {
  if(currentView!==null)return lightogMemoryCurrentBinding(currentView,libraryId);
  const statusRecord=run?.library_knowledge??run?.snapshot?.build?.library_knowledge;
  const records=[graph?.library_knowledge,statusRecord].filter(object);
  if(!records.length)return {status:'LEGACY',record:null,reason:null};
  const keys=['run_id','library_id','source_snapshot_ref','source_fingerprint','input_sha256','revision_ref','record_sha256'];
  const complete=row=>['LIBRARY_KNOWLEDGE_V1','SIMPLIFIED_LIBRARY_KNOWLEDGE_V1'].includes(row.policy)&&keys.every(key=>text(row[key]))&&Array.isArray(row.knowledge)&&object(row.identity)&&object(row.ontology);
  if(records.some(row=>!complete(row)))return {status:'MISMATCH',record:null,reason:'对象与定义的版本信息尚未完整读回，请重新读取。'};
  const record=records[0];
  if(libraryId&&record.library_id!==libraryId||run?.run_id&&record.run_id!==run.run_id||graph?.run_id&&record.run_id!==graph.run_id||records.some(row=>keys.some(key=>row[key]!==record[key])))return {status:'MISMATCH',record:null,reason:'对象与定义的版本尚未对齐，请重新读取。'};
  const snapshot=run?.source_snapshot_ref??run?.snapshot?.source_snapshot_ref??run?.snapshot?.input?.source_snapshot_ref;
  if(graph?.domain_graph?.revision_ref&&graph.domain_graph.revision_ref!==record.revision_ref)return {status:'MISMATCH',record:null,reason:'图谱与对象定义的组织版本尚未对齐，请重新读取。'};
  if(graph?.library_id&&graph.library_id!==record.library_id||graph?.source_snapshot_ref&&graph.source_snapshot_ref!==record.source_snapshot_ref)return {status:'MISMATCH',record:null,reason:'图谱与对象定义的来源版本尚未对齐，请重新读取。'};
  if(snapshot&&snapshot!==record.source_snapshot_ref)return {status:'MISMATCH',record:null,reason:'对象与定义的来源版本尚未对齐，请重新读取。'};
  return {status:'READY',record,reason:null};
}

export const lightogLibraryRevision = run => {
  const record=run?.library_knowledge??run?.snapshot?.build?.library_knowledge;
  return text(record?.revision_ref)?record.revision_ref:null;
};

/** Human review is a separate, explicitly version-bound read model. */
export function lightogCorrectionOriginal(record) {
  const origin=record?.correction_origin;
  return origin?.original_knowledge??origin?.original_record??origin?.before??null;
}
const systemReasons={TYPE_SCOPE_NOT_DECLARED:'定义尚未声明适用范围。',ENDPOINT_TYPE_UNKNOWN:'关联对象的类型尚未确认。',EXPLICIT_ENDPOINT_SCOPE_MISMATCH:'对象类型与定义适用范围不一致，需要整理表示归属。',MAPPING_DIRECTION_UNKNOWN:'来源表达与定义方向尚未对齐。',RELATION_ATTRIBUTE_OWNER_UNDECLARED:'属性所描述的关联尚未声明。',VALUE_DATATYPE_UNDECLARED:'值的数据类型尚未声明。',VALUE_DATATYPE_UNVERIFIED:'值的数据类型尚未核对。',ONTOLOGY_ALIGNMENT_AMBIGUOUS:'存在多个定义映射候选。'};
const REVIEW_QUEUES=['HUMAN','SYSTEM','ANALYSIS','TECHNICAL','HISTORY','DIRECT_EDIT'];
const REVIEW_STATES=['OPEN','DEFERRED','SAVED','PENDING_APPLICATION','APPLIED','NONE'];
const triageReasons={...systemReasons,LEGACY_SAME_NAME_CANDIDATES_UNASSESSED:'同名只表示候选，尚未确认含义冲突。',LEGACY_REASON_HAS_NO_BOUND_SEMANTIC_RECEIPT:'既有说明尚未与实际比较双方绑定。',REQUESTED_PENDING_WITHOUT_BUSINESS_CHOICE:'当前暂定记录尚无明确业务取舍。',EXACT_DEFINITION_REPRESENTATION_DUPLICATE:'定义表达与适用范围完全重复，属于系统整理。',COMPARISON_CANDIDATE_MISSING:'比较候选不存在或无法读回。',LOCAL_ANALYSIS_NO_NEW_INFORMATION:'本项分析没有新增可用信息，继续保留未决。',BOUND_LOCAL_ANALYSIS_RECOMMENDATION:'局部分析已形成建议，尚未改动图和索引。',LOCAL_ANALYSIS_RECORD_INVALID:'分析凭据与当前比较版本不一致。',LEGACY_BINDING_RECONSTRUCTION_RECORDED:'旧比较关联的校正记录已保留。'};
function reviewSources(record,related,model) {
  const refs=[...array(record?.source_refs),...related.flatMap(row=>array(row.source_refs))];
  const evidence=[...array(record?.evidence),...related.flatMap(row=>array(row.evidence))];
  return resolveLightogSources({...record,source_refs:refs,evidence},model);
}
function reviewTriage(record,valid){
  const supplied=record?.triage;
  if(valid&&object(supplied)&&REVIEW_QUEUES.includes(supplied.queue)&&REVIEW_STATES.includes(supplied.decision_state))return {...supplied,reason_codes:strings(supplied.reason_codes)};
  return {queue:valid?'SYSTEM':'TECHNICAL',decision_state:'OPEN',reason_codes:[valid?'TRIAGE_NOT_AVAILABLE':'REVIEW_ITEM_BINDING_INVALID'],business_question:valid?'此项尚未完成系统分流，当前不开放人工决定。':'此项版本或对象绑定需要系统整理，其他事项继续可用。'};
}
function reviewSide(raw,model,index){
  raw=object(raw)?raw:{};
  const record=raw.definition??raw.entity??raw,refs=strings(raw.knowledge_refs??record.knowledge_refs),related=refs.map(id=>model.knowledgeById.get(id)?.record).filter(object);
  const original=lightogCorrectionOriginal(record);
  return {...raw,record,name:raw.name??record.name??'名称未保存',description:raw.description??record.description??'',kind:raw.kind??record.kind??null,knowledge_ids:refs.filter(id=>model.knowledgeById.has(id)),sources:reviewSources({...record,...raw},related,model),original_sources:original?resolveLightogSources(original,model):[],source_owner_index:index};
}
/** Backend owns classification and action capability; malformed rows are isolated locally. */
export function projectLightogLibraryReview(payload,model) {
  const library=model?.library_knowledge;
  if(library?.policy==='MEMORY_CURRENT_VIEW_V1')return {status:'UNAVAILABLE',reason:'当前经验视图不提供旧文档批次人工处理入口；原记录更正使用记录接口。'};
  if(model?.library_state?.status!=='READY'||!library)return {status:'UNAVAILABLE',reason:'当前组织版本尚未读回，不能提交人工处理。'};
  if(payload?.policy!=='LIBRARY_REVIEW_V1'||payload.library_id!==library.library_id||payload.run_id!==library.run_id||payload.revision_ref!==library.revision_ref||payload.source_snapshot_ref!==library.source_snapshot_ref||!Array.isArray(payload.items)||!Array.isArray(payload.history)||!Array.isArray(payload.applications))return {status:'MISMATCH',reason:'人工处理事项与当前阅读版本尚未对齐，请重新读取。'};
  const items=payload.items.map((raw,index)=>{
    const record=object(raw)?raw:{},valid=text(record.item_ref)&&['IDENTITY','DEFINITION','KNOWLEDGE'].includes(record.kind)&&record.revision_ref===library.revision_ref;
    const definition=record.definition,knowledge=record.knowledge,triage=reviewTriage(record,valid),validTriage=valid&&object(record.triage)&&REVIEW_QUEUES.includes(record.triage.queue)&&REVIEW_STATES.includes(record.triage.decision_state);
    const refs=record.kind==='IDENTITY'?unique([...strings(record.left?.knowledge_refs),...strings(record.right?.knowledge_refs)]):record.kind==='KNOWLEDGE'?[record.target_ref]:strings(definition?.knowledge_refs);
    const related=refs.map(id=>model.knowledgeById.get(id)?.record).filter(object),original=lightogCorrectionOriginal(knowledge);
    const sourceRecord=record.kind==='IDENTITY'?{source_refs:[...array(record.left?.source_refs),...array(record.right?.source_refs)]}:record.kind==='KNOWLEDGE'?knowledge:definition;
    const suppliedComparisons=[...array(record.comparisons),record.comparison].filter(object),seen=new Set(),sideRows=[];
    const comparisons=suppliedComparisons.filter(row=>{if(!text(row.comparison_ref)||seen.has(row.comparison_ref))return false;seen.add(row.comparison_ref);return true;}).map(row=>({...row,sides:array(row.sides).map(side=>{const result=reviewSide(side,model,sideRows.length);sideRows.push(result);return result;})}));
    const readiness=object(record.readiness)?record.readiness:{can_decide:false,blocked_reason_codes:['TRIAGE_NOT_AVAILABLE'],actions:[]};
    const actions=validTriage&&readiness.can_decide===true?array(readiness.actions).filter(row=>object(row)&&text(row.action)&&row.enabled===true&&['STATE_ONLY','VERSION_CHANGE'].includes(row.effect)):[];
    const candidates=record.kind==='IDENTITY'?[record.left,record.right].filter(object).map(row=>({id:row.id,name:row.name??'原名称未保存',types:strings(row.types)})):record.kind==='KNOWLEDGE'?[{id:record.target_ref,name:knowledge?.statement??knowledge?.text??knowledge?.rule_text??'已保存知识'}]:[{id:definition?.definition_ref,name:definition?.name??'定义名称未保存'}];
    return {id:valid?record.item_ref:'unbound-review-row-'+index,kind:record.kind??'TECHNICAL',triage,category:triage.queue,decision_state:triage.decision_state,status:record.status,application_status:record.application_status,title:triage.business_question||(record.kind==='IDENTITY'?'对象身份判断':record.kind==='KNOWLEDGE'?'知识纠错':'定义判断'),record,reason:triage.business_question||triage.reason_codes.map(code=>triageReasons[code]).filter(text).join(' ')||(triage.queue==='DIRECT_EDIT'?'这是您主动进入的内容修订，不计为系统发现的人工待办。':'此项仍保留原记录，尚未完成系统分流。'),saved_reason:array(record.reasons).filter(text).join('；'),candidates,knowledge_ids:refs.filter(id=>model.knowledgeById.has(id)),sources:reviewSources(sourceRecord,record.kind==='KNOWLEDGE'?[]:related,model),original_sources:original?resolveLightogSources(original,model):[],original_knowledge:original,definition_id:definition?.definition_ref??null,comparisons,comparison:comparisons.length===1?comparisons[0]:null,comparison_sides:sideRows,readiness:{...readiness,can_decide:validTriage&&readiness.can_decide===true},action_capabilities:actions,allowed_actions:actions.map(row=>row.action),history:array(record.history),latest_state_event:record.latest_state_event??null,effective_version_event:record.effective_version_event??null,analysis_capability:valid&&triage.queue==='ANALYSIS'?record.analysis_capability??null:null,analysis_coverage:object(record.analysis_coverage)?structuredClone(record.analysis_coverage):null,analysis_qualification:object(record.analysis_qualification)?structuredClone(record.analysis_qualification):null,analysis_observations:structuredClone(array(record.analysis_observations)),analysis_task:object(record.analysis_task)?structuredClone(record.analysis_task):null,isolated:!valid};
  });
  const queue_counts=Object.fromEntries(REVIEW_QUEUES.map(queue=>[queue,items.filter(item=>item.triage.queue===queue).length]));
  return {status:'READY',record:payload,items,history:payload.history,applications:payload.applications,writable:payload.current===true&&payload.writable===true,summary:{...payload.summary,queue_counts,human_required:items.filter(item=>item.triage.queue==='HUMAN'&&item.decision_state==='OPEN').length,local_isolated:items.filter(item=>item.isolated).length}};
}

/** A UI view version includes semantic revision; the backend index is never rewritten. */
export function bindLightogLibraryGraph(graph,{run=null,libraryId=null}={}) {
  if(!graph)return graph;const binding=lightogLibraryBinding({run,graph,libraryId});
  if(binding.status!=='READY')return graph;
  const base=graph.lightog_base_index_revision??graph.index_revision??graph.domain_graph?.graph_revision??null;
  return {...graph,lightog_base_index_revision:base,library_revision_ref:binding.record.revision_ref,index_revision:'lightog-library-view:'+JSON.stringify([base,binding.record.revision_ref])};
}

function projectLibraryDetails(model,library) {
  model.formal_definitions=model.definitions.filter(d=>d.formation_status==='USABLE');
  model.pending_definitions=model.definitions.filter(d=>d.formation_status==='PENDING');
  model.rejected_definitions=model.definitions.filter(d=>d.formation_status==='REJECTED');
  const covered=new Set(model.definitions.flatMap(d=>strings(d.record.shape_refs)));
  const observations=library?array(library.ontology?.unbound_shapes).filter(row=>!covered.has(row.shape_ref)).map((row,index)=>({id:row.shape_ref??'observation-'+index,kind:row.kind==='CLASS'?'TYPE':row.kind,formation_status:'OBSERVED',name:row.label??row.name??'未命名术语',record:row,knowledge_ids:strings(row.knowledge_refs).filter(id=>model.knowledgeById.has(id)),sources:resolveLightogSources(row,model)})):model.definitions.filter(d=>d.formation_status==='OBSERVED');
  model.term_observations=observations;
  model.ontology_counts={usable:model.formal_definitions.length,pending:model.pending_definitions.length,observations:observations.length};
  if(!library)return;
  const identity=library.identity,profiles=new Map(array(identity.profiles).map(p=>[p.id,p])),byShortRef=new Map(array(identity.profiles).map(p=>[p.entity_ref,p]));
  const mappings=new Map(array(identity.mapping).filter(m=>m.status==='ACTIVE').map(m=>[m.local_entity_id,m]));
  const decisions=new Map(array(identity.decisions).filter(d=>text(d.decision_ref)).map(d=>[d.decision_ref,d]));
  const entityName=id=>model.graph_data?.nodes.get(id)?.name??profiles.get(id)?.name??array(identity.entities).find(e=>e.id===id||e.canonical_id===id)?.name??'名称未随记录保存';
  const relatedKnowledge=record=>unique([...strings(record.knowledge_refs??record.record_refs),...strings(record.evidence_refs).filter(ref=>model.knowledgeById.has(ref))]).filter(id=>model.knowledgeById.has(id));
  for(const raw of array(identity.entities)) {
    const id=raw.canonical_id??raw.id;if(!text(id))continue;
    const node=model.graph_data?.nodes.get(id),mentions=[];
    for(const knowledge of model.knowledge)for(const local of array(knowledge.record.library_projection?.source_local_domain?.entities)){
      const mapping=mappings.get(local.id);if(mapping?.canonical_id!==id)continue;
      const participants=array(knowledge.record.library_projection?.source_local_participants).filter(p=>p.subject_ref===local.id);
      const mentionSources=resolveLightogSources({...local,source_refs:array(local.source_refs).length?local.source_refs:array(knowledge.record.source_refs),evidence:array(local.evidence)},model);
      mentions.push({local_entity_id:local.id,name:local.name??local.label??'原名称未保存',observed_type:local.entity_type??null,roles:unique(participants.map(p=>p.role).filter(text)),knowledge_id:knowledge.id,sources:mentionSources,record:local});
    }
    // Profiles can retain source-local names even without a knowledge span. Do not invent one.
    for(const localId of strings(raw.local_entity_ids))if(!mentions.some(m=>m.local_entity_id===localId)){
      const profile=profiles.get(localId);if(profile)mentions.push({local_entity_id:localId,name:profile.name??'原名称未保存',observed_type:null,roles:[],knowledge_id:null,sources:resolveLightogSources(profile,model),record:profile});
    }
    const decisionIds=unique(array(identity.mapping).filter(m=>m.canonical_id===id).flatMap(m=>strings(m.decision_refs)));
    const row={id,name:node?.name??raw.name??raw.label,aliases:strings(raw.aliases),ontology_types:array(node?.ontology_types??raw.ontology_types).filter(type=>text(type.name)&&text(type.definition_ref)),observed_types:strings(raw.observed_types),roles:strings(raw.roles),type_definition_ids:definitionRefs(node??raw).filter(ref=>model.definitionById.get(ref)?.formation_status==='USABLE'),mentions,decisions:decisionIds.map(ref=>decisions.get(ref)).filter(Boolean).map(record=>({record,decision_ref:record.decision_ref,reason:record.reason??'',decision:record.decision,knowledge_ids:unique([...relatedKnowledge(record),...strings(profiles.get(record.left_id??byShortRef.get(record.left_ref)?.id)?.knowledge_refs),...strings(profiles.get(record.right_id??byShortRef.get(record.right_ref)?.id)?.knowledge_refs)]).filter(ref=>model.knowledgeById.has(ref)),sources:resolveLightogSources(record,model)})),sources:resolveLightogSources(raw,model),record:raw};
    model.entities.push(row);model.entityById.set(id,row);
  }
  const classified=readNativePendingClassification(library);
  model.pending_classification={...classified,entries:classified.entries.map(entry=>{
    const related=entry.knowledge_refs.map(id=>model.knowledgeById.get(id)).filter(Boolean),
      subject=related.flatMap(k=>array(k.record.domain?.entities)).find(e=>related.some(k=>k.record.subject_ref===e.id)),
      kind=String(entry.record.pending_kind??entry.record.candidate_kind??entry.record.kind??'').toUpperCase(),
      expectedKind=({CLASS:'TYPE',TYPE:'TYPE',ENTITY_TYPE:'TYPE',CLASS_DEFINITION:'TYPE','类型定义':'TYPE',RELATION:'RELATION',RELATION_TYPE:'RELATION',RELATION_DEFINITION:'RELATION',ATTRIBUTE:'ATTRIBUTE',ATTRIBUTE_TYPE:'ATTRIBUTE',ATTRIBUTE_DEFINITION:'ATTRIBUTE',CONCEPT:'CONCEPT'})[kind],
      explicit=entry.record.definition_ref??entry.record.definition_id,
      definitions=entry.category==='DEFINITION'?model.definitions.filter(d=>explicit?d.id===explicit:d.knowledge_ids.some(id=>entry.knowledge_refs.includes(id))&&(!expectedKind||d.kind===expectedKind)):[],
      definition=definitions.length===1?definitions[0]:null;
    return {...entry,name:definition?.name??entry.record.name??(expectedKind==='TYPE'?subject?.entity_type:null)??entry.title,knowledge_ids:entry.knowledge_refs.filter(id=>model.knowledgeById.has(id)),
      definition_id:definition?.id??null,ontology_kind:definition?.kind??expectedKind??null,sources:resolveLightogSources(entry.source_record,model)};
  })};
  for(const [kind,rows] of [['PENDING',classified.identity_pairs],['BLOCKED',[]]])for(const record of array(rows)){
    const left=record.left_id??byShortRef.get(record.left_ref)?.id,right=record.right_id??byShortRef.get(record.right_ref)?.id;
    const knowledgeIds=unique([...relatedKnowledge(record),...strings(profiles.get(left)?.knowledge_refs),...strings(profiles.get(right)?.knowledge_refs)]).filter(id=>model.knowledgeById.has(id));
    const entry=model.pending_classification.entries.find(e=>e.record===record);
    model.issues.push({id:record.decision_ref??record.pair_ref??entry?.id??'identity-issue-'+model.issues.length,kind:'IDENTITY',status:kind,title:'对象身份候选比较',reason:record.reason??'本次未保存具体判断依据。',candidates:[left,right].filter(text).map(id=>({id,name:entityName(id)})),knowledge_ids:knowledgeIds,sources:resolveLightogSources(record,model),record,read_only:true});
  }
  for(const definition of model.pending_definitions)model.issues.push({id:definition.id,kind:'ONTOLOGY',status:'PENDING',title:'定义待确认',reason:definition.record.reason??(definition.record.warning==='ONTOLOGY_EXISTING_DEFINITION_CONFLICT'?'与已有定义存在冲突。':'本次定义仍待确认。'),candidates:[{id:definition.id,name:definition.name}],definition_id:definition.id,knowledge_ids:definition.knowledge_ids,sources:definition.sources,record:definition.record});
  model.history=[...array(library.history),...array(identity.history),...array(library.ontology?.history)].filter(object);
}

/** Produces display rows and Maps. Inputs and retained records remain unmodified. */
export function projectLightogReading({run = null, graph = null, documents = null, blocks = null, chunks = null, windows = null, sources = [], libraryId = null,currentView=null} = {}) {
  const binding=lightogLibraryBinding({run,graph,libraryId,currentView}),library=binding.status==='READY'?binding.record:null;
  if(currentView!==null){
    if(binding.status!=='READY'||run!==null)throw Object.assign(new Error(binding.reason??'当前经验视图不能冒充文档批次。'),{code:'MEMORY_CURRENT_VIEW_INVALID',...(binding.diagnostic?{reason_code:binding.diagnostic.code,path:binding.diagnostic.path,diagnostic:binding.diagnostic}:{})});
    graph={library_id:currentView.library_id,source_snapshot_ref:currentView.binding.source_snapshot_ref,library_revision_ref:currentView.binding.library_revision_ref,index_revision:currentView.binding.knowledge_index_revision,domain_graph:currentView.domain_graph,knowledge:currentView.knowledge};
    documents??=currentView.source_snapshot.documents;sources=[];
  }
  const docs = normalizedDocuments({documents, blocks, sources}), data = readNativeDomainGraph(graph);
  const model = {run, documents: docs, documentByKey: new Map(docs.map(doc => [doc.key, doc])),
    knowledge: [], knowledgeById: new Map(), definitions: [], definitionById: new Map(),
    library_state:{status:binding.status==='READY'&&graph?.partial===true?'PARTIAL':binding.status,read_only:graph?.read_only===true,revision_ref:library?.revision_ref??null,reason:binding.reason??null,...(currentView!==null?{binding_policy:'MEMORY_CURRENT_VIEW_V1'}:{})},library_knowledge:library,
    entities:[],entityById:new Map(),formal_definitions:[],pending_definitions:[],rejected_definitions:[],term_observations:[],ontology_counts:{usable:0,pending:0,observations:0},issues:[],history:[],
    units: [...pages(chunks), ...pages(windows)], graph_data: data,
    partial_organization: run?.snapshot?.partial_organization ? {
      knowledge_count: pages(run.snapshot.partial_organization.knowledge).length,
      parent_graph_confirmed: run.snapshot.partial_organization.parent_graph_confirmed === true
    } : null};
  const records = library?array(library.knowledge).flatMap(record=>{const id=record?.knowledge_ref??record?.record_ref??record?.fact_ref??record?.id;return text(id)?[[id,record]]:[];}):data ? [...data.knowledge_records] : [];
  // Status-only knowledge is retained even before a drawable graph exists.
  // partial_organization is persisted native_knowledge_head knowledge, not a
  // semantic package. It remains readable without asserting a confirmed parent graph.
  const partialRecords = pages(run?.snapshot?.partial_organization?.knowledge);
  const fallback = library?[]:[...pages(run?.snapshot?.build?.knowledge ?? run?.knowledge), ...partialRecords];
  const aliases = new Map();
  for (const [id, record] of records) for (const alias of [id, record.knowledge_ref, record.record_ref, record.fact_ref, record.id].filter(text)) aliases.set(alias, id);
  for (const record of fallback) {
    const id = record?.knowledge_ref ?? record?.record_ref ?? record?.fact_ref ?? record?.id;
    if (!text(id) || aliases.has(id)) continue;
    records.push([id, record]); for (const alias of [id, record.record_ref, record.fact_ref, record.id].filter(text)) aliases.set(alias, id);
  }
  const canonical = value => aliases.get(value) ?? value;
  const partialIds = new Set(partialRecords.map(record => canonical(record.knowledge_ref ?? record.record_ref ?? record.fact_ref ?? record.id)).filter(text));
  const boundRecord = (item, id) => strings(item.record_refs).some(ref => canonical(ref) === id);
  for (const [id, record] of records) {
    const row = {id, kind: record.kind ?? 'TEXT', text: record.statement ?? record.text ?? record.rule_text ?? record.description ?? '', record,
      entity_ids: data ? [...data.nodes.values()].filter(node => boundRecord(node, id)).map(node => node.id) : [],
      relation_ids: data ? [...data.edges.values()].filter(edge => boundRecord(edge, id)).map(edge => edge.id) : [],
      definition_ids: [], sources: [], partial_saved: partialIds.has(id),
      ...(partialIds.has(id) ? {parent_graph_confirmed: model.partial_organization?.parent_graph_confirmed === true} : {})};
    model.knowledge.push(row); model.knowledgeById.set(id, row);
  }
  for (const record of suppliedDefinitions(graph, run, library)) {
    const id = record?.definition_ref ?? record?.id ?? record?.key;
    if (!text(id) || model.definitionById.has(id)) continue;
    const description = valueText(record.description ?? record.definition ?? record.rule_text);
    const suppliedKind=String(record.kind??'DEFINITION').toUpperCase(),formationStatus=binding.status!=='MISMATCH'&&['USABLE','PENDING','REJECTED'].includes(record.status)?record.status:'OBSERVED';
    const row = {id, kind: suppliedKind==='CLASS'?'TYPE':suppliedKind, name: record.name ?? record.label ?? record.key ?? id,
      description, formation_status:formationStatus,definition_status:text(description) ? 'DEFINED' : 'NAME_ONLY', record,
      knowledge_ids: unique([...strings(record.record_refs??record.knowledge_refs).map(canonical).filter(ref => model.knowledgeById.has(ref)),
        ...model.knowledge.filter(knowledge => definitionRefs(knowledge.record).includes(id)).map(knowledge => knowledge.id)]),
      entity_ids: data ? [...data.nodes.values()].filter(node => definitionRefs(node).includes(id)).map(node => node.id) : [],
      relation_ids: data ? [...data.edges.values()].filter(edge => definitionRefs(edge).includes(id)).map(edge => edge.id) : [], sources: []};
    model.definitions.push(row); model.definitionById.set(id, row);
  }
  for (const definition of model.definitions) {
    // TYPE usage can address an ENTITY knowledge record directly. Follow that
    // saved record's actual node references; equal labels alone remain insufficient.
    if (definition.kind === 'TYPE') definition.entity_ids = unique([...definition.entity_ids,
      ...definition.knowledge_ids.flatMap(id => {
        const knowledge = model.knowledgeById.get(id);
        return String(knowledge?.kind).toUpperCase() === 'ENTITY' ? knowledge.entity_ids : [];
      })]);
  }
  if(library)for(const definition of model.definitions){
    definition.related_knowledge_ids=[...definition.knowledge_ids];
    if(definition.formation_status==='USABLE')definition.knowledge_ids=definition.knowledge_ids.filter(id=>{const knowledge=model.knowledgeById.get(id);return definition.kind==='TYPE'?definition.entity_ids.some(ref=>knowledge?.entity_ids.includes(ref)):definitionRefs(knowledge?.record).includes(definition.id);});
  }
  for (const knowledge of model.knowledge) {
    knowledge.definition_ids = model.definitions.filter(definition => (!library||definition.formation_status==='USABLE')&&definition.knowledge_ids.includes(knowledge.id)).map(definition => definition.id);
    knowledge.proposal_definition_ids=model.definitions.filter(definition=>(definition.formation_status==='PENDING'&&definition.knowledge_ids.includes(knowledge.id))||(definition.formation_status==='USABLE'&&definition.related_knowledge_ids?.includes(knowledge.id)&&!definition.knowledge_ids.includes(knowledge.id))).map(definition=>definition.id);
    knowledge.sources = knowledge.record.answer_authority==='HUMAN_CORRECTION'||knowledge.record.origin_layer==='HUMAN_CORRECTION'?[]:resolveLightogSources(knowledge.record, model);
    const original=lightogCorrectionOriginal(knowledge.record);
    knowledge.original_sources=original?resolveLightogSources(original,model):[];
    knowledge.human_correction=knowledge.record.origin_layer==='HUMAN_CORRECTION'||knowledge.record.answer_authority==='HUMAN_CORRECTION';
  }
  for (const definition of model.definitions) definition.sources = reviewSources(definition.record,(definition.related_knowledge_ids??definition.knowledge_ids).map(id=>model.knowledgeById.get(id)?.record).filter(object),model);
  projectLibraryDetails(model,library);
  return model;
}

/** Attach a separate, verified display projection. Signed library records and every original lookup remain intact. */
export function attachLightogTemporalDisplay(model,display){
  if(display?.status!=='READY')return {...model,knowledge_display:null,display_notice:display?.reason_code?'当前版本关联尚未核对，保留原始记录显示。':null};
  const graphData=readNativeDomainGraph(display.graph),projected=new Map();
  if(!graphData)return {...model,knowledge_display:null,display_notice:'当前版本显示图尚未完整读回，保留原始记录显示。'};
  for(const record of array(display.projected_records)){
    const id=record.knowledge_ref??record.record_ref??record.fact_ref??record.id,original=model.knowledgeById.get(id);
    if(!original)continue;
    const aliases=new Set([id,record.knowledge_ref,record.record_ref,record.fact_ref,record.id].filter(text));
    const bound=item=>strings(item.record_refs).some(ref=>aliases.has(ref));
    projected.set(id,{...original,kind:record.kind??original.kind,text:record.statement??record.text??record.rule_text??original.text,
      record,retained_record:original.record,
      entity_ids:[...graphData.nodes.values()].filter(bound).map(node=>node.id),
      relation_ids:[...graphData.edges.values()].filter(bound).map(edge=>edge.id),
      sources:record.answer_authority==='HUMAN_CORRECTION'||record.origin_layer==='HUMAN_CORRECTION'?[]:resolveLightogSources(record,model)});
  }
  return {...model,retained_graph_data:model.graph_data,graph_data:graphData,
    knowledge_display:{...display,rows_by_ref:projected,groups_by_id:new Map(display.groups.map(group=>[group.id,group]))},
    display_notice:display.unresolved?.length?'仍有 '+display.unresolved.length+' 项版本关联未确认，相关记录分别保留。':null};
}

/** An exact member ID still opens that member, never an implicit alias to another version. */
export function lightogDisplayKnowledgeById(model,id){return model?.knowledge_display?.rows_by_ref.get(id)??model?.knowledgeById?.get(id);}

function memberGraphAnchor(model,id,data){
  const row=lightogDisplayKnowledgeById(model,id),record=row?.record;
  const aliases=new Set([id,record?.knowledge_ref,record?.record_ref,record?.fact_ref,record?.id].filter(text));
  const bound=item=>strings(item.record_refs).some(ref=>aliases.has(ref));
  return {entity_ids:[...(data?.nodes.values()??[])].filter(bound).map(node=>node.id),
    relation_ids:[...(data?.edges.values()??[])].filter(bound).map(edge=>edge.id)};
}
function knowledgeGraphStatus(model,id,rows,data){
  const display=model?.knowledge_display,groupId=display?.member_to_group.get(id)??id,group=display?.groups_by_id.get(groupId);
  const members=group?.member_refs??[id],qualified=new Set(array(rows).map(row=>row?.id)),qualifiedMembers=members.filter(ref=>qualified.has(ref));
  const anchor=qualified.has(id)?memberGraphAnchor(model,id,data):{entity_ids:[],relation_ids:[]};
  const anchored=value=>value.entity_ids.length>0||value.relation_ids.length>0;
  const targets=qualifiedMembers.filter(ref=>qualified.has(id)&&ref!==id&&lightogDisplayKnowledgeById(model,ref)?.record?.temporal_fact).flatMap(ref=>{
    const current=memberGraphAnchor(model,ref,data);return anchored(current)?[{id:ref,...current}]:[];
  });
  const member=lightogDisplayKnowledgeById(model,id);
  return {kind:anchored(anchor)?'MEMBER':targets.length?'GROUP_CURRENT_VERSION':'NO_ANCHOR',member_ref:id,group_id:groupId,
    qualified_member_refs:qualifiedMembers,member_count:members.length,member_anchor:anchor,current_version_targets:targets,
    scope_limited:members.some(ref=>!qualified.has(ref))||Boolean(member?.entity_ids.length||member?.relation_ids.length)};
}

/** Query text selects a member; only pre-query qualified members and real graph bindings grant graph status. */
export function lightogKnowledgeGraphStatus(model,id,{rows=model?.knowledge??[],graph}={}){
  const data=graph===undefined?model?.graph_data:readNativeDomainGraph(graph);
  return knowledgeGraphStatus(model,id,rows,data);
}

/** A different locate target must be an explicitly offered, in-scope current version of this exact member. */
export function lightogKnowledgeLocationTarget(model,id,targetId,options={}){
  const status=lightogKnowledgeGraphStatus(model,id,options);
  const anchor=id===targetId&&status.kind==='MEMBER'?{id,...status.member_anchor}:status.current_version_targets.find(target=>target.id===targetId);
  const row=anchor&&lightogDisplayKnowledgeById(model,targetId);
  return row?{row,anchor}:null;
}

/** Fold verified groups after query matching, without transferring anchors or sources between members. */
export function lightogDisplayKnowledgeRows(model,rows=model?.knowledge??[],{query='',graph}={}){
  const display=model?.knowledge_display,needle=String(query).trim().toLocaleLowerCase(),qualified=array(rows).filter(Boolean);
  const eligible=qualified.filter(row=>!needle||[row.text,lightogDisplayKnowledgeById(model,row.id)?.text,row.kind,lightogDisplayKnowledgeById(model,row.id)?.kind].join(' ').toLocaleLowerCase().includes(needle));
  const data=graph===undefined?model?.graph_data:readNativeDomainGraph(graph);
  if(!display)return eligible.map(row=>({...row,display_graph_status:knowledgeGraphStatus(model,row.id,qualified,data)}));
  const grouped=new Map();
  for(const row of eligible){const groupId=display.member_to_group.get(row.id)??row.id,items=grouped.get(groupId)??[];items.push(row.id);grouped.set(groupId,items);}
  return [...grouped].map(([id,memberRefs])=>{
    const group=display.groups_by_id.get(id),preferred=memberRefs.includes(group?.preferred_ref)?group.preferred_ref:memberRefs[0];
    const row=lightogDisplayKnowledgeById(model,preferred);
    return {...row,display_graph_status:knowledgeGraphStatus(model,preferred,qualified,data),
      display_group_id:id,display_member_refs:memberRefs,display_all_member_refs:group?.member_refs??memberRefs};
  });
}

/** Paragraph scope excludes document-only and broad processing-unit associations. */
export function lightogParagraphKnowledge(model, documentKey, blockId = null, {all = false} = {}) {
  if (!model.documentByKey.has(documentKey)) return [];
  return model.knowledge.filter(row => row.sources.some(source => source.available && source.document_key === documentKey &&
    (all || blockId && source.block_ids.includes(blockId))));
}

/** Direct object/type links require a saved identifier, not an equal display name. */
export function lightogDefinitionBindings(model, record) {
  return definitionRefs(record).map(id => model.definitionById.get(id)).filter(Boolean);
}
