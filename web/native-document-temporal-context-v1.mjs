/** Source-text candidates only. No calendar parsing, inferred anchors, or upload metadata. */
import {clone,hash} from './cq-discovery-store-v2.mjs';
const roles=[
  ['TIMEZONE',/时区|所有时间|北京时间|\btime\s*zone\b|\bUTC\b|\bGMT\b/i],
  ['PUBLICATION',/签发|发布日|发布日期|印发|颁布|\bpublished\b|\bissued\b|publication date/i],
  ['EFFECTIVE',/生效|施行|实施日|有效期|\beffective\b|comes? into force|valid from/i],
  ['OBSERVATION',/统计截止|截至|统计期间|观测|采集时|测量时|\bas of\b|observed|measured|reporting period/i],
  ['FISCAL_PERIOD',/财年|会计年度|财政年度|\bfiscal\b|\bFY\s*\d{2,4}\b/i],
];
const expressions=/(?:\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?|\d{4}年(?:\d{1,2}月(?:\d{1,2}日)?)?(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?|(?:UTC|GMT)\s*[+-]\d{2}:\d{2}|\bFY\s*\d{2,4}\b)/gi;
export function collectNativeDocumentTemporalContext({documents=[],evidence=[],semantics=[]}={}) {
  return documents.map(doc=>{
    const candidates=[];
    const add=(quote,role,extra={})=>{
      if(typeof quote!=='string'||!quote.trim()||!doc.content?.includes(quote))return;
      const timeText=[...quote.matchAll(expressions)].map(m=>m[0]);
      const ev=evidence.filter(e=>e.document_ref===doc.ref&&(e.quote.includes(quote)||quote.includes(e.quote))).map(e=>e.ref);
      candidates.push({role,scope:'UNRESOLVED',time_text:[...new Set(timeText)],quote,quote_status:'EXACT_SUBSTRING',evidence_refs:ev,...extra});
    };
    // Role labels are routing candidates, never proof that a date applies to every statement.
    for(const line of (doc.content??'').split(/\r?\n|(?<=[。；;!?！？])\s*|(?<=\.)\s+/))for(const [role,pattern]of roles) {
      const match=pattern.exec(line);if(!match)continue;
      const start=line.length>1200?Math.max(0,match.index-400):0,end=Math.min(line.length,start+1200);
      add(line.slice(start,end),role,{quote_complete:start===0&&end===line.length});
    }
    for(const row of semantics)for(const hint of row.temporal_hints??row.package?.temporal_hints??[]) {
      if(!hint||typeof hint!=='object')continue;
      const sources=hint.source_refs?.length?hint.source_refs:row.package?.source_refs;
      if(!sources?.some(s=>s.doc_ref===doc.doc_ref&&s.revision===doc.revision))continue;
      if(hint.scope==='DOCUMENT'||roles.some(([role])=>role===hint.context_role)){
        const extra={scope:hint.scope??'UNRESOLVED',statement:hint.statement??null,semantic_refs:clone(hint.semantic_refs??[]),package_ref:row.ref,
          ...(hint.time_text?{time_text:clone(hint.time_text)}:{})};
        if(typeof hint.quote==='string'&&doc.content?.includes(hint.quote))add(hint.quote,hint.context_role,extra);
        else candidates.push({role:hint.context_role,...extra,time_text:hint.time_text??null,quote:hint.quote??null,
          quote_status:'RECORDED_UNLOCATED',evidence_refs:[],warnings:['CONTEXT_REQUIRES_SOURCE_CHECK']});
      }
    }
    const unique=[...new Map(candidates.map(c=>[hash(c),c])).values()];
    return {ref:doc.ref,title:doc.title??null,context:unique.map((c,index)=>({ref:doc.ref+'T'+(index+1),...c})),
      context_status:unique.length?'CANDIDATES_REQUIRE_SCOPE_INTERPRETATION':'NO_EXPLICIT_CONTEXT_FOUND',source_available:true};
  });
}
