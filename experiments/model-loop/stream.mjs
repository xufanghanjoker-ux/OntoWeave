/** Decode actual Chat Completions SSE deltas, never manufacture typing from a complete answer. */
export async function readModelStream(response,{onDelta,scrub=String,secret='',maxBytes=2000000,normalize=x=>x,maxTrailingWhitespace=Infinity}={}){
 const fail=(code,message)=>Object.assign(Error(message),{code,details:{code,billing_status:'UNKNOWN'}});
 if(!response.headers.get('content-type')?.includes('text/event-stream'))throw fail('MODEL_STREAM_UNSUPPORTED','模型接口未返回流式数据，未将整段输出伪装为逐字生成。');
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',bytes=0,content='',held='',model,usage,finish=null,done=false;
 const publish=text=>{if(!text)return;content+=text;try{onDelta?.(text);}catch(error){error.stream_callback=true;throw error;}};
 let trailingWhitespace=0;
 const textDelta=text=>{const suffix=text.match(/\s*$/u)[0].length;trailingWhitespace=suffix===text.length?trailingWhitespace+suffix:suffix;
  if(trailingWhitespace>maxTrailingWhitespace)throw fail('MODEL_DEGENERATE_OUTPUT','模型持续输出空白，已提前终止，未接受未完成结果，也未自动重发。');
  held+=text;held=scrub(held);const guard=Math.max(0,secret.length-1),n=Math.max(0,held.length-guard);publish(held.slice(0,n));held=held.slice(n);};
 const frame=text=>{
  const data=text.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!data)return;
  if(data==='[DONE]'){done=true;return;}
  let value;try{value=JSON.parse(scrub(data));}catch{throw fail('MODEL_STREAM_INVALID_JSON','模型返回了无效的流式数据帧。');}
  value=normalize(value);
  if(value.error)throw fail('MODEL_STREAM_ERROR','模型流式生成失败，未接受未完成回答。');
  if(typeof value.model==='string')model=value.model;
  if(value.usage&&typeof value.usage==='object')usage=value.usage;
  const choice=value.choices?.[0];if(typeof choice?.finish_reason==='string')finish=choice.finish_reason;
  if(typeof choice?.delta?.content==='string')textDelta(choice.delta.content);
 };
 try{
  while(!done){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>maxBytes)throw fail('MODEL_RESPONSE_TOO_LARGE','模型流式回答超过大小上限。');buffer+=decoder.decode(part.value,{stream:true});buffer=buffer.replace(/\r\n/g,'\n');let i;while((i=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,i);buffer=buffer.slice(i+2);frame(block);if(done)break;}}
  if(!finish)throw fail('MODEL_STREAM_INTERRUPTED','模型输出连接中断，未收到完整结束状态，未自动重发。');
  publish(scrub(held));
  return {model,choices:[{finish_reason:finish,message:{content}}],usage,_streaming:true};
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
