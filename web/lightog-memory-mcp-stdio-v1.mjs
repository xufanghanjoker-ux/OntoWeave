/** Local product MCP entry point. stdout contains JSON-RPC only. */
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {createLightogMemoryMcpClient} from './lightog-memory-mcp-client-v1.mjs';
import {createLightogMemoryMcpSession} from './lightog-memory-mcp-session-v1.mjs';

export function runLightogMemoryMcpStdio({session,input=process.stdin,output=process.stdout,maxInputBytes=131072,maxPending=16,maxOutputBytes=524288}={}){
  if(typeof session?.handle!=='function'||typeof session?.close!=='function'||!Number.isSafeInteger(maxInputBytes)||maxInputBytes<128||!Number.isSafeInteger(maxPending)||maxPending<1||!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1024)throw new Error('Invalid stdio adapter configuration');
  let partial=Buffer.alloc(0),dropping=false,ended=false,outputFailed=false;
  let outputQueue=Promise.resolve();
  const pending=new Set();
  const parseError=message=>({jsonrpc:'2.0',id:null,error:{code:-32700,message}});
  const emit=response=>{
    if(!response||outputFailed)return Promise.resolve();
    let line;
    try{line=JSON.stringify(response)+'\n';}catch{line=JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32603,message:'Adapter serialization error'}})+'\n';}
    if(Buffer.byteLength(line)>maxOutputBytes)line=JSON.stringify({jsonrpc:'2.0',id:response.id??null,error:{code:-32603,message:'Adapter output budget exceeded; do not repeat an uncertain write'}})+'\n';
    outputQueue=outputQueue.then(async()=>{
      if(outputFailed)return;
      if(!output.write(line))await once(output,'drain');
    }).catch(()=>{outputFailed=true;session.close();});
    return outputQueue;
  };
  const outputError=()=>{outputFailed=true;session.close();};
  output.on('error',outputError);

  function line(bytes){
    if(bytes.length&&bytes[bytes.length-1]===13)bytes=bytes.subarray(0,bytes.length-1);
    if(!bytes.length)return;
    let message;
    try{message=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{void emit(parseError('Invalid UTF-8 JSON'));return;}
    const notification=message&&typeof message==='object'&&!Array.isArray(message)&&!Object.hasOwn(message,'id');
    if(!notification&&pending.size>=maxPending){void emit({jsonrpc:'2.0',id:typeof message?.id==='string'||typeof message?.id==='number'?message.id:null,error:{code:-32000,message:'Adapter is busy; this request was not sent'}});return;}
    let task;
    task=Promise.resolve().then(()=>session.handle(message)).then(emit).catch(()=>emit({jsonrpc:'2.0',id:typeof message?.id==='string'||typeof message?.id==='number'?message.id:null,error:{code:-32603,message:'Local adapter error'}})).finally(()=>pending.delete(task));
    pending.add(task);
  }

  function data(chunk){
    if(ended)return;
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    let start=0;
    for(let i=0;i<=bytes.length;i++){
      if(i<bytes.length&&bytes[i]!==10)continue;
      const segment=bytes.subarray(start,i);
      if(!dropping&&partial.length+segment.length>maxInputBytes){dropping=true;partial=Buffer.alloc(0);}
      if(!dropping&&segment.length)partial=partial.length?Buffer.concat([partial,segment]):Buffer.from(segment);
      if(i<bytes.length){
        if(dropping)void emit(parseError('Input line exceeds adapter budget'));
        else line(partial);
        partial=Buffer.alloc(0);dropping=false;
      }
      start=i+1;
    }
  }

  let finish;
  const done=new Promise(resolve=>{finish=resolve;});
  async function end(){
    if(ended)return;ended=true;
    if(dropping)await emit(parseError('Input line exceeds adapter budget'));
    else if(partial.length)line(partial);
    partial=Buffer.alloc(0);
    await Promise.allSettled([...pending]);
    await outputQueue;
    session.close();
    input.removeListener('data',data);
    input.removeListener('end',end);
    input.removeListener('error',stop);
    output.removeListener('error',outputError);
    finish();
  }
  function stop(){session.close();void end();}
  input.on('data',data);
  input.once('end',end);
  input.once('error',stop);
  return {done,close:stop};
}

export async function startLightogMemoryMcpFromEnvironment(env=process.env){
  const client=createLightogMemoryMcpClient({url:env.LIGHTOG_MEMORY_PRODUCT_URL,token:env.LIGHTOG_MEMORY_PRODUCT_TOKEN,binding:{workspace_id:env.LIGHTOG_MEMORY_WORKSPACE_ID,library_id:env.LIGHTOG_MEMORY_LIBRARY_ID}});
  const session=createLightogMemoryMcpSession({service:client});
  return runLightogMemoryMcpStdio({session});
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length>2)throw new Error('Unsupported command argument');
    const run=await startLightogMemoryMcpFromEnvironment();
    const stop=()=>{run.close();process.stdin.pause();};
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    await run.done;
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  }catch{
    // Never echo configuration values, tokens, service bodies or caught exceptions.
    process.stderr.write('LightOG memory MCP configuration is invalid. See the product integration contract.\n');
    process.exitCode=2;
  }
}
