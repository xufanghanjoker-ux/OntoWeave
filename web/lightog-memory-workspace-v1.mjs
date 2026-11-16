import {createLightogMemoryClient} from './lightog-memory-client-v1.mjs';
import {memoryMarkup,memoryList,memoryRecord,memoryEvidence,memoryStatus,memoryComposer,memoryIsRunning,memoryRelatedRefs,memoryPublicError} from './lightog-memory-view-v1.mjs';

const copy=value=>value===undefined?undefined:structuredClone(value);
const emptyDraft=()=>({kind:'SAVE',text:'',reason:'',time_text:'',target_record_ref:null,target_text:'',link_selected:false,submitted:false});
const reference=value=>typeof value==='string'&&value.trim()?value:null;

/** Only explicit user submissions write. Polls consume known running record refs with GET. */
export function createLightogMemoryWorkspace({api,storage=globalThis.localStorage,uuid=()=>crypto.randomUUID(),onRoute=()=>{},onAsk=()=>{},
 clientFactory=createLightogMemoryClient,setTimeout:setTimer=globalThis.setTimeout,clearTimeout:clearTimer=globalThis.clearTimeout,pollInterval=1500}={}){
 const libraries=new Map();let host=null,libraryId=null,epoch=0,pollTimer=null,polling=null,disposed=false,composerKey=null;
 function entry(id=libraryId){if(!libraries.has(id))libraries.set(id,{library_id:id,items:[],next_cursor:null,selected_record_ref:null,record:null,loaded_record_ref:null,related:{},related_errors:{},statuses:{},draft:emptyDraft(),draft_initialized:false,composer_open:false,list_loading:false,record_loading:false,error:null,notice:'',mutation_busy:false,mobile_panel:'timeline',read_seq:0,list_seq:0,scroll:{list:0,record:0,evidence:0}});return libraries.get(id);}
 function clientState(id){return client.snapshot(id)??{library_id:id,operation:null,pending:null,locked:false,error:null};}
 const client=clientFactory({api,storage,uuid,onChange:snapshot=>{if(!snapshot?.library_id)return;const saved=entry(snapshot.library_id);if(snapshot.error)saved.error=memoryPublicError(snapshot.error);if(host&&libraryId===snapshot.library_id){render();schedulePoll();}}});
 const active=(id,token)=>!disposed&&host&&libraryId===id&&epoch===token;
 function snapshot(id=libraryId){if(!id)return null;return copy({...entry(id),...clientState(id),error:entry(id).error??clientState(id).error});}
 function remember(){if(!host||!libraryId)return;const data=entry();for(const [key,selector] of [['list','[data-memory-list]'],['record','[data-memory-record]'],['evidence','[data-memory-evidence]']]){const pane=host.querySelector(selector);if(pane)data.scroll[key]=pane.scrollTop??0;}}
 function patch(selector,html){const target=host?.querySelector(selector);if(target&&target.innerHTML!==html)target.innerHTML=html;}
 function render({full=false,restore=false}={}){
  if(!host||!libraryId)return;const data=entry(),state=snapshot(),key=String(state.composer_open)+'\u0000'+state.draft.kind+'\u0000'+(state.draft.target_record_ref??'');
  if(full||!host.querySelector('[data-memory-shell]')){host.innerHTML=memoryMarkup(state);composerKey=key;}
  else {remember();patch('[data-memory-list]',memoryList(state));patch('[data-memory-record]',memoryRecord(state));patch('[data-memory-evidence]',memoryEvidence(state));patch('[data-memory-status]',memoryStatus(state));if(composerKey!==key){patch('[data-memory-composer]',state.composer_open?memoryComposer(state):'');composerKey=key;}}
  const shell=host.querySelector('[data-memory-shell]');if(shell)shell.dataset.panel=data.mobile_panel;
  const text=host.querySelector('[data-memory-draft]'),reason=host.querySelector('[data-memory-reason]'),time=host.querySelector('[data-memory-time]'),context=host.querySelector('[data-memory-context]');
  if(text&&text.value!==data.draft.text)text.value=data.draft.text;if(reason&&reason.value!==data.draft.reason)reason.value=data.draft.reason;if(time&&time.value!==data.draft.time_text)time.value=data.draft.time_text;if(context){context.checked=data.draft.link_selected;const label=context.closest?.('label');if(label)label.hidden=!(data.draft.kind==='SAVE'&&data.loaded_record_ref===data.selected_record_ref&&data.record);}
  const submit=host.querySelector('[data-memory-submit]');if(submit){submit.disabled=Boolean(state.locked||data.mutation_busy||!data.draft.text.trim()||(data.draft.kind==='CORRECTION'&&!data.draft.reason.trim())||(data.draft.submitted&&state.operation?.raw_saved===true));submit.textContent=data.mutation_busy?'正在提交…':'保存原话 ↑';}
  for(const [key,selector] of [['list','[data-memory-list]'],['record','[data-memory-record]'],['evidence','[data-memory-evidence]']]){const pane=host.querySelector(selector);if(pane&&(restore||data.scroll[key]!==undefined))pane.scrollTop=data.scroll[key];}
 }
 function route(ref){onRoute({library_id:libraryId,memory_record_ref:ref??null});}
 function validateEnvelope(result,id,ref){if(result?.library_id!==id||result?.record?.record_ref!==ref||typeof result.record.text!=='string'||result.record.text_truncated===true)throw Error('未读回所选库中该确切版本的完整原话，未用列表节选替代。');return result;}
 async function loadRelated(ref,{id=libraryId,token=epoch,selection=entry(id).read_seq}={}){
  if(!reference(ref))return;try{const result=validateEnvelope(await client.read({libraryId:id,recordRef:ref}),id,ref);if(!active(id,token)||entry(id).read_seq!==selection)return;entry(id).related[ref]=result;delete entry(id).related_errors[ref];render();}
  catch(error){if(active(id,token)&&entry(id).read_seq===selection){entry(id).related_errors[ref]=memoryPublicError(error);render();}}
 }
 async function readRecord(ref,{id=libraryId,token=epoch,routeChange=true}={}){
  if(!reference(ref))return;const data=entry(id),selection=++data.read_seq;data.selected_record_ref=ref;data.record=null;data.loaded_record_ref=null;data.record_loading=true;data.related={};data.related_errors={};data.error=null;
  if(active(id,token)){if(routeChange)route(ref);render();}
  try {const result=validateEnvelope(await client.read({libraryId:id,recordRef:ref}),id,ref);if(!active(id,token)||data.read_seq!==selection)return;data.record=result;data.loaded_record_ref=ref;data.record_loading=false;render();schedulePoll();await Promise.allSettled(memoryRelatedRefs(result).map(target=>loadRelated(target,{id,token,selection})));}
  catch(error){if(active(id,token)&&data.read_seq===selection){data.record_loading=false;data.error=memoryPublicError(error);render();}}
 }
 async function listRecords({more=false,id=libraryId,token=epoch}={}){
  const data=entry(id);if(more&&!data.next_cursor)return;const seq=++data.list_seq;data.list_loading=true;if(active(id,token))render();
  try {const result=await client.list({libraryId:id,...(more?{cursor:data.next_cursor}:{})});if(!active(id,token)||data.list_seq!==seq)return;
   if(result?.library_id!==id||!Array.isArray(result.items)||result.items.some(row=>row?.library_id!==id||!reference(row?.record?.record_ref)))throw Error('记录列表与当前知识库不一致，未混入其他库的内容。');
   const combined=more?[...data.items,...result.items]:result.items,seen=new Set();data.items=combined.filter(row=>{const ref=row.record.record_ref;if(seen.has(ref))return false;seen.add(ref);return true;});data.next_cursor=result.next_cursor??null;data.list_loading=false;render();
  }catch(error){if(active(id,token)&&data.list_seq===seq){data.list_loading=false;data.error=memoryPublicError(error);render();}}
 }
 async function statusRecord(ref,{id=libraryId,token=epoch}={}){
  if(!reference(ref))return;try {const result=await client.status({libraryId:id,recordRef:ref});if(!active(id,token))return;
   if(result?.library_id!==id||result?.record_ref!==ref)throw Error('状态回执与该确切记录不一致，未替换当前状态。');const data=entry(id);data.statuses[ref]=result;data.error=null;if(data.record?.record?.record_ref===ref)data.record={...data.record,processing:result.processing,publication:result.publication};render();schedulePoll();
  }catch(error){if(active(id,token)){entry(id).error=memoryPublicError(error);render();}}
 }
 function pollTarget(){if(!host||!libraryId)return null;const data=entry(),operation=clientState(libraryId).operation;if(reference(operation?.record_ref)&&memoryIsRunning(operation.receipt))return operation.record_ref;const status=data.statuses[data.selected_record_ref]??data.record;return reference(data.selected_record_ref)&&memoryIsRunning(status)?data.selected_record_ref:null;}
 function schedulePoll(){if(pollTimer!==null||polling===epoch||!pollTarget())return;const id=libraryId,token=epoch;pollTimer=setTimer(async()=>{pollTimer=null;if(!active(id,token))return;const ref=pollTarget();if(!ref)return;polling=token;try{await statusRecord(ref,{id,token});}finally{if(polling===token)polling=null;if(active(id,token))schedulePoll();}},pollInterval);}
 function begin(kind,ref){const data=entry(),record=data.record?.record;if(!record||data.loaded_record_ref!==ref||record.record_ref!==ref){data.error='请先读回目标版本的完整原话，再补充或更正。';render();return;}data.draft={...emptyDraft(),kind,target_record_ref:ref,target_text:record.text};data.composer_open=true;data.notice=kind==='CORRECTION'?'更正将追加保留版本，不抹掉旧原话；发布后才改变可查询知识。':'补充结果将保留与这条确切原话的关联。';render();host.querySelector('[data-memory-draft]')?.focus?.();}
 async function submit(event){if(!event.target.matches?.('[data-memory-form]'))return;event.preventDefault();const id=libraryId,token=epoch,data=entry(id),draft=copy(data.draft),lock=clientState(id);
  if(!data.composer_open||lock.locked||data.mutation_busy||!draft.text.trim()||(draft.kind==='CORRECTION'&&!draft.reason.trim())||(draft.submitted&&lock.operation?.raw_saved===true))return;
  if(draft.kind!=='SAVE'&&!reference(draft.target_record_ref)){data.error='没有确定的目标原话，未提交补充或更正。';render();return;}
  const payload={libraryId:id,text:draft.text,...(draft.time_text.trim()?{validTime:{kind:'UNRESOLVED',time_text:draft.time_text}}:{})};
  data.mutation_busy=true;data.error=null;data.notice='正在提交原话；知识是否可用另看发布确认。';render();
  try {const result=draft.kind==='RESULT'?await client.appendResult({...payload,recordRef:draft.target_record_ref}):draft.kind==='CORRECTION'?await client.correctRecord({...payload,recordRef:draft.target_record_ref,reason:draft.reason}):await client.save({...payload,...(draft.link_selected&&data.loaded_record_ref===data.selected_record_ref?{contextRefs:[data.selected_record_ref]}:{})});
   if(!active(id,token))return;if(result?.library_id!==id||result.raw_saved!==true||!reference(result.record?.record_ref))throw Error('保存回执尚未确认原话与记录版本；草稿保留，未自动重发。');
   data.draft.submitted=true;data.notice='原始记录已保存；知识是否可用于问答仅以发布回执为准。';await Promise.allSettled([listRecords({id,token}),readRecord(result.record.record_ref,{id,token})]);schedulePoll();
  }catch(error){if(active(id,token)){data.error=memoryPublicError(error);data.notice=clientState(id).operation?.state==='UNKNOWN'?'提交结果待确认，重复提交已锁定；草稿保留，不会自动重发。':'未完成提交，草稿保留；没有自动重试。';}}
  finally{data.mutation_busy=false;if(active(id,token))render();}
 }
 async function click(event){const button=event.target.closest?.('[data-memory-action]');if(!button||button.disabled)return;const action=button.dataset.memoryAction,ref=button.dataset.recordRef;
  if(action==='ask'){remember();onAsk();return;}
  if(action==='new-record'){const data=entry();data.composer_open=true;if(clientState(libraryId).locked){data.notice='当前补充仍待确认，已保留原稿；先核对原操作，不重复提交。';render();return;}data.draft=emptyDraft();data.error=null;data.notice='补充信息会保存人工原话；关联与知识发布另行确认。';render();host.querySelector('[data-memory-draft]')?.focus?.();}
  else if(action==='close-composer'){entry().composer_open=false;render();}
  else if(action==='select-record'||action==='read-record')await readRecord(ref);
  else if(action==='read-related')await loadRelated(ref);
  else if(action==='result')begin('RESULT',ref);
  else if(action==='correct')begin('CORRECTION',ref);
  else if(action==='status')await statusRecord(ref);
  else if(action==='more')await listRecords({more:true});
  else if(action==='panel'){entry().mobile_panel=button.dataset.panel;render();}
 }
 function input(event){if(!libraryId)return;const target=event.target,draft=entry().draft;if(target.matches?.('[data-memory-draft]'))draft.text=target.value;else if(target.matches?.('[data-memory-reason]'))draft.reason=target.value;else if(target.matches?.('[data-memory-time]'))draft.time_text=target.value;else if(target.matches?.('[data-memory-context]'))draft.link_selected=target.checked;else return;render();}
 function detach(){remember();++epoch;if(pollTimer!==null){clearTimer(pollTimer);pollTimer=null;}polling=null;if(host){host.removeEventListener('click',click);host.removeEventListener('submit',submit);host.removeEventListener('input',input);host.removeEventListener('change',input);}host=null;libraryId=null;composerKey=null;}
 return {async attach({host:target,libraryId:id,recordRef=null}={}){if(disposed)throw Error('工作区已释放。');if(!target||!reference(id))throw Error('需要工作区容器与知识库。');detach();host=target;libraryId=id;const token=epoch,data=entry(id);host.addEventListener('click',click);host.addEventListener('submit',submit);host.addEventListener('input',input);host.addEventListener('change',input);
   const operation=clientState(id).operation;if(!data.draft_initialized){if(operation?.text)data.draft={...emptyDraft(),kind:operation.kind??'SAVE',text:operation.text,reason:operation.reason??'',time_text:operation.valid_time?.time_text??'',target_record_ref:operation.target_record_ref??null,submitted:operation.raw_saved===true};data.draft_initialized=true;}
   render({full:true,restore:true});const ref=reference(recordRef)??data.selected_record_ref??reference(operation?.record_ref);await Promise.allSettled([listRecords({id,token}),...(ref?[readRecord(ref,{id,token})]:[])]);if(active(id,token)){render({restore:true});schedulePoll();}},
  detach,dispose(){detach();disposed=true;client.dispose?.();},render,snapshot};
}
