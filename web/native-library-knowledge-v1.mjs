/** Library identities and ontology projections. Source-local knowledge remains immutable. */
import {hash, clone, need, textField} from './cq-discovery-store-v2.mjs';
import {nativeActionIdentityEntities,isNativeActionKnowledge,projectNativeActionIdentityReferences} from './native-action-identity-projection-v1.mjs';

export const LIBRARY_KNOWLEDGE_POLICY = 'LIBRARY_KNOWLEDGE_V1';
export const LIBRARY_KNOWLEDGE_RECORDS = Object.freeze({
  INPUT:'native_library_knowledge_input_v1', STATE:'native_library_knowledge_state_v1',
  ENTITY:'native_library_canonical_entity_v1', MAPPING:'native_library_identity_mapping_v1',
  DEFINITION:'native_library_ontology_definition_v1', DECISION:'native_library_identity_decision_v1'
});
const array = v => Array.isArray(v) ? v : [];
const unique = rows => [...new Map(rows.map(v => [hash(v), v])).values()];
export const libraryNameKey = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase() : '';
const namesOf = e => unique([e.name,e.label,...array(e.aliases)].filter(textField));
const localId = e => e.id ?? e.entity_ref;

export function collectLibraryEntities(knowledge, existingEntities = []) {
  const profiles = new Map();
  for (const row of knowledge) for (const entity of nativeActionIdentityEntities(row)) {
    const id = localId(entity); if (!textField(id)) continue;
    const p = profiles.get(id) ?? {id, name:entity.name??entity.label, aliases:[], types:[], descriptions:[], source_refs:[], knowledge_refs:[], statements:[], neighbors:[], existing:false,current:true};
    p.aliases = unique([...p.aliases,...namesOf(entity)]);
    p.types = unique([...p.types,entity.entity_type,...array(entity.observed_types)].filter(textField));
    p.descriptions = unique([...p.descriptions,entity.description].filter(textField));
    p.source_refs = unique([...p.source_refs,...array(entity.source_refs),...array(row.source_refs)]);
    p.knowledge_refs = unique([...p.knowledge_refs,row.knowledge_ref??row.record_ref].filter(textField));
    p.statements = unique([...p.statements,{text:row.statement??row.text??'',kind:row.kind,quote:row.model_quote??null,conditions:row.conditions??null,time_text:row.time_text??null,modality:row.modality??null}]);
    p.neighbors = unique([...p.neighbors,...array(row.domain?.entities).filter(e=>localId(e)!==id).flatMap(namesOf)]);
    profiles.set(id,p);
  }
  for (const e of existingEntities) {
    const id=e.canonical_id??e.id; if(!textField(id))continue;
    const current=profiles.get(id);
    profiles.set(id,{id,name:e.name,aliases:unique([...namesOf(e),...array(current?.aliases)]),types:unique([...array(e.observed_types??e.types),...array(current?.types)]),descriptions:unique([...array(e.descriptions??(e.description?[e.description]:[])),...array(current?.descriptions)]),source_refs:unique([...array(e.source_refs),...array(current?.source_refs)]),knowledge_refs:unique([...array(e.knowledge_refs),...array(current?.knowledge_refs)]),statements:unique([...array(e.statements),...array(current?.statements)]),neighbors:unique([...array(e.neighbors),...array(current?.neighbors)]),existing:true,current:!!current});
  }
  return [...profiles.values()].sort((a,b)=>a.id.localeCompare(b.id)).map((p,i)=>({...p,entity_ref:'E'+(i+1)}));
}

function grams(s) { const chars=[...libraryNameKey(s)]; return new Set(chars.length<3?[chars.join('')]:chars.slice(0,-2).map((_,i)=>chars.slice(i,i+3).join(''))); }
function similar(a,b) {const x=grams(a),y=grams(b);if(!x.size||!y.size)return 0;return 2*[...x].filter(v=>y.has(v)).length/(x.size+y.size);}

/** Retrieval only: similarity and types never authorize an identity merge. */
export function libraryIdentityCandidates(profiles) {
  const pairs=[];
  for(let i=0;i<profiles.length;i++)for(let j=i+1;j<profiles.length;j++){
    const a=profiles[i],b=profiles[j];if(a.current===false&&b.current===false)continue;
    const an=unique([a.name,...a.aliases].map(libraryNameKey).filter(Boolean)),bn=unique([b.name,...b.aliases].map(libraryNameKey).filter(Boolean));
    const exact=an.some(n=>bn.includes(n));
    const score=Math.max(0,...an.flatMap(x=>bn.map(y=>similar(x,y))));
    if(exact||score>=0.55)pairs.push({pair_ref:'P'+(pairs.length+1),left_ref:a.entity_ref,right_ref:b.entity_ref,left_id:a.id,right_id:b.id,retrieval:exact?'NAME_OR_ALIAS':'NAME_SIMILARITY',retrieval_score:score});
  }
  return pairs;
}

export function projectLibraryIdentities({libraryId, profiles, decisions, priorMappings=[], revokedDecisionRefs=[]}) {
  const byRef=new Map(profiles.map(p=>[p.entity_ref,p])),byId=new Map(profiles.map(p=>[p.id,p]));
  const parent=new Map(profiles.map(p=>[p.id,p.id])),members=new Map(profiles.map(p=>[p.id,new Set([p.id])])),blocked=[],pending=[];
  const find=id=>{let p=id;while(parent.get(p)!==p)p=parent.get(p);return p;};
  const ends=d=>[byRef.get(d.left_ref)?.id??d.left_id,byRef.get(d.right_ref)?.id??d.right_id];
  const human=d=>[d.author,d.source,d.origin].includes('HUMAN'),pairKey=d=>hash(ends(d).sort());
  const retained=decisions.filter(d=>!revokedDecisionRefs.includes(d.decision_ref)),humanByPair=new Map(retained.filter(human).map(d=>[pairKey(d),d]));
  const overridden=retained.filter(d=>!human(d)&&humanByPair.has(pairKey(d))&&humanByPair.get(pairKey(d)).decision!==d.decision);
  const live=retained.filter(d=>human(d)?humanByPair.get(pairKey(d))===d:!humanByPair.has(pairKey(d)));
  blocked.push(...overridden.map(d=>({...clone(d),warning:'IDENTITY_HUMAN_DECISION_PREVAILS'})));
  const different=live.filter(d=>d.decision==='different'||human(d)&&d.decision==='uncertain').map(d=>ends(d));
  // Previous mappings are identity evidence, not permission to assign the same
  // canonical ID to disconnected components after a revocation/cannot-link.
  const usablePrior=priorMappings.filter(m=>m.library_id===libraryId&&m.status!=='REVOKED'&&!array(m.decision_refs).some(ref=>revokedDecisionRefs.includes(ref)));
  const priorGroups=new Map();for(const m of usablePrior){const ids=priorGroups.get(m.canonical_id)??new Set();if(byId.has(m.local_entity_id))ids.add(m.local_entity_id);if(byId.has(m.canonical_id))ids.add(m.canonical_id);priorGroups.set(m.canonical_id,ids);}
  const conflictingPrior=new Set([...priorGroups].filter(([,ids])=>different.some(([a,b])=>ids.has(a)&&ids.has(b))).map(([canonical])=>canonical));
  const prior=new Map(usablePrior.filter(m=>!conflictingPrior.has(m.canonical_id)).map(m=>[m.local_entity_id,m.canonical_id]));
  const join=(a,b)=>{const x=find(a),y=find(b);if(x===y)return true;const mx=members.get(x),my=members.get(y);if(different.some(([u,v])=>(mx.has(u)&&my.has(v))||(mx.has(v)&&my.has(u))))return false;const preferred=byId.get(x).existing?x:byId.get(y).existing?y:[x,y].sort()[0],other=preferred===x?y:x;parent.set(other,preferred);members.set(preferred,new Set([...mx,...my]));members.delete(other);return true;};
  for(const [canonical,ids]of priorGroups){if(conflictingPrior.has(canonical))continue;const rows=[...ids];for(let i=1;i<rows.length;i++)join(rows[0],rows[i]);}
  for(const d of live){
    const [a,b]=ends(d);if(!byId.has(a)||!byId.has(b)||a===b)continue;
    if(d.decision!=='same'){if(d.decision==='uncertain')pending.push({...clone(d),left_id:a,right_id:b});continue;}
    if(!textField(d.reason)){pending.push({...clone(d),warning:'IDENTITY_REASON_MISSING'});continue;}
    if(!join(a,b))blocked.push({...clone(d),warning:'IDENTITY_CANNOT_LINK_CONFLICT'});
  }
  const entities=[],mapping=[],redirects=[],claimed=new Set();
  for(const [root,ids]of members){
    const group=[...ids].map(id=>byId.get(id));
    const existing=group.filter(p=>p.existing).sort((a,b)=>a.id.localeCompare(b.id));
    const active=group.filter(p=>p.current!==false);if(!active.length)continue;
    let canonicalId=existing[0]?.id??prior.get(root)??'canonical_'+hash([libraryId,root]);
    if(claimed.has(canonicalId))canonicalId='canonical_'+hash([libraryId,root,'separate']);claimed.add(canonicalId);
    const name=existing[0]?.name??active[0].name;
    const entity={id:canonicalId,canonical_id:canonicalId,library_id:libraryId,name,label:name,kind:'ENTITY',entity_type:null,aliases:unique(group.flatMap(p=>[p.name,...p.aliases]).filter(textField)).filter(n=>n!==name),observed_types:unique(group.flatMap(p=>p.types)),descriptions:unique(group.flatMap(p=>p.descriptions)),source_refs:unique(group.flatMap(p=>p.source_refs)),local_entity_ids:active.map(p=>p.id),knowledge_refs:unique(active.flatMap(p=>p.knowledge_refs)),neighbors:unique(group.flatMap(p=>p.neighbors))};
    entities.push(entity);
    for(const p of existing)if(p.id!==canonicalId)redirects.push({from:p.id,to:canonicalId});
    for(const p of active)mapping.push({library_id:libraryId,local_entity_id:p.id,canonical_id:canonicalId,status:'ACTIVE',decision_refs:live.filter(d=>d.decision==='same'&&ends(d).every(id=>ids.has(id))).map(d=>d.decision_ref).filter(Boolean)});
  }
  return {entities,mapping,redirects,pending,blocked,summary:{source_entities:profiles.filter(p=>p.current!==false).length,canonical_entities:entities.length,merged_sources:mapping.length-entities.length,unresolved:pending.length,blocked:blocked.length}};
}

// This only checks literal representation against an explicitly declared type.
// It never rewrites values or infers measurement precision, units or identity.
function literalValueTypes(value){
  if(typeof value==='number')return Number.isFinite(value)?['number']:[];
  if(typeof value==='boolean')return ['bool'];
  if(typeof value!=='string')return [];
  const text=value.trim();
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)&&Number.isFinite(Number(text))?['text','number']:['text'];
}

/** Stable, source-local signatures; ordinal T references are navigation only. */
export function libraryShapeSignature(shape){
  return 'library_shape_'+hash({kind:shape.kind,label:libraryNameKey(shape.label),
    owner_kind:shape.subject_kind??shape.owner_kind??'ENTITY',subject_type:shape.subject_type??null,
    object_type:shape.object_type??null,direction:shape.direction??shape.source_direction??'SUBJECT_TO_OBJECT',
    value_types:[...array(shape.value_types??(shape.value_type?[shape.value_type]:[]))].sort(),
    unit:shape.unit??null,owner_relation:shape.owner_relation??null,
    observed_contexts:unique(array(shape.examples).map(example=>({conditions:example.conditions??null,time_text:example.time_text??null,
      version_text:example.version_text??null,negation:example.negation??null,modality:example.modality??null,
      exceptions:example.exceptions??null,comparison:example.comparison??null}))).sort((a,b)=>hash(a).localeCompare(hash(b))),
    knowledge_refs:[...array(shape.knowledge_refs)].sort()});
}
export function definitionScopeSignature(definition){
  return hash(Object.fromEntries(['kind','domains','ranges','parents','datatype','unit','mapping_direction','attribute_owner']
    .map(key=>[key,Array.isArray(definition[key])?[...definition[key]].sort():definition[key]??null])));
}
function sourceLocalKnowledge(row){
  const p=row.library_projection;if(!p)return row;
  return {...row,domain:clone(p.source_local_domain??row.domain),subject_ref:p.source_local_subject_ref??row.subject_ref,
    object_ref:p.source_local_object_ref??row.object_ref,direction:p.source_local_direction??row.direction,
    ...(row.kind==='RELATION'&&row.ontology_alignment?.original_label?{predicate:row.ontology_alignment.original_label}:{}),
    ...(row.kind==='ATTRIBUTE'&&row.ontology_alignment?.original_label?{attribute:row.ontology_alignment.original_label}:{})};
}

export function collectLibraryOntologyShapes(knowledge, identity) {
  const shapes=new Map(),entityById=new Map(identity.entities.map(e=>[e.id,e])),mapping=new Map(identity.mapping.map(m=>[m.local_entity_id,m.canonical_id]));
  const name=id=>entityById.get(mapping.get(id)??id)?.name??id;
  function add(kind,label,row,extra={}){
    if(!textField(label))return;
    const sourceEntities=array(row.domain?.entities),subjectType=sourceEntities.find(e=>e.id===row.subject_ref)?.entity_type??null,objectType=sourceEntities.find(e=>e.id===row.object_ref)?.entity_type??null;
    const direction=row.direction==='OBJECT_TO_SUBJECT'?'OBJECT_TO_SUBJECT':'SUBJECT_TO_OBJECT',subjectKind=kind==='ATTRIBUTE'&&(row.kind==='RELATION'||row.domain?.relation)?'RELATION':'ENTITY';
    const ownerRelation=subjectKind==='RELATION'?{predicate:row.kind==='RELATION'?row.predicate:row.domain.relation.predicate,
      subject_type:subjectType,object_type:objectType,direction}:null;
    const valueType=kind==='ATTRIBUTE'?(typeof row.raw_value==='number'?'number':typeof row.raw_value==='boolean'?'bool':typeof row.raw_value==='string'?'text':'unknown'):null,valueTypes=kind==='ATTRIBUTE'?literalValueTypes(row.raw_value):[];
    const key=hash([kind,label,kind==='CLASS'?null:subjectType,kind==='RELATION'?objectType:null,kind==='RELATION'?direction:null,subjectKind,valueType,valueTypes,extra.unit??null,ownerRelation]),old=shapes.get(key)??{kind,label,subject_type:subjectType,object_type:objectType,subject_kind:subjectKind,owner_relation:ownerRelation,object_is_value:kind==='ATTRIBUTE',value_type:valueType,value_types:valueTypes,direction,examples:[],knowledge_refs:[],...extra};
    old.knowledge_refs=unique([...old.knowledge_refs,row.knowledge_ref??row.record_ref].filter(textField));
    const ex={text:row.statement??row.text??'',subject:row.subject_ref?name(row.subject_ref):null,object:row.object_ref?name(row.object_ref):null,value:row.raw_value??null,conditions:row.conditions??null,modality:row.modality??null,direction:row.direction??'SUBJECT_TO_OBJECT',negation:row.negation??null,exceptions:row.exceptions??null,comparison:row.comparison??null,time_text:row.time_text??null,version_text:row.version_text??null};
    old.examples=unique([...old.examples,ex]);shapes.set(key,old);
  }
  for(const input of knowledge){const row=sourceLocalKnowledge(input);
    for(const e of array(row.domain?.entities))if(textField(e.entity_type))add('CLASS',e.entity_type,row);
    if(row.kind==='RELATION')add('RELATION',row.predicate,row);
    if(row.domain?.relation)add('RELATION',row.domain.relation.predicate,{...row,subject_ref:row.domain.relation.subject,object_ref:row.domain.relation.object,direction:row.domain.relation.direction??row.direction});
    if(row.kind==='ATTRIBUTE')add('ATTRIBUTE',row.attribute,row,{unit:row.unit??null});
    const attributes=Array.isArray(row.attributes)?row.attributes.map(a=>[a.attribute??a.name,a.value??a.raw_value,a.unit]):Object.entries(row.attributes??{}).map(([attribute,value])=>[attribute,value,null]);
    for(const [attribute,value,unit]of attributes)add('ATTRIBUTE',attribute,{...row,raw_value:value},{unit});
  }
  return [...shapes.values()].map((s,i)=>({...s,shape_ref:'T'+(i+1),shape_signature:libraryShapeSignature(s)}));
}

/** Rebuild only uniquely identified saved bindings; never infer a name from reason. */
export function resolveLibraryDefinitionShapes(definition,shapes){
  const old=array(definition.shape_bindings);
  if(!old.length)return {shapes:shapes.filter(s=>array(definition.shape_refs).includes(s.shape_ref)),overlays:[],problems:[]};
  const selected=new Map(),overlays=[],problems=[];
  for(const binding of old){
    const refs=array(binding.knowledge_refs),matches=shapes.filter(s=>s.kind===binding.kind&&s.label===binding.label&&
      refs.length&&refs.every(ref=>array(s.knowledge_refs).includes(ref)));
    if(matches.length!==1){problems.push({code:matches.length?'LEGACY_SHAPE_BINDING_AMBIGUOUS':'LEGACY_SHAPE_BINDING_MISSING',
      original_shape_ref:binding.shape_ref,kind:binding.kind,label:binding.label,knowledge_refs:clone(refs)});continue;}
    const shape=matches[0];selected.set(libraryShapeSignature(shape),shape);
    if(binding.shape_ref!==shape.shape_ref||binding.subject_kind!==shape.subject_kind||(binding.unit??null)!==(shape.unit??null))
      overlays.push({policy:'LIBRARY_BINDING_RECONSTRUCTION_V1',status:'UNIQUE',original_binding:clone(binding),
        shape_ref:shape.shape_ref,shape_signature:libraryShapeSignature(shape),reason:'EXACT_KIND_LABEL_KNOWLEDGE_SCOPE'});
  }
  return {shapes:[...selected.values()],overlays,problems};
}

function compatibleType(declared,observed,classes){
  if(!declared.length)return {status:'UNBOUND',reason:'TYPE_SCOPE_NOT_DECLARED'};
  if(!textField(observed))return {status:'UNBOUND',reason:'ENDPOINT_TYPE_UNKNOWN'};
  const known=new Set([libraryNameKey(observed)]),queue=[observed];
  while(queue.length){const term=queue.shift();for(const c of classes.filter(d=>d.kind==='CLASS'&&d.status==='USABLE'&&[d.name,d.key,...array(d.observed_labels)].some(v=>libraryNameKey(v)===libraryNameKey(term))))for(const word of [c.name,...array(c.parents)]){const key=libraryNameKey(word);if(key&&!known.has(key)){known.add(key);queue.push(word);}}}
  return declared.some(d=>known.has(libraryNameKey(d)))?{status:'ALIGNED'}:{status:'PENDING',reason:'EXPLICIT_ENDPOINT_SCOPE_MISMATCH'};
}

/** These are bindings to observed signatures, not a new semantic judgment. */
export function libraryDefinitionBindings(definition,shapes,classes=[]){
  const resolved=resolveLibraryDefinitionShapes(definition,shapes);
  return resolved.shapes.map(shape=>{
    const direction=definition.mapping_direction??'forward',warnings=[];
    let result={status:'ALIGNED'};
    if(shape.kind==='RELATION'){
      if(!['forward','reverse'].includes(direction))result={status:'UNBOUND',reason:'MAPPING_DIRECTION_UNKNOWN'};
      else{
        const subject=shape.direction==='OBJECT_TO_SUBJECT'?shape.object_type:shape.subject_type,object=shape.direction==='OBJECT_TO_SUBJECT'?shape.subject_type:shape.object_type;
        const a=compatibleType(array(definition.domains),direction==='reverse'?object:subject,classes),b=compatibleType(array(definition.ranges),direction==='reverse'?subject:object,classes);
        const bad=[a,b].filter(r=>r.status!=='ALIGNED');if(bad.length)result=bad.find(r=>r.status==='PENDING')??bad[0];
      }
    }else if(shape.kind==='ATTRIBUTE'){
      if(direction!=='forward')result={status:'PENDING',reason:'VALUE_PROPERTY_CANNOT_REVERSE'};
      else if(shape.subject_kind==='RELATION'){
        const owner=definition.attribute_owner;
        if(!owner||owner.kind!=='RELATION'||owner.predicate!==shape.owner_relation?.predicate)
          result={status:'UNBOUND',reason:'RELATION_ATTRIBUTE_OWNER_UNDECLARED'};
        else if(!textField(definition.datatype)||!array(shape.value_types??[shape.value_type]).includes(definition.datatype))
          result={status:'UNBOUND',reason:!textField(definition.datatype)?'VALUE_DATATYPE_UNDECLARED':'VALUE_DATATYPE_UNVERIFIED'};
      }
      else{result=compatibleType(array(definition.domains),shape.subject_type,classes);if(result.status==='ALIGNED'&&(!textField(definition.datatype)||!array(shape.value_types??[shape.value_type]).includes(definition.datatype)))result={status:'UNBOUND',reason:!textField(definition.datatype)?'VALUE_DATATYPE_UNDECLARED':'VALUE_DATATYPE_UNVERIFIED'};}
    }
    if(result.reason)warnings.push(result.reason);
    return {shape_ref:shape.shape_ref,shape_signature:libraryShapeSignature(shape),kind:shape.kind,label:shape.label,subject_type:shape.subject_type,object_type:shape.object_type,subject_kind:shape.subject_kind??'ENTITY',owner_relation:clone(shape.owner_relation??null),unit:shape.unit??null,object_is_value:shape.object_is_value??shape.kind==='ATTRIBUTE',value_type:shape.value_type??null,value_types:clone(shape.value_types??[shape.value_type]),source_direction:shape.direction??'SUBJECT_TO_OBJECT',mapping_direction:direction,knowledge_refs:clone(shape.knowledge_refs),...result,warnings};
  });
}

export function reconcileLibraryDefinitions(definitions,shapes,existing=null){
  const prior=existing===null?definitions.flatMap(d=>array(d.alignment_classes)):existing;
  const classes=[...new Map([...prior,...definitions].filter(d=>d.kind==='CLASS').map(d=>[libraryNameKey(d.name),d])).values()];
  const classBasis=classes.filter(c=>c.status==='USABLE').map(c=>({kind:c.kind,name:c.name,key:c.key,status:c.status,observed_labels:clone(c.observed_labels??[]),parents:clone(c.parents??[]),definition_ref:c.definition_ref}));
  return definitions.map(d=>{
    const resolution=resolveLibraryDefinitionShapes(d,shapes),shapeBindings=libraryDefinitionBindings(d,shapes,classes),
      disposition=d.disposition??d.definition_disposition,
      adopted=disposition==='SEPARATE'||d.author==='HUMAN'&&d.review_action==='accept',
      formalPending=!adopted&&(d.requested_pending||d.semantic_conflict_confirmed===false&&!!d.existing_definition_refs?.length);
    const usable=d.kind==='CLASS'||shapeBindings.some(b=>b.status==='ALIGNED');
    const status=disposition==='EXCLUDED'||d.author==='HUMAN'&&['reject','exclude'].includes(d.review_action)?'REJECTED':
      disposition==='UNIFIED'?'UNIFIED':disposition==='DEFERRED'||formalPending||!usable||resolution.problems.length?'PENDING':'USABLE';
    return {...clone(d),status,shape_bindings:shapeBindings,alignment_warnings:unique([...shapeBindings.flatMap(b=>b.warnings),...resolution.problems.map(p=>p.code)]),
      ...(resolution.overlays.length?{binding_reconstruction:resolution.overlays}:{}),...(d.kind!=='CLASS'?{alignment_classes:classBasis}:{})};
  });
}

export function normalizeLibraryDefinition(proposal, shapes, existing=[]) {
  const refs=unique(array(proposal.shape_refs).filter(r=>shapes.some(s=>s.shape_ref===r))),matched=shapes.filter(s=>refs.includes(s.shape_ref));
  if(!matched.length)return {accepted:false,warning:'ONTOLOGY_DEFINITION_INCOMPLETE',retained:clone(proposal)};
  const kinds=unique(matched.map(s=>s.kind));
  if(kinds.length!==1)return {accepted:false,warning:'ONTOLOGY_SHAPE_KIND_CONFLICT',retained:clone(proposal)};
  if(textField(proposal.reuse_definition_ref)){
    const reused=existing.find(d=>d.definition_ref===proposal.reuse_definition_ref&&d.kind===kinds[0]&&d.status==='USABLE');
    if(!reused)return {accepted:false,warning:'ONTOLOGY_REUSE_REFERENCE_UNKNOWN',retained:clone(proposal)};
    const definition={...clone(reused),shape_refs:refs,mapping_direction:proposal.mapping_direction??'forward',requested_pending:proposal.status==='pending',observed_labels:unique(matched.map(s=>s.label)),examples:unique(matched.flatMap(s=>s.examples)).slice(0,6),knowledge_refs:unique(matched.flatMap(s=>s.knowledge_refs)),reused_definition_ref:reused.definition_ref,...(textField(proposal.reason)?{reuse_reason:proposal.reason}:{})};
    return {accepted:true,definition:reconcileLibraryDefinitions([definition],matched,existing)[0]};
  }
  if(!textField(proposal.name)||!textField(proposal.description))return {accepted:false,warning:'ONTOLOGY_DEFINITION_INCOMPLETE',retained:clone(proposal)};
  const kind=kinds[0],same=existing.filter(d=>d.kind===kind&&libraryNameKey(d.name)===libraryNameKey(proposal.name));
  const conflict=same.some(d=>textField(d.description)&&libraryNameKey(d.description)!==libraryNameKey(proposal.description));
  const requestedPending=proposal.status==='pending'||proposal.uncertain===true;
  let definition={kind,name:proposal.name.trim(),description:proposal.description.trim(),parents:array(proposal.parents).filter(textField),domains:array(proposal.domains).filter(textField),ranges:array(proposal.ranges).filter(textField),datatype:textField(proposal.datatype)?proposal.datatype:null,unit:textField(proposal.unit)?proposal.unit:null,mapping_direction:proposal.mapping_direction??'forward',requested_pending:conflict||requestedPending,shape_refs:refs,observed_labels:unique(matched.map(s=>s.label)),examples:unique(matched.flatMap(s=>s.examples)).slice(0,6),knowledge_refs:unique(matched.flatMap(s=>s.knowledge_refs)),question_refs:array(proposal.question_refs).filter(textField),status:conflict||requestedPending?'PENDING':'USABLE',...(textField(proposal.reason)?{reason:proposal.reason}:{}),...(conflict?{warning:'ONTOLOGY_POTENTIAL_EXISTING_DEFINITION_DIFFERENCE',existing_definition_refs:same.map(d=>d.definition_ref),semantic_conflict_confirmed:false}:{})};
  definition=reconcileLibraryDefinitions([definition],matched,existing)[0];
  definition.definition_ref='ontology_definition_'+hash(definition);
  return {accepted:true,definition};
}

/** Only the derived view is rewritten. Every original endpoint/domain is retained. */
export function prepareDefinitionUnification({revision,comparison,selectedDefinitionRef,knowledge=revision.knowledge}){
  const blocked=[],sides=Array.isArray(comparison?.sides)?comparison.sides:[],definitions=array(revision.ontology?.definitions);
  if(comparison?.binding_status!=='BOUND'||sides.length!==2)blocked.push('COMPARISON_NOT_BOUND');
  const target=definitions.find(d=>d.definition_ref===selectedDefinitionRef),source=sides.map(s=>definitions.find(d=>d.definition_ref===(s.definition_ref??s.object_ref))).find(d=>d&&d.definition_ref!==selectedDefinitionRef);
  if(!target||!source||!sides.some(s=>(s.definition_ref??s.object_ref)===selectedDefinitionRef))blocked.push('DEFINITION_TARGET_NOT_BOUND');
  for(const side of sides){const d=definitions.find(d=>d.definition_ref===(side.definition_ref??side.object_ref));
    if(!d||hash(d)!==(side.object_sha256??side.definition_sha256))blocked.push('DEFINITION_COMPARISON_STALE');}
  if(source&&target){
    if(source.kind!==target.kind)blocked.push('DEFINITION_KIND_MISMATCH');
    if(target.status!=='USABLE'||target.disposition==='EXCLUDED')blocked.push('TARGET_DEFINITION_NOT_USABLE');
    if((source.unit??null)!==(target.unit??null))blocked.push('DEFINITION_UNIT_MISMATCH');
    const shapes=collectLibraryOntologyShapes(knowledge,revision.identity),resolved=resolveLibraryDefinitionShapes(source,shapes);
    blocked.push(...resolved.problems.map(p=>p.code));
    if(!resolved.shapes.length)blocked.push('DEFINITION_SOURCE_SHAPE_MISSING');
    const selected={...clone(target),shape_refs:resolved.shapes.map(s=>s.shape_ref)};delete selected.shape_bindings;
    const bindings=libraryDefinitionBindings(selected,resolved.shapes,definitions);
    blocked.push(...bindings.filter(b=>b.status!=='ALIGNED').flatMap(b=>b.warnings));
    if(source.kind==='ATTRIBUTE')for(const row of knowledge.filter(k=>array(source.knowledge_refs).includes(k.knowledge_ref??k.record_ref))){
      const attrs=row.attributes;
      if(attrs&&typeof attrs==='object'&&!Array.isArray(attrs)&&Object.hasOwn(attrs,target.name)&&
        array(source.observed_labels).some(label=>label!==target.name&&Object.hasOwn(attrs,label)))blocked.push('ATTRIBUTE_MAPPING_VALUE_COLLISION');
      if(Array.isArray(attrs)&&attrs.some(a=>(a.name??a.attribute)===target.name)&&attrs.some(a=>array(source.observed_labels).includes(a.name??a.attribute)&&(a.name??a.attribute)!==target.name))blocked.push('ATTRIBUTE_MAPPING_VALUE_COLLISION');
    }
    if(!blocked.length)return {allowed:true,blocked_reason_codes:[],mapping:{policy:'LIBRARY_DEFINITION_MAPPING_V1',
      source_definition_ref:source.definition_ref,source_definition_sha256:hash(source),
      source_shape_signatures:resolved.shapes.map(libraryShapeSignature),knowledge_refs:clone(source.knowledge_refs??[]),
      target_definition_ref:target.definition_ref,target_definition_sha256:hash(target),mapping_direction:target.mapping_direction??'forward',status:'ACTIVE',action:'unify'}};
  }
  return {allowed:false,blocked_reason_codes:[...new Set(blocked)],mapping:null};
}

export function projectLibraryKnowledge(knowledge,{identity,definitions,revisionRef,definitionMappings=[]}) {
  const mapping=new Map(identity.mapping.map(m=>[m.local_entity_id,m.canonical_id])),entities=new Map(identity.entities.map(e=>[e.id,e]));
  const resolve=id=>mapping.get(id)??id;
  const shapes=collectLibraryOntologyShapes(knowledge,identity),checkedDefinitions=reconcileLibraryDefinitions(definitions,shapes);
  const definitionByRef=new Map(checkedDefinitions.map(d=>[d.definition_ref,d]));
  const activeMappings=array(definitionMappings).filter(m=>m.status==='ACTIVE'&&['unify','keep_separate'].includes(m.action));
  const mappedFor=(record,kind,label)=>{
    const recordRef=record.knowledge_ref??record.record_ref,matchedShapes=shapes.filter(s=>s.kind===kind&&s.label===label&&array(s.knowledge_refs).includes(recordRef));
    const scoped=activeMappings.filter(m=>array(m.knowledge_refs).includes(recordRef)&&definitions.some(d=>d.definition_ref===m.source_definition_ref&&d.kind===kind&&array(d.observed_labels).includes(label))),
      matches=scoped.filter(m=>matchedShapes.some(s=>array(m.source_shape_signatures).includes(libraryShapeSignature(s))));
    if(!matches.length)return scoped.length?{status:'UNBOUND',original_label:label,reason:'DEFINITION_MAPPING_SOURCE_CONTEXT_CHANGED',warnings:['DEFINITION_MAPPING_SOURCE_CONTEXT_CHANGED']}:null;
    if(matches.length!==1)return {status:'PENDING',original_label:label,reason:'DEFINITION_MAPPING_AMBIGUOUS',warnings:['DEFINITION_MAPPING_AMBIGUOUS']};
    const m=matches[0],source=definitions.find(d=>d.definition_ref===m.source_definition_ref),target=definitionByRef.get(m.target_definition_ref),originalTarget=definitions.find(d=>d.definition_ref===m.target_definition_ref);
    if(!source||!target||hash(source)!==m.source_definition_sha256||hash(originalTarget)!==m.target_definition_sha256||target.status!=='USABLE'||target.kind!==kind)
      return {status:'UNBOUND',original_label:label,reason:'DEFINITION_MAPPING_STALE',warnings:['DEFINITION_MAPPING_STALE']};
    const selected={...clone(target),shape_refs:matchedShapes.map(s=>s.shape_ref)};delete selected.shape_bindings;
    const bindings=libraryDefinitionBindings(selected,matchedShapes,checkedDefinitions);
    if(bindings.length!==1||bindings[0].status!=='ALIGNED')return {status:'UNBOUND',original_label:label,
      reason:bindings[0]?.reason??'DEFINITION_MAPPING_SCOPE_UNBOUND',warnings:bindings.flatMap(b=>b.warnings)};
    return {definition_ref:target.definition_ref,source_definition_ref:source.definition_ref,original_label:label,status:'ALIGNED',
      mapping_direction:m.mapping_direction??target.mapping_direction??'forward',name:target.name,review_event_ref:m.review_event_ref,
      definition_mapping_ref:m.mapping_ref??m.review_event_ref??null};
  };
  const classesFor=(entity,record)=>unique([...checkedDefinitions.filter(d=>d.status==='USABLE'&&d.kind==='CLASS'&&d.observed_labels?.some(label=>entity.observed_types.includes(label))),
    ...array(entity.observed_types).flatMap(label=>{const mapped=mappedFor(record,'CLASS',label);return mapped?.status==='ALIGNED'?[definitionByRef.get(mapped.definition_ref)]:[];}).filter(Boolean)]);
  const bindingFor=(definition,record,kind,label)=>array(definition.shape_bindings).find(b=>b.kind===kind&&b.label===label&&b.knowledge_refs.includes(record.knowledge_ref??record.record_ref));
  const candidates=(record,kind,label)=>checkedDefinitions.filter(d=>d.kind===kind&&d.observed_labels?.includes(label)&&d.knowledge_refs?.includes(record.knowledge_ref??record.record_ref)).map(definition=>({definition,binding:bindingFor(definition,record,kind,label)}));
  const alignment=(row,kind,label)=>{
    const mapped=mappedFor(row,kind,label);if(mapped)return mapped;
    const found=candidates(row,kind,label);if(!found.length)return null;
    if(found.length!==1)return {status:'PENDING',original_label:label,reason:'ONTOLOGY_ALIGNMENT_AMBIGUOUS',warnings:['ONTOLOGY_ALIGNMENT_AMBIGUOUS']};
    const {definition,binding}=found[0],allowed=definition.status==='USABLE'&&binding?.status==='ALIGNED';
    return {definition_ref:definition.definition_ref,original_label:label,status:allowed?'ALIGNED':binding?.status==='PENDING'?'PENDING':'UNBOUND',mapping_direction:binding?.mapping_direction??null,...(!allowed?{reason:binding?.reason??'ONTOLOGY_DEFINITION_PENDING',warnings:binding?.warnings?.length?binding.warnings:['ONTOLOGY_DEFINITION_PENDING']}:{name:definition.name})};
  };
  const orient=(subject,object,direction,mappingDirection)=>{const a=direction==='OBJECT_TO_SUBJECT'?object:subject,b=direction==='OBJECT_TO_SUBJECT'?subject:object;return mappingDirection==='reverse'?{subject:b,object:a}:{subject:a,object:b};};
  return knowledge.map(original=>{
    const row=clone(original),sourceDomain=clone(row.domain??null),sourceParticipants=clone(row.participants??[]);
    row.library_projection={policy:LIBRARY_KNOWLEDGE_POLICY,revision_ref:revisionRef,source_local_domain:sourceDomain,source_local_subject_ref:row.subject_ref??null,source_local_object_ref:row.object_ref??null,source_local_direction:row.direction??null,source_local_participants:sourceParticipants};
    if(row.subject_ref)row.subject_ref=resolve(row.subject_ref);if(row.object_ref)row.object_ref=resolve(row.object_ref);
    const projectEntity=e=>{const canonical=entities.get(resolve(e.id));if(!canonical)return clone(e);const classes=classesFor(canonical,original),specific=classes.filter(d=>!classes.some(other=>other!==d&&other.parents?.includes(d.name))),def=specific.length===1?specific[0]:null;return {...(isNativeActionKnowledge(original)?clone(e):{}),...clone(canonical),kind:e.kind??canonical.kind,entity_type:def?.name??(isNativeActionKnowledge(original)?e.entity_type??null:null),ontology_types:classes.map(d=>({name:d.name,definition_ref:d.definition_ref})),description:canonical.descriptions.join('\n')||e.description||null,source_local_entity_ids:canonical.local_entity_ids,...(def?{type_definition_ref:def.definition_ref}:{})};};
    if(row.domain){row.domain.entities=unique(array(row.domain.entities).map(projectEntity));
      if(row.domain.relation){row.domain.relation.subject=resolve(row.domain.relation.subject);row.domain.relation.object=resolve(row.domain.relation.object);}}
    if(row.domain?.relation){const originalLabel=row.domain.relation.predicate,found=alignment(original,'RELATION',originalLabel);if(found){row.relation_ontology_alignment=found;if(found.status==='ALIGNED'){const endpoints=orient(row.domain.relation.subject,row.domain.relation.object,row.domain.relation.direction??original.direction,found.mapping_direction);row.domain.relation={...row.domain.relation,...endpoints,predicate:found.name,direction:'SUBJECT_TO_OBJECT'};}else row.warnings=unique([...array(row.warnings),...array(found.warnings)]);}}
    row.participants=array(row.participants).map(p=>({...p,subject_ref:resolve(p.subject_ref)}));
    const kind=row.kind==='RELATION'?'RELATION':row.kind==='ATTRIBUTE'?'ATTRIBUTE':null,label=kind==='RELATION'?row.predicate:row.attribute;
    const found=kind?alignment(original,kind,label):null;
    if(found){row.ontology_alignment=found;if(found.status==='ALIGNED'){if(kind==='RELATION'){const endpoints=orient(row.subject_ref,row.object_ref,original.direction,found.mapping_direction);row.subject_ref=endpoints.subject;row.object_ref=endpoints.object;row.direction='SUBJECT_TO_OBJECT';row.predicate=found.name;}else row.attribute=found.name;}else row.warnings=unique([...array(row.warnings),...array(found.warnings)]);}
    if(row.attributes){const alignments=[];
      if(Array.isArray(row.attributes))row.attributes=row.attributes.map(attribute=>{const label=attribute.name??attribute.attribute,a=mappedFor(original,'ATTRIBUTE',label);if(!a)return attribute;alignments.push(a);return a.status==='ALIGNED'?{...attribute,...(Object.hasOwn(attribute,'name')?{name:a.name}:{attribute:a.name}),original_label:label}:attribute;});
      else row.attributes=Object.fromEntries(Object.entries(row.attributes).map(([label,value])=>{const a=mappedFor(original,'ATTRIBUTE',label);if(a)alignments.push(a);return [a?.status==='ALIGNED'?a.name:label,value];}));
      if(alignments.length)row.attribute_ontology_alignments=alignments;
    }
    return projectNativeActionIdentityReferences({row,original,resolve,projectEntity});
  });
}

export function assertLibrarySource(catalog,libraryId,snapshotId) {need(catalog.isCurrent(snapshotId,libraryId),'NATIVE_SOURCE_STALE');}
