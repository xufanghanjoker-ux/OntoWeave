/** Local update ports only. Integration owns the sole Head/publication transaction. */
import {clone,hash,need,textField} from './cq-discovery-store-v2.mjs';
import {CONFLICT_POLICY,CONFLICT_RECORDS,checkConflictRecord,signConflictRecord,conflictRowContentHash,
  prepareNativeConflictReview,prepareNativeConflictApplication,prepareNativeConflictRevoke,readNativeConflictDecisions}
  from './native-knowledge-conflicts-v1.mjs';
const ref=r=>r.record_ref??r.knowledge_ref;
const equalSet=(a,b)=>a.length===new Set(a).size&&b.length===new Set(b).size&&hash([...a].sort())===hash([...b].sort());
const bindingKeys=['knowledge_revision_ref','graph_revision_ref','source_index_revision','knowledge_index_revision'];
const decisionPins=(store,application)=>readNativeConflictDecisions({store,libraryId:application.library_id,
  revisionRef:application.source_revision_ref,itemRefs:application.scope_item_refs}).map(d=>d.event_ref);
function immutable(store,kind,key,value) {
  const old=store.getRecord(kind,key);need(!old||hash(old)===hash(value),'NATIVE_CONFLICT_IMMUTABLE_CONFLICT');
  if(!old)store.putRecord(kind,key,clone(value));
}
function validateBase(application,revision) {
  checkConflictRecord(application);checkConflictRecord(revision);
  need(application.policy===CONFLICT_POLICY&&application.source_revision_ref===revision.revision_ref&&
    application.source_revision_sha256===revision.record_sha256,'NATIVE_CONFLICT_APPLICATION_STALE');
  need(equalSet(application.affected_knowledge_refs,application.record_changes.map(c=>c.record_ref))&&
    application.record_changes.every(c=>{
      const old=revision.knowledge.find(r=>ref(r)===c.record_ref);
      return old&&hash(old)===c.before_sha256&&hash(old)===hash(c.before)&&ref(c.after)===c.record_ref&&
        conflictRowContentHash(c.after)===c.after_content_sha256;
    }),'NATIVE_CONFLICT_DELTA_CHANGED');
  const expected=revision.knowledge.filter(r=>!application.affected_knowledge_refs.includes(ref(r)))
    .map(r=>({record_ref:ref(r),sha256:hash(r)}));
  need(hash(expected)===hash(application.retained_pins)&&application.source_policy==='REUSE_EXACT','NATIVE_CONFLICT_RETAINED_SCOPE_CHANGED');
}

export async function prepareNativeConflictLocalUpdate({store,application,currentRevision,currentSourceRecords,projectionPort,indexPort,localMappingPort=null}) {
  validateBase(application,currentRevision);
  let expected;
  if(application.kind==='REVIEW_DELTA') {
    const review=prepareNativeConflictReview({revision:currentRevision,...application.review_inputs});
    expected=prepareNativeConflictApplication({revision:currentRevision,review,decisions:application.decisions,localMappingPort});
  } else {
    need(application.kind==='REVOKE_DELTA','NATIVE_CONFLICT_APPLICATION_KIND_INVALID');
    const original=store.getRecord(CONFLICT_RECORDS.APPLICATION,application.revokes_application_ref)?.application;
    const receipt=store.getRecord(CONFLICT_RECORDS.APPLIED,application.revokes_application_ref);
    need(original&&receipt,'NATIVE_CONFLICT_REVOKE_RECEIPT_REQUIRED');
    expected=prepareNativeConflictRevoke({store,revision:currentRevision,appliedApplication:original,receipt,
      requestId:application.request_id,reason:application.reason,createdAt:application.created_at,localMappingPort});
  }
  need(hash(expected)===hash(application),'NATIVE_CONFLICT_APPLICATION_CHANGED');
  for(const d of application.decisions??[])need(hash(store.getRecord(CONFLICT_RECORDS.DECISION,d.event_ref))===hash(d),
    'NATIVE_CONFLICT_DECISION_NOT_SAVED');
  const order=decisionPins(store,application);
  if(application.kind==='REVIEW_DELTA')need(hash(order)===hash(application.decisions.map(d=>d.event_ref)),'NATIVE_CONFLICT_PREVIEW_STALE');
  if(!application.application_required)return {policy:CONFLICT_POLICY,application_ref:application.application_ref,
    state:'NO_APPLICATION_REQUIRED',graph_changed:false,index_changed:false};
  const cached=store.getRecord(CONFLICT_RECORDS.APPLICATION,application.application_ref);
  if(cached){need(hash(cached.application)===hash(application),'NATIVE_CONFLICT_IMMUTABLE_CONFLICT');
    return clone(checkConflictRecord(cached.prepared));}
  need(projectionPort&&typeof projectionPort.prepareLocal==='function'&&indexPort&&typeof indexPort.prepareLocal==='function'&&
    Array.isArray(currentSourceRecords),'NATIVE_CONFLICT_LOCAL_PORTS_REQUIRED');
  const input={base_revision_ref:currentRevision.revision_ref,base_revision_sha256:currentRevision.record_sha256,
    record_changes:clone(application.record_changes),identity_changes:clone(application.identity_changes),
    definition_changes:clone(application.definition_changes),affected_knowledge_refs:clone(application.affected_knowledge_refs),
    query_groups:clone(application.query_groups)};
  const graph=await projectionPort.prepareLocal(clone(input));
  need(graph&&equalSet(graph.changed_knowledge_refs??[],application.affected_knowledge_refs)&&graph.graph_revision_ref&&graph.graph_delta,
    'NATIVE_CONFLICT_GRAPH_SCOPE_CHANGED');
  const index=await indexPort.prepareLocal({...clone(input),graph_delta:clone(graph.graph_delta),source_policy:'REUSE_EXACT',
    source_records_sha256:hash(currentSourceRecords)});
  need(index&&equalSet(index.changed_knowledge_refs??[],application.affected_knowledge_refs)&&
    index.source_records_sha256===hash(currentSourceRecords)&&bindingKeys.every(k=>typeof index[k]==='string'&&index[k])&&
    index.graph_revision_ref===graph.graph_revision_ref,'NATIVE_CONFLICT_INDEX_SCOPE_CHANGED');
  const body={policy:CONFLICT_POLICY,application_ref:application.application_ref,application_sha256:application.record_sha256,
    library_id:application.library_id,source_revision_ref:currentRevision.revision_ref,source_revision_sha256:currentRevision.record_sha256,
    graph_prepared:clone(graph),index_prepared:clone(index),source_records_sha256:hash(currentSourceRecords),
    bindings:Object.fromEntries(bindingKeys.map(k=>[k,index[k]])),decision_order_sha256:hash(order),decision_scope:{
      source_revision_ref:application.source_revision_ref,item_refs:clone(application.scope_item_refs),event_refs:order},state:'PREPARED',queryable:false};
  const prepared=signConflictRecord(body);
  store.transaction(()=>immutable(store,CONFLICT_RECORDS.APPLICATION,application.application_ref,{application:clone(application),prepared}));
  return prepared;
}

/** No automatic resend. Failed/unknown calls leave the preparation available for inspection. */
async function executeNativeConflictUpdate({store,applicationRef,currentRevision,expectedBinding,publicationPort},confirmationOnly) {
  const saved=store.getRecord(CONFLICT_RECORDS.APPLICATION,applicationRef);
  need(saved,'NATIVE_CONFLICT_PREPARATION_MISSING');const {application,prepared}=saved;
  checkConflictRecord(prepared);checkConflictRecord(application);
  const previous=store.getRecord(CONFLICT_RECORDS.APPLIED,applicationRef);
  if(previous){checkConflictRecord(previous);need(previous.application_sha256===application.record_sha256&&
    previous.prepared_sha256===prepared.record_sha256,'NATIVE_CONFLICT_RECEIPT_CHANGED');return clone(previous);}
  if(!confirmationOnly){validateBase(application,currentRevision);
    need(hash(decisionPins(store,application))===prepared.decision_order_sha256,'NATIVE_CONFLICT_PREVIEW_STALE');}
  need(publicationPort&&['SIMULATION','NATIVE_PRODUCT'].includes(publicationPort.mode)&&
    typeof publicationPort[confirmationOnly?'readOriginalConflictUpdate':'commitConflictUpdate']==='function'&&typeof publicationPort.readback==='function',
    'NATIVE_CONFLICT_PUBLICATION_PORT_REQUIRED');
  // A durable dispatch marker prevents replay after a thrown/unknown external commit.
  const dispatchKind='native_knowledge_conflict_dispatch_v1';
  const dispatched=store.getRecord(dispatchKind,applicationRef);
  const request={application_ref:applicationRef,application_sha256:application.record_sha256,prepared_sha256:prepared.record_sha256,
    expected_binding:clone(confirmationOnly?dispatched?.expected_binding:expectedBinding)};
  if(confirmationOnly)need(dispatched&&dispatched.application_sha256===application.record_sha256&&
    dispatched.prepared_sha256===prepared.record_sha256,'NATIVE_CONFLICT_ORIGINAL_DISPATCH_REQUIRED');
  else store.transaction(()=>{
    need(!store.getRecord(dispatchKind,applicationRef),'NATIVE_CONFLICT_APPLICATION_ALREADY_DISPATCHED');
    store.putRecord(dispatchKind,applicationRef,{...request,state:'DISPATCHED'});
  });
  let result,stage='COMMIT';
  try {
    result=confirmationOnly?await publicationPort.readOriginalConflictUpdate({library_id:application.library_id,application_ref:applicationRef,
      prepared_sha256:prepared.record_sha256}):await publicationPort.commitConflictUpdate({application:clone(application),graph_prepared:clone(prepared.graph_prepared),
        index_prepared:clone(prepared.index_prepared),expected_binding:clone(expectedBinding),
        expected_decision_scope:clone(prepared.decision_scope),expected_decision_order_sha256:prepared.decision_order_sha256});
    const real=publicationPort.mode==='NATIVE_PRODUCT';
    if(confirmationOnly&&(!result||!['CONFIRMED','OFFLINE_CONFIRMED'].includes(result.state)))return {
      application_ref:applicationRef,state:result?.state??dispatched.state,queryable:false,no_resend:true};
    need(result?.state===(real?'CONFIRMED':'OFFLINE_CONFIRMED')&&result.queryable===real&&
      result.mode===publicationPort.mode&&result.library_id===application.library_id&&result.processing_ref===applicationRef&&
      bindingKeys.every(k=>result.bindings?.[k]===prepared.bindings[k])&&textField(result.commit_ref)&&textField(result.confirmation_ref)&&
      Array.isArray(result.evidence_refs)&&result.evidence_refs.length&&result.evidence_refs.every(textField),'NATIVE_CONFLICT_PUBLICATION_NOT_CONFIRMED');
    stage='READBACK';
    const read=await publicationPort.readback({publication:clone(result),application:clone(application),prepared:clone(prepared)});
    need(read?.verified===true&&equalSet(read.changed_knowledge_refs??[],application.affected_knowledge_refs)&&
      read.source_records_sha256===prepared.source_records_sha256&&
      bindingKeys.every(k=>read.bindings?.[k]===prepared.bindings[k]),'NATIVE_CONFLICT_READBACK_MISMATCH');
    const receipt=signConflictRecord({policy:CONFLICT_POLICY,status:real?'APPLIED':'OFFLINE_APPLIED',mode:publicationPort.mode,library_id:application.library_id,
      application_ref:applicationRef,application_sha256:application.record_sha256,prepared_sha256:prepared.record_sha256,
      publication_scope:'APPLICATION_ORIGIN',current_library:'NOT_RECHECKED',publication:clone(result),readback:clone(read)});
    return store.transaction(()=>{
      immutable(store,CONFLICT_RECORDS.APPLIED,applicationRef,receipt);
      store.putRecord(dispatchKind,applicationRef,{...request,state:'APPLIED'});return clone(receipt);
    });
  }catch(error) {
    store.putRecord(dispatchKind,applicationRef,{...request,state:stage==='READBACK'?'READBACK_FAILED':result?.state??'UNKNOWN',error_code:error.code??'NATIVE_CONFLICT_COMMIT_UNKNOWN'});
    throw error;
  }
}

export const applyNativeConflictLocalUpdate=args=>executeNativeConflictUpdate(args,false);
/** Explicit status check reads this original publication, never get-for-record/latest and never commit again. */
export const confirmNativeConflictLocalUpdate=args=>executeNativeConflictUpdate(args,true);
