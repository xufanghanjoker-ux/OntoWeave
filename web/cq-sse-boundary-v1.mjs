/** Incremental transport accounting. Never turns a prefix into a completed response.
 * semantic_payload_bytes counts transmitted text/argument copies, including done
 * snapshots; it is deliberately conservative, not unique output or token usage. */
import {need} from './cq-discovery-store-v2.mjs';
const size=s=>Buffer.byteLength(s,'utf8');
function payload(value) {
  if(!value||typeof value!=='object')return 0;
  if(Array.isArray(value))return value.reduce((n,v)=>n+payload(v),0);
  return Object.entries(value).reduce((n,[k,v])=>n+(['delta','text','arguments','refusal'].includes(k)&&typeof v==='string'?size(v):typeof v==='object'?payload(v):0),0);
}
export function createCQSSEBoundary(limits) {
  for(const k of ['max_sse_frame_bytes','max_sse_events','max_semantic_bytes'])need(Number.isSafeInteger(limits[k])&&limits[k]>0,'CQ_GATE_LIMIT_INVALID');
  let pending=Buffer.alloc(0),events=0,semantic=0,raw=0,peak=0,terminal=false,done=false;
  const types={};
  function frame(bytes) {
    need(bytes.length<=limits.max_sse_frame_bytes,'CQ_SSE_FRAME_TOO_LARGE');
    let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{need(false,'CQ_STREAM_UTF8_INVALID');}
    const lines=text.split(/\r?\n/),data=lines.filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
    if(!data)return;
    if(data==='[DONE]'){need(terminal&&!done,'CQ_STREAM_PREMATURE_DONE');done=true;return;}
    need(!terminal&&!done,'CQ_STREAM_AFTER_TERMINAL');
    let e;try{e=JSON.parse(data);}catch{need(false,'CQ_STREAM_JSON_INVALID');}
    need(e&&typeof e==='object'&&typeof e.type==='string','CQ_STREAM_EVENT_INVALID');
    const named=lines.filter(l=>l.startsWith('event:')).map(l=>l.slice(6).trim());
    need(!named.length||named.length===1&&named[0]===e.type,'CQ_STREAM_EVENT_MISMATCH');
    events++;need(events<=limits.max_sse_events,'CQ_SSE_EVENT_LIMIT');types[e.type]=(types[e.type]??0)+1;
    semantic+=payload(e);need(semantic<=limits.max_semantic_bytes,'CQ_SEMANTIC_TOO_LARGE');
    if(e.type==='response.completed')terminal=true;
  }
  function push(chunk) {
    const b=Buffer.from(chunk);raw+=b.length;
    // Slice untrusted chunks before retaining: pending never exceeds one frame.
    for(let at=0;at<b.length;){
      const room=limits.max_sse_frame_bytes+4-pending.length;
      need(room>0,'CQ_SSE_FRAME_TOO_LARGE');const take=Math.min(room,b.length-at);
      pending=Buffer.concat([pending,b.subarray(at,at+take)]);at+=take;peak=Math.max(peak,pending.length);
      for(;;){const lf=pending.indexOf('\n\n'),crlf=pending.indexOf('\r\n\r\n');let end,sep;
        if(crlf>=0&&(lf<0||crlf<lf)){end=crlf;sep=4;}else if(lf>=0){end=lf;sep=2;}else break;
        frame(pending.subarray(0,end));pending=pending.subarray(end+sep);
      }
      need(pending.length<=limits.max_sse_frame_bytes+3,'CQ_SSE_FRAME_TOO_LARGE');
    }
  }
  const metrics=()=>({raw_bytes:raw,event_count:events,semantic_payload_bytes:semantic,peak_frame_buffer_bytes:peak,pending_bytes:pending.length,completion_seen:terminal,event_types:{...types},semantic_accounting:'TRANSMITTED_TEXT_ARGUMENT_COPIES_NOT_TOKENS'});
  return {push,metrics,finish(){need(pending.length===0,'CQ_STREAM_TRUNCATED');need(terminal,'CQ_STREAM_RESULT_UNKNOWN');return metrics();}};
}
