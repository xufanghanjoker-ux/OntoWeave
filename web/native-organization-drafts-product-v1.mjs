/** Product provenance around the native draft validator; no import or model execution here. */
import {hash,need} from './cq-discovery-store-v2.mjs';
import {prepareNativeConfirmedOrganizationDrafts} from './native-confirmed-organization-drafts-v1.mjs';
export function prepareNativeProductOrganizationDrafts({store,catalog,libraryId,upstreamRunId,prepareSemanticReuse}){
 const row=store.getRecord('native_product_run_v1',upstreamRunId),ledger=store.getRecord('native_full_run_v1',upstreamRunId);
 need(row?.library_id===libraryId,'NATIVE_ORGANIZATION_DRAFT_SOURCE_MISMATCH');
 need(['FAILED','STOPPED'].includes(row.status)&&ledger?.status===row.status&&Number.isFinite(row.ended_at)&&Number.isFinite(ledger.ended_at),'NATIVE_ORGANIZATION_DRAFT_ORIGIN_UNSETTLED');
 const semantic=prepareSemanticReuse(upstreamRunId),drafts=prepareNativeConfirmedOrganizationDrafts({store,catalog,libraryId,snapshotId:row.snapshot_id,upstreamRunId});
 need(drafts.source_snapshot_ref===row.snapshot_id&&drafts.windows.length===semantic.confirmed.packages.length&&drafts.windows.every(w=>semantic.confirmed.packages.some(p=>p.window_ref===w.window_ref&&p.window_sha256===w.window_sha256&&p.package_ref===w.package_ref&&p.package_sha256===w.package_sha256)),'NATIVE_ORGANIZATION_DRAFT_SEMANTIC_CHANGED');
 return {...semantic,organizationDrafts:drafts};
}
export function describeNativeProductOrganizationDrafts({store,prepared}){
 const d=prepared.organizationDrafts,packages=[...new Set(d.windows.map(w=>w.package_ref))];
 return {upstream_run_id:d.upstream_run_id,item_count:d.windows.reduce((n,w)=>n+w.knowledge_count,0),window_count:d.windows.length,semantic_item_count:packages.reduce((n,ref)=>n+store.getRecord('native_semantic_package_v1',ref).items.length,0),semantic_origin_run_id:prepared.confirmed.upstream_run_id,validation_sha256:hash(d)};
}
