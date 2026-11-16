/** Evidence-bound process proposals, with no time/name based identity inference. */
import {clone, hash, need, textField} from './cq-discovery-store-v2.mjs';
import {verifyNativeActionDraft} from './native-action-contract-v1.mjs';

export const ACTION_PROCESS_POLICY = 'ACTION_PROCESS_PROPOSAL_V1';
const actual = node => node.draft.payload.execution_claim === 'REPORTED';
const type = node => node.draft.record_type;
const rules = {
  REALIZES_PLAN: (from, to) => type(from) === 'ACTION_OCCURRENCE' && actual(from)
    && type(to) === 'ACTION_OCCURRENCE' && to.draft.payload.action_phase === 'PLANNED',
  BEFORE_ACTION: (from, to) => ['STATE_ASSERTION', 'OBSERVATION'].includes(type(from)) && type(to) === 'ACTION_OCCURRENCE',
  AFTER_ACTION: (from, to) => ['STATE_ASSERTION', 'OBSERVATION'].includes(type(from)) && type(to) === 'ACTION_OCCURRENCE' && actual(to),
  EVALUATION_OF: (from, to) => type(from) === 'EVALUATION' && type(to) === 'OBSERVATION',
  MEMBER_OF: (from, to) => type(from) !== 'RECORDED_PROCESS' && type(to) === 'RECORDED_PROCESS',
};

/** bindings are Host-resolved handles, not fields accepted from untrusted model proposals.
 * Saved nodes pin a record_ref/version; callers must supply the frozen intended record set.
 */
export function buildNativeActionProcess({libraryId, nodes, associations = [], referenceBindings = [], anchorBindings = []}) {
  need(textField(libraryId) && Array.isArray(nodes) && Array.isArray(associations)
    && Array.isArray(referenceBindings) && Array.isArray(anchorBindings), 'NATIVE_ACTION_PROCESS_INPUT_INVALID');
  const registry = new Map();
  for (const node of nodes) {
    verifyNativeActionDraft(node.draft);
    need(node.draft.library_id === libraryId && textField(node.ref) && !registry.has(node.ref), 'NATIVE_ACTION_NODE_BINDING_INVALID');
    need(node.ref === (node.record_ref ?? node.draft.draft_ref), 'NATIVE_ACTION_NODE_REFERENCE_INVALID');
    if (node.record_ref) need(textField(node.logical_ref), 'NATIVE_ACTION_SAVED_IDENTITY_MISSING');
    registry.set(node.ref, clone(node));
  }
  const bindings = values => {
    const map = new Map();
    for (const value of values) {
      need(value?.library_id === libraryId && textField(value.binding_ref) && !map.has(value.binding_ref), 'NATIVE_ACTION_ASSOCIATION_BINDING_INVALID');
      map.set(value.binding_ref, clone(value));
    }
    return map;
  };
  const references = bindings(referenceBindings), anchors = bindings(anchorBindings);
  const hasSemantic = (node, ref) => node.draft.semantic_lineage.some(item => item.semantic_ref === ref);
  const links = [], retained = [];
  for (const proposal of associations) try {
    const from = registry.get(proposal?.from_ref), to = registry.get(proposal?.to_ref);
    need(from && to && from.ref !== to.ref, 'NATIVE_ACTION_ASSOCIATION_TARGET_UNKNOWN');
    need(Object.hasOwn(rules, proposal.type) && rules[proposal.type](from, to), 'NATIVE_ACTION_ASSOCIATION_DIRECTION_OR_TYPE_INVALID');
    let basis;
    if (proposal.basis?.binding_ref) {
      const binding = references.get(proposal.basis.binding_ref);
      need(binding && ['EXPLICIT_REFERENCE', 'CHECKED_IDENTITY'].includes(binding.kind)
        && binding.from_ref === from.ref && binding.to_ref === to.ref && hasSemantic(from, binding.semantic_ref), 'NATIVE_ACTION_REFERENCE_NOT_BOUND');
      if (binding.kind === 'CHECKED_IDENTITY') need(binding.identity_scope === 'ACTION_OR_PROCESS_INSTANCE'
        && textField(binding.check_ref), 'NATIVE_ACTION_INSTANCE_IDENTITY_REQUIRED');
      basis = clone(binding);
    } else {
      const refs = proposal.basis?.anchor_binding_refs;
      need(Array.isArray(refs) && refs.length === 2, 'NATIVE_ACTION_ASSOCIATION_BASIS_REQUIRED');
      const a = anchors.get(refs[0]), b = anchors.get(refs[1]);
      need(a && b && a.node_ref === from.ref && b.node_ref === to.ref
        && hasSemantic(from, a.semantic_ref) && hasSemantic(to, b.semantic_ref), 'NATIVE_ACTION_ANCHOR_NOT_BOUND');
      for (const key of ['namespace', 'key', 'subject_ref', 'context_ref'])
        need(textField(a[key]) && a[key] === b[key], 'NATIVE_ACTION_ANCHOR_AMBIGUOUS');
      basis = {kind:'SCOPED_PROCESS_KEY', bindings:[clone(a), clone(b)]};
    }
    const endpoint = node => ({ref:node.ref, record_type:type(node), draft_ref:node.draft.draft_ref,
      content_sha256:node.draft.content_sha256, record_ref:node.record_ref ?? null, logical_ref:node.logical_ref ?? null});
    const body = {policy:ACTION_PROCESS_POLICY, library_id:libraryId, type:proposal.type,
      from:endpoint(from), to:endpoint(to), basis, claim_scope:'REPORTED_ASSOCIATION_NOT_CAUSAL'};
    links.push({...body, link_sha256:hash(body)});
  } catch (error) {
    retained.push({raw:clone(proposal), reason:error.code ?? 'NATIVE_ACTION_ASSOCIATION_INVALID', saved:false});
  }
  return {policy:ACTION_PROCESS_POLICY, library_id:libraryId, nodes:[...registry.values()], links, retained,
    scope:'PROVIDED_RECORD_SET_ONLY', business_effect:'NOT_INFERRED'};
}

export function verifyNativeActionLink(link) {
  const {link_sha256, ...body} = link ?? {};
  need(link?.policy === ACTION_PROCESS_POLICY && link_sha256 === hash(body), 'NATIVE_ACTION_LINK_CHANGED');
  return clone(link);
}

/** A content view of a supplied exact record set, not a published/current or historical reader. */
export function readNativeActionExperience(process, focusRef) {
  const nodes = new Map(process.nodes.map(node => [node.ref, node]));
  need(nodes.has(focusRef), 'NATIVE_ACTION_PROCESS_FOCUS_UNKNOWN');
  for (const node of nodes.values()) {
    verifyNativeActionDraft(node.draft);
    need(node.draft.library_id === process.library_id, 'NATIVE_ACTION_NODE_BINDING_INVALID');
  }
  for (const link of process.links) {
    verifyNativeActionLink(link);
    for (const end of [link.from, link.to]) {
      const node = nodes.get(end.ref);
      need(node && node.draft.content_sha256 === end.content_sha256
        && (node.record_ref ?? null) === end.record_ref && (node.logical_ref ?? null) === end.logical_ref,
      'NATIVE_ACTION_VIEW_RECORD_SET_CHANGED');
    }
  }
  const included = new Set([focusRef]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const link of process.links) if (included.has(link.from.ref) || included.has(link.to.ref)) {
      for (const end of [link.from, link.to]) if (!included.has(end.ref)) {included.add(end.ref); changed = true;}
    }
  }
  const selected = [...included].map(ref => nodes.get(ref));
  const pick = recordType => selected.filter(node => type(node) === recordType).map(clone);
  return {scope:'PROVIDED_RECORD_SET_ONLY', focus_ref:focusRef,
    actions:pick('ACTION_OCCURRENCE'), states:pick('STATE_ASSERTION'), observations:pick('OBSERVATION'),
    evaluations:pick('EVALUATION'), processes:pick('RECORDED_PROCESS'),
    links:process.links.filter(link => included.has(link.from.ref) && included.has(link.to.ref)).map(clone),
    gaps:clone(process.retained), business_effect:'NOT_INFERRED', causal_conclusion:null};
}
