/** Native local adoption. Host-owned invocation bindings never come from model tools. */
import {clone, hash, need, textField} from './cq-discovery-store-v2.mjs';

export const NATIVE_LOCAL_ADOPTION_POLICY = 'native-local-adoption-v1';
const gapSchema = {type:'object',additionalProperties:false,required:['kind','detail'],properties:{kind:{type:'string',minLength:1},detail:{type:'string',minLength:1}}};
export const LOCAL_REVIEW_ROW_SCHEMA = {
  type:'object', additionalProperties:false,
  required:['candidate_ref','decision','evidence_refs','reason','identity_supported','conditions_supported'],
  properties:{candidate_ref:{type:'string',minLength:1},candidate_revision:{type:['string','integer']},decision:{enum:['SUPPORTED','INSUFFICIENT','CONFLICT','REJECTED']},evidence_refs:{type:'array',uniqueItems:true,items:{type:'string',minLength:1}},reason:{type:'string',minLength:1},identity_supported:{type:'boolean'},conditions_supported:{type:'boolean'},gaps:{type:'array',items:gapSchema}}
};
export const NATIVE_LOCAL_REVIEW_SCHEMA = {
  type:'object',additionalProperties:false,required:['rows'],properties:{
    rows:{type:'array',items:LOCAL_REVIEW_ROW_SCHEMA},
    coverage:{type:'array',items:{type:'object',additionalProperties:false,required:['task_ref','status','reason'],properties:{
      task_ref:{type:'string',minLength:1},status:{enum:['UNASSESSED','PARTIAL','COMPLETE','SOURCE_INSUFFICIENT','CONFLICTED']},reason:{type:'string',minLength:1},
      evidence_refs:{type:'array',uniqueItems:true,items:{type:'string'}},candidate_refs:{type:'array',uniqueItems:true,items:{type:'string'}}
    }}}
  }
};
const own=(v,k)=>Object.hasOwn(v,k);
const fields=(v,keys)=>Object.fromEntries(keys.filter(k=>own(v,k)).map(k=>[k,clone(v[k])]));
const list=(v,code)=>{need(Array.isArray(v),code);return v;};
const unique=(v,code)=>{list(v,code);need(v.every(textField)&&new Set(v).size===v.length,code);return v;};
const gapsValid=v=>Array.isArray(v)&&v.every(g=>g&&textField(g.kind)&&textField(g.detail));
const sortRefs=v=>[...new Map(v.map(r=>[hash(r),r])).values()].sort((a,b)=>hash(a).localeCompare(hash(b)));
const candidateFields=['candidate_ref','revision','scope_revision','local_ref','kind','statement','text','subject_ref','predicate','object_ref','direction','attribute','raw_value','rule_text','participants','evidence_refs','task_refs','conditions','negation','modality','unit','time_text','version_text','gaps','source_refs','source_snapshot_ref','run_id','dependency_fact_refs','depends_on_fact_refs','dependency_candidate_refs','depends_on_candidate_refs'];
const evidenceFields=['evidence_ref','quote','doc_ref','revision','start','end','unit_ref','source_snapshot_ref','source_spans','spans','page','pages','bbox','provenance','parser','warnings'];
const taskFields=['task_ref','cq_ref','cq_refs','input_ref','family_ref','subject_ref','scope_kind','scope_type','kind','module','requirement','knowledge_need','knowledge_requirement','question','conditions','source_refs'];
const subjectFields=['subject_ref','local_ref','surface','evidence_refs','source_refs','start','end','identity_status'];
const headKind='native_adoption_head_v1', revisionKind='native_adoption_revision_v1', factKind='native_adopted_fact_v1';
const invocationKind='native_local_review_invocation_v1', invocationHeadKind='native_local_review_head_v1', reviewKind='native_local_review_v1';
const pendingKind='native_local_review_pending_v1', confirmationKind='native_local_review_confirmation_v1';

export function createNativeLocalAdmission({store,runId,libraryId,snapshotId,assertOpen,readCandidates,readEvidence,readScope}) {
  need(store?.getRecord&&store?.putRecord&&store?.transaction&&[runId,libraryId,snapshotId].every(textField)&&[assertOpen,readCandidates,readEvidence,readScope].every(f=>typeof f==='function'),'NATIVE_ADMISSION_HOST_REQUIRED');
  const key=JSON.stringify([runId,libraryId,snapshotId]);
  const immutable=(kind,id,value)=>{const prior=store.getRecord(kind,id);if(prior){need(hash(prior)===hash(value),'NATIVE_ADMISSION_IMMUTABLE_CONFLICT');return prior;}store.putRecord(kind,id,clone(value));return store.getRecord(kind,id);};
  const currentRevision=()=>{const head=store.getRecord(headKind,key);if(!head)return null;const revision=store.getRecord(revisionKind,head.adoption_revision_ref);need(revision&&hash(revision)===head.revision_sha256,'NATIVE_ADMISSION_HEAD_CHANGED');return revision;};
  const pendingReview=()=>{const head=store.getRecord(pendingKind,key);if(!head)return null;const record=store.getRecord(reviewKind,head.review_ref);need(record&&hash(record)===head.review_sha256,'NATIVE_ADMISSION_PENDING_REVIEW_CHANGED');return record;};
  function open(){const value=assertOpen();need(!value?.then,'NATIVE_ADMISSION_ASYNC_HOST_UNSUPPORTED');}
  function evidenceRow(raw){
    need(raw&&textField(raw.evidence_ref)&&textField(raw.quote)&&textField(raw.doc_ref)&&textField(raw.revision),'NATIVE_ADMISSION_EVIDENCE_INVALID');
    if(raw.source_snapshot_ref!==undefined)need(raw.source_snapshot_ref===snapshotId,'NATIVE_ADMISSION_SOURCE_SNAPSHOT_CHANGED');
    return fields(raw,evidenceFields);
  }
  function scopeSubjects(scope){
    const subjects=new Map((scope.subjects??[]).map(s=>[s.subject_ref,s]));
    for(const t of scope.tasks??[])if(t.scope_kind==='MODULE_OR_DOCUMENT')subjects.set(t.task_ref,{module_scope_task:t});
    return subjects;
  }
  function scopeBinding(c,current){
    const subjectRefs=[...new Set([c.subject_ref,c.object_ref,...(c.participants??[]).map(p=>p.subject_ref)].filter(textField))];
    const binding={candidate_ref:c.candidate_ref,status:'CURRENT',origin_scope_revision:c.scope_revision??null,current_scope_revision:current.scope_revision??null,reasons:[],dependency_task_refs:clone(c.task_refs),dependency_subject_refs:subjectRefs};
    if(c.scope_revision===undefined||c.scope_revision===current.scope_revision)return binding;
    const origin=store.getRecord('native_scope_revision_v1',c.scope_revision);
    need(origin&&origin.scope_revision===c.scope_revision,'NATIVE_ADMISSION_ORIGIN_SCOPE_MISSING');
    const {scope_revision,...payload}=origin;
    need(scope_revision==='scope_'+hash(payload),'NATIVE_ADMISSION_ORIGIN_SCOPE_CHANGED');
    need(origin.run_id===runId&&origin.source_snapshot_ref===snapshotId&&textField(origin.binding)&&origin.binding===current.binding,'NATIVE_ADMISSION_ORIGIN_SCOPE_BINDING_CHANGED');
    need(Array.isArray(origin.tasks)&&Array.isArray(origin.subjects),'NATIVE_ADMISSION_ORIGIN_SCOPE_INVALID');
    const originalTasks=new Map(origin.tasks.map(t=>[t.task_ref,t])),currentTasks=new Map((current.tasks??[]).map(t=>[t.task_ref,t]));
    const originalSubjects=scopeSubjects(origin),currentSubjects=scopeSubjects(current);
    for(const ref of c.task_refs){
      need(originalTasks.has(ref),'NATIVE_ADMISSION_ORIGIN_SCOPE_DEPENDENCY_MISSING');
      if(!currentTasks.has(ref))binding.reasons.push('TASK_REMOVED:'+ref);
      else if(hash(originalTasks.get(ref))!==hash(currentTasks.get(ref)))binding.reasons.push('TASK_CHANGED:'+ref);
    }
    for(const ref of subjectRefs){
      need(originalSubjects.has(ref),'NATIVE_ADMISSION_ORIGIN_SCOPE_DEPENDENCY_MISSING');
      if(!currentSubjects.has(ref))binding.reasons.push('SUBJECT_REMOVED:'+ref);
      else if(hash(originalSubjects.get(ref))!==hash(currentSubjects.get(ref)))binding.reasons.push('SUBJECT_CHANGED:'+ref);
    }
    binding.status=binding.reasons.length?'STALE':'UNCHANGED_DEPENDENCIES';return binding;
  }
  function prepareCurrent(){
    const rawCandidates=readCandidates(),rawScope=readScope()??{};
    need(!rawCandidates?.then&&!rawScope?.then,'NATIVE_ADMISSION_ASYNC_HOST_UNSUPPORTED');
    const candidates=list(rawCandidates,'NATIVE_ADMISSION_CANDIDATES_INVALID').map(c=>fields(c,candidateFields));
    const evidenceRefs=[...new Set(candidates.flatMap(c=>list(c.evidence_refs,'NATIVE_ADMISSION_CANDIDATE_EVIDENCE_INVALID')))].sort();
    const evidence=evidenceRefs.map(ref=>{const e=readEvidence(ref);need(!e?.then,'NATIVE_ADMISSION_ASYNC_HOST_UNSUPPORTED');const row=evidenceRow(e);need(row.evidence_ref===ref,'NATIVE_ADMISSION_EVIDENCE_BINDING_CHANGED');return row;}),evidenceMap=new Map(evidence.map(e=>[e.evidence_ref,e]));
    need(evidenceMap.size===evidence.length,'NATIVE_ADMISSION_EVIDENCE_DUPLICATE');
    const tasks=list(rawScope.tasks??[],'NATIVE_ADMISSION_SCOPE_INVALID').map(t=>fields(t,taskFields)),taskMap=new Map(tasks.map(t=>[t.task_ref,t]));
    need(tasks.every(t=>textField(t.task_ref))&&taskMap.size===tasks.length,'NATIVE_ADMISSION_SCOPE_INVALID');
    const subjects=list(rawScope.subjects??[],'NATIVE_ADMISSION_SCOPE_INVALID').map(s=>fields(s,subjectFields));
    const profiles=new Map(subjects.map(s=>[s.subject_ref,s]));
    for(const t of tasks)if(t.scope_kind==='MODULE_OR_DOCUMENT')profiles.set(t.task_ref,{subject_ref:t.task_ref,module:t.module??null,scope_kind:t.scope_kind,task_ref:t.task_ref,source_refs:clone(t.source_refs??[]),identity_status:'MODULE_SCOPE_ONLY'});
    const seen=new Set(),scopeBindings=[];
    for(const c of candidates){
      need(textField(c.candidate_ref)&&!seen.has(c.candidate_ref)&&(textField(c.revision)||(Number.isSafeInteger(c.revision)&&c.revision>0)),'NATIVE_ADMISSION_CANDIDATE_INVALID');seen.add(c.candidate_ref);
      need(c.source_snapshot_ref===snapshotId&&c.run_id===runId,'NATIVE_ADMISSION_CANDIDATE_BINDING_CHANGED');
      unique(c.evidence_refs,'NATIVE_ADMISSION_CANDIDATE_EVIDENCE_INVALID');need(c.evidence_refs.length>0,'NATIVE_ADMISSION_CANDIDATE_EVIDENCE_INVALID');
      unique(c.task_refs,'NATIVE_ADMISSION_CANDIDATE_TASK_INVALID');const scopeBound=scopeBinding(c,rawScope);scopeBindings.push(scopeBound);
      if(scopeBound.status!=='STALE')need(c.task_refs.every(ref=>taskMap.has(ref)),'NATIVE_ADMISSION_CANDIDATE_TASK_UNKNOWN');
      need(gapsValid(c.gaps??[])&&Array.isArray(c.conditions)&&c.conditions.every(textField)&&textField(c.statement??c.text),'NATIVE_ADMISSION_CANDIDATE_INVALID');
      need(Array.isArray(c.source_refs)&&c.source_refs.length>0&&c.source_refs.every(s=>textField(s.doc_ref)&&textField(s.revision)),'NATIVE_ADMISSION_SOURCE_REFS_INVALID');
      for(const ref of c.evidence_refs){const e=evidenceMap.get(ref);need(e,'NATIVE_ADMISSION_EVIDENCE_UNKNOWN');need(c.source_refs.some(s=>s.doc_ref===e.doc_ref&&s.revision===e.revision),'NATIVE_ADMISSION_SOURCE_REVISION_CHANGED');}
    }
    const participantRefs=new Set(candidates.flatMap(c=>[c.subject_ref,c.object_ref,...(c.participants??[]).map(p=>p.subject_ref)]).filter(textField));
    const source_local_subjects=[...profiles.values()].filter(s=>participantRefs.has(s.subject_ref));
    const payload={contract_version:'native-local-review-input-v1',policy:NATIVE_LOCAL_ADOPTION_POLICY,run_id:runId,library_id:libraryId,source_snapshot_ref:snapshotId,scope_revision:rawScope.scope_revision??null,candidates,tasks,source_local_subjects,scope_bindings:scopeBindings,evidence};
    return{payload,input_sha256:hash(payload),candidates,evidence,evidenceMap,tasks,taskMap,profiles,scopeBindings,scope:rawScope};
  }
  function reviewInput(){open();const p=prepareCurrent();return{...clone(p.payload),input_sha256:p.input_sha256};}
  function recordReviewInvocation(receipt){
    open();need(receipt&&receipt.role==='REVIEW','NATIVE_ADMISSION_REVIEW_ROLE_REQUIRED');
    if(receipt.run_id!==undefined)need(receipt.run_id===runId,'NATIVE_ADMISSION_REVIEW_RUN_CHANGED');
    need([receipt.context_id,receipt.thread_id,receipt.runtime_id].some(textField),'NATIVE_ADMISSION_REVIEW_CONTEXT_REQUIRED');
    need(receipt.isolated_context===true&&receipt.independent!==false,'NATIVE_ADMISSION_REVIEW_NOT_INDEPENDENT');
    const ids=[receipt.context_id,receipt.thread_id].filter(textField);
    for(const prior of [receipt.generator_context_id,receipt.extraction_context_id,receipt.generator_thread_id,receipt.extraction_thread_id].filter(textField))need(!ids.includes(prior),'NATIVE_ADMISSION_REVIEW_NOT_INDEPENDENT');
    need(receipt.outcome===undefined||['STARTED','RETURNED'].includes(receipt.outcome),'NATIVE_ADMISSION_REVIEW_OUTCOME_INVALID');
    const p=prepareCurrent();if(receipt.input_sha256!==undefined)need(receipt.input_sha256===p.input_sha256,'NATIVE_ADMISSION_REVIEW_INPUT_CHANGED');
    const binding={...fields(receipt,['role','runtime_id','runtime_version','thread_id','turn_id','context_id','request_ref','request_id','origin','outcome','input_hash','prompt_hash','tools_hash','skills','model','isolated_context']),run_id:runId,library_id:libraryId,source_snapshot_ref:snapshotId,input_sha256:p.input_sha256,outcome:receipt.outcome??'STARTED'};
    const invocation_ref=receipt.invocation_ref??'native-review-invocation:'+hash(binding);need(textField(invocation_ref),'NATIVE_ADMISSION_INVOCATION_REF_INVALID');const record={invocation_ref,...binding};
    return store.transaction(()=>{immutable(invocationKind,invocation_ref,record);store.putRecord(invocationHeadKind,key,{invocation_ref,invocation_sha256:hash(record)});return clone(record);});
  }
  function invocation(p){
    const head=store.getRecord(invocationHeadKind,key),bound=head&&store.getRecord(invocationKind,head.invocation_ref);
    need(bound&&bound.role==='REVIEW','NATIVE_ADMISSION_REVIEW_INVOCATION_REQUIRED');need(hash(bound)===head.invocation_sha256,'NATIVE_ADMISSION_REVIEW_INVOCATION_CHANGED');need(bound.input_sha256===p.input_sha256,'NATIVE_ADMISSION_REVIEW_INPUT_CHANGED');
    return bound;
  }
  function normalizedRows(rows,p){
    list(rows,'NATIVE_ADMISSION_REVIEW_ROWS_INVALID');need(rows.length===p.candidates.length,'NATIVE_ADMISSION_REVIEW_COVERAGE_INCOMPLETE');
    const seen=new Set(),byRef=new Map(p.candidates.map(c=>[c.candidate_ref,c]));
    return rows.map(raw=>{
      need(raw&&Object.keys(raw).every(k=>own(LOCAL_REVIEW_ROW_SCHEMA.properties,k)),'NATIVE_ADMISSION_REVIEW_ROW_INVALID');
      const c=byRef.get(raw.candidate_ref);need(c&&!seen.has(raw.candidate_ref),'NATIVE_ADMISSION_REVIEW_CANDIDATE_UNKNOWN_OR_DUPLICATE');seen.add(raw.candidate_ref);
      need(LOCAL_REVIEW_ROW_SCHEMA.properties.decision.enum.includes(raw.decision)&&textField(raw.reason)&&typeof raw.identity_supported==='boolean'&&typeof raw.conditions_supported==='boolean','NATIVE_ADMISSION_REVIEW_ROW_INVALID');
      if(own(raw,'candidate_revision'))need(raw.candidate_revision===c.revision,'NATIVE_ADMISSION_CANDIDATE_REVISION_CHANGED');
      unique(raw.evidence_refs,'NATIVE_ADMISSION_REVIEW_EVIDENCE_INVALID');need(gapsValid(raw.gaps??[]),'NATIVE_ADMISSION_REVIEW_GAPS_INVALID');
      if(raw.decision==='SUPPORTED'){
        need(raw.identity_supported&&raw.conditions_supported,'NATIVE_ADMISSION_SUPPORTED_CHECKS_REQUIRED');
        need(raw.evidence_refs.length>0&&c.evidence_refs.every(ref=>raw.evidence_refs.includes(ref))&&raw.evidence_refs.every(ref=>c.evidence_refs.includes(ref)),'NATIVE_ADMISSION_SUPPORTED_EVIDENCE_INCOMPLETE');
      }
      for(const ref of raw.evidence_refs)if(!p.evidenceMap.has(ref)){const rawEvidence=readEvidence(ref);need(rawEvidence&&!rawEvidence.then,'NATIVE_ADMISSION_REVIEW_EVIDENCE_UNKNOWN');const e=evidenceRow(rawEvidence);need(e.evidence_ref===ref,'NATIVE_ADMISSION_EVIDENCE_BINDING_CHANGED');p.evidenceMap.set(ref,e);}
      return{...clone(raw),candidate_revision:c.revision,gaps:clone(raw.gaps??[])};
    });
  }
  function normalizedCoverage(coverage,p,facts){
    if(coverage===undefined)return clone(p.scope.coverage??[]);
    list(coverage,'NATIVE_ADMISSION_TASK_COVERAGE_INVALID');const seen=new Set(),supported=new Set(facts.map(f=>f.candidate_ref));
    return coverage.map(c=>{
      need(c&&Object.keys(c).every(k=>own(NATIVE_LOCAL_REVIEW_SCHEMA.properties.coverage.items.properties,k))&&p.taskMap.has(c.task_ref)&&!seen.has(c.task_ref),'NATIVE_ADMISSION_TASK_COVERAGE_INVALID');seen.add(c.task_ref);
      need(NATIVE_LOCAL_REVIEW_SCHEMA.properties.coverage.items.properties.status.enum.includes(c.status)&&textField(c.reason),'NATIVE_ADMISSION_TASK_COVERAGE_INVALID');
      unique(c.evidence_refs??[],'NATIVE_ADMISSION_TASK_COVERAGE_INVALID');unique(c.candidate_refs??[],'NATIVE_ADMISSION_TASK_COVERAGE_INVALID');
      need((c.evidence_refs??[]).every(ref=>p.evidenceMap.has(ref))&&(c.candidate_refs??[]).every(ref=>p.candidates.some(x=>x.candidate_ref===ref&&x.task_refs.includes(c.task_ref))),'NATIVE_ADMISSION_TASK_COVERAGE_REF_UNKNOWN');
      if(c.status==='COMPLETE')need(p.scope.discovery_status==='SCAN_COMPLETE'&&(c.evidence_refs??[]).length>0&&(c.candidate_refs??[]).length>0&&c.candidate_refs.every(ref=>supported.has(ref)),'NATIVE_ADMISSION_COMPLETE_COVERAGE_UNSUPPORTED');
      if(c.status==='SOURCE_INSUFFICIENT')need(p.scope.discovery_status==='SCAN_COMPLETE'&&(c.evidence_refs??[]).length>0,'NATIVE_ADMISSION_INSUFFICIENT_COVERAGE_UNSCANNED');
      return clone(c);
    });
  }
  function persistRevision(body){
    const adoption_revision_ref='native-adoption:'+hash(body),record={adoption_revision_ref,effective_fact_set_ref:'native-effective-facts:'+hash(body.effective_fact_refs),...body};
    immutable(revisionKind,adoption_revision_ref,record);store.putRecord(headKind,key,{adoption_revision_ref,revision_sha256:hash(record)});return record;
  }
  function recordReview({rows,coverage}={}){
    open();const p=prepareCurrent(),bound=invocation(p),checked=normalizedRows(rows,p),prior=currentRevision();
    const facts=[],results=[];
    for(const row of checked){
      const c=p.candidates.find(c=>c.candidate_ref===row.candidate_ref),holds=[],scopeBound=p.scopeBindings.find(b=>b.candidate_ref===c.candidate_ref);
      if((c.gaps??[]).length)holds.push('CANDIDATE_HAS_UNRESOLVED_GAPS');if(row.gaps.length)holds.push('REVIEW_HAS_UNRESOLVED_GAPS');
      if(scopeBound.status==='STALE')holds.push('STALE_SCOPE');
      const adopted=row.decision==='SUPPORTED'&&holds.length===0;
      let fact_ref=null;
      if(adopted){
        const participantRefs=[...new Set([c.subject_ref,c.object_ref,...(c.participants??[]).map(p=>p.subject_ref)].filter(textField))];
        const participant_profiles=participantRefs.filter(ref=>p.profiles.has(ref)).map(ref=>clone(p.profiles.get(ref)));
        const selected=row.evidence_refs.map(ref=>p.evidenceMap.get(ref)),basis={candidate_ref:c.candidate_ref,candidate_revision:c.revision,candidate_sha256:hash(c),evidence_sha256:hash(selected),participant_profiles_sha256:hash(participant_profiles),policy:NATIVE_LOCAL_ADOPTION_POLICY};
        fact_ref='native-fact:'+hash(basis);
        facts.push({...clone(c),fact_ref,record_ref:'native-adopted-fact:'+hash(basis),representation:'ADOPTED_FACT',answer_authority:'LOCALLY_ADOPTED',text:c.statement??c.text,statement:c.statement??c.text,subject_ref:c.subject_ref??null,participants:clone(c.participants??[]),participant_profiles,source_refs:sortRefs(selected.map(e=>({doc_ref:e.doc_ref,revision:e.revision}))),evidence_refs:clone(row.evidence_refs),conditions:clone(c.conditions),negation:c.negation??false,modality:c.modality??null,unit:c.unit??null,task_refs:clone(c.task_refs),...basis,source_snapshot_ref:snapshotId,run_id:runId,library_id:libraryId,dependency_fact_refs:clone(c.dependency_fact_refs??c.depends_on_fact_refs??[]),dependency_candidate_refs:clone(c.dependency_candidate_refs??c.depends_on_candidate_refs??[])});
      }
      results.push({...row,adoption_status:adopted?'PENDING_CONFIRMATION':row.decision==='SUPPORTED'?'HELD':row.decision,fact_ref,hold_reasons:holds,scope_status:scopeBound.status});
    }
    const taskCoverage=normalizedCoverage(coverage,p,facts),review={run_id:runId,library_id:libraryId,source_snapshot_ref:snapshotId,policy:NATIVE_LOCAL_ADOPTION_POLICY,review_invocation_ref:bound.invocation_ref,review_input_sha256:p.input_sha256,results,coverage:taskCoverage,pending_facts:facts,supplemental_evidence:[...p.evidenceMap.values()].filter(e=>!p.evidence.some(original=>original.evidence_ref===e.evidence_ref)),parent_revision_ref:prior?.adoption_revision_ref??null};
    const review_ref='native-local-review:'+hash(review);
    return store.transaction(()=>{
      open();need(prepareCurrent().input_sha256===p.input_sha256,'NATIVE_ADMISSION_REVIEW_INPUT_CHANGED');need(invocation(p).invocation_ref===bound.invocation_ref,'NATIVE_ADMISSION_REVIEW_INVOCATION_CHANGED');
      const old=store.getRecord(reviewKind,review_ref);if(old){need(hash(old)===hash({review_ref,...review}),'NATIVE_ADMISSION_IMMUTABLE_CONFLICT');return{...snapshot(),idempotent:true};}
      need((currentRevision()?.adoption_revision_ref??null)===(prior?.adoption_revision_ref??null),'NATIVE_ADMISSION_HEAD_CAS_MISMATCH');
      const record=immutable(reviewKind,review_ref,{review_ref,...review});store.putRecord(pendingKind,key,{review_ref,review_sha256:hash(record)});
      return{...snapshot(),idempotent:false};
    });
  }
  function confirmReviewInvocation(receipt){
    open();const p=prepareCurrent(),bound=invocation(p),pending=pendingReview();
    need(pending&&pending.review_invocation_ref===bound.invocation_ref&&pending.review_input_sha256===p.input_sha256,'NATIVE_ADMISSION_PENDING_REVIEW_REQUIRED');
    need(receipt&&receipt.invocation_ref===bound.invocation_ref&&receipt.isolated_context===true,'NATIVE_ADMISSION_CONFIRMATION_BINDING_INVALID');
    need((receipt.outcome==='RETURNED'||receipt.status==='SUCCEEDED')&&(receipt.outcome===undefined||receipt.outcome==='RETURNED')&&(receipt.status===undefined||receipt.status==='SUCCEEDED'),'NATIVE_ADMISSION_CONFIRMATION_NOT_SUCCESSFUL');
    need(receipt.role==='REVIEW','NATIVE_ADMISSION_REVIEW_ROLE_REQUIRED');need(receipt.run_id===runId,'NATIVE_ADMISSION_REVIEW_RUN_CHANGED');
    for(const k of ['runtime_id','thread_id','context_id','input_hash','prompt_hash','tools_hash'])if(bound[k]!==undefined&&bound[k]!==null)need(receipt[k]===bound[k],'NATIVE_ADMISSION_CONFIRMATION_CONTEXT_CHANGED');
    for(const e of pending.supplemental_evidence)need(hash(evidenceRow(readEvidence(e.evidence_ref)))===hash(e),'NATIVE_ADMISSION_SUPPLEMENTAL_EVIDENCE_CHANGED');
    const confirmed={review_ref:pending.review_ref,review_invocation_ref:bound.invocation_ref,review_input_sha256:p.input_sha256,...fields(receipt,['invocation_ref','run_id','role','runtime_id','thread_id','turn_id','context_id','input_hash','prompt_hash','tools_hash','isolated_context','outcome','status'])};
    return store.transaction(()=>{
      open();need(prepareCurrent().input_sha256===p.input_sha256,'NATIVE_ADMISSION_REVIEW_INPUT_CHANGED');need(invocation(p).invocation_ref===bound.invocation_ref,'NATIVE_ADMISSION_REVIEW_INVOCATION_CHANGED');
      for(const e of pending.supplemental_evidence)need(hash(evidenceRow(readEvidence(e.evidence_ref)))===hash(e),'NATIVE_ADMISSION_SUPPLEMENTAL_EVIDENCE_CHANGED');
      const existing=store.getRecord(confirmationKind,pending.review_ref);if(existing){need(hash(existing)===hash(confirmed),'NATIVE_ADMISSION_CONFIRMATION_CHANGED');return{...snapshot(),idempotent:true};}
      need((currentRevision()?.adoption_revision_ref??null)===pending.parent_revision_ref,'NATIVE_ADMISSION_HEAD_CAS_MISMATCH');
      const facts=pending.pending_facts;for(const f of facts)immutable(factKind,f.fact_ref,f);immutable(confirmationKind,pending.review_ref,confirmed);
      persistRevision({run_id:runId,library_id:libraryId,source_snapshot_ref:snapshotId,policy:NATIVE_LOCAL_ADOPTION_POLICY,parent_revision_ref:pending.parent_revision_ref,action:'LOCAL_REVIEW',review_ref:pending.review_ref,review_invocation_ref:bound.invocation_ref,review_input_sha256:p.input_sha256,effective_fact_refs:facts.map(f=>f.fact_ref).sort(),fact_bindings:Object.fromEntries(facts.map(f=>[f.fact_ref,hash(f)])),results:pending.results.map(row=>row.adoption_status==='PENDING_CONFIRMATION'?{...row,adoption_status:'ADOPTED'}:row),coverage:pending.coverage,suspended_fact_refs:[]});
      return{...snapshot(),idempotent:false};
    });
  }
  function eligibleFacts(revision,p){
    if(!revision)return{facts:[],stale_fact_refs:[]};const facts=[],stale_fact_refs=[];
    for(const ref of revision.effective_fact_refs){const f=store.getRecord(factKind,ref);need(f&&f.fact_ref===ref&&f.policy===NATIVE_LOCAL_ADOPTION_POLICY&&revision.fact_bindings?.[ref]===hash(f),'NATIVE_ADMISSION_FACT_RECORD_CHANGED');
      const c=p.candidates.find(c=>c.candidate_ref===f.candidate_ref),evidence=f.evidence_refs.map(ref=>p.evidenceMap.get(ref));
      const profiles=c?[...new Set([c.subject_ref,c.object_ref,...(c.participants??[]).map(p=>p.subject_ref)].filter(textField))].filter(ref=>p.profiles.has(ref)).map(ref=>p.profiles.get(ref)):[];
      if(!c||p.scopeBindings.some(b=>b.candidate_ref===c.candidate_ref&&b.status==='STALE')||c.revision!==f.candidate_revision||hash(c)!==f.candidate_sha256||evidence.some(e=>!e)||hash(evidence)!==f.evidence_sha256||hash(profiles)!==f.participant_profiles_sha256){stale_fact_refs.push(ref);continue;}facts.push(f);
    }
    let changed=true;while(changed){changed=false;const refs=new Set(facts.map(f=>f.fact_ref)),candidateRefs=new Set(facts.map(f=>f.candidate_ref));for(let i=facts.length-1;i>=0;i--){const f=facts[i];if(f.dependency_fact_refs.some(ref=>!refs.has(ref))||f.dependency_candidate_refs.some(ref=>!candidateRefs.has(ref))){stale_fact_refs.push(f.fact_ref);facts.splice(i,1);changed=true;}}}
    return{facts,stale_fact_refs};
  }
  function snapshot(){
    const revision=currentRevision();let p;
    try{p=prepareCurrent();}catch(error){
      if(!['NATIVE_SOURCE_STALE','NATIVE_ADMISSION_SOURCE_SNAPSHOT_CHANGED','NATIVE_ADMISSION_SOURCE_REVISION_CHANGED','NATIVE_ADMISSION_CANDIDATE_BINDING_CHANGED'].includes(error.code))throw error;
      return{policy:NATIVE_LOCAL_ADOPTION_POLICY,adoption_revision_ref:revision?.adoption_revision_ref??null,effective_fact_set_ref:'native-effective-facts:'+hash([]),facts:[],effective_fact_refs:[],stale_fact_refs:clone(revision?.effective_fact_refs??[]),stale_candidate_refs:[],scope_bindings:[],suspended_fact_refs:clone(revision?.suspended_fact_refs??[]),results:clone(revision?.results??[]),coverage:clone(revision?.coverage??[]),review_input_sha256:revision?.review_input_sha256??null,review_invocation_ref:revision?.review_invocation_ref??null,review_complete:false,adoption_pending_confirmation:false,source_current:false,invalidation_reason:error.code,source_snapshot_ref:snapshotId,run_id:runId};
    }
    const eligible=eligibleFacts(revision,p),pending=pendingReview(),confirmed=pending&&store.getRecord(confirmationKind,pending.review_ref),currentReview=pending??(revision?.review_ref&&store.getRecord(reviewKind,revision.review_ref));
    const activeInvocation=store.getRecord(invocationHeadKind,key)?.invocation_ref;
    const pendingCurrent=Boolean(pending&&pending.review_input_sha256===p.input_sha256&&pending.review_invocation_ref===activeInvocation&&!confirmed);
    return{policy:NATIVE_LOCAL_ADOPTION_POLICY,adoption_revision_ref:revision?.adoption_revision_ref??null,effective_fact_set_ref:'native-effective-facts:'+hash(eligible.facts.map(f=>f.fact_ref).sort()),facts:clone(eligible.facts),effective_fact_refs:eligible.facts.map(f=>f.fact_ref),stale_fact_refs:eligible.stale_fact_refs,stale_candidate_refs:p.scopeBindings.filter(b=>b.status==='STALE').map(b=>b.candidate_ref),scope_bindings:clone(p.scopeBindings),suspended_fact_refs:clone(revision?.suspended_fact_refs??[]),results:clone(pendingCurrent?pending.results:revision?.results??[]),coverage:clone(pendingCurrent?pending.coverage:revision?.coverage??p.scope.coverage??[]),review_input_sha256:currentReview?.review_input_sha256??null,review_invocation_ref:currentReview?.review_invocation_ref??null,review_complete:Boolean(currentReview&&currentReview.review_input_sha256===p.input_sha256&&currentReview.review_invocation_ref===activeInvocation),adoption_pending_confirmation:pendingCurrent,source_current:true,source_snapshot_ref:snapshotId,run_id:runId};
  }
  function suspend({fact_refs,evidence_refs,reason}={}){
    open();unique(fact_refs,'NATIVE_ADMISSION_SUSPEND_FACTS_INVALID');unique(evidence_refs,'NATIVE_ADMISSION_SUSPEND_EVIDENCE_INVALID');need(fact_refs.length>0&&evidence_refs.length>0&&textField(reason),'NATIVE_ADMISSION_SUSPEND_INVALID');
    const p=prepareCurrent(),suspensionEvidence=evidence_refs.map(ref=>{const raw=readEvidence(ref);need(raw&&!raw.then,'NATIVE_ADMISSION_SUSPEND_EVIDENCE_UNKNOWN');const e=evidenceRow(raw);need(e.evidence_ref===ref,'NATIVE_ADMISSION_EVIDENCE_BINDING_CHANGED');return e;});const prior=currentRevision();need(prior,'NATIVE_ADMISSION_SUSPEND_REVISION_REQUIRED');
    const all=prior.effective_fact_refs.map(ref=>store.getRecord(factKind,ref));need(all.every(Boolean)&&fact_refs.every(ref=>prior.effective_fact_refs.includes(ref)),'NATIVE_ADMISSION_SUSPEND_FACT_UNKNOWN');
    const removed=new Set(fact_refs);let changed=true;while(changed){changed=false;const candidates=new Set(all.filter(f=>removed.has(f.fact_ref)).map(f=>f.candidate_ref));for(const f of all)if(!removed.has(f.fact_ref)&&(f.dependency_fact_refs.some(ref=>removed.has(ref))||f.dependency_candidate_refs.some(ref=>candidates.has(ref)))){removed.add(f.fact_ref);changed=true;}}
    return store.transaction(()=>{
      open();need(currentRevision()?.adoption_revision_ref===prior.adoption_revision_ref,'NATIVE_ADMISSION_HEAD_CAS_MISMATCH');need(prepareCurrent().input_sha256===p.input_sha256,'NATIVE_ADMISSION_REVIEW_INPUT_CHANGED');
      const suspended_fact_refs=[...new Set([...(prior.suspended_fact_refs??[]),...removed])].sort();
      persistRevision({...fields(prior,['run_id','library_id','source_snapshot_ref','policy','review_ref','review_invocation_ref','review_input_sha256','results','coverage','fact_bindings']),parent_revision_ref:prior.adoption_revision_ref,action:'SUSPEND',effective_fact_refs:prior.effective_fact_refs.filter(ref=>!removed.has(ref)),suspended_fact_refs,suspension:{fact_refs:clone(fact_refs),evidence_refs:clone(evidence_refs),evidence_sha256:hash(suspensionEvidence),reason}});
      return{...snapshot(),invalidated_fact_refs:[...removed].sort(),invalidate_fact_view:true};
    });
  }
  return Object.freeze({reviewInput,recordReviewInvocation,recordReview,confirmReviewInvocation,suspend,snapshot});
}
