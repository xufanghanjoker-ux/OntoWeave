/** Business authority for CQ drafts. No provider calls or graph writes here. */
import {createCQDiscoveryStore, hash, id, need, clone, textField} from './cq-discovery-store-v2.mjs';
export const CQ_CONTRACT='lightog_cq_stage_v1';
const fields=(v,keys)=>need(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k)),'CQ_FIELDS_INVALID');
const array=v=>need(Array.isArray(v),'CQ_ARRAY_REQUIRED');
const strings=v=>{array(v);need(v.every(textField),'CQ_STRINGS_INVALID');};
const required=(v,keys)=>keys.forEach(k=>need(textField(v[k]),'CQ_FIELD_REQUIRED'));
const unique=v=>need(new Set(v).size===v.length,'CQ_DUPLICATE_REFERENCE');
const exact=(a,b)=>a.length===b.length&&a.every(x=>b.includes(x));
const readonlyStates=['CANCELLED','STALE'];
const stageKeys={CQ:['items','open_questions'],FAMILY:['families','unassigned_cq_ids','open_questions'],SCOPE:['subject_candidates','scope_candidates','unresolved_family_ids','open_questions']};
const itemFields=['local_key','source_hints','notes'];

export function createCQDiscoveryHost({store,catalog,now=()=>Date.now()}) {
  const db=createCQDiscoveryStore(store);
  const save=t=>db.put('task',t.task_id,t);
  const getTask=taskId=>{const t=db.get('task',taskId);need(t,'CQ_TASK_NOT_FOUND');return t;};
  const rawDraft=t=>db.get('draft',t.draft_id+':'+t.draft_revision);
  function event(t,type,detail={}) {db.event(t.task_id,type,detail);}
  function status(t,next,reason) {if(t.status!==next){event(t,next,{previous:t.status,reason});t.status=next;}if(reason)t.reason=reason;save(t);}
  function refresh(t) {
    if(t.status!=='STALE'&&!catalog.isCurrent(t.snapshot_id,t.library_id)) {
      status(t,'STALE','SOURCE_SNAPSHOT_NOT_CURRENT');
      const head=db.get('head',t.library_id);if(head?.task_id===t.task_id)db.put('head',t.library_id,{...head,validity:'STALE'});
    }
    return t;
  }
  function task(taskId) {return db.transaction(()=>clone(refresh(getTask(taskId))));}
  function draft(taskId,revision) {
    const t=task(taskId),d=db.get('draft',t.draft_id+':'+(revision??t.draft_revision));need(d,'CQ_DRAFT_NOT_FOUND');
    return {...d,validity:t.status==='STALE'?'STALE':d.validity};
  }
  function create({library_id,request_id,expected_source_epoch,purpose='',seed_questions=[],cq_list_only=false,budget={max_requests:0,max_input_tokens:0,max_output_tokens:0,max_concurrency:1,max_duration_ms:60000}}) {
    need(textField(library_id)&&textField(request_id)&&request_id.length<=200&&typeof purpose==='string'&&Number.isSafeInteger(expected_source_epoch),'CQ_CREATE_INVALID');strings(seed_questions);
    fields(budget,['max_requests','max_input_tokens','max_output_tokens','max_concurrency','max_duration_ms']);
    for(const k of ['max_requests','max_input_tokens','max_output_tokens','max_concurrency','max_duration_ms'])need(Number.isSafeInteger(budget[k])&&budget[k]>=0,'CQ_BUDGET_INVALID');
    need(budget.max_concurrency>0&&budget.max_duration_ms>0,'CQ_BUDGET_INVALID');
    need(typeof cq_list_only==='boolean','CQ_MODE_INVALID');
    const requestHash=hash({library_id,expected_source_epoch,purpose,seed_questions,budget,...(cq_list_only?{cq_list_only:true}:{})}),requestKey=hash([library_id,request_id]);
    return db.transaction(()=>{
      const previous=db.get('request',requestKey);
      if(previous){if(previous.request_hash!==requestHash){db.event(previous.task_id,'REQUEST_CONFLICT',{request_id});return {outcome:'REQUEST_CONFLICT',task_id:previous.task_id};}return clone(refresh(getTask(previous.task_id)));}
      need(!db.list('task').some(t=>t.library_id===library_id&&(t.status==='UNKNOWN_HOLD'||t.requests.some(r=>['RESERVED','UNKNOWN'].includes(r.outcome)))),'CQ_LIBRARY_UNKNOWN_OR_INFLIGHT_HOLD');
      const s=catalog.freeze(library_id,expected_source_epoch),task_id=id('cqtask'),draft_id=id('cqdraft');
      // One selective discovery unit per document. Agent cannot delete this plan.
      const cqUnits=s.documents.map(d=>({work_unit_id:id('work'),stage:'CQ',doc_ids:[d.doc_id],depends_on:[],read_policy:'SELECTIVE_BODY'}));
      const family={work_unit_id:id('work'),stage:'FAMILY',doc_ids:s.documents.map(d=>d.doc_id),depends_on:cqUnits.map(u=>u.work_unit_id)};
      const scope={work_unit_id:id('work'),stage:'SCOPE',doc_ids:family.doc_ids,depends_on:[...family.depends_on,family.work_unit_id]};
      const t={task_id,library_id,request_id,request_hash:requestHash,snapshot_id:s.snapshot_id,source_epoch:s.source_epoch,
        draft_id,draft_revision:0,status:'QUEUED',plan_revision:1,work_units:cq_list_only?cqUnits:[...cqUnits,family,scope],current:{},...(cq_list_only?{mode:'CQ_LIST_ONLY'}:{}),
        runtime_binding:{port:'lightog_agent_runtime_v1',kind:'OFFLINE_ONLY',model:'qwen3.8-flash',skill_version:'NOT_INSTALLED',contract:CQ_CONTRACT},
        purpose,seed_questions:clone(seed_questions),budget:clone(budget),requests:[],created_at:now(),started_at:null};
      db.append('plan',task_id+':1',{task_id,plan_revision:1,work_units:t.work_units});
      db.append('draft',draft_id+':0',{schema_version:'lightog_cq_draft_v1',draft_id,draft_revision:0,snapshot_id:s.snapshot_id,status:'DRAFT',validity:'CURRENT',completion:'PARTIAL',
        cq_items:[],families:[],subject_candidates:[],scope_candidates:[],unassigned_cq_ids:[],unresolved_family_ids:[],open_questions:[],unit_heads:{},
        downstream_checks:{identity_resolution:'NOT_PERFORMED',fact_verification:'NOT_PERFORMED',graph_publication:'NOT_PERFORMED'}});
      save(t);db.append('request',requestKey,{request_hash:requestHash,task_id});db.put('head',library_id,{task_id,draft_id,snapshot_id:s.snapshot_id,validity:'CURRENT'});event(t,'QUEUED');return clone(t);
    });
  }
  function unit(t,unitId,stage) {const u=t.work_units.find(u=>u.work_unit_id===unitId);need(u&&(!stage||u.stage===stage),'CQ_WORK_UNIT_INVALID');return u;}
  function dependencies(t,u,refs) {
    array(refs);refs.forEach(r=>{fields(r,['artifact_id','version']);need(textField(r.artifact_id)&&r.version===1,'CQ_UPSTREAM_REF_INVALID');});
    unique(refs.map(r=>r.artifact_id));
    const expected=u.depends_on.map(k=>t.current[k]);
    need(expected.every(Boolean)&&exact(refs.map(r=>r.artifact_id),expected),'CQ_DEPENDENCY_STALE');
  }
  function hints(t,list) {
    if(list===undefined)return [];
    array(list);const s=catalog.get(t.snapshot_id,t.library_id);
    return list.map(h=>{
      fields(h,['doc_id','revision','block_id']);required(h,['doc_id','revision']);need(h.block_id===undefined||textField(h.block_id),'CQ_HINT_INVALID');
      const d=s.documents.find(d=>d.doc_id===h.doc_id);
      const resolution=!d||d.revision!==h.revision||h.block_id!==undefined&&!d.blocks.some(b=>b.block_id===h.block_id)?'INVALID_REF':h.block_id===undefined?'UNLOCATED':'VALID';
      return {...h,resolution};
    });
  }
  function common(t,item,allowed) {
    fields(item,[...itemFields,...allowed]);required(item,['local_key']);if(item.notes!==undefined)strings(item.notes);
    return {...clone(item),source_hints:hints(t,item.source_hints)};
  }
  function project(t,u,a) {
    const p=a.input.payload;fields(p,stageKeys[u.stage]);if(p.open_questions!==undefined)strings(p.open_questions);
    const before=rawDraft(t),assigned={};
    const assign=(items,prefix)=>{array(items);unique(items.map(x=>x?.local_key));assigned[prefix]=Object.create(null);return items.map(x=>{need(textField(x?.local_key),'CQ_LOCAL_KEY_REQUIRED');const value=prefix+'_'+hash([a.artifact_id,x.local_key]).slice(0,32);assigned[prefix][x.local_key]=value;return value;});};
    const body={open_questions:p.open_questions??[]};
    if(u.stage==='CQ') {
      const ids=assign(p.items,'cq');
      body.cq_items=p.items.map((x,i)=>{
        const out=common(t,x,['question','knowledge_target','origin','operation_hint']);required(x,t.mode==='CQ_LIST_ONLY'?['question','origin']:['question','knowledge_target','origin']);need(['DOCUMENT','USER','MODEL_IDEA'].includes(x.origin),'CQ_ORIGIN_INVALID');
        if(x.operation_hint!==undefined)need(textField(x.operation_hint),'CQ_OPERATION_INVALID');
        if(x.origin==='USER')need(t.seed_questions.includes(x.question),'CQ_USER_ORIGIN_INVALID');
        return {...out,cq_id:ids[i]};
      });
    } else if(u.stage==='FAMILY') {
      const ids=assign(p.families,'family'),cqIds=before.cq_items.map(x=>x.cq_id);strings(p.unassigned_cq_ids);unique(p.unassigned_cq_ids);
      body.families=p.families.map((x,i)=>{
        const out=common(t,x,['question_template','knowledge_target','member_cq_ids','subject_slots','operation_hint','scope_hints']);required(x,['question_template','knowledge_target']);
        strings(x.member_cq_ids);need(x.member_cq_ids.length>0,'CQ_FAMILY_MEMBERS_REQUIRED');unique(x.member_cq_ids);need(x.member_cq_ids.every(k=>cqIds.includes(k)),'CQ_MEMBER_INVALID');
        const slots=x.subject_slots??[];strings(slots);unique(slots);need(slots.every(k=>/^[a-z][a-z0-9_]*$/.test(k)),'CQ_SLOT_INVALID');
        const placeholders=[...x.question_template.matchAll(/\{([^{}]+)\}/g)].map(m=>m[1]);need(placeholders.every(k=>slots.includes(k)),'CQ_SLOT_INVALID');
        if(x.operation_hint!==undefined)need(textField(x.operation_hint),'CQ_OPERATION_INVALID');
        if(x.scope_hints!==undefined){array(x.scope_hints);x.scope_hints.forEach(h=>{fields(h,['text','role']);required(h,['text']);need(['APPLICABILITY','BACKGROUND','UNCERTAIN'].includes(h.role),'CQ_SCOPE_HINT_INVALID');});}
        return {...out,family_id:ids[i],subject_slots:slots};
      });
      const members=body.families.flatMap(x=>x.member_cq_ids),all=[...new Set(members),...p.unassigned_cq_ids];
      need(exact([...new Set(all)],cqIds)&&!p.unassigned_cq_ids.some(k=>members.includes(k)),'CQ_DESTINATION_INCOMPLETE');
      body.unassigned_cq_ids=p.unassigned_cq_ids;
    } else {
      const subjectIds=assign(p.subject_candidates,'subject');
      body.subject_candidates=p.subject_candidates.map((x,i)=>{
        const out=common(t,x,['label','kind_hint','alias_suggestions']);required(x,['label','kind_hint']);need(['ENTITY_MENTION','COMPONENT','TOPIC','PROCESS','UNKNOWN'].includes(x.kind_hint),'CQ_KIND_INVALID');
        if(x.alias_suggestions!==undefined)strings(x.alias_suggestions);
        return {...out,subject_candidate_id:subjectIds[i]};
      });
      // local_key is scoped to object collection; references use the subject map.
      const subjectMap=new Map(p.subject_candidates.map((x,i)=>[x.local_key,subjectIds[i]])),scopeIds=assign(p.scope_candidates,'scope');
      body.scope_candidates=p.scope_candidates.map((x,i)=>{
        const out=common(t,x,['family_id','subject_bindings','applicability_hint']);required(x,['family_id','applicability_hint']);
        const f=before.families.find(f=>f.family_id===x.family_id);need(f,'CQ_FAMILY_INVALID');array(x.subject_bindings);
        const bindings=x.subject_bindings.map(b=>{fields(b,['slot','subject_candidate_id']);required(b,['slot','subject_candidate_id']);const candidate=subjectMap.get(b.subject_candidate_id)??b.subject_candidate_id;need(subjectIds.includes(candidate)&&f.subject_slots.includes(b.slot),'CQ_SUBJECT_BINDING_INVALID');return {...b,subject_candidate_id:candidate};});
        need(['SUGGESTED','UNCERTAIN','NOT_SUGGESTED'].includes(x.applicability_hint),'CQ_APPLICABILITY_INVALID');
        need(f.subject_slots.every(slot=>bindings.some(b=>b.slot===slot)),'CQ_REQUIRED_BINDING_MISSING');
        return {...out,scope_candidate_id:scopeIds[i],subject_bindings:bindings};
      });
      strings(p.unresolved_family_ids);unique(p.unresolved_family_ids);
      need(p.unresolved_family_ids.every(k=>before.families.some(f=>f.family_id===k)),'CQ_FAMILY_INVALID');
      need(before.families.every(f=>p.unresolved_family_ids.includes(f.family_id)||body.scope_candidates.some(s=>s.family_id===f.family_id)),'CQ_FAMILY_DESTINATION_INCOMPLETE');
      body.unresolved_family_ids=p.unresolved_family_ids;
    }
    return {body,assigned};
  }
  function rebuild(t,completion='PARTIAL') {
    const d=rawDraft(t),bodies=Object.values(t.current).map(k=>db.get('projection',k).body);
    const next={...d,draft_revision:t.draft_revision+1,completion,unit_heads:clone(t.current)};
    for(const key of ['cq_items','families','subject_candidates','scope_candidates','unassigned_cq_ids','unresolved_family_ids','open_questions']) next[key]=bodies.flatMap(b=>b[key]??[]);
    next.unassigned_cq_ids=[...new Set([...next.unassigned_cq_ids,...next.cq_items.filter(c=>!next.families.some(f=>f.member_cq_ids.includes(c.cq_id))).map(c=>c.cq_id)])];
    next.unresolved_family_ids=[...new Set([...next.unresolved_family_ids,...next.families.filter(f=>!next.scope_candidates.some(s=>s.family_id===f.family_id)).map(f=>f.family_id)])];
    db.append('draft',t.draft_id+':'+next.draft_revision,next);t.draft_revision=next.draft_revision;save(t);return next;
  }
  function apply(t,a,expectedRevision) {
    refresh(t);need(!readonlyStates.includes(t.status),'CQ_'+t.status);const u=unit(t,a.input.work_unit_id,a.input.stage);
    need(a.input.input_snapshot_id===t.snapshot_id,'CQ_INPUT_SNAPSHOT_INVALID');
    dependencies(t,u,a.input.upstream_artifact_refs);
    const expected=db.get('draft',t.draft_id+':'+expectedRevision);
    need(expected&&Number.isSafeInteger(expectedRevision)&&expectedRevision<=t.draft_revision,'CQ_DRAFT_REVISION_CONFLICT');
    // Independent units can rebase a known return; the same unit cannot overwrite.
    need(expected.unit_heads[u.work_unit_id]===t.current[u.work_unit_id],'CQ_DRAFT_REVISION_CONFLICT');
    if(u.stage==='CQ') {
      strings(a.input.input_read_refs);need(a.input.input_read_refs.length>0,'CQ_READ_RECEIPT_REQUIRED');
      const reads=a.input.input_read_refs.map(k=>db.get('read',k));
      need(reads.every(r=>r&&r.task_id===t.task_id&&r.work_unit_id===u.work_unit_id&&r.snapshot_id===t.snapshot_id),'CQ_READ_RECEIPT_INVALID');
      need(u.doc_ids.every(k=>reads.some(r=>r.doc_ids.includes(k)&&r.body_returned)),'CQ_BODY_NOT_READ');
    } else need(a.input.input_read_refs===undefined||Array.isArray(a.input.input_read_refs)&&a.input.input_read_refs.length===0,'CQ_READ_RECEIPT_INVALID');
    const projection=project(t,u,a);db.append('projection',a.artifact_id,{artifact_id:a.artifact_id,...projection});t.current[u.work_unit_id]=a.artifact_id;
    let changed=true;
    while(changed) {
      changed=false;
      for(const [unitId,artifactId] of Object.entries(t.current)) {
        const prior=db.get('artifact',artifactId),work=unit(t,unitId);
        const expectedDeps=work.depends_on.map(k=>t.current[k]);
        if(!expectedDeps.every(Boolean)||!exact(prior.input.upstream_artifact_refs.map(r=>r.artifact_id),expectedDeps)){
          delete t.current[unitId];event(t,'DEPENDENCY_REDO_REQUIRED',{work_unit_id:unitId,artifact_id:artifactId});changed=true;
        }
      }
    }
    const next=rebuild(t);if(!['UNKNOWN_HOLD','FAILED'].includes(t.status))status(t,'RUNNING');
    event(t,'STAGE_APPLIED',{artifact_id:a.artifact_id,draft_revision:next.draft_revision});
    return {outcome:'APPLIED',artifact_id:a.artifact_id,version:1,draft_revision:next.draft_revision,assigned_ids:projection.assigned,rebased:expectedRevision!==next.draft_revision-1};
  }
  function submit(taskId,input,{archiveReason}={}) {
    fields(input,['work_unit_id','stage','input_snapshot_id','upstream_artifact_refs','input_read_refs','expected_draft_revision','idempotency_key','payload','plan_change_request']);
    required(input,['work_unit_id','stage','input_snapshot_id','idempotency_key']);need(['CQ','FAMILY','SCOPE'].includes(input.stage),'CQ_STAGE_INVALID');
    need(canonicalSize(input)<=1000000,'CQ_STAGE_TOO_LARGE');
    return db.transaction(()=>{
      const t=refresh(getTask(taskId)),key=hash([taskId,input.idempotency_key]),contentHash=hash(input),old=db.get('submission',key);
      if(old){if(old.content_hash!==contentHash){event(t,'IDEMPOTENCY_CONFLICT',{artifact_id:old.receipt.artifact_id,content_hash:contentHash,conflicting_input:input});return {outcome:'IDEMPOTENCY_CONFLICT',artifact_id:old.receipt.artifact_id};}return clone(old.receipt);}
      const attempt=db.list('artifact').filter(a=>a.task_id===taskId&&a.input.work_unit_id===input.work_unit_id&&a.input.stage===input.stage).length+1;
      const artifact_id=id('stage'),a={artifact_id,version:1,task_id:taskId,input:clone(input),content_hash:contentHash,attempt,at:now()};
      db.append('artifact',artifact_id,a);
      let receipt;
      try {need(!archiveReason,archiveReason);receipt=apply(t,a,input.expected_draft_revision);}
      catch(error){receipt={outcome:'ARCHIVED',artifact_id,reason:error.code??'CQ_PROJECTION_FAILED'};event(t,'STAGE_ARCHIVED',receipt);}
      if(input.plan_change_request!==undefined)receipt.plan_change=changePlan(t,input.plan_change_request);
      db.append('submission',key,{content_hash:contentHash,receipt});return clone(receipt);
    });
  }
  function reproject(taskId,artifactId,expectedRevision) {
    return db.transaction(()=>{
      const t=getTask(taskId),a=db.get('artifact',artifactId);need(a?.task_id===taskId,'CQ_ARTIFACT_FORBIDDEN');
      need(!Object.values(t.current).includes(artifactId),'CQ_ALREADY_APPLIED');
      // Invalidated old projections are never silently reused after upstream changes.
      const result=apply(t,a,expectedRevision);event(t,'LOCAL_REPROJECTION',result);return result;
    });
  }
  function changePlan(t,request) {
    // CQ-1 supports additive reading units only. Split/merge awaits CQ-4.
    try {
      need(!['CANCELLED','STALE','UNKNOWN_HOLD','FAILED'].includes(t.status),'CQ_PLAN_CHANGE_BLOCKED');
      fields(request,['action','doc_ids','reason']);need(request.action==='ADD_DISCOVERY','CQ_PLAN_CHANGE_UNSUPPORTED');strings(request.doc_ids);unique(request.doc_ids);need(request.doc_ids.length>0&&textField(request.reason),'CQ_PLAN_CHANGE_INVALID');
      const s=catalog.get(t.snapshot_id,t.library_id);need(request.doc_ids.every(k=>s.documents.some(d=>d.doc_id===k)),'CQ_PLAN_CHANGE_FORBIDDEN');
      const work={work_unit_id:id('work'),stage:'CQ',doc_ids:request.doc_ids,depends_on:[],read_policy:'SELECTIVE_BODY'};
      t.work_units.push(work);for(const u of t.work_units.filter(u=>u.stage!=='CQ'))u.depends_on.push(work.work_unit_id);
      t.plan_revision++;db.append('plan',t.task_id+':'+t.plan_revision,{task_id:t.task_id,plan_revision:t.plan_revision,work_units:t.work_units,request});
      for(const u of t.work_units.filter(u=>u.stage!=='CQ'))delete t.current[u.work_unit_id];
      rebuild(t);event(t,'PLAN_CHANGED',{plan_revision:t.plan_revision,request});return {accepted:true,plan_revision:t.plan_revision,work_units:clone(t.work_units)};
    }catch(error){event(t,'PLAN_CHANGE_REJECTED',{request,reason:error.code});return {accepted:false,reason:error.code};}
  }
  function recordRead(taskId,workId,operation,args,result) {
    return db.transaction(()=>{
      const t=refresh(getTask(taskId));need(!readonlyStates.includes(t.status),'CQ_'+t.status);const u=unit(t,workId);
      const docIds=operation==='read'?[result.doc_id]:operation==='search'?[...new Set(result.hits.map(h=>h.doc_id))]:result.documents.map(d=>d.doc_id);
      if(u.stage==='CQ'&&operation!=='list')need(docIds.every(k=>u.doc_ids.includes(k)),'CQ_WORK_UNIT_READ_FORBIDDEN');
      const receipt_id=id('read'),body=operation==='read'?result.units.length>0:operation==='search'&&result.hits.length>0;
      db.append('read',receipt_id,{receipt_id,task_id:taskId,work_unit_id:workId,snapshot_id:t.snapshot_id,operation,doc_ids:docIds,
        body_returned:body,args:clone(args),result:clone(result),at:now()});return {...result,receipt_id};
    });
  }
  function unfinished(t) {const loop=db.get('agent_loop',t.task_id);return t.work_units.filter(u=>!t.current[u.work_unit_id]||u.stage==='CQ'&&loop&&loop.units[u.work_unit_id]?.status!=='FINISHED').map(u=>({work_unit_id:u.work_unit_id,stage:u.stage,doc_ids:u.doc_ids}));}
  function finalize(taskId,expectedRevision,reason='') {
    return db.transaction(()=>{
      const t=refresh(getTask(taskId));need(expectedRevision===t.draft_revision,'CQ_DRAFT_REVISION_CONFLICT');const remaining=unfinished(t);
      if(!readonlyStates.includes(t.status)&&t.status!=='UNKNOWN_HOLD'&&t.status!=='FAILED') {
        if(t.requests.some(r=>r.outcome==='RESERVED'))status(t,'PARTIAL','RUNTIME_STILL_IN_FLIGHT');
        else {rebuild(t,remaining.length?'PARTIAL':'COMPLETE');status(t,remaining.length?'PARTIAL':'SUCCEEDED',reason);}
      }
      return {task:clone(t),draft:draft(taskId),remaining};
    });
  }
  async function cancel(taskId,runtime) {
    const t=db.transaction(()=>{const t=refresh(getTask(taskId));event(t,'CANCEL_REQUESTED');status(t,t.status==='STALE'?'STALE':'CANCELLED','USER_CANCELLED');t.cancelled_at=now();save(t);return t;});
    // Cancel is durable before interrupting; late output is still archived.
    if(t.runtime_handle&&runtime){try{const receipt=await runtime.interrupt(t.runtime_handle);db.event(taskId,'INTERRUPT_RECEIPT',receipt);}catch{db.event(taskId,'INTERRUPT_UNCONFIRMED');}}
    return task(taskId);
  }
  function reserve(taskId,{request_id,actor='main',input_tokens,output_tokens,metering='TOKENS'}) {
    return db.transaction(()=>{
      const t=refresh(getTask(taskId));need(!['CANCELLED','STALE','FAILED','SUCCEEDED','UNKNOWN_HOLD'].includes(t.status),'CQ_SEND_BLOCKED');
      need(textField(request_id)&&textField(actor),'CQ_REQUEST_INVALID');need(!t.requests.some(r=>r.request_id===request_id),'CQ_REQUEST_ALREADY_RESERVED');
      for(const n of [input_tokens,output_tokens])need(Number.isSafeInteger(n)&&n>=0,'CQ_RESERVATION_INVALID');
      need(['TOKENS','BYTE_LIMITED'].includes(metering),'CQ_METERING_INVALID');
      const b=t.budget,active=t.requests.filter(r=>r.outcome==='RESERVED');
      const tokens=key=>t.requests.reduce((n,r)=>n+(r.actual?.[key]??r[key]),0);
      if(t.requests.length>=b.max_requests||active.length>=b.max_concurrency||metering==='TOKENS'&&(tokens('input_tokens')+input_tokens>b.max_input_tokens||tokens('output_tokens')+output_tokens>b.max_output_tokens)||t.started_at!==null&&now()-t.started_at>=b.max_duration_ms) {
        status(t,'PARTIAL','BUDGET_LIMIT');return {allowed:false,reason:'BUDGET_LIMIT',remaining:unfinished(t)};
      }
      const reservation={request_id,actor,input_tokens,output_tokens,metering,outcome:'RESERVED',at:now()};t.requests.push(reservation);t.started_at??=now();status(t,'RUNNING');event(t,'REQUEST_RESERVED',reservation);return {allowed:true,reservation};
    });
  }
  function settle(taskId,requestId,{outcome,input_tokens,output_tokens,usage_known=true}) {
    return db.transaction(()=>{
      const t=refresh(getTask(taskId)),r=t.requests.find(r=>r.request_id===requestId);need(r,'CQ_RESERVATION_NOT_FOUND');
      need(['RETURNED','FAILED','UNKNOWN'].includes(outcome),'CQ_OUTCOME_INVALID');
      const result={outcome,...(outcome==='UNKNOWN'?{}:usage_known?{input_tokens,output_tokens}:{usage_known:false})};
      if(r.settlement){need(hash(r.settlement)===hash(result),'CQ_SETTLEMENT_CONFLICT');return clone(t);}
      if(outcome!=='UNKNOWN'&&usage_known)for(const n of [input_tokens,output_tokens])need(Number.isSafeInteger(n)&&n>=0,'CQ_USAGE_REQUIRED');
      r.outcome=outcome;r.settlement=result;if(outcome!=='UNKNOWN'&&usage_known)r.actual={input_tokens,output_tokens};
      event(t,'REQUEST_'+outcome,{request_id:requestId,...result});
      if(!readonlyStates.includes(t.status)) {
        if(outcome==='UNKNOWN')status(t,'UNKNOWN_HOLD','SENT_RESULT_UNKNOWN');
        else if(r.metering!=='BYTE_LIMITED'&&(input_tokens>r.input_tokens||output_tokens>r.output_tokens))status(t,'FAILED','RUNTIME_USAGE_EXCEEDED_RESERVATION');
        else if(outcome==='FAILED')status(t,'PARTIAL','KNOWN_REQUEST_FAILURE');
      }
      save(t);return clone(t);
    });
  }
  function recover(taskId) {
    return db.transaction(()=>{
      const t=refresh(getTask(taskId));
      for(const r of t.requests.filter(r=>r.outcome==='RESERVED'))settle(taskId,r.request_id,{outcome:'UNKNOWN'});
      return task(taskId);
    });
  }
  function reviewScope(t,scope){const q=db.get('quality',t.task_id);need(t.mode==='CQ_LIST_ONLY'&&q?.phase===scope.role&&q.roles[scope.role]?.context_id===scope.context_id&&q.roles[scope.role].status==='STARTING','CQ_REVIEW_RUNTIME_SCOPE_INVALID');need(!['CANCELLED','STALE','UNKNOWN_HOLD','FAILED','SUCCEEDED'].includes(t.status)&&!t.requests.some(r=>['RESERVED','UNKNOWN'].includes(r.outcome)),'CQ_REVIEW_RUNTIME_BLOCKED');if(scope.role==='GENERATOR')need(q.revision_attempts===1&&q.review&&q.roles.EVALUATOR?.status==='DONE','CQ_REVIEW_HANDOFF_INVALID');else need(scope.role==='EVALUATOR'&&!t.runtime_handle&&!t.requests.length,'CQ_REVIEW_INITIAL_RUNTIME_INVALID');return q;}
  function setRuntimeHandle(taskId,handle,scope=null) {return db.transaction(()=>{const t=getTask(taskId);if(scope){reviewScope(t,scope);need(db.get('quality_runtime_binding',scope.context_id),'CQ_REVIEW_RUNTIME_NOT_BOUND');db.append('quality_runtime_handle',scope.context_id,{task_id:taskId,role:scope.role,context_id:scope.context_id,previous_handle:t.runtime_handle??null,handle});}else need(!t.runtime_handle,'CQ_RUNTIME_ALREADY_STARTED');t.runtime_handle=clone(handle);save(t);return clone(t);});}
  function updateRuntimeHandle(taskId,handle) {return db.transaction(()=>{const t=getTask(taskId);need(t.runtime_handle?.runtime_id===handle.runtime_id&&t.runtime_handle.thread_id===handle.thread_id,'CQ_RUNTIME_HANDLE_CONFLICT');need(!t.runtime_handle.turn_id||t.runtime_handle.turn_id===handle.turn_id,'CQ_RUNTIME_HANDLE_CONFLICT');t.runtime_handle=clone(handle);save(t);event(t,'RUNTIME_TURN_BOUND',{handle});return clone(t);});}
  function bindRuntime(taskId,binding,scope=null) {return db.transaction(()=>{const t=refresh(getTask(taskId));if(scope){reviewScope(t,scope);db.append('quality_runtime_binding',scope.context_id,{task_id:taskId,role:scope.role,context_id:scope.context_id,binding:clone(binding)});}else need(!t.requests.length&&!t.runtime_handle,'CQ_RUNTIME_BINDING_LOCKED');need(binding.model==='qwen3.8-flash','CQ_MODEL_MISMATCH');t.runtime_binding={...t.runtime_binding,...clone(binding)};save(t);event(t,'RUNTIME_BOUND',{...binding,...(scope?{review_role:scope.role,context_id:scope.context_id}:{})});return clone(t);});}
  function pause(taskId,reason) {return db.transaction(()=>{const t=refresh(getTask(taskId));if(!['CANCELLED','STALE','UNKNOWN_HOLD','FAILED','SUCCEEDED'].includes(t.status))status(t,'PARTIAL',reason);return clone(t);});}
  function holdUnknown(taskId,reason) {return db.transaction(()=>{const t=refresh(getTask(taskId));if(!readonlyStates.includes(t.status))status(t,'UNKNOWN_HOLD',reason);return clone(t);});}
  function addDiscovery(taskId,{expected_plan_revision,doc_ids,reason}) {return db.transaction(()=>{const t=refresh(getTask(taskId));need(t.plan_revision===expected_plan_revision,'CQ_PLAN_REVISION_CONFLICT');return changePlan(t,{action:'ADD_DISCOVERY',doc_ids,reason});});}
  function claimContinuation(taskId,permitId) {return db.transaction(()=>{
    const t=refresh(getTask(taskId)),p=db.get('turn_permit',permitId);need(p?.task_id===taskId&&p.previous_turn_id===t.runtime_handle?.turn_id,'CQ_CONTINUATION_PERMIT_INVALID');
    need(!['CANCELLED','STALE','UNKNOWN_HOLD','FAILED','SUCCEEDED'].includes(t.status)&&!t.requests.some(r=>['RESERVED','UNKNOWN'].includes(r.outcome)),'CQ_CONTINUATION_BLOCKED');
    need(!db.get('turn_permit_use',permitId),'CQ_CONTINUATION_ALREADY_CLAIMED');db.append('turn_permit_use',permitId,{permit_id:permitId,task_id:taskId,status:'CLAIMED'});event(t,'RUNTIME_CONTINUATION_CLAIMED',{permit_id:permitId});return clone(p);
  });}
  function bindContinuationHandle(taskId,handle,permitId) {return db.transaction(()=>{
    const t=refresh(getTask(taskId)),p=db.get('turn_permit',permitId),use=db.get('turn_permit_use',permitId);
    need(p?.task_id===taskId&&p.previous_turn_id===t.runtime_handle?.turn_id&&use?.status==='CLAIMED','CQ_CONTINUATION_PERMIT_INVALID');
    const previous=clone(t.runtime_handle);t.runtime_handle=clone(handle);save(t);db.put('turn_permit_use',permitId,{...use,status:'BOUND',runtime_handle:handle});event(t,'RUNTIME_CONTINUATION_BOUND',{permit_id:permitId,previous,handle});return clone(t);
  });}
  const waiting=(taskId,reason)=>db.transaction(()=>{const t=refresh(getTask(taskId));if(!['CANCELLED','STALE','UNKNOWN_HOLD','SUCCEEDED','FAILED'].includes(t.status))status(t,'WAITING_CONFIGURATION',reason);return clone(t);});
  return {create,task,draft,submit,reproject,recordRead,finalize,cancel,reserve,settle,recover,setRuntimeHandle,updateRuntimeHandle,bindRuntime,pause,holdUnknown,addDiscovery,claimContinuation,bindContinuationHandle,waiting,
    events:taskId=>db.list('event').filter(e=>e.task_id===taskId).sort((a,b)=>a.sequence-b.sequence),reads:taskId=>db.list('read').filter(r=>r.task_id===taskId),
    artifacts:taskId=>db.list('artifact').filter(a=>a.task_id===taskId),remaining:taskId=>unfinished(task(taskId))};
}
function canonicalSize(input){return JSON.stringify(input).length;}
