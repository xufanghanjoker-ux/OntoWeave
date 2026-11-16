/** Explicit candidate/product Rust transport. No build, activation or JS rule fallback. */
import {spawnSync} from 'node:child_process';
import {readFileSync,statSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const failure=code=>Object.assign(Error(code),{code});
export function createSourceCore({coreBinary,expectedSha256=null}){
 if(typeof coreBinary!=='string'||!isAbsolute(coreBinary))throw failure('SOURCE_CORE_BINARY_REQUIRED');
 const stat=statSync(coreBinary);if(!stat.isFile())throw failure('SOURCE_CORE_BINARY_INVALID');
 if(expectedSha256!==null&&createHash('sha256').update(readFileSync(coreBinary)).digest('hex')!==expectedSha256)throw failure('SOURCE_CORE_BINARY_DIGEST_MISMATCH');
 return function call(module,operation,payload){
  if(expectedSha256!==null&&createHash('sha256').update(readFileSync(coreBinary)).digest('hex')!==expectedSha256)throw failure('SOURCE_CORE_BINARY_DIGEST_MISMATCH');
  const request={wire_version:'lightog-core/0.1',request_id:randomUUID(),module,operation,payload};
  const input=JSON.stringify(request,(_k,v)=>{if(typeof v==='number'&&!Number.isFinite(v))throw failure('SOURCE_CORE_NONFINITE_NUMBER');return v;});
  const started=process.hrtime.bigint();
  const result=spawnSync(coreBinary,[],{input:input+'\n',encoding:'utf8',timeout:60000,maxBuffer:128*1024*1024});
  if(result.error||result.status!==0)throw Object.assign(failure('SOURCE_CORE_PROCESS_FAILED'),{details:{
   transport:'spawnSync',
   error_code:typeof result.error?.code==='string'&&/^[A-Z0-9_]{1,64}$/.test(result.error.code)?result.error.code:null,
   status:Number.isInteger(result.status)?result.status:null,
   signal:typeof result.signal==='string'&&/^SIG[A-Z0-9]+$/.test(result.signal)?result.signal:null,
   elapsed_ms:Number(process.hrtime.bigint()-started)/1e6,
   stderr_bytes:typeof result.stderr==='string'?Buffer.byteLength(result.stderr,'utf8'):Buffer.isBuffer(result.stderr)?result.stderr.length:0
  }});
  let response;try{response=JSON.parse(result.stdout.trim());}catch{throw failure('SOURCE_CORE_RESPONSE_INVALID');}
  if(response.request_id===null&&response.error?.code==='CORE_RESOURCE_LIMIT')throw Object.assign(failure('SOURCE_CORE_RESOURCE_LIMIT'),{details:{module,operation,request_bytes:Buffer.byteLength(input,'utf8')}});
  if(response.request_id!==request.request_id)throw failure('SOURCE_CORE_REQUEST_BINDING');
  if(response.ok!==true)throw Object.assign(Error(response.error?.message||'SOURCE_CORE_REJECTED'),{code:response.error?.code||'SOURCE_CORE_REJECTED',details:response.error?.details});
  return response.data;
 };
}
