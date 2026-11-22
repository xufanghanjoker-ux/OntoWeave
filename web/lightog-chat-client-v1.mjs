/** Public chat lifecycle and SSE replay only. No DOM, model calls, or POST retries. */
const VERSION='lightog-retrieval-chat/1';
const STORAGE_VERSION='LIGHTOG_CHAT_CLIENT_V1';
const REF=/^[A-Za-z0-9_-]{1,160}$/;
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const TERMINAL=new Set(['COMPLETED','NEEDS_CLARIFICATION','INTERRUPTED','FAILED','UNKNOWN_HOLD','CANCELLED','STOPPED','STALE']);
const SERVER=new Set(['RUNNING','ANSWER_STAGED','STALE',...TERMINAL]);
const TYPES=new Set(['turn.created','tool.started','tool.completed','citation.registered','answer.delta','answer.replace','turn.completed','turn.stopped','turn.failed']);
const PIN=['library_id','build_run_id','library_revision_ref','source_snapshot_ref','source_index_revision','fact_index_revision'];
const PG_PIN=['view_revision','business_manifest_sha256','retrieval_index_revision','at','as_of'];
const LOCAL=new Set(['STARTING','START_UNCONFIRMED','START_REJECTED']);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=v=>typeof v==='string'&&v.trim().length>0;
const ref=v=>typeof v==='string'&&REF.test(v);
const clone=structuredClone;
const sorted=v=>Array.isArray(v)?v.map(sorted):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
const equal=(a,b)=>JSON.stringify(sorted(a))===JSON.stringify(sorted(b));
function validScope(scope, libraryId){
 if(!object(scope)||scope.library_id!==libraryId)return false;
 const view=scope.query_read_view;
 if(view===undefined)return PIN.every(key=>text(scope[key]));
 return object(view)&&view.library_ref===libraryId&&view.contract==='ontoweave-query-read-view/1'
  &&text(view.view_revision)&&text(view.business_manifest_sha256)&&text(view.retrieval_index_revision)
  &&[view.at,view.as_of].every(value=>value===null||text(value));
}
function alignedPin(pin, scope){
 if(pin.query_read_view)return PG_PIN.every(key=>pin.query_read_view[key]===scope.query_read_view?.[key]);
 return !scope.query_read_view&&PIN.every(key=>pin[key]===scope[key]);
}
async function citationMatches(known,response){
 if(known?.delivery_contract!=='lightog-citation-descriptor/1')return equal(known,response.citation);
 if(!equal(known,response.citation_descriptor)||typeof known.detail_sha256!=='string'||!globalThis.crypto?.subtle)return false;
 const bytes=new TextEncoder().encode(JSON.stringify(sorted(response.citation))),digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);
 return [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('')===known.detail_sha256;
}
const fail=(code,message)=>Object.assign(new Error(message),{code});
const rejected=e=>Number.isInteger(e?.status)&&e.status>=400&&e.status<500&&e.status!==408;
const terminal=t=>t?.status==='STALE'&&t.historical_status?TERMINAL.has(t.historical_status):TERMINAL.has(t?.status);
const base=id=>'/api/product/libraries/'+encodeURIComponent(id)+'/native-query';
const queryPath=(lib,q)=>base(lib)+'/queries/'+encodeURIComponent(q);
const storageKey=id=>'lightog.chat.receipt.v1:'+id;
const info=(error,message)=>({code:error?.code??error?.error?.code??null,message:error?.code?.startsWith('LIGHTOG_CHAT_')?error.message:message,status:Number.isInteger(error?.status)?error.status:null});

function blankTurn(value={}){
 return {query_ref:null,library_id:null,conversation_id:null,turn_id:null,turn_index:null,question:'',status:'RUNNING',historical:false,historical_status:null,source_scope:null,answer:null,partial_answer:null,events:[],last_event_seq:0,blocks:[],citations:[],needs_readback:false,cancel_pending:false,...clone(value)};
}
function validCitation(c,outerRef){
 return object(c)&&['GRAPH','SOURCE'].includes(c.kind)&&(c.citation_ref===undefined||c.citation_ref===outerRef)&&(c.representation===undefined||(c.kind==='GRAPH'?c.representation==='EXTRACTED_KNOWLEDGE':['VERBATIM_SOURCE','INDEXED_SOURCE_WITH_MAPPING','VERBATIM_RECORD','INDEXED_RECORD_WITH_MAPPING'].includes(c.representation)));
}
function registry(answer){
 if(!object(answer)||!Array.isArray(answer.citations))return [];
 return answer.citations.map((row,index)=>object(row?.citation)?clone(row):{number:index+1,marker:'['+(index+1)+']',citation_ref:row?.citation_ref,citation:clone(row)});
}
function checkedRegistry(rows){
 const numbers=new Map(),refs=new Map();
 for(const row of rows){
  if(!object(row)||!Number.isSafeInteger(row.number)||row.number<1||row.marker!==undefined&&row.marker!=='['+row.number+']'||!ref(row.citation_ref)||!validCitation(row.citation,row.citation_ref)||numbers.has(row.number)&&numbers.get(row.number)!==row.citation_ref||refs.has(row.citation_ref)&&!equal(refs.get(row.citation_ref),row))throw fail('LIGHTOG_CHAT_CITATION_UNCONFIRMED','来源编号或引用绑定未完整读回。');
  numbers.set(row.number,row.citation_ref);refs.set(row.citation_ref,row);
 }
 return rows;
}

/** Pure reducer. A gap never changes the turn or advances its replay cursor. */
export function reduceLightogChatEvent(turn,envelope){
 const unchanged=status=>({status,turn:clone(turn),expected_seq:(turn.last_event_seq??0)+1});
 if(!object(envelope)||envelope.version!==VERSION||!ref(envelope.query_ref)||envelope.query_ref!==turn.query_ref||!ref(envelope.conversation_id)||!ref(envelope.turn_id)||turn.conversation_id&&turn.conversation_id!==envelope.conversation_id||turn.turn_id&&turn.turn_id!==envelope.turn_id||!Number.isSafeInteger(envelope.seq)||envelope.seq<1||!TYPES.has(envelope.type)||!Number.isFinite(envelope.at)||!object(envelope.data))return unchanged('REJECTED');
 if(envelope.seq<=(turn.last_event_seq??0))return unchanged('DUPLICATE');
 if(envelope.seq!==(turn.last_event_seq??0)+1)return unchanged('GAP');
 const next=blankTurn(turn),d=envelope.data,seq=envelope.seq;
 next.conversation_id=envelope.conversation_id;next.turn_id=envelope.turn_id;
 try{
  if(envelope.type==='turn.created'){
   if(!text(d.question)||next.question&&next.question!==d.question)throw Error();next.question=d.question;
  }else if(envelope.type==='tool.started'||envelope.type==='tool.completed'){
   if(!text(d.step_id)||!text(d.tool_name)||!text(d.label)||envelope.type==='tool.completed'&&!text(d.status))throw Error();
   const existing=next.blocks.find(b=>b.kind==='step'&&b.step_id===d.step_id);
   if(existing&&(existing.tool_name!==d.tool_name||existing.label!==d.label))throw Error();
   if(existing){if(envelope.type==='tool.completed')Object.assign(existing,{status:d.status,...(d.returned!==undefined?{returned:clone(d.returned)}:{}),last_seq:seq});}
   else next.blocks.push({kind:'step',step_id:d.step_id,tool_name:d.tool_name,label:d.label,status:envelope.type==='tool.started'?'RUNNING':d.status,...(d.returned!==undefined?{returned:clone(d.returned)}:{}),seq,last_seq:seq});
  }else if(envelope.type==='answer.delta'){
   if(!text(d.message_id)||typeof d.delta!=='string')throw Error();
   const last=next.blocks.at(-1);
   if(last?.kind==='message'&&last.message_id===d.message_id){last.markdown+=d.delta;last.last_seq=seq;}
   else next.blocks.push({kind:'message',message_id:d.message_id,markdown:d.delta,seq,last_seq:seq});
  }else if(envelope.type==='answer.replace'){
   if(!text(d.message_id)||typeof d.markdown!=='string')throw Error();
   const segments=next.blocks.filter(b=>b.kind==='message'&&b.message_id===d.message_id);
   if(!segments.length)next.blocks.push({kind:'message',message_id:d.message_id,markdown:d.markdown,seq,last_seq:seq});
   else{
    // Preserve the existing slots around tool steps, reconciling only this message.
    let offset=0;segments.forEach((block,index)=>{const end=index===segments.length-1?d.markdown.length:Math.min(offset+block.markdown.length,d.markdown.length);block.markdown=d.markdown.slice(offset,end);block.last_seq=seq;offset=end;});
   }
  }else if(envelope.type==='citation.registered'){
   const row=clone(d);
   checkedRegistry([...next.citations,row]);
   const previous=next.citations.find(c=>c.citation_ref===row.citation_ref);
   if(!previous)next.citations.push(row);
  }else{
   if(!SERVER.has(d.status)||!TERMINAL.has(d.status)&&d.status!=='STALE')throw Error();
   next.status=d.status;next.historical_status=d.historical_status??null;next.historical=next.historical||d.status==='STALE';next.reason=d.reason??null;
   if(d.answer!==undefined){next.answer=clone(d.answer);checkedRegistry(registry(d.answer));}
   if(d.partial_answer!==undefined){next.partial_answer=clone(d.partial_answer);checkedRegistry(registry(d.partial_answer));}
   for(const row of registry(d.answer??d.partial_answer)){const previous=next.citations.find(c=>c.citation_ref===row.citation_ref);if(previous&&!equal(previous.citation,row.citation))throw Error();if(!previous)next.citations.push(row);}
   checkedRegistry(next.citations);next.cancel_pending=false;
  }
 }catch{return unchanged('REJECTED');}
 next.events.push(clone(envelope));next.last_event_seq=seq;
 return {status:'APPLIED',turn:next,expected_seq:seq+1};
}

/** Incremental UTF-8 SSE parser. Incomplete frames at EOF are not dispatched. */
export async function* parseLightogChatSse(body,{signal}={}){
 if(!body?.getReader)throw fail('LIGHTOG_CHAT_STREAM_INVALID','流式响应暂不可读。');
 const reader=body.getReader(),decoder=new TextDecoder();let buffer='',data=[],event='',id='',first=true;
 const abort=()=>{void reader.cancel().catch(()=>{});};
 signal?.addEventListener('abort',abort,{once:true});
 const line=value=>{
  if(value===''){const frame=data.length?{id,event:event||'message',data:data.join('\n')}:null;data=[];event='';return frame;}
  if(value.startsWith(':'))return null;
  const colon=value.indexOf(':'),field=colon<0?value:value.slice(0,colon);let v=colon<0?'':value.slice(colon+1);if(v.startsWith(' '))v=v.slice(1);
  if(field==='data')data.push(v);else if(field==='event')event=v;else if(field==='id'&&!v.includes('\0'))id=v;
  return null;
 };
 try{
  while(!signal?.aborted){
   const {value,done}=await reader.read();if(signal?.aborted)break;
   buffer+=done?decoder.decode():decoder.decode(value,{stream:true});
   if(first&&buffer.length){first=false;if(buffer.charCodeAt(0)===0xfeff)buffer=buffer.slice(1);}
   let index=0;
   while(index<buffer.length){
    const end=buffer.slice(index).search(/[\r\n]/);if(end<0)break;
    const at=index+end;if(buffer[at]==='\r'&&at===buffer.length-1&&!done)break;
    const frame=line(buffer.slice(index,at));index=at+(buffer[at]==='\r'&&buffer[at+1]==='\n'?2:1);if(frame)yield frame;
   }
   buffer=buffer.slice(index);if(done)break;
  }
 }finally{signal?.removeEventListener('abort',abort);try{await reader.cancel();}catch{}reader.releaseLock();}
}

/** api(path, body?) is the existing JSON adapter; requestStream is GET-only fetch. */
export function createLightogChatClient({api,requestStream=globalThis.fetch,uuid=()=>globalThis.crypto.randomUUID(),storage=globalThis.localStorage,onChange=()=>{},reconnectLimit=3}={}){
 const entries=new Map();reconnectLimit=Number.isSafeInteger(reconnectLimit)&&reconnectLimit>=0?Math.min(reconnectLimit,10):3;
 function stored(libraryId){
  if(typeof storage?.getItem!=='function')throw fail('LIGHTOG_CHAT_STORAGE_UNAVAILABLE','无法读取本机对话收据，尚未发送问题。');
  const raw=storage.getItem(storageKey(libraryId));if(raw==null)return null;
  let row;try{row=JSON.parse(raw);}catch{throw fail('LIGHTOG_CHAT_RECEIPT_UNREADABLE','本机对话收据暂不可读，未重复提交。');}
  const p=row?.receipt;
  if(!object(row)||row.version!==STORAGE_VERSION||row.library_id!==libraryId||p!==null&&(!object(p)||p.library_id!==libraryId||!UUID.test(p.request_id??'')||!text(p.question)||p.query_ref!==null&&!ref(p.query_ref)||p.conversation_id!==null&&!ref(p.conversation_id)||p.turn_id!==null&&!ref(p.turn_id)||typeof p.locked!=='boolean'||typeof p.cancel_pending!=='boolean'||!SERVER.has(p.status)&&!LOCAL.has(p.status)||!p.query_ref&&['STARTING','START_UNCONFIRMED'].includes(p.status)&&!p.locked)||row.selected!==null&&(!object(row.selected)||row.selected.query_ref!==null&&!ref(row.selected.query_ref)||row.selected.conversation_id!==null&&!ref(row.selected.conversation_id)))throw fail('LIGHTOG_CHAT_RECEIPT_UNREADABLE','本机对话收据不完整，未重复提交。');
  if(row.incomplete_turns!==undefined&&(!Array.isArray(row.incomplete_turns)||row.incomplete_turns.some(t=>!object(t)||!ref(t.query_ref)||t.library_id!==libraryId||!SERVER.has(t.status)||terminal(t)||t.conversation_id!==null&&!ref(t.conversation_id)||!text(t.question))))throw fail('LIGHTOG_CHAT_RECEIPT_UNREADABLE','本机未完成对话记录不完整，未重复提交。');
  return row;
 }
 function entry(libraryId){
  if(!entries.has(libraryId)){
   const e={libraryId,turns:new Map(),conversations:[],legacy_queries:[],visible:[],conversation_id:null,query_ref:null,receipt:null,error:null,storageBlocked:false,observed_pin:null,selectionEpoch:0,listEpoch:0,reads:new Map(),stream:null,streamState:{status:'CLOSED',query_ref:null,last_event_seq:0,error:null}};
   try{if(!ref(libraryId))throw fail('LIGHTOG_CHAT_LIBRARY_INVALID','请选择有效的资料库。');const row=stored(libraryId);if(row){e.receipt=row.receipt;e.conversation_id=row.selected?.conversation_id??null;e.query_ref=row.selected?.query_ref??null;for(const t of row.incomplete_turns??[])e.turns.set(t.query_ref,blankTurn({...t,needs_readback:true}));if(e.receipt?.query_ref){const p=e.receipt;e.turns.set(p.query_ref,blankTurn({...p,needs_readback:true,source_scope:p.source_scope??null}));}if(e.query_ref){if(!e.turns.has(e.query_ref))e.turns.set(e.query_ref,blankTurn({...row.selected,library_id:libraryId,status:SERVER.has(row.selected.status)?row.selected.status:'RUNNING',needs_readback:true}));e.visible=[e.query_ref];}}}
   catch(error){e.storageBlocked=true;e.error=info(error,'本机对话收据暂不可读，尚未发送问题。');}
   entries.set(libraryId,e);
  }return entries.get(libraryId);
 }
 function snapshot(libraryId){
  const e=entry(libraryId),turn=e.turns.get(e.query_ref)??null,receipt=e.receipt;
  return clone({library_id:libraryId,conversations:e.conversations,legacy_queries:e.legacy_queries,conversation_id:e.conversation_id,query_ref:e.query_ref,turns:e.visible.map(q=>e.turns.get(q)).filter(Boolean),turn,status:e.storageBlocked?'LOCAL_UNAVAILABLE':receipt?.locked&&receipt.query_ref===null?receipt.status:turn?.local_status??turn?.status??'IDLE',locked:e.storageBlocked||receipt?.locked===true||[...e.turns.values()].some(t=>!terminal(t)),pending:receipt?.locked?receipt:null,receipt,error:e.error,stream:e.streamState,observed_pin:e.observed_pin,needs_readback:turn?.needs_readback??Boolean(receipt?.locked)});
 }
 function notify(e){try{onChange(snapshot(e.libraryId));}catch{/* A rendering error cannot change request semantics. */}}
 const result=(status,e,extra={})=>({status,library_id:e.libraryId,state:snapshot(e.libraryId),...extra});
 function persist(e,required=false){
  const fields=['library_id','query_ref','conversation_id','turn_id','turn_index','question','status','source_scope','historical','historical_status','cancel_pending','local_status'];
  const minimal=t=>Object.fromEntries(fields.filter(k=>t[k]!==undefined).map(k=>[k,clone(t[k])]));
  const selected=e.turns.get(e.query_ref),row={version:STORAGE_VERSION,library_id:e.libraryId,receipt:e.receipt?Object.fromEntries(['library_id','request_id','question','conversation_id','turn_id','turn_index','query_ref','status','locked','cancel_pending','local_status','source_scope','historical','historical_status'].filter(k=>e.receipt[k]!==undefined).map(k=>[k,clone(e.receipt[k])])):null,selected:{conversation_id:e.conversation_id,query_ref:e.query_ref,...(selected?minimal(selected):{})},incomplete_turns:[...e.turns.values()].filter(t=>!terminal(t)&&text(t.question)).map(minimal)};
  try{if(typeof storage?.setItem!=='function')throw Error();const raw=JSON.stringify(row);storage.setItem(storageKey(e.libraryId),raw);if(storage.getItem(storageKey(e.libraryId))!==raw)throw Error();return true;}
  catch{e.error=info(fail('LIGHTOG_CHAT_RECEIPT_NOT_SAVED','稳定对话收据未保存，未自动重发。'));if(required){e.storageBlocked=true;throw fail('LIGHTOG_CHAT_RECEIPT_NOT_SAVED','稳定对话收据未保存，问题尚未发送。');}return false;}
 }
 function changed(e){persist(e);notify(e);}
 function syncReceipt(e,turn){
  const p=e.receipt;if(!p||p.query_ref!==turn.query_ref)return;
  Object.assign(p,{status:turn.status,source_scope:clone(turn.source_scope),historical:turn.historical,historical_status:turn.historical_status,locked:!terminal(turn),cancel_pending:terminal(turn)?false:p.cancel_pending});
  turn.cancel_pending=p.cancel_pending;if(terminal(turn)){turn.local_status=null;p.local_status=null;}else if(p.cancel_pending){turn.local_status=p.local_status??'CANCEL_UNCONFIRMED';}
 }
 function observe(e,t){if(e.observed_pin&&t.source_scope)t.historical=t.historical||!alignedPin(e.observed_pin,t.source_scope);}
 function turnFromResponse(e,response,expectedRef){
  if(!object(response)||response.library_id!==e.libraryId||!ref(response.query_ref)||expectedRef&&response.query_ref!==expectedRef||!SERVER.has(response.status)||!text(response.question)||!validScope(response.source_scope,e.libraryId))throw fail('LIGHTOG_CHAT_READBACK_UNCONFIRMED','对话记录尚未匹配原资料库、提问与来源版本。');
  const prior=e.turns.get(response.query_ref);
  if(prior?.question&&prior.question!==response.question||prior?.conversation_id&&response.conversation_id!==prior.conversation_id||prior?.turn_id&&response.turn_id!==prior.turn_id||prior?.source_scope&&response.source_scope&&!equal(prior.source_scope,response.source_scope))throw fail('LIGHTOG_CHAT_READBACK_UNCONFIRMED','对话身份或来源版本发生不一致，保留原结果。');
  if(response.conversation_id!==undefined&&response.conversation_id!==null&&!ref(response.conversation_id)||response.turn_id!==undefined&&response.turn_id!==null&&!ref(response.turn_id))throw fail('LIGHTOG_CHAT_READBACK_UNCONFIRMED','对话标识尚未完整读回。');
  let next=blankTurn({...response,events:[],blocks:[],citations:[],last_event_seq:0});
  if(Array.isArray(response.events)){
   for(const event of response.events){const reduced=reduceLightogChatEvent(next,event);if(!['APPLIED','DUPLICATE'].includes(reduced.status))throw fail('LIGHTOG_CHAT_EVENT_GAP','事件记录不连续，已保留最后确认的位置。');next=reduced.turn;}
   if(!Number.isSafeInteger(response.last_event_seq)||response.last_event_seq!==next.last_event_seq)throw fail('LIGHTOG_CHAT_EVENT_GAP','事件游标与读回记录尚未对齐。');
   if(prior&&next.last_event_seq<prior.last_event_seq)return prior;
  }else if(prior?.last_event_seq){next=blankTurn({...prior,...response,events:prior.events,blocks:prior.blocks,citations:prior.citations,last_event_seq:prior.last_event_seq});}
  else next.legacy=true;
  // Preserve the immutable public event timeline; status readback supplies the envelope.
  Object.assign(next,{status:response.status,answer:clone(response.answer??next.answer),partial_answer:clone(response.partial_answer??next.partial_answer),source_scope:clone(response.source_scope??next.source_scope),historical:prior?.historical===true||response.historical===true||response.source_current===false||response.status==='STALE',historical_status:response.historical_status??null,needs_readback:false});
  const finalRegistry=registry(next.answer??next.partial_answer);checkedRegistry(finalRegistry);
  for(const row of finalRegistry){const previous=next.citations.find(c=>c.citation_ref===row.citation_ref);if(previous&&!equal(previous.citation,row.citation))throw fail('LIGHTOG_CHAT_CITATION_UNCONFIRMED','最终引用与本轮登记来源不一致。');if(!previous)next.citations.push(row);}
  checkedRegistry(next.citations);observe(e,next);return next;
 }
 async function readTurn(e,queryRef){
  const epoch=(e.reads.get(queryRef)??0)+1;e.reads.set(queryRef,epoch);
  const response=await api(queryPath(e.libraryId,queryRef));
  if(e.reads.get(queryRef)!==epoch)return null;
  const turn=turnFromResponse(e,response,queryRef);e.turns.set(queryRef,turn);syncReceipt(e,turn);changed(e);return turn;
 }
 function stopStream(e,status='DISCONNECTED'){
  const stream=e.stream;e.stream=null;if(stream){stream.closed=true;stream.controller.abort();}
  e.streamState={...e.streamState,status};notify(e);
 }
 function active(e,session){return e.stream===session&&!session.closed&&!session.controller.signal.aborted;}
 async function consume(e,session){
  let retries=0;
  while(active(e,session)){
   let turn=e.turns.get(session.queryRef);if(!turn)break;
   if(terminal(turn)){e.streamState={status:'ENDED',query_ref:turn.query_ref,last_event_seq:turn.last_event_seq,error:null};notify(e);break;}
   e.streamState={status:retries?'RECONNECTING':'CONNECTING',query_ref:turn.query_ref,last_event_seq:turn.last_event_seq,error:null};notify(e);
   try{
    const cursor=turn.last_event_seq,response=await requestStream(queryPath(e.libraryId,turn.query_ref)+'/events?after='+cursor,{method:'GET',headers:{Accept:'text/event-stream','Last-Event-ID':String(cursor)},signal:session.controller.signal});
    if(!active(e,session))break;
    if(response?.ok===false)throw Object.assign(Error('stream rejected'),{status:response.status});
    const contentType=response?.headers?.get?.('content-type');if(contentType&&!contentType.toLowerCase().startsWith('text/event-stream'))throw fail('LIGHTOG_CHAT_STREAM_INVALID','未收到可确认的对话事件流。');
    e.streamState.status='CONNECTED';notify(e);
    for await(const frame of parseLightogChatSse(response?.body??response,{signal:session.controller.signal})){
     if(!active(e,session))break;
     let event;try{event=JSON.parse(frame.data);}catch{throw fail('LIGHTOG_CHAT_STREAM_INVALID','流式事件暂不可解析，未跳过当前位置。');}
     if(String(event.seq)!==frame.id||frame.event!==event.type)throw fail('LIGHTOG_CHAT_STREAM_INVALID','流式帧与事件身份不一致。');
     turn=e.turns.get(session.queryRef);let reduced=reduceLightogChatEvent(turn,event);
     if(reduced.status==='GAP'){
      await readTurn(e,session.queryRef);if(!active(e,session))break;
      turn=e.turns.get(session.queryRef);reduced=reduceLightogChatEvent(turn,event);
     }
     if(reduced.status==='GAP')throw fail('LIGHTOG_CHAT_EVENT_GAP','事件序号仍有缺口，已保留最后确认的位置。');
     if(reduced.status==='REJECTED')throw fail('LIGHTOG_CHAT_STREAM_INVALID','事件未匹配当前对话，已保留原结果。');
     if(reduced.status==='APPLIED'){
      turn=reduced.turn;observe(e,turn);e.turns.set(turn.query_ref,turn);syncReceipt(e,turn);e.streamState.last_event_seq=turn.last_event_seq;e.error=null;changed(e);
     }
     if(terminal(e.turns.get(session.queryRef)))break;
    }
    if(!active(e,session))break;
    turn=e.turns.get(session.queryRef);if(terminal(turn)){e.streamState={status:'ENDED',query_ref:turn.query_ref,last_event_seq:turn.last_event_seq,error:null};notify(e);break;}
    throw fail('LIGHTOG_CHAT_STREAM_DISCONNECTED','连接已断开，已保留收到的正文。');
   }catch(error){
    if(!active(e,session))break;
    const t=e.turns.get(session.queryRef);if(terminal(t)){e.streamState={status:'ENDED',query_ref:t.query_ref,last_event_seq:t.last_event_seq,error:null};notify(e);break;}
    const gap=error?.code==='LIGHTOG_CHAT_EVENT_GAP',invalid=error?.code==='LIGHTOG_CHAT_STREAM_INVALID';
    e.streamState={status:gap?'GAP':'DISCONNECTED',query_ref:session.queryRef,last_event_seq:t.last_event_seq,error:info(error,'连接中断，已保留收到的正文；查询未被取消。')};notify(e);
    if(gap||invalid||rejected(error)||retries>=reconnectLimit)break;
    retries++;
   }
  }
  if(e.stream===session)e.stream=null;
  return result('CLOSED',e);
 }
 const client={
  snapshot,current:snapshot,
  noteVersion({libraryId,pin}={}){
   const e=entry(libraryId);if(!validScope(pin,libraryId))return result('REJECTED',e,{error:info(null,'资料库版本尚未完整读回。')});
   e.observed_pin=pin.query_read_view?{library_id:libraryId,query_read_view:clone(pin.query_read_view)}:Object.fromEntries(PIN.map(k=>[k,pin[k]]));for(const turn of e.turns.values())observe(e,turn);const t=e.turns.get(e.receipt?.query_ref);if(t)syncReceipt(e,t);changed(e);return result('UPDATED',e);
  },
  newChat({libraryId}={}){
   const e=entry(libraryId);stopStream(e);e.selectionEpoch++;e.conversation_id=null;e.query_ref=null;e.visible=[];changed(e);return result('UPDATED',e);
  },
  async list({libraryId}={}){
   const e=entry(libraryId),epoch=++e.listEpoch;
   const [conversations,legacy]=await Promise.allSettled([api(base(libraryId)+'/conversations'),api(base(libraryId)+'/queries')]);
   if(epoch!==e.listEpoch)return result('IGNORED',e);
   try{
    if(conversations.status==='rejected')throw conversations.reason;
    if(!Array.isArray(conversations.value?.items)||conversations.value.items.some(c=>!ref(c?.conversation_id)))throw fail('LIGHTOG_CHAT_HISTORY_INVALID','对话列表尚未完整读回。');
    e.conversations=clone(conversations.value.items);
    if(legacy.status==='fulfilled'&&Array.isArray(legacy.value?.items))e.legacy_queries=clone(legacy.value.items.filter(t=>ref(t?.query_ref)&&!t.conversation_id));
    e.error=legacy.status==='rejected'?info(legacy.reason,'旧查询历史暂未读回。'):null;notify(e);return result('UPDATED',e);
   }catch(error){e.error=info(error,'对话列表暂不可读，原记录保留。');notify(e);return result('UNCONFIRMED',e,{error:e.error});}
  },
  async open({libraryId,conversationId,queryRef}={}){
   const e=entry(libraryId);if((conversationId?1:0)+(queryRef?1:0)!==1||conversationId&&!ref(conversationId)||queryRef&&!ref(queryRef))return result('REJECTED',e,{error:info(null,'请选择明确的对话或历史查询。')});
   stopStream(e);const epoch=++e.selectionEpoch;
   try{
    const response=await api(conversationId?base(libraryId)+'/conversations/'+encodeURIComponent(conversationId):queryPath(libraryId,queryRef));
    if(epoch!==e.selectionEpoch)return result('IGNORED',e);
    let turns;
    if(conversationId){if(response?.library_id!==libraryId||response?.conversation_id!==conversationId||!Array.isArray(response.turns))throw fail('LIGHTOG_CHAT_READBACK_UNCONFIRMED','对话未匹配当前资料库。');turns=response.turns.map(t=>turnFromResponse(e,t));if(turns.some(t=>t.conversation_id!==conversationId)||new Set(turns.map(t=>t.query_ref)).size!==turns.length||turns.some((t,i)=>!Number.isSafeInteger(t.turn_index)||t.turn_index<1||i>0&&t.turn_index<=turns[i-1].turn_index))throw fail('LIGHTOG_CHAT_READBACK_UNCONFIRMED','对话轮次或顺序尚未完整读回。');}
    else turns=[turnFromResponse(e,response,queryRef)];
    for(const t of turns){e.turns.set(t.query_ref,t);syncReceipt(e,t);}
    e.conversation_id=conversationId??turns[0]?.conversation_id??null;e.visible=turns.map(t=>t.query_ref);e.query_ref=turns.at(-1)?.query_ref??null;e.error=null;changed(e);return result('UPDATED',e);
   }catch(error){if(epoch!==e.selectionEpoch)return result('IGNORED',e);e.error=info(error,'对话暂未读回，原问题和正文保留。');notify(e);return result('UNCONFIRMED',e,{error:e.error});}
  },
  async start({libraryId,question,conversationId}={}){
   const e=entry(libraryId);let requestId,selectionEpoch;
   try{
    const saved=stored(libraryId);if(saved?.receipt?.locked&&saved.receipt.request_id!==e.receipt?.request_id)e.receipt=clone(saved.receipt);
    if(e.storageBlocked||e.receipt?.locked||[...e.turns.values()].some(t=>!terminal(t)))return result('BUSY',e,{error:info(null,'原请求尚待确认，未重复提交。')});
    conversationId=conversationId===undefined?e.conversation_id:conversationId;
    if(!ref(libraryId)||!text(question)||conversationId!==undefined&&conversationId!==null&&!ref(conversationId)||typeof api!=='function'||typeof uuid!=='function')throw fail('LIGHTOG_CHAT_START_INVALID','请填写问题并选择有效资料库。');
    requestId=uuid();if(!UUID.test(requestId??''))throw fail('LIGHTOG_CHAT_REQUEST_INVALID','请求标识无效，问题尚未发送。');
    stopStream(e);selectionEpoch=++e.selectionEpoch;
    e.receipt={library_id:libraryId,request_id:requestId,question,conversation_id:conversationId??null,turn_id:null,turn_index:null,query_ref:null,status:'STARTING',locked:true,cancel_pending:false};e.error=null;persist(e,true);notify(e);
   }catch(error){e.error=info(error,'问题尚未发送，请检查本机收据与输入。');notify(e);return result('REJECTED',e,{error:e.error});}
   try{
    const pg=e.observed_pin?.query_read_view;
    const selection=pg?{...(pg.at?{at:pg.at}:{}),...(pg.as_of?{as_of:{timestamp:pg.as_of}}:{view_revision:pg.view_revision})}:{};
    const body={question,request_id:requestId,...(conversationId?{conversation_id:conversationId}:{}),...selection},response=await api(base(libraryId)+'/ask',body);
    if(e.receipt?.request_id!==requestId)return result('IGNORED',e);
    if(!ref(response?.query_ref)||!ref(response?.conversation_id)||!ref(response?.turn_id)||!Number.isSafeInteger(response?.turn_index)||response.turn_index<1||!SERVER.has(response?.status)||response.library_id!==undefined&&response.library_id!==libraryId||conversationId&&response.conversation_id!==conversationId)throw fail('LIGHTOG_CHAT_START_UNCONFIRMED','启动回执尚未匹配原请求，未重复提交。');
    Object.assign(e.receipt,{query_ref:response.query_ref,conversation_id:response.conversation_id,turn_id:response.turn_id,turn_index:response.turn_index,status:response.status});
    const t=blankTurn({...e.receipt,status:response.status,needs_readback:true});e.turns.set(t.query_ref,t);
    if(e.selectionEpoch===selectionEpoch){e.conversation_id=t.conversation_id;e.query_ref=t.query_ref;if(conversationId){if(!e.visible.includes(t.query_ref))e.visible.push(t.query_ref);}else e.visible=[t.query_ref];}
    e.error=null;changed(e);return result('CONFIRMED',e,{receipt:clone(e.receipt)});
   }catch(error){
    if(e.receipt?.request_id!==requestId)return result('IGNORED',e);
    e.receipt.status=rejected(error)?'START_REJECTED':'START_UNCONFIRMED';e.receipt.locked=!rejected(error);e.error=info(error,rejected(error)?'请求未被接受，可以在处理原因后明确重提。':'启动结果未知，已保留稳定收据并暂停重复提交。');changed(e);return result(rejected(error)?'REJECTED':'UNCONFIRMED',e,{error:e.error});
   }
  },
  async subscribe({libraryId,queryRef}={}){
   const e=entry(libraryId);queryRef??=e.query_ref;
   if(!ref(queryRef)||!e.turns.has(queryRef)||queryRef!==e.query_ref)return result('REJECTED',e,{error:info(null,'尚无明确的当前查询，未订阅其他运行。')});
   if(e.stream?.queryRef===queryRef)return e.stream.promise;
   stopStream(e);const session={queryRef,controller:new AbortController(),closed:false,promise:null};e.stream=session;
   session.promise=(async()=>{
    try{if(e.turns.get(queryRef).needs_readback)await readTurn(e,queryRef);}catch(error){if(active(e,session)){e.error=info(error,'查询读回未确认，保留原请求；未重新提交。');e.streamState={status:'DISCONNECTED',query_ref:queryRef,last_event_seq:e.turns.get(queryRef).last_event_seq,error:e.error};notify(e);e.stream=null;}return result('UNCONFIRMED',e,{error:e.error});}
    if(!active(e,session))return result('IGNORED',e);return consume(e,session);
   })();return session.promise;
  },
  closeStream({libraryId}={}){if(libraryId!==undefined){const e=entry(libraryId);stopStream(e);return result('CLOSED',e);}for(const e of entries.values())stopStream(e);return {status:'CLOSED'};},
  async cancel({libraryId,queryRef}={}){
   const e=entry(libraryId);queryRef??=e.query_ref;const t=e.turns.get(queryRef);
   if(!ref(queryRef)||!t||queryRef!==e.query_ref||terminal(t))return result('REJECTED',e,{error:info(null,'没有明确的当前运行可停止。')});
   if(t.cancel_pending||e.receipt?.query_ref===queryRef&&e.receipt.cancel_pending)return result('BUSY',e,{error:info(null,'停止结果尚待确认，未重复提交。')});
   t.cancel_pending=true;t.local_status='CANCEL_PENDING';if(e.receipt?.query_ref===queryRef){e.receipt.cancel_pending=true;e.receipt.local_status=t.local_status;}changed(e);
   try{
    const response=await api(queryPath(libraryId,queryRef)+'/cancel',{}),current=e.turns.get(queryRef);
    if(terminal(current)&&!TERMINAL.has(response?.status))return result('UPDATED',e);
    const turn=turnFromResponse(e,response,queryRef);e.turns.set(queryRef,turn);syncReceipt(e,turn);if(terminal(turn)&&e.stream?.queryRef===queryRef)stopStream(e,'ENDED');e.error=null;changed(e);return result(turn.status==='CANCELLED'?'CANCELLED':'UPDATED',e);
   }catch(error){
    const current=e.turns.get(queryRef);if(terminal(current)){current.cancel_pending=false;syncReceipt(e,current);changed(e);return result('UPDATED',e);}
    current.cancel_pending=!rejected(error);current.local_status=rejected(error)?null:'CANCEL_UNCONFIRMED';if(e.receipt?.query_ref===queryRef){e.receipt.cancel_pending=current.cancel_pending;e.receipt.local_status=current.local_status;}e.error=info(error,rejected(error)?'停止请求未被接受，原运行状态保留。':'停止结果未知，未将查询标为已停止。');changed(e);return result(rejected(error)?'REJECTED':'UNCONFIRMED',e,{error:e.error});
   }
  },
  async citation({libraryId,queryRef,citationRef}={}){
   const e=entry(libraryId),t=e.turns.get(queryRef),known=t?.citations.find(c=>c.citation_ref===citationRef),epoch=e.selectionEpoch;
   if(!ref(queryRef)||!ref(citationRef)||!e.visible.includes(queryRef)||!known)return result('REJECTED',e,{error:info(null,'此编号未绑定当前对话的已登记来源。')});
   try{
    const response=await api(queryPath(libraryId,queryRef)+'/citations/'+encodeURIComponent(citationRef));
    if(epoch!==e.selectionEpoch||!e.visible.includes(queryRef))return result('IGNORED',e);
    const matches=validCitation(response?.citation,citationRef)&&await citationMatches(known.citation,response)&&Array.isArray(response.source_previews);
    if(epoch!==e.selectionEpoch||!e.visible.includes(queryRef))return result('IGNORED',e);
    if(!matches)throw fail('LIGHTOG_CHAT_CITATION_UNCONFIRMED','引用读回与本轮登记来源不一致，未使用其他版本替代。');
    return result('READY',e,{query_ref:queryRef,citation_ref:citationRef,citation:clone(response.citation),source_previews:clone(response.source_previews),historical:t.historical||response.historical===true});
   }catch(error){if(epoch!==e.selectionEpoch)return result('IGNORED',e);return result('UNCONFIRMED',e,{error:info(error,'引用暂不可读，未使用其他资料或版本替代。')});}
  }
 };
 return Object.freeze(client);
}
