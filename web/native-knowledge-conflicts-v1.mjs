/** Bound local conflict review. No models, clocks-as-truth, publication, or global projection. */
import {clone, canonical, hash, need, textField} from './cq-discovery-store-v2.mjs';
import {normalizeValidTime} from './native-temporal-value-v1.mjs';

export const CONFLICT_POLICY = 'NATIVE_KNOWLEDGE_CONFLICT_V1';
export const CONFLICT_RECORDS = Object.freeze({DECISION:'native_knowledge_conflict_decision_v1',
  REQUEST:'native_knowledge_conflict_request_v1', APPLICATION:'native_knowledge_conflict_application_v1',
  APPLIED:'native_knowledge_conflict_applied_v1',ORDER:'native_knowledge_conflict_order_v1'});
const arr = v => Array.isArray(v) ? v : [];
const ref = r => r.record_ref ?? r.knowledge_ref;
const json = v => JSON.parse(canonical(v));
export const signConflictRecord = body => {const clean=json(body);return {...clean,record_sha256:hash(clean)};};
export function checkConflictRecord(value, code='NATIVE_CONFLICT_RECORD_CHANGED') {
  const {record_sha256,...body}=value??{};need(value&&hash(body)===record_sha256,code);return value;
}
const unique = v => [...new Set(v)];
const words = s => typeof s==='string'?s.replace(/\r\n/g,'\n').trim():s;
function values(revision,kind) {
  return kind==='FACT'?arr(revision.knowledge):kind==='DEFINITION'?arr(revision.ontology?.definitions):
    arr(revision.identity?.profiles).length?revision.identity.profiles:arr(revision.identity?.entities);
}
const objectRef = (row,kind) => kind==='FACT'?ref(row):kind==='DEFINITION'?row.definition_ref:row.id;
function side(revision,kind,id) {
  const found=values(revision,kind).filter(row=>objectRef(row,kind)===id);
  need(found.length===1,'NATIVE_CONFLICT_SIDE_NOT_BOUND');const row=found[0];
  const knowledge=kind==='FACT'?[row]:arr(revision.knowledge).filter(r=>arr(row.knowledge_refs).includes(ref(r)));
  return {object_ref:id,object_sha256:hash(row),record:clone(row),kind,
    name:row.name??row.attribute??row.predicate??row.rule_name??row.kind,
    text:row.statement??row.text??row.description??arr(row.descriptions).join('\n'),
    knowledge_refs:knowledge.map(ref),source_refs:clone(row.source_refs??knowledge.flatMap(r=>arr(r.source_refs))),
    evidence:clone(row.evidence??knowledge.flatMap(r=>arr(r.evidence))),valid_time:clone(row.valid_time??null),
    time_text:row.time_text??null,conditions:clone(row.conditions??null)};
}
function exactTime(input) {
  let t;try{t=normalizeValidTime(input);}catch{return null;}
  if(t.gaps.length)return null;
  if(t.kind==='TIMELESS')return {start:-Infinity,end:Infinity};
  const at=e=>e?.kind==='KNOWN'&&['SECOND','MILLISECOND'].includes(e.precision)&&
    /(?:Z|[+-]\d{2}:\d{2})$/.test(e.value)&&Number.isFinite(Date.parse(e.value))?Date.parse(e.value):null;
  if(t.kind==='INSTANT'){const n=at(t.occurred_at);return n===null?null:{start:n,end:n,point:true};}
  if(t.kind==='INTERVAL'){const start=at(t.valid_from),end=at(t.valid_to);return start===null||end===null?null:{start,end};}
  return null;
}
function overlaps(a,b) {
  if(a.point&&b.point)return a.start===b.start;
  if(a.point)return a.start>=b.start&&a.start<b.end;
  if(b.point)return b.start>=a.start&&b.start<a.end;
  return Math.max(a.start,b.start)<Math.min(a.end,b.end);
}
function subjectBound(revision,id) {
  return arr(revision.identity?.entities).some(e=>e.id===id)||
    arr(revision.identity?.mapping).some(m=>m.canonical_id===id&&m.status==='ACTIVE');
}
const scope = r => ({conditions:r.conditions??[],unit:r.unit??null,modality:r.modality??null,
  version_text:r.version_text??null,exceptions:r.exceptions??null,direction:r.direction??null});
const slot = r => ({kind:r.kind,subject_ref:r.subject_ref,
  attribute:r.kind==='ATTRIBUTE'?r.attribute:null,predicate:r.kind==='RELATION'?r.predicate:null});
const content = r => ({...slot(r),scope:scope(r),object_ref:r.object_ref??null,raw_value:r.raw_value??null,
  negation:r.negation??false,text:words(r.statement??r.text??r.rule_text),valid_time:r.valid_time??null,
  participants:r.participants??[],attributes:r.attributes??null,rule_text:r.rule_text??null,rule_name:r.rule_name??null});
const pairContentHash=rows=>hash(rows.map(r=>[ref(r),hash(content(r))]).sort((a,b)=>a[0].localeCompare(b[0])));
function functional(revision,row) {
  const binding=row.ontology_alignment;
  if(binding?.status!=='ALIGNED')return false;
  const definition=arr(revision.ontology?.definitions).find(d=>d.definition_ref===binding.definition_ref);
  return definition?.status==='USABLE'&&(definition.max_count===1||definition.cardinality==='FUNCTIONAL');
}
function explicitCorrection({left,right,bindings,sourceTexts}) {
  for(const b of bindings) {
    const old=[left,right].find(r=>ref(r)===b.old_ref),next=[left,right].find(r=>ref(r)===b.new_ref);
    if(!old||!next||b.old_ref===b.new_ref||hash(old)!==b.old_sha256||hash(next)!==b.new_sha256||
      b.policy!=='EXPLICIT_SAME_FACT_CORRECTION_V1'||!textField(b.reason))continue;
    const recorded=next.recognition_correction;
    if(!recorded||recorded.target_knowledge_ref!==b.old_ref||recorded.binding_ref!==b.binding_ref)continue;
    const source=sourceTexts.find(s=>s.source_ref===b.source_ref&&s.revision===b.source_revision);
    const evidence=arr(next.evidence).find(e=>(e.doc_ref??e.source_record_ref)===b.source_ref&&e.revision===b.source_revision&&
      (e.start??e.span?.start)===b.start&&(e.end??e.span?.end)===b.end&&(e.quote??e.span?.quote)===b.quote);
    const boundSource=arr(next.source_refs).some(s=>(s.doc_ref??s.record_ref)===b.source_ref&&s.revision===b.source_revision);
    if(source&&boundSource&&evidence&&Number.isSafeInteger(b.start)&&Number.isSafeInteger(b.end)&&b.start>=0&&b.end>b.start&&b.end<=source.text.length&&
      source.text.slice(b.start,b.end)===b.quote)return {old_ref:b.old_ref,new_ref:b.new_ref,binding_ref:b.binding_ref};
  }
  return null;
}
function classifyFact(revision,left,right,options) {
  if(hash(content(left))===hash(content(right)))return {kind:'DUPLICATE',queue:'SYSTEM',reason:'业务内容与适用范围一致，分别保留来源。'};
  const aResolution=left.conflict_resolution,bResolution=right.conflict_resolution;
  if(aResolution?.decision_ref&&aResolution.decision_ref===bResolution?.decision_ref&&
    aResolution.selected_ref===bResolution.selected_ref&&['keep_left','keep_right','recognition_correction'].includes(aResolution.action)&&
    aResolution.assertion_scope_sha256===pairContentHash([left,right])&&bResolution.assertion_scope_sha256===aResolution.assertion_scope_sha256){
    const selected=[left,right].find(r=>ref(r)===aResolution.selected_ref),other=[left,right].find(r=>ref(r)!==aResolution.selected_ref);
    if(selected&&other&&['ACTIVE','DISPUTED'].includes(selected.assertion_status)&&['NOT_ADOPTED','SUPERSEDED'].includes(other.assertion_status))
      return {kind:'RESOLVED_SELECTION',queue:'HISTORY',reason:'既有决定对这两条确切陈述仍适用；保留来源与撤回历史。'};
  }
  if(!subjectBound(revision,left.subject_ref)||left.subject_ref!==right.subject_ref||hash(slot(left))!==hash(slot(right)))
    return {kind:'UNBOUND_SCOPE',queue:'PENDING',reason:'尚未证明同一对象与同一知识目标，不作取舍。'};
  if(hash(scope(left))!==hash(scope(right)))return {kind:'SCOPE_VARIANT',queue:'SYSTEM',reason:'条件、单位、语气或版本不同，分别保留。'};
  const correction=explicitCorrection({left,right,...options});
  if(correction)return {kind:'RECOGNITION_CORRECTION',queue:'SYSTEM',reason:'原文明确指向该事实的认识更正，保留旧认识与依据。',...correction};
  const a=exactTime(left.valid_time),b=exactTime(right.valid_time);
  if(!a||!b)return {kind:'TIME_UNRESOLVED',queue:'PENDING',reason:'业务时间不足以证明重叠，保留双方及时间缺口。'};
  if(!overlaps(a,b))return {kind:'REALITY_CHANGE',queue:'SYSTEM',reason:'明确业务时段不重叠，按各自时间保留，不按上传顺序择真。'};
  const opposite=left.kind==='RELATION'&&left.object_ref===right.object_ref&&
    typeof left.negation==='boolean'&&typeof right.negation==='boolean'&&left.negation!==right.negation;
  const incompatible=left.kind==='ATTRIBUTE'?hash(left.raw_value)!==hash(right.raw_value):
    left.kind==='RELATION'&&left.object_ref!==right.object_ref;
  if(opposite||incompatible&&functional(revision,left)&&functional(revision,right))
    return {kind:'CONTRADICTION',queue:'HUMAN',reason:'同一对象、范围与重叠时段出现互斥陈述，双方均保留为争议。'};
  return {kind:'INSUFFICIENT_EXCLUSIVITY',queue:'PENDING',reason:'未证明这些值互斥，不把多值事实或证据不足强迫转为人工冲突。'};
}
function classifyMapping(revision,kind,left,right,pair,receipts) {
  if(kind==='DEFINITION') {
    const select=r=>Object.fromEntries(['kind','name','description','domains','ranges','datatype','unit','mapping_direction','attribute_owner']
      .map(k=>[k,typeof r[k]==='string'?words(r[k]):r[k]??null]));
    if(hash(select(left))===hash(select(right)))return {kind:'DUPLICATE',queue:'SYSTEM',reason:'定义表达与范围完全重复，交系统局部整理。'};
  }
  if(kind==='IDENTITY') {
    const mapped=id=>arr(revision.identity?.mapping).find(m=>m.local_entity_id===id&&m.status==='ACTIVE')?.canonical_id;
    if(mapped(left.id)&&mapped(left.id)===mapped(right.id))return {kind:'KNOWN_BINDING',queue:'SYSTEM',reason:'已有有效身份绑定，不重复要求人工判断。'};
    const different=arr(revision.identity?.decisions).some(d=>d.decision==='different'&&
      [d.left_id,d.right_id].includes(left.id)&&[d.left_id,d.right_id].includes(right.id)&&d.author==='HUMAN');
    if(different)return {kind:'KNOWN_SEPARATE',queue:'SYSTEM',reason:'保留既有人工不同对象决定。'};
  }
  const receipt=receipts.find(r=>r.comparison_ref===pair.comparison_ref);
  try {
    checkConflictRecord(receipt);
    const sides=receipt.sides??[];
    if(receipt.revision_ref===revision.revision_ref&&receipt.revision_sha256===revision.record_sha256&&
      receipt.assessment==='DOMAIN_CHOICE'&&textField(receipt.business_question)&&sides.length===2&&
      [left,right].every(r=>sides.some(s=>s.object_ref===objectRef(r,kind)&&s.object_sha256===hash(r))))
      return {kind:kind+'_CHOICE',queue:'HUMAN',reason:receipt.business_question};
  }catch{}
  return {kind:'CANDIDATE_ONLY',queue:'PENDING',reason:'候选关联不是已核实冲突，保留分别表示与局部疑点。'};
}

export function prepareNativeConflictReview({revision,candidatePairs=[],correctionBindings=[],sourceTexts=[],comparisonReceipts=[],mappingCapabilities=[]}) {
  checkConflictRecord(revision);need(Array.isArray(candidatePairs),'NATIVE_CONFLICT_PAIRS_INVALID');
  const seen=new Set(),items=candidatePairs.map(pair=>{
    const kind=pair.kind??'FACT',ids=[pair.left_ref,pair.right_ref];
    const itemRef='conflict_item_'+hash([revision.library_id,kind,[...ids].sort()]);
    try {
      need(['FACT','IDENTITY','DEFINITION'].includes(kind)&&ids.every(textField)&&ids[0]!==ids[1], 'NATIVE_CONFLICT_PAIR_INVALID');
      const key=hash([kind,[...ids].sort()]);need(!seen.has(key),'NATIVE_CONFLICT_PAIR_DUPLICATE');seen.add(key);
      const sides=ids.map(id=>side(revision,kind,id));
      const classification=kind==='FACT'?classifyFact(revision,...sides.map(s=>s.record),
        {bindings:correctionBindings,sourceTexts}):classifyMapping(revision,kind,...sides.map(s=>s.record),pair,comparisonReceipts);
      const actions=classification.queue==='HUMAN'?(kind==='FACT'?['keep_left','keep_right','keep_both','defer','recognition_correction','reality_change']:
        mappingCapabilities.filter(c=>c.kind===kind).flatMap(c=>c.actions)):[];
      return {item_ref:itemRef,kind,classification,comparison:{binding_status:'BOUND',
        comparison_ref:'conflict_comparison_'+hash([revision.record_sha256,sides.map(s=>[s.object_ref,s.object_sha256])]),sides},
        allowed_actions:unique([...actions,...(classification.queue==='HUMAN'?['defer']:[])]),
        recommendation:classification.queue==='HUMAN'?'核对双方原文与时间范围后作局部决定；也可保留争议。':'系统保留本项范围与来源，其他知识继续建图。'};
    }catch(error){return {item_ref:itemRef,kind,classification:{kind:'INVALID_BINDING',queue:'TECHNICAL',reason:error.code??'NATIVE_CONFLICT_PAIR_INVALID'},
      comparison:{binding_status:'MISSING',sides:[]},allowed_actions:[],recommendation:'仅隔离此项，不能另取无关候选补齐双方。'};}
  });
  return signConflictRecord({policy:CONFLICT_POLICY,library_id:revision.library_id,revision_ref:revision.revision_ref,
    revision_sha256:revision.record_sha256,items,inputs:{candidatePairs,correctionBindings,sourceTexts,comparisonReceipts,mappingCapabilities},
    summary:{human:items.filter(i=>i.classification.queue==='HUMAN').length,pending:items.filter(i=>i.classification.queue==='PENDING').length,
      system:items.filter(i=>i.classification.queue==='SYSTEM').length,technical:items.filter(i=>i.classification.queue==='TECHNICAL').length},
    blocks_other_knowledge:false});
}

export function prepareNativeConflictDecision({revision,review,itemRef,requestId,action,reason='',selectedRef=null,validTimes=null,createdAt}) {
  checkConflictRecord(review);checkConflictRecord(revision);
  need(review.revision_ref===revision.revision_ref&&review.revision_sha256===revision.record_sha256,'NATIVE_CONFLICT_REVIEW_STALE');
  need(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestId??'')&&textField(createdAt),'NATIVE_CONFLICT_REQUEST_INVALID');
  const item=review.items.find(i=>i.item_ref===itemRef);
  need(item?.comparison.binding_status==='BOUND'&&item.allowed_actions.includes(action),'NATIVE_CONFLICT_ACTION_UNAVAILABLE');
  need(typeof reason==='string'&&(['defer','keep_both'].includes(action)||textField(reason)),'NATIVE_CONFLICT_REASON_REQUIRED');
  if(['recognition_correction','unify'].includes(action))need(item.comparison.sides.some(s=>s.object_ref===selectedRef),'NATIVE_CONFLICT_SELECTION_REQUIRED');
  if(action==='reality_change') {
    need(validTimes&&Object.keys(validTimes).length===2&&item.comparison.sides.every(s=>exactTime(validTimes[s.object_ref])),'NATIVE_CONFLICT_EXPLICIT_TIMES_REQUIRED');
    need(!overlaps(...item.comparison.sides.map(s=>exactTime(validTimes[s.object_ref]))),'NATIVE_CONFLICT_TIMES_OVERLAP');
  }else need(validTimes===null,'NATIVE_CONFLICT_UNEXPECTED_TIMES');
  const body={policy:CONFLICT_POLICY,library_id:revision.library_id,source_revision_ref:revision.revision_ref,
    source_revision_sha256:revision.record_sha256,item_ref:itemRef,comparison_ref:item.comparison.comparison_ref,
    sides:item.comparison.sides.map(s=>({object_ref:s.object_ref,object_sha256:s.object_sha256})),
    request_id:requestId,action,reason:reason.trim(),selected_ref:selectedRef,valid_times:clone(validTimes),author:'HUMAN',created_at:createdAt};
  return signConflictRecord({...body,event_ref:'conflict_decision_'+hash(body)});
}

export function appendNativeConflictDecision({store,decision}) {
  checkConflictRecord(decision);const key=hash([decision.library_id,decision.request_id]);
  const {record_sha256,event_ref,created_at,...command}=decision,requestHash=hash(command);
  need(event_ref==='conflict_decision_'+hash({...command,created_at}),'NATIVE_CONFLICT_DECISION_BINDING_CHANGED');
  return store.transaction(()=>{
    const prior=store.getRecord(CONFLICT_RECORDS.REQUEST,key);
    if(prior){need(prior.request_sha256===requestHash,'NATIVE_CONFLICT_REQUEST_CONFLICT');const saved=checkConflictRecord(store.getRecord(CONFLICT_RECORDS.DECISION,prior.event_ref));
      const {record_sha256,event_ref,created_at,...original}=saved;need(hash(original)===requestHash,'NATIVE_CONFLICT_REQUEST_CHANGED');return clone(saved);}
    const old=store.getRecord(CONFLICT_RECORDS.DECISION,decision.event_ref);
    need(!old||hash(old)===hash(decision),'NATIVE_CONFLICT_IMMUTABLE_CONFLICT');
    if(!old)store.putRecord(CONFLICT_RECORDS.DECISION,decision.event_ref,decision);
    const orderKey=hash([decision.library_id,decision.source_revision_ref]),order=store.getRecord(CONFLICT_RECORDS.ORDER,orderKey);
    if(order)checkConflictRecord(order);
    store.putRecord(CONFLICT_RECORDS.ORDER,orderKey,signConflictRecord({library_id:decision.library_id,
      source_revision_ref:decision.source_revision_ref,event_refs:unique([...arr(order?.event_refs),decision.event_ref])}));
    store.putRecord(CONFLICT_RECORDS.REQUEST,key,{event_ref:decision.event_ref,request_sha256:requestHash});return clone(decision);
  });
}
export function readNativeConflictDecisions({store,libraryId,revisionRef,itemRefs=null}) {
  const order=store.getRecord(CONFLICT_RECORDS.ORDER,hash([libraryId,revisionRef]));if(!order)return [];
  checkConflictRecord(order);
  return order.event_refs.map(id=>{
    const event=checkConflictRecord(store.getRecord(CONFLICT_RECORDS.DECISION,id));
    need(event.library_id===libraryId&&event.source_revision_ref===revisionRef&&event.event_ref===id,'NATIVE_CONFLICT_ORDER_CHANGED');
    return clone(event);
  }).filter(event=>!itemRefs||itemRefs.includes(event.item_ref));
}

export function conflictRowContentHash(row) {
  const {run_id,record_sha256,...body}=clone(row);
  if(body.library_projection)delete body.library_projection.revision_ref;
  return hash(body);
}
function queryGroup(item,get) {
  const ids=item.comparison.sides.map(s=>s.object_ref),rows=ids.map(get),disputed=rows.some(r=>r?.assertion_status==='DISPUTED');
  const pending=item.classification.queue==='PENDING',inactive=['NOT_ADOPTED','SUPERSEDED','RETRACTED'];
  const adopted=ids.filter((id,i)=>!inactive.includes(rows[i]?.assertion_status));
  const variants=new Set(rows.filter(r=>!inactive.includes(r?.assertion_status)).map(r=>hash({value:r?.raw_value??null,object:r?.object_ref??null,negation:r?.negation??false})));
  return {conflict_ref:item.item_ref,knowledge_refs:ids,status:disputed?'DISPUTED':pending?'PENDING':'QUALIFIED',
    include_both_sources:disputed||pending,answer_policy:disputed?'DISCLOSE_BOTH':pending?'PRESERVE_QUALIFICATIONS':'QUALIFIED_VARIANTS',
    current_adopted_refs:disputed||pending?[]:adopted,
    not_adopted_refs:ids.filter((id,i)=>inactive.includes(rows[i]?.assertion_status)),
    human_time_knowledge_refs:ids.filter((id,i)=>rows[i]?.time_binding_authority?.kind==='HUMAN_DECISION'),
    human_decision_refs:unique(rows.flatMap(r=>[r?.conflict_resolution?.decision_ref,r?.time_binding_authority?.decision_ref]).filter(Boolean)),
    unique_value_eligible:!disputed&&!pending&&adopted.length>0&&variants.size===1};
}

/** Only affected rows are materialized; public domain projection remains an injected port. */
export function prepareNativeConflictApplication({revision,review,decisions=[],localMappingPort=null}) {
  checkConflictRecord(revision);checkConflictRecord(review);
  const fresh=prepareNativeConflictReview({revision,...review.inputs});
  need(hash(fresh)===hash(review),'NATIVE_CONFLICT_REVIEW_STALE');
  const byRef=new Map(arr(revision.knowledge).map(r=>[ref(r),clone(r)])),changed=new Set(),identityChanges=[],definitionChanges=[];
  const set=(id,patch)=>{need(byRef.has(id),'NATIVE_CONFLICT_KNOWLEDGE_MISSING');const old=byRef.get(id),next={...old,...clone(patch)};
    if(Object.hasOwn(next,'record_sha256')){const {record_sha256,...body}=next;next.record_sha256=hash(body);}
    if(hash(old)!==hash(next)){byRef.set(id,next);changed.add(id);}};
  for(const item of review.items.filter(i=>i.kind==='FACT'&&i.comparison.binding_status==='BOUND')) {
    const ids=item.comparison.sides.map(s=>s.object_ref),c=item.classification;
    if(c.kind==='CONTRADICTION')for(const id of ids)set(id,{assertion_status:'DISPUTED',conflict_refs:unique([...arr(byRef.get(id).conflict_refs),item.item_ref])});
    if(c.kind==='RECOGNITION_CORRECTION'){set(c.old_ref,{assertion_status:'SUPERSEDED',superseded_by:c.new_ref});set(c.new_ref,{assertion_status:'ACTIVE'});}
  }
  const latest=new Map();for(const d of decisions){checkConflictRecord(d);need(d.source_revision_ref===revision.revision_ref&&
    d.source_revision_sha256===revision.record_sha256,'NATIVE_CONFLICT_DECISION_STALE');
    const expected=prepareNativeConflictDecision({revision,review,itemRef:d.item_ref,requestId:d.request_id,action:d.action,
      reason:d.reason,selectedRef:d.selected_ref,validTimes:d.valid_times,createdAt:d.created_at});
    need(hash(expected)===hash(d),'NATIVE_CONFLICT_DECISION_BINDING_CHANGED');if(d.action!=='defer')latest.set(d.item_ref,d);}
  for(const [itemRef,d]of latest) {
    const item=review.items.find(i=>i.item_ref===itemRef);
    need(item&&item.allowed_actions.includes(d.action)&&hash(d.sides)===hash(item.comparison.sides.map(s=>({object_ref:s.object_ref,object_sha256:s.object_sha256}))),
      'NATIVE_CONFLICT_DECISION_BINDING_CHANGED');
    if(item.kind!=='FACT') {
      if(d.action==='defer')continue;
      need(localMappingPort&&typeof localMappingPort.prepare==='function','NATIVE_CONFLICT_MAPPING_PORT_REQUIRED');
      const delta=localMappingPort.prepare({revision:clone(revision),item:clone(item),decision:clone(d)});
      need(delta&&Array.isArray(delta.record_changes)&&Array.isArray(delta.affected_knowledge_refs),'NATIVE_CONFLICT_MAPPING_DELTA_INVALID');
      const related=new Set(item.comparison.sides.flatMap(s=>s.knowledge_refs));
      need(delta.affected_knowledge_refs.every(id=>related.has(id))&&delta.record_changes.every(c=>delta.affected_knowledge_refs.includes(c.record_ref)&&
        hash(byRef.get(c.record_ref))===c.before_sha256),'NATIVE_CONFLICT_MAPPING_SCOPE_CHANGED');
      const invariant=['record_ref','knowledge_ref','text','statement','raw_value','unit','conditions','negation','modality',
        'time_text','valid_time','version_text','source_refs','evidence','evidence_refs','origin_layer','answer_authority','native_action'];
      need(delta.record_changes.every(c=>invariant.every(key=>hash([Object.hasOwn(byRef.get(c.record_ref),key),byRef.get(c.record_ref)[key]??null])===
        hash([Object.hasOwn(c.after,key),c.after[key]??null]))),'NATIVE_CONFLICT_MAPPING_CONTENT_CHANGED');
      for(const change of [...arr(delta.identity_changes),...arr(delta.definition_changes)]) {
        need(item.comparison.sides.some(s=>s.object_ref===change.object_ref),'NATIVE_CONFLICT_MAPPING_SCOPE_CHANGED');
        const rows=item.kind==='IDENTITY'?arr(revision.identity?.mapping):arr(revision.ontology?.definition_mappings);
        const current=rows.find(row=>(item.kind==='IDENTITY'?row.local_entity_id:row.source_definition_ref)===change.object_ref)??null;
        need(hash(current)===hash(change.before),'NATIVE_CONFLICT_MAPPING_BASIS_CHANGED');
        if(change.after)need((item.kind==='IDENTITY'?change.after.local_entity_id:change.after.source_definition_ref)===change.object_ref,
          'NATIVE_CONFLICT_MAPPING_SCOPE_CHANGED');
      }
      for(const change of delta.record_changes){byRef.set(change.record_ref,clone(change.after));changed.add(change.record_ref);}
      identityChanges.push(...arr(delta.identity_changes));definitionChanges.push(...arr(delta.definition_changes));continue;
    }
    const ids=item.comparison.sides.map(s=>s.object_ref),selected=d.action==='keep_left'?ids[0]:d.action==='keep_right'?ids[1]:d.selected_ref;
    if(['keep_left','keep_right','recognition_correction'].includes(d.action))for(const id of ids)set(id,{assertion_status:id===selected?'ACTIVE':d.action==='recognition_correction'?'SUPERSEDED':'NOT_ADOPTED',
      conflict_resolution:{decision_ref:d.event_ref,action:d.action,selected_ref:selected,author:'HUMAN',reason:d.reason,
        assertion_scope_sha256:pairContentHash(item.comparison.sides.map(s=>s.record))}});
    if(d.action==='reality_change')for(const id of ids)set(id,{assertion_status:'ACTIVE',valid_time:normalizeValidTime(d.valid_times[id]),
      time_binding_authority:{kind:'HUMAN_DECISION',decision_ref:d.event_ref,original_valid_time:clone(byRef.get(id).valid_time??null)},
      conflict_resolution:{decision_ref:d.event_ref,action:d.action,author:'HUMAN',reason:d.reason}});
  }
  // A resolved pair cannot erase another unresolved dispute in the same bounded component.
  const groups=review.items.filter(i=>i.kind==='FACT'&&i.classification.kind==='CONTRADICTION'),neighbors=new Map();
  const remaining=new Set();
  for(const item of groups){const ids=item.comparison.sides.map(s=>s.object_ref),times=ids.map(id=>exactTime(byRef.get(id).valid_time));
    if(times.every(Boolean)&&!overlaps(...times))continue;
    for(const id of ids){const next=neighbors.get(id)??new Set();ids.forEach(x=>next.add(x));neighbors.set(id,next);}
    if(!['keep_left','keep_right','recognition_correction','reality_change'].includes(latest.get(item.item_ref)?.action))ids.forEach(id=>remaining.add(id));
  }
  const visited=new Set();for(const start of neighbors.keys()){
    if(visited.has(start))continue;const component=[],queue=[start];
    while(queue.length){const id=queue.pop();if(visited.has(id))continue;visited.add(id);component.push(id);queue.push(...neighbors.get(id));}
    const active=component.filter(id=>!['NOT_ADOPTED','SUPERSEDED','RETRACTED'].includes(byRef.get(id).assertion_status));
    const competingValues=new Set(active.map(id=>hash({value:byRef.get(id).raw_value??null,object:byRef.get(id).object_ref??null,negation:byRef.get(id).negation??false})));
    if(component.some(id=>remaining.has(id))||competingValues.size>1)for(const id of active)set(id,{assertion_status:'DISPUTED'});
  }
  const changes=[...changed].map(id=>({record_ref:id,before:clone(revision.knowledge.find(r=>ref(r)===id)),after:byRef.get(id)}))
    .filter(c=>hash(c.before)!==hash(c.after)).map(c=>({...c,before_sha256:hash(c.before),after_content_sha256:conflictRowContentHash(c.after)}));
  const affected=changes.map(c=>c.record_ref),queryGroups=review.items.filter(i=>i.kind==='FACT'&&i.comparison.binding_status==='BOUND')
    .map(i=>queryGroup(i,id=>byRef.get(id)));
  const body={policy:CONFLICT_POLICY,kind:'REVIEW_DELTA',review_inputs:clone(review.inputs),decisions:clone(decisions),
    library_id:revision.library_id,source_revision_ref:revision.revision_ref,
    source_revision_sha256:revision.record_sha256,review_sha256:review.record_sha256,scope_item_refs:review.items.map(i=>i.item_ref),decision_refs:[...latest.values()].map(d=>d.event_ref),
    record_changes:changes,identity_changes:identityChanges,definition_changes:definitionChanges,affected_knowledge_refs:affected,
    retained_pins:revision.knowledge.filter(r=>!affected.includes(ref(r))).map(r=>({record_ref:ref(r),sha256:hash(r)})),
    query_groups:queryGroups,source_policy:'REUSE_EXACT',application_required:changes.length>0||identityChanges.length>0||definitionChanges.length>0,
    status:'PREPARED',published:false};
  return signConflictRecord({...body,application_ref:'conflict_application_'+hash(body)});
}

export function prepareNativeConflictRevoke({store,revision,appliedApplication,receipt,requestId,reason,createdAt,localMappingPort=null}) {
  checkConflictRecord(revision);checkConflictRecord(appliedApplication);checkConflictRecord(receipt);
  need(store&&hash(store.getRecord(CONFLICT_RECORDS.APPLIED,appliedApplication.application_ref))===hash(receipt)&&
    hash(store.getRecord(CONFLICT_RECORDS.APPLICATION,appliedApplication.application_ref)?.application)===hash(appliedApplication),
  'NATIVE_CONFLICT_REVOKE_RECEIPT_REQUIRED');
  need((receipt.status==='APPLIED'&&receipt.mode==='NATIVE_PRODUCT'||receipt.status==='OFFLINE_APPLIED'&&receipt.mode==='SIMULATION')&&
    receipt.application_ref===appliedApplication.application_ref&&
    receipt.application_sha256===appliedApplication.record_sha256&&receipt.library_id===revision.library_id,
  'NATIVE_CONFLICT_REVOKE_NOT_APPLIED');
  need(textField(reason)&&textField(requestId)&&textField(createdAt),'NATIVE_CONFLICT_REASON_REQUIRED');
  const changes=appliedApplication.record_changes.map(c=>{
    const current=revision.knowledge.find(r=>ref(r)===c.record_ref);
    need(current&&conflictRowContentHash(current)===c.after_content_sha256,'NATIVE_CONFLICT_REVOKE_SUPERSEDED');
    return {record_ref:c.record_ref,before:clone(current),before_sha256:hash(current),after:clone(c.before),after_content_sha256:conflictRowContentHash(c.before)};
  });
  // Reversing a choice never silently promotes a still-contradictory pair to unique truth.
  let queryGroups=[];
  if(appliedApplication.review_inputs) {
    const restored=new Map(changes.map(c=>[c.record_ref,c.after])),body={...clone(revision),
      knowledge:revision.knowledge.map(r=>restored.get(ref(r))??r)};delete body.record_sha256;
    const review=prepareNativeConflictReview({revision:signConflictRecord(body),...appliedApplication.review_inputs});
    queryGroups=review.items.filter(i=>i.kind==='FACT'&&i.comparison.binding_status==='BOUND').map(i=>{
      const disputed=i.classification.kind==='CONTRADICTION';
      if(disputed)for(const s of i.comparison.sides){const change=changes.find(c=>c.record_ref===s.object_ref);if(change){
        change.after={...change.after,assertion_status:'DISPUTED',conflict_refs:unique([...arr(change.after.conflict_refs),i.item_ref])};
        if(Object.hasOwn(change.after,'record_sha256')){const {record_sha256,...after}=change.after;change.after.record_sha256=hash(after);}
        change.after_content_sha256=conflictRowContentHash(change.after);
      }}
      return queryGroup(i,id=>changes.find(c=>c.record_ref===id)?.after??revision.knowledge.find(r=>ref(r)===id));
    });
  }
  let identityChanges=[],definitionChanges=[];
  if(appliedApplication.identity_changes.length||appliedApplication.definition_changes.length) {
    need(typeof localMappingPort?.prepareRevoke==='function','NATIVE_CONFLICT_MAPPING_REVOKE_PORT_REQUIRED');
    const delta=localMappingPort.prepareRevoke({revision:clone(revision),appliedApplication:clone(appliedApplication),receipt:clone(receipt)});
    need(delta&&equalRefs(delta.affected_knowledge_refs,changes.map(c=>c.record_ref)),'NATIVE_CONFLICT_MAPPING_SCOPE_CHANGED');
    identityChanges=clone(delta.identity_changes??[]);definitionChanges=clone(delta.definition_changes??[]);
    for(const [changes,rows,key] of [[appliedApplication.identity_changes,arr(revision.identity?.mapping),'local_entity_id'],
      [appliedApplication.definition_changes,arr(revision.ontology?.definition_mappings),'source_definition_ref']])for(const change of changes)
      need(hash(rows.find(row=>row[key]===change.object_ref)??null)===hash(change.after),'NATIVE_CONFLICT_REVOKE_SUPERSEDED');
    need(hash(identityChanges)===hash(appliedApplication.identity_changes.map(c=>({...c,before:c.after,after:c.before})))&&
      hash(definitionChanges)===hash(appliedApplication.definition_changes.map(c=>({...c,before:c.after,after:c.before}))),
    'NATIVE_CONFLICT_MAPPING_REVOKE_CHANGED');
  }
  const affected=changes.map(c=>c.record_ref),body={policy:CONFLICT_POLICY,kind:'REVOKE_DELTA',library_id:revision.library_id,
    source_revision_ref:revision.revision_ref,source_revision_sha256:revision.record_sha256,revokes_application_ref:appliedApplication.application_ref,
    decision_refs:[],scope_item_refs:clone(appliedApplication.scope_item_refs),request_id:requestId,reason,author:'HUMAN',created_at:createdAt,record_changes:changes,identity_changes:identityChanges,definition_changes:definitionChanges,
    affected_knowledge_refs:affected,retained_pins:revision.knowledge.filter(r=>!affected.includes(ref(r))).map(r=>({record_ref:ref(r),sha256:hash(r)})),
    query_groups:queryGroups,source_policy:'REUSE_EXACT',application_required:changes.length>0,status:'PREPARED',published:false};
  return signConflictRecord({...body,application_ref:'conflict_application_'+hash(body)});
}

function equalRefs(a,b){return Array.isArray(a)&&a.length===new Set(a).size&&hash([...a].sort())===hash([...b].sort());}
