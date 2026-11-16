/** Deterministic pending-item projection and scoped semantic-analysis contracts. No I/O. */
import {clone,hash,need,textField} from './cq-discovery-store-v2.mjs';
import {libraryNameKey,definitionScopeSignature,prepareDefinitionUnification,collectLibraryOntologyShapes,
  resolveLibraryDefinitionShapes,libraryShapeSignature} from './native-library-knowledge-v1.mjs';

export const LIBRARY_PENDING_ANALYSIS_RECORD='native_library_pending_analysis_v1';
export const LIBRARY_PENDING_ANALYSIS_POLICY='LIBRARY_PENDING_ANALYSIS_V1';
export const LIBRARY_PENDING_ANALYSIS_TASK_VERSION='LIBRARY_PENDING_ANALYSIS_TARGET_COVERAGE_V2';
export const LIBRARY_PENDING_SOURCE_SELECTOR_POLICY='BOUND_DIRECTORY_OR_CANONICAL_DOC_REF_V1';
const CANDIDATE_STRATEGY='BOUND_TARGETS_THEN_SAME_NAME_THEN_DIRECTORY_V1';
const array=value=>Array.isArray(value)?value:[];
const unique=values=>[...new Set(values)];
const signed=body=>({...body,record_sha256:hash(body)});
const checked=(record,code)=>{const {record_sha256,...body}=record??{};need(record&&record_sha256===hash(body),code);return record;};
const definitionRef=side=>side.definition_ref??side.object_ref;
const inputBinding=revision=>({library_id:revision.library_id,run_id:revision.run_id,source_snapshot_ref:revision.source_snapshot_ref,
  revision_ref:revision.revision_ref,revision_sha256:revision.record_sha256});
const signatureFields=['kind','name','description','domains','ranges','parents','datatype','unit','mapping_direction','attribute_owner'];
const candidateToken=ref=>'C'+hash(ref).slice(0,12);
const definitionsOf=revision=>array(revision.ontology?.definitions);
const shapeCache=new WeakMap();
function revisionShapes(revision){let entry=shapeCache.get(revision);if(!entry||entry.sha!==revision.record_sha256){
  entry={sha:revision.record_sha256,shapes:collectLibraryOntologyShapes(revision.knowledge,revision.identity)};shapeCache.set(revision,entry);}return entry.shapes;}
function sourceBundle(records){
  const refs=[...new Map(records.flatMap(r=>array(r.source_refs)).map(r=>[hash(r),clone(r)])).values()],
    evidence=[...new Map(records.flatMap(r=>array(r.evidence)).map(e=>[hash(e),clone(e)])).values()];
  return {source_refs:refs,evidence,sources:refs.map(source=>({...clone(source),precision:evidence.some(e=>e.doc_ref===source.doc_ref&&e.revision===source.revision&&Number.isSafeInteger(e.start??e.span?.start))?'EXACT_SPAN':'DOCUMENT_ONLY'})),
    evidence_nature:records.some(r=>r.origin_layer==='HUMAN_CORRECTION')?'MIXED_WITH_HUMAN_STATEMENT':'SAVED_SOURCE_ASSOCIATION'};
}
function definitionSide(revision,definition,role){
  const knowledgeRefs=clone(definition.knowledge_refs??[]),records=array(revision.knowledge).filter(r=>knowledgeRefs.includes(r.knowledge_ref??r.record_ref)),observed=resolveLibraryDefinitionShapes(definition,revisionShapes(revision));
  return {role,object_ref:definition.definition_ref,definition_ref:definition.definition_ref,object_sha256:hash(definition),
    definition_sha256:hash(definition),revision_ref:revision.revision_ref,...Object.fromEntries(signatureFields.filter(k=>definition[k]!==undefined).map(k=>[k,clone(definition[k])])),
    definition:clone(definition),attribute_owner:clone(definition.attribute_owner??null),scope_signature:definitionScopeSignature(definition),knowledge_refs:knowledgeRefs,
    observed_shapes:observed.shapes.map(s=>({shape_ref:s.shape_ref,shape_signature:libraryShapeSignature(s),kind:s.kind,label:s.label,
      owner_kind:s.subject_kind,owner_relation:clone(s.owner_relation??null),unit:s.unit??null})),binding_reconstruction:clone(observed.overlays),binding_problems:clone(observed.problems),
    knowledge:records.map(r=>({record_ref:r.record_ref??r.knowledge_ref,kind:r.kind,text:r.statement??r.text,
      conditions:clone(r.conditions??null),time_text:r.time_text??null,version_text:r.version_text??null,
      source_refs:clone(r.source_refs??[]),evidence:clone(r.evidence??[]),origin_layer:r.origin_layer??'EXTRACTED_KNOWLEDGE'})),
    ...sourceBundle([definition,...records])};
}
function identitySide(revision,profile,role){return {role,object_ref:profile.id,entity_ref:profile.id,object_sha256:hash(profile),
  revision_ref:revision.revision_ref,name:profile.name,description:array(profile.descriptions).join('\n'),kind:'ENTITY',
  entity:clone(profile),knowledge_refs:clone(profile.knowledge_refs??[]),...sourceBundle([profile])};}
function businessSide(side){return Object.fromEntries(['role','name','description','kind','domains','ranges','parents','datatype','unit','mapping_direction','attribute_owner','knowledge','source_refs','evidence','sources','evidence_nature'].filter(k=>side[k]!==undefined).map(k=>[k,clone(side[k])]));}
function makeComparison(revision,itemRef,sides,{assessment=null,recommendation=null,differences=[],uncertainties=[],candidateKind=null}={}){
  const binding=inputBinding(revision),status=sides.length===2?'BOUND':sides.length>2?'AMBIGUOUS':'MISSING';
  return {policy:'LIBRARY_ITEM_COMPARISON_V1',comparison_ref:'library_item_comparison_'+hash([binding,itemRef,sides.map(s=>[s.object_ref,s.object_sha256])]),
    ...binding,item_ref:itemRef,binding_status:status,sides:clone(sides),assessment,recommendation,differences:clone(differences),
    uncertainties:clone(uncertainties),candidate_kind:candidateKind};
}
function withTargetCapabilities(revision,comparison,writable){
  if(!comparison)return null;
  const targets=array(comparison.sides).filter(side=>textField(side.definition_ref)).map(side=>{
    let result;
    try{result=prepareDefinitionUnification({revision,comparison,selectedDefinitionRef:side.definition_ref});}
    catch(error){result={allowed:false,blocked_reason_codes:[error.code??'DEFINITION_TARGET_VALIDATION_FAILED']};}
    return {definition_ref:side.definition_ref,enabled:writable===true&&result.allowed===true,
      blocked_reason_codes:unique([...array(result.blocked_reason_codes),...(writable===true?[]:['LIBRARY_REVIEW_READ_ONLY'])])};
  });
  return {...clone(comparison),target_capabilities:targets};
}
function baselineComparisons(revision,item){
  if(item.kind==='IDENTITY')return item.left&&item.right?[makeComparison(revision,item.item_ref,
    [identitySide(revision,item.left,'LEFT'),identitySide(revision,item.right,'RIGHT')],{candidateKind:'IDENTITY_CANDIDATE'})]:[];
  if(item.kind!=='DEFINITION')return [];
  const left=definitionsOf(revision).find(d=>d.definition_ref===item.target_ref);if(!left)return [];
  // Stored refs were produced by a literal name lookup. Their reason is not a semantic comparison receipt.
  const refs=unique([...array(left.existing_definition_refs),...definitionsOf(revision).filter(d=>d.definition_ref!==left.definition_ref&&d.kind===left.kind&&libraryNameKey(d.name)===libraryNameKey(left.name)).map(d=>d.definition_ref)]);
  return refs.map(ref=>{const right=definitionsOf(revision).find(d=>d.definition_ref===ref);
    return right?makeComparison(revision,item.item_ref,[definitionSide(revision,left,'LEFT'),definitionSide(revision,right,'RIGHT')],{candidateKind:'SAME_NAME_CANDIDATE'}):
      {...makeComparison(revision,item.item_ref,[definitionSide(revision,left,'LEFT')]),missing_candidate_ref:ref,binding_status:'MISSING'};});
}
function pendingComparisons(revision,item){
  const actual=array(item.comparisons).filter(c=>c?.binding_status==='BOUND'&&c.assessment==null&&c.sides?.length===2&&
    c.item_ref===item.item_ref&&Object.entries(inputBinding(revision)).every(([k,v])=>c[k]===v)&&
    c.sides[0].object_ref===(item.target_ref??item.left?.id)&&c.sides.every(side=>{
      const value=side.definition_ref?definitionsOf(revision).find(d=>d.definition_ref===side.definition_ref):array(revision.identity?.profiles).find(p=>p.id===side.entity_ref);
      return value&&hash(value)===side.object_sha256;
    }));
  return [...new Map([...baselineComparisons(revision,item),...actual].map(c=>[c.comparison_ref,c])).values()];
}
function validReceipt(receipt,hostStopReason){
  if(!textField(receipt?.run_id)||!textField(receipt?.invocation_ref)||receipt.role!=='LOCAL_REVIEW'||receipt.outcome!=='RETURNED')return false;
  if(receipt.status==='SUCCEEDED')return receipt.completion_source==='HOST_ACCEPTED_ROLE_OUTPUT';
  return receipt.status==='PARTIAL'&&receipt.program_partial_output===true&&receipt.completion_source==='PROGRAM_RETAINED_PARTIAL_OUTPUT'&&
    ['HOST_NO_NEW_INFORMATION','HOST_NORMAL_PARTIAL_COMPLETION','HOST_PARTIAL_ANALYSIS_OUTPUT'].includes(hostStopReason);
}
const recordComparisons=record=>Array.isArray(record.comparisons)?record.comparisons:record.comparison?[record.comparison]:[];
function validAnalysis(record,revision,itemRef){
  try{checked(record,'LIBRARY_PENDING_ANALYSIS_CHANGED');return record.policy===LIBRARY_PENDING_ANALYSIS_POLICY&&validReceipt(record.receipt,record.host_stop_reason,record.result)&&
    ['COMPLETED','NO_NEW_INFORMATION','PARTIAL'].includes(record.status)&&record.item_ref===itemRef&&
    Object.entries(inputBinding(revision)).every(([key,value])=>record[key]===value)&&recordComparisons(record).every(comparison=>array(comparison.sides).every(side=>{
      const value=side.definition_ref?definitionsOf(revision).find(d=>d.definition_ref===side.definition_ref):array(revision.identity?.profiles).find(p=>p.id===side.entity_ref);
      return value&&hash(value)===side.object_sha256;
    }));}catch{return false;}
}
function receiptOrder(record){
  const value=record.receipt,valid=value=>Number.isSafeInteger(value)&&value>=0,
    started=valid(value?.started_at)?value.started_at:null,
    ended=valid(value?.ended_at)&&(started===null||value.ended_at>=started)?value.ended_at:null;
  return [ended??started??-1,started??-1];
}
/** Storage order is not chronology. Unknown receipt times use a stable tie, not a claim of recency. */
function orderedAnalyses({revision,itemRef,analysisRecords,currentInputSha256=null,exactInput=false}){
  return array(analysisRecords).filter(record=>validAnalysis(record,revision,itemRef)&&
    (!exactInput||record.input_sha256===currentInputSha256)).sort((a,b)=>{
    const currentA=currentInputSha256!==null&&a.input_sha256===currentInputSha256,
      currentB=currentInputSha256!==null&&b.input_sha256===currentInputSha256,
      [endA,startA]=receiptOrder(a),[endB,startB]=receiptOrder(b);
    return Number(currentB)-Number(currentA)||endB-endA||startB-startA||
      String(a.analysis_ref??'').localeCompare(String(b.analysis_ref??''))||a.record_sha256.localeCompare(b.record_sha256);
  });
}
const preferredComparisons=rows=>{
  const byRef=new Map();for(const row of rows)if(!byRef.has(row.comparison_ref))byRef.set(row.comparison_ref,row);
  return [...byRef.values()];
};

export function prepareLibraryItemAnalysis({revision,items,itemRef,analysisRecords=[],candidateDefinitionRefs=null}){
  checked(revision,'LIBRARY_TRIAGE_REVISION_CHANGED');
  const item=array(items).find(row=>row.item_ref===itemRef);need(item&&item.revision_ref===revision.revision_ref,'LIBRARY_ANALYSIS_ITEM_STALE');
  let focus,candidates=[];
  const originalComparisons=pendingComparisons(revision,item),requiredComparisons=originalComparisons.filter(c=>c.binding_status==='BOUND'&&c.sides.length===2),
    requiredObjects=new Set(requiredComparisons.map(c=>c.sides[1].object_ref)),missingTargets=originalComparisons.filter(c=>c.binding_status==='MISSING').map(c=>c.missing_candidate_ref);
  if(item.kind==='DEFINITION'){
    const definition=definitionsOf(revision).find(d=>d.definition_ref===item.target_ref);need(definition,'LIBRARY_ANALYSIS_DEFINITION_MISSING');
    focus=definitionSide(revision,definition,'LEFT');
    if(candidateDefinitionRefs!==null)need(Array.isArray(candidateDefinitionRefs)&&candidateDefinitionRefs.every(ref=>definitionsOf(revision).some(d=>d.definition_ref===ref&&d.kind===definition.kind&&ref!==definition.definition_ref)),
      'LIBRARY_ANALYSIS_CANDIDATE_INVALID');
    // Explicit bound targets are never dropped by an optional directory selection.
    const rank=d=>requiredObjects.has(d.definition_ref)?0:libraryNameKey(d.name)===libraryNameKey(definition.name)?1:2;
    const selected=definitionsOf(revision).filter(d=>d.definition_ref!==definition.definition_ref&&(d.kind===definition.kind||requiredObjects.has(d.definition_ref))&&
      (candidateDefinitionRefs===null||candidateDefinitionRefs.includes(d.definition_ref)||requiredObjects.has(d.definition_ref)))
      .sort((a,b)=>rank(a)-rank(b)||libraryNameKey(a.name).localeCompare(libraryNameKey(b.name))||a.definition_ref.localeCompare(b.definition_ref));
    candidates=selected.map(d=>({...definitionSide(revision,d,'RIGHT'),candidate_ref:candidateToken(d.definition_ref),
      candidate_kind:requiredObjects.has(d.definition_ref)?'BOUND_REVIEW_TARGET':libraryNameKey(d.name)===libraryNameKey(definition.name)?'SAME_NAME_CANDIDATE':'AVAILABLE_DEFINITION'}));
  }else if(item.kind==='IDENTITY'){
    need(item.left&&item.right,'LIBRARY_ANALYSIS_IDENTITY_MISSING');focus=identitySide(revision,item.left,'LEFT');
    candidates=[{...identitySide(revision,item.right,'RIGHT'),candidate_ref:candidateToken(item.right.id),candidate_kind:'IDENTITY_CANDIDATE'}];
  }else need(false,'LIBRARY_ANALYSIS_ITEM_UNSUPPORTED');
  const requiredCandidateRefs=candidates.filter(c=>requiredObjects.has(c.object_ref)).map(c=>c.candidate_ref),
    required=requiredComparisons.map(c=>({comparison_ref:c.comparison_ref,candidate_ref:candidateToken(c.sides[1].object_ref),
      sides:c.sides.map(s=>({object_ref:s.object_ref,object_sha256:s.object_sha256}))})),
    pendingReason=textField(item.definition?.reason)?item.definition.reason:null,
    task={review_question:required.length?'澄清本项与实际关联候选的含义和适用范围是否相同，或是否存在需要业务选择的差异。':'寻找可实际绑定的相关定义；排除目录中的其他定义只形成局部观察，不代表原疑点已澄清。',
      unverified_pending_reason:pendingReason,pending_reason_is_verified:false,
      required_candidates:requiredCandidateRefs,
      source_reading_instruction:'补读关联原文时，可使用文档目录中的 document_ref，或对应 source_refs 中的 doc_ref；程序将二者限定到同一份已绑定原文。',
      instruction:'优先比较原待核候选；同名和历史说明仅是线索，不证明等价。可按需读取其他候选与原文。仅报告实际比较范围，无新信息可以结束，不要求读完整个目录。'},
    binding=inputBinding(revision),body={policy:'LIBRARY_PENDING_ANALYSIS_INPUT_V1',...binding,item_ref:itemRef,item_kind:item.kind,
    task_version:LIBRARY_PENDING_ANALYSIS_TASK_VERSION,candidate_strategy:CANDIDATE_STRATEGY,
    source_selector_policy:LIBRARY_PENDING_SOURCE_SELECTOR_POLICY,task,
    required_candidate_refs:requiredCandidateRefs,required_comparisons:required,missing_target_refs:missingTargets,
    focus,candidates,knowledge_refs:unique([...(focus.knowledge_refs??[]),...candidates.flatMap(c=>c.knowledge_refs??[])]),
    source_refs:[...new Map([...(focus.source_refs??[]),...candidates.flatMap(c=>c.source_refs??[])].map(s=>[hash(s),s])).values()]};
  const inputSha=hash(body),reusable=orderedAnalyses({revision,itemRef,analysisRecords,currentInputSha256:inputSha,exactInput:true})[0]??null,
    technicalOnly=item.kind==='DEFINITION'&&candidateDefinitionRefs===null&&!textField(item.definition?.reason)&&!baselineComparisons(revision,item).length;
  return signed({...body,input_sha256:inputSha,comparison_ref:'library_analysis_input_'+inputSha,
    can_start:!reusable&&!technicalOnly,blocked_reason_codes:reusable?['LIBRARY_ANALYSIS_SAME_INPUT_ALREADY_OBSERVED']:technicalOnly?['LIBRARY_ANALYSIS_SYSTEM_METADATA_ONLY']:[],reusable_record:reusable?clone(reusable):null,
    model_input:{task:clone(task),candidate_overview:candidates.map(c=>({candidate_ref:c.candidate_ref,name:c.name,kind:c.kind,candidate_kind:c.candidate_kind})),
      focus:businessSide(focus),candidates:candidates.map(c=>({candidate_ref:c.candidate_ref,candidate_kind:c.candidate_kind,...businessSide(c)}))}});
}

export function validateLibraryAnalysisBusinessResult(prepared,result){
  need(result&&typeof result==='object'&&!Array.isArray(result)&&Object.keys(result).every(k=>['assessment','candidate_refs','reason','differences','uncertainties','business_question'].includes(k)),
    'LIBRARY_ANALYSIS_RESULT_FIELDS_INVALID');
  need(['EQUIVALENT','DISTINCT','SCOPE_VARIANT','DOMAIN_CHOICE','INSUFFICIENT'].includes(result.assessment)&&textField(result.reason),
    'LIBRARY_ANALYSIS_RESULT_INVALID');
  need(Array.isArray(result.candidate_refs)&&new Set(result.candidate_refs).size===result.candidate_refs.length&&
    result.candidate_refs.every(ref=>prepared.candidates.some(c=>c.candidate_ref===ref)), 'LIBRARY_ANALYSIS_CANDIDATE_NOT_ISSUED');
  need(result.assessment==='INSUFFICIENT'||result.candidate_refs.length>0,'LIBRARY_ANALYSIS_CHOICE_REQUIRED');
  need(result.business_question===undefined||textField(result.business_question),'LIBRARY_ANALYSIS_RESULT_INVALID');
  if(result.assessment==='DOMAIN_CHOICE')need(textField(result.business_question),'LIBRARY_ANALYSIS_BUSINESS_QUESTION_REQUIRED');
  need(result.differences===undefined||Array.isArray(result.differences)&&result.differences.every(d=>d&&Object.keys(d).every(k=>['dimension','description'].includes(k))&&textField(d.dimension)&&textField(d.description)),
    'LIBRARY_ANALYSIS_DIFFERENCES_INVALID');
  need(result.uncertainties===undefined||Array.isArray(result.uncertainties)&&result.uncertainties.every(textField),'LIBRARY_ANALYSIS_RESULT_INVALID');
  return {...clone(result),differences:clone(result.differences??[]),uncertainties:clone(result.uncertainties??[])};
}

function normalizeObservations(prepared,observations){
  need(Array.isArray(observations),'LIBRARY_ANALYSIS_OBSERVATIONS_INVALID');
  const seen=new Set();return observations.map(value=>validateLibraryAnalysisBusinessResult(prepared,value)).filter(value=>{
    const key=hash(value);if(seen.has(key))return false;seen.add(key);return true;
  });
}
/** Host-owned scope accounting. Issuing or reading a candidate is not an assessment. */
export function computeLibraryAnalysisCoverage({prepared,observations=[],deliveredCandidateRefs=[]}){
  checked(prepared,'LIBRARY_ANALYSIS_INPUT_CHANGED');
  need(Array.isArray(deliveredCandidateRefs)&&deliveredCandidateRefs.every(ref=>prepared.candidates.some(c=>c.candidate_ref===ref)),
    'LIBRARY_ANALYSIS_DELIVERY_INVALID');
  const normalized=normalizeObservations(prepared,observations),delivered=new Set(deliveredCandidateRefs);
  need(normalized.every(row=>row.candidate_refs.every(ref=>delivered.has(ref))),'LIBRARY_ANALYSIS_CANDIDATE_NOT_READ');
  const latestByCandidate=new Map();for(const row of normalized)for(const ref of row.candidate_refs)latestByCandidate.set(ref,row);
  const assessed=new Set([...latestByCandidate].filter(([,row])=>row.assessment!=='INSUFFICIENT').map(([ref])=>ref)),
    required=unique(array(prepared.required_candidate_refs)),remaining=required.filter(ref=>!assessed.has(ref)),
    taskCovered=required.length>0&&!remaining.length&&!array(prepared.missing_target_refs).length,
    ordered=set=>prepared.candidates.filter(c=>set.has(c.candidate_ref)).map(c=>c.candidate_ref);
  return {policy:'LIBRARY_ANALYSIS_COVERAGE_V1',task_version:prepared.task_version??null,
    required_candidate_refs:required,delivered_candidate_refs:ordered(delivered),assessed_candidate_refs:ordered(assessed),
    remaining_candidate_refs:remaining,unread_required_candidate_refs:required.filter(ref=>!delivered.has(ref)),
    missing_target_refs:clone(prepared.missing_target_refs??[]),task_covered:taskCovered,
    status:taskCovered?'COVERED':!required.length?'NO_BOUND_TARGET':assessed.size?'PARTIAL':'NOT_ASSESSED'};
}
function observationComparisons(prepared,observations,revision){
  const rows=new Map();
  for(const observation of observations)for(const ref of observation.candidate_refs){
    const candidate=prepared.candidates.find(c=>c.candidate_ref===ref);if(!candidate)continue;
    const comparison=makeComparison(revision,prepared.item_ref,[prepared.focus,candidate],{assessment:observation.assessment,
      recommendation:observation.assessment==='EQUIVALENT'?'UNIFY':['DISTINCT','SCOPE_VARIANT'].includes(observation.assessment)?'KEEP_SEPARATE':observation.assessment==='DOMAIN_CHOICE'?'DOMAIN_CHOICE':null,
      differences:observation.differences,uncertainties:observation.uncertainties,candidateKind:'SEMANTIC_CANDIDATE'});
    // Retain distinct original observations; every actionable projection still has exactly two real sides.
    rows.set(comparison.comparison_ref,{...comparison,candidate_ref:ref,
      observation_ref:'library_analysis_observation_'+hash(observation),reason:observation.reason,
      ...(observation.business_question?{business_question:observation.business_question}:{})});
  }
  return [...rows.values()];
}
function qualificationFor(record,coverage,observations){
  return {status:coverage.task_covered?'TARGET_COVERED':observations.some(row=>row.assessment!=='INSUFFICIENT')?'LOCAL_OBSERVATION_ONLY':'NO_NEW_INFORMATION',
    task_covered:coverage.task_covered,legacy_record:!record.task_version,original_status:record.status,
    original_unresolved:record.unresolved,reason_codes:coverage.task_covered?[]:
      [coverage.required_candidate_refs.length?'ORIGINAL_TARGETS_UNASSESSED':'NO_BOUND_TARGET']};
}
function qualifyAnalysis(record,prepared,revision){
  const observations=normalizeObservations(prepared,Array.isArray(record.observations)?record.observations:record.result?[record.result]:[]),
    // Legacy SAVE accepted only delivered refs. This does not imply that any other issued ref was read.
    delivered=record.coverage?.delivered_candidate_refs??unique(observations.flatMap(row=>row.candidate_refs)),
    coverage=computeLibraryAnalysisCoverage({prepared,observations,deliveredCandidateRefs:delivered});
  return {observations,coverage,qualification:qualificationFor(record,coverage,observations),
    comparisons:observationComparisons(prepared,observations,revision)};
}

export function acceptLibraryItemAnalysis({prepared,result,observations,deliveredCandidateRefs,sourceReadSummary=null,
  receipt,currentRevision,existingRecords=[],readContextHashes=[],hostStopReason=null}){
  checked(prepared,'LIBRARY_ANALYSIS_INPUT_CHANGED');checked(currentRevision,'LIBRARY_TRIAGE_REVISION_CHANGED');
  need(hash(inputBinding(currentRevision))===hash(Object.fromEntries(Object.keys(inputBinding(currentRevision)).map(k=>[k,prepared[k]]))), 'LIBRARY_ANALYSIS_REVISION_STALE');
  const normalized=normalizeObservations(prepared,observations??(result?[result]:[])),
    delivered=deliveredCandidateRefs??(observations===undefined?unique(normalized.flatMap(row=>row.candidate_refs)):[]),
    coverage=computeLibraryAnalysisCoverage({prepared,observations:normalized,deliveredCandidateRefs:delivered});
  need(validReceipt(receipt,hostStopReason,normalized.at(-1)),'LIBRARY_ANALYSIS_RUNTIME_UNCONFIRMED');
  const previous=orderedAnalyses({revision:currentRevision,itemRef:prepared.item_ref,analysisRecords:existingRecords,
    currentInputSha256:prepared.input_sha256,exactInput:true})[0];
  if(previous)return clone(previous);
  const comparisons=observationComparisons(prepared,normalized,currentRevision),
    hasAssessment=normalized.some(row=>row.assessment!=='INSUFFICIENT'),
    status=coverage.task_covered?'COMPLETED':hasAssessment?'PARTIAL':'NO_NEW_INFORMATION';
  const body={policy:LIBRARY_PENDING_ANALYSIS_POLICY,record_kind:LIBRARY_PENDING_ANALYSIS_RECORD,...inputBinding(currentRevision),
    item_ref:prepared.item_ref,item_kind:prepared.item_kind,input_sha256:prepared.input_sha256,source_comparison_ref:prepared.comparison_ref,
    task_version:prepared.task_version,candidate_strategy:prepared.candidate_strategy,source_selector_policy:prepared.source_selector_policy,
    status,result:clone(normalized.at(-1)??null),observations:normalized,comparisons,
    comparison:comparisons.length===1?comparisons[0]:null,coverage,source_read_summary:clone(sourceReadSummary),
    read_context_hashes:unique(readContextHashes).sort(),receipt:clone(receipt),host_stop_reason:hostStopReason,
    business_progress_sha256:hash({assessments:normalized.map(row=>({assessment:row.assessment,candidate_refs:row.candidate_refs})),
      coverage,read_context_hashes:unique(readContextHashes).sort()}),
    unresolved:!coverage.task_covered||normalized.some(row=>row.assessment==='DOMAIN_CHOICE'),application_effect:'NONE',can_start:false};
  body.qualification=qualificationFor(body,coverage,normalized);
  return signed({...body,analysis_ref:'library_pending_analysis_'+hash(body)});
}

export function resolveLibraryItemComparison({revision,items,itemRef,comparisonRef,analysisRecords=[]}){
  const item=array(items).find(row=>row.item_ref===itemRef);if(!item)return null;
  const prepared=prepareLibraryItemAnalysis({revision,items,itemRef,analysisRecords:[]}),
    comparisons=preferredComparisons([...orderedAnalyses({revision,itemRef,analysisRecords,currentInputSha256:prepared.input_sha256})
      .flatMap(r=>qualifyAnalysis(r,prepared,revision).comparisons),...baselineComparisons(revision,item)]);
  return clone(comparisons.find(c=>c?.comparison_ref===comparisonRef&&c.binding_status==='BOUND')??null);
}

export function annotateLibraryReviewTriage({review,revision,analysisRecords=[]}){
  checked(revision,'LIBRARY_TRIAGE_REVISION_CHANGED');
  need(review.library_id===revision.library_id&&review.run_id===revision.run_id&&review.revision_ref===revision.revision_ref&&review.source_snapshot_ref===revision.source_snapshot_ref,'LIBRARY_TRIAGE_BINDING_CHANGED');
  const items=array(review.items).map(item=>{
    let records=orderedAnalyses({revision,itemRef:item.item_ref,analysisRecords});
    const qualified=[];
    let prepared=null,qualificationInvalid=false;
    if(['DEFINITION','IDENTITY'].includes(item.kind)&&(records.length||item.status!=='RESOLVED'))try{
      prepared=prepareLibraryItemAnalysis({revision,items:review.items,itemRef:item.item_ref,analysisRecords});
      records=orderedAnalyses({revision,itemRef:item.item_ref,analysisRecords,currentInputSha256:prepared.input_sha256});
      for(const record of records)try{qualified.push({record,...qualifyAnalysis(record,prepared,revision)});}catch{qualificationInvalid=true;}
    }catch{qualificationInvalid=records.length>0;}
    const latest=records[0],latestQualified=qualified[0],latestComparisons=latestQualified?.comparisons??[],
      comparisons=preferredComparisons([...qualified.flatMap(q=>q.comparisons),...baselineComparisons(revision,item)])
        .map(row=>withTargetCapabilities(revision,row,review.writable)),
      domainChoice=latestComparisons.find(c=>c.assessment==='DOMAIN_CHOICE'&&c.binding_status==='BOUND'),
      comparison=withTargetCapabilities(revision,domainChoice??(latestQualified?(latestComparisons.length===1?latestComparisons[0]:null):
        comparisons.length===1?comparisons[0]:comparisons.length?{...comparisons[0],binding_status:'AMBIGUOUS'}:null),review.writable),
      deferred=item.latest_event&&['defer','uncertain'].includes(item.latest_event.action),
      decisionState=item.application_status==='PENDING_APPLICATION'?'PENDING_APPLICATION':deferred?'DEFERRED':item.application_status==='APPLIED'?'APPLIED':item.status==='RESOLVED'?'NONE':'OPEN';
    let queue=item.kind==='KNOWLEDGE'?'DIRECT_EDIT':item.status==='RESOLVED'?'HISTORY':'ANALYSIS',codes=[],question=null;
    const definition=item.definition;
    if(definition){codes.push(...array(definition.alignment_warnings));
      if(array(definition.existing_definition_refs).length)codes.push('LEGACY_SAME_NAME_CANDIDATES_UNASSESSED');
      if(definition.reason&&!latest)codes.push('LEGACY_REASON_HAS_NO_BOUND_SEMANTIC_RECEIPT');
      if(!codes.length&&item.status!=='RESOLVED')codes.push('REQUESTED_PENDING_WITHOUT_BUSINESS_CHOICE');
      if(item.status!=='RESOLVED'&&!comparisons.length&&!textField(definition.reason))queue='SYSTEM';
      if(comparisons.some(c=>c.binding_status==='MISSING')){queue='TECHNICAL';codes.push('COMPARISON_CANDIDATE_MISSING');}
      if(array(definition.binding_reconstruction).length)codes.push('LEGACY_BINDING_RECONSTRUCTION_RECORDED');
      if(comparisons.length&&comparisons.every(c=>c.binding_status==='BOUND'&&c.sides.length===2&&
        libraryNameKey(c.sides[0].name)===libraryNameKey(c.sides[1].name)&&libraryNameKey(c.sides[0].description)===libraryNameKey(c.sides[1].description)&&c.sides[0].scope_signature===c.sides[1].scope_signature)){
        queue='SYSTEM';codes.push('EXACT_DEFINITION_REPRESENTATION_DUPLICATE');
      }
    }
    if(qualificationInvalid||array(analysisRecords).some(r=>r.item_ref===item.item_ref&&r.revision_ref===revision.revision_ref&&!validAnalysis(r,revision,item.item_ref))){
      queue='TECHNICAL';codes.push('LOCAL_ANALYSIS_RECORD_INVALID');
    }
    if(latestQualified&&queue!=='TECHNICAL'&&item.status!=='RESOLVED'){
      if(domainChoice){queue='HUMAN';question=domainChoice.business_question;codes.push('BOUND_DOMAIN_CHOICE');}
      else if(latestQualified.coverage.task_covered){queue='SYSTEM';codes.push('BOUND_LOCAL_ANALYSIS_RECOMMENDATION');}
      else{queue='ANALYSIS';codes.push(latestQualified.qualification.status==='NO_NEW_INFORMATION'?'LOCAL_ANALYSIS_NO_NEW_INFORMATION':'LOCAL_ANALYSIS_TARGETS_UNASSESSED');}
      if(!latestQualified.coverage.task_covered)codes.push(...latestQualified.qualification.reason_codes);
    }
    const actions=[];
    for(const action of array(item.allowed_actions))if(!['unify','keep_separate','exclude'].includes(action)){
      const unsafeAccept=item.kind==='DEFINITION'&&action==='accept'&&(array(definition?.alignment_warnings).length>0||comparisons.length>0||textField(definition?.reason));
      actions.push({action,enabled:review.writable===true&&!unsafeAccept&&!(queue==='TECHNICAL'&&!['defer','revoke'].includes(action)),requires_reason:!['defer','uncertain'].includes(action),effect:item.action_effects?.[action]??(['defer','uncertain'].includes(action)?'STATE_ONLY':'VERSION_CHANGE')});
    }
    if(item.kind==='DEFINITION'){
      const available=comparison?[comparison]:comparisons,
        bound=available.some(c=>c.binding_status==='BOUND'),supported=available.some(c=>c.binding_status==='BOUND'&&array(c.target_capabilities).some(target=>target.enabled));
      actions.push({action:'unify',enabled:review.writable===true&&queue!=='TECHNICAL'&&bound&&supported,requires_reason:true,effect:'VERSION_CHANGE'},
        {action:'keep_separate',enabled:review.writable===true&&queue!=='TECHNICAL'&&bound,requires_reason:false,effect:'VERSION_CHANGE'},
        {action:'exclude',enabled:review.writable===true&&queue!=='TECHNICAL',requires_reason:true,effect:'VERSION_CHANGE'});
    }
    let capability={can_start:false,input_sha256:latest?.input_sha256??null,blocked_reason_codes:[latest?'LIBRARY_ANALYSIS_SAME_INPUT_ALREADY_OBSERVED':'LIBRARY_ANALYSIS_NOT_REQUIRED'],reusable_record:latest?{analysis_ref:latest.analysis_ref,status:latest.status,input_sha256:latest.input_sha256}:null};
    if(['DEFINITION','IDENTITY'].includes(item.kind)&&item.status!=='RESOLVED'&&queue==='ANALYSIS')try{
      const input=prepared??prepareLibraryItemAnalysis({revision,items:review.items,itemRef:item.item_ref,analysisRecords});
      capability={can_start:input.can_start,input_sha256:input.input_sha256,blocked_reason_codes:input.blocked_reason_codes,
        reusable_record:input.reusable_record?{analysis_ref:input.reusable_record.analysis_ref,status:input.reusable_record.status,input_sha256:input.input_sha256}:null};
    }catch(error){capability={...capability,blocked_reason_codes:[error.code??'LIBRARY_ANALYSIS_INPUT_UNAVAILABLE']};}
    const blocked=queue==='TECHNICAL'?unique(codes):comparison?.binding_status==='AMBIGUOUS'?['COMPARISON_AMBIGUOUS']:[];
    return {...clone(item),triage:{queue,reason_codes:unique(codes),business_question:question,decision_state:decisionState,latest_decision_state:deferred?'DEFERRED':decisionState,
      analysis_state:latest?.status??'NOT_STARTED',unresolved:!['HISTORY','DIRECT_EDIT'].includes(queue),affected_refs:{knowledge_refs:clone(definition?.knowledge_refs??(item.kind==='KNOWLEDGE'?[item.target_ref]:unique([...array(item.left?.knowledge_refs),...array(item.right?.knowledge_refs)]))) }},
      comparison,comparisons,analysis_observations:clone(latestQualified?.observations??[]),
      analysis_coverage:clone(latestQualified?.coverage??null),analysis_qualification:clone(latestQualified?.qualification??null),
      analysis_task:prepared?{task_version:prepared.task_version,...clone(prepared.task),targets:prepared.candidates.filter(c=>prepared.required_candidate_refs.includes(c.candidate_ref))
        .map(c=>({candidate_ref:c.candidate_ref,name:c.name,kind:c.kind,description:c.description}))}:null,
      readiness:{can_decide:queue!=='TECHNICAL'&&actions.some(a=>a.enabled&&!['defer','uncertain'].includes(a.action)),blocked_reason_codes:blocked,actions},analysis_capability:capability};
  });
  const queues=Object.fromEntries(['HUMAN','SYSTEM','ANALYSIS','TECHNICAL','HISTORY','DIRECT_EDIT'].map(queue=>[queue,items.filter(i=>i.triage.queue===queue).length]));
  return {...clone(review),items,summary:{...clone(review.summary),triage:{queues,human_required:items.filter(i=>i.triage.queue==='HUMAN'&&i.triage.decision_state==='OPEN').length,
    deferred:items.filter(i=>i.triage.decision_state==='DEFERRED').length,pending_application:items.filter(i=>i.triage.decision_state==='PENDING_APPLICATION').length}}};
}
