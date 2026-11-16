/** Shared deterministic categorization. No Node APIs, inference, writes, or action authorization. */
export const PENDING_CLASSIFICATION_POLICY='NATIVE_PENDING_SEMANTIC_CATEGORIES_V1';
const list=v=>Array.isArray(v)?v:[];
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const text=v=>typeof v==='string'&&v.trim().length>0;
const unique=rows=>[...new Map(rows.map(r=>[JSON.stringify(r),r])).values()];
const ref=r=>r?.record_ref??r?.knowledge_ref;
const sourceKey=r=>JSON.stringify([r?.doc_ref??r?.record_ref,r?.revision]);
const ordered=v=>Array.isArray(v)?v.map(ordered):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;
const definitionKinds=new Set(['CLASS','TYPE','CONCEPT','DEFINITION','ONTOLOGY','类型定义','RELATION','ATTRIBUTE',
  'ENTITY_TYPE','RELATION_TYPE','ATTRIBUTE_TYPE','CLASS_DEFINITION','RELATION_DEFINITION','ATTRIBUTE_DEFINITION']);
const identityKinds=new Set(['','ENTITY','IDENTITY','IDENTITY_PAIR','ENTITY_IDENTITY']);
const factKinds=new Set(['FACT','CONFLICT','KNOWLEDGE','FACT_CONFLICT','KNOWLEDGE_CONFLICT']);

/** An exact record anchor may recover its own evidence; names and unrelated records never do. */
export function pendingRecordSources(record,knowledge=[]) {
  const nested=object(record?.source)?record.source:{},top=record?.record_ref,nestedRef=nested.record_ref;
  const mismatch=text(top)&&text(nestedRef)&&top!==nestedRef;
  const wanted=[...new Set([top,nestedRef,...list(record?.knowledge_refs),...list(record?.record_refs)].filter(text))];
  const related=mismatch?[]:knowledge.filter(row=>wanted.includes(ref(row)));
  const declaredSha=nested.record_sha256;
  const hashMismatch=related.filter(row=>ref(row)===(nestedRef??top)).some(row=>text(declaredSha)&&
    declaredSha!==(row.simplified_origin?.record_sha256??row.record_sha256));
  const safe=hashMismatch?[]:related;
  const issue=mismatch?'PENDING_RECORD_ANCHOR_MISMATCH':hashMismatch?'PENDING_RECORD_VERSION_MISMATCH':null;
  const declared=unique([...list(record?.source_refs),...list(nested.source_refs)]);
  const associated=safe.flatMap(row=>list(row.source_refs)).filter(s=>!declared.length||declared.some(r=>sourceKey(r)===sourceKey(s)&&
    (!text(r.unit_ref)||r.unit_ref===s.unit_ref)));
  const sources=issue?[]:unique([...declared,...associated]);
  const requested=[...new Set([...list(record?.evidence_refs),...list(nested.evidence_refs)].filter(text))];
  const direct=issue?[]:[...list(record?.evidence),...list(nested.evidence)];
  const evidence=unique([...direct,...safe.flatMap(row=>list(row.evidence)).filter(e=>
    (!requested.length||requested.includes(e.evidence_ref??e.id))&&sources.some(s=>sourceKey(s)===sourceKey(e)&&
      (!text(s.unit_ref)||s.unit_ref===e.unit_ref)))]);
  return {source_record:{...record,source_refs:sources,evidence,evidence_refs:[...new Set(evidence.map(e=>e.evidence_ref??e.id).filter(text))]},
    knowledge_refs:safe.map(ref),binding_issue:issue};
}

function endpoints(record,identity,ontology) {
  const profiles=list(identity?.profiles),entities=[...profiles,...list(identity?.entities)];
  const short=new Map(profiles.map(p=>[p.entity_ref,p.id]));
  const left=record.left_id??short.get(record.left_ref)??record.left_ref,
    right=record.right_id??short.get(record.right_ref)??record.right_ref;
  const def=id=>list(ontology?.definitions).some(d=>(d.definition_ref??d.id)===id);
  const definitionLeft=record.left_definition_ref??record.source_definition_ref??(def(record.left_ref)?record.left_ref:null),
    definitionRight=record.right_definition_ref??record.target_definition_ref??(def(record.right_ref)?record.right_ref:null);
  return {left,right,left_record:entities.find(r=>r.id===left),right_record:entities.find(r=>r.id===right),
    definition_left:definitionLeft,definition_right:definitionRight,
    definition_pair:text(definitionLeft)&&text(definitionRight)&&definitionLeft!==definitionRight&&
      [definitionLeft,definitionRight].every(id=>list(ontology?.definitions).some(d=>(d.definition_ref??d.id)===id))};
}

export function partitionNativePendingItems(rows,{knowledge=[],identity={},ontology={},legacy=false}={}) {
  const entries=rows.map((input,index)=>{
    const record=input?.record??input,origin=input?.origin??'pending',kind=String(record.pending_kind??record.candidate_kind??record.kind??'').toUpperCase(),reason=record.reason??'',
      source=pendingRecordSources(factKinds.has(kind)?{...record,knowledge_refs:[...list(record.knowledge_refs),record.left_ref,record.right_ref].filter(text)}:record,knowledge),ends=endpoints(record,identity,ontology);
    let category,title,explanation;
    if(source.binding_issue){category='TECHNICAL';title='来源绑定需核对';explanation='事项与关联记录版本不一致，未借用其他记录的引句。';}
    else if(ends.definition_pair){category='DEFINITION';title='定义含义待比较';explanation='已保留实际两方定义及依据；是否人工处理以正式接口能力为准。';}
    else if(definitionKinds.has(kind)){
      category='DEFINITION';title='新增定义候选';explanation='这是从资料中保留的新类型或关系用语，进入本体整理；尚未构成身份冲突。';
    }else if(identityKinds.has(kind)&&text(ends.left)&&text(ends.right)&&ends.left!==ends.right&&ends.left_record&&ends.right_record){
      category='IDENTITY';title='对象身份候选比较';explanation='实际双方已保存；候选关系不等于已确认冲突，当前动作以正式接口为准。';
    }else if(factKinds.has(kind)){
      category='FACT';title='知识事实疑点';explanation='保留事实与时间材料；真实双方及操作资格由正式冲突接口核对。';
    }else if(origin==='blocked'||/INVALID|MISMATCH|CORRUPT|NOT_FOUND/.test(reason)){
      category='TECHNICAL';title='系统绑定提示';explanation='此项尚缺可靠绑定，不开放取舍或修改操作。';
    }else{category='MATERIAL';title='对象关联材料待补';explanation='尚未绑定可比较的双方，保留原记录供核对，不要求您猜测身份。';}
    const id=record.decision_ref??record.pair_ref??record.candidate_ref??`pending-${category.toLowerCase()}-${index}`;
    const aliases=legacy&&['pending','blocked'].includes(origin)?[record.decision_ref??record.pair_ref??'identity-issue-'+index]:[];
    return {id,category,title,explanation,reason_code:reason,record,origin,legacy_aliases:aliases,
      knowledge_refs:source.knowledge_refs,source_record:source.source_record,binding_issue:source.binding_issue,
      sides:category==='IDENTITY'?[ends.left_record,ends.right_record]:category==='DEFINITION'&&ends.definition_pair?[ends.definition_left,ends.definition_right].map(id=>list(ontology.definitions).find(d=>(d.definition_ref??d.id)===id)):category==='FACT'?[record.left_ref,record.right_ref].map(id=>knowledge.find(k=>ref(k)===id)).filter(Boolean):[],read_only:true,allowed_actions:[]};
  });
  return {policy:PENDING_CLASSIFICATION_POLICY,entries,
    identity_pairs:entries.filter(e=>e.category==='IDENTITY').map(e=>e.record),
    definition_candidates:entries.filter(e=>e.category==='DEFINITION').map(e=>e.record),
    fact_conflicts:entries.filter(e=>e.category==='FACT').map(e=>e.record),
    material_issues:entries.filter(e=>e.category==='MATERIAL').map(e=>e.record),
    technical_issues:entries.filter(e=>e.category==='TECHNICAL').map(e=>e.record),
    counts:Object.fromEntries(['IDENTITY','DEFINITION','FACT','MATERIAL','TECHNICAL'].map(c=>[c,entries.filter(e=>e.category===c).length]))};
}

export function readNativePendingClassification(library) {
  const old=library?.pending_classification_policy!==PENDING_CLASSIFICATION_POLICY;
  const rows=[...list(library?.identity?.pending).map(record=>({record,origin:'pending'})),
    ...list(library?.identity?.blocked).map(record=>({record,origin:'blocked'})),
    ...list(library?.ontology?.candidates).map(record=>({record,origin:'ontology'})),
    ...list(library?.pending_issues).map(record=>({record,origin:'system'}))];
  return partitionNativePendingItems(rows,{knowledge:library?.knowledge,identity:library?.identity,ontology:library?.ontology,legacy:old});
}

/** Only the current formal response can authorize a form; historical material is always read-only. */
export function qualifyPendingConflictReview(review,model,{writable=false,supportedKinds=['FACT'],supportedActions=null}={}) {
  const issues=[],items=list(review?.items).map(item=>{
    const sides=list(item.comparison?.sides),binding=item.comparison?.binding_status==='BOUND'&&sides.length===2&&
      text(sides[0].object_ref)&&text(sides[1].object_ref)&&sides[0].object_ref!==sides[1].object_ref;
    const actual=side=>item.kind==='FACT'?model?.knowledgeById?.get(side.object_ref)?.record:
      item.kind==='DEFINITION'?model?.definitionById?.get(side.object_ref)?.record:
        [...list(model?.library_knowledge?.identity?.profiles),...list(model?.library_knowledge?.identity?.entities)].find(r=>r.id===side.object_ref);
    const sideReady=binding&&sides.every(side=>actual(side)&&text(side.text??side.record?.text??side.record?.statement??side.record?.description)&&
      list(side.source_refs).some(s=>text(s.doc_ref)&&text(s.revision)&&
        model?.documentByKey?.get(s.doc_ref+'@'+s.revision)?.revision_namespace==='FROZEN_SOURCE')&&
      JSON.stringify(ordered(side.record))===JSON.stringify(ordered(actual(side))));
    const readable=v=>text(v)&&!(/^[A-Z0-9_]+$/).test(v);
    const reported=item.reported_actions??list(item.allowed_actions),semanticQueue=item.semantic_queue??item.classification?.queue;
    const question=readable(item.classification?.reason)&&readable(item.recommendation),supported=supportedKinds.includes(item.kind)?reported
      .filter(a=>['keep_left','keep_right','keep_both','defer','recognition_correction','reality_change','same','different','unify','keep_separate'].includes(a)&&(!supportedActions||supportedActions.includes(a))):[],
      enabled=writable&&binding&&sideReady&&question&&supported.length>0&&semanticQueue==='HUMAN';
    const reason=!binding?'比较双方尚未可靠绑定。':!sideReady?'双方说明或可追溯依据尚未齐备，先由系统补充。':!question?'尚未形成明确业务问题与建议。':!supported.length||!writable?'当前后端尚未确认此项可执行能力。':null;
    if(reason)issues.push({item_ref:item.item_ref,reason});
    return {...item,reported_actions:reported,semantic_queue:semanticQueue,allowed_actions:enabled?supported:[],readiness:{can_decide:enabled,reason},
      classification:{...item.classification,queue:semanticQueue==='HUMAN'?(enabled?'HUMAN':'PENDING'):semanticQueue},
      sources_qualified:sideReady};
  });
  return {...review,items,writable:writable===true,qualification_issues:issues,
    summary:{...review?.summary,total_items:items.length,needs_material:issues.length,human:items.filter(i=>i.classification?.queue==='HUMAN'&&i.readiness.can_decide).length}};
}

export function resolvePendingRoute(model,itemId,formalItems=[]) {
  if(!text(itemId))return {kind:'NONE',item:null};
  const formal=formalItems.find(i=>i.item_ref===itemId);if(formal)return {kind:'FORMAL',item:formal};
  const saved=list(model?.pending_classification?.entries).find(i=>i.id===itemId||i.legacy_aliases.includes(itemId));
  return saved?{kind:'READ_ONLY',item:saved,legacy:saved.id!==itemId}:{kind:'STALE',item:null};
}

/** Current-view remains a distinct model; only an explicit server-verified document origin enables document APIs. */
export function lightogDocumentReviewContext(model){
 const library=model?.library_knowledge;if(model?.library_state?.status!=='READY'||!library)return null;
 if(['LIBRARY_KNOWLEDGE_V1','SIMPLIFIED_LIBRARY_KNOWLEDGE_V1'].includes(library.policy)&&/^nrun_[a-f0-9]{32}$/.test(library.run_id??''))return {libraryId:library.library_id,runId:library.run_id,revisionRef:library.revision_ref,recordSha256:library.record_sha256,simplified:library.policy==='SIMPLIFIED_LIBRARY_KNOWLEDGE_V1'};
 const binding=library.document_review_binding;
 if(library.policy!=='MEMORY_CURRENT_VIEW_V1'||binding?.policy!=='NATIVE_DOCUMENT_REVIEW_BINDING_V1'||binding.build_flow_policy!=='SIMPLIFIED_SOURCE_BLOCK_V1'||!/^nrun_[a-f0-9]{32}$/.test(binding.document_run_id??'')||binding.library_id!==library.library_id||binding.revision_ref!==library.revision_ref||binding.record_sha256!==library.record_sha256||binding.source_snapshot_ref!==library.source_snapshot_ref)return null;
 return {libraryId:binding.library_id,runId:binding.document_run_id,revisionRef:binding.revision_ref,recordSha256:binding.record_sha256,simplified:true};
}
