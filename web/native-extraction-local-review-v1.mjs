import {createNativeReadSession,nativePageNext} from './native-agent-read-session-v1.mjs';
import {projectSavedKnowledge,projectSavedKnowledgeSet,pageSavedKnowledge} from './native-organization-focus-v1.mjs';
/** One persisted local review opportunity inside the existing window agent. */
import {clone,need,hash,textField} from './cq-discovery-store-v2.mjs';

export const LOCAL_REVIEW_POLICY='LOCAL_REVIEW_ONCE_V1';
export function validateExtractionReviewPolicy(policy){need(policy===null||policy===LOCAL_REVIEW_POLICY,'NATIVE_EXTRACTION_REVIEW_POLICY_INVALID');return policy;}
const KIND='native_extraction_local_review_v1';
const instructions='窗口尚未关闭。对照当前窗口正文与实际保存结果回看一次：重要含义是否在压缩时丢失、联系或层级是否压平、值和机制的归属、条件／否定／语气／例外是否实际保留；引用关系不证明内容完整。以下线索不表示错误。只追加有原文依据的增量，可用 supplements 引用 K 标识；不要重交整批。没有增量可再次调用结束工具。此次回看不认证事实或完整覆盖。';

export function createExtractionLocalReview({store,runId,readKnowledge,readBudget}){
 const get=()=>store.getRecord(KIND,runId)??{run_id:runId,policy:LOCAL_REVIEW_POLICY,phase:'DRAFT',review_performed:false};
 const put=value=>{store.putRecord(KIND,runId,clone(value));return clone(value);};
 const proposals=()=>[...store.listRecords('native_knowledge_proposal_v1').filter(p=>p.run_id===runId&&p.name==='SUBMIT'&&store.getRecord('native_knowledge_receipt_v1',p.proposal_ref)?.saved===true),...(store.getRecord('native_organization_draft_import_v1',runId)?.proposals??[])];
 const latestRefs=()=>{const head=readKnowledge(),last=head.processing_results.at(-1);return last?(store.getRecord('native_knowledge_receipt_v1',last.proposal_ref)?.knowledge_refs??[]).map(ref=>'K'+(head.knowledge.findIndex(k=>k.record_ref===ref)+1)):[];};
 const feedback=()=>{const s=readKnowledge(),p=s.processing_summary;return {saved:proposals().length>0,received:p.received,structured:p.structured,text:p.text,skipped:p.skipped,warnings:p.warnings,warning_samples:s.processing_results.filter(i=>i.warnings.length).slice(0,6).map(i=>({index:i.index,warnings:i.warnings.slice(0,4)}))};};
 // K references are stable append positions within this window, never model IDs.
 const view=createNativeReadSession({binding:()=>hash(readKnowledge().knowledge),selectionFields:['knowledge_refs'],select(args){if(args.knowledge_refs!==undefined)need(Array.isArray(args.knowledge_refs)&&args.knowledge_refs.every(ref=>/^K[1-9][0-9]*$/.test(ref)&&Number(ref.slice(1))<=readKnowledge().knowledge.length),'NATIVE_READ_SELECTION_REFS_INVALID');return {knowledge_refs:args.knowledge_refs??null};},produce(selection,position){const page=pageSavedKnowledge(projectSavedKnowledgeSet(readKnowledge().knowledge),{...selection,...position});return {result:{...page,scope:'CURRENT_WINDOW_SAVED_KNOWLEDGE',signals_are_errors:false},next:nativePageNext(page)};}});
 function proposalMetadata(){const s=get();return {phase:s.phase==='REVIEW_AVAILABLE'?'SUPPLEMENT':'INITIAL',...(s.initial_proposal_refs?{initial_proposal_refs:clone(s.initial_proposal_refs),initial_revision:s.initial_revision}:{})};}
 function noteSaved(){const s=get();if(s.phase==='DRAFT')put({...s,phase:'DRAFT_SAVED'});}
 function finishCurrent(){
  const s=get(),b=readBudget(),saved=feedback();
  // UNKNOWN/failed/pending requests never acquire a normal successful finish.
  if(!b.settled)return {extraction_complete:false,window_closed:false,status:'REQUESTS_UNSETTLED',save_feedback:saved};
  if(!b.open)return {extraction_complete:false,window_closed:false,status:'PARENT_STOPPED',save_feedback:saved};
  const retained=store.listRecords('native_business_output_warning_v1').filter(r=>r.run_id===runId);if(!saved.saved&&retained.length){const done=put({...s,phase:'FINISHED',review_performed:false,review_status:'NOT_PERFORMED_NO_USABLE_INITIAL',warnings:['BUSINESS_OUTPUT_NOT_SAVED']});return {extraction_complete:true,window_closed:true,local_review:done,save_feedback:saved,gaps:['BUSINESS_OUTPUT_NOT_SAVED']};}
  if(!saved.saved)return {extraction_complete:false,window_closed:false,status:'FIRST_SAVE_REQUIRED',message:'尚无真实保存回执，窗口尚未关闭。先保存已发现内容；确无条目也提交空批次留下实际回执。'};
  if(s.phase!=='REVIEW_AVAILABLE'&&s.phase!=='FINISHED'){
   const initial={...s,initial_proposal_refs:proposals().map(p=>p.proposal_ref),initial_revision:readKnowledge().revision??store.getRecord('native_knowledge_head_v1',runId)?.revision??null,initial_feedback:saved,feedback_generation:b.generation};
   if(!b.canContinue){const done=put({...initial,phase:'FINISHED',review_performed:false,review_status:'NOT_PERFORMED_BUDGET'});return {extraction_complete:true,window_closed:true,local_review:done,save_feedback:saved};}
   put({...initial,phase:'REVIEW_AVAILABLE',review_status:'AVAILABLE'});
  }else if(s.phase==='REVIEW_AVAILABLE'){
   if(b.generation>s.feedback_generation){const supplementary=proposals().filter(p=>!s.initial_proposal_refs.includes(p.proposal_ref));const done=put({...s,phase:'FINISHED',review_performed:true,review_status:supplementary.length?'PERFORMED_WITH_SUPPLEMENT':'PERFORMED_NO_INCREMENT',supplement_proposal_refs:supplementary.map(p=>p.proposal_ref),final_feedback:saved});return {extraction_complete:true,window_closed:true,local_review:done,save_feedback:saved};}
   if(!b.canContinue){const done=put({...s,phase:'FINISHED',review_performed:false,review_status:'NOT_PERFORMED_BUDGET'});return {extraction_complete:true,window_closed:true,local_review:done,save_feedback:saved};}
  }else return {extraction_complete:true,window_closed:true,local_review:s,save_feedback:saved};
  return {extraction_complete:false,window_closed:false,status:'LOCAL_REVIEW_AVAILABLE',message:instructions,save_feedback:saved,saved_knowledge:view({knowledge_refs:latestRefs()}),local_review:get()};
 }
 function finish(args,ctx){
  need(textField(ctx?.invocation_ref)&&textField(ctx.tool_call_ref??String(ctx.mcp_request_id??'')),'NATIVE_TOOL_CALL_CONTEXT_REQUIRED');
  return store.transaction(()=>{const key=hash([runId,ctx.invocation_ref,ctx.tool_call_ref??ctx.mcp_request_id]),old=store.getRecord('native_extraction_review_finish_receipt_v1',key);if(old){need(old.args_sha256===hash(args),'NATIVE_KNOWLEDGE_CALL_IDENTITY_CONFLICT');return clone(old.result);}const result=finishCurrent();store.putRecord('native_extraction_review_finish_receipt_v1',key,{run_id:runId,args_sha256:hash(args),result:clone(result)});return result;});
 }
 function beginImportedReview(){const s=get(),b=readBudget();need(s.phase==='DRAFT'||s.phase==='DRAFT_SAVED','NATIVE_ORGANIZATION_DRAFT_REVIEW_ALREADY_STARTED');return put({...s,phase:'REVIEW_AVAILABLE',initial_proposal_refs:proposals().map(p=>p.proposal_ref),initial_revision:store.getRecord('native_knowledge_head_v1',runId)?.revision??null,initial_feedback:feedback(),feedback_generation:b.generation,review_status:'AVAILABLE',initial_origin:'PROGRAM_CONFIRMED_SAVED_DRAFTS'});}
 return {beginImportedReview,finish,view,latestRefs,feedback,proposalMetadata,noteSaved,snapshot:()=>clone(get())};
}
