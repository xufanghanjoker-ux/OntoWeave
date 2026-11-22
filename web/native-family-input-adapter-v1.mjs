/** Deterministic CQ aggregation only. The Skill/model owns semantic grouping. */
import {clone, hash, need, textField} from './cq-discovery-store-v2.mjs';
import {cqFamilyDefinitions, validateCQFamilies} from './cq-family-output-v1.mjs';

const VERSION = 'native-family-input/1';
export const NATIVE_FAMILY_TOLERANT_POLICY = 'EXTRACT_AND_INDEX_V1';
const MAX_ITEMS = cqFamilyDefinitions()[0].inputSchema.properties.families.items.properties.member_refs.maxItems;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);

/** Agent proposal schema only; the Host binds the aggregate input and system refs. */
export function nativeFamilyDefinitions({knowledgeBuildPolicy} = {}) {
  const tools = cqFamilyDefinitions();
  if (knowledgeBuildPolicy !== NATIVE_FAMILY_TOLERANT_POLICY) return tools;
  const schema = tools[0].inputSchema;
  delete schema.properties.input_ref;
  schema.required = ['families'];
  schema.additionalProperties = true;
  schema.properties.families.items.additionalProperties = true;
  schema.properties.families.items.properties.notes = {type:'string'};
  schema.properties.unassigned.items.additionalProperties = true;
  schema.properties.unassigned.items.required = ['cq_ref'];
  schema.properties.unassigned.items.properties.reason = {type:'string'};
  tools[0].description = '提交本轮CQ的问题族及成员引用，可选未归族项。仅填写归族内容，Host绑定input_ref并生成family_ref。按条处理坏族和无法对应的引用，相关原CQ保留为未归族继续规划；查看processing_summary/warnings，不为告警另开评审或修订循环。保留原题，不输出答案。';
  return tools;
}

function copyItemPayload(item) {
  need(record(item) && textField(item.cq_ref) && textField(item.question), 'NATIVE_FAMILY_CQ_INVALID');
  need(Object.keys(item).every(key => ['cq_ref','question','source_hint','notes','source_refs','read_receipt_refs',
    'source_status','source_unknown_reason','ranges','fallback_ranges','range_status','range_warnings','local_questions'].includes(key)),
    'NATIVE_FAMILY_CQ_INVALID');
  for (const key of ['source_hint','notes']) {
    if (own(item, key)) need(textField(item[key]), 'NATIVE_FAMILY_CQ_INVALID');
  }
  // An explicit empty array retains unknown provenance; no catalog is inferred here.
  need(Array.isArray(item.source_refs) && item.source_refs.every(source =>
    record(source) && textField(source.doc_ref) && textField(source.revision) &&
    Object.keys(source).every(key => ['doc_ref','revision'].includes(key))), 'NATIVE_FAMILY_SOURCE_REFS_INVALID');
  need(Array.isArray(item.read_receipt_refs) && item.read_receipt_refs.every(textField),
    'NATIVE_FAMILY_READ_REFS_INVALID');
  if (own(item, 'source_status')) {
    need(['KNOWN','UNKNOWN'].includes(item.source_status), 'NATIVE_FAMILY_SOURCE_STATUS_INVALID');
    need(item.source_status === 'UNKNOWN'
      ? item.source_refs.length === 0 && textField(item.source_unknown_reason)
      : item.source_refs.length > 0 && !own(item, 'source_unknown_reason'), 'NATIVE_FAMILY_SOURCE_STATUS_INVALID');
  } else {
    need(!own(item, 'source_unknown_reason'), 'NATIVE_FAMILY_SOURCE_STATUS_INVALID');
  }
  return {
    ...Object.fromEntries(['ranges','fallback_ranges','range_status','range_warnings','local_questions'].filter(k=>own(item,k)).map(k=>[k,clone(item[k])])),
    question:item.question,
    ...(own(item, 'source_hint') ? {source_hint:item.source_hint} : {}),
    ...(own(item, 'notes') ? {notes:item.notes} : {}),
    ...(own(item, 'source_status') ? {source_status:item.source_status} : {}),
    ...(own(item, 'source_unknown_reason') ? {source_unknown_reason:item.source_unknown_reason} : {}),
    source_refs:clone(item.source_refs),
    read_receipt_refs:clone(item.read_receipt_refs)
  };
}

/** Inputs are actual saved CQ lists selected by the Host for this run/snapshot.
 * This pure adapter cannot authenticate catalog freshness or reading receipts. */
export function createNativeFamilyInput({runId, sourceSnapshotRef, inputs} = {}) {
  need(textField(runId) && textField(sourceSnapshotRef), 'NATIVE_FAMILY_CONTEXT_INVALID');
  need(Array.isArray(inputs), 'NATIVE_FAMILY_INPUTS_INVALID');
  const inputRefs = new Set();
  let count = 0;
  const normalized = inputs.map(input => {
    need(record(input) && textField(input.input_ref) && Array.isArray(input.items), 'NATIVE_FAMILY_INPUT_INVALID');
    need(!inputRefs.has(input.input_ref), 'NATIVE_FAMILY_INPUT_REF_DUPLICATE');
    inputRefs.add(input.input_ref);
    count += input.items.length;
    need(count <= MAX_ITEMS, 'NATIVE_FAMILY_LIMIT_EXCEEDED');
    const cqRefs = new Set();
    return {
      input_ref:input.input_ref,
      items:input.items.map(item => {
        const payload = copyItemPayload(item);
        need(!cqRefs.has(item.cq_ref), 'NATIVE_FAMILY_ORIGIN_CQ_DUPLICATE');
        cqRefs.add(item.cq_ref);
        return {cq_ref:item.cq_ref, ...payload};
      })
    };
  });
  const input_ref = 'native_family_input_' + hash({version:VERSION, runId, sourceSnapshotRef, inputs:normalized});
  const items = [], mapping = {};
  for (const input of normalized) {
    for (const item of input.items) {
      const cq_ref = 'native_cq_' + hash({version:VERSION, runId, sourceSnapshotRef,
        origin_input_ref:input.input_ref, origin_cq_ref:item.cq_ref});
      need(!own(mapping, cq_ref), 'NATIVE_FAMILY_MEMBER_REF_COLLISION');
      const payload = copyItemPayload(item);
      items.push({cq_ref, ...clone(payload)});
      mapping[cq_ref] = {origin_input_ref:input.input_ref, origin_cq_ref:item.cq_ref, ...clone(payload)};
    }
  }
  return {input_ref, items, mapping};
}

/** Business view only. Canonical mapping, digests and read receipts stay Host-side.
 * Source versions remain distinguishable through the reference layer; text is exact. */
export function nativeFamilyModelItems(input, refs = input?.items?.map(item => item.cq_ref)) {
  validateInputMapping(input);
  need(Array.isArray(refs)&&new Set(refs).size===refs.length,'NATIVE_FAMILY_MODEL_REFS_INVALID');
  const items=new Map(input.items.map(item=>[item.cq_ref,item]));
  return refs.map(ref=>{
    const item=items.get(ref);need(item,'NATIVE_FAMILY_MODEL_REF_UNKNOWN');
    return {cq_ref:item.cq_ref,question:item.question,
      ...(item.notes!==undefined?{notes:item.notes}:{}),...(item.source_hint!==undefined?{source_hint:item.source_hint}:{}),
      source_refs:clone(item.source_refs),...(item.source_status?{source_status:item.source_status}:{}),
      ...(item.source_unknown_reason?{source_unknown_reason:item.source_unknown_reason}:{})};
  });
}

/** Omit only blank optional family notes. The caller retains the raw submission. */
export function normalizeNativeFamilyOutput({args, knowledgeBuildPolicy} = {}) {
  // The policy is accepted across the three-step Host API; binding needs input.
  const normalized = clone(args), normalizations = [];
  if (record(normalized) && Array.isArray(normalized.families)) {
    for (const [index, family] of normalized.families.entries()) {
      if (record(family) && own(family, 'notes') && typeof family.notes === 'string' && family.notes.trim() === '') {
        normalizations.push({code:'OPTIONAL_BLANK_NOTES_OMITTED', path:'/families/' + index + '/notes',
          original_value:family.notes});
        delete family.notes;
      }
    }
  }
  return {normalized, normalizations};
}

/** Reuse existing family structure checks; a valid result is not semantic approval. */
export function validateNativeFamilyOutput({input, args, knowledgeBuildPolicy} = {}) {
  need(record(input) && textField(input.input_ref) && Array.isArray(input.items) && record(input.mapping),
    'NATIVE_FAMILY_INPUT_INVALID');
  const {normalized} = normalizeNativeFamilyOutput({args, knowledgeBuildPolicy});
  if (knowledgeBuildPolicy === NATIVE_FAMILY_TOLERANT_POLICY) return validateTolerantFamilyOutput(input, normalized);
  const result = validateCQFamilies({inputRef:input.input_ref, cqRefs:input.items.map(item => item?.cq_ref), args:normalized});
  validateInputMapping(input);
  return result;
}

function validateInputMapping(input) {
  need(Object.keys(input.mapping).length === input.items.length, 'NATIVE_FAMILY_MAPPING_INVALID');
  const origins = new Set();
  for (const item of input.items) {
    const payload = copyItemPayload(item);
    need(own(input.mapping, item.cq_ref), 'NATIVE_FAMILY_MAPPING_INVALID');
    const mapped = input.mapping[item.cq_ref];
    need(record(mapped) && textField(mapped.origin_input_ref) && textField(mapped.origin_cq_ref),
      'NATIVE_FAMILY_MAPPING_INVALID');
    const {origin_input_ref, origin_cq_ref, ...mappedPayload} = mapped;
    const origin = hash([origin_input_ref, origin_cq_ref]);
    need(!origins.has(origin) && hash(mappedPayload) === hash(payload), 'NATIVE_FAMILY_MAPPING_INVALID');
    origins.add(origin);
  }
}

/** Local proposal defects never alter original CQs or infer a replacement family. */
function validateTolerantFamilyOutput(input, args) {
  const refs = input.items.map(item => item?.cq_ref), known = new Set(refs);
  const fallbackReason = '本轮问题族未可靠关联此CQ；保留原题继续范围规划。';
  // Input corruption is an invalid Host context, not a model proposal defect.
  validateCQFamilies({inputRef:input.input_ref, cqRefs:refs,
    args:{input_ref:input.input_ref, families:[], unassigned:refs.map(cq_ref => ({cq_ref, reason:fallbackReason}))}});
  validateInputMapping(input);
  const warnings = [];
  const warn = (code, path, cq_ref) => warnings.push({code, path, ...(cq_ref === undefined ? {} : {cq_ref})});
  const extras = (value, allowed, path) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) {
      warn('FAMILY_EXTRA_FIELD_IGNORED', path + '/' + key.replaceAll('~','~0').replaceAll('/','~1'));
    }
  };
  const proposal = record(args) ? args : {};
  if (!record(args)) warn('FAMILY_PROPOSAL_INVALID', '');
  extras(proposal, ['families','unassigned'], '');
  if (!Array.isArray(proposal.families)) warn('FAMILY_LIST_INVALID', '/families');
  if (own(proposal,'unassigned') && !Array.isArray(proposal.unassigned)) warn('FAMILY_UNASSIGNED_LIST_INVALID', '/unassigned');
  const proposedFamilies = Array.isArray(proposal.families) ? proposal.families : [];
  const candidates = [], identities = new Set();
  const validText = (value, max) => textField(value) && value.length <= max;
  for (const [index, original] of proposedFamilies.entries()) {
    const path = '/families/' + index;
    if (!record(original)) { warn('FAMILY_INVALID', path); continue; }
    extras(original, ['name','representative_question','member_refs','notes'], path);
    if (!validText(original.name,200) || !validText(original.representative_question,1200) ||
      !Array.isArray(original.member_refs) || !original.member_refs.length || original.member_refs.length > MAX_ITEMS ||
      own(original,'notes') && !validText(original.notes,600)) {
      warn('FAMILY_INVALID', path); continue;
    }
    const member_refs = [], local = new Set();
    let invalid = false;
    for (const [memberIndex, ref] of original.member_refs.entries()) {
      const memberPath = path + '/member_refs/' + memberIndex;
      if (!validText(ref,300) || !known.has(ref)) {
        warn('FAMILY_MEMBER_UNKNOWN', memberPath, typeof ref === 'string' ? ref : undefined);
        invalid = true; continue;
      }
      if (local.has(ref)) { warn('FAMILY_MEMBER_DUPLICATE_IGNORED', memberPath, ref); continue; }
      local.add(ref); member_refs.push(ref);
    }
    if (invalid) { warn('FAMILY_SKIPPED_INVALID_BINDING', path); continue; }
    const family = {name:original.name, representative_question:original.representative_question, member_refs,
      ...(own(original,'notes') ? {notes:original.notes} : {})};
    const identity = hash({...family,member_refs:[...member_refs].sort()});
    if (identities.has(identity)) { warn('FAMILY_DUPLICATE_IGNORED', path); continue; }
    if (candidates.length >= MAX_ITEMS) { warn('FAMILY_CAPACITY_SKIPPED', path); continue; }
    identities.add(identity); candidates.push({index,family});
  }
  const explicit = new Map();
  for (const [index, original] of (Array.isArray(proposal.unassigned) ? proposal.unassigned : []).entries()) {
    const path = '/unassigned/' + index;
    if (!record(original) || !validText(original.cq_ref,300) || !known.has(original.cq_ref)) {
      warn('FAMILY_UNASSIGNED_INVALID', path); continue;
    }
    extras(original, ['cq_ref','reason'], path);
    if (explicit.has(original.cq_ref)) { warn('FAMILY_UNASSIGNED_DUPLICATE_IGNORED', path, original.cq_ref); continue; }
    const reason = validText(original.reason,600) ? original.reason : fallbackReason;
    if (reason === fallbackReason && original.reason !== fallbackReason) warn('FAMILY_UNASSIGNED_REASON_MISSING', path + '/reason', original.cq_ref);
    explicit.set(original.cq_ref,reason);
  }
  const memberships = new Map(), skipped = new Set();
  for (const candidate of candidates) for (const ref of candidate.family.member_refs) {
    if (!memberships.has(ref)) memberships.set(ref,[]);
    memberships.get(ref).push(candidate);
  }
  for (const [ref, members] of memberships) {
    const overlap = explicit.has(ref);
    if (overlap || members.length > 1 && members.some(({family}) => !textField(family.notes))) {
      for (const {index} of members) skipped.add(index);
      warn(overlap ? 'FAMILY_ASSIGNMENT_CONFLICT' : 'FAMILY_MULTIPLE_MEMBERSHIP_UNEXPLAINED', '/families', ref);
    }
  }
  const families = candidates.filter(({index}) => !skipped.has(index)).map(({family}) => family);
  const assigned = new Set(families.flatMap(family => family.member_refs));
  let fallback_cqs = 0;
  const unassigned = refs.filter(ref => !assigned.has(ref)).map(cq_ref => {
    if (!explicit.has(cq_ref)) {
      fallback_cqs++;
      warn('FAMILY_CQ_UNASSIGNED', '/unassigned', cq_ref);
    }
    return {cq_ref,reason:explicit.get(cq_ref) ?? fallbackReason};
  });
  if (refs.length && !families.length) warn('FAMILY_NO_USABLE_FAMILIES', '/families');
  const result = validateCQFamilies({inputRef:input.input_ref,cqRefs:refs,args:{input_ref:input.input_ref,families,unassigned}});
  return {...result, processing_summary:{received:proposedFamilies.length,accepted:families.length,
    skipped:proposedFamilies.length-families.length,input_cqs:refs.length,assigned_cqs:assigned.size,
    unassigned_cqs:unassigned.length,fallback_cqs,warning_count:warnings.length,
    all_skipped:proposedFamilies.length > 0 && !families.length}, warnings};
}

/** Host-only projection after model-output validation. Does not change the raw result.
 * List/member ordering does not define identity; original order is still returned. */
export function materializeNativeFamilyRefs({input, families, knowledgeBuildPolicy} = {}) {
  // v5 callers pass the canonical validator result, whose metadata is Host-owned.
  // Recheck its business projection without interpreting metadata as model fields.
  const tolerant = knowledgeBuildPolicy === NATIVE_FAMILY_TOLERANT_POLICY;
  const validated = validateNativeFamilyOutput({input, args:tolerant && record(families)
    ? {input_ref:families.input_ref,families:families.families,unassigned:families.unassigned} : families});
  if (tolerant) for (const key of ['processing_summary','warnings']) {
    if (own(families,key)) validated[key] = clone(families[key]);
  }
  const refs = new Set();
  return {...validated, families:validated.families.map(family => {
    const family_ref = 'native_family_' + hash({version:'native-family-ref/1', input_ref:validated.input_ref,
      family:{...family, member_refs:[...family.member_refs].sort()}});
    need(!refs.has(family_ref), 'NATIVE_FAMILY_REF_DUPLICATE');
    refs.add(family_ref);
    return {...family, family_ref};
  })};
}
