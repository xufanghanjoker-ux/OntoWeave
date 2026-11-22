import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createStore} from './store.mjs';
import {createProductHttp} from './product-http-v1.mjs';
import {createNativeFullChainProduct} from './native-full-chain-product-v1.mjs';
import {DEMAND_FAMILY_POLICY} from './native-demand-family-v1.mjs';
import {createNativeFullChainHttp} from './native-full-chain-http-v1.mjs';
import {hash} from './cq-discovery-store-v2.mjs';
import {createNativeCQSourceAdapter} from './native-cq-source-adapter-v1.mjs';
import {createNativeFullRun} from './native-full-run-v1.mjs';
import {createNativeFamilyInput,materializeNativeFamilyRefs} from './native-family-input-adapter-v1.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const MODE='NATIVE_CQ_BUILD_V1';
async function fixture({chainFactory,familyPolicy}={}){
  const dir=mkdtempSync(join(tmpdir(),'native-product-http-')),store=createStore(dir),libraryId='kb_'+randomUUID(),content='Maple retains messages for 3 days.';
  const document={document_id:randomUUID(),parser:'docling',parser_version:'authored-test/1',offset_unit:'utf16_code_unit',content,original_sha256:'a'.repeat(64),parsed_sha256:sha(content),blocks:[{block_id:'#/texts/0',kind:'paragraph',start:0,end:content.length,provenance:[{page_no:1}]}]};
  const sources=[{id:'source_1',key:'src_'+sha(content).slice(0,32),title:'Authored parser fixture',content,parsing:document,active:true}];
  const state={source_epoch:0},calls={initial:0,runs:0,queries:0,generation:0,factories:[]};let models=null,unblock=null;
  const governance={baseFor:id=>id===libraryId?state:null,revoke(){sources[0].active=false;state.source_epoch++;}};
  const product={modelStatus:()=>({generation:{configured:Boolean(models?.upstream)},embedding:{configured:Boolean(models?.embed)}}),nativeModelRuntime:()=>{if(!models)throw Object.assign(Error('NATIVE_GENERATION_NOT_CONFIGURED'),{code:'NATIVE_GENERATION_NOT_CONFIGURED'});return models;},importLibrary:()=>({library_id:libraryId,status:'SOURCE_IMPORTED_GRAPH_NOT_BUILT'}),updateSource:()=>({library_id:libraryId})};
  const runtime={sources:()=>sources,view:()=>({library:{id:libraryId,sources},processing:{}}),initial(){calls.initial++;return {status:'QUEUED'};}};
  const factory=({runId,formatRepairPolicy,confirmedUpstream})=>{calls.factories.push({runId,formatRepairPolicy:structuredClone(formatRepairPolicy),...(confirmedUpstream?{confirmedUpstream:structuredClone(confirmedUpstream)}:{})});return {
    async run(){calls.runs++;if(unblock)await unblock;store.putRecord('native_test_chain_v1',runId,{status:'SUCCEEDED',readback_verified:true});},
    snapshot(){return {run:{run_id:runId,status:store.getRecord('native_test_chain_v1',runId)?.status??'RUNNING'},cq_input:{items:[{cq_ref:'Q01',question:'What is Maple retention?'}]},families:{families:[]}};},
    query(args){calls.queries++;return {view:args.view,results:[{representation:'ADOPTED_FACT',text:content,policy:'native-local-adoption-v1',source_refs:[{doc_ref:sources[0].key}]}]};},
    graph(){return {nodes:[{id:'Maple'}],edges:[]};}
  };};
  const host=createNativeFullChainProduct({store,governance,runtime,product,runtimeDirectory:join(dir,'runtime'),chainFactory:chainFactory??factory,...(familyPolicy===undefined?{}:{familyPolicy})});
  const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
  const parseBody=async req=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);return JSON.parse(Buffer.concat(chunks).toString()||'{}');};
  const handler=createProductHttp({runtime,product,governance,nativeBuildHost:host,json,parseBody,prepareInput:x=>({...x,sources}),openStream:()=>{}});
  const server=createServer(async(req,res)=>{try{if(!await handler({req,res,pathname:new URL(req.url,'http://localhost').pathname}))json(res,404,{});}catch(error){json(res,error.status??409,{code:error.code??error.message});}});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const origin='http://127.0.0.1:'+server.address().port;
  const api=async(path,body)=>{const r=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};};
  const path='/api/product/libraries/'+libraryId,base=path+'/native-full-chain/runs';
  return {dir,store,host,api,base,path,libraryId,state,calls,product,sources,models(value){models=value;},hold(){unblock=new Promise(done=>{this.release=done;});},async register(mode=MODE){return api('/api/product/libraries',{request_id:randomUUID(),build_mode:mode,input:{sources:[{document_id:document.document_id}]}});},async close(){await host.whenIdle();await new Promise(done=>server.close(done));await host.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
const configured=()=>({upstream:async()=>{throw Error('no real provider allowed');},embed:async()=>({vectors:[[1,0]]}),embeddingSpace:{model:'authored',revision:'1',dimensions:2,input_strategy:'query-document-v1',distance:'cosine'},generation:{model:'qwen3.8-flash',config_revision:1}});

test('status exposes only this run business argument recovery while retaining partial review and historical UNKNOWN',async()=>{
 const f=await fixture();try{
  await f.register();f.models(configured());const started=await f.api(f.base,{request_id:randomUUID(),consent:true,limits:{max_generation_requests:2},capability:'HYBRID'});assert.equal(started.status,202);await f.host.whenIdle();const runId=started.body.run_id,stageId=runId+'_window_test';
  f.store.putRecord('native_extraction_window_stage_v1',stageId,{parent_run_id:runId,stage_run_id:stageId});
  f.store.putRecord('native_agent_argument_normalization_v1','this_repair',{run_id:runId,normalization_ref:'this_repair',tool_name:'lightog_save_relation_review',status:'FORMAT_REPAIRED',warnings:['FORMAT_REPAIRED'],raw_arguments:'{"text":"意见"',normalized_arguments:'{"text":"意见"}',delta_count:413,body_utf8:'PRIVATE_WIRE_SENTINEL',reasoning:'PRIVATE_REASONING_SENTINEL'});
  f.store.putRecord('native_agent_argument_normalization_v1','this_raw',{run_id:stageId,normalization_ref:'this_raw',status:'UNPARSED_REVIEW_RETAINED',raw_arguments:'无法恢复原文'});
  f.store.putRecord('native_agent_argument_normalization_v1','foreign',{run_id:'nrun_'+'f'.repeat(32),status:'FORMAT_REPAIRED',raw_arguments:'FOREIGN_SENTINEL'});
  f.store.putRecord('native_organization_relation_review_v1',stageId,{run_id:runId,stage_run_id:stageId,status:'PARTIAL_WARN',gaps:['意见未完整保存'],review_completed:false,retained_texts:[{text:'无法恢复原文'}],findings:[{text:'已保存的意见'}]});
  const before=hash(f.store.listRecords('native_agent_argument_normalization_v1')),r=(await f.api(f.base+'/'+runId+'/status')).body,recovery=r.program_output_recovery;
  assert.equal(r.status,'SUCCEEDED');assert.equal(recovery.recovered_count,1);assert.equal(recovery.unrecovered_count,1);assert.equal(recovery.partial_review_count,1);assert.equal(recovery.normalizations.find(n=>n.normalization_ref==='this_repair').delta_count,413);assert(recovery.normalizations.some(n=>n.raw_arguments==='无法恢复原文'));assert.equal(recovery.relation_reviews[0].status,'PARTIAL_WARN');
  for(const secret of ['PRIVATE_WIRE_SENTINEL','PRIVATE_REASONING_SENTINEL','FOREIGN_SENTINEL'])assert(!JSON.stringify(recovery).includes(secret));assert.equal(hash(f.store.listRecords('native_agent_argument_normalization_v1')),before);
  const row=f.store.getRecord('native_product_run_v1',runId);f.store.putRecord('native_product_run_v1',runId,{...row,status:'UNKNOWN_HOLD'});const unknown=(await f.api(f.base+'/'+runId+'/status')).body;assert.equal(unknown.status,'UNKNOWN_HOLD');assert.equal(unknown.program_output_recovery.partial_review_count,1);assert.equal(f.calls.runs,1);
 }finally{await f.close();}
});

test('native HTTP forwards an explicit saved CQ draft continuation without changing it to discovery-only',async()=>{
 const libraryId='kb_'+randomUUID(),upstream='nrun_'+'a'.repeat(32),calls=[];
 const handler=createNativeFullChainHttp({host:{start:async args=>{calls.push(args);return {run_id:'nrun_new'};}},json:(_res,status,body)=>({status,body}),parseBody:async req=>req.body});
 const request={method:'POST',body:{request_id:randomUUID(),consent:true,limits:{max_generation_requests:16},capability:'HYBRID',reuse_cq_drafts_from_run_id:upstream}};
 assert.equal(await handler({req:request,res:{},pathname:'/api/product/libraries/'+libraryId+'/native-full-chain/runs'}),true);
 assert.equal(calls.length,1);assert.equal(calls[0].reuseCQDraftsFromRunId,upstream);assert.equal(calls[0].capability,'HYBRID');assert.equal(Object.hasOwn(calls[0],'stopAfter'),false);
 request.body.reuse_cq_drafts_from_run_id='invalid';await assert.rejects(()=>handler({req:request,res:{},pathname:'/api/product/libraries/'+libraryId+'/native-full-chain/runs'}),{code:'NATIVE_REUSE_RUN_ID_INVALID'});assert.equal(calls.length,1);
});

test('native UI offers saved window CQ recovery and explicitly starts a full continuation',async()=>{
 const requests=[],elements=new Map(),root={innerHTML:''},libraryId='kb_'+randomUUID(),upstream='nrun_'+'a'.repeat(32);
 const boot={tasks:[],knowledge_bases:[],configured:false,token:'authored-csrf'},meta={build_mode:MODE,runs:[],configuration:{generation_configured:true,embedding_configured:true}};
 const context={console,URL,TextDecoder,TextEncoder,crypto:{randomUUID},setTimeout:()=>1,clearTimeout:()=>{},setInterval:()=>1,document:{activeElement:null,querySelector:s=>s==='#app'?root:elements.get(s)??null,querySelectorAll:()=>[],addEventListener:()=>{}},window:{location:{hash:'',pathname:'/'},history:{replaceState:()=>{}},addEventListener:()=>{},scrollTo:()=>{}},fetch:async(path,options)=>{const body=options?.body?JSON.parse(options.body):undefined;requests.push({path,body});return {ok:true,json:async()=>path.endsWith('/view')?{library:{id:libraryId},native_full_chain:meta}:boot};}};
 const ui=await runInNewContext('(async()=>{'+readFileSync(new URL('./app.mjs',import.meta.url),'utf8')+';return {state,nativeBuildPage,handleProductAction};})()',context);
 ui.state.productLibraryId=libraryId;ui.state.productView={native_full_chain:meta};ui.state.nativeRun={run_id:upstream,library_id:libraryId,status:'FAILED',source_current:true,reusable_cq_drafts:{available:true,upstream_run_id:upstream,cq_count:7},snapshot:{input:{knowledge_build_policy:'EXTRACT_AND_INDEX_V1'},run:{attempts:[],checkpoints:[]}}};
 const markup=ui.nativeBuildPage();assert.match(markup,/已保留 7 条窗口CQ草稿/);assert.match(markup,/沿用已保存CQ草稿，继续构建/);
 elements.set('#native-stop-after',{value:'FAMILY'});elements.set('#native-capability',{value:'LEXICAL',disabled:true});elements.set('#native-embedding-limit',{value:'0',disabled:true});
 await ui.handleProductAction('native-reuse-cq-drafts',{dataset:{}});
 const start=requests.find(r=>r.path.endsWith('/native-full-chain/runs')&&r.body);assert.equal(start.body.reuse_cq_drafts_from_run_id,upstream);assert.equal(start.body.capability,'HYBRID');assert.equal(Object.hasOwn(start.body,'stop_after'),false);assert.equal(start.body.limits.max_embedding_batches,12);assert.equal(Object.hasOwn(start.body,'reuse_cq_from_run_id'),false);assert.equal(Object.hasOwn(start.body,'allow_format_repair_once'),false);
});

test('retained extraction request needs an explicit CQ-family prefix and cannot enter discovery-only scope',async()=>{
 const f=await fixture();try{
  await f.register();f.models(configured());
  const body={request_id:randomUUID(),consent:true,limits:{max_generation_requests:4},reuse_extraction_from_run_id:'nrun_'+'a'.repeat(32)};
  assert.equal((await f.api(f.base,body)).body.code,'NATIVE_EXTRACTION_REUSE_PREFIX_REQUIRED');
  assert.equal((await f.api(f.base,{...body,request_id:randomUUID(),reuse_extraction_from_run_id:'invalid'})).body.code,'NATIVE_REUSE_RUN_ID_INVALID');
  assert.equal((await f.api(f.base,{...body,request_id:randomUUID(),stop_after:'FAMILY'})).body.code,'NATIVE_EXTRACTION_REUSE_PREFIX_REQUIRED');
  assert.equal(f.calls.runs,0);assert.equal(f.store.listRecords('native_product_run_v1').length,0);
 }finally{await f.close();}
});

test('product discovery-only scope needs no embedding and is part of the idempotent request',async()=>{
 const options=[];
 const f=await fixture({chainFactory:args=>{options.push(args);return {async run(){},snapshot(){return {run:{status:'SUCCEEDED'},input:{stop_after:'FAMILY'},build:null};}};}});
 try{
  await f.register();f.models({upstream:async()=>{throw Error('no provider allowed');},generation:{model:'qwen3.8-flash',config_revision:1}});
  const body={request_id:randomUUID(),consent:true,limits:{max_generation_requests:10,max_embedding_batches:0},stop_after:'FAMILY'};
  const started=await f.api(f.base,body);assert.equal(started.status,202);assert.equal(started.body.stop_after,'FAMILY');
  await f.host.whenIdle();assert.equal(options[0].stopAfter,'FAMILY');assert(options[0].cqChunkOptions.documentStorage);
  const status=await f.api(f.base+'/'+started.body.run_id);assert.equal(status.body.capability,'LEXICAL');assert.equal(status.body.snapshot.build,null);
  assert.equal((await f.api(f.base,body)).body.idempotent,true);
  const changed=await f.api(f.base,{...body,stop_after:undefined,capability:'LEXICAL'});assert.equal(changed.body.code,'NATIVE_REQUEST_CONFLICT');
  assert.equal((await f.api(f.base,{...body,request_id:randomUUID(),stop_after:'EXTRACTION'})).body.code,'NATIVE_STOP_AFTER_INVALID');
 }finally{await f.close();}
});

test('HTTP allows the extracted view and leaves omitted defaults to the saved chain policy',async()=>{
 const calls=[],libraryId='kb_00000000-0000-4000-8000-000000000001',runId='run_authored',base='/api/product/libraries/'+libraryId+'/native-full-chain/runs/'+runId;
 let payload;
 const handle=createNativeFullChainHttp({host:{graph:async args=>{calls.push(args);return args;},query:async args=>{calls.push(args);return args;}},json:(_res,_status,body)=>body,parseBody:async()=>payload});
 await handle({req:{method:'GET',url:base+'/graph'},res:{},pathname:base+'/graph'});assert.equal(Object.hasOwn(calls.at(-1),'view'),false);
 await handle({req:{method:'GET',url:base+'/graph?view=EXTRACTED_KNOWLEDGE'},res:{},pathname:base+'/graph'});assert.equal(calls.at(-1).view,'EXTRACTED_KNOWLEDGE');
 payload={query:'saved knowledge'};await handle({req:{method:'POST'},res:{},pathname:base+'/query'});assert.equal(Object.hasOwn(calls.at(-1),'view'),false);
 payload={view:'EXTRACTED_KNOWLEDGE',query:'saved knowledge'};await handle({req:{method:'POST'},res:{},pathname:base+'/query'});assert.equal(calls.at(-1).view,'EXTRACTED_KNOWLEDGE');
 payload={view:'UNKNOWN_VIEW',query:'saved knowledge'};await assert.rejects(handle({req:{method:'POST'},res:{},pathname:base+'/query'}),{code:'NATIVE_VIEW_INVALID'});
 assert.equal(calls.length,4);
});

// Authored native receipts test admission only; no process or model is invoked.
async function authoredConfirmedUpstream(f){
  await f.register();f.models(configured());
  const registered=f.store.getRecord('native_product_library_v1',f.libraryId),snapshotId=registered.snapshot_id,source=f.host.catalog.get(snapshotId,f.libraryId),doc=source.documents[0],runId='nrun_'+randomUUID().replaceAll('-','');
  const input={library_ref:f.libraryId,source_snapshot_ref:snapshotId,source_fingerprint:source.fingerprint};
  const parent=createNativeFullRun({store:f.store,runId,input,limits:{max_generation_requests:4}});
  const sourceArtifact=parent.checkpoint('SOURCE_READY',{snapshot_id:snapshotId});
  const adapter=createNativeCQSourceAdapter({store:f.store,catalog:f.host.catalog,libraryId:f.libraryId,snapshotId,runId,assertOpen:()=>parent.assertOpen(),saveContract:'SOURCE_DOC_REFS_V1',readContract:'NEXT_UNREAD_V1'});
  assert.equal(adapter.call('lightog_read_cq_material',{doc_ref:doc.doc_id}).ok,true);
  assert.equal(adapter.call('lightog_save_cq_list',{items:[{question:'How many days does Maple retain messages?',source_doc_refs:[doc.doc_id]}]}).ok,true);
  const cq=adapter.snapshot().cq_input,familyInput=createNativeFamilyInput({runId,sourceSnapshotRef:snapshotId,inputs:[cq]});
  const families=materializeNativeFamilyRefs({input:familyInput,families:{input_ref:familyInput.input_ref,families:[{name:'Message retention',representative_question:'How many days does Maple retain messages?',member_refs:[familyInput.items[0].cq_ref]}],unassigned:[]}});
  const cqArtifact=parent.checkpoint('CQ_SAVED',cq,[sourceArtifact.artifact_ref]);parent.checkpoint('FAMILIES_SAVED',families,[cqArtifact.artifact_ref]);
  const invocations=['CQ','FAMILY'].map(role=>{
    const request=parent.reserve({kind:'GENERATION',role,requestBytes:1});parent.settle(request.request_ref,{outcome:'RETURNED'});
    const value={invocation_ref:'authored_'+role,run_id:runId,role,origin:'CODEX_NATIVE_APP_SERVER',semantic_origin:'SCRIPTED',status:'SUCCEEDED',outcome:'RETURNED',request_refs:[request.request_ref]};
    f.store.putRecord('native_agent_invocation_v1',hash({run_id:runId,role}),value);return value;
  });
  parent.stop('AUTHORED_DOWNSTREAM_FAILURE','FAILED');
  f.store.putRecord('native_full_chain_state_v1',runId,{run_id:runId,library_id:f.libraryId,snapshot_id:snapshotId,input,limits:parent.state().limits,execution_started:true,cq_input:cq,family_input:familyInput,families,invocations,build:null,readback:null});
  f.store.putRecord('native_product_run_v1',runId,{run_id:runId,library_id:f.libraryId,snapshot_id:snapshotId,source_epoch:registered.source_epoch,build_mode:MODE,status:'FAILED',reason:'AUTHORED_DOWNSTREAM_FAILURE',limits:parent.state().limits,capability:'HYBRID',created_at:parent.state().created_at});
  return {runId,snapshotId,source,parent,cqArtifact,readRef:adapter.snapshot().reads?.[0]?.read_receipt_ref};
}

test('explicit product reuse imports confirmed CQ/family into a new run with idempotency and no mutation of the failed run',async()=>{
  const f=await fixture();try{
    const old=await authoredConfirmedUpstream(f),kinds=['native_product_run_v1','native_full_run_v1','native_full_chain_state_v1','native_cq_source_adapter_v1'],before=kinds.map(k=>hash(f.store.getRecord(k,old.runId)));
    const info=(await f.api(f.base+'/'+old.runId+'/status')).body.reusable_cq_family;
    assert.equal(info.available,true);assert.equal(info.upstream_run_id,old.runId);assert.equal(info.cq_count,1);assert.equal(info.family_count,1);assert.equal(f.calls.runs,0);
    const body={request_id:randomUUID(),consent:true,limits:{max_generation_requests:4},capability:'HYBRID',reuse_cq_family_from_run_id:old.runId};
    const started=await f.api(f.base,body);assert.equal(started.status,202);assert.notEqual(started.body.run_id,old.runId);assert.equal(started.body.execution_mode,'REUSE_CONFIRMED_CQ_FAMILY');
    await f.host.whenIdle();const factory=f.calls.factories.find(x=>x.runId===started.body.run_id);
    assert.equal(factory.confirmedUpstream.upstream_run_id,old.runId);assert.equal(factory.confirmedUpstream.cq_scan_status,'COMPLETE');assert.equal(factory.confirmedUpstream.cq_input.items.length,1);
    assert.equal(f.store.getRecord('native_product_run_v1',started.body.run_id).reuse_cq_family_from_run_id,old.runId);
    const repeated=await f.api(f.base,body);assert.equal(repeated.status,202);assert.equal(repeated.body.idempotent,true);assert.equal(repeated.body.run_id,started.body.run_id);assert.equal(f.calls.runs,1);
    const changed=await f.api(f.base,{...body,reuse_cq_family_from_run_id:undefined});assert.equal(changed.body.code,'NATIVE_REQUEST_CONFLICT');
    assert.deepEqual(kinds.map(k=>hash(f.store.getRecord(k,old.runId))),before);assert.equal(f.calls.initial,0);
  }finally{await f.close();}
});

for(const status of ['SUCCEEDED','PARTIALLY_READY'])test(`completed ${status} upstream exposes extraction-only reuse without rewriting saved outputs`,async()=>{
 const f=await fixture();try{
  const old=await authoredConfirmedUpstream(f);
  for(const kind of ['native_product_run_v1','native_full_run_v1']){const value=f.store.getRecord(kind,old.runId);value.status=status;f.store.putRecord(kind,old.runId,value);}
  const before=hash(f.store.getRecord('native_full_chain_state_v1',old.runId));
  const info=(await f.api(f.base+'/'+old.runId+'/status')).body.reusable_cq_family;
  assert.equal(info.available,true);
  const started=await f.api(f.base,{request_id:randomUUID(),consent:true,limits:{max_generation_requests:4},capability:'HYBRID',reuse_cq_family_from_run_id:old.runId});
  assert.equal(started.status,202);await f.host.whenIdle();assert.equal(f.calls.runs,1);
  assert.equal(hash(f.store.getRecord('native_full_chain_state_v1',old.runId)),before);
  assert.equal(f.calls.factories.find(x=>x.runId===started.body.run_id).confirmedUpstream.upstream_run_id,old.runId);
 }finally{await f.close();}
});

for(const scenario of [
  {name:'unknown results',code:'NATIVE_LIBRARY_UNKNOWN_HOLD',change(f,o){for(const k of ['native_product_run_v1','native_full_run_v1']){const r=f.store.getRecord(k,o.runId);r.status='UNKNOWN_HOLD';f.store.putRecord(k,o.runId,r);}}},
  {name:'unsettled results',code:'NATIVE_REUSE_UNCONFIRMED_RUN',change(f,o){const r=f.store.getRecord('native_full_run_v1',o.runId);r.attempts[0].outcome='RESERVED';f.store.putRecord('native_full_run_v1',o.runId,r);}},
  {name:'changed sources',code:'NATIVE_REUSE_SOURCE_STALE',change(f){f.state.source_epoch++;}},
  {name:'changed input binding',code:'NATIVE_REUSE_SOURCE_MISMATCH',change(f,o){const r=f.store.getRecord('native_full_chain_state_v1',o.runId);r.input.source_fingerprint='changed';f.store.putRecord('native_full_chain_state_v1',o.runId,r);}},
  {name:'unconfirmed role receipt',code:'NATIVE_REUSE_INVOCATION_REQUIRED',change(f,o){const key=hash({run_id:o.runId,role:'FAMILY'}),r=f.store.getRecord('native_agent_invocation_v1',key);r.status='FAILED';f.store.putRecord('native_agent_invocation_v1',key,r);}},
  {name:'changed artifact',code:'NATIVE_REUSE_ARTIFACT_CHANGED',change(f,o){const r=f.store.getRecord('native_full_run_artifact_v1',o.cqArtifact.artifact_ref);r.payload.items[0].question='changed';f.store.putRecord('native_full_run_artifact_v1',o.cqArtifact.artifact_ref,r);}},
  {name:'foreign library',code:'NATIVE_RUN_NOT_FOUND',change(f,o){const r=f.store.getRecord('native_product_run_v1',o.runId);r.library_id='kb_'+randomUUID();f.store.putRecord('native_product_run_v1',o.runId,r);}},
  {name:'incomplete CQ scan',code:'NATIVE_REUSE_CQ_SCAN_INCOMPLETE',change(f,o){const r=f.store.getRecord('native_cq_source_adapter_v1',o.runId),unit=r.reads[0].result.units[0];unit.end--;unit.text=unit.text.slice(0,-1);f.store.putRecord('native_cq_read_receipt_v1',r.reads[0].read_receipt_ref,r.reads[0]);f.store.putRecord('native_cq_source_adapter_v1',o.runId,r);}}
])test('product reuse rejects '+scenario.name+' before dispatch',async()=>{
  const f=await fixture();try{
    const old=await authoredConfirmedUpstream(f);scenario.change(f,old);const count=f.store.listRecords('native_product_run_v1').length;
    const result=await f.api(f.base,{request_id:randomUUID(),consent:true,limits:{max_generation_requests:4},reuse_cq_family_from_run_id:old.runId});
    assert.equal(result.body.code,scenario.code);assert.equal(f.calls.runs,0);assert.equal(f.store.listRecords('native_product_run_v1').length,count);
  }finally{await f.close();}
});
test('native registration does not trigger legacy learning; missing models remain readable and cannot start',async()=>{
  const f=await fixture();try{
    const saved=await f.register();assert.equal(saved.status,201);assert.equal(saved.body.learning.status,'NOT_STARTED');assert.equal(f.calls.initial,0);
    const listing=await f.api(f.base);assert.equal(listing.status,200);assert.equal(listing.body.configuration.generation_configured,false);assert.equal(listing.body.runs.length,0);
    const rejected=await f.api(f.base,{request_id:randomUUID(),consent:true,limits:{max_generation_requests:4}});assert.equal(rejected.body.code,'NATIVE_GENERATION_NOT_CONFIGURED');assert.equal(f.calls.runs,0);
    f.models({...configured(),embed:null,embeddingSpace:null});assert.equal((await f.api(f.base,{request_id:randomUUID(),consent:true,limits:{max_generation_requests:4}})).body.code,'NATIVE_EMBEDDING_NOT_CONFIGURED');
  }finally{await f.close();}
});
test('HTTP start is idempotent under concurrent requests; status/query/graph do not execute the model; old mode stays intact',async()=>{
  const f=await fixture();try{
    await f.register();f.models(configured());f.hold();
    const request={request_id:randomUUID(),consent:true,limits:{max_generation_requests:4},capability:'HYBRID'};
    const starts=await Promise.all([f.api(f.base,request),f.api(f.base,request)]);assert(starts.every(r=>r.status===202));assert.equal(starts[0].body.run_id,starts[1].body.run_id);assert.equal(f.calls.runs,1);
    const runId=starts[0].body.run_id;
    assert.equal((await f.api(f.base+'/'+runId+'/status')).body.status,'RUNNING');
    assert.equal((await f.api(f.base+'/'+runId+'/query',{view:'ADOPTED_FACT',query:'retention'})).body.results[0].representation,'ADOPTED_FACT');
    assert.equal((await f.api(f.base+'/'+runId+'/graph')).body.nodes[0].id,'Maple');assert.equal(f.calls.runs,1);
    assert.equal((await f.api(f.base,{...request,limits:{max_generation_requests:5}})).body.code,'NATIVE_REQUEST_CONFLICT');
    f.release();await f.host.whenIdle();assert.equal((await f.api(f.base+'/'+runId+'/status')).body.status,'SUCCEEDED');
    assert.equal((await f.api(f.path+'/ask',{request_id:randomUUID(),question:'retention?'})).body.code,'NATIVE_QUERY_USE_READBACK');
    assert.equal(f.calls.initial,0);
    await f.api('/api/product/libraries',{request_id:randomUUID(),input:{sources:[{}]}});assert.equal(f.calls.initial,0,'a repeated native library cannot silently start the legacy loop');
  }finally{f.release?.();await f.close();}
});
test('format repair defaults to zero and omitted/false keep the new request policy digest',async()=>{
  const f=await fixture();try{
    await f.register();f.models(configured());f.hold();
    const request={request_id:randomUUID(),consent:true,limits:{max_generation_requests:4},capability:'HYBRID'};
    const started=await f.api(f.base,request);assert.equal(started.status,202);
    assert.equal(started.body.allow_format_repair_once,false);
    assert.deepEqual(f.calls.factories[0].formatRepairPolicy,{max_per_agent:0});
    const savedRequest=f.store.getRecord('native_product_request_v1',hash([f.libraryId,request.request_id]));
    assert.equal(savedRequest.digest,hash({limits:request.limits,capability:request.capability,family_policy:DEMAND_FAMILY_POLICY}));
    const repeated=await f.api(f.base,{...request,allow_format_repair_once:false});
    assert.equal(repeated.status,202);assert.equal(repeated.body.idempotent,true);assert.equal(repeated.body.run_id,started.body.run_id);
    assert.equal(repeated.body.allow_format_repair_once,false);assert.equal(f.calls.runs,1);assert.equal(f.calls.factories.length,1);
    const changed=await f.api(f.base,{...request,allow_format_repair_once:true});assert.equal(changed.body.code,'NATIVE_REQUEST_CONFLICT');
    assert.equal(changed.status,409);assert.equal(f.calls.runs,1);
    const listing=await f.api(f.base);assert.equal(listing.body.runs[0].allow_format_repair_once,false);
  }finally{f.release?.();await f.close();}
});
test('explicit format repair maps to one, is public and has policy-aware concurrent idempotency',async()=>{
  const f=await fixture();try{
    await f.register();f.models(configured());f.hold();
    const request={request_id:randomUUID(),consent:true,limits:{max_generation_requests:6},capability:'HYBRID',allow_format_repair_once:true};
    const starts=await Promise.all([f.api(f.base,request),f.api(f.base,request)]);
    assert(starts.every(x=>x.status===202));assert.equal(starts[0].body.run_id,starts[1].body.run_id);
    assert(starts.every(x=>x.body.allow_format_repair_once===true));
    assert.equal(f.calls.runs,1);assert.equal(f.calls.factories.length,1);
    assert.deepEqual(f.calls.factories[0].formatRepairPolicy,{max_per_agent:1});
    assert.equal(f.store.getRecord('native_product_request_v1',hash([f.libraryId,request.request_id])).digest,
      hash({limits:request.limits,capability:request.capability,family_policy:DEMAND_FAMILY_POLICY,allow_format_repair_once:true}));
    const runId=starts[0].body.run_id;
    assert.equal((await f.api(f.base+'/'+runId+'/status')).body.allow_format_repair_once,true);
    assert.equal((await f.api(f.base)).body.runs[0].allow_format_repair_once,true);
    const changed=await f.api(f.base,{...request,allow_format_repair_once:false});assert.equal(changed.body.code,'NATIVE_REQUEST_CONFLICT');
    assert.equal(f.calls.runs,1);
  }finally{f.release?.();await f.close();}
});
test('invalid format repair types create no run, request record or chain controller',async()=>{
  const f=await fixture();try{
    await f.register();f.models(configured());
    for(const value of [null,0,1,'true','false',[],{}]){
      const result=await f.api(f.base,{request_id:randomUUID(),consent:true,limits:{max_generation_requests:4},allow_format_repair_once:value});
      assert.equal(result.status,400);assert.equal(result.body.code,'NATIVE_FORMAT_REPAIR_POLICY_INVALID');
    }
    await assert.rejects(f.host.start({libraryId:f.libraryId,requestId:randomUUID(),limits:{max_generation_requests:4},allowFormatRepairOnce:'true'}),{code:'NATIVE_FORMAT_REPAIR_POLICY_INVALID'});
    assert.equal(f.calls.runs,0);assert.equal(f.calls.factories.length,0);
    for(const kind of ['native_product_run_v1','native_product_request_v1','native_full_run_v1','attempt'])assert.equal(f.store.listRecords(kind).length,0,kind);
  }finally{await f.close();}
});
test('legacy requests and restarted status stay repair-disabled without replay or policy mutation',async()=>{
  const f=await fixture();let recovered;
  try{
    const registration=await f.register(),requestId=randomUUID(),runId='legacy_native_run',limits={max_generation_requests:4};
    f.store.putRecord('native_product_run_v1',runId,{run_id:runId,library_id:f.libraryId,snapshot_id:registration.body.snapshot_id,source_epoch:f.state.source_epoch,status:'RUNNING',limits,capability:'HYBRID',created_at:1});
    f.store.putRecord('native_product_request_v1',hash([f.libraryId,requestId]),{digest:hash({limits,capability:'HYBRID'}),run_id:runId});
    const controllerPolicies=[];
    recovered=createNativeFullChainProduct({store:f.store,governance:{baseFor:()=>f.state},runtime:{sources:()=>f.sources},product:f.product,runtimeDirectory:f.dir,
      chainFactory:options=>{controllerPolicies.push(options.formatRepairPolicy);return {snapshot:()=>({status:'RUNNING'}),run(){throw Error('must not replay');}};}});
    const status=await recovered.status({libraryId:f.libraryId,runId});
    assert.equal(status.status,'UNKNOWN_HOLD');assert.equal(status.allow_format_repair_once,false);
    assert.deepEqual(controllerPolicies,[],'UNKNOWN reads must not construct a controller or settle its old ledger');
    assert.equal(Object.hasOwn(f.store.getRecord('native_product_run_v1',runId),'allow_format_repair_once'),false,'reading an old row must not widen or rewrite its policy');
    const listing=await recovered.list({libraryId:f.libraryId});assert.equal(listing.runs[0].allow_format_repair_once,false);
    const repeated=await f.api(f.base,{request_id:requestId,consent:true,limits,allow_format_repair_once:false});
    assert.equal(repeated.status,202);assert.equal(repeated.body.run_id,runId);assert.equal(repeated.body.idempotent,true);
    assert.equal(repeated.body.allow_format_repair_once,false);assert.equal(f.calls.runs,0);
    assert.equal(f.calls.factories.length,0,'idempotent UNKNOWN lookup must also stay read-only');
    assert.equal((await f.api(f.base,{request_id:requestId,consent:true,limits,allow_format_repair_once:true})).body.code,'NATIVE_REQUEST_CONFLICT');
    assert.equal(f.calls.runs,0);
  }finally{await recovered?.close();await f.close();}
});
test('an unmarked library still uses the legacy initial path',async()=>{
  const f=await fixture();try{const saved=await f.api('/api/product/libraries',{request_id:randomUUID(),input:{sources:[{}]}});assert.equal(saved.status,201);assert.equal(f.calls.initial,1);assert.equal(f.calls.runs,0);}finally{await f.close();}
});
test('native UI shows saved CQ and separate build/readback controls; explicit start carries shared limits',async()=>{
  const requests=[],elements=new Map(),root={innerHTML:''},libraryId='kb_'+randomUUID();
  const boot={tasks:[],knowledge_bases:[],configured:false,token:'authored-csrf'};
  const meta={build_mode:MODE,runs:[],configuration:{generation_configured:true,embedding_configured:true}};
  const context={console,URL,TextDecoder,TextEncoder,crypto:{randomUUID},setTimeout:()=>1,clearTimeout:()=>{},setInterval:()=>1,document:{activeElement:null,querySelector:s=>s==='#app'?root:elements.get(s)??null,querySelectorAll:()=>[],addEventListener:()=>{}},window:{location:{hash:'',pathname:'/'},history:{replaceState:()=>{}},addEventListener:()=>{},scrollTo:()=>{}},fetch:async(path,options)=>{const body=options?.body?JSON.parse(options.body):undefined;requests.push({path,body});return {ok:true,json:async()=>path.endsWith('/view')?{library:{id:libraryId},native_full_chain:meta}:path.endsWith('/runs')&&body?{run_id:'nrun_scripted'}:boot};}};
  const ui=await runInNewContext('(async()=>{'+readFileSync(new URL('./app.mjs',import.meta.url),'utf8')+';return {state,inputPage,nativeBuildPage,handleProductAction};})()',context);
  ui.state.boot={...boot,source_first:{default_path_adopted:true}};ui.state.nativeCreate=true;
  assert.match(ui.inputPage(),/保存解析资料/);assert.match(ui.inputPage(),/PDF／DOCX/);
  ui.state.productLibraryId=libraryId;ui.state.productView={native_full_chain:meta};
  ui.state.nativeRun={run_id:'nrun_scripted',status:'PARTIALLY_READY',snapshot:{run:{attempts:[{kind:'GENERATION'}],checkpoints:[{stage:'CQ_SAVED'}]},cq_input:{items:[{cq_ref:'Q01',question:'<script>source question</script>'}]},families:{families:[]}}};
  const markup=ui.nativeBuildPage();assert.match(markup,/部分知识可用/);assert.match(markup,/&lt;script&gt;source question/);assert.doesNotMatch(markup,/<script>source question/);assert.match(markup,/不新增模型请求/);
  elements.set('#native-generation-limit',{value:'9'});elements.set('#native-embedding-limit',{value:'4'});elements.set('#native-wall-seconds',{value:'120'});elements.set('#native-capability',{value:'HYBRID'});
  await ui.handleProductAction('native-start',{dataset:{}});
  const start=requests.find(r=>r.path.endsWith('/native-full-chain/runs')&&r.body);
  assert.equal(start.body.consent,true);assert.equal(start.body.limits.max_generation_requests,9);assert.equal(start.body.limits.max_embedding_batches,4);assert.equal(start.body.limits.max_wall_ms,120000);
  assert.equal(requests.filter(r=>r.path.endsWith('/native-full-chain/runs')&&r.body).length,1);
});
test('source changes invalidate readback and a restarted in-flight run cannot replay through a new request id',async()=>{
  const f=await fixture();try{
    await f.register();f.models(configured());
    const start=await f.api(f.base,{request_id:randomUUID(),consent:true,limits:{max_generation_requests:4}});await f.host.whenIdle();
    f.state.source_epoch++;
    assert.equal((await f.api(f.base+'/'+start.body.run_id+'/status')).body.status,'STALE');
    assert.equal((await f.api(f.base+'/'+start.body.run_id+'/query',{query:'retention'})).body.code,'NATIVE_SOURCE_STALE');
    f.store.putRecord('native_product_run_v1','interrupted',{run_id:'interrupted',library_id:f.libraryId,status:'RUNNING'});
    const recovered=createNativeFullChainProduct({store:f.store,governance:{baseFor:()=>f.state},runtime:{sources:()=>f.sources},product:f.product,runtimeDirectory:f.dir,chainFactory:()=>{throw Error('must not replay');}});
    assert.equal(f.store.getRecord('native_product_run_v1','interrupted').status,'UNKNOWN_HOLD');
    assert.equal((await f.api(f.base,{request_id:randomUUID(),consent:true,limits:{max_generation_requests:4}})).body.code,'NATIVE_LIBRARY_UNKNOWN_HOLD');
    await recovered.close();
  }finally{await f.close();}
});

test('simplified UNKNOWN graph HTTP reads only committed partial index without controller replay; query stays blocked',async()=>{
 const f=await fixture();try{
  const {createProductDocumentCatalog}=await import('./document-catalog-v1.mjs'),{createNativeExtractionWindowPlan}=await import('./native-extraction-window-plan-v1.mjs'),{createNativeSimplifiedIndex}=await import('./native-simplified-index-v1.mjs'),{createSimplifiedBlockTask,SIMPLIFIED_TOOLS:T}=await import('./native-simplified-extraction-v1.mjs'),{createNativeSourceRetrievalRecords}=await import('./native-build-host-v1.mjs');
  const registered=f.host.register({libraryId:f.libraryId}),snapshotId=registered.snapshot_id,runId='nrun_'+randomUUID().replaceAll('-','');
  const catalog=createProductDocumentCatalog({store:f.store,governance:{baseFor:()=>f.state},runtime:{sources:()=>f.sources}}),snapshot=catalog.get(snapshotId,f.libraryId),cqInput={input_ref:'cq',items:[]},families={input_ref:'cq',families:[]};
  const parentRun=createNativeFullRun({store:f.store,runId,input:{build_flow_policy:'SIMPLIFIED_SOURCE_BLOCK_V1'}}),args={store:f.store,catalog,libraryId:f.libraryId,snapshotId,parentRun,cqInput,families};
  const saved={run_id:runId,library_id:f.libraryId,snapshot_id:snapshotId,input:parentRun.state().input};
  const writer=createNativeSimplifiedIndex({...args,sources:createNativeSourceRetrievalRecords({snapshot}),onCommit:({revision,index,receipt})=>{saved.build={library_knowledge:revision,knowledge:revision.knowledge,...index};saved.incremental_commit=receipt;f.store.putRecord('native_full_chain_state_v1',runId,saved);}});
  const window=createNativeExtractionWindowPlan({snapshot,cqInput,families,windowTokens:8000}).windows[0],local=createSimplifiedBlockTask({...args,window,onSaved:writer.onSaved});
  const result=await local.tools.call(T.SAVE,{entities:[{name:'Maple'}],knowledge:[{kind:'TEXT',text:'Maple retains messages for 3 days.'}]},{invocation_ref:'partial',tool_call_ref:'save'});assert(result.ok);
  const row={run_id:runId,library_id:f.libraryId,snapshot_id:snapshotId,source_epoch:0,build_flow_policy:'SIMPLIFIED_SOURCE_BLOCK_V1',status:'UNKNOWN_HOLD',reason:'NATIVE_REQUEST_INTERRUPTED'};parentRun.stop(row.reason,'UNKNOWN_HOLD');f.store.putRecord('native_product_run_v1',runId,row);
  const callsBefore=structuredClone(f.calls),url=f.base+'/'+runId;
  const graph=await f.api(url+'/graph?view=EXTRACTED_KNOWLEDGE');assert.equal(graph.status,200,JSON.stringify(graph.body));assert.equal(graph.body.partial,true);assert.equal(graph.body.complete,false);assert.equal(graph.body.read_only,true);assert(graph.body.domain_graph.nodes.length>0);
  const status=await f.api(url+'/status');assert.equal(status.status,200);assert.equal(status.body.snapshot.build.library_knowledge.revision_ref,saved.build.library_knowledge.revision_ref);
  const query=await f.api(url+'/query',{view:'EXTRACTED_KNOWLEDGE',query:'Maple'});assert.equal(query.status,409);assert.equal(query.body.code,'NATIVE_RUN_UNKNOWN_HOLD');assert.deepEqual(f.calls,callsBefore);
  f.sources[0].content+=' changed';f.state.source_epoch++;
  const stale=await f.api(url+'/graph?view=EXTRACTED_KNOWLEDGE');assert.equal(stale.status,409);assert.equal(stale.body.code,'NATIVE_SOURCE_STALE');
 }finally{await f.close();}
});

test('HTTP CQ-only start wires the real stop and forces lexical with zero embedding budget',async()=>{
 const options=[],f=await fixture({chainFactory:args=>{options.push(args);return {async run(){},snapshot(){return {run:{status:'SUCCEEDED'}};}};}});
 try{await f.register();f.models(configured());const r=await f.api(f.base,{request_id:randomUUID(),consent:true,stop_after:'CQ',limits:{max_generation_requests:3,max_embedding_batches:0}});
  assert.equal(r.status,202);await f.host.whenIdle();assert.equal(options[0].stopAfter,'CQ');assert.equal(options[0].buildFlowPolicy,undefined);assert(options[0].cqChunkOptions.documentStorage);
  assert.equal(r.body.stop_after,'CQ');assert.equal((await f.api(f.base+'/'+r.body.run_id)).body.capability,'LEXICAL');
 }finally{await f.close();}
});

test('HTTP frozen CQ material readback is read-only and validates exact CQ selector',async()=>{
 const libraryId='kb_'+randomUUID(),runId='nrun_'+'a'.repeat(32),cqRef='native_cq_'+'b'.repeat(64);let read=0;
 const handle=createNativeFullChainHttp({host:{cqMaterials:args=>{read++;assert.equal(args.cqRef,cqRef);return {text:'frozen material'};}},json:(res,status,body)=>Object.assign(res,{status,body}),parseBody:()=>assert.fail('GET')});
 const pathname='/api/product/libraries/'+libraryId+'/native-full-chain/runs/'+runId+'/cq-materials',res={};
 assert(await handle({req:{method:'GET',url:pathname+'?cq_ref='+cqRef},res,pathname}));assert.equal(res.body.text,'frozen material');assert.equal(read,1);
 await assert.rejects(handle({req:{method:'GET',url:pathname+'?cq_ref=U001'},res:{},pathname}),/NATIVE_CQ_REF_INVALID/);assert.equal(read,1);
});
