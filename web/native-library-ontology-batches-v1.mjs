/** Scheduling only: affinity never establishes semantic identity or merges definitions. */
import {hash,clone,need} from './cq-discovery-store-v2.mjs';
const array=v=>Array.isArray(v)?v:[];
export const NATIVE_ONTOLOGY_BATCH_POLICY=Object.freeze({version:'ONTOLOGY_PROPOSAL_BATCHES_V1',max_shapes:12,max_chars:24000,concurrency:4});
export function nativeOntologyConcurrency(parentRun,policy={}){
  const input=parentRun.state().input??{},parent=input.extraction_window_policy;
  const allowed=['WINDOWED_EXTRACTION_V1','HYBRID_EXTRACTION_V1'].includes(parent?.version)?parent.concurrency:1;
  need(Number.isSafeInteger(allowed)&&allowed>0&&allowed<=4,'NATIVE_ONTOLOGY_PARENT_CONCURRENCY_INVALID');
  const requested=policy.concurrency??NATIVE_ONTOLOGY_BATCH_POLICY.concurrency;
  need(Number.isSafeInteger(requested)&&requested>0&&requested<=4,'NATIVE_ONTOLOGY_CONCURRENCY_INVALID');
  return Math.min(allowed,requested,4);
}
function related(a,b){
  if(array(a.knowledge_refs).some(r=>array(b.knowledge_refs).includes(r)))return 4;
  const types=s=>[s.subject_type,s.object_type,s.owner_relation?.subject_type,s.owner_relation?.object_type,...(s.kind==='CLASS'?[s.label]:[])].filter(Boolean);
  return types(a).some(t=>types(b).includes(t))?1:0;
}
export function createNativeOntologyBatchPlan({shapes,identity,existingDefinitions,sourceBinding,policy={}}){
  const config={...NATIVE_ONTOLOGY_BATCH_POLICY,...policy};
  need(config.version===NATIVE_ONTOLOGY_BATCH_POLICY.version&&Number.isSafeInteger(config.max_shapes)&&config.max_shapes>0&&Number.isSafeInteger(config.max_chars)&&config.max_chars>=1024,'NATIVE_ONTOLOGY_BATCH_POLICY_INVALID');
  const snapshot={source:clone(sourceBinding),identity:clone(identity),prior_definitions:clone(existingDefinitions),shapes:clone(shapes)},snapshotSha=hash(snapshot);
  const pending=clone(shapes),batches=[];
  while(pending.length){
    const selected=[pending.shift()];
    while(selected.length<config.max_shapes&&pending.length){
      const candidates=pending.map((shape,index)=>({shape,index,score:selected.reduce((n,s)=>n+related(s,shape),0)})).filter(c=>JSON.stringify([...selected,c.shape]).length<=config.max_chars).sort((a,b)=>b.score-a.score||a.index-b.index);
      if(!candidates.length)break;
      selected.push(pending.splice(candidates[0].index,1)[0]);
    }
    // A single indivisible shape is never truncated. Its full examples remain in
    // the stage reader, which uses explicit JSON fragment/continue delivery.
    const bytes=JSON.stringify(selected).length;
    const batchRef='B'+(batches.length+1),types=new Set(selected.flatMap(s=>[s.subject_type,s.object_type,...(s.kind==='CLASS'?[s.label]:[])]).filter(Boolean));
    const necessary=[];for(const d of existingDefinitions.filter(d=>[d.name,d.key,...array(d.observed_labels)].some(n=>types.has(n)))){if(JSON.stringify([...necessary,d]).length>config.max_chars)break;necessary.push(d);}
    batches.push({batch_ref:batchRef,shape_refs:selected.map(s=>s.shape_ref),shapes:selected,initial_shapes:bytes<=config.max_chars?clone(selected):[],initial_read_required:bytes>config.max_chars,necessary_definitions:clone(necessary),snapshot_sha256:snapshotSha,input_sha256:hash({snapshot_sha256:snapshotSha,batch_ref:batchRef,shapes:selected})});
  }
  return {policy:config,snapshot,snapshot_sha256:snapshotSha,batches};
}
export async function runNativeOntologyBatchTasks({batches,concurrency,run,worker}){
  let cursor=0,failure=null;const results=new Array(batches.length);
  async function next(){while(!failure&&cursor<batches.length){const index=cursor++;try{run.assertOpen();results[index]=await worker(batches[index],index);}catch(error){failure??=error;}}}
  await Promise.all(Array.from({length:Math.min(concurrency,batches.length)},next));
  if(failure)throw failure;
  return results;
}
export function assertNativeOntologyStageResumable(stage,parentRun){
  const state=stage.snapshot(),ledger=parentRun.assertOpen(),attempts=array(ledger.attempts).filter(a=>a.agent_scope===stage.agentScope);
  need(!attempts.some(a=>['RESERVED','UNKNOWN'].includes(a.outcome)),'NATIVE_LIBRARY_STAGE_REQUEST_UNKNOWN');
  need(state.status!=='RUNNING'&&state.status!=='UNKNOWN'&&state.status!=='UNKNOWN_HOLD','NATIVE_LIBRARY_STAGE_RUNNING_UNKNOWN');
  need(state.finished?['SAVED','PARTIAL'].includes(state.status):state.status==='PENDING','NATIVE_LIBRARY_STAGE_NOT_RESUMABLE');
  return state;
}
