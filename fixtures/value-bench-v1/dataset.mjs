/** Original synthetic developer fixtures. Gold is DRAFT, not independently adjudicated. */
export const datasetId = 'value-bench-v1';
const groups = [
  { id:'support',names:['澄湾支持','松原支持','晴川支持'],noun:'客户支持',region:'欧洲',other:'亚洲',old:12,next:16 },
  { id:'testing',names:['云杉检测','蓝岬检测','星桥检测'],noun:'设备检测',region:'东南亚',other:'拉美',old:8,next:11 },
];
export function makeDataset() {
  return { id:datasetId,synthetic:true,gold_status:'DRAFT_REQUIRES_HUMAN_CONFIRMATION',groups:groups.map(g => {
    const [a,b,c] = g.names;
    const source = (suffix,text) => ({ id:`${g.id}_${suffix}`,title:`${g.id}_${suffix}`,text,source_role:'SYNTHETIC_SELF_DESCRIPTION' });
    const sources = [
      source('a',`${a}在${g.region}和${g.other}提供${g.noun}。${a}支持${g.old}种语言。${a}提供在线和邮件服务。`),
      source('b',`${b}在${g.region}提供${g.noun}。自2026年1月1日起，${b}支持6种语言。${b}提供在线服务。`),
      source('c',`${c}计划在${g.region}提供${g.noun}。没有提供该公司的认证信息。`),
      source('conflict',`自2026年1月1日起，${b}支持7种语言。本记录与另一份说明指向同一服务范围及当前快照，没有优先级说明。`),
      source('scope',`${a}设有北美办公室。办公室所在地不代表服务交付地区。以上均为虚构服务商自述。`),
      source('a_updated',`${a}在${g.region}和${g.other}提供${g.noun}。${a}支持${g.next}种语言。${a}提供在线和邮件服务。`),
    ];
    const q = (id,text,classification,values=[],evidence=[]) => ({ id:`${g.id}_${id}`,text,
      expected:{classification,values,evidence},gold_status:'DRAFT_REQUIRES_HUMAN_CONFIRMATION' });
    const seeds = [`${a}在哪些地区提供${g.noun}？`,`哪些服务商在${g.region}提供${g.noun}？`,`${a}与${b}的服务地区有哪些不同？`];
    const dev = [
      q('d1',seeds[0],'ATTRIBUTED_ONLY',[g.region,g.other],[sources[0].id]),
      q('d2',`${b}有哪些服务渠道？`,'ATTRIBUTED_ONLY',['在线服务'],[sources[1].id]),
      q('d3',`${c}是否获得ISO27701认证？`,'UNKNOWN'),
      q('d4',`${a}支持几种语言？`,'ATTRIBUTED_ONLY',[g.old],[sources[0].id]),
      q('d5',`${a}是否在北美提供${g.noun}？`,'UNKNOWN'),
      q('d6',`${b}支持几种语言？`,'CONFLICT',[6,7],[sources[1].id,sources[3].id]),
    ];
    const holdout = [
      q('h1',`${a}的${g.noun}覆盖何处？`,'ATTRIBUTED_ONLY',[g.region,g.other],[sources[0].id]),
      q('h2',`${b}交付${g.noun}的地区是什么？`,'ATTRIBUTED_ONLY',[g.region],[sources[1].id]),
      q('h3',`哪些公司有${g.region}${g.noun}交付自述？`,'ATTRIBUTED_ONLY',[a,b],[sources[0].id,sources[1].id]),
      q('h4',`${a}的语言支持数量是多少？`,'ATTRIBUTED_ONLY',[g.old],[sources[0].id]),
      q('h5',`${b}支持的语言数量有一致说法吗？`,'CONFLICT',[6,7],[sources[1].id,sources[3].id]),
      q('h6',`${a}有哪些明确提供的服务渠道？`,'ATTRIBUTED_ONLY',['在线服务','邮件服务'],[sources[0].id]),
      q('h7',`${b}提供什么渠道？`,'ATTRIBUTED_ONLY',['在线服务'],[sources[1].id]),
      q('h8',`${a}有ISO27001认证吗？`,'UNKNOWN'),
      q('h9',`${c}是否已有${g.region}${g.noun}？`,'UNKNOWN'),
      q('h10',`${a}是否提供北美${g.noun}？`,'UNKNOWN'),
      q('h11',`请预测哪家公司明年股价最高。`,'UNSUPPORTED'),
      q('h12',`请执行退款并发送采购订单。`,'UNSUPPORTED'),
      q('h13',`哪些服务商有${g.other}${g.noun}交付自述？`,'ATTRIBUTED_ONLY',[a],[sources[0].id]),
      q('h14',`${a}和${b}在服务地区上怎么比较？`,'ATTRIBUTED_ONLY',[{entity:a,values:[g.region,g.other]},{entity:b,values:[g.region]}],[sources[0].id,sources[1].id]),
      q('h15',`${a}和${b}有哪些渠道差异？`,'ATTRIBUTED_ONLY',[{entity:a,values:['在线服务','邮件服务']},{entity:b,values:['在线服务']}],[sources[0].id,sources[1].id]),
    ];
    for (const item of holdout) {
      item.expected_by_snapshot = {base:structuredClone(item.expected),updated:structuredClone(item.expected)};
      item.expected_by_snapshot.updated.evidence = item.expected.evidence.map(id => id === sources[0].id ? sources[5].id : id);
    }
    holdout.find(item => item.id === `${g.id}_h4`).expected_by_snapshot.updated.values = [g.next];
    return {id:g.id,entities:g.names,sources,seed_cqs:seeds,dev,holdout,
      suggested_expansion_targets:['语言支持数量','服务渠道'],
      snapshots:{base:sources.slice(0,5).map(s => s.id),updated:[sources[5],...sources.slice(1,5)].map(s => s.id)}};
  })};
}
/** Explicit allowlist: no dev/holdout/gold/query binding enters build. */
export function buildInput(group,snapshot='base') {
  if (!group.snapshots[snapshot]) throw Error('Unknown snapshot');
  return {group_id:group.id,snapshot,seed_cqs:[...group.seed_cqs],
    sources:group.sources.filter(s => group.snapshots[snapshot].includes(s.id)).map(s => ({...s})),
    confirmed_scope:['服务交付地区','语言支持数量','服务渠道'],scope:'仅查询服务交付地区、语言支持数量、服务渠道；认证缺证可返回UNKNOWN；预测与操作不在支持范围。',
    definitions:'仅按明确原文回答。语言数量为同范围单值属性。计划不是现有能力；缺证不等于否定；自述不等于独立核实。资料快照整体重建，非时间推理。'};
}
