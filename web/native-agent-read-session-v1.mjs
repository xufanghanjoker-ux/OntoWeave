/** Model-facing read positions belong to the Host, not to tool arguments. */
import {clone,hash} from './cq-discovery-store-v2.mjs';
export const CONTINUE_READ_SCHEMA={continue:{type:'boolean'}};
const cursorKeys=new Set(['next_after','next_offset','next_start','next_expression_after','next_expression_offset','next_saved_after','next_saved_offset']);
const envelopes=new Set(['semantic_items','expressions','text_targets','review_targets','orphan_texts','saved_knowledge','organization_focus']);
const fragmentKeys=new Set(['semantic_ref','knowledge_ref','fragment_json','offset','total_chars','complete']);
const fragment=item=>item&&typeof item==='object'&&typeof item.fragment_json==='string'&&Object.keys(item).every(key=>fragmentKeys.has(key))?Object.fromEntries(Object.entries(item).filter(([key])=>key!=='offset')):clone(item);
export function hideNativeReadPositions(value){
 if(Array.isArray(value))return value.map(fragment);
 if(!value||typeof value!=='object')return value;
 const result={};for(const [key,item]of Object.entries(value)){if(cursorKeys.has(key)||key==='offset'&&(typeof value.fragment_json==='string'||typeof value.feedback_json_fragment==='string'))continue;result[key]=key==='items'&&Array.isArray(item)?item.map(fragment):envelopes.has(key)?hideNativeReadPositions(item):clone(item);}return result;
}
export function nativePageNext(page){return page.next_after===null?null:{after:page.next_after,offset:page.next_offset??0};}
/** Delivered content, independent of selection/order and retained before cursor hiding. */
export function createNativeReadCoverage({binding=()=>null}={}){
 const entries=new Map();
 function add(key,start,end){const ranges=entries.get(key)??[];ranges.push([start,end]);const merged=[];for(const span of ranges.sort((a,b)=>a[0]-b[0])){const last=merged.at(-1);if(last&&span[0]<=last[1])last[1]=Math.max(last[1],span[1]);else merged.push([...span]);}entries.set(key,merged);}
 function record(value){
  if(Array.isArray(value)){for(const item of value)record(item);return;}
  if(!value||typeof value!=='object')return;
  const ref=value.semantic_ref??value.knowledge_ref,kind=value.semantic_ref?'SEMANTIC':'KNOWLEDGE';
  if(typeof value.fragment_json==='string'&&typeof ref==='string')add(hash([binding(),kind,ref,value.total_chars]),value.offset,value.offset+value.fragment_json.length);
  else if(typeof ref==='string'&&(typeof value.text==='string'||typeof value.statement==='string')){const total=JSON.stringify(value).length;add(hash([binding(),kind,ref,total]),0,total);}
  else if(typeof value.feedback_json_fragment==='string')add(hash([binding(),'FEEDBACK',value.total_chars]),value.offset,value.offset+value.feedback_json_fragment.length);
  // Metadata such as selected refs, comparisons, warnings and remaining work
  // are not delivery. Only actual page containers contribute content ranges.
  for(const key of ['items','semantic_items','expressions','text_targets','review_targets','orphan_texts','saved_knowledge','organization_focus'])if(value[key]!==undefined)record(value[key]);
 }
 return {record,snapshot:()=>({delivered:[...entries].sort(([a],[b])=>a.localeCompare(b)).map(([content_ref,ranges])=>({content_ref,ranges:clone(ranges)}))})};
}

/** Exact delivery coverage for structured frozen rows, independent of page/selection metadata. */
export function createNativeStructuredReadCoverage({binding=()=>null,resolveRow}={}){
 if(typeof binding!=='function'||typeof resolveRow!=='function')throw new TypeError('NATIVE_STRUCTURED_READ_COVERAGE_RESOLVER_REQUIRED');
 const entries=new Map();
 function add(key,start,end){
  const merged=[];
  for(const span of [...(entries.get(key)??[]),[start,end]].sort((a,b)=>a[0]-b[0])){
   const prior=merged.at(-1);if(prior&&span[0]<=prior[1])prior[1]=Math.max(prior[1],span[1]);else merged.push([...span]);
  }
  entries.set(key,merged);
 }
 function record(page){
  if(!page||typeof page!=='object'||typeof page.section!=='string'||!Array.isArray(page.items))return;
  for(const item of page.items){
   if(!item||typeof item!=='object'||Array.isArray(item))continue;
   const fragmented=typeof item.fragment_json==='string',ref=fragmented?item.knowledge_ref:item.ref;
   if(typeof ref!=='string')continue;
   const row=resolveRow(page.section,ref);
   if(!row||typeof row!=='object'||Array.isArray(row)||row.ref!==ref)continue;
   const text=JSON.stringify(row);let start=0,end=text.length;
   if(fragmented){
    start=item.offset;end=start+item.fragment_json.length;
    if(!Number.isSafeInteger(start)||start<0||!item.fragment_json.length||item.total_chars!==text.length||end>text.length||
      text.slice(start,end)!==item.fragment_json||item.complete!==undefined&&item.complete!==(end===text.length))continue;
   }else if(hash(item)!==hash(row))continue;
   add(hash([binding(),page.section,ref,hash(row)]),start,end);
  }
 }
 return {record,snapshot:()=>({delivered:[...entries].sort(([a],[b])=>a.localeCompare(b)).map(([content_ref,ranges])=>({content_ref,ranges:clone(ranges)}))})};
}
export function createNativeReadSession({binding=()=>null,select=()=>({}),produce,selectionFields=[],coverage=createNativeReadCoverage({binding})}){
 let current=null;
 function read(args={}){
  const warnings=[];
  if(!args||typeof args!=='object'||Array.isArray(args)){args={};warnings.push('READ_ARGUMENTS_RESET');}
  const allowed=new Set(['continue',...selectionFields]);
  if(Object.keys(args).some(k=>!allowed.has(k)))warnings.push('READ_POSITION_OWNED_BY_HOST');
  if(args.continue!==undefined&&typeof args.continue!=='boolean')warnings.push('READ_CONTINUE_INVALID_RESET');
  const explicit=selectionFields.some(k=>Object.hasOwn(args,k));
  let selection;
  try{selection=select(explicit?args:(args.continue===true&&current?current.request:{}));}
  catch(error){if(!/^NATIVE_READ_SELECTION_/.test(error.code??''))throw error;warnings.push(error.code);selection=select({});}
  const identity=hash([binding(),selection]);
  let resetReason=null;
  if(current&&identity!==current.identity)resetReason='READ_SELECTION_OR_CONTENT_CHANGED_RESET';
  if(args.continue===true&&!current)resetReason='READ_CONTINUATION_NOT_STARTED_RESET';
  const advance=args.continue===true&&current?.identity===identity&&!warnings.length;
  if(!advance)current={identity,request:Object.fromEntries(selectionFields.filter(k=>Object.hasOwn(args,k)).map(k=>[k,clone(args[k])])),positions:{},last:null};
  if(advance&&current.positions===null)return {...clone(current.last),reading:{has_more:false,feedback:['READ_ALREADY_COMPLETE']}};
  const page=produce(selection,current.positions??{});current.positions=page.next;coverage.record(page.result);
  const result={...hideNativeReadPositions(page.result),reading:{has_more:page.next!==null,...(warnings.length||resetReason?{feedback:[...warnings,...(resetReason?[resetReason]:[])]}:{})}};
  current.last=clone(result);return result;
 }
 read.progressSnapshot=()=>coverage.snapshot();return read;
}
export function createNativeSourceReader({text,sourceRefs=null}){
 const delivered=[];const read=createNativeReadSession({binding:()=>hash(text),selectionFields:['contains'],select(args){if(args.contains!==undefined&&(typeof args.contains!=='string'||!text.includes(args.contains)))throw Object.assign(Error('NATIVE_READ_SELECTION_TEXT_NOT_FOUND'),{code:'NATIVE_READ_SELECTION_TEXT_NOT_FOUND'});return {start:args.contains?text.indexOf(args.contains):0};},produce(selection,position){const start=position.start??selection.start;let end=Math.min(text.length,start+6000);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1])&&/[\uDC00-\uDFFF]/.test(text[end]))end--;delivered.push([start,end]);return {result:{text:text.slice(start,end),total_chars:text.length,scope:'CURRENT_WINDOW_MATERIAL',...(sourceRefs?{source_refs:sourceRefs}:{})},next:end<text.length?{start:end}:null};}});
 read.progressSnapshot=()=>{const ranges=[];for(const span of [...delivered].sort((a,b)=>a[0]-b[0])){const tail=ranges.at(-1);if(tail&&span[0]<=tail[1])tail[1]=Math.max(tail[1],span[1]);else ranges.push([...span]);}return {source_binding:hash([text,sourceRefs]),ranges};};return read;
}
