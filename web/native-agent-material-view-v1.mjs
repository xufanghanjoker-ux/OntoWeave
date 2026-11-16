/** Model-only material views. Canonical Host sources, receipts and schemas stay intact. */
import {clone,need,textField} from './cq-discovery-store-v2.mjs';
import {NATIVE_BUILD_TOOL_NAMES as N} from './native-build-host-v1.mjs';

const VERSION='native-agent-material-read/1',OFFSET='utf16_code_unit';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value,key)=>Object.hasOwn(value,key);
const spanKeys=new Set(['unit_ref','parent_unit_ref','doc_ref','revision','block_id','start','end','offset_unit','role','provenance']);
const segmentKeys=new Set(['input_start','input_end','source_span_index','unit_ref','role']);

/** The caller supplies a canonical, already-authorized read result. This pure
 * projection does not authenticate a receipt or grant semantic authority. */
export function projectNativeMaterialRead(result){
  const original=()=>clone(result);
  if(!object(result)||!textField(result.read_receipt_ref)||!Array.isArray(result.units)||!result.units.length||
    result.accepted===false||result.ok===false||result.offset_unit!==OFFSET)return original();
  if(own(result,'agent_material_view'))return original();
  const docRef=result.doc_ref??result.source_ref?.doc_ref,revision=result.revision??result.source_ref?.revision;
  if(!textField(docRef)||!textField(revision)||
    result.source_ref&&(result.source_ref.doc_ref!==docRef||result.source_ref.revision!==revision)||
    own(result,'window_ref')&&!textField(result.window_ref))return original();
  const identities=new Set();
  for(const unit of result.units){
    if(!object(unit)||typeof unit.text!=='string'||!unit.text.isWellFormed()||
      !Number.isSafeInteger(unit.start)||!Number.isSafeInteger(unit.end)||unit.start<0||unit.end<=unit.start||unit.end-unit.start!==unit.text.length||
      own(unit,'doc_ref')&&unit.doc_ref!==docRef||own(unit,'revision')&&unit.revision!==revision||
      own(unit,'offset_unit')&&unit.offset_unit!==OFFSET||own(unit,'unit_ref')&&!textField(unit.unit_ref)||
      !textField(unit.unit_ref)&&!textField(unit.block_id))return original();
    const identity=unit.unit_ref??JSON.stringify([unit.block_id,unit.start,unit.end]);
    if(identities.has(identity))return original();identities.add(identity);
  }
  if(own(result,'text')&&(typeof result.text!=='string'||
    result.text!==result.units.map(unit=>unit.text).join('\n\n')&&result.text!==result.units.map(unit=>unit.text).join('')))return original();
  const roles=[];
  if(own(result,'source_spans')){
    if(!Array.isArray(result.source_spans)||result.source_spans.length!==result.units.length)return original();
    for(const [index,span] of result.source_spans.entries()){
      const unit=result.units[index];
      if(!object(span)||Object.keys(span).some(key=>!spanKeys.has(key))||span.doc_ref!==docRef||span.revision!==revision||
        span.start!==unit.start||span.end!==unit.end||span.offset_unit!==OFFSET||
        own(span,'unit_ref')&&!textField(unit.unit_ref)||own(span,'block_id')&&!textField(unit.block_id)||
        textField(unit.unit_ref)&&span.unit_ref!==unit.unit_ref||textField(unit.block_id)&&span.block_id!==unit.block_id||
        (own(span,'parent_unit_ref')||own(unit,'parent_unit_ref'))&&span.parent_unit_ref!==unit.parent_unit_ref||
        own(span,'role')&&!['CORE','CONTEXT'].includes(span.role)||
        own(unit,'window_role')&&unit.window_role!==span.role)return original();
      roles[index]=span.role;
    }
  }
  if(own(result,'input_segments')){
    if(!Array.isArray(result.input_segments)||result.input_segments.length!==result.units.length||typeof result.text!=='string'||!Array.isArray(result.source_spans))return original();
    for(const [index,segment] of result.input_segments.entries()){
      const unit=result.units[index];
      if(!object(segment)||Object.keys(segment).some(key=>!segmentKeys.has(key))||
        segment.source_span_index!==index||segment.unit_ref!==unit.unit_ref||segment.role!==roles[index]||
        !Number.isSafeInteger(segment.input_start)||!Number.isSafeInteger(segment.input_end)||segment.input_start<0||segment.input_end<=segment.input_start||
        result.text.slice(segment.input_start,segment.input_end)!==unit.text)return original();
    }
  }
  const view=original();
  delete view.text;delete view.source_spans;delete view.input_segments;
  view.units=result.units.map((unit,index)=>{
    const value=clone(unit);delete value.provenance;
    if(roles[index]!==undefined)value.window_role=roles[index];
    return value;
  });
  view.agent_material_view={version:VERSION,text_location:'units[].text',
    canonical_lookup:{read_receipt_ref:result.read_receipt_ref,...(result.window_ref?{window_ref:result.window_ref}:{})},
    provenance_note:'完整provenance、source_spans、input_segments仍保存在Host原记录，按上述窗口/读取回执及unit_ref或block_id关联查回；本视图不授予额外权限或事实资格。',
    completeness_note:'保留本页全部单元和分页状态；Host返回完整不等于模型接收完整，仍以实际原生请求为准。'};
  return view;
}

/** Smaller submissions are per call, never a cap on the accumulated fact set.
 * REVIEW keeps the canonical full review input, result and completion policy. */
export function createNativeBuildAgentTools({build,role,maxCandidatesPerBatch=16,inputSourceRefs=[]}){
  need(build&&typeof build.definitions==='function'&&typeof build.call==='function'&&typeof build.snapshot==='function','NATIVE_AGENT_BUILD_PORT_INVALID');
  need(['EXTRACTION','REVIEW'].includes(role),'NATIVE_AGENT_BUILD_ROLE_INVALID');
  need(Number.isSafeInteger(maxCandidatesPerBatch)&&maxCandidatesPerBatch>0,'NATIVE_AGENT_BATCH_LIMIT_INVALID');
  const definitions=clone(build.definitions(role));
  if(role==='EXTRACTION'&&build.snapshot().knowledge_build_policy==='EXTRACT_AND_INDEX_V1')return {
    definitions,
    async call(name,args={},context){const bound=inputSourceRefs.length?{...context,source_refs:clone(inputSourceRefs)}:context;const result=await build.call(role,name,args,bound);return result?.ok===true?{...clone(result),result:projectNativeMaterialRead(result.result)}:clone(result);},
    isComplete:()=>build.snapshot().extraction_complete===true
  };
  let maxCandidates=maxCandidatesPerBatch,maxStatements=32;
  if(role==='EXTRACTION'){
    const submit=definitions.find(tool=>tool.name===N.SUBMIT),properties=submit?.inputSchema?.properties;
    need(properties?.candidates?.type==='array'&&properties?.source_statements?.type==='array','NATIVE_AGENT_SUBMIT_SCHEMA_INVALID');
    maxCandidates=Math.min(16,maxCandidatesPerBatch,properties.candidates.maxItems??maxCandidatesPerBatch);
    maxStatements=Math.min(32,properties.source_statements.maxItems??32);
    properties.candidates.maxItems=maxCandidates;properties.source_statements.maxItems=maxStatements;
    submit.description=(submit.description??'')+' 每批最多'+maxCandidates+'条候选和'+maxStatements+'条原话；按批提交，不同批次使用不同idempotency_key。超限完整批次返回NEEDS_BATCH_SPLIT，整批未保存且不截断；Agent保留各数组原顺序显式分批，每批等待保存回执，用返回的新revision提交下一批，不并行提交。不同批使用新的幂等键，不复用被拒整批的键。不限制已保存候选总数；所有批次完成后单独调用结束工具。';
  }
  return {definitions,async call(name,args={},context){
    if(role==='EXTRACTION'&&name===N.SUBMIT&&
      (Array.isArray(args?.candidates)&&args.candidates.length>maxCandidates||Array.isArray(args?.source_statements)&&args.source_statements.length>maxStatements)){
      if(typeof build.validateExtractionBatch!=='function')return {ok:false,error:{code:'NATIVE_AGENT_BATCH_VALIDATION_PORT_REQUIRED'}};
      const checked=await build.validateExtractionBatch(args);
      if(checked?.ok!==true)return clone(checked);
      if(checked.result?.validated!==true||checked.result.already_saved!==false)return {ok:false,error:{code:'NATIVE_EXTRACTION_IDEMPOTENCY_CONFLICT'}};
      return {ok:true,result:{accepted:false,status:'NEEDS_BATCH_SPLIT',code:'NATIVE_AGENT_EXTRACTION_BATCH_LIMIT',batch_saved:false,idempotency_key_used:false,
        max_candidates_per_batch:maxCandidates,max_source_statements_per_batch:maxStatements,received_candidates:args.candidates.length,received_source_statements:args.source_statements.length,
        minimum_batches:Math.max(Math.ceil(args.candidates.length/maxCandidates),Math.ceil(args.source_statements.length/maxStatements)),
        current_extraction_revision:checked.result.current_extraction_revision,truncated:false,automatically_split:false,host_write_performed:false,semantic_support_certified:false,
        next_action:'保留原候选和原话，各数组按原顺序显式分成不超过上述上限的批次，保留每项原字段和引用。每批使用新的唯一idempotency_key，不复用本次被拒整批的键；第一批用current_extraction_revision，等保存回执后再用其revision提交下一批，不能并行或沿用旧revision。原话无需复制到每批；全部批次确认保存后再单独结束抽取。Host未替你拆分、补字段或保存任何项。'}};
    }
    const canonical=await build.call(role,name,args,context);
    if(role==='REVIEW'||canonical?.ok!==true)return clone(canonical);
    return {...clone(canonical),result:projectNativeMaterialRead(canonical.result)};
  },isComplete(){
    const state=build.snapshot();
    return role==='EXTRACTION'?state.extraction_complete===true:state.review_complete===true||state.adoption_pending_confirmation===true;
  }};
}
