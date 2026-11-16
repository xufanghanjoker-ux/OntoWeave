/** Query-time lexical and compatible stored-vector retrieval. No document embedding. */
import {clone,hash,need,textField} from './cq-discovery-store-v2.mjs';
import {createNativeQueryPager,nativeQueryScope} from './native-query-view-v1.mjs';
import {nativeQueryCore} from './native-query-core-v1.mjs';
import {createQueryRanking,QUERY_RANKING_REVISION,QUERY_DELIVERY_REVISION} from './native-query-ranking-v2.mjs';

const list=value=>value===undefined?[]:Array.isArray(value)?value:[value];
// serde strings represent Unicode scalars, while legacy reader fields may
// contain lone UTF-16 units. This transport escape preserves those opaque
// fields without a JavaScript search fallback. Literal markers are escaped.
const wireMarker='\uE000';
function encodeWireString(value){let out='';for(let i=0;i<value.length;i++){
  const unit=value.charCodeAt(i);
  if(value[i]===wireMarker){out+=wireMarker+'p'+wireMarker;continue;}
  if(unit>=0xD800&&unit<=0xDBFF&&i+1<value.length){const next=value.charCodeAt(i+1);if(next>=0xDC00&&next<=0xDFFF){out+=value[i]+value[++i];continue;}}
  out+=unit>=0xD800&&unit<=0xDFFF?wireMarker+'s'+unit.toString(16).padStart(4,'0')+wireMarker:value[i];
}return out;}
const decodeWireString=value=>value.replace(/\uE000(?:p|s([0-9a-f]{4}))\uE000/g,(_match,unit)=>unit?String.fromCharCode(parseInt(unit,16)):wireMarker);
function mapWire(value,transform){
  if(typeof value==='string')return transform(value);
  if(Array.isArray(value))return value.map(item=>mapWire(item,transform));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[transform(key),mapWire(item,transform)]));
  return value;
}
const searchCore=(operation,payload)=>mapWire(nativeQueryCore(operation,mapWire(payload,encodeWireString)),decodeWireString);
function checkQueryWire(args){
  need(args&&typeof args==='object','NATIVE_QUERY_SEARCH_INPUT_INVALID');
  need(args.query===undefined||typeof args.query==='string'&&args.query.isWellFormed()&&args.query.length<=16000,'NATIVE_QUERY_SEARCH_TEXT_INVALID');
  need(list(args.keywords).every(textField),'NATIVE_QUERY_KEYWORDS_INVALID');
}
// JSON cannot encode non-finite numbers. Keep this wire-boundary rejection
// before IPC; all finite vector dimensions/norms/scores are checked by Rust.
function checkFiniteVector(values){need(!Array.isArray(values)||values.every(Number.isFinite),'NATIVE_QUERY_VECTOR_INVALID');}

export function createNativeQuerySearch({reader,embed,signal,rerank,rerankBinding,rankingOptions}={}){
  need(reader&&['scope','assertCurrent','documents','subjects','facts','evidence'].every(name=>typeof reader[name]==='function'),'NATIVE_QUERY_READER_INVALID');
  need(embed===undefined||embed===null||typeof embed==='function','NATIVE_QUERY_EMBEDDING_PORT_INVALID');
  const paginate=createNativeQueryPager({reader,namespace:'search-v2'}),queryCache=new Map(),order=createQueryRanking({reader,rerank,rerankBinding,signal,...rankingOptions});
  async function ranked(rows,args,type){
    reader.assertCurrent();checkQueryWire(args);const scope=nativeQueryScope(reader);
    // Encode an unrepresentable vector as an invalid shape, so Rust can retain
    // the original filter-before-vector-validation ordering for excluded rows.
    const wireRows=rows.map(row=>row.embedding&&((Array.isArray(row.embedding.values)&&row.embedding.values.some(v=>typeof v==='number'&&!Number.isFinite(v)))||typeof row.embedding.values==='number'&&!Number.isFinite(row.embedding.values))?{...row,embedding:{...row.embedding,values:null}}:row);
    const prepared=searchCore('search_prepare',{rows:wireRows,args,type,scope,embedding_enabled:Boolean(embed)}),query=prepared.query,queryVectors=[];
    need(prepared.ranking_revision===QUERY_RANKING_REVISION,'QUERY_RANKING_BINARY_VERSION_MISMATCH');
    if(query&&embed){
      for(const {space_ref,space}of prepared.groups){
        need(!signal?.aborted,'NATIVE_QUERY_CANCELLED');const key=hash({query,space});let values=queryCache.get(key);
        if(!values){const result=await embed([query],{inputType:'query',embeddingSpace:clone(space),signal});need(Array.isArray(result)&&result.length===1,'NATIVE_QUERY_QUERY_EMBEDDING_INVALID');checkFiniteVector(result[0]);values=searchCore('search_validate_vector',{values:result[0],space});reader.assertCurrent();queryCache.set(key,[...values]);}
        queryVectors.push({space_ref,values});
      }
    }
    const ranked=searchCore('search_finish',{prepared,query_vectors:queryVectors}),ordered=await order(ranked.rows,{query,type,cursor:args.cursor}),result=paginate(ordered.rows,args,{type,mode:ranked.mode,query,ranking_revision:QUERY_RANKING_REVISION,delivery_revision:QUERY_DELIVERY_REVISION});
    return {...result,ranking:ordered.trace,query_diagnostics:{normalized_query:query,query_components:prepared.query_components,source_refs:args.source_refs??[],scope},mode:ranked.mode,capability:ranked.capability,query_embedding_spaces:ranked.query_embedding_spaces,evidence:[...new Map(result.items.flatMap(row=>row.evidence??[]).map(e=>[e.evidence_ref,e])).values()]};
  }
  function sourceRows(){
    const rows=[],knownEvidence=typeof reader.sourceEvidence==='function'?new Map(reader.sourceEvidence().map(e=>[e.evidence_ref,e])):null;
    for(const doc of reader.documents())for(const block of doc.blocks){
      const quote=doc.content.slice(block.start,block.end),evidence_ref=block.evidence_ref??'nquery_evidence_'+hash([reader.scope().library_id,reader.scope().source_snapshot_ref,doc.doc_ref,doc.revision,block.block_ref,block.start,block.end]);
      const evidence=knownEvidence?.get(evidence_ref)??reader.evidence(evidence_ref);
      need(evidence&&evidence.quote===quote&&evidence.doc_ref===doc.doc_ref&&evidence.revision===doc.revision&&evidence.start===block.start&&evidence.end===block.end,'NATIVE_QUERY_SOURCE_EVIDENCE_CHANGED');
      const embedding=block.embedding??(doc.blocks.length===1?doc.embedding:undefined);
      rows.push({record_ref:'nquery_source_'+hash([doc.doc_ref,doc.revision,block.block_ref]),doc_ref:doc.doc_ref,revision:doc.revision,title:doc.title,state:doc.state,block_ref:block.block_ref,text:quote,search_text:quote,source_refs:[{doc_ref:doc.doc_ref,revision:doc.revision}],evidence_refs:[evidence_ref],evidence:[evidence],answer_authority:'ORIGINAL_SOURCE',...(embedding?{embedding}:{})});
    }
    return rows;
  }
  return Object.freeze({
    async findEntities(args={}){
      const mentions=list(args.mentions);need(mentions.every(textField),'NATIVE_QUERY_MENTIONS_INVALID');
      const prepared=searchCore('entity_prepare',{subjects:reader.subjects(),args}),result=await ranked(prepared.rows,prepared.args,'entities');
      const ambiguous=searchCore('entity_status',{prepared,items:result.items});
      return {...result,status:ambiguous?'AMBIGUOUS':result.status,match_type:prepared.exact_count?'EXACT_NAME_OR_ALIAS':'LEXICAL_OR_VECTOR',identity_authenticated:false};
    },
    async searchFacts(args={}){need(args.states===undefined,'NATIVE_QUERY_FACT_STATES_UNSUPPORTED');if(reader.scope().fact_capability==='UNAVAILABLE')return {status:'UNAVAILABLE_CAPABILITY',items:[],evidence:[],next_cursor:null,truncated:false,scope:nativeQueryScope(reader)};return ranked(searchCore('fact_rows',{facts:reader.facts()}),args,'facts');},
    async searchSources(args={}){return ranked(sourceRows(),args,'sources');},
    readEvidence(args={}){
      reader.assertCurrent();const refs=list(args.evidence_refs);need(refs.every(textField),'NATIVE_QUERY_EVIDENCE_REFS_INVALID');let rows;
      if(refs.length){rows=refs.map(ref=>{const e=reader.evidence(ref);need(e,'NATIVE_QUERY_EVIDENCE_UNKNOWN');return e;});}
      else{
        need(textField(args.doc_ref)&&textField(args.revision),'NATIVE_QUERY_SOURCE_REF_REQUIRED');
        const doc=reader.documents().find(d=>d.doc_ref===args.doc_ref&&d.revision===args.revision);need(doc,'NATIVE_QUERY_SOURCE_FORBIDDEN');
        const blocks=list(args.block_refs);need(blocks.every(textField),'NATIVE_QUERY_BLOCK_REFS_INVALID');
        need(blocks.every(ref=>doc.blocks.some(b=>b.block_ref===ref)),'NATIVE_QUERY_BLOCK_UNKNOWN');
        rows=sourceRows().filter(r=>r.doc_ref===doc.doc_ref&&(!blocks.length||blocks.includes(r.block_ref))).flatMap(r=>r.evidence);
      }
      return {...paginate(rows,args,{type:'evidence'}),answer_authority:'ORIGINAL_SOURCE'};
    }
  });
}
