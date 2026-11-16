/** Display projection of durable host observations, never an estimated percent. */
export function projectProductProcessing({progress,review,jobs,graph,candidatePreview=null,sources=[],sourceEpoch}) {
  const current=r=>sourceEpoch===undefined||(r.source_snapshot?.source_epoch??r.job?.snapshot?.source_epoch)===sourceEpoch;
  const rows=(progress?.items??[]).filter(current),active=rows.filter(r=>['QUEUED','RUNNING','WAIT_MODEL_CONFIGURATION'].includes(r.queue_status));
  const row=active[0]??rows[0],stage=row?.stage??'QUEUED';
  const fullRows=rows.filter(r=>r.is_correction!==true&&!r.policy_version?.includes('correction'));
  const scanRow=fullRows.find(r=>['QUEUED','RUNNING'].includes(r.queue_status))??fullRows[0];
  const labels={CANDIDATE_ATTRIBUTE_INVALID:'属性类型与对象或方向不一致，需程序修复',CANDIDATE_RELATION_INVALID:'关系对象或方向不符合结构要求，需程序修复',SOURCE_LEARNING_BASE_GRAPH_MISSING:'首次建图提交受阻：当前没有基础图，等待恢复提交'};
  const diagnosticRows=(review?.diagnostics??[]).map(d=>({...d,message:d.resolved===true?'结构表示已修复；原失败记录保留':d.message??d.label??labels[d.error_code??d.code]??'此项处理暂未完成'})),reviewItems=review?.items??[];
  const open=reviewItems.filter(r=>['MENTION_SCOPE','SEMANTIC_CANDIDATE'].includes(r.kind)&&['OPEN','DEFERRED'].includes(r.status)&&r.actions?.length>0);
  const applicationBlocked=reviewItems.filter(r=>r.status==='APPLY_BLOCKED');
  const unknown=(jobs?.items??[]).filter(current).some(r=>r.job?.attempts?.some(a=>a.outcome==='UNKNOWN'));
  const technical=diagnosticRows.filter(d=>d.resolved!==true);
  const technicalCount=technical.length+applicationBlocked.length;
  const publication=scanRow?.publication_assessment,unrepresented=publication?.coverage?.sources_without_candidates??[],coverageGap=Array.isArray(unrepresented)?unrepresented.length:0;
  const batches=scanRow?.batches??{},candidates=row?.candidates??{};
  const scanDone=fullRows.some(r=>['COMPLETED','COMPLETED_WITH_ISSUES','NO_CANDIDATES'].includes(r.scan_status));
  const candidateReady=candidatePreview?.status==='CANDIDATE_PREVIEW'||(candidatePreview?.status==='READY'&&candidatePreview.retrieval_available===true)||(graph?.status==='READY'&&graph.publication_status!=='PUBLISHED'&&graph.retrieval_available===true);
  const candidateIndexed=(scanRow?.index_status==='READY'&&Boolean(scanRow.graph_revision))||(graph?.index_status==='READY'&&graph?.status==='READY'&&graph?.publication_status!=='PUBLISHED'&&graph?.retrieval_available===true)||(candidatePreview?.status==='READY'&&candidatePreview.index_status==='READY'&&candidatePreview.retrieval_available===true);
  const graphReady=graph?.publication_status==='PUBLISHED'&&Boolean(graph?.published_graph_revision)&&graph?.status==='READY'&&graph?.index_status==='READY';
  const currentPublicationReady=graphReady&&(sourceEpoch===undefined||graph.snapshot?.source_epoch===sourceEpoch);
  const publicationComplete=currentPublicationReady&&scanDone;
  const paused=!scanDone&&['WAIT_REVIEW','WAIT_EVIDENCE','FAILED','STOPPED'].includes(stage);
  const diagnostic=unknown?'调用结果尚未确认，已保留进度，系统不会盲目重发。':technicalCount?'部分内容处理受阻，已保留返回结果；这不等于知识发生冲突。':open.length?'有少量知识指向需要你判断，其余内容继续处理。':null;
  const p=(id,label,status,completed=null,total=null,unit=null,message=null)=>({id,label,status,completed,total,unit,message});
  const phases=[
    p('PARSE','读取资料',sources.length?'COMPLETE':'PENDING',sources.length,sources.length,'份资料'),
    p('EXTRACT','抽取知识联系',scanDone||['VALIDATING','INDEX_PENDING','COMPLETED'].includes(scanRow?.stage)?'COMPLETE':unknown||paused?'PAUSED':['EXTRACTING','RETRIEVING'].includes(scanRow?.stage)?'RUNNING':'PENDING',batches.materialized??null,batches.planned??null,'批',diagnostic),
    p('ORGANIZE','整理候选与待确认事项',open.length?'WAITING_HUMAN':applicationBlocked.length?'PAUSED':scanDone||['INDEX_PENDING','COMPLETED'].includes(stage)?'COMPLETE':stage==='VALIDATING'?'RUNNING':paused&&open.length?'WAITING_HUMAN':'PENDING',candidates.staged??null,scanDone?candidates.staged??null:null,'条候选'),
    p('INDEX','建立候选检索索引',candidateIndexed?'COMPLETE':stage==='INDEX_PENDING'?'RUNNING':'PENDING',null,null,null,candidateReady&&!candidateIndexed?'候选图已保留，检索索引尚未就绪。':null),
    p('READY','发布正式图谱',publicationComplete?'COMPLETE':open.length?'WAITING_HUMAN':technicalCount||coverageGap||unknown?'PAUSED':'PENDING',null,null,null,!publicationComplete&&graphReady&&!currentPublicationReady?'当前可查看旧版正式图，新版整理完成后再发布。':!graphReady&&open.length?'有 '+open.length+' 项知识含义待你判断，处理后继续核实；满足全部发布条件后才能发布。':!graphReady&&unknown?'上次调用结果尚未确认，当前版本暂不发布。':!graphReady&&technicalCount?'发布受阻：'+(technical[0]?.message??'人工决定的应用尚未完成')+'。'+(candidateReady?'其他候选已保留，可预览候选图；':'')+'当前资料版本暂不发布。':!graphReady&&coverageGap?'有 '+coverageGap+' 份资料尚无候选或明确的无相关事实记录，当前版本暂不发布。':null)
  ];
  const status=unknown?'RESULT_UNKNOWN':active.length?(graphReady?'UPDATING':'PROCESSING'):graphReady?(scanDone?(open.length||technicalCount?'READY_WITH_ISSUES':'READY'):'PARTIAL_READY'):paused?(open.length?'WAITING_HUMAN':technicalCount?'TECHNICAL_HOLD':'WAITING_PROCESSING'):candidateReady?(scanDone?(open.length||technicalCount||coverageGap?'CANDIDATES_READY_WITH_ISSUES':'CANDIDATES_READY'):'PARTIAL_CANDIDATES'):scanDone?'PROCESSED_WITH_ISSUES':'QUEUED';
  return {status,current_phase:phases.find(p=>['RUNNING','PAUSED','WAITING_HUMAN'].includes(p.status))?.id??(graphReady?'READY':'EXTRACT'),phases,
    issues:{actionable:open.length,technical:technicalCount,coverage:coverageGap,application_blocked:applicationBlocked.length,isolated:candidates.quarantined??0},graph_ready:publicationComplete,graph_available:graphReady,candidate_graph_available:candidateReady,
    graph_revision:graphReady?graph.graph_revision:scanRow?.graph_revision??candidatePreview?.graph_revision??graph?.graph_revision??null,index_status:candidateIndexed?'READY':graph?.index_status??'NONE',diagnostics:diagnosticRows,
    source_scan_complete:scanDone,all_candidates_semantically_confirmed:false};
}
