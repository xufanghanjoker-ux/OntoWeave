/** Native query role: independent execution observation, provider-neutral Responses.
 * Uses the existing locked app-server launcher and tools-only MCP executable.
 * No business model decision loop, build quota or production database is created.
 */
import {createServer} from 'node:http';
import {readFileSync,readdirSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,dirname,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {clone,hash,id,need} from './cq-discovery-store-v2.mjs';
import {createNativeCodexAppServer,nativeToolOutputFailure,nativeTurnCompletedNormally} from './native-agent-runtime-v1.mjs';
import {createQueryPublicStream} from './native-query-public-stream-v1.mjs';
import {createQueryRounds} from './native-query-rounds-v3.mjs';
import {createCQSSEBoundary} from './cq-sse-boundary-v1.mjs';
import {createNativeQueryModelBinding,validateNativeQueryRequest,validateNativeQuerySSE,normalizeNativeQueryToolNames} from './native-query-model-v1.mjs';
import {deriveNativeToolArguments,businessArgumentPolicy,ARGUMENT_NORMALIZATION} from './native-tool-arguments-v1.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const NATIVE_QUERY_SKILL=join(root,'docs/skill-drafts/lightog-retrieval-answer/SKILL.md');
const INVOCATION='native_query_invocation_v1',WIRE='native_query_wire_v1',RESPONSE='native_query_response_v1';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const QUERY_FINAL_ANSWER_GUIDANCE='现在进入回答阶段，回到用户原始问题。依据实际取得的证据回答可支持的部分；已有完整支持时直接回答，必要范围尚未确认时自然说明，不补造遗漏。不要叙述接下来要执行工具，不输出内部轮次、预算或系统字段，也不要把未发生的动作写成已完成。';
function interrupted(signal){
  let listener;
  const promise=new Promise((_resolve,reject)=>{listener=()=>reject(Object.assign(Error('NATIVE_QUERY_REQUEST_INTERRUPTED'),{code:'NATIVE_QUERY_REQUEST_INTERRUPTED'}));signal.addEventListener('abort',listener,{once:true});if(signal.aborted)listener();});
  return {promise,close:()=>signal.removeEventListener('abort',listener)};
}
function skillsOf(paths=[NATIVE_QUERY_SKILL]) {
  need(Array.isArray(paths)&&paths.length===1&&resolve(paths[0])===NATIVE_QUERY_SKILL,'NATIVE_QUERY_SKILL_FORBIDDEN');
  const path=realpathSync(paths[0]);need(path===NATIVE_QUERY_SKILL,'NATIVE_QUERY_SKILL_SYMLINK_FORBIDDEN');
  const files=[];
  function walk(directory){for(const item of readdirSync(directory,{withFileTypes:true})){
    const full=join(directory,item.name);need(!lstatSync(full).isSymbolicLink(),'NATIVE_QUERY_SKILL_SYMLINK_FORBIDDEN');
    if(item.isDirectory())walk(full);else if(item.isFile())files.push({relative:relative(dirname(path),full),sha256:sha(readFileSync(full))});
  }}
  walk(dirname(path));files.sort((a,b)=>a.relative.localeCompare(b.relative));
  return [{name:'lightog-retrieval-answer',path,sha256:sha(readFileSync(path)),tree_sha256:hash(files),files}];
}

export function createNativeQueryTransport({store,operation,modelBinding,upstream,isComplete=()=>false,onFailure=()=>{},invocationRef=operation.state().query_id,requiredToolNames=[],onPublicEvent=null,onPublicMessages=()=>{},rounds=null}) {
  need(typeof upstream==='function','NATIVE_QUERY_UPSTREAM_REQUIRED');let sending=false;
  async function send(bytes,signal) {
    operation.assertActive();need(!isComplete(),'NATIVE_QUERY_ROLE_COMPLETE');need(!sending,'NATIVE_QUERY_CONCURRENT_GENERATION_FORBIDDEN');
    need(!signal?.aborted&&!operation.signal.aborted,'NATIVE_QUERY_CANCELLED_BEFORE_SEND');
    const originalWire=Buffer.from(bytes),execution=operation.state().execution;let wire=originalWire;
    need(wire.length<=execution.max_request_bytes,'NATIVE_QUERY_REQUEST_TOO_LARGE');
    let body;try{body=JSON.parse(wire.toString('utf8'));}catch{need(false,'NATIVE_QUERY_REQUEST_JSON_INVALID');}
    const names=validateNativeQueryRequest(body,modelBinding),toolFailure=nativeToolOutputFailure(body);
    const missing=requiredToolNames.map(n=>'mcp__lightog_native__'+n).filter(n=>!names.includes(n));
    if(missing.length){
      store.putRecord('native_query_tool_readiness_v1',invocationRef,{query_id:operation.state().query_id,phase:'BEFORE_PROVIDER_SEND',status:'REJECTED',reason:'NATIVE_QUERY_BUSINESS_TOOLS_NOT_ADVERTISED',advertised_tool_names:names,missing_tool_names:missing,provider_request_sent:false});
      operation.stop('NATIVE_QUERY_BUSINESS_TOOLS_NOT_ADVERTISED');need(false,'NATIVE_QUERY_BUSINESS_TOOLS_NOT_ADVERTISED');
    }
    if(toolFailure){operation.stop('NATIVE_QUERY_LOCAL_TOOL_EXECUTION_FAILED');need(false,'NATIVE_QUERY_LOCAL_TOOL_EXECUTION_FAILED');}
    const finalPhase=rounds?.isAnswerPhase()??false;
    if(finalPhase){wire=Buffer.from(JSON.stringify({...body,tool_choice:'none',instructions:[body.instructions,QUERY_FINAL_ANSWER_GUIDANCE].filter(Boolean).join('\n\n')}));need(wire.length<=execution.max_request_bytes,'NATIVE_QUERY_REQUEST_TOO_LARGE');rounds.markFinalRequest();}
    const request=operation.beginRequest({kind:'GENERATION',role:'QUERY',requestMetadata:{body_sha256:sha(wire),original_body_sha256:sha(originalWire),request_rewritten:!wire.equals(originalWire),request_bytes:wire.length,model_binding_ref:modelBinding.binding_ref,tool_names:names,final_answer_phase:finalPhase}});
    const publicStream=onPublicEvent?createQueryPublicStream({requestRef:request.request_ref,onEvent:onPublicEvent}):null;
    const boundary=createCQSSEBoundary({max_response_bytes:execution.max_response_bytes,max_sse_frame_bytes:execution.max_sse_frame_bytes,max_sse_events:execution.max_sse_events,max_semantic_bytes:execution.max_semantic_bytes});
    const abort=new AbortController(),combined=AbortSignal.any([abort.signal,request.signal,...(signal?[signal]:[])]),timer=setTimeout(()=>abort.abort('NATIVE_QUERY_REQUEST_TIMEOUT'),request.remaining_ms);
    let settled=false,response,total=0,completeBody=false,nameNormalization=null,derivedResponseBody=null;const chunks=[],interruption=interrupted(combined);sending=true;
    const settle=(outcome,data)=>{if(settled)return;settled=true;operation[outcome](request.request_ref,data);};
    store.putRecord(WIRE,request.request_ref,{query_id:operation.state().query_id,request_ref:request.request_ref,model_binding_ref:modelBinding.binding_ref,body_sha256:sha(wire),request_bytes:wire.length,advertised_tool_names:names,request_rewritten:!wire.equals(originalWire),original_body_sha256:sha(originalWire),derived_body_sha256:sha(wire),...(finalPhase?{derivation_reason:'FINAL_ANSWER_TOOL_CHOICE_NONE_AND_GUIDANCE',tool_choice:'none',final_guidance_version:'query-final-answer/1'}:{})});
    try{
      response=await Promise.race([upstream({body:wire,signal:combined,request_id:request.request_ref}),interruption.promise]);
      need(response&&Number.isInteger(response.status)&&response.body?.[Symbol.asyncIterator],'NATIVE_QUERY_UPSTREAM_RESPONSE_INVALID');
      if(response.status<200||response.status>=300){settle('recordFailed',{reason:'NATIVE_QUERY_UPSTREAM_HTTP_'+response.status});need(false,'NATIVE_QUERY_UPSTREAM_HTTP_'+response.status);}
      const iterator=response.body[Symbol.asyncIterator]();
      for(;;){
        const next=await Promise.race([iterator.next(),interruption.promise]);if(next.done)break;
        need(!combined.aborted,'NATIVE_QUERY_RESPONSE_INTERRUPTED');const b=Buffer.from(next.value);total+=b.length;
        need(total<=execution.max_response_bytes,'NATIVE_QUERY_RESPONSE_TOO_LARGE');boundary.push(b);chunks.push(b);if(publicStream)await publicStream.push(b);
      }
      completeBody=true;const data=Buffer.concat(chunks);
      nameNormalization=normalizeNativeQueryToolNames(data,{tools:body.tools});
      let checked,delivered=nameNormalization.body,audits=[];derivedResponseBody=delivered;
      try{
        try{checked=validateNativeQuerySSE(delivered,{model:modelBinding.model,allowedNames:names});}
        catch(error){
          if(!error.provider_completed||error.code!=='NATIVE_QUERY_TOOL_ARGUMENTS_JSON_INVALID')throw error;
          boundary.finish();
          settle('recordReturned',{usage:error.reported_usage??null});
          const policy=businessArgumentPolicy(names.map(n=>n.split('__').at(-1))),derived=deriveNativeToolArguments({bytes:delivered,policy,allowedNames:names,runId:operation.state().query_id,invocationRef,requestRef:request.request_ref});
          delivered=derived.body;derivedResponseBody=delivered;audits=derived.audits;need(delivered.length<=execution.max_response_bytes,'NATIVE_QUERY_DERIVED_RESPONSE_TOO_LARGE');checked=validateNativeQuerySSE(delivered,{model:modelBinding.model,allowedNames:names});
        }
        boundary.finish();
      }
      catch(error){if(error.provider_completed)settle('recordReturned',{usage:error.reported_usage??null});else if(error.provider_failed)settle('recordFailed',{usage:error.reported_usage??null,reason:error.code});throw error;}
      settle('recordReturned',{usage:checked.usage});
      need(delivered.length<=execution.max_response_bytes,'NATIVE_QUERY_DERIVED_RESPONSE_TOO_LARGE');
      if(audits.length)store.transaction(()=>{for(const audit of audits)store.putRecord(ARGUMENT_NORMALIZATION,audit.normalization_ref,audit);const redact=response.redact??(v=>v);store.putRecord('native_query_response_derivation_v1',request.request_ref,{query_id:operation.state().query_id,request_ref:request.request_ref,raw_response_sha256:sha(data),derived_response_sha256:sha(delivered),raw_body_utf8:redact(data.toString('utf8')),derived_body_utf8:redact(delivered.toString('utf8')),normalization_refs:audits.map(a=>a.normalization_ref),response_byte_preserving:false});});
      if(nameNormalization.normalizations.length){
        const prior=audits.length?store.getRecord('native_query_response_derivation_v1',request.request_ref):{query_id:operation.state().query_id,request_ref:request.request_ref,raw_response_sha256:sha(data),derived_response_sha256:sha(delivered),normalization_refs:[],response_byte_preserving:false};
        store.putRecord('native_query_response_derivation_v1',request.request_ref,{...prior,tool_name_normalization:{version:nameNormalization.version,inventory_sha256:nameNormalization.inventory_sha256,declared_names_sha256:nameNormalization.declared_names_sha256,events:clone(nameNormalization.normalizations)}});
      }
      store.putRecord(RESPONSE,request.request_ref,{query_id:operation.state().query_id,request_ref:request.request_ref,status:response.status,response_sha256:sha(data),derived_response_sha256:sha(delivered),derived_response_bytes:delivered.length,response_byte_preserving:delivered.equals(data),tool_name_normalization:clone(nameNormalization.normalizations),normalization_refs:audits.map(a=>a.normalization_ref),response_bytes:total,complete_body:true,protocol_valid:true,usage:checked.usage,model:checked.reported_model,tool_calls:checked.calls.map((c,index)=>({call_id:c.call_id,batch_ordinal:index+1,name:c.name,arguments_sha256:hash(c.arguments),normalized_arguments_sha256:hash(JSON.parse(c.arguments))})),sse_metrics:boundary.metrics()});
      if(finalPhase&&checked.calls.length){
        const error=Object.assign(Error('NATIVE_QUERY_FINAL_TOOL_CHOICE_VIOLATION'),{code:'NATIVE_QUERY_FINAL_TOOL_CHOICE_VIOLATION',provider_completed:true,validated_calls:checked.calls.map((c,i)=>({call_id:c.call_id,batch_ordinal:i+1,name:c.name,normalized_arguments_sha256:hash(JSON.parse(c.arguments))}))});throw error;
      }
      rounds?.register({request_ref:request.request_ref,calls:checked.calls});
      if(publicStream)onPublicMessages(publicStream.messages());
      return {status:response.status,content_type:'text/event-stream',body:delivered};
    }catch(error){
      abort.abort(error.code??'NATIVE_QUERY_RESPONSE_UNKNOWN');
      if(!settled)settle(error.billing_status==='NOT_SENT'?'recordFailed':'recordUnknown',{reason:error.code??'NATIVE_QUERY_SENT_RESULT_UNKNOWN'});
      else if(operation.state().status==='RUNNING')operation.stop(error.code??'NATIVE_QUERY_RESPONSE_INVALID');
      store.putRecord(RESPONSE,request.request_ref,{query_id:operation.state().query_id,request_ref:request.request_ref,status:response?.status??null,response_sha256:sha(Buffer.concat(chunks)),response_bytes:total,complete_body:completeBody,protocol_valid:false,reason:error.code??'NATIVE_QUERY_SENT_RESULT_UNKNOWN',...(nameNormalization?{tool_name_normalization:clone(nameNormalization.normalizations),tool_name_resolution_diagnostics:clone(nameNormalization.diagnostics),derived_response_sha256:sha(derivedResponseBody??nameNormalization.body)}:{}),sse_metrics:boundary.metrics(),...(error.tool_identity_diagnostics?{tool_identity_diagnostics:clone(error.tool_identity_diagnostics)}:{}),...(error.validated_calls?{tool_choice_compatible:false,tool_calls:clone(error.validated_calls)}:{})});
      onFailure(error.code??'NATIVE_QUERY_SENT_RESULT_UNKNOWN');throw error;
    }finally{sending=false;clearTimeout(timer);interruption.close();}
  }
  return Object.freeze({send});
}

async function bodyOf(req,max){let size=0;const chunks=[];for await(const bytes of req){size+=bytes.length;need(size<=max,'NATIVE_QUERY_HTTP_TOO_LARGE');chunks.push(bytes);}return Buffer.concat(chunks);}
export async function createNativeQueryBridge({operation,tools,transport,onComplete,onFailure}) {
  const token=randomUUID(),pending=new Set(),mcpCalls=new Map();
  async function handle(req,res){
    try{
      need(req.method==='POST'&&req.headers.authorization==='Bearer '+token,'NATIVE_QUERY_LOCAL_AUTH_REQUIRED');
      const bytes=await bodyOf(req,operation.state().execution.max_request_bytes),args=JSON.parse(bytes.toString('utf8'));
      if(req.url==='/broker/definitions'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({definitions:tools.definitions}));return;}
      if(req.url==='/broker/failure'){onFailure('NATIVE_QUERY_MCP_FAILURE');res.writeHead(200,{'Content-Type':'application/json'});res.end('{"stopped":true}');return;}
      if(req.url==='/broker'){
        operation.assertActive();need(!tools.isComplete(),'NATIVE_QUERY_ROLE_COMPLETE');need(tools.definitions.some(t=>t.name===args.name),'NATIVE_QUERY_TOOL_FORBIDDEN');
        const abort=interrupted(operation.signal);let value;
        try{
          const context=args.call_context;
          if(tools.requiresCallContext)need(context&&typeof context==='object'&&Object.keys(context).every(k=>['mcp_session_ref','mcp_request_id'].includes(k))&&typeof context.mcp_session_ref==='string'&&context.mcp_session_ref.length>0&&(typeof context.mcp_request_id==='string'&&context.mcp_request_id.length>0||Number.isSafeInteger(context.mcp_request_id)),'NATIVE_QUERY_MCP_CALL_CONTEXT_INVALID');
          const key=context?hash(context):null,signature=hash({name:args.name,args:args.args??{}}),prior=key&&mcpCalls.get(key);
          if(prior){need(prior.signature===signature,'NATIVE_QUERY_MCP_CALL_CHANGED');value=await prior.promise;}
          else{const promise=Promise.race([tools.call(args.name,args.args??{},context),abort.promise]);if(key)mcpCalls.set(key,{signature,promise});value=await promise;}
        }finally{abort.close();}
        if(value?.ok===false)onFailure(value.error?.code??'NATIVE_QUERY_TOOL_FAILED');
        res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));
        if(value?.ok!==false&&tools.isComplete())setImmediate(onComplete);return;
      }
      need(req.url==='/v1/responses','NATIVE_QUERY_ROUTE_FORBIDDEN');
      const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort();});
      const value=await transport.send(bytes,abort.signal);res.writeHead(value.status,{'Content-Type':value.content_type});res.end(value.body);
    }catch(error){
      if(req.headers.authorization==='Bearer '+token&&error.code!=='NATIVE_QUERY_ROLE_COMPLETE')onFailure(error.code??'NATIVE_QUERY_BRIDGE_FAILED');
      if(!res.headersSent)res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{type:'native_query',message:error.code??'NATIVE_QUERY_BRIDGE_FAILED'}}));
    }
  }
  const server=createServer((req,res)=>{const promise=handle(req,res);pending.add(promise);promise.finally(()=>pending.delete(promise));});
  server.on('connect',(_req,socket)=>socket.destroy());await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
  return {url:'http://127.0.0.1:'+server.address().port,token,async close(){server.closeAllConnections();await new Promise(done=>server.close(done));await Promise.allSettled([...pending]);}};
}

export async function runNativeQueryAgent({store,operation,tools,skillPaths,prompt,runtimeDirectory,modelBinding,upstream,nativeRuntimeBinding=null,runtimeFactory=createNativeCodexAppServer,answerMode='legacy',onPublicEvent=null}) {
  need(store&&operation&&Array.isArray(tools?.definitions)&&typeof tools.call==='function'&&typeof tools.isComplete==='function'&&typeof prompt==='string','NATIVE_QUERY_RUNTIME_INPUT_INVALID');
  modelBinding=modelBinding?.binding_ref?modelBinding:createNativeQueryModelBinding(modelBinding);
  need(tools.definitions.length&&tools.definitions.every(t=>t.inputSchema?.type==='object'&&t.annotations?.destructiveHint===false&&t.annotations?.openWorldHint===false),'NATIVE_QUERY_TOOLS_INVALID');
  const skills=skillsOf(skillPaths),queryId=operation.state().query_id,invocationRef=id('native_query_invocation'),events=[];
  let receipt={invocation_ref:invocationRef,query_id:queryId,role:'QUERY',status:'PREPARED',model_binding:clone(modelBinding),input_hash:hash({prompt,definitions:tools.definitions,skills:skills.map(s=>({name:s.name,sha256:s.sha256,tree_sha256:s.tree_sha256}))}),execution_label:runtimeFactory===createNativeCodexAppServer?'NATIVE_CODEX_SCRIPTABLE_TRANSPORT':'INJECTED_RUNTIME',started_at:Date.now()};
  const save=()=>store.putRecord(INVOCATION,invocationRef,clone(receipt));save();
  const rounds=answerMode==='markdown'?createQueryRounds({onChange:state=>{receipt.retrieval_control=state;save();}}):null;
  if(rounds){const original=tools;tools={...original,requiresCallContext:true,async call(name,args,context){
    const admission=rounds.claim(name,args,context);let result;
    if(!admission.allowed)result=admission.response;
    else result=await original.call(name,args,{...context,query_runtime_control:true,retrieval_phase:admission.phase,provider_request_ref:admission.request_ref});
    if(['NO_NEW_INFORMATION','STOPPED_NO_PROGRESS'].includes(result?.result?.status)||result?.result?.repeated_no_progress)rounds.stopForNoProgress();
    original.recordModelProjection?.(name,result);return result;
  }};}
  let resolveTerminal,runtime,bridge,watcher,deadline,outputSaved=false,nativeCompleted=false,nativeMessage=null,lastPublicMessages=[];
  const terminal=new Promise(done=>{resolveTerminal=done;});
  function fail(reason){if(['RUNNING','ANSWER_STAGED'].includes(operation.state().status))operation.stop(reason);resolveTerminal();}
  const complete=()=>{outputSaved=true;resolveTerminal();};
  try{
    operation.assertActive();need(operation.state().status==='RUNNING','NATIVE_QUERY_ALREADY_STAGED');
    const requiredToolNames=tools.definitions.map(t=>t.name);
    const transport=createNativeQueryTransport({store,operation,modelBinding,upstream,isComplete:tools.isComplete,onFailure:fail,invocationRef,requiredToolNames,
      rounds,onPublicEvent:answerMode==='markdown'?onPublicEvent:null,onPublicMessages:messages=>{lastPublicMessages=messages;}});
    bridge=await createNativeQueryBridge({operation,tools,transport,onComplete:complete,onFailure:fail});
    const state=operation.state(),remaining=Math.max(1,state.execution.timeout_ms-(Date.now()-state.created_at));
    deadline=setTimeout(()=>{operation.stop('NATIVE_QUERY_TIMEOUT','INTERRUPTED');resolveTerminal();},remaining);
    runtime=await runtimeFactory({...(nativeRuntimeBinding!==null?{runtimeBinding:nativeRuntimeBinding}:{}),runtimeDirectory,bridge,skills,model:modelBinding.model,timeoutMs:remaining+2000,onFailure:fail,
      queryReadiness:{requiredToolNames,signal:operation.signal,answerFormat:answerMode,onStatus:status=>{
        receipt.tool_readiness={...status,status:status.runtime_status==='connected'&&!status.missing_tool_names.length?'READY':'WAITING'};
        store.putRecord('native_query_tool_readiness_v1',invocationRef,{query_id:queryId,phase:'THREAD_MCP_INVENTORY',...receipt.tool_readiness,provider_request_sent:false});save();
      }}});
    receipt.runtime=clone(runtime.metadata??{kind:'INJECTED_RUNTIME'});receipt.status='STARTED';save();
    const handle=await runtime.start({prompt:'$lightog-retrieval-answer\n'+prompt});Object.assign(receipt,handle);save();
    watcher=(async()=>{
      try{for await(const notification of runtime.observe(handle)){
        const item=notification.params?.item;
        const event={method:notification.method,item_type:item?.type??null,status:item?.status??notification.params?.turn?.status??null};
        if(item?.tool)event.tool=item.tool;events.push(event);
        if(answerMode==='markdown'&&notification.method==='item/completed'&&item?.type==='agentMessage'&&typeof item.text==='string'&&item.text.trim()&&notification.params?.threadId===handle.thread_id&&notification.params?.turnId===handle.turn_id)nativeMessage=item;
        if(notification.method==='turn/completed'){
          nativeCompleted=nativeTurnCompletedNormally(notification,handle.turn_id,handle.thread_id);
          if(answerMode==='markdown'&&nativeCompleted){
            const candidate=lastPublicMessages.findLast(m=>m.item_id===nativeMessage?.id)??lastPublicMessages.findLast(m=>m.phase==='final_answer')??lastPublicMessages.at(-1);
            const text=candidate&&(nativeMessage?.id===candidate.item_id||nativeMessage?.phase==='final_answer')?nativeMessage.text:candidate?.markdown;
            need(candidate&&typeof text==='string'&&text.trim(),'NATIVE_QUERY_PUBLIC_ANSWER_MISSING');
            need(operation.state().attempts.every(a=>a.outcome==='RETURNED'),'NATIVE_QUERY_REQUESTS_UNSETTLED');
            await tools.finishMarkdown({markdown:text,message_id:candidate.message_id});
          }
          if(!tools.isComplete())fail('NATIVE_QUERY_ANSWER_NOT_SAVED');else complete();
        }
      }}catch(error){if(!tools.isComplete())fail(error.code??'NATIVE_QUERY_RUNTIME_FAILED');}
      if(!tools.isComplete()&&!['FAILED','UNKNOWN_HOLD','CANCELLED','INTERRUPTED'].includes(operation.state().status))fail('NATIVE_QUERY_ROLE_INCOMPLETE');
    })();
    await Promise.race([terminal,watcher]);
  }catch(error){
    if(error.code?.startsWith('NATIVE_QUERY_MCP_')){
      receipt.tool_readiness={...(receipt.tool_readiness??{}),status:'FAILED',reason:error.code};
      store.putRecord('native_query_tool_readiness_v1',invocationRef,{query_id:queryId,phase:'THREAD_MCP_INVENTORY',...receipt.tool_readiness,provider_request_sent:operation.state().attempts.some(a=>a.kind==='GENERATION')});
    }
    fail(error.code??'NATIVE_QUERY_RUNTIME_FAILED');
  }
  finally{
    clearTimeout(deadline);
    for(const resource of [runtime,bridge])try{await resource?.close();}catch(error){if(!tools.isComplete())fail(error.code??'NATIVE_QUERY_CLOSE_FAILED');}
    await watcher;
    const state=operation.state(),unknown=state.attempts.some(a=>a.outcome==='UNKNOWN'||a.outcome==='STARTED');
    receipt.ended_at=Date.now();receipt.request_refs=state.attempts.filter(a=>a.kind==='GENERATION').map(a=>a.request_ref);
    if(unknown){receipt.status='UNKNOWN';receipt.reason=state.reason??'NATIVE_QUERY_RESULT_UNKNOWN';}
    else if((outputSaved||nativeCompleted)&&tools.isComplete()&&state.status==='ANSWER_STAGED'){
      receipt.status='SUCCEEDED';receipt.completion_source=nativeCompleted?'NATIVE_TURN_COMPLETED':'HOST_ACCEPTED_ROLE_OUTPUT';receipt.provider_outcome_known=true;
    }else{receipt.status=['INTERRUPTED','CANCELLED','STALE'].includes(state.status)?state.status:'FAILED';receipt.reason=state.reason??'NATIVE_QUERY_ROLE_INCOMPLETE';}
    receipt.events=events;save();
  }
  return {receipt:clone(receipt),events:clone(events),complete:receipt.status==='SUCCEEDED'};
}
