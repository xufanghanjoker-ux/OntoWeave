/** Optional semantic time clues and lineage only. No date parsing, assignment or document-time authority. */
import {clone,hash,need,textField} from './cq-discovery-store-v2.mjs';

export const SEMANTIC_TEMPORAL_HINTS_CONTRACT='SEMANTIC_TEMPORAL_HINTS_V1';
export const SEMANTIC_TEMPORAL_HINT_RECORD='native_semantic_temporal_hint_sidecar_v1';
const SCOPES=new Set(['STATEMENT','SENTENCE','TABLE_ROW','TABLE_COLUMN','SECTION','DOCUMENT','AMBIGUOUS']);
const ROLES=new Set(['PUBLICATION','EFFECTIVE','OBSERVATION','FISCAL_PERIOD','TIMEZONE','UNRESOLVED']);
const array=value=>Array.isArray(value)?value:[];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const unique=rows=>[...new Map(rows.map(row=>[row===undefined?'undefined':hash(row),row])).values()];
const strings=rows=>[...new Set(rows.filter(textField))];
const checked=value=>{const {record_sha256,...body}=value??{};
  need(record_sha256===hash(body),'SEMANTIC_TEMPORAL_SIDECAR_CHANGED');return value;};
const contextFor=item=>({semantic_ref:item.semantic_ref,statement:item.text,
  ...Object.fromEntries(['participants','values','conditions','exceptions','negation','modality','uncertainties','observation_identity','reporter']
    .filter(key=>item[key]!==undefined).map(key=>[key,clone(item[key])]))});

/** Caller supplies an already-authorized package; a content digest is not execution/source authorization. */
export function createSemanticTemporalHintSidecar({semanticPackage:p,proposals=[]}){
  checked(p);need(textField(p.package_ref)&&Array.isArray(p.items)&&Array.isArray(p.source_refs),
    'SEMANTIC_TEMPORAL_PACKAGE_INVALID');
  const byRef=new Map(p.items.map(item=>[item.semantic_ref,item])),rawHints=[],retained=[],warnings=[];
  const collect=(value,origin,defaults=[])=>{
    if(value===undefined)return;
    if(!Array.isArray(value)){retained.push({raw:clone(value),origin,reason:'TEMPORAL_HINTS_NOT_ARRAY'});return;}
    for(const [index,raw]of value.entries())rawHints.push({raw:clone(raw),origin:{...origin,index},defaults});
  };
  collect(p.temporal_hints,{kind:'PACKAGE'});
  for(const item of p.items){
    collect(item.temporal_hints,{kind:'STATEMENT',semantic_ref:item.semantic_ref},[item.semantic_ref]);
    // Older explicit time words are usable without rewriting their saved package or inventing missing clues.
    if(item.temporal_hints===undefined&&textField(item.time_text))collect([{time_text:item.time_text,statement:item.text,
      quote:item.quote,scope:'STATEMENT',context_role:'UNRESOLVED'}],{kind:'LEGACY_STATEMENT_TIME_TEXT',semantic_ref:item.semantic_ref},[item.semantic_ref]);
  }
  for(const proposal of proposals){
    const pin=array(p.proposals).find(row=>row.proposal_ref===proposal.proposal_ref);
    need(pin&&pin.raw_sha256===proposal.raw_sha256&&proposal.raw_sha256===hash(proposal.raw),
      'SEMANTIC_TEMPORAL_PROPOSAL_CHANGED');
    const own=p.items.filter(item=>item.proposal_ref===proposal.proposal_ref).map(item=>item.semantic_ref);
    collect(proposal.raw?.temporal_hints,{kind:'PROPOSAL',proposal_ref:proposal.proposal_ref},own.length===1?own:[]);
  }
  const grouped=new Map();
  for(const entry of rawHints){
    const {raw,origin,defaults}=entry;
    if(!object(raw)){retained.push({raw,origin,reason:'TEMPORAL_HINT_NOT_OBJECT'});continue;}
    const local=[],given=array(raw.semantic_refs),requested=strings([...defaults,...given]),
      exact=textField(raw.statement)?p.items.filter(item=>item.text===raw.statement).map(item=>item.semantic_ref):[];
    let refs=requested.filter(ref=>byRef.has(ref));
    if(!refs.length&&!requested.length)refs=exact;
    if(!requested.length&&exact.length>1)local.push('TEMPORAL_HINT_STATEMENT_MATCH_AMBIGUOUS');
    const unresolved=given.filter(ref=>!textField(ref)||!byRef.has(ref));
    if(unresolved.length)local.push('TEMPORAL_HINT_SEMANTIC_REFERENCE_UNRESOLVED');
    const statement=textField(raw.statement)?raw.statement:refs.length===1?byRef.get(refs[0]).text:null,
      time_text=textField(raw.time_text)?raw.time_text:null,quote=textField(raw.quote)?raw.quote:null,
      scope=SCOPES.has(raw.scope)?raw.scope:raw.scope===undefined?'STATEMENT':'AMBIGUOUS',
      context_role=ROLES.has(raw.context_role)?raw.context_role:'UNRESOLVED';
    if(!time_text)local.push('TEMPORAL_HINT_TIME_TEXT_MISSING');
    if(!refs.length&&scope!=='DOCUMENT')local.push('TEMPORAL_HINT_STATEMENT_SCOPE_UNRESOLVED');
    if(raw.scope!==undefined&&!SCOPES.has(raw.scope))local.push('TEMPORAL_HINT_SCOPE_UNRESOLVED');
    if(raw.context_role!==undefined&&!ROLES.has(raw.context_role))local.push('TEMPORAL_HINT_CONTEXT_ROLE_UNRESOLVED');
    if(raw.semantic_refs!==undefined&&!Array.isArray(raw.semantic_refs))local.push('TEMPORAL_HINT_SEMANTIC_REFERENCE_UNRESOLVED');
    if(quote)local.push('TEMPORAL_HINT_QUOTE_RECORDED_WITHOUT_PRECISE_LOCATION');
    if(raw.source_refs!==undefined&&(!Array.isArray(raw.source_refs)
      ||raw.source_refs.some(source=>source===undefined||!p.source_refs.some(bound=>hash(bound)===hash(source)))))
      local.push('TEMPORAL_HINT_MODEL_SOURCE_REFERENCE_NOT_ADOPTED');
    if(['id','hint_ref','start','end','offset','offsets','revision','version','record_sha256'].some(key=>Object.hasOwn(raw,key)))
      local.push('TEMPORAL_HINT_MODEL_SYSTEM_FIELD_NOT_ADOPTED');
    const business={time_text,statement,scope,quote,context_role,source_refs:clone(p.source_refs)},key=hash(business),old=grouped.get(key);
    if(old){old.semantic_refs=strings([...old.semantic_refs,...refs]);old.unresolved_semantic_refs=unique([...old.unresolved_semantic_refs,...unresolved]);
      old.warnings=strings([...old.warnings,...local]);old.origins.push({...origin,raw:clone(raw)});}
    else grouped.set(key,{...business,hint_ref:'semantic_temporal_hint_'+hash([p.package_ref,p.record_sha256,business]),
      semantic_refs:refs,unresolved_semantic_refs:unresolved,quote_status:quote?'RECORDED_UNLOCATED':'NOT_PROVIDED',warnings:local,
      origins:[{...origin,raw:clone(raw)}]});
  }
  const hints=[...grouped.values()].map(hint=>({...hint,statement_contexts:hint.semantic_refs.map(ref=>contextFor(byRef.get(ref)))})),
    missing=p.items.filter(item=>!hints.some(hint=>hint.semantic_refs.includes(item.semantic_ref))).map(item=>item.semantic_ref);
  if(missing.length)warnings.push('SEMANTIC_TEMPORAL_HINTS_NOT_PROVIDED_FOR_SOME_STATEMENTS');
  if(retained.length)warnings.push('SEMANTIC_TEMPORAL_HINT_RAW_RETAINED');
  const body={schema:SEMANTIC_TEMPORAL_HINTS_CONTRACT,builder_revision:'semantic-temporal-hints-v1@20261114-1',
    sidecar_ref:'semantic_temporal_sidecar_'+hash([p.package_ref,p.record_sha256,'semantic-temporal-hints-v1@20261114-1']),
    package_ref:p.package_ref,package_record_sha256:p.record_sha256,window_ref:p.window_ref??null,window_sha256:p.window_sha256??null,
    source_snapshot_ref:p.source_snapshot_ref??null,source_fingerprint:p.source_fingerprint??null,source_refs:clone(p.source_refs),
    hints,retained_hints:retained,missing_semantic_refs:missing,warnings,
    time_resolution:'NOT_PERFORMED',time_assignment:'NOT_PERFORMED',source_authorization:'CALLER_MUST_VALIDATE_ORIGINAL_PACKAGE'};
  return {...body,record_sha256:hash(body)};
}

/** Follow existing S→K references. Merges/splits retain candidates; they never assign one date to every K. */
export function linkSemanticTemporalHintsToKnowledge({sidecars,knowledge}){
  need(Array.isArray(sidecars)&&Array.isArray(knowledge),'SEMANTIC_TEMPORAL_LINEAGE_INPUT_INVALID');
  sidecars.forEach(checked);
  const links=[],allHints=unique(sidecars.flatMap(sidecar=>sidecar.hints)),warnings=[],byHint=new Map(allHints.map(h=>[h.hint_ref,[]]));
  for(const row of knowledge){
    const knowledge_ref=row.record_ref??row.knowledge_ref,lineage=row.semantic_lineage??{},refs=array(lineage.semantic_refs),
      packages=unique([...array(lineage.package_refs).map(pin=>({package_ref:pin.package_ref,sha256:pin.sha256??pin.record_sha256??null})),
        ...(textField(lineage.package_ref)?[{package_ref:lineage.package_ref,sha256:null}]:[])]);
    const matched=sidecars.filter(sidecar=>packages.some(pin=>pin.package_ref===sidecar.package_ref
      &&(!pin.sha256||pin.sha256===sidecar.package_record_sha256)));
    const knownRefs=new Set(matched.flatMap(sidecar=>[...array(sidecar.missing_semantic_refs),...sidecar.hints.flatMap(h=>h.semantic_refs)])),
      unresolved=unique([...array(lineage.unresolved_refs),...refs.filter(ref=>!knownRefs.has(ref))]);
    const associations=[];
    for(const sidecar of matched)for(const hint of sidecar.hints){
      const applicable=hint.semantic_refs.filter(ref=>refs.includes(ref));if(!applicable.length)continue;
      associations.push({sidecar_ref:sidecar.sidecar_ref,hint_ref:hint.hint_ref,package_ref:sidecar.package_ref,
        semantic_refs:applicable,statement_contexts:hint.statement_contexts.filter(item=>applicable.includes(item.semantic_ref))});
      if(textField(knowledge_ref))byHint.get(hint.hint_ref).push(knowledge_ref);
    }
    const local=[];
    if(!textField(knowledge_ref))local.push('TEMPORAL_KNOWLEDGE_REFERENCE_MISSING');
    if(!associations.length)local.push('TEMPORAL_KNOWLEDGE_HINT_MISSING');
    if(unresolved.length)local.push('TEMPORAL_KNOWLEDGE_SEMANTIC_REFERENCE_UNAVAILABLE');
    if(refs.length>1&&associations.length)local.push('MERGED_SEMANTIC_TIME_SCOPE_REQUIRES_INTERPRETATION');
    if(packages.some(pin=>!pin.sha256&&sidecars.filter(sidecar=>sidecar.package_ref===pin.package_ref).length>1))
      local.push('TEMPORAL_SEMANTIC_PACKAGE_VERSION_AMBIGUOUS');
    links.push({knowledge_ref:knowledge_ref??null,associations,unresolved_semantic_refs:unresolved,warnings:local,time_assignment:'NOT_PERFORMED'});
  }
  const hint_links=allHints.map(hint=>({hint_ref:hint.hint_ref,knowledge_refs:strings(byHint.get(hint.hint_ref)),
    warnings:strings(byHint.get(hint.hint_ref)).length>1?['SPLIT_SEMANTIC_TIME_SCOPE_REQUIRES_INTERPRETATION']:[]}));
  for(const row of links)if(row.associations.some(a=>hint_links.find(link=>link.hint_ref===a.hint_ref).knowledge_refs.length>1))
    row.warnings.push('SPLIT_SEMANTIC_TIME_SCOPE_REQUIRES_INTERPRETATION');
  const document_context_candidates=allHints.filter(hint=>hint.scope==='DOCUMENT'||['PUBLICATION','EFFECTIVE','OBSERVATION','FISCAL_PERIOD','TIMEZONE'].includes(hint.context_role))
    .map(hint=>({hint_ref:hint.hint_ref,time_text:hint.time_text,statement:hint.statement,scope:hint.scope,quote:hint.quote,
      context_role:hint.context_role,source_refs:clone(hint.source_refs),semantic_refs:clone(hint.semantic_refs),warnings:clone(hint.warnings)}));
  if(links.some(row=>row.warnings.length))warnings.push('SEMANTIC_TEMPORAL_LINEAGE_HAS_LOCAL_UNRESOLVED_SCOPE');
  const body={schema:'SEMANTIC_TEMPORAL_HINT_LINKS_V1',sidecar_refs:sidecars.map(s=>({sidecar_ref:s.sidecar_ref,record_sha256:s.record_sha256})),
    knowledge_links:links,hint_links,document_context_candidates,
    unlinked_hint_refs:hint_links.filter(link=>!link.knowledge_refs.length).map(link=>link.hint_ref),warnings,time_assignment:'NOT_PERFORMED'};
  return {...body,record_sha256:hash(body)};
}
