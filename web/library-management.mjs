/** Library lifecycle is independent of immutable task inputs and source identities. */
import {rmSync,readFileSync} from 'node:fs';
import {resolve,relative,sep} from 'node:path';
import {knowledgeBases} from './knowledge-bases.mjs';
import {sha} from './engine.mjs';
const failure=(code,message,status=409)=>Object.assign(Error(message),{code,status});
export const libraryLifecycle=(store,id)=>store.getRecord('library_lifecycle',id);
export const libraryActive=(store,id)=>!['TRASHED','PURGING','PURGED'].includes(libraryLifecycle(store,id)?.status);
export function assertLibraryActive(store,id){if(!libraryActive(store,id))throw failure('LIBRARY_UNAVAILABLE','知识库已移入回收站或删除，请先恢复。',410);}
const references=(value,ids)=>typeof value==='string'?ids.has(value):Array.isArray(value)?value.some(v=>references(v,ids)):value&&typeof value==='object'?Object.entries(value).some(([k,v])=>ids.has(k)||references(v,ids)):false;
export function createLibraryManagement({store,storage,jobs,governance,busy,stopBatch,graphFor=()=>null}){
  const find=id=>knowledgeBases(store.listTasks()).find(b=>b.id===id);
  function requireBase(id){const base=find(id);if(!base)throw failure('LIBRARY_NOT_FOUND','知识库不存在',404);return base;}
  function save(id,value){store.putRecord('library_lifecycle',id,value);return value;}
  function rename(id,name){assertLibraryActive(store,id);const base=requireBase(id);if(typeof name!=='string'||!name.trim()||[...name.trim()].length>100)throw failure('INVALID_LIBRARY_NAME','名称须为 1–100 个字符',400);return save(id,{...libraryLifecycle(store,id),id,status:'ACTIVE',name:name.trim(),updated_at:new Date().toISOString()});}
  function trash(id){const base=requireBase(id),old=libraryLifecycle(store,id);if(old?.status==='TRASHED')return old;assertLibraryActive(store,id);const at=new Date().toISOString();
    return store.transaction(()=>{
      const next=save(id,{...old,id,name:old?.name||base.name,status:'TRASHED',trashed_at:at,updated_at:at});
      const state=governance.baseFor(id);if(state)store.putRecord('library_state',id,{...state,source_epoch:state.source_epoch+1});
      for(const taskId of base.task_ids){const job=jobs.get(taskId)||store.getTask(taskId);if(!job)continue;if(job.status!=='READY'){job.cancel_requested=true;job.lifecycle_stopped=true;if(['QUEUED','INTERRUPTED','FAILED','PAUSED'].includes(job.status)){job.status='CANCELLED';job.stage='CANCELLED';}store.saveTask(job);}}
      for(const batch of store.listRecords('learning_batch').filter(b=>b.base_id===id))stopBatch(batch.id);
      for(const kind of ['learning_observation','component_submission'])for(const record of store.listRecords(kind).filter(r=>r.base_id===id||base.task_ids.includes(r.task_id)||base.task_ids.includes(r.origin_task_id))){if(!['COMPLETED','PUBLISHED','EXCLUDED','RESOLVED'].includes(record.status))store.putRecord(kind,record.id,{...record,status:'STOPPED',stopped_reason:'LIBRARY_TRASHED'});}
      for(const access of store.listRecords('integration_access').filter(a=>a.library_id===id&&!a.revoked_at))store.putRecord('integration_access',access.id,{...access,revoked_at:at,revocation_reason:'LIBRARY_TRASHED'});
      return next;
    });
  }
  function restore(id){const base=requireBase(id),old=libraryLifecycle(store,id);if(old?.status!=='TRASHED')throw failure('LIBRARY_NOT_TRASHED','只能恢复回收站中的知识库');return store.transaction(()=>{const state=governance.baseFor(id);if(state)store.putRecord('library_state',id,{...state,source_epoch:state.source_epoch+1});return save(id,{...old,status:'ACTIVE',restored_at:new Date().toISOString(),updated_at:new Date().toISOString()});});}
  async function purge(id,{confirm_name}={}){
    let old=libraryLifecycle(store,id);if(old?.status==='PURGED')return {deleted:true};
    if(!old||!['TRASHED','PURGING'].includes(old.status))throw failure('LIBRARY_NOT_TRASHED','请先移入回收站，再彻底删除');
    const base=find(id),name=old.name||base?.name;if(confirm_name!==name)throw failure('DELETE_CONFIRMATION_REQUIRED','请输入完整知识库名称确认彻底删除',400);
    if(busy())throw failure('LIBRARY_DELETE_BUSY','当前仍有处理未结束，请稍后再彻底删除；回收站中的内容不会继续学习。');
    const ids=old.task_ids||base?.task_ids||[],set=new Set(ids),owned=store.listTasks().filter(t=>set.has(t.id));
    if(owned.some(j=>j.graph_sync?.status==='SYNCED')&&!graphFor())throw failure('GRAPH_CONNECTION_REQUIRED','此知识库有 Neo4j 副本，请先连接原数据库再彻底删除。');
    const synced=owned.filter(j=>j.graph_sync?.status==='SYNCED'),connection=graphFor()?.info;
    if(synced.some(j=>!j.graph_sync.target||j.graph_sync.target.uri!==connection?.uri||j.graph_sync.target.database!==connection?.database||j.graph_sync.target.workspace!==connection?.workspace))throw failure('GRAPH_TARGET_UNVERIFIED','尚未确认 Neo4j 副本所在数据库。请恢复知识库并连接原数据库重新同步，再移入回收站删除。');
    old=save(id,{...old,status:'PURGING',task_ids:ids});
    if(owned.some(j=>j.graph_sync?.status==='SYNCED'))await graphFor().removeVersions(ids);
    // Keep a resumable cleanup manifest until every registered live file has been removed.
    let paths=old.cleanup_paths,recordKeys=old.record_keys,docIds=old.document_ids;
    if(!paths){
      const entries=store.db.prepare('SELECT kind,id,payload FROM workbench_records').all().map(r=>({...r,value:JSON.parse(r.payload)})),identities=new Set([id,...ids]);
      const ownedIds=v=>{if(!v||typeof v!=='object')return;for(const [key,value] of Object.entries(v)){if(['budget_id','preview_id','operation_id','request_id'].includes(key)&&typeof value==='string')identities.add(value);else if(value&&typeof value==='object')ownedIds(value);}};
      owned.forEach(ownedIds);
      const retainedTaskIds=new Set(store.listTasks().filter(t=>!set.has(t.id)).map(t=>t.id));
      const foreignOwner=r=>(r.value.base_id&&r.value.base_id!==id)||(r.value.library_id&&r.value.library_id!==id)||retainedTaskIds.has(r.value.task_id);
      const selected=[];let added=true;
      while(added){added=false;for(const r of entries){if(r.kind==='library_lifecycle'||foreignOwner(r)||selected.includes(r))continue;if(identities.has(r.id)||references(r.value,identities)){selected.push(r);identities.add(r.id);ownedIds(r.value);added=true;}}}
      const selectedKeys=new Set(selected.map(r=>r.kind+':'+r.id));
      for(const r of selected){const archive=entries.find(a=>a.kind==='immutable_archive'&&a.id===sha([r.kind,r.id]));if(archive&&!selectedKeys.has('immutable_archive:'+archive.id)){selected.push(archive);selectedKeys.add('immutable_archive:'+archive.id);}}
      const documents=new Set();const collect=v=>{if(!v||typeof v!=='object')return;if(typeof v.document_id==='string'&&/^[a-f0-9-]{36}$/.test(v.document_id))documents.add(v.document_id);Object.values(v).forEach(collect);};owned.forEach(collect);selected.forEach(r=>collect(r.value));
      const retained=[...store.listTasks().filter(t=>!set.has(t.id)),...entries.filter(r=>!selectedKeys.has(r.kind+':'+r.id)&&r.kind!=='library_lifecycle').map(r=>r.value)];
      docIds=[...documents].filter(doc=>!retained.some(v=>references(v,new Set([doc]))));
      paths=[];for(const r of store.db.prepare('SELECT path FROM artifacts').all()){
        const parts=r.path.split(/[\\/]/);let remove=set.has(parts[0])||parts[0]==='operations'&&identities.has(parts[1])||parts[0]==='documents'&&docIds.includes(parts[1])||selected.some(s=>s.kind==='immutable_archive'&&s.value.path===r.path);
        if(!remove&&['operations','archives'].includes(parts[0])){try{remove=references(JSON.parse(readFileSync(resolve(storage,r.path),'utf8')),identities);}catch{}}
        if(remove)paths.push(r.path);
      }
      recordKeys=selected.map(r=>[r.kind,r.id]);old=save(id,{...old,cleanup_paths:paths,record_keys:recordKeys,document_ids:docIds});
    }
    // Validated namespace roots only. Never follow a user-provided deletion path.
    for(const path of paths){const absolute=resolve(storage,path),rel=relative(storage,absolute);if(!rel||rel.startsWith('..'+sep)||rel==='..')throw failure('INVALID_CLEANUP_PATH','清理路径不属于当前工作空间');rmSync(absolute,{force:true});}
    for(const taskId of ids){if(!/^[a-f0-9-]{36}$/.test(taskId))throw failure('INVALID_TASK_ID','清理任务标识无效');rmSync(resolve(storage,taskId),{recursive:true,force:true});}
    for(const doc of docIds)rmSync(resolve(storage,'documents',doc),{recursive:true,force:true});
    store.transaction(()=>{
      for(const taskId of ids){for(const table of ['records','claims'])store.db.prepare(`DELETE FROM ${table} WHERE task_id=?`).run(taskId);store.db.prepare('DELETE FROM imports WHERE id=?').run(taskId);store.db.prepare('DELETE FROM tasks WHERE id=?').run(taskId);jobs.delete(taskId);}
      for(const [kind,key] of recordKeys)store.db.prepare('DELETE FROM workbench_records WHERE kind=? AND id=?').run(kind,key);
      for(const path of paths)store.db.prepare('DELETE FROM artifacts WHERE path=?').run(path);
      // IDs alone prevent late writes and legacy reimport; no source content is kept here.
      save(id,{id,status:'PURGED',task_ids:ids,purged_at:new Date().toISOString()});
    });
    return {deleted:true,removed_tasks:ids.length,removed_documents:docIds.length};
  }
  return {rename,trash,restore,purge};
}
