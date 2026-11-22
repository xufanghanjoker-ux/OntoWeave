/** Connect the existing native query product to the trusted Python read port. */
import {clone,hash,need} from './cq-discovery-store-v2.mjs';

export function createPgQueryPort({request}){
 need(typeof request==='function','QUERY_PG_REQUEST_PORT_REQUIRED');
 const send=(libraryId,action,body,signal)=>request({libraryId,action,body,signal});
 return Object.freeze({
  async open({libraryId,selection,viewRevision}){
   const asOf=selection?.as_of;
   need(!asOf||asOf.timestamp,'QUERY_PG_AS_OF_ACTIVATION_SEQ_UNAVAILABLE');
   const result=await send(libraryId,'open',{at:selection?.at??null,as_of:asOf?.timestamp??null,...(viewRevision?{view_revision:viewRevision}:{})});
   const view=result?.view;
   need(view?.library_ref===libraryId&&view?.business_manifest_ref&&view?.business_manifest_sha256&&Array.isArray(result.definitions),'QUERY_PG_VIEW_INVALID');
   const scope={library_id:libraryId,source_snapshot_ref:result.source_manifest_ref??view.business_manifest_ref,
    manifest_ref:view.business_manifest_ref,view_ref:view.view_revision,graph_revision_ref:view.graph_revision,
    query_read_view:clone(view),source_capability:view.capabilities?.source_lexical??'UNAVAILABLE',
    fact_capability:view.capabilities?.knowledge_lexical??'UNAVAILABLE'};
   return Object.freeze({
    definitions:clone(result.definitions),scope:()=>clone(scope),
    // Pinned verification checks authorization and immutable membership on the PG side.
    assertCurrent:()=>true,verify:signal=>send(libraryId,'verify',{view},signal),
    call:({queryId,name,args,operationRef,signal})=>send(libraryId,'call',{view,query_id:queryId,name,args,operation_ref:operationRef},signal),
    close:queryId=>send(libraryId,'close',{view,query_id:queryId}),
   });
  },
  verify({libraryId,scope,signal}){return send(libraryId,'verify',{view:scope.query_read_view},signal);},
 });
}

export function createPgNativeQueryHost({reader,operation}){
 const trace={tool_calls:[],ranking:[],citations:[],agent_tool_projections:[]},citations=new Map();
 const queryId=operation.state().query_id;
 return {
  definitions:reader.definitions,
  snapshot:()=>({...clone(trace),citations:clone([...citations.values()])}),
  async call(name,args){
   operation.assertActive();
   const started=Date.now();
   try{
    const response=await reader.call({queryId,name,args,operationRef:queryId+':'+hash([name,args]),signal:operation.signal});
    operation.assertActive();
    need(response?.result&&Array.isArray(response.citations),'QUERY_PG_RESULT_INVALID');
    for(const citation of response.citations){
     need(citation.citation_ref&&citation.source_targets?.every(target=>target.source_snapshot_ref===reader.scope().source_snapshot_ref),'QUERY_PG_CITATION_SCOPE_INVALID');
     const prior=citations.get(citation.citation_ref);
     need(!prior||hash(prior)===hash(citation),'QUERY_PG_CITATION_CHANGED');
     citations.set(citation.citation_ref,citation);
    }
    trace.ranking.push(...(response.diagnostics??[]));
    trace.tool_calls.push({name,status:response.result.status,returned:response.result.items?.length??0,elapsed_ms:Date.now()-started});
    return {ok:true,result:response.result};
   }catch(error){
    const code=error.code??'QUERY_PG_TOOL_FAILED';
    trace.tool_calls.push({name,status:'FAILED',error:code,elapsed_ms:Date.now()-started});
    if(error.billing_status==='UNKNOWN'||code.includes('UNKNOWN'))operation.stop(code,'UNKNOWN_HOLD');
    return {ok:false,error:{code}};
   }
  },
  recordModelProjection(name,result){
   trace.agent_tool_projections.push({tool_name:name,sha256:hash(result),utf8_bytes:Buffer.byteLength(JSON.stringify(result))});
  },
 };
}
