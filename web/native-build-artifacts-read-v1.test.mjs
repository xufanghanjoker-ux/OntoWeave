import test from 'node:test';
import assert from 'node:assert/strict';
import {hash} from './cq-discovery-store-v2.mjs';
import {readNativeBuildArtifacts} from './native-build-artifacts-read-v1.mjs';
import {createNativeFullChainHttp} from './native-full-chain-http-v1.mjs';
import {createNativeFullChainProduct} from './native-full-chain-product-v1.mjs';

const libraryId = 'kb_00000000-0000-4000-8000-000000000001';
const runId = 'nrun_' + '1'.repeat(32), originRun = 'nrun_' + '2'.repeat(32);
const seal = value => ({...value, record_sha256: hash(value)});

function fixture({reuse = false, planSaved = true, manifest = false} = {}) {
  const rows = new Map(), effects = {writes: 0, transactions: 0, catalogReads: 0, currentSources: 0, controllers: 0, models: 0};
  const set = (kind, id, value) => rows.set(JSON.stringify([kind, id]), structuredClone(value));
  const get = (kind, id) => structuredClone(rows.get(JSON.stringify([kind, id])) ?? null);
  const mutate = () => {effects.writes++;throw Error('ARTIFACT_READ_MUST_NOT_WRITE');};
  const store = {getRecord: get, listRecords: kind => [...rows].filter(([k]) => JSON.parse(k)[0] === kind).map(([, v]) => structuredClone(v)), putRecord: mutate, archiveRecord: mutate, saveTask: mutate, transaction(fn) {effects.transactions++;return fn();}};
  const documents = ['a', 'b'].map((name, index) => ({doc_id: 'doc_' + name, revision: 'revision_' + name, title: 'Frozen ' + name, content: '# ' + name + '\n' + name + ' body', format: 'docx', parse_status: 'READABLE', parser: {name: 'docling', version: 'authored/1', document_id: 'document_' + name, private_path: 'DO_NOT_EXPOSE_PRIVATE_PATH'}, warnings: ['PARSER_NOTICE'], blocks: [{block_id: '#/texts/0', kind: 'heading', start: 0, end: 3, provenance: [{page_no: index + 1, bbox: {l: 1, t: 2, r: 3, b: 4, coord_origin: 'TOPLEFT', wire: 'DO_NOT_EXPOSE_BBOX'}, wire: 'DO_NOT_EXPOSE_PROVENANCE'}]}, {block_id: '#/texts/1', kind: 'paragraph', start: 4, end: 10, provenance: []}]}));
  const sourceBody = {library_id: libraryId, source_epoch: 0, documents};
  const fingerprint = hash(sourceBody), snapshotId = 'snapshot_' + fingerprint, source = {snapshot_id: snapshotId, fingerprint, ...sourceBody};
  set('cq_v2_snapshot', snapshotId, source);
  const input = {library_ref: libraryId, source_snapshot_ref: snapshotId, source_fingerprint: fingerprint};
  const row = {run_id: runId, library_id: libraryId, snapshot_id: snapshotId, source_epoch: 0, status: 'PARTIALLY_READY'};
  const state = {run_id: runId, library_id: libraryId, snapshot_id: snapshotId, input};
  if (reuse) {
    Object.assign(row, {reuse_cq_family_from_run_id: originRun, reuse_semantic_from_run_id: 'nrun_' + '3'.repeat(32), reuse_organization_draft_from_run_id: 'nrun_' + '4'.repeat(32), execution_mode: 'REUSE_CONFIRMED_ORGANIZATION_DRAFTS'});
    state.upstream_origin = {run_id: originRun, cq_origin_run_id: originRun, mode: 'EXPLICITLY_IMPORTED_CONFIRMED_OUTPUTS'};
    set('native_product_run_v1', originRun, {run_id: originRun, library_id: libraryId, snapshot_id: snapshotId, source_epoch: 0, status: 'SUCCEEDED'});
    set('native_full_chain_state_v1', originRun, {run_id: originRun, library_id: libraryId, snapshot_id: snapshotId, input});
  }
  const chunk = (doc, ordinal) => ({chunk_ref: 'chunk_' + doc.doc_id + '_' + ordinal, doc_ref: doc.doc_id, revision: doc.revision, title: doc.title, ordinal, text: 'Source body ' + ordinal, contextualized_text: '# Context\nSource body ' + ordinal, headings: ['# Context'], token_count: 8, token_budget: 8000, tokenizer: 'cl100k_base', token_count_exact: true, source_block_refs: ['#/texts/1'], source_items: [{self_ref: '#/texts/1', label: 'text', parent_refs: ['#/body'], role: 'CORE', provenance: [], internal: 'DO_NOT_EXPOSE_SOURCE_ITEM'}], status: 'PLANNED', warnings: [], raw_response: 'DO_NOT_EXPOSE_RAW'});
  const chunks = [chunk(documents[0], 0), chunk(documents[0], 1), chunk(documents[1], 0)];
  const windows = documents.map((d, ordinal) => ({window_ref: 'window_' + d.doc_id, doc_ref: d.doc_id, revision: d.revision, ordinal, text: chunks.filter(c => c.doc_ref === d.doc_id).map(c => c.contextualized_text).join('\n\n'), contextualized_text: chunks.filter(c => c.doc_ref === d.doc_id).map(c => c.contextualized_text).join('\n\n'), source_chunk_refs: chunks.filter(c => c.doc_ref === d.doc_id).map(c => c.chunk_ref), source_block_refs: ['#/texts/1'], token_count: ordinal ? 8 : 16, token_budget: 8000, tokenizer: 'cl100k_base', warnings: []}));
  const planBody = {plan_ref: 'plan_authored', source_snapshot_ref: snapshotId, source_fingerprint: fingerprint, policy: {engine: 'DoclingHybridChunker', tokenizer: 'cl100k_base', max_tokens: 8000, token_count_exact: true, hidden: 'DO_NOT_EXPOSE_POLICY'}, chunks, windows, summary: {documents: 2, chunks: 3, windows: 2, source_blocks: 4, represented_blocks: 2, hidden: 'DO_NOT_EXPOSE_SUMMARY'}, warnings: []};
  const plan = {...planBody, plan_sha256: hash(planBody)};
  state.chunk_plan_summary = {plan_ref: plan.plan_ref};
  set('native_product_run_v1', runId, row);
  set('native_full_chain_state_v1', runId, state);
  if (planSaved) set('native_chunked_cq_plan_v1', reuse ? originRun : runId, seal({run_id: reuse ? originRun : runId, source_snapshot_ref: snapshotId, plan}));
  if (manifest) {
    const windowManifest = {source_snapshot_ref: snapshotId, source_fingerprint: fingerprint, hybrid_plan_ref: plan.plan_ref, hybrid_plan_sha256: plan.plan_sha256, windows: windows.map(w => ({...w, source_snapshot_ref: snapshotId, internal: 'DO_NOT_EXPOSE_WINDOW'}))};
    const manifestHash = hash(windowManifest), binding = 'queue_authored', manifestRef = 'manifest_authored';
    set('native_extraction_window_queue_v1', runId, {run_id: runId, binding, manifest_ref: manifestRef, manifest_sha256: manifestHash});
    set('native_extraction_window_manifest_v1', manifestRef, seal({run_id: runId, queue_binding: binding, manifest_sha256: manifestHash, manifest: windowManifest}));
  }
  const catalog = {get(id, lib) {effects.catalogReads++;assert.equal(id, snapshotId);assert.equal(lib, libraryId);return get('cq_v2_snapshot', id);}, isCurrent() {throw Error('MUST_NOT_READ_CURRENT_SOURCES');}};
  const read = (kind, options = {}) => readNativeBuildArtifacts({store, catalog, libraryId, runId, kind, ...options});
  return {rows, store, effects, set, get, read, source, plan, snapshotId, catalog};
}

test('retained chunks paginate exact bodies with a whitelist and zero writes or transactions', () => {
  const f = fixture(), before = hash([...f.rows]);
  const first = f.read('chunks', {limit: 2}), second = f.read('chunks', {after: first.next_after, limit: 2});
  assert.equal(first.available, true);assert.equal(first.read_only, true);assert.equal(first.has_more, true);assert.equal(first.next_after, 2);
  assert.equal(second.has_more, false);assert.equal(second.next_after, null);
  assert.deepEqual([...first.items, ...second.items].map(i => i.ref), f.plan.chunks.map(c => c.chunk_ref));
  assert.equal(first.items[0].contextualized_text, f.plan.chunks[0].contextualized_text);
  assert.equal(first.items[0].source_snapshot_ref, f.snapshotId);assert.equal(first.summary.total_items, 3);
  assert.doesNotMatch(JSON.stringify([first, second]), /DO_NOT_EXPOSE/);
  first.items[0].text = 'client edit';assert.equal(f.read('chunks').items[0].text, f.plan.chunks[0].text);
  assert.equal(hash([...f.rows]), before);assert.equal(f.effects.writes, 0);assert.equal(f.effects.transactions, 0);
});

test('actual organization-draft reuse shape follows its declared CQ ancestor and saved extraction manifest', () => {
  const f = fixture({reuse: true, manifest: true});
  const chunks = f.read('chunks'), windows = f.read('windows', {docRef: 'doc_a'});
  assert.equal(chunks.origin_run_id, originRun);assert.equal(chunks.items.length, 3);
  assert.equal(windows.artifact_origin, 'SAVED_EXTRACTION_MANIFEST');assert.equal(windows.items[0].window_ref, 'window_doc_a');
  assert.deepEqual(windows.items[0].source_chunk_refs, ['chunk_doc_a_0', 'chunk_doc_a_1']);
  assert.deepEqual(windows.items[0].headings, ['# Context']);assert.equal(windows.source_snapshot_ref, f.snapshotId);
  assert.doesNotMatch(JSON.stringify(windows), /DO_NOT_EXPOSE/);
  assert.equal(f.effects.writes, 0);assert.equal(f.effects.transactions, 0);
});

test('documents and blocks come from the frozen snapshot, with document selection and unambiguous references', () => {
  const f = fixture();
  const doc = f.read('documents', {ref: 'doc_a'}).items[0];
  assert.equal(doc.text, f.source.documents[0].content);assert.equal(doc.document_id, 'document_a');assert.equal(doc.block_count, 2);
  const blocks = f.read('blocks', {docRef: 'doc_b', limit: 1});
  assert.equal(blocks.items[0].text, '# b');assert.equal(blocks.items[0].provenance[0].page_no, 2);
  assert.equal(blocks.next_after, 1);assert.equal(f.read('blocks', {docRef: 'doc_b', after: 1}).items[0].text, 'b body');
  assert.equal(f.read('blocks', {docRef: 'doc_b', ref: '#/texts/0'}).items.length, 1);
  assert.equal(f.read('blocks', {ref: blocks.items[0].ref}).items.length, 1);
  assert.throws(() => f.read('blocks', {ref: '#/texts/0'}), {code: 'NATIVE_ARTIFACT_REF_AMBIGUOUS'});
  assert.throws(() => f.read('blocks', {docRef: 'foreign_doc'}), {code: 'NATIVE_ARTIFACT_DOCUMENT_NOT_FOUND'});
  assert.doesNotMatch(JSON.stringify([doc, blocks]), /DO_NOT_EXPOSE/);
  assert.equal(f.effects.writes, 0);assert.equal(f.effects.transactions, 0);
});

test('missing saved plans, references and snapshots return unavailable without creating replacements', () => {
  const f = fixture({reuse: true, planSaved: false}), before = hash([...f.rows]);
  assert.equal(f.read('chunks').available, false);assert.equal(f.read('windows').reason, 'NATIVE_ARTIFACT_NOT_SAVED');
  f.rows.delete(JSON.stringify(['native_product_run_v1', originRun]));
  assert.equal(f.read('chunks').reason, 'NATIVE_ARTIFACT_LINEAGE_NOT_SAVED');
  assert.equal(f.read('documents', {ref: 'absent'}).reason, 'NATIVE_ARTIFACT_REF_NOT_FOUND');
  f.rows.delete(JSON.stringify(['cq_v2_snapshot', f.snapshotId]));
  assert.equal(f.read('documents').reason, 'NATIVE_ARTIFACT_SNAPSHOT_NOT_SAVED');
  assert.equal(f.effects.writes, 0);assert.equal(f.effects.transactions, 0);
  assert.equal(f.store.listRecords('native_chunked_cq_plan_v1').length, 0);
  assert.notEqual(hash([...f.rows]), before); // Only the fixture deliberately removed the snapshot.
});

test('page bounds, run/library/snapshot bindings, plan hashes and reuse edges fail closed', () => {
  const f = fixture();
  for (const options of [{after: -1}, {after: 4}, {limit: 0}, {limit: 101}, {after: 1.2}]) assert.throws(() => f.read('chunks', options), {code: 'NATIVE_ARTIFACT_PAGE_INVALID'});
  assert.throws(() => f.read('invalid'), {code: 'NATIVE_ARTIFACT_KIND_INVALID'});
  assert.throws(() => readNativeBuildArtifacts({store: f.store, catalog: f.catalog, libraryId: 'foreign', runId, kind: 'chunks'}), {code: 'NATIVE_RUN_NOT_FOUND'});
  const changed = fixture();changed.set('native_full_chain_state_v1', runId, {...changed.get('native_full_chain_state_v1', runId), snapshot_id: 'other'});
  assert.throws(() => changed.read('documents'), {code: 'NATIVE_ARTIFACT_RUN_BINDING_CHANGED'});
  const badSource = fixture();badSource.set('cq_v2_snapshot', badSource.snapshotId, {...badSource.source, fingerprint: 'changed'});
  assert.throws(() => badSource.read('documents'), {code: 'NATIVE_ARTIFACT_SNAPSHOT_BINDING_CHANGED'});
  const badPlan = fixture();const saved = badPlan.get('native_chunked_cq_plan_v1', runId);saved.plan.chunks[0].text = 'changed';badPlan.set('native_chunked_cq_plan_v1', runId, saved);
  assert.throws(() => badPlan.read('chunks'), {code: 'NATIVE_ARTIFACT_PLAN_BINDING_CHANGED'});
  const badReuse = fixture({reuse: true});badReuse.set('native_product_run_v1', runId, {...badReuse.get('native_product_run_v1', runId), reuse_cq_family_from_run_id: 'unrelated'});
  assert.throws(() => badReuse.read('chunks'), {code: 'NATIVE_ARTIFACT_LINEAGE_BINDING_CHANGED'});
  const badAncestor = fixture({reuse: true});badAncestor.set('native_product_run_v1', originRun, {...badAncestor.get('native_product_run_v1', originRun), library_id: 'foreign'});
  assert.throws(() => badAncestor.read('chunks'), {code: 'NATIVE_RUN_NOT_FOUND'});
  for (const item of [f, changed, badSource, badPlan, badReuse, badAncestor]) {assert.equal(item.effects.writes, 0);assert.equal(item.effects.transactions, 0);}
});

test('product artifacts endpoint avoids controllers, configuration, current sources and every mutation method', async () => {
  const f = fixture({reuse: true, manifest: true});
  const host = createNativeFullChainProduct({store: f.store, governance: {baseFor: id => id === libraryId ? {source_epoch: 99} : null}, runtime: {sources() {f.effects.currentSources++;throw Error('NO_CURRENT_SOURCES');}}, product: {nativeModelRuntime() {f.effects.models++;throw Error('NO_MODELS');}}, runtimeDirectory: '/unused-artifacts-fixture', chainFactory() {f.effects.controllers++;throw Error('NO_CONTROLLER');}});
  // Product initialization has an existing restart audit transaction; the read path must add none.
  f.effects.transactions = 0;
  const before = hash([...f.rows]), bodies = [];
  const handle = createNativeFullChainHttp({host, json: (_res, status, body) => bodies.push({status, body}), parseBody: async () => {throw Error('NO_BODY');}});
  const path = '/api/product/libraries/' + libraryId + '/native-full-chain/runs/' + runId + '/artifacts';
  for (const kind of ['chunks', 'windows', 'documents', 'blocks']) {
    assert.equal(await handle({req: {method: 'GET', url: path + '?kind=' + kind + '&after=0&limit=1'}, res: {}, pathname: path}), true);
    assert.equal(bodies.at(-1).status, 200);assert.equal(bodies.at(-1).body.available, true);
  }
  assert.equal(hash([...f.rows]), before);
  assert.deepEqual({...f.effects, catalogReads: 0}, {writes: 0, transactions: 0, catalogReads: 0, currentSources: 0, controllers: 0, models: 0});
});

test('even rehashed plans and manifests cannot point at foreign revisions, documents or snapshot inputs', () => {
  const revisePlan = (f, change) => {const record = f.get('native_chunked_cq_plan_v1', runId);change(record.plan);const {plan_sha256, ...body} = record.plan;record.plan = {...body, plan_sha256: hash(body)};delete record.record_sha256;f.set('native_chunked_cq_plan_v1', runId, seal(record));};
  const revision = fixture();revisePlan(revision, p => {p.chunks[0].revision = 'foreign_revision';});
  assert.throws(() => revision.read('chunks'), {code: 'NATIVE_ARTIFACT_PLAN_BINDING_CHANGED'});
  const crossDoc = fixture();revisePlan(crossDoc, p => {p.windows[0].source_chunk_refs = [p.chunks[2].chunk_ref];});
  assert.throws(() => crossDoc.read('windows'), {code: 'NATIVE_ARTIFACT_PLAN_BINDING_CHANGED'});
  const input = fixture();const state = input.get('native_full_chain_state_v1', runId);state.input.source_snapshot_ref = 'foreign_snapshot';input.set('native_full_chain_state_v1', runId, state);
  assert.throws(() => input.read('documents'), {code: 'NATIVE_ARTIFACT_RUN_BINDING_CHANGED'});
  const manifest = fixture({manifest: true});const queue = manifest.get('native_extraction_window_queue_v1', runId), saved = manifest.get('native_extraction_window_manifest_v1', queue.manifest_ref);
  saved.manifest.windows[0].text = 'changed outside frozen plan';saved.manifest_sha256 = hash(saved.manifest);queue.manifest_sha256 = saved.manifest_sha256;
  delete saved.record_sha256;manifest.set('native_extraction_window_queue_v1', runId, queue);manifest.set('native_extraction_window_manifest_v1', queue.manifest_ref, seal(saved));
  assert.throws(() => manifest.read('windows'), {code: 'NATIVE_ARTIFACT_WINDOW_BINDING_CHANGED'});
  for (const f of [revision, crossDoc, input, manifest]) {assert.equal(f.effects.writes, 0);assert.equal(f.effects.transactions, 0);}
});

test('HTTP validates kind, selection, unique parameters and capped integer pagination before dispatch', async () => {
  const calls = [];
  const handle = createNativeFullChainHttp({host: {artifacts: args => {calls.push(args);return args;}}, json: () => {}, parseBody: async () => {throw Error('NO_BODY');}});
  const path = '/api/product/libraries/' + libraryId + '/native-full-chain/runs/' + runId + '/artifacts';
  const invoke = query => handle({req: {method: 'GET', url: path + query}, res: {}, pathname: path});
  await invoke('?kind=blocks&doc_ref=doc_a&ref=%23%2Ftexts%2F0');
  assert.deepEqual(calls[0], {libraryId, runId, kind: 'blocks', after: 0, limit: 40, docRef: 'doc_a', ref: '#/texts/0'});
  for (const [query, code] of [['?kind=other', 'NATIVE_ARTIFACT_KIND_INVALID'], ['?kind=chunks&limit=101', 'NATIVE_ARTIFACT_PAGE_INVALID'], ['?kind=chunks&after=-1', 'NATIVE_ARTIFACT_PAGE_INVALID'], ['?kind=chunks&after=1.2', 'NATIVE_ARTIFACT_PAGE_INVALID'], ['?kind=chunks&after=9007199254740992', 'NATIVE_ARTIFACT_PAGE_INVALID'], ['?kind=chunks&kind=windows', 'NATIVE_HTTP_ARGUMENTS_INVALID'], ['?kind=chunks&unknown=x', 'NATIVE_HTTP_ARGUMENTS_INVALID'], ['?kind=chunks&ref=', 'NATIVE_ARTIFACT_SELECTION_INVALID']]) await assert.rejects(invoke(query), {code});
  assert.equal(calls.length, 1);
  await assert.rejects(handle({req: {method: 'POST', url: path}, res: {}, pathname: path}), {code: 'NATIVE_METHOD_NOT_ALLOWED'});
});

test('v2 saved artifact projection keeps frozen unit mapping and range policy with zero side effects',()=>{
 const f=fixture(),plan=structuredClone(f.plan);plan.policy.range_contract='CQ_UNIT_RANGES_V1';
 plan.windows[0].manifest_ref='manifest';plan.windows[0].units=[{label:'U001',ordinal:0,unit_ref:'frozen-unit',text:'原文',context:'标题与单位',block_id:'#/texts/1',fragment:'part-1',text_sha256:'a'.repeat(64),source_items:[],private_field:'DO_NOT_EXPOSE_UNIT_INTERNAL'}];
 const {plan_sha256,...body}=plan;plan.plan_sha256=hash(body);f.set('native_chunked_cq_plan_v1',runId,seal({run_id:runId,source_snapshot_ref:f.snapshotId,plan}));
 const result=f.read('windows');assert.equal(result.policy.range_contract,'CQ_UNIT_RANGES_V1');assert.equal(result.items[0].manifest_ref,'manifest');assert.equal(result.items[0].units[0].unit_ref,'frozen-unit');assert.equal(result.items[0].units[0].context,'标题与单位');assert(!JSON.stringify(result).includes('DO_NOT_EXPOSE_UNIT_INTERNAL'));assert.equal(f.effects.writes,0);
});
