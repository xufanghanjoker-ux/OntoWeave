/** Explicit reuse of saved initial output. Never replays proposals or edits its origin. */
import {clone,hash,need} from './cq-discovery-store-v2.mjs';
import {domainRows} from './native-domain-knowledge-v1.mjs';
import {readSemanticPackage,SEMANTIC_STAGE_POLICY} from './native-semantic-package-v1.mjs';
const IMPORT='native_organization_draft_import_v1';
const checked=(r,code)=>{need(r&&r.record_sha256===hash(Object.fromEntries(Object.entries(r).filter(([k])=>k!=='record_sha256'))),code);return r;};
export function prepareNativeConfirmedOrganizationDrafts({store,catalog,libraryId,snapshotId,upstreamRunId}){
 need(catalog.isCurrent(snapshotId,libraryId),'NATIVE_ORGANIZATION_DRAFT_SOURCE_STALE');
 const source=catalog.get(snapshotId,libraryId),ledger=store.getRecord('native_full_run_v1',upstreamRunId);
 need(ledger?.input?.extraction_stage_policy===SEMANTIC_STAGE_POLICY&&['FAILED','STOPPED'].includes(ledger.status)&&ledger.attempts.length>0&&ledger.attempts.every(a=>a.outcome==='RETURNED'),'NATIVE_ORGANIZATION_DRAFT_ORIGIN_UNSETTLED');
 const allActors=store.listRecords('native_agent_invocation_v1').filter(a=>a.run_id===upstreamRunId);need(allActors.length>0&&allActors.every(a=>['SUCCEEDED','FAILED','STOPPED','CANCELLED'].includes(a.status)&&a.ended_at!=null),'NATIVE_ORGANIZATION_DRAFT_ACTOR_NOT_ENDED');
 const manifest=checked(store.listRecords('native_extraction_window_manifest_v1').find(m=>m.run_id===upstreamRunId),'NATIVE_ORGANIZATION_DRAFT_MANIFEST_CHANGED');
 const windows=manifest.manifest.windows.map(window=>{
  const stageRunId=upstreamRunId+'_window_'+hash(window.window_ref).slice(0,24),meta=store.getRecord('native_extraction_window_stage_v1',stageRunId),head=store.getRecord('native_knowledge_head_v1',stageRunId),state=store.getRecord('native_build_state_v1',stageRunId),scope=store.getRecord('native_knowledge_scope_v1',stageRunId)??null;
  need(meta?.parent_run_id===upstreamRunId&&meta.library_id===libraryId&&meta.source_snapshot_ref===snapshotId&&meta.window_ref===window.window_ref&&meta.window_sha256===hash(window)&&source.documents.some(d=>d.doc_id===window.doc_ref&&d.revision===window.revision),'NATIVE_ORGANIZATION_DRAFT_WINDOW_CHANGED');
  need(head?.knowledge.length>0&&!state?.extraction_complete&&state?.extraction_stage_policy===SEMANTIC_STAGE_POLICY&&state?.extraction_review_policy==='LOCAL_REVIEW_ONCE_V1'&&!scope?.subjects?.length&&!scope?.tasks?.length,'NATIVE_ORGANIZATION_DRAFT_STAGE_UNSUPPORTED');
  const binding=checked(store.getRecord('native_semantic_window_binding_v1',upstreamRunId+':'+window.window_ref),'NATIVE_ORGANIZATION_DRAFT_SEMANTIC_BINDING_CHANGED'),p=readSemanticPackage({store,catalog,libraryId,snapshotId,packageRef:binding.package_ref});
  need(binding.package_sha256===p.record_sha256&&p.window_sha256===hash(window),'NATIVE_ORGANIZATION_DRAFT_SEMANTIC_CHANGED');
  const proposals=store.listRecords('native_knowledge_proposal_v1').filter(p=>p.run_id===stageRunId).sort((a,b)=>a.proposal_ref.localeCompare(b.proposal_ref));
  need(proposals.length>0&&proposals.every(p=>p.name==='SUBMIT'&&p.raw_hash===hash(p.raw)&&p.source_snapshot_ref===snapshotId&&p.semantic_policy==='DOMAIN_KNOWLEDGE_V1'&&p.extraction_pass?.phase==='INITIAL'),'NATIVE_ORGANIZATION_DRAFT_PROPOSAL_CHANGED');
  const refs=[],summaryItems=head.processing_summary.items;
  const proposalPins=proposals.map(proposal=>{
   const receipt=store.getRecord('native_knowledge_receipt_v1',proposal.proposal_ref),items=summaryItems.filter(i=>i.proposal_ref===proposal.proposal_ref),rows=domainRows(proposal.raw),expected=items.filter(i=>i.status!=='SKIPPED').map(i=>'knowledge_'+hash([proposal.proposal_ref,i.index]));
   need(receipt?.saved===true&&receipt.processed===true&&receipt.proposal_ref===proposal.proposal_ref&&receipt.received===rows.length&&items.length===rows.length&&new Set(items.map(i=>i.index)).size===rows.length&&items.every(i=>Number.isSafeInteger(i.index)&&i.index>=0&&i.index<rows.length)&&hash(receipt.knowledge_refs)===hash(expected),'NATIVE_ORGANIZATION_DRAFT_RECEIPT_CHANGED');
   for(const [status,key]of [['STRUCTURED','structured'],['TEXT','text'],['SKIPPED','skipped']])need(receipt[key]===items.filter(i=>i.status===status).length,'NATIVE_ORGANIZATION_DRAFT_RECEIPT_CHANGED');
   const actors=store.listRecords('native_agent_invocation_v1').filter(a=>a.run_id===upstreamRunId&&a.invocation_ref===proposal.identity?.invocation_ref&&a.role==='EXTRACTION'&&a.agent_scope===window.window_ref+':ORGANIZATION');
   need(actors.length===1&&actors[0].origin==='CODEX_NATIVE_APP_SERVER'&&['SUCCEEDED','FAILED','STOPPED','CANCELLED'].includes(actors[0].status)&&actors[0].ended_at!=null,'NATIVE_ORGANIZATION_DRAFT_ACTOR_NOT_ENDED');
   const own=ledger.attempts.filter(a=>a.agent_scope===actors[0].agent_scope&&a.kind==='GENERATION'&&a.role==='EXTRACTION');need(own.length>0&&hash(own.map(a=>a.request_ref))===hash(actors[0].request_refs),'NATIVE_ORGANIZATION_DRAFT_ACTOR_REQUESTS_CHANGED');
   refs.push(...receipt.knowledge_refs);return {proposal_ref:proposal.proposal_ref,raw_sha256:proposal.raw_hash,proposal_sha256:hash(proposal),receipt_sha256:hash(receipt),actor_sha256:hash(actors[0])};
  });
  const recordRefs=head.knowledge.map(k=>k.record_ref);
  need(new Set(refs).size===refs.length&&refs.length===recordRefs.length&&new Set(recordRefs).size===recordRefs.length&&recordRefs.every(ref=>refs.includes(ref))&&head.knowledge.every(k=>k.run_id===stageRunId&&k.source_snapshot_ref===snapshotId&&k.extraction_pass?.phase==='INITIAL'&&proposals.some(p=>p.proposal_ref===k.proposal_ref)&&k.semantic_lineage?.package_ref===p.package_ref&&k.semantic_lineage.semantic_refs.every(r=>p.items.some(i=>i.semantic_ref===r))),'NATIVE_ORGANIZATION_DRAFT_HEAD_CHANGED');
  const reviewInput=store.getRecord('native_relation_review_input_v1',stageRunId);if(reviewInput)need(hash(reviewInput.knowledge_snapshot)===hash(head.knowledge)&&reviewInput.input_sha256===hash({package_ref:p.package_ref,package_sha256:p.record_sha256,knowledge:head.knowledge}),'NATIVE_ORGANIZATION_DRAFT_REVIEW_INPUT_CHANGED');
  return {window_ref:window.window_ref,window_sha256:hash(window),stage_run_id:stageRunId,stage_metadata_sha256:hash(meta),head_sha256:hash(head),knowledge_sha256:hash(head.knowledge),knowledge_count:head.knowledge.length,scope_sha256:hash(scope),package_ref:p.package_ref,package_sha256:p.record_sha256,proposals:proposalPins};
 });
 return {version:'CONFIRMED_ORGANIZATION_DRAFTS_V1',upstream_run_id:upstreamRunId,source_snapshot_ref:snapshotId,source_fingerprint:source.fingerprint,manifest_sha256:manifest.record_sha256,ledger_sha256:hash(ledger),windows};
}
export function importNativeConfirmedOrganizationDraft({store,catalog,libraryId,snapshotId,confirmed,window,stageRunId}){
 need(hash(confirmed)===hash(prepareNativeConfirmedOrganizationDrafts({store,catalog,libraryId,snapshotId,upstreamRunId:confirmed.upstream_run_id})),'NATIVE_ORGANIZATION_DRAFT_REUSE_CHANGED');
 const entry=confirmed.windows.find(w=>w.window_ref===window.window_ref);need(entry?.window_sha256===hash(window),'NATIVE_ORGANIZATION_DRAFT_MANIFEST_CHANGED');
 const destination=store.getRecord('native_extraction_window_stage_v1',stageRunId);need(destination?.window_ref===window.window_ref&&destination.window_sha256===hash(window)&&destination.library_id===libraryId&&destination.source_snapshot_ref===snapshotId&&destination.parent_run_id!==confirmed.upstream_run_id,'NATIVE_ORGANIZATION_DRAFT_DESTINATION_INVALID');
 const prior=store.getRecord(IMPORT,stageRunId),pin=hash([confirmed,entry]);if(prior){need(prior.confirmation_sha256===pin,'NATIVE_ORGANIZATION_DRAFT_IMPORT_CONFLICT');return clone(prior);}
 const oldHead=store.getRecord('native_knowledge_head_v1',stageRunId);need(!oldHead||oldHead.knowledge.length===0,'NATIVE_ORGANIZATION_DRAFT_IMPORT_NOT_EMPTY');
 const origin={run_id:confirmed.upstream_run_id,stage_run_id:entry.stage_run_id,head_sha256:entry.head_sha256,knowledge_sha256:entry.knowledge_sha256},source=store.getRecord('native_knowledge_head_v1',entry.stage_run_id);
 const knowledge=source.knowledge.map(k=>({...clone(k),run_id:stageRunId,organization_draft_origin:origin,evidence:(k.evidence??[]).map(e=>{const {record_sha256,...body}=clone(e),value={...body,run_id:stageRunId,organization_draft_origin:origin};return {...value,...(record_sha256?{record_sha256:hash(value)}:{})};})}));
 const receipt={run_id:stageRunId,confirmation_sha256:pin,origin,knowledge_count:knowledge.length,proposals:entry.proposals.map(p=>({proposal_ref:p.proposal_ref,origin_run_id:confirmed.upstream_run_id,receipt_sha256:p.receipt_sha256})),saved:true,initial_drafts_imported:true,requests_resent:0,semantic_quality:'NOT_CERTIFIED'};
 store.transaction(()=>{need(!store.getRecord(IMPORT,stageRunId),'NATIVE_ORGANIZATION_DRAFT_IMPORT_CONFLICT');store.putRecord('native_knowledge_head_v1',stageRunId,{revision:'knowledge_revision_'+hash([stageRunId,pin]),knowledge,processing_summary:clone(source.processing_summary)});store.putRecord(IMPORT,stageRunId,receipt);});return clone(receipt);
}
