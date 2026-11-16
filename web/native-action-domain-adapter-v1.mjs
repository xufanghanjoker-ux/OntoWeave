/** Source-local prepared domain projection. No store, embeddings, identity decisions or publication. */
import {clone, hash, need, textField} from './cq-discovery-store-v2.mjs';
import {verifyNativeActionDraft} from './native-action-contract-v1.mjs';
import {verifyNativeActionLink} from './native-action-process-v1.mjs';
import {createDomainGraph, DOMAIN_SEMANTIC_POLICY} from './native-domain-knowledge-v1.mjs';
import {GENERAL_KNOWLEDGE_POLICY} from './native-general-knowledge-v1.mjs';
import {normalizeValidTime} from './native-temporal-value-v1.mjs';
import {extendNativeActionGraph} from './native-action-graph-extension-v1.mjs';
import {verifyNativeActionEvidence} from './native-action-evidence-binding-v1.mjs';

export const ACTION_DOMAIN_POLICY = 'ACTION_DOMAIN_PREPARED_V1';
const list = value => Array.isArray(value) ? value : [];
const name = value => typeof value === 'string' ? value : value?.name ?? value?.label;
export const actionKnowledgeRef = draft => 'action_knowledge_' + hash([draft.library_id, draft.draft_ref, draft.content_sha256]);
export const actionDomainNodeRef = draft => 'action_node_' + hash([draft.library_id, draft.draft_ref]);
const mainNodeRef = actionDomainNodeRef;

export function projectNativeActionDomain({libraryId, drafts, sourceRecords, contextKnowledge = [], links = [], semanticPackageRefs = {}}) {
  need(textField(libraryId) && Array.isArray(drafts) && Array.isArray(sourceRecords), 'ACTION_DOMAIN_INPUT_INVALID');
  const sources = new Map(sourceRecords.map(source => [source.source_record_ref, source]));
  need(sources.size === sourceRecords.length && sourceRecords.every(source => source.library_id === libraryId), 'ACTION_DOMAIN_SOURCE_SCOPE_INVALID');
  const allDrafts = [...contextKnowledge.map(record => record.native_action), ...drafts];
  const byDraft = new Map();
  for (const draft of allDrafts) {
    verifyNativeActionDraft(draft);
    need(draft.library_id === libraryId, 'ACTION_DOMAIN_LIBRARY_MISMATCH');
    for (const evidence of draft.evidence) {
      const source = sources.get(evidence.source_record_ref);
      verifyNativeActionEvidence(source, evidence);
    }
    const old = byDraft.get(draft.draft_ref);
    need(!old || old.content_sha256 === draft.content_sha256, 'ACTION_DOMAIN_DRAFT_AMBIGUOUS');
    byDraft.set(draft.draft_ref, draft);
  }
  const gaps = [], extraNodes = [], extraEdges = [];
  const knowledge = drafts.map(draft => {
    const ref = actionKnowledgeRef(draft), nodeRef = mainNodeRef(draft), business = draft.payload.business;
    let validTime;
    try { validTime = normalizeValidTime(draft.time_proposal.valid_time ?? {kind:'UNRESOLVED', time_text:draft.time_proposal.time_text}); }
    catch { validTime = {kind:'UNRESOLVED', time_text:draft.time_proposal.time_text, gaps:['INVALID_TIME_PROPOSAL_RETAINED']}; }
    const sourceRefs = draft.source_origins.map(origin => ({revision:origin.revision,
      kind:'MEMORY_RECORD_SOURCE', record_ref:origin.source_record_ref, source_kind:origin.source_kind,
      document_evidence_eligible:false}));
    const qualifiers = {record_refs:[ref], source_refs:sourceRefs, conditions:clone(draft.conditions),
      modality:draft.modality, negation:draft.negation, valid_time:clone(validTime),
      semantic_support:draft.semantic_support};
    const entities = [], participants = [], localReferenceReuse = [];
    const declarations = [business.subject, ...list(business.participants).map(p => p?.entity ?? p?.subject)]
      .filter(value => value && typeof value === 'object' && textField(name(value)) && textField(value.type));
    function entity(value, usage) {
      const label = name(value);
      if (!textField(label)) return null;
      let resolved = value;
      const bare = typeof value === 'string' || value && typeof value === 'object'
        && Object.keys(value).every(key => ['name','label','type'].includes(key)) && value.type == null;
      if (bare) {
        const candidates = [...new Map(declarations.filter(item => name(item) === label).map(item => [hash(item),item])).values()];
        if (candidates.length === 1) {
          resolved = candidates[0];
          localReferenceReuse.push({usage,raw_value:clone(value),declaration:clone(resolved),basis:'UNIQUE_EXPLICIT_DECLARATION_IN_PROPOSAL'});
        } else if (candidates.length > 1) gaps.push({draft_ref:draft.draft_ref,code:'ACTION_LOCAL_REFERENCE_AMBIGUOUS',usage,label});
      }
      const id = 'action_entity_' + hash([libraryId, draft.source_origins.map(origin => origin.source_record_ref), label, resolved?.type ?? null]);
      if (!entities.some(entity => entity.id === id)) entities.push({id, name:label, label, kind:'ENTITY', entity_type:resolved?.type ?? null, source_refs:sourceRefs});
      if (localReferenceReuse.at(-1)?.usage === usage) localReferenceReuse.at(-1).entity_ref = id;
      return id;
    }
    const subject = entity(business.subject, 'subject');
    for (const [index, participant] of list(business.participants).entries()) {
      const ref = entity(participant?.entity ?? participant?.subject, 'participant:' + index);
      if (ref && textField(participant.role)) participants.push({role:participant.role, subject_ref:ref});
      else gaps.push({draft_ref:draft.draft_ref, code:'ACTION_PARTICIPANT_UNBOUND', raw:clone(participant)});
    }
    const actual = draft.record_type === 'ACTION_OCCURRENCE' && draft.payload.execution_claim === 'REPORTED';
    const kind = draft.record_type === 'ACTION_OCCURRENCE' ? (actual ? 'EVENT' : 'ACTION_INTENT') : draft.record_type;
    const node = {id:nodeRef, name:business.label ?? draft.payload.text, label:business.label ?? draft.payload.text,
      kind, entity_type:draft.record_type, native_action:clone(draft), resolved_subject_ref:subject,
      resolved_participants:clone(participants), ...qualifiers};
    entities.push(node);
    const edge = (source, target, predicate, edgeKind) => extraEdges.push({id:'action_edge_' + hash([ref, source, target, predicate]),
      source, target, predicate, label:predicate, kind:edgeKind, ...qualifiers});
    if (subject) edge(nodeRef, subject, 'ABOUT', 'ACTION_SUBJECT');
    if (!actual) for (const participant of participants) edge(nodeRef, participant.subject_ref, participant.role, 'INTENT_PARTICIPANT');
    if (list(draft.conditions).length) {
      const contextRef = 'action_context_' + hash([draft.draft_ref, draft.conditions]);
      extraNodes.push({id:contextRef, name:JSON.stringify(draft.conditions), kind:'CONTEXT', conditions:clone(draft.conditions), ...qualifiers});
      edge(nodeRef, contextRef, 'UNDER_CONTEXT', 'ACTION_CONTEXT');
    }
    if (['STATE_ASSERTION', 'OBSERVATION', 'EVALUATION'].includes(draft.record_type)) {
      node.attributes = [{name:business.property ?? (draft.record_type === 'EVALUATION' ? '评价' : '未决属性'),
        value:clone(business.value ?? business.verdict ?? null), unit:business.unit ?? null,
        measurement:clone(business), ...qualifiers}];
      extraNodes.push(clone(node));
    }
    const text = [draft.payload.text, '业务内容：' + JSON.stringify(business),
      '条件：' + JSON.stringify(draft.conditions), '时间：' + JSON.stringify(validTime),
      '未决：' + JSON.stringify(draft.uncertainties)].join('\n');
    return {record_ref:ref, knowledge_ref:ref, library_id:libraryId, kind:'ENTITY', original_kind:draft.record_type,
      representation:'EXTRACTED_KNOWLEDGE', answer_authority:'EXTRACTED_KNOWLEDGE',
      semantic_policy:DOMAIN_SEMANTIC_POLICY, general_knowledge_policy:GENERAL_KNOWLEDGE_POLICY,
      text, statement:draft.payload.text, subject_ref:nodeRef, participants,
      source_refs:sourceRefs, evidence:clone(draft.evidence), evidence_refs:[],
      semantic_lineage:{package_ref:semanticPackageRefs[draft.draft_ref] ?? null, semantic_refs:draft.semantic_lineage.map(item => item.semantic_ref)},
      conditions:clone(draft.conditions), negation:draft.negation, modality:draft.modality,
      time_text:clone(draft.time_proposal.time_text), valid_time:validTime, valid_time_input:clone(draft.time_proposal),
      domain:{entities, definition:null, relation:null}, native_action:clone(draft),
      local_reference_reuse:localReferenceReuse,
      action_domain_nodes:extraNodes.filter(node=>node.record_refs?.includes(ref)).map(clone),
      action_domain_edges:extraEdges.filter(edge=>edge.record_refs?.includes(ref)).map(clone),
      action_domain_policy:ACTION_DOMAIN_POLICY, source_record_refs:draft.source_origins.map(origin => origin.source_record_ref),
      warnings:clone(draft.warnings), semantic_quality:'UNASSESSED'};
  });
  for (const link of links) {
    verifyNativeActionLink(link);
    const from = byDraft.get(link.from.draft_ref), to = byDraft.get(link.to.draft_ref);
    need(link.library_id === libraryId && from?.content_sha256 === link.from.content_sha256
      && to?.content_sha256 === link.to.content_sha256, 'ACTION_DOMAIN_LINK_TARGET_CHANGED');
    const contextFrom=contextKnowledge.find(record=>record.native_action.draft_ref===from.draft_ref);
    const contextTo=contextKnowledge.find(record=>record.native_action.draft_ref===to.draft_ref);
    const id = 'action_process_edge_' + link.link_sha256;
    const edge={id, source:contextFrom?.subject_ref??mainNodeRef(from), target:contextTo?.subject_ref??mainNodeRef(to), predicate:link.type, label:link.type,
      kind:'RECORDED_PROCESS_LINK', record_refs:[contextFrom?.record_ref??actionKnowledgeRef(from), contextTo?.record_ref??actionKnowledgeRef(to)],
      source_refs:knowledge.find(record => record.native_action.draft_ref === from.draft_ref)?.source_refs ?? [],
      process_link:clone(link), claim_scope:'REPORTED_ASSOCIATION_NOT_CAUSAL'};
    knowledge.find(record=>record.native_action.draft_ref===from.draft_ref)?.action_domain_edges.push(clone(edge));
  }
  const manifest = sourceRecords.map(source => ({kind:'MEMORY_RECORD_SOURCE', record_ref:source.source_record_ref,
    version:Number(source.revision), source_kind:source.source_kind, source_ingested_at:source.source_ingested_at,
    text_sha256:hash(source.text), origin:source.source_kind === 'HUMAN_TEXT' ? 'HUMAN_ASSERTED' : 'SOURCE_REPORTED',
    document_evidence_eligible:false}));
  for (const source of manifest) {
    const id = 'action_source_' + hash([libraryId, source.record_ref, source.version]);
    for (const record of knowledge.filter(record => record.source_record_refs.includes(source.record_ref))) {
      const edgeId = 'action_provenance_' + hash([record.record_ref, id]);
      const edge={id:edgeId, source:record.subject_ref, target:id, predicate:'REPORTED_IN', label:'REPORTED_IN',
        kind:'ACTION_PROVENANCE', record_refs:[record.record_ref], source_refs:record.source_refs};
      record.action_domain_edges.push(clone(edge));
    }
  }
  const graph=createNativeActionDomainGraph({knowledge:[...contextKnowledge,...knowledge],sourceManifest:manifest});
  gaps.push(...(graph.action_gaps??[]));
  return {policy:ACTION_DOMAIN_POLICY, knowledge,
    domain_graph:{...graph,scope:'DELTA_WITH_EXACT_RELATED_CONTEXT'},
    source_manifest:manifest, process_links:clone(links), gaps,
    index_documents:knowledge.map(record => ({knowledge_ref:record.knowledge_ref, text:record.text,
      source_refs:clone(record.source_refs), valid_time:clone(record.valid_time), native_action:clone(record.native_action),
      process_links:links.filter(link => link.from.draft_ref === record.native_action.draft_ref).map(clone),
      content_sha256:hash(record)})),
    published:false, graph_index_committed:false};
}

/** Shared integration hook after the caller's library identity projection; keeps unrelated legacy knowledge. */
export function createNativeActionDomainGraph({knowledge,sourceManifest=[]}) {
  need(Array.isArray(knowledge)&&Array.isArray(sourceManifest),'ACTION_GRAPH_INPUT_INVALID');
  const graph=extendNativeActionGraph({graph:createDomainGraph(knowledge),knowledge,sourceManifest});
  return {...graph,action_extension_policy:ACTION_DOMAIN_POLICY,action_gaps:graph.action_gaps??[]};
}
