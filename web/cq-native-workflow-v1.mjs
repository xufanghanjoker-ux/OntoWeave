/** Native Agent owns discovery and grouping; Host owns source binding and durable output. */
import {createCQDiscoveryStore,hash,need,clone,textField,id} from './cq-discovery-store-v2.mjs';
import {cqListDefinitions,CQ_LIST_TOOLS} from './cq-list-output-v1.mjs';
import {CQ_FAMILY_TOOL,cqFamilyDefinitions,validateCQFamilies} from './cq-family-output-v1.mjs';

export const CQ_NATIVE_SKILLS=['lightog-cq-discovery','lightog-cq-family-normalization'];
const VERSION='lightog-cq-native-workflow/1';
const TOOLS=[...CQ_LIST_TOOLS,CQ_FAMILY_TOOL];
const OPEN=['OPEN','CQ_SAVED'];
const BLOCKED=['CANCELLED','STALE','UNKNOWN_HOLD','FAILED','SUCCEEDED'];
const fields=(value,keys)=>need(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k)),'CQ_LIST_ARGUMENTS_INVALID');

export function cqNativeWorkflowDefinitions() {
  const definitions=cqListDefinitions();
  definitions[1].description='保存本次CQ原稿，返回后续归族所需的input_ref及Q01等成员编号。此为中间结果；继续基于实际保存列表归族并调用lightog_save_cq_families后才完成任务。每项question，可选source_hint/notes；Host管理来源绑定与版本。';
  return [...definitions,...cqFamilyDefinitions()];
}

export function createCQNativeWorkflow({store,host,catalog,taskId,workUnitId}) {
  const db=createCQDiscoveryStore(store),initial=host.task(taskId);
  need(initial.mode==='CQ_LIST_ONLY'&&initial.work_units.length===1,'CQ_NATIVE_SINGLE_CQ_TASK_REQUIRED');
  const unit=initial.work_units.find(u=>u.work_unit_id===(workUnitId??initial.work_units[0].work_unit_id));
  need(unit?.stage==='CQ'&&unit.doc_ids.length===1,'CQ_NATIVE_WORK_UNIT_INVALID');
  const load=()=>db.get('native_workflow',taskId);
  let resolveCompletion;
  const completion=new Promise(resolve=>{resolveCompletion=resolve;});
  db.transaction(()=>{
    if(!load())db.append('native_workflow',taskId,{version:VERSION,task_id:taskId,work_unit_id:unit.work_unit_id,snapshot_id:initial.snapshot_id,status:'OPEN',cq_original:null,cq_input_ref:null,cq_items:[],families:null,reading:[]});
    const s=load();need(s.version===VERSION&&s.work_unit_id===unit.work_unit_id&&s.snapshot_id===initial.snapshot_id,'CQ_NATIVE_WORKFLOW_BINDING_INVALID');
  });
  if(!OPEN.includes(load().status))resolveCompletion(clone(load()));
  const snapshot=()=>clone(load());
  const isComplete=()=>load().status==='COMPLETE';
  const isOpen=()=>OPEN.includes(load().status)&&!BLOCKED.includes(host.task(taskId).status);

  // Completion is historical output: shutdown errors cannot erase a committed result.
  function fail(reason) {
    return db.transaction(()=>{
      const s=load();if(s.status==='COMPLETE')return clone(s);
      const t=host.task(taskId),boundReason={UNKNOWN_HOLD:'UNKNOWN_HOLD',CANCELLED:'CANCELLED',STALE:'SOURCE_STALE',FAILED:t.reason??'CQ_NATIVE_HOST_FAILED'}[t.status];
      const nextReason=boundReason??(s.status==='STOPPED'?s.reason:String(reason).slice(0,200));
      if(s.status!=='STOPPED'||s.reason!==nextReason){
        s.status='STOPPED';s.reason=nextReason;db.put('native_workflow',taskId,s);host.pause(taskId,s.reason);
        db.event(taskId,'CQ_NATIVE_STOPPED',{reason:s.reason,cq_saved:s.cq_original!==null,families_saved:s.families!==null});
      }
      resolveCompletion(clone(s));return clone(s);
    });
  }
  function current() {
    const t=host.task(taskId);need(!BLOCKED.includes(t.status),'CQ_NATIVE_'+t.status);
    need(OPEN.includes(load().status),'CQ_NATIVE_NOT_OPEN');return t;
  }
  function document(t) {
    const d=catalog.get(t.snapshot_id,t.library_id).documents.find(d=>d.doc_id===unit.doc_ids[0]);
    need(d,'CQ_NATIVE_DOCUMENT_FORBIDDEN');return d;
  }
  function read(args) {
    fields(args,['cursor']);if(Object.hasOwn(args,'cursor'))need(textField(args.cursor),'CQ_LIST_CURSOR_INVALID');
    const t=current(),d=document(t),binding=hash([t.snapshot_id,d.doc_id,d.revision]);let start=0;
    if(args.cursor){try{const cursor=JSON.parse(Buffer.from(args.cursor,'base64url').toString());need(cursor.binding===binding&&Number.isSafeInteger(cursor.start)&&cursor.start>=0&&cursor.start<d.content.length,'CQ_LIST_CURSOR_INVALID');start=cursor.start;}catch{need(false,'CQ_LIST_CURSOR_INVALID');}}
    let end=Math.min(d.content.length,start+12000);
    if(end<d.content.length&&/[\uDC00-\uDFFF]/.test(d.content[end])&&/[\uD800-\uDBFF]/.test(d.content[end-1]))end--;
    const next=end<d.content.length?Buffer.from(JSON.stringify({binding,start:end})).toString('base64url'):null;
    const units=d.blocks.filter(b=>b.end>start&&b.start<end).map(b=>({block_id:b.block_id,kind:b.kind,start:Math.max(start,b.start),end:Math.min(end,b.end),text:d.content.slice(Math.max(start,b.start),Math.min(end,b.end)),truncated:b.start<start||b.end>end}));
    const receipt=host.recordRead(taskId,unit.work_unit_id,'read',{snapshot_id:t.snapshot_id,doc_id:d.doc_id,revision:d.revision,cursor:args.cursor??null},{snapshot_id:t.snapshot_id,doc_id:d.doc_id,revision:d.revision,units,returned_chars:end-start,next_cursor:next,truncated:!!next,read_mode:'BOUNDED_VERBATIM_BODY',offset_unit:'utf16_code_unit'});
    db.transaction(()=>{const s=load();s.reading.push({receipt_id:receipt.receipt_id,start,end});db.put('native_workflow',taskId,s);});
    return {title:d.title,text:d.content.slice(start,end),complete:!next,next_cursor:next,returned_chars:end-start};
  }
  const cqReceipt=s=>({saved:true,completed:s.status==='COMPLETE',input_ref:s.cq_input_ref,count:s.cq_items.length,items:clone(s.cq_items)});
  function saveCQ(args) {
    fields(args,['items']);need(Array.isArray(args.items)&&args.items.length<=100,'CQ_LIST_ITEMS_INVALID');
    for(const item of args.items){fields(item,['question','source_hint','notes']);need(textField(item.question)&&item.question.length<=1200,'CQ_LIST_QUESTION_INVALID');for(const [key,max]of [['source_hint',300],['notes',600]])if(Object.hasOwn(item,key))need(textField(item[key])&&item[key].length<=max,'CQ_LIST_OPTION_INVALID');}
    const inputHash=hash(args),old=load();
    if(old.cq_original!==null&&old.status!=='STOPPED'){
      if(old.status!=='COMPLETE')current();need(old.cq_input_hash===inputHash,'CQ_LIST_ALREADY_SAVED');return cqReceipt(old);
    }
    return db.transaction(()=>{
      const t=current(),d=document(t),reads=host.reads(taskId).filter(r=>r.work_unit_id===unit.work_unit_id&&r.body_returned);
      need(reads.length>0,'CQ_LIST_BODY_NOT_READ');
      const input={work_unit_id:unit.work_unit_id,stage:'CQ',input_snapshot_id:t.snapshot_id,upstream_artifact_refs:[],input_read_refs:reads.map(r=>r.receipt_id),expected_draft_revision:t.draft_revision,idempotency_key:'cq-native-'+inputHash,payload:{items:args.items.map((item,i)=>({local_key:'item_'+(i+1),question:item.question,origin:'DOCUMENT',source_hints:[{doc_id:d.doc_id,revision:d.revision}],...(item.notes?{notes:[item.notes]}:{})}))}};
      db.append('native_cq_submission',hash([taskId,inputHash]),{task_id:taskId,model_input:clone(args),host_input:clone(input)});
      const receipt=host.submit(taskId,input);
      // A known Host rejection must commit its ARCHIVED artifact before stopping.
      if(receipt.outcome!=='APPLIED')return {saved:false,reason:receipt.reason??'CQ_NATIVE_CQ_SAVE_REJECTED',receipt};
      const s=load();s.status='CQ_SAVED';s.cq_original=clone(args.items);s.cq_input_hash=inputHash;s.cq_input_ref='cq_input_'+hash([taskId,t.snapshot_id,receipt.artifact_id,inputHash]);
      s.cq_items=args.items.map((item,i)=>({cq_ref:'Q'+String(i+1).padStart(2,'0'),...clone(item)}));s.cq_receipt=receipt;
      db.append('native_cq_input',s.cq_input_ref,{task_id:taskId,input_ref:s.cq_input_ref,snapshot_id:t.snapshot_id,artifact_id:receipt.artifact_id,items:s.cq_items});
      db.put('native_workflow',taskId,s);db.event(taskId,'CQ_NATIVE_CQ_SAVED',{count:s.cq_items.length,input_ref:s.cq_input_ref,artifact_id:receipt.artifact_id});return cqReceipt(s);
    });
  }
  const familyReceipt=s=>({saved:true,completed:s.status==='COMPLETE',input_ref:s.cq_input_ref,count:s.families.families.length,unassigned_count:s.families.unassigned.length});
  function saveFamilies(args) {
    const old=load();
    if(old.status!=='COMPLETE')current();need(old.cq_original!==null,'CQ_NATIVE_CQ_REQUIRED');
    const families=validateCQFamilies({inputRef:old.cq_input_ref,cqRefs:old.cq_items.map(item=>item.cq_ref),args}),inputHash=hash(families);
    if(old.families!==null){need(old.family_input_hash===inputHash,'CQ_NATIVE_FAMILIES_ALREADY_SAVED');return familyReceipt(old);}
    return db.transaction(()=>{
      const t=current(),s=load();
      need(t.current[unit.work_unit_id]===s.cq_receipt.artifact_id,'CQ_NATIVE_CQ_ARTIFACT_CHANGED');
      s.families=clone(families);s.family_input_hash=inputHash;
      db.append('native_family_submission',hash([taskId,inputHash]),{task_id:taskId,input_ref:s.cq_input_ref,model_input:families});
      db.put('native_workflow',taskId,s);
      const finalized=host.finalize(taskId,t.draft_revision,'CQ_NATIVE_WORKFLOW_SAVED');
      if(finalized.task.status!=='SUCCEEDED')return {...familyReceipt(s),reason:finalized.task.reason??'CQ_NATIVE_FINALIZE_INCOMPLETE'};
      s.status='COMPLETE';db.put('native_workflow',taskId,s);db.event(taskId,'CQ_NATIVE_COMPLETED',{input_ref:s.cq_input_ref,cq_count:s.cq_items.length,family_count:families.families.length,unassigned_count:families.unassigned.length});
      resolveCompletion(clone(s));return familyReceipt(s);
    });
  }
  return {names:[...TOOLS],isComplete,isOpen,fail,completion,snapshot,async call(name,args={}) {
    try {
      need(TOOLS.includes(name),'CQ_NATIVE_TOOL_FORBIDDEN');
      const result=name===TOOLS[0]?read(args):name===TOOLS[1]?saveCQ(args):saveFamilies(args);
      if(result.saved===false||name===CQ_FAMILY_TOOL&&!result.completed){
        fail(result.reason);return {ok:false,error:{code:result.reason,...(result.receipt?.artifact_id?{artifact_id:result.receipt.artifact_id}:{})}};
      }
      return {ok:true,result};
    }catch(error){
      const reason=error.code??'CQ_NATIVE_TOOL_FAILED';fail(reason);const rejection_id=id('native_rejection');
      db.append('native_rejection',rejection_id,{task_id:taskId,rejection_id,name,args:clone(args),reason});return {ok:false,error:{code:reason,rejection_id}};
    }
  }};
}
