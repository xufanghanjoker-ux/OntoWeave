/** OFFLINE CANDIDATE ONLY. Reads one exact current library revision; never applies identity decisions. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {clone, hash, canonical} from './cq-discovery-store-v2.mjs';
import {readMemorySourceBinding,memorySourceBindingKey} from './native-memory-source-binding-v1.mjs';

const ACTIVE = 'native_library_knowledge_active_v1';
const REVISION = 'native_library_knowledge_revision_v1';
const SCHEMA = 'MEMORY_LIBRARY_CONTEXT_CANDIDATE_V1';
const DEFAULT_LIMITS = Object.freeze({max_entities:64,max_profiles:128,max_definitions:128,max_definition_mappings:256,
  max_identity_evidence_rows:512,max_raw_records:33,max_raw_input_bytes:262144,max_context_bytes:262144,
  max_sources:256,max_source_text_bytes:1048576,max_source_read_chars:12000});
const OWNING_SOURCES = Object.freeze([
  ['web/store.mjs','SQLite record ownership'],
  ['web/cq-discovery-store-v2.mjs','canonical SHA function'],
  ['web/native-memory-product-projection-v1.mjs','current active/revision binding'],
  ['web/native-library-knowledge-v1.mjs','canonical entities and identity projection shape'],
  ['web/native-library-knowledge-agent-v1.mjs','saved profiles and inherited human constraints'],
  ['web/native-action-library-preparation-v1.mjs','explicit existing identity evidence consumer']
  ,['web/native-memory-source-binding-v1.mjs','exact typed raw source verification']
  ,['web/document-catalog-v1.mjs','document snapshot and fingerprint ownership']
].map(([path,role])=>{
  const bytes=readFileSync(new URL('../'+path,import.meta.url));
  return Object.freeze({path,role,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
}));
function need(condition,code,details) {if(!condition)throw Object.assign(new Error(code),{code,...(details?{details}:{}),status:409});}
const text=value=>typeof value==='string'&&value.trim().length>0&&value.isWellFormed()&&!value.includes('\0');
function array(value,field) {need(value===undefined||Array.isArray(value),'MEMORY_LIBRARY_CONTEXT_SHAPE_INVALID',{field});return value??[];}
const bytes=value=>Buffer.byteLength(canonical(value));
const rawBody=record=>{const {status,...body}=record;return body;};

function limitsFor(input) {
  need(input&&typeof input==='object'&&!Array.isArray(input),'MEMORY_LIBRARY_CONTEXT_LIMITS_INVALID');
  need(Object.keys(input).every(key=>Object.hasOwn(DEFAULT_LIMITS,key)),'MEMORY_LIBRARY_CONTEXT_LIMITS_INVALID');
  const limits={...DEFAULT_LIMITS,...input};
  need(Object.values(limits).every(value=>Number.isSafeInteger(value)&&value>0),'MEMORY_LIBRARY_CONTEXT_LIMITS_INVALID');
  return limits;
}
function scopedRaw(record,libraryId) {
  need(record&&typeof record==='object'&&!Array.isArray(record)&&record.library_id===libraryId
    &&text(record.record_ref)&&typeof record.text==='string','MEMORY_LIBRARY_CONTEXT_RAW_SCOPE_INVALID');
  return {library_id:libraryId,record_ref:record.record_ref,version:record.version??null,
    record_sha256:hash(rawBody(record)),text_sha256:createHash('sha256').update(record.text).digest('hex')};
}
function checkedSnapshot(store,libraryId) {
  const active=store.getRecord(ACTIVE,libraryId);
  if(active===null||active===undefined)return {active:null,revision:null};
  need(active.library_id===libraryId&&text(active.revision_ref)&&text(active.run_id)&&text(active.source_snapshot_ref)
    &&/^[0-9a-f]{64}$/.test(active.record_sha256??''),'MEMORY_LIBRARY_CONTEXT_ACTIVE_INVALID');
  const revision=store.getRecord(REVISION,active.revision_ref);
  need(revision&&typeof revision==='object'&&!Array.isArray(revision),'MEMORY_LIBRARY_CONTEXT_REVISION_MISSING');
  const {record_sha256,...body}=revision;
  need(record_sha256===active.record_sha256&&hash(body)===record_sha256,'MEMORY_LIBRARY_CONTEXT_REVISION_SHA_INVALID');
  need(revision.library_id===libraryId&&revision.run_id===active.run_id&&revision.source_snapshot_ref===active.source_snapshot_ref
    &&revision.revision_ref===active.revision_ref,'MEMORY_LIBRARY_CONTEXT_REVISION_SCOPE_INVALID');
  return {active,revision};
}
function canonicalProfiles(entities) {
  // A saved profile is preferable. A missing one falls back to exact canonical fields,
  // with no reconstructed statements, inferred aliases or name-based identity relation.
  return entities.map(entity=>({...clone(entity),id:entity.canonical_id??entity.id,
    profile_basis:'CANONICAL_ENTITY_FIELDS_ONLY',source_profile_available:false}));
}
function evidenceRows(value) {
  if(Array.isArray(value))return value.length+value.reduce((count,row)=>count+evidenceRows(row),0);
  if(value&&typeof value==='object')return Object.values(value).reduce((count,row)=>count+evidenceRows(row),0);
  return 0;
}
function scopedTree(value,libraryId) {
  if(Array.isArray(value))return value.every(row=>scopedTree(row,libraryId));
  if(value&&typeof value==='object')return (!Object.hasOwn(value,'library_id')||value.library_id===libraryId)
    &&Object.values(value).every(row=>scopedTree(row,libraryId));
  return true;
}

export function createMemoryLibraryContextCandidate({store,limits={},catalog=null,coreForLibrary=null}={}) {
  need(typeof store?.getRecord==='function','MEMORY_LIBRARY_CONTEXT_STORE_REQUIRED');
  need(catalog===null||typeof catalog.get==='function'&&typeof catalog.isCurrent==='function','MEMORY_LIBRARY_CONTEXT_CATALOG_INVALID');
  need(coreForLibrary===null||typeof coreForLibrary==='function','MEMORY_LIBRARY_CONTEXT_CORE_PORT_INVALID');
  const bounded=limitsFor(limits);
  // This cache contains only exact caller-provided raw snapshots, never a mutable latest lookup.
  // Serialized contexts without a core/binding resolver cannot read a raw input after cache expiry.
  const rawSnapshots=new Map();
  function documentSnapshot(revision,libraryId) {
    const snapshot=catalog?catalog.get(revision.source_snapshot_ref,libraryId):store.getRecord('cq_v2_snapshot',revision.source_snapshot_ref);
    need(snapshot?.library_id===libraryId&&snapshot.snapshot_id===revision.source_snapshot_ref&&Array.isArray(snapshot.documents),
      'MEMORY_LIBRARY_CONTEXT_SOURCE_SNAPSHOT_INVALID');
    need(snapshot.fingerprint===hash({library_id:libraryId,source_epoch:snapshot.source_epoch,documents:snapshot.documents}),
      'MEMORY_LIBRARY_CONTEXT_SOURCE_SNAPSHOT_SHA_INVALID');
    need(new Set(snapshot.documents.map(row=>row.doc_id)).size===snapshot.documents.length,'MEMORY_LIBRARY_CONTEXT_SOURCE_DOCUMENT_DUPLICATE');
    if(catalog)need(catalog.isCurrent(revision.source_snapshot_ref,libraryId),'MEMORY_LIBRARY_CONTEXT_SOURCE_SNAPSHOT_STALE');
    return snapshot;
  }
  function sourceRows(revision,raw) {
    const rows=new Map(),unresolved=[];
    function add(source,knowledgeRef=null) {
      need(source&&typeof source==='object'&&!Array.isArray(source),'MEMORY_LIBRARY_CONTEXT_SOURCE_REF_INVALID');
      let kind,key;
      if(text(source.doc_ref)) {
        need(source.kind!== 'MEMORY_RECORD_SOURCE'&&!Object.hasOwn(source,'record_ref')&&text(source.revision),
          'MEMORY_LIBRARY_CONTEXT_SOURCE_TYPE_INVALID');
        kind='DOCUMENT';key=hash([kind,source.doc_ref,source.revision]);
      } else if(source.kind==='MEMORY_RECORD_SOURCE'&&text(source.record_ref)) {
        need(!Object.hasOwn(source,'doc_ref')&&source.document_evidence_eligible!==true,
          'MEMORY_LIBRARY_CONTEXT_SOURCE_TYPE_INVALID');
        const revision=source.revision??(Number.isSafeInteger(source.version)?String(source.version):null);
        need(text(revision)&&/^[1-9]\d*$/.test(revision),'MEMORY_LIBRARY_CONTEXT_SOURCE_REVISION_INVALID');
        kind='MEMORY_RECORD_SOURCE';key=hash([kind,source.record_ref,revision]);
      } else {
        unresolved.push({source:clone(source),knowledge_ref:knowledgeRef,reason:'SOURCE_REFERENCE_HAS_NO_EXACT_TYPED_REVISION'});return;
      }
      const old=rows.get(key)??{kind,source_key:key,source_references:[],knowledge_refs:[]};
      if(!old.source_references.some(row=>hash(row)===hash(source)))old.source_references.push(clone(source));
      if(knowledgeRef&&!old.knowledge_refs.includes(knowledgeRef))old.knowledge_refs.push(knowledgeRef);
      rows.set(key,old);
    }
    // Only current canonical provenance establishes directory authority. Historical
    // semantic/window containers and library_projection audit copies are immutable
    // lineage, not an independent registry of typed source identities.
    const authorities=new WeakSet();
    function direct(value,knowledgeRef=null) {
      if(!value||typeof value!=='object'||Array.isArray(value))return;
      authorities.add(value);
      if(value.source_refs!==undefined)for(const source of array(value.source_refs,'source_refs'))add(source,knowledgeRef);
    }
    for(const row of revision?.knowledge??[]) {
      const ref=row.knowledge_ref??row.record_ref??null;
      direct(row,ref);
      for(const entity of row.domain?.entities??[])direct(entity,ref);
      direct(row.domain?.definition,ref);direct(row.domain?.relation,ref);
      for(const entity of row.action_domain_nodes??[])direct(entity,ref);
      for(const edge of row.action_domain_edges??[])direct(edge,ref);
    }
    for(const entity of revision?.identity?.entities??[])direct(entity);
    for(const profile of revision?.identity?.profiles??[])direct(profile);
    for(const field of ['definitions','definition_mappings','unbound_shapes'])
      for(const value of revision?.ontology?.[field]??[])direct(value);
    let auditOnlyRefs=0;
    function countAudit(value) {
      if(Array.isArray(value)){for(const child of value)countAudit(child);return;}
      if(!value||typeof value!=='object')return;
      for(const [key,child]of Object.entries(value)) {
        if(key==='source_refs'&&Array.isArray(child)&&!authorities.has(value))auditOnlyRefs+=child.length;
        else countAudit(child);
      }
    }
    countAudit([revision?.knowledge??[],revision?.identity??{},revision?.ontology??{}]);
    for(const source of revision?.source_manifest??[])add(source);
    for(const record of raw) {
      need(Number.isSafeInteger(record.version)&&record.version>0&&text(record.source?.kind),
        'MEMORY_LIBRARY_CONTEXT_RAW_SOURCE_INVALID');
      add({kind:'MEMORY_RECORD_SOURCE',record_ref:record.record_ref,revision:String(record.version),version:record.version,
        source_kind:record.source.kind,text_sha256:hash(record.text),document_evidence_eligible:false});
    }
    return {rows:[...rows.values()],unresolved,projection:{policy:'CURRENT_CANONICAL_SOURCE_REFERENCES_V1',
      audit_source_refs_excluded_from_authority:auditOnlyRefs,audit_data_preserved_in_revision:true}};
  }
  function resolvedSource(row,revision,libraryId,raw) {
    const refs=row.source_references;
    if(row.kind==='DOCUMENT') {
      const source=refs[0],snapshot=documentSnapshot(revision,libraryId),document=snapshot.documents.find(doc=>doc.doc_id===source.doc_ref&&doc.revision===source.revision);
      need(document&&typeof document.content==='string','MEMORY_LIBRARY_CONTEXT_SOURCE_DOCUMENT_CHANGED');
      return {entry:{...clone(row),library_id:libraryId,doc_ref:document.doc_id,revision:document.revision,title:document.title??null,
        source_snapshot_ref:snapshot.snapshot_id,snapshot_sha256:hash(snapshot),document_sha256:hash(document),
        text_sha256:hash(document.content),text_chars:document.content.length,document_evidence_eligible:true,readable:true,
        verification_scope:catalog?'CURRENT_CATALOG_AND_FROZEN_SNAPSHOT':'FROZEN_DOCUMENT_SNAPSHOT'},text:document.content};
    }
    const source=refs[0],recordRef=source.record_ref,version=Number(source.revision??source.version);
    const saved=store.getRecord('native_memory_source_binding_v1',memorySourceBindingKey(libraryId,recordRef));
    const binding=saved?readMemorySourceBinding({store,libraryId,recordRef}):null;
    const input=raw.find(record=>record.record_ref===recordRef);
    const record=coreForLibrary?coreForLibrary(libraryId).getRawRecord(recordRef):input;
    if(record)need(record.library_id===libraryId&&record.record_ref===recordRef&&record.version===version
      &&typeof record.text==='string'&&text(record.source?.kind),'MEMORY_LIBRARY_CONTEXT_SOURCE_RAW_CHANGED');
    if(binding)need(binding.version===version&&(!record||binding.text_sha256===hash(record.text)&&binding.source_kind===record.source.kind),
      'MEMORY_LIBRARY_CONTEXT_SOURCE_RAW_CHANGED');
    const textValue=binding?.text??record?.text??null;
    const sourceKind=binding?.source_kind??record?.source.kind??refs.find(ref=>text(ref.source_kind))?.source_kind;
    const textHash=textValue===null?refs.find(ref=>text(ref.text_sha256))?.text_sha256:hash(textValue);
    need(text(sourceKind)&&/^[a-f0-9]{64}$/.test(textHash??''),'MEMORY_LIBRARY_CONTEXT_SOURCE_MANIFEST_INCOMPLETE');
    for(const ref of refs)need((ref.source_kind===undefined||ref.source_kind===sourceKind)
      &&(ref.text_sha256===undefined||ref.text_sha256===textHash),'MEMORY_LIBRARY_CONTEXT_SOURCE_MANIFEST_CHANGED');
    return {entry:{...clone(row),library_id:libraryId,record_ref:recordRef,version,revision:String(version),source_kind:sourceKind,
      text_sha256:textHash,text_chars:textValue?.length??null,binding_sha256:binding?.record_sha256??null,
      raw_record_sha256:record?hash(rawBody(record)):null,document_evidence_eligible:false,readable:textValue!==null,
      verification_scope:record?(coreForLibrary?(binding?'CORE_EXACT_VERSION_AND_IMMUTABLE_BINDING':'CORE_EXACT_VERSION'):'RAW_INPUT_PINNED')
        :binding?'IMMUTABLE_MEMORY_SOURCE_BINDING':'SIGNED_REVISION_MANIFEST_ONLY'},text:textValue};
  }
  function read(input={}) {
    need(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(key=>['library_id','record','relatedRecords'].includes(key)),
      'MEMORY_LIBRARY_CONTEXT_INPUT_INVALID');
    const {library_id:libraryId,record=null,relatedRecords=[]}=input;
    need(text(libraryId),'MEMORY_LIBRARY_CONTEXT_LIBRARY_REQUIRED');
    need(Array.isArray(relatedRecords)&&relatedRecords.length+(record?1:0)<=bounded.max_raw_records,'MEMORY_LIBRARY_CONTEXT_RAW_LIMIT');
    const raw=[...(record?[record]:[]),...relatedRecords];
    const rawPins=raw.map(value=>scopedRaw(value,libraryId));
    need(bytes(raw)<=bounded.max_raw_input_bytes,'MEMORY_LIBRARY_CONTEXT_RAW_LIMIT');
    const {active,revision}=checkedSnapshot(store,libraryId),identity=revision?.identity??{},ontology=revision?.ontology??{};
    need(identity&&typeof identity==='object'&&!Array.isArray(identity)&&ontology&&typeof ontology==='object'&&!Array.isArray(ontology),
      'MEMORY_LIBRARY_CONTEXT_SHAPE_INVALID');
    const entities=clone(array(identity.entities,'identity.entities'));
    need(entities.every(entity=>entity&&typeof entity==='object'&&text(entity.canonical_id??entity.id)
      &&(entity.library_id===undefined||entity.library_id===libraryId)),'MEMORY_LIBRARY_CONTEXT_ENTITY_SCOPE_INVALID');
    const profiles=identity.profiles===undefined?canonicalProfiles(entities):clone(array(identity.profiles,'identity.profiles'));
    need(profiles.every(profile=>profile&&typeof profile==='object'&&text(profile.id??profile.canonical_id)
      &&(profile.library_id===undefined||profile.library_id===libraryId)),'MEMORY_LIBRARY_CONTEXT_PROFILE_SCOPE_INVALID');
    const definitions=clone(array(ontology.definitions,'ontology.definitions'));
    const definitionMappings=clone(array(ontology.definition_mappings,'ontology.definition_mappings'));
    need([...definitions,...definitionMappings].every(row=>row&&typeof row==='object'&&(row.library_id===undefined||row.library_id===libraryId)),
      'MEMORY_LIBRARY_CONTEXT_DEFINITION_SCOPE_INVALID');
    const {entities:ignoredEntities,profiles:ignoredProfiles,...identityEvidence}=clone(identity);
    const gaps=[];
    // Preserve all original evidence fields, including future fields. Fill only absent known lists.
    for(const field of ['mapping','decisions','pending','blocked','redirects','inherited_human_decisions','unresolved_human_decisions']) {
      if(identityEvidence[field]===undefined)gaps.push('IDENTITY_FIELD_NOT_SAVED:'+field);
      identityEvidence[field]=array(identityEvidence[field],'identity.'+field);
    }
    need(identityEvidence.mapping.every(row=>row&&typeof row==='object'&&(row.library_id===undefined||row.library_id===libraryId)),
      'MEMORY_LIBRARY_CONTEXT_IDENTITY_SCOPE_INVALID');
    const {definitions:ignoredDefinitions,definition_mappings:ignoredMappings,...ontologyEvidence}=clone(ontology);
    need(scopedTree([entities,profiles,definitions,definitionMappings,identityEvidence,ontologyEvidence],libraryId),
      'MEMORY_LIBRARY_CONTEXT_EVIDENCE_SCOPE_INVALID');
    if(!revision)gaps.push('NO_CURRENT_LIBRARY_REVISION');
    if(identity.profiles===undefined)gaps.push('SAVED_PROFILES_UNAVAILABLE');
    const sourcePlan=sourceRows(revision,raw);
    need(sourcePlan.rows.length<=bounded.max_sources,'MEMORY_LIBRARY_CONTEXT_SOURCE_LIMIT_EXCEEDED');
    const sourceDirectory=sourcePlan.rows.map(row=>resolvedSource(row,revision,libraryId,raw).entry);
    if(sourcePlan.unresolved.length)gaps.push('SOURCE_REFERENCES_WITHOUT_EXACT_TYPED_REVISION');
    const counts={entities:entities.length,profiles:profiles.length,definitions:definitions.length,definition_mappings:definitionMappings.length,
      identity_evidence_rows:evidenceRows(identityEvidence),raw_records:rawPins.length,sources:sourceDirectory.length,
      unresolved_source_refs:sourcePlan.unresolved.length};
    for(const key of ['entities','profiles','definitions','definition_mappings','identity_evidence_rows']) {
      need(counts[key]<=bounded['max_'+key],'MEMORY_LIBRARY_CONTEXT_LIMIT_EXCEEDED',{field:key,count:counts[key],limit:bounded['max_'+key]});
    }
    const body={schema:SCHEMA,execution_label:'OFFLINE_CANDIDATE_ONLY',authority:'RETRIEVAL_CANDIDATES_ONLY',library_id:libraryId,
      current_revision:revision?{revision_ref:revision.revision_ref,record_sha256:revision.record_sha256,run_id:revision.run_id,
        source_snapshot_ref:revision.source_snapshot_ref}:null,basis_sha256:hash(active),
      entities,profiles,profile_origin:identity.profiles===undefined?'CANONICAL_ENTITY_FIELDS_ONLY':'SAVED_PROFILES',
      definitions,definition_mappings:definitionMappings,identity_evidence:identityEvidence,ontology_evidence:ontologyEvidence,
      source_directory_projection:sourcePlan.projection,
      source_directory:sourceDirectory,source_directory_complete:sourcePlan.unresolved.length===0,
      source_directory_unresolved_refs:sourcePlan.unresolved,
      raw_input_pins:rawPins,counts,limits:clone(bounded),omitted:{entities:0,profiles:0,definitions:0,definition_mappings:0,identity_evidence_rows:0},
      complete:true,selection:{policy:'ALL_OR_FAIL',truncated:false,history_scope:'CURRENT_REVISION_ONLY'},gaps,
      owning_source_sha256:clone(OWNING_SOURCES)};
    const result={...body,context_sha256:hash(body)};
    need(bytes(result)<=bounded.max_context_bytes,'MEMORY_LIBRARY_CONTEXT_BYTES_EXCEEDED',{bytes:bytes(result),limit:bounded.max_context_bytes});
    const after=checkedSnapshot(store,libraryId);
    need(hash(after.active)===hash(active)&&hash(after.revision)===hash(revision),'MEMORY_LIBRARY_CONTEXT_BASIS_CHANGED');
    // Verify exact source inputs again after assembling candidates, before caching this immutable raw snapshot.
    for(const source of sourceDirectory)need(hash(resolvedSource(source,revision,libraryId,raw).entry)===hash(source),
      'MEMORY_LIBRARY_CONTEXT_SOURCE_BASIS_CHANGED');
    rawSnapshots.set(result.context_sha256,clone(raw));
    while(rawSnapshots.size>16)rawSnapshots.delete(rawSnapshots.keys().next().value);
    return result;
  }
  function assertCurrent(context) {
    need(context?.schema===SCHEMA&&text(context.library_id),'MEMORY_LIBRARY_CONTEXT_INVALID');
    const {context_sha256,...body}=context;
    need(context_sha256===hash(body),'MEMORY_LIBRARY_CONTEXT_SHA_INVALID');
    const now=checkedSnapshot(store,context.library_id);
    need(hash(now.active)===context.basis_sha256
      &&(now.revision?hash({revision_ref:now.revision.revision_ref,record_sha256:now.revision.record_sha256,run_id:now.revision.run_id,
        source_snapshot_ref:now.revision.source_snapshot_ref}):hash(null))===hash(context.current_revision),'MEMORY_LIBRARY_CONTEXT_BASIS_CHANGED');
    need(Array.isArray(context.source_directory),'MEMORY_LIBRARY_CONTEXT_SOURCE_DIRECTORY_INVALID');
    const raw=rawSnapshots.get(context.context_sha256)??[];
    for(const source of context.source_directory)need(hash(resolvedSource(source,now.revision,context.library_id,raw).entry)===hash(source),
      'MEMORY_LIBRARY_CONTEXT_SOURCE_BASIS_CHANGED');
    return true;
  }
  function fullSource(context,sourceKey) {
    assertCurrent(context);
    const source=context.source_directory.find(row=>row.source_key===sourceKey);
    need(source,'MEMORY_LIBRARY_CONTEXT_SOURCE_NOT_IN_SCOPE');
    const revision=checkedSnapshot(store,context.library_id).revision;
    const resolved=resolvedSource(source,revision,context.library_id,rawSnapshots.get(context.context_sha256)??[]);
    need(hash(resolved.entry)===hash(source),'MEMORY_LIBRARY_CONTEXT_SOURCE_BASIS_CHANGED');
    need(typeof resolved.text==='string','MEMORY_LIBRARY_CONTEXT_SOURCE_BODY_UNAVAILABLE');
    assertCurrent(context);return {source,text:resolved.text};
  }
  function readSource({context,source_key,start=0,max_chars=6000}={}) {
    need(text(source_key)&&Number.isSafeInteger(start)&&start>=0&&Number.isSafeInteger(max_chars)&&max_chars>0
      &&max_chars<=bounded.max_source_read_chars,'MEMORY_LIBRARY_CONTEXT_SOURCE_READ_INVALID');
    const value=fullSource(context,source_key),content=value.text;
    need(start<=content.length&&!(start>0&&/[\uDC00-\uDFFF]/.test(content[start]??'')&&/[\uD800-\uDBFF]/.test(content[start-1])),
      'MEMORY_LIBRARY_CONTEXT_SOURCE_OFFSET_INVALID');
    let end=Math.min(content.length,start+max_chars);
    if(end<content.length&&/[\uD800-\uDBFF]/.test(content[end-1])&&/[\uDC00-\uDFFF]/.test(content[end]))end--;
    need(end>start||start===content.length,'MEMORY_LIBRARY_CONTEXT_SOURCE_PAGE_TOO_SMALL');
    return {kind:value.source.kind,source_key,source_ref:value.source.doc_ref??value.source.record_ref,revision:value.source.revision,
      source_kind:value.source.source_kind??null,document_evidence_eligible:value.source.document_evidence_eligible,
      text:content.slice(start,end),start,end,total_chars:content.length,next_start:end<content.length?end:null,
      truncated:start>0||end<content.length,offset_unit:'utf16_code_unit',context_sha256:context.context_sha256};
  }
  function createSourceAccess(context) {
    assertCurrent(context);
    return Object.freeze({read({kind,source_ref,revision,library_id}={}) {
      need(library_id===context.library_id&&['DOCUMENT','MEMORY_RECORD_SOURCE'].includes(kind)&&text(source_ref)&&text(revision),
        'MEMORY_LIBRARY_CONTEXT_SOURCE_ACCESS_SCOPE_INVALID');
      const selected=context.source_directory.find(row=>row.kind===kind&&(row.doc_ref??row.record_ref)===source_ref&&row.revision===revision);
      need(selected,'MEMORY_LIBRARY_CONTEXT_SOURCE_NOT_IN_SCOPE');
      const value=fullSource(context,selected.source_key);
      need(Buffer.byteLength(value.text)<=bounded.max_source_text_bytes,'MEMORY_LIBRARY_CONTEXT_SOURCE_TEXT_BYTES_EXCEEDED');
      return {kind,source_ref,revision,text:value.text,source_kind:selected.source_kind??null,
        document_evidence_eligible:selected.document_evidence_eligible,context_sha256:context.context_sha256,
        verification_scope:selected.verification_scope};
    }});
  }
  return Object.freeze({read,assertCurrent,readSource,createSourceAccess});
}
