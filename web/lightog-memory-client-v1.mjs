/** Candidate UI client. api(path, body?) owns same-origin credentials. No fetch, timers or POST replay. */
const BASE='/api/product/memory/v1',VERSION='LIGHTOG_MEMORY_CLIENT_V1';
const STATES=new Set(['SUBMITTING','ACCEPTED','FAILED','UNKNOWN','COMPLETED']);
const PROCESSING=new Set(['RECEIVED','QUEUED','PROCESSING','PARTIALLY_READY','READY','FAILED','UNKNOWN','WAITING_PROCESSOR','WAITING_MODEL','RUNNING','READY_AWAITING_PUBLICATION','COMPLETED','OFFLINE_COMPLETED','ENQUEUE_FAILED']);
const BINDINGS=['knowledge_revision_ref','graph_revision_ref','source_index_revision','knowledge_index_revision'];
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v,max=100000)=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!v.includes('\0');
const ref=(v,max=512)=>text(v,max)&&!/[\\/\u0000-\u001f\u007f]/.test(v);
const clone=structuredClone;
const bytes=v=>new TextEncoder().encode(v).length;
const key=id=>'lightog.memory.operation.v1:'+id;
const locked=op=>!!op&&['SUBMITTING','ACCEPTED','UNKNOWN'].includes(op.state);
const fail=(code,message,status)=>Object.assign(new Error(message),{code,...(status?{status}:{})});
const need=(value,code,message)=>{if(!value)throw fail(code,message);};
const statusOf=e=>Number.isInteger(e?.status)?e.status:Number.isInteger(e?.statusCode)?e.statusCode:null;
const rejected=e=>{const s=statusOf(e);return s>=400&&s<500&&s!==408;};
const timestamp=v=>typeof v==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
function errorOf(error,message){
 const candidate=error?.code??error?.error?.code,code=typeof candidate==='string'?candidate:/^[A-Z][A-Z0-9_]+$/.test(error?.message??'')?error.message:'MEMORY_CLIENT_UNAVAILABLE';
 return fail(code,code.startsWith('MEMORY_CLIENT_')&&text(error?.message)?error.message:message,statusOf(error));
}
const errorData=e=>({code:e.code,message:e.message,status:statusOf(e)});
function args(input,fields){need(object(input)&&Object.keys(input).every(k=>fields.includes(k)),'MEMORY_CLIENT_ARGUMENT_INVALID','请求字段不符合当前记录接口。');need(ref(input.libraryId,160),'MEMORY_CLIENT_LIBRARY_INVALID','请选择有效的资料库。');}
function paging(pageSize,cursor,fallback){need(pageSize===undefined||Number.isSafeInteger(pageSize)&&pageSize>=1&&pageSize<=50,'MEMORY_CLIENT_PAGE_INVALID','每页数量应为 1 至 50。');need(cursor===undefined||text(cursor,2048),'MEMORY_CLIENT_CURSOR_INVALID','分页引用无效，请重新读取列表。');return pageSize??fallback;}
function parts(response,libraryId){
 need(object(response)&&response.schema_version==='MEMORY_PRODUCT_V1'&&response.library_id===libraryId,'MEMORY_CLIENT_SCOPE_UNCONFIRMED','回执未匹配原资料库，已保留原请求。');
 const p=response.processing,u=response.publication;
 need(object(p)&&PROCESSING.has(p.state)&&text(p.mode,80)&&(p.job_ref===null||ref(p.job_ref))&&object(u)&&text(u.state,100)&&typeof u.queryable==='boolean'&&(u.library_id===undefined||u.library_id===libraryId),'MEMORY_CLIENT_RECEIPT_UNCONFIRMED','保存、处理或发布回执尚未完整读回。');
 if(u.queryable)need(u.state==='CONFIRMED'&&u.mode==='NATIVE_PRODUCT'&&ref(u.publication_ref)&&ref(u.commit_ref)&&ref(u.confirmation_ref)&&object(u.bindings)&&BINDINGS.every(k=>ref(u.bindings[k]))&&Array.isArray(u.evidence_refs)&&u.evidence_refs.length>0&&u.evidence_refs.every(v=>ref(v))&&timestamp(u.commit_acknowledged_at)&&timestamp(u.readback_confirmed_at),'MEMORY_CLIENT_PUBLICATION_UNCONFIRMED','知识发布尚缺少一致的读回证明，未当作当前可查询。');
}
function recordDto(response,libraryId,recordRef,{preview=false}={}){
 parts(response,libraryId);const r=response.record;
 need(object(r)&&ref(r.record_ref)&&(!recordRef||r.record_ref===recordRef)&&ref(r.logical_ref)&&Number.isSafeInteger(r.version)&&r.version>=1&&typeof r.text==='string'&&object(r.source)&&['DOCUMENT','HUMAN_TEXT','AGENT_REPORT','TOOL_RECEIPT'].includes(r.source.kind)&&timestamp(r.source_ingested_at)&&(r.library_id===undefined||r.library_id===libraryId),'MEMORY_CLIENT_RECORD_UNCONFIRMED','原话版本或来源未匹配，未换成其他记录。');
 if(!preview)need(r.schema_version==='MEMORY_RECORD_V1'&&r.library_id===libraryId,'MEMORY_CLIENT_RECORD_UNCONFIRMED','原始记录版本与资料库尚未确认。');
 if(preview)need(typeof r.text_truncated==='boolean'&&Number.isSafeInteger(r.text_characters)&&r.text_characters>=r.text.length&&(!r.text_truncated?r.text_characters===r.text.length:true),'MEMORY_CLIENT_RECORD_UNCONFIRMED','列表原话预览范围尚未确认。');
 return r;
}
function stateFor(response){
 if(response.processing.state==='UNKNOWN'||response.publication.state==='COMMIT_UNKNOWN')return 'UNKNOWN';
 if(['PREPARING','COMMITTED_UNCONFIRMED','READBACK_FAILED'].includes(response.publication.state))return 'ACCEPTED';
 if(['FAILED','ENQUEUE_FAILED'].includes(response.processing.state)||response.publication.state==='FAILED')return 'FAILED';
 return ['COMPLETED','OFFLINE_COMPLETED'].includes(response.processing.state)?'COMPLETED':'ACCEPTED';
}
function summarized(receipt){
 if(!receipt)return null;
 const pick=(value,fields)=>Object.fromEntries(fields.filter(k=>value?.[k]!==undefined).map(k=>[k,clone(value[k])]));
 return {...pick(receipt,['schema_version','library_id','request_id','raw_saved','replayed']),record:pick(receipt.record,['record_ref','logical_ref','version','source_ingested_at']),processing:pick(receipt.processing,['state','mode','job_ref','error_code']),publication:{...pick(receipt.publication,['state','queryable','mode','library_id','publication_ref','processing_ref','commit_ref','commit_seq','confirmation_ref','recorded_from','historical_status','commit_acknowledged_at','readback_confirmed_at','error_code']),...(object(receipt.publication?.bindings)?{bindings:pick(receipt.publication.bindings,BINDINGS)}:{}),...(Array.isArray(receipt.publication?.evidence_refs)?{evidence_refs:receipt.publication.evidence_refs.filter(v=>typeof v==='string')}:{}),...(Array.isArray(receipt.publication?.gaps)?{gaps:receipt.publication.gaps.filter(v=>typeof v==='string')}: {})}};
}

export function createLightogMemoryClient({api,uuid=()=>globalThis.crypto.randomUUID(),storage=globalThis.localStorage,onChange=()=>{}}={}){
 const entries=new Map();
 function readStored(libraryId){
  need(typeof storage?.getItem==='function','MEMORY_CLIENT_STORAGE_UNAVAILABLE','无法读取稳定操作收据，尚未发送记录。');
  const raw=storage.getItem(key(libraryId));if(raw==null)return null;let value;
  try{value=JSON.parse(raw);}catch{throw fail('MEMORY_CLIENT_STORAGE_UNREADABLE','本机操作收据暂不可读，未重复提交。');}
  const op=value?.operation;
  need(object(value)&&value.version===VERSION&&value.library_id===libraryId&&object(op)&&STATES.has(op.state)&&['SAVE','RESULT','CORRECTION'].includes(op.kind)&&text(op.request_id,128)&&/^[A-Za-z0-9_:\-]+$/.test(op.request_id)&&text(op.text)&&typeof op.reason==='string'&&(op.target_record_ref===null||ref(op.target_record_ref))&&(op.record_ref===null||ref(op.record_ref))&&[null,true,false].includes(op.raw_saved)&&(!['ACCEPTED','COMPLETED'].includes(op.state)||op.record_ref&&op.raw_saved===true)&&(!op.receipt||op.receipt.library_id===libraryId&&op.receipt.request_id===op.request_id&&op.receipt.record?.record_ref===op.record_ref),'MEMORY_CLIENT_STORAGE_UNREADABLE','本机操作收据不完整，未重复提交。');
  if(op.record_ref){need(object(op.receipt)&&op.receipt.raw_saved===true,'MEMORY_CLIENT_STORAGE_UNREADABLE','本机保存回执不完整，未重复提交。');parts(op.receipt,libraryId);}
  return op;
 }
 function entry(libraryId){
  if(!entries.has(libraryId)){
   const e={libraryId,operation:null,error:null,storageBlocked:false,readEpoch:0,statusEpoch:0};
   try{need(ref(libraryId,160),'MEMORY_CLIENT_LIBRARY_INVALID','请选择有效的资料库。');e.operation=readStored(libraryId);if(e.operation?.state==='SUBMITTING')e.operation.state='UNKNOWN';}
   catch(error){e.storageBlocked=true;e.error=errorData(errorOf(error,'本机操作收据暂不可读，未发送记录。'));}
   entries.set(libraryId,e);
  }return entries.get(libraryId);
 }
 function snapshot(libraryId){const e=entry(libraryId),isLocked=e.storageBlocked||locked(e.operation);return clone({library_id:libraryId,operation:e.operation,pending:isLocked?e.operation:null,locked:isLocked,error:e.error});}
 function notify(e){try{onChange(snapshot(e.libraryId));}catch{/* UI errors cannot retry writes. */}}
 function persist(e,required=false){
  try{need(typeof storage?.setItem==='function','MEMORY_CLIENT_STORAGE_UNAVAILABLE','本机收据无法保存，尚未发送记录。');const value=JSON.stringify({version:VERSION,library_id:e.libraryId,operation:{...e.operation,receipt:summarized(e.operation?.receipt)}});storage.setItem(key(e.libraryId),value);if(storage.getItem(key(e.libraryId))!==value)throw Error('not durable');return true;}
  catch{e.error=errorData(fail('MEMORY_CLIENT_STORAGE_UNAVAILABLE',required?'本机收据未保存，记录尚未发送。':'本机收据暂未保存；原操作保留，未自动重发。'));if(required){e.storageBlocked=true;throw fail(e.error.code,e.error.message);}return false;}
 }
 const change=e=>{persist(e);notify(e);};
 function same(e,id,recordRef){return e.operation?.request_id===id&&e.operation.record_ref===recordRef;}
 function applyStatus(e,response){const op=e.operation;op.receipt={...op.receipt,raw_saved:true,processing:clone(response.processing),publication:clone(response.publication)};op.state=stateFor(response);op.raw_saved=true;e.error=null;change(e);}
 async function readCall(input,fields,path,validate){
  args(input,fields);const e=entry(input.libraryId),epoch=++e.readEpoch;
  try{const response=await api(path);validate(response);if(epoch===e.readEpoch){e.error=null;notify(e);}return clone(response);}
  catch(cause){const error=errorOf(cause,'记录暂未读回，原操作和原话保留。');if(epoch===e.readEpoch){e.error=errorData(error);notify(e);}throw error;}
 }
 async function write(kind,input){
  const fields=kind==='SAVE'?['libraryId','text','validTime','contextRefs']:kind==='RESULT'?['libraryId','recordRef','text','validTime']:['libraryId','recordRef','text','reason','validTime'];
  args(input,fields);const e=entry(input.libraryId);let requestId,operation;
  try{
   const other=readStored(input.libraryId);if(other&&other.request_id!==e.operation?.request_id&&locked(other))e.operation={...other,state:other.state==='SUBMITTING'?'UNKNOWN':other.state};
   need(!e.storageBlocked&&!locked(e.operation),'MEMORY_CLIENT_BUSY','原操作尚待确认，未重复提交。');
   need(typeof api==='function'&&typeof uuid==='function'&&text(input.text)&&bytes(input.text)<=400000,'MEMORY_CLIENT_INPUT_INVALID','请填写原话，单条最多 100000 字符／400000 UTF-8 字节。');
   if(kind!=='SAVE')need(ref(input.recordRef),'MEMORY_CLIENT_TARGET_INVALID','请选择明确的原始记录版本。');
   if(kind==='CORRECTION')need(text(input.reason,4000),'MEMORY_CLIENT_REASON_REQUIRED','请填写这次纠正的理由。');
   if(input.contextRefs!==undefined)need(Array.isArray(input.contextRefs)&&input.contextRefs.length<=50&&input.contextRefs.every(v=>text(v,256)),'MEMORY_CLIENT_CONTEXT_INVALID','事项关联引用无效。');
   if(input.validTime!==undefined){let encoded;try{encoded=JSON.stringify(input.validTime);}catch{}need(typeof encoded==='string'&&bytes(encoded)<=16384,'MEMORY_CLIENT_TIME_INVALID','时间输入无法完整保存，请保留时间原话。');}
   requestId=uuid();need(typeof requestId==='string'&&/^[A-Za-z0-9_:\-]{1,128}$/.test(requestId)&&requestId!==e.operation?.request_id,'MEMORY_CLIENT_REQUEST_ID_INVALID','无法生成新的稳定请求标识，尚未发送。');
   operation={request_id:requestId,kind,target_record_ref:kind==='SAVE'?null:input.recordRef,text:input.text,reason:kind==='CORRECTION'?input.reason:'',record_ref:null,receipt:null,state:'SUBMITTING',raw_saved:null,...(input.validTime!==undefined?{valid_time:clone(input.validTime)}:{}),...(input.contextRefs!==undefined?{context_refs:clone(input.contextRefs)}:{})};
   e.operation=operation;e.error=null;e.statusEpoch++;e.readEpoch++;persist(e,true);notify(e);
  }catch(cause){const error=errorOf(cause,'记录尚未发送，请核对输入与本机收据。');if(operation){operation.state='FAILED';operation.raw_saved=false;}e.error=errorData(error);notify(e);throw error;}
  const body={library_id:input.libraryId,request_id:requestId,text:input.text,...(input.validTime!==undefined?{valid_time:clone(input.validTime)}:{}),...(kind==='SAVE'&&input.contextRefs!==undefined?{context_refs:clone(input.contextRefs)}:{}),...(kind==='CORRECTION'?{reason:input.reason}:{})};
  const path=BASE+'/records'+(kind==='SAVE'?'':'/'+encodeURIComponent(input.recordRef)+(kind==='RESULT'?'/results':'/corrections'));
  try{
   const response=await api(path,body),record=recordDto(response,input.libraryId);
   need(response.raw_saved===true&&response.request_id===requestId&&typeof response.replayed==='boolean'&&record.text===input.text,'MEMORY_CLIENT_SAVE_UNCONFIRMED','保存回执尚未匹配原话与请求，未重复提交。');
   if(kind!=='SAVE')need(record.source?.metadata?.related_record_ref===input.recordRef&&record.record_ref!==input.recordRef,'MEMORY_CLIENT_TARGET_UNCONFIRMED','补充／纠正回执未匹配目标记录，未替用其他记录。');
   if(kind==='RESULT')need(record.relation?.kind==='SUPPLEMENT'&&Array.isArray(record.relation.related_logical_refs)&&record.relation.related_logical_refs.length>0,'MEMORY_CLIENT_TARGET_UNCONFIRMED','补结果关联尚未完整确认。');
   if(kind==='CORRECTION')need(record.supersedes===input.recordRef&&record.revision_reason===input.reason&&record.version>=2,'MEMORY_CLIENT_TARGET_UNCONFIRMED','纠正版本尚未匹配旧记录与理由。');
   if(e.operation?.request_id===requestId){Object.assign(operation,{record_ref:record.record_ref,receipt:clone(response),raw_saved:true,state:stateFor(response)});e.error=null;change(e);}
   return clone(response);
  }catch(cause){
   const error=errorOf(cause,rejected(cause)?'请求被明确拒绝，原话草稿保留。':'保存结果尚待确认，原话和稳定请求标识已保留，未重复提交。');
   if(e.operation?.request_id===requestId){operation.state=rejected(cause)?'FAILED':'UNKNOWN';operation.raw_saved=rejected(cause)?false:null;e.error=errorData(error);change(e);}throw error;
  }
 }
 return Object.freeze({
  snapshot,
  list(input){args(input,['libraryId','pageSize','cursor']);const size=paging(input.pageSize,input.cursor,20),query=new URLSearchParams({library_id:input.libraryId,...(input.pageSize!==undefined?{page_size:String(size)}:{}),...(input.cursor!==undefined?{cursor:input.cursor}:{})});return readCall(input,['libraryId','pageSize','cursor'],BASE+'/records?'+query,r=>{need(r?.schema_version==='MEMORY_PRODUCT_LIST_V1'&&r.library_id===input.libraryId&&Array.isArray(r.items)&&r.items.length<=size&&r.page_size===size&&(r.next_cursor===null||text(r.next_cursor,2048)),'MEMORY_CLIENT_LIST_UNCONFIRMED','记录列表范围尚未完整读回。');for(const item of r.items)recordDto(item,input.libraryId,null,{preview:true});});},
  read(input){args(input,['libraryId','recordRef']);need(ref(input.recordRef),'MEMORY_CLIENT_TARGET_INVALID','请选择明确的原始记录版本。');return readCall(input,['libraryId','recordRef'],BASE+'/records/'+encodeURIComponent(input.recordRef)+'?'+new URLSearchParams({library_id:input.libraryId}),r=>recordDto(r,input.libraryId,input.recordRef));},
  async status(input){
   args(input,['libraryId','recordRef']);need(ref(input.recordRef),'MEMORY_CLIENT_TARGET_INVALID','尚无明确记录引用，无法猜测原保存结果。');const e=entry(input.libraryId),id=e.operation?.request_id,recordRef=e.operation?.record_ref,epoch=++e.statusEpoch;
   const expectedLogical=recordRef===input.recordRef?e.operation?.receipt?.record?.logical_ref:null;
   const response=await readCall(input,['libraryId','recordRef'],BASE+'/records/'+encodeURIComponent(input.recordRef)+'/status?'+new URLSearchParams({library_id:input.libraryId}),r=>{parts(r,input.libraryId);need(r.raw_saved===true&&r.record_ref===input.recordRef&&ref(r.logical_ref)&&(!expectedLogical||r.logical_ref===expectedLogical),'MEMORY_CLIENT_STATUS_UNCONFIRMED','处理状态未匹配该原话版本，原操作保留。');});
   if(recordRef===input.recordRef&&same(e,id,recordRef)&&epoch===e.statusEpoch)applyStatus(e,response);return response;
  },
  async search(input){
   args(input,['libraryId','query','pageSize','cursor']);const size=paging(input.pageSize,input.cursor,10);need(text(input.query,4000),'MEMORY_CLIENT_QUERY_INVALID','请填写相关知识的查询内容。');const e=entry(input.libraryId),epoch=++e.readEpoch;
   try{const response=await api(BASE+'/search',{library_id:input.libraryId,query:input.query,...(input.pageSize!==undefined?{page_size:size}:{}),...(input.cursor!==undefined?{cursor:input.cursor}:{})});need(response?.schema_version==='MEMORY_PRODUCT_SEARCH_V1'&&response.library_id===input.libraryId&&Array.isArray(response.items)&&response.items.length<=size&&object(response.view)&&response.view.library_id===input.libraryId&&(response.next_cursor===undefined||response.next_cursor===null||text(response.next_cursor,2048))&&response.execution?.mode==='DIRECT_KNOWLEDGE'&&response.execution.answer_model_called===false&&response.execution.absence_proven===false,'MEMORY_CLIENT_SEARCH_UNCONFIRMED','相关知识尚未按当前资料库范围完整读回。');if(epoch===e.readEpoch){e.error=null;notify(e);}return clone(response);}
   catch(cause){const error=errorOf(cause,'相关知识暂不可读，未把读取失败当作没有知识。');if(epoch===e.readEpoch){e.error=errorData(error);notify(e);}throw error;}
  },
  save:input=>write('SAVE',input),appendResult:input=>write('RESULT',input),correctRecord:input=>write('CORRECTION',input)
 });
}
