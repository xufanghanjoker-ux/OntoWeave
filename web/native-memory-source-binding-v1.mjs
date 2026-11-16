/** Immutable projection of exact core versions. This is not another memory write service. */
import {canonical, hash, need, textField} from './cq-discovery-store-v2.mjs';

import {verifyNativeActionEvidence} from './native-action-evidence-binding-v1.mjs';

const clone = value => JSON.parse(canonical(value));
export const memorySourceBindingKey = (libraryId, recordRef) => canonical([libraryId, recordRef]);
export function readMemorySourceBinding({store, libraryId, recordRef}) {
  need(store && typeof store.getRecord === 'function' && textField(libraryId) && textField(recordRef), 'MEMORY_SOURCE_BINDING_HOST_REQUIRED');
  const value = store.getRecord('native_memory_source_binding_v1', memorySourceBindingKey(libraryId, recordRef));
  const {record_sha256, ...body} = value ?? {};
  need(value && record_sha256 === hash(body) && body.library_id === libraryId && body.record_ref === recordRef,
    'MEMORY_SOURCE_BINDING_CHANGED');
  need(body.kind === 'MEMORY_RECORD_SOURCE' && body.document_evidence_eligible === false
    && body.revision === String(body.version) && body.text_sha256 === hash(body.text), 'MEMORY_SOURCE_BINDING_INVALID');
  return clone(value);
}

export function registerMemorySourceBindings({store, coreForLibrary, libraryId, recordRefs}) {
  need(store && ['getRecord', 'putRecord', 'transaction'].every(name => typeof store[name] === 'function')
    && typeof coreForLibrary === 'function' && textField(libraryId) && Array.isArray(recordRefs)
    && recordRefs.length > 0 && recordRefs.every(textField) && new Set(recordRefs).size === recordRefs.length,
  'MEMORY_SOURCE_BINDING_HOST_REQUIRED');
  const core = coreForLibrary(libraryId);
  const prepared = recordRefs.map(recordRef => {
    const raw = core.getRawRecord(recordRef);
    need(raw?.schema_version === 'MEMORY_RECORD_V1' && raw.library_id === libraryId && raw.record_ref === recordRef
      && Number.isSafeInteger(raw.version) && raw.version > 0 && textField(raw.text) && raw.source
      && ['DOCUMENT', 'HUMAN_TEXT', 'AGENT_REPORT', 'TOOL_RECEIPT'].includes(raw.source.kind), 'MEMORY_SOURCE_RAW_BINDING_INVALID');
    const body = {schema_version: 'MEMORY_SOURCE_BINDING_V1', kind: 'MEMORY_RECORD_SOURCE',
      library_id: libraryId, record_ref: raw.record_ref, logical_ref: raw.logical_ref,
      version: raw.version, revision: String(raw.version), source_kind: raw.source.kind,
      document_evidence_eligible: false, text: raw.text, text_sha256: hash(raw.text),
      source: clone(raw.source), origin: raw.origin, source_ingested_at: raw.source_ingested_at};
    return {...body, record_sha256: hash(body)};
  });
  return store.transaction(() => prepared.map(binding => {
    const key = memorySourceBindingKey(libraryId, binding.record_ref);
    const old = store.getRecord('native_memory_source_binding_v1', key);
    need(!old || hash(old) === hash(binding), 'MEMORY_SOURCE_BINDING_IMMUTABLE_CONFLICT');
    if (!old) store.putRecord('native_memory_source_binding_v1', key, binding);
    return readMemorySourceBinding({store, libraryId, recordRef: binding.record_ref});
  }));
}

/** Works with a read-only store facade. It never consults a mutable latest core version. */
export function verifyMemoryIndexSources({store, libraryId, record, view}) {
  need(record && Array.isArray(record.source_refs) && Array.isArray(record.evidence), 'MEMORY_INDEX_SOURCE_RECORD_INVALID');
  const memory = record.source_refs.filter(source => source?.kind === 'MEMORY_RECORD_SOURCE');
  const bindings = new Map(memory.map(source => {
    need(textField(source.record_ref) && textField(source.revision) && textField(source.source_kind)
      && source.document_evidence_eligible === false && !Object.hasOwn(source, 'doc_ref'), 'MEMORY_INDEX_SOURCE_REF_INVALID');
    const binding = readMemorySourceBinding({store, libraryId, recordRef: source.record_ref});
    need(source.revision === binding.revision && source.source_kind === binding.source_kind, 'MEMORY_INDEX_SOURCE_BINDING_CHANGED');
    return [source.record_ref, binding];
  }));
  function verifyBoundEvidence(evidence, {recordOnly = false} = {}) {
    const binding = bindings.get(evidence?.source_record_ref);
    need(binding && evidence.revision === binding.revision && !Object.hasOwn(evidence,'doc_ref')
      && evidence.document_evidence_eligible !== true, 'MEMORY_INDEX_EVIDENCE_SOURCE_CHANGED');
    verifyNativeActionEvidence({source_record_ref:binding.record_ref,revision:binding.revision,text:binding.text},evidence);
    const proof=evidence.evidence_binding;
    if(recordOnly)need(proof?.proof_scope==='SOURCE_RECORD_ONLY' && evidence.kind==='MEMORY_RECORD_SOURCE_PROOF'
      && evidence.quote===null && proof.span_utf16===null
      && evidence.mapping_precision==='SOURCE_RECORD_ONLY'
      && ['start','end','span','spans','offset_unit'].every(key=>!Object.hasOwn(evidence,key))
      && evidence.document_evidence_eligible===false, 'MEMORY_INDEX_RECORD_PROOF_CHANGED');
    if(proof?.proof_scope==='LOCATED_SOURCE_SPAN') {
      const span=proof.span_utf16;
      need(span && binding.text.slice(span.start,span.end)===evidence.quote
        && (evidence.start===undefined || evidence.start===span.start)
        && (evidence.end===undefined || evidence.end===span.end), 'MEMORY_INDEX_EVIDENCE_LOCATED_SPAN_CHANGED');
    }
  }
  need(record.record_source_evidence===undefined || Array.isArray(record.record_source_evidence), 'MEMORY_INDEX_RECORD_PROOFS_INVALID');
  for(const proof of record.record_source_evidence ?? [])verifyBoundEvidence(proof,{recordOnly:true});
  // The immutable action assertion keeps all record-only/located evidence. Do not rely
  // on sentence spans alone to validate its source version and source-text digest.
  const actions=[record.native_action,...(record.action_assertions ?? []).map(row=>row.native_action)].filter(Boolean);
  for(const action of actions) {
    for(const origin of action.source_origins ?? []) {
      const binding=bindings.get(origin.source_record_ref);
      need(binding && origin.revision===binding.revision && origin.source_kind===binding.source_kind,
        'MEMORY_INDEX_ACTION_SOURCE_ORIGIN_CHANGED');
    }
    for(const evidence of action.evidence ?? [])verifyBoundEvidence(evidence);
  }
  if (memory.length && view === 'SOURCE') {
    need(memory.length === 1 && record.source_refs.length === 1, 'MEMORY_INDEX_SOURCE_VERBATIM_AMBIGUOUS');
    const binding = bindings.get(memory[0].record_ref);
    need(typeof record.text === 'string' && binding.text.includes(record.text), 'MEMORY_INDEX_SOURCE_TEXT_CHANGED');
    if (record.retrieval_fragment) {
      const {start, end} = record.retrieval_fragment;
      need(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start
        && end <= binding.text.length && binding.text.slice(start, end) === record.text,
      'MEMORY_INDEX_SOURCE_FRAGMENT_CHANGED');
    } else need(record.text === binding.text, 'MEMORY_INDEX_SOURCE_TEXT_CHANGED');
  }
  for (const evidence of record.evidence) {
    if (evidence?.source_record_ref === undefined && evidence?.kind !== 'MEMORY_RECORD_EVIDENCE') {
      need(!memory.length || textField(evidence?.doc_ref), 'MEMORY_INDEX_EVIDENCE_SOURCE_REQUIRED');
      continue;
    }
    const binding = bindings.get(evidence.source_record_ref);
    need(binding && evidence.revision === binding.revision && !Object.hasOwn(evidence, 'doc_ref')
      && evidence.document_evidence_eligible !== true, 'MEMORY_INDEX_EVIDENCE_SOURCE_CHANGED');
    if(evidence.evidence_binding) {
      verifyBoundEvidence(evidence);
      need(evidence.evidence_binding.proof_scope === 'LOCATED_SOURCE_SPAN', 'MEMORY_INDEX_RECORD_PROOF_IN_SPAN_EVIDENCE');
    }
    const quotes = evidence.spans?.length ? evidence.spans.map(span => span.quote) : [evidence.quote ?? evidence.span?.quote];
    need(quotes.length > 0 && quotes.every(quote => textField(quote) && binding.text.includes(quote)), 'MEMORY_INDEX_EVIDENCE_QUOTE_CHANGED');
  }
  if (record.source_record_refs !== undefined) {
    need(Array.isArray(record.source_record_refs) && record.source_record_refs.every(ref => bindings.has(ref))
      && memory.every(source => record.source_record_refs.includes(source.record_ref)), 'MEMORY_INDEX_SOURCE_RECORD_REFS_CHANGED');
  }
  return [...bindings.values()].map(clone);
}
