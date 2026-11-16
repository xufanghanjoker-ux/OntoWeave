/** Stable integration shapes, independent of Web's compatibility fields. Never exports internal CQ/observation data. */
import {createHash} from 'node:crypto';
export function integrationRequestId(credential,mode,libraryId,id){const hex=createHash('sha256').update(JSON.stringify([credential,mode,libraryId,id])).digest('hex');return hex.slice(0,8)+'-'+hex.slice(8,12)+'-4'+hex.slice(13,16)+'-8'+hex.slice(17,20)+'-'+hex.slice(20,32);}
export function libraryContract(base){return {id:base.id,name:base.name,status:base.status,version:base.current_task_id||null,source_count:base.source_count,claim_count:base.claim_count};}
export function jobContract(job,base,{ownerId}={}){return {id:job.id,knowledge_base_id:base.id,status:job.status,stage:job.stage_label||job.stage,
  version:job.publication?.status==='PUBLISHED'?job.id:null,head_version:base.current_task_id,needs_review:job.status==='REVIEW_REQUIRED',
  can_cancel:(job.learning||job.learning_resolution)?.integration_id===ownerId&&['RUNNING','QUEUED'].includes(job.status),workbench_path:'#task='+job.id+(job.status==='REVIEW_REQUIRED'?'&view=review':'')};}
export function answerContract(data,{base,mode,getJob}){
  const classification=data.answer?.classification||data.classification||(['UNSUPPORTED','NEEDS_CLARIFICATION'].includes(data.status)?data.status:'UNKNOWN');
  const evidence=(data.claims||[]).map(c=>({claim_id:c.id,source_id:c.source_id,quote:c.quote,start:c.start,end:c.end,subject_id:c.subject_id,predicate_id:c.predicate_id,value:c.value,unit:c.unit,scope:c.scope,effective_from:c.effective_from}));
  const version=data.version||data.task_id||base.current_task_id;
  const response={schema_version:'cqforge_answer_v1',knowledge_base_id:base.id,mode,version,head_version:base.current_task_id,status:data.status||'ANSWERED',
    answer:data.answer||{classification,values:data.value??null,...(data.comparisons?{comparisons:data.comparisons.map(c=>({subject_id:c.subject_id,classification:c.classification,values:c.value??null}))}:{}),reason:data.reason||''},evidence,
    reason:data.reason||'',review_required:data.pending_review===true||data.status==='WAIT_REVIEW'};
  if(data.learning_task_id){const job=getJob(data.learning_task_id);response.learning={id:data.learning_task_id,status:job?.status||data.status,status_path:'/api/v1/knowledge-bases/'+base.id+'/jobs/'+data.learning_task_id,workbench_path:'#task='+data.learning_task_id+(job?.status==='REVIEW_REQUIRED'?'&view=review':'')};}
  return response;
}
