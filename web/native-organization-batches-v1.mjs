import {clone,hash,need} from './cq-discovery-store-v2.mjs';

export const ORGANIZATION_BATCH_POLICY=Object.freeze({version:'ORGANIZATION_CONTEXT_BATCHES_V1',max_items:6,max_chars:12000});
/** Scheduling only. Preserve source order and indivisible items; never infer identity or semantic equivalence. */
export function planNativeOrganizationBatches(p,{policy=ORGANIZATION_BATCH_POLICY}={}){
 need(hash(policy)===hash(ORGANIZATION_BATCH_POLICY)&&Array.isArray(p.items)&&new Set(p.items.map(i=>i.semantic_ref)).size===p.items.length,'NATIVE_ORGANIZATION_BATCH_INPUT_INVALID');
 const groups=[];let items=[],chars=0;
 for(const item of p.items){const size=JSON.stringify(item).length;if(items.length&&(items.length>=policy.max_items||chars+size>policy.max_chars)){groups.push(items);items=[];chars=0;}items.push(item.semantic_ref);chars+=size;}
 if(items.length)groups.push(items);
 const batches=groups.map((semantic_refs,index)=>({batch_ref:'B'+(index+1),semantic_refs,oversized_item:semantic_refs.length===1&&JSON.stringify(p.items.find(i=>i.semantic_ref===semantic_refs[0])).length>policy.max_chars}));
 const body={policy:clone(policy),package_ref:p.package_ref,package_sha256:p.record_sha256??hash(p),input_sha256:hash(p),batches};return {...body,plan_sha256:hash(body)};
}

/** Persist one independent context per batch. Incomplete/unknown calls are never replayed. */
export function createNativeOrganizationBatchJournal({store,stageRunId,plan,sourceBinding}){
 const KIND='native_organization_batch_v1',PLAN='native_organization_batch_plan_v1',binding=hash([plan,sourceBinding]),old=store.getRecord(PLAN,stageRunId);
 need(!old||old.binding===binding,'NATIVE_ORGANIZATION_BATCH_BINDING_CHANGED');if(!old)store.putRecord(PLAN,stageRunId,{stage_run_id:stageRunId,binding,plan:clone(plan)});
 const key=ref=>stageRunId+':'+ref;
 function state(batch){return store.getRecord(KIND,key(batch.batch_ref));}
 function start(batch,agentScope){const prior=state(batch);need(!prior||prior.status==='PENDING','NATIVE_ORGANIZATION_BATCH_INTERRUPTED_NO_REPLAY');const row={stage_run_id:stageRunId,binding,batch_ref:batch.batch_ref,semantic_refs:clone(batch.semantic_refs),agent_scope:agentScope,status:'RUNNING'};store.putRecord(KIND,key(batch.batch_ref),row);return row;}
 function finish(batch,receipt,knowledgeSha,gaps=[],savedRecords=[]){const prior=state(batch);need(prior?.status==='RUNNING'&&receipt?.outcome==='RETURNED'&&['SUCCEEDED','PARTIAL'].includes(receipt.status),'NATIVE_ORGANIZATION_BATCH_UNSETTLED');const row={...prior,status:receipt.status==='PARTIAL'?'PARTIAL_SAVED_SETTLED':'SAVED_SETTLED',receipt:clone(receipt),knowledge_sha256:knowledgeSha,saved_records:savedRecords.map(record=>({record_ref:record.record_ref,record_sha256:hash(record)})),gaps:clone(gaps)};store.putRecord(KIND,key(batch.batch_ref),row);return row;}
 return {state,start,finish,snapshot:()=>plan.batches.map(state).filter(Boolean)};
}
