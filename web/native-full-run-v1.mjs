/** Persistent parent ledger for every native business role. No implicit replay. */
import {hash, id, clone, need} from './cq-discovery-store-v2.mjs';
import {NORMAL_NATIVE_LIMITS,progressExecution} from './native-execution-controls-v1.mjs';

const RUN = 'native_full_run_v1', ARTIFACT = 'native_full_run_artifact_v1';
const OPEN = ['OPEN', 'RUNNING'];
export const NATIVE_BUILD_MODE = 'NATIVE_CQ_BUILD_V1';
export const DEFAULT_NATIVE_LIMITS = Object.freeze({
  max_generation_requests: 16, max_embedding_batches: 12, max_embedding_items: 200,
  max_embedding_text_chars: 120000, max_request_bytes: 1048576,
  max_total_bytes: 8388608, max_response_bytes: 16777216, max_wall_ms: 600000
});

export function createNativeFullRun({store, runId = id('full_run'), input, limits = DEFAULT_NATIVE_LIMITS, now = () => Date.now()}) {
  const normal=progressExecution({input}),selected = {...(normal?NORMAL_NATIVE_LIMITS:DEFAULT_NATIVE_LIMITS), ...(normal&&limits===DEFAULT_NATIVE_LIMITS?{}:limits)};
  for (const [name, value] of Object.entries(selected)) need(normal&&NORMAL_NATIVE_LIMITS[name]===null?value===null:Number.isSafeInteger(value) && value >= (['max_generation_requests', 'max_embedding_batches', 'max_embedding_items', 'max_embedding_text_chars'].includes(name) ? 0 : 1), 'NATIVE_RUN_LIMIT_INVALID');
  const binding = hash({input, limits: selected});
  const get = () => store.getRecord(RUN, runId);
  const save = value => store.putRecord(RUN, runId, clone(value));
  store.transaction(() => {
    const old = get();
    if (old) {
      need(old.binding === binding, 'NATIVE_RUN_BINDING_CONFLICT');
      if (old.attempts.some(a => a.outcome === 'RESERVED')) {
        old.status = 'UNKNOWN_HOLD'; old.reason = 'NATIVE_RUN_INTERRUPTED_RESULT_UNKNOWN';
        for (const attempt of old.attempts) if (attempt.outcome === 'RESERVED') { attempt.outcome = 'UNKNOWN'; attempt.reason = old.reason; }
        save(old);
      }
    } else save({run_id: runId, mode: NATIVE_BUILD_MODE, binding, input: clone(input), limits: selected,
      status: 'OPEN', created_at: now(), started_at: null, ended_at: null, attempts: [], checkpoints: [],...(normal?{last_progress_at:now()}: {})});
  });
  function state() { return clone(get()); }
  function assertOpen() {
    const value = get(); need(OPEN.includes(value.status), 'NATIVE_RUN_' + value.status);
    if (normal && now()-(value.last_progress_at??value.created_at)>=value.limits.max_no_progress_ms) {
      stop('NATIVE_NO_PROGRESS_TIMEOUT');need(false,'NATIVE_NO_PROGRESS_TIMEOUT');
    }
    if (!normal && value.started_at !== null && now() - value.started_at >= value.limits.max_wall_ms) {
      stop('NATIVE_RUN_DEADLINE'); need(false, 'NATIVE_RUN_DEADLINE');
    }
    return value;
  }
  function stop(reason, status = 'STOPPED') {
    return store.transaction(() => {
      const value = get();
      if (!OPEN.includes(value.status)) return clone(value);
      need(['STOPPED', 'FAILED', 'UNKNOWN_HOLD', 'STALE', 'CANCELLED'].includes(status), 'NATIVE_RUN_STOP_STATUS_INVALID');
      value.status = status; value.reason = reason; value.ended_at = now(); save(value); return clone(value);
    });
  }
  function checkpoint(stage, payload, parentRefs = []) {
    return store.transaction(() => {
      const value = assertOpen();
      need(typeof stage === 'string' && stage.length > 0 && Array.isArray(parentRefs), 'NATIVE_STAGE_INVALID');
      for (const ref of parentRefs) need(value.checkpoints.some(c => c.artifact_ref === ref), 'NATIVE_PARENT_ARTIFACT_INVALID');
      const content = {run_id: runId, stage, payload: clone(payload), parent_refs: [...parentRefs]};
      const artifact_ref = 'native_artifact_' + hash(content);
      const old = store.getRecord(ARTIFACT, artifact_ref);
      if (old) return clone(old);
      const artifact = {...content, artifact_ref, content_hash: hash(content), created_at: now()};
      store.putRecord(ARTIFACT, artifact_ref, artifact);
      value.checkpoints.push({stage, artifact_ref}); value.phase = stage;if(normal)value.last_progress_at=now();save(value); return clone(artifact);
    });
  }
  function reserve({kind, role, requestBytes = 0, items = 0, textChars = 0, agentScope = null}) {
    // Persist a deadline stop outside the admission transaction, so throwing
    // during preflight cannot roll the stop back to RUNNING.
    assertOpen();
    let denial;
    const result = store.transaction(() => {
      const value = assertOpen();
      need(['GENERATION', 'EMBEDDING'].includes(kind) && typeof role === 'string' && role.length > 0, 'NATIVE_REQUEST_ROLE_INVALID');
      const pending = value.attempts.filter(a => a.outcome === 'RESERVED');
      const parallel = ['WINDOWED_EXTRACTION_V1','HYBRID_EXTRACTION_V1'].includes(value.input.extraction_window_policy?.version);
      const parallelCQ = ['DOCLING_HYBRID_CQ_V1','DOCLING_STRUCTURE_CQ_V2'].includes(value.input.cq_chunk_policy?.version);
      if (agentScope !== null) need(typeof agentScope === 'string' && agentScope.length > 0, 'NATIVE_REQUEST_SCOPE_INVALID');
      if ((parallel && role === 'EXTRACTION' || parallelCQ && role === 'CQ') && kind === 'GENERATION' && agentScope) {
        need(pending.every(a => a.kind === 'GENERATION' && a.role === role && a.agent_scope && a.agent_scope !== agentScope), 'NATIVE_RUN_CONCURRENT_REQUEST_FORBIDDEN');
        if(value.input.extraction_stage_policy==='SEMANTIC_THEN_ORGANIZE_V1'&&role==='EXTRACTION'){const windowOf=scope=>scope.replace(/:(SEMANTIC|ORGANIZATION|RELATION_REVIEW)$/,'');need(pending.every(a=>windowOf(a.agent_scope)!==windowOf(agentScope)),'NATIVE_RUN_WINDOW_STAGE_CONCURRENT_FORBIDDEN');}
        const concurrency = role === 'CQ' ? value.input.cq_chunk_policy.concurrency : value.input.extraction_window_policy.concurrency;
        need(Number.isSafeInteger(concurrency) && concurrency > 0 && concurrency <= 4 && pending.length < concurrency, 'NATIVE_RUN_PARALLEL_LIMIT');
      } else need(!pending.length, 'NATIVE_RUN_CONCURRENT_REQUEST_FORBIDDEN');
      for (const n of [requestBytes, items, textChars]) need(Number.isSafeInteger(n) && n >= 0, 'NATIVE_REQUEST_SIZE_INVALID');
      const generation = value.attempts.filter(a => a.kind === 'GENERATION').length;
      const embedding = value.attempts.filter(a => a.kind === 'EMBEDDING');
      const total = key => value.attempts.reduce((n, a) => n + (a[key] ?? 0), 0);
      denial = requestBytes > value.limits.max_request_bytes ? 'NATIVE_REQUEST_TOO_LARGE' :
        !normal&&total('request_bytes') + requestBytes > value.limits.max_total_bytes ? 'NATIVE_TOTAL_BYTES_EXCEEDED' :
        !normal&&kind === 'GENERATION' && generation >= value.limits.max_generation_requests ? 'NATIVE_GENERATION_LIMIT' :
        !normal&&kind === 'EMBEDDING' && embedding.length >= value.limits.max_embedding_batches ? 'NATIVE_EMBEDDING_BATCH_LIMIT' :
        !normal&&kind === 'EMBEDDING' && total('items') + items > value.limits.max_embedding_items ? 'NATIVE_EMBEDDING_ITEMS_LIMIT' :
        !normal&&kind === 'EMBEDDING' && total('text_chars') + textChars > value.limits.max_embedding_text_chars ? 'NATIVE_EMBEDDING_TEXT_LIMIT' : null;
      if (denial) { value.status = 'STOPPED'; value.reason = denial; value.ended_at = now(); save(value); return null; }
      if (value.started_at === null) value.started_at = now();
      value.status = 'RUNNING';
      const request_ref = id('native_request');
      value.attempts.push({request_ref, request_id: request_ref, kind, role, ...(agentScope ? {agent_scope:agentScope} : {}), request_bytes: requestBytes, items, text_chars: textChars, outcome: 'RESERVED', sent_at: now()});
      save(value);
      return {request_ref, request_id: request_ref, remaining_ms: normal?value.limits.max_request_ms:Math.max(1, value.limits.max_wall_ms - (now() - value.started_at))};
    });
    need(!denial, denial); return result;
  }
  function settle(requestRef, {outcome, usage = null, reason = null}) {
    return store.transaction(() => {
      need(['RETURNED', 'FAILED', 'UNKNOWN'].includes(outcome), 'NATIVE_REQUEST_OUTCOME_INVALID');
      const value = get(), attempt = value.attempts.find(a => a.request_ref === requestRef);
      need(attempt, 'NATIVE_REQUEST_UNKNOWN');
      if (attempt.outcome !== 'RESERVED') {
        need(attempt.outcome === outcome, 'NATIVE_SETTLEMENT_CONFLICT'); return clone(attempt);
      }
      attempt.outcome = outcome; attempt.usage = clone(usage); attempt.reason = reason; attempt.ended_at = now();
      if (outcome !== 'RETURNED') {
        if (value.status !== 'UNKNOWN_HOLD' || outcome === 'UNKNOWN') {
          value.status = outcome === 'UNKNOWN' ? 'UNKNOWN_HOLD' : 'FAILED';
          value.reason = reason ?? 'NATIVE_REQUEST_' + outcome;
        }
        value.ended_at = now();
      }
      save(value); return clone(attempt);
    });
  }
  function complete(summary) {
    return store.transaction(() => {
      const value = assertOpen();
      need(value.attempts.every(a => a.outcome === 'RETURNED'), 'NATIVE_UNSETTLED_REQUEST');
      need(summary?.readback_verified === true, 'NATIVE_READBACK_REQUIRED');
      value.status = summary.partial ? 'PARTIALLY_READY' : 'SUCCEEDED'; value.summary = clone(summary); value.ended_at = now(); save(value); return clone(value);
    });
  }
  function completeDiscovery(summary) {
    return store.transaction(() => {
      const value = assertOpen();
      need(['CQ','FAMILY'].includes(value.input.stop_after), 'NATIVE_DISCOVERY_ONLY_SCOPE_REQUIRED');
      need(value.attempts.every(a => a.outcome === 'RETURNED'), 'NATIVE_UNSETTLED_REQUEST');
      need(value.attempts.every(a => a.kind === 'GENERATION' && (value.input.stop_after==='CQ'?['CQ']:['CQ','FAMILY']).includes(a.role)), 'NATIVE_DISCOVERY_ONLY_ROLE_VIOLATION');
      need(value.checkpoints.some(c => ['CQ_SAVED','CQ_IMPORTED_CONFIRMED'].includes(c.stage)) && (value.input.stop_after==='CQ'||value.checkpoints.some(c => c.stage === 'FAMILIES_SAVED')), 'NATIVE_DISCOVERY_CHECKPOINTS_REQUIRED');
      value.status = summary?.partial ? 'PARTIALLY_READY' : 'SUCCEEDED';
      value.summary = {...clone(summary),completion_scope:value.input.stop_after==='CQ'?'CQ_ONLY':'CQ_FAMILY_ONLY',knowledge_built:false,readback_verified:false};
      value.ended_at = now();save(value);return clone(value);
    });
  }
  function noteProgress(){if(!normal)return;return store.transaction(()=>{const value=get();if(OPEN.includes(value.status)){value.last_progress_at=now();save(value);}return value.last_progress_at;});}
  return {runId, state, assertOpen, checkpoint, reserve, settle, stop, complete, completeDiscovery,noteProgress,
    artifact(ref) { const value = store.getRecord(ARTIFACT, ref); need(value?.run_id === runId && value.content_hash === hash({run_id:value.run_id,stage:value.stage,payload:value.payload,parent_refs:value.parent_refs}), 'NATIVE_ARTIFACT_INVALID'); return clone(value); }};
}
