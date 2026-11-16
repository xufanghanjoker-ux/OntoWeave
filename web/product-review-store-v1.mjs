/** Durable local human decisions. No graph/model work runs in a SQLite transaction. */
import {createHash} from 'node:crypto';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=code=>Object.assign(Error(code),{code,status:409});
const need=(v,code)=>{if(!v)throw fail(code);};
const VERSION='lightog-source-human-review/0.1';
const retryable=e=>e.code==='SOURCE_CORRECTION_WRITER_BUSY'||e.details?.application_outcome==='NOT_ENQUEUED'&&e.details?.retryable===true;
export function createProductReviews({store,product,core,actor={kind:'LOCAL_OPERATOR',id:'local-workbench'}}) {
  const rpc=(op,p)=>core('source_human_review_v1',op,{contract_version:VERSION,...p});
  function context(libraryId,item) {
    const job=store.getRecord('source_learning_job',JSON.stringify([libraryId,item.origin?.task_ref??item.task_ref]))?.job;
    const p=product.prepare({libraryId,question:job?.request?.raw_question??'核对当前资料中的提及归属'});
    return {current_snapshot:p.snapshot,source_texts:p.context.source_texts};
  }
  function stored(libraryId,itemId) {
    return store.listRecords('product_review_decision').filter(r=>r.library_id===libraryId&&r.item_id===itemId)
      .sort((a,b)=>(a.sequence??0)-(b.sequence??0)||a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id)).at(-1);
  }
  function list({libraryId}) {
    const projected=product.readReviewItems({libraryId});
    const items=projected.items.map(item=>{
      if(item.kind==='SEMANTIC_CANDIDATE'){
        const row=store.listRecords('source_candidate_human_decision').filter(r=>r.library_id===libraryId&&r.task_ref===item.origin.task_ref&&r.decision.candidate_id===item.origin.candidate_id).sort((a,b)=>(a.sequence??0)-(b.sequence??0)).at(-1);
        if(!row)return item;
        const status=row.decision.action==='DEFER'?'DEFERRED':row.decision.action==='EXCLUDE'?'EXCLUDED':'CONFIRMED';
        return{...item,status,decision:{id:row.decision.decision_id,action:row.decision.action,reason:row.decision.reason,status},actions:status==='DEFERRED'?item.actions:[]};
      }
      const row=stored(libraryId,item.id);if(!row)return item;
      if(row.item_revision!==item.item_revision)return {...item,previous_decision:{status:'STALE',id:row.id},actions:item.actions};
      let status=row.status;
      let application=row.application??null;
      if(status==='APPLY_PENDING'&&row.application?.task_ref){
        const job=store.getRecord('source_learning_job',JSON.stringify([libraryId,row.application.task_ref]))?.job;
        const queue=store.getRecord('source_product_queue',JSON.stringify([libraryId,row.application.task_ref]));
        application={...application,stage:job?.stage??null,queue_status:queue?.status??null,error_code:queue?.error_code??null};
        if(job?.stage==='COMPLETED')status=row.decision.action==='EXCLUDE_CANDIDATE'?'EXCLUDED':'APPLIED';
        else if(job?.attempts?.some(a=>a.outcome==='UNKNOWN')||queue?.status==='UNKNOWN_NO_RETRY')status='APPLICATION_UNKNOWN';
        else if(job?.stage==='SUPERSEDED')status='STALE';
        else if(queue?.result_status==='CORRECTION_MATERIALIZED_NO_GRAPH')status='MATERIALIZED_WITH_ISSUES';
        else if(['BLOCKED','SETTLED'].includes(queue?.status)||['FAILED','STOPPED','WAIT_REVIEW','WAIT_EVIDENCE'].includes(job?.stage))status='APPLY_BLOCKED';
      }
      return {...item,status,decision:{id:row.id,action:row.decision.action,reason:row.decision.reason,status,error_code:row.error_code??application?.error_code??null,application},
        actions:['OPEN','DEFERRED'].includes(status)?item.actions:[]};
    });
    return {...projected,items};
  }
  async function decide({libraryId,itemId,command}) {
    const id=hash([libraryId,itemId,command.request_id]),fingerprint=hash(command);
    const prior=store.getRecord('product_review_request',id);
    if(prior){need(prior.fingerprint===fingerprint,'HUMAN_REVIEW_REQUEST_REUSED');return {decision:store.getRecord('product_review_decision',prior.decision_id),deduplicated:true};}
    const item=product.readReviewItems({libraryId}).items.find(i=>i.id===itemId);
    need(item,'HUMAN_REVIEW_ITEM_NOT_FOUND');
    if(item.kind==='SEMANTIC_CANDIDATE'){
      need(item.item_revision===command.item_revision&&['CONFIRM_SUPPORT','EXCLUDE_CANDIDATE','DEFER'].includes(command.action)&&!command.option_id&&typeof command.reason==='string'&&command.reason.trim(),'SOURCE_HUMAN_SEMANTIC_COMMAND_INVALID');
      const action=command.action==='EXCLUDE_CANDIDATE'?'EXCLUDE':command.action;
      const result=product.decideCandidateMeaning({libraryId,item,action,reason:command.reason,requestId:command.request_id});
      const status=action==='DEFER'?'DEFERRED':action==='EXCLUDE'?'EXCLUDED':'CONFIRMED';
      return{decision:{id:result.decision.decision.decision_id,status,action,reason:command.reason},assessment:result.assessment,publication_status:result.publication_status,deduplicated:result.idempotent};
    }
    const trusted=context(libraryId,item);
    const decision=rpc('decide',{item,command,actor,...trusted});
    const created_at=new Date().toISOString();
    const record=store.transaction(()=>{
      const old=stored(libraryId,itemId);
      need(!old||old.item_revision!==item.item_revision||old.status==='DEFERRED','HUMAN_REVIEW_ALREADY_DECIDED');
      const row={id:decision.decision_id,library_id:libraryId,item_id:itemId,item_revision:item.item_revision,item,
        decision,status:decision.action==='DEFER'?'DEFERRED':'APPLY_PENDING',sequence:(old?.sequence??0)+1,created_at};
      store.archiveRecord('product_review_decision',row.id,row);
      store.putRecord('product_review_decision',row.id,row);
      store.putRecord('product_review_request',id,{fingerprint,decision_id:row.id});return row;
    });
    if(record.status==='APPLY_PENDING') {
      let application;
      try {
        application=await product.applyReviewCorrection({libraryId,item,decision});
      } catch(error) {
        // The decision remains durable even if execution could not be queued.
        const row={...record,status:retryable(error)?'APPLY_PENDING':'APPLY_BLOCKED',error_code:error.code??'HUMAN_REVIEW_APPLICATION_FAILED'};
        store.putRecord('product_review_decision',row.id,row);return {decision:row};
      }
      // A failure saving this pointer must leave the durable pending decision
      // recoverable. The host looks up its idempotent application before enqueue.
      const row={...record,application};store.putRecord('product_review_decision',row.id,row);return {decision:row,application};
    }
    return {decision:record};
  }
  async function recover() {
    for(const row of store.listRecords('product_review_decision').filter(r=>r.status==='APPLY_PENDING'&&!r.application)) {
      let application;
      try {
        application=await product.applyReviewCorrection({libraryId:row.library_id,item:row.item,decision:row.decision});
      } catch(error) {
        store.putRecord('product_review_decision',row.id,{...row,status:retryable(error)?'APPLY_PENDING':'APPLY_BLOCKED',error_code:error.code??'HUMAN_REVIEW_APPLICATION_FAILED'});
        continue;
      }
      store.putRecord('product_review_decision',row.id,{...row,application});
    }
  }
  return {list,decide,recover};
}
