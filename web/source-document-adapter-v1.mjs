/** Server-only document hydration. Client parsing/offset/hash metadata is never authority. */
import {createHash} from 'node:crypto';
const sha=value=>createHash('sha256').update(value).digest('hex');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hex=/^[a-f0-9]{64}$/;
const need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code,status:400});};
const scalarBoundary=(text,n)=>n===0||n===text.length||!(text.charCodeAt(n-1)>=0xd800&&text.charCodeAt(n-1)<=0xdbff&&text.charCodeAt(n)>=0xdc00&&text.charCodeAt(n)<=0xdfff);
function checkedDocument(parsed,id){
 need(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&parsed.document_id===id,'SOURCE_DOCUMENT_ID_MISMATCH');
 need(parsed.parser==='docling'&&typeof parsed.parser_version==='string'&&parsed.parser_version.length>0&&parsed.offset_unit==='utf16_code_unit','SOURCE_DOCUMENT_PARSER_INVALID');
 need(typeof parsed.content==='string'&&parsed.content.trim()&&parsed.content.isWellFormed(),'SOURCE_DOCUMENT_TEXT_INVALID');
 need(hex.test(parsed.original_sha256)&&hex.test(parsed.parsed_sha256)&&sha(parsed.content)===parsed.parsed_sha256,'SOURCE_DOCUMENT_HASH_INVALID');
 need(Array.isArray(parsed.blocks)&&parsed.blocks.length>0,'SOURCE_DOCUMENT_BLOCKS_INVALID');
 const ids=new Set();let last=0;
 for(const b of parsed.blocks){
  need(b&&typeof b.block_id==='string'&&b.block_id&&!ids.has(b.block_id)&&Number.isSafeInteger(b.start)&&Number.isSafeInteger(b.end)&&b.start>=last&&b.end>b.start&&b.end<=parsed.content.length&&scalarBoundary(parsed.content,b.start)&&scalarBoundary(parsed.content,b.end)&&Array.isArray(b.provenance),'SOURCE_DOCUMENT_BLOCKS_INVALID');
  need(!parsed.content.slice(last,b.start).trim(),'SOURCE_DOCUMENT_BLOCK_GAP_INVALID');
  ids.add(b.block_id);last=b.end;
 }
 need(!parsed.content.slice(last).trim(),'SOURCE_DOCUMENT_BLOCK_GAP_INVALID');
 // The resolver (documents.get) verifies the original bytes. No filesystem path
 // or caller-provided parsing object is copied into source authority here.
 const keys=['document_id','title','extension','original_sha256','original_bytes','created_at','parser','parser_version','content','parsed_sha256','blocks','warnings','offset_unit'];
 return structuredClone(Object.fromEntries(keys.filter(k=>Object.hasOwn(parsed,k)).map(k=>[k,parsed[k]])));
}
export function hydrateSource(source,{getDocument}={}){
 need(source&&typeof source==='object'&&!Array.isArray(source),'SOURCE_DOCUMENT_SOURCE_INVALID');
 need(!Object.hasOwn(source,'parsing'),'SOURCE_CLIENT_PARSING_FORBIDDEN');
 need(Object.keys(source).every(k=>['title','content','document_id'].includes(k)),'SOURCE_DOCUMENT_SOURCE_FIELDS_INVALID');
 if(source.document_id===undefined){
  need(typeof source.title==='string'&&source.title.trim()&&typeof source.content==='string'&&source.content.trim()&&source.content.isWellFormed(),'SOURCE_DOCUMENT_SOURCE_INVALID');
  return {title:source.title,content:source.content};
 }
 need(typeof source.document_id==='string'&&uuid.test(source.document_id),'SOURCE_DOCUMENT_ID_INVALID');
 need(typeof getDocument==='function','SOURCE_DOCUMENT_RESOLVER_REQUIRED');
 const value=getDocument(source.document_id);need(!value||typeof value.then!=='function','SOURCE_DOCUMENT_RESOLVER_MUST_BE_SYNC');
 const parsed=checkedDocument(value,source.document_id);
 need(source.content===undefined||source.content===parsed.content,'SOURCE_DOCUMENT_CONTENT_CHANGED');
 const title=source.title??parsed.title;
 need(typeof title==='string'&&title.trim()&&title.length<=180,'SOURCE_DOCUMENT_TITLE_INVALID');
 return {title,content:parsed.content,parsing:parsed};
}
export function hydrateInput(input,options={}){
 need(input&&typeof input==='object'&&Array.isArray(input.sources),'SOURCE_DOCUMENT_INPUT_INVALID');
 return {...input,sources:input.sources.map(source=>hydrateSource(source,options))};
}
