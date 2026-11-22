import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from './store.mjs';
import {createDocumentCatalog} from './document-catalog-v1.mjs';
import {createNativeFullRun} from './native-full-run-v1.mjs';
import {createNativeFullChain} from './native-full-chain-v1.mjs';

function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'native-semantic-policy-'));
  const store=createStore(directory),libraryId='generic-library';
  const material={source_epoch:1,sources:[{id:'manual',title:'装置说明',content:'装置甲使用部件乙。'}]};
  const catalog=createDocumentCatalog({store,loadLibrary:()=>material});
  const source=catalog.freeze(libraryId,1);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,store,catalog,source,options:{store,catalog,libraryId,snapshotId:source.snapshot_id,runId:'semantic-run'}};
}

test('a fresh product chain passes its domain policy to the build host without adding a discovery gate',t=>{
  const f=fixture(t),chain=createNativeFullChain(f.options);
  const state=f.store.getRecord('native_full_chain_state_v1',f.options.runId);
  assert.equal(state.input.semantic_policy,'DOMAIN_KNOWLEDGE_V1');
  const familyInput={input_ref:'family-input',items:[{cq_ref:'question',question:'装置如何组成？'}]};
  f.store.putRecord('native_full_chain_state_v1',f.options.runId,{...state,family_input:familyInput,families:{input_ref:familyInput.input_ref,families:[]}});
  const snapshot=chain.snapshot();
  assert.equal(snapshot.build.semantic_policy,'DOMAIN_KNOWLEDGE_V1');
  assert.equal(snapshot.build.scope.tasks.length,0);
  assert.equal(snapshot.build.knowledge.length,0);
});

test('reopening an old stopped extraction keeps its input and ledger unchanged and sends no request',async t=>{
  const f=fixture(t),historical=createNativeFullChain({...f.options,semanticPolicy:null});
  const state=f.store.getRecord('native_full_chain_state_v1',f.options.runId);
  assert.equal(Object.hasOwn(state.input,'semantic_policy'),false);
  const parent=createNativeFullRun({store:f.store,runId:f.options.runId,input:state.input,limits:state.limits});
  parent.stop('OFFLINE_HISTORICAL_FAILURE','FAILED');
  f.store.putRecord('native_full_chain_state_v1',f.options.runId,{...state,execution_started:true});
  const before=f.store.getRecord('native_full_chain_state_v1',f.options.runId),ledger=parent.state();
  let calls=0;const deny=async()=>{calls++;throw Error('No external request is allowed.');};
  const reopened=createNativeFullChain({...f.options,agentRunner:deny});
  assert.deepEqual(reopened.snapshot().input,historical.snapshot().input);
  const result=await reopened.run({runtimeDirectory:join(f.directory,'no-replay'),upstream:deny,capability:'LEXICAL'});
  assert.equal(result.execution_outcome,'NO_AUTOMATIC_REPLAY');
  assert.equal(calls,0);
  assert.deepEqual(f.store.getRecord('native_full_chain_state_v1',f.options.runId),before);
  assert.deepEqual(parent.state(),ledger);
});

test('CQ-only production chain stops before family, extraction and embedding and preserves frozen ranges',async t=>{
 const f=fixture(t),{createHash}=await import('node:crypto'),{hash}=await import('./cq-discovery-store-v2.mjs');
 const {readNativeCQMaterials}=await import('./native-chunked-cq-v1.mjs');let calls=0,factoryCalls=0;
 const chain=createNativeFullChain({...f.options,stopAfter:'CQ',cqChunkOptions:{documentStorage:f.directory},limits:{max_generation_requests:1,max_embedding_batches:0,max_wall_ms:60000},
  chunkPlanFactory:async({snapshot,maxTokens})=>{factoryCalls++;assert.equal(maxTokens,5000);const d=snapshot.documents[0],text='[U001] '+d.content;
   const c={chunk_ref:'block',plan_ref:'frozen-plan',manifest_ref:'manifest',doc_ref:d.doc_id,revision:d.revision,headings:[],source_items:[],source_block_refs:[],contextualized_text:text,text,token_count:20,
    units:[{label:'U001',ordinal:0,unit_ref:'unit',text:d.content,text_sha256:createHash('sha256').update(d.content).digest('hex'),context:'装置说明',source_items:[],fragment:'whole'}]};
   return {plan_ref:'frozen-plan',source_snapshot_ref:snapshot.snapshot_id,source_fingerprint:snapshot.fingerprint,policy:{engine:'DoclingHybridChunker',max_tokens:5000,tokenizer:'cl100k_base',range_contract:'CQ_UNIT_RANGES_V1'},chunks:[c],windows:[c],gaps:[],coverage:[],warnings:[]};
  },agentRunner:async args=>{calls++;assert.equal(args.role,'CQ');assert(args.skillPaths[0].endsWith('/lightog-cq-discovery-product-v1/SKILL.md'));
   const req=args.run.reserve({kind:'GENERATION',role:'CQ',agentScope:args.agentScope});args.run.settle(req.request_ref,{outcome:'RETURNED'});
   assert.equal((await args.tools.call('lightog_save_cq_list',{items:[{question:'装置甲使用哪些部件？',ranges:[{start:'U001',end:'U001'}]}]})).ok,true);
   return {receipt:{status:'SUCCEEDED',outcome:'RETURNED'}};
  },embed:()=>assert.fail('CQ-only must not embed')});
 const result=await chain.run({runtimeDirectory:join(f.directory,'cq-only'),upstream:()=>assert.fail('offline'),capability:'LEXICAL'});
 assert.equal(result.run.status,'SUCCEEDED');assert.equal(result.run.summary.completion_scope,'CQ_ONLY');assert.equal(calls,1);assert.equal(factoryCalls,1);assert.equal(result.build,null);assert.equal(result.family_input,null);
 assert.equal(result.run.attempts.length,1);assert(!result.run.checkpoints.some(c=>c.stage==='FAMILIES_SAVED'));
 const q=result.cq_input.items[0];assert(readNativeCQMaterials({store:f.store,runId:f.options.runId,cqRef:q.cq_ref}).text.includes('装置甲使用部件乙'));
 assert.equal((await chain.run()).execution_outcome,'NO_AUTOMATIC_REPLAY');assert.equal(calls,1);
});

test('v2 CQ ledger admits four distinct block requests and rejects a fifth or duplicate scope',t=>{
 const f=fixture(t),p=createNativeFullRun({store:f.store,runId:'cq-parallel',input:{cq_chunk_policy:{version:'DOCLING_STRUCTURE_CQ_V2',concurrency:4}},limits:{max_generation_requests:8,max_wall_ms:60000}});
 const requests=Array.from({length:4},(_,i)=>p.reserve({kind:'GENERATION',role:'CQ',agentScope:'block-'+i}));
 assert.throws(()=>p.reserve({kind:'GENERATION',role:'CQ',agentScope:'block-4'}),/PARALLEL_LIMIT/);
 assert.throws(()=>p.reserve({kind:'GENERATION',role:'CQ',agentScope:'block-0'}),/CONCURRENT_REQUEST_FORBIDDEN/);
 for(const r of requests)p.settle(r.request_ref,{outcome:'RETURNED'});
 assert.equal(p.state().attempts.length,4);
});
