/** Recover only complete, independently parseable objects from explicit raw SAVE arrays.
 * This reader never consumes a repaired whole-document candidate or invents item fields. */
import {parseTree} from 'jsonc-parser';
import {createHash} from 'node:crypto';

export const BUSINESS_ITEM_RECOVERY_VERSION='RAW_BUSINESS_ITEMS_V1';
const shape=(arrays,optional=['gaps','semantic_refs'])=>({arrays:Object.fromEntries(arrays.map(name=>[name,true])),optional});
const shapes={
 lightog_program_extraction_output:shape(['entities','facts','definitions','knowledge','items','candidates','statements','rules','source_statements']),
 lightog_save_semantic_statements:shape(['statements'],['gaps']),
 lightog_save_objects:shape(['objects','definitions']),
 lightog_save_relations:shape(['relations']),
 lightog_save_attributes:shape(['attributes']),
 lightog_save_rules_or_events:shape(['rules','events']),
 lightog_save_knowledge_text:shape(['statements'])
};
export const BUSINESS_ITEM_RECOVERY_TOOLS=Object.freeze(Object.keys(shapes));
export function hasDuplicateArgumentKeys(raw){return duplicateKeys(parseTree(raw));}
/** Whole repair may change separators, not container/field ownership. Missing
 * closings deliberately fall through to raw independent-item recovery. */
export function businessArgumentStructurePreserved(raw,normalized){
 function tokens(text){let at=ws(text,0),out=[];while(at<text.length){const c=text[at];if(/\s|,/.test(c)){at++;continue;}
  if(c==='"'){const end=stringEnd(text,at);if(end===null)return null;out.push(text.slice(at,end));at=end;continue;}
  if('{}[]:'.includes(c)){out.push(c);at++;continue;}
  const m=/^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(at));if(!m)return null;out.push(m[0]);at+=m[0].length;
 }return out;}
 const envelope=raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i,'$1');
 const before=tokens(envelope),after=tokens(normalized);return before!==null&&after!==null&&JSON.stringify(before)===JSON.stringify(after)&&!hasDuplicateArgumentKeys(normalized);
}
const sha=value=>createHash('sha256').update(value).digest('hex');
const ws=(raw,i)=>{while(i<raw.length&&/\s/.test(raw[i]))i++;return i;};
function stringEnd(raw,start){
 let i=start+1;while(i<raw.length){if(raw[i]==='\\'){i+=2;continue;}if(raw[i++]==='"')return i;}return null;
}
function duplicateKeys(node){
 if(!node)return true;
 if(node.type==='object'){const keys=node.children.map(p=>p.children[0].value);if(new Set(keys).size!==keys.length)return true;}
 return(node.children??[]).some(duplicateKeys);
}
function extent(raw,start){
 if(raw[start]==='"'){const end=stringEnd(raw,start);return end===null?null:{end};}
 if(!['{','['].includes(raw[start])){let end=start;while(end<raw.length&&!/[\s,\]}{[]/.test(raw[end]))end++;return end>start?{end}:null;}
 const stack=[raw[start]];for(let i=start+1;i<raw.length;i++){
  if(raw[i]==='"'){const end=stringEnd(raw,i);if(end===null)return null;i=end-1;continue;}
  if(raw[i]==='{'||raw[i]==='[')stack.push(raw[i]);
  if(raw[i]==='}'||raw[i]===']'){if(stack.pop()!==(raw[i]==='}'?'{':'['))return null;if(!stack.length)return{end:i+1};}
 }return null;
}
const nonempty=value=>typeof value==='string'&&value.trim().length>0&&value.isWellFormed();
function itemCheck(text){
 try{const value=JSON.parse(text);if(!value||Array.isArray(value)||typeof value!=='object')return'NOT_OBJECT';
  if(duplicateKeys(parseTree(text)))return'DUPLICATE_ITEM_KEY';
  // Recovery counts syntactically complete raw objects. The ordinary receiver
  // decides whether their content is useful, structurally usable, or empty.
  return null;
 }catch{return'ITEM_JSON_INVALID';}
}

export function recoverBusinessItemArguments(raw,{toolName}={}){
 const schema=Object.hasOwn(shapes,toolName)?shapes[toolName]:null;if(!schema||typeof raw!=='string')return null;
 const items=[],skipped=[],warnings=new Set(),fields=[],seen=new Set(),duplicates=new Set();
 const reject=(start,end,reason,field=null)=>{skipped.push({field,start,end,reason,raw_utf8_sha256:sha(raw.slice(start,end))});};
 let i=ws(raw,0);if(raw[i]!=='{')return null;i++;
 function array(field,start){
  const accepted=[];let at=ws(raw,start+1),index=0;
  while(at<raw.length){
   if(raw[at]===']')return{end:at+1,accepted};
   if(raw[at]==='}')return{end:at,accepted,missing_close:true};
   if(raw[at]===','){warnings.add('ARRAY_SEPARATOR_IGNORED');at=ws(raw,at+1);continue;}
   if(raw[at]==='"'){const end=stringEnd(raw,at);if(end===null){reject(at,raw.length,'UNTERMINATED_ARRAY_STRING',field);return{end:raw.length,accepted};}
    if(raw[ws(raw,end)]===':')return{end:at,accepted,missing_close:true};
   }
   const value=extent(raw,at);if(!value){reject(at,raw.length,'UNCONFIRMED_ARRAY_TAIL',field);return{end:raw.length,accepted};}
   const reason=raw[at]==='{'?itemCheck(raw.slice(at,value.end)):'NOT_INDEPENDENT_OBJECT';
   if(reason)reject(at,value.end,reason,field);else accepted.push({field,index,start:at,end:value.end,raw_utf8_sha256:sha(raw.slice(at,value.end))});
   index++;const next=ws(raw,value.end);if(![',',']','}'].includes(raw[next])&&next<raw.length)warnings.add('MISSING_ARRAY_SEPARATOR');at=raw[next]===','?ws(raw,next+1):next;
  }
  return{end:raw.length,accepted,missing_close:true};
 }
 while(i<raw.length){
  i=ws(raw,i);if(raw[i]===','){i++;continue;}if(raw[i]==='}')break;
  if(raw[i]!=='"'){reject(i,raw.length,'UNCONFIRMED_ROOT_TAIL');break;}
  const end=stringEnd(raw,i);if(end===null){reject(i,raw.length,'UNTERMINATED_ROOT_KEY');break;}
  let field;try{field=JSON.parse(raw.slice(i,end));}catch{reject(i,raw.length,'ROOT_KEY_JSON_INVALID');break;}let at=ws(raw,end);if(raw[at]!==':'){reject(i,raw.length,'ROOT_FIELD_OWNERSHIP_UNCONFIRMED');break;}
  if(seen.has(field))duplicates.add(field);seen.add(field);at=ws(raw,at+1);
  if(Object.hasOwn(schema.arrays,field)&&raw[at]==='['){
   const found=array(field,at);items.push(...found.accepted);fields.push({field,type:'items'});if(found.missing_close)warnings.add('RAW_ARRAY_BOUNDARY_RECOVERED');i=found.end;
  }else{
   const value=extent(raw,at);if(!value){reject(at,raw.length,'UNCONFIRMED_ROOT_VALUE',field);break;}
   if(Object.hasOwn(schema.arrays,field))reject(at,value.end,'BUSINESS_ARRAY_TYPE_INVALID',field);
   else if(schema.optional.includes(field)){
    try{const v=JSON.parse(raw.slice(at,value.end));if(!Array.isArray(v)||!v.every(nonempty))throw Error();fields.push({field,type:'optional',start:at,end:value.end});}
    catch{reject(at,value.end,'OPTIONAL_ROOT_FIELD_INVALID',field);}
   }else warnings.add('UNDECLARED_ROOT_FIELD_NOT_RECOVERED');
   i=value.end;
  }
 }
 const confirmed=items.filter(item=>{if(!duplicates.has(item.field))return true;reject(item.start,item.end,'DUPLICATE_ROOT_FIELD',item.field);return false;});
 const members=[];for(const field of [...new Set(fields.map(v=>v.field))]){
  if(duplicates.has(field)){warnings.add('AMBIGUOUS_ROOT_FIELD_SKIPPED');continue;}
  const entry=fields.find(v=>v.field===field);if(entry.type==='items')members.push(JSON.stringify(field)+':['+confirmed.filter(v=>v.field===field).map(v=>raw.slice(v.start,v.end)).join(',')+']');
  else members.push(JSON.stringify(field)+':'+raw.slice(entry.start,entry.end));
 }
 if(!seen.size)return null;
 const recovered_count=confirmed.length,normalized=recovered_count?'{'+members.join(',')+'}':'{}';
 return{normalized,status:recovered_count?'BUSINESS_ITEMS_RECOVERED':'UNPARSED_BUSINESS_RETAINED',warnings:[...new Set(['BUSINESS_OUTPUT_PARTIAL',...(recovered_count?['RAW_BUSINESS_ITEMS_RECOVERED']:['BUSINESS_OUTPUT_NOT_SAVED']),...warnings])],scalar_tokens_preserved:false,original_items_preserved:true,item_recovery:{version:BUSINESS_ITEM_RECOVERY_VERSION,counts_complete:false,received_count:null,recovered_count,skipped_count:null,bad_fragment_count:skipped.length,items:confirmed,skipped_ranges:skipped,warnings:[...warnings],partial:true,offset_unit:'utf16_code_unit',offset_domain:'MODEL_TOOL_ARGUMENTS_NOT_SOURCE_DOCUMENT'}};
}
