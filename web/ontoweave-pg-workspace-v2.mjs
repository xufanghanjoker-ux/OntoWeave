import { lightogWorkspaceShell, control } from './unified-workbench-view-v2.mjs';
import { lightogReviewSideMarkup } from './lightog-correction-view-v1.mjs';
import { appliedPublication, applyGraphDelta, identityReviewSummary, identityReviewUnavailable, confirmedManifest, createPgApi, createPgRegistry, createPgModelSettings, matchingGraph, receiptState, ref, reviewActionSpecs, reviewDomain, shouldEnterFirstGraph, workspaceReadiness } from './ontoweave-pg-api-v2.mjs';

const pages = { graph: '图谱', documents: '资料', ontology: '本体', reviews: '待处理', answers: '问答',
  libraries: '工作空间', trash: '回收站', 'knowledge-list': '知识列表', settings: '设置', progress: '整理进度', review: '处理事项', knowledge: '知识详情', source: '原文', change: '本次变化' };
const stages = { RECEPTION: '资料接收', UNDERSTANDING: '内容整理', EXTRACTION: '知识提取',
  FACT_ROUTING: '关系整理', PUBLICATION: '生成图谱与检索' };
const stageAliases = { RECEIVE: 'RECEPTION', PARSING: 'UNDERSTANDING',
  UNDERSTAND: 'UNDERSTANDING', CHUNKING: 'UNDERSTANDING', BLOCK_CQ: 'EXTRACTION', CQ_SIMILARITY: 'EXTRACTION',
  ORGANIZE: 'EXTRACTION', IDENTITY: 'FACT_ROUTING', ONTOLOGY: 'FACT_ROUTING',
  IDENTITY_ONTOLOGY: 'FACT_ROUTING', ALIGN_ROUTE: 'FACT_ROUTING', PUBLISH: 'PUBLICATION' };
const stageLabels = { RECEPTION: '接收文件', PARSING: '读取文档', CHUNKING: '划分内容单元',
  EXTRACTION: '提取知识', IDENTITY: '识别实体', ONTOLOGY: '对齐本体',
  IDENTITY_ONTOLOGY: '身份与本体', FACT_ROUTING: '区分事实及待确认事项' };
const internalStages = new Set(['BLOCK_CQ', 'CQ_SIMILARITY']);
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
  const aliases = { sources: 'documents', upload: 'documents', pending: 'reviews', query: 'answers' };
  const target = Object.hasOwn(aliases, page) ? aliases[page] : page;
  const home = ['libraries','trash'].includes(target) || (!target && !library) || (target === 'settings' && !library);
  return { library: home ? null : library ?? fallback ?? null,
    page: home ? ['settings','trash'].includes(target) ? target : 'libraries' : Object.hasOwn(pages, target) ? target : null,
    item: search.get('item'), pin: search.get('view_revision'), at: search.get('at'), asOf: search.get('as_of'),
    focus: search.get('focus'), source: search.get('source_filter'),
    conversation: search.get('conversation'), query: search.get('query'), turn: search.get('turn') };
}
function routeHash(route) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries({ library: route.library, view: route.page, item: route.item,
    view_revision: route.pin, at: route.at, as_of: route.asOf, focus: route.focus, source_filter: route.source,
    conversation: route.conversation, query: route.query, turn: route.turn })) {
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

export function mountPgWorkspace({ root, boot, legacy = [], openLegacy }) {
  const descriptor = boot.ontoweave_pg;
  const registry = createPgRegistry({ token: boot.token });
  const modelSettings = createPgModelSettings({ token: boot.token });
  const libraries = new Map((descriptor.libraries ?? []).map(library => [library.library_ref, library]));
  const legacyById = new Map(legacy.map(entry => [entry.id, entry]));
  let defaultLibrary = libraries.has(descriptor.default_library_ref) ? descriptor.default_library_ref : libraries.keys().next().value;
  let createEnabled = descriptor.create_enabled === true;
  let creationPending;
  const createKey = 'ontoweave.pg.create-space';
  try { creationPending = JSON.parse(sessionStorage.getItem(createKey)); } catch {}
  let route = decodeRoute(defaultLibrary);
  if (!route.library && !route.page) route.page = 'libraries';
  let disposed = false, registryRevision = 0;
  let libraryAbort, stopStream, syncTimer, disconnectTimer, api;
  let epoch = 0, connected = false, interrupted = false, syncing = false, dirty = false;
  let head, lastReady, graphUpdate, displayed, build, loadError, initiated, selected, graphView, graphTools;
  let lastBuildRef, documentWriteBusy = false;
  let chatWorkspace, chatPin;
  let canvasKey, renderKey, pageVersion = 0, activePanel, viewError, pendingRead = false;
  let reviewFlow, revertFlow, correctionStatus, receipt, job, changeRef, uploadUnknown, receipts = new Map();
  let bannerKey, reviewRevision = 0, pollDelay = 1000;
  const scrollMemory = new Map(), historyParts = new Map();
  const historical = new Map(), contexts = new Map(), observedViews = new Map(), readCache = new Map();
  const timestamps = (name, details = {}) => root.dispatchEvent(new CustomEvent('ontoweave:ui', {
    bubbles: true, detail: { name, library_ref: route.library, milliseconds: performance.now(), ...details },
  }));

  root.innerHTML = lightogWorkspaceShell({ route }, {
    shellClass: 'pg-workspace', mainClass: 'pg-main',
    header: {
      library: '<button class="lw-button" data-lw-action="page" data-page="libraries">全部工作空间</button>' +
        '<select class="pg-library-select" aria-label="切换工作空间"></select>',
      actions: control('＋ 添加资料', 'page', 'data-page="documents"', 'primary') +
        control('设置', 'page', 'data-page="settings"'),
      navPages: { sources: 'documents', pending: 'reviews', query: 'answers' },
    },
    banner: '<div class="pg-banner"><span role="status"></span><div class="pg-actions"></div></div>',
    body: '<h1 tabindex="-1"></h1><div data-pg-content></div>',
  });
  const shell = root.firstElementChild;
  const nav = shell.querySelector('.lw-nav');
  const addDocuments = shell.querySelector('.lw-header-actions [data-page=documents]');
  const selector = shell.querySelector('.pg-library-select');
  function drawLibraries() {
    const entries = [...libraries].map(([key, entry]) => [key, entry.title ?? '知识库']);
    entries.push(...legacy.map(entry => [entry.id, entry.name]));
    selector.replaceChildren(...entries.map(([key, title]) => {
      const option = el('option', title);
      option.value = key;
      return option;
    }));
    selector.value = route.library ?? '';
    selector.hidden = !route.library || !entries.length;
  }
  drawLibraries();
  selector.addEventListener('change', () => {
    if (legacyById.has(selector.value)) openLegacy?.(selector.value);
    else navigate({ library: selector.value, page: null, pin: null, at: null, asOf: null, source: null });
  });
  if (descriptor.fixture === true) selector.after(el('span', '离线夹具', 'lw-tag'));
  shell.addEventListener('click', event => {
    const control = event.target.closest('[data-lw-action=page]');
    if (!control) return;
    const page = control.dataset.page;
    if (control.closest('.lw-nav')) {
      const sameCurrentDrilldown = ['source','knowledge'].includes(route.page) && !route.asOf &&
        route.pin === confirmedManifest(head)?.view_revision;
      navigate({ page, ...(sameCurrentDrilldown ? { pin: null } : {}) });
    }
    else navigate({ page, ...(['libraries','trash'].includes(page) ? { library: null, source: null } : {}), pin: null, at: null, asOf: null });
  });
  const navButtons = new Map([...shell.querySelectorAll('.lw-nav button')].map(link => [link.dataset.page, link]));
  const live = shell.querySelector('.pg-banner [role=status]');
  const bannerActions = shell.querySelector('.pg-banner .pg-actions');
  const heading = shell.querySelector('.pg-main h1');
  const content = shell.querySelector('[data-pg-content]');
  const dialog = el('dialog', null, 'pg-dialog');
  dialog.setAttribute('aria-label', '原文预览');
  let opener;
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    dialog.replaceChildren();
    opener?.focus();
    opener = undefined;
  });
  shell.append(dialog);

  async function refreshRegistry() {
    const revision = registryRevision;
    const result = await registry.list();
    if (disposed || revision !== registryRevision || !Array.isArray(result.items)) return;
    libraries.clear();
    for (const row of result.items) {
      if (row.backend === 'PG' && row.library_ref) libraries.set(row.library_ref, row);
    }
    defaultLibrary = result.default_library_ref ?? libraries.keys().next().value;
    createEnabled = result.create_enabled === true;
    drawLibraries();
  }

  function saveCreation(value) {
    creationPending = value;
    try {
      if (value) sessionStorage.setItem(createKey, JSON.stringify(value));
      else sessionStorage.removeItem(createKey);
    } catch {}
  }

  function canManageSpace(entry, action) {
    return entry?.workspace_revision != null && (!entry.available_actions || entry.available_actions.includes(action));
  }

  function manageSpace(entry, action, control, refresh) {
    const actionTitle = { RENAME: '重命名工作空间', ARCHIVE: '移入回收站', RESTORE: '恢复工作空间' }[action];
    opener = control;
    const form = el('form', null, 'pg-space-form');
    const status = el('p');
    status.setAttribute('role', 'status');
    const title = el('input');
    title.required = action === 'RENAME';
    title.value = entry.title;
    if (action === 'RENAME') {
      const label = el('label', '工作空间名称');
      label.append(title);
      form.append(label);
    } else form.append(el('p', action === 'ARCHIVE' ?
      '将「' + entry.title + '」移入回收站？资料、历史图和已保存答案会保留。' :
      '恢复「' + entry.title + '」后，可从工作空间列表再次打开。'));
    const submit = el('button', actionTitle, 'lw-button primary');
    submit.type = 'submit';
    const cancel = button('取消', () => dialog.close());
    form.append(el('div', null, 'pg-actions'), status);
    form.querySelector('.pg-actions').append(submit, cancel);
    dialog.setAttribute('aria-label', actionTitle);
    dialog.replaceChildren(block(actionTitle, form));
    if (!dialog.open) dialog.showModal();
    if (action === 'RENAME') title.focus();
    let operation;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (submit.disabled) return;
      const name = title.value.trim();
      if (action === 'RENAME' && (!name || Array.from(name).length > 80)) {
        status.textContent = '请输入 1 到 80 个字的名称。';
        return;
      }
      operation ??= { action, expected_workspace_revision: entry.workspace_revision, client_operation_ref: operationId(),
        ...(action === 'RENAME' ? { title: name } : {}) };
      submit.disabled = cancel.disabled = title.readOnly = true;
      status.textContent = '正在保存';
      try {
        const result = await registry.lifecycle(entry.library_ref, operation);
        const state = action === 'ARCHIVE' ? 'ARCHIVED' : 'ACTIVE';
        if (result.library_ref !== entry.library_ref || result.workspace_state !== state ||
            result.workspace_revision == null || (action === 'RENAME' && result.title !== operation.title)) {
          throw new Error('WORKSPACE_LIFECYCLE_UNCONFIRMED');
        }
        registryRevision++;
        if (state === 'ARCHIVED') libraries.delete(entry.library_ref);
        else libraries.set(result.library_ref, result);
        drawLibraries();
        if (form.isConnected) {
          dialog.close();
          refresh(action === 'RENAME' ? '名称已更新' : action === 'ARCHIVE' ? '已移入回收站' : '已恢复工作空间');
        }
      } catch (error) {
        if (!form.isConnected) return;
        cancel.disabled = false;
        if (error.status === 409) {
          status.textContent = '工作空间状态已变化。请关闭并读取最新列表后再试。';
          refresh();
          return;
        }
        if (error.status >= 400 && error.status < 500) {
          operation = null;
          title.readOnly = false;
          status.textContent = '操作未获受理。请核对当前状态。';
        } else {
          status.textContent = '结果待核对。再次确认会沿用原操作。';
          submit.textContent = '核对操作结果';
        }
        submit.disabled = false;
      }
    });
  }

  function renderTrash() {
    const diagnostics = el('div');
    const items = el('div', null, 'lw-libraries');
    const state = el('p');
    state.setAttribute('role', 'status');
    content.append(button('返回工作空间', () => navigate({ page: 'libraries', library: null })),
      el('p', '移入回收站的工作空间可以恢复。'), state, diagnostics, items);
    async function load(message) {
      if (message) state.textContent = message;
      try {
        const packet = await registry.list('ARCHIVED');
        if (!items.isConnected) return;
        items.replaceChildren(...(packet.items ?? []).filter(entry => entry.workspace_state === 'ARCHIVED').map(entry => {
          const card = block(entry.title);
          if (canManageSpace(entry,'RESTORE')) card.append(button('恢复工作空间', event =>
            manageSpace(entry, 'RESTORE', event.currentTarget, load)));
          return card;
        }));
        if (!items.childElementCount) items.append(el('p', '回收站没有工作空间。', 'lw-muted'));
        diagnostics.replaceChildren();
      } catch (error) { if (items.isConnected) diagnostics.replaceChildren(errorPanel(error, () => void load())); }
    }
    void load();
  }

  function renderLibraries() {
    const linkList = el('div', null, 'lw-libraries');
    const outcome = el('p');
    outcome.setAttribute('role', 'status');
    const trash = button('回收站', () => navigate({ page: 'trash', library: null }));
    function draw() {
      const pg = [...libraries].map(([key, entry]) => {
        const registered = entry.registration_status !== 'UNAVAILABLE';
        const link = button('', () => navigate({ library: key, page: null, pin: null, at: null, asOf: null }));
        link.textContent = registered ? '打开工作空间' : '空间准备中，暂不可用';
        link.setAttribute('aria-label', '打开工作空间 ' + entry.title);
        link.disabled = !registered;
        const actions = el('div', null, 'pg-actions');
        actions.append(link);
        for (const [action,label] of [['RENAME','重命名'],['ARCHIVE','移入回收站']]) {
          if (canManageSpace(entry,action)) actions.append(button(label,event => manageSpace(entry,action,event.currentTarget,refresh)));
        }
        return block(entry.title, actions);
      });
      const old = legacy.map(entry => {
        const link = button('', () => openLegacy?.(entry.id));
        link.append(el('h2', entry.name), el('p', '已有知识空间'));
        return link;
      });
      linkList.replaceChildren(...pg, ...old);
    }
    draw();
    const diagnostics = el('div');
    const form = el('form', null, 'pg-space-form');
    const label = el('label', '工作空间名称');
    const title = el('input');
    title.name = 'title';
    title.required = true;
    title.autocomplete = 'off';
    title.value = creationPending?.title ?? '';
    title.readOnly = Boolean(creationPending);
    label.append(title);
    const submit = el('button', creationPending ? '核对创建结果' : '创建工作空间', 'lw-button primary');
    submit.type = 'submit';
    const status = el('p');
    status.setAttribute('role', 'status');
    form.append(label, submit, status);
    form.hidden = !createEnabled;
    const showError = error => diagnostics.replaceChildren(errorPanel(error, () => { void read(); }));
    async function read() {
      try {
        await refreshRegistry();
        if (!linkList.isConnected) return;
        create.hidden = !createEnabled || Boolean(creationPending);
        if (!createEnabled) form.hidden = true;
        draw();
        diagnostics.replaceChildren();
      } catch (error) { if (linkList.isConnected) showError(error); }
    }
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (submit.disabled) return;
      const name = title.value.trim();
      if (!name || Array.from(name).length > 80) {
        status.textContent = '请输入 1 到 80 个字的名称。';
        title.focus();
        return;
      }
      const payload = creationPending ?? { title: name, client_operation_ref: operationId() };
      saveCreation(payload);
      submit.disabled = true;
      title.readOnly = true;
      status.textContent = '正在准备工作空间';
      try {
        const saved = await registry.create(payload);
        if (disposed) return;
        if (saved.backend !== 'PG' || saved.registration_status !== 'READY' || !saved.library_ref) {
          throw new Error('LIBRARY_REGISTRATION_UNCONFIRMED');
        }
        registryRevision++;
        libraries.set(saved.library_ref, saved);
        defaultLibrary ??= saved.library_ref;
        saveCreation(null);
        drawLibraries();
        if (form.isConnected) navigate({ library: saved.library_ref, page: 'documents', pin: null, at: null, asOf: null });
      } catch (error) {
        if (!form.isConnected) return;
        if (error.status === 422) {
          saveCreation(null);
          title.readOnly = false;
          submit.textContent = '创建工作空间';
          status.textContent = '名称未通过校验，请检查后再试。';
        } else {
          submit.textContent = '核对创建结果';
          status.textContent = '空间创建结果待核对。';
          void read();
        }
        submit.disabled = false;
      }
    });
    const create = button('＋ 新建工作空间', () => { form.hidden = false; activePanel = form; title.focus(); }, true);
    create.hidden = !createEnabled || Boolean(creationPending);
    if (!creationPending) form.hidden = true;
    function refresh(message) {
      if (message) outcome.textContent = message;
      draw();
      void read();
    }
    const actions = el('div', null, 'pg-actions');
    actions.append(create, trash);
    content.append(actions, form, outcome, diagnostics, linkList);
    if (descriptor.create_enabled === true) void read();
  }

  function renderSettings() {
    const summary = el('div');
    const editor = el('div');
    const status = el('div');
    status.setAttribute('role', 'status');
    content.append(block('受管模型', summary, editor, status));
    const roles = [['generation', '整理模型'], ['embedding', '原文索引模型'], ['reranker', '检索重排模型（可选）']];
    function drawModels(models, packet) {
      summary.replaceChildren(models ? fields([
        ...(packet ? [['服务', packet.provider === 'QWEN_BEIJING' ? '千问 · 北京' : '本地模拟'],
          ['模型凭据', packet.credential_configured ? '已配置' : '未配置']] : []),
        ...roles.map(([role, label]) => [label, models[role]?.configured === true ? models[role].model ?? '已配置' : '未配置']),
      ]) : el('p', '正在读取受管模型状态。', 'lw-muted'));
    }
    drawModels(head?.capabilities?.models ?? libraries.get(route.library)?.capabilities?.models);
    async function load() {
      try {
        const packet = await modelSettings.status();
        if (!summary.isConnected) return;
        drawModels(packet.models, packet);
        if (packet.can_save !== true) return;
        const form = el('form', null, 'pg-form');
        const label = el('label', '模型 API Key');
        const key = el('input');
        key.type = 'password';
        key.autocomplete = 'off';
        key.required = true;
        key.maxLength = 4096;
        label.append(key);
        const save = el('button', '保存模型凭据', 'lw-button primary');
        save.type = 'submit';
        form.append(label, save);
        editor.replaceChildren(form);
        key.addEventListener('input', () => { activePanel = form; });
        form.addEventListener('submit', async event => {
          event.preventDefault();
          if (save.disabled || !key.value.trim()) return;
          save.disabled = true;
          const pending = modelSettings.save(key.value.trim());
          key.value = '';
          status.textContent = '正在保存模型凭据';
          try {
            const saved = await pending;
            if (!editor.isConnected) return;
            if (!saved.credential_configured) throw new Error('MODEL_SETTINGS_SAVE_UNCONFIRMED');
            drawModels(saved.models, saved);
            status.textContent = '模型凭据已保存';
            invalidate('models_saved');
          } catch (error) {
            if (!editor.isConnected) return;
            status.textContent = error.status === 409 ? '有整理或发布任务正在执行，请结束后重新输入凭据。' :
              error.status >= 400 && error.status < 500 ? '凭据未通过校验，请重新输入。' :
                '保存结果待确认。可以重新读取配置状态。';
            if (!error.status || error.status >= 500) status.append(button('读取配置状态', () => void load()));
          } finally {
            save.disabled = false;
          }
        });
      } catch (error) {
        if (!summary.isConnected) return;
        status.replaceChildren(error.status === 404
          ? el('p', '当前服务未开放模型凭据管理。', 'lw-muted')
          : errorPanel(error, () => void load()));
      }
    }
    void load();
  }

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
    const target = { ...route, item: null, focus: null, ...next };
    if (target.library !== previous.library) target.conversation = target.query = target.turn = null;
    if (routeHash(target) !== location.hash) {
      const method = replace ? 'replaceState' : 'pushState';
      history[method](null, '', routeHash(target));
    }
    route = target;
    setRoute(previous, focus);
  }
  function onLocationChange() {
    const target = decodeRoute(defaultLibrary);
    if (legacyById.has(target.library) || routeHash(target) === routeHash(route)) return;
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
    if (previous.page !== route.page || previous.item !== route.item || previous.focus !== route.focus ||
        previous.source !== route.source || (route.page === 'answers' &&
        (previous.conversation !== route.conversation || previous.query !== route.query || previous.turn !== route.turn)) ||
        scopeChanged(previous, route)) {
      if (dialog.open) dialog.close();
      rememberCanvas();
      viewError = undefined;
      reviewFlow = undefined;
      revertFlow = undefined;
      correctionStatus = undefined;
      activePanel = undefined;
      renderKey = undefined;
      if (scopeChanged(previous, route)) {
        displayed = route.pin || route.asOf || route.at ? undefined : lastReady;
      }
    }
    render(focus);
    invalidate('navigate');
  }
  const scopeChanged = (a, b) => a.pin !== b.pin || a.asOf !== b.asOf || a.at !== b.at;
  function ownsUploadProgress(marker) {
    return marker?.library === route.library && route.page === 'progress' && !route.pin && !route.asOf &&
      Boolean(marker.run) && marker.run === route.item;
  }
  function pendingUpload(value) {
    const key = 'ontoweave.pg.pending-upload:' + route.library;
    try {
      if (value === undefined) return JSON.parse(sessionStorage.getItem(key));
      if (value === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }
  function connectLibrary() {
    epoch++;
    libraryAbort?.abort();
    clearTimeout(syncTimer);
    syncTimer = undefined;
    clearTimeout(disconnectTimer);
    stopStream?.();
    stopStream = undefined;
    if (dialog.open) dialog.close();
    rememberCanvas();
    libraryAbort = new AbortController();
    api = route.library ? createPgApi(route.library, { token: boot.token, signal: libraryAbort.signal }) : null;
    selector.value = route.library ?? '';
    head = lastReady = graphUpdate = displayed = build = loadError = selected = lastBuildRef = undefined;
    const marker = readUploadProgress();
    initiated = ownsUploadProgress(marker) ? { ...marker, used: false } : undefined;
    if (!initiated && marker) saveUploadProgress(null);
    reviewFlow = revertFlow = correctionStatus = receipt = job = changeRef = viewError = uploadUnknown = undefined;
    receipts = new Map();
    documentWriteBusy = false;
    uploadUnknown = pendingUpload();
    pollDelay = 1000;
    readCache.clear();
    historical.clear();
    observedViews.clear();
    activePanel = renderKey = undefined;
    interrupted = connected = syncing = dirty = false;
    render();
    if (!api) return;
    stopStream = api.subscribe({ invalidate, connection(value) { connected = value; interrupted = !value; paintBanner(); } });
    invalidate('initial');
  }
  function invalidate(reason) {
    if (!api || disposed) return;
    dirty = true;
    if (!['poll', 'queued', 'disconnected'].includes(reason)) pollDelay = 1000;
    if (document.hidden) return;
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
      if (uploadUnknown && activeRun && activeRun !== uploadUnknown.priorRun &&
          (head.current_build?.client_operation_ref === uploadUnknown.operation ||
           (!uploadUnknown.base && head.capabilities?.initial_upload_only === true))) {
        uploadUnknown = undefined;
        pendingUpload(null);
        if (route.page === 'documents') { activePanel = undefined; renderKey = undefined; }
      }
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
      const applied = appliedPublication(receipt, job);
      if (applied?.target_view_revision === nextManifest?.view_revision &&
          applied?.target_view_revision === lastReady?.view.view_revision) changeRef = applied?.change_ref;
      else if (previous?.view.view_revision !== lastReady?.view.view_revision) changeRef = undefined;
      if (!route.page) {
        navigate({ page: lastReady ? 'graph' : run ? 'progress' : 'documents', item: lastReady ? null : run }, { replace: true, focus: false });
      } else if (lastReady && shouldEnterFirstGraph({ route, initiated, head,
        resolved: lastReady.view, graph: lastReady.data, build })) {
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
          if (!document.hidden) disconnectTimer = setTimeout(() => invalidate('poll'), pollDelay);
          pollDelay = Math.min(pollDelay * 2, 8000);
        }
        if (dirty) invalidate('queued');
      }
    }
  }

  function paintBanner() {
    const readiness = workspaceReadiness(head);
    const { manifest, vector } = readiness;
    const target = head?.target_publication?.publication_status;
    const ready = Boolean(lastReady);
    const progress = build?.execution_status ?? readiness.execution;
    let status = '正在读取知识库';
    if (loadError && !ready && !manifest) status = '知识库暂时无法读取';
    else if (loadError || (manifest && manifest.view_revision !== lastReady?.view.view_revision)) status = ready ? '新版正在读取 · 上一版仍可使用' : '正在读取已发布图谱';
    else if (target === 'UNKNOWN_HOLD' || progress === 'UNKNOWN_HOLD') status = '处理结果待确认，已保存内容保留';
    else if (target === 'FAILED' || progress === 'FAILED') status = ready ? '本次发布未完成，上一版图谱仍可使用' : '图谱发布未完成';
    else if (ready && ['ACCEPTED', 'RUNNING', 'QUEUED'].includes(progress)) status = '本批资料正在整理 · 已发布图谱可查看';
    else if (target === 'PREPARING') status = progress === 'COMPLETED' ? '知识已整理，正在生成图谱和索引' : '正在整理和发布知识';
    else if (ready && (lastReady.data.coverage ?? manifest?.coverage) === 'PARTIAL') status = '部分知识已就绪';
    else if (ready) status = '图谱已就绪';
    else if (runRef()) status = '正在整理资料';
    else if (head) status = '上传资料，开始建立知识图谱';
    if (ready && vector === 'PARTIAL') status += ' · 向量覆盖不完整';
    if (ready && vector === 'READY_EMPTY') status += ' · 本版无可向量化条目';
    if (ready && readiness.lexical === 'READY_EMPTY') status += ' · 本版无词法索引条目';
    if (interrupted) status += ' · 实时连接中断，正在核对';
    if (live.textContent !== status) live.textContent = status;
    const actions = [];
    if (ready && route.page !== 'graph') actions.push(button('查看当前图谱', () => navigate({ page: 'graph', pin: null, at: null, asOf: null })));
    if (runRef() && route.page !== 'progress') actions.push(button('查看整理进度', () => go('progress', runRef())));
    if (head?.capabilities?.models?.generation?.configured === false && route.page !== 'settings' && !ready) {
      actions.push(button('前往设置', () => go('settings')));
    }
    if (loadError || target === 'UNKNOWN_HOLD' || progress === 'UNKNOWN_HOLD' || uploadUnknown) {
      actions.push(button('核对处理结果', () => invalidate('user_read')));
    }
    const key = actions.map(action => action.textContent).join('|') + '|' + runRef();
    if (key !== bannerKey) { bannerKey = key; bannerActions.replaceChildren(...actions); }
  }
  function runRef() { return head?.run_ref ?? head?.current_build?.run_ref ?? head?.target_publication?.run_ref ?? lastBuildRef ?? build?.run_ref; }
  function currentView() { return displayed?.view; }
  function readOnly(view = currentView()) {
    return Boolean(head?.workspace_state === 'ARCHIVED' || route.pin || route.asOf || view?.read_only || (view && view.view_revision !== confirmedManifest(head)?.view_revision));
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
    const banner = live.parentElement;
    const inside = Boolean(route.library) && route.page !== 'libraries';
    nav.hidden = !inside;
    selector.hidden = !inside;
    addDocuments.hidden = !inside || readOnly() || Boolean(route.at) || !head?.available_actions?.includes('UPLOAD_DOCUMENTS');
    banner.hidden = !inside;
    if (!banner.hidden) paintBanner();
    const section = ['progress', 'source'].includes(route.page) ? 'documents' : route.page === 'review' ? 'reviews' :
      ['knowledge-list', 'knowledge'].includes(route.page) ? 'graph' : route.page;
    for (const [name, link] of navButtons) {
      if (name === section) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    heading.textContent = pages[route.page] ?? '知识库';
    if (focus) heading.focus();
    const view = currentView();
    if (activePanel?.isConnected && ['libraries', 'documents', 'ontology', 'review', 'change', 'knowledge', 'settings'].includes(route.page)) {
      updateReviewStatus();
      correctionStatus?.();
      return;
    }
    const key = JSON.stringify([routeHash(route), viewKey(view), route.page === 'progress' ? build : null,
      ['documents', 'settings'].includes(route.page) ? head : null, route.page === 'reviews' ? reviewRevision : null, loadError?.code, viewError?.code, Boolean(loadError), Boolean(viewError), changeRef]);
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
    if (route.page === 'libraries') { renderLibraries(); return; }
    if (route.page === 'trash') { renderTrash(); return; }
    if (route.page === 'settings') { renderSettings(); return; }
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
      'knowledge-list': renderKnowledgeCatalog, knowledge: renderKnowledge, source: renderSource, change: renderChange, answers: renderAnswers };
    const active = () => version === pageVersion && container.isConnected;
    Promise.resolve(handlers[route.page]?.(container, view, active)).catch(error => {
      if (active()) container.replaceChildren(errorPanel(error, () => { readCache.clear(); renderKey = undefined; render(); }));
    }).then(restoreScroll);
  }

  function originalDocumentLink(documentRevision, viewRevision) {
    const link = el('a', '下载原件', 'lw-button');
    link.href = api.originalDocumentUrl(documentRevision, viewRevision);
    link.download = '';
    return link;
  }

  function renderDocuments() {
    const view = currentView();
    const base = confirmedManifest(head)?.view_revision;
    const actions = head?.available_actions ?? [];
    const canWrite = !route.at && !readOnly(view) && (!base || view?.view_revision === base);
    const canUpload = canWrite && actions.includes('UPLOAD_DOCUMENTS');
    const canReplace = canWrite && base && actions.includes('REPLACE_DOCUMENT');
    const canRemove = canWrite && base && actions.includes('REMOVE_DOCUMENT');
    const uploadArea = el('div');
    content.append(uploadArea);
    if (route.pin || route.asOf || route.at) historyBar(content);
    const limits = head?.capabilities?.upload_limits;

    function editor(action, source) {
      const replace = action === 'REPLACE';
      const remove = action === 'REMOVE';
      const name = source?.title ?? source?.filename;
      const title = replace ? '替换资料' : remove ? '移出资料' : base ? '追加资料' : '上传资料';
      const form = el('form', null, 'pg-upload');
      const label = el('label', null, 'lw-dropzone pg-dropzone');
      const input = el('input');
      input.type = 'file';
      input.accept = (limits?.suffixes ?? ['.md', '.docx', '.pdf']).join(',');
      input.multiple = !replace;
      const pickerLabel = replace ? '选择替换文件' : '选择资料';
      input.setAttribute('aria-label', pickerLabel);
      label.append(el('strong', pickerLabel), el('small', '选择文件或拖放到这里'), input);
      const fileList = el('div');
      const controls = el('div', null, 'pg-actions');
      const submitLabel = replace ? '提交替换' : remove ? '确认移出' : base ? '开始追加' : '开始上传';
      const submit = el('button', submitLabel, 'lw-button primary');
      submit.type = 'submit';
      const cancel = source && button('取消', () => {
        activePanel = undefined;
        showUpload();
        directoryButtons.find(entry => entry.document === source.document_ref && entry.action === action)?.control.focus();
      });
      controls.append(submit);
      if (cancel) controls.append(cancel);
      const status = el('div');
      status.setAttribute('role', 'status');
      let files = [], busy = false;
      const size = value => value < 1024 ? value + ' B' : new Intl.NumberFormat('zh-CN', {
        maximumFractionDigits: 1,
      }).format(value / 1024) + ' KiB';

      function drawFiles() {
        const selection = new DataTransfer();
        for (const file of files) selection.items.add(file);
        input.files = selection.files;
        const total = files.reduce((sum, file) => sum + file.size, 0);
        const errors = files.map(file => {
          if (!file.size) return '文件为空';
          if (limits?.suffixes && !limits.suffixes.some(suffix => file.name.toLowerCase().endsWith(suffix))) return '格式不受支持';
          return '';
        });
        const error = files.length > (replace ? 1 : limits?.max_files ?? Infinity) ? '超过文件数量上限' :
          total > (limits?.max_total_bytes ?? Infinity) ? '超过整批资料大小上限' : '';
        fileList.replaceChildren();
        if (files.length) fileList.append(list(files.map((file, index) => ({ file, index })), ({ file, index }) => {
          const row = el('div', [file.name, size(file.size), errors[index]].filter(Boolean).join(' · '), 'pg-file-row');
          const discard = button('移除 ' + file.name, () => {
            files.splice(index, 1);
            if (!source && !files.length && activePanel === form) activePanel = undefined;
            drawFiles();
            (fileList.querySelector('button') ?? input).focus();
          });
          discard.disabled = busy || Boolean(uploadUnknown);
          row.append(discard);
          return row;
        }));
        status.textContent = error || (uploadUnknown ? '接收结果待确认，请核对现有整理任务。' : '');
        input.disabled = busy || documentWriteBusy || Boolean(uploadUnknown);
        for (const { control } of directoryButtons) control.disabled = input.disabled;
        submit.disabled = input.disabled || (!remove && !files.length) || Boolean(error) || errors.some(Boolean);
        if (cancel) cancel.disabled = busy;
      }
      function select(chosen) {
        if (input.disabled || !chosen.length) return;
        files = replace ? [...chosen] : [...files, ...chosen];
        activePanel = form;
        drawFiles();
      }
      input.addEventListener('change', () => select(input.files));
      label.addEventListener('dragover', event => event.preventDefault());
      label.addEventListener('drop', event => { event.preventDefault(); select(event.dataTransfer.files); });
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (submit.disabled || documentWriteBusy || uploadUnknown) return;
        const runEpoch = epoch, routeAtUpload = route;
        const operation = operationId();
        const priorRun = runRef();
        const data = new FormData();
        for (const file of files) data.append('files', file, file.name);
        data.append('client_operation_ref', operation);
        if (base) data.append('base_view_revision', base);
        if (source) {
          data.append('action', action);
          data.append('document_ref', source.document_ref);
        }
        pendingUpload({ operation, priorRun, base });
        activePanel = form;
        documentWriteBusy = busy = true;
        drawFiles();
        submit.setAttribute('aria-busy', 'true');
        submit.textContent = '正在提交';
        try {
          const result = await api.post('/documents', data);
          if (runEpoch !== epoch) return;
          if (!result.run_ref) throw new Error('Missing run receipt');
          documentWriteBusy = false;
          pendingUpload(null);
          timestamps('upload_accepted', { run_ref: result.run_ref });
          head = { ...head, run_ref: result.run_ref };
          build = result;
          const stillHere = routeAtUpload === route;
          initiated = { library: route.library, run: result.run_ref, used: !stillHere || Boolean(base) };
          if (!initiated.used) saveUploadProgress({ library: initiated.library, run: initiated.run });
          if (stillHere) go('progress', result.run_ref);
          invalidate('upload');
        } catch (error) {
          if (runEpoch !== epoch) return;
          const unknown = !error.status || error.status >= 500;
          if (unknown) uploadUnknown = { operation, priorRun, base };
          else pendingUpload(null);
          documentWriteBusy = busy = false;
          drawFiles();
          if (!form.isConnected) { renderKey = undefined; invalidate('user_read'); }
          if (error.status === 409) {
            submit.disabled = true;
            status.append(el('p', '资料状态已变化。请读取最新目录后重新选择。'),
              button('读取最新目录', () => { activePanel = renderKey = undefined; invalidate('user_read'); }));
          } else {
            if (!unknown) status.append(el('p', '本次资料更新未获受理。'));
            status.append(errorPanel(error, () => invalidate('user_read')));
          }
          submit.removeAttribute('aria-busy');
          submit.textContent = submitLabel;
          paintBanner();
        }
      });
      if (!remove) form.append(label, fileList);
      form.append(controls, status);
      drawFiles();
      const formats = limits?.suffixes?.join('、') ?? 'Markdown、DOCX 或 PDF';
      const limit = limits ? '，最多 ' + (replace ? 1 : limits.max_files) + ' 份，整批不超过 ' +
        (limits.max_total_bytes / (1024 * 1024)) + ' MiB' : '';
      const description = name ? name + '。更新发布后生效，历史版本保留原来的资料。' :
        base ? '选择要加入当前空间的资料（' + formats + limit + '）。' : '请一次选齐首批资料（' + formats + limit + '）。';
      uploadArea.replaceChildren(block(title, el('p', description, 'lw-muted'), form));
      if (source) {
        activePanel = form;
        (remove ? cancel : input).focus();
        form.scrollIntoView({ block: 'nearest' });
      }
    }

    function showUpload() {
      if (canUpload) { editor('APPEND'); return; }
      let detail = head ? '当前工作空间暂未开放上传。' : '正在读取资料能力。';
      if (route.pin || route.asOf || route.at) detail = '当前正在查看固定版本的资料。';
      else if (base && (head.capabilities?.upload_mode === 'INITIAL_ONLY' || head.capabilities?.initial_upload_only === true)) {
        detail = '工作空间已有可读图谱。当前服务暂未开放后续资料更新。';
      }
      uploadArea.replaceChildren(block('资料上传', el('p', detail, 'lw-muted')));
    }
    const directoryButtons = [];
    showUpload();
    const documents = base ? (head?.documents ?? []).filter(source => !source.view_revision ||
      source.view_revision === view?.view_revision) : [];
    if (documents.length) content.append(block('资料目录', list(documents, source => {
      const row = el('div');
      row.append(el('strong', source.title ?? source.filename ?? '未命名资料'));
      const description = [source.view_revision ? '已发布' : statuses[source.status], source.version_label].filter(Boolean);
      if (description.length) row.append(el('p', description.join(' · '), 'lw-muted'));
      const itemActions = el('div', null, 'pg-actions');
      if (source.source_ref && view && (!source.view_revision || source.view_revision === view.view_revision)) {
        itemActions.append(button('打开正文', () => navigate({ page: 'source', item: source.source_ref,
          pin: view.view_revision })));
      } else row.append(el('p', '当前目录尚未提供可打开的正文。', 'lw-muted'));
      if (source.document_revision_ref && source.view_revision === view?.view_revision) {
        itemActions.append(originalDocumentLink(source.document_revision_ref, source.view_revision));
      }
      if (source.document_ref && source.document_revision_ref && source.view_revision === base) {
        for (const [enabled, action, label] of [[canReplace, 'REPLACE', '替换资料'], [canRemove, 'REMOVE', '移出资料']]) {
          if (!enabled) continue;
          const control = button(label, () => {
            if (!uploadUnknown && !documentWriteBusy) editor(action, source);
          });
          control.disabled = Boolean(uploadUnknown) || documentWriteBusy;
          directoryButtons.push({ document: source.document_ref, action, control });
          itemActions.append(control);
        }
      }
      if (itemActions.childElementCount) row.append(itemActions);
      return row;
    })));
    const candidates = head?.current_build?.publication_status === 'PUBLISHED' ? [] :
      head?.current_build?.documents ?? [];
    if (runRef() && !route.pin && !route.asOf && !route.at) content.append(block('最近整理', candidates?.length
      ? list(candidates, source => el('span', [source.filename ?? source.title, statuses[source.status]].filter(Boolean).join(' · ')))
      : null, button('查看整理进度', () => go('progress', runRef()))));
    if (base && view?.view_revision === base && head?.documents?.length === 0) {
      content.append(block('资料目录', el('p', '当前发布版本没有资料。', 'lw-muted')));
    }
    if (loadError) content.append(errorPanel(loadError, () => invalidate('user_read')));
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
      const group = rows.get(key) ?? [];
      const visible = group.filter(stage => !internalStages.has(stage.stage));
      const subStages = visible.length ? visible : group.slice(-1);
      row.dataset.status = subStages.find(item => item.status !== 'COMPLETED')?.status ?? subStages[0]?.status ?? '';
      row.append(el('strong', label));
      if (!subStages.length) row.append(el('span', '等待状态确认'));
      for (const stage of subStages) {
        const internal = internalStages.has(stage.stage);
        const done = stage.counts?.processed ??
          (stage.status === 'COMPLETED' ? stage.counts?.statements : null);
        const total = stage.counts?.total;
        const observed = stage.ended_at ?? stage.updated_at;
        const seconds = stage.elapsed_seconds ?? (stage.started_at && observed
          ? (Date.parse(observed) - Date.parse(stage.started_at)) / 1000 : null);
        row.append(el('span', [subStages.length > 1 ? stageLabels[stage.stage] : null,
          statuses[stage.status]].filter(Boolean).join(' · ') || '等待状态确认'));
        if (!internal && Number.isFinite(done)) row.append(el('p', '已处理 ' + done +
          (Number.isFinite(total) && total > 0 && total >= done ? ' / ' + total : '') +
          (stage.counts.unit_label ? ' ' + stage.counts.unit_label : Number.isFinite(stage.counts.statements) ? ' 条原述' : '')));
        const { started_batches: started, settled_batches: settled } = stage.counts ?? {};
        if (!internal && Number.isSafeInteger(started) && Number.isSafeInteger(settled) && started > 0 &&
            settled >= 0 && settled <= started) {
          row.append(el('p', '已结束 ' + settled + ' 批 · 已开始 ' + started + ' 批'));
        }
        if (stage.status === 'RUNNING' && stage.updated_at) row.append(el('small', '最近更新 ' + dateLabel(stage.updated_at)));
        if (Number.isFinite(stage.counts?.definitions) && stage.status === 'COMPLETED') {
          row.append(el('p', '已整理 ' + stage.counts.definitions + ' 条定义'));
        }
        if (Number.isFinite(seconds) && seconds >= 0) row.append(el('small', '耗时 ' + Math.floor(seconds) + ' 秒'));
      }
      progress.append(row);
    }
    const summary = packet.execution_status === 'COMPLETED' && packet.publication_status === 'PREPARING' ?
      '整理已完成，正在发布图谱' : (['ACCEPTED', 'QUEUED'].includes(packet.execution_status) ? '资料已接收，正在整理' :
        statuses[packet.execution_status] ?? '整理状态待确认');
    content.append(block(summary, progress,
      fields([['图谱发布', statuses[packet.publication_status] ?? '等待状态确认']])));
    const documents = [...(packet.accepted ?? packet.documents ?? []), ...(packet.rejected ?? [])];
    if (documents.length) content.append(block('本批资料', list(documents, source =>
      el('span', [source.title ?? source.filename, statuses[source.status], source.reason_label].filter(Boolean).join(' · ')))));
    const buildView = currentView();
    appendGaps(content, packet.gaps, packet.view_revision === buildView?.view_revision ? buildView : null);
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
  function appendGaps(parent, gaps, view) {
    if (!gaps?.length) return;
    parent.append(block('未完成范围', list(gaps, gap => {
      const codes = [gap.reason_code, gap.code].filter(value => typeof value === 'string' && value);
      const diagnostics = [gap.diagnostics, gap.detail?.diagnostics].flat()
        .filter(value => typeof value === 'string' && value);
      const reasons = {
        SOURCE_RECEPTION_GAP: '部分记录接收有缺口',
        SOURCE_ITEM_SKIPPED: '有记录未纳入整理',
        SOURCE_TASK_GAP: '有资料处理任务未完成',
        EXTRACTION_TASK_GAP: '有知识提取任务未完成',
        EXTRACTION_PARTIAL: '知识提取部分完成',
      };
      const known = code => Object.hasOwn(reasons, code) ? reasons[code] : null;
      const reason = gap.reason_label || gap.detail?.reason_label || codes.map(known).find(Boolean) || '处理缺口，查看详情';
      const row = el('div');
      row.append(el('strong', [...new Set([gap.label || gap.title, reason].filter(Boolean))].join(' · ')));
      if (diagnostics.includes('FACT_BACKBONE_MISSING')) {
        row.append(el('p', '有记录缺少形成结构化事实所需的字段。', 'lw-muted'));
      }
      const sourceTitle = gap.source_title || gap.detail?.source_title;
      const location = gap.location_label || gap.detail?.location_label;
      const source = gap.source_ref || gap.detail?.source_ref;
      const count = gap.count ?? gap.detail?.count;
      if (sourceTitle || location) row.append(el('p', [sourceTitle, location].filter(Boolean).join(' · '), 'lw-muted'));
      const canOpenSource = view && typeof source === 'string' && source;
      if (canOpenSource) row.append(sourceButtons([source], view));
      if (Number.isSafeInteger(count) && count >= 0) {
        const unit = gap.unit_label || gap.detail?.unit_label;
        row.append(el('p', '受影响数量：' + count + (unit ? ' ' + unit : ''), 'lw-muted'));
      }
      if (!(sourceTitle || location || canOpenSource)) {
        row.append(el('p', '当前页面暂无可定位的资料或段落。', 'lw-muted'));
      }
      const details = el('details');
      details.append(el('summary', '诊断详情'), fields([
        ['原因代码', [...new Set(codes)].join(' · ')], ['诊断代码', [...new Set(diagnostics)].join(' · ')],
        ['条目编号', gap.item_ref || gap.detail?.item_ref], ['回执编号', gap.receipt_ref],
        ['范围编号', gap.scope_ref], ['原文编号', source],
      ]));
      if (!details.lastElementChild.childElementCount) details.append(el('p', '暂无更多诊断信息。', 'lw-muted'));
      row.append(details);
      return row;
    })));
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
    const focusType = !route.focus ? route.item : null;
    const target = route.focus && route.item ? { kind: route.focus, id: route.item } : null;
    const key = JSON.stringify([route.library, viewKey(view), focusType]);
    const restored = canvasContext(view, key, data);
    selected = restored?.selected ?? null;
    const update = !route.pin && !route.asOf && graphUpdate?.after.view.view_revision === view.view_revision ? graphUpdate : null;
    const publication = observedViews.get(view.view_revision);
    const notes = el('div');
    if (loadError && lastReady) notes.append(errorPanel(loadError, () => invalidate('user_read')));
    if (publication?.counts) {
      const counts = el('ul', null, 'pg-metrics');
      for (const [label, number] of [['标准事实', publication.counts.standard_facts],
        ['开放知识', publication.counts.open_statements], ['争议事实', publication.counts.contested_facts],
        ['待处理', publication.counts.open_reviews]]) {
        if (Number.isFinite(number)) counts.append(el('li', label + ' ' + number));
      }
      notes.append(counts);
    }
    if (changeRef && !readOnly()) notes.append(button('查看本次变化', () => go('change', changeRef)));
    if (update && !data.selection?.truncated && !update.before.data.selection?.truncated) {
      const total = kind => [...update.changes.nodes.values(), ...update.changes.edges.values()].filter(value => value === kind).length;
      notes.append(el('p', '本次变化 · 新增 ' + total('新增') + ' · 修改 ' + total('修改') +
        ' · 移出 ' + update.changes.removed.length, 'pg-change-legend'));
      if (update.changes.removed.length) {
        const removed = el('details');
        removed.append(el('summary', '查看移出的对象与关联'),
          list(update.changes.removed, item => el('span', item.label ?? '移出一项关联')));
        notes.append(removed);
      }
      if (restored?.removedSelection) notes.append(el('p', '此前选中的对象已移出此版本。', 'lw-muted'));
    }
    if (!data.graph.edges.length) notes.append(
      el('p', data.graph.nodes.length ? '此范围没有可连线的关系。' : '此范围没有可绘制的知识。', 'lw-muted'),
      button('查看资料', () => go('documents')), button('查看本体', () => go('ontology')));

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
    search.placeholder = '搜索对象、关系或画布内知识';
    search.setAttribute('aria-label', '搜索对象、关系或画布内知识');
    search.value = restored?.query ?? '';
    const entries = el('div', null, 'pg-browse');
    function inspect(id, kind) {
      selected = id ? { id, kind } : null;
      showSelection(inspector, data, view, types, id, kind).catch(error => {
        if (active() && selected?.id === id) inspector.append(errorPanel(error));
      });
    }
    const searchRows = [...data.graph.nodes, ...data.graph.edges].filter(item =>
      !focusType || focusNodes.has(item.id) || item.definition_ref === focusType ||
        (focusNodes.has(item.source) && focusNodes.has(item.target)));
    const graphSourceNames = new Map((head?.documents ?? head?.current_build?.documents ?? [])
      .filter(row => row.source_ref && (row.title || row.filename)).map(row => [row.source_ref, row.title ?? row.filename]));
    const filter = el('select');
    filter.setAttribute('aria-label', '按资料筛选画布项目');
    for (const [value, title] of [['', '全部资料'], ...graphSourceNames]) {
      const option = el('option', title);
      option.value = value;
      filter.append(option);
    }
    filter.value = route.source ?? restored?.source ?? '';
    function browseItems() {
      const query = search.value.trim().toLocaleLowerCase();
      const source = filter.value;
      const rows = searchRows.flatMap(item => [
        { item, kind: Object.hasOwn(item, 'source') ? 'relation' : 'entity' },
        ...(item.attributes ?? []).filter(attribute => attribute.fact_ref)
          .map(attribute => ({ item: { ...attribute, source_refs: attribute.source_refs }, kind: 'knowledge', owner: item.label })),
      ]).filter(({item,owner}) => {
        const title = [owner, item.label, textOf(item.value)].filter(Boolean).join(' ').toLocaleLowerCase();
        return title.includes(query) && (!source || (item.source_refs ?? []).some(ref => (ref?.source_ref ?? ref) === source));
      });
      entries.replaceChildren(list(rows, ({ item, kind, owner }) => button([owner, item.label, textOf(item.value)].filter(Boolean).join(' · '), () => {
        if (kind === 'knowledge') return go('knowledge', item.fact_ref);
        graphView?.select(item.id, kind);
        inspect(item.id, kind);
      }), '当前已加载范围没有匹配项。'));
    }
    search.addEventListener('input', () => { browse.open = true; browseItems(); });
    filter.addEventListener('change', () => { browse.open = true; browseItems(); });
    browseItems();
    const discover = el('div', null, 'pg-actions pg-discover');
    discover.append(search, button('浏览完整知识列表', () => navigate({page:'knowledge-list',source:filter.value || null})));
    if (graphSourceNames.size && !readOnly(view)) discover.append(filter);
    timeControls(discover);
    canvas.prepend(discover);
    browse.append(entries);
    canvas.append(browse);
    layout.append(canvas, inspector);
    parent.append(layout, notes);
    const gaps = data.gaps ?? publication?.gaps;
    if (gaps?.length) {
      const details = el('details', null, 'pg-graph-diagnostics');
      details.append(el('summary', '查看处理缺口'));
      appendGaps(details, gaps, view);
      parent.append(details);
    }
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
      if (saved) { saved.query = search.value; saved.listOpen = browse.open; saved.source = filter.value; }
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
        if (target && ['entity', 'relation'].includes(target.kind)) {
          const objects = target.kind === 'entity' ? data.graph.nodes : data.graph.edges;
          if (objects.some(item => item.id === target.id)) {
            const id = target.id;
            graphView.select(id, target.kind);
            graphView.locate(id, target.kind);
            inspect(id, target.kind);
          } else status.textContent = '此引用的对象或关系暂未出现在已加载的图范围。';
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
          () => edge.fact_ref ? go('knowledge', edge.fact_ref) :
            (graphView?.select(edge.id, 'relation'), showSelection(parent, data, view, types, edge.id, 'relation')));
      }, '当前画布没有此对象的关联。'));
      if (node.attributes?.length) parent.append(block('属性', list(node.attributes, attribute =>
        button([attribute.label, textOf(attribute.value)].filter(Boolean).join(' · '),
          () => go('knowledge', attribute.fact_ref)))));
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
    dialog.setAttribute('aria-label', '原文预览');
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
      if (result.view_revision !== view.view_revision || result.index_descriptor_ref !== descriptorRef) {
        throw Error('SOURCE_VIEW_MISMATCH');
      }
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
    parent.append(button('返回来源入口', () => history.back()), block(source.title ?? '资料原文',
      ...sourceText(source), source.document_revision_ref && source.view_revision === view.view_revision
        ? originalDocumentLink(source.document_revision_ref, view.view_revision) : null));
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
      ['表达方式', modalityNames[fact.modality] ?? textOf(fact.modality)], ['是否否定', typeof (fact.negated ?? fact.content?.negated) === 'boolean' ? ((fact.negated ?? fact.content.negated) ? '是' : '否') : null],
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
  async function renderKnowledgeCatalog(parent, view, active) {
    const toolbar = el('div', null, 'pg-actions');
    const results = el('div');
    const filters = el('select');
    filters.setAttribute('aria-label', '资料来源');
    const documents = (head?.documents ?? []).filter(item => item.view_revision === view.view_revision);
    const options = new Map(documents.filter(item => item.source_ref && (item.title || item.filename))
      .map(item => [item.source_ref, item.title ?? item.filename]));
    for (const [value,label] of [['','全部资料'],...options]) {
      const option = el('option',label);
      option.value = value;
      filters.append(option);
    }
    const memoryKey = JSON.stringify([route.library, viewKey(view), 'knowledge-catalog']);
    const prior = historyParts.get(memoryKey);
    filters.value = route.source ?? prior?.source ?? '';
    let kind = prior?.kind ?? 'FACT', request = 0;
    const tabs = new Map();
    for (const [key,label] of [['FACT','标准知识'],['OPEN','开放知识']]) {
      const tab = button(label, () => { kind = key; void load(); });
      tabs.set(key,tab);
      toolbar.append(tab);
    }
    if (options.size) toolbar.append(filters);
    filters.addEventListener('change', () => { void load(); });
    parent.append(button('返回图谱', () => history.back()),toolbar,results);
    async function load(cursor) {
      const seq = ++request;
      historyParts.set(memoryKey,{kind,source:filters.value});
      for (const [key,tab] of tabs) tab.setAttribute('aria-pressed', String(key === kind));
      if (!cursor) results.replaceChildren(el('p','正在读取当前版本的知识。','lw-muted'));
      try {
        const page = await readBound('/knowledge',view,{kind,source_ref:filters.value || undefined,cursor});
        if (!active() || seq !== request) return;
        if (!cursor) results.replaceChildren();
        results.querySelector('[data-more-knowledge]')?.remove();
        results.append(list(page.items ?? [], item => {
          const key = item.fact_ref ?? item.statement_ref ?? item.knowledge_ref;
          const label = item.label ?? item.statement_text ?? item.text ?? '查看知识详情';
          return key ? button(label, () => navigate({page:'knowledge',item:key,focus:kind === 'OPEN' ? 'open' : null,
            source:filters.value || null})) : el('span', label);
        }, '当前范围没有这类知识。'));
        if (page.next_cursor) {
          const more = button('继续读取知识', () => { more.disabled = true; void load(page.next_cursor); });
          more.dataset.moreKnowledge = '';
          results.append(more);
        }
      } catch (error) {
        if (active() && seq === request) results.replaceChildren(errorPanel(error, () => void load()));
      }
    }
    await load();
  }

  async function renderKnowledge(parent, view, active) {
    const path = '/knowledge/' + ref(route.item);
    const open = route.focus === 'open';
    const fact = await readBound(path, view, open ? { kind: 'OPEN' } : undefined);
    if (!active()) return;
    const panel = block(fact.label ?? '知识依据', factDetails(fact, view));
    parent.append(button('返回上一步', () => history.back()), panel);
    if (open || route.at || readOnly(view) || !head?.capabilities?.runs_human_jobs) return;
    try {
      const basis = await readBound(path + '/correction', view);
      if (active() && !readOnly(view)) renderCorrection(panel, path + '/correction', basis, fact, view);
    } catch (error) {
      if (active() && ![404, 409, 422].includes(error.status)) {
        panel.append(errorPanel(error, () => { renderKey = undefined; render(); }));
      }
    }
  }

  function renderCorrection(panel, path, basis, fact, view) {
    const action = basis.available_actions?.find(item => item.kind === 'CORRECT_FACT');
    const edits = new Set(action?.editable_fields ?? []);
    const original = fact.content ?? {};
    const sources = (basis.evidence ?? []).filter(row => row.source_ref && row.text);
    const polarity = edits.has('negated') && typeof original.negated === 'boolean';
    const originalValue = original.value ?? basis.sides?.[0]?.value;
    const hasValue = edits.has('value') && originalValue?.kind === 'VALUE' &&
      (typeof originalValue.value === 'string' || typeof originalValue.value === 'boolean' || Number.isSafeInteger(originalValue.value));
    if (!basis.target_fact_version_ref || !sources.length || (!polarity && !hasValue)) return;
    const entry = button('更正知识', openEditor);
    panel.append(entry);
    function openEditor() {
      if (readOnly(view)) return;
      entry.hidden = true;
      const form = el('form', null, 'pg-form pg-correction');
      const editor = el('fieldset', null, 'pg-correction-fields');
      const reason = el('textarea');
      reason.required = true;
      const reasonLabel = el('label', '更正理由');
      reasonLabel.append(reason);
      let negated, value;
      if (polarity) {
        const label = el('label', '修订后的表达');
        negated = el('select');
        for (const [key, name] of [['false', '肯定'], ['true', '否定']]) {
          const option = el('option', name);
          option.value = key;
          negated.append(option);
        }
        negated.value = String(original.negated);
        label.append(negated);
        editor.append(label);
      }
      if (hasValue) {
        const label = el('label', '修订后的值');
        const initial = originalValue.value;
        value = el('input');
        value.type = typeof initial === 'boolean' ? 'checkbox' : typeof initial === 'number' ? 'number' : 'text';
        if (value.type === 'checkbox') value.checked = initial;
        else { value.value = initial; value.required = true; }
        label.append(value);
        editor.append(label);
      }
      const evidence = el('fieldset');
      evidence.append(el('legend', '选择资料依据'));
      const chosen = sources.map(row => {
        const label = el('label', row.text);
        const check = el('input');
        check.type = 'checkbox';
        label.prepend(check);
        evidence.append(label, button('打开此版本原文', () => go('source', row.source_ref, view.view_revision)));
        return [row.source_ref, check];
      });
      const preview = el('button', '预览变化', 'lw-button primary');
      preview.type = 'submit';
      const outcome = el('div');
      outcome.setAttribute('aria-live', 'polite');
      const cancel = button('取消更正', () => {
        form.remove();
        correctionStatus = activePanel = undefined;
        entry.hidden = false;
        entry.focus();
        invalidate('correction_closed');
      });
      const controls = el('div', null, 'pg-actions');
      controls.append(preview, cancel);
      editor.append(reasonLabel, evidence, controls);
      form.append(editor, outcome);
      panel.append(form);
      activePanel = form;
      reason.focus();
      form.addEventListener('input', () => outcome.replaceChildren());
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (editor.disabled) return;
        const evidenceRefs = chosen.filter(([, check]) => check.checked).map(([key]) => key);
        const proposed = {};
        if (negated && (negated.value === 'true') !== original.negated) proposed.negated = negated.value === 'true';
        if (value) {
          const revised = value.type === 'checkbox' ? value.checked : value.type === 'number' ? value.valueAsNumber : value.value;
          if (typeof revised === 'number' && !Number.isSafeInteger(revised)) {
            outcome.textContent = '请输入可精确表示的整数。';
            return;
          }
          if (revised !== originalValue.value) {
            proposed.value = { ...originalValue, value: revised };
          }
        }
        if (!Object.keys(proposed).length || !evidenceRefs.length || !reason.value.trim()) {
          outcome.textContent = '请修改内容、写明理由并选择至少一项资料依据。';
          return;
        }
        const client = api;
        if (readOnly(view)) {
          outcome.replaceChildren(el('p', '知识版本已更新，请重新读取后再更正。'), button('读取最新知识', () => cancel.click()));
          return;
        }
        const request = { base_view_revision: view.view_revision, client_operation_ref: operationId(),
          intent: { kind: 'CORRECT_FACT', target_fact_version_ref: basis.target_fact_version_ref,
            proposed_content: proposed, evidence_refs: evidenceRefs, reason: reason.value.trim() } };
        editor.disabled = true;
        outcome.textContent = '正在读取更正预览';
        try {
          const result = await client.post(path + '/preview', request);
          if (!form.isConnected || client !== api) return;
          if (result.base_view_revision !== view.view_revision || !result.preview_ref) throw new Error('CORRECTION_PREVIEW_UNCONFIRMED');
          const submit = button('确认更正', save, true);
          const message = el('p');
          outcome.replaceChildren(impactBlock(result, view), submit, message);
          async function save() {
            submit.disabled = true;
            editor.disabled = true;
            message.textContent = '正在保存更正';
            try {
              const saved = await client.post(path, { ...request, preview_ref: result.preview_ref });
              if (client !== api) return;
              if (!saved.decision_ref || !saved.job_ref) throw new Error('CORRECTION_RECEIPT_UNCONFIRMED');
              receipt = saved;
              job = undefined;
              outcome.replaceChildren(message);
              if (form.isConnected) {
                correctionStatus = () => {
                  message.textContent = receiptState(saved, job);
                  const applied = appliedPublication(saved, job);
                  if (applied && !outcome.querySelector('button')) outcome.append(button('查看本次变化', () =>
                    go('change', applied.change_ref, applied.target_view_revision)));
                };
                correctionStatus();
              }
              invalidate('correction_saved');
            } catch (error) {
              if (!form.isConnected) return;
              if (!error.status || error.status >= 500) {
                message.textContent = '保存结果待确认。可用同一操作核对结果。';
                submit.textContent = '核对保存结果';
                submit.disabled = false;
              } else {
                editor.disabled = false;
                outcome.replaceChildren(errorPanel(error, error.status === 409 ? () => cancel.click() : undefined));
              }
            }
          }
        } catch (error) {
          if (form.isConnected) outcome.replaceChildren(errorPanel(error, error.status === 409 ? () => cancel.click() : undefined));
        } finally {
          editor.disabled = false;
        }
      });
    }
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
        button(fact.label ?? '查看相关事实', () => go('knowledge', fact.fact_ref)))));
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
    for (const [key, label] of [['OPEN', '待判断'], ['APPLYING', '应用中'], ['DECIDED', '已处理'],
      ['DEFERRED', '暂不处理'], ['UNAVAILABLE', '暂不可处理']]) {
      const tab = button(label, () => { status = key; historyParts.set(listKey, status); void load(); });
      filter.append(tab);
      tabs.set(key, tab);
    }
    async function load(cursor) {
      const seq = ++request;
      for (const [key, tab] of tabs) tab.setAttribute('aria-pressed', String(key === status));
      try {
        const filter = status === 'UNAVAILABLE' ? undefined : status === 'APPLYING' ? 'DECIDED' : status;
        const data = await readBound('/reviews', view, { status: filter, cursor });
        if (!active() || seq !== request) return;
        const items = (data.items ?? []).filter(item => {
          if (status === 'UNAVAILABLE') return item.review_status === 'OPEN' && item.review_eligibility?.actionable === false;
          const applying = item.decision?.decision_status === 'SAVED';
          if (status === 'APPLYING') return applying;
          if (status === 'DECIDED') return !applying;
          return true;
        });
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
    const saved = detail.decision_receipt ?? receipts.get(reviewRef) ?? recovered ?? (detail.decision ? {
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
      const rawReason = model.reason;
      const internal = typeof rawReason === 'string' && (/\b(?:O|E)\d{2,}\b/.test(rawReason) ||
        /[A-Fa-f0-9]{20,}/.test(rawReason));
      identitySummary.replaceChildren(fields([
        ['模型建议', model.judgment ?? '暂无可展示的模型建议'],
        ['模型把握度', model.confidence ?? model.confidence_note],
        ['建议依据', internal ? null : rawReason],
        ['程序采用说明', model.adoption],
      ]));
      if (internal) {
        const details = el('details');
        details.append(el('summary', '查看建议依据及原始编号'), el('p', rawReason));
        identitySummary.append(details);
      }
    }
    if (identity) {
      showIdentitySummary(detail);
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
    if (identity) pair.after(identitySummary);
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
    if ((saved && saved.review_status !== 'DEFERRED') || detail.review_status === 'DECIDED') return;
    const unavailable = identity ? identityReviewUnavailable(detail, head?.capabilities, { fixture: descriptor.fixture === true }) :
      detail.review_status === 'OPEN' && detail.review_eligibility?.actionable === false
        ? detail.review_eligibility.reason ?? '此事项暂不可处理。' : null;
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
    let actions = reviewActionSpecs(detail).filter(action => action.supported);
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
        const refreshedActions = reviewActionSpecs(item).filter(action => action.supported);
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
          if (result.review_status === 'DEFERRED') {
            controls.append(button('继续处理此事项', () => {
              readCache.clear();
              activePanel = renderKey = undefined;
              render();
            }));
          }
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

  function applicationView(applied) {
    if (!applied) return {};
    const revision = applied.target_view_revision;
    const manifest = confirmedManifest(head);
    const ready = revision === manifest?.view_revision && revision === lastReady?.view.view_revision;
    const historical = Boolean(manifest && manifest.view_revision !== revision &&
      (manifest.parent_view_revision === revision || (applied.active_view_revision && applied.active_view_revision !== revision)));
    return {
      revision, ready, pin: ready ? null : revision,
      note: historical ? '此决定已应用于较早的发布版本。' : ready ? null : '应用已确认，正在读取对应版本图谱。',
    };
  }

  function updateReviewStatus() {
    if (!reviewFlow) return;
    const flow = reviewFlow;
    flow.stale?.();
    if (!flow.current) return;
    const receiptJob = flow.current === receipt ? job : null;
    const state = receiptState(flow.current, receiptJob);
    const applied = appliedPublication(flow.current, receiptJob);
    const version = applicationView(applied);
    const key = JSON.stringify([state, applied?.change_ref, version.note]);
    if (flow.statusKey === key) return;
    flow.statusKey = key;
    flow.status.replaceChildren(el('p', state));
    if (applied) {
      if (version.note) flow.status.append(el('p', version.note, 'lw-muted'));
      flow.status.append(button('查看本次变化', () => navigate({ page: 'change', item: applied.change_ref,
        pin: version.pin, at: null, asOf: null })));
      if (version.ready && flow.appliedObserved !== applied.change_ref) {
        flow.appliedObserved = applied.change_ref;
        timestamps('decision_applied', { view_revision: version.revision, change_ref: applied.change_ref });
      }
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
    const historical = change.to && change.to !== confirmedManifest(head)?.view_revision;
    actions.append(button(historical ? '查看应用后的图谱' : '查看图中变化',
      () => navigate({ page: 'graph', pin: historical ? change.to : null, at: null, asOf: null })));
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
    const state = receiptState(revertFlow.receipt, job);
    const applied = appliedPublication(revertFlow.receipt, job);
    const version = applicationView(applied);
    const key = JSON.stringify([state, version.note, version.revision]);
    if (key === revertFlow.state) return;
    revertFlow.state = key;
    revertFlow.result.replaceChildren(el('p', applied ? '撤销已应用' : state));
    if (applied) {
      if (version.note) revertFlow.result.append(el('p', version.note, 'lw-muted'));
      revertFlow.result.append(button('查看撤销后的图谱', () => navigate({
        page: 'graph', pin: version.pin, at: null, asOf: null,
      })));
    }
  }

  function chatApi(path, body) {
    const match = /^\/api\/product\/libraries\/([^/]+)\/native-query\//.exec(path);
    if (!match) throw Error('问答路径无效');
    return createPgApi(decodeURIComponent(match[1]), { token: boot.token }).query(path, body);
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
    const graph = matchesChatScope(scope) && displayed?.view.view_revision === view.view_revision
      ? displayed.data.graph : null;
    const knowledge = graph ? citation.knowledge_refs ?? [] : [];
    const relations = graph?.edges.filter(edge => knowledge.includes(edge.fact_ref) || knowledge.includes(edge.statement_ref)) ?? [];
    const entityIds = new Set(relations.flatMap(edge => [edge.source, edge.target]));
    for (const node of graph?.nodes ?? []) {
      if ((node.attributes ?? []).some(attribute => knowledge.includes(attribute.fact_ref))) entityIds.add(node.id);
    }
    const graphTargets = [
      ...(graph?.nodes ?? []).filter(node => entityIds.has(node.id))
        .map(node => ({kind:'entity',id:node.id,label:node.label})),
      ...relations.map(edge => ({kind:'relation',id:edge.id,label:edge.label})),
    ].filter(item => item.label);
    return {citation_ref:citation.citation_ref, label:citation.label, kind:citation.kind, historical,
      sources, knowledge_ids:knowledge, entity_ids:[...entityIds], relation_ids:relations.map(edge => edge.id),
      graph_targets:graphTargets, graph_location_verified:Boolean(graphTargets.length)};
  }

  async function renderAnswers(parent, view, active) {
    const caps = head?.capabilities ?? {};
    if (caps.query_registered === false || (caps.query_registered === undefined && !descriptor.query_enabled) ||
        (!route.pin && !route.asOf && caps.questions === false)) {
      parent.append(block(null, el('p', '当前知识库尚未提供同版本问答。'),
        button(caps.query_status === 'NOT_CONFIGURED' ? '前往设置' : '在图谱中查看知识来源',
          () => go(caps.query_status === 'NOT_CONFIGURED' ? 'settings' : 'graph'))));
      return;
    }
    const libraryId = route.library;
    const time = view.resolved_scope ?? {};
    const selection = time.as_of ? { as_of: JSON.stringify({ timestamp: time.as_of }) } :
      { view_revision: view.view_revision };
    const availability = await api.queryCapabilities({ ...selection, at: time.at });
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
      onRoute: frame => {
        if (route.page !== 'answers' || frame.library_id !== route.library) return;
        const next = { ...route, conversation: frame.conversation_id, query: frame.query_ref, turn: frame.chat_turn_id };
        history.replaceState(history.state, '', routeHash(next));
        route = next;
      },
      canAsk:() => currentView()?.view_revision === chatPin?.query_read_view?.view_revision && route.page === 'answers',
      onOpenSource:({source,citation}) => {
        const pinned = citation.source_scope.query_read_view;
        const item = ['retrieval', source.source_ref, pinned.index_descriptor_ref, source.quote_start, source.quote_end].join('~');
        navigate({page:'source', item, pin:pinned.view_revision, asOf:null, at:pinned.at});
      },
      onOpenGraph:({kind,id,scope}) => {
        if (kind === 'knowledge') navigate({page:'knowledge',item:id,pin:scope.query_read_view.view_revision,
                                            asOf:null,at:scope.query_read_view.at});
        else if (kind === 'entity' || kind === 'relation') navigate({page:'graph', item:id, focus:kind,
          pin:scope.query_read_view.view_revision, asOf:null, at:scope.query_read_view.at});
      },
    });
    await chatWorkspace.attach({host:parent,libraryId,pin,
      conversationId:route.conversation,queryRef:route.query,turnId:route.turn});
  }

  function onVisibility() {
    if (document.hidden) {
      clearTimeout(disconnectTimer);
      clearTimeout(syncTimer);
      syncTimer = undefined;
    } else invalidate('visible');
  }
  document.addEventListener('visibilitychange', onVisibility);
  connectLibrary();
  return { dispose() {
    disposed = true;
    epoch++;
    pageVersion++;
    libraryAbort?.abort();
    stopStream?.();
    clearTimeout(syncTimer);
    clearTimeout(disconnectTimer);
    removeEventListener('popstate', onLocationChange);
    removeEventListener('hashchange', onLocationChange);
    document.removeEventListener('visibilitychange', onVisibility);
    if (dialog.open) dialog.close();
    rememberCanvas();
    chatWorkspace?.dispose();
  } };
}
