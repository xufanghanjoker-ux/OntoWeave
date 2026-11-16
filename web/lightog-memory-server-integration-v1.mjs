/** Server-only composition. Factories are the real production exports passed by server.mjs. */
import {createHash} from 'node:crypto';

const ROOT = '/api/product/memory/v1';
const CURRENT = ROOT + '/current-view';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code,status=403) => Object.assign(new Error(code),{code,status});
const need = (value,code,status) => {if(!value)throw fail(code,status);};
const errorCode = error => /^[A-Z][A-Z0-9_]{0,95}$/.test(error?.code??'') ? error.code : 'MEMORY_SERVER_UNAVAILABLE';
const json = (res,status,value) => {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(value));
};

export function createLightogMemoryServerIntegration({
  store,catalog,workspaceId,serviceInstanceRef,integrationAccess,assertLibrary,
  browserToken,allowedOrigins,modelRuntime,runtimeDirectory,skillPaths,onOperation=()=>{},
  createRuntime,createActionPort,selectSkills,createMcpHandler,createBrowserHandler,
  createMaintenanceRuntime=null,createMaintenanceHandler=null,createLibraryContext=null,
  createOrganizationReusePort=null,verifyActionPrepared=null,prepareActionLibrary=null,identitySkillPath=null,
  createMaintenanceOutcomeReader=null,temporalCore=null,temporalEmbeddingRuntime=null
}={}) {
  need(store&&typeof store.getRecord==='function'&&typeof store.putRecord==='function'
    &&typeof workspaceId==='string'&&workspaceId.length>0,'MEMORY_SERVER_HOST_INVALID',500);
  for(const fn of [assertLibrary,browserToken,allowedOrigins,modelRuntime,createRuntime,createActionPort,selectSkills,createMcpHandler,createBrowserHandler])
    need(typeof fn==='function','MEMORY_SERVER_FACTORY_REQUIRED',500);
  const maintenanceFactories=[createMaintenanceRuntime,createMaintenanceHandler,createLibraryContext,
    createOrganizationReusePort,verifyActionPrepared,prepareActionLibrary];
  const maintenanceEnabled=maintenanceFactories.some(value=>value!==null)||identitySkillPath!==null;
  need(!maintenanceEnabled||maintenanceFactories.every(value=>typeof value==='function')
    &&typeof identitySkillPath==='string'&&identitySkillPath.length>0,'MEMORY_SERVER_MAINTENANCE_FACTORY_REQUIRED',500);
  need(createMaintenanceOutcomeReader===null||typeof createMaintenanceOutcomeReader==='function',
    'MEMORY_SERVER_MAINTENANCE_OUTCOME_FACTORY_INVALID',500);
  need(createMaintenanceOutcomeReader===null||maintenanceEnabled,'MEMORY_SERVER_MAINTENANCE_FACTORY_REQUIRED',500);
  const skills=selectSkills(skillPaths);
  const names=['lightog-semantic-discovery','lightog-knowledge-organization'];
  need(Array.isArray(skills)&&skills.length===2&&names.every(name=>skills.filter(skill=>skill.name===name).length===1)
    &&skills.every(skill=>/^[a-f0-9]{64}$/.test(skill.sha256)&&/^[a-f0-9]{64}$/.test(skill.tree_sha256)),
  'MEMORY_SERVER_SKILL_FREEZE_INVALID',500);
  const skillFreeze={schema:'NATIVE_ACTION_SKILL_FREEZE_V1',skills:structuredClone(skills)};
  const freezeRef='memory_server_skill_freeze_'+hash(skillFreeze);
  const freezeRecord={freeze_ref:freezeRef,...skillFreeze};
  const prior=store.getRecord('native_memory_server_skill_freeze_v1',freezeRef);
  need(!prior||hash(prior)===hash(freezeRecord),'MEMORY_SERVER_SKILL_FREEZE_CONFLICT',500);
  if(!prior)store.putRecord('native_memory_server_skill_freeze_v1',freezeRef,freezeRecord);
  const pin=({name,path,sha256,tree_sha256})=>({name,path,sha256,tree_sha256});
  let identityPin=null,identityFreezeRef=null;
  if(maintenanceEnabled) {
    const selected=selectSkills([identitySkillPath]);
    need(selected.length===1&&selected[0].name==='lightog-entity-resolution'
      &&/^[a-f0-9]{64}$/.test(selected[0].sha256)&&/^[a-f0-9]{64}$/.test(selected[0].tree_sha256),
    'MEMORY_SERVER_IDENTITY_SKILL_FREEZE_INVALID',500);
    identityPin=pin(selected[0]);
    identityFreezeRef='memory_server_identity_skill_freeze_'+hash(identityPin);
    const identityRecord={schema:'NATIVE_ACTION_IDENTITY_SKILL_FREEZE_V1',freeze_ref:identityFreezeRef,skill:identityPin};
    const previous=store.getRecord('native_memory_server_skill_freeze_v1',identityFreezeRef);
    need(!previous||hash(previous)===hash(identityRecord),'MEMORY_SERVER_SKILL_FREEZE_CONFLICT',500);
    if(!previous)store.putRecord('native_memory_server_skill_freeze_v1',identityFreezeRef,identityRecord);
  }

  const browserAuth=new WeakMap();
  let mcpHandler;
  function authorizeBrowser(auth,{library_id,action}) {
    const entry=browserAuth.get(auth);
    if(!entry)return null;
    need(entry.library_id===library_id&&['read','search','write'].includes(action),'MEMORY_BROWSER_SCOPE_DENIED',403);
    assertLibrary(library_id);
    return {library_id,principal_ref:'browser:'+workspaceId,channel:'BROWSER',permissions:['read','search','write']};
  }
  const authorize=(auth,scope)=>{
    assertLibrary(scope.library_id);
    // A recognized but revoked MCP identity throws; it must not fall back to browser auth.
    return mcpHandler?.authorize(auth,scope)??authorizeBrowser(auth,scope);
  };
  function authenticateBrowser(req,scope) {
    need(req.headers?.authorization===undefined,'MEMORY_BROWSER_BEARER_DENIED',403);
    const token=browserToken();
    need(typeof token==='string'&&token.length>0&&req.headers?.['x-cqforge-token']===token,'MEMORY_BROWSER_TOKEN_INVALID',401);
    const origins=allowedOrigins();
    need(Array.isArray(origins)&&origins.length>0,'MEMORY_BROWSER_ORIGINS_UNAVAILABLE',503);
    const origin=req.headers?.origin;
    need(origin===undefined||origins.includes(origin),'MEMORY_BROWSER_ORIGIN_FORBIDDEN',403);
    if(req.method!=='GET')need(typeof origin==='string'&&origins.includes(origin),'MEMORY_BROWSER_ORIGIN_REQUIRED',403);
    assertLibrary(scope.library_id);
    const auth=Object.freeze({});browserAuth.set(auth,{library_id:scope.library_id});
    return auth;
  }
  const runtime=createRuntime({store,catalog,authorize,modelRuntime,temporalCore,temporalEmbeddingRuntime,
    actionProcessingPortFactory:snapshot=>createActionPort({store,runtimeDirectory,upstream:snapshot.upstream,skillFreeze}),
    assertLibrary,onOperation,resumeNeverStarted:false,
    ...(maintenanceEnabled?{verifyActionPrepared,prepareActionLibrary}:{})});
  need(runtime?.service&&typeof runtime.resolveReader==='function'&&typeof runtime.readCurrentView==='function'
    &&typeof runtime.readiness==='function'&&typeof runtime.close==='function','MEMORY_SERVER_RUNTIME_INVALID',500);
  mcpHandler=createMcpHandler({service:runtime.service,integrationAccess,workspaceId,serviceInstanceRef});
  const browserHandler=createBrowserHandler({service:runtime.service,authenticateRequest:authenticateBrowser});
  let maintenanceRuntime=null,maintenanceHandler=null;
  if(maintenanceEnabled) {
    need(store.db&&typeof runtime.coreForLibrary==='function'&&runtime.processing&&runtime.publication&&runtime.projection,
      'MEMORY_SERVER_SHARED_RUNTIME_PORTS_REQUIRED',500);
    const libraryContext=createLibraryContext({store,catalog:runtime.catalog,coreForLibrary:runtime.coreForLibrary});
    need(typeof libraryContext?.assertCurrent==='function'&&typeof libraryContext?.createSourceAccess==='function',
      'MEMORY_SERVER_LIBRARY_CONTEXT_REQUIRED',500);
    const resolveRuntimeOutcome=createMaintenanceOutcomeReader===null?null:createMaintenanceOutcomeReader({store});
    need(resolveRuntimeOutcome===null&&createMaintenanceOutcomeReader===null||typeof resolveRuntimeOutcome==='function',
      'MEMORY_SERVER_MAINTENANCE_OUTCOME_READER_REQUIRED',500);
    maintenanceRuntime=createMaintenanceRuntime({db:store.db,coreForLibrary:runtime.coreForLibrary,
      processing:runtime.processing,publication:runtime.publication,projection:runtime.projection,libraryContext,
      resolveSourcePrepared:({source_run_id})=>store.getRecord('native_action_processing_result_v1',source_run_id)?.prepared,
      organizationPortFactory:(snapshot,bound)=>{
        need(typeof snapshot?.upstream==='function'&&bound?.library_context,'MEMORY_SERVER_ORGANIZATION_CONTEXT_REQUIRED',503);
        need(hash(selectSkills([identitySkillPath]).map(pin))===hash([identityPin]),'MEMORY_SERVER_IDENTITY_SKILL_CHANGED',409);
        libraryContext.assertCurrent(bound.library_context);
        const port=createOrganizationReusePort({store,runtimeDirectory,upstream:snapshot.upstream,skillFreeze,identitySkillPath,
          sourceAccess:libraryContext.createSourceAccess(bound.library_context),
          assertLibraryContext:context=>libraryContext.assertCurrent(context)});
        need(port?.mode==='NATIVE_CODEX'&&typeof port.verifyReuse==='function'&&typeof port.reorganize==='function',
          'MEMORY_SERVER_NATIVE_ORGANIZATION_PORT_REQUIRED',503);
        return port;
      },modelRuntime,authorize,assertLibrary,onOperation,verifyActionPrepared,
      ...(resolveRuntimeOutcome===null?{}:{resolveRuntimeOutcome})});
    need(typeof maintenanceRuntime?.readiness==='function'&&typeof maintenanceRuntime.close==='function'
      &&typeof maintenanceRuntime.drain==='function','MEMORY_SERVER_MAINTENANCE_RUNTIME_INVALID',500);
    maintenanceHandler=createMaintenanceHandler({runtime:maintenanceRuntime,authenticateRequest:authenticateBrowser});
    need(typeof maintenanceHandler==='function','MEMORY_SERVER_MAINTENANCE_HANDLER_INVALID',500);
  }
  let resumeError=null;
  const resumeNeverStarted=()=>{
    try {runtime.resumeNeverStarted();resumeError=null;return true;}
    catch(error){resumeError=errorCode(error);return false;}
  };
  const readiness=()=>{
    const value=runtime.readiness();
    return Object.fromEntries(['production_mount_ready','models_configured','automatic_processing','queue_length','running','closed','strict_as_of_supported']
      .filter(key=>value[key]!==undefined).map(key=>[key,value[key]]).concat(resumeError?[['resume_error_code',resumeError]]:[]));
  };
  const maintenanceMetadata=()=>{
    if(!maintenanceEnabled)return {enabled:false};
    const state=maintenanceRuntime.readiness(),projectionModelsReady=runtime.readiness().models_configured===true;
    return {enabled:true,reorganize_route:ROOT+'/records/:record_ref/reorganize',status_route:ROOT+'/maintenance-attempts/:attempt_ref',
      readiness:{...Object.fromEntries(Object.entries(state).filter(([key])=>
        ['available','accepting','closed','running','queue_length','automatic_resume','execution_mode'].includes(key))),
      available:state.available===true&&projectionModelsReady,projection_models_configured:projectionModelsReady}};
  };
  async function handle(req,res) {
    const url=new URL(req.url,'http://memory.local');
    if(!url.pathname.startsWith(ROOT+'/'))return false;
    if(await mcpHandler(req,res))return true;
    if(maintenanceHandler&&await maintenanceHandler(req,res))return true;
    if(url.pathname===CURRENT) {
      try {
        need(req.method==='GET','MEMORY_CURRENT_VIEW_METHOD_INVALID',405);
        need([...url.searchParams.keys()].every(key=>key==='library_id')
          &&url.searchParams.getAll('library_id').length===1,'MEMORY_CURRENT_VIEW_ARGUMENTS_INVALID',400);
        const library_id=url.searchParams.get('library_id');
        need(typeof library_id==='string'&&library_id.trim().length>0&&library_id.length<=160,'MEMORY_LIBRARY_REQUIRED',400);
        const auth=authenticateBrowser(req,{library_id,action:'read'});
        need(authorize(auth,{library_id,action:'read'}),'MEMORY_BROWSER_AUTH_REQUIRED',401);
        const value=await runtime.readCurrentView({library_id});
        need(value?.library_id===library_id,'MEMORY_CURRENT_VIEW_SCOPE_CHANGED',409);
        json(res,200,value);
      }catch(error){json(res,[400,401,403,404,405,409,413,503].includes(error.status)?error.status:409,{error:{code:errorCode(error)}});}
      return true;
    }
    return browserHandler(req,res);
  }
  return Object.freeze({runtime,maintenanceRuntime,handle,resolveReader:libraryId=>runtime.resolveReader(libraryId),
    readiness,isBusy:()=>[runtime,maintenanceRuntime].filter(Boolean).some(port=>{
      const state=port.readiness();return state.running===true||Number(state.queue_length)>0;}),
    resumeNeverStarted,async close(options){await maintenanceRuntime?.close(options);await runtime.close(options);},
    metadata:()=>({enabled:true,route:ROOT,readiness:readiness(),current_view_route:CURRENT,maintenance:maintenanceMetadata(),
      temporal:{enabled:temporalCore!==null,candidates_route:ROOT+'/temporal/candidates',query_route:ROOT+'/temporal/query',changes_route:ROOT+'/temporal/changes',
        scope:'FACT_VERSION_AND_SOURCE_HISTORY',answer_model_called:false}}),
    skillFreezeRef:freezeRef,identitySkillFreezeRef:identityFreezeRef});
}
