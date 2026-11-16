/** Chat presentation only. text.html is trusted output from the safe Markdown renderer. */
const list=value=>Array.isArray(value)?value:[];
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const text=value=>typeof value==='string'?value:typeof value==='number'?String(value):value&&typeof value==='object'?[value.text,value.label,value.summary,value.description].find(item=>typeof item==='string')??'':'';
const status=value=>String(value??'').toUpperCase();
const activeStates=new Set(['STARTING','QUEUED','OPEN','RUNNING','STREAMING','STARTED','ANSWER_STAGED']);
const stoppingStates=new Set(['STOPPING','CANCELLING','CANCEL_PENDING','STOP_REQUESTED']);
const unknownStates=new Set(['UNKNOWN','UNKNOWN_HOLD','SUBMIT_UNKNOWN']);
const stoppedStates=new Set(['STOPPED','CANCELLED','CANCELED']);
const doneStates=new Set(['COMPLETED','SUCCEEDED','DONE','ANSWERED']);
const internalTitle=/^(?:(?:nquery|query|conversation|conv|turn|run|nrun|kb)_[A-Za-z0-9_-]+|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i;
const title=(value,fallback)=>typeof value==='string'&&value.trim()&&!internalTitle.test(value.trim())?value.trim():fallback;
const citationNumber=value=>Number.isInteger(value)&&value>0?value:null;
const citationRef=value=>typeof value?.citation_ref==='string'?value.citation_ref:typeof value?.id==='string'?value.id:null;
const kindLabel=kind=>kind==='GRAPH'?'图中知识':kind==='SOURCE'?'来源资料':'回答依据';
const definitionChoicesOf=entry=>list(entry?.definition_sources).filter(source=>source?.kind==='HUMAN_DEFINITION_SELECTION'&&source.evidence_nature==='HUMAN_DEFINITION_CHOICE'&&source.authority_scope==='NORMALIZED_DEFINITION_ONLY');
const evidenceLabel=entry=>{const base=list(entry?.record_sources).length?'原始记录来源':list(entry?.human_sources).length?list(entry?.records).some(r=>r.origin_layer!=='HUMAN_CORRECTION')?'知识与人工修订':'人工修订':kindLabel(entry?.kind);return definitionChoicesOf(entry).length?base+' · 人工定义选择':base;};
const button=(label,action,attributes='',classes='')=>`<button type="button" class="lc-button ${classes}" data-chat-action="${action}" ${attributes}>${escape(label)}</button>`;
const badge=(label,tone='')=>`<span class="lc-badge ${tone}">${escape(label)}</span>`;

function turnState(turn){
 const value=status(turn?.status);
 if(turn?.unfinished===true&&doneStates.has(value))return {label:'未完成',tone:'attention',partial:true};
 if(stoppingStates.has(value))return {label:'正在停止',tone:'waiting',partial:true};
 if(activeStates.has(value))return {label:'回答中',tone:'running',partial:false};
 if(unknownStates.has(value))return {label:'结果待确认',tone:'waiting',partial:true};
 if(stoppedStates.has(value))return {label:'已停止',tone:'quiet',partial:true};
 if(value==='FAILED')return {label:'处理未完成',tone:'attention',partial:true};
 if(doneStates.has(value))return {label:'已完成',tone:'ready',partial:false};
 return {label:'已保存',tone:'quiet',partial:false};
}
function publicError(value){const message=text(value);return /^[A-Z0-9_:-]+$/.test(message)?'暂时无法读取进度，已显示的内容会保留。':message;}
function formatDate(value){
 if(value===undefined||value===null||value==='')return '';
 const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';
 return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(date);
}
function activeTurn(state){const turns=list(state.turns);return state.active_turn_id?turns.find(turn=>turn.turn_id===state.active_turn_id)??null:turns.at(-1)??null;}
function runningTurn(state){const turns=list(state.turns),running=turn=>activeStates.has(status(turn?.status))||stoppingStates.has(status(turn?.status));return turns.find(turn=>turn.turn_id===state.running_turn_id&&running(turn))??turns.findLast(running)??null;}
function usedCitations(turn){
 const seen=new Set(),numbers=new Map(),conflicts=new Set(),rows=list(turn?.used_citations).filter(row=>{const number=citationNumber(row?.number),ref=citationRef(row);if(number===null||!ref?.trim())return false;if(numbers.has(number)&&numbers.get(number)!==ref)conflicts.add(number);numbers.set(number,ref);const key=JSON.stringify([number,ref]);if(seen.has(key))return false;seen.add(key);return true;});return rows.filter(row=>!conflicts.has(row.number));
}
function citationAttributes(turn,row){return `data-turn="${escape(turn.turn_id)}" data-number="${row.number}" data-citation-ref="${escape(citationRef(row))}"`;}
function matchingCitation(state,turn,number){
 const row=usedCitations(turn).find(item=>item.number===number),selected=state.selected_citation;
 if(!row||!selected||selected.number!==number||citationRef(selected)!==citationRef(row))return null;
 if(selected.turn_id&&selected.turn_id!==turn.turn_id)return null;
 if(selected.query_ref&&turn.query_ref&&selected.query_ref!==turn.query_ref)return null;
 return {...selected,label:title(selected.label,title(row.label,'回答依据')),citation_ref:citationRef(row)};
}

export function chatHistory(state){
 const rows=list(state.conversations);
 return rows.map(row=>{const current=row.conversation_id===state.selected_conversation_id,running=activeStates.has(status(row.status))||stoppingStates.has(status(row.status)),date=formatDate(row.updated_at);return `<button type="button" class="lc-history-item" data-chat-action="select-conversation" data-id="${escape(row.conversation_id)}" ${current?'aria-current="page"':''}><span class="lc-history-title">${escape(title(row.title,'未命名对话'))}</span><span class="lc-history-meta">${running?'<span class="lc-history-running">进行中</span>':date?`<time>${escape(date)}</time>`:'<span>已保存</span>'}${row.unread===true?'<span class="lc-unread" aria-label="有新内容"></span>':''}</span></button>`;}).join('')||'<div class="lc-history-empty">这里会保留你与当前知识库的对话。</div>';
}
function historyMarkup(state){
 return `<aside class="lc-history" aria-label="历史对话"><div class="lc-history-heading"><span class="lc-eyebrow">对话</span>${button('＋ 新对话','new-conversation','','primary')}</div><div class="lc-history-list" data-chat-history>${chatHistory(state)}</div><footer>离开页面后可继续查看已保存的进度。</footer></aside>`;
}
function blockKey(block,index){
 if(block.block_id!==undefined)return block.block_id;
 if(block.key!==undefined)return block.key;
 if(block.kind==='step')return block.step_id??block.id??'step-'+index;
 if(block.message_id!==undefined)return block.message_id+':'+(block.segment_seq??block.fragment_seq??block.seq??0);
 return block.id??'text-'+index;
}
function stepMarkup(block,index){
 const value=status(block.status),running=activeStates.has(value),failed=value==='FAILED',unknown=unknownStates.has(value),stopped=stoppedStates.has(value),label=failed?'未完成':unknown?'待确认':stopped?'已停止':running?'进行中':doneStates.has(value)?'已完成':'已记录';
 return `<div class="lc-step ${running?'is-running':failed?'is-failed':unknown?'is-waiting':''}" data-chat-block="${escape(blockKey(block,index))}" data-block-kind="step" role="status"><span class="lc-step-icon" aria-hidden="true">${failed?'!':unknown?'◌':running?'◌':'✓'}</span><span class="lc-step-label">${escape(text(block.label)||'已记录处理步骤')}</span><span class="lc-step-state">${label}</span></div>`;
}
function turnMarkup(state,turn){
 const current=turn.turn_id===activeTurn(state)?.turn_id,info=turnState(turn),blocks=list(turn.blocks),used=usedCitations(turn),hasText=blocks.some(block=>block?.kind==='text'&&typeof block.html==='string'&&block.html.trim());
 const body=blocks.map((block,index)=>block?.kind==='step'?stepMarkup(block,index):block?.kind==='text'&&typeof block.html==='string'?`<div class="lc-markdown" data-chat-block="${escape(blockKey(block,index))}" data-block-kind="text">${block.html}</div>`:'').join('');
 const incomplete=stoppedStates.has(status(turn.status))?'回答已停止，以下保留已生成的内容，尚未完成。':status(turn.status)==='FAILED'?'本次回答未完成，已显示内容保留。':unknownStates.has(status(turn.status))?'本次处理结果仍待确认，已显示内容保留。':turn.unfinished===true?'这轮保留的是未完成正文，尚不能作为完整回答。':'';
 return `<article class="lc-turn ${current?'is-current':''}" data-chat-turn="${escape(turn.turn_id)}" data-turn="${escape(turn.turn_id)}"><div class="lc-user-message"><span class="lc-speaker">你</span><p>${escape(turn.question??'')}</p></div><section class="lc-assistant-message" aria-label="LightOG 回答"><header class="lc-answer-heading"><span class="lc-assistant-name"><i aria-hidden="true">✳</i>LightOG</span>${badge(info.label,info.tone)}${button('查看本轮依据','select-turn',`data-turn="${escape(turn.turn_id)}" ${current?'aria-current="true"':''}`,'lc-turn-evidence')}</header>${turn.historical===true?'<p class="lc-partial-notice">这是此前知识版本的回答，引用仍按保留的原版本核对。</p>':''}${incomplete?`<p class="lc-partial-notice">${escape(incomplete)}</p>`:''}<div class="lc-answer-blocks" data-chat-turn-blocks="${escape(turn.turn_id)}">${body||`<p class="lc-answer-pending">${activeStates.has(status(turn.status))?'正在读取已保存的知识与资料…':stoppingStates.has(status(turn.status))?'正在确认停止状态，已显示内容会保留。':'本轮尚未保存回答正文。'}</p>`}</div>${state.memory_enabled===true&&hasText?`<div class="lc-answer-secondary">${button('补充信息','supplement-info',`data-turn="${escape(turn.turn_id)}"`,'lc-supplement-action')}</div>`:''}${hasText||!activeStates.has(status(turn.status))?`<footer class="lc-used-sources"><span>本轮引用</span>${used.length?`<div>${used.map(row=>button('['+row.number+'] '+title(row.label,kindLabel(row.kind)),'citation',citationAttributes(turn,row),'lc-used-source')).join('')}</div>`:`<p>${activeStates.has(status(turn.status))?'正文尚未引用来源。':'未引用任何来源'}</p>`}</footer>`:''}</section></article>`;
}

export function chatTimeline(state){
 const turns=list(state.turns);
 return turns.length?turns.map(turn=>turnMarkup(state,turn)).join(''):'<div class="lc-chat-empty"><span aria-hidden="true">✳</span><h2>从一个问题开始</h2><p>围绕当前知识库提问，沿回答中的引用核对保留原文。</p></div>';
}
function precision(source){
 if(source.precision==='EXACT_SPAN'||source.granularity==='SPAN')return {label:'已校验原文范围',exact:true};
 if(source.precision==='BLOCK_ASSOCIATION'||source.granularity==='BLOCK')return {label:'原文块级关联',exact:false};
 return {label:'资料级来源',exact:false};
}
function sourceMarkup(source,index,turn,row,{preview=false}={}){
 if(source.kind==='MEMORY_RECORD_SOURCE')return `<article class="lc-source lc-record-source"><header><strong>${escape(source.title??'原始记录')}</strong>${badge('原始记录版本','quiet')}</header><p class="lc-source-note">${escape(source.precision_note??'原话来源性质不等于独立核验。')}</p>${list(source.quotes).map(quote=>`<blockquote>${escape(text(quote))}</blockquote>`).join('')}${source.available===true?button('打开原始记录','open-source',`${citationAttributes(turn,row)} data-index="${index}"`,'lc-open-source')+button('补充结果','supplement-result',`${citationAttributes(turn,row)} data-index="${index}"`,'lc-record-secondary-action')+button('纠正原话','supplement-correction',`${citationAttributes(turn,row)} data-index="${index}"`,'lc-record-secondary-action'):'<p class="lc-source-note">此原始版本暂不可读，没有替用其他记录或文档。</p>'}</article>`;
 const range=precision(source),quotes=list(source.quotes).map(text).filter(Boolean),unverified=list(source.unverified_quotes).map(text).filter(Boolean),version=typeof source.revision==='string'?source.revision:null;
 if(preview)return `<article class="lc-source"><header><strong>${escape(title(source.title,'保留资料'))}</strong>${badge(range.label,'quiet')}</header>${quotes.length?quotes.map(quote=>`<blockquote>${range.exact?`<mark>${escape(quote)}</mark>`:escape(quote)}</blockquote>`).join(''):`<p class="lc-source-note">${range.exact?'本次尚未读回可展示的引句。':range.label==='原文块级关联'?'此依据只保存了正文块关联，不作精确原句高亮。':'此依据未保存可校验的原句位置。'}</p>`}${unverified.length?`<div class="lc-unverified"><small>位置尚未校验的上下文</small>${unverified.map(quote=>`<blockquote>${escape(quote)}</blockquote>`).join('')}</div>`:''}</article>`;
 return `<article class="lc-source"><header><strong>${escape(title(source.title,'保留资料'))}</strong>${badge(range.label,'quiet')}</header>${version?`<small title="${escape(version)}">资料版本 ${escape(version.length>20?version.slice(0,12)+'…'+version.slice(-6):version)}</small>`:'<small>未保存可绑定的资料版本</small>'}${quotes.length?quotes.map(quote=>`<blockquote>${range.exact?`<mark>${escape(quote)}</mark>`:escape(quote)}</blockquote>`).join(''):`<p class="lc-source-note">${range.exact?'本次尚未读回可展示的引句。':range.label==='原文块级关联'?'此依据只保存了正文块关联，不作精确原句高亮。':'此依据未保存可校验的原句位置。'}</p>`}${unverified.length?`<div class="lc-unverified"><small>位置尚未校验的上下文</small>${unverified.map(quote=>`<blockquote>${escape(quote)}</blockquote>`).join('')}</div>`:''}${source.precision_note?`<p class="lc-source-note">${escape(text(source.precision_note))}</p>`:''}${source.available===true?button(source.action_label??(range.exact?'打开同版本原文':'打开对应资料'),'open-source',`${citationAttributes(turn,row)} data-index="${index}"`,'lc-open-source'):'<p class="lc-source-note">此来源版本暂不可读，没有替用其他资料或版本。</p>'}</article>`;
}
function citationDetails(citation,turn,row,{preview=false}={}){
 const conditions=list(citation.conditions).map(text).filter(Boolean),sources=list(citation.sources),human=list(citation.human_sources),definitions=definitionChoicesOf(citation);
 const renderSources=background=>sources.map((source,index)=>({source,index})).filter(({source})=>(source.evidence_role==='CORRECTION_BACKGROUND_ONLY')===background).map(({source,index})=>sourceMarkup(source,index,turn,row,{preview})).join('');
 const manual=human.length?`<section class="lc-human-evidence" aria-label="人工修订依据"><h4>人工修订</h4><p class="lc-source-note">以下更正来自已保存的人工决定，与原文证据分别保留。</p>${human.map(source=>`<article><p>${escape(source.reason||'本次人工决定未附说明。')}</p>${!preview&&source.original_text?`<details><summary>修订前知识</summary><p>${escape(source.original_text)}</p></details>`:''}${!preview?`<small>决定 ${escape(source.review_event_ref??'待核对')} · 原知识版本 ${escape(source.source_revision_ref??'待核对')}</small>`:''}</article>`).join('')}</section>`:'';
 const definitionChoices=definitions.length?`<section class="lc-human-evidence" aria-label="人工定义选择依据"><h4>人工定义选择</h4><p class="lc-source-note">仅规范定义或标签的选择来自已保存的人工决定。事实内容继续对应原件及其原有精度；原件不因此被视为出现了选定的规范名称。</p>${definitions.map(source=>`<article><dl><dt>原表达标签</dt><dd>${escape(source.original_label??'原标签未保存')}</dd><dt>选定的规范定义</dt><dd>${escape(source.selected_label??'选定名称未保存')}</dd></dl>${source.reason?`<p>${escape(source.reason)}</p>`:''}</article>`).join('')}</section>`:'';
 const definitionUnbound=citation.definition_selection_status==='UNBOUND'||list(citation.definition_selection_warnings).length?'<p class="lc-source-note">规范定义选择的人工凭据尚未完整绑定；未将其当作已确认的定义来源，事实原文仍按原精度保留。</p>':'';
 const natures=list(citation.records),mixed=human.length&&natures.some(record=>record.origin_layer!=='HUMAN_CORRECTION');
 const byRecord=mixed?`<section aria-label="逐条依据性质"><h4>逐条依据</h4>${natures.map(record=>`<article>${badge(record.origin_layer==='HUMAN_CORRECTION'?'人工修订':'资料抽取','quiet')}${record.text?`<p>${escape(record.text)}</p>`:''}</article>`).join('')}</section>`:'';
 const backgrounds=renderSources(true),evidence=renderSources(false);
 const original=backgrounds?`<section aria-label="修订前原文对照"><h4>修订前原文对照</h4><p class="lc-source-note">原文用于核对被修订内容，不代表支持更正后的表述。</p>${backgrounds}</section>`:'';
 if(preview)return definitionChoices+definitionUnbound+manual+evidence+original||`<p class="lc-evidence-empty">${citation.loading?'正在读取保留原文…':'此依据未附可定位的保留原文，不补造引句或位置。'}</p>`;
 return `${citation.representation==='INDEXED_SOURCE_WITH_MAPPING'?'<p class="lc-source-note">资料片段可能由多个正文块整理而成，请打开保留原文核对。</p>':''}${citation.text?`<p class="lc-citation-text">${escape(citation.text)}</p>`:''}${conditions.length?`<div class="lc-citation-conditions"><span>适用条件</span><p>${escape(conditions.join('；'))}</p></div>`:''}${byRecord}${definitionChoices}${definitionUnbound}${manual}${evidence}${original}${!manual&&!evidence&&!original&&!definitionChoices?`<p class="lc-evidence-empty">${citation.loading?'正在读取保留原文…':'此依据未附可定位的保留原文，不补造引句或位置。'}</p>`:''}`;
}
export function chatEvidence(state){
 const turn=activeTurn(state),rows=usedCitations(turn),selected=rows.find(row=>matchingCitation(state,turn,row.number)),citation=selected?matchingCitation(state,turn,selected.number):null;
 return `<header class="lc-evidence-heading"><span class="lc-eyebrow">依据</span><h2>${citation?'引用 ['+selected.number+']':'本轮采用的依据'}</h2>${turn?`<p>${escape(turn.question??'')}</p>`:''}</header><div class="lc-evidence-content">${rows.length?`<nav class="lc-citation-list" aria-label="本轮已引用来源">${rows.map(row=>`<button type="button" data-chat-action="citation" ${citationAttributes(turn,row)} ${selected?.number===row.number?'aria-current="true"':''}><span class="lc-citation-number">[${row.number}]</span><span><strong>${escape(title(row.label,kindLabel(row.kind)))}</strong><small>${evidenceLabel(row.citation??row)}</small></span></button>`).join('')}</nav>`:`<div class="lc-evidence-empty">${turn&&activeStates.has(status(turn.status))?'本轮尚未采用引用。':'未引用任何来源'}</div>`}${citation?`<section class="lc-selected-evidence"><div class="lc-selected-evidence-title">${badge(evidenceLabel(citation))}<h3>${escape(citation.label)}</h3></div>${citationDetails(citation,turn,selected)}</section>`:rows.length?'<p class="lc-evidence-hint">选择句末角标或上方来源，先预览引句，再打开保留原文。</p>':''}</div>`;
}

export function chatPopover(state){
 const popover=state.popover;if(!popover)return '';
 const turn=list(state.turns).find(row=>row.turn_id===popover.turn_id),number=citationNumber(popover.number),row=usedCitations(turn).find(item=>item.number===number);if(!turn||!row)return '';
 const citation=matchingCitation(state,turn,number),sourceIndex=list(citation?.sources).findIndex(source=>source.available===true);
 const action=sourceIndex>=0?button(list(citation?.sources)[sourceIndex]?.evidence_role==='CORRECTION_BACKGROUND_ONLY'?'打开修订前原文':'打开原文','open-source',`${citationAttributes(turn,row)} data-index="${sourceIndex}"`,'lc-open-source primary'):citation&&!citation.loading?'<p class="lc-source-note">此来源版本暂不可读，没有替用其他资料或版本。</p>':'';
 return `<aside class="lc-popover" role="dialog" aria-modal="false" aria-label="引用 [${number}] 原文预览" data-chat-popover data-turn="${escape(turn.turn_id)}" data-number="${number}"><header><h3>引用 [${number}]</h3>${button('关闭','close-preview','aria-label="关闭引用预览"','lc-close-preview')}</header><div class="lc-popover-content">${citation?citationDetails(citation,turn,row,{preview:true}):'<p class="lc-evidence-empty" role="status">正在读取保留原文预览…</p>'}</div>${action?`<footer class="lc-popover-actions" data-chat-preview-actions>${action}</footer>`:''}</aside>`;
}
function connectionMarkup(state){
 const value=status(typeof state.connection==='string'?state.connection:state.connection?.status);
 const reconnecting=['RECONNECTING','CONNECTING'].includes(value),offline=['DISCONNECTED','OFFLINE'].includes(value),message=reconnecting?'正在恢复连接':offline?'连接中断，已显示内容保留':activeStates.has(status(runningTurn(state)?.status))?'正在接收回答':state.busy?'正在提交请求':'';
 return `<span class="lc-connection ${reconnecting||offline?'waiting':''}" data-chat-connection role="status" ${message?'':'hidden'}>${message}</span>`;
}
export function chatStatus(state){
 const error=publicError(state.error),notice=text(state.notice);
 return `${connectionMarkup(state)}<div class="lc-chat-notice" data-chat-notice role="status" ${notice?'':'hidden'}>${escape(notice)}</div><div class="lc-chat-error" data-chat-error role="alert" ${error?'':'hidden'}>${escape(error)}</div>`;
}
function composerMarkup(state){
 const turn=runningTurn(state),value=status(turn?.status),stopping=stoppingStates.has(value),showStop=Boolean(turn),canSubmit=state.can_submit===true,canStop=state.can_stop===true;
 return `<div class="lc-composer-dock"><form class="lc-composer" data-chat-form><label for="lightog-chat-question">你的问题</label><textarea id="lightog-chat-question" name="question" data-chat-draft rows="2" placeholder="你的问题…" aria-label="你的问题">${escape(state.draft??'')}</textarea><div class="lc-composer-bottom"><span>引用可回到保留原文核对</span><div>${button(stopping?'正在停止…':'停止','stop',`data-chat-stop data-turn="${escape(turn?.turn_id??'')}" ${!canStop||stopping?'disabled':''} ${showStop?'':'hidden'}`,'lc-stop')}<button type="submit" data-chat-send class="lc-button primary lc-send" ${!canSubmit||!String(state.draft??'').trim()?'disabled':''}>发送 <span aria-hidden="true">↑</span></button></div></div></form></div>`;
}
export function chatMarkup(state){
 const panel=['history','evidence'].includes(state.mobile_panel)?state.mobile_panel:'timeline';
 return `<section class="lc-chat" data-chat-view data-chat-shell data-panel="${panel}" aria-label="知识库问答"><nav class="lc-mobile-tabs" aria-label="问答面板">${button('历史对话','panel',`data-panel="history" aria-pressed="${panel==='history'}"`)}${button('对话','panel',`data-panel="timeline" aria-pressed="${panel==='timeline'}"`)}${button('引用依据','panel',`data-panel="evidence" aria-pressed="${panel==='evidence'}"`)}</nav>${historyMarkup(state)}<section class="lc-chat-main" aria-label="当前对话"><header class="lc-chat-heading"><div><h1>问答</h1><p>围绕当前知识库</p></div></header><div class="lc-chat-status" data-chat-status>${chatStatus(state)}</div><div class="lc-timeline" data-chat-timeline aria-label="对话内容" aria-live="off">${chatTimeline(state)}</div>${state.memory_enabled===true?'<div data-chat-supplement-host></div>':''}${composerMarkup(state)}</section><aside class="lc-evidence" aria-label="本轮引用依据" data-chat-evidence>${chatEvidence(state)}</aside><div data-chat-popover-host>${chatPopover(state)}</div></section>`;
}
