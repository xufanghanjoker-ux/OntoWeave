/** S0 candidate copy. Production and earlier frozen candidate unchanged. */
/** Shared browser/MCP facade. Raw content has one authority: MEMORY_RECORD_V1 in this db. */
import {createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {createMemoryRecordCore} from './native-memory-record-core-v1.mjs';
import {createMemoryProcessing} from './native-memory-processing-v1.mjs';
import {unknownMemoryProcessingQuality} from './native-memory-processing-quality-v1.mjs';
const fail = code => Object.assign(new Error(code), {code});
const need = (test, code) => {if (!test) throw fail(code);};
const text = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const allowed = (args, keys) => need(args && typeof args === 'object' && !Array.isArray(args)
  && Object.keys(args).every(key => keys.includes(key)), 'MEMORY_INPUT_FIELD_INVALID');
const bodyKeys = ['auth', 'library_id', 'request_id', 'text', 'valid_time'];

export function createMemoryProductService({db, authorize, processing = null, publication = null, searchPort = null, temporalPort = null,
  clock = () => new Date().toISOString(), cursorSecret = randomBytes(32), notifyEnqueued = null}) {
  need(db && typeof authorize === 'function', 'MEMORY_PRODUCT_HOST_REQUIRED');
  need(notifyEnqueued === null || typeof notifyEnqueued === 'function', 'MEMORY_ENQUEUE_NOTIFICATION_INVALID');
  need(!searchPort || (searchPort.mode === 'DIRECT_KNOWLEDGE' && typeof searchPort.search === 'function'
    && typeof searchPort.assertCurrent === 'function'), 'MEMORY_DIRECT_SEARCH_PORT_REQUIRED');
  need(temporalPort === null || ['listCandidates', 'readFacts', 'publishChange']
    .every(method => typeof temporalPort?.[method] === 'function'), 'MEMORY_TEMPORAL_PORT_INVALID');
  const cores = new Map();
  const coreForLibrary = libraryId => {
    if (!cores.has(libraryId)) cores.set(libraryId, createMemoryRecordCore({db, libraryId, clock}));
    return cores.get(libraryId);
  };
  const runner = processing ?? createMemoryProcessing({db, coreForLibrary, publication, clock});
  async function scope(args, action) {
    need(text(args.library_id), 'MEMORY_LIBRARY_REQUIRED');
    const principal = await authorize(args.auth, {library_id: args.library_id, action});
    need(principal, 'MEMORY_UNAUTHENTICATED');
    need(principal.library_id === args.library_id && text(principal.principal_ref)
      && ['BROWSER', 'MCP', 'TRUSTED_TOOL'].includes(principal.channel), 'MEMORY_SCOPE_FORBIDDEN');
    need(Array.isArray(principal.permissions) && principal.permissions.includes(action), 'MEMORY_PERMISSION_DENIED');
    return principal;
  }
  function idempotency(args, principal) {
    need(typeof args.request_id === 'string' && /^[A-Za-z0-9_:\-]{1,128}$/.test(args.request_id), 'MEMORY_REQUEST_ID_REQUIRED');
    return {idempotency_key: 'product:' + hash([principal.principal_ref, args.request_id])};
  }
  function input(args, principal, target = null) {
    need(text(args.text) && args.text.length <= 100000 && Buffer.byteLength(args.text) <= 400000, 'MEMORY_TEXT_SIZE_INVALID');
    const sourceKind = {BROWSER: 'HUMAN_TEXT', MCP: 'AGENT_REPORT', TRUSTED_TOOL: 'TOOL_RECEIPT'}[principal.channel];
    const result = {text: args.text, source: {kind: sourceKind, metadata: {reporter: principal.principal_ref,
      product_request_id: args.request_id, input_kind: 'RAW_RECORD',
      ...(target ? {related_record_ref: target.record_ref, relation_basis: 'EXPLICIT_CALLER_TARGET'} : {})}}};
    if (args.valid_time !== undefined) {
      need(Buffer.byteLength(JSON.stringify(args.valid_time)) <= 16384, 'MEMORY_VALID_TIME_SIZE_INVALID');
      result.valid_time = clone(args.valid_time);
    }
    if (args.context_refs !== undefined) {
      need(Array.isArray(args.context_refs) && args.context_refs.length <= 50 && args.context_refs.every(ref => text(ref) && ref.length <= 256), 'MEMORY_CONTEXT_REFS_INVALID');
      result.context_refs = clone(args.context_refs);
    }
    return result;
  }
  function publicationFor(libraryId, recordRef) {
    return publication?.getForRecord({library_id: libraryId, record_ref: recordRef}) ?? {state: 'NOT_PUBLISHED', queryable: false};
  }
  function dto(libraryId, recordRef) {
    const raw = coreForLibrary(libraryId).getRawRecord(recordRef);
    const {status, ...record} = raw;
    const job = runner.get({library_id: libraryId, record_ref: recordRef});
    const quality=job?.quality??unknownMemoryProcessingQuality('MEMORY_PROCESSING_QUALITY_UNAVAILABLE');
    return {schema_version: 'MEMORY_PRODUCT_V1', library_id: libraryId, record,
      processing: {state: job?.state ?? status.processing_state, mode: job?.mode ?? runner.mode,
        job_ref: job?.job_ref ?? null, runtime_ref: job?.runtime_receipt?.run_id ?? job?.runtime_failure_ref ?? null,
        error_code: job?.error_code ?? null, gaps: job?.gaps ?? [],
        flow_state:job?.state??status.processing_state,content_state:quality.content_state,partial:quality.partial,
        retained_count:quality.retained_count,retained_reason_counts:clone(quality.retained_reason_counts),quality:clone(quality)},
      publication: {...publicationFor(libraryId, recordRef), recorded_from: status.recorded_from,
        historical_status: 'UNAVAILABLE_IN_MEMORY_PRODUCT_V1'}};
  }
  async function writeResult(args, principal, receipt, operation, target = null) {
    let enqueueError = null;
    try {
      const job = runner.enqueue({library_id: args.library_id, record_ref: receipt.record_ref,
        request_id: args.request_id, operation, target_record_ref: target?.record_ref ?? null});
      if (notifyEnqueued && ['QUEUED', 'WAITING_PROCESSOR', 'WAITING_MODEL'].includes(job.state)) notifyEnqueued(clone(job));
    }
    catch (cause) {enqueueError = typeof cause.code === 'string' ? cause.code : 'MEMORY_ENQUEUE_FAILED';}
    const result = {...dto(args.library_id, receipt.record_ref), request_id: args.request_id,
      raw_saved: true, replayed: receipt.replayed};
    if (enqueueError) result.processing = {...result.processing, state: 'ENQUEUE_FAILED', error_code: enqueueError};
    return result;
  }
  async function saveRecord(args) {
    allowed(args, [...bodyKeys, 'context_refs']);
    const principal = await scope(args, 'write');
    const receipt = coreForLibrary(args.library_id).saveRecord(input(args, principal), idempotency(args, principal));
    return writeResult(args, principal, receipt, 'SAVE');
  }
  async function appendResult(args) {
    allowed(args, [...bodyKeys, 'record_ref']);
    const principal = await scope(args, 'write');
    const core = coreForLibrary(args.library_id), target = core.getRawRecord(args.record_ref);
    const receipt = core.appendRecord(input(args, principal, target), {...idempotency(args, principal),
      relation_kind: 'SUPPLEMENT', related_logical_refs: [target.logical_ref]});
    return writeResult(args, principal, receipt, 'RESULT', target);
  }
  async function correctRecord(args) {
    allowed(args, [...bodyKeys, 'record_ref', 'reason']);
    const principal = await scope(args, 'write');
    need(text(args.reason) && args.reason.length <= 4000, 'MEMORY_CORRECTION_REASON_REQUIRED');
    const core = coreForLibrary(args.library_id), target = core.getRawRecord(args.record_ref);
    const receipt = core.correctRecord({logical_ref: target.logical_ref, expected_record_ref: target.record_ref,
      reason: args.reason, record: input(args, principal, target)}, idempotency(args, principal));
    return writeResult(args, principal, receipt, 'CORRECTION', target);
  }
  async function readRecord(args) {
    allowed(args, ['auth', 'library_id', 'record_ref']); await scope(args, 'read');
    need(text(args.record_ref), 'MEMORY_RECORD_REF_REQUIRED');
    return dto(args.library_id, args.record_ref);
  }
  async function getStatus(args) {
    const result = await readRecord(args);
    return {schema_version: result.schema_version, library_id: result.library_id, record_ref: result.record.record_ref,
      logical_ref: result.record.logical_ref, raw_saved: true, processing: result.processing, publication: result.publication};
  }
  function sign(payload) {
    const bytes = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return bytes + '.' + createHmac('sha256', cursorSecret).update(bytes).digest('base64url');
  }
  function unsign(cursor) {
    need(typeof cursor === 'string' && cursor.length <= 2048, 'MEMORY_CURSOR_INVALID');
    const [bytes, signature, extra] = cursor.split('.');
    const expected = createHmac('sha256', cursorSecret).update(bytes ?? '').digest('base64url');
    need(!extra && signature?.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected)), 'MEMORY_CURSOR_INVALID');
    try {return JSON.parse(Buffer.from(bytes, 'base64url').toString());} catch {throw fail('MEMORY_CURSOR_INVALID');}
  }
  const pageSize = (value, fallback) => {const size = value ?? fallback; need(Number.isSafeInteger(size) && size >= 1 && size <= 50, 'MEMORY_PAGE_SIZE_INVALID'); return size;};
  async function listRecords(args) {
    allowed(args, ['auth', 'library_id', 'page_size', 'cursor']); const principal = await scope(args, 'read');
    const size = pageSize(args.page_size, 20); coreForLibrary(args.library_id);
    const current = args.cursor ? unsign(args.cursor) : {library_id: args.library_id, principal_ref: principal.principal_ref,
      upper: db.prepare('SELECT COALESCE(max(rowid),0) AS upper FROM memory_record_versions_v1 WHERE library_id=?').get(args.library_id).upper, before: Number.MAX_SAFE_INTEGER};
    need(current.library_id === args.library_id && current.principal_ref === principal.principal_ref
      && Number.isSafeInteger(current.upper) && Number.isSafeInteger(current.before), 'MEMORY_CURSOR_SCOPE_MISMATCH');
    const rows = db.prepare(`SELECT v.rowid AS seq,v.record_ref FROM memory_record_versions_v1 v
      WHERE v.library_id=? AND v.rowid<=? AND v.rowid<?
      AND COALESCE(json_extract(v.payload,'$.source.metadata.derivation'),'')!='ORGANIZED_DRAFT'
      AND NOT EXISTS(SELECT 1 FROM memory_record_versions_v1 n WHERE n.library_id=v.library_id
        AND n.logical_ref=v.logical_ref AND n.version>v.version AND n.rowid<=?)
      ORDER BY v.rowid DESC LIMIT ?`).all(args.library_id, current.upper, current.before, current.upper, size + 1);
    const items = rows.slice(0, size).map(row => {
      const value = dto(args.library_id, row.record_ref), record = value.record;
      return {...value, record: {record_ref: record.record_ref, logical_ref: record.logical_ref, version: record.version,
        text: record.text.slice(0, 1000), text_truncated: record.text.length > 1000, text_characters: record.text.length,
        source: record.source, origin: record.origin, relation: record.relation, supersedes: record.supersedes,
        source_ingested_at: record.source_ingested_at, valid_time: record.valid_time}};
    });
    return {schema_version: 'MEMORY_PRODUCT_LIST_V1', library_id: args.library_id, items, page_size: size,
      next_cursor: rows.length > size ? sign({...current, before: rows[size - 1].seq}) : null};
  }
  function view(libraryId) {
    if (!publication) return null;
    try {return publication.assertQueryable({library_id: libraryId});}
    catch (cause) {if (cause.code === 'MEMORY_PUBLICATION_NOT_READY') return null; throw cause;}
  }
  async function search(args) {
    allowed(args, ['auth', 'library_id', 'query', 'page_size', 'cursor']); await scope(args, 'search');
    need(text(args.query) && args.query.length <= 4000, 'MEMORY_SEARCH_QUERY_INVALID');
    const size = pageSize(args.page_size, 10); need(searchPort, 'MEMORY_SEARCH_UNAVAILABLE');
    const pinned = view(args.library_id);
    const result = await searchPort.search({library_id: args.library_id, query: args.query, page_size: size,
      cursor: args.cursor ?? null, view: pinned});
    need(result && Array.isArray(result.items) && result.items.length <= size && result.view?.library_id === args.library_id
      && (result.library_id === undefined || result.library_id === args.library_id), 'MEMORY_SEARCH_PORT_RESULT_INVALID');
    if (pinned) need(result.view.commit_ref === pinned.commit_ref && result.view.confirmation_ref === pinned.confirmation_ref
      && ['knowledge_revision_ref', 'graph_revision_ref', 'source_index_revision', 'knowledge_index_revision']
        .every(key => result.view.bindings?.[key] === pinned.bindings?.[key]), 'MEMORY_SEARCH_PIN_MISMATCH');
    await searchPort.assertCurrent({library_id: args.library_id, view: result.view});
    need(hash(view(args.library_id)) === hash(pinned), 'MEMORY_SEARCH_VIEW_CHANGED');
    need(Buffer.byteLength(JSON.stringify(result)) <= 131072, 'MEMORY_SEARCH_RESULT_TOO_LARGE');
    return {...clone(result), schema_version: 'MEMORY_PRODUCT_SEARCH_V1', library_id: args.library_id,
      execution: {mode: 'DIRECT_KNOWLEDGE', answer_model_called: false, absence_proven: false}};
  }
  async function temporalPrincipal(args, action) {
    const principal = await scope(args, action);
    need(principal.channel === 'BROWSER', 'MEMORY_TEMPORAL_BROWSER_SCOPE_FORBIDDEN');
    need(temporalPort, 'MEMORY_TEMPORAL_UNAVAILABLE');
    return principal;
  }
  async function listTemporalCandidates(args) {
    allowed(args, ['auth', 'library_id', 'run_id', 'revision_ref']);
    const principal = await temporalPrincipal(args, 'read'), {auth, ...fields} = args;
    return temporalPort.listCandidates({...fields, principal});
  }
  async function readTemporalFacts(args) {
    allowed(args, ['auth', 'library_id', 'at', 'as_of', 'view_ref']);
    const principal = await temporalPrincipal(args, 'read'), {auth, ...fields} = args;
    return temporalPort.readFacts({...fields, principal});
  }
  async function publishTemporalChange(args) {
    allowed(args, ['auth', 'library_id', 'request_id', 'operation', 'knowledge_ref', 'revision_ref', 'run_id',
      'fact_ref', 'text', 'value', 'valid_time', 'reason', 'single_valued', 'conditions']);
    const principal = await temporalPrincipal(args, 'write'), {auth, ...fields} = args;
    return temporalPort.publishChange({...fields, principal});
  }
  return Object.freeze({saveRecord, appendResult, correctRecord, readRecord, getStatus, listRecords, search,
    listTemporalCandidates, readTemporalFacts, publishTemporalChange,
    processing: runner, readiness: () => ({processing_mode: runner.mode,
      direct_search: !!searchPort, production_mount_ready: runner.mode === 'NATIVE_CODEX' && runner.isReady?.() !== false
        && !!searchPort && publication?.mode === 'NATIVE_PRODUCT'})});
}
