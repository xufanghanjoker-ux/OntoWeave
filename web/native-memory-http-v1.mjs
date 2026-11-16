/** Thin product transport. Authentication, origin policy and service authorization are injected. */
const PREFIX = '/api/product/memory/v1';
const MAX_ERROR_CODE = 96;
const ERROR_STATUSES = new Set([400, 401, 403, 404, 409, 413, 503]);

function failure(code, status = 400) { return Object.assign(new Error(code), {code, status}); }
function need(condition, code, status = 400) { if (!condition) throw failure(code, status); }
function string(value, field, max = 1048576) {
  need(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000]/.test(value), `MEMORY_HTTP_${field.toUpperCase()}_INVALID`);
  return value;
}
function whitelist(value, fields) {
  need(value && typeof value === 'object' && !Array.isArray(value), 'MEMORY_HTTP_BODY_INVALID');
  need(Object.keys(value).every(key => fields.includes(key)), 'MEMORY_HTTP_FIELD_INVALID');
}
function pageSize(value, fromQuery) {
  if (value === undefined) return undefined;
  if (fromQuery) need(typeof value === 'string' && /^[1-9]\d*$/.test(value), 'MEMORY_HTTP_PAGE_SIZE_INVALID');
  const size = fromQuery ? Number(value) : value;
  need(Number.isSafeInteger(size) && size >= 1 && size <= 50, 'MEMORY_HTTP_PAGE_SIZE_INVALID');
  return size;
}
function optionalCursor(value) { return value === undefined ? undefined : string(value, 'cursor', 8192); }

function route(method, pathname) {
  if (pathname === `${PREFIX}/temporal/candidates` && method === 'GET')
    return {call:'listTemporalCandidates', action:'read', temporal:true, query:['library_id','run_id','revision_ref']};
  if (pathname === `${PREFIX}/temporal/query` && method === 'POST')
    return {call:'readTemporalFacts', action:'read', temporal:true, fields:['library_id','at','as_of','view_ref']};
  if (pathname === `${PREFIX}/temporal/changes` && method === 'POST')
    return {call:'publishTemporalChange', action:'write', write:true, temporal:true,
      fields:['library_id','request_id','operation','knowledge_ref','revision_ref','run_id','fact_ref','text','value','valid_time','reason','single_valued','conditions']};
  if (pathname === `${PREFIX}/records`) {
    if (method === 'POST') return {call:'saveRecord', action:'write', write:true, fields:['library_id','request_id','text','valid_time','context_refs']};
    if (method === 'GET') return {call:'listRecords', action:'read', query:['library_id','page_size','cursor']};
  }
  if (pathname === `${PREFIX}/search` && method === 'POST') return {call:'search', action:'search', fields:['library_id','query','page_size','cursor']};
  const match = /^\/api\/product\/memory\/v1\/records\/([^/]+)(?:\/(results|corrections|status))?$/.exec(pathname);
  if (!match) return null;
  const [,encodedRef, operation] = match;
  let definition;
  if (!operation && method === 'GET') definition = {call:'readRecord',action:'read',query:['library_id']};
  if (operation === 'status' && method === 'GET') definition = {call:'getStatus',action:'read',query:['library_id']};
  if (operation === 'results' && method === 'POST') definition = {call:'appendResult',action:'write',write:true,fields:['library_id','request_id','text','valid_time']};
  if (operation === 'corrections' && method === 'POST') definition = {call:'correctRecord',action:'write',write:true,fields:['library_id','request_id','text','reason','valid_time']};
  return definition ? {...definition,encodedRef} : null;
}

function readBody(req, maxBodyBytes) {
  const contentType = req.headers?.['content-type'];
  need(typeof contentType === 'string' && /^application\/json(?:\s*;|\s*$)/i.test(contentType), 'MEMORY_HTTP_CONTENT_TYPE_INVALID');
  const length = req.headers?.['content-length'];
  if (length !== undefined) {
    need(typeof length === 'string' && /^\d+$/.test(length), 'MEMORY_HTTP_CONTENT_LENGTH_INVALID');
    if (Number(length) > maxBodyBytes) { req.resume(); throw failure('MEMORY_HTTP_BODY_TOO_LARGE', 413); }
  }
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0;
    const cleanup = () => { req.removeListener('data', onData); req.removeListener('end', onEnd); req.removeListener('error', onError); req.removeListener('aborted', onAborted); };
    const fail = error => { cleanup(); req.resume(); reject(error); };
    const onData = chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBodyBytes) { fail(failure('MEMORY_HTTP_BODY_TOO_LARGE', 413)); return; }
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      try { resolve(JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks)))); }
      catch { reject(failure('MEMORY_HTTP_JSON_INVALID')); }
    };
    const onError = () => fail(failure('MEMORY_HTTP_BODY_UNAVAILABLE', 400));
    const onAborted = () => fail(failure('MEMORY_HTTP_BODY_ABORTED', 400));
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError); req.on('aborted', onAborted);
  });
}

function queryValues(url, fields) {
  const values = {};
  for (const key of url.searchParams.keys()) {
    need(fields.includes(key) && url.searchParams.getAll(key).length === 1, 'MEMORY_HTTP_QUERY_INVALID');
    values[key] = url.searchParams.get(key);
  }
  return values;
}
function argumentsFor(definition, values) {
  const result = {library_id:string(values.library_id, 'library_id', 160)};
  if (definition.temporal) {
    for (const key of ['run_id','revision_ref','knowledge_ref','fact_ref','view_ref'])
      if (values[key] !== undefined) result[key] = string(values[key], key, 512);
    for (const key of ['at','as_of','value','valid_time','conditions'])
      if (values[key] !== undefined) result[key] = values[key];
    for (const key of ['text','reason'])
      if (values[key] !== undefined) result[key] = string(values[key], key);
    if (values.single_valued !== undefined) {
      need(typeof values.single_valued === 'boolean', 'MEMORY_HTTP_SINGLE_VALUED_INVALID');
      result.single_valued = values.single_valued;
    }
    if (definition.write) {
      result.request_id = string(values.request_id, 'request_id', 200);
      result.operation = string(values.operation, 'operation', 128);
    }
    return result;
  }
  if (definition.encodedRef !== undefined) {
    let ref;
    try { ref = decodeURIComponent(definition.encodedRef); } catch { throw failure('MEMORY_HTTP_RECORD_REF_INVALID'); }
    result.record_ref = string(ref, 'record_ref', 512);
    need(!/[\\/\u0000-\u001f\u007f]/.test(ref), 'MEMORY_HTTP_RECORD_REF_INVALID');
  }
  if (definition.write) {
    result.request_id = string(values.request_id, 'request_id', 200);
    result.text = string(values.text, 'text');
    if (values.valid_time !== undefined) result.valid_time = values.valid_time;
    if (definition.call === 'saveRecord' && values.context_refs !== undefined) {
      need(Array.isArray(values.context_refs), 'MEMORY_HTTP_CONTEXT_REFS_INVALID');
      result.context_refs = values.context_refs;
    }
    if (definition.call === 'correctRecord') result.reason = string(values.reason, 'reason');
  }
  if (definition.call === 'search') result.query = string(values.query, 'query');
  if (['listRecords','search'].includes(definition.call)) {
    if (values.page_size !== undefined) result.page_size = pageSize(values.page_size, !!definition.query);
    if (values.cursor !== undefined) result.cursor = optionalCursor(values.cursor);
  }
  return result;
}
function errorResponse(error) {
  const rawCode = typeof error?.code === 'string' ? error.code : '';
  const code = /^[A-Z][A-Z0-9_]{0,95}$/.test(rawCode) ? rawCode.slice(0,MAX_ERROR_CODE) : 'MEMORY_HTTP_UNAVAILABLE';
  let status = ERROR_STATUSES.has(error?.status) ? error.status : ERROR_STATUSES.has(error?.statusCode) ? error.statusCode : null;
  if (status === null) {
    if (/(?:UNAUTHENTICATED|AUTH_REQUIRED|TOKEN_INVALID|TOKEN_MISSING)/.test(code)) status = 401;
    else if (/(?:FORBIDDEN|UNAUTHORIZED|PERMISSION|ACCESS_DENIED|CROSS_LIBRARY)/.test(code)) status = 403;
    else if (/(?:NOT_FOUND|UNKNOWN_RECORD)/.test(code)) status = 404;
    else if (/(?:CONFLICT|STALE|CONCURRENT|BUSY|REPLAY|PENDING)/.test(code)) status = 409;
    else if (/(?:TOO_LARGE|SIZE_EXCEEDED)/.test(code)) status = 413;
    else if (/(?:INVALID|REQUIRED|UNSUPPORTED|ARGUMENT|HISTORY)/.test(code)) status = 400;
    else status = 503;
  }
  // Error messages, stacks, request bodies and credentials never cross this transport boundary.
  return {status, body:{error:{code}}};
}
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(body);
}

export function createMemoryHttpHandler({service, authenticateRequest, maxBodyBytes = 1048576} = {}) {
  need(service && typeof service === 'object', 'MEMORY_HTTP_SERVICE_REQUIRED');
  need(typeof authenticateRequest === 'function', 'MEMORY_HTTP_AUTHENTICATOR_REQUIRED');
  need(Number.isSafeInteger(maxBodyBytes) && maxBodyBytes > 0, 'MEMORY_HTTP_BODY_LIMIT_INVALID');
  for (const method of ['saveRecord','readRecord','appendResult','correctRecord','getStatus','listRecords','search']) need(typeof service[method] === 'function', 'MEMORY_HTTP_SERVICE_INVALID');
  return async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://memory.local'); } catch { return false; }
    const definition = route(req.method, url.pathname);
    if (!definition) return false;
    try {
      const values = definition.query ? queryValues(url, definition.query) : await readBody(req,maxBodyBytes);
      if (!definition.query) {
        need([...url.searchParams.keys()].length === 0, 'MEMORY_HTTP_QUERY_INVALID');
        whitelist(values,definition.fields);
      }
      const args = argumentsFor(definition, values);
      let auth;
      try { auth = await authenticateRequest(req, {library_id:args.library_id,action:definition.action}); }
      catch (error) { throw Object.assign(failure('MEMORY_HTTP_AUTH_REQUIRED',401), {code:typeof error?.code === 'string' ? error.code : 'MEMORY_HTTP_AUTH_REQUIRED',status:error?.status === 403 || error?.statusCode === 403 ? 403 : 401}); }
      need(auth !== null && auth !== undefined && auth !== false, 'MEMORY_HTTP_AUTH_REQUIRED', 401);
      if (definition.temporal) need(typeof service[definition.call] === 'function', 'MEMORY_TEMPORAL_UNAVAILABLE', 503);
      const result = await service[definition.call]({...args,auth});
      json(res,definition.write ? 202 : 200,result);
    } catch (error) {
      if (res.headersSent) { res.end(); return true; }
      const response = errorResponse(error); json(res,response.status,response.body);
    }
    return true;
  };
}
