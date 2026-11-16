import {createDomainGraph} from './native-domain-knowledge-v1.mjs';
/** Versioned native source/fact indexes. No legacy publication or provider calls. */
import {canonical, hash, need, textField} from './cq-discovery-store-v2.mjs';
import {randomUUID} from 'node:crypto';
import {readMemorySourceBinding, verifyMemoryIndexSources} from './native-memory-source-binding-v1.mjs';

const POLICY = 'native-local-adoption-v1';
const GRAPH_POLICY = 'native-adopted-structure-graph/1';
const VIEWS = ['SOURCE', 'ADOPTED_FACT', 'EXTRACTED_KNOWLEDGE'];
const CAPABILITIES = ['LEXICAL', 'VECTOR', 'HYBRID'];
const json = value => JSON.parse(canonical(value));
const key = (...parts) => canonical(parts);
const kind = (view, suffix) => `native_${view === 'SOURCE' ? 'source' : view === 'EXTRACTED_KNOWLEDGE' ? 'knowledge' : 'fact'}_index_${suffix}_v1`;
const revisionRef = value => typeof value === 'string' ? value : value?.adoption_revision_ref;
const finiteVector = (values, dimensions) => {
  need(Array.isArray(values) && values.length === dimensions && values.every(Number.isFinite) && values.some(n => n !== 0), 'NATIVE_INDEX_VECTOR_INVALID');
  need(Number.isFinite(Math.hypot(...values)), 'NATIVE_INDEX_VECTOR_INVALID');
  return [...values];
};
function spaceBinding(value) {
  need(value && textField(value.model) && (value.revision === null || textField(value.revision ?? value.model_revision)) && Number.isInteger(value.dimensions) && value.dimensions > 0 && value.dimensions <= 32768, 'NATIVE_INDEX_SPACE_INVALID');
  need((textField(value.input_strategy) || value.input_strategy && typeof value.input_strategy === 'object' && !Array.isArray(value.input_strategy) && Object.keys(value.input_strategy).length) && String(value.distance).toUpperCase() === 'COSINE', 'NATIVE_INDEX_SPACE_INVALID');
  const normalized = {...json(value), revision: value.revision ?? value.model_revision ?? null, distance: 'COSINE', normalization: value.normalization ?? 'NONE'};
  delete normalized.model_revision;
  need(['NONE', 'L2'].includes(normalized.normalization), 'NATIVE_INDEX_NORMALIZATION_UNSUPPORTED');
  return normalized;
}
function normalizedVector(values, space) {
  const result = finiteVector(values, space.dimensions);
  if (space.normalization === 'L2') {
    const norm = Math.hypot(...result);
    need(Number.isFinite(norm) && norm > 0, 'NATIVE_INDEX_VECTOR_INVALID');
    return result.map(n => n / norm);
  }
  return result;
}
function batchLimits(space) {
  const limits = {
    items: space.max_batch_items ?? space.max_batch_size ?? space.batch_size ?? 20,
    chars: space.max_batch_chars ?? 100000,
    bytes: space.max_batch_bytes ?? 1048576,
    inputChars: space.max_input_chars ?? 100000,
    inputBytes: space.max_input_bytes ?? 512000
  };
  need(Object.values(limits).every(n => Number.isSafeInteger(n) && n > 0) && limits.items <= 256, 'NATIVE_INDEX_BATCH_LIMIT_INVALID');
  return limits;
}
function planBatches(texts, space) {
  const limits = batchLimits(space), batches = [];
  let batch = [], chars = 0, bytes = 0;
  for (const text of texts) {
    const size = Buffer.byteLength(text, 'utf8');
    need(text.length <= limits.inputChars && size <= limits.inputBytes && text.length <= limits.chars && size <= limits.bytes, 'NATIVE_INDEX_EMBEDDING_INPUT_TOO_LARGE');
    if (batch.length && (batch.length === limits.items || chars + text.length > limits.chars || bytes + size > limits.bytes)) {
      batches.push(batch); batch = []; chars = 0; bytes = 0;
    }
    batch.push(text); chars += text.length; bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
function checkedFactStructure(record) {
  need(['RELATION', 'ATTRIBUTE', 'RULE'].includes(record.kind) && textField(record.subject_ref), 'NATIVE_INDEX_FACT_STRUCTURE_INVALID');
  need(Array.isArray(record.conditions) && record.conditions.every(textField) && typeof record.negation === 'boolean' && textField(record.modality), 'NATIVE_INDEX_FACT_QUALIFIERS_INVALID');
  if (record.kind === 'RELATION') need(textField(record.predicate) && textField(record.object_ref) && record.direction === 'SUBJECT_TO_OBJECT', 'NATIVE_INDEX_RELATION_STRUCTURE_INVALID');
  if (record.kind === 'ATTRIBUTE') {
    need(textField(record.attribute) && Object.hasOwn(record, 'raw_value') && (record.raw_value === null || ['string', 'boolean'].includes(typeof record.raw_value) || typeof record.raw_value === 'number' && Number.isFinite(record.raw_value)), 'NATIVE_INDEX_ATTRIBUTE_STRUCTURE_INVALID');
    need(record.unit === undefined || record.unit === null || textField(record.unit), 'NATIVE_INDEX_ATTRIBUTE_UNIT_INVALID');
  }
  if (record.kind === 'RULE') need(textField(record.rule_text), 'NATIVE_INDEX_RULE_STRUCTURE_INVALID');
  if (record.participants !== undefined) need(Array.isArray(record.participants) && record.participants.every(p => p && textField(p.role) && textField(p.subject_ref)), 'NATIVE_INDEX_RULE_PARTICIPANTS_INVALID');
}
function checkedRecords(records, view, verifyHumanCorrection, verifyMemorySources) {
  need(Array.isArray(records), 'NATIVE_INDEX_RECORDS_REQUIRED');
  const seen = new Set();
  return records.map(input => {
    need(input && textField(input.record_ref) && input.record_ref.length <= 512 && !seen.has(input.record_ref), 'NATIVE_INDEX_RECORD_REF_INVALID');
    seen.add(input.record_ref);
    need(input.representation === (view === 'SOURCE' ? 'VERBATIM_SOURCE' : view === 'EXTRACTED_KNOWLEDGE' ? 'EXTRACTED_KNOWLEDGE' : 'ADOPTED_FACT'), 'NATIVE_INDEX_REPRESENTATION_INVALID');
    need(textField(input.text) && input.text.length <= 128000, 'NATIVE_INDEX_TEXT_INVALID');
    const human = view === 'EXTRACTED_KNOWLEDGE' && input.origin_layer === 'HUMAN_CORRECTION';
    if (human) verifyHumanCorrection(input);
    need(Array.isArray(input.source_refs) && (human || input.source_refs.length > 0) && input.source_refs.length <= 128
      && input.source_refs.every(r => r && textField(r.revision) && (r.kind === 'MEMORY_RECORD_SOURCE'
        ? textField(r.record_ref) && textField(r.source_kind) && r.document_evidence_eligible === false && !Object.hasOwn(r, 'doc_ref')
        : textField(r.doc_ref))), 'NATIVE_INDEX_SOURCE_REFS_REQUIRED');
    need(Array.isArray(input.evidence_refs) && (view === 'EXTRACTED_KNOWLEDGE' || input.evidence_refs.length > 0) && input.evidence_refs.length <= 128 && input.evidence_refs.every(textField), 'NATIVE_INDEX_EVIDENCE_REFS_REQUIRED');
    need(Array.isArray(input.evidence) && (view === 'EXTRACTED_KNOWLEDGE' || input.evidence.length > 0), 'NATIVE_INDEX_EXACT_EVIDENCE_REQUIRED');
    const evidenceIds = new Set(input.evidence.map(e => e?.evidence_ref ?? e?.id));
    need(input.evidence_refs.every(ref => evidenceIds.has(ref)), 'NATIVE_INDEX_EVIDENCE_UNRESOLVED');
    need(input.evidence.every(e => e && (textField(e.quote) || textField(e.span?.quote) || Array.isArray(e.spans) && e.spans.length && e.spans.every(s => textField(s.quote)))), 'NATIVE_INDEX_EVIDENCE_QUOTE_REQUIRED');
    if (input.source_refs.some(source => source.kind === 'MEMORY_RECORD_SOURCE')
      || input.evidence.some(evidence => evidence.source_record_ref !== undefined) || input.source_record_refs !== undefined)
      verifyMemorySources(input, view);
    if (view === 'ADOPTED_FACT') { need(input.policy === POLICY, 'NATIVE_INDEX_ADOPTION_POLICY_REQUIRED'); checkedFactStructure(input); }
    return json(input);
  });
}
function graphPayload(records, view) {
  const nodes = new Map(), edges = new Map();
  const sourceKey = source => source.kind === 'MEMORY_RECORD_SOURCE'
    ? key('MEMORY_RECORD_SOURCE', source.record_ref, source.revision) : key('DOCUMENT', source.doc_ref, source.revision);
  function localSubject(ref, sourceRefs) {
    const id = key('SOURCE_LOCAL_SUBJECT', ref), prior = nodes.get(id), combined = [...(prior?.source_refs ?? []), ...sourceRefs];
    const sources = [...new Map(combined.map(source => [sourceKey(source), source])).values()].sort((a, b) => canonical(a).localeCompare(canonical(b)));
    nodes.set(id, {id, kind: 'SOURCE_LOCAL_SUBJECT', subject_ref: ref, source_refs: sources, identity_policy: 'EXACT_SOURCE_LOCAL_REF_ONLY_NO_CANONICAL_MERGE'});
    return id;
  }
  for (const record of records) {
    const recordId = key(view, record.record_ref), factRef = record.fact_ref ?? record.record_ref;
    const structure = view !== 'SOURCE' ? Object.fromEntries(['subject_ref', 'predicate', 'object_ref', 'direction', 'attribute', 'raw_value', 'unit', 'rule_text', 'participants', 'conditions', 'negation', 'modality', 'time_text', 'version_text','gaps','warnings','source_refs','native_action','action_domain_nodes','action_domain_edges','action_domain_policy','valid_time','valid_time_input','source_record_refs','process_links'].filter(field => Object.hasOwn(record, field)).map(field => [field, record[field]])) : {};
    const memorySource = view === 'SOURCE' && record.source_refs.some(source => source.kind === 'MEMORY_RECORD_SOURCE');
    nodes.set(recordId, {id: recordId, kind: view === 'SOURCE' ? memorySource ? 'MEMORY_RECORD_SOURCE' : 'SOURCE_RECORD' : view === 'EXTRACTED_KNOWLEDGE' ? 'EXTRACTED_KNOWLEDGE' : 'ADOPTED_FACT', record_ref: record.record_ref, representation: record.representation, text: record.text, evidence_refs: record.evidence_refs, ...(memorySource ? {source_refs: record.source_refs, document_evidence_eligible: false} : {}), ...(view !== 'SOURCE' ? {fact_ref: factRef, fact_kind: record.kind, statement: record.statement ?? record.text, policy: view === 'EXTRACTED_KNOWLEDGE' ? 'EXTRACT_AND_INDEX_V1' : POLICY, ...structure} : {})});
    if (view === 'ADOPTED_FACT' || view === 'EXTRACTED_KNOWLEDGE' && ['RELATION','ATTRIBUTE','RULE'].includes(record.kind) && record.subject_ref) {
      const subject = localSubject(record.subject_ref, record.source_refs);
      const qualifiers = {record_ref: record.record_ref, fact_ref: factRef, fact_node_id: recordId, evidence_refs: record.evidence_refs, source_refs: record.source_refs, policy: view === 'EXTRACTED_KNOWLEDGE' ? 'EXTRACT_AND_INDEX_V1' : POLICY, conditions: record.conditions, negation: record.negation, modality: record.modality, ...(record.time_text !== undefined ? {time_text: record.time_text} : {}), ...(record.version_text !== undefined ? {version_text: record.version_text} : {})};
      const edge = (relation, source, target, fields = {}) => {const row = {id: key(recordId, relation, source, target, fields), kind: relation, source, target, ...qualifiers, ...fields}; edges.set(row.id, row);};
      edge('SUBJECT', recordId, subject);
      if (record.kind === 'RELATION') {
        const object = localSubject(record.object_ref, record.source_refs);
        edge('OBJECT', recordId, object);
        edge(view === 'EXTRACTED_KNOWLEDGE' ? 'EXTRACTED_RELATION' : 'ADOPTED_RELATION', subject, object, {predicate: record.predicate, direction: record.direction});
      } else if (record.kind === 'ATTRIBUTE') {
        const id = key('ATTRIBUTE_VALUE', record.record_ref);
        nodes.set(id, {id, kind: 'ATTRIBUTE_VALUE', ...qualifiers, attribute: record.attribute, raw_value: record.raw_value, unit: record.unit ?? null});
        edge('HAS_ATTRIBUTE_VALUE', recordId, id);
        edge(view === 'EXTRACTED_KNOWLEDGE' ? 'EXTRACTED_ATTRIBUTE' : 'ADOPTED_ATTRIBUTE', subject, id, {attribute: record.attribute, raw_value: record.raw_value, unit: record.unit ?? null});
      } else {
        const id = key('RULE', record.record_ref);
        nodes.set(id, {id, kind: view === 'EXTRACTED_KNOWLEDGE' ? 'EXTRACTED_RULE' : 'ADOPTED_RULE', ...qualifiers, rule_text: record.rule_text, participants: record.participants ?? []});
        edge('RULE', recordId, id);
        edge('APPLIES_TO', id, subject);
        for (const participant of record.participants ?? []) edge('RULE_PARTICIPANT', id, localSubject(participant.subject_ref, record.source_refs), {role: participant.role, subject_ref: participant.subject_ref});
      }
    }
    for (const source of record.source_refs) {
      const id = sourceKey(source);
      nodes.set(id, {id, kind: source.kind === 'MEMORY_RECORD_SOURCE' ? 'MEMORY_RECORD_SOURCE' : 'DOCUMENT', ...source});
      const edge = {id: key(recordId, 'DERIVED_FROM', id), source: recordId, target: id, kind: 'DERIVED_FROM', record_ref: record.record_ref}; edges.set(edge.id, edge);
    }
    for (const evidence of record.evidence) {
      const ref = evidence.evidence_ref ?? evidence.id, id = key('EVIDENCE', ref);
      const node = {id, kind: 'EVIDENCE', evidence_ref: ref, evidence};
      need(!nodes.has(id) || hash(nodes.get(id)) === hash(node), 'NATIVE_INDEX_EVIDENCE_COLLISION'); nodes.set(id, node);
      const edge = {id: key(recordId, 'CITES', id), source: recordId, target: id, kind: 'CITES', record_ref: record.record_ref}; edges.set(edge.id, edge);
    }
  }
  return {representation: view === 'ADOPTED_FACT' ? 'NATIVE_ADOPTED_FACT_GRAPH' : view === 'EXTRACTED_KNOWLEDGE' ? 'EXTRACTED_KNOWLEDGE_GRAPH' : 'NATIVE_PROVENANCE_GRAPH', graph_policy: view === 'EXTRACTED_KNOWLEDGE' ? 'native-extracted-structure-graph/1' : GRAPH_POLICY, semantic_relations_inferred: false, nodes: [...nodes.values()], edges: [...edges.values()]};
}
function tokens(text) {
  // Match Han runs separately: \p{L}+ from a Latin prefix also consumes Han.
  const values = text.toLocaleLowerCase('und').normalize('NFKC').match(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}_])+/gu) ?? [], result = [];
  for (const value of values) {
    if (!/^\p{Script=Han}/u.test(value)) { result.push(value); continue; }
    const characters = [...value]; result.push(...characters);
    for (let i = 1; i < characters.length; i++) result.push(characters[i - 1] + characters[i]);
  }
  return result;
}
function lexicalScore(text, queryTokens) {
  const counts = new Map(); for (const token of tokens(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  return [...queryTokens].reduce((score, token) => score + (counts.has(token) ? 1 + Math.log(counts.get(token)) : 0), 0);
}
function cosine(a, b) {
  const aNorm = Math.hypot(...a), bNorm = Math.hypot(...b);
  need(Number.isFinite(aNorm) && Number.isFinite(bNorm) && aNorm > 0 && bNorm > 0, 'NATIVE_INDEX_VECTOR_INVALID');
  return a.reduce((sum, n, i) => sum + n / aNorm * (b[i] / bNorm), 0);
}

export function createNativeBuildIndex({store, runId, libraryId, snapshotId, assertOpen}) {
  need(store && ['getRecord', 'putRecord', 'transaction'].every(name => typeof store[name] === 'function') && [runId, libraryId, snapshotId].every(textField) && typeof assertOpen === 'function', 'NATIVE_INDEX_HOST_REQUIRED');
  const scope = {run_id: runId, library_id: libraryId, source_snapshot_ref: snapshotId}, scopeKey = key(libraryId, snapshotId, runId);
  const head = view => store.getRecord(kind(view, 'head'), scopeKey);
  const suspensionKey = key(scopeKey, 'suspensions');
  // An empty document source is permitted only for a server-installed, audited
  // correction. The original document is background to the old claim, not
  // evidence that it contains the human's replacement value.
  function verifyHumanCorrection(record) {
    const checked = value => {const {record_sha256, ...body} = value ?? {}; need(value && record_sha256 === hash(body), 'NATIVE_INDEX_HUMAN_CORRECTION_AUDIT_CHANGED'); return value;};
    const origin = record.correction_origin;
    need(record.author === 'HUMAN' && record.source === 'HUMAN' && record.answer_authority === 'HUMAN_CORRECTION' &&
      origin?.policy === 'KNOWLEDGE_CORRECTION_V1' && origin.library_id === libraryId && origin.source_snapshot_ref === snapshotId &&
      record.review_event_ref === origin.review_event_ref && record.review_source_revision_ref === origin.source_revision_ref &&
      record.review_item_ref === origin.review_item_ref &&
      ['source_refs','evidence','evidence_refs'].every(name => Array.isArray(record[name]) && record[name].length === 0),
    'NATIVE_INDEX_HUMAN_CORRECTION_INVALID');
    const event = checked(store.getRecord('native_library_review_event_v1', origin.review_event_ref));
    const baseRef = record.retrieval_fragment ? record.knowledge_ref : record.record_ref;
    need(event.library_id === libraryId && event.source_snapshot_ref === snapshotId && event.item_kind === 'KNOWLEDGE' &&
      event.action === 'replace' && event.item_target_ref === baseRef && event.source_run_id === origin.source_run_id &&
      event.source_revision_ref === origin.source_revision_ref && event.source_revision_sha256 === origin.source_revision_sha256 &&
      event.item_ref === origin.review_item_ref && event.reason === origin.reason &&
      hash(origin.before_knowledge) === origin.before_sha256,
    'NATIVE_INDEX_HUMAN_CORRECTION_EVENT_BINDING_CHANGED');
    const sourceRevision = checked(store.getRecord('native_library_knowledge_revision_v1', origin.source_revision_ref));
    need(sourceRevision.library_id === libraryId && sourceRevision.run_id === origin.source_run_id &&
      sourceRevision.source_snapshot_ref === snapshotId && sourceRevision.record_sha256 === origin.source_revision_sha256,
    'NATIVE_INDEX_HUMAN_CORRECTION_SOURCE_CHANGED');
    const installation = checked(store.getRecord('native_library_review_installation_v1', runId));
    const pointer = store.getRecord('native_library_knowledge_projection_v1', runId);
    const revision = checked(store.getRecord('native_library_knowledge_revision_v1', pointer?.revision_ref));
    need(installation.library_id === libraryId && installation.source_snapshot_ref === snapshotId &&
      installation.target_run_id === runId && installation.target_revision_ref === revision.revision_ref &&
      installation.event_refs.includes(origin.review_event_ref) && revision.run_id === runId && revision.library_id === libraryId &&
      revision.source_snapshot_ref === snapshotId && pointer.record_sha256 === revision.record_sha256,
    'NATIVE_INDEX_HUMAN_CORRECTION_INSTALLATION_CHANGED');
    const projected = revision.knowledge.find(row => row.record_ref === baseRef);
    need(projected && projected.review_event_ref === origin.review_event_ref,
      'NATIVE_INDEX_HUMAN_CORRECTION_RECORD_CHANGED');
    // Application retargets the run envelope. All knowledge content and audit
    // metadata must still match the immutable installed library projection.
    const content = row => {const {run_id, application_origin, retrieval_fragment, ...body} = row; return body;};
    const expected = {...projected};
    if (record.retrieval_fragment) {
      const {start,end} = record.retrieval_fragment;
      need(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= projected.text.length &&
        record.record_ref === baseRef + '_fragment_' + start, 'NATIVE_INDEX_HUMAN_CORRECTION_FRAGMENT_CHANGED');
      expected.record_ref = record.record_ref; expected.knowledge_ref = record.knowledge_ref; expected.text = projected.text.slice(start,end);
    }
    need(hash(content(record)) === hash(content(expected)), 'NATIVE_INDEX_HUMAN_CORRECTION_RECORD_CHANGED');
  }
  function boundRecords(records, view) {
    return checkedRecords(records, view, verifyHumanCorrection,
      (record, recordView) => verifyMemoryIndexSources({store, libraryId, record, view: recordView})).map(record => {
      for (const item of [record, ...record.evidence]) {
        need(Object.entries(scope).every(([name, value]) => item[name] === undefined || item[name] === value), 'NATIVE_INDEX_RECORD_BINDING_CHANGED');
        if (item.source_record_ref === undefined && item.kind !== 'MEMORY_RECORD_EVIDENCE'
          && (item.doc_ref !== undefined || item.revision !== undefined && item.evidence_ref !== undefined))
          need(record.source_refs.some(source => source.kind !== 'MEMORY_RECORD_SOURCE' && source.doc_ref === item.doc_ref && source.revision === item.revision), 'NATIVE_INDEX_EVIDENCE_SOURCE_CHANGED');
      }
      return record;
    });
  }
  function verifyLibraryGraph(libraryKnowledge) {
    const graph = libraryKnowledge?.domain_graph;
    if (!graph) return;
    need(textField(libraryKnowledge.revision_ref) && graph.revision_ref === libraryKnowledge.revision_ref
      && Array.isArray(graph.nodes) && Array.isArray(graph.edges) && Array.isArray(graph.knowledge),
    'NATIVE_INDEX_LIBRARY_DOMAIN_GRAPH_INVALID');
    const nodes = new Set(graph.nodes.map(node => node.id)), edges = new Set(graph.edges.map(edge => edge.id));
    need(nodes.size === graph.nodes.length && graph.nodes.every(node => textField(node.id))
      && edges.size === graph.edges.length && graph.edges.every(edge => textField(edge.id) && nodes.has(edge.source) && nodes.has(edge.target)),
    'NATIVE_INDEX_LIBRARY_DOMAIN_GRAPH_BINDING_CHANGED');
    const knowledge = new Set((libraryKnowledge.knowledge ?? []).map(record => record.knowledge_ref ?? record.record_ref));
    need(graph.knowledge.every(record => knowledge.has(record.knowledge_ref ?? record.record_ref)),
      'NATIVE_INDEX_LIBRARY_DOMAIN_KNOWLEDGE_CHANGED');
    for (const item of [...graph.nodes, ...graph.edges, ...graph.knowledge]) {
      if (item.kind === 'MEMORY_RECORD_SOURCE') {
        const binding = readMemorySourceBinding({store, libraryId, recordRef: item.record_ref});
        need(item.document_evidence_eligible === false && !Object.hasOwn(item, 'doc_ref')
          && item.source_kind === binding.source_kind && (item.version === binding.version || item.revision === binding.revision)
          && (item.text_sha256 === undefined || item.text_sha256 === binding.text_sha256), 'NATIVE_INDEX_LIBRARY_MEMORY_SOURCE_CHANGED');
      }
      if (item.source_refs?.some(source => source.kind === 'MEMORY_RECORD_SOURCE'))
        verifyMemoryIndexSources({store, libraryId, record: {...item, evidence: item.evidence ?? []}, view: 'EXTRACTED_KNOWLEDGE'});
    }
  }
  function read(view) {
    need(VIEWS.includes(view), 'NATIVE_INDEX_VIEW_INVALID');
    const current = head(view); if (!current) return null;
    need(current.view === view && hash(current.scope) === hash(scope), 'NATIVE_INDEX_HEAD_BINDING_CHANGED');
    const payload = store.getRecord(kind(view, 'payload'), current.payload_ref);
    need(payload && hash(payload) === current.payload_sha256 && payload.index_revision === current.index_revision && hash(payload.scope) === hash(scope) && payload.view === view, 'NATIVE_INDEX_PAYLOAD_CHANGED');
    need(hash(payload.records) === payload.manifest.record_set_sha256 && hash(payload.graph) === payload.manifest.graph_sha256 && payload.manifest.status === 'READY', 'NATIVE_INDEX_MANIFEST_CHANGED');
    boundRecords(payload.records, view);
    verifyLibraryGraph(payload.graph.library_knowledge);
    if (payload.capability !== 'LEXICAL') {
      need(hash(spaceBinding(payload.embedding_space)) === hash(payload.embedding_space), 'NATIVE_INDEX_SPACE_CHANGED');
      need(Object.keys(payload.vectors).length === new Set(payload.records.map(r => r.text)).size && payload.records.every(r => finiteVector(payload.vectors[hash(r.text)], payload.embedding_space.dimensions)), 'NATIVE_INDEX_VECTORS_CHANGED');
    }
    return {current, payload};
  }
  const blocked = () => store.getRecord('native_fact_index_suspensions_v1', suspensionKey)?.bindings ?? [];
  const eligible = (record, adoption) => !blocked().some(b => (b.record_ref === record.record_ref || b.fact_ref === (record.fact_ref ?? record.record_ref)) && b.adoption_revision_ref === adoption);
  function publicState(view) {
    const active = read(view); if (!active) return null;
    const {current, payload} = active, valid = view === 'SOURCE' ? payload.records.length : payload.records.filter(r => eligible(r, payload.adoption_revision_ref)).length;
    return {...json(current), status: 'READY', capability: payload.capability, records_total: payload.records.length, effective_records: valid, suspended_records: payload.records.length - valid, embedding_space: payload.embedding_space, manifest: payload.manifest};
  }
  async function vectorsFor(records, embeddingSpace, embed) {
    const spaceId = hash(embeddingSpace), texts = [...new Set(records.map(r => r.text))], result = {}, missing = [];
    for (const text of texts) {
      const id = hash({space: spaceId, input_type: 'document', text_sha256: hash(text)}), cached = store.getRecord('native_vector_cache_v1', id);
      if (cached) {
        const {cache_sha256, ...body} = cached;
        need(hash(body) === cache_sha256 && cached.space_sha256 === spaceId && cached.text_sha256 === hash(text) && cached.input_type === 'document', 'NATIVE_INDEX_CACHE_CHANGED');
        result[hash(text)] = normalizedVector(cached.values, embeddingSpace);
      } else {
        const pending = store.getRecord('native_vector_pending_v1', id);
        need(!pending, 'NATIVE_INDEX_EMBEDDING_NO_AUTOMATIC_RETRY');
        missing.push(text);
      }
    }
    for (const batch of planBatches(missing, embeddingSpace)) {
      assertOpen();
      const refs = batch.map(text => hash({space: spaceId, input_type: 'document', text_sha256: hash(text)}));
      store.transaction(() => {
        for (const id of refs) {
          need(!store.getRecord('native_vector_pending_v1', id) && !store.getRecord('native_vector_cache_v1', id), 'NATIVE_INDEX_EMBEDDING_CAS_MISMATCH');
          store.putRecord('native_vector_pending_v1', id, {id, ...scope, status: 'STARTED', space_sha256: spaceId});
        }
      });
      let returned = false;
      try {
        const values = await embed([...batch], {inputType: 'document'}); returned = true;
        need(Array.isArray(values) && values.length === batch.length, 'NATIVE_INDEX_EMBEDDING_RESPONSE_INVALID');
        const checked = values.map(vector => normalizedVector(vector, embeddingSpace));
        store.transaction(() => {
          batch.forEach((text, i) => {
            const body = {id: refs[i], space_sha256: spaceId, input_type: 'document', text_sha256: hash(text), values: checked[i], completed_run_id: runId};
            store.putRecord('native_vector_cache_v1', refs[i], {...body, cache_sha256: hash(body)});
            store.putRecord('native_vector_pending_v1', refs[i], {id: refs[i], ...scope, status: 'RETURNED', space_sha256: spaceId}); result[hash(text)] = checked[i];
          });
        });
        assertOpen();
      } catch (error) {
        store.transaction(() => { for (const id of refs) store.putRecord('native_vector_pending_v1', id, {id, ...scope, status: returned ? 'RETURNED_REJECTED' : 'FAILED_OR_UNKNOWN_NO_RETRY', space_sha256: spaceId}); });
        throw error;
      }
    }
    return result;
  }
  function payloadFor(view, records, vectors, embeddingSpace, capability, adoption, libraryKnowledge=null) {
    assertOpen();
    verifyLibraryGraph(libraryKnowledge);
    const graph = {...graphPayload(records, view),...(libraryKnowledge?{library_knowledge:json(libraryKnowledge),library_revision_ref:libraryKnowledge.revision_ref}:{})}, body = {...scope, view, records, vectors, graph_sha256: hash(graph), embedding_space: embeddingSpace, capability, adoption_revision_ref: adoption}, revision = 'nidx_' + hash(body);
    const manifest = {...(libraryKnowledge?{library_revision_ref:libraryKnowledge.revision_ref}:{}),contract_version: 'native-build-index-v1', ...scope, view, index_revision: revision, status: 'READY', capability, record_set_sha256: hash(records), graph_sha256: hash(graph), embedding_space_sha256: embeddingSpace ? hash(embeddingSpace) : null, records_total: records.length, vectors_completed: Object.keys(vectors).length, adoption_revision_ref: adoption, policy: view === 'ADOPTED_FACT' ? POLICY : null};
    const payload = {scope, view, index_revision: revision, records, vectors, graph, manifest, embedding_space: embeddingSpace, capability, adoption_revision_ref: adoption}, payloadRef = key(scopeKey, revision), payloadHash = hash(payload);
    const next = {...(libraryKnowledge?{library_revision_ref:libraryKnowledge.revision_ref}:{}),scope, view, index_revision: revision, payload_ref: payloadRef, payload_sha256: payloadHash, adoption_revision_ref: adoption};
    return {view, payload, next_head: next, payload_ref: payloadRef, payload_sha256: payloadHash};
  }
  function persistPayload(preparedView) {
    const {view, payload, payload_ref: payloadRef, payload_sha256: payloadHash} = preparedView;
    const prior = store.getRecord(kind(view, 'payload'), payloadRef);
    need(!prior || hash(prior) === payloadHash, 'NATIVE_INDEX_IMMUTABLE_CONFLICT');
    if (!prior) store.putRecord(kind(view, 'payload'), payloadRef, payload);
    need(hash(store.getRecord(kind(view, 'payload'), payloadRef)) === payloadHash, 'NATIVE_INDEX_READBACK_CHANGED');
  }
  function activate(view, records, vectors, embeddingSpace, capability, adoption, expectedHead, libraryKnowledge=null) {
    const prepared = payloadFor(view, records, vectors, embeddingSpace, capability, adoption, libraryKnowledge);
    return store.transaction(() => {
      assertOpen(); need(hash(head(view)) === hash(expectedHead), 'NATIVE_INDEX_HEAD_CAS_MISMATCH');
      persistPayload(prepared);
      store.putRecord(kind(view, 'head'), scopeKey, prepared.next_head);
      need(hash(head(view)) === hash(prepared.next_head), 'NATIVE_INDEX_HEAD_READBACK_CHANGED');
      read(view); return prepared.next_head;
    });
  }
  function chunkKnowledge(input, space) {
    need(Array.isArray(input), 'NATIVE_INDEX_RECORDS_REQUIRED');
    const chunks = [], max = space ? Math.min(batchLimits(space).inputChars, batchLimits(space).chars,
      Math.floor(Math.min(batchLimits(space).inputBytes, batchLimits(space).bytes) / 4), 3000) : 3000;
    need(max > 1, 'NATIVE_INDEX_BATCH_LIMIT_INVALID');
    for (const record of input) {
      need(record && typeof record.text === 'string', 'NATIVE_INDEX_TEXT_INVALID');
      if (record.text.length <= max) { chunks.push(record); continue; }
      for (let at = 0; at < record.text.length;) {
        let end = Math.min(at + max, record.text.length);
        if (end < record.text.length && /[\uD800-\uDBFF]/.test(record.text[end - 1])) end--;
        chunks.push({...record, knowledge_ref: record.knowledge_ref ?? record.record_ref,
          record_ref: record.record_ref + '_fragment_' + at, text: record.text.slice(at, end), retrieval_fragment: {start: at, end}});
        at = end;
      }
    }
    return chunks;
  }
  function checkedPrepared(prepared) {
    const {prepared_sha256, ...body} = prepared ?? {};
    need(prepared && prepared.contract_version === 'native-prepared-knowledge-index-v1'
      && prepared_sha256 === hash(body) && hash(prepared.scope) === hash(scope)
      && textField(prepared.prepared_ref), 'NATIVE_INDEX_PREPARED_CHANGED');
    const saved = store.getRecord('native_knowledge_index_prepared_v1', key(scopeKey, prepared.prepared_ref));
    need(saved && hash(saved) === hash(prepared), 'NATIVE_INDEX_PREPARED_CHANGED');
    for (const view of ['SOURCE', 'EXTRACTED_KNOWLEDGE']) {
      const item = prepared.views?.[view];
      need(item && item.next_head?.view === view && hash(item.next_head.scope) === hash(scope)
        && item.next_head.payload_ref === item.payload_ref && item.next_head.payload_sha256 === item.payload_sha256,
      'NATIVE_INDEX_PREPARED_VIEW_CHANGED');
      const payload = store.getRecord(kind(view, 'payload'), item.payload_ref);
      need(payload && hash(payload) === item.payload_sha256 && payload.view === view
        && payload.index_revision === item.next_head.index_revision && hash(payload.scope) === hash(scope)
        && hash(payload.records) === payload.manifest.record_set_sha256 && hash(payload.graph) === payload.manifest.graph_sha256,
      'NATIVE_INDEX_PREPARED_PAYLOAD_CHANGED');
      boundRecords(payload.records, view);
      verifyLibraryGraph(payload.graph.library_knowledge);
      if (payload.capability !== 'LEXICAL') {
        need(hash(spaceBinding(payload.embedding_space)) === hash(payload.embedding_space)
          && Object.keys(payload.vectors).length === new Set(payload.records.map(record => record.text)).size
          && payload.records.every(record => finiteVector(payload.vectors[hash(record.text)], payload.embedding_space.dimensions)),
        'NATIVE_INDEX_PREPARED_VECTORS_CHANGED');
      }
    }
    return prepared;
  }
  async function prepareKnowledge({sources, knowledge, embed, embeddingSpace, capability = 'LEXICAL', libraryKnowledge = null}) {
    need(store.db?.isTransaction === false, 'NATIVE_INDEX_PREPARE_REQUIRES_TRANSACTION_OUTSIDE');
    assertOpen(); need(CAPABILITIES.includes(capability), 'NATIVE_INDEX_CAPABILITY_INVALID');
    const space = capability === 'LEXICAL' ? null : spaceBinding(embeddingSpace);
    if (space) need(typeof embed === 'function', 'NATIVE_INDEX_EMBEDDING_REQUIRED');
    const library = libraryKnowledge ? json(libraryKnowledge) : null;
    verifyLibraryGraph(library);
    const expected = Object.fromEntries(['SOURCE', 'EXTRACTED_KNOWLEDGE'].map(view => [view, json(head(view))]));
    const inputs = {SOURCE: boundRecords(chunkKnowledge(sources, space), 'SOURCE'),
      EXTRACTED_KNOWLEDGE: boundRecords(chunkKnowledge(knowledge, space), 'EXTRACTED_KNOWLEDGE')};
    const views = {};
    for (const view of ['SOURCE', 'EXTRACTED_KNOWLEDGE']) {
      const records = inputs[view], vectors = space ? await vectorsFor(records, space, embed) : {};
      need(store.db?.isTransaction === false, 'NATIVE_INDEX_PREPARE_REQUIRES_TRANSACTION_OUTSIDE');
      views[view] = payloadFor(view, records, vectors, space, capability, null, view === 'EXTRACTED_KNOWLEDGE' ? library : null);
    }
    assertOpen();
    const body = {contract_version: 'native-prepared-knowledge-index-v1', scope: json(scope), expected_heads: expected,
      views: Object.fromEntries(Object.entries(views).map(([view, {next_head, payload_ref, payload_sha256}]) =>
        [view, {next_head, payload_ref, payload_sha256}])),
      source_index_revision: views.SOURCE.next_head.index_revision,
      knowledge_index_revision: views.EXTRACTED_KNOWLEDGE.next_head.index_revision,
      library_revision_ref: library?.revision_ref ?? null,
      graph_sha256: views.EXTRACTED_KNOWLEDGE.payload.manifest.graph_sha256};
    const envelope = {...body, prepared_ref: 'nidxprepared_' + hash(body)};
    const prepared = {...envelope, prepared_sha256: hash(envelope)};
    store.transaction(() => {
      for (const item of Object.values(views)) persistPayload(item);
      const id = key(scopeKey, prepared.prepared_ref), prior = store.getRecord('native_knowledge_index_prepared_v1', id);
      need(!prior || hash(prior) === hash(prepared), 'NATIVE_INDEX_PREPARED_IMMUTABLE_CONFLICT');
      if (!prior) store.putRecord('native_knowledge_index_prepared_v1', id, prepared);
    });
    checkedPrepared(prepared);
    return json(prepared);
  }
  function readPreparedKnowledge(prepared) {
    checkedPrepared(prepared);
    for (const view of ['SOURCE', 'EXTRACTED_KNOWLEDGE'])
      need(hash(head(view)) === hash(prepared.views[view].next_head), 'NATIVE_INDEX_PREPARED_HEAD_CHANGED');
    return {verified: true, prepared_ref: prepared.prepared_ref, scope: json(scope),
      source_index: publicState('SOURCE'), knowledge_index: publicState('EXTRACTED_KNOWLEDGE'),
      source_index_revision: prepared.source_index_revision, knowledge_index_revision: prepared.knowledge_index_revision,
      library_revision_ref: prepared.library_revision_ref, graph_sha256: prepared.graph_sha256};
  }
  function applyPreparedKnowledge(prepared) {
    need(store.db?.isTransaction === true, 'NATIVE_INDEX_CALLER_TRANSACTION_REQUIRED');
    checkedPrepared(prepared); assertOpen();
    for (const view of ['SOURCE', 'EXTRACTED_KNOWLEDGE'])
      need(hash(head(view)) === hash(prepared.expected_heads[view]), 'NATIVE_INDEX_HEAD_CAS_MISMATCH');
    const savepoint = 'native_index_prepared_' + randomUUID().replaceAll('-', '');
    store.db.exec('SAVEPOINT ' + savepoint);
    try {
      for (const view of ['SOURCE', 'EXTRACTED_KNOWLEDGE']) {
        store.putRecord(kind(view, 'head'), scopeKey, prepared.views[view].next_head);
        need(hash(head(view)) === hash(prepared.views[view].next_head), 'NATIVE_INDEX_HEAD_READBACK_CHANGED');
      }
      const receipt = readPreparedKnowledge(prepared);
      store.db.exec('RELEASE SAVEPOINT ' + savepoint);
      return receipt;
    } catch (error) {
      store.db.exec('ROLLBACK TO SAVEPOINT ' + savepoint);
      store.db.exec('RELEASE SAVEPOINT ' + savepoint);
      throw error;
    }
  }
  function snapshot() {
    return {source_index: publicState('SOURCE'), fact_index: publicState('ADOPTED_FACT'), knowledge_index: publicState('EXTRACTED_KNOWLEDGE'), last_build: store.getRecord('native_index_operation_v1', scopeKey)};
  }
  return Object.freeze({
    prepareKnowledge, applyPreparedKnowledge, readPreparedKnowledge,
    async buildKnowledge({sources,knowledge,embed,embeddingSpace,capability='LEXICAL',libraryKnowledge=null}) {
      assertOpen();need(CAPABILITIES.includes(capability),'NATIVE_INDEX_CAPABILITY_INVALID');
      const space=capability==='LEXICAL'?null:spaceBinding(embeddingSpace);if(space)need(typeof embed==='function','NATIVE_INDEX_EMBEDDING_REQUIRED');
      for(const [view,input]of [['SOURCE',sources],['EXTRACTED_KNOWLEDGE',knowledge]]){
        const chunks=chunkKnowledge(input,space);
        const records=boundRecords(chunks,view),expected=head(view),vectors=space?await vectorsFor(records,space,embed):{};
        activate(view,records,vectors,space,capability,null,expected,view==='EXTRACTED_KNOWLEDGE'?libraryKnowledge:null);
      }return snapshot();
    },
    async build({sources, facts, adoptionRevision, embed, embeddingSpace, capability = 'LEXICAL'}) {
      assertOpen(); need(CAPABILITIES.includes(capability), 'NATIVE_INDEX_CAPABILITY_INVALID');
      const sourceRecords = boundRecords(sources, 'SOURCE'), factRecords = boundRecords(facts, 'ADOPTED_FACT'), adoption = revisionRef(adoptionRevision);
      need(textField(adoption), 'NATIVE_INDEX_ADOPTION_REVISION_REQUIRED');
      const space = capability === 'LEXICAL' ? null : spaceBinding(embeddingSpace);
      if (space) { need(typeof embed === 'function', 'NATIVE_INDEX_EMBEDDING_REQUIRED'); planBatches([...new Set([...sourceRecords, ...factRecords].map(r => r.text))], space); }
      const expected = Object.fromEntries(VIEWS.map(view => [view, head(view)])), planHash = hash({scope, sources: sourceRecords, facts: factRecords, adoption, space, capability, graph_policy: GRAPH_POLICY}), prior = store.getRecord('native_index_build_plan_v1', key(scopeKey, planHash));
      if (prior?.status === 'COMPLETE') {
        need(head('SOURCE')?.index_revision === prior.source_revision && head('ADOPTED_FACT')?.index_revision === prior.fact_revision, 'NATIVE_INDEX_IDEMPOTENT_HEAD_SUPERSEDED'); return snapshot();
      }
      need(!prior, 'NATIVE_INDEX_BUILD_NO_AUTOMATIC_RETRY');
      const operation = {operation_ref: 'nindexop_' + planHash, ...scope, plan_sha256: planHash, status: 'STARTED'};
      store.transaction(() => { need(store.getRecord('native_index_operation_v1', scopeKey)?.status !== 'STARTED', 'NATIVE_INDEX_BUILD_IN_PROGRESS'); need(!store.getRecord('native_index_build_plan_v1', key(scopeKey, planHash)), 'NATIVE_INDEX_BUILD_CAS_MISMATCH'); store.putRecord('native_index_build_plan_v1', key(scopeKey, planHash), operation); store.putRecord('native_index_operation_v1', scopeKey, operation); });
      try {
        const sourceVectors = space ? await vectorsFor(sourceRecords, space, embed) : {};
        const source = activate('SOURCE', sourceRecords, sourceVectors, space, capability, null, expected.SOURCE);
        const factVectors = space ? await vectorsFor(factRecords, space, embed) : {};
        const fact = activate('ADOPTED_FACT', factRecords, factVectors, space, capability, adoption, expected.ADOPTED_FACT);
        const completed = {...operation, status: 'COMPLETE', source_revision: source.index_revision, fact_revision: fact.index_revision};
        store.transaction(() => { store.putRecord('native_index_build_plan_v1', key(scopeKey, planHash), completed); store.putRecord('native_index_operation_v1', scopeKey, completed); });
        return snapshot();
      } catch (error) {
        const failed = {...operation, status: 'FAILED_NO_RETRY', error_code: error.code ?? 'NATIVE_INDEX_BUILD_FAILED'};
        store.transaction(() => { store.putRecord('native_index_build_plan_v1', key(scopeKey, planHash), failed); store.putRecord('native_index_operation_v1', scopeKey, failed); }); throw error;
      }
    },
    query({view = 'SOURCE', query, vector, limit = 12, embeddingSpace} = {}) {
      need(typeof query === 'string' && query.isWellFormed() && query.length <= 16000 && Number.isInteger(limit) && limit > 0 && limit <= 100, 'NATIVE_INDEX_QUERY_INVALID');
      const active = read(view); if (!active) return {view, status: 'UNAVAILABLE', hits: []};
      const {payload} = active, values = Array.isArray(vector) ? vector : vector?.values, enumerate = !query.trim();
      need(!enumerate || !vector, 'NATIVE_INDEX_QUERY_VECTOR_WITHOUT_QUERY');
      need(!vector || payload.capability !== 'LEXICAL', 'NATIVE_INDEX_VECTOR_NOT_AVAILABLE');
      need(enumerate || payload.capability !== 'VECTOR' || vector, 'NATIVE_INDEX_QUERY_VECTOR_REQUIRED');
      const suppliedSpace = embeddingSpace ?? (!Array.isArray(vector) ? vector?.embeddingSpace ?? vector?.embedding_space : null);
      if (suppliedSpace) need(payload.embedding_space && hash(spaceBinding(suppliedSpace)) === hash(payload.embedding_space), 'NATIVE_INDEX_QUERY_SPACE_MISMATCH');
      const queryVector = vector ? normalizedVector(values, payload.embedding_space) : null, queryTokens = new Set(tokens(query)), records = payload.records.filter(r => view === 'SOURCE' || eligible(r, payload.adoption_revision_ref));
      const scored = records.map(record => ({record, lexical: lexicalScore(record.text, queryTokens), vector: queryVector ? cosine(queryVector, payload.vectors[hash(record.text)]) : null}));
      const order = (field, rows) => [...rows].sort((a, b) => b[field] - a[field] || a.record.record_ref.localeCompare(b.record.record_ref));
      const lexical = order('lexical', scored.filter(r => r.lexical > 0)), semantic = queryVector ? order('vector', scored) : [], mode = enumerate ? 'ENUMERATE' : queryVector ? payload.capability : 'LEXICAL';
      const lexicalRanks = new Map(lexical.map((r, i) => [r.record.record_ref, i + 1])), vectorRanks = new Map(semantic.map((r, i) => [r.record.record_ref, i + 1]));
      const selected = mode === 'ENUMERATE' ? scored.sort((a, b) => a.record.record_ref.localeCompare(b.record.record_ref)) : mode === 'LEXICAL' ? lexical : mode === 'VECTOR' ? semantic : scored.map(r => ({...r, fused: (lexicalRanks.has(r.record.record_ref) ? 1 / (60 + lexicalRanks.get(r.record.record_ref)) : 0) + 1 / (60 + vectorRanks.get(r.record.record_ref))})).sort((a, b) => b.fused - a.fused || a.record.record_ref.localeCompare(b.record.record_ref));
      return {view, status: 'READY', mode, capability: payload.capability, index_revision: payload.index_revision, source_snapshot_ref: snapshotId, adoption_revision_ref: payload.adoption_revision_ref, embedding_space: payload.embedding_space, hits: selected.slice(0, limit).map(r => ({...json(r.record), score: mode === 'ENUMERATE' ? null : mode === 'LEXICAL' ? r.lexical : mode === 'VECTOR' ? r.vector : r.fused, lexical_score: r.lexical, vector_score: r.vector, answer_authority: view === 'SOURCE' ? 'ORIGINAL_SOURCE' : view === 'EXTRACTED_KNOWLEDGE' ? r.record.origin_layer === 'HUMAN_CORRECTION' ? 'HUMAN_CORRECTION' : 'EXTRACTED_KNOWLEDGE' : 'ADOPTED_FACT', ...(view === 'ADOPTED_FACT' ? {policy: POLICY, adoption_revision_ref: payload.adoption_revision_ref} : {})}))};
    },
    graph({view = 'SOURCE'} = {}) {
      const active = read(view); if (!active) return {view, status: 'UNAVAILABLE', nodes: [], edges: []};
      const {payload} = active, refs = new Set(payload.records.filter(r => view === 'SOURCE' || eligible(r, payload.adoption_revision_ref)).map(r => r.record_ref));
      const edges = payload.graph.edges.filter(e => refs.has(e.record_ref)), connected = new Set(edges.flatMap(edge => [edge.source, edge.target]));
      return {view, status: 'READY', index_revision: payload.index_revision, adoption_revision_ref: payload.adoption_revision_ref, ...json(payload.graph),...(view==='EXTRACTED_KNOWLEDGE'?{domain_graph:payload.graph.library_knowledge?.domain_graph?json(payload.graph.library_knowledge.domain_graph):{...createDomainGraph(payload.records.filter(r=>refs.has(r.record_ref))),...(payload.graph.library_knowledge?{observed_definitions:createDomainGraph(payload.records).definitions,definitions:payload.graph.library_knowledge.ontology.definitions,identity:payload.graph.library_knowledge.identity,ontology:payload.graph.library_knowledge.ontology,revision_ref:payload.graph.library_knowledge.revision_ref,pending:{identity:payload.graph.library_knowledge.identity.pending,ontology:payload.graph.library_knowledge.ontology.definitions.filter(d=>d.status==='PENDING'),unbound:payload.graph.library_knowledge.ontology.unbound_shapes}}:{})}}:{}), nodes: payload.graph.nodes.filter(n => n.record_ref ? refs.has(n.record_ref) : connected.has(n.id)), edges};
    },
    suspendFacts({factRefs, adoptionRevision}) {
      need(Array.isArray(factRefs) && factRefs.length > 0 && factRefs.every(textField) && textField(revisionRef(adoptionRevision)), 'NATIVE_INDEX_SUSPENSION_INVALID');
      return store.transaction(() => {
        const current = read('ADOPTED_FACT'); need(current, 'NATIVE_INDEX_FACT_INDEX_UNAVAILABLE');
        const row = store.getRecord('native_fact_index_suspensions_v1', suspensionKey) ?? {scope, bindings: []};
        for (const factRef of new Set(factRefs)) {
          const record = current.payload.records.find(r => r.record_ref === factRef || r.fact_ref === factRef);
          need(record, 'NATIVE_INDEX_SUSPENSION_FACT_UNKNOWN');
          if (!row.bindings.some(b => b.record_ref === record.record_ref && b.adoption_revision_ref === current.payload.adoption_revision_ref)) row.bindings.push({record_ref: record.record_ref, fact_ref: record.fact_ref ?? record.record_ref, adoption_revision_ref: current.payload.adoption_revision_ref, suspended_by_adoption_revision_ref: revisionRef(adoptionRevision)});
        }
        store.putRecord('native_fact_index_suspensions_v1', suspensionKey, row); return snapshot();
      });
    },
    snapshot
  });
}
