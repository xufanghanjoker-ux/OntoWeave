/** Real CQForge benchmark adapter. Offline mode measures wiring, never model quality. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateInput, runPipeline, sha } from './engine.mjs';
import { proposeCQs, confirmCQProposal } from './cq-proposals.mjs';
import { createCapabilityCatalog, routeQuestion, executeTyped } from './capabilities.mjs';
import { answerQuestion } from '../experiments/value-bench/runner.mjs';
import { validateAnswer } from '../experiments/value-bench/score.mjs';
import { dimensions } from '../fixtures/tools/evaluator-gate.mjs';

import {synthesizeAnswer} from './answer-synthesis.mjs';

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const nameOf = (job, id) => job.result.schema.entities.find(e => e.id === id)?.name || id;
const shownValue = (job, claim) => job.result.schema.predicates.find(p => p.id === claim.predicate_id)?.value_type === 'ENTITY'
  ? nameOf(job, claim.value) : claim.value;

/** Same answerer as baselines, bounded by the actual SQL-selected claims. */
export async function answerFromClaims({ job, question, gate, provider, call, presentation='EXACT',synthesis=false,reviewProvider,onEvent }) {
  assert(gate && ['ATTRIBUTED_ONLY', 'UNKNOWN', 'CONFLICT', 'UNSUPPORTED'].includes(gate.classification), '未知查询门禁状态');
  if (['UNKNOWN', 'UNSUPPORTED'].includes(gate.classification)) return { classification: gate.classification, items: [],
    reason: gate.reason || '', gate: gate.classification };
  assert(provider && typeof provider.complete === 'function', '请配置回答模型');
  if(synthesis&&presentation==='SUMMARY'&&!job.benchmark_run_id)return synthesizeAnswer({job,question,gate,provider,reviewProvider,onEvent,fallback:raw=>answerFromClaims({job,question,gate,provider:{complete:async()=>({content:JSON.stringify(raw)})},presentation,synthesis:false})});
  const claims = gate.comparisons ? gate.comparisons.filter(c => ['ATTRIBUTED_ONLY','CONFLICT'].includes(c.classification)).flatMap(c => c.claims || []) : gate.claims || [];
  assert(claims.length > 0, '有值的门禁必须包含对应声明');
  const predicate=job.result.schema.predicates.find(p=>p.id===gate.predicate_id||p.id===job.result.schema.cq_plans.find(q=>q.template===(gate.query_template||'COMPARE'))?.predicate_id);
  const summaryAllowed=presentation==='SUMMARY'&&!job.benchmark_run_id&&gate.classification!=='CONFLICT'&&gate.query_template!=='ENTITIES'&&predicate?.value_type==='STRING';
  const evidence = claims.map(c => ({ source_id: c.source_id, text: c.quote, claim_id: c.id,
    subject: nameOf(job, c.subject_id),subject_id:c.subject_id, value: shownValue(job, c), gate: gate.classification,scope:c.scope,unit:c.unit,comparator:c.comparator,effective_from:c.effective_from,time_raw:c.time_raw,modality:c.modality,
    ...(gate.comparisons ? { comparison_subject: nameOf(job, c.subject_id) } : {}) }));
  // Use the connected model profile; a fixed tiny answer budget can truncate multi-subject results.
  const selected = provider;
  const commonInput = job.benchmark_answer_input || { seed_cqs: job.input.cqs.map(q => q.question), definitions: job.input.definitions };
  const answer = validateAnswer(await answerQuestion(selected, question, evidence, call, commonInput,{preserveModelProfile:!job.benchmark_run_id,bindStructuredEvidence:!job.benchmark_run_id,summaryView:summaryAllowed,answerTemplate:gate.query_template||(gate.comparisons?'COMPARE':'FACTS')}));
  assert.equal(answer.classification, gate.classification, '回答器不得更改查询门禁分类');
  assert(answer.items.length > 0, '有值的回答不能遗漏所有结果');
  for (const item of answer.items) {
    let supported;
    if (gate.comparisons) {
      assert(item.value && typeof item.value === 'object' && !Array.isArray(item.value)
        && typeof item.value.entity === 'string' && Array.isArray(item.value.values) && item.value.values.length > 0,
      '比较结果必须保留主体和对应values');
      const entities = job.result.schema.entities.filter(e => e.name === item.value.entity || e.id === item.value.entity);
      assert.equal(entities.length, 1, '比较结果主体不存在或有同名歧义');
      supported = claims.filter(c => c.subject_id === entities[0].id);
      assert(item.value.values.every(v => supported.some(c => equal(shownValue(job, c), v))), '比较值不属于对应主体的查询结果');
      assert(item.value.values.every(v => supported.some(c => equal(shownValue(job, c), v)
        && item.evidence.some(e => e.source_id === c.source_id && e.quote === c.quote))), '比较值缺少对应主体声明证据');
    } else {
      const entityResult = gate.query_template === 'ENTITIES'
        || (gate.params && !Object.hasOwn(gate.params, 'subject_id') && !Object.hasOwn(gate.params, 'subject_ids'));
      supported = claims.filter(c => entityResult ? equal(nameOf(job, c.subject_id), item.value) || equal(c.subject_id, item.value)
        : equal(shownValue(job, c), item.value));
      assert(supported.length > 0, '回答值不属于查询门禁允许值，数值类型也必须一致');
    }
    assert(item.evidence.length > 0 && item.evidence.every(e => supported.some(c => e.source_id === c.source_id && e.quote === c.quote)),
      '引文必须绑定支持本项值的同一声明，不能引用任意合法原文');
    const qualified=supported.filter(c=>item.evidence.some(e=>e.source_id===c.source_id&&e.quote===c.quote));
    item.qualifiers=[...new Map(qualified.map(c=>[c.id,{claim_id:c.id,subject_id:c.subject_id,scope:c.scope,unit:c.unit,comparator:c.comparator,effective_from:c.effective_from,time_raw:c.time_raw,modality:c.modality}])).values()];
  }
  let complete;
  if (gate.comparisons) {
    complete = claims.every(c => answer.items.some(item => (item.value.entity === nameOf(job,c.subject_id) || item.value.entity === c.subject_id)
      && item.value.values.some(value => equal(value,shownValue(job,c)))));
  } else {
    const entityResult = gate.query_template === 'ENTITIES'
      || (gate.params && !Object.hasOwn(gate.params,'subject_id') && !Object.hasOwn(gate.params,'subject_ids'));
    const required = entityResult ? (gate.value || []).map(id=>nameOf(job,id)) : claims.map(c=>shownValue(job,c));
    complete = required.every(value => answer.items.some(item => equal(value,entityResult ? nameOf(job,item.value) : item.value)));
  }
  if(summaryAllowed){
    if(gate.comparisons)assert(gate.comparisons.filter(c=>c.classification==='ATTRIBUTED_ONLY').every(c=>answer.items.some(item=>item.value.entity===nameOf(job,c.subject_id)||item.value.entity===c.subject_id)),'INCOMPLETE_ANSWER: 要点回答也不能遗漏有据主体');
    answer.coverage={view:'SUMMARY',all_values_shown:complete,total_claims:claims.length,notice:'以下为有据要点；完整事实、条件和证据可展开查看。'};
    answer.full_result={classification:gate.classification,facts:claims.map(c=>({claim_id:c.id,subject_id:c.subject_id,subject:nameOf(job,c.subject_id),value:shownValue(job,c),scope:c.scope,unit:c.unit,comparator:c.comparator,effective_from:c.effective_from,time_raw:c.time_raw,source_id:c.source_id,quote:c.quote}))};
  }
  if (!complete&&!summaryAllowed) throw Object.assign(new Error('INCOMPLETE_ANSWER: 回答遗漏查询允许结果，不能作为完整成功答案'),{code:'INCOMPLETE_ANSWER'});
  return { ...answer, gate: gate.classification };
}

function offlineProvider(input) {
  const names = [...new Set(input.sources.map(s => s.content.match(/^(.{1,40}?)(?:计划在|在|支持)/)?.[1]).filter(Boolean))];
  if (!names.length) names.push('离线MOCK实体');
  const entities = names.map((name, i) => ({ id: 'mock_entity_' + i, name, type: 'mock_type' }));
  const schema = { entity_types: [{ id: 'mock_type', label: 'MOCK类型，非质量验证' }], entities,
    predicates: [{ id: 'mock_fact', label: 'MOCK属性，非语义验证', value_type: 'STRING', unit: null, cardinality: 'MANY' }],
    cq_plans: input.cqs.map(q => ({ cq_id: q.id, template: 'FACTS', subject_id: entities[0].id, predicate_id: 'mock_fact', object_value: null })) };
  const review = { coverage: Object.fromEntries(dimensions.map(d => [d, 'CHECKED'])), issues: [] };
  const provider = { model: 'OFFLINE_MOCK_NOT_QUALITY_MEASUREMENT', withMaxTokens: () => provider,
    async complete(messages) {
      const prompt = messages[0].content, payload = JSON.parse(messages[1].content);
      let output;
      if (prompt.includes('CQ建议助手')) output = { candidates: [], clarifications: [] };
      else if (prompt.includes('受限查询路由器')) {
        const entity = entities.find(e => payload.question.includes(e.name));
        output = entity && payload.capabilities.length ? { status: 'MATCHED', candidates: [{ capability_id: payload.capabilities[0].id,
          params: { subject_id: entity.id, object_value: null } }] } : { status: 'UNSUPPORTED', candidates: [], reason: 'OFFLINE_MOCK: 未测量真实路由能力' };
      } else if (prompt.includes('按提供的资料和问题回答')) output = { classification: 'UNKNOWN', items: [] };
      else if(prompt.includes('CQForge Builder'))output={schema};
      else if(prompt.includes('CQForge Extractor'))output={claims:[]};
      else if(prompt.includes('独立评审者'))output=review;
      else output={supported_scopes:[],unknowns:[],potential_errors:[]};
      assert(output, '离线MOCK调用超出预期');
      return { content: JSON.stringify(output), usage: {}, reported_model: provider.model };
    } };
  return provider;
}

export function createCQForgeAdapter({ provider, store, offline = false, runId, confirmSuggestions } = {}) {
  assert(store && typeof store.saveTask === 'function' && typeof store.queryPlan === 'function', '需要任务存储与参数化查询接口');
  if (!offline) assert(provider && typeof provider.complete === 'function', '真实评测需要显式模型配置');
  const models = new Map();
  return {
    async build(input, ctx) {
      const identity = { run_id: runId || ctx.runId, group: ctx.group || input.group_id, snapshot: ctx.snapshot || input.snapshot, round: ctx.round ?? 0 };
      assert(identity.run_id, '评测运行需要runId');
      const key = sha({ identity, input, mode: offline ? 'mock' : 'live', model: offline ? 'MOCK' : provider.model,
        config: offline ? null : { endpoint: provider.root, max_tokens: provider.maxTokens, thinking_mode: provider.thinkingMode ?? 'default', timeout_ms: provider.timeoutMs } });
      const previous = store.listTasks?.().find(t => t.benchmark_build_key === key);
      if (previous) {
        if (previous.status !== 'READY') throw Error('BLOCKED_AMBIGUOUS_BUILD: 先前构建未完成或未通过评审；请显式创建新评测运行');
        if (offline) models.set(previous.id, offlineProvider(previous.input));
        return { job_id: previous.id, catalog: createCapabilityCatalog(previous), source_map: previous.benchmark_source_map, mock: offline };
      }
      let validated = validateInput({ name: '评测 ' + identity.group + ' / ' + identity.snapshot, consent: true,
        definitions: input.definitions || '', cqs: input.seed_cqs,
        sources: input.sources.map(s => ({ title: s.title || s.id, content: s.text })) });
      const sourceMap = Object.fromEntries(validated.sources.map((s, i) => [s.id, input.sources[i].id]));
      const rawProvider = offline ? offlineProvider(validated) : provider;
      const id = randomUUID(), saved = {};
      const job = { id, input: validated, status: 'RUNNING', stage: 'cq_expansion', created_at: new Date().toISOString(), events: [],
        benchmark_run_id: identity.run_id, benchmark_build_key: key, benchmark_source_map: sourceMap,
        benchmark_answer_input: { seed_cqs: structuredClone(input.seed_cqs), definitions: input.definitions || '',
          ...(input.scope !== undefined ? { scope: structuredClone(input.scope) } : {}) },
        model: rawProvider.model, publication_approved: false, benchmark_mock: offline, benchmark_artifacts: saved };
      store.saveTask(job); models.set(id, rawProvider);
      let operation = 0;
      const counted = phase => ({ model: rawProvider.model, complete(messages) {
        return ctx.call(phase, 'cqforge_' + phase.toLowerCase() + '_' + (++operation), () => rawProvider.complete(messages), messages);
      } });
      try {
        const draft = await proposeCQs(validated, counted('CQ_EXPANSION'), { consent: true });
        saved.cq_proposal = draft; store.saveTask(job);
        if (draft.clarifications.some(c => c.required)) throw Error('BLOCKED_CLARIFICATION: CQ扩展提出必要语义澄清，不能自动确认');
        let confirmation;
        if (offline) confirmation = { selected_ids: draft.candidates.map(c => c.id) };
        else if (typeof confirmSuggestions === 'function') {
          // A caller-controlled human/preconfirmed-scope policy, not a second model approval.
          confirmation = await confirmSuggestions({ draft: structuredClone(draft), input: structuredClone(input),
            context: structuredClone(identity) });
          assert(confirmation && Array.isArray(confirmation.selected_ids), 'BLOCKED_CONFIRMATION: 确认策略未返回明确选择');
        } else if (draft.candidates.length) throw Error('BLOCKED_CONFIRMATION: 扩展候选需要人工或显式预确认范围策略，不能静默弃用或自动全选');
        else confirmation = { selected_ids: [] };
        validated = confirmCQProposal(draft, confirmation);
        job.benchmark_expansion_confirmation = { policy: offline ? 'OFFLINE_MOCK_ONLY' : typeof confirmSuggestions === 'function' ? 'EXPLICIT_CALLER_CONFIRMATION' : 'NO_CANDIDATES',
          selected_ids: [...confirmation.selected_ids], candidate_count: draft.candidates.length };
        job.input = validated;
        job.result = await runPipeline(validated, counted('BUILD'), {
          save(name, data) { saved[name] = data; store.saveTask(job); },
          update(stage, detail) { job.stage = stage; job.events.push({ stage, ...(detail || {}) }); store.saveTask(job); }
        });
        job.status = job.result.status; job.stage = job.status;
        job.finished_at = new Date().toISOString(); store.saveTask(job);
        if (job.status !== 'READY') throw Error('BLOCKED_REVIEW: 构建未通过评审，不能评测为成功知识库');
        return { job_id: job.id, catalog: createCapabilityCatalog(job), source_map: sourceMap, mock: offline };
      } catch (error) {
        if (job.status === 'RUNNING') job.status = error.message.startsWith('BLOCKED_CLARIFICATION') ? 'BLOCKED_CLARIFICATION'
          : error.message.startsWith('BLOCKED_CONFIRMATION') ? 'BLOCKED_CONFIRMATION' : 'FAILED';
        job.error = error.message; job.finished_at = new Date().toISOString(); store.saveTask(job); throw error;
      }
    },
    async query({ question, artifact }, ctx) {
      const job = store.getTask(artifact.job_id); assert(job && job.benchmark_run_id === (runId || ctx.runId), '评测任务或运行身份不匹配');
      const rawProvider = models.get(job.id) || (offline ? offlineProvider(job.input) : provider);
      const counted = { model: rawProvider.model, complete: messages => ctx.call('ROUTE', 'route_' + question.id,
        () => rawProvider.complete(messages), messages) };
      const routed = await routeQuestion(job, artifact.catalog, question.text, counted, { consent: true });
      if (routed.status !== 'MATCHED') return { classification: routed.status === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'UNKNOWN', items: [], reason: routed.reason,
        route_status: routed.status, version: job.id };
      const gate = await executeTyped(job, artifact.catalog, routed.capability_id, routed.params, {
        question: question.text, queryPlan: (id, plan, inputOverride) => store.queryPlan(id, plan, inputOverride)
      });
      gate.query_template = routed.binding.plan.template;
      const answer = await answerFromClaims({ job, question, gate, provider: rawProvider, call: ctx.call });
      return { ...answer, route_status: routed.status, capability_id: routed.capability_id, params: routed.params, version: job.id,
        items: answer.items.map(item => ({ ...item, evidence: item.evidence.map(e => ({ ...e,
        source_id: artifact.source_map[e.source_id] || e.source_id })) })) };
    }
  };
}
