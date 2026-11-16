/** Explicit, source-bound authorization. A request is reserved synchronously before network. */
import { randomUUID } from 'node:crypto';
import { sha } from './engine.mjs';
import { extractionUnits, contextSources, claimReviewBatches } from './source-context.mjs';
export const modelProfile = provider => ({ name: provider?.model || '', base_url: provider?.root || '',
  thinking_mode: provider?.thinkingMode ?? 'default', max_tokens: provider?.maxTokens ?? null, timeout_ms: provider?.timeoutMs ?? null });
const blocked = (code, message) => Object.assign(Error(message), { code, details: { code, usage: null, usage_raw: null, billing_status: 'NOT_SENT' } });
export function createBudgets(store, { profile } = {}) {
  const scope = input => {
    return sha({ sources: input.sources.map(s => [s.id,s.title,s.source_role,sha(s.content)]), cqs: input.cqs, definitions: input.definitions, as_of: input.as_of });
  };
  function preview(input, { operation = 'BUILD', task_id = null, question = null, snapshot_hash=null, decision_set_hash=null, review_candidate=null } = {}) {
    if (!['BUILD','EXPAND','ASK','RESUME','RETRY','REVIEW_CONTINUE'].includes(operation)) throw Error('预算操作类型无效');
    if(operation==='REVIEW_CONTINUE'&&(!snapshot_hash||!decision_set_hash||!review_candidate))throw Error('人工继续预算缺少候选或决定绑定');
    const humanReview=review_candidate!==null;
    const chunks = extractionUnits(input.sources);
    const normal = humanReview?claimReviewBatches(review_candidate.claims).length:operation === 'EXPAND' ? 1 : operation === 'ASK' ? 3 : 4 + chunks.length;
    const manifest = { operation, task_id, question, sources: input.sources.map(s => ({ id:s.id,title:s.title,sha256:sha(s.content),characters:s.content.length })),
      total_characters: input.sources.reduce((n,s) => n+s.content.length,0), model: profile(), normal_calls:normal, max_calls:null,
      normal_calls_basis: ['BUILD','RETRY','RESUME','ASK'].includes(operation)?'MINIMUM_BEFORE_REUSE_AND_ADDITIONAL_REVIEWS':'FIXED',
      extraction_chunks:chunks.map(c=>({id:c.id,source_id:c.source_id,start:c.start,end:c.end})),
      preparation_context:contextSources(input.sources,input.cqs).map(s=>({source_id:s.id,...s.context_scope})),
      planned_calls: operation === 'EXPAND' ? [{phase:'问题扩展',calls:1}] : operation === 'ASK' ? [{phase:'问题路由',calls:1},{phase:'证据综合回答',calls:1},{phase:'回答独立复核',calls:1}]
        : [{phase:'本体与独立阅读（长文使用相关片段）',calls:2},{phase:'本体评审',calls:1},{phase:'全文逐块抽取',calls:chunks.length},{phase:'声明分批复核（至少）',calls:1}],
      ...(humanReview?{snapshot_hash,decision_set_hash,send_scope:'HUMAN_DECISIONS_CANDIDATE_AND_NEIGHBORING_EVIDENCE',
        normal_calls_basis:'FIXED_REVIEW_BATCHES_BEFORE_REUSE_AND_REPAIR',extraction_chunks:[],preparation_context:[],
        planned_calls:[{phase:'人工决定后的独立复评（不重新抽取）',calls:normal}]}:{}),
      limits:{sources:8,total_utf16:null,source_utf16:null,automatic_chunking:true,max_repairs:null,max_repairs_per_unit:1,semantic_revision_rounds:1},
      notice:'构建次数为全新构建的最低估算，声明较多时增加分批复核；修复另计，恢复复用有效阶段。每个处理单元最多自动修复一次，不同抽取块和评审批次不共享整篇两次额度；语义修订后须重新评审。默认不限制本次操作的调用次数，可选填写上限；不限次数仍会产生实际模型费用，可随时停止任务。授权只适用于本次操作及资料，不授权其他任务。全部请求（含失败）计数，缺usage记未知；不自动重发未知远端请求。价格未确认，不承诺金额。' };
    if(humanReview)manifest.notice='本次只复评修订候选、人工说明及相关原文邻近片段，不重新抽取全文。程序先校验证据与字段，再由模型独立复评；仍有疑点会再次等待人工核对。次数按实际批数估算，格式修复另计，恢复复用已通过批次。默认不限本次操作调用次数，可自行设置上限或停止；原始usage及失败仍计量，未知远端不自动重发。人工决定不等于独立事实认证。';
    const row = { id:randomUUID(),scope_hash:scope(input),profile_hash:sha(profile()),manifest,created_at:new Date().toISOString() };
    store.putRecord('budget_preview',row.id,row);
    return {preview_id:row.id,manifest,requires_confirmation:true};
  }
  function confirm({ preview_id, max_calls = null, auto_repair = false, consent } = {}) {
    if (consent !== true) throw blocked('BUDGET_CONSENT_REQUIRED','请确认本批发送范围与调用上限');
    const p = typeof preview_id==='string' ? store.getRecord('budget_preview',preview_id) : null;
    if (!p || p.profile_hash !== sha(profile())) throw blocked('BUDGET_STALE','预算预览已失效，请重新预览当前模型配置');
    if ((max_calls !== null && (!Number.isSafeInteger(max_calls) || max_calls < 1)) || typeof auto_repair !== 'boolean') throw Error('调用上限须为正整数或null（不限次数），自动修复需明确选择');
    const prior = store.listRecords('budget').find(b => b.preview_id === preview_id);
    if (prior) {
      if (prior.max_calls !== max_calls || prior.auto_repair !== auto_repair) throw Error('该预览已确认，不能修改已授权批次');
      return read(prior.id);
    }
    const row = {id:randomUUID(),preview_id,scope_hash:p.scope_hash,profile_hash:p.profile_hash,max_calls,used:0,auto_repair,
      manifest:p.manifest,created_at:new Date().toISOString()};
    store.archiveRecord('budget_authorization',row.id,row); store.putRecord('budget',row.id,row); return read(row.id);
  }
  function read(id) { const b=typeof id==='string'?store.getRecord('budget',id):null; return b ? {...b,remaining:b.max_calls===null?null:b.max_calls-b.used} : null; }
  function authorize(id,input, context) {
    const b=read(id);
    if (!b) throw blocked('BUDGET_REQUIRED','需要先预览并确认本批预算；未发送模型请求');
    if (b.scope_hash !== scope(input) || b.profile_hash !== sha(profile())) throw blocked('BUDGET_SCOPE_CHANGED','资料、问题范围或模型配置已变化，请重新确认预算');
    if (!context || b.manifest.operation !== context.operation || b.manifest.task_id !== (context.task_id ?? null)
      || b.manifest.question !== (context.question ?? null)) throw blocked('BUDGET_OPERATION_CHANGED','预算不属于本次操作、版本或问题，请重新确认');
    if(b.manifest.send_scope==='HUMAN_DECISIONS_CANDIDATE_AND_NEIGHBORING_EVIDENCE'&&(b.manifest.snapshot_hash!==context.snapshot_hash||b.manifest.decision_set_hash!==context.decision_set_hash))
      throw blocked('BUDGET_REVIEW_CHANGED','人工候选或决定已变化，请重新预览本次继续范围');
    if (b.max_calls !== null && b.used >= b.max_calls) throw blocked('BUDGET_EXHAUSTED','本次自定义调用额度已用完，进度已保存；重新授权后可继续');
    return b;
  }
  function reserve(id,input,context) {
    const b=authorize(id,input,context); b.used++; delete b.remaining;
    // No await between validation and reservation; the loopback app has one workspace writer.
    store.putRecord('budget',id,b); return {budget_id:id,index:b.used,limit:b.max_calls};
  }
  return {preview,confirm,read,authorize,reserve};
}
