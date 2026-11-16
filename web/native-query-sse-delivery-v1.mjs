/** One serialized writer; slow consumers pull persisted pages instead of queuing payloads. */
export function openNativeQueryEvents({req,res,product,libraryId,queryId,after,heartbeatMs=15000}){
 let closed=false,cursor=after,version=0,wake=null,heartbeat=false,watch,timer;const pending=new Set();
 const stop=()=>{if(closed)return;closed=true;clearInterval(timer);watch?.close();wake?.();for(const finish of [...pending])finish();};
 const notify=()=>{version++;wake?.();};
 res.once('close',stop);res.once('error',stop);
 function drain(){return new Promise(done=>{
  const finish=()=>{pending.delete(finish);res.off('drain',finish);res.off('close',finish);res.off('error',finish);done();};pending.add(finish);
  res.once('drain',finish);res.once('close',finish);res.once('error',finish);if(closed||res.destroyed)finish();
 });}
 async function write(frame){const bytes=Buffer.from(frame),size=Math.max(1,Math.min(res.writableHighWaterMark??16384,65536));
  for(let at=0;at<bytes.length;at+=size){if(closed||res.destroyed)return false;if(!res.write(bytes.subarray(at,at+size)))await drain();}
  return !closed;
 }
 async function end(){if(!closed&&!res.destroyed){await new Promise(done=>{const finish=()=>{res.off('close',finish);res.off('error',finish);done();};res.once('close',finish);res.once('error',finish);res.end(finish);});}stop();}
 const pump=(async()=>{
  try{watch=product.watchEvents({libraryId,queryId,onChange:notify});
   timer=setInterval(()=>{heartbeat=true;notify();},heartbeatMs);timer.unref?.();
   while(!closed){const observed=version,page=product.readEventPage({libraryId,queryId,after:cursor,limit:32});
    for(const event of page.events){if(event.seq!==cursor+1)throw Error('QUERY_EVENT_SEQUENCE_GAP');
     if(!await write('id: '+event.seq+'\nevent: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n'))return;cursor=event.seq;
     if(['turn.completed','turn.stopped','turn.failed'].includes(event.type)){await end();return;}
    }
    if(page.events.length)continue;
    if(page.terminal&&cursor===page.last_event_seq){await end();return;}
    if(heartbeat){heartbeat=false;if(!await write(': heartbeat\n\n'))return;}
    if(version!==observed)continue;
    await new Promise(done=>{wake=done;if(closed||version!==observed)done();});wake=null;
   }
  }catch{if(!closed&&!res.destroyed)res.destroy();}finally{stop();}
 })();
 return {close:stop,done:pump};
}
