/** Mounted only after the workbench's Host, Origin, token and library checks. */
const fail=(code,status=400)=>Object.assign(Error(code),{code,status});
const need=(ok,code,status)=>{if(!ok)throw fail(code,status);};
const uuid=/^[a-f0-9-]{36}$/;
function fields(body,allowed){need(body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).every(k=>allowed.includes(k)),'SOURCE_HTTP_ARGUMENTS_INVALID');}
export function createSourceFirstHttp({product,json,parseBody,prepareInput,openStream,onOperation=()=>{}}){
 return async function handle({req,res,pathname}){
  const modelRoute=pathname.match(/^\/api\/source-first\/models(?:\/(generation|embedding|reranker))?$/);
  if(modelRoute){need(product,'SOURCE_PRODUCT_NOT_ENABLED',409);if(req.method==='GET'&&!modelRoute[1]){json(res,200,product.modelStatus());return true;}need(req.method==='POST'&&modelRoute[1],'SOURCE_METHOD_NOT_ALLOWED',405);json(res,200,product.configureModel(modelRoute[1],await parseBody(req)));return true;}
  if(pathname==='/api/source-first/libraries'){
   need(product,'SOURCE_PRODUCT_NOT_ENABLED',409);need(req.method==='POST','SOURCE_METHOD_NOT_ALLOWED',405);const body=await parseBody(req);fields(body,['input','request_id']);need(typeof body.request_id==='string'&&uuid.test(body.request_id),'SOURCE_REQUEST_ID_REQUIRED');
   const input=prepareInput(body.input);json(res,201,product.importLibrary({input,requestId:body.request_id}));return true;
  }
  const match=pathname.match(/^\/api\/knowledge-bases\/(kb_[a-f0-9-]{36})\/source-first\/(preview|budgets|ask|learning|jobs|sources|graph|recover-candidates)(?:\/(sl_[a-f0-9]{32}))?$/);
  if(!match)return false;
  need(product,'SOURCE_PRODUCT_NOT_ENABLED',409);const [,libraryId,action,taskRef]=match;
  if(req.method==='GET'&&action==='graph'){need(!taskRef,'SOURCE_GRAPH_SCOPE_INVALID');json(res,200,product.graph({libraryId}));return true;}
  if(req.method==='GET'&&action==='jobs'){need(!taskRef||/^sl_[a-f0-9]{32}$/.test(taskRef),'SOURCE_JOB_ID_INVALID');json(res,200,product.status({libraryId,taskRef}));return true;}
  need(req.method==='POST'&&!taskRef&&action!=='jobs'&&action!=='graph','SOURCE_METHOD_NOT_ALLOWED',405);
  const body=await parseBody(req);
  if(action==='recover-candidates'){fields(body,['task_ref']);need(/^sl_[a-f0-9]{32}$/.test(body.task_ref),'SOURCE_JOB_ID_INVALID');onOperation(1);try{json(res,200,await product.recoverCandidates({libraryId,taskRef:body.task_ref}));}finally{onOperation(-1);}return true;}
  if(action==='sources'){fields(body,['source','replace_source_key']);json(res,200,product.updateSource({libraryId,source:body.source,replaceSourceKey:body.replace_source_key??null}));return true;}
  if(action==='preview'){
   fields(body,['question','operation','rebuild_source_scope']);need(body.operation===undefined||['ASK','LEARN'].includes(body.operation),'SOURCE_OPERATION_INVALID');need(body.rebuild_source_scope===undefined||typeof body.rebuild_source_scope==='boolean','SOURCE_REBUILD_FLAG_INVALID');
   json(res,200,product.preview({libraryId,question:body.question,operation:body.operation??'ASK',rebuildSourceScope:body.rebuild_source_scope??false}));return true;
  }
  if(action==='budgets'){
   fields(body,['question','operation','preview_id','limits','consent','rebuild_source_scope']);need(['ASK','LEARN'].includes(body.operation),'SOURCE_OPERATION_INVALID');need(body.rebuild_source_scope===undefined||typeof body.rebuild_source_scope==='boolean','SOURCE_REBUILD_FLAG_INVALID');
   json(res,201,product.confirm({libraryId,question:body.question,operation:body.operation,previewId:body.preview_id,limits:body.limits,consent:body.consent,rebuildSourceScope:body.rebuild_source_scope??false}));return true;
  }
  fields(body,['question','request_id','budget_id','consent',...(action==='learning'?['rebuild_source_scope']:[])]);need(body.consent===true,'SOURCE_MODEL_CONSENT_REQUIRED',428);need(typeof body.request_id==='string'&&uuid.test(body.request_id),'SOURCE_REQUEST_ID_REQUIRED');need(body.rebuild_source_scope===undefined||typeof body.rebuild_source_scope==='boolean','SOURCE_REBUILD_FLAG_INVALID');
  if(action==='learning'){
   // A separate learning budget is mandatory; asking never silently funds a build.
   json(res,202,product.enqueue({libraryId,question:body.question,requestId:body.request_id,budgetId:body.budget_id,rebuildSourceScope:body.rebuild_source_scope??false}));return true;
  }
  onOperation(1);
  try{
   product.authorizeAsk({libraryId,question:body.question,budgetId:body.budget_id});
   if(String(req.headers.accept??'').includes('text/event-stream'))res.answerStream=openStream(res);
   const answer=await product.ask({libraryId,question:body.question,budgetId:body.budget_id,requestId:body.request_id,onEvent:async e=>{const {event,...data}=e;res.answerStream?.send(event,data);}});
   json(res,200,answer);return true;
  }finally{onOperation(-1);}
 };
}
