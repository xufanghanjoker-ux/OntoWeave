/** Full-current-library projection for the shared preparation port; no stores, models or publication. */
import {clone,hash,need,textField} from './cq-discovery-store-v2.mjs';
import {verifyNativeActionPrepared} from './native-action-processing-host-v1.mjs';
import {collectLibraryEntities,libraryIdentityCandidates,projectLibraryIdentities,projectLibraryKnowledge,LIBRARY_KNOWLEDGE_POLICY} from './native-library-knowledge-v1.mjs';
import {nativeActionIdentityEntities,isNativeActionKnowledge} from './native-action-identity-projection-v1.mjs';
import {nativeActionSourceManifest} from './native-action-graph-extension-v1.mjs';
import {createNativeActionDomainGraph,actionDomainNodeRef} from './native-action-domain-adapter-v1.mjs';

const array=value=>Array.isArray(value)?value:[];
const unique=rows=>[...new Map(rows.map(row=>[hash(row),row])).values()];
const ref=record=>record.knowledge_ref??record.record_ref;
const immutableAction=record=>({ref:ref(record),draft:record.native_action?.content_sha256,text:record.text,statement:record.statement,
  source_record_refs:record.source_record_refs,source_refs:array(record.source_refs).map(source=>({kind:source.kind,record_ref:source.record_ref,
    revision:source.revision,source_kind:source.source_kind,document_evidence_eligible:source.document_evidence_eligible})),
  valid_time:record.valid_time,conditions:record.conditions,modality:record.modality,negation:record.negation});

export function prepareNativeActionLibrary({prepared,existingKnowledge,existingSourceManifest=[],identity=null,
  identityDecisions=[],priorMappings=[],existingEntities=[],definitions=[],definitionMappings=[],revisionRef,revokedDecisionRefs=[]}) {
  verifyNativeActionPrepared(prepared);
  need(Array.isArray(existingKnowledge)&&Array.isArray(existingSourceManifest)&&textField(revisionRef),'ACTION_LIBRARY_INPUT_INVALID');
  const libraryId=prepared.library_id,records=new Map();
  for(const record of [...existingKnowledge,...prepared.knowledge]){
    need(textField(ref(record))&&(record.library_id===undefined||record.library_id===libraryId),'ACTION_LIBRARY_RECORD_SCOPE_INVALID');
    const old=records.get(ref(record));
    if(old){
      const same=isNativeActionKnowledge(old)&&isNativeActionKnowledge(record)
        ?hash(immutableAction(old))===hash(immutableAction(record)):hash(old)===hash(record);
      need(same,'ACTION_LIBRARY_KNOWLEDGE_REF_CONFLICT');
      // Keep already-published identity/evidence enrichment for an identical source assertion.
      continue;
    }
    records.set(ref(record),clone(record));
  }
  const complete=[...records.values()];
  const priorEntities=existingEntities.length?existingEntities:unique(existingKnowledge.flatMap(nativeActionIdentityEntities).map(entity=>({
    ...clone(entity),canonical_id:entity.canonical_id??entity.id,observed_types:entity.observed_types??(entity.entity_type?[entity.entity_type]:[]),
    descriptions:entity.descriptions??(entity.description?[entity.description]:[])})));
  const profiles=collectLibraryEntities(complete,priorEntities);
  const byId=new Map(profiles.map(profile=>[profile.id,profile])),byHandle=new Map(profiles.map(profile=>[profile.entity_ref,profile]));
  const boundDecisions=identityDecisions.map(decision=>{
    // E handles belong to one profile set. Stable endpoint IDs take precedence at this bridge.
    const left=decision.left_id?byId.get(decision.left_id):byHandle.get(decision.left_ref);
    const right=decision.right_id?byId.get(decision.right_id):byHandle.get(decision.right_ref);
    need(left&&right&&(left.id!==right.id||decision.decision==='same')&&['same','different','uncertain'].includes(decision.decision)
      &&textField(decision.reason)&&textField(decision.decision_ref),'ACTION_LIBRARY_IDENTITY_DECISION_INVALID');
    return {...clone(decision),left_id:left.id,right_id:right.id,left_ref:left.entity_ref,right_ref:right.entity_ref};
  });
  const computedIdentity=projectLibraryIdentities({libraryId,profiles,decisions:boundDecisions,priorMappings,revokedDecisionRefs});
  if(identity&&identityDecisions.length)need(hash(identity.mapping)===hash(computedIdentity.mapping),
    'ACTION_LIBRARY_IDENTITY_OVERRIDE_CONFLICT');
  const initialIdentity=identity??computedIdentity;
  const resolved=clone(initialIdentity);
  need(Array.isArray(resolved.mapping)&&Array.isArray(resolved.entities),'ACTION_LIBRARY_IDENTITY_INVALID');
  // A queued Host can still reference the exact source-local node of an already-canonical record.
  // These aliases are inherited identity evidence, never inferred from a label.
  const map=new Map(resolved.mapping.map(item=>[item.local_entity_id,item.canonical_id])),aliases=new Map();
  function alias(local,canonical){
    if(!textField(local)||!textField(canonical)||local===canonical)return;
    const target=map.get(canonical)??canonical;
    need(!aliases.has(local)||aliases.get(local)===target,'ACTION_LIBRARY_ALIAS_CONFLICT');aliases.set(local,target);
  }
  for(const record of existingKnowledge){
    for(const entity of nativeActionIdentityEntities(record))for(const local of [...array(entity.source_local_entity_ids),...array(entity.local_entity_ids)])alias(local,entity.id);
    alias(record.library_projection?.source_local_subject_ref,record.subject_ref);
    if(isNativeActionKnowledge(record))alias(actionDomainNodeRef(record.native_action),record.subject_ref);
  }
  for(const [local,canonical]of aliases){
    need(!map.has(local)||map.get(local)===canonical,'ACTION_LIBRARY_ALIAS_CONFLICT');
    if(!map.has(local))resolved.mapping.push({library_id:libraryId,local_entity_id:local,canonical_id:canonical,status:'ACTIVE',
      decision_refs:[],origin:'INHERITED_EXACT_RECORD_IDENTITY'});
  }
  const covered=new Set([...resolved.mapping.map(item=>item.local_entity_id),...resolved.entities.map(entity=>entity.id)]);
  need(profiles.filter(profile=>profile.current!==false).every(profile=>covered.has(profile.id)),'ACTION_LIBRARY_IDENTITY_INCOMPLETE');
  const projected=projectLibraryKnowledge(complete,{identity:resolved,definitions,definitionMappings,revisionRef});
  const sourceManifest=nativeActionSourceManifest(projected,[...existingSourceManifest,...prepared.source_manifest]);
  const domainGraph={...createNativeActionDomainGraph({knowledge:projected,sourceManifest}),revision_ref:revisionRef,scope:'CURRENT_COMPLETE_LIBRARY'};
  const gaps=clone(domainGraph.action_gaps??[]);
  const candidates=libraryIdentityCandidates(profiles);
  const libraryBody={policy:LIBRARY_KNOWLEDGE_POLICY,library_id:libraryId,revision_ref:revisionRef,run_id:prepared.run_id,
    knowledge:projected,domain_graph:domainGraph,source_manifest:sourceManifest,
    identity:{...clone(resolved),profiles,decisions:clone(identityDecisions)},ontology:{definitions:clone(definitions)},
    original_knowledge_preserved:true,action_prepared_sha256:prepared.prepared_sha256,gaps};
  const libraryKnowledge={...libraryBody,record_sha256:hash(libraryBody)};
  const body={schema:'NATIVE_ACTION_LIBRARY_PREPARED_V1',library_id:libraryId,revision_ref:revisionRef,
    knowledge:projected,domain_graph:domainGraph,source_manifest:sourceManifest,identity:clone(resolved),identity_candidates:candidates,
    index_documents:projected.map(record=>({knowledge_ref:ref(record),text:record.text??record.statement??'',source_refs:clone(record.source_refs??[]),
      content_sha256:hash(record),structure:clone(record)})),
    libraryKnowledge,action_prepared_sha256:prepared.prepared_sha256,
    identity_decisions_applied_sha256:hash(identityDecisions),
    correction_bindings:clone(prepared.correction_bindings??[]),
    execution_mode:prepared.execution_mode,publication_eligible:prepared.publication_eligible,
    ready_for_indexing:gaps.length===0,gaps,published:false,graph_index_committed:false};
  return {...body,library_projection_sha256:hash(body)};
}

/** Direct bridge for the core owner after its explicit correction-target filtering. */
export function prepareNativeActionLibraryForMemoryProduct({prepared,retainedKnowledge,previousRevision=null,sourceManifest=[],revisionRef=null,
  identityDecisions=prepared.identity_decisions??[]}) {
  need(previousRevision===null||previousRevision.library_id===prepared.library_id,'ACTION_LIBRARY_PREVIOUS_SCOPE_INVALID');
  const resolution=prepared.identity_resolution;
  if(identityDecisions.length||resolution){
    need(resolution?.policy==='ACTION_LIBRARY_IDENTITY_REUSE_V1'
      &&hash(identityDecisions)===resolution.decisions_sha256
      &&hash(identityDecisions)===hash(prepared.identity_decisions??[])
      &&hash(resolution.library_basis)===hash(previousRevision?{revision_ref:previousRevision.revision_ref,
        record_sha256:previousRevision.record_sha256,run_id:previousRevision.run_id,
        source_snapshot_ref:previousRevision.source_snapshot_ref}:null),'ACTION_LIBRARY_IDENTITY_BASIS_CHANGED');
  }
  const chosenRef=revisionRef??'memory_library_'+hash({library_id:prepared.library_id,action_prepared_sha256:prepared.prepared_sha256,
    previous_revision_sha256:previousRevision?hash(previousRevision):null});
  return prepareNativeActionLibrary({prepared,existingKnowledge:retainedKnowledge,existingSourceManifest:sourceManifest,revisionRef:chosenRef,
    existingEntities:previousRevision?.identity?.entities??[],priorMappings:previousRevision?.identity?.mapping??[],
    identityDecisions,revokedDecisionRefs:resolution?.revoked_decision_refs??[],
    definitions:previousRevision?.ontology?.definitions??[],definitionMappings:previousRevision?.ontology?.definition_mappings??[]});
}
