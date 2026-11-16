/** Trusted, digest-pinned deterministic Rust boundary. No build or JS fallback. */
import {spawnSync} from 'node:child_process';
import {readFileSync,statSync} from 'node:fs';
import {resolve,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';

export const NATIVE_QUERY_CORE_VERSION='lightog-native-query-core/1';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const lockPath=resolve(root,'contracts/native-query-rust-v1/core-lock.json');
const verified=new Map();
let pinnedBinding=null;
const fail=code=>Object.assign(Error(code),{code});
const need=(ok,code)=>{if(!ok)throw fail(code);};

function configured(){
  const path=process.env.NATIVE_QUERY_CORE_BINARY,digest=process.env.NATIVE_QUERY_CORE_SHA256;
  if(path!==undefined||digest!==undefined){
    need(typeof path==='string'&&isAbsolute(path)&&/^[a-f0-9]{64}$/.test(digest??''),'NATIVE_QUERY_CORE_CONFIGURATION_INVALID');
    return {path,digest};
  }
  let lock;try{lock=JSON.parse(readFileSync(lockPath,'utf8'));}catch{throw fail('NATIVE_QUERY_CORE_NOT_PREPARED');}
  need(lock.contract_version===NATIVE_QUERY_CORE_VERSION&&typeof lock.binary_path==='string'&&!isAbsolute(lock.binary_path)&&/^[a-f0-9]{64}$/.test(lock.binary_sha256??''),'NATIVE_QUERY_CORE_LOCK_INVALID');
  const full=resolve(root,lock.binary_path);need(full.startsWith(root+'/target/native-query-rust-v1/'),'NATIVE_QUERY_CORE_LOCK_INVALID');
  return {path:full,digest:lock.binary_sha256};
}
function checked(){
  const binding=configured();let stat;
  need(!pinnedBinding||pinnedBinding.path===binding.path&&pinnedBinding.digest===binding.digest,'NATIVE_QUERY_CORE_RUNTIME_BINDING_CHANGED');
  try{stat=statSync(binding.path);}catch{throw fail('NATIVE_QUERY_CORE_BINARY_MISSING');}
  need(stat.isFile(),'NATIVE_QUERY_CORE_BINARY_INVALID');
  const signature=[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':'),key=binding.path+'\n'+binding.digest;
  if(verified.get(key)!==signature){need(createHash('sha256').update(readFileSync(binding.path)).digest('hex')===binding.digest,'NATIVE_QUERY_CORE_DIGEST_MISMATCH');verified.set(key,signature);}
  pinnedBinding=binding;
  return binding;
}
export function nativeQueryCoreInfo(){const binding=checked();return {contract_version:NATIVE_QUERY_CORE_VERSION,binary_sha256:binding.digest,transport:'SYNC_JSONL_EQUIVALENCE_PHASE',javascript_fallback:false};}

export function nativeQueryCore(operation,input={}){
  need(typeof operation==='string'&&operation.length>0,'NATIVE_QUERY_CORE_OPERATION_INVALID');
  const binding=checked(),request_id=randomUUID();
  // JSON.stringify drops the sign of -0. A separate path list preserves it
  // without reserving or changing any business object keys or values.
  const negative_zero_paths=[],seen=new Set();
  function scan(value,path=[]){
    if(typeof value==='number'&&Object.is(value,-0))negative_zero_paths.push(path);
    if(value&&typeof value==='object'){
      need(!seen.has(value),'NATIVE_QUERY_CORE_REQUEST_INVALID');seen.add(value);
      if(Array.isArray(value))value.forEach((item,index)=>scan(item,[...path,index]));
      else for(const [key,item]of Object.entries(value))scan(item,[...path,key]);
      seen.delete(value);
    }
  }
  scan(input);
  const request={wire_version:'lightog-core/0.1',request_id,module:'native_query_v1',operation,payload:{contract_version:NATIVE_QUERY_CORE_VERSION,input,...(negative_zero_paths.length?{negative_zero_paths}:{})}};
  let wire;try{wire=JSON.stringify(request,(_key,value)=>{if(typeof value==='number'&&!Number.isFinite(value))throw fail('NATIVE_QUERY_CORE_NONFINITE_NUMBER');return value;});}catch(error){throw error.code?error:fail('NATIVE_QUERY_CORE_REQUEST_INVALID');}
  need(Buffer.byteLength(wire)<=64*1024*1024,'NATIVE_QUERY_CORE_REQUEST_TOO_LARGE');
  const response=spawnSync(binding.path,[],{input:wire+'\n',encoding:'utf8',timeout:60000,maxBuffer:128*1024*1024});
  need(!response.error&&response.status===0,'NATIVE_QUERY_CORE_PROCESS_FAILED');
  let result;try{result=JSON.parse(response.stdout.trim());}catch{throw fail('NATIVE_QUERY_CORE_RESPONSE_INVALID');}
  if(result.request_id===null&&result.error?.code==='CORE_RESOURCE_LIMIT')throw fail('NATIVE_QUERY_CORE_REQUEST_TOO_LARGE');
  need(result.request_id===request_id,'NATIVE_QUERY_CORE_RESPONSE_BINDING_INVALID');
  if(result.ok!==true){need(typeof result.error?.code==='string','NATIVE_QUERY_CORE_RESPONSE_INVALID');throw fail(result.error.code);}
  need(result.data?.contract_version===NATIVE_QUERY_CORE_VERSION&&result.data.operation===operation&&Object.hasOwn(result.data,'result'),'NATIVE_QUERY_CORE_RESPONSE_BINDING_INVALID');
  return result.data.result;
}
