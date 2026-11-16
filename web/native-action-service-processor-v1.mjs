/** Adapter to native-memory-processing-v1. No record writes, vector calls or publication here. */
import {clone, need, textField} from './cq-discovery-store-v2.mjs';
import {verifyNativeActionPrepared} from './native-action-processing-host-v1.mjs';

const bindings=['knowledge_revision_ref','graph_revision_ref','source_index_revision','knowledge_index_revision'];
export function createNativeActionServiceProcessor({processingPort,resolveContext=null,prepareProjection=null}) {
  need(['NATIVE_CODEX','DI_SCRIPTED'].includes(processingPort?.execution_mode)
    && typeof processingPort.process==='function','ACTION_PROCESSING_HOST_REQUIRED');
  need(resolveContext===null||typeof resolveContext==='function','ACTION_CONTEXT_PORT_INVALID');
  need(prepareProjection===null||typeof prepareProjection==='function','ACTION_PROJECTION_PORT_INVALID');
  const native=processingPort.execution_mode==='NATIVE_CODEX';
  return Object.freeze({
    mode:native?'NATIVE_CODEX':'OFFLINE_DI',
    product_ready:native&&typeof resolveContext==='function'&&typeof prepareProjection==='function',
    async process({job,record,relatedRecords=[]}) {
      need(job?.library_id===record?.library_id && job.record_ref===record.record_ref
        && textField(job.request_id) && Array.isArray(relatedRecords),'ACTION_SERVICE_JOB_BINDING_INVALID');
      if(native)need(typeof prepareProjection==='function','ACTION_PROJECTION_PREPARATION_PORT_REQUIRED');
      if(relatedRecords.length)need(typeof resolveContext==='function','ACTION_RELATED_KNOWLEDGE_PORT_REQUIRED');
      const context=resolveContext?await resolveContext({job:clone(job),record:clone(record),relatedRecords:clone(relatedRecords)}):{};
      const prepared=verifyNativeActionPrepared(await processingPort.process({record,
        related_records:context.related_records??relatedRecords, related_knowledge:context.related_knowledge??[], request_id:job.request_id,
        operation:job.operation,correction_target_record_ref:job.target_record_ref??null}));
      need(prepared.source_record_ref===record.record_ref && prepared.source_record_version===record.version
        && prepared.library_id===job.library_id && prepared.execution_mode===processingPort.execution_mode,'ACTION_SERVICE_PREPARED_BINDING_INVALID');
      const runtime_receipt={runtime:native?'NATIVE_CODEX':'OFFLINE_DI',run_id:prepared.run_id,
        source_record_ref:prepared.source_record_ref,source_record_version:prepared.source_record_version,
        skill_bindings:clone(prepared.skill_bindings),invocation_refs:prepared.invocations.map(receipt=>receipt.invocation_ref),
        request_refs:prepared.invocations.flatMap(receipt=>receipt.request_refs??[]),prepared_sha256:prepared.prepared_sha256,
        semantic_quality:'UNASSESSED',correction_status:prepared.correction_status??'NOT_REQUESTED'};
      if(job.operation==='CORRECTION'&&prepared.correction_status!=='BOUND')throw Object.assign(new Error('更正目标待确认；原话与新草稿已保留，当前知识未更改。'),
        {code:'ACTION_CORRECTION_TARGET_UNRESOLVED',correction_status:'NEEDS_TARGET',action_processing_run_id:prepared.run_id,runtime_receipt});
      // The common service already saved the original/result/correction. No derived core record or new version book.
      if(!native)return {record_refs:[record.record_ref],prepared_projection:null,runtime_receipt,
        gaps:[...prepared.gaps,'DI_PROCESSING_NOT_PRODUCT'],action_prepared:prepared};
      need(prepared.publication_eligible===true,'ACTION_NO_PUBLISHABLE_KNOWLEDGE');
      const projection=await prepareProjection({job:clone(job),record:clone(record),prepared:clone(prepared)});
      need(projection?.library_id===job.library_id && bindings.every(key=>textField(projection[key]))
        && projection.action_prepared_sha256===prepared.prepared_sha256,'ACTION_PROJECTION_PREPARATION_BINDING_INVALID');
      return {record_refs:[record.record_ref],prepared_projection:projection,runtime_receipt,gaps:clone(prepared.gaps)};
    },
  });
}
