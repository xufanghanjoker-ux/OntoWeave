/** Scripted Responses wire fixture. Does not contain or contact a model. */
export function sseResponse({name,args,text='CQ草案已保存。',index=0,model='qwen3.8-flash'}) {
  const qualified=name?.startsWith('mcp__lightog_cq__')?{namespace:'mcp__lightog_cq',name:name.slice('mcp__lightog_cq__'.length)}:{name};
  const output=name?[{id:'fc_'+index,type:'function_call',status:'completed',call_id:'call_'+index,...qualified,arguments:JSON.stringify(args)}]:[{id:'msg_'+index,type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text,annotations:[]}]}];
  const response={id:'resp_'+index,object:'response',created_at:1,status:'completed',model,output,usage:{input_tokens:100+index,output_tokens:20,total_tokens:120+index}};
  const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}}];
  output.forEach((item,i)=>{
    events.push({type:'response.output_item.added',output_index:i,item:{...item,status:'in_progress',...(name?{arguments:''}:{content:[]})}});
    if(name){events.push({type:'response.function_call_arguments.delta',item_id:item.id,output_index:i,delta:item.arguments});events.push({type:'response.function_call_arguments.done',item_id:item.id,output_index:i,arguments:item.arguments});}
    else{events.push({type:'response.content_part.added',item_id:item.id,output_index:i,content_index:0,part:{type:'output_text',text:'',annotations:[]}});events.push({type:'response.output_text.delta',item_id:item.id,output_index:i,content_index:0,delta:text});events.push({type:'response.output_text.done',item_id:item.id,output_index:i,content_index:0,text});}
    events.push({type:'response.output_item.done',output_index:i,item});
  });
  events.push({type:'response.completed',response});
  return Buffer.from(events.map((e,i)=>'event: '+e.type+'\ndata: '+JSON.stringify({...e,sequence_number:i})+'\n\n').join(''));
}
export const mockHttpResponse=bytes=>({status:200,body:(async function*(){yield bytes;})()});
