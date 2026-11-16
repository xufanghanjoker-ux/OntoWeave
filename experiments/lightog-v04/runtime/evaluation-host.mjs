/** Isolated real evaluation plumbing: source projection, Rust RPC, model HTTP.
 * It never reads gold or scores answers. Algorithms stay in the Rust kernels. */
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
export const sha=s=>createHash('sha256').update(s).digest('hex');
const sort=v=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;
export const objectSha=v=>sha(JSON.stringify(sort(v)));
export function core(module,operation,payload){
 const request={wire_version:'lightog-core/0.1',request_id:randomUUID(),module,operation,payload};
 const r=spawnSync(resolve(root,'target/debug/lightog-core'),[],{input:JSON.stringify(request)+'\n',encoding:'utf8',timeout:60000,maxBuffer:64*1024*1024});
 if(r.error||r.status!==0)throw Object.assign(Error('CORE_PROCESS_FAILED'),{code:'CORE_PROCESS_FAILED'});
 const out=JSON.parse(r.stdout.trim());if(!out.ok)throw Object.assign(Error(out.error.code),{code:out.error.code});return out.data;
}
export function sourceContext(source){
 if(sha(source.content)!==source.sha256)throw Error('SOURCE_HASH_MISMATCH');
 const revision=source.source_revision||'snapshot-'+source.sha256.slice(0,20);
 const units=core('retrieval','extraction_units',{sources:[{id:source.id,sha256:source.sha256,content:source.content}],options:{}});
 const snapshot={base_ref:'eval_'+source.id,source_epoch:0,graph_revision:null,sources:[{source_ref:source.id,source_revision:revision,original_sha256:source.original_sha256,text_sha256:source.sha256,parser_version:source.parser_version}]};
 const fragments=units.map((u,i)=>({id:source.id+':e'+i,origin:'SOURCE_FRAGMENT',source_ref:source.id,source_revision:revision,block_ref:u.id,text_sha256:source.sha256,span:{start:u.start,end:u.end,quote:u.text,offset_unit:'utf16_code_unit'},claim_refs:[],role:'PRIMARY'}));
 const es={contract_version:'lightog-demand/0.1',evidence_set_id:'es_'+source.id,snapshot,fragments};
 const context={examples:{source_evidence:es},source_texts:[{source_ref:source.id,source_revision:revision,text:source.content,original_sha256:source.original_sha256,parser_version:source.parser_version,blocks:units.map(u=>({block_ref:u.id,start:u.start,end:u.end}))}],authority:{requests:[],allowed_snapshots:[snapshot],claims:[],receipts:[],scope_bindings:[],entities:[],predicate_refs:[],user_definitions:[],groups:[],entity_links:[]}};
 return {units,evidenceSet:es,context,snapshot};
}
export async function modelClient(){
 const base='http://127.0.0.1:4324';let token;
 async function api(path,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{origin:base,'x-lightog-token':token||'',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(180000)});const out=await r.json();if(!r.ok)throw Object.assign(Error(out.error||'LOCAL_MODEL_API_FAILED'),{code:out.error});return out;}
 const boot=await api('/api/bootstrap');token=boot.token;
 return {status:boot.status,api};
}
export function attachVectors(payload,vectorResults,queryResults){
 const groups=new Map();
 for(const record of payload.trusted_index.records){const component=record.kind==='DOCUMENT'?'CHUNK':record.kind;if(!groups.has(component))groups.set(component,[]);groups.get(component).push(record);}
 const manifests=[];const context=payload.trusted_index.context;
 context.authority.active_indexes=[];
 for(const [component,records]of groups){
  const result=vectorResults[component];if(!result||result.vectors.length!==records.length)throw Error('VECTOR_RECORD_COUNT_MISMATCH');
  const id='idx_'+component.toLowerCase()+'_'+sha(records.map(r=>r.id).join('|')+result.model+result.dimensions).slice(0,20);
  const space={provider:'EXPLICIT_CONFIGURED_SERVICE',model:result.model,model_revision:result.model_revision,dimensions:result.dimensions,normalization:'NONE',distance:'COSINE',text_policy:'p23-deterministic/1',tokenizer_version:'PROVIDER_MANAGED_VERSION_UNKNOWN'};
  const manifest={contract_version:'lightog-knowledge/0.2',index_id:id,index_revision:'v1',component,snapshot:payload.snapshot,vector_space:space,status:'ACTIVE',records_total:records.length,vectors_completed:records.length,build_receipt_ref:'build_'+id};
  context.authority.receipts.push({receipt_ref:manifest.build_receipt_ref,kind:'INDEX_BUILD',status:'COMPLETE',index_id:id,index_revision:'v1',component,snapshot_sha256:objectSha(payload.snapshot),vector_space_sha256:objectSha(space),records_total:records.length,vectors_completed:records.length});
  context.authority.active_indexes.push(manifest);manifests.push(manifest);
  records.forEach((r,i)=>{if(result.text_sha256[i]!==sha(r.text))throw Error('VECTOR_TEXT_MISMATCH');r.embedding={index_id:id,values:result.vectors[i],text_sha256:result.text_sha256[i]};});
 }
 payload.trusted_index.manifests=manifests;
 payload.query_vectors=manifests.map(m=>{const q=queryResults[m.component];if(!q||q.dimensions!==m.vector_space.dimensions||q.model!==m.vector_space.model||q.model_revision!==m.vector_space.model_revision||q.config_revision!==vectorResults[m.component].config_revision)throw Error('QUERY_SPACE_MISMATCH');const text=m.component==='CHUNK'?payload.queries.document:m.component==='ENTITY'?payload.queries.entity:payload.queries.relation;if(q.text_sha256[0]!==sha(text))throw Error('QUERY_TEXT_MISMATCH');return {component:m.component,index_id:m.index_id,vector_space:m.vector_space,query_text_sha256:q.text_sha256[0],values:q.vectors[0]};});
 return payload;
}
