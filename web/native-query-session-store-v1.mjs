/** Synchronous native query record port with atomic PG commits and one gateway lease. */
import {randomUUID} from 'node:crypto';
import {MessageChannel,receiveMessageOnPort,Worker} from 'node:worker_threads';

const failure=(code,status=503)=>Object.assign(Error(code),{code,status});
const clone=structuredClone;
const keyOf=(kind,id)=>JSON.stringify([kind,id]);

export function createPgQuerySessionStore({endpoint,writeToken}){
 const url=new URL('/_ontoweave/query-sessions/v1',endpoint);
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!writeToken)throw failure('QUERY_SESSION_LOCAL_PORT_REQUIRED');
 const owner=randomUUID();
 const {port1,port2}=new MessageChannel();
 const worker=new Worker(new URL('./native-query-session-worker-v1.mjs',import.meta.url),{
  workerData:{port:port2,url:url.href,writeToken},transferList:[port2],
 });
 worker.unref();
 port1.unref();
 worker.on('error',()=>{broken=true;});
 let active=null,broken=false,closed=false;
 function rpc(action,fields={}){
  if(broken||closed)throw failure('QUERY_SESSION_UNAVAILABLE');
  const signal=new SharedArrayBuffer(4),state=new Int32Array(signal);
  port1.postMessage({body:{owner,action,...fields},signal});
  if(Atomics.wait(state,0,0,5500)==='timed-out'){
   broken=true;
   throw failure('QUERY_SESSION_TRANSPORT_UNKNOWN');
  }
  const response=receiveMessageOnPort(port1)?.message;
  if(!response){
   broken=true;
   throw failure('QUERY_SESSION_TRANSPORT_UNKNOWN');
  }
  if(response.error){
   // A mutation that may have committed cannot be transparently repeated.
   if(response.error==='QUERY_SESSION_GATEWAY_FENCED'||
      action==='commit'&&response.error==='QUERY_SESSION_TRANSPORT_UNKNOWN')broken=true;
   throw failure(response.error,response.status);
  }
  return response.data;
 }

 try{rpc('claim');}
 catch(error){port1.close();void worker.terminate();throw error;}

 const heartbeat=setInterval(()=>{
  try{rpc('heartbeat');}catch{/* subsequent state transitions still require the PG lease */}
 },10000);
 heartbeat.unref();

 function transaction(callback){
  if(active)return callback();
  const revision=rpc('revision').revision;
  active={rows:new Map(),reads:new Map(),lists:new Map()};
  try{
   const value=callback();
   if(value&&typeof value.then==='function')throw failure('QUERY_SESSION_SYNCHRONOUS_TRANSACTION_REQUIRED');
   if(active.rows.size)rpc('commit',{revision,rows:[...active.rows.values()]});
   return value;
  }finally{active=null;}
 }
 function getRecord(kind,id){
  const key=keyOf(kind,id);
  if(active?.rows.has(key))return clone(active.rows.get(key).payload);
  if(active?.reads.has(key))return clone(active.reads.get(key));
  const {record}=rpc('get',{kind,id});
  active?.reads.set(key,record);
  return clone(record);
 }
 function putRecord(kind,id,payload){
  if(!active)return transaction(()=>putRecord(kind,id,payload));
  active.rows.set(keyOf(kind,id),{kind,id,payload:clone(payload),updated_at:new Date().toISOString()});
  return payload;
 }
 function listRecords(kind,{library=null}={}){
  const key=keyOf(kind,library);
  let rows=active?.lists.get(key);
  if(!rows){
   rows=rpc('list',{kind,library}).rows;
   active?.lists.set(key,rows);
  }
  if(!active?.rows.size)return rows.map(row=>clone(row.payload));
  const merged=new Map(rows.map(row=>[row.id,row]));
  for(const record of active.rows.values()){
   if(record.kind!==kind)continue;
   if(library===null||record.payload.library_id===library)merged.set(record.id,record);
   else merged.delete(record.id);
  }
  return [...merged.values()].sort((a,b)=>b.updated_at.localeCompare(a.updated_at)||a.id.localeCompare(b.id)).map(row=>clone(row.payload));
 }

 return Object.freeze({
  getRecord,putRecord,listRecords,transaction,
  listLibraryRecords:(kind,library)=>listRecords(kind,{library}),
  listQueryEvents:(query,after,limit)=>rpc('events',{query,after,limit}).rows,
  async close(){
   if(closed)return;
   clearInterval(heartbeat);
   try{if(!broken)rpc('release');}finally{
    closed=true;
    port1.close();
    await worker.terminate();
   }
  },
 });
}
