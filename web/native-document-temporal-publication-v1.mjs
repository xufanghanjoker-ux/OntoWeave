import {createNativeSimplifiedTemporalPublication} from './native-simplified-temporal-publication-v1.mjs';
/** Saved document build -> semantic temporal proposals -> Rust plan -> sole SQLite publication coordinator. */
import {canonical,clone,hash,need,textField} from './cq-discovery-store-v2.mjs';
import {runNativeDocumentTemporalInterpretation} from './native-document-temporal-agent-v1.mjs';
import {readDomainAttributes} from './native-domain-knowledge-v1.mjs';
import {createSemanticTemporalHintSidecar,linkSemanticTemporalHintsToKnowledge} from './native-semantic-temporal-hints-v1.mjs';

export const DOCUMENT_TEMPORAL_POLICY='DOCUMENT_BITEMPORAL_PUBLICATION_V1';
const RESULT='native_document_temporal_publication_v1',ORIGIN='native_document_temporal_origin_v1';
const signed=body=>({...body,record_sha256:hash(body)});
const checked=(value,code)=>{const {record_sha256,...body}=value??{};need(value&&record_sha256===hash(body),code);return value;};
const list=value=>Array.isArray(value)?value:[];
const same=(a,b)=>hash(a)===hash(b);
const unique=rows=>[...new Map(rows.map(row=>[hash(row),row])).values()];
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
function contentFor(row) {
  need(['ATTRIBUTE','RELATION'].includes(row.kind)&&textField(row.subject_ref),'DOCUMENT_TEMPORAL_STRUCTURE_UNRESOLVED');
  const predicate=row.kind==='ATTRIBUTE'?row.attribute??row.predicate:row.predicate;
  need(textField(predicate)&&(row.kind==='ATTRIBUTE'?Object.hasOwn(row,'raw_value'):textField(row.object_ref)),'DOCUMENT_TEMPORAL_STRUCTURE_UNRESOLVED');
  return {subject_ref:row.subject_ref,predicate,value:clone(row.kind==='ATTRIBUTE'?row.raw_value:{object_ref:row.object_ref,direction:row.direction??'SUBJECT_TO_OBJECT'}),
    conditions:{conditions:clone(row.conditions??[]),unit:row.unit??null,direction:row.direction??null,exceptions:clone(row.exceptions??null),
      comparison:clone(row.comparison??null),record_type:row.kind,...(row.kind==='RELATION'&&(row.relation_value||row.attributes)?{relation_annotations:{policy:'EXPLICIT_RELATION_METADATA_V1',attributes:clone(row.attributes??null),companion_value:clone(row.relation_value??null)}}:{})},negated:row.negation===true,modality:row.modality??'ASSERTED'};
}
function endpoint(point,hints,path) {
  if(!point||point.kind!=='KNOWN')return null;
  need(plain(point)&&Object.keys(point).every(key=>['kind','value','precision','timezone','basis','time_text'].includes(key)),'DOCUMENT_TEMPORAL_TIME_FIELDS_INVALID');
  const precision={SECOND:'EXACT',MILLISECOND:'EXACT',MINUTE:'MINUTE',DAY:'DAY',MONTH:'MONTH',YEAR:'YEAR'}[point.precision];
  need(precision&&textField(point.value),'DOCUMENT_TEMPORAL_TIME_POINT_INVALID');
  if(point.timezone!==undefined){need(textField(point.timezone),'DOCUMENT_TEMPORAL_TIME_POINT_INVALID');hints.push({time_index:0,point:path,timezone:point.timezone});}
  return {value:point.value,precision,raw:point.time_text??point.value,basis:point.basis??'SOURCE_TEMPORAL_INTERPRETATION'};
}
function worldTime(value,row,reason,hints) {
  if(!value||value.kind==='UNRESOLVED')return {kind:'UNKNOWN',raw:value?.time_text??(row.time_text?canonical(row.time_text):null),basis:reason};
  need(plain(value)&&Object.keys(value).every(key=>['kind','time_text','basis','gaps','occurred_at','valid_from','valid_to'].includes(key)),'DOCUMENT_TEMPORAL_TIME_FIELDS_INVALID');
  if(value.kind==='TIMELESS'){need(textField(value.basis),'DOCUMENT_TEMPORAL_TIMELESS_BASIS_REQUIRED');return {kind:'TIMELESS',basis:value.basis};}
  if(value.kind==='INSTANT')return {kind:'EVENT',occurred_at:endpoint(value.occurred_at,hints,'OCCURRED_AT')??{value:null,precision:'UNKNOWN',raw:value.time_text??null,basis:reason}};
  need(value.kind==='INTERVAL','DOCUMENT_TEMPORAL_TIME_KIND_INVALID');
  const start=endpoint(value.valid_from,hints,'START'),end=endpoint(value.valid_to,hints,'END'),event=row.domain?.entities?.some(item=>item.id===row.subject_ref&&item.kind==='EVENT');
  if(event&&start&&end)return {kind:'WINDOW',start,end};
  need(!event,'DOCUMENT_TEMPORAL_EVENT_INTERVAL_UNRESOLVED');
  return {kind:'STATE',start,end:end?{kind:'EXACT',point:end}:value.valid_to?.kind==='OPEN_AS_REPORTED'?{kind:'OPEN_AS_REPORTED'}:{kind:'UNKNOWN'}};
}
const timeMeaning=value=>{if(Array.isArray(value))return value.map(timeMeaning);if(!plain(value))return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!['raw','basis'].includes(key)).map(([key,item])=>[key,timeMeaning(item)]));};

export function createNativeDocumentTemporalPublication({store,resolveParticipant,interpret=runNativeDocumentTemporalInterpretation}={}) {
  need(store?.db&&typeof resolveParticipant==='function'&&typeof interpret==='function','DOCUMENT_TEMPORAL_HOST_REQUIRED');
  const immutable=(kind,key,value)=>{const old=store.getRecord(kind,key);need(!old||same(old,value),'DOCUMENT_TEMPORAL_IMMUTABLE_CONFLICT');if(!old)store.putRecord(kind,key,value);return value;};
  function mirror(participant,libraryId,source,doc) {
    const key=canonical([libraryId,doc.doc_id,doc.revision]),old=store.getRecord('native_document_temporal_source_v1',key),core=participant.rawCoreForLibrary(libraryId);
    if(old){checked(old,'DOCUMENT_TEMPORAL_SOURCE_BINDING_CHANGED');const raw=core.getRawRecord(old.record_ref);need(raw.text===doc.content&&hash(raw.source)===old.source_sha256,'DOCUMENT_TEMPORAL_SOURCE_BINDING_CHANGED');return raw;}
    const saved=core.saveRecord({text:doc.content,source:{kind:'DOCUMENT',external_ref:doc.doc_id,revision:doc.revision,label:doc.title??doc.doc_id,
      metadata:{input_kind:'EXACT_DOCUMENT_BUILD_SOURCE',first_source_snapshot_ref:source.snapshot_id,doc_ref:doc.doc_id,document_revision:doc.revision,
        content_sha256:hash(doc.content),parser:clone(doc.parser??null)}}},{idempotency_key:'document-temporal:'+hash(key)});
    const raw=core.getRawRecord(saved.record_ref);
    immutable('native_document_temporal_source_v1',key,signed({library_id:libraryId,doc_ref:doc.doc_id,revision:doc.revision,record_ref:raw.record_ref,
      content_sha256:hash(doc.content),source_sha256:hash(raw.source)}));return raw;
  }
  async function publishBuild(args) {
    const {libraryId,runId,snapshotId,source,libraryRevision,parentRun,semanticPackages=[],cqInput,families}=args;
    need(store.db.isTransaction===false,'DOCUMENT_TEMPORAL_REQUIRES_OUTSIDE_TRANSACTION');
    const participant=resolveParticipant();need(participant?.prepareChangeSet&&participant?.registerSourceCorrectionBasis,'DOCUMENT_TEMPORAL_PARTICIPANT_NOT_READY');
    const revision=checked(store.getRecord('native_library_knowledge_revision_v1',libraryRevision?.revision_ref),'DOCUMENT_TEMPORAL_LIBRARY_REVISION_CHANGED');
    need(same(revision,libraryRevision)&&revision.library_id===libraryId&&revision.run_id===runId&&revision.source_snapshot_ref===snapshotId,'DOCUMENT_TEMPORAL_BUILD_BINDING_CHANGED');
    const savedSource=store.getRecord('cq_v2_snapshot',snapshotId);
    need(savedSource?.library_id===libraryId&&same(savedSource,source),'DOCUMENT_TEMPORAL_SOURCE_SNAPSHOT_CHANGED');
    for(const pkg of semanticPackages)need(pkg.library_id===libraryId&&pkg.source_snapshot_ref===snapshotId
      &&same(store.getRecord('native_semantic_package_v1',pkg.package_ref),pkg),'DOCUMENT_TEMPORAL_SEMANTIC_PACKAGE_CHANGED');
    const inputSha=hash({libraryId,runId,snapshotId,source_sha256:hash(source),library_revision_sha256:revision.record_sha256,
      semantic_packages:semanticPackages.map(pkg=>({ref:pkg.package_ref,sha256:hash(pkg)})),cq_sha256:hash(cqInput),families_sha256:hash(families),capability:args.capability,embedding_space:args.embeddingSpace??null});
    const prior=store.getRecord(RESULT,runId);
    if(prior){checked(prior,'DOCUMENT_TEMPORAL_PUBLICATION_CHANGED');need(prior.input_sha256===inputSha,'DOCUMENT_TEMPORAL_BUILD_REPLAY_CHANGED');
      need(prior.status==='CONFIRMED','DOCUMENT_TEMPORAL_NO_AUTOMATIC_RETRY');return clone(prior.result);}
    parentRun.assertOpen();
    const base=participant.snapshot({library_id:libraryId}),documents=[],evidence=[],byDoc=new Map(),warnings=[],origins=[],incoming=[],seen=new Set();
    for(const [index,doc]of list(source.documents).entries()) {
      const raw=mirror(participant,libraryId,source,doc),ref='D'+(index+1);byDoc.set(canonical([doc.doc_id,doc.revision]),{doc,raw,ref});
      documents.push({ref,title:doc.title,doc_ref:doc.doc_id,revision:doc.revision,content:doc.content,parser:clone(doc.parser??null)});
      for(const block of list(doc.blocks))if(Number.isSafeInteger(block.start)&&Number.isSafeInteger(block.end)&&block.start>=0&&block.end>block.start&&block.end<=doc.content.length)
        evidence.push({ref:'E'+(evidence.length+1),document_ref:ref,source_version_id:raw.record_ref,doc_ref:doc.doc_id,revision:doc.revision,
          start:block.start,end:block.end,quote:doc.content.slice(block.start,block.end)});
    }
    for(const original of list(revision.knowledge)) {
      const projections=original.kind==='ENTITY'&&original.attributes?readDomainAttributes(original.attributes)
        .map(item=>({...original,kind:'ATTRIBUTE',attribute:item.name,raw_value:clone(item.value),unit:item.unit??original.unit??null,
          ...Object.fromEntries(['conditions','negation','modality','time_text','valid_time','exceptions','comparison','source_refs'].filter(key=>Object.hasOwn(item,key)).map(key=>[key,clone(item[key])]))})): [original];
      if(!projections.length)warnings.push({knowledge_ref:original.knowledge_ref??original.record_ref,code:'DOCUMENT_TEMPORAL_STRUCTURE_UNRESOLVED'});
      for(const row of projections)try {
        const content=contentFor(row),sources=[];
        for(const sourceRef of list(row.source_refs)) {
          const entry=byDoc.get(canonical([sourceRef.doc_ref,sourceRef.revision]));need(entry,'DOCUMENT_TEMPORAL_DOCUMENT_BINDING_REQUIRED');
          const selected=list(row.evidence).filter(item=>item.doc_ref===sourceRef.doc_ref&&item.revision===sourceRef.revision).flatMap(item=>item.spans??[item]);
          for(const span of selected)need(textField(span.quote)&&Number.isSafeInteger(span.start)&&Number.isSafeInteger(span.end)
            &&span.start>=0&&span.end>span.start&&entry.doc.content.slice(span.start,span.end)===span.quote,'DOCUMENT_TEMPORAL_QUOTE_CHANGED');
          const quote=selected[0]?.quote??null;
          if(quote&&!evidence.some(item=>item.source_version_id===entry.raw.record_ref&&item.quote===quote))evidence.push({ref:'E'+(evidence.length+1),document_ref:entry.ref,
            source_version_id:entry.raw.record_ref,doc_ref:entry.doc.doc_id,revision:entry.doc.revision,start:selected[0].start,end:selected[0].end,quote});
          sources.push({source_version_id:entry.raw.record_ref,role:'SUPPORT',kind:'DOCUMENT',quote});
        }
        need(sources.length>0,'DOCUMENT_TEMPORAL_SOURCE_REQUIRED');
        const signature=hash({content,sources,source_time:row.valid_time??row.time_text??null});
        if(store.getRecord(ORIGIN,canonical([libraryId,signature]))||seen.has(signature))continue;seen.add(signature);
        const ref='K'+(incoming.length+1);incoming.push({ref,content,knowledge:clone(row),sources:unique(sources),signature,
          evidence_refs:evidence.filter(item=>sources.some(s=>s.source_version_id===item.source_version_id)).map(item=>item.ref)});
      } catch(cause){warnings.push({knowledge_ref:original.knowledge_ref??original.record_ref,code:cause.code??'DOCUMENT_TEMPORAL_KNOWLEDGE_UNRESOLVED'});}
    }
    const current=base.versions.map((fact,index)=>({ref:'F'+(index+1),fact:clone(fact),source_records:fact.sources.map(s=>{
      const raw=participant.rawCoreForLibrary(libraryId).getRawRecord(s.source_version_id);return {source_version_id:raw.record_ref,source:clone(raw.source),quote:s.quote};})}));
    // Existing ontology definitions do not imply cardinality; expose only an actual explicit saved constraint.
    const constraints=list(revision.ontology?.definitions).filter(d=>d.status==='USABLE'&&d.single_valued===true&&textField(d.definition_ref)).map((d,index)=>({ref:'C'+(index+1),definition:clone(d)}));
    const semantics=semanticPackages.map((pkg,index)=>{
      let sidecar=null;
      try {sidecar=createSemanticTemporalHintSidecar({semanticPackage:pkg,proposals:list(pkg.proposals)
        .map(pin=>store.getRecord('native_semantic_proposal_v1',pin.proposal_ref)).filter(Boolean)});}
      catch(cause){warnings.push({package_ref:pkg.package_ref,code:cause.code??'DOCUMENT_TEMPORAL_HINT_SIDECAR_UNRESOLVED'});}
      return {ref:'P'+(index+1),package:clone(pkg),...(sidecar?{temporal_hints:sidecar.hints,temporal_hint_sidecar:sidecar}:{})};
    });
    const temporalHintLinks=linkSemanticTemporalHintsToKnowledge({sidecars:semantics.map(p=>p.temporal_hint_sidecar).filter(Boolean),
      knowledge:incoming.map(k=>({...k.knowledge,record_ref:k.ref,knowledge_ref:k.ref}))});
    const input={incoming,current,semantics,documents,evidence,constraints,temporal_hint_links:temporalHintLinks};
    immutable('native_document_temporal_binding_v1',runId,signed({library_id:libraryId,run_id:runId,snapshot_id:snapshotId,input,input_sha256:hash(input),
      base_head:base.head,library_revision_sha256:revision.record_sha256,cq_sha256:hash(cqInput),families_sha256:hash(families)}));
    let interpretation;
    if(incoming.length)interpretation=await interpret({store,parentRun,libraryId,runId,snapshotId,input,agentRunner:args.agentRunner,upstream:args.upstream,
      runtimeDirectory:args.runtimeDirectory,onInvocation:args.onInvocation});
    else interpretation={interpretations:[],warnings:[],partial:false};
    const updates=[];let unresolved=0,temporalParsed=0;const accepted=[],corrected=new Set();
    for(const proposal of list(interpretation.interpretations)) {
      const item=incoming.find(row=>row.ref===proposal.knowledge_ref);
      try {
        need(item&&textField(proposal.reason),'DOCUMENT_TEMPORAL_INTERPRETATION_INVALID');
        if(proposal.operation==='UNRESOLVED'){unresolved++;warnings.push({knowledge_ref:item.ref,code:'DOCUMENT_TEMPORAL_SEMANTICS_UNRESOLVED',reason:proposal.reason});continue;}
        const target=current.find(row=>row.ref===proposal.target_ref)?.fact,authority=proposal.authority??{kind:'NONE',evidence_refs:[]};
        const cited=list(authority.evidence_refs).map(ref=>evidence.find(row=>row.ref===ref));
        need(cited.every(Boolean),'DOCUMENT_TEMPORAL_AUTHORITY_EVIDENCE_CHANGED');
        const timezoneHints=[],valid=worldTime(proposal.valid_time,item.knowledge,proposal.reason,timezoneHints);
        const normalization=participant.normalizeTimes({library_id:libraryId,times:[valid],timezone_hints:timezoneHints}),normalized=normalization.times[0];
        warnings.push(...list(normalization.warnings).map(w=>({...w,knowledge_ref:item.ref,stage:'NORMALIZE_TIME'})));
        const group=normalized.kind==='STATE'?{key:'document_state_'+hash([item.content.subject_ref,item.content.predicate,item.content.conditions,item.signature]),single_valued:false}:null;
        const assertion={content:clone(item.content),valid_time:normalized,state_group:group,sources:clone(item.sources)};
        if(cited.length){assertion.sources=assertion.sources.filter(s=>cited.some(e=>e.source_version_id===s.source_version_id))
          .map(s=>({...s,quote:cited.find(e=>e.source_version_id===s.source_version_id).quote}));need(assertion.sources.length>0,'DOCUMENT_TEMPORAL_CONTENT_EVIDENCE_REQUIRED');}
        let update;
        if(proposal.operation==='ADD_FACT')update={kind:'ADD_FACT',assertion,reason:proposal.reason};
        else {
          need(target,'DOCUMENT_TEMPORAL_TARGET_UNRESOLVED');
          const sameSubject=target.content.subject_ref===item.content.subject_ref&&target.content.predicate===item.content.predicate;
          need(sameSubject,'DOCUMENT_TEMPORAL_TARGET_IDENTITY_UNRESOLVED');
          if(proposal.operation==='STATE_CHANGE') {
            need(normalized.kind==='STATE'&&target.asserted_valid_time.kind==='STATE'&&same(target.content.conditions,item.content.conditions),'DOCUMENT_TEMPORAL_STATE_SCOPE_UNRESOLVED');
            need(target.state_group,'DOCUMENT_TEMPORAL_STATE_GROUP_CHANGED');assertion.state_group=clone(target.state_group);
            let succession;
            if(authority.kind==='SOURCE_EXPLICIT_CHANGE'){need(cited.length>0&&cited.every(e=>item.sources.some(s=>s.source_version_id===e.source_version_id)),'DOCUMENT_TEMPORAL_CHANGE_EVIDENCE_REQUIRED');succession='EXPLICIT_HANDOVER';}
            else {const constraint=constraints.find(row=>row.ref===authority.constraint_ref);need(authority.kind==='ONTOLOGY_SINGLE_VALUE'&&constraint,'DOCUMENT_TEMPORAL_SINGLE_VALUE_AUTHORITY_REQUIRED');
              need(constraint.definition.name===item.content.predicate,'DOCUMENT_TEMPORAL_SINGLE_VALUE_SCOPE_CHANGED');assertion.state_group.single_valued=true;succession='ONTOLOGY_SINGLE_VALUE';}
            update={kind:'STATE_CHANGE',assertion,authority:succession,reason:proposal.reason};
          } else if(proposal.operation==='CORRECT') {
            need(authority.kind==='SOURCE_EXPLICIT_CORRECTION'&&cited.length>0,'DOCUMENT_TEMPORAL_CORRECTION_AUTHORITY_REQUIRED');
            need(!corrected.has(target.fact_version_id),'DOCUMENT_TEMPORAL_DUPLICATE_CORRECTION_UNRESOLVED');
            if(assertion.valid_time.kind==='STATE'&&target.state_group&&same(target.content.conditions,item.content.conditions))assertion.state_group=clone(target.state_group);
            const previousSourceIds=new Set([...target.sources,...base.support_links.filter(link=>link.fact_version_id===target.fact_version_id).map(link=>link.source)].map(s=>s.source_version_id));
            const correctionSources=assertion.sources.filter(s=>!previousSourceIds.has(s.source_version_id)&&cited.some(e=>e.source_version_id===s.source_version_id));
            need(correctionSources.length>0,'DOCUMENT_TEMPORAL_NEW_CORRECTION_SOURCE_REQUIRED');
            for(const source of correctionSources) {
              const quote=cited.find(e=>e.source_version_id===source.source_version_id)?.quote;
              need(quote,'DOCUMENT_TEMPORAL_NEW_CORRECTION_SOURCE_REQUIRED');
              participant.registerSourceCorrectionBasis({library_id:libraryId,source_version_id:source.source_version_id,target_version_id:target.fact_version_id,
                interpretation_ref:interpretation.stage_ref,interpretation_sha256:interpretation.record_sha256,quote});
              source.kind='SOURCE_REVISION';
            }
            const newIds=new Set(correctionSources.map(s=>s.source_version_id));
            assertion.sources=[...correctionSources,...item.sources.filter(s=>!newIds.has(s.source_version_id)).map(s=>({...s,role:'BACKGROUND'}))];
            corrected.add(target.fact_version_id);
            update={kind:'CORRECT',target_version_id:target.fact_version_id,assertion,reason:proposal.reason};
          } else {
            need(proposal.operation==='ADD_SUPPORT'&&same(target.content,item.content)&&same(timeMeaning(target.asserted_valid_time),timeMeaning(normalized)),
              'DOCUMENT_TEMPORAL_SUPPORT_IDENTITY_UNRESOLVED');
            need(!['OBSERVATION','EVALUATION'].includes(item.knowledge.native_action?.record_type),'DOCUMENT_TEMPORAL_OBSERVATION_IDENTITY_REQUIRED');
            for(const source of assertion.sources)updates.push({kind:'ADD_SUPPORT',target_version_id:target.fact_version_id,source,reason:proposal.reason});
          }
        }
        if(update)updates.push(update);accepted.push(item);
        const known=p=>p&&['EXACT','MINUTE','DAY'].includes(p.precision)&&textField(p.value);
        const incomplete=list(normalization.warnings).some(w=>['TIMEZONE_OR_MINUTE_UNRESOLVED','TIME_COARSE_OR_UNKNOWN','TIME_UNKNOWN',
          'TIME_INVALID','TIMEZONE_UNKNOWN','TIMEZONE_CONFLICT','TIMEZONE_UNSUPPORTED'].includes(w.code));
        if(!incomplete&&(normalized.kind==='TIMELESS'||normalized.kind==='EVENT'&&known(normalized.occurred_at)
          ||normalized.kind==='STATE'&&known(normalized.start)&&(normalized.end.kind==='OPEN_AS_REPORTED'||normalized.end.kind==='EXACT'&&known(normalized.end.point))
          ||normalized.kind==='WINDOW'&&known(normalized.start)&&known(normalized.end)))temporalParsed++;
        origins.push({signature:item.signature,knowledge_ref:item.knowledge.knowledge_ref??item.knowledge.record_ref,operation:proposal.operation});
      } catch(cause){unresolved++;warnings.push({knowledge_ref:item?.ref??proposal.knowledge_ref,code:cause.code??'DOCUMENT_TEMPORAL_LOCAL_UNRESOLVED',reason:proposal.reason??null});}
    }
    warnings.push(...list(interpretation.warnings));
    const requestId='document_temporal_'+hash([libraryId,runId,inputSha]);
    const request={library_id:libraryId,request_id:requestId,expected_head:base.head,updates,projection_context:{run_id:runId,source_snapshot_ref:snapshotId,
      library_revision_ref:revision.revision_ref,library_revision_sha256:revision.record_sha256,capability:args.capability,embedding_space:args.embeddingSpace??null}};
    immutable(RESULT,runId,signed({library_id:libraryId,run_id:runId,status:'PREPARED',input_sha256:inputSha,request,warnings,origins}));
    try {
      const plan=participant.prepareChangeSet(request);
      warnings.push(...list(plan.kernel_plan?.warnings??plan.warnings).map(w=>({...w,stage:'PREPARE_CHANGE_SET'})));
      const staged=await participant.stagePrepared({...request,plan,view_runtime:{embed:args.embed,embeddingSpace:args.embeddingSpace??null}});
      const publication=staged.receipt.state==='CONFIRMED'?staged.receipt:await participant.confirmPrepared(request);
      need(publication.state==='CONFIRMED','DOCUMENT_TEMPORAL_PUBLICATION_UNCONFIRMED');
      const view=participant.readFacts({library_id:libraryId,as_of:{activation_seq:publication.fact_activation.activation_seq}});
      need(view.status==='READY'&&view.view_bindings.run_id===runId&&view.view_bindings.source_snapshot_ref===snapshotId,'DOCUMENT_TEMPORAL_READBACK_UNCONFIRMED');
      const result={confirmed:true,publication,readback:{verified:true,temporal_view_ref:view.view_ref,activation:publication.fact_activation,bindings:view.view_bindings},
        partial:unresolved>0||warnings.length>0||interpretation.partial===true,warnings,
        summary:{incoming:incoming.length,accepted:accepted.length,saved:accepted.length,temporal_parsed:temporalParsed,
          at_qualified_supported:null,at_qualified_support_status:'NOT_EVALUATED_REQUIRES_QUERY_AT',unresolved,skipped_unsupported:warnings.filter(w=>w.code==='DOCUMENT_TEMPORAL_STRUCTURE_UNRESOLVED').length,
          updates:updates.length,automatic_activation:true,system_time_source:'ACTUAL_COMMITTED_ACTIVATION'},index_scope:{run_id:runId,source_snapshot_ref:snapshotId}};
      for(const origin of origins)immutable(ORIGIN,canonical([libraryId,origin.signature]),signed({library_id:libraryId,source_run_id:runId,
        source_snapshot_ref:snapshotId,...origin,activation:publication.fact_activation}));
      store.putRecord(RESULT,runId,signed({library_id:libraryId,run_id:runId,status:'CONFIRMED',input_sha256:inputSha,request,result}));return result;
    } catch(cause){store.putRecord(RESULT,runId,signed({library_id:libraryId,run_id:runId,status:'FAILED',input_sha256:inputSha,request,warnings,
      error_code:cause.code??'DOCUMENT_TEMPORAL_PUBLICATION_FAILED',retained_build_revision_ref:revision.revision_ref}));throw cause;}
  }
  return Object.freeze({policy:DOCUMENT_TEMPORAL_POLICY,publishBuild,simplified:createNativeSimplifiedTemporalPublication({store,resolveParticipant})});
}

export {contentFor as nativeDocumentTemporalContentFor,worldTime as nativeDocumentTemporalWorldTime};
