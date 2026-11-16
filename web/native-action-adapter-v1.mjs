/** Thin injected adapter to MEMORY_RECORD_V1; never publishes, indexes, or executes actions. */
import {clone, hash, need, textField} from './cq-discovery-store-v2.mjs';
import {verifyNativeActionDraft} from './native-action-contract-v1.mjs';
import {verifyNativeActionLink} from './native-action-process-v1.mjs';
import {verifyNativeActionEvidence} from './native-action-evidence-binding-v1.mjs';

export function bindNativeActionSource(record) {
  need(record?.schema_version === 'MEMORY_RECORD_V1' && textField(record.record_ref)
    && textField(record.library_id) && Number.isInteger(record.version) && record.source
    && typeof record.text === 'string', 'NATIVE_ACTION_RAW_SOURCE_REQUIRED');
  return {source_record_ref:record.record_ref, library_id:record.library_id, revision:String(record.version),
    text:record.text, source_kind:record.source.kind, reporter:clone(record.source.metadata?.reporter ?? null),
    source_ingested_at:record.source_ingested_at, receipt:clone(record.source.metadata?.receipt ?? null)};
}

export function readNativeActionRecord(record) {
  const draft = verifyNativeActionDraft(record?.content?.native_action);
  need(record.schema_version === 'MEMORY_RECORD_V1' && record.library_id === draft.library_id
    && textField(record.record_ref) && textField(record.logical_ref), 'NATIVE_ACTION_SAVED_RECORD_INVALID');
  return {ref:record.record_ref, record_ref:record.record_ref, logical_ref:record.logical_ref, draft};
}

/** Core injection is Host-only. RECORD_ONLY is deliberately not graph/index capability. */
export function createNativeActionRecordAdapter({core, libraryId, capability}) {
  need(capability === 'RECORD_ONLY' && textField(libraryId)
    && ['getRawRecord', 'saveRecord', 'appendRecord', 'correctRecord'].every(name => typeof core?.[name] === 'function'),
  'NATIVE_ACTION_CORE_CAPABILITY_UNSUPPORTED');

  function input(draft, links = []) {
    verifyNativeActionDraft(draft);
    need(draft.library_id === libraryId, 'NATIVE_ACTION_LIBRARY_MISMATCH');
    // Check exact original versions, never a mutable latest-source lookup.
    for (const origin of draft.source_origins) {
      const raw = bindNativeActionSource(core.getRawRecord(origin.source_record_ref));
      const {text:originalText, ...binding} = raw;
      need(raw.library_id === libraryId && hash(binding) === hash({...origin, library_id:libraryId}),
        'NATIVE_ACTION_SOURCE_CHANGED');
      for (const evidence of draft.evidence.filter(item => item.source_record_ref === raw.source_record_ref))
        verifyNativeActionEvidence(raw, evidence);
    }
    for (const link of links) {
      verifyNativeActionLink(link);
      need(link.library_id === libraryId && link.from.draft_ref === draft.draft_ref
        && link.from.content_sha256 === draft.content_sha256, 'NATIVE_ACTION_LINK_SOURCE_MISMATCH');
      need(textField(link.to.record_ref), 'NATIVE_ACTION_LINK_TARGET_NOT_SAVED');
      const target = readNativeActionRecord(core.getRawRecord(link.to.record_ref));
      need(target.draft.library_id === libraryId && target.logical_ref === link.to.logical_ref
        && target.draft.content_sha256 === link.to.content_sha256, 'NATIVE_ACTION_LINK_TARGET_CHANGED');
    }
    const proposedTime = draft.time_proposal.valid_time;
    const time = proposedTime && typeof proposedTime === 'object' && !Array.isArray(proposedTime)
      ? {...proposedTime, time_text:proposedTime.time_text ?? draft.time_proposal.time_text}
      : proposedTime ?? {kind:'UNRESOLVED', time_text:draft.time_proposal.time_text};
    return {text:draft.payload.text,
      source:{kind:'AGENT_REPORT', external_ref:draft.draft_ref, revision:draft.content_sha256,
        label:'LightOG organized action draft', metadata:{derivation:'ORGANIZED_DRAFT',
          evidence_record_refs:draft.source_origins.map(origin => origin.source_record_ref)}},
      valid_time:clone(time), content:{native_action:clone(draft), process_links:clone(links)},
      modality:draft.modality, uncertainties:clone(draft.uncertainties)};
  }
  function receipt(value, draft) {
    need(value?.raw_saved === true && value.publication_state === 'UNPUBLISHED'
      && textField(value.record_ref) && textField(value.logical_ref), 'NATIVE_ACTION_CORE_RECEIPT_INVALID');
    return {...clone(value), draft_ref:draft.draft_ref, content_sha256:draft.content_sha256,
      capability:'RECORD_ONLY', action_executed_by_adapter:false, graph_index_written:false};
  }
  const host = key => {need(textField(key), 'NATIVE_ACTION_IDEMPOTENCY_KEY_REQUIRED'); return {idempotency_key:key};};
  return Object.freeze({
    capability:'RECORD_ONLY',
    saveDraft({draft, links = [], idempotencyKey}) {
      return receipt(core.saveRecord(input(draft, links), host(idempotencyKey)), draft);
    },
    appendFeedback({draft, links, idempotencyKey}) {
      need(['OBSERVATION', 'EVALUATION', 'STATE_ASSERTION'].includes(draft?.record_type)
        && Array.isArray(links) && links.length > 0, 'NATIVE_ACTION_FEEDBACK_LINK_REQUIRED');
      need(links.every(link => ['AFTER_ACTION', 'EVALUATION_OF'].includes(link.type)), 'NATIVE_ACTION_FEEDBACK_RELATION_INVALID');
      const record = input(draft, links);
      return receipt(core.appendRecord(record, {...host(idempotencyKey),
        relation_kind:draft.record_type === 'OBSERVATION' ? 'NEW_OBSERVATION' : 'SUPPLEMENT',
        related_logical_refs:[...new Set(links.map(link => link.to.logical_ref))]}), draft);
    },
    correctDraft({draft, logicalRef, expectedRecordRef, reason, idempotencyKey}) {
      need(textField(reason) && textField(logicalRef) && textField(expectedRecordRef), 'NATIVE_ACTION_CORRECTION_TARGET_REQUIRED');
      const target = readNativeActionRecord(core.getRawRecord(expectedRecordRef));
      need(target.draft.library_id === libraryId && target.logical_ref === logicalRef
        && target.draft.record_type === draft.record_type, 'NATIVE_ACTION_CORRECTION_TARGET_INVALID');
      return receipt(core.correctRecord({logical_ref:logicalRef, expected_record_ref:expectedRecordRef,
        reason, record:input(draft)}, host(idempotencyKey)), draft);
    },
    readRecord(recordRef) {
      const node = readNativeActionRecord(core.getRawRecord(recordRef));
      need(node.draft.library_id === libraryId, 'NATIVE_ACTION_LIBRARY_MISMATCH');
      return node;
    },
  });
}

/** Proposal for the existing EVENT/participant seam. New kinds must not fall through old normalizers. */
export function proposeNativeActionEvent(draft) {
  verifyNativeActionDraft(draft);
  if (draft.record_type !== 'ACTION_OCCURRENCE' || draft.payload.execution_claim !== 'REPORTED')
    return {supported:false, reason:'ACTUAL_ACTION_REQUIRED', retained:clone(draft)};
  const participants = draft.payload.business.participants;
  if (!Array.isArray(participants) || participants.length === 0
    || participants.some(item => !textField(item.role) || !textField(item.subject_ref)))
    return {supported:false, reason:'PARTICIPANT_BINDING_INCOMPLETE', retained:clone(draft)};
  return {supported:true, scope:'EVENT_PROJECTION_PROPOSAL_ONLY', graph_index_written:false,
    required_capabilities:['EVENT_PARTICIPANT_ROLES', 'ACTION_QUALIFIERS', 'EXACT_SOURCE_BINDING'],
    row:{kind:'EVENT', name:draft.payload.business.label ?? draft.payload.text, text:draft.payload.text,
      participants:clone(participants), conditions:clone(draft.conditions), negation:draft.negation,
      modality:draft.modality, time_text:clone(draft.time_proposal.time_text)},
    extension:{native_action:clone(draft), business_effect:'NOT_INFERRED'}};
}
