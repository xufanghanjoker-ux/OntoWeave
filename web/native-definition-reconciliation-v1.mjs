/** Definition-reference reconciliation. Meaning is checked before provenance is unioned. */
import {clone,hash,canonical} from './cq-discovery-store-v2.mjs';
import {validateCurrentViewDefinitions} from './lightog-current-view-contract-v1.mjs';
const provenance=new Set(['record_refs','knowledge_refs','source_refs']);
const observationKeys=new Set(['id','kind','name','description','record_refs','source_refs']);
const ref=row=>row?.definition_ref??row?.id;
const unique=rows=>[...new Map(rows.map(row=>[canonical(row),clone(row)])).entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,v])=>v);
const meaning=row=>Object.fromEntries(Object.entries(row).filter(([k])=>!provenance.has(k)&&!['id','definition_ref'].includes(k)));
const description=row=>({kind:row.kind,name:row.name,description:row.description??null});
const observation=row=>Object.keys(row).every(k=>observationKeys.has(k));
function failure(code,definitionRef,rows){return Object.assign(Error(code),{code,diagnostic:{definition_ref:definitionRef,contributions:rows.map(({path,row})=>({path,content_sha256:hash(row)}))}});}
function contractError(result){return Object.assign(Error(result.reason),{code:result.diagnostic.code,path:result.diagnostic.path,diagnostic:result.diagnostic});}
export function reconcileGraphDefinitions({graph,ontology,knowledge,basis=null}){
 const initial=validateCurrentViewDefinitions({graph,ontology,knowledge});
 if(initial.status==='READY')return {changed:false,graph:clone(graph),ontology:clone(ontology),projection:null};
 if(initial.diagnostic.code!=='MEMORY_CURRENT_VIEW_DEFINITION_REFERENCE_DUPLICATE')throw contractError(initial);
 const authority=new Map();for(const row of ontology.definitions){if(authority.has(ref(row)))throw contractError(initial);authority.set(ref(row),row);}
 const mirror=graph.ontology?.definitions;
 if(!Array.isArray(mirror)||mirror.length!==authority.size||new Set(mirror.map(ref)).size!==mirror.length||mirror.some(row=>!authority.has(ref(row))||hash(row)!==hash(authority.get(ref(row)))))throw contractError(initial);
 const withoutDefinitions=value=>Object.fromEntries(Object.entries(value).filter(([k])=>k!=='definitions'));
 if(hash(withoutDefinitions(graph.ontology))!==hash(withoutDefinitions(ontology)))throw contractError(initial);
 const known=new Map();for(const k of knowledge)for(const r of [k.knowledge_ref,k.record_ref,k.fact_ref,k.id].filter(Boolean))known.set(r,k);
 const groups=new Map();for(const [i,row]of graph.definitions.entries()){const r=ref(row);if(!r||row.id&&row.definition_ref&&row.id!==row.definition_ref)throw failure('NATIVE_DEFINITION_REFERENCE_CONFLICT',r,[{path:'/domain_graph/definitions/'+i,row}]);const entries=groups.get(r)??[];entries.push({path:'/domain_graph/definitions/'+i,row});groups.set(r,entries);}
 const merged=[],formal=[],audit=[];
 for(const [r,entries]of [...groups].sort(([a],[b])=>a.localeCompare(b))){
  const authoritative=authority.get(r),anchor=authoritative??[...entries].sort((a,b)=>Number(observation(a.row))-Number(observation(b.row))||canonical(a.row).localeCompare(canonical(b.row)))[0].row;
  for(const {row}of entries){
   if(hash(meaning(row))!==hash(meaning(anchor))&&!(observation(row)&&hash(description(row))===hash(description(anchor))))throw failure('NATIVE_DEFINITION_REFERENCE_CONFLICT',r,entries);
   for(const field of ['record_refs','knowledge_refs'])if(row[field]!==undefined&&(!Array.isArray(row[field])||row[field].some(id=>!known.has(id))))throw failure('NATIVE_DEFINITION_PROVENANCE_INVALID',r,entries);
   const linked=[...(row.record_refs??[]),...(row.knowledge_refs??[])].flatMap(id=>known.get(id)?.source_refs??[]);
   if(row.source_refs!==undefined&&(!Array.isArray(row.source_refs)||row.source_refs.some(s=>!linked.some(k=>hash(k)===hash(s))&&!(authoritative?.source_refs??[]).some(k=>hash(k)===hash(s)))))throw failure('NATIVE_DEFINITION_PROVENANCE_INVALID',r,entries);
  }
  const result=clone(anchor);
  for(const field of provenance){const all=[...(anchor[field]??[]),...entries.flatMap(({row})=>row[field]??[])];if(all.length||Object.hasOwn(anchor,field))result[field]=unique(all);}
  merged.push(result);if(authoritative)formal.push(result);
  if(entries.length>1)audit.push({definition_ref:r,canonical_sha256:hash(result),contributions:clone(entries)});
 }
 // Missing formal definitions stay an error. A read adapter never invents one.
 const canonicalOntology={...clone(ontology),definitions:formal},canonicalGraph={...clone(graph),definitions:merged,ontology:clone(canonicalOntology)};
 const checked=validateCurrentViewDefinitions({graph:canonicalGraph,ontology:canonicalOntology,knowledge});if(checked.status!=='READY')throw contractError(checked);
 const body={version:'DEFINITION_REFERENCE_RECONCILIATION_V1',basis:clone(basis),raw_graph_definitions_sha256:hash(graph.definitions),raw_ontology_sha256:hash(ontology),canonical_graph_definitions_sha256:hash(merged),canonical_ontology_sha256:hash(canonicalOntology),groups:audit,historical_artifacts_modified:false};
 return {changed:true,graph:canonicalGraph,ontology:canonicalOntology,projection:{...body,projection_sha256:hash(body)}};
}
