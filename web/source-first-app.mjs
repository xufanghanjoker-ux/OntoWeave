const $=id=>document.getElementById(id);let token,preview=null,budget=null,operation=null;
let graphView=null,graphPayload=null,graphTools=null,graphEpoch=0,learningPoll=null;
let libraryEntries=new Map(),catalogRequest=0,sourceViewEpoch=0,sourceMutationInFlight=false;
const appendText=(parent,text,tag='p')=>{const el=document.createElement(tag);el.textContent=text;parent.append(el);return el;};
function clearGraph(message='尚无图谱。'){
 graphEpoch++;graphView?.dispose();graphView=null;graphPayload=null;$('graph-browse').replaceChildren();$('source-graph-inspector').textContent='点击候选实体、关系或下方条目核对原文。';$('source-graph-view').querySelector('[data-graph-status]').textContent=message;
}
function inspectGraph(id,kind='entity'){
 const root=$('source-graph-inspector');root.replaceChildren();if(!id||!graphPayload)return;
 const detail=graphTools.inspectSourceGraph(graphPayload,id,kind);if(!detail){appendText(root,'该条记录不在当前图快照中，请刷新图谱。');return;}const item=detail.item;
 appendText(root,kind==='entity'?'候选实体详情':'候选陈述与原文位置','h3');
 appendText(root,'待核实 · 仅供导航与检索提示，不作为回答事实依据。','p').className='unverified-badge';
 if(kind==='entity'){
  appendText(root,item.label);appendText(root,'类型：'+(item.type_labels??[]).join('、'));
  appendText(root,'身份：'+(item.identity_status==='PROVISIONAL_ANCHOR'?'来源提及，尚未完成身份归一':item.identity_status??'未说明'));
 }else{
  appendText(root,(item.descriptions??[]).join('\n')||item.predicate?.proposed_definition?.label||item.predicate?.predicate_ref||id);
  appendText(root,'属性／关系：'+(item.predicate?.proposed_definition?.label??item.predicate?.predicate_ref??'未说明'));
  const entityName=entityId=>graphTools.inspectSourceGraph(graphPayload,entityId,'entity')?.item.label??entityId;appendText(root,'主体：'+entityName(item.subject_id));appendText(root,'值／对象：'+(item.object?.entity_id?entityName(item.object.entity_id):JSON.stringify(item.object?.typed_value?.value)));if(item.qualifiers?.unit)appendText(root,'单位：'+item.qualifiers.unit);
  appendText(root,`方向：${({DIRECTED:'主体 → 对象',UNDIRECTED:'无向关系',NONE:'属性，无关系方向'})[item.direction]??'未说明'}；否定：${item.qualifiers?.negated?'是':'否'}`);
  if(item.qualifiers?.scope)appendText(root,'适用范围：'+item.qualifiers.scope);
  if(item.qualifiers?.effective_time)appendText(root,'时间：'+JSON.stringify(item.qualifiers.effective_time));
  if(item.conditions?.length)appendText(root,'条件：'+item.conditions.map(c=>c.text).join('；'));
 }
 const citations=[...(detail.evidence??[]).map(e=>({...e,display_label:'核对候选关联的原文片段（定位不等于语义支持）'})),...(detail.anchors??[]).map(e=>({...e,display_label:'实体提及位置（仅定位）'})),...(detail.condition_evidence??[]).flatMap(c=>(c.evidence??[]).map(e=>({...e,display_label:'候选条件原文：'+c.condition.text})))];
 for(const evidence of citations){
  const e=evidence.fragment??evidence.evidence??evidence.anchor??evidence;
  if(evidence.resolved===false){appendText(root,'该证据在本次图快照中未能定位：'+(evidence.error??evidence.evidence_id??''));continue;}
  if(!e.span)continue;
  const box=document.createElement('details');appendText(box,evidence.display_label,'summary');
  appendText(box,`来源：${e.source_ref}\n版本：${e.source_revision}\n原文位置：[${e.span.start}, ${e.span.end})（UTF16，左闭右开）`,'pre');
  appendText(box,e.span.quote,'blockquote');root.append(box);
 }
 const raw=document.createElement('details');appendText(raw,'查看保留的原始记录','summary');appendText(raw,JSON.stringify(detail,null,2),'pre');root.append(raw);
}
async function refreshGraph(){
 clearGraph('正在读取当前图版本…');const epoch=graphEpoch,libraryId=$('library').value;if(!libraryId){$('graph-version').textContent='请先导入或选择知识库。';return;}
 const registered=libraryEntries.get(libraryId)?.sources;if(registered?.length&&!registered.some(s=>s.active)){const message='当前没有有效来源，已撤回资料仅保留历史。请先添加有效资料，再提问或授权建图。';$('graph-version').textContent=message;$('source-graph-view').querySelector('[data-graph-status]').textContent=message;return;}
 try{
  const payload=await api(`/api/knowledge-bases/${libraryId}/source-first/graph`);if(epoch!==graphEpoch||libraryId!==$('library').value)return;
  if(!['READY','COMMITTED_INDEX_PENDING','COMMITTED_INDEX_UNAVAILABLE'].includes(payload.status)){
   const message=payload.status==='SOURCE_INVALIDATED'?'资料已经变化，旧图不再展示。请按当前资料重新预览并授权建图。':payload.status==='EMPTY'?'资料已保存，尚未建图。可先原文提问，或预览并授权后台建图。':'当前图暂不可展示，请查看后台任务状态。';$('graph-version').textContent=message;$('source-graph-view').querySelector('[data-graph-status]').textContent=message;return;
  }
  const tools=await import('/assets/graph-view.mjs');if(epoch!==graphEpoch)return;
  const projection=tools.projectSourceGraph(payload);graphTools=tools;graphPayload=payload;
  $('graph-version').textContent=`图版本：${payload.graph_revision}；索引：${payload.index_status}。${payload.retrieval_available?'此候选图索引已就绪，可辅助定位原文；内容仍待核实。':'当前展示的是已提交候选图，索引尚不可用于检索。'} 刷新可检查资料与版本变化。`;
  if(projection.omitted_patterns)$('graph-version').textContent+=` 另有 ${projection.omitted_patterns} 条模式记录未在此画布绘制。`;
  const browse=$('graph-browse');for(const n of projection.nodes.filter(n=>n.kind==='entity')){const b=appendText(browse,n.label+' · 待核实','button');b.type='button';b.onclick=()=>{inspectGraph(n.canonical_id,'entity');graphView?.select(n.canonical_id,'entity');};}
  const statements=new Map();for(const build of payload.builds)for(const s of build.graph.statements)statements.set(s.id,s);
  for(const s of statements.values()){const b=appendText(browse,(s.descriptions?.[0]??s.predicate?.proposed_definition?.label??s.id)+' · 待核实','button');b.type='button';b.onclick=()=>{inspectGraph(s.id,'statement');graphView?.select(s.id,'statement');};}
  try{graphView=tools.createGraphView($('source-graph-view'),{id:payload.graph_revision},{layoutKey:libraryId+':'+payload.graph_revision,projectionFactory:(_task,options)=>tools.projectSourceGraph(payload,options),statementLabel:'待核实陈述',onSelect:inspectGraph});}
  catch(error){$('source-graph-view').querySelector('[data-graph-status]').textContent='画布暂不可用，下方条目仍可查看实体、关系和原文依据。'+error.message;}
 }catch(error){if(epoch===graphEpoch){clearGraph('当前图读取失败；旧图已隐藏。');$('graph-version').textContent=error.message;}}
}
function watchLearning(libraryId,viewEpoch=sourceViewEpoch){
 clearTimeout(learningPoll);learningPoll=setTimeout(async()=>{if(libraryId!==$('library').value||viewEpoch!==sourceViewEpoch)return;try{const status=await api(`/api/knowledge-bases/${libraryId}/source-first/jobs`);if(libraryId!==$('library').value||viewEpoch!==sourceViewEpoch)return;showLearningStatus(status);const active=status.items.some(r=>['QUEUED','RUNNING','WAIT_MODEL_CONFIGURATION'].includes(r.status));if(!active||status.head?.committed_graph_revision!==graphPayload?.graph_revision||(graphPayload&&status.head?.index_state!==graphPayload.index_status))await refreshGraph();if(active)watchLearning(libraryId,viewEpoch);}catch(error){if(viewEpoch===sourceViewEpoch)$('learning-status').textContent='后台状态读取失败：'+error.message;}},3000);
}
const defaults={generation:{label:'LLM 生成模型',model:'qwen3.8-flash',base_url:'https://cn-beijing.maas.qianwenaiapi.com/compatible-mode/v1',protocol:'openai-compatible'},embedding:{label:'Embedding 向量模型',model:'qwen3.7-text-embedding-flash',base_url:'https://cn-beijing.maas.qianwenaiapi.com/api/v1/services/embeddings/text-embedding/text-embedding',protocol:'dashscope-native'},reranker:{label:'Reranker 重排模型',model:'qwen3.7-text-rerank',base_url:'https://cn-beijing.maas.qianwenaiapi.com/api/v1/services/rerank/text-rerank/text-rerank',protocol:'dashscope-native'}};
async function api(path,body){const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-cqforge-token':token},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json();if(!response.ok)throw Error(data.code??data.error??'请求失败');return data;}
const labels={QUEUED:'等待后台学习',RETRIEVING:'准备相关原文',EXTRACTING:'抽取候选',VALIDATING:'独立审核',INDEX_PENDING:'图已提交，索引更新中',COMPLETED:'图与索引已就绪',WAIT_REVIEW:'候选待审核',WAIT_EVIDENCE:'等待更多证据',SUPERSEDED:'资料已变化，此任务停止',FAILED:'执行失败',STOPPED:'已停止'};
function showLearningStatus(value){
 const root=$('learning-status');root.replaceChildren();appendText(root,'后台学习与索引','h3');
 const head=value.head??{};appendText(root,`当前可用图：${head.active_usable?head.active_graph_revision??'已有版本':head.active_graph_revision?'资料已变化，旧图已停用':'尚无'}；索引：${head.active_usable?head.index_state??'未说明':'等待当前资料版本'}`);
 if(head.committed_graph_revision&&head.committed_graph_revision!==head.active_graph_revision)appendText(root,'新提交图：'+head.committed_graph_revision+(head.active_usable?'；索引构建期间保留原可用版本。':'；等待新索引就绪，旧版本仅保留历史，不用于当前资料检索。'));
 if(!(value.items??[]).length)appendText(root,'尚无后台任务。可先原文提问，或预览并授权候选建图。');
 for(const row of value.items??[]){const job=row.job??{},pending=job.attempts?.some(a=>['STARTED','UNKNOWN'].includes(a.outcome)),stage=job.stage==='VALIDATING'&&job.request?.policy_version?.includes('candidate-mvp')?'核对候选结构与来源位置（未语义审核）':labels[job.stage]??row.status??job.stage??'未说明';appendText(root,`${job.task_ref??'后台任务'}：${pending?'调用进行中或结果未确认，不会自动重发':row.status==='WAIT_MODEL_CONFIGURATION'?'等待恢复本任务原模型配置':stage}${row.error_code?'；原因：'+row.error_code:''}`);}
 appendText(root,'后台任务不会改写当前回答。索引就绪后，可换个问法再次提问，核对本次是否实际使用候选图导航。');
}
async function refreshLearningStatus(){const libraryId=$('library').value,epoch=sourceViewEpoch;if(!libraryId)return;try{const value=await api(`/api/knowledge-bases/${libraryId}/source-first/jobs`);if(epoch===sourceViewEpoch&&libraryId===$('library').value){showLearningStatus(value);if(value.items?.some(row=>['QUEUED','RUNNING','WAIT_MODEL_CONFIGURATION'].includes(row.status)))watchLearning(libraryId,epoch);}}catch(error){if(epoch===sourceViewEpoch)$('learning-status').textContent='后台状态读取失败：'+error.message;}}
function showAnswer(value){
 const a=value.answer,root=$('result');root.replaceChildren();
 const line=(parent,text,tag='p')=>{const el=document.createElement(tag);el.textContent=text;parent.append(el);return el;};
 line(root,`回答状态：${a.status}；图：${value.graph_status??'无图信息'}`);
 if(a.snapshot)line(root,`本次来源代次：${a.snapshot.source_epoch??'未说明'}；读取图版本：${a.snapshot.graph_revision??'空图，仅原文'}。`);
 const selectedLinks=(value.retrieval_trace?.record_decisions??[]).filter(row=>typeof row.record_id==='string'&&row.record_id.startsWith('profile:')&&['COVERED_LINK','ADDED_WHOLE_GROUP'].includes(row.reason));
 const reused=new Set(selectedLinks.map(row=>row.record_id));line(root,reused.size?`本次实际使用 ${reused.size} 条候选图导航记录定位原文；候选陈述本身不作为答案证据。`:'本次未记录实际使用候选图导航；回答仍须核对下方原文。');
 const index=a.evidence_index??{};
 const cite=(parent,ids)=>{const detail=document.createElement('details'),summary=document.createElement('summary');summary.textContent=`查看原文依据（${ids.length} 处）`;detail.append(summary);for(const id of ids){const e=index[id];if(!e){line(detail,'该引用未在本次证据清单中登记。');continue;}line(detail,`来源：${e.source_ref}\n版本：${e.source_revision}\n原文位置：[${e.span?.start}, ${e.span?.end})（UTF16，左闭右开）`,'pre');line(detail,e.span?.quote??'','blockquote');}parent.append(detail);};
 for(const statement of a.statements??[]){const row=document.createElement('article');line(row,statement.text);cite(row,statement.evidence_ids??[]);root.append(row);}
 for(const excerpt of a.excerpts??[]){line(root,typeof excerpt==='string'?excerpt:excerpt.text??excerpt.quote??excerpt.span?.quote??excerpt.fragment?.span?.quote??JSON.stringify(excerpt),'blockquote');}
 if(!(a.statements??[]).length&&Object.keys(index).length)cite(root,Object.keys(index));
 if(a.gaps?.length)line(root,'尚未覆盖：'+a.gaps.map(g=>typeof g==='string'?g:g.reason??g.description??JSON.stringify(g)).join('；'));
 line(root,'依据对应本次回答的来源快照；资料更新或撤回后，需重新提问核对当前有效证据。');
}
const show=value=>{
 let text;if(typeof value==='string')text=value;
 else if(value.status==='SOURCE_IMPORTED_GRAPH_NOT_BUILT')text='CQ 与资料已保存，尚未建图。本次模型调用：0。\n下一步可点击「预览后台候选建图」，核对预算后执行；也可先提问并核对原文。';
 else if(value.answer){showAnswer(value);return;}
 else if(value.queue_status)text=`后台任务已登记：${value.job?.task_ref??''}\n状态：${labels[value.job?.stage]??value.queue_status}\n后台失败不会改写已有答案。`;
 else if(value.items)text=`当前可用图：${value.head?.active_usable?'已有可用版本':value.head?.active_graph_revision?'资料已变化，旧图已停用':'尚无'}\n索引：${value.head?.active_usable?value.head.index_state:'等待建立当前资料版本'}\n\n`+value.items.map(row=>`${row.job?.attempts?.some(a=>['STARTED','UNKNOWN'].includes(a.outcome))?'调用进行中或结果未知，不会自动重发':row.status==='WAIT_MODEL_CONFIGURATION'?'等待恢复本任务原模型配置':labels[row.job?.stage]??row.status}${row.error_code?'；原因：'+row.error_code:''}`).join('\n');
 else text=JSON.stringify(value,null,2);$('result').textContent=text;
};
function showPreview(p){
 const mvp=p.proposal_policy_version?.includes('candidate-mvp');
 const notices=mvp?['本次仅抽取待核实实体和关系，建立候选导航图，不进行语义审核，也不标记为已证实。','候选图只用于导航与检索提示；回答仍须引用原文，不以候选描述作为证据。']:p.proposal_policy_version?.includes('structured-review')?['本次抽取要求逐项填写原文中的提及位置，唯一位置也须明确填写；旧任务和结果保留。','本次独立审核分别检查结构九维、描述是否有原文支持、结构与描述是否一致；任一不通过均不接收。']:p.proposal_policy_version?[p.proposal_policy_version.includes('required-occurrence')?'本次抽取要求逐项填写原文中的提及位置，唯一位置也须明确填写；旧任务和结果保留。':'本次按任务原定位协议执行；旧任务和结果保留。']:[];
 $('preview').textContent=[`操作：${operation==='ASK'?'原文回答（候选图可辅助导航）':p.rebuild_source_scope?'以当前全部资料重建候选图，保留历史档案':mvp?'后台抽取待核实候选并建立导航图':'后台抽取、审核与建图'}`,`问题／方向：${p.question}`,`发送资料：${p.sources.map(s=>`${s.title}（${s.characters} 字符）`).join('、')}`,...Object.entries(defaults).map(([r,d])=>`${d.label}：${p.model_bindings[r]?.model??'未配置'}`),...(operation==='ASK'&&p.preview?.embedding_document_batches!==undefined?[`本次向量需求：资料 ${p.preview.embedding_document_batches} 批，问题 ${p.preview.embedding_query_batches} 批，合计 ${p.preview.embedding_upper_bound} 批（已扣除缓存）。`,'发送前会重新核对缓存与额度；生成和重排仍按各自上限计数。']:[]),...notices,'CQ 用作种子和方向；资料中的文字作为内容处理。','调用失败计入上限；未知结果不自动重发。'].join('\n');
}
function invalidate(){preview=null;budget=null;$('confirm').disabled=true;$('execute').disabled=true;}
async function run(fn){try{await fn();}catch(error){show(error.message);}}
function input(parent,label,value,type='text'){const row=document.createElement('label');row.textContent=label;const el=document.createElement('input');el.type=type;el.value=value;row.append(el);parent.append(row);return el;}
async function modelStatus(){const status=await api('/api/source-first/models');$('model-status').textContent=Object.entries(defaults).map(([r,d])=>`${d.label}：${status[r]?.configured?'已配置':'未配置'}`).join('；');}
for(const [role,d] of Object.entries(defaults)){
 const section=document.createElement('details'),summary=document.createElement('summary');summary.textContent=d.label;section.append(summary);const model=input(section,'模型',d.model),url=input(section,'接口地址',d.base_url),key=input(section,'Key（只保存在内存）','','password'),dimension=role==='embedding'?input(section,'向量维度（需与模型输出一致）','1024','number'):null;
 const save=document.createElement('button');save.textContent='保存配置（不调用模型）';save.onclick=()=>run(async()=>{const result=await api('/api/source-first/models/'+role,{enabled:true,model:model.value,base_url:url.value,api_key:key.value,protocol:d.protocol,timeout_ms:300000,...(dimension?{dimensions:Number(dimension.value)}:{})});key.value='';invalidate();await modelStatus();show({configured:true,model:result.model});});const disable=document.createElement('button');disable.textContent='关闭此模型（不调用模型）';disable.onclick=()=>run(async()=>{await api('/api/source-first/models/'+role,{enabled:false,base_url:url.value,model:model.value});key.value='';invalidate();await modelStatus();show('已关闭'+d.label+'。如需重新启用，请重新保存配置。');});section.append(save,disable);$('models').append(section);
}
function clearSourceView(message){
 sourceViewEpoch++;clearTimeout(learningPoll);invalidate();$('preview').textContent=message;$('result').replaceChildren();$('learning-status').textContent=message;clearGraph(message);$('graph-version').textContent=message;
}
function sourceControlsBusy(busy){for(const id of ['library','import','add-source','preview-ask','preview-learn','preview-import-learn'])$(id).disabled=busy;renderSourceDirectory();}
function renderSourceDirectory(){
 const root=$('source-list');root.replaceChildren();const library=libraryEntries.get($('library').value),sources=library?.sources??[];
 if(!library){appendText(root,'请先导入或选择知识库。');return;}
 if(!sources.length){appendText(root,'当前知识库尚无已登记来源。');return;}
 for(const source of sources){const row=document.createElement('li');row.className=source.active?'source-active':'source-revoked';appendText(row,source.title||'未命名资料','strong');appendText(row,source.active?'当前有效':'已撤回 · 历史保留','span');if(source.active){const replace=appendText(row,'用上方内容替换','button');replace.type='button';replace.disabled=sourceMutationInFlight;replace.setAttribute('aria-label','用上方内容替换「'+(source.title||'未命名资料')+'」');replace.onclick=()=>run(()=>changeSource('replace',source));const revoke=appendText(row,'撤回','button');revoke.type='button';revoke.className='source-revoke';revoke.disabled=sourceMutationInFlight;revoke.setAttribute('aria-label','撤回「'+(source.title||'未命名资料')+'」');revoke.onclick=()=>run(()=>changeSource('revoke',source));}root.append(row);}
}
async function libraries(selected){const wanted=selected??$('library').value,read=++catalogRequest,data=await api('/api/knowledge-bases');if(read!==catalogRequest)return;libraryEntries=new Map(data.items.map(l=>[l.id,l]));$('library').replaceChildren();for(const library of data.items){const option=document.createElement('option');option.value=library.id;option.textContent=library.name;$('library').append(option);}if(libraryEntries.has(wanted))$('library').value=wanted;renderSourceDirectory();}
async function changeSource(action,source){
 if(sourceMutationInFlight)return;const libraryId=$('library').value;if(!libraryId)throw Error('请先选择知识库。');const current=libraryEntries.get(libraryId)?.sources?.find(s=>s.key===source.key&&s.active);if(!current)throw Error('这份来源已变化，请刷新来源目录后重试。');
 const replacement={title:$('source-title').value,content:$('source-text').value};if(action==='replace'&&(!replacement.title.trim()||!replacement.content.trim()))throw Error('请先在上方填写替换资料的标题和原文。');
 const message=action==='replace'?`确认将「${current.title}」替换为上方的「${replacement.title}」？`:`确认撤回「${current.title}」？`;
 if(!window.confirm(message+'\n旧回答和旧图将停止展示，已有调用授权失效；历史记录保留。\n本次不会调用模型，也不会自动建图。'))return;
 const pending=action==='replace'?'正在替换来源；旧回答和旧图已隐藏。':'正在撤回来源；旧回答和旧图已隐藏。';clearSourceView(pending);sourceMutationInFlight=true;sourceControlsBusy(true);
 try{await api(action==='replace'?`/api/knowledge-bases/${libraryId}/source-first/sources`:`/api/knowledge-bases/${libraryId}/sources/${encodeURIComponent(current.key)}/revoke`,action==='replace'?{source:replacement,replace_source_key:current.key}:{});$('rebuild').checked=true;await libraries(libraryId);await refreshGraph();show(action==='replace'?'来源已替换，旧版本已退出当前有效范围。历史记录保留；本次模型调用为0。需要建图时，请重新预览并授权。':'来源已撤回，已从当前有效范围移除。历史记录保留；本次模型调用为0，没有自动建图。');}
 finally{sourceMutationInFlight=false;sourceControlsBusy(false);}
}
$('import').onclick=()=>run(async()=>{clearSourceView('正在导入资料，旧视图已清空。');const epoch=sourceViewEpoch,cqs=$('cqs').value.split('\n').map(q=>q.trim()).filter(Boolean);const row=await api('/api/source-first/libraries',{request_id:crypto.randomUUID(),input:{name:$('name').value,cqs,sources:[{title:$('source-title').value,content:$('source-text').value}],consent:true}});if(epoch!==sourceViewEpoch)return;await libraries(row.library_id);await refreshGraph();$('question').value=cqs[0]??'';invalidate();show(row);});
$('add-source').onclick=()=>run(async()=>{if(sourceMutationInFlight)return;const libraryId=$('library').value;if(!libraryId)throw Error('请先选择知识库。');clearSourceView('正在更新资料；旧回答和旧图已隐藏。');sourceMutationInFlight=true;sourceControlsBusy(true);try{const row=await api(`/api/knowledge-bases/${libraryId}/source-first/sources`,{source:{title:$('source-title').value,content:$('source-text').value}});$('rebuild').checked=true;await libraries(libraryId);await refreshGraph();show(row.status==='UNCHANGED'?'资料已存在，无需重复添加。':'资料已保存，原文可用于提问。图需要按当前全部资料重新预览并授权，本次没有调用模型。');}finally{sourceMutationInFlight=false;sourceControlsBusy(false);}});
async function previewOperation(mode){if(sourceMutationInFlight)return;if(!$('library').value)throw Error('请先保存 CQ 与资料，或选择知识库。');invalidate();const selectedLibrary=$('library').value,epoch=sourceViewEpoch,value=await api(`/api/knowledge-bases/${selectedLibrary}/source-first/preview`,{operation:mode,question:$('question').value,rebuild_source_scope:mode==='LEARN'&&$('rebuild').checked});if(epoch!==sourceViewEpoch||selectedLibrary!==$('library').value)return;operation=mode;preview=value;showPreview(preview);const p=preview.preview??{};$('generation-limit').value=p.generation_upper_bound??2;$('embedding-limit').value=p.embedding_upper_bound??0;$('reranker-limit').value=p.reranker_upper_bound??0;$('confirm').disabled=false;}
for(const [id,mode]of [['preview-ask','ASK'],['preview-learn','LEARN'],['preview-import-learn','LEARN']])$(id).onclick=()=>run(async()=>{await previewOperation(mode);if(id==='preview-import-learn')$('answer-learning-panel').scrollIntoView?.({behavior:'smooth',block:'start'});});
$('confirm').onclick=()=>run(async()=>{if(!preview||sourceMutationInFlight)return;const selectedLibrary=$('library').value,epoch=sourceViewEpoch,value=await api(`/api/knowledge-bases/${selectedLibrary}/source-first/budgets`,{operation,question:$('question').value,rebuild_source_scope:preview.rebuild_source_scope,preview_id:preview.id,limits:Object.fromEntries(['generation','embedding','reranker'].map(r=>[r,Number($(r+'-limit').value)])),consent:true});if(epoch!==sourceViewEpoch||selectedLibrary!==$('library').value)return;budget=value;$('execute').disabled=false;if(operation==='LEARN')appendText($('learning-status'),'后台任务授权已保存，尚未执行。请点击执行已授权操作。');else show({limits:budget.limits,notice:'授权已保存，尚未执行。'});});
$('execute').onclick=()=>run(async()=>{if(!budget||sourceMutationInFlight)return;const selected=budget,selectedLibrary=$('library').value,selectedOperation=operation,epoch=sourceViewEpoch;clearTimeout(learningPoll);$('execute').disabled=true;const result=await api(`/api/knowledge-bases/${$('library').value}/source-first/${operation==='ASK'?'ask':'learning'}`,{question:$('question').value,request_id:crypto.randomUUID(),budget_id:selected.id,consent:true,...(operation==='LEARN'?{rebuild_source_scope:preview.rebuild_source_scope}:{})});if(epoch===sourceViewEpoch&&selectedLibrary===$('library').value){if(selectedOperation==='LEARN'){showLearningStatus({items:[{job:result.job,status:result.queue_status}]});await refreshLearningStatus();}else show(result);await refreshGraph();if(selectedOperation==='LEARN')watchLearning(selectedLibrary,epoch);invalidate();}});
$('status').onclick=()=>run(async()=>{await refreshLearningStatus();await refreshGraph();});
$('refresh-graph').onclick=()=>void refreshGraph();
$('library').addEventListener('change',()=>{clearSourceView('已切换知识库，旧回答和旧授权已清空。');renderSourceDirectory();void refreshGraph();void refreshLearningStatus();});
for(const id of ['library','question','rebuild'])$(id).addEventListener('change',invalidate);
await run(async()=>{const boot=await(await fetch('/api/bootstrap')).json();token=boot.token;if(!boot.source_first?.enabled)throw Error('此服务尚未启用原文与持续学习入口，请使用隔离启动命令。');await libraries();await modelStatus();await refreshGraph();await refreshLearningStatus();});
