import {libraryActive} from './library-management.mjs';
/** Persistent, bounded source-update queue. Observations remain internal. */
import { sha } from './engine.mjs';
export function createLearningBatches({store,governance,start,sourcesFor,busy}){
  let admitting=false;
  const save=batch=>{store.putRecord('learning_batch',batch.id,batch);return batch;};
  function enqueue(baseId){
    const state=governance.baseFor(baseId),id='update_'+sha([baseId,state.source_epoch]).slice(0,32);
    const prior=store.getRecord('learning_batch',id);if(prior)return prior;
    for(const old of store.listRecords('learning_batch').filter(b=>b.base_id===baseId&&['QUEUED','RUNNING','BLOCKED'].includes(b.status)))save({...old,status:'SUPERSEDED'});
    const pending=store.listRecords('learning_observation').filter(o=>o.base_id===baseId&&o.status==='WAIT_EVIDENCE')
      .sort((a,b)=>(a.created_at||'').localeCompare(b.created_at||'')||(a.id||'').localeCompare(b.id||''));
    const questions=[...new Map(pending.map(o=>[o.question.trim().replace(/\s+/g,' ').toLowerCase(),o.question.trim()])).values()];
    const head=store.getTask(state.head_task_id);
    if(!questions.length)questions.push(head.input.cqs[0].question);
    // Freeze the finite gap snapshot. Questions created later never expand this batch.
    return save({id,base_id:baseId,source_epoch:state.source_epoch,status:'QUEUED',questions,deferred:[],cursor:0,task_ids:[],created_at:new Date().toISOString()});
  }
  function settle(job){
    const tracking=job.learning||job.learning_resolution,batch=tracking?.batch_id&&store.getRecord('learning_batch',tracking.batch_id);
    if(!batch||['SUPERSEDED','STOPPED','COMPLETED'].includes(batch.status))return;
    if(tracking.question&&tracking.question!==batch.questions[batch.cursor])return;
    if(batch.completed_task_ids?.includes(job.id))return;
    if(governance.baseFor(batch.base_id).source_epoch!==batch.source_epoch)return save({...batch,status:'SUPERSEDED'});
    const tasks=[...new Set([...batch.task_ids,job.id])];
    if(job.status==='READY')return save({...batch,status:'QUEUED',cursor:batch.cursor+1,task_id:null,task_ids:tasks,completed_task_ids:[...(batch.completed_task_ids||[]),job.id]});
    return save({...batch,status:job.status==='CANCELLED'?'STOPPED':'BLOCKED',task_id:job.id,task_ids:tasks});
  }
  function tick(){
    if(admitting||busy())return;
    for(const batch of store.listRecords('learning_batch').filter(b=>b.status==='RUNNING')){
      const task=batch.task_id&&store.getTask(batch.task_id);
      if(!task||!['RUNNING','QUEUED'].includes(task.status))save({...batch,status:'BLOCKED'});
    }
    for(const batch of store.listRecords('learning_batch').filter(b=>b.status==='QUEUED')){
      const state=governance.baseFor(batch.base_id);
      if(!state||!libraryActive(store,batch.base_id)||state.source_epoch!==batch.source_epoch){save({...batch,status:'SUPERSEDED'});continue;}
      if(batch.cursor>=batch.questions.length){save({...batch,status:'COMPLETED',finished_at:new Date().toISOString()});continue;}
      const head=store.getTask(state.head_task_id),question=batch.questions[batch.cursor];
      try{
        const {sources,changedSourceIds}=sourcesFor(state,head);
        const existing=head.input.cqs.find(q=>q.question.trim()===question.trim());
        const plan=existing&&head.result.schema.cq_plans.find(p=>p.cq_id===existing.id);
        if(!changedSourceIds.length&&plan&&governance.query(head.id,plan).classification==='ATTRIBUTED_ONLY'){
          for(const o of store.listRecords('learning_observation').filter(o=>o.base_id===state.id&&o.status==='WAIT_EVIDENCE'&&o.question.trim()===question.trim()))store.putRecord('learning_observation',o.id,{...o,status:'RESOLVED',resolved_by_task:head.id});
          save({...batch,cursor:batch.cursor+1});return tick();
        }
        // Persist RUNNING before starting; execute may finish synchronously in a fake provider.
        save({...batch,status:'RUNNING'});
        const result=start(head,question,{sources,changedSourceIds,batchId:batch.id});
        const complete=result=>{const current=store.getRecord('learning_batch',batch.id);if(['STOPPED','SUPERSEDED','COMPLETED'].includes(current.status))return;
          if(['WAIT_EVIDENCE','OUT_OF_SCOPE','NEEDS_CLARIFICATION','QUERY_RETRY','ANSWERED'].includes(result.status)){save({...current,status:'QUEUED',cursor:current.cursor+1,task_id:null,deferred:[...current.deferred,{question,status:result.status,reason:result.reason}]});return true;}
          save({...current,task_id:result.learning_task_id||null,task_ids:[...new Set([...current.task_ids,...(result.learning_task_id?[result.learning_task_id]:[])])],status:result.status==='LEARNING'?'RUNNING':'BLOCKED',reason:result.reason});};
        if(result&&typeof result.then==='function'){admitting=true;let advance=false;return result.then(r=>{advance=complete(r);}).catch(error=>{const current=store.getRecord('learning_batch',batch.id);if(!['STOPPED','SUPERSEDED'].includes(current.status))save({...current,status:'BLOCKED',error:error.message});}).finally(()=>{admitting=false;}).then(()=>advance?tick():undefined);}
        if(complete(result))return tick();
      }catch(error){save({...store.getRecord('learning_batch',batch.id),status:'BLOCKED',error:error.message});}
      return;
    }
  }
  function stop(id){const batch=store.getRecord('learning_batch',id);if(batch&&!['COMPLETED','SUPERSEDED'].includes(batch.status))save({...batch,status:'STOPPED'});}
  function progress(baseId){const batch=store.listRecords('learning_batch').filter(b=>b.base_id===baseId).sort((a,b)=>b.source_epoch-a.source_epoch)[0];
    return batch?{id:batch.id,status:batch.status,total:batch.questions.length,completed:batch.cursor,deferred:batch.deferred.length,task_id:batch.task_id||batch.task_ids.at(-1)||null,question:batch.questions[Math.min(batch.cursor,batch.questions.length-1)]}:null;}
  return {enqueue,tick,settle,stop,progress};
}
