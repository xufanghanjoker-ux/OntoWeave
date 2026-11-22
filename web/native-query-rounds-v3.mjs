/** Bind Codex MCP executions to admitted provider tool calls. */
import {clone,hash} from './cq-discovery-store-v2.mjs';

const localName=name=>name.split('__').at(-1);
const fingerprint=(name,args)=>hash({name:localName(name),args});

export function createQueryRounds({onChange=()=>{}}={}){
 const state={version:'query-tool-admission/4',phase:'RETRIEVAL',batches:[],blocked_actions:0,final_request_sent:false};
 let active=null;
 const publish=()=>onChange(clone(state));

 function register({request_ref,calls}){
  const phase=state.phase;
  const tickets=calls.map(call=>{
   const args=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments;
   return {name:localName(call.name),args_sha256:hash(args),fingerprint:fingerprint(call.name,args),call_id:call.call_id,used:false};
  });
  active={request_ref,phase,tickets};
  state.batches.push({request_ref,phase,actions:tickets.map(({name,args_sha256,call_id},index)=>({name,args_sha256,call_id,ordinal:index+1})),bindings:[]});
  publish();
 }

 function claim(name,args,context){
  const index=active?.tickets.findIndex(ticket=>!ticket.used&&ticket.fingerprint===fingerprint(name,args))??-1;
  if(index<0||active.phase==='ANSWER'){
   state.blocked_actions++;
   publish();
   return {allowed:false,response:{ok:true,result:{status:'UNBOUND_TOOL_CALL',retrieval_executed:false,items:[],guidance:'只使用本次已声明的工具调用及参数。'}}};
  }
  const ticket=active.tickets[index];
  ticket.used=true;
  state.batches.at(-1).bindings.push({call_id:ticket.call_id,ordinal:index+1,args_sha256:ticket.args_sha256,mcp_session_ref:context?.mcp_session_ref,mcp_request_id:context?.mcp_request_id,binding_method:'NAME_ARGUMENTS_AND_UNCLAIMED_PLAN_ORDINAL'});
  publish();
  return {allowed:true,phase:active.phase,request_ref:active.request_ref};
 }

 return {
  register,claim,snapshot:()=>clone(state),
  stopForNoProgress(){state.phase='ANSWER';publish();},
  isAnswerPhase:()=>state.phase==='ANSWER',
  markFinalRequest(){state.final_request_sent=true;publish();},
 };
}
