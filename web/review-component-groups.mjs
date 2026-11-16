/** Group membership is frozen by the original candidate, never by UI selection. */
import assert from 'node:assert/strict';
import {sha} from './engine.mjs';
import {planComponentPublication} from './component-publication.mjs';
import {applyReviewDecisions} from './human-review.mjs';
export function componentDecisionGroups(job,review,base,decisions=[],progress=null){
  if(!job.internal_scope||job.component_submission||job.component_release||job.human_review?.component_publication||review?.stage!=='claims_review'||!base)return [];
  const plan=planComponentPublication(base,job,{allowUnchanged:true});if(!plan.eligible)return [];
  return plan.manifest.components.filter(c=>c.issue_indexes.length).map(c=>{
    const ids=c.issue_indexes.map(i=>review.issues[i]?.id);assert(ids.every(Boolean),'组件事项与原始评审不一致');
    return {id:'decision_component_'+sha([review.snapshot_hash,c.predicate_ids]).slice(0,24),predicate_ids:c.predicate_ids,
      issue_ids:ids,pending_count:ids.filter(id=>!decisions.some(d=>d.issue_id===id)).length,
      published:ids.every(id=>progress?.committed_issue_ids?.includes(id))};
  });
}
export function prepareComponentDecision({job,review,decisions,group,head,progress}){
  assert(group&&!group.published,'组件已发布或不存在');assert(group.pending_count===0,'请先保存本组全部决定');
  const ids=[...new Set([...(progress?.committed_issue_ids||[]),...group.issue_ids])];
  const chosen=decisions.filter(d=>ids.includes(d.issue_id));assert(chosen.length===ids.length,'已提交的组件决定缺失');
  for(const [issueId,decisionId] of Object.entries(progress?.committed_decisions||{}))assert(chosen.find(d=>d.issue_id===issueId)?.id===decisionId,'已经发布的决定不可修改');
  const applied=applyReviewDecisions(review,chosen,{input:job.input});
  const remaining=review.issues.filter(i=>!ids.includes(i.id)).map(issue=>{
    const copy=structuredClone(issue),match=issue.target.match(/^\/claims\/(\d+)(?=\/|$)/);
    if(match){const original=review.candidate.claims[Number(match[1])],index=applied.candidate.claims.findIndex(c=>c.id===original.id);assert(index>=0,'修改跨越了剩余事项的依赖边界');copy.target=copy.target.replace(/^\/claims\/\d+/,'/claims/'+index);}
    return copy;
  });
  const proposed={...job,result:{...job.result,...applied.candidate,gate:{...job.result.gate,issues:remaining}}};
  const plan=planComponentPublication(head,proposed,{allowUnchanged:true,allowNoIssues:true});assert(plan.eligible,'当前变更不能独立发布：'+plan.reason);
  assert(group.predicate_ids.every(id=>plan.manifest.safe_predicate_ids.includes(id)),'修改后组件与剩余事项共享依赖，需合并处理');
  for(const audit of applied.audit)if(audit.new_claim_id){const c=applied.candidate.claims.find(c=>c.id===audit.new_claim_id);assert(c&&plan.manifest.safe_predicate_ids.includes(c.predicate_id),'修正跨入了待核对组件，需合并处理');}
  // The immutable origin remains the actual original candidate, not this derived proposal.
  plan.manifest.origin_result_hash=sha(job.result);
  return {...plan,committed:chosen,committed_issue_ids:ids,audit:applied.audit,decision_set_hash:applied.decision_set_hash,remaining_count:remaining.length};
}
