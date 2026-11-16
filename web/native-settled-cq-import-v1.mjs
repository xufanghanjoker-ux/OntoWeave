/** Purpose-limited CQ input. The backing frozen evidence is never extraction input. */
import {hash,clone,need} from './cq-discovery-store-v2.mjs';
import {readNativeSettledSemanticImport} from './native-settled-semantic-import-v1.mjs';
const KIND='native_settled_cq_import_v1';
export function installNativeSettledCQImport({store,catalog,libraryId,snapshotId,evidenceRef}){
 const source=readNativeSettledSemanticImport({store,catalog,libraryId,snapshotId,importRef:evidenceRef});
 const body={policy:'SETTLED_CQ_ONLY_IMPORT_V1',library_id:libraryId,source_snapshot_ref:snapshotId,evidence_ref:evidenceRef,evidence_sha256:source.receipt_sha256,prefix_sha256:hash(source.prefix)};
 const ref='settled_cq_import_'+hash(body),receipt={...body,import_ref:ref};receipt.record_sha256=hash(receipt);
 const old=store.getRecord(KIND,ref);need(!old||hash(old)===hash(receipt),'NATIVE_CQ_IMPORT_CONFLICT');if(!old)store.putRecord(KIND,ref,receipt);
 return readNativeSettledCQImport({store,catalog,libraryId,snapshotId,importRef:ref});
}
export function readNativeSettledCQImport({store,catalog,libraryId,snapshotId,importRef}){
 need(/^settled_cq_import_[a-f0-9]{64}$/.test(importRef??''),'NATIVE_CQ_IMPORT_REF_INVALID');
 const receipt=store.getRecord(KIND,importRef),{record_sha256,import_ref,...body}=receipt??{};
 need(receipt&&record_sha256===hash({import_ref,...body})&&import_ref===importRef&&importRef==='settled_cq_import_'+hash(body)&&body.policy==='SETTLED_CQ_ONLY_IMPORT_V1'&&body.library_id===libraryId&&body.source_snapshot_ref===snapshotId,'NATIVE_CQ_IMPORT_CHANGED');
 const source=readNativeSettledSemanticImport({store,catalog,libraryId,snapshotId,importRef:body.evidence_ref});
 need(source.receipt_sha256===body.evidence_sha256&&hash(source.prefix)===body.prefix_sha256,'NATIVE_CQ_IMPORT_CHANGED');
 const {import_ref:backing,...prefix}=clone(source.prefix);
 return {import_ref:importRef,receipt_sha256:record_sha256,source_run_id:source.source_run_id,prefix:{...prefix,version:'SETTLED_CQ_IMPORT_PREFIX_V1',import_ref:importRef},consumed:['CQ','FAMILY','SOURCE_CHUNK_PLAN'],semantic_packages_consumed:false,knowledge_consumed:false};
}
