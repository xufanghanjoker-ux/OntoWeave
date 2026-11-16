/** Library-scoped integration credentials. Only hashes persist; UI receives a secret once. */
import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
const digest=value=>createHash('sha256').update(value).digest('hex');
export const accessError=(code,message,status=403)=>Object.assign(Error(message),{code,status});
export function createIntegrationAccess(store,{libraryExists}){
  const publicRow=({id,name,library_id,mode,created_at,revoked_at})=>({id,name,library_id,mode,created_at,revoked_at:revoked_at||null});
  function issue({name,library_id,mode='QUERY'}={}){
    if(typeof name!=='string'||!name.trim()||name.length>80||!['QUERY','LEARN'].includes(mode)||!libraryExists(library_id))throw accessError('INVALID_ACCESS_SCOPE','请选择已有可查询知识库、接入名称和查询/学习模式',400);
    const secret='cqf_'+randomBytes(32).toString('base64url'),record={id:randomUUID(),name:name.trim(),library_id,mode,secret_hash:digest(secret),created_at:new Date().toISOString()};
    store.putRecord('integration_access',record.id,record);return {...publicRow(record),token:secret};
  }
  function authenticate(header){
    if(typeof header!=='string'||!/^Bearer cqf_[A-Za-z0-9_-]{43}$/.test(header))throw accessError('ACCESS_REQUIRED','需要有效的 Bearer 接入凭证',401);
    const hashed=Buffer.from(digest(header.slice(7)),'hex');
    const record=store.listRecords('integration_access').find(r=>!r.revoked_at&&typeof r.secret_hash==='string'&&/^[a-f0-9]{64}$/.test(r.secret_hash)&&timingSafeEqual(Buffer.from(r.secret_hash,'hex'),hashed));
    if(!record)throw accessError('ACCESS_REVOKED','接入凭证无效或已经撤销',401);return publicRow(record);
  }
  function authorize(id,libraryId,{learn=false}={}){
    const record=store.getRecord('integration_access',id);
    if(!record||record.revoked_at)throw accessError('ACCESS_REVOKED','接入凭证已撤销',401);
    if(record.library_id!==libraryId||learn&&record.mode!=='LEARN')throw accessError('ACCESS_SCOPE_DENIED','此凭证不允许访问该知识库或触发学习');
    return publicRow(record);
  }
  function revoke(id){const record=store.getRecord('integration_access',id);if(!record)throw accessError('ACCESS_NOT_FOUND','接入不存在',404);if(!record.revoked_at)store.putRecord('integration_access',id,{...record,revoked_at:new Date().toISOString()});return {revoked:true};}
  return {issue,authenticate,authorize,revoke,list:()=>store.listRecords('integration_access').map(publicRow)};
}
