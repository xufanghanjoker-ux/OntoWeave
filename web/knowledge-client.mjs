/** Loopback HTTP bridge; never opens SQLite or receives the model provider key. */
export function createKnowledgeClient({url='http://127.0.0.1:4317',token,fetchImpl=fetch,timeoutMs=300000}={}){
  const endpoint=new URL(url);
  if(endpoint.protocol!=='http:'||!['127.0.0.1','localhost'].includes(endpoint.hostname)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/')throw Error('CQFORGE_URL 必须是本机回环 HTTP 服务根地址');
  if(typeof token!=='string'||!/^cqf_[A-Za-z0-9_-]{43}$/.test(token))throw Error('需要 CQFORGE_ACCESS_TOKEN 接入凭证，不能使用模型密钥');
  async function request(path,body,{signal}={}){
    let response;try{response=await fetchImpl(endpoint.origin+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs)});}catch{throw Object.assign(Error(signal?.aborted?'等待已取消；已提交的学习需使用停止学习工具停止':'无法连接本地 CQForge，或请求尚未返回；不要自动更换请求标识重试'),{code:signal?.aborted?'WAIT_CANCELLED':'LOCAL_SERVICE_UNAVAILABLE'});}
    let data;try{data=await response.json();}catch{throw Object.assign(Error('本地服务未返回有效 JSON'),{code:'INVALID_SERVICE_RESPONSE'});}
    if(!response.ok)throw Object.assign(Error(data.error||'接入请求失败'),{code:data.code||'REQUEST_FAILED'});return data;
  }
  return {request};
}
