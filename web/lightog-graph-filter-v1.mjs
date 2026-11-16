/** Read-only document/version filter. It never creates an entity or semantic edge. */
import {readNativeDomainGraph} from './native-domain-graph-data-v1.mjs';
import {lightogDocumentKey} from './lightog-reading-data-v1.mjs';

const list=value=>Array.isArray(value)?value:[];
const text=value=>typeof value==='string'&&value.trim().length>0;
const refs=record=>[record?.knowledge_ref,record?.record_ref,record?.fact_ref,record?.id].filter(text);
const clone=structuredClone;
function selection(model,documentKey){
 const document=model?.documentByKey?.get(documentKey)??list(model?.documents).find(d=>d.key===documentKey);
 const valid=Boolean(document&&text(document.doc_ref)&&text(document.revision)&&lightogDocumentKey(document.doc_ref,document.revision)===documentKey);
 const rows=valid?list(model?.knowledge).filter(row=>list(row.sources).some(source=>source?.available===true&&source.document_key===documentKey&&source.doc_ref===document.doc_ref&&source.revision===document.revision)):[];
 return {document,valid,rows};
}

/** Only resolved, same-version source bindings participate; missing revisions never match. */
export function lightogSourceKnowledgeIds(readingModel,documentKey){
 if(documentKey===null||documentKey===undefined||documentKey==='')return [...new Set(list(readingModel?.knowledge).map(row=>row.id).filter(text))];
 return [...new Set(selection(readingModel,documentKey).rows.map(row=>row.id).filter(text))];
}

/** A real saved edge or entity binding is required, independent of overview limits. */
export function lightogKnowledgeHasGraphAnchor(graph,knowledgeId){
 const data=readNativeDomainGraph(graph);if(!data||!text(knowledgeId))return false;
 const id=data.knowledge_keys.get(knowledgeId)??knowledgeId;
 const bound=item=>list(item.record_refs).some(ref=>(data.knowledge_keys.get(ref)??ref)===id);
 return [...data.nodes.values()].some(bound)||[...data.edges.values()].some(bound);
}

/**
 * Return a graph payload with the same domain identities, clipped to one retained
 * document version. Top-level provenance arrays remain provenance arrays; the
 * explicit metadata counts refer only to domain nodes, edges and knowledge.
 */
export function filterLightogGraph(graph,readingModel,documentKey){
 if(documentKey===null||documentKey===undefined||documentKey==='')return graph;
 const {document,valid,rows}=selection(readingModel,documentKey),data=readNativeDomainGraph(graph);
 const ids=new Set(rows.map(row=>row.id).filter(text)),aliases=new Set(rows.flatMap(row=>[row.id,...refs(row.record)]).filter(text));
 const canonical=ref=>data?.knowledge_keys.get(ref)??ref;
 const matchingRef=ref=>aliases.has(ref)||ids.has(canonical(ref));
 const matchingRefs=item=>list(item?.record_refs).filter(matchingRef);
 const bound=item=>matchingRefs(item).length>0;
 const sameSource=source=>valid&&source?.doc_ref===document.doc_ref&&source?.revision===document.revision;
 const sourceRefs=item=>list(item?.source_refs).filter(sameSource);
 const details=values=>list(values).filter(value=>bound(value)||sourceRefs(value).length).map(value=>({...clone(value),...(Array.isArray(value.record_refs)?{record_refs:matchingRefs(value)}:{}),...(Array.isArray(value.source_refs)?{source_refs:sourceRefs(value)}:{})}));
 const edges=[...(data?.edges.values()??[])].filter(bound);
 const wantedNodes=new Set([...([...data?.nodes.values()??[]].filter(bound).map(node=>node.id)),...edges.flatMap(edge=>[edge.source,edge.target])]);
 const nodes=[...(data?.nodes.values()??[])].filter(node=>wantedNodes.has(node.id)).map(node=>({...clone(node),record_refs:matchingRefs(node),source_refs:sourceRefs(node),...(Array.isArray(node.attributes)?{attributes:details(node.attributes)}:{}),...(Array.isArray(node.rules)?{rules:details(node.rules)}:{})}));
 const realNodes=new Set(nodes.map(node=>node.id));
 const selectedEdges=edges.filter(edge=>realNodes.has(edge.source)&&realNodes.has(edge.target)).map(edge=>({...clone(edge),record_refs:matchingRefs(edge),source_refs:sourceRefs(edge),...(Array.isArray(edge.attributes)?{attributes:details(edge.attributes)}:{})}));
 const selectedKnowledge=rows.filter(row=>row.record&&typeof row.record==='object').map(row=>clone(row.record));
 const domain=graph?.domain_graph??{};
 const suppliedDefinitions=domain.definitions??domain.ontology,definitionIds=new Set(rows.flatMap(row=>list(row.definition_ids)));
 const filterDefinitions=values=>list(values).filter(value=>bound(value)||definitionIds.has(value.id??value.definition_ref??value.key)).map(value=>({...clone(value),record_refs:matchingRefs(value),...(Array.isArray(value.source_refs)?{source_refs:sourceRefs(value)}:{})}));
 const definitions=Array.isArray(suppliedDefinitions)?filterDefinitions(suppliedDefinitions):suppliedDefinitions&&typeof suppliedDefinitions==='object'?Object.fromEntries(Object.entries(suppliedDefinitions).map(([kind,values])=>[kind,filterDefinitions(values)])):[];
 const evidenceIds=new Set(rows.flatMap(row=>[...list(row.record?.evidence_refs),...list(row.record?.evidence).flatMap(e=>[e.evidence_ref,e.id])]).filter(text));
 const recordMatches=record=>refs(record).some(matchingRef);
 const topNodes=list(graph?.nodes).filter(node=>recordMatches(node)||node.kind==='DOCUMENT'&&sameSource(node)||node.kind==='EVIDENCE'&&evidenceIds.has(node.evidence_ref??node.evidence?.evidence_ref??node.id)&&sameSource(node.evidence??node)).map(node=>clone(node));
 const topNodeIds=new Set(topNodes.map(node=>node.id));
 const topEdges=list(graph?.edges).filter(edge=>matchingRef(edge.record_ref??edge.knowledge_ref)&&topNodeIds.has(edge.source)&&topNodeIds.has(edge.target)).map(edge=>clone(edge));
 const baseRevision=graph?.index_revision??domain.graph_revision??domain.version??graph?.graph_revision??null;
 const nodeIds=nodes.map(node=>node.id),edgeIds=selectedEdges.map(edge=>edge.id),knowledgeIds=[...ids];
 const versionBase=baseRevision??['UNVERSIONED',nodeIds.toSorted(),edgeIds.toSorted(),knowledgeIds.toSorted()];
 const result={...graph,index_revision:'lightog-source-view:'+JSON.stringify([versionBase,documentKey]),
  nodes:topNodes,edges:topEdges,
  ...(Array.isArray(graph?.knowledge)?{knowledge:graph.knowledge.filter(recordMatches).map(record=>clone(record))}:{}),
  ...(Array.isArray(graph?.records)?{records:graph.records.filter(recordMatches).map(record=>clone(record))}:{}),
  domain_graph:{...clone(domain),nodes,edges:selectedEdges,knowledge:selectedKnowledge,
   ...(Object.hasOwn(domain,'ontology')?{ontology:definitions}:{}),
   ...(Object.hasOwn(domain,'definitions')||!Object.hasOwn(domain,'ontology')?{definitions}:{})},
  lightog_source_filter:{document_key:documentKey,source_valid:valid,base_index_revision:baseRevision,
   knowledge_ids:knowledgeIds,node_ids:nodeIds,edge_ids:edgeIds,
   knowledge_count:knowledgeIds.length,node_count:nodeIds.length,edge_count:edgeIds.length,
   reason:valid?null:'SOURCE_VERSION_NOT_RETAINED'}};
 const anchored=new Set([...nodes,...selectedEdges].flatMap(item=>matchingRefs(item).map(canonical)));
 result.lightog_source_filter.anchor_knowledge_ids=knowledgeIds.filter(id=>anchored.has(canonical(id)));
 return result;
}
