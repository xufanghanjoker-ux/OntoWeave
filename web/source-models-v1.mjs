/** Native provider I/O only; secrets live in the registry closure, never the store. */
import {createModelRegistry} from './source-model-registry-v1.mjs';
import {createHash} from 'node:crypto';
// Normalize transport exceptions only; never retain provider text or credentials.
function nativeProviderFailure(error,signal,phase,parentOwned){
 if(typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{1,95}$/.test(error.code))return error;
 const timedOut=error?.name==='TimeoutError'||signal?.aborted&&signal.reason?.name==='TimeoutError';
 const aborted=error?.name==='AbortError'||signal?.aborted;
 const code=timedOut?'NATIVE_PROVIDER_TIMEOUT':aborted?'NATIVE_PROVIDER_ABORTED':'NATIVE_PROVIDER_TRANSPORT_FAILED_OR_UNKNOWN';
 const safeCode=value=>typeof value==='number'&&Number.isFinite(value)?value:typeof value==='string'&&/^[A-Z][A-Z0-9_]{1,95}$/.test(value)?value:null;
 const safeName=value=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value)?value:'UnknownError';
 return Object.assign(Error(code),{code,native_transport_error:{phase,name:safeName(error?.name),original_code:safeCode(error?.code),cause_code:safeCode(error?.cause?.code),signal_aborted:signal?.aborted===true,deadline_owner:parentOwned?'PARENT_REQUEST':'PROFILE_FALLBACK'}});
}
export function createSourceModels({fetchImpl=fetch,store}={}){
 let registry=createModelRegistry({fetchImpl,authorize:()=>true});
 let configurations=new Map();
 const revisions=new Map();
 async function returned(role,call){const revision=revisions.get(role),result=await call();if(revision!==revisions.get(role))throw Object.assign(Error('SOURCE_MODEL_CONFIG_CHANGED_DURING_CALL'),{code:'SOURCE_MODEL_CONFIG_CHANGED_DURING_CALL',provider_response_received:true});return {...result,config_revision:revision};}
 function models(){
  const status=registry.status(),out={};
  for(const role of ['generation','embedding','reranker']){
   const state=status[role];if(!state.configured)continue;
   const binding={model:state.model,config_revision:revisions.get(role)};
   if(role==='generation')out.generation={...binding,complete:(messages,options)=>returned(role,()=>registry.complete(messages,{stage:options.phase},options))};
   else if(role==='embedding')out.embedding={...binding,model_revision:state.model_revision,dimensions:state.dimensions,embed:(texts,options)=>returned(role,()=>registry.embed(texts,{stage:options.phase??'SOURCE_EMBEDDING',text_type:options.input_type}))};
   else out.reranker={...binding,async rerank(query,documents,options){const result=await returned(role,()=>registry.rerank(query,documents,{stage:options.phase??'SOURCE_RERANK'}));return {...result,scores:result.results};}};
  }
  return out;
 }
 function status(){return Object.fromEntries(Object.entries(registry.status()).map(([role,state])=>[role,{...state,...(state.configured?{config_revision:revisions.get(role)}:{})}]));}
 function configure(role,config){
  if(role==='embedding'&&config.enabled&&(!Number.isInteger(config.dimensions)||config.dimensions<1||config.dimensions>32768))throw Object.assign(Error('SOURCE_EMBEDDING_DIMENSIONS_REQUIRED'),{code:'SOURCE_EMBEDDING_DIMENSIONS_REQUIRED'});
  return configureMany({[role]:config})[role];
 }
 function configureMany(configs){
  if(!configs||typeof configs!=='object'||Array.isArray(configs)||!Object.keys(configs).length||Object.keys(configs).some(r=>!['generation','embedding','reranker'].includes(r)))throw Object.assign(Error('SOURCE_MODEL_CONFIG_INVALID'),{code:'SOURCE_MODEL_CONFIG_INVALID'});
  const staged=createModelRegistry({fetchImpl,authorize:()=>true}),nextConfigurations=new Map(configurations),updates=new Map(),results={};
  for(const [role,config]of Object.entries(configs)){
   if(role==='embedding'&&config.enabled&&(!Number.isInteger(config.dimensions)||config.dimensions<1||config.dimensions>32768))throw Object.assign(Error('SOURCE_EMBEDDING_DIMENSIONS_REQUIRED'),{code:'SOURCE_EMBEDDING_DIMENSIONS_REQUIRED'});
   nextConfigurations.set(role,structuredClone(config));
  }
  // Validate every entry before replacing any live role or persisted revision.
  for(const [role,config]of nextConfigurations){const result=staged.configure(role,config);if(!Object.hasOwn(configs,role))continue;
  const {config_revision:_internal,probed:_probe,requires_index_compatibility_check:_check,...publicConfig}=result;
  const digest=createHash('sha256').update(JSON.stringify({publicConfig,timeout_ms:config.timeout_ms??60000,allow_insecure_http:config.allow_insecure_http===true})).digest('hex');
  const prior=store?.getRecord('source_model_config_revision',role),revision=prior?.public_config_sha256===digest?prior.revision:(prior?.revision??revisions.get(role)??0)+1;
  // Same public settings + reentered credentials restore a binding after restart.
  // Only a counter and public configuration digest persist; never the key.
  updates.set(role,{revision,public_config_sha256:digest});results[role]={...result,config_revision:revision};
  }
  const persist=()=>{for(const [role,row]of updates)store?.putRecord('source_model_config_revision',role,row);};
  if(store?.transaction)store.transaction(persist);else persist();
  for(const [role,row]of updates)revisions.set(role,row.revision);
  configurations=nextConfigurations;registry=staged;return results;
 }
 function nativeModelRuntime(){
  const state=status(),generation=configurations.get('generation'),revision=revisions.get('generation');
  const need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code,status:409});};
  need(state.generation?.configured,'NATIVE_GENERATION_NOT_CONFIGURED');
  need(generation.model==='qwen3.8-flash','NATIVE_GENERATION_MODEL_MISMATCH');
  const base=generation.base_url.replace(/\/$/,'');
  need((generation.endpoint_mode??'base')==='base'||base.endsWith('/responses'),'NATIVE_RESPONSES_ENDPOINT_REQUIRED');
  const destination=base.endsWith('/responses')?base:base+'/responses';
  const upstream=async({body,signal})=>{
   need(revision===revisions.get('generation'),'NATIVE_GENERATION_CONFIG_CHANGED');
   const request=JSON.parse(Buffer.from(body).toString('utf8'));
   need(request.model===generation.model&&request.stream===true,'NATIVE_GENERATION_WIRE_MISMATCH');
   const requestSignal=signal??AbortSignal.timeout(generation.timeout_ms??60000);
   let response;try{response=await fetchImpl(destination,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Accept:'text/event-stream',...(generation.api_key?{Authorization:'Bearer '+generation.api_key}:{})},body,signal:requestSignal});}catch(error){throw nativeProviderFailure(error,requestSignal,'REQUEST_HEADERS',!!signal);}
   need(response.body,'NATIVE_GENERATION_BODY_MISSING');
   const chunks=(async function*(){
    try{for await(const chunk of response.body){need(revision===revisions.get('generation'),'NATIVE_GENERATION_CONFIG_CHANGED');yield chunk;}}catch(error){throw nativeProviderFailure(error,requestSignal,'RESPONSE_BODY',!!signal);}
   })();
   return {status:response.status,body:chunks,redact:text=>generation.api_key?text.replaceAll(generation.api_key,'[REDACTED]'):text};
  };
  return {upstream,...nativeEmbeddingRuntime(),...nativeQueryRerankRuntime(),generation:{model:generation.model,config_revision:revision},status:state};
 }
 function nativeQueryRerankRuntime(){
  const r=status().reranker;
  if(!r?.configured)return {rerank:null,rerankBinding:null};
  const need=(ok)=>{if(!ok)throw Object.assign(Error('NATIVE_QUERY_RERANK_CONFIG_CHANGED'),{code:'NATIVE_QUERY_RERANK_CONFIG_CHANGED',billing_status:'NOT_SENT'});};
  const assertCurrent=()=>need(revisions.get('reranker')===r.config_revision);
  const rerank=async(query,documents,{signal}={})=>{
   need(revisions.get('reranker')===r.config_revision);
   let result;try{result=await returned('reranker',()=>registry.rerank(query,documents,{stage:'NATIVE_QUERY_RERANK',signal}));}catch(error){if(error.code==='RERANK_RESPONSE_INVALID')error.provider_response_received=true;throw error;}
   if(result.config_revision!==r.config_revision)throw Object.assign(Error('NATIVE_QUERY_RERANK_CONFIG_CHANGED'),{code:'NATIVE_QUERY_RERANK_CONFIG_CHANGED',provider_response_received:true});
   return {...result,model:r.model};
  };
  rerank.assertCurrent=assertCurrent;
  return {rerankBinding:{model:r.model,config_revision:r.config_revision},rerank};
 }
 function nativeEmbeddingRuntime(){
  const state=status(),need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code,status:409});};
  const e=state.embedding;
  const embed=e?.configured?async(texts,{inputType='document',signal}={})=>{
   need(revisions.get('embedding')===e.config_revision,'NATIVE_EMBEDDING_CONFIG_CHANGED');
   const result=await returned('embedding',()=>registry.embed(texts,{stage:'NATIVE_BUILD_INDEX',text_type:inputType,signal}));
   need(result.config_revision===e.config_revision,'NATIVE_EMBEDDING_CONFIG_CHANGED');
   return result;
  }:null;
  return {embed,embeddingSpace:e?.configured?{model:e.model,revision:e.model_revision??String(e.config_revision),model_revision:e.model_revision,config_revision:e.config_revision,dimensions:e.dimensions,input_strategy:'query-document-v1',distance:'cosine'}:null,status:state};
 }
 return Object.freeze({models,status,configure,configureMany,nativeModelRuntime,nativeEmbeddingRuntime});
}
