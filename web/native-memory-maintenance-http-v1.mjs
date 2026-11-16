/** OFFLINE CANDIDATE. Additional explicit maintenance routes; authentication and scope are mandatory. */
const PREFIX='/api/product/memory/v1';
const failure=(code,status=400)=>Object.assign(new Error(code),{code,status});
const need=(condition,code,status)=>{if(!condition)throw failure(code,status);};
function string(value,field,max=512){need(typeof value==='string'&&value.trim().length>0&&value.length<=max&&value.isWellFormed()&&!/[\0\u0001-\u001f\u007f]/.test(value),'MEMORY_MAINTENANCE_HTTP_'+field+'_INVALID');return value;}
function decoded(value,field){let result;try{result=decodeURIComponent(value);}catch{throw failure('MEMORY_MAINTENANCE_HTTP_'+field+'_INVALID');}
  string(result,field);need(!/[\\/]/.test(result),'MEMORY_MAINTENANCE_HTTP_'+field+'_INVALID');return result;}
function route(method,pathname){
  let match=/^\/api\/product\/memory\/v1\/records\/([^/]+)\/reorganize$/.exec(pathname);
  if(match&&method==='POST')return {method:'requestReorganization',action:'write',record_ref:decoded(match[1],'RECORD_REF'),write:true};
  match=/^\/api\/product\/memory\/v1\/maintenance-attempts\/([^/]+)$/.exec(pathname);
  if(match&&method==='GET')return {method:'getAttempt',action:'read',attempt_ref:decoded(match[1],'ATTEMPT_REF'),write:false};
  return null;
}
function body(req,limit){
  need(typeof req.headers?.['content-type']==='string'&&/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type']),'MEMORY_MAINTENANCE_HTTP_CONTENT_TYPE_INVALID');
  const length=req.headers?.['content-length'];if(length!==undefined){need(typeof length==='string'&&/^\d+$/.test(length),'MEMORY_MAINTENANCE_HTTP_CONTENT_LENGTH_INVALID');if(Number(length)>limit){req.resume();throw failure('MEMORY_MAINTENANCE_HTTP_BODY_TOO_LARGE',413);}}
  return new Promise((resolve,reject)=>{
    const chunks=[];let bytes=0;
    const cleanup=()=>{req.removeListener('data',onData);req.removeListener('end',onEnd);req.removeListener('error',onError);req.removeListener('aborted',onAbort);};
    const fail=error=>{cleanup();req.resume();reject(error);};
    const onData=chunk=>{const value=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=value.length;if(bytes>limit){fail(failure('MEMORY_MAINTENANCE_HTTP_BODY_TOO_LARGE',413));return;}chunks.push(value);};
    const onEnd=()=>{cleanup();try{resolve(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}catch{reject(failure('MEMORY_MAINTENANCE_HTTP_JSON_INVALID'));}};
    const onError=()=>fail(failure('MEMORY_MAINTENANCE_HTTP_BODY_UNAVAILABLE'));
    const onAbort=()=>fail(failure('MEMORY_MAINTENANCE_HTTP_BODY_ABORTED'));
    req.on('data',onData);req.on('end',onEnd);req.on('error',onError);req.on('aborted',onAbort);
  });
}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
function errorResponse(cause){
  const raw=typeof cause?.code==='string'?cause.code:'';
  const code=/^[A-Z][A-Z0-9_]{0,95}$/.test(raw)?raw:'MEMORY_MAINTENANCE_HTTP_UNAVAILABLE';
  let status=[400,401,403,404,409,413,503].includes(cause?.status)?cause.status:null;
  if(!status){if(/UNAUTHENTICATED|AUTH_REQUIRED|TOKEN_INVALID/.test(code))status=401;
    else if(/FORBIDDEN|PERMISSION|ACCESS_DENIED/.test(code))status=403;
    else if(/NOT_FOUND|UNKNOWN_RECORD/.test(code))status=404;
    else if(/TOO_LARGE/.test(code))status=413;
    else if(/INVALID|REQUIRED/.test(code))status=400;
    else if(/CONFLICT|STALE|PENDING|CHANGED|NO_RETRY/.test(code))status=409;
    else status=503;}
  return {status,body:{error:{code}}};
}

export function createMemoryMaintenanceHttpHandler({runtime,authenticateRequest,maxBodyBytes=262144}={}){
  need(typeof runtime?.requestReorganization==='function'&&typeof runtime?.getAttempt==='function','MEMORY_MAINTENANCE_HTTP_RUNTIME_REQUIRED');
  need(typeof authenticateRequest==='function','MEMORY_MAINTENANCE_HTTP_AUTHENTICATOR_REQUIRED');
  need(Number.isSafeInteger(maxBodyBytes)&&maxBodyBytes>0,'MEMORY_MAINTENANCE_HTTP_BODY_LIMIT_INVALID');
  return async function handle(req,res){
    let url;try{url=new URL(req.url,'http://memory.local');}catch{return false;}
    let definition;
    try{definition=route(req.method,url.pathname);if(!definition)return false;
      let args;
      if(definition.write){
        need([...url.searchParams.keys()].length===0,'MEMORY_MAINTENANCE_HTTP_QUERY_INVALID');
        const values=await body(req,maxBodyBytes);
        const fields=['library_id','request_id','reason','source_processing_ref','semantic_reuse','replacement_manifest'];
        need(values&&typeof values==='object'&&!Array.isArray(values)&&Object.keys(values).every(key=>fields.includes(key)),'MEMORY_MAINTENANCE_HTTP_FIELD_INVALID');
        args={library_id:string(values.library_id,'LIBRARY',160),record_ref:definition.record_ref,
          request_id:string(values.request_id,'REQUEST_ID',200),reason:string(values.reason,'REASON',4000),
          source_processing_ref:string(values.source_processing_ref,'SOURCE_PROCESSING_REF'),
          semantic_reuse:values.semantic_reuse,replacement_manifest:values.replacement_manifest};
        for(const key of ['semantic_reuse','replacement_manifest'])need(args[key]&&typeof args[key]==='object'&&!Array.isArray(args[key]),'MEMORY_MAINTENANCE_HTTP_MANIFEST_INVALID');
      }else{
        need([...url.searchParams.keys()].every(key=>key==='library_id')&&url.searchParams.getAll('library_id').length===1,'MEMORY_MAINTENANCE_HTTP_QUERY_INVALID');
        args={library_id:string(url.searchParams.get('library_id'),'LIBRARY',160),attempt_ref:definition.attempt_ref};
      }
      let auth;
      try{auth=await authenticateRequest(req,{library_id:args.library_id,action:definition.action});}
      catch(cause){throw failure(typeof cause?.code==='string'?cause.code:'MEMORY_MAINTENANCE_HTTP_AUTH_REQUIRED',cause?.status===403||cause?.statusCode===403?403:401);}
      need(auth!==null&&auth!==undefined&&auth!==false,'MEMORY_MAINTENANCE_HTTP_AUTH_REQUIRED',401);
      const result=await runtime[definition.method]({...args,auth});
      json(res,definition.write?202:200,result);
    }catch(cause){if(res.headersSent){res.end();return true;}const response=errorResponse(cause);json(res,response.status,response.body);}
    return true;
  };
}
