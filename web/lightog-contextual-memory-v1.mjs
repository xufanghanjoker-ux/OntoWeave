import {createLightogMemoryClient} from './lightog-memory-client-v1.mjs';

const clone=value=>structuredClone(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const reference=value=>typeof value==='string'&&value.trim()!==''&&!/[\\/\u0000-\u001f\u007f]/.test(value);
const kinds=new Set(['DOCUMENT','HUMAN_TEXT','AGENT_REPORT','TOOL_RECEIPT']);
const intents=new Set(['SAVE','RESULT','CORRECTION']);
const failure=(code,message)=>Object.assign(new Error(message),{code});
const errorData=error=>({code:typeof error?.code==='string'?error.code:'CONTEXTUAL_MEMORY_UNAVAILABLE',message:typeof error?.message==='string'?error.message:'操作尚未确认，原话草稿保留。',...(Number.isInteger(error?.status)?{status:error.status}:{})});
const canonical=value=>Array.isArray(value)?value.map(canonical):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const running=dto=>dto?.publication?.queryable!==true&&!['COMMIT_UNKNOWN','UNKNOWN','READBACK_FAILED','FAILED'].includes(dto?.publication?.state)&&['RECEIVED','QUEUED','RUNNING','PROCESSING','READY','PARTIALLY_READY','READY_AWAITING_PUBLICATION'].includes(dto?.processing?.state);
const operationLocked=op=>['SUBMITTING','ACCEPTED','UNKNOWN'].includes(op?.state);

/** Inline controller only: anchor stays local; explicit submit is the sole write path. */
export function createLightogContextualMemory({api,storage=globalThis.localStorage,uuid=()=>globalThis.crypto.randomUUID(),client:providedClient,onChange=()=>{},setTimeout:setTimer=globalThis.setTimeout,clearTimeout:clearTimer=globalThis.clearTimeout}={}){
 const sessions=new Map(),writing=new Map();let current=null,isOpen=false,disposed=false,timer=null;
 const client=providedClient??createLightogMemoryClient({api,storage,uuid,onChange:state=>{
  const pending=writing.get(state?.library_id),op=state?.operation,sent=pending?.payloadSnapshot;
  if(pending&&typeof op?.request_id==='string'&&op.request_id!==pending.previous_request_id&&op.kind===sent.kind&&op.text===sent.text&&op.reason===sent.reason&&op.target_record_ref===sent.target_record_ref)pending.session.request_id=op.request_id;
  if(!disposed&&isOpen&&current?.library_id===state?.library_id)emit();
 }});
 const clientState=id=>client.snapshot(id)??{operation:null,locked:false,error:null};
 const assertLive=()=>{if(disposed)throw failure('CONTEXTUAL_MEMORY_DISPOSED','当前记录编辑器已关闭。');};
 function stopTimer(){if(timer!==null){clearTimer(timer);timer=null;}}
 function synchronize(session,state){
  const op=state.operation;
  if(session.request_id&&op?.request_id===session.request_id&&op.raw_saved===true){
   session.submitted=true;
   // Durable client receipts are summaries; never replace a full server quality report with one.
   if(op.receipt&&!session.receipt)session.receipt=clone(op.receipt);
  }
 }
 function snapshot(){
  if(!current)return {open:false,library_id:null,intent:'SAVE',anchor:null,draft:{text:'',reason:'',time_text:''},target_record:null,target_loading:false,target_error:null,busy:false,submitted:false,operation:null,locked:false,error:null,receipt:null};
  const state=clientState(current.library_id);synchronize(current,state);
  return clone({open:isOpen,library_id:current.library_id,intent:current.intent,anchor:current.anchor,draft:current.draft,target_record:current.target_record,target_loading:current.target_loading,target_error:current.target_error,busy:current.busy,submitted:current.submitted,operation:state.operation??null,locked:Boolean(state.locked||current.submitted||(current.request_id===state.operation?.request_id&&operationLocked(state.operation))),error:current.error??((state.locked||current.request_id===state.operation?.request_id)?state.error:null)??null,receipt:current.receipt});
 }
 function schedule(){
  if(timer!==null||disposed||!isOpen||!current||current.busy||current.statusPromise||current.status_failed||!knownRef(current)||!running(current.receipt))return;
  const session=current;
  timer=setTimer(()=>{timer=null;if(disposed||!isOpen||current!==session)return;refreshStatus().catch(()=>{});},1500);
 }
 function emit(){if(disposed)return;try{onChange(snapshot());}catch{/* View errors cannot cause writes or retries. */}schedule();}
 function targetValid(session,result){
  const expected=session.expected,record=result?.record;
  if(!expected||result?.schema_version!=='MEMORY_PRODUCT_V1'||result.library_id!==session.library_id||record?.schema_version!=='MEMORY_RECORD_V1'||record.library_id!==session.library_id||record.record_ref!==expected.record_ref||!Number.isSafeInteger(record.version)||record.version<1||String(record.version)!==expected.revision||record.source?.kind!==expected.source_kind||typeof record.text!=='string'||record.text_truncated===true)
   throw failure('CONTEXTUAL_MEMORY_TARGET_UNCONFIRMED','未读回所选库、确切版本与来源一致的完整原话，不能补充或更正。');
  return record;
 }
 async function open({libraryId,intent='SAVE',anchor={},targetRecord=null}={}){
  assertLive();
  if(!reference(libraryId)||!intents.has(intent)||!object(anchor))throw failure('CONTEXTUAL_MEMORY_ARGUMENT_INVALID','请指定资料库、记录方式与当前上下文。');
  const display=clone(anchor),expected=intent==='SAVE'?null:targetRecord===null?null:clone(targetRecord);
  const key=JSON.stringify(canonical([libraryId,intent,display,expected]));
  stopTimer();
  if(!sessions.has(key))sessions.set(key,{library_id:libraryId,intent,anchor:display,expected,draft:{text:'',reason:'',time_text:''},target_record:null,target_loading:false,target_error:null,busy:false,submitted:false,error:null,receipt:null,request_id:null,target_seq:0,statusPromise:null,status_failed:false});
  const session=sessions.get(key);current=session;isOpen=true;
  if(intent==='SAVE'){emit();return snapshot();}
  const seq=++session.target_seq;session.target_record=null;session.target_error=null;
  if(!object(expected)||!reference(expected.record_ref)||typeof expected.revision!=='string'||!expected.revision.trim()||!kinds.has(expected.source_kind)){
   session.target_loading=false;session.target_error=errorData(failure('CONTEXTUAL_MEMORY_TARGET_REQUIRED','请先选择确切的原始记录版本，再补充或更正。'));emit();return snapshot();
  }
  session.target_loading=true;emit();
  try{
   const result=await client.read({libraryId,recordRef:expected.record_ref});
   const record=targetValid(session,result);
   if(session.target_seq===seq){session.target_record=clone(record);session.target_error=null;}
  }catch(error){if(session.target_seq===seq){session.target_record=null;session.target_error=errorData(error);}}
  finally{if(session.target_seq===seq)session.target_loading=false;if(current===session&&isOpen)emit();}
  return snapshot();
 }
 function updateDraft(patch={}){
  assertLive();if(!current||!isOpen)throw failure('CONTEXTUAL_MEMORY_NOT_OPEN','请先打开记录编辑器。');
  if(!object(patch)||Object.keys(patch).some(key=>!['text','reason','time_text'].includes(key)||typeof patch[key]!=='string'))throw failure('CONTEXTUAL_MEMORY_DRAFT_INVALID','原话、理由与时间输入应为文本。');
  Object.assign(current.draft,patch);current.error=null;emit();return snapshot();
 }
 function reject(session,code,message){const error=failure(code,message);session.error=errorData(error);emit();throw error;}
 async function submit(){
  assertLive();if(!current||!isOpen)throw failure('CONTEXTUAL_MEMORY_NOT_OPEN','请先打开记录编辑器。');
  const session=current,state=clientState(session.library_id);synchronize(session,state);
  if(session.busy||state.locked||session.submitted)return reject(session,'CONTEXTUAL_MEMORY_LOCKED','原操作已保存或结果待确认，未重复提交。');
  if(!session.draft.text.trim())return reject(session,'CONTEXTUAL_MEMORY_TEXT_REQUIRED','请填写要保留的原话。');
  if(session.intent==='CORRECTION'&&!session.draft.reason.trim())return reject(session,'CONTEXTUAL_MEMORY_REASON_REQUIRED','请填写这次更正的理由。');
  if(session.intent!=='SAVE'){
   if(session.target_loading||session.target_error||!session.target_record)return reject(session,'CONTEXTUAL_MEMORY_TARGET_UNCONFIRMED','请先读回该确切版本的完整原话，再补充或更正。');
   targetValid(session,{schema_version:'MEMORY_PRODUCT_V1',library_id:session.library_id,record:session.target_record});
  }
  const draft=clone(session.draft),payload={libraryId:session.library_id,text:draft.text,...(draft.time_text.trim()?{validTime:{kind:'UNRESOLVED',time_text:draft.time_text}}:{})};
  const pending={session,previous_request_id:state.operation?.request_id??null,payloadSnapshot:{kind:session.intent,text:draft.text,reason:session.intent==='CORRECTION'?draft.reason:'',target_record_ref:session.expected?.record_ref??null}};
  session.busy=true;session.error=null;session.status_failed=false;writing.set(session.library_id,pending);emit();
  try{
   const result=session.intent==='RESULT'?await client.appendResult({...payload,recordRef:session.expected.record_ref}):session.intent==='CORRECTION'?await client.correctRecord({...payload,recordRef:session.expected.record_ref,reason:draft.reason}):await client.save(payload);
   if(result?.schema_version!=='MEMORY_PRODUCT_V1'||result.library_id!==session.library_id||result.raw_saved!==true||!reference(result.record?.record_ref))throw failure('CONTEXTUAL_MEMORY_SAVE_UNCONFIRMED','保存回执未匹配原资料库与明确记录，未重复提交。');
   session.request_id=result.request_id;session.receipt=clone(result);session.submitted=true;return result;
  }catch(error){session.error=errorData(error);throw error;}
  finally{session.busy=false;if(writing.get(session.library_id)===pending)writing.delete(session.library_id);synchronize(session,clientState(session.library_id));if(current===session&&isOpen)emit();}
 }
 function knownRef(session){
  const own=clientState(session.library_id).operation;
  return reference(session.receipt?.record?.record_ref)?session.receipt.record.record_ref:session.request_id&&own?.request_id===session.request_id&&reference(own.record_ref)?own.record_ref:null;
 }
 function refreshStatus(){
  assertLive();if(!current||!isOpen)return Promise.reject(failure('CONTEXTUAL_MEMORY_NOT_OPEN','请先打开记录编辑器。'));
  const session=current;if(session.statusPromise)return session.statusPromise;
  const recordRef=knownRef(session);
  if(!recordRef){const error=failure('CONTEXTUAL_MEMORY_STATUS_REF_UNAVAILABLE','尚无本次保存的明确记录引用，不能猜测保存结果。');session.error=errorData(error);emit();return Promise.reject(error);}
  stopTimer();session.error=null;session.status_failed=false;
  session.statusPromise=(async()=>{
   try{
    const result=await client.status({libraryId:session.library_id,recordRef});
    if(result?.schema_version!=='MEMORY_PRODUCT_V1'||result.library_id!==session.library_id||result.raw_saved!==true||result.record_ref!==recordRef)throw failure('CONTEXTUAL_MEMORY_STATUS_UNCONFIRMED','状态回执未匹配本次保存的确切记录。');
    session.receipt={...session.receipt,raw_saved:true,processing:clone(result.processing),publication:clone(result.publication)};session.submitted=true;session.error=null;return result;
   }catch(error){session.error=errorData(error);session.status_failed=true;throw error;}
   finally{session.statusPromise=null;if(current===session&&isOpen)emit();}
  })();return session.statusPromise;
 }
 function close(){assertLive();stopTimer();isOpen=false;emit();return snapshot();}
 function dispose(){if(disposed)return;stopTimer();isOpen=false;disposed=true;}
 return Object.freeze({open,updateDraft,submit,refreshStatus,close,snapshot,dispose});
}
