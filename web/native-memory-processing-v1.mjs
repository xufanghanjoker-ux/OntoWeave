/** S0 candidate copy. Production and earlier frozen candidate unchanged. */
/** Persistent processing jobs over the frozen raw-record core. Never calls an SDK. */
import {randomUUID} from 'node:crypto';
import {checkMemoryProcessingQuality,unknownMemoryProcessingQuality} from './native-memory-processing-quality-v1.mjs';
const need = (test, code) => {if (!test) throw Object.assign(new Error(code), {code});};
const clone = value => JSON.parse(JSON.stringify(value));
const text = value => typeof value === 'string' && value.trim().length > 0;

export function createMemoryProcessing({db, coreForLibrary, processorPort = null, publication = null,
  resolveProcessingQuality = null, clock = () => new Date().toISOString()}) {
  need(db && typeof coreForLibrary === 'function', 'MEMORY_PROCESSING_HOST_REQUIRED');
  need(!processorPort || (['NATIVE_CODEX', 'OFFLINE_DI'].includes(processorPort.mode) && typeof processorPort.process === 'function'), 'MEMORY_PROCESSOR_PORT_INVALID');
  need(resolveProcessingQuality===null||typeof resolveProcessingQuality==='function','MEMORY_PROCESSING_QUALITY_PORT_INVALID');
  db.exec(`CREATE TABLE IF NOT EXISTS memory_product_processing_jobs_v1(
    job_ref TEXT PRIMARY KEY,library_id TEXT NOT NULL,record_ref TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL,
    UNIQUE(library_id,record_ref));
    CREATE TABLE IF NOT EXISTS memory_product_processing_events_v1(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,job_ref TEXT NOT NULL,payload TEXT NOT NULL);`);
  const now = () => new Date(clock()).toISOString();
  const decode = row => row ? JSON.parse(row.payload) : null;
  const getJob = ref => decode(db.prepare('SELECT payload FROM memory_product_processing_jobs_v1 WHERE job_ref=?').get(ref));
  function qualityFor(job, record = null, runtime_receipt = job.runtime_receipt) {
    try {
      if(resolveProcessingQuality) return checkMemoryProcessingQuality(resolveProcessingQuality({job:clone(job),
        record:record??coreForLibrary(job.library_id).getRawRecord(job.record_ref),runtime_receipt:clone(runtime_receipt)}));
      return job.quality ? checkMemoryProcessingQuality(job.quality) : unknownMemoryProcessingQuality();
    } catch {return unknownMemoryProcessingQuality('MEMORY_PROCESSING_QUALITY_UNAVAILABLE');}
  }
  function withQuality(job) {
    if(!job)return job;
    const quality=qualityFor(job);
    return {...job,quality,content_state:quality.content_state,partial:quality.partial,
      retained_count:quality.retained_count,retained_reason_counts:clone(quality.retained_reason_counts)};
  }
  const get = ({library_id, record_ref}) => {
    const job = decode(db.prepare('SELECT payload FROM memory_product_processing_jobs_v1 WHERE library_id=? AND record_ref=?').get(library_id, record_ref));
    if (job?.state === 'READY_AWAITING_PUBLICATION' && publication?.getForRecord) {
      const confirmed = publication.getForRecord({library_id, record_ref});
      if (['CONFIRMED', 'OFFLINE_CONFIRMED'].includes(confirmed.state)) return withQuality({...job,
        state: confirmed.state === 'OFFLINE_CONFIRMED' ? 'OFFLINE_COMPLETED' : 'COMPLETED',
        publication: confirmed, confirmation_projected: true});
    }
    return withQuality(job);
  };
  function transaction(fn) {
    need(!db.isTransaction, 'MEMORY_PROCESSING_OUTER_TRANSACTION_FORBIDDEN');
    db.exec('BEGIN IMMEDIATE');
    try {const value = fn(); db.exec('COMMIT'); return value;} catch (cause) {db.exec('ROLLBACK'); throw cause;}
  }
  function persist(job) {
    db.prepare('UPDATE memory_product_processing_jobs_v1 SET state=?,payload=? WHERE job_ref=?').run(job.state, JSON.stringify(job), job.job_ref);
    db.prepare('INSERT INTO memory_product_processing_events_v1(job_ref,payload) VALUES(?,?)').run(job.job_ref, JSON.stringify({state: job.state, at: now(), error_code: job.error_code ?? null}));
    return clone(job);
  }
  function enqueue({library_id, record_ref, request_id, operation, target_record_ref = null}) {
    need([library_id, record_ref, request_id].every(text) && ['SAVE', 'RESULT', 'CORRECTION'].includes(operation), 'MEMORY_PROCESSING_INPUT_INVALID');
    const core = coreForLibrary(library_id);
    core.getRawRecord(record_ref);
    if (target_record_ref) core.getRawRecord(target_record_ref);
    const job = transaction(() => {
      const old = get({library_id, record_ref});
      if (old) return old;
      const value = {job_ref: 'mjob_' + randomUUID(), library_id, record_ref, request_id, operation,
        target_record_ref, state: processorPort ? (processorPort.isReady?.() === false ? 'WAITING_MODEL' : 'QUEUED') : 'WAITING_PROCESSOR',
        mode: processorPort?.mode ?? 'UNAVAILABLE', received_at: now(), attempts: 0,
        runtime_receipt: null, publication: {state: 'NOT_PUBLISHED', queryable: false}, gaps: []};
      db.prepare('INSERT INTO memory_product_processing_jobs_v1 VALUES(?,?,?,?,?)')
        .run(value.job_ref, library_id, record_ref, value.state, JSON.stringify(value));
      db.prepare('INSERT INTO memory_product_processing_events_v1(job_ref,payload) VALUES(?,?)')
        .run(value.job_ref, JSON.stringify({state: value.state, at: value.received_at}));
      return value;
    });
    const status = core.getStatus(record_ref);
    if (status.processing_state === 'RECEIVED') core.markProcessing(record_ref, {state: 'QUEUED'}, {idempotency_key: 'job:queued:' + job.job_ref});
    return clone(job);
  }
  async function runOne({job_ref}) {
    need(text(job_ref), 'MEMORY_PROCESSING_JOB_REQUIRED');
    const original = getJob(job_ref); need(original, 'MEMORY_PROCESSING_JOB_NOT_FOUND');
    if (!processorPort) return clone(original);
    if (['COMPLETED', 'OFFLINE_COMPLETED', 'READY_AWAITING_PUBLICATION'].includes(original.state))
      return clone(get({library_id: original.library_id, record_ref: original.record_ref}));
    need(['QUEUED', 'WAITING_PROCESSOR', 'WAITING_MODEL'].includes(original.state), 'MEMORY_PROCESSING_ALREADY_STARTED_NO_RETRY');
    if (processorPort.isReady?.() === false) return original.state === 'WAITING_MODEL' ? clone(original)
      : transaction(() => persist({...original, state: 'WAITING_MODEL'}));
    const job = transaction(() => {
      const current = getJob(job_ref);
      need(['QUEUED', 'WAITING_PROCESSOR', 'WAITING_MODEL'].includes(current.state), 'MEMORY_PROCESSING_ALREADY_STARTED_NO_RETRY');
      return persist({...current, state: 'RUNNING', mode: processorPort.mode, started_at: now(), attempts: current.attempts + 1});
    });
    const core = coreForLibrary(job.library_id);
    try {
      core.markProcessing(job.record_ref, {state: 'PROCESSING'}, {idempotency_key: 'job:running:' + job_ref});
      const record = core.getRawRecord(job.record_ref);
      const relatedRecords = job.target_record_ref ? [core.getRawRecord(job.target_record_ref)] : [];
      const result = await processorPort.process({job: clone(job), record, relatedRecords, core});
      need(result && Array.isArray(result.record_refs) && result.record_refs.every(text) && result.runtime_receipt && typeof result.runtime_receipt === 'object', 'MEMORY_PROCESSOR_RESULT_INVALID');
      if (processorPort.mode === 'NATIVE_CODEX') need(result.runtime_receipt.runtime === 'NATIVE_CODEX'
        && Array.isArray(result.runtime_receipt.skill_bindings) && result.runtime_receipt.skill_bindings.length >= 2
        && result.runtime_receipt.skill_bindings.every(binding => text(binding.sha256)), 'MEMORY_NATIVE_CODEX_SKILL_RECEIPT_REQUIRED');
      const records = [...new Set([job.record_ref, ...result.record_refs])];
      const quality=qualityFor(job,record,result.runtime_receipt);
      for (const ref of records) {
        core.getRawRecord(ref);
        const state = core.getStatus(ref).processing_state;
        if (!['READY', 'PARTIALLY_READY'].includes(state)) core.markProcessing(ref,
          {state: result.gaps?.length || quality.partial === true ? 'PARTIALLY_READY' : 'READY', result_refs: result.record_refs, gaps: result.gaps ?? []},
          {idempotency_key: 'job:ready:' + job_ref + ':' + ref});
      }
      transaction(() => persist({...getJob(job_ref), runtime_receipt: clone(result.runtime_receipt),
        record_refs: records, prepared_projection: clone(result.prepared_projection ?? null), gaps: clone(result.gaps ?? []),quality}));
      let published = {state: 'NOT_PUBLISHED', queryable: false};
      if (publication && result.prepared_projection && result.record_refs.length) {
        // Publishing never reruns semantic processing. A pending confirmation remains explicit.
        published = await publication.publish({library_id: job.library_id, record_refs: records,
          processing_ref: job_ref, prepared: result.prepared_projection});
      }
      return transaction(() => persist({...getJob(job_ref), state: published.queryable ? 'COMPLETED'
        : published.state === 'OFFLINE_CONFIRMED' ? 'OFFLINE_COMPLETED' : 'READY_AWAITING_PUBLICATION',
        finished_at: now(), runtime_receipt: clone(result.runtime_receipt), record_refs: records,
        publication: clone(published), gaps: clone(result.gaps ?? []),quality}));
    } catch (cause) {
      const code = typeof cause.code === 'string' ? cause.code : 'MEMORY_PROCESSING_FAILED';
      const state = /UNKNOWN|ABORT|TIMEOUT/.test(code) ? 'UNKNOWN' : 'FAILED';
      const currentState = core.getStatus(job.record_ref).processing_state;
      if (!['FAILED', 'UNKNOWN'].includes(currentState)) core.markProcessing(job.record_ref,
        {state, detail: {error_code: code}}, {idempotency_key: 'job:failed:' + job_ref});
      return transaction(() => persist({...getJob(job_ref), state, finished_at: now(), error_code: code,
        runtime_failure_ref: cause.action_processing_run_id ?? null, runtime_failure_kind: cause.staging_kind ?? null}));
    }
  }
  return Object.freeze({enqueue, get, runOne, mode: processorPort?.mode ?? 'UNAVAILABLE',
    isReady: () => !!processorPort && processorPort.isReady?.() !== false,
    neverStarted({limit = 50} = {}) {
      need(Number.isSafeInteger(limit) && limit > 0 && limit <= 100, 'MEMORY_PROCESSING_LIMIT_INVALID');
      return db.prepare("SELECT payload FROM memory_product_processing_jobs_v1 WHERE state IN ('QUEUED','WAITING_PROCESSOR','WAITING_MODEL') ORDER BY rowid LIMIT ?")
        .all(limit).map(decode).filter(job => job.attempts === 0);
    },
    events: job_ref => db.prepare('SELECT payload FROM memory_product_processing_events_v1 WHERE job_ref=? ORDER BY seq').all(job_ref).map(decode)});
}
