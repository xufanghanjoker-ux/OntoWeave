/** Host-only source binding. Quote location never decides whether a statement is true. */
import {clone, hash, need, textField} from './cq-discovery-store-v2.mjs';

export const ACTION_EVIDENCE_BINDING_POLICY = 'NATIVE_ACTION_EVIDENCE_BINDING_V1';
// One UTF-16 code unit to one code unit; no number, letter, sign or whitespace folding.
const punctuation = new Map([
  ...[...'“”„‟「」『』'].map(ch => [ch, '"']),
  ...[...'‘’‚‛'].map(ch => [ch, "'"]),
  ...[...'，：；！？（）［］｛｝．'].map((ch, i) => [ch, ',:;!?()[]{}.'[i]]),
]);
const normalize = text => [...text].map(ch => punctuation.get(ch) ?? ch).join('');
function matches(text, quote) {
  if (!textField(quote)) return {count:0, first:-1};
  let count = 0, first = -1, after = 0, offset;
  while ((offset = text.indexOf(quote, after)) !== -1) {
    if (!count) first = offset;
    count++; after = offset + 1;
  }
  return {count, first};
}
function checkSource(source, evidence) {
  need(source && source.source_record_ref === evidence?.source_record_ref
    && source.revision === evidence.revision && typeof source.text === 'string',
  'NATIVE_ACTION_EVIDENCE_SOURCE_CHANGED');
  if (evidence.source_text_sha256 !== undefined)
    need(evidence.source_text_sha256 === hash(source.text), 'NATIVE_ACTION_EVIDENCE_SOURCE_CHANGED');
}

export function bindNativeActionEvidence(source, evidence) {
  checkSource(source, evidence);
  if (evidence.evidence_binding) {
    verifyNativeActionEvidence(source, evidence);
    return clone(evidence);
  }
  const modelQuote = evidence.quote ?? null;
  const exact = matches(source.text, modelQuote);
  const located = exact.count ? exact : matches(normalize(source.text),
    typeof modelQuote === 'string' ? normalize(modelQuote) : null);
  const unique = located.count === 1;
  const status = unique ? (exact.count ? 'EXACT' : 'PUNCTUATION_ALIGNED')
    : located.count ? 'AMBIGUOUS' : 'UNLOCATED';
  const quote = unique ? source.text.slice(located.first, located.first + modelQuote.length) : null;
  return {...clone(evidence), quote, model_quote:clone(modelQuote), evidence_binding:{
    policy:ACTION_EVIDENCE_BINDING_POLICY, source_text_sha256:hash(source.text),
    status, proof_scope:unique ? 'LOCATED_SOURCE_SPAN' : 'SOURCE_RECORD_ONLY',
    span_utf16:unique ? {start:located.first, end:located.first + quote.length} : null,
    candidate_count:located.count,
  }};
}

export function verifyNativeActionEvidence(source, evidence) {
  checkSource(source, evidence);
  const binding = evidence.evidence_binding;
  if (!binding) {
    // Existing immutable drafts keep their original strict validation path.
    need(textField(evidence.quote) && source.text.includes(evidence.quote), 'NATIVE_ACTION_EVIDENCE_CHANGED');
    return clone(evidence);
  }
  need(binding.policy === ACTION_EVIDENCE_BINDING_POLICY
    && binding.source_text_sha256 === hash(source.text), 'NATIVE_ACTION_EVIDENCE_SOURCE_CHANGED');
  const {evidence_binding, model_quote, ...original} = evidence;
  const expected = bindNativeActionEvidence(source, {...original, quote:model_quote});
  need(hash(binding) === hash(expected.evidence_binding) && evidence.quote === expected.quote,
    'NATIVE_ACTION_EVIDENCE_LOCATOR_CHANGED');
  return clone(evidence);
}
