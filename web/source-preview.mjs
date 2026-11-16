/** Bounded source previews. All returned text is sliced at the original absolute UTF-16 offsets. */
const splitPair=(text,index)=>index>0&&index<text.length&&/[\uD800-\uDBFF]/.test(text[index-1])&&/[\uDC00-\uDFFF]/.test(text[index]);
const safeStart=(text,index)=>splitPair(text,index)?index+1:index;
const safeEnd=(text,index)=>splitPair(text,index)?index-1:index;
const validBlock=(block,length)=>Number.isInteger(block?.start)&&Number.isInteger(block?.end)&&block.start>=0&&block.end>block.start&&block.end<=length;
function merge(ranges){
  const ordered=ranges.filter(r=>r.end>r.start).sort((a,b)=>a.start-b.start),out=[];
  for(const range of ordered){const last=out.at(-1);if(last&&range.start<=last.end)last.end=Math.max(last.end,range.end);else out.push({...range});}
  return out;
}
function around(text,claim,range,radius,budget){
  const quoteLength=claim.end-claim.start;
  const allowance=quoteLength>budget?2*radius:Math.max(0,budget-quoteLength);
  let left=Math.min(radius,Math.ceil(allowance/2),claim.start-range.start);
  const right=Math.min(radius,Math.max(0,allowance-left),range.end-claim.end);
  left=Math.min(radius,claim.start-range.start,left+Math.max(0,allowance-left-right));
  return {start:safeStart(text,claim.start-left),end:safeEnd(text,claim.end+right)};
}
function linesOf(text,start,end){
  const lines=[];let cursor=start;
  for(const value of text.slice(start,end).match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)||[]){
    if(!value.length)continue;lines.push({start:cursor,end:cursor+value.length,text:value.replace(/[\r\n]+$/,'')});cursor+=value.length;
  }
  return lines;
}
function separator(line){
  const value=line.trim().replace(/^\|/,'').replace(/\|$/,'');
  const cells=value.split('|').map(c=>c.trim());return cells.length>0&&cells.every(c=>/^:?-{3,}:?$/.test(c));
}
function pageLabel(source,blocks){
  const extension=String(source.parsing?.extension||source.extension||'').toLowerCase();
  if(extension==='.docx'||extension==='.doc')return '';
  const pages=[...new Set(blocks.flatMap(b=>Array.isArray(b.provenance)?b.provenance.map(p=>p?.page_no):[])
    .filter(page=>Number.isInteger(page)&&page>0))].sort((a,b)=>a-b);
  return pages.length?'第 '+pages.join('、')+' 页 · ':'';
}
function paragraphRange(text,claim,radius){
  const left=Math.max(0,claim.start-radius),right=Math.min(text.length,claim.end+radius);
  let start=left,end=right;
  const before=[],after=[];
  const neighborhood=text.slice(Math.max(0,left-4),Math.min(text.length,right+4)),offset=Math.max(0,left-4);
  for(const match of neighborhood.matchAll(/\r?\n[ \t]*(?:\r?\n)+/g)){
    const a=offset+match.index,b=a+match[0].length;
    if(b<=claim.start&&b>=left)before.push(b);
    if(a>=claim.end&&a<=right)after.push(a);
  }
  // Include an adjacent paragraph when it fits, instead of hiding a heading or scope on the previous line.
  if(before.length>1)start=Math.max(left,before.at(-2));
  if(after.length>1)end=Math.min(right,after[1]);
  return {start,end};
}
function segment(text,range,claim){
  const a=Math.max(range.start,claim.start),b=Math.min(range.end,claim.end);
  if(a<b)return {start:range.start,end:range.end,before:text.slice(range.start,a),highlight:text.slice(a,b),after:text.slice(b,range.end)};
  return {start:range.start,end:range.end,before:range.end<=claim.start?text.slice(range.start,range.end):'',highlight:'',after:range.start>=claim.end?text.slice(range.start,range.end):''};
}

export function sourcePreview(source,claim,{radius=280,maxContext=1400}={}){
  const quote=typeof claim?.quote==='string'?claim.quote:'';
  const invalid=notice=>({valid:false,segments:[],locator:'原文位置待核对',kind:'paragraph',quote,notice});
  if(typeof source?.content!=='string'||!quote||!Number.isInteger(claim?.start)||!Number.isInteger(claim?.end)
    ||claim.start<0||claim.end<=claim.start||claim.end>source.content.length)return invalid('证据偏移无效，未猜测或重新搜索位置；请核对原件。');
  if(source.id&&claim.source_id&&source.id!==claim.source_id)return invalid('证据来源与当前资料不一致，未在其他资料中寻找同句。');
  if(claim.offset_unit&&claim.offset_unit!=='utf16_code_unit')return invalid('证据偏移不是UTF16单位，需先核对定位契约。');
  if(source.content.slice(claim.start,claim.end)!==quote)return invalid('该偏移处原文与引文不一致，未改用同句的其他位置。');
  if(splitPair(source.content,claim.start)||splitPair(source.content,claim.end))return invalid('证据偏移切入了完整Unicode字符，未移动原始定位。');
  if(!Number.isInteger(radius)||radius<0||!Number.isInteger(maxContext)||maxContext<1)return invalid('预览上下文参数无效。');
  const text=source.content,blocks=(Array.isArray(source.parsing?.blocks)?source.parsing.blocks:[])
    .filter(b=>validBlock(b,text.length)&&!splitPair(text,b.start)&&!splitPair(text,b.end));
  const containing=blocks.filter(b=>b.start<=claim.start&&b.end>=claim.end),overlapping=blocks.filter(b=>b.start<claim.end&&b.end>claim.start);
  const table=containing.find(b=>String(b.kind).toLowerCase()==='table');
  let ranges,kind='paragraph',locator,notice=quote.length>maxContext?'引文较长，完整保留；只展示有界邻接上下文。':undefined;
  if(table){
    kind='table';const lines=linesOf(text,table.start,table.end),hits=lines.map((line,i)=>line.start<claim.end&&line.end>claim.start?i:-1).filter(i=>i>=0);
    const first=hits[0],last=hits.at(-1),divider=lines.findIndex((line,i)=>i>0&&separator(line.text)),headers=[];
    if(divider>=1){
      for(const index of [divider-1,divider]){
        const line=lines[index],limit=Math.max(1,Math.floor(maxContext/4));
        headers.push({start:line.start,end:safeEnd(text,Math.min(line.end,line.start+limit))});
        if(line.end-line.start>limit)notice='表头较宽，仅展示有界原文片段；完整表格请查看原件。';
      }
    }else notice='未识别标准Markdown表头；展示命中行及相邻原文，不展开整张表。';
    const neighboring={start:lines[Math.max(0,first-1)].start,end:lines[Math.min(lines.length-1,last+1)].end};
    // Header ranges outside the quotation have a separate bounded share; never clip the quote itself.
    const headerOnly=headers.filter(h=>h.end<=claim.start||h.start>=claim.end),headerSize=merge(headerOnly).reduce((n,r)=>n+r.end-r.start,0);
    const body=around(text,claim,neighboring,radius,Math.max(quote.length,maxContext-headerSize));
    ranges=merge([...headers,body]);
    const number=blocks.filter(b=>String(b.kind).toLowerCase()==='table').indexOf(table)+1;
    locator=pageLabel(source,[table])+'表格 '+number+' · 原文第 '+(first+1)+(last!==first?'–'+(last+1):'')+' 行';
  }else{
    ranges=[around(text,claim,paragraphRange(text,claim,radius),radius,maxContext)];
    const block=containing[0]||overlapping[0];
    const paragraph=block?'文本块 '+(blocks.indexOf(block)+1):'第 '+(1+[...text.slice(0,claim.start).matchAll(/\r?\n[ \t]*(?:\r?\n)+/g)].length)+' 段';
    locator=pageLabel(source,overlapping)+paragraph;
  }
  return {valid:true,segments:ranges.map(range=>segment(text,range,claim)),locator,kind,quote,...(notice?{notice}:{})};
}
