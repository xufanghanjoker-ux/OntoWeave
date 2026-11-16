import {receiveFactConditions} from './native-fact-conditions-v5.mjs';
/** Bounded expansion of explicit business containers only. Original raw proposal remains immutable. */
import {clone,hash} from './cq-discovery-store-v2.mjs';
const list=v=>Array.isArray(v)?v:[],object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const contextKeys=['source_refs','quote','conditions','negation','modality','time_text','version_text','unit','gaps'];
const allowed=new Set(['facts','entities',...contextKeys]);
export function expandNativeDomainRows(raw){
 const roots=[...list(raw.entities).map((v,i)=>({value:object(v)?{...v,kind:v.kind??'ENTITY'}:v,path:['entities',i]})),...list(raw.definitions).map((v,i)=>({value:object(v)?{...v,kind:'DEFINITION'}:v,path:['definitions',i]})),...list(raw.candidates??raw.knowledge??raw.items).map((value,i)=>({value,path:[Array.isArray(raw.candidates)?'candidates':Array.isArray(raw.knowledge)?'knowledge':'items',i]})),...list(raw.statements).map((v,i)=>({value:typeof v==='string'?{kind:'TEXT',text:v}:v,path:['statements',i]})),...list(raw.rules).map((v,i)=>({value:object(v)?{...v,kind:v.kind??'RULE'}:v,path:['rules',i]})),...list(raw.facts).map((value,i)=>({value,path:['facts',i],fact:true}))];
 const out=[];let expanded=0;
 function visit(value,path,index,fact,depth=0,context={}){
  if(!object(value)){out.push(value);return;}
  const inherited=Object.fromEntries(contextKeys.filter(k=>Object.hasOwn(context,k)&&!Object.hasOwn(value,k)).map(k=>[k,clone(context[k])])),row={...inherited,...clone(value),domain_input_path:path,domain_input_index:index};
  if(Array.isArray(value.facts)&&Object.keys(value).every(k=>allowed.has(k))){
   const size=value.facts.length+list(value.entities).length,permit=depth<2&&expanded+size<=512;out.push({...row,domain_original_input:clone(value),domain_container:{status:permit?'EXPANDED':'RETAINED_LIMIT',children:size,reason:permit?'EXPLICIT_FACTS_CONTAINER':'BUSINESS_CONTAINER_EXPANSION_LIMIT'},domain_fact_input:fact});
   if(!permit)return;expanded+=size;const ctx=Object.fromEntries(contextKeys.filter(k=>Object.hasOwn(row,k)).map(k=>[k,clone(row[k])]));
   for(const [i,e]of list(value.entities).entries())visit(object(e)?{...e,kind:e.kind??'ENTITY'}:e,[...path,'entities',i],index+'.entities.'+i,false,depth+1,ctx);
   for(const [i,f]of value.facts.entries())visit(f,[...path,'facts',i],index+'.facts.'+i,true,depth+1,ctx);return;
  }
  const conflicts=['negation','modality','time_text','version_text','unit'].filter(k=>depth&&Object.hasOwn(value,k)&&Object.hasOwn(context,k)&&hash(value[k])!==hash(context[k]));
  out.push({...row,...(depth&&context.conditions!==undefined?{conditions:[...new Set([...(receiveFactConditions(context.conditions).conditions??[]),...(receiveFactConditions(value.conditions).conditions??[])])]}:{}),domain_original_input:clone(value),...(conflicts.length?{domain_container_conflicts:conflicts}:{}),domain_fact_input:fact,...(depth?{domain_container_context:clone(context)}:{})});
 }
 roots.forEach((r,i)=>visit(r.value,r.path,i,r.fact??false));return out;
}
