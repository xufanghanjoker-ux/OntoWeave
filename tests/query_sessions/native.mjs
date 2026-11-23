/** Actual PG registration and native Codex with a local Responses fixture. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {createPgQuerySessionStore} from '../../web/native-query-session-store-v1.mjs';
import {createNativeQueryChat} from '../../web/native-query-chat-v1.mjs';
import {createNativeQueryOperation} from '../../web/native-query-operation-v1.mjs';
import {hash} from '../../web/cq-discovery-store-v2.mjs';
import {registerPgQuery} from '../../web/ontoweave-pg-query-registration-v1.mjs';
import {simulatedResponses} from '../../python/ontoweave_front_half/native-sim-provider.mjs';

const {QUERY_TEST_API:api,QUERY_TEST_TOKEN:writeToken,QUERY_TEST_LIBRARY:library,
 QUERY_TEST_RUNTIME:runtime,QUERY_TEST_OUT:storage}=process.env;
const binding=JSON.parse(readFileSync(runtime,'utf8'));
const model='qwen3.8-flash',answer='离线续聊测试完成。';
let previousQuestion, requests=0, releaseProvider;
const released=new Promise(done=>{releaseProvider=done;});
const fixture=simulatedResponses({role:'pg_session_regression',model,turns:[
 {tool_calls:[{name:'find_entities',arguments:'{"query":"离线测试"}'}]},
 {text:answer,expect_tool_output:true},
]});

async function bytes(req){const parts=[];for await(const part of req)parts.push(part);return Buffer.concat(parts);}
const listen=async server=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port;};
const stop=async server=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
const provider=createServer(async(req,res)=>{
 try{
  const body=await bytes(req);
  if(requests++===0){assert.ok(Buffer.from(body).toString().includes(previousQuestion));await released;}
  const response=await fixture({body});res.writeHead(response.status,response.headers);
  for await(const part of response.body)res.write(part);
  res.end();
 }catch(error){res.writeHead(500);res.end(error.code??'FIXTURE_FAILED');}
});
const providerUrl=await listen(provider);
const query={mode:'NATIVE_SIM',storage_directory:storage,native_runtime_binding:binding,
 generation:{model,reasoning_effort:'low',base_url:providerUrl+'/responses'}};
const json=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
function gateway(){
 const product=registerPgQuery({query,endpoint:api,writeToken,authorizeLibrary:id=>id===library,json});
 const server=createServer((req,res)=>product.handle({req,res,pathname:new URL(req.url,'http://127.0.0.1').pathname}).then(
  matched=>{if(!matched)json(res,404,{});}).catch(error=>json(res,500,{error:{code:error.code}})));
 return {server,async close(){await stop(server);await product.close();}};
}
let gatewayInstance=gateway();
assert.throws(()=>createPgQuerySessionStore({endpoint:api,writeToken}),{code:'QUERY_SESSION_GATEWAY_ACTIVE'});

function seedAbandoned(store,scope,started){
 const queryId='query_'+randomUUID(),conversationId='conversation_'+randomUUID(),turnId='turn_'+randomUUID();
 const question=started?'已发送但结算未知的合成问题':'尚无出站请求的合成问题';
 const requestId=randomUUID(),viewRevision=scope.query_read_view.view_revision;
 const input={question,context:[],source_scope:scope,pinned_view_revision:viewRevision,model_binding:null};
 const request={question,request_id:requestId,view_revision:viewRevision};
 const operation=createNativeQueryOperation({store,queryId,libraryId:library,input});
 if(started)operation.beginRequest({kind:'GENERATION',role:'QUERY'});
 const state=operation.state();
 store.transaction(()=>{
  store.putRecord('native_query_product_v1',queryId,{query_id:queryId,library_id:library,request_id:requestId,
   input,answer_mode:'markdown',conversation_id:conversationId,turn_id:turnId,turn_index:1,
   execution:state.execution,status:state.status,operation:state,created_at:state.created_at});
  store.putRecord('native_query_request_v1',hash([library,requestId]),{
   binding:hash({libraryId:library,question,context:[],view_revision:viewRevision}),query_id:queryId});
  store.putRecord('native_query_conversation_v1',conversationId,{conversation_id:conversationId,
   library_id:library,query_id:queryId,query_refs:[queryId],title:question,status:state.status,
   created_at:state.created_at,updated_at:state.created_at});
 });
 createNativeQueryChat({store,queryId,conversationId,turnId,turnIndex:1,question,sourceScope:scope});
 return {queryId,request,expected:started?'UNKNOWN_HOLD':'INTERRUPTED'};
}
try{
 const BASE='/api/product/libraries/'+library+'/native-query';
 let origin=await listen(gatewayInstance.server);
 async function get(path){const result=await fetch(origin+BASE+path);const data=await result.json();assert.equal(result.status,200,JSON.stringify(data.error));return data;}
 async function post(path,body){
  const resp=await fetch(origin+BASE+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await resp.json();assert.ok(resp.status===200||resp.status===202,JSON.stringify(data.error));return data;
 }
 const {items:conversations}=await get('/conversations');assert.equal(conversations.length,1);
 const before=await get('/conversations/'+conversations[0].conversation_id);
 assert.equal(before.turns.length,1);
 const previous=before.turns.at(-1);previousQuestion=previous.question;
 const pin=previous.source_scope.query_read_view;
 const citation=previous.answer.citations.find(row=>row.citation.source_targets?.length);
 assert.ok(citation);
 const citationPath='/queries/'+previous.query_ref+'/citations/'+citation.citation_ref;
 const saved=await get(citationPath),target=saved.citation.source_targets[0];
 const queryParams=new URLSearchParams({view_revision:pin.view_revision,index_descriptor_ref:pin.index_descriptor_ref});
 const read=await fetch(api+'/api/v1/libraries/'+library+'/retrieval/sources/'+encodeURIComponent(target.source_ref)+'?'+queryParams);
 assert.equal(read.status,200);
 const source=await read.json();
 assert.equal(source.location.document_revision,target.revision);
 assert.equal(source.location.parent_block_ref,target.block_ref);
 const selection=pin.as_of?{as_of:{timestamp:pin.as_of}}:{view_revision:pin.view_revision};
 if(pin.at)selection.at=pin.at;
 const ask={question:'离线续聊验证',request_id:randomUUID(),conversation_id:before.conversation_id,...selection};
 const started=await post('/ask',ask);
 assert.equal(started.turn_index,before.turns.length+1);
 const eventUrl=origin+BASE+'/queries/'+started.query_ref+'/events';
 const controller=new AbortController(),early=await fetch(eventUrl,{signal:controller.signal});
 const reader=early.body.getReader(),decoder=new TextDecoder();
 let seen='';
 while(!seen.includes('event: turn.created')){
  const part=await reader.read();
  assert.equal(part.done,false);
  seen+=decoder.decode(part.value,{stream:true});
 }
 controller.abort();
 await reader.cancel().catch(()=>{});
 releaseProvider();
 const resumed=await fetch(eventUrl,{headers:{'Last-Event-ID':'1'}});
 const final=await resumed.text();
 assert.match(final,/event: turn.completed/);
 assert.doesNotMatch(final,/event: turn.created/);
 const replay=await post('/ask',ask);
 assert.equal(replay.query_ref,started.query_ref);
 assert.equal(replay.idempotent,true);
 const next=await get('/queries/'+started.query_ref);
 assert.equal(next.answer.markdown,answer);
 assert.equal(next.events.at(-1).seq,next.last_event_seq);
 assert.ok(next.receipt.events.some(event=>event.item_type==='mcpToolCall'&&event.tool==='find_entities'&&event.status==='completed'));
 await gatewayInstance.close();
 const promptStore=createPgQuerySessionStore({endpoint:api,writeToken});
 let abandoned;
 try{abandoned=[seedAbandoned(promptStore,previous.source_scope,true),seedAbandoned(promptStore,previous.source_scope,false)];}
 finally{await promptStore.close();}
 gatewayInstance=gateway();
 origin=await listen(gatewayInstance.server);
 const after=await get('/conversations/'+before.conversation_id);
 assert.equal(after.turns.length,before.turns.length+1);
 assert.deepEqual(await get(citationPath),saved);
 assert.equal(after.turns.at(-1).answer.markdown,answer);
 const replayAfter=await post('/ask',ask);
 assert.equal(replayAfter.query_ref,started.query_ref);
 for(const old of abandoned){
  const outcome=await get('/queries/'+old.queryId);
  assert.equal(outcome.status,old.expected);
  assert.equal(outcome.events.at(-1).data.status,old.expected);
  const refusedReplay=await post('/ask',old.request);
  assert.equal(refusedReplay.idempotent,true);
  assert.equal(refusedReplay.query_ref,old.queryId);
 }
 assert.equal(requests,2);
 assert.deepEqual(readdirSync(storage).filter(name=>name.endsWith('.sqlite')),[]);
 await gatewayInstance.close();
 const temporary=createServer();
 const port=new URL(await listen(temporary)).port;
 await stop(temporary);
 const configFile=join(storage,'test-startup-config.json');
 writeFileSync(configFile,JSON.stringify({api_origin:api,web_port:Number(port),default_library_ref:library,unified_workbench_v2:true,
  libraries:[{library_ref:library,title:'Offline test',backend:'PG'}],query}));
 const processHandle=spawn(process.execPath,['--no-experimental-sqlite','scripts/start-ontoweave.mjs'],{stdio:['ignore','pipe','inherit'],
  env:{...process.env,ONTOWEAVE_PG_CONFIG:configFile,ONTOWEAVE_PG_WRITE_TOKEN:writeToken}});
 const exited=once(processHandle,'exit');
 try{
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('isolated PG gateway did not listen')),5000);
   processHandle.stdout.once('data',chunk=>{
    clearTimeout(timer);
    if(String(chunk).includes('OntoWeave PG'))resolve();
    else reject(Error('unexpected gateway startup output'));
   });
   exited.then(()=>{clearTimeout(timer);reject(Error('gateway exited before ready'));});
  });
  origin='http://127.0.0.1:'+port;
  const bootstrap=await fetch(origin+'/api/bootstrap');
  assert.equal(bootstrap.status,200);
  assert.equal((await bootstrap.json()).ontoweave_pg.query_enabled,true);
  const asset=await fetch(origin+'/');
  assert.equal(asset.status,200);
  assert.match(asset.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.match(await asset.text(),/unified-workbench-v2\.mjs/);
  const script=await fetch(origin+'/unified-workbench-v2.mjs');
  assert.equal(script.status,200);
  await script.arrayBuffer();
  const openapi=await fetch(origin+'/api/v1/openapi.json');
  assert.equal(openapi.status,200);
  assert.ok((await openapi.json()).openapi);
  const production=await get('/conversations/'+before.conversation_id);
  assert.equal(production.turns.at(-1).answer.markdown,answer);
  const foreignWrite=await fetch(origin+'/api/v1/libraries',{method:'POST',headers:{Origin:'http://localhost:1'}});
  assert.equal(foreignWrite.status,403);
  assert.equal((await foreignWrite.json()).error.code,'SAME_ORIGIN_REQUIRED');
  const privateEndpoint=await fetch(origin+'/_ontoweave/libraries/'+library);
  assert.equal(privateEndpoint.status,404);
 }finally{
  processHandle.kill('SIGTERM');
 }
 const [code,signal]=await exited;
 assert.equal(code,0);
 assert.equal(signal,null);
 const restarted=createPgQuerySessionStore({endpoint:api,writeToken});
 await restarted.close();
 gatewayInstance=null;
 console.log(JSON.stringify({native_mcp:true,duplicate_submission_no_replay:true,live_sse_reconnect:true,
  restart_readback:true,original_citation_readback:true,same_view_context_reused:true,abandoned_and_unknown_no_replay:true,gateway_fencing:true,production_sqlite_disabled:true,production_guard_checks:true,production_signal_released_lease:true,simulated_requests:requests}));
}finally{releaseProvider();await gatewayInstance?.close();await stop(provider);}
