const state = { view: 'overview', boot: null, task: null, selected: null, busy: false, pollBusy: false,
  draft: { name: '', cqs: '', definitions: '', as_of: '', sources: [], consent: false }, zoom: 1 };
const root = document.querySelector('#app');
let graphView=null,graphEpoch=0,draftRenderTimer=null;
let productUi=null,productGraphTools=null,nativeGraphUi=null,nativeWorkbenchUi=null;
const productEnabled=()=>state.boot?.source_first?.default_path_adopted===true;
async function loadProductUi(){if(!productUi)productUi=await import('./product-library-ui-v1.mjs');return productUi;}
async function loadNativeWorkbenchUi(){if(!nativeWorkbenchUi)nativeWorkbenchUi=await import('./native-build-workbench-view-v1.mjs');return nativeWorkbenchUi;}
async function loadNativeGraphUi(){if(!nativeGraphUi)nativeGraphUi=await import('./assets/graph-view.mjs');return nativeGraphUi;}
function renderDraftSoon(){
 if(draftRenderTimer!==null)return;
 draftRenderTimer=setTimeout(()=>{draftRenderTimer=null;const draft=state.answerDraft;if(!draft||state.view!=='knowledge'||draft.task_id!==state.task?.id||draft.question!==state.askQuestion)return;
  const shown=draft.shown??'',pending=Array.from(draft.text.slice(shown.length));
  const immediate=document.hidden||window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const steps=draft.finishing?Math.max(1,4-(draft.finishTicks||0)):12;
  const count=immediate?pending.length:Math.max(3,Math.ceil(pending.length/steps));
  draft.shown=shown+pending.slice(0,count).join('');if(draft.finishing)draft.finishTicks=(draft.finishTicks||0)+1;
  const text=document.querySelector('#answer-draft-text');if(text)text.textContent=draft.shown;else render();
  if(draft.shown!==draft.text)renderDraftSoon();else if(draft.finishing){state.answerDraft=null;render();}
 },33);
}
function finishAnswerDraft(){const draft=state.answerDraft;if(!draft)return;
 if(state.directAnswer?.answer?.answer_mode!=='SYNTHESIS'||draft.shown===draft.text||document.hidden||window.matchMedia?.('(prefers-reduced-motion: reduce)').matches){state.answerDraft=null;return;}
 draft.finishing=true;draft.finishTicks=0;renderDraftSoon();
}
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const labels = { overview: '工作空间', trash:'回收站', input: '资料与问题', knowledge: '知识库', run: '技术运行记录', schema: '本体契约', graph: '图谱探索', queries: '知识库', review: '待确认', source: '原文阅读', model: '设置', integrations:'应用与 Agent 接入',budget: '确认发送与调用上限' };
const glyph = path => `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
const icons = {
  overview:glyph('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
  input:glyph('<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7"/>'),
  run:glyph('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  schema:glyph('<path d="m12 3 9 9-9 9-9-9zM12 3v18M3 12h18"/>'),
  graph:glyph('<circle cx="5" cy="6" r="3"/><circle cx="18" cy="5" r="3"/><circle cx="12" cy="19" r="3"/><path d="m7 8 4 8M16 8l-3 8M8 6h7"/>'),
  queries:glyph('<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6M7 10h6M10 7v6"/>'),
  review:glyph('<path d="m12 3 10 18H2zM12 9v5M12 17v.1"/>'),
  model:glyph('<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>')
};
const statusLabel = { DRAFT: '修订草稿', READY: '可查询', REVIEW_REQUIRED: '待处理', RUNNING: '构建中', QUEUED: '等待中', FAILED: '失败', PAUSED: '已暂停', INTERRUPTED: '已中断', CANCELLED: '已停止' };
const classLabel = { ATTRIBUTED_ONLY: '来源陈述', UNKNOWN: '证据不足', CONFLICT: '存在冲突', UNSUPPORTED: '能力未覆盖', OUT_OF_SCOPE:'超出资料范围',NEEDS_CLARIFICATION: '需要澄清',LEARNING:'正在补充知识',WAIT_EVIDENCE:'等待补充资料',WAIT_REVIEW:'等待核对',STOPPED:'已停止',COMPLETED:'已完成',FAILED:'处理未完成' };
const comparator = { EQ: '', GT: '超过 ', GE: '至少 ', LT: '少于 ', LE: '至多 ', APPROX: '约 ', UNKNOWN: '限定未知 ' };
const active = () => productEnabled()?null:state.boot?.active_task;
const guardedActions = new Set(['build','propose-cqs','ask-question','retry-task','resume-task','continue-review']);
const schema = () => state.task?.result?.schema;
const claimList = () => state.task?.result?.claims ?? [];
const entityName = id => schema()?.entities.find(e => e.id === id)?.name ?? id;
const predicateName = id => schema()?.predicates.find(e => e.id === id)?.label ?? id;
const typeName = id => schema()?.entity_types.find(e => e.id === id)?.label ?? id;
const valueLabel = claim => { const p = schema()?.predicates.find(p => p.id === claim.predicate_id);
  return (comparator[claim.comparator] ?? '') + (p?.value_type === 'ENTITY' ? entityName(claim.value) : claim.value) + (claim.unit ? ' ' + claim.unit : ''); };
const badge = (label, cls = '') => `<span class="badge ${cls}">${escape(label)}</span>`;
const button = (label, action, cls = '', extra = '') => `<button class="btn ${cls}" data-action="${action}" ${extra}>${label}</button>`;
function toast(message) { const el = document.querySelector('#toast'); el.textContent = message; el.style.display = 'block'; clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.style.display = 'none'; }, 5000); }
async function api(path, data) {
  const response = await fetch(path, data === undefined ? { cache: 'no-store' } : { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CQForge-Token': state.boot?.token ?? '' }, body: JSON.stringify(data) });
  let body; try { body = await response.json(); } catch { throw Error('本地服务响应异常，请检查服务是否仍在运行'); }
  if (!response.ok) throw Object.assign(Error(body.error || body.code || '请求失败'),{status:response.status}); return body;
}
function clearProductAnswer(){state.productAnswer=null;state.productEvidence=null;state.productSourcePreview=null;state.productGraphSelected=null;state.askRevision=(state.askRevision||0)+1;}
// Uploaded documents are immutable server-owned originals. Send their handle,
// never duplicate parser output/full content in imports or draft writes.
function productSourcePayload(source){return source.document_id?{title:source.title,document_id:source.document_id}:{title:source.title,content:source.content};}
const nativeBase=id=>'/api/product/libraries/'+encodeURIComponent(id)+'/native-full-chain/runs';
const nativeEnabled=()=>Boolean(state.productView?.native_full_chain?.build_mode);
const nativeConfiguration=()=>state.nativeRun?.configuration??state.productView?.native_full_chain?.configuration??{};
const nativeCapability=()=>state.nativeCapability??state.nativeRun?.capability??'HYBRID';
const nativeRunCQOnly=()=>state.nativeRun?.stop_after==='FAMILY'||state.nativeRun?.snapshot?.input?.stop_after==='FAMILY';
const nativeSelectedStopAfter=()=>state.nativeStopAfter??(state.nativeRun?(nativeRunCQOnly()?'FAMILY':'FULL'):'FAMILY');
const nativeExtractedPolicy=()=>[state.nativeRun?.snapshot?.input?.knowledge_build_policy,state.nativeRun?.snapshot?.build?.knowledge_build_policy,state.nativeRun?.knowledge_build_policy].includes('EXTRACT_AND_INDEX_V1');
const nativeDefaultView=()=>nativeExtractedPolicy()?'EXTRACTED_KNOWLEDGE':'ADOPTED_FACT';
const nativeReadView=()=>state.nativeQueryView??nativeDefaultView();
const nativeLimitValue=(key,freshDefault,legacyDefault)=>state.nativeRun?.limits?.[key]??state.nativeRun?.snapshot?.run?.limits?.[key]??(state.nativeRun&&!nativeExtractedPolicy()?legacyDefault:freshDefault);
const nativeResponseBytes=16*1024*1024;
function nativeCanReuse(capability=nativeCapability()){
 const run=state.nativeRun,reuse=run?.reusable_cq_family,config=nativeConfiguration();
 return Boolean(!state.busy&&reuse?.available===true&&typeof reuse.upstream_run_id==='string'&&reuse.upstream_run_id&&
  !['STARTING','OPEN','RUNNING','UNKNOWN','UNKNOWN_HOLD'].includes(run.status)&&
  (!run.library_id||run.library_id===state.productLibraryId)&&config.generation_configured&&
  (capability==='LEXICAL'||config.embedding_configured));
}
function nativeCanReuseCQDrafts(capability=nativeCapability()){
 const run=state.nativeRun,reuse=run?.reusable_cq_drafts,config=nativeConfiguration();
 return Boolean(!state.busy&&run?.status==='FAILED'&&run.source_current!==false&&reuse?.available===true&&
  typeof reuse.upstream_run_id==='string'&&reuse.upstream_run_id&&Number.isSafeInteger(reuse.cq_count)&&reuse.cq_count>0&&
  (!run.library_id||run.library_id===state.productLibraryId)&&config.generation_configured&&(capability==='LEXICAL'||config.embedding_configured));
}
function nativeCanRebuildProposals(capability=nativeCapability()){
 const run=state.nativeRun,rebuild=run?.rebuildable_proposals;
 return Boolean(!state.busy&&run?.source_current!==false&&rebuild?.available===true&&
  !['STARTING','OPEN','RUNNING','UNKNOWN','UNKNOWN_HOLD'].includes(run.status)&&
  typeof rebuild.upstream_run_id==='string'&&rebuild.upstream_run_id&&
  (!run.library_id||run.library_id===state.productLibraryId)&&
  (capability==='LEXICAL'||nativeConfiguration().embedding_configured));
}
function nativeCanReuseCQ(){
 const run=state.nativeRun,reuse=run?.reusable_cq;
 return Boolean(!state.busy&&nativeRunCQOnly()&&run.status==='UNKNOWN_HOLD'&&run.source_current!==false&&
  reuse?.available===true&&reuse.requires_unknown_acknowledgement===true&&
  typeof reuse.upstream_run_id==='string'&&reuse.upstream_run_id&&Number.isSafeInteger(reuse.cq_count)&&reuse.cq_count>0&&
  (!run.library_id||run.library_id===state.productLibraryId)&&nativeConfiguration().generation_configured);
}
function nativeCanReuseSemantic(capability=nativeCapability()){
 const run=state.nativeRun,reuse=run?.reusable_semantic_packages,config=nativeConfiguration();
 return Boolean(!state.busy&&run?.source_current!==false&&reuse?.available===true&&typeof reuse.upstream_run_id==='string'&&reuse.upstream_run_id&&
  !['STARTING','OPEN','RUNNING','UNKNOWN','UNKNOWN_HOLD'].includes(run.status)&&(!run.library_id||run.library_id===state.productLibraryId)&&config.generation_configured&&(capability==='LEXICAL'||config.embedding_configured));
}
const nativeSemanticRecovery=()=>state.nativeRun?.semantic_recovery??state.productView?.native_full_chain?.semantic_recovery;
function nativeSemanticRecoveryCandidate(){
 const candidates=nativeSemanticRecovery()?.candidates??[],selected=state.nativeRecoveryOrigin;
 return candidates.find(c=>c.upstream_run_id===selected)??candidates[0]??null;
}
function nativeCanRecoverSemantic(capability=nativeCapability(),requireConfirmation=true){
 const run=state.nativeRun,recovery=nativeSemanticRecovery(),candidate=nativeSemanticRecoveryCandidate(),config=nativeConfiguration();
 return Boolean(!state.busy&&recovery?.available===true&&recovery.hold_count>0&&candidate?.unknown_acknowledgement_ref&&
  !['STARTING','OPEN','RUNNING'].includes(run?.status)&&(!run?.library_id||run.library_id===state.productLibraryId)&&config.generation_configured&&(capability==='LEXICAL'||config.embedding_configured)&&
  (!requireConfirmation||state.nativeRecoveryConfirmation===candidate.unknown_acknowledgement_ref));
}
const nativeOrganizationDraftRecovery=()=>state.nativeRun?.organization_draft_recovery??state.productView?.native_full_chain?.organization_draft_recovery;
function nativeOrganizationDraftCandidate(){
 const candidates=nativeOrganizationDraftRecovery()?.candidates??[];
 return candidates.find(c=>c.upstream_run_id===state.nativeOrganizationDraftOrigin)??candidates[0]??null;
}
function nativeCanReuseOrganizationDraft(capability=nativeCapability()){
 const recovery=nativeOrganizationDraftRecovery(),candidate=nativeOrganizationDraftCandidate(),run=state.nativeRun,config=nativeConfiguration();
 return Boolean(!state.busy&&recovery?.available===true&&candidate?.upstream_run_id&&candidate.item_count>0&&
  !['STARTING','OPEN','RUNNING'].includes(run?.status)&&(!run?.library_id||run.library_id===state.productLibraryId)&&config.generation_configured&&(capability==='LEXICAL'||config.embedding_configured)&&
  (!recovery.requires_unknown_acknowledgement||candidate.unknown_acknowledgement_ref&&state.nativeOrganizationDraftConfirmation===candidate.unknown_acknowledgement_ref));
}
async function refreshNativeRun(){
 const id=state.productLibraryId,rows=state.productView?.native_full_chain?.runs??[];
 if(!nativeEnabled()){state.nativeRun=null;return;}
 const run=rows.find(row=>row.run_id===state.nativeBrowseRunId)??rows[0];if(!run){state.nativeRun=null;return;}
 if(state.nativeRun?.run_id!==run.run_id){state.nativeQueryResult=null;state.nativeGraph=null;state.nativeQueryView=null;state.nativeDomainSelected=null;state.nativeDomainFocus=null;state.nativeSemanticRead=null;state.nativeRecoveryOrigin=null;state.nativeRecoveryConfirmation=null;state.nativeOrganizationDraftOrigin=null;state.nativeOrganizationDraftConfirmation=null;state.nativeArtifacts={};state.nativeWorkbenchSelection={};state.nativeWorkbenchQuery={};}
 const result=await api(nativeBase(id)+'/'+encodeURIComponent(run.run_id)+'/status');
 if(id===state.productLibraryId)state.nativeRun=result;
}
function nativeGraphMarkup(payload){
 if(payload?.domain_graph&&nativeGraphUi)return nativeGraphUi.nativeDomainGraphMarkup(payload,{selected:state.nativeDomainSelected,title:state.productView?.library?.name??'领域关系图',sources:state.productView?.library?.sources??[]});
 const nodes=payload?.nodes??[],records=nodes.filter(n=>n.text||n.statement||n.evidence?.quote);
 return `<section class="panel" role="region" aria-label="已存知识与来源关联图"><h2>知识与来源记录</h2><p class="help">已读回 ${nodes.length} 个记录节点、${payload?.edges?.length??0} 条来源关联。${payload?.view==='SOURCE'?'当前为原文来源视图。':'此版本尚无领域关系投影，可查看已保存的知识与来源。'}</p>${records.length?`<details><summary>查看记录内容 · ${records.length}</summary>${records.map(n=>`<p>${escape(n.statement??n.text??n.evidence?.quote)}</p>`).join('')}</details>`:''}</section>`;
}
function updateNativeDomainInspector(id,kind){
 state.nativeDomainSelected=id?{id,kind}:null;
 const panel=root.querySelector?.('[data-native-domain-inspector]');
 if(panel&&nativeGraphUi)panel.innerHTML=nativeGraphUi.nativeDomainInspector(state.nativeGraph,state.nativeDomainSelected,{sources:state.productView?.library?.sources??[]});
}
function nativeKnowledgeSummary(build,jsonDetails){
 const summary=build.processing_summary??{},count=key=>Number.isSafeInteger(summary[key])?summary[key]:'尚未记录';
 const indexName=index=>index?.status==='READY'?'已就绪':index?.status==='PENDING'?'等待建立':index?.status??'尚未建立';
 const source=build.source_index,knowledge=build.knowledge_index;
 return `<section class="panel"><h2>抽取知识与处理记录</h2><p>结构化知识 ${count('structured')} 条 · 文本知识 ${count('text')} 条 · 跳过 ${count('skipped')} 条 · 告警 ${count('warnings')} 项</p><p class="help">抽取知识保留当前取得的内容和来源，尚未经过独立核实；质量缺口不阻止其他知识构建。</p><p>知识索引：${escape(indexName(knowledge))}${knowledge?.capability?` · ${escape(knowledge.capability==='HYBRID'?'词法与向量':knowledge.capability==='LEXICAL'?'仅词法':knowledge.capability)}`:''}${Number.isInteger(knowledge?.records_total)?` · ${knowledge.records_total} 条记录`:''}${Number.isInteger(knowledge?.vectors_completed)?` · ${knowledge.vectors_completed} 条向量`:''}</p><p>原文索引：${escape(indexName(source))}${Number.isInteger(source?.records_total)?` · ${source.records_total} 条记录`:''}${Number.isInteger(source?.vectors_completed)?` · ${source.vectors_completed} 条向量`:''}</p>${jsonDetails('查看跳过与告警明细',{processing_summary:summary,...(build.processing_results?{processing_results:build.processing_results}:{}),...(build.warnings?{warnings:build.warnings}:{})})}</section>`;
}
function nativeSemanticStagesMarkup(run,snapshot){
 const stages=snapshot.semantic_stages??[],enabled=(snapshot.input?.extraction_stage_policy??run?.extraction_stage_policy)==='SEMANTIC_THEN_ORGANIZE_V1';
 if(!enabled)return '';
 const labels={NOT_STARTED:'等待开始',PARTIAL_DRAFT:'已保存部分草稿',SAVED_SETTLED:'草稿已保存',REUSED_SAVED_SETTLED:'沿用已保存草稿',RUNNING:'处理中',SUCCEEDED:'已处理',RETURNED:'已处理',COMPLETED:'已处理',FAILED:'执行失败',UNKNOWN_HOLD:'请求未确认'};
 let html='<section class="panel"><h2>语义草稿与知识组织</h2><p class="help">先理解资料并保存语义草稿，再由独立任务组织知识。草稿和组织完成均不代表事实已核实。</p>';
 if(!stages.length)html+='<p class="help">尚无窗口阶段记录。</p>';
 for(const [i,s]of stages.entries())html+=`<article><h3>窗口 ${i+1}</h3><p>语义识别：${escape(labels[s.semantic?.status]??'已记录')} · ${escape(s.semantic?.items??0)} 条草稿</p><p>知识组织：${escape(s.organization?.status==='SAVED_SETTLED'?'知识已保存':labels[s.organization?.status]??'已记录')} · ${escape(s.organization?.items??0)} 条知识</p>${s.semantic?.status==='REUSED_SAVED_SETTLED'?'<p class="help">本次沿用已保存的语义草稿，没有重新识别资料。</p>':''}${s.semantic?.package_ref?`<button class="btn tiny" data-action="native-semantic-read" data-window-ref="${escape(s.window_ref)}" ${state.busy?'disabled':''}>查看语义草稿</button>`:''}${(s.semantic?.gaps?.length||s.organization?.gaps?.length)?`<details><summary>查看保留缺口</summary><ul>${[...(s.semantic?.gaps??[]),...(s.organization?.gaps??[])].map(g=>`<li>${escape(typeof g==='string'?g:g.message??g.code??JSON.stringify(g))}</li>`).join('')}</ul></details>`:''}</article>`;
 const read=state.nativeSemanticRead;
 if(read?.run_id===run?.run_id){
  const items=[],fragments=new Map();for(const p of read.pages)for(const item of p.items??[]){if(item.fragment_json!==undefined){const f=fragments.get(item.semantic_ref)??{text:'',complete:false};f.text+=item.fragment_json;f.complete=item.complete;fragments.set(item.semantic_ref,f);}else items.push(item);}
  for(const [semantic_ref,f]of fragments){if(f.complete){try{items.push(JSON.parse(f.text));}catch{items.push({semantic_ref,text:'分段内容尚未完整读取，请继续查看。'});}}else items.push({semantic_ref,text:'本条草稿较长，继续读取后可查看完整内容。'});}
  const last=read.pages.at(-1);
  html+=`<div><h3>已读取的语义草稿</h3><p class="help">本窗口共 ${escape(last?.total??0)} 条；${last?.truncated?'仍有未读内容。':'已读至末尾。'}</p>${items.map(item=>`<article><p>${escape(item.text??'')}</p>${item.quote?`<blockquote>${escape(item.quote)}</blockquote>`:''}${[['participants','参与对象与角色'],['values','数值线索'],['conditions','适用限定'],['uncertainties','保留不确定处']].filter(([key])=>item[key]!==undefined).map(([key,label])=>`<p class="help">${label}：${escape(typeof item[key]==='string'?item[key]:JSON.stringify(item[key]))}</p>`).join('')}</article>`).join('')}${last?.truncated?button('继续读取语义草稿','native-semantic-next','tiny',state.busy?'disabled':''):''}</div>`;
 }
 return html+'</section>';
}
function nativeWorkbenchReadbackMarkup(){
 const run=state.nativeRun,build=run?.snapshot?.build??{},held=run?.status==='UNKNOWN_HOLD',cqOnly=nativeRunCQOnly(),view=nativeReadView();
 const views=nativeExtractedPolicy()?[['EXTRACTED_KNOWLEDGE','抽取知识'],['SOURCE','原文来源'],['ADOPTED_FACT','已采用知识']]:[['ADOPTED_FACT','已采用知识'],['SOURCE','原文来源']];
 const indexes=[['知识索引',build.knowledge_index],['原文索引',build.source_index],['采用索引',build.fact_index]].filter(([,index])=>index);
 let markup=`<div class="nbw-indexes">${indexes.map(([label,index])=>`<span>${label} · ${index.status==='READY'?'已保存':escape(index.status??'未建立')}${Number.isInteger(index.records_total)?` · ${index.records_total} 条`:''}</span>`).join('')||'<span>尚无索引记录</span>'}</div>`;
 if(!run||cqOnly)return markup+'<p class="help">本轮尚无知识图与索引；可以先浏览已保存的问题与问题族。</p>';
 markup+=`<section class="nbw-graph-readback"><div class="nbw-query-row"><input id="native-query" value="${escape(state.nativeQuery??'')}" placeholder="搜索实际保存的对象、属性或规则" aria-label="检索已保存知识"><select id="native-query-view" aria-label="检索视图">${views.map(([value,label])=>`<option value="${value}" ${value===view?'selected':''}>${label}</option>`).join('')}</select>${button('检索读回','native-query','tiny',held||state.busy?'disabled':'')}${button(state.nativeGraph?'重新读回图':'查看已存图','native-graph','primary',held||state.busy?'disabled':'')}</div><p class="help">读取已保存的索引，不生成答案，不新增模型请求。</p></section>`;
 if(state.nativeQueryResult){const hits=state.nativeQueryResult.hits??state.nativeQueryResult.results??[];markup+=`<section class="nbw-review"><h3>读回结果 · ${hits.length} 条</h3>${hits.map(hit=>`<article><p>${escape(hit.text??hit.statement??'')}</p>${hit.conditions?.length?`<p class="help">适用条件：${escape(hit.conditions.map(c=>typeof c==='string'?c:c.text??JSON.stringify(c)).join('；'))}</p>`:''}${(hit.evidence??[]).map(e=>`<blockquote>${escape(e.quote??e.span?.quote??'')}</blockquote>`).join('')}</article>`).join('')||'<p class="help">当前索引未命中；不代表资料中不存在相关知识。</p>'}<details class="nbw-record"><summary>完整来源与处理记录</summary><pre>${escape(JSON.stringify(state.nativeQueryResult,null,2))}</pre></details></section>`;}
 if(state.nativeGraph)markup+=nativeGraphMarkup(state.nativeGraph)+`<details class="nbw-record"><summary>图版本与原始记录</summary><pre>${escape(JSON.stringify(state.nativeGraph,null,2))}</pre></details>`;
 else markup+='<div class="nbw-empty"><span>◉</span><p>选择“查看已存图”，浏览对象、关系和对应原文。</p></div>';
 return markup;
}
function refreshNativeWorkbench(){
 const container=root.querySelector?.('.native-build-workbench');
 if(!nativeWorkbenchUi||!container){render();return;}
 const scroll=window.scrollY??0,focused=document.activeElement,searching=focused?.id==='native-workbench-search',start=focused?.selectionStart;
 graphEpoch++;graphView?.dispose();graphView=null;
 container.outerHTML=nativeWorkbenchUi.nativeBuildWorkbench(state,{executionMarkup:state.nativeExecutionMarkup??'',graphMarkup:nativeWorkbenchReadbackMarkup()});
 if(searching){const input=root.querySelector?.('#native-workbench-search');input?.focus?.();if(Number.isInteger(start))input?.setSelectionRange?.(start,start);}
 window.scrollTo?.({top:scroll,behavior:'instant'});void mountGraphView();
}
async function loadNativeArtifacts(kind,{next=false,docRef=''}={}){
 const run=state.nativeRun,id=state.productLibraryId;if(!run)throw Error('尚无已保存的构建运行');
 if(!['chunks','windows','documents','blocks'].includes(kind))throw Error('未知的产物类型');
 const previous=state.nativeArtifacts?.[kind],after=next&&previous?.doc_ref===docRef?previous.next_after:0;
 if(next&&!previous?.has_more)return;
 const path=nativeBase(id)+'/'+encodeURIComponent(run.run_id)+'/artifacts?kind='+kind+'&after='+(after??0)+'&limit=40'+(docRef?'&doc_ref='+encodeURIComponent(docRef):'');
 const page=await api(path);if(state.productLibraryId!==id||state.nativeRun?.run_id!==run.run_id)return;
 state.nativeArtifacts??={};state.nativeArtifacts[kind]={...page,doc_ref:docRef,items:next?[...(previous?.items??[]),...(page.items??[])]:page.items??[]};
 if(kind==='chunks'||kind==='windows')state.nativeChunkKind=kind;
}
function nativeBuildPage(){
 const run=state.nativeRun,snapshot=run?.snapshot??{},ledger=snapshot.run??{},config=nativeConfiguration();
 const cqOnly=nativeRunCQOnly(),selectedCQOnly=nativeSelectedStopAfter()==='FAMILY';
 const reusedOrganizationDraftFrom=run?.reuse_organization_draft_from_run_id,rebuiltFrom=run?.rebuild_saved_proposals_from_run_id,reusedSemanticFrom=run?.reuse_semantic_from_run_id,reusedDraftsFrom=run?.reuse_cq_drafts_from_run_id,reusedCQFrom=run?.reuse_cq_from_run_id,reusedFrom=run?.reuse_cq_family_from_run_id,reusedExtractionFrom=run?.reuse_extraction_from_run_id,capability=selectedCQOnly?'LEXICAL':nativeCapability(),extracted=nativeExtractedPolicy(),build=snapshot.build??{},readView=nativeReadView();
 const reusable=run?.reusable_cq_family,canRetainExtraction=reusable?.available===true&&typeof reusable.reuse_extraction_from_run_id==='string'&&reusable.reuse_extraction_from_run_id.trim().length>0;
 const extractionPolicy=snapshot.input?.extraction_window_policy??snapshot.extraction_windows?.policy;
 const hybridExtraction=extractionPolicy?.version==='HYBRID_EXTRACTION_V1'&&extractionPolicy.token_count_strategy==='cl100k_base'&&extractionPolicy.token_count_exact===true&&
  Number.isSafeInteger(extractionPolicy.window_tokens)&&extractionPolicy.window_tokens>0&&Number.isSafeInteger(extractionPolicy.concurrency)&&extractionPolicy.concurrency>0;
 const names={STARTING:'准备中',OPEN:'等待执行',RUNNING:'构建中',SUCCEEDED:'本次构建完成',READY:'本次构建完成',PARTIALLY_READY:'部分知识可用',FAILED:'执行失败',UNKNOWN_HOLD:'请求结果未确认',STOPPED:'已停止',BLOCKED:'受阻',STALE:'资料已变化'};
 const running=['STARTING','RUNNING','OPEN'].includes(run?.status),held=run?.status==='UNKNOWN_HOLD';
 const checkpoints=ledger.checkpoints??[],attempts=ledger.attempts??[];
 const outputRecovery=run?.program_output_recovery;
 const summary=build.processing_summary??{},hasWarnings=Number(summary.warnings)>0||Number(summary.skipped)>0||Number(outputRecovery?.recovered_count)>0||Number(outputRecovery?.unrecovered_count)>0||Number(outputRecovery?.partial_review_count)>0;
 const completed=['SUCCEEDED','READY','COMPLETED'].includes(run?.status);
 const noKnowledge=!cqOnly&&extracted&&completed&&summary.structured===0&&summary.text===0;
 const statusName=cqOnly&&completed?'CQ与问题族已生成':cqOnly&&run?.status==='PARTIALLY_READY'?'CQ与问题族已生成，含未完成范围':noKnowledge?'本轮未形成可用知识':extracted&&completed?(hasWarnings?'本次构建完成，有告警':'本次构建完成'):(names[run?.status]??'资料已保存，尚未开始');
 const formatRepairs=snapshot.format_repairs??[],formatRepairRequests=formatRepairs.reduce((total,record)=>total+(record.used??0),0);
 const cq=snapshot.cq_input??snapshot.cq?.cq_input??snapshot.cq??{},cqItems=cq.items??[];
 const family=snapshot.families??snapshot.family??{},families=family.families??[];
 const stageNames={SOURCE:'来源准备',SOURCE_READY:'来源准备',CHUNKS_READY:'资料分块已保存',CQ:'发现问题',CQ_DISCOVERY:'发现问题',CQ_SAVED:'问题已保存',CQ_IMPORTED_CONFIRMED:'已沿用问题',FAMILY:'问题族归一',FAMILIES:'问题族归一',FAMILIES_SAVED:'问题族已保存',FAMILIES_IMPORTED_CONFIRMED:'已沿用问题族',CQ_FAMILY_COMPLETE:'CQ与问题族已保存',SCOPE:'范围计划',SCOPE_SAVED:'范围计划已保存',EXTRACTION:'事实抽取',EXTRACTION_SAVED:extracted?'抽取知识已保存':'候选已保存',REVIEW:'独立核实',ADOPTION:'局部采用',ADOPTION_RECORDED:'核实结果已保存',INDEX:'建立索引',INDEXES:'建立索引',INDEX_COMMITTED:'索引已保存',READBACK_VERIFIED:'读回已核对'};
 const reasonLabels={NATIVE_GENERATION_LIMIT:'生成请求上限已到，已确认产物保留。',NATIVE_RUN_DEADLINE:'本次执行时限已到，已确认产物保留。',NATIVE_PRODUCT_RESTART_NO_AUTOMATIC_REPLAY:'服务曾中断，本次请求结果尚未确认；没有自动重发。',NATIVE_SOURCE_STALE:'资料版本已变化，本次结果不能继续作为当前知识使用。'};
 const jsonDetails=(label,value)=>`<details class="panel"><summary>${escape(label)}</summary><pre>${escape(JSON.stringify(value,null,2))}</pre></details>`;
 const pageHeading=head(cqOnly||!run&&selectedCQOnly?'CQ与问题族生成':'原生知识构建',reusedOrganizationDraftFrom?'从已保存的知识草稿继续审阅、局部补全和建立图与索引。':reusedSemanticFrom?'沿用已保存的语义草稿，只重新组织知识并建立图与索引。':reusedDraftsFrom?'沿用已保存CQ草稿，继续问题族、抽取、建图与索引。':reusedCQFrom?'沿用已保存CQ，新建问题族归一请求。':cqOnly||!run&&selectedCQOnly?'从解析后的资料分块发现问题，汇总去重后整理问题族。':reusedFrom?(reusedExtractionFrom?'沿用已保存的问题、问题族及部分抽取产物，继续知识构建。':extracted?'沿用已保存的问题与问题族，重新规划、抽取并建立知识图与索引。':'沿用已保存的问题与问题族，重新规划范围、抽取并独立核实知识。'):'从已解析资料生成新问题与问题族，构建可检索的知识与来源。');
 let content='';
 if(reusedDraftsFrom)content+=`<section class="panel"><p>本次沿用已保存的CQ草稿；原失败请求及其记录保留，不重新发现CQ。</p><details><summary>查看草稿复用来源</summary><p>${escape(reusedDraftsFrom)}</p></details></section>`;
 if(reusedCQFrom)content+=`<section class="panel"><p>本次沿用已保存的 ${cqItems.length} 条CQ，只整理问题族；原请求及其记录保留。</p><details><summary>查看CQ复用来源</summary><p>${escape(reusedCQFrom)}</p></details></section>`;
 if(reusedFrom&&!reusedOrganizationDraftFrom)content+=`<section class="panel"><p>${reusedExtractionFrom?'本次沿用已保存的问题、问题族及部分抽取产物；未完成部分保留缺口，其余窗口继续。':'本次沿用已保存的问题与问题族，范围计划和后续知识重新构建。'}</p><details><summary>查看复用来源</summary><p>${escape(reusedFrom)}</p>${reusedExtractionFrom?`<p>抽取产物来源：${escape(reusedExtractionFrom)}</p>`:''}</details></section>`;
 if(canRetainExtraction){
  const counted=Number.isSafeInteger(reusable.retained_windows)&&reusable.retained_windows>=0&&Number.isSafeInteger(reusable.retained_knowledge)&&reusable.retained_knowledge>=0;
  const partial=Number.isSafeInteger(reusable.partial_retained_windows)&&reusable.partial_retained_windows>0?`，其中 ${reusable.partial_retained_windows} 窗尚未完整`:'';
  content+=`<p class="help">${counted?`可沿用已保存的 ${reusable.retained_windows} 个抽取窗口、${reusable.retained_knowledge} 条知识`:'可沿用已保存的抽取产物'}${partial}；未完成部分保留缺口，其余窗口继续。</p>`;
 }
 if(!cqOnly&&hybridExtraction)content+=`<p class="help">抽取窗口：Docling HybridChunker · cl100k_base · 每窗正文上限 ${extractionPolicy.window_tokens} tokens · 最多 ${extractionPolicy.concurrency} 路并发。</p>`;
 if(formatRepairs.length)content+=`<p class="notice">参数格式纠正已请求 ${formatRepairRequests} 次，计入下方调用总数；是否保存成功仍以构建结果为准。</p>`;
 if(outputRecovery&&(outputRecovery.normalizations?.length||outputRecovery.partial_review_count))content+=`<section class="panel"><h2>格式处理与审阅告警</h2>${outputRecovery.recovered_count?`<p class="notice warning">程序已修复 ${escape(outputRecovery.recovered_count)} 处工具参数格式，原始参数和修复记录已保留；没有为格式修复新增模型请求。</p>`:''}${outputRecovery.unrecovered_count?`<p class="notice warning">${escape(outputRecovery.unrecovered_count)} 处参数未能恢复，原文已保留。相关输出尚未完整保存。</p>`:''}${outputRecovery.partial_review_count?`<p class="notice warning">${escape(outputRecovery.partial_review_count)} 个窗口的关系审阅部分完成；已保存知识可继续建图索引，未完成审阅仍作为告警保留。</p>`:''}${jsonDetails('查看格式处理与未恢复原文',outputRecovery)}</section>`;
 if(rebuiltFrom)content+=`<section class="panel"><p>本次沿用已保存的问题、问题族和抽取原稿重建图谱，不重新抽取资料；原运行与原稿保留。</p></section>`;
 if(reusedOrganizationDraftFrom)content+=`<section class="panel"><p>本次由程序复用已保存的知识草稿，仅继续审阅、必要的局部修订和建图索引；不重新生成问题、问题族或语义，也不要求模型重新提交原草稿。</p><details><summary>查看知识草稿来源</summary><p>${escape(reusedOrganizationDraftFrom)}</p></details></section>`;
 else if(reusedSemanticFrom)content+='<section class="panel"><p>本次沿用原问题、问题族及已保存的语义草稿，仅重新组织知识；没有重新识别语义。</p></section>';
 if(reusedOrganizationDraftFrom&&run.organization_draft_imports?.some(r=>r.saved&&r.initial_drafts_imported))content+=`<p class="help">程序已导入 ${escape(run.organization_draft_imports.filter(r=>r.saved&&r.initial_drafts_imported).reduce((n,r)=>n+r.knowledge_count,0))} 条来源知识草稿；后续修订单独记录。</p>`;
 const draftRecovery=nativeOrganizationDraftRecovery(),draftCandidate=nativeOrganizationDraftCandidate();
 if(draftRecovery?.available&&draftCandidate)content+=`<section class="panel"><h2>继续已保存的知识草稿</h2><p>程序已校验保存的知识、回执和来源。新运行直接承接 ${escape(draftCandidate.item_count)} 条草稿，继续审阅、局部补全和建立图与索引，不要求模型重交草稿。原运行状态与记录保留。</p><div class="field"><label for="native-organization-draft-origin">已校验知识草稿</label><select id="native-organization-draft-origin">${draftRecovery.candidates.map((c,i)=>`<option value="${escape(c.upstream_run_id)}" ${c===draftCandidate?'selected':''}>知识草稿 ${i+1} · ${escape(c.item_count)} 条 · ${escape(c.semantic_item_count)} 项语义 · ${escape(c.window_count)} 窗</option>`).join('')}</select></div><details><summary>查看来源运行</summary><p>${escape(draftCandidate.upstream_run_id)}</p></details>${draftRecovery.requires_unknown_acknowledgement?`<p>${escape(draftRecovery.hold_count)} 轮旧请求仍未确认，旧请求不会恢复或重发。</p><label class="consent"><input type="checkbox" id="native-organization-draft-ack" ${state.nativeOrganizationDraftConfirmation===draftCandidate.unknown_acknowledgement_ref?'checked':''}><span>我已了解旧请求仍未确认；确认仅使用以上知识草稿新开独立运行。</span></label>`:''}${button('复用已保存知识草稿，继续审阅并建图索引','native-reuse-organization-draft','primary',nativeCanReuseOrganizationDraft()?'':'disabled')}</section>`;
 if(run?.reusable_semantic_packages?.available)content+=`<section class="panel"><p>可沿用已保存的 ${escape(run.reusable_semantic_packages.item_count??'')} 条语义草稿，独立重新组织知识。</p>${button('沿用语义草稿，重新组织知识','native-reuse-semantic','primary',nativeCanReuseSemantic()?'':'disabled')}</section>`;
 const recovery=nativeSemanticRecovery(),recoveryCandidate=nativeSemanticRecoveryCandidate();
 if(recovery?.available&&recoveryCandidate)content+=`<section class="panel"><h2>从已确认草稿新开知识组织</h2><p>${escape(recovery.hold_count)} 轮旧请求仍未确认，原记录和已发送请求保留。本次使用已确认的语义草稿创建独立运行，不恢复或重发旧请求，也不沿用未确认的组织结果。</p><div class="field"><label for="native-semantic-recovery-origin">已确认语义草稿</label><select id="native-semantic-recovery-origin">${recovery.candidates.map((c,i)=>`<option value="${escape(c.upstream_run_id)}" ${c===recoveryCandidate?'selected':''}>草稿 ${i+1} · ${escape(c.item_count)} 条 · ${escape(c.window_count)} 窗</option>`).join('')}</select></div><details><summary>查看草稿来源</summary><p>${escape(recoveryCandidate.upstream_run_id)}</p></details><label class="consent"><input type="checkbox" id="native-semantic-recovery-ack" ${state.nativeRecoveryConfirmation===recoveryCandidate.unknown_acknowledgement_ref?'checked':''}><span>我已了解旧请求仍未确认；确认仅从以上 ${escape(recoveryCandidate.item_count)} 条草稿新开组织、建图和索引。</span></label>${button('确认并新开知识组织','native-recover-semantic','primary',nativeCanRecoverSemantic()?'':'disabled')}</section>`;
 if(run?.rebuildable_proposals?.available===true)content+=`<section class="panel"><p>可使用已保存的 ${escape(run.rebuildable_proposals.item_count??'')} 条抽取结果重新整理知识和图谱，保留问题与原稿，只为缺少向量的知识补充索引。</p>${button('用已保存的抽取结果重建图谱','native-rebuild-proposals','primary',nativeCanRebuildProposals()?'':'disabled')}</section>`;
 if(run?.reusable_cq_drafts?.available===true)content+=`<section class="panel"><p>已保留 ${escape(run.reusable_cq_drafts.cq_count)} 条窗口CQ草稿，全局汇总尚未完成。可沿用合法草稿继续构建；原失败记录保持不变。</p>${button('沿用已保存CQ草稿，继续构建','native-reuse-cq-drafts','primary',nativeCanReuseCQDrafts()?'':'disabled')}</section>`;
 if(cqOnly&&held&&run.reusable_cq?.available===true)content+=`<section class="panel"><p>旧请求结果未确认，${escape(run.reusable_cq.cq_count??cqItems.length)} 条CQ已保存。可沿用这些CQ新建一次问题族请求；旧请求保持未确认，不重新生成CQ。</p>${button('沿用已保存CQ，继续问题族','native-reuse-cq','primary',nativeCanReuseCQ()?'':'disabled')}</section>`;
 content+=`<section class="panel" aria-live="polite"><div class="row"><h2>${escape(statusName)}</h2>${button('刷新','native-refresh','tiny',state.busy?'disabled':'')}</div><p>资料目录已注册；点击开始后才发送模型请求。</p>${run?.reason?`<p class="notice warning">${escape(reasonLabels[run.reason]??(extracted&&completed?'本次构建已完成，处理记录包含提示。':'本次构建未完成；已确认产物与处理记录保留。'))}</p><details><summary>查看处理记录</summary><p>${escape(run.reason)}</p></details>`:''}<p>问题 ${cqItems.length} 条 · 问题族 ${families.length} 个 · 已记录模型请求 ${attempts.filter(a=>a.kind==='GENERATION').length} 次 · 向量批次 ${attempts.filter(a=>a.kind==='EMBEDDING').length}</p>${checkpoints.length?`<p class="help">已保存阶段：${checkpoints.map(c=>escape(stageNames[c.stage]??'产物已保存')).join(' → ')}</p>`:''}${!config.generation_configured?`<p class="notice warning">请先配置原生生成模型。${button('模型设置','nav-model','tiny')}</p>`:''}${!selectedCQOnly&&!config.embedding_configured?'<p class="help">向量模型尚未配置；可显式选择词法构建，向量索引不会显示就绪。</p>':''}</section>`;
 content+=`<section class="panel"><h2>本次执行范围</h2>
 <div class="field"><label for="native-stop-after">执行到哪一步</label><select id="native-stop-after"><option value="FAMILY" ${selectedCQOnly?'selected':''}>仅生成CQ与问题族</option><option value="FULL" ${!selectedCQOnly?'selected':''}>完整知识构建</option></select></div>
 <p class="help">${selectedCQOnly?'本次完成资料分块、CQ发现与问题族整理后结束，无需向量模型。':'完整构建会继续范围规划、抽取、建图与索引；新构建先保存语义草稿，再组织知识。'}</p>
 <div class="field"><label for="native-capability">索引能力</label><select id="native-capability" ${selectedCQOnly?'disabled':''}><option value="HYBRID" ${capability==='HYBRID'?'selected':''}>词法与向量</option><option value="LEXICAL" ${capability==='LEXICAL'?'selected':''}>仅词法</option></select></div>
 <details><summary>调用上限</summary><div class="field"><label for="native-generation-limit">所有阶段生成请求总数</label><input id="native-generation-limit" type="number" min="0" value="${run?.limits?.max_generation_requests??16}"></div>
 <div class="field"><label for="native-embedding-limit">向量请求批数</label><input id="native-embedding-limit" type="number" min="0" value="${selectedCQOnly?0:run?.limits?.max_embedding_batches??12}" ${selectedCQOnly?'disabled':''}></div>
 <div class="field"><label for="native-embedding-items">向量文本总条数</label><input id="native-embedding-items" type="number" min="0" value="${selectedCQOnly?0:nativeLimitValue('max_embedding_items',800,200)}" ${selectedCQOnly?'disabled':''}></div>
 <div class="field"><label for="native-embedding-chars">向量文本累计字符数</label><input id="native-embedding-chars" type="number" min="0" value="${selectedCQOnly?0:nativeLimitValue('max_embedding_text_chars',800000,120000)}" ${selectedCQOnly?'disabled':''}></div>
 <div class="field"><label for="native-wall-seconds">总执行时限（秒）</label><input id="native-wall-seconds" type="number" min="1" value="${(run?.limits?.max_wall_ms??600000)/1000}"></div><div class="field"><label for="native-request-mib">单次模型输入上限（MiB）</label><input id="native-request-mib" type="number" min="1" value="${(run?.limits?.max_request_bytes??1048576)/1048576}"></div><div class="field"><label for="native-total-mib">累计模型输入上限（MiB）</label><input id="native-total-mib" type="number" min="1" value="${(run?.limits?.max_total_bytes??8388608)/1048576}"></div></details>
 <label class="consent"><input type="checkbox" id="native-format-repair" ${run?.allow_format_repair_once?'checked':''}><span>工具参数格式错误时，每个 Agent 可纠正一次（新请求计入调用上限）</span></label><p class="help">所有阶段共享上限；网络失败或请求结果不明时停止外发，刷新页面不会重发。</p>
 ${button(selectedCQOnly?'生成CQ与问题族':run?'开始一个新构建':'开始本次构建','native-start','primary',state.busy||running||held||recovery?.hold_count>0||!config.generation_configured?'disabled':'')}${run?button('复用问题与问题族，重新构建知识','native-reuse-cq-family','',nativeCanReuse(capability)?'':'disabled'):''}${run?'<p class="help">复用会从已保存的问题与问题族继续规划、抽取并建立索引；新生成会重新发现问题。</p>':''}</section>`;
 if(nativeWorkbenchUi){state.nativeExecutionMarkup=content;return pageHeading+nativeWorkbenchUi.nativeBuildWorkbench(state,{executionMarkup:content,graphMarkup:nativeWorkbenchReadbackMarkup()});}
 content+=`<section class="panel"><h2>${reusedCQFrom?'沿用的CQ与本轮问题族':reusedFrom?'沿用的问题与问题族':'本轮问题与问题族'}</h2>${cqItems.length?`<ol>${cqItems.map(q=>`<li>${escape(q.question)} <small>${escape(q.cq_ref)}</small></li>`).join('')}</ol>`:'<p class="help">本轮问题尚未保存。</p>'}${families.length?`<details><summary>查看 ${families.length} 个问题族</summary>${families.map(f=>`<p><strong>${escape(f.name)}</strong> ${escape(f.representative_question)}<br><small>${escape((f.member_refs??[]).join('、'))}</small></p>`).join('')}</details>`:''}</section>`;
 if(extracted&&(snapshot.cq?.processing_summary||family.processing_summary))content+=jsonDetails('查看问题与问题族处理记录',{cq:snapshot.cq?.processing_summary??null,family:family.processing_summary??null});
 if(snapshot.chunked_cq?.merge?.semantic_status==='NOT_COMPLETED_DRAFTS_RETAINED')content+='<p class="notice warning">已保留原始CQ，未完成语义去重；后续构建继续使用已保存问题。</p>';
 if(snapshot.chunked_cq?.merge?.mode==='HOST_EXACT_DEDUP')content+='<p class="help">CQ由程序汇集并精确去重，原问句与来源保留。</p>';
 if(snapshot.chunk_plan_summary||snapshot.chunked_cq)content+=jsonDetails('查看资料分块与CQ汇总记录',{...(snapshot.chunk_plan_summary?{chunks:snapshot.chunk_plan_summary}:{}),...(snapshot.chunked_cq?{cq:snapshot.chunked_cq}:{})});
 if(run&&!cqOnly){
  content+=nativeSemanticStagesMarkup(run,snapshot);
  if(held&&snapshot.partial_organization?.knowledge_count)content+=`<section class="panel"><p>已保存 ${escape(snapshot.partial_organization.knowledge_count)} 条组织草稿；本轮父级图与索引尚未确认完成。</p><details><summary>查看已保存组织草稿</summary>${snapshot.partial_organization.knowledge.map(k=>`<p>${escape(k.text??k.statement??'')}</p>`).join('')}</details></section>`;
  if(extracted)content+=nativeKnowledgeSummary(build,jsonDetails);
  const views=extracted?[['EXTRACTED_KNOWLEDGE','抽取知识'],['SOURCE','原文来源'],['ADOPTED_FACT','已采用知识']]:[['ADOPTED_FACT','已采用知识'],['SOURCE','原文来源']];
  content+=`<section class="panel"><h2>检索实际保存的知识</h2><p class="help">此处读回${extracted?'抽取知识、原文来源或已采用事实':'来源或已采用事实'}；不生成整题答案，也不新增模型请求。</p><div class="field"><label for="native-query">检索内容</label><input id="native-query" value="${escape(state.nativeQuery??'')}" placeholder="输入对象、规则或属性"></div><select id="native-query-view" aria-label="检索视图">${views.map(([value,label])=>`<option value="${value}" ${readView===value?'selected':''}>${label}</option>`).join('')}</select>${button('检索读回','native-query','primary',state.busy||held?'disabled':'')}${button('查看已存图','native-graph','tiny',state.busy||held?'disabled':'')}</section>`;
  if(state.nativeQueryResult){const hits=state.nativeQueryResult.hits??state.nativeQueryResult.results??[];content+=`<section class="panel"><h2>读回结果 · ${hits.length} 条</h2>${hits.map(h=>`<article><p>${escape(h.text??h.statement??'')}</p>${h.conditions?.length?`<p class="help">适用条件：${escape(h.conditions.map(c=>typeof c==='string'?c:c.text??JSON.stringify(c)).join('；'))}</p>`:''}${(h.evidence??[]).map(e=>`<blockquote>${extracted?'<small>抽取时保留的引句；定位情况见来源记录</small><br>':''}${escape(e.quote??e.span?.quote??'')}</blockquote>`).join('')}${extracted&&h.quote?`<blockquote><small>抽取时保留的引句；定位情况见来源记录</small><br>${escape(h.quote)}</blockquote>`:''}${extracted&&Array.isArray(h.warnings)&&h.warnings.length?`<p class="notice warning">${escape(h.warnings.map(w=>typeof w==='string'?w:w.message??w.code??JSON.stringify(w)).join('；'))}</p>`:''}</article>`).join('')||'<p class="help">当前索引未命中；不代表资料中不存在相关知识。</p>'}</section>`;content+=jsonDetails(extracted?'查看完整来源与质量记录':'查看完整来源与采用记录',state.nativeQueryResult);}
  if(state.nativeGraph)content+=nativeGraphMarkup(state.nativeGraph)+jsonDetails('查看图版本与原始记录',state.nativeGraph);
  content+=jsonDetails('构建阶段与索引记录',snapshot.build??snapshot);
 }else if(run)content+=jsonDetails('查看CQ与问题族阶段记录',{run:ledger,cq:snapshot.cq_input??null,families:snapshot.families??null});
 return pageHeading+content;
}
async function refreshProductView(){
 const id=state.productLibraryId,epoch=state.productEpoch;if(!id)return false;
 const next=await api('/api/product/libraries/'+encodeURIComponent(id)+'/view');if(id!==state.productLibraryId||epoch!==state.productEpoch)return false;
 const changed=JSON.stringify(next)!==JSON.stringify(state.productView);
 state.productSourceChanged=Boolean(state.productView&&JSON.stringify(next.source_stamp)!==JSON.stringify(state.productView.source_stamp));
 if(state.productSourceChanged){
  clearProductAnswer();state.productReviewSelected=null;
  const initial=state.productInitialBuild;
  // Parser/index receipts can change the source stamp during the first build.
  // Only a changed source epoch means this is a different user-visible scope.
  if(initial?.library_id===id&&initial.source_epoch!==null&&initial.source_epoch!==next.library?.source_epoch)initial.auto_open=false;
 }
 state.productView=next;
 if(next.native_full_chain&&state.knowledgeMode!=='sources')state.knowledgeMode='native';
 const oldNative=JSON.stringify(state.nativeRun);if(next.native_full_chain)await refreshNativeRun();
 const initial=state.productInitialBuild;
 if(initial?.auto_open&&initial.library_id===id&&state.view==='knowledge'&&state.knowledgeMode==='processing'){
  if(initial.source_epoch===null)initial.source_epoch=next.library?.source_epoch;
  const focused=document.activeElement,editing=['INPUT','TEXTAREA','SELECT'].includes(focused?.tagName?.toUpperCase?.())||focused?.isContentEditable===true;
  if(!editing&&initial.source_epoch===next.library?.source_epoch&&next.processing?.graph_ready===true&&next.published_graph?.publication_status==='PUBLISHED'&&next.published_graph?.published_graph_revision&&next.published_graph?.status==='READY'&&next.published_graph.index_status==='READY'){
   initial.auto_open=false;state.knowledgeMode='graph';state.productAutoGraphTransition=true;
  }
 }
 return changed||oldNative!==JSON.stringify(state.nativeRun)||state.productAutoGraphTransition===true;
}
async function openProductLibrary(id,{mode='answers',initialBuild=null}={}){
 state.nativeRun=null;state.nativeQueryResult=null;state.nativeGraph=null;state.nativeQueryView=null;state.nativeStopAfter=null;state.nativeBrowseRunId=null;state.nativeWorkbenchStage=null;state.nativeArtifacts={};state.nativeWorkbenchSelection={};state.nativeWorkbenchQuery={};
 await loadProductUi();state.productEpoch=(state.productEpoch||0)+1;state.productLibraryId=id;state.productView=null;state.productCreationPending=null;state.productInitialBuild=initialBuild;state.productReviewSelected=null;state.task=null;state.selected=null;state.askQuestion='';state.knowledgeMode=mode;state.view='knowledge';state.librarySupplement=null;state.productReplacement=null;clearProductAnswer();
 await refreshProductView();if(nativeEnabled())await loadNativeWorkbenchUi();render();
}
function renderProductPoll(previous){
 if(nativeEnabled()){
  if(nativeWorkbenchUi&&state.nativeWorkbenchStage==='graph'&&state.nativeGraph&&graphView&&state.nativeRun?.source_current!==false)return;
  if(!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName?.toUpperCase?.())){const scroll=window.scrollY??0;render();window.scrollTo?.({top:scroll,behavior:'instant'});}return;
 }
 const mode=state.knowledgeMode??'answers';
 const preserveFocus=()=>{const focused=document.activeElement,id=focused?.id,start=focused?.selectionStart,end=focused?.selectionEnd;render();const replacement=id?document.getElementById?.(id)??document.querySelector('#'+id):null;if(replacement&&focused!==replacement){replacement.focus?.();if(Number.isInteger(start)&&Number.isInteger(end))replacement.setSelectionRange?.(start,end);}};
 if(state.productAutoGraphTransition){state.productAutoGraphTransition=false;preserveFocus();return;}
 if(state.productSourceChanged){preserveFocus();return;}
 if(mode==='processing'){
  const live=document.querySelector('#product-processing-live');if(!live){preserveFocus();return;}live.innerHTML=productUi.processingProgress(state);
  const graphButton=document.querySelector('#product-processing-open-graph');if(graphButton)graphButton.disabled=!(state.productView?.processing?.candidate_graph_available??(!Object.hasOwn(state.productView??{},'published_graph')&&state.productView?.processing?.graph_available));
  const before=productUi.reviewItems(previous),after=productUi.reviewItems(state.productView),focused=document.activeElement;
  if(JSON.stringify(before)!==JSON.stringify(after)){
   const queue=document.querySelector('#product-review-queue');if(queue&&!focused?.closest?.('#product-review-queue'))queue.innerHTML=productUi.reviewQueue(state);
   const pane=document.querySelector('#product-review-content');if(pane&&!focused?.closest?.('#product-review-content'))pane.innerHTML=productUi.reviewPane(state);else if(pane){const selected=after.find(i=>i.id===state.productReviewSelected),status=document.querySelector('#product-review-state');if(status)status.textContent=productUi.reviewStatus[selected?.status]??selected?.status??'此项已变化';if(!selected||!['OPEN','DEFERRED'].includes(selected.status))for(const control of pane.querySelectorAll?.('[data-action="product-review-decision"]')??[])control.disabled=true;}
  }
  const diagnostics=document.querySelector('#product-processing-diagnostics');if(diagnostics)diagnostics.innerHTML=productUi.processingDiagnostics(state);
  return;
 }
 if(mode==='graph'||mode==='candidate'){
  const oldGraph=productGraphForMode(previous,mode),newGraph=productGraphForMode(state.productView,mode);
  if(oldGraph?.graph_revision!==newGraph?.graph_revision||oldGraph?.status!==newGraph?.status||oldGraph?.publication_status!==newGraph?.publication_status||oldGraph?.scope_availability!==newGraph?.scope_availability||oldGraph?.index_status!==newGraph?.index_status)preserveFocus();
  else{const notice=document.querySelector('#product-graph-processing-notice');if(notice)notice.innerHTML=productUi.graphStatusMarkup(state,{candidatePreview:mode==='candidate'});}
  return;
 }
 if(mode==='scope'){preserveFocus();return;}
 if(mode==='answers'){
  const routeNotice=document.querySelector('.product-answer-scope');if(routeNotice)routeNotice.outerHTML=productUi.scopeRouteMarkup(state.productAnswer,state.productView);
  const status=document.querySelector('#product-learning-status');if(status){status.outerHTML=productUi.learningStatus(state.productView,state.productModels);return;}
  preserveFocus();
 }
}
function productGraphForMode(view,mode){return mode==='candidate'?(view?.candidate_preview??view?.graph):Object.hasOwn(view??{},'published_graph')?view.published_graph:view?.graph;}
function updateProductInspector(id,kind='entity'){
 const payload=productGraphForMode(state.productView,state.knowledgeMode);
 if(!productGraphTools||!payload)return;
 state.productGraphSelected={id,kind};const panel=document.querySelector('#product-graph-inspector');
 if(panel){const detail=productGraphTools.inspectSourceGraph(payload,id,kind);if(detail&&kind==='statement'){detail.subject_label=productGraphTools.inspectSourceGraph(payload,detail.item.subject_id,'entity')?.item.label;if(detail.item.object?.entity_id)detail.object_label=productGraphTools.inspectSourceGraph(payload,detail.item.object.entity_id,'entity')?.item.label;}panel.innerHTML=productUi.graphInspector(detail,state.productView.library?.sources??[],state.knowledgeMode==='graph'&&Object.hasOwn(state.productView??{},'published_graph'));}
 document.querySelector('[data-product-graph-workbench]')?.classList?.remove('graph-overview');
}
async function handleProductAction(action,el){
 if(action==='knowledge-native'){state.view='knowledge';state.knowledgeMode='native';render();return true;}
 if(action==='native-toggle-mode'){state.nativeCreate=!state.nativeCreate;render();return true;}
 if(action==='native-refresh'){await refreshProductView();return true;}
 if(action==='native-workbench-stage'||action==='native-workbench-jump'){
  state.nativeWorkbenchStage=el.dataset.stage;state.nativeWorkbenchListLimit=120;
  if(action==='native-workbench-jump'){state.nativeWorkbenchSelection??={};state.nativeWorkbenchSelection[el.dataset.stage]=el.dataset.id;}
  if(el.dataset.stage==='graph'&&!state.nativeGraph&&state.nativeRun&&state.nativeRun.status!=='UNKNOWN_HOLD'&&!nativeRunCQOnly()&&[state.nativeRun.snapshot?.build?.knowledge_index,state.nativeRun.snapshot?.build?.fact_index,state.nativeRun.snapshot?.build?.source_index].some(index=>index?.status==='READY')){await handleProductAction('native-graph',{dataset:{}});state.busy=false;}
  refreshNativeWorkbench();return true;
 }
 if(action==='native-workbench-select'){state.nativeWorkbenchSelection??={};state.nativeWorkbenchSelection[el.dataset.stage??state.nativeWorkbenchStage??'knowledge']=el.dataset.id;refreshNativeWorkbench();return true;}
 if(action==='native-workbench-more'){state.nativeWorkbenchListLimit=(state.nativeWorkbenchListLimit??120)+120;refreshNativeWorkbench();return true;}
 if(action==='native-chunk-kind'){state.nativeChunkKind=el.dataset.kind;state.nativeWorkbenchSelection??={};delete state.nativeWorkbenchSelection.chunks;if(!state.nativeArtifacts?.[el.dataset.kind])await loadNativeArtifacts(el.dataset.kind);refreshNativeWorkbench();return true;}
 if(action==='native-artifacts-load'||action==='native-artifacts-next'){await loadNativeArtifacts(el.dataset.kind,{next:action==='native-artifacts-next',docRef:el.dataset.docRef??''});refreshNativeWorkbench();return true;}
 if(action==='native-semantic-read'||action==='native-semantic-next'){
  const run=state.nativeRun;if(!run)throw Error('尚无语义草稿');
  const previous=state.nativeSemanticRead,next=action==='native-semantic-next',last=previous?.pages?.at(-1),windowRef=next?previous?.window_ref:el.dataset.windowRef;
  if(!windowRef||next&&!last?.truncated)throw Error('没有未读语义内容');
  const after=next?last.next_after:0,offset=next?last.next_offset:0,path=nativeBase(state.productLibraryId)+'/'+encodeURIComponent(run.run_id)+'/semantic-packages?window_ref='+encodeURIComponent(windowRef)+'&after='+after+'&offset='+offset;
  const page=await api(path);if(state.nativeRun?.run_id===run.run_id)state.nativeSemanticRead={run_id:run.run_id,window_ref:windowRef,pages:next?[...previous.pages,page]:[page]};if(nativeWorkbenchUi){state.nativeWorkbenchStage='semantic';state.nativeWorkbenchSelection??={};state.nativeWorkbenchSelection.semantic=windowRef;refreshNativeWorkbench();}else render();return true;
 }
 if(action==='native-start'||action==='native-reuse-semantic'||action==='native-recover-semantic'||action==='native-reuse-organization-draft'||action==='native-reuse-cq-family'||action==='native-reuse-cq'||action==='native-reuse-cq-drafts'||action==='native-rebuild-proposals'){
  const id=state.productLibraryId;if(!id)throw Error('请先保存解析资料');
  const reuseOrganizationDraft=action==='native-reuse-organization-draft',reuse=action==='native-reuse-cq-family',reuseCQ=action==='native-reuse-cq',reuseDrafts=action==='native-reuse-cq-drafts',rebuild=action==='native-rebuild-proposals',recoverSemantic=action==='native-recover-semantic',reuseSemantic=action==='native-reuse-semantic'||recoverSemantic;
  if(reuseCQ&&!nativeCanReuseCQ())throw Error('当前CQ不能沿用，请刷新并核对来源、已保存产物和模型配置。');
  if(!reuseCQ&&!recoverSemantic&&!reuseOrganizationDraft&&(['UNKNOWN','UNKNOWN_HOLD'].includes(state.nativeRun?.status)||nativeSemanticRecovery()?.hold_count>0))throw Error('旧请求结果未确认，请使用已确认草稿的显式新建入口。');
  // Embedded legacy callers without the scope control retain full construction.
  const cqOnly=reuseCQ||!reuse&&!reuseDrafts&&!rebuild&&!reuseSemantic&&!reuseOrganizationDraft&&(document.querySelector('#native-stop-after')?.value??state.nativeStopAfter??'FULL')==='FAMILY';
  const number=(selector,fallback)=>{const control=document.querySelector(selector);return Number((reuseDrafts||rebuild||reuseSemantic||reuseOrganizationDraft)&&control?.disabled?fallback:control?.value??fallback);};
  const limits={max_generation_requests:number('#native-generation-limit',16),max_embedding_batches:number('#native-embedding-limit',12),max_embedding_items:number('#native-embedding-items',nativeLimitValue('max_embedding_items',800,200)),max_embedding_text_chars:number('#native-embedding-chars',nativeLimitValue('max_embedding_text_chars',800000,120000)),max_wall_ms:number('#native-wall-seconds',600)*1000,max_request_bytes:number('#native-request-mib',1)*1024*1024,max_total_bytes:number('#native-total-mib',8)*1024*1024,max_response_bytes:reuseCQ?nativeResponseBytes:nativeLimitValue('max_response_bytes',nativeResponseBytes,nativeResponseBytes)};
  if(cqOnly)Object.assign(limits,{max_embedding_batches:0,max_embedding_items:0,max_embedding_text_chars:0});
  if(rebuild)limits.max_generation_requests=0;
  const capability=cqOnly?'LEXICAL':(reuseDrafts||rebuild||reuseSemantic||reuseOrganizationDraft)&&document.querySelector('#native-capability')?.disabled?(state.nativeRun?.capability??'HYBRID'):document.querySelector('#native-capability')?.value??'HYBRID';
  const allowFormatRepairOnce=!rebuild&&document.querySelector('#native-format-repair')?.checked===true;
  if(reuseSemantic&&!recoverSemantic&&!nativeCanReuseSemantic(capability))throw Error('当前语义草稿不可复用，请核对来源和模型配置。');
  if(recoverSemantic&&!nativeCanRecoverSemantic(capability))throw Error('请先核对并确认已保存草稿；确认范围变化时需刷新后重新确认。');
  if(reuseOrganizationDraft&&!nativeCanReuseOrganizationDraft(capability))throw Error('请核对知识草稿来源并完成本次确认；范围变化时需刷新后重新确认。');
  if(rebuild&&!nativeCanRebuildProposals(capability))throw Error('当前抽取原稿不能重建，请刷新并核对来源及索引配置。');
  if(reuseDrafts&&!nativeCanReuseCQDrafts(capability))throw Error('当前CQ草稿不能沿用，请核对来源、已保存产物和模型配置。');
  if(reuse&&!nativeCanReuse(capability))throw Error('当前问题与问题族不可复用，请核对模型配置并刷新构建状态。');
  const upstreamRunId=reuse?state.nativeRun.reusable_cq_family.upstream_run_id:null;
  const rebuildFromRunId=rebuild?state.nativeRun.rebuildable_proposals.upstream_run_id:null;
  const upstreamDraftsRunId=reuseDrafts?state.nativeRun.reusable_cq_drafts.upstream_run_id:null;
  const upstreamCQRunId=reuseCQ?state.nativeRun.reusable_cq.upstream_run_id:null;
  const extractionFrom=reuse?state.nativeRun.reusable_cq_family.reuse_extraction_from_run_id:null;
  const retainedExtractionFrom=typeof extractionFrom==='string'&&extractionFrom.trim()?extractionFrom:null;
  if(rebuild||reuseSemantic||reuseOrganizationDraft)state.nativeStopAfter='FULL';
  const recoveryOrigin=recoverSemantic?nativeSemanticRecoveryCandidate():null;
  const organizationDraftOrigin=reuseOrganizationDraft?nativeOrganizationDraftCandidate():null;
  state.busy=true;await api(nativeBase(id),{request_id:crypto.randomUUID(),consent:true,limits,capability,...(reuseSemantic?{reuse_semantic_from_run_id:recoverSemantic?recoveryOrigin.upstream_run_id:state.nativeRun.reusable_semantic_packages.upstream_run_id}:{}),...(recoverSemantic?{acknowledge_unknown:true,unknown_acknowledgement_ref:recoveryOrigin.unknown_acknowledgement_ref}:{}),...(reuseOrganizationDraft?{reuse_organization_draft_from_run_id:organizationDraftOrigin.upstream_run_id,...(nativeOrganizationDraftRecovery().requires_unknown_acknowledgement?{acknowledge_unknown:true,unknown_acknowledgement_ref:organizationDraftOrigin.unknown_acknowledgement_ref}:{})}:{}),...(cqOnly?{stop_after:'FAMILY'}:{}),...(allowFormatRepairOnce?{allow_format_repair_once:true}:{}),...(reuse?{reuse_cq_family_from_run_id:upstreamRunId}:{}),...(retainedExtractionFrom?{reuse_extraction_from_run_id:retainedExtractionFrom}:{}),...(reuseCQ?{reuse_cq_from_run_id:upstreamCQRunId,acknowledge_unknown:true}:{}),...(reuseDrafts?{reuse_cq_drafts_from_run_id:upstreamDraftsRunId}:{}),...(rebuild?{rebuild_saved_proposals_from_run_id:rebuildFromRunId}:{})});await refreshProductView();return true;
 }
 if(action==='native-query'||action==='native-graph'){
  const id=state.productLibraryId,run=state.nativeRun;if(!run)throw Error('本次构建尚无读回版本');
  if(nativeRunCQOnly())throw Error('本次仅生成CQ与问题族，尚无图与知识索引。');
  state.busy=true;const path=nativeBase(id)+'/'+encodeURIComponent(run.run_id),view=document.querySelector('#native-query-view')?.value??nativeReadView();
  state.nativeQueryView=view;
  const requestKey=JSON.stringify([id,run.run_id,view,action]);state.nativeReadbackRequestKey=requestKey;
  const current=()=>state.productLibraryId===id&&state.nativeRun?.run_id===run.run_id&&nativeReadView()===view&&state.nativeReadbackRequestKey===requestKey;
  if(action==='native-graph'){
   const payload=await api(path+'/graph?view='+encodeURIComponent(view));if(!current())return true;
   if(payload.domain_graph){await loadNativeGraphUi();if(!current())return true;}
   state.nativeGraph=payload;state.nativeDomainSelected=null;state.nativeDomainFocus=null;
  }else{state.nativeQuery=document.querySelector('#native-query')?.value??'';const result=await api(path+'/query',{view,query:state.nativeQuery,limit:12});if(current())state.nativeQueryResult=result;}
  return true;
 }
 if(action==='native-domain-node'){state.nativeDomainFocus=el.dataset.id;updateNativeDomainInspector(el.dataset.id,'entity');graphView?.select(el.dataset.id,'entity');return true;}
 if(action==='native-domain-relation'){updateNativeDomainInspector(el.dataset.id,'statement');graphView?.select(el.dataset.id,'statement');return true;}
 if(action==='native-domain-knowledge'){updateNativeDomainInspector(el.dataset.id,'knowledge');graphView?.select(el.dataset.id,'knowledge');root.querySelector?.('[data-native-domain-inspector]')?.scrollIntoView?.({block:'nearest'});return true;}
 if(action==='native-domain-clear'){updateNativeDomainInspector(null);graphView?.select(null);return true;}
 if(action==='product-library'){await openProductLibrary(el.dataset.id);return true;}
 if(action==='build'){
  if(state.nativeCreate&&state.draft.sources.some(s=>!s.document_id))throw Error('原生全链路请上传 PDF、DOCX 或 Markdown，等待 Docling 解析完成。');
  state.busy=true;const input=draftPayload(),fingerprint=JSON.stringify({input,mode:state.nativeCreate?'NATIVE_CQ_BUILD_V1':'LEGACY'});if(state.productBuildAttempt?.fingerprint!==fingerprint)state.productBuildAttempt={fingerprint,id:crypto.randomUUID()};
  const initial={request_id:state.productBuildAttempt.id,library_id:null,source_epoch:null,auto_open:true};state.productInitialBuild=initial;state.productCreationPending={name:input.name,request_id:initial.request_id};state.productLibraryId=null;state.productView=null;state.task=null;state.view='knowledge';state.knowledgeMode='processing';clearProductAnswer();
  render();
  const response=await api('/api/product/libraries',{input,request_id:state.productBuildAttempt.id,...(state.nativeCreate?{build_mode:'NATIVE_CQ_BUILD_V1'}:{})});const id=response.library_id??response.library?.id;if(!id)throw Error('导入响应未返回知识库标识，未重复提交');
  initial.library_id=id;
  if(state.productInitialBuild===initial&&state.view==='knowledge'&&state.knowledgeMode==='processing')await openProductLibrary(id,{mode:'processing',initialBuild:initial});
  state.productCreationPending=null;state.boot=await api('/api/bootstrap');await clearWorkspaceDraft();return true;
 }
 if(action==='ask-question'){
  const question=state.askQuestion?.trim(),id=state.productLibraryId,epoch=state.productEpoch,revision=state.askRevision||0;if(!question||!id)throw Error('请先打开知识库并填写问题');
  state.busy=true;state.answerPending=true;state.askProgress='正在检索原文…';state.productSourcePreview=null;state.productEvidence=null;
  const fingerprint=JSON.stringify([id,question,revision,state.productView?.graph?.graph_revision??null]);if(state.productAskAttempt?.fingerprint!==fingerprint)state.productAskAttempt={fingerprint,id:crypto.randomUUID()};
  render();const current=()=>id===state.productLibraryId&&epoch===state.productEpoch&&revision===(state.askRevision||0)&&question===state.askQuestion?.trim();
  const result=await streamAsk('/api/product/libraries/'+encodeURIComponent(id)+'/ask',{question,request_id:state.productAskAttempt.id},(event,data)=>{
   if(!current())return;
   if(event==='progress')state.askProgress=data.message??'正在核对原文…';
   if(event==='sources'){state.productSourcePreview=data.source_evidence??[];state.askProgress='已找到相关原文，正在核对回答…';}
   if(event==='answer_block')state.askProgress='已核对回答片段，正在整理完整依据…';
   if(event!=='result')render();
  });
  if(current()){state.productAnswer=result;state.productAnsweredQuestion=question;state.productSourcePreview=null;await refreshProductView();}return true;
 }
 if(action==='product-use-question'){const q=productUi.questionSuggestions(state.productView)[Number(el.dataset.index)];if(!q)throw Error('这个建议问题已变化，请重新选择');state.askQuestion=q;clearProductAnswer();render();document.querySelector('#ask-question')?.focus?.();return true;}
 if(action==='product-answer-evidence'){state.productEvidence=el.dataset.index;render();return true;}
 if(action==='product-close-evidence'){state.productEvidence=null;render();return true;}
 if(action==='product-graph-select'){updateProductInspector(el.dataset.id,el.dataset.kind);graphView?.select(el.dataset.id,el.dataset.kind);return true;}
 if(action==='product-open-review'){const item=productUi.reviewItems(state.productView).find(i=>i.id===el.dataset.id);if(!item)throw Error('该问题已变化，请刷新整理状态');state.productReviewSelected=item.id;state.productReviewNotice=null;render();return true;}
 if(action==='product-refresh-processing'){await refreshProductView();render();return true;}
 if(action==='product-review-decision'){
  const item=productUi.reviewItems(state.productView).find(i=>i.id===el.dataset.id),actionId=el.dataset.decision;
  if(!item||!['MENTION_SCOPE','SEMANTIC_CANDIDATE'].includes(item.kind)||String(item.item_revision)!==String(el.dataset.revision)||!['OPEN','DEFERRED'].includes(item.status)||(item.actions??[]).every(a=>a.id!==actionId))throw Error('这个知识问题或可用决定已变化，请刷新后重新选择');
  const option=actionId==='SELECT_OCCURRENCE'?(item.options??[]).find(o=>o.id===el.dataset.option):null;if(actionId==='SELECT_OCCURRENCE'&&!option)throw Error('请在当前问题提供的原文选项中选择');
  const reason=state.productReviewReasons?.[item.id+':'+item.item_revision]??'';if(item.kind==='SEMANTIC_CANDIDATE'&&!reason.trim())throw Error('请填写判断理由，再提交这项知识含义决定');
  const data={item_revision:item.item_revision,action:actionId,...(option?{option_id:option.id}:{}),...(reason?{reason}:{})},fingerprint=JSON.stringify([state.productLibraryId,item.id,data]);state.productReviewAttempts??={};state.productReviewAttempts[fingerprint]??=crypto.randomUUID();
  state.busy=true;render();const result=await api('/api/product/libraries/'+encodeURIComponent(state.productLibraryId)+'/reviews/'+encodeURIComponent(item.id)+'/decisions',{request_id:state.productReviewAttempts[fingerprint],...data});
  const status=result.decision?.status??result.status;state.productReviewNotice={item_id:item.id,message:status==='CONFIRMED'?(productUi.partialScopeEnabled(state.productView)?'含义判断已保存；任务还需通过事实与范围核实，之后可先部分就绪。':'含义判断已保存；整份资料通过门槛后才会发布正式图谱。'):status==='APPLIED'?'决定已应用到候选知识；索引是否就绪请查看整理进度。':status==='MATERIALIZED_WITH_ISSUES'?'定位决定已应用，相关候选仍待其它问题处理；图谱尚未因此更新。':status==='APPLICATION_UNKNOWN'?'更新请求的结果尚未确认，保留决定，未自动重发。':status==='STALE'?'资料已变化，这次决定不再用于当前版本。':status==='APPLY_BLOCKED'?'决定已保存，但知识更新受阻；其他可用知识仍保留。':status==='EXCLUDED'?'已保存：不采用此候选，其他可用知识继续处理。':status==='DEFERRED'?'已保存为稍后处理，尚未应用到知识。':'决定已保存，正在更新知识。'};
  await refreshProductView();return true;
 }
 if(action==='product-replace-source'){const source=state.productView?.library?.sources?.find(s=>s.key===el.dataset.key&&s.active);if(!source)throw Error('来源已变化，请刷新');state.productReplacement={key:source.key,title:source.title};state.librarySupplement={title:source.title,content:''};render();return true;}
 if(action==='product-cancel-replace'){state.productReplacement=null;state.librarySupplement=null;render();return true;}
 if(action==='product-save-source'||action==='product-revoke-source'){
  const id=state.productLibraryId;if(!id)throw Error('请先打开知识库');const source=state.librarySupplement??{};
  if(action==='product-save-source'&&(!source.title?.trim()||!source.document_id&&!source.content?.trim()))throw Error('请提供资料标题与正文，或选择已解析的原文件');
  if(action==='product-revoke-source'){const row=state.productView?.library?.sources?.find(s=>s.key===el.dataset.key&&s.active);if(!row)throw Error('来源已变化，请刷新');if(!window.confirm('确认将「'+row.title+'」移出当前知识库？原件与历史保留，旧回答和旧图将停止展示。'))return true;}
  state.busy=true;clearProductAnswer();state.productEpoch=(state.productEpoch||0)+1;state.productView=null;render();
  const submitted=productSourcePayload(source);
  await api('/api/product/libraries/'+encodeURIComponent(id)+'/sources'+(action==='product-revoke-source'?'/'+encodeURIComponent(el.dataset.key)+'/revoke':''),action==='product-revoke-source'?{}:{source:submitted,...(state.productReplacement?{replace_source_key:state.productReplacement.key}:{})});
  state.librarySupplement=null;state.productReplacement=null;await refreshProductView();state.boot=await api('/api/bootstrap');return true;
 }
 if(action==='product-save-models'){
  const configs={};for(const [role,d]of Object.entries(productUi.modelDefaults)){const field=name=>document.querySelector('#product-model-'+role+'-'+name),enabled=field('enabled').checked,config={enabled,base_url:enabled?field('url').value.trim():'',model:enabled?field('name').value.trim():''};if(enabled){const key=field('key').value;if(!key.trim())throw Error('请重新填写'+d.label+'的 Key；留空不会默认为保存成功');const existing=state.productModels?.[role],endpointMode=role!=='generation'?'full':existing?.base_url===config.base_url?existing.endpoint_mode??'base':/\/chat\/completions\/?$/.test(config.base_url)?'full':'base';Object.assign(config,{api_key:key,protocol:d.protocol,endpoint_mode:endpointMode,timeout_ms:300000,...(role==='embedding'?{dimensions:Number(document.querySelector('#product-model-embedding-dimensions').value)}:{})});}configs[role]=config;}
  state.busy=true;try{await api('/api/product/models',configs);}finally{for(const role of Object.keys(configs)){const key=document.querySelector('#product-model-'+role+'-key');if(key)key.value='';}}
  state.productModels=await api('/api/product/models');state.boot=await api('/api/bootstrap');toast('模型配置已保存；保存本身没有调用模型');return true;
 }
 return false;
}
async function streamAsk(path,data,onEvent){
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','Accept':'text/event-stream','X-CQForge-Token':state.boot?.token??''},body:JSON.stringify(data)});
  if(!response.headers?.get?.('content-type')?.includes('text/event-stream')){const body=await response.json();if(!response.ok)throw Error(body.error||'请求失败');return body;}
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',result;
  const consume=()=>{let boundary;while((boundary=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);let event='message';const values=[];
    for(const line of frame.split('\n')){if(line.startsWith('event:'))event=line.slice(6).trim();if(line.startsWith('data:'))values.push(line.slice(5).trimStart());}
    if(!values.length)continue;const value=JSON.parse(values.join('\n'));onEvent(event,value);
    if(event==='error')throw Error(value.error||'回答暂未完成');if(event==='result')result=value;
  }};
  try{for(;;){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});if(buffer.length>16000000)throw Error('回答数据异常');consume();}buffer+=decoder.decode();consume();}
  finally{reader.releaseLock();}
  if(!result)throw Error('回答连接已中断，请重试原问题以查看结果；系统不会自动重复发送。');return result;
}
function head(title, subtitle, actions = '') { return `<div class="page-head"><div><h1>${title}</h1><p>${subtitle}</p></div><div class="actions">${actions}</div></div>`; }
function blank(title, description) { return `<div class="panel task-empty"><h2>${title}</h2><p>${description}</p><br>${button('新建知识模型', 'new', 'primary')}</div>`; }
function taskStatus(task){return state.task?.id===task.id&&state.taskReview?.continued_to?'已继续处理':task.presentation?.category==='HUMAN_REVIEW'||task.status==='WAITING_REVIEW'||(state.task?.id===task.id&&state.taskReview?.review)?'等待人工核对':task.presentation?.category==='PAUSED_BUDGET'||task.error_details?.code==='BUDGET_EXHAUSTED'?'已暂停 · 调用额度用完':statusLabel[task.status]||task.status;}
function taskRows() { const tasks = state.boot?.tasks ?? []; if (!tasks.length) return '<div class="task-empty">还没有构建任务。先定义问题，再让资料成为可追溯的知识。</div>';
  return `<div class="task-list">${tasks.map(t => `<button class="task-row" data-action="task" data-id="${escape(t.id)}"><div><strong>${escape(t.name)}</strong><p>${t.source_count} 份资料 · ${t.cq_count} 条 CQ · ${t.claim_count} 条声明</p></div><div>${badge(taskStatus(t), t.status === 'READY' ? 'green' : 'yellow')}</div><span class="muted small last-cell">查看 →</span></button>`).join('')}</div>`; }
function overview() {
  if(productEnabled())return productUi.overview(state.boot?.knowledge_bases??[]);
  const tasks=state.boot?.tasks||[],drafts=tasks.filter(t=>t.status==='DRAFT'),completed=tasks.filter(t=>t.status!=='DRAFT');
  const bases=state.boot?.knowledge_bases;
  return head('工作空间','把常用问题整理成可持续查询的知识。',button('回收站'+(state.boot?.trash_count?' · '+state.boot.trash_count:''),'show-trash','tiny')+button('新建知识库','new','primary'))
    +(hasDraftContent()?`<section class="panel draft-continuation"><div class="panel-head"><div><span class="eyebrow">未完成的草稿</span><h2>${escape(state.draft.name||'未命名知识库')}</h2><p class="help">${state.draft.sources.length} 份资料</p></div>${button('继续整理','continue-workspace-draft')}</div></section>`:'')
    +(!bases&&drafts.length?`<section class="workspace-section"><div class="panel-head"><h2>可继续的修订</h2></div><div class="kb-grid">${drafts.map(knowledgeCard).join('')}</div></section>`:'')
    +`<section class="workspace-section"><div class="panel-head"><h2>知识库</h2><span class="muted small">${bases?bases.length+' 个知识库':completed.length+' 个知识库'}</span></div>${(bases||completed).length?`<div class="kb-grid">${bases?bases.map(baseCard).join(''):completed.map(knowledgeCard).join('')}</div>`:`<div class="panel empty-state"><div class="empty-symbol">◇</div><h2>从一份资料、几个问题开始</h2><p>上传你熟悉的资料，告诉我们你经常需要回答什么。<br>每个答案都保留依据，缺证与冲突不会被掩盖。</p><div class="actions">${button('上传资料，创建知识库','new','primary')}${button('体验合成示例','sample')}</div></div>`}</section>`;
}
function baseCard(base){return `<article class="kb-card"><button class="kb-card-open" data-action="task" data-id="${escape(base.open_task_id)}"><div class="kb-card-top"><span class="kb-icon">◇</span>${badge(statusLabel[base.status]||base.status,base.current_task_id?'green':'')}</div><h3>${escape(base.name)}</h3><p>${base.cq_count} 个起始问题</p>${base.current_task_id&&base.latest_task_id!==base.current_task_id?`<p class="help">最近整理：${escape(statusLabel[base.latest_status]||base.latest_status)} · 当前版本仍可查询</p>`:''}<div class="kb-card-footer"><span>${base.source_count} 份资料</span><span>打开 →</span></div></button><details class="kb-menu"><summary aria-label="管理 ${escape(base.name)}">⋯</summary><div>${button('重命名','manage-rename','tiny',`data-base="${escape(base.id)}" aria-label="重命名"`)}${button('移入回收站','manage-trash','tiny',`data-base="${escape(base.id)}" aria-label="移入回收站"`)}</div></details></article>`;}
function trashPage(){const items=state.trashItems||[];return head('回收站','恢复后保留知识与资料；学习任务和应用接入不会自动重新开启。',button('返回工作空间','nav-overview','tiny'))+`<section class="panel">${items.length?items.map(b=>`<article class="trash-row"><div><h3>${escape(b.name)}</h3><p class="help">${b.version_count} 个版本 · ${b.source_count} 份资料${b.lifecycle_status==='PURGING'?' · 清理未完成，可重试':''}</p></div><div class="actions">${b.lifecycle_status==='TRASHED'?button('恢复','restore-library','',`data-base="${escape(b.id)}"`):''}${button(b.lifecycle_status==='PURGING'?'继续彻底删除':'彻底删除','manage-purge','danger',`data-base="${escape(b.id)}"`)}</div></article>`).join(''):'<div class="empty-state"><h2>回收站是空的</h2><p>移入回收站的知识库可以在这里恢复。</p></div>'}</section>`;}
function libraryManagementDialog(){const m=state.libraryManage;if(!m)return '';const rename=m.action==='rename',purge=m.action==='purge',title=rename?'重命名知识库':purge?'彻底删除知识库':'移入回收站';return `<div class="library-modal-layer"><button class="library-modal-backdrop" data-action="close-library-manage" aria-label="关闭知识库管理"></button><section class="library-modal" role="dialog" aria-modal="true" aria-labelledby="library-modal-title"><h2 id="library-modal-title">${title}</h2><p>${rename?'给知识库一个容易识别的名字。':purge?'将删除此知识库的全部版本、知识、学习记录与不再共享的资料。此操作无法恢复，已有备份不会随之删除。':'将停止学习并停用应用接入。资料和知识会保留，可以稍后恢复。'}</p>${rename||purge?`<div class="field"><label for="library-manage-name">${purge?'输入完整名称确认：'+escape(m.name):'知识库名称'}</label><input id="library-manage-name" maxlength="100" value="${rename?escape(m.name):''}" autocomplete="off"></div>`:`<strong>${escape(m.name)}</strong>`}<div class="actions">${button('取消','close-library-manage','','id="library-manage-cancel"')}${button(rename?'保存名称':purge?'确认彻底删除':'移入回收站','confirm-library-manage',purge?'danger':'primary',state.busy||purge?'disabled':'')}</div></section></div>`;}

function libraryVersions(){const base=state.boot?.knowledge_bases?.find(b=>b.task_ids?.includes(state.task?.id));if(!base)return '';return `<details class="panel"><summary>版本记录 · ${base.version_count} 个版本</summary>${(state.boot.tasks||[]).filter(t=>base.task_ids.includes(t.id)).map(t=>`<div class="row"><span>${escape(taskStatus(t))}${t.id===base.current_task_id?' · 当前可用':''}</span>${button(t.id===state.task.id?'正在查看':'打开','task','tiny',`data-id="${escape(t.id)}" data-history="true"`)}</div>`).join('')}</details>`;}
function knowledgeCard(task){return `<button class="kb-card" data-action="task" data-id="${escape(task.id)}"><div class="kb-card-top"><span class="kb-icon">◇</span>${badge(taskStatus(task),task.status==='READY'?'green':'')}</div><h3>${escape(task.name)}</h3><p>${task.source_count} 份资料 · ${task.cq_count} 个问题</p><div class="kb-card-footer"><span>${task.source_count} 份资料</span><span>打开 →</span></div></button>`;}
function inputPage() {
  const d=state.draft;
  const sources=d.sources.map((s,i)=>`<div class="source-card compact-source"><div class="row"><input aria-label="资料标题" data-source-title="${i}" value="${escape(s.title)}" maxlength="180">${button('移除','remove-source','tiny',`data-index="${i}"`)}</div><details ${s.document_id?'':'open'}><summary>${s.document_id?'查看内容':'编辑内容'}</summary><textarea aria-label="资料正文" data-source-content="${i}" rows="5" ${s.document_id?'readonly':''}>${escape(s.content)}</textarea>${s.document_id?`<a class="small" href="/api/documents/${escape(s.document_id)}/original">下载原文件</a>`:''}</details></div>`).join('');
  return head(productEnabled()?'上传资料':'资料与问题',productEnabled()?'资料为必需输入；系统会发现可整理的问题范围。用途与示例问题可以留空。':'',`<details class="draft-menu"><summary>更多</summary>${button('保存草稿','save-workspace-draft','tiny')}${button('清空草稿','discard-workspace-draft','tiny')}</details>`)
    +`${state.draftSaveFailure?`<div class="notice warning" role="alert">草稿暂未保存。${button('重试保存','save-workspace-draft','tiny')}</div>`:''}${state.draftRestoreNotice?`<div class="notice warning">${escape(state.draftRestoreNotice)}</div>`:''}${state.discardDraftPending?`<div class="notice warning">清空这份草稿？${button('清空草稿','confirm-discard-draft','tiny')}${button('取消','cancel-discard-draft','tiny')}</div>`:''}`
    +(productEnabled()?`<section class="panel"><div class="row"><div><strong>${state.nativeCreate?'原生全链路构建':'现有整理方式'}</strong><p class="help">${state.nativeCreate?'上传 PDF／DOCX／Markdown 后先保存解析资料，再明确启动 CQ、问题族及知识构建。':'当前方式保持已有整理流程。'}</p></div>${button(state.nativeCreate?'使用现有方式':'选择原生全链路','native-toggle-mode','tiny')}</div></section>`:'')
    +(!(productEnabled()?state.productModels?.generation?.configured:state.boot?.configured)?`<div class="notice warning">${productEnabled()?(state.nativeCreate?'可先保存解析资料；配置模型后手动开始本次构建。':'可先保存资料，连接生成与向量模型后会自动整理。'):'连接模型后即可开始。'}${button('连接模型','nav-model','tiny')}</div>`:'')
    +`<div class="input-grid simple-input"><section class="panel"><div class="panel-head"><h2>资料</h2>${button('粘贴文本','add-source','tiny')}</div><div class="dropzone" id="dropzone" role="button" tabindex="0" data-action="upload"><div class="symbol">↑</div><h3>${state.parsing?'正在读取资料…':'选择或拖入文件'}</h3><p class="help">${state.nativeCreate?'PDF、Word、Markdown（Docling 解析）':'PDF、Word、TXT、Markdown'}</p>${state.parsing?'<div role="status">正在处理…</div>':''}</div><input type="file" id="file-picker" accept="${state.nativeCreate?'.pdf,.docx,.md':'.pdf,.docx,.txt,.md'}" multiple>${sources}</section>
    <section class="panel"><h2>${productEnabled()?'整理方向（可选）':'起始问题'}</h2><div class="field"><label for="task-name">知识库名称</label><input id="task-name" data-field="name" value="${escape(d.name)}" maxlength="100" placeholder="给这份知识库起个名字"></div><div class="field"><label for="cq-input">${productEnabled()?'示例问题（可选）':'你想了解什么？'}</label><textarea id="cq-input" data-field="cqs" rows="5" placeholder="${productEnabled()?'可以留空，系统会根据资料发现问题；也可每行填写一个示例':'每行一个问题'}">${escape(d.cqs)}</textarea></div><details class="optional-definition"><summary>补充说明（可选）</summary><div class="field"><label for="definitions">${productEnabled()?'用途、关注主题或业务定义':'业务定义或回答范围'}</label><textarea id="definitions" data-field="definitions" rows="3">${escape(d.definitions)}</textarea></div>${d.parent_id?`<div class="field"><label for="as-of">查询时点</label><input type="date" id="as-of" data-field="as_of" value="${escape(d.as_of)}"></div>`:''}</details>${proposalPanel()}<div class="build-action">${/^http:\/\//.test(state.boot?.base_url||'')?'<p class="notice warning">当前模型连接未加密，请在设置中更换为 HTTPS。</p>':''}${button(state.busy?'正在提交…':state.nativeCreate?'保存解析资料':'开始整理','build','primary',state.busy||active()?'disabled':'')}</div></section></div>`;
}

function proposalPanel() {
  if(productEnabled()||state.boot?.product_flow==='knowledge_m1'&&!state.draft.parent_id)return '';
  if(state.draft.parent_id)return '<div class="panel"><h2>CQ 扩展</h2><p class="help">修订版本暂不接入扩展草稿；可直接修改问题并重新验证。</p></div>';
  const p=state.proposal;
  return `<div class="panel"><h2>从少量问题扩展</h2><p class="help">填写1–5条起始问题，结合资料建议相关问题；候选支持范围不是答案证明。生成建议前会预览发送范围与调用上限，确认后才发送。</p>${button('建议更多相关问题','propose-cqs','',state.busy||!state.boot?.configured?'disabled':'')}${p?button('放弃建议，使用当前问题','discard-proposal','tiny'):''}<div id="proposal-validity">${p?.status==='CONFIRMED'?'<div class="notice">范围已确认；构建将使用此快照。编辑资料、问题或定义会使确认失效。下一步仍需确认发送范围与调用上限。</div>':''}</div>${p?.status==='PROPOSED'?`<h3>起始问题（保留）</h3>${p.seeds.map(q=>`<p>${escape(q.question)}</p>`).join('')}<h3>选择需要扩展的问题</h3>${p.candidates.map(c=>`<label class="consent"><input type="checkbox" data-proposal-choice="${escape(c.id)}" ${(state.proposalSelected||[]).includes(c.id)?'checked':''}><span>${escape(c.question)} ${badge(({SUPPORTED:'资料中有相关线索',PARTIAL:'部分资料相关',UNKNOWN:'支持范围待核对'})[c.support]||'待核对')}<br><small>${escape(c.reason)}</small></span></label>`).join('')||'<p class="help">没有额外候选，可确认保留起始问题。</p>'}${p.clarifications.map(c=>`<div class="field"><label>${escape(c.question)}${c.required?'（必答）':'（可选）'}</label><textarea data-clarification="${escape(c.id)}" maxlength="1000">${escape(state.proposalAnswers?.[c.id]||'')}</textarea></div>`).join('')}${button('确认范围与定义','confirm-proposal','primary',state.busy?'disabled':'')}`:''}</div>`;
}
function invalidateProposal() {
  if(!state.proposal)return;
  state.proposal=null;state.proposalSelected=[];state.proposalAnswers={};state.proposalFingerprint=null;
  const message=document.querySelector('#proposal-validity');if(message)message.textContent='输入已变化，CQ建议确认已失效；需要时重新生成。';
}
function proposalFingerprint(){return JSON.stringify(draftPayload());}
function budgetFingerprint(action) {
  return JSON.stringify({action,task_id:state.task?.id,input:['build','propose-cqs'].includes(action)?draftPayload():null,
    question:action==='ask-question'?state.askQuestion:null,proposal:state.proposal?.id,proposal_status:state.proposal?.status,
    ...(action==='continue-review'?{snapshot_hash:state.taskReview?.review?.snapshot_hash,decision_set_hash:state.taskReview?.decision_set_hash}:{})});
}
async function prepareBudget(action) {
  if(action==='build'&&state.proposal&&state.proposal.status!=='CONFIRMED')throw Error('请先确认或放弃问题建议。');
  if(action==='ask-question'&&!state.askQuestion?.trim())throw Error('请先填写问题。');
  if(action==='continue-review'&&state.taskReview?.continued_to)throw Error('此快照已继续处理，请打开后续版本。');
  if(action==='continue-review'&&(!state.taskReview?.can_continue||state.taskReview.pending_count!==0||hasUnsavedReviewEdits()))throw Error('请先保存每一项决定；尚未保存的编辑不能直接继续。');
  const from=state.view==='budget'?(state.pendingBudget?.from||'input'):state.view, fingerprint=budgetFingerprint(action);
  const confirmUnknown=['resume-task','retry-task'].includes(action)&&state.taskDiagnostics?.requires_unknown_resend_confirmation===true;
  if(confirmUnknown&&!document.querySelector('#unknown-resend-consent')?.checked)throw Error('请先明确确认上次结果未知阶段的再次发送风险。');
  let taskId=['ask-question','retry-task','resume-task','continue-review'].includes(action)?state.task?.id:null;
  if(action==='build'&&state.draft.parent_id){const draft=await saveRevision();taskId=draft.id;}
  const operation={build:'BUILD','propose-cqs':'EXPAND','ask-question':'ASK','retry-task':'RETRY','resume-task':'RESUME','continue-review':'REVIEW_CONTINUE'}[action];
  const request=taskId?{task_id:taskId,operation,...(action==='ask-question'?{question:state.askQuestion}:{})}
    :{input:draftPayload(),operation};
  const preview=await api('/api/budgets/preview',request);
  if(action==='continue-review'&&((preview.manifest?.snapshot_hash&&preview.manifest.snapshot_hash!==state.taskReview.review.snapshot_hash)||(preview.manifest?.decision_set_hash&&preview.manifest.decision_set_hash!==state.taskReview.decision_set_hash))){await loadTaskDetails();throw Error('复核候选或决定已变化，请重新核对后继续。');}
  if(fingerprint!==budgetFingerprint(action))throw Error('准备期间输入发生变化，请重新预览。');
  state.pendingBudget={action,from,fingerprint,request,taskId,preview,confirmUnknown};state.view='budget';render();
}
function budgetPage() {
  const pending=state.pendingBudget;if(!pending)return blank('尚无待授权操作','从资料或知识库发起操作后，再确认发送范围。');
  const p=pending.preview,m={...(p.manifest||p)},sources=m.sources||m.source_manifest||[],model=m.model||{};
  m.base_url=model.base_url||m.base_url;m.thinking_mode=model.thinking_mode||m.thinking_mode;m.max_tokens=model.max_tokens||m.max_tokens;
  return head('确认发送与调用上限','现在只做本地预览，尚未发送模型。确认仅适用于下述资料与模型。')
    +`<section class="panel"><h2>本次发送范围</h2><p>操作：${escape(m.operation)} · 模型：${escape(model.name||state.boot.model)}</p>
    <p class="help">接口 ${escape(m.base_url||state.boot.base_url)} · thinking ${escape(m.thinking_mode||'服务商默认')} · 最大输出 ${escape(m.max_tokens)} tokens</p>
    ${pending.action==='ask-question'?`<blockquote>${escape(state.askQuestion)}</blockquote>`:''}
    <div class="table-wrap"><table><thead><tr><th>资料</th><th>字符数</th><th>SHA-256</th></tr></thead><tbody>${sources.map(s=>`<tr><td>${escape(s.title||s.id)}</td><td>${escape(s.characters??'未知')}</td><td><code>${escape(s.sha256||'未提供')}</code></td></tr>`).join('')}</tbody></table></div>
    ${m.max_calls!==null&&m.max_calls!==undefined&&m.normal_calls>m.max_calls?`<div class="notice warning">本次完整处理预计 ${escape(m.normal_calls)} 次调用，超过单批 ${escape(m.max_calls)} 次上限。额度用完会保存有效阶段并暂停；需重新确认新批次后继续，不会自动追加。</div>`:''}<h3>正常流程的调用清单</h3><ul>${(m.planned_calls||[]).map(c=>`<li>${escape(c.phase)}：${escape(c.calls)} 次</li>`).join('')}</ul><p class="help">${escape(m.notice||'修复也占用同一上限，不无限重试。调用上限不是金额保证。')}</p>
    <details><summary>完整发送清单（模型、范围及限制）</summary><pre>${escape(JSON.stringify(m,null,2))}</pre></details>
    <div class="field"><label for="budget-max-calls">本次调用上限（可选）</label><input id="budget-max-calls" type="number" min="1" step="1" value="" placeholder="不限次数"><span class="help">默认不限次数，处理完本次操作即停止；仍会产生模型费用，可随时停止任务。填写正整数则在达到该值时保存进度并暂停。</span></div>
    <label class="consent"><input id="budget-auto-repair" type="checkbox"><span>允许系统在本次上限内修复技术/结构问题；不替我裁决事实冲突，不超限继续，不更改资料。</span></label>
    <label class="consent"><input id="budget-consent" type="checkbox"><span>我已核对清单，允许向以上模型发送本次资料与问题，并按上述上限调用。</span></label>
    ${button('确认并开始','confirm-budget','primary',state.busy?'disabled':'')}${button('返回，不发送','cancel-budget')}</section>`;
}
function userProgress(task) {
  const stage=task.failed_stage||task.stage||'',ready=task.status==='READY', index=ready?3:/extraction|claims|repair/.test(stage)?2:/schema_review|independent_reading/.test(stage)?1:0;
  return `<section class="panel"><div class="panel-head"><h2>${escape(task.input.name)}</h2>${badge(taskStatus(task),ready?'green':'yellow')}</div><div class="progress user-progress">${['理解资料与问题','整理知识与证据','检查答案与待确认'].map((s,i)=>`<div class="step ${ready||i<index?'done':i===index?'live':''}"><span>0${i+1}</span>${s}</div>`).join('')}</div>${task.unit_progress&&task.unit_progress.stage===task.stage?`<p class="help" role="status">已处理 ${task.unit_progress.completed} / ${task.unit_progress.total} 段资料</p>`:''}${['RUNNING','QUEUED'].includes(task.status)?button('停止任务','cancel','tiny'):''}</section>`;
}
function knowledgePage() {
  if(productEnabled())return nativeEnabled()&&state.knowledgeMode!=='sources'?nativeBuildPage():state.productLibraryId||state.productCreationPending?productUi.libraryPage(state):productUi.overview(state.boot?.knowledge_bases??[]);
  if(!state.task)return head('知识库','选择已有知识库，或上传资料开始。')+`<section class="panel">${taskRows()}</section>`;
  const t=state.task,ready=t.status==='READY'&&t.result?.status==='READY',mode=state.knowledgeMode||'answers';
  const tabs=componentProgress()+sourceUpdateProgress();
  if(mode==='ontology')return tabs+ontologyOverview();
  if(mode==='sources')return tabs+librarySources();
  if(ready)return tabs+(mode==='graph'?graphPage():queriesPage());
  return head('知识库','')+userProgress(t)+tabs+`<section class="panel"><h2>整理中的成果草稿</h2><p>${schema()?.entities?.length||0} 个实体 · ${claimList().length} 条证据化声明 · ${t.input.cqs.length} 个问题</p><div class="query-values">${(schema()?.entities||[]).slice(0,12).map(e=>badge(e.name)).join('')}</div>${button(t.presentation?.category==='HUMAN_REVIEW'?'查看待确认':'查看整理进度','nav-review','primary')}</section>`+(mode==='graph'&&schema()?graphPage():'');
}
function ontologyOverview(){
  const s=schema();if(!s)return '<section class="panel"><h2>正在整理知识结构</h2><p>生成后将在这里展示概念、属性与关系。</p></section>';
  const types={NUMBER:'数值',STRING:'文本',ENTITY:'实体关系'};
  const rows=predicates=>predicates.map(p=>`<tr><td>${escape(p.label)}</td><td>${types[p.value_type]||'待确认'}</td><td>${escape(p.unit||'未指定')}</td><td>${p.cardinality==='ONE'?'同一条件下单值':'可保留多值'}</td></tr>`).join('');
  const table=predicates=>predicates.length?`<div class="table-wrap"><table><thead><tr><th>名称</th><th>值的形式</th><th>单位</th><th>约束</th></tr></thead><tbody>${rows(predicates)}</tbody></table></div>`:'<p class="help">当前没有这类定义。</p>';
  return head('本体 · 知识结构',state.task.result.status==='READY'?'当前版本的概念、属性和关系。':'正在核对的候选结构，通过校验后才可使用。')+
    `${state.task.input.definitions?`<section class="panel"><h2>业务定义</h2><p>${escape(state.task.input.definitions)}</p></section>`:''}<section class="panel"><h2>概念</h2><div class="kb-grid">${s.entity_types.map(type=>`<article class="source-card"><h3>${escape(type.label)}</h3><p>${s.entities.filter(e=>e.type===type.id).length} 个已整理实体</p><p class="help">${s.entities.filter(e=>e.type===type.id).map(e=>escape(e.name)).join('、')||'暂无实例'}</p></article>`).join('')}</div></section><section class="panel"><h2>属性</h2>${table(s.predicates.filter(p=>p.value_type!=='ENTITY'))}</section><section class="panel"><h2>关系</h2>${table(s.predicates.filter(p=>p.value_type==='ENTITY'))}</section>`;
}
function librarySources(){const base=state.boot?.knowledge_bases?.find(b=>b.task_ids.includes(state.task.id));if(!base)return '';
  const draft=state.librarySupplement||{};
  return head('资料','')+`<details class="panel add-library-source" ${state.sourceReplacement||draft.content||draft.document_id?'open':''}><summary>${state.sourceReplacement?'替换资料':'添加资料'}</summary>${button(state.parsing?'正在解析…':'选择文件','pick-library-file','tiny',state.busy?'disabled':'')}<input type="file" id="library-file-picker" accept=".pdf,.docx,.txt,.md" hidden><div class="field"><label for="supplement-title">资料标题</label><input id="supplement-title" data-library-field="title" value="${escape(draft.title||'')}"></div><div class="field"><label for="supplement-content">正文或解析预览</label><textarea id="supplement-content" rows="5" data-library-field="content" ${draft.document_id?'readonly':''}>${escape(draft.content||'')}</textarea></div>${state.sourceReplacement?'<p class="help">确认后旧资料退出当前答案依据，原件及历史保留。</p>':''}${button(state.sourceReplacement?'确认替换并整理':'添加并整理','add-library-source','primary',state.busy?'disabled':'')}${state.sourceReplacement?button('取消替换','cancel-source-replacement','tiny'):''}</details><section class="panel">${(base.sources||[]).map(s=>`<div class="source-card"><h3>${escape(s.title)}</h3>${badge(s.active?'正在使用':'已移出')}${s.active?button('替换资料','replace-library-source','tiny',`data-base="${escape(base.id)}" data-key="${escape(s.key)}"`):''}${s.active?button('移出当前知识库','revoke-source','tiny',`data-base="${escape(base.id)}" data-key="${escape(s.key)}"`):''}${state.revokePending?.key===s.key?`<div class="notice">移出后相关答案会立即重新判定。${button('确认移出','confirm-revoke-source','tiny')}${button('保留资料','cancel-revoke-source','tiny')}</div>`:''}</div>`).join('')}</section>`;
}
function componentProgress(){
  const pending=state.task?.result?.pending_components;if(!pending?.origin_task_ids?.length)return '';
  const base=state.boot?.knowledge_bases?.find(b=>b.task_ids.includes(state.task.id)),current=state.boot?.tasks?.find(t=>t.id===base?.current_task_id),newerIndependent=current?.id!==state.task.id&&current?.revision?.kind==='COMPONENT_PUBLICATION';
  return `<section class="panel"><h2>${state.task.result.component_publication?'独立更新已可用':'部分知识需要核对'}</h2><p>可独立使用的知识继续服务；${escape(pending.predicate_ids.length)} 类属性或关系暂不提供确定结论。</p>${newerIndependent?button('查看已发布的独立更新','task','tiny',`data-id="${escape(current.id)}"`):''}${pending.origin_task_ids.map(id=>button('处理剩余待确认事项','open-component-review','tiny',`data-id="${escape(id)}"`)).join('')}</section>`;
}
function sourceUpdateProgress(){
  const base=state.boot?.knowledge_bases?.find(b=>b.task_ids.includes(state.task?.id)),update=base?.source_update;
  if(!update)return '';
  const labels={QUEUED:'等待整理更新',RUNNING:'正在整理资料更新',BLOCKED:'资料更新需要处理',STOPPED:'本次资料更新已停止',SUPERSEDED:'资料已再次变化',COMPLETED:'资料更新已完成'};
  return `<section class="panel" role="status"><h2>${labels[update.status]||'资料更新'}</h2><p>已检查 ${escape(update.completed)} / ${escape(update.total)} 个相关问题${update.deferred?' · 其余问题等待后续整理':''}</p>${update.task_id?button('查看处理详情','task','tiny',`data-id="${escape(update.task_id)}"`):''}${['RUNNING','QUEUED','BLOCKED'].includes(update.status)?button('停止本次更新','stop-source-update','tiny',`data-base="${escape(base.id)}" data-update="${escape(update.id)}"`):''}</section>`;
}
function learningProgress(){const p=state.pendingLearning;if(!p)return '';const task=state.boot?.tasks?.find(t=>t.id===p.task_id),running=['RUNNING','QUEUED'].includes(task?.status);return `<section class="learning-status" role="status"><span>${running?'正在补充相关知识…':task?.status==='READY'?'正在更新回答…':taskStatus(task||{status:'QUEUED'})}</span><div class="actions">${task&&!running?button('查看进度','task','tiny',`data-id="${escape(task.id)}"`):''}${running?button('停止本次整理','stop-learning','tiny'):''}</div></section>`;}

function diagnosticPanel(t) {
  const d=t.diagnostics;
  if(!d)return '';
  if(d.model_error)return `<section class="panel"><h2>模型调用诊断</h2><p>${escape(t.error)}</p><pre>${escape(JSON.stringify(d.model_error,null,2))}</pre><p class="help">${escape(d.notice)}</p>${button('导出任务与诊断','export')}</section>`;
  return `<section class="panel"><div class="panel-head"><h2>失败诊断</h2>${badge('本地离线复验')}</div><p class="small muted">失败阶段：${escape(d.failed_stage||t.failed_stage||'未知')} · 已完成：${escape(d.completed_stages.join(' → '))||'无'}</p>${d.submitted!==undefined?`<p class="small">原响应 ${d.submitted} 条声明 · 当前结构与证据定位校验通过 ${d.valid} 条 · ${d.issues.length} 条需处理</p>`:''}${d.normalization?.length?`<div class="notice warning">发现 ${d.normalization.filter(n=>n.field==='quote').length} 处可审计的中文排版空白差异。仅恢复原文定位，未改动事实，也未执行后续语义复核。</div>${d.normalization.map(n=>`<details><summary>第 ${n.index+1} 条 · ${escape(n.rule)}</summary><p class="help">模型原引文</p><pre>${escape(n.before)}</pre><p class="help">绑定的原文</p><pre>${escape(n.after)}</pre><p class="help">范围 ${n.start}–${n.end} · ${escape(n.source_id)}</p></details>`).join('')}`:''}${d.issues?.map(i=>`<div class="issue-card"><strong>第 ${i.index+1} 条 · ${escape(i.code)}</strong><p>${escape(i.explanation)}</p><pre>${escape(i.model_quote)}</pre><p class="help">${escape(i.source_id)} · ${escape(i.subject_id)} / ${escape(i.predicate_id)}</p></div>`).join('')||''}<p class="help">${escape(d.notice||'旧记录不覆盖。此诊断不调用模型、不产生新计费。')}</p><br>${button('导出任务与诊断','export')}${button('作为新版本修改','edit')}</section>`;
}
function runPage() { const t=state.task; if(!t)return blank('尚未选择任务','从工作空间打开已有任务，或新建一次构建。'); const stages=['schema','independent_reading','schema_review','extraction','claims_review']; const latest=stages.indexOf(t.failed_stage||t.diagnostics?.failed_stage||t.stage), completed=t.status==='READY';
  return head(escape(t.input.name),'实时记录构建过程与问题，不以“模型返回”冒充已完成。',`${button('作为新版本修改','edit')}${['RUNNING','QUEUED'].includes(t.status)?button('停止任务','cancel'):''}`)+diagnosticPanel(t)
    + `<div class="panel"><div class="run-status">${['RUNNING','QUEUED'].includes(t.status)?'<span class="pulse"></span>':''}<h2>${escape(t.stage_label)}</h2>${badge('SHADOW','yellow')}</div><div class="progress">${stages.map((s,i)=>`<div class="step ${completed||i<latest?'done':i===latest?'live':''}"><span>0${i+1}</span>${['生成本体','独立阅读','本体评审','抽取声明','声明复核'][i]}</div>`).join('')}</div>${t.error?`<div class="error-text">${escape(t.error)}</div>`:''}${completed?`<div class="notice">已完成 ${t.result.schema.entities.length} 个实体、${t.result.claims.length} 条证据化声明。评审通过只表示候选可查询，不是独立事实认证。</div><br><div class="actions">${button('探索图谱 →','nav-graph','primary')}${button('查看 CQ 查询','nav-queries')}</div>`:''}${t.status==='REVIEW_REQUIRED'?`<div class="notice warning">门禁动作：${escape(t.result.gate.action)}。请查看待处理问题，修改输入或定义后创建新任务；未开放自动裁决。</div><br>${button('查看待处理问题','nav-review','primary')}`:''}</div>
    <div class="panel"><div class="panel-head"><h2>运行记录</h2><span class="small muted">${escape(t.model)}</span></div>${t.events.map(e=>`<div class="event-row"><span>${escape(e.stage)}${e.calls?' · 已完成 '+e.calls+' 次模型响应':''}</span><span class="muted small">${new Date(e.at).toLocaleTimeString('zh-CN')}</span></div>`).join('')}<div class="help">停止请求会在当前模型调用结束后生效；重启服务后未完成任务标记为中断。</div></div>`; }
function schemaPage() { const s=schema(); if(!s)return blank('还没有本体草案','构建任务生成本体后，可在这里检查概念与查询计划。');return head('本体契约','由 Builder 根据本次 CQ 与资料生成，评审通过不代表事实已独立认证。',button('导出任务 JSON','export'))
  + `<div class="panel"><div class="panel-head"><h2>实体与概念</h2>${badge(s.entities.length+' 个实体')}</div><div class="table-wrap"><table><thead><tr><th>实体名称</th><th>类型</th><th>稳定标识</th></tr></thead><tbody>${s.entities.map(e=>`<tr><td>${escape(e.name)}</td><td>${escape(typeName(e.type))}</td><td><code>${escape(e.id)}</code></td></tr>`).join('')}</tbody></table></div></div>
  <div class="panel"><h2>属性与关系</h2><div class="table-wrap"><table><thead><tr><th>名称</th><th>值类型</th><th>单位</th><th>标识</th></tr></thead><tbody>${s.predicates.map(p=>`<tr><td>${escape(p.label)}</td><td>${escape(p.value_type)}</td><td>${escape(p.unit??'未指定')}</td><td><code>${escape(p.id)}</code></td></tr>`).join('')}</tbody></table></div></div>
  <div class="panel"><h2>CQ 查询计划</h2><div class="table-wrap"><table><thead><tr><th>问题</th><th>模板</th><th>说明</th></tr></thead><tbody>${s.cq_plans.map(p=>`<tr><td>${escape(state.task.input.cqs.find(c=>c.id===p.cq_id)?.question)}</td><td><code>${escape(p.template)}</code></td><td>${escape(p.reason||'按有限参数返回证据声明')}</td></tr>`).join('')}</tbody></table></div></div>`; }
function inspector() {
  const c=claimList().find(c=>c.id===state.selected);
  const location=c?.document_id?`<div class="panel"><h3>原文件定位 · Docling</h3><a href="/api/documents/${escape(c.document_id)}/original">下载原件核对</a><p class="help">以下位置由解析器提供，OCR文字未独立核实；没有页码时使用块定位。</p><pre>${escape(JSON.stringify(c.locations,null,2))}</pre></div>`:'';
  return '<div>'+evidenceInspector()+location+'</div>';
}
function evidenceInspector() { if(!state.selected)return '<div class="panel inspector"><div class="eyebrow">证据核对</div><div class="empty-symbol">◇</div><h3>从关系，回到原文。</h3><p class="muted small">点击图中的实体或声明，查看它的范围、来源和逐字证据。</p></div>';
  const claim=claimList().find(c=>c.id===state.selected); if(!claim){const ent=schema()?.entities.find(e=>e.id===state.selected);return `<div class="panel inspector"><div class="eyebrow">实体</div><h3>${escape(ent?.name||state.selected)}</h3>${badge(typeName(ent?.type))}<br><br><p class="help">相关声明</p>${claimList().filter(c=>c.subject_id===state.selected).map(c=>`<button class="claim-button" data-action="claim" data-id="${escape(c.id)}">${escape(predicateName(c.predicate_id))} · ${escape(valueLabel(c))}</button>`).join('')}</div>`;}
  const source=state.task.input.sources.find(s=>s.id===claim.source_id); 
  return `<div class="panel inspector"><div class="eyebrow">证据核对</div><h3>${escape(entityName(claim.subject_id))}</h3>${badge('来源陈述','green')}<div class="kv"><span>属性 / 关系</span><span>${escape(predicateName(claim.predicate_id))}</span><span>值</span><span>${escape(valueLabel(claim))}</span><span>语气</span><span>${claim.modality==='PLANNED'?'计划，非现行能力':'原文现行陈述'}</span><span>范围</span><span>${escape(claim.scope??'未说明')}</span><span>有效时间</span><span>${escape(claim.effective_from??claim.time_raw??'未知')}</span></div><div class="quote">${escape(claim.quote)}</div><div class="kv"><span>来源</span><span>${escape(source?.title)}</span><span>来源身份</span><span>上传资料，原始发布者未确认</span><span>独立核实</span><span>未独立核实</span></div>${evidenceContextMarkup(claim)}${button('打开完整原文','open-review-source','tiny',`data-id="${escape(claim.id)}"`)}<details><summary>定位与版本</summary><pre>${escape(JSON.stringify({source_id:claim.source_id,sha256:source?.sha256,start:claim.start,end:claim.end,unit:claim.offset_unit},null,2))}</pre></details></div>`; }
function graphPage() {
  if(!schema()||(!['READY','REVIEW_REQUIRED'].includes(state.task?.status)&&!state.taskReview?.review))return blank('还没有候选图谱','生成与校验后可探索候选实体及证据；通过评审前不开放事实查询。');
  const command=(label,value)=>`<button type="button" class="graph-tool" data-graph-command="${value}">${label}</button>`;
  return `<div class="graph-workbench ${state.selected?'':'graph-overview'}" data-graph-workbench><div class="graph-stage"><div class="graph-surface" data-graph-surface role="img" aria-label="可缩放拖拽的知识图谱" tabindex="0"></div>
    <details class="graph-browser"><summary class="graph-browser-title">实体探索 <span>${schema().entities.length}</span></summary><div class="graph-browser-content"><input data-graph-search aria-label="检索图中实体" placeholder="检索实体…"><nav aria-label="图中实体列表">${schema().entities.map(e=>`<button type="button" data-graph-command="entity" data-entity="${escape(e.id)}"><span class="graph-list-dot"></span>${escape(e.name)}<small>${claimList().filter(c=>c.subject_id===e.id).length}</small></button>`).join('')}</nav><label class="graph-switch"><input type="checkbox" data-graph-statements checked>显示属性声明</label></div></details>
    <div class="graph-tools" aria-label="图谱操作">${command('＋','in')}${command('−','out')}${command('适应视图','fit')}${command('暂停动效','motion')}<details class="graph-tool-menu"><summary class="graph-tool">更多</summary><div>${command('力导向','layout')}${command('环形','circle')}${command('仅看邻域','focus')}${command('返回全图','unfocus')}</div></details></div>
    <div class="graph-caption"><strong>${escape(state.task.input.name)}</strong><span data-graph-status role="status">正在加载本地图谱引擎…</span>${state.task.status!=='READY'?'<span class="error-text">待评审候选，不开放事实查询</span>':''}</div>
    <div class="graph-legend"><span><i class="entity-dot"></i>实体</span><span><i></i>来源声明</span><span><i class="plan-dot"></i>计划</span><span>拖动节点联动 · 滚轮缩放 · 双击聚焦</span></div></div>
    <div class="graph-evidence" id="graph-inspector">${inspector()}</div></div>`;
}
function updateGraphInspector(){const panel=root.querySelector?.('#graph-inspector');if(panel){panel.innerHTML=inspector();root.querySelector?.('[data-graph-workbench]')?.classList?.toggle('graph-overview',!state.selected);}}
async function mountGraphView(){
  if(typeof root.querySelector!=='function')return;
  if(productEnabled()&&state.nativeGraph?.domain_graph){
   const container=root.querySelector('[data-native-domain-graph-workbench]'),payload=state.nativeGraph,epoch=graphEpoch;if(!container)return;
   try{const tools=await import('./assets/graph-view.mjs');if(epoch!==graphEpoch||!container.isConnected)return;
    graphView=tools.createGraphView(container,{id:payload.index_revision??state.nativeRun?.run_id??'native-domain'},{layoutKey:state.productLibraryId+':domain:'+(payload.index_revision??state.nativeRun?.run_id),projectionFactory:(_task,options)=>tools.projectNativeDomainGraph(payload,{...options,focusId:state.nativeDomainFocus}),edgeLabels:'auto',labelTheme:'native-domain',statementLabel:'知识',onSelect:updateNativeDomainInspector});
    if(state.nativeDomainSelected)graphView.select(state.nativeDomainSelected.id,state.nativeDomainSelected.kind);
   }catch(error){if(epoch===graphEpoch){const status=container.querySelector('[data-graph-status]');if(status)status.textContent='领域图画布暂不可用，知识与来源仍可从详情查看。'+error.message;}}
   return;
  }
  if(productEnabled()){
   const container=root.querySelector('[data-product-graph-workbench]'),payload=productGraphForMode(state.productView,state.knowledgeMode),epoch=graphEpoch;if(!container||!payload)return;
   try{const tools=await import('./assets/graph-view.mjs');if(epoch!==graphEpoch||!container.isConnected)return;productGraphTools=tools;graphView=tools.createGraphView(container,{id:payload.graph_revision},{layoutKey:state.productLibraryId+':'+payload.graph_revision,projectionFactory:(_task,options)=>tools.projectSourceGraph(payload,options),statementLabel:state.knowledgeMode==='graph'&&Object.hasOwn(state.productView??{},'published_graph')?'已发布陈述':'待核实陈述',onSelect:updateProductInspector});if(state.productGraphSelected)updateProductInspector(state.productGraphSelected.id,state.productGraphSelected.kind);}
   catch(error){if(epoch===graphEpoch){const status=container.querySelector('[data-graph-status]');if(status)status.textContent='候选图暂不可用，原文仍可阅读。'+error.message;}}
   return;
  }
  const container=root.querySelector('[data-graph-workbench]');if(!container)return;
  const epoch=graphEpoch,task=state.task;
  try{const {createGraphView}=await import('./assets/graph-view.mjs');if(epoch!==graphEpoch||!container.isConnected)return;
    graphView=createGraphView(container,task,{layoutKey:state.boot?.knowledge_bases?.find(b=>b.task_ids.includes(task.id))?.id||task.id,onSelect(id){state.selected=id;updateGraphInspector();}});
  }catch(error){if(epoch!==graphEpoch)return;const status=container.querySelector('[data-graph-status]');if(status)status.textContent='图谱引擎加载失败：'+error.message+'。资料和证据仍保留，请重新加载。';}
}
function naturalAnswerValue(item){
  const value=item.value;
  if(value&&typeof value==='object'&&!Array.isArray(value)&&Array.isArray(value.values))return `<h3>${escape(entityName(value.entity))}</h3><ul>${value.values.map(v=>`<li>${escape(typeof v==='object'?JSON.stringify(v):v)}</li>`).join('')}</ul>`;
  return `<strong>${escape(typeof value==='object'?JSON.stringify(value):value)}</strong>`;
}
function synthesisMarkup(answer){
  const blocks=answer?.synthesis?.blocks;if(!blocks)return '';
  const blockMarkup=b=>`${b.heading?`<h3>${escape(b.heading)}</h3>`:''}${b.statements.map(s=>`<p class="answer-paragraph"><button type="button" class="answer-citation ${state.answerEvidence===s.id?'selected':''}" data-action="answer-evidence" data-statement-id="${escape(s.id)}" aria-haspopup="dialog" aria-controls="answer-evidence-drawer" aria-expanded="${state.answerEvidence===s.id}" title="查看依据 · ${s.claim_ids.length} 条来源声明">${escape(s.text)}</button></p>`).join('')}`;
  const allSubjects=new Set(Object.values(answer.evidence_index||{}).map(e=>e.subject_id)),overviewSubjects=new Set(blocks[0]?.statements.flatMap(s=>s.claim_ids.map(id=>answer.evidence_index?.[id]?.subject_id)));
  const compact=answer.answer_mode==='SYNTHESIS'&&blocks.length>1&&[...allSubjects].every(id=>overviewSubjects.has(id));
  return `<div class="synthesized-answer">${answer.answer_mode==='SOURCE_PREVIEW'?`<p class="help">${escape(answer.reason)}</p>`:''}${answer.answer_mode==='SOURCE_EXCERPTS'?`<p class="notice warning">${escape(answer.reason||'以下为原始来源陈述。')}</p>`:''}${compact?blockMarkup(blocks[0])+`<details class="answer-explanation"><summary>展开解释与边界</summary>${blocks.slice(1).map(blockMarkup).join('')}</details>`:blocks.map(blockMarkup).join('')}${answer.synthesis.gaps?.length?`<div class="answer-gaps"><h3>当前缺口</h3>${answer.synthesis.gaps.map(g=>`<p>${escape(g)}</p>`).join('')}</div>`:''}</div>`;
}

function supportSetMarkup(e){return e.support_set?.length?`<details class="support-set"><summary>补充原文依据 · ${e.support_set.length}</summary>${e.support_set.map(s=>`<section><p class="help">${escape(s.source_title||s.source_id)} · ${escape(s.role)}</p><blockquote>${escape(s.quote)}</blockquote><p class="help">${escape(s.start)}–${escape(s.end)} · ${escape(s.source_sha256)}</p></section>`).join('')}</details>`:'';}
function answerEvidenceDrawer(){
  const answer=state.directAnswer?.answer,statement=answer?.synthesis?.blocks.flatMap(b=>b.statements).find(s=>s.id===state.answerEvidence);
  if(!statement||state.view!=='knowledge')return '';
  const snapshot=answer.snapshot,base=state.boot?.knowledge_bases?.find(b=>b.id===snapshot?.base_id),changed=base&&base.source_epoch!==snapshot.source_epoch;
  return `<div class="answer-drawer-layer"><button class="answer-drawer-backdrop" data-action="close-answer-evidence" tabindex="-1" aria-label="关闭证据抽屉"></button><aside id="answer-evidence-drawer" class="answer-evidence-drawer" role="dialog" aria-modal="true" aria-labelledby="answer-evidence-title" tabindex="-1"><header><h2 id="answer-evidence-title">结论依据</h2><button id="answer-evidence-close" class="btn tiny" data-action="close-answer-evidence" aria-label="关闭证据抽屉">关闭</button></header><div class="answer-drawer-body"><p class="selected-conclusion">${escape(statement.text)}</p><p class="help">${statement.support_kind==='SYNTHESIS'?'结合所列证据归纳':'原文依据'} · 有来源支持，不代表独立事实认证</p>${changed?'<p class="notice warning">资料范围已变化，以下展示回答当时的历史依据，使用前需重新核对。</p>':''}${statement.claim_ids.map((id,i)=>{const e=answer.evidence_index?.[id];if(!e)return '<p class="notice warning">该依据未随回答保存，无法展示。</p>';const page=e.locations?.flatMap(l=>l.provenance||[]).map(p=>p.page_no).find(Number.isInteger);return `<section class="answer-source"><h3>依据 ${i+1} · ${escape(e.source_title)}</h3><p class="help">${escape(e.context?.locator||'原文位置待核对')}</p>${qualifierMarkup([e])}<div class="evidence-context">${e.context?.segments?.map((s,i)=>`${i?'<p class="context-gap">…</p>':''}<div class="context-fragment">${escape(s.before)}<mark>${escape(s.highlight)}</mark>${escape(s.after)}</div>`).join('')||`<blockquote>${escape(e.quote)}</blockquote>`}</div>${supportSetMarkup(e)}<button class="btn tiny" data-action="answer-source" data-claim-id="${escape(id)}">阅读全文并定位</button>${e.document_id?` <a class="btn tiny" href="/api/documents/${escape(e.document_id)}/original" target="_blank" rel="noopener">下载原文件</a>`:''}<details><summary>来源与版本</summary><dl class="answer-version"><dt>知识版本</dt><dd>${escape(snapshot?.task_id)}</dd><dt>回答时间</dt><dd>${escape(snapshot?.answered_at)}</dd><dt>资料版本 SHA-256</dt><dd>${escape(e.source_sha256)}</dd><dt>原文位置</dt><dd>${escape(e.start)}–${escape(e.end)} · UTF-16</dd><dt>来源身份</dt><dd>用户上传资料；原始发布者未独立核实</dd></dl></details></section>`;}).join('')}</div></aside></div>`;
}
function closeAnswerEvidence(){const id=state.answerEvidence;state.answerEvidence=null;render();document.querySelector(`[data-statement-id="${id}"]`)?.focus?.();}

function qualifierMarkup(rows){
  const text=[...new Set((rows||[]).map(q=>[q.scope?'适用条件：'+q.scope:'',q.time_raw?'时间：'+q.time_raw:q.effective_from?'生效：'+q.effective_from:'',q.unit?'单位：'+q.unit:'',({GT:'大于',GE:'至少',LT:'低于',LE:'至多',APPROX:'约'})[q.comparator]||'',q.modality==='PLANNED'?'计划，非现行能力':''].filter(Boolean).join(' · ')).filter(Boolean))];
  return text.length?`<div class="answer-qualifiers">${text.map(t=>`<p class="help">${escape(t)}</p>`).join('')}</div>`:'';
}
function queryValues(answer){
  if(answer.value===null)return `<div class="query-values">${badge('无法确定')}</div>`;
  const values=answer.value||[],render=items=>`<ul class="answer-summary">${items.map(v=>`<li>${escape(entityName(v))}${qualifierMarkup((answer.claims||[]).filter(c=>JSON.stringify(c.value)===JSON.stringify(v)))}</li>`).join('')}</ul>`;
  return render(values.slice(0,3))+(values.length>3?`<details><summary>展开其余 ${values.length-3} 条来源陈述（共 ${values.length} 条）</summary>${render(values.slice(3))}</details>`:'');
}
function queryEvidence(answer){
  const claims=answer.claims||[],render=items=>items.map(c=>`<button class="claim-button" data-action="claim" data-id="${escape(c.id)}">${escape(entityName(c.subject_id))} · ${escape(predicateName(c.predicate_id))} · ${escape(valueLabel(c))}<br><span class="muted">查看原文证据 →</span></button>`).join('');
  return render(claims.slice(0,2))+(claims.length>2?`<details><summary>查看其余 ${claims.length-2} 条证据</summary>${render(claims.slice(2))}</details>`:'');
}
function queriesPage(){
  if(state.view==='queries')return detailedQueriesPage();
  const answer=state.directAnswer,ready=answer?.status==='ANSWERED',learning=answer?.status==='LEARNING';
  const suggestions=state.task.input.cqs.map((q,i)=>({...q,index:i})).filter(q=>!q.id.startsWith('LQ_')).slice(0,4);
  return `<div class="question-workspace ${answer||state.answerDraft?.text?'has-answer':''}">${answer||state.answerDraft?.text?`<h1 class="asked-question">${escape(answer?.request_context?.question||state.askQuestion)}</h1>`:''}<section class="panel ask-composer"><div class="panel-head"><div><span class="eyebrow">与你的知识对话</span><h1>你想了解什么？</h1></div><span class="muted small">${state.task.input.sources.length} 份资料</span></div><textarea id="ask-question" rows="${answer||state.answerDraft?.text?1:3}" maxlength="1000" aria-label="向知识库提问" placeholder="向你的资料提问，发现新的联系…">${escape(state.askQuestion||'')}</textarea><div class="composer-actions"><span class="muted small" role="status">${state.answerPending?escape(state.askProgress||'正在理解问题…'):''}</span>${button(state.answerPending?'回答中…':'提问','ask-question','primary',state.busy?'disabled':'')}</div></section>
  ${state.pendingLearning?learningProgress():''}
  ${state.answerDraft?.text&&state.answerDraft.task_id===state.task.id&&state.answerDraft.question===state.askQuestion?`<section class="panel answer-surface"><div class="panel-head"><h2>回答</h2><span class="muted small">${state.answerDraft.finishing?'正在呈现':(state.askProgress?.includes('核对')?'核对中':'生成中')+' · 待核对'}</span></div><div id="answer-draft-text" class="answer-draft-text">${escape(state.answerDraft.shown??state.answerDraft.text)}</div></section>`:answer?`<section class="panel answer-surface" aria-live="polite"><div class="panel-head"><h2>${ready||answer.status==='ANSWERING'?'回答':answer.status==='PREVIEW'?'相关资料':classLabel[answer.status||answer.classification]||'查询结果'}</h2>${ready&&state.answerWasRevised?'<span class="muted small">已按原文修订</span>':''}</div>${!ready&&!learning&&answer.status!=='PREVIEW'&&answer.status!=='ANSWERING'?`<p>${escape(answer.reason||answer.answer?.reason||'')}</p>`:''}${learning&&!state.pendingLearning?'<p role="status">正在补充相关知识…</p>':''}${answer.answer?.answer_mode==='PRODUCT'?`<p class="answer-paragraph">${escape(answer.answer.text)}</p>`:answer.answer?.synthesis?synthesisMarkup(answer.answer):(answer.answer?.items||[]).map(i=>`<div class="answer-paragraph">${naturalAnswerValue(i)}${qualifierMarkup(i.qualifiers)}<details><summary>查看依据</summary>${(i.evidence||[]).map(e=>`<blockquote>${escape(e.quote)}</blockquote>`).join('')}</details></div>`).join('')}${!answer.answer&&answer.value!==undefined?`<pre>${escape(JSON.stringify(answer.value,null,2))}</pre>`:''}</section>`:!state.answerPending&&suggestions.length?`<section class="question-suggestions"><p class="muted small">试着问</p>${suggestions.map(q=>`<button class="suggestion-chip" data-action="use-question" data-index="${q.index}">${escape(q.question)} <span aria-hidden="true">↗</span></button>`).join('')}</section>`:''}</div>`;
}

function detailedQueriesPage() {
  if(state.task?.status!=='READY')return blank('当前版本尚未开放查询','需要先完成评审；有争议的版本不能被当作事实库使用。');
  return head('知识库 · 问答与证据',escape(state.task.input.name)+' · 从问题得到答案，也能逐句核对依据。')+coveragePanel()+scopeSummary()+capabilityPanel()+executionContextPanel()+backlogPanel()
    + `<details class="panel query-technical"><summary>高级：查询后端与版本</summary><p class="help">当前版本：${escape(state.task.id)}。默认 SQLite，不需要图数据库；连接 Neo4j 不会自动切换后端。</p><label>查询后端 <select id="query-backend"><option value="SQLITE" ${state.queryBackend!=='NEO4J'?'selected':''}>SQLite（默认）</option><option value="NEO4J" ${state.queryBackend==='NEO4J'?'selected':''}>Neo4j（高级，需主动同步）</option></select></label></details><div class="split"><div>${state.task.input.cqs.map(q=>{
      const a=state.queryAnswers?.[q.id] || state.task.result.answers?.find(a=>a.cq_id===q.id);
      const plan=schema().cq_plans.find(p=>p.cq_id===q.id);
      return `<div class="query-card"><div class="row">${a?badge(a?.pending_review?'等待核对':plan?.template==='UNKNOWN'?'能力未覆盖':classLabel[a.classification]||a.classification):badge('尚未查询')}</div>
        <h3>${escape(q.question)}</h3>${button('执行查询','query','tiny',`data-cq="${escape(q.id)}" ${state.busy?'disabled':''}`)}
        ${a?`${a.comparisons?`<div class="table-wrap"><table><thead><tr><th>主体</th><th>状态</th><th>来源陈述</th></tr></thead><tbody>${a.comparisons.map(c=>`<tr><td>${escape(entityName(c.subject_id))}</td><td>${escape(classLabel[c.classification]||c.classification)}</td><td>${c.value?queryValues(c):'缺证或冲突；不判定为不具备'}</td></tr>`).join('')}</tbody></table></div>`:queryValues(a)}
        <p>${escape(a.reason)}</p>${queryEvidence(a)}`:''}<details><summary>高级：此问题的执行信息</summary><p>${escape(q.id)} · ${escape(plan?.template||'UNKNOWN')} · ${escape(a?.backend||'构建结果快照')}</p></details></div>`;
    }).join('')}<div class="notice">${state.task?.publication?'系统会按需补充新问题涉及的知识；资料不足时明确缺证。':'新问法可使用上方已有能力；能力未覆盖时才需要补充 CQ 并创建新版本。没有证据不等于不具备能力。'}</div></div>${inspector()}</div>`;
}
function scopeSummary(){const t=state.task,s=schema(),uncovered=coverageRows().filter(r=>r.group==='uncovered'),missing=coverageRows().filter(r=>r.group==='missing');return `<section class="panel scope-summary"><h2>本次知识范围</h2><p><span class="muted">资料：</span>${t.input.sources.map(source=>escape(source.title)+(t.publication?.revoked_source_ids?.includes(source.id)?'（已移出）':'')).join('、')}</p><p><span class="muted">关键定义：</span>${escape(t.input.definitions||'尚未补充业务定义；按原文范围回答。')}</p><p><span class="muted">可查询主题：</span>${(s?.predicates||[]).map(p=>escape(p.label)).join('、')||'尚无明确主题'}</p>${uncovered.length?`<p><span class="muted">尚未覆盖的问题：</span>${uncovered.map(q=>escape(q.question)).join('；')}</p>`:'<p class="help">起始问题均已有查询路径，不代表每题都有充分证据。</p>'}${missing.length?`<p><span class="muted">当前缺证的问题：</span>${missing.map(a=>escape(t.input.cqs.find(q=>q.id===a.cq_id)?.question||a.question)).join('；')}</p>`:''}</section>`;}
function coverageRows(){return(state.task?.input.cqs||[]).map(q=>{const answer=state.queryAnswers?.[q.id]||state.task.result?.answers?.find(a=>a.cq_id===q.id),plan=schema()?.cq_plans?.find(p=>p.cq_id===q.id);
  const group=answer?.pending_review?'conflict':plan?.template==='UNKNOWN'||answer?.classification==='UNSUPPORTED'?'uncovered':answer?.classification==='CONFLICT'?'conflict':answer?.classification==='ATTRIBUTED_ONLY'?'answerable':answer?.classification==='UNKNOWN'?'missing':'pending';return{question:q.question,answer,group};});}
function coveragePanel(){const rows=coverageRows(),groups=[['answerable','可回答','有来源支持，不等于独立核实'],['missing','缺少证据','不把缺失推断为否定'],['conflict','来源冲突','保留原文，不自动选边'],['uncovered','尚未覆盖','需要确认新的查询范围']];
  return `<section class="coverage-section"><div class="panel-head"><h2>问题覆盖</h2><span class="muted small">${rows.length} 个问题${rows.some(r=>r.group==='pending')?' · 部分等待检查':''}</span></div><div class="coverage-grid">${groups.map(([key,label,note])=>`<div class="coverage-item ${key}"><div class="coverage-item-title"><span>${label}</span><strong>${rows.filter(r=>r.group===key).length}</strong></div><p>${note}</p><details><summary>查看问题</summary>${rows.filter(r=>r.group===key).map(r=>`<p>${escape(r.question)}</p>`).join('')||'<p>当前没有</p>'}</details></div>`).join('')}</div></section>`;}
function backlogPanel(){const answer=state.directAnswer,uncovered=answer&&['UNSUPPORTED','NEEDS_CLARIFICATION'].includes(answer.status||answer.classification),question=answer?.request_context?.question||state.askQuestion||'',items=state.questionBacklog||[];
  if(state.task?.publication)return '';
  return `<section class="backlog-panel">${uncovered?`<div class="notice"><h3>这个问题尚未形成可直接复用的查询</h3><p>可以先保存，稍后一起确认扩展范围；保存不会调用模型，也不会自动改变图谱。</p>${button(items.some(i=>i.question===question.trim())?'已保存到待扩展':'保存到待扩展','save-backlog','tiny',items.some(i=>i.question===question.trim())?'disabled':'')}</div>`:''}${items.length?`<details class="panel"><summary>待扩展问题 · ${items.length}</summary>${items.map(i=>`<p>${escape(i.question)}</p>`).join('')}<p class="help">仅是后续需求清单，不是已支持能力。</p></details>`:''}</section>`;}
function capabilityPanel() {
  const caps=state.catalog?.capabilities||[], chosen=caps.find(c=>c.id===state.capabilityId)||caps[0];
  const entities=schema()?.entities||[];
  const answer=state.directAnswer;
  return `<section class="panel"><h2>向知识库提问</h2><textarea id="ask-question" rows="2" maxlength="1000" placeholder="例如：甲服务商覆盖哪些地区？">${escape(state.askQuestion||'')}</textarea><p class="help">${state.task?.internal_scope?'系统自动理解问题，使用当前知识与原文依据回答。':'提问后先核对发送范围与调用上限；不自动授权、不发送完整原始文件。路由和回答分别计数。'}</p>${button(state.answerPending?'正在整理回答…':'提问','ask-question','primary',state.busy?'disabled':'')}${state.answerPending?'<p class="help" role="status">正在查询资料、组织结论并核对依据。</p>':''}<p class="help">系统会依据资料核实主体称呼；无法唯一确定时请你确认。历史、修订和指定日期问题暂不支持。</p><details><summary>参数化查询（SQLite，无模型调用）</summary>${button('刷新查询能力','load-capabilities','tiny')}${caps.length?`<div class="field"><label for="capability-select">查询能力</label><select id="capability-select">${caps.map(c=>`<option value="${escape(c.id)}" ${c.id===chosen.id?'selected':''}>${escape(c.predicate?.label||c.predicate_id)} · ${escape(c.template)}${c.status==='AMBIGUOUS'?'（映射歧义，不可用）':''}</option>`).join('')}</select></div><p class="help">${escape(chosen.example_questions?.join('；'))}</p>${chosen.parameters.includes('subject_id')?`<div class="field"><label for="typed-subject">主体</label><select id="typed-subject">${entities.filter(e=>chosen.subject_types.includes(e.type)).map(e=>`<option value="${escape(e.id)}" ${e.id===chosen.defaults.subject_id?'selected':''}>${escape(e.name)}</option>`).join('')}</select></div>`:''}${chosen.parameters.includes('subject_ids')?`<div class="field"><label for="typed-subjects">比较主体（选择2–8个，可按住⌘/Ctrl多选）</label><select id="typed-subjects" multiple>${entities.filter(e=>chosen.subject_types.includes(e.type)).map(e=>`<option value="${escape(e.id)}" ${chosen.defaults.subject_ids?.includes(e.id)?'selected':''}>${escape(e.name)}</option>`).join('')}</select></div>`:''}<div class="field"><label for="typed-object">目标值（留空表示不限定；实体筛选必须填写）</label><input id="typed-object" value="${escape(chosen.defaults.object_value??'')}" ${chosen.predicate?.value_type==='NUMBER'?'type="number"':''}><span class="help">类型 ${escape(chosen.predicate?.value_type)}${chosen.predicate?.value_type==='ENTITY'?'；目标请填写实体ID，参见本体契约':''}。不开放日期参数。</span></div>${button('执行参数查询','execute-capability','',state.busy||chosen.status!=='AVAILABLE'?'disabled':'')}`:'<p class="help">尚未加载查询能力；可点击刷新。</p>'}</details>${answer?`<div class="notice">${badge(classLabel[answer.answer?.classification||answer.classification||answer.status]||answer.status)}<p>${escape(answer.reason||answer.answer?.reason||'')}</p>${answer.answer?.coverage?.view==='SUMMARY'?`<p class="help">回答要点 · 完整结果共 ${answer.answer.coverage.total_claims} 条来源陈述，可展开查看。</p>`:''}${answer.answer?.answer_mode==='PRODUCT'?`<p class="answer-paragraph">${escape(answer.answer.text)}</p>`:answer.answer?.synthesis?synthesisMarkup(answer.answer):(answer.answer?.items||[]).map(i=>`<div>${naturalAnswerValue(i)}${qualifierMarkup(i.qualifiers)}<details><summary>查看要点依据</summary>${i.evidence.map(e=>`<blockquote>${escape(e.quote)}</blockquote><small>${escape(e.source_id)}</small>`).join('')}</details></div>`).join('')}${!answer.answer&&answer.value!==undefined?`<pre>${escape(JSON.stringify(answer.value,null,2))}</pre>`:''}<details><summary>展开全部 ${(answer.claims||[]).length} 条事实与证据</summary>${(answer.claims||[]).map(c=>`<button class="claim-button" data-action="claim" data-id="${escape(c.id)}">${escape(entityName(c.subject_id))} · ${escape(valueLabel(c))}${qualifierMarkup([c])}<br>查看原文证据 →</button>`).join('')}</details><p class="help">来源陈述不等于独立核实。</p><details><summary>高级：本次回答版本</summary><small>${escape(answer.version||state.task.id)} · ${escape(answer.backend||'SQLITE')}</small></details></div>`:''}</section>`;
}
function executionContextPanel() {
  const request=state.directAnswer?.request_context;if(!request)return '';
  return `<details class="panel"><summary>本次结果对应的实际请求（高级）</summary>${request.question?`<p>原问题：${escape(request.question)}</p>`:`<p>参数化能力：<code>${escape(request.capability_id)}</code></p><pre>${escape(JSON.stringify(request.params,null,2))}</pre>`}<p class="help">任务版本 ${escape(request.task_id)}。此处记录实际执行参数，不是表单默认值。</p></details>`;
}
function changeAskQuestion(el) {
  if(state.askQuestion===el.value)return;
  if(productEnabled()){const hadAnswer=Boolean(state.productAnswer),position=el.selectionStart;state.askQuestion=el.value;clearProductAnswer();if(hadAnswer){render();const field=document.querySelector('#ask-question');field?.focus?.();if(Number.isInteger(position))field?.setSelectionRange?.(position,position);}return;}
  const hadAnswer=Boolean(state.directAnswer),position=el.selectionStart;
  state.askQuestion=el.value;state.askConsent=false;state.directAnswer=null;state.answerDraft=null;state.answerEvidence=null;state.askRevision=(state.askRevision||0)+1;
  const consent=document.querySelector('#ask-consent');if(consent)consent.checked=false;
  if(hadAnswer){render();const field=document.querySelector('#ask-question');field?.focus?.();if(Number.isInteger(position))field?.setSelectionRange?.(position,position);}
}

function versionPanel() {
  const t=state.task;if(!t)return '';
  return `<section class="panel"><div class="panel-head"><h2>当前任务版本</h2>${badge(t.revision?'V'+t.revision.number:'V1')}${badge('SQLite 已保存')}</div><p class="help">${escape(t.id)}</p>
    ${['FAILED','INTERRUPTED','CANCELLED'].includes(t.status)?`<div class="notice"><h3>按当前模型配置重试</h3><p>创建新任务并完整执行，不覆盖本次失败。会重新发送本任务的资料及CQ；不会自动重试或接受截断输出。</p><div class="field"><label for="retry-max-tokens">本次重试的最大输出 tokens</label><input id="retry-max-tokens" type="number" min="1024" max="32768" step="1024" value="${Math.max(16000,state.boot.max_tokens||8000)}"></div><label class="consent"><input type="checkbox" id="retry-consent"><span>我允许重新向当前模型发送本任务资料。</span></label>${button('完整重试（新任务）','retry-task','primary',state.busy||active()?'disabled':'')}<p class="help">增加输出上限可能增加耗时与费用，不保证解决上下文不足或拒答。旧响应未保存时不能断言一定是截断。</p></div>`:''}
    ${t.result?.runtime_issues?.length?`<div class="notice warning">当前查询规则发现 ${t.result.runtime_issues.length} 项计划问题；受影响的 CQ 已返回 UNKNOWN。历史评审记录保留，请创建修订版本修复。${t.result.runtime_issues.map(i=>`<p>${escape(i.cq_ids.join('、'))}：${escape(i.explanation)}</p>`).join('')}</div>`:''}
    ${t.revision?`<p class="small">修订说明：${escape(t.revision.note)}</p><p class="help">状态：${escape(t.revision.resolution)} · 父版本 ${escape(t.revision.parent_id)}</p>
    <details><summary>本次修改了什么</summary><ul>${t.revision.changes.map(c=>`<li>${escape(({definitions:'业务定义',cqs:'能力问题',sources:'来源资料',as_of:'查询时点'})[c.field]||c.field)} · 前后内容哈希已记录</li>`).join('')}</ul></details>
    ${button('打开父版本','task','tiny',`data-id="${escape(t.revision.parent_id)}"`)}${button('对比父版本','version-diff','tiny')}`:'<p class="help">原始构建版本；修订会生成有父版本记录的新版本，不覆盖旧结果。</p>'}
    ${state.versionDiff?`<details open><summary>版本差异 · 本地快照</summary><p class="help">${escape(state.versionDiff.notice)}</p>
    ${state.versionDiff.inputs.map(c=>`<h3>${escape(c.field)}</h3><p class="help">修改前</p><pre>${escape(JSON.stringify(c.before,null,2))}</pre><p class="help">修改后</p><pre>${escape(JSON.stringify(c.after,null,2))}</pre>`).join('')}
    <div class="table-wrap"><table><thead><tr><th>CQ</th><th>父版本</th><th>本版本</th><th>变化</th></tr></thead><tbody>${state.versionDiff.answers.map(a=>`<tr><td>${escape(a.question)}</td><td>${escape(classLabel[a.before?.classification]||a.before?.classification||'无此CQ')}</td><td>${escape(classLabel[a.after?.classification]||a.after?.classification||'无此CQ')}</td><td>${a.changed?'有变化':'无变化'}</td></tr>`).join('')}</tbody></table></div>
    <details><summary>完整差异（含答案值、来源哈希及证据）</summary><pre>${escape(JSON.stringify(state.versionDiff,null,2))}</pre></details></details>`:''}
    ${t.status==='DRAFT'?`${button('恢复修订草稿','resume-draft','primary')}<p class="help">尚未调用模型。恢复后需明确授权，再完整执行生成与独立评审。</p>`:''}
    ${state.boot.graph?.connected&&['READY','REVIEW_REQUIRED'].includes(t.status)?button(t.graph_sync?.status==='FAILED'?'重试同步 Neo4j':'主动同步到 Neo4j（高级）','sync-graph','tiny',state.busy?'disabled':''):''}
    ${t.graph_sync?.error?`<p class="error-text">${escape(t.graph_sync.error)}</p>`:''}
    <p class="help">入图不代表通过评审；待处理版本仍禁止事实查询。查询故障不自动重跑模型，也不静默切换后端。</p></section>`;
}
function revisionInput() {
  if(!state.draft.parent_id)return '';
  return `<section class="panel"><h2>修订版本</h2><p class="help">父版本 ${escape(state.draft.parent_id)}。修改下方定义、CQ、资料或时点；旧任务保留，问题不会因填写说明而被自动判为解决。</p>
    <div class="field"><label for="revision-note">修订说明 · 必填</label><textarea id="revision-note" data-field="revision_note" rows="3" maxlength="2000" placeholder="例如：补充服务覆盖的定义，说明与办公室所在地的区别。">${escape(state.draft.revision_note||'')}</textarea></div>
    ${button('保存修订草稿（不调用模型）','save-draft','',state.busy?'disabled':'')}</section>`;
}
function graphSettingsPage() {
  const g=state.boot.graph||{};
  return `<details class="panel settings"><summary>高级设置 · Neo4j（可选，不影响默认使用）</summary><div class="panel-head"><h2>Neo4j 图存储</h2>${badge(g.connected?'已连接':'未连接',g.connected?'green':'yellow')}</div>
    <p class="help">独立 CQForge 存储命名空间（兼容已有数据）；不修改其他项目节点。不向数据库之外发送资料。</p>
    <div class="field"><label for="graph-uri">本机 Bolt 地址</label><input id="graph-uri" value="${escape(g.uri||'bolt://127.0.0.1:7687')}"></div>
    <div class="field"><label for="graph-database">数据库名称</label><input id="graph-database" value="${escape(g.database||'neo4j')}"></div>
    <div class="field"><label for="graph-user">数据库用户名</label><input id="graph-user" value="neo4j" autocomplete="off"></div>
    <div class="field"><label for="graph-password">数据库密码</label><input id="graph-password" type="password" autocomplete="off" placeholder="只保存在本地服务进程内存中"></div>
    ${button('连接 Neo4j','connect-graph','primary',state.busy?'disabled':'')}${g.connected?button('断开数据库','disconnect-graph'):''}
    <p class="help">连接会创建 CQForge 存储兼容约束。所有任务均需主动同步；连接不切换查询后端。密码不写入任务或配置文件，服务重启后重新连接。</p></details>`;
}
function environmentPanel() {
  const migration=state.boot.migration;
  return `<section class="panel"><h2>本地环境与数据</h2><p>默认 SQLite · 无需 Neo4j 密码。配置模型 → 上传并核对解析预览 → 填写 CQ 与定义 → 构建/修订 → 查询与原文回溯。</p><p class="help">模型地址与名称会保留；重启后需要重新输入密钥。解析未就绪时先运行 npm run setup，诊断运行 npm run doctor（不调用收费模型）。</p>${button('检查解析环境（不调用模型）','environment','tiny')}${state.environment?`<pre>${escape(JSON.stringify(state.environment,null,2))}</pre>`:''}<details><summary>旧数据迁移报告 · ${migration?.errors?.length||0} 项异常</summary><p class="help">原目录保留，不重新解析或调用模型。异常任务不会冒充导入成功。</p><pre>${escape(JSON.stringify(migration,null,2))}</pre></details>${state.task?`<p class="help">当前版本 ${escape(state.task.id)} · ${escape(state.task.status)}。可查询不等于独立事实认证。</p>`:''}</section>`;
}
function draftPayload() {
  const d=state.draft;
  return { name:d.name,cqs:d.cqs.split('\n').map(s=>s.trim()).filter(Boolean),definitions:d.definitions,
    as_of:d.as_of,sources:productEnabled()?d.sources.map(productSourcePayload):d.sources,revision_note:d.revision_note||'' };
}
let draftSaveQueue=Promise.resolve(),draftSaveTimer=null;
function hasDraftContent(){const d=state.draft;return !d.parent_id&&Boolean(d.name?.trim()||d.cqs?.trim()||d.definitions?.trim()||d.sources?.length);}
function workspaceDraftPayload(){const d=state.draft;return {name:d.name||'',cqs:d.cqs||'',definitions:d.definitions||'',as_of:d.as_of||'',sources:productEnabled()?(d.sources||[]).map(productSourcePayload):d.sources||[],
  ...(state.proposal?.status==='CONFIRMED'?{proposal_id:state.proposal.id}:{}),proposalSelected:state.proposalSelected||[],proposalAnswers:state.proposalAnswers||{}};}
function draftStatus(text){state.draftSaveStatus=text;const el=document.querySelector('#draft-save-status');if(el)el.textContent=text;}
async function persistWorkspaceDraft(){clearTimeout(draftSaveTimer);if(state.draft.parent_id)return;const payload=workspaceDraftPayload();draftStatus('正在保存草稿…');
  draftSaveQueue=draftSaveQueue.catch(()=>{}).then(async()=>{await api('/api/workspace-draft',{draft:payload});draftStatus('草稿已保存在本机');});
  try{await draftSaveQueue;const recovered=state.draftSaveFailure;state.draftSaveFailure=false;if(recovered&&state.view==='input')render();}catch{state.draftSaveFailure=true;draftStatus('草稿尚未保存，请点击保存重试');if(state.view==='input')render();}}
function scheduleDraftSave(){if(state.draft.parent_id)return;clearTimeout(draftSaveTimer);draftStatus('有未保存的修改');draftSaveTimer=setTimeout(()=>{void persistWorkspaceDraft();},400);}
async function clearWorkspaceDraft(){clearTimeout(draftSaveTimer);await draftSaveQueue.catch(()=>{});await api('/api/workspace-draft',{draft:null});state.proposal=null;state.proposalSelected=[];state.proposalAnswers={};state.proposalFingerprint=null;state.draft={name:'',cqs:'',definitions:'',as_of:'',sources:[],consent:false};draftStatus('');}
async function restoreWorkspaceDraft(){
  const saved=await api('/api/workspace-draft');if(!saved?.draft)return;
  const d=saved.draft;state.draft={name:d.name||'',cqs:Array.isArray(d.cqs)?d.cqs.join('\n'):d.cqs||'',definitions:d.definitions||'',as_of:d.as_of||'',sources:d.sources||[],consent:false};
  state.proposal=null;state.proposalSelected=Array.isArray(d.proposalSelected)?d.proposalSelected:[];state.proposalAnswers=d.proposalAnswers||{};
  state.askConsent=false;state.pendingBudget=null;state.approvedBudget=null;state.lastBudget=null;
  if(d.proposal_id){const list=await api('/api/cq-proposals');const p=Array.isArray(list)?list.find(p=>p.id===d.proposal_id):null,confirmed=p?.confirmed_input;
    const questions=confirmed?.cqs?.map(q=>q.question)||[];
    const matching=p?.status==='CONFIRMED'&&confirmed.sources?.length===state.draft.sources.length
      &&confirmed.sources.every((s,i)=>s.content===state.draft.sources[i].content&&s.title===state.draft.sources[i].title)
      &&JSON.stringify(questions)===JSON.stringify(state.draft.cqs.split('\n').map(q=>q.trim()).filter(Boolean))&&confirmed.definitions===state.draft.definitions;
    if(matching){state.proposal=p;state.proposalFingerprint=proposalFingerprint();}
    else state.draftRestoreNotice='原问题范围确认已失效，资料和问题文本已保留，请重新确认。';
  }
  draftStatus('');
}
function restoreDraft(task) {
  const i=task.input;
  state.draft={ name:task.status==='DRAFT'?i.name:i.name+' · 新版本',cqs:i.cqs.map(c=>c.question).join('\n'),
    sources:i.sources.map(s=>({title:s.title,content:s.content,...(s.parsing?{document_id:s.parsing.document_id,parsing:s.parsing}:{})})),
    definitions:i.definitions,as_of:i.as_of||'',consent:false,
    parent_id:task.status==='DRAFT'?task.revision.parent_id:task.id,
    revision_note:task.status==='DRAFT'?task.revision.note:'', saved_draft_id:task.status==='DRAFT'?task.id:null };
  state.savedDraftJson=task.status==='DRAFT'?JSON.stringify(draftPayload()):null;
  state.view='input';render();
}
async function saveRevision() {
  if(state.draft.saved_draft_id && state.savedDraftJson===JSON.stringify(draftPayload()))return {id:state.draft.saved_draft_id};
  return api('/api/tasks/'+state.draft.parent_id+'/revisions',draftPayload());
}
function reviewPage() {
  if(!state.task)return blank('尚未选择知识库','打开已有版本后查看待确认。');
  if(state.taskReview?.review||state.taskReview?.continued_to)return humanReviewPage();
  const t=state.task,packet=state.taskIssues||{},issues=visibleIssues(),d=state.taskDiagnostics||packet.system_diagnostics||{};
  const paused=d.category==='PAUSED_BUDGET'||t.status==='PAUSED'||t.error_details?.code==='BUDGET_EXHAUSTED';
  const technical=paused||d.category==='SYSTEM_FAILURE'||['FAILED','INTERRUPTED','CANCELLED'].includes(t.status);
  const cards=issues.map((i,index)=>{
    const kind=String(i.category||i.kind||i.code||''),conflict=/CONFLICT/.test(kind),unknown=/UNKNOWN|MISSING_EVIDENCE|WAIT_EVIDENCE/.test(kind);
    const system=/SYSTEM|TECHNICAL|CONTRACT|INVALID|QUOTE_NOT_FOUND/.test(kind)&&!conflict&&!unknown;
    return `<article class="issue-card"><div class="row">${badge(system?'系统处理':conflict?'来源冲突':unknown?'证据不足':'需要你确认','yellow')}</div><p>${escape(i.explanation||i.message||i.reason||i.notice||'请核对当前资料与口径。')}</p>${(i.claims||[]).map(c=>`<blockquote>${escape(c.quote)}<small> · ${escape(c.source_id)}</small></blockquote>`).join('')}<p class="help">${escape(i.suggested_change||'')} · 影响问题 ${escape((i.cq_ids||[]).join('、'))}</p>${system?'<p>这不是要求你改写资料；系统将按授权上限处理可恢复问题。</p>':`<div class="field"><label>决定</label><select data-decision-choice="${index}">${conflict?'<option value="KEEP_CONFLICT">保留冲突，不替来源裁决</option>':''}${unknown?'<option value="ADD_EVIDENCE">需要补充证据</option>':'<option value="CONFIRM_DEFINITION">确认一个业务定义</option><option value="ADD_EVIDENCE">需要补充证据</option>'}</select></div><div class="field"><label>定义或处理说明</label><textarea data-decision-note="${index}" maxlength="2000"></textarea></div>${button('保存决定（不调用模型）','save-decision','tiny',`data-index="${index}"`)}`}<details><summary>技术定位</summary><pre>${escape(JSON.stringify(i,null,2))}</pre></details></article>`;
  }).join('');
  if(technical)return `<section class="panel recovery-panel"><h2>${paused?'整理已暂停':'整理暂时中断'}</h2><p>已保留完成的进度，可以继续处理，无需重新上传或改写资料。</p>${d.requires_unknown_resend_confirmation?'<label class="consent"><input id="unknown-resend-consent" type="checkbox"><span>上次请求的结果未知，我确认重新发送未完成的阶段。</span></label>':''}<div class="actions">${button(t.internal_scope?'继续整理':'预览恢复范围','resume-task','primary')}</div><details><summary>其他操作</summary>${paused?'':button('从头重新整理','retry-task','tiny')}<details><summary>诊断信息</summary><pre>${escape(JSON.stringify(d,null,2))}</pre></details></details></section>`;
  return head('待确认','')+(cards||`<section class="panel"><h2>${t.status==='READY'?'当前没有需要确认的决定':'尚未产生人工待确认事项'}</h2>${button('回到知识库','nav-knowledge')}</section>`)+decisionHistory(packet);
}
function visibleIssues(){const p=state.taskIssues;if(Array.isArray(p))return p;if(p&&Array.isArray(p.user_decisions))return [...p.user_decisions.map(i=>({...i,category:'NEEDS_USER'})),...(p.evidence_requests||[]).map(i=>({...i,category:'WAIT_EVIDENCE'})),...(p.conflicts||[]).map(i=>({...i,category:'CONFLICT'}))];return p?.issues||state.task?.result?.gate?.issues||[];}
function decisionHistory(packet){return `<details class="panel"><summary>已保存决定与系统处理历史（不改写原文）</summary><pre>${escape(JSON.stringify({decisions:packet.decisions||[],processing_history:packet.processing_history||[]},null,2))}</pre></details>`;}
const humanChoiceLabels={EXCLUDE_CLAIM:'排除此候选',AMEND_CLAIM:'修正候选后重新校验',RECHECK:'保留候选，请求独立复核',KEEP_CONFLICT:'保留冲突，不自动选边'};
const humanReasonLabels={EVIDENCE_SUPPORTS:'已有原文支持',UNKNOWN_IS_VALID:'缺证应返回未知',SUBJECT_SCOPE:'主体或范围需要重新判断',OTHER:'其他原因'};
function humanEditKey(issue){return state.task.id+':'+state.taskReview.review.snapshot_hash+':'+issue.id;}
function latestReviewDecision(issue){return(state.taskReview?.decisions||[]).map((decision,index)=>({decision,index})).filter(r=>r.decision.issue_id===issue.id).sort((a,b)=>(b.decision.created_at||'').localeCompare(a.decision.created_at||'')||b.index-a.index)[0]?.decision;}
function humanEdit(issue){const saved=latestReviewDecision(issue),local=state.humanEdits?.[humanEditKey(issue)];return !state.taskReview?.continued_to&&local||{choice:saved?.choice||'',note:saved?.note||'',reason_code:saved?.reason_code||'',claim_id:saved?.patch?.claim_id||issue.claims?.[0]?.id||'',patch:saved?.patch||null,dirty:false};}
function humanOperationSummary(edit){return ({EXCLUDE_CLAIM:'将排除当前候选，原文保留',AMEND_CLAIM:'将按所填字段修正候选并重新校验',RECHECK:'将保留候选并请求独立复核',KEEP_CONFLICT:'将保留冲突陈述，不自动选边'})[edit.choice]||'尚未选择处理方式';}
function evidenceContextMarkup(claim){
  const context=state.taskReview?.evidence_contexts?.[claim.id]||state.task?.evidence_contexts?.[claim.id],segments=context?.valid?context.segments:[];
  return segments.length?`<details class="review-evidence-context"><summary>查看上下文</summary><div class="evidence-context">${segments.map((s,i)=>`${i?'<p class="context-gap">…（中间内容省略）</p>':''}<div class="context-fragment">${escape(s.before)}${s.highlight?`<mark>${escape(s.highlight)}</mark>`:''}${escape(s.after)}</div>`).join('')}</div>${context.notice?`<p class="help">${escape(context.notice)}</p>`:''}</details>`:`<p class="help">${escape(context?.notice||'可从独立原文阅读页核对上下文。')}</p>`;
}
function humanEvidence(claim){
  const source=state.task.input.sources.find(s=>s.id===claim.source_id),context=state.taskReview?.evidence_contexts?.[claim.id]||state.task?.evidence_contexts?.[claim.id];
  return `<section class="review-candidate"><h3>${escape(entityName(claim.subject_id))} · ${escape(predicateName(claim.predicate_id))}</h3><p class="review-candidate-value">${escape(valueLabel(claim))}</p>${claim.scope?`<p class="help">范围：${escape(claim.scope)}</p>`:''}<blockquote>${escape(claim.quote)}</blockquote><p class="help">原文来源：${escape(source?.title||claim.source_id)}${context?.locator?' · '+escape(context.locator):''}</p>
    ${evidenceContextMarkup(claim)}
    ${source?button('打开完整原文','open-review-source','tiny',`data-id="${escape(claim.id)}"`):''}</section>`;
}
function sourceReaderPage(){
  const viewer=state.sourceViewer,claim=viewer?.claim||state.taskReview?.review?.candidate?.claims?.find(c=>c.id===viewer?.claim_id)||claimList().find(c=>c.id===viewer?.claim_id);
  const source=viewer?.source||state.task?.input.sources.find(s=>s.id===claim?.source_id);
  if(!viewer||(viewer.task_id!==state.task?.id&&!viewer.answer_snapshot)||!source||!claim)return blank('原文阅读位置已失效','请从当前任务的待核对事项重新打开。');
  const context=viewer.context||state.taskReview?.evidence_contexts?.[claim.id]||state.task?.evidence_contexts?.[claim.id];
  const valid=context?.valid!==false&&Number.isInteger(claim.start)&&Number.isInteger(claim.end)&&claim.start>=0&&claim.end>claim.start&&claim.end<=source.content.length&&source.content.slice(claim.start,claim.end)===claim.quote;
  const doc=source.parsing?.document_id,location=context?.locator;
  return head('原文阅读',escape(source.title))+`<div class="source-reader-tools">${button(viewer.return_view==='review'?'返回人工核对':'返回知识库','close-review-source','tiny')}${valid?button('定位证据','locate-review-quote','tiny'):''}${doc?`<a class="btn tiny" href="/api/documents/${escape(doc)}/original" target="_blank" rel="noopener">下载原件核对</a>`:''}<span class="help">${escape(location||'解析正文')} · 当前只读</span></div>
    <p class="help">这里显示完整解析正文。PDF/Word的排版可能与原件不同，可下载原件核对。</p>${!valid?'<p class="notice warning">引文位置与当前正文不一致，未猜测或自动替换位置。</p>':''}
    <article class="panel source-reader-text">${valid?escape(source.content.slice(0,claim.start))+`<mark id="source-evidence" tabindex="-1">${escape(claim.quote)}</mark>`+escape(source.content.slice(claim.end)):escape(source.content)}</article>`;
}
function groupEditKey(group){return state.task.id+':'+state.taskReview.review.snapshot_hash+':'+group.id;}
function hasUnsavedReviewEdits(){return(state.taskReview?.review?.issues||[]).some(i=>humanEdit(i).dirty)||(state.taskReview?.review?.groups||[]).some(g=>state.groupEdits?.[groupEditKey(g)]?.dirty);}
function humanGroupCard(group,index){
  const review=state.taskReview.review,issues=review.issues.filter(i=>group.issue_ids.includes(i.id)),edit=state.groupEdits?.[groupEditKey(group)]||{};
  const locked=group.issue_ids.some(id=>state.taskReview.locked_issue_ids?.includes(id));
  const claims=[...new Map(issues.flatMap(i=>i.claims||[]).map(c=>[c.id,c])).values()];
  return `<section class="panel"><h2>共同核对 ${index+1} · ${issues.length} 项</h2><p>${escape(group.explanation)}</p>${group.suggested_change?`<p class="help">建议：${escape(group.suggested_change)}</p>`:''}${claims.map(humanEvidence).join('')}<div class="field"><label>共同复核意见（可选）</label><textarea data-group-note="${escape(group.id)}" ${locked?'disabled':''} maxlength="2000">${escape(edit.note||'')}</textarea></div><p class="help">共同意见只请求重新复核，不会批准事实或覆盖逐项修改。</p>${button('保存共同复核意见','save-review-group','',`data-group="${escape(group.id)}" ${state.busy||locked?'disabled':''}`)}${button('放弃共同编辑','discard-review-group','tiny',`data-group="${escape(group.id)}"`)}<details><summary>查看并逐项处理 ${issues.length} 项</summary>${issues.map(issue=>humanReviewCard(issue,review.issues.indexOf(issue))).join('')}</details></section>`;
}
function ontologyRevisionPanel(){
  if(!state.task?.internal_scope)return '';
  const key=state.task.id+':'+state.taskReview.review.snapshot_hash,text=state.ontologyInstructions?.[key]||'';
  return `<section class="panel"><h2>补充业务定义，重新整理本体</h2><p>说明概念、范围或实体身份，AI 将据此重新构建并校验。资料原件保留，已有可用版本继续服务。</p><textarea data-ontology-instruction rows="3" maxlength="1000" aria-label="业务定义或身份说明">${escape(text)}</textarea><br>${button('确认定义并重新整理','revise-ontology','primary',state.busy||!text.trim()?'disabled':'')}</section>`;
}
function reviewAmendment(issue,edit,index){
  const claims=issue.claims||[],claim=claims.find(c=>c.id===edit.claim_id)||claims[0];if(!claim)return '<p class="help">当前事项没有可定位的候选声明，不能直接修正；请选择请求独立复核。</p>';
  const patch=edit.patch||{},value=Object.hasOwn(patch,'value')?patch.value:claim.value;
  const predicate=schema()?.predicates.find(p=>p.id===(patch.predicate_id||claim.predicate_id));
  const valueControl=predicate?.value_type==='ENTITY'?`<select data-human-field="value" data-human-index="${index}">${(schema()?.entities||[]).map(e=>`<option value="${escape(e.id)}" ${e.id===value?'selected':''}>${escape(e.name)}</option>`).join('')}</select>`:`<input data-human-field="value" data-human-index="${index}" ${predicate?.value_type==='NUMBER'?'type="number" step="any"':''} value="${escape(typeof value==='object'?JSON.stringify(value):value)}">`;
  return `<div class="review-amendment"><p class="help">只修正当前候选，不改写原始文件或原句。保存后还需要程序校验与独立复核。</p>${claims.length>1?`<div class="field"><label>选择要修正的候选</label><select data-human-field="claim_id" data-human-index="${index}">${claims.map(c=>`<option value="${escape(c.id)}" ${c.id===claim.id?'selected':''}>${escape(entityName(c.subject_id))} · ${escape(predicateName(c.predicate_id))} · ${escape(c.value)}</option>`).join('')}</select></div>`:''}<div class="field"><label>主体</label><select data-human-field="subject_id" data-human-index="${index}">${(schema()?.entities||[]).map(e=>`<option value="${escape(e.id)}" ${e.id===(patch.subject_id||claim.subject_id)?'selected':''}>${escape(e.name)}</option>`).join('')}</select></div><div class="field"><label>属性或关系</label><select data-human-field="predicate_id" data-human-index="${index}">${(schema()?.predicates||[]).map(p=>`<option value="${escape(p.id)}" ${p.id===(patch.predicate_id||claim.predicate_id)?'selected':''}>${escape(p.label)}</option>`).join('')}</select></div><div class="field"><label>候选值</label>${valueControl}</div><div class="field"><label>适用范围（未说明可留空）</label><input data-human-field="scope" data-human-index="${index}" value="${escape(Object.hasOwn(patch,'scope')?patch.scope:claim.scope||'')}"></div></div>`;
}
function humanReviewCard(issue,index){
  const edit=humanEdit(issue),saved=latestReviewDecision(issue),allowed=issue.allowed_choices||[],locked=Boolean(state.taskReview?.continued_to||state.taskReview?.locked_issue_ids?.includes(issue.id));
  return `<article class="panel human-review-card"><div class="panel-head"><h2>核对候选 ${index+1}</h2>${badge(edit.dirty?'有未保存的编辑':saved?'决定已保存':'尚未决定',saved&&!edit.dirty?'green':'yellow')}</div>
    <div class="human-review-candidates">${(issue.claims||[]).map(humanEvidence).join('')||'<p class="help">没有可直接定位的声明；不能据此补写事实，请结合原始资料确认。</p>'}</div>
    <div class="notice"><strong>AI复核意见（不是事实裁决）</strong><p>${escape(issue.explanation||'请核对候选与原文是否一致。')}</p>${issue.suggested_change?`<p class="help">建议：${escape(issue.suggested_change)}</p>`:''}</div>
    <fieldset class="review-decision-controls" ${locked?'disabled':''}><div class="field"><label>你希望如何处理？</label><select aria-label="候选处理方式" data-human-field="choice" data-human-index="${index}"><option value="">请选择，不自动批准</option>${allowed.filter(c=>humanChoiceLabels[c]).map(c=>`<option value="${c}" ${edit.choice===c?'selected':''}>${humanChoiceLabels[c]}</option>`).join('')}</select></div>${edit.choice==='AMEND_CLAIM'?reviewAmendment(issue,edit,index):''}
    ${edit.choice==='RECHECK'?`<div class="field"><label>复核原因（可选）</label><select aria-label="复核原因" data-human-field="reason_code" data-human-index="${index}"><option value="">仅请求复核，不补充原因</option>${Object.entries(humanReasonLabels).map(([key,label])=>`<option value="${key}" ${edit.reason_code===key?'selected':''}>${escape(label)}</option>`).join('')}</select></div>`:''}
    <div class="field"><label>补充说明（可选）</label><textarea aria-label="处理说明" data-human-field="note" data-human-index="${index}" maxlength="2000" placeholder="需要补充具体信息时再填写">${escape(edit.note)}</textarea></div><p class="help system-operation-summary">系统操作记录：${escape(humanOperationSummary(edit))}。此记录不代替用户理由。</p><p class="help">排除仅影响后续候选，不删除原文；保留候选也不会跳过独立复核。</p>${button(locked?'本组决定已锁定':'保存这项决定（仅本地）','save-human-decision','',`data-index="${index}" ${locked||state.busy||!edit.choice?'disabled':''}`)}${edit.dirty?button('放弃本项未保存编辑','discard-human-edit','tiny',`data-index="${index}"`):''}</fieldset><details><summary>高级：事项标识与定位</summary><pre>${escape(JSON.stringify({id:issue.id,code:issue.code,claim_ids:issue.claim_ids},null,2))}</pre></details></article>`;
}
function hasUnsavedComponentEdits(group){
  const issues=state.taskReview?.review?.issues||[];
  return group.issue_ids.some(id=>{const issue=issues.find(i=>i.id===id);return issue&&humanEdit(issue).dirty;})||(state.taskReview?.review?.groups||[]).some(g=>g.issue_ids.some(id=>group.issue_ids.includes(id))&&state.groupEdits?.[groupEditKey(g)]?.dirty);
}
function componentDecisionPanel(){
  const packet=state.taskReview,groups=packet.dependency_groups||[];
  if(packet.component_origin_task_id)return `<section class="panel"><h2>本组复核反馈</h2><p>需要调整时请返回原待核对事项，修改本组决定后重新提交。其他组的决定仍保留。</p>${button('返回原待核对事项','open-component-review','primary',`data-id="${escape(packet.component_origin_task_id)}"`)}</section>`;
  if(!groups.length)return '';
  const running=groups.some(g=>g.submission&&['QUEUED','RUNNING','FAILED','PAUSED','INTERRUPTED'].includes(g.submission.status));
  return `<section class="panel"><h2>按独立组继续</h2><p>保存本组全部决定后即可单独复核。已发布组的决定会锁定；其他组保存的决定不会提前应用。</p>${running?'<p class="help">请先处理或停止正在复核的组，再提交下一组。</p>':''}${groups.map((g,index)=>{
    const locked=g.submission&&['QUEUED','RUNNING','FAILED','PAUSED','INTERRUPTED'].includes(g.submission.status);
    return `<article class="source-card"><h3>第 ${index+1} 组 · ${g.predicate_ids.map(id=>escape(predicateName(id))).join('、')}</h3><p>${g.published?'本组已发布，决定已锁定':g.issue_ids.length+' 项 · 尚未保存 '+g.pending_count+' 项决定'}</p>${g.submission?.requires_unknown_resend_confirmation&&!g.published?`<label class="consent"><input id="component-unknown-${escape(g.id)}" type="checkbox"><span>上次本组调用的结果或计费未知，我允许再次发送。</span></label>`:''}${!g.published?button('校验并发布本组','continue-component','primary',`data-group="${escape(g.id)}" ${state.busy||hasUnsavedComponentEdits(g)||running||g.pending_count?'disabled':''}`):''}${g.submission?button('查看本组处理详情','task','tiny',`data-id="${escape(g.submission.task_id)}"`):''}${locked?button('停止本组复核','stop-component','tiny',`data-submission="${escape(g.submission.id)}"`):''}</article>`;
  }).join('')}</section>`;
}
function humanReviewPage(){
  const packet=state.taskReview,review=packet.review,pending=packet.pending_count,dirty=hasUnsavedReviewEdits(),local=review?.stage==='claims_review';
  if(packet.continued_to)return head('此快照已继续处理','这里保留原候选与已保存决定；后续修改请在新的任务版本进行。')+`<section class="panel"><h2>打开后续版本</h2><p>此快照不再接受新决定，也不会再次发起继续处理。</p>${button('打开后续版本','task','primary',`data-id="${escape(packet.continued_to)}"`)}</section>`+(review?.issues||[]).map(humanReviewCard).join('');
  return head('等待人工核对','候选与原文已经保留。你可以排除、修正、保留冲突或请求复核，不需要强制批准。')
    +(packet.component_release?.status==='PUBLISHED'?`<section class="panel"><h2>独立部分已经发布</h2><p>剩余争议可按独立组继续，当前可用版本会保留。</p>${button('查看当前可用版本','task','tiny',`data-id="${escape(packet.component_release.task_id)}"`)}</section>`:'')
    +componentDecisionPanel()
    +`<section class="panel"><h2>需要核对 ${review.issues.length} 项</h2><p>尚未保存决定：${pending} 项${dirty?' · 有尚未保存的修改':''}</p><p class="help">${local?(packet.dependency_groups?.length?'保存决定只写入本地，不调用模型；可按独立组继续，或全部处理后整体继续。':'保存决定只写入本地，不调用模型；全部处理后，仍需单独确认并“校验并继续”。'):state.task.internal_scope?'请在下方补充业务定义，确认后由 AI 重新整理并校验。':'请补充定义或资料，再创建修订草稿。'}</p>${button('刷新复核意见','refresh-human-review','tiny')}</section>`
    +(review.groups?review.groups.map((group,index)=>group.issue_ids.length>1?humanGroupCard(group,index):humanReviewCard(review.issues.find(i=>i.id===group.issue_ids[0]),review.issues.findIndex(i=>i.id===group.issue_ids[0]))).join(''):review.issues.map(humanReviewCard).join(''))
    +(!local?ontologyRevisionPanel():'')
    +`<section class="panel review-continue-panel"><h2>${local?'保存完毕后再继续':'需要调整知识定义或资料'}</h2><p>${local?'程序先校验局部修改，再进行独立复核。仍有问题会重新暂停，不将人工决定当作事实认证。':state.task.internal_scope?'请在上方补充业务定义并重新整理，AI 会生成新的候选版本并校验。':'当前不是声明复核阶段，不能直接使用局部声明续跑；请创建修订草稿，相关阶段可能重新计算。'}</p>${packet.requires_component_resend_confirmation?'<label class="consent"><input id="component-full-unknown" type="checkbox"><span>本次包含结果或计费未知的组，我允许再次发送。</span></label>':''}${local&&!packet.component_origin_task_id?button('校验并继续','continue-review','primary',state.busy||!packet.can_continue||pending!==0||dirty?'disabled':''):''}<details><summary>需要修改定义或补充资料？</summary><p>这会创建修订草稿，相关抽取与评审可能重新计算；不同于本页局部声明决定。</p>${button('修改定义或补充资料（修订草稿）','edit','tiny')}</details></section>`;
}
function changeHumanField(el){
  if(state.taskReview?.continued_to)return;
  if(state.taskReview?.locked_issue_ids?.includes(state.taskReview.review.issues[Number(el.dataset.humanIndex)]?.id))return;
  const index=Number(el.dataset.humanIndex),issue=state.taskReview?.review?.issues?.[index];if(!issue)return;
  const field=el.dataset.humanField,key=humanEditKey(issue),edit={...humanEdit(issue),dirty:true};
  if(field==='choice'&&edit.choice===el.value)return;
  if(field==='choice'){edit.choice=el.value;}else if(field==='note')edit.note=el.value;else if(field==='reason_code')edit.reason_code=el.value;else if(field==='claim_id'){edit.claim_id=el.value;edit.patch=null;}else{edit.patch={...(edit.patch||{}),[field]:el.value};}
  state.humanEdits??={};state.humanEdits[key]=edit;
  if(['choice','claim_id','predicate_id'].includes(field))render();else{const button=document.querySelector('[data-action="continue-review"]');if(button)button.disabled=true;document.querySelectorAll?.('[data-action="continue-component"]').forEach(b=>{const group=state.taskReview?.dependency_groups?.find(g=>g.id===b.dataset.group);if(group&&hasUnsavedComponentEdits(group))b.disabled=true;});}
}
function modelPage() {
  if(productEnabled())return productUi.modelsPage(state.productModels??{},state.busy);
  return head('设置','')+`<section class="panel settings"><div class="panel-head"><h2>模型连接</h2>${badge(state.boot?.configured?'已连接':'未连接',state.boot?.configured?'green':'')}</div><div class="field"><label for="model-url">接口地址</label><input id="model-url" value="${escape(state.boot?.base_url)}" placeholder="https://your-provider.example/v1"></div><div class="field"><label for="model-name">模型名称</label><input id="model-name" value="${escape(state.boot?.model)}"></div><div class="field"><label for="model-key">API 密钥</label><input type="password" id="model-key" autocomplete="off" placeholder="${state.boot?.configured?'留空保持当前连接':'输入模型服务的密钥'}"></div><details class="model-parameters"><summary>高级参数</summary><div class="field"><label for="model-max-tokens">最大输出 tokens</label><input id="model-max-tokens" type="number" min="1024" max="32768" value="${escape(state.boot?.max_tokens||8000)}"></div><div class="field"><label for="model-thinking">思考模式</label><select id="model-thinking"><option value="default" ${(state.boot?.thinking_mode||'default')==='default'?'selected':''}>服务商默认</option><option value="disabled" ${state.boot?.thinking_mode==='disabled'?'selected':''}>关闭</option><option value="enabled" ${state.boot?.thinking_mode==='enabled'?'selected':''}>开启</option></select></div></details><details class="model-parameters"><summary>本地模型与开发连接</summary><label class="consent"><input type="checkbox" id="insecure-http" ${state.boot?.allow_insecure_http?'checked':''}><span>允许 HTTP 连接（仅本地测试）</span></label></details><div class="build-action">${button('保存连接','save-model','primary',state.busy?'disabled':'')}</div><p class="help">用于资料整理与问答。</p><details class="key-help"><summary>密钥说明</summary><p class="help">密钥仅保存在本机服务内存，不写入配置文件；服务重启后需重新输入。</p></details></section><details class="panel"><summary>环境检查</summary>${environmentPanel()}</details>`;
}

function integrationForm(){const first=(state.boot?.knowledge_bases||[]).find(b=>b.current_task_id);return {name:'我的应用',library_id:first?.id||'',mode:'QUERY',...(state.integrationDraft||{})};}
function integrationsPage(){
  const form=integrationForm(),available=(state.boot?.knowledge_bases||[]).filter(b=>b.current_task_id),data=state.integrationData||{},issued=state.issuedIntegration;
  const config={mcpServers:{cqforge:{command:data.mcp?.command||'node',args:[...(data.mcp?.args||['web/mcp-stdio.mjs']),...((issued?.mode||form.mode)==='LEARN'?['--allow-learning']:[])],env:{CQFORGE_URL:data.mcp?.url||'http://127.0.0.1:4317',CQFORGE_ACCESS_TOKEN:'填写上方生成的接入凭证'}}}};
  return head('应用与 Agent 接入','每个接入仅连接一个知识库；默认查询，需要时才允许学习。')+
    `<section class="panel"><h2>创建接入</h2>${!available.length?'<p>先建立一个可查询知识库，再创建应用接入。</p>':''}<div class="field"><label for="integration-name">接入名称</label><input id="integration-name" data-integration-field="name" maxlength="80" value="${escape(form.name)}"></div><div class="field"><label for="integration-library">知识库</label><select id="integration-library" data-integration-field="library_id">${available.map(b=>`<option value="${escape(b.id)}" ${b.id===form.library_id?'selected':''}>${escape(b.name)}</option>`).join('')}</select></div><div class="field"><label for="integration-mode">允许的操作</label><select id="integration-mode" data-integration-field="mode"><option value="QUERY" ${form.mode==='QUERY'?'selected':''}>仅查询</option><option value="LEARN" ${form.mode==='LEARN'?'selected':''}>查询并学习</option></select></div><p class="help">查询模式不会扩图；学习模式按用户资料补充知识，冲突回到工作台处理。</p>${button('生成接入凭证','create-integration','primary',state.busy||!available.length?'disabled':'')}</section>`+
    (issued?`<section class="panel"><h2>请保存新接入凭证</h2><p>刷新后无法再次查看，不是模型 API 密钥。</p><textarea readonly aria-label="新接入凭证">${escape(issued.token)}</textarea>${button('已保存，隐藏凭证','hide-integration-token','tiny')}</section>`:'')+
    `<details class="panel"><summary>MCP 配置示例（stdio）</summary><p>将 command、args、env 填入支持 stdio 的 MCP 客户端，替换凭证占位符。查询默认不触发学习。</p><pre>${escape(JSON.stringify(config,null,2))}</pre></details><details class="panel"><summary>HTTP 调用</summary><p>使用 Bearer 接入凭证；每次请求携带稳定 request_id。重复发送原请求时复用该标识，不自动换新标识重试。</p><pre>${escape(JSON.stringify({url:(data.mcp?.url||'http://127.0.0.1:4317')+'/api/v1/knowledge-bases/'+form.library_id+'/query',headers:{Authorization:'Bearer 接入凭证'},body:{question:'你的问题',request_id:'填写一个 UUID'}},null,2))}</pre><p class="help">学习入口为 /learn，只有学习凭证允许使用；MCP 也需配置 --allow-learning。</p></details>`+
    `<section class="panel"><h2>已有接入</h2>${(data.items||[]).map(item=>`<article class="source-card"><h3>${escape(item.name)}</h3><p>${escape(available.find(b=>b.id===item.library_id)?.name||item.library_id)} · ${item.mode==='LEARN'?'查询并学习':'仅查询'} · ${item.revoked_at?'已撤销':'可用'}</p>${!item.revoked_at?button('撤销接入','revoke-integration','tiny',`data-id="${escape(item.id)}"`):''}</article>`).join('')||'<p>尚未创建接入。</p>'}<p class="help">仅连接本机服务。撤销会阻止后续接入请求，已启动的学习可在工作台停止。</p></section>`;
}
function budgetMeter(b){return b.max_calls===null?'本次操作：已调用 '+(b.used??'未知')+' 次 · 不限次数 · 可随时停止任务。':'最近授权批次：已用 '+(b.used??'未知')+' / '+(b.max_calls??'未知')+' 次 · 剩余 '+(b.remaining??'请刷新')+'。达到自定义上限后保存进度并暂停。';}
function operationStatus(){return (state.lastError?`<div class="notice warning error-banner" role="alert"><span>${escape(state.lastError)}</span>${button('关闭提示','dismiss-error','tiny')}</div>`:'')+(state.lastBudget&&['budget','run','queries'].includes(state.view)?`<div id="budget-meter" class="notice budget-meter">${escape(budgetMeter(state.lastBudget))}</div>`:'');}
function reviewTasks(){
  const base=state.boot?.knowledge_bases?.find(b=>b.task_ids?.includes(state.task?.id));
  const ids=base?new Set(base.task_ids):null;
  return (state.boot?.tasks||[]).filter(t=>(!ids||ids.has(t.id))&&(t.presentation?.category==='HUMAN_REVIEW'||!t.presentation&&['REVIEW_REQUIRED','WAITING_REVIEW'].includes(t.status))&&!t.continued_to&&!t.presentation?.continued_to&&!t.learning?.eligibility?.includes('EXCLUDED'));
}
const reviewContextKeys=['task','taskReview','taskIssues','taskDiagnostics','catalog','questionBacklog','askQuestion','askRevision','directAnswer','queryAnswers','selected','knowledgeMode','pendingLearning','view'];
function rememberReviewContext(){if(!state.reviewReturn)state.reviewReturn=Object.fromEntries(reviewContextKeys.map(k=>[k,state[k]]));}
function closeReviewDrawer(){
  state.reviewInbox=false;
  if(state.reviewReturn){Object.assign(state,state.reviewReturn);state.reviewReturn=null;
    const base=state.boot?.knowledge_bases?.find(b=>b.task_ids?.includes(state.task?.id)),stamp=state.task?.publication;
    if(stamp&&base&&(base.source_epoch!==stamp.source_epoch||base.review_hash!==stamp.review_hash)){state.directAnswer=null;state.queryAnswers={};state.answerEvidence=null;state.catalog=null;}
  }else if(state.view==='review')state.view='knowledge';
  render();document.querySelector('[data-action="open-review-inbox"]')?.focus?.();
}
function reviewDrawer(){
  if(!state.reviewInbox&&state.view!=='review')return '';
  const tasks=reviewTasks(),technical=state.view==='review'&&['SYSTEM_FAILURE','PAUSED_BUDGET'].includes(state.taskDiagnostics?.category||state.task?.presentation?.category);
  const content=state.view==='review'?reviewPage():`<div class="review-inbox"><p class="help">只在需要你判断时打扰你。</p>${tasks.length?tasks.map(t=>`<button class="review-inbox-item" data-action="review-item" data-id="${escape(t.id)}"><span>${escape(t.learning?.question||t.name||'知识整理')}<small>${escape(t.stage_label||'有候选内容需要核对')}${t.created_at?' · '+escape(new Date(t.created_at).toLocaleDateString('zh-CN')):''}</small></span><span aria-hidden="true">↗</span></button>`).join(''):'<div class="empty-state"><h3>当前没有待确认事项</h3><p>你可以继续提问或添加资料。</p></div>'}</div>`;
  return `<div class="review-drawer-layer"><button class="review-backdrop" data-action="close-review" aria-label="${technical?'关闭整理进度':'关闭待确认'}"></button><aside class="review-drawer" role="dialog" aria-modal="true" aria-labelledby="review-title"><header><div><span class="eyebrow">${technical?'已保留处理进度':'需要你的判断'}</span><h2 id="review-title">${technical?'整理进度':'待确认'}</h2></div>${button('关闭','close-review','tiny','id="review-close"')}</header><div class="review-drawer-body">${content}</div></aside></div>`;
}
function render() {
  if(productEnabled())state.productAutoGraphTransition=false;
  graphEpoch++;if(graphView){graphView.dispose();graphView=null;}
  const pages={overview,trash:trashPage,input:()=>revisionInput()+inputPage(),knowledge:knowledgePage,budget:budgetPage,run:()=>libraryVersions()+versionPanel()+runPage(),schema:schemaPage,graph:()=>versionPanel()+graphPage(),queries:queriesPage,review:reviewPage,source:sourceReaderPage,model:()=>productEnabled()?modelPage():modelPage()+`<details class="panel"><summary>诊断工具</summary><div class="actions">${button('运行记录','nav-run','tiny')}${button('结构化查询','nav-queries','tiny')}${button('本体契约','nav-schema','tiny')}</div></details>`+`<details class="panel"><summary>应用与 Agent 接入</summary>${button('管理应用接入','nav-integrations','tiny')}</details>`+graphSettingsPage(),integrations:integrationsPage};
  const nav=v=>`<button data-action="nav-${v}" class="${state.view===v?'active':''}" ${state.view===v?'aria-current="page"':''}><span class="nav-icon" aria-hidden="true">${icons[v]||icons.queries}</span>${labels[v]}</button>`;
  const inLibrary=(productEnabled()?!!(state.productLibraryId||state.productCreationPending):!!state.task)&&['knowledge','review','source'].includes(state.view),pending=productEnabled()?[]:reviewTasks();
  const modes=nativeEnabled()?[['native','知识构建',icons.run],['sources','资料',icons.input]]:[...(productEnabled()?[['processing','整理',icons.run]]:[]),['answers','问答',icons.queries],['graph','图谱',icons.graph],...(productEnabled()?[['scope','知识范围',icons.schema]]:[['ontology','本体',icons.schema]]),['sources','资料',icons.input]];
  const primary=inLibrary?`<nav class="library-navigation" aria-label="知识库视图">${modes.map(([mode,label,icon])=>`<button data-action="knowledge-${mode}" class="${(state.knowledgeMode||'answers')===mode?'active':''}" ${(state.knowledgeMode||'answers')===mode?'aria-current="page"':''}><span class="nav-icon">${icon}</span>${label}</button>`).join('')}</nav>`:`<nav aria-label="工作空间导航">${nav('overview')}${nav('input')}</nav>`;
  const content=state.view==='review'?knowledgePage():(pages[state.view]||overview)();
  root.innerHTML=`<div class="shell"><header class="app-header"><button class="brand" data-action="nav-overview" aria-label="LightOG 工作空间"><span class="brand-symbol" aria-hidden="true">✳</span>LightOG</button><span class="header-divider" aria-hidden="true">/</span><button class="workspace-switch" data-action="nav-overview" aria-label="切换知识库">${escape((productEnabled()?state.productView?.library?.name:state.boot?.knowledge_bases?.find(b=>b.task_ids?.includes(state.task?.id))?.name)||state.task?.input?.name||'我的知识空间')} <span aria-hidden="true">⌄</span></button><div class="header-actions">${pending.length?button('待确认 · '+pending.length,'open-review-inbox','review-trigger',`aria-label="${pending.length} 个任务待确认" ${state.busy?'disabled':''}`):''}${button('新建知识库','new','tiny')}${nav('model')}</div></header><div class="app-navigation">${primary}${inLibrary?`<div class="navigation-end">${button('添加资料','knowledge-sources','tiny')}</div>`:''}</div><main class="main ${state.view==='knowledge'&&state.knowledgeMode==='graph'?'main-graph':''} ${state.view==='knowledge'&&(!state.knowledgeMode||state.knowledgeMode==='answers')?'main-answers':''}">${operationStatus()}${content}</main></div>${productEnabled()?productUi.sourceEvidenceDrawer(state):answerEvidenceDrawer()+reviewDrawer()+libraryManagementDialog()}`;
  if(state.libraryManage){document.querySelector('.shell')?.setAttribute?.('inert','');(document.querySelector('#library-manage-name')||document.querySelector('#library-manage-cancel'))?.focus?.();}
  if(state.reviewInbox||state.view==='review'){document.querySelector('.shell')?.setAttribute?.('inert','');document.querySelector('#review-close')?.focus?.();}
  if(productEnabled()&&state.productEvidence!==null&&state.productEvidence!==undefined&&document.querySelector('#product-answer-evidence')){document.querySelector('.shell')?.setAttribute?.('inert','');document.querySelector('#product-evidence-close')?.focus?.();}
  if(state.answerEvidence&&state.view==='knowledge'&&document.querySelector('#answer-evidence-drawer')){document.querySelector('.shell')?.setAttribute?.('inert','');document.querySelector('#answer-evidence-close')?.focus?.();}
  syncWorkbenchLink();
  void mountGraphView();
  if(state.nativeDomainScrollToDetail){state.nativeDomainScrollToDetail=false;root.querySelector?.('[data-native-domain-inspector]')?.scrollIntoView?.({block:'nearest'});}
  if(state.view==='source')document.querySelector('#source-evidence')?.scrollIntoView?.({block:'center'});
}
async function loadTaskDetails() {
  if(!state.task)return;
  const id=state.task.id;
  const [diagnostics,issues,review]=await Promise.all([api('/api/tasks/'+id+'/diagnostics'),api('/api/tasks/'+id+'/issues'),api('/api/tasks/'+id+'/review')]);
  if(state.task?.id===id){state.taskDiagnostics=diagnostics;state.taskIssues=issues;state.taskReview=review?.review||review?.continued_to?review:null;}
}
async function loadBacklog(){if(!state.task)return;const id=state.task.id,data=await api('/api/tasks/'+id+'/question-backlog');if(state.task?.id===id)state.questionBacklog=Array.isArray(data?.items)?data.items:[];}
function recallLearningProgress(task){
  const base=state.boot?.knowledge_bases?.find(b=>b.task_ids.includes(task.id));
  const latest=state.boot?.tasks?.find(t=>t.id===base?.latest_task_id);
  const candidate=(task.learning||task.learning_resolution)&&['RUNNING','QUEUED','READY'].includes(task.status)?task:latest?.learning&&['RUNNING','QUEUED','READY'].includes(latest.status)?latest:null;
  if(!candidate)return;const question=(candidate.learning||candidate.learning_resolution).question;
  state.askQuestion=question;state.pendingLearning={task_id:candidate.id,origin_task_id:task.id,question,revision:state.askRevision||0,base_id:task.publication?.base_id||base?.id};
}
async function refreshBudget(id=state.lastBudget?.id){if(!id)return;try{const budget=await api('/api/budgets/'+id);if(budget?.id===id)state.lastBudget=budget;else if(state.lastBudget?.id===id)state.lastBudget={...state.lastBudget,used:null,remaining:null};}catch{if(state.lastBudget?.id===id)state.lastBudget={...state.lastBudget,used:null,remaining:null};}}
async function openTask(id,{restoreLearning=true}={}) {const oldBase=state.boot?.knowledge_bases?.find(b=>b.task_ids.includes(state.task?.id))?.id,nextBase=state.boot?.knowledge_bases?.find(b=>b.task_ids.includes(id))?.id;if(oldBase!==nextBase){state.librarySupplement=null;state.sourceReplacement=null;state.pendingLearning=null;}state.pendingLearning=null;state.revokePending=null;state.askRevision=(state.askRevision||0)+1;state.task=await api('/api/tasks/'+id);state.selected=null;state.queryAnswers={};state.versionDiff=null;state.catalog=null;state.questionBacklog=[];state.directAnswer=null;state.answerEvidence=null;state.askQuestion='';state.askConsent=false;state.taskDiagnostics=null;state.taskIssues=null;state.taskReview=null;state.knowledgeMode='answers';state.view='knowledge';if(restoreLearning)recallLearningProgress(state.task);if(state.task.status==='READY')state.catalog=await api('/api/tasks/'+id+'/capabilities');await Promise.all([loadTaskDetails(),loadBacklog()]);render();}
async function importFiles(files) {
  if(state.parsing)throw Error('正在解析，请稍后再上传');
  if(!productEnabled()&&state.draft.sources.length+files.length>8)throw Error('最多导入8份资料');
  invalidateProposal();
  state.parsing=true;state.busy=true;render();
  try { for(const f of files){
    if(/\.(pdf|docx)$/i.test(f.name)||(state.nativeCreate&&/\.md$/i.test(f.name))){
      if(f.size>20*1024*1024)throw Error('文件超过20MB');
      const response=await fetch('/api/documents',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-CQForge-Token':state.boot.token,'X-CQForge-Filename':encodeURIComponent(f.name)},body:f});
      const parsed=await response.json();if(!response.ok)throw Error(parsed.error||'解析失败');
      state.draft.sources.push({title:parsed.title,content:parsed.content,document_id:parsed.document_id,parsing:parsed});
    }else if(/\.(md|txt)$/i.test(f.name)){
      if(f.size>20*1024*1024)throw Error('文本文件超过20MB');state.draft.sources.push({title:f.name,content:await f.text()});
    }else throw Error('目前支持PDF、DOCX、TXT、MD；旧DOC请另存DOCX');
  }}finally{state.parsing=false;state.busy=false;await persistWorkspaceDraft();render();}
}
async function importLibraryFile(files){
  const file=files?.[0];if(!file)return;if(state.busy)throw Error('请等待当前操作完成');
  if(files.length!==1||file.size>20*1024*1024)throw Error('每次添加一份不超过20MB的资料');
  const taskId=state.task?.id,libraryId=state.productLibraryId;state.parsing=true;state.busy=true;render();
  try{let source;
    if(/\.(pdf|docx)$/i.test(file.name)){
      const response=await fetch('/api/documents',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-CQForge-Token':state.boot.token,'X-CQForge-Filename':encodeURIComponent(file.name)},body:file});
      const parsed=await response.json();if(!response.ok)throw Error(parsed.error||'解析失败');source={title:parsed.title,content:parsed.content,document_id:parsed.document_id};
    }else if(/\.(md|txt)$/i.test(file.name))source={title:file.name,content:await file.text()};
    else throw Error('支持PDF、DOCX、TXT、MD');
    if(productEnabled()?state.productLibraryId===libraryId:state.task?.id===taskId)state.librarySupplement=source;
  }finally{state.parsing=false;state.busy=false;render();}
}
document.addEventListener('input', event=>{const el=event.target;if(el.dataset&&Object.hasOwn(el.dataset,'nativeWorkbenchSearch')){state.nativeWorkbenchQuery??={};state.nativeWorkbenchQuery[el.dataset.stage??state.nativeWorkbenchStage??'knowledge']=el.value;refreshNativeWorkbench();return;}if(nativeGraphUi&&state.nativeGraph?.domain_graph&&el.dataset&&(Object.hasOwn(el.dataset,'nativeDomainSearch')||Object.hasOwn(el.dataset,'nativeKnowledgeSearch'))){const entities=Object.hasOwn(el.dataset,'nativeDomainSearch'),list=root.querySelector?.(entities?'[data-native-domain-entities]':'[data-native-domain-knowledge]');if(list)list.innerHTML=entities?nativeGraphUi.nativeDomainEntityList(state.nativeGraph,el.value,{selected:state.nativeDomainSelected}):nativeGraphUi.nativeDomainKnowledgeList(state.nativeGraph,el.value,{selected:state.nativeDomainSelected});return;}if(productEnabled()&&el.dataset?.productReviewReason){state.productReviewReasons??={};state.productReviewReasons[el.dataset.productReviewReason]=el.value;return;}if(el.id==='library-manage-name'&&state.libraryManage){const m=state.libraryManage,control=document.querySelector('[data-action="confirm-library-manage"]');if(control)control.disabled=state.busy||(m.action==='purge'?el.value!==m.name:!el.value.trim()||[...el.value.trim()].length>100);return;}if(el.dataset?.integrationField){state.integrationDraft||=integrationForm();state.integrationDraft[el.dataset.integrationField]=el.value;return;}if(el.dataset?.groupNote){const group=state.taskReview?.review?.groups?.find(g=>g.id===el.dataset.groupNote);if(group){state.groupEdits||={};state.groupEdits[groupEditKey(group)]={note:el.value,dirty:true};const control=document.querySelector('[data-action="continue-review"]');if(control)control.disabled=true;}return;}if(el.dataset&&Object.hasOwn(el.dataset,'ontologyInstruction')){const key=state.task.id+':'+state.taskReview.review.snapshot_hash;state.ontologyInstructions||={};state.ontologyInstructions[key]=el.value;const control=document.querySelector('[data-action="revise-ontology"]');if(control)control.disabled=state.busy||!el.value.trim();return;}if(el.dataset?.libraryField){state.librarySupplement||={};state.librarySupplement[el.dataset.libraryField]=el.value;return;}if(el.dataset?.humanField){changeHumanField(el);return;}if((el.dataset.field&&el.dataset.field!=='consent')||el.dataset.sourceTitle!==undefined||el.dataset.sourceContent!==undefined)invalidateProposal();if(el.dataset.field)state.draft[el.dataset.field]=el.type==='checkbox'?el.checked:el.value;if(el.dataset.sourceTitle!==undefined)state.draft.sources[Number(el.dataset.sourceTitle)].title=el.value;if(el.dataset.sourceContent!==undefined)state.draft.sources[Number(el.dataset.sourceContent)].content=el.value;if(el.dataset.proposalChoice){state.proposalSelected=(state.proposalSelected||[]).filter(id=>id!==el.dataset.proposalChoice);if(el.checked)state.proposalSelected.push(el.dataset.proposalChoice);}if(el.dataset.clarification){state.proposalAnswers??={};state.proposalAnswers[el.dataset.clarification]=el.value;}if(el.id==='ask-question')changeAskQuestion(el);if(el.id==='ask-consent')state.askConsent=el.checked;if(el.dataset.field||el.dataset.sourceTitle!==undefined||el.dataset.sourceContent!==undefined||el.dataset.proposalChoice||el.dataset.clarification)scheduleDraftSave();});
document.addEventListener('change',async event=>{if(event.target.id==='native-browse-run'){try{state.nativeBrowseRunId=event.target.value;await refreshNativeRun();render();}catch(error){toast(error.message);}return;}if(event.target.id==='native-organization-draft-origin'){state.nativeOrganizationDraftOrigin=event.target.value;state.nativeOrganizationDraftConfirmation=null;render();return;}if(event.target.id==='native-organization-draft-ack'){state.nativeOrganizationDraftConfirmation=event.target.checked?nativeOrganizationDraftCandidate()?.unknown_acknowledgement_ref:null;const control=document.querySelector('[data-action="native-reuse-organization-draft"]');if(control)control.disabled=!nativeCanReuseOrganizationDraft();return;}if(event.target.id==='native-semantic-recovery-origin'){state.nativeRecoveryOrigin=event.target.value;state.nativeRecoveryConfirmation=null;render();return;}if(event.target.id==='native-semantic-recovery-ack'){state.nativeRecoveryConfirmation=event.target.checked?nativeSemanticRecoveryCandidate()?.unknown_acknowledgement_ref:null;const control=document.querySelector('[data-action="native-recover-semantic"]');if(control)control.disabled=!nativeCanRecoverSemantic();return;}if(event.target.id==='native-stop-after'){state.nativeStopAfter=event.target.value;render();return;}if(event.target.id==='native-query-view'){state.nativeQueryView=event.target.value;state.nativeQueryResult=null;state.nativeGraph=null;return;}if(event.target.id==='native-capability'){state.nativeCapability=event.target.value;const control=document.querySelector('[data-action="native-reuse-cq-family"]');if(control)control.disabled=!nativeCanReuse(event.target.value);const recovery=document.querySelector('[data-action="native-recover-semantic"]');if(recovery)recovery.disabled=!nativeCanRecoverSemantic(event.target.value);const draft=document.querySelector('[data-action="native-reuse-organization-draft"]');if(draft)draft.disabled=!nativeCanReuseOrganizationDraft(event.target.value);return;}if(event.target.dataset?.integrationField){state.integrationDraft||=integrationForm();state.integrationDraft[event.target.dataset.integrationField]=event.target.value;return;}if(event.target.dataset?.humanField){changeHumanField(event.target);return;}if(event.target.id==='library-file-picker'){try{await importLibraryFile(event.target.files);}catch(e){toast(e.message);}return;}if(event.target.id==='file-picker')try{await importFiles(event.target.files);}catch(e){toast(e.message);}if(event.target.id==='capability-select'){state.capabilityId=event.target.value;render();}if(event.target.id==='semantic-row'){state.semanticRowIndex=event.target.value===''?null:Number(event.target.value);render();}});
document.addEventListener('dragover',event=>{if(event.target.closest('#dropzone'))event.preventDefault();});
document.addEventListener('drop',async event=>{if(event.target.closest('#dropzone')){event.preventDefault();try{await importFiles(event.dataTransfer.files);}catch(e){toast(e.message);}}});
document.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)&&event.target.matches('[role=button][data-action]')){event.preventDefault();event.target.click();}});
async function handleClick(event){const el=event.target.closest('[data-action]');if(!el||el.disabled)return;const action=el.dataset.action,directNativeAction=/^native-(?:workbench-|artifacts-|chunk-kind|domain-)/.test(action)||nativeWorkbenchUi&&['native-semantic-read','native-semantic-next'].includes(action);if(state.busy&&action!=='cancel')return;let budgetId=null,budgetTaskId=null,confirmUnknown=false;try{
  state.lastError=null;
  if(productEnabled()&&state.productInitialBuild&&(action.startsWith('nav-')||['knowledge-answers','knowledge-graph','knowledge-candidate','knowledge-sources','knowledge-scope','new','product-library'].includes(action)))state.productInitialBuild.auto_open=false;
  if(productEnabled()&&await handleProductAction(action,el))return;
  const automaticBuild=action==='build'&&state.boot?.product_flow==='knowledge_m1'&&!state.draft.parent_id;
  const automaticAsk=action==='ask-question'&&state.boot?.product_flow==='knowledge_m1'&&state.task?.internal_scope===true;
  const automaticReview=action==='continue-review'&&state.task?.internal_scope===true;
  const automaticResume=action==='resume-task'&&state.task?.internal_scope===true;
  if(automaticResume&&state.taskDiagnostics?.requires_unknown_resend_confirmation){if(!document.querySelector('#unknown-resend-consent')?.checked)throw Error('上次远端结果未知，请先确认是否再次发送');confirmUnknown=true;}
  if(guardedActions.has(action)&&!automaticBuild&&!automaticAsk&&!automaticReview&&!automaticResume){
    if(!state.approvedBudget||state.approvedBudget.action!==action){state.busy=true;await prepareBudget(action);return;}
    ({id:budgetId,taskId:budgetTaskId,confirmUnknown}=state.approvedBudget);state.approvedBudget=null;
  }
  if(action==='confirm-budget'){
    const p=state.pendingBudget;if(!p)throw Error('没有待确认操作。');
    if(p.fingerprint!==budgetFingerprint(p.action))throw Error('资料、问题或版本已变化，请重新预览。');
    if(!document.querySelector('#budget-consent').checked)throw Error('请先核对发送清单并明确授权。');
    const rawCalls=document.querySelector('#budget-max-calls').value.trim(),maxCalls=rawCalls===''?null:Number(rawCalls);if(maxCalls!==null&&(!Number.isSafeInteger(maxCalls)||maxCalls<1))throw Error('调用上限请留空（不限次数）或填写正整数。');
    state.busy=true;
    const budget=await api('/api/budgets',{preview_id:p.preview.preview_id,max_calls:maxCalls,auto_repair:document.querySelector('#budget-auto-repair').checked,consent:true});
    state.approvedBudget={action:p.action,id:budget.id,taskId:p.taskId,confirmUnknown:p.confirmUnknown};state.lastBudget=budget;
    state.pendingBudget=null;state.view=p.from;state.draft.consent=true;if(p.action==='ask-question')state.askConsent=true;state.busy=false;
    await handleClick({target:{closest:()=>({dataset:{action:p.action},disabled:false})}});return;
  }
  if(action==='cancel-budget'){state.view=state.pendingBudget?.from||'input';state.pendingBudget=null;render();return;}
  if(action==='dismiss-error'){state.lastError=null;render();return;}
  if(action==='continue-workspace-draft'){state.view='input';render();return;}
  if(action==='save-workspace-draft'){await persistWorkspaceDraft();render();return;}
  if(action==='discard-workspace-draft'){state.discardDraftPending=true;render();return;}
  if(action==='cancel-discard-draft'){state.discardDraftPending=false;render();return;}
  if(action==='confirm-discard-draft'){await clearWorkspaceDraft();state.discardDraftPending=false;state.view='input';render();return;}
  if(state.parsing&&['new','sample','build','edit','upload'].includes(action))throw Error('文档正在解析，请稍后再操作');
  if(action==='show-trash'){state.trashItems=(await api('/api/trash')).items;state.view='trash';render();return;}
  if(['manage-rename','manage-trash','manage-purge'].includes(action)){const base=[...(state.boot?.knowledge_bases||[]),...(state.trashItems||[])].find(b=>b.id===el.dataset.base);if(!base)throw Error('知识库已变化，请刷新');state.libraryManage={id:base.id,name:base.name,action:action.slice(7)};render();return;}
  if(action==='close-library-manage'){state.libraryManage=null;render();return;}
  if(action==='confirm-library-manage'){
    const m=state.libraryManage;if(!m)throw Error('没有待处理的知识库');
    const value=document.querySelector('#library-manage-name')?.value;
    if(m.action==='purge'&&value!==m.name)throw Error('请输入完整知识库名称');
    state.busy=true;await api('/api/knowledge-bases/'+m.id+'/'+m.action,m.action==='rename'?{name:value}:m.action==='purge'?{confirm_name:value}:{});
    const affected=state.boot?.knowledge_bases?.find(b=>b.id===m.id)?.task_ids||[];
    if(m.action!=='rename'){if(affected.includes(state.task?.id)){state.task=null;state.directAnswer=null;state.pendingLearning=null;state.answerEvidence=null;state.reviewReturn=null;state.view='overview';}if(affected.includes(state.draft.parent_id)){state.draft={name:'',cqs:'',definitions:'',as_of:'',sources:[],consent:false};}state.reviewInbox=false;}
    state.boot=await api('/api/bootstrap');state.libraryManage=null;if(m.action==='purge'){state.trashItems=(await api('/api/trash')).items;state.view='trash';}
    state.busy=false;render();toast(m.action==='rename'?'名称已更新':m.action==='purge'?'知识库已彻底删除':'已移入回收站');return;
  }
  if(action==='restore-library'){state.busy=true;await api('/api/knowledge-bases/'+el.dataset.base+'/restore',{});state.boot=await api('/api/bootstrap');state.trashItems=(await api('/api/trash')).items;state.busy=false;render();toast('已恢复；学习与应用接入保持停用');return;}
  if(action==='open-review-inbox'){if(state.busy)return;state.reviewInbox=true;render();return;}
  if(action==='close-review'){closeReviewDrawer();return;}
  if(action==='review-item'){rememberReviewContext();await openTask(el.dataset.id,{restoreLearning:false});state.reviewInbox=false;state.view='review';render();return;}
  if(action==='nav-review')rememberReviewContext();else if(action.startsWith('nav-')||['task','new'].includes(action)){state.reviewReturn=null;state.reviewInbox=false;}
  if(action.startsWith('nav-')||['task','new','sample','edit'].includes(action))window.scrollTo(0,0);
  if(action.startsWith('nav-')){state.view=labels[action.slice(4)]?action.slice(4):'overview';if(['queries','graph'].includes(state.view)){state.knowledgeMode=state.view==='graph'?'graph':'answers';state.view='knowledge';}if(state.view==='knowledge'&&state.task?.status==='READY')state.catalog=await api('/api/tasks/'+state.task.id+'/capabilities');if(state.view==='review')await loadTaskDetails();if(state.view==='integrations'){state.busy=true;state.integrationData=await api('/api/integrations');}if(productEnabled()&&state.view==='model')state.productModels=await api('/api/product/models');render();}
  else if(['knowledge-answers','knowledge-ontology','knowledge-graph','knowledge-candidate','knowledge-sources','knowledge-processing','knowledge-scope'].includes(action)){state.view='knowledge';state.reviewInbox=false;state.knowledgeMode=action==='knowledge-scope'?'scope':action==='knowledge-processing'?'processing':action==='knowledge-graph'?'graph':action==='knowledge-candidate'?'candidate':action==='knowledge-sources'?'sources':action==='knowledge-ontology'?'ontology':'answers';render();}
  else if(action==='pick-library-file'){document.querySelector('#library-file-picker').click();}
  else if(action==='create-integration'){state.busy=true;state.issuedIntegration=await api('/api/integrations',integrationForm());state.integrationData=await api('/api/integrations');render();}
  else if(action==='hide-integration-token'){state.issuedIntegration=null;render();}
  else if(action==='revoke-integration'){state.busy=true;await api('/api/integrations/'+el.dataset.id+'/revoke',{});if(state.issuedIntegration?.id===el.dataset.id)state.issuedIntegration=null;state.integrationData=await api('/api/integrations');render();}
  else if(action==='add-library-source'){
    const base=state.boot?.knowledge_bases?.find(b=>b.task_ids.includes(state.task.id));if(!base)throw Error('请打开知识库');
    const source=state.librarySupplement||{};if(!source.title?.trim()||!source.content?.trim())throw Error('请提供资料标题和正文');
    state.busy=true;const replacement=state.sourceReplacement;if(replacement&&replacement.base!==base.id)throw Error('替换目标已变化，请重新选择资料');const response=await api('/api/knowledge-bases/'+base.id+'/sources'+(replacement?'/'+replacement.key+'/replace':''),{source});
    state.sourceReplacement=null;state.directAnswer=null;state.answerEvidence=null;state.queryAnswers={};state.catalog=null;state.task=await api('/api/tasks/'+state.task.id);
    state.librarySupplement=null;state.boot=await api('/api/bootstrap');state.knowledgeMode='answers';
    if(response.learning_task_id&&response.status==='LEARNING'){state.askQuestion=response.question;state.askRevision=(state.askRevision||0)+1;state.pendingLearning={task_id:response.learning_task_id,origin_task_id:state.task.id,question:response.question,revision:state.askRevision,base_id:base.id};}
    render();
  }
  else if(action==='replace-library-source'){const base=state.boot?.knowledge_bases?.find(b=>b.id===el.dataset.base),source=base?.sources.find(s=>s.key===el.dataset.key&&s.active);if(!source)throw Error('来源已变化，请刷新');state.sourceReplacement={base:base.id,key:source.key};state.librarySupplement={title:source.title,content:''};render();}
  else if(action==='cancel-source-replacement'){state.sourceReplacement=null;state.librarySupplement=null;render();}
  else if(action==='stop-source-update'){await api('/api/knowledge-bases/'+el.dataset.base+'/source-updates/'+el.dataset.update+'/stop',{});state.boot=await api('/api/bootstrap');render();}
  else if(action==='revoke-source'){state.revokePending={base:el.dataset.base,key:el.dataset.key};render();}
  else if(action==='cancel-revoke-source'){state.revokePending=null;render();}
  else if(action==='confirm-revoke-source'){const p=state.revokePending;if(!p)throw Error('没有待移出的资料');await api('/api/knowledge-bases/'+p.base+'/sources/'+p.key+'/revoke',{});state.revokePending=null;state.directAnswer=null;state.answerEvidence=null;state.queryAnswers={};state.boot=await api('/api/bootstrap');state.task=await api('/api/tasks/'+state.task.id);state.catalog=null;render();}
  else if(action==='stop-learning'){if(!state.pendingLearning)throw Error('没有正在整理的任务');await api('/api/tasks/'+state.pendingLearning.task_id+'/cancel',{});state.boot=await api('/api/bootstrap');render();}
  else if(action==='environment'){state.environment=await api('/api/environment');render();}
  else if(action==='new'){if(state.draft.parent_id){state.draft={name:'',cqs:'',definitions:'',as_of:'',sources:[],consent:false};await restoreWorkspaceDraft();}if(hasDraftContent()){state.view='input';toast('已打开未完成草稿；如需重新开始，请先明确清空。');}else{invalidateProposal();state.draft={name:'',cqs:'',definitions:'',as_of:'',sources:[],consent:false};state.view='input';}render();}
  else if(action==='sample'){if(hasDraftContent())throw Error('请先保存并继续现有草稿，或明确清空后再载入示例。');invalidateProposal();const sample=await api('/api/sample');state.draft={...sample,cqs:sample.cqs.join('\n'),as_of:'',consent:false};state.view='input';render();}
  else if(action==='upload')document.querySelector('#file-picker').click();
  else if(action==='add-source'){if(!productEnabled()&&state.draft.sources.length>=8)throw Error('最多8份资料');invalidateProposal();state.draft.sources.push({title:'粘贴资料 '+(state.draft.sources.length+1),content:''});render();}
  else if(action==='remove-source'){invalidateProposal();state.draft.sources.splice(Number(el.dataset.index),1);render();}
  else if(action==='open-component-review'){rememberReviewContext();await openTask(el.dataset.id,{restoreLearning:false});state.view='review';render();}
  else if(action==='task')await openTask(el.dataset.id,{restoreLearning:el.dataset.history!=='true'});
  else if(action==='edit'||action==='resume-draft'){if(!state.task)throw Error('请先选择任务');invalidateProposal();restoreDraft(state.task);}
  else if(action==='save-draft'){state.busy=true;const draft=await saveRevision();state.boot=await api('/api/bootstrap');await openTask(draft.id);toast('修订草稿已保存；没有调用模型');}
  else if(action==='build'){if(!state.boot.configured){throw Error('请先在模型设置中连接模型；当前输入已保留');}if(!automaticBuild&&!state.draft.consent)throw Error('请勾选资料发送授权');state.busy=true;let task;
    if(!automaticBuild&&state.proposal&&state.proposal.status!=='CONFIRMED')throw Error('请先确认或放弃CQ建议');
    if(!automaticBuild&&state.proposal&&state.proposalFingerprint!==proposalFingerprint()){invalidateProposal();throw Error('输入已变化，请重新确认CQ范围');}
    if(automaticBuild){const payload=draftPayload(),fingerprint=JSON.stringify(payload);if(state.buildAttempt?.fingerprint!==fingerprint)state.buildAttempt={fingerprint,id:crypto.randomUUID()};task=await api('/api/knowledge-build',{...payload,consent:true,request_id:state.buildAttempt.id});}
    else if(state.draft.parent_id){task=budgetTaskId?{id:budgetTaskId}:await saveRevision();await api('/api/tasks/'+task.id+'/start',{consent:true,budget_id:budgetId});}
    else task=await api('/api/tasks',{...draftPayload(),...(state.proposal?{proposal_id:state.proposal.id}:{}),consent:true,budget_id:budgetId});
    state.boot=await api('/api/bootstrap');state.task=await api('/api/tasks/'+task.id);if(!state.draft.parent_id)await clearWorkspaceDraft();state.queryAnswers={};state.taskIssues=null;state.taskDiagnostics=null;state.taskReview=null;await loadTaskDetails();state.knowledgeMode='answers';state.view='knowledge';render();}
  else if(action==='connect-graph'){state.busy=true;const password=document.querySelector('#graph-password');try{await api('/api/graph/connect',{uri:document.querySelector('#graph-uri').value.trim(),database:document.querySelector('#graph-database').value.trim(),username:document.querySelector('#graph-user').value.trim(),password:password.value});}finally{password.value='';}state.boot=await api('/api/bootstrap');render();toast('Neo4j 已连接；既有版本可手动同步');}
  else if(action==='disconnect-graph'){await api('/api/graph/disconnect',{});state.boot=await api('/api/bootstrap');state.queryAnswers={};render();}
  else if(action==='sync-graph'){state.busy=true;await api('/api/tasks/'+state.task.id+'/sync',{});state.task=await api('/api/tasks/'+state.task.id);state.boot=await api('/api/bootstrap');render();toast('本版本已同步；重复同步不会新增相同节点');}
  else if(action==='query'){state.queryBackend=document.querySelector('#query-backend')?.value||'SQLITE';state.busy=true;const answer=await api('/api/tasks/'+state.task.id+'/query',{cq_id:el.dataset.cq,backend:state.queryBackend});state.queryAnswers??={};state.queryAnswers[el.dataset.cq]=answer;render();}
  else if(action==='propose-cqs'){if(state.draft.parent_id)throw Error('修订暂不支持CQ扩展');state.busy=true;const before=proposalFingerprint();const proposal=await api('/api/cq-proposals',{...draftPayload(),consent:true,budget_id:budgetId});if(before!==proposalFingerprint())throw Error('生成期间输入发生变化，请重新生成建议');state.proposal=proposal;state.proposalSelected=[];state.proposalAnswers={};state.proposalFingerprint=null;}
  else if(action==='discard-proposal'){invalidateProposal();render();}
  else if(action==='confirm-proposal'){if(!state.proposal||state.proposal.status!=='PROPOSED')throw Error('请先生成建议');state.busy=true;const id=state.proposal.id,before=proposalFingerprint();const confirmed=await api('/api/cq-proposals',{action:'confirm',id,selected_ids:state.proposalSelected||[],clarification_answers:state.proposalAnswers||{}});if(!state.proposal||state.proposal.id!==id||before!==proposalFingerprint())throw Error('确认期间输入发生变化，请重新生成建议');state.proposal={...state.proposal,status:'CONFIRMED'};state.draft.cqs=confirmed.input.cqs.map(q=>q.question).join('\n');state.draft.definitions=confirmed.input.definitions;state.draft.consent=false;state.proposalFingerprint=proposalFingerprint();}
  else if(action==='load-capabilities'){state.catalog=await api('/api/tasks/'+state.task.id+'/capabilities');render();}
  else if(action==='ask-question'){if(!state.askQuestion?.trim())throw Error('请填写问题');const question=state.askQuestion,taskId=state.task.id,revision=state.askRevision||0;state.busy=true;state.answerPending=true;state.answerDraft=null;state.answerWasRevised=false;state.askProgress='正在理解问题…';state.askConsent=false;state.directAnswer=null;state.answerEvidence=null;render();const askFingerprint=JSON.stringify([taskId,question,revision]);if(automaticAsk&&state.askAttempt?.fingerprint!==askFingerprint)state.askAttempt={fingerprint:askFingerprint,id:crypto.randomUUID()};const base=automaticAsk&&state.boot.knowledge_bases?.find(b=>b.task_ids.includes(taskId));const answer=await streamAsk(base?'/api/knowledge-bases/'+base.id+'/ask':'/api/tasks/'+taskId+'/ask',{question,consent:true,backend:'SQLITE',budget_id:budgetId,...(automaticAsk?{request_id:state.askAttempt.id}:{})},(event,data)=>{
 if(state.task?.id!==taskId||state.askQuestion!==question||(state.askRevision||0)!==revision)return;
 if(event==='progress')state.askProgress=data.message;
 if(event==='answer_reset'){state.answerDraft=null;if(data.reason==='revision')state.answerWasRevised=true;state.answerEvidence=null;}
 if(event==='answer_delta'){state.answerDraft||={task_id:taskId,question,text:'',shown:''};state.answerDraft.text+=data.text;renderDraftSoon();return;}
 if(event==='sources'){state.directAnswer={status:'PREVIEW',answer:{...data.answer,answer_mode:'SOURCE_PREVIEW'},request_context:{question,task_id:data.task_id}};state.answerEvidence=null;}
 if(event==='answer_block'){if(data.index===0){state.directAnswer={status:'ANSWERING',answer:{answer_mode:'SYNTHESIS',synthesis:{blocks:[],gaps:[]},evidence_index:data.evidence_index,snapshot:data.snapshot},request_context:{question,task_id:data.task_id}};state.answerEvidence=null;}state.directAnswer.answer.synthesis.blocks[data.index]=data.block;}
 if(event==='error'){state.answerDraft=null;state.directAnswer=null;state.answerEvidence=null;}
 if(event!=='result')render();
});if(state.task?.id===taskId&&state.askQuestion===question&&(state.askRevision||0)===revision){if(answer.status!=='LEARNING')state.pendingLearning=null;state.directAnswer={...answer,request_context:{question,task_id:answer.task_id||taskId}};finishAnswerDraft();if(answer.learning_task_id&&answer.status==='LEARNING'){state.pendingLearning={task_id:answer.learning_task_id,origin_task_id:taskId,question,revision,base_id:base.id};state.boot=await api('/api/bootstrap');}}else toast('原问题或任务版本已变化，未将旧响应套用到当前问题');}
  else if(action==='execute-capability'){const c=state.catalog?.capabilities.find(c=>c.id===document.querySelector('#capability-select').value);if(!c)throw Error('请先载入查询能力');const raw=document.querySelector('#typed-object').value.trim();let value=raw||null;if(raw&&c.predicate.value_type==='NUMBER'){value=Number(raw);if(!Number.isFinite(value))throw Error('目标必须是有效数值');}const params={object_value:value};if(c.parameters.includes('subject_id'))params.subject_id=document.querySelector('#typed-subject').value;if(c.parameters.includes('subject_ids'))params.subject_ids=Array.from(document.querySelector('#typed-subjects').selectedOptions,o=>o.value);const taskId=state.task.id;state.busy=true;const answer=await api('/api/tasks/'+taskId+'/execute',{capability_id:c.id,params,backend:'SQLITE'});if(state.task?.id===taskId)state.directAnswer={...answer,request_context:{capability_id:c.id,params,task_id:taskId}};}
  else if(action==='answer-evidence'){state.answerEvidence=el.dataset.statementId;render();}
  else if(action==='close-answer-evidence')closeAnswerEvidence();
  else if(action==='answer-source'){
    const answer=state.directAnswer?.answer,e=answer?.evidence_index?.[el.dataset.claimId];if(!e)throw Error('回答证据不存在');
    const snapshotTask=answer.snapshot.task_id===state.task?.id?state.task:await api('/api/tasks/'+answer.snapshot.task_id);
    const source=snapshotTask.input.sources.find(s=>s.id===e.source_id&&s.sha256===e.source_sha256);if(!source)throw Error('无法取得回答时的资料版本，未改用其他版本');
    state.sourceViewer={task_id:answer.snapshot.task_id,claim_id:e.claim_id,claim:{...e,id:e.claim_id},source,context:e.context,answer_snapshot:true,return_view:'knowledge',back_scroll:window.scrollY||0};state.answerEvidence=null;state.view='source';render();
  }
  else if(action==='use-question'){const q=state.task?.input.cqs[Number(el.dataset.index)];if(!q)throw Error('问题不存在');state.askQuestion=q.question;state.askRevision=(state.askRevision||0)+1;state.directAnswer=null;state.answerEvidence=null;render();document.querySelector('#ask-question')?.focus?.();}
  else if(action==='save-backlog'){const taskId=state.task?.id,question=state.directAnswer?.request_context?.question||state.askQuestion;if(!taskId||!question?.trim())throw Error('没有可保存的问题。');state.busy=true;const saved=await api('/api/tasks/'+taskId+'/question-backlog',{question:question.trim()});if(state.task?.id===taskId){const item=saved.item||saved;state.questionBacklog=[...(state.questionBacklog||[]).filter(i=>i.id!==item.id&&i.question!==item.question),item];}render();toast('问题已保存，尚未扩展知识库，也未调用模型。');}
  else if(action==='version-diff'){state.versionDiff=await api('/api/tasks/'+state.task.id+'/diff');render();}
  else if(action==='retry-task'){state.busy=true;const task=await api('/api/tasks/'+state.task.id+'/retry',{consent:true,budget_id:budgetId,...(confirmUnknown?{confirm_unknown_resend:true}:{})});state.boot=await api('/api/bootstrap');await openTask(task.id);}
  else if(action==='resume-task'){state.busy=true;const resumeFingerprint=JSON.stringify([state.task.id,state.task.checkpoints,state.task.repairs,state.boot.model,state.boot.base_url,state.boot.max_tokens,state.boot.thinking_mode]);if(automaticResume&&state.resumeRequest?.fingerprint!==resumeFingerprint)state.resumeRequest={fingerprint:resumeFingerprint,id:crypto.randomUUID()};const task=await api('/api/tasks/'+state.task.id+'/resume',{consent:true,budget_id:budgetId,...(automaticResume?{request_id:state.resumeRequest.id}:{}),...(confirmUnknown?{confirm_unknown_resend:true}:{})});state.boot=await api('/api/bootstrap');await openTask(task.id||state.task.id);}
  else if(action==='discard-human-edit'){const issue=state.taskReview?.review?.issues?.[Number(el.dataset.index)];if(issue)delete state.humanEdits?.[humanEditKey(issue)];render();}
  else if(action==='refresh-human-review'){state.busy=true;await loadTaskDetails();render();}
  else if(action==='open-review-source'){
    const claim=state.taskReview?.review?.candidate?.claims?.find(c=>c.id===el.dataset.id)||claimList().find(c=>c.id===el.dataset.id);
    if(!claim)throw Error('证据已变化，请重新打开当前候选。');
    state.sourceViewer={task_id:state.task.id,claim_id:claim.id,return_view:state.view,back_scroll:window.scrollY||0};state.view='source';render();
  }
  else if(action==='close-review-source'){const y=state.sourceViewer?.back_scroll||0;state.view=state.sourceViewer?.return_view||'review';render();window.scrollTo(0,y);}
  else if(action==='locate-review-quote')document.querySelector('#source-evidence')?.scrollIntoView?.({block:'center'});
  else if(action==='save-human-decision'){
    if(state.taskReview?.continued_to)throw Error('此快照已继续处理，请打开后续版本再作决定。');
    const taskId=state.task.id,review=state.taskReview?.review,issue=review?.issues?.[Number(el.dataset.index)];if(!issue)throw Error('当前复核事项已变化，请刷新。');
    const key=humanEditKey(issue),edit=humanEdit(issue);if(!issue.allowed_choices?.includes(edit.choice))throw Error('请选择当前事项允许的处理方式。');
    const body={version:taskId,snapshot_hash:review.snapshot_hash,issue_id:issue.id,choice:edit.choice,note:(edit.note||'').trim(),...(edit.choice==='RECHECK'&&edit.reason_code?{reason_code:edit.reason_code}:{})};
    if(edit.choice==='AMEND_CLAIM'){
      if(issue.claim_ids?.length!==1||issue.claims?.length!==1)throw Error('只有单条明确候选可以局部修正；请请求复核。');
      const claim=issue.claims[0],patch={...(edit.patch||{})},predicate=schema()?.predicates.find(p=>p.id===(patch.predicate_id||claim.predicate_id));
      if(!Object.keys(patch).length)throw Error('请先修改候选字段；不修改时请选择请求独立复核。');
      if(Object.hasOwn(patch,'value')){if(predicate?.value_type==='NUMBER'){if(String(patch.value).trim()===''||!Number.isFinite(Number(patch.value)))throw Error('该属性需要有效数值。');patch.value=Number(patch.value);}else if(predicate?.value_type==='ENTITY'&&!schema()?.entities.some(e=>e.id===patch.value))throw Error('候选关系值必须选择已知实体标识。');}
      if(Object.hasOwn(patch,'scope'))patch.scope=patch.scope.trim()||null;
      body.patch=patch;
    }
    state.busy=true;await api('/api/tasks/'+taskId+'/review-decisions',body);
    if(state.task?.id===taskId){delete state.humanEdits?.[key];await loadTaskDetails();}
    toast('这项决定已保存在本机，尚未调用模型。');render();
  }
  else if(action==='discard-review-group'){const group=state.taskReview?.review?.groups?.find(g=>g.id===el.dataset.group);if(group)delete state.groupEdits?.[groupEditKey(group)];render();}
  else if(action==='save-review-group'){
    const review=state.taskReview?.review,group=review?.groups?.find(g=>g.id===el.dataset.group);if(!group)throw Error('事项组已变化，请刷新');
    if(group.issue_ids.some(id=>humanEdit(review.issues.find(i=>i.id===id)).dirty))throw Error('此组有尚未保存的逐项编辑，请先保存或放弃逐项修改');
    state.busy=true;await api('/api/tasks/'+state.task.id+'/review-group-decisions',{version:state.task.id,snapshot_hash:review.snapshot_hash,group_id:group.id,choice:'RECHECK',note:state.groupEdits?.[groupEditKey(group)]?.note||''});
    delete state.groupEdits?.[groupEditKey(group)];await loadTaskDetails();toast('共同复核意见已保存，尚未调用模型');
  }
  else if(action==='stop-component'){
    state.busy=true;await api('/api/tasks/'+state.task.id+'/review-component-stop',{submission_id:el.dataset.submission});await loadTaskDetails();toast('本组复核已停止，其他已保存决定保留');
  }
  else if(action==='continue-component'){
    const packet=state.taskReview,group=packet?.dependency_groups?.find(g=>g.id===el.dataset.group);if(!group||group.published)throw Error('分组已变化或已经发布，请刷新');
    if(hasUnsavedComponentEdits(group))throw Error('请先保存或放弃本组尚未保存的编辑，再提交本组');
    const unknown=group.submission?.requires_unknown_resend_confirmation===true;
    if(unknown&&!document.querySelector('#component-unknown-'+group.id)?.checked)throw Error('请先单独确认本组未知结果的再次发送');
    const fingerprint=JSON.stringify([state.task.id,packet.review.snapshot_hash,group.id,packet.decisions.filter(d=>group.issue_ids.includes(d.issue_id)).map(d=>d.id),group.submission?.id,group.submission?.status]);
    if(state.componentAttempt?.fingerprint!==fingerprint)state.componentAttempt={fingerprint,id:crypto.randomUUID()};
    state.busy=true;const next=await api('/api/tasks/'+state.task.id+'/review-component-continue',{consent:true,request_id:state.componentAttempt.id,snapshot_hash:packet.review.snapshot_hash,decision_set_hash:packet.decision_set_hash,group_id:group.id,...(unknown?{confirm_unknown_resend:true}:{})});
    state.boot=await api('/api/bootstrap');await openTask(next.id,{restoreLearning:false});
  }
  else if(action==='revise-ontology'){
    const review=state.taskReview?.review;if(!review)throw Error('没有当前核对快照');
    const key=state.task.id+':'+review.snapshot_hash,definition=state.ontologyInstructions?.[key]?.trim();if(!definition)throw Error('请填写业务定义或身份说明');
    const fingerprint=JSON.stringify([key,definition]);if(state.ontologyRequest?.fingerprint!==fingerprint)state.ontologyRequest={fingerprint,id:crypto.randomUUID()};
    state.busy=true;const next=await api('/api/tasks/'+state.task.id+'/ontology-revision',{snapshot_hash:review.snapshot_hash,definition,request_id:state.ontologyRequest.id});
    state.boot=await api('/api/bootstrap');await openTask(next.id);
  }
  else if(action==='continue-review'){
    const componentUnknown=state.taskReview?.requires_component_resend_confirmation===true;if(componentUnknown&&!document.querySelector('#component-full-unknown')?.checked)throw Error('请先单独确认结果未知分组的再次发送');
    const packet=state.taskReview,taskId=state.task.id;if(packet?.continued_to)throw Error('此快照已继续处理，请打开后续版本。');if(!packet?.review||!packet.can_continue||packet.pending_count!==0||hasUnsavedReviewEdits())throw Error('请先保存全部事项的决定。');
    state.busy=true;const child=await api('/api/tasks/'+taskId+'/review-continue',{consent:true,budget_id:budgetId,...(componentUnknown?{confirm_unknown_resend:true}:{}),snapshot_hash:packet.review.snapshot_hash,decision_set_hash:packet.decision_set_hash});
    state.boot=await api('/api/bootstrap');await openTask(child.id);
  }
  else if(action==='save-decision'){const packet=state.taskIssues,issue=visibleIssues()[Number(el.dataset.index)],i=Number(el.dataset.index);if(!issue)throw Error('待确认项已变化，请刷新。');const choice=document.querySelector('[data-decision-choice="'+i+'"]').value,note=document.querySelector('[data-decision-note="'+i+'"]').value;state.busy=true;const decision=await api('/api/tasks/'+state.task.id+'/decisions',{issue_id:issue.id||issue.issue_id,version:packet?.version||state.task.id,choice,note,...(choice==='CONFIRM_DEFINITION'?{definition:note}:{})});if(decision.draft?.id||decision.draft_id){await openTask(decision.draft?.id||decision.draft_id);toast('决定已保存为修订草稿；尚未发送模型。');}else{await loadTaskDetails();toast('决定已保存，原始冲突与历史保留。');}}
  else if(action==='cancel'){const r=await api('/api/tasks/'+state.task.id+'/cancel',{});toast(r.message);}
  else if(action==='claim'||action==='entity'){state.selected=el.dataset.id;if(graphView){graphView.select(el.dataset.id,action==='entity'?'entity':'statement');updateGraphInspector();}else render();}
  else if(action==='zoom-in'){state.zoom=Math.min(1.5,state.zoom+.15);render();}
  else if(action==='zoom-out'){state.zoom=Math.max(.65,state.zoom-.15);render();}
  else if(action==='zoom-reset'){state.zoom=1;render();}
  else if(action==='save-model'){state.busy=true;const key=document.querySelector('#model-key');await api('/api/model',{base_url:document.querySelector('#model-url').value.trim(),model:document.querySelector('#model-name').value.trim(),max_tokens:Number(document.querySelector('#model-max-tokens').value),thinking_mode:document.querySelector('#model-thinking').value,api_key:key.value,allow_insecure_http:document.querySelector('#insecure-http').checked});key.value='';state.boot=await api('/api/bootstrap');render();toast('模型连接已保存');}
  else if(action==='export'){if(!state.task)throw Error('请先选择任务');const url=URL.createObjectURL(new Blob([JSON.stringify(state.task,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='cqforge-'+state.task.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
}catch(error){state.lastError=error.message;toast(error.message);}finally{if(budgetId)await refreshBudget(budgetId);if(['new','sample','add-source','remove-source','propose-cqs','discard-proposal','confirm-proposal'].includes(action))await persistWorkspaceDraft();state.busy=false;if(productEnabled()&&!directNativeAction&&(action.startsWith('product-')||action.startsWith('native-')||['build','ask-question'].includes(action)))render();if(action==='ask-question'){state.answerPending=false;if(!state.answerDraft?.finishing)state.answerDraft=null;}if(['confirm-library-manage','restore-library','nav-integrations','create-integration','revoke-integration','build','save-model','save-draft','connect-graph','sync-graph','query','retry-task','resume-task','propose-cqs','confirm-proposal','ask-question','execute-capability','confirm-budget','add-library-source','save-review-group','continue-component','stop-component','revise-ontology','save-decision','save-backlog','save-human-decision','refresh-human-review','continue-review'].includes(action))render();}}
document.addEventListener('click',handleClick);
async function advanceLearning(boot){
  const p=state.pendingLearning;if(!p)return false;
  let summary=boot.tasks.find(t=>t.id===p.task_id);const seen=new Set();
  while(summary&&['FAILED','INTERRUPTED','PAUSED','REVIEW_REQUIRED'].includes(summary.status)&&!seen.has(summary.id)){
    seen.add(summary.id);const next=boot.tasks.filter(t=>t.revision?.parent_id===summary.id&&['TECHNICAL_RESUME','TECHNICAL_RETRY','HUMAN_REVIEW_CONTINUE'].includes(t.revision.kind)&&t.learning?.question===p.question&&t.status!=='CANCELLED').sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))[0];
    if(!next)break;p.task_id=next.id;summary=next;
  }
  if(!summary||summary.status!=='READY')return false;
  const update=boot.knowledge_bases?.find(b=>b.id===p.base_id)?.source_update;if(update&&['RUNNING','QUEUED'].includes(update.status))return false;
  if(state.view!=='knowledge'||state.task?.id!==p.origin_task_id||state.askQuestion!==p.question||(state.askRevision||0)!==p.revision)return false;
  state.busy=true;
  try{
    let next=await api('/api/tasks/'+p.task_id);
    if(next.publication?.status!=='PUBLISHED')return false;
    const answer=await api('/api/knowledge-bases/'+p.base_id+'/ask',{question:p.question,consent:true,learn:false,request_id:crypto.randomUUID()});
    if(state.task?.id!==p.origin_task_id||state.askQuestion!==p.question||(state.askRevision||0)!==p.revision)return false;
    const answeredTask=answer.task_id||answer.version||next.id;if(answeredTask!==next.id)next=await api('/api/tasks/'+answeredTask);
    state.task=next;state.catalog=await api('/api/tasks/'+next.id+'/capabilities');state.queryAnswers={};
    state.directAnswer={...answer,request_context:{question:p.question,task_id:next.id}};state.pendingLearning=null;await loadTaskDetails();render();return true;
  }catch(error){state.lastError=error.message;state.pendingLearning=null;render();return false;}finally{state.busy=false;render();}
}
async function poll(){if(state.pollBusy||state.busy)return;state.pollBusy=true;try{const boot=await api('/api/bootstrap');if(productEnabled()){const basesChanged=JSON.stringify(boot.knowledge_bases)!==JSON.stringify(state.boot?.knowledge_bases);state.boot=boot;if(state.productLibraryId&&!boot.knowledge_bases?.some(b=>b.id===state.productLibraryId)){state.productLibraryId=null;state.productView=null;clearProductAnswer();state.view='overview';render();return;}const previous=state.productView,viewChanged=await refreshProductView();if(state.view==='overview'&&basesChanged)render();else if(state.view==='knowledge'&&viewChanged)renderProductPoll(previous);return;}if(state.lastBudget?.id){state.lastBudget=await api('/api/budgets/'+state.lastBudget.id);const meter=document.querySelector('#budget-meter');if(meter)meter.textContent=budgetMeter(state.lastBudget);}const changed=JSON.stringify([boot.tasks,boot.knowledge_bases])!==JSON.stringify([state.boot?.tasks,state.boot?.knowledge_bases]);const oldLibrary=state.boot?.knowledge_bases?.find(b=>b.task_ids?.includes(state.task?.id));state.boot=boot;
if(oldLibrary&&!boot.knowledge_bases?.some(b=>b.id===oldLibrary.id)){state.task=null;state.directAnswer=null;state.answerEvidence=null;state.pendingLearning=null;state.reviewReturn=null;state.reviewInbox=false;state.libraryManage=null;state.view='overview';render();return;}if(await advanceLearning(boot))return;const library=boot.knowledge_bases?.find(b=>b.task_ids.includes(state.task?.id));const sourceChanged=state.task?.publication&&library?.source_epoch!==undefined&&(library.source_epoch!==state.task.publication.source_epoch||library.review_hash!==state.task.publication.review_hash);if(sourceChanged){state.directAnswer=null;state.answerEvidence=null;state.queryAnswers={};state.catalog=null;}const summary=state.task&&boot.tasks.find(t=>t.id===state.task.id);if(state.task&&(sourceChanged||['RUNNING','QUEUED'].includes(state.task.status)||boot.active_task===state.task.id||summary?.status!==state.task.status||JSON.stringify(summary?.graph_sync||null)!==JSON.stringify(state.task.graph_sync||null))){const pollingTaskId=state.task.id,refreshedTask=await api('/api/tasks/'+pollingTaskId);if(state.task?.id!==pollingTaskId)return;state.task=refreshedTask;if(['knowledge','review'].includes(state.view))await loadTaskDetails();if(!['input','model','budget'].includes(state.view))render();}else if(changed&&['overview','knowledge'].includes(state.view))render();}catch{/* Keep current view; explicit operations surface connection errors. */}finally{state.pollBusy=false;}}
function syncWorkbenchLink(){
  if(productEnabled()&&state.productLibraryId&&state.view==='knowledge'){window.history?.replaceState?.(null,'','#library='+state.productLibraryId+'&view='+(state.knowledgeMode??'answers'));return;}
  if(!window.history?.replaceState)return;
  let hash=null;if(state.task&&['knowledge','review'].includes(state.view))hash='#task='+state.task.id+'&view='+state.view;
  else if(state.view==='overview')hash='';else if(state.view==='model')hash='#settings';else if(state.view==='integrations')hash='#integrations';else if(state.view==='input')hash='#input';
  if(hash!==null&&window.location?.hash!==hash)window.history.replaceState(null,'',hash||window.location?.pathname||'/');
}
async function openWorkbenchLink(){
  const hash=window.location?.hash||'';if(!hash)return false;
  if(hash==='#integrations'){state.integrationData=await api('/api/integrations');state.view='integrations';return true;}
  if(hash==='#settings'||hash==='#input'){state.view=hash==='#settings'?'model':'input';return true;}
  if(productEnabled()){const library=hash.match(/^#library=(kb_[a-f0-9-]{36})(?:&view=(answers|graph|sources|processing|native))?$/);if(library){await openProductLibrary(library[1],{mode:library[2]??'answers'});return true;}state.view='overview';return true;}
  const task=hash.match(/^#task=([a-f0-9-]{36})(?:&view=(knowledge|review))?$/),library=hash.match(/^#library=(kb_[a-f0-9-]{36})$/);
  const id=task?.[1]||(library&&state.boot.knowledge_bases?.find(b=>b.id===library[1])?.open_task_id);
  if(!id||!state.boot.tasks.some(t=>t.id===id)){state.lastError='链接中的知识库或任务不在当前工作空间';state.view='overview';return true;}
  await openTask(id,{restoreLearning:!task});if(task?.[2]==='review')state.view='review';return true;
}
try{state.boot=await api('/api/bootstrap');if(state.boot.ontoweave_pg){
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = '/ontoweave-pg-workspace-v1.css';
  document.head.append(style);
  const { mountPgWorkspace } = await import('./ontoweave-pg-workspace-v1.mjs');
  await mountPgWorkspace({ root, boot: state.boot });
}else if(state.boot.source_first?.workspace_ui==='LIGHTOG_WORKSPACE_V1'){const workspace=await import('./lightog-workspace-v1.mjs');await workspace.mountLightogWorkspace({root,boot:state.boot,api,toast});}else{if(productEnabled()){await loadProductUi();state.productModels=await api('/api/product/models');}try{await restoreWorkspaceDraft();}catch{state.draftRestoreNotice='暂时无法读取草稿，请检查本地服务；未覆盖原有草稿。';}if(!await openWorkbenchLink()&&!productEnabled()&&state.boot.active_task){state.task=await api('/api/tasks/'+state.boot.active_task);recallLearningProgress(state.task);state.view='knowledge';}render();setInterval(poll,2500);window.addEventListener?.('hashchange',()=>{void openWorkbenchLink().then(render).catch(e=>toast(e.message));});}}catch(error){root.innerHTML=`<div class="boot"><h2>无法连接本地工作台</h2><p>${escape(error.message)}</p></div>`;}

document.addEventListener('keydown',event=>{if(productEnabled()&&state.productEvidence!==null&&state.productEvidence!==undefined){if(event.key==='Escape'){state.productEvidence=null;render();return;}if(event.key==='Tab'){const nodes=document.querySelector('#product-answer-evidence')?.querySelectorAll?.('button,a,summary,[tabindex="0"]');if(nodes?.length){const first=nodes[0],last=nodes[nodes.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}}return;}if(state.libraryManage){if(event.key==='Escape'){state.libraryManage=null;render();return;}if(event.key==='Tab'){const nodes=document.querySelector('.library-modal')?.querySelectorAll?.('input,button');if(nodes?.length){const first=nodes[0],last=nodes[nodes.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}}return;}if(state.reviewInbox||state.view==='review'){if(event.key==='Escape'){event.preventDefault?.();closeReviewDrawer();return;}if(event.key==='Tab'){const nodes=document.querySelector('.review-drawer')?.querySelectorAll?.('button,a,input,textarea,select,summary');if(!nodes?.length)return;const enabled=[...nodes].filter(n=>!n.disabled&&n.getClientRects?.().length);const first=enabled[0],last=enabled.at(-1);if(!first)return;if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}return;}if(!state.answerEvidence||state.view!=='knowledge')return;if(event.key==='Escape'){event.preventDefault?.();closeAnswerEvidence();return;}if(event.key==='Tab'){const nodes=document.querySelector('#answer-evidence-drawer')?.querySelectorAll?.('button,a,summary,[tabindex="0"]');if(!nodes?.length)return;const first=nodes[0],last=nodes[nodes.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}});

