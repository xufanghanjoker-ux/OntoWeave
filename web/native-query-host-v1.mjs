/** Read-only query tools. Semantic choices stay in the native Agent. */
import {hash,clone,need,textField} from './cq-discovery-store-v2.mjs';
import {validateArguments} from './native-build-host-v1.mjs';
import {createNativeQuerySearch} from './native-query-search-v1.mjs';
import {createNativeQueryGraph} from './native-query-graph-v1.mjs';
import {nativeQueryScope} from './native-query-view-v1.mjs';
import {nativeQueryCore} from './native-query-core-v1.mjs';

const string={type:'string',minLength:1,maxLength:16000};
const refs={type:'array',items:string,uniqueItems:true,maxItems:256};
const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const paging={cursor:string,page_size:{type:'integer',minimum:1,maximum:100}};
const search={query:string,keywords:{type:'array',items:string,maxItems:64},source_refs:refs,states:{type:'array',items:{enum:['ACTIVE','HISTORICAL','FUTURE']},uniqueItems:true},...paging};
const {states:_sourceStates,...factSearch}=search;
const graph={predicates:refs,direction:{enum:['OUT','IN','BOTH']},...paging};
export const QUERY_TOOL_NAMES=Object.freeze({
  ENTITIES:'lightog_find_entities',FACTS:'lightog_search_facts',SOURCES:'lightog_search_sources',
  READ:'lightog_read_evidence',ENTITY_FACTS:'lightog_get_entity_facts',EXPAND:'lightog_expand_graph',
  PATHS:'lightog_find_paths',COMPUTE:'lightog_compute',ANSWER:'lightog_submit_answer'
});
const number={type:'number'};
const operand=object({value:number,evidence_refs:refs,calculation_ref:string,input_source:{enum:['EVIDENCE','QUESTION','CALCULATION']}},['value','input_source']);
const schemas={
  [QUERY_TOOL_NAMES.ENTITIES]:object({...factSearch,mentions:{type:'array',items:string,maxItems:64}}),
  [QUERY_TOOL_NAMES.FACTS]:object({...factSearch,kind:{enum:['RELATION','ATTRIBUTE','RULE']},kinds:{type:'array',items:{enum:['RELATION','ATTRIBUTE','RULE']}},subject_refs:refs,predicates:refs},['query']),
  [QUERY_TOOL_NAMES.SOURCES]:object(search,['query']),
  [QUERY_TOOL_NAMES.READ]:object({evidence_refs:refs,doc_ref:string,revision:string,block_refs:refs,...paging}),
  [QUERY_TOOL_NAMES.ENTITY_FACTS]:object({...graph,entity_ref:string,kind:{enum:['RELATION','ATTRIBUTE','RULE']}},['entity_ref']),
  [QUERY_TOOL_NAMES.EXPAND]:object({...graph,seed_refs:refs},['seed_refs']),
  [QUERY_TOOL_NAMES.PATHS]:object({...graph,from_ref:string,to_ref:string,max_depth:{type:'integer',minimum:1,maximum:32}},['from_ref','to_ref']),
  [QUERY_TOOL_NAMES.COMPUTE]:object({operation:{enum:['SUM','MULTIPLY','WEIGHTED_SUM','DIVIDE','CEIL','ROUND_HALF_UP']},operands:{type:'array',items:operand,minItems:1,maxItems:128},weights:{type:'array',items:number,maxItems:128},digits:{type:'integer',minimum:0,maximum:12},rule_evidence_refs:refs},['operation','operands','rule_evidence_refs']),
  [QUERY_TOOL_NAMES.ANSWER]:object({status:{enum:['SUPPORTED','PARTIAL','INSUFFICIENT','CONFLICTED','NEEDS_CLARIFICATION']},statements:{type:'array',items:object({text:string,evidence_refs:refs,fact_refs:refs,calculation_refs:refs},['text','evidence_refs']),maxItems:256},unanswered:{type:'array',items:string,maxItems:128},clarification:string},['status','statements','unanswered'])
};
const description={
  ENTITIES:'按对象提及、已有别名或描述定位候选；同名不合并。',
  FACTS:'检索有效关系、属性或规则，保留限定和精确证据。',
  SOURCES:'检索获准原文；图未就绪时仍可查。历史或未来状态随原文返回。',
  READ:'读回已发放证据或明确来源块，补齐实际上下文。',
  ENTITY_FACTS:'读取已定位主体的实际属性、关系和规则。',
  EXPAND:'沿实际业务关系取邻接，不从来源边推业务关系。',
  PATHS:'查询真实有向事实链；路径不等于因果或传递结论。',
  COMPUTE:'执行明确算术操作并保留输入证据；不认证公式的语义解释。',
  ANSWER:'提交逐结论证据和未答部分，提交后由Host确认收尾，不再调用其他工具。'
};
export function nativeQueryDefinitions(){return Object.entries(QUERY_TOOL_NAMES).map(([key,name])=>({name,description:description[key],inputSchema:clone(schemas[name]),annotations:{readOnlyHint:name!==QUERY_TOOL_NAMES.ANSWER&&name!==QUERY_TOOL_NAMES.COMPUTE,destructiveHint:false,openWorldHint:false}}));}

export function createNativeQueryHost({reader,operation,embed,signal=operation?.signal,onEvent=async()=>{}}){
  need(reader&&operation,'QUERY_HOST_PORT_REQUIRED');
  const searchEngine=createNativeQuerySearch({reader,embed,signal}),graphEngine=createNativeQueryGraph({reader});
  const visible=new Map(),visibleFacts=new Map(),calculations=new Map();let staged=null;
  const definitions=nativeQueryDefinitions();
  const scope=()=>{reader.assertCurrent();return nativeQueryScope(reader);};
  function evidence(ref){
    need(visible.has(ref),'QUERY_EVIDENCE_NOT_ISSUED');
    const e=reader.evidence(ref)??visible.get(ref);validateEvidence(e);return clone(e);
  }
  function validateEvidence(e){
    need(e&&textField(e.evidence_ref)&&textField(e.doc_ref)&&textField(e.revision)&&textField(e.quote),'QUERY_EVIDENCE_INVALID');
    const d=reader.documents().find(d=>d.doc_ref===e.doc_ref&&d.revision===e.revision);
    need(d&&Number.isSafeInteger(e.start)&&Number.isSafeInteger(e.end)&&nativeQueryCore('evidence_span',{content:d.content,start:e.start,end:e.end,quote:e.quote}),'QUERY_EVIDENCE_SOURCE_CHANGED');
    need(!e.offset_unit||['utf16_code_unit','utf16_code_units'].includes(e.offset_unit),'QUERY_EVIDENCE_OFFSET_UNIT_INVALID');
  }
  function collect(value,issued=new Set()){
    if(Array.isArray(value)){value.forEach(v=>collect(v,issued));return;}
    if(!value||typeof value!=='object')return;
    if(value.evidence_ref&&value.quote){validateEvidence(value);visible.set(value.evidence_ref,clone(value));issued.add(value.evidence_ref);}
    if(value.fact_ref&&['RELATION','ATTRIBUTE','RULE'].includes(value.kind)&&Array.isArray(value.evidence))visibleFacts.set(value.fact_ref,factSignature(value));
    for(const ref of value.evidence_refs??[]){const e=reader.evidence(ref);if(e){validateEvidence(e);visible.set(ref,clone(e));issued.add(ref);}}
    Object.values(value).forEach(v=>{if(v&&typeof v==='object')collect(v,issued);});
  }
  function compute(args){
    const ruleEvidence=args.rule_evidence_refs.map(evidence);
    need(ruleEvidence.length>0,'QUERY_COMPUTE_RULE_REQUIRED');
    const sourceText=[operation.state().input?.question??'',...(operation.state().input?.context??[]).filter(x=>x.role==='user').map(x=>x.content??'')].join('\n');
    const operandEvidence=[];
    for(const item of args.operands){
      if(item.input_source==='EVIDENCE'){
        need(item.evidence_refs?.length>0,'QUERY_COMPUTE_INPUT_EVIDENCE_REQUIRED');
        const es=item.evidence_refs.map(evidence);operandEvidence.push(...es);
        need(es.some(e=>numericMention(e.quote,item.value)),'QUERY_COMPUTE_VALUE_NOT_IN_EVIDENCE');
      }else if(item.input_source==='CALCULATION'){
        const prior=calculations.get(item.calculation_ref);need(prior&&prior.value===item.value,'QUERY_COMPUTE_CALCULATION_NOT_ISSUED');
        operandEvidence.push(...prior.evidence_refs.map(evidence));
      }else need(numericMention(sourceText,item.value),'QUERY_COMPUTE_VALUE_NOT_IN_QUESTION');
    }
    const values=args.operands.map(x=>x.value);
    if(args.operation==='WEIGHTED_SUM'){
      need(args.weights?.length===values.length,'QUERY_COMPUTE_WEIGHTS_REQUIRED');
      // Coefficients remain tied to a displayed rule rather than arbitrary hidden defaults.
      need(args.weights.every(w=>w===1||ruleEvidence.some(e=>numericMention(e.quote,w))),'QUERY_COMPUTE_WEIGHT_NOT_IN_RULE');
    }
    const {value}=nativeQueryCore('compute_value',{operation:args.operation,values,...(args.weights!==undefined?{weights:args.weights}:{}),...(args.digits!==undefined?{digits:args.digits}:{})});
    const body={operation:args.operation,operands:clone(args.operands),weights:args.weights??null,digits:args.digits??null,value,evidence_refs:[...new Set([...ruleEvidence,...operandEvidence].map(e=>e.evidence_ref))],scope:scope(),semantic_rule_validation:'NOT_CERTIFIED_BY_ARITHMETIC'};
    const calculation_ref='query_calc_'+hash(body),result={calculation_ref,...body};calculations.set(calculation_ref,result);return clone(result);
  }
  function stage(args){
    scope();
    need(args.status!=='SUPPORTED'||args.statements.length>0,'QUERY_SUPPORTED_ANSWER_EMPTY');
    need(args.status!=='PARTIAL'||args.unanswered.length>0,'QUERY_PARTIAL_GAP_REQUIRED');
    need(args.status!=='NEEDS_CLARIFICATION'||textField(args.clarification),'QUERY_CLARIFICATION_REQUIRED');
    for(const statement of args.statements){
      need(statement.evidence_refs.length>0,'QUERY_STATEMENT_EVIDENCE_REQUIRED');
      statement.evidence_refs.forEach(evidence);
      validateFactRefs(statement);
      for(const ref of statement.calculation_refs??[]){const calculation=calculations.get(ref);need(calculation,'QUERY_CALCULATION_NOT_ISSUED');need(calculation.evidence_refs.every(e=>statement.evidence_refs.includes(e)),'QUERY_CALCULATION_EVIDENCE_INCOMPLETE');}
    }
    const body={...clone(args),statements:args.statements.map(s=>({...clone(s),answer_authority:statementAuthority(s)})),scope:scope(),evidence:[...new Set(args.statements.flatMap(s=>s.evidence_refs))].map(evidence),calculations:[...new Set(args.statements.flatMap(s=>s.calculation_refs??[]))].map(ref=>clone(calculations.get(ref))),validation:'REFERENCES_AND_VERSION_CHECKED_SEMANTICS_NOT_CERTIFIED'};
    const result=operation.stageAnswer(body);staged=body;return result;
  }
  const handlers={
    [QUERY_TOOL_NAMES.ENTITIES]:args=>searchEngine.findEntities(args),
    [QUERY_TOOL_NAMES.FACTS]:args=>searchEngine.searchFacts(args),
    [QUERY_TOOL_NAMES.SOURCES]:args=>searchEngine.searchSources(args),
    [QUERY_TOOL_NAMES.READ]:args=>searchEngine.readEvidence(args),
    [QUERY_TOOL_NAMES.ENTITY_FACTS]:args=>graphEngine.getEntityFacts(args),
    [QUERY_TOOL_NAMES.EXPAND]:args=>graphEngine.expandGraph(args),
    [QUERY_TOOL_NAMES.PATHS]:args=>graphEngine.findPaths(args),
    [QUERY_TOOL_NAMES.COMPUTE]:compute,[QUERY_TOOL_NAMES.ANSWER]:stage
  };
  async function call(name,args={}){
    try{
      operation.assertActive();need(!staged,'QUERY_OUTPUT_ALREADY_STAGED');scope();
      need(Object.hasOwn(handlers,name),'QUERY_TOOL_FORBIDDEN');validateArguments(schemas[name],args);
      const result=await handlers[name](args),issued=new Set();collect(result,issued);
      if(name!==QUERY_TOOL_NAMES.ANSWER){
        const progress=operation.recordProgress({tool_name:name,args_hash:hash(args),evidence_refs:[...issued],result_hash:hash(result)});
        if(progress?.should_stop){operation.stop('QUERY_NO_PROGRESS','INTERRUPTED');return {ok:true,result:{...result,status:'STOPPED_NO_PROGRESS',reason:'相同动作没有新增证据，已停止；保留实际检索结果。'}};}
        await onEvent({event:'sources',tool:name,evidence_refs:[...visible.keys()],scope:scope()});
      }
      return {ok:true,result};
    }catch(error){
      const code=error.code??'QUERY_TOOL_FAILED';
      if(['RUNNING','ANSWER_STAGED'].includes(operation.state().status))operation.stop(code,code.includes('STALE')?'STALE':'FAILED');
      return {ok:false,error:{code}};
    }
  }
  function confirmAnswer({runtime_receipt}={}){
    scope();need(staged,'QUERY_ANSWER_NOT_STAGED');
    for(const statement of staged.statements){statement.evidence_refs.forEach(evidence);validateFactRefs(statement);}
    return operation.confirmAnswer({runtime_receipt,evidence_validated:true});
  }
  function validateFactRefs(statement){
    if(!statement.fact_refs?.length)return;
    const effective=new Map(reader.facts().map(f=>[f.fact_ref,f]));
    for(const ref of statement.fact_refs){
      need(visibleFacts.has(ref),'QUERY_FACT_NOT_ISSUED');const fact=effective.get(ref);
      need(fact&&factSignature(fact)===visibleFacts.get(ref),'QUERY_FACT_NO_LONGER_EFFECTIVE');
      need(fact.evidence.every(e=>statement.evidence_refs.includes(e.evidence_ref)),'QUERY_FACT_EVIDENCE_INCOMPLETE');
    }
  }
  function statementAuthority(statement){
    if(!statement.fact_refs?.length)return 'ORIGINAL_SOURCE';
    const facts=reader.facts().filter(f=>statement.fact_refs.includes(f.fact_ref));
    return facts.every(f=>f.policy==='native-local-adoption-v1'&&f.representation==='ADOPTED_FACT')?'ADOPTED_FACT':'STRUCTURED_SOURCE_EVIDENCE';
  }
  return {definitions,call,isComplete:()=>staged!==null,snapshot:()=>({scope:scope(),staged_answer:clone(staged),issued_evidence_refs:[...visible.keys()],calculations:[...calculations.values()].map(clone)}),confirmAnswer};
}

function numericMention(text,value){
  return nativeQueryCore('numeric_mention',{text:String(text),value});
}
function factSignature(f){const fields=['fact_ref','kind','subject_ref','predicate','object_ref','direction','attribute','raw_value','unit','rule_text','participants','conditions','negation','modality','time_text','version_text','source_refs'];return hash({...Object.fromEntries(fields.filter(k=>Object.hasOwn(f,k)).map(k=>[k,f[k]])),evidence_refs:(f.evidence??[]).map(e=>e.evidence_ref).sort()});}
