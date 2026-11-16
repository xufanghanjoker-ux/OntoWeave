/** Action receiver staging over existing semantic and organization tools. No raw-record writes. */
import {clone, hash, need, textField} from './cq-discovery-store-v2.mjs';
import {prepareNativeActionBatch} from './native-action-contract-v1.mjs';
import {buildNativeActionProcess} from './native-action-process-v1.mjs';
import {projectNativeActionDomain} from './native-action-domain-adapter-v1.mjs';
import {createNativeOrganizationTools, ORGANIZATION_TOOLS as O} from './native-knowledge-organization-v1.mjs';
import {NATIVE_BUILD_TOOL_NAMES as N} from './native-build-host-v1.mjs';
import {SEMANTIC_TOOLS as S} from './native-semantic-package-v1.mjs';
import {createNativeReadSession, nativePageNext, CONTINUE_READ_SCHEMA} from './native-agent-read-session-v1.mjs';
import {pageSavedKnowledge} from './native-organization-focus-v1.mjs';
import {businessArgumentPolicy, retainUnparsedBusinessOutput} from './native-tool-arguments-v1.mjs';
import {resolveNativeActionCorrections} from './native-action-correction-v1.mjs';

export const ACTION_ORGANIZATION_TOOLS = {SAVE:'lightog_save_action_experience', LINK:'lightog_link_action_process', RELATED:'lightog_read_related_experience',CORRECT:'lightog_correct_action_knowledge'};
const STAGE = 'native_action_organization_stage_v1';
const obj = properties => ({type:'object', additionalProperties:true, properties});
const str = {type:'string'}, refs = {type:'array', items:str};
const definition = (name, description, properties, read = false) => ({name, description, inputSchema:obj(properties),
  annotations:{readOnlyHint:read, destructiveHint:false, openWorldHint:false}});

export function createNativeActionOrganizationStage({store, run, runId, libraryId, p, window, sourceRecords, contextKnowledge = [], assertCurrent,operation='SAVE',correctionTargetRecordRefs=[]}) {
  const binding = hash({runId, libraryId, package:p.record_sha256, window, sourceRecords, contextKnowledge,operation,correctionTargetRecordRefs});
  const previous = store.getRecord(STAGE, runId);
  need(!previous || previous.binding === binding, 'ACTION_ORGANIZATION_BINDING_CHANGED');
  if (!previous) store.putRecord(STAGE, runId, {binding, drafts:[], links:[], retained:[], gaps:[], calls:[], review:false, finished:false,
    correction_proposals:[],correction_bindings:[],correction_audit:[],correction_retained:[],correction_pending:false});
  const get = () => store.getRecord(STAGE, runId), put = state => store.putRecord(STAGE, runId, clone(state));
  const semanticItems = p.items.map(item => ({...clone(item), library_id:libraryId, evidence:sourceRecords
    .filter(source => window.source_refs.some(ref => ref.doc_ref === source.source_record_ref && ref.revision === source.revision))
    .map(source => ({source_record_ref:source.source_record_ref, revision:source.revision, quote:item.quote ?? ''}))}));
  const packageRefs = () => Object.fromEntries(get().drafts.map(draft => [draft.draft_ref, p.package_ref]));
  const projection = () => projectNativeActionDomain({libraryId, drafts:get().drafts, links:get().links,
    sourceRecords, contextKnowledge, semanticPackageRefs:packageRefs()});
  const savedRows = () => projection().knowledge.map((record,index) => ({...clone(record), knowledge_ref:'K' + (index + 1)}));
  const savedRead = createNativeReadSession({binding:() => hash(get().drafts), selectionFields:['knowledge_refs'],
    select:args => ({knowledge_refs:args.knowledge_refs ?? null}),
    produce(selection,position) {const page=pageSavedKnowledge(savedRows(),{...selection,...position,max_chars:6000});return {result:page,next:nativePageNext(page)};}});
  const contextRows = contextKnowledge.map((record,index) => ({...clone(record), knowledge_ref:'C' + (index + 1)}));
  const contextRead = createNativeReadSession({binding:() => hash(contextKnowledge), selectionFields:['knowledge_refs'],
    select(args) {need(args.knowledge_refs === undefined || Array.isArray(args.knowledge_refs)
      && args.knowledge_refs.every(ref => contextRows.some(row => row.knowledge_ref === ref)), 'ACTION_CONTEXT_REFERENCE_UNKNOWN');
      return {knowledge_refs:args.knowledge_refs ?? null};},
    produce(selection,position) {const page=pageSavedKnowledge(contextRows,{...selection,...position,max_chars:6000});return {result:page,next:nativePageNext(page)};}});
  const snapshot = () => ({knowledge:projection().knowledge, processing_results:[], gaps:clone(get().gaps),
    extraction_complete:get().finished, domain_definitions:[], local_review:{phase:get().review?'REVIEW':'DRAFT'}});
  const host = {
    snapshot, assertCurrentRead:assertCurrent,
    definitions:() => [definition(N.SAVED,'读取本轮实际保存的行动表达及完整扩展，支持K选择和continue续读。', {...CONTINUE_READ_SCHEMA,knowledge_refs:refs},true),
      definition(N.STATE,'读取本轮处理概况。',{},true)],
    programPartialFinish(context) {
      const own=run.state().attempts.filter(attempt=>attempt.agent_scope===window.window_ref+':ORGANIZATION');
      need(context.native_completion?.status==='completed' && own.length>0 && own.every(attempt=>attempt.outcome==='RETURNED')
        && hash(own.map(attempt=>attempt.request_ref))===hash(context.request_refs), 'ACTION_PARTIAL_REQUEST_UNSETTLED');
      const state=get();if(!state.drafts.length)return {partial:false,saved_output:false};
      put({...state,finished:true,partial:true,gaps:[...state.gaps,'ACTION_FINISH_NOT_CALLED']});
      return {partial:true,saved_output:true,reason:'ACTION_FINISH_NOT_CALLED'};
    },
    async call(role,name,args={}) {
      assertCurrent();need(role==='EXTRACTION','ACTION_ROLE_FORBIDDEN');
      if(name===N.SAVED)return {ok:true,result:savedRead(args)};
      if(name===N.STATE)return {ok:true,result:{saved_items:get().drafts.length,retained:get().retained.length,gaps:get().gaps,extraction_complete:get().finished}};
      need(name===N.FINISH,'ACTION_OLD_RECEIVER_FORBIDDEN');
      const state=get(),gaps=Array.isArray(args.gaps)?args.gaps:[];
      if(!state.review){put({...state,review:true,gaps:[...state.gaps,...gaps]});return {ok:true,result:{status:'LOCAL_REVIEW_AVAILABLE',extraction_complete:false}};}
      put({...state,finished:true,gaps:[...state.gaps,...gaps]});return {ok:true,result:{extraction_complete:true,semantic_quality:'UNASSESSED'}};
    },
  };
  const base=createNativeOrganizationTools({store,runId,host,p,window,compactFinishFeedback:true});
  // Reuse source/semantic reads, focus, actual saved readback and one local review; old saves are not advertised.
  const allowed=new Set([S.READ,S.SOURCE,N.SAVED,N.STATE,O.FINISH,O.FOCUS,O.NEXT]);
  const definitions=[...base.definitions.filter(item=>allowed.has(item.name)),
    definition(ACTION_ORGANIZATION_TOOLS.SAVE,
      '保存当前语义支持的行动经验。records逐项选择category:action/state/observation/evaluation/process/definition/text，写text和semantic_refs；按原义附subject、action_phase、participants[{role,entity:{name,type}}]、property/value/unit、方法/窗口/判据、conditions/time_text/uncertainties。建议/计划不当执行，操作结果不当业务效果；字段可缺，坏项保留，不编造ID或系统时间。',
      {records:{type:'array',items:obj({category:{type:'string',enum:['action','state','observation','evaluation','process','definition','text']},text:str,semantic_refs:refs,
        subject:{},action_phase:str,participants:{type:'array',items:obj({role:str,entity:{}})},property:str,value:{},unit:str,conditions:refs,time_text:str,uncertainties:refs})},gaps:refs}),
    definition(ACTION_ORGANIZATION_TOOLS.LINK,
      '仅在原文有依据时关联本轮K和已提供的相关C：links每项from、to、type(BEFORE_ACTION/AFTER_ACTION/REALIZES_PLAN/EVALUATION_OF/MEMBER_OF)、semantic_refs。from必须是本轮已保存K。引用支持回指的原语义；同名、同一天不等于同一次过程，不提供因果类型。',
      {links:{type:'array',items:obj({from:str,to:str,type:str,semantic_refs:refs})}}),
    definition(ACTION_ORGANIZATION_TOOLS.RELATED,'读取程序限定的相关已存经验，C选择，continue续读；只作消歧和关联，不重新抽取。', {...CONTINUE_READ_SCHEMA,knowledge_refs:refs},true)];
  if(operation==='CORRECTION')definitions.push(definition(ACTION_ORGANIZATION_TOOLS.CORRECT,
    '本次用户明确更正既有知识。对照新原话和已有C的对象、观察/限定与内容，保存对应含义种类的正确新表达K，再提交corrections:[{target:已有C句柄,replacement:本轮K句柄,reason:更正理由,semantic_refs:新语义句柄}]。只指明被更正项，不整段移除原记录里的其他计划/事实。不能确定目标、或认为原分类本身有误时保留缺口，不猜测或用新进展替换旧知识。',
    {corrections:{type:'array',items:obj({target:str,replacement:str,reason:str,semantic_refs:refs})}}));
  const custom=new Set(Object.values(ACTION_ORGANIZATION_TOOLS));
  const tools={...base,definitions,argumentPolicy:businessArgumentPolicy([ACTION_ORGANIZATION_TOOLS.SAVE,ACTION_ORGANIZATION_TOOLS.LINK,
    ...(operation==='CORRECTION'?[ACTION_ORGANIZATION_TOOLS.CORRECT]:[]),O.FINISH],{retainBusinessOutput:true,recoverBusinessItems:true}),
    progressSnapshot:context=>custom.has(context.name)?{drafts:get().drafts.map(draft=>draft.content_sha256),links:get().links.map(link=>link.link_sha256),
      corrections:get().correction_bindings,retained:get().retained}:base.progressSnapshot(context),
    async call(name,args={},ctx={}) {
      if(!custom.has(name))return base.call(name,args,ctx);
      try {
        assertCurrent();if(name===ACTION_ORGANIZATION_TOOLS.RELATED)return {ok:true,result:contextRead(args)};
        need(!get().finished,'ACTION_ORGANIZATION_ALREADY_FINISHED');
        need(textField(ctx.invocation_ref)&&textField(ctx.tool_call_ref),'ACTION_CALL_CONTEXT_REQUIRED');
        const key=hash([ctx.invocation_ref,ctx.tool_call_ref]),digest=hash([name,args]);
        const old=get().calls.find(call=>call.key===key);
        if(old){need(old.digest===digest,'ACTION_CALL_REPLAY_CONFLICT');return clone(old.result);}
        return store.transaction(()=>{
          const state=get();let result;
          const unparsed=retainUnparsedBusinessOutput({store,runId,name,args,ctx});
          if(unparsed){state.retained.push({raw:clone(args),reason:'UNPARSED_ACTION_OUTPUT_RETAINED'});result={ok:true,result:{saved:false,raw_retained:true}};}
          else if(name===ACTION_ORGANIZATION_TOOLS.SAVE){
            if(!Array.isArray(args.records)){state.retained.push({raw:clone(args),reason:'ACTION_RECORDS_ARRAY_MISSING'});result={ok:true,result:{saved:false,raw_retained:true}};}
            else {
              const start=state.drafts.length;
              const proposals=args.records.map((row,index)=>{if(!row||typeof row!=='object'||Array.isArray(row))return row;
                const {category,text,semantic_refs,conditions,uncertainties,time_text,valid_time,negation,...business}=row;
                return Object.fromEntries(Object.entries({local_ref:key+'_'+index,category,text,semantic_refs,conditions,uncertainties,time_text,valid_time,negation,business}).filter(([,value])=>value!==undefined));});
              const batch=prepareNativeActionBatch({libraryId,requestId:runId,sourceRecords,semanticItems,proposals});
              state.drafts.push(...batch.drafts);state.retained.push(...batch.retained,...batch.input_gaps);
              for(const warning of batch.evidence_warnings.filter(item=>item.proof_scope==='SOURCE_RECORD_ONLY')){
                const gap={code:'NATIVE_ACTION_QUOTE_'+warning.status,...warning};
                if(!state.gaps.some(item=>hash(item)===hash(gap)))state.gaps.push(gap);
              }
              state.gaps.push(...(Array.isArray(args.gaps)?args.gaps:[]));put(state);
              result={ok:true,result:{saved:batch.drafts.length>0,received:args.records.length,saved_count:batch.drafts.length,
                knowledge_refs:batch.drafts.map((_,index)=>'K'+(start+index+1)),retained_count:batch.retained.length,
                saved_items:batch.drafts.map((draft,index)=>({knowledge_ref:'K'+(start+index+1),record_type:draft.record_type,
                  semantic_refs:draft.semantic_lineage.map(item=>item.semantic_ref),warnings:clone(draft.warnings),
                  ...(draft.payload.action_phase?{action_phase:draft.payload.action_phase,execution_claim:draft.payload.execution_claim}:{})})),
                retained_reasons:batch.retained.map(item=>({index:item.index,reason:item.reason})),
                input_gaps:batch.input_gaps.map(item=>({kind:item.kind,semantic_ref:item.raw?.semantic_ref??null,reason:item.reason})),
                evidence_warnings:batch.evidence_warnings,
                reading:{tool:N.SAVED,meaning:'按需读取本批knowledge_refs的完整正文；continue:true续读。'},semantic_quality:'UNASSESSED'}};
            }
          } else if(name===ACTION_ORGANIZATION_TOOLS.CORRECT){
            need(operation==='CORRECTION','ACTION_CORRECTION_NOT_REQUESTED');
            if(!Array.isArray(args.corrections)){state.retained.push({raw:clone(args),reason:'ACTION_CORRECTIONS_ARRAY_MISSING'});state.correction_pending=true;}
            else {
              state.correction_proposals.push(...clone(args.corrections));
              const resolution=resolveNativeActionCorrections({libraryId,proposals:state.correction_proposals,currentDrafts:state.drafts,contextKnowledge,targetRecordRefs:correctionTargetRecordRefs});
              state.correction_bindings=resolution.bindings;state.correction_audit=resolution.audit;
              state.correction_retained=resolution.retained;state.correction_pending=resolution.pending;
            }
            result={ok:true,result:{bound_corrections:state.correction_bindings.length,pending:state.correction_pending,
              retained:state.correction_retained,meaning:'仅生成明确更正提案；旧知识在统一发布前保持。'}};
          } else {
            const current=state.drafts.map((draft,index)=>({ref:draft.draft_ref,draft,handle:'K'+(index+1)}));
            const related=contextKnowledge.map((record,index)=>({ref:record.native_action.draft_ref,draft:record.native_action,handle:'C'+(index+1)}));
            const associations=[],bindings=[];
            for(const [index,row]of (Array.isArray(args.links)?args.links:[]).entries()){
              const from=current.find(node=>node.handle===row?.from),to=[...current,...related].find(node=>node.handle===row?.to);
              const semantic_ref=Array.isArray(row?.semantic_refs)?row.semantic_refs.find(ref=>from?.draft.semantic_lineage.some(item=>item.semantic_ref===ref)):null;
              const binding_ref=key+'_'+index;
              bindings.push({library_id:libraryId,binding_ref,kind:'EXPLICIT_REFERENCE',from_ref:from?.ref??null,to_ref:to?.ref??null,semantic_ref:semantic_ref??null,
                origin:'MODEL_PROPOSED_REFERENCE',semantic_truth_verified:false});
              associations.push({type:row?.type??null,from_ref:from?.ref??null,to_ref:to?.ref??null,basis:{binding_ref}});
            }
            const process=buildNativeActionProcess({libraryId,nodes:[...current,...related].map(({handle,...node})=>node),associations,referenceBindings:bindings});
            state.links.push(...process.links);state.retained.push(...process.retained);
            if(!Array.isArray(args.links))state.retained.push({raw:clone(args),reason:'ACTION_LINKS_ARRAY_MISSING'});
            result={ok:true,result:{saved_links:process.links.length,retained:process.retained,claim_scope:'MODEL_PROPOSED_NOT_CAUSAL'}};
          }
          state.calls.push({key,digest,result:clone(result)});put(state);return result;
        });
      } catch(error) {return {ok:false,error:{code:error.code??'ACTION_ORGANIZATION_TOOL_FAILED'}};}
    },
  };
  return {tools,snapshot:()=>clone(get()),projection,semanticPackageRefs:packageRefs,
    related_summary:pageSavedKnowledge(contextRows.map(row=>({knowledge_ref:row.knowledge_ref,text:(row.statement??row.text??'').slice(0,300),
      record_type:row.native_action.record_type})),{max_chars:4000,max_items:8})};
}
