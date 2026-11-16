/** Conservative grouping of identical review causes; grouping never approves facts. */
import assert from 'node:assert/strict';
import { sha } from './engine.mjs';
import { validateReviewDecision } from './human-review.mjs';

const normalize=value=>String(value||'').trim().replace(/\s+/g,' ');
export function groupReviewIssues(review){
  const groups=new Map();
  for(const issue of review.issues){
    const claims=issue.claims||[];
    const target=issue.target.replace(/^(\/schema\/(?:entities|predicates|entity_types|cq_plans)\/\d+)(?:\/.*)?$/,'$1');
    const signature={stage:review.stage,code:issue.code,
      target:claims.length?'CLAIM_COHORT':target,
      cohorts:claims.map(c=>[c.source_id,c.predicate_id,c.scope,c.unit,c.modality]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
      explanation:normalize(issue.explanation),suggestion:normalize(issue.suggested_change)};
    const key=sha(signature);let group=groups.get(key);
    if(!group){group={id:'review_group_'+sha([review.snapshot_hash,key]).slice(0,24),issue_ids:[],code:issue.code,
      explanation:issue.explanation||'',suggested_change:issue.suggested_change||'',allowed_choices:['RECHECK'],claim_ids:[]};groups.set(key,group);}
    group.issue_ids.push(issue.id);group.claim_ids=[...new Set([...group.claim_ids,...(issue.claim_ids||[])])];
  }
  return [...groups.values()];
}

export function expandGroupDecision(review,body){
  assert(body&&body.version===review.task_id&&body.snapshot_hash===review.snapshot_hash,'事项组版本或快照已变化');
  const group=groupReviewIssues(review).find(g=>g.id===body.group_id);assert(group,'事项组不属于当前快照');
  assert(group.allowed_choices.includes(body.choice),'组操作只允许共同复核，字段修正请逐项处理');
  return group.issue_ids.map(issue_id=>validateReviewDecision(review,{version:body.version,snapshot_hash:body.snapshot_hash,
    issue_id,choice:body.choice,note:body.note,reason_code:body.reason_code}));
}
