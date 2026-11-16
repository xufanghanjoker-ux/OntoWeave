/** Read -> understand/generate -> save. Save, not a later native turn, completes output. */
import {createCQListOutput,CQ_LIST_TOOLS} from './cq-list-output-v1.mjs';
import {createCQInferenceGate} from './cq-inference-gate-v1.mjs';
import {createCQRuntimeBridge,createCodexCQAppServer} from './codex-cq-app-server-v1.mjs';
import {createCQDiscoveryStore,need,id} from './cq-discovery-store-v2.mjs';
export const CQ_LIST_WIRE_NAMES=CQ_LIST_TOOLS.map(n=>'mcp__lightog_cq__'+n);
export function cqListPrompt({host,catalog,taskId}) {
  const t=host.task(taskId),doc=catalog.get(t.snapshot_id,t.library_id).documents[0];
  return '$lightog-cq-discovery\n本次只做资料→CQ列表。读取本次唯一材料，理解主要内容，生成有用且目标适中的问题；保存前按需要检查表达与重复。短资料可以直接完整读取，不强制分组或多轮。每项question，可选source_hint/notes。使用lightog_save_cq_list保存后，本次产出即完成，不需结束决策或额外消息。\n'+JSON.stringify({purpose:t.purpose,material:{title:doc.title,chars:doc.content.length},tools:'仅本次读取/保存工具；Host管理ID、版本及来源绑定。'});
}
export async function runCQListStageA({store,host,catalog,taskId,runtimeDirectory,limits,upstream,onStarted=async()=>{}}) {
  const db=createCQDiscoveryStore(store),tools=createCQListOutput({store,host,catalog,taskId}),events=[];
  const result=(extra={})=>({cq_list_complete:tools.state().saved,output_status:tools.state().saved?'CQ_LIST_SAVED':'CQ_LIST_NOT_SAVED',execution_status:tools.state().status,items:tools.state().items,task:host.task(taskId),draft:host.draft(taskId),list_state:tools.state(),events,...extra});
  const old=db.get('list_execution',taskId);if(old||host.task(taskId).runtime_handle||host.task(taskId).requests.length){host.recover(taskId);return result({execution_outcome:'NO_AUTOMATIC_REPLAY'});}
  need(tools.state().status==='OPEN','CQ_LIST_NOT_OPEN');const execution_id=id('list_execution');db.append('list_execution',taskId,{execution_id,task_id:taskId,status:'STARTED',started_at:Date.now()});
  const gate=createCQInferenceGate({store,host,taskId,limits,upstream,allowedWireNames:CQ_LIST_WIRE_NAMES});let bridge,runtime,watcher;
  try {
    bridge=await createCQRuntimeBridge({host,catalog,taskId,workUnitId:host.task(taskId).work_units[0].work_unit_id,gate,toolProvider:tools,listOnly:true});
    runtime=await createCodexCQAppServer({runtimeDirectory,bridge,host,taskId,contentProfile:true,timeoutMs:limits.max_wall_ms+2000});
    const prompt=cqListPrompt({host,catalog,taskId});db.append('list_startup',execution_id,{task_id:taskId,execution_id,prompt});
    const handle=await runtime.start({model:'qwen3.8-flash',prompt});await onStarted({runtime,handle,tools,gate});
    watcher=(async()=>{try{for await(const e of runtime.observe(handle))events.push(e);}catch(error){events.push(tools.state().saved?{host_ended_after_save:true}:{local_error:error.code??'CQ_LIST_NATIVE_ERROR'});}if(tools.state().status==='OPEN')tools.fail('CQ_LIST_NOT_SAVED');})();
    await Promise.race([tools.completion,watcher]);
  }catch(error){host.recover(taskId);tools.fail(error.code??'CQ_LIST_LOCAL_FAILURE');events.push({local_error:error.code??'CQ_LIST_LOCAL_FAILURE'});}
  finally{await runtime?.close();await bridge?.close();await watcher;}
  const current=db.get('list_execution',taskId);db.put('list_execution',taskId,{...current,status:tools.state().status,ended_at:Date.now()});
  return result({execution_outcome:'EXECUTED',budget:gate.state(),runtime:runtime?.metadata,native_completion_required:false,completion_source:tools.state().saved?'HOST_ACCEPTED_SAVE':null});
}
