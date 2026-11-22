import { lightogReviewSideMarkup } from './lightog-correction-view-v1.mjs';
import { applyGraphDelta, identityReviewSummary, identityReviewUnavailable, confirmedManifest, createPgApi, matchingGraph, receiptState, ref, reviewActionSpecs, reviewDomain, shouldEnterFirstGraph } from './ontoweave-pg-api-v1.mjs';

const pages = { graph: '图谱', documents: '资料', ontology: '本体', reviews: '待处理', answers: '问答',
  progress: '整理进度', review: '处理事项', knowledge: '知识详情', source: '原文', change: '本次变化' };
const stages = { RECEPTION: '接收与读取资料', UNDERSTANDING: '理解资料', EXTRACTION: '整理知识',
  FACT_ROUTING: '对齐与分流', PUBLICATION: '发布图谱' };
const stageAliases = { RECEIVE: 'RECEPTION', PARSING: 'RECEPTION',
  UNDERSTAND: 'UNDERSTANDING', CHUNKING: 'UNDERSTANDING', BLOCK_CQ: 'UNDERSTANDING', CQ_SIMILARITY: 'UNDERSTANDING',
  ORGANIZE: 'EXTRACTION', IDENTITY: 'FACT_ROUTING', ONTOLOGY: 'FACT_ROUTING',
  IDENTITY_ONTOLOGY: 'FACT_ROUTING', ALIGN_ROUTE: 'FACT_ROUTING', PUBLISH: 'PUBLICATION' };
const stageLabels = { RECEPTION: '接收文件', PARSING: '读取文档', CHUNKING: '划分内容单元',
  BLOCK_CQ: '梳理内容重点', CQ_SIMILARITY: '归并相近内容', IDENTITY: '识别实体', ONTOLOGY: '对齐本体',
  IDENTITY_ONTOLOGY: '身份与本体', FACT_ROUTING: '区分事实及待确认事项' };
const statuses = { PENDING: '待执行', NOT_STARTED: '待执行', QUEUED: '等待处理', ACCEPTED: '已接收', RUNNING: '进行中',
  COMPLETED: '已完成', PARTIAL: '部分完成', FAILED: '已停止', UNKNOWN_HOLD: '结果待确认',
  CANCELLED: '已取消', PREPARING: '正在发布', PUBLISHED: '已发布' };
const definitionKinds = { TYPE: '类型', RELATION: '关系', ATTRIBUTE: '属性', CONSTRAINT: '约束' };
const constraintKinds = { SINGLE_VALUE: '单值约束', INVERSE_UNIQUE: '反向唯一约束',
  MUTUALLY_EXCLUSIVE: '互斥约束' };
const definitionStates = { PROVISIONAL: '资料自动形成', ADOPTED: '已确认', RETIRED: '已停用' };
const actionNames = { CLOSE_STATE: '后来发生了变化', RETIME_FACT: '调整事实时间', CORRECT_FACT: '修订事实',
  REVISE_SCOPE: '区分适用范围', WITHDRAW_FACT: '撤回采用', KEEP_BOTH: '保留双方记载',
  MERGE: '确认为同一实体', KEEP_SEPARATE: '确认为不同实体',
  KEEP_DISTINCT: '保留为不同定义', ALIAS: '确认为同义表达', REBIND: '调整原词对应的定义',
  ADOPT_CONSTRAINT: '采用此范围内的约束', DEFER: '暂不处理' };
const reviewDomains = { FACT: '事实判断', IDENTITY: '实体辨认', ONTOLOGY: '本体判断' };
const directionNames = { FORWARD: '同向（主体和客体保持对应）', REVERSE: '反向（主体和客体对调）' };
const modalityNames = { ASSERTED: '直接陈述', PLANNED: '计划', PREDICTED: '预测', REPORTED: '转述',
  POSSIBLE: '可能', CONDITIONAL: '有条件' };
const knowledgeStates = { CONTESTED: '存在不同记载', OPEN_UNINTERPRETED: '尚未归一', ENDED: '已结束',
  ACTIVE: '已采用', ADOPTED: '已采用', WITHDRAWN: '已撤回' };
const staleCodes = new Set(['VIEW_BASE_STALE', 'PREVIEW_EXPIRED', 'DECISION_TARGET_CHANGED', 'IDENTITY_REVIEW_BASIS_CHANGED', 'ONTOLOGY_REVIEW_BASIS_CHANGED', 'ONTOLOGY_REVIEW_STALE']);
const typeColors = ['#78c3a3', '#8fb2d3', '#c7b481', '#ba9acf', '#7eb6b9'];
function textOf(value) {
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(' · ');
  if (value == null) return '';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value !== 'object') return String(value);
  if (value.kind === 'OPEN_AS_REPORTED') return '结束时间未注明';
  if (value.kind === 'DECIMAL' && value.numerator != null) {
    return [value.denominator === '1' ? value.numerator : value.numerator + '/' + value.denominator, value.unit].filter(Boolean).join(' ');
  }
  return textOf(value.label ?? value.raw ?? value.value ?? value.subject_label ?? value.entity_label ??
    value.text ?? value.decimal ?? value.point ?? value.occurred_at ?? (value.start || value.end ? [value.start, value.end] : null));
}
const dateLabel = value => value && !Number.isNaN(Date.parse(value))
  ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '';
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
const operationId = () => crypto.randomUUID();
const uploadProgressKey = 'ontoweave.pg.upload-progress';
function readUploadProgress() {
  try { return JSON.parse(sessionStorage.getItem(uploadProgressKey)); }
  catch { return null; }
}
function saveUploadProgress(value) {
  try {
    if (value) sessionStorage.setItem(uploadProgressKey, JSON.stringify(value));
    else sessionStorage.removeItem(uploadProgressKey);
  } catch { /* Progress remains addressable by its URL if storage is unavailable. */ }
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, onClick, primary = false) {
  const node = el('button', text, 'lw-button' + (primary ? ' primary' : ''));
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}
function block(title, ...content) {
  const box = el('section', null, 'pg-panel');
  if (title) box.append(el('h2', title));
  box.append(...content.filter(Boolean));
  return box;
}
function list(items, render, empty) {
  if (!items?.length) return el('p', empty ?? '当前范围暂无记录。', 'lw-muted');
  const root = el('ul', null, 'pg-list');
  for (const item of items) {
    const row = el('li');
    row.append(render(item));
    root.append(row);
  }
  return root;
}
function fields(entries) {
  const dl = el('dl', null, 'pg-fields');
  for (const [label, value] of entries) {
    if (value == null || value === '') continue;
    dl.append(el('dt', label), el('dd', value));
  }
  return dl;
}
function message(error) {
  if (staleCodes.has(error?.code)) return '相关知识已更新，请重新预览。';
  if (error?.code === 'HISTORY_BOUNDARY_UNAVAILABLE') return '该时点的完整版本暂时无法确认。';
  if (error?.code === 'SOURCE_NOT_IN_VIEW') return '此版本没有可读的原文依据。';
  return '暂时无法读取，请核对连接和版本。';
}
function errorPanel(error, retry) {
  const box = block(null, el('p', message(error)));
  box.setAttribute('role', 'status');
  if (retry) box.append(button('重新读取', retry));
  if (error?.code || error?.requestRef) {
    const detail = el('details');
    detail.append(el('summary', '诊断'), el('p', [error.code, error.requestRef].filter(Boolean).join(' · ')));
    box.append(detail);
  }
  return box;
}
function decodeRoute(fallback) {
  const search = new URLSearchParams(location.hash.slice(1));
  const library = search.get('library');
  const page = search.get('view');
  return { library: library ?? fallback, page: Object.hasOwn(pages, page) ? page : null,
    item: search.get('item'), pin: search.get('view_revision'), at: search.get('at'), asOf: search.get('as_of') };
}
function routeHash(route) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries({ library: route.library, view: route.page, item: route.item,
    view_revision: route.pin, at: route.at, as_of: route.asOf })) {
    if (value) search.set(key, value);
  }
  return '#' + search.toString();
}
function viewKey(view) {
  return JSON.stringify([view?.view_revision, view?.resolved_scope]);
}
function safeSpan(text, span) {
  if (!Number.isSafeInteger(span?.start) || !Number.isSafeInteger(span?.end) ||
      span.start < 0 || span.end <= span.start || typeof span.quote !== 'string') return null;
  let start = span.start;
  let end = span.end;
  if (span.coordinate_system === 'UNIT_CODEPOINTS') {
    const points = Array.from(text);
    if (end > points.length) return null;
    start = points.slice(0, start).join('').length;
    end = points.slice(0, end).join('').length;
  } else if (span.coordinate_system === 'UTF8_BYTES') {
    const bytes = new TextEncoder().encode(text);
    if (end > bytes.length) return null;
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      start = decoder.decode(bytes.slice(0, start)).length;
      end = start + decoder.decode(bytes.slice(span.start, span.end)).length;
    } catch { return null; }
  } else if (span.coordinate_system !== 'UTF16') return null;
  if (end > text.length || text.slice(start, end) !== span.quote) return null;
  return [start, end];
}
function sourceText(source) {
  const content = source.text ?? source.unit_text ?? '';
  const span = safeSpan(content, source.verified_span);
  const precision = span ? '精确引句' : (source.unit_ref || source.location?.unit_ref || source.precision === 'UNIT') ? '已定位到相关段落' : '资料级来源';
  const quote = el('blockquote');
  if (span) {
    quote.append(document.createTextNode(content.slice(0, span[0])),
      el('mark', content.slice(...span)), document.createTextNode(content.slice(span[1])));
  } else quote.textContent = content || '此版本的原文暂时不可读取。';
  const version = source.version_label ?? (source.location?.revision || source.revision ? '固定资料版本' : null);
  return [el('p', [source.title, version, source.section, precision].filter(Boolean).join(' · '), 'lw-muted'), quote];
}

function projectionFor(data, changes, types, focusType) {
  const nodes = data.graph.nodes;
  const degree = new Map(nodes.map(node => [node.id, 0]));
  const edges = data.graph.edges.filter(edge => degree.has(edge.source) && degree.has(edge.target));
  const focusNodes = new Set(edges.filter(edge => edge.definition_ref === focusType).flatMap(edge => [edge.source, edge.target]));
  for (const node of nodes) {
    if (node.type_refs?.includes(focusType) || node.attributes?.some(attribute => attribute.definition_ref === focusType)) focusNodes.add(node.id);
  }
  for (const edge of edges) {
    degree.set(edge.source, degree.get(edge.source) + 1);
    degree.set(edge.target, degree.get(edge.target) + 1);
  }
  const typeColorsByKey = type => {
    let hash = 0;
    for (const character of type) hash = (hash * 33 + character.codePointAt(0)) >>> 0;
    return typeColors[hash % typeColors.length];
  };
  return {
    version: data.view_revision, total_nodes: data.summary?.total_nodes, total_edges: data.summary?.total_edges,
    nodes: nodes.map(node => {
      const type = node.type_refs?.[0] ?? '未分类';
      const label = types.get(type) ?? (type === '未分类' ? type : node.type_label ?? '定义待读取');
      const change = changes.nodes.get(node.id);
      return { id: 'entity:' + node.id, canonical_id: node.id, label: node.label, kind: 'entity',
        degree: degree.get(node.id), type_label: focusType && !focusNodes.has(node.id) ? '筛选范围外' : label,
        type_color: change === '新增' ? '#b4e8a4' : change === '修改' ? '#e1c281' : typeColorsByKey(type),
        display_badge: change ?? (node.pending ? '待确认' : undefined) };
    }),
    edges: edges.map(edge => ({ ...edge, source: 'entity:' + edge.source, target: 'entity:' + edge.target,
      canonical_id: edge.id, kind: 'relation', directed: edge.directed !== false,
      planned: changes.edges.has(edge.id), display_badge: changes.edges.get(edge.id) ?? knowledgeStates[edge.state] })),
  };
}
function changesBetween(before, after) {
  const compare = (oldItems = [], newItems = []) => {
    const old = new Map(oldItems.map(item => [item.id, item]));
    const changed = new Map();
    for (const item of newItems) {
      const previous = old.get(item.id);
      if (!previous) changed.set(item.id, '新增');
      else if (JSON.stringify(previous) !== JSON.stringify(item)) changed.set(item.id, '修改');
      old.delete(item.id);
    }
    return { changed, removed: [...old.values()] };
  };
  const nodes = compare(before.graph.nodes, after.graph.nodes);
  const edges = compare(before.graph.edges, after.graph.edges);
  return { nodes: nodes.changed, edges: edges.changed, removed: [...nodes.removed, ...edges.removed] };
}
const noChanges = () => ({ nodes: new Map(), edges: new Map(), removed: [] });

export async function mountPgWorkspace({ root, boot }) {
  const descriptor = boot.ontoweave_pg;
  const libraries = new Map((descriptor.libraries ?? []).map(library => [library.library_ref, library]));
  const defaultLibrary = libraries.has(descriptor.default_library_ref) ? descriptor.default_library_ref : libraries.keys().next().value;
  root.className = 'lw-app pg-workspace';
  root.replaceChildren();
  if (!defaultLibrary) {
    root.append(block('OntoWeave', el('p', '当前服务没有可读取的知识库。')));
    return;
  }
  let route = decodeRoute(defaultLibrary);
  let libraryAbort, stopStream, syncTimer, disconnectTimer, api;
  let epoch = 0, connected = false, interrupted = false, syncing = false, dirty = false;
  let head, lastReady, graphUpdate, displayed, build, loadError, initiated, selected, graphView, graphTools;
  let lastBuildRef;
  let chatWorkspace, chatPin;
  let canvasKey, renderKey, pageVersion = 0, activePanel, viewError, pendingRead = false;
  let reviewFlow, revertFlow, receipt, job, changeRef, uploadUnknown, receipts = new Map();
  let bannerKey, reviewRevision = 0;
  const scrollMemory = new Map(), historyParts = new Map();
  const historical = new Map(), contexts = new Map(), observedViews = new Map(), readCache = new Map();
  const timestamps = (name, details = {}) => root.dispatchEvent(new CustomEvent('ontoweave:ui', {
    bubbles: true, detail: { name, library_ref: route.library, milliseconds: performance.now(), ...details },
  }));

  const header = el('header', null, 'lw-header');
  const brand = el('strong', 'OntoWeave', 'lw-brand');
  const selector = el('select', null, 'pg-library-select');
  selector.setAttribute('aria-label', '切换知识库');
  for (const [key, entry] of libraries) {
    const option = el('option', entry.title ?? '知识库');
    option.value = key;
    selector.append(option);
  }
  selector.addEventListener('change', () => navigate({ library: selector.value, page: null, pin: null, at: null, asOf: null }));
  header.append(brand, selector);
  if (descriptor.fixture === true) header.append(el('span', '离线夹具', 'lw-tag'));
  const nav = el('nav', null, 'lw-nav');
  nav.setAttribute('aria-label', '知识库导航');
  const navButtons = new Map();
  for (const name of ['graph', 'documents', 'ontology', 'reviews', 'answers']) {
    const link = button(pages[name], () => navigate({ page: name }));
    nav.append(link);
    navButtons.set(name, link);
  }
  const banner = el('div', null, 'pg-banner');
  const live = el('span');
  live.setAttribute('role', 'status');
  const bannerActions = el('div', null, 'pg-actions');
  banner.append(live, bannerActions);
  const main = el('main', null, 'lw-main pg-main');
  const heading = el('h1');
  heading.tabIndex = -1;
  const content = el('div');
  main.append(heading, content);
  const dialog = el('dialog', null, 'pg-dialog');
  dialog.setAttribute('aria-label', '原文预览');
  let opener;
  dialog.addEventListener('close', () => { dialog.replaceChildren(); opener?.focus(); opener = undefined; });
  root.append(header, nav, banner, main, dialog);

  function rememberCanvas() {
    if (!graphView || !canvasKey) return;
    contexts.set(canvasKey, { snapshot: graphView.snapshot(), selected });
    if (contexts.size > 30) contexts.delete(contexts.keys().next().value);
    graphView.dispose();
    graphView = undefined;
    canvasKey = undefined;
  }
  function go(page, item, pin = route.pin) {
    if (pin && pin === displayed?.view.view_revision) {
      historical.set(JSON.stringify([pin, route.asOf ?? null, route.at ?? null]), displayed);
    }
    navigate({ page, item, pin });
  }
  function navigate(next, { replace = false, focus = true } = {}) {
    const previous = route;
    const target = { ...route, item: null, ...next };
    if (routeHash(target) !== location.hash) {
      const method = replace ? 'replaceState' : 'pushState';
      history[method](null, '', routeHash(target));
    }
    route = target;
    setRoute(previous, focus);
  }
  function onLocationChange() {
    const target = decodeRoute(defaultLibrary);
    if (routeHash(target) === routeHash(route)) return;
    const previous = route;
    route = target;
    setRoute(previous, false);
  }
  addEventListener('popstate', onLocationChange);
  addEventListener('hashchange', onLocationChange);
  function setRoute(previous, focus) {
    scrollMemory.set(routeHash(previous), scrollY);
    if (scrollMemory.size > 60) scrollMemory.delete(scrollMemory.keys().next().value);
    if (initiated && !ownsUploadProgress(initiated)) {
      initiated.used = true;
      saveUploadProgress(null);
    }
    if (previous.library !== route.library) { connectLibrary(); return; }
    if (previous.page !== route.page || previous.item !== route.item || scopeChanged(previous, route)) {
      if (dialog.open) dialog.close();
      rememberCanvas();
      viewError = undefined;
      reviewFlow = undefined;
      revertFlow = undefined;
      activePanel = undefined;
      renderKey = undefined;
      if (scopeChanged(previous, route)) displayed = undefined;
    }
    render(focus);
    invalidate('navigate');
  }
  const scopeChanged = (a, b) => a.pin !== b.pin || a.asOf !== b.asOf || a.at !== b.at;
  function ownsUploadProgress(marker) {
    return marker?.library === route.library && route.page === 'progress' && !route.pin && !route.asOf &&
      Boolean(marker.run) && marker.run === route.item;
  }
  function connectLibrary() {
    epoch++;
    libraryAbort?.abort();
    clearTimeout(syncTimer);
    syncTimer = undefined;
    clearTimeout(disconnectTimer);
    stopStream?.();
    if (dialog.open) dialog.close();
    rememberCanvas();
    libraryAbort = new AbortController();
    api = createPgApi(route.library, { token: boot.token, signal: libraryAbort.signal });
    selector.value = route.library;
    head = lastReady = graphUpdate = displayed = build = loadError = selected = lastBuildRef = undefined;
    const marker = readUploadProgress();
    initiated = ownsUploadProgress(marker) ? { ...marker, used: false } : undefined;
    if (!initiated && marker) saveUploadProgress(null);
    reviewFlow = revertFlow = receipt = job = changeRef = viewError = uploadUnknown = undefined;
    receipts = new Map();
    readCache.clear();
    historical.clear();
    observedViews.clear();
    activePanel = renderKey = undefined;
    interrupted = connected = syncing = dirty = false;
    render();
    stopStream = api.subscribe({ invalidate, connection(value) { connected = value; interrupted = !value; paintBanner(); } });
    invalidate('initial');
  }
  function invalidate(reason) {
    dirty = true;
    if (reason !== 'navigate') readCache.clear();
    if (['review.changed', 'decision.saved', 'saved', 'reconnect'].includes(reason)) reviewRevision++;
    if (syncing || syncTimer) return;
    syncTimer = setTimeout(() => { syncTimer = undefined; void sync(); }, 35);
  }
  async function resolveGraph(client, currentRoute, manifest, old, runEpoch) {
    const requested = currentRoute.pin ?? (!currentRoute.asOf && manifest?.view_revision);
    if (!requested && !currentRoute.asOf) return null;
    const path = { view_revision: requested || null, at: currentRoute.at ?? null, as_of: currentRoute.asOf ?? null };
    const historyKey = JSON.stringify([path.view_revision, path.as_of, path.at]);
    const existing = currentRoute.pin || currentRoute.asOf ? historical.get(historyKey) : null;
    if (existing) return existing;
    if (old?.path && manifest?.view_revision === old.view.view_revision &&
        JSON.stringify(old.path) === JSON.stringify(path)) return old;
    const view = await client.resolve({ ...path, view_revision: currentRoute.asOf ? null : currentRoute.pin || null });
    if (!view?.view_revision || !view.resolved_scope || (requested && view.view_revision !== requested)) {
      throw new Error('Unconfirmed resolved scope');
    }
    let data, delta, usedDelta = false;
    if (old && old.view.view_revision !== view.view_revision && !currentRoute.pin && !currentRoute.asOf &&
        !currentRoute.at && !old.path.at && manifest?.parent_view_revision === old.view.view_revision) {
      try {
        delta = await client.read('/graph/delta', view, { from: old.view.view_revision, to: view.view_revision });
        data = applyGraphDelta(old.data, delta, view);
        if (data) { Object.assign(data, { coverage: manifest.coverage, gaps: manifest.gaps }); usedDelta = true; }
      } catch { /* A full read can recover when no patch was served. */ }
    }
    data ??= await client.read('/graph', view);
    if (!matchingGraph(data, view)) throw new Error('Unconfirmed graph');
    const graph = { view, data, delta, path };
    if (runEpoch === epoch) {
      timestamps('graph_read', { view_revision: view.view_revision, mode: usedDelta ? 'delta' : 'full' });
      if (currentRoute.pin || currentRoute.asOf) {
        historical.set(historyKey, graph);
        if (historical.size > 16) historical.delete(historical.keys().next().value);
      }
    }
    return graph;
  }

  async function sync() {
    if (syncing || !dirty) return;
    dirty = false;
    syncing = true;
    let checkSoon = false;
    const runEpoch = epoch, client = api, checkedRoute = route;
    try {
      const nextHead = await client.head();
      if (epoch !== runEpoch) return;
      const nextManifest = confirmedManifest(nextHead);
      const priorManifest = confirmedManifest(head);
      if (priorManifest?.activation_seq != null && nextManifest?.activation_seq != null &&
          nextManifest.activation_seq < priorManifest.activation_seq) return;
      head = nextHead;
      loadError = undefined;
      const activeRun = head.run_ref ?? head.current_build?.run_ref ?? head.target_publication?.run_ref;
      lastBuildRef = activeRun ?? lastBuildRef;
      const run = route.page === 'progress' ? route.item : lastBuildRef;
      const activeReceipt = receipt;
      const jobRef = activeReceipt?.job_ref ?? (!activeReceipt?.unknown && head.target_publication?.job_ref);
      const [buildResult, currentResult, jobResult] = await Promise.allSettled([
        run ? client.get('/builds/' + ref(run)) : null,
        resolveGraph(client, {}, nextManifest, lastReady, runEpoch),
        jobRef ? client.get('/jobs/' + ref(jobRef)) : null,
      ]);
      if (epoch !== runEpoch) return;
      if (buildResult.status === 'fulfilled') {
        const packet = buildResult.value;
        if (packet && JSON.stringify(packet.stages) !== JSON.stringify(build?.stages)) {
          timestamps('build_read', { run_ref: run, stages: (packet.stages ?? []).map(stage => ({
            stage: stage.stage, status: stage.status, started_at: stage.started_at, ended_at: stage.ended_at,
          })) });
        }
        build = packet;
      } else if (build?.run_ref !== run) build = undefined;
      if (jobResult.status === 'fulfilled' && activeReceipt === receipt) {
        job = jobResult.value;
        if (!receipt && job?.decision_ref) receipt = job;
      }
      const previous = lastReady;
      if (currentResult.status === 'fulfilled' && currentResult.value) {
        lastReady = currentResult.value;
        if (nextManifest) observedViews.set(nextManifest.view_revision, { ...nextManifest, counts: head.counts });
        if (previous?.view.view_revision !== lastReady.view.view_revision) {
          timestamps('manifest_read', { view_revision: lastReady.view.view_revision });
          if (previous) {
            graphUpdate = { before: previous, after: lastReady, changes: changesBetween(previous.data, lastReady.data),
              redirects: lastReady.delta?.entity_redirects ?? nextManifest?.entity_redirects ?? [] };
          }
        }
      } else if (currentResult.status === 'rejected') {
        loadError = currentResult.reason;
        checkSoon = Boolean(nextManifest);
      }
      if (scopeChanged(checkedRoute, route)) return;
      if (route.pin || route.at || route.asOf) {
        try {
          const scoped = await resolveGraph(client, route, nextManifest, displayed, runEpoch);
          if (epoch !== runEpoch || scopeChanged(checkedRoute, route)) return;
          displayed = scoped; viewError = undefined;
        } catch (error) {
          if (epoch !== runEpoch || scopeChanged(checkedRoute, route)) return;
          viewError = error; displayed = undefined;
        }
      } else {
        displayed = lastReady;
        viewError = undefined;
      }
      if (epoch !== runEpoch || scopeChanged(checkedRoute, route)) return;
      if (receiptState(receipt, job, nextManifest, lastReady?.view.view_revision) === '处理已应用') {
        changeRef = (job?.result ?? job ?? receipt).change_ref;
      }
      if (!route.page) {
        navigate({ page: lastReady ? 'graph' : run ? 'progress' : 'documents', item: lastReady ? null : run }, { replace: true, focus: false });
      } else if (lastReady && shouldEnterFirstGraph({ route, initiated, head,
        resolved: lastReady.view, graph: lastReady.data })) {
        initiated.used = true;
        saveUploadProgress(null);
        timestamps('first_graph_navigation', { view_revision: lastReady.view.view_revision });
        navigate({ page: 'graph' }, { replace: true });
      }
    } catch (error) {
      if (epoch === runEpoch) loadError = error;
    } finally {
      if (epoch === runEpoch) {
        syncing = false;
        render();
        updateReviewStatus();
        updateRevertStatus();
        clearTimeout(disconnectTimer);
        if (!connected || checkSoon || (receipt?.job_ref && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(job?.job_status))) {
          disconnectTimer = setTimeout(() => invalidate('poll'), 3000);
        }
        if (dirty) invalidate('queued');
      }
    }
  }

  function paintBanner() {
    const manifest = confirmedManifest(head);
    const target = head?.target_publication?.publication_status;
    const ready = Boolean(lastReady);
    const progress = build?.execution_status ?? head?.execution_status;
    let status = '正在读取知识库';
    if (loadError && !ready && !manifest) status = '知识库暂时无法读取';
    else if (loadError || (manifest && manifest.view_revision !== lastReady?.view.view_revision)) status = ready ? '新版正在读取 · 上一版仍可使用' : '正在读取已发布图谱';
    else if (target === 'UNKNOWN_HOLD' || progress === 'UNKNOWN_HOLD') status = '处理结果待确认，已保存内容保留';
    else if (target === 'FAILED' || progress === 'FAILED') status = ready ? '本次发布未完成，上一版图谱仍可使用' : '图谱发布未完成';
    else if (target === 'PREPARING') status = progress === 'COMPLETED' ? '知识已整理，正在生成图谱和索引' : '正在整理和发布知识';
    else if (ready && (lastReady.data.coverage ?? manifest?.coverage) === 'PARTIAL') status = '部分知识已就绪';
    else if (ready) status = '图谱已就绪';
    else if (runRef()) status = '正在整理资料';
    else if (head) status = '上传资料，开始建立知识图谱';
    if (interrupted) status += ' · 实时连接中断，正在核对';
    if (live.textContent !== status) live.textContent = status;
    const actions = [];
    if (ready && route.page !== 'graph') actions.push(button('查看当前图谱', () => navigate({ page: 'graph', pin: null, at: null, asOf: null })));
    if (runRef() && route.page !== 'progress') actions.push(button('查看整理进度', () => go('progress', runRef())));
    if (loadError || target === 'UNKNOWN_HOLD' || progress === 'UNKNOWN_HOLD' || uploadUnknown) {
      actions.push(button('核对处理结果', () => invalidate('user_read')));
    }
    const key = actions.map(action => action.textContent).join('|') + '|' + runRef();
    if (key !== bannerKey) { bannerKey = key; bannerActions.replaceChildren(...actions); }
  }
  function runRef() { return head?.run_ref ?? head?.current_build?.run_ref ?? head?.target_publication?.run_ref ?? lastBuildRef ?? build?.run_ref; }
  function currentView() { return displayed?.view; }
  function readOnly(view = currentView()) {
    return Boolean(route.pin || route.asOf || view?.read_only || (view && view.view_revision !== confirmedManifest(head)?.view_revision));
  }
  function readBound(path, view, params) {
    const client = api;
    const key = JSON.stringify([route.library, path, viewKey(view), params]);
    if (!readCache.has(key)) {
      const pending = client.read(path, view, params).then(data => {
        if (data.view_revision != null && data.view_revision !== view.view_revision) throw new Error('Mismatched view revision');
        return data;
      }).catch(error => { readCache.delete(key); throw error; });
      if (readCache.size >= 50) readCache.delete(readCache.keys().next().value);
      readCache.set(key, pending);
    }
    return readCache.get(key);
  }
  function historyBar(parent) {
    const manifest = observedViews.get(currentView()?.view_revision) ?? confirmedManifest(head);
    const actions = el('div', null, 'pg-actions');
    if (route.pin || route.asOf) {
      actions.append(el('span', '历史视图', 'lw-tag'), button('回到当前版本', () => navigate({ item: route.item, pin: null, asOf: null })));
      if (lastReady?.view.view_revision !== currentView()?.view_revision) actions.append(el('span', '已有新版', 'lw-muted'));
    }
    if (manifest?.parent_view_revision && manifest.parent_view_revision !== route.pin) {
      actions.append(button('上一发布版本', () => navigate({ pin: manifest.parent_view_revision, asOf: null })));
    }
    if (manifest?.activated_at && manifest.view_revision === currentView()?.view_revision) {
      actions.append(el('span', '发布于 ' + dateLabel(manifest.activated_at), 'lw-muted'));
    }
    if (actions.childElementCount) parent.append(actions);
  }
  function render(focus = false) {
    paintBanner();
    const section = ['progress', 'source'].includes(route.page) ? 'documents' : route.page === 'review' ? 'reviews' : route.page;
    for (const [name, link] of navButtons) {
      if (name === section) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    heading.textContent = pages[route.page] ?? '知识库';
    if (focus) heading.focus();
    const view = currentView();
    if (activePanel?.isConnected && ['documents', 'ontology', 'review', 'change'].includes(route.page)) {
      updateReviewStatus();
      return;
    }
    const key = JSON.stringify([routeHash(route), viewKey(view), route.page === 'progress' ? build : null,
      route.page === 'documents' ? head : null, route.page === 'reviews' ? reviewRevision : null, loadError?.code, viewError?.code, Boolean(loadError), Boolean(viewError), changeRef]);
    if (key === renderKey) return;
    renderKey = key;
    rememberCanvas();
    chatWorkspace?.detach();
    const version = ++pageVersion;
    content.replaceChildren();
    const scroll = scrollMemory.get(routeHash(route)) ?? 0;
    const restoreScroll = () => { if (version === pageVersion) requestAnimationFrame(() => {
      if (version === pageVersion) scrollTo(0, scroll);
    }); };
    if (route.page === 'documents') { renderDocuments(); return; }
    if (route.page === 'progress') { renderProgress(); return; }
    if (route.page === 'graph' || route.pin || route.asOf) historyBar(content);
    if (viewError) {
      content.append(errorPanel(viewError, () => invalidate('user_read')));
      if (route.page === 'graph') timeControls(content);
      return;
    }
    if (!view) {
      content.append(loadError ? errorPanel(loadError, () => invalidate('user_read')) :
        block(null, el('p', runRef() ? '资料整理中。图与索引发布后会出现在这里。' : '上传资料后即可开始整理。'),
          button(runRef() ? '查看整理进度' : '前往资料', () => go(runRef() ? 'progress' : 'documents', runRef()))));
      return;
    }
    const container = el('div', null, 'pg-page');
    content.append(container);
    const handlers = { graph: renderGraph, ontology: renderOntology, reviews: renderReviews, review: renderReview,
      knowledge: renderKnowledge, source: renderSource, change: renderChange, answers: renderAnswers };
    const active = () => version === pageVersion && container.isConnected;
    Promise.resolve(handlers[route.page]?.(container, view, active)).catch(error => {
      if (active()) container.replaceChildren(errorPanel(error, () => { readCache.clear(); renderKey = undefined; render(); }));
    }).then(restoreScroll);
  }

  function renderDocuments() {
    const canUpload = head?.available_actions?.includes('UPLOAD_DOCUMENTS');
    if (!canUpload) {
      const initialOnly = head?.capabilities?.initial_upload_only === true;
      const detail = initialOnly && confirmedManifest(head) ? '此知识库已完成首建。下一批资料请切换到已登记的空知识库。' :
        head ? '此知识库暂未开放上传。' : '正在读取资料能力。';
      content.append(block('资料', el('p', detail, 'lw-muted')));
    }
    const upload = el('form', null, 'pg-upload');
    const label = el('label', '选择资料');
    const input = el('input');
    input.type = 'file';
    input.accept = '.md,.markdown,.docx,.pdf';
    input.multiple = true;
    input.required = true;
    input.disabled = Boolean(uploadUnknown || !head);
    label.append(input);
    const selectedFiles = el('div');
    input.addEventListener('change', () => selectedFiles.replaceChildren(list([...input.files], file => el('span', file.name))));
    const submit = el('button', '开始上传', 'lw-button primary');
    submit.disabled = input.disabled;
    const response = el('div');
    const start = async event => {
      event.preventDefault();
      if (submit.disabled || !input.files.length) return;
      const runEpoch = epoch;
      const operation = operationId();
      const hadPublished = Boolean(lastReady);
      const data = new FormData();
      for (const file of input.files) data.append('files', file, file.name);
      data.append('client_operation_ref', operation);
      submit.disabled = true;
      input.disabled = true;
      submit.textContent = '正在接收资料';
      activePanel = upload;
      const routeAtUpload = route;
      try {
        const result = await api.post('/documents', data);
        if (runEpoch !== epoch) return;
        if (!result.run_ref) throw new Error('Missing run receipt');
        timestamps('upload_accepted', { run_ref: result.run_ref });
        head = { ...head, run_ref: result.run_ref };
        build = result;
        const stillHere = routeAtUpload === route;
        initiated = { library: route.library, run: result.run_ref, used: !stillHere || hadPublished };
        if (!initiated.used) saveUploadProgress({ library: initiated.library, run: initiated.run });
        if (stillHere) go('progress', result.run_ref);
        else invalidate('upload');
      } catch (error) {
        if (runEpoch !== epoch) return;
        const unknown = !error.status || error.status >= 500;
        if (unknown) uploadUnknown = { operation };
        response.replaceChildren(el('p', unknown ? '接收结果待确认，请核对现有整理任务。' : '这批资料未被接受，请查看原因。'),
          errorPanel(error, () => invalidate('user_read')));
        submit.disabled = unknown;
        input.disabled = unknown;
        submit.textContent = '开始上传';
        paintBanner();
      }
    };
    upload.addEventListener('submit', start);
    upload.append(label, selectedFiles, submit, response);
    if (canUpload) {
      const description = confirmedManifest(head) ? '接收后开始整理。图与索引发布后即可查看。' :
        '请一次选齐本批资料（Markdown、DOCX 或 PDF）。接收后开始首建，图与索引发布后即可查看。';
      content.append(block('上传资料', el('p', description, 'lw-muted'), upload));
    }
    const documents = head?.documents ?? head?.current_build?.documents;
    if (documents?.length) content.append(block('资料版本', list(documents, source => {
      const row = el('div', source.title ?? source.filename);
      if (source.status) row.append(el('small', statuses[source.status] ?? source.status));
      if (source.source_ref && currentView()) row.append(button('打开原文', () => go('source', source.source_ref, currentView().view_revision)));
      return row;
    })));
    if (runRef()) content.append(block('最近整理', button('查看整理进度', () => go('progress', runRef()))));
    if (uploadUnknown) content.append(block(null, el('p', '接收结果待确认，请核对现有整理任务。')));
    if (loadError) content.append(errorPanel(loadError, () => invalidate('user_read')));
    if (head) input.addEventListener('change', () => { activePanel = upload; });
  }

  function renderProgress() {
    if (!build || (route.item && build.run_ref !== route.item)) {
      content.append(block(null, el('p', '正在读取本次整理…'), button('重新读取', () => invalidate('user_read'))));
      return;
    }
    const packet = build;
    const rows = new Map();
    for (const stage of packet.stages ?? []) {
      const key = stageAliases[stage.stage] ?? stage.stage;
      rows.set(key, [...(rows.get(key) ?? []), stage]);
    }
    const progress = el('ol', null, 'pg-stage-grid');
    for (const [key, label] of Object.entries(stages)) {
      const row = el('li', null, 'pg-stage');
      const subStages = rows.get(key) ?? [];
      row.dataset.status = subStages.find(item => item.status !== 'COMPLETED')?.status ?? subStages[0]?.status ?? '';
      row.append(el('strong', label));
      if (!subStages.length) row.append(el('span', '等待状态确认'));
      for (const stage of subStages) {
        const done = stage.counts?.processed ??
          (stage.status === 'COMPLETED' ? stage.counts?.statements : null);
        const total = stage.counts?.total;
        const seconds = stage.elapsed_seconds ?? (stage.started_at && stage.ended_at
          ? (Date.parse(stage.ended_at) - Date.parse(stage.started_at)) / 1000 : null);
        row.append(el('span', [subStages.length > 1 ? stageLabels[stage.stage] ?? stage.label : null,
          statuses[stage.status]].filter(Boolean).join(' · ') || '等待状态确认'));
        if (Number.isFinite(done)) row.append(el('p', '已处理 ' + done + (Number.isFinite(total) ? ' / ' + total : '') + (stage.counts.unit_label ? ' ' + stage.counts.unit_label : Number.isFinite(stage.counts.statements) ? ' 条原述' : '')));
        if (Number.isFinite(stage.counts?.definitions) && stage.status === 'COMPLETED') {
          row.append(el('p', '已整理 ' + stage.counts.definitions + ' 条定义'));
        }
        if (Number.isFinite(seconds) && seconds >= 0) row.append(el('small', '耗时 ' + Math.floor(seconds) + ' 秒'));
      }
      progress.append(row);
    }
    const summary = packet.execution_status === 'COMPLETED' && packet.publication_status === 'PREPARING' ?
      '整理已完成，正在发布图谱' : statuses[packet.execution_status] ?? '整理状态待确认';
    content.append(block(summary, progress,
      fields([['图谱发布', statuses[packet.publication_status] ?? '等待状态确认']])));
    const documents = [...(packet.accepted ?? packet.documents ?? []), ...(packet.rejected ?? [])];
    if (documents.length) content.append(block('本批资料', list(documents, source =>
      el('span', [source.title ?? source.filename, statuses[source.status], source.reason_label].filter(Boolean).join(' · ')))));
    appendGaps(content, packet.gaps);
    if (lastReady) content.append(button('查看已发布图谱', () => navigate({ page: 'graph', pin: null, at: null, asOf: null }), true));
    const capabilities = packet.available_actions ?? [];
    if (capabilities.includes('RECONCILE')) {
      content.append(button('核对已有处理记录', async event => {
        const control = event.currentTarget, client = api;
        control.disabled = true;
        try { await client.post('/builds/' + ref(packet.run_ref) + '/reconcile', {}); }
        catch (error) { if (control.isConnected) control.after(errorPanel(error)); }
        finally { if (client === api) invalidate('reconcile'); }
      }));
    }
    if (capabilities.includes('RESUME') && packet.execution_status !== 'UNKNOWN_HOLD') {
      content.append(button('预览可继续范围', async event => {
        const control = event.currentTarget, client = api;
        control.disabled = true;
        const operation = operationId();
        try {
          const preview = await client.post('/builds/' + ref(packet.run_ref) + '/resume-preview', { client_operation_ref: operation });
          if (!control.isConnected) return;
          const status = el('p');
          const confirm = button('继续已核实的范围', async ev => {
            ev.currentTarget.disabled = true;
            try {
              const result = await client.post('/builds/' + ref(packet.run_ref) + '/resume', {
                preview_ref: preview.preview_ref, client_operation_ref: operation, scope_refs: preview.allowed_scope_refs,
              });
              if (client === api && result.run_ref && control.isConnected) go('progress', result.run_ref);
            } catch { status.textContent = '继续结果待确认，请核对运行记录。'; }
            finally { if (client === api) invalidate('resume'); }
          }, true);
          confirm.disabled = !preview.preview_ref || !preview.allowed_scope_refs?.length;
          control.after(block('续作范围', el('p', preview.summary ?? ''), list(preview.allowed_scope ?? [], item => el('span', item.label)), confirm, status));
        } catch (error) { if (control.isConnected) { control.after(errorPanel(error)); control.disabled = false; } }
      }));
    }
  }
  function appendGaps(parent, gaps) {
    if (!gaps?.length) return;
    parent.append(block('未完成范围', list(gaps, gap => el('span',
      [gap.label ?? gap.title ?? gap.scope_ref, gap.reason_label ?? gap.reason_code].filter(Boolean).join(' · ')))));
  }
  function filtersFor(nodes) {
    const filters = el('details', null, 'lw-filter');
    filters.append(el('summary', '筛选对象类型'));
    const items = el('div', null, 'lw-filter-content');
    for (const name of new Set(nodes.map(item => item.type_label))) {
      const control = button(name, () => {});
      control.dataset.graphCommand = 'type';
      control.dataset.type = name;
      control.setAttribute('aria-pressed', 'true');
      items.append(control);
    }
    filters.append(items);
    return filters;
  }
  function canvasContext(view, key, data) {
    const previous = graphUpdate;
    const exact = contexts.get(key);
    if (exact) return exact;
    if (view.view_revision !== previous?.after.view.view_revision || route.pin || route.asOf) return null;
    if (route.at) return null;
    const prior = contexts.get(JSON.stringify([route.library, viewKey(previous.before.view), route.item]));
    if (!prior) return null;
    const redirects = new Map(Array.isArray(previous.redirects)
      ? previous.redirects.map(item => [item.from ?? item.from_entity_ref, item.to ?? item.to_entity_ref]) : Object.entries(previous.redirects));
    const nextIds = new Set(data.graph.nodes.map(item => item.id));
    const nextEdges = new Set(data.graph.edges.map(item => item.id));
    const moved = new Map();
    for (const position of prior.snapshot.positions) {
      const id = position.id.slice('entity:'.length);
      if (nextIds.has(id)) moved.set(id, position);
    }
    for (const position of prior.snapshot.positions) {
      const survivor = redirects.get(position.id.slice('entity:'.length));
      if (nextIds.has(survivor) && !moved.has(survivor)) moved.set(survivor, { ...position, id: 'entity:' + survivor });
    }
    let picked = prior.selected;
    if (picked?.kind === 'entity' && !nextIds.has(picked.id)) picked = redirects.has(picked.id) ? { ...picked, id: redirects.get(picked.id) } : null;
    if (picked?.kind !== 'entity' && !nextEdges.has(picked?.id)) picked = null;
    const originalFocus = prior.snapshot.focus?.slice('entity:'.length);
    const focused = nextIds.has(originalFocus) ? originalFocus : redirects.get(originalFocus);
    return { selected: picked, removedSelection: Boolean(prior.selected && !picked),
      snapshot: { ...prior.snapshot, version: view.view_revision, selection: picked,
        positions: [...moved.values()], focus: focused ? 'entity:' + focused : null,
        projection_focus: null, temporary_context: null } };
  }
  function timeControls(parent) {
    const row = el('form', null, 'pg-actions pg-time');
    const mode = el('select');
    mode.setAttribute('aria-label', '时间范围');
    for (const [value, label] of [['all', '全部时间'], ['current', '当前有效'], ['at', '指定世界时间'], ['asOf', '按当时的认识']]) {
      const option = el('option', label);
      option.value = value;
      mode.append(option);
    }
    mode.value = route.asOf ? 'asOf' : route.at === 'current' ? 'current' : route.at ? 'at' : 'all';
    const timestamp = el('input');
    timestamp.setAttribute('aria-label', '时间与时区');
    timestamp.placeholder = '2026-11-18T10:00:00+08:00';
    timestamp.value = route.asOf ?? (route.at === 'current' ? '' : route.at) ?? '';
    const showInput = () => { timestamp.hidden = !['at', 'asOf'].includes(mode.value); };
    showInput();
    mode.addEventListener('change', showInput);
    const tip = el('span', null, 'lw-muted');
    const submit = el('button', '查看时间范围', 'lw-button');
    row.addEventListener('submit', event => {
      event.preventDefault();
      const value = timestamp.value.trim();
      if (mode.value === 'asOf' && (!/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))) {
        tip.textContent = '请选择带时区的完整时间点。';
        return;
      }
      if (mode.value === 'at' && !value) { tip.textContent = '请填写要查看的世界时间。'; return; }
      navigate({ item: route.item, pin: mode.value === 'asOf' ? null : route.pin,
        at: mode.value === 'at' ? value : mode.value === 'current' ? 'current' : null,
        asOf: mode.value === 'asOf' ? value : null });
    });
    row.append(mode, timestamp, submit, tip);
    parent.append(row);
  }
  async function renderGraph(parent, view, active) {
    const frame = displayed;
    const data = frame.data;
    const focusType = route.item;
    const key = JSON.stringify([route.library, viewKey(view), focusType]);
    const restored = canvasContext(view, key, data);
    selected = restored?.selected ?? null;
    const update = !route.pin && !route.asOf && graphUpdate?.after.view.view_revision === view.view_revision ? graphUpdate : null;
    const publication = observedViews.get(view.view_revision);
    const caption = el('p', (data.coverage ?? publication?.coverage) === 'PARTIAL' ? '部分知识已就绪' : '已发布图谱', 'lw-muted');
    caption.className = 'lw-muted pg-graph-caption';
    parent.append(caption);
    timeControls(parent);
    if (loadError && lastReady) parent.append(errorPanel(loadError, () => invalidate('user_read')));
    appendGaps(parent, data.gaps ?? publication?.gaps);
    if (publication?.counts) {
      const counts = el('ul', null, 'pg-metrics');
      for (const [label, number] of [['标准事实', publication.counts.standard_facts],
        ['开放知识', publication.counts.open_statements], ['争议事实', publication.counts.contested_facts],
        ['待处理', publication.counts.open_reviews]]) {
        if (Number.isFinite(number)) counts.append(el('li', label + ' ' + number));
      }
      parent.append(counts);
    }
    if (changeRef && !readOnly()) parent.append(button('查看本次变化', () => go('change', changeRef)));
    if (update && !data.selection?.truncated && !update.before.data.selection?.truncated) {
      const total = kind => [...update.changes.nodes.values(), ...update.changes.edges.values()].filter(value => value === kind).length;
      parent.append(el('p', '本次变化 · 新增 ' + total('新增') + ' · 修改 ' + total('修改') +
        ' · 移出 ' + update.changes.removed.length, 'pg-change-legend'));
      if (update.changes.removed.length) {
        const removed = el('details');
        removed.append(el('summary', '查看移出的对象与关联'),
          list(update.changes.removed, item => el('span', item.label ?? '移出一项关联')));
        parent.append(removed);
      }
      if (restored?.removedSelection) parent.append(el('p', '此前选中的对象已移出此版本。', 'lw-muted'));
    }
    if (!data.graph.edges.length) parent.append(el('p', data.graph.nodes.length ? '此范围没有可连线的关系。' : '此范围没有可绘制的知识。', 'lw-muted'));
    const typesPromise = readBound('/ontology', view).catch(() => ({ definitions: [] }));
    const toolsPromise = graphTools ?? import('/assets/graph-view.mjs');
    const [catalog, tools] = await Promise.all([typesPromise, toolsPromise]);
    if (!active()) return;
    graphTools = tools;
    const types = new Map((catalog.items ?? []).map(def => [def.definition_ref, def.label]));
    const projection = projectionFor(data, update?.changes ?? noChanges(), types, focusType);
    const focusNodes = new Set(projection.nodes.filter(node => node.type_label !== '筛选范围外').map(node => node.canonical_id));
    const layout = el('div', null, 'pg-graph-layout');
    const canvas = el('section', null, 'pg-graph-canvas native-domain-section');
    const canvasToolbar = el('div', null, 'pg-actions pg-graph-toolbar');
    for (const [command, label] of [['in', '放大'], ['out', '缩小'], ['fit', '适应视图'], ['layout', '重新布局'], ['motion', '暂停或恢复布局']]) {
      const control = button(label, () => {});
      control.dataset.graphCommand = command;
      canvasToolbar.append(control);
    }
    canvasToolbar.append(filtersFor(projection.nodes));
    const surface = el('div', null, 'pg-graph-surface');
    surface.dataset.graphSurface = '';
    surface.tabIndex = 0;
    surface.setAttribute('aria-label', '领域关系图');
    const status = el('p', null, 'lw-muted');
    status.dataset.graphStatus = '';
    status.setAttribute('role', 'status');
    canvas.append(canvasToolbar, surface, status);
    const inspector = block('知识详情', el('p', '选择对象或关系查看定义与原文依据。', 'lw-muted'));
    const browse = el('details');
    browse.append(el('summary', '按列表查看对象与关系'));
    const search = el('input');
    search.type = 'search';
    search.placeholder = '搜索名称';
    search.setAttribute('aria-label', '搜索图中对象和关系');
    search.value = restored?.query ?? '';
    const entries = el('div', null, 'pg-browse');
    function inspect(id, kind) {
      selected = id ? { id, kind } : null;
      showSelection(inspector, data, view, types, id, kind).catch(error => {
        if (active() && selected?.id === id) inspector.append(errorPanel(error));
      });
    }
    function browseItems() {
      const query = search.value.trim().toLocaleLowerCase();
      entries.replaceChildren(list([...data.graph.nodes, ...data.graph.edges].filter(item =>
        item.label?.toLocaleLowerCase().includes(query) && (!focusType || focusNodes.has(item.id) ||
          item.definition_ref === focusType || (focusNodes.has(item.source) && focusNodes.has(item.target)))), item => button(item.label, () => {
        const kind = Object.hasOwn(item, 'source') ? 'relation' : 'entity';
        graphView?.select(item.id, kind);
        inspect(item.id, kind);
      }), '当前筛选没有匹配的对象或关系。'));
    }
    search.addEventListener('input', browseItems);
    browseItems();
    browse.append(search, entries);
    canvas.append(browse);
    layout.append(canvas, inspector);
    parent.append(layout);
    if (data.selection?.truncated) {
      const total = data.summary;
      parent.append(el('p', '已加载 ' + total.returned_nodes + ' / ' + total.total_nodes +
        ' 个对象，' + total.returned_edges + ' / ' + total.total_edges + ' 条关联。', 'lw-muted'));
      if (data.selection.next_cursor) {
        const more = button('继续加载图谱', async () => {
          more.disabled = true;
          try {
            const next = await readBound('/graph', view, { cursor: data.selection.next_cursor });
            if (!active() || displayed !== frame || !matchingGraph(next, view)) return;
            const merge = (a, b) => [...new Map([...a, ...b].map(item => [item.id, item])).values()];
            const nodes = merge(data.graph.nodes, next.graph.nodes), edges = merge(data.graph.edges, next.graph.edges);
            frame.data = { ...next, graph: { nodes, edges }, summary: {
              ...next.summary, returned_nodes: nodes.length, returned_edges: edges.length,
            }, selection: { ...next.selection, truncated: Boolean(next.selection.next_cursor) } };
            renderKey = undefined;
            render();
          } catch (error) {
            if (active()) { more.disabled = false; more.after(errorPanel(error)); }
          }
        });
        parent.append(more);
      }
    }
    const saveLocal = () => {
      const saved = contexts.get(key);
      if (saved) { saved.query = search.value; saved.listOpen = browse.open; }
    };
    browse.open = restored?.listOpen ?? false;
    if (data.graph.nodes.length) {
      try {
        graphView = tools.createGraphView(canvas, { id: view.view_revision }, {
          labelTheme: 'native-domain', edgeLabels: 'auto', layoutKey: route.library + ':' + key,
          context: restored?.snapshot, projectionFactory: () => projection, onSelect: inspect,
        });
        const handle = graphView;
        canvasKey = key;
        const dispose = handle.dispose;
        handle.dispose = () => { saveLocal(); dispose(); };
        if (focusType && !restored) {
          canvas.querySelector('[data-type="筛选范围外"]')?.click();
        }
        await nextFrame();
        if (active()) timestamps('graph_interactive', { view_revision: view.view_revision });
      } catch {
        status.textContent = '交互画布暂不可用。仍可通过列表查阅对象、关系和原文。';
      }
    } else surface.hidden = true;
    if (active() && selected) inspect(selected.id, selected.kind);
  }
  async function showSelection(parent, data, view, types, id, kind) {
    parent.replaceChildren(el('h2', '知识详情'));
    if (!id) return;
    if (kind === 'entity') {
      const node = data.graph.nodes.find(item => item.id === id);
      if (!node) return;
      parent.append(el('h3', node.label));
      const typeRefs = node.type_refs ?? [];
      if (typeRefs.length) parent.append(list(typeRefs, type => button(types.get(type) ?? '查看类型定义',
        () => go('ontology', type, view.view_revision))));
      parent.append(list(data.graph.edges.filter(edge => edge.source === id || edge.target === id), edge => {
        const label = data.graph.nodes.find(node => node.id === (edge.source === id ? edge.target : edge.source))?.label;
        return button([edge.label, label].filter(Boolean).join(' · '),
          () => edge.fact_ref ? go('knowledge', edge.fact_ref, view.view_revision) :
            (graphView?.select(edge.id, 'relation'), showSelection(parent, data, view, types, edge.id, 'relation')));
      }, '当前画布没有此对象的关联。'));
      if (node.attributes?.length) parent.append(block('属性', list(node.attributes, attribute =>
        button([attribute.label, textOf(attribute.value)].filter(Boolean).join(' · '),
          () => go('knowledge', attribute.fact_ref, view.view_revision)))));
      parent.append(sourceButtons(node.source_refs, view));
      return;
    }
    const edge = data.graph.edges.find(item => item.id === id);
    if (!edge) return;
    parent.append(el('h3', edge.label), el('p', knowledgeStates[edge.state] ?? '', 'lw-muted'));
    if (!edge.fact_ref && edge.statement_ref) {
      parent.append(sourceButtons(edge.source_refs, view));
      return;
    }
    const fact = await readBound('/knowledge/' + ref(edge.fact_ref ?? edge.id), view);

    if (parent.isConnected && selected?.id === id) parent.append(factDetails(fact, view));
  }

  function sourceButtons(sources = [], view) {
    const row = el('div', null, 'pg-actions');
    for (const item of sources) {
      const sourceRef = typeof item === 'string' ? item : item.source_ref;
      if (!sourceRef) continue;
      row.append(button(item.title ?? '查看原文依据', event => previewSource(sourceRef, view, event.currentTarget)));
    }
    return row;
  }
  async function previewSource(sourceRef, view, control) {
    opener = control;
    const slot = block('原文预览', el('p', '正在读取此版本原文…'));
    const close = button('关闭预览', () => dialog.close());
    dialog.replaceChildren(slot, close);
    if (!dialog.open) dialog.showModal();
    try {
      const source = await readBound('/sources/' + ref(sourceRef), view);
      if (!slot.isConnected) return;
      slot.replaceChildren(el('h2', '原文预览'), ...sourceText(source),
        button('打开原文', () => { dialog.close(); go('source', sourceRef, view.view_revision); }));
    } catch (error) {
      if (slot.isConnected) slot.replaceChildren(errorPanel(error, () => previewSource(sourceRef, view, control)));
    }
  }
  async function renderSource(parent, view, active) {
    if (route.item?.startsWith('retrieval~')) {
      const [, sourceRef, descriptorRef, rawStart, rawEnd] = route.item.split('~');
      const quoteStart = Number(rawStart), quoteEnd = Number(rawEnd);
      const result = await api.get('/retrieval/sources/' + ref(sourceRef), {
        view_revision: view.view_revision, index_descriptor_ref: descriptorRef || null,
        start: Number.isSafeInteger(quoteStart) ? Math.max(0, quoteStart - 500) : 0,
      });
      if (!active()) return;
      const spanStart = quoteStart - result.location.start, spanEnd = quoteEnd - result.location.start;
      const points = Array.from(result.text);
      const quote = spanStart >= 0 && spanEnd > spanStart && spanEnd <= points.length
        ? {start:spanStart, end:spanEnd, quote:points.slice(spanStart,spanEnd).join(''), coordinate_system:'UNIT_CODEPOINTS'} : null;
      const body = el('pre', null, 'pg-source-text');
      if (quote) body.append(document.createTextNode(points.slice(0,spanStart).join('')),
        el('mark', quote.quote), document.createTextNode(points.slice(spanEnd).join('')));
      else body.textContent = result.text;
      parent.append(button('返回来源入口', () => history.back()), block('资料原文',
        el('p', '固定资料版本 · 原文块范围 ' + result.location.start + '–' + result.location.end, 'lw-muted'), body));
      return;
    }
    const source = await readBound('/sources/' + ref(route.item), view);
    if (!active()) return;
    parent.append(button('返回来源入口', () => history.back()), block(source.title ?? '资料原文', ...sourceText(source)));
  }
  function objectLabel(value, view) {
    if (value?.kind !== 'ENTITY') return textOf(value);
    if (viewKey(view) === viewKey(displayed?.view)) {
      return displayed?.data.graph.nodes.find(node => node.id === value.entity_ref)?.label ?? textOf(value);
    }
    return textOf(value);
  }
  function factDetails(fact, view) {
    const area = el('div', null, 'pg-fact');
    area.append(fields([
      ['主体', textOf(fact.subject ?? fact.subject_label)], ['原关系或属性', textOf(fact.raw_properties ?? fact.original_predicate)],
      ['标准关系或属性', textOf(fact.predicate ?? fact.label)],
      ['对象或值', objectLabel(fact.object ?? fact.value ?? fact.content?.value, view)], ['单位', fact.unit ?? fact.content?.value?.unit],
      ['适用范围', textOf(fact.scope ?? fact.content?.conditions?.scope)],
      ['归因', textOf(fact.content?.conditions?.attribution)], ['限定', textOf(fact.qualifiers ?? fact.content?.conditions?.context)],
      ['表达方式', modalityNames[fact.modality] ?? textOf(fact.modality)], ['是否否定', typeof fact.negated === 'boolean' ? (fact.negated ? '是' : '否') : null],
      ['原文时间', textOf(fact.asserted_world_time ?? fact.world_time)],
      ['采用状态', knowledgeStates[fact.state] ?? fact.state],
    ]));
    if (fact.statement_text) area.append(el('blockquote', fact.statement_text));
    if (fact.definition_ref) area.append(button('查看关系定义', () => go('ontology', fact.definition_ref, view.view_revision)));
    for (const reviewRef of fact.review_refs ?? (fact.review_ref ? [fact.review_ref] : [])) {
      area.append(button('查看对应事项', () => go('review', reviewRef, view.view_revision)));
    }
    area.append(sourceButtons(fact.sources ?? fact.source_refs, view));
    return area;
  }
  async function renderKnowledge(parent, view, active) {
    const fact = await readBound('/knowledge/' + ref(route.item), view);
    if (!active()) return;
    parent.append(button('返回上一步', () => history.back()), block(fact.label ?? '知识依据', factDetails(fact, view)));
  }
  async function renderOntology(parent, view, active) {
    if (route.item) {
      const definition = await readBound('/ontology/' + ref(route.item), view);
      if (!active()) return;
      const detail = definition.definition ?? definition;
      const detailType = definitionKinds[detail.kind];
      parent.append(button('返回上一步', () => history.back()));
      const pane = block(detail.label ?? '定义详情', fields([
        ['种类', detailType], ['定义状态', definitionStates[detail.definition_status ?? detail.status]], ['含义', detail.description],
        ['目前资料中的用法', textOf(detail.observed_usage)], ['观察到的主体类型', textOf(detail.observed_domains)],
        ['观察到的客体类型', textOf(detail.observed_ranges)], ['适用范围', textOf(detail.scope)],
        ['值形状', textOf(detail.value_shape ?? detail.observed_datatypes)], ['单位', textOf(detail.unit)],
        ['时间语义', textOf(detail.temporal_semantics ?? detail.time_semantics)],
      ]));
      parent.append(pane);
      const mappings = detail.bindings ?? definition.bindings;
      if (mappings?.length) pane.append(block('资料原词与标准方向', list(mappings, binding =>
        el('span', [binding.phrase ?? binding.raw_label ?? binding.original_expression, { FORWARD: '正向映射', REVERSE: '反向映射',
          REVERSED: '反向映射' }[binding.direction], binding.original_direction_label, binding.standard_direction_label].filter(Boolean).join(' · ')))));
      const sources = detail.sources ?? detail.source_refs;
      if (sources?.length) pane.append(block('定义来源', sourceButtons(sources, view)));
      const facts = detail.related_facts ?? [];
      if (facts.length) pane.append(block('关联实例', list(facts, fact =>
        button(fact.label ?? '查看相关事实', () => go('knowledge', fact.fact_ref, view.view_revision)))));
      pane.append(button('在图谱中查看实例', () => go('graph', detail.definition_ref ?? route.item, view.view_revision)));
      if (!readOnly(view) && (detail.available_actions ?? definition.available_actions ?? []).includes('FEEDBACK')) {
        renderFeedback(pane, detail, view);
      }
      return;
    }
    const filters = el('div', null, 'pg-actions');
    const overview = el('div');
    parent.append(filters, overview);
    const items = [];
    const listKey = JSON.stringify([route.library, viewKey(view), 'ontology']);
    const selectedKinds = new Set(historyParts.get(listKey) ?? Object.keys(definitionKinds));
    let cursor;
    function draw() {
      overview.replaceChildren(...Object.entries(definitionKinds).filter(([kind]) => selectedKinds.has(kind)).map(([kind, label]) =>
        block(label, list(items.filter(item => item.kind === kind), item => {
          const row = el('div');
          row.append(button(item.label, () => go('ontology', item.definition_ref)),
            el('small', [definitionStates[item.definition_status ?? item.status], Number.isFinite(item.instance_count) ? item.instance_count + ' 个实例' : ''].filter(Boolean).join(' · ')));
          return row;
        }, '当前范围暂无' + label + '定义。'))));
      if (cursor) {
        const more = button('继续读取定义', async () => {
          more.disabled = true;
          try { await load(cursor); } catch (error) { if (active()) overview.append(errorPanel(error)); }
        });
        overview.append(more);
      }
    }
    for (const [kind, label] of Object.entries(definitionKinds)) {
      const toggle = button(label, () => {
        if (!selectedKinds.delete(kind)) selectedKinds.add(kind);
        toggle.setAttribute('aria-pressed', String(selectedKinds.has(kind)));
        historyParts.set(listKey, [...selectedKinds]);
        draw();
      });
      toggle.setAttribute('aria-pressed', 'true');
      filters.append(toggle);
    }
    async function load(next) {
      const data = await readBound('/ontology', view, { cursor: next });
      if (!active()) return;
      items.push(...(data.items ?? []));
      cursor = data.next_cursor ?? data.selection?.next_cursor;
      draw();
    }
    await load();
  }
  function renderFeedback(parent, detail, view) {
    const feedback = el('details');
    const prompt = el('summary', '反馈定义问题');
    const form = el('form', null, 'pg-form');
    const problem = el('textarea'), suggested = el('textarea');
    problem.required = true;
    const problemLabel = el('label', '哪里需要澄清');
    problemLabel.append(problem);
    const suggestedLabel = el('label', '建议含义（可选）');
    suggestedLabel.append(suggested);
    const facts = (detail.related_facts ?? []).map(fact => {
      const label = el('label', fact.label ?? '关联事实');
      const check = el('input');
      check.type = 'checkbox';
      check.value = fact.fact_ref;
      label.prepend(check);
      return { label, check };
    });
    const submit = el('button', '提交定义反馈', 'lw-button primary');
    const status = el('div');
    status.setAttribute('role', 'status');
    form.append(problemLabel, suggestedLabel, ...facts.map(item => item.label), submit, status);
    feedback.append(prompt, form);
    parent.append(feedback);
    problem.addEventListener('input', () => { activePanel = form; });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!problem.value.trim() || submit.disabled) return;
      if (readOnly(view)) { status.textContent = '本体已更新，请回到当前版本核对。'; return; }
      submit.disabled = true;
      try {
        const result = await api.post('/ontology/' + ref(detail.definition_ref) + '/feedback', {
          contract: 'ontoweave-ontology-feedback/1', base_view_revision: view.view_revision, definition_ref: detail.definition_ref,
          business_problem: problem.value.trim(), suggested_revision: suggested.value.trim() || undefined,
          fact_refs: facts.filter(item => item.check.checked).map(item => item.check.value),
          source_refs: (detail.sources ?? detail.source_refs ?? []).map(source => source.source_ref ?? source).filter(Boolean),
          client_operation_ref: operationId(),
        });
        if (!form.isConnected) return;
        if (result.review_ref) go('review', result.review_ref);
        else status.replaceChildren(el('p', '反馈已记录，请补充具体依据。'), list(result.missing_context ?? result.missing, item => el('span', textOf(item))));
      } catch (error) {
        if (form.isConnected) status.replaceChildren(errorPanel(error, () => invalidate('user_read')));
        submit.disabled = !error.status || error.status >= 500;
      }
    });
  }
  async function renderReviews(parent, view, active) {
    const filter = el('div', null, 'pg-actions'), body = el('div');
    parent.append(filter, body);
    const listKey = JSON.stringify([route.library, viewKey(view), 'reviews']);
    let status = historyParts.get(listKey) ?? 'OPEN', request = 0, rows = [];
    const tabs = new Map();
    for (const [key, label] of [['OPEN', '待判断'], ['UNAVAILABLE', '暂不可处理'],
      ['DEFERRED', '暂不处理'], ['DECIDED', '已作决定']]) {
      const tab = button(label, () => { status = key; historyParts.set(listKey, status); void load(); });
      filter.append(tab);
      tabs.set(key, tab);
    }
    async function load(cursor) {
      const seq = ++request;
      for (const [key, tab] of tabs) tab.setAttribute('aria-pressed', String(key === status));
      try {
        const data = await readBound('/reviews', view, { status: status === 'UNAVAILABLE' ? undefined : status, cursor });
        if (!active() || seq !== request) return;
        const items = (data.items ?? []).filter(item => status !== 'UNAVAILABLE' ||
          (item.review_status === 'OPEN' && item.review_eligibility?.actionable === false));
        rows = cursor ? rows.concat(items) : items;
        tabs.get('UNAVAILABLE').hidden = status !== 'UNAVAILABLE' && !data.counts?.unavailable_open;
        body.replaceChildren(fields([['待判断', data.counts?.open], ['待应用', data.counts?.pending_application],
          ['暂不可处理', data.counts?.unavailable_open]]),
          list(rows, item => {
            const row = el('div');
            row.append(button(item.title ?? item.question ?? '查看事项', () => go('review', item.review_ref)));
            const description = [reviewDomains[reviewDomain(item)], textOf(item.subject)].filter(Boolean).join(' · ');
            if (description) row.append(el('small', description));
            if (status === 'UNAVAILABLE' && item.review_eligibility?.reason) {
              row.append(el('small', item.review_eligibility.reason));
            }
            return row;
          }, '当前没有这类事项。'));
        const next = data.next_cursor ?? data.selection?.next_cursor;
        if (next) body.append(button('继续读取事项', () => load(next)));
      } catch (error) { if (active() && seq === request) body.replaceChildren(errorPanel(error, () => load())); }
    }
    await load();
  }
  function sideSummary(side, view, domain) {
    if (domain === 'IDENTITY') return fields([
      ['其他名称', textOf((side.names ?? []).filter(name => name !== (side.display_name ?? side.label ?? side.name)))],
      ['资料中的别名', textOf(side.aliases)], ['资料中的类型', textOf(side.type_observations ?? side.types)],
    ]);
    if (domain === 'ONTOLOGY') {
      const definition = side.definition ?? side;
      return fields([
        ['定义名称', constraintKinds[definition.label] ?? definition.label ?? definition.name],
        ['类别', definitionKinds[definition.kind] ?? constraintKinds[definition.kind]],
        ['采用状态', definitionStates[definition.definition_status ?? definition.status]],
        ['含义', definition.description], ['资料中的表达', textOf(side.raw_properties ?? side.phrases ?? side.raw_labels)],
        ['观察到的主体类型', textOf(definition.observed_domains)], ['观察到的客体类型', textOf(definition.observed_ranges)],
        ['适用范围', textOf(side.scope ?? definition.scope)],
      ]);
    }
    return fields([
      ['主体', textOf(side.subject ?? side.entity)], ['原关系或属性', textOf(side.raw_properties ?? side.original_predicate)],
      ['标准关系或属性', textOf(side.property ?? side.predicate)], ['对象或值', objectLabel(side.object ?? side.value, view)], ['单位', side.unit],
      ['适用范围', textOf(side.scope)], ['限定', textOf(side.qualifiers)], ['表达方式', modalityNames[side.modality] ?? textOf(side.modality)],
      ['原文时间与范围', textOf(side.world_time)], ['归因', textOf(side.attribution)],
      ['是否否定', typeof side.negated === 'boolean' ? (side.negated ? '是' : '否') : null], ['采用状态', knowledgeStates[side.state] ?? side.state],
    ]);
  }
  function identityComparisonContext(detail) {
    const sourceSets = (detail.sides ?? []).map(side => new Set(
      (side.evidence ?? side.sources ?? side.source_refs ?? []).map(row => row?.source_ref ?? row)));
    const shared = new Set();
    const seen = new Set();
    for (const refs of sourceSets) for (const source of refs) {
      if (seen.has(source)) shared.add(source);
      seen.add(source);
    }
    return { shared, exactContract: Boolean(detail.model_suggestion || detail.review_eligibility || detail.adoption) };
  }
  function identityStatementText(record) {
    if (typeof record === 'string') return record.trim();
    const fields = [record?.subject, record?.relation_phrase ?? record?.predicate,
      record?.value_raw ?? textOf(record?.value), record?.unit];
    const structured = fields.filter(value => typeof value === 'string' && value.trim()).join(' · ');
    return structured || (typeof record?.raw_utf8 === 'string' ? record.raw_utf8.trim() : '');
  }
  async function identitySide(side, pane, view, context) {
    const sourceEvidence = side.evidence?.length ? side.evidence : side.sources ?? side.source_refs ?? [];
    const entries = new Map();
    for (const value of sourceEvidence) {
      const row = typeof value === 'string' ? { source_ref: value } : value;
      if (!row?.source_ref) continue;
      const key = JSON.stringify([row.source_ref, row.statement_ref, row.occurrence_ref]);
      if (!entries.has(key)) entries.set(key, row);
    }
    const results = await Promise.allSettled([...entries.values()].map(async row => {
      const source = await readBound('/sources/' + ref(row.source_ref), view);
      const text = source.text ?? source.unit_text ?? '';
      const range = row.source_excerpt_range;
      const verifiedRange = range && safeSpan(text, {
        start: range.start, end: range.end, coordinate_system: range.coordinate, quote: row.preview,
      });
      const verified = typeof row.preview === 'string' && row.preview.trim() && context.exactContract &&
        (verifiedRange || (['EXACT', 'EXACT_RANGE', 'EXACT_SPAN', 'SPAN'].includes(row.precision) && text.includes(row.preview))) &&
        !(context.shared.has(row.source_ref) && row.preview === text);
      const linked = el('article', null, 'lw-source');
      linked.append(el('small', source.title ?? row.location?.title ?? '固定资料版本'));
      const statement = identityStatementText(row.statement_excerpt);
      if (statement) linked.append(el('h5', '已保存陈述'), el('p', statement));
      if (verified) {
        linked.append(el('small', verifiedRange ? '已定位原文片段 · 原句边界未核准' : '已绑定原文片段'),
          el('blockquote', row.preview));
      } else if (text && !context.shared.has(row.source_ref) && !context.exactContract) {
        const points = Array.from(text);
        linked.append(el('small', '资料段落 · 原句位置未核准'),
          el('blockquote', points.length > 340 ? points.slice(0, 340).join('') + '…' : text));
      } else {
        linked.append(el('small', text ? '资料级依据 · 此陈述的原句位置未核准' : '此版本原文暂不可读取'));
      }
      linked.append(button('打开此版本原文', () => go('source', row.source_ref, view.view_revision)));
      return { linked, readable: Boolean(text) };
    }));
    for (const result of results) {
      pane.append(result.status === 'fulfilled' ? result.value.linked : errorPanel(result.reason));
    }
    return results.length > 0 && results.every(result => result.status === 'fulfilled' && result.value.readable);
  }
  async function reviewSide(side, index, view, domain, comparison) {
    const label = side.title ?? side.display_name ?? side.definition?.label ?? side.label;
    const name = (constraintKinds[label] ?? label) ?? (index === 0 ? '一方记载' : '另一方记载');
    if (domain === 'IDENTITY') {
      const wrapper = el('div');
      wrapper.innerHTML = lightogReviewSideMarkup({ name });
      const pane = wrapper.firstElementChild;
      const content = pane.querySelector('[data-review-side-content]');
      content.append(sideSummary(side, view, domain));
      return { pane, readable: await identitySide(side, content, view, comparison) };
    }
    const sidePane = block(name, sideSummary(side, view, domain));
    if (side.statement_text) sidePane.append(el('p', side.statement_text, 'pg-statement'));
    const sources = side.sources ?? side.source_refs ?? side.evidence ?? [];
    if (!sources.length) return { pane: sidePane, readable: false };
    const references = sources.map(item => typeof item === 'string' ? item : item?.source_ref);
    const settled = await Promise.allSettled([...new Set(references)].map(async source => {
      if (typeof source !== 'string' || !source) throw new Error('Missing source reference');
      return readBound('/sources/' + ref(source), view).then(data => ({ source, data }));
    }));
    for (const result of settled) {
      if (result.status === 'rejected') sidePane.append(errorPanel(result.reason));
      else {
        const { data, source } = result.value;
        sidePane.append(...sourceText(data), button('打开此版本原文', () => go('source', source, view.view_revision)));
      }
    }
    return { pane: sidePane, readable: settled.every(result => result.status === 'fulfilled' &&
      Boolean(result.value.data.text ?? result.value.data.unit_text)) };
  }
  function impactBlock(preview, view) {
    const columns = el('div', null, 'pg-pair');
    const beforeEntities = new Map((preview.before?.entities ?? []).map(entity => [entity.entity_ref, entity]));
    const definitions = new Map((preview.before?.sides ?? []).map(side => [side.definition_ref, side.label]));
    function impactEntries(side) {
      const items = Array.isArray(side) ? side : [
        'entities', 'definitions', 'sides', 'bindings', 'changed_bindings', 'constraints', 'adopted_constraints',
        'facts', 'edges', 'nodes',
      ]
        .flatMap(key => Array.isArray(side?.[key]) ? side[key] : []);
      if (!side?.entities?.length && side?.entity_refs?.length) {
        items.push(...side.entity_refs.map(key => beforeEntities.get(key)).filter(Boolean));
      }
      const result = el('div');
      const relationship = { SAME: '合并为同一实体', DIFFERENT: '保持为不同实体' }[side?.relationship];
      if (relationship) result.append(el('p', relationship));
      if (actionNames[side?.action]) result.append(el('p', actionNames[side.action]));
      result.append(list(items, item => el('span', [
        item?.display_name ?? item?.phrase ?? constraintKinds[item?.label] ?? (textOf(item) ||
          [constraintKinds[item?.kind], definitions.get(item?.definition_ref)].filter(Boolean).join(' · ')),
        item?.description, definitionStates[item?.definition_status], directionNames[item?.direction],
        objectLabel(item.content?.value, view),
        typeof item.content?.negated === 'boolean' ? (item.content.negated ? '否定记载' : '肯定记载') : null,
        knowledgeStates[item.state], textOf(item.world_time ?? item.valid_time)].filter(Boolean).join(' · ') || '相关知识记录'), '当前无列出的内容。'));
      return result;
    }
    columns.append(block('修改前', impactEntries(preview.before)), block('修改后', impactEntries(preview.after)));
    const impact = preview.impact;
    const indexed = impact?.index;
    const indexTotal = indexed && Object.values(indexed).every(Number.isFinite)
      ? Object.values(indexed).reduce((a, b) => a + b, 0) : null;
    const dimensions = Array.isArray(impact) ? impact.map(item =>
      [item.label, item.checked === false || item.count == null ? '未知' : item.count]) : [
      ['受影响实体', impact?.affected_entity_refs?.length ?? impact?.counts?.nodes],
      ['受影响陈述', impact?.affected_statement_refs?.length ?? impact?.counts?.statements],
      ['受影响来源', impact?.affected_source_refs?.length ?? impact?.counts?.sources],
      ['受影响事实', impact?.affected_fact_refs?.length], ['受影响定义', impact?.affected_definition_refs?.length],
      ['图中新增关系', impact?.graph?.added?.edges?.length], ['图中移出关系', impact?.graph?.removed?.edge_refs?.length],
      ['图中修改关系', impact?.graph?.edges_updated ?? impact?.graph?.updated?.edges?.length],
      ['索引变化记录', impact?.index?.documents_updated ?? indexTotal],
      ['尚未确认的影响项', impact?.unknown?.length || null],
    ].filter(([, value]) => value != null);
    const area = block('预计影响', fields(dimensions), columns);
    if (!dimensions.length) area.prepend(el('p', '影响尚未完整计算。', 'lw-muted'));
    if (preview.timeline_summary) area.append(el('p', preview.timeline_summary));
    if (preview.expires_at) area.append(el('p', '预览有效至 ' + dateLabel(preview.expires_at), 'lw-muted'));
    return area;
  }
  function intentFields(spec, target, detail, view) {
    const required = new Set(spec.required_fields ?? []);
    const sides = detail.sides ?? [];
    function control(label, node, required = true) {
      const group = el('label', label);
      node.required = required;
      group.append(node);
      target.append(group);
      return node;
    }
    function select(label, choices) {
      const node = control(label, el('select'));
      for (const [value, label] of [['', '请选择'], ...choices]) {
        const option = el('option', label);
        option.value = value;
        node.append(option);
      }
      return node;
    }
    const sidePicker = required.has('target_fact_version_ref') || required.has('proposed_world_time')
      ? select('要修订的记载', sides.filter(side => side.fact_version_ref).map((side, i) =>
        [side.fact_version_ref, [side.title ?? (i === 0 ? '一方记载' : '另一方记载'),
          typeof side.negated === 'boolean' ? (side.negated ? '否定' : '肯定') : null,
          textOf(side.subject), objectLabel(side.value, view), textOf(side.world_time)].filter(Boolean).join(' · ')]))
      : null;
    const evidence = new Map();
    if (required.has('evidence_refs')) {
      for (const [index, side] of sides.entries()) {
        for (const source of side.evidence ?? side.sources ?? side.source_refs ?? []) {
          const sourceRef = source?.source_ref ?? source;
          if (typeof sourceRef !== 'string' || !sourceRef || evidence.has(sourceRef)) continue;
          const node = el('input');
          node.type = 'checkbox';
          const label = el('label', source.title ?? (index === 0 ? '采用一方的原文作为依据' : '采用另一方的原文作为依据'));
          label.prepend(node);
          evidence.set(sourceRef, node);
          target.append(label);
        }
      }
    }
    const direction = required.has('relative_direction') ? select('两个表达的方向',
      (spec.allowed_directions ?? Object.keys(directionNames)).filter(value => Object.hasOwn(directionNames, value))
        .map(value => [value, directionNames[value]])) : null;
    const scopeKey = required.has('proposed_scope') ? control('适用范围名称', el('input')) : null;
    const scopeValue = scopeKey ? control('适用范围内容', el('input')) : null;
    const negated = required.has('proposed_content') ? select('修订后的表达', [['affirmed', '肯定'], ['negated', '否定']]) : null;
    const close = spec.kind === 'CLOSE_STATE';
    const precision = required.has('proposed_world_time')
      ? select('时间精度', [['YEAR', '年'], ['MONTH', '月'], ['DAY', '日'], ['MINUTE', '分钟'], ['EXACT', '完整时间点']]) : null;
    const time = precision ? control(close ? '结束时间' : '修订时间', el('input')) : null;
    const rawTime = precision ? control('原文或人工依据中的时间表达', el('input')) : null;
    if (time) {
      time.placeholder = '如 2026-06（月份）';
      target.append(el('p', '保留所选时间精度。完整时间点请注明时区。', 'lw-muted'));
    }
    return (reason, wholeForm) => {
      if (!spec.supported) return null;
      const intent = {};
      if (direction) intent.relative_direction = direction.value;
      const targetSide = sides.find(side => side.fact_version_ref === sidePicker?.value);
      if (sidePicker) intent.target_fact_version_ref = sidePicker.value;
      if (required.has('evidence_refs')) {
        intent.evidence_refs = [...evidence].filter(([, node]) => node.checked).map(([key]) => key);
        if (!intent.evidence_refs.length) { wholeForm.append(el('p', '请勾选至少一项原文依据。')); return null; }
        if (reviewDomain(detail) === 'IDENTITY' && sides.some(side =>
          !(side.evidence ?? side.sources ?? side.source_refs ?? []).some(source =>
            intent.evidence_refs.includes(source?.source_ref ?? source)))) {
          wholeForm.append(el('p', '请为双方各选择一项原文依据。'));
          return null;
        }
      }
      if (scopeKey) intent.proposed_scope = [[scopeKey.value.trim(), scopeValue.value.trim()]];
      if (negated) intent.proposed_content = { negated: negated.value === 'negated' };
      if (time) {
        const point = { value: time.value.trim(), raw: rawTime.value.trim(), precision: precision.value, basis: reason };
        const original = targetSide?.world_time;
        if (close && original?.kind === 'STATE') {
          intent.proposed_world_time = { ...original, end: { kind: 'EXACT', point } };
        } else if (original?.kind === 'EVENT') intent.proposed_world_time = { kind: 'EVENT', occurred_at: point };
        else if (original?.kind === 'STATE' || !original?.kind) {
          intent.proposed_world_time = { kind: 'STATE', start: point, end: original?.end ?? { kind: 'OPEN_AS_REPORTED' } };
        } else {
          wholeForm.append(el('p', '此时间形状需要完整的起止依据，请选择适用的处理方式。'));
          return null;
        }
      }
      return intent;
    };
  }
  async function renderReview(parent, view, active) {
    const reviewRef = route.item;
    const path = '/reviews/' + ref(reviewRef);
    let detail = await readBound(path, view);
    if (!active()) return;
    const domain = reviewDomain(detail);
    const recovered = detail.decision_ref && detail.decision_ref === receipt?.decision_ref ? receipt : null;
    const saved = receipts.get(reviewRef) ?? detail.decision_receipt ?? recovered ?? (detail.decision ? {
      ...detail.decision, review_status: detail.review_status, decision_status: detail.decision.status,
    } : null);
    if (saved && receipt !== saved) { receipt = saved; job = undefined; invalidate('receipt'); }
    const area = block(detail.question ?? detail.title ?? '查看双方记载');
    parent.append(button('返回事项列表', () => go('reviews')), area);
    if (domain) area.prepend(el('p', reviewDomains[domain], 'lw-muted'));
    const identity = domain === 'IDENTITY';
    const identitySummary = el('div', null, 'lw-review-comparison');
    function showIdentitySummary(item) {
      const model = identityReviewSummary(item);
      identitySummary.replaceChildren(fields([
        ['模型建议', model.judgment ?? '暂无可展示的模型建议'],
        ['模型把握度', model.confidence ?? model.confidence_note],
        ['建议依据', model.reason],
        ['程序采用说明', model.adoption],
      ]));
    }
    if (identity) {
      showIdentitySummary(detail);
      area.append(identitySummary);
    } else if (detail.conflict_reason ?? detail.reason) {
      area.append(el('p', detail.conflict_reason ?? detail.reason, 'pg-statement'));
    }
    const diffLabels = { subject: '主体', value: '对象或值', label: '名称', description: '含义',
      raw_properties: '资料中的表达', scope: '适用范围', world_time: '原文时间', negated: '是否否定' };
    const differences = Array.isArray(detail.differences) ? detail.differences : Object.entries(detail.differences ?? {}).map(
      ([key, pair]) => ({ label: diffLabels[key], before: pair?.[0], after: pair?.[1] })).filter(diff => diff.label);
    if (differences.length) area.append(block('可比差异', list(differences, diff => {
      const row = el('div', null, 'pg-diff');
      row.append(el('strong', diff.label), el('span', objectLabel(diff.before, view) || '未注明'),
        el('span', objectLabel(diff.after, view) || '未注明'));
      return row;
    })));
    const pair = el('div', null, identity ? 'pg-pair lw-review-sides' : 'pg-pair');
    const status = el('div', null, 'pg-review-status');
    status.setAttribute('role', 'status');
    area.append(pair, status);
    const compare = identity ? identityComparisonContext(detail) : null;
    const sides = await Promise.all((detail.sides ?? []).map((side, index) => reviewSide(side, index, view, domain, compare)));
    if (!active()) return;
    pair.append(...sides.map(side => side.pane));
    const canCompare = sides.length >= 2 && sides.every(side => side.readable);
    const controls = el('div');
    area.append(controls);
    reviewFlow = { status, controls, reviewRef, view, current: saved };
    activePanel = area;
    updateReviewStatus();
    if (readOnly(view) || detail.read_only) {
      controls.append(el('p', detail.review_eligibility?.reason ?? '此事项当前以只读方式显示。', 'lw-muted'),
        button('在当前版本核对事项', () => navigate({ item: reviewRef, pin: null, asOf: null })));
      return;
    }
    if (saved || detail.review_status === 'DECIDED') return;
    const unavailable = identity ? identityReviewUnavailable(detail, head?.capabilities, { fixture: descriptor.fixture === true }) : null;
    if (unavailable) {
      controls.append(el('p', unavailable, 'lw-muted'),
        button('重新读取事项', () => { readCache.clear(); activePanel = renderKey = undefined; render(); }));
      return;
    }
    if (!canCompare) {
      controls.append(el('p', '双方原文依据暂不完整，核对后再作判断。'),
        button('重新读取双方依据', () => { readCache.clear(); activePanel = renderKey = undefined; render(); }));
      return;
    }
    let actions = reviewActionSpecs(detail);
    if (!actions.length) {
      controls.append(el('p', '此事项当前没有可执行的处理方式。', 'lw-muted'));
      return;
    }
    const form = el('form', null, 'pg-form');
    const selectLabel = el('label', '处理方式');
    const select = el('select');
    select.required = true;
    const actionButtons = identity && compare.exactContract ? el('div', null, 'lw-inline-actions') : null;
    if (actionButtons) {
      actionButtons.setAttribute('role', 'group');
      actionButtons.setAttribute('aria-label', '处理方式');
      selectLabel.hidden = true;
    }
    function drawActions() {
      select.replaceChildren(el('option', '请选择处理方式'));
      select.options[0].value = '';
      actionButtons?.replaceChildren();
      for (const action of actions) {
        const label = actionNames[action.kind] ? action.label ?? actionNames[action.kind] : '此版本暂不支持的处理方式';
        const option = el('option', label + (action.supported ? '' : ' · 不可用'));
        option.value = action.kind;
        option.disabled = !action.supported;
        select.append(option);
        if (actionButtons && action.supported) {
          const choice = button(label, () => {
            select.value = action.kind;
            select.dispatchEvent(new Event('change'));
          });
          choice.dataset.identityAction = action.kind;
          choice.setAttribute('aria-pressed', 'false');
          actionButtons.append(choice);
        }
      }
    }
    drawActions();
    selectLabel.append(select);
    const inputs = el('div', null, 'pg-form');
    const reasonLabel = el('label', '处理理由');
    const reason = el('textarea');
    reasonLabel.append(reason, el('small', '修订依据会随处理决定保留。', 'lw-muted'));
    const submit = el('button', '预览变化', 'lw-button primary');
    submit.disabled = true;
    const previewRegion = el('div');
    previewRegion.setAttribute('aria-live', 'polite');
    let readIntent, preview, requestInProgress = false, inputVersion = 0;
    form.append(selectLabel);
    if (actionButtons) form.append(actionButtons);
    form.append(inputs, reasonLabel, submit, previewRegion);
    controls.append(form);
    const flow = reviewFlow;
    function clearPreview() {
      inputVersion++;
      preview = undefined;
      previewRegion.replaceChildren();
    }
    select.addEventListener('change', () => {
      clearPreview();
      inputs.replaceChildren();
      for (const choice of actionButtons?.children ?? []) {
        choice.setAttribute('aria-pressed', String(choice.dataset.identityAction === select.value));
      }
      const spec = actions.find(action => action.kind === select.value);
      submit.textContent = spec?.kind === 'DEFER' ? (actionButtons ? '确认暂不处理' : '暂不处理') : '预览变化';
      reason.required = Boolean(spec && (spec.kind !== 'DEFER' || spec.required_fields?.includes('reason')));
      submit.disabled = !spec?.supported || requestInProgress;
      readIntent = spec?.supported ? intentFields(spec, inputs, detail, flow.view) : undefined;
    });
    form.addEventListener('input', event => { if (event.target !== select) clearPreview(); });
    async function refreshBase() {
      try {
        const client = api;
        const manifest = confirmedManifest(await client.head());
        if (!manifest || !form.isConnected || client !== api) return false;
        const fresh = await client.resolve({ at: route.at });
        if (!form.isConnected || client !== api) return false;
        readCache.clear();
        const item = await readBound(path, fresh);
        if (!form.isConnected || !fresh.resolved_scope || fresh.view_revision !== manifest.view_revision) return false;
        if (item.review_status !== 'OPEN' && item.review_status !== 'DEFERRED') {
          previewRegion.replaceChildren(el('p', '此事项已有处理记录，请返回列表核对。'));
          invalidate('review_changed');
          return false;
        }
        const unavailableAfterRefresh = identity && identityReviewUnavailable(item, head?.capabilities,
          { fixture: descriptor.fixture === true });
        if (unavailableAfterRefresh) {
          submit.disabled = true;
          previewRegion.replaceChildren(el('p', unavailableAfterRefresh));
          return false;
        }
        const comparison = identity ? identityComparisonContext(item) : null;
        const newSides = await Promise.all((item.sides ?? []).map((side, index) => reviewSide(side, index, fresh, domain, comparison)));
        if (!form.isConnected || newSides.length < 2 || newSides.some(side => !side.readable) ||
            item.read_only || reviewDomain(item) !== domain) {
          submit.disabled = true;
          return false;
        }
        const refreshedActions = reviewActionSpecs(item);
        const prior = actions.find(action => action.kind === select.value);
        const next = refreshedActions.find(action => action.kind === select.value);
        const changed = JSON.stringify(prior) !== JSON.stringify(next) ||
          JSON.stringify(detail.sides) !== JSON.stringify(item.sides);
        pair.replaceChildren(...newSides.map(side => side.pane));
        if (identity) showIdentitySummary(item);
        flow.view = fresh;
        detail = item;
        actions = refreshedActions;
        if (changed) {
          drawActions();
          select.dispatchEvent(new Event('change'));
        }
        previewRegion.replaceChildren(el('p', changed ? '双方依据或处理方式已变化，请重新选择。' :
          '已读取更新后的双方依据。请核对输入后重新预览。'));
        return true;
      } catch (error) {
        if (form.isConnected) previewRegion.replaceChildren(errorPanel(error, refreshBase));
        return false;
      }
    }
    function stalePrompt(expired = false) {
      preview = undefined;
      previewRegion.replaceChildren(el('p', expired ? '影响预览已过期，请重新预览。' : '相关知识已更新，请重新预览。'), button('重读当前事项', refreshBase));
    }
    flow.stale = () => {
      if (preview && flow.view.view_revision !== confirmedManifest(head)?.view_revision) stalePrompt();
    };
    async function save(body, confirm) {
      if (requestInProgress || confirm.disabled || !form.isConnected) return;
      const unavailableNow = identity && identityReviewUnavailable(detail, head?.capabilities,
        { fixture: descriptor.fixture === true });
      if (unavailableNow) {
        previewRegion.replaceChildren(el('p', unavailableNow));
        return;
      }
      const client = api;
      requestInProgress = true;
      confirm.disabled = submit.disabled = true;
      status.textContent = '正在保存处理决定';
      try {
        const result = await client.post(path + '/decisions', body);
        if (client !== api) return;
        receipt = result;
        timestamps('decision_saved', { has_job: Boolean(result.job_ref) });
        job = undefined;
        receipts.set(reviewRef, result);
        if (form.isConnected && reviewFlow === flow) {
          flow.current = result;
          controls.replaceChildren();
          updateReviewStatus();
        }
        invalidate('saved');
      } catch (error) {
        if (client !== api) return;
        if (!error.status || error.status >= 500) {
          const unknown = { unknown: true, client_operation_ref: body.client_operation_ref };
          receipts.set(reviewRef, unknown);
          receipt = unknown;
          if (form.isConnected) {
            flow.current = unknown;
            controls.replaceChildren();
            updateReviewStatus();
          }
          invalidate('unknown_save');
        } else if (form.isConnected) {
          status.textContent = '';
          if (staleCodes.has(error.code)) stalePrompt(error.code === 'PREVIEW_EXPIRED');
          else previewRegion.replaceChildren(errorPanel(error));
          submit.disabled = false;
        }
      } finally { requestInProgress = false; }
    }
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (requestInProgress || submit.disabled || !readIntent) return;
      const spec = actions.find(action => action.kind === select.value);
      if (!spec?.supported) return;
      const unavailableNow = identity && identityReviewUnavailable(detail, head?.capabilities,
        { fixture: descriptor.fixture === true });
      if (unavailableNow) { previewRegion.replaceChildren(el('p', unavailableNow)); return; }
      if (flow.view.view_revision !== confirmedManifest(head)?.view_revision) { stalePrompt(); return; }
      const defer = spec.kind === 'DEFER';
      previewRegion.replaceChildren();
      const parsed = readIntent(reason.value.trim(), previewRegion);
      if (!parsed) {
        if (!previewRegion.childElementCount) previewRegion.append(el('p', '此处理方式的输入暂不可用。'));
        return;
      }
      const body = { contract: 'ontoweave-decision-request/1', target_kind: defer ? 'REVIEW' : domain,
        review_ref: reviewRef, base_view_revision: flow.view.view_revision, client_operation_ref: operationId(),
        intent: { ...parsed, kind: spec.kind, reason: reason.value.trim() } };
      if (defer) { void save(body, submit); return; }
      requestInProgress = true;
      submit.disabled = true;
      const version = inputVersion;
      const client = api;
      try {
        const result = await client.post(path + '/preview', body);
        if (!form.isConnected || version !== inputVersion || client !== api) return;
        if (!result.preview_ref || result.base_view_revision !== body.base_view_revision) throw new Error('Invalid preview');
        if (body.base_view_revision !== confirmedManifest(head)?.view_revision) { stalePrompt(); return; }
        preview = result;
        const confirm = button('确认并更新', event => {
          if (!preview) return;
          if (Number.isFinite(Date.parse(result.expires_at)) && Date.parse(result.expires_at) <= Date.now()) {
            stalePrompt(true);
            return;
          }
          void save({ ...body, preview_ref: result.preview_ref }, event.currentTarget);
        }, true);
        confirm.disabled = result.can_confirm === false;
        previewRegion.replaceChildren(impactBlock(result, flow.view), confirm);
      } catch (error) {
        if (form.isConnected && version === inputVersion) {
          if (staleCodes.has(error.code)) stalePrompt(error.code === 'PREVIEW_EXPIRED');
          else previewRegion.replaceChildren(errorPanel(error));
        }
      } finally {
        requestInProgress = false;
        if (form.isConnected) submit.disabled = !actions.some(action => action.kind === select.value && action.supported);
      }
    });
  }

  function updateReviewStatus() {
    if (!reviewFlow) return;
    const flow = reviewFlow;
    flow.stale?.();
    if (!flow.current) return;
    const state = receiptState(flow.current, flow.current === receipt ? job : null,
      confirmedManifest(head), lastReady?.view.view_revision);
    const key = state + ':' + changeRef;
    if (flow.statusKey === key) return;
    flow.statusKey = key;
    flow.status.replaceChildren(el('p', state));
    if (state === '处理已应用' && changeRef) {
      flow.status.append(button('查看本次变化', () => go('change', changeRef)));
      timestamps('decision_applied', { view_revision: lastReady.view.view_revision, change_ref: changeRef });
    }
    if (flow.current.unknown) flow.status.append(button('核对处理结果', async () => {
      try {
        readCache.clear();
        const result = await readBound('/reviews/' + ref(flow.reviewRef), flow.view,
          { client_operation_ref: flow.current.client_operation_ref });
        if (reviewFlow !== flow) return;
        if (result.decision_receipt?.client_operation_ref === flow.current.client_operation_ref) {
          receipt = flow.current = result.decision_receipt;
          receipts.set(flow.reviewRef, receipt);
          job = undefined;
        }
        invalidate('receipt_readback');
      } catch { invalidate('receipt_readback'); }
    }));
  }

  async function renderChange(parent, view, active) {
    const change = await readBound('/changes/' + ref(route.item), view);
    if (!active()) return;
    const area = block(change.title ?? '本次变化', impactBlock(change, view), sourceButtons(change.source_refs, view));
    parent.append(area);
    const actions = el('div', null, 'pg-actions');
    actions.append(button('查看图中变化', () => go('graph')));
    if (change.from) actions.append(button('查看修改前的版本', () => go('graph', null, change.from)));
    area.append(actions);
    const available = change.available_actions ?? [];
    if (!change.decision_ref || !available.includes('REVERT') || readOnly(view)) return;
    const path = '/decisions/' + ref(change.decision_ref);
    const reason = el('textarea');
    reason.required = true;
    const label = el('label', '撤销理由');
    label.append(reason);
    const form = el('form', null, 'pg-form');
    const submit = el('button', '预览撤销影响', 'lw-button');
    const result = el('div');
    result.setAttribute('role', 'status');
    form.append(label, submit, result);
    area.append(form);
    activePanel = area;
    revertFlow = { result, view };
    reason.addEventListener('input', () => result.replaceChildren());
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const explanation = reason.value.trim();
      if (!explanation || submit.disabled) return;
      if (readOnly(view)) { result.textContent = '已有新版，请重新读取后再预览。'; return; }
      const request = { base_view_revision: view.view_revision, reason: explanation, client_operation_ref: operationId() };
      submit.disabled = true;
      try {
        const preview = await api.post(path + '/revert-preview', request);
        if (!active() || explanation !== reason.value.trim()) return;
        if (!preview.preview_ref || preview.base_view_revision !== view.view_revision) throw new Error('Invalid revert preview');
        const confirm = button('确认撤销并更新', async event => {
          const control = event.currentTarget;
          if (control.disabled) return;
          if (readOnly(view)) { result.textContent = '已有新版，请重新读取后再预览。'; return; }
          control.disabled = submit.disabled = true;
          const client = api;
          try {
            const saved = await client.post(path + '/revert', { ...request, preview_ref: preview.preview_ref });
            if (client !== api) return;
            receipt = saved;
            job = undefined;
            if (active() && revertFlow) { revertFlow.receipt = saved; updateRevertStatus(); }
            invalidate('revert_saved');
          } catch (error) {
            if (active()) {
              result.replaceChildren(el('p', !error.status || error.status >= 500 ? '撤销结果待确认。' : message(error)),
                button('核对处理结果', () => invalidate('user_read')));
              submit.disabled = !error.status || error.status >= 500;
            }
          }
        }, true);
        confirm.disabled = preview.can_confirm === false;
        result.replaceChildren(impactBlock(preview, view), confirm);
      } catch (error) {
        if (active()) result.replaceChildren(errorPanel(error));
      } finally { if (active()) submit.disabled = false; }
    });
  }

  function updateRevertStatus() {
    if (!revertFlow?.receipt) return;
    const state = receiptState(revertFlow.receipt, job, confirmedManifest(head), lastReady?.view.view_revision);
    if (state === revertFlow.state) return;
    revertFlow.state = state;
    revertFlow.result.replaceChildren(el('p', state === '处理已应用' ? '撤销已应用' : state));
    if (state === '处理已应用' && changeRef) revertFlow.result.append(button('查看撤销后的图谱', () => go('graph')));
  }

  async function chatApi(path, body) {
    const response = await fetch(path, {
      method:body === undefined ? 'GET' : 'POST',
      credentials:'same-origin', cache:'no-store', redirect:'error',
      headers:body === undefined ? {Accept:'application/json'} : {'Content-Type':'application/json',Accept:'application/json'},
      ...(body === undefined ? {} : {body:JSON.stringify(body)}),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) {
      throw Object.assign(Error('问答服务暂不可用'), {code:result?.error?.code, status:response.status});
    }
    return result;
  }

  function matchesChatScope(scope) {
    const pinned = chatPin?.query_read_view, candidate = scope?.query_read_view;
    return Boolean(pinned && candidate && ['library_ref','view_revision','business_manifest_sha256',
      'retrieval_index_revision','at','as_of'].every(key => pinned[key] === candidate[key]));
  }

  async function projectPgCitation(citation, scope, {historical}) {
    const view = scope.query_read_view, client = createPgApi(view.library_ref);
    const sources = await Promise.all((citation.source_targets ?? []).map(async target => {
      const quote = target.spans?.find(span => typeof span.quote === 'string' && span.offset_unit === 'unicode_codepoint');
      const base = {title:target.title, doc_ref:target.doc_ref, revision:target.revision,
                    source_ref:target.source_ref, quotes:[], available:false, precision:'DOCUMENT_ONLY'};
      try {
        const page = await client.get('/retrieval/sources/' + ref(target.source_ref), {
          view_revision:view.view_revision, index_descriptor_ref:view.index_descriptor_ref,
          start:quote?.start ?? 0, limit:quote ? quote.end - quote.start : 1,
        });
        const location = page.location;
        if (location.doc_ref !== target.doc_ref || location.document_revision !== target.revision ||
            location.parent_block_ref !== target.block_ref || page.view_revision !== view.view_revision) return base;
        if (quote && (page.text !== quote.quote || location.start !== quote.start || location.end !== quote.end)) return base;
        return {...base, available:true, quotes:quote ? [page.text] : [],
                precision:quote ? 'EXACT_SPAN' : 'BLOCK_ASSOCIATION',
                quote_start:quote?.start, quote_end:quote?.end};
      } catch {
        return base;
      }
    }));
    return {citation_ref:citation.citation_ref, label:citation.label, kind:citation.kind, historical,
            sources, knowledge_ids:historical ? [] : citation.knowledge_refs ?? [], entity_ids:[], relation_ids:[]};
  }

  async function renderAnswers(parent, view, active) {
    if (!descriptor.query_enabled) {
      parent.append(block(null, el('p', '当前知识库尚未提供同版本问答。'),
        button('在图谱中查看知识来源', () => go('graph'))));
      return;
    }
    const libraryId = route.library;
    const time = view.resolved_scope ?? {};
    const selection = new URLSearchParams(time.as_of ? {as_of:JSON.stringify({timestamp:time.as_of})}
                                                   : {view_revision:view.view_revision});
    if (time.at) selection.set('at', time.at);
    const path = '/api/product/libraries/' + ref(libraryId) + '/native-query/capabilities?';
    const availability = await chatApi(path + selection);
    if (!active()) return;
    const pin = availability.scope;
    const candidate = pin?.query_read_view;
    if (!availability.available || pin?.library_id !== libraryId || candidate?.view_revision !== view.view_revision
          || candidate.at !== (time.at ?? null) || candidate.as_of !== (time.as_of ?? null)
          || !candidate.retrieval_index_revision) {
      parent.append(block(null, el('p', '当前版本的检索索引尚未就绪。')));
      return;
    }
    chatPin = pin;
    const {createLightogChatWorkspace} = await import('./lightog-chat-workspace-v1.mjs');
    if (!active()) return;
    chatWorkspace ??= createLightogChatWorkspace({
      api:chatApi, matchesScope:matchesChatScope, projectCitation:projectPgCitation,
      canAsk:() => currentView()?.view_revision === chatPin?.query_read_view?.view_revision && route.page === 'answers',
      onOpenSource:({source,citation}) => {
        const pinned = citation.source_scope.query_read_view;
        const item = ['retrieval', source.source_ref, pinned.index_descriptor_ref, source.quote_start, source.quote_end].join('~');
        navigate({page:'source', item, pin:pinned.view_revision, asOf:null, at:pinned.at});
      },
      onOpenGraph:({kind,id,scope}) => {
        if (kind === 'knowledge') navigate({page:'knowledge',item:id,pin:scope.query_read_view.view_revision,
                                            asOf:null,at:scope.query_read_view.at});
      },
    });
    await chatWorkspace.attach({host:parent,libraryId,pin});
  }

  connectLibrary();
}
