import {reconcileGraphDefinitions} from './native-definition-reconciliation-v1.mjs';
/** OFFLINE CANDIDATE COPY; production remains unchanged. */
/** Real immutable library/graph/index projection. Preparation never switches an active pointer. */
import {nativeDocumentReviewBinding} from './native-document-review-binding-v1.mjs';
import {clone, hash, canonical, need, textField} from './cq-discovery-store-v2.mjs';
import {createNativeBuildIndex} from './native-build-index-v1.mjs';
import {validateMemoryCurrentViewContract} from './lightog-current-view-contract-v1.mjs';
import {readTemporalKnowledgeProjection} from './native-temporal-index-view-v2.mjs';
import {createNativeActionDomainGraph} from './native-action-domain-adapter-v1.mjs';
import {verifyNativeActionPrepared} from './native-action-processing-host-v1.mjs';
import {prepareNativeActionLibraryForMemoryProduct} from './native-action-library-preparation-v1.mjs';
import {registerMemorySourceBindings, readMemorySourceBinding} from './native-memory-source-binding-v1.mjs';

const PLAN = 'native_memory_projection_prepared_v1';
import {verifyNativeActionEvidence} from './native-action-evidence-binding-v1.mjs';

const unique = values => [...new Set(values)];
const signed = value => {const {record_sha256, ...body} = value ?? {}; need(value && hash(body) === record_sha256, 'MEMORY_LIBRARY_REVISION_CHANGED'); return value;};
function immutable(store, kind, ref, value) {
  const old = store.getRecord(kind, ref); need(!old || hash(old) === hash(value), 'MEMORY_PROJECTION_IMMUTABLE_CONFLICT');
  if (!old) store.putRecord(kind, ref, value);
  need(hash(store.getRecord(kind, ref)) === hash(value), 'MEMORY_PROJECTION_READBACK_CHANGED');
}

export function createMemoryProductProjection({store, coreForLibrary, catalog = null, embed = null, embeddingSpace = null,
  embeddingRuntime = null, capability = 'HYBRID', executionLabel = 'HOST_CONFIGURED_EMBEDDING',
  verifyActionPrepared = verifyNativeActionPrepared, prepareActionLibrary = prepareNativeActionLibraryForMemoryProduct}) {
  need(store?.db && typeof coreForLibrary === 'function' && ['LEXICAL', 'VECTOR', 'HYBRID'].includes(capability), 'MEMORY_PROJECTION_HOST_REQUIRED');
  need(embeddingRuntime === null || typeof embeddingRuntime === 'function', 'MEMORY_PROJECTION_RUNTIME_GETTER_INVALID');
  const configuredEmbedding = () => embeddingRuntime ? embeddingRuntime() : {embed, embeddingSpace};
  const active = libraryId => store.getRecord('native_library_knowledge_active_v1', libraryId);
  const currentRevision = libraryId => {
    const pointer = active(libraryId); if (!pointer) return null;
    const revision = signed(store.getRecord('native_library_knowledge_revision_v1', pointer.revision_ref));
    need(revision.library_id === libraryId && revision.run_id === pointer.run_id && revision.record_sha256 === pointer.record_sha256
      && revision.source_snapshot_ref === pointer.source_snapshot_ref, 'MEMORY_LIBRARY_ACTIVE_CHANGED');
    return revision;
  };
  function memorySnapshot(libraryId) {
    const snapshotId = 'memory_snapshot_' + hash(libraryId);
    const value = {schema_version: 'MEMORY_PRODUCT_SNAPSHOT_V1', snapshot_id: snapshotId, source_snapshot_ref: snapshotId,
      library_id: libraryId, documents: [], source_epoch: 0, fingerprint: hash(['MEMORY_PRODUCT_SOURCE_FAMILY_V1', libraryId]),
      source_kind: 'MEMORY_RECORD_SOURCE', source_manifest_location: 'IMMUTABLE_LIBRARY_REVISION'};
    immutable(store, 'cq_v2_snapshot', snapshotId, value);
    return snapshotId;
  }
  const wrappedCatalog = {
    get(snapshotId, libraryId) {
      const snapshot = store.getRecord('cq_v2_snapshot', snapshotId);
      if (snapshot?.schema_version === 'MEMORY_PRODUCT_SNAPSHOT_V1') {
        need(snapshot.library_id === libraryId && snapshot.fingerprint === hash(['MEMORY_PRODUCT_SOURCE_FAMILY_V1', libraryId]), 'MEMORY_SNAPSHOT_CHANGED');
        return clone(snapshot);
      }
      need(catalog && typeof catalog.get === 'function', 'MEMORY_DOCUMENT_CATALOG_REQUIRED');
      return catalog.get(snapshotId, libraryId);
    },
    isCurrent(snapshotId, libraryId) {
      const snapshot = store.getRecord('cq_v2_snapshot', snapshotId);
      if (snapshot?.schema_version === 'MEMORY_PRODUCT_SNAPSHOT_V1') {
        try {this.get(snapshotId, libraryId); return true;} catch {return false;}
      }
      return !!catalog?.isCurrent(snapshotId, libraryId);
    }
  };
  function indexFor(plan) {
    return createNativeBuildIndex({store, libraryId: plan.library_id, runId: plan.run_id, snapshotId: plan.source_snapshot_ref,
      assertOpen() {need(wrappedCatalog.isCurrent(plan.source_snapshot_ref, plan.library_id), 'MEMORY_DOCUMENT_BASIS_STALE');}});
  }
  function normalizeKnowledge(rows, libraryId) {
    return rows.map(value => {
      const row = clone(value);
      const recordProofs = clone(row.record_source_evidence ?? []);
      row.evidence = (row.evidence ?? []).flatMap(evidence => {
        if (!evidence.source_record_ref) return evidence;
        const binding = readMemorySourceBinding({store, libraryId, recordRef: evidence.source_record_ref});
        if (evidence.evidence_binding) {
          verifyNativeActionEvidence({source_record_ref: binding.record_ref, revision: binding.revision, text: binding.text}, evidence);
          const proof = evidence.evidence_binding;
          if (proof.proof_scope === 'SOURCE_RECORD_ONLY') {
            // Record association is preserved separately from sentence-span evidence.
            need(evidence.quote === null && proof.span_utf16 === null, 'MEMORY_PROJECTION_RECORD_PROOF_CHANGED');
            const clean = clone(evidence);
            for (const key of ['start','end','span','spans','offset_unit','evidence_ref','id']) delete clean[key];
            recordProofs.push({...clean,kind:'MEMORY_RECORD_SOURCE_PROOF',quote:null,
              proof_ref:'memory_record_proof_' + hash([libraryId,binding.record_ref,binding.revision,proof,evidence.model_quote]),
              mapping_precision:'SOURCE_RECORD_ONLY',document_evidence_eligible:false});
            return [];
          }
          const span = proof.span_utf16;
          need(proof.proof_scope === 'LOCATED_SOURCE_SPAN' && span && Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end)
            && binding.text.slice(span.start,span.end) === evidence.quote, 'MEMORY_PROJECTION_LOCATED_SPAN_CHANGED');
          return [{...evidence,kind:'MEMORY_RECORD_EVIDENCE',
            evidence_ref:evidence.evidence_ref ?? 'memory_evidence_' + hash([libraryId,binding.record_ref,binding.revision,span.start,span.end,evidence.quote]),
            start:span.start,end:span.end,offset_unit:'utf16_code_unit',mapping_precision:'RECORD_EXACT_SPAN',
            position_disambiguated:true,document_evidence_eligible:false}];
        }
        const quote = evidence.quote ?? evidence.span?.quote, start = binding.text.indexOf(quote);
        need(textField(quote) && evidence.revision === binding.revision && start >= 0, 'MEMORY_PROJECTION_QUOTE_CHANGED');
        return {...evidence, kind: 'MEMORY_RECORD_EVIDENCE', evidence_ref: evidence.evidence_ref ?? 'memory_evidence_' + hash([libraryId, binding.record_ref, binding.revision, start, quote]),
          start, end: start + quote.length, quote, offset_unit: 'utf16_code_unit', mapping_precision: 'RECORD_EXACT_SPAN',
          position_disambiguated: binding.text.indexOf(quote, start + 1) < 0, document_evidence_eligible: false};
      });
      if (recordProofs.length) row.record_source_evidence = [...new Map(recordProofs.map(proof => [hash(proof),proof])).values()];
      row.evidence_refs = row.evidence.map(evidence => evidence.evidence_ref ?? evidence.id).filter(textField);
      return row;
    });
  }
  function boundedContext({job, relatedRecords}) {
    const revision = currentRevision(job.library_id); if (!revision || !relatedRecords.length) return {related_records: [], related_knowledge: []};
    const core = coreForLibrary(job.library_id), refs = new Set(relatedRecords.map(record => record.record_ref));
    const related = (revision.knowledge ?? []).filter(row => row.native_action && row.source_refs?.some(source => source.kind === 'MEMORY_RECORD_SOURCE' && refs.has(source.record_ref)));
    need(related.length <= 48, 'MEMORY_RELATED_CONTEXT_TOO_LARGE');
    const sourceRefs = unique(related.flatMap(row => row.source_refs.filter(source => source.kind === 'MEMORY_RECORD_SOURCE').map(source => source.record_ref)));
    const records = unique([...refs, ...sourceRefs]).filter(ref => ref !== job.record_ref).map(ref => core.getRawRecord(ref));
    need(records.length <= 32 && records.reduce((count, record) => count + record.text.length, 0) <= 64000
      && JSON.stringify(related).length <= 131072, 'MEMORY_RELATED_CONTEXT_TOO_LARGE');
    return {related_records: records, related_knowledge: clone(related)};
  }
  async function prepareProjection({job, record, prepared: input, embeddingSnapshot = null}) {
    const prepared = verifyActionPrepared(input);
    need(prepared.execution_mode === 'NATIVE_CODEX' && prepared.publication_eligible === true && prepared.library_id === job.library_id
      && prepared.source_record_ref === record.record_ref && prepared.source_record_version === record.version, 'MEMORY_ACTION_PREPARED_NOT_PUBLISHABLE');
    const libraryId = job.library_id, before = clone(active(libraryId)), previous = currentRevision(libraryId);
    const configured = capability === 'LEXICAL' ? {} : embeddingSnapshot ?? configuredEmbedding();
    need(capability === 'LEXICAL' || typeof configured?.embed === 'function' && configured.embeddingSpace, 'MEMORY_PROJECTION_EMBEDDING_NOT_CONFIGURED');
    const pinnedSpace = capability === 'LEXICAL' ? null : clone(configured.embeddingSpace), usage = [];
    function assertEmbedding() {
      if (capability !== 'LEXICAL') need(hash(configuredEmbedding()?.embeddingSpace) === hash(pinnedSpace), 'MEMORY_PROJECTION_EMBEDDING_CONFIG_CHANGED');
    }
    const pinnedEmbed = async (texts, options) => {
      assertEmbedding();
      const result = await configured.embed(texts, options); assertEmbedding();
      const vectors = Array.isArray(result) ? result : result?.vectors;
      need(Array.isArray(vectors), 'MEMORY_PROJECTION_EMBEDDING_RESPONSE_INVALID');
      usage.push({inputs: texts.length, config_revision: pinnedSpace.config_revision ?? null,
        ...(result?.usage ? {usage: clone(result.usage)} : {})});
      return vectors;
    };
    assertEmbedding();
    // Keep the old index envelope for existing A/document proof chains. New action runs have their own runtime receipts.
    const runId = before?.run_id ?? 'memory_run_' + hash(libraryId), snapshotId = before?.source_snapshot_ref ?? memorySnapshot(libraryId);
    need(wrappedCatalog.isCurrent(snapshotId, libraryId), 'MEMORY_DOCUMENT_BASIS_STALE');
    const prior = clone(previous?.knowledge ?? []), incoming = clone(prepared.knowledge), replacements = prepared.correction_bindings ?? [];
    const remove = new Set();
    if (job.operation === 'REORGANIZE') {
      const manifest = job.replacement_manifest;
      need(manifest && Array.isArray(manifest.knowledge) && manifest.source_prepared_sha256 === job.source_prepared_sha256,
        'MEMORY_REORGANIZATION_REPLACEMENT_MANIFEST_INVALID');
      // Replacing only explicitly frozen old contributions. Empty is append-missing-only.
      need(!(previous?.knowledge ?? []).some(row => row.review_event_ref || row.application_origin || row.correction_origin
        || row.knowledge_review || row.applied_receipt_ref || row.application_ref
        || ['origin_layer','answer_authority','text_origin','representation'].some(key => row[key] === 'HUMAN_CORRECTION')),
        'MEMORY_REORGANIZATION_REVIEW_INHERITANCE_REQUIRED');
      for (const pin of manifest.knowledge) {
        const target = prior.find(row => row.record_ref === pin.record_ref);
        need(target && target.native_action?.content_sha256 === pin.native_action_sha256
          && hash(target.native_action) === pin.native_action_record_sha256
          && target.source_refs.some(source => source.kind === 'MEMORY_RECORD_SOURCE' && source.record_ref === record.record_ref)
          && !remove.has(target.record_ref), 'MEMORY_REORGANIZATION_CONTRIBUTION_CHANGED');
        remove.add(target.record_ref);
      }
      need(replacements.length === 0, 'MEMORY_UNEXPECTED_CORRECTION_BINDING');
    } else if (job.operation === 'CORRECTION') {
      need(Array.isArray(replacements) && replacements.length > 0, 'MEMORY_CORRECTION_TARGET_UNRESOLVED');
      for (const binding of replacements) {
        const target = prior.find(row => row.record_ref === binding.target_knowledge_ref);
        const replacement = incoming.find(row => row.record_ref === binding.replacement_knowledge_ref);
        const targetPin = prepared.correction_target_manifest?.find(row => row.knowledge_ref === binding.target_knowledge_ref);
        need(target && replacement && textField(binding.reason) && target.native_action?.record_type === replacement.native_action?.record_type
          && targetPin?.native_action_sha256 === target.native_action.content_sha256
          && target.source_refs.some(source => source.kind === 'MEMORY_RECORD_SOURCE' && source.record_ref === job.target_record_ref)
          && !remove.has(target.record_ref), 'MEMORY_CORRECTION_TARGET_UNRESOLVED');
        remove.add(target.record_ref);
      }
    } else need(replacements.length === 0, 'MEMORY_UNEXPECTED_CORRECTION_BINDING');
    const retained = prior.filter(row => !remove.has(row.record_ref));
    const sourceRefs = unique([record.record_ref, ...retained.flatMap(row => row.source_refs ?? []).filter(source => source.kind === 'MEMORY_RECORD_SOURCE').map(source => source.record_ref),
      ...incoming.flatMap(row => row.source_refs ?? []).filter(source => source.kind === 'MEMORY_RECORD_SOURCE').map(source => source.record_ref),
      ...(prepared.source_manifest ?? []).map(source => source.record_ref)]);
    const bindings = registerMemorySourceBindings({store, coreForLibrary, libraryId, recordRefs: sourceRefs});
    const bySource = new Map(bindings.map(binding => [binding.record_ref, binding]));
    for (const origin of prepared.source_manifest ?? []) {
      const binding = bySource.get(origin.record_ref);
      need(origin.kind === 'MEMORY_RECORD_SOURCE' && origin.document_evidence_eligible === false && binding
        && origin.version === binding.version && origin.source_kind === binding.source_kind
        && origin.text_sha256 === binding.text_sha256, 'MEMORY_ACTION_SOURCE_MANIFEST_CHANGED');
    }
    for (const row of incoming) for (const origin of row.native_action?.source_origins ?? []) {
      const binding = bySource.get(origin.source_record_ref);
      need(binding && origin.revision === binding.revision && origin.source_kind === binding.source_kind,
        'MEMORY_ACTION_SOURCE_ORIGIN_CHANGED');
    }
    const sourceManifest = bindings.map(binding => ({kind: binding.kind, record_ref: binding.record_ref, version: binding.version,
      revision: binding.revision, source_kind: binding.source_kind, text_sha256: binding.text_sha256,
      source_ingested_at: binding.source_ingested_at, origin: binding.origin, document_evidence_eligible: false}));
    const decisions = clone(prepared.identity_decisions ?? []);
    const library = prepareActionLibrary({prepared, retainedKnowledge: retained, identityDecisions: decisions,
      previousRevision: previous, sourceManifest});
    need(library.ready_for_indexing, 'MEMORY_ACTION_LIBRARY_REFERENCES_UNRESOLVED');
    if (decisions.length) need(library.identity_decisions_applied_sha256 === hash(decisions), 'MEMORY_ACTION_IDENTITY_DECISIONS_NOT_APPLIED');
    const knowledge = normalizeKnowledge(library.knowledge, libraryId);
    // Persist the bridge's signed enrichment (profiles and explicit decisions), not only its mapping.
    const identity = clone(library.libraryKnowledge?.identity ?? library.identity);
    const ontology = clone(previous?.ontology ?? {definitions: [], definition_mappings: [], unbound_shapes: [], summary: {pending: 0, unbound: 0}, stage_status: 'COMPLETE'});
    const graphBase = createNativeActionDomainGraph({knowledge, sourceManifest});
    const seed = {library_id: libraryId, run_id: runId, source_snapshot_ref: snapshotId, knowledge, identity, ontology,
      source_manifest: sourceManifest, library_basis: {revision_ref: before?.revision_ref ?? null, record_sha256: before?.record_sha256 ?? null},
      action_prepared_sha256: prepared.prepared_sha256, correction_bindings: clone(replacements),
      action_library_projection_sha256: library.library_projection_sha256,
      ...(job.maintenance ? {maintenance: clone(job.maintenance)} : {})};
    const revisionRef = library.revision_ref;
    const body = {...seed, policy: 'LIBRARY_KNOWLEDGE_V1', revision_ref: revisionRef,
      domain_graph: {...graphBase, identity, ontology, definitions: ontology.definitions, revision_ref: revisionRef,
        scope: 'CURRENT_COMPLETE_LIBRARY'}};
    const revision = {...body, record_sha256: hash(body)};
    immutable(store, 'native_library_knowledge_revision_v1', revisionRef, revision);
    const index = indexFor({library_id: libraryId, run_id: runId, source_snapshot_ref: snapshotId});
    const scopeKey = canonical([libraryId, snapshotId, runId]);
    const oldSourceHead = store.getRecord('native_source_index_head_v1', scopeKey);
    const oldSourcePayload = oldSourceHead ? store.getRecord('native_source_index_payload_v1', oldSourceHead.payload_ref) : null;
    need(!oldSourceHead || hash(oldSourcePayload) === oldSourceHead.payload_sha256, 'MEMORY_SOURCE_INDEX_BASIS_CHANGED');
    const oldSources = oldSourcePayload?.records ?? [];
    need(Array.isArray(oldSources), 'MEMORY_SOURCE_INDEX_BASIS_CHANGED');
    const sources = [...oldSources.filter(row => !row.source_refs.some(source => source.kind === 'MEMORY_RECORD_SOURCE')),
      ...bindings.map(binding => {
        const evidence = {kind: 'MEMORY_RECORD_EVIDENCE', source_record_ref: binding.record_ref, revision: binding.revision,
          evidence_ref: 'memory_evidence_' + hash([libraryId, binding.record_ref, binding.revision, 0, binding.text]),
          start: 0, end: binding.text.length, quote: binding.text, offset_unit: 'utf16_code_unit', document_evidence_eligible: false};
        return {record_ref: binding.record_ref, representation: 'VERBATIM_SOURCE', text: binding.text,
          source_refs: [{kind: 'MEMORY_RECORD_SOURCE', record_ref: binding.record_ref, revision: binding.revision,
            source_kind: binding.source_kind, document_evidence_eligible: false}], evidence: [evidence], evidence_refs: [evidence.evidence_ref]};
      })];
    const indexPrepared = await index.prepareKnowledge({sources, knowledge, libraryKnowledge: revision,
      embed: capability === 'LEXICAL' ? null : pinnedEmbed, embeddingSpace: pinnedSpace, capability});
    assertEmbedding();
    need(hash(active(libraryId)) === hash(before), 'MEMORY_LIBRARY_ACTIVE_BASIS_CHANGED');
    const planBody = {library_id: libraryId, run_id: runId, source_snapshot_ref: snapshotId, expected_active: before,
      revision_ref: revisionRef, revision_sha256: revision.record_sha256, index_prepared: indexPrepared,
      action_prepared_sha256: prepared.prepared_sha256, execution_label: executionLabel,
      ...(job.maintenance ? {maintenance: clone(job.maintenance)} : {}),
      embedding_space_sha256: hash(pinnedSpace), embedding_usage: usage};
    const ref = 'memory_projection_' + hash(planBody), plan = {...planBody, projection_ref: ref, projection_sha256: hash(planBody)};
    immutable(store, PLAN, ref, plan);
    return {library_id: libraryId, knowledge_revision_ref: revisionRef, graph_revision_ref: revisionRef,
      source_index_revision: indexPrepared.source_index_revision, knowledge_index_revision: indexPrepared.knowledge_index_revision,
      action_prepared_sha256: prepared.prepared_sha256, projection_ref: ref, projection_sha256: plan.projection_sha256,
      ...(job.maintenance ? {maintenance: clone(job.maintenance)} : {})};
  }
  function planFor(frame) {
    const value = store.getRecord(PLAN, frame.projection_ref), {projection_ref, projection_sha256, ...body} = value ?? {};
    need(value && projection_sha256 === hash(body) && projection_sha256 === frame.projection_sha256
      && value.library_id === frame.library_id && value.revision_ref === frame.knowledge_revision_ref
      && frame.graph_revision_ref === value.revision_ref && value.index_prepared.source_index_revision === frame.source_index_revision
      && value.index_prepared.knowledge_index_revision === frame.knowledge_index_revision, 'MEMORY_PROJECTION_PLAN_CHANGED');
    return value;
  }
  function applyInTransaction({library_id, prepared}) {
    need(store.db.isTransaction === true, 'MEMORY_PROJECTION_CALLER_TRANSACTION_REQUIRED');
    const plan = planFor(prepared); need(plan.library_id === library_id && hash(active(library_id)) === hash(plan.expected_active), 'MEMORY_LIBRARY_ACTIVE_BASIS_CHANGED');
    if (capability !== 'LEXICAL') need(hash(configuredEmbedding()?.embeddingSpace) === plan.embedding_space_sha256, 'MEMORY_PROJECTION_EMBEDDING_CONFIG_CHANGED');
    const revision = signed(store.getRecord('native_library_knowledge_revision_v1', plan.revision_ref));
    need(revision.record_sha256 === plan.revision_sha256, 'MEMORY_LIBRARY_REVISION_CHANGED');
    indexFor(plan).applyPreparedKnowledge(plan.index_prepared);
    store.putRecord('native_library_knowledge_active_v1', library_id, {library_id, run_id: plan.run_id,
      source_snapshot_ref: plan.source_snapshot_ref, revision_ref: revision.revision_ref, record_sha256: revision.record_sha256,
      knowledge_index_revision: prepared.knowledge_index_revision, source_index_revision: prepared.source_index_revision,
      memory_projection_ref: prepared.projection_ref});
  }
  async function readback({library_id, prepared, commit_ref}) {
    const plan = planFor(prepared), pointer = active(library_id), revision = currentRevision(library_id);
    need(pointer?.memory_projection_ref === prepared.projection_ref && revision.revision_ref === prepared.knowledge_revision_ref
      && coreForLibrary(library_id).getHead()?.commit_ref === commit_ref, 'MEMORY_PROJECTION_ACTIVE_READBACK_CHANGED');
    const index = indexFor(plan), read = index.readPreparedKnowledge(plan.index_prepared), graph = index.graph({view: 'EXTRACTED_KNOWLEDGE'}).domain_graph;
    need(read.verified && graph.revision_ref === prepared.graph_revision_ref && hash(graph) === hash(revision.domain_graph)
      && pointer.source_index_revision === read.source_index_revision && pointer.knowledge_index_revision === read.knowledge_index_revision,
      'MEMORY_PROJECTION_GRAPH_READBACK_CHANGED');
    return {verified: true, library_id, knowledge_revision_ref: revision.revision_ref, graph_revision_ref: graph.revision_ref,
      source_index_revision: read.source_index_revision, knowledge_index_revision: read.knowledge_index_revision,
      evidence_refs: [revision.revision_ref, ...Object.values(plan.index_prepared.views).map(view => view.payload_ref)],
      execution_label: executionLabel};
  }
  function readCurrentView({library_id, publicationView}) {
    const pointer = active(library_id), revision = currentRevision(library_id);
    need(pointer && revision && publicationView?.queryable === true && publicationView.library_id === library_id,
      'MEMORY_CURRENT_VIEW_NOT_READY');
    const bindings = publicationView.bindings;
    need(bindings?.knowledge_revision_ref === revision.revision_ref && bindings.graph_revision_ref === revision.revision_ref
      && bindings.source_index_revision === pointer.source_index_revision && bindings.knowledge_index_revision === pointer.knowledge_index_revision,
      'MEMORY_CURRENT_VIEW_BINDING_CHANGED');
    const index = indexFor({library_id, run_id: pointer.run_id, source_snapshot_ref: pointer.source_snapshot_ref});
    const indexes = index.snapshot(), graph = index.graph({view: 'EXTRACTED_KNOWLEDGE'}).domain_graph;
    need(indexes.source_index?.index_revision === bindings.source_index_revision
      && indexes.knowledge_index?.index_revision === bindings.knowledge_index_revision
      && graph.revision_ref === bindings.graph_revision_ref && hash(graph) === hash(revision.domain_graph),
      'MEMORY_CURRENT_VIEW_INDEX_CHANGED');
    const source = wrappedCatalog.get(pointer.source_snapshot_ref, library_id);
    need(hash(active(library_id)) === hash(pointer) && wrappedCatalog.isCurrent(pointer.source_snapshot_ref, library_id),
      'MEMORY_CURRENT_VIEW_STALE');
    const dto = {schema_version: 'MEMORY_CURRENT_VIEW_V1', library_id,
      binding: {index_scope_run_id: pointer.run_id, source_snapshot_ref: pointer.source_snapshot_ref,
        library_revision_ref: revision.revision_ref, record_sha256: revision.record_sha256,
        graph_revision_ref: graph.revision_ref, source_index_revision: bindings.source_index_revision,
        knowledge_index_revision: bindings.knowledge_index_revision, commit_ref: publicationView.commit_ref,
        confirmation_ref: publicationView.confirmation_ref},
      document_review_binding:nativeDocumentReviewBinding({store,libraryId:library_id,revision,active:pointer}),
      pending_classification_policy:revision.pending_classification_policy??null,pending_issues:clone(revision.pending_issues??[]),
      publication: clone(publicationView), knowledge: clone(revision.knowledge), domain_graph: clone(graph),
      identity: clone(revision.identity), ontology: clone(revision.ontology), source_snapshot: clone(source),
      indexes: {source: clone(indexes.source_index), knowledge: clone(indexes.knowledge_index)},
      gaps: ['STRICT_HISTORY_BOUNDARY_UNSEALED'], native_document_run_emulated: false};
    const definitions=reconcileGraphDefinitions({graph:dto.domain_graph,ontology:dto.ontology,knowledge:dto.knowledge,basis:{library_id,revision_ref:revision.revision_ref,record_sha256:revision.record_sha256,raw_graph_sha256:hash(graph),current_view_binding:clone(dto.binding)}});
    if(definitions.changed){dto.domain_graph=definitions.graph;dto.ontology=definitions.ontology;dto.definition_projection=definitions.projection;}
    const checked = validateMemoryCurrentViewContract(dto, {libraryId: library_id});
    if (checked.status !== 'READY') throw Object.assign(new Error(checked.reason), {code: checked.diagnostic.code,
      path: checked.diagnostic.path, diagnostic: checked.diagnostic});
    // The persisted graph, knowledge and their publication pins remain the
    // immutable audit basis. Compatibility is a separately bound read model.
    if (revision.knowledge.some(row => row.temporal_fact)) {
      const derived = readTemporalKnowledgeProjection({store, libraryId: library_id, runId: pointer.run_id,
        revisionRef: revision.revision_ref, revisionSha256: revision.record_sha256});
      const {projection_sha256, ...body} = derived;
      const envelope = {...body, current_view_binding: clone(dto.binding), read_projection_sha256: projection_sha256};
      dto.temporal_projection = {...envelope, projection_sha256: hash(envelope)};
    }
    return dto;
  }
  return Object.freeze({mode: 'NATIVE_PRODUCT', prepareProjection, resolveContext: boundedContext, applyInTransaction, readback,
    readCurrentView, catalog: wrappedCatalog, currentRevision});
}
