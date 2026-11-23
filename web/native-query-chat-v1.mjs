/** Program-owned turn events, stable numbered evidence and Markdown delivery. */
import {hash,clone,need} from './cq-discovery-store-v2.mjs';
import {renderLightogChatMarkdown} from './lightog-chat-markdown-v1.mjs';
import {publicQueryEvent,publicAnswer,citationReadContext} from './native-query-delivery-view-v1.mjs';
import {createQueryIncremental} from './native-query-incremental-v3.mjs';
const TURN='native_query_chat_turn_v1',EVENT='native_query_chat_event_v1';
export const NATIVE_QUERY_CHAT_STORAGE=Object.freeze({turn:TURN,event:EVENT});
export function markdownCitationNumbers(text){
 // With an empty registry, the shared Markdown parser collects every marker as unknown.
 return renderLightogChatMarkdown(text).unknown_numbers;
}
export function createNativeQueryChat({store,queryId,conversationId,turnId,turnIndex,question,sourceScope,onEvent=()=>{},inherited=[],reservedThrough=0}){
 const prior=store.getRecord(TURN,queryId),scopeRef=hash(sourceScope);
 if(prior)need(hash(prior.source_scope)===scopeRef,'QUERY_CHAT_SCOPE_CHANGED');if(sourceScope.temporal_view_sha256)for(const entry of inherited)need(entry.query_scope_ref===scopeRef,'QUERY_CITATION_TEMPORAL_SCOPE_MISMATCH');
 if(!prior)store.putRecord(TURN,queryId,{query_id:queryId,conversation_id:conversationId,turn_id:turnId,turn_index:turnIndex,source_scope:clone(sourceScope),last_event_seq:0,messages:[],registry:clone(inherited),reserved_through:reservedThrough,final_markdown:null});
 const state=()=>store.getRecord(TURN,queryId);
 function publish(type,data,mutate=()=>{},notify=true){
  let event;store.transaction(()=>{const row=state();mutate(row);event=publicQueryEvent({version:'lightog-retrieval-chat/1',query_ref:queryId,query_id:queryId,conversation_id:conversationId,turn_id:turnId,seq:row.last_event_seq+1,type,at:Date.now(),data});row.last_event_seq=event.seq;store.putRecord(EVENT,queryId+':'+String(event.seq).padStart(10,'0'),event);store.putRecord(TURN,queryId,row);});
  if(notify)broadcast(event);return event;
 }
 function broadcast(event){try{onEvent(clone(event));}catch{}}
 function register(citation,{number=null,inheritedFrom=null}={}){
  if(sourceScope.temporal_view_sha256)need(citation.temporal_scope?.view_ref===sourceScope.view_ref&&citation.temporal_scope?.temporal_view_sha256===sourceScope.temporal_view_sha256&&hash(citation.temporal_scope?.temporal_selection)===hash(sourceScope.temporal_selection),'QUERY_CITATION_TEMPORAL_SCOPE_MISMATCH');
  const current=state(),existing=current.registry.find(r=>r.citation_ref===citation.citation_ref);if(existing)return existing;
  const n=number??Math.max(current.reserved_through,...current.registry.map(r=>r.number),0)+1;
  need(!current.registry.some(r=>r.number===n),'QUERY_CITATION_NUMBER_CONFLICT');
  const entry={...(sourceScope.temporal_view_sha256?{query_scope_ref:scopeRef,view_ref:sourceScope.view_ref}:{}),number:n,marker:'['+n+']',citation_ref:citation.citation_ref,citation:clone(citation),source_snapshot_ref:sourceScope.source_snapshot_ref,...(inheritedFrom?{inherited_from_query:inheritedFrom}:{})};
  publish('citation.registered',entry,row=>{row.registry.push(entry);row.reserved_through=Math.max(row.reserved_through,n);});return entry;
 }
 function projection(text){const row=state(),numbers=markdownCitationNumbers(text),used=numbers.map(n=>row.registry.find(c=>c.number===n)).filter(Boolean);return publicAnswer({format:'markdown',markdown:text,citations:used,citation_warnings:numbers.filter(n=>!row.registry.some(c=>c.number===n)).map(number=>({code:'QUERY_CITATION_NUMBER_UNISSUED',number,marker:'['+number+']'}))});}
 function partial(){const row=state();return projection(row.final_markdown??row.messages.map(m=>m.markdown).join('\n\n'));}
 function publicEvent(event){
  if(event.type!=='answer.delta'&&event.type!=='answer.replace')return;
  const {message_id}=event.data;need(typeof message_id==='string','QUERY_PUBLIC_MESSAGE_ID_INVALID');
  publish(event.type,event.data,row=>{let message=row.messages.find(m=>m.message_id===message_id);if(!message){message={message_id,markdown:''};row.messages.push(message);}if(event.type==='answer.delta')message.markdown+=event.data.delta;else message.markdown=event.data.markdown;});
 }
 function finish({markdown:text,message_id}){
  need(typeof text==='string'&&text.trim(),'QUERY_MARKDOWN_ANSWER_EMPTY');
  const row=state(),prior=row.messages.find(m=>m.message_id===message_id);
  if(!prior||prior.markdown!==text)publicEvent({type:'answer.replace',data:{message_id,markdown:text}});
  const next=state();next.final_markdown=text;store.putRecord(TURN,queryId,next);return projection(text);
 }
 if(!prior){publish('turn.created',{question});for(const entry of inherited)publish('citation.registered',entry);}
 return {publish,broadcast,register,partial,finish,publicEvent,state,events(after=0){const context=citationReadContext(queryId,sourceScope.source_snapshot_ref,state());return store.listRecords(EVENT).filter(e=>e.query_id===queryId&&e.seq>after).sort((a,b)=>a.seq-b.seq).map(e=>publicQueryEvent(e,context));}};
}

export function createMarkdownQueryTools({host,chat,operation,reader}){
 let complete=false;const incremental=createQueryIncremental({scope:reader.scope()}),navigationRequests=new Map();
 const executedStatuses=new Set(['READY','NO_MATCH','AMBIGUOUS','PARTIAL','NO_NEW_INFORMATION','STOPPED_NO_PROGRESS']);
 const definitions=host.definitions.filter(t=>t.name!=='lightog_submit_answer').map(t=>({...t,description:t.description.replaceAll('可直接提交的citation_refs','引用编号').replaceAll('可直接提交','可引用')}));
 const names=new Set(definitions.map(t=>t.name)),labels={find_entities:'定位实体',search_knowledge:'检索知识',get_entity_facts:'读取实体知识',expand_graph:'展开关联',find_paths:'查找关系路径',search_sources:'搜索资料',read_source:'读取资料',lightog_find_entities:'定位实体',lightog_search_facts:'检索知识',lightog_retrieve:'检索知识',lightog_search_sources:'搜索资料',lightog_read_evidence:'读取资料',lightog_get_entity_facts:'读取实体知识',lightog_expand_graph:'展开关联',lightog_find_paths:'查找关系路径',lightog_compute:'计算'};
 const annotate=value=>{if(Array.isArray(value))return value.map(annotate);if(!value||typeof value!=='object')return value;const next=Object.fromEntries(Object.entries(value).map(([k,v])=>[k,annotate(v)]));if(Array.isArray(value.citation_refs))next.citation_markers=value.citation_refs.map(ref=>chat.state().registry.find(c=>c.citation_ref===ref)?.marker).filter(Boolean);if(value.citation_ref){const entry=chat.state().registry.find(c=>c.citation_ref===value.citation_ref);if(entry){next.marker=entry.marker;next.number=entry.number;}}return next;};
 return {definitions,isComplete:()=>complete,snapshot:()=>host.snapshot(),async call(name,args,context){
  need(names.has(name),'QUERY_TOOL_FORBIDDEN');const step_id='step_'+hash([operation.state().query_id,chat.state().last_event_seq,name]).slice(0,16),label=labels[name]??'检索资料';
  chat.publish('tool.started',{step_id,tool_name:name,label});
  // Normalize only omitted optional empty strings; actual schemas and permissions remain authoritative.
  const schema=definitions.find(d=>d.name===name).inputSchema,normalized=Object.fromEntries(Object.entries(args??{}).filter(([key,value])=>!(value===''&&!schema.required?.includes(key)&&schema.properties?.[key]?.type==='string')));
  try{const result=await host.call(name,normalized),value=result?.result,execution=value?.execution??result?.execution??{},successful=result?.ok===true&&value&&executedStatuses.has(value.status)&&!result.error&&!value.error&&execution.executed!==false&&value.retrieval_executed!==false;
   if(successful)for(const citation of host.snapshot().citations??[])chat.register(citation);
   chat.publish('tool.completed',{step_id,tool_name:name,label,status:result?.ok===false?'FAILED':value?.status??'UNCONFIRMED',returned:successful?(value.items?.length??null):null,...(!successful?{execution:{...clone(execution),executed:execution.executed??(value?.status==='INVALID_ARGUMENTS'||value?.status==='UNAVAILABLE_CAPABILITY'||value?.retrieval_executed===false?false:null),succeeded:false,can_infer_absence:false}}:{})});const annotated=annotate(result);
   if(!successful){
    const failedExecution={...clone(execution),executed:execution.executed??(value?.status==='INVALID_ARGUMENTS'||value?.status==='UNAVAILABLE_CAPABILITY'||value?.retrieval_executed===false?false:null),succeeded:false,can_infer_absence:false,knowledge_coverage:'NOT_ESTABLISHED',note:'本次工具结果未建立成功读取，不能作为知识不存在或已覆盖的证明。'};
    if(annotated.result){const {delivery_coverage,incremental,...diagnostic}=annotated.result;annotated.result={...diagnostic,execution:failedExecution};}else annotated.execution=failedExecution;
    return annotated;
   }
   if(reader.verify){
    const short=value=>{
     if(Array.isArray(value))return value.map(short);
     if(!value||typeof value!=='object')return value;
     const {citation_ref,...fields}=value;
     return Object.fromEntries(Object.entries(fields).map(([key,field])=>[key,short(field)]));
    };
    return short(annotated);
   }
   if(annotated.result){
    const identity=row=>Object.fromEntries(['record_ref','subject_ref','surface','name','label','aliases','types','exact_match','source_refs'].filter(k=>row[k]!==undefined).map(k=>[k,row[k]]));
    if(name==='lightog_find_entities')annotated.result={...annotated.result,items:(annotated.result.items??[]).map(identity),identity_authenticated:false};
    if(annotated.result.entities)annotated.result.entities=annotated.result.entities.map(identity);
   }
   if(successful){
    const value=annotated.result,explicit=[normalized.entity_ref,...(normalized.subject_refs??[]),...(normalized.seed_refs??[])],located=[...(value.entities??[]).map(r=>r.subject_ref),...(name==='lightog_find_entities'?(value.items??[]).map(r=>r.subject_ref):[])],candidates=(value.items??[]).flatMap(r=>[r.subject_ref,r.object_ref]);
    const filters=Object.fromEntries(['source_refs','source_mode','kind','kinds','predicates','direction'].filter(k=>normalized[k]!==undefined).map(k=>[k,normalized[k]])),currentRequests=new Map();
    for(const subject_ref of [...explicit,...located,...candidates].filter(Boolean)){const key=hash([subject_ref,filters]);if(currentRequests.has(key))continue;const request={subject_ref,filters};currentRequests.set(key,request);navigationRequests.delete(key);navigationRequests.set(key,request);}
    annotated.result=incremental.project(value,{reread:name==='lightog_read_evidence'});
    const navigations=typeof host.knowledgeNavigation==='function'?[...currentRequests.values(),...[...navigationRequests.entries()].reverse().filter(([key])=>!currentRequests.has(key)).map(([,value])=>value)].slice(0,8).map(r=>incremental.navigation(host.knowledgeNavigation(r.subject_ref,r.filters))):[];
    annotated.result.delivery_coverage={...incremental.coverage(),navigation:navigations,navigation_truncated:navigationRequests.size>navigations.length,navigation_limit:8,returned_page:{items:value.items?.length??0,has_next_page:Boolean(value.next_cursor),truncated:Boolean(value.truncated)}};
   }return annotated;
  }catch(error){chat.publish('tool.completed',{step_id,tool_name:name,label,status:'FAILED',code:error.code??'QUERY_TOOL_FAILED'});throw error;}
 },finishMarkdown(input){
  const finish=()=>{reader.assertCurrent();operation.assertActive();const answer=chat.finish(input);operation.stageAnswer(answer);complete=true;return answer;};
  return reader.verify?reader.verify(operation.signal).then(finish):finish();
 }};
}
