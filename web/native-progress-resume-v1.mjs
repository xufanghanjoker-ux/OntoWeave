/** New-run retained-work plan. No original controller, acknowledgement or retry. */
import {clone,hash,need} from './cq-discovery-store-v2.mjs';
import {readSemanticPackage,bindNativeSemanticPackage} from './native-semantic-package-v1.mjs';
import {domainRows} from './native-domain-knowledge-v1.mjs';
import {prepareProgramSemanticRecovery,readProgramSemanticImport,isLocalContentFailure} from './native-semantic-lifecycle-v1.mjs';
const checked=(r,code)=>{need(r&&r.record_sha256===hash(Object.fromEntries(Object.entries(r).filter(([k])=>k!=='record_sha256'))),code);return r;};
export function prepareNativeProgressResume({store,catalog,libraryId,snapshotId,upstreamRunId,confirmedUpstream,programSemanticRecovery}){
 const row=store.getRecord('native_product_run_v1',upstreamRunId),ledger=store.getRecord('native_full_run_v1',upstreamRunId),state=store.getRecord('native_full_chain_state_v1',upstreamRunId);
 programSemanticRecovery??=isLocalContentFailure(ledger?.reason);
 need(row?.library_id===libraryId&&row.snapshot_id===snapshotId&&state?.snapshot_id===snapshotId&&state.library_id===libraryId,'NATIVE_RESUME_SOURCE_MISMATCH');
 need(['STOPPED','FAILED','CANCELLED'].includes(row.status)&&ledger?.status===row.status&&ledger.ended_at!=null&&ledger.attempts.every(a=>a.outcome==='RETURNED'),'NATIVE_RESUME_REQUESTS_UNSETTLED');
 need(catalog.isCurrent(snapshotId,libraryId),'NATIVE_RESUME_SOURCE_STALE');const source=catalog.get(snapshotId,libraryId);
 need(state.input.source_fingerprint===source.fingerprint&&hash(state.input)===hash(ledger.input)&&ledger.binding===hash({input:ledger.input,limits:ledger.limits}),'NATIVE_RESUME_INPUT_CHANGED');
 need(hash(state.cq_input)===hash(confirmedUpstream.cq_input)&&hash(state.family_input)===hash(confirmedUpstream.family_input)&&hash(state.families)===hash(confirmedUpstream.families),'NATIVE_RESUME_PREFIX_CHANGED');
 const actors=store.listRecords('native_agent_invocation_v1');
 const terminal=new Set(['FAILED','STOPPED','SUCCEEDED','CANCELLED','PARTIAL']);
 function settledRun(runId){
  const l=store.getRecord('native_full_run_v1',runId),s=store.getRecord('native_full_chain_state_v1',runId),r=store.getRecord('native_product_run_v1',runId);
  need(l&&r&&s&&r.library_id===libraryId&&r.snapshot_id===snapshotId&&s.snapshot_id===snapshotId&&s.library_id===libraryId&&['STOPPED','FAILED','CANCELLED'].includes(l.status)&&r.status===l.status&&l.ended_at!=null&&l.attempts.every(a=>a.outcome==='RETURNED'),'NATIVE_RESUME_REQUESTS_UNSETTLED');
  need(l.input.source_fingerprint===source.fingerprint&&hash(l.input)===hash(s.input)&&l.binding===hash({input:l.input,limits:l.limits}),'NATIVE_RESUME_INPUT_CHANGED');
  const own=actors.filter(a=>a.run_id===runId);need(own.length>0&&own.every(a=>a.origin==='CODEX_NATIVE_APP_SERVER'&&a.ended_at!=null&&terminal.has(a.status)),'NATIVE_RESUME_ACTOR_UNSETTLED');return l;
 }
 settledRun(upstreamRunId);
 const suffix=prepareNativeTemporalLibrarySuffix({store,catalog,libraryId,snapshotId,upstreamRunId,confirmedUpstream});
 if(suffix)return {version:'CONFIRMED_PROGRESS_RESUME_V1',upstream_run_id:upstreamRunId,source_snapshot_ref:snapshotId,source_fingerprint:source.fingerprint,
   capability:row.capability,prefix:clone(confirmedUpstream),ledger_sha256:hash(ledger),windows:[],resume_scope:'DOCUMENT_TEMPORAL_ONLY',suffix,
   summary:{cq_count:state.cq_input.items.length,family_count:state.families.families.length,semantic_items:suffix.semantic_packages.reduce((n,p)=>n+p.item_count,0),
    sealed_semantic_items:suffix.semantic_packages.reduce((n,p)=>n+p.item_count,0),partial_semantic_items:0,saved_knowledge:suffix.knowledge_count,
    formed_library_knowledge:suffix.knowledge_count,window_count:suffix.semantic_packages.length,scan_status:confirmedUpstream.cq_scan_status,partial:true,
    resume_scope:'DOCUMENT_TEMPORAL_ONLY',reused_scopes:['CQ','FAMILY','SEMANTIC','ORGANIZATION','RELATION_REVIEW','IDENTITY','ONTOLOGY'],
    identity_stage_status:suffix.identity_status,ontology_stage_status:suffix.ontology_status,source_quality:clone(suffix.source_quality)}};
 function actor(runId,ref,scope){const l=settledRun(runId),found=actors.filter(a=>a.run_id===runId&&a.invocation_ref===ref&&a.agent_scope===scope),requests=l.attempts.filter(a=>a.agent_scope===scope&&a.kind==='GENERATION');need(found.length===1&&requests.length>0&&hash(requests.map(r=>r.request_ref))===hash(found[0].request_refs),'NATIVE_RESUME_ACTOR_CHANGED');return hash(found[0]);}
 // Follow only explicitly pinned same-window ancestors. Never search other runs
 // for a matching statement or accept a detached proposal as inherited work.
 function semanticDraft(stageId,window,trail=[]){
  need(!trail.includes(stageId)&&trail.length<64,'NATIVE_RESUME_LINEAGE_CYCLE');
  const head=store.getRecord('native_semantic_head_v1',stageId),owner=head?.binding.run_id;
  need(head&&stageId===owner+'_semantic_'+hash(window.window_ref).slice(0,24)&&head.binding.window_sha256===hash(window)&&head.binding.source_snapshot_ref===snapshotId&&head.binding.source_fingerprint===source.fingerprint&&head.binding.library_id===libraryId,'NATIVE_RESUME_SEMANTIC_CHANGED');settledRun(owner);
  let items=[],pins=[],inherited=0;
  if(head.retained_origin){const o=head.retained_origin,old=semanticDraft(o.stage_id,window,[...trail,stageId]);need(o.origin_run_id===old.owner&&o.head_sha256===hash(old.head)&&hash(o.proposal_pins)===hash(old.pins)&&o.item_count===old.items.length&&hash(head.items.slice(0,old.items.length))===hash(old.items)&&hash(head.proposals.slice(0,old.head.proposals.length))===hash(old.head.proposals),'NATIVE_RESUME_SEMANTIC_ORIGIN_CHANGED');items=clone(old.items);pins=clone(old.pins);inherited=old.head.proposals.length;}
  for(const pin of head.proposals.slice(inherited)){
   const p=checked(store.getRecord('native_semantic_proposal_v1',pin.proposal_ref),'NATIVE_RESUME_SEMANTIC_RECEIPT_CHANGED');
   need(p.run_id===owner&&p.stage_id===stageId&&p.raw_sha256===hash(p.raw)&&p.raw_sha256===pin.raw_sha256&&p.window_sha256===hash(window)&&p.source_snapshot_ref===snapshotId&&p.source_fingerprint===source.fingerprint,'NATIVE_RESUME_SEMANTIC_RECEIPT_CHANGED');
   const saved=[];for(const raw of p.raw.statements??[]){const text=typeof raw==='string'?raw:raw?.text??raw?.statement;if(typeof text!=='string'||!text.trim())continue;const item={...(raw&&typeof raw==='object'?clone(raw):{}),text,semantic_ref:'S'+(items.length+saved.length+1),source_refs:clone(window.source_refs),proposal_ref:p.proposal_ref};saved.push(item);}
   need((p.feedback.saved===true||p.content_status==='ALL_BAD'&&saved.length===0)&&p.feedback.saved_count===saved.length&&hash(p.feedback.items.filter(i=>i.status==='SAVED').map(i=>i.semantic_ref))===hash(saved.map(i=>i.semantic_ref)),'NATIVE_RESUME_SEMANTIC_RECEIPT_CHANGED');items.push(...saved);const actorSha=p.program_recovery_ref?readProgramSemanticImport({store,ref:p.program_recovery_ref,stageId,args:p.raw}).execution.actor_sha256:actor(owner,p.invocation_ref,window.window_ref+':SEMANTIC');pins.push({proposal_ref:p.proposal_ref,sha256:p.record_sha256,actor_sha256:actorSha});
  }
  need(hash(items)===hash(head.items)&&new Set(head.proposals.map(p=>p.proposal_ref)).size===head.proposals.length,'NATIVE_RESUME_SEMANTIC_CONTENT_CHANGED');return {head,owner,items,pins};
 }
 function organizationDraft(stageRunId,window,semantic,trail=[]){
  need(!trail.includes(stageRunId)&&trail.length<64,'NATIVE_RESUME_LINEAGE_CYCLE');
  const head=store.getRecord('native_knowledge_head_v1',stageRunId),meta=store.getRecord('native_extraction_window_stage_v1',stageRunId),build=store.getRecord('native_build_state_v1',stageRunId),owner=meta?.parent_run_id;
  need(head&&meta?.window_sha256===hash(window)&&stageRunId===owner+'_window_'+hash(window.window_ref).slice(0,24)&&meta.source_snapshot_ref===snapshotId&&meta.library_id===libraryId&&semantic.kind==='SEALED','NATIVE_RESUME_ORGANIZATION_CHANGED');settledRun(owner);
  let refs=[],pins=[],inheritedItems=[];const imported=store.getRecord('native_organization_draft_import_v1',stageRunId);
  if(imported){
   const o=imported.origin,old=organizationDraft(o?.stage_run_id,window,semantic,[...trail,stageRunId]);
   need(o.run_id===old.owner&&o.head_sha256===old.entry.head_sha256&&imported.confirmation_sha256===hash(old.entry)&&imported.knowledge_count===old.head.knowledge.length&&imported.saved===true&&imported.partial===true&&imported.requests_resent===0&&hash(imported.proposals)===hash(old.entry.proposals.map(p=>({proposal_ref:p.proposal_ref,origin_run_id:o.run_id,receipt_sha256:p.receipt_sha256}))),'NATIVE_RESUME_KNOWLEDGE_ORIGIN_CHANGED');
   const expected=projectImportedKnowledge(old.head.knowledge,stageRunId,o);need(hash(head.knowledge.slice(0,expected.length))===hash(expected),'NATIVE_RESUME_KNOWLEDGE_ORIGIN_CHANGED');refs=expected.map(k=>k.record_ref);pins=clone(old.entry.proposals);inheritedItems=old.head.processing_summary.items;
   need(hash(head.processing_summary.items.slice(0,inheritedItems.length))===hash(inheritedItems),'NATIVE_RESUME_KNOWLEDGE_RECEIPT_CHANGED');
  }
  const proposals=store.listRecords('native_knowledge_proposal_v1').filter(p=>p.run_id===stageRunId&&p.name==='SUBMIT'),processedNew=[];
  for(const p of proposals){const receipt=store.getRecord('native_knowledge_receipt_v1',p.proposal_ref),rows=domainRows(p.raw),processed=head.processing_summary.items.slice(inheritedItems.length).filter(i=>i.proposal_ref===p.proposal_ref),expected=processed.filter(i=>i.status!=='SKIPPED').map(i=>'knowledge_'+hash([p.proposal_ref,i.index]));
   need(p.source_snapshot_ref===snapshotId&&p.semantic_policy==='DOMAIN_KNOWLEDGE_V1'&&p.raw_hash===hash(p.raw)&&receipt?.proposal_ref===p.proposal_ref&&receipt?.saved===true&&receipt.processed===true&&receipt.received===rows.length&&processed.length===rows.length&&new Set(processed.map(i=>i.index)).size===rows.length&&processed.every(i=>Number.isSafeInteger(i.index)&&i.index>=0&&i.index<rows.length)&&hash(receipt.knowledge_refs)===hash(expected),'NATIVE_RESUME_KNOWLEDGE_RECEIPT_CHANGED');for(const [status,key]of [['STRUCTURED','structured'],['TEXT','text'],['SKIPPED','skipped']])need(receipt[key]===processed.filter(i=>i.status===status).length,'NATIVE_RESUME_KNOWLEDGE_RECEIPT_CHANGED');refs.push(...receipt.knowledge_refs);processedNew.push(...processed);pins.push({proposal_ref:p.proposal_ref,proposal_sha256:hash(p),receipt_sha256:hash(receipt),actor_sha256:actor(owner,p.identity.invocation_ref,window.window_ref+':ORGANIZATION')});
  }
  need(processedNew.length+inheritedItems.length===head.processing_summary.items.length&&new Set(refs).size===refs.length&&refs.length===head.knowledge.length&&head.knowledge.every(k=>refs.includes(k.record_ref)&&k.run_id===stageRunId&&k.source_snapshot_ref===snapshotId&&k.semantic_lineage?.package_ref===semantic.package_ref&&k.semantic_lineage.semantic_refs.every(ref=>store.getRecord('native_semantic_package_v1',semantic.package_ref).items.some(i=>i.semantic_ref===ref))&&k.source_refs.every(r=>source.documents.some(d=>d.doc_id===r.doc_ref&&d.revision===r.revision))),'NATIVE_RESUME_KNOWLEDGE_CHANGED');
  return {head,owner,entry:{stage_run_id:stageRunId,head_sha256:hash(head),knowledge_count:head.knowledge.length,proposals:pins,completed:build?.extraction_complete===true,build_sha256:hash(build),scope_sha256:hash(store.getRecord('native_knowledge_scope_v1',stageRunId)??null)}};
 }
 const manifest=checked(store.listRecords('native_extraction_window_manifest_v1').find(r=>r.run_id===upstreamRunId),'NATIVE_RESUME_MANIFEST_CHANGED');
 const windows=manifest.manifest.windows.map(window=>{
  const binding=store.getRecord('native_semantic_window_binding_v1',upstreamRunId+':'+window.window_ref);let semantic;
  if(binding){checked(binding,'NATIVE_RESUME_SEMANTIC_CHANGED');const p=readSemanticPackage({store,catalog,libraryId,snapshotId,packageRef:binding.package_ref});need(p.window_sha256===hash(window)&&p.record_sha256===binding.package_sha256,'NATIVE_RESUME_SEMANTIC_CHANGED');semantic={kind:'SEALED',window_ref:window.window_ref,window_sha256:hash(window),package_ref:p.package_ref,package_sha256:p.record_sha256,item_count:p.items.length};}
  else{
   const stageId=upstreamRunId+'_semantic_'+hash(window.window_ref).slice(0,24),head=store.getRecord('native_semantic_head_v1',stageId);
   if(head){
    const draft=semanticDraft(stageId,window);semantic={kind:'PARTIAL_DRAFT',stage_id:stageId,window_sha256:hash(window),head_sha256:hash(head),item_count:draft.items.length,proposal_pins:draft.pins,origin_run_id:upstreamRunId,...(programSemanticRecovery?{program_recovery:prepareProgramSemanticRecovery({store,runId:upstreamRunId,window,head})}:{})};
   }else semantic={kind:'NOT_STARTED',item_count:0};
  }
  const stageRunId=upstreamRunId+'_window_'+hash(window.window_ref).slice(0,24),head=store.getRecord('native_knowledge_head_v1',stageRunId);let organization=null;
  if(head?.knowledge.length)organization=organizationDraft(stageRunId,window,semantic).entry;
  return {window_ref:window.window_ref,window_sha256:hash(window),semantic,organization};
 });
 const summary={cq_count:state.cq_input.items.length,family_count:state.families.families.length,semantic_items:windows.reduce((n,w)=>n+w.semantic.item_count,0),sealed_semantic_items:windows.filter(w=>w.semantic.kind==='SEALED').reduce((n,w)=>n+w.semantic.item_count,0),partial_semantic_items:windows.filter(w=>w.semantic.kind==='PARTIAL_DRAFT').reduce((n,w)=>n+w.semantic.item_count,0),saved_knowledge:windows.reduce((n,w)=>n+(w.organization?.knowledge_count??0),0),window_count:windows.length,scan_status:confirmedUpstream.cq_scan_status,partial:true};
 return {version:'CONFIRMED_PROGRESS_RESUME_V1',upstream_run_id:upstreamRunId,source_snapshot_ref:snapshotId,source_fingerprint:source.fingerprint,capability:row.capability,prefix:clone(confirmedUpstream),ledger_sha256:hash(ledger),manifest_sha256:manifest.record_sha256,windows,summary,...(programSemanticRecovery?{program_semantic_recovery:true,program_summary:{saved_semantic_items:summary.semantic_items,recoverable_semantic_items:windows.reduce((n,w)=>n+(w.semantic.program_recovery?.recoverable_item_count??0),0),semantic_model_windows_required:windows.filter(w=>w.semantic.kind==='NOT_STARTED').length}}:{})};
}
function projectImportedKnowledge(knowledge,stageRunId,origin){
 return knowledge.map(k=>({...clone(k),run_id:stageRunId,organization_draft_origin:clone(origin),evidence:(k.evidence??[]).map(e=>{const {record_sha256,...body}=clone(e),value={...body,run_id:stageRunId};return {...value,...(record_sha256?{record_sha256:hash(value)}:{})};})}));
}
export function importProgressKnowledge({store,stageRunId,entry,originRunId}){
 const old=store.getRecord('native_knowledge_head_v1',entry.stage_run_id);need(hash(old)===entry.head_sha256,'NATIVE_RESUME_KNOWLEDGE_CHANGED');const prior=store.getRecord('native_organization_draft_import_v1',stageRunId);if(prior){need(prior.confirmation_sha256===hash(entry),'NATIVE_RESUME_IMPORT_CONFLICT');return prior;}
 need(!(store.getRecord('native_knowledge_head_v1',stageRunId)?.knowledge.length),'NATIVE_RESUME_IMPORT_CONFLICT');
 const origin={run_id:originRunId,stage_run_id:entry.stage_run_id,head_sha256:entry.head_sha256},knowledge=projectImportedKnowledge(old.knowledge,stageRunId,origin),receipt={run_id:stageRunId,confirmation_sha256:hash(entry),origin,knowledge_count:knowledge.length,proposals:entry.proposals.map(p=>({proposal_ref:p.proposal_ref,origin_run_id:originRunId,receipt_sha256:p.receipt_sha256})),saved:true,initial_drafts_imported:true,partial:true,requests_resent:0};
 store.transaction(()=>{store.putRecord('native_knowledge_head_v1',stageRunId,{revision:'knowledge_revision_'+hash([stageRunId,entry]),knowledge,processing_summary:clone(old.processing_summary)});store.putRecord('native_organization_draft_import_v1',stageRunId,receipt);});return receipt;
}

/** Completed-library suffix recovery. Does not reopen a controller or re-evaluate semantic/library stages. */
export function prepareNativeTemporalLibrarySuffix({store,catalog,libraryId,snapshotId,upstreamRunId,confirmedUpstream}) {
 const row=store.getRecord('native_product_run_v1',upstreamRunId),ledger=store.getRecord('native_full_run_v1',upstreamRunId),state=store.getRecord('native_full_chain_state_v1',upstreamRunId);
 const checkpoint=ledger?.checkpoints?.find(c=>c.stage==='LIBRARY_KNOWLEDGE_FORMED');
 if(!checkpoint||state?.input?.temporal_publication_policy!=='DOCUMENT_BITEMPORAL_PUBLICATION_V1')return null;
 need(catalog.isCurrent(snapshotId,libraryId),'NATIVE_TEMPORAL_SUFFIX_SOURCE_STALE');const source=catalog.get(snapshotId,libraryId);
 need(row?.library_id===libraryId&&row.snapshot_id===snapshotId&&state.library_id===libraryId&&state.snapshot_id===snapshotId
  &&['STOPPED','FAILED','CANCELLED'].includes(row.status)&&ledger.status===row.status&&Number.isFinite(ledger.ended_at)
  &&ledger.attempts.length>0&&ledger.attempts.every(a=>a.outcome==='RETURNED'),'NATIVE_TEMPORAL_SUFFIX_SOURCE_UNSETTLED');
 need(state.input.source_fingerprint===source.fingerprint&&hash(state.input)===hash(ledger.input)&&ledger.binding===hash({input:state.input,limits:ledger.limits}),
  'NATIVE_TEMPORAL_SUFFIX_INPUT_CHANGED');
 need(confirmedUpstream&&hash(state.cq_input)===hash(confirmedUpstream.cq_input)&&hash(state.family_input)===hash(confirmedUpstream.family_input)
  &&hash(state.families)===hash(confirmedUpstream.families),'NATIVE_TEMPORAL_SUFFIX_PREFIX_CHANGED');
 const artifact=store.getRecord('native_full_run_artifact_v1',checkpoint.artifact_ref),artifactBody=artifact&&{run_id:artifact.run_id,stage:artifact.stage,payload:artifact.payload,parent_refs:artifact.parent_refs};
 need(artifactBody?.run_id===upstreamRunId&&artifactBody.stage==='LIBRARY_KNOWLEDGE_FORMED'&&checkpoint.artifact_ref==='native_artifact_'+hash(artifactBody)
  &&artifact.content_hash===hash(artifactBody),'NATIVE_TEMPORAL_SUFFIX_CHECKPOINT_CHANGED');
 const pointer=store.getRecord('native_library_knowledge_projection_v1',upstreamRunId),revision=checked(store.getRecord('native_library_knowledge_revision_v1',pointer?.revision_ref),'NATIVE_TEMPORAL_SUFFIX_LIBRARY_CHANGED');
 const input=store.getRecord('native_library_knowledge_input_v1',upstreamRunId),receipt=store.getRecord('native_build_library_projection_v1',upstreamRunId);
 need(pointer.run_id===upstreamRunId&&pointer.library_id===libraryId&&pointer.record_sha256===revision.record_sha256
  &&revision.run_id===upstreamRunId&&revision.library_id===libraryId&&revision.source_snapshot_ref===snapshotId&&revision.source_fingerprint===source.fingerprint
  &&input?.run_id===upstreamRunId&&input.library_id===libraryId&&input.source_snapshot_ref===snapshotId&&input.source_fingerprint===source.fingerprint
  &&input.input_sha256===revision.input_sha256&&input.input_sha256===hash({libraryId,snapshotId,knowledge:input.knowledge,cqInput:input.cq_input,families:input.families})
  &&hash(input.cq_input)===hash(state.family_input)&&hash(input.families)===hash(state.families),'NATIVE_TEMPORAL_SUFFIX_LIBRARY_INPUT_CHANGED');
 need(receipt&&hash(receipt)===hash(artifact.payload)&&receipt.revision_ref===revision.revision_ref&&receipt.projection_sha256===hash(revision)
  &&receipt.source_fingerprint===source.fingerprint,'NATIVE_TEMPORAL_SUFFIX_LIBRARY_RECEIPT_CHANGED');
 const identity=store.getRecord('native_library_knowledge_state_v1',upstreamRunId+':IDENTITY'),ontology=store.getRecord('native_library_knowledge_state_v1',upstreamRunId+':ONTOLOGY');
 need(identity?.finished===true&&ontology?.finished===true&&['SAVED','PARTIAL'].includes(identity.status)&&['SAVED','PARTIAL'].includes(ontology.status)
  &&identity.library_id===libraryId&&ontology.library_id===libraryId&&identity.source_snapshot_ref===snapshotId&&ontology.source_snapshot_ref===snapshotId,
  'NATIVE_TEMPORAL_SUFFIX_LIBRARY_STAGE_UNFINISHED');
 const actors=store.listRecords('native_agent_invocation_v1').filter(a=>a.run_id===upstreamRunId);
 need(actors.length>0&&actors.every(a=>a.origin==='CODEX_NATIVE_APP_SERVER'&&a.ended_at!=null&&['SUCCEEDED','FAILED','STOPPED','CANCELLED','PARTIAL'].includes(a.status)),
  'NATIVE_TEMPORAL_SUFFIX_ACTORS_UNSETTLED');
 for(const invocation of revision.invocations??[]) {
  const actor=actors.find(a=>a.invocation_ref===invocation.invocation_ref);
  need(actor&&actor.status==='SUCCEEDED'&&hash(actor)===hash(invocation)&&hash(ledger.attempts.filter(a=>a.agent_scope===actor.agent_scope&&a.kind==='GENERATION').map(a=>a.request_ref))===hash(actor.request_refs),
   'NATIVE_TEMPORAL_SUFFIX_LIBRARY_ACTOR_CHANGED');
 }
 // A program-completed empty identity stage has no native invocation and remains valid.
 const temporal=store.getRecord('native_document_temporal_interpretation_v1',upstreamRunId),publication=store.getRecord('native_document_temporal_publication_v1',upstreamRunId);
 need(temporal?.library_id===libraryId&&temporal.source_snapshot_ref===snapshotId&&temporal.sealed===false&&temporal.finished===false
  &&temporal.interpretations?.length===0&&publication?.status!=='CONFIRMED'&&!ledger.checkpoints.some(c=>c.stage==='TEMPORAL_PUBLICATION_CONFIRMED'),
  'NATIVE_TEMPORAL_SUFFIX_STATE_UNSUPPORTED');
 const active=store.getRecord('native_library_knowledge_active_v1',libraryId),basis={revision_ref:active?.revision_ref??null,record_sha256:active?.record_sha256??null};
 need(hash(basis)===hash(revision.library_basis)&&hash(input.library_basis)===hash(revision.library_basis),'NATIVE_TEMPORAL_SUFFIX_ACTIVE_BASIS_CHANGED');
 const semanticManifest=checked(store.listRecords('native_extraction_window_manifest_v1').find(r=>r.run_id===upstreamRunId),'NATIVE_TEMPORAL_SUFFIX_SEMANTIC_CHANGED');
 const semanticQuality=[];
 const semantic=store.listRecords('native_semantic_window_binding_v1').filter(b=>b.run_id===upstreamRunId).map(binding=>{
  checked(binding,'NATIVE_TEMPORAL_SUFFIX_SEMANTIC_CHANGED');const pkg=readSemanticPackage({store,catalog,libraryId,snapshotId,packageRef:binding.package_ref});
  const window=semanticManifest.manifest.windows.find(w=>w.window_ref===binding.window_ref);
  need(pkg.record_sha256===binding.package_sha256&&window&&hash(window)===pkg.window_sha256,'NATIVE_TEMPORAL_SUFFIX_SEMANTIC_CHANGED');
  semanticQuality.push({package_ref:pkg.package_ref,partial:pkg.partial===true,content_status:pkg.content_status??null,gaps:clone(pkg.gaps??[])});
  return {binding_id:upstreamRunId+':'+binding.window_ref,binding_sha256:hash(binding),package_ref:pkg.package_ref,package_sha256:pkg.record_sha256,item_count:pkg.items.length,window:clone(window)};
 });
 need(semantic.length>0,'NATIVE_TEMPORAL_SUFFIX_SEMANTIC_REQUIRED');
 const windowResults=store.listRecords('native_extraction_window_result_v1').filter(r=>r.run_id===upstreamRunId
  &&semanticManifest.manifest.windows.some(w=>w.window_ref===r.window_ref)).map(r=>{checked(r,'NATIVE_TEMPORAL_SUFFIX_WINDOW_RESULT_CHANGED');return {
   window_ref:r.window_ref,partial:r.response?.result?.partial===true,gaps:clone(r.response?.result?.gaps??[]),result_sha256:r.record_sha256};});
 const windowSummary=clone(state.extraction_window_summary??null),semanticGaps=semanticQuality.flatMap(p=>p.gaps);
 const windowPartial=windowSummary?.partial===true||windowResults.some(w=>w.partial||w.gaps.length>0);
 const semanticPartial=semanticQuality.some(p=>p.partial)||semanticGaps.length>0;
 const sourceQuality={partial:windowPartial||semanticPartial,reasons:[...new Set([...(windowPartial?['EXTRACTION_WINDOWS_HAVE_GAPS']:[]),
  ...(semanticPartial?['SEMANTIC_PACKAGES_HAVE_GAPS']:[]),...(windowPartial?[...(windowSummary?.partial_reasons??[]),...(windowSummary?.reasons??[])]:[])])],
  extraction_window_summary:windowSummary,window_results:windowResults,semantic_packages:semanticQuality,semantic_gaps:semanticGaps};
 return {kind:'DOCUMENT_TEMPORAL_ONLY',source_run_id:upstreamRunId,library_id:libraryId,source_snapshot_ref:snapshotId,source_fingerprint:source.fingerprint,
  library_revision_ref:revision.revision_ref,library_revision_sha256:revision.record_sha256,knowledge_count:revision.knowledge.length,
  identity_status:revision.identity?.stage_status,ontology_status:revision.ontology?.stage_status,semantic_packages:semantic,library_basis:clone(basis),source_quality:sourceQuality,
  pins:{row:hash(row),ledger:hash(ledger),state:hash(state),artifact_ref:checkpoint.artifact_ref,artifact:hash(artifact),pointer:hash(pointer),input:hash(input),receipt:hash(receipt),
   identity:hash(identity),ontology:hash(ontology),temporal:hash(temporal),publication:hash(publication??null),actors:hash(actors),semantic_manifest:hash(semanticManifest),source_quality_sha256:hash(sourceQuality)},
  skipped_generation_scopes:['CQ','FAMILY','SEMANTIC','ORGANIZATION','RELATION_REVIEW','IDENTITY','ONTOLOGY']};
}

export function importNativeTemporalLibrarySuffix({store,catalog,libraryId,snapshotId,runId,plan}) {
 need(plan?.resume_scope==='DOCUMENT_TEMPORAL_ONLY'&&plan.suffix?.kind==='DOCUMENT_TEMPORAL_ONLY'&&runId!==plan.upstream_run_id,'NATIVE_TEMPORAL_SUFFIX_PLAN_REQUIRED');
 const source=prepareNativeTemporalLibrarySuffix({store,catalog,libraryId,snapshotId,upstreamRunId:plan.upstream_run_id,confirmedUpstream:plan.prefix});
 need(source&&hash(source)===hash(plan.suffix),'NATIVE_TEMPORAL_SUFFIX_PLAN_CHANGED');
 const original=checked(store.getRecord('native_library_knowledge_revision_v1',source.library_revision_ref),'NATIVE_TEMPORAL_SUFFIX_LIBRARY_CHANGED');
 const originalInput=store.getRecord('native_library_knowledge_input_v1',source.source_run_id);
 const origin={run_id:source.source_run_id,revision_ref:original.revision_ref,record_sha256:original.record_sha256,checkpoint_ref:source.pins.artifact_ref,
  plan_sha256:hash(plan),identity_sha256:hash(original.identity),ontology_sha256:hash(original.ontology),knowledge_sha256:hash(original.knowledge),
  invocation_refs:(original.invocations??[]).map(a=>a.invocation_ref),source_quality_sha256:source.pins.source_quality_sha256,execution:'REUSED_COMPLETED_LIBRARY_NO_AGENT_REPLAY'};
 const {record_sha256:oldSha,...body}=clone(original),ref='retained_library_revision_'+hash([runId,origin]);
 const next={...body,run_id:runId,revision_ref:ref,invocations:[],retained_library_origin:origin};
 // Knowledge, canonical IDs, definition refs and decisions stay byte-for-byte inherited; only the owner envelope changes.
 const revision={...next,record_sha256:hash(next)},input={...clone(originalInput),run_id:runId,retained_library_origin:origin};
 const immutable=(kind,key,value)=>{const old=store.getRecord(kind,key);need(!old||hash(old)===hash(value),'NATIVE_TEMPORAL_SUFFIX_IMPORT_CONFLICT');if(!old)store.putRecord(kind,key,value);};
 const packages=source.semantic_packages.map(pin=>readSemanticPackage({store,catalog,libraryId,snapshotId,packageRef:pin.package_ref}));
 store.transaction(()=>{
  const current=prepareNativeTemporalLibrarySuffix({store,catalog,libraryId,snapshotId,upstreamRunId:plan.upstream_run_id,confirmedUpstream:plan.prefix});
  need(hash(current)===hash(plan.suffix),'NATIVE_TEMPORAL_SUFFIX_PLAN_CHANGED');
  immutable('native_library_knowledge_input_v1',runId,input);immutable('native_library_knowledge_revision_v1',ref,revision);
  for(const [index,pin]of source.semantic_packages.entries())bindNativeSemanticPackage({store,runId,window:pin.window,p:packages[index],reused:true});
  immutable('native_library_knowledge_projection_v1',runId,{run_id:runId,library_id:libraryId,revision_ref:ref,record_sha256:revision.record_sha256});
  immutable('native_temporal_library_suffix_import_v1',runId,{run_id:runId,library_id:libraryId,source_snapshot_ref:snapshotId,origin,
   source_plan_sha256:hash(plan),semantic_package_pins:clone(source.semantic_packages),source_quality:clone(source.source_quality),models_replayed:0});
 });
 return {libraryRevision:revision,semanticPackages:packages,origin,summary:clone(plan.summary),sourceQuality:clone(source.source_quality),build:{run_id:runId,source_snapshot_ref:snapshotId,source_current:true,
  knowledge:clone(revision.knowledge),library_knowledge:revision,library_revision_ref:ref,semantic_base:{records:packages.reduce((n,p)=>n+p.items.length,0),semantic_quality:'INHERITED_NOT_REEVALUATED'},
  processing_summary:{mode:'REUSED_COMPLETED_LIBRARY',knowledge:revision.knowledge.length,generation_calls:0},retained_library_origin:origin,source_quality:clone(source.source_quality),
  completion:{task_ended:false,semantic_quality:'INHERITED_NOT_REEVALUATED',ontology_stage_status:revision.ontology?.stage_status,
   source_partial:source.source_quality.partial,source_partial_reasons:clone(source.source_quality.reasons)}}};
}
