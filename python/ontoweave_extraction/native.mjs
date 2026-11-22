import {simulatedResponses} from '../ontoweave_front_half/native-sim-provider.mjs';
/** Role adapter only. Uses the existing counted transport and agent lifecycle. */
import {createRPC} from '../ontoweave_front_half/native-rpc.mjs';
import {readFileSync} from 'node:fs';
import {runNativeAgent} from '../../web/native-agent-runtime-v1.mjs';
import {createSourceModels} from '../../web/source-models-v1.mjs';
const input=JSON.parse(readFileSync(0,'utf8'));
const rpc = createRPC(input);
let rows=null,pending=[];const id=(kind,key)=>JSON.stringify([kind,key]);
const store={getRecord(kind,key){return rows?structuredClone(rows.get(id(kind,key))?.payload??null):rpc('get',{kind,key});},putRecord(kind,key,payload){if(rows){rows.set(id(kind,key),{kind,key,payload:structuredClone(payload)});pending.push({kind,key,payload:structuredClone(payload)});return payload;}return rpc('put',{kind,key,payload});},listRecords(kind){return rows?[...rows.values()].filter(r=>r.kind===kind).map(r=>structuredClone(r.payload)):rpc('list',{kind});},transaction(fn){if(rows)return fn();rows=new Map(rpc('rows').map(r=>[id(r.kind,r.key),r]));pending=[];try{const v=fn();rpc('batch',{rows:pending});return v;}finally{rows=null;pending=[];}}};
const run={state:()=>rpc('state'),assertOpen:()=>rpc('assert_open'),noteProgress:()=>rpc('progress'),stop:(reason,status='STOPPED')=>rpc('stop',{reason,status}),reserve:args=>rpc('reserve',args),settle:(ref,args)=>rpc('settle',{ref,...args})};
const tools={definitions:input.definitions,fixedMaterialReads:['extraction_read_task'],isComplete:()=>rpc('complete'),call:(name,args,context)=>rpc('tool',{name,args,context}),
 finalizeNativeTurn:context=>rpc('tool',{name:'__program_finalize_turn',args:context}),
 progressSnapshot:({name})=>({name}),
 canContinueNativeTurn:()=>true,
 outputCorrectionFeedback:()=> '请提交当前任务能依据材料交付的业务输出。'};
process.env.LIGHTOG_NATIVE_RUNTIME_LOCK_FILE=input.runtime_binding.lock_file;process.env.LIGHTOG_NATIVE_RUNTIME_LOCK_SHA256=input.runtime_binding.lock_sha256;
let upstream,runtimeFactory;
if(input.mode==='NATIVE_SIM'&&input.simulation?.[0]?.native_app_server===true){
 upstream=simulatedResponses({role:'extraction',model:input.model,turns:input.simulation,readTool:'extraction_read_task'});
}else if(input.mode==='NATIVE_SIM'){
 let index=0,current;
 const turns=input.simulation;
 const frame=e=>'data: '+JSON.stringify(e)+'\n\n';
 upstream=async()=>{
  current=turns[index]??{text:'',outcome:'RETURNED'};const outcome=current.outcome??'RETURNED';
  const messages=(current.messages??[current.text??'']).map((text,i)=>({id:'sim-message-'+index+'-'+i,type:'message',role:'assistant',phase:'final_answer',status:outcome==='KNOWN_INCOMPLETE'&&!current.certified_complete_message?'incomplete':'completed',content:[{type:'output_text',text}]}));
  const response={id:'sim-response-'+index,model:input.model,status:outcome==='RETURNED'?'completed':outcome==='KNOWN_INCOMPLETE'?'incomplete':'failed',output:messages,...(outcome==='KNOWN_INCOMPLETE'?{incomplete_details:{reason:'max_output_tokens'}}:{})};
  let body=messages.map(item=>frame({type:'response.output_item.done',item})).join('');
  if(outcome!=='UNKNOWN')body+=frame({type:outcome==='RETURNED'?'response.completed':outcome==='KNOWN_INCOMPLETE'?'response.incomplete':'response.failed',response});
  return {status:200,headers:{'content-type':'text/event-stream'},body:(async function*(){yield Buffer.from(body);})()};
 };
 runtimeFactory=async({bridge})=>{
  const handle={runtime_id:'sim-runtime',thread_id:'sim-thread-'+input.agent_scope,turn_id:'sim-turn-0'};
  const send=async()=>{
   const body={model:input.model,stream:true,tools:input.definitions.map(d=>({type:'function',name:'mcp__lightog_native__'+d.name,parameters:d.inputSchema})),input:[{role:'user',content:input.prompt}],reasoning:{effort:'low'}};
   const r=await fetch(bridge.url+'/v1/responses',{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify(body)});await r.text();
  };
  return {metadata:{kind:'SCRIPTED_OFFLINE_NATIVE_PROTOCOL',real_model_requests:0},async start(){await send();return {...handle};},async continue(){index++;handle.turn_id='sim-turn-'+index;await send();return {...handle};},async *observe(){yield {method:'turn/completed',params:{threadId:handle.thread_id,turn:{id:handle.turn_id,status:(current?.outcome??'RETURNED')==='RETURNED'?'completed':'failed'}}};},async close(){}};
 };
}else{
 const models=createSourceModels();models.configure('generation',{...input.generation,enabled:true,api_key:input.api_key});upstream=models.nativeModelRuntime().upstream;
}
try{
 const result=await runNativeAgent({store,run,tools,skillPaths:input.skill_paths,prompt:input.prompt,runtimeDirectory:input.runtime_directory,upstream,model:input.model,role:'EXTRACTION',agentScope:input.agent_scope,maxFormatRepairs:0,maxIncompleteContinuations:1,...(runtimeFactory?{runtimeFactory}:{})});
 process.stdout.write(JSON.stringify(result));
}catch(e){process.stdout.write(JSON.stringify({error:e.code??'EXTRACTION_BRIDGE_FAILED'}));process.exitCode=1;}
