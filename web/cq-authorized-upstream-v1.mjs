/** Prepared real transport. Construction itself requires a new explicit receipt.
 * No CLI entry invokes it and no credentials are loaded from disk/environment. */
import {hash,need,createCQDiscoveryStore} from './cq-discovery-store-v2.mjs';
import {createHash} from 'node:crypto';
export function createAuthorizedCQUpstream({store,host,taskId,plan,authorization,apiKey,fetchImpl=fetch}) {
  need(authorization?.status==='USER_CONFIRMED'&&typeof authorization.confirmation_ref==='string'&&authorization.confirmation_ref.trim()&&authorization.plan_hash===hash(plan),'CQ_NEW_AUTHORIZATION_REQUIRED');
  need(plan.model==='qwen3.8-flash'&&plan.destination==='https://cn-beijing.maas.qianwenaiapi.com/compatible-mode/v1/responses','CQ_DESTINATION_BINDING_INVALID');
  need(plan.task_id===taskId&&host.task(taskId).snapshot_id===plan.snapshot_id,'CQ_AUTHORIZED_TASK_MISMATCH');
  need(typeof apiKey==='string'&&apiKey.length>0,'CQ_CREDENTIAL_REQUIRED');
  const db=createCQDiscoveryStore(store);
  return async({body,signal,request_id})=>{
    db.transaction(()=>{
      const t=host.task(taskId),s=db.get('transport',taskId),a=s?.attempts.find(a=>a.request_id===request_id);
      need(t.status==='RUNNING'&&t.budget.max_requests===plan.max_requests&&t.requests.length<=plan.max_requests&&t.requests.some(r=>r.request_id===request_id&&r.outcome==='RESERVED'),'CQ_EXTERNAL_SEND_NOT_RESERVED');
      need(hash(s?.limits)===hash(plan.limits)&&s.status==='OPEN'&&a?.wire_sha256===createHash('sha256').update(body).digest('hex'),'CQ_AUTHORIZED_GATE_MISMATCH');
      need(!db.get('external_send',request_id),'CQ_EXTERNAL_SEND_ALREADY_DISPATCHED');
      db.append('external_send',request_id,{task_id:taskId,request_id,authorization_hash:hash(authorization),status:'SENT',destination:plan.destination,request_sha256:a.wire_sha256});
    });
    const response=await fetchImpl(plan.destination,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer '+apiKey,Accept:'text/event-stream'},body,signal});
    return {status:response.status,body:response.body,redact:value=>value.replaceAll(apiKey,'[REDACTED]')};
  };
}
