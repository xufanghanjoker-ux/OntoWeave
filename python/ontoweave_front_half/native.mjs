import {simulatedResponses} from './native-sim-provider.mjs';
/** Thin synchronous record/run RPC plus existing native runtime. No CQ business. */
import {createRPC} from './native-rpc.mjs';
import {runNativeAgent,NATIVE_LOW_SEMANTIC_INPUT_POLICY} from '../../web/native-agent-runtime-v1.mjs';
import {createSourceModels} from '../../web/source-models-v1.mjs';
import {readFileSync} from 'node:fs';
const input=JSON.parse(readFileSync(0,'utf8'));
const rpc = createRPC(input);
let transactionRows=null,pending=[];
const id=(k,key)=>JSON.stringify([k,key]);
const store={
 getRecord(kind,key){return transactionRows?structuredClone(transactionRows.get(id(kind,key))?.payload??null):rpc('get',{kind,key});},
 putRecord(kind,key,payload){if(transactionRows){transactionRows.set(id(kind,key),{kind,key,payload:structuredClone(payload)});pending.push({kind,key,payload:structuredClone(payload)});return payload;}return rpc('put',{kind,key,payload});},
 listRecords(kind){return transactionRows?[...transactionRows.values()].filter(r=>r.kind===kind).map(r=>structuredClone(r.payload)):rpc('list',{kind});},
 transaction(fn){if(transactionRows)return fn();transactionRows=new Map(rpc('rows').map(r=>[id(r.kind,r.key),r]));pending=[];try{const v=fn();rpc('batch',{rows:pending});return v;}finally{transactionRows=null;pending=[];}}
};
const run={state:()=>rpc('state'),assertOpen:()=>rpc('assert_open'),noteProgress:()=>rpc('progress'),stop:(reason,status='STOPPED')=>rpc('stop',{reason,status}),reserve:args=>rpc('reserve',args),settle:(ref,args)=>rpc('settle',{ref,...args})};
const tools={definitions:input.definitions,closedBusinessWrites:['lightog_save_cq_list'],isComplete:()=>rpc('complete'),call:(name,args,context)=>rpc('tool',{name,args,context})};
process.env.LIGHTOG_NATIVE_RUNTIME_LOCK_FILE=input.runtime_binding.lock_file;
process.env.LIGHTOG_NATIVE_RUNTIME_LOCK_SHA256=input.runtime_binding.lock_sha256;
try{
 let upstream;
 if(input.mode==='NATIVE_SIM'){
   if(input.api_key)throw Error('NATIVE_SIM_CREDENTIAL_FORBIDDEN');
   upstream=simulatedResponses({role:'cq',model:input.model,turns:input.simulation});
 }else{
   const models=createSourceModels();models.configure('generation',{...input.generation,enabled:true,api_key:input.api_key});
   upstream=models.nativeModelRuntime().upstream;
 }
 const result=await runNativeAgent({store,run,tools,skillPaths:input.skill_paths,prompt:input.prompt,runtimeDirectory:input.runtime_directory,upstream,model:input.model,role:'CQ',agentScope:input.agent_scope,maxFormatRepairs:input.max_format_repairs,maxIncompleteContinuations:input.max_incomplete_continuations,runtimeInputPolicy:NATIVE_LOW_SEMANTIC_INPUT_POLICY});
 process.stdout.write(JSON.stringify(result));
}catch(e){process.stdout.write(JSON.stringify({error:e.code??'NATIVE_BRIDGE_FAILED'}));process.exitCode=1;}
