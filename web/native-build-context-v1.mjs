/** Short-source preload through the public build tools. No extraction or adoption. */
import {need,clone,textField} from './cq-discovery-store-v2.mjs';
import {NATIVE_BUILD_TOOL_NAMES as N} from './native-build-host-v1.mjs';

const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
const omitted=(reason,extra={})=>({prepared:false,reason,source_text_complete:false,...extra});
const select=(value,keys)=>Object.fromEntries(keys.filter(k=>Object.hasOwn(value,k)).map(k=>[k,clone(value[k])]));

/** Pure model-facing projection; canonical receipts and evidence stay unchanged in the Host. */
export function projectNativeBuildContextForAgent(context) {
  const original=()=>clone(context);
  if(!context||context.prepared!==true||context.source_text_complete!==true||context.semantic_extraction_performed!==false||
    !Array.isArray(context.documents)||context.documents.length!==1||!Array.isArray(context.windows)||context.windows.length!==1||
    !Array.isArray(context.evidence_menu)||!context.evidence_menu.length||!Array.isArray(context.source_read_receipts)||context.source_read_receipts.length!==1)return original();
  const d=context.documents[0],w=context.windows[0],offset='utf16_code_unit';
  if(!d||!w||![d.doc_ref,d.revision,w.window_ref,w.read_receipt_ref].every(textField)||
    w.doc_ref!==d.doc_ref||w.revision!==d.revision||w.complete!==true||w.whole_document!==true||
    context.source_read_receipts[0]!==w.read_receipt_ref||!Array.isArray(w.units))return original();
  const units=new Map(w.units.map(u=>[u?.unit_ref,u]));
  if(units.size!==w.units.length)return original();
  const allowed=new Set(['evidence_ref','doc_ref','revision','window_ref','unit_ref','block_id','quote','start','end','offset_unit','provenance','representation','semantic_support_certified','kind','warnings']);
  const seen=new Set();
  for(const e of context.evidence_menu){
    if(!e||Object.keys(e).some(k=>!allowed.has(k))||![e.evidence_ref,e.unit_ref,e.quote,e.kind].every(textField)||seen.has(e.evidence_ref)||
      e.doc_ref!==d.doc_ref||e.revision!==d.revision||e.window_ref!==w.window_ref||e.offset_unit!==offset||
      e.representation!=='VERBATIM_SOURCE'||e.semantic_support_certified!==false||
      !Number.isSafeInteger(e.start)||!Number.isSafeInteger(e.end)||e.start<0||e.end-e.start!==e.quote.length)return original();
    const u=units.get(e.unit_ref);
    if(!u||u.start!==e.start||u.end!==e.end||u.offset_unit!==offset||u.kind!==e.kind||u.block_id!==e.block_id)return original();
    seen.add(e.evidence_ref);
  }
  const view=clone(context);
  delete view.source_read_receipts;
  view.windows=context.windows.map(window=>{const {units,...metadata}=window;return clone(metadata);});
  view.source={doc_ref:d.doc_ref,revision:d.revision,window_ref:w.window_ref,read_receipt_ref:w.read_receipt_ref,offset_unit:offset};
  view.evidence_menu=context.evidence_menu.map(e=>select(e,['evidence_ref','unit_ref','kind','start','end','quote','warnings']));
  view.evidence_menu_inheritance={doc_ref:'source.doc_ref',revision:'source.revision',window_ref:'source.window_ref',read_receipt_ref:'source.read_receipt_ref',offset_unit:'source.offset_unit'};
  view.evidence_authority={representation:'VERBATIM_SOURCE',semantic_support_certified:false,
    inheritance:'每条 evidence_menu 记录的公共出处由 evidence_menu_inheritance 指向的 source 字段继承；不能用于其他文档或窗口。',
    host_lookup:'完整来源 provenance、限定及定位回执仍保存在Host，按原 evidence_ref 查回；本投影不生成事实或采用资格。'};
  if(view.cq_input&&typeof view.cq_input==='object'&&!Array.isArray(view.cq_input))delete view.cq_input.mapping;
  view.projection_version='native-build-agent-context/1';
  view.token_estimate_strategy='utf8-byte-upper-bound/1';
  for(let n=0;n<8;n++){
    const size=bytes(view);if(view.context_bytes===size&&view.estimated_tokens===size)break;
    view.context_bytes=size;view.estimated_tokens=size;
  }
  return view;
}

export async function prepareNativeBuildContext({build,catalog,libraryId,snapshotId,maxChars=16000,maxUnits=256,maxContextBytes=131072,maxEstimatedTokens=131072}) {
  need(build&&typeof build.definitions==='function'&&typeof build.call==='function'&&catalog&&typeof catalog.get==='function'&&typeof catalog.isCurrent==='function','NATIVE_CONTEXT_PORT_INVALID');
  for(const value of [maxChars,maxUnits,maxContextBytes,maxEstimatedTokens])need(Number.isSafeInteger(value)&&value>0,'NATIVE_CONTEXT_BUDGET_INVALID');
  const current=()=>need(catalog.isCurrent(snapshotId,libraryId),'NATIVE_BUILD_SOURCE_STALE');
  current();
  const snapshot=catalog.get(snapshotId,libraryId);
  need(snapshot?.snapshot_id===snapshotId&&Array.isArray(snapshot.documents),'NATIVE_CONTEXT_SOURCE_INVALID');
  if(snapshot.documents.length!==1)return omitted('SINGLE_DOCUMENT_REQUIRED');
  const d=snapshot.documents[0];
  need(typeof d.content==='string'&&d.content.isWellFormed()&&Array.isArray(d.blocks),'NATIVE_CONTEXT_SOURCE_INVALID');
  if(d.content.length>maxChars)return omitted('SHORT_DOCUMENT_CHAR_BUDGET_EXCEEDED',{required_chars:d.content.length,max_chars:maxChars});
  if(d.blocks.length>maxUnits)return omitted('SHORT_DOCUMENT_UNIT_BUDGET_EXCEEDED',{required_units:d.blocks.length,max_units:maxUnits});
  if(!d.content.trim()||!d.blocks.length)return omitted('EMPTY_SOURCE');
  // UTF-8 byte count is an explicit conservative estimate, never an exact model tokenizer.
  const sourceBytes=Buffer.byteLength(d.content,'utf8');
  if(sourceBytes>maxContextBytes||sourceBytes>maxEstimatedTokens)return omitted('CONTEXT_BUDGET_EXCEEDED',{source_bytes:sourceBytes,max_context_bytes:maxContextBytes,max_estimated_tokens:maxEstimatedTokens});
  const definitions=build.definitions('EXTRACTION');
  for(const name of [N.STATE,N.READ,N.EVIDENCE])need(definitions.some(t=>t.name===name),'NATIVE_CONTEXT_TOOL_MISSING');
  const quoteLimit=definitions.find(t=>t.name===N.EVIDENCE).inputSchema?.properties?.quote?.maxLength;
  let previous=0;
  for(const b of d.blocks){
    need(textField(b.block_id)&&Number.isSafeInteger(b.start)&&Number.isSafeInteger(b.end)&&b.start>=previous&&b.end>b.start&&b.end<=d.content.length,'NATIVE_CONTEXT_SOURCE_UNIT_INVALID');
    previous=b.end;
    if(quoteLimit!==undefined&&b.end-b.start>quoteLimit)return omitted('UNIT_EXCEEDS_EVIDENCE_TOOL_LIMIT',{block_id:b.block_id,required_chars:b.end-b.start,max_quote_chars:quoteLimit});
  }
  async function call(name,args){
    current();const response=await build.call('EXTRACTION',name,args);
    need(response?.ok===true,response?.error?.code??'NATIVE_CONTEXT_TOOL_REJECTED');
    return response.result;
  }
  const state=await call(N.STATE,{});
  need(state?.cq_input&&state.families,'NATIVE_CONTEXT_INPUT_MISSING');
  if(bytes({cq_input:state.cq_input,families:state.families,source_text:d.content})>Math.min(maxContextBytes,maxEstimatedTokens))return omitted('CONTEXT_BUDGET_EXCEEDED');
  const read=await call(N.READ,{doc_ref:d.doc_id,revision:d.revision,max_chars:maxChars});
  if(read?.accepted===false)return omitted(read.code??'READ_NOT_ACCEPTED');
  need(textField(read?.window_ref)&&textField(read.read_receipt_ref)&&Array.isArray(read.units),'NATIVE_CONTEXT_READ_RECEIPT_INVALID');
  const receipts=[read.read_receipt_ref];
  if(read.complete!==true||read.whole_document!==true||read.next_cursor!==null||read.units.length!==d.blocks.length)return omitted('SOURCE_READ_INCOMPLETE',{source_read_receipts:receipts});
  if(read.text!==d.content)return omitted('SOURCE_READ_NOT_VERBATIM',{source_read_receipts:receipts});
  const unitRefs=new Set(),evidence=[];
  for(const [i,u]of read.units.entries()){
    const b=d.blocks[i];
    need(textField(u.unit_ref)&&!unitRefs.has(u.unit_ref)&&u.doc_ref===d.doc_id&&u.revision===d.revision&&u.block_id===b.block_id&&u.start===b.start&&u.end===b.end&&u.text===d.content.slice(b.start,b.end),'NATIVE_CONTEXT_READ_UNIT_MISMATCH');
    unitRefs.add(u.unit_ref);
    if(!u.text.trim())continue;
    const e=await call(N.EVIDENCE,{window_ref:read.window_ref,unit_ref:u.unit_ref,quote:u.text,occurrence:1});
    need(e?.accepted!==false&&textField(e.evidence_ref)&&e.window_ref===read.window_ref&&e.unit_ref===u.unit_ref&&e.doc_ref===d.doc_id&&e.revision===d.revision&&e.start===u.start&&e.end===u.end&&e.quote===u.text&&e.offset_unit==='utf16_code_unit','NATIVE_CONTEXT_EVIDENCE_MISMATCH');
    evidence.push({...select(e,['evidence_ref','doc_ref','revision','window_ref','unit_ref','block_id','quote','start','end','offset_unit','provenance','representation','semantic_support_certified']),kind:u.kind});
  }
  current();
  // Quote text occurs only in evidence_menu. Windows carry references and positions.
  const result={prepared:true,cq_input:clone(state.cq_input),families:clone(state.families),
    documents:[{doc_ref:d.doc_id,revision:d.revision,title:d.title,chars:d.content.length,parser:clone(d.parser??null),warnings:clone(read.warnings??[])}],
    windows:[{window_ref:read.window_ref,doc_ref:d.doc_id,revision:d.revision,read_receipt_ref:read.read_receipt_ref,complete:true,whole_document:true,units:read.units.map(u=>select(u,['unit_ref','block_id','kind','start','end','offset_unit']))}],
    evidence_menu:evidence,source_read_receipts:receipts,source_text_complete:true,semantic_extraction_performed:false,
    token_estimate_strategy:'utf8-byte-upper-bound/1',budget_scope:'PRELOADED_CONTEXT_ONLY_COMPLETE_NATIVE_REQUEST_REQUIRES_SEPARATE_GATE'};
  for(let n=0;n<8;n++){
    const size=bytes(result);if(result.context_bytes===size&&result.estimated_tokens===size)break;
    result.context_bytes=size;result.estimated_tokens=size;
  }
  if(result.context_bytes>maxContextBytes||result.estimated_tokens>maxEstimatedTokens)return omitted('CONTEXT_BUDGET_EXCEEDED',{context_bytes:result.context_bytes,estimated_tokens:result.estimated_tokens,source_read_receipts:receipts});
  return result;
}
