/** Local main-product endpoints, mounted after the normal CSRF/library checks. */
import {createNativeFullChainHttp,NATIVE_BUILD_MODE} from './native-full-chain-http-v1.mjs';
const validId=/^[a-f0-9-]{36}$/;
const need=(value,code,status=400)=>{if(!value)throw Object.assign(Error(code),{code,status});};
export function createProductHttp({runtime,product,governance,reviews=null,nativeBuildHost=null,json,parseBody,prepareInput,openStream,onOperation=()=>{}}) {
  const nativeHttp=createNativeFullChainHttp({host:nativeBuildHost,json,parseBody});
  return async function handle({req,res,pathname}) {
    if(!pathname.startsWith('/api/product/'))return false;
    need(runtime&&product,'PRODUCT_RUNTIME_NOT_ENABLED',409);
    if(await nativeHttp({req,res,pathname}))return true;
    if(pathname==='/api/product/models'&&req.method==='GET'){json(res,200,product.modelStatus());return true;}
    if(pathname==='/api/product/models'&&req.method==='POST'){product.configureModels(await parseBody(req));json(res,200,product.modelStatus());return true;}
    const model=pathname.match(/^\/api\/product\/models\/(generation|embedding|reranker)$/);
    if(model&&req.method==='POST'){json(res,200,product.configureModel(model[1],await parseBody(req)));return true;}
    if(pathname==='/api/product/libraries'&&req.method==='POST') {
      const body=await parseBody(req);need(validId.test(body.request_id??''),'SOURCE_REQUEST_ID_REQUIRED');
      const input=prepareInput({...body.input,consent:true});
      need(body.build_mode===undefined||body.build_mode===NATIVE_BUILD_MODE,'PRODUCT_BUILD_MODE_INVALID');
      if(body.build_mode===NATIVE_BUILD_MODE){need(nativeBuildHost,'NATIVE_BUILD_NOT_CONNECTED',409);nativeBuildHost.validateInput(input);}
      const imported=product.importLibrary({input,requestId:body.request_id});
      if(body.build_mode===NATIVE_BUILD_MODE||nativeBuildHost?.isNativeLibrary(imported.library_id)){const registered=nativeBuildHost.register({libraryId:imported.library_id});json(res,201,{...imported,...registered,learning:{status:'NOT_STARTED',model_calls:0}});return true;}
      json(res,201,{...imported,learning:runtime.initial(imported.library_id)});return true;
    }
    const reviewRoute=pathname.match(/^\/api\/product\/libraries\/(kb_[a-f0-9-]{36})\/reviews(?:\/(review_[a-f0-9]{32})\/decisions)?$/);
    if(reviewRoute){
      need(reviews,'HUMAN_REVIEW_NOT_ENABLED',409);const [,libraryId,itemId]=reviewRoute;
      runtime.view(libraryId);
      if(req.method==='GET'&&!itemId){json(res,200,reviews.list({libraryId}));return true;}
      need(req.method==='POST'&&itemId,'PRODUCT_METHOD_NOT_ALLOWED',405);
      const command=await parseBody(req);
      need(command&&Object.keys(command).every(k=>['request_id','item_revision','action','option_id','reason'].includes(k))&&validId.test(command.request_id??''),'HUMAN_REVIEW_COMMAND_INVALID');
      const result=await reviews.decide({libraryId,itemId,command});json(res,200,result);return true;
    }
    const route=pathname.match(/^\/api\/product\/libraries\/(kb_[a-f0-9-]{36})\/(view|ask|sources)(?:\/(src_[a-f0-9]{32})\/(revoke))?$/);
    need(route,'PRODUCT_ROUTE_NOT_FOUND',404);
    const [,libraryId,action,sourceKey]=route;
    // view performs the same active-library check as the source host.
    runtime.view(libraryId);
    if(action==='view'&&req.method==='GET'){const view=runtime.view(libraryId);json(res,200,{...view,...(nativeBuildHost?.isNativeLibrary(libraryId)?{native_full_chain:await nativeBuildHost.list({libraryId})}:{})});return true;}
    need(req.method==='POST','PRODUCT_METHOD_NOT_ALLOWED',405);
    const body=await parseBody(req);
    if(action==='sources') {
      need(body.build_mode===undefined||body.build_mode===NATIVE_BUILD_MODE,'PRODUCT_BUILD_MODE_INVALID');
      const native=body.build_mode===NATIVE_BUILD_MODE||nativeBuildHost?.isNativeLibrary(libraryId);
      if(native)need(nativeBuildHost,'NATIVE_BUILD_NOT_CONNECTED',409);
      if(native&&!sourceKey)need(typeof body.source?.document_id==='string','NATIVE_DOCLING_DOCUMENT_REQUIRED');
      const updated=sourceKey?(governance.revoke(libraryId,sourceKey),{status:'SOURCE_REVOKED'}):product.updateSource({libraryId,source:body.source,replaceSourceKey:body.replace_source_key??null});
      const active=runtime.sources(libraryId).some(s=>s.active);
      if(native){const registration=active?nativeBuildHost.register({libraryId}):null;json(res,200,{...updated,...registration,build_mode:NATIVE_BUILD_MODE,learning:{status:active?'NOT_STARTED':'NO_ACTIVE_SOURCES',model_calls:0}});return true;}
      json(res,200,{...updated,learning:active?runtime.initial(libraryId,true):{status:'NO_ACTIVE_SOURCES'}});return true;
    }
    need(!nativeBuildHost?.isNativeLibrary(libraryId),'NATIVE_QUERY_USE_READBACK',409);
    need(action==='ask'&&typeof body.question==='string'&&body.question.trim()&&validId.test(body.request_id??''),'PRODUCT_QUESTION_REQUIRED');
    onOperation(1);
    try {
      if(String(req.headers.accept??'').includes('text/event-stream'))res.answerStream=openStream(res);
      const answer=await runtime.ask({libraryId,question:body.question,requestId:body.request_id,
        onEvent:async e=>{const {event,...data}=e;res.answerStream?.send(event,data);}});
      json(res,200,answer);return true;
    } finally {onOperation(-1);}
  };
}
