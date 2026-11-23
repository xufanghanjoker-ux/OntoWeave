import {createServer, request as httpRequest} from 'node:http';
import {registerPgQuery} from './ontoweave-pg-query-registration-v1.mjs';
import {serveWorkbenchAsset, unifiedAssets} from './workbench-assets.mjs';

export function createPGWorkbench(config, writeToken) {
  const endpoint = new URL(config.api_origin);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' ||
      endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw Error('ONTOWEAVE_PG_API_MUST_BE_LOOPBACK');
  }
  const dynamic = Boolean(config.workspace_registry);
  const assets = unifiedAssets();
  const libraries = (config.libraries ?? []).map(({library_ref, title, backend}) => {
    if (backend !== 'PG' || typeof library_ref !== 'string' || !library_ref || typeof title !== 'string')
      throw Error('ONTOWEAVE_PG_REGISTRY_INVALID');
    return {library_ref, title};
  });
  const registry = new Set(libraries.map(row => row.library_ref));
  if (registry.size !== libraries.length || (!dynamic && config.default_library_ref != null && !registry.has(config.default_library_ref)) || !writeToken) {
    throw Error('ONTOWEAVE_PG_REGISTRY_INVALID');
  }
  const descriptor = {libraries, default_library_ref:config.default_library_ref, ...(config.query ? {query_enabled:true} : {})};
  const registryRead = async path => {
    const response = await fetch(new URL(path, endpoint), {redirect:'error', signal:AbortSignal.timeout(10000),
      headers:{Accept:'application/json', 'X-Ontoweave-Write-Token':writeToken}});
    const data = await response.json();
    return {response,data};
  };
  const authorizeLibrary = async (library, action) => {
    if (!dynamic) return registry.has(library);
    const {response,data} = await registryRead('/_ontoweave/libraries/' + encodeURIComponent(library));
    return response.ok && data.library_ref === library && data.query_registered === true &&
      (action !== 'ask' || (data.workspace_state !== 'ARCHIVED' && data.model_ready !== false));
  };
  const send = (res, status, body) => {
    res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    res.end(JSON.stringify(body));
  };
  const reject = (res, status, code) => send(res, status, {error:{
    code, message:code, retryable:false, request_ref:null, details:{}
  }});
  const pgQuery = registerPgQuery({query:config.query, endpoint, writeToken, authorizeLibrary, json:send,
    rotatingCredential:config.model_settings_enabled === true});
  const server = createServer(async (req, res) => {
    const {port} = server.address();
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host)) return reject(res, 403, 'LOCAL_HOST_REQUIRED');
    try {
      const requested = new URL(req.url, 'http://127.0.0.1');
      const path = requested.pathname;
      if (pgQuery && await pgQuery.handle({req,res,pathname:path})) return;
      if (path === '/api/bootstrap' && req.method === 'GET') {
        if (!dynamic) return send(res, 200, {ontoweave_pg:descriptor});
        try {
          const {response,data} = await registryRead('/api/v1/libraries');
          if (!response.ok) return reject(res, 503, 'PG_API_UNAVAILABLE');
          return send(res, 200, {ontoweave_pg:{...descriptor, libraries:data.items,
            default_library_ref:data.default_library_ref, create_enabled:data.create_enabled,
            client_contract:'ontoweave-workbench-client/2'}});
        } catch { return reject(res, 503, 'PG_API_UNAVAILABLE'); }
      }
      if (path === '/api/v1/openapi.json' || path === '/api/v1/libraries' || path === '/api/v1/models' ||
          path.startsWith('/api/v1/libraries/')) {
        if (!['GET','POST'].includes(req.method)) return reject(res, 405, 'METHOD_NOT_ALLOWED');
        const match = /^\/api\/v1\/libraries\/([^/]+)\//.exec(path);
        if (path.startsWith('/api/v1/libraries/') && (!match || (!dynamic && !registry.has(decodeURIComponent(match[1])))))
          return reject(res, 404, 'LIBRARY_NOT_FOUND');
        const sameOrigin = req.headers.origin === 'http://' + req.headers.host;
        if ((req.headers.origin && !sameOrigin) || (req.method === 'POST' && !sameOrigin))
          return reject(res, 403, 'SAME_ORIGIN_REQUIRED');
        const headers = {};
        for (const name of ['accept','content-type','content-length','last-event-id','x-request-id']) {
          if (req.headers[name] !== undefined) headers[name] = req.headers[name];
        }
        if (req.method === 'POST') headers['x-ontoweave-write-token'] = writeToken;
        const upstream = httpRequest(endpoint, {method:req.method, path:path + requested.search, headers}, (reply) => {
          const responseHeaders = {};
          for (const name of ['content-type','cache-control','x-accel-buffering','content-disposition','x-content-type-options']) {
            if (reply.headers[name] !== undefined) responseHeaders[name] = reply.headers[name];
          }
          res.writeHead(reply.statusCode, responseHeaders);
          res.flushHeaders();
          reply.on('error', () => res.destroy());
          reply.pipe(res);
        });
        upstream.on('error', () => {
          if (res.headersSent) res.destroy();
          else reject(res, 503, 'PG_API_UNAVAILABLE');
        });
        res.on('close', () => upstream.destroy());
        req.pipe(upstream);
        return;
      }
      if (!serveWorkbenchAsset(req, res, path, assets)) reject(res, 404, 'NOT_FOUND');
    } catch (error) {
      reject(res, error instanceof URIError ? 400 : 404, error instanceof URIError ? 'PATH_INVALID' : 'NOT_FOUND');
    }
  });
  if (pgQuery) server.once('close', () => {
    void pgQuery.close().catch(error => {
      const code=/^[A-Z0-9_]{1,96}$/.test(error?.code??'')?error.code:'QUERY_GATEWAY_CLOSE_FAILED';
      console.error('PG query gateway close failed:',code);
    });
  });
  return server;
}
