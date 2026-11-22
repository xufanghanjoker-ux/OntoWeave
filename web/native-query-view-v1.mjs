/** Read-only query data view. Qualification is supplied by the trusted Host reader. */
import {randomUUID} from 'node:crypto';
import {clone,hash,need,textField} from './cq-discovery-store-v2.mjs';

const STATES=new Set(['ACTIVE','HISTORICAL','FUTURE']);
const FACT_KINDS=new Set(['RELATION','ATTRIBUTE','RULE']);
const strings=value=>Array.isArray(value)&&value.every(textField);
const unique=(values,code)=>{need(new Set(values).size===values.length,code);return values;};
const evidenceHash=e=>hash([e.doc_ref,e.revision,e.start,e.end,e.quote]);

export function nativeQueryScope(reader){
  const scope=reader.scope();
  const scalarKeys=['view_ref','activation_ref','activation_seq','activated_at','at','temporal_view_sha256','history_capability','graph_capability','library_id','build_run_id','library_revision_ref','graph_revision_ref','publication_commit_ref','publication_confirmation_ref','source_snapshot_ref','source_epoch','manifest_ref','source_current','source_capability','fact_capability','identity_policy','adoption_revision_ref','source_index_revision','fact_index_revision','reader_manifest_ref','source_index_coverage'];
  const result=Object.fromEntries(scalarKeys.filter(key=>scope[key]!==undefined).map(key=>{const value=scope[key];need(value===null||['string','boolean'].includes(typeof value)||typeof value==='number'&&Number.isFinite(value),'NATIVE_QUERY_SCOPE_SCALAR_INVALID');return [key,value];}));
  if(scope.query_read_view!==undefined){
    const v=scope.query_read_view;
    need(v?.library_ref===scope.library_id&&v.business_manifest_ref===scope.manifest_ref&&v.view_revision===scope.view_ref&&!Object.hasOwn(v,'authorization_scope'),'QUERY_PG_VIEW_INVALID');
    result.query_read_view=clone(v);
  }
  if(scope.temporal_selection!==undefined){const t=scope.temporal_selection;need(t&&typeof t==='object'&&!Array.isArray(t)&&Object.keys(t).every(k=>['at','as_of'].includes(k))&&(t.at===null||typeof t.at==='string'),'NATIVE_QUERY_TEMPORAL_SCOPE_INVALID');result.temporal_selection=clone(t);}
  if(scope.as_of!==undefined){const a=scope.as_of;need(a===null||a&&typeof a==='object'&&!Array.isArray(a)&&Object.keys(a).length===1&&(Number.isSafeInteger(a.activation_seq)&&a.activation_seq>0||typeof a.timestamp==='string'),'NATIVE_QUERY_TEMPORAL_SCOPE_INVALID');result.as_of=clone(a);}
  if(scope.embedding_spaces!==undefined){need(Array.isArray(scope.embedding_spaces),'NATIVE_QUERY_EMBEDDING_SPACES_INVALID');result.embedding_spaces=scope.embedding_spaces.map(space=>Object.fromEntries(['space_ref','model','revision','dimensions','input_strategy','distance','normalization','config_revision'].filter(key=>space[key]!==undefined).map(key=>[key,clone(space[key])])));}
  return result;
}

export function createNativeQueryView({store,libraryId,sourceSnapshot,subjects=[],readFacts,isCurrent=()=>true,metadata={}}){
  need(textField(libraryId)&&sourceSnapshot&&Array.isArray(sourceSnapshot.documents),'NATIVE_QUERY_VIEW_INPUT_INVALID');
  need((readFacts===undefined||typeof readFacts==='function')&&typeof isCurrent==='function','NATIVE_QUERY_VIEW_PORT_INVALID');
  const hasFactReader=typeof readFacts==='function',readQualifiedFacts=readFacts??(()=>[]);
  const snapshotRef=sourceSnapshot.source_snapshot_ref??sourceSnapshot.snapshot_id;
  need(textField(snapshotRef),'NATIVE_QUERY_SNAPSHOT_REQUIRED');
  need(sourceSnapshot.library_id===undefined||sourceSnapshot.library_id===libraryId,'NATIVE_QUERY_LIBRARY_MISMATCH');
  function checkBinding(item){need(item.library_id===undefined||item.library_id===libraryId,'NATIVE_QUERY_LIBRARY_MISMATCH');need(item.source_snapshot_ref===undefined||item.source_snapshot_ref===snapshotRef,'NATIVE_QUERY_SNAPSHOT_MISMATCH');}
  const documents=sourceSnapshot.documents.map(input=>{
    checkBinding(input);
    const doc=clone(input);doc.doc_ref=input.doc_ref??input.doc_id;doc.revision=input.revision;
    need(textField(doc.doc_ref)&&textField(doc.revision)&&typeof doc.content==='string'&&doc.content.isWellFormed(),'NATIVE_QUERY_DOCUMENT_INVALID');
    doc.title=typeof doc.title==='string'?doc.title:doc.doc_ref;doc.state=doc.state??'ACTIVE';
    need(STATES.has(doc.state),'NATIVE_QUERY_SOURCE_STATE_INVALID');
    const blocks=doc.blocks?.length?doc.blocks:[{block_ref:'whole_'+hash([doc.doc_ref,doc.revision]),start:0,end:doc.content.length}];
    doc.blocks=blocks.filter(block=>block.start!==block.end).map(block=>{
      const b=clone(block);b.block_ref=block.block_ref??block.block_id??block.unit_ref;
      need(textField(b.block_ref)&&Number.isSafeInteger(b.start)&&Number.isSafeInteger(b.end)&&b.start>=0&&b.end>b.start&&b.end<=doc.content.length,'NATIVE_QUERY_BLOCK_INVALID');
      return b;
    });
    unique(doc.blocks.map(block=>block.block_ref),'NATIVE_QUERY_BLOCK_DUPLICATE');return doc;
  });
  unique(documents.map(doc=>doc.doc_ref),'NATIVE_QUERY_DOCUMENT_DUPLICATE');
  const byDoc=new Map(documents.map(doc=>[doc.doc_ref,doc]));
  function checkSource(source){const doc=byDoc.get(source?.doc_ref);need(doc&&source.revision===doc.revision,'NATIVE_QUERY_EVIDENCE_SOURCE_INVALID');return doc;}
  function checkEvidence(input){
    need(input&&textField(input.evidence_ref),'NATIVE_QUERY_EVIDENCE_REF_REQUIRED');
    checkBinding(input);
    const e=clone(input),span=e.span??e,doc=checkSource(e);
    e.start=span.start;e.end=span.end;e.quote=e.quote??span.quote;
    need((e.offset_unit??span.offset_unit??'utf16_code_unit')==='utf16_code_unit','NATIVE_QUERY_EVIDENCE_OFFSET_INVALID');
    need(Number.isSafeInteger(e.start)&&Number.isSafeInteger(e.end)&&e.start>=0&&e.end>e.start&&e.end<=doc.content.length&&typeof e.quote==='string'&&e.quote.isWellFormed()&&doc.content.slice(e.start,e.end)===e.quote,'NATIVE_QUERY_EVIDENCE_MISMATCH');
    e.offset_unit='utf16_code_unit';return e;
  }
  const sourceEvidence=new Map();
  for(const doc of documents)for(const block of doc.blocks){
    const evidence_ref=block.evidence_ref??'nquery_evidence_'+hash([libraryId,snapshotRef,doc.doc_ref,doc.revision,block.block_ref,block.start,block.end]);
    block.evidence_ref=evidence_ref;
    need(!sourceEvidence.has(evidence_ref),'NATIVE_QUERY_EVIDENCE_COLLISION');
    sourceEvidence.set(evidence_ref,checkEvidence({evidence_ref,doc_ref:doc.doc_ref,revision:doc.revision,block_ref:block.block_ref,start:block.start,end:block.end,quote:doc.content.slice(block.start,block.end),offset_unit:'utf16_code_unit',...(block.provenance?{provenance:block.provenance}:{})}));
  }
  const profiles=subjects.map(input=>{
    checkBinding(input);
    const s=clone(input);s.surface=s.surface??s.name;
    need(textField(s.subject_ref)&&textField(s.surface)&&strings(s.aliases??[]),'NATIVE_QUERY_SUBJECT_INVALID');
    s.aliases=s.aliases??[];s.source_refs=s.source_refs??[];need(Array.isArray(s.source_refs),'NATIVE_QUERY_SUBJECT_SOURCE_INVALID');s.source_refs.forEach(checkSource);
    s.evidence=(s.evidence??[]).map(checkEvidence);return s;
  });
  unique(profiles.map(s=>s.subject_ref),'NATIVE_QUERY_SUBJECT_DUPLICATE');
  const fixedEvidence=new Map(sourceEvidence);
  for(const e of profiles.flatMap(s=>s.evidence)){const prior=fixedEvidence.get(e.evidence_ref);need(!prior||evidenceHash(prior)===evidenceHash(e),'NATIVE_QUERY_EVIDENCE_COLLISION');fixedEvidence.set(e.evidence_ref,e);}
  const sourceBody={library_id:libraryId,source_snapshot_ref:snapshotRef,source_epoch:sourceSnapshot.source_epoch??null,documents,subjects:profiles};
  const payloadHash=hash(sourceBody),manifestRef='native_query_manifest_'+hash({source:payloadHash,metadata});
  if(store){
    need(['getRecord','putRecord','transaction'].every(name=>typeof store[name]==='function'),'NATIVE_QUERY_STORE_INVALID');
    store.transaction(()=>{const prior=store.getRecord('native_query_source_view_v1',payloadHash);need(!prior||hash(prior)===hash(sourceBody),'NATIVE_QUERY_VIEW_CHANGED');if(!prior)store.putRecord('native_query_source_view_v1',payloadHash,sourceBody);});
  }
  function assertCurrent(){need(sourceSnapshot.source_current!==false&&isCurrent()===true,'NATIVE_QUERY_SOURCE_STALE');return true;}
  function verifyStored(){if(store)need(hash(store.getRecord('native_query_source_view_v1',payloadHash))===payloadHash,'NATIVE_QUERY_VIEW_PAYLOAD_CHANGED');}
  function facts(){
    assertCurrent();verifyStored();const values=readQualifiedFacts();need(Array.isArray(values),'NATIVE_QUERY_FACT_READER_INVALID');
    const result=values.map(input=>{
      checkBinding(input);
      const f=clone(input);f.fact_ref=f.fact_ref??f.record_ref;
      need(textField(f.fact_ref)&&FACT_KINDS.has(f.kind)&&textField(f.subject_ref),'NATIVE_QUERY_FACT_INVALID');
      need(f.representation===undefined||f.representation==='ADOPTED_FACT','NATIVE_QUERY_FACT_REPRESENTATION_INVALID');
      need(f.policy===undefined||f.policy==='native-local-adoption-v1','NATIVE_QUERY_FACT_POLICY_INVALID');
      need(strings(f.conditions)&&typeof f.negation==='boolean'&&textField(f.modality),'NATIVE_QUERY_FACT_QUALIFIERS_REQUIRED');
      need(Array.isArray(f.source_refs)&&f.source_refs.length>0,'NATIVE_QUERY_FACT_SOURCE_REQUIRED');f.source_refs.forEach(checkSource);
      need(Array.isArray(f.evidence)&&f.evidence.length>0,'NATIVE_QUERY_FACT_EVIDENCE_REQUIRED');f.evidence=f.evidence.map(checkEvidence);
      need(f.evidence.every(e=>f.source_refs.some(s=>s.doc_ref===e.doc_ref&&s.revision===e.revision)),'NATIVE_QUERY_FACT_EVIDENCE_SOURCE_MISMATCH');
      if(f.kind==='RELATION')need(textField(f.predicate)&&textField(f.object_ref)&&f.direction==='SUBJECT_TO_OBJECT','NATIVE_QUERY_RELATION_INVALID');
      if(f.kind==='ATTRIBUTE')need(textField(f.attribute)&&Object.hasOwn(f,'raw_value')&&(f.raw_value===null||['string','boolean'].includes(typeof f.raw_value)||typeof f.raw_value==='number'&&Number.isFinite(f.raw_value)),'NATIVE_QUERY_ATTRIBUTE_INVALID');
      if(f.kind==='RULE')need(textField(f.rule_text),'NATIVE_QUERY_RULE_INVALID');
      if(f.participants!==undefined)need(Array.isArray(f.participants)&&f.participants.every(p=>textField(p.role)&&textField(p.subject_ref)),'NATIVE_QUERY_RULE_PARTICIPANT_INVALID');
      return f;
    });
    unique(result.map(f=>f.fact_ref),'NATIVE_QUERY_FACT_DUPLICATE');
    const refs=new Map(fixedEvidence);for(const e of result.flatMap(f=>f.evidence)){const prior=refs.get(e.evidence_ref);need(!prior||evidenceHash(prior)===evidenceHash(e),'NATIVE_QUERY_EVIDENCE_COLLISION');refs.set(e.evidence_ref,e);}return result;
  }
  function evidence(ref){
    assertCurrent();verifyStored();need(textField(ref),'NATIVE_QUERY_EVIDENCE_REF_REQUIRED');
    if(fixedEvidence.has(ref))return clone(fixedEvidence.get(ref));
    const matches=facts().flatMap(f=>f.evidence).filter(e=>e.evidence_ref===ref);
    return matches.length?clone(matches[0]):null;
  }
  return Object.freeze({
    scope(){assertCurrent();verifyStored();return {source_capability:'LEXICAL',fact_capability:hasFactReader?'LEXICAL':'UNAVAILABLE',...clone(metadata),library_id:libraryId,source_snapshot_ref:snapshotRef,source_epoch:sourceBody.source_epoch,manifest_ref:manifestRef,source_current:true,identity_policy:'EXACT_SOURCE_LOCAL_REF_ONLY_NO_CANONICAL_MERGE'};},
    assertCurrent,
    documents(){assertCurrent();verifyStored();return clone(documents);},
    subjects(){assertCurrent();verifyStored();return clone(profiles);},facts,evidence,
    sourceEvidence(){assertCurrent();verifyStored();return clone([...sourceEvidence.values()]);}
  });
}

/** Opaque cursors are local to a query reader and bind parameters, scope and result set. */
export function createNativeQueryPager({reader,namespace}){
  const cursors=new Map();
  return function page(rows,args={},binding={}){
    reader.assertCurrent();const size=args.page_size??12;
    need(Number.isSafeInteger(size)&&size>=1&&size<=100,'NATIVE_QUERY_PAGE_SIZE_INVALID');
    const {cursor,...parameters}=args,signature=hash({namespace,scope:nativeQueryScope(reader),parameters,binding,rows});
    let offset=0;
    if(cursor!==undefined&&cursor!==null){const saved=cursors.get(cursor);need(saved&&saved.signature===signature,'NATIVE_QUERY_CURSOR_INVALID');offset=saved.offset;}
    const items=rows.slice(offset,offset+size),more=offset+items.length<rows.length;let next_cursor=null;
    if(more){next_cursor='nquery_cursor_'+randomUUID();cursors.set(next_cursor,{signature,offset:offset+items.length});}
    return {status:rows.length?'READY':'NO_MATCH',items:clone(items),next_cursor,truncated:more,scope:nativeQueryScope(reader),coverage:'LOCAL_RETRIEVAL_NOT_EXHAUSTIVE',returned:items.length};
  };
}
