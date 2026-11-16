/** Existing product APIs, one full run for an explicit upload. No stage approvals or replay. */
// Normal product execution controls belong to the backend. Never forward browser trial budgets.
const uuidPattern=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const libraryPattern=/^kb_[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const runPattern=/^nrun_[a-f0-9]{32}$/;
const copies=rows=>rows.map(row=>({...row}));
const invalid=(message,code)=>Object.assign(Error(message),{code});
const errorFields=error=>({error:error?.message??'本地服务未返回可确认的结果',error_code:error?.code??null,error_status:Number.isInteger(error?.status)?error.status:null});
// A transport/5xx error can occur after a durable write. Never turn it into a fresh request.
const rejected=error=>Number.isInteger(error?.status)&&error.status>=400&&error.status<500&&error.status!==408;
export function lightogBuildCommand({requestId,embedding=false,resumeFromRunId=null,capability=null}){
 if(!uuidPattern.test(requestId??''))throw invalid('整理请求标识无效','LIGHTOG_REQUEST_ID_INVALID');
 if(resumeFromRunId!==null&&!runPattern.test(resumeFromRunId))throw invalid('此前整理记录标识无效','LIGHTOG_RESUME_RUN_ID_INVALID');
 if(capability!==null&&!['HYBRID','LEXICAL'].includes(capability))throw invalid('此前整理使用的模型配置尚未确认','LIGHTOG_CAPABILITY_INVALID');
 return {request_id:requestId,consent:true,capability:capability??(embedding?'HYBRID':'LEXICAL'),...(resumeFromRunId?{resume_from_run_id:resumeFromRunId}:{})};
}
export function confirmLightogRun(run,libraryId,{resumeFromRunId=null}={}){
 if(!runPattern.test(run?.run_id??'')||run.library_id!==undefined&&run.library_id!==libraryId||run.run_id===resumeFromRunId)throw invalid('整理请求已提交，返回的任务标识尚不能确认，请读取原请求状态','LIGHTOG_RUN_HANDLE_UNCONFIRMED');
 return run;
}
export async function submitLightogDocuments({files,name,libraryId=null,api,upload,models,uuid,onProgress=()=>{},onSaved=()=>{}}){
 const selected=Array.from(files??[]);
 if(!selected.length)throw Error('请选择至少一份资料');
 // Validate the entire selection before saving any file.
 if(selected.some(f=>typeof f?.name!=='string'||!(/\.(pdf|docx|md)$/i.test(f.name))||!Number.isSafeInteger(f.size)||f.size<=0||f.size>20*1024*1024))throw Error('支持 20MB 以内的 PDF、DOCX、Markdown 资料');
 if(libraryId!==null&&!libraryPattern.test(libraryId))throw invalid('知识库标识无效','LIGHTOG_LIBRARY_ID_INVALID');
 const generation=models?.generation?.configured===true;
 // The caller can retain these IDs before the first mutation; this helper never retries.
 const registrationRequestId=libraryId?null:uuid(),requestId=generation?uuid():null;
 if(registrationRequestId!==null&&!uuidPattern.test(registrationRequestId)||requestId!==null&&!uuidPattern.test(requestId))throw invalid('资料请求标识无效','LIGHTOG_REQUEST_ID_INVALID');
 const sources=[],registered=[];let id=libraryId,viewRefreshError=null;
 const state=()=>({library_id:id,sources:copies(sources),uploaded_sources:copies(sources),registered_sources:copies(registered),registration_request_id:registrationRequestId,request_id:requestId});
 const saved=async complete=>{try{await onSaved({...state(),sources:copies(registered),registration_complete:complete});}catch(error){viewRefreshError=error?.message??'资料已保存，但页面未能刷新';}};
 onProgress({step:'prepared',total:selected.length,...state()});
 for(const [index,file]of selected.entries()){
  onProgress({step:'reading',index,total:selected.length,title:file.name,...state()});
  let doc;
  try{
   doc=await upload(file);
   if(!uuidPattern.test(doc?.document_id??''))throw invalid('资料服务未返回可验证的原件标识，请先确认保存状态','LIGHTOG_DOCUMENT_HANDLE_UNCONFIRMED');
  }catch(error){return {...state(),status:sources.length?'PARTIAL_UPLOAD_SAVED':rejected(error)?'UPLOAD_REJECTED':'UPLOAD_RESULT_UNCONFIRMED',failed_file:{index,title:file.name},...errorFields(error),registration_complete:false};}
  sources.push({title:typeof doc.title==='string'&&doc.title.trim()?doc.title:file.name,document_id:doc.document_id});
  // Emit each durable handle immediately, even if a later parse or registration fails.
  onProgress({step:'uploaded',index,total:selected.length,title:file.name,...state()});
 }
 onProgress({step:'saving',total:selected.length,...state()});
 if(!id){
  let result;
  try{
   result=await api('/api/product/libraries',{request_id:registrationRequestId,build_mode:'NATIVE_CQ_BUILD_V1',input:{name:typeof name==='string'&&name.trim()?name.trim():sources[0].title,cqs:[],definitions:'',sources:copies(sources),consent:true}});
   if(!libraryPattern.test(result?.library_id??''))throw invalid('资料保存结果未返回可验证的知识库标识，请先确认状态','LIGHTOG_LIBRARY_HANDLE_UNCONFIRMED');
  }catch(error){return {...state(),status:rejected(error)?'SAVE_REJECTED':'SAVE_RESULT_UNCONFIRMED',...errorFields(error),registration_complete:false};}
  id=result.library_id;registered.push(...copies(sources));await saved(true);
 }else{
  for(const [index,source]of sources.entries()){
   try{await api('/api/product/libraries/'+encodeURIComponent(id)+'/sources',{source:{...source},build_mode:'NATIVE_CQ_BUILD_V1'});}
   catch(error){return {...state(),status:rejected(error)?registered.length?'PARTIALLY_REGISTERED':'SAVE_REJECTED':'SAVE_RESULT_UNCONFIRMED',failed_file:{index,title:source.title},...errorFields(error),registration_complete:false,...(viewRefreshError?{view_refresh_error:viewRefreshError}:{})};}
   registered.push({...source});await saved(registered.length===sources.length);
  }
 }
 const summary=()=>({...state(),registration_complete:true,...(viewRefreshError?{view_refresh_error:viewRefreshError}:{})});
 if(!generation)return {...summary(),status:'SAVED_CONFIGURATION_REQUIRED'};
 onProgress({step:'organizing',total:selected.length,...state()});
 try{
  const run=confirmLightogRun(await api('/api/product/libraries/'+encodeURIComponent(id)+'/native-full-chain/runs',lightogBuildCommand({requestId,embedding:models?.embedding?.configured===true})),id);
  return {...summary(),status:'STARTED',run};
 }catch(error){return {...summary(),status:rejected(error)?'START_REJECTED':'START_RESULT_UNCONFIRMED',...errorFields(error)};}
}
