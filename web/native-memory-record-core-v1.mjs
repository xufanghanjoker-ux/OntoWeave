/** OFFLINE CANDIDATE COPY; production remains unchanged. */
/** Unified immutable raw records and RECORD_ONLY publication. No graph/index writer. */
import {createHash, randomUUID} from 'node:crypto';
import {normalizeValidTime, matchValidTime} from './native-temporal-value-v1.mjs';

const schema = 'MEMORY_RECORD_V1';
const sources = new Set(['DOCUMENT', 'HUMAN_TEXT', 'AGENT_REPORT', 'TOOL_RECEIPT']);
const relations = new Set(['NEW_OBSERVATION', 'REALITY_CHANGE', 'CONFLICT', 'SUPPLEMENT']);
const ready = new Set(['READY', 'PARTIALLY_READY']);
const transitions = {
  RECEIVED: ['QUEUED', 'PROCESSING', 'READY', 'PARTIALLY_READY', 'FAILED', 'UNKNOWN'],
  QUEUED: ['PROCESSING', 'READY', 'PARTIALLY_READY', 'FAILED', 'UNKNOWN'],
  PROCESSING: ['READY', 'PARTIALLY_READY', 'FAILED', 'UNKNOWN'],
  READY: ['QUEUED', 'PROCESSING', 'FAILED', 'UNKNOWN'],
  PARTIALLY_READY: ['QUEUED', 'PROCESSING', 'READY', 'FAILED', 'UNKNOWN'],
  FAILED: ['QUEUED', 'PROCESSING', 'READY', 'PARTIALLY_READY', 'UNKNOWN'],
  UNKNOWN: ['QUEUED', 'PROCESSING', 'READY', 'PARTIALLY_READY', 'FAILED'],
};
const bindingKeys = ['source_manifest_ref', 'identity_revision_ref', 'ontology_revision_ref',
  'graph_revision_ref', 'source_index_revision', 'knowledge_index_revision'];
const error = (code, message = code) => Object.assign(new Error(message), {code});
const requireThat = (condition, code) => { if (!condition) throw error(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function string(value, name) {
  requireThat(typeof value === 'string' && value.trim().length > 0, `INVALID_${name}`);
  return value;
}
function keys(value, allowed, name) {
  requireThat(object(value), `INVALID_${name}`);
  requireThat(Object.keys(value).every(key => allowed.includes(key)), `UNEXPECTED_${name}_FIELD`);
}
// Stable JSON for idempotency: key order is not a semantic content change.
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  requireThat(object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'INVALID_JSON');
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
const clone = value => JSON.parse(canonical(value));
const hash = value => createHash('sha256').update(value).digest('hex');
const id = prefix => prefix + '_' + randomUUID();
function instant(value, name) {
  if (value instanceof Date) value = value.toISOString();
  requireThat(typeof value === 'string' && /T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value)), `INVALID_${name}`);
  return new Date(value).toISOString();
}
function refs(value, name) {
  requireThat(Array.isArray(value) && value.every(ref => typeof ref === 'string' && ref.trim()), `INVALID_${name}`);
  requireThat(new Set(value).size === value.length, `DUPLICATE_${name}`);
  return [...value];
}

/** Owns synchronous transactions. Pass the existing store.db only at an assigned integration window. */
export function createMemoryRecordCore({db, libraryId, clock = () => new Date().toISOString()}) {
  string(libraryId, 'LIBRARY_ID');
  requireThat(db && typeof db.prepare === 'function', 'INVALID_DATABASE');
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_record_versions_v1 (
      library_id TEXT NOT NULL, record_ref TEXT NOT NULL, logical_ref TEXT NOT NULL,
      version INTEGER NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(library_id,record_ref), UNIQUE(library_id,logical_ref,version));
    CREATE TABLE IF NOT EXISTS memory_record_events_v1 (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, library_id TEXT NOT NULL,
      event_ref TEXT NOT NULL UNIQUE, record_ref TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS memory_record_events_lookup_v1
      ON memory_record_events_v1(library_id,record_ref,seq);
    CREATE TABLE IF NOT EXISTS memory_record_commits_v1 (
      library_id TEXT NOT NULL, commit_ref TEXT NOT NULL, commit_seq INTEGER NOT NULL,
      published_at TEXT, payload TEXT NOT NULL,
      PRIMARY KEY(library_id,commit_ref), UNIQUE(library_id,commit_seq));
    CREATE TABLE IF NOT EXISTS memory_record_heads_v1 (
      library_id TEXT PRIMARY KEY, commit_ref TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_record_replays_v1 (
      library_id TEXT NOT NULL, replay_key TEXT NOT NULL, operation TEXT NOT NULL,
      request_hash TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(library_id,replay_key));
    CREATE TABLE IF NOT EXISTS memory_record_publish_attempts_v1 (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, library_id TEXT NOT NULL, payload TEXT NOT NULL);
  `);
  const now = () => instant(clock(), 'CLOCK');
  const decode = row => row ? JSON.parse(row.payload) : null;
  const raw = ref => decode(db.prepare('SELECT payload FROM memory_record_versions_v1 WHERE library_id=? AND record_ref=?').get(libraryId, ref));
  const latest = ref => decode(db.prepare('SELECT payload FROM memory_record_versions_v1 WHERE library_id=? AND logical_ref=? ORDER BY version DESC LIMIT 1').get(libraryId, ref));
  const events = ref => db.prepare('SELECT payload FROM memory_record_events_v1 WHERE library_id=? AND record_ref=? ORDER BY seq').all(libraryId, ref).map(decode);
  const lastEvent = ref => decode(db.prepare('SELECT payload FROM memory_record_events_v1 WHERE library_id=? AND record_ref=? ORDER BY seq DESC LIMIT 1').get(libraryId, ref));
  const commits = () => db.prepare('SELECT payload FROM memory_record_commits_v1 WHERE library_id=? ORDER BY commit_seq').all(libraryId).map(decode);
  const head = () => decode(db.prepare(`SELECT c.payload FROM memory_record_heads_v1 h JOIN memory_record_commits_v1 c
    ON c.library_id=h.library_id AND c.commit_ref=h.commit_ref WHERE h.library_id=?`).get(libraryId));
  const exactCommit = ref => decode(db.prepare('SELECT payload FROM memory_record_commits_v1 WHERE library_id=? AND commit_ref=?').get(libraryId, ref));
  function needed(ref) {
    string(ref, 'RECORD_REF');
    const record = raw(ref);
    requireThat(record, 'RECORD_NOT_FOUND');
    return record;
  }
  function addEvent(recordRef, state, at, detail = {}) {
    const event = {event_ref: id('mevt'), record_ref: recordRef, state, occurred_at: at, ...clone(detail)};
    db.prepare('INSERT INTO memory_record_events_v1(library_id,event_ref,record_ref,payload) VALUES(?,?,?,?)')
      .run(libraryId, event.event_ref, recordRef, canonical(event));
    return event;
  }
  function transaction(fn) {
    // No nested fallback: joining an unknown outer transaction would allow a false success receipt.
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (cause) {
      try { db.exec('ROLLBACK'); cause.memory_record_rolled_back = true; } catch { /* original error retained */ }
      throw cause;
    }
  }
  function writeInTransaction(operation, request, host, fn) {
    requireThat(db.isTransaction === true, 'CALLER_TRANSACTION_REQUIRED');
    keys(host, ['idempotency_key'], 'HOST');
    const key = string(host.idempotency_key, 'IDEMPOTENCY_KEY');
    const digest = hash(canonical(request));
    const old = db.prepare('SELECT * FROM memory_record_replays_v1 WHERE library_id=? AND replay_key=?').get(libraryId, key);
    if (old) {
      requireThat(old.operation === operation && old.request_hash === digest, 'IDEMPOTENCY_CONFLICT');
      return {...JSON.parse(old.receipt), replayed: true};
    }
    const receipt = {...fn(), replayed: false};
    db.prepare('INSERT INTO memory_record_replays_v1 VALUES(?,?,?,?,?)').run(libraryId, key, operation, digest, canonical(receipt));
    return receipt;
  }
  function write(operation, request, host, fn) {
    return transaction(() => writeInTransaction(operation, request, host, fn));
  }
  function normalizeInput(input) {
    keys(input, ['text', 'source', 'valid_time', 'content', 'subject_refs', 'context_refs', 'modality', 'uncertainties'], 'RECORD');
    string(input.text, 'TEXT');
    keys(input.source, ['kind', 'external_ref', 'revision', 'label', 'locator', 'metadata'], 'SOURCE');
    requireThat(sources.has(input.source.kind), 'INVALID_SOURCE_KIND');
    for (const key of ['external_ref', 'revision', 'label']) if (input.source[key] !== undefined) string(input.source[key], 'SOURCE_' + key.toUpperCase());
    const original = clone(input);
    let validTime;
    let timeError = null;
    try { validTime = normalizeValidTime(input.valid_time); }
    catch (cause) {
      timeError = String(cause.message);
      validTime = normalizeValidTime({kind: 'UNRESOLVED', time_text: typeof input.valid_time?.time_text === 'string' ? input.valid_time.time_text : null});
      validTime.gaps = [...new Set([...validTime.gaps, 'INVALID_VALID_TIME'])];
    }
    const content = input.content ?? {};
    requireThat(object(content), 'INVALID_CONTENT');
    requireThat(input.modality === undefined || typeof input.modality === 'string', 'INVALID_MODALITY');
    requireThat(input.uncertainties === undefined || Array.isArray(input.uncertainties), 'INVALID_UNCERTAINTIES');
    return {text: input.text, source: original.source,
      origin: input.source.kind === 'HUMAN_TEXT' ? 'HUMAN_ASSERTED' : 'SOURCE_REPORTED',
      valid_time: validTime, valid_time_input: original.valid_time ?? null, time_validation_error: timeError,
      content: clone(content), subject_refs: refs(input.subject_refs ?? [], 'SUBJECT_REFS'),
      context_refs: refs(input.context_refs ?? [], 'CONTEXT_REFS'), modality: input.modality ?? null,
      uncertainties: clone(input.uncertainties ?? [])};
  }
  function insertVersion(input, {logicalRef = id('mrec'), version = 1, supersedes = null,
    reason = null, revisionKind = 'INITIAL', relation = null, receivedAt = null} = {}) {
    const at = receivedAt ?? now();
    const record = {schema_version: schema, library_id: libraryId, logical_ref: logicalRef,
      record_ref: id('mver'), version, source_ingested_at: at, ...normalizeInput(input),
      supersedes, revision_reason: reason, revision_kind: revisionKind, relation};
    db.prepare('INSERT INTO memory_record_versions_v1 VALUES(?,?,?,?,?)')
      .run(libraryId, record.record_ref, logicalRef, version, canonical(record));
    addEvent(record.record_ref, 'RECEIVED', at);
    return {raw_saved: true, logical_ref: logicalRef, record_ref: record.record_ref, version,
      source_ingested_at: at, processing_state: 'RECEIVED', publication_state: 'UNPUBLISHED'};
  }
  function saveRecord(input, host) {
    return write('save', input, host, () => insertVersion(input));
  }
  function appendRecord(input, host) {
    keys(host, ['idempotency_key', 'relation_kind', 'related_logical_refs'], 'APPEND_HOST');
    const relationKind = host.relation_kind;
    const related = refs(host.related_logical_refs, 'RELATED_LOGICAL_REFS');
    requireThat(relations.has(relationKind) && related.length > 0, 'INVALID_RELATION');
    return write('append', {input, relation_kind: relationKind, related_logical_refs: related},
      {idempotency_key: host.idempotency_key}, () => {
        for (const ref of related) requireThat(latest(ref), 'RELATED_RECORD_NOT_FOUND');
        return insertVersion(input, {relation: {kind: relationKind, related_logical_refs: related}});
      });
  }
  function correctRecord(request, host) {
    keys(request, ['logical_ref', 'expected_record_ref', 'reason', 'revision_kind', 'record'], 'CORRECTION');
    string(request.reason, 'REVISION_REASON');
    string(request.logical_ref, 'LOGICAL_REF');
    const kind = request.revision_kind ?? 'CORRECTION';
    requireThat(['CORRECTION', 'VALID_TIME_REVISION'].includes(kind), 'INVALID_REVISION_KIND');
    return write('correct', request, host, () => {
      const old = latest(request.logical_ref);
      requireThat(old, 'RECORD_NOT_FOUND');
      requireThat(old.record_ref === request.expected_record_ref, 'STALE_RECORD_VERSION');
      const at = now();
      requireThat(at >= old.source_ingested_at, 'CLOCK_REGRESSION');
      return insertVersion(request.record, {logicalRef: old.logical_ref, version: old.version + 1,
        supersedes: old.record_ref, reason: request.reason, revisionKind: kind, relation: old.relation, receivedAt: at});
    });
  }
  function markProcessing(recordRef, update, host) {
    keys(update, ['state', 'detail', 'result_refs', 'gaps'], 'PROCESSING');
    return write('processing', {record_ref: recordRef, update}, host, () => {
      needed(recordRef);
      const previous = lastEvent(recordRef);
      requireThat(transitions[previous.state]?.includes(update.state), 'INVALID_PROCESSING_TRANSITION');
      const at = now();
      requireThat(at >= previous.occurred_at, 'CLOCK_REGRESSION');
      const event = addEvent(recordRef, update.state, at, {detail: clone(update.detail ?? null),
        result_refs: refs(update.result_refs ?? [], 'RESULT_REFS'), gaps: clone(update.gaps ?? [])});
      return {raw_saved: true, record_ref: recordRef, processing_state: update.state, event_ref: event.event_ref};
    });
  }
  function interval(recordRef, through = null) {
    const history = commits().filter(commit => !through || commit.commit_seq <= through.commit_seq);
    const first = history.findIndex(commit => commit.record_refs.includes(recordRef));
    if (first < 0) return {recorded_from: null, recorded_to: null, commit_ref: null, closed_by_commit_ref: null};
    const close = history.slice(first + 1).find(commit => !commit.record_refs.includes(recordRef));
    return {recorded_from: history[first].published_at, recorded_to: close?.published_at ?? null,
      commit_ref: history[first].commit_ref, closed_by_commit_ref: close?.commit_ref ?? null,
      publication_gaps: [history[first], close].filter(commit => commit?.publication_boundary === 'UNCONFIRMED_CALLER_COMMIT')
        .map(commit => 'UNCONFIRMED_PUBLICATION_BOUNDARY:' + commit.commit_ref)};
  }
  function getStatus(recordRef) {
    needed(recordRef);
    const history = events(recordRef);
    const publication = interval(recordRef);
    const attempts = publicationAttempts().filter(attempt => attempt.record_refs.includes(recordRef));
    return {raw_saved: true, record_ref: recordRef, processing_state: history.at(-1).state,
      processing_events: history, publication_state: !publication.commit_ref ? 'UNPUBLISHED'
        : publication.closed_by_commit_ref ? 'SUPERSEDED'
          : publication.recorded_from === null ? 'PUBLISHED_CURRENT_ONLY' : 'PUBLISHED', ...publication,
      publication_attempts: attempts, latest_publication_attempt: attempts.at(-1) ?? null};
  }
  const getRawRecord = recordRef => ({...needed(recordRef), status: getStatus(recordRef)});
  const getLatestRaw = logicalRef => {
    const record = latest(string(logicalRef, 'LOGICAL_REF'));
    return record ? getRawRecord(record.record_ref) : null;
  };
  function publicationAttempt(payload) {
    db.prepare('INSERT INTO memory_record_publish_attempts_v1(library_id,payload) VALUES(?,?)').run(libraryId, canonical(payload));
    return payload;
  }
  function publicationAttempts() {
    return db.prepare('SELECT payload FROM memory_record_publish_attempts_v1 WHERE library_id=? ORDER BY seq')
      .all(libraryId).map(decode);
  }
  function publicationReceiptInTransaction(request, host, {callerOwned = false, knowledgeView = false} = {}) {
      keys(request, ['record_refs', 'expected_commit_ref', 'bindings', ...(knowledgeView ? ['maintenance'] : [])], 'PUBLICATION');
      requireThat(Object.hasOwn(request, 'expected_commit_ref'), 'EXPECTED_COMMIT_REQUIRED');
      const patches = refs(request.record_refs, 'RECORD_REFS');
      requireThat(patches.length > 0, 'EMPTY_PUBLICATION');
      keys(request.bindings ?? {}, bindingKeys, 'BINDINGS');
      for (const ref of Object.values(request.bindings ?? {})) requireThat(ref === null || (typeof ref === 'string' && ref.trim()), 'INVALID_BINDING');
      return writeInTransaction(knowledgeView ? 'knowledge-view' : 'publish', request, host, () => {
        const oldHead = head();
        requireThat((oldHead?.commit_ref ?? null) === request.expected_commit_ref, 'STALE_COMMIT');
        if (knowledgeView) {
          const m = request.maintenance;
          keys(m, ['attempt_ref','source_processing_ref','source_publication_ref','semantic_manifest_sha256','replacement_manifest_sha256','expected_bindings'], 'MAINTENANCE');
          for (const key of ['attempt_ref','source_processing_ref','source_publication_ref','semantic_manifest_sha256','replacement_manifest_sha256']) string(m[key], 'MAINTENANCE_' + key.toUpperCase());
          requireThat(oldHead && canonical(oldHead.bindings) === canonical(m.expected_bindings), 'KNOWLEDGE_VIEW_BASIS_CHANGED');
          const chosen = Object.fromEntries(bindingKeys.map(key => [key, request.bindings?.[key] ?? null]));
          requireThat(canonical(chosen) !== canonical(oldHead.bindings), 'KNOWLEDGE_VIEW_NO_BINDING_CHANGE');
          requireThat(patches.every(ref => oldHead.record_refs.includes(ref)), 'KNOWLEDGE_VIEW_REQUIRES_CURRENT_RECORD');
        }
        const records = new Map((oldHead?.record_refs ?? []).map(ref => { const record = needed(ref); return [record.logical_ref, record]; }));
        const states = {...oldHead?.record_states};
        const changed = new Set();
        const at = now();
        requireThat(!oldHead || at >= (oldHead.published_at ?? oldHead.staged_at), 'CLOCK_REGRESSION');
        for (const ref of patches) {
          const record = needed(ref);
          requireThat(!changed.has(record.logical_ref), 'MULTIPLE_VERSIONS_IN_PUBLICATION');
          changed.add(record.logical_ref);
          requireThat(latest(record.logical_ref).record_ref === ref, 'STALE_RECORD_VERSION');
          const state = knowledgeView ? oldHead.record_states[ref] : lastEvent(ref);
          requireThat(ready.has(state.state), 'RECORD_NOT_READY');
          requireThat(at >= state.occurred_at && at >= record.source_ingested_at, 'CLOCK_REGRESSION');
          const current = records.get(record.logical_ref);
          if (knowledgeView) requireThat(current?.record_ref === ref && current.version === record.version, 'KNOWLEDGE_VIEW_RAW_SET_CHANGED');
          else {
            requireThat(!current || current.record_ref !== ref, 'NO_RECORD_CHANGE');
            requireThat(!current || current.version < record.version, 'VERSION_REGRESSION');
          }
          if (current) delete states[current.record_ref];
          records.set(record.logical_ref, record);
          states[ref] = state;
        }
        const selected = [...records.values()].sort((a, b) => a.logical_ref.localeCompare(b.logical_ref));
        const bindings = Object.fromEntries(bindingKeys.map(key => [key, request.bindings?.[key] ?? null]));
        const commit = {schema_version: 'MEMORY_RECORD_COMMIT_V1', library_id: libraryId,
          commit_ref: id('mcommit'), commit_seq: (oldHead?.commit_seq ?? 0) + 1,
          parent_commit_ref: oldHead?.commit_ref ?? null,
          published_at: callerOwned ? null : at, staged_at: callerOwned ? at : null,
          publication_boundary: callerOwned ? 'UNCONFIRMED_CALLER_COMMIT' : 'CORE_COMMIT', capability: 'RECORD_ONLY',
          record_refs: selected.map(record => record.record_ref), record_states: states,
          ...(knowledgeView ? {commit_kind: 'KNOWLEDGE_VIEW_ONLY', maintenance: clone(request.maintenance)} : {}),
          source_manifest: selected.map(record => ({record_ref: record.record_ref,
            source: record.source, text_sha256: hash(record.text)})), bindings,
          gaps: ['PRODUCT_GRAPH_INDEX_NOT_INTEGRATED', 'CURRENT_ACCESS_POLICY_REQUIRED_BY_CALLER',
            ...(callerOwned ? ['UNCONFIRMED_PUBLICATION_BOUNDARY'] : [])]};
        db.prepare('INSERT INTO memory_record_commits_v1 VALUES(?,?,?,?,?)')
          .run(libraryId, commit.commit_ref, commit.commit_seq, commit.published_at, canonical(commit));
        db.prepare(`INSERT INTO memory_record_heads_v1 VALUES(?,?)
          ON CONFLICT(library_id) DO UPDATE SET commit_ref=excluded.commit_ref`).run(libraryId, commit.commit_ref);
        publicationAttempt({attempt_ref: id('mpub'), state: 'SUCCEEDED', attempted_at: at,
          idempotency_key: host.idempotency_key, commit_ref: commit.commit_ref, record_refs: patches});
        return {raw_saved: true, published: true, capability: 'RECORD_ONLY', commit};
      });
  }
  /** Same validation/application as publish, but the sole coordinator owns the final COMMIT. */
  function applyPublicationParticipant(request, host, knowledgeView) {
    requireThat(db.isTransaction === true, 'CALLER_TRANSACTION_REQUIRED');
    const savepoint = 'memory_record_' + randomUUID().replaceAll('-', '');
    db.exec('SAVEPOINT ' + savepoint);
    try {
      const receipt = publicationReceiptInTransaction(request, host, {callerOwned: true, knowledgeView: knowledgeView});
      db.exec('RELEASE SAVEPOINT ' + savepoint);
      return {raw_saved: true, publication_staged: true, requires_outer_commit: true,
        capability: 'RECORD_ONLY', commit: receipt.commit, replayed: receipt.replayed};
    } catch (cause) {
      try {
        db.exec('ROLLBACK TO SAVEPOINT ' + savepoint);
        db.exec('RELEASE SAVEPOINT ' + savepoint);
        cause.memory_record_participant_rolled_back = true;
      } catch { /* the coordinator must roll back the entire transaction */ }
      throw cause;
    }
  }
  const applyPublicationInTransaction = (request, host) => applyPublicationParticipant(request, host, false);
  const applyKnowledgeViewInTransaction = (request, host) => applyPublicationParticipant(request, host, true);
  /** Call only after the coordinator rolled back its outer transaction. This is not a publish. */
  function recordPublicationFailure(request, host = {}) {
    requireThat(db.isTransaction === false, 'FAILURE_AUDIT_REQUIRES_ROLLBACK');
    keys(request, ['record_refs', 'error_code'], 'FAILURE_AUDIT');
    keys(host, ['idempotency_key'], 'HOST');
    const recordRefs = refs(request.record_refs, 'RECORD_REFS');
    const code = string(request.error_code, 'ERROR_CODE');
    if (host.idempotency_key !== undefined) string(host.idempotency_key, 'IDEMPOTENCY_KEY');
    return transaction(() => ({failure_audit_saved: true, attempt: publicationAttempt({attempt_ref: id('mpub'),
      state: 'FAILED', attempted_at: now(), idempotency_key: host.idempotency_key ?? null,
      record_refs: recordRefs, error_code: code})}));
  }
  function publish(request, host) {
    try {
      return transaction(() => publicationReceiptInTransaction(request, host));
    } catch (cause) {
      // Persist failure outside the rolled-back publication; never join an unknown outer transaction.
      if (cause.memory_record_rolled_back) {
        try {
          recordPublicationFailure({record_refs: [...new Set(Array.isArray(request?.record_refs)
            ? request.record_refs.filter(ref => typeof ref === 'string' && ref.trim()) : [])],
            error_code: typeof cause.code === 'string' ? cause.code : 'PUBLICATION_FAILED'},
          typeof host?.idempotency_key === 'string' ? {idempotency_key: host.idempotency_key} : {});
          cause.failure_audit_persisted = true;
        } catch { cause.failure_audit_persisted = false; }
      }
      throw cause;
    }
  }
  function cutoff(asOf) {
    const requestTime = now();
    const at = asOf === undefined ? requestTime : instant(asOf, 'AS_OF');
    requireThat(at <= requestTime, 'FUTURE_AS_OF');
    return at;
  }
  function assertHistoricalBoundary(asOf) {
    // An outer COMMIT cannot be timestamped by this participant. Never backdate visibility to staging.
    requireThat(!commits().some(commit => commit.publication_boundary === 'UNCONFIRMED_CALLER_COMMIT'
      && commit.staged_at <= asOf), 'UNCONFIRMED_PUBLICATION_BOUNDARY');
  }
  function selectRecords({as_of, at} = {}) {
    const asOf = cutoff(as_of);
    if (as_of !== undefined) assertHistoricalBoundary(asOf);
    const commit = as_of === undefined ? head() : decode(db.prepare(`SELECT payload FROM memory_record_commits_v1
      WHERE library_id=? AND published_at<=? ORDER BY commit_seq DESC LIMIT 1`).get(libraryId, asOf));
    requireThat(!commit || (commit.published_at ?? commit.staged_at) <= asOf, 'CLOCK_REGRESSION');
    // Validate at even when there are no records, so scope behavior does not depend on data presence.
    matchValidTime(normalizeValidTime(), {at});
    if (!commit) return {as_of: asOf, commit: null, records: [], gaps: ['NO_PUBLISHED_COMMIT']};
    const records = commit.record_refs.map(ref => {
      const record = needed(ref);
      const match = matchValidTime(record.valid_time, {at});
      return {...record, ...interval(ref, commit), processing_state: commit.record_states[ref].state,
        publication_state: commit.publication_boundary === 'UNCONFIRMED_CALLER_COMMIT' ? 'PUBLISHED_CURRENT_ONLY' : 'PUBLISHED', temporal_match: match};
    }).filter(record => record.temporal_match.status !== 'OUTSIDE');
    return {as_of: asOf, commit, records, gaps: [...commit.gaps]};
  }
  const readCurrent = options => selectRecords(options);
  function getHistory(logicalRef, {as_of} = {}) {
    string(logicalRef, 'LOGICAL_REF');
    const asOf = cutoff(as_of);
    assertHistoricalBoundary(asOf);
    const history = commits().filter(commit => commit.published_at <= asOf);
    const last = history.at(-1);
    const versions = db.prepare('SELECT payload FROM memory_record_versions_v1 WHERE library_id=? AND logical_ref=? ORDER BY version')
      .all(libraryId, logicalRef).map(decode).map(record => ({...record, ...interval(record.record_ref, last)}))
      .filter(record => last && record.recorded_from !== null);
    return {logical_ref: logicalRef, as_of: asOf, versions};
  }
  return Object.freeze({saveRecord, appendRecord, correctRecord, markProcessing, getRawRecord, getLatestRaw,
    getStatus, publish, applyPublicationInTransaction, applyKnowledgeViewInTransaction, recordPublicationFailure, selectRecords, readCurrent, getHistory,
    getCommit: ref => exactCommit(string(ref, 'COMMIT_REF')),
    getHead: head,
    listPublicationAttempts: publicationAttempts});
}
