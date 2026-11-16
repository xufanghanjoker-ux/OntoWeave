/** Source-bound planning records. Semantic planning belongs to the native Skill. */
import {hash,clone,need,textField} from './cq-discovery-store-v2.mjs';

const str={type:'string',minLength:1,maxLength:4000};
const refs={type:'array',items:str,uniqueItems:true,maxItems:512};
export const NATIVE_SOURCE_REF_SCHEMA={type:'object',additionalProperties:false,required:['doc_ref','revision'],properties:{doc_ref:str,revision:str}};
export const NATIVE_COVERAGE_SCHEMA={type:'array',maxItems:512,items:{type:'object',additionalProperties:false,required:['task_ref','status','reason','candidate_refs'],properties:{task_ref:str,status:{enum:['UNASSESSED','PARTIAL','COMPLETE','SOURCE_INSUFFICIENT','CONFLICTED']},reason:str,candidate_refs:refs}}};
export const NATIVE_SCOPE_SCHEMA={type:'object',additionalProperties:false,required:['subjects','tasks','cq_dispositions'],properties:{
 expected_scope_revision:{type:['string','null'],description:'首次保存可省略或传null；空字符串按null处理。已有范围时，若提供此字段，必须填写当前真实scope_revision，不能用空值覆盖。'},
 subjects:{type:'array',maxItems:512,items:{type:'object',additionalProperties:false,required:['local_ref','surface','evidence_ref'],properties:{local_ref:str,surface:str,evidence_ref:str,occurrence:{type:'integer',minimum:0}}}},
 tasks:{type:'array',maxItems:1024,items:{type:'object',additionalProperties:false,required:['local_ref','cq_refs','scope_kind','requirement','conditions','source_refs'],properties:{local_ref:str,cq_refs:refs,family_ref:{type:['string','null']},scope_kind:{enum:['SUBJECT','MODULE_OR_DOCUMENT']},subject_local_ref:{type:['string','null']},module:{type:['string','null'],maxLength:2000},requirement:str,conditions:{type:'array',items:str,maxItems:128},source_refs:{type:'array',items:NATIVE_SOURCE_REF_SCHEMA,maxItems:128}}}},
 cq_dispositions:{type:'array',maxItems:1024,items:{type:'object',additionalProperties:false,required:['cq_ref','status','task_local_refs','reason'],properties:{cq_ref:str,status:{enum:['TASKS','PENDING_DISCOVERY','SOURCE_INSUFFICIENT','NOT_APPLICABLE','UNRESOLVED']},task_local_refs:refs,reason:str}}}
}};
export const NATIVE_SCOPE_CONTRACTS=Object.freeze({LEGACY_V1:'LEGACY_V1',TASK_CQ_REFS_V1:'TASK_CQ_REFS_V1'});
export const NATIVE_SCOPE_TASK_CQ_REFS_SCHEMA=clone(NATIVE_SCOPE_SCHEMA);
NATIVE_SCOPE_TASK_CQ_REFS_SCHEMA.required=['subjects','tasks','unplanned_cqs'];
delete NATIVE_SCOPE_TASK_CQ_REFS_SCHEMA.properties.cq_dispositions;
NATIVE_SCOPE_TASK_CQ_REFS_SCHEMA.properties.tasks.items.properties.cq_refs.description='本任务实际关联的原CQ引用，这是唯一的任务归属声明；Host确定性生成反向TASKS dispositions，不另填cq_dispositions。同一CQ可关联多个实际任务。';
NATIVE_SCOPE_TASK_CQ_REFS_SCHEMA.properties.unplanned_cqs={type:'array',maxItems:1024,description:'逐项声明未关联任何任务的原CQ；须覆盖所有未规划CQ，与tasks[].cq_refs互斥，不遗漏、不重复。已规划全部原CQ时填空数组。OUT_OF_SCOPE仅指本轮范围不适用，不证明资料不足。',items:{type:'object',additionalProperties:false,required:['cq_ref','status','reason'],properties:{cq_ref:str,status:{enum:['UNRESOLVED','OUT_OF_SCOPE']},reason:str}}};
export function nativeScopeSchemaFor(scopeContract='LEGACY_V1'){need(Object.values(NATIVE_SCOPE_CONTRACTS).includes(scopeContract),'NATIVE_SCOPE_CONTRACT_INVALID');return clone(scopeContract==='TASK_CQ_REFS_V1'?NATIVE_SCOPE_TASK_CQ_REFS_SCHEMA:NATIVE_SCOPE_SCHEMA);}
const shape=(v,keys,required=[])=>need(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k))&&required.every(k=>Object.hasOwn(v,k)),'NATIVE_SCOPE_SHAPE_INVALID');
const texts=(v,max=1024)=>need(Array.isArray(v)&&v.length<=max&&v.every(textField),'NATIVE_SCOPE_TEXTS_INVALID');
const unique=(v,code)=>need(new Set(v).size===v.length,code);
const immutable=(store,kind,id,value)=>{const old=store.getRecord(kind,id);if(old)need(hash(old)===hash(value),'NATIVE_SCOPE_IMMUTABLE_CONFLICT');else store.putRecord(kind,id,clone(value));return clone(value);};

export function createNativeScopePlan({store,catalog,libraryId,snapshotId,cqInput,families,runId,assertOpen=()=>{},scopeContract='LEGACY_V1'}) {
 need(textField(runId)&&textField(cqInput?.input_ref)&&Array.isArray(cqInput.items),'NATIVE_SCOPE_INPUT_INVALID');
 unique(cqInput.items.map(i=>i.cq_ref),'NATIVE_SCOPE_CQ_DUPLICATE');
 const binding=hash({runId,libraryId,snapshotId,cqInput,families}),schema=nativeScopeSchemaFor(scopeContract),contractKind='native_scope_contract_v1';
 const contractBody={run_id:runId,source_snapshot_ref:snapshotId,binding,scope_save_contract:scopeContract};
 const hasHistory=()=>['native_build_state_v1','native_scope_head_v1','native_scope_scan_v1','native_coverage_head_v1','native_extraction_head_v1'].some(kind=>store.getRecord(kind,runId)),existingContract=store.getRecord(contractKind,runId);
 if(existingContract)need(hash(existingContract)===hash(contractBody),'NATIVE_SCOPE_CONTRACT_CHANGED');
 else if(hasHistory())need(scopeContract==='LEGACY_V1','NATIVE_SCOPE_CONTRACT_CHANGED');
 else store.transaction(()=>{const concurrent=store.getRecord(contractKind,runId);if(concurrent)need(hash(concurrent)===hash(contractBody),'NATIVE_SCOPE_CONTRACT_CHANGED');else if(hasHistory())need(scopeContract==='LEGACY_V1','NATIVE_SCOPE_CONTRACT_CHANGED');else immutable(store,contractKind,runId,contractBody);});
 const pinned=!!store.getRecord(contractKind,runId);
 const assertContract=()=>{const actual=store.getRecord(contractKind,runId);need(pinned?actual&&hash(actual)===hash(contractBody):!actual,'NATIVE_SCOPE_CONTRACT_CHANGED');};
 const source=()=>{assertContract();assertOpen();need(catalog.isCurrent(snapshotId,libraryId),'NATIVE_SOURCE_STALE');return catalog.get(snapshotId,libraryId);};
 const checkRefs=rows=>{need(Array.isArray(rows),'NATIVE_SCOPE_SOURCES_INVALID');const docs=source().documents;for(const r of rows){shape(r,['doc_ref','revision'],['doc_ref','revision']);need(docs.some(d=>d.doc_id===r.doc_ref&&d.revision===r.revision),'NATIVE_SCOPE_SOURCE_FORBIDDEN');}};
 const head=()=>store.getRecord('native_scope_head_v1',runId);
 const current=()=>{assertContract();const h=head();if(!h)return null;need(h.binding===binding,'NATIVE_SCOPE_BINDING_CHANGED');const r=store.getRecord('native_scope_revision_v1',h.scope_revision);need(r&&hash(r)===h.content_sha256,'NATIVE_SCOPE_RECORD_CHANGED');return r;};
 const readEvidence=ref=>{const ev=store.getRecord('native_evidence_v1',ref);need(ev&&ev.run_id===runId&&ev.source_snapshot_ref===snapshotId,'NATIVE_SCOPE_EVIDENCE_FORBIDDEN');const {record_sha256,...body}=ev;need(record_sha256===hash(body),'NATIVE_SCOPE_EVIDENCE_CHANGED');const d=source().documents.find(d=>d.doc_id===ev.doc_ref&&d.revision===ev.revision);need(d&&Number.isSafeInteger(ev.start)&&Number.isSafeInteger(ev.end)&&ev.start>=0&&ev.end>ev.start&&d.content.slice(ev.start,ev.end)===ev.quote,'NATIVE_SCOPE_EVIDENCE_CHANGED');return ev;};
 function savePlan(args) {
  source();scan();shape(args,Object.keys(schema.properties),schema.required);
  need(Array.isArray(args.subjects)&&args.subjects.length<=512&&Array.isArray(args.tasks)&&args.tasks.length<=1024&&Array.isArray(scopeContract==='LEGACY_V1'?args.cq_dispositions:args.unplanned_cqs),'NATIVE_SCOPE_COLLECTION_INVALID');
  const old=current(),expectedScopeRevision=args.expected_scope_revision===''?null:(args.expected_scope_revision??null);if(Object.hasOwn(args,'expected_scope_revision'))need(expectedScopeRevision===(old?.scope_revision??null),'NATIVE_SCOPE_CAS_CONFLICT');
  const subjectMap=new Map(),subjects=args.subjects.map(s=>{
   shape(s,['local_ref','surface','evidence_ref','occurrence'],['local_ref','surface','evidence_ref']);need(textField(s.local_ref)&&textField(s.surface),'NATIVE_SCOPE_SUBJECT_INVALID');need(!subjectMap.has(s.local_ref),'NATIVE_SCOPE_SUBJECT_DUPLICATE');
   const ev=readEvidence(s.evidence_ref),positions=[];let at=0;while((at=ev.quote.indexOf(s.surface,at))>=0){positions.push(at);at+=Math.max(1,s.surface.length);}
   if(!positions.length)throw Object.assign(Error('NATIVE_SCOPE_SURFACE_NOT_FOUND'),{code:'NATIVE_SCOPE_SURFACE_NOT_FOUND',status:409,subject_local_ref:s.local_ref,surface:s.surface,source_evidence_ref:s.evidence_ref,occurrences:[],evidence_location:{evidence_ref:ev.evidence_ref,doc_ref:ev.doc_ref,revision:ev.revision,window_ref:ev.window_ref,unit_ref:ev.unit_ref,quote:ev.quote,start:ev.start,end:ev.end,offset_unit:'utf16_code_unit'}});if(s.occurrence===undefined&&positions.length>1)throw Object.assign(Error('NATIVE_SCOPE_MENTION_AMBIGUOUS'),{code:'NATIVE_SCOPE_MENTION_AMBIGUOUS',status:409,subject_local_ref:s.local_ref,surface:s.surface,source_evidence_ref:s.evidence_ref,occurrences:positions.map((start,occurrence)=>({occurrence,start:ev.start+start,end:ev.start+start+s.surface.length,offset_unit:'utf16_code_unit'}))});const n=s.occurrence??0;need(Number.isSafeInteger(n)&&n>=0&&n<positions.length,'NATIVE_SCOPE_OCCURRENCE_INVALID');
   const subject={subject_ref:'subject_'+hash([runId,s.evidence_ref,s.surface,n]),local_ref:s.local_ref,surface:s.surface,evidence_refs:[s.evidence_ref],source_refs:[{doc_ref:ev.doc_ref,revision:ev.revision}],start:ev.start+positions[n],end:ev.start+positions[n]+s.surface.length,identity_status:'SOURCE_LOCAL_MENTION'};subjectMap.set(s.local_ref,subject);return subject;
  });
  const cqRefs=new Set(cqInput.items.map(i=>i.cq_ref)),familyRefs=new Set((families?.families??[]).map(f=>f.family_ref).filter(textField));
  const taskMap=new Map(),tasks=args.tasks.map(t=>{
   shape(t,['local_ref','cq_refs','family_ref','scope_kind','subject_local_ref','module','requirement','conditions','source_refs'],['local_ref','cq_refs','scope_kind','requirement','conditions','source_refs']);
   need(textField(t.local_ref)&&!taskMap.has(t.local_ref)&&textField(t.requirement),'NATIVE_SCOPE_TASK_INVALID');texts(t.cq_refs);unique(t.cq_refs,'NATIVE_SCOPE_CQ_DUPLICATE');need(t.cq_refs.length&&t.cq_refs.every(q=>cqRefs.has(q)),'NATIVE_SCOPE_CQ_FORBIDDEN');texts(t.conditions,128);checkRefs(t.source_refs);
   need(!t.family_ref||familyRefs.has(t.family_ref),'NATIVE_SCOPE_FAMILY_FORBIDDEN');need(['SUBJECT','MODULE_OR_DOCUMENT'].includes(t.scope_kind),'NATIVE_SCOPE_KIND_INVALID');
   need(t.scope_kind==='SUBJECT'?subjectMap.has(t.subject_local_ref):textField(t.module),'NATIVE_SCOPE_TARGET_REQUIRED');
   const task={...clone(t),task_ref:'task_'+hash([runId,cqInput.input_ref,t]),input_ref:cqInput.input_ref,subject_ref:t.scope_kind==='SUBJECT'?subjectMap.get(t.subject_local_ref).subject_ref:null,status:'PLANNED',coverage_status:'UNASSESSED'};taskMap.set(t.local_ref,task);return task;
  });
  const bindingIssues=[],seen=new Set();let dispositions;
  if(scopeContract==='TASK_CQ_REFS_V1'){
   const planned=new Map(cqInput.items.map(i=>[i.cq_ref,tasks.filter(t=>t.cq_refs.includes(i.cq_ref))])),unplanned=new Map();
   need(args.unplanned_cqs.length<=1024,'NATIVE_SCOPE_COLLECTION_INVALID');
   for(const d of args.unplanned_cqs){shape(d,['cq_ref','status','reason'],['cq_ref','status','reason']);need(cqRefs.has(d.cq_ref)&&!unplanned.has(d.cq_ref),'NATIVE_SCOPE_CQ_DISPOSITION_INVALID');need(['UNRESOLVED','OUT_OF_SCOPE'].includes(d.status)&&textField(d.reason),'NATIVE_SCOPE_DISPOSITION_INVALID');need(planned.get(d.cq_ref).length===0,'NATIVE_SCOPE_CQ_UNPLANNED_OVERLAP');unplanned.set(d.cq_ref,d);}
   need([...planned].every(([q,linked])=>linked.length>0||unplanned.has(q)),'NATIVE_SCOPE_CQ_DISPOSITION_MISSING');
   dispositions=cqInput.items.map(({cq_ref})=>{const linked=planned.get(cq_ref);if(linked.length)return {cq_ref,status:'TASKS',task_local_refs:linked.map(t=>t.local_ref),reason:'由tasks[].cq_refs确定性派生本轮任务归属；不表示事实支持或整题覆盖完成。',input_ref:cqInput.input_ref,task_refs:linked.map(t=>t.task_ref)};const d=unplanned.get(cq_ref);return {cq_ref,status:d.status==='OUT_OF_SCOPE'?'NOT_APPLICABLE':'UNRESOLVED',task_local_refs:[],reason:d.reason,input_ref:cqInput.input_ref,task_refs:[]};});
  }else dispositions=args.cq_dispositions.map((d,index)=>{
   shape(d,['cq_ref','status','task_local_refs','reason'],['cq_ref','status','task_local_refs','reason']);need(cqRefs.has(d.cq_ref)&&!seen.has(d.cq_ref),'NATIVE_SCOPE_CQ_DISPOSITION_INVALID');seen.add(d.cq_ref);texts(d.task_local_refs);unique(d.task_local_refs,'NATIVE_SCOPE_TASK_DUPLICATE');need(textField(d.reason)&&NATIVE_SCOPE_SCHEMA.properties.cq_dispositions.items.properties.status.enum.includes(d.status),'NATIVE_SCOPE_DISPOSITION_INVALID');
   need(d.task_local_refs.every(r=>taskMap.has(r)),'NATIVE_SCOPE_DISPOSITION_TASK_FORBIDDEN');
   const linked=tasks.filter(t=>t.cq_refs.includes(d.cq_ref)).map(t=>t.local_ref).sort();if(hash(linked)!==hash([...d.task_local_refs].sort())||!(d.status==='TASKS'?d.task_local_refs.length>0:d.task_local_refs.length===0))bindingIssues.push({path:'/cq_dispositions/'+index,cq_ref:d.cq_ref,declared_status:d.status,declared_task_local_refs:clone(d.task_local_refs),tasks_declaring_cq:linked,reason:'BIDIRECTIONAL_CQ_BINDING_MISMATCH'});
   if(d.status==='SOURCE_INSUFFICIENT')need(scan().discovery_status==='SCAN_COMPLETE','NATIVE_SCOPE_UNREAD_NOT_INSUFFICIENT');
   return {...clone(d),input_ref:cqInput.input_ref,task_refs:d.task_local_refs.map(r=>taskMap.get(r).task_ref)};
  });
  if(scopeContract==='LEGACY_V1')need(seen.size===cqRefs.size,'NATIVE_SCOPE_CQ_DISPOSITION_MISSING');
  if(bindingIssues.length)throw Object.assign(Error('NATIVE_SCOPE_CQ_BINDINGS_INVALID'),{code:'NATIVE_SCOPE_CQ_BINDINGS_INVALID',issues:bindingIssues});
  const payload={run_id:runId,source_snapshot_ref:snapshotId,input_ref:cqInput.input_ref,binding,subjects,tasks,cq_dispositions:dispositions};const scope_revision='scope_'+hash(payload),row={scope_revision,...payload};
  return store.transaction(()=>{need((head()?.scope_revision??null)===(old?.scope_revision??null),'NATIVE_SCOPE_CAS_CONFLICT');immutable(store,'native_scope_revision_v1',scope_revision,row);store.putRecord('native_scope_head_v1',runId,{binding,scope_revision,content_sha256:hash(row)});return clone(row);});
 }
 function scan() {
  assertContract();
  const docs=catalog.get(snapshotId,libraryId).documents,ledger=store.getRecord('native_scope_scan_v1',runId);if(ledger)need(ledger.binding===binding,'NATIVE_SCOPE_BINDING_CHANGED');
  const receipts=(ledger?.read_receipt_refs??[]).map(ref=>{const r=store.getRecord('native_read_receipt_v1',ref);need(r&&r.run_id===runId&&r.source_snapshot_ref===snapshotId,'NATIVE_SCOPE_READ_FORBIDDEN');const {record_sha256,...body}=r;need(record_sha256===hash(body),'NATIVE_SCOPE_READ_CHANGED');return r;});
  const units=docs.flatMap(d=>d.blocks.map(b=>({doc_ref:d.doc_id,revision:d.revision,block_id:b.block_id,start:b.start,end:b.end})));
  const spans=receipts.flatMap(r=>r.source_spans??r.units??[]);
  const covered=(u)=>{const ranges=spans.filter(s=>s.doc_ref===u.doc_ref&&s.revision===u.revision&&s.end>u.start&&s.start<u.end).sort((a,b)=>a.start-b.start);let end=u.start;for(const r of ranges){if(r.start>end)break;end=Math.max(end,r.end);}return end>=u.end;};
  const read=units.filter(covered),unread=units.filter(u=>!covered(u));return {discovery_status:unread.length===0?'SCAN_COMPLETE':spans.length?'PARTIAL':'NOT_STARTED',expected_units:units.length,read_units:read.length,unread_units:unread,read_receipt_refs:clone(ledger?.read_receipt_refs??[])};
 }
 function recordReads(refs) {source();texts(refs);for(const ref of refs){const r=store.getRecord('native_read_receipt_v1',ref);need(r&&r.run_id===runId&&(r.source_snapshot_ref??r.snapshot_id)===snapshotId,'NATIVE_SCOPE_READ_FORBIDDEN');}store.transaction(()=>{const old=store.getRecord('native_scope_scan_v1',runId);if(old)need(old.binding===binding,'NATIVE_SCOPE_BINDING_CHANGED');store.putRecord('native_scope_scan_v1',runId,{run_id:runId,binding,read_receipt_refs:[...new Set([...(old?.read_receipt_refs??[]),...refs])]});});return scan();}
 function setCoverage(rows) {source();const plan=current();need(plan&&Array.isArray(rows),'NATIVE_SCOPE_REQUIRED');const seen=new Set();for(const r of rows){shape(r,['task_ref','status','reason','candidate_refs'],['task_ref','status','reason','candidate_refs']);need(plan.tasks.some(t=>t.task_ref===r.task_ref)&&!seen.has(r.task_ref)&&NATIVE_COVERAGE_SCHEMA.items.properties.status.enum.includes(r.status)&&textField(r.reason),'NATIVE_COVERAGE_INVALID');seen.add(r.task_ref);texts(r.candidate_refs);if(['COMPLETE','SOURCE_INSUFFICIENT'].includes(r.status))need(scan().discovery_status==='SCAN_COMPLETE','NATIVE_COVERAGE_SCAN_INCOMPLETE');}
  const merged=new Map(snapshot().coverage.map(row=>[row.task_ref,row]));for(const row of rows)merged.set(row.task_ref,clone(row));const all=plan.tasks.map(t=>merged.get(t.task_ref));const value={run_id:runId,scope_revision:plan.scope_revision,rows:all},ref='coverage_'+hash(value);immutable(store,'native_coverage_revision_v1',ref,value);store.putRecord('native_coverage_head_v1',runId,{coverage_revision:ref});return clone(all);
 }
 function snapshot(){const plan=current(),c=store.getRecord('native_coverage_head_v1',runId),coverage=c?store.getRecord('native_coverage_revision_v1',c.coverage_revision):null;return {...(plan??{scope_revision:null,subjects:[],tasks:[],cq_dispositions:[]}),...scan(),coverage:coverage&&plan&&coverage.scope_revision===plan.scope_revision?clone(coverage.rows):(plan?.tasks??[]).map(t=>({task_ref:t.task_ref,status:'UNASSESSED',reason:'尚未评估整题覆盖',candidate_refs:[]}))};}
 return {savePlan,recordReads,setCoverage,snapshot};
}
