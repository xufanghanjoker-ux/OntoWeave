/** MCP stdio: stdout is JSON-RPC only. Configuration contains an integration key, never the model key. */
import {createInterface} from 'node:readline';
import {createKnowledgeClient} from './knowledge-client.mjs';
import {createMcpSession} from './mcp-session.mjs';
let session;
try{
  if(process.argv.slice(2).some(a=>a!=='--allow-learning'))throw Error('仅支持可选参数 --allow-learning');
  const client=createKnowledgeClient({url:process.env.CQFORGE_URL||'http://127.0.0.1:4317',token:process.env.CQFORGE_ACCESS_TOKEN});
  session=createMcpSession({client,allowLearning:process.argv.includes('--allow-learning')});
}catch(error){process.stderr.write(error.message+'\n');process.exit(1);}
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
process.stdout.on('error',()=>process.exit(0));
lines.on('line',line=>{
  if(!line.trim())return;
  let message;try{if(Buffer.byteLength(line)>1024*1024)throw Error('large');message=JSON.parse(line);}catch{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error or message too large'}})+'\n');return;}
  void session.handle(message).then(response=>{if(response)process.stdout.write(JSON.stringify(response)+'\n');}).catch(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id??null,error:{code:-32603,message:'Local bridge error'}})+'\n'));
});
lines.on('close',()=>session.close());
