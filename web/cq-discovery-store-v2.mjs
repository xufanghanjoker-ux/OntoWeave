/** CQ records are isolated from legacy scope, normalization and publication. */
import {createHash, randomUUID} from 'node:crypto';
export const clone = value => structuredClone(value);
export const canonical = value => JSON.stringify(normalize(value));
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,normalize(value[k])]));
  return value;
}
export const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
export const id = prefix => prefix+'_'+randomUUID();
export const need = (ok, code) => {if(!ok) throw Object.assign(Error(code),{code,status:409});};
export const textField = value => typeof value==='string' && value.trim().length>0 && value.isWellFormed();
export function createCQDiscoveryStore(store) {
  const kind = name => 'cq_v2_'+name;
  const get = (name,key) => store.getRecord(kind(name),key);
  const list = name => store.listRecords(kind(name));
  const put = (name,key,value) => store.putRecord(kind(name),key,clone(value));
  function append(name,key,value) {
    const old=get(name,key);
    if(old) {need(hash(old)===hash(value),'CQ_IMMUTABLE_CONFLICT');return old;}
    return put(name,key,value);
  }
  function event(taskId,type,detail={}) {
    return store.transaction(()=>{
      const event_id=id('event'),sequence=list('event').filter(e=>e.task_id===taskId).length+1;
      return append('event',event_id,{event_id,task_id:taskId,sequence,type,detail:clone(detail),at:new Date().toISOString()});
    });
  }
  return {get,list,put,append,event,transaction:fn=>store.transaction(fn)};
}
