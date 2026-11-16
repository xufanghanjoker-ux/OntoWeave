/** Program-owned business-content corrections in the native review chain. No model I/O. */
import {clone, hash, need, textField} from './cq-discovery-store-v2.mjs';
import {normalizeExplicitQuantity} from './native-general-knowledge-v1.mjs';

export const KNOWLEDGE_CORRECTION_POLICY = 'KNOWLEDGE_CORRECTION_V1';
export const KNOWLEDGE_CORRECTION_KINDS = Object.freeze(['RELATION', 'ATTRIBUTE', 'RULE', 'TEXT']);
export const KNOWLEDGE_CORRECTION_FIELDS = Object.freeze([
  'text', 'statement', 'raw_value', 'attribute', 'unit', 'conditions',
  'time_text', 'version_text', 'negation', 'modality', 'predicate', 'rule_text', 'rule_name'
]);
const array = value => Array.isArray(value) ? value : [];
const has = (value, key) => Object.hasOwn(value, key);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const structuredFields = {ATTRIBUTE: ['raw_value', 'attribute', 'unit'],
  RELATION: ['predicate'], RULE: ['rule_text', 'rule_name']};
const structural = new Set(Object.values(structuredFields).flat());
const nonempty = value => textField(value) && value.length <= 128000;
const ref = record => record.record_ref ?? record.knowledge_ref;

/** Exact field allowlist prevents user input from supplying technical identity/version/evidence. */
export function validateKnowledgeCorrection(record, value) {
  need(plain(value) && Object.keys(value).length > 0 &&
    Object.keys(value).every(key => KNOWLEDGE_CORRECTION_FIELDS.includes(key)),
  'NATIVE_KNOWLEDGE_CORRECTION_FIELDS_INVALID');
  need(KNOWLEDGE_CORRECTION_KINDS.includes(record?.kind),
    'NATIVE_KNOWLEDGE_CORRECTION_KIND_UNSUPPORTED');
  const allowedStructure = new Set(structuredFields[record.kind] ?? []);
  need(Object.keys(value).every(key => !structural.has(key) || allowedStructure.has(key)),
    'NATIVE_KNOWLEDGE_CORRECTION_FIELD_KIND_INVALID');
  const result = clone(value);
  for (const key of ['text', 'statement', 'attribute', 'predicate', 'rule_text', 'modality']) {
    if (has(result, key)) need(nonempty(result[key]), 'NATIVE_KNOWLEDGE_CORRECTION_VALUE_INVALID');
  }
  for (const key of ['unit', 'time_text', 'version_text', 'rule_name']) {
    if (has(result, key)) need(result[key] === null || nonempty(result[key]),
      'NATIVE_KNOWLEDGE_CORRECTION_VALUE_INVALID');
  }
  if (has(result, 'raw_value')) need(result.raw_value === null || ['string', 'boolean'].includes(typeof result.raw_value) ||
    typeof result.raw_value === 'number' && Number.isFinite(result.raw_value), 'NATIVE_KNOWLEDGE_CORRECTION_VALUE_INVALID');
  if (typeof result.raw_value === 'string') need(result.raw_value.isWellFormed() && result.raw_value.length <= 128000,
    'NATIVE_KNOWLEDGE_CORRECTION_VALUE_INVALID');
  if (has(result, 'conditions')) need(Array.isArray(result.conditions) && result.conditions.length <= 128 &&
    result.conditions.every(nonempty), 'NATIVE_KNOWLEDGE_CORRECTION_VALUE_INVALID');
  if (has(result, 'negation')) need(typeof result.negation === 'boolean', 'NATIVE_KNOWLEDGE_CORRECTION_VALUE_INVALID');
  if (has(result, 'text') && has(result, 'statement')) need(result.text === result.statement,
    'NATIVE_KNOWLEDGE_CORRECTION_TEXT_INCONSISTENT');
  const explicitText = result.text ?? result.statement;
  if (record.kind === 'RULE' && explicitText !== undefined && has(result, 'rule_text')) need(explicitText === result.rule_text,
    'NATIVE_KNOWLEDGE_CORRECTION_TEXT_INCONSISTENT');
  if (explicitText !== undefined) {
    result.text = explicitText; result.statement = explicitText;
    if (record.kind === 'RULE') result.rule_text = explicitText;
  } else if (record.kind === 'RULE' && has(result, 'rule_text')) {
    result.text = result.rule_text; result.statement = result.rule_text;
  } else if (Object.keys(result).some(key => structural.has(key))) {
    const next = {...record, ...result}, name = id => array(record.domain?.entities)
      .find(entity => entity.id === id)?.name ?? id ?? '';
    const text = record.kind === 'ATTRIBUTE' ?
      `${name(next.subject_ref)}；${next.attribute} = ${JSON.stringify(next.raw_value)}${next.unit ? ' ' + next.unit : ''}` :
      record.kind === 'RELATION' ? `${name(next.subject_ref)} ${next.predicate} ${name(next.object_ref)}` : null;
    if (text) {result.text = text; result.statement = text;}
  }
  need(Object.keys(result).some(key => hash(result[key]) !== hash(record[key] ?? null)),
    'NATIVE_KNOWLEDGE_CORRECTION_NO_CHANGE');
  return result;
}

/** Metadata kept apart from the business record's evidence authority. */
export function knowledgeReviewRows(record) {
  const rows = [...array(record?.knowledge_review?.history), record?.knowledge_review,
    ...(record?.origin_layer === 'HUMAN_CORRECTION' ? [record] : [])].filter(value => textField(value?.review_event_ref));
  return [...new Map(rows.map(value => [value.review_event_ref, value])).values()];
}
export function knowledgeReviewEventRefs(record) {return knowledgeReviewRows(record).map(value => value.review_event_ref);}
export function knowledgeBusinessChangedFields(before, after) {
  return KNOWLEDGE_CORRECTION_FIELDS.filter(key => hash(before[key] ?? null) !== hash(after[key] ?? null));
}
function withoutEvidence(value) {
  if (Array.isArray(value)) return value.map(withoutEvidence);
  if (!plain(value)) return clone(value);
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !['source_refs', 'evidence', 'evidence_refs', 'quote', 'model_quote'].includes(key))
    .map(([key, item]) => [key, withoutEvidence(item)]));
}
/** Canonical entity mapping must not reattach original-source evidence to a corrected expression. */
export function clearHumanCorrectionEvidence(record) {
  if (record.origin_layer !== 'HUMAN_CORRECTION') return record;
  const result = {...clone(record), source_refs: [], evidence: [], evidence_refs: [], model_quote: null};
  if (result.domain) result.domain = withoutEvidence(result.domain);
  return result;
}

function reviewMetadata(event) {
  return {author: 'HUMAN', review_action: event.action, review_event_ref: event.event_ref,
    review_item_ref: event.item_ref, review_source_revision_ref: event.source_revision_ref,
    reason: event.reason, created_at: event.created_at};
}
function signLike(source, record) {
  if (!has(source, 'record_sha256')) return record;
  const {record_sha256: _old, ...body} = record; return {...body, record_sha256: hash(body)};
}

/** A revoke restores the content preceding the latest applied replacement; no old record is edited. */
export function applyKnowledgeReviewEvent(record, event, {historyEvents = []} = {}) {
  need(event.item_kind === 'KNOWLEDGE' && event.item_target_ref === ref(record) &&
    ['replace', 'defer', 'revoke'].includes(event.action), 'NATIVE_KNOWLEDGE_CORRECTION_BINDING_CHANGED');
  const human = reviewMetadata(event), priorHistory = knowledgeReviewRows(record), history = [...new Map([
    ...priorHistory, ...historyEvents.map(reviewMetadata), human].map(value => [value.review_event_ref, value])).values()];
  let result;
  if (event.action === 'replace') {
    const patch = validateKnowledgeCorrection(record, event.correction);
    const original = record.correction_origin?.original_knowledge ?? record;
    const originalSourceRefs = clone(original.source_refs ?? []), originalEvidence = clone(original.evidence ?? []),
      originalEvidenceRefs = clone(original.evidence_refs ?? []);
    result = {...clone(record), ...patch, ...human, source: 'HUMAN',
      answer_authority: 'HUMAN_CORRECTION', origin_layer: 'HUMAN_CORRECTION', text_origin: 'HUMAN_CORRECTION',
      source_refs: [], evidence: [], evidence_refs: [], model_quote: null,
      original_source_refs: originalSourceRefs, original_evidence: originalEvidence,
      original_evidence_refs: originalEvidenceRefs,
      correction_origin: {policy: KNOWLEDGE_CORRECTION_POLICY, action: 'replace',
        library_id: event.library_id, source_snapshot_ref: event.source_snapshot_ref,
        source_run_id: event.source_run_id, source_revision_ref: event.source_revision_ref,
        source_revision_sha256: event.source_revision_sha256,
        review_event_ref: event.event_ref, review_item_ref: event.item_ref, reason: event.reason,
        original_knowledge: clone(original), original_source_refs: originalSourceRefs,
        original_evidence: originalEvidence, original_evidence_refs: originalEvidenceRefs,
        before_knowledge: clone(record), before_sha256: hash(record)}};
    if (result.domain?.relation && record.kind === 'RELATION' && has(patch, 'predicate')) {
      result.domain.relation.predicate = result.predicate;
    }
    delete result.original_relation;
    delete result.ontology_alignment;
    delete result.relation_ontology_alignment;
    result = clearHumanCorrectionEvidence(result);
    // A format cache must never retain the old value after a real value/unit edit.
    if (has(patch, 'raw_value') || has(patch, 'unit')) {
      delete result.value_normalization;
      const normalized = normalizeExplicitQuantity(result.raw_value, result.unit);
      if (normalized) result.value_normalization = normalized;
    }
  } else if (event.action === 'revoke') {
    result = clone(record.correction_origin?.before_knowledge ?? record);
  } else result = clone(record);
  result.knowledge_review = {...human, status: event.action === 'replace' ? 'CORRECTED' :
    event.action === 'defer' ? 'DEFERRED' : 'REVOKED', history};
  return signLike(record, result);
}

/** Install receipt references only on decisions in this application, preserving earlier receipts. */
export function installKnowledgeReviewReceipt(record, {eventRefs, applicationRef, appliedRef}) {
  const refs = new Set(eventRefs), decorate = value => value && refs.has(value.review_event_ref) ?
    {...clone(value), application_ref: applicationRef, applied_receipt_ref: appliedRef} : clone(value);
  let result = clone(record);
  if (textField(result.review_event_ref)) result = decorate(result);
  if (result.correction_origin) result.correction_origin = decorate(result.correction_origin);
  if (result.knowledge_review) result.knowledge_review = {...decorate(result.knowledge_review),
    history: array(result.knowledge_review.history).map(decorate)};
  return signLike(record, result);
}
