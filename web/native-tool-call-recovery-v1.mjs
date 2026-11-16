/** Complete-response-only, audited substitution to a no-action error bridge. */
import {createHash} from 'node:crypto';
import {clone,hash,need} from './cq-discovery-store-v2.mjs';
import {checkNativeToolRegistry,registryWireNames} from './native-tool-registry-v1.mjs';
export const TOOL_CALL_RECOVERY='native_agent_tool_call_recovery_v1';
export const TOOL_CALL_DERIVED_RESPONSE='native_agent_tool_call_derived_response_v1';
const sha=b=>createHash('sha256').update(b).digest('hex');
export const qualifiedToolCall=c=>c.namespace?c.namespace+'__'+c.name:c.name;
function frames(bytes){
  const text=Buffer.from(bytes).toString('utf8');need(/(?:\r?\n){2}$/.test(text),'CQ_STREAM_TRUNCATED');
  return text.split(/(?<=\n\n)/).filter(Boolean).map(raw=>{const data=raw.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');return {raw,event:!data||data==='[DONE]'?null:JSON.parse(data)};});
}
export function confirmedRegistryCalls(bytes){
  const fs=frames(bytes),ends=fs.filter(f=>f.event?.type==='response.completed');
  need(ends.length===1&&ends[0].event.response?.status==='completed','CQ_STREAM_RESULT_UNKNOWN');
  const calls=(ends[0].event.response.output??[]).filter(c=>c.type==='function_call');
  need(calls.every(c=>typeof c.id==='string'&&c.id&&typeof c.call_id==='string'&&c.call_id&&typeof c.arguments==='string')&&new Set(calls.map(c=>c.id)).size===calls.length&&new Set(calls.map(c=>c.call_id)).size===calls.length,'NATIVE_TOOL_CALL_ID_AMBIGUOUS');
  const known=new Map(calls.map(c=>[c.id,c]));
  for(const {event:e}of fs){if(!e)continue;
    if(e.item?.type==='function_call'){
      const c=known.get(e.item.id);need(c&&c.call_id===e.item.call_id&&qualifiedToolCall(c)===qualifiedToolCall(e.item),'NATIVE_TOOL_CALL_COPIES_MISMATCH');
      if(e.type==='response.output_item.done')need(e.item.arguments===c.arguments,'NATIVE_TOOL_CALL_COPIES_MISMATCH');
    }
    if(e.type==='response.function_call_arguments.done'){const c=known.get(e.item_id);need(c&&e.arguments===c.arguments,'NATIVE_TOOL_CALL_COPIES_MISMATCH');}
  }
  for(const c of calls){const deltas=fs.filter(f=>f.event?.type==='response.function_call_arguments.delta'&&f.event.item_id===c.id).map(f=>f.event.delta);need(!deltas.length||deltas.every(v=>typeof v==='string')&&deltas.join('')===c.arguments,'NATIVE_TOOL_CALL_COPIES_MISMATCH');}
  return {frames:fs,calls};
}
export function deriveUnknownToolFeedback({bytes,registry,allowedNames,runId,invocationRef,requestRef,available=true}){
  checkNativeToolRegistry(registry);const parsed=confirmedRegistryCalls(bytes),own=registryWireNames(registry),unknown=parsed.calls.filter(c=>!own.includes(qualifiedToolCall(c)));
  const bad=()=>need(false,'CQ_RETURNED_TOOL_FORBIDDEN');
  need(!parsed.calls.some(c=>qualifiedToolCall(c)===registry.namespace+'__'+registry.error_bridge),'NATIVE_TOOL_ERROR_BRIDGE_UNBOUND');
  if(!unknown.length)return null;
  if(!available||!own.every(n=>allowedNames.includes(n)))bad();
  // A function in another namespace, a qualified name hidden in a namespace,
  // native execution helpers, or invalid arguments never becomes recoverable.
  for(const c of unknown){if(c.namespace!==registry.namespace||!/^[A-Za-z0-9_]{1,64}$/.test(c.name)||c.name.includes('__')||['exec_command','apply_patch','shell','request_user_input','list_mcp_resources','read_mcp_resource'].includes(c.name))bad();try{const a=JSON.parse(c.arguments);need(a&&typeof a==='object'&&!Array.isArray(a),'CQ_RETURNED_TOOL_FORBIDDEN');}catch{bad();}}
  const recoveryRef='tool_call_recovery_'+hash([invocationRef,requestRef,registry.registry_sha256]);
  const mapping=unknown.map(c=>({item_id:c.id,call_id:c.call_id,original_name:c.name,namespace:c.namespace,original_arguments_sha256:hash(c.arguments),derived_name:registry.error_bridge,derived_arguments:JSON.stringify({recovery_ref:recoveryRef})}));
  const byItem=new Map(mapping.map(m=>[m.item_id,m])),emitted=new Set();
  const body=Buffer.from(parsed.frames.map(({raw,event:e})=>{if(!e)return raw;const next=clone(e);let changed=false;
    const item=c=>{const m=byItem.get(c?.id);if(!m)return;c.name=m.derived_name;if(next.type!=='response.output_item.added'||c.arguments!=='')c.arguments=m.derived_arguments;changed=true;};
    item(next.item);for(const c of next.response?.output??[])item(c);
    const m=byItem.get(next.item_id);
    if(m&&next.type==='response.function_call_arguments.delta'){next.delta=emitted.has(m.item_id)?'':m.derived_arguments;emitted.add(m.item_id);changed=true;}
    if(m&&next.type==='response.function_call_arguments.done'){next.arguments=m.derived_arguments;changed=true;}
    if(!changed)return raw;const eol=raw.includes('\r\n')?'\r\n':'\n';return [...raw.split(/\r?\n/).filter(l=>l&&!l.startsWith('data:')),'data: '+JSON.stringify(next),'',''].join(eol);
  }).join(''));
  const audit={version:'NATIVE_TOOL_CALL_RECOVERY_V1',recovery_ref:recoveryRef,run_id:runId,invocation_ref:invocationRef,request_ref:requestRef,registry_sha256:registry.registry_sha256,status:'AWAIT_FEEDBACK',used:0,max_corrections:1,
    reason:'UNKNOWN_NAME_IN_CONTROLLED_NAMESPACE',raw_response_sha256:sha(bytes),derived_response_sha256:sha(body),mapping,feedback_call_ids:[],business_actions_for_unknown:0};
  return {body,audit:{...audit,record_sha256:hash(audit)}};
}
