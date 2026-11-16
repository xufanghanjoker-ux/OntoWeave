/** Query-only finite retrieval batches, bound to validated provider responses. */
import {clone,hash} from './cq-discovery-store-v2.mjs';
const identity='lightog_find_entities';
const content=new Set(['lightog_retrieve','lightog_search_facts','lightog_search_sources','lightog_read_evidence','lightog_get_entity_facts','lightog_expand_graph','lightog_find_paths']);
const nameOf=name=>name.split('__').at(-1);
const fingerprint=(name,args)=>hash({name:nameOf(name),args});
export function createQueryRounds({onChange=()=>{}}={}){
 const state={version:'query-retrieval-rounds/3',identity_preparation_used:false,content_batches:0,phase:'INITIAL',batches:[],blocked_actions:0,final_request_sent:false};let active=null;
 const publish=()=>onChange(clone(state));
 function register({request_ref,calls}){
  const actions=calls.map(c=>({name:nameOf(c.name),args:typeof c.arguments==='string'?JSON.parse(c.arguments):c.arguments}));
  const retrieval=actions.filter(a=>content.has(a.name)||a.name===identity);
  let allowed=true,phase=state.phase;
  if(actions.length===0){state.phase='ANSWER';phase='ANSWER';}
  if(retrieval.length){
   if(state.phase==='ANSWER')allowed=false;
   else if(retrieval.every(a=>a.name===identity)&&state.content_batches===0&&!state.identity_preparation_used){state.identity_preparation_used=true;phase='IDENTITY_PREPARATION';}
   else if(retrieval.every(a=>a.name===identity)&&state.content_batches===0){allowed=false;state.phase='ANSWER';phase='ANSWER';}
   else if(state.content_batches<2){state.content_batches++;phase=state.content_batches===1?'INITIAL':'SUPPLEMENT';if(state.content_batches===2)state.phase='ANSWER';}
   else{allowed=false;phase='ANSWER';state.phase='ANSWER';}
  }
  active={request_ref,phase,allowed,tickets:retrieval.map((a,i)=>({fingerprint:fingerprint(a.name,a.args),call_id:calls.filter(c=>content.has(nameOf(c.name))||nameOf(c.name)===identity)[i].call_id,ordinal:i+1,used:false}))};
  state.batches.push({request_ref,phase,allowed,actions:retrieval.map((a,i)=>({name:a.name,args_sha256:hash(a.args),call_id:active.tickets[i].call_id,ordinal:i+1})),bindings:[]});publish();
 }
 function claim(name,args,context){
  if(!content.has(name)&&name!==identity)return {allowed:true,phase:state.phase};
  const ticket=active?.tickets.find(t=>!t.used&&t.fingerprint===fingerprint(name,args));
  if(ticket){ticket.used=true;state.batches.at(-1).bindings.push({call_id:ticket.call_id,ordinal:ticket.ordinal,args_sha256:hash(args),mcp_session_ref:context?.mcp_session_ref,mcp_request_id:context?.mcp_request_id,binding_method:'NAME_ARGUMENTS_AND_UNCLAIMED_PLAN_ORDINAL'});publish();}
  if(!ticket||!active.allowed){state.blocked_actions++;publish();return {allowed:false,phase:'ANSWER',response:{ok:true,result:{status:'ANSWER_PHASE',retrieval_executed:false,items:[],guidance:'本轮不再获取新内容。请依据已返回证据回答所有可支持的部分，明确剩余缺口；需要消歧时向用户澄清，不再请求检索。'}}};}
  return {allowed:true,phase:active.phase,request_ref:active.request_ref};
 }
 return {register,claim,snapshot:()=>clone(state),isAnswerPhase:()=>state.phase==='ANSWER',markFinalRequest(){state.final_request_sent=true;publish();}};
}
