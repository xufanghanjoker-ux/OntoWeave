import {readModelStream} from './stream.mjs';
import {isDashScopeEndpoint,dashScopeRequest,normalizeDashScope} from './dashscope.mjs';
/** Experimental OpenAI-compatible Chat Completions transport; no vendor SDK dependency. */
export function apiRoot(baseUrl, allowInsecureHttp = false) {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash) throw Error('Invalid model endpoint');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || allowInsecureHttp))) {
    throw Error('Remote HTTP requires explicit allowInsecureHttp; prefer HTTPS');
  }
  url.pathname = url.pathname.replace(/\/$/, '') || '/v1';
  return url.href.replace(/\/$/, '');
}

export function parseModelJson(content) {
  if (typeof content !== 'string') throw Error('Model response is not text');
  const text = content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1');
  return JSON.parse(text);
}

export function createProvider({ baseUrl, model, apiKey, allowInsecureHttp = false,
  timeoutMs = 90000, maxTokens = 6000, thinkingMode = 'default', fetchImpl = fetch }) {
  const root = apiRoot(baseUrl, allowInsecureHttp);
  const nativeDashScope=isDashScopeEndpoint(root);
  if (!model?.trim() || !apiKey?.trim()) throw Error('Model and credential required');
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 32768) throw Error('模型输出上限需为1–32768的整数');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw Error('模型超时配置无效');
  if (!['default', 'disabled', 'enabled'].includes(thinkingMode)) throw Error('思考模式配置无效');
  if (thinkingMode !== 'default' && new URL(root).hostname !== 'api.deepseek.com' && !nativeDashScope) throw Error('思考开关当前仅支持DeepSeek官方接口或DashScope原生接口；其他接口请选择服务商默认');
  // Never expose request headers or raw server errors. Redact secrets even if a server echoes them.
  const scrub = text => String(text).split(apiKey).join('[REDACTED]');
  async function request(path, payload, onDelta) {
    const started = Date.now();
    const signal = AbortSignal.timeout(timeoutMs);
    let response, bytes = 0;
    const failure = (code, message, phase, extra = {}) => Object.assign(new Error(message), { code,
      details: { code, phase, latency_ms: Date.now() - started, timeout_ms: timeoutMs,
        response_bytes: bytes, http_status: response?.status ?? null, usage: null, usage_raw: null,
        billing_status: 'UNKNOWN', requested_max_tokens: maxTokens, thinking_mode: thinkingMode, ...extra } });
    const transportFailure = (error, phase) => signal.aborted || error?.name === 'TimeoutError'
      ? failure('MODEL_TIMEOUT', '模型请求超时（上限' + timeoutMs / 1000 + '秒，' + (phase === 'headers' ? '等待响应' : '读取响应') + '阶段）；未自动重试，用量与计费未知。', phase)
      : failure(phase === 'headers' ? 'MODEL_NETWORK_ERROR' : 'MODEL_RESPONSE_READ_ERROR',
        phase === 'headers' ? 'Model request failed; request details suppressed' : '模型响应读取中断；不是JSON格式错误。未自动重试，用量与计费未知。', phase);
    try {
      response = await fetchImpl(root + path, { method: payload ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json',...(nativeDashScope?{'X-DashScope-SSE':'enable'}:{}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}), signal });
    } catch (error) {
      throw transportFailure(error, 'headers');
    }
    if (!response.ok) throw failure('MODEL_HTTP_ERROR', 'Model endpoint returned HTTP ' + response.status, 'headers');
    if(payload?.stream||nativeDashScope){try{return {body:await readModelStream(response,{onDelta,scrub,secret:apiKey,maxTrailingWhitespace:nativeDashScope?1024:Infinity,normalize:nativeDashScope?b=>normalizeDashScope(b,{stream:true}):undefined}),latency_ms:Date.now()-started};}catch(error){if(error.code?.startsWith('MODEL_')||error.stream_callback)throw error;throw transportFailure(error,'body');}}
    const decoder = new TextDecoder(); let text = '';
    try {
      const reader = response.body.getReader();
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 2_000_000) { await reader.cancel(); throw failure('MODEL_RESPONSE_TOO_LARGE', 'Model response exceeds size limit', 'body'); }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      if (error.code === 'MODEL_RESPONSE_TOO_LARGE') throw error;
      throw transportFailure(error, 'body');
    }
    let body;
    try { body = JSON.parse(scrub(text)); }
    catch {
      const trimmed = text.trimStart();
      const format = !trimmed ? 'EMPTY' : /^(?:<!doctype\b|<html\b)/i.test(trimmed) ? 'HTML'
        : /^(?:data:|event:)/.test(trimmed) ? 'SSE' : 'INVALID_JSON';
      throw failure('MODEL_RESPONSE_INVALID_JSON', '模型接口返回的响应不是有效JSON（' + format + '）；请检查兼容接口。未自动重试，响应正文已隐藏，用量与计费未知。', 'decode', { response_format: format });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('MODEL_INVALID_ENVELOPE', '模型接口返回的JSON不是有效响应对象。', 'decode');
    if(nativeDashScope){if(body.code)throw failure('MODEL_PROVIDER_ERROR','模型服务未完成请求（'+String(body.code).replace(/[^a-zA-Z0-9_.-]/g,'').slice(0,80)+'）。','decode');body=normalizeDashScope(body);}
    return { body, latency_ms: Date.now() - started };
  }
  return {
    protocol: nativeDashScope?'dashscope-multimodal':'chat-completions', model, root, maxTokens, timeoutMs, thinkingMode,
    withMaxTokens: tokens => createProvider({ baseUrl, model, apiKey, allowInsecureHttp, timeoutMs, maxTokens: tokens, thinkingMode, fetchImpl }),
    withOptions: ({ maxTokens: tokens = maxTokens, thinkingMode: thinking = thinkingMode } = {}) => createProvider({ baseUrl, model, apiKey, allowInsecureHttp, timeoutMs, maxTokens: tokens, thinkingMode: thinking, fetchImpl }),
    async probe() {
      if(nativeDashScope){const p=createProvider({baseUrl,model,apiKey,allowInsecureHttp,timeoutMs,maxTokens:32,thinkingMode:'disabled',fetchImpl});await p.complete([{role:'user',content:'Reply OK.'}]);return {available:true,configured_model:model};}
      const { body } = await request('/models');
      if (!Array.isArray(body.data)) throw Error('Invalid models response');
      if (!body.data.some(m => m.id === model)) throw Error('Configured model absent from model list');
      return { available: true, configured_model: model };
    },
    async complete(messages,{jsonObject=false,onDelta}={}) {
      const { body, latency_ms } = await request(nativeDashScope?'':'/chat/completions',
        nativeDashScope?dashScopeRequest(model,messages,{maxTokens,jsonObject,stream:true,thinkingMode}):{ model, messages, max_tokens: maxTokens, stream: typeof onDelta==='function',
          ...(typeof onDelta==='function'&&new URL(root).hostname==='api.deepseek.com'?{stream_options:{include_usage:true}}:{}),
          ...(jsonObject&&new URL(root).hostname==='api.deepseek.com'?{response_format:{type:'json_object'}}:{}),
          ...(thinkingMode !== 'default' ? { thinking: { type: thinkingMode } } : {}) },onDelta);
      const choice = Array.isArray(body.choices) ? body.choices[0] : null;
      const usage = {};
      for (const name of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
        if (Number.isFinite(body.usage?.[name]) && body.usage[name] >= 0) usage[name] = body.usage[name];
      }
      const usage_raw = body.usage && typeof body.usage === 'object' && !Array.isArray(body.usage) ? body.usage : null;
      let code, message;
      if (!choice) { code = 'MODEL_MISSING_CHOICE'; message = '模型接口没有返回候选回答（choices）；请检查兼容接口或服务状态。'; }
      else if (choice.finish_reason === 'length') { code = 'MODEL_OUTPUT_TRUNCATED'; message = '模型输出被截断（finish_reason=length）；可能达到输出或上下文上限，未接受不完整结果。'; }
      else if (choice.finish_reason === 'content_filter' || choice.message?.refusal) { code = 'MODEL_REFUSAL'; message = '模型拒绝回答或触发内容过滤，未生成可用结果。'; }
      else if (choice.finish_reason !== 'stop') { code = 'MODEL_UNSUPPORTED_FINISH'; message = '模型返回未支持的结束状态；本流程需要完整文本，不执行工具调用或猜测输出已完成。'; }
      else if (typeof choice.message?.content !== 'string' || !choice.message.content.trim()) { code = 'MODEL_EMPTY_TEXT'; message = '模型没有返回可用正文；推理内容不作为最终回答。'; }
      if (code) {
        const error = new Error(message); error.code = code;
        error.details = { code, finish_reason: typeof choice?.finish_reason === 'string' ? choice.finish_reason.slice(0, 80) : null,
          content_type: choice?.message?.content === null ? 'null' : typeof choice?.message?.content,
          content_characters: typeof choice?.message?.content === 'string' ? choice.message.content.length : 0,
          reasoning_characters: typeof choice?.message?.reasoning_content === 'string' ? choice.message.reasoning_content.length : 0,
          requested_max_tokens: maxTokens, thinking_mode: thinkingMode, usage, usage_raw, latency_ms,
          reported_model: typeof body.model === 'string' ? body.model.slice(0, 200) : null };
        // Only the bounded, credential-redacted response body is attached; no request headers or keys.
        error.model_response = body; throw error;
      }
      return { content: choice.message.content, streaming:body._streaming===true, reported_model: typeof body.model === 'string' ? body.model : null,
        latency_ms, usage, usage_raw, thinking_mode: thinkingMode, usage_status: Object.keys(usage).length ? 'REPORTED' : 'UNKNOWN' };
    },
  };
}
