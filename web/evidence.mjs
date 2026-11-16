/** Conservative source alignment. Never fuzzy-match words, numbers or punctuation. */
const cjkLayoutGap = /(?<=\p{Script=Han})[ \t\r\n\u00a0\u3000]+(?=\p{Script=Han})/gu;
function compact(text) {
  const gaps = [...text.matchAll(cjkLayoutGap)];
  const offsets = []; let value = '', gap = 0;
  for (let i = 0; i < text.length; i++) {
    while (gap < gaps.length && i >= gaps[gap].index + gaps[gap][0].length) gap++;
    if (gap < gaps.length && i >= gaps[gap].index && i < gaps[gap].index + gaps[gap][0].length) continue;
    offsets.push(i); value += text[i];
  }
  return { value, offsets };
}
function matches(text, quote) {
  const found = []; let pos = 0;
  while ((pos = text.indexOf(quote, pos)) >= 0) { found.push(pos); pos++; if (found.length > 1) break; }
  return found;
}
function fail(code, message) { const error = Error(message); error.code = code; throw error; }
// assembleDocument inserts a blank line between adjacent parser blocks. Models may copy
// it as one newline; align only that known separator, preserving every other character.
function parserSeparators(source,quote){
  const content=source.content,blocks=source.parsing.blocks||[],offsets=[],gaps=[];let value='';
  for(let i=0;i<content.length;){
    if(content[i]==='\n'&&content[i+1]==='\n'){
      let end=i+2;while(content[end]==='\n')end++;
      value+='\n';offsets.push({start:i,end});gaps.push({start:i,end});i=end;
    }else{value+=content[i];offsets.push({start:i,end:i+1});i++;}
  }
  const proposed=quote.replace(/\n{2,}/g,'\n'),found=matches(value,proposed);
  if(found.length!==1)return null;
  const start=offsets[found[0]]?.start,end=offsets[found[0]+proposed.length-1]?.end;
  const changed=gaps.filter(g=>g.start>=start&&g.end<=end);
  if(!changed.length||!changed.every(g=>blocks.some(b=>b.end===g.start)&&blocks.some(b=>b.start===g.end)))return null;
  return {start,end,quote:content.slice(start,end),method:'PARSER_BLOCK_SEPARATOR_NEWLINE_V1',model_quote:quote};
}
export function alignQuote(source, quote) {
  const exact = matches(source.content, quote);
  if (exact.length === 1) return { start: exact[0], end: exact[0] + quote.length, quote, method: 'EXACT' };
  if (exact.length > 1) fail('EVIDENCE_AMBIGUOUS', '引文在原文出现多次，不能自动选择证据位置');
  if (!source.parsing) fail('EVIDENCE_NOT_FOUND', '引文不在原文中');
  const separators=parserSeparators(source,quote);if(separators)return separators;
  const original = compact(source.content), proposed = compact(quote).value;
  const found = matches(original.value, proposed);
  if (!found.length) fail('EVIDENCE_NOT_FOUND', '引文不在原文中，中文排版空白对齐也未命中');
  if (found.length !== 1) fail('EVIDENCE_AMBIGUOUS', '空白对齐后引文不唯一，不能自动选择位置');
  const start = original.offsets[found[0]], end = original.offsets[found[0] + proposed.length - 1] + 1;
  const blocks = source.parsing.blocks || [];
  if (!blocks.some(b => b.start <= start && b.end >= end)) fail('EVIDENCE_CROSSES_BLOCKS', '空白对齐跨越解析文本块，需要重新引用连续原文');
  return { start, end, quote: source.content.slice(start, end), method: 'CJK_LAYOUT_WHITESPACE_V1', model_quote: quote };
}
