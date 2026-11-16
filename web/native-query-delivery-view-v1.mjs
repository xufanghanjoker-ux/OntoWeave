/** Separate program provenance, public citation descriptors and model-facing content. */
import {clone,hash,need} from './cq-discovery-store-v2.mjs';
import {renderLightogChatMarkdown} from './lightog-chat-markdown-v1.mjs';
export const CITATION_DESCRIPTOR='lightog-citation-descriptor/1';
const pick=(row,keys)=>Object.fromEntries(keys.filter(k=>row?.[k]!==undefined).map(k=>[k,clone(row[k])]));
const recordSourceKeys=['kind','record_ref','logical_ref','revision','record_version','source_version_id','source_role','temporal_claim','claim_scope','basis_fact_version_id','source_kind','evidence_nature','source_ingested_at','document_evidence_eligible','precision'];
const recordFields=row=>Object.fromEntries(['record_sources','time_boundary_sources','background_sources','uncertainty_sources'].filter(k=>row[k]?.length).map(k=>[k,row[k].map(s=>pick(s,recordSourceKeys))]));
const actionFields=row=>({...pick(row,['original_kind','source_record_refs','valid_time','valid_time_input','semantic_support','semantic_quality','process_link','claim_scope','role','measurement','resolved_subject_ref','resolved_participants']),...(row.native_action?{native_action:pick(row.native_action,['draft_ref','record_type','payload','conditions','uncertainties','time_proposal','warnings','semantic_support'])}:{})});
// The document behind the old claim remains a comparison target. Only the
// signed human decision is evidence for the replacement content.
const humanSource = row => pick(row,['kind','evidence_nature','author','knowledge_ref','review_event_ref','source_run_id','source_revision_ref','application_ref','applied_receipt_ref','reason','original_document_is_background_only']);
const correctionFields = row => ({
 ...(row.human_sources?.length?{human_sources:row.human_sources.map(humanSource)}:{}),
 ...(row.human_sources?.length&&row.records?{records:row.records.map(r=>pick(r,['knowledge_ref','kind','representation','index_origin','origin_layer','answer_authority','review_event_ref','review_source_revision_ref']))}:{})
});
const definitionSourceFields=['kind','evidence_nature','authority_scope','knowledge_ref','alignment_kind','source_definition_ref','definition_ref','original_label','selected_label','review_event_ref','reason','source_run_id','source_revision_ref','application_ref','applied_receipt_ref'];
const selectionFields=row=>({definition_sources:(row.definition_sources??[]).map(source=>pick(source,definitionSourceFields)),definition_selection_status:row.definition_selection_status??'NONE',definition_selection_warnings:clone(row.definition_selection_warnings??[])});
const definitionFields=row=>{
 const qualified=row.definition_sources?.length||row.definition_selection_status&&row.definition_selection_status!=='NONE'||row.definition_selection_warnings?.length;
 return qualified?{...selectionFields(row),...(row.records?{records:row.records.map(record=>({...pick(record,['knowledge_ref','kind','representation','index_origin','origin_layer','answer_authority','review_event_ref','review_source_revision_ref']),...selectionFields(record)}))}:{})}:{};
};
export function publicCitation(c){
 if(!c||typeof c!=='object')return c;
 if(c.delivery_contract===CITATION_DESCRIPTOR)return clone(c);
 return {...pick(c,['citation_ref','kind','representation','label','temporal_scope']),...recordFields(c),...correctionFields(c),...definitionFields(c),delivery_contract:CITATION_DESCRIPTOR,detail_available:true,detail_sha256:hash(c),
  source_targets:(c.source_targets??[]).map(t=>pick(t,['doc_ref','revision','title','source_snapshot_ref','precision']))};
}
export function publicCitationEntry(entry){return {...pick(entry,['number','marker','citation_ref','source_snapshot_ref','inherited_from_query','query_scope_ref','view_ref']),citation:publicCitation(entry.citation)};}
export function citationReadContext(queryId,snapshotRef,chat){
 if(!chat)return undefined;
 need(typeof snapshotRef==='string'&&snapshotRef.length>0&&chat.query_id===queryId&&chat.source_scope?.source_snapshot_ref===snapshotRef,'QUERY_CITATION_REGISTRY_SCOPE_INVALID');
 return {query_ref:queryId,source_snapshot_ref:snapshotRef,registry:chat.registry,...(chat.source_scope?.temporal_view_sha256?{query_scope_ref:hash(chat.source_scope)}:{})};
}
export function publicAnswer(answer,context){
 if(!answer)return answer;let value=answer;
 if(answer.format==='markdown'&&typeof answer.markdown==='string'&&Array.isArray(context?.registry)){
  const eligible=context.registry.filter(e=>e.source_snapshot_ref===context.source_snapshot_ref&&(!context.query_scope_ref||e.query_scope_ref===context.query_scope_ref)&&e.citation&&(!e.citation.citation_ref||e.citation.citation_ref===e.citation_ref)),rendered=renderLightogChatMarkdown(answer.markdown,{registry:eligible});
  const used=rendered.used_numbers.map(n=>eligible.find(e=>e.number===n)),warnings=rendered.unknown_numbers.map(number=>({code:'QUERY_CITATION_NUMBER_UNISSUED',number,marker:'['+number+']'}));
  const refs=rows=>(rows??[]).map(e=>({number:e.number,citation_ref:e.citation_ref})),stored=refs(answer.citations),displayed=refs(used);
  value={...answer,citations:used,citation_warnings:warnings};
  if(hash(stored)!==hash(displayed)||hash(answer.citation_warnings??[])!==hash(warnings))value.citation_projection={mode:'READ_ONLY_REGISTRY_RECONCILED',query_ref:context.query_ref,source_snapshot_ref:context.source_snapshot_ref,stored_citations:stored,displayed_citations:displayed};
 }
 return {...clone(value),...(Array.isArray(value.citations)?{citations:value.citations.map(c=>c?.citation?publicCitationEntry(c):publicCitation(c))}:{}),...(value.statements?{statements:value.statements.map(s=>({...clone(s),...(s.citations?{citations:s.citations.map(publicCitation)}:{})}))}:{})};
}
export function publicQueryEvent(event,context){
 if(Array.isArray(context?.registry))need(event.query_ref===context.query_ref&&(!event.query_id||event.query_id===context.query_ref),'QUERY_CITATION_EVENT_SCOPE_INVALID');
 const data=event.type==='citation.registered'?publicCitationEntry(event.data):{...clone(event.data),...(event.data?.answer?{answer:publicAnswer(event.data.answer,context)}:{}),...(event.data?.partial_answer?{partial_answer:publicAnswer(event.data.partial_answer,context)}:{})};
 return {...pick(event,['version','query_ref','query_id','conversation_id','turn_id','seq','type','at']),data};
}
const locator=e=>({...pick(e,[...recordSourceKeys,'evidence_ref','source_record_ref','doc_ref','block_ref','start','end','offset_unit','mapping_precision','origin_precision','quote_chars']),...(typeof e?.quote==='string'?{quote_chars:e.quote.length}:{}),read_with:'lightog_read_evidence'});
const semantic=['path_ref','record_ref','fact_ref','knowledge_ref','kind','original_kind','record_kind','representation','index_origin','policy','subject_ref','object_ref','predicate','direction','attribute','raw_value','unit','rule_text','rule_name','participants','attributes','conditions','negation','modality','time_text','version_text','types','type_definition_refs','exceptions','text','statement','warnings','surface','name','label','aliases','description','score','lexical_score','vector_score','lexical_rank','vector_rank','rrf_rank','ranking_revision','rerank_rank','pre_rerank_rank','rerank_score','duplicate_record_refs','exact_match','match_type','doc_ref','revision','title','state','block_ref','evidence_ref','start','end','offset_unit','text_representation','origin_precision','mapping_precision','source_precision','passage_text_verified','association_not_certified','knowledge_refs','record_refs','evidence_refs'];
export function modelCitation(c){
 const sources=(c.source_targets??c.sources??[]).map(t=>pick(t,['doc_ref','revision','title','precision']));
 return {...pick(c,['citation_ref','kind','representation','label','conditions','warnings','temporal_scope']),...recordFields(c),...correctionFields(c),...definitionFields(c),sources,
  ...(!c.human_sources?.length||sources.length?{read_with:'lightog_read_evidence'}:{})};
}
export function modelRegistry(entries){return entries.map(e=>({...pick(e,['number','marker','citation_ref','inherited_from_query','source_snapshot_ref']),citation:modelCitation(e.citation)}));}
export function modelRow(row){
 if(!row||typeof row!=='object')return row;
 const value=pick(row,semantic);
 Object.assign(value,pick(row,['author','origin_layer','answer_authority','review_event_ref','review_source_revision_ref','fact_id','system_time','asserted_valid_time','derivation','temporal_scope',...recordSourceKeys,'source_record_ref']),recordFields(row),actionFields(row),correctionFields(row),definitionFields(row));
 if(row.source_refs)value.source_refs=row.source_refs.map(s=>pick(s,[...recordSourceKeys,'doc_ref','title','block_refs']));
 if(row.evidence)value.evidence=row.evidence.map(locator);
 if(row.citation_refs)value.citation_refs=clone(row.citation_refs);
 if(row.citations)value.citations=row.citations.map(modelCitation);
 if(row.nodes)value.nodes=row.nodes.map(n=>n&&typeof n==='object'?modelRow(n):n);
 if(row.edges)value.edges=row.edges.map(e=>typeof e==='object'?modelRow(e):e);
 if(row.steps)value.steps=row.steps.map(s=>({...pick(s,['from_ref','to_ref','source','target','predicate','direction','traversal_reversed','edge_ref','relation_ref','relation_id']),...(s.fact?{fact:modelRow(s.fact)}:{})}));
 return value;
}
export function modelResult(result){
 const value=pick(result,['status','next_cursor','truncated','mode','capability','coverage','returned','answer_authority','semantic_entailment','graph','graph_followup','match_type','identity_authenticated','search_truncated','direction','seed_refs','graph_hops','max_depth','max_chars','read_scope','passage_text_verified','association_not_certified']);
 if(result.items)value.items=result.items.map(modelRow);
 if(result.entities)value.entities=result.entities.map(modelRow);
 if(result.neighbors)value.neighbors=modelResult(result.neighbors);
 return value;
}
