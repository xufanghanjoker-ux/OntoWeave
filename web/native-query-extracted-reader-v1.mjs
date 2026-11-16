/** Product reader over the active canonical EXTRACTED graph and existing indexes.
 * No build, adoption, entity merge, document embedding, or source write occurs.
 */
import {canonical,hash,clone,need} from './cq-discovery-store-v2.mjs';
import {collectLibraryOntologyShapes,libraryShapeSignature} from './native-library-knowledge-v1.mjs';
import {createNativeBuildIndex} from './native-build-index-v1.mjs';
import {createNativeQueryView} from './native-query-view-v1.mjs';
import {createNativeQuerySearch} from './native-query-search-v1.mjs';
import {createNativeQueryPager} from './native-query-view-v1.mjs';
import {nativeQueryCore} from './native-query-core-v1.mjs';
import {createQueryPassageReader} from './native-query-passage-read-v1.mjs';
import {createQueryRanking,QUERY_RANKING_REVISION,QUERY_DELIVERY_REVISION} from './native-query-ranking-v2.mjs';
import {isHumanQueryRecord,isMemoryQueryRecord,matchesQuerySources,querySourceMode} from './native-query-source-scope-v1.mjs';
import {createPublicationReadBarrier,createRecordSourceReader,createRecordPassageReader,isMemorySource,memoryActionFields} from './native-query-extracted-reader-memory-v1.mjs';

/** Remove only provenance-bound contributions from a query graph projection.
 * Business values, conditions, source text and historical audit strings are
 * not searched or rewritten. The saved graph remains untouched.
 */
export function qualifyExtractedGraphDetails(graph,excludedRefs){
 const excluded=excludedRefs instanceof Set?excludedRefs:new Set(excludedRefs);
 if(!excluded.size)return clone(graph);
 function contribution(row){
  if(!row||typeof row!=='object')return row;
  if(['record_ref','knowledge_ref'].some(key=>excluded.has(row[key])))return null;
  const result=clone(row);
  for(const key of ['record_refs','knowledge_refs'])if(Array.isArray(row[key])){
   result[key]=row[key].filter(ref=>!excluded.has(ref));
   if(row[key].length&&!result[key].length)return null;
  }
  return result;
 }
 const supported=rows=>rows.map(contribution).filter(row=>row!==null);
 const detail=row=>{const result=contribution(row);if(!result)return result;for(const key of ['attributes','rules'])if(Array.isArray(result[key]))result[key]=supported(result[key]);return result;};
 const result=clone(graph);
 for(const key of ['nodes','edges'])if(Array.isArray(graph[key]))result[key]=graph[key].map(detail).filter(row=>row!==null);
 for(const key of ['knowledge','definitions','observed_definitions'])if(Array.isArray(graph[key]))result[key]=supported(graph[key]);
 // Canonical entity copies also carry current contribution references. Trim
 // those explicit lists without changing identity decisions or mappings.
 if(Array.isArray(result.knowledge))for(const row of result.knowledge)if(Array.isArray(row.domain?.entities))row.domain.entities=supported(row.domain.entities);
 if(graph.identity)for(const key of ['entities','profiles'])if(Array.isArray(graph.identity[key]))result.identity[key]=supported(graph.identity[key]);
 if(graph.ontology)for(const key of ['definitions','definition_mappings','unbound_shapes'])if(Array.isArray(graph.ontology[key]))result.ontology[key]=supported(graph.ontology[key]);
 if(graph.pending)for(const key of ['ontology','unbound'])if(Array.isArray(graph.pending[key]))result.pending[key]=supported(graph.pending[key]);
 return result;
}

export function createNativeExtractedQueryReader({store,libraryId,catalog,publication,rawRecordPort}){
 need(typeof libraryId==='string'&&libraryId.length>0,'QUERY_LIBRARY_SCOPE_REQUIRED');
 const publicationBarrier=createPublicationReadBarrier({publication,libraryId});
 const active=store.getRecord('native_library_knowledge_active_v1',libraryId);need(active,'QUERY_GRAPH_NOT_READY');
 const {run_id:runId,source_snapshot_ref:snapshotId}=active;
 const readOnly={getRecord:(...a)=>store.getRecord(...a),putRecord(){need(false,'QUERY_READ_ONLY');},transaction(){need(false,'QUERY_READ_ONLY');}};
 const key=canonical([libraryId,snapshotId,runId]),payload=prefix=>{const h=store.getRecord('native_'+prefix+'_index_head_v1',key),p=h&&store.getRecord('native_'+prefix+'_index_payload_v1',h.payload_ref);need(p&&hash(p)===h.payload_sha256&&p.scope.library_id===libraryId&&p.scope.run_id===runId&&p.scope.source_snapshot_ref===snapshotId,'QUERY_INDEX_BINDING_CHANGED');return {h,p};};
 const sourceIndex=payload('source'),knowledgeIndex=payload('knowledge');
 need(active.knowledge_index_revision===knowledgeIndex.h.index_revision&&active.source_index_revision===sourceIndex.h.index_revision,'QUERY_ACTIVE_INDEX_CHANGED');
 const index=createNativeBuildIndex({store:readOnly,runId,libraryId,snapshotId,assertOpen(){need(false,'QUERY_READ_ONLY');}});
 const graph=index.graph({view:'EXTRACTED_KNOWLEDGE'}).domain_graph;
 need(graph?.revision_ref===active.revision_ref,'QUERY_GRAPH_REVISION_CHANGED');
 const source=store.getRecord('cq_v2_snapshot',snapshotId);need(source?.library_id===libraryId,'QUERY_SOURCE_BINDING_CHANGED');
 const recordSources=createRecordSourceReader({store:readOnly,libraryId,rows:[...knowledgeIndex.p.records,...sourceIndex.p.records],rawRecordPort});
 const recordRefs=new Set(recordSources.refs().map(s=>s.record_ref));
 const original=createNativeQueryView({libraryId,sourceSnapshot:{...source,documents:source.documents.filter(d=>!recordRefs.has(d.doc_ref??d.doc_id))}}),docs=original.documents(),byDoc=new Map(docs.map(d=>[d.doc_ref,d]));
 const exact=e=>{const d=byDoc.get(e.doc_ref),s=e.span??e;need(d&&d.revision===e.revision&&Number.isSafeInteger(s.start)&&Number.isSafeInteger(s.end)&&d.content.slice(s.start,s.end)===s.quote,'QUERY_SOURCE_SPAN_CHANGED');return {evidence_ref:e.evidence_ref??'query_source_span_'+hash([e.doc_ref,e.revision,s.start,s.end]),doc_ref:e.doc_ref,revision:e.revision,start:s.start,end:s.end,quote:s.quote,offset_unit:'utf16_code_unit',block_ref:e.block_ref??e.block_id??null};};
 const mappedEvidence=r=>(r.evidence??[]).flatMap(e=>e.source_record_ref||isMemorySource(e)?[recordSources.exact(e)]:e.spans?.length?e.spans.map(s=>({...exact({...s,doc_ref:s.doc_ref??e.doc_ref,revision:s.revision??e.revision}),mapping_precision:e.mapping_precision??'BLOCK_ASSOCIATION'})):Number.isSafeInteger(e.start??e.span?.start)?[{...exact(e),mapping_precision:e.mapping_precision??'EXACT_SPAN'}]:[]);
 const sourceByRef=new Map(sourceIndex.p.records.map(r=>[r.record_ref,r]));
 const space=knowledgeIndex.p.embedding_space?{...clone(knowledgeIndex.p.embedding_space),space_ref:'query_space_'+hash(knowledgeIndex.p.embedding_space)}:null;
 const embedding=(r,p)=>{const v=p.vectors?.[hash(r.text)];return v&&space?{embedding:{space_ref:space.space_ref,values:clone(v),text_sha256:hash(r.text)}}:{};};
 const library=knowledgeIndex.p.graph.library_knowledge,eligible=new Set((library?.knowledge??[]).map(k=>k.record_ref));
 // Definition choices qualify the normalized label only. Original document
 // references remain evidence for the saved factual expression.
 let definitionShapes=null;
 const auditCache=new Map(),currentDefinitions=library?.ontology?.definitions??[],currentMappings=library?.ontology?.definition_mappings??[],currentKnowledge=new Map((library?.knowledge??[]).map(row=>[row.knowledge_ref??row.record_ref,row]));
 const signedRecord=(kind,ref)=>{const value=store.getRecord(kind,ref),{record_sha256,...body}=value??{};need(value&&record_sha256===hash(body),'QUERY_DEFINITION_AUDIT_CHANGED');return value;};
 const lineage=d=>d?.definition_lineage_ref??d?.source_definition_ref??d?.definition_ref;
 function applicationProof(targetRunId,applicationRef,receiptRef){
  const cacheKey=hash([targetRunId,applicationRef,receiptRef]);if(auditCache.has(cacheKey))return auditCache.get(cacheKey);
  const receipt=signedRecord('native_library_review_applied_v1',receiptRef),installation=signedRecord('native_library_review_installation_v1',targetRunId),target=signedRecord('native_library_knowledge_revision_v1',receipt.target_revision_ref),origin=signedRecord('native_library_knowledge_revision_v1',installation.source_revision_ref),state=store.getRecord('native_full_chain_state_v1',targetRunId),ledger=store.getRecord('native_full_run_v1',targetRunId);
  need(installation.installation_ref==='library_review_installation_'+hash([applicationRef,targetRunId])&&receiptRef==='library_review_applied_'+hash(installation.installation_ref),'QUERY_DEFINITION_RECEIPT_IDENTITY_CHANGED');
  need(receipt.status==='APPLIED'&&receipt.library_id===libraryId&&receipt.source_snapshot_ref===snapshotId&&receipt.target_run_id===targetRunId&&receipt.application_ref===applicationRef&&receipt.applied_receipt_ref===receiptRef&&installation.library_id===libraryId&&installation.source_snapshot_ref===snapshotId&&installation.target_run_id===targetRunId&&installation.target_revision_ref===target.revision_ref&&installation.application_ref===applicationRef&&installation.applied_receipt_ref===receiptRef&&target.library_id===libraryId&&target.run_id===targetRunId&&target.source_snapshot_ref===snapshotId&&receipt.target_revision_sha256===target.record_sha256,'QUERY_DEFINITION_APPLICATION_BINDING_CHANGED');
  need(origin.library_id===libraryId&&origin.run_id===installation.source_run_id&&origin.source_snapshot_ref===snapshotId&&applicationRef==='library_review_application_'+hash([origin.revision_ref,origin.record_sha256,origin.input_sha256,installation.event_set_sha256]),'QUERY_DEFINITION_APPLICATION_CHANGED');
  need(state?.input?.application_ref===applicationRef&&state.application_origin?.application_ref===applicationRef&&state.readback?.verified===true&&state.readback.knowledge_graph?.library_revision_ref===target.revision_ref&&state.build?.knowledge_index?.index_revision===receipt.knowledge_index_revision&&state.build?.source_index?.index_revision===receipt.source_index_revision&&ledger?.phase==='READBACK_VERIFIED'&&['SUCCEEDED','PARTIALLY_READY'].includes(ledger.status)&&Array.isArray(ledger.attempts)&&ledger.attempts.every(attempt=>attempt.outcome==='RETURNED'),'QUERY_DEFINITION_READBACK_UNCONFIRMED');
  const proof={receipt,installation,target,origin};auditCache.set(cacheKey,proof);return proof;
 }
 function definitionSelections(record){
  const entries=[...(record.ontology_alignment?[['ontology_alignment',record.ontology_alignment]]:[]),...(record.relation_ontology_alignment?[['relation_ontology_alignment',record.relation_ontology_alignment]]:[]),...(record.attribute_ontology_alignments??[]).map(alignment=>['attribute_ontology_alignments',alignment])],sources=[],warnings=[];
  const knowledgeRef=record.knowledge_ref??record.record_ref,current=currentKnowledge.get(knowledgeRef),input=store.getRecord('native_library_knowledge_input_v1',runId);
  for(const [alignmentKind,alignment]of entries){
   const target=currentDefinitions.find(definition=>definition.definition_ref===alignment.definition_ref),mapping=alignment.definition_mapping_ref?currentMappings.find(m=>m.mapping_ref===alignment.definition_mapping_ref):null,eventRef=alignment.review_event_ref??mapping?.review_event_ref??(target?.author==='HUMAN'?target.review_event_ref:null);
   if(!eventRef&&!alignment.definition_mapping_ref&&target?.author!=='HUMAN')continue;
   try{
    need(alignment.status==='ALIGNED'&&target&&current&&hash(currentKnowledge.get(knowledgeRef)?.[alignmentKind]??null)===hash(record[alignmentKind]??null),'QUERY_DEFINITION_ALIGNMENT_UNBOUND');
    const retained=signedRecord('native_library_knowledge_revision_v1',active.revision_ref);
    need(retained.record_sha256===active.record_sha256&&library?.record_sha256===retained.record_sha256&&hash(library)===hash(retained),'QUERY_DEFINITION_CURRENT_REVISION_CHANGED');
    const currentProof=applicationProof(runId,retained.review_application?.application_ref,retained.review_application?.applied_receipt_ref);
    need(currentProof.target.revision_ref===active.revision_ref&&currentProof.receipt.knowledge_index_revision===active.knowledge_index_revision&&currentProof.receipt.source_index_revision===active.source_index_revision,'QUERY_DEFINITION_CURRENT_APPLICATION_CHANGED');
    const event=signedRecord('native_library_review_event_v1',eventRef),sourceRevision=signedRecord('native_library_knowledge_revision_v1',event.source_revision_ref);
    const {record_sha256:_eventSha,event_ref:_eventRef,...eventBody}=event;need(event.event_ref===eventRef&&eventRef==='library_review_event_'+hash(eventBody),'QUERY_DEFINITION_EVENT_CHANGED');
    need(event.item_kind==='DEFINITION'&&event.author==='HUMAN'&&['unify','keep_separate','accept'].includes(event.action)&&event.library_id===libraryId&&event.source_snapshot_ref===snapshotId&&sourceRevision.library_id===libraryId&&sourceRevision.source_snapshot_ref===snapshotId&&sourceRevision.run_id===event.source_run_id&&sourceRevision.record_sha256===event.source_revision_sha256,'QUERY_DEFINITION_EVENT_BINDING_CHANGED');
    let sourceDefinitionRef,applicationRef,receiptRef;
    if(mapping){
     const sourceDefinition=currentDefinitions.find(definition=>definition.definition_ref===mapping.source_definition_ref);
     need(mapping.status==='ACTIVE'&&mapping.review_event_ref===eventRef&&mapping.action===event.action&&mapping.target_definition_ref===target.definition_ref&&hash(target)===mapping.target_definition_sha256&&sourceDefinition&&hash(sourceDefinition)===mapping.source_definition_sha256&&(mapping.knowledge_refs??[]).includes(knowledgeRef),'QUERY_DEFINITION_MAPPING_CHANGED');
     const originalMappings=(event.definition_mappings??[]).filter(original=>{const source=(sourceRevision.ontology?.definitions??[]).find(d=>d.definition_ref===original.source_definition_ref),selected=(sourceRevision.ontology?.definitions??[]).find(d=>d.definition_ref===original.target_definition_ref);return source&&selected&&lineage(source)===lineage(sourceDefinition)&&lineage(selected)===lineage(target);});
     need(originalMappings.length===1&&hash(originalMappings[0].source_shape_signatures)===hash(mapping.source_shape_signatures)&&hash(originalMappings[0].knowledge_refs)===hash(mapping.knowledge_refs)&&originalMappings[0].mapping_direction===mapping.mapping_direction,'QUERY_DEFINITION_MAPPING_EVENT_CHANGED');
     const shapes=definitionShapes??(definitionShapes=collectLibraryOntologyShapes(input?.knowledge??[],retained.identity)),kind=target.kind,matching=shapes.filter(shape=>shape.kind===kind&&shape.label===alignment.original_label&&(shape.knowledge_refs??[]).includes(knowledgeRef));
     need(matching.some(shape=>(mapping.source_shape_signatures??[]).includes(libraryShapeSignature(shape))),'QUERY_DEFINITION_SCOPE_CHANGED');
     need(currentProof.target.ontology.definition_mappings.some(value=>hash(value)===hash(mapping))&&stateMappingReadbackMatches(currentProof.target),'QUERY_DEFINITION_CURRENT_MAPPING_UNCONFIRMED');
     sourceDefinitionRef=sourceDefinition.definition_ref;applicationRef=mapping.application_ref;receiptRef=mapping.applied_receipt_ref;
    }else{
     need(!alignment.definition_mapping_ref&&target.review_event_ref===eventRef&&['accept','unify','keep_separate'].includes(event.action),'QUERY_DEFINITION_SELECTION_BINDING_MISSING');
     const originalDefinitions=sourceRevision.ontology?.definitions??[],original=originalDefinitions.find(d=>d.definition_ref===event.item_target_ref),selectedRef=event.definition_resolution?.selected_definition_ref;
     need(original&&([lineage(original),...originalDefinitions.filter(d=>d.definition_ref===selectedRef).map(lineage)]).includes(lineage(target)),'QUERY_DEFINITION_SELECTED_TARGET_CHANGED');
     sourceDefinitionRef=event.item_target_ref;applicationRef=target.application_ref;receiptRef=target.applied_receipt_ref;
    }
    const receipt=signedRecord('native_library_review_applied_v1',receiptRef),originProof=applicationProof(receipt.target_run_id,applicationRef,receiptRef);
    need(originProof.receipt.event_refs.includes(eventRef)&&originProof.installation.event_refs.includes(eventRef)&&originProof.installation.source_revision_ref===event.source_revision_ref&&originProof.installation.source_run_id===event.source_run_id,'QUERY_DEFINITION_SELECTION_NOT_APPLIED');
    sources.push({kind:'HUMAN_DEFINITION_SELECTION',evidence_nature:'HUMAN_DEFINITION_CHOICE',authority_scope:'NORMALIZED_DEFINITION_ONLY',knowledge_ref:knowledgeRef,alignment_kind:alignmentKind,source_definition_ref:sourceDefinitionRef,definition_ref:target.definition_ref,original_label:alignment.original_label,selected_label:alignment.name??target.name,review_event_ref:eventRef,reason:event.reason,source_run_id:event.source_run_id,source_revision_ref:event.source_revision_ref,application_ref:applicationRef,applied_receipt_ref:receiptRef});
   }catch(error){warnings.push(error.code??'QUERY_DEFINITION_SELECTION_UNBOUND');}
  }
  return {definition_sources:[...new Map(sources.map(value=>[hash(value),value])).values()],definition_selection_status:warnings.length?'UNBOUND':sources.length?'BOUND':'NONE',definition_selection_warnings:[...new Set(warnings)]};
 }
 function stateMappingReadbackMatches(revision){const state=store.getRecord('native_full_chain_state_v1',runId);return state?.readback?.definition_mappings?.verified===true&&state.readback.definition_mappings.mappings_sha256===hash(revision.ontology.definition_mappings??[]);}
 function selectionSummary(rows){const sources=[...new Map(rows.flatMap(row=>row.definition_sources??[]).map(value=>[hash(value),value])).values()],warnings=[...new Set(rows.flatMap(row=>row.definition_selection_warnings??[]))];return {definition_sources:sources,definition_selection_status:rows.some(row=>row.definition_selection_status==='UNBOUND')?'UNBOUND':sources.length?'BOUND':'NONE',definition_selection_warnings:warnings};}
 const qualificationWarnings=[],excluded=new Set(),excludedKnowledge=new Set();
 const logicalRef=record=>record.retrieval_fragment?record.knowledge_ref:record.record_ref;
 // The index binds content to an installed revision. A query additionally
 // requires the actual APPLIED/readback receipt before granting human records
 // membership in its current library and document context.
 function humanContext(record){
  const origin=record.correction_origin,knowledgeRef=record.retrieval_fragment?record.knowledge_ref:record.record_ref;
  need(record.origin_layer==='HUMAN_CORRECTION'&&record.answer_authority==='HUMAN_CORRECTION'&&record.author==='HUMAN'&&record.source==='HUMAN'&&origin?.library_id===libraryId&&origin.source_snapshot_ref===snapshotId,'QUERY_HUMAN_SCOPE_CHANGED');
  const retained=signedRecord('native_library_knowledge_revision_v1',active.revision_ref);
  need(retained.record_sha256===active.record_sha256&&hash(library)===hash(retained),'QUERY_HUMAN_CURRENT_REVISION_CHANGED');
  const proof=applicationProof(runId,retained.review_application?.application_ref,retained.review_application?.applied_receipt_ref);
  need(proof.target.revision_ref===active.revision_ref&&proof.receipt.knowledge_index_revision===active.knowledge_index_revision&&proof.receipt.source_index_revision===active.source_index_revision,'QUERY_HUMAN_CURRENT_APPLICATION_CHANGED');
  const eventRef=record.review_event_ref;
  need([proof.receipt.event_refs,proof.installation.event_refs,retained.review_application?.event_refs].every(refs=>refs?.includes(eventRef)),'QUERY_HUMAN_NOT_CURRENTLY_APPLIED');
  const event=signedRecord('native_library_review_event_v1',eventRef),{record_sha256:_eventSha,event_ref:_eventRef,...eventBody}=event;
  need(event.event_ref===eventRef&&eventRef==='library_review_event_'+hash(eventBody)&&event.author==='HUMAN'&&event.action==='replace'&&event.item_kind==='KNOWLEDGE'&&event.item_target_ref===knowledgeRef&&event.library_id===libraryId&&event.source_snapshot_ref===snapshotId&&event.source_revision_ref===origin.source_revision_ref&&event.source_revision_sha256===origin.source_revision_sha256&&event.source_run_id===origin.source_run_id&&event.item_ref===origin.review_item_ref&&origin.review_event_ref===eventRef&&record.review_source_revision_ref===event.source_revision_ref&&event.before_knowledge_sha256===origin.before_sha256&&hash(origin.before_knowledge)===origin.before_sha256,'QUERY_HUMAN_EVENT_BINDING_CHANGED');
  const originalReceipt=signedRecord('native_library_review_applied_v1',origin.applied_receipt_ref),originalProof=applicationProof(originalReceipt.target_run_id,origin.application_ref,origin.applied_receipt_ref);
  need(originalProof.receipt.event_refs.includes(eventRef)&&originalProof.installation.event_refs.includes(eventRef)&&originalProof.installation.source_revision_ref===origin.source_revision_ref&&originalProof.installation.source_run_id===origin.source_run_id,'QUERY_HUMAN_ORIGIN_NOT_APPLIED');
  const sourceRevision=signedRecord('native_library_knowledge_revision_v1',origin.source_revision_ref),sourceRow=sourceRevision.knowledge?.find(row=>(row.knowledge_ref??row.record_ref)===knowledgeRef),current=retained.knowledge?.find(row=>(row.knowledge_ref??row.record_ref)===knowledgeRef);
  need(sourceRevision.library_id===libraryId&&sourceRevision.source_snapshot_ref===snapshotId&&sourceRevision.run_id===origin.source_run_id&&sourceRevision.record_sha256===origin.source_revision_sha256&&sourceRow&&current?.review_event_ref===eventRef,'QUERY_HUMAN_SOURCE_BINDING_CHANGED');
  const content=row=>{const {run_id,application_origin,retrieval_fragment,...body}=row;return body;},expected=clone(current);
  if(record.retrieval_fragment){const {start,end}=record.retrieval_fragment;need(Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&end>start&&end<=current.text.length&&record.record_ref===knowledgeRef+'_fragment_'+start,'QUERY_HUMAN_FRAGMENT_CHANGED');expected.record_ref=record.record_ref;expected.knowledge_ref=record.knowledge_ref;expected.text=current.text.slice(start,end);}
  need(hash(content(record))===hash(content(expected)),'QUERY_HUMAN_CURRENT_RECORD_CHANGED');
  const sourceRefs=isHumanQueryRecord(sourceRow)?sourceRow.correction_origin?.original_source_refs:sourceRow.source_refs;
  need(Array.isArray(sourceRefs)&&hash(sourceRefs)===hash(origin.original_source_refs),'QUERY_HUMAN_CONTEXT_BINDING_CHANGED');
  need(sourceRefs.every(ref=>byDoc.get(ref.doc_ref)?.revision===ref.revision),'QUERY_HUMAN_CONTEXT_REVISION_CHANGED');
  return clone(sourceRefs);
 }
 const humanSources=r=>r.origin_layer==='HUMAN_CORRECTION'?[{kind:'HUMAN_CORRECTION',evidence_nature:'HUMAN_STATEMENT',author:'HUMAN',knowledge_ref:r.knowledge_ref??r.record_ref,review_event_ref:r.review_event_ref,source_run_id:r.correction_origin?.source_run_id,source_revision_ref:r.review_source_revision_ref,application_ref:r.correction_origin?.application_ref,applied_receipt_ref:r.correction_origin?.applied_receipt_ref,reason:r.correction_origin?.reason??'',original_text:r.correction_origin?.original_knowledge?.text??'',original_document_is_background_only:true,original_source_targets:targets([{source_refs:r.correction_origin?.original_source_refs??[],evidence:r.correction_origin?.original_evidence??[]}])}]:[];
 const compact=r=>Object.fromEntries(['record_ref','kind','subject_ref','object_ref','predicate','direction','attribute','raw_value','unit','rule_text','rule_name','participants','attributes','conditions','negation','modality','time_text','version_text','exceptions','text','statement','warnings','source_refs','ontology_alignment','relation_ontology_alignment','attribute_ontology_alignments','semantic_policy','library_projection','author','origin_layer','answer_authority','review_event_ref','review_source_revision_ref','assertion_status','conflict_resolution','conflict_refs','valid_time','system_time','asserted_valid_time','temporal_lineage','temporal_projection','time_binding_authority'].filter(k=>r[k]!==undefined).map(k=>[k,clone(r[k])]));
 function conflictSummary(rows){const refs=new Set(rows.map(r=>r.knowledge_ref??r.record_ref)),documents=new Set(rows.flatMap(r=>r.source_refs??[]).map(s=>[s.doc_ref,s.revision].join(':'))),knowledge=library?.knowledge??[];const groups=(library?.query_groups??[]).filter(g=>g.knowledge_refs.some(id=>refs.has(id)||knowledge.some(k=>k.record_ref===id&&(k.source_refs??[]).some(s=>documents.has([s.doc_ref,s.revision].join(':'))))));return groups.length?{conflict_groups:groups.map(g=>({...clone(g),records:g.knowledge_refs.map(id=>knowledge.find(k=>k.record_ref===id)).filter(Boolean).map(compact)})),conflict_reading_policy:'Disclose DISPUTED alternatives with both sources. PENDING scope/time/exclusivity remains unresolved; never choose by upload order. NOT_ADOPTED/SUPERSEDED rows are historical context, not current selected facts.'}:{};}
 const candidates=knowledgeIndex.p.records.flatMap(r=>{let context;
  if(isHumanQueryRecord(r))try{context=humanContext(r);}catch(error){excluded.add(r.record_ref);excludedKnowledge.add(logicalRef(r));qualificationWarnings.push({record_ref:r.record_ref,code:error.code??'QUERY_HUMAN_UNBOUND'});return [];}
  return [{fact_ref:r.record_ref,...compact(r),...memoryActionFields(r),record_sources:recordSources.recordSources([r]),...(context?{context_source_refs:context}:{}),knowledge_ref:r.record_ref,representation:r.representation,record_kind:r.kind,human_sources:humanSources(r),...definitionSelections(r),index_origin:eligible.has(r.record_ref)?'BUSINESS_KNOWLEDGE':'SEMANTIC_BASE',policy:r.policy,evidence:mappedEvidence(r),...embedding(r,knowledgeIndex.p)}];});
 // Graph edges refer to the logical knowledge ID, whereas index fragments
 // have their own record IDs. Quarantine both so no synthetic edge can recover
 // an unqualified human claim from the graph projection.
 for(const row of knowledgeIndex.p.records)if(excludedKnowledge.has(logicalRef(row)))excluded.add(row.record_ref);
 for(const ref of excludedKnowledge)excluded.add(ref);
 const records=candidates.filter(row=>!excluded.has(row.fact_ref));
 const byRecord=new Map(records.map(r=>[r.fact_ref,r]));
 const visibleGraph=qualifyExtractedGraphDetails(graph,excluded);
 const nodes=visibleGraph.nodes.map(n=>{const backing=(n.record_refs??[]).map(id=>byRecord.get(id)).find(r=>r?.kind==='ENTITY'),context=[...new Map(records.filter(r=>r.subject_ref===n.id||r.object_ref===n.id||(r.participants??[]).some(p=>p.subject_ref===n.id)).flatMap(r=>r.context_source_refs??r.source_refs??[]).map(ref=>[hash(ref),ref])).values()];return {subject_ref:n.id,...clone(n),record_refs:clone(n.record_refs??[]),context_source_refs:clone(context),surface:n.name??n.label,aliases:clone(n.aliases??[]),description:backing?.text??n.description??n.name??n.label,evidence:[],...(backing?.embedding?{embedding:clone(backing.embedding)}:{})};});
 const edges=visibleGraph.edges.map(e=>({...clone(e),fact_ref:e.record_refs?.[0]??e.id}));
 const edgeRows=edges.filter(e=>!records.some(r=>r.kind==='RELATION'&&r.subject_ref===e.source&&r.object_ref===e.target&&r.predicate===e.predicate)).map(e=>({fact_ref:e.id,record_ref:e.id,kind:'RELATION',original_kind:e.kind,subject_ref:e.source,object_ref:e.target,predicate:e.predicate,direction:'SUBJECT_TO_OBJECT',text:`${nodes.find(n=>n.subject_ref===e.source)?.surface} —${e.predicate}→ ${nodes.find(n=>n.subject_ref===e.target)?.surface}`,...memoryActionFields(e),record_sources:recordSources.recordSources([e]),source_refs:clone(e.source_refs??[]),knowledge_refs:clone(e.record_refs??[]),conditions:clone(e.conditions??null),modality:e.modality??null,negation:e.negation??null,evidence:[],representation:'EXTRACTED_KNOWLEDGE',...selectionSummary((e.record_refs??[]).map(ref=>byRecord.get(ref)).filter(Boolean))}));
 const facts=[...records,...edgeRows],evidence=new Map([...original.sourceEvidence(),...records.flatMap(r=>r.evidence),...sourceIndex.p.records.flatMap(mappedEvidence)].map(e=>[e.evidence_ref,e]));
 const pin={library_id:libraryId,build_run_id:runId,library_revision_ref:active.revision_ref,graph_revision_ref:graph.revision_ref,source_snapshot_ref:snapshotId,source_index_revision:sourceIndex.h.index_revision,fact_index_revision:knowledgeIndex.h.index_revision,...(publicationBarrier.receipt?{publication_commit_ref:publicationBarrier.receipt.commit_ref,publication_confirmation_ref:publicationBarrier.receipt.confirmation_ref}:{})};
 publicationBarrier.bind(pin,recordSources.hasRecords);
 function assertCurrent(){publicationBarrier.assertCurrent();const now=store.getRecord('native_library_knowledge_active_v1',libraryId);need(now&&hash(now)===hash(active),'QUERY_LIBRARY_REVISION_STALE');need(!catalog||catalog.isCurrent(snapshotId,libraryId),'NATIVE_QUERY_SOURCE_STALE');need(store.getRecord('native_source_index_head_v1',key)?.index_revision===pin.source_index_revision&&store.getRecord('native_knowledge_index_head_v1',key)?.index_revision===pin.fact_index_revision,'QUERY_INDEX_REVISION_STALE');return true;}
 function targets(rows){return [...new Map(rows.filter(r=>r.origin_layer!=='HUMAN_CORRECTION'&&!isMemoryQueryRecord(r)).flatMap(r=>(r.source_refs??[]).filter(s=>!isMemorySource(s)).map(s=>{const spans=mappedEvidence(r).filter(e=>e.doc_ref===s.doc_ref&&e.revision===s.revision),mapping=(r.evidence??[]).find(e=>e.doc_ref===s.doc_ref);return {doc_ref:s.doc_ref,revision:s.revision,title:byDoc.get(s.doc_ref)?.title??s.doc_ref,precision:!spans.length?'DOCUMENT_ONLY':['DOCUMENT_ONLY','DOCUMENT_CONTEXT_ONLY'].includes(mapping?.mapping_precision)?'DOCUMENT_ONLY':mapping?.mapping_precision==='BLOCK_ASSOCIATION'||mapping?.spans?'BLOCK_ASSOCIATION':mapping?.mapping_precision&&mapping.mapping_precision!=='EXACT_SPAN'?'BLOCK_ASSOCIATION':'EXACT_SPAN',spans,segments:spans,block_refs:[...new Set(spans.map(e=>e.block_ref).filter(Boolean))],source_mapping:mapping?.source_mapping??null};})).map(t=>[hash(t),t])).values()];}
 const reader={assertCurrent,scope:()=>({...original.scope(),...pin,reader_manifest_ref:'query_reader_pin_'+hash(pin),source_capability:sourceIndex.p.capability,fact_capability:knowledgeIndex.p.capability,embedding_spaces:space?[space]:[]}),documents:()=>clone(docs),subjects:()=>clone(nodes),facts:()=>clone(facts),qualificationWarnings:()=>clone(qualificationWarnings),evidence:ref=>clone(evidence.get(ref)??null),sourceEvidence:()=>original.sourceEvidence(),graph:()=>clone(visibleGraph),pin:()=>clone(pin),sourceTargets:targets,recordSources:()=>recordSources.refs(),isSourceQualified:source=>isMemorySource(source)?recordSources.contains(source):byDoc.get(source.doc_ref)?.revision===source.revision,publicationView:()=>clone(publicationBarrier.receipt),readRecordEvidence:null,
  graphBundle(refs){const rows=refs.map(id=>facts.find(r=>r.fact_ref===id)).filter(Boolean),backingRows=[...new Map(rows.flatMap(r=>byRecord.has(r.fact_ref)?[r]:(r.knowledge_refs??[]).map(ref=>byRecord.get(ref)).filter(Boolean)).map(r=>[r.fact_ref,r])).values()],knowledgeRefs=[...new Set(rows.flatMap(r=>byRecord.has(r.fact_ref)?[r.fact_ref]:r.knowledge_refs??[]))],related=edges.filter(e=>refs.includes(e.id)||(e.record_refs??[]).some(r=>knowledgeRefs.includes(r))),entityRefs=[...new Set([...rows.flatMap(r=>[r.subject_ref,r.object_ref,...(r.participants??[]).map(p=>p.subject_ref)]),...related.flatMap(e=>[e.source,e.target])].filter(Boolean))];return {kind:'GRAPH',representation:'EXTRACTED_KNOWLEDGE',record_kinds:rows.map(r=>r.kind),record_sources:recordSources.recordSources(backingRows),records:backingRows.map(r=>({...memoryActionFields(r),record_sources:clone(r.record_sources??[]),knowledge_ref:r.fact_ref,kind:r.kind,text:r.text??r.statement??r.rule_text??'',representation:r.representation,index_origin:r.index_origin??'EXISTING_GRAPH_EDGE',origin_layer:r.origin_layer??'EXTRACTED_KNOWLEDGE',answer_authority:r.answer_authority??'EXTRACTED_KNOWLEDGE',...(r.review_event_ref?{review_event_ref:r.review_event_ref}:{}),...(r.review_source_revision_ref?{review_source_revision_ref:r.review_source_revision_ref}:{}),...selectionSummary([r])})),...selectionSummary(backingRows),...conflictSummary(backingRows),human_sources:backingRows.flatMap(r=>r.human_sources??[]),knowledge_refs:knowledgeRefs,knowledge_ref:knowledgeRefs[0]??null,entity_refs:entityRefs,entity_ids:entityRefs,relation_refs:related.map(e=>e.id),relation_ids:related.map(e=>e.id),label:rows.map(r=>r.attribute??r.predicate??r.rule_name??r.kind).join('；'),text:rows.map(r=>r.text??r.statement??r.rule_text).filter(Boolean).join('\n'),conditions:rows.map(r=>r.conditions),warnings:rows.flatMap(r=>r.warnings??[]),source_targets:targets(rows),graph_context:{entities:nodes.filter(n=>entityRefs.includes(n.subject_ref)).map(({embedding,...n})=>n),relations:related}};},
  sourceBundle(row){const indexed=row.text_representation==='SERIALIZED_INDEX_TEXT_WITH_ORIGINAL_MAPPING',original=indexed?sourceByRef.get(row.record_ref)??row:row;const sourceTargets=original.source_refs?targets([original]):targets([{source_refs:[original],evidence:[original]}]);if(indexed)for(const t of sourceTargets){t.precision=t.precision==='DOCUMENT_ONLY'?'DOCUMENT_ONLY':'BLOCK_ASSOCIATION';t.source_mapping=clone((original.evidence??[]).map(e=>({source_chunk_ref:e.source_chunk_ref,source_mapping:e.source_mapping,mapping_precision:e.mapping_precision,source_items:e.source_items})));}if(row.origin_precision&&row.origin_precision!=='EXACT_SPAN')for(const t of sourceTargets)t.precision=['DOCUMENT_ONLY','DOCUMENT_CONTEXT_ONLY'].includes(row.origin_precision)?'DOCUMENT_ONLY':'BLOCK_ASSOCIATION';return {kind:'SOURCE',record_sources:recordSources.recordSources([original]),representation:isMemoryQueryRecord(original)?(indexed?'INDEXED_RECORD_WITH_MAPPING':'VERBATIM_RECORD'):indexed?'INDEXED_SOURCE_WITH_MAPPING':'VERBATIM_SOURCE',knowledge_refs:[],entity_refs:[],relation_refs:[],label:row.title??'原文',text:row.text??row.quote??'',...(row.origin_precision?{origin_precision:row.origin_precision,association_not_certified:true}:{}),source_targets:sourceTargets,...conflictSummary([original]),graph_context:{entities:[],relations:[]}};},
  sourceRecords:()=>sourceIndex.p.records.map(r=>({...compact(r),...conflictSummary([r]),...memoryActionFields(r),record_sources:recordSources.recordSources([r]),evidence:mappedEvidence(r).map(({quote,...e})=>({...e,quote_chars:quote.length})),text_representation:'SERIALIZED_INDEX_TEXT_WITH_ORIGINAL_MAPPING',...embedding(r,sourceIndex.p)})),counts:()=>({nodes:nodes.length,edges:edges.length,knowledge:eligible.size,indexed_records:knowledgeIndex.p.records.length,semantic_drafts:records.filter(r=>r.index_origin==='SEMANTIC_BASE').length})};
 const passages=createRecordPassageReader({reader,recordSources,documentPassages:createQueryPassageReader({reader})});reader.readRecordEvidence=args=>passages.read(args);
 // Every public synchronous read shares the same coordinator barrier, including
 // callers that do not go through the Agent Host or the direct-search adapter.
 for(const name of ['scope','pin','documents','subjects','facts','qualificationWarnings','evidence','sourceEvidence','graph','sourceTargets','graphBundle','sourceBundle','sourceRecords','counts','recordSources','isSourceQualified','publicationView']){const read=reader[name];reader[name]=(...args)=>{assertCurrent();const result=read(...args);assertCurrent();return result;};}
 assertCurrent();return Object.freeze(reader);
}

/** Stored vectors are queried in their original text space; never re-embed graph.
 * SOURCE records preserve non-contiguous mapping and verified original spans.
 */
export function createExtractedQuerySearch({reader,embed,signal,rerank,rerankBinding,rankingOptions}){
 const raw=createNativeQuerySearch({reader,embed,signal,rerank,rerankBinding,rankingOptions}),page=createNativeQueryPager({reader,namespace:'product-source-mapping'}),passages=createQueryPassageReader({reader}),order=createQueryRanking({reader,rerank,rerankBinding,signal,...rankingOptions});
 const selections=new Map(),typed=reader.facts().some(isMemoryQueryRecord)||reader.sourceRecords().some(isMemoryQueryRecord);
 function selection(args){const {source_refs,source_mode,...rest}=args;querySourceMode(args);const key=hash({source_refs:source_refs??[],source_mode:source_mode??'CURRENT_KNOWLEDGE'});if(!selections.has(key))selections.set(key,createNativeQuerySearch({reader:{...reader,facts:()=>reader.facts().filter(r=>matchesQuerySources(r,args)),subjects:()=>reader.subjects().filter(r=>matchesQuerySources(r,args))},embed,signal,rerank,rerankBinding,rankingOptions}));return {search:selections.get(key),args:rest};}
 async function typedSearch(name,args){reader.assertCurrent();const selected=selection(args),result=await selected.search[name](selected.args);reader.assertCurrent();return {...result,query_diagnostics:{...result.query_diagnostics,source_refs:clone(args.source_refs??[])}};}
 return {...raw,...(typed?{searchFacts:(args={})=>typedSearch('searchFacts',args),findEntities:(args={})=>typedSearch('findEntities',args)}:{}),readEvidence:args=>reader.readRecordEvidence?reader.readRecordEvidence(args):passages.read(args),async searchSources(args={}){
  reader.assertCurrent();querySourceMode(args);const {source_refs,source_mode,...rest}=args,prepared=nativeQueryCore('search_prepare',{rows:reader.sourceRecords().filter(r=>matchesQuerySources(r,args)).map(r=>({...r,search_text:r.text,vector_text:r.text})),args:typed?rest:args,type:'sources',scope:reader.scope(),embedding_enabled:!!embed}),query_vectors=[];
  need(prepared.ranking_revision===QUERY_RANKING_REVISION,'QUERY_RANKING_BINARY_VERSION_MISMATCH');
  if(prepared.query&&embed)for(const g of prepared.groups??[]){const v=await embed([prepared.query],{inputType:'query',embeddingSpace:g.space,signal});query_vectors.push({space_ref:g.space_ref,values:v[0]});}
  const ranked=nativeQueryCore('search_finish',{prepared,query_vectors}),ordered=await order(ranked.rows,{query:prepared.query,type:'sources',cursor:args.cursor}),result=page(ordered.rows,args,{ranking_revision:QUERY_RANKING_REVISION,delivery_revision:QUERY_DELIVERY_REVISION});reader.assertCurrent();return {...result,ranking:ordered.trace,query_diagnostics:{normalized_query:prepared.query,query_components:prepared.query_components,source_refs:args.source_refs??[],scope:reader.scope()},mode:ranked.mode,evidence:result.items.flatMap(r=>r.evidence)};
 }};
}
