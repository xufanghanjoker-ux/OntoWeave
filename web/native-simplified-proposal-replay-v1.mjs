/** Host-only settled proposal replay. No model executor, fabricated reservation or semantic decisions. */
import {hash,clone,need} from './cq-discovery-store-v2.mjs';
import {createSimplifiedBlockTask,SIMPLIFIED_TOOLS as T} from './native-simplified-extraction-v1.mjs';
const VERSION='SETTLED_SOURCE_PROPOSAL_REPLAY_V1';
export function createNativeSimplifiedProposalReplay({sourceRun,sourceSnapshot,sourceManifest,stages,proposals,saveOrder}){
 need(['SUCCEEDED','PARTIALLY_READY','COMPLETED'].includes(sourceRun?.status)&&sourceRun.input?.build_flow_policy==='SIMPLIFIED_SOURCE_BLOCK_V1','PROPOSAL_REPLAY_SOURCE_NOT_SETTLED');
 need(Array.isArray(sourceRun.attempts)&&sourceRun.attempts.length>0&&sourceRun.attempts.every(a=>a.outcome==='RETURNED'),'PROPOSAL_REPLAY_UNKNOWN_OR_FAILED');
 need(sourceRun.input.source_snapshot_ref===sourceSnapshot?.snapshot_id&&sourceManifest?.run_id===sourceRun.run_id&&sourceManifest.manifest_sha256===hash(sourceManifest.manifest)&&sourceManifest.manifest.source_snapshot_ref===sourceSnapshot.snapshot_id&&sourceManifest.source_fingerprint===sourceSnapshot.fingerprint,'PROPOSAL_REPLAY_SOURCE_CHANGED');
 const windows=sourceManifest.manifest.windows,byWindow=new Map(windows.map(w=>[w.window_ref,w])),byStage=new Map(stages.map(s=>[s.stage_run_id,s]));
 need(windows.length===byWindow.size&&stages.length===windows.length&&byStage.size===stages.length&&saveOrder.length===stages.length&&new Set(saveOrder).size===stages.length&&saveOrder.every(id=>byStage.has(id)),'PROPOSAL_REPLAY_STAGE_COVERAGE');
 for(const s of stages)need(s.parent_run_id===sourceRun.run_id&&s.source_snapshot_ref===sourceSnapshot.snapshot_id&&s.library_id===sourceSnapshot.library_id&&byWindow.has(s.window_ref)&&s.window_sha256===hash(byWindow.get(s.window_ref)),'PROPOSAL_REPLAY_WINDOW_CHANGED');
 const seen=new Set();for(const p of proposals){need(!seen.has(p.proposal_ref)&&p.raw_hash===hash(p.raw)&&p.source_snapshot_ref===sourceSnapshot.snapshot_id&&byStage.has(p.run_id)&&p.name==='SUBMIT','PROPOSAL_REPLAY_RAW_CHANGED');seen.add(p.proposal_ref);}
 need(stages.every(s=>proposals.some(p=>p.run_id===s.stage_run_id)),'PROPOSAL_REPLAY_PROPOSAL_COVERAGE');
 const frozen=clone({sourceRun,sourceSnapshot,sourceManifest,stages,proposals,saveOrder}),body={policy:VERSION,origin_run_id:sourceRun.run_id,library_id:sourceSnapshot.library_id,source_snapshot_ref:sourceSnapshot.snapshot_id,source_snapshot_sha256:hash(sourceSnapshot),manifest_sha256:hash(sourceManifest.manifest),source_ledger_sha256:hash(sourceRun),proposals_sha256:hash(proposals),stage_bindings_sha256:hash(stages),save_order_sha256:hash(saveOrder),proposal_count:proposals.length};
 const binding=Object.freeze({...body,receipt_sha256:hash(body)});
 function assertFor({libraryId,snapshotId,source,capability}){need(libraryId===binding.library_id&&snapshotId===binding.source_snapshot_ref&&hash(source)===binding.source_snapshot_sha256,'PROPOSAL_REPLAY_TARGET_SOURCE_CHANGED');need(capability==='LEXICAL','PROPOSAL_REPLAY_LEXICAL_ONLY');return clone(binding);}
 async function run({store,catalog,libraryId,snapshotId,parentRun,manifest,cqInput,families,onSaved,getPreviousKnowledge}){
  assertFor({libraryId,snapshotId,source:catalog.get(snapshotId,libraryId),capability:'LEXICAL'});
  need(hash(manifest)===binding.manifest_sha256&&parentRun.state().input.settled_proposal_replay_sha256===binding.receipt_sha256&&parentRun.state().input.execution_mode==='PROGRAM_REPLAY_SETTLED_SOURCE_PROPOSALS','PROPOSAL_REPLAY_BINDING_CHANGED');
  const runId=parentRun.state().run_id;need(runId!==binding.origin_run_id&&!store.getRecord('native_simplified_proposal_replay_v1',runId),'PROPOSAL_REPLAY_NEW_RUN_REQUIRED');
  const startedAt=Date.now(),receipts=[],windowsResult=[];store.putRecord('native_simplified_proposal_replay_v1',runId,{status:'STARTED',binding:clone(binding),started_at:startedAt});
  try{for(const oldStageId of frozen.saveOrder){
   parentRun.assertOpen();const stage=frozen.stages.find(s=>s.stage_run_id===oldStageId),window=manifest.windows.find(w=>w.window_ref===stage.window_ref),local=createSimplifiedBlockTask({store,catalog,libraryId,snapshotId,parentRun,window,cqInput,families,onSaved,getPreviousKnowledge}),key=runId+':'+window.window_ref;
   need(!store.getRecord('native_simplified_block_v1',key),'PROPOSAL_REPLAY_BLOCK_EXISTS');
   store.putRecord('native_simplified_block_v1',key,{status:'PROGRAM_REPLAY_RUNNING',window_sha256:hash(window),stage_run_id:local.stageRunId,origin_stage_run_id:oldStageId});
   for(const old of frozen.proposals.filter(p=>p.run_id===oldStageId)){
    const args=clone(old.raw),result=await local.tools.call(T.SAVE,args,{invocation_ref:'settled-proposal-replay:'+binding.receipt_sha256,tool_call_ref:old.proposal_ref});need(result.ok,'PROPOSAL_REPLAY_RECEIVER_REJECTED');
    const saved=store.getRecord('native_knowledge_proposal_v1',result.result.proposal_ref);need(saved&&hash(saved.raw)===hash(old.raw)&&saved.raw_hash===old.raw_hash,'PROPOSAL_REPLAY_INPUT_MUTATED');
    receipts.push({original_proposal_ref:old.proposal_ref,original_stage_run_id:oldStageId,replay_proposal_ref:saved.proposal_ref,replay_stage_run_id:local.stageRunId,raw_sha256:old.raw_hash,receipt:clone(result.result)});
   }
   const finished=await local.tools.call(T.FINISH,{});need(finished.ok&&local.tools.isComplete(),'PROPOSAL_REPLAY_FINISH_REJECTED');
   const knowledge=local.readKnowledge(),projection=local.projection();windowsResult.push({window_ref:window.window_ref,stage_run_id:local.stageRunId,knowledge,projection,origin_stage_run_id:oldStageId});
   store.putRecord('native_simplified_block_v1',key,{status:'PROGRAM_REPLAY_SAVED_SETTLED',window_sha256:hash(window),stage_run_id:local.stageRunId,origin_stage_run_id:oldStageId,knowledge_sha256:hash(knowledge)});
  }
  need(parentRun.state().attempts.length===0,'PROPOSAL_REPLAY_MODEL_REQUEST_FORBIDDEN');
  const receipt={status:'SAVED_SETTLED_PROGRAM_REPLAY',binding:clone(binding),receipts,processed_windows:windowsResult.length,program_wall_ms:Date.now()-startedAt,model_requests:0,embedding_requests:0,semantic_decisions_added:0};store.putRecord('native_simplified_proposal_replay_v1',runId,receipt);return {...receipt,policy:VERSION,windows:windowsResult,semantic_quality:'UNASSESSED'};
  }catch(error){store.putRecord('native_simplified_proposal_replay_v1',runId,{status:'FAILED_NO_RETRY',binding:clone(binding),receipts,reason:error.code??error.message,model_requests:parentRun.state().attempts.length,program_wall_ms:Date.now()-startedAt});throw error;}
 }
 return Object.freeze({policy:VERSION,binding,assertFor,run});
}
