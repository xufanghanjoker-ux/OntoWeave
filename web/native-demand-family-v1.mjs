/** Lexical navigation + bounded native semantic decisions. No program semantic merge. */
import {join} from 'node:path';
import {clone,hash,need,textField} from './cq-discovery-store-v2.mjs';
import {nativeFamilyModelItems,validateNativeFamilyOutput,materializeNativeFamilyRefs} from './native-family-input-adapter-v1.mjs';
import {createNativeAgentReferences} from './native-agent-references-v1.mjs';
import {businessArgumentPolicy} from './native-tool-arguments-v1.mjs';
import {runNativeAgent,NATIVE_LOW_SEMANTIC_INPUT_POLICY} from './native-agent-runtime-v1.mjs';

export const DEMAND_FAMILY_POLICY='ON_DEMAND_FAMILY_V1';
export const LOCAL_FAMILY_RECOVERY={version:'LOCAL_FAMILY_RECOVERY_V1',max_format_repairs:1,max_incomplete_continuations:0};
const LOCAL_FAILURES=new Set(['NATIVE_TOOL_ARGUMENTS_JSON_INVALID','NATIVE_FORMAT_REPAIR_JSON_INVALID','NATIVE_FORMAT_REPAIR_NOT_COMPLETED','NATIVE_ROLE_OUTPUT_NOT_SAVED','NATIVE_ROLE_INCOMPLETE','NATIVE_DEMAND_FAMILY_NOT_SAVED']);
export const DEMAND_FAMILY_RECORDS={STATE:'native_demand_family_state_v1',BATCH:'native_demand_family_batch_v1'};
const DEFAULTS={top_k:4,min_similarity:0.12,max_local_items:12,max_local_chars:24000,member_page_chars:10000};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const annotation=readOnlyHint=>({readOnlyHint,destructiveHint:false,idempotentHint:true,openWorldHint:false});
const schema=properties=>({type:'object',properties,additionalProperties:false});
const pairKey=(a,b)=>hash([a,b].sort());
const projection=family=>{const{family_ref,...body}=family;return body;};
function policyOf(options={}){
 const p={...DEFAULTS,...options};need(Object.keys(p).every(k=>Object.hasOwn(DEFAULTS,k))&&Number.isInteger(p.top_k)&&p.top_k>0&&p.top_k<=12&&p.min_similarity>0&&p.min_similarity<=1&&Number.isInteger(p.max_local_items)&&p.max_local_items>=2&&p.max_local_items<=24&&p.max_local_chars>=2000&&p.member_page_chars>=2000,'NATIVE_DEMAND_FAMILY_POLICY_INVALID');return p;
}
function terms(text){
 const result=new Set();for(const word of text.normalize('NFKC').toLocaleLowerCase('en').match(/[\p{L}]+/gu)??[]){const chars=Array.from(word);if(chars.length<=3)result.add(word);for(let i=0;i+1<chars.length;i++)result.add(chars[i]+chars[i+1]);}return result;
}
/** Scores are candidate navigation only, never a family assignment. */
export function recallNativeFamilyCandidates(input,options={}){
 const policy=policyOf(options),items=nativeFamilyModelItems(input),sets=items.map(q=>terms(q.question+' '+(q.notes??''))),df=new Map();
 for(const set of sets)for(const term of set)df.set(term,(df.get(term)??0)+1);
 const weights=new Map([...df].map(([term,count])=>[term,1+Math.log((items.length+1)/(count+1))]));
 const neighbors=items.map(()=>[]);
 for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++){
  let intersection=0,union=0;for(const term of new Set([...sets[i],...sets[j]])){const w=weights.get(term);union+=w;if(sets[i].has(term)&&sets[j].has(term))intersection+=w;}
  const score=union?intersection/union:0;if(score>=policy.min_similarity){neighbors[i].push({index:j,score});neighbors[j].push({index:i,score});}
 }
 const pairs=new Map();neighbors.forEach((list,i)=>list.sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,policy.top_k).forEach(({index,score})=>{const refs=[items[i].cq_ref,items[index].cq_ref].sort();pairs.set(pairKey(...refs),{pair_ref:pairKey(...refs),refs,score});}));
 return {policy,pairs:[...pairs.values()].sort((a,b)=>b.score-a.score||a.pair_ref.localeCompare(b.pair_ref)),semantic_merge_decisions:0};
}
const saveDefinition=()=>({name:'lightog_save_cq_families',description:'保存本批已确认同一完整知识目标的局部归族决定。member_refs可选本批CQ或已有族引用；未合并项由Host原样保留，不用逐题对账。不新增题目或填写系统字段。',inputSchema:{...schema({families:{type:'array',items:{...schema({name:{type:'string',maxLength:200},representative_question:{type:'string',maxLength:1200},member_refs:{type:'array',items:{type:'string'},minItems:1},notes:{type:'string',maxLength:600}}),required:['name','representative_question','member_refs']}},unassigned:{type:'array',items:{...schema({cq_ref:{type:'string'},reason:{type:'string'}}),required:['cq_ref']}}}),required:['families']},annotations:annotation(false)});

export async function runNativeDemandFamilies({store,run,runId,sourceSnapshotRef,input,agentRunner=runNativeAgent,upstream,runtimeDirectory,skillPaths,assertCurrent=()=>{},onInvocation=()=>{},options={},recoveryPolicy=null}){
 need(store&&run&&textField(runId)&&textField(sourceSnapshotRef)&&typeof agentRunner==='function'&&typeof assertCurrent==='function','NATIVE_DEMAND_FAMILY_CONTEXT_INVALID');
 need(recoveryPolicy===null||hash(recoveryPolicy)===hash(LOCAL_FAMILY_RECOVERY),'NATIVE_DEMAND_FAMILY_RECOVERY_POLICY_INVALID');
 const items=nativeFamilyModelItems(input),byRef=new Map(items.map(i=>[i.cq_ref,i])),itemChars=new Map(items.map(i=>[i.cq_ref,JSON.stringify(i).length])),modelItems=refs=>refs.map(ref=>clone(byRef.get(ref))),recall=recallNativeFamilyCandidates(input,options),binding=hash({policy:DEMAND_FAMILY_POLICY,runId,sourceSnapshotRef,input,options:recall.policy});
 assertCurrent();
 const records=DEMAND_FAMILY_RECORDS,prior=store.getRecord(records.STATE,runId);
 if(prior){const{record_sha256,...body}=prior;need(record_sha256===hash(body),'NATIVE_DEMAND_FAMILY_STATE_CHANGED');need(prior.binding===binding,'NATIVE_DEMAND_FAMILY_INPUT_CHANGED');if(['COMPLETED','COMPLETED_WITH_GAPS'].includes(prior.status))return {families:clone(prior.families),summary:clone(prior.summary),execution_outcome:'NO_AUTOMATIC_REPLAY'};need(false,'NATIVE_DEMAND_FAMILY_NO_AUTOMATIC_REPLAY');}
 const current=()=>{run.assertOpen();assertCurrent();};current();
 let active=[],seen=new Set(),batchNumber=0;const reasons=new Map(),invocations=[],gaps=[],unresolved=new Set();
 const canonical=()=>{
  const assigned=new Set(active.flatMap(f=>f.member_refs)),args={input_ref:input.input_ref,families:active.map(projection),unassigned:input.items.filter(i=>!assigned.has(i.cq_ref)).map(i=>({cq_ref:i.cq_ref,reason:reasons.get(i.cq_ref)??'未形成可靠同目标归族，原问题及特有条件保留继续规划。'}))};
  return materializeNativeFamilyRefs({input,families:validateNativeFamilyOutput({input,args})});
 };
 const persist=(status,extra={})=>{const body={version:DEMAND_FAMILY_POLICY,run_id:runId,source_snapshot_ref:sourceSnapshotRef,binding,status,input_ref:input.input_ref,candidate_pairs:clone(recall.pairs),completed_pair_refs:[...seen].filter(r=>!unresolved.has(r)),unresolved_pair_refs:[...unresolved],local_gaps:clone(gaps),recovery_policy:clone(recoveryPolicy),families:canonical(),invocations:clone(invocations),...clone(extra)};return store.putRecord(records.STATE,runId,{...body,record_sha256:hash(body)});};
 persist('RUNNING');
 try{
  while(true){
   current();const membership=new Map(active.flatMap(f=>f.member_refs.map(ref=>[ref,f.family_ref]))),familyMap=new Map(active.map(f=>[f.family_ref,f]));
   const cqRefs=new Set(),familyHits=new Map(),batchPairs=[];
   const familySummary=ref=>{const f=familyMap.get(ref);return {family_ref:ref,name:f.name,representative_question:f.representative_question,...(f.notes?{notes:f.notes}:{})};};
   const contextOf=(qs,fs)=>({cqs:modelItems([...qs]),families:[...fs].map(([ref,hits])=>({...familySummary(ref),matched_members:modelItems([...hits])}))});
   const contextChars=(qs,fs)=>128+[...qs].reduce((n,ref)=>n+itemChars.get(ref)+1,0)+[...fs].reduce((n,[ref,hits])=>n+JSON.stringify(familySummary(ref)).length+64+[...hits].reduce((m,r)=>m+itemChars.get(r)+1,0),0);
   for(const pair of recall.pairs){
    if(seen.has(pair.pair_ref))continue;
    const [a,b]=pair.refs;if(membership.has(a)&&membership.get(a)===membership.get(b)){seen.add(pair.pair_ref);continue;}
    const nextQ=new Set(cqRefs),nextF=new Map([...familyHits].map(([r,hits])=>[r,new Set(hits)]));
    for(const ref of pair.refs){const f=membership.get(ref);if(f){if(!nextF.has(f))nextF.set(f,new Set());nextF.get(f).add(ref);}else nextQ.add(ref);}
    const size=nextQ.size+[...nextF.values()].reduce((n,hits)=>n+hits.size,0),chars=contextChars(nextQ,nextF);
    if(batchPairs.length&&(size>recall.policy.max_local_items||chars>recall.policy.max_local_chars))continue;
    cqRefs.clear();for(const ref of nextQ)cqRefs.add(ref);familyHits.clear();for(const[ref,hits]of nextF)familyHits.set(ref,hits);batchPairs.push(pair);
   }
   if(!batchPairs.length)break;
   const batchRef='demand_family_batch_'+hash([runId,++batchNumber,batchPairs.map(p=>p.pair_ref)]),agentScope='family-local-'+batchNumber,context=contextOf(cqRefs,familyHits),allowed=new Set([...cqRefs,...familyHits.keys()]),pages=new Map();let saved=false,pending=false;
   const batch={batch_ref:batchRef,run_id:runId,source_snapshot_ref:sourceSnapshotRef,binding,agent_scope:agentScope,status:'PREPARED',context:clone(context),pair_refs:batchPairs.map(p=>p.pair_ref),raw_proposal:null,warnings:[]};store.putRecord(records.BATCH,batchRef,batch);
   const tools={argumentPolicy:businessArgumentPolicy(['lightog_save_cq_families']),definitions:[{name:'lightog_read_family_members',description:'需要核对候选已有族的完整成员及特有条件时读取。只选本批family_ref；continue=true由Host续下一页。',inputSchema:schema({family_ref:{type:'string'},continue:{type:'boolean'}}),annotations:annotation(true)},saveDefinition()],isComplete:()=>saved&&!pending,
    flushPendingFinish:()=>{pending=false;},
    progressSnapshot:()=>({saved,read_pages:[...pages]}),async call(name,args={},ctx={}){
     try{current();need(!saved||pending,'NATIVE_DEMAND_FAMILY_BATCH_CLOSED');
      if(name==='lightog_read_family_members'){
       need(familyHits.has(args.family_ref),'NATIVE_DEMAND_FAMILY_READ_FORBIDDEN');const f=familyMap.get(args.family_ref),all=modelItems(f.member_refs);let offset=args.continue===true?(pages.get(args.family_ref)??0):0,end=offset,chars=0;
       while(end<all.length){const n=JSON.stringify(all[end]).length;if(end>offset&&chars+n>recall.policy.member_page_chars)break;chars+=n;end++;}
       pages.set(args.family_ref,end);return {ok:true,result:{family_ref:f.family_ref,members:all.slice(offset,end),has_more:end<all.length,read_performed:end>offset}};
      }
      need(name==='lightog_save_cq_families','NATIVE_DEMAND_FAMILY_TOOL_FORBIDDEN');
      need(!saved,'NATIVE_DEMAND_FAMILY_SAVE_CONFLICT');
      const warnings=[],candidates=[];const warn=code=>warnings.push(code);
      if(!object(args)||!Array.isArray(args.families))warn('LOCAL_FAMILY_LIST_INVALID');
      for(const group of Array.isArray(args?.families)?args.families:[]){
       if(!object(group)||!Array.isArray(group.member_refs)||!group.member_refs.length||group.member_refs.some(ref=>!allowed.has(ref))){warn('LOCAL_FAMILY_SELECTOR_INVALID');continue;}
       const selectors=[...new Set(group.member_refs)],touched=selectors.filter(ref=>familyHits.has(ref)),members=[...new Set(selectors.flatMap(ref=>familyMap.get(ref)?.member_refs??[ref]))];
       if(members.length<2)continue;
       try{
        const mini={...input,items:input.items.filter(i=>members.includes(i.cq_ref)),mapping:Object.fromEntries(members.map(ref=>[ref,clone(input.mapping[ref])]))},proposed={...clone(group),member_refs:members};
        const valid=validateNativeFamilyOutput({input:mini,args:{input_ref:input.input_ref,families:[proposed],unassigned:[]}}).families[0];candidates.push({family:valid,touched});
       }catch{warn('LOCAL_FAMILY_PROPOSAL_INVALID');}
      }
      const overlap=new Set();for(let i=0;i<candidates.length;i++)for(let j=i+1;j<candidates.length;j++)if(candidates[i].family.member_refs.some(ref=>candidates[j].family.member_refs.includes(ref))){overlap.add(i);overlap.add(j);}
      const accepted=candidates.filter((_,i)=>!overlap.has(i));if(overlap.size)warn('LOCAL_FAMILY_OVERLAP_UNRESOLVED');
      for(const row of Array.isArray(args?.unassigned)?args.unassigned:[])if(cqRefs.has(row?.cq_ref)&&textField(row.reason))reasons.set(row.cq_ref,row.reason);
      const touched=new Set(accepted.flatMap(c=>c.touched));active=active.filter(f=>!touched.has(f.family_ref)).concat(accepted.map(c=>c.family));active=canonical().families;
      for(const pair of batchPairs)seen.add(pair.pair_ref);
      saved=true;pending=!!ctx.pending_tool_calls?.length;const result={saved:true,accepted_families:accepted.map(c=>clone(c.family)),warnings:[...new Set(warnings)],retained_originals:true};
      store.putRecord(records.BATCH,batchRef,{...batch,status:'SAVED',raw_proposal:clone(args),proposal_context:clone(ctx),result:clone(result),warnings:result.warnings});persist('RUNNING');
      return {ok:true,result};
     }catch(error){return {ok:false,error:{code:error.code??'NATIVE_DEMAND_FAMILY_TOOL_FAILED'}};}
    }};
   const prompt='$lightog-cq-family-normalization-product-v1\n只比较本批候选是否属于同一完整知识目标。词法相似不是同族结论。已有族用族引用参与合并，必要时读取其完整成员；未确认合并即可保留原题。仅保存本批决定，由Host推进后续批次。\n'+JSON.stringify(context);
   const refs=createNativeAgentReferences({store,runId,role:'FAMILY',agentScope,tools,prompt,knowledgeBuildPolicy:'EXTRACT_AND_INDEX_V1',runtimeInputPolicy:NATIVE_LOW_SEMANTIC_INPUT_POLICY,lifecycle:{mode:'SINGLE_COMMIT',save:['lightog_save_cq_families']},assertCurrent:current});
   let localStop=null;
   const attempts=()=>run.state().attempts.filter(a=>a.agent_scope===agentScope);
   const safe=reason=>!!recoveryPolicy&&LOCAL_FAILURES.has(reason)&&['OPEN','RUNNING'].includes(run.state().status)&&attempts().length>0&&attempts().every(a=>a.outcome==='RETURNED');
   const stageRun={...run,state:()=>({...run.state(),...(localStop??{})}),assertOpen(){const state=run.assertOpen();need(!localStop,'NATIVE_LOCAL_FAMILY_CLOSED');return state;},reserve(args){need(!localStop,'NATIVE_LOCAL_FAMILY_CLOSED');return run.reserve({...args,agentScope});},stop(reason,status){if(safe(reason)){localStop??={status:'FAILED',reason};return this.state();}return run.stop(reason,status);}};
   let result,error;
   try{result=await agentRunner({store,run:stageRun,role:'FAMILY',agentScope,tools:refs.tools,prompt:refs.prompt,skillPaths,runtimeDirectory:join(runtimeDirectory,agentScope),upstream,model:'qwen3.8-flash',runtimeInputPolicy:NATIVE_LOW_SEMANTIC_INPUT_POLICY,maxFormatRepairs:recoveryPolicy?.max_format_repairs??0,maxIncompleteContinuations:0});}catch(e){error=e;}
   const receipt=result?.receipt??result??null;if(receipt){invocations.push(clone(receipt));await onInvocation({...clone(receipt),reference_manifest:refs.snapshot()});}
   const reason=error?.code??localStop?.reason??receipt?.reason??'NATIVE_DEMAND_FAMILY_NOT_SAVED';
   if(error||localStop||result?.complete!==true||!tools.isComplete()){
    if(!safe(reason)){if(error)throw error;current();need(false,reason);}
    const gap={batch_ref:batchRef,agent_scope:agentScope,reason,pair_refs:batchPairs.map(p=>p.pair_ref),request_refs:attempts().map(a=>a.request_ref),saved_output_retained:saved};gaps.push(gap);
    for(const pair of batchPairs){seen.add(pair.pair_ref);unresolved.add(pair.pair_ref);}
    const retained=store.getRecord(records.BATCH,batchRef);store.putRecord(records.BATCH,batchRef,{...retained,status:'LOCAL_UNRESOLVED',gap,receipt:clone(receipt)});persist('RUNNING');continue;
   }
   current();
  }
  const families=canonical(),summary={policy:DEMAND_FAMILY_POLICY,input_cqs:items.length,candidate_pairs:recall.pairs.length,local_batches:batchNumber,partial:gaps.length>0,failed_local_batches:gaps.length,local_gaps:clone(gaps),unresolved_pair_refs:[...unresolved],families:families.families.length,unassigned_cqs:families.unassigned.length,semantic_quality:'NOT_AUTOMATICALLY_CERTIFIED',candidate_recall:'LEXICAL_NAVIGATION_NOT_SEMANTIC_MERGE'};persist(gaps.length?'COMPLETED_WITH_GAPS':'COMPLETED',{families,summary});return {families,summary,execution_outcome:'EXECUTED'};
 }catch(error){persist(run.state().status==='UNKNOWN_HOLD'?'UNKNOWN':'FAILED',{reason:error.code??'NATIVE_DEMAND_FAMILY_FAILED'});throw error;}
}
