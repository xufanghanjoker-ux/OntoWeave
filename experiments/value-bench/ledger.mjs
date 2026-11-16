import { randomUUID, createHash } from 'node:crypto';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const usageOf = result => {
  const raw = result?.usage_raw, basic = result?.usage;
  const usage = raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length ? raw : basic;
  return usage && typeof usage === 'object' && !Array.isArray(usage) && Object.keys(usage).length ? structuredClone(usage) : null;
};
export function totalTokensOf(usage) {
  const valid = n => Number.isFinite(n) && n >= 0;
  if (valid(usage?.total_tokens)) return usage.total_tokens;
  for (const [input,output] of [['prompt_tokens','completion_tokens'],['input_tokens','output_tokens']]) {
    if (valid(usage?.[input]) && valid(usage?.[output])) return usage[input]+usage[output];
  }
  return null;
}
const billingOf = usage => totalTokensOf(usage) !== null ? 'REPORTED_USAGE' : usage ? 'PARTIAL_USAGE' : 'UNKNOWN';
/** Persist STARTED before network. Never auto-retry ambiguous requests. */
export function createLedger({ getRecord = () => null, putRecord = () => {}, runId = randomUUID(), maxCalls = 0 } = {}) {
  let attempts = getRecord('attempts') || [];
  const persist = () => putRecord('attempts', attempts);
  return { runId, get attempts() { return structuredClone(attempts); },
    async call(meta, invoke) {
      const fingerprint = digest(meta);
      const complete = attempts.find(a => a.fingerprint === fingerprint && a.status === 'SUCCEEDED');
      if (complete) return structuredClone(complete.result);
      if (attempts.some(a => a.fingerprint === fingerprint)) throw Error('BLOCKED_AMBIGUOUS_ATTEMPT: explicit new run required; no automatic resend');
      if (attempts.length >= maxCalls) throw Error('BLOCKED_BUDGET: call cap exhausted');
      const started = Date.now();
      const row = { id: randomUUID(), run_id: runId, fingerprint, ...meta, status: 'STARTED', started_at: new Date(started).toISOString(), duration_ms:null,usage: null, billing: 'UNKNOWN' };
      attempts.push(row); persist();
      try {
        const result = await invoke();
        row.result = result; row.usage = usageOf(result); row.usage_raw = result.usage_raw ? structuredClone(result.usage_raw) : null;
        row.status = 'SUCCEEDED'; row.billing = billingOf(row.usage);
        row.duration_ms = Date.now()-started; row.finished_at = new Date().toISOString(); persist(); return result;
      } catch (error) {
        row.status = 'FAILED'; row.error_code = error.code || 'REQUEST_FAILED';
        row.usage = usageOf(error.details); row.usage_raw = error.details?.usage_raw ? structuredClone(error.details.usage_raw) : null;
        row.billing = billingOf(row.usage); row.duration_ms = Date.now()-started; row.finished_at = new Date().toISOString(); persist(); throw error;
      }
    },
  };
}
export function summarizeUsage(attempts) {
  const sums = {}, missing = attempts.filter(a => totalTokensOf(a.usage) === null).length;
  const details = {};
  const collect = (value,prefix='') => { for (const [key,item] of Object.entries(value || {})) {
    const path = prefix ? prefix+'.'+key : key;
    if (Number.isFinite(item) && item >= 0) { const target = prefix ? details : sums; target[path] = (target[path] || 0)+item; }
    else if (item && typeof item === 'object' && !Array.isArray(item)) collect(item,path);
  } };
  for (const row of attempts) collect(row.usage);
  return { reported: sums, reported_details:details,unknown_attempts: missing,
    fields_reported_attempts:attempts.filter(a => a.usage).length,
    known_total_tokens:attempts.reduce((n,a) => n+(totalTokensOf(a.usage) || 0),0),
    total_tokens:missing || !attempts.length ? null : attempts.reduce((n,a) => n+totalTokensOf(a.usage),0),complete: attempts.length > 0 && missing === 0,
    note: 'Raw usage fields are separate. total_tokens is not added to prompt/completion or cache/reasoning detail.' };
}
