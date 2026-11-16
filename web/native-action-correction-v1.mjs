/** Readable handles become exact knowledge refs; no lexical matching or broad record replacement. */
import {clone,hash,need,textField} from './cq-discovery-store-v2.mjs';
import {actionKnowledgeRef} from './native-action-domain-adapter-v1.mjs';
import {verifyNativeActionDraft} from './native-action-contract-v1.mjs';

export function mergeNativeActionCorrectionBindings(bindings) {
  const groups=new Map(),retained=[];
  for(const binding of bindings){
    need(binding&&['target_knowledge_ref','replacement_knowledge_ref','reason'].every(key=>textField(binding[key])),'ACTION_CORRECTION_BINDING_INVALID');
    const rows=groups.get(binding.target_knowledge_ref)??[];rows.push(clone(binding));groups.set(binding.target_knowledge_ref,rows);
  }
  const accepted=[];
  for(const rows of groups.values()){
    if(new Set(rows.map(row=>row.replacement_knowledge_ref)).size>1)retained.push(...rows.map(raw=>({raw,reason:'ACTION_CORRECTION_TARGET_AMBIGUOUS'})));
    else accepted.push(rows[0]);
  }
  return {bindings:accepted,retained};
}

export function resolveNativeActionCorrections({libraryId,proposals,currentDrafts,contextKnowledge,targetRecordRefs}) {
  need(Array.isArray(proposals)&&Array.isArray(currentDrafts)&&Array.isArray(contextKnowledge)&&Array.isArray(targetRecordRefs),'ACTION_CORRECTION_INPUT_INVALID');
  const bindings=[],audit=[],retained=[];
  for(const proposal of proposals)try{
    const targetIndex=/^C([1-9][0-9]*)$/.exec(proposal?.target??''),replacementIndex=/^K([1-9][0-9]*)$/.exec(proposal?.replacement??'');
    const target=targetIndex?contextKnowledge[Number(targetIndex[1])-1]:null;
    const replacement=replacementIndex?currentDrafts[Number(replacementIndex[1])-1]:null;
    need(target&&replacement&&textField(proposal.reason),'ACTION_CORRECTION_TARGET_UNRESOLVED');
    verifyNativeActionDraft(target.native_action);verifyNativeActionDraft(replacement);
    need(target.library_id===libraryId&&replacement.library_id===libraryId,'ACTION_CORRECTION_LIBRARY_MISMATCH');
    need(target.native_action.source_origins.some(origin=>targetRecordRefs.includes(origin.source_record_ref)),'ACTION_CORRECTION_TARGET_OUTSIDE_REQUEST');
    need(target.native_action.record_type===replacement.record_type,'ACTION_CORRECTION_KIND_MISMATCH');
    need(Array.isArray(proposal.semantic_refs)&&proposal.semantic_refs.some(ref=>replacement.semantic_lineage.some(item=>item.semantic_ref===ref)),
      'ACTION_CORRECTION_SEMANTIC_BASIS_REQUIRED');
    const binding={target_knowledge_ref:target.knowledge_ref??target.record_ref,replacement_knowledge_ref:actionKnowledgeRef(replacement),reason:proposal.reason};
    need(textField(binding.target_knowledge_ref),'ACTION_CORRECTION_TARGET_UNRESOLVED');
    need(binding.target_knowledge_ref!==binding.replacement_knowledge_ref,'ACTION_CORRECTION_SAME_KNOWLEDGE');
    bindings.push(binding);audit.push({raw:clone(proposal),binding:clone(binding),target_draft_sha256:target.native_action.content_sha256,
      replacement_draft_sha256:replacement.content_sha256,source_record_refs:replacement.source_origins.map(origin=>origin.source_record_ref),
      basis:'MODEL_PROPOSED_EXPLICIT_CORRECTION',truth_verified:false});
  }catch(error){retained.push({raw:clone(proposal),reason:error.code??'ACTION_CORRECTION_INVALID'});}
  const merged=mergeNativeActionCorrectionBindings(bindings);retained.push(...merged.retained);
  return {bindings:merged.bindings,audit,retained,pending:retained.length>0,
    resolution_sha256:hash({bindings:merged.bindings,audit,retained})};
}
