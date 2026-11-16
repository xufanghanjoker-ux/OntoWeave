/** Incremental projection of public assistant output only, never reasoning/tool JSON. */
import {StringDecoder} from 'node:string_decoder';
export function createQueryPublicStream({requestRef,onEvent=()=>{}}){
 const decoder=new StringDecoder('utf8'),items=new Map(),messages=[],seen=new Set();let buffered='',responseId=requestRef;
 async function set(item,text,replace=false){
  if(item?.type!=='message'||item.role!=='assistant'||typeof item.id!=='string'||typeof text!=='string')return;
  let row=messages.find(m=>m.item_id===item.id);if(!row){row={item_id:item.id,message_id:requestRef+':'+item.id,markdown:'',phase:item.phase??null};messages.push(row);}
  if(replace){if(row.markdown===text)return;if(text.startsWith(row.markdown)){const delta=text.slice(row.markdown.length);row.markdown=text;if(delta)await onEvent({type:'answer.delta',data:{message_id:row.message_id,delta}});}else{row.markdown=text;await onEvent({type:'answer.replace',data:{message_id:row.message_id,markdown:text}});}}
  else{row.markdown+=text;await onEvent({type:'answer.delta',data:{message_id:row.message_id,delta:text}});}
 }
 async function frame(raw){const data=raw.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!data||data==='[DONE]')return;let e;try{e=JSON.parse(data);}catch{return;}
  if(e.response?.id)responseId=e.response.id;
  if(Number.isSafeInteger(e.sequence_number)){const key=responseId+':'+e.sequence_number;if(seen.has(key))return;seen.add(key);}
  if(e.item?.id&&e.item.type==='message'&&e.item.role==='assistant')items.set(e.item.id,e.item);
  if(e.type==='response.output_text.delta'&&typeof e.delta==='string'){const item=items.get(e.item_id);if(item)await set(item,e.delta);}
  if(e.type==='response.output_item.done'&&e.item?.type==='message')await set(e.item,(e.item.content??[]).filter(c=>c.type==='output_text').map(c=>c.text??'').join(''),true);
  if(e.type==='response.completed')for(const item of e.response?.output??[])if(item.type==='message'&&item.role==='assistant'){items.set(item.id,item);await set(item,(item.content??[]).filter(c=>c.type==='output_text').map(c=>c.text??'').join(''),true);const row=messages.find(m=>m.item_id===item.id);if(row)row.response_completed=true;}
 }
 return {async push(bytes){buffered+=decoder.write(bytes);for(;;){const match=/\r?\n\r?\n/.exec(buffered);if(!match)break;const value=buffered.slice(0,match.index);buffered=buffered.slice(match.index+match[0].length);await frame(value);}},messages:()=>messages.filter(m=>m.response_completed).map(m=>({...m,response_id:responseId}))};
}
