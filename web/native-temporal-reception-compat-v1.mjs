/** Finite receiver compatibility. Strict time values and Rust remain authoritative. */
import {clone,hash} from './cq-discovery-store-v2.mjs';
import {normalizeValidTime} from './native-temporal-value-v1.mjs';
export const TEMPORAL_RECEPTION_COMPAT_VERSION='TEMPORAL_RECEPTION_COMPAT_V1';
const object=v=>v&&typeof v==='object'&&!Array.isArray(v),text=v=>typeof v==='string'&&v.trim().length>0;
const ENDPOINTS=new Set(['KNOWN','UNKNOWN','OPEN_AS_REPORTED','UNKNOWN_ENDED']),PRECISIONS=new Set(['MILLISECOND','SECOND','MINUTE','DAY','MONTH','YEAR']);
const endpointFields=new Set(['kind','value','precision','timezone','time_text','basis']);
function offsetMinutes(value){if(value==='Z'||value==='UTC'||value==='GMT')return 0;const m=/^(?:(?:UTC|GMT))?([+-])(\d{2}):(\d{2})$/.exec(value??'');return m&&+m[2]<=14&&+m[3]<=59&&(+m[2]!==14||+m[3]===0)?(m[1]==='-'?-1:1)*(+m[2]*60 + +m[3]):null;}
function offsetText(minutes){if(minutes===0)return 'Z';return (minutes<0?'-':'+')+String(Math.floor(Math.abs(minutes)/60)).padStart(2,'0')+':'+String(Math.abs(minutes)%60).padStart(2,'0');}
function utc(parts){const d=new Date(0);d.setUTCFullYear(parts[0],parts[1]-1,parts[2]);d.setUTCHours(parts[3]??0,parts[4]??0,parts[5]??0,parts[6]??0);return d.getTime();}
function localParts(value){const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value??'');if(!m)return null;const p=[+m[1],+m[2],+m[3],+m[4],+m[5],+(m[6]??0),+(m[7]??'').padEnd(3,'0')],d=new Date(utc(p));if(p[0]<1||d.getUTCFullYear()!==p[0]||d.getUTCMonth()+1!==p[1]||d.getUTCDate()!==p[2]||p[3]>23||p[4]>59||p[5]>59)return null;if(m[8]&&offsetMinutes(m[8])===null)return null;return {p,suffix:m[8]??null,has_seconds:!!m[6],local:value.replace(/(?:Z|[+-]\d{2}:\d{2})$/,'')};}
function formatter(zone){try{return new Intl.DateTimeFormat('en-GB',{timeZone:zone,calendar:'iso8601',numberingSystem:'latn',hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});}catch{return null;}}
function zoneOffset(format,instant){const parts=Object.fromEntries(format.formatToParts(new Date(instant)).map(p=>[p.type,p.value])),local=utc([+parts.year,+parts.month,+parts.day,+parts.hour,+parts.minute,+parts.second]);return (local-Math.floor(instant/1000)*1000)/60000;}
function resolveLocalZone(parts,format){const wall=utc(parts),offsets=new Set();for(const hours of [-36,-12,0,12,36])offsets.add(zoneOffset(format,wall+hours*3600000));return [...offsets].map(offset=>({offset,instant:wall-offset*60000})).filter(x=>Number.isInteger(x.offset)&&zoneOffset(format,x.instant)===x.offset);}
function coarseValid(value,precision){const m=(precision==='YEAR'?/^(\d{4})$/:precision==='MONTH'?/^(\d{4})-(\d{2})$/:/^(\d{4})-(\d{2})-(\d{2})$/).exec(value??'');if(!m)return false;const p=[+m[1],+(m[2]??1),+(m[3]??1)],d=new Date(utc(p));return p[0]>0&&d.getUTCFullYear()===p[0]&&d.getUTCMonth()+1===p[1]&&d.getUTCDate()===p[2];}
/** Returns canonical strict-valid time plus raw data and field-level provenance.
 * No source prose is parsed to infer a boundary or a zone. Ambiguous IANA local
 * times stay uncomparable; contradictory kinds never become open intervals.
 */
export function normalizeTemporalReception(raw,{timeText=null}={}){
 const conversions=[],warnings=[];
 const warn=(field,code,detail=null)=>warnings.push({field,code,...(detail?{detail}:{})});
 const convert=(field,code,before,after)=>conversions.push({field,code,before:clone(before),after:clone(after),basis:'EXPLICIT_BUSINESS_TIME_FIELDS_ONLY'});
 const unresolved=code=>({kind:'UNRESOLVED',time_text:text(timeText)?timeText:null,gaps:[code]});
 function endpoint(input,side){
  if(input===null||input===undefined){warn(side,'ENDPOINT_MISSING');return {kind:'UNKNOWN'};}
  let e=clone(input);
  if(typeof e==='string'&&ENDPOINTS.has(e)){convert(side,'ENUM_ENDPOINT_OBJECT',e,{kind:e});e={kind:e};}
  if(!object(e)){warn(side,'ENDPOINT_OBJECT_INVALID');return {kind:'UNKNOWN'};}
  const result={};
  for(const key of Object.keys(e))if(!endpointFields.has(key)){warn(side+'.'+key,key==='valid_to_basis'?'UNSUPPORTED_ENDPOINT_BASIS':'UNSUPPORTED_ENDPOINT_FIELD');convert(side+'.'+key,'RETAIN_EXTENSION_IN_COMPAT_METADATA',e[key],null);}
  for(const key of ['basis','time_text'])if(e[key]!==undefined){if(text(e[key])||key==='time_text'&&e[key]===null)result[key]=e[key];else warn(side+'.'+key,'ENDPOINT_TEXT_INVALID');}
  let kind=e.kind;
  if(kind===undefined&&text(e.value)&&PRECISIONS.has(e.precision)&&!ENDPOINTS.has(e.value)){kind='KNOWN';convert(side+'.kind','KNOWN_FROM_EXPLICIT_VALUE_AND_PRECISION',null,kind);}
  else if(kind===undefined&&ENDPOINTS.has(e.value)&&(!e.precision||e.precision===null)){kind=e.value;convert(side+'.kind','KIND_FROM_EXPLICIT_ENUM_VALUE',null,kind);}
  if(!ENDPOINTS.has(kind)){warn(side+'.kind','ENDPOINT_KIND_UNRESOLVED');return {...result,kind:'UNKNOWN'};}
  if(side!=='valid_to'&&['OPEN_AS_REPORTED','UNKNOWN_ENDED'].includes(kind)){warn(side+'.kind','END_KIND_INVALID_FOR_BOUNDARY');return {...result,kind:'UNKNOWN'};}
  if(e.valid_to_basis!==undefined&&e.valid_to_basis!==kind)warn(side+'.kind','AMBIGUOUS_ENDPOINT_KIND_BASIS');
  result.kind=kind;
  if(kind!=='KNOWN'){
   if(e.timezone!==undefined){if(text(e.timezone))result.timezone=e.timezone;else warn(side+'.timezone','TIMEZONE_INVALID');}
   if((e.value!==undefined&&e.value!==null&&e.value!==kind)||(e.precision!==undefined&&e.precision!==null))warn(side,'NONKNOWN_ENDPOINT_VALUE_CONFLICT');
   return result;
  }
  if(!text(e.value)||!PRECISIONS.has(e.precision)){warn(side,'KNOWN_VALUE_OR_PRECISION_INVALID');return {...result,kind:'UNKNOWN'};}
  result.value=e.value;result.precision=e.precision;
  let zone=e.timezone;
  if(zone!==undefined&&!text(zone)){warn(side+'.timezone','TIMEZONE_INVALID');delete result.value;delete result.precision;return {...result,kind:'UNKNOWN'};}
  const offset=zone===undefined?null:offsetMinutes(zone),format=zone!==undefined&&offset===null&&/^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)+$/.test(zone)?formatter(zone):null;
  if(zone!==undefined&&offset===null&&!format){warn(side+'.timezone','TIMEZONE_UNKNOWN');delete result.value;delete result.precision;return {...result,kind:'UNKNOWN'};}
  if(zone!==undefined){result.timezone=offset===null?zone:offsetText(offset);if(result.timezone!==zone)convert(side+'.timezone','EXPLICIT_OFFSET_CANONICALIZED',zone,result.timezone);}
  if(['YEAR','MONTH','DAY'].includes(e.precision)){
   if(!coarseValid(e.value,e.precision)){warn(side+'.value','KNOWN_CALENDAR_INVALID');delete result.value;delete result.precision;return {...result,kind:'UNKNOWN'};}
   if(format)warn(side+'.timezone','COARSE_IANA_NOT_COMPARABLE');
   return result;
  }
  const parsed=localParts(e.value);
  if(!parsed||e.precision!=='MINUTE'&&!parsed.has_seconds){warn(side+'.value','KNOWN_INSTANT_INVALID');delete result.value;delete result.precision;return {...result,kind:'UNKNOWN'};}
  if(parsed.suffix){
   if(offset!==null&&offset!==offsetMinutes(parsed.suffix)||format&&zoneOffset(format,Date.parse(e.value))!==offsetMinutes(parsed.suffix)){warn(side+'.timezone','VALUE_TIMEZONE_CONFLICT');delete result.value;delete result.precision;return {...result,kind:'UNKNOWN'};}
   return result;
  }
  if(offset!==null){result.value=e.value+offsetText(offset);convert(side+'.value','EXPLICIT_OFFSET_ATTACHED',e.value,result.value);}
  else if(format){const matches=resolveLocalZone(parsed.p,format);
   if(matches.length===1){result.value=e.value+offsetText(matches[0].offset);convert(side+'.value','UNIQUE_IANA_OFFSET_ATTACHED',e.value,result.value);}
   else warn(side+'.timezone',matches.length?'IANA_LOCAL_TIME_AMBIGUOUS':'IANA_LOCAL_TIME_NONEXISTENT');
  }else warn(side+'.timezone','TIMEZONE_MISSING');
  return result;
 }
 let canonical;
 if(raw===null||raw===undefined){warn('valid_time','TIME_NOT_PROVIDED');canonical=unresolved('TIME_NOT_PROVIDED');}
 else if(!object(raw)){warn('valid_time','VALID_TIME_OBJECT_INVALID');canonical=unresolved('INVALID_RAW_VALID_TIME');}
 else{
  const allowed=new Set(['kind','time_text','basis','gaps','occurred_at','valid_from','valid_to']);
  for(const key of Object.keys(raw))if(!allowed.has(key))warn('valid_time.'+key,'UNSUPPORTED_TIME_FIELD');
  if(raw.time_text!==undefined&&raw.time_text!==null&&!text(raw.time_text))warn('valid_time.time_text','TIME_TEXT_INVALID');
  const base={kind:raw.kind,time_text:text(raw.time_text)?raw.time_text:text(timeText)?timeText:null,gaps:Array.isArray(raw.gaps)?raw.gaps.filter(text):[]};
  if(raw.gaps!==undefined&&(!Array.isArray(raw.gaps)||raw.gaps.some(g=>!text(g))))warn('valid_time.gaps','GAPS_INVALID');
  if(raw.basis!==undefined){if(text(raw.basis))base.basis=raw.basis;else warn('valid_time.basis','BASIS_INVALID');}
  if(raw.kind==='INTERVAL'&&raw.occurred_at===undefined){base.valid_from=endpoint(raw.valid_from,'valid_from');base.valid_to=endpoint(raw.valid_to,'valid_to');canonical=base;}
  else if(raw.kind==='INSTANT'&&raw.valid_from===undefined&&raw.valid_to===undefined){base.occurred_at=endpoint(raw.occurred_at,'occurred_at');canonical=base;}
  else if(['TIMELESS','UNRESOLVED'].includes(raw.kind)&&raw.occurred_at===undefined&&raw.valid_from===undefined&&raw.valid_to===undefined)canonical=base;
  else{warn('valid_time.kind','TIME_KIND_OR_ENDPOINT_LAYOUT_INVALID');canonical=unresolved('INVALID_RAW_VALID_TIME');}
 }
 canonical.gaps=[...new Set([...canonical.gaps,...warnings.map(w=>w.field+':'+w.code)])];
 try{canonical=normalizeValidTime(canonical);}catch(error){warn('valid_time','STRICT_TIME_VALIDATION_FAILED',error.message);canonical=normalizeValidTime(unresolved('INVALID_RAW_VALID_TIME'));canonical.gaps.push('valid_time:STRICT_TIME_VALIDATION_FAILED');}
 const compat={version:TEMPORAL_RECEPTION_COMPAT_VERSION,raw_sha256:hash(raw??null),normalized_sha256:hash(canonical),conversions,warnings};
 return {valid_time:canonical,raw_valid_time:clone(raw??null),reception_compat:compat};
}
