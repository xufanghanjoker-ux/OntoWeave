/** Only explicit structural entity references are resolved; source statements/versions stay immutable. */
import {clone, hash, need} from './cq-discovery-store-v2.mjs';
export const isNativeActionKnowledge = record => record?.action_domain_policy === 'ACTION_DOMAIN_PREPARED_V1';

export function nativeActionIdentityEntities(record) {
  const rows=[...(Array.isArray(record.domain?.entities)?record.domain.entities:[]),
    ...(isNativeActionKnowledge(record)&&Array.isArray(record.action_domain_nodes)?record.action_domain_nodes:[])];
  return isNativeActionKnowledge(record)?rows.filter(entity=>entity.kind!=='MEMORY_RECORD_SOURCE'):rows;
}

export function projectNativeActionIdentityReferences({row,original,resolve,projectEntity}) {
  if(!isNativeActionKnowledge(original))return row;
  need(Array.isArray(original.action_domain_nodes)&&Array.isArray(original.action_domain_edges),'ACTION_IDENTITY_EXTENSION_MISSING');
  const entity = value => {
    const mapped=projectEntity(value);
    if(mapped.resolved_subject_ref)mapped.resolved_subject_ref=resolve(mapped.resolved_subject_ref);
    if(Array.isArray(mapped.resolved_participants))mapped.resolved_participants=mapped.resolved_participants.map(p=>({...p,subject_ref:resolve(p.subject_ref)}));
    return mapped;
  };
  // domain.entities have already received canonical metadata; resolve only their nested structure.
  row.domain.entities=row.domain.entities.map(value=>{
    const mapped=clone(value);
    if(mapped.resolved_subject_ref)mapped.resolved_subject_ref=resolve(mapped.resolved_subject_ref);
    if(Array.isArray(mapped.resolved_participants))mapped.resolved_participants=mapped.resolved_participants.map(p=>({...p,subject_ref:resolve(p.subject_ref)}));
    return mapped;
  });
  row.action_domain_nodes=original.action_domain_nodes.map(entity);
  row.action_domain_edges=original.action_domain_edges.map(edge=>({...clone(edge),source:resolve(edge.source),target:resolve(edge.target)}));
  row.library_projection.source_local_action_domain_nodes=clone(original.library_projection?.source_local_action_domain_nodes??original.action_domain_nodes);
  row.library_projection.source_local_action_domain_edges=clone(original.library_projection?.source_local_action_domain_edges??original.action_domain_edges);
  need(hash(row.native_action)===hash(original.native_action)&&hash(row.source_refs)===hash(original.source_refs)
    && row.record_ref===original.record_ref&&row.knowledge_ref===original.knowledge_ref,'ACTION_IDENTITY_EVIDENCE_CHANGED');
  return row;
}
