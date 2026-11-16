import {assertLibraryActive,libraryActive,libraryLifecycle} from './library-management.mjs';
/** Source revocation and publication are synchronous transactions, separate from model execution. */
import assert from 'node:assert/strict';
import { sha, answerPlan, queryPlanIssues } from './engine.mjs';
import { knowledgeBases } from './knowledge-bases.mjs';
import {supportValid} from './structure-learning.mjs';

export const sourceKey = source => 'src_' + sha([source.parsing?.document_id || null,source.title,sha(source.content)]).slice(0,32);
const fault=(code,message)=>Object.assign(Error(message),{code});

export function createGovernance(store){
  const baseFor=id=>store.getRecord('library_state',id);
  const candidateFor=id=>store.getRecord('library_candidate',id);
  const pendingFor=(id,epoch)=>['component_release','component_hold'].flatMap(kind=>store.listRecords(kind)).filter(r=>r.base_id===id&&r.source_epoch===epoch&&r.status!=='RESOLVED').map(r=>({...r,manifest:{...r.manifest,held_predicate_ids:r.current_held_predicate_ids??r.manifest.held_predicate_ids,held_cq_ids:r.current_held_cq_ids??r.manifest.held_cq_ids}}));
  const reviewHash=(id,epoch)=>sha(pendingFor(id,epoch).map(r=>[r.id,r.manifest.held_predicate_ids,r.manifest.held_cq_ids,r.additional_held_predicate_ids||[],r.additional_held_cq_ids||[]]).sort());
  function begin(job){
    if(!job.internal_scope||job.benchmark_run_id)return null;
    return store.transaction(()=>{
      const old=candidateFor(job.id);if(old){assertLibraryActive(store,old.base_id);return old;}
      const base=knowledgeBases(store.listTasks()).find(b=>b.task_ids.includes(job.id));assert(base,'版本尚未保存');assertLibraryActive(store,base.id);
      let state=baseFor(base.id);
      if(!state){
        state={id:base.id,head_task_id:null,revision:0,source_epoch:0,sources:{}};
        for(const s of job.input.sources)state.sources[sourceKey(s)]={key:sourceKey(s),title:s.title,sha256:sha(s.content),active:true};
        store.putRecord('library_state',base.id,state);
      }
      if(job.revision?.parent_id){
        const parent=candidateFor(job.revision.parent_id);
        const intended=job.component_base_task_id||job.learning?.base_task_id||(parent?.status==='PUBLISHED'?parent.task_id:parent?.expected_head)||null;
        if(intended!==state.head_task_id)throw fault('PUBLICATION_STALE','候选基于旧知识版本，需重新校验，不能以当前版本身份发布');
      }
      const candidate={task_id:job.id,base_id:base.id,expected_head:state.head_task_id,expected_revision:state.revision,
        expected_source_epoch:state.source_epoch,input_hash:sha(job.input),status:'CANDIDATE'};
      store.putRecord('library_candidate',job.id,candidate);return candidate;
    });
  }
  function publish(job){
    const candidate=candidateFor(job.id);if(!candidate)return null;
    return store.transaction(()=>{
      const c=candidateFor(job.id),state=baseFor(c.base_id);assertLibraryActive(store,c.base_id);
      if(c.status==='PUBLISHED'){assert(c.result_hash===sha(job.result),'已发布结果不可改写');return c;}
      if(c.status!=='CANDIDATE')throw fault('PUBLICATION_REJECTED','候选已停止或失效');
      if(job.cancel_requested)throw fault('PUBLICATION_CANCELLED','已停止的候选不发布');
      assert(job.status==='READY'&&job.result?.status==='READY'&&job.result.gate?.action==='ACCEPT_CANDIDATE','候选尚未通过全部构建门禁');
      assert(!queryPlanIssues(job.result.schema,job.input).length,'查询计划仍存在未解决约束');
      assert(c.input_hash===sha(job.input),'候选输入已变化');
      if(state.source_epoch!==c.expected_source_epoch||job.input.sources.some(s=>!state.sources[sourceKey(s)]?.active))
        throw fault('SOURCE_REVOKED','资料范围已变化，候选需重新验证，未发布');
      if(state.head_task_id!==c.expected_head||state.revision!==c.expected_revision)
        throw fault('PUBLICATION_STALE','已有新版本发布，候选需重新校验，未覆盖当前版本');
      for(const claim of job.result.claims){
        assert(supportValid(claim,job.input.sources),'候选多段证据失效');
        const source=job.input.sources.find(s=>s.id===claim.source_id);
        assert(source&&sha(source.content)===source.sha256&&source.content.slice(claim.start,claim.end)===claim.quote,'候选证据无效');
      }
      const published={...c,status:'PUBLISHED',result_hash:sha(job.result),published_at:new Date().toISOString()};
      store.saveTask(job);
      store.putRecord('library_candidate',job.id,published);
      store.putRecord('library_state',state.id,{...state,head_task_id:job.id,revision:state.revision+1});return published;
    });
  }
  function revoke(baseId,key){return store.transaction(()=>{
    assertLibraryActive(store,baseId);const state=baseFor(baseId);assert(state,'知识库尚未启用来源管理');assert(state.sources[key],'来源不属于此知识库');
    if(!state.sources[key].active)return state;
    const next={...state,source_epoch:state.source_epoch+1,sources:{...state.sources,[key]:{...state.sources[key],active:false,revoked_at:new Date().toISOString()}}};
    store.putRecord('source_change',sha([baseId,next.source_epoch]),{base_id:baseId,key,source_epoch:next.source_epoch,action:'REVOKED',at:next.sources[key].revoked_at});
    store.putRecord('library_state',state.id,next);return next;
  });}
  function addSource(baseId,source){return store.transaction(()=>{
    assertLibraryActive(store,baseId);const state=baseFor(baseId);assert(state,'知识库尚未启用来源管理');
    const key=sourceKey(source);if(state.sources[key]?.active)return {state,added:false};
    assert(sha(source.content)===source.sha256,'新资料哈希无效');
    store.putRecord('library_source',sha([baseId,key]),{base_id:baseId,key,source});
    const next={...state,source_epoch:state.source_epoch+1,sources:{...state.sources,[key]:{key,title:source.title,sha256:source.sha256,active:true}}};
    store.putRecord('source_change',sha([baseId,next.source_epoch]),{base_id:baseId,key,source_epoch:next.source_epoch,action:state.sources[key]?'REACTIVATED':'ADDED',at:new Date().toISOString()});
    store.putRecord('library_state',baseId,next);return {state:next,added:true};
  });}
  function replaceSource(baseId,key,source){return store.transaction(()=>{
    assertLibraryActive(store,baseId);const state=baseFor(baseId);assert(state?.sources[key]?.active,'只能替换当前有效资料');
    const nextKey=sourceKey(source);if(key===nextKey)return {state,changed:false};
    assert(!state.sources[nextKey]?.active,'替换资料已在使用，请先核对来源');
    assert(sha(source.content)===source.sha256,'替换资料哈希无效');
    store.putRecord('library_source',sha([baseId,nextKey]),{base_id:baseId,key:nextKey,source});
    const at=new Date().toISOString(),epoch=state.source_epoch+1;
    const next={...state,source_epoch:epoch,sources:{...state.sources,
      [key]:{...state.sources[key],active:false,revoked_at:at,replaced_by:nextKey},
      [nextKey]:{key:nextKey,title:source.title,sha256:source.sha256,active:true,replaces:key}}};
    store.putRecord('source_change',sha([baseId,epoch]),{base_id:baseId,key:nextKey,previous_key:key,source_epoch:epoch,action:'REPLACED',at});
    store.putRecord('library_state',baseId,next);return {state:next,changed:true};
  });}
  function view(job){
    const c=candidateFor(job.id);if(!c){
      if(!job.internal_scope)return job;
      return {...job,result:job.result?{...job.result,status:'BUILDING',claims:[],answers:[]}:null,publication:{status:'UNREGISTERED'}};
    }
    assertLibraryActive(store,c.base_id);const state=baseFor(c.base_id),published=c.status==='PUBLISHED'&&job.status==='READY';
    const result=job.result?structuredClone(job.result):null;
    if(result){
      delete result.answers;
      const pending=pendingFor(c.base_id,state.source_epoch);
      const manifests=[...(result.component_publication?[result.component_publication]:[]),...pending.map(r=>({...r.manifest,held_predicate_ids:[...r.manifest.held_predicate_ids,...(r.additional_held_predicate_ids||[])],held_cq_ids:[...r.manifest.held_cq_ids,...(r.additional_held_cq_ids||[])]}))];
      if(manifests.length)result.pending_components={predicate_ids:[...new Set(manifests.flatMap(m=>m.held_predicate_ids))],cq_ids:[...new Set(manifests.flatMap(m=>m.held_cq_ids))],origin_task_ids:[...new Set(manifests.filter(m=>m.held_predicate_ids.length||m.held_cq_ids.length).map(m=>m.origin_task_id))]};
      result.claims=(result.claims||[]).filter(claim=>{
        const source=job.input.sources.find(s=>s.id===claim.source_id);return source&&state.sources[sourceKey(source)]?.active&&supportValid(claim,job.input.sources)&&(claim.support_set||[]).every(e=>{const s=job.input.sources.find(s=>s.id===e.source_id);return s&&state.sources[sourceKey(s)]?.active;});
      });
      if(!published)result.status='BUILDING';
    }
    return {...job,result,publication:{status:c.status,base_id:c.base_id,source_epoch:state.source_epoch,review_hash:reviewHash(c.base_id,state.source_epoch),
      revoked_source_ids:job.input.sources.filter(s=>!state.sources[sourceKey(s)]?.active).map(s=>s.id)}};
  }
  function stamp(taskId){const c=candidateFor(taskId);if(!c)return null;assertLibraryActive(store,c.base_id);const epoch=baseFor(c.base_id).source_epoch;return {base_id:c.base_id,source_epoch:epoch,review_hash:reviewHash(c.base_id,epoch)};}
  function assertCandidateSources(taskId){const c=candidateFor(taskId);if(c)assertLibraryActive(store,c.base_id);if(!c||c.status!=='CANDIDATE')return;
    const state=baseFor(c.base_id),job=store.getTask(taskId);
    if(state.source_epoch!==c.expected_source_epoch||job.input.sources.some(s=>!state.sources[sourceKey(s)]?.active))throw Object.assign(fault('SOURCE_REVOKED','处理期间资料范围已变化，未继续发送模型'),{details:{billing_status:'NOT_SENT'}});
  }
  function assertStamp(expected){if(expected)assertLibraryActive(store,expected.base_id);if(expected&&baseFor(expected.base_id).source_epoch!==expected.source_epoch)throw fault('SOURCE_REVOKED','回答期间资料已撤回，请按当前资料重新提问');
    if(expected&&(expected.review_hash?expected.review_hash!==reviewHash(expected.base_id,expected.source_epoch):pendingFor(expected.base_id,expected.source_epoch).length>0))throw fault('KNOWLEDGE_REVIEW_CHANGED','回答期间争议范围已变化，请按当前状态重新提问');}
  function query(taskId,plan,input){const job=view(store.getTask(taskId));return {...answerPlan(job.result||{status:job.status},input||job.input,plan),backend:'SQLITE',task_id:taskId,version:taskId};}
  function libraries(){return knowledgeBases(store.listTasks()).map(base=>{
    const life=libraryLifecycle(store,base.id),named={...base,name:life?.name||base.name,lifecycle_status:life?.status||'ACTIVE',trashed_at:life?.trashed_at||null};
    const state=baseFor(base.id);if(!state||!libraryActive(store,base.id))return named;
    const head=state.head_task_id&&store.getTask(state.head_task_id);
    return {...named,current_task_id:head?.id||null,open_task_id:head?.id||base.latest_task_id,
      status:head?'READY':base.latest_status==='READY'?'REVIEW_REQUIRED':base.latest_status,
      claim_count:head?view(head).result.claims.length:0,source_epoch:state.source_epoch,review_hash:reviewHash(base.id,state.source_epoch),
      source_count:Object.values(state.sources).filter(s=>s.active).length,
      sources:Object.values(state.sources).map(({key,title,active})=>({key,title,active}))};
  });}
  return {begin,publish,revoke,addSource,replaceSource,view,stamp,assertStamp,assertCandidateSources,query,libraries,baseFor,candidateFor};
}
