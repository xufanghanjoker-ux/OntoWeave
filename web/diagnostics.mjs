/** Offline diagnostics from immutable stored model outputs, never re-calls a model. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseModelJson } from '../experiments/model-loop/provider.mjs';
import { validateClaims } from './engine.mjs';

export function diagnoseTask(job, storage) {
  const started = job.events?.filter(e => !e.calls).at(-1)?.stage || 'queued';
  const completed = job.events?.filter(e => e.calls).map(e => e.stage) || [];
  const info = { failed_stage: job.status === 'FAILED' ? started : null, completed_stages: [...new Set(completed)],
    historical_replay: true, generated_model_calls: 0 };
  if (job.error_details?.code?.startsWith('MODEL_')) return { ...info, model_error: job.error_details,
    notice: '失败模型响应已在本地单独保存；未送入抽取或评审。重试需要明确授权，并创建新任务，不覆盖此记录。' };
  if (job.error === 'Model did not return a completed text response') return { ...info,
    notice: '旧版没有保存这次失败响应及finish_reason，不能确认是否截断、拒绝或空正文。更新后可记录具体原因；未重发本次资料。' };
  if (job.status !== 'FAILED' || !job.result?.schema || started !== 'extraction') return info;
  try {
    const call = JSON.parse(readFileSync(resolve(storage, job.id, 'call-4-extraction.json'), 'utf8'));
    const validation = validateClaims(parseModelJson(call.content), job.result.schema, job.input, { collectErrors: true });
    return { ...info, submitted: validation.submitted, valid: validation.claims.length,
      issues: validation.issues, normalization: validation.normalization,
      replay_validation_passed: validation.issues.length === 0,
      notice: '这是原响应的离线校验结果，不覆盖历史状态；未执行后续语义复核，不表示任务已经成功。' };
  } catch { return { ...info, notice: '无法完成离线复验，原始失败记录已保留。' }; }
}
