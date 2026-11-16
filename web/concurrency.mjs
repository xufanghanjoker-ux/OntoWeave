/** Bounded fan-out. Drain already-started work before reporting a failure. */
export async function mapConcurrent(items,limit,work,{cancelled=()=>false}={}){
 if(!Number.isInteger(limit)||limit<1||limit>8)throw Error('并行度须为 1–8');
 const results=new Array(items.length);let cursor=0,failed=null;
 async function worker(){while(!failed&&!cancelled()){const index=cursor++;if(index>=items.length)return;try{results[index]=await work(items[index],index);}catch(error){failed??=error;}}}
 await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));
 if(failed)throw failed;if(cancelled())throw Object.assign(Error('用户已请求停止任务'),{code:'SYSTEM_CANCELLED'});return results;
}
