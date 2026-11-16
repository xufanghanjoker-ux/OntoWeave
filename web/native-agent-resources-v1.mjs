/** Host-only, invocation-bound resources. Never resolve a model-supplied path/URL. */
import {readFileSync,realpathSync} from 'node:fs';
import {dirname,join,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {clone,hash,need} from './cq-discovery-store-v2.mjs';
export const NATIVE_RESOURCE_CONTRACT='NATIVE_ROLE_RESOURCE_V1';
export const RESOURCE_FEEDBACK='native_agent_resource_feedback_v1',RESOURCE_CATALOG='native_agent_resource_catalog_v1';
export const resourceHelperName=method=>({'resources/read':'read_mcp_resource','resources/list':'list_mcp_resources','resources/templates/list':'list_mcp_resource_templates'})[method]??null;
const localCodes=new Set(['NATIVE_RESOURCE_NOT_FOUND','NATIVE_RESOURCE_OPERATION_UNSUPPORTED','NATIVE_RESOURCE_PARAMS_INVALID']);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fileURIs=path=>[...new Set([pathToFileURL(path).href,'file://'+path])];
const mime=path=>/\.md$/i.test(path)?'text/markdown':/\.json$/i.test(path)?'application/json':/\.(?:ya?ml|txt|m?js|py|toml)$/i.test(path)?'text/plain':'application/octet-stream';
const error=(code,message,status='FATAL')=>({status,error:{code:status==='LOCAL_ERROR'?(code==='NATIVE_RESOURCE_NOT_FOUND'?-32002:code==='NATIVE_RESOURCE_PARAMS_INVALID'?-32602:-32601):-32001,message}});
const serialized=value=>typeof value==='string'?value:JSON.stringify(value??null);
const feedbackRefs=value=>[...new Set([...serialized(value).matchAll(/NATIVE_RESOURCE_LOCAL_ERROR\[(resource_feedback_[a-f0-9-]{36})\]/g)].map(m=>m[1]))];
const qualified=c=>c.namespace?c.namespace+'__'+c.name:c.name;

export function createNativeAgentResources({store,run,invocationRef,role,agentScope=null,skills=[]}){
 const entries=[],aliases=new Map(),prefixes=new Set();
 for(const skill of skills)for(const file of skill.files??[]){
  need(typeof file.relative==='string'&&!isAbsolute(file.relative)&&!file.relative.split(/[\\/]/).includes('..'),'NATIVE_RESOURCE_REGISTRATION_INVALID');
  const path=join(dirname(skill.path),file.relative);need(realpathSync(path)===path,'NATIVE_RESOURCE_REGISTRATION_INVALID');
  const bytes=readFileSync(path);need(sha(bytes)===file.sha256,'NATIVE_RESOURCE_SOURCE_CHANGED');
  const entry={resource_ref:'native_resource_'+hash([skill.name,file.relative,file.sha256]),skill_name:skill.name,relative:file.relative,source_path:path,served_path:path,sha256:file.sha256,mimeType:mime(path),uri:fileURIs(path)[0]};
  entries.push(entry);for(const uri of fileURIs(path))aliases.set(uri,entry);for(const uri of fileURIs(dirname(skill.path)))prefixes.add(uri+'/');
 }
 const binding=hash({contract:NATIVE_RESOURCE_CONTRACT,run_id:run.state().run_id,invocation_ref:invocationRef,role,agent_scope:agentScope,resources:entries.map(e=>({ref:e.resource_ref,source_path:e.source_path,sha256:e.sha256}))});
 const saveCatalog=()=>{const body={contract:NATIVE_RESOURCE_CONTRACT,run_id:run.state().run_id,invocation_ref:invocationRef,role,agent_scope:agentScope,binding,resources:entries.map(e=>({...e,uris:[...aliases].filter(([,entry])=>entry===e).map(([uri])=>uri)}))};store.putRecord(RESOURCE_CATALOG,invocationRef,{...body,record_sha256:hash(body)});};
 const verify=entry=>{try{for(const path of new Set([entry.source_path,entry.served_path]))need(realpathSync(path)===path&&sha(readFileSync(path))===entry.sha256,'NATIVE_RESOURCE_SOURCE_CHANGED');}catch{need(false,'NATIVE_RESOURCE_SOURCE_CHANGED');}};
 saveCatalog();
 function registerRuntimeSkills(copied){
  for(const skill of copied){
   const selected=skills.find(s=>s.name===skill.name&&s.sha256===skill.sha256&&s.tree_sha256===skill.tree_sha256);need(selected&&typeof skill.runtime_path==='string','NATIVE_RESOURCE_REGISTRATION_INVALID');
   for(const entry of entries.filter(e=>e.skill_name===skill.name)){
    const path=join(dirname(skill.runtime_path),entry.relative);need(realpathSync(path)===path&&sha(readFileSync(path))===entry.sha256,'NATIVE_RESOURCE_SOURCE_CHANGED');entry.served_path=path;entry.uri=fileURIs(path)[0];for(const uri of fileURIs(path))aliases.set(uri,entry);
   }
   for(const uri of fileURIs(dirname(skill.runtime_path)))prefixes.add(uri+'/');
  }saveCatalog();
 }
 function perform(method,params={}){
  try{
   for(const entry of entries)verify(entry);
   if(method==='resources/list')return {status:'OK',result:{resources:entries.map(e=>({uri:e.uri,name:e.skill_name+'/'+e.relative,mimeType:e.mimeType,_meta:{sha256:e.sha256,resource_ref:e.resource_ref}}))},observation:{method,status:'OK',catalog:binding}};
   if(method==='resources/templates/list')return {status:'OK',result:{resourceTemplates:[]},observation:{method,status:'OK',catalog:binding}};
   if(method!=='resources/read')return error('NATIVE_RESOURCE_OPERATION_UNSUPPORTED','NATIVE_RESOURCE_OPERATION_UNSUPPORTED','LOCAL_ERROR');
   if(typeof params?.uri!=='string'||!params.uri||params.uri.length>8192)return error('NATIVE_RESOURCE_PARAMS_INVALID','NATIVE_RESOURCE_PARAMS_INVALID','LOCAL_ERROR');
   const entry=aliases.get(params.uri);
   if(!entry){
    let uri;try{uri=new URL(params.uri);}catch{return error('NATIVE_RESOURCE_PARAMS_INVALID','NATIVE_RESOURCE_PARAMS_INVALID','LOCAL_ERROR');}
    // A nonexistent entry under this role's registered directories is local.
    // No unknown path is ever opened, even when it is in such a directory.
    if((uri.protocol==='file:'&&![...prefixes].some(prefix=>params.uri.startsWith(prefix)))||['http:','https:'].includes(uri.protocol))return error('NATIVE_RESOURCE_URI_FORBIDDEN','NATIVE_RESOURCE_URI_FORBIDDEN');
    return error('NATIVE_RESOURCE_NOT_FOUND','NATIVE_RESOURCE_NOT_FOUND','LOCAL_ERROR');
   }
   const bytes=readFileSync(entry.served_path),content={uri:params.uri,mimeType:entry.mimeType,...(entry.mimeType==='application/octet-stream'?{blob:bytes.toString('base64')}:{text:bytes.toString('utf8')}),_meta:{sha256:entry.sha256,resource_ref:entry.resource_ref}};
   return {status:'OK',result:{contents:[content]},observation:{method,status:'OK',resource_ref:entry.resource_ref,content_sha256:entry.sha256}};
  }catch(error){return {status:'FATAL',error:{code:-32001,message:error.code??'NATIVE_RESOURCE_READ_FAILED'}};}
 }
 function issue(method,params,context,outcome,modelCalls=[]){
  const feedback_ref='resource_feedback_'+randomUUID(),body={feedback_ref,contract:NATIVE_RESOURCE_CONTRACT,binding,run_id:run.state().run_id,invocation_ref:invocationRef,role,agent_scope:agentScope,method,params:clone(params),context:clone(context),status:outcome.status,code:outcome.error?.message??null,model_calls:clone(modelCalls)};
  store.putRecord(RESOURCE_FEEDBACK,feedback_ref,{...body,record_sha256:hash(body)});
  if(outcome.error){const local=outcome.status==='LOCAL_ERROR';return {error:{...outcome.error,message:outcome.error.message+(local?' NATIVE_RESOURCE_LOCAL_ERROR['+feedback_ref+']':''),data:{code:outcome.error.message,feedback_ref,classification:outcome.status}},feedback_ref};}
  return {result:outcome.result,feedback_ref};
 }
 const receipt=ref=>{if(typeof ref!=='string')return null;const row=store.getRecord(RESOURCE_FEEDBACK,ref);if(!row)return null;const{record_sha256,...body}=row;return row.binding===binding&&row.invocation_ref===invocationRef&&record_sha256===hash(body)&&row.status==='LOCAL_ERROR'&&localCodes.has(row.code)?row:null;};
 function localOutput(body,item){
  try{const refs=feedbackRefs(item.output);if(refs.length!==1)return false;const row=receipt(refs[0]),call=body.input?.find(i=>i.type==='function_call'&&i.call_id===item.call_id);if(!row||!call)return false;
  return row.model_calls.some(c=>c.call_id===call.call_id&&c.tool_name===qualified(call)&&c.arguments_sha256===hash(JSON.parse(call.arguments)));}catch{return false;}
 }
 function localNativeFailure(notification){
  try{const item=notification?.params?.item;if(notification?.method!=='item/completed'||item?.type!=='mcpToolCall'||item.server!=='lightog_native')return false;
  const refs=feedbackRefs(item.error??item.result);if(refs.length!==1)return false;const row=receipt(refs[0]);if(!row)return false;
  const args=typeof item.arguments==='string'?JSON.parse(item.arguments):item.arguments;
  return row.model_calls.some(c=>c.call_id===item.id&&c.tool_name===item.tool&&c.arguments_sha256===hash(args));}catch{return false;}
 }
 const localNotice=notice=>{const row=receipt(notice?.feedback_ref);return !!row&&notice.reason===row.code;};
 return {binding,registerRuntimeSkills,perform,issue,localOutput,localNativeFailure,localNotice};
}
