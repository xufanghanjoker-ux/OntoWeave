/** Loopback transport for the shared memory service. No store, model, or retry path. */

const ROOT = '/api/product/memory/v1';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ownsOnly = (value, keys) => object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Object.keys(value).every(key => keys.includes(key));
const string = (value, max = 512) => typeof value === 'string' && value.trim().length > 0 &&
  value.isWellFormed() && [...value].length <= max;
const reference = value => string(value) && !/[\u0000-\u001f\u007f]/u.test(value) && value !== '.' && value !== '..';
const text = value => typeof value === 'string' && value.trim().length > 0 && value.isWellFormed() && [...value].length <= 16000;
const key = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/u.test(value);
const messages = Object.freeze({
  LOCAL_CLIENT_CONFIG_INVALID: 'Invalid local memory client configuration.',
  INVALID_ARGUMENTS: 'Invalid memory service arguments or Host request metadata.',
  ACCESS_REQUIRED: 'The local memory service requires valid access.',
  ACCESS_DENIED: 'The local memory service denied this request.',
  LOCAL_SERVICE_NOT_FOUND: 'The requested local memory service resource was not found.',
  REQUEST_CONFLICT: 'The local memory service rejected a conflicting request.',
  REQUEST_TOO_LARGE: 'The local memory service rejected an oversized request.',
  SERVICE_REQUEST_REJECTED: 'The local memory service rejected this request.',
  LOCAL_SERVICE_UNAVAILABLE: 'The local memory service is unavailable.',
  LOCAL_SERVICE_TIMEOUT: 'The local memory service request timed out.',
  LOCAL_REQUEST_CANCELLED: 'The local memory service request was cancelled.',
  INVALID_SERVICE_RESPONSE: 'The local memory service returned an invalid response.',
  RESPONSE_TOO_LARGE: 'The local memory service response exceeded its byte limit.',
  SCOPE_MISMATCH: 'The local memory service response did not match the bound scope.',
  UNKNOWN: 'The write outcome is unknown. Check the existing request; do not retry automatically.'
});

function failure(code, outcome, requestRef, httpStatus) {
  const error = new Error(messages[code]);
  error.name = 'LightogMemoryMcpClientError';
  Object.assign(error, { code, outcome, no_auto_retry: true });
  if (requestRef) error.request_ref = requestRef;
  if (httpStatus !== undefined) error.http_status = httpStatus;
  return error;
}

// Private markers never preserve upstream errors, response text, URLs, or credentials.
const problems = new WeakSet();
const problem = (code, httpStatus) => {
  const marker = { code, httpStatus };
  problems.add(marker);
  return marker;
};

function validTime(value) {
  if (!ownsOnly(value, ['kind', 'occurred_at', 'valid_from', 'valid_to', 'time_text'])) return false;
  if (value.kind !== undefined && !['INSTANT', 'INTERVAL', 'UNRESOLVED', 'TIMELESS'].includes(value.kind)) return false;
  if (value.time_text !== undefined && !string(value.time_text, 1024)) return false;
  for (const field of ['occurred_at', 'valid_from', 'valid_to']) {
    if (value[field] === undefined) continue;
    const endpoint = value[field];
    if (!ownsOnly(endpoint, ['kind', 'value', 'precision', 'timezone', 'time_text']) ||
      !['KNOWN', 'UNKNOWN', 'OPEN_AS_REPORTED', 'UNKNOWN_ENDED'].includes(endpoint.kind)) return false;
    for (const name of ['value', 'precision', 'timezone', 'time_text']) {
      if (endpoint[name] !== undefined && !string(endpoint[name], name === 'time_text' ? 1024 : 128)) return false;
    }
  }
  return true; // Time interpretation and consistency belong to the shared core.
}

function readInput(input) {
  return ownsOnly(input, ['record_ref']) && reference(input.record_ref);
}

function writeInput(input, supplement) {
  const fields = supplement ? ['record_ref', 'text', 'source', 'valid_time'] : ['text', 'source', 'valid_time', 'related_record_ref'];
  return ownsOnly(input, fields) && text(input.text) &&
    ownsOnly(input.source, ['kind']) && input.source.kind === 'AGENT_REPORT' &&
    (!supplement || reference(input.record_ref)) &&
    (input.related_record_ref === undefined || reference(input.related_record_ref)) &&
    (input.valid_time === undefined || validTime(input.valid_time));
}

function searchInput(input) {
  return ownsOnly(input, ['query', 'limit', 'evidence_limit']) && string(input.query, 2000) &&
    (input.limit === undefined || Number.isInteger(input.limit) && input.limit >= 1 && input.limit <= 10) &&
    (input.evidence_limit === undefined || Number.isInteger(input.evidence_limit) && input.evidence_limit >= 0 && input.evidence_limit <= 3);
}

const rejectionCode = status => ({ 401: 'ACCESS_REQUIRED', 403: 'ACCESS_DENIED', 404: 'LOCAL_SERVICE_NOT_FOUND',
  409: 'REQUEST_CONFLICT', 413: 'REQUEST_TOO_LARGE' }[status] ?? 'SERVICE_REQUEST_REJECTED');

async function boundedJson(response, maxBytes, signal) {
  const length = response.headers?.get?.('content-length');
  if (typeof length === 'string' && /^\d+$/u.test(length) && Number(length) > maxBytes) throw problem('RESPONSE_TOO_LARGE');
  if (!response.body || typeof response.body.getReader !== 'function') throw problem('INVALID_SERVICE_RESPONSE');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
  signal.addEventListener('abort', cancel, { once: true });
  let bytes = 0;
  let body = '';
  try {
    for (;;) {
      if (signal.aborted) throw problem('LOCAL_REQUEST_CANCELLED');
      const { done, value } = await reader.read();
      if (signal.aborted) throw problem('LOCAL_REQUEST_CANCELLED');
      if (done) break;
      if (!(value instanceof Uint8Array)) throw problem('INVALID_SERVICE_RESPONSE');
      bytes += value.byteLength;
      if (bytes > maxBytes) throw problem('RESPONSE_TOO_LARGE');
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body);
  } catch (error) {
    // Cancellation is best effort; an injected/hung stream cannot delay the timeout result.
    cancel();
    if (problems.has(error)) throw error;
    throw problem('INVALID_SERVICE_RESPONSE');
  } finally {
    signal.removeEventListener('abort', cancel);
    try { reader.releaseLock(); } catch {}
  }
}

export function createLightogMemoryMcpClient({ url, token, binding, fetchImpl = globalThis.fetch,
  timeoutMs = 60000, maxResponseBytes = 131072 } = {}) {
  let base;
  try { base = typeof url === 'string' && url.trim() === url ? new URL(url) : null; } catch {}
  if (!base || base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
    base.username || base.password || base.pathname !== '/' || base.search || base.hash ||
    typeof token !== 'string' || !/^[\x21-\x7e]{1,16384}$/u.test(token) ||
    !ownsOnly(binding, ['workspace_id', 'library_id']) || Object.keys(binding).length !== 2 ||
    !reference(binding.workspace_id) || !reference(binding.library_id) || typeof fetchImpl !== 'function' ||
    !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647 ||
    !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw failure('LOCAL_CLIENT_CONFIG_INVALID', 'NOT_SENT');
  }
  const bound = Object.freeze({ workspace_id: binding.workspace_id, library_id: binding.library_id });
  const origin = base.origin;
  const validKey = value => key(value) && !value.includes(token);

  async function request(path, method, body, context, write) {
    if (!ownsOnly(context, ['signal', 'request_ref', 'idempotency_key']) ||
      context.request_ref !== undefined && !validKey(context.request_ref) ||
      context.idempotency_key !== undefined && !validKey(context.idempotency_key) ||
      write && (!validKey(context.request_ref) || !validKey(context.idempotency_key)) ||
      context.signal !== undefined && (!object(context.signal) || typeof context.signal.aborted !== 'boolean' ||
        typeof context.signal.addEventListener !== 'function' || typeof context.signal.removeEventListener !== 'function')) {
      throw failure('INVALID_ARGUMENTS', 'NOT_SENT');
    }
    const requestRef = context.request_ref;
    if (context.signal?.aborted) throw failure('LOCAL_REQUEST_CANCELLED', 'NOT_SENT', requestRef);
    const controller = new AbortController();
    const endpoint = origin + ROOT + path;
    const headers = { Accept: 'application/json', Authorization: 'Bearer ' + token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (requestRef) headers['X-LightOG-Request-Ref'] = requestRef;
    if (write) headers['Idempotency-Key'] = context.idempotency_key;
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    let attempted = false;
    let stopCode;
    let stop;
    const stopped = new Promise((_, reject) => { stop = code => {
      if (stopCode) return;
      stopCode = code;
      controller.abort();
      reject(problem(code));
    }; });
    const onAbort = () => stop('LOCAL_REQUEST_CANCELLED');
    const timer = setTimeout(() => stop('LOCAL_SERVICE_TIMEOUT'), timeoutMs);
    context.signal?.addEventListener('abort', onAbort, { once: true });
    const work = async () => {
      attempted = true;
      const response = await fetchImpl(endpoint, { method, headers, ...(serialized === undefined ? {} : { body: serialized }),
        redirect: 'error', credentials: 'omit', signal: controller.signal });
      if (stopCode) throw problem(stopCode);
      if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599 ||
        response.redirected || response.url && response.url !== endpoint) throw problem('INVALID_SERVICE_RESPONSE');
      if (response.status < 200 || response.status > 299) {
        if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
          throw problem(rejectionCode(response.status), response.status);
        }
        throw problem('LOCAL_SERVICE_UNAVAILABLE', response.status);
      }
      const envelope = await boundedJson(response, maxResponseBytes, controller.signal);
      if (!object(envelope) || !object(envelope.data) ||
        envelope.service_instance_ref !== undefined && !reference(envelope.service_instance_ref)) throw problem('INVALID_SERVICE_RESPONSE');
      if (!ownsOnly(envelope.scope, ['workspace_id', 'library_id']) || Object.keys(envelope.scope).length !== 2 ||
        envelope.scope.workspace_id !== bound.workspace_id || envelope.scope.library_id !== bound.library_id) throw problem('SCOPE_MISMATCH');
      return envelope; // Preserve the validated envelope and its legitimate extra receipt fields.
    };
    try {
      return await Promise.race([work(), stopped]);
    } catch (error) {
      const trusted = problems.has(error);
      if (trusted && error.httpStatus >= 400 && error.httpStatus < 500 && ![408, 429].includes(error.httpStatus)) {
        throw failure(error.code, 'REJECTED', requestRef, error.httpStatus);
      }
      if (write && attempted) throw failure('UNKNOWN', 'UNKNOWN', requestRef);
      throw failure(stopCode ?? (trusted ? error.code : 'LOCAL_SERVICE_UNAVAILABLE'), 'FAILED', requestRef,
        trusted ? error.httpStatus : undefined);
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }

  function checked(ok, context) {
    if (!ok) throw failure('INVALID_ARGUMENTS', 'NOT_SENT', validKey(context?.request_ref) ? context.request_ref : undefined);
  }
  const wireText = input => ({ text: input.text, ...(input.valid_time === undefined ? {} : { valid_time: input.valid_time }),
    ...(input.related_record_ref === undefined ? {} : { related_record_ref: input.related_record_ref }) });
  return Object.freeze({
    binding: bound,
    async search(input, context = {}) {
      checked(searchInput(input), context);
      return request('/search', 'POST', input, context, false);
    },
    async getRecord(input, context = {}) {
      checked(readInput(input), context);
      return request('/records/' + encodeURIComponent(input.record_ref), 'GET', undefined, context, false);
    },
    async appendRecord(input, context = {}) {
      checked(writeInput(input, false), context);
      return request('/records', 'POST', wireText(input), context, true);
    },
    async addResult(input, context = {}) {
      checked(writeInput(input, true), context);
      return request('/records/' + encodeURIComponent(input.record_ref) + '/results', 'POST', wireText(input), context, true);
    },
    async getStatus(input, context = {}) {
      checked(readInput(input), context);
      return request('/records/' + encodeURIComponent(input.record_ref) + '/status', 'GET', undefined, context, false);
    }
  });
}
