/** Resume a frozen claims candidate after local decisions; never replay extraction. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sha,validateSchema,validateClaims,queryPlanIssues,makePacket,answerCQ} from './engine.mjs';
import {claimReviewBatches} from './source-context.mjs';
import {compileReview,reviewTargets,workbenchReviewPrompt} from './review-protocol.mjs';
import {packetHash,decideReview} from '../fixtures/tools/evaluator-gate.mjs';
import {parseModelJson} from '../experiments/model-loop/provider.mjs';

export const continuationProfile=p=>({model:p.model||null,endpoint:p.root||p.baseUrl||null,max_tokens:p.maxTokens??null,
  timeout_ms:p.timeoutMs??null,thinking:p.thinkingMode??p.thinkingProfile??p.thinking??null});
const version='human_candidate_review_v1';
const fail=(code,message,details)=>Object.assign(Error(message),{code,details});
const prompt=workbenchReviewPrompt+`\n本次为人工处理后的候选复评。human_decisions是人的处理记录，不是新增来源或事实认证；排除候选不删除原资料，不能要求为填满CQ而补造声明。
packet是候选的一批，不能因本批缺少另一批声明判断整库CQ未覆盖。cq_execution_preview是程序针对完整候选计算的未发布查询预览：UNKNOWN表示合法缺证，已有查询计划且查询能返回UNKNOWN，不等于CQ_UNCOVERED。只有查询计划本身错误才报告未覆盖并指出具体计划，不能要求添加虚构的UNKNOWN事实。核对候选与原文主体、限定及类型，仍需报告真实错误。`;

export async function reviewHumanCandidate(input, session, provider, {save=()=>{},update=()=>{},checkpoint=()=>{},
  checkpoints=[],repairHistory=[],autoRepair=false,cancelled=()=>false}={}){
  assert(session.input_sha256===sha(input),'人工继续的资料已变化，请创建修订版本');
  assert(sha(continuationProfile(provider))===sha(session.source_profile),'模型配置已变化，不能强行复用旧构建；请恢复原配置或创建修订');
  const schema=validateSchema(structuredClone(session.candidate.schema),input);
  assert(!queryPlanIssues(schema,input).length,'查询计划存在目标绑定问题，不能跳过本体修订');
  const normalized=validateClaims({claims:session.candidate.claims},schema,input,{collectErrors:true});
  assert(!normalized.issues.length,'人工候选未通过证据及类型校验');
  assert(sha(session.candidate)===session.candidate_hash,'人工候选快照不一致');
  const baseline=session.baseline_checkpoint;
  assert(baseline?.validated===true&&baseline.output_sha256===sha(baseline.output),'缺少可验证的独立阅读检查点');
  assert(['supported_scopes','unknowns','potential_errors'].every(k=>Array.isArray(baseline.output[k])),'独立阅读检查点格式无效');
  const claims=normalized.claims,contextId=randomUUID(),calls=[],accepted=[],reused=[],gates=[],repairs=structuredClone(repairHistory);
  const preview=input.cqs.map(q=>{const a=answerCQ({status:'READY',schema,claims},input,q.id);return {cq_id:q.id,
    template:schema.cq_plans.find(p=>p.cq_id===q.id)?.template,classification:a.classification,matching_claim_count:a.claims.length,
    scope:'UNPUBLISHED_WHOLE_CANDIDATE_PREVIEW',unknown_is_valid:true};});
  save('schema',schema);save('claims',{claims,partial:true});
  const component=session.component_publication;
  const batches=[...(component?[{id:'schema',schemaOnly:true,claims:[],indices:[]}]:[]),...claimReviewBatches(claims)];
  for(const batch of batches){
    if(cancelled())throw fail('SYSTEM_CANCELLED','用户已停止人工核对后的继续处理');
    const key=(component?'component_review:':'human_review:')+session.decision_set_hash+':'+batch.id;
    const stage=batch.schemaOnly?'schema_review':'claims_review';
    const packet=makePacket(input,batch.schemaOnly?{schema}:{schema,claims:batch.claims},stage);
    packet.packet_id='packet_'+sha({input:sha(input),candidate:session.candidate_hash,key}).slice(0,24);
    const batchIds=new Set(batch.claims.map(c=>c.id));
    const decisions=batch.schemaOnly?session.audit:session.audit.filter(d=>!d.claim_ids?.length||d.claim_ids.some(id=>batchIds.has(id))||batchIds.has(d.new_claim_id)||d.choice==='EXCLUDE_CLAIM');
    const payload={context:{cqs:input.cqs,confirmed_user_definitions:input.definitions,sources:[],review_scope:batch.schemaOnly?'SCHEMA':'CLAIM_BATCH'},
      independent_baseline:baseline.output,packet,targets:reviewTargets(packet.proposal).filter(t=>['/schema','/claims'].includes(t.pointer)||/^\/claims\/\d+$/.test(t.pointer)||batch.schemaOnly&&/^\/schema\/(?:entities|predicates|cq_plans)\/\d+$/.test(t.pointer))
        .map(({ref,target_ref,pointer,kind,label})=>({ref,target_ref,pointer,kind,label})),
      ...(component?{component_publication:component,...(session.audit.length?{human_decisions:decisions}:{})}:{human_decisions:decisions}),cq_execution_preview:preview,decision_set_hash:session.decision_set_hash};
    const selectedPrompt=component?workbenchReviewPrompt+'\nReview the complete dependency-closed snapshot independently. Withheld components are not facts or approvals. Human decisions are proposals for review, never new evidence or automatic approval. UNKNOWN is valid missing evidence; do not fill withheld facts.':prompt;
    if(JSON.stringify(payload).length>100000)throw fail('SYSTEM_REVIEW_CONTEXT_TOO_LARGE','本批人工说明及证据超过复评容量，请分次处理或缩短核对说明；未发送');
    const fingerprint=sha({key,input:sha(input),candidate:session.candidate_hash,profile:continuationProfile(provider),prompt:selectedPrompt,payload,version});
    save('packet-'+key,packet);
    function validate(raw,metadata){
      const compiled=compileReview(packet,raw);
      if(!compiled.valid)throw fail('SYSTEM_REVIEW_PROTOCOL_INVALID','复评格式或引用不合法：'+JSON.stringify(compiled.diagnostics),{diagnostics:compiled.diagnostics});
      const binding=packetHash(packet),reviewer=metadata.context_id||contextId;
      const execution={packet_hash:binding,builder_context_id:session.builder_context_id,reviewer_context_id:reviewer,
        reviewer_run_id:'human_'+sha({fingerprint,reviewer}).slice(0,24),reviewer_model:provider.model,
        reviewer_prompt_version:version,independent_baseline_completed:true,
        independent_baseline_record_id:baseline.metadata.context_id+':independent_reading'};
      const review={...compiled.review,packet_id:packet.packet_id,packet_hash:binding,review_id:'review_'+sha(execution).slice(0,24),reviewer_run_id:execution.reviewer_run_id};
      const gate=decideReview(packet,review,{status:'PASS',packet_hash:binding},execution);
      if(gate.action==='REVIEW_INCOMPLETE')throw fail('SYSTEM_REVIEW_PROTOCOL_INVALID','复评执行记录校验失败',{gate});
      return {gate,review,execution};
    }
    let reviewed;
    for(const cached of checkpoints.filter(c=>c.key===key&&c.validated===true&&c.validation_version===version&&c.fingerprint===fingerprint&&c.output_sha256===sha(c.output))){
      try{reviewed=validate(cached.output,cached.metadata);}catch{continue;}
      await checkpoint(cached);accepted.push(cached);reused.push({key,status:'REUSED'});update(stage,{reused:true});break;
    }
    if(!reviewed){
      let correction=repairs.find(r=>r.repair_key===key)?.reason||null;
      for(;;){
        update(stage);let response;const entry=repairs.find(r=>r.repair_key===key);
        if(entry){entry.state='IN_FLIGHT';update(stage,{repairs});}
        try{response=await provider.complete([{role:'system',content:selectedPrompt},{role:'user',content:JSON.stringify(correction?{...payload,repair:{validation_error:correction}}:payload)}]);}
        catch(error){if(entry){entry.state=error.details?.billing_status==='NOT_SENT'?'NOT_SENT':'UNKNOWN';update(stage,{repairs});}
          save('call-human-'+(calls.length+1)+'-failed',{key,error:error.message,details:error.details||null,response:error.model_response||null});throw error;}
        calls.push({key,...response});save('call-human-'+calls.length,{key,prompt_sha256:sha(selectedPrompt),input_sha256:sha(payload),...response});
        if(cancelled())throw fail('SYSTEM_CANCELLED','用户已停止；完整响应已保存，未继续调用');
        try{const raw=parseModelJson(response.content);reviewed=validate(raw,{context_id:contextId});
          const cp={key,fingerprint,validated:true,validation_version:version,output:raw,output_sha256:sha(raw),
            metadata:{model:provider.model,profile:continuationProfile(provider),context_id:contextId,stage,prompt_sha256:sha(selectedPrompt),input_sha256:sha(payload),packet_hash:packetHash(packet)}};
          if(entry){entry.state='VALIDATED';update(stage,{repairs});}
          try{await checkpoint(cp);}catch(error){throw fail('SYSTEM_CHECKPOINT_WRITE_FAILED','复评检查点保存失败，未自动重发：'+error.message);}
          accepted.push(cp);update(stage,{calls:calls.length,usage:response.usage});break;
        }catch(error){
          if(error.code==='SYSTEM_CHECKPOINT_WRITE_FAILED')throw error;
          if(!autoRepair||repairs.some(r=>r.repair_key===key))throw error;
          correction=error.message;repairs.push({stage:'claims_review',repair_key:key,attempt:1,reason:correction,state:'RESERVED'});update(stage,{repairs});
        }
      }
    }
    save('review-'+key,reviewed);
    gates.push({...reviewed.gate,issues:reviewed.gate.issues.map(issue=>({...issue,issue_id:batch.id+'_'+issue.issue_id,
      target:issue.target?.replace(/^\/claims\/(\d+)(?=\/|$)/,(_m,n)=>'/claims/'+batch.indices[Number(n)])}))});
    if(batch.schemaOnly&&reviewed.gate.action!=='ACCEPT_CANDIDATE')break;
  }
  const action=['NEEDS_USER','WAIT_EVIDENCE','REQUEST_REVISION'].find(a=>gates.some(g=>g.action===a))||'ACCEPT_CANDIDATE';
  const result={status:action==='ACCEPT_CANDIDATE'?'READY':'REVIEW_REQUIRED',review_stage:component&&gates[0]?.action!=='ACCEPT_CANDIDATE'?'schema_review':'claims_review',schema,claims,
    ...(component?{component_publication:component,pending_components:{predicate_ids:component.held_predicate_ids,cq_ids:component.held_cq_ids,origin_task_ids:[component.origin_task_id]}}:{}),
    gate:{action,reason:action==='ACCEPT_CANDIDATE'?'human_candidate_review_complete':'awaiting_human_review',issues:gates.flatMap(g=>g.issues)},
    calls,checkpoints:accepted,reused,repairs,human_decision_audit:session.audit,independently_verified:false,publication_approved:false,mode:'SHADOW'};
  if(result.status==='READY')result.answers=input.cqs.map(q=>({cq_id:q.id,question:q.question,...answerCQ(result,input,q.id)}));
  return result;
}
