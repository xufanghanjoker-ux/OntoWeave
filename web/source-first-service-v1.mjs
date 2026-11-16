/** Opt-in product host: trusted source/store projection and model I/O only.
 * Retrieval, evidence composition, draft/review parsing and final states are Rust. */
import {createHash,randomUUID} from 'node:crypto';
import {createSourceCore} from './source-core-client-v1.mjs';
import {createSourceAnswerTemplates} from './source-first-prompts-v1.mjs';
import {sourceKey} from './knowledge-governance.mjs';
import {knowledgeBases} from './knowledge-bases.mjs';
import {assertLibraryActive} from './library-management.mjs';
import {searchPayload} from './source-retrieval-projection-v1.mjs';
const clone=structuredClone;
const sort=v=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;
const textSha=v=>createHash('sha256').update(v).digest('hex');
const hash=v=>textSha(JSON.stringify(sort(v)));
const fail=code=>Object.assign(Error(code),{code});
const need=(ok,code)=>{if(!ok)throw fail(code);};
const STRICT_ANSWER_OUTPUT_POLICY='QWEN_JSON_SCHEMA_P4_V2';
// A provider-only subset: the frozen prepared schema/messages and every Rust
// validation input retain their original contracts and semantic decisions.
function strictAnswerTransport(prepared,{sourceEvidenceMenu,draft=null,requirementIds=[],dimensions=[]}){
 // Template schema nodes may share JS object identities. A JSON tree copy keeps
 // finite statement/evidence ID domains separate when tightening each path.
 const schema=JSON.parse(JSON.stringify(prepared.output_schema)),evidenceIds=[...new Set(sourceEvidenceMenu.map(row=>row.evidence_id))];
 function finiteArray(node,ids){
  if(ids.length)node.items.enum=clone(ids);
  else {node.maxItems=0;if(node.minItems)node.minItems=0;}
 }
 if(draft===null){
  finiteArray(schema.properties.statements.items.properties.evidence_ids,evidenceIds);
  if(!evidenceIds.length)schema.properties.statements.maxItems=0;
 }else{
  const statementIds=draft.statements.map(row=>row.statement_id),statement=schema.properties.statements.items.properties;
  if(statementIds.length)statement.statement_id.enum=clone(statementIds);
  for(const dimension of dimensions){
   const refs=statement.dimensions.properties[dimension].properties.evidence_ids;
   finiteArray(refs,evidenceIds);refs.minItems=1;
   refs.description='IDs of supplied source fragments actually checked for this dimension. For PARTIAL, UNSUPPORTED or UNKNOWN these are checked sources, not supporting evidence. SUPPORTED must use only this statement own cited source IDs. Citation alone does not establish support.';
  }
  for(const coverage of [schema.properties.question,schema.properties.requirements.items]){
   finiteArray(coverage.properties.statement_ids,statementIds);
   finiteArray(coverage.properties.evidence_ids,evidenceIds);
  }
  if(requirementIds.length)schema.properties.requirements.items.properties.requirement_id.enum=clone(requirementIds);
 }
 const messages=clone(prepared.messages),user=JSON.parse(messages[1].content);
 user.output_schema=schema;
 user.provider_output_guidance=draft===null
  ?'Use only the supplied source evidence IDs. The output constraint does not establish source entailment or permit invented supporting evidence.'
  :'For every statement and each of its nine dimensions, cite at least one supplied source fragment actually checked, including when the dimension is not applicable. For PARTIAL, UNSUPPORTED or UNKNOWN, a cited ID records inspected material and does not assert support. Preserve the evidence-based decision; never promote a decision to SUPPORTED to fill a citation. SUPPORTED still requires this statement own cited evidence and textual support. Question and requirement references may remain empty for an unknown or unsupported result.';
 messages[1].content=JSON.stringify(user);
 return{schema,messages};
}
const modelBinding=(role,p)=>p?{role,model:p.model,config_revision:p.config_revision,...(role==='embedding'?{model_revision:p.model_revision??null,dimensions:p.dimensions}:{}),binding_origin:'HOST_CURRENT_CONFIGURATION_NOT_REMOTE_AUTHENTICATION'}:null;
function bindings(models){
 const out={};for(const role of ['generation','embedding','reranker']){const p=models[role];if(p){need(typeof p.model==='string'&&p.model&&Number.isInteger(p.config_revision)&&p.config_revision>0,'SOURCE_MODEL_BINDING_INVALID');if(role==='embedding')need(Number.isInteger(p.dimensions)&&p.dimensions>0&&p.dimensions<=32768,'SOURCE_EMBEDDING_DIMENSIONS_REQUIRED');}out[role]=modelBinding(role,p);}return out;
}
function trustedDirectory(store,governance,libraryId){
 assertLibraryActive(store,libraryId);const state=governance.baseFor(libraryId);need(state,'SOURCE_LIBRARY_NOT_FOUND');
 const bases=knowledgeBases(store.listTasks()),base=bases.find(b=>b.id===libraryId);
 const taskIds=new Set(base?.task_ids??[]);if(state.head_task_id)taskIds.add(state.head_task_id);
 for(const c of store.listRecords('library_candidate'))if(c.base_id===libraryId)taskIds.add(c.task_id);
 const found=new Map();
 for(const id of taskIds){const job=store.getTask(id);for(const source of job?.input?.sources??[]){const key=sourceKey(source);if(state.sources[key]?.active)found.set(key,source);}}
 // Explicit directory records take precedence; uploads need not wait for a graph head.
 for(const row of store.listRecords('library_source'))if(row.base_id===libraryId&&state.sources[row.key]?.active){need(row.key===sourceKey(row.source),'SOURCE_DIRECTORY_KEY_CHANGED');found.set(row.key,row.source);}
 const entries=[];for(const [key,registered]of Object.entries(state.sources??{}).sort(([a],[b])=>a.localeCompare(b))){if(!registered.active)continue;const source=found.get(key);need(source,'SOURCE_DIRECTORY_TEXT_MISSING');need(typeof source.id==='string'&&source.id&&typeof source.content==='string'&&source.content.length&&source.content.isWellFormed(),'SOURCE_DIRECTORY_TEXT_INVALID');need(textSha(source.content)===registered.sha256&&(!source.sha256||source.sha256===registered.sha256),'SOURCE_DIRECTORY_HASH_CHANGED');entries.push({key,source:clone(source)});}
 need(entries.length>0,'SOURCE_DIRECTORY_EMPTY');need(new Set(entries.map(e=>e.source.id)).size===entries.length,'SOURCE_DIRECTORY_REF_AMBIGUOUS');
 return {state:clone(state),entries,head:state.head_task_id?store.getTask(state.head_task_id):null,seedTask:(state.head_task_id??base?.latest_task_id)?store.getTask(state.head_task_id??base.latest_task_id):null};
}
function sourceStamp(directory){return {base_id:directory.state.id,source_epoch:directory.state.source_epoch,source_catalog_sha256:hash(directory.entries.map(e=>({key:e.key,id:e.source.id,source_revision:e.source.source_revision??'source-key:'+e.key,sha256:textSha(e.source.content),original_sha256:e.source.parsing?.original_sha256??e.source.original_sha256??textSha(e.source.content),parser_version:e.source.parsing?.parser_version??e.source.parser_version??'plain-text/1'})))};}
export function createSourceFirstService({store,governance,core:injectedCore,coreBinary,expectedCoreSha256,models,reserveCall,readGraphSnapshot=()=>null,readEmbeddingBudget=({budgetId})=>store.getRecord('source_product_budget',budgetId),fineAnswerCitations=false,providerOutputDefault=false,strictAnswerOutputDefault=false}={}){
 need(store&&governance&&typeof models==='function'&&typeof reserveCall==='function'&&typeof readGraphSnapshot==='function'&&typeof readEmbeddingBudget==='function','SOURCE_SERVICE_HOST_REQUIRED');
 need(typeof fineAnswerCitations==='boolean','SOURCE_CITATION_POLICY_INVALID');
 need(typeof strictAnswerOutputDefault==='boolean','SOURCE_ANSWER_OUTPUT_POLICY_INVALID');
 const core=injectedCore??createSourceCore({coreBinary,expectedSha256:expectedCoreSha256??null});
 need(typeof core==='function','SOURCE_CORE_REQUIRED');const templates=createSourceAnswerTemplates({core});
 // A terminated process cannot execute a catch block: recover from durable pre-send records.
 store.transaction(()=>{const attempts=store.listRecords('attempt');for(const operation of store.listRecords('source_first_operation'))if(operation.status==='STARTED'&&attempts.some(a=>a.operation_id===operation.id&&['STARTED','INTERRUPTED','FAILED_UNKNOWN_NO_RETRY'].includes(a.status)))store.putRecord('source_first_unknown_guard',operation.input_sha256,{id:operation.input_sha256,library_id:operation.library_id,operation_id:operation.id,source_stamp:operation.source_stamp,status:'UNKNOWN_NO_AUTOMATIC_RESEND',recovered_from_started_attempt:true});});
 // Host observations only. Rust validates cache identity, vectors, lane batching and budget remaining.
 function embeddingBudgetInput(p){
  const scope={version:'lightog-source-product-budget/1',input:p.budgetInput,context:p.budgetContext,source_stamp:p.sourceStamp,snapshot:p.snapshot,models:p.modelBindings};
  const documentHashes=[...new Set(p.graphPayload.trusted_index.records.map(r=>textSha(r.text)))],queryHashes=[textSha(p.question)],observations=[];
  if(p.modelBindings.embedding)for(const [inputType,hashes]of [['document',documentHashes],['query',queryHashes]])for(const digest of hashes){const cacheId=hash({binding:p.modelBindings.embedding,input_type:inputType,text_sha256:digest});observations.push({cache_id:cacheId,cache:store.getRecord('source_first_vector',cacheId),pending:store.getRecord('source_first_vector_pending',cacheId)});}
  return{contract_version:'lightog-source-answer-budget/0.1',scope,document_text_sha256s:documentHashes,query_text_sha256s:queryHashes,cache_observations:observations};
 }
 function prepare({libraryId,question}){
  need(typeof question==='string'&&question.trim()&&question.length<=4096&&question.isWellFormed(),'SOURCE_QUESTION_INVALID');
  const d=trustedDirectory(store,governance,libraryId),stamp=sourceStamp(d),selected=models();need(selected&&typeof selected==='object','SOURCE_MODELS_REQUIRED');const modelBindings=bindings(selected);
  const sources=d.entries.map(({key,source})=>({source_ref:source.id,source_revision:source.source_revision??'source-key:'+key,original_sha256:source.parsing?.original_sha256??source.original_sha256??textSha(source.content),text_sha256:textSha(source.content),parser_version:source.parsing?.parser_version??source.parser_version??'plain-text/1'}));
  const sourceSnapshot={base_ref:libraryId,source_epoch:d.state.source_epoch,graph_revision:null,sources};
  const graph=readGraphSnapshot({libraryId,state:clone(d.state),sources:d.entries.map(e=>clone(e.source)),sourceSnapshot:clone(sourceSnapshot)});
  need(!graph||typeof graph.then!=='function','SOURCE_GRAPH_READER_MUST_BE_SYNCHRONOUS');
  const snapshot={...sourceSnapshot,graph_revision:graph?.graph_revision??null};if(graph)need(hash(graph.snapshot)===hash(snapshot),'SOURCE_GRAPH_SNAPSHOT_MISMATCH');
  const fragments=[],sourceTexts=[];
  for(const {source}of d.entries){const meta=sources.find(s=>s.source_ref===source.id),units=core('retrieval','extraction_units',{sources:[{id:source.id,content:source.content,sha256:meta.text_sha256}],options:{}});need(Array.isArray(units)&&units.length,'SOURCE_EXTRACTION_UNITS_MISSING');
   for(const u of units)fragments.push({id:'source_first_'+hash({source_ref:source.id,revision:meta.source_revision,start:u.start,end:u.end}).slice(0,32),origin:'SOURCE_FRAGMENT',source_ref:source.id,source_revision:meta.source_revision,block_ref:u.id,text_sha256:meta.text_sha256,span:{start:u.start,end:u.end,quote:u.text,offset_unit:'utf16_code_unit'},claim_refs:[],role:'PRIMARY'});
   sourceTexts.push({source_ref:source.id,source_revision:meta.source_revision,text:source.content,original_sha256:meta.original_sha256,parser_version:meta.parser_version,blocks:units.map(u=>({block_ref:u.id,start:u.start,end:u.end}))});
  }
  const evidenceSet={contract_version:'lightog-demand/0.1',evidence_set_id:'source_first_es_'+hash({snapshot,fragments}).slice(0,24),snapshot,fragments};
  let context={examples:{source_directory:evidenceSet},source_texts:sourceTexts,authority:{requests:[],allowed_snapshots:[snapshot],claims:[],receipts:[],scope_bindings:[],entities:[],predicate_refs:[],user_definitions:[],groups:[],entity_links:[]}};
  let evidenceSets=[evidenceSet],p2Build=null,graphStatus='UNAVAILABLE_DOCUMENT_ONLY',indexModelStatus='NOT_APPLICABLE_DOCUMENT_ONLY';
  if(graph){
   need(graph.p2Build&&graph.context&&Array.isArray(graph.evidence_sets??graph.evidenceSets),'SOURCE_GRAPH_PROJECTION_REQUIRED');
   context=clone(graph.context);context.examples={...context.examples,source_directory:evidenceSet};
   // Every read-projected source stamp must match the live host directory.
   need(hash(context.source_texts.map(r=>({source_ref:r.source_ref,source_revision:r.source_revision,text:r.text,original_sha256:r.original_sha256,parser_version:r.parser_version})).sort((a,b)=>a.source_ref.localeCompare(b.source_ref)))===hash(sourceTexts.map(r=>({source_ref:r.source_ref,source_revision:r.source_revision,text:r.text,original_sha256:r.original_sha256,parser_version:r.parser_version})).sort((a,b)=>a.source_ref.localeCompare(b.source_ref))),'SOURCE_GRAPH_CONTEXT_CHANGED');
   evidenceSets.push(...clone(graph.evidence_sets??graph.evidenceSets));p2Build=clone(graph.p2Build);graphStatus=graph.index_status==='READY'&&graph.index_ack?.status==='READY'&&graph.index_ack.graph_revision===graph.graph_revision&&graph.index_ack.index_payload_sha256===hash(graph.index)?'READ_PROJECTED_GRAPH_INDEX_READY':'READ_PROJECTED_GRAPH_INDEX_NOT_READY';
   if(graphStatus==='READ_PROJECTED_GRAPH_INDEX_READY'){if(graph.index_ack.mode==='LEXICAL')indexModelStatus='FORMAL_LEXICAL_INDEX_READY';else if(!modelBindings.embedding)indexModelStatus='LEXICAL_QUERY_EMBEDDING_DISABLED';else if(!Object.hasOwn(graph,'index_model_bindings')||graph.index_model_bindings===null){graphStatus='READ_PROJECTED_GRAPH_INDEX_BINDING_UNKNOWN';indexModelStatus='PERSISTED_INDEX_BINDING_UNKNOWN';}else if(hash(graph.index_model_bindings?.embedding??null)!==hash(modelBindings.embedding)){graphStatus='READ_PROJECTED_GRAPH_INDEX_SPACE_MISMATCH';indexModelStatus='CURRENT_SPACE_MISMATCH_REBUILD_REQUIRED';}else indexModelStatus='CURRENT_EMBEDDING_BINDING_MATCHES';}
  }
  for(const es of evidenceSets){need(hash(es.snapshot)===hash(snapshot),'SOURCE_MIXED_EVIDENCE_SNAPSHOT');core('p1_evidence','compose',{request:{bridge_version:'lightog-evidence-bridge/0.1',evidence_set_id:es.evidence_set_id,snapshot,source_fragments:es.fragments,legacy_claim_ids:[]},context,legacy_claims:[]});}
  const indexProjection=core('source_learning_v1','project_index_payload',{contract_version:'lightog-source-learning/0.1',validation_payload:searchPayload({question,context,evidenceSets,p2Build})});const graphPayload=indexProjection.validation_payload;const documentPayload=clone(graphPayload),documentIds=new Set(evidenceSet.fragments.map(f=>f.id));documentPayload.trusted_index.records=documentPayload.trusted_index.records.filter(r=>r.kind==='DOCUMENT'&&r.evidence_ids.every(id=>documentIds.has(id)));documentPayload.trusted_index.edges=[];
  core('source_first_routing','compose',{contract_version:'lightog-source-first-routing/0.1',document_request:documentPayload,graph_request:graphPayload,policy:{max_context_utf16:16000}});
  const budgetInput={sources:d.entries.map(e=>clone(e.source)),cqs:[{id:'source_first_question',question}],definitions:d.head?.input?.definitions??'',as_of:d.head?.input?.as_of??null};
  const budgetContext={operation:'ASK',task_id:d.state.head_task_id??null,question,...(fineAnswerCitations?{citation_policy:'FINE_SOURCE_STRUCTURAL_SUBSPANS_V1'}:{})};
  const output={version:'lightog-product-source-first-prepared/1',libraryId,question,head_task_id:d.state.head_task_id??null,cqSeeds:(d.seedTask?.input?.cqs??[]).map((q,i)=>({seed_id:q.id??'seed_'+i,text:q.question??q.text})),sourceStamp:stamp,snapshot,evidenceSet,context,evidenceSets,documentPayload,graphPayload,indexProjection:indexProjection.index_projection,graphStatus,indexModelStatus,modelBindings,budgetInput,budgetContext,sourceDirectory:d.entries.map(e=>({key:e.key,id:e.source.id,title:e.source.title,sha256:textSha(e.source.content)})),graphTrust:graph?.graph_trust?clone(graph.graph_trust):null,preview:{generation_upper_bound:2,embedding_upper_bound:0,reranker_upper_bound:selected.reranker?2:0,origin:'HOST_CURRENT_SOURCE_DIRECTORY',question_spec:null,graph_status:graphStatus,citation_policy:fineAnswerCitations?'FINE_SOURCE_STRUCTURAL_SUBSPANS_V1':'REGISTERED_ORIGINAL_RETRIEVAL_UNITS_NO_FINE_SPLITTING',automatic_retry:0}};
  output.embeddingPlan=core('source_answer_budget_v1','plan',embeddingBudgetInput(output));output.preview.embedding_upper_bound=output.embeddingPlan.required_embedding_batches;output.preview.embedding_document_batches=output.embeddingPlan.document_batches;output.preview.embedding_query_batches=output.embeddingPlan.query_batches;output.preview.embedding_cache_hits=output.embeddingPlan.cache_hits;output.preview.embedding_preflight_scope='CURRENT_CACHE_EMBEDDING_ONLY_NOT_GENERATION_OR_RERANKER';output.preview.embedding_plan_status=output.embeddingPlan.status;return output;
 }
 async function answer({libraryId,question,budgetId,requestId,confirmUnknownResend=false,onEvent=async()=>{}}){
  const execution=store.getRecord('source_product_execution',budgetId);
  const outputDefault=providerOutputDefault&&(!execution||execution.generation_output_policy==='PROVIDER_DEFAULT');
  need(typeof requestId==='string'&&/^[A-Za-z0-9_-]{1,96}$/.test(requestId),'SOURCE_REQUEST_ID_INVALID');need(typeof onEvent==='function','SOURCE_EVENT_HANDLER_INVALID');
  const prepared=prepare({libraryId,question}),selected=models();need(hash(bindings(selected))===hash(prepared.modelBindings),'SOURCE_MODEL_CONFIG_CHANGED');
  const id='sf_'+hash([libraryId,requestId]).slice(0,32),key=hash({libraryId,question,sourceStamp:prepared.sourceStamp,models:prepared.modelBindings});
  const baseOperationBinding=fineAnswerCitations?hash({base_input_sha256:key,citation_policy:'FINE_SOURCE_STRUCTURAL_SUBSPANS_V1'}):key;
  const operationBinding=strictAnswerOutputDefault?hash({base_input_sha256:baseOperationBinding,answer_output_policy:STRICT_ANSWER_OUTPUT_POLICY}):baseOperationBinding;
  const previous=store.getRecord('source_first_operation',id);
  if(previous){need(previous.input_sha256===operationBinding,'SOURCE_REQUEST_REPLAY_CHANGED');need(previous.status==='COMPLETED'&&previous.response,'SOURCE_REQUEST_ALREADY_STARTED_NO_RETRY');return {...clone(previous.response),deduplicated:true};}
  const priorGuard=store.getRecord('source_first_unknown_guard',key);need(!priorGuard||!['STARTED_BEFORE_PROVIDER','UNKNOWN_NO_AUTOMATIC_RESEND'].includes(priorGuard.status)||confirmUnknownResend===true,'SOURCE_PREVIOUS_PROVIDER_OUTCOME_UNKNOWN_CONFIRMATION_REQUIRED');
  store.putRecord('source_first_operation',id,{id,library_id:libraryId,request_id:requestId,input_sha256:operationBinding,status:'STARTED',source_stamp:prepared.sourceStamp,created_at:new Date().toISOString()});
  const errors=[],providerAttempts=[];let unknown=false,sourceInvalid=false,draft=null,reviewPrepared=null,review=null,p4Prepared=null,retrieval=null,embeddingPreflight=null,stage='RETRIEVAL',answerContext=prepared.context,citationRefinement=null;
  function current(){const actual=sourceStamp(trustedDirectory(store,governance,libraryId));need(hash(actual)===hash(prepared.sourceStamp),'SOURCE_WITHDRAWN_OR_VERSION_DRIFT');need(hash(bindings(models()))===hash(prepared.modelBindings),'SOURCE_MODEL_CONFIG_CHANGED');return true;}
  async function send(role,phase,args,invoke){
   current();const attemptId=randomUUID(),binding=prepared.modelBindings[role];need(binding,'SOURCE_MODEL_NOT_CONFIGURED');
   const scope={budgetId,budgetInput:prepared.budgetInput,budgetContext:prepared.budgetContext,capability:role==='generation'?'generation':role==='embedding'?'embedding':'reranker',phase,requestId:attemptId,modelBinding:binding,sourceStamp:prepared.sourceStamp,...args};
   const attempt={id:attemptId,operation_id:id,task_id:prepared.head_task_id,budget_id:budgetId,phase,capability:scope.capability,model:binding.model,config_revision:binding.config_revision,status:'STARTED',started_at:new Date().toISOString(),usage:null,usage_status:'UNKNOWN'};
   try{const reservation=reserveCall(scope);need(!reservation||typeof reservation.then!=='function','SOURCE_BUDGET_RESERVATION_MUST_BE_SYNCHRONOUS');current();}catch(error){attempt.status='BLOCKED_NOT_SENT';attempt.error_code=error.code??'SOURCE_BUDGET_BLOCKED';store.putRecord('attempt',attemptId,attempt);throw error;}
   store.transaction(()=>{store.putRecord('attempt',attemptId,attempt);store.putRecord('source_first_unknown_guard',key,{id:key,library_id:libraryId,operation_id:id,attempt_id:attemptId,source_stamp:prepared.sourceStamp,status:'STARTED_BEFORE_PROVIDER'});});providerAttempts.push(attempt);let received=false;
   try{const response=await invoke(attemptId);received=true;store.archiveRecord('source_first_response',attemptId,response);store.putRecord('source_first_response',attemptId,{library_id:libraryId,operation_id:id,attempt_id:attemptId,response_sha256:hash(response),payload_location:'IMMUTABLE_ARCHIVE'});attempt.status='COMPLETED';attempt.usage=response?.usage_raw??response?.usage??null;attempt.usage_status=attempt.usage?'REPORTED':'UNKNOWN';current();return response;}
   catch(error){const notSent=error?.details?.billing_status==='NOT_SENT',known=received||Boolean(error?.model_response)||error?.provider_response_received===true;attempt.status=notSent?'BLOCKED_NOT_SENT':known?'RETURNED_REJECTED':'FAILED_UNKNOWN_NO_RETRY';attempt.error_code=error.code??'SOURCE_MODEL_REQUEST_FAILED';if(received&&error&&typeof error==='object')error.provider_response_received=true;if(!notSent&&!known)unknown=true;throw error;}
   finally{attempt.finished_at=new Date().toISOString();store.transaction(()=>{store.putRecord('attempt',attemptId,attempt);store.putRecord('source_first_unknown_guard',key,{id:key,library_id:libraryId,operation_id:id,attempt_id:attemptId,source_stamp:prepared.sourceStamp,status:attempt.status==='FAILED_UNKNOWN_NO_RETRY'?'UNKNOWN_NO_AUTOMATIC_RESEND':'KNOWN_RETURNED_OR_NOT_SENT'});});}
  }
  async function embeddings(texts,inputType){
   const p=selected.embedding,binding=prepared.modelBindings.embedding,result=new Map(),pending=[];
   for(const text of new Set(texts)){const cacheId=hash({binding,input_type:inputType,text_sha256:textSha(text)}),row=store.getRecord('source_first_vector',cacheId);if(row){need(row.text_sha256===textSha(text)&&hash(row.binding)===hash(binding)&&row.input_type===inputType&&Array.isArray(row.values)&&row.values.length===p.dimensions&&row.values.every(Number.isFinite)&&row.values.some(x=>x!==0)&&row.completed_attempt_id,'SOURCE_VECTOR_CACHE_CHANGED');result.set(text,row.values);}else pending.push({text,cacheId});}
   for(let n=0;n<pending.length;n+=20){const batch=pending.slice(n,n+20),input=batch.map(r=>r.text);let sentId;
    for(const row of batch){const prior=store.getRecord('source_first_vector_pending',row.cacheId);need(!prior||!['STARTED','UNKNOWN_NO_AUTOMATIC_RESEND'].includes(prior.status)||confirmUnknownResend===true,'SOURCE_EMBEDDING_OUTCOME_UNKNOWN_CONFIRMATION_REQUIRED');}
    try{
     const response=await send('embedding','SOURCE_'+inputType.toUpperCase()+'_EMBEDDING',{textCount:input.length,inputUtf16:input.reduce((n,t)=>n+t.length,0)},request_id=>{sentId=request_id;store.transaction(()=>{for(const row of batch)store.putRecord('source_first_vector_pending',row.cacheId,{id:row.cacheId,binding,input_type:inputType,text_sha256:textSha(row.text),attempt_id:request_id,status:'STARTED'});});return p.embed(input,{input_type:inputType,request_id});});
     need(Array.isArray(response.vectors)&&response.vectors.length===input.length&&(!response.dimensions||response.dimensions===p.dimensions),'SOURCE_EMBEDDING_RESPONSE_INVALID');
     for(const values of response.vectors)need(Array.isArray(values)&&values.length===p.dimensions&&values.every(Number.isFinite)&&values.some(x=>x!==0),'SOURCE_EMBEDDING_RESPONSE_INVALID');
     store.transaction(()=>{response.vectors.forEach((values,i)=>{const row={id:batch[i].cacheId,binding,input_type:inputType,text_sha256:textSha(input[i]),values,completed_attempt_id:sentId};store.putRecord('source_first_vector',row.id,row);store.putRecord('source_first_vector_pending',row.id,{id:row.id,attempt_id:sentId,status:'COMPLETED'});result.set(input[i],values);});});
    }catch(error){if(sentId)store.transaction(()=>{for(const row of batch)store.putRecord('source_first_vector_pending',row.cacheId,{id:row.cacheId,attempt_id:sentId,status:error.provider_response_received||error.code==='SOURCE_EMBEDDING_RESPONSE_INVALID'?'RETURNED_REJECTED':error.details?.billing_status==='NOT_SENT'?'BLOCKED_NOT_SENT':'UNKNOWN_NO_AUTOMATIC_RESEND'});});throw error;}
   }return result;
  }
  function attach(payload,docVectors,queryValues){
   const p=selected.embedding,groups=new Map();for(const r of payload.trusted_index.records){const component=r.kind==='DOCUMENT'?'CHUNK':r.kind;if(!groups.has(component))groups.set(component,[]);groups.get(component).push(r);}
   payload.trusted_index.context=clone(payload.trusted_index.context);const authority=payload.trusted_index.context.authority;authority.active_indexes=[];payload.trusted_index.manifests=[];payload.query_vectors=[];
   for(const [component,records]of groups){const space={provider:'HOST_CONFIGURED_SERVICE',model:p.model,model_revision:p.model_revision??null,dimensions:p.dimensions,normalization:'NONE',distance:'COSINE',text_policy:'source-first-product-original-records/1',tokenizer_version:'PROVIDER_MANAGED_VERSION_UNKNOWN'},indexId='sfi_'+hash({component,snapshot:payload.snapshot,space,texts:records.map(r=>textSha(r.text))}).slice(0,24),manifest={contract_version:'lightog-knowledge/0.2',index_id:indexId,index_revision:'v1',component,snapshot:payload.snapshot,vector_space:space,status:'ACTIVE',records_total:records.length,vectors_completed:records.length,build_receipt_ref:'build_'+indexId};
    const receipt={receipt_ref:manifest.build_receipt_ref,kind:'INDEX_BUILD',status:'COMPLETE',index_id:indexId,index_revision:'v1',component,snapshot_sha256:hash(payload.snapshot),vector_space_sha256:hash(space),records_total:records.length,vectors_completed:records.length};authority.receipts.push(receipt);authority.active_indexes.push(manifest);payload.trusted_index.manifests.push(manifest);
    for(const r of records)r.embedding={index_id:indexId,values:docVectors.get(r.text),text_sha256:textSha(r.text)};
    payload.query_vectors.push({component,index_id:indexId,vector_space:space,query_text_sha256:textSha(question),values:queryValues});
   }return payload;
  }
  const rankCache=new Map();
  const retrievalWarnings=[];
  async function ranked(payload){let out=core('p3_retrieval','search',payload);if(!selected.reranker||!out.trace.pre_rerank_candidate_ids.length)return {payload,result:out};
   const candidateIds=out.trace.pre_rerank_candidate_ids,records=new Map(payload.trusted_index.records.map(r=>[r.id,r]));let response=rankCache.get(out.trace.candidate_set_sha256);
   try{
    if(!response){const documents=candidateIds.map(id=>records.get(id).text);response=await send('reranker','SOURCE_EVIDENCE_RERANK',{textCount:documents.length,inputUtf16:question.length+documents.reduce((n,t)=>n+t.length,0)},request_id=>selected.reranker.rerank(question,documents,{top_n:documents.length,request_id}));rankCache.set(out.trace.candidate_set_sha256,response);}
    if(response.known_failed)throw Object.assign(fail(response.error_code),{provider_response_received:true});
    need(Array.isArray(response.scores)&&response.scores.length===candidateIds.length,'SOURCE_RERANK_RESPONSE_INVALID');const seen=new Set();const scores=response.scores.map(r=>{need(Number.isInteger(r.index)&&r.index>=0&&r.index<candidateIds.length&&!seen.has(r.index)&&Number.isFinite(r.score),'SOURCE_RERANK_RESPONSE_INVALID');seen.add(r.index);return {record_id:candidateIds[r.index],score:r.score};});
    payload.rerank={status:'COMPLETE',model:selected.reranker.model,candidate_set_sha256:out.trace.candidate_set_sha256,scores};
   }catch(error){if(!(error.provider_response_received||error.model_response||error.code==='SOURCE_RERANK_RESPONSE_INVALID'))throw error;rankCache.set(out.trace.candidate_set_sha256,{known_failed:true,error_code:error.code??'SOURCE_RERANK_KNOWN_FAILURE'});payload.rerank={status:'FAILED',model:selected.reranker.model,candidate_set_sha256:out.trace.candidate_set_sha256,scores:[]};retrievalWarnings.push({capability:'reranker',code:error.code??'SOURCE_RERANK_KNOWN_FAILURE',fallback:'RUST_RRF',retry:0});}
   out=core('p3_retrieval','search',payload);return {payload,result:out};
  }
  async function emit(event,data){current();await onEvent({event,operation_id:id,...clone(data)});}
  try{
   if(selected.embedding){stage='EMBEDDING_PREFLIGHT';current();const input=embeddingBudgetInput(prepared);embeddingPreflight={...core('source_answer_budget_v1','plan',input),admission:'NOT_VALIDATED'};const budget=readEmbeddingBudget({budgetId,prepared});need(!budget||typeof budget.then!=='function','SOURCE_EMBEDDING_BUDGET_READ_MUST_BE_SYNCHRONOUS');try{embeddingPreflight={...core('source_answer_budget_v1','validate',{...input,budget}),admission:'ADMITTED'};}catch(error){embeddingPreflight={...embeddingPreflight,admission:'REJECTED',error_code:error.code??'SOURCE_EMBEDDING_PREFLIGHT_REJECTED',billing_status:'NOT_SENT'};throw Object.assign(error,{details:{...error.details,billing_status:'NOT_SENT'}});}current();stage='RETRIEVAL';}
   let doc=clone(prepared.documentPayload),graph=clone(prepared.graphPayload);
   if(selected.embedding){const docs=await embeddings(graph.trusted_index.records.map(r=>r.text),'document'),queries=await embeddings([question],'query');doc=attach(doc,docs,queries.get(question));graph=attach(graph,docs,queries.get(question));}
   const document=await ranked(doc),navigation=await ranked(graph);retrieval=core('source_first_routing','compose',{contract_version:'lightog-source-first-routing/0.1',document_request:document.payload,graph_request:navigation.payload,policy:{max_context_utf16:16000}});
   current();let evidenceSet={contract_version:'lightog-demand/0.1',evidence_set_id:'source_first_answer_'+hash({snapshot:retrieval.snapshot,contexts:retrieval.contexts}).slice(0,24),snapshot:retrieval.snapshot,fragments:retrieval.contexts};
   if(prepared.graphTrust?.usage==='NAVIGATION_ONLY'){
    // Candidate descriptions guide retrieval; they are never answer authority.
    // Keep validated source block aliases so fine spans retain their true origin.
    need(evidenceSet.fragments.every(f=>f.origin==='SOURCE_FRAGMENT'&&Array.isArray(f.claim_refs)&&f.claim_refs.length===0),'SOURCE_ONLY_EVIDENCE_REQUIRED');
    answerContext={source_texts:clone(prepared.context.source_texts),examples:{[evidenceSet.evidence_set_id]:clone(evidenceSet)},authority:{requests:[],allowed_snapshots:[clone(prepared.snapshot)],claims:[],receipts:[],scope_bindings:[],entities:[],predicate_refs:[],user_definitions:[],groups:[],entity_links:[]}};
   }
   if(fineAnswerCitations){stage='CITATION_REFINEMENT';const refined=core('fine_source_evidence','refine',{contract_version:'lightog-fine-source-evidence/0.1',evidence_set:evidenceSet,context:answerContext});citationRefinement=refined.receipt;answerContext=clone(answerContext);answerContext.examples[refined.evidence_set.evidence_set_id]=clone(refined.evidence_set);evidenceSet=refined.evidence_set;}
   p4Prepared=templates.prepareSourceFirstAnswer({question,evidenceSet,context:answerContext,questionSpec:null});const plan=core('source_answer','plan',{prepared:p4Prepared,context:answerContext});
   await emit('sources',{source_evidence:p4Prepared.source_evidence_menu,snapshot:prepared.snapshot,verification:'SOURCE_LOCATIONS_VALIDATED_NOT_ANSWERED',transport:'BUFFERED_COMPLETE'});
   if(plan.allow_generation){need(selected.generation&&typeof selected.generation.complete==='function','SOURCE_GENERATION_NOT_CONFIGURED');
    stage='ANSWER_GENERATION';const answerTransport=strictAnswerOutputDefault?strictAnswerTransport(p4Prepared,{sourceEvidenceMenu:p4Prepared.source_evidence_menu}):null;const answerFormat=answerTransport?core('provider_schema_v1','compile_qwen',{contract_version:'lightog-provider-schema/0.1',name:'source_answer_generation',schema:answerTransport.schema}).response_format:null;const proposed=await send('generation',stage,{maxTokens:outputDefault?null:5000},request_id=>selected.generation.complete(answerTransport?.messages??p4Prepared.messages,{...(outputDefault?{}:{max_tokens:5000}),enable_thinking:false,request_id,phase:stage,...(answerFormat?{response_format:answerFormat}:{})}));need(!['length','max_tokens'].includes(proposed.finish_reason),'SOURCE_ANSWER_TRUNCATED');draft=core('source_answer','draft',{prepared:p4Prepared,context:answerContext,raw:proposed.content});
    reviewPrepared=templates.prepareIndependentAnswerReview(p4Prepared,draft);stage='ANSWER_REVIEW';const reviewTransport=strictAnswerOutputDefault?strictAnswerTransport(reviewPrepared,{sourceEvidenceMenu:p4Prepared.source_evidence_menu,draft,requirementIds:p4Prepared.manifest.requirement_ids,dimensions:templates.DIMENSIONS}):null;const reviewFormat=reviewTransport?core('provider_schema_v1','compile_qwen',{contract_version:'lightog-provider-schema/0.1',name:'source_answer_review',schema:reviewTransport.schema}).response_format:null;const checked=await send('generation',stage,{maxTokens:outputDefault?null:8000},request_id=>selected.generation.complete(reviewTransport?.messages??reviewPrepared.messages,{...(outputDefault?{}:{max_tokens:8000}),enable_thinking:false,request_id,phase:stage,...(reviewFormat?{response_format:reviewFormat}:{})}));need(!['length','max_tokens'].includes(checked.finish_reason),'SOURCE_ANSWER_TRUNCATED');review=core('source_answer','review',{prepared:p4Prepared,context:answerContext,draft,review_prepared:reviewPrepared,raw:checked.content});
   }
  }catch(error){errors.push({stage,code:error.code??'SOURCE_FIRST_STAGE_FAILED'});try{current();}catch{sourceInvalid=true;}}
  try{current();}catch(error){sourceInvalid=true;errors.push({stage:'BEFORE_RETURN',code:error.code??'SOURCE_CHECK_FAILED'});}
  let response;
  if(p4Prepared){const answer=core('source_answer','final',{prepared:p4Prepared,context:answerContext,answer_id:id,draft,review_prepared:reviewPrepared,review,errors,source_invalid:sourceInvalid});
   for(const [index,block]of answer.statements.entries()){try{await emit('answer_block',{index,block,verification:answer.verification.verdict,transport:'BUFFERED_COMPLETE'});}catch(error){sourceInvalid=true;errors.push({stage:'BEFORE_ANSWER_BLOCK',code:error.code??'SOURCE_CHECK_FAILED'});break;}}
   try{current();}catch(error){sourceInvalid=true;errors.push({stage:'BEFORE_FINAL_RESPONSE',code:error.code??'SOURCE_CHECK_FAILED'});}
   const finalAnswer=sourceInvalid?core('source_answer','final',{prepared:p4Prepared,context:answerContext,answer_id:id,draft,review_prepared:reviewPrepared,review,errors,source_invalid:true}):answer;response={status:finalAnswer.status,answer:finalAnswer};
  }else response={status:sourceInvalid?'SOURCE_INVALIDATED':'SOURCE_FIRST_UNAVAILABLE',answer:null};
  response={...response,...(prepared.graphTrust?{graph_trust:clone(prepared.graphTrust),answer_authority:'SOURCE_ONLY_CANDIDATE_GRAPH_NAVIGATION'}:{}),...(fineAnswerCitations?{citation_policy:'FINE_SOURCE_STRUCTURAL_SUBSPANS_V1',citation_refinement:sourceInvalid?null:citationRefinement}:{}),retrieval_warnings:retrievalWarnings,operation_id:id,library_id:libraryId,task_id:prepared.head_task_id,source_stamp:prepared.sourceStamp,graph_status:prepared.graphStatus,index_model_status:prepared.indexModelStatus,index_projection:prepared.indexProjection,embedding_preflight:embeddingPreflight,retrieval_trace:retrieval?.trace??null,retrieval_lanes:retrieval?{document:retrieval.document_result.trace,graph:retrieval.graph_result.trace}:null,errors,provider_outcome_unknown:unknown,provider_attempts:providerAttempts.length,transport:'BUFFERED_COMPLETE',question_spec:null,publication_performed:false,legacy_claims_created:0};
  if(unknown)store.putRecord('source_first_unknown_guard',key,{id:key,library_id:libraryId,operation_id:id,source_stamp:prepared.sourceStamp,status:'UNKNOWN_NO_AUTOMATIC_RESEND',at:new Date().toISOString()});
  store.putRecord('source_first_operation',id,{id,library_id:libraryId,request_id:requestId,input_sha256:operationBinding,status:'COMPLETED',response,source_stamp:prepared.sourceStamp,finished_at:new Date().toISOString()});return response;
 }
 return {prepare,answer};
}
