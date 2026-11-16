/** TEST ONLY: real stdio subprocess with injected synthetic service ports. */
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';

export function memoryMcpProbeDriver(){
  const stdio=new URL('./lightog-memory-mcp-stdio-v1.mjs',import.meta.url).href;
  const session=new URL('./lightog-memory-mcp-session-v1.mjs',import.meta.url).href;
  const fixture=new URL('./lightog-memory-mcp-fixture-v1.test-helper.mjs',import.meta.url).href;
  return `import {runLightogMemoryMcpStdio} from ${JSON.stringify(stdio)};
import {createLightogMemoryMcpSession} from ${JSON.stringify(session)};
import {createMemoryMcpTestService} from ${JSON.stringify(fixture)};
const f=createMemoryMcpTestService();
const append=f.service.appendRecord, status=f.service.getStatus;
let uncertainSends=0;
f.service.appendRecord=async(input,context)=>{
  if(input.text==='synthetic uncertain write'){
    uncertainSends++; f.setInstance('process-after-restart');
    throw new Error('Synthetic transport error PRIVATE_TEST_STRING');
  }
  return append(input,context);
};
f.service.getStatus=async(input,context)=>{
  const result=await status(input,context);
  return {...result,data:{...result.data,test_only_observation:{uncertain_service_sends:uncertainSends,append_service_sends:f.calls.filter(c=>c.method==='appendRecord').length}}};
};
await runLightogMemoryMcpStdio({session:createLightogMemoryMcpSession({service:f.service,callTimeoutMs:2000})}).done;`;
}

export async function startMemoryMcpStdioProbe(){
  const child=spawn(process.execPath,['--input-type=module','-e',memoryMcpProbeDriver()],{env:{},stdio:['pipe','pipe','pipe']});
  const transcript=[],pending=new Map();
  let sequence=1,stderr='';
  child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
  const rejectAll=error=>{for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(error);}pending.clear();};
  createInterface({input:child.stdout}).on('line',line=>{
    let response;
    try{response=JSON.parse(line);}catch{rejectAll(new Error('Non-protocol output'));child.kill();return;}
    transcript.push({direction:'server',message:response});
    const key=JSON.stringify([typeof response.id,response.id]);
    const waiter=pending.get(key);
    if(waiter){pending.delete(key);clearTimeout(waiter.timer);waiter.resolve(response);}
  });
  child.on('exit',code=>rejectAll(new Error(`Probe process exited ${code}`)));
  function send(method,params,{id=sequence++,notification=false}={}){
    const message={jsonrpc:'2.0',...(notification?{}:{id}),method,...(params===undefined?{}:{params})};
    transcript.push({direction:'client',message});
    if(notification){child.stdin.write(JSON.stringify(message)+'\n');return Promise.resolve();}
    const key=JSON.stringify([typeof id,id]);
    if(pending.has(key))throw new Error('Probe already has this pending id');
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(key);child.kill();reject(new Error('Probe timed out; no retry'));},3000);
      pending.set(key,{resolve,reject,timer});child.stdin.write(JSON.stringify(message)+'\n');
    });
  }
  return {
    child,transcript,send,
    call(name,args,options){return send('tools/call',{name,arguments:args},options);},
    async initialize(){
      const init=await send('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'independent-stdio-test-client',version:'1'}});
      assert.equal(init.result.protocolVersion,'2025-11-25');
      await send('notifications/initialized',undefined,{notification:true});
    },
    async close(){
      if(child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));const timer=setTimeout(()=>child.kill(),1000);child.stdin.end();await exited;clearTimeout(timer);}
      assert.equal(stderr,'','No unexpected stderr or credential logging');
    }
  };
}

export async function runMemoryMcpStdioScenario(){
  const probe=await startMemoryMcpStdioProbe();
  const data=response=>response.result.structuredContent;
  try{
    await probe.initialize();
    const inventory=await probe.send('tools/list',{});
    assert.equal(inventory.result.tools.length,5);
    const invalid=await probe.call('lightog_append_record',{text:'bad authority',source:{kind:'TOOL_RECEIPT'}});
    assert.equal(data(invalid).data.error.code,'INVALID_ARGUMENTS');
    const search=await probe.call('lightog_search_knowledge',{query:'synthetic',limit:2,evidence_limit:1});
    assert.equal(data(search).data.knowledge.length,2);
    assert.equal(data(search).data.knowledge.flatMap(k=>k.evidence).length,1);
    assert.equal([...data(search).data.knowledge[0].evidence[0].quote].length,400);
    const text='  synthetic plan\nnot actual execution  ';
    const saved=await probe.call('lightog_append_record',{text},{id:'save-1'});
    const receipt=data(saved).data;
    assert.equal(receipt.raw_saved,true);assert.equal(receipt.processing_state,'RECEIVED');assert.equal(receipt.publication_state,'UNPUBLISHED');
    assert.deepEqual(await probe.call('lightog_append_record',{text},{id:'save-1'}),saved);
    const result=await probe.call('lightog_add_result',{record_ref:receipt.record_ref,text:'synthetic follow-up: no observed change'});
    assert.notEqual(data(result).data.record_ref,receipt.record_ref);
    const raw=await probe.call('lightog_get_record',{record_ref:receipt.record_ref});
    assert.equal(data(raw).data.record.text,text);
    assert.equal(data(raw).data.record.source.kind,'AGENT_REPORT');
    assert.equal(data(raw).data.supplements.length,1);
    const unknown=await probe.call('lightog_append_record',{text:'synthetic uncertain write'},{id:'uncertain-1'});
    assert.equal(data(unknown).data.error.code,'UNKNOWN');
    assert.equal(data(unknown).adapter.no_auto_retry,true);
    assert.deepEqual(await probe.call('lightog_append_record',{text:'synthetic uncertain write'},{id:'uncertain-1'}),unknown);
    const status=await probe.call('lightog_get_processing_status',{record_ref:receipt.record_ref});
    assert.equal(data(status).data.test_only_observation.uncertain_service_sends,1);
    assert.equal(data(status).data.test_only_observation.append_service_sends,1);
    assert.equal(data(status).data.structured_knowledge.published,false);
    assert.equal(data(status).service_instance_ref,'process-after-restart');
    const foreign=await probe.call('lightog_get_record',{record_ref:'outside-this-library'});
    assert.equal(data(foreign).data.error.code,'NOT_FOUND');
    const ping=await probe.send('ping',{});assert.deepEqual(ping.result,{});
    for(const event of probe.transcript){
      const result=event.message.result;
      if(result?.structuredContent)assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
    }
    assert.ok(!JSON.stringify(probe.transcript).includes('PRIVATE_TEST_STRING'));
    return {classification:'OFFLINE_REAL_STDIO_INJECTED_SERVICE',client:'handwritten protocol client, not actual Codex',product_http_connected:false,active_database_access:false,model_requests:0,embedding_requests:0,transcript:probe.transcript};
  }finally{await probe.close();}
}
