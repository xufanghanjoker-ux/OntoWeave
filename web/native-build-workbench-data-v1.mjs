/** Display-only projection of saved native artifacts. Never starts work or infers correctness. */
const list=value=>Array.isArray(value)?value:[];
const text=value=>typeof value==='string'?value:value===undefined||value===null?'':typeof value==='object'?JSON.stringify(value):String(value);
const label=value=>typeof value==='string'?value:value?.label??value?.name??value?.message??value?.code??text(value);
const unique=items=>[...new Set(items.filter(Boolean))];
export const NATIVE_BUILD_STAGES=[
 ['sources','资料与解析','保留原件与解析正文'],['chunks','统一分块','Docling 分块与工作窗口'],['cq','CQ','从资料中发现的问题'],['families','问题族','相同知识目标的问法'],
 ['scope','范围计划','本轮知识目标与限定'],['semantic','语义草稿','资料理解与保留不确定处'],['knowledge','知识组织','表达、来源与审阅建议'],['graph','图与索引','已保存图与索引读回']
];
export const nativeSavedStatus=value=>({STARTING:'准备中',OPEN:'等待执行',RUNNING:'处理中',SUCCEEDED:'执行完成',READY:'索引就绪',COMPLETED:'处理完成',PARTIALLY_READY:'部分知识可用',FAILED:'执行失败',UNKNOWN_HOLD:'请求结果未确认',STALE:'资料已变化',NOT_STARTED:'尚未开始',PARTIAL_DRAFT:'部分草稿已保存',SAVED_SETTLED:'已保存',REUSED_SAVED_SETTLED:'沿用已保存草稿',RETURNED:'已返回',UNASSESSED:'尚未评估',PLANNED:'已规划',PARTIAL:'部分覆盖',COMPLETE:'覆盖已记录',SOURCE_INSUFFICIENT:'资料不足',UNRESOLVED:'尚待明确',NOT_APPLICABLE:'不适用'}[value]??value??'尚未记录');
export function nativeSemanticItems(read){
 const items=[],fragments=new Map();for(const page of list(read?.pages))for(const item of list(page.items)){
  if(item.fragment_json===undefined)items.push(item);else{const f=fragments.get(item.semantic_ref)??{text:'',complete:false};f.text+=item.fragment_json;f.complete=item.complete;fragments.set(item.semantic_ref,f);}
 }
 for(const [semantic_ref,f]of fragments){if(f.complete){try{items.push(JSON.parse(f.text));continue;}catch{}}items.push({semantic_ref,text:'本条草稿较长，继续读取后可查看完整内容。'});}
 return items;
}
export function projectNativeBuildWorkbench(state={}){
 const run=state.nativeRun??{},snapshot=run.snapshot??{},build=snapshot.build??{},library=state.productView?.library??{},sources=list(library.sources),cq=snapshot.cq_input??snapshot.cq?.cq_input??snapshot.cq??{},questions=list(cq.items),questionMap=new Map(questions.map(q=>[q.cq_ref,q])),family=snapshot.families??snapshot.family??{},families=list(family.families),scope=build.scope??{},semantic=list(snapshot.semantic_stages),artifact=state.nativeArtifacts??{},kind=state.nativeChunkKind??'windows',chunkPage=artifact[kind],rows={};
 const sourceNames=new Map();for(const s of run.source_current===false?[]:sources)for(const ref of [s.key,s.id,s.source_id,s.source_ref,s.document_id,s.doc_ref])if(ref)sourceNames.set(ref,s.title??s.name??'资料');
 const originQuestionMap=new Map(questionMap),familyInput=snapshot.family_input??{},familyItems=list(familyInput.items);for(const q of familyItems)if(!questionMap.has(q.cq_ref))questionMap.set(q.cq_ref,q);
 const questionTarget=ref=>originQuestionMap.has(ref)?ref:originQuestionMap.has(familyInput.mapping?.[ref]?.origin_cq_ref)?familyInput.mapping[ref].origin_cq_ref:ref;
 for(const d of list(artifact.documents?.items))if(d.doc_ref)sourceNames.set(d.doc_ref,d.title??d.name??'资料');
 const refsLabel=refs=>unique(list(refs).map(ref=>sourceNames.get(typeof ref==='string'?ref:ref.doc_ref??ref.source_ref)??(typeof ref==='string'?ref:ref.filename??ref.doc_ref??ref.source_ref))).join(' · ');
 const row=(id,title,subtitle,record,extra={})=>({id:String(id),title:text(title),subtitle:text(subtitle),record,...extra});
 const docs=list(artifact.documents?.items);
 rows.sources=(docs.length?docs:run.source_current===false?[]:sources).map((s,i)=>row(s.doc_ref??s.key??s.id??'doc-'+i,s.title??s.name??'资料 '+(i+1),s.parser?.name??s.parsing?.parser??(s.document_id?'Docling 已解析':'保留正文'),s,{sourceLabel:s.title??s.name??'资料'}));
 const draftWindows=list(snapshot.chunked_cq?.chunks),work=list(snapshot.extraction_windows?.windows);
 const fallbackChunks=draftWindows.length?draftWindows:work;
 const chunkItems=chunkPage?list(chunkPage.items):kind==='windows'?fallbackChunks:[],zeroBased=chunkItems.some(c=>c.ordinal===0);
 rows.chunks=chunkItems.map((c,i)=>row(c.window_ref??c.chunk_ref??c.ref??'chunk-'+i,(c.title??sourceNames.get(c.doc_ref)??'资料')+' · '+(kind==='windows'?'窗口':'分块')+' '+(Number.isInteger(c.ordinal)?c.ordinal+(zeroBased?1:0):i+1),list(c.headings).map(label).join(' / ')||nativeSavedStatus(c.status??c.draft?.status),c,{sourceLabel:sourceNames.get(c.doc_ref)??c.title,body:c.contextualized_text??c.text??c.draft?.source_text??'',hasBody:typeof(c.contextualized_text??c.text)==='string'}));
 const mapping=list(snapshot.chunked_cq?.merge?.mapping);
 rows.cq=questions.map((q,i)=>row(q.cq_ref??'cq-'+i,q.question,refsLabel(q.source_refs)||q.source_hint||'来源尚未提供',q,{lineage:mapping.find(m=>m.cq_ref===q.cq_ref),sourceLabel:refsLabel(q.source_refs)}));
 const requestedQuestion=state.nativeWorkbenchSelection?.cq;if(requestedQuestion&&!originQuestionMap.has(requestedQuestion)&&questionMap.has(requestedQuestion)){const q=questionMap.get(requestedQuestion);rows.cq.unshift(row(q.cq_ref,q.question,'归族输入中的已保存问句',q,{sourceLabel:refsLabel(q.source_refs)}));}
 rows.families=families.map((f,i)=>row(f.family_ref??f.id??'family-'+i,f.name??f.representative_question??'问题族 '+(i+1),list(f.member_refs).length+' 个成员问题',f,{members:list(f.member_refs).map(ref=>({...questionMap.get(ref),cq_ref:ref,target_ref:questionTarget(ref),question:questionMap.get(ref)?.question??'此历史产物未附成员问句',available:questionMap.has(ref)}))}));
 rows.scope=list(scope.tasks).map((t,i)=>row(t.task_ref??t.local_ref??'task-'+i,t.requirement??t.module??'知识目标 '+(i+1),nativeSavedStatus(list(scope.coverage).find(c=>c.task_ref===t.task_ref)?.status??t.coverage_status??'UNASSESSED'),t,{questions:list(t.cq_refs).map(ref=>questionMap.get(ref)??{cq_ref:ref,question:'此历史产物未附问题正文'}),coverage:list(scope.coverage).find(c=>c.task_ref===t.task_ref),sourceLabel:refsLabel(t.source_refs)}));
 for(const [index,d]of list(scope.cq_dispositions).entries())if(!list(d.task_refs).length){const question=questionMap.get(d.cq_ref);rows.scope.push(row('disposition-'+(d.cq_ref??index),question?.question??'未映射的问题归属 '+(index+1),nativeSavedStatus(d.status)+' · '+(d.reason??'尚未记录原因'),d,{scopeKind:'disposition',question,questions:question?[question]:[],sourceLabel:question?refsLabel(question.source_refs):''}));}
 rows.semantic=semantic.map((s,i)=>row(s.window_ref??'semantic-'+i,'窗口 '+(i+1),nativeSavedStatus(s.semantic?.status)+' · '+(s.semantic?.items??0)+' 条语义草稿',s,{semanticItems:state.nativeSemanticRead?.window_ref===s.window_ref?nativeSemanticItems(state.nativeSemanticRead):[],semanticRead:state.nativeSemanticRead?.window_ref===s.window_ref?state.nativeSemanticRead:null}));
 const knowledge=list(build.knowledge).length?build.knowledge:list(snapshot.partial_organization?.knowledge).length?list(snapshot.partial_organization.knowledge):list(build.candidates);
 const knowledgeMap=new Map();for(const [i,k]of knowledge.entries()){const id=k.knowledge_ref??k.record_ref??k.candidate_ref??'knowledge-'+i;if(!knowledgeMap.has(id))knowledgeMap.set(id,k);}
 const objectNames=new Map(list(scope.subjects).map(s=>[s.subject_ref,s.surface??s.name]));for(const k of knowledge)for(const e of list(k.domain?.entities))if(e.id&&e.name)objectNames.set(e.id,e.name);
 const kindNames={ENTITY:'对象',RELATION:'关系',ATTRIBUTE:'属性',RULE:'规则',TEXT:'知识陈述',DEFINITION:'定义'};
 rows.knowledge=[...knowledgeMap].map(([id,k])=>{const own=list(k.domain?.entities).find(e=>e.id===k.subject_ref),title=k.kind==='ENTITY'?(own?.name??k.name??k.statement??k.text):k.statement??k.text??k.rule_text??k.name??'知识陈述';return row(id,title,(kindNames[k.kind]??k.kind??'知识')+' · '+(refsLabel(k.source_refs)||'来源详情待展开'),k,{sourceLabel:refsLabel(k.source_refs),description:k.kind==='ENTITY'?own?.description:null});});
 rows.graph=[];
 const reviews=list(run.program_output_recovery?.relation_reviews),suggestions=reviews.flatMap((review,reviewIndex)=>list(review.findings).map((finding,index)=>({id:'review-'+reviewIndex+'-'+index,finding,review}))),processing=build.processing_summary??{},warningRows=list(processing.items).filter(item=>list(item.warnings).length||item.status==='SKIPPED'||item.reason),warnings=Number.isSafeInteger(processing.warnings)?processing.warnings:unique(knowledge.flatMap(k=>list(k.warnings))).length;
 const pending=list(snapshot.run?.attempts).filter(a=>a.outcome==='RESERVED'),pendingRoles=new Set(pending.map(a=>a.role));
 const stages=NATIVE_BUILD_STAGES.map(([id,title,description])=>{
  let count=rows[id].length,status=count?'已保存':'暂无产物';
  if(id==='chunks')count=chunkPage?.summary?.total_items??(kind==='windows'?snapshot.chunk_plan_summary?.window_count:snapshot.chunk_plan_summary?.chunk_count)??rows.chunks.length;
  if(id==='semantic')count=semantic.reduce((n,s)=>n+Number(s.semantic?.items??0),0);
  if(id==='graph'){const indexes=[build.knowledge_index,build.source_index,build.fact_index].filter(Boolean);count=indexes.filter(index=>index.status==='READY').length;status=count?'索引已保存':'尚无索引';}
  else if(count)status='已保存';
  const active=id==='cq'&&pendingRoles.has('CQ')||id==='families'&&pendingRoles.has('FAMILY')||id==='scope'&&pendingRoles.has('SCOPE')||['semantic','knowledge'].includes(id)&&pendingRoles.has('EXTRACTION')||id==='graph'&&pending.some(a=>a.kind==='EMBEDDING');
  if(active)status=count?'处理中 · 已保留部分':'处理中';
  if(id==='cq'&&snapshot.chunked_cq?.status&&!['COMPLETED','SUCCEEDED'].includes(snapshot.chunked_cq.status))status=count?'部分已保存':nativeSavedStatus(snapshot.chunked_cq.status);
  if(id==='semantic'&&semantic.some(s=>['UNKNOWN_HOLD','RUNNING','PARTIAL_DRAFT','FAILED'].includes(s.semantic?.status)))status='含'+nativeSavedStatus(semantic.find(s=>['UNKNOWN_HOLD','RUNNING','PARTIAL_DRAFT','FAILED'].includes(s.semantic?.status)).semantic.status);
  if(id==='knowledge'&&semantic.some(s=>['UNKNOWN_HOLD','RUNNING','PARTIAL_DRAFT','FAILED'].includes(s.organization?.status)))status='含'+nativeSavedStatus(semantic.find(s=>['UNKNOWN_HOLD','RUNNING','PARTIAL_DRAFT','FAILED'].includes(s.organization?.status)).organization.status);
  if(run.status==='UNKNOWN_HOLD'&&['semantic','knowledge','graph'].includes(id))status=count?'部分保存 · 请求未确认':'请求未确认';
  if(id==='graph'&&snapshot.extraction_windows?.windows?.some(w=>!['COMPLETED','SUCCEEDED','RETURNED','REUSED'].includes(w.status))&&count)status='索引已保存 · 含缺口';
  if(id==='chunks'&&chunkPage?.available===false)status=count?'仅有历史计数':'正文未保留';
  return {id,title,description,count,status};
 });
 const selectedStage=NATIVE_BUILD_STAGES.some(([id])=>id===state.nativeWorkbenchStage)?state.nativeWorkbenchStage:rows.knowledge.length?'knowledge':rows.families.length?'families':'sources';
 const query=text(state.nativeWorkbenchQuery?.[selectedStage]).trim().toLocaleLowerCase(),all=rows[selectedStage],filtered=all.filter(r=>!query||[r.title,r.subtitle,r.sourceLabel,text(r.record)].join(' ').toLocaleLowerCase().includes(query));
 const selectedId=state.nativeWorkbenchSelection?.[selectedStage],selected=filtered.find(r=>r.id===selectedId)??filtered[0]??null;
 return {run,snapshot,build,library,sources,sourceNames,objectNames,stages,stage:selectedStage,rows,filtered,query,selected,chunkKind:kind,chunkPage,artifact,suggestions,reviews,processing,warningRows,warnings,questions,families,unassigned:list(family.unassigned),knowledgeCount:knowledgeMap.size};
}
