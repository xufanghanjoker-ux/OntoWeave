/** Experimental controller: validates mock review envelopes, not model semantics. */
import { createHash } from 'node:crypto';
import { reviewCodebook } from './review-codebook.mjs';

export const dimensions = Object.freeze(['CQ_COVERAGE', 'SOURCE_SUPPORT', 'ENTITY_SCOPE',
  'QUALIFIERS', 'CONFLICT_LOGIC', 'AUTHORITY_BOUNDARY']);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const nonempty = x => typeof x === 'string' && x.trim().length > 0;
const issueCodes = new Set(Object.keys(reviewCodebook));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export function packetHash(packet) {
  return createHash('sha256').update(JSON.stringify(canonical(packet))).digest('hex');
}
function pointerExists(root, pointer) {
  if (!nonempty(pointer) || !pointer.startsWith('/')) return false;
  let current = root;
  for (const token of pointer.slice(1).split('/')) {
    if (/~(?![01])/.test(token)) return false;
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return false;
    current = current[key];
  }
  return true;
}

/** Detailed protocol diagnostics; never silently discard an invalid issue. */
export function diagnoseReview(packet, review) {
  const diagnostics = [], add = (code,path,message) => diagnostics.push({code,path,message,category:'SYSTEM_REVIEW_PROTOCOL_INVALID'});
  if (!object(review)) {add('REVIEW_NOT_OBJECT','/','评审响应必须是对象');return diagnostics;}
  if (!object(review.coverage)) add('COVERAGE_MISSING','/coverage','缺少六维检查记录');
  else for (const dimension of dimensions) if (review.coverage[dimension] !== 'CHECKED') add('COVERAGE_NOT_CHECKED','/coverage/'+dimension,'该维度未完成检查');
  if (!Array.isArray(review.issues)) {add('ISSUES_NOT_ARRAY','/issues','issues必须为数组');return diagnostics;}
  if (!Array.isArray(packet?.cqs) || !Array.isArray(packet?.evidence) || !object(packet?.proposal)) {add('PACKET_INVALID','/packet','评审包缺少问题、证据或提案');return diagnostics;}
  const cqs = new Set(packet.cqs.map(c => c?.id)), evidence = new Set(packet.evidence.map(e => e?.id)), seen = new Set();
  if (!packet.cqs.length || cqs.size !== packet.cqs.length || evidence.size !== packet.evidence.length
    || [...cqs,...evidence].some(id => !nonempty(id))) add('PACKET_REFERENCE_IDS_INVALID','/packet','CQ和证据ID必须非空且各自唯一');
  for (const [index,issue] of review.issues.entries()) {
    const path = '/issues/'+index;
    if (!object(issue)) {add('ISSUE_NOT_OBJECT',path,'问题条目必须为对象');continue;}
    if (!nonempty(issue.issue_id)) add('ISSUE_ID_MISSING',path+'/issue_id','需要非空问题ID');
    else if (seen.has(issue.issue_id)) add('ISSUE_ID_DUPLICATE',path+'/issue_id','问题ID重复');
    seen.add(issue.issue_id);
    if (!issueCodes.has(issue.code)) add('ISSUE_CODE_UNKNOWN',path+'/code','不支持的问题代码 '+String(issue.code)+'；只能从以下问题代码选择：'+[...issueCodes].join(', ')+'。coverage维度不是问题代码，不得将真实问题删除或改成正常观察来绕过校验。');
    for (const field of ['explanation','counterexample','suggested_change']) if (!nonempty(issue[field])) add('ISSUE_TEXT_MISSING',path+'/'+field,'问题需要具体依据、反例和最小修订');
    if (!pointerExists(packet.proposal,issue.target)) add('TARGET_NOT_FOUND',path+'/target','目标必须存在于proposal内部');
    if (!Array.isArray(issue.cq_ids) || !issue.cq_ids.length) add('CQ_REFERENCE_MISSING',path+'/cq_ids','问题必须关联至少一个CQ');
    else if (issue.cq_ids.some(id => !cqs.has(id))) add('CQ_REFERENCE_UNKNOWN',path+'/cq_ids','引用了不存在的CQ');
    if (!Array.isArray(issue.evidence_ids)) add('EVIDENCE_REFERENCE_INVALID',path+'/evidence_ids','证据引用必须是数组');
    else if (issue.evidence_ids.some(id => !evidence.has(id))) add('EVIDENCE_REFERENCE_UNKNOWN',path+'/evidence_ids','引用了不存在的证据');
    if (!['AUTO_REVISE','WAIT_EVIDENCE','NEEDS_USER'].includes(issue.resolution)) add('RESOLUTION_UNKNOWN',path+'/resolution','不支持的处置方式');
    else if (issueCodes.has(issue.code) && !reviewCodebook[issue.code].resolutions.includes(issue.resolution)) add('RESOLUTION_NOT_ALLOWED',path+'/resolution','该问题代码不允许此处置方式');
    if (issue.resolution === 'AUTO_REVISE' && Array.isArray(issue.evidence_ids) && !issue.evidence_ids.length && issue.code !== 'CQ_UNCOVERED') add('AUTO_REVISE_WITHOUT_EVIDENCE',path+'/evidence_ids','自动语义修订需要已有证据；不猜测缺失事实');
  }
  return diagnostics;
}

export function decideReview(packet, review, validation, execution) {
  const result = (action, reason, issues = []) => ({ action, reason, issues,
    ...(action === 'REVIEW_INCOMPLETE' ? {diagnostics:diagnoseReview(packet,review).length ? diagnoseReview(packet,review) : [{code:reason.toUpperCase(),path:'/',message:reason,category:'SYSTEM_REVIEW_PROTOCOL_INVALID'}]} : {}),
    independently_verified: false, publication_approved: false });
  if (!object(packet) || !object(validation) || !object(execution)) {
    return result('REVIEW_INCOMPLETE', 'invalid_runner_envelope');
  }
  if (!nonempty(packet.packet_id) || !object(packet.versions)
    || ['schema', 'sources', 'cqs', 'candidate'].some(k => !nonempty(packet.versions[k]))
    || !object(packet.proposal)) return result('REVIEW_INCOMPLETE', 'invalid_packet_versions');
  const binding = packetHash(packet);
  // The caller must be a trusted runner. Model-generated metadata is not trusted here.
  if (validation.packet_hash !== binding || execution.packet_hash !== binding) {
    return result('REVIEW_INCOMPLETE', 'stale_runner_binding');
  }
  if (validation.status === 'FAIL') return result('REJECT', 'deterministic_validation_failed');
  if (validation.status !== 'PASS') return result('REVIEW_INCOMPLETE', 'validation_not_completed');
  if (!object(review) || !nonempty(review.review_id) || review.packet_id !== packet.packet_id
    || review.packet_hash !== binding || review.reviewer_run_id !== execution.reviewer_run_id
    || !nonempty(execution.reviewer_run_id) || !nonempty(execution.reviewer_model)
    || !nonempty(execution.reviewer_prompt_version) || !nonempty(execution.independent_baseline_record_id)
    || !nonempty(execution.builder_context_id) || !nonempty(execution.reviewer_context_id)
    || execution.builder_context_id === execution.reviewer_context_id
    || execution.independent_baseline_completed !== true) {
    return result('REVIEW_INCOMPLETE', 'invalid_or_nonindependent_review');
  }
  if (!object(review.coverage) || dimensions.some(d => review.coverage[d] !== 'CHECKED')) {
    return result('REVIEW_INCOMPLETE', 'review_coverage_incomplete');
  }
  if (!Array.isArray(review.issues) || !Array.isArray(packet.cqs)
    || packet.cqs.length === 0 || !Array.isArray(packet.evidence)) {
    return result('REVIEW_INCOMPLETE', 'invalid_collections');
  }
  const cqIds = new Set(packet.cqs.map(c => c.id));
  const evidenceIds = new Set(packet.evidence.map(e => e.id));
  if (cqIds.size !== packet.cqs.length || evidenceIds.size !== packet.evidence.length
    || [...cqIds, ...evidenceIds].some(id => !nonempty(id))) {
    return result('REVIEW_INCOMPLETE', 'invalid_collection_ids');
  }
  const issueIds = new Set();
  for (const i of review.issues) {
    if (!object(i) || !nonempty(i.issue_id) || issueIds.has(i.issue_id)
      || !issueCodes.has(i.code) || !nonempty(i.explanation) || !nonempty(i.counterexample)
      || !nonempty(i.suggested_change) || !pointerExists(packet.proposal, i.target)
      || !Array.isArray(i.cq_ids) || i.cq_ids.length === 0 || i.cq_ids.some(id => !cqIds.has(id))
      || !Array.isArray(i.evidence_ids) || i.evidence_ids.some(id => !evidenceIds.has(id))
      || !['AUTO_REVISE', 'WAIT_EVIDENCE', 'NEEDS_USER'].includes(i.resolution)) {
      return result('REVIEW_INCOMPLETE', 'invalid_issue_reference');
    }
    if (!reviewCodebook[i.code].resolutions.includes(i.resolution)
      || (i.resolution === 'AUTO_REVISE' && i.evidence_ids.length === 0 && i.code !== 'CQ_UNCOVERED')) {
      return result('REVIEW_INCOMPLETE', 'invalid_resolution_policy');
    }
    issueIds.add(i.issue_id);
  }
  // User decisions are surfaced before other open work; all issues remain in the result.
  for (const [resolution, action] of [['NEEDS_USER', 'NEEDS_USER'],
    ['WAIT_EVIDENCE', 'WAIT_EVIDENCE'], ['AUTO_REVISE', 'REQUEST_REVISION']]) {
    if (review.issues.some(i => i.resolution === resolution)) {
      return result(action, 'open_review_issues', review.issues);
    }
  }
  return result('ACCEPT_CANDIDATE', 'checked_candidate_only');
}
