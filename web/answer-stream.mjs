/** Local POST SSE; disconnecting a reader never resends or cancels a billed model request. */
export function openAnswerStream(res,{heartbeatMs=15000}={}){
 res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'});res.flushHeaders?.();let seq=0,closed=false;
 const send=(event,data)=>{if(closed||res.destroyed||res.writableEnded)return;res.write('id: '+(++seq)+'\nevent: '+event+'\ndata: '+JSON.stringify(data)+'\n\n');};
 const timer=setInterval(()=>{if(!closed&&!res.destroyed&&!res.writableEnded)res.write(': heartbeat\n\n');},heartbeatMs);timer.unref?.();
 const cleanup=()=>{closed=true;clearInterval(timer);};res.once('close',cleanup);res.once('finish',cleanup);
 return {send,finish(status,data){send(status>=400?'error':'result',{http_status:status,...data});if(!res.destroyed&&!res.writableEnded)res.end();cleanup();}};
}
