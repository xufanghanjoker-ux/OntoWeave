/** Bounded original-source reading. Stored source mappings are never rewritten. */
import {randomUUID} from 'node:crypto';
import {clone,hash,need} from './cq-discovery-store-v2.mjs';
import {nativeQueryCore} from './native-query-core-v1.mjs';
export const MAX_QUERY_READ_CHARS=16000;
function windows(text,start,end,max){const ranges=[];for(let at=start;at<end;){let to=Math.min(end,at+max);if(to<end){const lower=at+Math.floor(max/2),paragraph=text.lastIndexOf('\n\n',to),line=text.lastIndexOf('\n',to);if(paragraph>=lower)to=paragraph+2;else if(line>=lower)to=line+1;if(to>at+max)to=at+max;if(/[\uD800-\uDBFF]/.test(text[to-1]))to--;}ranges.push([at,to]);at=to;}return ranges;}
export function createQueryPassageReader({reader}){
 const cursors=new Map(),issued=new Map();
 function read(args={}){
  reader.assertCurrent();let params,rows,offset=0;
  if(args.cursor){const saved=cursors.get(args.cursor);need(saved,'NATIVE_QUERY_CURSOR_INVALID');params=saved.params;for(const [k,v]of Object.entries(args))if(k!=='cursor')need(hash(v)===hash(params[k]),'NATIVE_QUERY_CURSOR_INVALID');need(hash(reader.scope())===saved.scope,'NATIVE_QUERY_CURSOR_INVALID');rows=saved.rows;offset=saved.offset;}
  else{
   params={...clone(args),max_chars:args.max_chars??MAX_QUERY_READ_CHARS,page_size:args.page_size??12};
   need(Number.isSafeInteger(params.max_chars)&&params.max_chars>=128&&params.max_chars<=MAX_QUERY_READ_CHARS,'NATIVE_QUERY_READ_SIZE_INVALID');need(Number.isSafeInteger(params.page_size)&&params.page_size>=1&&params.page_size<=100,'NATIVE_QUERY_PAGE_SIZE_INVALID');
   const docs=reader.documents(),scopes=[];
   if(params.evidence_refs?.length){for(const ref of params.evidence_refs){const e=issued.get(ref)??reader.evidence(ref);need(e,'NATIVE_QUERY_EVIDENCE_UNKNOWN');scopes.push({...e,origin_precision:e.mapping_precision??e.origin_precision??'EXACT_SPAN'});}}
   else{const doc=docs.find(d=>d.doc_ref===params.doc_ref&&d.revision===params.revision);need(doc,'NATIVE_QUERY_SOURCE_FORBIDDEN');const blocks=params.block_refs??[];need(blocks.every(ref=>doc.blocks.some(b=>b.block_ref===ref)),'NATIVE_QUERY_BLOCK_UNKNOWN');for(const b of doc.blocks)if(!blocks.length||blocks.includes(b.block_ref))scopes.push({doc_ref:doc.doc_ref,revision:doc.revision,block_ref:b.block_ref,start:b.start,end:b.end,origin_precision:'BLOCK_ASSOCIATION'});}
   const seen=new Set();rows=[];
   for(const scope of scopes){const doc=docs.find(d=>d.doc_ref===scope.doc_ref&&d.revision===scope.revision);need(doc&&Number.isSafeInteger(scope.start)&&Number.isSafeInteger(scope.end)&&scope.start>=0&&scope.end<=doc.content.length&&scope.end>scope.start,'QUERY_SOURCE_SPAN_CHANGED');const key=hash([scope.doc_ref,scope.revision,scope.start,scope.end]);if(seen.has(key))continue;seen.add(key);
    for(const [start,end]of windows(doc.content,scope.start,scope.end,params.max_chars)){const quote=doc.content.slice(start,end),evidence_ref='query_passage_'+hash([reader.scope(),scope.doc_ref,scope.revision,start,end]);const evidence={evidence_ref,doc_ref:scope.doc_ref,revision:scope.revision,block_ref:scope.block_ref??null,start,end,quote,offset_unit:'utf16_code_unit'};
     rows.push({record_ref:evidence_ref,doc_ref:scope.doc_ref,revision:scope.revision,title:doc.title,state:doc.state??'ACTIVE',block_ref:scope.block_ref??null,evidence_ref,start,end,text:quote,evidence:[evidence],source_refs:[{doc_ref:scope.doc_ref,revision:scope.revision}],origin_precision:scope.origin_precision,source_precision:'VERIFIED_ORIGINAL_PASSAGE',passage_text_verified:true,association_not_certified:true,text_representation:'VERIFIED_ORIGINAL_PASSAGE'});}
   }
   if(params.query||params.keywords?.length){const prepared=nativeQueryCore('search_prepare',{rows:rows.map(r=>({...r,search_text:r.text})),args:{query:params.query,keywords:params.keywords},type:'sources',scope:reader.scope(),embedding_enabled:false});rows=nativeQueryCore('search_finish',{prepared,query_vectors:[]}).rows;}
  }
  const items=[];let chars=0;while(offset<rows.length&&items.length<params.page_size){const row=rows[offset];if(chars+row.text.length>params.max_chars&&items.length)break;items.push(clone(row));chars+=row.text.length;offset++;}
  for(const item of items)issued.set(item.evidence_ref,{...item.evidence[0],origin_precision:item.origin_precision});
  let next_cursor=null;if(offset<rows.length){next_cursor='nquery_read_'+randomUUID();cursors.set(next_cursor,{params,rows,offset,scope:hash(reader.scope())});}
  return {status:items.length?'READY':'NO_MATCH',items,next_cursor,truncated:!!next_cursor,returned:items.length,max_chars:params.max_chars,read_scope:'EXPLICIT_ORIGINAL_PASSAGES_NOT_EXHAUSTIVE',passage_text_verified:true,association_not_certified:true,answer_authority:'ORIGINAL_SOURCE'};
 }
 return {read};
}
