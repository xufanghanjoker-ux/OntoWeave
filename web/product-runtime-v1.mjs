/** Main-product orchestration. Rust owns extraction, retrieval and admission.
 * Intents survive restart; provider calls never run inside SQLite transactions. */
import {createHash, randomUUID} from 'node:crypto';
import {sourceKey} from './knowledge-governance.mjs';
import {projectProductProcessing} from './product-processing-v1.mjs';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => Object.assign(Error(code), {code, status:409});
// The library workspace needs graph navigation and exact cited source spans.
// The immutable build proof (including staging metadata) remains available from
// the dedicated graph endpoint and in the repository; it is not polled by the UI.
export function projectProductGraphForView(graph) {
  if (!Array.isArray(graph?.builds) || graph.builds.length === 0) return graph;
  return {...graph, builds:graph.builds.map(build=>({
    task_ref:build.task_ref,
    graph:{
      contract_version:build.graph.contract_version,
      snapshot:build.graph.snapshot,
      status:build.graph.status,
      graph_digest:build.graph.graph_digest,
      entities:build.graph.entities,
      statements:build.graph.statements,
      patterns:build.graph.patterns??[]
    }
  }))};
}
export function createProductRuntime({store, governance, product, reviews=null, pollMs=1000}) {
  let running=null, closed=false;
  const kind='product_learning_intent';
  const graphViewCache=new Map();
  function sources(libraryId) {
    const state=governance.baseFor(libraryId);
    if(!state) throw fail('SOURCE_LIBRARY_NOT_FOUND');
    const found=new Map();
    const base=governance.libraries().find(b=>b.id===libraryId);
    const taskIds=new Set(base?.task_ids??[]);
    for(const job of store.listTasks().filter(j=>taskIds.has(j.id))) for(const source of job.input?.sources??[]) {
      const key=sourceKey(source);
      if(state.sources[key]) found.set(key,source);
    }
    for(const row of store.listRecords('library_source')) if(row.base_id===libraryId) found.set(row.key,row.source);
    return Object.entries(state.sources).map(([key,meta])=>{
      const source=found.get(key);
      return {...source,...meta,key,source_ref:source?.id??null,
        source_revision:source?.source_revision??'source-key:'+key,
        document_id:source?.parsing?.document_id??null};
    });
  }
  function view(libraryId) {
    const base=governance.libraries().find(b=>b.id===libraryId);
    if(!base) throw fail('SOURCE_LIBRARY_NOT_FOUND');
    const state=governance.baseFor(libraryId), task=store.getTask(base.root_task_id??base.latest_task_id);
    const librarySources=sources(libraryId),jobs=product.status({libraryId});
    // A validated graph is immutable for a given source directory and graph head.
    // Hash the actual source content as well as the epoch, so a changed source
    // cannot inherit a previously validated canvas during periodic UI refresh.
    const candidateLedgerHeads=store.listRecords('source_candidate_incremental_ledger').filter(r=>r.library_id===libraryId).map(r=>r.ledger?.ledger_sha256);
    const graphKey=digest([state,librarySources,jobs.head,candidateLedgerHeads,store.getRecord('source_graph_publication_head',libraryId),store.listRecords('document_scope_coverage').filter(r=>r.library_id===libraryId).map(r=>[r.task_ref,r.status,r.receipt?.receipt_hash])]);
    let cached=graphViewCache.get(libraryId);
    if(!cached||cached.key!==graphKey){
      cached={key:graphKey,graph:projectProductGraphForView(product.graph({libraryId})),candidate_preview:typeof product.candidatePreview==='function'?projectProductGraphForView(product.candidatePreview({libraryId})):null,published_graph:typeof product.publishedGraph==='function'?projectProductGraphForView(product.publishedGraph({libraryId})):null};
      graphViewCache.set(libraryId,cached);
      if(graphViewCache.size>4)graphViewCache.delete(graphViewCache.keys().next().value);
    }
    const result={library:{id:libraryId,name:base.name,cqs:task?.input?.cqs??[],sources:librarySources,source_epoch:state.source_epoch},
      graph:cached.graph,candidate_preview:cached.candidate_preview,published_graph:cached.published_graph,jobs,
      learning:store.listRecords(kind).filter(r=>r.library_id===libraryId),
      source_stamp:{base_id:libraryId,source_epoch:state.source_epoch}};
    if(product.documentFirstEnabled===true){
      try {
        if(typeof product.documentScopeStatus!=='function')throw fail('DOCUMENT_SCOPE_NOT_CONNECTED');
        const scope=product.documentScopeStatus({libraryId});
        if(scope?.source_epoch!==state.source_epoch)throw fail('DOCUMENT_SCOPE_SOURCE_STALE');
        const models=product.modelStatus(),waiting=!models.managed_externally&&(!models.generation?.configured||!models.embedding?.configured);
        result.document_scope=waiting&&['PENDING','QUEUED','WAITING'].includes(scope.status)?{...scope,status:'WAIT_MODEL_CONFIGURATION'}:scope;
      } catch(error) {
        // Scope discovery is additional background work. A missing model or a
        // scope read failure must not hide already retained sources/answers.
        const models=product.modelStatus();
        const waiting=!models.managed_externally&&(!models.generation?.configured||!models.embedding?.configured);
        result.document_scope={status:waiting?'WAIT_MODEL_CONFIGURATION':'FAILED',phase:'DOCUMENT_DISCOVERY',source_epoch:state.source_epoch,
          families:[],tasks:[],coverage:[],generated_cqs:[],errors:waiting?[]:[{code:error.code??'DOCUMENT_SCOPE_READ_FAILED'}]};
      }
    }
    if(reviews&&typeof product.processingProgress==='function'){
      result.reviews=reviews.list({libraryId});
      result.processing=projectProductProcessing({progress:product.processingProgress({libraryId}),review:result.reviews,jobs:result.jobs,graph:result.published_graph,candidatePreview:result.candidate_preview??result.graph,sources:result.library.sources.filter(s=>s.active),sourceEpoch:state.source_epoch});
    }
    return result;
  }
  function schedule({libraryId,question,reason='INITIAL_DISCOVERY',rebuildSourceScope=false}) {
    const state=governance.baseFor(libraryId);
    if(!state) throw fail('SOURCE_LIBRARY_NOT_FOUND');
    const id=digest([libraryId,state.source_epoch,question,reason,rebuildSourceScope]);
    const old=store.getRecord(kind,id);
    if(old) return old;
    const row={id,library_id:libraryId,source_epoch:state.source_epoch,question,reason,rebuild_source_scope:rebuildSourceScope,
      request_id:randomUUID(),status:'WAITING',created_at:new Date().toISOString()};
    store.putRecord(kind,id,row);
    return row;
  }
  function initial(libraryId,rebuildSourceScope=false) {
    if(product.documentFirstEnabled===true)return schedule({libraryId,question:null,reason:'DOCUMENT_SCOPE_DISCOVERY',rebuildSourceScope});
    const base=governance.libraries().find(b=>b.id===libraryId);
    const task=base&&store.getTask(base.root_task_id??base.latest_task_id);
    const question=(task?.input?.cqs??[]).map(c=>typeof c==='string'?c:c.question).filter(Boolean).join('\n')||'发现资料中的主要实体、关系和适用条件';
    return schedule({libraryId,question,reason:rebuildSourceScope?'SOURCE_CHANGED':'INITIAL_DISCOVERY',rebuildSourceScope});
  }
  function hasActiveWriter(row){
    return (product.status({libraryId:row.library_id}).items??[]).some(q=>
      (q.job?.snapshot?.source_epoch===undefined||q.job.snapshot.source_epoch===row.source_epoch)
      &&(['QUEUED','RUNNING','WAIT_MODEL_CONFIGURATION','UNKNOWN_NO_RETRY'].includes(q.status)
        ||['COMMITTING','INDEX_PENDING'].includes(q.job?.stage)
        ||q.job?.attempts?.some(a=>['STARTED','UNKNOWN'].includes(a.outcome))));
  }
  async function tick() {
    if(closed||running) return running;
    running=(async()=>{
      const models=product.modelStatus();
      if(!models.managed_externally&&(!models.generation?.configured||!models.embedding?.configured)) {
        for(const row of store.listRecords(kind).filter(r=>r.reason==='DOCUMENT_SCOPE_DISCOVERY'&&r.status==='WAITING'))store.putRecord(kind,row.id,{...row,status:'WAIT_MODEL_CONFIGURATION'});
        return;
      }
      if(reviews)await reviews.recover();
      if(typeof product.recoverKnownPaused==='function'){
        try {await product.recoverKnownPaused();}
        catch(error){store.putRecord('product_runtime_observation','known_proposal_recovery',{
          error_code:error.code??'PRODUCT_KNOWN_PROPOSAL_RECOVERY_FAILED',at:new Date().toISOString()});}
      }
      for(let row of store.listRecords(kind).filter(r=>['WAITING','WAIT_MODEL_CONFIGURATION','DISCOVERING','SCOPE_PLANNED'].includes(r.status)).sort((a,b)=>a.created_at.localeCompare(b.created_at))) {
        if(closed) break;
        // A library has one graph writer. Prepare a later intent only after the
        // previous commit/index settles, otherwise both bind the old graph head.
        const state=governance.baseFor(row.library_id);
        if(!state||state.source_epoch!==row.source_epoch) {store.putRecord(kind,row.id,{...row,status:'SUPERSEDED'});continue;}
        try {
          if(hasActiveWriter(row))continue;
          if(row.reason==='DOCUMENT_SCOPE_DISCOVERY'){
            if(product.documentFirstEnabled!==true||typeof product.discoverDocumentScope!=='function'||typeof product.documentScopeStatus!=='function'||typeof product.documentScopeQuestion!=='function')throw fail('DOCUMENT_SCOPE_NOT_CONNECTED');
            const prior=product.documentScopeStatus({libraryId:row.library_id});
            // A crash during discovery is not permission to resend an unknown
            // provider operation. Only a persisted READY host plan is reusable.
            if(row.status==='DISCOVERING'&&prior?.status!=='READY'){
              store.putRecord(kind,row.id,{...row,status:'UNKNOWN_NO_RETRY',error_code:'DOCUMENT_SCOPE_INTERRUPTED_RESULT_UNKNOWN'});continue;
            }
            if(row.status!=='SCOPE_PLANNED'){
              row={...row,status:'DISCOVERING'};store.putRecord(kind,row.id,row);
              const plan=await product.discoverDocumentScope({libraryId:row.library_id});
              const latest=governance.baseFor(row.library_id);
              if(!latest||latest.source_epoch!==row.source_epoch){store.putRecord(kind,row.id,{...row,status:'SUPERSEDED',scope_plan_id:plan?.plan_id??null});continue;}
              if(typeof plan?.plan_id!=='string'||!plan.plan_id||plan.snapshot?.source_epoch!==row.source_epoch||plan.snapshot?.base_ref!==row.library_id)throw fail('DOCUMENT_SCOPE_PLAN_BINDING_INVALID');
              const question=product.documentScopeQuestion(plan);
              if(typeof question!=='string'||!question.trim())throw fail('DOCUMENT_SCOPE_QUESTION_REQUIRED');
              row={...row,status:'SCOPE_PLANNED',scope_plan_id:plan.plan_id,question};store.putRecord(kind,row.id,row);
            }
            const scope=product.documentScopeStatus({libraryId:row.library_id});
            if(scope?.status!=='READY'||scope.source_epoch!==row.source_epoch||scope.plan_id!==row.scope_plan_id)throw fail('DOCUMENT_SCOPE_PLAN_NO_LONGER_CURRENT');
            // Discovery awaits provider work; source validity must be checked
            // again before granting execution or creating a graph writer.
            if(governance.baseFor(row.library_id)?.source_epoch!==row.source_epoch){store.putRecord(kind,row.id,{...row,status:'SUPERSEDED'});continue;}
            if(closed)break;
            if(hasActiveWriter(row))continue;
          }
          const scopeBinding=row.scope_plan_id?{documentScopePlanId:row.scope_plan_id}:{};
          const execution=product.autoAuthorize({libraryId:row.library_id,question:row.question,operation:'LEARN',
            executionKey:row.id,requestId:row.request_id,rebuildSourceScope:row.rebuild_source_scope,...scopeBinding});
          const result=product.enqueue({libraryId:row.library_id,question:row.question,requestId:row.request_id,budgetId:execution.id,rebuildSourceScope:row.rebuild_source_scope,...scopeBinding});
          store.putRecord(kind,row.id,{...row,status:'ENQUEUED',task_ref:result.job?.task_ref??result.task_ref});
        } catch(error) {
          let scopeStatus=null;
          try {if(row.reason==='DOCUMENT_SCOPE_DISCOVERY')scopeStatus=product.documentScopeStatus?.({libraryId:row.library_id})?.status;} catch { /* Preserve the original discovery error. */ }
          const status=scopeStatus==='UNKNOWN_NO_RETRY'?'UNKNOWN_NO_RETRY':scopeStatus==='SUPERSEDED'||governance.baseFor(row.library_id)?.source_epoch!==row.source_epoch?'SUPERSEDED':'BLOCKED';
          store.putRecord(kind,row.id,{...row,status,error_code:error.code??'PRODUCT_LEARNING_FAILED'});
        }
      }
    })();
    try {await running;} finally {running=null;}
  }
  async function ask({libraryId,question,requestId,onEvent}) {
    let scopeRoute=null;
    if(product.documentFirstEnabled===true&&typeof product.routeDocumentQuestion==='function'){
      try{scopeRoute=await product.routeDocumentQuestion({libraryId,question,requestId});}
      catch(error){scopeRoute={route:'UNKNOWN',status:'HELD',error_code:error.code??'DOCUMENT_FAMILY_ROUTE_FAILED',reuse_eligible:false,semantic_equivalence_certified:false};}
    }
    const execution=product.autoAuthorize({libraryId,question,operation:'ASK',executionKey:'ask:'+requestId,requestId});
    const response=await product.ask({libraryId,question,requestId,budgetId:execution.id,onEvent});
    if(scopeRoute?.snapshot&&(!response.answer?.snapshot||digest(scopeRoute.snapshot)!==digest(response.answer.snapshot)||response.status==='SOURCE_INVALIDATED')){response.scope_route={route:'UNKNOWN',status:'SOURCE_OR_GRAPH_CHANGED',prior_receipt_hash:scopeRoute.receipt_hash};response.learning={status:'DEFERRED_SCOPE_CHANGED'};return response;}
    if(scopeRoute){
      response.scope_route=scopeRoute;
      if(scopeRoute.route==='SAME_SCOPE_REUSE'&&scopeRoute.reuse_eligible===true){response.learning={status:'NOT_NEEDED',reason:'EXISTING_FAMILY_SCOPE_REUSED',scope_receipt_hash:scopeRoute.receipt_hash};return response;}
      if(['SAME_FAMILY_NEW_SCOPE','NEW_FAMILY'].includes(scopeRoute.route)){response.learning=schedule({libraryId,question,reason:scopeRoute.route});return response;}
      response.learning={status:'DEFERRED_SCOPE_UNKNOWN',error_code:scopeRoute.error_code??null};return response;
    }
    // Admission must come from Rust; absence is an explicit integration gap,
    // never permission for JavaScript to infer semantic graph completeness.
    if(typeof product.learningAdmission==='function') {
      try {
        const admission=product.learningAdmission({response,question});
        if(admission.enqueue_discovery===true) response.learning= schedule({libraryId,question,reason:'QUESTION_DISCOVERY'});
        else response.learning={status:'NOT_NEEDED',admission};
      } catch(error) {
        // Background admission may observe source/graph changes after the answer.
        // Preserve that answer's own snapshot; do not turn learning failure into
        // a failed ASK or label the old response as current evidence.
        response.learning={status:'DEFERRED',error_code:error.code??'PRODUCT_LEARNING_ADMISSION_FAILED'};
        try {store.putRecord('product_learning_observation',digest([libraryId,requestId]),{
          library_id:libraryId,request_id:requestId,operation_id:response.operation_id??null,...response.learning});} catch {
          response.learning.observation_persisted=false;
        }
      }
    } else response.learning={status:'ADMISSION_NOT_CONNECTED'};
    return response;
  }
  const timer=pollMs>0?setInterval(()=>{void tick().catch(error=>{
    if(!closed)store.putRecord('product_runtime_observation','last_error',{error_code:error.code??'PRODUCT_SCHEDULER_FAILED',at:new Date().toISOString()});
  });},pollMs):null;
  timer?.unref?.();
  return {view,sources,schedule,initial,ask,tick,
    async whenIdle(){while(running) await running;},
    close(){closed=true;if(timer)clearInterval(timer);}};
}
