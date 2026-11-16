/** Narrow CQ list output. Existing Host owns identities, reads and atomic saves. */
import {createCQDiscoveryStore,hash,need,clone,textField,id} from './cq-discovery-store-v2.mjs';
export const CQ_LIST_VERSION='lightog-cq-list/1';
export const CQ_LIST_TOOLS=['lightog_read_cq_material','lightog_save_cq_list'];
const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
export const cqListDefinitions=()=>[
  {name:CQ_LIST_TOOLS[0],description:'读取本次唯一获准资料的正文。短资料一次完整返回；分页时使用实际next_cursor。Host管理来源版本和读取收据。',inputSchema:object({cursor:{type:'string',minLength:1}}),annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
  {name:CQ_LIST_TOOLS[1],description:'保存并完成本次CQ列表。每项只需question，可选source_hint/notes；ID、来源绑定与版本由Host管理。无需结束决策或修订协议。',inputSchema:object({items:{type:'array',maxItems:100,items:object({question:{type:'string',minLength:1,maxLength:1200},source_hint:{type:'string',minLength:1,maxLength:300},notes:{type:'string',minLength:1,maxLength:600}},['question'])}},['items']),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}}
];
const fields=(v,keys)=>need(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k)),'CQ_LIST_ARGUMENTS_INVALID');
export function createCQListOutput({store,host,catalog,taskId}) {
  const db=createCQDiscoveryStore(store),initial=host.task(taskId);need(initial.mode==='CQ_LIST_ONLY'&&initial.work_units.length===1,'CQ_LIST_TASK_REQUIRED');
  const unit=initial.work_units[0],load=()=>db.get('list_output',taskId);let done;
  const completion=new Promise(resolve=>{done=resolve;});
  db.transaction(()=>{if(!load())db.append('list_output',taskId,{version:CQ_LIST_VERSION,task_id:taskId,status:'OPEN',saved:false,items:[],reading:[]});});
  if(load().status!=='OPEN')done(load());
  function fail(reason) {
    return db.transaction(()=>{const s=load(),t=host.task(taskId);if(s.status==='STOPPED')return s;
      s.status='STOPPED';s.reason=t.status==='UNKNOWN_HOLD'?'UNKNOWN_HOLD':t.status==='CANCELLED'?'CANCELLED':t.status==='STALE'?'SOURCE_STALE':String(reason).slice(0,200);db.put('list_output',taskId,s);host.pause(taskId,s.reason);db.event(taskId,'CQ_LIST_STOPPED',{reason:s.reason,saved:s.saved});done(clone(s));return s;});
  }
  function current() {const t=host.task(taskId);need(!['CANCELLED','STALE','UNKNOWN_HOLD','FAILED'].includes(t.status),'CQ_LIST_'+t.status);need(load().status==='OPEN','CQ_LIST_NOT_OPEN');return t;}
  function document(t) {const doc=catalog.get(t.snapshot_id,t.library_id).documents.find(d=>d.doc_id===unit.doc_ids[0]);need(doc&&unit.doc_ids.length===1,'CQ_LIST_DOCUMENT_FORBIDDEN');return doc;}
  function read(args) {
    fields(args,['cursor']);const t=current(),d=document(t),binding=hash([t.snapshot_id,d.doc_id,d.revision]);let start=0;
    if(args.cursor){try{const c=JSON.parse(Buffer.from(args.cursor,'base64url').toString());need(c.binding===binding&&Number.isSafeInteger(c.start)&&c.start>=0&&c.start<d.content.length,'CQ_LIST_CURSOR_INVALID');start=c.start;}catch{need(false,'CQ_LIST_CURSOR_INVALID');}}
    let end=Math.min(d.content.length,start+12000);if(end<d.content.length&&/[\uDC00-\uDFFF]/.test(d.content[end])&&/[\uD800-\uDBFF]/.test(d.content[end-1]))end--;
    const next=end<d.content.length?Buffer.from(JSON.stringify({binding,start:end})).toString('base64url'):null;
    const units=d.blocks.filter(b=>b.end>start&&b.start<end).map(b=>({block_id:b.block_id,kind:b.kind,start:Math.max(start,b.start),end:Math.min(end,b.end),text:d.content.slice(Math.max(start,b.start),Math.min(end,b.end)),truncated:b.start<start||b.end>end}));
    const result=host.recordRead(taskId,unit.work_unit_id,'read',{snapshot_id:t.snapshot_id,doc_id:d.doc_id,revision:d.revision,cursor:args.cursor??null},{snapshot_id:t.snapshot_id,doc_id:d.doc_id,revision:d.revision,units,returned_chars:end-start,next_cursor:next,truncated:!!next,read_mode:'BOUNDED_VERBATIM_BODY',offset_unit:'utf16_code_unit'});
    db.transaction(()=>{const s=load();s.reading.push({receipt_id:result.receipt_id,start,end});db.put('list_output',taskId,s);});
    return {title:d.title,text:d.content.slice(start,end),complete:!next,next_cursor:next,returned_chars:end-start};
  }
  function save(args) {
    fields(args,['items']);need(Array.isArray(args.items)&&args.items.length<=100,'CQ_LIST_ITEMS_INVALID');
    for(const c of args.items){fields(c,['question','source_hint','notes']);need(textField(c.question)&&c.question.length<=1200,'CQ_LIST_QUESTION_INVALID');for(const [k,max]of [['source_hint',300],['notes',600]])if(c[k]!==undefined)need(textField(c[k])&&c[k].length<=max,'CQ_LIST_OPTION_INVALID');}
    const inputHash=hash(args),old=load();if(old.saved){need(old.input_hash===inputHash,'CQ_LIST_ALREADY_SAVED');return {saved:true,completed:true,count:old.items.length};}
    return db.transaction(()=>{
      const t=current(),d=document(t),reads=host.reads(taskId).filter(r=>r.work_unit_id===unit.work_unit_id&&r.body_returned);need(reads.length>0,'CQ_LIST_BODY_NOT_READ');
      const input={work_unit_id:unit.work_unit_id,stage:'CQ',input_snapshot_id:t.snapshot_id,upstream_artifact_refs:[],input_read_refs:reads.map(r=>r.receipt_id),expected_draft_revision:t.draft_revision,idempotency_key:'cq-list-'+inputHash,
        payload:{items:args.items.map((c,i)=>({local_key:'item_'+(i+1),question:c.question,origin:'DOCUMENT',source_hints:[{doc_id:d.doc_id,revision:d.revision}],...(c.notes?{notes:[c.notes]}:{})}))}};
      db.append('list_submission',hash([taskId,inputHash]),{task_id:taskId,model_input:clone(args),host_input:clone(input)});
      const receipt=host.submit(taskId,input);if(receipt.outcome!=='APPLIED')return {saved:false,reason:receipt.reason??'CQ_LIST_SAVE_REJECTED',receipt};
      host.finalize(taskId,host.task(taskId).draft_revision,'CQ_LIST_SAVED');const s=load();s.status='SAVED';s.saved=true;s.items=clone(args.items);s.input_hash=inputHash;s.receipt=receipt;db.put('list_output',taskId,s);db.event(taskId,'CQ_LIST_SAVED',{count:s.items.length,artifact_id:receipt.artifact_id});done(clone(s));return {saved:true,completed:true,count:s.items.length};
    });
  }
  return {names:CQ_LIST_TOOLS,completion,state:load,fail,async call(name,args={}) {try{need(CQ_LIST_TOOLS.includes(name),'CQ_LIST_TOOL_FORBIDDEN');const result=name===CQ_LIST_TOOLS[0]?read(args):save(args);if(name===CQ_LIST_TOOLS[1]&&!result.saved){fail(result.reason);return {ok:false,error:{code:result.reason,artifact_id:result.receipt.artifact_id}};}return {ok:true,result};}catch(error){const reason=error.code??'CQ_LIST_TOOL_FAILED';fail(reason);const rejection_id=id('list_rejection');db.append('list_rejection',rejection_id,{task_id:taskId,rejection_id,name,args:clone(args),reason});return {ok:false,error:{code:reason,rejection_id}};}}};
}
