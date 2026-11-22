const events = [
  'build.stage_changed', 'build.progress', 'build.stopped', 'review.changed',
  'decision.saved', 'job.progress', 'publication.published', 'publication.failed',
  'resync', 'stream.resync',
];

export const ref = value => encodeURIComponent(value);
export const scopeParams = view => ({
  view_revision: view.view_revision,
  at: view.resolved_scope?.at ?? null,
  resolved_scope: JSON.stringify(view.resolved_scope),
});

export class PgApiError extends Error {
  constructor(response, error) {
    super(response ? '服务暂时无法完成此操作' : '连接中断，结果待核对');
    this.status = response?.status ?? 0;
    this.code = typeof error?.code === 'string' ? error.code : 'REQUEST_UNAVAILABLE';
    this.requestRef = typeof error?.request_ref === 'string' ? error.request_ref : null;
  }
}

export function createPgApi(libraryRef, { token, signal, fetcher = fetch } = {}) {
  const base = '/api/v1/libraries/' + ref(libraryRef);
  function url(path, params = {}) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== '') search.set(key, value);
    }
    return base + path + (search.size ? '?' + search.toString() : '');
  }
  async function request(path, { params, body } = {}) {
    const headers = { Accept: 'application/json' };
    if (token && body !== undefined) headers['X-CQForge-Token'] = token;
    if (body !== undefined && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetcher(url(path, params), {
        method: body === undefined ? 'GET' : 'POST', body, headers, signal,
        credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new PgApiError(null);
    }
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) throw new PgApiError(response, result?.error);
    return result;
  }
  function subscribe({ invalidate, connection, EventStream = EventSource }) {
    let stream;
    const seen = new Set();
    function receive(event) {
      if (event.type === 'resync' || event.type === 'stream.resync') {
        invalidate('resync');
        stream.close();
        open();
        return;
      }
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.library_ref !== libraryRef || !data.event_id || seen.has(data.event_id)) return;
      if (event.lastEventId && event.lastEventId !== data.event_id) return;
      seen.add(data.event_id);
      if (seen.size > 512) seen.delete(seen.values().next().value);
      invalidate(data.event_type);
    }
    function open() {
      const source = new EventStream(url('/events'));
      stream = source;
      for (const type of [...events, 'message']) {
        source.addEventListener(type, event => { if (stream === source) receive(event); });
      }
      // Native reconnect preserves Last-Event-ID. Only an explicit expired
      // cursor control causes a new stream with a fresh cursor.
      source.addEventListener('open', () => {
        if (stream === source) { connection(true); invalidate('reconnect'); }
      });
      source.addEventListener('error', () => {
        if (stream === source) { connection(false); invalidate('disconnected'); }
      });
    }
    open();
    return () => { stream.close(); stream = null; };
  }
  return {
    head: () => request('/view'),
    resolve: params => request('/views/resolve', { params }),
    read: (path, view, params) => request(path, { params: { ...params, ...scopeParams(view) } }),
    get: (path, params) => request(path, { params }),
    post: (path, body) => request(path, { body }),
    subscribe,
  };
}

export function confirmedManifest(head) {
  const view = head?.active_view;
  if (!view?.view_revision || !view.graph_revision || !view.index_revision) return null;
  // /view's active_view is itself confirmed. If it supplies an explicit
  // publication state, reject any contradictory value.
  if (view.publication_status && view.publication_status !== 'PUBLISHED') return null;
  if (Object.values(view.index_components ?? {}).some(state => !['READY', 'NOT_CONFIGURED'].includes(state))) return null;
  return view;
}

export function matchingGraph(graph, resolved) {
  return graph?.view_revision === resolved.view_revision &&
    graph.publication_status === 'PUBLISHED' &&
    (graph.scope?.at ?? null) === (resolved.resolved_scope.at ?? null) && Array.isArray(graph.graph?.nodes) &&
    Array.isArray(graph.graph?.edges);
}

export function shouldEnterFirstGraph({ route, initiated, head, resolved, graph }) {
  return route.page === 'progress' && !route.pin && initiated?.run === route.item &&
    !initiated?.used && confirmedManifest(head)?.view_revision === resolved.view_revision &&
    matchingGraph(graph, resolved) &&
    (head.active_view.run_ref ?? head.target_publication?.run_ref ?? head.run_ref) === initiated.run;
}

export function applyGraphDelta(previous, delta, resolved) {
  if (delta?.from !== previous.view_revision || delta?.to !== resolved.view_revision ||
      !delta.scope || delta.scope.at !== resolved.resolved_scope.at ||
      previous.selection?.truncated) return null;
  const patch = (items, changes) => {
    if (!changes || !['added', 'modified', 'removed'].every(key => Array.isArray(changes[key]))) return null;
    const byId = new Map(items.map(item => [item.id, item]));
    for (const item of changes.removed) byId.delete(typeof item === 'string' ? item : item.id);
    for (const item of [...changes.added, ...changes.modified]) {
      if (!item?.id) return null;
      byId.set(item.id, item);
    }
    return [...byId.values()];
  };
  const nodes = patch(previous.graph.nodes, {
    added: delta.added?.nodes, modified: delta.updated?.nodes, removed: delta.removed?.node_refs,
  });
  const edges = patch(previous.graph.edges, {
    added: delta.added?.edges, modified: delta.updated?.edges, removed: delta.removed?.edge_refs,
  });
  if (!nodes || !edges || nodes.length + edges.length > 200) return null;
  const ids = new Set(nodes.map(node => node.id));
  if (edges.some(edge => !ids.has(edge.source) || !ids.has(edge.target))) return null;
  return {
    view_revision: resolved.view_revision, publication_status: 'PUBLISHED',
    scope: resolved.resolved_scope, graph: { nodes, edges },
    summary: { total_nodes: nodes.length, total_edges: edges.length, returned_nodes: nodes.length, returned_edges: edges.length },
    selection: { truncated: false, next_cursor: null },
  };
}

export function receiptState(receipt, job, confirmed, readableRevision) {
  if (!receipt) return '';
  if (receipt.unknown) return '保存结果待确认';
  if (receipt.review_status === 'DEFERRED') return '已暂缓，可在暂不处理中继续查看';
  const result = job?.result ?? job ?? receipt;
  if (result.decision_status === 'SUPERSEDED') return '该决定已有后续修订';
  const target = result.target_view_revision;
  if (result.decision_status === 'APPLIED' && result.publication_status === 'PUBLISHED' &&
      result.job_status === 'SUCCEEDED' && result.change_ref && target &&
      target === result.active_view_revision && target === confirmed?.view_revision &&
      target === readableRevision) return '处理已应用';
  const status = job?.job_status ?? result.job_status ?? receipt.job_status;
  if (['FAILED', 'CANCELLED'].includes(status)) return '决定已保存，更新未完成';
  if (status === 'UNKNOWN_HOLD') return '决定已保存，更新结果待确认';
  return '决定已保存，正在更新相关知识与图谱';
}

const reviewActions = {
  FACT: ['CLOSE_STATE', 'RETIME_FACT', 'CORRECT_FACT', 'REVISE_SCOPE', 'WITHDRAW_FACT', 'KEEP_BOTH'],
  IDENTITY: ['MERGE', 'KEEP_SEPARATE'],
  ONTOLOGY: ['KEEP_DISTINCT', 'ALIAS', 'REBIND', 'ADOPT_CONSTRAINT'],
};
const reviewInputFields = {
  FACT: ['target_fact_version_ref', 'evidence_refs', 'proposed_scope', 'proposed_world_time', 'proposed_content'],
  IDENTITY: ['evidence_refs'],
  ONTOLOGY: ['relative_direction', 'evidence_refs'],
};
export function reviewDomain(review) {
  const domain = review.target_kind ?? review.review_kind;
  return Object.hasOwn(reviewActions, domain) ? domain : null;
}

export function reviewActionSpecs(review) {
  const domain = reviewDomain(review);
  if (!domain || !Array.isArray(review.available_actions)) return [];
  return review.available_actions.flatMap(raw => {
    const input = typeof raw === 'string' ? { kind: raw } : raw;
    if (typeof input?.kind !== 'string' || !input.kind) return [];
    const required = input.required_fields ?? [];
    const directions = input.allowed_relative_directions ?? input.allowed_directions;
    const accepted = input.kind === 'DEFER' ? ['reason'] : ['reason', ...reviewInputFields[domain]];
    return [{ ...input, allowed_directions: directions, required_fields: Array.isArray(required) ? required : [],
      supported: input.enabled !== false && input.can_preview !== false && Array.isArray(required) &&
        (input.kind === 'DEFER' || reviewActions[domain].includes(input.kind)) &&
        required.every(key => accepted.includes(key)) &&
        (!required.includes('relative_direction') || directions === undefined ||
          (Array.isArray(directions) && directions.some(value => ['FORWARD', 'REVERSE'].includes(value)))) }];
  });
}

export function identityReviewSummary(review) {
  const suggestion = review.model_suggestion;
  const modelPick = { SAME: '同一实体', DIFFERENT: '保持为不同实体', UNKNOWN: '依据不足，暂不能判断' };
  const judgment = modelPick[suggestion?.judgment ?? review.judgment?.judgment];
  const score = suggestion?.confidence;
  const valid = suggestion?.confidence_status === 'VALID' && Number.isFinite(score) && score >= 0 && score <= 1;
  const unscored = { LEGACY_UNSCORED: '这条旧建议未保存把握度', MISSING: '未提供把握度',
    INVALID: '记录的把握度无效', NOT_APPLICABLE: null };
  return {
    judgment, confidence: valid ? String(score) : null,
    confidence_note: valid ? null : unscored[suggestion?.confidence_status] ?? (judgment ? '未保存把握度' : null),
    reason: suggestion?.reason ?? (judgment ? review.reason : null),
    adoption: review.adoption?.reason ?? null,
  };
}

export function identityReviewUnavailable(review, capabilities, { readOnly = false, fixture = false } = {}) {
  const eligibility = review.review_eligibility;
  if (readOnly || review.read_only) return eligibility?.reason || '这是已固定的历史视图。请在当前版本核对后处理。';
  if (eligibility && (eligibility.status !== 'ACTIONABLE' ||
    (review.review_status === 'OPEN' && eligibility.actionable === false))) {
    return eligibility.reason || ({
      WAITING_FOR_EVIDENCE: '双方的原文证据还需要补齐。',
      TECHNICAL_PENDING: '系统仍在判断或核对影响，完成后可重新读取。',
      NO_LEGAL_ACTION: '此版本暂没有可执行的身份决定。',
    })[eligibility.status] || '此事项暂未达到可处理条件。';
  }
  if (!fixture && (!capabilities?.runs_human_jobs || !capabilities.human_review_domains?.includes('IDENTITY'))) {
    return '此知识库尚未开放实体决定的应用能力。';
  }
  if (!reviewActionSpecs(review).some(action => action.supported && ['MERGE', 'KEEP_SEPARATE'].includes(action.kind))) {
    return eligibility?.reason || '此版本暂没有可执行的身份决定。';
  }
  return null;
}
