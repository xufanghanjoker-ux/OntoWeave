/** Durable business receipts. A committed save is separate from actor/run completion. */
import {hash,clone,need} from './cq-discovery-store-v2.mjs';
export const AGENT_LIFECYCLE='native_agent_save_finish_v1';
const queues=new WeakMap();
export function bindAgentSaveFinish({store,runId,role,scope=null,tools,profile,assertCurrent}){
 need(['SINGLE_COMMIT','APPEND_UNTIL_FINISH'].includes(profile.mode),'NATIVE_LIFECYCLE_PROFILE_INVALID');
 need(typeof assertCurrent==='function','NATIVE_LIFECYCLE_GUARD_REQUIRED');
 const id=hash({run_id:runId,role,scope}),binding=hash(profile);
 let map=queues.get(store);if(!map)queues.set(store,map=new Map());
 const load=()=>{const s=store.getRecord(AGENT_LIFECYCLE,id);if(s){const {record_sha256,...body}=s;need(record_sha256===hash(body)&&s.binding===binding,'NATIVE_LIFECYCLE_BINDING_CHANGED');}return s??{version:1,run_id:runId,role,scope,binding,status:'OPEN',operations:[],diagnostics:[]};};
 const write=s=>{const {record_sha256,...body}=s;return store.putRecord(AGENT_LIFECYCLE,id,{...body,record_sha256:hash(body)});};
 const denied=(s,name,args,reason)=>{s.diagnostics.push({name,args:clone(args),reason,at:Date.now()});write(s);return {ok:true,result:{accepted:false,saved:false,lifecycle:{status:s.status,reason,original_receipt:s.operations.find(o=>o.status==='COMMITTED')?.receipt??null}}};};
 async function dispatch(name,args,ctx){
  assertCurrent();const s=load(),finish=(profile.finish??[]).includes(name),save=(profile.save??[]).includes(name);
  if(!save&&!finish)return tools.call(name,args,ctx);
  const key=hash({name,args}),prior=s.operations.find(o=>o.key===key);
  if(prior?.status==='COMMITTED'){if(tools.reconcileLifecycle){const confirmed=tools.reconcileLifecycle({name,args:clone(args),context:clone(prior.context)});need(confirmed&&hash(confirmed)===hash(prior.receipt),'NATIVE_LIFECYCLE_COMMITTED_OUTPUT_CHANGED');}return clone(prior.receipt);}
  if(prior){const recovered=tools.reconcileLifecycle?.({name,args:clone(args),context:clone(prior.context)});if(recovered){prior.status='COMMITTED';prior.receipt=clone(recovered);prior.reconciled_at=Date.now();s.status=finish?'FINISHED':profile.mode==='SINGLE_COMMIT'?'COMMITTED':'OPEN';write(s);return clone(recovered);}return denied(s,name,args,'INTERRUPTED_COMMIT_REQUIRES_RECONCILIATION');}
  if(s.status==='FINISHED'||s.status==='COMMITTED'&&profile.mode==='SINGLE_COMMIT')return denied(s,name,args,'LATE_CONFLICT_PRESERVED');
  const operation={key,name,args:clone(args),context:clone(ctx??{}),status:'PREPARED',at:Date.now()};s.operations.push(operation);write(s);
  let receipt;try{receipt=await tools.call(name,args,ctx);}catch(error){operation.status='UNCONFIRMED';operation.error_code=error.code??'NATIVE_LIFECYCLE_INTERRUPTED';write(s);const recovered=tools.reconcileLifecycle?.({name,args:clone(args),context:clone(ctx)});if(!recovered)throw error;receipt=recovered;}
  if(receipt?.ok===false||receipt?.result?.accepted===false){s.operations=s.operations.filter(o=>o.key!==key);write(s);return receipt;}
  operation.status='COMMITTED';operation.receipt=clone(receipt);operation.committed_at=Date.now();
  if(finish)s.status='FINISHED';else if(profile.mode==='SINGLE_COMMIT')s.status='COMMITTED';write(s);return receipt;
 }
 return {...tools,lifecycleProfile:clone(profile),assertLifecycleCurrent:assertCurrent,call(name,args={},ctx={}){const before=map.get(id)??Promise.resolve();const job=before.catch(()=>{}).then(()=>dispatch(name,args,ctx));map.set(id,job);return job.finally(()=>{if(map.get(id)===job)map.delete(id);});}};
}
