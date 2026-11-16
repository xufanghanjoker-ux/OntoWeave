/** Host closure after a normally ended native turn. Never interprets reasoning or repairs JSON. */
import {createHash} from 'node:crypto';
import {hash,clone,need} from './cq-discovery-store-v2.mjs';
import {hasDuplicateArgumentKeys} from './native-business-item-recovery-v1.mjs';
import {confirmedRegistryCalls} from './native-tool-call-recovery-v1.mjs';
export const SIMPLIFIED_COMPLETION='native_simplified_completion_v1';
export const SIMPLIFIED_LOCAL_FAILURES=new Set(['NATIVE_ROLE_OUTPUT_NOT_SAVED','NATIVE_ROLE_INCOMPLETE','NATIVE_LOCAL_NO_PROGRESS','NATIVE_TOOL_ARGUMENTS_JSON_INVALID','NATIVE_SIMPLIFIED_BLOCK_UNSETTLED']);
const signed=v=>({...v,record_sha256:hash(v)}),sha=s=>createHash('sha256').update(s).digest('hex');
export function completeSimplifiedNativeTurn({store,parentRun,local,window,snapshotId,context,decode=v=>v}){
 const runId=parentRun.state().run_id,scope=window.window_ref+':SOURCE_BLOCK',own=parentRun.state().attempts.filter(a=>a.agent_scope===scope),batches=store.listRecords('native_agent_delivered_tool_batch_v1').filter(b=>b.invocation_ref===context.invocation_ref);
 parentRun.assertOpen();local.host.assertCurrentRead();
 need(context.native_completion?.status==='completed'&&own.length>0&&own.every(a=>a.outcome==='RETURNED')&&hash(own.map(a=>a.request_ref))===hash(context.request_refs)&&batches.every(b=>context.request_refs.includes(b.request_ref)&&b.calls.every(c=>c.status==='COMPLETED')),'NATIVE_SIMPLIFIED_COMPLETION_UNSETTLED');
 return (async()=>{
  const imports=[];
  for(const attempt of own){
   const r=store.getRecord('native_agent_response_v1',attempt.request_ref);need(r?.complete_body&&r.http_status>=200&&r.http_status<300&&!r.redacted&&!r.redaction_error&&r.invocation_ref===context.invocation_ref&&sha(r.body_utf8)===r.body_sha256,'NATIVE_SIMPLIFIED_COMPLETION_RESPONSE_CHANGED');
   const parsed=confirmedRegistryCalls(Buffer.from(r.body_utf8)),last=parsed.frames.find(f=>f.event?.type==='response.completed').event.response;
   for(const [i,output]of(last.output??[]).entries()){
    if(output.type!=='message')continue;
    const parts=(output.content??[]).filter(p=>p.type==='output_text');if(!parts.length)continue;
    const text=parts.map(p=>p.text).join(''),json=text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i,'$1');
    let args;try{args=JSON.parse(json);}catch{continue;}
    if(!args||Array.isArray(args)||typeof args!=='object'||hasDuplicateArgumentKeys(json)||!['entities','facts','definitions','knowledge','items','candidates','statements','rules','source_statements'].some(k=>Array.isArray(args[k])))continue;
    const id='simplified_output_'+hash([local.stageRunId,attempt.request_ref,i]),prior=store.getRecord('native_simplified_output_reception_v1',id);
    if(prior){const {record_sha256,...body}=prior;need(record_sha256===hash(body)&&prior.raw_text_sha256===sha(text)&&['RECEIVED','ALREADY_SAVED'].includes(prior.status),'NATIVE_SIMPLIFIED_OUTPUT_RECEIPT_CHANGED');imports.push(id);continue;}
    const origin={run_id:runId,stage_run_id:local.stageRunId,window_ref:window.window_ref,source_snapshot_ref:snapshotId,invocation_ref:context.invocation_ref,request_ref:attempt.request_ref,response_sha256:r.body_sha256,output_index:i,raw_text:text,raw_text_sha256:sha(text),raw_arguments:clone(args)};
    store.putRecord('native_simplified_output_reception_v1',id,signed({...origin,status:'PREPARED'}));
    const decoded=decode(args),existing=store.listRecords('native_knowledge_proposal_v1').find(p=>p.run_id===local.stageRunId&&p.name==='SUBMIT'&&p.raw_hash===hash(decoded));
    if(existing){const receipt=store.getRecord('native_knowledge_receipt_v1',existing.proposal_ref);need(receipt?.saved===true,'NATIVE_SIMPLIFIED_SAVED_RECEIPT_CHANGED');store.putRecord('native_simplified_output_reception_v1',id,signed({...origin,status:'ALREADY_SAVED',receipt:clone(receipt)}));imports.push(id);continue;}
    const result=await local.tools.call('lightog_submit_extraction_batch',decoded,{invocation_ref:context.invocation_ref,tool_call_ref:id,program_output_reception_ref:id});
    need(result.ok===true&&result.result?.saved===true,'NATIVE_SIMPLIFIED_OUTPUT_RECEIVER_FAILED');
    store.putRecord('native_simplified_output_reception_v1',id,signed({...origin,status:'RECEIVED',receipt:clone(result)}));imports.push(id);
   }
  }
  const head=store.getRecord('native_knowledge_head_v1',local.stageRunId),knowledge=local.readKnowledge();
  if(!knowledge.length)return {partial:false,saved_output:false,classification:'NO_USABLE_BUSINESS_OUTPUT'};
  if(context.continuation_exhausted===false)return {partial:false,saved_output:false,saved_items:knowledge.length,agent_finish_received:false,reason:'SAVED_BATCHES_AWAIT_AGENT_FINISH'};
  const proposals=store.listRecords('native_knowledge_proposal_v1').filter(p=>p.run_id===local.stageRunId&&p.name==='SUBMIT'),covered=new Set(),pins=[];
  for(const p of proposals){const receipt=store.getRecord('native_knowledge_receipt_v1',p.proposal_ref);need(p.raw_hash===hash(p.raw)&&p.source_snapshot_ref===snapshotId&&receipt?.saved===true&&receipt.proposal_ref===p.proposal_ref,'NATIVE_SIMPLIFIED_SAVED_RECEIPT_CHANGED');for(const ref of receipt.knowledge_refs??[])covered.add(ref);pins.push({proposal_ref:p.proposal_ref,proposal_sha256:hash(p),receipt_sha256:hash(receipt)});}
  const inherited=store.getRecord('native_simplified_retained_window_v1',local.stageRunId);if(inherited){need(hash(inherited.entry)===inherited.entry_sha256,'NATIVE_SIMPLIFIED_RECOVERY_SEED_CHANGED');for(const row of inherited.entry.knowledge)covered.add(row.record_ref);}
  need(knowledge.every(k=>covered.has(k.record_ref)&&k.source_snapshot_ref===snapshotId),'NATIVE_SIMPLIFIED_SAVED_RECEIPT_CHANGED');
  const seal=signed({run_id:runId,stage_run_id:local.stageRunId,window_ref:window.window_ref,source_snapshot_ref:snapshotId,invocation_ref:context.invocation_ref,context:clone(context),head_sha256:hash(head),knowledge_sha256:hash(knowledge),saved_items:knowledge.length,proposal_pins:pins,output_reception_refs:imports,status:'PROGRAM_PARTIAL_SAVED',coverage_complete:false,agent_finish_received:false});
  store.putRecord(SIMPLIFIED_COMPLETION,local.stageRunId,seal);
  return {partial:true,saved_output:true,reason:imports.length?'COMPLETE_BUSINESS_OUTPUT_RECEIVED_LOCALLY':'SAVED_BATCHES_WITHOUT_FINISH',saved_items:knowledge.length,seal_sha256:seal.record_sha256};
 })();
}
