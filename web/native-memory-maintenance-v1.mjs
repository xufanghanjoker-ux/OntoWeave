/** Explicit organization-only attempts. OFFLINE CANDIDATE; never saves/revises raw records. */
import {randomUUID} from 'node:crypto';
import {clone, hash, need, textField} from './cq-discovery-store-v2.mjs';
import {verifyNativeActionPrepared} from './native-action-processing-host-v1.mjs';

import {checkMemoryMaintenanceRuntimeOutcome} from './native-memory-maintenance-outcome-v1.mjs';

const signed = (value, key, code) => {
  const {[key]: signature, ...body} = value ?? {};
  need(signature === hash(body), code); return clone(value);
};
const rawPin = value => Object.fromEntries(['schema_version','library_id','record_ref','logical_ref','version','text','source',
  'source_ingested_at','valid_time','content','supersedes','relation'].filter(key => value[key] !== undefined).map(key => [key,clone(value[key])]));
const codeOf = value => typeof value === 'string' ? value : value?.code ?? value?.reason_code ?? 'RETAINED_WITHOUT_REASON_CODE';

/** Flow completion and publication confirmation do not establish content completeness. */
export function summarizeMemoryProcessingQuality(prepared) {
  const retained = prepared.retained ?? [], gaps = prepared.gaps ?? [];
  need(Array.isArray(retained) && Array.isArray(gaps), 'MEMORY_MAINTENANCE_QUALITY_INVALID');
  const reasons = {};
  for (const item of retained) {const code = codeOf(item); reasons[code] = (reasons[code] ?? 0) + 1;}
  return {partial: retained.length > 0 || gaps.length > 0 || prepared.processing_state === 'PARTIALLY_READY',
    retained_count: retained.length, retained_reason_counts: reasons, gap_count: gaps.length,
    gap_codes: [...new Set(gaps.map(codeOf))], organized_count: prepared.knowledge?.length ?? 0,
    action_run_id: prepared.run_id, action_prepared_sha256: prepared.prepared_sha256, semantic_quality: 'UNASSESSED'};
}

export function createMemoryMaintenance({db, coreForLibrary, processing, publication, projection, libraryContext,
  organizationPort, resolveSourcePrepared, resolveRuntimeOutcome = null, verifyActionPrepared = verifyNativeActionPrepared,
  clock = () => new Date().toISOString()}) {
  need(db && typeof coreForLibrary === 'function' && typeof processing?.get === 'function'
    && typeof publication?.publishKnowledgeView === 'function' && typeof publication?.getForProcessing === 'function'
    && typeof projection?.prepareProjection === 'function' && typeof libraryContext?.read === 'function'
    && typeof libraryContext?.assertCurrent === 'function' && typeof resolveSourcePrepared === 'function',
  'MEMORY_MAINTENANCE_HOST_REQUIRED');
  need(resolveRuntimeOutcome===null || typeof resolveRuntimeOutcome==='function','MEMORY_MAINTENANCE_OUTCOME_PORT_INVALID');
  need(organizationPort?.mode === 'NATIVE_CODEX' && typeof organizationPort.reorganize === 'function'
    && typeof organizationPort.verifyReuse === 'function', 'MEMORY_MAINTENANCE_ORGANIZATION_REUSE_PORT_REQUIRED');
  db.exec(`CREATE TABLE IF NOT EXISTS memory_product_maintenance_attempts_v1(
    attempt_ref TEXT PRIMARY KEY,library_id TEXT NOT NULL,record_ref TEXT NOT NULL,request_id TEXT NOT NULL,
    state TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(library_id,record_ref,request_id));
    CREATE TABLE IF NOT EXISTS memory_product_maintenance_events_v1(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,attempt_ref TEXT NOT NULL,payload TEXT NOT NULL);`);
  const now = () => new Date(clock()).toISOString();
  const decode = row => row ? JSON.parse(row.payload) : null;
  const get = ({attempt_ref}) => decode(db.prepare('SELECT payload FROM memory_product_maintenance_attempts_v1 WHERE attempt_ref=?').get(attempt_ref));
  function outcomeFor(attempt) {
    if(!resolveRuntimeOutcome)return null;
    try {return checkMemoryMaintenanceRuntimeOutcome(resolveRuntimeOutcome({attempt:clone(attempt),
      runtime_failure_ref:attempt.runtime_failure_ref??null}),{attempt});} catch {return null;}
  }
  function readAttempt(input) {
    const attempt=get(input);
    if(attempt?.state==='READY_AWAITING_PUBLICATION') {
      const receipt=publication.getForProcessing({library_id:attempt.library_id,processing_ref:attempt.attempt_ref});
      if(receipt.state==='CONFIRMED')return {...attempt,state:'COMPLETED',publication:receipt,
        stored_state:attempt.state,stored_publication:clone(attempt.publication),confirmation_projected:true};
    }
    if(attempt && ['FAILED','UNKNOWN'].includes(attempt.state)) {
      const outcome=outcomeFor(attempt);
      if(outcome?.verified && outcome.outcome==='UNKNOWN')return {...attempt,state:'UNKNOWN',
        stored_state:attempt.state,stored_error_code:attempt.error_code??null,
        stored_runtime_failure_ref:attempt.runtime_failure_ref??null,runtime_failure_ref:outcome.runtime_ref,
        runtime_outcome:outcome,outcome_projected:true};
      if(outcome)return {...attempt,runtime_outcome:outcome};
    }
    return attempt;
  }
  const event = (attempt, type) => db.prepare('INSERT INTO memory_product_maintenance_events_v1(attempt_ref,payload) VALUES(?,?)')
    .run(attempt.attempt_ref, JSON.stringify({type,state:attempt.state,at:now(),error_code:attempt.error_code ?? null,
      source_processing_ref:attempt.source_processing_ref,semantic_manifest_sha256:attempt.semantic_reuse.manifest_sha256,
      publication_ref:attempt.publication?.publication_ref ?? null,attempt_payload_sha256:hash(attempt)}));
  function transaction(fn) {
    need(db.isTransaction === false, 'MEMORY_MAINTENANCE_OUTER_TRANSACTION_FORBIDDEN');
    db.exec('BEGIN IMMEDIATE');
    try {const result=fn(); db.exec('COMMIT'); return result;} catch(cause) {if(db.isTransaction)db.exec('ROLLBACK'); throw cause;}
  }
  function persist(attempt, type) {
    db.prepare('UPDATE memory_product_maintenance_attempts_v1 SET state=?,payload=? WHERE attempt_ref=?')
      .run(attempt.state,JSON.stringify(attempt),attempt.attempt_ref); event(attempt,type); return clone(attempt);
  }
  function assertRaw(core, record, pin) {
    need(hash(rawPin(core.getRawRecord(record.record_ref))) === pin
      && core.getLatestRaw(record.logical_ref)?.record_ref === record.record_ref
      && core.getHead()?.record_refs.includes(record.record_ref), 'MEMORY_MAINTENANCE_RAW_CHANGED');
  }
  function enqueue({library_id,record_ref,request_id,reason,source_processing_ref,semantic_reuse,replacement_manifest}) {
    need([library_id,record_ref,request_id,reason,source_processing_ref].every(textField), 'MEMORY_MAINTENANCE_INPUT_INVALID');
    const request = {library_id,record_ref,request_id,reason,source_processing_ref,semantic_reuse,replacement_manifest};
    const requestHash = hash(request);
    const replay = decode(db.prepare('SELECT payload FROM memory_product_maintenance_attempts_v1 WHERE library_id=? AND record_ref=? AND request_id=?')
      .get(library_id,record_ref,request_id));
    if (replay) {need(replay.request_hash === requestHash,'MEMORY_MAINTENANCE_IDEMPOTENCY_CONFLICT');return clone(readAttempt({attempt_ref:replay.attempt_ref}));}
    const core=coreForLibrary(library_id),record=core.getRawRecord(record_ref),pin=hash(rawPin(record));
    assertRaw(core,record,pin); publication.assertQueryable({library_id});
    const source=processing.get({library_id,record_ref});
    need(source?.job_ref === source_processing_ref && source.state === 'COMPLETED' && source.mode === 'NATIVE_CODEX',
      'MEMORY_MAINTENANCE_CONFIRMED_SOURCE_JOB_REQUIRED');
    const original=verifyActionPrepared(resolveSourcePrepared({library_id,record_ref,source_processing_ref,
      source_run_id:source.runtime_receipt?.run_id}));
    need(original.library_id === library_id && original.source_record_ref === record_ref
      && original.source_record_version === record.version && original.prepared_sha256 === source.runtime_receipt?.prepared_sha256,
    'MEMORY_MAINTENANCE_SOURCE_PREPARED_CHANGED');
    const sourcePublication=publication.getForProcessing({library_id,processing_ref:source_processing_ref});
    need(sourcePublication.state === 'CONFIRMED' && sourcePublication.mode === 'NATIVE_PRODUCT', 'MEMORY_MAINTENANCE_SOURCE_UNCONFIRMED');
    const reuse=signed(semantic_reuse,'manifest_sha256','MEMORY_MAINTENANCE_SEMANTIC_MANIFEST_CHANGED');
    need(reuse.source_run_id === original.run_id && reuse.source_prepared_sha256 === original.prepared_sha256
      && Array.isArray(reuse.package_refs) && reuse.package_refs.length > 0
      && reuse.package_refs.every(pin => textField(pin.package_ref) && /^[a-f0-9]{64}$/.test(pin.sha256))
      && new Set(reuse.package_refs.map(pin=>pin.package_ref)).size === reuse.package_refs.length,
    'MEMORY_MAINTENANCE_SEMANTIC_MANIFEST_INVALID');
    const packages=[...new Set((original.windows ?? []).map(window=>window.semantic_package_ref))].sort();
    need(hash(packages) === hash(reuse.package_refs.map(pin=>pin.package_ref).sort()), 'MEMORY_MAINTENANCE_PACKAGE_SET_CHANGED');
    const replacements=signed(replacement_manifest,'manifest_sha256','MEMORY_MAINTENANCE_REPLACEMENT_MANIFEST_CHANGED');
    need(replacements.source_prepared_sha256 === original.prepared_sha256 && Array.isArray(replacements.knowledge)
      && new Set(replacements.knowledge.map(pin=>pin.record_ref)).size === replacements.knowledge.length,
    'MEMORY_MAINTENANCE_REPLACEMENT_MANIFEST_INVALID');
    for(const pin of replacements.knowledge) {
      const row=original.knowledge.find(row=>row.record_ref===pin.record_ref);
      need(row && row.native_action.content_sha256===pin.native_action_sha256 && hash(row.native_action)===pin.native_action_record_sha256,
        'MEMORY_MAINTENANCE_REPLACEMENT_NOT_ORIGINAL_CONTRIBUTION');
    }
    return transaction(()=>{
      const attempt={schema:'MEMORY_PRODUCT_MAINTENANCE_ATTEMPT_V1',attempt_ref:'mattempt_'+randomUUID(),
        ...clone(request),semantic_reuse:reuse,replacement_manifest:replacements,request_hash:requestHash,state:'QUEUED',
        created_at:now(),raw_pin_sha256:pin,source_operation:source.operation,target_record_ref:source.target_record_ref ?? null,
        source_prepared_sha256:original.prepared_sha256,source_publication_ref:sourcePublication.publication_ref,
        source_processing_snapshot_sha256:hash(source),source_quality:summarizeMemoryProcessingQuality(original),
        publication:{state:'NOT_PUBLISHED',queryable:false},semantic_invocations:0};
      db.prepare('INSERT INTO memory_product_maintenance_attempts_v1 VALUES(?,?,?,?,?,?)')
        .run(attempt.attempt_ref,library_id,record_ref,request_id,attempt.state,JSON.stringify(attempt));
      event(attempt,'EXPLICIT_ATTEMPT_CREATED');return clone(attempt);
    });
  }
  async function runOne({attempt_ref}) {
    let attempt=get({attempt_ref});need(attempt,'MEMORY_MAINTENANCE_ATTEMPT_NOT_FOUND');
    if(['COMPLETED','READY_AWAITING_PUBLICATION'].includes(attempt.state))return clone(readAttempt({attempt_ref}));
    need(attempt.state==='QUEUED','MEMORY_MAINTENANCE_ALREADY_STARTED_NO_RETRY');
    attempt=transaction(()=>{const current=get({attempt_ref});need(current.state==='QUEUED','MEMORY_MAINTENANCE_ALREADY_STARTED_NO_RETRY');
      return persist({...current,state:'RUNNING',started_at:now()},'ORGANIZATION_REUSE_STARTED');});
    try {
      const core=coreForLibrary(attempt.library_id),record=core.getRawRecord(attempt.record_ref);
      assertRaw(core,record,attempt.raw_pin_sha256);
      publication.assertQueryable({library_id:attempt.library_id});
      const head=core.getHead(),context=libraryContext.read({library_id:attempt.library_id,record,relatedRecords:[]});
      const verification=await organizationPort.verifyReuse({attempt:clone(attempt),record:clone(record),semantic_reuse:clone(attempt.semantic_reuse),
        library_context:clone(context)});
      need(verification?.verified===true && verification.manifest_sha256===attempt.semantic_reuse.manifest_sha256,
        'MEMORY_MAINTENANCE_SEMANTIC_REUSE_NOT_VERIFIED');
      libraryContext.assertCurrent(context);assertRaw(core,record,attempt.raw_pin_sha256);
      const result=await organizationPort.reorganize({attempt:clone(attempt),record:clone(record),
        semantic_reuse:clone(attempt.semantic_reuse),library_context:clone(context)});
      libraryContext.assertCurrent(context);assertRaw(core,record,attempt.raw_pin_sha256);
      need(core.getHead()?.commit_ref===head.commit_ref,'MEMORY_MAINTENANCE_STALE_COMMIT');
      const receipt=result?.reuse_receipt;
      need(receipt?.stage==='ORGANIZATION_ONLY' && receipt.semantic_invocations===0
        && receipt.manifest_sha256===attempt.semantic_reuse.manifest_sha256
        && receipt.source_run_id===attempt.semantic_reuse.source_run_id
        && receipt.library_context_sha256===context.context_sha256,
      'MEMORY_MAINTENANCE_REUSE_RECEIPT_INVALID');
      const prepared=verifyActionPrepared(result.action_prepared);
      need(prepared.execution_mode==='NATIVE_CODEX' && prepared.publication_eligible===true
        && prepared.library_id===attempt.library_id && prepared.source_record_ref===attempt.record_ref
        && prepared.source_record_version===record.version && prepared.run_id!==attempt.semantic_reuse.source_run_id,
      'MEMORY_MAINTENANCE_ACTION_BINDING_INVALID');
      need(!(prepared.invocations ?? []).some(invocation=>invocation.action_stage==='SEMANTIC'),
        'MEMORY_MAINTENANCE_NEW_SEMANTIC_INVOCATION_FORBIDDEN');
      need(result.runtime_receipt?.runtime==='NATIVE_CODEX' && result.runtime_receipt.run_id===prepared.run_id
        && result.runtime_receipt.prepared_sha256===prepared.prepared_sha256, 'MEMORY_MAINTENANCE_RUNTIME_RECEIPT_INVALID');
      const maintenance={attempt_ref,source_processing_ref:attempt.source_processing_ref,source_publication_ref:attempt.source_publication_ref,
        semantic_manifest_sha256:attempt.semantic_reuse.manifest_sha256,replacement_manifest_sha256:attempt.replacement_manifest.manifest_sha256,
        expected_bindings:clone(head.bindings)};
      const frame=await projection.prepareProjection({job:{...clone(attempt),operation:'REORGANIZE',maintenance},record,prepared});
      const quality=summarizeMemoryProcessingQuality(prepared);
      transaction(()=>persist({...get({attempt_ref}),state:'PREPARED',prepared_projection:clone(frame),quality,
        runtime_receipt:clone(result.runtime_receipt),reuse_receipt:clone(receipt),context_sha256:context.context_sha256},'ORGANIZATION_PREPARED'));
      const published=await publication.publishKnowledgeView({library_id:attempt.library_id,record_refs:[attempt.record_ref],
        processing_ref:attempt_ref,prepared:frame,maintenance});
      return transaction(()=>persist({...get({attempt_ref}),state:published.queryable?'COMPLETED':'READY_AWAITING_PUBLICATION',
        publication:clone(published),finished_at:now()},'VIEW_PUBLICATION_SETTLED'));
    } catch(cause) {
      const error_code=typeof cause.code==='string'?cause.code:'MEMORY_MAINTENANCE_FAILED';
      const failed={...get({attempt_ref}),state:'FAILED',error_code,finished_at:now(),
        runtime_failure_ref:cause.action_processing_run_id ?? null};
      const outcome=outcomeFor(failed);
      return transaction(()=>persist({...failed,state:outcome?.verified&&outcome.outcome==='UNKNOWN'?'UNKNOWN':'FAILED',
        ...(outcome?{runtime_outcome:outcome}:{})},'ATTEMPT_FAILED_NO_RETRY'));
    }
  }
  return Object.freeze({enqueue,get:readAttempt,runOne,events:({attempt_ref})=>db.prepare('SELECT payload FROM memory_product_maintenance_events_v1 WHERE attempt_ref=? ORDER BY seq')
    .all(attempt_ref).map(decode)});
}
