/** Program-owned classifications. Never read an outcome from model arguments. */
import {hash} from './cq-discovery-store-v2.mjs';
import {qualifiedNativeCall} from './native-tool-completion-v1.mjs';

export function toolOutcome(value) {
  if (value?.ok !== false) return (value?.execution_outcome === 'ITEM_WARNING' || value?.result?.warnings?.length) ? 'ITEM_WARNING'
    : value?.execution_outcome === 'REUSED' ? 'REUSED' : 'SUCCESS';
  const outcome = value.execution_outcome;
  return ['LOCAL_REJECT', 'BATCH_FAILED_KNOWN', 'UNKNOWN_HOLD'].includes(outcome) ? outcome : 'FATAL';
}

export const callSettled = call => ['COMPLETED', 'LOCAL_REJECT'].includes(call.status);
export const batchSettled = batch => batch.calls.every(callSettled);
export const toolDoesNotStop = outcome => ['SUCCESS', 'REUSED', 'ITEM_WARNING', 'LOCAL_REJECT'].includes(outcome);
export const localReject = (code, message) => ({ok: false, execution_outcome: 'LOCAL_REJECT', error: {code, message}});

export function fixedMaterialInput(args) {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const keys = Object.keys(args);
    if (!keys.length) return {args};
    if (keys.length === 1 && keys[0] === '_raw' && typeof args._raw === 'string'
        && /^[ \t\r\n]*\{[ \t\r\n]*\}[ \t\r\n]*$/.test(args._raw)) return {args: {}, normalized: true};
  }
  return {result: localReject('FIXED_MATERIAL_ARGUMENTS_INVALID', '此工具读取当前批次的固定材料。请仅提交空对象 {}。')};
}

function containsExact(value, expected, depth = 0) {
  if (depth > 8 || value == null) return false;
  if (typeof value === 'string') {
    try { return containsExact(JSON.parse(value.trim().replace(/^(?:Wall time:[^\n]*\n(?:[^\n]*\n)*?Output:\s*|Output:\s*)/, '')), expected, depth + 1); }
    catch { return false; }
  }
  if (Array.isArray(value)) return value.some(item => containsExact(item, expected, depth + 1));
  return typeof value === 'object' && (hash(value) === expected
    || ['structuredContent', 'content', 'output', 'text'].some(key => containsExact(value[key], expected, depth + 1)));
}

export function matchesLocalResult(call, value) {
  return call?.status === 'LOCAL_REJECT' && call.result && containsExact(value, hash(call.result));
}

export function localToolFeedback(batches, body, item) {
  const originals = body.input.filter(i => i.type === 'function_call' && i.call_id === item.call_id);
  return originals.length > 0 && batches.some(batch => batch.calls.some(call =>
    call.call_id === item.call_id && matchesLocalResult(call, item.output) && originals.every(original => {
      try {
        return qualifiedNativeCall(original) === call.qualified_tool_name
          && hash(JSON.parse(original.arguments)) === call.arguments_sha256;
      } catch { return false; }
    })
  ));
}

export function failureClass(reason) {
  return ['NATIVE_UPSTREAM_HTTP_FAILED', 'CQ_STREAM_FAILED', 'NATIVE_ROLE_OUTPUT_NOT_SAVED',
    'NATIVE_LOCAL_NO_PROGRESS'].includes(reason) ? 'BATCH_FAILED_KNOWN' : 'FATAL';
}

// The receiver still owns shape and item validation. This only guards against
// swallowing fields outside the declared write contract.
export function hasUndeclaredWriteField(schema, value) {
  if (Array.isArray(value)) return schema.items && value.some(item => hasUndeclaredWriteField(schema.items, item));
  if (!value || typeof value !== 'object' || !schema.properties) return false;
  return Object.entries(value).some(([key, child]) => Object.hasOwn(schema.properties, key)
    ? hasUndeclaredWriteField(schema.properties[key], child) : schema.additionalProperties === false);
}
