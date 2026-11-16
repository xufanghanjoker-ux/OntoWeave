/** DashScope native multimodal text transport normalization. No image fetches. */
export const isDashScopeEndpoint = root => new URL(root).pathname === '/api/v1/services/aigc/multimodal-generation/generation';
export function dashScopeRequest(model,messages,{maxTokens,jsonObject=false,stream=false,thinkingMode='default'}={}) {
  return {model,input:{messages:messages.map(m=>({role:m.role,content:[{text:m.content}]}))},parameters:{max_tokens:maxTokens,
    // Native JSON constraints vary by model. Keep JSON instructions and validate the
    // returned text; qwen3.7-flash was observed to loop on whitespace in JSON mode.
    ...(stream?{incremental_output:true}:{}),
    ...(thinkingMode!=='default'?{enable_thinking:thinkingMode==='enabled'}:{})}};
}
export function normalizeDashScope(body,{stream=false}={}) {
  if(body.code) return {error:{code:body.code}};
  const choice=body.output?.choices?.[0],parts=choice?.message?.content;
  const text=typeof parts==='string'?parts:Array.isArray(parts)?parts.filter(p=>typeof p.text==='string').map(p=>p.text).join(''):undefined;
  const finish=choice?.finish_reason;
  return {model:body.model,choices:choice?[{finish_reason:finish==='null'?null:finish,
    ...(stream?{delta:{content:text}}:{message:{content:text}})}]:[],
    usage:body.usage?{prompt_tokens:body.usage.input_tokens,completion_tokens:body.usage.output_tokens,total_tokens:body.usage.total_tokens,
      ...(body.usage.prompt_tokens_details?{prompt_tokens_details:body.usage.prompt_tokens_details}:{})}:undefined};
}
