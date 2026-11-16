import {modify,applyEdits,parseTree,findNodeAtOffset} from 'jsonc-parser';
/** Derived tool arguments for declared business tools, after complete SSE validation. */
import {jsonrepair} from 'jsonrepair';
import {createHash} from 'node:crypto';
import {hash,clone,need} from './cq-discovery-store-v2.mjs';
import {recoverBusinessItemArguments,BUSINESS_ITEM_RECOVERY_TOOLS,businessArgumentStructurePreserved,hasDuplicateArgumentKeys} from './native-business-item-recovery-v1.mjs';
export const PROGRAM_ARGUMENT_POLICY='PROGRAM_TOOL_ARGUMENTS_V1';
export const ARGUMENT_NORMALIZATION='native_agent_argument_normalization_v1',DERIVED_RESPONSE='native_agent_derived_response_v1';
const JSON_C_VERSION='3.3.1';
const bytesHash=value=>createHash('sha256').update(value).digest('hex');
const qualified=call=>call.namespace&&!call.name?.startsWith(call.namespace+'__')?call.namespace+'__'+call.name:call.name;
export function businessArgumentPolicy(names,{retainReviewText=false,retainBusinessOutput=false,recoverBusinessItems=false}={}){return {version:PROGRAM_ARGUMENT_POLICY,tools:Object.fromEntries(names.map(name=>[name,{syntax_repair:true,...(retainReviewText?{retain_unparsed_review:true}:{}),...(retainBusinessOutput?{retain_unparsed_business:true}:{}),...(recoverBusinessItems&&BUSINESS_ITEM_RECOVERY_TOOLS.includes(name)?{recover_business_items:true,item_recovery_tool:name}:{}),...(retainBusinessOutput&&['lightog_finish_semantic_discovery','lightog_finish_knowledge_organization'].includes(name)?{syntax_repair:false,retain_invalid_only:true}:{})}]))};}
// This is a value-preservation check, not a second repair algorithm. Only JSON
// punctuation/whitespace may change; quoted strings, keys and scalar tokens stay exact.
function atoms(text){
 const value=text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i,'$1'),result=[];let i=0;
 while(i<value.length){if(/[\s{}\[\],:]/.test(value[i])){i++;continue;}if(value[i]==='"'){const start=i++;let closed=false;while(i<value.length){const c=value[i++];if(c==='\\'){i++;continue;}if(c==='"'){closed=true;break;}}need(closed,'NATIVE_ARGUMENT_VALUE_UNCERTAIN');const token=value.slice(start,i);JSON.parse(token);result.push(token);continue;}const match=/^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(value.slice(i));need(match,'NATIVE_ARGUMENT_VALUE_UNCERTAIN');result.push(match[0]);i+=match[0].length;}
 return result;
}
/** Admit only added escapes on existing quotes inside parsed string values.
 * No source character is removed/replaced, no key is repaired, and the ordinary
 * tool's member/source/schema validation still runs after this syntax step. */
function quoteEscapeInsertions(raw,normalized){
 const edits=[];let i=0,j=0;
 while(i<raw.length&&j<normalized.length){
  if(raw[i]===normalized[j]){i++;j++;continue;}
  if(raw[i]!=='"'||normalized[j]!=='\\'||normalized[j+1]!=='"')return null;
  let slashes=0;for(let k=i-1;k>=0&&raw[k]==='\\';k--)slashes++;
  if(slashes%2)return null;
  edits.push({raw_offset:i,normalized_offset:j,inserted:'\\'});j++;
 }
 if(i!==raw.length||j!==normalized.length||!edits.length)return null;
 const tree=parseTree(normalized);
 if(!tree||edits.some(edit=>{const node=findNodeAtOffset(tree,edit.normalized_offset,true);return node?.type!=='string'||node.parent?.type==='property'&&node.parent.children[0]===node;}))return null;
 return edits;
}
export function normalizeBusinessArguments(raw,policy){
 try{const value=JSON.parse(raw);if(!(policy?.recover_business_items||policy?.retain_invalid_only)||!hasDuplicateArgumentKeys(raw)){if(value&&typeof value==='object'&&!Array.isArray(value)||!policy?.retain_unparsed_review&&!policy?.retain_unparsed_business)return null;}}catch{}
 if(!policy?.syntax_repair){if(policy?.retain_invalid_only&&policy.retain_unparsed_business)return{normalized:'{}',status:'UNPARSED_BUSINESS_RETAINED',warnings:['INVALID_FINISH_RETAINED','BUSINESS_OUTPUT_NOT_SAVED'],scalar_tokens_preserved:false,retained_without_repair:true,reason:'NATIVE_FINISH_ARGUMENTS_JSON_INVALID'};return null;}
 try{const normalized=jsonrepair(raw),value=JSON.parse(normalized);need(value&&typeof value==='object'&&!Array.isArray(value),'NATIVE_ARGUMENT_OBJECT_REQUIRED');if(policy.recover_business_items)need(!hasDuplicateArgumentKeys(normalized),'NATIVE_ARGUMENT_DUPLICATE_KEY');let tokensPreserved=false;try{tokensPreserved=hash(atoms(raw))===hash(atoms(normalized));}catch{}const escapes=tokensPreserved?null:quoteEscapeInsertions(raw,normalized);need(tokensPreserved||escapes,'NATIVE_ARGUMENT_VALUE_CHANGED');if(policy.recover_business_items&&tokensPreserved)need(businessArgumentStructurePreserved(raw,normalized),'NATIVE_ARGUMENT_FIELD_OWNERSHIP_CHANGED');return {normalized,status:'FORMAT_REPAIRED',warnings:['FORMAT_REPAIRED'],scalar_tokens_preserved:tokensPreserved,...(escapes?{repair_kind:'STRING_QUOTE_ESCAPES_ONLY',original_characters_preserved:true,quote_escape_offset_unit:'utf16_code_unit',quote_escape_insertions:escapes}:{})};}
 catch(error){if(policy.recover_business_items){const recovered=recoverBusinessItemArguments(raw,{toolName:policy.item_recovery_tool});if(recovered)return{...recovered,reason:error.code??error.name};}if(!policy.retain_unparsed_review&&!policy.retain_unparsed_business)return {status:'UNRECOVERABLE',warnings:['TOOL_ARGUMENTS_UNRECOVERABLE'],reason:error.code??error.name};return policy.retain_unparsed_review?{normalized:JSON.stringify({text:raw}),status:'UNPARSED_REVIEW_RETAINED',warnings:['UNPARSED_REVIEW_OUTPUT_RETAINED','REVIEW_INCOMPLETE'],scalar_tokens_preserved:false,reason:error.code??error.name}:{normalized:'{}',status:'UNPARSED_BUSINESS_RETAINED',warnings:['UNPARSED_BUSINESS_OUTPUT_RETAINED','BUSINESS_OUTPUT_NOT_SAVED'],scalar_tokens_preserved:false,reason:error.code??error.name};}
}
function framesOf(bytes){return bytes.toString('utf8').split(/(?<=\n\n)|(?<=\r\n\r\n)/).filter(Boolean).map(raw=>{const data=raw.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');return {raw,data,event:!data||data==='[DONE]'?null:JSON.parse(data)};});}
/** No mutation of raw bytes or call identity. All argument copies are rewritten together. */
export function deriveNativeToolArguments({bytes,policy,allowedNames,runId,invocationRef,requestRef}){
 if(!policy)return {body:bytes,audits:[]};need(policy.version===PROGRAM_ARGUMENT_POLICY&&policy.tools&&typeof policy.tools==='object','NATIVE_PROGRAM_ARGUMENT_POLICY_INVALID');
 const frames=framesOf(bytes),completed=frames.find(f=>f.event?.type==='response.completed')?.event.response;need(completed?.status==='completed','NATIVE_ARGUMENT_STREAM_UNCONFIRMED');
 const changes=[];
 for(const call of completed.output??[]){if(call.type!=='function_call')continue;const name=qualified(call),short=call.name?.split('__').at(-1),entry=policy.tools[short];if(!entry)continue;need(allowedNames.includes(name),'NATIVE_ARGUMENT_TOOL_FORBIDDEN');
  const repair=normalizeBusinessArguments(call.arguments,entry);if(!repair||repair.status==='UNRECOVERABLE')continue;
  need(typeof call.id==='string'&&typeof call.call_id==='string','NATIVE_ARGUMENT_CALL_ID_MISSING');const copies=[],deltas=[];
  for(const {event:e}of frames){if(!e)continue;if(e.item?.id===call.id&&e.item.type==='function_call'){need(e.item.call_id===call.call_id&&qualified(e.item)===name,'NATIVE_ARGUMENT_CALL_ID_CHANGED');if(e.type==='response.output_item.done')copies.push(e.item.arguments);}
   if(e.item_id===call.id&&e.type==='response.function_call_arguments.delta')deltas.push(e.delta);
   if(e.item_id===call.id&&e.type==='response.function_call_arguments.done')copies.push(e.arguments);
  }
  need(copies.every(v=>v===call.arguments)&&(!deltas.length||deltas.every(v=>typeof v==='string')&&deltas.join('')===call.arguments),'NATIVE_ARGUMENT_STREAM_COPIES_MISMATCH');
  changes.push({call,name,short,...repair,raw:call.arguments,raw_arguments_sha256:hash(call.arguments),normalized_arguments_sha256:hash(repair.normalized),delta_count:deltas.length,done_copy_count:copies.length});
 }
 if(!changes.length)return {body:bytes,audits:[]};
 need(new Set(changes.map(c=>c.call.id)).size===changes.length&&new Set(changes.map(c=>c.call.call_id)).size===changes.length,'NATIVE_ARGUMENT_CALL_ID_DUPLICATE');
 const byItem=new Map(changes.map(c=>[c.call.id,c])),emitted=new Set();
 const body=Buffer.from(frames.map(frame=>{const e=frame.event;if(!e)return frame.raw;let data=frame.data,changed=false;
  const replace=(path,value)=>{data=applyEdits(data,modify(data,path,value,{}));changed=true;};
  const item=(value,path)=>{const c=byItem.get(value?.id);if(!c)return;need(value.call_id===c.call.call_id&&qualified(value)===c.name,'NATIVE_ARGUMENT_CALL_ID_CHANGED');if(typeof value.arguments==='string'&&value.arguments!=='')replace([...path,'arguments'],c.normalized);};
  if(e.item)item(e.item,['item']);if(e.response?.output)for(const [index,value]of e.response.output.entries())item(value,['response','output',index]);
  const c=byItem.get(e.item_id);if(c&&e.type==='response.function_call_arguments.delta'){replace(['delta'],emitted.has(c.call.id)?'':c.normalized);emitted.add(c.call.id);}if(c&&e.type==='response.function_call_arguments.done')replace(['arguments'],c.normalized);
  if(!changed)return frame.raw;const eol=frame.raw.includes('\r\n')?'\r\n':'\n';const lines=frame.raw.split(/\r?\n/).filter(line=>!line.startsWith('data:')&&line!=='');return [...lines,'data: '+data,'',''].join(eol);
 }).join(''));
 const audits=changes.map(c=>{const value={version:PROGRAM_ARGUMENT_POLICY,run_id:runId,invocation_ref:invocationRef,request_ref:requestRef,tool_name:c.short,qualified_tool_name:c.name,item_id:c.call.id,call_id:c.call.call_id,raw_arguments:c.raw,normalized_arguments:c.normalized,raw_arguments_sha256:c.raw_arguments_sha256,normalized_arguments_sha256:c.normalized_arguments_sha256,status:c.status,warnings:c.warnings,repair_library:c.retained_without_repair?'NONE_RAW_RETAINED':c.item_recovery?'RAW_INDEPENDENT_ITEMS_V1':'jsonrepair@3.15.0',sse_string_editor:'jsonc-parser@'+JSON_C_VERSION,scalar_tokens_preserved:c.scalar_tokens_preserved,...(c.retained_without_repair?{retained_without_repair:true}:{}),...(c.item_recovery?{item_recovery:c.item_recovery,original_items_preserved:c.original_items_preserved}:{}),...(c.repair_kind?{repair_kind:c.repair_kind,original_characters_preserved:c.original_characters_preserved,quote_escape_offset_unit:c.quote_escape_offset_unit,quote_escape_insertions:c.quote_escape_insertions}:{}),semantic_equivalence_claimed:false,response_byte_preserving:false,raw_response_sha256:bytesHash(bytes),derived_response_sha256:bytesHash(body),delta_count:c.delta_count,done_copy_count:c.done_copy_count};const auditBody={normalization_ref:'argument_normalization_'+hash([invocationRef,requestRef,c.call.call_id]),...value};return {...auditBody,record_sha256:hash(auditBody)};});
 return {body,audits};
}
export function normalizationSummary(records){return {policy:PROGRAM_ARGUMENT_POLICY,records:records.length,format_repaired:records.filter(r=>r.status==='FORMAT_REPAIRED').length,business_items_recovered:records.filter(r=>r.status==='BUSINESS_ITEMS_RECOVERED').length,recovered_items:records.reduce((n,r)=>n+(r.item_recovery?.recovered_count??0),0),unparsed_business_retained:records.filter(r=>r.status==='UNPARSED_BUSINESS_RETAINED').length,unparsed_review_retained:records.filter(r=>r.status==='UNPARSED_REVIEW_RETAINED').length,warnings:[...new Set(records.flatMap(r=>r.warnings))],response_byte_preserving:records.length===0};}

/** Host-only recovery view, never an admission/semantic correctness decision. */
export function businessOutputRecovery({store,runId,name,args,ctx={}}){
 const refs=ctx.argument_normalization_refs??[];if(!refs.length)return null;
 const records=refs.map(ref=>store.getRecord(ARGUMENT_NORMALIZATION,ref));need(records.every(Boolean),'NATIVE_ARGUMENT_NORMALIZATION_MISSING');
 for(const r of records){const{record_sha256,...body}=r;need(r.run_id===runId&&r.invocation_ref===ctx.invocation_ref&&r.tool_name===name&&hash(JSON.parse(r.normalized_arguments))===hash(args??{})&&r.record_sha256===hash(body),'NATIVE_ARGUMENT_NORMALIZATION_BINDING_INVALID');if(ctx.native_tool_batch_ref)need(r.request_ref===ctx.native_tool_batch_ref,'NATIVE_ARGUMENT_NORMALIZATION_BINDING_INVALID');if(ctx.native_tool_call_id)need(r.call_id===ctx.native_tool_call_id,'NATIVE_ARGUMENT_NORMALIZATION_BINDING_INVALID');}
 const statuses=[...new Set(records.map(r=>r.status))],status=statuses.includes('UNPARSED_BUSINESS_RETAINED')?'UNPARSED_BUSINESS_RETAINED':statuses.includes('BUSINESS_ITEMS_RECOVERED')?'BUSINESS_ITEMS_RECOVERED':statuses[0];
 return{status,statuses,argument_normalization_refs:refs,raw_retained:true,partial:statuses.some(s=>['BUSINESS_ITEMS_RECOVERED','UNPARSED_BUSINESS_RETAINED'].includes(s)),counts_complete:records.some(r=>r.item_recovery?.counts_complete===false)?false:undefined,received_count:records.some(r=>r.item_recovery?.received_count===null)?null:undefined,recovered_count:records.reduce((n,r)=>n+(r.item_recovery?.recovered_count??0),0),skipped_count:records.some(r=>r.item_recovery?.skipped_count===null)?null:undefined,bad_fragment_count:records.reduce((n,r)=>n+(r.item_recovery?.bad_fragment_count??0),0),warnings:[...new Set(records.flatMap(r=>r.warnings))]};
}

export function retainUnparsedBusinessOutput({store,runId,name,args,ctx}){const records=(ctx.argument_normalization_refs??[]).map(ref=>store.getRecord(ARGUMENT_NORMALIZATION,ref)).filter(r=>r?.status==='UNPARSED_BUSINESS_RETAINED');if(!records.length)return null;need(records.every(r=>r.invocation_ref===ctx.invocation_ref&&r.tool_name===name),'NATIVE_ARGUMENT_NORMALIZATION_BINDING_INVALID');need(ctx.invocation_ref&&ctx.tool_call_ref,'NATIVE_TOOL_CALL_CONTEXT_REQUIRED');const key=hash([runId,ctx.invocation_ref,ctx.tool_call_ref]),old=store.getRecord('native_business_output_warning_v1',key),rawHash=hash([name,args]);need(!old||old.raw_sha256===rawHash,'NATIVE_BUSINESS_OUTPUT_CALL_CONFLICT');const value=old??{run_id:runId,name,raw_sha256:rawHash,argument_normalization_refs:records.map(r=>r.normalization_ref),warnings:[...new Set(records.flatMap(r=>r.warnings))],saved:false,skipped:true};if(!old)store.putRecord('native_business_output_warning_v1',key,value);return clone(value);}
