/** Product commands resolve saved knowledge and human business changes; Rust owns temporal rules. */
import {canonical,clone,hash,need,textField} from './cq-discovery-store-v2.mjs';

const REQUEST='native_temporal_product_request_v2';
const ORIGIN='native_temporal_product_origin_v2';
const signed=body=>({...body,record_sha256:hash(body)});
const checked=(value,code)=>{const {record_sha256,...body}=value??{};need(value&&record_sha256===hash(body),code);return value;};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fields=(value,allowed,code)=>need(plain(value)&&Object.keys(value).every(key=>allowed.includes(key)),code);

// Structural mapping only. Missing offset/precision and invalid dates are interpreted exclusively by Rust.
function timePoint(endpoint) {
  if(!endpoint||endpoint.kind!=='KNOWN')return null;
  fields(endpoint,['kind','value','precision','timezone','time_text','basis'],'TEMPORAL_PRODUCT_TIME_FIELD_INVALID');
  const precision={SECOND:'EXACT',MILLISECOND:'EXACT',MINUTE:'MINUTE',DAY:'DAY',MONTH:'MONTH',YEAR:'YEAR'}[endpoint.precision];
  need(precision&&textField(endpoint.value),'TEMPORAL_PRODUCT_TIME_POINT_INVALID');
  // A separate offset is preserved as evidence, never silently attached to an unzoned value.
  if(endpoint.timezone!==undefined) {
    need(textField(endpoint.timezone),'TEMPORAL_PRODUCT_TIMEZONE_INVALID');
    const offset=/(Z|[+-]\d{2}:\d{2})$/.exec(endpoint.value)?.[1],zero=value=>['Z','+00:00','-00:00'].includes(value)?'Z':value;
    need(!offset||zero(offset)===zero(endpoint.timezone),'TEMPORAL_PRODUCT_TIMEZONE_CONFLICT');
  }
  return {value:endpoint.value,precision,raw:endpoint.time_text??endpoint.value,
    basis:endpoint.basis??(endpoint.timezone?'EXPLICIT_BUSINESS_TIME '+canonical({timezone:endpoint.timezone}):'EXPLICIT_BUSINESS_TIME')};
}
function worldTime(value,recordType=null,timeText=null) {
  if(value===null||value===undefined)return {kind:'UNKNOWN',raw:timeText===null?null:canonical(timeText),basis:'SAVED_TIME_NOT_RESOLVED'};
  fields(value,['kind','time_text','basis','gaps','occurred_at','valid_from','valid_to'],'TEMPORAL_PRODUCT_TIME_FIELD_INVALID');
  if(value.kind==='UNRESOLVED')return {kind:'UNKNOWN',raw:value.time_text??(timeText===null?null:canonical(timeText)),basis:value.basis??'BUSINESS_TIME_UNRESOLVED'};
  if(value.kind==='TIMELESS'){need(textField(value.basis),'TEMPORAL_PRODUCT_TIMELESS_BASIS_REQUIRED');return {kind:'TIMELESS',basis:value.basis};}
  if(value.kind==='INSTANT')return {kind:'EVENT',occurred_at:timePoint(value.occurred_at)??{value:null,precision:'UNKNOWN',raw:value.time_text??null,basis:'BUSINESS_TIME_UNKNOWN'}};
  need(value.kind==='INTERVAL','TEMPORAL_PRODUCT_TIME_KIND_INVALID');
  const start=timePoint(value.valid_from),end=timePoint(value.valid_to);
  if(['OBSERVATION','EVALUATION','ACTION_OCCURRENCE','ACTION_INTENT'].includes(recordType)&&start&&end)return {kind:'WINDOW',start,end};
  return {kind:'STATE',start,end:end?{kind:'EXACT',point:end}:value.valid_to?.kind==='OPEN_AS_REPORTED'?{kind:'OPEN_AS_REPORTED'}:{kind:'UNKNOWN'}};
}

function savedContent(row) {
  const action=row.native_action,business=action?.payload?.business;
  if(business&&plain(business)) {
    const node=row.domain?.entities?.find(item=>item.id===row.subject_ref);
    const subject=node?.resolved_subject_ref??row.subject_ref;
    need(textField(subject),'TEMPORAL_PRODUCT_SAVED_SUBJECT_REQUIRED');
    const predicate=business.property??business.label??action.record_type;
    need(textField(predicate),'TEMPORAL_PRODUCT_SAVED_PREDICATE_REQUIRED');
    return {subject_ref:subject,predicate,value:clone(Object.hasOwn(business,'value')?business.value:Object.hasOwn(business,'verdict')?business.verdict:business),
      conditions:{conditions:clone(row.conditions??[]),unit:business.unit??null,record_type:action.record_type,
        execution_claim:action.payload.execution_claim??null,participants:clone(row.participants??[])},
      negated:row.negation===true,modality:row.modality??action.modality??'ASSERTED'};
  }
  need(['ATTRIBUTE','RELATION'].includes(row.kind)&&textField(row.subject_ref),'TEMPORAL_PRODUCT_SAVED_STRUCTURE_UNSUPPORTED');
  const predicate=row.kind==='ATTRIBUTE'?row.attribute??row.predicate:row.predicate;
  need(textField(predicate)&&(row.kind!=='ATTRIBUTE'||Object.hasOwn(row,'raw_value'))
    &&(row.kind!=='RELATION'||textField(row.object_ref)),'TEMPORAL_PRODUCT_SAVED_STRUCTURE_UNSUPPORTED');
  return {subject_ref:row.subject_ref,predicate,value:clone(row.kind==='RELATION'?{object_ref:row.object_ref,direction:row.direction??'SUBJECT_TO_OBJECT'}:row.raw_value),
    conditions:{conditions:clone(row.conditions??null),unit:row.unit??null,attributes:clone(row.attributes??null),
      direction:row.direction??null,exceptions:clone(row.exceptions??null),comparison:clone(row.comparison??null),record_type:row.kind},
    negated:row.negation===true,modality:row.modality??'ASSERTED'};
}

export function createMemoryTemporalProduct({store,participant,coreForLibrary,catalog=null,assertLibrary=()=>{}}={}) {
  need(store?.db&&participant&&typeof coreForLibrary==='function','TEMPORAL_PRODUCT_HOST_REQUIRED');
  const immutable=(kind,id,value)=>{const old=store.getRecord(kind,id);need(!old||hash(old)===hash(value),'TEMPORAL_PRODUCT_IMMUTABLE_CONFLICT');if(!old)store.putRecord(kind,id,value);return value;};
  const principal=args=>{assertLibrary(args.library_id);need(args.principal?.channel==='BROWSER'&&textField(args.principal.principal_ref),'TEMPORAL_PRODUCT_BROWSER_REQUIRED');};
  function revision({library_id,revision_ref,run_id}) {
    let ref=revision_ref;
    if(!ref) {
      const active=store.getRecord('native_library_knowledge_active_v1',library_id);
      if(!run_id||active?.run_id===run_id)ref=active?.revision_ref;
      else ref=store.getRecord('native_library_knowledge_projection_v1',run_id)?.revision_ref;
      if(!ref&&run_id) {
        const matches=store.listRecords('native_library_knowledge_revision_v1').filter(row=>row.library_id===library_id&&row.run_id===run_id);
        need(matches.length===1,'TEMPORAL_PRODUCT_REVISION_SELECTION_REQUIRED');ref=matches[0].revision_ref;
      }
    }
    need(textField(ref),'TEMPORAL_PRODUCT_SAVED_REVISION_REQUIRED');
    const value=checked(store.getRecord('native_library_knowledge_revision_v1',ref),'TEMPORAL_PRODUCT_SAVED_REVISION_CHANGED');
    need(value.library_id===library_id&&(!run_id||value.run_id===run_id)&&Array.isArray(value.knowledge),'TEMPORAL_PRODUCT_SAVED_SCOPE_CHANGED');
    return value;
  }
  function snapshot(value) {
    const saved=store.getRecord('cq_v2_snapshot',value.source_snapshot_ref);
    need(saved?.library_id===value.library_id&&saved.snapshot_id===value.source_snapshot_ref,'TEMPORAL_PRODUCT_SOURCE_SNAPSHOT_REQUIRED');
    if(catalog)need(hash(catalog.get(value.source_snapshot_ref,value.library_id))===hash(saved),'TEMPORAL_PRODUCT_SOURCE_SNAPSHOT_CHANGED');
    return saved;
  }
  function sourceDescriptors(value,row) {
    const saved=snapshot(value),core=coreForLibrary(value.library_id),out=[];
    for(const source of row.source_refs??[]) {
      if(source.kind==='MEMORY_RECORD_SOURCE') {
        const raw=core.getRawRecord(source.record_ref);
        need(raw.library_id===value.library_id&&String(raw.version)===source.revision&&raw.source.kind===source.source_kind,'TEMPORAL_PRODUCT_RAW_SOURCE_CHANGED');
        const evidence=(row.evidence??[]).filter(item=>item.source_record_ref===source.record_ref);
        for(const item of evidence)need(item.revision===String(raw.version)&&(!item.quote||raw.text.includes(item.quote)),'TEMPORAL_PRODUCT_SAVED_QUOTE_CHANGED');
        out.push({kind:'RAW',raw,quote:evidence.find(item=>textField(item.quote))?.quote??null});
      } else {
        const doc=saved.documents?.find(item=>item.doc_id===source.doc_ref&&item.revision===source.revision);
        need(doc&&textField(doc.content),'TEMPORAL_PRODUCT_DOCUMENT_SOURCE_CHANGED');
        const evidence=(row.evidence??[]).filter(item=>item.doc_ref===source.doc_ref&&item.revision===source.revision);
        for(const item of evidence) {
          const spans=item.spans??[item];
          for(const span of spans)need(Number.isSafeInteger(span.start)&&Number.isSafeInteger(span.end)&&span.start>=0&&span.end>span.start
            &&doc.content.slice(span.start,span.end)===span.quote,'TEMPORAL_PRODUCT_SAVED_QUOTE_CHANGED');
        }
        out.push({kind:'DOCUMENT',doc,snapshot_ref:saved.snapshot_id,quote:evidence.flatMap(item=>item.spans??[item]).find(item=>textField(item.quote))?.quote??null});
      }
    }
    need(out.length>0,'TEMPORAL_PRODUCT_SAVED_SOURCE_REQUIRED');return out;
  }
  function resolveSaved(args) {
    const value=revision(args),row=value.knowledge.find(item=>(item.knowledge_ref??item.record_ref)===args.knowledge_ref||item.record_ref===args.knowledge_ref);
    need(row&&!row.temporal_fact,'TEMPORAL_PRODUCT_SAVED_KNOWLEDGE_NOT_FOUND');
    return {revision:value,row,content:savedContent(row),sources:sourceDescriptors(value,row)};
  }
  function listCandidates(args) {
    principal(args);const value=revision(args),items=[];
    for(const row of value.knowledge.filter(item=>!item.temporal_fact)) {
      let available=true,code=null,content=null;
      try{content=savedContent(row);sourceDescriptors(value,row);}catch(cause){available=false;code=cause.code??'TEMPORAL_PRODUCT_SAVED_UNAVAILABLE';}
      items.push({knowledge_ref:row.knowledge_ref??row.record_ref,record_ref:row.record_ref,kind:row.original_kind??row.kind,
        statement:row.statement??row.text,available,unavailable_code:code,content,valid_time:clone(row.valid_time??null),
        time_text:clone(row.time_text??null),source_refs:clone(row.source_refs??[]),semantic_lineage:clone(row.semantic_lineage??null),
        row_sha256:hash(row)});
    }
    return {schema_version:'MEMORY_TEMPORAL_CANDIDATES_V2',library_id:args.library_id,run_id:value.run_id,
      revision_ref:value.revision_ref,revision_sha256:value.record_sha256,source_snapshot_ref:value.source_snapshot_ref,items,
      saved_knowledge_count:items.length,execution:{model_called:false,source:'SAVED_KNOWLEDGE_REVISION'},gaps:['UNRESOLVED_SAVED_WORLD_TIME_REMAINS_UNKNOWN']};
  }
  function materializeSources(saved) {
    const core=coreForLibrary(saved.revision.library_id);
    return saved.sources.map(source=>{
      let raw=source.raw;
      if(source.kind==='DOCUMENT') {
        const doc=source.doc,receipt=core.saveRecord({text:doc.content,source:{kind:'DOCUMENT',external_ref:doc.doc_id,revision:doc.revision,
          label:doc.title??doc.doc_id,metadata:{input_kind:'EXACT_SAVED_DOCUMENT_MIRROR',source_snapshot_ref:source.snapshot_ref,
            doc_ref:doc.doc_id,document_revision:doc.revision,content_sha256:hash(doc.content),parser:clone(doc.parser??null)}}},
          {idempotency_key:'temporal-document:'+hash([saved.revision.library_id,source.snapshot_ref,doc.doc_id,doc.revision])});
        raw=core.getRawRecord(receipt.record_ref);
      }
      return {source_version_id:raw.record_ref,role:'SUPPORT',kind:raw.source.kind==='DOCUMENT'?'DOCUMENT':'OBSERVATION',quote:source.quote};
    });
  }
  function humanSource(args,kernelId,kind='HUMAN_REVISION') {
    need(textField(args.text)&&args.text.length<=100000&&textField(args.reason)&&args.reason.length<=4000,'TEMPORAL_PRODUCT_HUMAN_BASIS_REQUIRED');
    const receipt=coreForLibrary(args.library_id).saveRecord({text:args.text,source:{kind:'HUMAN_TEXT',metadata:{input_kind:'EXPLICIT_TEMPORAL_BUSINESS_CHANGE',
      reporter:args.principal.principal_ref,product_request_id:args.request_id,operation:args.operation,reason:args.reason}}},
      {idempotency_key:'temporal-human:'+kernelId});
    return {source_version_id:receipt.record_ref,role:'SUPPORT',kind,quote:args.text};
  }
  function target(args) {
    need(textField(args.fact_ref),'TEMPORAL_PRODUCT_FACT_REQUIRED');
    const matches=participant.snapshot({library_id:args.library_id}).versions.filter(row=>row.fact_id===args.fact_ref||row.fact_version_id===args.fact_ref);
    need(matches.length===1,'TEMPORAL_PRODUCT_CURRENT_FACT_NOT_FOUND');return matches[0];
  }
  async function publishChange(args) {
    principal(args);need(textField(args.request_id)&&/^[A-Za-z0-9_:\-]{1,128}$/.test(args.request_id),'TEMPORAL_PRODUCT_REQUEST_REQUIRED');
    const {principal:actor,...businessArgs}=args,requestKey=canonical([args.library_id,actor.principal_ref,args.request_id]);
    const digest=hash(businessArgs),prior=store.getRecord(REQUEST,requestKey);
    if(prior){checked(prior,'TEMPORAL_PRODUCT_REQUEST_CHANGED');need(prior.request_sha256===digest,'TEMPORAL_PRODUCT_IDEMPOTENCY_CONFLICT');
      return result(args,await participant.publishChangeSet(prior.kernel_args),prior.origin);}
    const kernelId='temporal_product_'+hash(requestKey);let updates,origin=null;
    if(args.operation==='ADOPT_SAVED') {
      need(textField(args.knowledge_ref),'TEMPORAL_PRODUCT_KNOWLEDGE_REQUIRED');
      const saved=resolveSaved(args),content=saved.content,sources=materializeSources(saved);
      if(Object.hasOwn(args,'value')){need(textField(args.text)&&textField(args.reason),'TEMPORAL_PRODUCT_HUMAN_BASIS_REQUIRED');content.value=clone(args.value);}
      if(args.conditions!==undefined){need(Array.isArray(args.conditions)||plain(args.conditions),'TEMPORAL_PRODUCT_CONDITIONS_INVALID');content.conditions.conditions=clone(args.conditions);}
      const overridden=args.valid_time!==undefined||Object.hasOwn(args,'value')||args.conditions!==undefined;
      if(overridden)for(const source of sources)source.role='BACKGROUND';
      if(overridden||args.single_valued===true)sources.push(humanSource(args,kernelId));
      const validTime=worldTime(args.valid_time??saved.row.valid_time,saved.row.native_action?.record_type,saved.row.time_text??null);
      need(args.single_valued===undefined||typeof args.single_valued==='boolean','TEMPORAL_PRODUCT_SINGLE_VALUE_INVALID');
      if(args.single_valued===true)need(validTime.kind==='STATE'&&textField(args.text)&&textField(args.reason),'TEMPORAL_PRODUCT_SINGLE_VALUE_BASIS_REQUIRED');
      const stateGroup=args.single_valued?{key:'product_state_'+hash([content.subject_ref,content.predicate,content.conditions]),single_valued:true}:null;
      origin={revision_ref:saved.revision.revision_ref,revision_sha256:saved.revision.record_sha256,run_id:saved.revision.run_id,
        knowledge_ref:saved.row.knowledge_ref??saved.row.record_ref,row_sha256:hash(saved.row),source_snapshot_ref:saved.revision.source_snapshot_ref,
        original_source_refs:clone(saved.row.source_refs),original_evidence:clone(saved.row.evidence??[]),original_semantic_lineage:clone(saved.row.semantic_lineage??null)};
      updates=[{kind:'ADD_FACT',assertion:{content,valid_time:validTime,state_group:stateGroup,sources},reason:args.reason??'Explicit adoption of saved knowledge'}];
    } else {
      const current=target(args),source=humanSource(args,kernelId,args.operation==='ADD_SUPPORT'?'OBSERVATION':'HUMAN_REVISION');
      if(args.operation==='WITHDRAW')updates=[{kind:'WITHDRAW',target_version_id:current.fact_version_id,basis:source,reason:args.reason}];
      else if(args.operation==='ADD_SUPPORT')updates=[{kind:'ADD_SUPPORT',target_version_id:current.fact_version_id,source,reason:args.reason}];
      else {
        need(['STATE_CHANGE','CORRECT'].includes(args.operation),'TEMPORAL_PRODUCT_OPERATION_INVALID');
        need(Object.hasOwn(args,'value')||args.valid_time!==undefined||args.conditions!==undefined||args.single_valued!==undefined,'TEMPORAL_PRODUCT_EXPLICIT_BUSINESS_CHANGE_REQUIRED');
        const content={...clone(current.content),...(Object.hasOwn(args,'value')?{value:clone(args.value)}:{})};
        if(args.conditions!==undefined){need(Array.isArray(args.conditions)||plain(args.conditions),'TEMPORAL_PRODUCT_CONDITIONS_INVALID');content.conditions.conditions=clone(args.conditions);}
        need(args.single_valued===undefined||typeof args.single_valued==='boolean','TEMPORAL_PRODUCT_SINGLE_VALUE_INVALID');
        let stateGroup=clone(current.state_group);
        if(args.single_valued!==undefined||args.conditions!==undefined&&stateGroup)stateGroup=(args.single_valued??stateGroup?.single_valued)?
          {key:'product_state_'+hash([content.subject_ref,content.predicate,content.conditions]),single_valued:true}:null;
        const assertion={content,valid_time:args.valid_time===undefined?clone(current.asserted_valid_time):worldTime(args.valid_time),state_group:stateGroup,sources:[source]};
        if(args.operation==='STATE_CHANGE') {
          need(current.state_group?.single_valued===true&&assertion.state_group?.single_valued===true&&assertion.valid_time.kind==='STATE'&&args.valid_time!==undefined,'TEMPORAL_PRODUCT_STATE_AUTHORITY_REQUIRED');
          updates=[{kind:'STATE_CHANGE',assertion,authority:'USER_DECISION',reason:args.reason}];
        } else updates=[{kind:'CORRECT',target_version_id:current.fact_version_id,assertion,reason:args.reason}];
      }
    }
    const kernelArgs={library_id:args.library_id,request_id:kernelId,updates};
    // Plan validation precedes product request persistence. It performs one Rust batch and never enqueues extraction.
    participant.prepareChangeSet(kernelArgs);
    const request=signed({library_id:args.library_id,request_id:args.request_id,principal_ref:actor.principal_ref,request_sha256:digest,kernel_args:kernelArgs,origin});
    immutable(REQUEST,requestKey,request);
    if(origin)immutable(ORIGIN,kernelId,signed({library_id:args.library_id,kernel_request_id:kernelId,origin}));
    return result(args,await participant.publishChangeSet(kernelArgs),origin);
  }
  function result(args,receipt,origin) {
    const prepared=store.getRecord('native_temporal_fact_prepared_v2',canonical([args.library_id,receipt.processing_ref]));
    const indexPlan=prepared&&store.getRecord('native_temporal_index_plan_v2',prepared.frame.projection_ref);
    const embedding=indexPlan?{index_plan_ref:indexPlan.projection_ref,capability:indexPlan.capability??'LEXICAL',
      embedding_space_sha256:indexPlan.embedding_space_sha256??null,saved_plan_usage:clone(indexPlan.embedding_usage??[])}:null;
    return {schema_version:'MEMORY_TEMPORAL_CHANGE_V2',library_id:args.library_id,request_id:args.request_id,operation:args.operation,
      publication:receipt,origin:clone(origin),facts:receipt.state==='CONFIRMED'?participant.readFacts({library_id:args.library_id}):null,
      execution:{generation_model_called:false,answer_model_called:false,embedding,extraction_enqueued:false,
        source:args.operation==='ADOPT_SAVED'?'SAVED_KNOWLEDGE_REUSE':'EXPLICIT_HUMAN_BUSINESS_CHANGE'}};
  }
  function readFacts(args) {
    principal(args);return {...participant.readFacts({library_id:args.library_id,at:args.at??null,as_of:args.as_of??null,view_ref:args.view_ref??null}),
      schema_version:'MEMORY_TEMPORAL_QUERY_V2',execution:{model_called:false,extraction_enqueued:false}};
  }
  return Object.freeze({listCandidates,publishChange,readFacts});
}
