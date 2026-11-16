import {clone,hash,need} from './cq-discovery-store-v2.mjs';
import {domainRows} from './native-domain-knowledge-v1.mjs';
import {normalizeTemporalReception,TEMPORAL_RECEPTION_COMPAT_VERSION} from './native-temporal-reception-compat-v1.mjs';
const KIND='native_simplified_temporal_v1';
function checkedSidecar(side,{record,stageRunId,snapshotId}){
 const {binding_sha256,...body}=side;
 need(binding_sha256===hash(body)&&side.record_ref===record.record_ref&&side.record_sha256===hash(record)&&side.stage_run_id===stageRunId&&side.source_snapshot_ref===snapshotId&&hash(side.source_refs)===hash(record.source_refs),'SIMPLIFIED_TEMPORAL_SIDECAR_INVALID');
 if(side.reception_compat)need(side.reception_compat.version===TEMPORAL_RECEPTION_COMPAT_VERSION&&side.reception_compat.raw_sha256===hash(side.raw_valid_time??null)&&side.reception_compat.normalized_sha256===hash(side.valid_time),'SIMPLIFIED_TEMPORAL_COMPAT_BINDING_INVALID');
 return body;
}
/** Capture business time from the actual persisted receiver proposal, never a model-supplied record ID. */
export function captureSimplifiedTemporal({store,stageRunId,snapshotId,receipt,knowledge}){
 const proposal=store.getRecord('native_knowledge_proposal_v1',receipt.proposal_ref);
 need(proposal&&proposal.name==='SUBMIT'&&proposal.run_id===stageRunId&&proposal.source_snapshot_ref===snapshotId&&proposal.raw_hash===hash(proposal.raw),'SIMPLIFIED_TEMPORAL_PROPOSAL_BINDING_INVALID');
 const rows=domainRows(proposal.raw),bound=[];
 for(const ref of receipt.knowledge_refs??[]){
  const index=rows.findIndex((row,i)=>'knowledge_'+hash([receipt.proposal_ref,row.domain_input_index??i])===ref),record=knowledge.find(r=>r.record_ref===ref);
  need(index>=0&&record&&record.run_id===stageRunId&&record.source_snapshot_ref===snapshotId&&record.source_refs?.length,'SIMPLIFIED_TEMPORAL_RECORD_BINDING_INVALID');
  const raw=rows[index]?.valid_time??null,old=store.getRecord(KIND,ref);
  // A legacy signed sidecar is immutable. Replay only validates its actual
  // binding; compatibility is an explicitly labelled read-only overlay below.
  if(old){checkedSidecar(old,{record,stageRunId,snapshotId});need(old.proposal_ref===receipt.proposal_ref&&old.proposal_index===index&&old.proposal_raw_sha256===proposal.raw_hash&&hash(old.raw_valid_time??null)===hash(raw),'SIMPLIFIED_TEMPORAL_BINDING_CHANGED');bound.push(ref);continue;}
  const compatible=normalizeTemporalReception(raw,{timeText:record.time_text??null});
  const body={record_ref:ref,stage_run_id:stageRunId,source_snapshot_ref:snapshotId,source_refs:clone(record.source_refs),proposal_ref:receipt.proposal_ref,proposal_raw_sha256:proposal.raw_hash,proposal_index:index,record_sha256:hash(record),...compatible};
  store.putRecord(KIND,ref,{...body,binding_sha256:hash(body)});bound.push(ref);
 }
 return bound;
}
export function readSimplifiedTemporal({store,stageRunId,snapshotId,knowledge}){
 return knowledge.map(record=>{const side=store.getRecord(KIND,record.record_ref);if(!side)return {...clone(record),valid_time:{kind:'UNRESOLVED',time_text:record.time_text??null,gaps:['TIME_NOT_CAPTURED']}};
  const body=checkedSidecar(side,{record,stageRunId,snapshotId}),{raw_valid_time,valid_time,...binding}=body,reception_compat=body.reception_compat;
  if(reception_compat)return {...clone(record),valid_time:clone(valid_time),raw_valid_time:clone(raw_valid_time),temporal_reception:{...clone(reception_compat),mode:'CAPTURED_COMPATIBILITY'},temporal_binding:{...binding,binding_sha256:side.binding_sha256}};
  const compatible=normalizeTemporalReception(raw_valid_time,{timeText:record.time_text??null});
  return {...clone(record),valid_time:clone(valid_time),raw_valid_time:clone(raw_valid_time),temporal_reception:{mode:'LEGACY_BINDING_PRESERVED',origin_sidecar_binding_sha256:side.binding_sha256,stored_valid_time_sha256:hash(valid_time)},temporal_compatibility_suggestion:{...compatible.reception_compat,mode:'READ_ONLY_LEGACY_COMPAT_SUGGESTION',suggested_valid_time:clone(compatible.valid_time),suggestion_is_published:false,origin_sidecar_binding_sha256:side.binding_sha256,stored_valid_time:clone(valid_time),stored_valid_time_sha256:hash(valid_time),overlay_sha256:hash({origin_binding_sha256:side.binding_sha256,raw_sha256:compatible.reception_compat.raw_sha256,normalized_sha256:compatible.reception_compat.normalized_sha256,version:compatible.reception_compat.version})},temporal_binding:{...binding,binding_sha256:side.binding_sha256}};
 });
}
