/** Product input normalization. Full source text is retained; task batching is downstream. */
import {createHash} from 'node:crypto';
import {hydrateSource} from './source-document-adapter-v1.mjs';
const hash=text=>createHash('sha256').update(text).digest('hex');
const need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code,status:400});};
export function prepareProductInput(body,{getDocument}={}) {
  need(body&&(body.cqs===undefined||Array.isArray(body.cqs))&&Array.isArray(body.sources),'PRODUCT_INPUT_REQUIRED');
  const questions=[...new Set((body.cqs??[]).map(q=>typeof q==='string'?q:q?.question).map(q=>{
    need(typeof q==='string'&&q.isWellFormed(),'PRODUCT_CQ_INVALID');return q.trim();
  }).filter(Boolean))];
  need(body.sources.length,'PRODUCT_SOURCES_REQUIRED');
  const sources=body.sources.map((source,index)=>{
    // The original upload UI keeps parsing previews locally. Resolve them again
    // on the server; neither those previews nor client hashes become authority.
    const submitted={title:source.title,content:source.content,...(source.document_id?{document_id:source.document_id}:{})};
    const s=hydrateSource(submitted,{getDocument});
    need(typeof s.content==='string'&&s.content.trim()&&s.content.isWellFormed(),'PRODUCT_SOURCE_INVALID');
    return {...s,id:'source_'+(index+1),sha256:hash(s.content),source_role:'UPLOADED_ORIGIN_UNCONFIRMED'};
  });
  return {name:typeof body.name==='string'&&body.name.trim()?body.name.trim():'我的知识库',
    definitions:typeof body.definitions==='string'?body.definitions:'',as_of:body.as_of??null,
    cqs:questions.map((question,index)=>({id:'CQ-'+String(index+1).padStart(2,'0'),question})),sources,publication_allowed:false};
}
export function prepareProductDraft(value,{getDocument}={}) {
  if(value===null)return null;
  need(value&&typeof value==='object'&&!Array.isArray(value),'PRODUCT_DRAFT_INVALID');
  const string=(v,fallback='')=>{need(v===undefined||typeof v==='string'&&v.isWellFormed(),'PRODUCT_DRAFT_FIELD_INVALID');return v??fallback;};
  const cqs=value.cqs??'';
  need(typeof cqs==='string'||Array.isArray(cqs)&&cqs.every(q=>typeof q==='string'),'PRODUCT_DRAFT_CQ_INVALID');
  need(value.sources===undefined||Array.isArray(value.sources),'PRODUCT_DRAFT_SOURCES_INVALID');
  const sources=(value.sources??[]).map(source=>{
    const title=string(source.title),content=string(source.content);
    if(source.document_id){const s=hydrateSource({title,...(source.content===undefined?{}:{content}),document_id:source.document_id},{getDocument});return {...s,document_id:source.document_id};}
    return {title,content};
  });
  return {name:string(value.name),cqs:structuredClone(cqs),definitions:string(value.definitions),as_of:string(value.as_of),sources};
}
