/** Shared graph extension; deliberately independent of library/domain factories to avoid cycles. */
import {clone, hash, need, textField} from './cq-discovery-store-v2.mjs';
import {verifyNativeActionDraft} from './native-action-contract-v1.mjs';
import {isNativeActionKnowledge} from './native-action-identity-projection-v1.mjs';
const list=value=>Array.isArray(value)?value:[];
const unique=rows=>[...new Map(rows.map(row=>[hash(row),row])).values()];

export function nativeActionSourceManifest(knowledge,supplied=[]) {
  const sources=new Map();
  function add(source){
    need(source?.kind==='MEMORY_RECORD_SOURCE'&&textField(source.record_ref)&&Number.isInteger(source.version)&&source.version>0
      && source.document_evidence_eligible!==true,'ACTION_GRAPH_SOURCE_INVALID');
    const key=hash([source.record_ref,source.version]),old=sources.get(key);
    for(const field of ['source_kind','source_ingested_at','text_sha256'])
      need(old?.[field]===undefined||source[field]===undefined||old[field]===source[field],'ACTION_LIBRARY_SOURCE_CONFLICT');
    sources.set(key,{...old,...clone(source),document_evidence_eligible:false});
  }
  for(const source of supplied)add(source);
  for(const record of knowledge.filter(isNativeActionKnowledge))for(const source of list(record.source_refs)){
    need(source.kind==='MEMORY_RECORD_SOURCE'&&textField(source.record_ref),'ACTION_TYPED_SOURCE_MISSING');
    const origin=record.native_action?.source_origins.find(item=>item.source_record_ref===source.record_ref&&item.revision===source.revision);
    const row={kind:'MEMORY_RECORD_SOURCE',record_ref:source.record_ref,version:Number(source.revision),
      source_kind:source.source_kind??origin?.source_kind,document_evidence_eligible:false};
    if(origin?.source_ingested_at!==undefined)row.source_ingested_at=origin.source_ingested_at;
    add(row);
  }
  return [...sources.values()];
}

export function extendNativeActionGraph({graph,knowledge,sourceManifest=[]}) {
  // Use exactly the current records selected by the base graph, not replaced history.
  const selected=new Set(graph.knowledge.map(record=>record.knowledge_ref??record.record_ref));
  const actionRecords=knowledge.filter(record=>isNativeActionKnowledge(record)&&selected.has(record.knowledge_ref??record.record_ref));
  if(!actionRecords.length)return graph;
  const manifest=nativeActionSourceManifest(actionRecords,sourceManifest);
  const nodes=new Map(graph.nodes.map(node=>[node.id,clone(node)])),edges=new Map(graph.edges.map(edge=>[edge.id,clone(edge)])),gaps=[];
  for(const origin of manifest){
    const record=actionRecords.find(record=>record.source_record_refs.includes(origin.record_ref));
    if(!record)continue;
    const id='action_source_'+hash([record.library_id,origin.record_ref,origin.version]);
    nodes.set(id,{id,name:origin.record_ref,...clone(origin)});
  }
  function restore(node){
    const old=nodes.get(node.id);
    nodes.set(node.id,{...clone(node),...old,attributes:unique([...list(old?.attributes),...list(node.attributes)]),
      record_refs:unique([...list(old?.record_refs),...list(node.record_refs)]),source_refs:unique([...list(old?.source_refs),...list(node.source_refs)])});
  }
  for(const record of actionRecords){
    verifyNativeActionDraft(record.native_action);
    need(Array.isArray(record.action_domain_nodes)&&Array.isArray(record.action_domain_edges)
      && nodes.has(record.subject_ref),'ACTION_GRAPH_EXTENSION_MISSING');
    for(const entity of list(record.domain?.entities))if(entity.attributes?.length)restore(entity);
    for(const node of record.action_domain_nodes)restore(node);
  }
  const assertions=new Map();
  for(const record of actionRecords){
    const sourceEntity=record.domain.entities.find(entity=>entity.id===record.subject_ref);
    const statement={knowledge_ref:record.knowledge_ref??record.record_ref,native_action:clone(record.native_action),
      conditions:clone(record.conditions),modality:record.modality,negation:record.negation,valid_time:clone(record.valid_time),
      source_refs:clone(record.source_refs),resolved_subject_ref:sourceEntity?.resolved_subject_ref??null,
      resolved_participants:clone(record.participants)};
    const rows=assertions.get(record.subject_ref)??[];rows.push(statement);assertions.set(record.subject_ref,rows);
    for(const edge of record.action_domain_edges){
      if(nodes.has(edge.source)&&nodes.has(edge.target))edges.set(edge.id,clone(edge));
      else gaps.push({code:'ACTION_GRAPH_TARGET_OUTSIDE_SCOPE',record_ref:record.record_ref,edge_id:edge.id});
    }
  }
  for(const [id,rows]of assertions){
    const node=nodes.get(id);node.action_assertions=unique(rows);
    const claims=unique(rows.map(row=>row.native_action));
    if(claims.length===1)node.native_action=claims[0];
    else {delete node.native_action;node.action_summary='MULTIPLE_SOURCE_ASSERTIONS';}
    const subjects=unique(rows.map(row=>row.resolved_subject_ref).filter(Boolean));
    node.resolved_subject_refs=subjects;node.resolved_subject_ref=subjects.length===1?subjects[0]:null;
    node.resolved_participants=unique(rows.flatMap(row=>row.resolved_participants));
  }
  return {...graph,nodes:[...nodes.values()],edges:[...edges.values()],action_extension_policy:'ACTION_DOMAIN_PREPARED_V1',
    action_source_manifest:manifest,action_gaps:gaps};
}
