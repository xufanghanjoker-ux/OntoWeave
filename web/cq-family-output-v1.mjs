/** Structural acceptance of family results; semantic grouping belongs to the Skill/model. */
import {need, textField} from './cq-discovery-store-v2.mjs';

export const CQ_FAMILY_TOOL = 'lightog_save_cq_families';
const MAX_ITEMS = 1000;
const MAX_REF = 300;
const object = (properties, required) => ({type:'object', properties, required, additionalProperties:false});
const string = maxLength => ({type:'string', minLength:1, maxLength, pattern:'\\S'});

export function cqFamilyDefinitions() {
  return [{
    name:CQ_FAMILY_TOOL,
    description:'保存本次CQ列表的问题族与成员引用。input_ref使用CQ保存回执；每条CQ应归族或列为未归族，多族归属需在相关族notes说明。保留原CQ，不输出答案或改写原题。',
    inputSchema:object({
      input_ref:string(MAX_REF),
      families:{type:'array', maxItems:MAX_ITEMS, items:object({
        name:string(200),
        representative_question:string(1200),
        member_refs:{type:'array', minItems:1, maxItems:MAX_ITEMS, uniqueItems:true, items:string(MAX_REF)},
        notes:string(600)
      }, ['name','representative_question','member_refs'])},
      unassigned:{type:'array', maxItems:MAX_ITEMS, items:object({
        cq_ref:string(MAX_REF), reason:string(600)
      }, ['cq_ref','reason'])}
    }, ['input_ref','families','unassigned']),
    annotations:{readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:false}
  }];
}

function fields(value, allowed, required, code) {
  need(value && typeof value==='object' && !Array.isArray(value) &&
    Object.keys(value).every(k=>allowed.includes(k)) && required.every(k=>Object.hasOwn(value,k)), code);
}
function text(value, max, code) { need(textField(value) && value.length<=max, code); }

/** Valid refs/coverage do not certify that a model grouped the right knowledge targets. */
export function validateCQFamilies({inputRef, cqRefs, args}) {
  text(inputRef, MAX_REF, 'CQ_FAMILY_INPUT_INVALID');
  need(Array.isArray(cqRefs) && cqRefs.length<=MAX_ITEMS &&
    cqRefs.every(r=>textField(r) && r.length<=MAX_REF) && new Set(cqRefs).size===cqRefs.length,
    'CQ_FAMILY_INPUT_INVALID');
  fields(args, ['input_ref','families','unassigned'], ['input_ref','families','unassigned'], 'CQ_FAMILY_ARGUMENTS_INVALID');
  text(args.input_ref, MAX_REF, 'CQ_FAMILY_ARGUMENTS_INVALID');
  need(args.input_ref===inputRef, 'CQ_FAMILY_INPUT_REF_MISMATCH');
  need(Array.isArray(args.families) && args.families.length<=MAX_ITEMS &&
    Array.isArray(args.unassigned) && args.unassigned.length<=MAX_ITEMS, 'CQ_FAMILY_ARGUMENTS_INVALID');
  if(!cqRefs.length)need(!args.families.length && !args.unassigned.length, 'CQ_FAMILY_EMPTY_INPUT_RESULT_INVALID');

  const known = new Set(cqRefs), memberships = new Map(), unassigned = new Set();
  for(const [index,family] of args.families.entries()) {
    fields(family, ['name','representative_question','member_refs','notes'],
      ['name','representative_question','member_refs'], 'CQ_FAMILY_FAMILY_INVALID');
    text(family.name, 200, 'CQ_FAMILY_FAMILY_INVALID');
    text(family.representative_question, 1200, 'CQ_FAMILY_FAMILY_INVALID');
    if(Object.hasOwn(family,'notes'))text(family.notes, 600, 'CQ_FAMILY_FAMILY_INVALID');
    need(Array.isArray(family.member_refs) && family.member_refs.length>0 &&
      family.member_refs.length<=MAX_ITEMS, 'CQ_FAMILY_FAMILY_INVALID');
    const local = new Set();
    for(const ref of family.member_refs) {
      text(ref, MAX_REF, 'CQ_FAMILY_FAMILY_INVALID');
      need(known.has(ref), 'CQ_FAMILY_REF_UNKNOWN');
      need(!local.has(ref), 'CQ_FAMILY_REF_DUPLICATE');
      local.add(ref);
      if(!memberships.has(ref))memberships.set(ref,[]);
      memberships.get(ref).push(index);
    }
  }
  for(const item of args.unassigned) {
    fields(item, ['cq_ref','reason'], ['cq_ref','reason'], 'CQ_FAMILY_UNASSIGNED_INVALID');
    text(item.cq_ref, MAX_REF, 'CQ_FAMILY_UNASSIGNED_INVALID');
    text(item.reason, 600, 'CQ_FAMILY_UNASSIGNED_INVALID');
    need(known.has(item.cq_ref), 'CQ_FAMILY_REF_UNKNOWN');
    need(!unassigned.has(item.cq_ref), 'CQ_FAMILY_UNASSIGNED_DUPLICATE');
    need(!memberships.has(item.cq_ref), 'CQ_FAMILY_REF_CROSS_ASSIGNED');
    unassigned.add(item.cq_ref);
  }
  need(cqRefs.every(ref=>memberships.has(ref) || unassigned.has(ref)), 'CQ_FAMILY_COVERAGE_INCOMPLETE');
  for(const indexes of memberships.values()) {
    if(indexes.length>1)need(indexes.every(i=>textField(args.families[i].notes)), 'CQ_FAMILY_MULTIPLE_MEMBERSHIP_REQUIRES_NOTES');
  }
  return structuredClone(args);
}
