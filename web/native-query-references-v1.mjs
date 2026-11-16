/** Isolated typed ID registration for saved extracted graph records. Host authorization is unchanged. */
/** Agent-facing reference aliases only. Host records, schemas and provenance stay authoritative. */
import {hash,clone,need,textField} from './cq-discovery-store-v2.mjs';

const KIND='native_query_product_references_v1',VERSION='native-query-product-references/1';
const PROTECTED=new Set([
  'local_ref','local_refs','question','representative_question','text','quote','statement','surface','notes','reason',
  'raw_value','rule_text','title','heading','table_header','label','name','description','requirement','knowledge_need',
  'knowledge_requirement','source_hint','source_unknown_reason','conditions','predicate','attribute','unit','module',
  'time_text','version_text','value_text','content','instructions'
]);
// Canonical validation digests are values to compare, never business references.
const digestField=key=>/^(?:hash|hashes|sha256|binding)$/.test(key)||/_(?:sha256|hash|hashes)$/.test(key);
const fieldReference=key=>/^(?:id|ids|ref|refs|revision|revisions|version|versions|cursor|cursors)$/.test(key)||
  /_(?:ref|refs|id|ids|revision|revisions|version|versions|cursor|cursors)$/.test(key);
const opaque=value=>typeof value==='string'&&value.length>=24&&!/\s/u.test(value);
const aliasLike=value=>typeof value==='string'&&value.startsWith('ref_');
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const dictionaryField=key=>key==='mapping'||/(?:_by_ref|_by_id|_map|_bindings)$/.test(key);
const referenceKey=(name,parent,state)=>opaque(name)&&(dictionaryField(parent)||state.entries.some(row=>row.value===name)||/[a-f0-9]{24}/i.test(name)||/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(name));
function category(key,value){
  if(/(?:^|_)citation_refs?$/.test(key))return 'L';
  // Published field semantics take precedence over opaque value spelling.
  // A document identifier containing "fact" is still a document reference.
  if(/(?:^|_)calculation_refs?$/.test(key))return 'C';
  if(/(?:^|_)evidence_refs?$/.test(key))return 'E';
  if(/(?:^|_)fact_refs?$/.test(key))return 'K';
  if(/^(?:doc_ref|source_refs|allowed_doc_refs)$/.test(key))return 'D';
  if(/^(?:subject_refs?|entity_ref|seed_refs|from_ref|to_ref)$/.test(key))return 'P';
  if(key==='block_refs'||key==='block_ref')return 'B';
  if(key==='cursor'||key==='next_cursor')return 'N';
  const hint=key+' '+value.slice(0,30);
  if(/cursor/.test(hint))return 'N';
  if(/revision|version|sha256|hash|binding/.test(key))return 'V';
  if(/calculation/.test(hint))return 'C';
  if(/snapshot/.test(hint))return 'S';
  if(/manifest/.test(hint))return 'M';
  if(/read_receipt|cq_read_/.test(hint))return 'R';
  if(/evidence/.test(hint))return 'E';
  if(/candidate/.test(hint))return 'C';
  if(/task/.test(hint))return 'T';
  if(/(?:cq|member)_|native_cq_/.test(hint))return 'Q';
  if(/family/.test(hint))return 'F';
  if(/fact/.test(hint))return 'K';
  if(/doc|document/.test(hint))return 'D';
  if(/subject|entity|seed|from_ref|to_ref/.test(hint))return 'P';
  if(/block/.test(hint))return 'B';
  if(/unit/.test(hint))return 'U';
  if(/window/.test(hint))return 'W';
  return 'I';
}
const bodyOf=state=>{const {manifest_sha256,...body}=state;return body;};

export function createNativeAgentReferences({store,runId,role,tools,prompt,referenceKinds={},answerFormat='structured'}){
  need(textField(runId)&&textField(role)&&typeof prompt==='string'&&Array.isArray(tools?.definitions)&&typeof tools.call==='function','NATIVE_REFERENCE_INPUT_INVALID');
  const key=hash({runId,role}),binding=hash({version:VERSION,runId,role,referenceKinds,prompt,definitions:tools.definitions});
  function load(){
    const state=store.getRecord(KIND,key);
    need(state&&state.binding===binding&&state.run_id===runId&&state.role===role&&state.manifest_sha256===hash(bodyOf(state)),'NATIVE_REFERENCE_MANIFEST_CHANGED');
    need(new Set(state.entries.map(row=>row.alias)).size===state.entries.length&&new Set(state.entries.map(row=>row.value)).size===state.entries.length,'NATIVE_REFERENCE_MANIFEST_CHANGED');
    return state;
  }
  function persist(state){return store.putRecord(KIND,key,{...bodyOf(state),manifest_sha256:hash(bodyOf(state))});}
  store.transaction(()=>{
    const existing=store.getRecord(KIND,key);
    if(existing){load();return;}
    const full=hash({version:VERSION,runId,role});let length=6,scope=full.slice(0,length);
    const scopes=store.listRecords(KIND);
    while(scopes.some(row=>row.scope===scope)){length+=2;need(length<=full.length,'NATIVE_REFERENCE_SCOPE_COLLISION');scope=full.slice(0,length);}
    persist({version:VERSION,run_id:runId,role,scope,binding,raw_prompt_hash:hash(prompt),definitions_hash:hash(tools.definitions),entries:[],counters:{}});
  });
  function encodeValue(value,keyName,state){
    if(!opaque(value))return value;
    const existing=state.entries.find(row=>row.value===value);if(existing)return existing.alias;
    need(!aliasLike(value),'NATIVE_REFERENCE_HOST_ALIAS_INVALID');
    const type=expectedCategory(keyName)??referenceKinds[value]??category(keyName,value),number=(state.counters[type]??0)+1;
    state.counters[type]=number;
    const alias='ref_'+state.scope+'_'+type+number;
    state.entries.push({alias,value,category:type});return alias;
  }
  function expectedCategory(key){
    if(/(?:^|_)citation_refs?$/.test(key))return 'L';
    if(/(?:^|_)evidence_refs?$/.test(key))return 'E';
    if(/(?:^|_)fact_refs?$/.test(key))return 'K';
    if(/(?:^|_)calculation_refs?$/.test(key))return 'C';
    if(/^(?:doc_ref|source_refs|allowed_doc_refs)$/.test(key))return 'D';
    if(/^(?:subject_refs?|entity_ref|seed_refs|from_ref|to_ref)$/.test(key))return 'P';
    if(key==='block_refs')return 'B';if(key==='cursor')return 'N';return null;
  }
  function decodeValue(value,state,keyName){
    if(!aliasLike(value))return value;
    const entry=state.entries.find(row=>row.alias===value);
    need(entry,'NATIVE_REFERENCE_ALIAS_FORBIDDEN');return entry.value;
  }
  function transform(value,keyName,state,direction,authority=false){
    if(PROTECTED.has(keyName)||/(?:^|_)local_refs?$/.test(keyName)||digestField(keyName))return clone(value);
    const isAuthority=authority||fieldReference(keyName);
    if(typeof value==='string'){
      if(!isAuthority)return value;
      if(direction==='ENCODE')return encodeValue(value,keyName,state);
      if(aliasLike(value)){
        const entry=state.entries.find(row=>row.alias===value),expected=expectedCategory(keyName);
        if(entry&&expected&&entry.category!==expected)throw Object.assign(Error('QUERY_REFERENCE_ALIAS_TYPE_MISMATCH'),{code:'QUERY_REFERENCE_ALIAS_TYPE_MISMATCH',field:keyName,expected_category:expected,actual_category:entry.category});
      }
      return decodeValue(value,state,keyName);
    }
    if(Array.isArray(value))return value.map(item=>transform(item,keyName,state,direction,isAuthority));
    if(!record(value))return value;
    const entries=Object.entries(value).map(([name,item])=>{
      // Dynamic dictionaries (e.g. family mapping / fact bindings) also carry
      // authoritative references as keys. Semantic subtrees returned above are untouched.
      let mapped=name;
      if(direction==='ENCODE'&&referenceKey(name,keyName,state))mapped=encodeValue(name,keyName,state);
      else if(direction==='DECODE'&&aliasLike(name)&&(dictionaryField(keyName)||/^ref_[a-f0-9]{6,64}_[A-Z]\d+$/.test(name)))mapped=decodeValue(name,state);
      return [mapped,transform(item,name,state,direction,false)];
    });
    need(new Set(entries.map(([name])=>name)).size===entries.length,'NATIVE_REFERENCE_KEY_COLLISION');
    return Object.fromEntries(entries);
  }
  function encode(value){return store.transaction(()=>{const state=load(),encoded=transform(value,'',state,'ENCODE');persist(state);return encoded;});}
  function decode(value){return transform(value,'',load(),'DECODE');}
  const encodedPrompt=store.transaction(()=>{
    const state=load();
    const result=prompt.split(/(\r?\n)/).map(line=>{
      const trimmed=line.trim();if(!trimmed.startsWith('{')&&!trimmed.startsWith('['))return line;
      let json;try{json=JSON.parse(trimmed);}catch{return line;}
      const prefix=line.slice(0,line.indexOf(trimmed));
      return prefix+JSON.stringify(transform(json,'',state,'ENCODE'))+line.slice(line.indexOf(trimmed)+trimmed.length);
    }).join('');
    persist(state);return (answerFormat==='markdown'?'工具中的短名仅用于检索导航；使用实际返回的对应主体、文档、证据或游标，不猜编号。正文引用只用citation_markers给出的[n]，不输出导航短名，不填写答案JSON。source_refs只接收实际doc_ref，省略表示当前授权库。\n':'本角色工具和JSON输入中的 ref_'+state.scope+'_ 短名由Host发放。类型：L=可直接提交的完整citation引用包，D=文档，E=原文证据，K=结构事实，P=主体，C=计算，B=块，V=版本，N=分页游标；S/M=运行快照/视图，不是文档或证据。字段类型不可混用；保留实际短名，不猜或自造。source_refs只接收D类doc_ref，省略表示全当前授权库；question/quote/条件等业务文本照录不改。短名不授予身份或额外权限。\n')+result;
  });
  const feedback=[];
  const wrapped={...tools,definitions:tools.definitions,async call(name,args,context){
    let decoded;try{decoded=decode(args??{});}catch(error){
      const code=error.code??'NATIVE_REFERENCE_DECODE_FAILED',key=hash({name,args}),repeated=feedback.some(row=>row.key===key);
      feedback.push({key,name,code});
      if(typeof tools.recordReferenceFeedback==='function')return tools.recordReferenceFeedback(name,args,{...error,code,repeated});
      // Return an ordinary MCP result so native Agent can correct a reference;
      // this is not a provider retry or a successful retrieval.
      return {ok:true,result:{status:'INVALID_ARGUMENTS',recoverable:!repeated,error:{code,field:error.field??null,expected_reference_category:error.expected_category??null,actual_reference_category:error.actual_category??null,message:'短引用类型错误或未由Host发放。只使用本轮实际结果中的对应类型引用；不要猜测引用。'},...(repeated?{repeated_no_progress:true}:{})}};
    }
    return encode(await tools.call(name,decoded,context));
  }};
  if(typeof tools.isComplete==='function')wrapped.isComplete=()=>tools.isComplete();
  const snapshot=()=>clone(load());
  return {tools:wrapped,prompt:encodedPrompt,snapshot,get manifest(){return snapshot();}};
}
