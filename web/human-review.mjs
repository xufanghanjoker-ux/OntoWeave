/** Pure human-review snapshots. A decision is a proposal, never permission to bypass evaluation. */
import assert from 'node:assert/strict';
import {sha,validateClaims,validateSchema} from './engine.mjs';
import {compileReview} from './review-protocol.mjs';
import {packetHash,decideReview} from '../fixtures/tools/evaluator-gate.mjs';
import {reviewCodebook} from '../fixtures/tools/review-codebook.mjs';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const patchFields=['subject_id','predicate_id','value','scope','unit','comparator','effective_from','modality'];
export const reviewReasonLabels=Object.freeze({EVIDENCE_SUPPORTS:'已有原文支持',UNKNOWN_IS_VALID:'缺证应返回未知',SUBJECT_SCOPE:'主体或范围需要重新判断',OTHER:'其他原因'});
export function reviewDecisionSummary(decision){
  const actions={EXCLUDE_CLAIM:'用户选择排除当前候选',AMEND_CLAIM:'用户选择修正当前候选字段',RECHECK:'用户请求独立复核当前候选',KEEP_CONFLICT:'用户选择保留冲突陈述'};
  const fields={subject_id:'主体',predicate_id:'属性或关系',value:'值',scope:'范围',unit:'单位',comparator:'比较符',effective_from:'日期',modality:'语气'};
  return (actions[decision.choice]||'用户保存了处理决定')+(decision.choice==='AMEND_CLAIM'?'：'+Object.keys(decision.patch||{}).map(k=>fields[k]||k).join('、'):'')
    +(decision.reason_code?'；用户选择原因：'+reviewReasonLabels[decision.reason_code]:'');
}
const error=(code,message)=>Object.assign(new Error(message),{code});
const requireSnapshot=(condition,message)=>{if(!condition)throw error('HUMAN_REVIEW_SNAPSHOT_MISMATCH',message);};
const same=(a,b)=>a===undefined||b===undefined?a===b:sha(a)===sha(b);
const checkpointsOf=job=>job.checkpoints||job.result?.checkpoints||[];

function canonicalCandidate(job){
  requireSnapshot(job.input&&job.result?.schema,'缺少候选本体或原始输入');
  const schema=validateSchema(structuredClone(job.result.schema),job.input);
  const original=job.result.claims||[],validated=validateClaims({claims:original},schema,job.input,{collectErrors:true});
  requireSnapshot(!validated.issues.length&&validated.claims.length===original.length,'候选包含非法声明，不能静默丢弃后进入人审');
  const claims=validated.claims;
  for(const [i,c] of claims.entries()){
    const stored=job.result.claims[i];
    requireSnapshot(c.id===stored.id&&c.evidence_id===stored.evidence_id&&c.start===stored.start&&c.end===stored.end,'候选声明身份或证据位置与原文不一致');
    for(const key of ['subject_id','predicate_id','value','source_id','quote','modality','comparator','unit','scope','effective_from','offset_unit','source_role','independently_verified'])
      requireSnapshot(same(c[key],stored[key]),'候选字段不能在核验时被静默改写：'+key);
  }
  return {schema,claims};
}
function originalProfile(job){
  const profile=checkpointsOf(job).find(c=>c.key==='schema'||c.key==='schema_semantic_repair')?.metadata?.profile||job.human_review?.source_profile;
  if(!object(profile))return null;
  return Object.fromEntries(['model','endpoint','max_tokens','timeout_ms','thinking'].filter(k=>Object.hasOwn(profile,k)).map(k=>[k,structuredClone(profile[k])]));
}
function realConflict(candidate,claims){
  if(claims.length<2)return false;
  const first=claims[0],predicate=candidate.schema.predicates.find(p=>p.id===first.predicate_id);
  return predicate?.cardinality==='ONE'&&first.effective_from!==null&&first.effective_from!==undefined
    &&claims.every(c=>c.modality==='CURRENT'&&c.comparator==='EQ'&&c.subject_id===first.subject_id&&c.predicate_id===first.predicate_id
      &&c.scope===first.scope&&c.unit===first.unit&&c.effective_from===first.effective_from)
    &&new Set(claims.map(c=>JSON.stringify(c.value))).size>1;
}
function legacyIssues(job,candidate,reviewPackets){
  const checkpoints=checkpointsOf(job),final=checkpoints.filter(c=>/^claims_review_repaired(?:$|:)/.test(c.key));
  if(!final.length)return null;
  if(!reviewPackets.length)throw error('HUMAN_REVIEW_SNAPSHOT_REQUIRED','旧任务需要对应的不可变评审包与评审记录，不能仅从报错拼接人审');
  const issues=[];
  for(const checkpoint of final){
    const records=reviewPackets.filter(r=>r.key===checkpoint.key&&r.checkpoint?.fingerprint===checkpoint.fingerprint);
    if(records.length!==1)throw error('HUMAN_REVIEW_SNAPSHOT_REQUIRED','缺少或存在多个对应的最终评审快照');
    const {packet,review_record:record,checkpoint:provided}=records[0];
    requireSnapshot(checkpoint.validated===true&&checkpoint.output_sha256===sha(checkpoint.output)&&same(provided,checkpoint),'最终评审检查点哈希无效');
    requireSnapshot(packet&&record?.execution&&record.review&&record.gate,'缺少评审包、执行身份或门禁记录');
    const binding=packetHash(packet);
    requireSnapshot(binding===record.execution.packet_hash&&binding===record.review.packet_hash&&record.review.packet_id===packet.packet_id,'评审包哈希或运行绑定不一致');
    requireSnapshot(packet.versions?.sources===sha(job.input.sources)&&packet.versions?.cqs===sha(job.input.cqs)
      &&packet.versions?.schema===sha(candidate.schema)&&packet.versions?.candidate===sha(packet.proposal),'评审包来源、本体或问题版本不匹配');
    const compiled=compileReview(packet,checkpoint.output);
    requireSnapshot(compiled.valid&&same(compiled.review.coverage,record.review.coverage)&&same(compiled.review.issues,record.review.issues)
      &&same(compiled.review.observations||[],record.review.observations||[]),'评审原始输出与已归档评审记录不一致');
    const gate=decideReview(packet,record.review,{status:'PASS',packet_hash:binding},record.execution);
    requireSnapshot(gate.action!=='REVIEW_INCOMPLETE'&&gate.action===record.gate.action&&same(gate.issues||[],record.gate.issues||[]),'评审执行门禁或问题清单不一致');
    const batch=packet.proposal?.claims;
    requireSnapshot(Array.isArray(batch)&&same(packet.proposal.schema,candidate.schema),'评审包不包含对应声明候选');
    const globalIndices=batch.map(c=>{
      const index=candidate.claims.findIndex(actual=>actual.id===c.id);
      requireSnapshot(index>=0,'归档评审批次引用了当前候选之外的声明');
      for(const [key,value] of Object.entries(c))requireSnapshot(same(candidate.claims[index][key],value),'归档声明与当前候选内容不一致：'+key);
      return index;
    });
    issues.push(...(compiled.review.issues||[]).map(issue=>({...issue,target:issue.target?.replace(/^\/claims\/(\d+)(?=\/|$)/,
      (_m,index)=>'/claims/'+globalIndices[Number(index)]),legacy_checkpoint_key:checkpoint.key})));
  }
  return issues;
}

export function buildHumanReview(job,{reviewPackets=[]}={}){
  if(!job||!['REVIEW_REQUIRED','FAILED'].includes(job.status))return null;
  if(job.status==='FAILED'&&(job.error_details?.code!=='SYSTEM_SEMANTIC_REPAIR_EXHAUSTED'||job.error!=='声明修复后仍未通过语义评审'))return null;
  if(job.status==='FAILED'&&!checkpointsOf(job).some(c=>/^claims_review_repaired(?:$|:)/.test(c.key)))return null;
  if(job.status==='REVIEW_REQUIRED'&&(!job.result?.gate||job.result.gate.action==='REVIEW_INCOMPLETE'))return null;
  let candidate;
  try{candidate=canonicalCandidate(job);}catch(cause){if(cause.code?.startsWith('HUMAN_'))throw cause;throw error('HUMAN_REVIEW_SNAPSHOT_MISMATCH','候选快照校验失败：'+cause.message);}
  const candidate_hash=sha(candidate),input_sha256=sha(job.input);
  const origin=job.status==='FAILED'?'LEGACY_CHECKPOINT_DIAGNOSIS':'PIPELINE_PAUSE';
  const raw=job.status==='FAILED'?legacyIssues(job,candidate,reviewPackets):job.result.gate.issues||[];
  if(!raw?.length)return null;
  const stage=job.status==='FAILED'?'claims_review':job.result.review_stage||job.result.human_review_stage
    ||(checkpointsOf(job).some(c=>c.key.startsWith('claims_review'))||candidate.claims.length?'claims_review':'schema_review');
  requireSnapshot(['schema_review','claims_review'].includes(stage),'不支持的人审核验阶段');
  const issues=raw.map(issue=>{
    requireSnapshot(object(issue)&&typeof issue.code==='string'&&(Object.hasOwn(reviewCodebook,issue.code)||issue.code==='QUERY_TARGET_UNBOUND')
      &&typeof issue.target==='string','人审问题不是合法语义事项');
    let claims=[];const match=issue.target.match(/^\/claims\/(\d+)(?:\/|$)/);
    if(match){requireSnapshot(candidate.claims[Number(match[1])],'问题目标不在当前候选中');claims=[candidate.claims[Number(match[1])]];}
    else if(issue.target==='/claims')claims=candidate.claims.filter(c=>(issue.evidence_ids||[]).includes(c.evidence_id));
    const id='human_issue_'+sha({task:job.id,candidate_hash,stage,code:issue.code,target:issue.target,cq_ids:issue.cq_ids||[],evidence_ids:issue.evidence_ids||[],
      original_id:issue.issue_id||null,checkpoint:issue.legacy_checkpoint_key||null}).slice(0,24);
    const allowed_choices=['RECHECK'];
    if(stage==='claims_review'&&claims.length===1)allowed_choices.push('EXCLUDE_CLAIM','AMEND_CLAIM');
    if(stage==='claims_review'&&realConflict(candidate,claims))allowed_choices.push('KEEP_CONFLICT');
    return {...structuredClone(issue),id,claim_ids:claims.map(c=>c.id),claims:structuredClone(claims),allowed_choices};
  });
  requireSnapshot(new Set(issues.map(i=>i.id)).size===issues.length,'人审问题身份重复');
  const model_profile=originalProfile(job),snapshot_hash=sha({task_id:job.id,input_sha256,candidate_hash,stage,issues,model_profile});
  return {version:'human_review_v1',task_id:job.id,snapshot_hash,input_sha256,candidate_hash,candidate,stage,issues,origin,model_profile,
    can_continue:stage==='claims_review'&&Boolean(model_profile?.model),independently_verified:false,publication_approved:false};
}

export function validateReviewDecision(review,body){
  assert(review?.version==='human_review_v1'&&object(body),'人审决定格式无效');
  assert(review.snapshot_hash===sha({task_id:review.task_id,input_sha256:review.input_sha256,candidate_hash:review.candidate_hash,
    stage:review.stage,issues:review.issues,model_profile:review.model_profile}),'人审包哈希不一致');
  assert(body.version===review.task_id&&body.snapshot_hash===review.snapshot_hash,'人审版本或快照已变化，请刷新');
  const issue=review.issues.find(i=>i.id===body.issue_id);assert(issue,'问题不属于当前人审快照');
  assert(issue.allowed_choices.includes(body.choice),'此问题不允许该决定');
  assert(body.note===undefined||(typeof body.note==='string'&&body.note.length<=2000),'补充说明格式无效或超过2000字');
  const note=(body.note||'').trim(),reason_code=body.reason_code;
  assert(reason_code===undefined||reason_code===''||(body.choice==='RECHECK'&&Object.hasOwn(reviewReasonLabels,reason_code)),'复核原因无效或不适用于当前操作');
  let patch;
  if(body.choice==='AMEND_CLAIM'){
    assert(issue.claim_ids.length===1&&object(body.patch)&&Object.keys(body.patch).length>0,'字段修正需要唯一候选及非空patch');
    assert(Object.keys(body.patch).every(key=>patchFields.includes(key)),'不得修改引文、来源、偏移或任意审核状态');
    patch=Object.fromEntries(patchFields.filter(k=>Object.hasOwn(body.patch,k)).map(k=>[k,structuredClone(body.patch[k])]));
    assert(Object.keys(patch).some(key=>!same(patch[key],issue.claims[0][key])),'修正没有改变候选字段，请使用重新核对');
    assert(!(issue.claims[0].modality==='PLANNED'&&patch.modality==='CURRENT'),'计划不能通过人工字段修正升级为当前能力');
    const proposed={...issue.claims[0],...patch},schema=review.candidate.schema;
    assert(schema.entities.some(e=>e.id===proposed.subject_id),'修正主体未定义');
    const predicate=schema.predicates.find(p=>p.id===proposed.predicate_id);assert(predicate,'修正谓词未定义');
    assert(predicate.value_type==='NUMBER'?typeof proposed.value==='number'&&Number.isFinite(proposed.value)
      :predicate.value_type==='ENTITY'?typeof proposed.value==='string'&&schema.entities.some(e=>e.id===proposed.value)
      :typeof proposed.value==='string'&&proposed.value.trim()&&proposed.value.length<=1000,'修正值类型不匹配');
    assert(proposed.scope===null||typeof proposed.scope==='string'&&proposed.scope.length<=500,'修正范围无效');
    assert(proposed.unit===null||typeof proposed.unit==='string'&&proposed.unit.length<=100,'修正单位无效');
    assert(['EQ','GT','GE','LT','LE','APPROX','UNKNOWN'].includes(proposed.comparator),'修正比较符无效');
    assert(['CURRENT','PLANNED'].includes(proposed.modality),'修正语气无效');
    assert(proposed.effective_from===null||typeof proposed.effective_from==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(proposed.effective_from)
      &&Number.isFinite(Date.parse(proposed.effective_from))&&new Date(proposed.effective_from).toISOString().slice(0,10)===proposed.effective_from,'修正有效日期无效');
  }else assert(body.patch===undefined||body.patch===null,'非字段修正决定不能附带patch');
  const decision={task_id:review.task_id,version:review.task_id,snapshot_hash:review.snapshot_hash,issue_id:issue.id,choice:body.choice,note,...(patch?{patch}:{}),...(reason_code?{reason_code}:{})};
  return {id:'human_decision_'+sha(decision).slice(0,32),...decision};
}

export function applyReviewDecisions(review,decisions,{input}={}){
  assert(input&&sha(input)===review.input_sha256,'需要与人审快照一致的原始输入');
  assert(object(review.candidate)&&sha(review.candidate)===review.candidate_hash,'人审候选哈希不一致');
  assert(Array.isArray(decisions),'决定必须是数组');
  const canonical=decisions.map(d=>{const validated=validateReviewDecision(review,d);assert(d.id===undefined||d.id===validated.id,'决定ID不匹配');return validated;});
  assert(new Set(canonical.map(d=>d.issue_id)).size===canonical.length,'同一问题不能重复或相反决定');
  canonical.sort((a,b)=>a.issue_id.localeCompare(b.issue_id));
  const candidate=structuredClone(review.candidate),modified=new Set(),kept=new Set(),audit=[];
  for(const d of canonical)if(d.choice==='KEEP_CONFLICT')for(const id of review.issues.find(i=>i.id===d.issue_id).claim_ids)kept.add(id);
  for(const d of canonical){
    const issue=review.issues.find(i=>i.id===d.issue_id),entry={decision_id:d.id,issue_id:issue.id,choice:d.choice,claim_ids:[...issue.claim_ids],note:d.note,
      operation_summary:reviewDecisionSummary(d),...(d.reason_code?{reason_code:d.reason_code}:{})};
    if(['AMEND_CLAIM','EXCLUDE_CLAIM'].includes(d.choice)){
      const id=issue.claim_ids[0];assert(!modified.has(id)&&!kept.has(id),'同一候选存在重复、相反修改或保留冲突决定');modified.add(id);
      const index=candidate.claims.findIndex(c=>c.id===id);assert(index>=0,'候选已不存在');entry.old_claim_id=id;
      if(d.choice==='EXCLUDE_CLAIM')candidate.claims.splice(index,1);
      else {const raw={...candidate.claims[index],...d.patch},validated=validateClaims({claims:[raw]},candidate.schema,input,{collectErrors:true});
        assert(!validated.issues.length&&validated.claims.length===1,'修正后的声明未通过证据或结构校验');const normalized=validated.claims[0];
        candidate.claims[index]=normalized;entry.new_claim_id=normalized.id;entry.patch=structuredClone(d.patch);}
    }
    audit.push(entry);
  }
  candidate.schema=validateSchema(candidate.schema,input);
  const validated=validateClaims({claims:candidate.claims},candidate.schema,input,{collectErrors:true});
  assert(!validated.issues.length&&validated.claims.length===candidate.claims.length,'候选包含非法声明，不能静默丢弃');candidate.claims=validated.claims;
  const done=new Set(canonical.map(d=>d.issue_id)),missing_issue_ids=review.issues.filter(i=>!done.has(i.id)).map(i=>i.id);
  return {candidate,audit,decision_set_hash:sha(canonical),missing_issue_ids,ready_to_continue:review.can_continue===true&&!missing_issue_ids.length,
    independently_verified:false,publication_approved:false};
}
