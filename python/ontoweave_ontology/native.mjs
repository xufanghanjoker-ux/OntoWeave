import {simulatedResponses} from '../ontoweave_front_half/native-sim-provider.mjs';
/** Ontology role adapter using the shared native Codex transport. */
import {createRPC, createRPCStore} from '../ontoweave_front_half/native-rpc.mjs';
import {readFileSync} from 'node:fs';
import {runNativeAgent} from '../../web/native-agent-runtime-v1.mjs';
import {createSourceModels} from '../../web/source-models-v1.mjs';
const input=JSON.parse(readFileSync(0,'utf8'));
const rpc = createRPC(input);
const store = createRPCStore(rpc);
const run={state:()=>rpc('state'),assertOpen:()=>rpc('assert_open'),noteProgress:()=>rpc('progress'),stop:(reason,status='STOPPED')=>rpc('stop',{reason,status}),reserve:args=>rpc('reserve',args),settle:(ref,args)=>rpc('settle',{ref,...args})};
const tools={definitions:input.definitions,fixedMaterialReads:['ontology_read_material'],isComplete:()=>rpc('complete'),call:(name,args,context)=>rpc('tool',{name,args,context}),
 finalizeNativeTurn:context=>rpc('tool',{name:'__program_finalize_turn',args:context}),
 // This tool has no input and exposes one frozen material. A repeated read never adds progress.
 progressSnapshot:({name})=>({name}),
 outputCorrectionFeedback:()=> '请直接提交本批候选的业务判断。候选材料已提供。',
};
process.env.LIGHTOG_NATIVE_RUNTIME_LOCK_FILE=input.runtime_binding.lock_file;process.env.LIGHTOG_NATIVE_RUNTIME_LOCK_SHA256=input.runtime_binding.lock_sha256;
let upstream;
if (input.mode === 'NATIVE_SIM') {
  upstream = simulatedResponses({role:'ontology',model:input.model,turns:input.simulation,readTool:'ontology_read_material'});
} else if (input.mode === 'REAL') {
  const models = createSourceModels();
  models.configure('generation', {...input.generation, enabled: true, api_key: input.api_key});
  upstream = models.nativeModelRuntime().upstream;
} else {
  throw Error('ONTOLOGY_NATIVE_MODE_INVALID');
}
try{
 const result=await runNativeAgent({store,run,tools,skillPaths:input.skill_paths,prompt:input.prompt,runtimeDirectory:input.runtime_directory,upstream,model:input.model,role:'ONTOLOGY',agentScope:input.agent_scope,maxFormatRepairs:0,maxIncompleteContinuations:1});
 process.stdout.write(JSON.stringify(result));
}catch(e){process.stdout.write(JSON.stringify({error:e.code??'ONTOLOGY_BRIDGE_FAILED'}));process.exitCode=1;}finally{rpc.close();}
