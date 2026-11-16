/** Read-only display adapter for the native domain projection. No semantic inference. */
const palette=['#9ce7c8','#8fc9ed','#d4b5ec','#e6c58f','#9acfc9','#b9d39b'];
const text=value=>typeof value==='string'&&value.trim().length>0;
const array=value=>Array.isArray(value)?value:[];
const name=value=>typeof value==='string'?value:value?.label??value?.name??value?.key??'';
const refs=value=>array(value).filter(text);
const unique=values=>[...new Set(values)];
const excluded=new Set(['DOCUMENT','EVIDENCE','SOURCE_RECORD','EXTRACTED_KNOWLEDGE','ADOPTED_FACT','TASK','ATTRIBUTE_VALUE']);
export const nativeDomainEntityKey=id=>'entity:'+id;
export const nativeDomainKnowledgeKind=kind=>({ENTITY:'对象',TEXT:'知识陈述',RULE:'规则',ATTRIBUTE:'属性',RELATION:'关系',DEFINITION:'定义'}[String(kind??'').toUpperCase()]??'知识');
/** Expression polarity only, never verification or a lexical rewrite of the predicate. */
export const nativeDomainNegation=value=>value===true?true:value===false?false:null;
export const nativeDomainPolarity=value=>value===true?'NEGATED':value===false?'NON_NEGATED':'UNSPECIFIED';
export const nativeDomainPolarityLabel=value=>value===true?'否定表达':value===false?'非否定表达':'极性未声明';
export const nativeDomainRelationLabel=edge=>{
 const label=name(edge?.label??edge?.predicate);
 return edge?.negation===true?label+'〔否定表达〕':label;
};
const knowledgeText=record=>record.statement??record.text??record.rule_text??record.description??record.attribute??record.predicate??'';
const knowledgeRefs=(data,values)=>unique(refs(values).map(ref=>data.knowledge_keys.get(ref)??ref));

export function readNativeDomainGraph(payload){
 const domain=payload?.domain_graph;
 if(!domain||!Array.isArray(domain.nodes)||!Array.isArray(domain.edges))return null;
 const nodes=new Map(),edges=new Map(),knowledge=new Map(),knowledgeRecords=new Map(),knowledgeKeys=new Map();let invalid=0;
 for(const item of domain.nodes){
  const label=item?.name??item?.label??item?.surface;
  if(!text(item?.id)||!text(label)||excluded.has(String(item.kind??'').toUpperCase())||nodes.has(item.id)){invalid++;continue;}
  nodes.set(item.id,{...item,name:label,label,type_label:name(item.type_label??item.type_name??item.entity_type??item.type),record_refs:refs(item.record_refs)});
 }
 for(const item of domain.edges){
  const label=name(item?.label??item?.predicate);
  if(!text(item?.id)||!nodes.has(item.source)||!nodes.has(item.target)||!text(label)||edges.has(item.id)){invalid++;continue;}
  edges.set(item.id,{...item,label,predicate:name(item.predicate)||label,record_refs:refs(item.record_refs)});
 }
 const supplied=Array.isArray(domain.knowledge)?domain.knowledge:Object.values(domain.knowledge??{});
 const records=[...supplied,...array(payload.knowledge),...array(payload.records),...array(payload.nodes).filter(n=>['EXTRACTED_KNOWLEDGE','ADOPTED_FACT'].includes(n.kind))];
 for(const record of records){
  if(!record||typeof record!=='object')continue;
  const businessRefs=unique([record.knowledge_ref,record.record_ref,record.fact_ref].filter(text));
  const aliases=unique([...businessRefs,record.id].filter(text));if(!aliases.length)continue;
  // A graph-record node and a domain record can be separate objects for the
  // same saved knowledge. Count the stable record once, while all display and
  // fragment references resolve to the preferred (domain-first) record.
  const key=aliases.map(ref=>knowledgeKeys.get(ref)).find(text)??businessRefs[0]??record.id;
  if(!knowledgeRecords.has(key))knowledgeRecords.set(key,record);
  const saved=knowledgeRecords.get(key);
  for(const ref of aliases)if(!knowledge.has(ref)){knowledgeKeys.set(ref,key);knowledge.set(ref,saved);}
 }
 const adjacency=new Map([...nodes.keys()].map(id=>[id,new Set()]));
 for(const edge of edges.values()){adjacency.get(edge.source).add(edge.target);adjacency.get(edge.target).add(edge.source);}
 return {domain,nodes,edges,knowledge,knowledge_records:knowledgeRecords,knowledge_keys:knowledgeKeys,adjacency,invalid,definitions:domain.definitions??domain.ontology??{},version:payload.index_revision??domain.graph_revision??domain.version??payload.graph_revision??'native-domain'};
}

/** Large graphs use connected neighborhoods, with total/visible counts disclosed. */
export function projectNativeDomainGraph(payload,{limit=1800,focusId=null}={}){
 const data=readNativeDomainGraph(payload);
 if(!data)return {nodes:[],edges:[],entities:0,claims:0,invalid:0,version:'unavailable',status_text:'当前版本尚无领域关系图。'};
 const cap=Number.isSafeInteger(limit)&&limit>0?Math.min(limit,1800):1800;
 const ordered=[...data.nodes.keys()].sort((a,b)=>data.adjacency.get(b).size-data.adjacency.get(a).size||data.nodes.get(a).name.localeCompare(data.nodes.get(b).name)||a.localeCompare(b));
 if(data.nodes.has(focusId)){ordered.splice(ordered.indexOf(focusId),1);ordered.unshift(focusId);}
 const visible=new Set();
 for(const seed of ordered){
  if(visible.size>=cap)break;if(visible.has(seed))continue;
  const pending=[seed];let at=0;
  while(at<pending.length&&visible.size<cap){
   const id=pending[at++];if(visible.has(id))continue;visible.add(id);
   const neighbors=[...data.adjacency.get(id)].sort((a,b)=>data.adjacency.get(b).size-data.adjacency.get(a).size||a.localeCompare(b));
   for(const other of neighbors)if(!visible.has(other))pending.push(other);
  }
 }
 const types=unique([...data.nodes.values()].map(n=>n.type_label||'未分类')).sort();
 const nodes=[...visible].map((id,index)=>{
  const node=data.nodes.get(id),rule=String(node.kind??'').toUpperCase().includes('RULE');
  return {id:nativeDomainEntityKey(id),canonical_id:id,kind:'entity',domain_kind:node.kind??'ENTITY',structure_kind:rule?'RULE':null,label:node.name,type_label:node.type_label||'未分类',
   negation:nativeDomainNegation(node.negation),negation_state:nativeDomainPolarity(node.negation),polarity_label:nativeDomainPolarityLabel(node.negation),
   color:rule?'#d4b5ec':palette[types.indexOf(node.type_label||'未分类')%palette.length],degree:data.adjacency.get(id).size,record_refs:knowledgeRefs(data,node.record_refs),seed:index};
 });
 const edges=[...data.edges.values()].filter(e=>visible.has(e.source)&&visible.has(e.target)).map(edge=>({
  id:'domain-relation:'+edge.id,source:nativeDomainEntityKey(edge.source),target:nativeDomainEntityKey(edge.target),canonical_id:edge.id,statement_id:edge.id,claim_id:edge.id,
  label:nativeDomainRelationLabel(edge),original_label:edge.label,predicate:edge.predicate,predicate_label:nativeDomainRelationLabel({...edge,label:edge.predicate}),
  negation:nativeDomainNegation(edge.negation),negated:nativeDomainNegation(edge.negation),negation_state:nativeDomainPolarity(edge.negation),polarity_label:nativeDomainPolarityLabel(edge.negation),
  record_refs:knowledgeRefs(data,edge.record_refs),planned:['PLANNED','PROPOSED'].includes(edge.modality),direction:edge.direction??'SUBJECT_TO_OBJECT',type:['UNDIRECTED','NONE'].includes(edge.direction)?'line':'arrow'
 }));
 // All real relations remain addressable. The canvas may group coincident lines,
 // but the inspector and click rotation keep every relation's original identity.
 const pairs=new Map();for(const edge of edges){const pair=JSON.stringify([edge.source,edge.target].sort()),group=pairs.get(pair)??[];group.push(edge);pairs.set(pair,group);}
 for(const group of pairs.values()){group.sort((a,b)=>a.canonical_id.localeCompare(b.canonical_id));group.forEach((edge,index)=>Object.assign(edge,{parallel_ids:group.map(e=>e.id),parallel_count:group.length,parallel_index:index}));}
 const display=payload?.lightog_display,grouped=display?.policy==='TEMPORAL_LINEAGE_DISPLAY_V1'&&display.raw_record_count===data.knowledge_records.size
  &&Number.isSafeInteger(display.knowledge_count)&&display.knowledge_count>=0&&display.knowledge_count<=data.knowledge_records.size;
 return {nodes,edges,entities:data.nodes.size,claims:grouped?display.knowledge_count:data.knowledge_records.size,retained_claims:data.knowledge_records.size,invalid:data.invalid,omitted:0,version:data.version,is_native_domain:true,
  total_nodes:data.nodes.size,total_edges:data.edges.size,visible_nodes:nodes.length,visible_edges:edges.length,
  types:types.map((label,index)=>({label,color:palette[index%palette.length],count:[...data.nodes.values()].filter(n=>(n.type_label||'未分类')===label).length})),
  status_text:`当前显示 ${nodes.length} / ${data.nodes.size} 个对象 · ${edges.length} / ${data.edges.size} 条领域关联`+(data.invalid?` · ${data.invalid} 项显示数据无法绑定`:'')};
}

export function listNativeDomainEntities(payload,query='',limit=200){
 const data=readNativeDomainGraph(payload);if(!data)return {items:[],total:0};
 const needle=String(query).trim().toLocaleLowerCase();
 const matches=[...data.nodes.values()].filter(n=>[n.name,n.type_label,...array(n.aliases).map(name)].join(' ').toLocaleLowerCase().includes(needle));
 matches.sort((a,b)=>data.adjacency.get(b.id).size-data.adjacency.get(a.id).size||a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
 return {items:matches.slice(0,limit),total:matches.length};
}

export function listNativeDomainKnowledge(payload,query='',limit=100){
 const data=readNativeDomainGraph(payload);if(!data)return {items:[],total:0};
 const needle=String(query).trim().toLocaleLowerCase(),items=[];
 for(const [ref,record]of data.knowledge_records){
  const body=knowledgeText(record),search=[body,nativeDomainKnowledgeKind(record.kind),record.attribute,record.predicate,...array(record.conditions).map(name)].join(' ');
  if(search.toLocaleLowerCase().includes(needle))items.push({id:ref,record,text:body});
 }
 return {items:items.slice(0,limit),total:items.length};
}

function definitionList(definitions,keys){
 if(Array.isArray(definitions))return definitions;
 return keys.flatMap(key=>array(definitions?.[key]));
}
export function inspectNativeDomainGraph(payload,id,kind='entity'){
 const data=readNativeDomainGraph(payload);if(!data||!text(id))return null;
 const objectNames=Object.fromEntries([...data.nodes].map(([ref,node])=>[ref,node.name]));
 if(kind==='knowledge'){
  const record=data.knowledge.get(id);if(!record)return null;
  const key=data.knowledge_keys.get(id)??id,linked=values=>knowledgeRefs(data,values).includes(key);
  return {id,kind:'knowledge',item:record,records:[record],definitions:[],
   entity_ids:[...data.nodes.values()].filter(n=>linked(n.record_refs)).map(n=>n.id),
   relations:[...data.edges.values()].filter(e=>linked(e.record_refs)).map(e=>({...e,source_name:objectNames[e.source],target_name:objectNames[e.target]})),
   object_names:objectNames,unresolved_record_refs:[],version:data.version};
 }
 const edge=kind==='statement'||kind==='relation'?data.edges.get(id):null,node=edge?null:data.nodes.get(id);
 const item=edge??node;if(!item)return null;
 const related=edge?[edge]:[...data.edges.values()].filter(e=>e.source===id||e.target===id);
 const recordRefs=unique([...refs(item.record_refs),...related.flatMap(e=>e.record_refs)]);
 const records=unique(recordRefs.map(ref=>data.knowledge.get(ref)).filter(Boolean));
 const definitions=definitionList(data.definitions,edge?['relations','relation_types','predicates']:['types','entity_types','classes']).filter(d=>{
  const candidates=[d?.id,d?.key,d?.name,d?.label,d?.type_ref,d?.predicate].filter(text);
  const requested=edge?[edge.predicate,edge.label]:[name(node.type),name(node.entity_type),node.type_ref,node.type_label];
  return requested.filter(text).some(value=>candidates.includes(value));
 });
 return {id,kind:edge?'relation':'entity',item,records,definitions,source:edge?data.nodes.get(edge.source):null,target:edge?data.nodes.get(edge.target):null,
  relations:related.map(e=>({...e,source_name:data.nodes.get(e.source)?.name,target_name:data.nodes.get(e.target)?.name})),
  parallel_relations:edge?[...data.edges.values()].filter(e=>(e.source===edge.source&&e.target===edge.target)||(e.source===edge.target&&e.target===edge.source)).map(e=>({...e,source_name:objectNames[e.source],target_name:objectNames[e.target]})):[],
  object_names:objectNames,unresolved_record_refs:recordRefs.filter(ref=>!data.knowledge.has(ref)),version:data.version};
}
