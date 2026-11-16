/** Saved-knowledge and source tools with program-owned citations and access accounting. */
import {hash,clone,need,textField} from './cq-discovery-store-v2.mjs';
import {createExtractedQuerySearch} from './native-query-extracted-reader-v1.mjs';
import {createNativeQueryGraph} from './native-query-graph-v1.mjs';
import {querySourceMode,querySourceRefs,matchesQuerySources} from './native-query-source-scope-v1.mjs';
import {validateArguments} from './native-build-host-v1.mjs';
import {modelResult,modelCitation,modelRow} from './native-query-delivery-view-v1.mjs';
import {queryRecordBodyHash} from './native-query-incremental-v3.mjs';
import {QUERY_RANKING_REVISION,QUERY_DELIVERY_REVISION,DEFAULT_RERANK_WINDOW} from './native-query-ranking-v2.mjs';

const str={type:'string',minLength:1,maxLength:16000},refs={type:'array',items:str,maxItems:256},object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const sourceScope={source_refs:refs,source_mode:{enum:['CURRENT_KNOWLEDGE','DOCUMENT_EVIDENCE']}},page={page_size:{type:'integer',minimum:1,maximum:100},cursor:str},search={query:str,keywords:refs,...sourceScope,...page},direction={enum:['OUT','IN','BOTH']};
const schemas={
 lightog_find_entities:object({...search,mentions:refs}),
 lightog_search_facts:object({...search,subject_refs:refs,predicates:refs,kinds:refs,kind:str}),
 lightog_retrieve:object({...search,entity_mentions:refs,subject_refs:refs,predicates:refs,kinds:refs,graph_needed:{type:'boolean'},direction}),
 lightog_search_sources:object(search),
 lightog_read_evidence:object({evidence_refs:refs,doc_ref:str,record_ref:str,revision:str,block_refs:refs,query:str,keywords:refs,max_chars:{type:'integer',minimum:128,maximum:16000},...page}),
 lightog_get_entity_facts:object({entity_ref:str,direction,predicates:refs,kind:str,...sourceScope,...page},['entity_ref']),
 lightog_expand_graph:object({seed_refs:refs,direction,predicates:refs,kinds:refs,...sourceScope,...page},['seed_refs']),
 lightog_find_paths:object({from_ref:str,to_ref:str,direction,max_depth:{type:'integer',minimum:1,maximum:32},predicates:refs,...sourceScope,...page},['from_ref','to_ref']),
 lightog_submit_answer:object({status:{enum:['SUPPORTED','PARTIAL','INSUFFICIENT','CONFLICTED','NEEDS_CLARIFICATION']},statements:{type:'array',maxItems:256,items:object({text:str,citation_refs:refs},['text','citation_refs'])},unanswered:{type:'array',items:str,maxItems:128},clarification:str},['status','statements','unanswered'])
};
function expectedArgument(schema){
 if(schema.enum)return schema.enum.join(' | ');
 if(schema.type==='array')return 'array<'+expectedArgument(schema.items??{})+'>';
 return (schema.type??'value')+(schema.minimum!==undefined?' >= '+schema.minimum:'')+(schema.maximum!==undefined?' <= '+schema.maximum:'');
}
function invalidArgument(code,field,expected){throw Object.assign(Error(code),{code,field,expected});}
function validateHostArguments(schema,value,path='$'){
 try{validateArguments({...schema,properties:{},items:undefined,required:[],additionalProperties:true},value,path);}
 catch(error){error.field=path;error.expected=expectedArgument(schema);throw error;}
 if(value&&typeof value==='object'&&!Array.isArray(value)){
  for(const key of schema.required??[])if(!Object.hasOwn(value,key))invalidArgument('NATIVE_TOOL_ARGUMENT_REQUIRED',path+'.'+key,expectedArgument(schema.properties[key]));
  for(const [key,item]of Object.entries(value)){
   if(schema.additionalProperties===false&&!Object.hasOwn(schema.properties??{},key))invalidArgument('NATIVE_TOOL_ARGUMENT_UNKNOWN',path+'.'+key,'one of: '+Object.keys(schema.properties??{}).join(', '));
   if(schema.properties?.[key])validateHostArguments(schema.properties[key],item,path+'.'+key);
  }
 }
 if(Array.isArray(value)&&schema.items)value.forEach((item,index)=>validateHostArguments(schema.items,item,path+'['+index+']'));
}
const descriptions={lightog_retrieve:'对同一保存事实池执行内容检索，可在一个动作内定位实体并按需读取实际邻接；与lightog_search_facts、lightog_get_entity_facts可能重叠。资料范围用source_refs、所求内容用query/keywords；不读来源全文、不重新抽取，分数不认证支持或覆盖。',lightog_search_sources:'搜索授权来源索引中的具体措辞、条件、冲突或范围线索；结果带真实来源定位，可能有后续页，不是整篇内容或全集证明。资料范围用source_refs，所求内容用query/keywords。',lightog_submit_answer:'旧结构化协议兼容工具；自然Markdown问答不暴露此工具。'};
export function createExtractedQueryHost({reader,operation,embed,rerank,rerankBinding,rankingOptions,onEvent=async()=>{}}){
 const citations=new Map(),visibleSubjects=new Set(),visibleEvidence=new Set(),graphs=new Map();let staged=null;
 // Local metadata index only: no search, graph traversal, embedding or rerank.
 const documents=new Map(reader.documents().map(d=>[d.doc_ref,d.revision])),associations=new Map(),poolReader={...reader,facts:()=>reader.facts().filter(fact=>querySourceRefs(fact).every(source=>source.kind==='MEMORY_RECORD_SOURCE'?reader.isSourceQualified?.(source)===true:documents.get(source.doc_ref)===source.revision))};
 const searchPort=createExtractedQuerySearch({reader:poolReader,embed,rerank,rerankBinding,rankingOptions,signal:operation.signal});
 function graphFor(args){const selection={source_refs:clone(args.source_refs??[]),source_mode:querySourceMode(args)},key=hash(selection);
  if(!graphs.has(key))graphs.set(key,createNativeQueryGraph({reader:{...poolReader,facts:()=>poolReader.facts().filter(row=>matchesQuerySources(row,selection))}}));
  return graphs.get(key);
 }
 for(const fact of poolReader.facts()){
  const refs=new Set([fact.subject_ref,...(fact.kind==='RELATION'?[fact.object_ref]:[]),...(fact.kind==='RULE'?(fact.participants??[]).map(p=>p.subject_ref):[])].filter(Boolean));
  const projected=modelRow(fact),metadata={record_ref:fact.fact_ref??fact.record_ref,kind:fact.kind,source_refs:clone(projected.source_refs??[]),body_sha256:queryRecordBodyHash(projected),subject_ref:fact.subject_ref,object_ref:fact.object_ref,predicate:fact.predicate??fact.attribute,dimension_label:fact.attribute??fact.predicate??fact.rule_name??fact.kind,participant_refs:(fact.participants??[]).map(p=>p.subject_ref),...Object.fromEntries(['origin_layer','answer_authority','human_sources','record_sources','native_action','original_kind','valid_time'].filter(key=>projected[key]!==undefined).map(key=>[key,clone(projected[key])])),...(Object.hasOwn(fact,'context_source_refs')?{context_source_refs:clone(fact.context_source_refs)}:{})};
  for(const ref of refs){if(!associations.has(ref))associations.set(ref,[]);associations.get(ref).push(metadata);}
 }
 const identityRow=row=>Object.fromEntries(['record_ref','subject_ref','surface','name','label','aliases','types','exact_match','source_refs'].filter(k=>row[k]!==undefined).map(k=>[k,clone(row[k])]));
 function knowledgeNavigation(subjectRef,args={}){
  reader.assertCurrent();const direction=args.direction??'BOTH',kinds=args.kinds??(args.kind?[args.kind]:[]),predicates=args.predicates??[],sourceRefs=args.source_refs??[],sourceMode=querySourceMode(args);
  const records=(associations.get(subjectRef)??[]).filter(r=>(!kinds.length||kinds.includes(r.kind))&&(!predicates.length||predicates.includes(r.predicate))&&matchesQuerySources(r,{source_refs:sourceRefs,source_mode:sourceMode})&&((direction!=='IN'&&r.subject_ref===subjectRef)||(direction!=='OUT'&&r.kind==='RELATION'&&r.object_ref===subjectRef)||(r.kind==='RULE'&&r.participant_refs.includes(subjectRef)))).map(({subject_ref,object_ref,participant_refs,...record})=>record);
  return {subject_ref:subjectRef,scope:{source_snapshot_ref:reader.scope().source_snapshot_ref,direction,kinds:clone(kinds),predicates:clone(predicates),source_refs:clone(sourceRefs),source_mode:sourceMode},basis:'SAME_SAVED_FACT_POOL_DIRECT_ASSOCIATIONS_ONLY',query_text_applied:false,total_records:records.length,records,document_coverage:'NOT_A_DOCUMENT_CONTENT_INVENTORY'};
 }
 const trace={ranking_policy:{ranking_revision:QUERY_RANKING_REVISION,delivery_revision:QUERY_DELIVERY_REVISION,rerank_enabled:rankingOptions?.enabled??false,candidate_window:rankingOptions?.candidateWindow??DEFAULT_RERANK_WINDOW},tool_calls:[],graph_paths:[],source_reads:{calls:0,items:0,characters:0},graph_reads:0,delivered_records:[],host_projections:[],agent_tool_projections:[],query_diagnostics:[]};
 const definitions=Object.entries(schemas).map(([name,inputSchema])=>{const description=descriptions[name]??({lightog_find_entities:'按实际名称、别名定位候选身份，返回身份字段与本地直接关联范围导航，不附完整业务属性；exact_match不合并同名，也不证明内容已覆盖。',lightog_search_facts:'对保存事实池按query/keywords排序召回事实、属性、关系、规则或文本；与主体读取来自同一池。source_refs限定资料，保留kind、单位、条件和版本；Top-K或页结束不证明内容全集。',lightog_read_evidence:'按实际定位补读具体措辞、缺失细节或限定，可聚焦相关窗口；续页或扩读也是内容补查，遵守程序阶段；保持原来源精度，不强制读全文。',lightog_get_entity_facts:'读取同一保存事实池中与实际主体直接关联的记录，按方向、类型或关系/属性过滤，可能与先前搜索重叠；source_refs限定业务资料归属，默认CURRENT_KNOWLEDGE包含已应用人工修订；DOCUMENT_EVIDENCE仅选文档证据记录，人工关联不充当文档引句。不读文档全文、不发现新事实。页结束仅表示该关联范围结束。',lightog_expand_graph:'沿实际边读邻居，组合相容主体与条件下的证据，保留方向；连接存在本身不证明因果。',lightog_find_paths:'在实际对象间查有向多跳连接；可据兼容前提推导，但路径本身不认证因果或传递结论。'}[name]);return {name,inputSchema,description:description+(Object.hasOwn(inputSchema.properties,'source_mode')?' source_refs为资料范围；CURRENT_KNOWLEDGE包含已应用人工陈述的业务归属，DOCUMENT_EVIDENCE仅文档证据，业务关联不等于文档引句。':''),annotations:{readOnlyHint:name!=='lightog_submit_answer',destructiveHint:false,openWorldHint:false}};});
 function issue(bundle){const citation_ref='query_citation_'+hash([operation.state().query_id,reader.pin(),bundle]);const value={citation_ref,...clone(bundle)};citations.set(citation_ref,value);return value;}
 const brief=modelCitation;
 function prepareRows(result,source=false){
  const items=(result.items??[]).map(row=>{
   if(row.subject_ref&&row.surface)visibleSubjects.add(row.subject_ref);
   for(const ref of [row.subject_ref,row.object_ref,...(row.nodes??[])])if(ref)visibleSubjects.add(ref);
   for(const e of row.evidence??[]){visibleEvidence.add(e.evidence_ref);}
   if(row.evidence_ref)visibleEvidence.add(row.evidence_ref);
   if(row.steps){const refs=row.steps.map(s=>s.fact.fact_ref),c=issue(reader.graphBundle(refs));trace.graph_paths.push(clone(row));return {...row,citation_refs:[c.citation_ref],citations:[brief(c)]};}
   if(row.fact_ref){const c=issue(reader.graphBundle([row.fact_ref,...(row.duplicate_record_refs??[])]));trace.delivered_records.push({knowledge_ref:row.fact_ref,kind:row.kind,representation:row.representation,index_origin:row.index_origin??'GRAPH_EDGE'});const {embedding,...publicRow}=row;return {...publicRow,citation_refs:[c.citation_ref],citations:[brief(c)]};}
   if(source){const c=issue(reader.sourceBundle(row));const {embedding,...publicRow}=row;return {...publicRow,citation_refs:[c.citation_ref],citations:[brief(c)]};}
   const {embedding,...publicRow}=row;return row.subject_ref&&row.surface?identityRow(row):publicRow;
  });return modelResult({...result,items,...(result.entities?{entities:result.entities.map(identityRow)}:{})});
 }
 function references(args){for(const ref of [...(args.subject_refs??[]),...(args.seed_refs??[]),...['entity_ref','from_ref','to_ref'].map(k=>args[k]).filter(Boolean)])need(visibleSubjects.has(ref),'QUERY_SUBJECT_NOT_ISSUED');}
 function stage(args){
  need(args.status!=='SUPPORTED'||args.statements.length,'QUERY_SUPPORTED_ANSWER_EMPTY');need(args.status!=='PARTIAL'||args.unanswered.length,'QUERY_PARTIAL_GAP_REQUIRED');need(args.status!=='NEEDS_CLARIFICATION'||textField(args.clarification),'QUERY_CLARIFICATION_REQUIRED');
  const statements=args.statements.map(s=>{need(s.citation_refs.length,'QUERY_STATEMENT_CITATION_REQUIRED');const bundles=s.citation_refs.map(ref=>{need(citations.has(ref),'QUERY_CITATION_NOT_ISSUED');return clone(citations.get(ref));}),kinds=new Set(bundles.map(c=>c.kind)),basis=kinds.size===2?'GRAPH_AND_SOURCE':kinds.has('GRAPH')?'GRAPH':'SOURCE';return {...clone(s),basis,citations:bundles,answer_authority:basis==='GRAPH'?'EXTRACTED_KNOWLEDGE':basis==='SOURCE'?'ORIGINAL_SOURCE':'MIXED'};});
  staged={...clone(args),statements,citations:[...new Map(statements.flatMap(s=>s.citations).map(c=>[c.citation_ref,c])).values()],validation:'SAVED_GRAPH_CITATIONS_NOT_SEMANTIC_CERTIFICATION'};return operation.stageAnswer(staged);
 }
 const handlers={
  lightog_find_entities:a=>searchPort.findEntities(a),lightog_search_facts:a=>searchPort.searchFacts(a),lightog_search_sources:a=>searchPort.searchSources(a),
  lightog_read_evidence:a=>{if(a.evidence_refs)for(const ref of a.evidence_refs)need(visibleEvidence.has(ref),'QUERY_EVIDENCE_NOT_ISSUED');if(!a.evidence_refs&&!a.cursor&&!a.record_ref){const doc=reader.documents().find(d=>d.doc_ref===a.doc_ref&&(!a.revision||d.revision===a.revision));need(doc,'QUERY_SOURCE_FORBIDDEN');a={...a,revision:doc.revision};}return searchPort.readEvidence(a);},
  lightog_get_entity_facts:a=>graphFor(a).getEntityFacts(a),lightog_expand_graph:a=>graphFor(a).expandGraph(a),lightog_find_paths:a=>graphFor(a).findPaths(a),lightog_submit_answer:stage,
  async lightog_retrieve(a){const found=a.entity_mentions?.length?await searchPort.findEntities({mentions:a.entity_mentions,page_size:20,source_refs:a.source_refs,source_mode:a.source_mode}):{items:[]};found.items.forEach(s=>visibleSubjects.add(s.subject_ref));const exact=found.items.filter(s=>s.exact_match),seeds=a.subject_refs??(exact.length===1?[exact[0].subject_ref]:[]),params=Object.fromEntries(['query','keywords','source_refs','source_mode','predicates','kinds','page_size','cursor'].filter(k=>a[k]!==undefined).map(k=>[k,a[k]]));if(seeds.length)params.subject_refs=seeds;const result=await searchPort.searchFacts(params);let neighbors=null;if(a.graph_needed&&seeds.length){neighbors=graphFor(a).expandGraph({seed_refs:seeds,direction:a.direction??'OUT',page_size:20,...Object.fromEntries(['source_refs','source_mode'].filter(key=>a[key]!==undefined).map(key=>[key,a[key]])),...(a.predicates?{predicates:a.predicates}:{})});}return {...result,entities:found.items,neighbors:neighbors?prepareRows(neighbors):null,graph:{requested:!!a.graph_needed,executed:!!neighbors&&neighbors.status!=='UNAVAILABLE_CAPABILITY'},graph_followup:a.graph_needed&&!seeds.length?'SELECT_ACTUAL_SUBJECT_REF':null};}
 };
 async function call(name,args={}){
  const started=Date.now();let result,handlerStarted=false;
  try{operation.assertActive();reader.assertCurrent();need(!staged,'QUERY_OUTPUT_ALREADY_STAGED');need(schemas[name],'QUERY_TOOL_FORBIDDEN');validateHostArguments(schemas[name],args);references(args);handlerStarted=true;const raw=await handlers[name](clone(args));reader.assertCurrent();
   if(raw.query_diagnostics||raw.ranking)trace.query_diagnostics.push({tool_name:name,query:clone(raw.query_diagnostics),ranking:clone(raw.ranking)});
   const source=['lightog_search_sources','lightog_read_evidence'].includes(name);result=name==='lightog_submit_answer'?raw:prepareRows(raw,source);
   const executed=raw.status!=='UNAVAILABLE_CAPABILITY';result={...result,retrieval_executed:executed&&name!=='lightog_submit_answer',execution:{executed,absence_proven:false}};
   if(name!=='lightog_submit_answer'&&executed){
    if(source){trace.source_reads.calls++;trace.source_reads.items+=(result.items??[]).length;trace.source_reads.characters+=(result.items??[]).reduce((n,r)=>n+(r.text??r.quote??'').length+(r.evidence??[]).reduce((m,e)=>m+(e.quote??'').length,0),0);}else trace.graph_reads++;
    trace.host_projections.push({tool_name:name,projection_version:'HOST_SEMANTIC_RESULT_V2',sha256:hash(result),utf8_bytes:Buffer.byteLength(JSON.stringify(result)),characters:JSON.stringify(result).length,result:clone(result)});
    const progress=operation.recordProgress({tool_name:name,args_hash:hash(args),evidence_refs:[...citations.keys(),...visibleSubjects],result_hash:hash(result)});if(progress.should_stop)result={...result,status:'NO_NEW_INFORMATION'};
   }
   trace.tool_calls.push({name,args:clone(args),status:result.status??'READY',elapsed_ms:Date.now()-started,returned:result.items?.length??null});await onEvent({event:'query_trace',trace:snapshot()});return {ok:true,result};
  }catch(error){const code=error.code??'QUERY_TOOL_FAILED',recoverable=/^(?:NATIVE_TOOL_ARGUMENT_|QUERY_(?:SUBJECT_NOT_ISSUED|EVIDENCE_NOT_ISSUED|CITATION_NOT_ISSUED|STATEMENT_CITATION_REQUIRED|SUPPORTED_ANSWER_EMPTY|PARTIAL_GAP_REQUIRED|CLARIFICATION_REQUIRED))/.test(code);trace.tool_calls.push({name,args:clone(args),status:recoverable?'INVALID_ARGUMENTS':'FAILED',error:code,elapsed_ms:Date.now()-started,returned:null,execution:{executed:handlerStarted,completed:false,absence_proven:false}});
   if(recoverable){const p=operation.recordProgress({tool_name:name,args_hash:hash(args),result_hash:hash(code)});return {ok:true,result:{status:'INVALID_ARGUMENTS',recoverable:!p.should_stop,retrieval_executed:false,execution:{executed:handlerStarted,completed:false,absence_proven:false},error:{code,field:error.field??null,expected:error.expected??'use a reference actually issued by this query',message:error.field?'字段 '+error.field+' 需要 '+error.expected+'；保持数组/布尔/数值等实际JSON类型，不传JSON字符串。':'使用实际返回的subject_ref／citation_refs；段落未知时按doc_ref读取，不猜编号。'}}};}
   if(['RUNNING','ANSWER_STAGED'].includes(operation.state().status))operation.stop(code,code.includes('STALE')?'STALE':'FAILED');return {ok:false,error:{code},retrieval_executed:false,execution:{executed:handlerStarted,completed:false,absence_proven:false}};
  }
 }
 function snapshot(){const graphContext=trace.delivered_records.length>0||trace.graph_paths.length>0||visibleSubjects.size>0,sourceContext=trace.source_reads.characters>0,access_route=sourceContext?(graphContext?'GRAPH_WITH_SOURCE':'SOURCE_ONLY'):graphContext?'GRAPH_ONLY':null,outcome=staged?.status??null;return {...clone(trace),access_route,answer_outcome:outcome,retrieval_route:outcome==='INSUFFICIENT'?'INSUFFICIENT':outcome==='CONFLICTED'?'CONFLICT':access_route,citations:[...citations.values()]};}
 return {definitions,call,knowledgeNavigation,recordModelProjection(name,result){trace.agent_tool_projections.push({tool_name:name,call_index:trace.agent_tool_projections.length+1,projection_version:'REFERENCE_ENCODED_TOOL_RESULT_V2',sha256:hash(result),utf8_bytes:Buffer.byteLength(JSON.stringify(result)),characters:JSON.stringify(result).length,result:clone(result)});},isComplete:()=>!!staged,snapshot,confirmAnswer({runtime_receipt}){reader.assertCurrent();need(staged,'QUERY_ANSWER_NOT_STAGED');return operation.confirmAnswer({runtime_receipt,evidence_validated:true});}};
}
