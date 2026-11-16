/** Typed record provenance uses the unified record core, never a document alias. */
import {clone,hash,need,textField} from './cq-discovery-store-v2.mjs';
import {createNativeQueryPager} from './native-query-view-v1.mjs';
import {nativeQueryCore} from './native-query-core-v1.mjs';
import {verifyMemoryIndexSources} from './native-memory-source-binding-v1.mjs';

export const isMemorySource=source=>source?.kind==='MEMORY_RECORD_SOURCE';
export const memoryActionKeys=['native_action','original_kind','source_record_refs','valid_time','valid_time_input','action_domain_policy','semantic_support','semantic_quality','process_link','claim_scope','role','measurement','resolved_subject_ref','resolved_participants'];
export const memoryActionFields=row=>Object.fromEntries(memoryActionKeys.filter(k=>row?.[k]!==undefined).map(k=>[k,clone(row[k])]));
const sourceKinds=new Set(['DOCUMENT','HUMAN_TEXT','HUMAN_REPORT','AGENT_REPORT','TOOL_RECEIPT','MEASUREMENT_REPORT']);

export function createPublicationReadBarrier({publication,libraryId}){
 const capture=()=>{if(!publication)return null;need(typeof publication.assertQueryable==='function','QUERY_PUBLICATION_PORT_INVALID');try{const value=publication.assertQueryable({library_id:libraryId});need(!value?.then&&value?.queryable===true&&value.library_id===libraryId&&value.commit_ref&&value.confirmation_ref,'QUERY_PUBLICATION_UNCONFIRMED');return clone(value);}catch(error){if(error.code==='MEMORY_PUBLICATION_NOT_READY')return null;throw error;}};
 const initial=capture();
 return {receipt:initial,bind(pin,hasRecords){
  need(!hasRecords||initial,'QUERY_RECORD_PUBLICATION_REQUIRED');
  if(initial){const b=initial.bindings;need(b&&b.knowledge_revision_ref===pin.library_revision_ref&&b.graph_revision_ref===pin.graph_revision_ref&&b.source_index_revision===pin.source_index_revision&&b.knowledge_index_revision===pin.fact_index_revision,'QUERY_PUBLICATION_BINDING_CHANGED');}
 },assertCurrent(){need(hash(capture())===hash(initial),'QUERY_PUBLICATION_STALE');return true;}};
}

export function createRecordSourceReader({libraryId,rows,rawRecordPort,store}){
 const refs=rows.flatMap(row=>row.source_refs??[]).filter(isMemorySource),origins=new Map(),rawPins=new Map();
 for(const row of rows)if((row.source_refs??[]).some(isMemorySource)){const bindings=verifyMemoryIndexSources({store,libraryId,record:row,view:row.representation==='VERBATIM_SOURCE'?'SOURCE':'EXTRACTED_KNOWLEDGE'});for(const binding of bindings){need(typeof rawRecordPort?.getRawRecord==='function','QUERY_RAW_RECORD_PORT_REQUIRED');const raw=rawRecordPort.getRawRecord({library_id:libraryId,record_ref:binding.record_ref});need(raw?.text===binding.text&&raw.source?.kind===binding.source_kind&&raw.version===binding.version,'QUERY_RAW_RECORD_BINDING_CHANGED');}}
 const identity=source=>Object.fromEntries(['kind','record_ref','revision','source_kind','document_evidence_eligible'].map(k=>[k,source[k]]));
 const load=ref=>{need(typeof rawRecordPort?.getRawRecord==='function','QUERY_RAW_RECORD_PORT_REQUIRED');const raw=rawRecordPort.getRawRecord({library_id:libraryId,record_ref:ref});need(raw&&!raw.then&&raw.library_id===libraryId&&raw.record_ref===ref&&Number.isSafeInteger(raw.version)&&typeof raw.text==='string'&&sourceKinds.has(raw.source?.kind),'QUERY_RAW_RECORD_BINDING_CHANGED');return raw;};
 const pin=raw=>hash({library_id:raw.library_id,record_ref:raw.record_ref,version:raw.version,text:raw.text,source:raw.source,logical_ref:raw.logical_ref});
 for(const source of refs){need(textField(source.record_ref)&&textField(source.revision)&&source.document_evidence_eligible===false,'QUERY_RECORD_SOURCE_INVALID');const raw=load(source.record_ref);need(source.revision===String(raw.version)&&source.source_kind===raw.source.kind,'QUERY_RECORD_SOURCE_VERSION_CHANGED');const old=origins.get(raw.record_ref);need(!old||hash(old)===hash(identity(source)),'QUERY_RECORD_SOURCE_AMBIGUOUS');origins.set(raw.record_ref,identity(source));rawPins.set(raw.record_ref,pin(raw));}
 const get=ref=>{const source=origins.get(ref);need(source,'QUERY_RECORD_SOURCE_FORBIDDEN');const raw=load(ref);need(pin(raw)===rawPins.get(ref),'QUERY_RAW_RECORD_CHANGED');return raw;};
 const descriptor=source=>{const raw=get(source.record_ref);need(hash(origins.get(source.record_ref))===hash(identity(source)),'QUERY_RECORD_SOURCE_CHANGED');return {kind:'MEMORY_RECORD_SOURCE',record_ref:raw.record_ref,logical_ref:raw.logical_ref,revision:String(raw.version),record_version:raw.version,source_kind:raw.source.kind,evidence_nature:raw.source.kind==='HUMAN_TEXT'?'HUMAN_STATEMENT':raw.source.kind==='TOOL_RECEIPT'?'TOOL_RECEIPT':'SOURCE_REPORT',source_ingested_at:raw.source_ingested_at,document_evidence_eligible:false,precision:'RECORD_VERSION_ONLY'};};
 const exact=e=>{const ref=e.source_record_ref??e.record_ref,source=origins.get(ref),raw=get(ref),s=e.span??e;need(source&&e.revision===String(raw.version)&&typeof s.quote==='string'&&s.quote.length,'QUERY_RECORD_EVIDENCE_CHANGED');let start=s.start,end=s.end,quote=s.quote,mapping='RECORD_EXACT_SPAN';
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)){start=raw.text.indexOf(quote);need(start>=0,'QUERY_RECORD_EVIDENCE_CHANGED');if(raw.text.indexOf(quote,start+1)>=0){start=0;end=raw.text.length;quote=raw.text;mapping='RECORD_VERSION_ASSOCIATION';}else end=start+quote.length;}
  need(start>=0&&end>start&&end<=raw.text.length&&raw.text.slice(start,end)===quote&&(s.offset_unit??'utf16_code_unit')==='utf16_code_unit','QUERY_RECORD_EVIDENCE_CHANGED');
  return {...descriptor(source),evidence_ref:'query_record_span_'+hash([ref,e.revision,start,end]),source_record_ref:ref,start,end,quote,offset_unit:'utf16_code_unit',mapping_precision:mapping,...(mapping==='RECORD_VERSION_ASSOCIATION'?{origin_precision:mapping,reported_quote:s.quote}:{})};
 };
 return {hasRecords:origins.size>0,refs:()=>clone([...origins.values()]),contains:source=>isMemorySource(source)&&origins.has(source.record_ref)&&hash(origins.get(source.record_ref))===hash(identity(source)),descriptor,exact,get,recordSources:rows=>[...new Map(rows.flatMap(r=>r.source_refs??[]).filter(isMemorySource).map(s=>{const d=descriptor(s);return [hash(d),d];})).values()]};
}

/** Record windows keep record identity and source nature on every returned span. */
export function createRecordPassageReader({reader,recordSources,documentPassages}){
 const pages=createNativeQueryPager({reader,namespace:'record-passages-v1'}),saved=new Map(),issued=new Map();
 function read(args={}){
  reader.assertCurrent();let rows,params;
  if(args.cursor&&saved.has(args.cursor)){({rows,params}=saved.get(args.cursor));for(const [k,v]of Object.entries(args))if(k!=='cursor')need(hash(v)===hash(params[k]),'NATIVE_QUERY_CURSOR_INVALID');}
  else{
   const refs=args.evidence_refs??[],evidence=refs.map(ref=>issued.get(ref)??reader.evidence(ref));
   if(!args.record_ref&&!evidence.some(isMemorySource))return documentPassages.read(args);
   params={...clone(args),max_chars:args.max_chars??16000,page_size:args.page_size??12};
   need(Number.isSafeInteger(params.max_chars)&&params.max_chars>=128&&params.max_chars<=16000,'NATIVE_QUERY_READ_SIZE_INVALID');
   const scopes=args.record_ref?[{...recordSources.descriptor(recordSources.refs().find(s=>s.record_ref===args.record_ref)??{}),start:0,end:recordSources.get(args.record_ref).text.length}]:evidence;
   need(scopes.length&&scopes.every(Boolean),'NATIVE_QUERY_EVIDENCE_UNKNOWN');rows=[];
   for(const scope of scopes){
    if(!isMemorySource(scope)){const result=documentPassages.read({evidence_refs:[scope.evidence_ref],max_chars:params.max_chars,page_size:100});need(!result.next_cursor,'QUERY_MIXED_SOURCE_READ_TOO_LARGE');rows.push(...result.items);continue;}
    const raw=recordSources.get(scope.record_ref);need((!args.revision||args.revision===String(raw.version))&&Number.isSafeInteger(scope.start)&&Number.isSafeInteger(scope.end)&&scope.start>=0&&scope.end<=raw.text.length&&scope.end>scope.start,'QUERY_RECORD_EVIDENCE_CHANGED');
    for(let start=scope.start;start<scope.end;){let end=Math.min(scope.end,start+params.max_chars);if(end<scope.end&&/[\uD800-\uDBFF]/.test(raw.text[end-1]))end--;const e=recordSources.exact({source_record_ref:raw.record_ref,revision:String(raw.version),start,end,quote:raw.text.slice(start,end)});rows.push({...e,record_ref:raw.record_ref,text:e.quote,source_refs:recordSources.refs().filter(s=>s.record_ref===raw.record_ref),evidence:[e],origin_precision:scope.mapping_precision??scope.precision??'RECORD_VERSION_ONLY',passage_text_verified:true,association_not_certified:true,text_representation:'VERBATIM_RECORD',answer_authority:e.source_kind});start=end;}
   }
   if(params.query||params.keywords?.length){const prepared=nativeQueryCore('search_prepare',{rows:rows.map(r=>({...r,search_text:r.text})),args:{query:params.query,keywords:params.keywords},type:'sources',scope:reader.scope(),embedding_enabled:false});rows=nativeQueryCore('search_finish',{prepared,query_vectors:[]}).rows;}
  }
  // One window per page bounds total text even for mixed source requests.
  const result=pages(rows,{...params,page_size:1,...(args.cursor?{cursor:args.cursor}:{})},{type:'record-evidence'});
  if(result.next_cursor)saved.set(result.next_cursor,{rows,params});for(const row of result.items)for(const e of row.evidence??[])issued.set(e.evidence_ref,e);
  reader.assertCurrent();return {...result,max_chars:params.max_chars,read_scope:'EXPLICIT_ORIGINAL_RECORD_WINDOWS',passage_text_verified:true,association_not_certified:true,answer_authority:'TYPED_ORIGINAL_SOURCE'};
 }
 return {read};
}
