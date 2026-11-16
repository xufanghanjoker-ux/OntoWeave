/** Model-facing temporal meaning only. The original host trace and scope remain authoritative. */
import {clone,need} from './cq-discovery-store-v2.mjs';

const roles={SUPPORT:'本条合资格事实的内容依据',BACKGROUND:'背景对照，不支持修订后的值',TIME_BOUNDARY_BASIS:'仅用于说明派生时间边界',TIME_UNRESOLVED_CONTEXT:'时间未确定的原文上下文，不能证明所问时刻的状态'};
const claims={FACT_CONTENT:'仅支持本条事实内容',DERIVED_END_ONLY:'仅支持派生结束边界',NOT_SUPPORT:'不能作为当前结论的支持',UNCERTAINTY_ONLY:'只用于解释证据不足'};
function humanTime(scope){
 const selection=scope.temporal_selection??scope.selection??scope,asOf=selection.as_of;
 return {world_time:selection.at??'未指定世界时间过滤',knowledge_as_of:asOf?.timestamp??(asOf?.activation_seq?'用户明确选择的已确认系统认识':'本次问题开始时已确认的系统认识'),knowledge_snapshot_time:scope.activated_at??scope.knowledge_snapshot_time??null};
}
export function createTemporalModelView(reader){
 need(typeof reader.temporalModelState==='function','QUERY_TEMPORAL_MODEL_VIEW_REQUIRED');
 const state=reader.temporalModelState(),uncertain=state.readable_sources.filter(s=>s.source_role==='TIME_UNRESOLVED_CONTEXT'),available=state.readable_sources.length>0;
 let summary;
 if(state.eligible_facts>0)summary='当前时间范围内有可确认的事实；单次关键词未命中不能推断资料不存在。';
 else if(uncertain.length)summary='当前时间范围内没有可确认的事实，但仍有可读的原文上下文；这些上下文只能解释资料记载与证据不足，不能证明所问时刻的状态。';
 else if(state.possible_facts>0)summary='存在时间归属未确定的记录，但当前没有获准可读的准确引句；不能补造原文或确定状态。';
 else if(state.outside_facts>0)summary='这个固定系统视图中有事实记录，但没有记录满足所选世界时间条件。这是时间筛选结果，不能解释为全库为空、资料未导入或没有原始文档。';
 else summary='当前固定时间范围内没有取得可确认的事实；这里没有核验全库资料清单，不能据此推断全库为空。';
 const nature={DOCUMENT:'文档原话的保存记录',HUMAN_TEXT:'人工陈述记录',AGENT_REPORT:'Agent 报告记录',TOOL_RECEIPT:'工具回执记录'};
 return {time:humanTime(state),scope_explanation:'以下可用性只描述本次固定时间范围，不是全库、全图或全部文档的数量。',summary,
  readable_source_availability:{available,uncertainty_context_available:uncertain.length>0,catalog_scope:'仅列出本次允许读取的引句来源；空列表不等于资料库没有文档',sources:state.readable_sources.slice(0,8).map(s=>({source_type:'记录型来源',title:String(s.label??'原始记录').slice(0,160),nature:nature[s.source_kind]??'来源记录',evidence_role:roles[s.source_role]??'按工具注明的来源角色读取'})),more_sources:state.readable_sources.length>8},
  reading_guidance:available?'如需说明原材料实际写了什么或解释证据不足，请使用 lightog_search_sources 定位本范围的来源，再按实际返回的 evidence_refs 用 lightog_read_evidence 读取；只有实际读到的证据才能带引用。这些是记录型来源，即使原话来自文档，也不要套用仅文档证据的过滤，按工具默认来源模式检索即可。此处只有来源元数据，没有提供原文或新证据权限。':'本范围没有获准可读的引句。可以说明当前时间条件下证据不足，不能把它说成空库。',
  answer_boundary:'区分世界时间条件与系统认识时间；不能只因世界时间筛选未命中就建议改用更晚的系统时间。不要把程序容量、审计标记或内部枚举当作面向用户的事实。背景不能支持新值，时间未定上下文不能证明在所问时刻成立。'};
}

/** Translate only known temporal audit fields; source text and business values are untouched. */
export function projectTemporalModelValue(value){
 if(Array.isArray(value))return value.map(projectTemporalModelValue);
 if(!value||typeof value!=='object')return value;
 const result={};for(const [key,item]of Object.entries(value)){
  if(['raw_value','text','quote','statement','conditions','attributes','participants','native_action','valid_time','asserted_valid_time','derivation','rule_text'].includes(key)){result[key]=clone(item);continue;}
  if(key==='temporal_scope'){result[key]=humanTime(item);continue;}
  if(key==='system_time'&&item){result[key]={known_from:item.recorded_from??null,known_until:item.recorded_to??'该固定系统视图内未记录终止'};continue;}
  if(key==='source_role'){result[key]=roles[item]??item;continue;}
  if(key==='claim_scope'){result[key]=claims[item]??item;continue;}
  if(key==='temporal_claim'&&item==='NOT_DEFINITE_AT_TIME'){result[key]='不能确认在所问时刻成立';continue;}
  if(key==='temporal_match'&&item==='POSSIBLE'){result[key]='时间归属仍不确定';continue;}
  result[key]=projectTemporalModelValue(item);
 }
 return result;
}

export function withTemporalModelView({host,view}){
 return {...host,async call(name,args,context){
  const raw=await host.call(name,args,context),result=projectTemporalModelValue(raw);
  if(result?.ok===true&&['NO_MATCH','NO_NEW_INFORMATION'].includes(result.result?.status)&&Array.isArray(result.result.items)&&result.result.items.length===0&&result.result.execution?.executed!==false)result.result.temporal_view=clone(view);
  return result;
 }};
}
