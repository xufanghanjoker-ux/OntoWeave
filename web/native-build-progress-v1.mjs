/** Read-only timing metadata. No controller, model receipt bodies or ledger mutation. */
import {hash} from './cq-discovery-store-v2.mjs';
const definitions=[['upload_parse','上传解析'],['chunking','分块'],['cq','CQ'],['family','问题族'],['extraction_local_alignment','抽取与局部对齐'],['temporal_publication','时态发布'],['graph_index_readback','图/索引与读回']];
const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
const time=v=>number(v)??(typeof v==='string'&&Number.isFinite(Date.parse(v))?Date.parse(v):null);
const min=values=>{const xs=values.filter(v=>v!==null&&v!==undefined);return xs.length?Math.min(...xs):null;};
const max=values=>{const xs=values.filter(v=>v!==null&&v!==undefined);return xs.length?Math.max(...xs):null;};
const open=status=>['OPEN','STARTING','RUNNING','PREPARED','STARTED'].includes(status);
const roleStage=role=>role==='CQ'?'cq':role==='FAMILY'?'family':/TEMPORAL|DOCUMENT_TIME/.test(role??'')?'temporal_publication':/INDEX|EMBEDDING|READBACK/.test(role??'')?'graph_index_readback':/EXTRACTION|SEMANTIC|ORGANIZATION|ONTOLOGY|LIBRARY_KNOWLEDGE|ALIGNMENT|REVIEW/.test(role??'')?'extraction_local_alignment':null;
function usageOf(attempts){
 const result={input_tokens:null,cached_input_tokens:null,output_tokens:null,reasoning_tokens:null,returned_with_usage:0,returned_without_usage:0,unknown_without_usage:0,inflight_without_usage:0};
 for(const a of attempts){
  if(a.outcome!=='RETURNED'){if(a.outcome==='UNKNOWN'&&!a.usage)result.unknown_without_usage++;if(['RESERVED','STARTED'].includes(a.outcome)&&!a.usage)result.inflight_without_usage++;continue;}
  if(!a.usage){result.returned_without_usage++;continue;}result.returned_with_usage++;const u=a.usage;
  const values={input_tokens:u.input_tokens??u.prompt_tokens,cached_input_tokens:u.cached_input_tokens??u.input_tokens_details?.cached_tokens??u.prompt_tokens_details?.cached_tokens,output_tokens:u.output_tokens??u.completion_tokens,reasoning_tokens:u.reasoning_tokens??u.output_tokens_details?.reasoning_tokens??u.completion_tokens_details?.reasoning_tokens};
  for(const [key,value]of Object.entries(values))if(number(value)!==null)result[key]=(result[key]??0)+value;
 }return result;
}
export function buildNativeBuildProgress({runId,row={},ledger={},artifacts=[],invocations=[],windows=[],indexCommits=[],programTiming=null,documentTimings=[],plannedWindows=null,now=Date.now()}){
 const status=row.status&&!open(row.status)?row.status:ledger.status&&ledger.status!=='OPEN'?ledger.status:row.status??ledger.status??'UNKNOWN',frozen=!open(status),attempts=ledger.attempts??[],executionMode=ledger.input?.execution_mode??row.execution_mode??null,isReplay=/PROGRAM.*REPLAY|PROGRAM_RENORMALIZE/.test(executionMode??'');
 const observed=time(now),lastEvent=max([time(ledger.ended_at),time(row.ended_at),...artifacts.map(a=>time(a.created_at)),...invocations.flatMap(i=>[time(i.started_at),time(i.ended_at)]),...attempts.flatMap(a=>[time(a.sent_at),time(a.ended_at)]),...indexCommits.map(c=>time(c.started_at)!==null&&number(c.wall_ms)!==null?time(c.started_at)+c.wall_ms:null)]),asOf=frozen?lastEvent:observed;
 const event=name=>min(artifacts.filter(a=>a.stage===name).map(a=>time(a.created_at))),has=name=>artifacts.some(a=>a.stage===name),artifactRefs=names=>artifacts.filter(a=>names.includes(a.stage)).map(a=>a.artifact_ref).filter(Boolean);
 const stages=definitions.map(([stage,label])=>{
  const actors=invocations.filter(i=>roleStage(i.role)===stage),calls=attempts.filter(a=>roleStage(a.role)===stage),starts=actors.map(i=>time(i.started_at)),ends=actors.map(i=>time(i.ended_at)),refs=actors.map(i=>i.invocation_ref).filter(Boolean),basis=[];
  let measurement='UNMEASURED',completed=false,reused=false,activity=actors.length>0||calls.length>0,reportedDuration=null;
  if(actors.length){basis.push('INVOCATION_METADATA');measurement='INVOCATION_SPAN';}
  if(!actors.length&&calls.length){starts.push(...calls.map(a=>time(a.sent_at)));ends.push(...calls.map(a=>time(a.ended_at)));basis.push('LEDGER_ATTEMPTS');measurement='REQUEST_SPAN';}
  if(stage==='upload_parse'){
   starts.push(...documentTimings.map(d=>time(d.started_at)));ends.push(...documentTimings.map(d=>time(d.ended_at)));activity=documentTimings.some(d=>time(d.started_at)!==null||time(d.ended_at)!==null);completed=activity&&documentTimings.every(d=>time(d.ended_at)!==null);if(activity){basis.push('DOCUMENT_PARSER_METADATA');measurement='DOCUMENT_RECORD_SPAN';}
  }else if(stage==='chunking'){
   reused=has('CHUNKS_IMPORTED_CONFIRMED');const start=event('SOURCE_READY'),end=event('CHUNKS_READY');if(!reused&&(end!==null||start!==null&&ledger.input?.cq_chunk_policy)){starts.push(start);ends.push(end);activity=true;completed=end!==null;measurement='CHECKPOINT_INTERVAL';basis.push('SOURCE_READY_TO_CHUNKS_READY');refs.push(...artifactRefs(['SOURCE_READY','CHUNKS_READY']));}
  }else if(stage==='cq'){reused=has('CQ_IMPORTED_CONFIRMED');completed=has('CQ_SAVED');refs.push(...artifactRefs(['CQ_SAVED','CQ_IMPORTED_CONFIRMED']));}
  else if(stage==='family'){reused=has('FAMILIES_IMPORTED_CONFIRMED');completed=has('FAMILIES_SAVED');refs.push(...artifactRefs(['FAMILIES_SAVED','FAMILIES_IMPORTED_CONFIRMED']));}
  else if(stage==='extraction_local_alignment'){
   reused=has('EXTRACTION_IMPORTED_CONFIRMED');completed=has('SIMPLIFIED_SOURCE_BLOCKS_SAVED')||has('EXTRACTION_SAVED');refs.push(...artifactRefs(['SIMPLIFIED_SOURCE_BLOCKS_SAVED','EXTRACTION_SAVED','EXTRACTION_IMPORTED_CONFIRMED']));reportedDuration=number(programTiming?.source_block_span_ms);
   activity||=windows.length>0||reportedDuration!==null;
  }else if(stage==='temporal_publication'){
   completed=has('SIMPLIFIED_TEMPORAL_PUBLICATION_CONFIRMED')||has('TEMPORAL_PUBLICATION_CONFIRMED');refs.push(...artifactRefs(['SIMPLIFIED_TEMPORAL_PUBLICATION_CONFIRMED','TEMPORAL_PUBLICATION_CONFIRMED']));reportedDuration=number(programTiming?.temporal_finalization_ms);activity||=completed||reportedDuration!==null;
  }else if(stage==='graph_index_readback'){
   completed=has('READBACK_VERIFIED');refs.push(...artifactRefs(['INDEX_COMMITTED','READBACK_VERIFIED']));
   for(const c of indexCommits){const start=time(c.started_at);starts.push(start);ends.push(start!==null&&number(c.wall_ms)!==null?start+c.wall_ms:null);if(c.record_ref)refs.push(c.record_ref);}
   const end=event('READBACK_VERIFIED')??event('INDEX_COMMITTED');if(end!==null)ends.push(end);
   activity||=indexCommits.length>0||end!==null;reportedDuration=number(programTiming?.vector_finalization_ms);if(indexCommits.length){basis.push('INCREMENTAL_INDEX_COMMITS');measurement='OBSERVED_ACTIVITY_SPAN';}
  }
  let started=min(starts),ended=max(ends);const unresolvedActor=actors.some(i=>open(i.status)&&time(i.ended_at)===null),unresolvedCall=calls.some(a=>['RESERVED','STARTED'].includes(a.outcome));
  let stageStatus=reused?'REUSED':completed?'COMPLETED':activity?(frozen?(status==='UNKNOWN_HOLD'?'UNKNOWN_HOLD':status==='FAILED'?'FAILED':['STOPPED','CANCELLED','STALE'].includes(status)?'STOPPED':'PARTIAL'):'RUNNING'):(stage==='upload_parse'?'UNMEASURED':'NOT_STARTED');
  if(!completed&&!reused&&activity&&actors.length&&actors.every(i=>time(i.ended_at)!==null)&&actors.every(i=>['SUCCEEDED','COMPLETED'].includes(i.status)))stageStatus=frozen?'PARTIAL':'RUNNING';
  if(!frozen&&(unresolvedActor||unresolvedCall))ended=null;
  if(reused){started=null;ended=null;measurement='REUSED_OUTPUT';basis.push('CONFIRMED_IMPORT_CHECKPOINT');}
  const duration=started!==null&&ended!==null&&ended>=started?ended-started:null,elapsed=started===null||(ended??asOf)===null?null:Math.max(0,(ended??asOf)-started),settled=calls.filter(a=>time(a.sent_at)!==null&&time(a.ended_at)!==null&&time(a.ended_at)>=time(a.sent_at)),callStart=min(calls.map(a=>time(a.sent_at))),callEnd=max(calls.map(a=>time(a.ended_at)));
  const counts={actors_total:actors.length,actors_completed:actors.filter(i=>['SUCCEEDED','COMPLETED'].includes(i.status)).length};
  if(stage==='extraction_local_alignment'){counts.windows_total=number(plannedWindows)??(windows.length||null);counts.windows_saved=windows.filter(w=>/SAVED_SETTLED/.test(w.status??'')).length;counts.windows_failed=windows.filter(w=>w.status==='FAILED').length;}
  const requestCounts={generation_attempts:calls.filter(a=>a.kind==='GENERATION').length,embedding_attempts:calls.filter(a=>a.kind==='EMBEDDING').length,returned:calls.filter(a=>a.outcome==='RETURNED').length,failed:calls.filter(a=>a.outcome==='FAILED').length,unknown:calls.filter(a=>a.outcome==='UNKNOWN').length,inflight:frozen?0:calls.filter(a=>['RESERVED','STARTED'].includes(a.outcome)).length,unsettled_at_stop:frozen?calls.filter(a=>['RESERVED','STARTED'].includes(a.outcome)).length:0,provider_calls:null};
  return {stage,label,status:stageStatus,started_at:started,ended_at:ended,duration_ms:duration,elapsed_ms:elapsed,measured:duration!==null||!frozen&&started!==null&&asOf!==null,measurement_kind:measurement,reported_duration_ms:reportedDuration,evidence_refs:[...new Set(refs)],basis,request_cumulative_ms:settled.length?settled.reduce((n,a)=>n+time(a.ended_at)-time(a.sent_at),0):null,parallel_span_ms:callStart===null?null:Math.max(0,((!frozen&&unresolvedCall?asOf:callEnd)??asOf??callStart)-callStart),requests:requestCounts,usage:usageOf(calls),counts,notes:['Parallel stage spans and request cumulative time must not be added as total wall time.',...(reused?['Reused output; no generation duration attributed to this run.']:[]),...(isReplay?['Program proposal replay; saves/windows are not model requests.']:[]),...(ended!==null&&time(ledger.ended_at)!==null&&ended>time(ledger.ended_at)?['Actor/commit drain ended after the parent stop timestamp.']:[])]};
 });
 const started=time(ledger.created_at)??time(row.created_at),ended=time(ledger.ended_at)??time(row.ended_at);
 return {version:'NATIVE_BUILD_PROGRESS_V1',run_id:runId,status,as_of_ms:asOf,observed_at_ms:observed,frozen,freeze_basis:frozen?(ended!==null?'TERMINAL_WITH_PERSISTED_DRAIN_EVENTS':'LAST_PERSISTED_EVENT_NO_TERMINAL_TIMESTAMP'):null,execution_mode:executionMode,is_program_replay:isReplay,overall:{started_at:started,ended_at:ended,duration_ms:started!==null&&ended!==null?Math.max(0,ended-started):null,elapsed_ms:started===null||(ended??asOf)===null?null:Math.max(0,(ended??asOf)-started),measured:started!==null&&(ended!==null||!frozen),basis:['PARENT_RUN_TIMESTAMPS']},stages,usage:usageOf(attempts),notes:['Request attempts are not proof of provider admission. Provider call count is unknown without admission evidence.','Missing starts remain null. Completed checkpoint timestamps alone do not establish a duration.']};
}

/** Exact kind/id lookups and current-run JSON projections only; no per-run global receipt scan. */
export function readNativeBuildProgress({store,row,now=Date.now()}){
 const runId=row.run_id,ledger=store.getRecord('native_full_run_v1',runId)??{},db=store.db;
 if(!db?.prepare)return buildNativeBuildProgress({runId,row,ledger,now});
 const exact=(kind,id,fields)=>db.prepare(`SELECT ${fields.map(([alias,path])=>`json_extract(payload, '${path}') AS ${alias}`).join(', ')} FROM workbench_records WHERE kind=? AND id=?`).get(kind,id);
 const each=(kind,id,path,fields)=>db.prepare(`SELECT ${fields.map(([alias,p])=>`json_extract(j.value, '${p}') AS ${alias}`).join(', ')} FROM workbench_records w,json_each(w.payload,'${path}') j WHERE w.kind=? AND w.id=?`).all(kind,id);
 const artifactFields=[['stage','$.stage'],['artifact_ref','$.artifact_ref'],['created_at','$.created_at']];
 const artifacts=(ledger.checkpoints??[]).map(c=>exact('native_full_run_artifact_v1',c.artifact_ref,artifactFields)).filter(Boolean);
 const windowsPlan=each('native_simplified_manifest_v1',runId,'$.manifest.windows',[['window_ref','$.window_ref']]),cqPlan=each('native_chunked_cq_state_v1',runId,'$.chunks',[['chunk_ref','$.chunk_ref']]);
 const invocationFields=[['invocation_ref','$.invocation_ref'],['role','$.role'],['status','$.status'],['started_at','$.started_at'],['ended_at','$.ended_at']];
 const bindings=new Map(),add=(role,scope=null)=>{if(!role)return;const body={run_id:runId,role,...(scope?{agent_scope:scope}:{})};bindings.set(hash(body),body);};
 for(const role of ['CQ','FAMILY','EXTRACTION'])add(role);
 for(const a of ledger.attempts??[])if(a.kind==='GENERATION')add(a.role,a.agent_scope??null);
 for(const c of cqPlan)add('CQ',c.chunk_ref);
 const cqState=exact('native_chunked_cq_state_v1',runId,[['plan_ref','$.plan_ref']]);if(cqState?.plan_ref)add('CQ','cq_merge_'+hash(cqState.plan_ref).slice(0,32));
 for(const w of windowsPlan)for(const suffix of ['',':SOURCE_BLOCK',':SEMANTIC',':ORGANIZATION',':RELATION_REVIEW'])add('EXTRACTION',w.window_ref+suffix);
 const invoked=each('native_full_chain_state_v1',runId,'$.invocations',[...invocationFields,['agent_scope','$.agent_scope']]);for(const i of invoked)add(i.role,i.agent_scope??null);
 const byInvocation=new Map(invoked.filter(i=>i.invocation_ref).map(i=>[i.invocation_ref,i]));
 for(const id of bindings.keys()){const i=exact('native_agent_invocation_v1',id,invocationFields);if(i?.invocation_ref)byInvocation.set(i.invocation_ref,i);}
 const invocations=[...byInvocation.values()],windows=windowsPlan.map(w=>exact('native_simplified_block_v1',runId+':'+w.window_ref,[['status','$.status']])).filter(Boolean);
 const indexFields=[['started_at','$.started_at'],['wall_ms','$.wall_ms'],['record_ref','$.revision_ref']],indexCommits=each('native_full_chain_state_v1',runId,'$.build.simplified.commits',indexFields);
 const program=exact('native_full_chain_state_v1',runId,[['timing','$.build.simplified.timing'],['commit_started','$.incremental_commit.started_at'],['commit_wall','$.incremental_commit.wall_ms'],['commit_ref','$.incremental_commit.revision_ref']]),programTiming=program?.timing?JSON.parse(program.timing):null;
 if(program?.commit_started!==null&&program?.commit_started!==undefined&&!indexCommits.some(c=>c.record_ref===program.commit_ref))indexCommits.push({started_at:program.commit_started,wall_ms:program.commit_wall,record_ref:program.commit_ref});
 const snapshotId=ledger.input?.source_snapshot_ref??row.snapshot_id,documentTimings=snapshotId?db.prepare("SELECT json_extract(d.value,'$.parser.started_at') AS started_at,json_extract(d.value,'$.parser.ended_at') AS ended_at FROM workbench_records AS w,json_each(w.payload,'$.documents') AS d WHERE w.kind='cq_v2_snapshot' AND w.id=?").all(snapshotId):[];
 return buildNativeBuildProgress({runId,row,ledger,artifacts,invocations,windows,indexCommits,programTiming,documentTimings,plannedWindows:windowsPlan.length||null,now});
}
