/** Pure projections of retained build inputs. Never constructs a worker or writes a record. */
import {hash} from './cq-discovery-store-v2.mjs';

export const NATIVE_ARTIFACT_KINDS = ['chunks', 'windows', 'documents', 'blocks'];
export const NATIVE_ARTIFACT_PAGE_LIMIT = 100;
const need = (ok, code, status = 409) => {if (!ok) throw Object.assign(Error(code), {code, status});};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const strings = value => Array.isArray(value) ? value.filter(v => typeof v === 'string') : [];
const pick = (value, keys) => Object.fromEntries(keys.filter(k => ['string', 'number', 'boolean'].includes(typeof value?.[k])).map(k => [k, value[k]]));
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const policyFields = ['engine', 'max_tokens', 'tokenizer', 'token_count_exact', 'model_tokenizer_match', 'merge_peers', 'repeat_table_header', 'always_emit_headings', 'budget_scope', 'source_mapping', 'window_composition','range_contract','structure_strategy','split_strategy'];
const summaryFields = ['documents', 'chunks', 'windows', 'gaps', 'source_blocks', 'represented_blocks', 'source_chunks'];

function provenance(value) {
  return (Array.isArray(value) ? value : []).filter(object).map(p => ({
    ...pick(p, ['page_no', 'page', 'start', 'end']),
    ...(object(p.bbox) ? {bbox: pick(p.bbox, ['l', 't', 'r', 'b', 'coord_origin'])} : {}),
    ...(Array.isArray(p.charspan) && p.charspan.every(Number.isSafeInteger) ? {charspan: [...p.charspan]} : {})
  }));
}

function checkedRun(store, libraryId, runId, snapshotId = null) {
  const row = store.getRecord('native_product_run_v1', runId);
  need(row && row.library_id === libraryId, 'NATIVE_RUN_NOT_FOUND', 404);
  need(row.run_id === runId && text(row.snapshot_id) && (!snapshotId || row.snapshot_id === snapshotId), 'NATIVE_ARTIFACT_RUN_BINDING_CHANGED');
  const state = store.getRecord('native_full_chain_state_v1', runId);
  if (state) {
    need(state.run_id === runId && state.library_id === libraryId && state.snapshot_id === row.snapshot_id, 'NATIVE_ARTIFACT_RUN_BINDING_CHANGED');
    if (state.input) need(state.input.library_ref === libraryId && state.input.source_snapshot_ref === row.snapshot_id, 'NATIVE_ARTIFACT_RUN_BINDING_CHANGED');
  }
  return {row, state};
}

function checkedPlan(plan, source) {
  const {plan_sha256, ...body} = plan ?? {};
  need(object(plan) && text(plan.plan_ref) && plan_sha256 === hash(body) && plan.source_snapshot_ref === source.snapshot_id && plan.source_fingerprint === source.fingerprint && Array.isArray(plan.chunks) && Array.isArray(plan.windows), 'NATIVE_ARTIFACT_PLAN_BINDING_CHANGED');
  const refs = new Set();
  for (const row of [...plan.chunks, ...plan.windows]) {
    need(object(row), 'NATIVE_ARTIFACT_PLAN_BINDING_CHANGED');
    const doc = source.documents.find(d => d.doc_id === row.doc_ref);
    const ref = row.window_ref ?? row.chunk_ref;
    need(doc && doc.revision === row.revision && text(ref) && !refs.has(ref) && typeof row.text === 'string' && typeof row.contextualized_text === 'string', 'NATIVE_ARTIFACT_PLAN_BINDING_CHANGED');
    need(strings(row.source_block_refs).every(ref => doc.blocks.some(b => b.block_id === ref)), 'NATIVE_ARTIFACT_PLAN_BINDING_CHANGED');
    refs.add(ref);
  }
  const chunks = new Map(plan.chunks.map(c => [c.chunk_ref, c]));
  need(plan.windows.every(w => strings(w.source_chunk_refs).every(ref => chunks.get(ref)?.doc_ref === w.doc_ref && chunks.get(ref)?.revision === w.revision)), 'NATIVE_ARTIFACT_PLAN_BINDING_CHANGED');
  return plan;
}

/** Follow only saved lineage pointers; an absent plan remains absent. */
function retainedPlan(store, source, libraryId, runId) {
  const seen = new Set();
  let current = runId;
  while (current) {
    need(!seen.has(current) && seen.size < 32, 'NATIVE_ARTIFACT_LINEAGE_CYCLE');
    seen.add(current);
    if (current !== runId && !store.getRecord('native_product_run_v1', current)) return {plan: null, origin_run_id: null, reason: 'NATIVE_ARTIFACT_LINEAGE_NOT_SAVED'};
    const {row, state} = checkedRun(store, libraryId, current, source.snapshot_id);
    need(row.source_epoch === source.source_epoch && (!state?.input?.source_fingerprint || state.input.source_fingerprint === source.fingerprint), 'NATIVE_ARTIFACT_RUN_BINDING_CHANGED');
    if (state?.proposal_rebuild_plan) return {plan: checkedPlan(state.proposal_rebuild_plan, source), origin_run_id: current};
    const saved = store.getRecord('native_chunked_cq_plan_v1', current);
    if (saved) {
      const {record_sha256, ...body} = saved;
      need(record_sha256 === hash(body) && saved.run_id === current && saved.source_snapshot_ref === source.snapshot_id, 'NATIVE_ARTIFACT_PLAN_BINDING_CHANGED');
      return {plan: checkedPlan(saved.plan, source), origin_run_id: current};
    }
    const declared = [row.reuse_cq_drafts_from_run_id, row.reuse_cq_from_run_id, row.reuse_cq_family_from_run_id, row.rebuild_saved_proposals_from_run_id, row.reuse_semantic_from_run_id, row.reuse_organization_draft_from_run_id].filter(text);
    if (state?.upstream_origin?.run_id) need(declared.includes(state.upstream_origin.run_id), 'NATIVE_ARTIFACT_LINEAGE_BINDING_CHANGED');
    // Follow the persisted reuse edge, rather than trusting a shortcut to an unrelated CQ run.
    current = state?.upstream_origin?.run_id ?? declared[0] ?? null;
  }
  return {plan: null, origin_run_id: null};
}

function retainedWindows(store, runId, source, plan) {
  const queue = store.getRecord('native_extraction_window_queue_v1', runId);
  if (!queue) return {windows: plan?.windows ?? null, origin: plan ? 'SAVED_HYBRID_PLAN' : null};
  need(queue.run_id === runId && text(queue.manifest_ref), 'NATIVE_ARTIFACT_WINDOW_BINDING_CHANGED');
  const saved = store.getRecord('native_extraction_window_manifest_v1', queue.manifest_ref);
  if (!saved) return {windows: null, origin: null};
  const {record_sha256, ...body} = saved, manifest = saved.manifest;
  need(record_sha256 === hash(body) && saved.run_id === runId && saved.queue_binding === queue.binding && saved.manifest_sha256 === queue.manifest_sha256 && hash(manifest) === queue.manifest_sha256 && manifest?.source_snapshot_ref === source.snapshot_id && manifest.source_fingerprint === source.fingerprint && Array.isArray(manifest.windows), 'NATIVE_ARTIFACT_WINDOW_BINDING_CHANGED');
  for (const w of manifest.windows) {
    const doc = source.documents.find(d => d.doc_id === w.doc_ref);
    need(doc && doc.revision === w.revision && text(w.window_ref) && typeof w.text === 'string', 'NATIVE_ARTIFACT_WINDOW_BINDING_CHANGED');
    if (w.source_snapshot_ref) need(w.source_snapshot_ref === source.snapshot_id, 'NATIVE_ARTIFACT_WINDOW_BINDING_CHANGED');
    if (plan && manifest.hybrid_plan_sha256) need(manifest.hybrid_plan_sha256 === plan.plan_sha256 && manifest.hybrid_plan_ref === plan.plan_ref, 'NATIVE_ARTIFACT_WINDOW_BINDING_CHANGED');
    if (plan) {
      const original = plan.windows.find(p => p.window_ref === w.window_ref);
      need(original && original.doc_ref === w.doc_ref && original.revision === w.revision && original.text === w.text && hash(original.source_chunk_refs) === hash(w.source_chunk_refs), 'NATIVE_ARTIFACT_WINDOW_BINDING_CHANGED');
    }
  }
  return {windows: manifest.windows, origin: 'SAVED_EXTRACTION_MANIFEST'};
}

function chunkItem(row, kind, source, plan) {
  const ref = kind === 'windows' ? row.window_ref : row.chunk_ref;
  const doc = source.documents.find(d => d.doc_id === row.doc_ref);
  const children = kind === 'windows' ? (plan?.chunks ?? []).filter(c => strings(row.source_chunk_refs).includes(c.chunk_ref)) : [];
  return {
    id: ref, ref, ...(kind === 'windows' ? {window_ref: ref} : {chunk_ref: ref}),
    source_snapshot_ref: source.snapshot_id, doc_ref: row.doc_ref, revision: row.revision,
    title: typeof row.title === 'string' ? row.title : doc.title, document_id: doc.parser?.document_id ?? null,
    ordinal: count(row.ordinal), text: row.text,
    contextualized_text: typeof row.contextualized_text === 'string' ? row.contextualized_text : row.text,
    headings: [...new Set([...strings(row.headings), ...children.flatMap(c => strings(c.headings))])],
    token_count: count(row.token_count ?? row.estimated_tokens), token_budget: count(row.token_budget), tokenizer: typeof row.tokenizer === 'string' ? row.tokenizer : null,
    ...(Array.isArray(row.units)?{units:row.units.filter(object).map(u=>({...pick(u,['label','ordinal','unit_ref','text','text_sha256','context','block_id','fragment']),headings:strings(u.headings),source_items:(Array.isArray(u.source_items)?u.source_items:[]).filter(object).map(i=>({...pick(i,['self_ref','role','label']),parent_refs:strings(i.parent_refs),provenance:provenance(i.provenance)}))}))}:{}),
    ...pick(row, ['token_count_exact', 'serialization_status', 'source_mapping', 'material_format', 'status','manifest_ref','plan_ref','core_text_tokens','context_tokens','material_sha256']),
    source_block_refs: strings(row.source_block_refs), source_chunk_refs: kind === 'windows' ? strings(row.source_chunk_refs) : [ref],
    source_items: (Array.isArray(row.source_items) ? row.source_items : []).filter(object).map(s => ({...pick(s, ['self_ref', 'label', 'role']), parent_refs: strings(s.parent_refs), provenance: provenance(s.provenance)})),
    warnings: strings(row.warnings)
  };
}

/** Historical input inspection does not require the frozen snapshot to still be current. */
export function readNativeBuildArtifacts({store, catalog, libraryId, runId, kind, after = 0, limit = 40, docRef = null, ref = null}) {
  need(NATIVE_ARTIFACT_KINDS.includes(kind), 'NATIVE_ARTIFACT_KIND_INVALID', 400);
  need(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= NATIVE_ARTIFACT_PAGE_LIMIT, 'NATIVE_ARTIFACT_PAGE_INVALID', 400);
  need((docRef === null || text(docRef) && docRef.length <= 512) && (ref === null || text(ref) && ref.length <= 1024), 'NATIVE_ARTIFACT_SELECTION_INVALID', 400);
  const {row, state} = checkedRun(store, libraryId, runId), snapshotId = row.snapshot_id;
  const base = {run_id: runId, source_snapshot_ref: snapshotId, kind, items: [], summary: null, policy: null, has_more: false, next_after: null, read_only: true};
  // Consult the frozen record first so absence can be reported without rebuilding it.
  if (!store.getRecord('cq_v2_snapshot', snapshotId)) return {...base, available: false, reason: 'NATIVE_ARTIFACT_SNAPSHOT_NOT_SAVED'};
  const source = catalog.get(snapshotId, libraryId);
  need(object(source), 'NATIVE_ARTIFACT_SNAPSHOT_BINDING_CHANGED');
  const {snapshot_id, fingerprint, ...body} = source;
  need(snapshot_id === snapshotId && source.library_id === libraryId && fingerprint === hash(body) && snapshot_id === 'snapshot_' + fingerprint && Array.isArray(source.documents) && source.documents.every(d => object(d) && text(d.doc_id) && text(d.revision) && typeof d.content === 'string' && Array.isArray(d.blocks)), 'NATIVE_ARTIFACT_SNAPSHOT_BINDING_CHANGED');
  need(row.source_epoch === source.source_epoch && (!state?.input?.source_fingerprint || state.input.source_fingerprint === fingerprint), 'NATIVE_ARTIFACT_RUN_BINDING_CHANGED');
  if (docRef) need(source.documents.some(d => d.doc_id === docRef), 'NATIVE_ARTIFACT_DOCUMENT_NOT_FOUND', 404);
  let plan = null, originRunId = null, windows = null, origin = 'FROZEN_SOURCE_SNAPSHOT', missingReason = null;
  if (['chunks', 'windows'].includes(kind)) {
    ({plan, origin_run_id: originRunId, reason: missingReason} = retainedPlan(store, source, libraryId, runId));
    if (plan && state?.chunk_plan_summary?.plan_ref) need(state.chunk_plan_summary.plan_ref === plan.plan_ref, 'NATIVE_ARTIFACT_PLAN_BINDING_CHANGED');
    if (kind === 'windows') ({windows, origin} = retainedWindows(store, runId, source, plan));
    else origin = plan ? 'SAVED_HYBRID_PLAN' : null;
  }
  const summary = {...pick(plan?.summary, summaryFields), documents: source.documents.length, source_blocks: source.documents.reduce((n, d) => n + d.blocks.length, 0)};
  const policy = plan ? {...pick(plan.policy, policyFields), warnings: strings(plan.warnings), semantic_completeness_certified: false} : null;
  if (kind === 'chunks' && !plan || kind === 'windows' && !windows) return {...base, available: false, summary, policy, reason: missingReason ?? 'NATIVE_ARTIFACT_NOT_SAVED'};
  const selectedDocs = source.documents.filter(d => !docRef || d.doc_id === docRef);
  let items;
  if (kind === 'documents') items = selectedDocs.map(d => ({id: d.doc_id, ref: d.doc_id, doc_ref: d.doc_id, revision: d.revision, title: d.title, document_id: d.parser?.document_id ?? null, source_snapshot_ref: snapshotId, parser: d.parser ? pick(d.parser, ['name', 'version', 'document_id', 'original_sha256', 'parsed_sha256']) : null, format: d.format, parse_status: d.parse_status, text: d.content, char_count: d.content.length, block_count: d.blocks.length, warnings: strings(d.warnings)}));
  else if (kind === 'blocks') items = selectedDocs.flatMap(d => d.blocks.map(b => {
    need(Number.isSafeInteger(b.start) && Number.isSafeInteger(b.end) && b.start >= 0 && b.end >= b.start && b.end <= d.content.length, 'NATIVE_ARTIFACT_BLOCK_BINDING_CHANGED');
    const itemRef = d.doc_id + ':' + b.block_id;
    return {id: itemRef, ref: itemRef, block_id: b.block_id, doc_ref: d.doc_id, revision: d.revision, title: d.title, document_id: d.parser?.document_id ?? null, source_snapshot_ref: snapshotId, ...pick(b, ['kind', 'start', 'end']), text: d.content.slice(b.start, b.end), offset_unit: 'utf16_code_unit', provenance: provenance(b.provenance)};
  }));
  else items = (kind === 'chunks' ? plan.chunks : windows).filter(r => !docRef || r.doc_ref === docRef).map(r => chunkItem(r, kind, source, plan));
  if (ref) {
    items = items.filter(i => i.ref === ref || i.block_id === ref);
    need(items.length <= 1, 'NATIVE_ARTIFACT_REF_AMBIGUOUS', 400);
    if (!items.length) return {...base, available: false, summary, policy, reason: 'NATIVE_ARTIFACT_REF_NOT_FOUND'};
  }
  need(after <= items.length, 'NATIVE_ARTIFACT_PAGE_INVALID', 400);
  const end = Math.min(items.length, after + limit);
  return {...base, available: true, artifact_origin: origin, ...(originRunId ? {origin_run_id: originRunId} : {}), items: items.slice(after, end), summary: {...summary, total_items: items.length, returned_items: end - after}, policy, has_more: end < items.length, next_after: end < items.length ? end : null};
}
