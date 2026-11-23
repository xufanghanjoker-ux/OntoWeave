/** Isolate authenticated PG API I/O from the synchronous query state machine. */
import {workerData} from 'node:worker_threads';

const {port, url, writeToken}=workerData;

port.on('message',async ({body, signal})=>{
 const state=new Int32Array(signal);
 let result;
 try{
  const response=await fetch(url,{
   method:'POST',redirect:'error',signal:AbortSignal.timeout(4500),
   headers:{'Content-Type':'application/json','X-Ontoweave-Write-Token':writeToken},
   body:JSON.stringify(body),
  });
  const data=await response.json();
  result=response.ok?{data}:{error:data.error?.code??'QUERY_SESSION_UNAVAILABLE',status:response.status};
 }catch{
  result={error:'QUERY_SESSION_TRANSPORT_UNKNOWN',status:503};
 }
 port.postMessage(result);
 Atomics.store(state,0,1);
 Atomics.notify(state,0);
});
