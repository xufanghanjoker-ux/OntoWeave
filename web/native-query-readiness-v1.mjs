/** Query-only MCP inventory barrier. Notifications wake checks; time never proves readiness. */
import {need} from './cq-discovery-store-v2.mjs';

export async function waitForNativeQueryTools({probe,subscribe,requiredToolNames,threadId,serverName='lightog_native',timeoutMs,signal,onStatus=()=>{}}) {
  need(Array.isArray(requiredToolNames)&&requiredToolNames.length>0&&requiredToolNames.every(n=>typeof n==='string'&&n),'NATIVE_QUERY_READINESS_POLICY_INVALID');
  const deadline=Date.now()+timeoutMs;let version=0,wake=null,startup=null;
  const unsubscribe=subscribe(event=>{
    const p=event.params;
    if(event.method==='mcpServer/startupStatus/updated'&&p?.name===serverName&&p.threadId===threadId){startup=p.status;version++;wake?.();}
  });
  const abort=()=>wake?.();signal?.addEventListener('abort',abort);
  const check=()=>{need(!signal?.aborted,'NATIVE_QUERY_MCP_READINESS_CANCELLED');need(Date.now()<deadline,'NATIVE_QUERY_MCP_READINESS_TIMEOUT');};
  async function bounded(promise){
    check();let timer,listener;
    try{return await Promise.race([promise,new Promise((_,reject)=>{
      const fail=code=>reject(Object.assign(Error(code),{code}));
      timer=setTimeout(()=>fail('NATIVE_QUERY_MCP_READINESS_TIMEOUT'),Math.max(1,deadline-Date.now()));
      listener=()=>fail('NATIVE_QUERY_MCP_READINESS_CANCELLED');signal?.addEventListener('abort',listener,{once:true});if(signal?.aborted)listener();
    })]);}finally{clearTimeout(timer);signal?.removeEventListener('abort',listener);}
  }
  try{for(;;){
    check();const observed=version,servers=[];let cursor=null;const cursors=new Set();
    do{
      const page=await bounded(probe({threadId,serverName,detail:'toolsAndAuthOnly',limit:100,...(cursor?{cursor}:{})}));
      need(Array.isArray(page?.data),'NATIVE_QUERY_MCP_INVENTORY_INVALID');servers.push(...page.data);
      cursor=page.nextCursor??null;need(!cursor||!cursors.has(cursor),'NATIVE_QUERY_MCP_INVENTORY_CURSOR_INVALID');if(cursor)cursors.add(cursor);
    }while(cursor);
    const server=servers.find(s=>s.name===serverName),names=Object.keys(server?.tools??{}),missing=requiredToolNames.filter(n=>!names.includes(n));
    const status={thread_id:threadId,server_name:serverName,runtime_status:server?.runtimeStatus??null,required_tool_names:[...requiredToolNames],discovered_tool_names:names,missing_tool_names:missing};
    onStatus(status);
    if(server?.runtimeStatus==='connected'&&!server.toolsError&&!missing.length)return {...status,status:'READY'};
    need(!server?.toolsError&&!['failed','cancelled','disabled','authenticationRequired'].includes(server?.runtimeStatus)&&!['failed','cancelled'].includes(startup),'NATIVE_QUERY_MCP_READINESS_FAILED');
    // Connected/ready catalogs are definitive; an incomplete catalog will not change.
    need(!(server?.runtimeStatus==='connected'||startup==='ready'),'NATIVE_QUERY_MCP_TOOLS_MISSING');
    if(version!==observed)continue;
    await bounded(new Promise(done=>{wake=done;if(version!==observed||signal?.aborted)done();}));wake=null;
  }}finally{wake=null;unsubscribe();signal?.removeEventListener('abort',abort);}
}
