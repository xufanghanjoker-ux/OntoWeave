/** Opaque symbol projection in front of frozen extraction-adapter-v2.
 * Changes only host-owned local symbols. Source surfaces, anchors, evidence and
 * domain semantics are passed through unchanged. No model/network calls.
 */
import { prepareExtractionCall as prepareV2,
  materializeExtractionResult as materializeV2, ADAPTER_VERSION, MAX_ENTITIES,
} from './extraction-adapter-v2.mjs';
import { objectSha } from '../runtime/evaluation-host.mjs';

export { ADAPTER_VERSION };
export const SYMBOL_PROJECTION_VERSION = 'lightog-p2-opaque-symbols/0.1';
const MAX_KEY_CHARACTERS = 160;
const MAX_RAW_BYTES = 8 * 1024 * 1024;
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const opaqueKey = value => typeof value === 'string' && value.length > 0
  && value.isWellFormed() && [...value].length <= MAX_KEY_CHARACTERS;
const generated = (prefix, index) => `${prefix}_${String(index + 1).padStart(3, '0')}`;
function need(condition, code) {
  if (!condition) throw Object.assign(Error(code), { code });
}
const keySchema = () => ({ type: 'string', minLength: 1, maxLength: MAX_KEY_CHARACTERS,
  description: 'Opaque well-formed key, exact and case-sensitive; may contain Chinese, spaces, or angle brackets. At most 160 Unicode characters. Never normalize it.' });

export function prepareExtractionCall(prepared, options = {}) {
  const call = prepareV2(prepared, options), schema = clone(call.output_schema);
  const { RegistryEntity, ModelFact, ModelCondition } = schema.$defs;
  need(RegistryEntity?.properties?.local_id && ModelFact?.properties?.subject_local_id
    && ModelFact.properties.local_id && ModelCondition?.properties?.id,
  'SYMBOL_PREPARED_SCHEMA_INVALID');
  RegistryEntity.properties.local_id = keySchema();
  ModelFact.properties.subject_local_id = keySchema();
  const modelObject = ModelFact.properties.object.anyOf.find(value => value?.properties?.entity_local_id);
  need(modelObject, 'SYMBOL_PREPARED_SCHEMA_INVALID');
  modelObject.properties.entity_local_id = { anyOf: [keySchema(), { type: 'null' }] };
  delete ModelFact.properties.local_id;
  ModelFact.required = ModelFact.required.filter(key => key !== 'local_id');
  delete ModelCondition.properties.id;
  ModelCondition.required = ModelCondition.required.filter(key => key !== 'id');
  const user = JSON.parse(call.messages[1].content);
  user.output_schema = schema;
  return { ...call, output_schema: schema, schema,
    symbol_projection_version: SYMBOL_PROJECTION_VERSION,
    messages: [{ ...call.messages[0], content: call.messages[0].content
      + '\nOpaque symbol protocol: registry local_id is an exact opaque key, not a program identifier; keys such as RefCell<T> or 中文名称 are allowed. Use the exact same key for subject_local_id and object.entity_local_id references. Never normalize or substitute keys, and never infer entity identity from a key/name. Do not output local_id on facts or id on conditions: the host generates them from their original array positions. All source evidence and semantic fields follow the unchanged extraction rules.' },
    { ...call.messages[1], content: JSON.stringify(user) }] };
}

export function materializeExtractionResult(prepared, raw, options = {}) {
  const call = prepareExtractionCall(prepared, options);
  if (typeof raw === 'string') need(Buffer.byteLength(raw, 'utf8') <= MAX_RAW_BYTES, 'SYMBOL_RAW_RESOURCE_LIMIT');
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : clone(raw);
  need(Buffer.byteLength(JSON.stringify(parsed) || '', 'utf8') <= MAX_RAW_BYTES, 'SYMBOL_RAW_RESOURCE_LIMIT');
  need(object(parsed) && Object.keys(parsed).length === 2
    && Object.hasOwn(parsed, 'entities') && Object.hasOwn(parsed, 'candidates'), 'SYMBOL_ENVELOPE_INVALID');
  need(Array.isArray(parsed.entities) && parsed.entities.length <= MAX_ENTITIES
    && Array.isArray(parsed.candidates) && parsed.candidates.length <= call.max_candidates,
  'SYMBOL_COLLECTION_LIMIT');
  const keys = new Map(), missing = new Map(), registry = [], facts = [];
  // Every well-formed key gets exactly one host symbol, including keys on rows
  // with other shape errors. Duplicates MUST reach v2 as the same local_id.
  for (let index = 0; index < parsed.entities.length; index++) {
    const entity = parsed.entities[index], rawKey = entity?.local_id;
    if (!opaqueKey(rawKey)) continue;
    if (!keys.has(rawKey)) keys.set(rawKey, { opaque_key: rawKey,
      internal_id: generated('e', keys.size), registry_indices: [] });
    keys.get(rawKey).registry_indices.push(index);
  }
  const entities = parsed.entities.map((entity, index) => {
    const present = object(entity) && Object.hasOwn(entity, 'local_id');
    const rawKey = present ? entity.local_id : null;
    const mapping = opaqueKey(rawKey) ? keys.get(rawKey) : null;
    registry.push({ registry_index: index, original_key_present: present, original_key: clone(rawKey),
      original_entry_sha256: objectSha(entity), key_status: mapping ? 'MAPPED_EXACT_KEY' : 'INVALID_KEY',
      internal_id: mapping?.internal_id || null, duplicate_key: (mapping?.registry_indices.length || 0) > 1 });
    if (!object(entity) || !mapping) return clone(entity);
    return { ...clone(entity), local_id: mapping.internal_id };
  });
  function reference(rawKey, slot, receipt) {
    if (!opaqueKey(rawKey)) {
      receipt.references.push({ slot, original_key: clone(rawKey), internal_id: null, status: 'INVALID_KEY' });
      return clone(rawKey); // v2 rejects invalid identifier type/shape; do not coerce.
    }
    const known = keys.get(rawKey);
    if (known) {
      receipt.references.push({ slot, original_key: rawKey, internal_id: known.internal_id, status: 'REGISTRY_KEY' });
      return known.internal_id;
    }
    // A disjoint namespace is essential: raw "e_001" is never interpreted as
    // host e_001 unless it was explicitly a registry key and mapped above.
    if (!missing.has(rawKey)) missing.set(rawKey, { opaque_key: rawKey,
      internal_id: generated('missing', missing.size) });
    const unknown = missing.get(rawKey);
    receipt.references.push({ slot, original_key: rawKey, internal_id: unknown.internal_id, status: 'UNKNOWN_KEY' });
    return unknown.internal_id;
  }
  const candidates = parsed.candidates.map((fact, index) => {
    const receipt = { fact_index: index, generated_fact_local_id: generated('f', index),
      original_fact_sha256: objectSha(fact), original_fact_local_id_present: object(fact) && Object.hasOwn(fact, 'local_id'),
      references: [], conditions: [], projection_errors: [] };
    facts.push(receipt);
    if (!object(fact)) return clone(fact);
    const projected = { ...clone(fact), local_id: receipt.generated_fact_local_id };
    if (Object.hasOwn(fact, 'local_id')) {
      receipt.original_fact_local_id = clone(fact.local_id);
      receipt.projection_errors.push('MODEL_FACT_ID_FORBIDDEN');
    }
    if (Object.hasOwn(fact, 'subject_local_id'))
      projected.subject_local_id = reference(fact.subject_local_id, 'subject_local_id', receipt);
    if (object(fact.object) && Object.hasOwn(fact.object, 'entity_local_id') && fact.object.entity_local_id !== null)
      projected.object.entity_local_id = reference(fact.object.entity_local_id, 'object.entity_local_id', receipt);
    if (Array.isArray(fact.conditions)) projected.conditions = fact.conditions.map((condition, conditionIndex) => {
      const entry = { condition_index: conditionIndex, generated_condition_id: generated('cond', conditionIndex),
        original_condition_sha256: objectSha(condition), original_id_present: object(condition) && Object.hasOwn(condition, 'id') };
      receipt.conditions.push(entry);
      if (!object(condition)) return clone(condition);
      if (Object.hasOwn(condition, 'id')) {
        entry.original_id = clone(condition.id);
        receipt.projection_errors.push('MODEL_CONDITION_ID_FORBIDDEN');
      }
      return { ...clone(condition), id: entry.generated_condition_id };
    });
    // Unexpected model-owned fact/condition IDs cannot be silently overwritten
    // into accepted output. Retain the fact in-place as a v2 shape rejection.
    if (receipt.projection_errors.length) projected.symbol_projection_errors = clone(receipt.projection_errors);
    return projected;
  });
  const projected = { entities, candidates };
  const projection = { version: SYMBOL_PROJECTION_VERSION, raw_input_sha256: objectSha(parsed),
    original_registry_sha256: objectSha(parsed.entities), projected_input_sha256: objectSha(projected),
    key_map: [...keys.values()], missing_key_map: [...missing.values()], registry, facts };
  const result = materializeV2(prepared, projected, options);
  return { ...result, symbol_projection_version: SYMBOL_PROJECTION_VERSION, symbol_projection: projection,
    entity_resolution: result.entity_resolution.map((entry, index) => ({ ...entry,
      symbol_projection_version: SYMBOL_PROJECTION_VERSION, original_registry_index: index,
      original_key: clone(registry[index].original_key) })),
    receipts: result.receipts.map((receipt, index) => ({ ...receipt,
      symbol_projection_version: SYMBOL_PROJECTION_VERSION,
      symbol_raw_input_sha256: projection.raw_input_sha256,
      symbol_original_fact_index: index, symbol_original_fact_sha256: facts[index].original_fact_sha256,
      symbol_generated_fact_local_id: facts[index].generated_fact_local_id,
      ...(facts[index].projection_errors.length ? { symbol_projection_errors: facts[index].projection_errors } : {}) })) };
}
