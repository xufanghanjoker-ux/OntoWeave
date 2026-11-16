/** Domain tool adapter. MCP transport is deliberately deferred to CQ-2. */
import {need,clone} from './cq-discovery-store-v2.mjs';
export const CQ_TOOLS=Object.freeze(['lightog_list_documents','lightog_read_document_units','lightog_search_documents','lightog_submit_cq_stage','lightog_finalize_cq_draft']);
const keys=(args,allowed)=>need(args&&typeof args==='object'&&!Array.isArray(args)&&Object.keys(args).every(k=>allowed.includes(k)),'CQ_TOOL_ARGUMENTS_INVALID');
/** taskId and workUnitId come from host dispatch, never from model arguments. */
export function createCQTools({host,catalog,taskId,workUnitId,allowedStages=['CQ','FAMILY','SCOPE'],allowFinalize=true}) {
  async function call(name,args={}) {
    try {
      need(CQ_TOOLS.includes(name),'CQ_TOOL_FORBIDDEN');
      const t=host.task(taskId),u=t.work_units.find(u=>u.work_unit_id===workUnitId);need(u,'CQ_WORK_UNIT_INVALID');
      need(!['CANCELLED','STALE'].includes(t.status)||name==='lightog_submit_cq_stage','CQ_'+t.status);
      const snapshot=()=>{need(args.snapshot_id===t.snapshot_id,'CQ_SNAPSHOT_FORBIDDEN');return {snapshot_id:t.snapshot_id,library_id:t.library_id};};
      if(name==='lightog_submit_cq_stage') {
        need(args.work_unit_id===workUnitId,'CQ_WORK_UNIT_FORBIDDEN');
        need(allowedStages.includes(args.stage),'CQ_STAGE_FORBIDDEN');
        return {ok:true,result:host.submit(taskId,clone(args))};
      }
      if(name==='lightog_finalize_cq_draft') {
        need(allowFinalize,'CQ_FINALIZE_FORBIDDEN');
        keys(args,['expected_draft_revision','unfinished_reason']);
        need(u.stage==='SCOPE','CQ_FINALIZE_FORBIDDEN');
        return {ok:true,result:host.finalize(taskId,args.expected_draft_revision,args.unfinished_reason??'')};
      }
      let result,operation;
      if(name==='lightog_list_documents') {
        keys(args,['snapshot_id','cursor','limit']);
        // Directory access is snapshot-wide; body reads for discovery are partitioned.
        result=catalog.list({...args,...snapshot()});operation='list';
      } else if(name==='lightog_read_document_units') {
        keys(args,['snapshot_id','doc_id','revision','block_ids','cursor','max_chars']);
        need(u.doc_ids.includes(args.doc_id),'CQ_DOCUMENT_FORBIDDEN');
        result=catalog.read({...args,...snapshot()});operation='read';
      } else {
        keys(args,['snapshot_id','query','cursor','limit']);
        // Family/scope may search the full snapshot; CQ only its assigned documents.
        result=catalog.search({...args,...snapshot(),doc_ids:u.stage==='CQ'?u.doc_ids:undefined});operation='search';
      }
      return {ok:true,result:host.recordRead(taskId,workUnitId,operation,args,result)};
    }catch(error){return {ok:false,error:{code:error.code??'CQ_TOOL_FAILED'}};}
  }
  return {names:CQ_TOOLS.filter(n=>allowFinalize||n!=='lightog_finalize_cq_draft'),call};
}
