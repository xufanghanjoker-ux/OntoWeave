import {assertSimplifiedRecovery} from './native-simplified-recovery-v1.mjs';
import {simplifiedPublicationRun} from './native-simplified-window-outcomes-v1.mjs';
/** New source path; no legacy semantic/review/global-ontology execution. */
import {resolve,join} from 'node:path';
import {hash,need} from './cq-discovery-store-v2.mjs';
import {createNativeExtractionWindowPlan,createNativeHybridExtractionWindowPlan} from './native-extraction-window-plan-v1.mjs';
import {createNativeHybridSourceRecords} from './native-hybrid-source-records-v1.mjs';
import {createNativeSourceRetrievalRecords} from './native-build-host-v1.mjs';
import {runNativeSimplifiedExtraction} from './native-simplified-extraction-v1.mjs';
import {createNativeSimplifiedIndex} from './native-simplified-index-v1.mjs';
export async function runNativeSimplifiedBuild({store,catalog,libraryId,snapshotId,parentRun,cqInput,families,hybridPlan,agentRunner,upstream,embed,embeddingSpace,capability,runtimeDirectory,onInvocation,onCommit=()=>{},temporalPort=null,settledProposalReplay=null,cqOriginInput=null,confirmedSimplifiedRecovery=null}){
 need(temporalPort?.policy==='SIMPLIFIED_TEMPORAL_PUBLICATION_V1'&&typeof temporalPort.publishBuild==='function','NATIVE_SIMPLIFIED_TEMPORAL_PORT_REQUIRED');
 const startedAt=Date.now();const source=catalog.get(snapshotId,libraryId),input=parentRun.state().input,runId=parentRun.state().run_id;
 need(input.build_flow_policy==='SIMPLIFIED_SOURCE_BLOCK_V1'&&!input.extraction_stage_policy&&!input.extraction_review_policy&&!input.organization_relation_review_policy,'NATIVE_SIMPLIFIED_LEGACY_POLICY_CONFLICT');
 const blockCQContext=input.block_cq_policy==='BLOCK_CQ_CONTEXT_V4'?{originalCQInput:cqOriginInput,readReceipts:[...new Set([...cqInput.items,...(cqOriginInput?.items??[])].flatMap(q=>q.read_receipt_refs??[]))].map(ref=>store.getRecord('native_cq_chunk_read_receipt_v1',ref)).filter(Boolean)}:null;
 const manifest=hybridPlan?createNativeHybridExtractionWindowPlan({snapshot:source,hybridPlan,cqInput,familyInput:cqInput,families,blockCQContext}):createNativeExtractionWindowPlan({snapshot:source,cqInput,families,windowTokens:input.extraction_window_policy.window_tokens});
 const sources=hybridPlan?createNativeHybridSourceRecords({snapshot:source,plan:hybridPlan}):createNativeSourceRetrievalRecords({snapshot:source,splitLargeBlocks:true});
 store.putRecord('native_simplified_manifest_v1',runId,{run_id:runId,manifest,manifest_sha256:hash(manifest),source_fingerprint:source.fingerprint});
 const extractionStartedAt=Date.now();const writer=createNativeSimplifiedIndex({store,catalog,libraryId,snapshotId,parentRun:simplifiedPublicationRun(parentRun),sources,cqInput,families,embed,embeddingSpace,capability,onCommit});
 if(confirmedSimplifiedRecovery){assertSimplifiedRecovery({store,catalog,libraryId,snapshotId,confirmed:confirmedSimplifiedRecovery});need(hash(manifest)===confirmedSimplifiedRecovery.manifest_sha256,'NATIVE_SIMPLIFIED_RECOVERY_MANIFEST_CHANGED');}
 const sourceProducer=settledProposalReplay?.run??runNativeSimplifiedExtraction;
 const result=await sourceProducer({store,catalog,libraryId,snapshotId,parentRun,manifest,cqInput,families,agentRunner,upstream,runtimeDirectory:join(runtimeDirectory,'simplified'),skillPaths:[resolve(import.meta.dirname,'../docs/skill-drafts/lightog-simplified-extraction/SKILL.md')],confirmedRecovery:confirmedSimplifiedRecovery,onSaved:writer.onSaved,getPreviousKnowledge:writer.getPreviousKnowledge,readCanonicalEntities:writer.readCanonicalEntities,onInvocation,concurrency:input.extraction_window_policy.concurrency});
 const localIdentity=await writer.alignLocalIdentities({agentRunner,upstream,runtimeDirectory:join(runtimeDirectory,'local-identity'),onInvocation});if(localIdentity)result.local_identity=localIdentity;
 if(parentRun.state().status==='UNKNOWN_HOLD'&&result.partial_summary){result.partial=true;result.partial_summary.status='UNKNOWN_HOLD';result.partial_summary.unknown_request_refs=parentRun.state().attempts.filter(a=>a.outcome==='UNKNOWN').map(a=>a.request_ref);}
 if(result.partial_summary)writer.setCoverage(result.partial_summary);
 const held=parentRun.state().status==='UNKNOWN_HOLD',effectiveCapability=held?'LEXICAL':capability;
 const extractionEndedAt=Date.now(),indexed=await writer.finish({localOnly:held}),temporalStartedAt=Date.now(),temporal=await temporalPort.publishBuild({store,libraryId,runId,snapshotId,source,libraryRevision:indexed.revision,capability:effectiveCapability,embeddingSpace:held?null:embeddingSpace,embed:effectiveCapability==='LEXICAL'?null:writer.embed});
 if(result.partial_summary){result.partial_summary.publication={status:result.partial?'CONFIRMED_PARTIAL':'CONFIRMED',capability:effectiveCapability,readback_verified:temporal.publication.state==='CONFIRMED',run_status_preserved:true};store.putRecord('native_simplified_partial_summary_v1',runId,result.partial_summary);}

 const active=store.getRecord('native_library_knowledge_active_v1',libraryId),revision=store.getRecord('native_library_knowledge_revision_v1',active.revision_ref);need(active.run_id===runId&&temporal.view.view_bindings.library_revision_ref===revision.revision_ref,'SIMPLIFIED_TEMPORAL_ACTIVE_BINDING_CHANGED');
 return {result,...indexed,revision,index:writer.snapshot(),readback:{verified:temporal.publication.state==='CONFIRMED',source:writer.query({view:'SOURCE',query:'',limit:1}),knowledge:writer.query({view:'EXTRACTED_KNOWLEDGE',query:'',limit:1}),knowledge_graph:writer.graph({view:'EXTRACTED_KNOWLEDGE'}),temporal:{view_ref:temporal.view.view_ref,activation:temporal.view.selected_activation,bindings:temporal.view.view_bindings}},temporal,manifest,timing:{source_preparation_ms:extractionStartedAt-startedAt,source_block_span_ms:extractionEndedAt-extractionStartedAt,vector_finalization_ms:temporalStartedAt-extractionEndedAt,temporal_finalization_ms:Date.now()-temporalStartedAt,wall_ms:Date.now()-startedAt,overlap:'Incremental lexical commits occur inside source block span; do not add their durations to that span.'}};
}
