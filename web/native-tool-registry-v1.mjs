/** Optional Host-owned capability registry. No spelling aliases or model-authored mappings. */
import {clone,hash,need} from './cq-discovery-store-v2.mjs';
export const NATIVE_TOOL_REGISTRY='NATIVE_TOOL_REGISTRY_V1';
export const TOOL_ERROR_BRIDGE='tool_error';
const namespace='mcp__lightog_native';
export function createNativeToolRegistry({role,agentScope,capabilities}) {
  need(typeof role==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(role)&&typeof agentScope==='string'&&agentScope.length>0&&agentScope.length<=512&&(agentScope!=='DOCUMENT_TEMPORAL'||role==='EXTRACTION'),'NATIVE_TOOL_REGISTRY_SCOPE_INVALID');
  need(capabilities&&Object.keys(capabilities).length>0&&Object.keys(capabilities).every(k=>/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k)&&k!==TOOL_ERROR_BRIDGE&&!k.includes('__'))&&Object.values(capabilities).every(v=>typeof v==='string'&&/^[A-Za-z0-9_]{1,64}$/.test(v))&&new Set(Object.values(capabilities)).size===Object.keys(capabilities).length,'NATIVE_TOOL_REGISTRY_CAPABILITIES_INVALID');
  const body={version:NATIVE_TOOL_REGISTRY,role,agent_scope:agentScope,namespace,capabilities:clone(capabilities),error_bridge:TOOL_ERROR_BRIDGE,max_unknown_tool_corrections:1};
  return {...body,registry_sha256:hash(body)};
}
export function checkNativeToolRegistry(registry,{role,agentScope}={}) {
  const expected=createNativeToolRegistry({role:registry?.role,agentScope:registry?.agent_scope,capabilities:registry?.capabilities});
  need(hash(expected)===hash(registry)&&(!role||role===registry.role)&&(agentScope===undefined||agentScope===registry.agent_scope),'NATIVE_TOOL_REGISTRY_BINDING_INVALID');
  return registry;
}
export const registryToolNames=registry=>[...Object.keys(registry.capabilities),registry.error_bridge];
export const registryWireNames=registry=>registryToolNames(registry).map(name=>registry.namespace+'__'+name);
export function registryToolFeedback(registry,recoveryRef) {
  return {ok:true,result:{status:'TOOL_NOT_FOUND',code:'NATIVE_TOOL_NOT_FOUND',recovery_ref:recoveryRef,
    available_tools:Object.keys(registry.capabilities),message:'工具不存在，未执行此调用。仅使用当前可用工具；不要重复已成功的调用。Host最多提供一次局部纠正，沿用原上下文和预算。'}};
}
export function bindNativeToolRegistry({registry,role,agentScope,tools}) {
  checkNativeToolRegistry(registry,{role,agentScope});

  const entries=Object.entries(registry.capabilities);
  need(tools.definitions.length===entries.length&&entries.every(([,name])=>tools.definitions.filter(d=>d.name===name).length===1),'NATIVE_TOOL_REGISTRY_INVENTORY_INVALID');
  const implementation=name=>{need(Object.hasOwn(registry.capabilities,name),'NATIVE_TOOL_REGISTRY_CALL_FORBIDDEN');return registry.capabilities[name];};
  return {...tools,definitions:[...entries.map(([name,internal])=>({...clone(tools.definitions.find(d=>d.name===internal)),name,description:rewriteRegistryText(registry,tools.definitions.find(d=>d.name===internal).description??'')})),
    {name:registry.error_bridge,description:'Host-only tool-name error feedback bridge; never performs a business read or write. Do not call directly.',
      inputSchema:{type:'object',properties:{recovery_ref:{type:'string'}},required:['recovery_ref'],additionalProperties:false},
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}}],
    ...(tools.argumentPolicy?{argumentPolicy:{...clone(tools.argumentPolicy),tools:Object.fromEntries(entries.filter(([,internal])=>Object.hasOwn(tools.argumentPolicy.tools,internal)).map(([short,internal])=>[short,clone(tools.argumentPolicy.tools[internal])]))}}:{}),
    call:(name,args,ctx)=>{const internal=implementation(name);return Promise.resolve(tools.call(internal,args,{...ctx,...(ctx?.pending_tool_calls?{pending_tool_calls:ctx.pending_tool_calls.map(c=>({...c,tool_name:registry.capabilities[c.tool_name]??c.tool_name}))}:{})})).then(value=>mapRegistryMetadata(registry,value));},
    ...(tools.progressSnapshot?{progressSnapshot:({name,...rest})=>tools.progressSnapshot({name:implementation(name),...rest})}:{})};
}
export const registryInstructions=registry=>'Host当前业务工具：'+JSON.stringify({namespace:registry.namespace,available_tools:Object.keys(registry.capabilities)})+
  '。能力由Host声明并映射到当前角色实际工具；用途及参数以各工具描述和Schema为准。tool_error仅由Host反馈不存在工具，不执行业务。仅完整已返回且Host已登记的工具名错误可在同一上下文纠正一次；其他错误及UNKNOWN立即停止，不回放成功调用。';

const metadataKeys=new Set(['tool','source_access','saved_access','read_tool','candidate_read_tool']);
export function rewriteRegistryText(registry,text){let value=text;for(const [short,internal]of Object.entries(registry.capabilities))value=value.replace(new RegExp('(?<![A-Za-z0-9_])'+internal+'(?![A-Za-z0-9_])','g'),short);return value;}
const navigationContainers=new Set(['result','reading','local_alignment','saved_knowledge','organization_focus','remaining','read_tools']);
export function mapRegistryMetadata(registry,value,container='ROOT'){if(!value||typeof value!=='object'||Array.isArray(value))return clone(value);return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,typeof item==='string'&&(metadataKeys.has(key)||container==='read_tools')?rewriteRegistryText(registry,item):navigationContainers.has(key)?mapRegistryMetadata(registry,item,key):clone(item)]));}
export function registryPrompt(registry,prompt){return prompt.split('\n').map(line=>{try{return JSON.stringify(mapRegistryMetadata(registry,JSON.parse(line)));}catch{return line;}}).join('\n');}
