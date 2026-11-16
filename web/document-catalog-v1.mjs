/** Read trusted retained sources, without answer preparation, graph or embeddings. */
import {hydrateSource} from './source-document-adapter-v1.mjs';
import {createCQDiscoveryStore, hash, need, clone, textField} from './cq-discovery-store-v2.mjs';
import {cqMarkdownBlocks} from './cq-markdown-sections-v1.mjs';
const bounded = (value,low,high,fallback) => {const n=value??fallback;need(Number.isSafeInteger(n)&&n>=low&&n<=high,'CQ_PAGE_LIMIT_INVALID');return n;};
const boundary = (text,n) => n>0&&n<text.length&&/[\uDC00-\uDFFF]/.test(text[n])&&/[\uD800-\uDBFF]/.test(text[n-1])?n-1:n;
const cursor = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(value,binding) {
  if(value===undefined||value===null)return 0;
  try {const v=JSON.parse(Buffer.from(value,'base64url').toString());need(v.binding===binding&&Number.isSafeInteger(v.position)&&v.position>=0,'CQ_CURSOR_INVALID');return v.position;}
  catch {need(false,'CQ_CURSOR_INVALID');}
}
function plainBlocks(content) {
  const out=[];let start=0;
  while(start<content.length) {
    const separator=content.indexOf('\n\n',start),end=separator<0?content.length:separator;
    if(end>start)out.push({block_id:'text_'+out.length,kind:/^#{1,6}\s/.test(content.slice(start,end))?'heading':'text',start,end,provenance:[]});
    start=separator<0?content.length:separator+2;
  }
  return out;
}
/** loadLibrary is a server-owned resolver: {source_epoch,sources:[retained source]}. */
export function createDocumentCatalog({store,loadLibrary}) {
  const db=createCQDiscoveryStore(store);
  function material(libraryId) {
    const library=loadLibrary(libraryId);need(library&&Number.isSafeInteger(library.source_epoch),'CQ_LIBRARY_NOT_FOUND');
    const documents=(library.sources??[]).filter(s=>s.active!==false).map(source=>{
      const p=source.parsing;
      const trusted=hydrateSource(p?{document_id:p.document_id,title:source.title,content:source.content}:{title:source.title,content:source.content},{getDocument:()=>p});
      const content=trusted.content, blocks=clone(p?.blocks??(source.format==='markdown'?cqMarkdownBlocks(content):plainBlocks(content)));
      const doc_id=source.key??source.id??p?.document_id;need(textField(doc_id),'CQ_DOCUMENT_ID_REQUIRED');
      const revision=hash({title:trusted.title,content,parsing:p??null,source_revision:source.source_revision??null,...(source.format==='markdown'?{format:'markdown',block_parser:'cq-markdown-sections/1'}:{})});
      return {doc_id,revision,title:trusted.title.slice(0,180),title_truncated:trusted.title.length>180,format:p?.extension??(source.format==='markdown'?'markdown':'text'),parse_status:'READABLE',
        parser:p?{name:p.parser,version:p.parser_version,document_id:p.document_id,original_sha256:p.original_sha256,parsed_sha256:p.parsed_sha256}:null,
        content,blocks,...(p?{warnings:clone(p.warnings??[]),offset_unit:p.offset_unit??'utf16_code_unit'}:{}),source_revision:source.source_revision??null};
    });
    documents.sort((a,b)=>a.doc_id.localeCompare(b.doc_id));
    need(new Set(documents.map(d=>d.doc_id)).size===documents.length,'CQ_DOCUMENT_ID_DUPLICATE');
    return {library_id:libraryId,source_epoch:library.source_epoch,documents};
  }
  function freeze(libraryId,expectedEpoch) {
    const value=material(libraryId);need(value.source_epoch===expectedEpoch,'CQ_SOURCE_EPOCH_CONFLICT');need(value.documents.length,'CQ_SOURCES_REQUIRED');
    const fingerprint=hash(value),snapshot_id='snapshot_'+fingerprint;
    const snapshot={snapshot_id,fingerprint,...value};db.append('snapshot',snapshot_id,snapshot);return clone(snapshot);
  }
  function get(snapshotId,libraryId) {const s=db.get('snapshot',snapshotId);need(s&&s.library_id===libraryId,'CQ_SNAPSHOT_FORBIDDEN');return s;}
  function isCurrent(snapshotId,libraryId) {try {return get(snapshotId,libraryId).fingerprint===hash(material(libraryId));}catch{return false;}}
  function list({snapshot_id,library_id,cursor:page,limit}) {
    const s=get(snapshot_id,library_id),size=bounded(limit,1,20,10),binding=hash(['list',snapshot_id]),start=decode(page,binding);
    need(start<=s.documents.length,'CQ_CURSOR_INVALID');
    const documents=s.documents.slice(start,start+size).map(d=>({doc_id:d.doc_id,revision:d.revision,title:d.title,title_truncated:d.title_truncated,format:d.format,parse_status:d.parse_status,
      chars:d.content.length,unit_count:d.blocks.length,parser:d.parser,
      directory:d.blocks.filter(b=>/heading|title|table/.test(b.kind??'')).slice(0,32).map(b=>({block_id:b.block_id,kind:b.kind,title:d.content.slice(b.start,Math.min(b.end,b.start+120)),title_truncated:b.end-b.start>120})),
      directory_truncated:d.blocks.filter(b=>/heading|title|table/.test(b.kind??'')).length>32}));
    return {snapshot_id,documents,next_cursor:start+size<s.documents.length?cursor({binding,position:start+size}):null,read_mode:'DIRECTORY_ONLY',total_documents:s.documents.length,limits:{documents:20,directory_entries_per_document:32,title_chars:180}};
  }
  function read({snapshot_id,library_id,doc_id,revision,block_ids,cursor:page,max_chars,max_units}) {
    const s=get(snapshot_id,library_id),d=s.documents.find(d=>d.doc_id===doc_id);need(d&&d.revision===revision,'CQ_DOCUMENT_FORBIDDEN');
    need(block_ids===undefined||Array.isArray(block_ids)&&block_ids.length>0&&block_ids.length<=64&&new Set(block_ids).size===block_ids.length&&block_ids.every(b=>d.blocks.some(u=>u.block_id===b)),'CQ_BLOCKS_INVALID');
    const selected=block_ids?d.blocks.filter(b=>block_ids.includes(b.block_id)):d.blocks;
    const binding=hash(['read',snapshot_id,doc_id,revision,block_ids??null]),start=decode(page,binding),cap=bounded(max_chars,256,12000,6000),unitCap=bounded(max_units,1,512,32);
    const total=selected.reduce((n,b)=>n+b.end-b.start,0);need(start<=total,'CQ_CURSOR_INVALID');
    let skip=start,remaining=cap,consumed=0;const units=[];
    for(const b of selected) {
      const length=b.end-b.start;
      if(skip>=length){skip-=length;continue;}
      if(!remaining||units.length>=unitCap)break;
      const from=b.start+skip,to=boundary(d.content,Math.min(b.end,from+remaining));
      if(to===from)break;
      const heading=d.blocks.filter(u=>u.start<=b.start&&/heading|title/.test(u.kind??'')).at(-1);
      const header=b.kind==='table'?d.content.slice(b.start,b.end).split('\n').slice(0,2).join('\n'):null;
      units.push({block_id:b.block_id,kind:b.kind,text:d.content.slice(from,to),start:from,end:to,unit_start:b.start,unit_end:b.end,provenance:clone(b.provenance??[]),...(b.table_geometry?{table_geometry:clone(b.table_geometry)}:{}),
        heading:heading?d.content.slice(heading.start,Math.min(heading.end,heading.start+160)):null,
        heading_truncated:!!heading&&heading.end-heading.start>160,table_header:header?.slice(0,300)??null,table_header_truncated:!!header&&header.length>300,
        truncated:from!==b.start||to!==b.end});
      consumed+=to-from;remaining-=to-from;skip=0;
      if(to<b.end)break;
    }
    return {snapshot_id,doc_id,revision,units,parser:d.parser,warnings:clone(d.warnings??[]),returned_chars:consumed,offset_unit:'utf16_code_unit',selection:block_ids??'ALL_UNITS',
      next_cursor:start+consumed<total?cursor({binding,position:start+consumed}):null,read_mode:'BODY_UNITS',truncated:start+consumed<total,limits:{body_chars:cap,units:unitCap,heading_chars:160,table_header_chars:300}};
  }
  function search({snapshot_id,library_id,doc_ids,query,cursor:page,limit}) {
    need(textField(query)&&query.length<=200,'CQ_QUERY_INVALID');const s=get(snapshot_id,library_id),size=bounded(limit,1,20,10),binding=hash(['search',snapshot_id,doc_ids??null,query]),start=decode(page,binding);
    need(doc_ids===undefined||Array.isArray(doc_ids)&&doc_ids.every(k=>s.documents.some(d=>d.doc_id===k)),'CQ_DOCUMENT_FORBIDDEN');
    const hits=[];
    for(const d of s.documents.filter(d=>doc_ids===undefined||doc_ids.includes(d.doc_id)))for(const b of d.blocks) {
      const text=d.content.slice(b.start,b.end),at=text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
      if(at<0)continue;
      const from=boundary(text,Math.max(0,at-80)),to=boundary(text,Math.min(text.length,at+query.length+180));
      hits.push({doc_id:d.doc_id,revision:d.revision,block_id:b.block_id,text:text.slice(from,to),start:b.start+from,end:b.start+to,truncated:from!==0||to!==text.length});
    }
    need(start<=hits.length,'CQ_CURSOR_INVALID');
    return {snapshot_id,hits:hits.slice(start,start+size),next_cursor:start+size<hits.length?cursor({binding,position:start+size}):null,
      total_hits:hits.length,read_mode:'SEARCH_HITS_ONLY',search_scope:'AUTHORIZED_DOCUMENTS_LITERAL_SUBSTRING',searched_doc_ids:doc_ids??s.documents.map(d=>d.doc_id),limits:{hits:20,snippet_chars:460},blind_spots:'Nonmatching text was not returned; lexical hits do not establish exhaustive CQ coverage.'};
  }
  return {freeze,get,isCurrent,list,read,search};
}
/** Reuse the existing product's source resolver without calling runtime.view/ask. */
export function createProductDocumentCatalog({store,governance,runtime}) {
  return createDocumentCatalog({store,loadLibrary:libraryId=>{
    const state=governance.baseFor(libraryId);
    return state?{source_epoch:state.source_epoch,sources:runtime.sources(libraryId)}:null;
  }});
}
