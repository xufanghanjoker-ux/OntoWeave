/** Read-only canvas/inspector mapping for host-validated committed source graphs.
 * Canvas claim:* / claim_id are compatibility keys for real Rust statement IDs;
 * this module never creates legacy claims, binds identity or certifies support. */
const palette=['#9ce7c8','#8acbb7','#b2d6c2','#9dbab0','#b7c9bb','#91c6bf'];
const visibleStates=new Set(['READY','COMMITTED_INDEX_PENDING','COMMITTED_INDEX_UNAVAILABLE','CANDIDATE_PREVIEW']);
const forbiddenStates=new Set(['QUARANTINED','REJECTED','REVOKED','SOURCE_INVALIDATED']);
const copy=structuredClone;
const fail=(code,details)=>Object.assign(Error(code),{code,details});
const need=(value,code,details)=>{if(!value)throw fail(code,details);};
const obj=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=value=>typeof value==='string'&&value.length>0;
const canonical=value=>Array.isArray(value)?value.map(canonical):obj(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const key=value=>JSON.stringify(canonical(value));
const union=values=>[...new Map(values.map(value=>[key(value),copy(value)])).entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,value])=>value);
const pair=(a,b)=>JSON.stringify([a,b]);
const sourceScope=s=>({base_ref:s?.base_ref,source_epoch:s?.source_epoch,sources:union(s?.sources??[])});
export const sourceEntityKey=value=>'entity:'+value;
export const sourceStatementKey=value=>'claim:'+value;

function collect(payload){
 const preview=payload?.status==='CANDIDATE_PREVIEW';
 if(preview)need(payload.contract_version==='lightog-source-candidate-preview/0.1'&&payload.publication_performed===false&&payload.semantic_support_certified===false&&payload.retrieval_available===false,'SOURCE_GRAPH_PREVIEW_CONTRACT_INVALID');
 need(obj(payload)&&visibleStates.has(payload.status),'SOURCE_GRAPH_NOT_AVAILABLE',{status:payload?.status??null});
 need(id(payload.graph_revision)&&obj(payload.snapshot)&&(preview||payload.snapshot.graph_revision===payload.graph_revision)&&Array.isArray(payload.builds)&&payload.builds.length>0&&Array.isArray(payload.evidence_sets)&&Array.isArray(payload.source_texts),'SOURCE_GRAPH_PAYLOAD_INVALID');
 need(payload.status!=='READY'||payload.index_status==='READY','SOURCE_GRAPH_READY_INDEX_MISMATCH');
 const sources=new Map(),sets=new Map(),fragments=new Map(),entities=new Map(),statements=new Map(),patterns=new Map();
 for(const row of payload.source_texts){
  need(obj(row)&&id(row.source_ref)&&id(row.source_revision)&&typeof row.text==='string','SOURCE_GRAPH_SOURCE_INVALID');
  const k=pair(row.source_ref,row.source_revision),prior=sources.get(k);need(!prior||key(prior)===key(row),'SOURCE_GRAPH_SOURCE_CONFLICT',{source_ref:row.source_ref,source_revision:row.source_revision});sources.set(k,copy(row));
 }
 for(const es of payload.evidence_sets){
  need(obj(es)&&id(es.evidence_set_id)&&Array.isArray(es.fragments)&&key(sourceScope(es.snapshot))===key(sourceScope(payload.snapshot)),'SOURCE_GRAPH_EVIDENCE_SET_INVALID');
  const prior=sets.get(es.evidence_set_id);need(!prior||key(prior)===key(es),'SOURCE_GRAPH_EVIDENCE_SET_CONFLICT',{evidence_set_id:es.evidence_set_id});if(prior)continue;
  sets.set(es.evidence_set_id,copy(es));
  for(const fragment of es.fragments){need(id(fragment.id),'SOURCE_GRAPH_FRAGMENT_INVALID');const k=pair(es.evidence_set_id,fragment.id);need(!fragments.has(k),'SOURCE_GRAPH_FRAGMENT_DUPLICATE',{evidence_set_id:es.evidence_set_id,evidence_id:fragment.id});fragments.set(k,copy(fragment));}
 }
 function merge(map,row,kind,core,fields,build){
  need(obj(row)&&id(row.id),'SOURCE_GRAPH_RECORD_INVALID',{kind});
  need(!forbiddenStates.has(row.status),'SOURCE_GRAPH_UNADMITTED_ROW',{kind,id:row.id,status:row.status});
  const prior=map.get(row.id),ref={build_index:build.index,task_ref:build.task_ref??null,graph_digest:build.graph_digest??null,snapshot:copy(build.snapshot)};
  if(prior){need(key(prior.core)===key(core),'SOURCE_GRAPH_CANONICAL_CONFLICT',{kind,id:row.id});for(const field of fields)prior.item[field]=union([...(prior.item[field]??[]),...(row[field]??[])]);prior.records.push({build_ref:ref,item:copy(row)});prior.build_refs=union([...prior.build_refs,ref]);}
  else map.set(row.id,{core:copy(core),item:copy(row),records:[{build_ref:ref,item:copy(row)}],build_refs:[ref]});
 }
 for(const [index,build]of payload.builds.entries()){
  const graph=build?.graph;need(obj(graph)&&Array.isArray(graph.entities)&&Array.isArray(graph.statements)&&key(sourceScope(graph.snapshot))===key(sourceScope(payload.snapshot)),'SOURCE_GRAPH_BUILD_SCOPE_INVALID',{build_index:index});need(!forbiddenStates.has(graph.status),'SOURCE_GRAPH_UNADMITTED_BUILD',{build_index:index,status:graph.status});
  const meta={index,task_ref:build.task_ref,graph_digest:graph.graph_digest,snapshot:graph.snapshot};
  for(const e of graph.entities){
   need(id(e.label)&&Array.isArray(e.anchors)&&Array.isArray(e.evidence_refs),'SOURCE_GRAPH_ENTITY_INVALID',{id:e.id});
   const row={...e,labels:union([e.label,...(e.labels??[])]),type_labels:union(e.type_labels??[])};
   merge(entities,row,'entity',{entity_ref:e.entity_ref??null,identity_status:e.identity_status??null,structure_kind:e.structure_kind??null,participant_ids:e.participant_ids??[]},['labels','type_labels','anchors','evidence_refs','candidate_ids'],meta);
  }
  for(const statement of graph.statements){
   need(Array.isArray(statement.evidence_refs),'SOURCE_GRAPH_STATEMENT_INVALID',{id:statement.id});
   const fields=['kind','subject_id','predicate','object','direction','qualifiers','conditions','status','semantic_status'],core=Object.fromEntries(fields.map(field=>[field,statement[field]??null]));
   merge(statements,statement,'statement',core,['evidence_refs','condition_records','descriptions','keywords','candidate_ids'],meta);
  }
  for(const pattern of graph.patterns??[])merge(patterns,pattern,'pattern',{kind:pattern.kind,label:pattern.label,roles:pattern.roles,qualifiers:pattern.qualifiers},['evidence_refs'],meta);
 }
 // A canonical entity can have several preserved labels; choosing a display
 // label never changes the record's ID, identity status or original records.
 for(const row of entities.values())row.item.label=row.item.labels[0];
 return{payload,sources,sets,fragments,entities,statements,patterns};
}
function spanInSource(span,source){return Boolean(source&&obj(span)&&span.offset_unit==='utf16_code_unit'&&Number.isSafeInteger(span.start)&&Number.isSafeInteger(span.end)&&span.start>=0&&span.end>span.start&&span.end<=source.text.length&&typeof span.quote==='string'&&source.text.slice(span.start,span.end)===span.quote&&(typeof span.quote.isWellFormed!=='function'||span.quote.isWellFormed()));}
function resolveEvidence(data,ref){
 const result={ref:copy(ref),resolved:false};
 if(!obj(ref)||!id(ref.evidence_set_ref)||!id(ref.evidence_id))return{...result,error:'INVALID_EVIDENCE_REFERENCE'};
 if(!data.sets.has(ref.evidence_set_ref))return{...result,error:'EVIDENCE_SET_NOT_FOUND'};
 const fragment=data.fragments.get(pair(ref.evidence_set_ref,ref.evidence_id));if(!fragment)return{...result,error:'FRAGMENT_NOT_FOUND'};
 const source=data.sources.get(pair(fragment.source_ref,fragment.source_revision));if(!source)return{...result,fragment:copy(fragment),error:'SOURCE_REVISION_NOT_FOUND'};
 if(!spanInSource(fragment.span,source))return{...result,fragment:copy(fragment),error:'SOURCE_SPAN_MISMATCH'};
 return{...result,resolved:true,fragment:copy(fragment),source:{source_ref:source.source_ref,source_revision:source.source_revision,original_sha256:source.original_sha256??null,parser_version:source.parser_version??null},source_text:source.text};
}
const predicateLabel=statement=>statement.predicate?.proposed_definition?.label??statement.predicate?.predicate_ref??null;
function structurallyDrawable(row,data){const s=row.item,o=s.object;return['RELATION','ATTRIBUTE'].includes(s.kind)&&data.entities.has(s.subject_id)&&id(predicateLabel(s))&&obj(o)&&['DIRECTED','UNDIRECTED','NONE'].includes(s.direction)&&(s.kind==='RELATION'?id(o.entity_id)&&data.entities.has(o.entity_id)&&o.typed_value===null:o.entity_id===null&&obj(o.typed_value));}

export function projectSourceGraph(payload,{statements:showStatements=true,limit=1800}={}){
 need(typeof showStatements==='boolean'&&Number.isSafeInteger(limit)&&limit>0&&limit<=1800,'SOURCE_GRAPH_LIMIT_INVALID',{limit,max:1800});
 const data=collect(payload),nodes=[],edges=[];let omitted=0,invalid=0;
 const checkLimit=()=>need(nodes.length<=limit,'SOURCE_GRAPH_NODE_LIMIT_EXCEEDED',{nodes:nodes.length,limit,message:`当前投影超过本地画布上限${limit}；未静默截断。`});
 for(const [entityId,row]of [...data.entities].sort(([a],[b])=>a<b?-1:a>b?1:0)){
  const e=row.item;nodes.push({id:sourceEntityKey(entityId),canonical_id:entityId,kind:'entity',label:e.label,type_label:e.type_labels.join('、'),identity_status:e.identity_status,entity_ref:e.entity_ref,structure_kind:e.structure_kind??null,participant_ids:copy(e.participant_ids??[]),color:palette[nodes.length%palette.length],degree:0,seed:nodes.length});checkLimit();
 }
 const byNode=new Map(nodes.map(node=>[node.id,node]));
 for(const [statementId,row]of [...data.statements].sort(([a],[b])=>a<b?-1:a>b?1:0)){
  const s=row.item;if(!structurallyDrawable(row,data)||s.evidence_refs.some(ref=>!resolveEvidence(data,ref).resolved)){invalid++;continue;}
  const source=sourceEntityKey(s.subject_id),planned=s.qualifiers?.modality==='PLANNED',displayPredicate=(s.qualifiers?.negated===true?'否定：':'')+predicateLabel(s),shared={statement_id:statementId,claim_id:statementId,canonical_id:statementId,label:displayPredicate,predicate_label:predicateLabel(s),planned,direction:s.direction,negated:s.qualifiers?.negated??null};
  if(s.kind==='RELATION'){const target=sourceEntityKey(s.object.entity_id);edges.push({...shared,id:'relation:'+statementId,source,target});byNode.get(source).degree++;byNode.get(target).degree++;}
  else if(showStatements){const target=sourceStatementKey(statementId),value=s.object.typed_value.value;nodes.push({id:target,canonical_id:statementId,kind:'statement',subject_id:s.subject_id,label:typeof value==='string'?value:JSON.stringify(value??s.object.typed_value),predicate:displayPredicate,predicate_label:predicateLabel(s),negated:s.qualifiers?.negated??null,planned,color:planned?'#c4a16e':'#738c80',degree:1,seed:nodes.length});edges.push({...shared,id:'statement:'+statementId,source,target});byNode.get(source).degree++;checkLimit();}
  else omitted++;
 }
 // A rendered/indexed record is not a semantic approval. Older payloads without
 // explicit graph_trust remain conservatively unverified in the same UI.
 for(const row of [...nodes,...edges]){row.display_badge='待核实';row.navigation_only=true;row.semantic_support_certified=false;}
 return{nodes,edges,entities:data.entities.size,claims:data.statements.size,omitted,invalid,version:payload.graph_revision,status:payload.status,index_status:payload.index_status,graph_trust:payload.graph_trust?copy(payload.graph_trust):null,usage:'NAVIGATION_ONLY',semantic_support_certified:false,read_only:true,legacy_claims_created:0,omitted_patterns:data.patterns.size,display_mapping:'CANONICAL_RUST_IDS_CLAIM_PREFIX_IS_CANVAS_ONLY'};
}

export function inspectSourceGraph(payload,canonicalId,kind='entity'){
 need(id(canonicalId)&&['entity','statement'].includes(kind),'SOURCE_GRAPH_INSPECTOR_REQUEST_INVALID');
 const data=collect(payload),row=(kind==='entity'?data.entities:data.statements).get(canonicalId);if(!row)return null;
 const item=copy(row.item),evidence=item.evidence_refs.map(ref=>resolveEvidence(data,ref));
 const anchors=kind==='entity'?item.anchors.map(anchor=>{const source=data.sources.get(pair(anchor.source_ref,anchor.source_revision));return{...copy(anchor),resolved:spanInSource(anchor.span,source),role:'LOCATION_ONLY_NOT_FACT_SUPPORT',...(source?{source_text:source.text}:{error:'SOURCE_REVISION_NOT_FOUND'})};}):[];
 const conditionEvidence=kind==='statement'?(item.condition_records??[]).flatMap(record=>(record.conditions??[]).map(condition=>({candidate_id:record.candidate_id,evidence_set_ref:record.evidence_set_ref,condition:copy(condition),evidence:(condition.evidence_ids??[]).map(evidence_id=>resolveEvidence(data,{evidence_set_ref:record.evidence_set_ref,evidence_id}))}))):[];
 const related=kind==='entity'?[...data.statements.values()].filter(s=>s.item.subject_id===canonicalId||s.item.object?.entity_id===canonicalId).map(s=>copy(s.item)):[];
 return{kind,id:canonicalId,item,records:copy(row.records),build_refs:copy(row.build_refs),evidence,anchors,statements:related,condition_evidence:conditionEvidence,graph_revision:payload.graph_revision,status:payload.status,index_status:payload.index_status,snapshot:copy(payload.snapshot),graph_trust:payload.graph_trust?copy(payload.graph_trust):null,usage:'NAVIGATION_ONLY',semantic_support_certified:false,read_only:true};
}
