/** Independent action staging. No NLP, database, provider, or publication side effects. */
import {hash,clone,need,textField} from './cq-discovery-store-v2.mjs';
import {bindNativeActionEvidence} from './native-action-evidence-binding-v1.mjs';
export const ACTION_BUILD_POLICY='ACTION_EXPERIENCE_DRAFT_V1';
export const ACTION_RECORD_TYPES=Object.freeze({action:'ACTION_OCCURRENCE',state:'STATE_ASSERTION',observation:'OBSERVATION',evaluation:'EVALUATION',process:'RECORDED_PROCESS',definition:'ACTION_DEFINITION',text:'SOURCE_STATEMENT'});
const phases={SUGGESTED:'SUGGESTED','建议':'SUGGESTED',PLANNED:'PLANNED','计划':'PLANNED',ATTEMPTED:'ATTEMPTED','尝试':'ATTEMPTED',IN_PROGRESS:'IN_PROGRESS','进行中':'IN_PROGRESS',COMPLETED:'COMPLETED','完成':'COMPLETED',FAILED:'FAILED','失败':'FAILED',PARTIALLY_COMPLETED:'PARTIALLY_COMPLETED','部分完成':'PARTIALLY_COMPLETED',UNKNOWN:'UNKNOWN'};
export const actionPhase=value=>Object.hasOwn(phases,value)?phases[value]:'UNKNOWN';
const actual=new Set(['ATTEMPTED','IN_PROGRESS','COMPLETED','FAILED','PARTIALLY_COMPLETED']);
const list=v=>Array.isArray(v)?v:[];
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const sourceKinds=new Set(['DOCUMENT','HUMAN_TEXT','HUMAN_REPORT','AGENT_REPORT','TOOL_RECEIPT','MEASUREMENT_REPORT']);
const duplicateKeys=(rows,key)=>{const counts=new Map();for(const row of rows){const ref=row?.[key];counts.set(ref,(counts.get(ref)??0)+1);}return new Set([...counts].filter(([,count])=>count>1).map(([ref])=>ref));};

/** sourceRecords and semanticItems are Host-bound inputs, never model-selected registries. */
export function prepareNativeActionBatch({libraryId,requestId,sourceRecords,semanticItems,proposals}){
 need(textField(libraryId)&&textField(requestId)&&Array.isArray(sourceRecords)&&Array.isArray(semanticItems)&&Array.isArray(proposals),'NATIVE_ACTION_INPUT_INVALID');
 const sources=new Map(),semantics=new Map(),resolvedEvidence=new Map(),inputGaps=[],evidenceWarnings=[];
 // Bad content is locally retained. Duplicate handles are ambiguous, never last-writer-wins.
 const duplicateSources=duplicateKeys(sourceRecords,'source_record_ref'),duplicateSemantics=duplicateKeys(semanticItems,'semantic_ref'),duplicateProposals=duplicateKeys(proposals,'local_ref');
 for(const source of sourceRecords)try{need(object(source)&&textField(source.source_record_ref)&&source.library_id===libraryId&&textField(source.revision)&&typeof source.text==='string'&&sourceKinds.has(source.source_kind)&&!duplicateSources.has(source.source_record_ref),'NATIVE_ACTION_SOURCE_BINDING_INVALID');sources.set(source.source_record_ref,clone(source));}catch(error){inputGaps.push({kind:'SOURCE',raw:clone(source),reason:error.code});}
 for(const item of semanticItems)try{need(object(item)&&textField(item.semantic_ref)&&item.library_id===libraryId&&textField(item.text)&&!duplicateSemantics.has(item.semantic_ref)&&list(item.evidence).length>0,'NATIVE_ACTION_SEMANTIC_BINDING_INVALID');
  const bound=item.evidence.map(evidence=>bindNativeActionEvidence(sources.get(evidence?.source_record_ref),evidence));
  resolvedEvidence.set(item.semantic_ref,bound);
  for(const evidence of bound)if(evidence.evidence_binding.status!=='EXACT')evidenceWarnings.push({semantic_ref:item.semantic_ref,
    source_record_ref:evidence.source_record_ref,status:evidence.evidence_binding.status,proof_scope:evidence.evidence_binding.proof_scope});
  semantics.set(item.semantic_ref,clone(item));
 }catch(error){inputGaps.push({kind:'SEMANTIC',raw:clone(item),reason:error.code});}
 const drafts=[],retained=[],seen=new Set();
 for(const [index,proposal] of proposals.entries())try{
  need(object(proposal)&&textField(proposal.local_ref)&&!seen.has(proposal.local_ref)&&!duplicateProposals.has(proposal.local_ref),'NATIVE_ACTION_LOCAL_REFERENCE_INVALID');seen.add(proposal.local_ref);
  const selected=list(proposal.semantic_refs).map(ref=>semantics.get(ref));need(selected.length>0&&selected.every(Boolean),'NATIVE_ACTION_SEMANTIC_REFERENCE_UNKNOWN');
  const text=proposal.text??proposal.statement;need(textField(text),'NATIVE_ACTION_TEXT_REQUIRED');
  const recordType=Object.hasOwn(ACTION_RECORD_TYPES,proposal.category)?ACTION_RECORD_TYPES[proposal.category]:null;need(recordType,'NATIVE_ACTION_CATEGORY_UNSUPPORTED');
  const warnings=[],evidence=[...new Map(selected.flatMap(s=>resolvedEvidence.get(s.semantic_ref)).map(e=>[hash(e),e])).values()],origins=[...new Map(evidence.map(e=>{const source=sources.get(e.source_record_ref);return [source.source_record_ref,{source_record_ref:source.source_record_ref,revision:source.revision,source_kind:source.source_kind,reporter:clone(source.reporter??null),source_ingested_at:source.source_ingested_at??null,receipt:clone(source.receipt??null)}];})).values()];
  for(const item of evidence)if(item.evidence_binding.status!=='EXACT')warnings.push('NATIVE_ACTION_QUOTE_'+item.evidence_binding.status);
  const business=clone(object(proposal.business)?proposal.business:{}),payload={text,business};
  if(proposal.business!==undefined&&!object(proposal.business))warnings.push('BUSINESS_SHAPE_RETAINED_RAW');
  let phase=actionPhase(business.action_phase),reportedExecution=false;
  if(recordType==='ACTION_OCCURRENCE'){
   if(phase==='UNKNOWN')warnings.push('ACTION_PHASE_UNRESOLVED');
   const hints=selected.map(s=>actionPhase(s.action_phase)).filter(p=>p!=='UNKNOWN');
   if(hints.some(p=>p!==phase)){warnings.push('ACTION_PHASE_CONFLICT');phase='UNKNOWN';}
   if(!hints.length)warnings.push('ACTION_PHASE_NOT_CROSSCHECKED');
   reportedExecution=actual.has(phase)&&proposal.negation!==true;
   if(proposal.negation===true)warnings.push('NEGATED_ACTION_NOT_EXECUTION');
   payload.action_phase=phase;payload.execution_claim=reportedExecution?'REPORTED':'NOT_ASSERTED';
   payload.execution_evidence=reportedExecution?origins.map(o=>({source_record_ref:o.source_record_ref,report_kind:o.source_kind,receipt_ref:o.source_kind==='TOOL_RECEIPT'?o.receipt?.receipt_ref??null:null,claim_scope:'EXECUTION_ONLY'})):[];
   payload.business_effect='NOT_INFERRED';
  }
  if(recordType==='OBSERVATION'){payload.measurement_scope='REPORTED_OBSERVATION_ONLY';if(!business.subject||!business.property)warnings.push('OBSERVATION_SCOPE_INCOMPLETE');}
  if(recordType==='EVALUATION'){payload.evaluation_status=business.criteria&&list(business.basis_refs).length?'PROPOSED_BASIS_REQUIRES_BINDING':'REPORTED_UNBOUND';if(!business.criteria)warnings.push('EVALUATION_CRITERIA_MISSING');}
  const modality=recordType==='ACTION_OCCURRENCE'?(phase==='PLANNED'?'PLANNED':phase==='SUGGESTED'?'SUGGESTED':phase==='UNKNOWN'?'UNKNOWN':'STATED'):proposal.modality??'STATED';
  const draft={policy:ACTION_BUILD_POLICY,draft_ref:'action_draft_'+hash([libraryId,requestId,proposal.local_ref]),library_id:libraryId,local_ref:proposal.local_ref,record_type:recordType,payload,modality,negation:proposal.negation===true,conditions:clone(proposal.conditions??[]),uncertainties:clone(proposal.uncertainties??[]),time_proposal:{time_text:clone(proposal.time_text??null),...(proposal.valid_time!==undefined?{valid_time:clone(proposal.valid_time)}:{})},evidence:clone(evidence),source_origins:origins,semantic_lineage:clone(selected),raw_proposal:clone(proposal),warnings,semantic_support:'PROPOSED_NOT_TRUTH_VERIFIED'};
  draft.content_sha256=hash(draft);drafts.push(draft);
 }catch(error){retained.push({index,raw:clone(proposal),reason:error.code??'NATIVE_ACTION_PROPOSAL_INVALID',saved:false});}
 const body={policy:ACTION_BUILD_POLICY,library_id:libraryId,request_id:requestId,input_sha256:hash({sourceRecords,semanticItems,proposals}),drafts,retained,input_gaps:inputGaps,evidence_warnings:evidenceWarnings,counts:{received:proposals.length,organized:drafts.length,retained:retained.length},scope:'STAGING_ONLY_NOT_PUBLISHED'};
 return {...body,record_sha256:hash(body)};
}

export function verifyNativeActionDraft(draft){const {content_sha256,...body}=draft??{};need(content_sha256===hash(body),'NATIVE_ACTION_DRAFT_CHANGED');return clone(draft);}
