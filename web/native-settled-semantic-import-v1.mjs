/** Host-only frozen-source import. Never settles or replays the source run. */
import {execFileSync} from 'node:child_process';
import {readFileSync,statSync,existsSync} from 'node:fs';
import {resolve,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {hash,clone,need,textField} from './cq-discovery-store-v2.mjs';
import {readSemanticPackage,SEMANTIC_RECORDS as S} from './native-semantic-package-v1.mjs';
import {prepareNativeProductConfirmedCQDrafts} from './native-confirmed-cq-drafts-reuse-v1.mjs';
import {createNativeFamilyInput,normalizeNativeFamilyOutput,validateNativeFamilyOutput,materializeNativeFamilyRefs} from './native-family-input-adapter-v1.mjs';
export const SETTLED_SEMANTIC_IMPORT_POLICY='SETTLED_SEMANTIC_IMPORT_V1';
export const SETTLED_SEMANTIC_IMPORT_RECORD='native_settled_semantic_import_v1';
const check=(ok,suffix)=>need(ok,'NATIVE_SETTLED_IMPORT_'+suffix);
const unique=a=>Array.isArray(a)&&new Set(a).size===a.length;
const immutable=(store,kind,id)=>{const value=store.getRecord(kind,id),{record_sha256,...body}=value??{};check(value&&record_sha256===hash(body),'RECORD_CHANGED');return value;};
const fileSha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const terminal=new Set(['READY','SUCCEEDED','PARTIALLY_READY','FAILED','BLOCKED','CANCELLED','STALE','UNKNOWN_HOLD','STOPPED','COMPLETED']);
const sourceKinds=['cq_v2_snapshot','native_product_run_v1','native_full_chain_state_v1','native_full_run_v1','native_chunked_cq_plan_v1','native_chunked_cq_state_v1','native_cq_chunk_merge_v1','native_cq_chunk_draft_v1','native_cq_chunk_read_receipt_v1','native_family_output_normalization_v1','native_full_run_artifact_v1','native_extraction_window_manifest_v1',...Object.values(S),'native_semantic_window_binding_v1','native_agent_invocation_v1','native_agent_delivered_tool_batch_v1','native_agent_argument_normalization_v1'];
const evidenceOnly=new Set(['native_product_run_v1','native_full_chain_state_v1','cq_v2_snapshot']);
const processAlive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
const memory=records=>({getRecord:(kind,id)=>clone(records.find(r=>r.kind===kind&&r.id===id)?.payload??null),listRecords:kind=>records.filter(r=>r.kind===kind).map(r=>clone(r.payload))});
// immutable=1 also avoids SQLite WAL/SHM bookkeeping on the source directory.
// Node's readOnly connection alone does not provide that guarantee.
const immutableRead=String.raw`import sys,json,sqlite3,urllib.parse
path,kinds,run,library,snapshot=sys.argv[1],json.loads(sys.argv[2]),sys.argv[3],sys.argv[4],sys.argv[5]
db=sqlite3.connect('file:'+urllib.parse.quote(path)+'?mode=ro&immutable=1',uri=True)
db.execute('PRAGMA query_only=ON')
query='SELECT kind,id,payload FROM workbench_records WHERE kind IN ('+','.join('?' for _ in kinds)+') AND ((kind=? AND id=?) OR (kind=? AND json_extract(payload,\'$.library_id\')=?) OR json_extract(payload,\'$.run_id\')=? OR json_extract(payload,\'$.binding.run_id\')=?) ORDER BY kind,id'
rows=db.execute(query,(*kinds,'cq_v2_snapshot',snapshot,'native_product_run_v1',library,run,run)).fetchall()
print(json.dumps([{'kind':k,'id':i,'payload':json.loads(p)} for k,i,p in rows],ensure_ascii=False))
db.close()`;
function sourceRecords(pins,sourceRunId,libraryId,snapshotId){
 const all=JSON.parse(execFileSync(process.env.LIGHTOG_IMPORT_PYTHON??'python3',['-c',immutableRead,pins.snapshot.path,JSON.stringify(sourceKinds),sourceRunId,libraryId,snapshotId],{encoding:'utf8',maxBuffer:128*1024*1024}));
 const ledger=all.find(r=>r.kind==='native_full_run_v1'&&r.id===sourceRunId)?.payload;check(ledger,'SOURCE_RUN_MISSING');
 const relevant=new Set(ledger.attempts.filter(a=>['CQ','FAMILY'].includes(a.role)||a.role==='EXTRACTION'&&a.agent_scope?.endsWith(':SEMANTIC')).map(a=>a.request_ref));
 return all.filter(r=>r.kind==='native_agent_invocation_v1'?r.payload.request_refs?.some(ref=>relevant.has(ref)):r.kind==='native_agent_delivered_tool_batch_v1'||r.kind==='native_agent_argument_normalization_v1'?relevant.has(r.payload.request_ref):true);
}
function assertPins(pins){
 for(const pin of [pins.snapshot,pins.stop])check(pin&&isAbsolute(pin.path)&&/^[a-f0-9]{64}$/.test(pin.sha256)&&existsSync(pin.path)&&fileSha(pin.path)===pin.sha256,'SOURCE_FILE_CHANGED');
 const p=pins.snapshot.path;check((statSync(p).mode&0o222)===0,'SOURCE_NOT_READONLY');
 for(const suffix of ['-wal','-journal'])check(!existsSync(p+suffix)||statSync(p+suffix).size===0,'SOURCE_NOT_FROZEN');
}
function validateStop({records,pins,sourceRunId,libraryId}){
 assertPins(pins);const proof=JSON.parse(readFileSync(pins.stop.path,'utf8')),store=memory(records),ledger=store.getRecord('native_full_run_v1',sourceRunId);
 check(unique(records.map(r=>r.kind+'\0'+r.id)),'DUPLICATE_SOURCE_RECORD');
 const source=sourceRecords(pins,sourceRunId,libraryId,ledger?.input?.source_snapshot_ref);
 check(hash(source)===hash(records),'SOURCE_RECORD_CHANGED');
 check(proof.target_run_id===sourceRunId&&proof.snapshot_sha256===pins.snapshot.sha256&&proof.all_owned_processes_stopped===true&&Array.isArray(proof.alive_owned_processes)&&proof.alive_owned_processes.length===0&&Array.isArray(proof.owned_pids)&&proof.owned_pids.length>0&&proof.owned_pids.every(Number.isSafeInteger)&&proof.owned_pids.includes(proof.service_pid)&&proof.signal==='SIGTERM'&&proof.database_records_manually_modified===false&&proof.automatic_replays===0&&Number.isFinite(Date.parse(proof.signalled_at))&&Date.parse(proof.verified_at)>=Date.parse(proof.signalled_at),'STOP_PROOF_INVALID');
 check(proof.owned_pids.every(pid=>pid>0&&!processAlive(pid)),'SOURCE_PROCESS_ALIVE');
 check(ledger&&proof.ledger_status===ledger.status&&proof.attempts===ledger.attempts.length,'STOP_PROOF_CHANGED');
 const unknown=ledger.attempts.filter(a=>a.outcome!=='RETURNED');
 check(hash(unknown.map(a=>a.request_ref).sort())===hash((proof.unconfirmed_requests??[]).map(a=>a.request_ref).sort())&&unknown.every(a=>proof.unconfirmed_requests.some(p=>p.request_ref===a.request_ref&&p.scope===a.agent_scope&&p.role===a.role)),'STOP_SCOPE_CHANGED');
 check(!store.listRecords('native_product_run_v1').some(row=>row.library_id===libraryId&&row.run_id!==sourceRunId&&(!terminal.has(row.status)||row.status==='UNKNOWN_HOLD')),'OTHER_ACTIVE_RUN');
}
function validateEvidence({records,pins,sourceRunId,libraryId,snapshotId,catalog}){
 validateStop({records,pins,sourceRunId,libraryId});const store=memory(records),source=catalog.get(snapshotId,libraryId),frozen=store.getRecord('cq_v2_snapshot',snapshotId);
 check(catalog.isCurrent(snapshotId,libraryId)&&hash(frozen)===hash(source),'SOURCE_CHANGED');
 const prefix=validateSettledHybridPrefix({store,catalog,libraryId,snapshotId,upstreamRunId:sourceRunId}),ledger=store.getRecord('native_full_run_v1',sourceRunId);
 const manifest=immutable(store,'native_extraction_window_manifest_v1',records.find(r=>r.kind==='native_extraction_window_manifest_v1'&&r.payload.run_id===sourceRunId)?.id);
 check(manifest.run_id===sourceRunId&&manifest.manifest.source_snapshot_ref===snapshotId&&manifest.manifest.source_fingerprint===source.fingerprint,'WINDOW_MANIFEST_CHANGED');
 const packages=manifest.manifest.windows.map(window=>{
  const seal=immutable(store,S.SEALED,sourceRunId+'_semantic_'+hash(window.window_ref).slice(0,24)),p=readSemanticPackage({store,catalog,libraryId,snapshotId,packageRef:seal.package_ref});
  check(p.run_id===sourceRunId&&p.window_ref===window.window_ref&&p.window_sha256===hash(window)&&seal.run_id===sourceRunId&&seal.package_sha256===p.record_sha256&&seal.window_sha256===hash(window),'PACKAGE_CHANGED');
  for(const ref of p.proposals){const proposal=immutable(store,S.PROPOSAL,ref.proposal_ref);check(proposal.invocation_ref===p.invocation_ref&&proposal.agent_scope===p.agent_scope,'PROPOSAL_SCOPE_CHANGED');}
  return {window_ref:window.window_ref,window_sha256:hash(window),package_ref:p.package_ref,package_sha256:p.record_sha256};
 });
 const scopes=new Set(manifest.manifest.windows.map(w=>w.window_ref+':SEMANTIC'));
 const included=a=>a.kind==='GENERATION'&&(['CQ','FAMILY'].includes(a.role)||a.role==='EXTRACTION'&&scopes.has(a.agent_scope));
 const attempts=ledger.attempts.filter(included);check(attempts.length>0&&attempts.every(a=>a.outcome==='RETURNED'),'SCOPE_UNSETTLED');
 const excluded=ledger.attempts.filter(a=>!included(a));
 check(excluded.every(a=>a.kind==='GENERATION'&&a.role==='EXTRACTION'&&!scopes.has(a.agent_scope)&&!['CQ','FAMILY'].includes(a.role)),'EXCLUDED_SCOPE_INVALID');
 const actors=store.listRecords('native_agent_invocation_v1'),batches=store.listRecords('native_agent_delivered_tool_batch_v1');
 for(const request of attempts){const batch=batches.filter(b=>b.request_ref===request.request_ref&&b.run_id===sourceRunId),owner=actors.filter(a=>a.request_refs?.includes(request.request_ref));
  check(batch.length===1&&owner.length===1&&owner[0].invocation_ref===batch[0].invocation_ref&&owner[0].agent_scope===request.agent_scope&&owner[0].role===request.role&&owner[0].status==='SUCCEEDED'&&owner[0].outcome==='RETURNED'&&owner[0].ended_at!=null&&owner[0].origin==='CODEX_NATIVE_APP_SERVER'&&batch[0].calls.every(c=>c.status==='COMPLETED'),'TOOL_CHAIN_UNSETTLED');
 }
 const calls=batches.filter(b=>attempts.some(a=>a.request_ref===b.request_ref)).flatMap(b=>b.calls.map(c=>({...c,invocation_ref:b.invocation_ref,request_ref:b.request_ref})));
 for(const p of store.listRecords(S.PROPOSAL)){
  const own=calls.filter(c=>c.tool_call_ref===p.tool_call_ref&&c.invocation_ref===p.invocation_ref);check(own.length===1&&own[0].tool_name==='lightog_save_semantic_statements'&&own[0].arguments_sha256===p.raw_sha256,'PROPOSAL_TOOL_CHAIN_CHANGED');
 }
 for(const p of store.listRecords(S.REJECTED)){
  const {record_sha256,...body}=p;check(record_sha256===hash(body)&&p.raw_sha256===hash(p.raw)&&scopes.has(p.agent_scope),'OPAQUE_RECORD_CHANGED');
  const own=calls.filter(c=>c.tool_call_ref===p.tool_call_ref&&c.invocation_ref===p.invocation_ref);check(own.length===1&&own[0].tool_name===p.tool_name&&own[0].arguments_sha256===p.raw_sha256,'OPAQUE_TOOL_CHAIN_CHANGED');
  for(const ref of p.argument_normalization_refs??[]){const raw=store.getRecord('native_agent_argument_normalization_v1',ref);check(raw&&raw.invocation_ref===p.invocation_ref&&raw.request_ref===own[0].request_ref&&raw.raw_arguments_sha256===hash(raw.raw_arguments)&&raw.normalized_arguments_sha256===hash(raw.normalized_arguments),'OPAQUE_ORIGINAL_MISSING');}
 }
 return {prefix,semantic_packages:{version:'SETTLED_SEMANTIC_IMPORT_PACKAGES_V1',upstream_run_id:sourceRunId,source_snapshot_ref:snapshotId,source_fingerprint:source.fingerprint,cq_family_origin_run_id:sourceRunId,packages},included_requests:attempts.map(a=>a.request_ref),excluded_requests:excluded.map(a=>({request_ref:a.request_ref,scope:a.agent_scope,role:a.role,outcome:a.outcome,replay_allowed:false})),partial_packages:packages.filter(x=>store.getRecord(S.PACKAGE,x.package_ref).partial).map(x=>x.package_ref)};
}
export function createNativeSettledSemanticImportSource({snapshotFile,snapshotSha256,stopVerificationFile,stopVerificationSha256,sourceRunId}){
 const pins={snapshot:{path:resolve(snapshotFile),sha256:snapshotSha256},stop:{path:resolve(stopVerificationFile),sha256:stopVerificationSha256}};
 return {policy:SETTLED_SEMANTIC_IMPORT_POLICY,install({store,catalog,libraryId,snapshotId}){
  assertPins(pins);check(!store.getRecord('native_product_run_v1',sourceRunId),'SOURCE_PRODUCT_ROW_MUST_STAY_SEPARATE');
  const records=sourceRecords(pins,sourceRunId,libraryId,snapshotId);
  const validated=validateEvidence({records,pins,sourceRunId,libraryId,snapshotId,catalog});assertPins(pins);
  const body={policy:SETTLED_SEMANTIC_IMPORT_POLICY,purpose:'FIXED_SEMANTIC_ORGANIZATION_COMPARISON',source_run_id:sourceRunId,library_id:libraryId,source_snapshot_ref:snapshotId,source_fingerprint:catalog.get(snapshotId,libraryId).fingerprint,pins,records,...validated};
  const import_ref='settled_semantic_import_'+hash(body),receipt={...body,import_ref};receipt.record_sha256=hash(receipt);
  store.transaction(()=>{
   for(const r of records.filter(r=>!evidenceOnly.has(r.kind))){const old=store.getRecord(r.kind,r.id);check(!old||hash(old)===hash(r.payload),'TARGET_RECORD_CONFLICT');if(!old)store.putRecord(r.kind,r.id,r.payload);}
   const old=store.getRecord(SETTLED_SEMANTIC_IMPORT_RECORD,import_ref);check(!old||hash(old)===hash(receipt),'RECEIPT_CONFLICT');if(!old)store.putRecord(SETTLED_SEMANTIC_IMPORT_RECORD,import_ref,receipt);
  });
  return readNativeSettledSemanticImport({store,catalog,libraryId,snapshotId,importRef:import_ref});
 }};
}
export function readNativeSettledSemanticImport({store,catalog,libraryId,snapshotId,importRef}){
 check(/^settled_semantic_import_[a-f0-9]{64}$/.test(importRef??''),'REF_INVALID');const receipt=immutable(store,SETTLED_SEMANTIC_IMPORT_RECORD,importRef),{record_sha256,import_ref,...body}=receipt;
 check(import_ref===importRef&&importRef==='settled_semantic_import_'+hash(body)&&body.policy===SETTLED_SEMANTIC_IMPORT_POLICY&&body.purpose==='FIXED_SEMANTIC_ORGANIZATION_COMPARISON'&&body.library_id===libraryId&&body.source_snapshot_ref===snapshotId,'RECEIPT_CHANGED');
 const validated=validateEvidence({records:body.records,pins:body.pins,sourceRunId:body.source_run_id,libraryId,snapshotId,catalog});
 for(const key of Object.keys(validated))check(hash(body[key])===hash(validated[key]),'RECEIPT_CHANGED');
 for(const r of body.records.filter(r=>!evidenceOnly.has(r.kind)))check(hash(store.getRecord(r.kind,r.id))===hash(r.payload),'COPIED_RECORD_CHANGED');
 const expectedActors=body.records.filter(r=>r.kind==='native_agent_invocation_v1').map(r=>r.payload);
 check(store.listRecords('native_agent_invocation_v1').filter(a=>a.run_id===body.source_run_id).every(a=>expectedActors.some(b=>hash(a)===hash(b))),'COPIED_RECORD_CHANGED');
 return {import_ref:importRef,receipt_sha256:record_sha256,source_run_id:body.source_run_id,prefix:{...clone(validated.prefix),import_ref:importRef},semantic_packages:{...clone(validated.semantic_packages),import_ref:importRef},excluded_requests:clone(validated.excluded_requests),partial_packages:clone(validated.partial_packages)};
}

function validateSettledHybridPrefix({store,catalog,libraryId,snapshotId,upstreamRunId}){
 const row=store.getRecord('native_product_run_v1',upstreamRunId),state=store.getRecord('native_full_chain_state_v1',upstreamRunId),ledger=store.getRecord('native_full_run_v1',upstreamRunId);
 check(row?.run_id===upstreamRunId&&row.library_id===libraryId&&row.snapshot_id===snapshotId&&state?.run_id===upstreamRunId&&state.library_id===libraryId&&state.snapshot_id===snapshotId&&ledger?.run_id===upstreamRunId,'SOURCE_MISMATCH');
 check(row.status===ledger.status&&ledger.attempts?.length>0&&unique(ledger.attempts.map(a=>a.request_ref)), 'PARENT_BINDING_CHANGED');
 check(ledger.attempts.filter(a=>['CQ','FAMILY'].includes(a.role)).every(a=>a.kind==='GENERATION'&&a.outcome==='RETURNED'),'SCOPE_UNSETTLED');
 check(catalog.isCurrent(snapshotId,libraryId),'SOURCE_STALE');
 const source=catalog.get(snapshotId,libraryId),input=state.input;
 check(source.documents?.length>0&&source.documents.every(d=>d.parser?.name==='docling'&&d.blocks?.length),'DOCLING_REQUIRED');
 check(input?.knowledge_build_policy==='EXTRACT_AND_INDEX_V1'&&['DOCLING_HYBRID_CQ_V1','DOCLING_STRUCTURE_CQ_V2'].includes(input.cq_chunk_policy?.version)&&hash(input)===hash(ledger.input)&&ledger.binding===hash({input,limits:ledger.limits})&&hash(state.limits)===hash(ledger.limits)&&input.library_ref===libraryId&&input.source_snapshot_ref===snapshotId&&input.source_fingerprint===source.fingerprint&&row.source_epoch===source.source_epoch,'INPUT_CHANGED');
 const cq=state.cq_input,familyInput=state.family_input,families=state.families;
 check(cq?.run_id===upstreamRunId&&cq.source_snapshot_ref===snapshotId&&cq.items?.length>0&&unique(cq.items.map(q=>q.cq_ref))&&families?.families?.length>0&&familyInput?.input_ref===families.input_ref,'OUTPUTS_REQUIRED');
 const sourceRefs=refs=>Array.isArray(refs)&&refs.length>0&&refs.every(r=>source.documents.some(d=>d.doc_id===r.doc_ref&&d.revision===r.revision));
 check(cq.items.every(q=>textField(q.question)&&sourceRefs(q.source_refs)),'CQ_CHANGED');
 const planRecord=immutable(store,'native_chunked_cq_plan_v1',upstreamRunId),plan=planRecord.plan;
 const chunked=store.getRecord('native_chunked_cq_state_v1',upstreamRunId),merge=immutable(store,'native_cq_chunk_merge_v1',upstreamRunId);
 const windows=plan?.windows??plan?.chunks;
 check(planRecord.run_id===upstreamRunId&&planRecord.source_snapshot_ref===snapshotId&&plan?.source_snapshot_ref===snapshotId&&plan.source_fingerprint===source.fingerprint&&Array.isArray(windows)&&windows.length>0&&unique(windows.map(w=>w.chunk_ref))&&windows.every(w=>source.documents.some(d=>d.doc_id===w.doc_ref&&d.revision===w.revision)),'PLAN_CHANGED');
 check(chunked?.run_id===upstreamRunId&&chunked.library_id===libraryId&&chunked.source_snapshot_ref===snapshotId&&chunked.status==='COMPLETED'&&Number.isFinite(chunked.ended_at)&&chunked.plan_ref===plan.plan_ref&&hash(chunked.cq_input)===hash(cq)&&hash(chunked.result?.cq_input)===hash(cq)&&['COMPLETE','PARTIAL'].includes(chunked.scan_status)&&chunked.chunks?.length===windows.length,'CQ_CHANGED');
 check(merge.run_id===upstreamRunId&&merge.source_snapshot_ref===snapshotId&&merge.plan_ref===plan.plan_ref&&hash(merge.cq_input)===hash(cq)&&cq.input_ref==='native_cq_input_'+hash([chunked.binding,merge.mode,merge.raw_proposal]),'MERGE_CHANGED');
 const actors=store.listRecords('native_agent_invocation_v1').filter(a=>a.run_id===upstreamRunId),copies=state.invocations??[];
 const actor=(role,scope=null,ref=null)=>{
  const found=actors.filter(a=>a.role===role&&(scope===null||a.agent_scope===scope)&&(ref===null||a.invocation_ref===ref));
  check(found.length===1,'ACTOR_UNCONFIRMED');const a=found[0],copy=copies.find(c=>c.invocation_ref===a.invocation_ref);
  check(a.origin==='CODEX_NATIVE_APP_SERVER'&&a.status==='SUCCEEDED'&&a.outcome==='RETURNED'&&Number.isFinite(a.ended_at)&&copy?.status===a.status&&copy.outcome==='RETURNED'&&copy.role===role&&copy.origin===a.origin&&hash(copy.request_refs)===hash(a.request_refs)&&unique(a.request_refs)&&a.request_refs.length>0&&a.request_refs.every(ref=>ledger.attempts.some(r=>r.request_ref===ref&&r.kind==='GENERATION'&&r.role===role&&r.outcome==='RETURNED'&&(scope===null||r.agent_scope===scope))),'ACTOR_UNCONFIRMED');
  return a;
 };
 let retained=null,draftOrigin=null;
 if(input.confirmed_cq_drafts_sha256){
  draftOrigin=state.upstream_origin?.run_id;
  check(state.upstream_origin?.mode==='EXPLICITLY_IMPORTED_CONFIRMED_CQ_DRAFTS'&&textField(draftOrigin)&&draftOrigin!==upstreamRunId,'DRAFT_ORIGIN_CHANGED');
  retained=prepareNativeProductConfirmedCQDrafts({store,catalog,libraryId,snapshotId,upstreamRunId:draftOrigin});
  check(hash(retained)===input.confirmed_cq_drafts_sha256&&hash(retained.hybrid_plan)===hash(plan),'DRAFT_ORIGIN_CHANGED');
 }
 const drafts=[];
 for(const window of windows){
  const chunk=chunked.chunks.find(c=>c.chunk_ref===window.chunk_ref),d=immutable(store,'native_cq_chunk_draft_v1',upstreamRunId+':'+window.chunk_ref),r=immutable(store,'native_cq_chunk_read_receipt_v1',d.read_receipt_ref);
  check(chunk?.status==='RETURNED'&&chunk.outcome==='RETURNED'&&d.run_id===upstreamRunId&&d.source_snapshot_ref===snapshotId&&d.chunk_ref===window.chunk_ref&&d.doc_ref===window.doc_ref&&d.revision===window.revision&&Array.isArray(d.items),'DRAFT_CHANGED');
  check(r.run_id===upstreamRunId&&r.source_snapshot_ref===snapshotId&&r.chunk_ref===window.chunk_ref&&r.read_receipt_ref===d.read_receipt_ref&&r.material_sha256===hash(window.contextualized_text)&&hash(r.source_ref)===hash({doc_ref:window.doc_ref,revision:window.revision})&&d.items.every(q=>textField(q.question)&&sourceRefs(q.source_refs)&&q.read_receipt_refs?.includes(r.read_receipt_ref)),'READ_RECEIPT_CHANGED');
  if(retained){
   const original=retained.drafts.find(o=>o.chunk_ref===window.chunk_ref)?.draft;
   check(original&&d.reuse_origin?.run_id===draftOrigin&&d.reuse_origin.chunk_ref===window.chunk_ref&&d.reuse_origin.record_sha256===original.record_sha256&&hash(d.reuse_origin.origin_cq_refs)===hash(original.items.map(q=>q.cq_ref))&&hash(d.raw_proposal)===hash(original.raw_proposal)&&d.items.length===original.items.length&&d.items.every((q,i)=>hash({question:q.question,notes:q.notes??null,source_hint:q.source_hint??null,source_refs:q.source_refs})===hash({question:original.items[i].question,notes:original.items[i].notes??null,source_hint:original.items[i].source_hint??null,source_refs:original.items[i].source_refs}))&&r.delivery==='HOST_REUSED_RETAINED_CQ_DRAFT'&&r.origin_run_id===draftOrigin&&r.origin_read_receipt_ref===original.read_receipt_ref,'DRAFT_ORIGIN_CHANGED');
  }else{
   check(!d.reuse_origin&&r.delivery!=='HOST_REUSED_RETAINED_CQ_DRAFT'&&chunk.receipt?.invocation_ref,'DRAFT_ORIGIN_CHANGED');
   const a=actor('CQ',window.chunk_ref,chunk.receipt.invocation_ref);
   check(chunk.receipt.status===a.status&&hash(chunk.receipt.request_refs)===hash(a.request_refs),'ACTOR_UNCONFIRMED');
  }
  drafts.push(...d.items.map(q=>({item:q,chunk_ref:window.chunk_ref})));
 }
 // Number after flattening, matching the saved merge's canonical draft order.
 const numbered=drafts.map((d,i)=>({...d,draft_ref:'draft_'+String(i+1).padStart(4,'0')}));
 check(hash(merge.drafts)===hash(numbered.map(d=>({draft_ref:d.draft_ref,origin_cq_ref:d.item.cq_ref,chunk_ref:d.chunk_ref})))&&merge.mapping?.length===cq.items.length&&unique(merge.mapping.map(m=>m.cq_ref)),'MERGE_CHANGED');
 const mapped=new Set();
 for(const m of merge.mapping){const q=cq.items.find(q=>q.cq_ref===m.cq_ref),origins=(m.source_draft_refs??[]).map(ref=>numbered.find(d=>d.draft_ref===ref));
  check(q&&unique(m.source_draft_refs)&&origins.length>0&&origins.every(Boolean)&&origins.every(d=>!mapped.has(d.draft_ref))&&hash(m.origin_cq_refs)===hash(origins.map(d=>d.item.cq_ref))&&hash(m.origin_chunk_refs)===hash([...new Set(origins.map(d=>d.chunk_ref))])&&hash(q.source_refs)===hash([...new Map(origins.flatMap(d=>d.item.source_refs).map(r=>[hash(r),r])).values()])&&hash(q.read_receipt_refs)===hash([...new Set(origins.flatMap(d=>d.item.read_receipt_refs))]),'MERGE_CHANGED');
  origins.forEach(d=>mapped.add(d.draft_ref));
 }
 check(mapped.size===numbered.length,'MERGE_CHANGED');
 if(merge.mode==='AGENT_REFERENCE_DECISIONS')actor('CQ','cq_merge_'+hash(plan.plan_ref).slice(0,32));
 else check((['HOST_EXACT_DEDUP','HOST_DRAFT_FALLBACK'].includes(merge.mode)||merge.mode==='HOST_CONSERVATIVE_RANGE_DEDUP_V1'&&plan.policy?.range_contract==='CQ_UNIT_RANGES_V1'),'MERGE_CHANGED');
 const familyActor=actor('FAMILY');
 check(ledger.attempts.filter(a=>a.kind==='GENERATION'&&a.role==='FAMILY').every(a=>familyActor.request_refs.includes(a.request_ref)),'REQUEST_BINDING_CHANGED');
 check(hash(createNativeFamilyInput({runId:upstreamRunId,sourceSnapshotRef:snapshotId,inputs:[cq]}))===hash(familyInput),'FAMILY_INPUT_CHANGED');
 const outputs=store.listRecords('native_family_output_normalization_v1').filter(p=>p.run_id===upstreamRunId),options={knowledgeBuildPolicy:'EXTRACT_AND_INDEX_V1'};
 check(outputs.length===1&&outputs[0].input_ref===familyInput.input_ref,'FAMILIES_CHANGED');
 const normalized=normalizeNativeFamilyOutput({args:outputs[0].raw,...options}).normalized;
 check(hash(normalized)===hash(outputs[0].normalized)&&hash(materializeNativeFamilyRefs({input:familyInput,families:validateNativeFamilyOutput({input:familyInput,args:normalized,...options}),...options}))===hash(families),'FAMILIES_CHANGED');
 const artifact=(stage,payload)=>{const cp=ledger.checkpoints?.find(c=>c.stage===stage),a=cp&&store.getRecord('native_full_run_artifact_v1',cp.artifact_ref),body=a&&{run_id:a.run_id,stage:a.stage,payload:a.payload,parent_refs:a.parent_refs};check(a?.run_id===upstreamRunId&&a.stage===stage&&hash(a.payload)===hash(payload)&&a.content_hash===hash(body)&&cp.artifact_ref==='native_artifact_'+hash(body),'ARTIFACT_CHANGED');return a;};
 const cqArtifact=artifact('CQ_SAVED',cq),familyArtifact=artifact('FAMILIES_SAVED',families);
 check(cqArtifact.parent_refs.includes(ledger.checkpoints.find(c=>c.stage==='SOURCE_READY')?.artifact_ref)&&familyArtifact.parent_refs.includes(cqArtifact.artifact_ref),'ARTIFACT_CHANGED');
 return {version:'SETTLED_SEMANTIC_IMPORT_PREFIX_V1',upstream_run_id:upstreamRunId,source_snapshot_ref:snapshotId,cq_input:clone(cq),family_input:clone(familyInput),families:clone(families),cq_scan_status:chunked.scan_status,hybrid_plan:clone(plan),cq_origin_run_id:upstreamRunId,cq_draft_origin_run_id:draftOrigin};
}
