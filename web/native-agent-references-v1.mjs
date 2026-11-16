import {bindAgentSaveFinish} from './native-agent-save-finish-v1.mjs';
/** Agent-facing reference aliases only. Host records, schemas and provenance stay authoritative. */
import {hash,clone,need,textField} from './cq-discovery-store-v2.mjs';

const KIND='native_agent_references_v1',VERSION='native-agent-references/1';
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
  const hint=key+' '+value.slice(0,30);
  if(/cursor/.test(hint))return 'N';
  if(/revision|version|sha256|hash|binding/.test(key))return 'V';
  if(/snapshot/.test(hint))return 'S';
  if(/read_receipt|cq_read_/.test(hint))return 'R';
  if(/evidence/.test(hint))return 'E';
  if(/candidate/.test(hint))return 'C';
  if(/task/.test(hint))return 'T';
  if(/(?:cq|member)_|native_cq_/.test(hint))return 'Q';
  if(/family/.test(hint))return 'F';
  if(/fact/.test(hint))return 'K';
  if(/doc|document/.test(hint))return 'D';
  if(/subject/.test(hint))return 'P';
  if(/block/.test(hint))return 'B';
  if(/unit/.test(hint))return 'U';
  if(/window/.test(hint))return 'W';
  return 'I';
}
const bodyOf=state=>{const {manifest_sha256,...body}=state;return body;};

export function createNativeAgentReferences({store,runId,role,tools,prompt,knowledgeBuildPolicy='LEGACY_V1',agentScope=null,runtimeInputPolicy=null,lifecycle=null,assertCurrent=null}){
  need(textField(runId)&&textField(role)&&typeof prompt==='string'&&Array.isArray(tools?.definitions)&&typeof tools.call==='function','NATIVE_REFERENCE_INPUT_INVALID');
  need(['LEGACY_V1','EXTRACT_AND_INDEX_V1'].includes(knowledgeBuildPolicy),'NATIVE_REFERENCE_POLICY_INVALID');
  need(agentScope===null||textField(agentScope)&&agentScope.length<=512,'NATIVE_AGENT_SCOPE_INVALID');
  need(runtimeInputPolicy===null||runtimeInputPolicy==='LOW_SEMANTIC_TASK_V1','NATIVE_INPUT_POLICY_INVALID');
  // Window work IDs are supplied by the Host, never by the model. Omitting one
  // preserves the exact existing run/role keys and bindings for historic runs.
  const scopeBinding=agentScope===null?{}:{agent_scope:agentScope};
  const tolerant=knowledgeBuildPolicy==='EXTRACT_AND_INDEX_V1';
  const key=hash({runId,role,...scopeBinding}),binding=hash({version:VERSION,runId,role,...scopeBinding,prompt,definitions:tools.definitions,
    ...(tolerant?{knowledge_build_policy:knowledgeBuildPolicy}:{}),...(runtimeInputPolicy?{runtime_input_policy:runtimeInputPolicy}:{})});
  function load(){
    const state=store.getRecord(KIND,key);
    need(state&&state.binding===binding&&state.run_id===runId&&state.role===role&&(state.agent_scope??null)===agentScope&&state.manifest_sha256===hash(bodyOf(state)),'NATIVE_REFERENCE_MANIFEST_CHANGED');
    need(new Set(state.entries.map(row=>row.alias)).size===state.entries.length&&new Set(state.entries.map(row=>row.value)).size===state.entries.length,'NATIVE_REFERENCE_MANIFEST_CHANGED');
    return state;
  }
  function persist(state){return store.putRecord(KIND,key,{...bodyOf(state),manifest_sha256:hash(bodyOf(state))});}
  store.transaction(()=>{
    const existing=store.getRecord(KIND,key);
    if(existing){load();return;}
    const full=hash({version:VERSION,runId,role,...scopeBinding});let length=6,scope=full.slice(0,length);
    const scopes=store.listRecords(KIND);
    while(scopes.some(row=>row.scope===scope)){length+=2;need(length<=full.length,'NATIVE_REFERENCE_SCOPE_COLLISION');scope=full.slice(0,length);}
    persist({version:VERSION,run_id:runId,role,...scopeBinding,scope,binding,raw_prompt_hash:hash(prompt),definitions_hash:hash(tools.definitions),entries:[],counters:{}});
  });
  function encodeValue(value,keyName,state){
    if(!opaque(value))return value;
    const existing=state.entries.find(row=>row.value===value);if(existing)return existing.alias;
    // Unissued model selectors can be echoed in per-item warnings by a tolerant
    // Host. Never register one as a real Host reference or grant it authority.
    if(tolerant&&aliasLike(value))return value;
    need(!aliasLike(value),'NATIVE_REFERENCE_HOST_ALIAS_INVALID');
    const type=category(keyName,value),number=(state.counters[type]??0)+1;
    state.counters[type]=number;
    const alias='ref_'+state.scope+'_'+type+number;
    state.entries.push({alias,value,category:type});return alias;
  }
  function decodeValue(value,state){
    if(!aliasLike(value))return value;
    const entry=state.entries.find(row=>row.alias===value);
    if(!entry&&tolerant)return value;
    need(entry,'NATIVE_REFERENCE_ALIAS_FORBIDDEN');return entry.value;
  }
  function transform(value,keyName,state,direction,authority=false){
    if(PROTECTED.has(keyName)||/(?:^|_)local_refs?$/.test(keyName)||digestField(keyName))return clone(value);
    const isAuthority=authority||fieldReference(keyName);
    if(typeof value==='string')return isAuthority?(direction==='ENCODE'?encodeValue(value,keyName,state):decodeValue(value,state)):value;
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
    persist(state);return (runtimeInputPolicy?'仅使用Host发放的引用；原问题、备注和原文保持原样。\n':'本角色工具和JSON输入中的 ref_'+state.scope+'_ 短名由Host发放，作为完整引用原样使用；不复述或猜测长ID，不自造ref_短名。local_ref由你命名且不使用ref_前缀；问题和原文照录不改。短名不授予额外权限。\n')+result;
  });
  if(typeof tools.bindNativeReferenceDecoder==='function')tools.bindNativeReferenceDecoder(decode);
  if(lifecycle)tools=bindAgentSaveFinish({store,runId,role,scope:agentScope,tools,profile:lifecycle,assertCurrent});
  const wrapped={...tools,definitions:tools.definitions,async call(name,args,callContext){
    let decoded;try{decoded=decode(args??{});}catch(error){return {ok:false,error:{code:error.code??'NATIVE_REFERENCE_DECODE_FAILED'}};}
    return encode(await tools.call(name,decoded,callContext));
  }};
  if(typeof tools.isComplete==='function')wrapped.isComplete=()=>tools.isComplete();
  const snapshot=()=>clone(load());
  return {tools:wrapped,prompt:encodedPrompt,snapshot,decode,get manifest(){return snapshot();}};
}

/** Decode a settled response using its original signed selector inventory, without writes. */
export function decodeRetainedNativeOutput({store,runId,agentScope,value}){
 const s=store.getRecord(KIND,hash({runId,role:'EXTRACTION',agent_scope:agentScope}));need(s&&s.run_id===runId&&s.agent_scope===agentScope&&s.manifest_sha256===hash(bodyOf(s)),'NATIVE_REFERENCE_MANIFEST_CHANGED');
 const entries=new Map(s.entries.map(e=>[e.alias,e.value]));
 const visit=(v,k='',authority=false)=>{if(PROTECTED.has(k)||/(?:^|_)local_refs?$/.test(k)||digestField(k))return clone(v);const bound=authority||fieldReference(k);if(typeof v==='string')return bound?(entries.get(v)??v):v;if(Array.isArray(v))return v.map(x=>visit(x,k,bound));if(!record(v))return v;return Object.fromEntries(Object.entries(v).map(([key,x])=>[entries.get(key)??key,visit(x,key)]));};return visit(value);
}
