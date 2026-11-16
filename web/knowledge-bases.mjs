/** Stable library identity is derived from verified revision ancestry, never from names. */
import { sha } from './engine.mjs';

export function knowledgeBases(tasks) {
  const visible = tasks.filter(task => !task.benchmark_run_id);
  const byId = new Map(visible.map(task => [task.id, task]));
  const rootFor = task => {
    const seen = new Set(); let current = task;
    while (current.revision?.parent_id && byId.has(current.revision.parent_id)) {
      if (seen.has(current.id)) throw Error('版本关系存在循环，不能自动合并知识库');
      seen.add(current.id); current = byId.get(current.revision.parent_id);
    }
    return current;
  };
  const groups = new Map();
  for (const task of visible) {
    const root = rootFor(task), id = 'kb_' + root.id;
    if (!groups.has(id)) groups.set(id, { id, root_task_id: root.id, name: root.input.name, tasks: [] });
    groups.get(id).tasks.push(task);
  }
  return [...groups.values()].map(group => {
    const ordered = group.tasks.sort((a,b) => (a.created_at || '').localeCompare(b.created_at || '') || a.id.localeCompare(b.id));
    const latest = ordered.at(-1);
    const ready = ordered.filter(t => t.status === 'READY' && t.result?.status === 'READY');
    const current = ready.at(-1) || null;
    return { id: group.id, name: group.name, root_task_id: group.root_task_id,
      current_task_id: current?.id || null, latest_task_id: latest.id,
      open_task_id: current?.id || latest.id, status: current ? 'READY' : latest.status,
      latest_status: latest.status, version_count: ordered.length, task_ids: ordered.map(t => t.id),
      source_count: (current || latest).input.sources.length, cq_count: byId.get(group.root_task_id).input.cqs.length,
      learned_question_count:Math.max(0,(current||latest).input.cqs.length-byId.get(group.root_task_id).input.cqs.length),
      claim_count: (current || latest).result?.claims?.length || 0,
      updated_at: latest.created_at, lineage_incomplete: Boolean(byId.get(group.root_task_id).revision?.parent_id) };
  }).sort((a,b) => (b.updated_at || '').localeCompare(a.updated_at || '') || a.id.localeCompare(b.id));
}

/** Additive, rebuildable index. Original tasks and attachments are never rewritten. */
export function indexKnowledgeBases(store) {
  const bases = knowledgeBases(store.listTasks());
  store.transaction(() => {
    for (const base of bases) {
      const old = store.getRecord('knowledge_base_v1', base.id);
      if (sha(old) !== sha(base)) store.putRecord('knowledge_base_v1', base.id, base);
    }
  });
  return bases;
}
