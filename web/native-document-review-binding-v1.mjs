/** Server-verified document-run origin. An index namespace alone grants no document actions. */
import {hash} from './cq-discovery-store-v2.mjs';
export function nativeDocumentReviewBinding({store,libraryId,revision,active}){
 const {record_sha256,...body}=revision??{};
 if(!revision||record_sha256!==hash(body)||!active||revision.policy!=='SIMPLIFIED_LIBRARY_KNOWLEDGE_V1'||revision.library_id!==libraryId||revision.revision_ref!==active.revision_ref||revision.record_sha256!==active.record_sha256||revision.run_id!==active.run_id||revision.source_snapshot_ref!==active.source_snapshot_ref)return null;
 const run=store.getRecord('native_product_run_v1',revision.run_id);
 if(!run||run.run_id!==revision.run_id||run.library_id!==libraryId||run.snapshot_id!==revision.source_snapshot_ref||run.build_flow_policy!=='SIMPLIFIED_SOURCE_BLOCK_V1'||!['SUCCEEDED','PARTIALLY_READY'].includes(run.status)||!/^nrun_[a-f0-9]{32}$/.test(run.run_id))return null;
 return {policy:'NATIVE_DOCUMENT_REVIEW_BINDING_V1',library_id:libraryId,document_run_id:run.run_id,source_snapshot_ref:run.snapshot_id,revision_ref:revision.revision_ref,record_sha256:revision.record_sha256,build_flow_policy:run.build_flow_policy};
}
