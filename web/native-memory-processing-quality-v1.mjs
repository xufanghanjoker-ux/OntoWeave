/** S0 candidate. Bounded content-completeness evidence from immutable prepared receipts; no writes or model calls. */
import {clone,hash,need,textField} from './cq-discovery-store-v2.mjs';
const SCHEMA='MEMORY_PROCESSING_QUALITY_V1';
const safeCode=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,95}$/.test(value)?value:null;
const reasonCode=value=>safeCode(typeof value==='string'?value:value?.reason_code??value?.code??value?.reason)
  ??'RETAINED_REASON_UNCLASSIFIED';
export function unknownMemoryProcessingQuality(code='MEMORY_PROCESSING_QUALITY_UNAVAILABLE') {
  return {schema_version:SCHEMA,content_state:'UNKNOWN',partial:null,retained_count:null,retained_reason_counts:{},
    gap_count:null,gap_codes:[],organized_count:null,verified:false,source:'UNAVAILABLE',
    action_run_id:null,action_prepared_sha256:null,quality_error_code:safeCode(code)??'MEMORY_PROCESSING_QUALITY_UNAVAILABLE'};
}
export function checkMemoryProcessingQuality(value) {
  need(value?.schema_version===SCHEMA&&['READY','PARTIALLY_READY','UNKNOWN'].includes(value.content_state)
    &&(value.partial===null||typeof value.partial==='boolean')&&typeof value.verified==='boolean'
    &&(value.retained_count===null||Number.isSafeInteger(value.retained_count)&&value.retained_count>=0)
    &&value.retained_reason_counts&&typeof value.retained_reason_counts==='object'&&!Array.isArray(value.retained_reason_counts)
    &&Object.keys(value.retained_reason_counts).length<=64
    &&Object.entries(value.retained_reason_counts).every(([code,count])=>safeCode(code)&&Number.isSafeInteger(count)&&count>0)
    &&Array.isArray(value.gap_codes)&&value.gap_codes.length<=64&&value.gap_codes.every(safeCode)
    &&(value.gap_count===null||Number.isSafeInteger(value.gap_count)&&value.gap_count>=0)
    &&(value.organized_count===null||Number.isSafeInteger(value.organized_count)&&value.organized_count>=0),
  'MEMORY_PROCESSING_QUALITY_INVALID');
  need(value.content_state==='UNKNOWN'?value.partial===null&&value.verified===false
    :value.partial===(value.content_state==='PARTIALLY_READY')&&value.verified===true,
  'MEMORY_PROCESSING_QUALITY_INVALID');
  need(Buffer.byteLength(JSON.stringify(value))<=16384,'MEMORY_PROCESSING_QUALITY_TOO_LARGE');
  return clone(value);
}
export function createMemoryPreparedQualityReader({store,verifyPrepared=null}={}) {
  need(typeof store?.getRecord==='function'&&(verifyPrepared===null||typeof verifyPrepared==='function'),
    'MEMORY_PROCESSING_QUALITY_HOST_REQUIRED');
  return function resolveProcessingQuality({job,record,runtime_receipt=job?.runtime_receipt}={}) {
    try {
      need(job?.library_id===record?.library_id&&job?.record_ref===record?.record_ref,
        'MEMORY_PROCESSING_QUALITY_SCOPE_CHANGED');
      const receipt=runtime_receipt;
      if(!receipt?.run_id)return unknownMemoryProcessingQuality('MEMORY_PROCESSING_QUALITY_NOT_YET_PREPARED');
      need(textField(receipt.run_id)&&/^[a-f0-9]{64}$/.test(receipt.prepared_sha256??''),
        'MEMORY_PROCESSING_QUALITY_RECEIPT_CHANGED');
      const normal=store.getRecord('native_action_processing_result_v1',receipt.run_id)?.prepared;
      const maintenance=store.getRecord('native_action_organization_reuse_result_v1',receipt.run_id)?.result?.action_prepared;
      if(!normal&&!maintenance)return unknownMemoryProcessingQuality('MEMORY_PROCESSING_QUALITY_PREPARED_UNAVAILABLE');
      need(!normal||!maintenance||hash(normal)===hash(maintenance),'MEMORY_PROCESSING_QUALITY_PREPARED_AMBIGUOUS');
      const prepared=normal??maintenance,{prepared_sha256,...body}=prepared;
      need(prepared.schema==='NATIVE_ACTION_PROCESSING_PREPARED_V1'&&prepared_sha256===hash(body)
        &&prepared_sha256===receipt.prepared_sha256&&prepared.run_id===receipt.run_id,
      'MEMORY_PROCESSING_QUALITY_PREPARED_CHANGED');
      need(prepared.library_id===record.library_id&&prepared.source_record_ref===record.record_ref
        &&prepared.source_record_version===record.version
        &&(receipt.source_record_ref===undefined||receipt.source_record_ref===record.record_ref)
        &&(receipt.source_record_version===undefined||receipt.source_record_version===record.version),
      'MEMORY_PROCESSING_QUALITY_SOURCE_CHANGED');
      if(!Array.isArray(prepared.source_manifest))return unknownMemoryProcessingQuality('MEMORY_PROCESSING_QUALITY_SOURCE_PIN_UNRECORDED');
      const sources=prepared.source_manifest.filter(source=>source.record_ref===record.record_ref);
      need(sources.length===1&&sources[0].kind==='MEMORY_RECORD_SOURCE'&&sources[0].version===record.version
        &&sources[0].source_kind===record.source?.kind&&sources[0].text_sha256===hash(record.text)
        &&sources[0].document_evidence_eligible===false,'MEMORY_PROCESSING_QUALITY_SOURCE_CHANGED');
      need((receipt.runtime==='NATIVE_CODEX'&&prepared.execution_mode==='NATIVE_CODEX')
        ||(receipt.runtime==='OFFLINE_DI'&&prepared.execution_mode==='DI_SCRIPTED'),
      'MEMORY_PROCESSING_QUALITY_RUNTIME_CHANGED');
      if(verifyPrepared)need(hash(verifyPrepared(prepared))===hash(prepared),'MEMORY_PROCESSING_QUALITY_VERIFIER_CHANGED');
      if(!Array.isArray(prepared.retained)||!Array.isArray(prepared.gaps)||!Array.isArray(prepared.knowledge))
        return unknownMemoryProcessingQuality('MEMORY_PROCESSING_QUALITY_COMPLETENESS_UNRECORDED');
      need(prepared.retained.length<=100000&&prepared.gaps.length<=100000&&prepared.knowledge.length<=100000,
        'MEMORY_PROCESSING_QUALITY_COUNTS_EXCEEDED');
      const retained_reason_counts={};
      for(const item of prepared.retained) {
        let code=reasonCode(item);
        if(!Object.hasOwn(retained_reason_counts,code)&&Object.keys(retained_reason_counts).length>=63)code='OTHER_RETAINED_REASONS';
        retained_reason_counts[code]=(retained_reason_counts[code]??0)+1;
      }
      const partial=prepared.retained.length>0||prepared.gaps.length>0||prepared.processing_state==='PARTIALLY_READY';
      return checkMemoryProcessingQuality({schema_version:SCHEMA,content_state:partial?'PARTIALLY_READY':'READY',partial,
        retained_count:prepared.retained.length,retained_reason_counts,gap_count:prepared.gaps.length,
        gap_codes:[...new Set(prepared.gaps.map(reasonCode))].slice(0,64),organized_count:prepared.knowledge.length,
        verified:true,source:'IMMUTABLE_ACTION_PREPARED',action_run_id:receipt.run_id,
        action_prepared_sha256:prepared.prepared_sha256,quality_error_code:null});
    } catch(cause) {
      return unknownMemoryProcessingQuality(safeCode(cause?.code)??'MEMORY_PROCESSING_QUALITY_UNAVAILABLE');
    }
  };
}
