/** Business discovery loop. Decisions/receipts/checkpoints are distinct from turns. */
import {createCQDiscoveryStore,hash,id,clone,need,textField} from './cq-discovery-store-v2.mjs';
import {createCQTools} from './lightog-cq-tools-v1.mjs';
export const CQ_LOOP_VERSION='lightog-cq-agent-loop/1';
export const CQ_LOOP_TOOL_VERSION='lightog-cq-loop-tools/1';
export const CQ_LOOP_EXTRA_TOOLS=['lightog_get_cq_progress','lightog_record_cq_decision'];
const normalize=s=>s.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase();
const signature=c=>hash([normalize(c.knowledge_target),c.operation_hint??'']);
const fields=(a,allowed)=>need(a&&typeof a==='object'&&!Array.isArray(a)&&Object.keys(a).every(k=>allowed.includes(k)),'CQ_LOOP_FIELDS_INVALID');
const strings=a=>need(Array.isArray(a)&&a.every(textField),'CQ_LOOP_STRINGS_INVALID');
const lifecycle={CANCELLED:'CANCELLED',STALE:'SOURCE_STALE',UNKNOWN_HOLD:'UNKNOWN_HOLD',FAILED:'KNOWN_FAILURE'};
export function createCQAgentLoop({store,host,catalog,taskId,initialUnitId,toolSchemaHash=null,stopOnToolFailure,limits={max_rounds:12,max_turns:4,max_no_progress:2,max_repeated_reads:2,max_work_units:6}}) {
  const db=createCQDiscoveryStore(store),load=()=>db.get('agent_loop',taskId),save=s=>db.put('agent_loop',taskId,s);
  need(stopOnToolFailure===undefined||typeof stopOnToolFailure==='boolean','CQ_LOOP_FAILURE_POLICY_INVALID');
  fields(limits,['max_rounds','max_turns','max_no_progress','max_repeated_reads','max_work_units']);
  for(const value of Object.values(limits))need(Number.isSafeInteger(value)&&value>0,'CQ_LOOP_LIMIT_INVALID');
  need(['max_rounds','max_turns','max_no_progress','max_repeated_reads','max_work_units'].every(k=>Number.isSafeInteger(limits[k])),'CQ_LOOP_LIMIT_INVALID');
  const initial=host.task(taskId);need(initial.work_units.some(u=>u.work_unit_id===initialUnitId&&u.stage==='CQ'),'CQ_LOOP_UNIT_INVALID');
  db.transaction(()=>{
    const old=load();if(old){need(hash(old.limits)===hash(limits)&&old.tool_schema_sha256===toolSchemaHash,'CQ_LOOP_LIMIT_CHANGED');need(stopOnToolFailure===undefined||(old.stop_on_tool_failure??false)===stopOnToolFailure,'CQ_LOOP_FAILURE_POLICY_CHANGED');return;}
    const units=Object.fromEntries(initial.work_units.filter(u=>u.stage==='CQ').map(u=>[u.work_unit_id,{status:u.work_unit_id===initialUnitId?'RUNNING':'PENDING',checkpoints:0}]));
    const s={version:CQ_LOOP_VERSION,task_id:taskId,snapshot_id:initial.snapshot_id,limits:clone(limits),stop_on_tool_failure:stopOnToolFailure??false,status:'RUNNING',active_unit_id:initialUnitId,context_id:id('context'),units,
      role:'CQ_DISCOVERY_AND_COMPLETION',tool_version:CQ_LOOP_TOOL_VERSION,tool_schema_sha256:toolSchemaHash,round_count:1,turn_count:0,no_progress:0,read_keys:{},ranges:[],action:null,pending_dispatch:null,native_active:null,permit_id:null,closing_requests:0};save(s);
    db.append('discovery_round',taskId+':1',{round_id:id('discovery'),task_id:taskId,sequence:1,work_unit_id:initialUnitId,snapshot_id:initial.snapshot_id,start_draft_revision:initial.draft_revision,start_plan_revision:initial.plan_revision});
    db.event(taskId,'CQ_LOOP_STARTED',{version:CQ_LOOP_VERSION,limits});
  });
  function stop(s,reason,detail={}) {
    if(s.status==='STOPPED'&&s.stop_reason===reason)return;
    const t=host.task(taskId),end_id=id('loop_end');s.status='STOPPED';s.stop_reason=reason;s.action=null;save(s);
    db.append('loop_end',end_id,{end_id,task_id:taskId,work_unit_id:s.active_unit_id,reason,draft_revision:t.draft_revision,plan_revision:t.plan_revision,detail,remaining:host.remaining(taskId)});
    host.pause(taskId,reason);db.event(taskId,'CQ_LOOP_STOPPED',{reason,end_id});
  }
  function sync() {
    const t=host.task(taskId),s=load();
    if(lifecycle[t.status])db.transaction(()=>stop(s,lifecycle[t.status]));
    else if(t.reason==='BUDGET_LIMIT'||t.reason?.startsWith('CQ_GATE_'))db.transaction(()=>stop(s,'BUDGET_OR_TIME_LIMIT',{host_reason:t.reason}));
    return load();
  }
  function bound(binding,{write=false}={}) {
    const s=sync();need(binding.task_id===taskId&&binding.work_unit_id===s.active_unit_id&&binding.context_id===s.context_id,'CQ_LOOP_CONTEXT_STALE');
    if(write)need(s.status==='RUNNING','CQ_LOOP_NOT_RUNNING');return s;
  }
  const binding=()=>{const s=sync();return {task_id:taskId,work_unit_id:s.active_unit_id,context_id:s.context_id};};
  function progress(b,args={}) {
    const s=bound(b);fields(args,['cursor','limit']);const t=host.task(taskId),d=host.draft(taskId),limit=args.limit??20;need(Number.isSafeInteger(limit)&&limit>=1&&limit<=20,'CQ_LOOP_PAGE_INVALID');let offset=0;
    if(args.cursor){try{const c=JSON.parse(Buffer.from(args.cursor,'base64url').toString());need(c.revision===d.draft_revision&&Number.isSafeInteger(c.offset)&&c.offset>=0,'CQ_LOOP_CURSOR_STALE');offset=c.offset;}catch{need(false,'CQ_LOOP_CURSOR_STALE');}}
    const reads=host.reads(taskId).filter(r=>r.work_unit_id===b.work_unit_id),owners=new Map();
    for(const [unitId,artifactId] of Object.entries(t.current)){const a=host.artifacts(taskId).find(a=>a.artifact_id===artifactId);if(a?.input.stage==='CQ')for(const c of a.input.payload.items)owners.set('cq_'+hash([artifactId,c.local_key]).slice(0,32),unitId);}
    const view={version:CQ_LOOP_VERSION,tool_version:CQ_LOOP_TOOL_VERSION,snapshot_id:t.snapshot_id,draft_revision:d.draft_revision,plan_revision:t.plan_revision,loop_status:s.status,stop_reason:s.stop_reason??null,
      current_unit:{...clone(t.work_units.find(u=>u.work_unit_id===b.work_unit_id)),...s.units[b.work_unit_id]},
      cq_items:d.cq_items.slice(offset,offset+limit).map(c=>({cq_id:c.cq_id,work_unit_id:owners.get(c.cq_id),question:c.question.slice(0,800),knowledge_target:c.knowledge_target.slice(0,200),summary_truncated:c.question.length>800||c.knowledge_target.length>200,origin:c.origin,source_hints:c.source_hints.slice(0,2)})),
      next_cursor:offset+limit<d.cq_items.length?Buffer.from(JSON.stringify({revision:d.draft_revision,offset:offset+limit})).toString('base64url'):null,
      plan:t.work_units.filter(u=>u.stage==='CQ').slice(0,20).map(u=>({...u,...s.units[u.work_unit_id]})),plan_truncated:t.work_units.filter(u=>u.stage==='CQ').length>20,
      reading:reads.slice(0,20).map(r=>({receipt_id:r.receipt_id,operation:r.operation,doc_ids:r.doc_ids,body_returned:r.body_returned,next_cursor:r.result.next_cursor??null,returned_ranges:r.result.units?.map(u=>({block_id:u.block_id,start:u.start,end:u.end}))??[],hit_count:r.result.hits?.length??null})),reading_truncated:reads.length>20,
      action:clone(s.action),pending_dispatch:clone(s.pending_dispatch),recent_gap_decisions:db.list('loop_decision').filter(r=>r.task_id===taskId&&r.input.gap).slice(0,10).map(r=>({decision_id:r.decision_id,work_unit_id:r.work_unit_id,gap:r.input.gap,next_action:r.input.next_action,accepted:r.receipt.accepted,semantic_resolution:'NOT_CERTIFIED'})),remaining:{business_rounds:Math.max(0,s.limits.max_rounds-s.round_count),native_turns:Math.max(0,s.limits.max_turns-s.turn_count),requests:Math.max(0,t.budget.max_requests-t.requests.length),no_progress:Math.max(0,s.limits.max_no_progress-s.no_progress)},
      unit_artifact_id:t.current[b.work_unit_id]??null,knowledge_state:'DRAFT_NOT_VERIFIED',coverage:'SELECTIVE_READ_NOT_EXHAUSTIVE'};
    const view_id=id('progress');db.append('loop_progress_view',view_id,{view_id,task_id:taskId,work_unit_id:b.work_unit_id,draft_revision:d.draft_revision,plan_revision:t.plan_revision,unit_artifact_id:view.unit_artifact_id,returned_cq_ids:view.cq_items.map(c=>c.cq_id),cursor:args.cursor??null});return {...view,view_id};
  }
  function decision(b,input) {
    bound(b);fields(input,['expected_plan_revision','expected_draft_revision','idempotency_key','next_action','reason','gap','target','unresolved','stop_reason']);
    need(textField(input.idempotency_key)&&textField(input.reason)&&input.reason.length<=600,'CQ_LOOP_DECISION_INVALID');
    const actions=['READ','SEARCH','REVISE_CQ','REQUEST_WORK_UNIT','FINISH_UNIT','STOP_PARTIAL'];need(actions.includes(input.next_action),'CQ_LOOP_ACTION_INVALID');
    if(input.unresolved!==undefined)strings(input.unresolved);
    return db.transaction(()=>{
      const s=load(),t=host.task(taskId),key=hash([taskId,b.work_unit_id,input.idempotency_key]),old=db.get('loop_decision',key);
      if(old){if(old.input_hash!==hash(input)){db.event(taskId,'CQ_LOOP_DECISION_CONFLICT',{key,input});return {accepted:false,reason:'IDEMPOTENCY_CONFLICT'};}return clone(old.receipt);}
      need(s.status==='RUNNING','CQ_LOOP_NOT_RUNNING');need(input.expected_plan_revision===t.plan_revision&&input.expected_draft_revision===t.draft_revision,'CQ_LOOP_REVISION_CONFLICT');
      const action=input.next_action,continuing=['READ','SEARCH','REVISE_CQ','REQUEST_WORK_UNIT'].includes(action);
      if(continuing){fields(input.gap,['kind','description','expected_information','receipt_ids','cq_ids']);need(textField(input.gap.kind)&&textField(input.gap.description)&&textField(input.gap.expected_information),'CQ_LOOP_CONCRETE_GAP_REQUIRED');
        for(const k of ['kind','description','expected_information'])need(input.gap[k].length<=600,'CQ_LOOP_REASON_TOO_LONG');
        if(input.gap.receipt_ids){strings(input.gap.receipt_ids);need(input.gap.receipt_ids.every(k=>host.reads(taskId).some(r=>r.receipt_id===k)),'CQ_LOOP_RECEIPT_INVALID');}
        if(input.gap.cq_ids){strings(input.gap.cq_ids);need(input.gap.cq_ids.every(k=>host.draft(taskId).cq_items.some(c=>c.cq_id===k)),'CQ_LOOP_CQ_REF_INVALID');}
      }
      const decision_id=id('decision');let receipt={accepted:true,decision_id,next_action:action};
      if(continuing&&s.round_count>=s.limits.max_rounds){stop(s,'BUDGET_OR_TIME_LIMIT',{limit:'BUSINESS_ROUNDS'});receipt={accepted:false,decision_id,reason:'BUSINESS_ROUND_LIMIT'};}
      else if(action==='STOP_PARTIAL'){need(['SOURCE_LIMITATION','KNOWN_FAILURE','BUDGET_OR_TIME_LIMIT'].includes(input.stop_reason),'CQ_LOOP_STOP_REASON_INVALID');stop(s,input.stop_reason,{reason:input.reason,unresolved:input.unresolved??[]});}
      else if(action==='FINISH_UNIT') {
        need(s.units[b.work_unit_id].status!=='FINISHED','CQ_LOOP_UNIT_ALREADY_FINISHED');need(t.current[b.work_unit_id],'CQ_LOOP_CHECKPOINT_REQUIRED');need(!s.action||s.action.fulfilled,'CQ_LOOP_PENDING_ACTION');
        const unit=t.work_units.find(u=>u.work_unit_id===b.work_unit_id),reads=host.reads(taskId).filter(r=>r.work_unit_id===b.work_unit_id);
        need(unit.doc_ids.every(doc=>reads.some(r=>r.body_returned&&r.doc_ids.includes(doc))),'CQ_LOOP_BODY_NOT_READ');
        need(!reads.some(r=>r.operation==='read'&&r.result.next_cursor&&!reads.some(later=>later.operation==='read'&&later.args.cursor===r.result.next_cursor)),'CQ_LOOP_UNFINISHED_PAGE');
        const end_id=id('unit_end');s.units[b.work_unit_id]={...s.units[b.work_unit_id],status:'FINISHED',end_id,reason:'PLANNED_WORK_COMPLETE'};s.action=null;
        db.append('loop_end',end_id,{end_id,task_id:taskId,work_unit_id:b.work_unit_id,reason:'PLANNED_WORK_COMPLETE',draft_revision:t.draft_revision,plan_revision:t.plan_revision,reason_note:input.reason,unresolved:input.unresolved??[],read_receipt_ids:reads.map(r=>r.receipt_id)});
        s.status=t.work_units.filter(u=>u.stage==='CQ').every(u=>s.units[u.work_unit_id]?.status==='FINISHED')?'COMPLETED':'RUNNING';s.closing_requests=0;receipt={...receipt,end_id,unit_status:'FINISHED',loop_status:s.status};save(s);
      } else if(continuing) {
        need(!s.action||s.action.fulfilled,'CQ_LOOP_PENDING_ACTION');
        const target=input.target??{};fields(target,['doc_id','revision','block_ids','cursor','query','create_new']);
        const unit=t.work_units.find(u=>u.work_unit_id===b.work_unit_id),snapshot=catalog.get(t.snapshot_id,t.library_id);
        if(['READ','SEARCH'].includes(action)){
          need(s.units[b.work_unit_id].status!=='FINISHED','CQ_LOOP_UNIT_ALREADY_FINISHED');
          if(action==='READ')need(unit.doc_ids.includes(target.doc_id)&&snapshot.documents.some(d=>d.doc_id===target.doc_id&&d.revision===target.revision),'CQ_LOOP_READ_SCOPE_FORBIDDEN');
          else need(textField(target.query)&&target.query.length<=200,'CQ_LOOP_QUERY_INVALID');
        }
        if(action==='REQUEST_WORK_UNIT') {
          need(snapshot.documents.some(d=>d.doc_id===target.doc_id),'CQ_LOOP_WORK_SCOPE_FORBIDDEN');
          need(target.create_new===undefined||typeof target.create_new==='boolean','CQ_LOOP_TARGET_INVALID');
          let next=t.work_units.find(u=>u.stage==='CQ'&&u.work_unit_id!==b.work_unit_id&&u.doc_ids.includes(target.doc_id)&&s.units[u.work_unit_id]?.status!=='FINISHED');
          if(!next||target.create_new){need(t.work_units.filter(u=>u.stage==='CQ').length<s.limits.max_work_units,'CQ_LOOP_WORK_UNIT_LIMIT');
            const added=host.addDiscovery(taskId,{expected_plan_revision:t.plan_revision,doc_ids:[target.doc_id],reason:input.reason});need(added.accepted,'CQ_LOOP_PLAN_REJECTED');next=added.work_units.at(-1);s.units[next.work_unit_id]={status:'PENDING',checkpoints:0};}
          s.pending_dispatch={decision_id,from_unit_id:b.work_unit_id,to_unit_id:next.work_unit_id};s.status='HANDOFF_PENDING';s.closing_requests=0;
          if(s.units[b.work_unit_id].status!=='FINISHED')s.units[b.work_unit_id].status='PAUSED';receipt={...receipt,scheduled_unit:next,plan_revision:host.task(taskId).plan_revision,requires_known_turn_completion:true};
          db.append('loop_dispatch',decision_id,{task_id:taskId,...s.pending_dispatch,plan_revision:host.task(taskId).plan_revision});
        }
        s.round_count++;const round_id=id('discovery');s.action={decision_id,next_action:action,target:clone(target),fulfilled:false,round_id};
        db.append('discovery_round',taskId+':'+s.round_count,{round_id,task_id:taskId,sequence:s.round_count,work_unit_id:b.work_unit_id,snapshot_id:t.snapshot_id,start_draft_revision:t.draft_revision,start_plan_revision:t.plan_revision,decision_id,native_execution_id:s.native_active?.execution_id??null});save(s);
      }
      const latest=host.task(taskId);receipt={...receipt,draft_revision:latest.draft_revision,plan_revision:latest.plan_revision};db.append('loop_decision',key,{decision_id,task_id:taskId,work_unit_id:b.work_unit_id,input_hash:hash(input),input:clone(input),receipt});db.event(taskId,'CQ_LOOP_DECISION',{decision_id,action,accepted:receipt.accepted});return receipt;
    });
  }
  function observation(s,type,detail,progressMade) {
    s.no_progress=progressMade?0:s.no_progress+1;const observation_id=id('observation');db.append('loop_observation',observation_id,{observation_id,task_id:taskId,work_unit_id:s.active_unit_id,round_id:s.action?.round_id??null,type,progress:progressMade,detail});
    save(s);if(s.no_progress>=s.limits.max_no_progress)stop(s,'NO_PROGRESS_LIMIT',{observation_id});return observation_id;
  }
  function readAdmission(b,name,args) {
    const s=bound(b,{write:true});need(s.units[b.work_unit_id].status!=='FINISHED','CQ_LOOP_UNIT_ALREADY_FINISHED');
    const op=name==='lightog_read_document_units'?'READ':'SEARCH';
    if(s.units[b.work_unit_id].checkpoints){need(s.action?.next_action===op&&!s.action.fulfilled,'CQ_LOOP_DECISION_REQUIRED');const target=s.action.target;
      if(op==='READ')need(target.doc_id===args.doc_id&&target.revision===args.revision&&hash(target.block_ids??null)===hash(args.block_ids??null)&&hash(target.cursor??null)===hash(args.cursor??null),'CQ_LOOP_READ_TARGET_MISMATCH');
      else need(target.query===args.query,'CQ_LOOP_SEARCH_TARGET_MISMATCH');}
    const key=hash([b.work_unit_id,op,op==='READ'?[args.doc_id,args.revision,[...(args.block_ids??[])].sort(),args.cursor??null]:[normalize(args.query??''),args.cursor??null]]);
    if((s.read_keys[key]??0)>s.limits.max_repeated_reads){db.transaction(()=>stop(s,'NO_PROGRESS_LIMIT',{limit:'REPEATED_READS',key}));need(false,'CQ_LOOP_REPEATED_READ_LIMIT');}
    return key;
  }
  function readObserved(b,name,args,result,key) {return db.transaction(()=>{
    const s=load();s.read_keys[key]=(s.read_keys[key]??0)+1;
    const ranges=(result.units??result.hits??[]).map(u=>hash([u.doc_id??result.doc_id,u.revision??result.revision,u.block_id,u.start,u.end]));const isNew=ranges.some(k=>!s.ranges.includes(k));s.ranges=[...new Set([...s.ranges,...ranges])];
    if(isNew)s.units[b.work_unit_id].read_progress_since_checkpoint=true;
    if(s.action){s.action.fulfilled=true;s.action.receipt_id=result.receipt_id;}
    const observation_id=observation(s,result.hits?.length===0?'NO_NEW':isNew?'READ_NEW':'NO_NEW',{receipt_id:result.receipt_id,decision_id:s.action?.decision_id??null,zero_hits:result.hits?.length===0,absence_of_knowledge_certified:false},isNew);return {...result,observation_id,loop_status:load().status};
  });}
  function checkpoint(b,args) {
    const s=sync(),{revision_links=[],...input}=args;need(b.task_id===taskId&&host.task(taskId).work_units.some(u=>u.work_unit_id===b.work_unit_id&&u.stage==='CQ'),'CQ_LOOP_UNIT_INVALID');
    const before=host.draft(taskId),oldHead=before.unit_heads[b.work_unit_id],oldArtifact=host.artifacts(taskId).find(a=>a.artifact_id===oldHead),oldIds=(oldArtifact?.input.payload.items??[]).map(x=>'cq_'+hash([oldHead,x.local_key]).slice(0,32)),previous=before.cq_items.filter(c=>oldIds.includes(c.cq_id));
    let archiveReason=b.context_id!==s.context_id||b.work_unit_id!==s.active_unit_id?'CQ_LOOP_CONTEXT_STALE':s.status!=='RUNNING'?'CQ_LOOP_NOT_RUNNING':undefined;
    if(input.plan_change_request)archiveReason='CQ_LOOP_USE_WORK_UNIT_DECISION';
    if(!archiveReason&&s.units[b.work_unit_id].checkpoints&&(!s.action||s.action.next_action==='REQUEST_WORK_UNIT'||!s.action.fulfilled&&s.action.next_action!=='REVISE_CQ'))archiveReason='CQ_LOOP_DECISION_REQUIRED';
    const nextKeys=Array.isArray(input.payload?.items)?input.payload.items.map(x=>x?.local_key):[];try{need(Array.isArray(revision_links),'CQ_LOOP_LINEAGE_INVALID');for(const l of revision_links){fields(l,['from_cq_ids','to_local_keys','relation','reason']);strings(l.from_cq_ids);strings(l.to_local_keys);need(l.from_cq_ids.length>0&&l.from_cq_ids.every(k=>previous.some(c=>c.cq_id===k))&&l.to_local_keys.every(k=>nextKeys.includes(k))&&['SPLIT','REVISED','RETIRED','UNCHANGED'].includes(l.relation)&&textField(l.reason),'CQ_LOOP_LINEAGE_INVALID');need(l.relation==='RETIRED'?l.to_local_keys.length===0:l.to_local_keys.length>0,'CQ_LOOP_LINEAGE_INVALID');if(l.relation==='SPLIT')need(l.to_local_keys.length>=2,'CQ_LOOP_LINEAGE_INVALID');}}catch{archiveReason='CQ_LOOP_LINEAGE_INVALID';}
    return db.transaction(()=>{
      const receipt=host.submit(taskId,input,{archiveReason});const old=db.get('loop_checkpoint',receipt.artifact_id);if(old)return {...receipt,checkpoint_id:old.checkpoint_id,unit_status:load().units[b.work_unit_id].status};
      const checkpoint_id=id('checkpoint'),nowState=load(),after=host.draft(taskId),current=after.cq_items.filter(c=>c.cq_id.startsWith('cq_')&&Object.values(receipt.assigned_ids?.cq??{}).includes(c.cq_id));
      const links=revision_links.map(l=>({...l,to_cq_ids:l.to_local_keys.map(k=>receipt.assigned_ids?.cq?.[k]).filter(Boolean)}));
      for(const c of previous.filter(c=>!links.some(l=>l.from_cq_ids.includes(c.cq_id)))){const matches=current.filter(n=>signature(n)===signature(c));links.push({from_cq_ids:[c.cq_id],to_cq_ids:matches.map(n=>n.cq_id),relation:matches.length?(matches.some(n=>n.question===c.question)?'UNCHANGED':'REWORDED'):'RETIRED',reason:'Host lexical target/local projection mapping; semantic identity not certified.'});}
      const added=current.filter(c=>!previous.some(p=>signature(p)===signature(c)));const changed=added.length>0;
      const record={checkpoint_id,task_id:taskId,work_unit_id:b.work_unit_id,artifact_id:receipt.artifact_id,outcome:receipt.outcome,before_revision:before.draft_revision,after_revision:after.draft_revision,links,added_cq_ids:added.map(c=>c.cq_id),observation:changed?'ADDED_OR_REVISED':'NO_NEW',semantic_progress_certified:false,read_receipt_ids:input.input_read_refs??[]};db.append('loop_checkpoint',receipt.artifact_id,record);
      if(receipt.outcome==='APPLIED'){const readProgress=nowState.units[b.work_unit_id].read_progress_since_checkpoint;nowState.units[b.work_unit_id].checkpoints++;nowState.units[b.work_unit_id].latest_checkpoint_id=checkpoint_id;nowState.units[b.work_unit_id].read_progress_since_checkpoint=false;nowState.action=null;observation(nowState,record.observation,{checkpoint_id},changed||readProgress);}
      const currentTask=host.task(taskId);
      return {...receipt,checkpoint_id,checkpoint_saved:receipt.outcome==='APPLIED',unit_status:load().units[b.work_unit_id].status,unit_finished:false,loop_status:load().status,
        current_state:{draft_revision:currentTask.draft_revision,plan_revision:currentTask.plan_revision,cq_count:after.cq_items.length,unit_artifact_id:currentTask.current[b.work_unit_id]??null,action:clone(load().action)},
        checkpoint_delta:{before_revision:before.draft_revision,after_revision:after.draft_revision,added_cq_ids:record.added_cq_ids,revision_links:record.links.filter(l=>l.relation!=='UNCHANGED'),unchanged_count:record.links.filter(l=>l.relation==='UNCHANGED').length,semantic_progress_certified:false}};
    });
  }
  function toolsFor(b) {
    const base=createCQTools({host,catalog,taskId,workUnitId:b.work_unit_id,allowedStages:['CQ'],allowFinalize:false});
    function checked(name,response) {
      const rejected=response.ok===false||name==='lightog_submit_cq_stage'&&response.result?.outcome!=='APPLIED'||name==='lightog_record_cq_decision'&&response.result?.accepted!==true;
      if(!load().stop_on_tool_failure||!rejected)return response;
      db.transaction(()=>{
        const s=sync(),failure_id=id('tool_failure'),reason=response.error?.code??response.result?.reason??'CQ_TOOL_RESULT_REJECTED';
        db.append('loop_tool_failure',failure_id,{failure_id,task_id:taskId,work_unit_id:b.work_unit_id,tool:name,reason,artifact_id:response.result?.artifact_id??null,policy:'STOP_ON_TOOL_FAILURE'});
        // Lifecycle/unknown/budget stops keep priority. Never revive a stopped task.
        if(s.status==='RUNNING')stop(s,'KNOWN_FAILURE',{failure_id,tool:name,reason,artifact_id:response.result?.artifact_id??null});
      });
      return {...response,loop_status:load().status,stop_reason:load().stop_reason,...(response.result?{result:{...response.result,loop_status:load().status,stop_reason:load().stop_reason}}:{})};
    }
    return {names:[...base.names,...CQ_LOOP_EXTRA_TOOLS],async call(name,args={}) {try {
      if(name==='lightog_get_cq_progress')return checked(name,{ok:true,result:progress(b,args)});
      if(name==='lightog_record_cq_decision')return checked(name,{ok:true,result:decision(b,args)});
      if(name==='lightog_submit_cq_stage'){need(args.work_unit_id===b.work_unit_id&&args.stage==='CQ','CQ_LOOP_SUBMIT_SCOPE_INVALID');return checked(name,{ok:true,result:checkpoint(b,args)});}
      bound(b,{write:true});let key;if(['lightog_read_document_units','lightog_search_documents'].includes(name))key=readAdmission(b,name,args);
      const response=await base.call(name,args);if(response.ok&&key)response.result=readObserved(b,name,args,response.result,key);return checked(name,response);
    }catch(error){const rejection_id=id('loop_rejection');db.append('loop_rejection',rejection_id,{rejection_id,task_id:taskId,work_unit_id:b.work_unit_id,context_id:b.context_id,tool:name,args:clone(args),reason:error.code??'CQ_LOOP_TOOL_FAILED'});return checked(name,{ok:false,error:{code:error.code??'CQ_LOOP_TOOL_FAILED',rejection_id}});}}};
  }
  function beginNative(permitId) {sync();return db.transaction(()=>{
    const s=load(),t=host.task(taskId);need(!lifecycle[t.status]&&['RUNNING','AWAITING_CONTINUATION'].includes(s.status),'CQ_LOOP_NATIVE_BLOCKED');
    if(permitId){need(s.permit_id===permitId&&s.status==='AWAITING_CONTINUATION','CQ_LOOP_PERMIT_INVALID');host.claimContinuation(taskId,permitId);const p=db.get('turn_permit',permitId);s.active_unit_id=p.work_unit_id;s.context_id=id('context');s.units[p.work_unit_id].status='RUNNING';if(s.action?.next_action==='REQUEST_WORK_UNIT')s.action=null;s.pending_dispatch=null;s.status='RUNNING';s.closing_requests=0;s.permit_id=null;}
    else need(!s.native_active&&!t.runtime_handle,'CQ_LOOP_NO_AUTOMATIC_REPLAY');
    if(s.turn_count>=s.limits.max_turns){stop(s,'BUDGET_OR_TIME_LIMIT',{limit:'NATIVE_TURNS'});return null;}
    const execution_id=id('execution');s.turn_count++;s.native_active={execution_id,status:'STARTING',work_unit_id:s.active_unit_id,permit_id:permitId??null};save(s);
    db.append('loop_native_start',execution_id,{execution_id,task_id:taskId,work_unit_id:s.active_unit_id,sequence:s.turn_count,snapshot_id:s.snapshot_id,start_draft_revision:t.draft_revision,start_plan_revision:t.plan_revision,request_start_index:t.requests.length,previous_handle:t.runtime_handle??null,permit_id:permitId??null});return {execution_id,binding:binding(),permit_id:permitId??null,previous_handle:t.runtime_handle??null};
  });}
  function nativeBound(executionId,handle){return db.transaction(()=>{const s=load();need(s.native_active?.execution_id===executionId,'CQ_LOOP_NATIVE_INVALID');s.native_active={...s.native_active,status:'RUNNING',handle};save(s);db.append('loop_native_binding',executionId,{execution_id:executionId,task_id:taskId,handle});});}
  function endNative(executionId,handle,terminal) {sync();return db.transaction(()=>{
    const s=load();need(s.native_active?.execution_id===executionId,'CQ_LOOP_NATIVE_INVALID');const status=terminal?.params?.turn?.status??'unknown';
    const start=db.get('loop_native_start',executionId),end={task_id:taskId,execution_id:executionId,handle,status,request_ids:host.task(taskId).requests.slice(start.request_start_index).map(r=>r.request_id)};db.append('loop_native_end',executionId,end);s.native_active={...s.native_active,status};save(s);
    if(['CANCELLED','STALE'].includes(host.task(taskId).status))return null;
    if(status==='unknown'){host.holdUnknown(taskId,'CQ_NATIVE_COMPLETION_UNKNOWN');stop(s,'UNKNOWN_HOLD');return null;}
    if(['STOPPED','COMPLETED'].includes(s.status))return null;
    if(status!=='completed'){stop(s,'KNOWN_FAILURE',{native_status:status});return null;}
    const next=s.pending_dispatch?.to_unit_id??(s.action?s.active_unit_id:null);
    if(!next){stop(s,'KNOWN_FAILURE',{reason:'MISSING_EXPLICIT_BUSINESS_DECISION'});return null;}
    const t=host.task(taskId);if(s.turn_count>=s.limits.max_turns||t.requests.length>=t.budget.max_requests){stop(s,'BUDGET_OR_TIME_LIMIT');return null;}
    const permit_id=id('permit');db.append('turn_permit',permit_id,{permit_id,task_id:taskId,previous_turn_id:handle.turn_id,previous_execution_id:executionId,work_unit_id:next,snapshot_id:s.snapshot_id,decision_id:s.pending_dispatch?.decision_id??s.action.decision_id});s.permit_id=permit_id;s.status='AWAITING_CONTINUATION';save(s);db.event(taskId,'CQ_LOOP_CONTINUATION_GRANTED',{permit_id,work_unit_id:next});return permit_id;
  });}
  return {binding,progress,decision,checkpoint,toolsFor,beginNative,nativeBound,endNative,state:sync,stop:(reason,detail)=>db.transaction(()=>stop(load(),reason,detail)),
    records:()=>Object.fromEntries(['discovery_round','loop_decision','loop_checkpoint','loop_observation','loop_end','loop_dispatch','loop_progress_view','loop_rejection','loop_tool_failure','loop_native_start','loop_native_binding','loop_native_end','turn_permit','turn_permit_use'].map(k=>[k,db.list(k).filter(r=>r.task_id===taskId)]))};
}
