/** Revision lineage is an audit record, never permission to bypass review. */
import assert from 'node:assert/strict';
import { sha, answerCQ } from './engine.mjs';

export function revisionAudit(parent, input, note) {
  assert(parent && !['RUNNING', 'QUEUED', 'DRAFT'].includes(parent.status), '只能修订已结束的版本');
  assert(typeof note === 'string' && note.trim().length >= 3 && note.length <= 2000, '请填写至少3字的修订说明');
  const fields = ['definitions', 'as_of', 'cqs', 'sources'];
  const changes = fields.filter(field => sha(parent.input[field]) !== sha(input[field]))
    .map(field => ({ field, before_sha256: sha(parent.input[field]), after_sha256: sha(input[field]) }));
  assert(changes.length, '只改名称不算修订；请修改定义、CQ、资料或查询时点');
  return { parent_id: parent.id, root_id: parent.revision?.root_id || parent.id,
    number: (parent.revision?.number || 1) + 1, note: note.trim(), changes,
    parent_input_sha256: sha(parent.input), input_sha256: sha(input),
    parent_issue_ids: (parent.result?.gate?.issues || []).map(i => i.issue_id || i.code),
    resolution: 'PENDING_REVALIDATION', created_at: new Date().toISOString() };
}

export function versionDiff(parent, child) {
  assert(child.revision?.parent_id === parent.id, '不是直接父子版本');
  const byQuestion = job => new Map(job.input.cqs.map(q => [q.question,
    answerCQ(job.result || { status: job.status }, job.input, q.id)]));
  const before = byQuestion(parent), after = byQuestion(child);
  return { parent_id: parent.id, child_id: child.id, mode: 'LOCAL_VERSION_SNAPSHOTS_NOT_LIVE_GRAPH_QUERY',
    inputs: ['definitions', 'as_of', 'cqs'].filter(f => sha(parent.input[f]) !== sha(child.input[f]))
      .map(field => ({ field, before: parent.input[field], after: child.input[field] })),
    sources: { before: parent.input.sources.map(s => ({ title: s.title, sha256: s.sha256 })),
      after: child.input.sources.map(s => ({ title: s.title, sha256: s.sha256 })) },
    answers: [...new Set([...before.keys(), ...after.keys()])].map(question => ({ question,
      before: before.get(question) || null, after: after.get(question) || null,
      changed: sha(before.get(question) || null) !== sha(after.get(question) || null) })),
    notice: '答案按当前查询规则从各自版本快照计算；未通过评审或缺少目标约束时返回UNKNOWN。变化可能来自本体ID、查询计划或证据变化，不等于现实事实已改变；不判定新版本更正确，也不自动废弃旧资料。' };
}
