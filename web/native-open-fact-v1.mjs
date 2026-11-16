/** Shape reception only: preserve every observation; never infer direction, units or numeric entity names. */
import {hash,clone,textField} from './cq-discovery-store-v2.mjs';
import {normalizeDomainKind} from './native-domain-kind-compat-v1.mjs';
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v),has=(r,k)=>Object.hasOwn(r,k),empty=v=>v===null||v===undefined||typeof v==='string'&&!v.trim()||object(v)&&Object.keys(v).length===0;
export function explicitEntityLabel(v){if(typeof v==='string')return v;if(!object(v))return null;const typed=['entity','event','concept'].includes(String(v.type??'').toLowerCase())&&typeof v.value==='string'?v.value:null;const labels=[v.name,v.label,v.surface,typeof v.entity==='string'?v.entity:null,typed].filter(textField);return new Set(labels).size===1?labels[0]:null;}
// The pinned Codex MCP conversion may erase complex optional schemas. Deliberately
// expose these business fields as open JSON and preserve unsupported forms with feedback.
export const OPEN_FACT_SCHEMA={type:'object',additionalProperties:true,required:['subject','predicate'],properties:{subject:{},predicate:{type:'string'},object:{},value:{},raw_value:{},result:{},conditions:{},quote:{type:'string'},source_refs:{},negation:{type:'boolean'},modality:{type:'string'},time_text:{type:'string'},version_text:{type:'string'},unit:{type:'string'},attribute:{type:'string'},value_owner:{type:'string',enum:['relation']}}};
export function normalizeExplicitEntityType(v){return textField(v)?v.normalize('NFKC').trim().replace(/[_\-\s]+/gu,' ').toLowerCase():null;}
export function explicitEntitySpec(v){return object(v)&&(textField(explicitEntityLabel(v))||textField(v.canonical_ref)||textField(v.entity_ref))&&!['text','statement','attribution'].some(k=>has(v,k))&&(!has(v,'value')||['entity','event','concept'].includes(String(v.type??'').toLowerCase())&&typeof v.value==='string');}
export function explicitLiteral(v){if(typeof v==='number'||typeof v==='boolean')return {present:true,value:clone(v)};if(object(v)&&!explicitEntitySpec(v)){const typed=['literal','value'].includes(String(v.type??v.kind??'').toLowerCase());if(has(v,'literal'))return {present:true,value:clone(v.literal),unit:v.unit};if(has(v,'value')&&(typed||Object.keys(v).every(k=>['value','unit','text','attribution'].includes(k))))return {present:true,value:clone(v.value),unit:v.unit};}return {present:false};}
export function openFactRow(input,{fact=false}={}){
 if(!object(input)||input.open_fact_input)return input;
 const row=clone(input),kind=normalizeDomainKind(row.kind).kind,diagnostics=[],compatibility=[],conflicts=[];
 const literal=explicitLiteral(row.object),hasObject=has(row,'object')&&!empty(row.object)&&!literal.present,resultPresent=has(row,'result'),result=row.result,resultObject=object(result),resultValue=resultObject?has(result,'value')?{present:true,value:clone(result.value)}:has(result,'text')?{present:true,value:clone(Object.fromEntries(Object.entries(result).filter(([k])=>!['name','unit'].includes(k))))}:{present:false}:resultPresent?{present:true,value:clone(result)}:{present:false};
 const present=['value','raw_value'].filter(k=>has(row,k)),nonempty=present.filter(k=>!empty(row[k])),keys=nonempty.length?nonempty:present;
 const valueKeys=hasObject&&!resultPresent&&row.value_owner!=='relation'?nonempty:keys;const values=valueKeys.map(k=>({field:k,value:row[k]}));if(resultValue.present)values.push({field:'result',value:resultValue.value});if(literal.present)values.push({field:'object',value:literal.value});
 const candidate=fact||((!kind||['ATTRIBUTE','RELATION'].includes(kind))&&(present.length||resultPresent||literal.present));if(!candidate)return row;
 const resultName=resultObject&&textField(result.name)?result.name:null,explicitName=resultName??(row.value_owner==='relation'&&textField(row.attribute)?row.attribute:null);
 if(values.length>1&&values.some(v=>hash(v.value)!==hash(values[0].value)))conflicts.push(resultPresent?'FACT_RESULT_VALUE_CONFLICT':'FACT_VALUE_ALIASES_CONFLICT');
 if(resultName&&textField(row.attribute)&&resultName!==row.attribute)conflicts.push('FACT_RESULT_ATTRIBUTE_CONFLICT');
 const units=[row.unit,resultObject?result.unit:undefined,literal.unit].filter(v=>v!==undefined&&!empty(v));if(units.length>1&&units.some(v=>hash(v)!==hash(units[0])))conflicts.push('FACT_RESULT_UNIT_CONFLICT');
 const primary=values[0],unit=units[0]??null,meaningfulCompanion=values.length>0||resultPresent;
 if(hasObject&&present.length&&!nonempty.length&&!resultValue.present)compatibility.push('FACT_EMPTY_VALUE_PLACEHOLDER_IGNORED');
 if(has(row,'object')&&!hasObject&&!literal.present&&meaningfulCompanion)compatibility.push('FACT_EMPTY_OBJECT_PLACEHOLDER_IGNORED');
 if(nonempty.length&&present.length>nonempty.length)compatibility.push('FACT_EMPTY_VALUE_ALIAS_IGNORED');
 const normalized={...row};if(literal.present){delete normalized.object;compatibility.push('EXPLICIT_LITERAL_OBJECT_AS_VALUE');}
 const relationResult=hasObject&&primary&&!!explicitName&&!conflicts.length;
 const names=(hasObject&&(explicitName||resultPresent)?['predicate']:['predicate','attribute','name']).filter(k=>textField(row[k]));
 if(new Set(names.map(k=>row[k])).size>1)diagnostics.push('FACT_PREDICATE_ALIASES_CONFLICT');
 const label=v=>explicitEntityLabel(v)??(object(v)?v.canonical_ref??v.entity_ref:null),nested=object(row.relation)&&textField(label(row.relation.subject))&&textField(row.relation.predicate)&&textField(label(row.relation.object));
 if(!textField(label(row.subject??row.subject_ref))&&!nested)diagnostics.push('FACT_SHAPE_INCOMPLETE');
 if(!textField(row.predicate??row.attribute??row.name)||!hasObject&&!primary)diagnostics.push('FACT_SHAPE_INCOMPLETE');
 if(has(row,'subject')&&has(row,'subject_ref')&&hash(label(row.subject)??row.subject)!==hash(label(row.subject_ref)??row.subject_ref))diagnostics.push('FACT_OWNER_ALIASES_CONFLICT');
 if(has(row,'subject')&&nested)diagnostics.push('FACT_MULTIPLE_OWNER_SHAPES');if(has(row,'owner')||has(row,'entity'))diagnostics.push('FACT_AMBIGUOUS_OWNER_FIELD');
 for(const k of ['subject',...(hasObject?['object']:[])])if(object(row[k])&&!empty(row[k])&&!explicitEntitySpec(row[k]))diagnostics.push('FACT_PROPOSITION_AS_ENDPOINT');
 if(fact&&has(row,'kind')&&kind&&!['RELATION','ATTRIBUTE'].includes(kind))diagnostics.push('FACT_KIND_SHAPE_CONFLICT');
 if(row.value_owner!==undefined&&row.value_owner!=='relation')diagnostics.push('FACT_VALUE_OWNER_UNSUPPORTED');
 if(!hasObject&&conflicts.length)diagnostics.push(...conflicts);
 const observations={...Object.fromEntries(present.map(k=>[k,clone(row[k])])),...(resultPresent?{result:clone(result)}:{}),...(literal.present?{object:clone(row.object)}:{}),...(has(row,'unit')?{unit:clone(row.unit)}:{}),...(row.attribute?{attribute:row.attribute}:{})};
 const observation={...(primary?{raw_value:clone(primary.value)}:{}),observations,unit,status:relationResult?'BOUND_RELATION_ATTRIBUTE':'UNBOUND',...(explicitName?{attribute:explicitName}:{}),...(conflicts.length?{conflicts:clone(conflicts)}:{})};
 if(resultPresent&&!resultValue.present)compatibility.push('FACT_RESULT_CONTENT_UNRESOLVED');
 if(hasObject&&meaningfulCompanion&&!relationResult)compatibility.push('FACT_RELATION_VALUE_OWNER_UNRESOLVED');
 compatibility.push(...conflicts);
 const extra={};if(meaningfulCompanion){if(hasObject)extra.relation_value=observation;else if(conflicts.length||!primary)extra.value_observation=observation;}
 if(relationResult){extra.attributes=[...(Array.isArray(row.attributes)?clone(row.attributes):object(row.attributes)?Object.entries(row.attributes).map(([name,value])=>({name,value})):[]),{...(resultObject?clone(result):{}),name:explicitName,value:clone(primary.value),unit}];}
 const predicate=row.predicate??row.attribute??row.name,hasLiteral=!hasObject&&!!primary;
 return {...normalized,...extra,kind:diagnostics.length?'TEXT':hasLiteral?'ATTRIBUTE':'RELATION',...(row.kind?{domain_original_kind:row.kind}:{}),...(hasLiteral?{attribute:predicate,value:clone(primary.value),...(unit!==null?{unit}:{} )}:{}),...(fact||has(row,'predicate')||!hasLiteral?{predicate}:{}),open_fact_input:clone(input.domain_original_input??input),open_fact_diagnostics:[...new Set(diagnostics)],open_fact_compatibility:[...new Set(compatibility)],open_fact_shape:fact?'FACTS_V5':'LEGACY_EXPLICIT_VALUE'};
}
