/** Public product-memory tools. No store, model runner or native Host dependency. */
const string = (maxLength, description) => ({type:'string',minLength:1,maxLength,...(description?{description}:{})});
const object = (properties,required=[]) => ({type:'object',properties,required,additionalProperties:false});
const endpoint = object({kind:{type:'string',enum:['KNOWN','UNKNOWN','OPEN_AS_REPORTED','UNKNOWN_ENDED']},value:string(128),precision:string(64),timezone:string(128),time_text:string(1024)},['kind']);
const validTime = object({kind:{type:'string',enum:['INSTANT','INTERVAL','UNRESOLVED','TIMELESS']},occurred_at:endpoint,valid_from:endpoint,valid_to:endpoint,time_text:string(1024)});
const recordRef = string(120,'Use a record_ref returned by the product; do not invent one.');
const temporal = {at:string(128,'Business-time selection is not available in this adapter version.'),as_of:string(128,'Historical knowledge selection is not available in this adapter version.')};
const outputSchema = {type:'object',properties:{scope:object({workspace_id:string(256),library_id:string(256)},['workspace_id','library_id']),data:{type:'object'}},required:['scope','data']};
const annotations = readOnlyHint => ({readOnlyHint,destructiveHint:false,idempotentHint:readOnlyHint,openWorldHint:false});
export const LIGHTOG_MEMORY_MCP_TOOLS = [
  {name:'lightog_search_knowledge',description:'Read relevant published knowledge and bounded evidence for your own answer. This does not invoke the LightOG answer agent. Keep source kinds, conditions and gaps visible.',inputSchema:object({query:string(2000),limit:{type:'integer',minimum:1,maximum:10},evidence_limit:{type:'integer',minimum:0,maximum:3},...temporal},['query']),outputSchema,annotations:annotations(true)},
  {name:'lightog_get_record',description:'Read the exact original record version and its bounded supplements/status. Saved text and latest drafts do not establish published knowledge or actual execution.',inputSchema:object({record_ref:recordRef,...temporal},['record_ref']),outputSchema,annotations:annotations(true)},
  {name:'lightog_append_record',description:'Append natural language memory as an Agent report. Preserve plans, attempts, conditions and uncertainty. Program-maintained raw_saved/processing/publication receipts determine what was saved; this does not publish knowledge.',inputSchema:object({text:string(16000),related_record_ref:recordRef,valid_time:validTime},['text']),outputSchema,annotations:annotations(false)},
  {name:'lightog_add_result',description:'Append a reported result to an existing record_ref, preserving the original. The service links a SUPPLEMENT; this does not authenticate execution, overwrite a version, or auto-publish a correction.',inputSchema:object({record_ref:recordRef,text:string(16000),valid_time:validTime},['record_ref','text']),outputSchema,annotations:annotations(false)},
  {name:'lightog_get_processing_status',description:'Read the real raw_saved, processing_state and publication_state receipt. RECORD_ONLY publication is distinct from structured knowledge with verified graph and both indexes.',inputSchema:object({record_ref:recordRef},['record_ref']),outputSchema,annotations:annotations(true)}
];
export const WRITE_TOOLS = new Set(['lightog_append_record','lightog_add_result']);
export const TOOL_PORTS = Object.freeze({lightog_search_knowledge:'search',lightog_get_record:'getRecord',lightog_append_record:'appendRecord',lightog_add_result:'addResult',lightog_get_processing_status:'getStatus'});
export const isPlainObject = value => value !== null && typeof value==='object' && !Array.isArray(value) && (Object.getPrototypeOf(value)===Object.prototype || Object.getPrototypeOf(value)===null);

export function validateMemoryToolArguments(schema,value,path='arguments'){
  if(schema.type==='object'){
    if(!isPlainObject(value))throw new Error(`${path} must be an object`);
    for(const key of schema.required||[])if(!Object.hasOwn(value,key))throw new Error(`${path}.${key} is required`);
    for(const key of Object.keys(value)){
      if(!Object.hasOwn(schema.properties,key))throw new Error(`${path} contains an unsupported field`);
      validateMemoryToolArguments(schema.properties[key],value[key],`${path}.${key}`);
    }
  }else if(schema.type==='string'){
    if(typeof value!=='string'||!value.trim()||[...value].length>schema.maxLength)throw new Error(`${path} has an invalid string value`);
    if(schema.enum&&!schema.enum.includes(value))throw new Error(`${path} has an unsupported value`);
  }else if(schema.type==='integer'&&(!Number.isInteger(value)||value<schema.minimum||value>schema.maximum))throw new Error(`${path} is out of range`);
}

export function normalizeMemoryBinding(binding){
  if(!isPlainObject(binding)||['workspace_id','library_id'].some(key=>typeof binding[key]!=='string'||!binding[key].trim()||binding[key].length>256))throw new Error('Invalid program-provided workspace/library binding');
  return Object.freeze({workspace_id:binding.workspace_id,library_id:binding.library_id});
}

export function canonicalMemoryJson(value){
  if(Array.isArray(value))return `[${value.map(canonicalMemoryJson).join(',')}]`;
  if(isPlainObject(value))return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalMemoryJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
