/** Shared provider admission. Request failure/cancellation is request-scoped;
 * only the explicit service stop closes admission for all tasks. No retries.
 */
import {randomUUID,createHash} from 'node:crypto';

export function createExternalGovernor({destinations,limit=4,fetchImpl=fetch,onEvent=()=>{}}){
  if(limit!==4||!Array.isArray(destinations)||!destinations.length)throw Error('EXTERNAL_GOVERNOR_INVALID');
  const allowed=new Map(destinations.map(d=>[d.url,d])),queue=[],controllers=new Set();
  let active=0,peak=0,started=0,stopped=false,stopReason=null;
  const failure=code=>Object.assign(Error(code),{code,billing_status:'NOT_SENT'});
  function pump(){
    while(!stopped&&active<limit&&queue.length){
      const entry=queue.shift();entry.cleanup();
      if(entry.signal?.aborted){entry.reject(failure('EXTERNAL_CANCELLED_BEFORE_SEND'));continue;}
      active++;peak=Math.max(peak,active);entry.resolve();
    }
  }
  function acquire(signal){return new Promise((resolve,reject)=>{
    if(stopped){reject(failure(stopReason));return;}
    if(signal?.aborted){reject(failure('EXTERNAL_CANCELLED_BEFORE_SEND'));return;}
    const entry={signal,resolve,reject,cleanup:()=>signal?.removeEventListener('abort',cancel)};
    function cancel(){const index=queue.indexOf(entry);if(index<0)return;queue.splice(index,1);entry.cleanup();reject(failure('EXTERNAL_CANCELLED_BEFORE_SEND'));}
    signal?.addEventListener('abort',cancel,{once:true});queue.push(entry);pump();
  });}
  function stop(reason='EXTERNAL_GOVERNOR_STOPPED'){
    if(stopped)return;
    stopped=true;stopReason=reason;
    for(const entry of queue.splice(0)){entry.cleanup();entry.reject(failure(reason));}
    for(const controller of controllers)controller.abort();
  }
  async function controlledFetch(url,options={}){
    if(stopped)throw failure(stopReason);
    const target=allowed.get(String(url));if(!target)throw failure('EXTERNAL_DESTINATION_NOT_ADMITTED');
    const body=JSON.parse(options.body);
    if(body.model!==target.model)throw failure('EXTERNAL_MODEL_MISMATCH');
    if(target.role==='generation'&&(body.reasoning?.effort!=='low'||body.stream!==true))throw failure('EXTERNAL_LOW_REQUIRED');
    await acquire(options.signal);
    if(stopped||options.signal?.aborted){active--;pump();throw failure(stopped?stopReason:'EXTERNAL_CANCELLED_BEFORE_SEND');}
    const id=randomUUID(),controller=new AbortController();controllers.add(controller);
    let released=false,ended=false;
    const release=(outcome,extra={})=>{
      if(released)return;
      released=true;controllers.delete(controller);active--;
      onEvent({id,role:target.role,model:target.model,phase:'END',outcome,active,peak,...extra});pump();
    };
    started++;
    onEvent({id,role:target.role,model:target.model,phase:'START',active,peak,bytes:Buffer.byteLength(options.body),body_sha256:createHash('sha256').update(options.body).digest('hex'),...(target.role==='generation'?{reasoning_effort:body.reasoning.effort}:{})});
    try{
      const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
      const response=await fetchImpl(url,{...options,signal});
      if(!response.body){release('RETURNED',{http_status:response.status});return response;}
      const reader=response.body.getReader();
      const stream=new ReadableStream({
        async pull(output){
          try{
            const {done,value}=await reader.read();if(ended)return;
            if(done){ended=true;release('RETURNED',{http_status:response.status});output.close();}
            else output.enqueue(value);
          }catch(error){if(ended)return;ended=true;release('UNKNOWN',{code:typeof error.code==='string'?error.code:'STREAM_FAILURE'});output.error(error);}
        },
        async cancel(reason){
          if(ended)return;
          ended=true;controller.abort();release('UNKNOWN',{code:'STREAM_CANCELLED'});
          await reader.cancel(reason);
        }
      });
      return new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers});
    }catch(error){controller.abort();release('UNKNOWN',{code:typeof error.code==='string'?error.code:'TRANSPORT_FAILURE'});throw error;}
  }
  return {fetch:controlledFetch,stop,state:()=>({limit,active,peak,started,queued:queue.length,stopped,stop_reason:stopReason})};
}
