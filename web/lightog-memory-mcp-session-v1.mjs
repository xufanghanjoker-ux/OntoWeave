import {createHash,randomUUID} from 'node:crypto';
import {LIGHTOG_MEMORY_MCP_TOOLS,WRITE_TOOLS,TOOL_PORTS,isPlainObject,validateMemoryToolArguments,normalizeMemoryBinding,canonicalMemoryJson} from './lightog-memory-mcp-contract-v1.mjs';

const PROTOCOL_VERSION='2025-11-25';
const PUBLIC_ERRORS=Object.freeze({
  INVALID_ARGUMENTS:'The tool arguments are invalid.',TIME_VIEW_UNAVAILABLE:'This adapter currently supports the current view only; at/as_of are not silently ignored.',
  FORBIDDEN:'The credential does not allow this operation.',UNAUTHORIZED:'Product authentication failed.',CREDENTIAL_REVOKED:'The product credential was revoked.',
  NOT_FOUND:'The record is not available within the credential-bound library.',LIBRARY_NOT_FOUND:'The bound library is not available.',
  WORKSPACE_MISMATCH:'The response workspace does not match the configured binding.',SCOPE_MISMATCH:'The response does not match the configured workspace and library.',
  REPLAY_CONFLICT:'This protocol request identity was already used with different content.',STALE_READ_VIEW:'The read view changed; no mixed-version result is returned.',
  RESULT_TOO_LARGE:'The service result exceeds the adapter output budget.',INVALID_SERVICE_RESPONSE:'The service did not return the agreed product response.',
  LOCAL_SERVICE_UNAVAILABLE:'The local product service is unavailable.',WAIT_CANCELLED:'Waiting was cancelled. This does not cancel already submitted work.',
  LOCAL_SERVICE_TIMEOUT:'The local product service request timed out.',LOCAL_REQUEST_CANCELLED:'Waiting for the local product service was cancelled.',
  ACCESS_REQUIRED:'The product service requires valid access.',ACCESS_DENIED:'The product service denied this request.',
  LOCAL_SERVICE_NOT_FOUND:'The requested product record or route is not available.',REQUEST_CONFLICT:'The product service rejected a conflicting request.',
  REQUEST_TOO_LARGE:'The product service rejected an oversized request.',SERVICE_REQUEST_REJECTED:'The product service rejected this request.',
  RESPONSE_TOO_LARGE:'The product service response exceeded its byte budget.',LOCAL_CLIENT_CONFIG_INVALID:'The product client configuration is invalid.',
  SERVICE_ERROR:'The product service could not complete the request.',UNKNOWN:'The write outcome is unknown. Do not automatically repeat it or generate a new key.',
  SESSION_CLOSED:'This MCP session is closed.'
});
const sameScope=(scope,binding)=>isPlainObject(scope)&&scope.workspace_id===binding.workspace_id&&scope.library_id===binding.library_id;
const rpcError=(id,code,message)=>({jsonrpc:'2.0',id,error:{code,message}});
const toolResult=(id,envelope,isError=false)=>({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(envelope)}],structuredContent:envelope,isError}});
const errorCode=error=>typeof error?.code==='string'&&Object.hasOwn(PUBLIC_ERRORS,error.code)?error.code:'SERVICE_ERROR';
const codeError=code=>Object.assign(new Error(PUBLIC_ERRORS[code]),{code});

function boundSearch(envelope,args){
  const data=envelope.data;
  if(!Array.isArray(data.knowledge)||data.generated_answer===true)throw codeError('INVALID_SERVICE_RESPONSE');
  let remaining=args.evidence_limit??2;
  let evidenceOmitted=0,quotesClipped=0;
  const selected=data.knowledge.slice(0,args.limit??5);
  const knowledge=selected.map(item=>{
    if(!isPlainObject(item)||(item.evidence!==undefined&&!Array.isArray(item.evidence)))throw codeError('INVALID_SERVICE_RESPONSE');
    const evidence=(item.evidence||[]).slice(0,remaining).map(part=>{
      if(!isPlainObject(part)||(part.quote!==undefined&&typeof part.quote!=='string'))throw codeError('INVALID_SERVICE_RESPONSE');
      if(part.quote!==undefined&&[...part.quote].length>400){quotesClipped++;return {...part,quote:[...part.quote].slice(0,400).join(''),quote_truncated:true};}
      return part;
    });
    evidenceOmitted+=(item.evidence?.length||0)-evidence.length;
    remaining-=evidence.length;
    return {...item,evidence,...(evidence.length<(item.evidence?.length||0)?{evidence_omitted:true}:{})};
  });
  return {...envelope,data:{...data,knowledge},adapter:{request_ref:envelope.adapter.request_ref,bounds:{knowledge_omitted:data.knowledge.length-selected.length,evidence_omitted:evidenceOmitted,quotes_clipped:quotesClipped}}};
}

/**
 * service: {binding, search, getRecord, appendRecord, addResult, getStatus}.
 * Each method(input, {signal,request_ref,idempotency_key?}) returns a product
 * envelope {scope:{workspace_id,library_id},data,service_instance_ref?}.
 * The service authenticates/authorizes every invocation; this adapter cannot
 * replace product auth. No provider, store or graph writer is loaded here.
 */
export function createLightogMemoryMcpSession({service,callTimeoutMs=60000,maxResultBytes=131072}={}){
  const binding=normalizeMemoryBinding(service?.binding);
  for(const method of Object.values(TOOL_PORTS))if(typeof service?.[method]!=='function')throw new Error('Missing product service port');
  if(!Number.isSafeInteger(callTimeoutMs)||callTimeoutMs<1||callTimeoutMs>300000||!Number.isSafeInteger(maxResultBytes)||maxResultBytes<1024||maxResultBytes>1048576)throw new Error('Invalid adapter limits');
  const sessionRef=randomUUID();
  const writes=new Map();
  const inflight=new Map();
  let phase='NEW';
  let closed=false;

  const failure=(id,code,{request_ref,outcome,no_auto_retry,target_record_ref,record_ref}={})=>toolResult(id,{scope:{...binding},data:{error:{code,message:PUBLIC_ERRORS[code]||PUBLIC_ERRORS.SERVICE_ERROR}},adapter:{...(request_ref?{request_ref}:{}),...(outcome?{outcome}:{}),...(no_auto_retry?{no_auto_retry:true}:{}),...(target_record_ref?{target_record_ref}:{}),...(record_ref?{record_ref}:{}),...(code==='UNKNOWN'?{recovery:{key_only_lookup_available:false,action:'Keep the request receipt. Query a known record_ref; otherwise await product reconciliation without resending.'}}:{})}},true);

  async function invoke(id,name,args,requestRef,key){
    const write=WRITE_TOOLS.has(name);
    if(closed)return failure(id,'SESSION_CLOSED',{request_ref:requestRef,outcome:write?'NOT_SENT':undefined});
    const controller=new AbortController();
    const idKey=JSON.stringify([typeof id,id]);
    const timer=setTimeout(()=>controller.abort('timeout'),callTimeoutMs);
    inflight.set(idKey,controller);
    let attempted=false;
    let abortListener;
    let knownRecordRef;
    try{
      const input=write?{...args,source:{kind:'AGENT_REPORT'}}:{...args};
      const context={signal:controller.signal,request_ref:requestRef,...(write?{idempotency_key:key}:{})};
      const result=await Promise.race([
        Promise.resolve().then(()=>{
          if(controller.signal.aborted||closed)throw Object.assign(codeError('WAIT_CANCELLED'),{outcome:'NOT_SENT'});
          attempted=true;
          return service[TOOL_PORTS[name]](input,context);
        }),
        new Promise((_,reject)=>{abortListener=()=>reject(codeError(write?'UNKNOWN':controller.signal.reason==='timeout'?'LOCAL_SERVICE_TIMEOUT':'WAIT_CANCELLED'));controller.signal.addEventListener('abort',abortListener,{once:true});})
      ]);
      if(controller.signal.aborted)throw codeError(write?'UNKNOWN':'WAIT_CANCELLED');
      if(!isPlainObject(result)||!sameScope(result.scope,binding))throw codeError('SCOPE_MISMATCH');
      if(!isPlainObject(result.data))throw codeError('INVALID_SERVICE_RESPONSE');
      if(write&&typeof result.data.record_ref==='string'&&result.data.record_ref.length<=120)knownRecordRef=result.data.record_ref;
      // Clone plain JSON data so injected services cannot mutate cached receipts later.
      let envelope;
      try{envelope=JSON.parse(JSON.stringify(result));}catch{throw codeError('INVALID_SERVICE_RESPONSE');}
      envelope.scope={...binding};
      envelope.adapter={request_ref:requestRef};
      if(name==='lightog_search_knowledge')envelope=boundSearch(envelope,args);
      if(Buffer.byteLength(JSON.stringify(envelope),'utf8')>maxResultBytes)throw codeError('RESULT_TOO_LARGE');
      return toolResult(id,envelope);
    }catch(error){
      let code=errorCode(error);
      let outcome=error?.outcome;
      if(write&&attempted&&outcome!=='NOT_SENT'&&outcome!=='REJECTED'){code='UNKNOWN';outcome='UNKNOWN';}
      if(write&&!attempted)outcome='NOT_SENT';
      if(!['UNKNOWN','NOT_SENT','REJECTED','FAILED'].includes(outcome))outcome=write?'UNKNOWN':undefined;
      return failure(id,code,{request_ref:requestRef,outcome,no_auto_retry:write||error?.no_auto_retry,target_record_ref:args.record_ref,record_ref:knownRecordRef});
    }finally{
      clearTimeout(timer);
      if(abortListener)controller.signal.removeEventListener('abort',abortListener);
      if(inflight.get(idKey)===controller)inflight.delete(idKey);
    }
  }

  async function handle(message){
    const object=isPlainObject(message);
    const hasId=object&&Object.hasOwn(message,'id');
    const validId=hasId&&(typeof message.id==='string'||(typeof message.id==='number'&&Number.isFinite(message.id)));
    const id=validId?message.id:null;
    if(!object||message.jsonrpc!=='2.0'||typeof message.method!=='string'||(hasId&&!validId))return rpcError(id,-32600,'Invalid request');
    if(!hasId){
      if(message.method==='notifications/initialized'&&phase==='AWAIT_INITIALIZED')phase='READY';
      if(message.method==='notifications/cancelled'){
        const cancelled=message.params?.requestId;
        inflight.get(JSON.stringify([typeof cancelled,cancelled]))?.abort('client_cancelled');
      }
      return undefined;
    }
    if(closed)return failure(id,'SESSION_CLOSED');
    if(message.method==='ping')return {jsonrpc:'2.0',id,result:{}};
    if(message.method==='initialize'){
      const p=message.params;
      if(phase!=='NEW')return rpcError(id,-32600,'Already initialized');
      if(!isPlainObject(p)||typeof p.protocolVersion!=='string'||!isPlainObject(p.capabilities)||!isPlainObject(p.clientInfo)||typeof p.clientInfo.name!=='string'||typeof p.clientInfo.version!=='string')return rpcError(id,-32602,'Malformed initialization');
      phase='AWAIT_INITIALIZED';
      return {jsonrpc:'2.0',id,result:{protocolVersion:PROTOCOL_VERSION,capabilities:{tools:{listChanged:false}},serverInfo:{name:'lightog-memory',version:'1.0.0'},instructions:'Use the credential-bound product knowledge and sources to answer independently. Agent reports are not authenticated execution receipts. Raw saved, record publication and verified graph/index publication are distinct. Write UNKNOWN outcomes must not be automatically repeated. This adapter does not support historical at/as_of selection.'}};
    }
    if(phase!=='READY')return rpcError(id,-32002,'Initialize and send notifications/initialized first');
    if(message.method==='tools/list'){
      if(message.params!==undefined&&(!isPlainObject(message.params)||Object.keys(message.params).some(key=>!['cursor','_meta'].includes(key))||message.params.cursor!==undefined||(message.params._meta!==undefined&&!isPlainObject(message.params._meta))))return rpcError(id,-32602,'All five tools fit one page; no cursor is accepted');
      return {jsonrpc:'2.0',id,result:{tools:LIGHTOG_MEMORY_MCP_TOOLS}};
    }
    if(message.method!=='tools/call')return rpcError(id,-32601,'Method not found');
    const p=message.params;
    if(!isPlainObject(p)||typeof p.name!=='string'||(p.arguments!==undefined&&!isPlainObject(p.arguments))||(p._meta!==undefined&&!isPlainObject(p._meta)))return rpcError(id,-32602,'Malformed tools/call');
    const tool=LIGHTOG_MEMORY_MCP_TOOLS.find(tool=>tool.name===p.name);
    if(!tool)return rpcError(id,-32602,'Unknown tool');
    const args=p.arguments??{};
    try{validateMemoryToolArguments(tool.inputSchema,args);}catch{return failure(id,'INVALID_ARGUMENTS',{outcome:WRITE_TOOLS.has(p.name)?'NOT_SENT':undefined});}
    if(args.at!==undefined||args.as_of!==undefined)return failure(id,'TIME_VIEW_UNAVAILABLE');
    const requestRef=`lightog-mcp:${sessionRef}:${randomUUID()}`;
    if(!WRITE_TOOLS.has(p.name))return invoke(id,p.name,args,requestRef);
    const idKey=JSON.stringify([typeof id,id]);
    const fingerprint=createHash('sha256').update(canonicalMemoryJson({name:p.name,args})).digest('hex');
    const saved=writes.get(idKey);
    if(saved)return saved.fingerprint===fingerprint?saved.promise:failure(id,'REPLAY_CONFLICT',{request_ref:saved.request_ref,outcome:'NOT_SENT',no_auto_retry:true});
    // Do not trust model/client _meta for scope, source or idempotency identity.
    // Cache the promise before invoking the port: concurrent redelivery also sends once.
    const entry={fingerprint,request_ref:requestRef,promise:undefined};
    entry.promise=Promise.resolve().then(()=>invoke(id,p.name,args,requestRef,`lightog-mcp:${sessionRef}:${randomUUID()}`));
    writes.set(idKey,entry);
    return entry.promise;
  }
  return {binding,handle,close(){closed=true;for(const controller of inflight.values())controller.abort('session_closed');}};
}
