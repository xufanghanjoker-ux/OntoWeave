/** Provider-independent query model binding and Responses envelope validation. */
import {clone,hash,need,textField} from './cq-discovery-store-v2.mjs';
import {createHash} from 'node:crypto';

export function nativeQueryReturnedToolName(value) {
  if(typeof value?.name!=='string'||value.namespace!=null&&typeof value.namespace!=='string')return null;
  return value.namespace&&!value.name?.startsWith(value.namespace+'__')?value.namespace+'__'+value.name:value.name;
}

/** Unique aliases are generated only from this request's advertised business tools. */
export function normalizeNativeQueryToolNames(bytes,{tools}) {
  const exact=new Map(),aliases=new Map();
  function add(wire,namespace,local,shape){
    const entry={wire,namespace,local,shape};exact.set(wire,entry);
    if(!local.startsWith('lightog_'))return;
    for(const alias of [local,local.slice('lightog_'.length)]){
      if(!aliases.has(alias))aliases.set(alias,new Map());aliases.get(alias).set(wire,entry);
    }
  }
  for(const tool of tools??[]){
    if(tool.type==='namespace'&&Array.isArray(tool.tools))for(const child of tool.tools){if(child.type==='function'&&typeof child.name==='string')add(tool.name+'__'+child.name,tool.name,child.name,'NAMESPACE');}
    else if(tool.type==='function'&&typeof tool.name==='string'){const at=tool.name.lastIndexOf('__');add(tool.name,at<0?null:tool.name.slice(0,at),at<0?tool.name:tool.name.slice(at+2),'FLAT');}
  }
  function resolve(item){
    if(typeof item.name!=='string'||item.namespace!=null&&typeof item.namespace!=='string')return {reason:'INVALID_IDENTITY'};
    const canonical=nativeQueryReturnedToolName(item),entry=exact.get(canonical);
    if(entry&&(!item.namespace||item.namespace===entry.namespace)&&(item.name===entry.wire||item.name===entry.local))return {entry,match:'EXACT'};
    // An explicitly supplied namespace never receives missing-namespace alias repair.
    if(item.namespace)return {reason:'NONEXACT_OR_UNDECLARED_NAMESPACE'};
    const candidates=aliases.get(item.name);
    if(candidates?.size===1)return {entry:[...candidates.values()][0],match:'UNIQUE_INVENTORY_ALIAS'};
    return {reason:candidates?.size?'AMBIGUOUS_ALIAS':'UNDECLARED_NAME',candidates:candidates?[...candidates.keys()]:[]};
  }
  const parts=Buffer.from(bytes).toString('utf8').split(/(\r?\n\r?\n)/),frames=[],idToCall=new Map();
  const items=event=>[...(event?.item?[event.item]:[]),...(Array.isArray(event?.response?.output)?event.response.output:[])].filter(i=>i?.type==='function_call');
  for(let i=0;i<parts.length;i+=2){
    const data=parts[i].split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');let event;try{event=JSON.parse(data);}catch{continue;}
    frames.push({index:i,event});for(const item of items(event))if(item.id&&item.call_id)idToCall.set(item.id,item.call_id);
  }
  const key=item=>item.call_id??idToCall.get(item.id)??item.id,affected=new Set(),diagnostics=[];
  for(const frame of frames)for(const item of items(frame.event)){const r=resolve(item);if(r.match==='UNIQUE_INVENTORY_ALIAS')affected.add(key(item));if(!r.entry)diagnostics.push({event_type:frame.event.type,raw_name:typeof item.name==='string'?item.name:null,namespace:typeof item.namespace==='string'?item.namespace:null,call_id:item.call_id??null,item_id:item.id??null,resolution:r.reason,candidates:r.candidates??[]});}
  const normalizations=[];
  for(const frame of frames){let changed=false;
    for(const item of items(frame.event)){
      const r=resolve(item);if(!r.entry||!affected.has(key(item)))continue;
      const name=r.entry.shape==='NAMESPACE'?r.entry.local:r.entry.wire,namespace=r.entry.shape==='NAMESPACE'?r.entry.namespace:null;
      if(item.name===name&&(item.namespace??null)===namespace)continue;
      normalizations.push({event_type:frame.event.type,call_id:item.call_id??null,item_id:item.id??null,raw_name:item.name,raw_namespace:item.namespace??null,name,namespace,canonical_name:r.entry.wire,resolution:r.match});
      item.name=name;if(namespace)item.namespace=namespace;else delete item.namespace;changed=true;
    }
    if(changed){
      const lines=parts[frame.index].split(/\r?\n/),at=lines.findIndex(l=>l.startsWith('data:')),eol=parts[frame.index].includes('\r\n')?'\r\n':'\n';
      const output=[];for(let i=0;i<lines.length;i++){if(i===at)output.push('data: '+JSON.stringify(frame.event));if(!lines[i].startsWith('data:'))output.push(lines[i]);}parts[frame.index]=output.join(eol);
    }
  }
  return {body:normalizations.length?Buffer.from(parts.join('')):Buffer.from(bytes),version:'query-tool-name-normalization/1',inventory_sha256:hash(tools),declared_names_sha256:hash(nativeQueryWireToolNames(tools)),normalizations,diagnostics};
}
function rejectedToolDiagnostic(value,eventType) {
  const args=value.arguments;let validity=args===undefined?'MISSING':args===''?'EMPTY':'INVALID_JSON';
  if(typeof args==='string'&&args!=='')try{const parsed=JSON.parse(args);validity=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?'VALID_OBJECT':'NOT_OBJECT';}catch{}
  return {event_type:eventType,raw_name:value.name??null,namespace:value.namespace??null,normalized_name:nativeQueryReturnedToolName(value)??null,
    call_id:value.call_id??null,item_id:value.id??null,arguments:{validity,wire_type:typeof args,
      bytes:typeof args==='string'?Buffer.byteLength(args):null,sha256:typeof args==='string'?createHash('sha256').update(args).digest('hex'):null}};
}

export function createNativeQueryModelBinding(profile={}) {
  need(textField(profile.model)&&profile.model.length<=256,'NATIVE_QUERY_MODEL_INVALID');
  const protocol=profile.protocol??'responses';
  need(['responses','openai-compatible-responses','openai-compatible'].includes(protocol),'NATIVE_QUERY_MODEL_PROTOCOL_UNSUPPORTED');
  need(profile.supports_tools!==false&&profile.supports_streaming!==false,'NATIVE_QUERY_MODEL_CAPABILITY_UNSUPPORTED');
  const value={version:'lightog-native-query-model/1',provider:profile.provider??'HOST_CONFIGURED',profile_ref:profile.profile_ref??null,model:profile.model,
    model_revision:profile.model_revision??null,config_revision:profile.config_revision??null,protocol:'responses',adapter_version:profile.adapter_version??'responses/1',
    supports_tools:true,supports_streaming:true,context_window:profile.context_window??null,compatibility:'DECLARED_NOT_SEMANTICALLY_VALIDATED'};
  need(value.context_window===null||Number.isSafeInteger(value.context_window)&&value.context_window>0,'NATIVE_QUERY_MODEL_CONTEXT_INVALID');
  need(textField(value.provider)&&textField(value.adapter_version)&&(value.profile_ref===null||textField(value.profile_ref)),'NATIVE_QUERY_MODEL_PROFILE_INVALID');
  const scalarRevision=v=>v===null||typeof v==='string'&&v.isWellFormed()&&v.length<=1024||typeof v==='number'&&Number.isFinite(v);
  need(scalarRevision(value.model_revision)&&scalarRevision(value.config_revision),'NATIVE_QUERY_MODEL_REVISION_INVALID');
  return Object.freeze({...value,binding_ref:'native-query-model:'+hash(value)});
}

export function validateNativeQueryModelBinding(binding) {
  const {binding_ref,...value}=binding??{};
  need(binding_ref==='native-query-model:'+hash(value),'NATIVE_QUERY_MODEL_BINDING_CHANGED');
  return binding;
}

export function nativeQueryWireToolNames(tools=[]) {
  return tools.flatMap(tool=>tool.type==='namespace'&&Array.isArray(tool.tools)?tool.tools.map(child=>tool.name+'__'+child.name):typeof tool.name==='string'?[tool.name]:[]);
}
export function validateNativeQueryRequest(body,binding) {
  validateNativeQueryModelBinding(binding);
  need(body&&body.model===binding.model&&body.stream===true&&Array.isArray(body.tools),'NATIVE_QUERY_WIRE_BINDING_INVALID');
  need(body.previous_response_id===undefined,'NATIVE_QUERY_REMOTE_CONTINUATION_FORBIDDEN');
  const names=nativeQueryWireToolNames(body.tools);need(names.length>0,'NATIVE_QUERY_TOOLS_MISSING');return names;
}

export function validateNativeQuerySSE(bytes,{model,allowedNames}) {
  const raw=Buffer.from(bytes).toString('utf8');need(raw.endsWith('\n\n')||raw.endsWith('\r\n\r\n'),'NATIVE_QUERY_STREAM_TRUNCATED');
  let completed=null,failed=false,failedResponse=null;const finalCalls=new Map(),identities=new Map(),rejections=[];let eventType=null;
  const inspectIdentity=value=>{
    if(!value||typeof value!=='object')return;
    if(value.type==='function_call'){
      const name=nativeQueryReturnedToolName(value);
      if(!allowedNames.includes(name)){
        if(rejections.length<64)rejections.push(rejectedToolDiagnostic(value,eventType));
        need(false,'NATIVE_QUERY_RETURNED_TOOL_FORBIDDEN');
      }
      const key=value.call_id??value.id;if(key){need(!identities.has(key)||identities.get(key)===name,'NATIVE_QUERY_CALL_CHANGED');identities.set(key,name);}
    }else need(!value.type||['message','reasoning','compaction'].includes(value.type),'NATIVE_QUERY_RETURNED_ITEM_FORBIDDEN');
  };
  const inspect=value=>{
    if(!value||typeof value!=='object')return;
    inspectIdentity(value);
    if(value.type==='function_call'){
      const name=nativeQueryReturnedToolName(value);
      need(allowedNames.includes(name),'NATIVE_QUERY_RETURNED_TOOL_FORBIDDEN');
      let args;try{args=JSON.parse(value.arguments);}catch{need(false,'NATIVE_QUERY_TOOL_ARGUMENTS_JSON_INVALID');}
      need(args&&typeof args==='object'&&!Array.isArray(args),'NATIVE_QUERY_TOOL_ARGUMENTS_OBJECT_REQUIRED');
      need(textField(value.call_id),'NATIVE_QUERY_CALL_ID_MISSING');
      const prior=finalCalls.get(value.call_id),call={call_id:value.call_id,name,arguments:value.arguments};need(!prior||hash(prior)===hash(call),'NATIVE_QUERY_CALL_CHANGED');finalCalls.set(value.call_id,call);
    }else need(!value.type||['message','reasoning','compaction'].includes(value.type),'NATIVE_QUERY_RETURNED_ITEM_FORBIDDEN');
  };
  let violation=null;
  for(const frame of raw.split(/\r?\n\r?\n/)){
    const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    if(!data)continue;if(data==='[DONE]'){need(completed,'NATIVE_QUERY_STREAM_PREMATURE_DONE');continue;}
    if(completed)throw Object.assign(Error('NATIVE_QUERY_STREAM_AFTER_TERMINAL'),{code:'NATIVE_QUERY_STREAM_AFTER_TERMINAL',provider_completed:true,reported_usage:completed.usage??null});
    let event;try{event=JSON.parse(data);}catch{need(false,'NATIVE_QUERY_STREAM_JSON_INVALID');}
    eventType=event.type;
    if(['response.failed','response.incomplete','error'].includes(event.type)){failed=true;failedResponse=event.response??null;}
    try{
      if(event.type==='response.output_item.done')inspect(event.item);
      else if(event.item)inspectIdentity(event.item);
      if(event.response?.output)for(const item of event.response.output)event.type==='response.completed'?inspect(item):inspectIdentity(item);
    }catch(error){violation??=error;}
    if(event.type==='response.completed')completed=event.response;
  }
  if(failed)throw Object.assign(Error('NATIVE_QUERY_STREAM_FAILED'),{code:'NATIVE_QUERY_STREAM_FAILED',provider_failed:true,reported_usage:failedResponse?.usage??null});
  need(completed?.status==='completed','NATIVE_QUERY_STREAM_RESULT_UNKNOWN');
  const usage=completed.usage?{input_tokens:completed.usage.input_tokens,output_tokens:completed.usage.output_tokens}:null;
  if(usage&&!Object.values(usage).every(n=>Number.isSafeInteger(n)&&n>=0))throw Object.assign(Error('NATIVE_QUERY_USAGE_INVALID'),{code:'NATIVE_QUERY_USAGE_INVALID',provider_completed:true,reported_usage:null});
  if(violation){violation.reported_usage=usage;violation.provider_completed=true;if(rejections.length)violation.tool_identity_diagnostics=rejections;throw violation;}
  if(completed.model&&completed.model!==model){const error=Object.assign(Error('NATIVE_QUERY_RETURNED_MODEL_MISMATCH'),{code:'NATIVE_QUERY_RETURNED_MODEL_MISMATCH',reported_usage:usage,provider_completed:true});throw error;}
  return {usage,calls:[...finalCalls.values()].map(clone),reported_model:completed.model??null};
}
