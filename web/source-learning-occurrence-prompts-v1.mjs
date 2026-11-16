/** Versioned mention-location schema/template only. Rust owns occurrence choice,
 * UTF16 anchors, candidate materialization and every semantic admission rule. */
import{createHash}from'node:crypto';
import{createSourceLearningPrompts}from'./source-learning-prompts-v1.mjs';
const clone=structuredClone;
const sort=v=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;
const sha=text=>createHash('sha256').update(text).digest('hex');
const objectSha=value=>sha(JSON.stringify(sort(value)));
const need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
export const OCCURRENCE_PROMPT_VERSION='lightog-source-learning-occurrence-prompts/0.1';
export function createSourceLearningOccurrencePrompts({core,requireOccurrence=false,localResolution=false}){
 const protocolVersion=localResolution?'lightog-source-learning-local-occurrence-prompts/0.1':requireOccurrence?'lightog-source-learning-required-occurrence-prompts/0.1':OCCURRENCE_PROMPT_VERSION;
 const legacy=createSourceLearningPrompts({core});
 function prepare(base,prepared,options){
  const selected=core('support_selection',localResolution?'prepare_local_required_occurrence_v1':requireOccurrence?'prepare_required_occurrence_v1':'prepare_occurrence_v1',{prepared,trusted_context:options.trustedContext});
  need(selected.contract_version==='lightog-support-selection/0.2'&&selected.registry_entity_schema?.properties?.mention_occurrence&&Array.isArray(selected.occurrence_instructions)&&selected.occurrence_instructions.every(x=>typeof x==='string'),'SOURCE_OCCURRENCE_RUST_SCHEMA_REQUIRED');
  if(requireOccurrence)need(selected.proposal_contract_version===(localResolution?'lightog-required-mention-occurrence/0.2':'lightog-required-mention-occurrence/0.1')&&selected.registry_entity_schema.required.includes('mention_occurrence'),'SOURCE_REQUIRED_OCCURRENCE_RUST_CONTRACT_REQUIRED');
  const schema=clone(base.output_schema);schema.$defs.RegistryEntity=clone(selected.registry_entity_schema);
  const user=JSON.parse(base.messages[1].content);user.output_schema=schema;
  user.explicit_support_protocol.contract_version=selected.contract_version;
  user.mention_occurrence_protocol={protocol_version:protocolVersion,support_selection_version:selected.contract_version,prepared_payload_sha256:selected.prepared_payload_sha256,registry_entity_schema_sha256:objectSha(selected.registry_entity_schema),instructions:clone(selected.occurrence_instructions)};
  const oldSentence='It must occur exactly once inside that menu fragment.';
  need(base.messages[0].content.split(oldSentence).length===2,'SOURCE_OCCURRENCE_LEGACY_LOCATION_INSTRUCTION_CHANGED');
  // Replace exactly the old location-only sentence. In particular, "one fact has
  // exactly one explicit subject", polarity, conditions and support rules remain.
  const system=base.messages[0].content.replace(oldSentence,selected.occurrence_instructions.join(' '));
  const messages=[{role:'system',content:system},{role:'user',content:JSON.stringify(user)}];
  const {metadata_sha256:oldDigest,...metadata}=base.metadata;
  const next={...metadata,mention_occurrence_protocol:protocolVersion,support_selection_version:selected.contract_version,registry_entity_schema_sha256:objectSha(selected.registry_entity_schema),occurrence_instructions_sha256:objectSha(selected.occurrence_instructions),schema_sha256:objectSha(schema),messages_sha256:objectSha(messages),prompt_sha256:sha(system),base_metadata_sha256:oldDigest,materializer_binding:{...metadata.materializer_binding,support_selection_operation:localResolution?'materialize_local_required_occurrence_v1':requireOccurrence?'materialize_required_occurrence_v1':'materialize_occurrence_v1',support_selection_version:selected.contract_version}};
  next.metadata_sha256=objectSha(next);
  return {...base,output_schema:schema,schema,messages,metadata:next,mention_occurrence_protocol:protocolVersion};
 }
 return Object.freeze({
  prepareExplicitSeedCall(prepared,options={}){return prepare(legacy.prepareExplicitSeedCall(prepared,options),prepared,options);},
  prepareExplicitGapCall(prepared,options={}){return prepare(legacy.prepareExplicitGapCall(prepared,options),prepared,options);},
  // Eligibility, support roles and independent-review wording are unchanged.
  prepareExplicitReview:legacy.prepareExplicitReview,
 });
}
