/** Candidate backend model configuration. Credentials remain in this closure;
 * no network call occurs on configure/status. No product/global singleton. */
import {createHash,randomUUID} from 'node:crypto';
const sha=s=>createHash('sha256').update(s).digest('hex');
const error=code=>Object.assign(new Error(code),{code});
const roles=new Set(['generation','embedding','reranker']);
// Transport boundary only. Schema keyword compatibility and local semantic
// validation belong to Rust; this layer must not edit or repair the schema.
function checkedResponseFormat(value){
 const invalid=()=>{throw error('GENERATION_RESPONSE_FORMAT_INVALID');};
 const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
 let nodes=0;const active=new Set();
 function json(x,depth){
  if(++nodes>100000||depth>64)invalid();
  if(x===null||typeof x==='string'||typeof x==='boolean')return;
  if(typeof x==='number'){if(!Number.isFinite(x))invalid();return;}
  if(typeof x!=='object'||active.has(x)||!Array.isArray(x)&&!object(x))invalid();
  active.add(x);
  const keys=Reflect.ownKeys(x);
  if(keys.some(k=>typeof k!=='string')||Array.isArray(x)&&keys.some(k=>k!=='length'&&!/^(0|[1-9][0-9]*)$/.test(k)))invalid();
  for(const k of keys){if(Array.isArray(x)&&k==='length')continue;const d=Object.getOwnPropertyDescriptor(x,k);if(!d?.enumerable||!Object.hasOwn(d,'value'))invalid();json(d.value,depth+1);}
  if(Array.isArray(x)&&keys.length!==x.length+1)invalid();
  active.delete(x);
 }
 json(value,0);
 if(!object(value)||value.type!=='json_schema'||Object.keys(value).some(k=>!['type','json_schema'].includes(k)))invalid();
 const spec=value.json_schema;
 if(!object(spec)||typeof spec.name!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(spec.name)||spec.strict!==true||!object(spec.schema)||Object.keys(spec).some(k=>!['name','strict','schema','description'].includes(k))||spec.description!==undefined&&typeof spec.description!=='string')invalid();
 const serialized=JSON.stringify(value);if(Buffer.byteLength(serialized,'utf8')>1048576)throw error('GENERATION_RESPONSE_FORMAT_TOO_LARGE');
 // Snapshot before the asynchronous authorizer: caller mutation cannot change
 // the transmitted schema after its validation or hash was computed.
 return JSON.parse(serialized);
}
function exact(value,required,optional=[]){
 if(!value||typeof value!=='object'||Array.isArray(value)||required.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>!required.includes(k)&&!optional.includes(k)))throw error('MODEL_CONFIG_INVALID');
}
function validate(role,config){
 if(!roles.has(role))throw error('MODEL_ROLE_UNSUPPORTED');
 exact(config,['enabled','base_url','model'],['api_key','allow_insecure_http','timeout_ms','dimensions','model_revision','protocol','endpoint_mode']);
 if(typeof config.enabled!=='boolean'||typeof config.base_url!=='string'||typeof config.model!=='string')throw error('MODEL_CONFIG_INVALID');
 if(!config.enabled)return {role,enabled:false};
 let url;try{url=new URL(config.base_url);}catch{throw error('MODEL_ENDPOINT_INVALID');}
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw error('MODEL_ENDPOINT_INVALID');
 const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
 if(url.protocol==='http:'&&!local&&config.allow_insecure_http!==true)throw error('MODEL_INSECURE_REMOTE');
 if(!config.model.trim()||config.model.length>256||(!local&&!(typeof config.api_key==='string'&&config.api_key.trim())))throw error('MODEL_CONFIG_INVALID');
 if(config.api_key!==undefined&&typeof config.api_key!=='string')throw error('MODEL_CONFIG_INVALID');
 const timeout=config.timeout_ms??60000;
 if(!Number.isInteger(timeout)||timeout<100||timeout>300000)throw error('MODEL_CONFIG_INVALID');
 if(config.dimensions!==undefined&&(!Number.isInteger(config.dimensions)||config.dimensions<1||config.dimensions>65536))throw error('MODEL_CONFIG_INVALID');
 if(config.model_revision!==undefined&&config.model_revision!==null&&(typeof config.model_revision!=='string'||!config.model_revision))throw error('MODEL_CONFIG_INVALID');
 const protocol=config.protocol??'openai-compatible';
 if(!['openai-compatible','dashscope-native'].includes(protocol))throw error('MODEL_PROTOCOL_UNSUPPORTED');
 const endpointMode=config.endpoint_mode??(protocol==='dashscope-native'?'full':'base');
 if(!['full','base'].includes(endpointMode)||role==='generation'&&protocol!=='openai-compatible')throw error('MODEL_PROTOCOL_UNSUPPORTED');
 return {role,enabled:true,protocol,endpointMode,root:url.href.replace(/\/$/,''),model:config.model,apiKey:config.api_key||null,timeout,dimensions:config.dimensions??null,modelRevision:config.model_revision??null,allowInsecureHttp:config.allow_insecure_http===true};
}
export function createModelRegistry({fetchImpl=fetch,authorize,recordAttempt=()=>{}}={}){
 const state=new Map();
 const view=s=>!s?{configured:false,enabled:false,probed:false}:!s.enabled?{configured:false,enabled:false,probed:false}:{configured:true,enabled:true,protocol:s.protocol,endpoint_mode:s.endpointMode,base_url:s.root,model:s.model,model_revision:s.modelRevision,dimensions:s.dimensions,probed:s.probed===true,config_revision:s.revision};
 function configure(role,config){const next=validate(role,config),old=state.get(role);next.revision=(old?.revision||0)+1;next.probed=false;state.set(role,next);return {...view(next),requires_index_compatibility_check:role==='embedding'&&next.enabled};}
 function status(){return {generation:view(state.get('generation')),embedding:view(state.get('embedding')),reranker:view(state.get('reranker'))};}
 async function request(role,body,context){
  const s=state.get(role);if(!s?.enabled)throw error('MODEL_NOT_CONFIGURED');
  if(typeof authorize!=='function'||await authorize({role,context,config_revision:s.revision})!==true)throw error('MODEL_CALL_NOT_AUTHORIZED');
  const id=randomUUID(),started=Date.now(),event={event_id:id,kind:role==='embedding'?'EMBEDDING':role==='generation'?'GENERATION':'RERANK',config_revision:s.revision,stage:context?.stage??'UNSPECIFIED'};
  // Store sanitized metering metadata only. Auth credentials and endpoint never
  // enter logs, even when a server echoes them in its error body.
  const recordStart=()=>recordAttempt({...event,status:'STARTED',input_tokens:null,output_tokens:null,elapsed_ms:null,money:null});
  if(body.response_format===undefined)recordStart();
  let parsed,responseKnown=false;
  try{
   const native=s.protocol==='dashscope-native';
   const requestBody=native?(role==='embedding'?{model:s.model,input:{texts:body.input},parameters:{text_type:context?.text_type??'document',...(s.dimensions?{dimension:s.dimensions}:{})}}:{model:s.model,input:{query:body.query,documents:body.documents},parameters:{top_n:body.documents.length,return_documents:false}}):{model:s.model,...body};
   const serialized=JSON.stringify(requestBody);
   if(body.response_format!==undefined){event.hash_domain='EXACT_WIRE_UTF8_JSON';event.response_format_wire_sha256=sha(JSON.stringify(body.response_format));event.native_request_wire_sha256=sha(serialized);recordStart();}
   const suffix=role==='embedding'?'/embeddings':role==='generation'?'/chat/completions':'/rerank';
   const timeoutSignal=AbortSignal.timeout(s.timeout);
   const r=await fetchImpl(native||s.endpointMode==='full'?s.root:s.root+suffix,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...(s.apiKey?{Authorization:'Bearer '+s.apiKey}:{})},body:serialized,signal:context?.signal?AbortSignal.any([context.signal,timeoutSignal]):timeoutSignal});
   if(!r.ok)responseKnown=true;
   if(!r.ok&&body.response_format===undefined)throw error('MODEL_HTTP_'+r.status);
   if(!r.body)throw error('MODEL_BODY_MISSING');
   const reader=r.body.getReader(),parts=[];let size=0;
   for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16000000){await reader.cancel();throw error('MODEL_RESPONSE_TOO_LARGE');}parts.push(value);}
   const bytes=Buffer.concat(parts);
   responseKnown=true;
   if(body.response_format!==undefined)event.native_response_wire_sha256=sha(bytes);
   if(!r.ok)throw error('MODEL_HTTP_'+r.status);
   try{parsed=JSON.parse(bytes.toString('utf8'));}catch{throw error('MODEL_RESPONSE_INVALID');}
   if(parsed.code)throw error('MODEL_PROVIDER_ERROR');
   const usage={};for(const [k,v]of Object.entries(parsed.usage||{}))if(['prompt_tokens','total_tokens','input_tokens','completion_tokens','output_tokens'].includes(k)&&Number.isFinite(v)&&v>=0)usage[k]=v;
   // Config may change while a request is in flight: never relabel the old
   // response as vectors of the replacement model.
   if(state.get(role)!==s)throw error('MODEL_CONFIG_CHANGED_DURING_CALL');
   return {parsed,usage,event,started,state:s};
  }catch(e){recordAttempt({...event,status:'FAILED_OR_UNKNOWN',input_tokens:null,output_tokens:null,elapsed_ms:Date.now()-started,money:null});const failure=error(/^MODEL_[A-Z0-9_]+$/.test(e.code||'')?e.code:'MODEL_TRANSPORT_FAILED_OR_UNKNOWN');if(responseKnown)failure.provider_response_received=true;throw failure;}
 }
 function finish(r,valid){recordAttempt({...r.event,status:valid?'COMPLETED':'FAILED_RESPONSE',input_tokens:r.usage.prompt_tokens??r.usage.input_tokens??r.usage.total_tokens??null,output_tokens:r.usage.completion_tokens??r.usage.output_tokens??null,elapsed_ms:Date.now()-r.started,money:null});}
 async function embed(input,context){
  if(!Array.isArray(input)||!input.length||input.length>256||input.some(s=>typeof s!=='string'||!s.trim()||s.length>100000))throw error('EMBEDDING_INPUT_INVALID');
  if(state.get('embedding')?.protocol==='dashscope-native'&&input.length>20)throw error('EMBEDDING_NATIVE_BATCH_LIMIT');
  if(context?.text_type!==undefined&&!['query','document'].includes(context.text_type))throw error('EMBEDDING_TEXT_TYPE_INVALID');
  const r=await request('embedding',{input},context);
  try{
   const data=r.state.protocol==='dashscope-native'?(r.parsed.output?.embeddings||[]).map(x=>{
    if(x.index!==undefined&&x.text_index!==undefined&&x.index!==x.text_index)throw error('EMBEDDING_RESPONSE_INDEX_CONFLICT');
    return {index:x.index??x.text_index,embedding:x.embedding};
   }):r.parsed.data;
   const rows=Array.isArray(data)?[...data].sort((a,b)=>a.index-b.index):[];
   if(rows.length!==input.length||rows.some((x,i)=>x.index!==i||!Array.isArray(x.embedding)||!x.embedding.length||x.embedding.length>65536||x.embedding.some(n=>typeof n!=='number'||!Number.isFinite(n)))||rows.some(x=>x.embedding.length!==rows[0].embedding.length))throw error('EMBEDDING_RESPONSE_INVALID');
   const dimensions=rows[0].embedding.length;
   if(r.state.dimensions!==null&&r.state.dimensions!==dimensions)throw error('EMBEDDING_DIMENSION_MISMATCH');
   if(rows.some(x=>!x.embedding.some(n=>n!==0)))throw error('EMBEDDING_ZERO_VECTOR');
   finish(r,true);
   return {vectors:rows.map(x=>x.embedding),dimensions,usage:r.usage,model:r.state.model,model_revision:r.state.modelRevision,config_revision:r.state.revision,text_sha256:input.map(sha),actual_call:true};
  }catch(e){finish(r,false);throw error(e.code||'EMBEDDING_RESPONSE_INVALID');}
 }
 async function rerank(query,documents,context){
  const s=state.get('reranker');
  if(!s?.enabled)return {status:'DISABLED',actual_call:false,results:null};
  if(typeof query!=='string'||!query.trim()||!Array.isArray(documents)||!documents.length||documents.length>256||documents.some(x=>typeof x!=='string'||!x.trim()))throw error('RERANK_INPUT_INVALID');
  const r=await request('reranker',{query,documents,return_documents:false},context);
  try{
   const rows=r.state.protocol==='dashscope-native'?r.parsed.output?.results:r.parsed.results;
   if(!Array.isArray(rows)||rows.length!==documents.length||new Set(rows.map(x=>x.index)).size!==rows.length||rows.some(x=>!Number.isInteger(x.index)||x.index<0||x.index>=documents.length||typeof x.relevance_score!=='number'||!Number.isFinite(x.relevance_score)))throw error('RERANK_RESPONSE_INVALID');
   finish(r,true);return {status:'COMPLETED',actual_call:true,results:rows.map(x=>({index:x.index,score:x.relevance_score})),query_sha256:sha(query),document_sha256:documents.map(sha),config_revision:r.state.revision,usage:r.usage};
  }catch(e){finish(r,false);throw error(e.code||'RERANK_RESPONSE_INVALID');}
 }
 async function probe(role,context){
  if(!roles.has(role))throw error('MODEL_ROLE_UNSUPPORTED');
  const revision=state.get(role)?.revision;
  const result=role==='embedding'?await embed(['LightOG connection probe'],context):role==='generation'?await complete([{role:'user',content:'Reply OK.'}],context,{max_tokens:16}):await rerank('connection probe',['connection probe'],context);
  if(result.actual_call&&state.get(role)?.revision===revision)state.get(role).probed=true;
  return {...view(state.get(role)),actual_call:result.actual_call,usage:result.usage??null};
 }
 async function complete(messages,context,{max_tokens=null,enable_thinking=false,response_format}={}){
  if(!Array.isArray(messages)||!messages.length||messages.length>32||messages.some(m=>!m||!['system','user','assistant'].includes(m.role)||typeof m.content!=='string')||(max_tokens!==null&&(!Number.isSafeInteger(max_tokens)||max_tokens<1))||typeof enable_thinking!=='boolean')throw error('GENERATION_INPUT_INVALID');
  const format=response_format===undefined?undefined:checkedResponseFormat(response_format);
  const r=await request('generation',{messages,...(max_tokens===null?{}:{max_tokens}),enable_thinking,stream:false,...(format===undefined?{}:{response_format:format})},context);
  const choice=r.parsed.choices?.[0];
  if(typeof choice?.message?.content!=='string'){finish(r,false);throw Object.assign(error('GENERATION_RESPONSE_INVALID'),{provider_response_received:true});}
  finish(r,true);return {content:choice.message.content,finish_reason:choice.finish_reason??null,usage:r.usage,actual_call:true,model:r.state.model,config_revision:r.state.revision,...(format===undefined?{}:{hash_domain:r.event.hash_domain,response_format_wire_sha256:r.event.response_format_wire_sha256,native_request_wire_sha256:r.event.native_request_wire_sha256,native_response_wire_sha256:r.event.native_response_wire_sha256})};
 }
 return {configure,status,embed,rerank,complete,probe};
}
