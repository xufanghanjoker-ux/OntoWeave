/** CONTROLLED_PREPARED_CONTRACT_NOT_MODEL. Authored proposals for program tests only. */
import {hash} from './cq-discovery-store-v2.mjs';
import {bindNativeActionSource} from './native-action-adapter-v1.mjs';
import {prepareNativeActionBatch} from './native-action-contract-v1.mjs';
import {projectNativeActionDomain} from './native-action-domain-adapter-v1.mjs';
export function authoredPrepared(record, proposals, extra = {}) {
  const source = bindNativeActionSource(record), batch = prepareNativeActionBatch({libraryId: record.library_id,
    requestId: record.record_ref, sourceRecords: [source], semanticItems: [{semantic_ref: 'authored', library_id: record.library_id,
      text: record.text, evidence: [{source_record_ref: record.record_ref, revision: String(record.version), quote: record.text}]}],
    proposals: proposals.map((proposal, index) => ({...proposal, local_ref: 'fixture-' + index, semantic_refs: ['authored'], text: record.text}))});
  const projection = projectNativeActionDomain({libraryId: record.library_id, drafts: batch.drafts, sourceRecords: [source]});
  const body = {schema: 'NATIVE_ACTION_PROCESSING_PREPARED_V1', library_id: record.library_id,
    source_record_ref: record.record_ref, source_record_version: record.version, execution_mode: 'NATIVE_CODEX',
    publication_eligible: true, run_id: 'CONTROLLED_PREPARED_CONTRACT_NOT_MODEL', skill_bindings: [], invocations: [],
    ...projection, ...extra};
  return {...body, prepared_sha256: hash(body)};
}
