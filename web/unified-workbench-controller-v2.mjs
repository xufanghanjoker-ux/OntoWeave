import {filterLightogGraph,lightogKnowledgeHasGraphAnchor,lightogSourceKnowledgeIds} from './lightog-graph-filter-v1.mjs';
import {projectLightogReading,bindLightogLibraryGraph,lightogLibraryRevision,projectLightogLibraryReview,lightogDisplayKnowledgeRows,lightogDisplayKnowledgeById,lightogKnowledgeLocationTarget} from './lightog-reading-data-v1.mjs';
import {createLightogNavigation,parseLightogLink} from './lightog-navigation-v1.mjs';
import {submitLightogDocuments,lightogBuildCommand,confirmLightogRun} from './lightog-upload-v1.mjs';
import {lightogWorkspaceMarkup,lightogInspector,lightogBatchStatus,lightogBatchActions,lightogBatchSummary,lightogBuildProgress,lightogResumeState,lightogQueryResult,lightogKnowledgeScopeRows,esc,MODEL_PRESETS} from './unified-workbench-view-v2.mjs';
import {lightogCorrectionFromForm,lightogReviewValuesEqual,createLightogAnalysisActions} from './lightog-library-review-ui-v1.mjs';
import {qualifyPendingConflictReview,lightogDocumentReviewContext} from './lightog-pending-classification-v1.mjs';
import {projectNativeDomainGraph} from './native-domain-graph-data-v1.mjs';

/** Recheck the offered version against today's qualified members and actual filtered graph. Never widen the scope. */
export function lightogVersionLocationTarget(s,memberId,targetId,{qualifiedRefs=null}={}){
 const allowed=qualifiedRefs===null?null:new Set(qualifiedRefs),rows=lightogKnowledgeScopeRows(s).filter(row=>!allowed||allowed.has(row.id));
 const graph=filterLightogGraph(s.graph,s.model,s.route.source_filter);
 const target=memberId!==targetId&&lightogKnowledgeLocationTarget(s.model,memberId,targetId,{rows,graph});
 if(!rows.some(row=>row.id===memberId)||!target)throw Error('同组当前版本已不在当前范围内，或尚无可定位的图中关联。');
 return target;
}
export function locateLightogKnowledgeTarget(graphView,target){
 const result=graphView?.locate(target.row.id,'knowledge',{focusId:target.anchor.entity_ids[0]});
 if(!result?.located)throw Error('此版本尚无可定位的图中关联。');
 return result;
}

/** Memory alone needs authenticated GETs; keep the existing chat API unchanged. */
export function createLightogMemoryApi({fetch:fetcher=globalThis.fetch,token}={}){
 return async function memoryApi(path,data){
  const fail=(code,message,status)=>Object.assign(new Error(message??code),{code,...(status===undefined?{}:{status})});
  if(typeof path!=='string'||!path.startsWith('/api/product/memory/v1/')||/[\\\u0000-\u0020\u007f]/.test(path))throw fail('LIGHTOG_MEMORY_PATH_INVALID','记录接口路径无效。');
  const url=new URL(path,'https://lightog.invalid');
  if(url.origin!=='https://lightog.invalid'||!url.pathname.startsWith('/api/product/memory/v1/')||url.hash)throw fail('LIGHTOG_MEMORY_PATH_INVALID','记录接口路径无效。');
  if(typeof token!=='string'||!token)throw fail('LIGHTOG_MEMORY_TOKEN_MISSING','记录服务的身份凭据尚未读回。',401);
  const post=data!==undefined,headers={Accept:'application/json','X-CQForge-Token':token,...(post?{'Content-Type':'application/json'}:{})};
  const response=await fetcher(url.pathname+url.search,{method:post?'POST':'GET',credentials:'same-origin',mode:'same-origin',cache:'no-store',headers,...(post?{body:JSON.stringify(data)}:{})});
  let body;try{body=await response.json();}catch{throw fail('LIGHTOG_MEMORY_RESPONSE_UNREADABLE','记录服务回执暂不可解析，结果尚待确认。',response.status);}
  if(!response.ok){const code=typeof body?.error?.code==='string'?body.error.code:'LIGHTOG_MEMORY_HTTP_ERROR',message=typeof body?.error?.message==='string'&&body.error.message.trim()?body.error.message:typeof body?.error==='string'&&body.error.trim()?body.error:code;throw Object.assign(fail(code,message,response.status),{body});}
  return body;
 };
}

export async function mountWorkbench(options){
 const {root,boot,window:win=window}=options;
 const pg=boot.ontoweave_pg;
 if(!pg)return mountLightogWorkspace(options);
 const legacy=boot.source_first?.workspace_ui==='LIGHTOG_WORKSPACE_V1'
  ? (boot.knowledge_bases??[]).filter(entry=>!pg.libraries?.some(row=>row.library_ref===entry.id)) : [];
 const legacyIds=new Set(legacy.map(entry=>entry.id));
 const {mountPgWorkspace}=await import('./ontoweave-pg-workspace-v2.mjs');
 let active,kind,queue=Promise.resolve();
 const target=()=>legacyIds.has(new URLSearchParams(win.location.hash.slice(1)).get('library'))?'legacy':'pg';
 const switchAdapter=()=>{
  queue=queue.catch(()=>{}).then(async()=>{
   const next=target();
   if(next===kind)return;
   active?.dispose?.();
   kind=null;
   if(next==='legacy')active=await mountLightogWorkspace({...options,boot:{...boot,knowledge_bases:legacy},openPg});
   else active=mountPgWorkspace({root,boot,legacy,openLegacy});
   kind=next;
  });
  return queue;
 };
 const move=(library,page)=>{
  const route=new URLSearchParams({view:page});
  if(library)route.set('library',library);
  win.history.pushState(null,'','#'+route);
  update();
 };
 const openPg=()=>move(null,'libraries');
 const openLegacy=id=>{if(legacyIds.has(id))move(id,'graph');};
 const update=()=>{void switchAdapter().catch(()=>{
  const error=root.ownerDocument.createElement('p');
  error.className='lw-notice';
  error.textContent='当前知识空间暂时无法读取。';
  root.replaceChildren(error);
 });};
 win.addEventListener('popstate',update);
 win.addEventListener('hashchange',update);
 await switchAdapter();
 return {dispose(){active?.dispose?.();win.removeEventListener('popstate',update);win.removeEventListener('hashchange',update);}};
}

/** The product workspace owns its UI state. Polling only updates status, never reading position. */
export async function mountLightogWorkspace({root,boot,api,openPg,toast=()=>{},window:win=window,document:doc=document,storage=globalThis.localStorage}){
 const chatMode=boot.lightog_query_ui!=='legacy';
 // Route availability permits raw intake; model readiness only describes later processing.
 const memoryEnabled=chatMode&&boot.memory_product?.enabled===true&&boot.memory_product?.route==='/api/product/memory/v1';
 const memoryApi=memoryEnabled?createLightogMemoryApi({fetch:(path,options)=>fetch(path,options),token:boot.token}):null;
 const memoryRoute=frame=>{const records=memoryEnabled&&frame?.memory_mode==='records';return {memory_mode:records?'records':null,memory_record_ref:records&&/^[A-Za-z0-9_-]{1,160}$/.test(frame?.memory_record_ref??'')?frame.memory_record_ref:null};};
 const s={boot,openPg,chatMode,route:null,view:null,run:null,graph:null,artifacts:{},model:projectLightogReading(),currentMemoryView:null,currentMemoryBlocked:false,memoryCurrentError:null,models:null,loading:false,uploading:false};
 let graphView=null,tools=null,renderEpoch=0,loadEpoch=0,pollBusy=false,lastGraph=null,disposed=false,reviewActions=null,reviewReadEpoch=0;
 const reviewBusy=new Map(),reviewNotices=new Map();
 let analysisActions=null;const analysisBusy=new Set();
 let queryActions=null,queryActionsPromise=null,queryEpoch=0;
 let chatWorkspace=null,chatWorkspacePromise=null,memoryProjectionModule=null,memoryReturnEpoch=0;const memoryConfirmedLibraries=new Set();
 const queryBusy=new Set(),queryLoading=new Set(),queryCapabilities=new Map(),queryErrors=new Map(),queryDrafts=new Map(),queryCitations=new Map();
 const setLocal=(key,value)=>{try{storage?.setItem?.(key,value);return true;}catch{return false;}},clearLocal=key=>{try{storage?.removeItem?.(key);}catch{}};
 const graphSyncPending=new Set(),cache=new Map(),cacheBindings=new Map(),base=id=>'/api/product/libraries/'+encodeURIComponent(id),runBase=(id,run)=>base(id)+'/native-full-chain/runs/'+encodeURIComponent(run);
 const clearCache=id=>{cache.delete(cacheBindings.get(id));cacheBindings.delete(id);};
 const cachedLibrary=id=>cache.get(cacheBindings.get(id));
 const cacheLibrary=(id,entry)=>{const revision=entry.currentMemoryView?.revision_key??entry.model.library_state.revision_ref??entry.graph?.index_revision??entry.run?.run_id??'sources';const key=JSON.stringify([id,revision]);cacheBindings.set(id,key);cache.set(key,{...entry,read_binding:{library_id:id,run_id:entry.run?.run_id??null,revision_ref:entry.model.library_state.revision_ref}});};
 // Keep unknown starts per library, including the legacy single receipt. No automatic replay.
 const pendingStarts=new Map(),pendingKey=id=>'lightog.pending-start.v1:'+id;
 try{const legacy=JSON.parse(storage?.getItem('lightog.pending-start.v1')??'null');if(legacy?.library_id){pendingStarts.set(legacy.library_id,legacy);setLocal(pendingKey(legacy.library_id),JSON.stringify(legacy));}}catch{}
 function syncPendingStart(id){
  try{const receipt=JSON.parse(storage?.getItem(pendingKey(id))??'null');if(receipt?.library_id===id)pendingStarts.set(id,receipt);}catch{}
  s.pendingStart=pendingStarts.get(id)??null;return s.pendingStart;
 }
 function rememberPending(receipt){pendingStarts.set(receipt.library_id,receipt);if(s.route.library_id===receipt.library_id)s.pendingStart=receipt;setLocal(pendingKey(receipt.library_id),JSON.stringify(receipt));setLocal('lightog.pending-start.v1',JSON.stringify(receipt));}
 function clearPending(id,requestId){
  const receipt=pendingStarts.get(id);if(!receipt||receipt.request_id!==requestId)return;
  pendingStarts.delete(id);clearLocal(pendingKey(id));
  try{const legacy=JSON.parse(storage?.getItem('lightog.pending-start.v1')??'null');if(legacy?.library_id===id&&legacy.request_id===requestId)clearLocal('lightog.pending-start.v1');}catch{}
  if(s.pendingStart?.library_id===id&&s.pendingStart.request_id===requestId)s.pendingStart=null;
 }
 async function readRun(id,row){
  if(!row)return null;const status=await api(runBase(id,row.run_id)+'/status');
  return {...row,...status,...(Object.hasOwn(row,'resume_available')?{resume_available:row.resume_available===true}:{}),...(Object.hasOwn(row,'resume_summary')?{resume_summary:row.resume_summary}:{})};
 }
 function pendingReviewApplication(id){
  try{const receipt=JSON.parse(storage?.getItem('lightog.library-review.pending.v1:'+id)??'null');return receipt?.library_id===id&&receipt.kind==='APPLICATION'&&/^nrun_[a-f0-9]{32}$/.test(receipt.run_id??'')&&typeof receipt.revision_ref==='string'?receipt:null;}catch{return null;}
 }
 function checkReviewDecision(response,context){
  if(response?.policy!=='LIBRARY_REVIEW_V1')return false;
  const event=response.event??response.history?.find(event=>event.request_id===context.requestId);
  const effect=event?.effect??response.effect,required=event?.application_required??response.application_required,effectMatches=context.expectedEffect===undefined||effect===context.expectedEffect&&required===(effect==='VERSION_CHANGE');
  return !!event&&event.request_id===context.requestId&&event.library_id===context.libraryId&&event.source_run_id===context.runId&&event.source_revision_ref===context.revisionRef&&event.item_ref===context.body.item_ref&&event.action===context.body.action&&event.reason===context.body.reason.trim()&&lightogReviewValuesEqual(event.correction,context.expectedCorrection)&&lightogReviewValuesEqual(event.definition_resolution,context.body.definition_resolution)&&effectMatches&&typeof event.event_ref==='string'&&(response.event?['PENDING_APPLICATION','APPLIED','DEFERRED','SAVED'].includes(response.status)&&response.graph_changed===false&&response.index_changed===false:response.run_id===context.runId&&response.revision_ref===context.revisionRef);
 }
 function appliedReviewReceipt(response,context){
  const values=[response,response?.application,response?.applied,...(Array.isArray(response?.applications)?response.applications:[])];
  return values.find(value=>value?.policy==='LIBRARY_REVIEW_V1'&&value.status==='APPLIED'&&value.library_id===context.libraryId&&value.source_run_id===context.runId&&value.source_revision_ref===context.revisionRef&&value.application_ref===context.acceptedApplicationRef&&value.target_run_id===context.targetRunId&&/^nrun_[a-f0-9]{32}$/.test(value.target_run_id??'')&&value.target_run_id!==context.runId&&typeof value.target_revision_ref==='string'&&typeof value.source_index_revision==='string'&&typeof value.knowledge_index_revision==='string')??null;
 }
 async function reviewManager(){
  if(!reviewActions){const module=await import('./lightog-library-review-ui-v1.mjs');reviewActions=module.createLightogReviewActions({api,uuid:()=>crypto.randomUUID(),storage,confirmDecision:checkReviewDecision,confirmApplication:(response,context)=>Boolean(appliedReviewReceipt(response,context))});}return reviewActions;
 }
 function reviewContext(){return lightogDocumentReviewContext(s.model);}
 function usesSimplifiedReview(){return reviewContext()?.simplified===true;}
 function safeDefinitionTarget(item,comparisonRef,definitionRef){
  const comparison=item?.comparisons.find(row=>row.comparison_ref===comparisonRef);
  return comparison?.binding_status==='BOUND'&&comparison.sides.some(side=>(side.definition_ref??side.record?.definition_ref)===definitionRef)&&comparison.target_capabilities?.some(target=>target.definition_ref===definitionRef&&target.enabled===true);
 }
 function revalidateDefinitionTarget(view){
  const selected=s.reviewTargetSelection;if(!selected)return;
  const item=view.items.find(row=>row.id===selected.item_id);
  if(!safeDefinitionTarget(item,selected.comparison_ref,selected.definition_ref)){s.reviewTargetSelection=null;s.reviewTargetNotice='原选定目标在当前比较中不再安全，请重新选择；未自动替换为另一方。';}
 }
 function syncAnalysis(){
  analysisActions??=createLightogAnalysisActions({api,uuid:()=>crypto.randomUUID(),storage});
  const item=s.review?.items?.find(row=>row.id===s.route.pending_item_id)??(s.route.review_scope==='analysis'?s.review?.items?.find(row=>row.triage.queue==='ANALYSIS'):null);
  s.analysisBusy=Boolean(item&&analysisBusy.has(s.route.library_id+':'+item.id));s.analysisReceipt=item?analysisActions.pending(s.route.library_id,item.id):null;s.analysisResult=s.analysisReceipt?.response??(s.analysisReceipt?{status:s.analysisReceipt.status}:null);
 }
 async function analysisOperation(kind,itemRef){
  const context=reviewContext(),frame=s.route,item=s.review?.items?.find(row=>row.id===itemRef),key=context?.libraryId+':'+itemRef;
  if(!context||!item||item.triage.queue!=='ANALYSIS'||analysisBusy.has(key))return;
  syncAnalysis();if(kind==='start'&&item.analysis_capability?.can_start!==true)throw Error('此项没有新增分析信息，当前未开放新的分析请求。');
  analysisBusy.add(key);await render();
  try{const result=kind==='start'?await analysisActions.start({...context,itemRef,inputFingerprint:item.analysis_capability?.input_fingerprint??item.analysis_capability?.input_sha256??null}):await analysisActions.read({libraryId:context.libraryId,itemRef});
   if(!disposed&&s.route===frame){if(result.status==='REJECTED')toast(result.error?.message??'分析请求尚未提交。');if(['COMPLETED','PARTIAL','NO_NEW_INFORMATION'].includes(result.status))await loadReview();}
  }finally{analysisBusy.delete(key);if(!disposed&&s.route===frame)await render();}
 }
 async function conflictRequest(body,{readOnly=false}={}){const context=reviewContext();if(!context)throw Error('当前知识版本尚未读回。');if(!readOnly&&s.reviewPending)throw Error('此前处理结果待确认，已暂停重复提交。');const key='lightog.conflict.pending.v1:'+context.libraryId;if(!readOnly&&storage.getItem(key))throw Error('此前处理结果待确认，已暂停重复提交。');if(!readOnly){storage.setItem(key,JSON.stringify({libraryId:context.libraryId,runId:context.runId,body}));s.reviewBusy=true;s.conflictBusy=true;}
  try{const result=await api(runBase(context.libraryId,context.runId)+'/conflicts',{...body,expected_revision_ref:context.revisionRef,expected_revision_sha256:s.model.library_knowledge.record_sha256,consent:true});if(!readOnly){storage.removeItem(key);s.reviewPending=false;}return result;}catch(error){if(!readOnly){s.reviewPending=true;s.conflictPendingApplicationRef=body.application_ref??s.conflictApplication?.application_ref??null;}throw error;}finally{s.reviewBusy=false;s.conflictBusy=false;}}
 async function prepareConflict(){const frame=s.route,context=reviewContext();if(!s.conflictDecision)throw Error('请先保存本版的处理决定。');const result=await conflictRequest({operation:'prepare',decision_refs:[s.conflictDecision.event_ref]});if(s.route!==frame||reviewContext()?.revisionRef!==context.revisionRef)return null;s.conflictPrepared=result;s.conflictApplication=result.application;s.reviewPreview=result;return result;}
 async function loadReview(){
  const context=reviewContext(),frame=s.route,epoch=++reviewReadEpoch;
  if(!context){s.review=null;s.reviewError='当前组织版本尚未读回。';return;}
  s.reviewLoading=true;
  try{
   if(usesSimplifiedReview()){
    const contextKey=context.libraryId+':'+context.revisionRef;if(s.conflictContextKey!==contextKey){s.conflictDecision=null;s.conflictPrepared=null;s.conflictApplication=null;s.reviewPreview=null;s.conflictPendingApplicationRef=null;s.conflictItemRef=null;s.conflictReview=null;s.conflictContextKey=contextKey;}
    const result=await api(runBase(context.libraryId,context.runId)+'/conflicts');if(disposed||s.route!==frame||epoch!==reviewReadEpoch)return;
    if(result.review?.library_id!==context.libraryId||(result.active_revision_ref??result.review.revision_ref)!==context.revisionRef||!Array.isArray(result.review.items))throw Error('冲突比较版本尚未对齐，请重新读取。');const cap=result.capabilities;s.conflictReview={...qualifyPendingConflictReview(result.review,s.model,{writable:cap?.writable===true&&cap.mode==='NATIVE_PRODUCT',supportedKinds:cap?.supported_kinds??[],supportedActions:cap?.supported_actions??[]}),backend_capabilities:cap??null};s.conflictBindings=result.bindings;s.conflictHistory=result.history??[];s.review=null;s.reviewError=null;
    const saved=JSON.parse(storage?.getItem('lightog.conflict.pending.v1:'+context.libraryId)??'null');s.conflictPendingApplicationRef=saved?.body?.application_ref??null;const confirmed=saved&&(saved.body.operation==='decide'&&(result.decisions??[]).some(d=>d.request_id===saved.body.request_id)||saved.body.operation==='apply'&&(result.history??[]).some(h=>h.application_ref===saved.body.application_ref&&h.status==='APPLIED'));if(confirmed)storage.removeItem('lightog.conflict.pending.v1:'+context.libraryId);s.reviewPending=Boolean(saved&&!confirmed);return;
   }
   s.conflictReview=null;
   const response=await api(runBase(context.libraryId,context.runId)+'/library-review?revision_ref='+encodeURIComponent(context.revisionRef));
   if(disposed||s.route!==frame||epoch!==reviewReadEpoch||reviewContext()?.revisionRef!==context.revisionRef)return;
   const view=projectLightogLibraryReview(response,s.model);if(view.status!=='READY')throw Error(view.reason);
   s.review=view;s.reviewError=null;revalidateDefinitionTarget(view);if(s.reviewPreviewEventKey!==JSON.stringify(view.history.map(event=>event.event_ref)))s.reviewPreview=null;const manager=await reviewManager();
   if(disposed||s.route!==frame||epoch!==reviewReadEpoch)return;
   const pending=manager.pending(context.libraryId);
   if(pending&&!pending.unreadable&&pending.run_id===context.runId&&pending.revision_ref===context.revisionRef){
    const result=await manager.confirmReadback({...context,requestId:pending.request_id,response});
    if(result.status==='CONFIRMED'){reviewNotices.set(context.libraryId,{...context,text:pending.kind==='APPLICATION'?'处理结果已确认应用；当前阅读位置保留，可查看最新结果。':'处理决定已读回；应用状态以当前记录为准。',applied:pending.kind==='APPLICATION'});if(pending.kind==='APPLICATION')clearCache(context.libraryId);}
    else if(pending.kind==='APPLICATION'&&pending.target_run_id){
     const target=await api(runBase(context.libraryId,pending.target_run_id)+'/status');
     if(!disposed&&s.route===frame&&epoch===reviewReadEpoch&&target?.run_id===pending.target_run_id)s.reviewApplicationState={status:target.status,phase:target.phase,error:target.error??target.snapshot?.error??null};
    }
   }
  }catch(error){if(!disposed&&s.route===frame&&epoch===reviewReadEpoch){s.reviewError=error.message;s.review=null;}}
  finally{if(!disposed&&s.route===frame&&epoch===reviewReadEpoch)s.reviewLoading=false;}
 }
 async function previewReview(){
  const context=reviewContext(),frame=s.route,view=s.review;
  if(!context||view?.status!=='READY'||!view.writable||s.reviewError||s.reviewPending||reviewBusy.has(context.libraryId)||!(Number(view.summary.pending_application)>0))throw Error('请先保存决定并核对当前处理请求状态。');
  const eventKey=JSON.stringify(view.history.map(event=>event.event_ref));s.reviewPreviewLoading=true;s.reviewPreviewError=null;await render();
  try{
   const response=await api(runBase(context.libraryId,context.runId)+'/library-review/preview?revision_ref='+encodeURIComponent(context.revisionRef)),plan=response?.application??response;
   if(disposed||s.route!==frame||reviewContext()?.revisionRef!==context.revisionRef)return;
   const localEvents=view.record.current_revision_history??view.history;
   if(plan?.policy!=='LIBRARY_REVIEW_APPLICATION_V1'||plan.library_id!==context.libraryId||plan.source_run_id!==context.runId||plan.source_revision_ref!==context.revisionRef||typeof plan.application_ref!=='string'||JSON.stringify(plan.event_refs)!==JSON.stringify(localEvents.map(event=>event.event_ref))||!Array.isArray(plan.content_changes))throw Error('应用预览尚未与本版已保存决定对应，未开放应用。');
   s.reviewPreview=plan;s.reviewPreviewEventKey=eventKey;
  }catch(error){if(s.route===frame){s.reviewPreview=null;s.reviewPreviewError=error.message;}}
  finally{if(s.route===frame){s.reviewPreviewLoading=false;await render();}}
 }
 async function submitReview(kind,fields={}){
  const context=reviewContext(),frame=s.route,view=s.review;
  if(!context||view?.status!=='READY'||!view.writable||s.reviewError)throw Error('请先读回当前有效版本的人工处理事项。');
  if(reviewBusy.has(context.libraryId))return;
  const manager=await reviewManager();if(manager.pending(context.libraryId))throw Error('此前处理请求尚待确认，已暂停重复提交。');
  if(kind==='DECISION'){
   const item=view.items.find(item=>item.id===fields.itemRef);
   const capability=item?.action_capabilities.find(row=>row.action===fields.action);
   if(!item||!capability||!item.readiness.can_decide||capability.requires_reason===true&&!fields.reason?.trim())throw Error('请选择此项已开放的处理方式，并按动作要求填写理由。');
   fields={...fields,expectedEffect:capability.effect,reasonRequired:capability.requires_reason===true};
  }else {
   if(!(Number(view.summary.pending_application)>0))throw Error('当前没有已经保存、等待应用的决定。');
   if(!s.reviewPreview||s.reviewPreviewEventKey!==JSON.stringify(view.history.map(event=>event.event_ref)))throw Error('请先读取本版已保存决定的应用影响预览。');
  }
  const token={};reviewBusy.set(context.libraryId,token);if(s.route===frame)await render();
  try{
   if(kind==='DECISION'){s.reviewPreview=null;s.reviewPreviewEventKey=null;}
   const sourceKnowledge=kind==='DECISION'&&fields.correction!==undefined?view.items.find(item=>item.id===fields.itemRef)?.record.knowledge:undefined;
   let result=kind==='DECISION'?await manager.saveDecision({...context,...fields,...(sourceKnowledge?{sourceKnowledge}:{})}):await manager.apply({...context,applicationFields:{application_ref:s.reviewPreview.application_ref}});
   if(kind==='APPLICATION'&&result.receipt?.response){
    const response=result.receipt.response,parts=[response?.applied,response?.application,response].filter(Boolean);
    const bound=parts.find(value=>value.library_id===context.libraryId&&(value.source_run_id??value.application_source_run_id)===context.runId&&(value.source_revision_ref??value.source_library_revision_ref)===context.revisionRef&&typeof value.application_ref==='string');
    const target=bound?.target_run_id??response.target_run_id??response.run_id;
    if(bound&&/^nrun_[a-f0-9]{32}$/.test(target??'')&&target!==context.runId){
     manager.bindAcceptedApplication({...context,requestId:result.receipt.request_id,applicationRef:bound.application_ref,targetRunId:target});
     result=await manager.confirmReadback({...context,requestId:result.receipt.request_id,response});
    }
   }
   const applied=kind==='APPLICATION'&&result.status==='CONFIRMED';
   const stateOnly=kind==='DECISION'&&(result.receipt?.response?.effect??result.receipt?.response?.event?.effect)==='STATE_ONLY';
   const text=result.status==='CONFIRMED'?(applied?'处理结果已确认应用；此前运行保留，可查看最新结果。':stateOnly?(fields.action==='defer'?'已暂缓此项；仅保存状态，没有构建图或索引。':'处理状态已保存，没有构建图或索引。'):'处理决定已保存，等待显式应用；当前图谱不变。'):result.status==='REJECTED'?'处理请求未保存：'+(result.error?.message??'请求被拒绝'):'处理请求结果尚待确认，已暂停重复提交；不会自动重发。';
   reviewNotices.set(context.libraryId,{...context,text,applied});if(applied)clearCache(context.libraryId);
   if(!disposed&&s.route===frame&&reviewContext()?.revisionRef===context.revisionRef)await loadReview();
  }finally{
   if(reviewBusy.get(context.libraryId)===token)reviewBusy.delete(context.libraryId);
   if(!disposed&&s.route===frame&&reviewContext()?.revisionRef===context.revisionRef)await render();
  }
 }
 const initial=parseLightogLink(win.location.hash,{memoryEnabled});if(!initial.library_id&&initial.page==='graph')initial.library_id=boot.knowledge_bases?.[0]?.id??null;
 if(win.location.hash==='#settings')initial.page='settings';
 s.route=initial;
 const nav=createLightogNavigation({history:win.history,location:win.location,initial,memoryEnabled,onNavigate:frame=>show(frame).catch(error=>toast(error.message))});
 const update=patch=>{Object.assign(s.route,patch);nav.update(patch);};
 async function ensureQueryActions(){queryActionsPromise??=import('./lightog-query-ui-v1.mjs').then(module=>queryActions=module.createLightogQueryActions({api,uuid:()=>crypto.randomUUID(),storage}));return queryActionsPromise;}
 async function ensureChatWorkspace(){
  chatWorkspacePromise??=import('./lightog-chat-workspace-v1.mjs').then(module=>chatWorkspace=module.createLightogChatWorkspace({api,memoryEnabled,memoryApi,onMemoryReturn,storage,document:doc,uuid:()=>crypto.randomUUID(),requestStream:(url,options={})=>fetch(url,{...options,credentials:'same-origin',headers:{...options.headers,...(boot.token?{'X-CQForge-Token':boot.token}:{})}}),readModel:()=>s.model,matchesScope:queryScopeMatches,canAsk:()=>queryScopeMatches(queryCapabilities.get(s.route.library_id)?.scope),onError:message=>toast(message),onRoute:frame=>{if(s.route.page==='query'&&s.route.library_id===frame.library_id)update({...frame,...memoryRoute({...s.route,...frame})});},onOpenSource:({libraryId,source,citation,queryRef,conversationId,turnId,sourceIndex})=>{
   if(s.route.library_id!==libraryId||!source.available)return;
   go({...memoryRoute(s.route),library_id:libraryId,page:'reader',document_key:source.document_key,block_id:source.block_ids[0]??null,reader_scope:source.block_ids.length?'paragraph':'all',scroll_to_block:Boolean(source.block_ids.length),metadata_source:{title:'回答依据：'+citation.label,source},query_ref:queryRef,query_citation_ref:citation.citation_ref??citation.id,query_source_index:sourceIndex,conversation_id:conversationId,chat_turn_id:turnId});
  },onOpenGraph:({libraryId,kind,id,scope})=>{
   if(s.route.library_id!==libraryId||!queryScopeMatches(scope))return;const previous=lastGraph?.library_id===libraryId?lastGraph:{},knowledge=kind==='knowledge'?s.model.knowledgeById.get(id):null,anchored=Boolean(knowledge&&(knowledge.entity_ids.length||knowledge.relation_ids.length));
   go({...previous,...memoryRoute(s.route),library_id:libraryId,page:'graph',display:knowledge&&!anchored?'list':'canvas',source_filter:null,search:'',definition_filter:null,knowledge_id:kind==='knowledge'?id:null,object_id:kind==='entity'?id:null,selection:kind==='relation'?{id,kind:'relation'}:kind==='entity'?{id,kind:'entity'}:null,locate_pending:kind==='knowledge'&&anchored,locate_object_pending:kind==='entity',locate_relation_pending:kind==='relation'});
  }}));return chatWorkspacePromise;
 }
 async function loadChatCapabilities({renderChat=true}={}){
  const id=s.route.library_id,frame=s.route,epoch=++queryEpoch;if(!id)return;queryCapabilities.delete(id);queryErrors.delete(id);
  try{const capabilities=await api(base(id)+'/native-query/capabilities');if(disposed||epoch!==queryEpoch||s.route!==frame)return;if(capabilities.library_id!==id||capabilities.scope?.library_id!==id)throw Error('问答版本尚未与当前知识库对应。');queryCapabilities.set(id,capabilities);if(chatWorkspace)chatWorkspace.client.noteVersion({libraryId:id,pin:capabilities.scope});}
  catch(error){if(!disposed&&epoch===queryEpoch&&s.route===frame)queryErrors.set(id,error.message||'问答版本暂未读回。');}
  if(renderChat&&s.route===frame)chatWorkspace?.render();
 }
 function queryScopeMatches(scope){
  if(s.memoryCurrentError||s.currentMemoryBlocked||s.graph?.partial===true)return false;
  if(s.currentMemoryView){const expected=s.currentMemoryView.scope;return expected?.library_id===s.route.library_id&&Object.keys(expected).every(key=>typeof expected[key]==='string'&&scope?.[key]===expected[key]);}
  const library=s.model.library_knowledge,sourceIndex=s.run?.active_library_knowledge?.source_index_revision??s.run?.snapshot?.build?.source_index?.index_revision;
  return s.model.library_state?.status==='READY'&&library&&scope?.library_id===s.route.library_id&&scope.build_run_id===library.run_id&&scope.library_revision_ref===library.revision_ref&&scope.source_snapshot_ref===library.source_snapshot_ref&&scope.fact_index_revision===(s.graph?.lightog_base_index_revision??s.graph?.index_revision)&&typeof sourceIndex==='string'&&sourceIndex.length>0&&scope.source_index_revision===sourceIndex;
 }
 async function readCurrentMemoryDto(id){
  if(!memoryEnabled)return null;
  try{return await memoryApi('/api/product/memory/v1/current-view?library_id='+encodeURIComponent(id));}
  catch(error){if(error?.code==='MEMORY_PUBLICATION_NOT_READY'&&!memoryConfirmedLibraries.has(id))return null;throw error;}
 }
 async function projectCurrentMemory(dto,id,artifacts=s.artifacts,sources=s.view?.library?.sources??[]){
  if(dto===null)return null;
  memoryProjectionModule??=import('./lightog-memory-current-view-v1.mjs');
  const module=await memoryProjectionModule,projection=await module.projectLightogMemoryDisplayView(dto,{libraryId:id,documents:artifacts.documents,blocks:artifacts.blocks,sources});
  memoryConfirmedLibraries.add(id);return projection;
 }
 function currentReadFailed(id,error,prior=s.currentMemoryView){
  queryCapabilities.delete(id);clearCache(id);s.memoryCurrentError=error.message||'当前视图尚未确认。';
  if(prior?.scope?.library_id===id){s.currentMemoryView=prior;s.graph=prior.display_graph??prior.graph;s.model=prior.model;s.currentMemoryBlocked=false;s.loadError='当前视图尚未确认，保留此前快照。'+s.memoryCurrentError;}
  else{s.currentMemoryView=null;s.graph=null;s.model=projectLightogReading({libraryId:id,...s.artifacts,sources:s.view?.library?.sources??[]});s.currentMemoryBlocked=true;s.loadError='当前视图尚未确认，未使用旧批次拼装当前知识。'+s.memoryCurrentError;}
 }
 async function onMemoryReturn({libraryId:id}={}){
  const frame=s.route,token=++memoryReturnEpoch,owns=()=>!disposed&&token===memoryReturnEpoch&&memoryEnabled&&s.route===frame&&s.route.library_id===id&&s.route.page==='query';let currentLoaded=false;
  if(!owns())throw Error('记录返回已离开原知识库，未更新其他页面。');
  ++loadEpoch;++queryEpoch;queryCapabilities.delete(id);queryErrors.delete(id);clearCache(id);const prior=s.currentMemoryView;
  try{
   const dto=await readCurrentMemoryDto(id);if(!owns())throw Error('记录返回位置已变化，未更新其他页面。');
   if(dto===null){await loadLibrary(id,{renderLoading:false});if(!owns())throw Error('记录返回位置已变化，未更新其他页面。');}
   else{const projection=await projectCurrentMemory(dto,id);if(!owns())throw Error('记录返回位置已变化，未更新其他页面。');s.currentMemoryView=projection;s.currentMemoryBlocked=false;s.memoryCurrentError=null;s.loadError=null;project();cacheLibrary(id,{view:s.view,run:s.run,graph:s.graph,artifacts:s.artifacts,model:s.model,currentMemoryView:s.currentMemoryView,currentMemoryBlocked:false,memoryCurrentError:null});}
   currentLoaded=true;await loadChatCapabilities({renderChat:false});if(!owns())throw Error('记录返回位置已变化，未更新其他页面。');
   const capabilities=queryCapabilities.get(id);if(!capabilities||!queryScopeMatches(capabilities.scope))throw Error('当前问答与已确认知识视图尚未对齐，暂不能提问。');
   return {pin:structuredClone(capabilities.scope)};
  }catch(error){if(owns()){queryCapabilities.delete(id);if(!currentLoaded)currentReadFailed(id,error,prior);queryErrors.set(id,error.message||'当前问答版本尚未确认。');}throw error;}
 }
 function syncQuery(){
  const id=s.route.library_id;s.query=queryActions?.current(id)??{status:'IDLE'};s.queryCapabilities=queryCapabilities.get(id)??null;s.queryLoading=queryLoading.has(id);s.queryBusy=queryBusy.has(id);s.queryError=queryErrors.get(id)??null;s.queryDraft=queryDrafts.get(id)??'';s.queryReadVersionChanged=Boolean(s.queryCapabilities&&!queryScopeMatches(s.queryCapabilities.scope));s.queryEnabled=Boolean(s.queryCapabilities&&queryScopeMatches(s.queryCapabilities.scope)&&!s.queryLoading);const selected=queryCitations.get(id);s.queryCitation=selected?.query_ref===s.query.query_ref?selected:null;
 }
 function renderQuery(){
  if(disposed||s.route.page!=='query')return;syncQuery();const result=root.querySelector('[data-lw-query-result]');if(result)result.innerHTML=lightogQueryResult(s);const submit=root.querySelector('[data-lw-query-submit]');if(submit){submit.disabled=!s.queryEnabled||s.query.locked||s.queryBusy;submit.textContent=s.queryBusy?'正在处理…':'提问';}
 }
 async function loadQuery({read=true}={}){
  if(chatMode){await loadChatCapabilities();return;}
  const id=s.route.library_id,frame=s.route,epoch=++queryEpoch;if(!id)return;queryLoading.add(id);queryErrors.delete(id);renderQuery();
  try{
   const actions=await ensureQueryActions(),capabilities=await api(base(id)+'/native-query/capabilities');
   if(disposed||epoch!==queryEpoch||s.route!==frame)return;
   if(capabilities.library_id!==id||capabilities.scope?.library_id!==id)throw Error('问答版本未能与当前知识库对应，请重新读取。');
   queryCapabilities.set(id,capabilities);actions.noteVersion({libraryId:id,pin:capabilities.scope});
   const current=actions.current(id);if(read&&current?.query_ref)await actions.read({libraryId:id,queryRef:current.query_ref});
  }catch(error){if(!disposed&&epoch===queryEpoch&&s.route===frame)queryErrors.set(id,error.message||'问答状态暂未读回。');}
  finally{queryLoading.delete(id);if(!disposed&&epoch===queryEpoch&&s.route===frame)renderQuery();}
 }
 async function queryOperation(kind,question=null){
  const id=s.route.library_id,frame=s.route;if(!id||queryBusy.has(id))return;syncQuery();
  if(kind==='start'&&!s.queryEnabled){queryErrors.set(id,'请先读取与当前知识视图一致的版本，再提问。');renderQuery();return;}
  queryBusy.add(id);queryErrors.delete(id);renderQuery();
  try{
   const actions=await ensureQueryActions();
   if(kind==='start'){queryCitations.delete(id);const pending=actions.start({libraryId:id,question,context:[],pin:queryCapabilities.get(id).scope});renderQuery();await pending;}
   else if(kind==='cancel'){const pending=actions.cancel({libraryId:id,queryRef:actions.current(id)?.query_ref});renderQuery();await pending;}
   else {const ref=actions.current(id)?.query_ref;if(ref)await actions.read({libraryId:id,queryRef:ref});}
  }catch(error){queryErrors.set(id,error.message||'本次问答状态尚待核对。');}
  finally{queryBusy.delete(id);if(!disposed&&s.route===frame)renderQuery();}
 }
 async function pollQuery(){
  if(chatMode)return;
  if(disposed||s.route.page!=='query'||queryBusy.has(s.route.library_id)||queryLoading.has(s.route.library_id))return;
  const q=queryActions?.current(s.route.library_id);if(!q?.query_ref)return;
  if(!q.needs_readback&&!['RUNNING','ANSWER_STAGED','SUBMITTING','CANCEL_UNCONFIRMED'].includes(q.status))return;
  await queryOperation('read');
 }
 async function restoreQuerySource(frame){
  if(frame.page!=='reader'||!frame.query_ref||!frame.query_citation_ref||frame.metadata_source)return;
  try{
   if(chatMode){const workspace=await ensureChatWorkspace(),result=await workspace.restoreSource(frame);if(disposed||s.route!==frame)return;update({metadata_source:{title:'回答依据：'+result.citation.label,source:result.source},block_id:result.source.block_ids[0]??null,reader_scope:result.source.block_ids.length?'paragraph':'all',scroll_to_block:Boolean(result.source.block_ids.length),query_source_notice:null});return;}
   const actions=await ensureQueryActions(),id=frame.library_id;if(actions.current(id)?.query_ref!==frame.query_ref)throw Error('此引用对应的原查询尚未读回，未换用其他回答。');
   await actions.read({libraryId:id,queryRef:frame.query_ref});const response=await actions.citation({libraryId:id,queryRef:frame.query_ref,citationRef:frame.query_citation_ref});if(response.status!=='READY')throw Error(response.error?.message??'此引用暂不可读。');
   const module=await import('./lightog-query-citations-v1.mjs');if(disposed||s.route!==frame)return;const q=actions.current(id),citation=module.projectLightogQueryCitation(response.citation,s.model,{historical:q.historical||response.historical||!queryScopeMatches(q.source_scope??q.pin)}),source=citation.sources[frame.query_source_index??0];
   if(!source?.available||source.document_key!==frame.document_key)throw Error('此引用的资料版本暂不可读，没有替用其他版本。');
   queryCitations.set(id,{...citation,query_ref:frame.query_ref});update({metadata_source:{title:'回答依据：'+citation.label,source},block_id:source.block_ids[0]??null,reader_scope:source.block_ids.length?'paragraph':'all',scroll_to_block:Boolean(source.block_ids.length),query_source_notice:null});
  }catch(error){if(!disposed&&s.route===frame)update({query_source_notice:error.message+' 可继续阅读已保留正文；未补造引用高亮。'});}
 }
 const project=()=>{const previousRevision=s.model.library_state?.revision_ref;if(s.currentMemoryView){s.graph=s.currentMemoryView.display_graph??s.currentMemoryView.graph;s.model=s.currentMemoryView.model;}else{s.graph=bindLightogLibraryGraph(s.graph,{run:s.run,libraryId:s.route.library_id});s.model=projectLightogReading({libraryId:s.route.library_id,run:s.run,graph:s.graph,...s.artifacts,sources:s.view?.library?.sources??[]});}if(previousRevision!==s.model.library_state?.revision_ref){if(s.reviewTargetSelection){s.reviewTargetSelection=null;s.reviewTargetNotice='知识版本已变化，原目标未沿用；请核对当前比较后重新选择。';}++reviewReadEpoch;s.review=null;s.conflictReview=null;s.conflictItemRef=null;s.reviewError=null;s.reviewLoading=false;s.reviewPreview=null;s.reviewPreviewEventKey=null;}};
 function capture(){
  const patch={window_scroll:win.scrollY??0,document_scroll:root.querySelector('[data-lw-document]')?.scrollTop??s.route.document_scroll??0,inspector_scroll:root.querySelector('[data-lw-inspector]')?.scrollTop??s.route.inspector_scroll??0,list_scroll:root.querySelector('.lw-graph-main')?.scrollTop??s.route.list_scroll??0,reader_knowledge_scroll:root.querySelector('.lw-reading-knowledge')?.scrollTop??s.route.reader_knowledge_scroll??0,definition_scroll:root.querySelector('.lw-definition-list')?.scrollTop??s.route.definition_scroll??0};
  if(graphView)patch.graph_context=graphView.snapshot();if(root.querySelector('details[data-lw-identity-mention]'))patch.identity_expanded=[...root.querySelectorAll('details[data-lw-identity-mention][open]')].map(el=>el.dataset.lwIdentityMention);update(patch);
  if(s.route.page==='graph')lastGraph=structuredClone(s.route);
 }
 function disposeGraph(){graphView?.dispose();graphView=null;}
 function inspector(){
  if(s.route.page!=='graph')return;
  const layout=root.querySelector('[data-lw-graph-layout]');if(!layout)return;
  const has=Boolean(s.route.selection||s.route.object_id||s.route.knowledge_id);layout.classList.toggle('has-inspector',has);
  let pane=layout.querySelector('[data-lw-inspector]');if(!has){pane?.remove();return;}
  if(!pane){pane=doc.createElement('aside');pane.className='lw-inspector';pane.setAttribute('aria-label','对象和知识详情');pane.setAttribute('data-lw-inspector','');layout.append(pane);}
  pane.innerHTML=lightogInspector(s);
 }
 function metadataItem(kind,id,mention){
  if(kind==='pending-classified')return s.model.pending_classification?.entries.find(row=>row.id===id);
  const entity=s.model.entityById?.get(id);
  if(kind==='issue'){const item=s.review?.items?.find(row=>row.id===id)??s.model.issues.find(row=>row.id===id);if(Number.isInteger(mention)&&mention>=0&&item?.comparison_sides?.[mention])return item.comparison_sides[mention];return item?.original_knowledge?{...item,sources:item.original_sources}:item;}
  return kind==='definition'?s.model.definitionById.get(id)??s.model.term_observations.find(row=>row.id===id):kind==='mention'?entity?.mentions[mention]:kind==='identity-decision'?s.model.entities.flatMap(row=>row.decisions).find(row=>row.record.decision_ref===id):null;
 }
 function normaliseRoute(){if(s.route.page==='reader'&&s.route.evidence_kind&&!s.route.metadata_source){const item=metadataItem(s.route.evidence_kind,s.route.evidence_id,s.route.evidence_mention),source=item?.sources?.[s.route.evidence_index];if(source?.available&&source.document_key===s.route.document_key)update({metadata_source:{title:s.route.evidence_kind==='mention'?'原名称记录：'+item.name:s.route.evidence_kind==='definition'?'定义来源：'+item.name:'处理依据',source}});}if(s.route.page==='reader'&&s.route.knowledge_id){const k=s.model.knowledgeById.get(s.route.knowledge_id),index=k?.sources.findIndex(src=>src.document_key===s.route.document_key)??-1;if(s.route.source_index===null&&index>=0)update({source_index:index});if(!s.route.block_id&&index>=0&&k.sources[index].block_ids.length)update({block_id:k.sources[index].block_ids[0],scroll_to_block:true});}if(s.route.page==='ontology'&&s.route.definition_id&&!s.route.ontology_kind){const d=s.model.definitionById.get(s.route.definition_id);if(d)update({ontology_kind:d.kind});}}
 async function render({preserve=true}={}){
  if(disposed)return;
  if(preserve)capture();if(!s.loading)normaliseRoute();disposeGraph();chatWorkspace?.detach();const epoch=++renderEpoch;s.hasReturn=nav.hasReturn();s.reviewBusy=usesSimplifiedReview()?Boolean(s.conflictBusy):reviewBusy.has(s.route.library_id);s.reviewPending=usesSimplifiedReview()?Boolean(storage?.getItem('lightog.conflict.pending.v1:'+s.route.library_id)):(s.route.library_id?reviewActions?.pending(s.route.library_id)??null:null);const reviewNotice=reviewNotices.get(s.route.library_id);s.reviewNotice=reviewNotice&&reviewNotice.revisionRef===s.model.library_state?.revision_ref?reviewNotice.text:null;s.reviewApplied=Boolean(s.reviewNotice&&reviewNotice.applied);syncQuery();syncAnalysis();s.visibleGraph=filterLightogGraph(s.graph,s.model,s.route.source_filter);root.innerHTML=lightogWorkspaceMarkup(s);
  const body=root.querySelector('[data-lw-document]');if(body)body.scrollTop=s.route.document_scroll??0;
  const detail=root.querySelector('[data-lw-inspector]');if(detail)detail.scrollTop=s.route.inspector_scroll??0;for(const [selector,key]of [['.lw-graph-main','list_scroll'],['.lw-reading-knowledge','reader_knowledge_scroll'],['.lw-definition-list','definition_scroll']]){const el=root.querySelector(selector);if(el)el.scrollTop=s.route[key]??0;}
  win.scrollTo?.({top:s.route.window_scroll??0,behavior:'instant'});if(s.route.page==='reader'&&s.route.scroll_to_block&&body){const paragraph=[...root.querySelectorAll('.lw-paragraph')].find(x=>x.dataset.id===s.route.block_id);if(paragraph){update({scroll_to_block:false});body.scrollTop+=paragraph.getBoundingClientRect().top-body.getBoundingClientRect().top-(body.clientHeight-paragraph.clientHeight)/2;}}
  if(chatMode&&s.route.page==='query'&&!s.loading){const target=root.querySelector('[data-lw-chat-host]');if(target)try{const workspace=await ensureChatWorkspace();if(disposed||epoch!==renderEpoch||!target.isConnected)return;await workspace.attach({host:target,libraryId:s.route.library_id,conversationId:s.route.conversation_id,queryRef:s.route.query_ref,turnId:s.route.chat_turn_id,memoryMode:memoryRoute(s.route).memory_mode,memoryRecordRef:memoryRoute(s.route).memory_record_ref,pin:queryCapabilities.get(s.route.library_id)?.scope});}catch(error){if(epoch===renderEpoch&&target.isConnected)target.innerHTML='<p class="lw-notice">对话暂未读回。'+esc(error.message)+'</p>';}return;}
  const target=root.querySelector('[data-lw-graph]');
  if(!target||!s.graph)return;
  try{
   tools??=await import('./assets/graph-view.mjs');if(epoch!==renderEpoch||disposed||!target.isConnected)return;
   graphView=tools.createGraphView(target,{id:s.graph.index_revision??s.run?.run_id??'domain'},{layoutKey:s.route.library_id+':'+(s.graph.index_revision??s.run?.run_id),labelTheme:'native-domain',edgeLabels:'auto',context:s.route.graph_context??null,projectionFactory:(_task,options)=>{const scene=projectNativeDomainGraph(s.visibleGraph,{focusId:options.focusId});if(s.model.knowledge_display){const refs=new Set(lightogSourceKnowledgeIds(s.model,s.route.source_filter)),members=s.model.knowledge.filter(row=>refs.has(row.id));scene.retained_claims=members.length;scene.claims=lightogDisplayKnowledgeRows(s.model,members).length;}return scene;},onSelect:(id,kind)=>{
    update({selection:id?{id,kind}:null,object_id:kind==='entity'?id:null,knowledge_id:null,sources_open:false,source_index:null});inspector();capture();
   }});
   if(s.route.knowledge_id)graphView.select(s.route.knowledge_id,'knowledge');else if(s.route.object_id)graphView.select(s.route.object_id,'entity');else if(s.route.selection?.kind==='relation')graphView.select(s.route.selection.id,'statement');
   if(s.route.locate_relation_pending){const edge=s.model.graph_data?.edges.get(s.route.selection?.id),result=edge?graphView.locate(edge.id,'statement',{focusId:edge.source}):{located:false};update({locate_relation_pending:false,temporary_location:result.temporary===true});root.querySelector('[data-lw-location-return]')?.toggleAttribute('hidden',!result.temporary);}
   if(s.route.locate_object_pending){const result=graphView.locate(s.route.object_id,'entity',{focusId:s.route.object_id});update({locate_object_pending:false,temporary_location:result.temporary===true});root.querySelector('[data-lw-location-return]')?.toggleAttribute('hidden',!result.temporary);}
   if(s.route.locate_pending){
    const version=s.route.version_location;
    update({locate_pending:false,version_location:null});
    let result;
    if(version){
     try{
      if(version.member_ref!==s.route.knowledge_id)throw Error('定位记录已变化，请重新核对当前版本。');
      const target=lightogVersionLocationTarget(s,version.member_ref,version.target_ref,{qualifiedRefs:version.qualified_member_refs});
      result=locateLightogKnowledgeTarget(graphView,target);
      update({knowledge_id:target.row.id,object_id:target.anchor.entity_ids[0]??null,selection:null,sources_open:false,source_index:null});inspector();
     }catch(error){toast(error.message);}
    }else{const k=lightogDisplayKnowledgeById(s.model,s.route.knowledge_id);result=k?graphView.locate(k.id,'knowledge',{focusId:k.entity_ids[0]}):{located:false};}
    if(result){update({temporary_location:result.temporary===true||Boolean(s.route.source_location_return)});root.querySelector('[data-lw-location-return]')?.toggleAttribute('hidden',!(result.temporary||s.route.source_location_return));if(!result.located)toast('此知识尚无可定位的图中关联。');}
   }
  }catch(error){const status=target.querySelector('[data-graph-status]');if(status)status.textContent='画布暂不可用，可切换知识列表继续阅读。';toast(error.message);}
 }
 async function artifact(kind,{id,run,docRef=null}={}){
  const items=[];let after=0,page;
  do{page=await api(runBase(id,run)+'/artifacts?kind='+kind+'&limit=100&after='+after+(docRef?'&doc_ref='+encodeURIComponent(docRef):''));items.push(...page.items??[]);if(!page.has_more)break;if(!Number.isSafeInteger(page.next_after)||page.next_after<=after)throw Error('资料分页位置无效，已停止继续读取');after=page.next_after;}while(true);
  return {...page,items,has_more:false};
 }
 async function loadLibrary(id,{renderLoading=true}={}){
  if(disposed||s.route.library_id!==id)return;
  const frame=s.route;syncPendingStart(id);const epoch=++loadEpoch,ownsRead=()=>!disposed&&epoch===loadEpoch&&s.route===frame&&s.route.library_id===id,previousState={view:s.view,run:s.run,graph:s.graph,artifacts:s.artifacts,model:s.model,currentMemoryView:s.currentMemoryView,currentMemoryBlocked:s.currentMemoryBlocked,memoryCurrentError:s.memoryCurrentError};s.loading=true;s.loadError=null;if(renderLoading)await render({preserve:false});try{
   if(!ownsRead())return;
   if(!id){s.view=null;s.run=null;s.graph=null;s.artifacts={};s.currentMemoryView=null;s.currentMemoryBlocked=false;s.memoryCurrentError=null;s.model=projectLightogReading();s.loading=false;return;}
   const previous=!memoryEnabled&&cachedLibrary(id);if(previous){Object.assign(s,previous);s.loading=false;return;}
   const [view,dto]=await Promise.all([api(base(id)+'/view'),readCurrentMemoryDto(id)]);if(!ownsRead())return;
   const application=pendingReviewApplication(id),runRows=view.native_full_chain?.runs??[],runRow=application?(runRows.find(row=>row.run_id===application.run_id)??{run_id:application.run_id}):runRows[0],run=await readRun(id,runRow);
   let graph=null,artifacts={};
   if(run){
    const reads=await Promise.allSettled([artifact('documents',{id,run:run.run_id}),dto===null?api(runBase(id,run.run_id)+'/graph?view=EXTRACTED_KNOWLEDGE'):Promise.resolve(null)]);
    if(reads[0].status==='fulfilled')artifacts.documents=reads[0].value;
    if(reads[1].status==='fulfilled')graph=reads[1].value;
    const docs=artifacts.documents?.items??[],blocks=await Promise.allSettled(docs.map(d=>artifact('blocks',{id,run:run.run_id,docRef:d.doc_ref})));
    artifacts.blocks=blocks.flatMap(x=>x.status==='fulfilled'?[x.value]:[]);
   }
   const currentMemoryView=await projectCurrentMemory(dto,id,artifacts,view.library?.sources??[]);if(!ownsRead())return;
   Object.assign(s,{view,run,graph,artifacts,currentMemoryView,currentMemoryBlocked:false,memoryCurrentError:null,loading:false});const pending=syncPendingStart(id);if(pending?.status==='START_CONFIRMED'&&pending.run_id===run?.run_id)clearPending(id,pending.request_id);project();if(memoryEnabled&&!currentMemoryView&&s.model.library_state?.status==='MISMATCH')throw Object.assign(Error('旧批次状态与图谱未对齐，未将其作为当前知识。'),{code:'MEMORY_CURRENT_VIEW_LEGACY_MISMATCH'});cacheLibrary(id,{view,run,graph:s.graph,artifacts,model:s.model,currentMemoryView,currentMemoryBlocked:false,memoryCurrentError:null});
  }catch(error){if(!ownsRead())return;if(previousState.view?.library?.id===id)Object.assign(s,previousState);else Object.assign(s,{view:null,run:null,graph:null,artifacts:{},model:projectLightogReading(),currentMemoryView:null});s.loading=false;if(memoryEnabled)currentReadFailed(id,error,previousState.currentMemoryView);else s.loadError=error.message;throw error;}
 }
 async function show(frame){
  const needsLibrary=['graph','sources','reader','ontology','pending','query'].includes(frame.page),changed=needsLibrary&&(frame.library_id!==s.route.library_id||frame.library_id&&!s.view);
  ++loadEpoch;++reviewReadEpoch;++queryEpoch;s.loading=false;s.reviewLoading=false;s.reviewPreviewLoading=false;if(frame.library_id!==s.route.library_id){Object.assign(s,{view:null,run:null,graph:null,artifacts:{},model:projectLightogReading(),currentMemoryView:null,currentMemoryBlocked:false,memoryCurrentError:null,loadError:null,review:null,reviewError:null,reviewPreview:null,reviewApplicationState:null,reviewTargetSelection:null,reviewTargetNotice:null});}
  disposeGraph();s.route=frame;syncPendingStart(frame.library_id);if(changed){try{await loadLibrary(frame.library_id);}catch(error){if(s.route===frame)toast(error.message);}}if(disposed||s.route!==frame)return;if(frame.page==='pending'){await loadReview();if(disposed||s.route!==frame)return;}if(frame.page==='query'){await loadQuery();if(disposed||s.route!==frame)return;}await restoreQuerySource(frame);if(disposed||s.route!==frame)return;await render({preserve:false});if(s.route!==frame)return;if(s.route.page==='reader'&&s.route.scroll_to_block){const target=[...root.querySelectorAll('.lw-paragraph')].find(x=>x.dataset.id===s.route.block_id);const scroller=root.querySelector('[data-lw-document]');if(target&&scroller){update({scroll_to_block:false});scroller.scrollTop+=target.getBoundingClientRect().top-scroller.getBoundingClientRect().top-(scroller.clientHeight-target.clientHeight)/2;win.scrollTo?.({top:s.route.window_scroll??0,behavior:'instant'});capture();}}
 }
 function go(frame){capture();return nav.go(frame);}
 function page(page){go({library_id:s.route.library_id,page,display:'canvas'});}
 function selectKnowledge(id){
  const k=s.model.knowledgeById.get(id);if(!k)return;
  const patch={knowledge_id:id,sources_open:false,source_index:null};
  if(s.route.page==='reader'){
   const sourceIndex=k.sources.findIndex(src=>src.document_key===s.route.document_key),source=k.sources[sourceIndex];patch.source_index=sourceIndex>=0?sourceIndex:null;if(source?.block_ids.length){patch.block_id=source.block_ids[0];patch.scroll_to_block=source.block_ids[0]!==s.route.block_id;}
   update(patch);void render();
  }else{update(patch);graphView?.select(id,'knowledge');inspector();capture();}
 }
 function openMemorySource(source){
  if(source?.kind!=='MEMORY_RECORD_SOURCE')return false;
  if(!memoryEnabled||source.available!==true||source.document_evidence_eligible!==false||!/^[A-Za-z0-9_-]{1,160}$/.test(source.record_ref??'')||typeof source.revision!=='string'||!source.revision||!['DOCUMENT','HUMAN_TEXT','AGENT_REPORT','TOOL_RECEIPT'].includes(source.source_kind))throw Error('此原始记录版本尚未确认可读，未替用文档或最新版本。');
  go({library_id:s.route.library_id,page:'query',memory_mode:'records',memory_record_ref:source.record_ref});return true;
 }
 async function click(event){
  const el=event.target.closest('[data-lw-action]');if(!el||el.disabled||s.uploading)return;const action=el.dataset.lwAction;
  try{
   if(action==='conflict-select'){s.conflictItemRef=el.dataset.item;update({pending_item_id:el.dataset.item});s.conflictApplication=null;s.reviewPreview=null;await render();}
   else if(action==='conflict-status'){const frame=s.route,context=reviewContext(),saved=JSON.parse(storage.getItem('lightog.conflict.pending.v1:'+context.libraryId)??'null'),applicationRef=saved?.body?.application_ref;if(!applicationRef||applicationRef!==el.dataset.application)throw Error('原应用标识尚未读回。');const result=await conflictRequest({operation:'confirm',application_ref:applicationRef},{readOnly:true});if(result.status!=='APPLIED'||result.application_ref!==applicationRef||!result.readback?.verified)throw Error('原应用尚未确认；未重新提交。');storage.removeItem('lightog.conflict.pending.v1:'+context.libraryId);if(s.route!==frame)return;s.reviewPending=false;s.conflictPendingApplicationRef=null;clearCache(context.libraryId);await loadLibrary(context.libraryId);await loadReview();s.conflictNotice='原应用结果已确认；当前版本以本次读回为准。';await render();}
   else if(action==='conflict-preview'){await prepareConflict();await render();}
   else if(action==='conflict-apply'){const frame=s.route,context=reviewContext(),prepared=s.conflictPrepared;if(!prepared||prepared.application.application_ref!==el.dataset.application)throw Error('当前应用与影响预览不匹配。');const result=await conflictRequest({operation:'apply',application_ref:el.dataset.application,expected_binding:prepared.expected_binding});if(result.status!=='APPLIED'||!result.readback?.verified||result.application_ref!==prepared.application.application_ref||result.prepared_sha256!==prepared.prepared?.record_sha256||!['knowledge_revision_ref','graph_revision_ref','source_index_revision','knowledge_index_revision'].every(key=>typeof prepared.prepared?.bindings?.[key]==='string'&&result.readback.bindings?.[key]===prepared.prepared.bindings[key]))throw Error('局部更新结果尚未确认。');if(s.route!==frame||reviewContext()?.revisionRef!==context.revisionRef)return;s.conflictNotice='局部更新已读回；旧版本和来源保留。';s.conflictDecision=null;s.conflictPrepared=null;s.conflictApplication=null;s.reviewPreview=null;clearCache(s.route.library_id);await loadLibrary(context.libraryId);if(s.model.library_knowledge?.revision_ref!==result.readback.bindings.knowledge_revision_ref)throw Error('更新已确认，但当前页面版本尚未读回，请刷新结果。');await loadReview();await render();}
   else if(action==='conflict-revoke'){const frame=s.route,context=reviewContext(),prepared=await conflictRequest({operation:'revoke',application_ref:el.dataset.application,request_id:crypto.randomUUID(),reason:'用户在处理历史中请求撤回',created_at:new Date().toISOString()});if(s.route!==frame||reviewContext()?.revisionRef!==context.revisionRef)return;s.conflictPrepared=prepared;s.conflictApplication=prepared.application;s.reviewPreview=prepared;await render();}
   else if(action==='conflict-source'){const item=s.conflictReview?.items.find(i=>i.item_ref===el.dataset.item),side=item?.comparison?.sides.find(x=>x.object_ref===el.dataset.side),knowledge=s.model.knowledgeById.get(side?.object_ref),selectedEvidence=side?.evidence?.find(e=>(e.evidence_ref??e.id)===el.dataset.evidence),target=selectedEvidence??side?.source_refs?.find(r=>r.doc_ref===el.dataset.source&&r.revision===el.dataset.revision),source=target&&knowledge?.sources?.find(x=>x.available&&x.doc_ref===target.doc_ref&&x.revision===target.revision);if(!source)throw Error('当前来源版本未读回，未跳转到其他候选。');go({library_id:s.route.library_id,page:'reader',document_key:source.document_key,block_id:source.block_ids[0]??null,knowledge_id:knowledge.id,sources_open:true,reader_scope:source.block_ids.length?'paragraph':'all',scroll_to_block:true});}
   else if(action==='page')page(el.dataset.page);
   else if(action==='library')go({library_id:el.dataset.id,page:'graph',display:'canvas'});
   else if(action==='pg-libraries'||action==='new-library'&&openPg)openPg();
   else if(action==='new-library')go({library_id:null,page:'upload'});
   else if(action==='back'){capture();nav.back();}
   else if(action==='document')go({library_id:s.route.library_id,page:'reader',document_key:el.dataset.key});
   else if(action==='paragraph'){
    if(event.target.closest('a,button')&&event.target!==el)return;
    update({block_id:el.dataset.id,knowledge_id:null,source_index:null,sources_open:false});await render();
   }
   else if(action==='knowledge')selectKnowledge(el.dataset.id);
   else if(action==='knowledge-correct'){
    if(!s.model.knowledgeById.has(el.dataset.id)||!reviewContext())throw Error('当前知识版本尚未完整读回。');
    await go({library_id:s.route.library_id,page:'pending',knowledge_id:el.dataset.id,review_scope:'all'});
    const item=s.review?.items?.find(row=>row.kind==='KNOWLEDGE'&&row.knowledge_ids.includes(el.dataset.id));
    if(!item)throw Error('此知识的修订事项尚未读回，未提交任何修改。');
    update({pending_item_id:item.id});await render();
   }
   else if(action==='knowledge-identity-review'){
    if(!s.model.knowledgeById.has(el.dataset.id)||!reviewContext())throw Error('当前知识版本尚未完整读回。');
    await go({library_id:s.route.library_id,page:'pending'});
    const item=s.review?.items?.find(row=>row.kind==='IDENTITY'&&row.knowledge_ids.includes(el.dataset.id));
    if(item){update({pending_item_id:item.id,review_scope:'all'});await render();}
    else toast('本版没有与该对象关联的身份疑点；原名称与知识继续保留。');
   }
   else if(action==='correction-original-source'){
    const k=s.model.knowledgeById.get(el.dataset.id),source=k?.original_sources?.[Number(el.dataset.index)];
    if(!source?.available)throw Error('修订前原依据的版本尚不可读。');if(openMemorySource(source))return;
    await go({library_id:s.route.library_id,page:'reader',document_key:source.document_key,block_id:source.block_ids[0]??null,reader_scope:source.block_ids.length?'paragraph':'all',scroll_to_block:Boolean(source.block_ids.length),metadata_source:{title:'修订前原依据（仅供对照）',source}});
   }
   else if(action==='object'){go({...s.route,selection:{id:el.dataset.id,kind:'entity'},object_id:el.dataset.id,knowledge_id:null,sources_open:false,source_index:null});}
   else if(action==='clear-selection'){update({selection:null,object_id:null,knowledge_id:null,sources_open:false});graphView?.select(null);inspector();capture();}
   else if(action==='close-fact'){update({knowledge_id:null,sources_open:false});if(s.route.page==='reader')await render();else{if(s.route.object_id)graphView?.select(s.route.object_id,'entity');inspector();}}
   else if(action==='identity-knowledge')go({library_id:s.route.library_id,page:'graph',display:'list',knowledge_id:el.dataset.id});
   else if(action==='query-refresh')await queryOperation('read');
   else if(action==='query-cancel')await queryOperation('cancel');
   else if(action==='query-close-citation'){queryCitations.delete(s.route.library_id);renderQuery();}
   else if(action==='query-citation'){
    const id=s.route.library_id,frame=s.route,actions=await ensureQueryActions(),q=actions.current(id),queryRef=q?.query_ref;if(!queryRef||queryBusy.has(id))return;
    queryBusy.add(id);queryErrors.delete(id);renderQuery();
    try{const response=await actions.citation({libraryId:id,queryRef,citationRef:el.dataset.ref});if(response.status!=='READY')throw Error(response.error?.message??'此引用尚未读回，未使用其他来源。');const module=await import('./lightog-query-citations-v1.mjs');if(disposed||s.route!==frame||actions.current(id)?.query_ref!==queryRef)return;const citation=module.projectLightogQueryCitation(response.citation,s.model,{historical:q.historical||response.historical||!queryScopeMatches(q.source_scope??q.pin)});queryCitations.set(id,{...citation,query_ref:queryRef});}
    catch(error){queryErrors.set(id,error.message||'引用依据暂未读回。');}
    finally{queryBusy.delete(id);if(!disposed&&s.route===frame)renderQuery();}
   }
   else if(action==='query-source'){
    syncQuery();const citation=s.queryCitation,source=citation?.sources?.[Number(el.dataset.index)];if(!source?.available)throw Error('此来源版本暂不可读，没有替用其他版本。');
    go({library_id:s.route.library_id,page:'reader',document_key:source.document_key,block_id:source.block_ids[0]??null,reader_scope:source.block_ids.length?'paragraph':'all',scroll_to_block:Boolean(source.block_ids.length),metadata_source:{title:'回答依据：'+citation.label,source},query_ref:citation.query_ref,query_citation_ref:citation.id,query_source_index:Number(el.dataset.index)});
   }
   else if(action==='query-return'){if(chatMode){go({...memoryRoute(s.route),library_id:s.route.library_id,page:'query',conversation_id:s.route.conversation_id,query_ref:s.route.query_ref,chat_turn_id:s.route.chat_turn_id});return;}const actions=await ensureQueryActions();if(actions.current(s.route.library_id)?.query_ref!==s.route.query_ref)throw Error('原查询尚未读回，没有换用其他回答。');page('query');}
   else if(['query-knowledge','query-object','query-relation'].includes(action)){
    syncQuery();const c=s.queryCitation,id=el.dataset.id,key=action==='query-knowledge'?'knowledge_ids':action==='query-object'?'entity_ids':'relation_ids';if(!c||action!=='query-knowledge'&&!c.graph_available||s.query.historical||!queryScopeMatches(s.query.source_scope??s.query.pin)||!c[key]?.includes(id))throw Error('此引用不属于当前图版本，不能替换为当前图中的其他记录。');
    const previous=lastGraph?.library_id===s.route.library_id?lastGraph:{};
    const knowledge=action==='query-knowledge'?s.model.knowledgeById.get(id):null,anchored=Boolean(knowledge&&(knowledge.entity_ids.length||knowledge.relation_ids.length));
    go({...previous,library_id:s.route.library_id,page:'graph',display:knowledge&&!anchored?'list':'canvas',source_filter:null,search:'',definition_filter:null,knowledge_id:action==='query-knowledge'?id:null,object_id:action==='query-object'?id:null,selection:action==='query-relation'?{id,kind:'relation'}:action==='query-object'?{id,kind:'entity'}:null,locate_pending:action==='query-knowledge'&&anchored,locate_object_pending:action==='query-object',locate_relation_pending:action==='query-relation'});
   }
   else if(action==='metadata-source'){
    const id=el.dataset.id,kind=el.dataset.kind,index=Number(el.dataset.index),mention=Number.isInteger(Number(el.dataset.mention))?Number(el.dataset.mention):null,item=metadataItem(kind,id,mention);
    const source=item?.sources?.[index];if(!source?.available)throw Error('这个来源版本暂不可读');if(openMemorySource(source))return;
    go({library_id:s.route.library_id,page:'reader',document_key:source.document_key,block_id:source.block_ids[0]??null,reader_scope:source.block_ids.length?'paragraph':'all',scroll_to_block:Boolean(source.block_ids.length),evidence_kind:kind,evidence_id:id,evidence_index:index,evidence_mention:mention,metadata_source:{title:kind==='mention'?'原名称记录：'+item.name:kind==='definition'?'定义来源：'+item.name:'处理依据',source}});
   }
   else if(action==='sources-toggle'){update({sources_open:!s.route.sources_open});if(s.route.page==='reader')await render();else inspector();}
   else if(action==='source-select'){const selected=s.model.knowledgeById.get(s.route.knowledge_id)?.sources?.[Number(el.dataset.index)];if(openMemorySource(selected))return;update({source_index:Number(el.dataset.index)});if(s.route.page==='reader')await render();else inspector();}
   else if(action==='display'){update({display:el.dataset.mode});await render();}
   else if(action==='knowledge-list'){go({library_id:s.route.library_id,page:'graph',display:'list'});}
   else if(action==='open-source'){
    const k=s.model.knowledgeById.get(el.dataset.knowledge),index=Number(el.dataset.index),source=k?.sources[index];if(!source?.available)throw Error('这个资料版本暂不可读');if(openMemorySource(source))return;
    go({library_id:s.route.library_id,page:'reader',document_key:source.document_key,block_id:source.block_ids[0]??null,knowledge_id:k.id,source_index:index,sources_open:true,reader_scope:source.block_ids.length?'paragraph':'all',scroll_to_block:true});
   }
   else if(action==='reader-scope'){update({reader_scope:el.dataset.scope,knowledge_id:null});await render();}
   else if(action==='locate-version'){
    const memberId=el.dataset.id,targetId=el.dataset.target;
    if(s.route.knowledge_id!==memberId)throw Error('当前记录已变化，请重新选择定位入口。');
    const target=lightogVersionLocationTarget(s,memberId,targetId);
    if(s.route.page==='graph'&&graphView){
     const result=locateLightogKnowledgeTarget(graphView,target);
     update({knowledge_id:targetId,object_id:target.anchor.entity_ids[0]??null,selection:null,sources_open:false,source_index:null,temporary_location:result.temporary===true});
     root.querySelector('[data-lw-location-return]')?.toggleAttribute('hidden',!result.temporary);inspector();capture();
    }else{
     const qualified=lightogKnowledgeScopeRows(s).map(row=>row.id);
     go({...memoryRoute(s.route),library_id:s.route.library_id,page:'graph',display:'canvas',source_filter:s.route.source_filter??null,definition_filter:s.route.definition_filter??null,search:s.route.search??'',knowledge_id:memberId,object_id:null,selection:null,graph_context:null,locate_pending:true,version_location:{member_ref:memberId,target_ref:targetId,qualified_member_refs:qualified}});
    }
   }
   else if(action==='locate'){
    const k=lightogDisplayKnowledgeById(s.model,el.dataset.id);if(!k?.entity_ids.length&&!k?.relation_ids.length)throw Error('尚未形成图中关联');
    if(s.route.page==='graph'&&s.route.source_filter&&!lightogKnowledgeHasGraphAnchor(s.visibleGraph,k.id)){capture();const prior=nav.current();update({source_location_return:prior,source_filter:null,graph_context:null,display:'canvas',locate_pending:true});await render({preserve:false});}
    else if(s.route.page==='graph'&&graphView){const result=graphView.locate(k.id,'knowledge',{focusId:k.entity_ids[0]});if(!result.located)throw Error('此知识尚无可定位的图中关联。');update({temporary_location:result.temporary===true});root.querySelector('[data-lw-location-return]')?.toggleAttribute('hidden',!result.temporary);capture();}
    else {const previous=lastGraph?.library_id===s.route.library_id?lastGraph:null,hidden=previous?.source_filter&&!lightogSourceKnowledgeIds(s.model,previous.source_filter).includes(k.id);go({...previous,...(hidden?{source_location_return:previous,source_filter:null,graph_context:null}:{}),library_id:s.route.library_id,page:'graph',display:'canvas',knowledge_id:k.id,object_id:k.entity_ids[0]??null,locate_pending:true});}
   }
   else if(action==='restore-location'){if(s.route.source_location_return){const before=s.route.source_location_return,returnTo=s.route.return_to;s.route={...before,source_location_return:null,temporary_location:false,return_to:returnTo};nav.replace(s.route);await render({preserve:false});return;}graphView?.restoreLocation();update({temporary_location:false});root.querySelector('[data-lw-location-return]')?.setAttribute('hidden','');capture();}
   else if(action==='neighborhood'){const result=graphView?.focus(el.dataset.id);if(!result?.focused)toast('当前图中没有可展开的对象');capture();}
   else if(action==='definition'){const d=s.model.definitionById.get(el.dataset.id);if(d)go({library_id:s.route.library_id,page:'ontology',definition_id:d.id,ontology_kind:d.kind});}
   else if(action==='definition-select'){update({definition_id:el.dataset.id});await render();}
   else if(action==='ontology-scope'){update({ontology_scope:el.dataset.scope,definition_id:null});await render();}
   else if(action==='pending-open-ontology'){const item=s.model.pending_classification?.entries.find(row=>row.id===el.dataset.id);go({library_id:s.route.library_id,page:'ontology',ontology_scope:'pending',definition_id:item?.definition_id??null,ontology_kind:item?.ontology_kind??null});}
   else if(action==='pending-show-system'){update({pending_item_id:null});s.conflictItemRef=null;await render();}
   else if(action==='pending-select'){update({pending_item_id:el.dataset.id,knowledge_id:null});await render();}
   else if(action==='review-scope'){update({review_scope:el.dataset.scope,pending_item_id:null,knowledge_id:null});await render();}
   else if(action==='refresh-review'){const frame=s.route;await loadReview();if(s.route===frame)await render();}
   else if(action==='review-preview')await previewReview();
   else if(action==='review-analysis-start')await analysisOperation('start',el.dataset.id);
   else if(action==='review-analysis-read')await analysisOperation('read',el.dataset.id);
   else if(action==='review-apply')await submitReview('APPLICATION');
   else if(action==='ontology-kind'){update({ontology_kind:el.dataset.kind,definition_id:null});await render();}
   else if(action==='definition-object')go({...(lastGraph?.library_id===s.route.library_id?lastGraph:{}),library_id:s.route.library_id,page:'graph',display:'canvas',object_id:el.dataset.id,selection:{id:el.dataset.id,kind:'entity'},knowledge_id:null,locate_object_pending:true});
   else if(action==='definition-knowledge')go({library_id:s.route.library_id,page:'graph',display:'list',definition_filter:el.dataset.id});
   else if(action==='definition-filter-clear'){update({definition_filter:null});await render();}
   else if(action==='start-saved'||action==='resume-run'){
    const frame=s.route,id=frame.library_id,resume=action==='resume-run',source=s.run,ownsFrame=()=>!disposed&&s.route===frame;
    if(s.starting||syncPendingStart(id))throw Error('整理启动结果待确认，请先核对状态；不会重复提交。');
    if(resume){
     const state=lightogResumeState(source,s.models);
     if(!state.enabled||el.dataset.run!==source?.run_id)throw Error(state.reason||'当前整理状态不能继续，请重新读取状态。');
    }else if(source||!s.view?.native_full_chain?.registration||!s.models?.generation?.configured)throw Error('请先确认资料整理状态与模型配置');
    const command=lightogBuildCommand({requestId:crypto.randomUUID(),embedding:s.models.embedding?.configured===true,...(resume?{resumeFromRunId:source.run_id,capability:source.capability}:{})});
    s.starting=true;s.uploadNotice=null;s.uploadNoticeActiveRunOnly=false;rememberPending({library_id:id,request_id:command.request_id,status:'START_RESULT_UNCONFIRMED',...(resume?{resume_from_run_id:source.run_id}:{})});await render();
    let accepted=false;
    try{
     const run=confirmLightogRun(await api(base(id)+'/native-full-chain/runs',command),id,{resumeFromRunId:command.resume_from_run_id??null});
     accepted=true;rememberPending({library_id:id,request_id:command.request_id,status:'START_CONFIRMED',run_id:run.run_id,...(resume?{resume_from_run_id:source.run_id}:{})});clearCache(id);
     if(ownsFrame()){await loadLibrary(id);if(ownsFrame()){s.uploadNotice=resume?'已开始继续整理；此前未完成的记录与已保存结果保留。':'资料已保存，后台会继续整理知识。';s.uploadNoticeActiveRunOnly=true;}}
    }catch(error){
     if(!accepted&&Number.isInteger(error.status)&&error.status>=400&&error.status<500&&error.status!==408)clearPending(id,command.request_id);
     if(ownsFrame()){s.uploadNotice=(accepted?'整理请求已提交，最新状态暂未读回；不会重复启动：':'资料和此前记录仍保留；请先核对整理请求状态：')+error.message;s.uploadNoticeActiveRunOnly=false;toast(s.uploadNotice);}
    }finally{s.starting=false;if(ownsFrame())await render();}
   }
   else if(action==='refresh-results'){const frame=s.route;clearCache(frame.library_id);capture();await loadLibrary(frame.library_id);if(s.route===frame&&frame.page==='pending')await loadReview();if(s.route===frame&&frame.page==='query')await loadQuery();if(s.route===frame)await render({preserve:false});}
  }catch(error){toast(error.message);if(!s.loading)await render({preserve:false});}
  if(s.route.page==='reader'&&s.route.scroll_to_block){const target=[...root.querySelectorAll('.lw-paragraph')].find(x=>x.dataset.id===s.route.block_id);const scroller=root.querySelector('[data-lw-document]');if(target&&scroller){update({scroll_to_block:false});scroller.scrollTop+=target.getBoundingClientRect().top-scroller.getBoundingClientRect().top-(scroller.clientHeight-target.clientHeight)/2;win.scrollTo?.({top:s.route.window_scroll??0,behavior:'instant'});capture();}}
 }
 async function submit(event){
  const form=event.target;if(!form.matches('[data-lw-upload-form],[data-lw-model-form],[data-lw-review-form],[data-lw-conflict-form],[data-lw-query-form]'))return;event.preventDefault();
  if(form.matches('[data-lw-conflict-form]')){const frame=s.route,context=reviewContext();try{const cap=s.conflictReview?.backend_capabilities,qualified=qualifyPendingConflictReview(s.conflictReview,s.model,{writable:cap?.writable===true&&cap.mode==='NATIVE_PRODUCT'&&!s.reviewLoading&&!s.reviewError,supportedKinds:cap?.supported_kinds??[],supportedActions:cap?.supported_actions??[]}),item=qualified.items.find(i=>i.item_ref===form.dataset.item);if(!item?.readiness.can_decide||!item.allowed_actions.includes(form.elements.action.value))throw Error('本项尚未具备可提交的双方依据与后端操作能力。');const action=form.elements.action.value,interval=side=>({kind:'INTERVAL',valid_from:{kind:'KNOWN',value:form.elements[side+'_valid_from'].value,precision:'SECOND'},valid_to:{kind:'KNOWN',value:form.elements[side+'_valid_to'].value,precision:'SECOND'}});const body={operation:'decide',request_id:crypto.randomUUID(),item_ref:item.item_ref,action,reason:form.elements.reason.value,selected_ref:form.elements.selected_ref.value||null,created_at:new Date().toISOString(),...(action==='reality_change'?{valid_times:{[item.comparison.sides[0].object_ref]:interval('left'),[item.comparison.sides[1].object_ref]:interval('right')}}:{})};const saved=await conflictRequest(body);if(s.route!==frame||reviewContext()?.revisionRef!==context.revisionRef)return;s.conflictDecision=saved.decision;await prepareConflict();s.conflictNotice='决定已保存；请核对局部影响后应用。';await render();}catch(error){toast(error.message);await render();}return;}
  if(form.matches('[data-lw-query-form]')){const question=form.elements.question.value.trim();queryDrafts.set(s.route.library_id,question);if(question)await queryOperation('start',question);return;}
  if(form.matches('[data-lw-review-form]')){try{
   const action=form.elements.action.value,item=s.review?.items?.find(row=>row.id===form.dataset.item);
   const correction=item?.kind==='KNOWLEDGE'&&action==='replace'?lightogCorrectionFromForm(form,item.record.knowledge):undefined;
   let definitionResolution;
   if(item?.kind==='DEFINITION'&&['unify','keep_separate'].includes(action)){
    const comparisonRef=form.elements.definition_comparison?.value??(item.comparisons.length===1?item.comparisons[0].comparison_ref:null),comparison=item.comparisons.find(row=>row.comparison_ref===comparisonRef);
    if(!comparison||comparison.binding_status!=='BOUND')throw Error('请选择本项实际已绑定的比较双方。');
    definitionResolution={comparison_ref:comparison.comparison_ref};
    if(action==='unify'){const selected=form.elements.selected_definition_ref?.value;if(!safeDefinitionTarget(item,comparison.comparison_ref,selected))throw Error('请选择当前比较中已开放的安全定义目标；未自动替换为另一方。');definitionResolution.selected_definition_ref=selected;}
   }
   await submitReview('DECISION',{itemRef:form.dataset.item,action,reason:form.elements.reason.value,...(correction?{correction}:{}),...(definitionResolution?{definitionResolution}:{})});
  }catch(error){toast(error.message);}return;}
  if(form.matches('[data-lw-model-form]')){
   const role=form.dataset.role,key=form.elements.key;try{await api('/api/product/models/'+role,{enabled:true,base_url:form.elements.url.value.trim(),model:form.elements.model.value.trim(),api_key:key.value,protocol:form.elements.protocol.value,...(role==='embedding'?{dimensions:Number(form.elements.dimensions.value)}:{})});key.value='';s.models=await api('/api/product/models');toast('模型配置已保存');await render();}catch(error){key.value='';toast(error.message);}return;
  }
  if(s.uploading)return;if(s.starting||syncPendingStart(s.route.library_id)){s.uploadNotice='整理启动结果待确认，已暂停重复提交。请保留已保存资料，先核对状态。';s.uploadNoticeActiveRunOnly=false;toast(s.uploadNotice);await render();return;}const files=[...form.elements.files.files],name=form.elements['library-name'].value,libraryId=s.route.library_id;
  s.uploading=true;s.uploadNotice=null;s.uploadNoticeActiveRunOnly=false;
  const progress=message=>{s.uploadProgress=message;const target=root.querySelector('[data-lw-upload-progress]');if(target)target.textContent=message;};
  try{
   const result=await submitLightogDocuments({files,name,libraryId,api,models:s.models,uuid:()=>crypto.randomUUID(),upload:async file=>{const response=await fetch('/api/documents',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-CQForge-Token':boot.token,'X-CQForge-Filename':encodeURIComponent(file.name)},body:file});const body=await response.json();if(!response.ok)throw Object.assign(Error(body.error??'资料读取失败'),{status:response.status});return body;},onProgress:p=>{s.uploadDraft={...(s.uploadDraft??{}),...p};setLocal('lightog.upload-receipt.v1',JSON.stringify(s.uploadDraft));if(p.step==='reading')progress('正在读取 '+p.title+'（'+(p.index+1)+'/'+p.total+'）');else if(p.step==='saving')progress('正在保存资料…');else if(p.step==='organizing'){rememberPending({library_id:p.library_id,request_id:p.request_id,status:'START_RESULT_UNCONFIRMED'});progress('资料已保存，正在启动知识整理…');}},onSaved:async({library_id})=>{s.boot=await api('/api/bootstrap');clearCache(library_id);await go({library_id,page:'sources'});}});
   const messages={SAVED_CONFIGURATION_REQUIRED:'资料已保存。请在设置中配置整理模型。',START_RESULT_UNCONFIRMED:'资料已保存，整理启动结果尚未确认；请查看批次状态，不要重复上传。',STARTED:'资料已保存，后台会连续整理知识与图谱。',PARTIAL_UPLOAD_SAVED:'部分原件已保存，其余资料未读取成功。已保存的文件句柄保留，请勿重复上传。',UPLOAD_REJECTED:'资料读取未成功，已保存的原件句柄保留。',UPLOAD_RESULT_UNCONFIRMED:'资料读取结果待确认，请勿重复上传。',SAVE_REJECTED:'原件已保存，加入知识库的请求被拒绝。',PARTIALLY_REGISTERED:'部分资料已加入知识库，其余资料尚未确认。',SAVE_RESULT_UNCONFIRMED:'原件已保存，加入知识库的结果待确认，请勿重复提交。',START_REJECTED:'资料已保存，知识整理尚未启动。'};
   s.uploadNotice=(messages[result.status]??'资料处理状态已保留。')+(result.error?' '+result.error:'');s.uploadNoticeActiveRunOnly=result.status==='STARTED';s.uploadResult=result;
   setLocal('lightog.upload-receipt.v1',JSON.stringify(result));if(result.status==='STARTED')rememberPending({library_id:result.library_id,request_id:result.request_id,status:'START_CONFIRMED',run_id:result.run.run_id});else if(result.status!=='START_RESULT_UNCONFIRMED')clearPending(result.library_id??libraryId,result.request_id);
   if(result.library_id){clearCache(result.library_id);await loadLibrary(result.library_id);if(s.route.library_id!==result.library_id)await go({library_id:result.library_id,page:'sources'});else update({page:'sources'});}

  }catch(error){toast(error.message);progress(error.message);}finally{s.uploading=false;await render({preserve:false});}
 }
 let searchTimer;
 const input=event=>{if(event.target.id==='lw-question'){queryDrafts.set(s.route.library_id,event.target.value);return;}if(event.target.id!=='lw-search')return;const text=event.target.value;update({search:text});clearTimeout(searchTimer);searchTimer=setTimeout(()=>{const position=event.target.selectionStart;void render().then(()=>{const search=root.querySelector('#lw-search');search?.focus();search?.setSelectionRange(position,position);});},180);};
 const change=event=>{
  if(event.target.id==='lw-source-filter'){capture();update({source_filter:event.target.value||null,graph_context:null});void render({preserve:false});return;}
  const form=event.target.closest?.('[data-lw-review-form]');
  if(form&&event.target.name==='action'){
   const item=s.review?.items?.find(row=>row.id===form.dataset.item),capability=item?.action_capabilities.find(row=>row.action===event.target.value);
   if(form.elements.reason)form.elements.reason.required=capability?.requires_reason===true;
   if(form.elements.selected_definition_ref)form.elements.selected_definition_ref.required=event.target.value==='unify';
  }
  if(form&&event.target.name==='selected_definition_ref'){
   const item=s.review?.items?.find(row=>row.id===form.dataset.item),comparisonRef=form.elements.definition_comparison?.value??(item?.comparisons.length===1?item.comparisons[0].comparison_ref:null),selected=event.target.value;
   s.reviewTargetSelection=selected&&safeDefinitionTarget(item,comparisonRef,selected)?{item_id:item.id,comparison_ref:comparisonRef,definition_ref:selected}:null;
   s.reviewTargetNotice=selected&&!s.reviewTargetSelection?'此目标在当前比较中尚未开放，请重新选择；未自动替换为另一方。':null;
   if(selected&&!s.reviewTargetSelection)event.target.value='';
  }
  if(form&&event.target.name==='definition_comparison'){
   const item=s.review?.items?.find(row=>row.id===form.dataset.item),previous=form.elements.selected_definition_ref?.value??s.reviewTargetSelection?.definition_ref,comparisonRef=event.target.value;
   s.reviewDraft={item_id:form.dataset.item,action:form.elements.action?.value??'',reason:form.elements.reason?.value??''};s.reviewComparisonRef=comparisonRef;
   if(previous&&safeDefinitionTarget(item,comparisonRef,previous)){s.reviewTargetSelection={item_id:item.id,comparison_ref:comparisonRef,definition_ref:previous};s.reviewTargetNotice=null;}
   else {s.reviewTargetSelection=null;if(previous)s.reviewTargetNotice='比较对象已切换，原目标在本次比较中不再安全，请重新选择；未自动替换为另一方。';}
   void render();
  }
 };
 const pop=event=>{capture();if(!nav.pop(event)){void show(parseLightogLink(win.location.hash,{memoryEnabled}));}};
 function currentUpdateNotice(message){
  let notice=root.querySelector('[data-lw-new-results]');if(!notice){notice=doc.createElement('div');notice.className='lw-update-notice';notice.setAttribute('data-lw-new-results','');root.querySelector('.lw-main')?.prepend(notice);}
  notice.innerHTML=esc(message)+' <button class="lw-button" data-lw-action="refresh-results">查看最新结果</button>';
 }
 async function poll(){
  if(pollBusy||disposed||!s.route.library_id||s.uploading||s.loading)return;pollBusy=true;const id=s.route.library_id,runId=s.run?.run_id,frame=s.route,prior=s.currentMemoryView,returnToken=memoryReturnEpoch,loadToken=loadEpoch,owns=()=>!disposed&&returnToken===memoryReturnEpoch&&loadToken===loadEpoch&&s.route===frame&&s.route.library_id===id;
  try{
   if(frame.page==='pending'&&reviewActions?.pending(id)?.kind==='APPLICATION'){await loadReview();if(!owns())return;if(!reviewActions.pending(id))await render();}
   const [view,dto]=await Promise.all([api(base(id)+'/view'),readCurrentMemoryDto(id)]);if(!owns())return;
   let observed=await projectCurrentMemory(dto,id,s.artifacts,view.library?.sources??[]);if(!owns())return;
   const application=pendingReviewApplication(id),rows=view.native_full_chain?.runs??[],row=application?(rows.find(row=>row.run_id===application.run_id)??{run_id:application.run_id}):rows[0],nextId=row?.run_id,run=await readRun(id,row);if(!owns())return;
   const memoryChanged=observed?.revision_key!==s.currentMemoryView?.revision_key,hadCurrentError=Boolean(s.memoryCurrentError);
   const changed=memoryChanged||s.currentMemoryBlocked||nextId!==runId||lightogLibraryRevision(run)!==lightogLibraryRevision(s.run)||JSON.stringify(view.source_stamp)!==JSON.stringify(s.view?.source_stamp)||JSON.stringify([run?.status,run?.snapshot?.build?.knowledge_index,run?.snapshot?.build?.knowledge,run?.snapshot?.partial_organization,run?.snapshot?.build?.processing_summary])!==JSON.stringify([s.run?.status,s.run?.snapshot?.build?.knowledge_index,s.run?.snapshot?.build?.knowledge,s.run?.snapshot?.partial_organization,s.run?.snapshot?.build?.processing_summary]);
   // Read the graph separately from source artifacts. Publication can lag the terminal
   // run status; a missing graph is retried on the next read-only poll, even at rest.
   const sourcesChanged=nextId!==runId||JSON.stringify(view.source_stamp)!==JSON.stringify(s.view?.source_stamp);
   let graph=s.graph,graphRead=false,artifacts=s.artifacts;
   if(sourcesChanged&&run){
    const documents=await artifact('documents',{id,run:run.run_id});if(!owns())return;
    const retained=new Map((s.artifacts.blocks??[]).map(row=>[JSON.stringify([row.doc_ref??row.items?.[0]?.doc_ref,row.revision??row.items?.[0]?.revision]),row]));
    const blocks=await Promise.all((documents.items??[]).map(d=>nextId===runId&&retained.get(JSON.stringify([d.doc_ref,d.revision]))||artifact('blocks',{id,run:run.run_id,docRef:d.doc_ref})));
    if(!owns())return;artifacts={documents,blocks};
    if(dto!==null){observed=await projectCurrentMemory(dto,id,artifacts,view.library?.sources??[]);if(!owns())return;}
   }
   if(!observed&&run&&(changed||!graph||!s.model.knowledge.length||!s.model.graph_data?.nodes?.size&&graph?.status!=='READY'||graphSyncPending.has(id))){
    graphSyncPending.add(id);
    graph=await api(runBase(id,run.run_id)+'/graph?view=EXTRACTED_KNOWLEDGE');
    if(!owns())return;
    graph=bindLightogLibraryGraph(graph,{run,libraryId:id});
    const candidate=graph&&projectLightogReading({libraryId:id,run,graph,...artifacts,sources:view.library?.sources??[]});
    if(!graph||graph.library_id&&graph.library_id!==id||graph.run_id&&graph.run_id!==run.run_id||candidate?.library_state?.status==='MISMATCH')
     throw Error('图谱尚未与当前批次对齐，保留此前快照。');
    graphRead=true;graphSyncPending.delete(id);
   }
   const displayChanged=memoryChanged||s.currentMemoryBlocked||graphRead||changed;
   const graphChanged=memoryChanged||s.currentMemoryBlocked||graphRead;
   s.run=run;s.view=view;
   if(displayChanged){
    clearCache(id);s.graph=graph;s.artifacts=artifacts;s.currentMemoryView=observed;s.currentMemoryBlocked=false;
    s.memoryCurrentError=null;s.loadError=null;project();
    cacheLibrary(id,{view,run,graph:s.graph,artifacts:s.artifacts,model:s.model,currentMemoryView:observed,currentMemoryBlocked:false,memoryCurrentError:null});
   }else if(hadCurrentError){s.memoryCurrentError=null;s.loadError=null;}
   if(memoryChanged){queryCapabilities.delete(id);s.memoryCurrentError='当前知识视图有更新，请读取最新确认版本后提问。';}
   // Only the graph page is redrawn automatically. Readers, chat answers and
   // review/settings forms keep their DOM, scroll and in-progress input.
   const preserveHistoricalLocation=Boolean(s.route.graph_context?.temporary_context||s.route.source_location_return||s.route.version_location);
   if(graphChanged&&frame.page==='graph'&&!preserveHistoricalLocation){
    capture();
    const context=s.route.graph_context;
    if(context){
     const scene=projectNativeDomainGraph(filterLightogGraph(s.graph,s.model,s.route.source_filter),{focusId:context.projection_focus});
     // Explicit same-library visual continuity; temporary historical locations
     // remain bound to their original revision and are never migrated.
     if(!context.temporary_context&&!s.route.source_location_return&&!s.route.version_location)
      update({graph_context:{...context,version:scene.version}});
    }
    await render({preserve:false});
    if(!owns())return;
   }
   const pending=syncPendingStart(id);if(pending?.status==='START_CONFIRMED'&&pending.run_id===run?.run_id)clearPending(id,pending.request_id);
   if(owns()&&frame.page==='query'&&!memoryChanged&&!s.currentMemoryBlocked&&(changed||hadCurrentError))await loadQuery({read:false});
   else if(owns()&&frame.page==='query'&&(memoryChanged||s.currentMemoryBlocked))chatWorkspace?.render();
   const actions=root.querySelector('[data-lw-batch-actions]');if(actions)actions.innerHTML=lightogBatchActions(s);
   const summary=root.querySelector('[data-lw-batch-summary]');if(summary){const gapsOpen=summary.querySelector('[data-lw-completion-gaps]')?.open===true;summary.innerHTML=lightogBatchSummary(s,{gapsOpen});}
   const progress=root.querySelector('[data-lw-build-progress]');if(progress){const open=progress.querySelector('[data-lw-progress-diagnostics]')?.open===true,scroll=progress.querySelector('.lw-build-table')?.scrollLeft??0;progress.innerHTML=lightogBuildProgress(s,{diagnosticsOpen:open});const table=progress.querySelector('.lw-build-table');if(table)table.scrollLeft=scroll;}
   const label=lightogBatchStatus(run,s.model);for(const target of root.querySelectorAll('.lw-status-dot')){target.textContent=label.label;target.className='lw-status-dot '+label.tone;}
   if(displayChanged&&(frame.page!=='graph'||preserveHistoricalLocation))currentUpdateNotice('新结果已读回，当前阅读位置已保留。');
  }catch(error){if(owns()){if(memoryEnabled&&(!s.graph||prior))currentReadFailed(id,error,prior);else {queryCapabilities.delete(id);s.memoryCurrentError=memoryEnabled?error.message:null;s.loadError='图谱暂未同步，保留此前快照。'+error.message;}chatWorkspace?.render();currentUpdateNotice(s.loadError);}}
  finally{pollBusy=false;}
 }
 root.addEventListener('click',click);root.addEventListener('submit',submit);root.addEventListener('input',input);root.addEventListener('change',change);win.addEventListener('popstate',pop);
 const keydown=event=>{if(event.key==='Enter'&&event.target.matches('.lw-paragraph'))void click({target:event.target});};
 root.addEventListener('keydown',keydown);
 syncPendingStart(s.route.library_id);
 try{s.uploadResult=JSON.parse(storage?.getItem('lightog.upload-receipt.v1')??'null');}catch{}
 s.models=await api('/api/product/models');try{await loadLibrary(s.route.library_id);}catch(error){toast(error.message);}if(s.route.page==='pending')await loadReview();if(s.route.page==='query')await loadQuery();await restoreQuerySource(s.route);await render({preserve:false});
 const timer=setInterval(()=>{void poll();},5000);
 const queryTimer=setInterval(()=>{void pollQuery();},1500);
 return {state:s,navigation:nav,poll,pollQuery,render,dispose(){disposed=true;++queryEpoch;chatWorkspace?.dispose();disposeGraph();clearInterval(timer);clearInterval(queryTimer);clearTimeout(searchTimer);root.removeEventListener('click',click);root.removeEventListener('submit',submit);root.removeEventListener('input',input);root.removeEventListener('change',change);root.removeEventListener('keydown',keydown);win.removeEventListener('popstate',pop);}};
}
