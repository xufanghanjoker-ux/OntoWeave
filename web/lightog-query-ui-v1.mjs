/** Query UI lifecycle only. No DOM, timers, build requests, or automatic POST replay. */
const VERSION='LIGHTOG_QUERY_UI_V1';
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const REF=/^[A-Za-z0-9_-]{1,160}$/;
const PIN=['library_id','build_run_id','library_revision_ref','source_snapshot_ref','source_index_revision','fact_index_revision'];
const TERMINAL=new Set(['COMPLETED','NEEDS_CLARIFICATION','INTERRUPTED','FAILED','UNKNOWN_HOLD','STALE','CANCELLED','STOPPED']);
const SERVER=new Set(['RUNNING','ANSWER_STAGED',...TERMINAL]);
const ANSWER=new Set(['SUPPORTED','PARTIAL','INSUFFICIENT','CONFLICTED','NEEDS_CLARIFICATION']);
const LOCAL=new Set(['IDLE','STARTING','START_UNCONFIRMED','START_REJECTED','CANCEL_PENDING','CANCEL_UNCONFIRMED','LOCAL_UNAVAILABLE']);
const text=value=>typeof value==='string'&&value.trim().length>0&&value.isWellFormed();
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const clone=structuredClone;
const sorted=value=>Array.isArray(value)?value.map(sorted):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value;
const equal=(a,b)=>JSON.stringify(sorted(a))===JSON.stringify(sorted(b));
const fail=(message,code)=>Object.assign(Error(message),{code});
const rejected=error=>Number.isInteger(error?.status)&&error.status>=400&&error.status<500&&error.status!==408;
const key=id=>'lightog.query.receipt.v1:'+id;
const path=id=>'/api/product/libraries/'+encodeURIComponent(id)+'/native-query';
const messages={QUERY_MODEL_NOT_CONFIGURED:'请先连接问答模型。',QUERY_NOT_FOUND:'该查询记录暂不可读，未替换成其他查询。',QUERY_HTTP_FORBIDDEN:'当前资料库不可访问，请重新确认资料库。',QUERY_REQUEST_CONFLICT:'原查询请求的内容已变化，未重新发送。',QUERY_SOURCE_STALE:'资料版本已变化，此查询按历史版本保留。',NATIVE_QUERY_SOURCE_STALE:'资料版本已变化，此查询按历史版本保留。',QUERY_CITATION_NOT_FOUND:'此查询的引用暂不可读，未使用其他来源替代。'};
function errorInfo(error,fallback){const code=error?.code??error?.error?.code??(/^[A-Z][A-Z0-9_]+$/.test(error?.message??'')?error.message:null);return {code,message:messages[code]??fallback,status:Number.isInteger(error?.status)?error.status:null};}
function pinOf(value,libraryId){if(!object(value)||PIN.some(field=>!text(value[field]))||value.library_id!==libraryId)return null;return Object.fromEntries(PIN.map(field=>[field,value[field]]));}
function empty(libraryId){return {library_id:libraryId,status:'IDLE',server_status:null,query_ref:null,request_id:null,question:'',pin:null,observed_pin:null,source_scope:null,scope_confirmed:false,answer:null,answer_ref:null,error:null,locked:false,historical:false,historical_status:null,cancel_pending:false,receipt:null,retrieval_route:null,trace:null,usage:[],provider_outcome_unknown:false,needs_readback:false};}
function citationValid(citation,libraryId,queryRef){return object(citation)&&text(citation.citation_ref)&&['GRAPH','SOURCE'].includes(citation.kind)&&(citation.kind==='GRAPH'?citation.representation==='EXTRACTED_KNOWLEDGE':['VERBATIM_SOURCE','INDEXED_SOURCE_WITH_MAPPING'].includes(citation.representation))&&(citation.library_id===undefined||citation.library_id===libraryId)&&(citation.query_ref===undefined||citation.query_ref===queryRef);}
function checkedAnswer(answer,libraryId,queryRef){
 if(answer===null||answer===undefined)return {answer:null,citations:new Map()};
 if(!object(answer)||!ANSWER.has(answer.status)||!Array.isArray(answer.statements)||!Array.isArray(answer.unanswered)||!answer.unanswered.every(v=>typeof v==='string')||!Array.isArray(answer.citations))throw fail('答案与当前查询的引用尚未完整读回。','LIGHTOG_QUERY_ANSWER_UNCONFIRMED');
 const all=new Map(),used=new Map();
 for(const citation of answer.citations){if(!citationValid(citation,libraryId,queryRef)||all.has(citation.citation_ref)&&!equal(all.get(citation.citation_ref),citation))throw fail('答案引用与当前查询尚未对齐。','LIGHTOG_QUERY_CITATION_UNCONFIRMED');all.set(citation.citation_ref,clone(citation));}
 for(const statement of answer.statements){
  if(!text(statement?.text)||!['GRAPH','SOURCE','GRAPH_AND_SOURCE'].includes(statement.basis)||!Array.isArray(statement.citation_refs)||!statement.citation_refs.every(ref=>text(ref)&&all.has(ref))||!Array.isArray(statement.citations))throw fail('答案的语句与实际引用尚未对齐。','LIGHTOG_QUERY_CITATION_UNCONFIRMED');
  const inline=new Map();for(const citation of statement.citations){if(!citationValid(citation,libraryId,queryRef)||!statement.citation_refs.includes(citation.citation_ref)||!equal(all.get(citation.citation_ref),citation))throw fail('答案引用与当前查询尚未对齐。','LIGHTOG_QUERY_CITATION_UNCONFIRMED');inline.set(citation.citation_ref,citation);}
  if(statement.citation_refs.some(ref=>!inline.has(ref)))throw fail('答案引用尚未完整读回。','LIGHTOG_QUERY_CITATION_UNCONFIRMED');for(const ref of statement.citation_refs)used.set(ref,all.get(ref));
 }
 return {answer:clone(answer),citations:used};
}

/** Capabilities are read by the controller. Start sends only the three contract fields. */
export function createLightogQueryActions({api,uuid,storage=globalThis.localStorage}={}){
 const entries=new Map();
 function readStored(libraryId){
  if(typeof storage?.getItem!=='function')throw fail('无法读取本机查询记录。','LIGHTOG_QUERY_STORAGE_UNAVAILABLE');
  const raw=storage.getItem(key(libraryId));if(raw===null||raw===undefined)return null;
  let record;try{record=JSON.parse(raw);}catch{throw fail('本机查询记录暂不可读，请先确认原请求。','LIGHTOG_QUERY_RECEIPT_UNREADABLE');}
  if(!object(record)||record.version!==VERSION||record.library_id!==libraryId||!UUID.test(record.request_id??'')||!text(record.question)||record.query_ref!==null&&!REF.test(record.query_ref??'')||!pinOf(record.pin,libraryId)||!SERVER.has(record.status)&&!LOCAL.has(record.status))throw fail('本机查询记录不完整，请先确认原请求。','LIGHTOG_QUERY_RECEIPT_UNREADABLE');return record;
 }
 function hydrate(record){return {...empty(record.library_id),...clone(record),source_scope:record.scope_confirmed?clone(record.pin):null,answer:null,trace:null,usage:[],error:null,needs_readback:Boolean(record.query_ref),receipt:{library_id:record.library_id,request_id:record.request_id,query_ref:record.query_ref,status:record.status,pin:clone(record.pin)}};}
 function entry(libraryId){
  if(!entries.has(libraryId)){let state=empty(libraryId);try{if(!REF.test(libraryId??''))throw fail('请选择有效的资料库。','LIGHTOG_QUERY_LIBRARY_INVALID');const stored=readStored(libraryId);if(stored)state=hydrate(stored);}catch(error){state.status='LOCAL_UNAVAILABLE';state.locked=true;state.error=errorInfo(error,'本机查询记录暂不可读，尚未发送请求。');}entries.set(libraryId,{state,epoch:0,citations:new Map()});}return entries.get(libraryId);
 }
 function persist(e,required=false){
  const s=e.state;if(!s.request_id)return true;
  const record={version:VERSION,...Object.fromEntries(['library_id','request_id','query_ref','question','pin','observed_pin','status','server_status','locked','historical','historical_status','cancel_pending','scope_confirmed','provider_outcome_unknown'].map(field=>[field,clone(s[field])]))};
  try{if(typeof storage?.setItem!=='function')throw Error();const raw=JSON.stringify(record);storage.setItem(key(s.library_id),raw);if(storage.getItem(key(s.library_id))!==raw)throw Error();return true;}
  catch{const error=fail('无法保留稳定查询记录，未自动重发。','LIGHTOG_QUERY_RECEIPT_NOT_SAVED');s.error=errorInfo(error,'本机查询记录保存失败，未自动重发。');if(required)throw error;return false;}
 }
 function current(libraryId){return clone(entry(libraryId).state);}
 const result=(status,e,error,extra={})=>({status,library_id:e.state.library_id,state:clone(e.state),...(error?{error:clone(error)}:{}),...extra});
 const same=(e,requestId,queryRef)=>e.state.request_id===requestId&&e.state.query_ref===queryRef;
 function history(s){s.historical=s.historical||Boolean(s.pin&&s.observed_pin&&!equal(s.pin,s.observed_pin));}
 function receipt(s){s.receipt={library_id:s.library_id,request_id:s.request_id,query_ref:s.query_ref,status:s.status,pin:clone(s.pin)};}
 function ingest(e,response){
  const s=e.state,pin=pinOf(response?.source_scope,s.library_id);
  if(!object(response)||response.library_id!==s.library_id||response.query_ref!==s.query_ref||response.question!==s.question||!SERVER.has(response.status)||typeof response.source_current!=='boolean'||typeof response.historical!=='boolean'||!pin||s.scope_confirmed&&!equal(s.pin,pin))throw fail('查询状态与原请求或版本尚未对齐，已保留原结果。','LIGHTOG_QUERY_READBACK_UNCONFIRMED');
  const completed=response.status==='COMPLETED'||response.status==='NEEDS_CLARIFICATION'||response.status==='STALE'&&['COMPLETED','NEEDS_CLARIFICATION'].includes(response.historical_status);
  if(response.answer!=null&&!completed)throw fail('答案尚未完成当前查询的读回确认。','LIGHTOG_QUERY_ANSWER_UNCONFIRMED');
  const checked=checkedAnswer(response.answer,s.library_id,s.query_ref);
  Object.assign(s,{server_status:response.status,status:response.status,pin,source_scope:clone(response.source_scope),scope_confirmed:true,historical:s.historical||response.historical===true||response.source_current===false||response.status==='STALE',historical_status:response.historical_status??null,provider_outcome_unknown:response.provider_outcome_unknown===true,answer:checked.answer,answer_ref:response.answer_ref??null,retrieval_route:response.retrieval_route??null,trace:clone(response.trace??null),usage:clone(response.usage??[]),backend_receipt:clone(response.receipt??null),needs_readback:false,error:null});
  if(TERMINAL.has(response.status)){s.locked=false;s.cancel_pending=false;}else{s.locked=true;if(s.cancel_pending)s.status='CANCEL_UNCONFIRMED';}
  history(s);e.citations=checked.citations;receipt(s);persist(e);
 }
 return Object.freeze({
  current,
  noteVersion({libraryId,pin}={}){
   const e=entry(libraryId),observed=pinOf(pin,libraryId);if(!observed)return result('REJECTED',e,errorInfo(null,'资料库版本尚未完整读回。'));
   e.state.observed_pin=observed;history(e.state);persist(e);return result('UPDATED',e);
  },
  async start({libraryId,question,context=[],pin}={}){
   const e=entry(libraryId);let requestId;
   try{
    const stored=readStored(libraryId);if(stored&&stored.request_id!==e.state.request_id&&stored.locked)e.state=hydrate(stored);
    if(e.state.locked)return result('BUSY',e,errorInfo(null,'当前查询尚待确认，未重复提交。'));
    const selected=pinOf(pin??e.state.observed_pin,libraryId);
    if(!REF.test(libraryId??'')||!text(question)||!selected||!Array.isArray(context)||context.some(row=>!object(row)||!['user','assistant'].includes(row.role)||!text(row.content)||Object.keys(row).some(k=>!['role','content'].includes(k)))||typeof api!=='function'||typeof uuid!=='function')throw fail('请填写问题，并先读回当前资料库版本。','LIGHTOG_QUERY_START_INVALID');
    requestId=uuid();if(!UUID.test(requestId??''))throw fail('查询请求标识无效，尚未发送。','LIGHTOG_QUERY_REQUEST_INVALID');
    e.epoch++;e.citations.clear();e.state={...empty(libraryId),status:'STARTING',question,pin:selected,observed_pin:clone(e.state.observed_pin??selected),request_id:requestId,locked:true};receipt(e.state);persist(e,true);
   }catch(error){if(e.state.status==='STARTING'){e.state.status='START_REJECTED';e.state.locked=false;}e.state.error=errorInfo(error,'查询未发送，请核对问题、版本和本机记录。');return result('REJECTED',e,e.state.error);}
   try{
    const response=await api(path(libraryId)+'/ask',{question,request_id:requestId,context:clone(context)});
    if(!same(e,requestId,null))return result('IGNORED',e);
    if(response?.library_id!==libraryId||!REF.test(response?.query_ref??'')||!SERVER.has(response?.status))throw fail('启动结果尚未确认，未重新发送。','LIGHTOG_QUERY_START_UNCONFIRMED');
    e.state.query_ref=response.query_ref;e.state.status=response.status;e.state.server_status=response.status;e.state.needs_readback=true;e.state.error=null;receipt(e.state);persist(e);
    if(response.source_scope)ingest(e,response);return result('CONFIRMED',e);
   }catch(error){if(e.state.request_id!==requestId)return result('IGNORED',e);if(e.state.query_ref){e.state.error=errorInfo(error,'查询引用已保存，完整状态尚待读回；未重新提交。');e.state.needs_readback=true;e.state.locked=true;persist(e);return result('UNCONFIRMED',e,e.state.error);}e.state.status=rejected(error)?'START_REJECTED':'START_UNCONFIRMED';e.state.locked=!rejected(error);e.state.error=errorInfo(error,rejected(error)?'查询请求未被接受；可以在解决问题后再次明确提问。':'查询启动结果待确认，已暂停重复提交，未自动重发。');receipt(e.state);persist(e);return result(rejected(error)?'REJECTED':'UNCONFIRMED',e,e.state.error);}
  },
  async read({libraryId,queryRef}={}){
   const e=entry(libraryId),s=e.state;if(!REF.test(queryRef??'')||queryRef!==s.query_ref)return result('REJECTED',e,errorInfo(null,'没有与当前请求绑定的查询引用，未读取其他查询。'));
   const requestId=s.request_id,epoch=++e.epoch;
   try{const response=await api(path(libraryId)+'/queries/'+encodeURIComponent(queryRef));if(e.epoch!==epoch||!same(e,requestId,queryRef))return result('IGNORED',e);ingest(e,response);return result('UPDATED',e);}
   catch(error){if(e.epoch!==epoch||!same(e,requestId,queryRef))return result('IGNORED',e);e.state.error=errorInfo(error,'查询状态暂未读回，已保留原问题与结果；未重新提交。');e.state.needs_readback=true;persist(e);return result('UNCONFIRMED',e,e.state.error);}
  },
  async cancel({libraryId,queryRef}={}){
   const e=entry(libraryId),s=e.state;if(!REF.test(queryRef??'')||queryRef!==s.query_ref)return result('REJECTED',e,errorInfo(null,'尚无明确的当前查询引用，未发送取消。'));
   if(s.cancel_pending)return result('BUSY',e,errorInfo(null,'取消结果尚待确认，未重复提交。'));
   if(TERMINAL.has(s.server_status)&&!s.needs_readback)return result('REJECTED',e,errorInfo(null,'该查询已经结束，无需取消。'));
   const requestId=s.request_id;e.epoch++;s.cancel_pending=true;s.locked=true;s.status='CANCEL_PENDING';receipt(s);persist(e);
   try{const response=await api(path(libraryId)+'/queries/'+encodeURIComponent(queryRef)+'/cancel',{});if(!same(e,requestId,queryRef))return result('IGNORED',e);if(TERMINAL.has(s.server_status)&&!s.needs_readback&&!TERMINAL.has(response?.status))return result('IGNORED',e);e.epoch++;ingest(e,response);return result(response.status==='CANCELLED'?'CANCELLED':'UPDATED',e);}
   catch(error){if(!same(e,requestId,queryRef))return result('IGNORED',e);if(TERMINAL.has(s.server_status)&&!s.needs_readback){s.cancel_pending=false;s.locked=false;s.status=s.server_status;receipt(s);persist(e);return result('UPDATED',e);}s.cancel_pending=!rejected(error);s.status=rejected(error)?s.server_status??'RUNNING':'CANCEL_UNCONFIRMED';s.locked=true;s.error=errorInfo(error,rejected(error)?'取消请求未被接受，查询原状态保留。':'取消结果待确认，查询未被标为已取消；请读取原查询状态。');receipt(s);persist(e);return result(rejected(error)?'REJECTED':'UNCONFIRMED',e,s.error);}
  },
  async citation({libraryId,queryRef,citationRef}={}){
   const e=entry(libraryId),s=e.state,known=e.citations.get(citationRef);
   if(queryRef!==s.query_ref||!REF.test(queryRef??'')||!text(citationRef)||!known)return result('REJECTED',e,errorInfo(null,'此引用不属于当前已读回答案，请先读取对应查询。'));
   const requestId=s.request_id;
   try{const response=await api(path(libraryId)+'/queries/'+encodeURIComponent(queryRef)+'/citations/'+encodeURIComponent(citationRef));if(!same(e,requestId,queryRef)||!e.citations.has(citationRef))return result('IGNORED',e);if(!citationValid(response?.citation,libraryId,queryRef)||response.citation.citation_ref!==citationRef||!equal(response.citation,known)||!Array.isArray(response.source_previews))throw fail('引用读回未匹配当前答案，未使用其他来源替代。','LIGHTOG_QUERY_CITATION_UNCONFIRMED');if(response.historical===true){s.historical=true;persist(e);}return result('READY',e,null,{citation:clone(response.citation),source_previews:clone(response.source_previews),historical:s.historical||response.historical===true});}
   catch(error){if(!same(e,requestId,queryRef))return result('IGNORED',e);return result('UNCONFIRMED',e,errorInfo(error,'当前引用暂不可读，未使用其他资料或版本替代。'));}
  }
 });
}
