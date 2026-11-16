/** Read committed incremental indexes without constructing or resuming a controller. */
import {createNativeBuildIndex} from './native-build-index-v1.mjs';
import {need,hash} from './cq-discovery-store-v2.mjs';

export function readNativeSimplifiedPartialGraph({store,catalog,row,view='EXTRACTED_KNOWLEDGE'}){
 const {run_id:runId,library_id:libraryId,snapshot_id:snapshotId}=row;
 need(catalog.isCurrent(snapshotId,libraryId),'NATIVE_SOURCE_STALE');
 const saved=store.getRecord('native_full_chain_state_v1',runId);
 need(row.build_flow_policy==='SIMPLIFIED_SOURCE_BLOCK_V1'&&saved?.input?.build_flow_policy===row.build_flow_policy&&saved.library_id===libraryId&&saved.snapshot_id===snapshotId,'NATIVE_PARTIAL_GRAPH_SCOPE_INVALID');
 need(['UNKNOWN_HOLD','FAILED','STOPPED'].includes(row.status),'NATIVE_PARTIAL_GRAPH_STATUS_INVALID');
 need(view==='EXTRACTED_KNOWLEDGE','NATIVE_PARTIAL_GRAPH_VIEW_INVALID');
 const published=store.getRecord('native_simplified_partial_publication_v1',runId);
 if(published){const {record_sha256,...body}=published,active=store.getRecord('native_library_knowledge_active_v1',libraryId),ledger=store.getRecord('native_full_run_v1',runId);need(record_sha256===hash(body)&&published.run_status==='UNKNOWN_HOLD'&&published.readback?.verified===true&&published.ledger_sha256===hash(ledger)&&published.publication?.state==='CONFIRMED'&&active?.run_id===runId,'NATIVE_PARTIAL_GRAPH_PUBLICATION_CHANGED');const index=createNativeBuildIndex({store,runId,libraryId,snapshotId,assertOpen(){need(catalog.isCurrent(snapshotId,libraryId),'NATIVE_SOURCE_STALE');}}),graph=index.graph({view});need(graph.status==='READY'&&graph.index_revision===active.knowledge_index_revision&&graph.library_knowledge?.revision_ref===active.revision_ref,'NATIVE_PARTIAL_GRAPH_PUBLICATION_CHANGED');return {...graph,partial:true,complete:false,read_only:true,run_status:row.status,run_reason:row.reason??null,partial_summary:store.getRecord('native_simplified_partial_summary_v1',runId),publication_status:'CONFIRMED_PARTIAL'};}
 const commit=saved.incremental_commit;
 need(commit?.readback_verified===true,'NATIVE_PARTIAL_GRAPH_NOT_COMMITTED');
 const index=createNativeBuildIndex({store,runId,libraryId,snapshotId,assertOpen(){need(catalog.isCurrent(snapshotId,libraryId),'NATIVE_SOURCE_STALE');}});
 const graph=index.graph({view});
 need(graph.status==='READY'&&graph.index_revision===commit.knowledge_index?.index_revision&&graph.library_knowledge?.revision_ref===commit.revision_ref&&graph.library_knowledge?.record_sha256===commit.record_sha256,'NATIVE_PARTIAL_GRAPH_COMMIT_MISMATCH');
 return {...graph,partial:true,complete:false,read_only:true,run_status:row.status,run_reason:row.reason??null};
}
