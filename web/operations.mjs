/** Record before sending. Missing usage means unknown, never free. No credentials or request bodies. */
import { randomUUID } from 'node:crypto';
import { sha } from './engine.mjs';
export function meteredProvider(provider, store, { operation_id = randomUUID(), phase = 'generation', task_id = null, budget_id = null } = {}) {
  async function complete(messages,options) {
    const record = { id: randomUUID(), operation_id, task_id, budget_id, phase: typeof phase === 'function' ? phase() : phase, model: provider.model,
      request_sha256: sha(messages), requested_max_tokens: provider.maxTokens ?? null,
      thinking_mode: provider.thinkingMode ?? 'default', timeout_ms: provider.timeoutMs ?? null,
      status: 'STARTED', started_at: new Date().toISOString(), usage: null, usage_status: 'UNKNOWN' };
    store.putRecord('attempt', record.id, record);
    const started = Date.now();
    try {
      const response = await provider.complete(messages,options);
      record.status = 'COMPLETED'; record.usage = response.usage_raw || response.usage || null;
      record.usage_status = reported(record.usage) ? 'REPORTED' : 'UNKNOWN';
      record.reported_model = response.reported_model || null;
      return response;
    } catch (error) {
      record.status = error.code?.startsWith('BUDGET_') || error.details?.billing_status==='NOT_SENT' ? 'BLOCKED_NOT_SENT' : 'FAILED'; record.error_code = error.code || 'REQUEST_FAILED_OR_UNKNOWN_BILLING';
      record.usage = error.details?.usage_raw || error.details?.usage || null;
      record.usage_status = reported(record.usage) ? 'REPORTED' : 'UNKNOWN'; throw error;
    } finally {
      record.finished_at = new Date().toISOString(); record.latency_ms = Date.now() - started;
      store.putRecord('attempt', record.id, record);
    }
  }
  return { ...provider, complete,
    withMaxTokens: provider.withMaxTokens ? tokens => meteredProvider(provider.withMaxTokens(tokens), store, { operation_id, phase, task_id, budget_id }) : undefined };
}
const reported = usage => usage && ['total_tokens', 'prompt_tokens', 'completion_tokens'].some(k => Number.isFinite(usage[k]) && usage[k] >= 0);
export function recoverAttempts(store) {
  for (const record of store.listRecords('attempt')) if (record.status === 'STARTED') store.putRecord('attempt', record.id,
    { ...record, status: 'INTERRUPTED', usage_status: 'UNKNOWN', finished_at: new Date().toISOString() });
}
