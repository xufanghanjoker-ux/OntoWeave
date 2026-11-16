/** Event-driven CQ business loop; each continuation consumes a persisted permit. */
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {cqMcpDefinitions} from './cq-mcp-session-v1.mjs';
import {createCQAgentLoop} from './cq-agent-loop-v1.mjs';
import {createCQInferenceGate} from './cq-inference-gate-v1.mjs';
import {createCQRuntimeBridge,createCodexCQAppServer} from './codex-cq-app-server-v1.mjs';
import {discoveryMode} from './codex-runtime-client-v1.mjs';
import {need,hash,createCQDiscoveryStore} from './cq-discovery-store-v2.mjs';
import {CQ_CONTENT_PROFILE,buildCQContentContext,cqContentPrompt} from './cq-content-context-v1.mjs';
export async function runAutonomousCQStageA({store,host,catalog,taskId,initialUnitId,runtimeDirectory,limits,loopLimits,upstream,mode='legacy_v1',onStarted=async()=>{},contextProfile=null,stopOnToolFailure}) {
  need(discoveryMode(mode)==='codex_v2','CQ_V2_NOT_SELECTED');
  need(contextProfile===null||contextProfile===CQ_CONTENT_PROFILE,'CQ_CONTEXT_PROFILE_INVALID');
  const toolSchemaHash=hash(cqMcpDefinitions({autonomous:true})),lock=JSON.parse(readFileSync(new URL('../contracts/cq-agent-loop-v1/mcp-tools.json',import.meta.url)));need(lock.version==='lightog-cq-loop-tools/1'&&hash(lock.tools)===toolSchemaHash,'CQ_LOOP_TOOL_SCHEMA_CHANGED');
  const loop=createCQAgentLoop({store,host,catalog,taskId,initialUnitId,limits:loopLimits,toolSchemaHash,stopOnToolFailure}),gate=createCQInferenceGate({store,host,taskId,limits,upstream}),events=[],runtimes=[];
  const existing=loop.state();
  if(!['STOPPED','COMPLETED'].includes(existing.status)&&existing.native_active&&['STARTING','RUNNING'].includes(existing.native_active.status)){host.recover(taskId);host.holdUnknown(taskId,'CQ_NATIVE_COMPLETION_NOT_CONFIRMED');loop.stop('UNKNOWN_HOLD');}
  let executed=false;
  async function execute(permitId) {
    const execution=loop.beginNative(permitId);if(!execution)return;executed=true;
    const binding=execution.binding;let bridge,runtime,handle,nextPermit;
    try {
      bridge=await createCQRuntimeBridge({host,catalog,taskId,workUnitId:binding.work_unit_id,gate,toolProvider:loop.toolsFor(binding),autonomous:true});
      runtime=await createCodexCQAppServer({runtimeDirectory:join(runtimeDirectory,execution.execution_id),bridge,host,taskId,timeoutMs:limits.max_wall_ms+2000,continuationPermitId:permitId??null,contentProfile:contextProfile===CQ_CONTENT_PROFILE});runtimes.push(runtime.metadata);
      const t=host.task(taskId),job={model:'qwen3.8-flash',prompt:'$lightog-cq-discovery\n当前为CQ自主发现与补全模式，仅阶段A。先观察进度/目录与已有检查点，按需读取并保存初稿；提交后检查具体遗漏，自主选择READ/SEARCH/REVISE_CQ或受控REQUEST_WORK_UNIT。结束必须记录FINISH_UNIT或STOP_PARTIAL及理由；单次submit或turn结束不代表业务完成。跨单元请求获准后结束当前轮次，等待Host绑定新单元，旧绑定不得越权。\n宿主上下文：'+JSON.stringify({snapshot_id:t.snapshot_id,work_unit_id:binding.work_unit_id,expected_draft_revision:t.draft_revision,expected_plan_revision:t.plan_revision,purpose:t.purpose,seed_questions:t.seed_questions,tool_version:'lightog-cq-loop-tools/1'})};
      if(contextProfile===CQ_CONTENT_PROFILE){const context=buildCQContentContext({host,catalog,loop,taskId,binding,limits});job.prompt=cqContentPrompt(context);createCQDiscoveryStore(store).append('bootstrap',execution.execution_id,{task_id:taskId,execution_id:execution.execution_id,context,prompt:job.prompt});}
      handle=await runtime.start(job);loop.nativeBound(execution.execution_id,handle);await onStarted({runtime,handle,loop,binding,execution,gate});
      const roundEvents=[];for await(const event of runtime.observe(handle)){roundEvents.push(event);events.push({execution_id:execution.execution_id,...event});}
      const terminal=roundEvents.findLast(e=>e.method==='turn/completed'&&e.params?.turn?.id===handle.turn_id);nextPermit=loop.endNative(execution.execution_id,handle,terminal);
    }catch(error){
      host.recover(taskId);const currentHandle=host.task(taskId).runtime_handle,possibleHandle=handle??(currentHandle?.runtime_id!==execution.previous_handle?.runtime_id?currentHandle:null);
      loop.endNative(execution.execution_id,possibleHandle??null,possibleHandle?null:{params:{turn:{status:'failed'}}});
      events.push({execution_id:execution.execution_id,local_error:error.code??'CQ_LOOP_LOCAL_FAILURE'});
    }finally{await runtime?.close();await bridge?.close();}
    // Only endNative can issue this permit, after a known successful terminal.
    if(nextPermit)await execute(nextPermit);
  }
  const state=loop.state();if(!['STOPPED','COMPLETED'].includes(state.status))await execute(state.status==='AWAITING_CONTINUATION'?state.permit_id:null);
  const result=executed?host.finalize(taskId,host.task(taskId).draft_revision,loop.state().stop_reason??'CQ_AGENT_LOOP_STAGE_A_ONLY'):{task:host.task(taskId),draft:host.draft(taskId),remaining:host.remaining(taskId)};
  return {...result,execution_outcome:executed?'EXECUTED':'NO_AUTOMATIC_REPLAY',loop:loop.state(),records:loop.records(),events,budget:gate.state(),runtimes,stage_a_complete:loop.state().status==='COMPLETED',semantic_autonomy_verified:false};
}
