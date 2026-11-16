import {readNativeLibraryKnowledge} from './native-library-knowledge-agent-v1.mjs';
import {GENERAL_KNOWLEDGE_POLICY,generalKnowledge,validateGeneralPolicy,currentKnowledge,semanticBaseRecords,knowledgeCompletion} from './native-general-knowledge-v1.mjs';
import {businessArgumentPolicy,retainUnparsedBusinessOutput} from './native-tool-arguments-v1.mjs';
import {CONTINUE_READ_SCHEMA} from './native-agent-read-session-v1.mjs';
import {validateOrganizationRelationReviewPolicy} from './native-organization-relation-review-v1.mjs';
import {validateExtractionStagePolicy} from './native-semantic-package-v1.mjs';
import {LOCAL_REVIEW_POLICY,validateExtractionReviewPolicy,createExtractionLocalReview} from './native-extraction-local-review-v1.mjs';
import {createExtractedKnowledge,EXTRACT_POLICY,TOLERANT_SCOPE_SCHEMA,TOLERANT_EXTRACT_SCHEMA,DOMAIN_EXTRACT_SCHEMA} from './native-extracted-knowledge-v1.mjs';
/** Native build tool host. No semantic model loop and no legacy publication writes. */
import {hash,clone,need,textField} from './cq-discovery-store-v2.mjs';
import {createDocumentExtractionWindows} from './document-extraction-windows-v1.mjs';
import {createNativeHybridSourceRecords} from './native-hybrid-source-records-v1.mjs';
import {createNativeScopePlan,nativeScopeSchemaFor,NATIVE_COVERAGE_SCHEMA} from './native-scope-plan-v1.mjs';
import {createNativeExtractionOutput,NATIVE_EXTRACTION_BATCH_SCHEMA} from './native-extraction-output-v1.mjs';
import {createNativeLocalAdmission,NATIVE_LOCAL_REVIEW_SCHEMA} from './native-local-admission-v1.mjs';
import {createNativeBuildIndex} from './native-build-index-v1.mjs';

const str={type:'string',minLength:1,maxLength:8000},refs={type:'array',items:str,uniqueItems:true,maxItems:512};
const obj=(properties,required=[])=>({type:'object',additionalProperties:false,required,properties});
const writes=new Set(['lightog_save_scope_plan','lightog_submit_extraction_batch','lightog_finish_extraction','lightog_save_local_review']);
const tool=(name,description,inputSchema)=>({name,description,inputSchema,annotations:{readOnlyHint:!writes.has(name),destructiveHint:false,openWorldHint:false}});
const doc={doc_ref:str,revision:str};
export const NATIVE_BUILD_TOOL_NAMES={
 LIST:'lightog_list_build_sources',READ:'lightog_read_build_material',WINDOW:'lightog_assemble_extraction_window',SPLIT:'lightog_split_source_unit',EVIDENCE:'lightog_locate_evidence',STATE:'lightog_get_build_state',SAVED:'lightog_read_saved_knowledge',SCOPE:'lightog_save_scope_plan',SUBMIT:'lightog_submit_extraction_batch',FINISH:'lightog_finish_extraction',
 REVIEW_INPUT:'lightog_get_review_batch',REVIEW_READ:'lightog_read_review_material',REVIEW_EVIDENCE:'lightog_locate_review_evidence',REVIEW_SAVE:'lightog_save_local_review'
};
const READ_SCHEMA=obj({...doc,cursor:{type:['string','null'],description:'省略、null或空字符串表示首页；非空值只使用本工具实际返回的next_cursor。'},max_chars:{type:'integer',minimum:1}},['doc_ref','revision']);
const WINDOW_SCHEMA=obj({...doc,core_unit_refs:refs,context_unit_refs:refs,max_chars:{type:'integer',minimum:1},token_budget:{type:'integer',minimum:1}},['doc_ref','revision','core_unit_refs']);
const EVIDENCE_SCHEMA=obj({window_ref:str,unit_ref:str,quote:str,occurrence:{type:'integer',minimum:1}},['window_ref','unit_ref','quote']);
const EXTRACTION_COVERAGE_SCHEMA=clone(NATIVE_COVERAGE_SCHEMA);
EXTRACTION_COVERAGE_SCHEMA.items.properties.status.enum=EXTRACTION_COVERAGE_SCHEMA.items.properties.status.enum.filter(status=>status!=='COMPLETE');
const FINISH_SCHEMA=obj({reason:str,coverage:EXTRACTION_COVERAGE_SCHEMA,gaps:{type:'array',items:str,maxItems:256}},['reason','coverage','gaps']);
const READ_REVIEW_SCHEMA=obj({...WINDOW_SCHEMA.properties,gap:str,candidate_ref:str},['doc_ref','revision','core_unit_refs','gap','candidate_ref']);

export function createNativeBuildHost({store,catalog,libraryId,snapshotId,cqInput,families,runId,assertOpen=()=>{},scopeContract='LEGACY_V1',knowledgeBuildPolicy=null,inputSourceRefs=[],allowedSourceDocumentRefs=null,allowedSourceUnits=null,sourceChunkPlan=null,semanticPolicy=null,extractionReviewPolicy=null,readExtractionBudget=null,extractionStagePolicy=null,semanticPackage=null,organizationRelationReviewPolicy=null,generalKnowledgePolicy=null,libraryKnowledgePolicy=null,readCanonicalEntities=()=>[]}) {
 validateGeneralPolicy(generalKnowledgePolicy);need(libraryKnowledgePolicy===null||libraryKnowledgePolicy==='LIBRARY_KNOWLEDGE_V1'&&generalKnowledgePolicy,'NATIVE_LIBRARY_POLICY_INVALID');const priorGeneral=store.getRecord('native_build_state_v1',runId);if(priorGeneral)need((priorGeneral.general_knowledge_policy??null)===generalKnowledgePolicy&&(priorGeneral.library_knowledge_policy??null)===libraryKnowledgePolicy,'NATIVE_GENERAL_KNOWLEDGE_POLICY_CHANGED');
 need(cqInput?.input_ref===families?.input_ref,'NATIVE_BUILD_FAMILY_INPUT_MISMATCH');
 const sourceChunkPlanHash=sourceChunkPlan?hash(sourceChunkPlan):null;
 if(sourceChunkPlan){const {plan_sha256,...body}=sourceChunkPlan;need(plan_sha256===hash(body),'NATIVE_HYBRID_SOURCE_PLAN_CHANGED');}
 const binding=hash({libraryId,snapshotId,cqInput,families,runId}),current=()=>{need(catalog.isCurrent(snapshotId,libraryId),'NATIVE_BUILD_SOURCE_STALE');const s=catalog.get(snapshotId,libraryId);if(s.fingerprint)need(hash({library_id:s.library_id,source_epoch:s.source_epoch,documents:s.documents})===s.fingerprint,'NATIVE_BUILD_SOURCE_SNAPSHOT_CHANGED');return s;};
 const open=()=>{assertOpen();current();};
 const options={store,catalog,libraryId,snapshotId,runId,assertOpen:open};
 const windows=createDocumentExtractionWindows(options),scope=createNativeScopePlan({...options,cqInput,families,scopeContract}),scopeSchema=nativeScopeSchemaFor(scopeContract);
 need(knowledgeBuildPolicy===null||knowledgeBuildPolicy===EXTRACT_POLICY,'NATIVE_KNOWLEDGE_POLICY_INVALID');need(semanticPolicy===null||knowledgeBuildPolicy===EXTRACT_POLICY,'NATIVE_SEMANTIC_POLICY_REQUIRES_KNOWLEDGE_POLICY');
 validateOrganizationRelationReviewPolicy(organizationRelationReviewPolicy);need(!organizationRelationReviewPolicy||extractionStagePolicy==='SEMANTIC_THEN_ORGANIZE_V1'&&extractionReviewPolicy==='LOCAL_REVIEW_ONCE_V1','NATIVE_ORGANIZATION_RELATION_REVIEW_REQUIRES_LOCAL_REVIEW');
 validateExtractionStagePolicy(extractionStagePolicy);validateExtractionReviewPolicy(extractionReviewPolicy);need(!extractionReviewPolicy||knowledgeBuildPolicy===EXTRACT_POLICY,'NATIVE_EXTRACTION_REVIEW_REQUIRES_KNOWLEDGE_POLICY');
 // Budget callback is internal to a window. Parent aggregation has no review loop.
 need(readExtractionBudget===null||extractionReviewPolicy===LOCAL_REVIEW_POLICY&&typeof readExtractionBudget==='function','NATIVE_EXTRACTION_REVIEW_BUDGET_REQUIRED');let localReview;
 const tolerant=knowledgeBuildPolicy===EXTRACT_POLICY?createExtractedKnowledge({store,runId,snapshotId,catalog,libraryId,cqInput,inputSourceRefs,allowedSourceDocumentRefs,allowedSourceUnits,semanticPolicy,semanticPackage,generalKnowledgePolicy,readCanonicalEntities,proposalMetadata:()=>localReview?.proposalMetadata()??null,assertOpen:open}):null;
 if(readExtractionBudget)localReview=createExtractionLocalReview({store,runId,readKnowledge:tolerant.snapshot,readBudget:readExtractionBudget});
 const output=createNativeExtractionOutput({...options,readScope:scope.snapshot});
 const admission=createNativeLocalAdmission({...options,readCandidates:()=>output.snapshot().candidates,readEvidence:ref=>ref?output.readEvidence(ref):store.listRecords('native_evidence_v1').filter(e=>e.run_id===runId),readScope:scope.snapshot});
 const index=createNativeBuildIndex(options);
 const state=()=>{const s=store.getRecord('native_build_state_v1',runId);need(s?.binding===binding,'NATIVE_BUILD_BINDING_CHANGED');return s;};
 store.transaction(()=>{const prior=store.getRecord('native_build_state_v1',runId);if(prior){need(prior.binding===binding,'NATIVE_BUILD_BINDING_CHANGED');need((prior.organization_relation_review_policy??null)===organizationRelationReviewPolicy,'NATIVE_ORGANIZATION_RELATION_REVIEW_POLICY_CHANGED');need((prior.extraction_stage_policy??null)===extractionStagePolicy,'NATIVE_EXTRACTION_STAGE_POLICY_CHANGED');need((prior.extraction_review_policy??null)===extractionReviewPolicy,'NATIVE_EXTRACTION_REVIEW_POLICY_CHANGED');need((prior.knowledge_build_policy??null)===knowledgeBuildPolicy,'NATIVE_KNOWLEDGE_POLICY_CHANGED');need((prior.source_chunk_plan_sha256??null)===sourceChunkPlanHash,'NATIVE_HYBRID_SOURCE_PLAN_BINDING_CHANGED');}else store.putRecord('native_build_state_v1',runId,{run_id:runId,binding,source_snapshot_ref:snapshotId,...(generalKnowledgePolicy?{general_knowledge_policy:generalKnowledgePolicy}:{}),...(libraryKnowledgePolicy?{library_knowledge_policy:libraryKnowledgePolicy}:{}),...(organizationRelationReviewPolicy?{organization_relation_review_policy:organizationRelationReviewPolicy}:{}),...(extractionStagePolicy?{extraction_stage_policy:extractionStagePolicy}:{}),...(extractionReviewPolicy?{extraction_review_policy:extractionReviewPolicy}:{}),...(tolerant?{knowledge_build_policy:EXTRACT_POLICY}:{}),...(sourceChunkPlanHash?{source_chunk_plan_sha256:sourceChunkPlanHash}:{}),extraction_complete:false});});
 function definitions(role) {
  need(['EXTRACTION','REVIEW'].includes(role),'NATIVE_BUILD_ROLE_FORBIDDEN');const n=NATIVE_BUILD_TOOL_NAMES;
  if(tolerant&&role==='REVIEW')return [];
  if(role==='REVIEW')return [
   tool(n.REVIEW_INPUT,'读取指定候选、原CQ任务和原文证据的独立核实包；不含生成者私有推理。',obj({})),
   tool(n.REVIEW_READ,'仅为明确候选缺口补读一次指定局部结构单元；不改写候选，不启动重审。',READ_REVIEW_SCHEMA),
   tool(n.REVIEW_EVIDENCE,'定位已读取窗口内精确引句，重复引句明确选择1起始occurrence；定位不认证语义。',EVIDENCE_SCHEMA),
   tool(n.REVIEW_SAVE,'逐候选保存支持/不足/冲突/拒绝结论及独立coverage；工具保存后等待Host确认原生调用，不能自行宣布采用或发布。',NATIVE_LOCAL_REVIEW_SCHEMA)
  ];
  const result=[
   tool(n.LIST,'列出获准资料及完整结构单元目录；目录不计实际正文扫描。',obj({...doc,cursor:{type:['string','null'],description:'省略、null或空字符串表示首页；非空值只使用本工具实际返回的next_cursor。'},max_units:{type:'integer',minimum:1}})),
   tool(n.READ,'按完整来源单元读取正文；短文可整篇，大文分页，显式预算不足不静默截断。',READ_SCHEMA),
   tool(n.WINDOW,'按选定结构单元组装核心正文与辅助标题/定义/表头；保留原始位置与合成输入映射。',WINDOW_SCHEMA),
   tool(n.SPLIT,'仅在单个结构单元超过显式预算时按自然边界拆分，返回可选part目录；不代表已读，表格无法无损拆分则返回缺口。',obj({...doc,unit_ref:str,max_chars:{type:'integer',minimum:1}},['doc_ref','revision','unit_ref','max_chars'])),
   tool(n.EVIDENCE,'定位已读窗口内逐字引句；重复引句明确选择1起始occurrence，Host生成证据引用。',EVIDENCE_SCHEMA),
   tool(n.STATE,'读取本轮原CQ、已保存问题族、scope、候选和扫描/覆盖缺口；候选不等于事实。',obj({})),
   tool(n.SCOPE,scopeContract==='TASK_CQ_REFS_V1'?'TASK_CQ_REFS_V1：只在tasks[].cq_refs声明实际任务归属；无任务CQ逐项填unplanned_cqs的UNRESOLVED/OUT_OF_SCOPE及原因，不另填cq_dispositions。Host仅派生反向TASKS归属，不推断事实支持或覆盖完成。主体必须绑定原文提及，无自然主体使用模块/文档任务。':'LEGACY_V1：保存本轮原CQ的范围任务与逐题disposition；主体必须绑定原文提及，无自然主体使用模块/文档任务。',tolerant?TOLERANT_SCOPE_SCHEMA:scopeSchema),
   tool(n.SUBMIT,'分开保存原话与RELATION/ATTRIBUTE/RULE候选；evidence_refs只用定位工具实际返回的evidence_ref，读取回执/窗口/单元引用不能代替。每条保留自己的证据、任务、条件和资料语气，不能自行采用。',tolerant?(semanticPolicy?DOMAIN_EXTRACT_SCHEMA:TOLERANT_EXTRACT_SCHEMA):NATIVE_EXTRACTION_BATCH_SCHEMA),
   tool(n.FINISH,'保存抽取检查点与明确缺口；空候选不证明资料不足或整题完整，后续仍需独立核实和索引。',FINISH_SCHEMA)
  ];
  if(tolerant)for(const d of result.map(d=>{d.inputSchema=clone(d.inputSchema);return d;})){if([n.READ,n.LIST,n.WINDOW,n.SPLIT].includes(d.name)){for(const k of ['revision','cursor'])delete d.inputSchema.properties[k];d.inputSchema.required=d.inputSchema.required.filter(k=>!['revision','cursor'].includes(k));}if(d.name===n.FINISH)d.inputSchema={type:'object',additionalProperties:true,properties:{reason:str,gaps:{type:'array',items:str}}};if(d.name===n.SCOPE)d.description='规划实际主体、模块和知识需求，关联原CQ并附可得来源；遗漏CQ由程序记未规划。';if(d.name===n.SUBMIT)d.description=(semanticPolicy?'从正文保存领域对象、任意类型／关系定义、对象或关系属性、规则及重要陈述；使用名称表达关系两端，可直接提交，不必先规划完整主体或任务。':'')+'保存知识描述及可得语义结构、来源和引句。缺项按条保留为文本或跳过告警，不要求精确证据、执行元数据或Review。';}
  if(localReview){result.push(tool(n.SAVED,'读取本窗口实际已保存知识，用K选择；reading.has_more时仅传continue:true续读，换选择自动从头开始。不重读知识库。',obj({...CONTINUE_READ_SCHEMA,knowledge_refs:{type:'array',items:str}})));const finishTool=result.find(t=>t.name===n.FINISH);finishTool.description='申请结束本窗口。首次调用返回实际保存反馈及一次回看机会，明确窗口尚未关闭；回看后无增量也可再次调用最终结束。预算不足记录未执行回看。';}
  return result;
 }
 function recordReads(result){if(result?.read_receipt_ref)scope.recordReads([result.read_receipt_ref]);return result;}
 function finish(args){need(textField(args?.reason)&&Array.isArray(args?.coverage)&&Array.isArray(args?.gaps)&&args.gaps.every(textField),'NATIVE_BUILD_FINISH_INVALID');need(args.coverage.every(r=>r.status!=='COMPLETE'),'NATIVE_BUILD_EXTRACTION_CANNOT_CERTIFY_COVERAGE');const s=scope.snapshot();need(s.scope_revision,'NATIVE_SCOPE_REQUIRED');const e=output.snapshot(),bindingState=admission.snapshot(),stale=new Set(bindingState.stale_candidate_refs??[]);for(const c of e.candidates)need(c.task_refs.every(r=>s.tasks.some(t=>t.task_ref===r))||stale.has(c.candidate_ref),'NATIVE_BUILD_TASK_CHANGED');scope.setCoverage(args.coverage);const receipt={extraction_complete:true,extraction_revision:e.revision,scope_revision:s.scope_revision,reason:args.reason,gaps:clone(args.gaps),stale_candidate_refs:[...stale]};store.putRecord('native_build_state_v1',runId,{...state(),...receipt});return receipt;}
 function supplement(args){need(textField(args.gap)&&output.snapshot().candidates.some(c=>c.candidate_ref===args.candidate_ref),'NATIVE_REVIEW_GAP_REQUIRED');const prior=store.getRecord('native_build_supplement_v1',runId),requestHash=hash(args);if(prior){need(prior.request_sha256===requestHash,'NATIVE_REVIEW_SUPPLEMENT_ALREADY_USED');return clone(prior.result);}const {gap,candidate_ref,...windowArgs}=args,result=recordReads(windows.assemble(windowArgs));if(result.accepted!==false)store.putRecord('native_build_supplement_v1',runId,{run_id:runId,request_sha256:requestHash,gap,candidate_ref,result:clone(result)});return result;}
 function missingSurfaceFeedback(error){
  const evidence=error.evidence_location;need(evidence&&textField(error.surface),'NATIVE_SCOPE_LOCATION_FEEDBACK_INVALID');
  const locations=new Map();
  for(const window of windows.snapshot().windows.filter(w=>w.doc_ref===evidence.doc_ref&&w.revision===evidence.revision))for(const unit of window.units){
   let offset=0,occurrence=0;while((offset=unit.text.indexOf(error.surface,offset))!==-1){occurrence++;const start=unit.start+offset,end=start+error.surface.length,key=hash([unit.doc_ref,unit.revision,start,end]);
    if(!locations.has(key))locations.set(key,{doc_ref:unit.doc_ref,revision:unit.revision,start,end,offset_unit:'utf16_code_unit',unit_kind:unit.kind,quote:error.surface,identity_verified:false,locate_arguments:{window_ref:window.window_ref,unit_ref:unit.unit_ref,quote:error.surface,occurrence}});offset++;
   }
  }
  const candidates=[...locations.values()].sort((a,b)=>a.start-b.start||a.end-b.end),limit=8;
  return {accepted:false,status:'NEEDS_LOCATION',code:error.code,scope_saved:false,subject_local_ref:error.subject_local_ref,surface:error.surface,source_evidence_ref:error.source_evidence_ref,occurrence_base:0,occurrences:[],evidence_locations:[clone(evidence)],candidate_locations:candidates.slice(0,limit),candidate_locations_total:candidates.length,candidate_locations_truncated:candidates.length>limit,candidate_scope:'EXACT_SURFACE_IN_ALREADY_READ_SAME_DOCUMENT_REVISION',semantic_support_certified:false,next_action:'所选证据引句不含该surface，填写occurrence不能修复。核对原文；若选择候选位置，先显式调用lightog_locate_evidence的locate_arguments取得新证据，再提交完整计划。候选位置不认证同一身份；也可明确改为原文逐字surface、按模块处理或保留未决，不自动拼接证据。'};
 }
 function wrongEvidenceTypeFeedback(args){
  const usages=new Map();for(const collection of ['source_statements','candidates'])for(const [index,item]of (args[collection]??[]).entries())for(const [position,ref]of item.evidence_refs.entries()){if(!usages.has(ref))usages.set(ref,[]);usages.get(ref).push('/'+collection+'/'+index+'/evidence_refs/'+position);}
  const material=windows.snapshot();need(material.source_current===true,'NATIVE_BUILD_SOURCE_STALE');
  const reads=new Map(material.reads.map(r=>[r.read_receipt_ref,r])),knownWindows=new Map(material.windows.map(w=>[w.window_ref,w])),issues=[];
  for(const [ref,paths]of usages){
   // A real E always follows the original strict validator, even if another ref is a valid R.
   if(store.getRecord('native_evidence_v1',ref)){output.readEvidence(ref);continue;}
   const read=reads.get(ref);if(!read)return null;
   const window=knownWindows.get(read.window_ref);
   need(read.body_returned===true&&window&&window.units.length>0&&hash(read.source_spans)===hash(window.source_spans),'NATIVE_EXTRACTION_EVIDENCE_FORBIDDEN');
   need(read.source_spans.every(s=>s.doc_ref===window.doc_ref&&s.revision===window.revision),'NATIVE_EXTRACTION_EVIDENCE_FORBIDDEN');
   issues.push({provided_ref:ref,actual_kind:'READ_RECEIPT',usages:paths,location:{doc_ref:window.doc_ref,revision:window.revision,read_receipt_ref:read.read_receipt_ref,window_ref:window.window_ref,unit_refs:window.units.map(u=>u.unit_ref)},required_tool:NATIVE_BUILD_TOOL_NAMES.EVIDENCE,required_arguments:['window_ref','unit_ref','quote'],occurrence_base:1});
  }
  if(!issues.length)return null;
  return {accepted:false,status:'NEEDS_EVIDENCE',code:'NATIVE_EXTRACTION_EVIDENCE_TYPE_MISMATCH',batch_saved:false,current_extraction_revision:output.snapshot().revision,issues,remaining_candidate_validation:'NOT_COMPLETED',next_action:'evidence_refs误用了本轮读取回执，整批未保存，idempotency_key未占用。请为每条原话/候选从已读units[].text选择支持它的逐字引句，显式调用lightog_locate_evidence取得evidence_ref，再重新提交整批。不要把读取回执、窗口、单元或仅定位主体名称的证据广播为所有候选的依据；Host不会自动替换引用或创建证据。'};
 }
 async function call(role,name,args={},callContext={}) {
  try{
   open();if(tolerant){
    const n=NATIVE_BUILD_TOOL_NAMES;need(role==='EXTRACTION','NATIVE_BUILD_ROLE_FORBIDDEN');need(!state().extraction_complete||name===n.STATE,'NATIVE_EXTRACTION_ALREADY_FINISHED');
    const retained=retainUnparsedBusinessOutput({store,runId,name,args,ctx:callContext});if(retained&&name!==n.FINISH)return {ok:true,result:{...retained,raw_retained:true,window_closed:false}};if(retained)args={gaps:retained.warnings};
    if(name===n.SCOPE)return {ok:true,result:tolerant.saveScope(args,callContext)};
    if(name===n.SUBMIT){const saved=tolerant.submit(args,callContext);localReview?.noteSaved();return {ok:true,result:localReview?{...saved,save_feedback:localReview.feedback(),saved_knowledge:localReview.view({knowledge_refs:(saved.knowledge_refs??[]).map(ref=>'K'+(tolerant.snapshot().knowledge.findIndex(k=>k.record_ref===ref)+1))}),window_closed:false}:saved};}
    if(name===n.SAVED&&localReview)return {ok:true,result:localReview.view(args)};
    if(name===n.STATE)return {ok:true,result:localReview?{cq_input:clone(cqInput),families:clone(families),save_feedback:localReview.feedback(),saved_knowledge:localReview.view(),local_review:localReview.snapshot(),extraction_complete:state().extraction_complete}:{cq_input:clone(cqInput),families:clone(families),...tolerant.snapshot()}};
    if(name===n.FINISH){const review=localReview?.finish(args,callContext);if(review&&!review.extraction_complete)return {ok:true,result:review};const receipt={...review,extraction_complete:true,...(generalKnowledgePolicy?{completion:knowledgeCompletion({knowledge:tolerant.snapshot().knowledge,gaps:args.gaps??[],windowClosed:true,localReview:localReview?.snapshot()})}:{}),reason:args.reason??'已处理抽取提案',gaps:Array.isArray(args.gaps)?args.gaps:[]};store.putRecord('native_build_state_v1',runId,{...state(),...receipt});return {ok:true,result:receipt};}
    if([n.READ,n.LIST].includes(name)&&args.doc_ref&&callContext.invocation_ref){const page=store.getRecord('native_knowledge_page_v1',hash([runId,callContext.invocation_ref,name,args.doc_ref]));args={...args,cursor:page?.next_cursor??null};}
    if(args.doc_ref&&!args.revision){const d=current().documents.find(d=>d.doc_id===args.doc_ref);if(d)args={...args,revision:d.revision};}
   }const definition=definitions(role).find(d=>d.name===name);need(definition,'NATIVE_BUILD_TOOL_FORBIDDEN');if(!tolerant)validateArguments(definition.inputSchema,args);
   if(role==='EXTRACTION')need(!state().extraction_complete,'NATIVE_EXTRACTION_ALREADY_FINISHED');else need(state().extraction_complete,'NATIVE_REVIEW_EXTRACTION_REQUIRED');
   const n=NATIVE_BUILD_TOOL_NAMES;let result;
   if(name===n.LIST)result={documents:current().documents.map(d=>({doc_ref:d.doc_id,revision:d.revision,title:d.title,parser:d.parser,chars:d.content.length})),...windows.listUnits(args)};
   else if(name===n.READ)result=recordReads(windows.read(args));
   else if(name===n.WINDOW)result=recordReads(windows.assemble(args));
   else if(name===n.SPLIT)result=windows.splitUnit(args);
   else if(name===n.EVIDENCE||name===n.REVIEW_EVIDENCE)result=windows.locateEvidence(args);
   else if(name===n.STATE)result={cq_input:clone(cqInput),families:clone(families),scope:scope.snapshot(),extraction:output.snapshot()};
   else if(name===n.SCOPE)result=scope.savePlan(args);
   else if(name===n.SUBMIT){const adopted=admission.snapshot().facts??[];result=output.submitBatch(args);if(result.changed_candidate_refs.length){const refs=adopted.filter(f=>result.changed_candidate_refs.includes(f.candidate_ref)).map(f=>f.fact_ref);if(refs.length){const ev=[...new Set(output.snapshot().candidates.filter(c=>result.changed_candidate_refs.includes(c.candidate_ref)).flatMap(c=>c.evidence_refs))],suspended=admission.suspend({fact_refs:refs,evidence_refs:ev,reason:'候选版本变化，旧核实不得继承'});if(index.snapshot().fact_index)index.suspendFacts({factRefs:refs,adoptionRevision:suspended.adoption_revision_ref});}}}
   else if(name===n.FINISH)result=finish(args);
   else if(name===n.REVIEW_INPUT)result=reviewInput();
   else if(name===n.REVIEW_READ)result=supplement(args);
   else if(name===n.REVIEW_SAVE)result=admission.recordReview(args);
   if(tolerant&&result?.read_receipt_ref)tolerant.recordRead(result,callContext);if(tolerant&&[NATIVE_BUILD_TOOL_NAMES.READ,NATIVE_BUILD_TOOL_NAMES.LIST].includes(name)&&args.doc_ref&&callContext.invocation_ref)store.putRecord('native_knowledge_page_v1',hash([runId,callContext.invocation_ref,name,args.doc_ref]),{next_cursor:result.next_cursor??null});
   return {ok:true,result:clone(result)};
  }catch(error){
   if(tolerant&&['NATIVE_WINDOW_DOCUMENT_FORBIDDEN','NATIVE_WINDOW_DOCUMENT_REQUIRED','NATIVE_WINDOW_SELECTION_REQUIRED','NATIVE_WINDOW_UNIT_FORBIDDEN','NATIVE_WINDOW_CONTEXT_INVALID','NATIVE_WINDOW_RECORD_FORBIDDEN','NATIVE_WINDOW_CURSOR_INVALID','NATIVE_EVIDENCE_UNIT_FORBIDDEN','NATIVE_EVIDENCE_INPUT_INVALID','NATIVE_EVIDENCE_OCCURRENCE_INVALID','NATIVE_WINDOW_UNIT_OVERLAP','NATIVE_WINDOW_BUDGET_EXCEEDED','NATIVE_WINDOW_CHAR_BUDGET_INVALID','NATIVE_WINDOW_CHAR_BUDGET_REQUIRED'].includes(error.code))return {ok:true,result:{processed:true,readable:false,status:'UNREADABLE_SELECTION',warnings:[error.code],next_action:'该资料选择本次不可读取；可使用实际目录引用继续其他资料，不代表资料没有相关知识。'}};
   if(name===NATIVE_BUILD_TOOL_NAMES.SCOPE&&error.code==='NATIVE_SCOPE_CQ_BINDINGS_INVALID'&&Array.isArray(error.issues)&&error.issues.length)return {ok:true,result:{accepted:false,status:'NEEDS_CQ_BINDINGS',code:error.code,scope_saved:false,current_scope_revision:scope.snapshot().scope_revision,issues:clone(error.issues),next_action:'旧式双写归属不一致，本次范围未保存。对照原CQ和资料，明确修订tasks[].cq_refs或cq_dispositions的status/task_local_refs并重交完整计划；Host没有选择哪一边正确，也没有改写任何映射。'}};
   if(name===NATIVE_BUILD_TOOL_NAMES.SUBMIT&&error.code==='NATIVE_EXTRACTION_FIELDS_REQUIRED'&&Array.isArray(error.issues)&&error.issues.length)return {ok:true,result:{accepted:false,status:'NEEDS_FIELDS',code:error.code,batch_saved:false,current_extraction_revision:output.snapshot().revision,issues:clone(error.issues),remaining_candidate_validation:'NOT_COMPLETED',next_action:'整批尚未保存，idempotency_key未占用。按issues逐项核对原文，明确补齐对应kind所需字段后重交完整批次；或依据实际内容显式调整候选类型、保留来源陈述及表达缺口。Host不会从statement猜属性名、值或规则，不会自动保存其余候选，也未认证证据语义。'}};
   if(name===NATIVE_BUILD_TOOL_NAMES.SUBMIT&&error.code==='NATIVE_EXTRACTION_EVIDENCE_FORBIDDEN'){
    try{const feedback=wrongEvidenceTypeFeedback(args);if(feedback)return {ok:true,result:feedback};}catch(feedbackError){return {ok:false,error:{code:feedbackError.code??'NATIVE_EXTRACTION_EVIDENCE_FORBIDDEN'}};}
   }
   if(name===NATIVE_BUILD_TOOL_NAMES.SCOPE&&error.code==='NATIVE_SCOPE_SURFACE_NOT_FOUND'){
    try{return {ok:true,result:missingSurfaceFeedback(error)};}catch(feedbackError){return {ok:false,error:{code:feedbackError.code??'NATIVE_SCOPE_LOCATION_FEEDBACK_FAILED'}};}
   }
   if(name===NATIVE_BUILD_TOOL_NAMES.SCOPE&&error.code==='NATIVE_SCOPE_MENTION_AMBIGUOUS'&&Array.isArray(error.occurrences)&&error.occurrences.length>0)return {ok:true,result:{accepted:false,status:'NEEDS_LOCATION',code:error.code,subject_local_ref:error.subject_local_ref,surface:error.surface,source_evidence_ref:error.source_evidence_ref,occurrence_base:0,occurrences:clone(error.occurrences),next_action:'按原文实际位置为该主体选择0起始occurrence后保存完整范围计划，或保留未决范围；尚未保存本次范围修订。'}};
   const locationTool=[NATIVE_BUILD_TOOL_NAMES.EVIDENCE,NATIVE_BUILD_TOOL_NAMES.REVIEW_EVIDENCE].includes(name);
   const unresolvedLocation=error.code==='NATIVE_EVIDENCE_QUOTE_NOT_FOUND'||error.code==='NATIVE_EVIDENCE_AMBIGUOUS'&&Array.isArray(error.occurrences)&&error.occurrences.length>0;
   if(locationTool&&unresolvedLocation)return {ok:true,result:{accepted:false,status:'NEEDS_LOCATION',code:error.code,...(error.occurrences?{occurrences:clone(error.occurrences)}:{}),next_action:'按返回的实际位置选择occurrence重新定位，或核对已读原文后留下定位缺口；尚未生成证据引用。'}};
   return {ok:false,error:{code:error.code??'NATIVE_BUILD_TOOL_FAILED',...(error.occurrences?{occurrences:clone(error.occurrences)}:{})}};
  }
 }
 function reviewInput(){need(state().extraction_complete,'NATIVE_REVIEW_EXTRACTION_REQUIRED');return admission.reviewInput();}
 function sourceRecords(){if(sourceChunkPlan){need(hash(sourceChunkPlan)===sourceChunkPlanHash,'NATIVE_HYBRID_SOURCE_PLAN_CHANGED');return createNativeHybridSourceRecords({snapshot:current(),plan:sourceChunkPlan});}return createNativeSourceRetrievalRecords({snapshot:current(),splitLargeBlocks:!!tolerant});}
 function libraryProjection(){
  const receipt=store.getRecord('native_build_library_projection_v1',runId);if(!receipt)return null;
  need(libraryKnowledgePolicy&&receipt.source_head_sha256===hash(tolerant.snapshot().knowledge)&&receipt.source_fingerprint===current().fingerprint,'NATIVE_LIBRARY_BUILD_INPUT_CHANGED');
  const projection=readNativeLibraryKnowledge({store,catalog,libraryId,snapshotId,runId,revisionRef:receipt.revision_ref});need(projection&&hash(projection)===receipt.projection_sha256&&projection.revision_ref===receipt.revision_ref&&projection.run_id===runId&&projection.library_id===libraryId&&projection.source_snapshot_ref===snapshotId,'NATIVE_LIBRARY_BUILD_PROJECTION_CHANGED');return projection;
 }
 function installLibraryKnowledge(projection){
  open();need(libraryKnowledgePolicy&&state().extraction_complete&&projection?.policy===libraryKnowledgePolicy&&projection.run_id===runId&&projection.library_id===libraryId&&projection.source_snapshot_ref===snapshotId&&Array.isArray(projection.knowledge)&&hash(readNativeLibraryKnowledge({store,catalog,libraryId,snapshotId,runId,revisionRef:projection.revision_ref}))===hash(projection),'NATIVE_LIBRARY_BUILD_PROJECTION_INVALID');
  const original=tolerant.snapshot().knowledge;need(projection.knowledge.length===currentKnowledge(original).length&&projection.knowledge.every(k=>original.some(o=>o.record_ref===k.record_ref&&o.text===k.text&&hash(o.source_refs)===hash(k.source_refs))),'NATIVE_LIBRARY_BUILD_CONTENT_CHANGED');
  const receipt={run_id:runId,library_id:libraryId,source_snapshot_ref:snapshotId,source_fingerprint:current().fingerprint,source_head_sha256:hash(original),projection_sha256:hash(projection),revision_ref:projection.revision_ref,policy:libraryKnowledgePolicy},old=store.getRecord('native_build_library_projection_v1',runId);need(!old||hash(old)===hash(receipt),'NATIVE_LIBRARY_BUILD_PROJECTION_CONFLICT');if(!old)store.putRecord('native_build_library_projection_v1',runId,receipt);return clone(receipt);
 }
 function installSemanticBase(packages){
  open();need(generalKnowledgePolicy&&packages.every(p=>p.library_id===libraryId&&p.source_snapshot_ref===snapshotId&&hash(store.getRecord('native_semantic_package_v1',p.package_ref))===hash(p)),'NATIVE_SEMANTIC_BASE_BINDING_CHANGED');
  const body={run_id:runId,source_snapshot_ref:snapshotId,package_pins:packages.map(p=>({package_ref:p.package_ref,record_sha256:p.record_sha256})),records:semanticBaseRecords({runId,packages})},value={...body,record_sha256:hash(body)},old=store.getRecord('native_semantic_base_projection_v1',runId);need(!old||hash(old)===hash(value),'NATIVE_SEMANTIC_BASE_CONFLICT');if(!old)store.putRecord('native_semantic_base_projection_v1',runId,value);return {records:body.records.length,origin_layer:'RETAINED_SEMANTIC_BASE',semantic_quality:'UNASSESSED'};
 }
 function semanticBase(){const value=store.getRecord('native_semantic_base_projection_v1',runId);if(!value)return [];const {record_sha256,...body}=value;need(generalKnowledgePolicy&&record_sha256===hash(body)&&value.package_pins.every(pin=>store.getRecord('native_semantic_package_v1',pin.package_ref)?.record_sha256===pin.record_sha256),'NATIVE_SEMANTIC_BASE_CHANGED');return clone(value.records);}
 async function buildIndexes({embed,embeddingSpace,capability='LEXICAL'}={}){open();need(state().extraction_complete,'NATIVE_BUILD_EXTRACTION_REQUIRED');if(tolerant){const projection=libraryProjection();need(!libraryKnowledgePolicy||projection,'NATIVE_LIBRARY_BUILD_PROJECTION_REQUIRED');const knowledge=projection?.knowledge??currentKnowledge(tolerant.snapshot().knowledge);return index.buildKnowledge({sources:sourceRecords(),knowledge:[...knowledge,...semanticBase()],libraryKnowledge:projection?clone(projection):null,embed,embeddingSpace,capability});}const a=admission.snapshot();need(a.review_complete&&!a.adoption_pending_confirmation,'NATIVE_BUILD_REVIEW_NOT_CONFIRMED');const facts=(a.facts??[]).map(f=>({...f,evidence:f.evidence_refs.map(output.readEvidence)}));return index.build({sources:sourceRecords(),facts,adoptionRevision:a.adoption_revision_ref,embed,embeddingSpace,capability});}
 function query(args){current();const result=index.query(args);if(args.view==='ADOPTED_FACT'){const valid=new Set((admission.snapshot().facts??[]).map(f=>f.fact_ref));if(Array.isArray(result.hits))result.hits=result.hits.filter(h=>valid.has(h.fact_ref??h.record?.fact_ref??h.record_ref));}return result;}
 function graph(args){current();const result=index.graph(args);if(args.view==='ADOPTED_FACT'){const valid=new Set((admission.snapshot().facts??[]).map(f=>f.record_ref));result.edges=result.edges.filter(e=>!e.record_ref||valid.has(e.record_ref));const connected=new Set(result.edges.flatMap(e=>[e.source,e.target]));result.nodes=result.nodes.filter(n=>(!n.record_ref||valid.has(n.record_ref))&&(connected.has(n.id)||n.kind==='ADOPTED_FACT'));}return result;}
 function snapshot(){let sourceCurrent=true;try{current();}catch(error){if(!['NATIVE_BUILD_SOURCE_STALE','NATIVE_BUILD_SOURCE_SNAPSHOT_CHANGED'].includes(error.code))throw error;sourceCurrent=false;}const recorded=admission.snapshot(),a=sourceCurrent?recorded:{...recorded,source_current:false,facts:[],effective_fact_refs:[],review_complete:false};return {run_id:runId,source_snapshot_ref:snapshotId,source_current:sourceCurrent,...clone(state()),scope:scope.snapshot(),candidates:output.snapshot().candidates,source_statements:output.snapshot().source_statements,extraction:output.snapshot(),adoption:a,...index.snapshot(),...(tolerant?tolerant.snapshot():{knowledge_build_policy:null,knowledge:[],processing_summary:null}),...(localReview?{local_review:localReview.snapshot()}:{}),...(generalKnowledgePolicy?{semantic_base:{records:semanticBase().length,origin_layer:'RETAINED_SEMANTIC_BASE',semantic_quality:'UNASSESSED'},library_knowledge:clone(libraryProjection())}:{}),review_complete:!!a.review_complete,adoption_pending_confirmation:!!a.adoption_pending_confirmation};}
 function suspendFacts(args){open();const result=admission.suspend(args);if(index.snapshot().fact_index)index.suspendFacts({factRefs:result.invalidated_fact_refs??args.fact_refs,adoptionRevision:result.adoption_revision_ref});return result;}
 function validateExtractionBatch(args){try{open();validateArguments(NATIVE_EXTRACTION_BATCH_SCHEMA,args);need(!state().extraction_complete,'NATIVE_EXTRACTION_ALREADY_FINISHED');return {ok:true,result:output.validateBatch(args)};}catch(error){return {ok:false,error:{code:error.code??'NATIVE_BUILD_TOOL_FAILED'}};}}
 function programPartialFinish(context){open();need(tolerant&&localReview&&extractionStagePolicy==='SEMANTIC_THEN_ORGANIZE_V1','NATIVE_PROGRAM_PARTIAL_STAGE_FORBIDDEN');const budget=readExtractionBudget(),head=tolerant.snapshot();need(budget.settled&&budget.open&&context.native_completion?.status==='completed','NATIVE_PROGRAM_PARTIAL_REQUESTS_UNSETTLED');if(!head.knowledge.length)return {partial:false,saved_output:false};const s=state(),review=localReview.snapshot(),reason=context.reason??'NATIVE_ROLE_OUTPUT_NOT_SAVED';store.transaction(()=>{store.putRecord('native_extraction_local_review_v1',runId,{...review,phase:'FINISHED',review_performed:false,review_status:'PROGRAM_PARTIAL_NATIVE_ENDED',program_partial:true});store.putRecord('native_build_state_v1',runId,{...s,extraction_complete:true,partial:true,program_partial_intent:clone(context),gaps:[...(s.gaps??[]),reason],completion:knowledgeCompletion({knowledge:head.knowledge,gaps:[reason],windowClosed:true,localReview:{...review,review_performed:false}})});});return {partial:true,saved_output:true,reason,knowledge_sha256:hash(head.knowledge),saved_items:head.knowledge.length};}
 return {rebindMissingEntities:proposals=>{open();need(tolerant,'NATIVE_PROGRAM_REBIND_POLICY_REQUIRED');return tolerant.rebindMissingEntities(proposals);},programPartialFinish,installLibraryKnowledge,installSemanticBase,definitions,argumentPolicy:tolerant?businessArgumentPolicy([NATIVE_BUILD_TOOL_NAMES.SCOPE,NATIVE_BUILD_TOOL_NAMES.SUBMIT,NATIVE_BUILD_TOOL_NAMES.FINISH],{retainBusinessOutput:true}):null,call,snapshot,readProgressSnapshot:()=>localReview?.view.progressSnapshot(),assertCurrentRead:open,noteImportedOrganizationDraft:()=>{open();localReview?.noteSaved();},beginImportedOrganizationReview:()=>{open();need(localReview,'NATIVE_ORGANIZATION_DRAFT_REVIEW_REQUIRED');return localReview.beginImportedReview();},reviewInput,validateExtractionBatch,bindPlannedWindow:plan=>{open();return recordReads(windows.bindPlan(plan));},ingestWindow:args=>{current();need(tolerant,'NATIVE_KNOWLEDGE_POLICY_REQUIRED');return tolerant.ingestWindow(args);},bindInputContext:args=>{open();need(tolerant,'NATIVE_KNOWLEDGE_POLICY_REQUIRED');return tolerant.bindInputContext(args);},recordReviewInvocation:receipt=>{open();return admission.recordReviewInvocation(receipt);},confirmReviewInvocation:receipt=>{open();return admission.confirmReviewInvocation(receipt);},buildIndexes,query,graph,suspendFacts};
}

/** Retrieval granularity is independent of parser blocks and extraction windows. */
export function createNativeSourceRetrievalRecords({snapshot,maxChars=3000,maxEvidence=64,splitLargeBlocks=false}) {
 need(snapshot?.snapshot_id&&Array.isArray(snapshot.documents)&&Number.isSafeInteger(maxChars)&&maxChars>0&&Number.isSafeInteger(maxEvidence)&&maxEvidence>0,'NATIVE_SOURCE_RETRIEVAL_INPUT_INVALID');
 const policy={version:'native-source-adjacent-blocks/1',max_chars:maxChars,max_evidence:maxEvidence,heading_preference_min_chars:Math.min(1000,maxChars)};
 return snapshot.documents.flatMap(d=>{
  const records=[];let blocks=[];
  function flush(){if(!blocks.length)return;const start=blocks[0].start,end=blocks.at(-1).end,text=d.content.slice(start,end),evidence=blocks.map(b=>({evidence_ref:'source_index_evidence_'+hash([snapshot.snapshot_id,d.doc_id,d.revision,b]),block_id:b.block_id,doc_ref:d.doc_id,revision:d.revision,start:b.start,end:b.end,quote:d.content.slice(b.start,b.end),offset_unit:'utf16_code_unit',provenance:clone(b.provenance??[])}));const spans=evidence.map(({quote,provenance,...span})=>span);records.push({record_ref:'source_record_'+hash([snapshot.snapshot_id,d.doc_id,d.revision,blocks.map(b=>b.retrieval_fragment?[b.block_id,b.start,b.end]:b.block_id),policy]),representation:'VERBATIM_SOURCE',answer_authority:'SOURCE_QUOTE',text,source_refs:[{doc_ref:d.doc_id,revision:d.revision}],source_spans:spans,evidence_refs:evidence.map(e=>e.evidence_ref),evidence,conditions:[],source_snapshot_ref:snapshot.snapshot_id,parser:d.parser??null,text_policy:clone(policy)});blocks=[];}
  let previous=0;const ids=new Set();
  for(const b of d.blocks){need(textField(b.block_id)&&!ids.has(b.block_id)&&Number.isSafeInteger(b.start)&&Number.isSafeInteger(b.end)&&b.start>=previous&&b.end>b.start&&b.end<=d.content.length,'NATIVE_SOURCE_RETRIEVAL_SPAN_INVALID');ids.add(b.block_id);previous=b.end;
   if(b.end-b.start>maxChars){
    if(!splitLargeBlocks)throw Object.assign(Error('NATIVE_SOURCE_RETRIEVAL_BLOCK_TOO_LARGE'),{code:'NATIVE_SOURCE_RETRIEVAL_BLOCK_TOO_LARGE',doc_ref:d.doc_id,block_id:b.block_id,required_chars:b.end-b.start,max_chars:maxChars});
    need(maxChars>=2,'NATIVE_SOURCE_RETRIEVAL_INPUT_INVALID');flush();
    for(let start=b.start;start<b.end;){let end=Math.min(b.end,start+maxChars);if(end<b.end&&/[\uD800-\uDBFF]/.test(d.content[end-1]))end--;blocks=[{...b,start,end,retrieval_fragment:true}];flush();start=end;}
    continue;
   }
   const existingChars=blocks.length?blocks.at(-1).end-blocks[0].start:0,heading=/heading|title|section_header/.test(b.kind??'');
   if(blocks.length&&(blocks.length>=maxEvidence||b.end-blocks[0].start>maxChars||heading&&existingChars>=policy.heading_preference_min_chars))flush();blocks.push(b);
  }flush();return records;
 });
}

/** Validate exactly the published tool shape before dispatch; no second shadow schema. */
export function validateArguments(schema,value,path='$') {
 if(schema.enum)need(schema.enum.some(x=>Object.is(x,value)),'NATIVE_TOOL_ARGUMENT_INVALID');
 const types=Array.isArray(schema.type)?schema.type:[schema.type];const type=value===null?'null':Array.isArray(value)?'array':typeof value==='number'&&Number.isInteger(value)?'integer':typeof value;
 need(!schema.type||types.includes(type)||(type==='integer'&&types.includes('number')),'NATIVE_TOOL_ARGUMENT_INVALID');
 if(value===null)return;
 if(type==='object'){need((schema.required??[]).every(k=>Object.hasOwn(value,k)),'NATIVE_TOOL_ARGUMENT_REQUIRED');for(const [k,v]of Object.entries(value)){need(schema.additionalProperties!==false||Object.hasOwn(schema.properties??{},k),'NATIVE_TOOL_ARGUMENT_UNKNOWN');if(schema.properties?.[k])validateArguments(schema.properties[k],v,path+'.'+k);}}
 if(type==='array'){need((schema.minItems===undefined||value.length>=schema.minItems)&&(schema.maxItems===undefined||value.length<=schema.maxItems),'NATIVE_TOOL_ARGUMENT_INVALID');if(schema.uniqueItems)need(new Set(value.map(hash)).size===value.length,'NATIVE_TOOL_ARGUMENT_INVALID');if(schema.items)value.forEach(v=>validateArguments(schema.items,v,path+'[]'));}
 if(type==='string')need(value.isWellFormed()&&(schema.minLength===undefined||value.length>=schema.minLength)&&(schema.maxLength===undefined||value.length<=schema.maxLength),'NATIVE_TOOL_ARGUMENT_INVALID');
 if(type==='integer'||type==='number')need(Number.isFinite(value)&&(schema.minimum===undefined||value>=schema.minimum)&&(schema.maximum===undefined||value<=schema.maximum),'NATIVE_TOOL_ARGUMENT_INVALID');
}
