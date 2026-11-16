/** MCP-only HTTP seam for the SAME browser memory service. No DB, job runner, or retry ledger. */
import {createHash} from 'node:crypto';

const PREFIX='/api/product/memory/v1';
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const str=(value,max=512)=>typeof value==='string'&&value.trim().length>0&&value.isWellFormed()&&[...value].length<=max;
const ref=value=>str(value)&&!/[\\/\u0000-\u001f\u007f]/u.test(value)&&!['.','..'].includes(value);
const hostKey=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/u.test(value);
const fail=(code,status=400)=>Object.assign(new Error(code),{code,status});
const need=(test,code,status=400)=>{if(!test)throw fail(code,status);};
const own=(value,key)=>Object.hasOwn(value||{},key);

export function deriveLightogMemoryMcpRequestId(key){
  need(hostKey(key),'MCP_MEMORY_IDEMPOTENCY_KEY_INVALID');
  return 'mcp_'+createHash('sha256').update('lightog-memory-mcp-request-v1\0'+key).digest('hex');
}

function route(method,path){
  if(method==='POST'&&path===PREFIX+'/search')return {call:'search',action:'search',fields:['query','limit','evidence_limit','library_id']};
  if(method==='POST'&&path===PREFIX+'/records')return {call:'saveRecord',action:'write',write:true,fields:['text','valid_time','related_record_ref','library_id']};
  const match=/^\/api\/product\/memory\/v1\/records\/([^/]+)(?:\/(results|status))?$/.exec(path);
  if(!match)return null;
  if(method==='GET'&&!match[2])return {call:'readRecord',action:'read',encodedRef:match[1]};
  if(method==='GET'&&match[2]==='status')return {call:'getStatus',action:'read',encodedRef:match[1]};
  if(method==='POST'&&match[2]==='results')return {call:'appendResult',action:'write',write:true,encodedRef:match[1],fields:['text','valid_time','library_id']};
  return null;
}

function header(req,name,{required=false}={}){
  const value=req.headers?.[name];
  if(Array.isArray(req.rawHeaders)){
    let count=0;
    for(let i=0;i<req.rawHeaders.length;i+=2)if(String(req.rawHeaders[i]).toLowerCase()===name)count++;
    need(count<=1,'MCP_MEMORY_DUPLICATE_HEADER');
  }
  if(value===undefined){need(!required,'MCP_MEMORY_HEADER_REQUIRED');return undefined;}
  need(typeof value==='string','MCP_MEMORY_HEADER_INVALID');
  return value;
}

function readBody(req,maxBytes){
  need(/^application\/json(?:\s*;|\s*$)/iu.test(header(req,'content-type')||''),'MCP_MEMORY_CONTENT_TYPE_INVALID');
  const length=header(req,'content-length');
  if(length!==undefined){need(/^\d+$/u.test(length),'MCP_MEMORY_CONTENT_LENGTH_INVALID');need(Number(length)<=maxBytes,'MCP_MEMORY_BODY_TOO_LARGE',413);}
  return new Promise((resolve,reject)=>{
    const chunks=[];let size=0,settled=false;
    const cleanup=()=>{req.removeListener('data',onData);req.removeListener('end',onEnd);req.removeListener('error',onError);req.removeListener('aborted',onAbort);};
    const stop=error=>{if(settled)return;settled=true;cleanup();req.resume?.();reject(error);};
    const onData=chunk=>{const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>maxBytes){stop(fail('MCP_MEMORY_BODY_TOO_LARGE',413));return;}chunks.push(bytes);};
    const onEnd=()=>{
      if(settled)return;settled=true;cleanup();
      try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));need(plain(value),'MCP_MEMORY_BODY_INVALID');resolve(value);}catch{reject(fail('MCP_MEMORY_BODY_INVALID'));}
    };
    const onError=()=>stop(fail('MCP_MEMORY_BODY_UNAVAILABLE'));
    const onAbort=()=>stop(fail('MCP_MEMORY_BODY_ABORTED'));
    req.on('data',onData);req.once('end',onEnd);req.once('error',onError);req.once('aborted',onAbort);
  });
}

function argumentsFor(definition,values,libraryId){
  need(plain(values),'MCP_MEMORY_BODY_INVALID');
  need(Object.keys(values).every(key=>(definition.fields||['library_id']).includes(key)),'MCP_MEMORY_FIELD_INVALID');
  if(values.library_id!==undefined)need(values.library_id===libraryId,'MCP_MEMORY_SCOPE_DENIED',403);
  const args={library_id:libraryId};
  if(definition.encodedRef!==undefined){
    let decoded;
    try{decoded=decodeURIComponent(definition.encodedRef);}catch{throw fail('MCP_MEMORY_RECORD_REF_INVALID');}
    need(ref(decoded),'MCP_MEMORY_RECORD_REF_INVALID');args.record_ref=decoded;
  }
  if(definition.call==='search'){
    need(str(values.query,2000),'MCP_MEMORY_QUERY_INVALID');
    need(values.limit===undefined||Number.isInteger(values.limit)&&values.limit>=1&&values.limit<=10,'MCP_MEMORY_LIMIT_INVALID');
    need(values.evidence_limit===undefined||Number.isInteger(values.evidence_limit)&&values.evidence_limit>=0&&values.evidence_limit<=3,'MCP_MEMORY_EVIDENCE_LIMIT_INVALID');
    args.query=values.query;args.page_size=values.limit??5;
  }
  if(definition.write){
    need(str(values.text,16000),'MCP_MEMORY_TEXT_INVALID');
    // No shared-service typed relation exists on saveRecord. Do not demote a relation to context.
    need(!own(values,'related_record_ref'),'MCP_MEMORY_RELATED_RECORD_UNSUPPORTED');
    args.text=values.text;
    if(values.valid_time!==undefined){need(timeShape(values.valid_time)&&Buffer.byteLength(JSON.stringify(values.valid_time))<=16384,'MCP_MEMORY_VALID_TIME_INVALID');args.valid_time=values.valid_time;}
  }
  return args;
}

// Field/type boundary only: actual time interpretation remains in the common core.
function timeShape(value){
  if(!plain(value)||Object.keys(value).some(key=>!['kind','occurred_at','valid_from','valid_to','time_text'].includes(key)))return false;
  if(value.kind!==undefined&&!['INSTANT','INTERVAL','UNRESOLVED','TIMELESS'].includes(value.kind))return false;
  if(value.time_text!==undefined&&!str(value.time_text,1024))return false;
  for(const field of ['occurred_at','valid_from','valid_to']){
    if(value[field]===undefined)continue;
    const endpoint=value[field];
    if(!plain(endpoint)||Object.keys(endpoint).some(key=>!['kind','value','precision','timezone','time_text'].includes(key))||!['KNOWN','UNKNOWN','OPEN_AS_REPORTED','UNKNOWN_ENDED'].includes(endpoint.kind))return false;
    for(const key of ['value','precision','timezone','time_text'])if(endpoint[key]!==undefined&&!str(endpoint[key],key==='time_text'?1024:128))return false;
  }
  return true;
}

function stripInternalReadHints(value,stats){
  if(Array.isArray(value))return value.map(part=>stripInternalReadHints(part,stats));
  if(!plain(value))return value;
  const result={};
  for(const [key,part] of Object.entries(value)){
    if(key==='read_with'){stats.read_hints_removed++;continue;}
    result[key]=stripInternalReadHints(part,stats);
  }
  return result;
}

function project(definition,result,libraryId){
  need(plain(result)&&result.library_id===libraryId,'MCP_MEMORY_SERVICE_SCOPE_INVALID',503);
  if(definition.call==='search'){
    need(result.schema_version==='MEMORY_PRODUCT_SEARCH_V1'&&Array.isArray(result.items)&&plain(result.view)&&result.view.library_id===libraryId,'MCP_MEMORY_SEARCH_RESULT_INVALID',503);
    need(result.execution?.mode==='DIRECT_KNOWLEDGE'&&result.execution.answer_model_called===false,'MCP_MEMORY_SEARCH_EXECUTION_INVALID',503);
    const {items,...rest}=result;
    const stats={read_hints_removed:0};
    const knowledge=items.map(item=>{need(plain(item),'MCP_MEMORY_SEARCH_RESULT_INVALID',503);return stripInternalReadHints(item,stats);});
    const descriptorOnly=knowledge.some(item=>(Array.isArray(item.evidence)&&item.evidence.some(e=>plain(e)&&typeof e.quote!=='string'))||item.citation?.delivery_contract==='lightog-citation-descriptor/1');
    return {...rest,knowledge,...(descriptorOnly?{gaps:[...(Array.isArray(rest.gaps)?rest.gaps:[]),{code:'MCP_EVIDENCE_QUOTES_UNAVAILABLE',detail:'The direct reader returned citation/record locators, not original quotes. Use exact source record refs with get_record where authorized; knowledge item IDs are not raw record refs.'}]}:{}),transport_projection:{items_renamed_to:'knowledge',read_hints_removed:stats.read_hints_removed,quote_materialization:'NOT_PERFORMED'}};
  }
  need(result.schema_version==='MEMORY_PRODUCT_V1','MCP_MEMORY_RECORD_RESULT_INVALID',503);
  if(definition.call==='getStatus'){
    need(ref(result.record_ref)&&result.record_ref===decodeURIComponent(definition.encodedRef),'MCP_MEMORY_RECORD_RESULT_INVALID',503);
    return result;
  }
  need(plain(result.record)&&ref(result.record.record_ref),'MCP_MEMORY_RECORD_RESULT_INVALID',503);
  if(definition.call==='readRecord')need(result.record.record_ref===decodeURIComponent(definition.encodedRef),'MCP_MEMORY_RECORD_RESULT_INVALID',503);
  if(definition.write)need(result.raw_saved===true&&result.record.source?.kind==='AGENT_REPORT','MCP_MEMORY_RECORD_RESULT_INVALID',503);
  // Aliases are copied from the actual raw record; processing/publication stay untouched.
  return {...result,record_ref:result.record.record_ref,...(result.record.logical_ref!==undefined?{logical_ref:result.record.logical_ref}:{}),...(result.record.version!==undefined?{version:result.record.version}:{}),...(result.record.source_ingested_at!==undefined?{source_ingested_at:result.record.source_ingested_at}:{})};
}

function readStatus(error){
  const code=typeof error?.code==='string'?error.code:'';
  if([400,401,403,404,409,413,503].includes(error?.status))return error.status;
  if(/(?:ACCESS_REQUIRED|ACCESS_REVOKED|UNAUTHENTICATED)/u.test(code))return 401;
  if(/(?:FORBIDDEN|DENIED|PERMISSION|CROSS_LIBRARY)/u.test(code))return 403;
  if(/(?:NOT_FOUND|UNKNOWN_RECORD)/u.test(code))return 404;
  if(/(?:CONFLICT|STALE|REPLAY|BUSY|PENDING)/u.test(code))return 409;
  if(/TOO_LARGE/u.test(code))return 413;
  if(/(?:INVALID|REQUIRED|UNSUPPORTED)/u.test(code))return 400;
  return 503;
}

function send(res,status,body,headers={}){
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});
  res.end(JSON.stringify(body));
}

/**
 * Mount BEFORE browser memory HTTP/global parseBody/Bearer rejection.
 * Same `service` object as browser. Compose service.authorize with handler.authorize.
 * Root owns active/native-library qualification; this module only authenticates tokens.
 */
export function createLightogMemoryMcpHttpHandler({service,integrationAccess,workspaceId,serviceInstanceRef,maxBodyBytes=131072,maxResponseBytes=131072}={}){
  need(service&&['saveRecord','readRecord','appendResult','getStatus','search'].every(key=>typeof service[key]==='function'),'MCP_MEMORY_SERVICE_REQUIRED');
  need(integrationAccess&&['authenticate','authorize'].every(key=>typeof integrationAccess[key]==='function'),'MCP_MEMORY_ACCESS_REQUIRED');
  need(ref(workspaceId)&&(!serviceInstanceRef||ref(serviceInstanceRef)),'MCP_MEMORY_HOST_IDENTITY_REQUIRED');
  need(Number.isSafeInteger(maxBodyBytes)&&maxBodyBytes>0&&Number.isSafeInteger(maxResponseBytes)&&maxResponseBytes>0,'MCP_MEMORY_LIMIT_INVALID');
  const issuedAuth=new WeakMap();
  function reauthorize(context,libraryId,action){
    need(libraryId===context.library_id,'MCP_MEMORY_SCOPE_DENIED',403);
    need(['read','search','write'].includes(action),'MCP_MEMORY_ACTION_DENIED',403);
    const current=integrationAccess.authorize(context.id,libraryId,{learn:action==='write'});
    need(current&&current.id===context.id&&current.library_id===libraryId&&['QUERY','LEARN'].includes(current.mode),'MCP_MEMORY_SCOPE_DENIED',403);
    return {library_id:libraryId,principal_ref:'integration:'+current.id,channel:'MCP',permissions:current.mode==='LEARN'?['read','search','write']:['read','search']};
  }
  function authorize(auth,scope){
    const context=issuedAuth.get(auth);
    if(!context)return null;
    return reauthorize(context,scope?.library_id,scope?.action);
  }
  const handle=async(req,res)=>{
    let url;
    try{url=new URL(req.url,'http://memory.local');}catch{return false;}
    const definition=route(req.method,url.pathname);
    if(!definition||!own(req.headers,'authorization'))return false;
    let dispatched=false,requestRef;
    try{
      need(!own(req.headers,'origin'),'MCP_MEMORY_ORIGIN_DENIED',403);
      const authorization=header(req,'authorization',{required:true});
      const principal=integrationAccess.authenticate(authorization);
      need(principal&&ref(principal.library_id)&&str(principal.id,256),'MCP_MEMORY_AUTH_REQUIRED',401);
      const context={id:principal.id,library_id:principal.library_id};
      reauthorize(context,context.library_id,definition.action);
      requestRef=header(req,'x-lightog-request-ref');
      if(requestRef!==undefined)need(hostKey(requestRef)&&!requestRef.includes(authorization.slice(7)),'MCP_MEMORY_REQUEST_REF_INVALID');
      const idempotencyKey=header(req,'idempotency-key');
      if(idempotencyKey!==undefined)need(hostKey(idempotencyKey)&&!idempotencyKey.includes(authorization.slice(7)),'MCP_MEMORY_IDEMPOTENCY_KEY_INVALID');
      if(definition.write)need(idempotencyKey!==undefined,'MCP_MEMORY_IDEMPOTENCY_KEY_REQUIRED');
      let values;
      if(definition.fields){
        need(url.searchParams.size===0,'MCP_MEMORY_QUERY_INVALID');
        values=await readBody(req,maxBodyBytes);
      }else{
        values={};
        for(const name of url.searchParams.keys()){
          need(name==='library_id'&&url.searchParams.getAll(name).length===1,'MCP_MEMORY_QUERY_INVALID');
          values[name]=url.searchParams.get(name);
        }
      }
      const args=argumentsFor(definition,values,context.library_id);
      if(definition.write)args.request_id=deriveLightogMemoryMcpRequestId(idempotencyKey);
      const auth=Object.freeze({});issuedAuth.set(auth,context);
      args.auth=auth;
      reauthorize(context,args.library_id,definition.action);
      dispatched=true;
      const result=await service[definition.call](args);
      reauthorize(context,args.library_id,definition.action);
      const data=project(definition,result,args.library_id);
      const envelope={scope:{workspace_id:workspaceId,library_id:args.library_id},...(serviceInstanceRef?{service_instance_ref:serviceInstanceRef}:{}),data};
      need(Buffer.byteLength(JSON.stringify(envelope))<=maxResponseBytes,'MCP_MEMORY_RESPONSE_TOO_LARGE',503);
      send(res,definition.write?202:200,envelope,requestRef?{'X-LightOG-Request-Ref':requestRef}:{});
    }catch(error){
      req.resume?.();
      if(res.headersSent){res.end();return true;}
      if(definition.write&&dispatched){
        send(res,503,{error:{code:'MCP_MEMORY_WRITE_OUTCOME_UNKNOWN'},outcome:'UNKNOWN',no_auto_retry:true,...(requestRef?{request_ref:requestRef}:{})});
      }else{
        const status=readStatus(error);
        const safeCode=status===401?'MCP_MEMORY_ACCESS_REQUIRED':status===403?'MCP_MEMORY_ACCESS_DENIED':status===404?'MCP_MEMORY_NOT_FOUND':status===409?'MCP_MEMORY_CONFLICT':status===413?'MCP_MEMORY_TOO_LARGE':status===503?'MCP_MEMORY_UNAVAILABLE':error?.code==='MCP_MEMORY_RELATED_RECORD_UNSUPPORTED'?'MCP_MEMORY_RELATED_RECORD_UNSUPPORTED':'MCP_MEMORY_REQUEST_INVALID';
        send(res,status,{error:{code:safeCode},no_auto_retry:true});
      }
    }
    return true;
  };
  handle.authorize=authorize;
  return handle;
}
