/** Exact QUERY ownership proof for the shared argument audit kind. No global namespace exemption. */
import {createHash} from 'node:crypto';
import {hash} from './cq-discovery-store-v2.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex');
export function verifyNativeQueryArgumentAudit({kind,id,audit:a,get,allowedQueryIds}) {
  const deny=reason=>({permitted:false,query_ref:null,reason});
  if(kind!=='native_agent_argument_normalization_v1')return deny('NOT_QUERY_ARGUMENT_AUDIT_KIND');
  try{
    const q=a.run_id;if(!allowedQueryIds.has(q))return deny('QUERY_NOT_ALLOWED');
    const op=get('native_query_operation_v1',q),inv=get('native_query_invocation_v1',a.invocation_ref),wire=get('native_query_wire_v1',a.request_ref),response=get('native_query_response_v1',a.request_ref),derived=get('native_query_response_derivation_v1',a.request_ref);
    const {record_sha256,...body}=a;
    const attempt=op?.attempts?.find(r=>r.request_ref===a.request_ref);
    const checks=[op?.query_id===q,inv?.query_id===q,inv?.role==='QUERY',inv?.invocation_ref===a.invocation_ref,inv?.request_refs?.includes(a.request_ref),attempt?.kind==='GENERATION',attempt?.role==='QUERY',attempt?.outcome==='RETURNED',wire?.query_id===q,response?.query_id===q,derived?.query_id===q,wire?.request_ref===a.request_ref,response?.request_ref===a.request_ref,derived?.request_ref===a.request_ref,
      response?.complete_body===true,response?.protocol_valid===true,response?.normalization_refs?.includes(id),derived?.normalization_refs?.includes(id),wire?.advertised_tool_names?.includes(a.qualified_tool_name),
      a.normalization_ref===id,id==='argument_normalization_'+hash([a.invocation_ref,a.request_ref,a.call_id]),hash(body)===record_sha256,hash(a.raw_arguments)===a.raw_arguments_sha256,hash(a.normalized_arguments)===a.normalized_arguments_sha256,
      response?.response_sha256===a.raw_response_sha256,response?.derived_response_sha256===a.derived_response_sha256,derived?.raw_response_sha256===a.raw_response_sha256,derived?.derived_response_sha256===a.derived_response_sha256];
    if(!checks.every(Boolean))return deny('QUERY_ARGUMENT_AUDIT_BINDING_OR_HASH_INVALID');
    if(sha(derived.raw_body_utf8)!==a.raw_response_sha256||sha(derived.derived_body_utf8)!==a.derived_response_sha256)return deny('QUERY_ARGUMENT_AUDIT_BODY_HASH_INVALID');
    for(const [body,args] of [[derived.raw_body_utf8,a.raw_arguments],[derived.derived_body_utf8,a.normalized_arguments]]){
      let call=null;for(const frame of body.split(/\r?\n\r?\n/)){const data=frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!data||data==='[DONE]')continue;const e=JSON.parse(data);if(e.type==='response.completed')call=e.response?.output?.find(c=>c.call_id===a.call_id);}
      const name=call?.namespace&&!call.name?.startsWith(call.namespace+'__')?call.namespace+'__'+call.name:call?.name;
      if(!call||call.type!=='function_call'||call.id!==a.item_id||name!==a.qualified_tool_name||call.arguments!==args)return deny('QUERY_ARGUMENT_AUDIT_CALL_INVALID');
    }
    return {permitted:true,query_ref:q,reason:'EXACT_QUERY_INVOCATION_REQUEST_AND_HASH_VERIFIED'};
  }catch{return deny('QUERY_ARGUMENT_AUDIT_UNVERIFIABLE');}
}
