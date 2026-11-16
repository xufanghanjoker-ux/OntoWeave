/** Bounded model contexts; originals are never truncated or rewritten. Offsets are UTF-16. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export const SOURCE_CONTEXT_VERSION='source_context_v1';
export const EXTRACTION_MAX_CHARS=6000;
export const EXTRACTION_OVERLAP=400;
export const CONTEXT_MAX_CHARS=16000;
export const REVIEW_MAX_CLAIMS=40;
export const REVIEW_MAX_CHARS=24000;
const reviewClaim=claim=>Object.fromEntries(['id','subject_id','predicate_id','value','source_id','quote','modality','comparator','unit','scope','effective_from','time_raw',
  'start','end','offset_unit','evidence_id','source_role','independently_verified','support_set'].filter(key=>claim[key]!==undefined).map(key=>[key,claim[key]]));
const boundary=(text,index)=>index>0&&index<text.length&&/[\uDC00-\uDFFF]/.test(text[index])&&/[\uD800-\uDBFF]/.test(text[index-1])?index-1:index;
export function extractionUnits(sources,{maxChars=EXTRACTION_MAX_CHARS,overlap=EXTRACTION_OVERLAP}={}){
  assert(Number.isInteger(maxChars)&&maxChars>=100&&Number.isInteger(overlap)&&overlap>=0&&overlap<maxChars,'分块参数无效');
  const units=[];
  for(const source of sources){
    assert(typeof source.content==='string','来源正文无效');
    const sourceHash=source.sha256||hash(source.content);let start=0;
    while(start<source.content.length){
      let end=boundary(source.content,Math.min(start+maxChars,source.content.length));
      if(end<source.content.length){
        const tail=source.content.slice(Math.max(start+maxChars-overlap-200,start),end),matches=[...tail.matchAll(/[。！？\n]/g)];
        if(matches.length){const candidate=end-tail.length+matches.at(-1).index+1;if(candidate>start+overlap+100)end=candidate;}
      }
      units.push({id:'unit_'+hash({source_id:source.id,source_hash:sourceHash,start,end,policy:SOURCE_CONTEXT_VERSION,maxChars,overlap}).slice(0,24),
        source_id:source.id,title:source.title,source_sha256:sourceHash,start,end,text:source.content.slice(start,end),offset_unit:'utf16_code_unit',policy:SOURCE_CONTEXT_VERSION});
      if(end===source.content.length)break;
      const next=boundary(source.content,Math.max(start+1,end-overlap));
      // An overlap of maxChars-1 can round back to the same surrogate boundary.
      start=next>start?next:end;
    }
  }
  return units;
}
function keywords(cqs){
  const text=cqs.map(q=>typeof q==='string'?q:q.question||q.text||'').join(' ');
  return [...new Set([...(text.match(/[A-Za-z0-9_-]{2,}/g)||[]),...[...text.matchAll(/[\p{Script=Han}]{2,}/gu)].flatMap(m=>{
    const chars=[...m[0]],words=[];for(let i=0;i<chars.length-1;i++)words.push(chars.slice(i,i+2).join(''));return words;})])];
}
export function contextSources(sources,cqs=[],{maxChars=CONTEXT_MAX_CHARS}={}){
  if(!sources.length)return [];
  assert(Number.isInteger(maxChars)&&maxChars>=sources.length,'上下文预算无效');
  const share=Math.floor(maxChars/sources.length),words=keywords(cqs);
  return sources.map(source=>{
    const content=source.content,window=Math.max(1,Math.min(1000,Math.floor(share/3)));
    if(content.length<=share)return {id:source.id,title:source.title,source_role:source.source_role,text:content,
      context_scope:{mode:'CQ_RELEVANT_SAMPLES',complete:true,ranges:[{start:0,end:content.length}],source_characters:content.length,policy:SOURCE_CONTEXT_VERSION}};
    const starts=new Set([0,Math.max(0,content.length-window)]);
    for(let i=1;i<=8;i++)starts.add(boundary(content,Math.floor(content.length*i/9)));
    for(const word of words){let position=-1;for(let hit=0;hit<20;hit++){position=content.indexOf(word,position+1);if(position<0)break;starts.add(boundary(content,Math.max(0,position-Math.floor(window/3))));}}
    const candidates=[...starts].map(start=>({start,end:boundary(content,Math.min(content.length,start+window))}));
    const score=range=>words.reduce((n,word)=>n+(content.slice(range.start,range.end).includes(word)?1:0),0);
    candidates.sort((a,b)=>score(b)-score(a)||a.start-b.start);
    const tail={start:boundary(content,Math.max(0,content.length-window)),end:content.length};
    const selected=[tail];let size=tail.end-tail.start;
    for(const candidate of candidates){
      if(selected.some(r=>r.start<candidate.end&&r.end>candidate.start))continue;
      if(size+candidate.end-candidate.start+5>share)continue;
      selected.push(candidate);size+=candidate.end-candidate.start+5;
    }
    selected.sort((a,b)=>a.start-b.start);
    return {id:source.id,title:source.title,source_role:source.source_role,text:selected.map(r=>content.slice(r.start,r.end)).join('\n…\n'),
      context_scope:{mode:'CQ_RELEVANT_SAMPLES',complete:false,ranges:selected,source_characters:content.length,policy:SOURCE_CONTEXT_VERSION,
        notice:'仅CQ相关有限样本，不代表全文理解；全文将分块抽取。'}};
  });
}
export function claimReviewBatches(claims,{maxClaims=REVIEW_MAX_CLAIMS,maxChars=REVIEW_MAX_CHARS}={}){
  const batches=[];let current=[],indices=[],size=2;
  const flush=()=>{if(!current.length)return;batches.push({id:'claims_'+hash(current.map(c=>c.id)).slice(0,24),claims:current,indices});current=[];indices=[];size=2;};
  claims.forEach((original,index)=>{const claim=reviewClaim(original),length=JSON.stringify(claim).length;
    assert(length+2<=maxChars,'单条声明超出评审批次容量，需要缩小引文或属性范围，原始资料未截断');
    if(current.length>=maxClaims||size+length+(current.length?1:0)>maxChars)flush();size+=length+(current.length?1:0);current.push(claim);indices.push(index);
  });flush();
  return batches.length?batches:[{id:'claims_empty',claims:[],indices:[]}];
}
