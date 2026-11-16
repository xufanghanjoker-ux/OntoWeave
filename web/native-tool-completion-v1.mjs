/** Reconcile Codex-owned tools from native protocol feedback, never business saves.
 * The proxy receives this input from Codex, not from a model response. Bind the
 * result to the exact earlier delivered call in the same invocation first.
 */
import {hash,need} from './cq-discovery-store-v2.mjs';

const BATCH='native_agent_delivered_tool_batch_v1';
const resourceTools=new Set(['read_mcp_resource','list_mcp_resources','list_mcp_resource_templates']);
export const qualifiedNativeCall=call=>call.namespace&&!call.name?.startsWith(call.namespace+'__')?call.namespace+'__'+call.name:call.name;
export function nativeCallOwner(call){
  const name=qualifiedNativeCall(call);
  return name?.startsWith('mcp__lightog_native__')||resourceTools.has(name)?'LIGHTOG_MCP':'CODEX_RUNTIME';
}

export function reconcileNativeToolCompletions({store,invocationRef,body,wireSha256}){
  const input=Array.isArray(body?.input)?body.input:[];
  const originals=input.filter(i=>i?.type==='function_call');
  const outputs=input.filter(i=>i?.type==='function_call_output'&&typeof i.call_id==='string');
  let completed=0;
  store.transaction(()=>{
    for(const batch of store.listRecords(BATCH).filter(b=>b.invocation_ref===invocationRef)){
      let changed=false;
      for(const call of batch.calls){
        if(call.execution_owner!=='CODEX_RUNTIME'||call.status!=='PENDING')continue;
        const results=outputs.filter(i=>i.call_id===call.call_id);if(!results.length)continue;
        need(new Set(results.map(i=>hash(i.output??null))).size===1,'NATIVE_TOOL_OUTPUT_CONFLICT');
        const original=originals.find(i=>i.call_id===call.call_id);
        need(original&&qualifiedNativeCall(original)===call.qualified_tool_name,'NATIVE_TOOL_OUTPUT_BINDING_INVALID');
        let args;try{args=JSON.parse(original.arguments);}catch{need(false,'NATIVE_TOOL_OUTPUT_BINDING_INVALID');}
        need(hash(args)===call.arguments_sha256,'NATIVE_TOOL_OUTPUT_BINDING_INVALID');
        // COMPLETED means Codex returned the tool result. Business completion
        // still requires its real MCP save; normal error checks still apply.
        call.status='COMPLETED';
        call.completion={source:'CODEX_FUNCTION_CALL_OUTPUT',output_sha256:hash(results[0].output??null),observed_wire_sha256:wireSha256,observed_at:Date.now()};
        changed=true;completed++;
      }
      if(changed)store.putRecord(BATCH,batch.request_ref,batch);
    }
  });
  return completed;
}
