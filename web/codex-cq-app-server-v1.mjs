/** Fixed-version stdio adapter. Inference only goes through the local gate.
 * Host config/credentials are not inherited; default product routing is untouched. */
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import {mkdirSync,writeFileSync,readFileSync,copyFileSync,rmSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {need,id} from './cq-discovery-store-v2.mjs';
import {createCQTools} from './lightog-cq-tools-v1.mjs';
import {CQ_CONTENT_BASE} from './cq-content-context-v1.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),sha=b=>createHash('sha256').update(b).digest('hex');
export const CODEX_CQ_EXECUTABLE='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const quote=value=>JSON.stringify(value);
async function bodyOf(req,limit=1048576){let size=0;const chunks=[];for await(const c of req){size+=c.length;need(size<=limit,'CQ_HTTP_INPUT_TOO_LARGE');chunks.push(c);}return Buffer.concat(chunks);}
export async function createCQRuntimeBridge({host,catalog,taskId,workUnitId,gate,toolProvider=null,autonomous=false,listOnly=false,reviewRole=null,rawInference=false}) {
  const token=randomUUID(),tools=toolProvider??createCQTools({host,catalog,taskId,workUnitId,allowedStages:['CQ'],allowFinalize:false});
  const inFlight=new Set();
  const handler=async(req,res)=>{
    try {
      need(req.headers.authorization==='Bearer '+token,'CQ_LOCAL_AUTH_REQUIRED');need(req.method==='POST','CQ_LOCAL_METHOD_FORBIDDEN');
      const bytes=await bodyOf(req),value=JSON.parse(bytes.toString('utf8'));
      if(listOnly&&req.url==='/broker/failure'){if(!tools.isComplete?.())tools.fail('CQ_MCP_PROTOCOL_OR_BRIDGE_FAILURE');res.writeHead(200,{'Content-Type':'application/json'});res.end('{"stopped":true}');return;}
      if(req.url==='/broker') {const result=await tools.call(value.name,value.args);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));return;}
      need(req.url==='/v1/responses','CQ_LOCAL_ROUTE_FORBIDDEN');
      const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
      const result=await gate.send(rawInference?bytes:value,controller.signal);res.writeHead(result.status,{'Content-Type':result.content_type});res.end(result.body);
    }catch(error){if(listOnly&&req.headers.authorization==='Bearer '+token&&error.code!=='CQ_LIST_SAVED'&&!tools.isComplete?.())tools.fail(error.code??'CQ_BRIDGE_FAILED');if(!res.headersSent)res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:error.code??'CQ_LOCAL_REQUEST_FAILED',type:'lightog_gate'}}));}
  };
  const server=createServer((req,res)=>{const pending=handler(req,res);inFlight.add(pending);pending.finally(()=>inFlight.delete(pending));});
  server.on('connect',(_req,socket)=>socket.destroy());
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
  const url='http://127.0.0.1:'+server.address().port;
  return {url,token,autonomous,listOnly,reviewRole,rawInference,async close(){server.closeAllConnections();await new Promise(done=>server.close(done));await Promise.allSettled([...inFlight]);}};
}
export function writeCQCodexConfig({runtimeDirectory,bridge,contentProfile=false,skillName='lightog-cq-discovery',skillNames=null,nativeProfile=false,modelProvider=null}) {
  const selected=skillNames??[skillName];
  need(selected.length>0&&new Set(selected).size===selected.length&&selected.every(n=>['lightog-cq-discovery','lightog-cq-quality-review','lightog-cq-family-normalization'].includes(n)),'CQ_SKILL_NOT_ALLOWED');
  need(!modelProvider||nativeProfile,'CQ_NATIVE_PROVIDER_REQUIRED');
  const providerId=modelProvider?.id??'lightog',baseUrl=modelProvider?.baseUrl??bridge.url+'/v1';
  need(/^[a-z][a-z0-9_]*$/.test(providerId),'CQ_PROVIDER_ID_INVALID');
  if(modelProvider){const url=new URL(baseUrl);need(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash,'CQ_PROVIDER_URL_INVALID');}
  const configRoot=join(runtimeDirectory,'codex-state'),cwd=join(runtimeDirectory,'session');mkdirSync(configRoot,{recursive:true});mkdirSync(cwd,{recursive:true});
  const skills=selected.map(name=>{
    const skillRoot=join(cwd,'.agents','skills',name);mkdirSync(skillRoot,{recursive:true});
    const skillSource=join(root,'.agents/skills',name,'SKILL.md'),path=join(skillRoot,'SKILL.md');copyFileSync(skillSource,path);
    return {name,path,sha256:sha(readFileSync(skillSource))};
  });
  const skillPath=skills[0].path,skill_sha256=skills[0].sha256;
  const config=`${contentProfile||nativeProfile?'model_reasoning_effort = "low"\n':''}${nativeProfile?'model_reasoning_summary = "none"\n':''}model = "qwen3.8-flash"
model_provider = ${quote(providerId)}
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"
check_for_update_on_startup = false
history.persistence = "none"
analytics.enabled = false
feedback.enabled = false
[features]
apps = false
plugins = false
multi_agent = false
view_image = false
${nativeProfile?'shell_tool = false\ngoals = false\nsleep_tool = false\nmemories = false\nrequest_permissions = false\n':''}[model_providers.${providerId}]
name = "LightOG ${nativeProfile?'native Responses provider':'bounded CQ gateway'}"
base_url = ${quote(baseUrl)}
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 15000
${modelProvider?'env_key = "LIGHTOG_MODEL_API_KEY"':'[model_providers.'+providerId+'.http_headers]\nAuthorization = '+quote('Bearer '+bridge.token)}
[mcp_servers.lightog_cq]
command = ${quote(process.execPath)}
args = [${quote(join(root,nativeProfile?'web/cq-native-workflow-mcp-v1.mjs':'web/cq-mcp-stdio-v1.mjs'))}]
startup_timeout_sec = 10
tool_timeout_sec = 10
[mcp_servers.lightog_cq.env]
LIGHTOG_CQ_BROKER_URL = ${quote(bridge.url+'/broker')}
LIGHTOG_CQ_BROKER_TOKEN = ${quote(bridge.token)}
LIGHTOG_CQ_AUTONOMOUS = ${quote(bridge.autonomous?'1':'0')}
LIGHTOG_CQ_LIST_ONLY = ${quote(bridge.listOnly?'1':'0')}
LIGHTOG_CQ_REVIEW_ROLE = ${quote(bridge.reviewRole??'')}
`;
  writeFileSync(join(configRoot,'config.toml'),config,{flag:'wx',mode:0o600});
  return {configRoot,cwd,skillPath,skill_sha256,skills,providerId};
}
export async function createCodexCQAppServer({runtimeDirectory,bridge,host,taskId,executable=CODEX_CQ_EXECUTABLE,timeoutMs=20000,continuationPermitId=null,contentProfile=false,skillName='lightog-cq-discovery',baseInstructions=null,reviewScope=null,skillNames=null,nativeProfile=false,modelProvider=null,onRuntimeFailure=null}) {
  if(modelProvider)need(typeof modelProvider.apiKey==='string'&&modelProvider.apiKey.length>0,'CQ_CREDENTIAL_REQUIRED');
  const lock=JSON.parse(readFileSync(join(root,'contracts/cq-discovery-v1/runtime-lock.json')));need(sha(readFileSync(executable))===lock.executable_sha256,'CQ_CODEX_EXECUTABLE_CHANGED');
  const isolated=writeCQCodexConfig({runtimeDirectory,bridge,contentProfile,skillName,skillNames,nativeProfile,modelProvider}),pending=new Map(),notifications=[],listeners=new Set(),diagnostics=[];let nextId=0,closed=false;
  // Child-only official config root; parent CODEX_HOME/HOME and user config stay intact.
  const child=spawn(executable,['app-server','--listen','stdio://'],{cwd:isolated.cwd,env:{PATH:process.env.PATH??'/usr/bin:/bin',CODEX_HOME:isolated.configRoot,
    ...(!nativeProfile?{HTTP_PROXY:bridge.url,HTTPS_PROXY:bridge.url,ALL_PROXY:bridge.url}:{}),...(modelProvider?{LIGHTOG_MODEL_API_KEY:modelProvider.apiKey}:{}),NO_PROXY:'127.0.0.1,localhost',RUST_LOG:'error'},stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:child.stdout,crlfDelay:Infinity});
  function wake(){for(const f of listeners)f();listeners.clear();}
  const send=m=>{need(!closed,'CQ_CODEX_CLOSED');child.stdin.write(JSON.stringify(m)+'\n');};
  const rpc=(method,params)=>new Promise((done,reject)=>{
    const requestId=++nextId,timer=setTimeout(()=>{pending.delete(requestId);reject(Object.assign(Error('CQ_RPC_TIMEOUT'),{code:'CQ_RPC_TIMEOUT'}));},timeoutMs);
    pending.set(requestId,{done:v=>{clearTimeout(timer);done(v);},reject:e=>{clearTimeout(timer);reject(e);}});send({id:requestId,method,params});
  });
  lines.on('line',line=>{
    let m;try{m=JSON.parse(line);}catch{return;}
    if(m.id!==undefined&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Object.assign(Error('CQ_RPC_REJECTED'),{code:'CQ_RPC_REJECTED',rpc_error:m.error})):p.done(m.result);return;}
    if(m.id!==undefined&&m.method){onRuntimeFailure?.('CQ_NATIVE_UNEXPECTED_RPC');send({id:m.id,error:{code:-32601,message:'CQ host declines runtime approval or unrelated tools'}});return;}
    notifications.push(m);wake();
  });
  child.stderr.on('data',bytes=>{if(diagnostics.join('').length<16000)diagnostics.push(bytes.toString());});
  child.on('error',()=>{closed=true;wake();});child.on('exit',()=>{closed=true;for(const p of pending.values())p.reject(Object.assign(Error('CQ_CODEX_EXITED'),{code:'CQ_CODEX_EXITED'}));pending.clear();wake();});
  let handle;
  async function close(){if(!closed){child.stdin.end();child.kill('SIGTERM');await new Promise(done=>{const timer=setTimeout(()=>{child.kill('SIGKILL');done();},1500);child.once('exit',()=>{clearTimeout(timer);done();});});}lines.close();rmSync(isolated.configRoot,{recursive:true,force:true});}
  try{await rpc('initialize',{clientInfo:{name:'lightog_cq',title:'LightOG CQ',version:'2.0.0'},capabilities:{experimentalApi:false}});send({method:'initialized',params:{}});}
  catch(error){await close();error.diagnostics=diagnostics.join('').replaceAll(bridge.token,'[REDACTED]').replaceAll(modelProvider?.apiKey??'NOT_A_SECRET_SENTINEL','[REDACTED]');throw error;}
  try {if(!continuationPermitId)host.bindRuntime(taskId,{kind:'CODEX_LOCAL_GATE',model:'qwen3.8-flash',cli_version:lock.cli_version,skill_version:isolated.skill_sha256,skill_sha256:isolated.skill_sha256,model_compatibility:'UNKNOWN'},reviewScope);
    else need(host.task(taskId).runtime_binding.skill_sha256===isolated.skill_sha256,'CQ_CONTINUATION_SKILL_CHANGED');
  }catch(error){await close();throw error;}
  return {
    async capabilities(){return {port:'lightog_agent_runtime_v1',kind:'CODEX_LOCAL_GATE',available:true,version:lock.cli_version,model:'qwen3.8-flash',compatibility:'UNKNOWN',per_request_gate_verified:true};},
    metadata:{cli_version:lock.cli_version,executable_sha256:lock.executable_sha256,skill_sha256:isolated.skill_sha256,transport:'stdio-jsonl',...(nativeProfile?{native_profile:true,skills:isolated.skills.map(({name,sha256})=>({name,sha256})),provider:isolated.providerId,counted_transport:!modelProvider}:{} )},
    diagnostics:()=>diagnostics.join('').replaceAll(bridge.token,'[REDACTED]').replaceAll(modelProvider?.apiKey??'NOT_A_SECRET_SENTINEL','[REDACTED]'),rpc,
    async start(job) {
      need(!handle,'CQ_CODEX_ALREADY_STARTED');need(job.model==='qwen3.8-flash','CQ_MODEL_MISMATCH');
      const thread=await rpc('thread/start',{model:job.model,modelProvider:isolated.providerId,cwd:isolated.cwd,approvalPolicy:'never',sandbox:'read-only',ephemeral:true,...(baseInstructions?{baseInstructions}:contentProfile?{baseInstructions:CQ_CONTENT_BASE}:{})});
      need(thread.thread?.id,'CQ_THREAD_ID_MISSING');handle={runtime_id:id('codex'),thread_id:thread.thread.id,turn_id:null};if(continuationPermitId)host.bindContinuationHandle(taskId,handle,continuationPermitId);else host.setRuntimeHandle(taskId,handle,reviewScope);
      const result=await rpc('turn/start',{threadId:handle.thread_id,input:[{type:'text',text:job.prompt},...isolated.skills.map(({name,path})=>({type:'skill',name,path}))]});handle.turn_id=result.turn?.id;need(handle.turn_id,'CQ_TURN_ID_MISSING');host.updateRuntimeHandle(taskId,handle);return {...handle};
    },
    async *observe(runtimeHandle,afterEvent=0) {
      let cursor=afterEvent;const deadline=Date.now()+timeoutMs;
      while(Date.now()<deadline) {
        while(cursor<notifications.length){const m=notifications[cursor++];yield {event_id:cursor,...m};if(m.method==='turn/completed'&&m.params?.turn?.id===runtimeHandle.turn_id)return;}
        if(closed)throw Object.assign(Error('CQ_CODEX_DISCONNECTED'),{code:'CQ_CODEX_DISCONNECTED'});
        await new Promise(done=>{const timer=setTimeout(()=>{listeners.delete(wakeUp);done();},100);function wakeUp(){clearTimeout(timer);done();}listeners.add(wakeUp);});
      }
      throw Object.assign(Error('CQ_TURN_OBSERVATION_TIMEOUT'),{code:'CQ_TURN_OBSERVATION_TIMEOUT'});
    },
    async interrupt(runtimeHandle){need(handle?.runtime_id===runtimeHandle.runtime_id,'CQ_RUNTIME_HANDLE_UNKNOWN');if(handle.turn_id)await rpc('turn/interrupt',{threadId:handle.thread_id,turnId:handle.turn_id});return {confirmed:true,remote_nonexecution_proven:false};},
    close
  };
}
