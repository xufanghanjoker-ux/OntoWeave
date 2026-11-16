/** The sole current-view publication coordinator. Confirmation never switches domain/index heads. */
import {createHash, randomUUID} from 'node:crypto';

const bindingKeys = ['knowledge_revision_ref', 'graph_revision_ref', 'source_index_revision', 'knowledge_index_revision'];
const finalStates = new Set(['CONFIRMED', 'OFFLINE_CONFIRMED']);
const blockedStates = new Set(['PREPARING', 'COMMITTED_UNCONFIRMED', 'READBACK_FAILED', 'COMMIT_UNKNOWN']);
const fail = code => Object.assign(new Error(code), {code});
const need = (condition, code) => { if (!condition) throw fail(code); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  need(plain(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'MEMORY_PUBLICATION_INVALID_JSON');
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
const clone = value => JSON.parse(canonical(value));
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
function refs(value) {
  need(Array.isArray(value) && value.length > 0 && value.every(text) && new Set(value).size === value.length,
    'MEMORY_PUBLICATION_RECORD_REFS_INVALID');
  return [...value];
}

export function createMemoryPublicationCoordinator({db, coreForLibrary, projectionPort, factPort = null, clock = () => new Date().toISOString()}) {
  need(db && typeof db.prepare === 'function' && typeof coreForLibrary === 'function', 'MEMORY_PUBLICATION_HOST_REQUIRED');
  need(projectionPort && ['NATIVE_PRODUCT', 'OFFLINE_DI'].includes(projectionPort.mode)
    && typeof projectionPort.applyInTransaction === 'function' && typeof projectionPort.readback === 'function',
  'MEMORY_PUBLICATION_PROJECTION_PORT_REQUIRED');
  need(projectionPort.applyInTransaction.constructor?.name !== 'AsyncFunction', 'MEMORY_PUBLICATION_ASYNC_APPLY_FORBIDDEN');
  need(factPort === null || factPort.mode === 'NATIVE_PRODUCT'
    && ['coreForLibrary','validatePrepared','applyInTransaction','readback','assertPreparedCurrent','activateInTransaction'].every(key => typeof factPort[key] === 'function'), 'MEMORY_FACT_PORT_REQUIRED');
  const coreFor = row => row.fact_participant ? factPort.coreForLibrary(row.library_id) : coreForLibrary(row.library_id);
  const projectionFor = row => row.fact_participant ? factPort : projectionPort;
  function validateFact(row, phase) {
    need(factPort && factPort.mode === 'NATIVE_PRODUCT', 'MEMORY_FACT_PORT_REQUIRED');
    const proof = factPort.validatePrepared({library_id:row.library_id,processing_ref:row.processing_ref,prepared:clone(row.prepared),phase});
    need(proof && typeof proof.then !== 'function' && proof.verified === true, 'MEMORY_FACT_PREPARED_NOT_VERIFIED');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS memory_product_publications_v1 (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, library_id TEXT NOT NULL, publication_ref TEXT NOT NULL UNIQUE,
    processing_ref TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL,
    UNIQUE(library_id,processing_ref));
    CREATE INDEX IF NOT EXISTS memory_product_publications_library_v1
      ON memory_product_publications_v1(library_id,seq);
    CREATE TABLE IF NOT EXISTS memory_product_publication_events_v1 (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, library_id TEXT NOT NULL, publication_ref TEXT NOT NULL,
      event_ref TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS memory_product_publication_events_lookup_v1
      ON memory_product_publication_events_v1(publication_ref,seq);`);
  const now = () => {
    const input = clock();
    const value = input instanceof Date ? input.toISOString() : input;
    need(text(value) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), 'MEMORY_PUBLICATION_CLOCK_INVALID');
    return new Date(value).toISOString();
  };
  const decode = row => row ? JSON.parse(row.payload) : null;
  const byRef = ref => decode(db.prepare('SELECT payload FROM memory_product_publications_v1 WHERE publication_ref=?').get(ref));
  const byProcessing = (libraryId, processingRef) => decode(db.prepare('SELECT payload FROM memory_product_publications_v1 WHERE library_id=? AND processing_ref=?').get(libraryId, processingRef));
  const rows = libraryId => db.prepare('SELECT payload FROM memory_product_publications_v1 WHERE library_id=? ORDER BY seq DESC').all(libraryId).map(decode);
  function appendEvent(value, previous, eventType) {
    const event = {event_ref: 'mpubevent_' + randomUUID(), publication_ref: value.publication_ref,
      library_id: value.library_id, event_type: eventType, occurred_at: now(), state: value.state,
      previous_state: previous?.state ?? null, error_code: value.error_code ?? null,
      previous_error_code: previous?.error_code ?? null,
      commit_ref: value.commit_ref ?? null, commit_seq: value.commit_seq ?? null,
      bindings: Object.fromEntries(bindingKeys.map(key => [key, value.prepared[key]])),
      transaction_result: value.transaction_result ?? null,
      commit_acknowledged_at: value.commit_acknowledged_at ?? null,
      readback_confirmed_at: value.readback_confirmed_at ?? null,
      readback_failed_at: value.readback_failed_at ?? null,
      confirmation_ref: value.confirmation_ref ?? null, evidence_refs: clone(value.readback?.evidence_refs ?? [])};
    if (value.fact_activation) event.fact_activation = clone(value.fact_activation);
    db.prepare('INSERT INTO memory_product_publication_events_v1(library_id,publication_ref,event_ref,payload) VALUES(?,?,?,?)')
      .run(value.library_id, value.publication_ref, event.event_ref, canonical(event));
  }
  function update(value, eventType = 'STATE_UPDATED') {
    const previous = byRef(value.publication_ref);
    db.prepare('UPDATE memory_product_publications_v1 SET state=?,payload=? WHERE publication_ref=? AND library_id=?')
      .run(value.state, canonical(value), value.publication_ref, value.library_id);
    appendEvent(value, previous, eventType);
    return value;
  }
  function transaction(fn) {
    need(db.isTransaction === false, 'MEMORY_PUBLICATION_OUTER_TRANSACTION_FORBIDDEN');
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      need(!result || typeof result.then !== 'function', 'MEMORY_PUBLICATION_ASYNC_TRANSACTION_FORBIDDEN');
      need(db.isTransaction === true, 'MEMORY_PUBLICATION_TRANSACTION_OWNERSHIP_CHANGED');
      db.exec('COMMIT');
      return result;
    } catch (cause) {
      if (db.isTransaction) {
        try { db.exec('ROLLBACK'); cause.publication_rolled_back = true; } catch { /* retained as unknown */ }
      }
      throw cause;
    }
  }
  function publicReceipt(row) {
    if (!row) return {state: 'NOT_PUBLISHED', queryable: false, mode: null, gaps: []};
    return {publication_ref: row.publication_ref, library_id: row.library_id, state: row.state,
      queryable: row.state === 'CONFIRMED' && row.mode === 'NATIVE_PRODUCT', mode: row.mode,
      processing_ref: row.processing_ref, commit_ref: row.commit_ref ?? null, commit_seq: row.commit_seq ?? null,
      bindings: Object.fromEntries(bindingKeys.map(key => [key, row.prepared[key]])),
      commit_acknowledged_at: row.commit_acknowledged_at ?? null,
      readback_confirmed_at: row.readback_confirmed_at ?? null, confirmation_ref: row.confirmation_ref ?? null,
      evidence_refs: clone(row.readback?.evidence_refs ?? []),
      ...(row.fact_activation ? {fact_activation:clone(row.fact_activation)} : {}),
      gaps: [row.fact_activation ? 'RAW_RECORD_HISTORY_BOUNDARY_UNSEALED' : 'STRICT_HISTORY_BOUNDARY_UNSEALED', ...(row.mode === 'OFFLINE_DI' ? ['OFFLINE_DI_NOT_PRODUCT_PUBLICATION'] : []),
        ...(finalStates.has(row.state) ? [] : ['PUBLICATION_NOT_CONFIRMED'])],
      ...(row.error_code ? {error_code: row.error_code} : {})};
  }
  function validatePrepared(libraryId, prepared) {
    need(plain(prepared) && prepared.library_id === libraryId && bindingKeys.every(key => text(prepared[key])),
      'MEMORY_PUBLICATION_PREPARED_INVALID');
    return clone(prepared);
  }
  function pending(libraryId) { return rows(libraryId).find(row => blockedStates.has(row.state)); }
  async function confirmPending({publication_ref}) {
    need(text(publication_ref), 'MEMORY_PUBLICATION_REF_REQUIRED');
    let row = byRef(publication_ref);
    need(row, 'MEMORY_PUBLICATION_NOT_FOUND');
    if (finalStates.has(row.state)) return publicReceipt(row);
    need(['COMMITTED_UNCONFIRMED', 'READBACK_FAILED'].includes(row.state), 'MEMORY_PUBLICATION_COMMIT_UNKNOWN');
    const projection = projectionFor(row);
    need(row.mode === projection.mode, 'MEMORY_PUBLICATION_MODE_CHANGED');
    const core = coreFor(row);
    need(core.getHead()?.commit_ref === row.commit_ref && core.getCommit(row.commit_ref), 'MEMORY_PUBLICATION_COMMIT_CHANGED');
    // A crash may have happened after COMMIT but before this acknowledgement was saved.
    if (!row.commit_acknowledged_at) row = transaction(() => update({...byRef(publication_ref), commit_acknowledged_at: now()}, 'COMMIT_ACKNOWLEDGED'));
    try {
      const proof = clone(await projection.readback({library_id: row.library_id,
        prepared: clone(row.prepared), commit_ref: row.commit_ref}));
      need(proof.verified === true && proof.library_id === row.library_id
        && bindingKeys.every(key => proof[key] === row.prepared[key])
        && Array.isArray(proof.evidence_refs) && proof.evidence_refs.length > 0 && proof.evidence_refs.every(text),
      'MEMORY_PUBLICATION_READBACK_MISMATCH');
      return transaction(() => {
        const current = byRef(publication_ref);
        if (finalStates.has(current.state)) return publicReceipt(current);
        need(['COMMITTED_UNCONFIRMED', 'READBACK_FAILED'].includes(current.state), 'MEMORY_PUBLICATION_STATE_CHANGED');
        need(core.getHead()?.commit_ref === current.commit_ref, 'MEMORY_PUBLICATION_COMMIT_CHANGED');
        const confirmationRef = 'mconfirm_' + hash([publication_ref, proof]);
        let activation = null;
        if (current.fact_participant) {
          const checked = factPort.assertPreparedCurrent({library_id:row.library_id,prepared:clone(row.prepared),readback:proof});
          need(checked && typeof checked.then !== 'function' && checked.verified === true, 'MEMORY_FACT_ACTIVE_BINDING_CHANGED');
          activation = factPort.activateInTransaction({library_id:row.library_id,processing_ref:row.processing_ref,
            publication_ref,confirmation_ref:confirmationRef,commit_ref:row.commit_ref,prepared:clone(row.prepared),readback:proof});
          need(activation && typeof activation.then !== 'function', 'MEMORY_FACT_ASYNC_ACTIVATION_FORBIDDEN');
        }
        const confirmed = {...current, state: current.mode === 'OFFLINE_DI' ? 'OFFLINE_CONFIRMED' : 'CONFIRMED',
          readback: proof, readback_confirmed_at: now(), confirmation_ref: confirmationRef,
          ...(activation ? {fact_activation:clone(activation)} : {}),
          error_code: null};
        update(confirmed, 'READBACK_CONFIRMED');
        return publicReceipt(confirmed);
      });
    } catch (cause) {
      return transaction(() => {
        const current = byRef(publication_ref);
        if (finalStates.has(current.state)) return publicReceipt(current);
        return publicReceipt(update({...current, state: 'READBACK_FAILED', readback_failed_at: now(),
          error_code: typeof cause.code === 'string' ? cause.code : 'MEMORY_PUBLICATION_READBACK_FAILED'}, 'READBACK_FAILED'));
      });
    }
  }
  async function publishInternal({library_id, record_refs, processing_ref, prepared, maintenance = null, fact_participant = false, defer_confirmation = false}) {
    need(text(library_id) && text(processing_ref), 'MEMORY_PUBLICATION_IDENTITY_REQUIRED');
    need(!fact_participant || !maintenance && record_refs === undefined, 'MEMORY_FACT_EXPLICIT_SCOPE_REQUIRED');
    const selected = fact_participant ? [] : refs(record_refs);
    const preparation = validatePrepared(library_id, prepared);
    const requestHash = hash({library_id, record_refs: selected, processing_ref, prepared: preparation,
      ...(maintenance ? {maintenance} : {}),...(fact_participant ? {fact_participant:true} : {})});
    const core = fact_participant ? (need(factPort,'MEMORY_FACT_PORT_REQUIRED'),factPort.coreForLibrary(library_id)) : coreForLibrary(library_id);
    const intent = transaction(() => {
      const existing = byProcessing(library_id, processing_ref);
      if (existing) {
        need(existing.request_hash === requestHash, 'MEMORY_PUBLICATION_IDEMPOTENCY_CONFLICT');
        return {row: existing, replayed: true};
      }
      need(!pending(library_id), 'MEMORY_PUBLICATION_PENDING');
      if (fact_participant) validateFact({library_id,processing_ref,prepared:preparation},'INTENT');
      if (maintenance) {
        need(typeof core.applyKnowledgeViewInTransaction === 'function', 'MEMORY_KNOWLEDGE_VIEW_PARTICIPANT_REQUIRED');
        const source = byProcessing(library_id, maintenance.source_processing_ref);
        need(source?.state === 'CONFIRMED' && source.mode === 'NATIVE_PRODUCT'
          && source.publication_ref === maintenance.source_publication_ref
          && selected.every(ref => source.record_refs.includes(ref)), 'MEMORY_MAINTENANCE_SOURCE_PUBLICATION_INVALID');
        need(maintenance.attempt_ref === processing_ref && preparation.maintenance?.attempt_ref === processing_ref
          && hash(preparation.maintenance) === hash(maintenance), 'MEMORY_MAINTENANCE_PROJECTION_BINDING_INVALID');
        assertQueryable({library_id});
      }
      // Resolve exact versions now; the core repeats readiness/CAS checks in the final transaction.
      for (const ref of selected) core.getRawRecord(ref);
      const row = {schema_version: 'MEMORY_PRODUCT_PUBLICATION_V1', publication_ref: 'mpublish_' + randomUUID(),
        library_id, processing_ref, record_refs: selected, prepared: preparation, mode: fact_participant ? factPort.mode : projectionPort.mode,
        ...(fact_participant ? {fact_participant:true} : {}),
        state: 'PREPARING', request_hash: requestHash, maintenance: clone(maintenance), intent_saved_at: now(), expected_commit_ref: core.getHead()?.commit_ref ?? null};
      db.prepare('INSERT INTO memory_product_publications_v1(library_id,publication_ref,processing_ref,state,payload) VALUES(?,?,?,?,?)')
        .run(library_id, row.publication_ref, processing_ref, row.state, canonical(row));
      appendEvent(row, null, 'INTENT_SAVED');
      return {row, replayed: false};
    });
    if (intent.replayed) return {...publicReceipt(intent.row), replayed: true};
    let row = intent.row;
    try {
      row = transaction(() => {
        const current = byRef(row.publication_ref);
        need(current.state === 'PREPARING' && (core.getHead()?.commit_ref ?? null) === current.expected_commit_ref,
          'MEMORY_PUBLICATION_STALE_COMMIT');
        if (current.fact_participant) validateFact(current,'APPLY');
        const apply = current.fact_participant ? core.applyFactPublicationInTransaction
          : current.maintenance ? core.applyKnowledgeViewInTransaction : core.applyPublicationInTransaction;
        const stage = apply({...(current.fact_participant ? {} : {record_refs:selected}),expected_commit_ref: current.expected_commit_ref,
          ...(current.maintenance ? {maintenance: current.maintenance} : {}),
          bindings: {graph_revision_ref: preparation.graph_revision_ref, source_index_revision: preparation.source_index_revision,
            knowledge_index_revision: preparation.knowledge_index_revision}}, {idempotency_key: 'publication:' + current.publication_ref});
        const applied = projectionFor(current).applyInTransaction({library_id, prepared: clone(preparation),
          expected: {commit_ref: current.expected_commit_ref}, commit_ref: stage.commit.commit_ref});
        need(!applied || typeof applied.then !== 'function', 'MEMORY_PUBLICATION_ASYNC_APPLY_FORBIDDEN');
        need(db.isTransaction === true, 'MEMORY_PUBLICATION_TRANSACTION_OWNERSHIP_CHANGED');
        return update({...current, state: 'COMMITTED_UNCONFIRMED', commit_ref: stage.commit.commit_ref,
          commit_seq: stage.commit.commit_seq, staged_at: stage.commit.staged_at, transaction_result: 'COMMITTED_AWAITING_ACK'}, 'PUBLICATION_APPLIED');
      });
    } catch (cause) {
      try {
        transaction(() => update({...byRef(row.publication_ref), state: cause.publication_rolled_back ? 'FAILED' : 'COMMIT_UNKNOWN',
          transaction_result: cause.publication_rolled_back ? 'ROLLED_BACK' : 'UNKNOWN',
          error_code: typeof cause.code === 'string' ? cause.code : 'MEMORY_PUBLICATION_APPLY_FAILED', failure_saved_at: now()}, 'APPLY_FAILED'));
        if (cause.publication_rolled_back && !fact_participant) core.recordPublicationFailure({record_refs: selected,
          error_code: typeof cause.code === 'string' ? cause.code : 'MEMORY_PUBLICATION_APPLY_FAILED'}, {idempotency_key: 'publication:' + row.publication_ref});
      } catch { /* original failure retained; PREPARING remains a read barrier */ }
      throw cause;
    }
    if (defer_confirmation) return {...publicReceipt(row),replayed:false};
    return {...await confirmPending({publication_ref: row.publication_ref}), replayed: false};
  }
  function getForRecord({library_id, record_ref}) {
    need(text(library_id) && text(record_ref), 'MEMORY_PUBLICATION_IDENTITY_REQUIRED');
    const receipt = publicReceipt(rows(library_id).find(row => row.record_refs.includes(record_ref)));
    if (!receipt.queryable) return receipt;
    const blocked = pending(library_id) ? 'MEMORY_PUBLICATION_PENDING'
      : coreForLibrary(library_id).getHead()?.commit_ref !== receipt.commit_ref ? 'MEMORY_PUBLICATION_STALE' : null;
    return blocked ? {...receipt, queryable: false, gaps: [...receipt.gaps, blocked]} : receipt;
  }
  function assertQueryable({library_id}) {
    need(text(library_id), 'MEMORY_PUBLICATION_IDENTITY_REQUIRED');
    need(!pending(library_id), 'MEMORY_PUBLICATION_PENDING');
    const current = rows(library_id).find(row => finalStates.has(row.state));
    need(current, 'MEMORY_PUBLICATION_NOT_READY');
    need(current.mode === 'NATIVE_PRODUCT' && current.state === 'CONFIRMED', 'MEMORY_PUBLICATION_OFFLINE_ONLY');
    need(coreFor(current).getHead()?.commit_ref === current.commit_ref, 'MEMORY_PUBLICATION_STALE');
    return publicReceipt(current);
  }
  function events({publication_ref}) {
    need(text(publication_ref), 'MEMORY_PUBLICATION_REF_REQUIRED');
    need(byRef(publication_ref), 'MEMORY_PUBLICATION_NOT_FOUND');
    return db.prepare('SELECT seq,payload FROM memory_product_publication_events_v1 WHERE publication_ref=? ORDER BY seq')
      .all(publication_ref).map(row => ({...decode(row), event_seq: row.seq}));
  }
  return Object.freeze({mode: projectionPort.mode,
    publish: request => {need(!Object.hasOwn(request,'maintenance'), 'MEMORY_MAINTENANCE_EXPLICIT_ENTRY_REQUIRED');
      need(!('fact_participant' in request),'MEMORY_FACT_EXPLICIT_ENTRY_REQUIRED');return publishInternal(request);},
    publishKnowledgeView: request => {need(plain(request.maintenance), 'MEMORY_MAINTENANCE_REQUIRED');
      need(!('fact_participant' in request),'MEMORY_FACT_EXPLICIT_ENTRY_REQUIRED');return publishInternal(request);},
    publishFactChangeSet: request => {
      need(plain(request) && [Object.prototype,null].includes(Object.getPrototypeOf(request))
        && Object.keys(request).every(key => ['library_id','processing_ref','prepared'].includes(key)), 'MEMORY_FACT_REQUEST_INVALID');
      return publishInternal({...clone(request),fact_participant:true});
    },
    stageFactChangeSet: request => {
      need(plain(request) && [Object.prototype,null].includes(Object.getPrototypeOf(request))
        && Object.keys(request).every(key => ['library_id','processing_ref','prepared'].includes(key)), 'MEMORY_FACT_REQUEST_INVALID');
      return publishInternal({...clone(request),fact_participant:true,defer_confirmation:true});
    },
    getForProcessing: ({library_id,processing_ref}) => publicReceipt(byProcessing(library_id,processing_ref)),
    getForRecord, assertQueryable, confirmPending, events});
}
