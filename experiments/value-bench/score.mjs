import {totalTokensOf} from './ledger.mjs';
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key,
    key === 'values' && Array.isArray(value[key]) ? [...new Map(value[key].map(v => [JSON.stringify(canonical(v)),canonical(v)])).entries()].sort(([a],[b]) => a.localeCompare(b)).map(([,v]) => v) : canonical(value[key])]));
  return value;
}
const sorted = values => [...new Set(values.map(x => JSON.stringify(canonical(x))))].sort();
export function validateAnswer(answer) {
  if (!answer || !['ATTRIBUTED_ONLY','UNKNOWN','CONFLICT','UNSUPPORTED'].includes(answer.classification) || !Array.isArray(answer.items)) throw Error('Invalid answer contract');
  for (const item of answer.items) if (!item || !Object.hasOwn(item,'value') || !Array.isArray(item.evidence) || item.evidence.some(e => !e || typeof e.source_id !== 'string' || typeof e.quote !== 'string' || !e.quote)) throw Error('Invalid evidence contract');
  if (['UNKNOWN','UNSUPPORTED'].includes(answer.classification) && answer.items.length) throw Error('Unknown answers cannot assert facts');
  return answer;
}
export function validateCitations(answer, sources) {
  validateAnswer(answer);
  for (const item of answer.items) {
    if (!item.evidence.length) throw Error('Answer value missing evidence');
    for (const evidence of item.evidence) if (!sources.some(s => (s.id || s.source_id) === evidence.source_id
      && (s.text || s.content || '').includes(evidence.quote))) throw Error('Answer quote absent from supplied evidence');
  }
  return answer;
}
export function scoreAnswer(question, answer, sources, status = 'SUCCEEDED') {
  const base = { question_id: question.id, status, expected_classification: question.expected.classification,
    human_semantic_status: 'PENDING', gold_status: question.gold_status, independently_verified: false };
  if (status !== 'SUCCEEDED') return { ...base, correct: false, classification_match: false, value_match: false, citation_integrity: false };
  try { validateAnswer(answer); } catch { return { ...base, status:'INVALID_ANSWER', correct:false, classification_match:false, value_match:false, citation_integrity:false }; }
  const classification_match = answer.classification === question.expected.classification;
  const value_match = JSON.stringify(sorted(answer.items.map(x => x.value))) === JSON.stringify(sorted(question.expected.values));
  const evidence = answer.items.flatMap(i => i.evidence);
  const citation_integrity = evidence.every(e => sources.some(s => s.id === e.source_id && s.text.includes(e.quote))) && (!answer.items.length || answer.items.every(i => i.evidence.length));
  const required_sources_present = (question.expected.evidence || []).every(id => evidence.some(e => e.source_id === id));
  return { ...base, classification_match, value_match, citation_integrity, required_sources_present,
    correct: classification_match && value_match && citation_integrity && required_sources_present,
    note: 'Programmatic agreement with draft gold; citation existence is not semantic entailment.' };
}
export function makeReport({ runId, mode, rows, attempts, usage,timingEvents=[] }) {
  const variants = [...new Set(rows.map(r => r.variant))];
  const grouped = new Map();
  for (const attempt of attempts) {
    const dimensions = {variant:attempt.variant || 'UNSPECIFIED',phase:attempt.phase || 'UNSPECIFIED',snapshot:attempt.snapshot || 'UNSPECIFIED',round:attempt.round ?? null};
    const key = JSON.stringify(dimensions);
    if (!grouped.has(key)) grouped.set(key,{...dimensions,attempts:0,known_total_tokens:0,unknown_usage_attempts:0,failed_attempts:0});
    const group = grouped.get(key); group.attempts++;
    if (totalTokensOf(attempt.usage) !== null) group.known_total_tokens += totalTokensOf(attempt.usage);
    else group.unknown_usage_attempts++;
    if (attempt.status !== 'SUCCEEDED') group.failed_attempts++;
  }
  const queryPhases = new Set(['ANSWER','ROUTE','QUERY_EMBED']);
  const curves = variants.map(variant => {
    const relevant = attempts.filter(a => a.variant === variant), variantRows = rows.filter(r => r.variant === variant);
    const cohorts = new Set(variantRows.map(r => JSON.stringify([r.group,r.snapshot,r.round]))).size || 1;
    const complete = relevant.length > 0 && relevant.some(a => queryPhases.has(a.phase) && a.status === 'SUCCEEDED')
      && relevant.every(a => a.status === 'SUCCEEDED' && totalTokensOf(a.usage) !== null)
      && variantRows.length > 0 && variantRows.every(r => r.status === 'SUCCEEDED');
    const setup = relevant.filter(a => !queryPhases.has(a.phase)).reduce((n,a) => n+(totalTokensOf(a.usage) || 0),0)/cohorts;
    const perQuery = relevant.filter(a => queryPhases.has(a.phase)).reduce((n,a) => n+(totalTokensOf(a.usage) || 0),0)/(variantRows.length || 1);
    return {variant,scenario_only:true,usage_complete:complete,setup_tokens:complete ? setup : null,
      mean_query_tokens:complete ? perQuery : null,points:[1,10,100].map(n => ({queries:n,total_tokens:complete ? setup+n*perQuery : null,cost:null})),
      break_even:null,price_status:'NOT_CONFIGURED',note:'Hypothetical workload, not measured extra queries. No monetary savings or equal-quality claim.'};
  });
  const baseline = curves.find(c => c.variant === 'FULLTEXT');
  if (baseline?.usage_complete) for (const curve of curves) if (curve.variant !== 'FULLTEXT' && curve.usage_complete
    && baseline.mean_query_tokens > curve.mean_query_tokens) curve.break_even = Math.max(1,Math.ceil((curve.setup_tokens-baseline.setup_tokens)/(baseline.mean_query_tokens-curve.mean_query_tokens)));
  const fraction = (numerator,denominator) => ({numerator,denominator,rate:denominator ? numerator/denominator : null});
  const metrics = [];
  for (const variant of variants) for (const snapshot of [...new Set(rows.filter(r => r.variant === variant).map(r => r.snapshot))]) {
    const selected = rows.filter(r => r.variant === variant && r.snapshot === snapshot);
    const answerable = selected.filter(r => r.score.expected_classification === 'ATTRIBUTED_ONLY');
    const unknown = selected.filter(r => ['UNKNOWN','UNSUPPORTED'].includes(r.score.expected_classification));
    const conflicts = selected.filter(r => r.score.expected_classification === 'CONFLICT');
    const assertions = selected.filter(r => r.answer?.items?.length > 0);
    const covered = selected.filter(r => r.status === 'SUCCEEDED' && r.answer?.route_status === 'MATCHED');
    metrics.push({variant,snapshot,status:'DEVELOPMENT_DRAFT',
      answerable_correct: fraction(answerable.filter(r => r.score.correct).length,answerable.length),
      refusal_correct:fraction(unknown.filter(r => r.status === 'SUCCEEDED' && r.answer?.classification === r.score.expected_classification).length,unknown.length),
      conflict_detected:fraction(conflicts.filter(r => r.status === 'SUCCEEDED' && r.answer?.classification === 'CONFLICT').length,conflicts.length),
      citation_integrity:fraction(assertions.filter(r => r.status === 'SUCCEEDED' && r.score.citation_integrity).length,assertions.length),
      execution_success:fraction(selected.filter(r => r.status === 'SUCCEEDED').length,selected.length),
      coverage:variant === 'CQFORGE' ? fraction(covered.length,selected.length) : null,
      covered_correct:variant === 'CQFORGE' ? fraction(covered.filter(r => r.score.correct).length,covered.length) : null,
      human_semantic_status:'PENDING',note:'Draft programmatic metrics. Failures remain in applicable question denominators; citation integrity is not entailment.'});
  }
  const timings = new Map();
  const measured = [...timingEvents.map(e => ({...e,source:'WORKFLOW'})),
    ...rows.map(r => ({...r,phase:'QUERY',source:'WORKFLOW'})),...attempts.map(a => ({...a,source:'ATTEMPT'}))];
  for (const event of measured) {
    if (!Number.isFinite(event.duration_ms) || event.duration_ms < 0) continue;
    const dimensions = {source:event.source,variant:event.variant,phase:event.phase,snapshot:event.snapshot};
    const key = JSON.stringify(dimensions);
    if (!timings.has(key)) timings.set(key,{...dimensions,count:0,total_ms:0,min_ms:event.duration_ms,max_ms:0});
    const bucket = timings.get(key);bucket.count++;bucket.total_ms+=event.duration_ms;bucket.min_ms=Math.min(bucket.min_ms,event.duration_ms);bucket.max_ms=Math.max(bucket.max_ms,event.duration_ms);
  }
  return { run_id:runId, mode, status:'DEVELOPMENT_EVALUATION_ONLY', gold_status:'DRAFT_REQUIRES_HUMAN_CONFIRMATION',
    value_conclusion:'NOT_ESTABLISHED', independently_verified:false, usage, attempts,
    usage_breakdown:[...grouped.values()].map(g => ({...g,total_tokens:g.unknown_usage_attempts ? null : g.known_total_tokens})),cost_curves:curves,
    metrics,timing_events:timingEvents,timing_breakdown:[...timings.values()].map(t => ({...t,mean_ms:t.total_ms/t.count})),
    timing_note:'Measured wall-clock durations only. Workflow and attempt timings overlap and must not be added together. No human time inferred.',
    summary: variants.map(variant => { const group = rows.filter(r => r.variant === variant); return { variant,
      correct:group.filter(r => r.score.correct).length, denominator:group.length,
      failed:group.filter(r => r.status !== 'SUCCEEDED').length, human_semantic_pending:group.length }; }), rows };
}
export function reportCsv(report) {
  const cells = row => row.map(x => '"'+String(x ?? '').replaceAll('"','""')+'"').join(',');
  return [cells(['variant','group','snapshot','round','question_id','status','correct','citation_integrity','human_semantic_status','note','duration_seconds']),
    ...report.rows.map(r => cells([r.variant,r.group,r.snapshot,r.round,r.question_id,r.status,r.score.correct,r.score.citation_integrity,r.score.human_semantic_status,r.semantic_review?.note,r.semantic_review?.duration_seconds]))].join('\n')+'\n';
}
