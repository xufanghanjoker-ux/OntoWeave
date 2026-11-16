export function tokens(text) {
  const latin = String(text).toLowerCase().match(/[a-z0-9_]+/g) || [];
  const runs = String(text).match(/[\p{Script=Han}]+/gu) || [];
  return [...latin, ...runs.flatMap(run => { const chars = [...run]; return chars.length === 1 ? chars : chars.slice(0,-1).map((c,i) => c + chars[i+1]); })];
}
export function chunkSources(sources, size = 800, overlap = 120) {
  if (!(size > overlap && overlap >= 0)) throw Error('Invalid chunk bounds');
  return sources.flatMap(source => {
    const rows = []; let start = 0;
    while (start < source.text.length) {
      let end = Math.min(start + size, source.text.length);
      if (end < source.text.length && /[\uD800-\uDBFF]/.test(source.text[end-1])) end--;
      rows.push({ id: `${source.id}:${start}:${end}`, source_id: source.id, start, end, text: source.text.slice(start,end) });
      if (end === source.text.length) break;
      start = end - overlap;
      if (/[\uDC00-\uDFFF]/.test(source.text[start])) start++;
    }
    return rows;
  });
}
export function bm25(query, chunks) {
  const docs = chunks.map(c => tokens(c.text)), terms = [...new Set(tokens(query))];
  const avg = docs.reduce((n,d) => n+d.length,0) / (docs.length || 1);
  const df = new Map(terms.map(t => [t, docs.filter(d => d.includes(t)).length]));
  return chunks.map((chunk,i) => ({ chunk, score: terms.reduce((s,t) => {
    const tf = docs[i].filter(x => x === t).length;
    return s + Math.log(1 + (docs.length-df.get(t)+.5)/(df.get(t)+.5)) * tf*2.2/(tf+1.2*(.25+.75*docs[i].length/(avg || 1)));
  },0) })).sort((a,b) => b.score-a.score || a.chunk.id.localeCompare(b.chunk.id));
}
export function cosine(a,b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length || [...a,...b].some(x => !Number.isFinite(x))) throw Error('Invalid embedding dimensions');
  const norm = Math.hypot(...a)*Math.hypot(...b);
  return norm ? a.reduce((s,x,i) => s+x*b[i],0)/norm : 0;
}
export function hybridRetrieve(query, chunks, vectors, queryVector, { top = 8, chars = 6000 } = {}) {
  if (!vectors || vectors.length !== chunks.length || !queryVector) throw Error('BLOCKED_CONFIGURATION: embeddings required; no retrieval fallback');
  const lexical = bm25(query,chunks).slice(0,20);
  const dense = chunks.map((chunk,i) => ({ chunk, score: cosine(vectors[i],queryVector) })).sort((a,b) => b.score-a.score || a.chunk.id.localeCompare(b.chunk.id)).slice(0,20);
  const scores = new Map();
  for (const ranking of [lexical,dense]) ranking.forEach((row,i) => scores.set(row.chunk.id,(scores.get(row.chunk.id)||0)+1/(60+i+1)));
  const sorted = chunks.map(chunk => ({ ...chunk, score: scores.get(chunk.id)||0 })).sort((a,b) => b.score-a.score || a.id.localeCompare(b.id));
  const selected = []; let used = 0;
  for (const row of sorted) { if (selected.length >= top) break; if (used + row.text.length > chars) continue; selected.push(row); used += row.text.length; }
  return selected;
}
