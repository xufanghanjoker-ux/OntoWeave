/** Persistent window work queue. Model execution is injected; reads never dispatch work. */
import {clone, hash, need, textField} from './cq-discovery-store-v2.mjs';

export const NATIVE_EXTRACTION_WINDOW_QUEUE_POLICY = 'WINDOW_EXTRACTION_QUEUE_V1';
export const NATIVE_EXTRACTION_WINDOW_CONCURRENCY = 4;
const QUEUE = 'native_extraction_window_queue_v1';
const MANIFEST = 'native_extraction_window_manifest_v1';
const WORK = 'native_extraction_window_work_v1';
const RESULT = 'native_extraction_window_result_v1';
const COMMIT = 'native_extraction_window_commit_v1';
const activeStores = new WeakMap();
const activeFor = store => {
  if (!activeStores.has(store)) activeStores.set(store, new Set());
  return activeStores.get(store);
};
const stopPriority = {STOPPED: 1, CANCELLED: 2, FAILED: 3, UNKNOWN_HOLD: 4};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const codeOf = (error, fallback) => textField(error?.code) ? error.code : fallback;
const resultOutcome = response => response?.outcome === 'UNKNOWN' ? 'UNKNOWN' : response?.outcome === 'FAILED' ? 'FAILED' : 'RETURNED';

/**
 * `manifest.windows` is immutable input, not a claim that every window contains knowledge.
 * `admit` is synchronous shared-budget preflight; the native runtime still meters requests.
 * `worker` owns outcome/receipt validation. `commit` serializes known returned proposals.
 */
export function createNativeExtractionWindowQueue({store, runId, manifest, concurrency = NATIVE_EXTRACTION_WINDOW_CONCURRENCY, now = () => Date.now()}) {
  need(store && ['getRecord', 'putRecord', 'transaction'].every(k => typeof store[k] === 'function') && textField(runId), 'NATIVE_WINDOW_QUEUE_STORE_REQUIRED');
  need(object(manifest) && Array.isArray(manifest.windows) && manifest.windows.every(object), 'NATIVE_WINDOW_QUEUE_MANIFEST_INVALID');
  need(Number.isSafeInteger(concurrency) && concurrency > 0 && concurrency <= NATIVE_EXTRACTION_WINDOW_CONCURRENCY, 'NATIVE_WINDOW_QUEUE_CONCURRENCY_INVALID');
  const frozen = clone(manifest), manifestHash = hash(frozen);
  const entries = frozen.windows.map((window, ordinal) => {
    const windowRef = window.window_ref ?? window.window_id ?? 'window_' + hash(window);
    need(textField(windowRef), 'NATIVE_WINDOW_QUEUE_WINDOW_ID_INVALID');
    return {window, ordinal, window_ref: windowRef, window_sha256: hash(window), work_id: 'window_work_' + hash([runId, manifestHash, ordinal, windowRef])};
  });
  need(new Set(entries.map(e => e.window_ref)).size === entries.length, 'NATIVE_WINDOW_QUEUE_DUPLICATE_WINDOW');
  const binding = hash({run_id: runId, manifest_sha256: manifestHash, concurrency, policy: NATIVE_EXTRACTION_WINDOW_QUEUE_POLICY});
  const manifestRef = 'window_manifest_' + hash([runId, manifestHash]);
  const get = (kind, id = runId) => store.getRecord(kind, id);
  const put = (kind, id, value) => store.putRecord(kind, id, clone(value));
  function queue() {
    const q = get(QUEUE);
    need(q?.binding === binding && q.run_id === runId && q.manifest_ref === manifestRef && q.manifest_sha256 === manifestHash, 'NATIVE_WINDOW_QUEUE_BINDING_CHANGED');
    return q;
  }
  function checkedManifest() {
    const value = get(MANIFEST, manifestRef);
    need(value, 'NATIVE_WINDOW_QUEUE_MANIFEST_MISSING');
    const {record_sha256, ...body} = value;
    need(record_sha256 === hash(body) && value.run_id === runId && value.queue_binding === binding &&
      value.manifest_sha256 === manifestHash && hash(value.manifest) === manifestHash, 'NATIVE_WINDOW_QUEUE_MANIFEST_CHANGED');
    return value.manifest;
  }
  function work(entry) {
    const w = get(WORK, entry.work_id);
    need(w?.queue_binding === binding && w.run_id === runId && w.ordinal === entry.ordinal && w.window_ref === entry.window_ref && w.window_sha256 === entry.window_sha256, 'NATIVE_WINDOW_QUEUE_WORK_CHANGED');
    return w;
  }
  function immutable(kind, id, body) {
    const value = {...clone(body), record_sha256: hash(body)}, old = get(kind, id);
    if (old) {need(hash(old) === hash(value), 'NATIVE_WINDOW_QUEUE_RESULT_CONFLICT');return old;}
    put(kind, id, value);return value;
  }
  function checkedResult(entry, kind = RESULT) {
    const value = get(kind, entry.work_id);
    if (!value) return null;
    const {record_sha256, ...body} = value;
    need(record_sha256 === hash(body) && value.run_id === runId && value.queue_binding === binding && value.work_id === entry.work_id && value.ordinal === entry.ordinal, 'NATIVE_WINDOW_QUEUE_RESULT_CHANGED');
    return value;
  }
  store.transaction(() => {
    const old = get(QUEUE);
    if (old) {queue();checkedManifest();for (const entry of entries) work(entry);return;}
    // Only queue-specific kinds are created. Existing run/history rows are never migrated.
    immutable(MANIFEST, manifestRef, {run_id: runId, queue_binding: binding, manifest_sha256: manifestHash, manifest: frozen});
    put(QUEUE, runId, {run_id: runId, policy: NATIVE_EXTRACTION_WINDOW_QUEUE_POLICY, binding, manifest_sha256: manifestHash,
      manifest_ref: manifestRef, concurrency, execution_started: false, status: 'PLANNED', created_at: now(), started_at: null, ended_at: null,
      stop_status: null, stop_reason: null, stop_events: [], commit_started: false, commit_complete: false});
    for (const entry of entries) put(WORK, entry.work_id, {run_id: runId, queue_binding: binding, work_id: entry.work_id,
      window_ref: entry.window_ref, window_sha256: entry.window_sha256, ordinal: entry.ordinal, status: 'PENDING', attempts: 0,
      read_status: 'UNREPORTED', extraction_status: 'NOT_STARTED', semantic_coverage: 'UNASSESSED', item_count: null,
      started_at: null, ended_at: null, commit_status: 'NOT_COMMITTED'});
  });
  function requestStop(reason, status = 'STOPPED') {
    need(Object.hasOwn(stopPriority, status) && textField(reason), 'NATIVE_WINDOW_QUEUE_STOP_INVALID');
    return store.transaction(() => {
      const q = queue();
      if (['COMPLETED', 'PARTIAL'].includes(q.status)) return clone(q);
      q.stop_events.push({status, reason, at: now()});
      if (!q.stop_status || stopPriority[status] > stopPriority[q.stop_status]) {q.stop_status = status;q.stop_reason = reason;}
      const inFlight = entries.some(e => work(e).status === 'RUNNING');
      q.status = inFlight || q.commit_started && !q.commit_complete ? 'DRAINING' : q.stop_status;
      if (!inFlight) q.ended_at = now();
      put(QUEUE, runId, q);return clone(q);
    });
  }
  function snapshot() {
    const q = queue(), savedManifest = checkedManifest(), windows = entries.map(entry => {
      const w = work(entry), r = checkedResult(entry), c = checkedResult(entry, COMMIT);
      return {...clone(w), result_available: !!r, result_sha256: r?.record_sha256 ?? null, commit_receipt_available: !!c};
    });
    const recoveryRequired = q.execution_started && ['RUNNING', 'DRAINING', 'COMMITTING'].includes(q.status) && !activeFor(store).has(runId);
    return {...clone(q), manifest: clone(savedManifest), ...(recoveryRequired ? {persisted_status: q.status, status: 'UNKNOWN_HOLD'} : {}), recovery_required: recoveryRequired,
      windows, summary: {total_windows: windows.length, pending: windows.filter(w => w.status === 'PENDING').length,
        running: windows.filter(w => w.status === 'RUNNING').length, returned: windows.filter(w => w.status === 'RETURNED').length,
        failed: windows.filter(w => w.status === 'FAILED').length, unknown: windows.filter(w => w.status === 'UNKNOWN').length,
        returned_empty: windows.filter(w => w.status === 'RETURNED' && w.item_count === 0).length,
        committed: windows.filter(w => w.commit_status === 'COMMITTED').length,
        all_windows_returned: windows.length > 0 && windows.every(w => w.status === 'RETURNED'),
        manifest_gaps: Array.isArray(savedManifest.gaps) ? savedManifest.gaps.length : 0,
        semantic_coverage: 'UNASSESSED', semantic_completeness_certified: false}};
  }
  function results() {return entries.map(e => checkedResult(e)).filter(Boolean).map(clone);}
  async function run({worker, admit = () => null, commit = null, signal = null} = {}) {
    need(typeof worker === 'function' && typeof admit === 'function' && (commit === null || typeof commit === 'function'), 'NATIVE_WINDOW_QUEUE_PORT_INVALID');
    checkedManifest();
    const claimed = store.transaction(() => {
      const q = queue();
      if (q.execution_started || q.status !== 'PLANNED') return false;
      q.execution_started = true;q.status = 'RUNNING';q.started_at = now();put(QUEUE, runId, q);return true;
    });
    if (!claimed) return {...snapshot(), execution_outcome: 'NO_AUTOMATIC_REPLAY'};
    activeFor(store).add(runId);
    const onAbort = () => requestStop(textField(signal?.reason?.code) ? signal.reason.code : 'NATIVE_WINDOW_QUEUE_CANCELLED', 'CANCELLED');
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, {once: true});
    let next = 0;
    const inFlight = new Set();
    async function execute(entry, admission) {
      let response;
      try {
        const value = await worker({window: clone(entry.window), workId: entry.work_id, ordinal: entry.ordinal, admission, signal});
        response = object(value) && Object.hasOwn(value, 'outcome') ? value : {outcome: 'RETURNED', result: value ?? null};
        need(['RETURNED', 'FAILED', 'UNKNOWN'].includes(response.outcome), 'NATIVE_WINDOW_QUEUE_WORKER_OUTCOME_INVALID');
        if (response.item_count !== undefined) need(Number.isSafeInteger(response.item_count) && response.item_count >= 0, 'NATIVE_WINDOW_QUEUE_ITEM_COUNT_INVALID');
      } catch (error) {
        // An uncategorized worker error can follow a sent request: do not guess FAILED.
        response = {outcome: error?.outcome === 'FAILED' ? 'FAILED' : 'UNKNOWN', reason: codeOf(error, 'NATIVE_WINDOW_WORKER_OUTCOME_UNKNOWN')};
      }
      const outcome = resultOutcome(response);
      store.transaction(() => {
        const w = work(entry);
        immutable(RESULT, entry.work_id, {run_id: runId, queue_binding: binding, work_id: entry.work_id, ordinal: entry.ordinal,
          window_ref: entry.window_ref, outcome, response: clone(response), returned_at: now()});
        Object.assign(w, {status: outcome, ended_at: now(), read_status: textField(response.read_status) ? response.read_status : w.read_status,
          extraction_status: outcome === 'RETURNED' ? response.item_count === 0 ? 'RETURNED_EMPTY_UNASSESSED' : 'RETURNED_UNASSESSED' : outcome,
          item_count: response.item_count ?? null, semantic_coverage: 'UNASSESSED'});
        put(WORK, entry.work_id, w);
      });
      if (outcome !== 'RETURNED') requestStop(textField(response.reason) ? response.reason : 'NATIVE_WINDOW_WORKER_' + outcome, outcome === 'UNKNOWN' ? 'UNKNOWN_HOLD' : 'FAILED');
    }
    function dispatch() {
      while (next < entries.length && inFlight.size < concurrency && !queue().stop_status) {
        const entry = entries[next];
        let admission;
        try {
          admission = admit({window: clone(entry.window), workId: entry.work_id, ordinal: entry.ordinal});
          need(!admission?.then, 'NATIVE_WINDOW_QUEUE_ADMISSION_MUST_BE_SYNC');
          if (admission?.allowed === false) {requestStop(admission.reason ?? 'NATIVE_WINDOW_QUEUE_ADMISSION_STOP');break;}
        } catch (error) {requestStop(codeOf(error, 'NATIVE_WINDOW_QUEUE_ADMISSION_STOP'));break;}
        next++;
        store.transaction(() => {
          const w = work(entry);need(w.status === 'PENDING' && w.attempts === 0, 'NATIVE_WINDOW_QUEUE_WORK_ALREADY_STARTED');
          Object.assign(w, {status: 'RUNNING', attempts: 1, started_at: now(), extraction_status: 'RUNNING'});put(WORK, entry.work_id, w);
        });
        let task;
        task = execute(entry, admission).finally(() => inFlight.delete(task));
        inFlight.add(task);
      }
    }
    try {
      dispatch();
      while (inFlight.size) {await Promise.race(inFlight);dispatch();}
      // All in-flight requests have settled and raw outcomes are durable before merging.
      if (commit) {
        store.transaction(() => {const q = queue();q.commit_started = true;q.status = q.stop_status ? 'DRAINING' : 'COMMITTING';put(QUEUE, runId, q);});
        for (const entry of entries) {
          const r = checkedResult(entry);
          if (!r || r.outcome !== 'RETURNED') continue;
          store.transaction(() => {const w = work(entry);w.commit_status = 'COMMITTING';put(WORK, entry.work_id, w);});
          try {
            const receipt = await commit({window: clone(entry.window), workId: entry.work_id, ordinal: entry.ordinal,
              result: clone(r.response.result ?? null), response: clone(r.response)});
            store.transaction(() => {
              immutable(COMMIT, entry.work_id, {run_id: runId, queue_binding: binding, work_id: entry.work_id, ordinal: entry.ordinal,
                window_ref: entry.window_ref, source_result_sha256: r.record_sha256, receipt: clone(receipt ?? null), committed_at: now()});
              const w = work(entry);w.commit_status = 'COMMITTED';put(WORK, entry.work_id, w);
            });
          } catch (error) {
            const unknown = error?.outcome !== 'FAILED';
            store.transaction(() => {const w = work(entry);w.commit_status = unknown ? 'UNKNOWN' : 'FAILED';w.commit_reason = codeOf(error, 'NATIVE_WINDOW_COMMIT_OUTCOME_UNKNOWN');put(WORK, entry.work_id, w);});
            requestStop(codeOf(error, 'NATIVE_WINDOW_COMMIT_OUTCOME_UNKNOWN'), unknown ? 'UNKNOWN_HOLD' : 'FAILED');
            break;
          }
        }
      }
      store.transaction(() => {
        const q = queue();q.commit_complete = commit ? entries.every(e => {const r = checkedResult(e);return !r || r.outcome !== 'RETURNED' || work(e).commit_status === 'COMMITTED';}) : false;
        q.status = q.stop_status ?? (Array.isArray(frozen.gaps) && frozen.gaps.length ? 'PARTIAL' : 'COMPLETED');q.ended_at = now();put(QUEUE, runId, q);
      });
      return {...snapshot(), execution_outcome: 'EXECUTED_ONCE'};
    } catch (error) {
      // Persistence or coordinator failure must not abandon remaining in-flight promises.
      requestStop(codeOf(error, 'NATIVE_WINDOW_COORDINATOR_FAILED'), 'UNKNOWN_HOLD');
      await Promise.allSettled([...inFlight]);
      store.transaction(() => {const q = queue();q.status = q.stop_status;q.ended_at = now();put(QUEUE, runId, q);});
      return {...snapshot(), execution_outcome: 'STOPPED_NO_AUTOMATIC_RETRY'};
    } finally {
      signal?.removeEventListener('abort', onAbort);activeFor(store).delete(runId);
    }
  }
  return {runId, snapshot, results, run, stop:requestStop, cancel: reason => requestStop(reason ?? 'NATIVE_WINDOW_QUEUE_CANCELLED', 'CANCELLED')};
}
