/** Shared read-boundary contract. Pure browser-compatible checks; no hashing, mutation or publication. */
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.trim().length>0;
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const pointer=value=>String(value).replace(/~/g,'~0').replace(/\//g,'~1');
const bindingKeys=['index_scope_run_id','source_snapshot_ref','library_revision_ref','record_sha256','graph_revision_ref','source_index_revision','knowledge_index_revision','commit_ref','confirmation_ref'];
const indexKeys=['knowledge_revision_ref','graph_revision_ref','source_index_revision','knowledge_index_revision'];
const derivedKeys=new Set(['id','kind','name','description','record_refs','source_refs']);

function reason(code){
 if(code.includes('DEFINITION')||code.includes('ONTOLOGY'))return '图谱与本体定义尚未完整对齐，请重新读取。';
 if(code.includes('PUBLICATION'))return '当前知识的发布确认尚未完整对齐，请重新读取。';
 if(code.includes('SOURCE'))return '当前资料版本尚未对齐，未替换为其他原文。';
 if(code.includes('INDEX'))return '图谱与检索索引尚未对应同一版本，请重新读取。';
 if(code.includes('IDENTITY'))return '图谱与对象身份尚未对应同一版本，请重新读取。';
 return '当前知识、图谱与发布确认尚未完整对齐，未替用旧批次。';
}
const bad=(suffix,path,details={})=>{const code='MEMORY_CURRENT_VIEW_'+suffix;return {status:'MISMATCH',reason:reason(code),diagnostic:{code,path,...details}};};

/** Object key order is irrelevant. Arrays remain ordered unless explicitly treated as a definition directory. */
function difference(a,b,path){
 if(Object.is(a,b))return null;
 if(Array.isArray(a)&&Array.isArray(b)){
  if(a.length!==b.length)return path;
  for(let i=0;i<a.length;i++){const at=difference(a[i],b[i],path+'/'+i);if(at!==null)return at;}return null;
 }
 if(object(a)&&object(b)){
  for(const key of [...new Set([...Object.keys(a),...Object.keys(b)])].sort()){
   const at=path+'/'+pointer(key);if(!own(a,key)||!own(b,key))return at;
   const nested=difference(a[key],b[key],at);if(nested!==null)return nested;
  }return null;
 }
 return path;
}
const definitionRef=row=>object(row)?own(row,'definition_ref')?(text(row.definition_ref)?row.definition_ref:null):(text(row.id)?row.id:null):null;
function directory(rows,path){
 if(!Array.isArray(rows))return {error:bad('DEFINITION_DIRECTORY_INVALID',path)};
 const byRef=new Map();
 for(let i=0;i<rows.length;i++){
  const ref=definitionRef(rows[i]),at=path+'/'+i;
  if(!ref)return {error:bad('DEFINITION_REFERENCE_INVALID',at)};
  if(byRef.has(ref))return {error:bad('DEFINITION_REFERENCE_DUPLICATE',at,{definition_ref:ref})};
  byRef.set(ref,{row:rows[i],path:at});
 }return {byRef};
}
function compareDirectory(actual,expected,path){
 for(const [ref,wanted] of expected){
  const found=actual.get(ref);if(!found)return bad('FORMAL_DEFINITION_MISSING',path,{definition_ref:ref});
  const changed=difference(found.row,wanted.row,found.path);
  if(changed!==null)return bad('FORMAL_DEFINITION_CHANGED',changed,{definition_ref:ref});
 }
 for(const [ref,found] of actual)if(!expected.has(ref))return bad('FORMAL_DEFINITION_UNEXPECTED',found.path,{definition_ref:ref});
 return null;
}

/** graph.definitions may mirror the ontology or add graph-derived descriptions. Neither is rewritten. */
export function validateCurrentViewDefinitions({graph,ontology,knowledge}){
 if(!object(graph)||!object(ontology)||!Array.isArray(knowledge))return bad('DEFINITION_CONTEXT_INVALID','/domain_graph');
 const authority=directory(ontology.definitions,'/ontology/definitions');if(authority.error)return authority.error;
 if(!object(graph.ontology))return bad('ONTOLOGY_MISSING','/domain_graph/ontology');
 const mirror=directory(graph.ontology.definitions,'/domain_graph/ontology/definitions');if(mirror.error)return mirror.error;
 const mismatch=compareDirectory(mirror.byRef,authority.byRef,'/domain_graph/ontology/definitions');if(mismatch)return mismatch;
 const withoutDefinitions=value=>Object.fromEntries(Object.entries(value).filter(([key])=>key!=='definitions'));
 const ontologyDifference=difference(withoutDefinitions(graph.ontology),withoutDefinitions(ontology),'/domain_graph/ontology');
 if(ontologyDifference!==null)return bad('ONTOLOGY_CHANGED',ontologyDifference);
 if(!Array.isArray(graph.definitions))return bad('DEFINITION_DIRECTORY_INVALID','/domain_graph/definitions');
 const knownKnowledge=new Set(knowledge.flatMap(row=>[row?.knowledge_ref,row?.record_ref,row?.fact_ref,row?.id].filter(text)));
 const formal=new Map(),derived=new Set();
 for(let i=0;i<graph.definitions.length;i++){
  const row=graph.definitions[i],path='/domain_graph/definitions/'+i,ref=definitionRef(row);
  if(!object(row)||!ref)return bad('DEFINITION_REFERENCE_INVALID',path);
  // Formal source-local definitions can use id/status rather than definition_ref.
  if(own(row,'definition_ref')||authority.byRef.has(ref)||own(row,'status')){
   if(formal.has(ref)||derived.has(ref))return bad('DEFINITION_REFERENCE_DUPLICATE',path,{definition_ref:ref});
   formal.set(ref,{row,path});continue;
  }
  // This is the existing createDomainGraph description shape, not a normalized ontology assertion.
  if(Object.keys(row).some(key=>!derivedKeys.has(key))||!text(row.id)||!text(row.kind)||!text(row.name)
   ||!(row.description===undefined||row.description===null||typeof row.description==='string')
   ||!Array.isArray(row.record_refs)||!row.record_refs.length||row.record_refs.some(ref=>!text(ref)||!knownKnowledge.has(ref))
   ||new Set(row.record_refs).size!==row.record_refs.length||!Array.isArray(row.source_refs)||row.source_refs.some(source=>!object(source)))
   return bad('GRAPH_DEFINITION_INVALID',path,{definition_ref:ref});
  const sources=knowledge.filter(record=>row.record_refs.some(ref=>[record?.knowledge_ref,record?.record_ref,record?.fact_ref,record?.id].includes(ref)))
   .flatMap(record=>Array.isArray(record.source_refs)?record.source_refs:[]);
  for(let j=0;j<row.source_refs.length;j++)if(!sources.some(source=>difference(source,row.source_refs[j],'')===null))
   return bad('GRAPH_DEFINITION_SOURCE_MISMATCH',path+'/source_refs/'+j,{definition_ref:ref});
  if(derived.has(ref)||formal.has(ref))return bad('DEFINITION_REFERENCE_DUPLICATE',path,{definition_ref:ref});
  derived.add(ref);
 }
 const formalDifference=compareDirectory(formal,authority.byRef,'/domain_graph/definitions');if(formalDifference)return formalDifference;
 // Only explicit live definition bindings are checked; audit copies and unresolved shapes are not promoted.
 function references(row,path){
  if(!object(row))return null;
  for(const key of ['definition_ref','definition_id','type_definition_ref','predicate_ref','attribute_ref','rule_ref']){
   if(row[key]!==undefined&&row[key]!==null&&(!text(row[key])||!authority.byRef.has(row[key])))return bad('FORMAL_REFERENCE_MISSING',path+'/'+key,{definition_ref:typeof row[key]==='string'?row[key]:null});
  }
  for(const key of ['definition_refs','type_definition_refs'])if(Array.isArray(row[key]))for(let i=0;i<row[key].length;i++){
   if(!text(row[key][i])||!authority.byRef.has(row[key][i]))return bad('FORMAL_REFERENCE_MISSING',path+'/'+key+'/'+i,{definition_ref:row[key][i]});
  }
  for(const key of ['ontology_types'])if(Array.isArray(row[key]))for(let i=0;i<row[key].length;i++){const error=references(row[key][i],path+'/'+key+'/'+i);if(error)return error;}
  for(const key of ['ontology_alignment','relation_ontology_alignment'])if(row[key]?.status==='ALIGNED'){
   if(!text(row[key].definition_ref)||!authority.byRef.has(row[key].definition_ref))return bad('FORMAL_REFERENCE_MISSING',path+'/'+key+'/definition_ref',{definition_ref:row[key].definition_ref??null});
  }
  if(Array.isArray(row.attribute_ontology_alignments))for(let i=0;i<row.attribute_ontology_alignments.length;i++){
   const entry=row.attribute_ontology_alignments[i];if(entry?.status==='ALIGNED'&&(!text(entry.definition_ref)||!authority.byRef.has(entry.definition_ref)))return bad('FORMAL_REFERENCE_MISSING',path+'/attribute_ontology_alignments/'+i+'/definition_ref',{definition_ref:entry.definition_ref??null});
  }
  return null;
 }
 for(const [rows,path] of [[knowledge,'/knowledge'],[graph.nodes,'/domain_graph/nodes'],[graph.edges,'/domain_graph/edges']]){
  if(!Array.isArray(rows))continue;
  for(let i=0;i<rows.length;i++){const error=references(rows[i],path+'/'+i);if(error)return error;}
 }
 return {status:'READY',reason:null,definition_catalogs:{formal:formal.size,graph_derived:derived.size,representation:derived.size?'MIXED':'FORMAL_ALIAS'}};
}

/** Same contract at server readCurrentView and browser binding; immutable artifact hashes remain server-owned. */
export function validateMemoryCurrentViewContract(dto,{libraryId=null}={}){
 const b=dto?.binding,p=dto?.publication;
 if(!object(dto)||dto.schema_version!=='MEMORY_CURRENT_VIEW_V1')return bad('SCHEMA_INVALID','/schema_version');
 if(!text(dto.library_id)||libraryId&&dto.library_id!==libraryId)return bad('LIBRARY_MISMATCH','/library_id');
 if(dto.native_document_run_emulated!==false)return bad('EMULATED_RUN_FORBIDDEN','/native_document_run_emulated');
 if(!object(b))return bad('BINDING_INVALID','/binding');
 for(const key of bindingKeys)if(!text(b[key]))return bad('BINDING_INVALID','/binding/'+key);
 if(!/^[a-f0-9]{64}$/i.test(b.record_sha256))return bad('BINDING_INVALID','/binding/record_sha256');
 if(!object(p))return bad('PUBLICATION_INVALID','/publication');
 for(const [key,value] of Object.entries({library_id:dto.library_id,state:'CONFIRMED',queryable:true,mode:'NATIVE_PRODUCT',commit_ref:b.commit_ref,confirmation_ref:b.confirmation_ref}))if(p[key]!==value)return bad('PUBLICATION_MISMATCH','/publication/'+key);
 for(const key of ['publication_ref','commit_acknowledged_at','readback_confirmed_at'])if(!text(p[key]))return bad('PUBLICATION_INVALID','/publication/'+key);
 if(!Array.isArray(p.evidence_refs)||!p.evidence_refs.length||!p.evidence_refs.every(text))return bad('PUBLICATION_INVALID','/publication/evidence_refs');
 const expected={knowledge_revision_ref:b.library_revision_ref,graph_revision_ref:b.graph_revision_ref,source_index_revision:b.source_index_revision,knowledge_index_revision:b.knowledge_index_revision};
 for(const key of indexKeys)if(p.bindings?.[key]!==expected[key])return bad('PUBLICATION_BINDING_MISMATCH','/publication/bindings/'+key);
 if(!Array.isArray(dto.knowledge))return bad('KNOWLEDGE_INVALID','/knowledge');
 for(let i=0;i<dto.knowledge.length;i++){
  const row=dto.knowledge[i];if(!object(row)||!text(row.knowledge_ref??row.record_ref??row.fact_ref??row.id)||row.library_id&&row.library_id!==dto.library_id)return bad('KNOWLEDGE_INVALID','/knowledge/'+i);
 }
 const graph=dto.domain_graph;
 if(!object(graph)||!Array.isArray(graph.nodes)||!Array.isArray(graph.edges))return bad('GRAPH_INVALID','/domain_graph');
 if(graph.revision_ref!==b.graph_revision_ref||b.graph_revision_ref!==b.library_revision_ref)return bad('GRAPH_REVISION_MISMATCH','/domain_graph/revision_ref');
 if(!object(dto.identity)||!Array.isArray(dto.identity.entities))return bad('IDENTITY_INVALID','/identity');
 const identityDifference=difference(graph.identity,dto.identity,'/domain_graph/identity');if(identityDifference!==null)return bad('IDENTITY_MISMATCH',identityDifference);
 const definitions=validateCurrentViewDefinitions({graph,ontology:dto.ontology,knowledge:dto.knowledge});if(definitions.status!=='READY')return definitions;
 for(const [name,view,revision] of [['source','SOURCE',b.source_index_revision],['knowledge','EXTRACTED_KNOWLEDGE',b.knowledge_index_revision]]){
  const index=dto.indexes?.[name],path='/indexes/'+name;
  if(!object(index))return bad('INDEX_INVALID',path);
  for(const [key,value] of Object.entries({status:'READY',view,index_revision:revision}))if(index[key]!==value)return bad('INDEX_MISMATCH',path+'/'+key);
  for(const key of ['payload_ref','payload_sha256'])if(!text(index[key]))return bad('INDEX_INVALID',path+'/'+key);
  for(const [key,value] of Object.entries({library_id:dto.library_id,run_id:b.index_scope_run_id,source_snapshot_ref:b.source_snapshot_ref}))if(index.scope?.[key]!==value)return bad('INDEX_SCOPE_MISMATCH',path+'/scope/'+key);
  for(const [key,value] of Object.entries({status:'READY',view,index_revision:revision,library_id:dto.library_id,run_id:b.index_scope_run_id,source_snapshot_ref:b.source_snapshot_ref}))if(index.manifest?.[key]!==value)return bad('INDEX_MANIFEST_MISMATCH',path+'/manifest/'+key);
  if(name==='knowledge'||index.library_revision_ref!==undefined)if(index.library_revision_ref!==b.library_revision_ref)return bad('INDEX_REVISION_MISMATCH',path+'/library_revision_ref');
  if(name==='knowledge'||index.manifest.library_revision_ref!==undefined)if(index.manifest.library_revision_ref!==b.library_revision_ref)return bad('INDEX_REVISION_MISMATCH',path+'/manifest/library_revision_ref');
 }
 const source=dto.source_snapshot;
 if(!object(source)||!Array.isArray(source.documents))return bad('SOURCE_INVALID','/source_snapshot');
 if(source.library_id!==dto.library_id)return bad('SOURCE_MISMATCH','/source_snapshot/library_id');
 if((source.source_snapshot_ref??source.snapshot_id)!==b.source_snapshot_ref)return bad('SOURCE_MISMATCH','/source_snapshot/source_snapshot_ref');
 for(const key of ['source_snapshot_ref','snapshot_id'])if(source[key]!==undefined&&source[key]!==b.source_snapshot_ref)return bad('SOURCE_MISMATCH','/source_snapshot/'+key);
 return {status:'READY',reason:null,definition_catalogs:definitions.definition_catalogs};
}
