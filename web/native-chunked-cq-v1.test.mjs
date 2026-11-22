import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {resolveCQUnitRanges,loadCQRangeMaterials,canAggregateCQ,aggregateCQRangeItems} from './native-cq-ranges-v1.mjs';
import {readNativeCQMaterials} from './native-chunked-cq-v1.mjs';
import {createStore} from './store.mjs';
import {hash} from './cq-discovery-store-v2.mjs';
import {createDocumentCatalog} from './document-catalog-v1.mjs';
import {createNativeFullRun} from './native-full-run-v1.mjs';
import {createNativeFamilyInput} from './native-family-input-adapter-v1.mjs';
import {runNativeChunkedCQ,snapshotNativeChunkedCQ,NATIVE_CHUNKED_CQ_RECORDS as K} from './native-chunked-cq-v1.mjs';
import {createNativeAgentTransport} from './native-agent-runtime-v1.mjs';
import {sseResponse,mockHttpResponse} from '../fixtures/cq-discovery-v1/mock-responses-v1.mjs';

const context=prompt=>prompt.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}).find(value=>value.chunk_material||value.drafts);
const pause=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,{count=2,maxRequests=30}={}){
 const directory=mkdtempSync(join(tmpdir(),'native-chunked-cq-')),store=createStore(directory);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const library={source_epoch:1,sources:Array.from({length:count},(_,i)=>({id:'doc_'+i,title:'业务资料'+i,format:'markdown',content:'# 模块'+i+'\n\n对象'+i+'的续航为8小时；低温为6小时。此规则待评审。正文标记'+i+'。'}))};
 const catalog=createDocumentCatalog({store,loadLibrary:()=>library}),snapshot=catalog.freeze('library',1);
 const plan={version:'docling-hybrid-chunks/1',plan_ref:'hybrid_plan_'+hash(snapshot),source_snapshot_ref:snapshot.snapshot_id,
  policy:{engine:'DoclingHybridChunker',max_tokens:8000,tokenizer:'cl100k_base'},gaps:[],coverage:[],chunks:snapshot.documents.map((doc,index)=>({
   chunk_ref:'hybrid_chunk_'+hash([snapshot.snapshot_id,doc.doc_id]),doc_ref:doc.doc_id,revision:doc.revision,text:doc.content,contextualized_text:doc.content,token_count:40,
   headings:['模块'+index],source_items:[{self_ref:'paragraph_'+index}],source_block_refs:doc.blocks.map(b=>b.block_id),warnings:[]}))};
 const input={cq_chunk_policy:{version:'DOCLING_HYBRID_CQ_V1',concurrency:4}};
 const parent=createNativeFullRun({store,runId:'cq_run',input,limits:{max_generation_requests:maxRequests,max_wall_ms:60000}});
 const options=agentRunner=>({store,catalog,libraryId:'library',snapshotId:snapshot.snapshot_id,runId:'cq_run',parentRun:parent,plan,agentRunner,
  runtimeDirectory:join(directory,'runtime'),upstream:()=>assert.fail('no external model'),skillPaths:[],concurrency:4});
 return {directory,store,library,catalog,snapshot,plan,parent,options};
}
function runner(f,{chunk,merge,before=async()=>{},track={}}={}){
 track.contexts??=[];track.scopes??=[];track.calls??=0;track.peak??=0;track.active??=0;
 return async args=>{
  const body=context(args.prompt);assert(body,'native prompt must contain actual material/drafts');track.contexts.push(body);track.scopes.push(args.agentScope);track.calls++;
  const request=args.run.reserve({kind:'GENERATION',role:args.role,agentScope:args.agentScope,requestBytes:args.prompt.length});
  track.active++;track.peak=Math.max(track.peak,track.active);await before(args,body);await pause();
  args.run.settle(request.request_ref,{outcome:'RETURNED'});
  const proposal=body.chunk_material?(chunk?chunk(body,args):{items:[{question:body.chunk_material.title+'的续航规则是什么？',notes:'待评审；区分常温与低温。'}]}):
   (merge?merge(body,args):{items:body.drafts.map(d=>({question:d.question,notes:d.notes,source_draft_refs:[d.draft_ref]}))});
  const saved=await args.tools.call('lightog_save_cq_list',proposal,{invocation_ref:'scripted_'+args.agentScope,tool_call_ref:'save'});
  assert.equal(saved.ok,true,JSON.stringify(saved));assert.equal(args.tools.isComplete(),true);track.active--;
  return {receipt:{invocation_ref:'scripted_'+args.agentScope,role:'CQ',status:'SUCCEEDED',outcome:'RETURNED',origin:'SCRIPTED_OFFLINE_RUNTIME',request_refs:[request.request_ref]}};
 };
}

test('native chunk workers isolate text, bind Host provenance and produce existing family-compatible input',async t=>{
 const f=fixture(t,{count:6}),track={},invocations=[];
 const result=await runNativeChunkedCQ({...f.options(runner(f,{track})),onInvocation:value=>invocations.push(value)});
 assert.equal(result.scan_status,'COMPLETE');assert.equal(result.cq_input.items.length,6);assert.equal(result.summary.semantic_completeness_certified,false);
 assert.equal(track.peak,4);assert.equal(new Set(track.scopes).size,7);assert.equal(invocations.length,7);
 assert.equal(f.parent.state().attempts.length,7);assert(f.parent.state().attempts.every(a=>a.role==='CQ'&&a.outcome==='RETURNED'));
 for(const body of track.contexts.filter(b=>b.chunk_material)){
  assert.equal(body.chunk_material.text.match(/正文标记\d/g).length,1);
  assert.equal(Object.hasOwn(body.chunk_material,'revision'),false);
 }
 const mergeBody=track.contexts.find(b=>b.drafts);assert.equal(mergeBody.drafts.length,6);assert.equal(JSON.stringify(mergeBody).includes('正文标记'),false);
 for(const item of result.cq_input.items){
  assert.equal(item.source_refs.length,1);assert.equal(item.read_receipt_refs.length,1);assert.equal(item.source_status,'KNOWN');
  assert.equal(item.notes,'待评审；区分常温与低温。');const read=f.store.getRecord(K.read,item.read_receipt_refs[0]);assert(read);assert.equal(read.semantic_reading_certified,false);
  const chunk=f.plan.chunks.find(c=>c.doc_ref===item.source_refs[0].doc_ref);assert.equal(read.material_sha256,hash(chunk.contextualized_text));
 }
 const family=createNativeFamilyInput({runId:'cq_run',sourceSnapshotRef:f.snapshot.snapshot_id,inputs:[result.cq_input]});assert.equal(family.items.length,6);
 const saved=snapshotNativeChunkedCQ({store:f.store,runId:'cq_run'});assert.equal(saved.status,'COMPLETED');assert.equal(saved.chunks.length,6);assert.equal(saved.merge.mapping.length,6);
 const again=await runNativeChunkedCQ({...f.options(()=>assert.fail('no replay'))});assert.equal(again.execution_outcome,'NO_AUTOMATIC_REPLAY');assert.deepEqual(again.cq_input,result.cq_input);
});

test('merge can combine duplicate goals across chunks while retaining both source and draft mappings',async t=>{
 const f=fixture(t),result=await runNativeChunkedCQ(f.options(runner(f,{chunk:()=>({items:[{question:'试点版的续航规则是什么？',notes:'常温及低温分别处理，待评审。'}]}),
  merge:body=>({items:[{question:'各对象试点版的续航规则是什么？',notes:'常温及低温分别处理，待评审。',source_draft_refs:body.drafts.map(d=>d.draft_ref)}]})})));
 assert.equal(result.summary.chunk_drafts,2);assert.equal(result.cq_input.items.length,1);assert.equal(result.cq_input.items[0].source_refs.length,2);assert.equal(result.cq_input.items[0].read_receipt_refs.length,2);
 const state=snapshotNativeChunkedCQ({store:f.store,runId:'cq_run'});assert.equal(state.merge.mapping[0].source_draft_refs.length,2);assert.equal(state.chunks[0].draft.items.length,1);
 assert.equal(state.chunks[0].draft.raw_proposal.items[0].question,'试点版的续航规则是什么？');
});

test('bad individual proposals warn or skip; foreign metadata cannot override Host chunk source',async t=>{
 const f=fixture(t),result=await runNativeChunkedCQ(f.options(runner(f,{chunk:()=>({items:[{},null,{question:'   '},{question:'试点版续航如何计算？',notes:'',source_refs:[{doc_ref:'foreign'}],revision:'forged'}]})})));
 assert.equal(result.cq_input.items.length,1);assert.equal(result.summary.chunk_warnings,12);
 const state=snapshotNativeChunkedCQ({store:f.store,runId:'cq_run'});
 for(const row of state.chunks){assert.equal(row.draft.processing_summary.skipped,3);assert(row.draft.warnings.some(w=>w.code==='CQ_EXTRA_FIELD_IGNORED'));}
 assert(result.cq_input.items.every(q=>q.source_refs.every(s=>s.doc_ref!=='foreign')&&!Object.hasOwn(q,'notes')));
});

test('global merge omissions preserve original needs and unmatched merge decisions do not invent new CQ',async t=>{
 const f=fixture(t),result=await runNativeChunkedCQ(f.options(runner(f,{merge:body=>({items:[{question:body.drafts[0].question,source_draft_refs:[body.drafts[0].draft_ref]},
  {question:'无法对应的新增问题？',source_draft_refs:['invented_draft']}]})})));
 assert.equal(result.cq_input.items.length,2);assert.equal(result.cq_input.items.filter(q=>q.source_status==='UNKNOWN').length,0);
 const state=snapshotNativeChunkedCQ({store:f.store,runId:'cq_run'});assert.equal(state.merge.processing_summary.preserved_unreferenced,1);
 assert(state.merge.warnings.some(w=>w.code==='CQ_MERGE_DRAFT_UNKNOWN'));assert(state.merge.mapping.some(m=>m.action==='HOST_PRESERVED_UNREFERENCED_DRAFT'));
 createNativeFamilyInput({runId:'cq_run',sourceSnapshotRef:f.snapshot.snapshot_id,inputs:[result.cq_input]});
});

test('generation minimum budget and source staleness stop before any native dispatch',async t=>{
 const f=fixture(t,{maxRequests:2});let calls=0;
 await assert.rejects(runNativeChunkedCQ(f.options(()=>{calls++;})),/NATIVE_CHUNKED_CQ_MINIMUM_BUDGET/);assert.equal(calls,0);assert.equal(f.parent.state().attempts.length,0);
 const g=fixture(t);g.library.source_epoch++;
 await assert.rejects(runNativeChunkedCQ(g.options(()=>{calls++;})),/NATIVE_SOURCE_STALE/);assert.equal(calls,0);assert.equal(g.parent.state().status,'STALE');
});

test('UNKNOWN stops unstarted chunks, drains and retains independently returned siblings without merging or replay',async t=>{
 const f=fixture(t,{count:6});let count=0,release;
 const barrier=new Promise(resolve=>{release=resolve;});const invoked=[];
 const execute=async args=>{
  const index=f.plan.chunks.findIndex(c=>c.chunk_ref===args.agentScope);assert(index>=0);invoked.push(index);
  const request=args.run.reserve({kind:'GENERATION',role:'CQ',agentScope:args.agentScope});count++;if(count===4)release();await barrier;
  if(index===0){args.run.settle(request.request_ref,{outcome:'UNKNOWN',reason:'NETWORK_RESULT_UNKNOWN'});return {receipt:{status:'UNKNOWN'}};}
  await pause();args.run.settle(request.request_ref,{outcome:'RETURNED'});
  assert.equal((await args.tools.call('lightog_save_cq_list',{items:[{question:'对象'+index+'的续航规则？'}]})).ok,true);
  return {receipt:{status:'FAILED',reason:'PARENT_UNKNOWN_AFTER_KNOWN_RETURN'}};
 };
 await assert.rejects(runNativeChunkedCQ(f.options(execute)),/NETWORK_RESULT_UNKNOWN/);
 assert.deepEqual(invoked.sort(),[0,1,2,3]);assert.equal(f.parent.state().attempts.length,4);assert.equal(f.parent.state().status,'UNKNOWN_HOLD');
 const state=snapshotNativeChunkedCQ({store:f.store,runId:'cq_run'});assert.equal(state.chunks.filter(c=>c.draft).length,3);assert.equal(state.chunks.filter(c=>c.status==='PENDING').length,2);assert.equal(state.merge,null);
 await assert.rejects(runNativeChunkedCQ(f.options(()=>assert.fail('must not replay'))),/NO_AUTOMATIC_REPLAY/);
 assert.equal(f.parent.state().attempts.length,4);
});

test('plan source mismatch is rejected and declared chunk gaps remain partial rather than certified coverage',async t=>{
 const f=fixture(t);f.plan.chunks[0].revision='changed';
 await assert.rejects(runNativeChunkedCQ(f.options(()=>assert.fail('no model'))),/NATIVE_CHUNKED_CQ_CHUNK_INVALID/);
 const g=fixture(t);g.plan.gaps=[{code:'UNRESOLVED_SOURCE_ITEM'}];
 const result=await runNativeChunkedCQ(g.options(runner(g)));assert.equal(result.scan_status,'PARTIAL');assert.equal(result.summary.plan_gaps,1);assert.equal(result.summary.semantic_completeness_certified,false);
});

test('CQ work windows reuse multiple native chunks and keep source-item mapping gaps explicit',async t=>{
 const f=fixture(t,{count:2});
 // Two retained base chunks belong to the first document and are combined into
 // one supplied, already token-counted work window. No custom chunker runs here.
 const first=f.plan.chunks[0];f.plan.chunks=[{...first,chunk_ref:'base_a'},{...first,chunk_ref:'base_b'}];
 f.plan.windows=[{...first,chunk_ref:'cq_window_a',window_ref:'cq_window_a',source_chunk_refs:['base_a','base_b']}];
 f.plan.coverage=[{doc_ref:first.doc_ref,block_id:'unrepresented',status:'UNREPRESENTED'}];
 f.plan.warnings=['HYBRID_CHUNK_SOURCE_ITEMS_UNREPRESENTED'];
 const track={},result=await runNativeChunkedCQ(f.options(runner(f,{track})));
 assert.equal(result.summary.base_chunk_count,2);assert.equal(result.summary.work_window_count,1);assert.equal(result.summary.processed_chunks,2);
 assert.equal(result.scan_status,'PARTIAL');assert.equal(result.summary.plan_gaps,0);assert.equal(result.summary.unrepresented_blocks,1);assert.equal(result.summary.coverage_warnings,1);
 assert.equal(track.calls,1);const read=f.store.getRecord(K.read,result.cq_input.items[0].read_receipt_refs[0]);assert.deepEqual(read.source_chunk_refs,['base_a','base_b']);
 assert.equal(result.summary.coverage_precision,'SOURCE_ITEM_REFERENCE_ONLY_NOT_CHARACTER_OR_SEMANTIC_COVERAGE');
});

test('one window keeps quoted/newline CQ in Host data, exact-dedupes and never calls a merge Agent',async t=>{
 const f=fixture(t,{count:1,maxRequests:1}),track={};
 const question='“集中化管理”与"本地运营"如何协同？\n哪些条件适用？';
 const result=await runNativeChunkedCQ(f.options(runner(f,{track,chunk:()=>({items:[{question},{question},{question,notes:'仅试点版'}]})})));
 assert.equal(track.calls,1);assert.equal(track.contexts.some(body=>body.drafts),false);
 assert.equal(result.cq_input.items.length,2);assert.equal(result.cq_input.items[0].question,question);
 assert.equal(result.summary.merge_mode,'HOST_EXACT_DEDUP');assert.equal(result.summary.merge_semantic_status,'NOT_NEEDED_SINGLE_WINDOW');
 const state=snapshotNativeChunkedCQ({store:f.store,runId:'cq_run'});
 assert.equal(state.merge.mapping[0].source_draft_refs.length,2);assert.equal(state.merge.processing_summary.exact_duplicates,1);
 assert.equal(JSON.parse(JSON.stringify(result.cq_input)).items[0].question,question);
});

test('multi-window merge saves reference decisions without regenerating original question strings',async t=>{
 const f=fixture(t),track={};
 const result=await runNativeChunkedCQ(f.options(runner(f,{track,merge:body=>({items:[{source_draft_refs:[body.drafts[0].draft_ref]}]})})));
 assert.equal(track.calls,3);assert.equal(result.cq_input.items.length,2);
 assert.equal(result.cq_input.items[0].question,'业务资料0的续航规则是什么？');
 assert.equal(result.summary.merge_mode,'AGENT_REFERENCE_DECISIONS');
 assert.equal(result.summary.merge_semantic_status,'AGENT_COMPLETED');
 assert.deepEqual(result.cq_input.items.map(item=>item.source_refs.length),[1,1]);
});

test('unusable returned merge decisions retain all known draft knowledge and mark degraded semantic merge',async t=>{
 const f=fixture(t);
 const result=await runNativeChunkedCQ(f.options(runner(f,{merge:()=>({items:[null,{source_draft_refs:['foreign_draft']}]})})));
 assert.equal(result.cq_input.items.length,2);assert.equal(result.summary.merge_mode,'HOST_DRAFT_FALLBACK');
 assert.equal(result.summary.merge_semantic_status,'NOT_COMPLETED_DRAFTS_RETAINED');
 assert.equal(f.parent.state().status,'RUNNING');assert(f.parent.state().attempts.every(a=>a.outcome==='RETURNED'));
 assert(snapshotNativeChunkedCQ({store:f.store,runId:'cq_run'}).merge.warnings.some(w=>w.reason==='CQ_MERGE_DECISIONS_UNUSABLE'));
});

function malformedToolSSE(){
 const argumentsText='{"items":[{"question":"其"集中化智能管理"如何运作？","source_draft_refs":["draft_0001"]}]}';
 return Buffer.from(sseResponse({name:'mcp__lightog_cq__lightog_save_cq_list',args:{items:[]},index:1}).toString().replaceAll('mcp__lightog_cq','mcp__lightog_native').split('\n\n').filter(Boolean).map(frame=>{
  const lines=frame.split('\n'),at=lines.findIndex(line=>line.startsWith('data: ')),event=JSON.parse(lines[at].slice(6));
  const update=item=>{if(item?.type==='function_call')item.arguments=argumentsText;};
  update(event.item);event.response?.output?.forEach(update);
  if(event.type==='response.function_call_arguments.delta')event.delta=argumentsText;
  if(event.type==='response.function_call_arguments.done')event.arguments=argumentsText;
  lines[at]='data: '+JSON.stringify(event);return lines.join('\n')+'\n\n';
 }).join(''));
}

test('complete malformed SSE merge is archived by real transport and falls back without stopping/reviving parent',async t=>{
 const f=fixture(t),chunkRunner=runner(f),receipts=[];
 const execute=async args=>{
  if(context(args.prompt).chunk_material)return chunkRunner(args);
  const transport=createNativeAgentTransport({store:f.store,run:args.run,role:'CQ',agentScope:args.agentScope,invocationRef:'malformed-merge',maxFormatRepairs:0,
   upstream:async()=>mockHttpResponse(malformedToolSSE())});
  const wire=Buffer.from(JSON.stringify({model:'qwen3.8-flash',stream:true,input:[],tools:[{type:'namespace',name:'mcp__lightog_native',tools:[{type:'function',name:'lightog_save_cq_list'}]}]}));
  await assert.rejects(transport.send(wire),{code:'NATIVE_TOOL_ARGUMENTS_JSON_INVALID'});
  assert.equal(args.run.state().status,'FAILED','only optional merge facade is stopped');
  assert.equal(f.parent.state().status,'RUNNING','real parent was never stopped');
  assert.throws(()=>args.run.reserve({kind:'GENERATION',role:'CQ',agentScope:args.agentScope}),/NATIVE_OPTIONAL_CQ_MERGE_STOPPED/);
  return {receipt:{status:'FAILED',reason:'NATIVE_TOOL_ARGUMENTS_JSON_INVALID',origin:'SCRIPTED_OFFLINE_RUNTIME'}};
 };
 const result=await runNativeChunkedCQ({...f.options(execute),onInvocation:receipt=>receipts.push(receipt)});
 assert.equal(result.cq_input.items.length,2);assert.equal(result.summary.merge_mode,'HOST_DRAFT_FALLBACK');
 assert.equal(result.summary.merge_semantic_status,'NOT_COMPLETED_DRAFTS_RETAINED');
 assert.equal(result.merge_result.agent_outcome,'FAILED');assert.equal(receipts.at(-1).status,'FAILED');
 assert(f.parent.state().attempts.every(attempt=>attempt.outcome==='RETURNED'));
 const failure=f.store.listRecords('native_agent_tool_failure_v1')[0];assert.equal(failure.signal,'NATIVE_TOOL_ARGUMENTS_JSON_INVALID');
 const response=f.store.getRecord('native_agent_response_v1',failure.request_ref);assert.equal(response.complete_body,true);assert.equal(response.redacted,false);
 assert(response.body_utf8.includes('集中化智能管理'));
 const saved=snapshotNativeChunkedCQ({store:f.store,runId:'cq_run'});assert.equal(saved.status,'COMPLETED');
 assert(saved.merge.warnings.some(w=>w.code==='CQ_MERGE_UNAVAILABLE_DRAFTS_RETAINED'));
 const family=f.parent.reserve({kind:'GENERATION',role:'FAMILY'});f.parent.settle(family.request_ref,{outcome:'RETURNED'});
 f.parent.checkpoint('FAMILIES_SAVED',{test:'later stage admitted'});assert.equal(f.parent.state().status,'RUNNING');
});

test('UNKNOWN and non-format failures in optional merge stop the real parent and never fall back',async t=>{
 for(const kind of ['UNKNOWN','PERMISSION']){
  const f=fixture(t),chunkRunner=runner(f);
  const execute=async args=>{
   if(context(args.prompt).chunk_material)return chunkRunner(args);
   const request=args.run.reserve({kind:'GENERATION',role:'CQ',agentScope:args.agentScope});
   if(kind==='UNKNOWN')args.run.settle(request.request_ref,{outcome:'UNKNOWN',reason:'MERGE_NETWORK_UNKNOWN'});
   else{args.run.settle(request.request_ref,{outcome:'RETURNED'});args.run.stop('NATIVE_TOOL_PERMISSION_DENIED','FAILED');}
   return {receipt:{status:'FAILED'}};
  };
  await assert.rejects(runNativeChunkedCQ(f.options(execute)),kind==='UNKNOWN'?/MERGE_NETWORK_UNKNOWN/:/NATIVE_TOOL_PERMISSION_DENIED/);
  assert.equal(f.parent.state().status,kind==='UNKNOWN'?'UNKNOWN_HOLD':'FAILED');
  assert.equal(snapshotNativeChunkedCQ({store:f.store,runId:'cq_run'}).merge,null);
 }
});

test('explicit new run reuses seven retained drafts with zero CQ requests and preserves old run records',async t=>{
 const f=fixture(t,{count:1});
 const questions=Array.from({length:7},(_,i)=>'对象'+i+'的"集中管理"如何运作？\n哪些条件适用？');
 await runNativeChunkedCQ(f.options(runner(f,{chunk:()=>({items:questions.map(question=>({question}))})})));
 f.parent.stop('NATIVE_TOOL_ARGUMENTS_JSON_INVALID','FAILED');
 const oldState=snapshotNativeChunkedCQ({store:f.store,runId:'cq_run'}),oldLedgerHash=hash(f.parent.state()),oldSnapshotHash=hash(oldState);
 const next=createNativeFullRun({store:f.store,runId:'new_cq_run',input:{cq_chunk_policy:{version:'DOCLING_HYBRID_CQ_V1',concurrency:4}},limits:{max_generation_requests:0,max_wall_ms:60000}});
 const confirmedDrafts={upstream_run_id:'cq_run',source_snapshot_ref:f.snapshot.snapshot_id,hybrid_plan:f.plan,drafts:oldState.chunks.map(chunk=>({chunk_ref:chunk.chunk_ref,draft:chunk.draft}))};
 const result=await runNativeChunkedCQ({...f.options(()=>assert.fail('retained single window must not call model')),runId:'new_cq_run',parentRun:next,confirmedDrafts});
 assert.deepEqual(result.cq_input.items.map(item=>item.question),questions);assert.equal(next.state().attempts.length,0);
 assert.equal(hash(f.parent.state()),oldLedgerHash);assert.equal(hash(snapshotNativeChunkedCQ({store:f.store,runId:'cq_run'})),oldSnapshotHash);
 assert.equal(result.summary.reused_drafts_from_run_id,'cq_run');assert.equal(result.summary.reused_chunk_drafts,1);
 const current=snapshotNativeChunkedCQ({store:f.store,runId:'new_cq_run'});assert.equal(current.chunks[0].draft.reuse_origin.run_id,'cq_run');
 for(const item of result.cq_input.items){
  const read=f.store.getRecord(K.read,item.read_receipt_refs[0]);assert.equal(read.run_id,'new_cq_run');assert.equal(read.delivery,'HOST_REUSED_RETAINED_CQ_DRAFT');
  assert.equal(read.origin_read_receipt_ref,oldState.chunks[0].draft.read_receipt_ref);
 }
});

for(const scope of ['chunk','merge'])test('CQ '+scope+' duplicate and differing concurrent saves preserve first durable result and drain all calls',async t=>{
 const f=fixture(t,{count:scope==='chunk'?1:2});let checked=0;
 const execute=runner(f,{before:async(args,body)=>{
  if(Boolean(body.chunk_material)!==(scope==='chunk'))return;
  checked++;const proposal=body.chunk_material?{items:[{question:'已确认的原问题？',notes:'仅低温'}]}:{items:body.drafts.map(d=>({question:d.question,notes:d.notes,source_draft_refs:[d.draft_ref]}))};
  const different={items:[{question:'迟到的不同稿？'}]},first=await args.tools.call('lightog_save_cq_list',proposal,{tool_call_ref:'first'}),[same,late]=await Promise.all([args.tools.call('lightog_save_cq_list',proposal,{tool_call_ref:'duplicate'}),args.tools.call('lightog_save_cq_list',different,{tool_call_ref:'late'})]);
  assert.deepEqual(same,first);assert.equal(late.result.accepted,false);assert.equal(args.tools.isComplete(),true);
  // runner submits one more different proposal after this; it must stay a
  // protocol receipt rather than invalidating the accepted business save.
 }});
 const result=await runNativeChunkedCQ(f.options(execute));assert.equal(checked,1);assert(result.cq_input.items.length>0);assert.equal(f.parent.state().status,'RUNNING');
 const history=f.store.listRecords('native_agent_save_finish_v1').flatMap(s=>s.diagnostics);assert(history.some(d=>d.args.items?.[0]?.question==='迟到的不同稿？'));assert(!history.some(d=>d.reason==='NATIVE_CHUNKED_CQ_ALREADY_SAVED'));
});

for(const scope of ['chunk','merge'])test('CQ '+scope+' reconciles a crash after durable save before receipt persistence without rewriting CQ',async t=>{
 const f=fixture(t,{count:scope==='chunk'?1:2});let interrupted=0;
 const original=f.store.putRecord;const execute=runner(f,{before:async(args,body)=>{
  if(Boolean(body.chunk_material)!==(scope==='chunk'))return;
  const proposal=body.chunk_material?{items:[{question:'保存后中断仍保留？'}]}:{items:body.drafts.map(d=>({question:d.question,source_draft_refs:[d.draft_ref]}))};
  let armed=true;f.store.putRecord=(kind,id,value)=>{if(armed&&kind==='native_agent_save_finish_v1'&&value.status==='COMMITTED'){armed=false;interrupted++;throw Object.assign(Error('SIMULATED_RECEIPT_CRASH'),{code:'SIMULATED_RECEIPT_CRASH'});}return original(kind,id,value);};
  try{await assert.rejects(args.tools.call('lightog_save_cq_list',proposal),{code:'SIMULATED_RECEIPT_CRASH'});}finally{f.store.putRecord=original;}
  const before=hash(f.store.listRecords(scope==='chunk'?K.draft:K.merge));const receipt=await args.tools.call('lightog_save_cq_list',proposal,{tool_call_ref:'recovered'});assert.equal(receipt.result.saved,true);assert.equal(hash(f.store.listRecords(scope==='chunk'?K.draft:K.merge)),before);
 }});await runNativeChunkedCQ(f.options(execute));assert.equal(interrupted,1);
});

test('CQ save before commit fails normally; changed source after commit still rejects duplicate receipt',async t=>{
 const f=fixture(t,{count:1});let checked=false;
 await assert.rejects(runNativeChunkedCQ(f.options(async args=>{
  const req=args.run.reserve({kind:'GENERATION',role:'CQ',agentScope:args.agentScope});args.run.settle(req.request_ref,{outcome:'RETURNED'});
  const original=f.store.putRecord;f.store.putRecord=(kind,id,value)=>{if(kind===K.draft)throw Object.assign(Error('BEFORE_SAVE_FAILED'),{code:'BEFORE_SAVE_FAILED'});return original(kind,id,value);};
  try{await assert.rejects(args.tools.call('lightog_save_cq_list',{items:[{question:'未保存'}]}),{code:'BEFORE_SAVE_FAILED'});}finally{f.store.putRecord=original;}
  assert.equal(args.tools.isComplete(),false);assert.equal(f.store.listRecords(K.draft).length,0);checked=true;return {receipt:{status:'FAILED',reason:'BEFORE_SAVE_FAILED'}};
 })));assert(checked);
 const g=fixture(t,{count:1});await assert.rejects(runNativeChunkedCQ(g.options(async args=>{const req=args.run.reserve({kind:'GENERATION',role:'CQ',agentScope:args.agentScope});args.run.settle(req.request_ref,{outcome:'RETURNED'});const proposal={items:[{question:'原问题'}]};await args.tools.call('lightog_save_cq_list',proposal);g.library.sources[0].content+='资料变更';await assert.rejects(args.tools.call('lightog_save_cq_list',proposal),{code:'NATIVE_SOURCE_STALE'});return {receipt:{status:'FAILED',reason:'NATIVE_SOURCE_STALE'}};})));
});

function preciseFixture(t,options={}){
 const f=fixture(t,options);f.plan.version='docling-structure-blocks/2';f.plan.policy={...f.plan.policy,max_tokens:5000,range_contract:'CQ_UNIT_RANGES_V1'};
 f.plan.chunks=f.plan.chunks.map(c=>({...c,plan_ref:f.plan.plan_ref,manifest_ref:'manifest_'+c.chunk_ref,units:Array.from({length:4},(_,i)=>{
  const text='正文'+i+' '+c.text;return {label:'U00'+(i+1),ordinal:i,text,context:'标题与单位',unit_ref:c.chunk_ref+'_unit_'+i,text_sha256:createHash('sha256').update(text).digest('hex'),source_items:c.source_items,fragment:'part-'+i};})}));
 return f;
}

test('v2 ranges merge overlaps, retain disjoint units, recover context and reject frozen version changes',t=>{
 const f=preciseFixture(t),c=f.plan.chunks[0],located=resolveCQUnitRanges(c,[{start:'U001',end:'U002'},{start:'U002',end:'U002'},{start:'U004',end:'U004'}]);
 assert.equal(located.range_status,'UNIT_RANGES');assert.equal(located.ranges.length,2);
 const loaded=loadCQRangeMaterials({plan:f.plan,item:located});assert.deepEqual(loaded.units.map(u=>u.label),['U001','U002','U004']);assert(loaded.text.includes('标题与单位'));
 for(const field of ['revision','doc_ref','manifest_ref','chunk_ref','plan_ref']){const bad=structuredClone(located);bad.ranges[0][field]='foreign';assert.throws(()=>loadCQRangeMaterials({plan:f.plan,item:bad}),/SOURCE_MISMATCH/);}
 const altered=structuredClone(f.plan);altered.chunks[0].units[0].text+='changed';assert.throws(()=>loadCQRangeMaterials({plan:altered,item:located}),/UNIT_MISMATCH/);
 for(const ranges of [null,[],[{start:'U004',end:'U001'}],[{start:'U999',end:'U999'}],[{start:'U001',end:'U001',doc_ref:'foreign'}]]){
  const bad=resolveCQUnitRanges(c,ranges);assert.equal(bad.range_status,'BLOCK_FALLBACK');assert.equal(loadCQRangeMaterials({plan:f.plan,item:bad}).units.length,4);
 }
 const partial=resolveCQUnitRanges(c,[{start:'U002',end:'U003'},{start:'U999',end:'U999'}]);assert.equal(partial.range_status,'PARTIAL_BLOCK_FALLBACK');assert.equal(partial.ranges.length,1);
 assert.equal(loadCQRangeMaterials({plan:f.plan,item:partial}).units.length,4);
});

for(const count of [0,1,5,7])test('v2 '+count+' questions save, read back and never dispatch model aggregation',async t=>{
 const f=preciseFixture(t,{count:2}),track={};
 const result=await runNativeChunkedCQ(f.options(runner(f,{track,chunk:()=>({items:Array.from({length:count},(_,i)=>({question:'问题'+i,ranges:[{start:'U001',end:'U002'}]}))})})));
 assert.equal(track.calls,2);assert.equal(result.cq_input.items.length,Math.min(count,5)*2);assert.equal(result.summary.merge_mode,'HOST_CONSERVATIVE_RANGE_DEDUP_V1');
 const state=snapshotNativeChunkedCQ({store:f.store,runId:'cq_run'});assert.equal(state.chunks[0].draft.raw_proposal.items.length,count);
 for(const q of result.cq_input.items){const loaded=readNativeCQMaterials({store:f.store,runId:'cq_run',cqRef:q.cq_ref});assert.equal(loaded.units.length,2);assert.equal(q.local_questions.length,1);}
 if(count>5)assert(state.chunks[0].draft.warnings.some(w=>w.code==='CQ_OVER_FIVE_TRUNCATED'));
 const family=createNativeFamilyInput({runId:'cq_run',sourceSnapshotRef:f.snapshot.snapshot_id,inputs:[result.cq_input]});assert(family.items.every(q=>q.ranges.length===1&&q.local_questions.length===1));
});

test('v2 partial damage retains valid questions and malformed whole responses never commit empty CQ',async t=>{
 const f=preciseFixture(t,{count:1});let damaged=false;
 const result=await runNativeChunkedCQ(f.options(runner(f,{before:async args=>{
  for(const proposal of [{},null,{items:[null,{}]}]){const response=await args.tools.call('lightog_save_cq_list',proposal);assert.equal(response.ok,false);assert.equal(args.tools.isComplete(),false);}damaged=true;
 },chunk:()=>({items:[null,{question:'正常范围',ranges:[{start:'U001',end:'U001'}]},{question:'坏范围保留',ranges:[{start:'foreign',end:'U003'}]}]})})));
 assert(damaged);assert.equal(result.cq_input.items.length,2);assert.equal(result.cq_input.items[1].range_status,'BLOCK_FALLBACK_PRESENT');
 assert.equal(readNativeCQMaterials({store:f.store,runId:'cq_run',cqRef:result.cq_input.items[1].cq_ref}).units.length,4);
});

test('v2 conservative aggregation requires normalized equal questions and actual intersecting source/context',t=>{
 const f=preciseFixture(t),c=f.plan.chunks[0],d=f.plan.chunks[1];
 const a={cq_ref:'a',question:'对象A  的规则？',...resolveCQUnitRanges(c,[{start:'U001',end:'U002'}])};
 const b={cq_ref:'b',question:'对象A 的规则？',...resolveCQUnitRanges(c,[{start:'U002',end:'U003'}])};
 assert(canAggregateCQ(a,b));assert(!canAggregateCQ(a,{...b,question:'对象B 的规则？'}));assert(!canAggregateCQ(a,{...b,...resolveCQUnitRanges(d,[{start:'U001',end:'U002'}])}));
 assert(!canAggregateCQ(a,{...b,question:'对象A 的规则是什么？'}));
 const combined=aggregateCQRangeItems([a,b]);assert.equal(combined.local_questions.length,2);assert.equal(loadCQRangeMaterials({plan:f.plan,item:combined}).units.length,3);
 // Explicit multi-source aggregation supports complete identities without forcing discovery.
 const multi=aggregateCQRangeItems([a,{...b,...resolveCQUnitRanges(d,[{start:'U001',end:'U002'}])}]);assert.equal(loadCQRangeMaterials({plan:f.plan,item:multi}).units.length,4);
});

test('v2 duplicate, concurrent and late submissions preserve first durable range result',async t=>{
 const f=preciseFixture(t,{count:1});let checked=0;
 await runNativeChunkedCQ(f.options(runner(f,{before:async args=>{
  const proposal={items:[{question:'首稿',ranges:[{start:'U001',end:'U001'}]}]};
  const first=await args.tools.call('lightog_save_cq_list',proposal);const [same,late]=await Promise.all([args.tools.call('lightog_save_cq_list',proposal),args.tools.call('lightog_save_cq_list',{items:[]})]);
  assert.deepEqual(first,same);assert.equal(late.result.accepted,false);checked++;
 }})));assert.equal(checked,1);assert.equal(f.store.listRecords(K.draft).length,1);
});

test('v2 multiple blocks aggregate only identical selected material and context, preserving both local originals',async t=>{
 for(const conflictingContext of [false,true]){
  const f=preciseFixture(t,{count:2}),a=f.plan.chunks[0],old=f.plan.chunks[1];
  f.plan.chunks[1]={...old,doc_ref:a.doc_ref,revision:a.revision,text:a.text,contextualized_text:a.contextualized_text,
   units:a.units.map((u,i)=>({...u,unit_ref:old.chunk_ref+'_unit_'+i,context:conflictingContext?'不同主体条件':u.context}))};
  const track={},result=await runNativeChunkedCQ(f.options(runner(f,{track,chunk:()=>({items:[{question:'具体对象甲的规则？',ranges:[{start:'U001',end:'U002'}]}]})})));
  assert.equal(track.calls,2);assert.equal(result.cq_input.items.length,conflictingContext?2:1);
  if(!conflictingContext){const q=result.cq_input.items[0];assert.equal(q.local_questions.length,2);assert.equal(q.ranges.length,2);assert.equal(readNativeCQMaterials({store:f.store,runId:'cq_run',cqRef:q.cq_ref}).units.length,4);}
 }
});

test('v2 UNKNOWN drains returned siblings, leaves pending blocks unprocessed and never automatically replays',async t=>{
 const f=preciseFixture(t,{count:6});let started=0,release;const barrier=new Promise(r=>release=r);
 const execute=async args=>{const req=args.run.reserve({kind:'GENERATION',role:'CQ',agentScope:args.agentScope});const index=f.plan.chunks.findIndex(c=>c.chunk_ref===args.agentScope);if(++started===4)release();await barrier;
  if(index===0){args.run.settle(req.request_ref,{outcome:'UNKNOWN',reason:'OFFLINE_UNKNOWN'});return {receipt:{status:'UNKNOWN'}};}
  await pause();args.run.settle(req.request_ref,{outcome:'RETURNED'});await args.tools.call('lightog_save_cq_list',{items:[{question:'保留已返回结果？',ranges:[{start:'U001',end:'U001'}]}]});return {receipt:{status:'SUCCEEDED',outcome:'RETURNED'}};
 };
 await assert.rejects(runNativeChunkedCQ(f.options(execute)),/OFFLINE_UNKNOWN/);
 const state=snapshotNativeChunkedCQ({store:f.store,runId:'cq_run'});assert.equal(state.chunks.filter(c=>c.draft).length,3);assert.equal(state.chunks.filter(c=>c.status==='PENDING').length,2);assert.equal(state.merge,null);
 await assert.rejects(runNativeChunkedCQ(f.options(()=>assert.fail('no replay'))),/NO_AUTOMATIC_REPLAY/);assert.equal(started,4);
});
