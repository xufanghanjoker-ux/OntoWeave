/** Explicit human decisions over an immutable library projection. No model I/O. */
import {clone, hash, need, textField} from './cq-discovery-store-v2.mjs';
import {
  LIBRARY_KNOWLEDGE_POLICY, LIBRARY_KNOWLEDGE_RECORDS as K,
  projectLibraryIdentities, projectLibraryKnowledge, collectLibraryOntologyShapes,
  libraryShapeSignature, prepareDefinitionUnification, resolveLibraryDefinitionShapes
} from './native-library-knowledge-v1.mjs';
import {annotateLibraryReviewTriage,resolveLibraryItemComparison} from './native-library-triage-v1.mjs';
import {createDomainGraph} from './native-domain-knowledge-v1.mjs';
import {validateKnowledgeCorrection, applyKnowledgeReviewEvent, knowledgeReviewRows,
  knowledgeReviewEventRefs, knowledgeBusinessChangedFields, installKnowledgeReviewReceipt,
  clearHumanCorrectionEvidence, KNOWLEDGE_CORRECTION_KINDS} from './native-knowledge-correction-v1.mjs';

export const LIBRARY_REVIEW_POLICY = 'LIBRARY_REVIEW_V1';
export const LIBRARY_REVIEW_APPLICATION_POLICY = 'LIBRARY_REVIEW_APPLICATION_V1';
export const LIBRARY_REVIEW_RECORDS = Object.freeze({
  ACTIVE: 'native_library_knowledge_active_v1',
  REVISION: 'native_library_knowledge_revision_v1',
  PROJECTION: 'native_library_knowledge_projection_v1',
  EVENT: 'native_library_review_event_v1',
  REQUEST: 'native_library_review_request_v1',
  HEAD: 'native_library_review_head_v1',
  INSTALLATION: 'native_library_review_installation_v1',
  APPLIED: 'native_library_review_applied_v1'
});
const R = LIBRARY_REVIEW_RECORDS;
const array = value => Array.isArray(value) ? value : [];
const unique = values => [...new Set(values)];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const actions = {IDENTITY: new Set(['same', 'different', 'uncertain', 'revoke']),
  DEFINITION: new Set(['accept', 'reject', 'unify', 'keep_separate', 'exclude', 'defer', 'revoke']),
  KNOWLEDGE: new Set(['replace', 'revoke', 'defer'])};
const pairKey = (a, b) => hash([a, b].sort());
const headKey = binding => hash([binding.libraryId, binding.runId, binding.revisionRef]);
const signed = body => ({...body, record_sha256: hash(body)});
const projectKnowledge = (knowledge, args) => projectLibraryKnowledge(knowledge, args).map(clearHumanCorrectionEvidence);
const versionChange = event => event.application_required !== false && event.effect !== 'STATE_ONLY';
const lineage = definition => definition.definition_lineage_ref ?? definition.source_definition_ref ?? definition.definition_ref;
const historyRefs = value => unique([value?.review_event_ref, ...array(value?.review_history).map(row => row.review_event_ref)].filter(textField));
const latestVersion = events => events.filter(versionChange).at(-1) ?? null;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const refOf = value => value.record_ref ?? value.knowledge_ref;
const bindingFields = ['subject_ref','object_ref','predicate','direction','attribute','raw_value','unit','rule_text','rule_name','participants','attributes','conditions','negation','modality','time_text','version_text','exceptions','ontology_alignment','relation_ontology_alignment','attribute_ontology_alignments','domain','source_refs','evidence','origin_layer','answer_authority'];
const identityShape = identity => ({mapping:array(identity.mapping).map(row=>({local_entity_id:row.local_entity_id,canonical_id:row.canonical_id})),entities:array(identity.entities).map(row=>({id:row.id,name:row.name,local_entity_ids:row.local_entity_ids}))});
const analysisRows = (store, revision) => typeof store.listRecords === 'function' ? store.listRecords('native_library_pending_analysis_v1').filter(row=>row.library_id===revision.library_id&&row.run_id===revision.run_id&&row.revision_ref===revision.revision_ref) : [];
function eventMatchesItem(event,item) {
  if (event.item_kind!==item.kind) return false;
  if (event.item_target_ref===item.target_ref || event.item_ref===item.item_ref) return true;
  return item.kind==='DEFINITION' && array(event.affected_definition_lineages).includes(lineage(item.definition));
}
function reviewHistory(row) {return [...array(row?.review_history), ...(row?.review_event_ref?[{review_event_ref:row.review_event_ref,applied_receipt_ref:row.applied_receipt_ref,author:'HUMAN'}]:[])];}

const allowedActions = (item, history = []) => [...actions[item.kind]].filter(action =>
  (action !== 'revoke' || canRevoke(item, history)) &&
  (item.kind !== 'KNOWLEDGE' || action !== 'replace' || KNOWLEDGE_CORRECTION_KINDS.includes(item.knowledge.kind)));
function checked(record, code) {
  const {record_sha256, ...body} = record ?? {};
  need(record && record_sha256 === hash(body), code);
  return record;
}
function append(store, kind, key, value) {
  const old = store.getRecord(kind, key);
  if (old) {need(hash(old) === hash(value), 'NATIVE_LIBRARY_REVIEW_IMMUTABLE_CONFLICT'); return old;}
  return store.putRecord(kind, key, clone(value));
}
function readBound({store, catalog, libraryId, snapshotId, runId, revisionRef}) {
  const pointer = store.getRecord(R.PROJECTION, runId);
  const ref = revisionRef ?? pointer?.revision_ref;
  need(textField(ref), 'NATIVE_LIBRARY_PROJECTION_MISSING');
  const revision = checked(store.getRecord(R.REVISION, ref), 'NATIVE_LIBRARY_PROJECTION_CHANGED');
  const input = store.getRecord(K.INPUT, runId);
  need(revision.policy === LIBRARY_KNOWLEDGE_POLICY && input &&
    revision.run_id === runId && revision.library_id === libraryId &&
    revision.source_snapshot_ref === snapshotId && revision.revision_ref === ref &&
    input.run_id === runId && input.library_id === libraryId && input.source_snapshot_ref === snapshotId,
  'NATIVE_LIBRARY_REVIEW_BINDING_CHANGED');
  const source = catalog.get(snapshotId, libraryId);
  const inputHash = hash({libraryId, snapshotId, knowledge: input.knowledge,
    cqInput: input.cq_input, families: input.families});
  need(inputHash === input.input_sha256 && inputHash === revision.input_sha256 &&
    input.source_fingerprint === source.fingerprint && revision.source_fingerprint === source.fingerprint,
  'NATIVE_LIBRARY_PROJECTION_INPUT_CHANGED');
  return {revision, input, pointer, binding: {libraryId, snapshotId, runId, revisionRef: ref}};
}
function assertActive(args, bound) {
  need(args.catalog.isCurrent(args.snapshotId, args.libraryId), 'NATIVE_SOURCE_STALE');
  const active = args.store.getRecord(R.ACTIVE, args.libraryId);
  need(active && active.library_id === args.libraryId && active.run_id === args.runId &&
    active.source_snapshot_ref === args.snapshotId && active.revision_ref === bound.revision.revision_ref &&
    active.record_sha256 === bound.revision.record_sha256 &&
    textField(active.knowledge_index_revision) && textField(active.source_index_revision),
  'NATIVE_LIBRARY_REVIEW_REVISION_STALE');
  need(bound.pointer?.revision_ref === bound.revision.revision_ref &&
    bound.pointer.record_sha256 === bound.revision.record_sha256,
  'NATIVE_LIBRARY_REVIEW_REVISION_STALE');
  need(args.currentRevisionRef === undefined || args.currentRevisionRef === active.revision_ref,
    'NATIVE_LIBRARY_REVIEW_REVISION_STALE');
  return active;
}
function decisionEnds(decision, profiles) {
  const byRef = new Map(profiles.map(profile => [profile.entity_ref, profile.id]));
  return [decision.left_id ?? byRef.get(decision.left_ref), decision.right_id ?? byRef.get(decision.right_ref)];
}
function identityDecisions(revision) {
  const profiles = array(revision.identity?.profiles);
  const result = new Map();
  for (const decision of [...array(revision.identity?.decisions), ...array(revision.identity?.pending),
    ...array(revision.identity?.blocked)]) {
    const [left, right] = decisionEnds(decision, profiles);
    if (!profiles.some(profile => profile.id === left) || !profiles.some(profile => profile.id === right) || left === right) continue;
    const ref = decision.decision_ref ?? 'identity_observation_' + hash(decision);
    result.set(ref, {...clone(decision), left_id: left, right_id: right, decision_ref: ref});
  }
  return [...result.values()];
}
function sourceItems(revision, sourceKnowledge = revision.knowledge) {
  const identity = revision.identity ?? {}, profiles = array(identity.profiles);
  const grouped = new Map();
  for (const decision of identityDecisions(revision)) {
    const key = pairKey(decision.left_id, decision.right_id);
    const item = grouped.get(key) ?? {kind: 'IDENTITY', target_ref: key,
      left_id: decision.left_id, right_id: decision.right_id,
      left: clone(profiles.find(profile => profile.id === decision.left_id)),
      right: clone(profiles.find(profile => profile.id === decision.right_id)),
      decisions: [], reasons: []};
    item.decisions.push(decision);
    item.reasons = unique([...item.reasons, decision.reason].filter(textField));
    grouped.set(key, item);
  }
  const blockedKeys = new Set(array(identity.blocked).map(decision => pairKey(...decisionEnds(decision, profiles))));
  const pendingKeys = new Set(array(identity.pending).map(decision => pairKey(...decisionEnds(decision, profiles))));
  const items = [...grouped.values()].map(item => ({...item,
    status: blockedKeys.has(item.target_ref) ? 'BLOCKED' : pendingKeys.has(item.target_ref) ? 'UNRESOLVED' : 'RESOLVED'}));
  for (const definition of array(revision.ontology?.definitions)) {
    if (!textField(definition.definition_ref)) continue;
    items.push({kind: 'DEFINITION', target_ref: definition.definition_ref,
      definition: clone(definition), status: ['USABLE', 'REJECTED', 'UNIFIED'].includes(definition.status) ? 'RESOLVED' : 'UNRESOLVED',
      resolution: definition.status === 'REJECTED' ? 'REJECTED' : definition.status === 'USABLE' ? 'ACCEPTED' : null,
      reasons: [definition.reason, definition.warning].filter(textField)});
  }
  for (const knowledge of array(sourceKnowledge)) {
    const targetRef = knowledge.record_ref ?? knowledge.knowledge_ref;
    if (!textField(targetRef)) continue;
    items.push({kind: 'KNOWLEDGE', target_ref: targetRef, knowledge: clone(knowledge),
      projected_knowledge: clone(array(revision.knowledge).find(value =>
        (value.record_ref ?? value.knowledge_ref) === targetRef) ?? knowledge),
      status: knowledge.knowledge_review?.status === 'DEFERRED' ? 'UNRESOLVED' : 'RESOLVED',
      resolution: knowledge.origin_layer === 'HUMAN_CORRECTION' ? 'HUMAN_CORRECTION' : null,
      reasons: [knowledge.knowledge_review?.reason].filter(textField)});
  }
  return items.map(item => ({...item,
    item_ref: 'library_review_item_' + hash([revision.revision_ref, item.kind, item.target_ref]),
    revision_ref: revision.revision_ref,
    allowed_actions: allowedActions(item)}));
}
function canRevoke(item, history = []) {
  if (item.kind === 'KNOWLEDGE') return item.knowledge?.origin_layer === 'HUMAN_CORRECTION' ||
    history.some(event => event.action === 'replace');
  return history.some(versionChange) ||
    item.decisions?.some(decision => decision.author === 'HUMAN' && textField(decision.review_event_ref)) ||
    item.definition?.author === 'HUMAN' && textField(item.definition.review_event_ref);
}
function readEvents(store, binding) {
  const events = store.listRecords(R.EVENT).filter(event => event.library_id === binding.libraryId &&
    event.source_run_id === binding.runId && event.source_revision_ref === binding.revisionRef)
    .sort((a, b) => a.sequence - b.sequence);
  for (const [index, event] of events.entries()) {
    checked(event, 'NATIVE_LIBRARY_REVIEW_EVENT_CHANGED');
    need(event.sequence === index + 1 && event.source_snapshot_ref === binding.snapshotId,
      'NATIVE_LIBRARY_REVIEW_EVENT_CHAIN_CHANGED');
    need(event.previous_event_ref === (events[index - 1]?.event_ref ?? null),
      'NATIVE_LIBRARY_REVIEW_EVENT_CHAIN_CHANGED');
  }
  const head = store.getRecord(R.HEAD, headKey(binding));
  if (events.length || head) {
    need(head && head.count === events.length && head.event_set_sha256 === hash(events) &&
      head.event_ref === (events.at(-1)?.event_ref ?? null), 'NATIVE_LIBRARY_REVIEW_EVENT_CHAIN_CHANGED');
  }
  return events;
}
function appliedReceipts(store, binding) {
  return store.listRecords(R.APPLIED).filter(receipt => receipt.library_id === binding.libraryId &&
    receipt.source_revision_ref === binding.revisionRef).map(receipt =>
    checked(receipt, 'NATIVE_LIBRARY_REVIEW_APPLIED_CHANGED'));
}
function listResult(args, bound) {
  const events = readEvents(args.store, bound.binding), receipts = appliedReceipts(args.store, bound.binding);
  const inheritedEvents = new Map(), inheritedReceipts = new Map();
  const humanRows = [...identityDecisions(bound.revision), ...array(bound.revision.ontology?.definitions),
    ...identityDecisions(bound.revision).flatMap(reviewHistory),
    ...array(bound.revision.ontology?.definitions).flatMap(reviewHistory),
    ...array(bound.revision.review_history), ...array(bound.input.knowledge).flatMap(knowledgeReviewRows)]
    .filter(value => value.author === 'HUMAN' || value.source === 'HUMAN');
  for (const value of humanRows) {
    if (textField(value.review_event_ref)) {
      const event = checked(args.store.getRecord(R.EVENT, value.review_event_ref), 'NATIVE_LIBRARY_REVIEW_EVENT_CHANGED');
      need(event.library_id === args.libraryId, 'NATIVE_LIBRARY_REVIEW_EVENT_BINDING_CHANGED');
      inheritedEvents.set(event.event_ref, event);
    }
    if (textField(value.applied_receipt_ref)) {
      const receipt = args.store.getRecord(R.APPLIED, value.applied_receipt_ref);
      if (receipt) {
        checked(receipt, 'NATIVE_LIBRARY_REVIEW_APPLIED_CHANGED');
        need(receipt.library_id === args.libraryId && receipt.status === 'APPLIED' &&
          receipt.event_refs.includes(value.review_event_ref), 'NATIVE_LIBRARY_REVIEW_APPLIED_CHANGED');
        inheritedReceipts.set(receipt.applied_receipt_ref, receipt);
      }
    }
  }
  const allReceipts = [...new Map([...receipts, ...inheritedReceipts.values()]
    .map(receipt => [receipt.applied_receipt_ref, receipt])).values()];
  const applied = new Set(allReceipts.flatMap(receipt => receipt.event_refs));
  const items = sourceItems(bound.revision, bound.input.knowledge).map(item => {
    const inheritedRefs = new Set(item.kind === 'KNOWLEDGE' ? knowledgeReviewEventRefs(item.knowledge) :
      (item.kind === 'IDENTITY' ? item.decisions : [item.definition]).flatMap(historyRefs));
    const history = [...inheritedEvents.values()].filter(event => inheritedRefs.has(event.event_ref)||eventMatchesItem(event,item));
    for (const event of events.filter(event => event.item_ref === item.item_ref)) {
      if (!history.some(old => old.event_ref === event.event_ref)) history.push(event);
    }
    const latest = history.at(-1), effectiveVersion = latestVersion(history), latestState = history.filter(event=>!versionChange(event)).at(-1)??null;
    return {...item, history: clone(history), latest_event: latest ? clone(latest) : null,
      allowed_actions: allowedActions(item, history),
      latest_state_event: clone(latestState), effective_version_event: clone(effectiveVersion),
      application_status: effectiveVersion ? applied.has(effectiveVersion.event_ref) ? 'APPLIED' : 'PENDING_APPLICATION' : latestState ? 'NO_APPLICATION_REQUIRED' : 'NO_HUMAN_DECISION'};
  });
  let current = false;
  try {assertActive(args, bound); current = true;} catch {}
  const result = {policy: LIBRARY_REVIEW_POLICY, library_id: args.libraryId, run_id: args.runId,
    source_snapshot_ref: args.snapshotId, revision_ref: bound.revision.revision_ref,
    source_current: args.catalog.isCurrent(args.snapshotId, args.libraryId), current, writable: current,
    items, history: clone([...new Map([...inheritedEvents.values(), ...events].map(event => [event.event_ref, event])).values()]),
    current_revision_history: clone(events), applications: clone(allReceipts),
    summary: {items: items.length, unresolved: items.filter(item => item.status !== 'RESOLVED').length,
      pending_application: [...new Map(events.filter(versionChange).map(event=>[event.item_ref,event])).values()].filter(event => !applied.has(event.event_ref)).length}};
  const annotated=annotateLibraryReviewTriage({review:result,revision:bound.revision,analysisRecords:analysisRows(args.store,bound.revision)});
  for(const item of annotated.items.filter(item=>item.kind==='IDENTITY')){const action=item.readiness?.actions?.find(action=>action.action==='uncertain');if(action)action.effect=uncertainEffect(bound,item,events);}
  for(const item of annotated.items)item.allowed_actions=array(item.readiness?.actions).filter(action=>action.enabled===true).map(action=>action.action);
  return annotated;
}
export function listNativeLibraryReview(args) {return listResult(args, readBound(args));}

function uncertainEffect(bound,item,events) {
  const priorPlan=computePlan(bound,events),nextDecisions=priorPlan.identity.decisions.filter(decision=>pairKey(decision.left_id,decision.right_id)!==item.target_ref);
  nextDecisions.push({author:'HUMAN',left_id:item.left_id,right_id:item.right_id,decision:'uncertain',reason:'暂不确定'});
  const next=projectLibraryIdentities({libraryId:bound.binding.libraryId,profiles:bound.revision.identity.profiles,decisions:nextDecisions,priorMappings:priorPlan.identity.mapping});
  return hash(identityShape(next))===hash(identityShape(priorPlan.identity))?'STATE_ONLY':'VERSION_CHANGE';
}
function beforeDefinitionState(bound, definitions) {
  const refs = new Set(definitions.map(definition=>definition.definition_ref));
  return {definitions:clone(definitions),mappings:clone(array(bound.revision.ontology?.definition_mappings).filter(mapping=>refs.has(mapping.source_definition_ref)||refs.has(mapping.target_definition_ref)))};
}
function definitionResolutionPlan(args,bound,item) {
  const resolution=args.definitionResolution,action=args.action,definitions=array(bound.revision.ontology?.definitions);
  need(resolution===undefined||plain(resolution)&&Object.keys(resolution).every(key=>['comparison_ref','selected_definition_ref'].includes(key)), 'NATIVE_LIBRARY_REVIEW_DEFINITION_RESOLUTION_INVALID');
  if (!['unify','keep_separate'].includes(action)) {
    need(resolution===undefined,'NATIVE_LIBRARY_REVIEW_DEFINITION_RESOLUTION_INVALID');
    return {definition_before:beforeDefinitionState(bound,[item.definition]),affected_definition_lineages:[lineage(item.definition)]};
  }
  need(plain(resolution)&&textField(resolution.comparison_ref),'NATIVE_LIBRARY_REVIEW_COMPARISON_REQUIRED');
  const comparison=resolveLibraryItemComparison({revision:bound.revision,items:sourceItems(bound.revision,bound.input.knowledge),itemRef:item.item_ref,comparisonRef:resolution.comparison_ref,analysisRecords:analysisRows(args.store,bound.revision)});
  need(comparison?.binding_status==='BOUND','NATIVE_LIBRARY_REVIEW_COMPARISON_UNBOUND');
  const sides=array(comparison.sides),refs=sides.map(side=>side.definition_ref??side.ref),matched=definitions.filter(definition=>refs.includes(definition.definition_ref));
  need(matched.length===2&&refs.includes(item.definition.definition_ref),'NATIVE_LIBRARY_REVIEW_COMPARISON_BINDING_CHANGED');
  let mappings;
  if(action==='unify') {
    need(refs.includes(resolution.selected_definition_ref),'NATIVE_LIBRARY_REVIEW_TARGET_DEFINITION_REQUIRED');
    const planned=prepareDefinitionUnification({revision:bound.revision,comparison,selectedDefinitionRef:resolution.selected_definition_ref,knowledge:bound.input.knowledge});
    need(planned.allowed&&planned.mapping,'NATIVE_LIBRARY_REVIEW_DEFINITION_UNIFICATION_UNSAFE');
    mappings=[planned.mapping];
  }else{
    need(resolution.selected_definition_ref===undefined,'NATIVE_LIBRARY_REVIEW_DEFINITION_RESOLUTION_INVALID');
    const shapes=collectLibraryOntologyShapes(bound.input.knowledge,bound.revision.identity);
    mappings=matched.map(definition=>{
      const resolved=resolveLibraryDefinitionShapes(definition,shapes),knowledgeRefs=array(definition.knowledge_refs),labels=array(definition.observed_labels),covered=new Set(resolved.shapes.flatMap(shape=>array(shape.knowledge_refs)));
      need(!resolved.problems.length&&resolved.shapes.length>0&&knowledgeRefs.length>0&&knowledgeRefs.every(ref=>covered.has(ref))&&resolved.shapes.every(shape=>shape.kind===definition.kind&&labels.includes(shape.label)&&array(shape.knowledge_refs).some(ref=>knowledgeRefs.includes(ref))),'NATIVE_LIBRARY_REVIEW_DEFINITION_SEPARATION_BINDING_UNRESOLVED');
      return {policy:'LIBRARY_DEFINITION_MAPPING_V1',source_definition_ref:definition.definition_ref,source_definition_sha256:hash(definition),source_shape_signatures:resolved.shapes.map(libraryShapeSignature),knowledge_refs:clone(knowledgeRefs),target_definition_ref:definition.definition_ref,target_definition_sha256:hash(definition),mapping_direction:definition.mapping_direction??'forward',status:'ACTIVE',action:'keep_separate'};
    });
  }
  return {definition_resolution:clone(resolution),definition_resolution_binding:clone(comparison),definition_mappings:mappings,definition_before:beforeDefinitionState(bound,matched),affected_definition_lineages:matched.map(lineage)};
}
function responseForEvent(event,applied=false,idempotent=false) {
  const applicationRequired=versionChange(event);
  return {policy:LIBRARY_REVIEW_POLICY,status:applicationRequired?(applied?'APPLIED':'PENDING_APPLICATION'):event.action==='defer'?'DEFERRED':'SAVED',event:clone(event),idempotent,effect:applicationRequired?'VERSION_CHANGE':'STATE_ONLY',application_required:applicationRequired,graph_changed:false,index_changed:false};
}
export function submitNativeLibraryReview(args) {
  const {store,libraryId,requestId,itemRef,action,correction,definitionResolution}=args,reason=typeof args.reason==='string'?args.reason:'';
  need(uuid.test(requestId??''),'NATIVE_LIBRARY_REVIEW_REQUEST_REQUIRED');
  need(textField(args.revisionRef)&&textField(itemRef)&&textField(action)&&typeof reason==='string','NATIVE_LIBRARY_REVIEW_DECISION_INVALID');
  const requestKey=hash([libraryId,requestId]),digest=hash({libraryId,snapshotId:args.snapshotId,runId:args.runId,revisionRef:args.revisionRef,itemRef,action,reason,...(correction===undefined?{}:{correction}),...(definitionResolution===undefined?{}:{definitionResolution})});
  const prior=store.getRecord(R.REQUEST,requestKey);
  if(prior){
    need(prior.digest===digest,'NATIVE_LIBRARY_REVIEW_REQUEST_CONFLICT');
    const event=checked(store.getRecord(R.EVENT,prior.event_ref),'NATIVE_LIBRARY_REVIEW_EVENT_CHANGED');
    need(event.request_id===requestId&&event.library_id===libraryId&&event.source_run_id===args.runId&&event.source_snapshot_ref===args.snapshotId&&event.source_revision_ref===args.revisionRef&&event.item_ref===itemRef&&event.action===action&&event.reason===reason.trim()&&event.request_sha256===digest,'NATIVE_LIBRARY_REVIEW_REQUEST_EVENT_CHANGED');
    return responseForEvent(event,appliedReceipts(store,{libraryId,revisionRef:args.revisionRef}).some(receipt=>receipt.event_refs.includes(event.event_ref)),true);
  }
  return store.transaction(()=>{
    const bound=readBound(args);assertActive(args,bound);
    const rawItem=sourceItems(bound.revision,bound.input.knowledge).find(value=>value.item_ref===itemRef);
    need(rawItem&&actions[rawItem.kind].has(action),'NATIVE_LIBRARY_REVIEW_ITEM_FORBIDDEN');
    const listed=listResult(args,bound),item=listed.items.find(value=>value.item_ref===itemRef),capability=item.readiness?.actions?.find(value=>value.action===action);
    if(capability)need(capability.enabled!==false,'NATIVE_LIBRARY_REVIEW_ACTION_UNAVAILABLE');
    need(!(['same','different','unify','replace'].includes(action)||capability?.requires_reason)||textField(reason),'NATIVE_LIBRARY_REVIEW_DECISION_INVALID');
    const events=readEvents(store,bound.binding),itemHistory=listed.history.filter(event=>eventMatchesItem(event,item));
    need(item.kind==='KNOWLEDGE'&&action==='replace'||correction===undefined,'NATIVE_KNOWLEDGE_CORRECTION_FIELDS_INVALID');
    need(item.kind==='DEFINITION'||definitionResolution===undefined,'NATIVE_LIBRARY_REVIEW_DEFINITION_RESOLUTION_INVALID');
    const corrected=item.kind==='KNOWLEDGE'&&action==='replace'?validateKnowledgeCorrection(item.knowledge,correction):null;
    let extra={},effect=action==='defer'?'STATE_ONLY':'VERSION_CHANGE';
    if(item.kind==='DEFINITION')extra=definitionResolutionPlan(args,bound,item);
    if(item.kind==='IDENTITY') {
      extra.identity_before={decisions:identityDecisions(bound.revision).filter(decision=>pairKey(decision.left_id,decision.right_id)===item.target_ref)};
      if(action==='uncertain')effect=uncertainEffect(bound,item,events);
    }
    if(action==='revoke') {
      need(canRevoke(item,itemHistory),'NATIVE_LIBRARY_REVIEW_NOT_REVOCABLE');
      const effective=latestVersion(itemHistory);
      if(effective){
        extra.revokes_event_ref=effective.event_ref;
        if(item.kind==='DEFINITION') {
          const origin=checked(store.getRecord(R.REVISION,effective.source_revision_ref),'NATIVE_LIBRARY_PROJECTION_CHANGED');
          const before=effective.definition_before??{definitions:array(origin.ontology?.definitions).filter(definition=>definition.definition_ref===effective.item_target_ref),mappings:[]};
          const lines=before.definitions.map(lineage),current=array(bound.revision.ontology?.definitions).filter(definition=>lines.includes(lineage(definition)));
          need(current.every(definition=>!definition.review_event_ref||definition.review_event_ref===effective.event_ref),'NATIVE_LIBRARY_REVIEW_REVOKE_SUPERSEDED');
          need(!events.some(event=>versionChange(event)&&event.item_kind==='DEFINITION'&&event.item_ref!==item.item_ref&&
            (event.source_revision_ref!==effective.source_revision_ref||event.sequence>effective.sequence)&&
            array(event.affected_definition_lineages).some(line=>lines.includes(line))),'NATIVE_LIBRARY_REVIEW_REVOKE_SUPERSEDED');
          extra.definition_restore=clone(before);extra.affected_definition_lineages=lines;
        }
        if(item.kind==='IDENTITY') {
          const origin=checked(store.getRecord(R.REVISION,effective.source_revision_ref),'NATIVE_LIBRARY_PROJECTION_CHANGED');
          extra.identity_restore=clone(effective.identity_before??{decisions:identityDecisions(origin).filter(decision=>pairKey(decision.left_id,decision.right_id)===item.target_ref)});
        }
      }
    }
    if(item.kind==='DEFINITION'&&action==='accept')need(['CLASS','RELATION','ATTRIBUTE'].includes(item.definition.kind)&&textField(item.definition.name)&&textField(item.definition.description)&&array(item.definition.shape_refs).length,'NATIVE_LIBRARY_REVIEW_DEFINITION_INCOMPLETE');
    const body={policy:LIBRARY_REVIEW_POLICY,request_id:requestId,request_sha256:digest,library_id:libraryId,source_run_id:args.runId,source_snapshot_ref:args.snapshotId,source_fingerprint:bound.revision.source_fingerprint,source_revision_ref:bound.revision.revision_ref,source_revision_sha256:bound.revision.record_sha256,source_input_sha256:bound.revision.input_sha256,item_ref:itemRef,item_kind:item.kind,item_target_ref:item.target_ref,action,reason:reason.trim(),author:'HUMAN',effect,application_required:effect==='VERSION_CHANGE',...extra,...(corrected?{correction:corrected,before_knowledge_sha256:hash(item.knowledge),evidence_authority:'HUMAN_CORRECTION'}:{}),sequence:events.length+1,previous_event_ref:events.at(-1)?.event_ref??null,created_at:args.now?args.now():new Date().toISOString()};
    const event=signed({...body,event_ref:'library_review_event_'+hash(body)});append(store,R.EVENT,event.event_ref,event);append(store,R.REQUEST,requestKey,{request_id:requestId,digest,event_ref:event.event_ref});const next=[...events,event];store.putRecord(R.HEAD,headKey(bound.binding),{count:next.length,event_ref:event.event_ref,event_set_sha256:hash(next)});return responseForEvent(event);
  });
}

function computePlan(bound,events) {
  const revision=bound.revision,items=sourceItems(revision,bound.input.knowledge),effective=new Map();
  for(const event of events){
    need(event.source_revision_sha256===revision.record_sha256&&event.source_input_sha256===revision.input_sha256,'NATIVE_LIBRARY_REVIEW_EVENT_BINDING_CHANGED');
    const item=items.find(value=>value.item_ref===event.item_ref);
    need(item&&item.target_ref===event.item_target_ref&&item.kind===event.item_kind&&actions[item.kind].has(event.action),'NATIVE_LIBRARY_REVIEW_EVENT_BINDING_CHANGED');
    if(item.kind==='KNOWLEDGE'&&event.action==='replace')need(event.before_knowledge_sha256===hash(item.knowledge),'NATIVE_KNOWLEDGE_CORRECTION_BINDING_CHANGED');
    if(versionChange(event))effective.set(item.item_ref,event);
  }
  let decisions=identityDecisions(revision),definitions=clone(array(revision.ontology?.definitions)),definitionMappings=clone(array(revision.ontology?.definition_mappings)),sourceKnowledge=clone(bound.input.knowledge);
  const metadata=(event,row)=>({author:'HUMAN',source:'HUMAN',origin:'HUMAN',review_action:event.action,review_event_ref:event.event_ref,review_item_ref:event.item_ref,review_source_revision_ref:revision.revision_ref,review_history:unique([...reviewHistory(row).map(value=>value.review_event_ref),event.event_ref]).map(review_event_ref=>({author:'HUMAN',review_event_ref,...(reviewHistory(row).find(value=>value.review_event_ref===review_event_ref)?.applied_receipt_ref?{applied_receipt_ref:reviewHistory(row).find(value=>value.review_event_ref===review_event_ref).applied_receipt_ref}:{})}))});
  for(const event of [...effective.values()].sort((a,b)=>a.sequence-b.sequence)){
    const item=items.find(value=>value.item_ref===event.item_ref),human=metadata(event,item.definition??item.decisions?.at(-1));
    if(item.kind==='IDENTITY'){
      const replaced=decisions.filter(decision=>pairKey(decision.left_id,decision.right_id)===item.target_ref);decisions=decisions.filter(decision=>pairKey(decision.left_id,decision.right_id)!==item.target_ref);
      const restore=event.action==='revoke'?array(event.identity_restore?.decisions).at(-1):null;
      decisions.push({...human,left_id:item.left_id,right_id:item.right_id,left_ref:item.left.entity_ref,right_ref:item.right.entity_ref,decision:event.action==='revoke'?restore?.decision??'uncertain':event.action,reason:event.reason||restore?.reason||'',decision_ref:'human_identity_'+hash([item.target_ref,event.event_ref]),...(event.action==='revoke'?{revokes_event_ref:event.revokes_event_ref??null,revoked_decision_refs:replaced.map(decision=>decision.decision_ref)}:{})});
    }else if(item.kind==='DEFINITION'){
      const lines=new Set(event.affected_definition_lineages??[lineage(item.definition)]),current=definitions.filter(definition=>lines.has(lineage(definition))),affectedRefs=new Set(current.map(definition=>definition.definition_ref));
      if(event.action==='revoke'&&event.definition_restore){
        const restored=event.definition_restore.definitions.map(definition=>({...clone(definition),...metadata(event,definition),definition_lineage_ref:lineage(definition),previous_definition_ref:current.find(value=>lineage(value)===lineage(definition))?.definition_ref??null,reason:event.reason}));
        definitions=[...definitions.filter(definition=>!lines.has(lineage(definition))),...restored];
        definitionMappings=[...definitionMappings.filter(mapping=>!affectedRefs.has(mapping.source_definition_ref)&&!affectedRefs.has(mapping.target_definition_ref)),...clone(event.definition_restore.mappings)];
      }else{
        const selected=event.definition_resolution?.selected_definition_ref;
        definitions=definitions.map(definition=>!lines.has(lineage(definition))?definition:{...definition,...metadata(event,definition),definition_lineage_ref:lineage(definition),source_definition_ref:definition.definition_ref,reason:event.reason,
          ...(event.action==='unify'?definition.definition_ref===selected?{status:'USABLE',requested_pending:false,semantic_conflict_confirmed:true}:{status:'UNIFIED',disposition:'UNIFIED',unified_into_definition_ref:selected}:{}),
          ...(event.action==='keep_separate'?{disposition:'SEPARATE',requested_pending:false,semantic_conflict_confirmed:true}:{}),
          ...(['exclude','reject'].includes(event.action)?{disposition:'EXCLUDED',status:'REJECTED'}:{}),
          ...(event.action==='accept'?{status:'USABLE',requested_pending:false,semantic_conflict_confirmed:true}:{}),
          ...(event.action==='revoke'?{status:'PENDING',requested_pending:true,disposition:null}:{})});
        if(['unify','keep_separate','exclude','reject'].includes(event.action)){
          definitionMappings=definitionMappings.filter(mapping=>!affectedRefs.has(mapping.source_definition_ref)&&!affectedRefs.has(mapping.target_definition_ref));
          definitionMappings.push(...array(event.definition_mappings).map(mapping=>({...clone(mapping),author:'HUMAN',review_event_ref:event.event_ref,review_item_ref:event.item_ref,mapping_ref:'definition_mapping_'+hash([event.event_ref,mapping])})));
        }
      }
    }else sourceKnowledge=sourceKnowledge.map(record=>refOf(record)!==item.target_ref?record:applyKnowledgeReviewEvent(record,event,{historyEvents:events.filter(value=>value.item_ref===item.item_ref)}));
  }
  const identity=projectLibraryIdentities({libraryId:bound.binding.libraryId,profiles:clone(array(revision.identity?.profiles)),decisions,priorMappings:clone(array(revision.identity?.mapping))});
  const allShapes=new Map(array(revision.ontology?.unbound_shapes).map(shape=>[shape.shape_ref,clone(shape)]));
  for(const definition of definitions)for(const shapeRef of array(definition.shape_refs))if(!allShapes.has(shapeRef))allShapes.set(shapeRef,{shape_ref:shapeRef,kind:definition.kind,label:array(definition.observed_labels).join(' / ')||definition.name});
  const covered=new Set(definitions.filter(value=>value.status==='USABLE').flatMap(value=>array(value.shape_refs))),unbound=[...allShapes.values()].filter(shape=>!covered.has(shape.shape_ref));
  definitionMappings=definitionMappings.map(mapping=>{const source=definitions.find(definition=>definition.definition_ref===mapping.source_definition_ref),target=definitions.find(definition=>definition.definition_ref===mapping.target_definition_ref);return {...mapping,...(source?{source_definition_sha256:hash(source)}:{}),...(target?{target_definition_sha256:hash(target)}:{})};});
  const ontology={...clone(revision.ontology),definitions,definition_mappings:definitionMappings,unbound_shapes:unbound,summary:{...clone(revision.ontology?.summary),usable:definitions.filter(value=>value.status==='USABLE').length,pending:definitions.filter(value=>value.status==='PENDING').length,rejected:definitions.filter(value=>value.status==='REJECTED').length,unbound:unbound.length}};
  return {identity:{...identity,profiles:clone(array(revision.identity?.profiles)),decisions},ontology,sourceKnowledge,effectiveEvents:[...effective.values()]};
}

export function prepareNativeLibraryReviewApplication(args) {
  const bound = readBound(args); assertActive(args, bound);
  const events = readEvents(args.store, bound.binding);
  need(events.length > 0, 'NATIVE_LIBRARY_REVIEW_NOTHING_TO_APPLY');
  const {identity, ontology, sourceKnowledge,effectiveEvents} = computePlan(bound, events);
  const applicationRef = 'library_review_application_' + hash([bound.revision.revision_ref,
    bound.revision.record_sha256, bound.revision.input_sha256, hash(events)]);
  const previewRef = 'library_review_preview_' + hash(applicationRef);
  const projected = projectKnowledge(sourceKnowledge, {identity, definitions: ontology.definitions,definitionMappings:ontology.definition_mappings, revisionRef: previewRef});
  const beforeGraph = createDomainGraph(bound.revision.knowledge), afterGraph = createDomainGraph(projected);
  const changedTargets = new Set(effectiveEvents.filter(event => event.item_kind === 'KNOWLEDGE').map(event => event.item_target_ref));
  const contentChanges = sourceKnowledge.filter(record => changedTargets.has(record.record_ref ?? record.knowledge_ref)).map(after => {
    const recordRef = after.record_ref ?? after.knowledge_ref,
      before = bound.input.knowledge.find(record => (record.record_ref ?? record.knowledge_ref) === recordRef),
      nodes = [...beforeGraph.nodes, ...afterGraph.nodes].filter(node => array(node.record_refs).includes(recordRef)),
      edges = [...beforeGraph.edges, ...afterGraph.edges].filter(edge => array(edge.record_refs).includes(recordRef));
    return {record_ref: recordRef, before: clone(before), after: clone(after),
      changed_fields: knowledgeBusinessChangedFields(before, after),
      evidence_identity_changed: (before.origin_layer ?? 'EXTRACTED_KNOWLEDGE') !== (after.origin_layer ?? 'EXTRACTED_KNOWLEDGE'),
      affected_knowledge_refs: [recordRef], affected_entity_refs: unique(nodes.map(node => node.id)),
      affected_relation_refs: unique(edges.map(edge => edge.id)),
      graph_before: {nodes: beforeGraph.nodes.filter(node => array(node.record_refs).includes(recordRef)),
        edges: beforeGraph.edges.filter(edge => array(edge.record_refs).includes(recordRef))},
      graph_after: {nodes: afterGraph.nodes.filter(node => array(node.record_refs).includes(recordRef)),
        edges: afterGraph.edges.filter(edge => array(edge.record_refs).includes(recordRef))}};
  });
  const recordImpact=refs=>{
    const ids=new Set(refs),nodes=[...beforeGraph.nodes,...afterGraph.nodes].filter(node=>array(node.record_refs).some(ref=>ids.has(ref))),edges=[...beforeGraph.edges,...afterGraph.edges].filter(edge=>array(edge.record_refs).some(ref=>ids.has(ref)));
    return {affected_knowledge_refs:unique(refs),affected_entity_refs:unique(nodes.map(node=>node.id)),affected_relation_refs:unique(edges.map(edge=>edge.id)),affected_index_record_refs:unique(refs)};
  };
  const identityChanges=effectiveEvents.filter(event=>event.item_kind==='IDENTITY').map(event=>{
    const item=sourceItems(bound.revision,bound.input.knowledge).find(value=>value.item_ref===event.item_ref),refs=unique([...array(item.left?.knowledge_refs),...array(item.right?.knowledge_refs)]);
    return {item_ref:event.item_ref,action:event.action,before:clone({entities:bound.revision.identity.entities,mapping:bound.revision.identity.mapping,pending:bound.revision.identity.pending,blocked:bound.revision.identity.blocked}),after:clone({entities:identity.entities,mapping:identity.mapping,pending:identity.pending,blocked:identity.blocked}),...recordImpact(refs)};
  });
  const definitionChanges=effectiveEvents.filter(event=>event.item_kind==='DEFINITION').map(event=>{
    const lines=new Set(event.affected_definition_lineages??[]),after=ontology.definitions.filter(definition=>lines.has(lineage(definition))),refs=unique(after.flatMap(definition=>array(definition.knowledge_refs)));
    return {item_ref:event.item_ref,action:event.action,before:clone(event.definition_before??{definitions:[],mappings:[]}),after:{definitions:clone(after),mappings:clone(array(ontology.definition_mappings).filter(mapping=>after.some(definition=>[mapping.source_definition_ref,mapping.target_definition_ref].includes(definition.definition_ref))))},...recordImpact(refs)};
  });
  const bindingChanges=projected.flatMap(after=>{
    const recordRef=refOf(after),before=bound.revision.knowledge.find(record=>refOf(record)===recordRef);if(!before)return [];
    const changedFields=bindingFields.filter(field=>hash(before[field]??null)!==hash(after[field]??null));if(!changedFields.length)return [];
    return [{record_ref:recordRef,before:clone(before),after:clone(after),changed_fields:changedFields,...recordImpact([recordRef]),graph_before:{nodes:beforeGraph.nodes.filter(node=>array(node.record_refs).includes(recordRef)),edges:beforeGraph.edges.filter(edge=>array(edge.record_refs).includes(recordRef))},graph_after:{nodes:afterGraph.nodes.filter(node=>array(node.record_refs).includes(recordRef)),edges:afterGraph.edges.filter(edge=>array(edge.record_refs).includes(recordRef))}}];
  });
  const affected=new Set([...bindingChanges.map(row=>row.record_ref),...identityChanges.flatMap(row=>row.affected_knowledge_refs),...definitionChanges.flatMap(row=>row.affected_knowledge_refs)]),unresolvedImpacts=projected.filter(row=>affected.has(refOf(row))).flatMap(row=>['ontology_alignment','relation_ontology_alignment'].flatMap(field=>row[field]&&row[field].status!=='ALIGNED'?[{kind:'DEFINITION_BINDING',record_ref:refOf(row),reason:row[field].reason??'DEFINITION_MAPPING_UNRESOLVED',status:row[field].status,knowledge_refs:[refOf(row)]}]:[]));
  unresolvedImpacts.push(...identity.pending.filter(row=>[row.left_id,row.right_id].flatMap(id=>array(identity.profiles.find(profile=>profile.id===id)?.knowledge_refs)).some(ref=>affected.has(ref))).map(row=>({kind:'IDENTITY',reason:row.reason??'IDENTITY_UNRESOLVED',decision_ref:row.decision_ref,knowledge_refs:unique([row.left_id,row.right_id].flatMap(id=>array(identity.profiles.find(profile=>profile.id===id)?.knowledge_refs)))})));
  const versionRefs=effectiveEvents.map(event=>event.event_ref),stateRefs=events.filter(event=>!versionChange(event)).map(event=>event.event_ref);
  return signed({policy: LIBRARY_REVIEW_APPLICATION_POLICY, application_ref: applicationRef,
    library_id: args.libraryId, source_run_id: args.runId, source_snapshot_ref: args.snapshotId,
    source_fingerprint: bound.revision.source_fingerprint,
    source_revision_ref: bound.revision.revision_ref, source_revision_sha256: bound.revision.record_sha256,
    source_input_sha256: bound.revision.input_sha256, event_refs: events.map(event => event.event_ref),
    event_set_sha256: hash(events), identity, ontology,version_event_refs:versionRefs,effective_version_event_refs:versionRefs,state_event_refs:stateRefs,effect:versionRefs.length?'VERSION_CHANGE':'STATE_ONLY',application_required:versionRefs.length>0,
    knowledge: projected, content_changes: contentChanges,identity_changes:identityChanges,definition_changes:definitionChanges,binding_changes:bindingChanges,unresolved_impacts:unresolvedImpacts,
    gaps: [...array(bound.revision.gaps), ...(identity.pending.length ? ['HUMAN_IDENTITY_UNRESOLVED'] : [])],
    warnings: unique([...array(bound.revision.warnings), ...identity.blocked.map(value => value.warning)]),
    source_knowledge: sourceKnowledge, original_knowledge: clone(bound.input.knowledge),original_review_history:clone(bound.revision.review_history??[]), cq_input: clone(bound.input.cq_input),
    families: clone(bound.input.families), status: 'PENDING_APPLICATION'});
}

function verifiedInheritedAppliedEvent(store, value, application) {
  if (!textField(value.review_event_ref) || !textField(value.applied_receipt_ref)) return null;
  const saved = store.getRecord(R.APPLIED, value.applied_receipt_ref);
  if (!saved) return null;
  const receipt = checked(saved, 'NATIVE_LIBRARY_REVIEW_APPLIED_CHANGED'),
    event = checked(store.getRecord(R.EVENT, value.review_event_ref), 'NATIVE_LIBRARY_REVIEW_EVENT_CHANGED');
  need(receipt.policy === LIBRARY_REVIEW_POLICY && receipt.status === 'APPLIED' &&
    receipt.applied_receipt_ref === value.applied_receipt_ref &&
    receipt.library_id === application.library_id && event.library_id === application.library_id &&
    receipt.source_snapshot_ref === application.source_snapshot_ref && event.source_snapshot_ref === application.source_snapshot_ref &&
    receipt.source_run_id === event.source_run_id && receipt.source_revision_ref === event.source_revision_ref &&
    array(receipt.event_refs).includes(event.event_ref) &&
    (!textField(value.application_ref) || value.application_ref === receipt.application_ref),
  'NATIVE_LIBRARY_REVIEW_APPLIED_CHANGED');
  return versionChange(event) ? event.event_ref : null;
}

export function installNativeLibraryReviewApplication({store, catalog, application, targetRunId, currentRevisionRef}) {
  checked(application, 'NATIVE_LIBRARY_REVIEW_APPLICATION_CHANGED');
  need(application.application_required!==false,'NATIVE_LIBRARY_REVIEW_NO_VERSION_CHANGE');
  need(textField(targetRunId) && targetRunId !== application.source_run_id,
    'NATIVE_LIBRARY_REVIEW_NEW_RUN_REQUIRED');
  const args = {store, catalog, libraryId: application.library_id, snapshotId: application.source_snapshot_ref,
    runId: application.source_run_id, revisionRef: application.source_revision_ref, currentRevisionRef};
  const fresh = prepareNativeLibraryReviewApplication(args);
  need(hash(fresh) === hash(application), 'NATIVE_LIBRARY_REVIEW_APPLICATION_STALE');
  const installationRef = 'library_review_installation_' + hash([application.application_ref, targetRunId]);
  const appliedRef = 'library_review_applied_' + hash(installationRef);
  const currentEventRefs=new Set(application.version_event_refs??application.event_refs);
  const decorate = value => (value.author === 'HUMAN' || value.source === 'HUMAN')&&currentEventRefs.has(value.review_event_ref) ?
    {...value, application_ref: application.application_ref, applied_receipt_ref: appliedRef} : clone(value);
  const identity = {...clone(application.identity), decisions: application.identity.decisions.map(decorate),
    pending: array(application.identity.pending).map(decorate), blocked: array(application.identity.blocked).map(decorate)};
  const definitionRefMap=new Map();
  const definitions = application.ontology.definitions.map(value => {
    if (value.author !== 'HUMAN' && value.source !== 'HUMAN') {definitionRefMap.set(value.definition_ref,value.definition_ref);return clone(value);}
    const result=decorate(value),{definition_ref:_old,...body}=result;
    const next={...body,definition_lineage_ref:lineage(value),previous_definition_ref:value.previous_definition_ref??value.definition_ref};
    const definition={...next,definition_ref:'ontology_definition_'+hash(next)};definitionRefMap.set(value.definition_ref,definition.definition_ref);return definition;
  });
  const mapRef=ref=>definitionRefMap.get(ref)??ref;
  for(const [index,definition] of definitions.entries())if(textField(definition.unified_into_definition_ref)){definition.unified_into_definition_ref=mapRef(definition.unified_into_definition_ref);const {definition_ref,...body}=definition;definition.definition_ref='ontology_definition_'+hash(body);definitionRefMap.set(application.ontology.definitions[index].definition_ref,definition.definition_ref);}
  const definitionMappings=array(application.ontology.definition_mappings).map(value=>{
    const source=definitions.find(definition=>definition.definition_ref===mapRef(value.source_definition_ref)),target=definitions.find(definition=>definition.definition_ref===mapRef(value.target_definition_ref));
    need(source&&target,'NATIVE_LIBRARY_REVIEW_MAPPING_TARGET_CHANGED');
    const {mapping_ref:_previousMappingRef,...mappingBody}=decorate(value);
    const next={...mappingBody,mapping_lineage_ref:value.mapping_lineage_ref??value.mapping_ref,source_definition_ref:source.definition_ref,source_definition_sha256:hash(source),target_definition_ref:target.definition_ref,target_definition_sha256:hash(target),source_definition_lineage_ref:lineage(source),target_definition_lineage_ref:lineage(target)};
    return {...next,mapping_ref:'definition_mapping_'+hash(next)};
  });
  const ontology = {...clone(application.ontology), definitions,definition_mappings:definitionMappings};
  const sourceKnowledge = application.source_knowledge.map(record => installKnowledgeReviewReceipt(record, {
    eventRefs: application.version_event_refs??application.event_refs, applicationRef: application.application_ref, appliedRef}));
  const inputSha = hash({libraryId: application.library_id, snapshotId: application.source_snapshot_ref,
    knowledge: sourceKnowledge, cqInput: application.cq_input, families: application.families});
  const revisionRef = 'library_knowledge_revision_' + hash([targetRunId, inputSha,
    application.application_ref, identity, ontology]);
  const inheritedRows = [...identity.decisions, ...definitions, ...sourceKnowledge.flatMap(knowledgeReviewRows)]
    .filter(value => value.author === 'HUMAN' || value.source === 'HUMAN');
  const inheritedEvents = inheritedRows.map(value => value.review_event_ref).filter(textField);
  // History includes superseded pending decisions. Only a real prior receipt
  // proves inherited application; current effective decisions receive this one.
  const inheritedAppliedEvents = inheritedRows.filter(value => !currentEventRefs.has(value.review_event_ref))
    .map(value => verifiedInheritedAppliedEvent(store, value, application)).filter(textField);
  const reviewApplication = {application_ref: application.application_ref, installation_ref: installationRef,
    applied_receipt_ref: appliedRef, source_run_id: application.source_run_id,
    source_revision_ref: application.source_revision_ref,
    event_refs: unique([...(application.version_event_refs??application.event_refs), ...inheritedAppliedEvents]).filter(ref=>versionChange(checked(store.getRecord(R.EVENT,ref),'NATIVE_LIBRARY_REVIEW_EVENT_CHANGED'))),state_event_refs:clone(application.state_event_refs??[]),effect:'VERSION_CHANGE',application_required:true,event_set_sha256: application.event_set_sha256};
  const result = signed({policy: LIBRARY_KNOWLEDGE_POLICY, run_id: targetRunId,
    library_id: application.library_id, source_snapshot_ref: application.source_snapshot_ref,
    source_fingerprint: application.source_fingerprint, input_sha256: inputSha, revision_ref: revisionRef,
    knowledge: projectKnowledge(sourceKnowledge, {identity, definitions,definitionMappings, revisionRef}),
    identity, ontology, gaps: clone(application.gaps), warnings: clone(application.warnings),
    invocations: [], original_knowledge_preserved: true,review_history:unique([...array(fresh.original_review_history).map(row=>row.review_event_ref),...application.event_refs,...inheritedEvents]).map(review_event_ref=>({...clone(array(fresh.original_review_history).find(row=>row.review_event_ref===review_event_ref)??{}),author:'HUMAN',review_event_ref,...(currentEventRefs.has(review_event_ref)?{applied_receipt_ref:appliedRef}:{})})), review_application: reviewApplication});
  const input = {run_id: targetRunId, library_id: application.library_id,
    source_snapshot_ref: application.source_snapshot_ref, source_fingerprint: application.source_fingerprint,
    input_sha256: inputSha, policy: LIBRARY_KNOWLEDGE_POLICY, knowledge: clone(sourceKnowledge),
    cq_input: clone(application.cq_input), families: clone(application.families),
    review_origin: {application_ref: application.application_ref, source_run_id: application.source_run_id,
      source_revision_ref: application.source_revision_ref}};
  store.transaction(() => {
    need(hash(prepareNativeLibraryReviewApplication(args)) === hash(application),
      'NATIVE_LIBRARY_REVIEW_APPLICATION_STALE');
    append(store, K.INPUT, targetRunId, input);
    append(store, R.REVISION, revisionRef, result);
    append(store, R.PROJECTION, targetRunId, {run_id: targetRunId, library_id: application.library_id,
      revision_ref: revisionRef, record_sha256: result.record_sha256});
    append(store, R.INSTALLATION, targetRunId, signed({installation_ref: installationRef,
      application_ref: application.application_ref, library_id: application.library_id,
      source_run_id: application.source_run_id, source_revision_ref: application.source_revision_ref,
      source_snapshot_ref: application.source_snapshot_ref, target_run_id: targetRunId,
      target_revision_ref: revisionRef, applied_receipt_ref: appliedRef,
      readback_contract:'LIBRARY_REVIEW_READBACK_V2',binding_record_refs:array(application.binding_changes).map(row=>row.record_ref),event_refs: reviewApplication.event_refs,state_event_refs:reviewApplication.state_event_refs,effect:'VERSION_CHANGE',application_required:true,event_set_sha256: application.event_set_sha256}));
  });
  return clone(result);
}

const revisionRefs = value => unique([value?.library_revision_ref, value?.library_knowledge?.revision_ref,
  value?.library_knowledge_revision_ref, value?.manifest?.library_revision_ref].filter(textField));
const matchesRevision = (value, revision) => {
  const refs = revisionRefs(value); return refs.length > 0 && refs.every(ref => ref === revision);
};
export function confirmNativeLibraryReviewApplication({store, catalog, libraryId, snapshotId,
  targetRunId, applicationRef, now = () => new Date().toISOString()}) {
  const installation = checked(store.getRecord(R.INSTALLATION, targetRunId),
    'NATIVE_LIBRARY_REVIEW_INSTALLATION_MISSING');
  need(installation.library_id === libraryId && installation.source_snapshot_ref === snapshotId &&
    installation.application_ref === applicationRef, 'NATIVE_LIBRARY_REVIEW_INSTALLATION_CHANGED');
  const old = store.getRecord(R.APPLIED, installation.applied_receipt_ref);
  if (old) return clone(checked(old, 'NATIVE_LIBRARY_REVIEW_APPLIED_CHANGED'));
  const args = {store, catalog, libraryId, snapshotId, runId: installation.source_run_id,
    revisionRef: installation.source_revision_ref};
  const bound = readBound(args); assertActive(args, bound);
  need(hash(readEvents(store, bound.binding)) === installation.event_set_sha256,
    'NATIVE_LIBRARY_REVIEW_APPLICATION_STALE');
  const target = readBound({store, catalog, libraryId, snapshotId, runId: targetRunId,
    revisionRef: installation.target_revision_ref});
  const ledger = store.getRecord('native_full_run_v1', targetRunId);
  const state = store.getRecord('native_full_chain_state_v1', targetRunId);
  const readback = state?.readback, build = state?.build;
  need(ledger && ['SUCCEEDED', 'PARTIALLY_READY'].includes(ledger.status) && ledger.phase === 'READBACK_VERIFIED' &&
    readback?.verified === true && build?.source_current !== false,
  'NATIVE_LIBRARY_REVIEW_READBACK_REQUIRED');
  need(Array.isArray(ledger.attempts) && ledger.attempts.every(attempt => attempt.outcome === 'RETURNED'),
    'NATIVE_LIBRARY_REVIEW_REQUESTS_UNSETTLED');
  need(build?.source_index?.status === 'READY' && build?.knowledge_index?.status === 'READY' &&
    readback.source_graph?.status === 'READY' && readback.knowledge_graph?.status === 'READY' &&
    readback.source_graph.index_revision === build.source_index.index_revision &&
    readback.knowledge_graph.index_revision === build.knowledge_index.index_revision,
  'NATIVE_LIBRARY_REVIEW_INDEX_READBACK_REQUIRED');
  const revision = target.revision.revision_ref;
  need(matchesRevision(build, revision) && matchesRevision(readback.knowledge_graph, revision) &&
    matchesRevision(build.knowledge_index, revision),
  'NATIVE_LIBRARY_REVIEW_READBACK_BINDING_REQUIRED');
  if(installation.readback_contract==='LIBRARY_REVIEW_READBACK_V2'){
    need(readback.source_content?.verified===true&&readback.source_content.run_id===targetRunId&&readback.source_content.library_id===libraryId&&readback.source_content.source_snapshot_ref===snapshotId&&readback.source_content.source_index_revision===build.source_index.index_revision,'NATIVE_LIBRARY_REVIEW_SOURCE_CONTENT_READBACK_REQUIRED');
    need(readback.definition_mappings?.verified===true&&readback.definition_mappings.knowledge_revision_ref===revision&&readback.definition_mappings.knowledge_index_revision===build.knowledge_index.index_revision&&readback.definition_mappings.mappings_sha256===hash(target.revision.ontology.definition_mappings??[]),'NATIVE_LIBRARY_REVIEW_MAPPING_READBACK_REQUIRED');
    need(array(installation.binding_record_refs).every(ref=>array(readback.binding_changes).some(row=>row.record_ref===ref&&row.verified===true&&row.knowledge_revision_ref===revision&&row.knowledge_index_revision===build.knowledge_index.index_revision)),'NATIVE_LIBRARY_REVIEW_BINDING_READBACK_REQUIRED');
  }
  const receipt = signed({policy: LIBRARY_REVIEW_POLICY, status: 'APPLIED',
    applied_receipt_ref: installation.applied_receipt_ref, installation_ref: installation.installation_ref,
    application_ref: applicationRef, library_id: libraryId, source_snapshot_ref: snapshotId,
    source_run_id: installation.source_run_id, source_revision_ref: installation.source_revision_ref,
    target_run_id: targetRunId, target_revision_ref: revision,
    target_revision_sha256: target.revision.record_sha256,
    source_index_revision: build.source_index.index_revision,
    knowledge_index_revision: build.knowledge_index.index_revision,
    event_refs: clone(installation.event_refs),state_event_refs:clone(installation.state_event_refs??[]),effect:'VERSION_CHANGE',application_required:true,event_set_sha256: installation.event_set_sha256,
    created_at: now()});
  return store.transaction(() => clone(append(store, R.APPLIED, receipt.applied_receipt_ref, receipt)));
}
