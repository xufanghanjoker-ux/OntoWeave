/** Chat-only UI. Product reads/writes are delegated to the version-bound client. */
import {createLightogChatClient} from './lightog-chat-client-v1.mjs';
import {renderLightogChatMarkdown} from './assets/lightog-chat-markdown-v1.mjs';
import {chatMarkup,chatTimeline,chatEvidence,chatPopover,chatHistory,chatStatus} from './lightog-chat-view-v1.mjs';
import {projectLightogQueryCitation} from './lightog-query-citations-v1.mjs';
const list=value=>Array.isArray(value)?value:[];
const terminal=turn=>turn?.status==='STALE'&&!turn.historical_status||['COMPLETED','NEEDS_CLARIFICATION','FAILED','UNKNOWN_HOLD','INTERRUPTED','CANCELLED','STOPPED','STALE'].includes(turn?.status==='STALE'?turn.historical_status:turn?.status);
const escapeMarkdown=value=>String(value??'').replace(/[\\`*_{}\[\]<>#!|]/g,'\\$&');
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
/** Only the exact formal raw-record endpoint can make a typed record source readable. */
export async function readLightogMemoryCitationSources({citation,libraryId,api}){
 const kinds={HUMAN_TEXT:'人工陈述',AGENT_REPORT:'Agent 报告',TOOL_RECEIPT:'工具回执',DOCUMENT:'记录来源'};
 return Promise.all(list(citation?.record_sources).map(async source=>{
  const base={...structuredClone(source),kind:'MEMORY_RECORD_SOURCE',precision:'RECORD_VERSION_ONLY',quotes:[],unverified_quotes:[],available:false,title:kinds[source?.source_kind]??'原始记录',action_label:'打开原始记录',precision_note:'这是原始记录版本，来源性质不等于独立核验。'};
  if(source?.kind!=='MEMORY_RECORD_SOURCE'||source.document_evidence_eligible!==false||typeof source.record_ref!=='string'||!source.record_ref||typeof source.revision!=='string'||!source.revision)return {...base,precision_note:'原始记录引用绑定不完整，未替用其他版本。'};
  try{const result=await api('/api/product/memory/v1/records/'+encodeURIComponent(source.record_ref)+'?library_id='+encodeURIComponent(libraryId)),raw=result?.record;
   if(result?.schema_version!=='MEMORY_PRODUCT_V1'||result.library_id!==libraryId||raw?.record_ref!==source.record_ref||String(raw.version)!==source.revision||raw.source?.kind!==source.source_kind||typeof raw.text!=='string'||raw.text_truncated===true)throw Error('record binding mismatch');
   return {...base,available:true,quotes:[raw.text],source_ingested_at:raw.source_ingested_at};
  }catch{return {...base,precision_note:'此原始记录版本暂不可读，未替用最新原话或文档。'};}
 }));
}
function legacyBody(turn,registry){
 const answer=turn.answer??turn.partial_answer;if(!answer)return '';
 const numbers=new Map(registry.map(row=>[row.citation_ref,row.number]));
 const rows=list(answer.statements).map(row=>escapeMarkdown(row.text)+list(row.citation_refs).filter(ref=>numbers.has(ref)).map(ref=>'['+numbers.get(ref)+']').join(''));
 if(list(answer.unanswered).length)rows.push('### 尚缺依据\n'+answer.unanswered.map(text=>'- '+escapeMarkdown(text)).join('\n'));
 if(answer.clarification)rows.push(escapeMarkdown(answer.clarification));return rows.join('\n\n');
}
export function projectLightogChatTurn(turn){
 const answer=turn.answer??turn.partial_answer,registry=list(turn.citations).length?turn.citations:list(answer?.citations).map((row,index)=>row?.citation?row:{number:index+1,citation_ref:row.citation_ref,citation:row});
 const id=turn.turn_id??turn.query_ref,rawBlocks=list(turn.blocks),messages=rawBlocks.filter(block=>block.kind==='message');
 const grouped=new Map(),parts=new Map();for(const block of messages){grouped.set(block.message_id,(grouped.get(block.message_id)??'')+block.markdown);parts.set(block.message_id,(parts.get(block.message_id)??0)+1);}
 const parsedMessages=new Map([...grouped].map(([messageId,markdown])=>[messageId,renderLightogChatMarkdown(markdown,{registry,turnId:id})]));
 const blocks=rawBlocks.map((block,index)=>block.kind==='message'?{kind:'text',key:block.message_id+':'+(block.seq??index),message_id:block.message_id,markdown:block.markdown,html:parts.get(block.message_id)>1&&parsedMessages.get(block.message_id).has_protected_syntax?'<div class="lc-fragment-text">'+escapeHtml(block.markdown)+'</div>':renderLightogChatMarkdown(block.markdown,{registry,turnId:id}).html}:{kind:'step',key:block.step_id,label:block.label,status:block.status,returned:block.returned});
 let markdown=[...grouped.values()].join('\n\n');
 if(!messages.length){markdown=answer?.format==='markdown'?answer.markdown??'':legacyBody(turn,registry);if(markdown)blocks.push({kind:'text',key:'saved-answer',markdown,html:renderLightogChatMarkdown(markdown,{registry,turnId:id}).html});}
 const parsed=messages.length?[...parsedMessages.values()]:[renderLightogChatMarkdown(markdown,{registry,turnId:id})];
 const used=[...new Set(parsed.flatMap(row=>row.used_numbers))].map(number=>registry.find(row=>row.number===number)).filter(Boolean).map(row=>({...row,label:row.citation?.label??'保存的来源',kind:row.citation?.kind??'SOURCE'}));
 return {...turn,status:turn.status==='STALE'?(turn.historical_status&&turn.historical_status!=='STALE'?turn.historical_status:'STOPPED'):turn.status,turn_id:id,blocks,markdown,registry,used_citations:used,unknown_numbers:[...new Set(parsed.flatMap(row=>row.unknown_numbers))],unfinished:!['COMPLETED','NEEDS_CLARIFICATION'].includes(turn.status==='STALE'?turn.historical_status:turn.status),legacy:answer?.format!=='markdown'&&!list(turn.events).length};
}

const keyOf=node=>node?.nodeType===1?(node.getAttribute('data-chat-turn')??node.getAttribute('data-chat-block')??node.getAttribute('data-chat-history-id')):null;
/** Retain unchanged nodes and scroll/selection while real streamed text grows. */
function morph(oldNode,newNode){
 if(oldNode.nodeType!==newNode.nodeType||oldNode.nodeType===1&&(oldNode.tagName!==newNode.tagName||keyOf(oldNode)!==keyOf(newNode))){oldNode.replaceWith(newNode.cloneNode(true));return;}
 if(oldNode.nodeType===3){const text=newNode.nodeValue??'',previous=oldNode.nodeValue??'';if(text!==previous){if(text.startsWith(previous)&&oldNode.appendData)oldNode.appendData(text.slice(previous.length));else oldNode.nodeValue=text;}return;}
 if(oldNode.nodeType!==1)return;
 if(oldNode.outerHTML===newNode.outerHTML)return;
 for(const attr of [...oldNode.attributes])if(!newNode.hasAttribute(attr.name))oldNode.removeAttribute(attr.name);
 for(const attr of [...newNode.attributes])if(oldNode.getAttribute(attr.name)!==attr.value)oldNode.setAttribute(attr.name,attr.value);
 let index=0;for(const next of [...newNode.childNodes]){let old=oldNode.childNodes[index];const key=keyOf(next);if(key&&keyOf(old)!==key){const match=[...oldNode.childNodes].slice(index).find(node=>keyOf(node)===key);if(match){oldNode.insertBefore(match,old??null);old=match;}}
  if(!old)oldNode.append(next.cloneNode(true));else morph(old,next);index++;}
 while(oldNode.childNodes.length>index)oldNode.lastChild.remove();
}
function patchContents(target,html){if(!target)return;const template=target.ownerDocument?.createElement?.('template');if(!template?.content){target.innerHTML=html;return;}template.innerHTML=html;const shell=target.cloneNode(false);shell.append(template.content.cloneNode(true));morph(target,shell);}

export function createLightogChatWorkspace({api,requestStream,uuid=()=>crypto.randomUUID(),storage=globalThis.localStorage,document:doc=globalThis.document,readModel=()=>null,projectCitation=null,matchesScope=()=>false,canAsk=()=>false,onOpenSource=()=>{},onOpenGraph=()=>{},onRoute=()=>{},onError=()=>{},memoryEnabled=false,memoryApi=api,memoryWorkspaceFactory=null,onMemoryReturn=async()=>null,contextualMemoryFactory=null,contextualMemoryRenderer=null}={}){
 let host=null,libraryId=null,epoch=0,viewError=null,selectedTurn=null,selectedCitation=null,popover=null,anchor=null,mobilePanel='timeline';
 let inputMode='ask',memoryWorkspace=null,memoryPromise=null,lastAttachment={};
 let contextual=null,contextualPromise=null,contextualRenderer=contextualMemoryRenderer,supplementEpoch=0,supplementRenderKey=null;
 const supplementConfirmations=new Set(),supplementScopeRefreshes=new Set();
 const drafts=new Map(),positions=new Map(),snapshots=new Map(),mutations=new Set();
 const client=createLightogChatClient({api,requestStream,uuid,storage,onChange:snapshot=>{snapshots.set(snapshot.library_id,snapshot);if(host&&snapshot.library_id===libraryId)render();}});
 const current=()=>snapshots.get(libraryId)??client.snapshot(libraryId);
 const positionKey=raw=>libraryId+':'+(raw.conversation_id??raw.query_ref??'new');
 function viewModel(){
  const raw=current(),mutationBusy=mutations.has(libraryId),turns=raw.turns.map(projectLightogChatTurn),active=turns.find(t=>t.turn_id===selectedTurn)??turns.at(-1),running=turns.findLast(t=>!terminal(t));
  const historical=list(raw.legacy_queries).map(query=>({conversation_id:'legacy:'+query.query_ref,title:query.question??'历史问答',status:query.status,updated_at:query.updated_at??query.ended_at??query.created_at??null,legacy:true,query_ref:query.query_ref}));
  const conversations=raw.conversations.map(conversation=>conversation.conversation_id===raw.conversation_id?{...conversation,status:raw.turns.at(-1)?.status??conversation.status,turn_count:raw.turns.length}:conversation);if(raw.conversation_id&&!conversations.some(conversation=>conversation.conversation_id===raw.conversation_id)){const last=raw.turns.at(-1);conversations.unshift({conversation_id:raw.conversation_id,title:raw.turns[0]?.question??'新对话',status:last?.status??raw.status,turn_count:raw.turns.length,updated_at:last?.events?.at(-1)?.at??null});}
  return {library_id:libraryId,memory_enabled:memoryEnabled===true,conversations:[...conversations,...historical],selected_conversation_id:raw.conversation_id??(raw.query_ref?'legacy:'+raw.query_ref:null),turns,active_turn_id:active?.turn_id??null,draft:drafts.get(libraryId)??'',busy:mutationBusy,can_submit:!supplementScopeRefreshes.has(libraryId)&&canAsk()&&!raw.locked&&!mutationBusy,can_stop:Boolean(running?.query_ref)&&!mutationBusy&&!running.cancel_pending,connection:raw.turns.some(turn=>turn.query_ref===raw.stream?.query_ref&&!terminal(turn))?raw.stream.status:'CLOSED',status:raw.status,notice:raw.pending&&!raw.pending.query_ref?'问题提交结果待确认，已暂停重复提交；系统不会自动重发。':raw.pending?.cancel_pending?'停止结果尚待确认，已保留收到的正文。':!canAsk()?'当前阅读版本尚未与问答版本对齐，历史内容仍可查看。':null,error:viewError??raw.error?.message??null,selected_citation:selectedCitation?.turn_id===active?.turn_id?selectedCitation:null,popover:popover?.turn_id===active?.turn_id?popover:null,mobile_panel:mobilePanel};
 }
 function rememberPosition(){const pane=host?.querySelector('[data-chat-timeline]');if(pane&&libraryId)positions.set(positionKey(current()),pane.scrollTop);}
 function render({full=false,restore=false,forceFollow=false}={}){
  if(!host||inputMode==='records')return;const state=viewModel(),timeline=host.querySelector('[data-chat-timeline]'),before=timeline?.scrollTop??0,follow=!timeline||timeline.scrollHeight-timeline.clientHeight-before<90;
  if(full||!timeline)host.innerHTML=chatMarkup(state);else{
   patchContents(host.querySelector('[data-chat-history]'),chatHistory(state));patchContents(timeline,chatTimeline(state));patchContents(host.querySelector('[data-chat-evidence]'),chatEvidence(state));patchContents(host.querySelector('[data-chat-popover-host]'),chatPopover(state));patchContents(host.querySelector('[data-chat-status]'),chatStatus(state));
  }
  const pane=host.querySelector('[data-chat-timeline]');if(pane)pane.scrollTop=forceFollow?pane.scrollHeight:restore?(positions.get(positionKey(current()))??pane.scrollHeight):follow?pane.scrollHeight:before;
  const input=host.querySelector('[data-chat-draft]');if(input&&input.value!==state.draft)input.value=state.draft;
  const submit=host.querySelector('[data-chat-send]');if(submit)submit.disabled=!state.can_submit||!state.draft.trim();
  const stop=host.querySelector('[data-chat-stop]'),running=state.turns.findLast(turn=>!terminal(turn));if(stop){stop.disabled=!state.can_stop;stop.hidden=!running;stop.dataset.turn=running?.turn_id??'';stop.textContent=running?.cancel_pending?'正在停止…':'停止';}
  const shell=host.querySelector('[data-chat-shell]');if(shell)shell.dataset.panel=mobilePanel;for(const tab of host.querySelectorAll('[data-chat-action="panel"]'))tab.setAttribute('aria-pressed',String(tab.dataset.panel===mobilePanel));
  const floating=host.querySelector('[data-chat-popover]');if(floating&&anchor){const width=Math.min(420,(doc.documentElement?.clientWidth??1280)-24),windowHeight=doc.documentElement?.clientHeight??720;floating.style.width=width+'px';floating.style.right='auto';floating.style.bottom='auto';const height=floating.getBoundingClientRect().height;floating.style.left=Math.max(12,Math.min(anchor.left,(doc.documentElement?.clientWidth??1280)-width-12))+'px';floating.style.top=Math.max(12,Math.min(anchor.bottom+8,windowHeight-Math.min(height,windowHeight-24)-12))+'px';}
  renderSupplement({force:full});
 }
 function renderSupplement({force=false}={}){
  const pane=host?.querySelector('[data-chat-supplement-host]');if(!pane)return;
  const state=contextual?.snapshot();if(!state?.open||state.library_id!==libraryId||inputMode!=='ask'){if(pane.innerHTML)pane.innerHTML='';supplementRenderKey=null;return;}
  if(!contextualRenderer)return;
  const key=JSON.stringify([state.library_id,state.intent,state.anchor,state.target_record?.record_ref,state.target_loading,state.target_error,state.busy,state.submitted,state.locked,state.error,state.receipt?.processing,state.receipt?.publication]);
  if(force||key!==supplementRenderKey){pane.innerHTML=contextualRenderer(state);supplementRenderKey=key;}
  for(const field of ['text','reason','time_text']){const element=pane.querySelector?.('[data-chat-supplement-field="'+field+'"]');if(element&&element.value!==(state.draft?.[field]??''))element.value=state.draft?.[field]??'';}
  const submit=pane.querySelector?.('[data-chat-supplement-submit]');if(submit)submit.disabled=Boolean(state.busy||state.locked||!state.draft?.text?.trim()||state.target_loading||state.target_error||state.intent!=='SAVE'&&!state.target_record||state.intent==='CORRECTION'&&!state.draft?.reason?.trim()||state.submitted&&state.operation?.raw_saved===true);
 }
 async function refreshSupplementScope(state){
  const publication=state.receipt?.publication,confirmation=publication?.confirmation_ref,id=state.library_id;
  if(!state.open||publication?.queryable!==true||typeof confirmation!=='string'||!confirmation||supplementConfirmations.has(JSON.stringify([id,confirmation]))||!host||id!==libraryId||inputMode!=='ask')return;
  supplementConfirmations.add(JSON.stringify([id,confirmation]));supplementScopeRefreshes.add(id);render();
  try{const refreshed=await onMemoryReturn({libraryId:id});if(host&&libraryId===id&&refreshed?.pin){lastAttachment={...lastAttachment,pin:refreshed.pin};client.noteVersion({libraryId:id,pin:refreshed.pin});}}
  catch(error){if(host&&libraryId===id)viewError=error.message;}
  finally{supplementScopeRefreshes.delete(id);if(host&&libraryId===id)render();}
 }
 async function ensureContextual(){
  contextualPromise??=(async()=>{const factory=contextualMemoryFactory??(await import('./lightog-contextual-memory-v1.mjs')).createLightogContextualMemory;
   contextualRenderer??=(await import('./lightog-memory-view-v1.mjs')).contextualMemoryMarkup;
   contextual=factory({api:memoryApi,storage,uuid,onChange:state=>{if(host&&state?.library_id===libraryId){renderSupplement();void refreshSupplementScope(state);}}});return contextual;
  })().catch(error=>{contextualPromise=null;throw error;});return contextualPromise;
 }
 async function openSupplement({turnId=null,intent='SAVE',targetRecord=null}={}){
  if(!host||inputMode!=='ask'||memoryEnabled!==true)return;const id=libraryId,selection=++supplementEpoch,turn=viewModel().turns.find(row=>row.turn_id===turnId)??viewModel().turns.at(-1);
  if(!turn)return;const controller=await ensureContextual();if(!host||libraryId!==id||selection!==supplementEpoch||inputMode!=='ask')return;
  await controller.open({libraryId:id,intent,anchor:{turnId:turn.turn_id,label:turn.question??'',queryRef:turn.query_ref??null},...(targetRecord?{targetRecord}:{})});
  if(host&&libraryId===id&&selection===supplementEpoch)renderSupplement();
 }
 function syncRoute(){const raw=current(),turn=raw.turns.find(t=>(t.turn_id??t.query_ref)===selectedTurn)??raw.turns.at(-1);lastAttachment={...lastAttachment,conversationId:raw.conversation_id??null,queryRef:turn?.query_ref??raw.query_ref??null,turnId:turn?.turn_id??turn?.query_ref??null};onRoute({library_id:libraryId,conversation_id:raw.conversation_id,query_ref:lastAttachment.queryRef,chat_turn_id:lastAttachment.turnId});}
 async function loadChat(selection,id,{conversationId=null,queryRef=null,pin=null}={}){
  if(pin)client.noteVersion({libraryId:id,pin});render({full:true,restore:true});await client.list({libraryId:id});if(!host||selection!==epoch||libraryId!==id||inputMode!=='ask')return;
  const raw=client.snapshot(id),conversation=conversationId??raw.conversation_id,query=queryRef??raw.query_ref;
  if(conversation||query)await client.open({libraryId:id,...(conversation?{conversationId:conversation}:{queryRef:query})});
  if(!host||selection!==epoch||libraryId!==id||inputMode!=='ask')return;render({restore:true});syncRoute();subscribe();
 }
 async function openAsk(){
  if(!host)return;memoryWorkspace?.detach();inputMode='ask';viewError=null;const id=libraryId,selection=++epoch;
  onRoute({library_id:id,memory_mode:null,memory_record_ref:null});
  try{const refreshed=await onMemoryReturn({libraryId:id});if(!host||libraryId!==id||selection!==epoch)return;if(refreshed?.pin)lastAttachment={...lastAttachment,pin:refreshed.pin};await loadChat(selection,id,lastAttachment);}catch(error){if(host&&libraryId===id){viewError=error.message;render({full:true});}}
 }
 async function ensureMemory(){
  memoryPromise??=(async()=>{const factory=memoryWorkspaceFactory??(await import('./lightog-memory-workspace-v1.mjs')).createLightogMemoryWorkspace;
   memoryWorkspace=factory({api:memoryApi,storage,uuid,document:doc,onAsk:()=>{void openAsk();},onRoute:frame=>{if(host&&inputMode==='records'&&frame.library_id===libraryId)onRoute({...frame,memory_mode:'records'});},onError:message=>onError(message)});return memoryWorkspace;
  })().catch(error=>{memoryPromise=null;throw error;});return memoryPromise;
 }
 async function openMemory(recordRef=null){
  if(!host||memoryEnabled!==true)return;rememberPosition();client.closeStream({libraryId});inputMode='records';popover=null;const id=libraryId,selection=++epoch;
  onRoute({library_id:id,memory_mode:'records',memory_record_ref:recordRef});host.innerHTML='<p class="lc-chat-notice" role="status">正在读取原始记录…</p>';
  try{const workspace=await ensureMemory();if(!host||libraryId!==id||selection!==epoch||inputMode!=='records')return;await workspace.attach({host,libraryId:id,recordRef});}
  catch(error){if(host&&libraryId===id&&selection===epoch){inputMode='ask';viewError='记录入口暂不可用，原有问答仍可使用。';onRoute({library_id:id,memory_mode:null,memory_record_ref:null});render({full:true});onError(viewError);}}
 }
 function subscribe(){const raw=current(),turn=raw.turns.findLast(t=>!terminal(t));if(!turn?.query_ref)return;void client.subscribe({libraryId,queryRef:turn.query_ref}).catch(error=>{if(host){viewError=error.message;render();}});}
 async function selectConversation(id){const idAtStart=libraryId,selection=++epoch;rememberPosition();selectedCitation=null;popover=null;selectedTurn=null;viewError=null;client.closeStream({libraryId});
  const result=await client.open({libraryId,...(id.startsWith('legacy:')?{queryRef:id.slice(7)}:{conversationId:id})});if(!host||selection!==epoch||libraryId!==idAtStart)return;syncRoute();render({restore:true});if(result.status==='UPDATED')subscribe();}
 async function showCitation(turnId,number,button){
  const turn=viewModel().turns.find(row=>row.turn_id===turnId),entry=turn?.used_citations.find(row=>row.number===number);if(!entry)return;
  const selection=++epoch,idAtStart=libraryId;selectedTurn=turnId;popover={turn_id:turnId,number};anchor=button?.getBoundingClientRect?.()??null;viewError=null;
  selectedCitation={turn_id:turnId,query_ref:turn.query_ref,number,kind:entry.citation.kind,label:entry.label,text:'正在读取该引用的保留来源…',sources:[],loading:true};render();
  const response=await client.citation({libraryId,queryRef:turn.query_ref,citationRef:entry.citation_ref});if(!host||selection!==epoch||libraryId!==idAtStart)return;
  if(response.status!=='READY'){viewError=response.error?.message??'该引用尚未读回，未使用其他来源。';selectedCitation=null;render();return;}
  const historical=response.historical||turn.historical||!matchesScope(turn.source_scope);
  const projected=projectCitation?await projectCitation(response.citation,turn.source_scope,{historical}):projectLightogQueryCitation(response.citation,readModel(),{historical});
  if(!host||selection!==epoch||libraryId!==idAtStart)return;
  if(memoryEnabled===true&&list(response.citation.record_sources).length){const sources=await readLightogMemoryCitationSources({citation:response.citation,libraryId:idAtStart,api:memoryApi});if(!host||selection!==epoch||libraryId!==idAtStart)return;projected.sources.push(...sources);projected.record_sources=structuredClone(response.citation.record_sources);}
  selectedCitation={...projected,turn_id:turnId,query_ref:turn.query_ref,conversation_id:turn.conversation_id,number,citation_ref:entry.citation_ref,source_scope:turn.source_scope,historical};render();syncRoute();
 }
 async function click(event){if(inputMode!=='ask')return;const button=event.target.closest('[data-chat-action]');if(!button||button.disabled)return;const action=button.dataset.chatAction;
  try{
   if(action==='supplement-info')await openSupplement({turnId:button.dataset.turn});
   else if(action==='supplement-result'||action==='supplement-correction'){
    const source=selectedCitation?.sources?.[Number(button.dataset.index??0)];if(source?.kind!=='MEMORY_RECORD_SOURCE'||source.available!==true)throw Error('没有确定的原始记录版本，未提交补充或更正。');
    await openSupplement({turnId:button.dataset.turn??selectedCitation.turn_id,intent:action==='supplement-result'?'RESULT':'CORRECTION',targetRecord:{record_ref:source.record_ref,revision:source.revision,source_kind:source.source_kind}});
   }
   else if(action==='supplement-close')contextual?.close();
   else if(action==='supplement-status')await contextual?.refreshStatus();
   else if(action==='supplement-open-record'){
    const state=contextual?.snapshot(),ref=button.dataset.recordRef,receiptRef=state?.receipt?.record?.record_ref??state?.receipt?.record_ref;
    if(state?.open&&state.library_id===libraryId&&typeof ref==='string'&&ref&&(ref===state.target_record?.record_ref||ref===receiptRef))await openMemory(ref);
   }
   else if(action==='memory-records')await openMemory();
   else if(action==='new-conversation'){rememberPosition();++epoch;selectedTurn=null;selectedCitation=null;popover=null;viewError=null;drafts.set(libraryId,'');client.newChat({libraryId});syncRoute();render({restore:true});}
   else if(action==='select-conversation')await selectConversation(button.dataset.id??button.dataset.conversation);
   else if(action==='select-turn'){selectedTurn=button.dataset.turn;selectedCitation=null;popover=null;render();syncRoute();}
   else if(action==='panel'){mobilePanel=button.dataset.panel;render();}
   else if(action==='citation')await showCitation(button.dataset.turn??button.closest('[data-chat-turn]')?.dataset.chatTurn,Number(button.dataset.number),button);
   else if(action==='close-preview'){popover=null;render();}
   else if(action==='open-source'){
    const citation=selectedCitation,source=citation?.sources[Number(button.dataset.index??0)];if(!source?.available)throw Error('此来源版本暂不可读，没有替用其他版本。');
    if(source.kind==='MEMORY_RECORD_SOURCE'){await openMemory(source.record_ref);return;}
    rememberPosition();onOpenSource({libraryId,source,citation,queryRef:citation.query_ref,conversationId:citation.conversation_id,turnId:citation.turn_id,number:citation.number,sourceIndex:Number(button.dataset.index??0)});
   }
   else if(action==='open-knowledge'||action==='open-object'||action==='open-relation'){
    if(!selectedCitation||(selectedCitation.historical&&!selectedCitation.graph_location_verified)||!matchesScope(selectedCitation.source_scope))throw Error('引用不属于当前图版本，未替换为当前图中的其他记录。');const kind=action==='open-knowledge'?'knowledge':action==='open-object'?'entity':'relation',key=kind==='knowledge'?'knowledge_ids':kind==='entity'?'entity_ids':'relation_ids';if(!selectedCitation[key]?.includes(button.dataset.id))return;rememberPosition();onOpenGraph({libraryId,kind,id:button.dataset.id,scope:selectedCitation.source_scope});
   }
   else if(action==='reconnect'){subscribe();}
   else if(action==='stop'){
    const turn=current().turns.findLast(row=>!terminal(row));if(!turn?.query_ref||mutations.has(libraryId))return;const idAtStart=libraryId;mutations.add(idAtStart);render();try{await client.cancel({libraryId:idAtStart,queryRef:turn.query_ref});}finally{mutations.delete(idAtStart);if(host&&libraryId===idAtStart)render();}
   }
  }catch(error){viewError=error.message;render();onError(error.message);}
 }
 async function submit(event){
  if(inputMode==='ask'&&event.target.matches('[data-chat-supplement-form]')){event.preventDefault();try{await contextual?.submit();}catch{/* The contextual controller preserves its own receipt, draft and error. */}return;}
  if(inputMode!=='ask'||!event.target.matches('[data-chat-form]'))return;event.preventDefault();const state=viewModel(),question=(event.target.elements.question?.value??drafts.get(libraryId)??'').trim();if(!question||!state.can_submit||supplementScopeRefreshes.has(libraryId)||mutations.has(libraryId))return;
  const idAtStart=libraryId,selection=++epoch;mutations.add(idAtStart);viewError=null;selectedCitation=null;popover=null;rememberPosition();render();
  try{const result=await client.start({libraryId,question,...(current().conversation_id?{conversationId:current().conversation_id}:{})});if(!host||selection!==epoch||libraryId!==idAtStart)return;
   if(result.status==='CONFIRMED'){drafts.set(libraryId,'');selectedTurn=null;syncRoute();render({forceFollow:true});subscribe();}else if(result.error)viewError=result.error.message;
  }catch(error){if(libraryId===idAtStart)viewError=error.message;}finally{mutations.delete(idAtStart);if(host&&libraryId===idAtStart)render();}
 }
 const input=event=>{if(event.target.matches('[data-chat-supplement-field]')){const field=event.target.dataset.chatSupplementField;if(['text','reason','time_text'].includes(field))contextual?.updateDraft({[field]:event.target.value});return;}if(event.target.matches('[data-chat-draft]')){drafts.set(libraryId,event.target.value);const send=host.querySelector('[data-chat-send]');if(send)send.disabled=!viewModel().can_submit||supplementScopeRefreshes.has(libraryId)||!event.target.value.trim();}};
 const keydown=event=>{if(event.key==='Escape'&&contextual?.snapshot()?.open){contextual.close();return;}if(event.key==='Escape'&&popover){popover=null;render();}};
 function detach(){contextual?.close();++supplementEpoch;supplementRenderKey=null;memoryWorkspace?.detach();rememberPosition();++epoch;if(libraryId)client.closeStream({libraryId});if(host){host.removeEventListener('click',click);host.removeEventListener('submit',submit);host.removeEventListener('input',input);host.removeEventListener('keydown',keydown);}host=null;popover=null;}
 return {
  client,viewModel,render,openMemory,openAsk,openSupplement,supplementSnapshot:()=>contextual?.snapshot()??null,
  async attach({host:target,libraryId:id,conversationId=null,queryRef=null,turnId=null,pin=null,memoryMode=null,memoryRecordRef=null}={}){
   detach();host=target;libraryId=id;selectedTurn=turnId;selectedCitation=null;viewError=null;inputMode='ask';lastAttachment={conversationId,queryRef,turnId,pin};const selection=++epoch;
   if(!doc.querySelector?.('[data-lightog-chat-style]')){const link=doc.createElement('link');link.rel='stylesheet';link.href=new URL('./lightog-chat-v1.css',import.meta.url).href;link.setAttribute('data-lightog-chat-style','');doc.head?.append(link);}
   host.addEventListener('click',click);host.addEventListener('submit',submit);host.addEventListener('input',input);host.addEventListener('keydown',keydown);
   if(memoryEnabled===true&&memoryMode==='records'){await openMemory(memoryRecordRef);return;}
   await loadChat(selection,id,lastAttachment);
  },
  async restoreSource(frame){
   await client.open({libraryId:frame.library_id,queryRef:frame.query_ref});const response=await client.citation({libraryId:frame.library_id,queryRef:frame.query_ref,citationRef:frame.query_citation_ref});if(response.status!=='READY')throw Error(response.error?.message??'此引用暂不可读。');
   const raw=client.snapshot(frame.library_id),turn=raw.turns.find(t=>t.query_ref===frame.query_ref),citation=projectLightogQueryCitation(response.citation,readModel(),{historical:response.historical||turn?.historical||!matchesScope(turn?.source_scope)}),source=citation.sources[frame.query_source_index??0];if(!source?.available||source.document_key!==frame.document_key)throw Error('引用的原资料版本暂不可读，没有替用其他版本。');return {citation,source};
  },
  detach,dispose(){detach();contextual?.dispose();}
 };
}
