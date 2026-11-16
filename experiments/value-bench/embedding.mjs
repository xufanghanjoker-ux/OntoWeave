/** Explicit OpenAI-compatible embeddings transport. No default model and no fallback. */
export function createEmbeddingProvider({ baseUrl, model, apiKey, allowInsecureHttp = false, fetchImpl = fetch, timeoutMs = 90000 } = {}) {
  if (!baseUrl || !model || !apiKey) throw Error('BLOCKED_CONFIGURATION: explicit embedding endpoint/model/credential required');
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash || !['https:','http:'].includes(url.protocol)) throw Error('Invalid embedding endpoint');
  if (url.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname) && !allowInsecureHttp) throw Error('Remote embedding HTTP requires explicit opt-in');
  const root = url.href.replace(/\/$/,'');
  const scrub = value => typeof value === 'string' ? value.split(apiKey).join('[REDACTED]') : Array.isArray(value) ? value.map(scrub)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key,item]) => [scrub(key),scrub(item)])) : value;
  return { model, root, async embed(input) {
    if (!Array.isArray(input) || !input.length || input.some(x => typeof x !== 'string')) throw Error('Invalid embedding input');
    let response;
    try { response = await fetchImpl(root + '/embeddings', { method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer '+apiKey, 'Content-Type':'application/json' }, body: JSON.stringify({ model, input }), signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw Error('Embedding request failed or timed out; details suppressed'); }
    if (!response.ok) throw Error('Embedding endpoint returned HTTP '+response.status);
    if (!response.body) throw Error('Embedding response body missing');
    const reader = response.body.getReader(), decoder = new TextDecoder(); let bytes = 0, text = '';
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 8_000_000) { await reader.cancel(); throw Error('Embedding response exceeds size limit'); }
        text += decoder.decode(chunk.value,{stream:true});
      }
      text += decoder.decode();
    } catch (error) {
      if (error.message === 'Embedding response exceeds size limit') throw error;
      throw Error('Embedding response stream failed; details suppressed');
    }
    let body; try { body = JSON.parse(text); } catch { throw Error('Invalid embedding response'); }
    const rows = Array.isArray(body.data) ? [...body.data].sort((a,b) => a.index-b.index) : [];
    if (rows.length !== input.length || rows.some((r,i) => r.index !== i || !Array.isArray(r.embedding) || !r.embedding.length || r.embedding.some(n => !Number.isFinite(n))) || rows.some(r => r.embedding.length !== rows[0].embedding.length)) throw Error('Invalid embedding shape');
    const usage_raw = body.usage && typeof body.usage === 'object' && !Array.isArray(body.usage) ? scrub(body.usage) : null;
    const usage = {}; for (const [k,v] of Object.entries(usage_raw || {})) if (Number.isFinite(v) && v >= 0) usage[k] = v;
    return { vectors: rows.map(r => r.embedding), usage, usage_raw,
      reported_model:typeof body.model === 'string' ? scrub(body.model).slice(0,200) : null };
  } };
}
