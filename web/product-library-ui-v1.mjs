/** Main-product library templates. Library/source snapshots are used directly;
 * no legacy task, claim, READY result or reviewed fact is manufactured. */
export const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button=(label,action,extra='')=>`<button class="btn ${['ask-question','product-save-models','product-save-source'].includes(action)?'primary':''}" data-action="${action}" ${extra}>${label}</button>`;
const badge=text=>`<span class="badge yellow">${escape(text)}</span>`;
const stages={QUEUED:'等待后台整理',RETRIEVING:'寻找相关原文',EXTRACTING:'整理候选联系',VALIDATING:'核对结构和原文位置',INDEX_PENDING:'正在更新检索索引',COMPLETED:'本次整理已完成',WAIT_EVIDENCE:'等待补充资料',WAIT_REVIEW:'有候选需要进一步核对',SUPERSEDED:'资料已更新，旧任务停止',FAILED:'本次整理未完成',STOPPED:'已停止'};
export const modelDefaults={generation:{label:'LLM · 整理与回答',model:'qwen3.8-flash',base_url:'https://cn-beijing.maas.qianwenaiapi.com/compatible-mode/v1',protocol:'openai-compatible'},embedding:{label:'Embedding · 原文与候选检索',model:'qwen3.7-text-embedding-flash',base_url:'https://cn-beijing.maas.qianwenaiapi.com/api/v1/services/embeddings/text-embedding/text-embedding',protocol:'dashscope-native'},reranker:{label:'Reranker · 检索重排（可选）',model:'qwen3.7-text-rerank',base_url:'https://cn-beijing.maas.qianwenaiapi.com/api/v1/services/rerank/text-rerank/text-rerank',protocol:'dashscope-native'}};
export function libraryCard(base){return `<button class="kb-card" data-action="product-library" data-id="${escape(base.id)}"><div class="kb-card-top"><span class="kb-icon">◇</span>${badge('原文可读')}</div><h3>${escape(base.name)}</h3><p>${base.cq_count?escape(base.cq_count)+' 个示例问题':'根据资料发现知识范围'}</p><div class="kb-card-footer"><span>${escape(base.source_count??base.sources?.filter(s=>s.active).length??0)} 份资料</span><span>打开 →</span></div></button>`;}
export function overview(bases=[]){return `<div class="page-head"><div><h1>工作空间</h1><p>从资料发现问题范围，整理可复用的知识与原文依据。</p></div>${button('新建知识库','new')}</div><section class="workspace-section"><div class="panel-head"><h2>知识库</h2><span class="muted small">${bases.length} 个知识库</span></div>${bases.length?`<div class="kb-grid">${bases.map(libraryCard).join('')}</div>`:`<section class="panel empty-state"><h2>从上传资料开始</h2><p>系统根据资料发现问题与适用主体，整理图谱和索引；用途或示例问题可以留空。</p>${button('上传资料，创建知识库','new')}</section>`}</section>`;}
export function learningStatus(view,models={}){
 const jobs=view?.jobs??{},head=jobs.head??{},rows=(jobs.items??[]).filter(r=>r.job?.snapshot?.source_epoch===undefined||r.job.snapshot.source_epoch===view?.library?.source_epoch);
 const active=rows.filter(r=>['QUEUED','RUNNING','WAIT_MODEL_CONFIGURATION'].includes(r.status));
 const waiting=(view?.learning??[]).some(r=>['WAITING','WAIT_MODEL_CONFIGURATION'].includes(r.status)&&(r.source_epoch===undefined||r.source_epoch===view?.library?.source_epoch)),missingModels=waiting&&(!models.generation?.configured||!models.embedding?.configured);
 const incomplete=rows.some(r=>['FAILED','WAIT_REVIEW','WAIT_EVIDENCE'].includes(r.job?.stage));
 const pendingUnknown=rows.some(r=>r.job?.attempts?.some(a=>a.outcome==='UNKNOWN'));
 const sending=rows.some(r=>r.job?.attempts?.some(a=>a.outcome==='STARTED'));
 const returned=rows.flatMap(r=>r.job?.attempts??[]).filter(a=>a.phase?.startsWith('EXTRACTION')&&a.outcome==='RETURNED').length;
 const published=view?.published_graph?.publication_status==='PUBLISHED'&&view.published_graph?.index_status==='READY'?view.published_graph:null,partial=Boolean(published&&partialPublication(view));
 return `<section class="learning-status product-learning-status" id="product-learning-status" role="status"><div><strong>${partial?'部分就绪':pendingUnknown?'上次调用结果尚未确认，已暂停自动重发':sending?'正在抽取知识，请稍候…':missingModels||active.some(r=>r.status==='WAIT_MODEL_CONFIGURATION')?'等待模型配置，原文仍可阅读':active.length?'正在后台整理相关资料…':waiting?'等待后台整理相关资料':incomplete?'本次后台整理尚未完成，可继续原文提问':published?'正式图谱已发布':head.active_usable?'候选索引已就绪':'原文已保存，可直接提问'}</strong><p class="help">${published?(partial?'已发布已核实任务的子图版本 ':'正式图版本 ')+escape(published.published_graph_revision)+' · 索引 READY':head.active_usable?'候选图版本 '+escape(head.active_graph_revision??'未说明')+' · 索引 '+escape(head.index_state??'未说明'):'候选图可稍后补齐，回答以当前有效原文为依据。'}${active.length?' · '+escape(stages[active[0].job?.stage]??active[0].job?.stage??'准备中'):''}${returned?' · 已收到 '+returned+' 批抽取结果':''}${partial&&pendingUnknown?' · 存在尚未确认的调用，已暂停自动重发':''}</p>${scopeReadinessMarkup(view)}</div></section>`;
}
const cqText=q=>typeof q==='string'?q:q.question??q.text??'';
const textOf=value=>typeof value==='string'?value:value?.label??value?.surface??value?.name??value?.text??'';
const taskTitle=(title,subject)=>typeof title==='string'&&subject?title.replace(/\{subject\}/g,()=>subject):title;
const scopeStatuses={SCOPE_PROPOSED:'已发现候选知识范围',PARTIAL_SCOPE:'知识范围仅完成部分发现',NO_SCOPE_DISCOVERED:'尚未发现问题族',UNKNOWN_NO_RETRY:'范围发现结果尚未确认，已暂停自动重发',QUEUED:'等待发现知识范围',PENDING:'等待发现知识范围',WAITING:'等待发现知识范围',RUNNING:'正在发现问题族与适用主体',DISCOVERING:'正在发现问题族与适用主体',EXTRACTING:'正在发现问题族与适用主体',WAIT_MODEL_CONFIGURATION:'等待模型配置',READY:'范围计划已形成',COMPLETED:'范围计划已形成',NO_SUPPORTED_CQS:'尚未发现有据的问题范围',NO_CANDIDATES:'尚未发现有据的问题范围',WAIT_EVIDENCE:'当前资料依据不足',FAILED:'本次范围发现未完成',BLOCKED:'本次范围发现受阻',UNKNOWN:'范围发现结果尚未确认',RESULT_UNKNOWN:'范围发现结果尚未确认',SUPERSEDED:'资料已变化，等待重新发现',SOURCE_INVALIDATED:'资料已变化，等待重新发现'};
export function currentDocumentScope(view){
 const scope=view?.document_scope;
 return scope&&Number.isSafeInteger(scope.source_epoch)&&scope.source_epoch===view?.library?.source_epoch?scope:null;
}
function usesPartialScopePolicy(scope){return Boolean(scope&&(scope.readiness_policy==='PARTIAL_SUPPORTED_TASKS_V1'||scope.publication_policy==='PARTIAL_SUPPORTED_TASKS_V1'||scope.partial_available===true||scope.scope_publication_status==='PARTIALLY_READY'));}
export function partialScopeEnabled(view){return usesPartialScopePolicy(currentDocumentScope(view));}
function partialPublication(view){return view?.published_graph?.scope_availability==='PARTIAL'||view?.published_graph?.publication_mode==='PARTIAL_SCOPE'||partialScopeEnabled(view)&&view.document_scope.scope_publication_status==='PARTIALLY_READY';}
const coverageStatesProtocol='SOURCE_CANDIDATE_COVERAGE_STATES_V1';
const hasCoverageStates=row=>Object.hasOwn(row,'source_evidence_state')||Object.hasOwn(row,'candidate_answer_state');
function attachCoverageObservation(scope,row){
 if(!hasCoverageStates(row))return row;
 const matches=(scope?.row_observations??[]).filter(o=>o.task_id===row.task_id);
 // These are Rust observations, not decisions inferred from the model's two axes.
 const observation=matches.length===1?matches[0]:matches.length===0&&row.decision_origin==='RUST_DERIVED'?row:null;
 const valid=observation&&observation.source_evidence_state===row.source_evidence_state&&observation.candidate_answer_state===row.candidate_answer_state&&typeof observation.protocol_valid==='boolean'&&Array.isArray(observation.error_codes);
 return {...row,coverage_observation:valid?observation:null,coverage_observation_issue:valid?null:matches.length>1?'覆盖核实记录重复，需要重新核对。':'尚未收到与原始观察一致的范围核实结果。'};
}
function coverageRows(scope){
 const rows=Array.isArray(scope?.coverage)?scope.coverage:[],tasks=scope?.tasks??[],ids=new Set(tasks.map(t=>t.id)),byId=new Map();
 for(const row of rows)if(row.task_id&&ids.has(row.task_id))byId.set(row.task_id,byId.has(row.task_id)?{task_id:row.task_id,status:'UNKNOWN',reason:'该任务的覆盖记录重复，需要重新核对。'}:attachCoverageObservation(scope,row));
 return [...tasks.map(task=>byId.get(task.id)??{task_id:task.id,status:'NOT_CHECKED',execution_status:'NOT_CHECKED'}),...rows.filter(row=>!row.task_id||!ids.has(row.task_id)).map(row=>attachCoverageObservation(scope,row))];
}
function taskCoverageDecision(scope,row){
 if(hasCoverageStates(row)){
  const o=row.coverage_observation;
  if(!o)return null;
  if(o.protocol_valid===false&&o.effective_status==='PROTOCOL_HOLD')return 'PROTOCOL_HOLD';
  return o.protocol_valid===true&&o.error_codes.length===0&&o.derived_decision===o.effective_status?o.derived_decision:null;
 }
 if(scope?.review_protocol===coverageStatesProtocol&&row.execution_status!=='NOT_CHECKED')return null;
 return row.decision??row.status;
}
function scopeAuditDeferred(scope,row){
 return row.scope_audit_deferred===true&&row.scope_audit_status==='DEFERRED'&&row.effective_status==='TASK_DEFERRED'&&typeof scope?.scope_task_restriction_hash==='string'&&scope.scope_task_restriction_hash.length>0&&Array.isArray(scope.audit_deferred_task_ids)&&scope.audit_deferred_task_ids.includes(row.task_id)&&taskCoverageDecision(scope,row)==='SUPPORTED';
}
function taskCoverageState(scope,row){
 const decision=taskCoverageDecision(scope,row);
 if(scopeAuditDeferred(scope,row))return 'auditDeferred';
 if(decision==='PROTOCOL_HOLD'||['TECHNICAL_HOLD','TECHNICAL_BLOCK','TECHNICAL_BLOCKED','PROTOCOL_HOLD','FAILED','UNKNOWN_NO_RETRY'].includes(row.execution_status??row.status))return 'technical';
 if(decision==='SUPPORTED')return (usesPartialScopePolicy(scope)?typeof scope.coverage_receipt_hash==='string'&&scope.coverage_receipt_hash.length>0&&Array.isArray(scope.supported_task_ids)&&scope.supported_task_ids.includes(row.task_id)&&Array.isArray(scope.reusable_task_ids)&&scope.reusable_task_ids.includes(row.task_id):!Array.isArray(scope.supported_task_ids)||scope.supported_task_ids.includes(row.task_id))?'supported':'unresolved';
 if(decision==='SOURCE_INSUFFICIENT'||decision==='INSUFFICIENT_EVIDENCE')return 'insufficient';
 if(decision==='EXTRACTION_GAP')return 'gap';
 if(['NOT_CHECKED','UNCHECKED'].includes(decision)||row.execution_status==='NOT_CHECKED')return 'unchecked';
 return 'unresolved';
}
export function scopeReadiness(view){
 const scope=currentDocumentScope(view);if(!scope)return null;
 const tasks=new Map((scope.tasks??[]).map(t=>[t.id,t])),counts={supported:0,unresolved:0,technical:0,insufficient:0,gap:0,unchecked:0},supportedIds=[];
 for(const row of coverageRows(scope))if(tasks.has(row.task_id)){const status=taskCoverageState(scope,row);counts[status]=(counts[status]??0)+1;if(status==='supported')supportedIds.push(row.task_id);}
 return {scope,total:tasks.size,counts,supportedIds};
}
function scopeReadinessMarkup(view){
 if(!partialScopeEnabled(view))return '';
 const data=scopeReadiness(view),scope=data.scope,c=data.counts;
 const tech=Number.isSafeInteger(scope.technical_blocked_task_count)&&scope.technical_blocked_task_count>=0?`技术阻断 ${scope.technical_blocked_task_count} 项任务`:c.technical?`技术阻断 ${c.technical} 项任务`:'技术阻断任务数尚未确认';
 const technicalCandidates=Number.isSafeInteger(scope.technical_candidate_count)&&scope.technical_candidate_count>=0?`<p class="help">技术候选记录 ${scope.technical_candidate_count} 项；未将候选数量折算为受阻任务数。</p>`:'';
 const pendingCandidates=Number.isSafeInteger(scope.pending_review_candidate_count)&&scope.pending_review_candidate_count>=0?`<p class="help">另有 ${scope.pending_review_candidate_count} 项候选待核实，尚不直接计作已覆盖任务。</p>`:'';
 return `<div class="product-scope-readiness" role="status"><p><strong>已覆盖 ${c.supported} / ${data.total} 个任务</strong> · 全部任务保留</p><p class="help">待核实 ${c.unresolved} · 抽取缺口 ${c.gap} · 资料不足 ${c.insufficient} · 尚未核对 ${c.unchecked}${c.auditDeferred?' · 暂缓复用 '+c.auditDeferred:''} · ${tech}</p>${technicalCandidates}${pendingCandidates}<p class="help">仅通过事实与范围核实的已覆盖任务可复用；其余问题继续查找原文依据，依据不足或处理未完成会明确说明。</p></div>`;
}
export function questionSuggestions(view){
 const scope=currentDocumentScope(view),suggestions=[];
 for(const family of scope?.families??[]){
  const template=family.question_template??family.question;
  if(typeof template!=='string'||!template.trim())continue;
  const slot=/\{subject\}|\{主体\}|<subject>|\[主体\]/g;
  if(slot.test(template))for(const subject of family.subjects??[]){const label=textOf(subject);if(label)suggestions.push(template.replace(slot,()=>label));}
  else if(!/[{}<>]/.test(template))suggestions.push(template);
 }
 const generated=(scope?.generated_cqs??[]).map(cqText).filter(q=>typeof q==='string'&&!/[{}<>]/.test(q));
 return [...new Set([...suggestions,...generated,...(view?.library?.cqs??[]).map(cqText)].filter(q=>typeof q==='string'&&q.trim()))];
}
function scopeState(state){
 const view=state.productView,scope=currentDocumentScope(view),stale=Boolean(view?.document_scope&&!scope);
 if(stale)return {scope:null,label:'资料已变化，等待重新发现',message:'旧的问题族与主体不作为当前资料范围展示。'};
 if(!scope)return {scope:null,label:state.productModels?.generation?.configured===false?'等待模型配置':'等待发现知识范围',message:'尚未收到当前资料的问题族与主体记录，不推测可问范围。'};
 const noTasks=(scope.errors??[]).some(e=>e?.code==='DOCUMENT_SCOPE_NO_SUPPORTED_TASKS');
 return {scope,label:noTasks?'尚未发现可执行的问题范围':scopeStatuses[scope.status]??'知识范围状态待确认',message:scope.message??'以下是当前资料发现的整理目标；范围计划已形成不代表图谱已发布或每项都有答案。'};
}
function scopePublicationMarkup(scope){
 if(!scope?.scope_publication_status)return '';
 const labels={READY:'范围覆盖核对已通过；正式图是否发布，以图谱状态为准。',PARTIALLY_READY:'部分范围已通过核实；全量任务尚未完成，正式子图是否可用以发布状态为准。',LIMITED_AVAILABLE:'本次范围仅有限可用：部分任务在已检查资料中依据不足，缺口会保留。',BLOCKED:'范围覆盖尚未通过，当前范围不能据此宣告整理完成。',NOT_CHECKED:'需求覆盖尚未核对。',STARTED:'正在独立核对问题范围与原文依据。',FAILED:'范围覆盖核对未完成，已保留处理记录。',UNKNOWN_NO_RETRY:'范围覆盖核对结果尚未确认，系统不会自动重发。'};
 return `<p class="help product-scope-coverage-status" role="status">${escape(labels[scope.scope_publication_status]??'范围覆盖状态待确认。')}</p>`;
}
function scopeNormalizationMarkup(scope){
 const n=scope?.normalization;if(!n)return '';
 const count=Number.isSafeInteger(n.original_proposals)?n.original_proposals:null;
 if(n.status==='STARTED')return `<p class="help">正在归一${count===null?'':count+' 项'}原始问题，并检查资料中的其他适用主体。</p>`;
 const summary=count===null?'':`${count} 项原始问题 → ${n.canonical_families??0} 个问题族、${n.subjects??0} 个主体提及。`;
 return `<p class="help">${escape(summary)}首次整理计划保留全部发现范围；分批执行不会删除其他任务。${n.unresolved?.length?'还有 '+n.unresolved.length+' 项原始需求待归一，尚不作为全范围建图完成。':''}</p>`;
}
export function discoveryProgress(state){
 const {scope,label,message}=scopeState(state);
 const progress=scope?.progress,counts=Number.isSafeInteger(progress?.completed)&&progress.completed>=0&&Number.isSafeInteger(progress?.total)&&progress.total>=progress.completed;
 const errorLabels={DOCUMENT_SCOPE_MODEL_NOT_CONFIGURED:'连接生成模型后继续发现范围。',DOCUMENT_FAMILY_NORMALIZATION_UNRESOLVED:'部分候选问题尚未能归一或确认适用主体；已保留全部发现项，当前不作为全范围建图完成。',FAMILY_NORMALIZE_REVIEW_RESOURCE_LIMIT:'本次资料超出单次归一容量，已保留资料和候选问题，需要分层处理。',DOCUMENT_SCOPE_NO_SUPPORTED_TASKS:'本次未形成可执行的问题范围；已保留资料，不将其视为没有相关知识。',DOCUMENT_SCOPE_OUTPUT_TRUNCATED:'范围发现结果返回不完整，已保留处理记录。',DOCUMENT_SCOPE_SOURCE_OR_MODEL_CHANGED:'资料或模型配置已变化，原处理结果不用于当前范围。',DOCUMENT_SCOPE_INTERRUPTED_RESULT_UNKNOWN:'上次范围发现结果尚未确认，系统不会自动重发。'};
 return `<section class="panel product-scope-progress" role="status"><div class="panel-head"><h2>${escape(label)}</h2>${button('查看知识范围','knowledge-scope')}</div><p class="help">${escape(message)}</p>${scopePublicationMarkup(scope)}${scopeReadinessMarkup(state.productView)}${scopeNormalizationMarkup(scope)}${scope?.phase?`<p class="help">${escape(({DOCUMENT_DISCOVERY:'发现资料支持的候选问题',FAMILY_NORMALIZATION:'归一问题族并扩展适用主体',SCOPE_PLANNED:'范围计划已形成',CQ_DISCOVERY:'发现有据问题',FAMILY_DISCOVERY:'归纳问题族',SUBJECT_DISCOVERY:'发现适用主体',PLANNING:'形成范围计划'})[scope.phase]??'正在处理资料范围')}</p>`:''}${counts?`<p class="help">已收到 ${progress.completed} / ${progress.total} 批范围发现结果</p>`:''}${scope?.errors?.length?`<p class="notice warning">${escape(scope.errors.map(e=>typeof e==='string'?e:e.message??e.reason??errorLabels[e.code]??'本次处理未完成，原资料与处理记录仍保留。').join('；'))}</p><details><summary>查看处理记录</summary>${scope.errors.filter(e=>e?.code).map(e=>`<p class="help">${escape(e.code)}</p>`).join('')}</details>`:''}</section>`;
}
function scopeEvidenceMarkup(family,state){
 const sources=state.productView?.library?.sources??[];
 const evidence=(family.evidence??[]).map(e=>e.fragment??e).filter(e=>e?.span);
 if(!evidence.length)return '';
 return `<details><summary>查看发现依据</summary>${evidence.map(e=>{
  const source=sources.find(s=>s.active!==false&&s.source_ref===e.source_ref&&s.source_revision===e.source_revision),span=e.span;
  if(!source||typeof source.content!=='string'||!Number.isSafeInteger(span.start)||!Number.isSafeInteger(span.end)||span.start<0||span.end<=span.start||span.end>source.content.length||source.content.slice(span.start,span.end)!==span.quote)return '<p class="help">这处发现依据无法在当前原文中核对，请保留处理记录。</p>';
  return fragmentMarkup(e,'问题范围的发现依据',sources);
 }).join('')}</details>`;
}
const coverageLabels={SUPPORTED:'有据支持',PARTIAL:'部分支持',UNKNOWN:'支持情况待核对',NOT_CHECKED:'尚未检查',UNCHECKED:'尚未检查',INSUFFICIENT_EVIDENCE:'已查未找到足够依据',SOURCE_INSUFFICIENT:'本次已检查资料依据不足，保留有限可用缺口',EXTRACTION_GAP:'原文已有线索，抽取仍有缺口',WAIT_EVIDENCE:'等待补充资料',NOT_APPLICABLE:'不适用',SOURCE_INVALIDATED:'来源已失效',FAILED:'处理故障',TECHNICAL_HOLD:'处理故障'};
function taskCoverageLabel(scope,row){const state=taskCoverageState(scope,row),decision=taskCoverageDecision(scope,row);return state==='auditDeferred'?'条件适用性待确认，暂缓复用':state==='technical'?'技术阻断，任务尚未完成':state==='supported'?'有据支持 · 已覆盖任务':state==='unresolved'&&decision==='SUPPORTED'?'支持范围仍待确认':coverageLabels[decision]??'覆盖情况待核对';}
function scopeObservationMarkup(row){
 if(!hasCoverageStates(row))return '';
 const source={ANSWER_PRESENT:'已有所问内容的依据',INSUFFICIENT:'已检查资料仍不足',UNKNOWN:'含义或适用范围待核实'},candidate={COMPLETE:'完整覆盖本任务',PARTIAL:'仅覆盖本任务一部分',ABSENT:'尚未形成可回答本任务的候选',UNKNOWN:'候选含义或适用性待核实'};
 const errors=row.coverage_observation?.error_codes??row.error_codes??[];
 return `<p class="help product-scope-observations">审核原始观察 · 原文：${escape(source[row.source_evidence_state]??'状态待核实')} · 候选：${escape(candidate[row.candidate_answer_state]??'状态待核实')}</p>${row.coverage_observation_issue?`<p class="help">${escape(row.coverage_observation_issue)}</p>`:''}${errors.length?`<details><summary>查看技术阻断记录</summary>${errors.map(code=>`<p class="help">${escape(code)}</p>`).join('')}</details>`:''}`;
}
function scopeCoverageMarkup(scope){
 const coverage=coverageRows(scope),tasks=new Map((scope?.tasks??[]).map(t=>[t.id,t]));
 return `<section class="panel"><h2>需求覆盖与缺口</h2>${coverage.some(hasCoverageStates)?'<p class="help">原文有答案，不代表候选已完整整理。原始观察保留如下，能否复用以上方核实状态为准。</p>':''}${coverage.length?coverage.map(row=>{
  const task=tasks.get(row.task_id),unmatched=Boolean(row.task_id&&!task),subject=textOf(task?.subject)||row.subject_label;
  const question=task?.question??row.question??row.label??'需求覆盖';
  const title=unmatched?'范围任务待核对':taskTitle(question,subject);
  const label=taskCoverageLabel(scope,row);
  const audit=task&&scopeAuditDeferred(scope,row)?`<p class="help product-scope-audit">原始范围核实：有据支持。条件适用性尚待确认，当前不计入可复用范围。${row.scope_audit_reason?escape(row.scope_audit_reason):''}</p>`:'';
  return `<article class="source-card"${task?` data-scope-task="${escape(task.id)}"`:''}><strong>${escape(title)}</strong>${subject?`<p>主体提及：${escape(subject)}</p>`:''}<p>${escape(unmatched?'覆盖记录与当前任务尚未匹配':label)}</p>${scopeObservationMarkup(row)}${audit}${task?.conditions?.length?`<p class="help">条件：${task.conditions.map(c=>escape(textOf(c))).join('；')}</p>`:''}${row.reason?`<p class="help">${escape(row.reason)}</p>`:''}</article>`;
 }).join(''):'<p class="help">尚未收到需求覆盖记录。发现了问题族、完成扫描或人工队列为空，都不代表这些问题已经有足够依据。</p>'}</section>`;
}
export function scopePage(state){
 const {scope}=scopeState(state),families=Array.isArray(scope?.families)?scope.families:[],tasks=Array.isArray(scope?.tasks)?scope.tasks:[];
 const taskCoverage=new Map(coverageRows(scope).map(row=>[row.task_id,row]));
 return `<div class="page-head"><div><h1>知识范围</h1><p>查看本次资料要整理哪些问题、涉及哪些主体，以及仍需补齐的依据。</p></div>${button('查看整理进度','knowledge-processing')}</div>${discoveryProgress(state)}${families.length?`<section class="panel"><div class="panel-head"><h2>问题族与适用主体</h2><span class="muted small">${families.length} 个问题族</span></div>${families.map(f=>`<article class="source-card"><h3>${escape(f.label??f.question_template??'问题族')}</h3>${f.question_template?`<p>${escape(f.question_template)}</p>`:''}<dl class="answer-version"><dt>目标</dt><dd>${escape(textOf(f.target)||'目标待核对')}</dd><dt>问题操作</dt><dd>${escape(({ATTRIBUTE:'属性查询',LOOKUP:'查询',QUERY:'查询',COMPARE:'比较',LIST:'列举',RELATION:'关系查询',EXPLAIN:'解释',AGGREGATE:'汇总',CONDITIONAL:'条件查询'})[f.operation]??f.operation??'操作待核对')}</dd></dl><p>适用主体：${(f.subjects??[]).map(textOf).filter(Boolean).map(escape).join('、')||'尚未记录'}</p>${f.conditions?.length?`<p>条件：${f.conditions.map(c=>escape(textOf(c))).join('；')}</p>`:''}<p class="help">${(f.evidence_ids??f.evidence)?.length?'保留 '+(f.evidence_ids??f.evidence).length+' 处发现依据；主体适用性和事实支持仍需分别核对。':'尚未提供发现依据记录。'}</p>${scopeEvidenceMarkup(f,state)}</article>`).join('')}</section>`:`<section class="panel empty-state"><h2>当前还没有可展示的问题族</h2><p>资料与原件仍保留。范围发现完成后，这里会展示实际问题族和主体，不用示例问题代替发现结果。</p></section>`}${tasks.length?`<section class="panel"><h2>本次整理任务</h2>${tasks.map(t=>`<article class="source-card"><strong>${escape(taskTitle(t.label??t.question??t.description??t.family_id??'范围任务',textOf(t.subject)))}</strong>${textOf(t.subject)?`<p>主体提及：${escape(textOf(t.subject))}</p>`:''}<p class="help">${escape(taskCoverage.has(t.id)?taskCoverageLabel(scope,taskCoverage.get(t.id)):coverageLabels[t.coverage_status]??phaseStates[t.status]??t.status??'等待处理结果')}</p></article>`).join('')}</section>`:''}${scopeCoverageMarkup(scope)}`;
}
export function consumedProfiles(response){return new Set((response?.retrieval_trace?.record_decisions??[]).filter(r=>typeof r.record_id==='string'&&r.record_id.startsWith('profile:')&&['COVERED_LINK','ADDED_WHOLE_GROUP'].includes(r.reason)).map(r=>r.record_id)).size;}
export function scopeRouteMarkup(response,view){
 const scope=currentDocumentScope(view),route=response?.scope_route;
 if(!route&&!partialScopeEnabled(view))return '';
 const data=scopeReadiness(view),supported=new Set(data?.supportedIds??[]),reusable=new Set(scope?.reusable_task_ids??data?.supportedIds??[]),tasks=route?.task_ids;
 const snapshot=route?.snapshot,answerSnapshot=response?.answer?.snapshot;
 const current=scope&&response?.status!=='SOURCE_INVALIDATED'&&typeof scope.plan_id==='string'&&scope.plan_id.length>0&&route?.plan_id===scope.plan_id&&typeof scope.coverage_receipt_hash==='string'&&scope.coverage_receipt_hash.length>0&&route.coverage_receipt_hash===scope.coverage_receipt_hash&&snapshot?.source_epoch===scope.source_epoch&&answerSnapshot?.source_epoch===scope.source_epoch&&snapshot?.base_ref===view?.library?.id&&snapshot?.base_ref===answerSnapshot?.base_ref&&snapshot?.graph_revision===answerSnapshot?.graph_revision;
 const published=view?.published_graph,publishedCurrent=!usesPartialScopePolicy(scope)||published?.publication_status==='PUBLISHED'&&published.index_status==='READY'&&published.published_graph_revision===answerSnapshot?.graph_revision;
 const reuse=current&&publishedCurrent&&route?.route==='SAME_SCOPE_REUSE'&&route.reuse_eligible===true&&Array.isArray(tasks)&&tasks.length>0&&tasks.every(id=>supported.has(id)&&reusable.has(id));
 const message=reuse?`本次问题匹配 ${new Set(tasks).size} 个已覆盖任务，复用范围仅限这些已核实的任务；回答仍逐条核对原文。`:route?.route==='SAME_FAMILY_NEW_SCOPE'?'本次属于已有问题族的新范围，尚未确认可复用；先按原文回答，缺口仍保留。':route?.route==='NEW_FAMILY'?'本次涉及新的问题范围，先按原文回答，尚未计入已覆盖任务。':route?.route==='UNKNOWN'?'本次问题的适用范围尚未确认；按原文回答，不将未决范围当作新增知识。':'本次未确认匹配已覆盖任务；按原文查找依据，处理未完成或资料不足会明确说明。';
 return `<p class="notice product-answer-scope" role="status">${escape(message)}</p>`;
}
export function sourceAnswerMarkup(response,{formalRevision=null,view=null}={}){
 const answer=response?.answer;if(!answer)return `<p class="help">${escape(response?.status==='SOURCE_INVALIDATED'?'资料已更新，请重新提问。':response?.status??'暂未生成回答，可先核对资料。')}</p>`;
 const rows=answer.statements??[],excerpts=answer.excerpts??[],reuse=consumedProfiles(response);
 return `${scopeRouteMarkup(response,view)}${rows.map((s,i)=>`<article class="answer-paragraph"><p>${escape(s.text)}</p>${button('查看原文依据','product-answer-evidence',`data-index="${i}"`)}</article>`).join('')}${!rows.length?`<p class="help">以下是检索到的原文片段，尚未形成完整回答。</p>${excerpts.map(e=>`<blockquote>${escape(typeof e==='string'?e:e.text??e.quote??e.span?.quote??'')}</blockquote>`).join('')}${Object.keys(answer.evidence_index??{}).length?button('查看原文片段与位置','product-answer-evidence','data-index="excerpts"'):''}`:''}${answer.gaps?.length?`<div class="answer-gaps"><h3>仍需核对</h3>${answer.gaps.map(g=>`<p>${escape(typeof g==='string'?g:g.reason??g.description??'证据尚未完整')}</p>`).join('')}</div>`:''}<p class="help">依据本次原文快照${answer.snapshot?.graph_revision?' · 读取图版本 '+escape(answer.snapshot.graph_revision):''}。${reuse?`本次使用 ${reuse} 条${formalRevision===answer.snapshot?.graph_revision?'正式图':'候选图'}导航记录定位原文；图谱描述不作为答案证据。`:'本次未记录实际消费图谱导航。'}</p>`;
}
export function answersPage(state){
 const view=state.productView,library=view?.library??{},response=state.productAnswer,q=state.askQuestion??'',cqs=questionSuggestions(view);
 return `<div class="question-workspace ${response?'has-answer':''}">${response?`<h1 class="asked-question">${escape(state.productAnsweredQuestion??q)}</h1>`:''}<section class="panel ask-composer"><div class="panel-head"><div><span class="eyebrow">与你的知识对话</span><h1>你想了解什么？</h1></div><span class="muted small">${(library.sources??[]).filter(s=>s.active).length} 份有效资料</span></div><textarea id="ask-question" rows="${response?1:3}" maxlength="4096" aria-label="向知识库提问" placeholder="向原文提问，发现新的联系…">${escape(q)}</textarea><div class="composer-actions"><span class="muted small" role="status">${state.answerPending?escape(state.askProgress??'正在检索原文…'):''}</span>${button(state.answerPending?'回答中…':'提问','ask-question',state.busy?'disabled':'')}</div></section>${learningStatus(view,state.productModels)}${response?`<section class="panel answer-surface" aria-live="polite"><div class="panel-head"><h2>回答</h2></div>${sourceAnswerMarkup(response,{formalRevision:view?.published_graph?.published_graph_revision??null,view})}</section>`:state.productSourcePreview?.length?`<section class="panel"><h2>正在核对相关原文</h2>${state.productSourcePreview.slice(0,3).map(e=>`<blockquote>${escape(e.span?.quote??e.text??'')}</blockquote>`).join('')}</section>`:!state.answerPending&&cqs.length?`<section class="question-suggestions"><p class="muted small">试着问</p>${cqs.slice(0,4).map((q,i)=>button(escape(q),'product-use-question',`data-index="${i}"`)).join('')}</section>`:''}</div>`;
}
export function graphPage(state,{candidatePreview=false}={}){
 const legacy=!Object.hasOwn(state.productView??{},'published_graph');
 const graph=candidatePreview?(state.productView?.candidate_preview??state.productView?.graph):legacy?state.productView?.graph:state.productView?.published_graph;
 if(!candidatePreview&&!legacy&&graph?.publication_status!=='PUBLISHED')return `<section class="panel empty-state"><h2>正式图谱尚在整理</h2><p>当前只有候选知识。原文问答照常可用，候选图可在「知识整理」中预览；完成证据与语义核实后才会发布正式图谱。</p>${button('查看整理进度','knowledge-processing')}</section>`;
 if(!graph||!['READY','CANDIDATE_PREVIEW','COMMITTED_INDEX_PENDING','COMMITTED_INDEX_UNAVAILABLE'].includes(graph.status))return learningStatus(state.productView,state.productModels)+`<section class="panel empty-state"><h2>${graph?.status==='SOURCE_INVALIDATED'?'资料已变化，旧图已隐藏':'正在积累知识联系'}</h2><p>你可以先提问并核对原文，后台会继续整理候选实体和关系。</p></section>`;
 const entities=new Map(),statements=new Map();for(const build of graph.builds??[]){for(const e of build.graph?.entities??[])entities.set(e.id,e);for(const s of build.graph?.statements??[])statements.set(s.id,s);}
 const commands=[['放大','in'],['缩小','out'],['适应视图','fit'],['力导向','layout'],['环形','circle'],['暂停动效','motion']];
 const indexed=state.productView?.graph,sameSources=graph.snapshot&&indexed?.snapshot&&graph.snapshot.base_ref===indexed.snapshot.base_ref&&graph.snapshot.source_epoch===indexed.snapshot.source_epoch&&JSON.stringify(graph.snapshot.sources)===JSON.stringify(indexed.snapshot.sources);
 const indexSource=candidatePreview&&graph.index_status==='NOT_PUBLISHED'&&sameSources&&indexed.status==='READY'&&indexed.index_status==='READY'&&indexed.retrieval_available===true?indexed:graph;
 const indexStatus=indexSource.index_status==='NOT_PUBLISHED'?'未就绪':indexSource.index_status??'未提供',indexVersion=indexSource!==graph?` · 索引版本 ${escape(indexSource.graph_revision)}`:'';
 const partial=!candidatePreview&&!legacy&&partialPublication(state.productView);
 const publicationStatus=graph.publication_status??(candidatePreview||legacy?'NOT_PUBLISHED':null),publicationLabel=publicationStatus==='PUBLISHED'?(partial?'部分范围已正式发布':'已正式发布'):publicationStatus==='NOT_PUBLISHED'?'未正式发布':'发布状态未说明';
 const markup=`<div id="product-graph-processing-notice">${graphStatusMarkup(state,{candidatePreview})}</div><p class="help product-graph-notice">${badge('待核实候选')} 仅用于导航与检索提示。索引就绪不代表内容已证实，答案依据仍是原文。</p><div class="graph-workbench product-graph-workbench ${state.productGraphSelected?'':'graph-overview'}" data-product-graph-workbench><div class="graph-stage"><div class="graph-surface" data-graph-surface role="img" aria-label="待核实候选图谱，可点击节点和连线核对原文" tabindex="0"></div><div class="graph-tools">${commands.map(([text,c])=>`<button class="graph-tool" type="button" data-graph-command="${c}">${text}</button>`).join('')}</div><div class="graph-status" data-graph-status>正在读取候选图…</div><details class="graph-browser"><summary>候选实体与关系 · ${entities.size} / ${statements.size}</summary><div class="graph-browser-content">${[...entities.values()].map(e=>button(escape(e.label)+' · 待核实','product-graph-select',`data-id="${escape(e.id)}" data-kind="entity"`)).join('')}${[...statements.values()].map(s=>button(escape(s.descriptions?.[0]??s.predicate?.proposed_definition?.label??s.id)+' · 待核实','product-graph-select',`data-id="${escape(s.id)}" data-kind="statement"`)).join('')}</div></details></div><aside class="graph-evidence product-graph-inspector" id="product-graph-inspector"><section class="panel inspector"><h3>从候选联系回到原文</h3><p>点击节点、连线或候选条目，查看方向、条件与精确来源位置。</p></section></aside></div><p class="help">图版本 ${escape(graph.graph_revision)} · 索引 ${escape(indexStatus)}${indexVersion} · ${escape(publicationLabel)} · 内容待核实</p>`;
 return candidatePreview||legacy?markup:markup.replaceAll("待核实候选","正式图谱").replaceAll("待核实 · 仅导航","已发布").replaceAll(" · 待核实"," · 已发布").replaceAll("候选实体与关系","已发布实体与关系").replaceAll("候选陈述","已发布陈述").replaceAll("候选关联原文","图谱原文依据").replaceAll("从候选联系回到原文","从已发布知识回到原文").replaceAll("候选条目","已发布条目").replaceAll("候选图","正式图谱").replaceAll("正式图谱图谱","正式图谱").replaceAll("内容待核实","查看来源与审核收据").replace("仅用于导航与检索提示。索引就绪不代表内容已证实，答案依据仍是原文。",`${partial?'本版仅包含通过事实与范围核实的已覆盖任务，全量任务尚未完成。':'已通过本版的来源、证据与语义审核。'}点击节点可核对原文，回答仍以原文为依据。`);
}
export function candidatePreviewPage(state){return `<div class="page-head"><div><span class="eyebrow">知识整理</span><h1>候选图预览</h1><p>这张图仍在核实中，不代表正式发布。</p></div>${button('返回整理进度','knowledge-processing')}</div>`+graphPage(state,{candidatePreview:true});}
export function graphProcessingNotice(state){
 const p=state.productView?.processing,issues=p?.issues??{},actionable=Number.isSafeInteger(issues.actionable)&&issues.actionable>0?issues.actionable:0,technical=Number.isSafeInteger(issues.technical)&&issues.technical>0?issues.technical:0;
 const partialPublished=state.productView?.published_graph?.publication_status==='PUBLISHED'&&partialPublication(state.productView);
 const availability=partialPublished?'部分就绪：已发布的子图仅覆盖已核实任务，其余任务仍未完成，可继续原文提问。':p?.status==='PARTIALLY_READY'?'部分任务已通过范围核实；正式子图是否可用，以发布与索引状态为准。':p?.status==='PARTIAL_READY'?'当前仅有部分候选图可用，仍有资料待处理。':p?.status==='UPDATING'?'正在后台更新，当前可用图继续提供导航。':'';
 return availability||actionable||technical?`<section class="product-graph-issues" role="status"><span>${escape(availability)}${actionable?' 仍有 '+actionable+' 项知识指向待你选择。':''}${technical?' 另有 '+technical+' 项系统处理记录，其他候选继续可用。':''}</span>${button(actionable?'查看待处理 · '+actionable+' 项':'查看处理进度','knowledge-processing')}</section>`:'';
}
export function graphStatusMarkup(state,{candidatePreview=false}={}){return graphProcessingNotice(state)+(!candidatePreview&&state.productView?.published_graph?.publication_status==='PUBLISHED'&&partialPublication(state.productView)?scopeReadinessMarkup(state.productView):'');}
function originalDocument(fragment,sources){
 const source=sources.find(s=>s.active!==false&&s.source_ref===fragment.source_ref&&s.source_revision===fragment.source_revision),span=fragment.span;
 if(!source?.document_id||typeof source.content!=='string'||!Number.isSafeInteger(span?.start)||!Number.isSafeInteger(span?.end)||span.start<0||span.end<=span.start||span.end>source.content.length||source.content.slice(span.start,span.end)!==span.quote)return '';
 const pages=[...new Set((source.parsing?.blocks??[]).filter(b=>Number.isSafeInteger(b.start)&&Number.isSafeInteger(b.end)&&b.start<span.end&&b.end>span.start).flatMap(b=>(b.provenance??[]).map(p=>p.page_no)).filter(p=>Number.isSafeInteger(p)&&p>0))].sort((a,b)=>a-b);
 return `<p class="help">${escape(source.title)} · ${pages.length?'解析器记录的原件页码：'+pages.join('、'):'未提供可信页码，按正文位置核对。'}</p><a class="btn tiny" href="/api/documents/${encodeURIComponent(source.document_id)}/original${pages.length?'#page='+pages[0]:''}" target="_blank" rel="noopener">打开保留原件${pages.length?' · 第 '+pages[0]+' 页':''}</a>`;
}
function fragmentMarkup(fragment,label='原文依据',sources=[]){
 return `<section class="answer-source"><h3>${escape(label)}</h3><blockquote>${escape(fragment.span?.quote??'')}</blockquote>${originalDocument(fragment,sources)}<details><summary>来源、版本与位置</summary><dl class="answer-version"><dt>来源</dt><dd>${escape(fragment.source_ref)}</dd><dt>版本</dt><dd>${escape(fragment.source_revision)}</dd><dt>原文位置</dt><dd>[${escape(fragment.span?.start)}, ${escape(fragment.span?.end)}) · UTF-16</dd><dt>原文摘要</dt><dd>${escape(fragment.text_sha256??fragment.original_sha256??'未提供')}</dd></dl></details></section>`;
}
export function graphInspector(detail,sources=[],published=false){
 if(!detail)return '<section class="panel inspector"><p>该候选不在当前来源快照中，请刷新。</p></section>';
 const item=detail.item??{},entity=detail.kind==='entity',evidence=[...(detail.evidence??[]),...(detail.anchors??[]).map(anchor=>({fragment:anchor,resolved:anchor.resolved})),...(detail.condition_evidence??[]).flatMap(c=>c.evidence??[])];
 return `<section class="panel inspector"><div class="eyebrow">${published?(entity?'实体':'陈述'):(entity?'候选实体':'候选陈述')}</div>${badge(published?'已发布':'待核实 · 仅导航')}<h3>${escape(entity?item.label:item.descriptions?.[0]??item.predicate?.proposed_definition?.label??item.id)}</h3>${entity?`<p class="help">${escape(item.identity_status==='PROVISIONAL_ANCHOR'?'来源提及，身份尚未归一':item.identity_status??'身份未核实')}</p>`:`<dl class="answer-version"><dt>主体</dt><dd>${escape(detail.subject_label??item.subject_id)}</dd><dt>属性／关系</dt><dd>${escape(item.predicate?.proposed_definition?.label??item.predicate?.predicate_ref)}</dd><dt>对象／值</dt><dd>${escape(detail.object_label??item.object?.entity_id??JSON.stringify(item.object?.typed_value?.value))}</dd><dt>方向</dt><dd>${escape(({DIRECTED:'主体 → 对象',UNDIRECTED:'无向关系',NONE:'属性'})[item.direction]??item.direction)}</dd><dt>否定</dt><dd>${item.qualifiers?.negated===true?'是':'否'}</dd></dl>${item.conditions?.length?`<p>条件：${escape(item.conditions.map(c=>c.text).join('；'))}</p>`:''}${item.qualifiers?.scope?`<p>范围：${escape(item.qualifiers.scope)}</p>`:''}${item.qualifiers?.effective_time?`<p>时间：${escape(JSON.stringify(item.qualifiers.effective_time))}</p>`:''}${item.qualifiers?.unit?`<p>单位：${escape(item.qualifiers.unit)}</p>`:''}`}<p class="help">${published?'证据与审核收据可回看，原文仍可核对。':'定位成功不等于语义已经证实。'}</p>${evidence.map((e,i)=>e.resolved===false?'<p class="help">这处原文位置无法在当前快照解析。</p>':fragmentMarkup(e.fragment??e.evidence??e.anchor??e,(published?'图谱原文依据 ':'候选关联原文 ')+(i+1),sources)).join('')}</section>`;
}
export function sourceEvidenceDrawer(state){
 if(state.productEvidence===null||state.productEvidence===undefined||state.view!=='knowledge')return '';
 const answer=state.productAnswer?.answer;if(!answer)return '';
 const statement=state.productEvidence==='excerpts'?null:answer.statements?.[Number(state.productEvidence)],ids=statement?.evidence_ids??(state.productEvidence==='excerpts'?Object.keys(answer.evidence_index??{}):[]);
 return `<div class="answer-drawer-layer"><button class="answer-drawer-backdrop" data-action="product-close-evidence" aria-label="关闭原文依据"></button><aside class="answer-evidence-drawer" id="product-answer-evidence" role="dialog" aria-modal="true" aria-labelledby="product-evidence-title"><header><h2 id="product-evidence-title">原文依据</h2>${button('关闭','product-close-evidence','id="product-evidence-close"')}</header><div class="answer-drawer-body">${statement?`<p class="selected-conclusion">${escape(statement.text)}</p>`:''}<p class="help">以下是这句话实际选择的来源片段。保留原文版本与位置，不表示独立事实认证。</p>${ids.map(id=>{const e=answer.evidence_index?.[id];return e?fragmentMarkup(e,'原文依据',state.productView?.library?.sources??[]):'<p>该引用未在本次回答证据清单中登记。</p>';}).join('')}</div></aside></div>`;
}
export function sourcesPage(state){
 const view=state.productView,library=view?.library??{},draft=state.librarySupplement??{},replacement=state.productReplacement;
 return `<section class="panel"><h2>${replacement?'替换资料':'添加资料'}</h2><p class="help">保存后自动更新后台整理任务；原件与历史版本保留。</p>${button('选择文件','pick-library-file',state.busy?'disabled':'')}<input type="file" id="library-file-picker" accept=".pdf,.docx,.txt,.md" hidden><div class="field"><label for="supplement-title">资料标题</label><input id="supplement-title" data-library-field="title" value="${escape(draft.title)}"></div><div class="field"><label for="supplement-content">正文或解析预览</label><textarea id="supplement-content" rows="5" data-library-field="content" ${draft.document_id?'readonly':''}>${escape(draft.content)}</textarea></div>${button(replacement?'确认替换资料':'添加资料','product-save-source',state.busy?'disabled':'')}${replacement?button('取消替换','product-cancel-replace'):''}</section><section class="panel">${(library.sources??[]).map(s=>`<article class="source-card"><h3>${escape(s.title)}</h3>${badge(s.active?'当前有效':'已移出 · 历史保留')}${s.active?button('替换资料','product-replace-source',`data-key="${escape(s.key)}"`)+button('移出当前知识库','product-revoke-source',`data-key="${escape(s.key)}"`):''}<details><summary>阅读保留原文</summary><pre>${escape(s.content??'当前视图未返回完整原文，请使用回答引用核对。')}</pre><p class="help">${escape(s.source_ref??s.key)} · ${escape(s.source_revision??'未提供来源版本')}</p></details>${s.document_id?`<a href="/api/documents/${escape(s.document_id)}/original" target="_blank" rel="noopener">下载原文件</a>`:''}</article>`).join('')||'<p>尚无已登记资料。</p>'}</section>`;
}
export function libraryPage(state){
 if(state.knowledgeMode==='processing'||state.productCreationPending)return processingPage(state);
 if(!state.productView)return '<section class="panel"><h2>正在读取知识库…</h2></section>';
 const mode=state.knowledgeMode??'answers';return mode==='graph'?graphPage(state):mode==='candidate'?candidatePreviewPage(state):mode==='sources'?sourcesPage(state):mode==='scope'?scopePage(state):answersPage(state);
}
const phaseLabels={PARSE:'解析与保留原文',EXTRACT:'抽取实体和关系',ORGANIZE:'连接候选知识',READY:'候选知识已可导航',PARSING:'解析与保留原文',EXTRACTION:'抽取实体和关系',GRAPH:'连接候选知识',INDEX:'更新检索索引'};
const phaseStates={PLANNED_UNVERIFIED:'已规划，尚未核实',PLANNED:'已规划',PENDING:'等待中',WAITING:'等待中',QUEUED:'等待中',RUNNING:'进行中',COMPLETE:'已完成',COMPLETED:'已完成',READY:'已就绪',PARTIAL:'部分完成',PAUSED:'已暂停',WAITING_HUMAN:'待你选择',BLOCKED:'暂不可继续',FAILED:'未完成',SKIPPED:'本次未执行',UNKNOWN:'状态待确认'};
export function processingProgress(state){
 const p=state.productView?.processing,discovery=state.productView?.document_scope?discoveryProgress(state):'';
 if(!p)return discovery+ `<div class="processing-intro" role="status"><span class="processing-pulse" aria-hidden="true"></span><div><h2>${state.productCreationPending?(state.lastError?'资料保存尚未完成':'正在保存资料与可选整理方向'):'等待后台整理状态'}</h2><p>${state.productCreationPending&&state.lastError?'原输入仍保留，请先核对连接状态；本页不会自动重复提交。':'资料与原件会保留。尚未收到阶段记录时，不估算抽取或建图进度。'}</p></div></div>${state.productCreationPending?'':learningStatus(state.productView,state.productModels)}`;
 const count=(value)=>Number.isSafeInteger(value)&&value>=0;
 const scope=currentDocumentScope(state.productView),scopeUnchecked=scope?.scope_publication_status==='NOT_CHECKED';
 const phaseMessage=phase=>{
  if(phase.id!=='READY'||!scopeUnchecked||p.graph_ready)return phase.message;
  const pending=count(p.issues?.actionable)&&p.issues.actionable>0;
  const message=pending?'有 '+p.issues.actionable+' 项知识含义待你判断，处理后继续核实。':phase.message;
  return (message??'')+'需求覆盖未核对；正式发布仍需通过范围核实。';
 };
 return discovery+`<div class="processing-intro" role="status"><span class="processing-pulse ${p.graph_ready?'is-ready':''}" aria-hidden="true"></span><div><h2>${escape(p.status==='PARTIALLY_READY'?'部分就绪，其他任务仍待完成':p.status==='WAITING_PROCESSING'?'等待后台继续处理':p.status==='RESULT_UNKNOWN'?'调用结果待确认':p.status==='TECHNICAL_HOLD'?'系统处理暂时受阻':p.status==='WAITING_HUMAN'?'有知识需要你判断':p.status==='PARTIAL_CANDIDATES'?'候选图正在增量形成':p.status==='CANDIDATES_READY_WITH_ISSUES'?'候选图可预览，仍有事项待核对':p.status==='CANDIDATES_READY'?'候选图可预览，等待正式核实':p.status==='PARTIAL_READY'?'正式图谱已有旧版，新资料仍在整理':p.status==='UPDATING'?'正在更新知识，已发布版本仍可查看':p.status==='READY_WITH_ISSUES'?'正式图谱已发布，仍有后续事项':p.graph_ready?'正式图谱已发布':p.current_phase?phaseLabels[p.current_phase]??p.current_phase:'正在整理知识')}</h2><p>${escape(p.message??'以下阶段和数量来自已保存的处理记录；局部问题会单独保留。')}</p></div></div><ol class="processing-phases">${(p.phases??[]).map(phase=>`<li class="processing-phase ${escape(String(phase.status??'UNKNOWN').toLowerCase())}"><div><strong>${escape(phase.label??phaseLabels[phase.id]??phase.id)}</strong><span>${escape(phaseStates[phase.status]??phase.status??'状态待确认')}</span></div>${count(phase.completed)?`<p>${phase.completed}${count(phase.total)?' / '+phase.total:''} ${escape(phase.unit??'项')}${count(phase.total)?'':' · 总数尚未确定'}</p>`:''}${phaseMessage(phase)?`<p class="help">${escape(phaseMessage(phase))}</p>`:''}</li>`).join('')}</ol><div class="processing-summary"><span>待处理 ${count(p.issues?.actionable)?p.issues.actionable:'未提供'} 项</span><span>原文依据缺口记录 ${count(p.issues?.coverage)?p.issues.coverage:'未提供'} 份</span>${scopeUnchecked?'<span>需求覆盖未核对</span>':''}<span>已单独保留 ${count(p.issues?.isolated)?p.issues.isolated:'未提供'} 项</span><span>技术记录 ${count(p.issues?.technical)?p.issues.technical:'未提供'} 项</span></div>${p.graph_revision?`<p class="help">${p.graph_available?'正式图':'候选图'}版本 ${escape(p.graph_revision)} · 索引 ${escape(p.index_status??'未说明')}</p>`:''}`;
}
export function reviewItems(view){return Array.isArray(view?.review_items)?view.review_items:Array.isArray(view?.reviews)?view.reviews:view?.reviews?.items??[];}
export const reviewStatus={OPEN:'待你选择',APPLY_PENDING:'决定已保存，正在更新知识',APPLY_BLOCKED:'决定已保存，但知识更新受阻',APPLICATION_UNKNOWN:'更新请求的结果尚未确认，保留决定，未自动重发',MATERIALIZED_WITH_ISSUES:'定位已应用，候选仍有其它问题',APPLIED:'已应用到候选知识',CONFIRMED:'含义判断已保存',EXCLUDED:'已不采用此候选',DEFERRED:'已稍后处理',STALE:'资料已变化，这次决定不再用于当前版本'};
function applicationMessage(item){
 if(item.status==='APPLICATION_UNKNOWN')return '本次更新结果需要先确认；系统保留你的决定，不会自动重复派发。';
 if(item.status==='STALE')return '该决定只保留在历史中，请以当前资料中的问题为准。';
 if(item.status==='APPLY_BLOCKED')return '当前知识更新未完成。决定已保留，其他可用候选继续服务。';
 if(['APPLIED','EXCLUDED','DEFERRED','MATERIALIZED_WITH_ISSUES'].includes(item.status))return '';
 const application=item.decision?.application;
 if(!application)return '';
 if(application.queue_status==='QUEUED')return '决定已排队，等待当前整理任务完成后自动更新，无需再次提交。';
 if(application.queue_status==='WAIT_MODEL_CONFIGURATION')return '决定已保留，等待本次更新所需的模型配置恢复。';
 const stage={RETRIEVING:'正在读取这次决定对应的原文。',EXTRACTING:'正在按原文选择核对已保留结果。',VALIDATING:'正在核对候选结构与原文位置。',INDEX_PENDING:'正在更新检索索引。'}[application.stage];
 return stage??'';
}
function reviewOptionQuote(option,sources){
 const context=option.context_span,span=option.span,plain=option.context_quote??span?.quote??'此选项未提供可显示的原文。';
 const source=sources.find(s=>s.active!==false&&s.source_ref===option.source_ref&&s.source_revision===option.source_revision);
 if(!context||!source||typeof source.content!=='string'||typeof context.quote!=='string'||context.quote!==option.context_quote||![context.start,context.end,span?.start,span?.end].every(Number.isSafeInteger)||context.start<0||context.end>source.content.length||context.end-context.start!==context.quote.length||span.start<context.start||span.end>context.end||span.end<=span.start||source.content.slice(context.start,context.end)!==context.quote||source.content.slice(span.start,span.end)!==span.quote)return escape(plain);
 const before=context.quote.slice(0,span.start-context.start),after=context.quote.slice(span.end-context.start);
 if([before,span.quote,after].some(s=>typeof s.isWellFormed==='function'&&!s.isWellFormed()))return escape(plain);
 return escape(before)+'<mark>'+escape(span.quote)+'</mark>'+escape(after);
}
export function reviewQueue(state){
 const items=reviewItems(state.productView);
 return `<div class="panel-head"><div><span class="eyebrow">知识问题</span><h2>需要核对的候选</h2></div><span class="muted small">${items.length} 项记录</span></div>${items.length?`<nav class="processing-review-list" aria-label="待处理知识问题">${items.map(item=>`<button type="button" class="processing-review-item ${state.productReviewSelected===item.id?'selected':''}" data-action="product-open-review" data-id="${escape(item.id)}"><span>${escape(item.title??'原文中的知识指向')}<small>${escape(reviewStatus[item.status]??item.status??'状态待确认')}</small></span><span aria-hidden="true">↗</span></button>`).join('')}</nav>`:'<p class="help">当前没有可供你决定的知识问题。后台的技术问题会单独记录，不要求你修改程序字段。</p>'}`;
}
export function reviewPane(state){
 const item=reviewItems(state.productView).find(i=>i.id===state.productReviewSelected);
 if(!item)return '<div class="processing-review-empty"><span aria-hidden="true">↔</span><h3>让知识与原文并排核对</h3><p>选择左侧问题，查看这项知识及其在原文中的不同指向。</p></div>';
 if(item.kind==='SEMANTIC_CANDIDATE')return semanticReviewPane(state,item);
 const allowed=['OPEN','DEFERRED'].includes(item.status),supportedKind=item.kind==='MENTION_SCOPE';
 const action=id=>supportedKind&&allowed?(item.actions??[]).find(a=>a.id===id):null;
 const adopt=action('SELECT_OCCURRENCE'),exclude=action('EXCLUDE_CANDIDATE'),defer=action('DEFER');
 const candidate=item.candidate??{},reasonKey=item.id+':'+item.item_revision,notice=state.productReviewNotice?.item_id===item.id?state.productReviewNotice.message:null;
 return `<header class="processing-review-header"><div><span class="eyebrow">原文提及归属</span><h2>${escape(item.title??'这项知识指向哪处原文？')}</h2></div><span id="product-review-state">${badge(reviewStatus[item.status]??item.status??'待核对')}</span></header>${notice?`<p class="notice" role="status">${escape(notice)}</p>`:''}${applicationMessage(item)?`<p class="help" role="status">${escape(applicationMessage(item))}</p>`:''}<div class="processing-review-columns"><section class="processing-knowledge-card"><h3>知识候选</h3><p class="processing-candidate-text">${escape(candidate.text??'这项候选的知识表述尚未提供。')}</p>${candidate.subject_label?`<p class="help">主体：${escape(candidate.subject_label)}</p>`:''}${candidate.relation_label?`<p class="help">关系：${escape(candidate.relation_label)}</p>`:''}${candidate.object_label?`<p class="help">对象：${escape(candidate.object_label)}</p>`:''}<p>${escape(item.question??'请根据原文含义选择这项知识的指向；不确定时可以稍后处理。')}</p><p class="help">选择原文位置不等于完成语义审核，也不会把整张图标记为已证实。</p></section><section class="processing-evidence-card"><h3>原文中的可选指向</h3>${(item.options??[]).map((option,i)=>`<article class="processing-evidence-option"><div class="panel-head"><strong>${escape(option.label??'原文片段 '+(i+1))}</strong>${option.source_title?`<span class="muted small">${escape(option.source_title)}</span>`:''}</div><blockquote>${reviewOptionQuote(option,state.productView?.library?.sources??[])}</blockquote>${option.context_quote&&option.span?.quote&&option.context_quote!==option.span.quote?`<p class="processing-mention">对应提及：${escape(option.span.quote)}</p>`:''}<p class="help">来源版本：${escape(option.source_revision??'未提供')}</p>${originalDocument(option,state.productView?.library?.sources??[])}${adopt?button(escape(adopt.label??'采用此处原文'),'product-review-decision',`data-id="${escape(item.id)}" data-revision="${escape(item.item_revision)}" data-decision="SELECT_OCCURRENCE" data-option="${escape(option.id)}" ${state.busy?'disabled':''}`):''}</article>`).join('')||'<p class="help">当前没有可提交的原文选择。请保留此项，系统不会要求你填写原始字段或位置数字。</p>'}</section></div>${exclude||defer?`<footer class="processing-review-actions"><label>补充说明（可选）<textarea rows="2" data-product-review-reason="${escape(reasonKey)}" placeholder="可以留空">${escape(state.productReviewReasons?.[reasonKey]??'')}</textarea></label><div>${exclude?button(escape(exclude.label??'不采用此候选'),'product-review-decision',`data-id="${escape(item.id)}" data-revision="${escape(item.item_revision)}" data-decision="EXCLUDE_CANDIDATE" ${state.busy?'disabled':''}`):''}${defer?button(escape(defer.label??'稍后处理'),'product-review-decision',`data-id="${escape(item.id)}" data-revision="${escape(item.item_revision)}" data-decision="DEFER" ${state.busy?'disabled':''}`):''}</div></footer>`:''}${item.status==='MATERIALIZED_WITH_ISSUES'?'<p class="notice">定位决定已应用，相关候选仍待其它问题处理；图谱尚未因此更新。</p>':item.status==='APPLIED'?'<p class="help">此决定已应用；检索索引是否就绪，以整理进度中的索引状态为准。</p>':''}`;
}
function semanticReviewPane(state,item){
 const notice=state.productReviewNotice?.item_id===item.id?state.productReviewNotice.message:null;
 const c=item.candidate??{},allowed=['OPEN','DEFERRED'].includes(item.status),actions=item.actions??[],reasonKey=item.id+':'+item.item_revision;
 const action=(id,label)=>allowed&&actions.some(a=>a.id===id)?button(label,'product-review-decision',`data-id="${escape(item.id)}" data-revision="${escape(item.item_revision)}" data-decision="${id}" ${state.busy?'disabled':''}`):'';
 return `<header class="processing-review-header"><div><span class="eyebrow">知识含义核对</span><h2>${escape(item.title)}</h2></div><span id="product-review-state">${badge(reviewStatus[item.status]??item.status)}</span></header>${notice?`<p class="notice" role="status">${escape(notice)}</p>`:''}<div class="processing-review-columns"><section class="processing-knowledge-card"><h3>候选陈述</h3><p class="processing-candidate-text">${escape(c.text??'')}</p><dl class="answer-version"><dt>主体</dt><dd>${escape(c.subject_label)}</dd><dt>关系／属性</dt><dd>${escape(c.relation_label)}</dd><dt>对象／值</dt><dd>${escape(c.object_label)}</dd></dl><p>${escape(item.question)}</p><p class="help">请判断原文是否完整支持这条陈述；程序会继续核对来源版本、位置和索引。</p></section><section class="processing-evidence-card"><h3>当前版本原文</h3>${(item.options??[]).map((option,i)=>`<article class="processing-evidence-option"><blockquote>${reviewOptionQuote(option,state.productView?.library?.sources??[])}</blockquote>${originalDocument(option,state.productView?.library?.sources??[])}<p class="help">来源版本：${escape(option.source_revision??'未提供')} · 片段 ${i+1}</p></article>`).join('')}</section></div>${allowed?`<footer class="processing-review-actions"><label>判断理由（必填）<textarea rows="2" data-product-review-reason="${escape(reasonKey)}" placeholder="说明原文如何支持，或哪里不一致">${escape(state.productReviewReasons?.[reasonKey]??'')}</textarea></label><div>${action('CONFIRM_SUPPORT','原文支持这条陈述')}${action('EXCLUDE_CANDIDATE','不采用此陈述')}${action('DEFER','稍后判断')}</div></footer>`:`<p class="help">${partialScopeEnabled(state.productView)?'判断已保存。仅通过事实与范围核实的任务可先部分就绪，其余任务继续保留。':'判断已保存。正式图谱是否可发布，以整份资料的审核与索引状态为准。'}</p>`}`;
}
export function processingPage(state){
 const title=state.productView?.library?.name??state.productCreationPending?.name??'知识库';
 return `<div class="page-head"><div><span class="eyebrow">${escape(title)}</span><h1>知识整理</h1><p>${partialScopeEnabled(state.productView)?'资料会逐步成为可回溯的候选知识。已核实任务的子图发布且你没有在编辑时，会打开该子图；其余任务继续保留，你也可以随时先去原文问答。':'资料会逐步成为可回溯的候选知识。首次整理完成且你没有在编辑时，会打开正式图谱；你也可以随时先去问答。'}</p></div><div>${button('去原文问答','knowledge-answers',state.productLibraryId?'':'disabled')}${button('预览候选图','knowledge-candidate','id="product-processing-open-graph" '+(state.productView?.processing?.candidate_graph_available??(!Object.hasOwn(state.productView??{},'published_graph')&&state.productView?.processing?.graph_available)?'':'disabled'))}</div></div><section class="panel" id="product-processing-live">${processingProgress(state)}</section><div class="processing-review-workspace"><aside class="panel processing-review-sidebar" id="product-review-queue">${reviewQueue(state)}</aside><section class="panel processing-review-main" id="product-review-content">${reviewPane(state)}</section></div><details class="panel processing-diagnostics" id="product-processing-diagnostics">${processingDiagnostics(state)}</details>`;
}
export function processingDiagnostics(state){const rows=state.productView?.processing?.diagnostics??[],technicalLabel={SOURCE_WORKER_PROVIDER_OUTPUT_CONTRACT_INVALID:'模型输出缺少约定结构，已暂停本次整理；原始结果已保留',CANDIDATE_ATTRIBUTE_INVALID:'属性类型与对象或方向不一致，需程序修复',SOURCE_LEARNING_BASE_GRAPH_MISSING:'首次建图提交受阻：当前没有基础图，等待恢复提交',CANDIDATE_RELATION_INVALID:'关系对象未形成有效实体绑定',CANDIDATE_KIND_MISMATCH:'提案缺少关系或属性所需字段',SEMANTIC_REVIEW_EVIDENCE_MISSING:'语义审核缺少可核对的原文',MATERIALIZATION_FAILED:'提案未能转换为候选知识'};return `<summary>系统处理记录 · ${rows.length} 项</summary><p class="help">技术问题不会当作知识语义决定；原始结果已保留，当前版本会等待程序修复或重新处理。</p>${rows.map(d=>`<p>${escape(d.message??d.label??technicalLabel[d.error_code??d.code]??'此项处理暂未完成')}${d.proposal_text?`：${escape(d.proposal_text)}`:''}${d.phase?` · 阶段：${escape(d.phase)}`:''}${d.code??d.error_code?` · 记录：${escape(d.code??d.error_code)}`:''}</p>`).join('')||'<p class="help">当前未返回技术问题记录。</p>'}`;}
export function modelsPage(models={},busy=false){
 const cards=Object.entries(modelDefaults).map(([role,d])=>{const status=models[role]??{},enabled=role!=='reranker'||status.configured===true;return `<section class="panel settings"><div class="panel-head"><h2>${escape(d.label)}</h2>${badge(status.configured?'已配置':'未配置')}</div><label class="consent"><input id="product-model-${role}-enabled" type="checkbox" ${enabled?'checked':''}><span>启用此模型</span></label><div class="field"><label>接口地址</label><input id="product-model-${role}-url" value="${escape(status.base_url??d.base_url)}"></div><div class="field"><label>模型名称</label><input id="product-model-${role}-name" value="${escape(status.model??d.model)}"></div><div class="field"><label>API Key（仅内存）</label><input id="product-model-${role}-key" type="password" autocomplete="off" placeholder="${status.configured?'保存时需重新填写，留空不会默认为已保存':'输入此模型的 Key'}"></div>${role==='embedding'?`<div class="field"><label>向量维度</label><input id="product-model-embedding-dimensions" type="number" min="1" max="32768" value="${escape(status.dimensions??1024)}"></div>`:''}</section>`;}).join('');
 return `<div class="page-head"><div><h1>设置</h1><p>连接生成与向量模型后，资料会在后台自动整理。重排模型可选。</p></div></div>${cards}<section class="panel"><p class="help">Key 只保存在服务进程内存，重启后需重新填写。保存不会探测或调用模型；已排队的后台任务会在配置齐全后继续。修改任一启用模型时，请重新填写本次保存的启用项 Key。</p>${button(busy?'正在保存…':'保存模型配置','product-save-models',busy?'disabled':'')}</section>`;
}
