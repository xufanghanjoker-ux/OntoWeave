/** Authored synthetic fixtures. Semantic/organization proposals are NOT actual model outputs. */
export const actionExampleSources = [
  {key:'maintenance-plan', kind:'HUMAN_TEXT', text:'检修单 MAINT/42：泵 P7 在低负载时渗漏为 2 mL/h。工程师建议更换密封，安排 11 月 14 日更换，尚未动手。'},
  {key:'maintenance-execution', kind:'TOOL_RECEIPT', text:'检修单 MAINT/42，泵 P7：11 月 15 日由技师林完成密封更换；回执 step-9 显示更换步骤成功，尚未复测。', metadata:{receipt:{receipt_ref:'step-9'}, reporter:{role:'tool'}}},
  {key:'maintenance-feedback', kind:'DOCUMENT', text:'检修单 MAINT/42，泵 P7：更换密封后 24 小时在低负载下复测，渗漏仍为 2 mL/h，噪声由 60 dB 升至 64 dB。工程师说“未达标”，但未给出判定标准。'},
  {key:'irrigation', kind:'HUMAN_TEXT', text:'试验 IRR/A-3，东站 A 畦，干旱条件：尝试滴灌 10 分钟，阀门卡住后中止，操作失败。土壤含水率未测，不知道是否改善。'},
  {key:'other-irrigation', kind:'DOCUMENT', text:'西站试验 IRR/A-3，B 畦：本次观察含水率 24%。该编号不属于东站试验。'},
  {key:'conservation', kind:'AGENT_REPORT', text:'馆藏 R8 清洁记录：我已完成表面清洁，没有附工具回执。我认为颜色更亮，但尚未测量，也未说明光照条件。'},
  {key:'approval', kind:'DOCUMENT', text:'项目 J21 于 11 月 1 日计划提交审批。11 月 10 日说明仍未提交；主管建议先补充可行性说明。'},
];

/** Host assigns refs; this function only constructs authored fixture content around those refs. */
export function actionExampleInput(sourceRecords, requestId = 'authored-cross-domain-v1') {
  const source = new Map(sourceRecords.map((record, index) => [actionExampleSources[index].key, record]));
  const semantics = [], proposals = [];
  function item(key, category, text, business, extras = {}) {
    const raw = source.get(key), local = extras.local ?? category + '-' + semantics.length;
    const semantic = {semantic_ref:'sem-' + local, library_id:raw.library_id, text,
      ...(business.action_phase ? {action_phase:business.action_phase} : {}),
      evidence:[{source_record_ref:raw.source_record_ref, revision:raw.revision, quote:raw.text}]};
    semantics.push(semantic);
    proposals.push({local_ref:local, category, text, business, semantic_refs:[semantic.semantic_ref],
      ...extras});
  }
  item('maintenance-plan','state','泵 P7 低负载时渗漏 2 mL/h。',{subject:'泵 P7',property:'渗漏',value:2,unit:'mL/h'},{local:'pump-before',conditions:['低负载']});
  item('maintenance-plan','action','工程师建议更换泵 P7 密封，尚未执行。',{action_phase:'SUGGESTED',subject:'泵 P7'},{local:'pump-suggestion'});
  item('maintenance-plan','action','计划 11 月 14 日更换泵 P7 密封。',{action_phase:'PLANNED',subject:'泵 P7'},{local:'pump-plan',time_text:'11 月 14 日'});
  item('maintenance-execution','action','技师林于 11 月 15 日完成泵 P7 密封更换；操作回执成功，尚未复测。',
    {action_phase:'COMPLETED',label:'泵 P7 密封更换',participants:[{role:'执行者',subject_ref:'technician-lin'},{role:'作用对象',subject_ref:'pump-P7'}],execution_result:'更换步骤成功',effect_gap:'尚未复测'},
    {local:'pump-executed',time_text:'11 月 15 日'});
  item('maintenance-feedback','observation','更换后 24 小时低负载复测，泵 P7 渗漏仍为 2 mL/h。',
    {subject:'泵 P7',property:'渗漏',value:2,unit:'mL/h',method:'复测',comparison:'无变化'},
    {local:'pump-leak',conditions:['低负载'],time_text:'更换密封后 24 小时'});
  item('maintenance-feedback','observation','更换后复测噪声由 60 dB 升至 64 dB。',
    {subject:'泵 P7',property:'噪声',before:60,value:64,unit:'dB',reported_cost:'噪声升高'},
    {local:'pump-noise',conditions:['低负载'],time_text:'更换密封后 24 小时'});
  item('maintenance-feedback','evaluation','工程师称本次未达标；标准未给出。',
    {evaluator:'工程师',verdict:'未达标',basis_refs:['pump-leak'],criteria:null},{local:'pump-evaluation'});
  item('irrigation','action','东站 A 畦干旱条件下尝试滴灌 10 分钟，阀门卡住后中止，操作失败；含水率未测。',
    {action_phase:'FAILED',subject:'东站 A 畦',duration:'10 分钟',execution_result:'阀门卡住后中止',effect_gap:'含水率未测'},
    {local:'irrigation-failed',conditions:['干旱'],uncertainties:['业务效果未知']});
  item('other-irrigation','observation','西站 B 畦本次试验含水率 24%，与东站同号试验不同。',
    {subject:'西站 B 畦',property:'含水率',value:24,unit:'%'},{local:'irrigation-other'});
  item('conservation','action','Agent 自报已完成馆藏 R8 表面清洁，未附执行回执。',
    {action_phase:'COMPLETED',subject:'馆藏 R8',evidence_gap:'无工具回执'},{local:'conservation-report',verified:true,origin:'DIRECT_OBSERVATION'});
  item('conservation','observation','Agent 认为颜色更亮；未测量且光照条件未知。',
    {subject:'馆藏 R8',property:'颜色',value:'更亮',method:null},{local:'conservation-color',uncertainties:['光照条件未知','未测量']});
  item('approval','action','项目 J21 计划于 11 月 1 日提交审批。',
    {action_phase:'PLANNED',subject:'项目 J21'},{local:'approval-plan',time_text:'11 月 1 日'});
  item('approval','action','截至 11 月 10 日，项目 J21 仍未提交审批。',
    {action_phase:'COMPLETED',subject:'项目 J21'},{local:'approval-not-submitted',negation:true,time_text:'11 月 10 日'});
  item('approval','action','主管建议先补充项目 J21 可行性说明。',
    {action_phase:'SUGGESTED',subject:'项目 J21'},{local:'approval-suggestion'});
  return {libraryId:sourceRecords[0].library_id, requestId, sourceRecords, semanticItems:semantics, proposals};
}

export const actionExampleExpectations = {
  evidence_layer:'AUTHORED_SYNTHETIC_NOT_MODEL_OUTPUT', sources:7, proposals:14,
  preserve:['原话与确切版本','参与角色','操作成功与尚未复测','无变化','噪声副作用','失败与未测','未给标准','计划未提交','未知时间'],
  must_not_infer:['工具步骤成功证明业务改善','Agent 自报成为直接观测','同号跨站试验合并','后补观测覆盖旧记录','先后关系成为因果'],
};

export function actionExampleStandaloneSources(libraryId = 'isolated-action-fixture') {
  return actionExampleSources.map((source, index) => ({source_record_ref:'original-' + index,
    library_id:libraryId, revision:'1', text:source.text, source_kind:source.kind,
    source_ingested_at:'2026-11-13T08:00:00.000Z', reporter:source.metadata?.reporter ?? null,
    receipt:source.metadata?.receipt ?? null}));
}
