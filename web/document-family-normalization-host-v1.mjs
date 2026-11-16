/** A separate, durable model pass turns document CQ proposals into families.
 * Original returns are never rewritten or promoted directly into graph facts. */
import {randomUUID} from 'node:crypto';
import {prepareFamilyNormalization,materializeFamilyNormalization,validateFamilyNormalization} from './document-family-normalize-v1.mjs';
const need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
export function validateNormalizedScopeRun({store,core,row,currentSnapshot}){
 if(!row.normalization_required)return;
 const hash=v=>core('primitives','hash',v).canonical_hash;
 const record=store.getRecord('document_family_normalization',row.normalization_id);
 need(record?.status==='RETURNED'&&record.receipt?.ready_for_scope_build===true,'DOCUMENT_FAMILY_NORMALIZATION_NOT_READY');
 validateFamilyNormalization({core,prepared:record.prepared,raw:record.response,receipt:record.receipt,currentSnapshot});
 need(hash(row.discovery_prepared?.kernel_prepared??row.discovery_prepared)===record.receipt.origin_discovery_prepared_sha256&&hash(row.discovery_responses)===record.receipt.origin_discovery_responses_sha256,'DOCUMENT_FAMILY_NORMALIZATION_ORIGIN_CHANGED');
 need(hash(row.plan)===hash(record.receipt.normalized_plan)&&hash(row.prepared.kernel_prepared)===hash(record.receipt.normalized_prepared)&&hash(row.responses)===hash(record.receipt.normalized_responses),'DOCUMENT_FAMILY_NORMALIZATION_BINDING_CHANGED');
}
export function createFamilyNormalizationHost({store,core,models,onOperation=()=>{}}){
 const hash=v=>core('primitives','hash',v).canonical_hash;
 async function normalize({runId,libraryId,preparedDiscovery,responses,modelBinding,revalidate}){
  const {prepared,messages,output_schema}=prepareFamilyNormalization({core,preparedDiscovery,responses});
  const binding=hash({prepared,modelBinding}),id=runId;
  const prior=store.getRecord('document_family_normalization',id);
  if(prior){
   need(prior.binding_sha256===binding,'DOCUMENT_FAMILY_NORMALIZATION_BINDING_CHANGED');
   need(prior.status==='RETURNED'&&prior.receipt,'DOCUMENT_FAMILY_NORMALIZATION_NO_AUTOMATIC_RESEND');
   validateFamilyNormalization({core,prepared:prior.prepared,raw:prior.response,receipt:prior.receipt,currentSnapshot:revalidate().snapshot});
   return {id,receipt:structuredClone(prior.receipt)};
  }
  const projection=core('provider_schema_v1','compile_qwen',{contract_version:'lightog-provider-schema/0.1',name:'document_family_normalization',schema:output_schema});
  const options={phase:'DOCUMENT_FAMILY_NORMALIZATION',request_id:randomUUID(),enable_thinking:false,max_tokens:14000,response_format:projection.response_format};
  const row={id,run_id:runId,library_id:libraryId,prepared,model_binding:modelBinding,binding_sha256:binding,request_id:options.request_id,request_sha256:hash({messages,options}),status:'STARTED',started_at:new Date().toISOString()};
  store.putRecord('document_family_normalization',id,row);onOperation(1);let received=false;
  try{
   revalidate();const response=await models().generation.complete(messages,options);received=true;
   Object.assign(row,{status:'RETURNED',response:structuredClone(response),returned_at:new Date().toISOString()});store.putRecord('document_family_normalization',id,row);
   const receipt=materializeFamilyNormalization({core,prepared,raw:response});
   validateFamilyNormalization({core,prepared,raw:response,receipt,currentSnapshot:revalidate().snapshot});
   Object.assign(row,{receipt});store.putRecord('document_family_normalization',id,row);
   return{id,receipt:structuredClone(receipt)};
  }catch(error){Object.assign(row,{status:received?'FAILED':'UNKNOWN_NO_RETRY',error_code:error.code??'DOCUMENT_FAMILY_NORMALIZATION_FAILED'});store.putRecord('document_family_normalization',id,row);throw error;}
  finally{onOperation(-1);}
 }
 return Object.freeze({normalize});
}
