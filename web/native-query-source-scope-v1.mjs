/** Query membership is separate from the document evidence for a statement.
 * context_source_refs is derived by the qualified reader, never from tool args.
 */
import {need} from './cq-discovery-store-v2.mjs';

export function querySourceMode(args={}){
 const mode=args.source_mode===undefined?'CURRENT_KNOWLEDGE':args.source_mode;
 need(['CURRENT_KNOWLEDGE','DOCUMENT_EVIDENCE'].includes(mode),'NATIVE_QUERY_SOURCE_MODE_INVALID');
 return mode;
}
export const isHumanQueryRecord=row=>row.origin_layer==='HUMAN_CORRECTION'||row.answer_authority==='HUMAN_CORRECTION';
export const isMemoryQueryRecord=row=>row.kind==='MEMORY_RECORD_SOURCE'||[...(row.record_sources??[]),...(row.source_refs??[])].some(s=>s.kind==='MEMORY_RECORD_SOURCE');
const identityRow=row=>typeof row.surface==='string'&&typeof row.subject_ref==='string'&&!row.fact_ref;
export function querySourceRefs(row,sourceMode='CURRENT_KNOWLEDGE'){
 const mode=querySourceMode({source_mode:sourceMode});
 if(mode==='DOCUMENT_EVIDENCE'&&isHumanQueryRecord(row))return [];
 if(isMemoryQueryRecord(row)){
  if(identityRow(row))return (row.context_source_refs??row.source_refs??[]).filter(s=>mode!=='DOCUMENT_EVIDENCE'||s.kind!=='MEMORY_RECORD_SOURCE');
  return mode==='DOCUMENT_EVIDENCE'?[]:(row.source_refs??[]).filter(s=>s.kind==='MEMORY_RECORD_SOURCE');
 }
 if(mode==='CURRENT_KNOWLEDGE'&&Object.hasOwn(row,'context_source_refs'))return Array.isArray(row.context_source_refs)?row.context_source_refs:[];
 if(row.source_refs!==undefined&&row.source_refs!==null)return Array.isArray(row.source_refs)?row.source_refs:[];
 return row.doc_ref?[{doc_ref:row.doc_ref,revision:row.revision}]:[];
}
export function matchesQuerySources(row,args={}){
 const mode=querySourceMode(args);
 if(mode==='DOCUMENT_EVIDENCE'&&(isHumanQueryRecord(row)||isMemoryQueryRecord(row)&&(!identityRow(row)||!querySourceRefs(row,mode).length)))return false;
 const sources=args.source_refs===undefined?[]:Array.isArray(args.source_refs)?args.source_refs:[args.source_refs];
 const refs=querySourceRefs(row,mode);
 return !sources.length||refs.some(ref=>sources.some(source=>typeof source==='string'?source===(ref.kind==='MEMORY_RECORD_SOURCE'?ref.record_ref:ref.doc_ref):ref.kind==='MEMORY_RECORD_SOURCE'?source?.kind==='MEMORY_RECORD_SOURCE'&&source.record_ref===ref.record_ref&&(source.revision===undefined||source.revision===ref.revision):source?.doc_ref===ref.doc_ref&&(source.revision===undefined||source.revision===ref.revision)));
}
