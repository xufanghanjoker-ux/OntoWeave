/** Every inference POST (including a runtime retry) must pass this durable gate.
 * Buffer and validate bounded SSE before Codex can execute any returned tool. */
import {createCQDiscoveryStore,hash,id,need,clone} from './cq-discovery-store-v2.mjs';
import {CQ_TOOLS} from './lightog-cq-tools-v1.mjs';
import {CQ_LOOP_EXTRA_TOOLS} from './cq-agent-loop-v1.mjs';
import {createHash} from 'node:crypto';
import {createCQSSEBoundary} from './cq-sse-boundary-v1.mjs';
import {CQ_LIST_TOOLS} from './cq-list-output-v1.mjs';
import {CQ_QUALITY_TOOL} from './cq-quality-local-v1.mjs';
const bytesSHA=bytes=>createHash('sha256').update(bytes).digest('hex');
const knownTools=[...CQ_TOOLS,...CQ_LOOP_EXTRA_TOOLS];
export const CQ_WIRE_NAMES=knownTools.map(n=>'mcp__lightog_cq__'+n);
const allowed=name=>CQ_WIRE_NAMES.includes(name);
export function restrictCQWire(body,allowedNames=CQ_WIRE_NAMES) {
  need(body?.model==='qwen3.8-flash'&&body.stream===true&&Array.isArray(body.tools),'CQ_WIRE_BINDING_INVALID');
  need(body.previous_response_id===undefined,'CQ_REMOTE_CONTINUATION_FORBIDDEN');
  function filter(tools) {
    return tools.flatMap(t=>{
      if(t.type==='function'&&allowedNames.includes(t.name))return [t];
      if(t.type==='namespace'&&t.name==='mcp__lightog_cq'&&Array.isArray(t.tools)){const nested=t.tools.filter(n=>n.type==='function'&&allowedNames.includes(t.name+'__'+n.name));return nested.length?[{...t,tools:nested}]:[];}
      return [];
    });
  }
  const tools=filter(body.tools);
  const names=tools.flatMap(t=>t.type==='namespace'?t.tools.map(n=>t.name+'__'+n.name):[t.name]);
  need(names.length>0,'CQ_MCP_TOOLS_MISSING');
  return {...clone(body),tools,store:false};
}
export function validateCQSSE(bytes,allowedNames=CQ_WIRE_NAMES) {
  const text=Buffer.from(bytes).toString('utf8');need(text.endsWith('\n\n')||text.endsWith('\r\n\r\n'),'CQ_STREAM_TRUNCATED');
  let completed=null,violation=null,failed=false;const calls=[];
  function item(value) {
    if(!value||typeof value!=='object')return;
    if(value.type==='function_call'){const name=value.namespace?value.namespace+'__'+value.name:value.name;need(allowedNames.includes(name),'CQ_RETURNED_TOOL_FORBIDDEN');calls.push(name);}
    else if(value.type&&!['message','reasoning','compaction'].includes(value.type))need(false,'CQ_RETURNED_ITEM_FORBIDDEN');
  }
  for(const frame of text.split(/\r?\n\r?\n/)) {
    const data=frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
    if(!data)continue;
    if(data==='[DONE]'){need(completed,'CQ_STREAM_PREMATURE_DONE');continue;}
    need(!completed,'CQ_STREAM_AFTER_TERMINAL');
    let event;try{event=JSON.parse(data);}catch{need(false,'CQ_STREAM_JSON_INVALID');}
    try {if(event.item)item(event.item);if(event.response?.output)event.response.output.forEach(item);}catch(error){violation??=error;}
    if(event.type==='response.completed'){need(!completed,'CQ_STREAM_MULTIPLE_COMPLETIONS');completed=event.response;}
    if(['response.failed','response.incomplete','error'].includes(event.type))failed=true;
  }
  if(failed)need(false,'CQ_STREAM_FAILED');
  need(completed?.status==='completed','CQ_STREAM_RESULT_UNKNOWN');
  const usage=completed.usage;
  need(!usage||Number.isSafeInteger(usage.input_tokens)&&usage.input_tokens>=0&&Number.isSafeInteger(usage.output_tokens)&&usage.output_tokens>=0,'CQ_USAGE_INVALID');
  if(violation){violation.reported_usage=usage?{input_tokens:usage.input_tokens,output_tokens:usage.output_tokens}:null;throw violation;}
  need(!completed.model||completed.model==='qwen3.8-flash','CQ_RETURNED_MODEL_MISMATCH');
  return {usage:usage?{input_tokens:usage.input_tokens,output_tokens:usage.output_tokens}:null,calls:[...new Set(calls)]};
}
export function createCQInferenceGate({store,host,taskId,limits,upstream,now=()=>Date.now(),allowedWireNames,nativePassthrough=false,isOpen=null}) {
  if(allowedWireNames)need(Array.isArray(allowedWireNames)&&allowedWireNames.length>0&&new Set(allowedWireNames).size===allowedWireNames.length&&allowedWireNames.every(n=>[...CQ_WIRE_NAMES,...CQ_LIST_TOOLS.map(t=>'mcp__lightog_cq__'+t),...Object.values(CQ_QUALITY_TOOL).map(t=>'mcp__lightog_cq__'+t)].includes(n)),'CQ_GATE_TOOLS_INVALID');
  need(!nativePassthrough||!limits.request_controls,'CQ_NATIVE_CONTROLS_MUST_BE_NATIVE');
  const db=createCQDiscoveryStore(store),binding=hash({taskId,limits,model:'qwen3.8-flash',...(allowedWireNames?{allowedWireNames}:{}),...(nativePassthrough?{native_passthrough:true}:{})}),key=taskId;
  for(const k of ['max_request_bytes','max_total_bytes','max_response_bytes','max_wall_ms'])need(Number.isSafeInteger(limits[k])&&limits[k]>0,'CQ_GATE_LIMIT_INVALID');
  if(limits.sse_boundary_version!==undefined){need(limits.sse_boundary_version===1,'CQ_GATE_LIMIT_INVALID');createCQSSEBoundary(limits);}
  if(limits.request_controls!==undefined)need(limits.request_controls.reasoning_effort==='low'&&limits.request_controls.max_output_tokens===8192&&Object.keys(limits.request_controls).length===2,'CQ_GATE_CONTROLS_INVALID');
  db.transaction(()=>{
    const old=db.get('transport',key);
    if(old){need(old.binding===binding,'CQ_GATE_LIMIT_CHANGED');return;}
    db.append('transport',key,{task_id:taskId,binding,limits:clone(limits),started_at:now(),bytes_reserved:0,status:'OPEN',attempts:[]});
  });
  const state=()=>db.get('transport',key);
  async function send(body,signal) {
    need(!signal?.aborted,'CQ_REQUEST_CANCELLED_BEFORE_SEND');
    const nativeBytes=nativePassthrough?Buffer.from(body):null;
    if(nativePassthrough){body=JSON.parse(nativeBytes.toString('utf8'));need(body?.model==='qwen3.8-flash'&&body.stream===true&&Array.isArray(body.tools),'CQ_NATIVE_WIRE_INVALID');}
    db.event(taskId,'NATIVE_WIRE_TOOLS',{tools:body.tools});
    if(limits.request_controls||nativePassthrough)db.event(taskId,'NATIVE_REQUEST_CONTROLS',{reasoning:body.reasoning??null,max_output_tokens:body.max_output_tokens??null});
    const quality=db.get('quality',taskId),effectiveNames=quality?allowedWireNames?.filter(n=>n==='mcp__lightog_cq__'+CQ_QUALITY_TOOL[quality.active_role]):allowedWireNames;
    const filtered=nativePassthrough?body:restrictCQWire(body,effectiveNames);
    // Explicit, approval-bound vendor parameters; no dependence on summary suppression.
    if(limits.request_controls){filtered.reasoning={effort:limits.request_controls.reasoning_effort};filtered.max_output_tokens=limits.request_controls.max_output_tokens;}
    const wire=nativeBytes??Buffer.from(JSON.stringify(filtered)),wireHash=bytesSHA(wire),request_id=id('wire');
    const admitted=db.transaction(()=>{
      const s=state();need(s.status==='OPEN','CQ_GATE_'+s.status);
      if(isOpen)need(isOpen(),'CQ_WORKFLOW_NOT_OPEN');
      const list=db.get('list_output',taskId);if(list)need(list.status==='OPEN','CQ_LIST_'+list.status);
      const q=db.get('quality',taskId);if(q)need(['EVALUATOR','GENERATOR'].includes(q.phase),'CQ_QUALITY_NOT_OPEN');
      const loop=db.get('agent_loop',taskId);
      if(loop){need(loop.status!=='STOPPED','CQ_LOOP_STOPPED');if(['COMPLETED','HANDOFF_PENDING'].includes(loop.status)){
        if(loop.status==='COMPLETED'){const t=host.task(taskId);need(t.requests.length<t.budget.max_requests&&now()-s.started_at<limits.max_wall_ms,'CQ_LOOP_BUSINESS_COMPLETE');}
        need(loop.closing_requests<1,'CQ_LOOP_AWAIT_TURN_END');loop.closing_requests++;db.put('agent_loop',taskId,loop);
      }}
      const deny=reason=>{s.status='LIMIT_REACHED';s.reason=reason;db.put('transport',key,s);host.pause(taskId,reason);db.event(taskId,'INFERENCE_SEND_DENIED',{reason});return {allowed:false,reason};};
      if(now()-s.started_at>=limits.max_wall_ms)return deny('CQ_GATE_DEADLINE');
      if(wire.length>limits.max_request_bytes||s.bytes_reserved+wire.length>limits.max_total_bytes)return deny('CQ_GATE_BYTES_EXCEEDED');
      const reservation=host.reserve(taskId,{request_id,input_tokens:0,output_tokens:0,metering:'BYTE_LIMITED'});if(!reservation.allowed)return deny('CQ_GATE_BUDGET_EXCEEDED');
      s.bytes_reserved+=wire.length;s.attempts.push({request_id,wire_bytes:wire.length,wire_sha256:wireHash,hash_domain:'EXACT_HTTP_BODY_BYTES',outcome:'RESERVED',...(nativePassthrough?{native_wire_sha256:wireHash,upstream_wire_sha256:wireHash,request_rewritten:false}:{})});db.put('transport',key,s);
      db.event(taskId,'INFERENCE_SEND_RESERVED',{request_id,wire_bytes:wire.length,wire_sha256:wireHash,advertised_tools:filtered.tools});
      db.append('wire_input',request_id,{task_id:taskId,request_id,wire_sha256:wireHash,body:filtered});return {allowed:true};
    });
    need(admitted.allowed,admitted.reason);
    let response=null,settled=false,received=[];let receivedBytes=0;
    const boundary=limits.sse_boundary_version===1?createCQSSEBoundary(limits):null;
    const remaining=Math.max(1,limits.max_wall_ms-(now()-state().started_at)),controller=new AbortController();
    let abortListener;
    const aborted=new Promise((_done,reject)=>{abortListener=()=>reject(Object.assign(Error('CQ_REQUEST_INTERRUPTED'),{code:'CQ_REQUEST_INTERRUPTED'}));controller.signal.addEventListener('abort',abortListener,{once:true});});
    const timer=setTimeout(()=>controller.abort(),remaining);const onAbort=()=>controller.abort();signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)controller.abort();
    function settle(outcome,extra={}) {
      db.transaction(()=>{
        const s=state(),a=s.attempts.find(a=>a.request_id===request_id);a.outcome=outcome;Object.assign(a,extra);
        if(outcome!=='RETURNED')s.status=outcome==='UNKNOWN'?'UNKNOWN_HOLD':'STOPPED';db.put('transport',key,s);
        host.settle(taskId,request_id,{outcome,...(extra.usage??{usage_known:false})});
      });settled=true;
    }
    try {
      // Upstream callback owns the single fixed destination; it must not retry.
      response=await Promise.race([upstream({body:wire,signal:controller.signal,request_id}),aborted]);
      need(response&&Number.isInteger(response.status),'CQ_UPSTREAM_INVALID');
      let bytes=0;
      const bytesOut=await Promise.race([(async()=>{for await(const chunk of response.body){need(!controller.signal.aborted,'CQ_REQUEST_INTERRUPTED');bytes+=chunk.length;const room=limits.max_response_bytes-receivedBytes;if(room>0){const part=Buffer.from(chunk).subarray(0,room);received.push(part);receivedBytes+=part.length;}need(bytes<=limits.max_response_bytes,'CQ_RESPONSE_TOO_LARGE');if(response.status>=200&&response.status<300)boundary?.push(chunk);}return Buffer.concat(received);})(),aborted]);
      const raw=bytesOut.toString('utf8'),safe=response.redact?response.redact(raw):raw;
      db.append('wire_response',request_id,{task_id:taskId,request_id,http_status:response.status,complete_body:true,body:safe,redacted:safe!==raw,response_sha256:bytesSHA(bytesOut),stored_body_sha256:bytesSHA(Buffer.from(safe)),...(boundary?{sse_metrics:boundary.metrics()}:{} )});
      if(nativePassthrough&&safe!==raw){settle('FAILED',{reason:'CQ_NATIVE_RESPONSE_REDACTED',response_bytes:bytes});need(false,'CQ_NATIVE_RESPONSE_REDACTED');}
      if(response.status<200||response.status>=300){settle('FAILED',{http_status:response.status,response_bytes:bytes});need(false,'CQ_UPSTREAM_HTTP_FAILED');}
      let checked;
      const allowedNames=filtered.tools.flatMap(t=>t.type==='namespace'?t.tools.map(n=>t.name+'__'+n.name):[t.name]);
      try{checked=validateCQSSE(bytesOut,allowedNames);boundary?.finish();}catch(error){
        // A complete forbidden response is known, a truncated/missing terminal is unknown.
        settle(['CQ_RETURNED_TOOL_FORBIDDEN','CQ_RETURNED_ITEM_FORBIDDEN','CQ_RETURNED_MODEL_MISMATCH','CQ_STREAM_FAILED'].includes(error.code)?'FAILED':'UNKNOWN',{reason:error.code,response_bytes:bytes,usage:error.reported_usage??null});throw error;
      }
      settle('RETURNED',{usage:checked.usage,response_bytes:bytes,response_sha256:bytesSHA(bytesOut),calls:checked.calls,...(boundary?{sse_metrics:boundary.metrics()}:{} )});
      return {status:response.status,body:Buffer.from(safe),content_type:'text/event-stream'};
    }catch(error){
      controller.abort();
      if(!db.get('wire_response',request_id)){const raw=Buffer.concat(received).toString('utf8'),safe=response?.redact?response.redact(raw):raw;db.append('wire_response',request_id,{task_id:taskId,request_id,complete_body:false,body:safe,redacted:safe!==raw,received_prefix_bytes:receivedBytes,reason:error.code??'CQ_SENT_RESULT_UNKNOWN',...(boundary?{sse_metrics:boundary.metrics()}:{} )});}
      if(!settled)settle('UNKNOWN',{reason:error.code??'CQ_SENT_RESULT_UNKNOWN'});throw error;
    }
    finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);controller.signal.removeEventListener('abort',abortListener);}
  }
  function recover(){const s=state();if(s.attempts.some(a=>a.outcome==='RESERVED')){host.recover(taskId);s.status='UNKNOWN_HOLD';for(const a of s.attempts)if(a.outcome==='RESERVED')a.outcome='UNKNOWN';db.put('transport',key,s);}return state();}
  recover();return {send,state,recover};
}
