import {knowledgeBases} from './knowledge-bases.mjs';
import {createLibraryManagement,assertLibraryActive,libraryActive} from './library-management.mjs';
import {assessLearning,admissionFingerprint} from './learning-admission.mjs';
import {intentDisposition} from './query-intent.mjs';
import {openAnswerStream} from './answer-stream.mjs';
/** Loopback-only prototype server. Model credentials stay in this process, never on disk. */
import { createServer, request as httpRequest } from 'node:http';
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, existsSync, unlinkSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, relative } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createProvider } from '../experiments/model-loop/provider.mjs';
import {recoveryCheckpointBank,technicalSuccessor} from './recovery-checkpoints.mjs';
import{createLearningIndex,createLearningLedger}from'./learning-index.mjs';
import { readCredential } from '../experiments/model-loop/credential.mjs';
import { validateInput, validateBuildInput, runPipeline, answerCQ, sha, queryPlanIssues } from './engine.mjs';
import { createDocumentStore } from './documents.mjs';
import { diagnoseTask } from './diagnostics.mjs';
import { revisionAudit, versionDiff } from './revisions.mjs';
import { connectGraph } from './graph.mjs';
import { createStore, atomicFile } from './store.mjs';
import { supportedNode, parserHealth } from './runtime.mjs';
import { meteredProvider, recoverAttempts } from './operations.mjs';
import {resolveLearningHolds} from './learning-extension.mjs';
import {learningObservationId,STRUCTURE_CONTRACT} from './structure-learning.mjs';
import {workbenchReviewPrompt} from './review-protocol.mjs';
import {createSemanticMemory,semanticScope} from './semantic-memory.mjs';
import { createCapabilityCatalog, executeTyped, routeQuestion } from './capabilities.mjs';
import { proposeCQs, confirmCQProposal } from './cq-proposals.mjs';
import { answerFromClaims } from './value-adapter.mjs';
import { makeDataset } from '../fixtures/value-bench-v1/dataset.mjs';
import { prepareBenchmark, runBenchmark } from '../experiments/value-bench/runner.mjs';
import { reportCsv } from '../experiments/value-bench/score.mjs';
import { createCQForgeAdapter } from './value-adapter.mjs';
import { createEmbeddingProvider } from '../experiments/value-bench/embedding.mjs';
import { reviewedReport } from './benchmark-reviews.mjs';
import { createBudgets, modelProfile } from './budgets.mjs';
import { taskDiagnostics, taskIssues } from './task-issues.mjs';
import { validateWorkspaceDraft, questionBacklogItem } from './workspace-state.mjs';
import { buildHumanReview, validateReviewDecision, applyReviewDecisions } from './human-review.mjs';
import { reviewHumanCandidate, continuationProfile } from './human-review-runner.mjs';
import { sourcePreview } from './source-preview.mjs';
import { extractionUnits } from './source-context.mjs';
import { createGovernance, sourceKey } from './knowledge-governance.mjs';
import { groupReviewIssues, expandGroupDecision } from './review-groups.mjs';
import { recoveryEligibility } from './safe-recovery.mjs';
import { createLearningBatches } from './learning-batches.mjs';
import { planComponentPublication } from './component-publication.mjs';
import { componentDecisionGroups,prepareComponentDecision } from './review-component-groups.mjs';
import {createIntegrationAccess,accessError} from './integration-access.mjs';
import {libraryContract,jobContract,answerContract,integrationRequestId} from './external-contract.mjs';
import {createSourceProductHost} from './source-product-host-v1.mjs';
import {createSourceFirstHttp} from './source-first-http-v1.mjs';
import {createProductRuntime} from './product-runtime-v1.mjs';
import {createProductHttp} from './product-http-v1.mjs';
import {createNativeFullChainProduct} from './native-full-chain-product-v1.mjs';
import {createNativeDocumentTemporalPublication} from './native-document-temporal-publication-v1.mjs';
import {createProductReviews} from './product-review-store-v1.mjs';
import {createSourceCore} from './source-core-client-v1.mjs';
import {prepareProductInput,prepareProductDraft} from './product-input-v1.mjs';
import {createTemporalQueryReaderPort} from './native-query-temporal-reader-v2.mjs';
import {createNativeQueryProduct} from './native-query-product-v1.mjs';
import {registerPgQuery} from './ontoweave-pg-query-registration-v1.mjs';
import {createNativeQueryHttp} from './native-query-http-v1.mjs';
import {createNativeExtractedQueryReader} from './native-query-extracted-reader-v1.mjs';
import {createProductDocumentCatalog} from './document-catalog-v1.mjs';
import {createMemoryProductRuntime} from './native-memory-product-runtime-v1.mjs';
import {createNativeActionProcessingPort,verifyNativeActionPrepared} from './native-action-processing-host-v1.mjs';
import {prepareNativeActionLibraryForMemoryProduct} from './native-action-library-preparation-v1.mjs';
import {createNativeActionOrganizationReusePort} from './native-action-organization-reuse-host-v1.mjs';
import {createMemoryMaintenanceRuntime} from './native-memory-maintenance-runtime-v1.mjs';
import {createMemoryMaintenanceOutcomeReader} from './native-memory-maintenance-outcome-v1.mjs';
import {createMemoryMaintenanceHttpHandler} from './native-memory-maintenance-http-v1.mjs';
import {createMemoryLibraryContextCandidate} from './native-memory-library-context-candidate-v1.mjs';
import {selectedNativeSkills} from './native-agent-runtime-v1.mjs';
import {createLightogMemoryMcpHttpHandler} from './lightog-memory-mcp-http-v1.mjs';
import {createMemoryHttpHandler} from './native-memory-http-v1.mjs';
import {createLightogMemoryServerIntegration} from './lightog-memory-server-integration-v1.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const webRoot = fileURLToPath(new URL('./', import.meta.url));
const stageLabels = { DRAFT: '修订草稿 · 尚未发送模型', queued: '等待开始', scope:'正在整理相关主体与问题',structure_discovery:'正在理解资料关联',structure_audit:'正在核对关联与依据', schema: 'Builder · 生成本体', independent_reading: 'Evaluator · 独立阅读',
  schema_review: 'Evaluator · 评审本体', extraction: 'Extractor · 抽取声明', claims_review: 'Evaluator · 复核声明',
  READY: '可查询 · shadow版本', REVIEW_REQUIRED: '待处理 · 未通过门禁', PAUSED:'调用额度用完 · 已暂停', FAILED: '执行失败', INTERRUPTED: '服务重启 · 任务中断', CANCELLED: '任务已停止' };
const idPattern = /^[a-f0-9-]{36}$/;

const WORKBENCH_ASSETS = { '/': ['index.html', 'text/html'], '/app.mjs': ['app.mjs', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/lightog.css':['lightog.css','text/css'],
        '/ontoweave-pg-api-v1.mjs':['ontoweave-pg-api-v1.mjs','text/javascript'],
        '/ontoweave-pg-workspace-v1.mjs':['ontoweave-pg-workspace-v1.mjs','text/javascript'],
        '/ontoweave-pg-workspace-v1.css':['ontoweave-pg-workspace-v1.css','text/css'],
        '/lightog-memory-client-v1.mjs':['lightog-memory-client-v1.mjs','text/javascript'],
        '/lightog-memory-current-view-v1.mjs':['lightog-memory-current-view-v1.mjs','text/javascript'],
        '/lightog-memory-view-v1.mjs':['lightog-memory-view-v1.mjs','text/javascript'],
        '/lightog-contextual-memory-v1.mjs':['lightog-contextual-memory-v1.mjs','text/javascript'],
        '/lightog-memory-workspace-v1.mjs':['lightog-memory-workspace-v1.mjs','text/javascript'],
        '/source-first':['source-first.html','text/html'], '/source-first-app.mjs':['source-first-app.mjs','text/javascript'], '/source-first.css':['source-first.css','text/css'],
        '/product-library-ui-v1.mjs':['product-library-ui-v1.mjs','text/javascript'],
        '/lightog-workspace-v1.mjs':['lightog-workspace-v1.mjs','text/javascript'],
        '/lightog-workspace-view-v1.mjs':['lightog-workspace-view-v1.mjs','text/javascript'],
        '/lightog-correction-view-v1.mjs':['lightog-correction-view-v1.mjs','text/javascript'],
        '/lightog-workspace-v1.css':['lightog-workspace-v1.css','text/css'],
        '/lightog-chat-workspace-v1.mjs':['lightog-chat-workspace-v1.mjs','text/javascript'],
        '/lightog-chat-client-v1.mjs':['lightog-chat-client-v1.mjs','text/javascript'],
        '/lightog-chat-view-v1.mjs':['lightog-chat-view-v1.mjs','text/javascript'],
        '/lightog-chat-v1.css':['lightog-chat-v1.css','text/css'],
        '/assets/lightog-chat-markdown-v1.mjs':['assets/lightog-chat-markdown-v1.mjs','text/javascript'],
        '/assets/CHAT_MARKDOWN_THIRD_PARTY_LICENSES.txt':['assets/CHAT_MARKDOWN_THIRD_PARTY_LICENSES.txt','text/plain'],
        '/lightog-reading-data-v1.mjs':['lightog-reading-data-v1.mjs','text/javascript'],
        '/lightog-pending-classification-v1.mjs':['lightog-pending-classification-v1.mjs','text/javascript'],
        '/lightog-current-view-contract-v1.mjs':['lightog-current-view-contract-v1.mjs','text/javascript'],
        '/lightog-temporal-display-v1.mjs':['lightog-temporal-display-v1.mjs','text/javascript'],
        '/lightog-library-review-ui-v1.mjs':['lightog-library-review-ui-v1.mjs','text/javascript'],
        '/lightog-navigation-v1.mjs':['lightog-navigation-v1.mjs','text/javascript'],
        '/lightog-graph-filter-v1.mjs':['lightog-graph-filter-v1.mjs','text/javascript'],
        '/lightog-upload-v1.mjs':['lightog-upload-v1.mjs','text/javascript'],
        '/lightog-query-ui-v1.mjs':['lightog-query-ui-v1.mjs','text/javascript'],
        '/lightog-query-citations-v1.mjs':['lightog-query-citations-v1.mjs','text/javascript'],
        '/native-domain-graph-data-v1.mjs':['native-domain-graph-data-v1.mjs','text/javascript'],
        '/native-build-workbench-data-v1.mjs':['native-build-workbench-data-v1.mjs','text/javascript'],
        '/native-build-workbench-view-v1.mjs':['native-build-workbench-view-v1.mjs','text/javascript'],
        '/native-build-workbench-v1.css':['native-build-workbench-v1.css','text/css'],
        '/native-domain-graph-workbench-v1.css':['native-domain-graph-workbench-v1.css','text/css'],
        '/assets/graph-view.mjs':['assets/graph-view.mjs','text/javascript'],
        '/assets/graph-fa2-worker-v1.mjs':['assets/graph-fa2-worker-v1.mjs','text/javascript'],
        '/assets/graph-fa2-worker-v1.mjs.LEGAL.txt':['assets/graph-fa2-worker-v1.mjs.LEGAL.txt','text/plain'],
        '/assets/graph-view.mjs.LEGAL.txt':['assets/graph-view.mjs.LEGAL.txt','text/plain'],
        '/assets/THIRD_PARTY_LICENSES.txt':['assets/THIRD_PARTY_LICENSES.txt','text/plain'],
        '/fonts/geist-latin-wght-normal.woff2':['fonts/geist-latin-wght-normal.woff2','font/woff2'],
        '/fonts/manrope-latin-wght-normal.woff2':['fonts/manrope-latin-wght-normal.woff2','font/woff2'] };

function serveWorkbenchAsset(req, res, pathname, assets = WORKBENCH_ASSETS) {
  if (req.method !== 'GET' || !Object.hasOwn(assets, pathname)) return false;
  const [name, mime] = assets[pathname];
  const bytes = readFileSync(resolve(webRoot, name));
  res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff' });
  res.end(bytes);
  return true;
}

function unifiedAssets() {
  const assets = { ...WORKBENCH_ASSETS, '/': ['unified-workbench-v2.html', 'text/html'] };
  const approved = JSON.parse(readFileSync(resolve(webRoot, 'unified-workbench-v2.assets.json'), 'utf8'));
  if (!Array.isArray(approved)) throw Error('UNIFIED_WORKBENCH_ASSET_MANIFEST_INVALID');
  const root = realpathSync(webRoot) + '/';
  for (const filename of approved) {
    if (typeof filename !== 'string' || !/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:mjs|css)$/.test(filename) ||
        Object.hasOwn(assets, '/' + filename) || !realpathSync(resolve(webRoot, filename)).startsWith(root)) {
      throw Error('UNIFIED_WORKBENCH_ASSET_MANIFEST_INVALID');
    }
    assets['/' + filename] = [filename, filename.endsWith('.css') ? 'text/css' : 'text/javascript'];
  }
  return assets;
}

export function createPGWorkbench(config, writeToken) {
  const endpoint = new URL(config.api_origin);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' ||
      endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw Error('ONTOWEAVE_PG_API_MUST_BE_LOOPBACK');
  }
  const dynamic = Boolean(config.workspace_registry);
  const assets = config.unified_workbench_v2 ? unifiedAssets() : WORKBENCH_ASSETS;
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
  if (pgQuery) server.once('close', () => { void pgQuery.close(); });
  return server;
}

export function createWorkbench({ provider = null, profile = {}, storage = resolve(root, 'local-runs', 'workbench'), port = 4317,
  graphConnector = connectGraph, acceptance = false, instance = randomUUID(), control = randomBytes(32).toString('hex'), sourceFirstOptions = null } = {}) {
  mkdirSync(storage, { recursive: true });
  const store = createStore(storage);
  const governance=createGovernance(store);
  store.transaction(()=>{for(const task of store.listTasks())resolveLearningHolds(store,task);});
  const semanticMemory=createSemanticMemory(store);
  recoverAttempts(store);
  const identityFile = resolve(storage, 'workspace.json');
  if (!existsSync(identityFile)) writeFileSync(identityFile, JSON.stringify(store.getSetting('workspace') || { id: randomUUID() }), { flag: 'wx' });
  const workspace = JSON.parse(readFileSync(identityFile, 'utf8')).id;
  if (!idPattern.test(workspace)) throw Error('工作空间ID无效');
  const migration = store.migrate();
  store.db.prepare('INSERT OR IGNORE INTO settings VALUES(?,?)').run('workspace', JSON.stringify({ id: workspace }));
  const documents = createDocumentStore(resolve(storage, 'documents'), store);
  const token = randomBytes(32).toString('hex'), jobs = new Map(); let active = null, globalProvider = provider,
    globalProfile = { ...(store.getSetting('model') || {}), ...Object.fromEntries(Object.entries(profile).filter(([, v]) => v !== undefined)) }, graph = null;
  store.setProfile(globalProfile);
  const inheritedJobs=new WeakSet();
  const persist = job => {
    // A successor inherits one immutable parent snapshot, not one full DB read per field and event.
    if(job.revision?.parent_id&&!inheritedJobs.has(job)){
      const parent=store.getTask(job.revision.parent_id);
      if(parent){
        if(job.internal_scope===undefined&&parent.internal_scope===true)job.internal_scope=true;
        if(['HUMAN_REVIEW_CONTINUE','TECHNICAL_RESUME','TECHNICAL_RETRY'].includes(job.revision.kind)){
          for(const field of ['learning','learning_resolution','component_base_task_id','component_resume_origin','component_release','component_batch_id','component_submission'])
            if(job[field]===undefined&&parent[field]!==undefined)job[field]=structuredClone(parent[field]);
        }
        inheritedJobs.add(job);
      }
    }
    store.saveTask(job);
  };
  const benchmarkControllers = new Map();
  let graphOperations=0;
  let modelOperations = 0, embeddingProvider = null;
  let memoryServerIntegration = null;
  let embeddingProfile = store.getSetting('embedding') || {};
  const isBusy = () => Boolean(active) || benchmarkControllers.size > 0 || modelOperations > 0||graphOperations>0||memoryServerIntegration?.isBusy()===true;
  const budgets = createBudgets(store, { profile: () => modelProfile(globalProvider || { model:globalProfile.model,root:globalProfile.baseUrl,maxTokens:globalProfile.maxTokens,thinkingMode:globalProfile.thinkingMode }) });
  for (const record of store.listRecords('benchmark')) if (record.status === 'RUNNING') store.putRecord('benchmark', record.id,
    { ...record, status: 'INTERRUPTED', notice: '服务中断；不会自动重发，离线流程可重新启动。' });
  for (const job of store.listTasks()) {
    if (['RUNNING', 'QUEUED'].includes(job.status)) { job.interrupted_stage=job.stage;job.status = 'INTERRUPTED'; job.stage = 'INTERRUPTED'; persist(job); }
    jobs.set(job.id, job);
  }
  // Adopt the earlier M1 records without changing original task payloads or statuses.
  for(const job of [...jobs.values()].sort((a,b)=>(a.created_at||'').localeCompare(b.created_at||''))){
    if(job.internal_scope&&!governance.candidateFor(job.id)){
      try{governance.begin(job);
        if(job.status==='READY'&&job.result?.gate?.action==='ACCEPT_CANDIDATE')governance.publish(job);
      }catch(error){store.putRecord('library_migration_issue',job.id,{task_id:job.id,code:error.code||'PUBLICATION_BLOCKED',reason:error.message});}
    }
  }
  // Legacy libraries receive a reusable retrieval index without another model call.
  for(const job of jobs.values())if(job.status==='READY'){
    const candidate=governance.candidateFor(job.id),base=candidate&&governance.baseFor(candidate.base_id);
    if(candidate?.status==='PUBLISHED'&&base?.head_task_id===job.id&&libraryActive(store,base.id)){
      try{createLearningIndex(store,base.id).ensure(activeSources(base,job).sources,job.result.schema.entities);}
      catch(error){store.putRecord('learning_index_issue',job.id,{id:job.id,base_id:base.id,reason:error.message});}
    }
  }
  for(const observation of store.listRecords('learning_observation'))if(observation.status==='LEARNING'){
    const task=store.getTask(observation.task_id);
    if(!task||!['RUNNING','QUEUED'].includes(task.status))store.putRecord('learning_observation',observation.id,{...observation,status:task?.status==='INTERRUPTED'?'INTERRUPTED':'FAILED'});
  }
  const summary = job => ({ id: job.id, name: job.display_name || job.input.name, status: job.status, stage: job.stage,
    stage_label: presentation(job).category==='HUMAN_REVIEW'?'等待人工核对':taskDiagnostics(job).category==='PAUSED_BUDGET'?stageLabels.PAUSED:stageLabels[job.stage] || job.stage, created_at: job.created_at,
    cq_count: job.input.cqs.length, source_count: job.input.sources.length,
    entity_count: job.result?.schema?.entities?.length || 0, claim_count: job.result?.claims?.length || 0,
    issue_count: job.result?.gate?.issues?.length || 0, revision: job.revision || null,
    ...(job.learning||job.learning_resolution?{learning:{question:(job.learning||job.learning_resolution).question,parent_id:job.revision?.parent_id}}:{}),
    graph_sync: job.graph_sync || null, mode: 'SHADOW', presentation: presentation(job) });
  const json = (res, status, data) => { if(res.transformJson){const transform=res.transformJson;res.transformJson=null;try{({status,data}=transform(status,data));}catch(error){status=error.status||400;data={error:error.message,code:error.code||'INTEGRATION_ERROR'};}}if(res.answerStream)return res.answerStream.finish(status,data);res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
  const parseBody = async req => {
    if(req.cqforgeBody)return req.cqforgeBody;
    if (!String(req.headers['content-type']).startsWith('application/json')) throw Error('需要JSON请求');
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 64 * 1024 * 1024) throw Error('本次请求超过64MB，请分批添加资料；已保存的原件和草稿仍保留'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('请求不是有效JSON'); }
  };
  function verifiedJson(job,name){
    if(!/^[a-zA-Z0-9_:.-]+$/.test(name))throw Error('人审核验附件名称无效');
    const path=resolve(storage,job.id,name+'.json'),rel=relative(storage,path);
    const registered=store.db.prepare('SELECT sha256,bytes FROM artifacts WHERE path=?').get(rel);
    if(!registered)throw Error('缺少已登记的原评审附件，不能重建人工核对快照');
    const bytes=readFileSync(path);
    if(bytes.length!==registered.bytes||createHash('sha256').update(bytes).digest('hex')!==registered.sha256)throw Error('人审原始评审附件校验失败');
    return JSON.parse(bytes.toString('utf8'));
  }
  function reviewState(job){
    let reviewPackets=[];
    if(job.status==='FAILED'&&job.error==='声明修复后仍未通过语义评审'){
      reviewPackets=(job.checkpoints||[]).filter(c=>/^claims_review_repaired(?:$|:)/.test(c.key)).map(cp=>({key:cp.key,checkpoint:cp,
        packet:verifiedJson(job,'packet-'+cp.key),review_record:verifiedJson(job,'review-'+cp.key)}));
    }
    const review=buildHumanReview(job,{reviewPackets});
    if(!review)return {review:null,decisions:[],pending_count:0,can_continue:false,decision_set_hash:null};
    if(job.internal_scope)review.groups=groupReviewIssues(review);
    const active=store.listRecords('human_review_active').filter(r=>r.task_id===job.id&&r.snapshot_hash===review.snapshot_hash);
    const decisions=active.map(r=>store.getRecord('human_review_decision',r.decision_id));
    if(decisions.some(d=>!d))throw Error('已保存的人工决定缺失，不能继续');
    const applied=applyReviewDecisions(review,decisions,{input:job.input});
    const progress=store.getRecord('component_progress',job.id),submissions=store.listRecords('component_submission').filter(r=>r.origin_task_id===job.id);
    const locked=new Set([...(progress?.committed_issue_ids||[]),...submissions.filter(r=>['QUEUED','RUNNING','FAILED','PAUSED','INTERRUPTED'].includes(r.status)).flatMap(r=>r.issue_ids)]);
    const graphBaseId=governance.candidateFor(job.id)?.expected_head;
    const latestByGroup=new Map();for(const submission of submissions)if(!latestByGroup.has(submission.group_id))latestByGroup.set(submission.group_id,submission);
    const dependency_groups=componentDecisionGroups(job,review,graphBaseId&&governance.view(store.getTask(graphBaseId)),decisions,progress).map(group=>{
      const submission=latestByGroup.get(group.id);return {...group,submission:submission?{id:submission.id,status:submission.status,task_id:submission.task_id,
        requires_unknown_resend_confirmation:taskDiagnostics(store.getTask(submission.task_id)).requires_unknown_resend_confirmation===true}:null};
    });
    const consumed=store.getRecord('human_review_consumed',sha([job.id,review.snapshot_hash,applied.decision_set_hash]));
    return {review,decisions,evidence_contexts:evidenceContexts(job,review.issues.flatMap(i=>i.claims)),pending_count:applied.missing_issue_ids.length,
      can_continue:review.can_continue&&applied.ready_to_continue&&!consumed&&!submissions.some(r=>['QUEUED','RUNNING','FAILED','PAUSED','INTERRUPTED'].includes(r.status)),locked_issue_ids:[...locked],dependency_groups,requires_component_resend_confirmation:submissions.some(r=>r.status==='CANCELLED'&&r.issue_ids.some(id=>!progress?.committed_issue_ids?.includes(id))&&taskDiagnostics(store.getTask(r.task_id)).requires_unknown_resend_confirmation===true),decision_set_hash:applied.decision_set_hash,
      ...(consumed?{continued_to:consumed.child_id}:{}),
      ...(job.component_submission?{component_origin_task_id:store.getRecord('component_submission',job.component_submission.id)?.origin_task_id}:{}),
      ...(store.getRecord('component_release',job.id)?{component_release:{task_id:store.getRecord('component_release',job.id).task_id,status:store.getRecord('component_release',job.id).status}}:{})};
  }
  function evidenceContexts(job,claims=job.result?.claims||[]){
    const sources=new Map(job.input.sources.map(s=>[s.id,s]));
    return Object.fromEntries(claims.map(c=>[c.id,sourcePreview(sources.get(c.source_id),c)]));
  }
  function presentation(job){
    const base=taskDiagnostics(job);
    try{const state=reviewState(job);
      if(state.review&&!state.decisions.length){const candidate=governance.candidateFor(job.id),library=candidate&&governance.baseFor(candidate.base_id),head=library?.head_task_id&&store.getTask(library.head_task_id);
        if(head?.status==='READY'&&governance.candidateFor(head.id)?.status==='PUBLISHED'&&sha(head.input)===sha(job.input)){
          const successor=technicalSuccessor(job,head,id=>store.getTask(id));if(successor)return {...base,category:'HUMAN_REVIEW_CONTINUED',continued_to:successor,message:'此候选已由通过重新验证的后续版本替代。',allowed_actions:['OPEN_SUCCESSOR']};
        }
      }
      if(state.continued_to)return {...base,category:'HUMAN_REVIEW_CONTINUED',continued_to:state.continued_to,
      message:'此核对快照已继续处理，请打开后续版本。',allowed_actions:['OPEN_SUCCESSOR']};
      if(state.review)return {...base,category:'HUMAN_REVIEW',message:'构建已暂停，等待人工核对；原资料及已完成成果保留。',
      allowed_actions:['DECIDE','REVIEW_CONTINUE','REVISE'],pending_count:state.pending_count,requires_unknown_resend_confirmation:false};}
    catch(error){return {...base,category:'SYSTEM_FAILURE',code:error.code||'HUMAN_REVIEW_SNAPSHOT_INVALID',message:error.message,allowed_actions:['REVISE','EXPORT']};}
    return base;
  }
  function continuationFor(job,state){
    if(!state.review||!state.can_continue)throw Error('请先处理并保存全部阻塞事项；本体阶段需使用定义或资料修订流程');
    const applied=applyReviewDecisions(state.review,state.decisions,{input:job.input});
    if(!globalProvider||sha(continuationProfile(globalProvider))!==sha(state.review.model_profile))throw Error('请连接与原构建一致的模型配置；配置变化需创建修订，不能强行复用');
    for(const source of job.input.sources)if(source.parsing?.document_id){
      const parsed=documents.get(source.parsing.document_id);
      if(parsed.content!==source.content||parsed.original_sha256!==source.parsing.original_sha256)throw Error('来源附件或解析内容已变化，不能沿用人审快照');
    }
    const checkpoints=job.checkpoints||[],baseline=checkpoints.find(c=>c.key==='independent_reading')||job.human_review?.baseline_checkpoint;
    const builder=checkpoints.find(c=>c.key==='schema'||c.key==='schema_semantic_repair')?.metadata?.context_id||job.human_review?.builder_context_id;
    if(!baseline?.validated||baseline.output_sha256!==sha(baseline.output)||!builder)throw Error('独立阅读或本体检查点缺失，不能直接复评');
    return {input_sha256:sha(job.input),source_profile:state.review.model_profile,builder_context_id:builder,
      baseline_checkpoint:baseline,candidate:applied.candidate,candidate_hash:sha(applied.candidate),audit:applied.audit,
      decision_set_hash:applied.decision_set_hash,snapshot_hash:state.review.snapshot_hash,parent_id:job.id};
  }
  function prepareInput(body) {
    if (Array.isArray(body.sources)) body.sources = body.sources.map(s => {
      if (!s.document_id) return { title: s.title, content: s.content };
      const parsed = documents.get(s.document_id);
      if (s.content !== parsed.content) throw Error('解析资料已被修改，请重新上传；不能沿用旧证据定位');
      return { ...s, parsing: parsed };
    });
    return validateInput(body);
  }
  function catalogFor(job) {
    const parentJob = job.revision?.parent_id && store.getTask(job.revision.parent_id);
    const parent = parentJob?.result?.schema && (store.getRecord('capability', parentJob.id) || catalogFor(parentJob));
    const catalog = createCapabilityCatalog(job, { parentCatalog: parent || null });
    store.putRecord('capability', job.id, catalog); return catalog;
  }
  function saveResponse(operationId, value) {
    const path = resolve(storage, 'operations', operationId, randomUUID() + '.json');
    atomicFile(path, JSON.stringify(value)); store.artifact(path);
  }
  function operationProvider(selected, id, phase, task_id = null, budget_id = null, input = null, budgetContext = null) {
    const archive = provider => ({ ...provider, async complete(messages,options) {
      if(task_id)governance.assertCandidateSources(task_id);
      if (!budget_id || !input) throw Object.assign(Error('请先确认本批调用预算；未发送请求'),{code:'BUDGET_REQUIRED'});
      budgets.reserve(budget_id,input,budgetContext);
      try {
        const response = await provider.complete(messages,options);
        saveResponse(id, { phase: typeof phase === 'function' ? phase() : phase, response });
        return response;
      } catch (error) {
        if (error.details) saveResponse(id, { phase: typeof phase === 'function' ? phase() : phase, error_details: error.details });
        throw error;
      }
    }, withMaxTokens: provider.withMaxTokens ? tokens => archive(provider.withMaxTokens(tokens)) : undefined });
    return meteredProvider(archive(selected), store, { operation_id: id, phase, task_id, budget_id });
  }
  let recoveryScheduled=false,recoveryClosed=false;
  function scheduleRecovery(){
    if(recoveryScheduled)return;recoveryScheduled=true;
    setImmediate(()=>{recoveryScheduled=false;if(recoveryClosed||!globalProvider||isBusy())return;
      for(const job of jobs.values()){
        if(!job.internal_scope||!['INTERRUPTED','FAILED'].includes(job.status)||!visibleTask(job))continue;
        const candidate=governance.candidateFor(job.id),state=candidate&&governance.baseFor(candidate.base_id);
        const check=recoveryEligibility(job,{provider:globalProvider,receipt:store.getRecord('recovery_receipt',job.id),
          attempts:store.listRecords('attempt').filter(a=>a.task_id===job.id),candidate,state,budget:budgets.read(job.budget_id)});
        store.putRecord('recovery_status',job.id,{task_id:job.id,reason:check.reason});
        if(!check.eligible)continue;
        try{governance.assertCandidateSources(job.id);budgets.authorize(job.budget_id,job.input,job.budget_context);}
        catch(error){store.putRecord('recovery_status',job.id,{task_id:job.id,reason:error.code||'RECOVERY_BLOCKED'});continue;}
        job.safe_recovery_boundaries=[...(job.safe_recovery_boundaries||[]),check.boundary];
        job.recovery_checkpoints=structuredClone(job.checkpoints||[]);delete job.error;delete job.error_details;delete job.failed_stage;
        job.events.push({stage:'recovery',at:new Date().toISOString(),message:'从已验证且无未知远端请求的检查点自动继续'});
        persist(job);active=job.id;void execute(job,globalProvider);return;
      }
      learningBatches.tick();
    });
  }
  async function syncGraph(job) {
    if (!graph) throw Error('请先连接 Neo4j');
    graphOperations++;try { job.graph_sync = {...await graph.sync(job),target:{uri:graph.info.uri,database:graph.info.database,workspace}}; }
    catch (error) { job.graph_sync = { status: 'FAILED', at: new Date().toISOString(),
      error: '图同步失败；候选版本未被改写。' }; persist(job); throw error; }finally{graphOperations--;}
    persist(job); return job.graph_sync;
  }
  async function execute(job, selectedProvider) {
    job.status = 'RUNNING'; persist(job);
    const update = (stage, detail = {}) => { job.stage = stage;if(detail.unit_progress)job.unit_progress={stage,...detail.unit_progress};if(detail.repairs)job.repairs=structuredClone(detail.repairs); job.events.push({ stage, at: new Date().toISOString(), ...detail }); persist(job); };
    const save = (name, data) => {
      let path = resolve(storage, job.id, name + '.json');
      if (existsSync(path)) path = resolve(storage,job.id,name+'-revision-'+randomUUID()+'.json');
      atomicFile(path, JSON.stringify(data, null, 2)); store.artifact(path);
      if (name === 'schema') { job.result = { status: 'BUILDING', schema: data, claims: [] }; persist(job); }
      if (name === 'claims' && job.result) { job.result.claims = data.claims; persist(job); }
    };
    try {
      governance.begin(job);
      const parent=job.learning&&store.getTask(job.learning.base_task_id);
      const knowledgeBaseId=governance.candidateFor(job.id)?.base_id||'kb_'+(job.revision?.root_id||job.id),index=createLearningIndex(store,knowledgeBaseId),ledger=createLearningLedger(store,knowledgeBaseId);
      index.ensure(job.input.sources,parent?.result?.schema?.entities||[]);
      const admissionEvidence=job.learning?.admission_id?store.getRecord('learning_admission',job.learning.admission_id)?.decision?.evidence||[]:[];
      if(parent&&!job.learning.changed_source_ids?.length&&admissionEvidence.length&&!job.learning.retrieval_plan){job.learning.retrieval_plan=index.plan(job.input.sources,job.learning.question,admissionEvidence,{entities:parent.result.schema.entities,claims:governance.view(parent).result.claims});persist(job);}
      const runner=job.human_review?((_input,_provider,options)=>reviewHumanCandidate(_input,job.human_review,_provider,options)):runPipeline;
      job.result = await runner(job.input, operationProvider(selectedProvider, job.id, () => job.stage, job.id, job.budget_id, job.input, job.budget_context), {
        save, update, cancelled: () => job.cancel_requested, autoRepair: budgets.read(job.budget_id)?.auto_repair === true,
        internalScope:job.internal_scope===true&&(!job.learning||job.learning.changed_source_ids?.length>0),
        structureLearning:job.internal_scope===true,
        extension:parent?{schema:parent.result.schema,claims:governance.view(parent).result.claims,question:job.learning.question,
          changedSourceIds:job.learning.changed_source_ids||[],resolvableIds:[job.learning.cq_id],
          evidence:admissionEvidence,retrievalPlan:job.learning.retrieval_plan||null}:null,
        indexScope:row=>index.enrich(job.input.sources,row,parent?.result?.schema?.entities||[]),processingLedger:ledger,
        reuseValidatedCandidates:job.revision?.kind==='TECHNICAL_RESUME',recoveryCandidate:job.recovery_candidate||null,repairHistory:job.repairs || [],
        checkpoints: job.recovery_checkpoints || [], checkpoint: record => {
          job.checkpoints ||= []; const index=job.checkpoints.findIndex(c=>c.key===record.key);
          if(index<0)job.checkpoints.push(record);else job.checkpoints[index]=record;
          store.archiveRecord('checkpoint',job.id+':'+record.key+':'+record.fingerprint,record);
          const validatedRequests=new Set(job.checkpoints.map(c=>c.metadata?.request_sha256).filter(Boolean));
          store.transaction(()=>{persist(job);store.putRecord('recovery_receipt',job.id,{task_id:job.id,input_hash:sha(job.input),
            checkpoints_hash:sha(job.checkpoints),repairs_hash:sha(job.repairs||[]),profile_hash:sha(continuationProfile(selectedProvider)),
            attempt_ids:store.listRecords('attempt').filter(a=>a.task_id===job.id&&a.status==='COMPLETED'&&validatedRequests.has(a.request_sha256)).map(a=>a.id)});});
        } });
      job.status = job.result.status; job.stage = job.status;
      if(job.component_submission){const r=store.getRecord('component_submission',job.component_submission.id);job.result.component_publication=r.manifest;job.result.pending_components={predicate_ids:r.manifest.held_predicate_ids,cq_ids:r.manifest.held_cq_ids,origin_task_ids:r.manifest.held_predicate_ids.length?[r.origin_task_id]:[]};}
      if(job.status==='READY')store.transaction(()=>{
        if(job.component_submission)assertComponentSubmission(job);
        governance.publish(job);
        index.ensure(job.input.sources,job.result.schema.entities);ledger.commit(job,{published:governance.candidateFor(job.id)?.status==='PUBLISHED'});
        resolveLearningHolds(store,job);
        if(job.component_submission)commitComponentSubmission(job);
        if(job.component_release){const r=store.getRecord('component_release',job.component_release.origin_task_id);store.putRecord('component_release',r.id,{...r,status:'PUBLISHED',task_id:job.id,additional_held_predicate_ids:[],additional_held_cq_ids:[]});}
        if(job.component_resume_origin)for(const kind of ['component_release','component_hold','component_progress']){const r=store.getRecord(kind,job.component_resume_origin);if(r)store.putRecord(kind,r.id,{...r,status:'RESOLVED',resolved_by:job.id});}
      });
    } catch (error) { job.failed_stage = job.stage; job.status = job.cancel_requested ? 'CANCELLED' : error.code==='BUDGET_EXHAUSTED'?'PAUSED':'FAILED'; job.stage = job.status;
      job.error = error.message; job.error_details = { ...(error.details || {}), code:error.code || error.details?.code || 'SYSTEM_PIPELINE_ERROR' };
      job.events.push({ stage: job.failed_stage, status: job.status, at: new Date().toISOString(), message: job.error }); }
    finally { job.finished_at = new Date().toISOString();
      if (job.revision) job.revision.resolution = job.status === 'READY' ? 'REVALIDATED' : 'NEEDS_REVISION';
      persist(job);
      const trackedLearning=job.learning||job.learning_resolution;
      if(trackedLearning){
        const observation=store.getRecord('learning_observation',trackedLearning.observation_id);
        if(observation){
          const plan=job.result?.schema?.cq_plans?.find(p=>p.cq_id===trackedLearning.cq_id);
          const answer=job.status==='READY'?governance.query(job.id,plan):null;
          const status=job.status==='READY'?(answer.classification==='UNKNOWN'?'WAIT_EVIDENCE':'COMPLETED'):
            job.status==='REVIEW_REQUIRED'?'WAIT_REVIEW':job.status==='CANCELLED'?'STOPPED':'FAILED';
          const partialSearch=answer?.classification==='UNKNOWN'&&job.result?.source_coverage?.remaining_unit_ids?.length>0&&job.learning?.retrieval_plan;
          store.putRecord('learning_observation',observation.id,{...observation,status,task_id:job.id,finished_at:job.finished_at,...(partialSearch?{search_scope:'LOCAL_INCOMPLETE',reason:'当前已检查的资料片段尚不足以形成可靠答案，未处理范围仍保留；不能据此判断全文没有依据。'}:{})});
          if(status==='COMPLETED')for(const old of store.listRecords('learning_observation'))if(old.id!==observation.id&&old.base_id===observation.base_id&&old.status==='WAIT_EVIDENCE'&&old.question.trim()===observation.question.trim())
            store.putRecord('learning_observation',old.id,{...old,status:'RESOLVED',resolved_by:observation.id});
        }
      }
      if(job.component_release&&job.status!=='READY'){const r=store.getRecord('component_release',job.component_release.origin_task_id);if(r)store.putRecord('component_release',r.id,{...r,status:job.status,...(job.status==='REVIEW_REQUIRED'?{additional_held_predicate_ids:job.result.schema.predicates.map(p=>p.id),additional_held_cq_ids:job.input.cqs.map(q=>q.id)}:{})});}
      if(job.component_submission){const r=store.getRecord('component_submission',job.component_submission.id);if(r&&r.status!=='PUBLISHED'&&r.status!=='CANCELLED')store.putRecord('component_submission',r.id,{...r,status:job.status,task_id:job.id});}
      learningBatches.settle(job);active = null;
      try{queueIndependentComponents(job);}catch(error){store.putRecord('component_attempt',job.id,{task_id:job.id,status:'BLOCKED',reason:error.message});}
      scheduleRecovery(); }
  }
  function assertComponentEditsOpen(state,ids){if(ids.some(id=>state.locked_issue_ids?.includes(id)))throw Error('本组已经提交或发布，决定已锁定；请处理其他组或先停止正在复核的组');}
  function unfinishedComponent(originId){return store.listRecords('component_submission').find(r=>r.origin_task_id===originId&&['QUEUED','RUNNING','FAILED','PAUSED','INTERRUPTED'].includes(r.status));}
  function assertComponentSubmission(job){
    const r=store.getRecord('component_submission',job.component_submission.id);
    if(!r||r.status==='CANCELLED')throw Error('本组已停止，未发布');
    const original=store.getTask(r.origin_task_id),progress=store.getRecord('component_progress',r.origin_task_id);
    if(sha(original.result)!==r.origin_result_hash||sha({schema:job.result.schema,claims:job.result.claims})!==r.candidate_hash)throw Error('分组复核候选发生变化，未发布');
    if(sha(progress?.committed_decisions||{})!==sha(r.prior_committed_decisions))throw Error('已发布的分组决定已变化，未覆盖');
    for(const d of r.decisions){const active=store.getRecord('human_review_active',sha([original.id,r.snapshot_hash,d.issue_id]));if(active?.decision_id!==d.id)throw Error('分组决定已变化，未发布');}
  }
  function commitComponentSubmission(job){
    const r=store.getRecord('component_submission',job.component_submission.id),previous=store.getRecord('component_progress',r.origin_task_id);
    const finished=r.remaining_count===0;
    store.putRecord('component_progress',r.origin_task_id,{id:r.origin_task_id,base_id:r.base_id,source_epoch:r.source_epoch,origin_result_hash:r.origin_result_hash,
      status:finished?'RESOLVED':'PARTIAL',latest_head:job.id,committed_issue_ids:r.committed_issue_ids,
      committed_decisions:Object.fromEntries(r.decisions.map(d=>[d.issue_id,d.id])),task_ids:[...(previous?.task_ids||[]),job.id]});
    let marked=false;
    for(const kind of ['component_release','component_hold']){const record=store.getRecord(kind,r.origin_task_id);if(!record)continue;marked=true;
      store.putRecord(kind,record.id,{...record,status:finished?'RESOLVED':kind==='component_release'?'PUBLISHED':'HELD',...(kind==='component_release'?{task_id:job.id}:{}),
        current_held_predicate_ids:r.manifest.held_predicate_ids,current_held_cq_ids:r.manifest.held_cq_ids,additional_held_predicate_ids:[],additional_held_cq_ids:[]});}
    if(!marked)store.putRecord('component_hold',r.origin_task_id,{id:r.origin_task_id,base_id:r.base_id,source_epoch:r.source_epoch,status:finished?'RESOLVED':'HELD',manifest:r.manifest});
    store.putRecord('component_submission',r.id,{...r,status:'PUBLISHED',task_id:job.id});
    if(finished)store.putRecord('human_review_consumed',sha([r.origin_task_id,r.snapshot_hash,r.decision_set_hash]),{task_id:r.origin_task_id,snapshot_hash:r.snapshot_hash,decision_set_hash:r.decision_set_hash,child_id:job.id,kind:'COMPONENT_DECISIONS_COMPLETE'});
  }
  function componentResumeBase(job){
    const progress=store.getRecord('component_progress',job.id);if(progress?.status==='PARTIAL'){const current=governance.baseFor(progress.base_id),head=store.getTask(progress.latest_head);if(current.head_task_id!==head?.id||current.source_epoch!==progress.source_epoch||sha(job.result)!==progress.origin_result_hash||governance.candidateFor(head.id)?.result_hash!==sha(head.result))throw Error('分组发布后的基版已变化，需要重新修订');return {component_base_task_id:head.id,component_resume_origin:job.id};}
    const record=store.getRecord('component_release',job.id);if(!record||record.status!=='PUBLISHED')return record||store.getRecord('component_hold',job.id)?{component_resume_origin:job.id}:{};
    const state=governance.baseFor(record.base_id),head=store.getTask(record.task_id);
    if(state.head_task_id!==head?.id||state.source_epoch!==record.source_epoch||sha(job.result)!==record.manifest.origin_result_hash||governance.candidateFor(head.id)?.result_hash!==sha(head.result))throw Error('独立发布后的基版已变化，需要重新修订，不能覆盖新版本');
    return {component_base_task_id:head.id,component_resume_origin:job.id};
  }
  function queueIndependentComponents(job){
    if(!job.internal_scope||job.component_release||job.human_review?.component_publication||job.cancel_requested||isBusy()||!globalProvider)return;
    const batchId=(job.learning||job.learning_resolution)?.batch_id;if(batchId&&store.getRecord('learning_batch',batchId)?.status==='STOPPED')return;
    if(store.getRecord('component_release',job.id))return;
    const original=governance.candidateFor(job.id),state=original&&governance.baseFor(original.base_id);
    if(!state||original.expected_head!==state.head_task_id||original.expected_source_epoch!==state.source_epoch)return;
    const head=state.head_task_id&&governance.view(store.getTask(state.head_task_id)),plan=planComponentPublication(head,job);
    if(!plan.eligible){if(job.status==='REVIEW_REQUIRED'){store.putRecord('component_attempt',job.id,{task_id:job.id,status:'WHOLE_CANDIDATE_HELD',reason:plan.reason});if(head)store.putRecord('component_hold',job.id,{id:job.id,base_id:state.id,source_epoch:state.source_epoch,status:'HELD',manifest:plan.hold||{origin_task_id:job.id,held_predicate_ids:head.result.schema.predicates.map(p=>p.id),held_cq_ids:head.input.cqs.map(q=>q.id)}});}return;}
    const review=reviewState(job).review,checkpoints=job.checkpoints||[],baseline=checkpoints.find(c=>c.key==='independent_reading')||job.human_review?.baseline_checkpoint;
    const builder=checkpoints.find(c=>c.key==='schema'||c.key==='schema_semantic_repair')?.metadata?.context_id||job.human_review?.builder_context_id;
    if(!review||!baseline?.validated||baseline.output_sha256!==sha(baseline.output)||!builder||sha(review.model_profile)!==sha(continuationProfile(globalProvider)))return;
    governance.assertCandidateSources(job.id);
    const id=randomUUID(),context={operation:'BUILD',task_id:null,question:null},preview=budgets.preview(job.input,context);
    const budget=budgets.confirm({preview_id:preview.preview_id,max_calls:16+8*extractionUnits(job.input.sources).length,auto_repair:true,consent:true});
    const session={input_sha256:sha(job.input),source_profile:review.model_profile,builder_context_id:builder,baseline_checkpoint:baseline,
      candidate:plan.candidate,candidate_hash:sha(plan.candidate),audit:[],decision_set_hash:plan.hash,snapshot_hash:review.snapshot_hash,parent_id:job.id,component_publication:plan.manifest};
    const child={id,input:structuredClone(job.input),status:'QUEUED',stage:'queued',events:[],created_at:new Date().toISOString(),model:globalProvider.model,
      internal_scope:true,budget_id:budget.id,budget_context:context,human_review:session,component_release:plan.manifest,
      component_base_task_id:head.id,...(batchId?{component_batch_id:batchId}:{}),cancel_requested:false,publication_approved:false,
      revision:{kind:'COMPONENT_PUBLICATION',parent_id:job.id,root_id:job.revision?.root_id||job.id,note:'独立依赖组件重新校验后形成完整新快照；争议组件保持隔离。'}};
    mkdirSync(resolve(storage,id));store.transaction(()=>{persist(child);governance.begin(child);
      store.archiveRecord('component_change_set',id,plan.manifest);
      store.putRecord('component_release',job.id,{id:job.id,base_id:state.id,source_epoch:state.source_epoch,status:'QUEUED',task_id:id,manifest:plan.manifest});});
    jobs.set(id,child);active=id;void execute(child,globalProvider);
  }
  function excludeNonKnowledge(baseId,question,intent){
    for(const observation of store.listRecords('learning_observation').filter(o=>o.base_id===baseId&&o.question.trim()===question.trim())){
      if(observation.status==='EXCLUDED')continue;
      store.putRecord('learning_exclusion',observation.id,{prior:observation,intent,reason:'NON_KNOWLEDGE_INTENT',at:new Date().toISOString()});
      const old=observation.task_id&&(jobs.get(observation.task_id)||store.getTask(observation.task_id));
      if(old&&old.status!=='READY'){old.cancel_requested=true;old.learning={...old.learning,eligibility:'EXCLUDED'};persist(old);}
      store.putRecord('learning_observation',observation.id,{...observation,status:'EXCLUDED',exclusion_reason:'NON_KNOWLEDGE_INTENT',excluded_at:new Date().toISOString()});
    }
  }
  async function queueLearning(job,question,{sources=null,changedSourceIds=[],batchId=null,integration=null,gapKind='SCHEMA_GAP',requirement=null,admissionProvider=null,onProgress=()=>{}}={}){
    const candidate=governance.candidateFor(job.id),state=candidate&&governance.baseFor(candidate.base_id);
    if(state)assertLibraryActive(store,state.id);
    if(!state||state.head_task_id!==job.id)throw Error('请使用知识库当前版本学习');
    const normalized=question.trim().replace(/\s+/g,' ').toLowerCase();
    const observationId=learningObservationId(state.id,normalized,state.source_epoch);
    const previous=store.getRecord('learning_observation',observationId);
    const priorAdmission=previous?.admission_id&&store.getRecord('learning_admission',previous.admission_id);
    if(previous&&priorAdmission?.base_task_id===job.id)return {status:previous.search_scope==='LOCAL_INCOMPLETE'?'UNKNOWN':previous.status,learning_task_id:previous.task_id,reason:previous.reason||(previous.status==='WAIT_EVIDENCE'?'已检查相关资料，当前仍缺少依据。':'此问题已有学习记录，可查看处理进度。')};
    if(!Object.values(state.sources).some(s=>s.active))return {status:'WAIT_EVIDENCE',reason:'当前知识库没有有效资料，请补充资料。'};
    if(!sources&&job.input.sources.some(s=>!state.sources[(sourceKey(s))]?.active))return {status:'WAIT_EVIDENCE',reason:'资料范围已撤回，需先以当前资料修订知识库。'};
    const input=structuredClone(job.input);
    if(sources)input.sources=structuredClone(sources);
    validateBuildInput(input);
    const sourceIndex=createLearningIndex(store,state.id);
    sourceIndex.ensure(input.sources,job.result.schema.entities);
    const rankedUnits=changedSourceIds.length?null:sourceIndex.rank(input.sources,question,{entities:job.result.schema.entities,claims:job.result.claims});
    const stamp=governance.stamp(job.id),fingerprint=admissionFingerprint(job,question,input.sources,state.source_epoch);
    const saved=store.getRecord('learning_admission',fingerprint);
    let admission=saved?.decision;
    if(!admission){
      let selected=admissionProvider,owned=false;
      if(!selected){const ctx={operation:'ASK',task_id:job.id,question},preview=budgets.preview(input,ctx),budget=budgets.confirm({preview_id:preview.preview_id,max_calls:4+2*extractionUnits(input.sources).length,auto_repair:true,consent:true});selected=operationProvider(globalProvider,randomUUID(),'learning_admission',job.id,budget.id,input,ctx);modelOperations++;owned=true;}
      const guarded={...selected,complete:async(...args)=>{governance.assertStamp(stamp);return selected.complete(...args);}};
      try{admission=await assessLearning(job,question,guarded,{sources:input.sources,requirement,onProgress,changedSourceIds,rankedUnits});}finally{if(owned)modelOperations--;}
      governance.assertStamp(stamp);
      store.putRecord('learning_admission',fingerprint,{id:fingerprint,base_id:state.id,base_task_id:job.id,source_epoch:state.source_epoch,question,decision:admission,created_at:new Date().toISOString()});
    }
    if(batchId&&['STOPPED','SUPERSEDED'].includes(store.getRecord('learning_batch',batchId)?.status))return {status:'STOPPED',reason:'本次整理已停止。'};
    if(admission.intent!=='KNOWLEDGE_QUERY'){
      excludeNonKnowledge(state.id,question,admission.intent);
      const direct=intentDisposition({intent:admission.intent});return direct?.status==='DIRECT_RESPONSE'?{status:'ANSWERED',answer:{answer_mode:'PRODUCT',classification:'NOT_APPLICABLE',text:direct.text,items:[]},claims:[]}:{status:'OUT_OF_SCOPE',reason:'这个问题不属于当前资料知识范围。'};
    }
    if(admission.decision==='NO_SUPPORT'){
      store.putRecord('learning_observation',observationId,{id:observationId,base_id:state.id,source_epoch:state.source_epoch,question:question.trim(),status:'WAIT_EVIDENCE',task_id:null,admission_id:fingerprint,created_at:new Date().toISOString()});return {status:'WAIT_EVIDENCE',reason:admission.reason};
    }
    if(admission.decision==='RETRY_QUERY')return {status:'QUERY_RETRY',reason:'已发现相关知识，正在重新匹配查询。',evidence_hints:{claims:job.result.claims.filter(c=>admission.claim_ids.includes(c.id)),reason:admission.reason}};
    if(admission.decision==='NEEDS_CLARIFICATION')return {status:'NEEDS_CLARIFICATION',reason:admission.reason};
    if(admission.decision!=='ALLOW_LEARNING')return {status:'OUT_OF_SCOPE',reason:'当前资料不覆盖这个请求，请询问资料中的知识。'};
    if(previous&&!['EXCLUDED','WAIT_EVIDENCE'].includes(previous.status))return {status:previous.status,learning_task_id:previous.task_id,reason:previous.status==='WAIT_EVIDENCE'?'已检查相关资料，当前仍缺少依据。':'此问题已有学习记录，可查看处理进度。'};
    gapKind=admission.gap_kind;
    const existing=input.cqs.find(q=>q.question.trim()===question.trim());
    const cqId=existing?.id||'LQ_'+sha(question).slice(0,20);
    if(!existing)input.cqs.push({id:cqId,question:question.trim()});
    const id=randomUUID(),context={operation:'BUILD',task_id:null,question:null};
    const previousSearch=previous?.search_scope==='LOCAL_INCOMPLETE'&&previous.task_id?store.getTask(previous.task_id):null;
    const retrievalPlan=!changedSourceIds.length?(previousSearch?.learning?.retrieval_plan?sourceIndex.expand(previousSearch.learning.retrieval_plan,input.sources,question,{entities:job.result.schema.entities,claims:job.result.claims}):sourceIndex.plan(input.sources,question,admission.evidence,{entities:job.result.schema.entities,claims:job.result.claims})):null;
    const preview=budgets.preview(input,context),units=extractionUnits(input.sources).length;
    const budget=budgets.confirm({preview_id:preview.preview_id,max_calls:16+8*units,auto_repair:true,consent:true});
    const learned={id,input,status:'QUEUED',stage:'queued',events:[],created_at:new Date().toISOString(),model:globalProvider.model,
      internal_scope:true,budget_id:budget.id,budget_context:context,publication_approved:false,cancel_requested:false,
      ...(previousSearch?{recovery_checkpoints:recoveryCheckpointBank(previousSearch)}:{}),
      learning:{admission_id:fingerprint,question:question.trim(),base_task_id:job.id,observation_id:observationId,cq_id:cqId,changed_source_ids:changedSourceIds,
        ...(retrievalPlan?{retrieval_plan:retrievalPlan}:{}),...(integration?{integration_id:integration.id}:{}),...(batchId?{batch_id:batchId}:{})},
      revision:{kind:'ADDITIVE_LEARNING',parent_id:job.id,root_id:state.id.slice(3),note:'新问题触发有界新增能力学习'}};
    mkdirSync(resolve(storage,id));
    store.transaction(()=>{persist(learned);governance.begin(learned);store.putRecord('learning_observation',observationId,
      {id:observationId,base_id:state.id,source_epoch:state.source_epoch,question:question.trim(),contract_version:STRUCTURE_CONTRACT,admission_id:fingerprint,gap_kind:gapKind,status:'LEARNING',task_id:id,created_at:learned.created_at});if(integration?.request_key){const request=store.getRecord('integration_request',integration.request_key);store.putRecord('integration_request',integration.request_key,{...request,status:'LEARNING',learning_task_id:id});}});
    jobs.set(id,learned);active=id;void execute(learned,globalProvider);
    return {status:'LEARNING',learning_task_id:id,reason:'正在补充相关知识，完成后将更新答案。'};
  }
  function activeSources(state,head){
    const combined=new Map(head.input.sources.filter(s=>state.sources[sourceKey(s)]?.active).map(s=>[sourceKey(s),s]));
    for(const saved of store.listRecords('library_source').filter(r=>r.base_id===state.id&&state.sources[r.key]?.active))combined.set(saved.key,saved.source);
    const sources=[...combined.values()],changedSourceIds=sources.filter(s=>!head.input.sources.some(old=>sourceKey(old)===sourceKey(s))).map(s=>s.id);
    return {sources,changedSourceIds};
  }
  const learningBatches=createLearningBatches({store,governance,start:queueLearning,sourcesFor:activeSources,busy:()=>!globalProvider||isBusy()});
  for(const job of jobs.values())if(job.status==='READY'&&governance.candidateFor(job.id)?.status==='PUBLISHED')learningBatches.settle(job);
  const libraries=()=>governance.libraries().filter(b=>libraryActive(store,b.id)).map(base=>({...base,source_update:learningBatches.progress(base.id)}));
  const integrationAccess=createIntegrationAccess(store,{libraryExists:id=>libraryActive(store,id)&&(Boolean(governance.baseFor(id)?.head_task_id)||(sourceFirstOptions?.mainProduct===true&&nativeBuildHost?.isNativeLibrary(id)===true))});
  const management=createLibraryManagement({store,storage,jobs,governance,busy:isBusy,stopBatch:id=>learningBatches.stop(id),graphFor:()=>graph});
  const taskBase=id=>governance.candidateFor(id)?.base_id||knowledgeBases(store.listTasks()).find(b=>b.task_ids.includes(id))?.id||store.listRecords('library_lifecycle').find(l=>l.task_ids?.includes(id))?.id;
  const visibleTask=job=>{const base=taskBase(job.id);return !base||libraryActive(store,base);};
  const sourceProduct=sourceFirstOptions?createSourceProductHost({...sourceFirstOptions,store,governance,resolveDocument:id=>documents.get(id),onOperation:delta=>{modelOperations+=delta;},saveDraft:job=>{persist(job);jobs.set(job.id,job);}}):null;
  const productReviews=sourceFirstOptions?.mainProduct?createProductReviews({store,product:sourceProduct,core:sourceFirstOptions.core??createSourceCore({coreBinary:sourceFirstOptions.coreBinary,expectedSha256:sourceFirstOptions.expectedCoreSha256??null})}):null;
  const productRuntime=sourceFirstOptions?.mainProduct?createProductRuntime({store,governance,product:sourceProduct,reviews:productReviews,pollMs:sourceFirstOptions.mainPollMs??1000}):null;
  const documentTemporalPublication=productRuntime&&sourceFirstOptions.documentTemporalPublication===true?createNativeDocumentTemporalPublication({store,resolveParticipant:()=>memoryServerIntegration?.runtime.temporalParticipant}):null;
  const nativeBuildHost=productRuntime?createNativeFullChainProduct({store,governance,runtime:productRuntime,product:sourceProduct,runtimeDirectory:resolve(storage,'native-runtime'),...(sourceFirstOptions.nativeFullChain??{}),...(documentTemporalPublication?{temporalPublicationPort:documentTemporalPublication}:{}),onOperation:delta=>{modelOperations+=delta;}}):null;
  const queryCatalog=productRuntime?createProductDocumentCatalog({store,governance,runtime:productRuntime}):null;
  memoryServerIntegration=productRuntime&&sourceFirstOptions.memoryProduct!==false?createLightogMemoryServerIntegration({
    store,catalog:queryCatalog,workspaceId:workspace,serviceInstanceRef:instance,integrationAccess,
    temporalCore:sourceFirstOptions.temporalCore??sourceFirstOptions.core??createSourceCore({coreBinary:sourceFirstOptions.coreBinary,expectedSha256:sourceFirstOptions.expectedCoreSha256??null}),
    temporalEmbeddingRuntime:()=>sourceProduct.nativeEmbeddingRuntime(),
    assertLibrary:libraryId=>{assertLibraryActive(store,libraryId);if(!governance.baseFor(libraryId))throw accessError('SOURCE_LIBRARY_NOT_FOUND','知识库不存在',404);},
    browserToken:()=>token,allowedOrigins:()=>['http://127.0.0.1:'+server.address()?.port,'http://localhost:'+server.address()?.port],
    modelRuntime:()=>sourceProduct.nativeModelRuntime(),runtimeDirectory:resolve(storage,'native-memory-runtime'),
    skillPaths:['lightog-semantic-discovery','lightog-knowledge-organization'].map(name=>resolve(root,'docs/skill-drafts',name,'SKILL.md')),
    createRuntime:createMemoryProductRuntime,createActionPort:createNativeActionProcessingPort,selectSkills:selectedNativeSkills,
    createMaintenanceRuntime:createMemoryMaintenanceRuntime,createMaintenanceHandler:createMemoryMaintenanceHttpHandler,
    createMaintenanceOutcomeReader:createMemoryMaintenanceOutcomeReader,
    createLibraryContext:createMemoryLibraryContextCandidate,createOrganizationReusePort:createNativeActionOrganizationReusePort,
    verifyActionPrepared:verifyNativeActionPrepared,prepareActionLibrary:prepareNativeActionLibraryForMemoryProduct,
    identitySkillPath:resolve(root,'docs/skill-drafts/lightog-entity-resolution/SKILL.md'),
    createMcpHandler:createLightogMemoryMcpHttpHandler,createBrowserHandler:createMemoryHttpHandler,onOperation:delta=>{modelOperations+=delta;}
  }):null;
  const nativeQueryProduct=productRuntime?createNativeQueryProduct({store,...(memoryServerIntegration?.runtime.temporalParticipant?{temporalReaderPort:createTemporalQueryReaderPort({store,readFacts:args=>memoryServerIntegration.runtime.temporalParticipant.readFacts(args)})}:{}),resolveReader:libraryId=>{assertLibraryActive(store,libraryId);return memoryServerIntegration?memoryServerIntegration.resolveReader(libraryId):createNativeExtractedQueryReader({store,libraryId,catalog:queryCatalog});},modelRuntime:()=>{const configured=sourceProduct.nativeModelRuntime();return {...configured,profile:{...configured.generation,provider:'HOST_CONFIGURED',profile_ref:'PRODUCT_NATIVE_PROFILE',protocol:'responses'}};},runtimeDirectory:resolve(storage,'native-query-runtime'),...(sourceFirstOptions.nativeQuery??{}),onOperation:delta=>{modelOperations+=delta;}}):null;
  const nativeQueryHttp=nativeQueryProduct?createNativeQueryHttp({product:nativeQueryProduct,json,parseBody,authorize:({req,libraryId,action})=>{assertLibraryActive(store,libraryId);if(action.endsWith('/events')){const origins=['http://127.0.0.1:'+server.address()?.port,'http://localhost:'+server.address()?.port];if(req.headers['x-cqforge-token']!==token||req.headers.origin&&!origins.includes(req.headers.origin))return false;}return !!governance.baseFor(libraryId);}}):null;
  const productHttp=createProductHttp({runtime:productRuntime,product:sourceProduct,governance,reviews:productReviews,nativeBuildHost,json,parseBody,prepareInput:input=>prepareProductInput(input,{getDocument:id=>documents.get(id)}),openStream:openAnswerStream,onOperation:delta=>{modelOperations+=delta;}});
  const sourceHttp=createSourceFirstHttp({product:sourceProduct,json,parseBody,prepareInput,openStream:openAnswerStream,onOperation:delta=>{modelOperations+=delta;}});
  const server = createServer(async (req, res) => {
    const boundPort = server.address()?.port ?? port;
    const allowedHosts = ['127.0.0.1:' + boundPort, 'localhost:' + boundPort];
    if (!allowedHosts.includes(req.headers.host)) return json(res, 403, { error: '仅允许本机访问' });
    let pathname = new URL(req.url, 'http://127.0.0.1').pathname;let externalCall=null;
    if (req.method === 'POST' && pathname === '/api/shutdown') {
      if (req.headers['x-cqforge-control'] !== control || req.headers.origin || isBusy()) return json(res, 403, { error: '身份不匹配或任务正在执行' });
      json(res, 200, { stopped: true }); server.close(); return;
    }
    try {
      if(memoryServerIntegration&&await memoryServerIntegration.handle(req,res))return;
      if(pathname.startsWith('/api/v1/')){
        if(productRuntime)throw accessError('PRODUCT_LEGACY_V1_NOT_SUPPORTED_MAIN_MODE','此候选版使用新的知识链路，旧版应用接入协议尚未适配',409);
        if(req.headers.origin!==undefined)throw accessError('BROWSER_ORIGIN_REJECTED','外部接入不接受浏览器跨站请求');
        const principal=integrationAccess.authenticate(req.headers.authorization);
        const visible=libraries().filter(b=>b.id===principal.library_id);
        if(req.method==='GET'&&pathname==='/api/v1/knowledge-bases')return json(res,200,{items:visible.map(libraryContract)});
        const match=pathname.match(/^\/api\/v1\/knowledge-bases\/(kb_[a-f0-9-]{36})(?:\/(capabilities|query|learn|jobs)(?:\/([a-f0-9-]{36})(?:\/(cancel))?)?)?$/);
        if(!match)return json(res,404,{error:'接口不存在',code:'NOT_FOUND'});
        const baseId=match[1],action=match[2],jobId=match[3];integrationAccess.authorize(principal.id,baseId,{learn:action==='learn'||match[4]==='cancel'});
        const base=visible.find(b=>b.id===baseId);if(!base?.current_task_id)throw accessError('LIBRARY_NOT_READY','知识库尚无可查询版本',409);
        if(req.method==='GET'&&!action)return json(res,200,libraryContract(base));
        if(req.method==='GET'&&action==='capabilities')return json(res,200,catalogFor(governance.view(store.getTask(base.current_task_id))));
        if(action==='jobs'&&jobId){
          const job=store.getTask(jobId);if(!job||governance.candidateFor(jobId)?.base_id!==baseId)throw accessError('JOB_NOT_FOUND','此知识库中没有该任务',404);
          const related=[...jobs.values()].filter(j=>j.component_release?.origin_task_id===jobId&&['RUNNING','QUEUED'].includes(j.status));
          if(req.method==='POST'&&match[4]==='cancel'){
            if((job.learning||job.learning_resolution)?.integration_id!==principal.id)throw accessError('JOB_OWNER_MISMATCH','只能停止由此接入发起的学习任务');
            for(const task of [job,...related])if(['RUNNING','QUEUED'].includes(task.status)){task.cancel_requested=true;persist(task);}
            return json(res,200,{id:jobId,status:job.status,cancel_requested:job.cancel_requested===true||related.some(j=>j.cancel_requested)});
          }
          if(req.method==='GET'&&!match[4]){const next=reviewState(job).continued_to;return json(res,200,{...jobContract({...governance.view(job),stage_label:stageLabels[job.stage]||job.stage},base,{ownerId:principal.id}),...(next?{next_job_id:next}:{}),can_cancel:(job.learning||job.learning_resolution)?.integration_id===principal.id&&(['RUNNING','QUEUED'].includes(job.status)||related.length>0)});}
        }
        if(req.method!=='POST'||!['query','learn'].includes(action)||jobId)throw accessError('METHOD_NOT_ALLOWED','请求方法或路径不支持',405);
        const body=await parseBody(req),allowed=action==='query'?['question','request_id','version','capability_id','params']:['question','request_id','version'];
        if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!allowed.includes(k)))throw accessError('INVALID_ARGUMENTS','只接受已声明的查询字段，不允许覆盖学习模式',400);
        if(typeof body.request_id!=='string'||!idPattern.test(body.request_id))throw accessError('REQUEST_ID_REQUIRED','需要有效 request_id 以避免重复调用',400);
        const typed=action==='query'&&typeof body.capability_id==='string';
        if(typed?body.question!==undefined||!body.params||typeof body.version!=='string'||!idPattern.test(body.version):typeof body.question!=='string'||!body.question.trim()||body.question.length>1000)throw accessError('INVALID_ARGUMENTS','请提供问题；参数查询需提供当前 version、capability_id 和 params',400);
        const mode=action==='learn'?'LEARN':'QUERY',requestKey=sha([principal.id,baseId,mode,body.request_id]),fingerprint=sha(body),prior=store.getRecord('integration_request',requestKey);
        externalCall={id:principal.id,base_id:baseId,mode,request_key:requestKey,stamp:governance.stamp(base.current_task_id)};
        res.transformJson=(status,data)=>{
          integrationAccess.authorize(principal.id,baseId,{learn:mode==='LEARN'});
          const row=store.getRecord('integration_request',requestKey);
          if(status>=400){if(row?.status==='STARTED')store.putRecord('integration_request',requestKey,{...row,status:['WORKSPACE_BUSY','MODEL_NOT_CONNECTED'].includes(data.code)?'NOT_SENT':'FAILED_OR_UNKNOWN'});return {status,data:{error:data.error||'请求未完成',code:data.code||'REQUEST_FAILED'}};}
          governance.assertStamp(externalCall.stamp);
          store.putRecord('integration_request',requestKey,{...row,status:'COMPLETED',response:data,source_stamp:externalCall.stamp});
          const current=libraries().find(b=>b.id===baseId);
          return {status:data.status==='LEARNING'?202:200,data:answerContract(data,{base:current,mode,getJob:id=>store.getTask(id)})};
        };
        if(prior){
          if(prior.fingerprint!==fingerprint)throw accessError('REQUEST_ID_REUSED','同一 request_id 的内容已变化',409);
          if(prior.status==='COMPLETED'){externalCall.stamp=prior.source_stamp;governance.assertStamp(prior.source_stamp);return json(res,200,prior.response);}
          if(prior.learning_task_id&&store.getTask(prior.learning_task_id)){externalCall.stamp=prior.source_stamp;governance.assertStamp(prior.source_stamp);return json(res,202,{status:'LEARNING',task_id:prior.version,version:prior.version,learning_task_id:prior.learning_task_id});}
          if(prior.status!=='NOT_SENT')throw accessError('REQUEST_RESULT_UNKNOWN','此请求正在处理或结果未知，不会自动再次发送；请检查原请求或任务状态',409);
        }
        if(body.version!==undefined&&body.version!==base.current_task_id)throw accessError('VERSION_CHANGED','当前版本已变化，请重新读取能力目录',409);
        if(!typed&&!globalProvider)throw accessError('MODEL_NOT_CONNECTED','请在工作台连接模型后重试原请求',409);
        if(!typed&&isBusy())throw accessError('WORKSPACE_BUSY','正在整理或回答其他问题，请稍后重试原请求；参数查询仍可使用',409);
        store.putRecord('integration_request',requestKey,{id:requestKey,credential_id:principal.id,library_id:baseId,mode,fingerprint,status:'STARTED',version:base.current_task_id,source_stamp:externalCall.stamp,created_at:new Date().toISOString()});
        if(typed){const head=governance.view(store.getTask(base.current_task_id)),catalog=catalogFor(head),answer=await executeTyped(head,catalog,body.capability_id,body.params,{queryPlan:governance.query});return json(res,200,answer);}
        req.cqforgeBody={question:body.question,consent:true,request_id:integrationRequestId(principal.id,mode,baseId,body.request_id),learn:mode==='LEARN',backend:'SQLITE'};
        pathname='/api/knowledge-bases/'+baseId+'/ask';
      }
      if(req.headers.authorization&&!externalCall)throw accessError('INTEGRATION_PATH_DENIED','接入凭证仅用于 /api/v1 接口');
      if(req.method==='POST'&&!externalCall&&(req.headers['x-cqforge-token']!==token||!['http://127.0.0.1:'+boundPort,'http://localhost:'+boundPort].includes(req.headers.origin)))return json(res,403,{error:'请求来源校验失败，请刷新工作台'});
      const libraryLifecycleRoute=pathname.match(/^\/api\/knowledge-bases\/(kb_[a-f0-9-]{36})\/(rename|trash|restore|purge)$/);
      if(req.method==='GET'&&pathname==='/api/trash')return json(res,200,{items:governance.libraries().filter(b=>['TRASHED','PURGING'].includes(b.lifecycle_status))});
      if(req.method==='POST'&&libraryLifecycleRoute){const body=await parseBody(req),[,id,action]=libraryLifecycleRoute;return json(res,200,action==='rename'?management.rename(id,body.name):action==='purge'?await management.purge(id,body):management[action](id));}
      const scopedLibrary=pathname.match(/^\/api\/knowledge-bases\/(kb_[a-f0-9-]{36})/);
      if(scopedLibrary)assertLibraryActive(store,scopedLibrary[1]);
      const scopedTask=pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})/);
      if(scopedTask){const base=taskBase(scopedTask[1]);if(base)assertLibraryActive(store,base);}
      if(req.method==='POST'&&String(req.headers['content-type']).startsWith('application/json')){const body=await parseBody(req);req.cqforgeBody=body;for(const id of [body.task_id,body.parent_id]){const base=id&&taskBase(id);if(base)assertLibraryActive(store,base);}}
      if(nativeQueryHttp&&await nativeQueryHttp({req,res,pathname}))return;
      if(await productHttp({req,res,pathname})){
        if(req.method==='POST'&&/^\/api\/product\/models(?:\/(generation|embedding|reranker))?$/.test(pathname)&&res.statusCode>=200&&res.statusCode<300)memoryServerIntegration?.resumeNeverStarted();
        return;
      }
      if(productRuntime&&req.method==='POST'&&(
        ['/api/knowledge-build','/api/tasks','/api/model','/api/embedding-profile','/api/cq-proposals','/api/benchmarks'].includes(pathname)
        ||/^\/api\/tasks\//.test(pathname)
        ||/^\/api\/knowledge-bases\/[^/]+\/(ask|sources|refresh-structure|source-updates)(\/|$)/.test(pathname)
      ))throw accessError('PRODUCT_LEGACY_PATH_DISABLED','主产品已采用新链路，请使用当前页面操作',409);
      const nativeLegacyWrite=pathname.match(/^\/api\/knowledge-bases\/([^/]+)\/source-first\/(ask|learning|sources|recover-candidates)$/);
      if(req.method==='POST'&&nativeLegacyWrite&&nativeBuildHost?.isNativeLibrary(nativeLegacyWrite[1]))throw accessError('NATIVE_LIBRARY_LEGACY_WRITE_DISABLED','此知识库采用原生构建，请使用原生构建和知识读回接口',409);
      if(await sourceHttp({req,res,pathname}))return;
      if(pathname==='/api/integrations'&&req.method==='GET')return json(res,200,{items:integrationAccess.list(),mcp:memoryServerIntegration?{command:process.execPath,args:[resolve(webRoot,'lightog-memory-mcp-stdio-v1.mjs')],url:'http://127.0.0.1:'+boundPort,workspace_id:workspace,protocol:'LIGHTOG_MEMORY_MCP_V1',required_env:['LIGHTOG_MEMORY_PRODUCT_URL','LIGHTOG_MEMORY_PRODUCT_TOKEN','LIGHTOG_MEMORY_WORKSPACE_ID','LIGHTOG_MEMORY_LIBRARY_ID']}:{command:process.execPath,args:[resolve(webRoot,'mcp-stdio.mjs')],url:'http://127.0.0.1:'+boundPort}});
      if(pathname==='/api/integrations'&&req.method==='POST')return json(res,201,integrationAccess.issue(await parseBody(req)));
      const revokeAccess=pathname.match(/^\/api\/integrations\/([a-f0-9-]{36})\/revoke$/);
      if(req.method==='POST'&&revokeAccess)return json(res,200,integrationAccess.revoke(revokeAccess[1]));

      if(req.method==='GET'&&pathname==='/api/knowledge-bases')return json(res,200,{items:libraries()});
      const stopUpdateMatch=pathname.match(/^\/api\/knowledge-bases\/(kb_[a-f0-9-]{36})\/source-updates\/(update_[a-f0-9]{32})\/stop$/);
      if(req.method==='POST'&&stopUpdateMatch){
        const batch=store.getRecord('learning_batch',stopUpdateMatch[2]);if(!batch||batch.base_id!==stopUpdateMatch[1])throw Error('更新任务不属于此知识库');
        learningBatches.stop(batch.id);
        const job=batch.task_id&&jobs.get(batch.task_id);if(job&&['RUNNING','QUEUED'].includes(job.status)){job.cancel_requested=true;persist(job);}
        for(const candidate of jobs.values())if(candidate.component_batch_id===batch.id&&!['READY','CANCELLED'].includes(candidate.status)){candidate.cancel_requested=true;persist(candidate);if(candidate.component_submission){const r=store.getRecord('component_submission',candidate.component_submission.id);if(r&&r.status!=='PUBLISHED')store.putRecord('component_submission',r.id,{...r,status:'CANCELLED'});}}
        return json(res,200,{stopped:true});
      }
      const replaceSourceMatch=pathname.match(/^\/api\/knowledge-bases\/(kb_[a-f0-9-]{36})\/sources\/(src_[a-f0-9]{32})\/replace$/);
      if(req.method==='POST'&&replaceSourceMatch){
        if(!globalProvider||isBusy())return json(res,409,{error:'请连接模型并等待当前整理完成'});
        const state=governance.baseFor(replaceSourceMatch[1]),head=state?.head_task_id&&store.getTask(state.head_task_id),key=replaceSourceMatch[2];
        if(!head||!state.sources[key])throw Error('资料不属于当前知识库');
        const body=await parseBody(req);
        const source=prepareInput({name:head.input.name,cqs:[head.input.cqs[0].question],sources:[body.source],consent:true}).sources[0];
        source.id='source_'+sha(sourceKey(source)).slice(0,20);
        if(state.sources[key].replaced_by===sourceKey(source)&&state.sources[sourceKey(source)]?.active)return json(res,200,{status:'UNCHANGED'});
        const current=activeSources(state,head).sources.filter(s=>sourceKey(s)!==key);
        validateBuildInput({...head.input,sources:[...current,source]});
        const result=store.transaction(()=>{
          const replacement=governance.replaceSource(state.id,key,source);
          if(replacement.changed)learningBatches.enqueue(state.id);
          return replacement;
        });
        if(!result.changed)return json(res,200,{status:'UNCHANGED'});
        await learningBatches.tick();const progress=learningBatches.progress(state.id);
        return json(res,202,{status:progress.status==='RUNNING'?'LEARNING':progress.status,learning_task_id:progress.task_id,question:progress.question,update:progress});
      }
      const addSourceMatch=pathname.match(/^\/api\/knowledge-bases\/(kb_[a-f0-9-]{36})\/sources$/);
      if(req.method==='POST'&&addSourceMatch){
        if(!globalProvider||isBusy())return json(res,409,{error:'请连接模型并等待当前整理完成'});
        const state=governance.baseFor(addSourceMatch[1]),head=state?.head_task_id&&store.getTask(state.head_task_id);
        if(!head)return json(res,409,{error:'知识库尚未有可用版本'});
        const body=await parseBody(req);
        const prepared=prepareInput({name:head.input.name,cqs:[head.input.cqs[0].question],sources:[body.source],consent:true});
        const source=prepared.sources[0];source.id='source_'+sha(sourceKey(source)).slice(0,20);
        const combined=new Map(head.input.sources.filter(s=>state.sources[sourceKey(s)]?.active).map(s=>[sourceKey(s),s]));
        for(const saved of store.listRecords('library_source').filter(r=>r.base_id===state.id&&state.sources[r.key]?.active))if(!combined.has(saved.key))combined.set(saved.key,saved.source);
        const changed=!combined.has(sourceKey(source));if(changed)combined.set(sourceKey(source),source);
        validateBuildInput({...head.input,sources:[...combined.values()]});
        const changedIds=[...combined.values()].filter(s=>!head.input.sources.some(old=>sourceKey(old)===sourceKey(s))||!state.sources[sourceKey(s)]?.active).map(s=>s.id);
        if(!changedIds.length&&state.sources[sourceKey(source)]?.active)return json(res,200,{status:'UNCHANGED',reason:'资料已在当前知识库中，无需重复整理。'});
        store.transaction(()=>{governance.addSource(state.id,source);learningBatches.enqueue(state.id);});await learningBatches.tick();
        const progress=learningBatches.progress(state.id);
        return json(res,202,{status:progress.status==='RUNNING'?'LEARNING':progress.status,learning_task_id:progress.task_id,question:progress.question,update:progress});
      }
      const sourceMatch=pathname.match(/^\/api\/knowledge-bases\/(kb_[a-f0-9-]{36})\/sources\/([a-z0-9_]+)\/revoke$/);
      if(req.method==='POST'&&sourceMatch){await parseBody(req);const state=governance.revoke(sourceMatch[1],sourceMatch[2]);return json(res,200,{source_epoch:state.source_epoch,sources:Object.values(state.sources)});}
      const refreshMatch=pathname.match(/^\/api\/knowledge-bases\/(kb_[a-f0-9-]{36})\/refresh-structure$/);
      if(req.method==='POST'&&refreshMatch){
        const body=await parseBody(req);if(body.consent!==true||typeof body.request_id!=='string'||!idPattern.test(body.request_id))throw Error('结构补全需要有效请求标识和本次资料处理授权');
        const state=governance.baseFor(refreshMatch[1]),head=state&&store.getTask(state.head_task_id);if(!head)throw Error('知识库尚无当前可用版本');
        const question=typeof body.question==='string'?body.question.trim():'请说明'+head.result.schema.entities.filter(e=>!e.structure_kind).map(e=>e.name).join('、')+'之间有哪些组合模式，各自的角色与分工是什么？';
        if(!question||question.length>1000)throw Error('结构补全问题过长或为空');
        const key=sha(['STRUCTURE_REFRESH',state.id,body.request_id]),prior=store.getRecord('structure_refresh',key);
        if(prior){if(prior.question!==question)throw Error('同一结构补全请求的问题已变化');return json(res,prior.response.status==='LEARNING'?202:200,{...prior.response,reused_result:true});}
        if(isBusy())return json(res,409,{error:'请等待当前任务结束'});
        if(!globalProvider)throw Error('请先连接模型');
        const response=await queueLearning(head,question,{gapKind:'STRUCTURE_LOSS'});store.putRecord('structure_refresh',key,{question,response,contract_version:STRUCTURE_CONTRACT});return json(res,response.status==='LEARNING'?202:200,response);
      }
      const baseMatch=pathname.match(/^\/api\/knowledge-bases\/(kb_[a-f0-9-]{36})$/);
      if(req.method==='GET'&&baseMatch){
        const base=libraries().find(b=>b.id===baseMatch[1]);
        return base?json(res,200,{...base,versions:base.task_ids.map(id=>summary(store.getTask(id)))}):json(res,404,{error:'知识库不存在'});
      }
      if(req.method==='POST'&&pathname==='/api/knowledge-build'){
        if(!globalProvider)return json(res,409,{error:'请先连接模型；输入资料会自动整理'});
        if(isBusy())return json(res,409,{error:'请等待当前整理完成，或停止当前任务'});
        const body=await parseBody(req),input=prepareInput(body);
        validateBuildInput(input);
        if(body.parent_id||body.proposal_id)throw Error('新建入口不接受历史修订或扩展确认；请使用对应版本入口');
        if(typeof body.request_id!=='string'||!idPattern.test(body.request_id))throw Error('请提供有效的构建请求标识');
        const requestKey=sha(['KNOWLEDGE_BUILD',body.request_id]);
        const prior=store.getRecord('execution_request',requestKey);
        if(prior){
          if(prior.input_sha256!==sha(input))return json(res,409,{error:'同一构建请求的资料已变化，请重新发起'});
          return json(res,202,{...summary(store.getTask(prior.task_id)),deduplicated:true});
        }
        const context={operation:'BUILD',task_id:null,question:null};
        const preview=budgets.preview(input,context);
        // Finite internal allowance includes scope scanning, extraction, review and one repair per unit.
        const units=extractionUnits(input.sources).length;
        const budget=budgets.confirm({preview_id:preview.preview_id,max_calls:16+8*units,auto_repair:true,consent:true});
        const id=randomUUID();mkdirSync(resolve(storage,id));
        const job={id,input,status:'QUEUED',stage:'queued',events:[],created_at:new Date().toISOString(),
          model:globalProvider.model,budget_id:budget.id,budget_context:context,internal_scope:true,
          publication_approved:false,cancel_requested:false};
        store.transaction(()=>{persist(job);store.putRecord('execution_request',requestKey,{task_id:id,input_sha256:sha(input)});});
        jobs.set(id,job);active=id;void execute(job,globalProvider);return json(res,202,summary(job));
      }
      if(pathname==='/api/workspace-draft'&&['GET','POST'].includes(req.method)){
        const options={getDocument:id=>documents.get(id),getProposal:id=>store.getRecord('proposal',id)};
        const validateDraft=productRuntime?prepareProductDraft:validateWorkspaceDraft;
        if(req.method==='GET'){
          const current=store.getRecord('workspace-draft',workspace);
          return json(res,200,{draft:current?.draft===null||!current?null:validateDraft(current.draft,options)});
        }
        const body=await parseBody(req);
        if(!body||typeof body!=='object'||Array.isArray(body)||!Object.hasOwn(body,'draft'))throw Error('请提供draft对象或null');
        const draft=validateDraft(body.draft,options);
        store.putRecord('workspace-draft',workspace,{draft});return json(res,200,{draft});
      }
      const backlogMatch=pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})\/question-backlog$/);
      if(backlogMatch&&['GET','POST'].includes(req.method)){
        const task=store.getTask(backlogMatch[1]);if(!task)return json(res,404,{error:'任务不存在'});
        if(req.method==='GET')return json(res,200,{items:store.listRecords('question-backlog').filter(item=>item.task_id===task.id)});
        const body=await parseBody(req);
        const candidate=questionBacklogItem(task.id,body?.question),previous=store.getRecord('question-backlog',candidate.id);
        if(previous)return json(res,200,{item:previous,deduplicated:true});
        store.putRecord('question-backlog',candidate.id,candidate);return json(res,201,{item:candidate,deduplicated:false});
      }
      if (pathname === '/api/budgets/preview' && ['GET','POST'].includes(req.method)) {
        const body=req.method==='POST'?await parseBody(req):Object.fromEntries(new URL(req.url,'http://localhost').searchParams);
        const job=body.task_id && store.getTask(body.task_id);
        if(body.task_id&&!job)return json(res,404,{error:'任务不存在'});
        const input=job?job.input:prepareInput({...body.input,consent:true});
        validateBuildInput(input);
        let reviewContext={};
        if(body.operation==='REVIEW_CONTINUE'){
          if(!job)throw Error('人审继续需要具体任务版本');
          const state=reviewState(job),session=continuationFor(job,state);
          reviewContext={snapshot_hash:state.review.snapshot_hash,decision_set_hash:state.decision_set_hash,review_candidate:session.candidate};
        }
        if(body.operation==='RESUME'&&job?.human_review){
          reviewContext={snapshot_hash:job.human_review.snapshot_hash,decision_set_hash:job.human_review.decision_set_hash,review_candidate:job.human_review.candidate};
        }
        return json(res,200,budgets.preview(input,{operation:body.operation || 'BUILD',task_id:job?.id || null,question:body.question || null,...reviewContext}));
      }
      if(pathname==='/api/budgets'&&req.method==='POST') {
        if(!globalProvider)return json(res,409,{error:'请先配置模型，再确认预算'});
        return json(res,201,budgets.confirm(await parseBody(req)));
      }
      const budgetMatch=pathname.match(/^\/api\/budgets\/([a-f0-9-]{36})$/);
      if(budgetMatch&&req.method==='GET') {const budget=budgets.read(budgetMatch[1]);return json(res,budget?200:404,budget || {error:'预算不存在'});}
      const humanMatch=pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})\/(review|review-decisions|review-group-decisions|review-component-continue|review-component-stop|review-continue|ontology-revision)$/);
      if(humanMatch){
        const job=store.getTask(humanMatch[1]);if(!job)return json(res,404,{error:'任务不存在'});
        const state=reviewState(job);
        if(req.method==='GET'&&humanMatch[2]==='review')return json(res,200,state);
        if(req.method==='POST'&&humanMatch[2]==='review-component-stop'){
          const body=await parseBody(req),record=store.getRecord('component_submission',body.submission_id);
          if(!record||record.origin_task_id!==job.id)throw Error('分组提交不属于当前任务');
          if(record.status==='PUBLISHED')throw Error('本组已发布，不能撤销历史发布');
          const child=jobs.get(record.task_id);if(child){child.cancel_requested=true;persist(child);}
          store.putRecord('component_submission',record.id,{...record,status:'CANCELLED'});return json(res,200,{stopped:true});
        }
        if(req.method==='POST'&&humanMatch[2]==='review-component-continue'){
          const body=await parseBody(req);if(body.consent!==true||typeof body.request_id!=='string'||!idPattern.test(body.request_id))throw Error('请确认本组继续并提供有效请求标识');
          const key=sha(['COMPONENT_DECISION',job.id,body.request_id]),fingerprint=sha([body.snapshot_hash,body.decision_set_hash,body.group_id]);
          const prior=store.getRecord('component_submission',key);if(prior){if(prior.fingerprint!==fingerprint)throw Error('同一请求的分组或决定已变化');return json(res,202,{...summary(store.getTask(prior.task_id)),deduplicated:true,submission_id:key});}
          if(!job.internal_scope||!state.review||state.continued_to||body.snapshot_hash!==state.review.snapshot_hash||body.decision_set_hash!==state.decision_set_hash)throw Error('核对快照或已保存决定已变化，请刷新');
          if(!globalProvider||isBusy())return json(res,409,{error:'请连接模型并等待当前处理结束'});
          if(unfinishedComponent(job.id))throw Error('请先恢复或停止上一组的复核，再提交其他组');
          governance.assertCandidateSources(job.id);
          const group=state.dependency_groups.find(g=>g.id===body.group_id);if(!group)throw Error('分组依赖无法可靠划分，请使用完整复核');
          assertComponentEditsOpen(state,group.issue_ids);
          if(group.submission?.requires_unknown_resend_confirmation&&body.confirm_unknown_resend!==true)throw Error('上次本组远端结果未知，请单独确认允许再次发送');
          const candidate=governance.candidateFor(job.id),base=governance.baseFor(candidate.base_id),head=store.getTask(base.head_task_id),progress=store.getRecord('component_progress',job.id);
          const resume=componentResumeBase(job);if((resume.component_base_task_id||candidate.expected_head)!==head?.id)throw Error('当前基版已经变化，请重新修订');
          if(sha(state.review.model_profile)!==sha(continuationProfile(globalProvider)))throw Error('模型配置已变化，请恢复原配置或创建修订');
          const planned=prepareComponentDecision({job,review:state.review,decisions:state.decisions,group,head:governance.view(head),progress});
          const checkpoints=job.checkpoints||[],baseline=checkpoints.find(c=>c.key==='independent_reading')||job.human_review?.baseline_checkpoint,
            builder=checkpoints.find(c=>c.key==='schema'||c.key==='schema_semantic_repair')?.metadata?.context_id||job.human_review?.builder_context_id;
          if(!baseline?.validated||baseline.output_sha256!==sha(baseline.output)||!builder)throw Error('缺少有效的独立阅读检查点，不能分组继续');
          const id=randomUUID(),context={operation:'BUILD',task_id:null,question:null},preview=budgets.preview(job.input,context),
            budget=budgets.confirm({preview_id:preview.preview_id,max_calls:16+8*extractionUnits(job.input.sources).length,auto_repair:true,consent:true});
          const session={input_sha256:sha(job.input),source_profile:state.review.model_profile,builder_context_id:builder,baseline_checkpoint:baseline,
            candidate:planned.candidate,candidate_hash:sha(planned.candidate),audit:planned.audit,decision_set_hash:planned.decision_set_hash,snapshot_hash:state.review.snapshot_hash,parent_id:job.id,component_publication:planned.manifest};
          const tracking=job.learning||job.learning_resolution;
          const child={id,input:structuredClone(job.input),status:'QUEUED',stage:'queued',events:[],created_at:new Date().toISOString(),model:globalProvider.model,
            internal_scope:true,budget_id:budget.id,budget_context:context,human_review:session,component_submission:{id:key},component_base_task_id:head.id,
            ...(tracking?.batch_id?{component_batch_id:tracking.batch_id}:{}),...(planned.remaining_count===0&&tracking?{learning_resolution:structuredClone(tracking)}:{}),
            cancel_requested:false,publication_approved:false,revision:{kind:'COMPONENT_DECISION',parent_id:job.id,root_id:job.revision?.root_id||job.id,note:'仅提交一个完整依赖组，重新复核后形成完整快照，其他组继续隔离。'}};
          const record={id:key,fingerprint,origin_task_id:job.id,origin_result_hash:sha(job.result),snapshot_hash:state.review.snapshot_hash,group_id:group.id,issue_ids:group.issue_ids,
            base_id:base.id,source_epoch:base.source_epoch,expected_head:head.id,task_id:id,status:'QUEUED',candidate_hash:sha(planned.candidate),manifest:planned.manifest,
            decisions:planned.committed,committed_issue_ids:planned.committed_issue_ids,prior_committed_decisions:progress?.committed_decisions||{},decision_set_hash:planned.decision_set_hash,remaining_count:planned.remaining_count,created_at:new Date().toISOString()};
          mkdirSync(resolve(storage,id));store.transaction(()=>{persist(child);governance.begin(child);store.archiveRecord('component_submission_request',key,record);store.putRecord('component_submission',key,record);});
          jobs.set(id,child);active=id;void execute(child,globalProvider);return json(res,202,{...summary(child),submission_id:key});
        }
        if(req.method==='POST'&&humanMatch[2]==='review-group-decisions'){
          const body=await parseBody(req);if(!job.internal_scope||!state.review)throw Error('当前版本没有可合并处理的事项');
          governance.assertCandidateSources(job.id);
          if(store.listRecords('human_review_consumed').some(r=>r.task_id===job.id&&r.snapshot_hash===state.review.snapshot_hash))throw Error('此快照已提交继续，请打开后续版本');
          const decisions=expandGroupDecision(state.review,body),ids=new Set(decisions.map(d=>d.issue_id));
          assertComponentEditsOpen(state,[...ids]);
          if(state.decisions.some(d=>ids.has(d.issue_id)&&d.choice!=='RECHECK'))throw Error('此组已有逐项修正或排除决定，请保留逐项处理，不能被共同复核覆盖');
          applyReviewDecisions(state.review,[...state.decisions.filter(d=>!ids.has(d.issue_id)),...decisions],{input:job.input});
          store.transaction(()=>{for(const decision of decisions){
            const old=store.getRecord('human_review_decision',decision.id),saved=old||{...decision,created_at:new Date().toISOString()};
            if(!old){store.archiveRecord('human_review_decision',saved.id,saved);store.putRecord('human_review_decision',saved.id,saved);}
            store.putRecord('human_review_active',sha([job.id,state.review.snapshot_hash,decision.issue_id]),{task_id:job.id,snapshot_hash:state.review.snapshot_hash,issue_id:decision.issue_id,decision_id:saved.id});
          }});return json(res,200,{saved:decisions.length,decision_ids:decisions.map(d=>d.id)});
        }
        if(req.method==='POST'&&humanMatch[2]==='ontology-revision'){
          const body=await parseBody(req);
          if(!job.internal_scope||!state.review||body.snapshot_hash!==state.review.snapshot_hash)throw Error('本体核对快照已变化');
          if(typeof body.definition!=='string'||!body.definition.trim()||body.definition.length>1000)throw Error('请填写最多1000字的业务定义或身份说明');
          if(typeof body.request_id!=='string'||!idPattern.test(body.request_id))throw Error('需要有效的修订请求标识');
          governance.assertCandidateSources(job.id);
          const key=sha(['ONTOLOGY_REVISION',job.id,body.request_id]),fingerprint=sha([state.review.snapshot_hash,body.definition.trim()]);
          const old=store.getRecord('ontology_revision_request',key);
          if(old){if(old.fingerprint!==fingerprint)throw Error('同一请求标识的定义已变化');return json(res,202,{...summary(store.getTask(old.task_id)),deduplicated:true});}
          if(store.listRecords('human_review_consumed').some(r=>r.task_id===job.id&&r.snapshot_hash===state.review.snapshot_hash))throw Error('此快照已提交修订，请打开后续版本');
          if(!globalProvider||isBusy())return json(res,409,{error:'请连接模型并等待当前处理完成'});
          if(unfinishedComponent(job.id))throw Error('请先恢复或停止正在复核的组');
          const input=structuredClone(job.input);input.definitions=[input.definitions,body.definition.trim()].filter(Boolean).join('\n');
          if(input.definitions.length>3000)throw Error('定义总长度超过当前容量，请整理已有定义后修订');
          input.revision_context={parent_id:job.id,note:body.definition.trim(),review_snapshot_hash:state.review.snapshot_hash};
          const id=randomUUID(),context={operation:'BUILD',task_id:null,question:null},preview=budgets.preview(input,context);
          const budget=budgets.confirm({preview_id:preview.preview_id,max_calls:16+8*extractionUnits(input.sources).length,auto_repair:true,consent:true});
          const child={id,input,status:'QUEUED',stage:'queued',events:[],created_at:new Date().toISOString(),model:globalProvider.model,
            internal_scope:true,budget_id:budget.id,budget_context:context,publication_approved:false,cancel_requested:false,
            ...componentResumeBase(job),...(job.learning||job.learning_resolution?{learning_resolution:structuredClone(job.learning||job.learning_resolution)}:{}),
            revision:{kind:'ONTOLOGY_REVISION',parent_id:job.id,root_id:job.revision?.root_id||job.id,note:body.definition.trim()}};
          mkdirSync(resolve(storage,id));store.transaction(()=>{persist(child);governance.begin(child);
            store.archiveRecord('ontology_instruction',id,{parent_id:job.id,snapshot_hash:state.review.snapshot_hash,definition:body.definition.trim(),fingerprint});
            store.putRecord('human_review_consumed',sha([job.id,state.review.snapshot_hash,state.decision_set_hash]),{task_id:job.id,snapshot_hash:state.review.snapshot_hash,decision_set_hash:state.decision_set_hash,child_id:id,kind:'ONTOLOGY_REVISION'});
            store.putRecord('ontology_revision_request',key,{fingerprint,task_id:id,snapshot_hash:state.review.snapshot_hash,definition:body.definition.trim()});});
          jobs.set(id,child);active=id;void execute(child,globalProvider);return json(res,202,summary(child));
        }
        if(req.method==='POST'&&humanMatch[2]==='review-decisions'){
          const body=await parseBody(req);
          if(!state.review)throw Error('当前任务没有可处理的人工核对快照');
          if(job.internal_scope)governance.assertCandidateSources(job.id);
          const decision=validateReviewDecision(state.review,body),key=sha([job.id,state.review.snapshot_hash,decision.issue_id]);
          assertComponentEditsOpen(state,[decision.issue_id]);
          if(store.listRecords('human_review_consumed').some(r=>r.task_id===job.id&&r.snapshot_hash===state.review.snapshot_hash))throw Error('该人审快照已继续处理，请打开新版本');
          applyReviewDecisions(state.review,[...state.decisions.filter(d=>d.issue_id!==decision.issue_id),decision],{input:job.input});
          const existing=store.getRecord('human_review_decision',decision.id),saved=existing||{...decision,created_at:new Date().toISOString()};
          store.transaction(()=>{if(!existing){store.archiveRecord('human_review_decision',saved.id,saved);store.putRecord('human_review_decision',saved.id,saved);}
            store.putRecord('human_review_active',key,{task_id:job.id,snapshot_hash:state.review.snapshot_hash,issue_id:decision.issue_id,decision_id:saved.id});});
          return json(res,existing?200:201,saved);
        }
        if(req.method==='POST'&&humanMatch[2]==='review-continue'){
          const body=await parseBody(req);
          if(body.consent!==true)throw Error('校验并继续需要本次明确发送授权');
          if(!state.review||body.snapshot_hash!==state.review.snapshot_hash||body.decision_set_hash!==state.decision_set_hash)throw Error('人工候选或决定已变化，请重新预览');
          const prior=store.getRecord('human_review_consumed',sha([job.id,body.snapshot_hash,body.decision_set_hash]));
          if(prior)return json(res,202,{...summary(store.getTask(prior.child_id)),deduplicated:true});
          if(isBusy())return json(res,409,{error:'请等待当前操作结束'});
          if(unfinishedComponent(job.id))throw Error('请先恢复或停止正在复核的组');
          if(state.requires_component_resend_confirmation&&body.confirm_unknown_resend!==true)throw Error('本次包含结果未知的组，请单独确认再次发送');
          if(job.component_submission)throw Error('本组复核未通过，请返回原待核对事项修改决定后重新提交');
          const session=continuationFor(job,state),context={operation:'REVIEW_CONTINUE',task_id:job.id,question:null,
            snapshot_hash:state.review.snapshot_hash,decision_set_hash:state.decision_set_hash};
          if(job.internal_scope&&!body.budget_id){
            const preview=budgets.preview(job.input,{...context,review_candidate:session.candidate});
            const budget=budgets.confirm({preview_id:preview.preview_id,max_calls:2*preview.manifest.normal_calls+2,auto_repair:true,consent:true});
            body.budget_id=budget.id;
          }
          budgets.authorize(body.budget_id,job.input,context);
          const id=randomUUID();mkdirSync(resolve(storage,id));
          const child={id,input:structuredClone(job.input),status:'QUEUED',stage:'queued',events:[],created_at:new Date().toISOString(),
            model:globalProvider.model,budget_id:body.budget_id,budget_context:context,human_review:session,...componentResumeBase(job),
            result:{status:'BUILDING',...structuredClone(session.candidate)},cancel_requested:false,publication_approved:false,
            checkpoints:[],recovery_checkpoints:[],repairs:[],
            revision:{kind:'HUMAN_REVIEW_CONTINUE',parent_id:job.id,root_id:job.revision?.root_id||job.id,
              number:(job.revision?.number||1)+1,changes:session.audit,note:'人工决定后的候选复评；复用有效本体与抽取，不直接批准事实。',resolution:'REVALIDATING'}};
          store.transaction(()=>{store.archiveRecord('human_review_session',id,session);persist(child);
            store.putRecord('human_review_consumed',sha([job.id,body.snapshot_hash,body.decision_set_hash]),{task_id:job.id,snapshot_hash:body.snapshot_hash,decision_set_hash:body.decision_set_hash,child_id:id});});
          jobs.set(id,child);active=id;void execute(child,globalProvider);return json(res,202,summary(child));
        }
      }
      const usabilityMatch=pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})\/(diagnostics|issues|resume|decisions)$/);
      if(usabilityMatch) {
        const job=store.getTask(usabilityMatch[1]);if(!job)return json(res,404,{error:'任务不存在'});
        if(req.method==='GET'&&usabilityMatch[2]==='diagnostics')return json(res,200,presentation(job));
        if(req.method==='GET'&&usabilityMatch[2]==='issues')return json(res,200,taskIssues(job,store.listRecords('decision').filter(d=>d.task_id===job.id)));
        if(req.method==='POST'&&usabilityMatch[2]==='resume') {
          const body=await parseBody(req);
          if(body.consent!==true)throw Error('恢复会发送未完成阶段所需资料，请明确授权');
          if(!globalProvider||isBusy())return json(res,409,{error:'请先连接模型，并等待当前操作结束'});
          if(job.component_submission&&store.getRecord('component_submission',job.component_submission.id)?.status==='CANCELLED')throw Error('本组已停止，请返回原待核对事项重新提交');
          const diagnostics=presentation(job);
          const lastReview=[...(job.checkpoints||[])].reverse().find(c=>c.validated&&c.metadata?.stage===job.result?.review_stage&&c.metadata?.role==='evaluator');
          const structureContractChanged=job.result?.structure_learning?.version&&job.result.structure_learning.version!==STRUCTURE_CONTRACT;
          const reviewContractChanged=job.internal_scope&&job.status==='REVIEW_REQUIRED'&&((lastReview&&lastReview.metadata.prompt_sha256!==sha(workbenchReviewPrompt))||structureContractChanged);
          if(!diagnostics.allowed_actions.includes('RESUME')&&!reviewContractChanged)throw Error('当前版本无需技术恢复；业务决定请使用修订流程');
          const reviewRecheckKey=reviewContractChanged?sha([governance.candidateFor(job.id)?.base_id||job.id,job.input,job.result.schema,job.result.claims,job.result.review_stage,sha(workbenchReviewPrompt),STRUCTURE_CONTRACT]):null;
          const rechecked=reviewRecheckKey&&store.getRecord('review_contract_recheck',reviewRecheckKey);
          if(rechecked)return json(res,202,{...summary(store.getTask(rechecked.task_id)),deduplicated:true});
          if(diagnostics.requires_unknown_resend_confirmation&&body.confirm_unknown_resend!==true)throw Error('上次远端结果或计费未知，请单独确认允许重新发送未完成阶段');
          validateBuildInput(job.input);
          const budget_context={operation:'RESUME',task_id:job.id,question:null,...(job.human_review?{
            snapshot_hash:job.human_review.snapshot_hash,decision_set_hash:job.human_review.decision_set_hash}:{})};
          if(job.internal_scope&&!body.budget_id){
            if(typeof body.request_id!=='string'||!idPattern.test(body.request_id))throw Error('需要有效的恢复请求标识');
            const key=sha(['AUTOMATIC_RESUME',job.id,body.request_id]);
            const fingerprint=sha([job.input,job.checkpoints||[],job.repairs||[],budget_context]);
            const old=store.getRecord('automatic_resume',key);
            if(old){if(old.fingerprint!==fingerprint)throw Error('恢复检查点已变化，请重新发起');body.budget_id=old.budget_id;}
            else{
              const preview=budgets.preview(job.input,{...budget_context,...(job.human_review?{review_candidate:job.human_review.candidate}:{})});
              const budget=budgets.confirm({preview_id:preview.preview_id,max_calls:16+8*extractionUnits(job.input.sources).length,auto_repair:true,consent:true});
              body.budget_id=budget.id;store.putRecord('automatic_resume',key,{fingerprint,budget_id:budget.id});
            }
          }
          const requestKey=sha(['RESUME',job.id,body.budget_id,body.request_id || 'default']);
          const prior=store.getRecord('execution_request',requestKey);
          if(prior)return json(res,202,{...summary(store.getTask(prior.task_id)),deduplicated:true});
          budgets.authorize(body.budget_id,job.input,budget_context);
          const id=randomUUID();mkdirSync(resolve(storage,id));
          let expandedLearning=null;
          if(job.error_details?.code==='SYSTEM_STRUCTURE_COVERAGE_INCOMPLETE'&&job.learning?.retrieval_plan&&job.learning.retrieval_plan.unit_ids.length<job.learning.retrieval_plan.total_units){
            const base=governance.candidateFor(job.id)?.base_id,original=store.getTask(job.learning.base_task_id);
            expandedLearning={...job.learning,retrieval_plan:createLearningIndex(store,base).expand(job.learning.retrieval_plan,job.input.sources,job.learning.question,{entities:original.result.schema.entities,claims:original.result.claims})};
          }
          const child={id,input:structuredClone(job.input),status:'QUEUED',stage:'queued',events:[],created_at:new Date().toISOString(),
            budget_id:body.budget_id,budget_context,model:globalProvider.model,publication_approved:false,cancel_requested:false,
            recovery_checkpoints:recoveryCheckpointBank(job),
            ...(expandedLearning?{learning:expandedLearning}:{}),
            ...(job.failed_stage==='claims_review'&&job.result?.schema&&Array.isArray(job.result.claims)?{recovery_candidate:{origin_task_id:job.id,input_sha256:sha(job.input),schema_sha256:sha(job.result.schema),claims:structuredClone(job.result.claims)}}:{}),
            repairs:structuredClone(job.repairs || job.result?.repairs || []),
            ...(job.human_review?{human_review:structuredClone(job.human_review)}:{}),
            revision:{kind:'TECHNICAL_RESUME',parent_id:job.id,root_id:job.revision?.root_id || job.id,number:(job.revision?.number || 1)+1,
              note:reviewContractChanged?'评审契约更新后重新核对同一候选，不记录或代替用户业务决定。':'从匹配且通过校验的检查点恢复；未知请求已单独确认时才允许重发。',changes:[],resolution:'REVALIDATING'},display_name:job.input.name+' · 恢复'};
          store.transaction(()=>{persist(child);store.putRecord('execution_request',requestKey,{task_id:id});if(reviewRecheckKey)store.putRecord('review_contract_recheck',reviewRecheckKey,{task_id:id,parent_id:job.id,review_prompt_sha256:sha(workbenchReviewPrompt)});});jobs.set(id,child);active=id;void execute(child,globalProvider);
          return json(res,202,summary(child));
        }
        if(req.method==='POST'&&usabilityMatch[2]==='decisions') {
          const body=await parseBody(req);
          if(body.version!==job.id)throw Error('版本已变化，请重新查看待确认事项');
          const groups=taskIssues(job),issue=[...groups.user_decisions,...groups.evidence_requests,...groups.conflicts].find(i=>i.id===body.issue_id);
          if(!issue)throw Error('不是当前版本可确认的问题，系统格式错误不应提交业务决定');
          if(!['KEEP_CONFLICT','CONFIRM_DEFINITION','ADD_EVIDENCE'].includes(body.choice))throw Error('决定类型无效');
          if(typeof body.note!=='string'||body.note.length>2000)throw Error('请提供不超过2000字的决定说明');
          if(body.choice==='KEEP_CONFLICT'&&!groups.conflicts.some(i=>i.id===body.issue_id))throw Error('此项不是知识冲突');
          const key=sha([job.id,body.issue_id,body.choice,body.note,body.definition || null]);
          const prior=store.getRecord('decision',key);if(prior)return json(res,200,prior);
          const decision={id:key,task_id:job.id,issue_id:body.issue_id,version:job.id,choice:body.choice,note:body.note,created_at:new Date().toISOString()};
          let child;
          if(body.choice!=='KEEP_CONFLICT') {
            const input=structuredClone(job.input);
            if(body.choice==='CONFIRM_DEFINITION') {
              if(typeof body.definition!=='string'||!body.definition.trim()||body.definition.length>1000)throw Error('请填写待合入的业务定义（最多1000字）');
              input.definitions=[input.definitions,body.definition.trim()].filter(Boolean).join('\n');
              if(input.definitions.length>3000)throw Error('合入后定义超过3000字');
            }
            const id=randomUUID();mkdirSync(resolve(storage,id));
            child={id,input,status:'DRAFT',stage:'DRAFT',events:[],created_at:new Date().toISOString(),publication_approved:false,cancel_requested:false,
              requires_evidence_edit:body.choice==='ADD_EVIDENCE',revision:{kind:'USER_DECISION',parent_id:job.id,root_id:job.revision?.root_id || job.id,number:(job.revision?.number || 1)+1,note:body.note || '用户决定创建修订草稿',
                changes:body.choice==='CONFIRM_DEFINITION'?[{field:'definitions',before_sha256:sha(job.input.definitions),after_sha256:sha(input.definitions)}]:[],resolution:'PENDING_REVALIDATION',decision_id:key}};
            decision.draft_id=id;
          }
          store.transaction(()=>{if(child)persist(child);store.archiveRecord('decision',key,decision);store.putRecord('decision',key,decision);});
          if(child)jobs.set(child.id,child);
          return json(res,201,decision);
        }
      }
      if (req.method === 'POST' && pathname === '/api/embedding-profile') {
        if (active || benchmarkControllers.size || modelOperations) return json(res, 409, { error: '请等待当前操作结束' });
        const body = await parseBody(req);
        // Validate without probing: configuration must not incur a paid request.
        const selected = createEmbeddingProvider({ baseUrl: body.base_url, model: body.model, apiKey: body.api_key,
          allowInsecureHttp: body.allow_insecure_http === true });
        embeddingProfile = { base_url: selected.root, model: selected.model, allow_insecure_http: body.allow_insecure_http === true };
        store.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('embedding', JSON.stringify(embeddingProfile));
        embeddingProvider = selected;
        return json(res, 200, { ...embeddingProfile, configured: true, probed: false, notice: '仅保存非密配置；尚未调用嵌入接口，不表示真实评测已授权。' });
      }
      if (req.method === 'GET' && pathname === '/api/benchmarks/prepare') return json(res, 200,
        prepareBenchmark({ dataset: makeDataset(), mode: 'mock', rounds: 3 }));
      if (req.method === 'GET' && pathname === '/api/benchmarks') return json(res, 200,
        store.listRecords('benchmark').map(({ id, status, created_at, mode, preview, error }) => ({ id, status, created_at, mode, preview, error })));
      if (req.method === 'POST' && pathname === '/api/benchmarks') {
        const body = await parseBody(req);
        if ((body.mode ?? 'mock') !== 'mock') return json(res, 409, { status: 'BLOCKED_AUTHORIZATION', error: '本轮仅允许离线流程。真实评测需另行确认生成/嵌入配置、价格、发送范围及预算。' });
        if (benchmarkControllers.size || active || modelOperations) return json(res, 409, { error: '已有任务执行中，请先等待或停止。' });
        const id = randomUUID(), rounds = body.rounds ?? 3;
        const preview = prepareBenchmark({ mode: 'mock', rounds });
        const controller = { cancelled: false }; benchmarkControllers.set(id, controller);
        store.putRecord('benchmark', id, { id, mode: 'mock', status: 'RUNNING', preview, created_at: new Date().toISOString() });
        const archivedAttempts = new Set();
        const hooks = { getRecord: key => store.getRecord('bench:' + id, key), putRecord: (key, value) => {
          if (key === 'attempts') for (const attempt of value) if (attempt.status !== 'STARTED' && !archivedAttempts.has(attempt.id)) {
            store.archiveRecord('benchmark_attempt', attempt.id, attempt); archivedAttempts.add(attempt.id);
          }
          return store.putRecord('bench:' + id, key, value);
        } };
        void runBenchmark({ mode: 'mock', rounds, runId: id, ...hooks, cancelled: () => controller.cancelled,
          cqforge: createCQForgeAdapter({ store, offline: true, runId: id }) }).then(report => {
          saveResponse(id, report);
          store.putRecord('benchmark', id, { ...store.getRecord('benchmark', id), status: controller.cancelled ? 'CANCELLED' : 'COMPLETED', report, finished_at: new Date().toISOString() });
        }).catch(error => store.putRecord('benchmark', id, { ...store.getRecord('benchmark', id), status: 'FAILED', error: error.code || 'BENCHMARK_FAILED', finished_at: new Date().toISOString() }))
          .finally(() => benchmarkControllers.delete(id));
        return json(res, 202, { id, status: 'RUNNING', mode: 'mock', preview });
      }
      const benchMatch = pathname.match(/^\/api\/benchmarks\/([a-f0-9-]{36})(?:\/(cancel|export|review|sources))?$/);
      if (benchMatch) {
        const run = store.getRecord('benchmark', benchMatch[1]); if (!run) return json(res, 404, { error: '评测不存在' });
        if (req.method === 'GET' && benchMatch[2] === 'sources') {
          const dataset = makeDataset();
          if (prepareBenchmark({ dataset }).dataset_hash !== run.preview.dataset_hash) return json(res, 409, { error: '当前合成资料版本与运行不一致，不能用于核验旧报告' });
          return json(res, 200, { groups: dataset.groups.map(({ id, sources, snapshots }) => ({ id, sources, snapshots })) });
        }
        if (req.method === 'POST' && benchMatch[2] === 'review') {
          const body = await parseBody(req);
          const row = run.report?.rows.find(r => r.group === body.group && r.snapshot === body.snapshot
            && r.round === body.round && r.variant === body.variant && r.question_id === body.question_id);
          if (!row || !['SUPPORTED', 'UNSUPPORTED', 'UNCERTAIN'].includes(body.judgment)) throw Error('请选择已完成的题目与有效语义核验结果');
          if (typeof body.note !== 'string' || body.note.length > 2000 || !Number.isFinite(body.duration_seconds) || body.duration_seconds < 0) throw Error('请提供核验说明与非负耗时');
          const review = { id: randomUUID(), run_id: run.id, group: row.group, snapshot: row.snapshot, round: row.round,
            variant: row.variant, question_id: row.question_id, judgment: body.judgment, note: body.note,
            duration_seconds: body.duration_seconds, created_at: new Date().toISOString() };
          store.putRecord('semantic_review', review.id, review);
          return json(res, 201, review);
        }
        if (req.method === 'POST' && benchMatch[2] === 'cancel') {
          const controller = benchmarkControllers.get(run.id); if (!controller) return json(res, 409, { error: '评测已结束' });
          controller.cancelled = true; return json(res, 200, { status: 'CANCELLING' });
        }
        if (req.method === 'GET' && benchMatch[2] === 'export') {
          if (!run.report) return json(res, 409, { error: '评测报告尚未完成' });
          const csv = new URL(req.url, 'http://localhost').searchParams.get('format') === 'csv';
          res.writeHead(200, { 'Content-Type': csv ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
            'Content-Disposition': 'attachment; filename="cqforge-benchmark-' + run.id + (csv ? '.csv' : '.json') + '"', 'Cache-Control': 'no-store' });
          const reviews = store.listRecords('semantic_review').filter(r => r.run_id === run.id);
          const report = reviewedReport(run.report, reviews);
          return res.end(csv ? reportCsv(report) : JSON.stringify(report, null, 2));
        }
        if (req.method === 'GET' && !benchMatch[2]) {
          const progress = store.getRecord('bench:' + run.id, 'rows') || [];
          const reviews = store.listRecords('semantic_review').filter(r => r.run_id === run.id);
          return json(res, 200, { ...run, report: reviewedReport(run.report, reviews), semantic_reviews: reviews,
            progress: { completed: progress.length, scheduled: run.preview.scheduled_answers } });
        }
      }
      if (req.method === 'GET' && pathname === '/api/cq-proposals') return json(res, 200, store.listRecords('proposal'));
      if (req.method === 'POST' && pathname === '/api/cq-proposals') {
        const body = await parseBody(req);
        if (body.action === 'confirm') {
          const draft = store.getRecord('proposal', body.id); if (!draft) throw Error('CQ建议草稿不存在');
          const confirmed = confirmCQProposal(draft, body);
          store.putRecord('proposal', body.id, { ...draft, status: 'CONFIRMED', confirmed_input: confirmed, confirmed_at: new Date().toISOString() });
          return json(res, 200, { id: body.id, status: 'CONFIRMED', input: confirmed });
        }
        if (!globalProvider) return json(res, 409, { error: '请先配置模型；建议扩展不是离线功能' });
        if (active || benchmarkControllers.size || modelOperations) return json(res, 409, { error: '请等待当前任务结束',code:'WORKSPACE_BUSY' });
        const input = prepareInput(body), id = randomUUID(), selected = globalProvider;
        validateBuildInput(input);
        const budget_context={operation:'EXPAND',task_id:null,question:null};
        const operationKey=sha(['EXPAND',body.budget_id,body.request_id || 'default']);
        const previous=store.getRecord('remote_operation',operationKey);
        if(previous){if(previous.input_sha256!==sha(input))return json(res,409,{error:'原请求的输入已变化，请重新确认预算'});if(previous.status==='COMPLETED')return json(res,200,{...store.getRecord('proposal',previous.proposal_id),reused_result:true});return json(res,409,{error:'此请求已执行或结果未知，不会自动重复发送；请查看记录并显式确认新操作'});}
        budgets.authorize(body.budget_id,input,budget_context);
        store.putRecord('remote_operation',operationKey,{status:'STARTED',input_sha256:sha(input),operation_id:id,budget_id:body.budget_id});
        modelOperations++;
        try {
        const draft = await proposeCQs(input, operationProvider(selected, id, 'cq_expansion', null, body.budget_id,input,budget_context),
          { consent: body.consent === true, onAttempt: record => saveResponse(id, record) });
        const record = { ...draft, id, created_at: new Date().toISOString(), model: selected.model };
        store.transaction(()=>{store.putRecord('proposal', id, record);store.putRecord('remote_operation',operationKey,{status:'COMPLETED',input_sha256:sha(input),proposal_id:id,budget_id:body.budget_id});}); return json(res, 201, record);
        } catch(error){store.putRecord('remote_operation',operationKey,{status:'FAILED_OR_UNKNOWN',input_sha256:sha(input),operation_id:id,budget_id:body.budget_id});throw error;} finally { modelOperations--;scheduleRecovery(); }
      }
      let capabilityMatch = pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})\/(capabilities|ask|execute|attempts)$/);
      const libraryAsk=pathname.match(/^\/api\/knowledge-bases\/(kb_[a-f0-9-]{36})\/ask$/);
      if(req.method==='POST'&&libraryAsk){
        const state=governance.baseFor(libraryAsk[1]);
        if(!state?.head_task_id)return json(res,409,{error:'知识库尚无可查询版本'});
        capabilityMatch=[pathname,state.head_task_id,'ask'];
      }
      if (capabilityMatch) {
        const storedJob = store.getTask(capabilityMatch[1]); if (!storedJob) return json(res, 404, { error: '任务不存在' });
        const job=governance.view(storedJob);
        if (req.method === 'GET' && capabilityMatch[2] === 'attempts') return json(res, 200, store.listRecords('attempt').filter(a => a.task_id === job.id));
        const catalog = catalogFor(job);
        if (req.method === 'GET' && capabilityMatch[2] === 'capabilities') return json(res, 200, catalog);
        if (req.method === 'POST') {
          const body = await parseBody(req);
          if (body.backend && body.backend !== 'SQLITE') throw Error('新查询能力当前仅支持SQLITE；旧CQ查询的Neo4j接口保持不变');
          if (capabilityMatch[2] === 'execute') return json(res, 200, await executeTyped(job, catalog, body.capability_id, body.params,
            { queryPlan: governance.query, question: body.question }));
          if (capabilityMatch[2] === 'ask') {
            if (body.consent !== true) throw Error('自然语言提问会发送问题、能力目录和证据，请明确授权');
            if (!globalProvider) return json(res, 409, { error: '请先重新输入模型密钥',code:'MODEL_NOT_CONNECTED' });
            if (active || benchmarkControllers.size || modelOperations) return json(res, 409, { error: '请等待当前任务结束',code:'WORKSPACE_BUSY' });
            if(job.internal_scope===true&&!body.budget_id){
              if(typeof body.request_id!=='string'||!idPattern.test(body.request_id))throw Error('请提供有效的提问请求标识');
              if(typeof body.question!=='string'||!body.question.trim()||body.question.length>1000)throw Error('问题长度需为1–1000字符');
              const key=sha(['AUTO_ASK',job.id,body.request_id]),fingerprint=sha([job.input,body.question]);
              const previous=store.getRecord('automatic_query',key);
              if(previous){if(previous.fingerprint!==fingerprint)throw Error('同一请求标识的问题已变化');body.budget_id=previous.budget_id;}
              else{
                const preview=budgets.preview(job.input,{operation:'ASK',task_id:job.id,question:body.question});
                const budget=budgets.confirm({preview_id:preview.preview_id,max_calls:16+2*extractionUnits(job.input.sources).length,auto_repair:false,consent:true});
                body.budget_id=budget.id;store.putRecord('automatic_query',key,{fingerprint,budget_id:budget.id});
              }
            }
            const operationKey=sha(['ASK',job.id,body.budget_id,body.question,body.request_id || 'default']);
            const readStamp=governance.stamp(job.id);
            const previous=store.getRecord('remote_operation',operationKey);
            if(previous){if(previous.status==='COMPLETED'){governance.assertStamp(previous.source_stamp||(readStamp?{...readStamp,source_epoch:0}:null));return json(res,200,{...previous.response,reused_result:true});}return json(res,409,{error:'此请求已执行或结果未知，不会自动重复发送；请查看记录并显式确认新操作'});}
            modelOperations++;
            try {
            const budget_context={operation:'ASK',task_id:job.id,question:body.question};
            budgets.authorize(body.budget_id,job.input,budget_context);
            store.putRecord('remote_operation',operationKey,{status:'STARTED',budget_id:body.budget_id,task_id:job.id});
            const id = randomUUID(), baseProvider = globalProvider, selected = operationProvider(baseProvider, id, 'query_route', job.id,body.budget_id,job.input,budget_context);
            if(!externalCall&&String(req.headers.accept||'').includes('text/event-stream'))res.answerStream=openAnswerStream(res);
            const sendEvent=(event,data)=>{if(['sources','answer_delta','answer_block'].includes(event))governance.assertStamp(readStamp);res.answerStream?.send(event,{...data,operation_id:id,task_id:job.id});};
            sendEvent('progress',{phase:'understanding',message:'正在理解问题…'});
            const scope=semanticScope(job,{base_id:readStamp?.base_id||job.id,source_epoch:readStamp?.source_epoch||0,...(readStamp?{sources:activeSources(governance.baseFor(readStamp.base_id),storedJob).sources}:{})});
            const routeOptions={consent:true,onAttempt:record=>saveResponse(id,record),entityBindings:semanticMemory.bindings(scope),enforceStructureIntent:job.internal_scope===true,intentCache:new Map()};
            let routed = await routeQuestion(job, catalog, body.question, selected,routeOptions);
            if(routed.status==='NEEDS_CLARIFICATION'&&['ENTITY_BINDING','SEMANTIC_UNRESOLVED'].includes(routed.failure_kind)){
              sendEvent('progress',{phase:'identity',message:'正在核实问题中的主体…'});
              const semanticProvider=operationProvider(baseProvider,id,'expression_verification',job.id,body.budget_id,job.input,budget_context);
              const resolved=await semanticMemory.resolve({question:body.question,scope,provider:semanticProvider,
                persist:!!(libraryAsk&&job.internal_scope&&body.learn!==false),assertFresh:()=>governance.assertStamp(readStamp),operation_id:id});
              if(resolved.status==='RESOLVED')routed=await routeQuestion(job,catalog,body.question,selected,{...routeOptions,entityBindings:[...routeOptions.entityBindings,...resolved.bindings]});
              else if(resolved.reason)routed={...routed,reason:resolved.reason};
            }
            if(['DIRECT_RESPONSE','OUT_OF_SCOPE'].includes(routed.status)){
              governance.assertStamp(readStamp);
              if(routed.status==='DIRECT_RESPONSE'&&body.learn!==false&&(!externalCall||externalCall.mode==='LEARN'))excludeNonKnowledge(readStamp?.base_id,body.question,routed.intent);
              const response=routed.status==='DIRECT_RESPONSE'?{status:'ANSWERED',answer:{answer_mode:'PRODUCT',classification:'NOT_APPLICABLE',text:routed.text,items:[]},claims:[],operation_id:id,task_id:job.id,version:job.id}:{status:'OUT_OF_SCOPE',reason:routed.reason,claims:[],operation_id:id,task_id:job.id,version:job.id};
              store.putRecord('remote_operation',operationKey,{status:'COMPLETED',response,source_stamp:readStamp});return json(res,200,response);
            }
            const maybeLearn=()=>queueLearning(storedJob,body.question,{integration:externalCall,requirement:routed.requirement,admissionProvider:operationProvider(baseProvider,id,'learning_admission',job.id,body.budget_id,job.input,budget_context),onProgress:p=>sendEvent('progress',p)});
            if (routed.status !== 'MATCHED') {
              governance.assertStamp(readStamp);
              const canLearn=libraryAsk&&job.internal_scope&&body.learn!==false&&routed.status==='UNSUPPORTED'&&routed.requirement?.intent==='KNOWLEDGE_QUERY'&&!/\d{4}[-年/]|历史|当时|截至|修订|as of|previously/i.test(body.question);
              const knownGap=libraryAsk&&readStamp&&store.getRecord('learning_observation',learningObservationId(readStamp.base_id,body.question,readStamp.source_epoch));
              const learning=canLearn?await maybeLearn():knownGap?.status==='WAIT_EVIDENCE'?{status:knownGap.search_scope==='LOCAL_INCOMPLETE'?'UNKNOWN':'WAIT_EVIDENCE',reason:knownGap.reason||'已检查相关资料，当前仍缺少依据；补充资料后会继续学习。'}:{};
              if(learning.status==='QUERY_RETRY'){
                routed=await routeQuestion(job,catalog,body.question,selected,{...routeOptions,evidenceHints:learning.evidence_hints});
                if(routed.status!=='MATCHED'){const response={status:'UNSUPPORTED',reason:'资料中已有相关知识，但暂未形成可靠的查询，请具体说明目标属性。',claims:[],operation_id:id,task_id:job.id,version:job.id};store.putRecord('remote_operation',operationKey,{status:'COMPLETED',response,source_stamp:readStamp});return json(res,200,response);}
              }else{
              const response={ status:routed.status,reason:routed.reason,...learning,operation_id:id,backend:'SQLITE',task_id:job.id,version:job.id,claims:[] };
              store.putRecord('remote_operation',operationKey,{status:'COMPLETED',response,source_stamp:readStamp});return json(res,200,response);
              }
            }
            governance.assertStamp(readStamp);
            sendEvent('progress',{phase:'retrieval',message:'正在查找相关资料…'});
            const gate = await executeTyped(job, catalog, routed.capability_id, routed.params, { queryPlan: governance.query, question: body.question });
            if(gate.classification==='UNKNOWN'&&libraryAsk&&job.internal_scope&&body.learn!==false&&routed.requirement?.intent==='KNOWLEDGE_QUERY'){
              governance.assertStamp(readStamp);const learning=await maybeLearn();
              const response={...gate,...learning,...(learning.status==='QUERY_RETRY'?{status:'WAIT_EVIDENCE',reason:'已发现相关知识，但当前查询缺少完整的现行证据，需要进一步核对。'}:{}),task_id:job.id,version:job.id,operation_id:id};
              store.putRecord('remote_operation',operationKey,{status:'COMPLETED',response,source_stamp:readStamp});return json(res,200,response);
            }
            if(gate.pending_review){const response={...gate,status:'WAIT_REVIEW',answer:{classification:'CONFLICT',items:[],reason:gate.reason},operation_id:id};store.putRecord('remote_operation',operationKey,{status:'COMPLETED',response,source_stamp:readStamp});return json(res,200,response);}
            const answerProvider = operationProvider(baseProvider, id, 'answer', job.id,body.budget_id,job.input,budget_context);
            const answer = await answerFromClaims({ job, question: { id, text: body.question }, gate: { ...gate, query_template: routed.binding.plan.template,predicate_id:routed.binding.plan.predicate_id }, provider: answerProvider,reviewProvider:operationProvider(baseProvider,id,'answer_review',job.id,body.budget_id,job.input,budget_context),presentation:'SUMMARY',synthesis:true,onEvent:sendEvent });
            saveResponse(id, { route: { capability_id: routed.capability_id, params: routed.params }, answer });
            const response={ ...gate, status: 'ANSWERED', answer, operation_id: id, reason: '按当前版本能力检索；来源陈述不等于独立事实认证。' };
            governance.assertStamp(readStamp);store.putRecord('remote_operation',operationKey,{status:'COMPLETED',response,source_stamp:readStamp});return json(res,200,response);
            } catch(error){if(store.getRecord('remote_operation',operationKey))store.putRecord('remote_operation',operationKey,{status:'FAILED_OR_UNKNOWN',budget_id:body.budget_id,task_id:job.id});throw error;} finally { modelOperations--;scheduleRecovery(); }
          }
        }
      }
      if (req.method === 'GET' && pathname === '/api/migration') return json(res, 200, migration);
      if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { status: 'UP', backend: 'SQLITE', acceptance,integration_api:productRuntime?'MAIN_PRODUCT_LOCAL_ONLY':'v1',storage: resolve(storage), workspace, instance, pid: process.pid, active_task: active, active_evaluation: benchmarkControllers.size > 0, active_model_operation: modelOperations > 0, migration_errors: migration.errors.length,...(memoryServerIntegration?{memory_product:memoryServerIntegration.metadata()}:{}) });
      if (req.method === 'GET' && pathname === '/api/environment') return json(res, 200, { node: { supported: supportedNode(), version: process.versions.node }, parser: parserHealth(), model_calls: 0 });
      if (req.method === 'POST' && pathname === '/api/documents') {
        if (req.headers['content-type'] !== 'application/octet-stream') throw Error('文件需要二进制上传');
        const filename = decodeURIComponent(String(req.headers['x-cqforge-filename'] || ''));
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 20 * 1024 * 1024) throw Error('文件超过20MB'); chunks.push(chunk); }
        return json(res, 200, await documents.parse(Buffer.concat(chunks), filename));
      }
      const docMatch = pathname.match(/^\/api\/documents\/([a-f0-9-]{36})\/original$/);
      if (req.method === 'GET' && docMatch) {
        const owners=store.listTasks().filter(j=>j.input.sources.some(s=>s.parsing?.document_id===docMatch[1]));const sourceOwners=store.listRecords('library_source').filter(r=>r.source?.parsing?.document_id===docMatch[1]);if((owners.length||sourceOwners.length)&&!owners.some(visibleTask)&&!sourceOwners.some(r=>libraryActive(store,r.base_id)))throw accessError('DOCUMENT_UNAVAILABLE','资料所在知识库已移入回收站',410);
        const { meta, path } = documents.original(docMatch[1]);
        res.writeHead(200, { 'Content-Type': meta.extension === '.pdf' ? 'application/pdf' : meta.extension === '.md' ? 'text/markdown; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(meta.title),
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(readFileSync(path));
      }
      if (req.method === 'GET' && pathname === '/api/bootstrap') return json(res, 200, { token,...(memoryServerIntegration?{memory_product:memoryServerIntegration.metadata()}:{}),
        source_first:{enabled:Boolean(sourceProduct),route:'/api/knowledge-bases/:id/source-first',access:'LOCAL_WORKBENCH_CSRF_ONLY',default_path_adopted:Boolean(productRuntime),...(productRuntime?{workspace_ui:'LIGHTOG_WORKSPACE_V1'}:{})},
        product_flow:'knowledge_m1',acceptance,knowledge_bases:libraries(),trash_count:store.listRecords('library_lifecycle').filter(b=>['TRASHED','PURGING'].includes(b.status)).length,
        configured: Boolean(globalProvider), model: globalProvider?.model ?? globalProfile.model ?? '', base_url: globalProfile.baseUrl ?? '',
        max_tokens: globalProvider?.maxTokens || globalProfile.maxTokens || 8000,
        thinking_mode: globalProvider?.thinkingMode ?? globalProfile.thinkingMode ?? 'default',
        allow_insecure_http: globalProfile.allowInsecureHttp ?? false, active_task: active,
        graph: graph?.info || { connected: false, workspace },
        backend: 'SQLITE', migration,
        embedding: { ...embeddingProfile, configured: Boolean(embeddingProvider), probed: false },
        tasks: store.listTasks().filter(j => !j.benchmark_run_id&&visibleTask(j)).map(summary).sort((a, b) => b.created_at.localeCompare(a.created_at)),
        limits: { cqs: 12, sources: 8, total_characters: null, model_calls_per_task: null, upload_bytes:20*1024*1024,request_bytes:64*1024*1024 },
        execution_limits:{sources:8,total_utf16:null,source_utf16:null,automatic_chunking:true,max_repairs:null,max_repairs_per_unit:1,semantic_revision_rounds:1,max_batch_calls:null} });
      if (req.method === 'POST' && pathname === '/api/graph/connect') {
        if (active) return json(res, 409, { error: '请等待当前任务结束后连接数据库' });
        const next = await graphConnector(await parseBody(req), workspace);
        const previous = graph; graph = next;
        if (previous) await previous.close();
        return json(res, 200, graph.info);
      }
      if (req.method === 'POST' && pathname === '/api/graph/disconnect') {
        if (active) return json(res, 409, { error: '请等待当前任务结束后断开数据库' });
        if (graph) await graph.close(); graph = null;
        return json(res, 200, { connected: false });
      }
      if (req.method === 'GET' && pathname === '/api/sample') return json(res, 200, {
        name: '全球服务商 · 合成演示', definitions: '服务覆盖指资料明确陈述的服务交付地区，不是办公室所在地。所有公司均为虚构。',
        cqs: ['示例服务商A在哪些地区提供客户支持？', '哪些服务商有欧洲客户支持的来源陈述？', '示例服务商B是否提供制造业技术支持？'],
        sources: [{ title: '服务商A · 能力说明', content: '【合成资料】示例服务商A在欧洲和东南亚提供客户支持服务。示例服务商A为制造业客户提供技术支持。' },
          { title: '服务商B · 能力说明', content: '【合成资料】示例服务商B在欧洲和拉美提供客户支持服务。示例服务商B提供电商客户服务。' }] });
      if (req.method === 'POST' && pathname === '/api/model') {
        if (active || benchmarkControllers.size || modelOperations) return json(res, 409, { error: '请等待当前任务结束后修改模型' });
        const body = await parseBody(req);
        if (isBusy()) return json(res, 409, { error: '请等待当前操作结束' });
        if (!body.api_key?.trim() && !globalProvider) return json(res, 409, {
          error: '模型尚未连接，请在设置中输入 API 密钥并保存连接；服务重启后需重新连接。', code: 'MODEL_NOT_CONNECTED' });
        modelOperations++;
        try {
        if (!body.api_key && globalProvider && body.base_url === globalProfile.baseUrl && body.model === globalProvider.model
          && (body.allow_insecure_http === true) === (globalProfile.allowInsecureHttp === true)) {
          const thinkingMode = body.thinking_mode ?? globalProvider.thinkingMode ?? 'default';
          if (!['default', 'enabled', 'disabled'].includes(thinkingMode)) throw Error('思考模式配置无效');
          if (thinkingMode !== (globalProvider.thinkingMode ?? 'default') && !globalProvider.withOptions) throw Error('当前适配器不支持变更思考模式，请重新输入密钥');
          const next = globalProvider.withOptions ? globalProvider.withOptions({ maxTokens: body.max_tokens ?? globalProvider.maxTokens, thinkingMode })
            : body.max_tokens === undefined ? globalProvider : globalProvider.withMaxTokens(body.max_tokens);
          await next.probe(); globalProvider = next;
          globalProfile.maxTokens = next.maxTokens; globalProfile.thinkingMode = thinkingMode; store.setProfile(globalProfile);
          return json(res, 200, { configured: true, model: globalProvider.model });
        }
        const next = createProvider({ baseUrl: body.base_url, model: body.model, apiKey: body.api_key, timeoutMs:600000,
          allowInsecureHttp: body.allow_insecure_http === true, maxTokens: body.max_tokens ?? globalProfile.maxTokens ?? 8000,
          thinkingMode: body.thinking_mode ?? 'default' });
        await next.probe(); globalProvider = next;
        globalProfile = { baseUrl: body.base_url, model: body.model, maxTokens: next.maxTokens, allowInsecureHttp: body.allow_insecure_http === true, thinkingMode: next.thinkingMode };
        store.setProfile(globalProfile);
        return json(res, 200, { configured: true, model: next.model });
        } finally { modelOperations--;scheduleRecovery(); }
      }
      if (req.method === 'POST' && pathname === '/api/tasks') {
        if (!globalProvider) return json(res, 409, { error: '请先连接全局模型' });
        if (active || benchmarkControllers.size || modelOperations) return json(res, 409, { error: '原型一次执行一个任务，请等待或停止当前任务' });
        const body = await parseBody(req);
        if (body.parent_id) throw Error('修订请先保存修订草稿，再重新验证');
        let input;
        if (body.proposal_id) {
          if (body.consent !== true) throw Error('确认CQ范围不代表允许发送资料，请重新授权构建');
          const draft = store.getRecord('proposal', body.proposal_id);
          if (!draft || draft.status !== 'CONFIRMED') throw Error('CQ范围尚未确认');
          input = structuredClone(draft.confirmed_input);
        } else input = prepareInput(body);
        validateBuildInput(input);
        const budget_context={operation:'BUILD',task_id:null,question:null};
        const requestKey=sha(['BUILD',body.budget_id,body.request_id || 'default']);
        const prior=store.getRecord('execution_request',requestKey);
        if(prior){if(prior.input_sha256!==sha(input))return json(res,409,{error:'同一请求键对应的输入已变化，请重新预览预算'});return json(res,202,{...summary(store.getTask(prior.task_id)),deduplicated:true});}
        budgets.authorize(body.budget_id,input,budget_context);
        if (isBusy()) return json(res, 409, { error: '另一个操作已开始，请等待结束' });
        const id = randomUUID();
        mkdirSync(resolve(storage, id));
        const job = { id, input, status: 'QUEUED', stage: 'queued', events: [], created_at: new Date().toISOString(),
          model: globalProvider.model, budget_id:body.budget_id,budget_context, publication_approved: false, cancel_requested: false };
        store.transaction(()=>{persist(job);store.putRecord('execution_request',requestKey,{task_id:id,input_sha256:sha(input)});}); jobs.set(id, job);active = id; void execute(job, globalProvider);
        return json(res, 202, summary(job));
      }
      const match = pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})(?:\/(query|cancel|revisions|start|sync|diff|retry))?$/);
      if (match) {
        const job = req.method === 'GET' ? store.getTask(match[1]) : jobs.get(match[1]); if (!job) return json(res, 404, { error: '任务不存在' });
        if (req.method === 'GET' && !match[2]) {const visible=governance.view(job);return json(res, 200, { ...visible,...(job.component_submission?{component_origin_task_id:store.getRecord('component_submission',job.component_submission.id)?.origin_task_id}:{}),evidence_contexts:evidenceContexts(visible),
          ...(job.status === 'READY' ? { result: { ...job.result,
            runtime_issues: queryPlanIssues(job.result.schema, job.input),
            ...visible.result,answers: job.input.cqs.map(q => ({ cq_id: q.id, question: q.question, ...answerCQ(visible.result, job.input, q.id) })),
            answer_policy: 'target_binding_v1_current_policy_not_stored_model_answer' } } : {}),
          diagnostics: job.status === 'FAILED' ? diagnoseTask(job, storage) : null,
          presentation:presentation(job),stage_label:presentation(job).category==='HUMAN_REVIEW'?'等待人工核对':taskDiagnostics(job).category==='PAUSED_BUDGET'?stageLabels.PAUSED:stageLabels[job.stage] || job.stage });}
        if (req.method === 'GET' && match[2] === 'diff') {
          const parent = jobs.get(job.revision?.parent_id);
          if (!parent) return json(res, 404, { error: '无可用父版本' });
          return json(res, 200, versionDiff(parent, job));
        }
        if (req.method === 'POST' && match[2] === 'retry') {
          if(job.component_submission&&store.getRecord('component_submission',job.component_submission.id)?.status==='CANCELLED')throw Error('本组已停止，请返回原待核对事项重新提交');
          if (!taskDiagnostics(job).allowed_actions.includes('FULL_REBUILD')) return json(res, 409, { error: '只有技术失败、中断或停止的任务可重试；业务待处理内容需修订' });
          const body = await parseBody(req);
          if (body.consent !== true) throw Error('重试会重新发送本任务资料，请明确授权');
          if (isBusy() || !globalProvider) return json(res, 409, { error: '请连接模型并等待当前任务结束' });
          validateBuildInput(job.input);
          if(taskDiagnostics(job).requires_unknown_resend_confirmation&&body.confirm_unknown_resend!==true)throw Error('上次远端结果或计费未知，请确认允许重发');
          const budget_context={operation:'RETRY',task_id:job.id,question:null};
          const requestKey=sha(['RETRY',job.id,body.budget_id,body.request_id || 'default']);
          const prior=store.getRecord('execution_request',requestKey);
          if(prior)return json(res,202,{...summary(store.getTask(prior.task_id)),deduplicated:true});
          budgets.authorize(body.budget_id,job.input,budget_context);
          const maxTokens = body.max_tokens ?? globalProvider.maxTokens ?? 8000;
          if (!Number.isInteger(maxTokens) || maxTokens < 1024 || maxTokens > 32768) throw Error('输出上限需为1024–32768的整数');
          if(globalProvider.maxTokens&&maxTokens!==globalProvider.maxTokens)throw Error('请先在模型设置调整输出上限，再重新确认预算；不静默改变批次参数');
          const selected = globalProvider.withMaxTokens ? globalProvider.withMaxTokens(maxTokens) : globalProvider;
          const id = randomUUID(); mkdirSync(resolve(storage, id));
          const input = structuredClone(job.input);
          input.name = (input.name.slice(0, 90) + ' · 重试');
          const retry = { id, input, status: 'QUEUED', stage: 'queued', events: [],
            created_at: new Date().toISOString(), model: selected.model, max_tokens: maxTokens,budget_id:body.budget_id,budget_context,
            publication_approved: false, cancel_requested: false,
            revision: { kind: 'TECHNICAL_RETRY', parent_id: job.id, root_id: job.revision?.root_id || job.id,
              number: (job.revision?.number || 1) + 1, note: '技术失败后按当前模型配置完整重试；不继承原版本批准。',
              changes: [], parent_input_sha256: sha(job.input), input_sha256: sha(input),
              resolution: 'REVALIDATING', requested_max_tokens: maxTokens } };
          store.transaction(()=>{persist(retry);store.putRecord('execution_request',requestKey,{task_id:id});});jobs.set(id, retry);active = id; void execute(retry, selected);
          return json(res, 202, summary(retry));
        }
        if (req.method === 'POST' && match[2] === 'revisions') {
          const body = await parseBody(req);
          // Saving a local draft does not require permission to transmit; starting it does.
          const input = prepareInput({ ...body, consent: true });
          const revision = revisionAudit(job, input, body.revision_note);
          input.revision_context = { note: revision.note, parent_id: job.id };
          revision.input_sha256 = sha(input);
          const id = randomUUID(); mkdirSync(resolve(storage, id));
          const draft = { id, input, revision, status: 'DRAFT', stage: 'DRAFT', events: [],
            created_at: new Date().toISOString(), publication_approved: false, cancel_requested: false };
          jobs.set(id, draft); persist(draft); return json(res, 201, summary(draft));
        }
        if (req.method === 'POST' && match[2] === 'start') {
          if (job.status !== 'DRAFT') return json(res, 409, { error: '只有尚未执行的草稿可以开始；请创建新版本' });
          const body = await parseBody(req);
          if (body.consent !== true) throw Error('请明确允许向所配模型发送修订资料');
          if (!globalProvider || isBusy()) return json(res, 409, { error: '请连接模型，并等待当前任务结束' });
          if(job.requires_evidence_edit && sha(job.input.sources)===sha(store.getTask(job.revision.parent_id)?.input.sources))throw Error('此草稿仍缺补充资料，请先修改资料再构建');
          validateBuildInput(job.input);
          const budget_context={operation:'BUILD',task_id:job.id,question:null};
          budgets.authorize(body.budget_id,job.input,budget_context);
          job.budget_id=body.budget_id;job.budget_context=budget_context;
          job.status = 'QUEUED'; job.stage = 'queued'; job.model = globalProvider.model;
          job.revision.resolution = 'REVALIDATING'; persist(job); active = job.id;
          void execute(job, globalProvider); return json(res, 202, summary(job));
        }
        if (req.method === 'POST' && match[2] === 'sync') {
          if (['RUNNING', 'QUEUED', 'DRAFT'].includes(job.status)) return json(res, 409, { error: '版本尚未完成，不能入图' });
          return json(res, 200, await syncGraph(job));
        }
        if (req.method === 'POST' && match[2] === 'cancel') {
          if (!['RUNNING', 'QUEUED'].includes(job.status)) return json(res, 409, { error: '任务已经结束，无需停止' });
          job.cancel_requested = true;if(job.learning?.batch_id)learningBatches.stop(job.learning.batch_id);if(job.learning_resolution?.batch_id)learningBatches.stop(job.learning_resolution.batch_id);persist(job); return json(res, 200, { message: '将在当前模型调用结束后停止，不再发送新调用。' });
        }
        if (req.method === 'POST' && match[2] === 'query') {
          const body = await parseBody(req);
          const backend = body.backend ?? 'SQLITE';
          if(governance.candidateFor(job.id)&&backend!=='SQLITE')throw Error('来源管理版本仅支持受治理的本地查询，不能绕过来源撤回');
          if (backend === 'SQLITE') return json(res, 200, governance.query(job.id,job.result?.schema?.cq_plans.find(p=>p.cq_id===body.cq_id)));
          if (backend !== 'NEO4J') throw Error('查询后端只能是 SQLITE 或 NEO4J');
          if (!graph) throw Error('Neo4j 未连接；请连接并主动同步此版本，或选择 SQLite');
          return json(res, 200, { ...await graph.query(job, body.cq_id), task_id: job.id, version: job.id });
        }
      }
      if (serveWorkbenchAsset(req, res, pathname)) return;
      return json(res, 404, { error: '路径不存在' });
    } catch (error) { return json(res, error.status|| (error.code?.startsWith('BUDGET_') ? 428 : 400), { error: error.message, code:error.code || null }); }
  });
  // The desktop Rust bridge is synchronous. A long bridge call can delay idle
  // socket timers; close each main-product response rather than advertising a
  // reusable connection that may be reset when the event loop resumes.
  if(sourceFirstOptions?.mainProduct===true)server.maxRequestsPerSocket=1;
  server.once('listening',()=>scheduleRecovery());
  server.on('close', () => {
    recoveryClosed=true;
    void (async()=>{
      await memoryServerIntegration?.close({drain:true});
      productRuntime?.close();sourceProduct?.close();
      await Promise.allSettled([graph?.close(),nativeBuildHost?.close(),nativeQueryProduct?.close()]);
      store.close();
    })().catch(error=>{console.error('工作台关闭未完成：'+(/^[A-Z0-9_]{1,96}$/.test(error?.code??'')?error.code:'MEMORY_CLOSE_FAILED'));});
  });
  return { server, jobs, store, instance, control, sourceProduct, productRuntime, nativeBuildHost,nativeQueryProduct,memoryServerIntegration, hasActiveOperations: isBusy };
}

export async function startWorkbench({sourceFirstOptions=null}={}) {
  if (!supportedNode()) throw Error('请安装 Node 22.22+ 或 24.15+：https://nodejs.org/en/download');
  const args = process.argv.slice(2), config = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--allow-insecure-http') config.allowInsecureHttp = true;
    else if (args[i] === '--configure-only') config.configureOnly = true;
    else if (['--base-url', '--model', '--port', '--max-tokens'].includes(args[i]) && args[i + 1]) config[args[i++].slice(2)] = args[i];
    else throw Error('无效启动参数');
  }
  const port = Number(config.port || process.env.CQFORGE_PORT || 4317); if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('端口无效');
  let provider = config.model && !config.configureOnly ? createProvider({ timeoutMs:600000,baseUrl: config['base-url'], model: config.model,
    apiKey: await readCredential(), allowInsecureHttp: config.allowInsecureHttp, maxTokens: Number(config['max-tokens'] || 8000) }) : null;
  const storage = resolve(process.env.CQFORGE_STORAGE || resolve(root, 'local-runs/workbench'));
  if (process.env.CQFORGE_API_KEY) {
    if (!process.env.CQFORGE_MODEL_URL || !process.env.CQFORGE_MODEL_NAME) throw Error('环境变量密钥必须同时显式提供 CQFORGE_MODEL_URL 和 CQFORGE_MODEL_NAME；不混用历史配置');
    config['base-url'] = process.env.CQFORGE_MODEL_URL; config.model = process.env.CQFORGE_MODEL_NAME;
    config.allowInsecureHttp = process.env.CQFORGE_ALLOW_INSECURE_HTTP === '1';
    provider = createProvider({ timeoutMs:600000,baseUrl: config['base-url'], model: config.model, apiKey: process.env.CQFORGE_API_KEY,
      allowInsecureHttp: config.allowInsecureHttp, maxTokens: Number(config['max-tokens'] || 8000) });
  }
  // Refuse a second foreground/background instance before migration can touch runtime state.
  const { createConnection } = await import('node:net');
  const occupied = await new Promise(done => { const probe = createConnection({ host: '127.0.0.1', port }); probe.once('connect', () => { probe.destroy(); done(true); }); probe.once('error', () => done(false)); });
  if (occupied) throw Error('端口 ' + port + ' 已占用；请检查 npm run status 或 CQFORGE_PORT，不会自动停止占用进程');
  mkdirSync(storage, { recursive: true });
  const lock = resolve(storage, 'runtime.lock');
  if (existsSync(lock)) {
    const owner = JSON.parse(readFileSync(lock));
    let alive = false; try { process.kill(owner.pid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') alive = true; }
    if (alive) throw Error('此工作空间已有进程锁；不会因更换端口启动第二个写入者');
    renameSync(lock, lock + '.stale-' + randomUUID());
  }
  const instance = randomUUID(); writeFileSync(lock, JSON.stringify({ pid: process.pid, instance }), { flag: 'wx', mode: 0o600 });
  process.on('exit', () => { try { if (JSON.parse(readFileSync(lock)).instance === instance) unlinkSync(lock); } catch { /* Never remove another process lock. */ } });
  const app = createWorkbench({ provider, storage, profile: { baseUrl: config['base-url'], model: config.model,
    maxTokens: config['max-tokens'] ? Number(config['max-tokens']) : undefined, allowInsecureHttp: config.allowInsecureHttp }, acceptance:process.env.CQFORGE_ACCEPTANCE==='1',port, instance,sourceFirstOptions });
  const { server } = app;
  server.listen(port, '127.0.0.1', () => {
    writeFileSync(resolve(storage, 'server.json'), JSON.stringify({ pid: process.pid, instance: app.instance, control: app.control, port, storage, started_at: new Date().toISOString() }), { mode: 0o600 });
    console.log('OntoWeave: http://127.0.0.1:' + port + ' · SQLite · parser=' + parserHealth().status);
    console.log('只监听本机；重启电脑后需要重新启动。密钥不落盘，模型未连接时请在界面输入。');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (app.hasActiveOperations()) { void app.memoryServerIntegration?.close({drain:false});console.log('未完成任务将保留；已经开始或结果未知的请求不会自动重发。'); process.exit(0); }
    server.close();
  });
  server.on('error', error => { console.error('工作台启动失败：' + error.code + '；未停止任何其他进程'); app.store.close(); process.exitCode = 1; });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await startWorkbench();
