/** Opt-in integration test against a real local Neo4j; generation is explicitly MOCK.
 * Creates only CQFNode-labelled synthetic data in a unique workspace. Never deletes database data.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import neo4j from 'neo4j-driver';
import { readCredential } from '../experiments/model-loop/credential.mjs';
import { body, schema, claims, mockProvider, rawClaim } from '../fixtures/workbench/synthetic.mjs';
import { createWorkbench } from './server.mjs';
import { validateInput, validateClaims, answerCQ } from './engine.mjs';
import { projection } from './graph.mjs';
import { randomUUID } from 'node:crypto';

const password = await readCredential({ envName: 'CQFORGE_NEO4J_PASSWORD', prompt: 'Neo4j password' });
const uri = process.env.CQFORGE_NEO4J_URI || 'bolt://127.0.0.1:7687';
const database = process.env.CQFORGE_NEO4J_DATABASE || 'neo4j';
const username = process.env.CQFORGE_NEO4J_USER || 'neo4j';
const parentDir = resolve('local-runs'); mkdirSync(parentDir, { recursive: true });
const storage = mkdtempSync(resolve(parentDir, 'neo4j-smoke-'));
let model = mockProvider(), generationCalls = 0;
const provider = { model: model.model, async complete(...args) {
  if (model.calls === 5) model = mockProvider(); generationCalls++; return model.complete(...args);
} };
let app, origin, token;
const report = { mode: 'REAL_NEO4J_WITH_OFFLINE_MOCK_MODEL', storage, checks: [] };
const check = (name, value) => { assert(value, name); report.checks.push(name); console.log('PASS ' + name); };
async function request(path, data) {
  if (path.endsWith('/query')) data = { backend: 'NEO4J', ...data };
  if(data?.consent===true&&!data.budget_id&&(path==='/api/tasks'||path.endsWith('/start'))) {
    const match=path.match(/^\/api\/tasks\/([^/]+)\/start$/);
    const preview=await request('/api/budgets/preview',match?{task_id:match[1],operation:'BUILD'}:{input:data,operation:'BUILD'});
    const budget=await request('/api/budgets',{preview_id:preview.preview_id,max_calls:20,auto_repair:false,consent:true});
    data={...data,budget_id:budget.id};
  }
  const response = await fetch(origin + path, data === undefined ? {} : { method: 'POST', headers: {
    Origin: origin, 'X-CQForge-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json(); assert(response.ok, result.error || path); return result;
}
async function launch() {
  app = createWorkbench({ storage, provider });
  await new Promise((yes, no) => { app.server.once('error', no); app.server.listen(0, '127.0.0.1', yes); });
  origin = 'http://127.0.0.1:' + app.server.address().port;
  token = (await request('/api/bootstrap')).token;
  await request('/api/graph/connect', { uri, database, username, password });
}
async function finished(id) {
  for (let i = 0; i < 200; i++) {
    const task = await request('/api/tasks/' + id);
    if (!['RUNNING', 'QUEUED'].includes(task.status)) return task;
    await new Promise(r => setTimeout(r, 50));
  }
  throw Error('Integration task did not finish');
}
const driver = neo4j.driver(uri, neo4j.auth.basic(username, password), { disableLosslessIntegers: true });
const count = async workspace => (await driver.executeQuery('MATCH (n:CQFNode) WHERE n.key STARTS WITH $prefix RETURN count(n) AS count',
  { prefix: workspace + ':' }, { database })).records[0].get('count');
try {
  await launch();
  const workspace = (await request('/api/bootstrap')).graph.workspace;
  const created = await request('/api/tasks', body()), root = await finished(created.id);
  check('connection does not auto-sync new versions', root.graph_sync === undefined);
  root.graph_sync = await request('/api/tasks/' + root.id + '/sync', {});
  check('synthetic five-call build and real graph import', root.status === 'READY' && root.graph_sync.status === 'SYNCED' && generationCalls === 5);
  const n = await count(workspace);
  await request('/api/tasks/' + root.id + '/sync', {});
  check('repeat import preserves node count', n === await count(workspace));
  for (const q of root.input.cqs) {
    const answer = await request('/api/tasks/' + root.id + '/query', { cq_id: q.id });
    const sqlite = await request('/api/tasks/' + root.id + '/query', { cq_id: q.id, backend: 'SQLITE' });
    const { backend: sqlBackend, ...sqlAnswer } = sqlite;
    const { backend: neoBackend, template, version_key, ...neoAnswer } = answer;
    assert.deepEqual(sqlAnswer, neoAnswer);
    check('SQLite / Neo4j parity ' + q.id, sqlBackend === 'SQLITE' && neoBackend === 'NEO4J');
    assert.deepEqual(answer.claims, answerCQ(root.result, root.input, q.id).claims);
    check('real Cypher ' + root.result.schema.cq_plans.find(p => p.cq_id === q.id).template, answer.backend === 'NEO4J');
    check('evidence offsets ' + q.id, answer.claims.every(c => root.input.sources[0].content.slice(c.start, c.end) === c.quote));
  }
  const original = JSON.stringify(app.store.getTask(root.id));
  const changed = { ...body(), definitions: body().definitions + '本次补充范围限制。', revision_note: '补充范围限制' };
  const draft = await request('/api/tasks/' + root.id + '/revisions', changed);
  check('draft saves without generation', draft.status === 'DRAFT' && generationCalls === 5);
  await new Promise(r => app.server.close(r)); await launch();
  check('draft persists through restart', (await request('/api/tasks/' + draft.id)).status === 'DRAFT');
  await request('/api/tasks/' + draft.id + '/start', { consent: true });
  const revised = await finished(draft.id);
  await request('/api/tasks/' + revised.id + '/sync', {});
  check('full revalidation produces lineage-linked version', revised.status === 'READY' && revised.revision.parent_id === root.id && generationCalls === 10);
  check('parent record stays unchanged', JSON.stringify(app.store.getTask(root.id)) === original);
  check('version diff includes changed definitions', (await request('/api/tasks/' + revised.id + '/diff')).inputs.some(c => c.field === 'definitions'));
  const held = structuredClone(root); held.id = randomUUID(); held.status = held.result.status = 'REVIEW_REQUIRED';
  held.result.gate = { action: 'REQUEST_REVISION', issues: [{ code: 'SYNTHETIC_REVIEW_HOLD' }] }; delete held.graph_sync;
  const lateParent = structuredClone(root); lateParent.id = randomUUID(); delete lateParent.graph_sync;
  const lateChild = structuredClone(revised); lateChild.id = randomUUID(); delete lateChild.graph_sync;
  lateChild.revision.parent_id = lateParent.id;
  const conflict = structuredClone(root); conflict.id = randomUUID();
  conflict.input.sources[0].content = '2026年1月甲的唯一主要服务地区为欧洲。2026年1月甲的唯一主要服务地区为亚洲。';
  const validated = validateInput({ ...body(), sources: conflict.input.sources }); conflict.input = validated;
  conflict.result.schema.predicates[0].cardinality = 'ONE';
  conflict.result.claims = validateClaims({ claims: [rawClaim('a', '欧洲', '2026年1月甲的唯一主要服务地区为欧洲。', { effective_from: '2026-01-01' }),
    rawClaim('a', '亚洲', '2026年1月甲的唯一主要服务地区为亚洲。', { effective_from: '2026-01-01' })] }, conflict.result.schema, validated).claims;
  delete conflict.graph_sync;
  // Persist explicit synthetic test cases, then let the production HTTP path import and query them after restart.
  for (const task of [held, conflict, lateParent, lateChild]) app.store.saveTask(task);
  await new Promise(r => app.server.close(r)); await launch();
  await request('/api/tasks/' + lateChild.id + '/sync', {});
  const placeholder = await driver.executeQuery('MATCH (v:CQFVersion {key:$key}) RETURN v.status AS status',
    { key: workspace + ':' + lateParent.id }, { database });
  check('child-first import creates non-queryable parent placeholder', placeholder.records[0].get('status') === 'NOT_IMPORTED');
  await request('/api/tasks/' + lateParent.id + '/sync', {});
  check('later parent import upgrades placeholder without losing lineage', (await request('/api/tasks/' + lateParent.id + '/query', { cq_id: 'CQ-01' })).claims.length === 2);
  await request('/api/tasks/' + held.id + '/sync', {});
  check('review-required graph remains unqueryable', (await request('/api/tasks/' + held.id + '/query', { cq_id: 'CQ-01' })).classification === 'UNKNOWN');
  await request('/api/tasks/' + conflict.id + '/sync', {});
  const answer = await request('/api/tasks/' + conflict.id + '/query', { cq_id: 'CQ-01' });
  check('contradictory claims are retained, never overwritten', answer.classification === 'CONFLICT' && answer.claims.length === 2);
  check('old version answers survive later imports', (await request('/api/tasks/' + root.id + '/query', { cq_id: 'CQ-01' })).claims.length === 2);
  await new Promise(r => app.server.close(r)); await launch();
  check('query works after server restart and reconnect', (await request('/api/tasks/' + revised.id + '/query', { cq_id: 'CQ-03' })).backend === 'NEO4J');
  const versionKey = projection(revised, workspace).version;
  const lineage = await driver.executeQuery('MATCH (:CQFVersion {key:$child})-[:REVISES]->(:CQFVersion {key:$parent}) RETURN count(*) AS count',
    { child: versionKey, parent: projection(root, workspace).version }, { database });
  check('parent-child relationship exists in real graph', lineage.records[0].get('count') === 1);
  report.generation_calls = generationCalls; report.workspace = workspace; report.status = 'PASS';
  writeFileSync(resolve(storage, 'report.json'), JSON.stringify(report, null, 2));
  console.log('Integration report: ' + resolve(storage, 'report.json'));
} finally {
  if (app?.server.listening) await new Promise(r => app.server.close(r));
  await driver.close();
}
