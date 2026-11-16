/** Dedicated child MCP process. stdout is JSONL only; no direct DB/model access. */
import {createInterface} from 'node:readline';
import {createCQMcpSession} from './cq-mcp-session-v1.mjs';
const url=new URL(process.env.LIGHTOG_CQ_BROKER_URL??'http://invalid');
if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!process.env.LIGHTOG_CQ_BROKER_TOKEN)throw Error('CQ_BROKER_CONFIGURATION_INVALID');
const listOnly=process.env.LIGHTOG_CQ_LIST_ONLY==='1';
async function onFailure(reason){if(!listOnly)return;const failureURL=new URL(url);failureURL.pathname='/broker/failure';await fetch(failureURL,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.LIGHTOG_CQ_BROKER_TOKEN},body:JSON.stringify({reason}),signal:AbortSignal.timeout(2000)}).catch(()=>{});}
const session=createCQMcpSession({autonomous:process.env.LIGHTOG_CQ_AUTONOMOUS==='1',listOnly,onFailure,reviewRole:process.env.LIGHTOG_CQ_REVIEW_ROLE||null,call:async(name,args)=>{
  const response=await fetch(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.LIGHTOG_CQ_BROKER_TOKEN},body:JSON.stringify({name,args}),signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('CQ_BROKER_REFUSED');return response.json();
}});
let chain=Promise.resolve();const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
process.stdout.on('error',()=>process.exit(0));
lines.on('line',line=>{chain=chain.then(async()=>{
  let message;
  try {if(Buffer.byteLength(line)>1048576)throw Error();message=JSON.parse(line);const result=await session.handle(message);if(result)process.stdout.write(JSON.stringify(result)+'\n');}
  catch{await onFailure('CQ_MCP_JSON_INVALID');process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message?.id??null,error:{code:-32700,message:'Invalid or oversized JSONL'}})+'\n');}
});});
