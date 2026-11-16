/** Explicit native-library review requests. This module never edits or applies knowledge locally. */
const VERSION='LIGHTOG_LIBRARY_REVIEW_ACTION_V1';
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const LIBRARY=/^kb_[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const RUN=/^nrun_[a-f0-9]{32}$/;
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.trim().length>0&&value.isWellFormed();
const clone=structuredClone;
const fail=(message,code)=>Object.assign(Error(message),{code});
const info=error=>({message:error?.message??'请求结果尚未确认',code:error?.code??null,status:Number.isInteger(error?.status)?error.status:null});
const rejected=error=>Number.isInteger(error?.status)&&error.status>=400&&error.status<500&&error.status!==408;
const key=libraryId=>'lightog.library-review.pending.v1:'+libraryId;
const base=(libraryId,runId)=>'/api/product/libraries/'+encodeURIComponent(libraryId)+'/native-full-chain/runs/'+encodeURIComponent(runId)+'/library-review';
const validScope=({libraryId,runId,revisionRef}={})=>LIBRARY.test(libraryId??'')&&RUN.test(runId??'')&&text(revisionRef);

/** Receipt comparison follows JSON value semantics; object key order is immaterial. */
export function lightogReviewValuesEqual(left,right){
 if(left===right)return true;
 if(Array.isArray(left)||Array.isArray(right))return Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&left.every((value,index)=>lightogReviewValuesEqual(value,right[index]));
 if(!plain(left)||!plain(right))return false;
 const keys=Object.keys(left),other=Object.keys(right);
 return keys.length===other.length&&keys.every(key=>Object.hasOwn(right,key)&&lightogReviewValuesEqual(left[key],right[key]));
}

/** Predict only the deterministic event-field additions from the bound source row.
 * This is a receipt expectation, not a replacement for backend validation. Its
 * contract tests call the actual backend normalizer so changes cannot pass silently.
 */
export function lightogExpectedKnowledgeCorrection(record,patch){
 if(!plain(record)||!text(record.record_ref??record.knowledge_ref)||!['RELATION','ATTRIBUTE','RULE','TEXT'].includes(record.kind)||!plain(patch))throw fail('知识修订缺少本版具体原记录，尚未提交','LIGHTOG_REVIEW_CORRECTION_SOURCE_REQUIRED');
 const expected=clone(patch),has=key=>Object.hasOwn(expected,key),explicit=expected.text??expected.statement;
 if(explicit!==undefined){expected.text=explicit;expected.statement=explicit;if(record.kind==='RULE')expected.rule_text=explicit;}
 else if(record.kind==='RULE'&&has('rule_text')){expected.text=expected.rule_text;expected.statement=expected.rule_text;}
 else if(Object.keys(expected).some(key=>['raw_value','attribute','unit','predicate','rule_text','rule_name'].includes(key))){
  const next={...record,...expected},name=id=>(Array.isArray(record.domain?.entities)?record.domain.entities:[]).find(entity=>entity.id===id)?.name??id??'';
  const expression=record.kind==='ATTRIBUTE'?`${name(next.subject_ref)}；${next.attribute} = ${JSON.stringify(next.raw_value)}${next.unit?' '+next.unit:''}`:record.kind==='RELATION'?`${name(next.subject_ref)} ${next.predicate} ${name(next.object_ref)}`:null;
  if(expression){expected.text=expression;expected.statement=expression;}
 }
 if(!Object.entries(patch).every(([key,value])=>lightogReviewValuesEqual(value,expected[key])))throw fail('知识修订的文本字段彼此不一致，尚未提交','LIGHTOG_REVIEW_CORRECTION_INCONSISTENT');
 return expected;
}

/**
 * Business confirmation is injected after the owning backend contract is frozen.
 * A checker must explicitly return true. Missing/false/throw retains the pending
 * request, including after a successful HTTP response. No method retries a POST.
 */
export function createLightogReviewActions({api,uuid,storage=globalThis.localStorage,confirmDecision,confirmApplication}={}){
 const memory=new Map();
 function read(libraryId){
  if(!LIBRARY.test(libraryId??''))throw fail('知识库标识无效','LIGHTOG_REVIEW_SCOPE_INVALID');
  if(typeof storage?.getItem!=='function')throw fail('无法读取本机请求记录，尚未提交人工处理','LIGHTOG_REVIEW_STORAGE_UNAVAILABLE');
  let raw;try{raw=storage.getItem(key(libraryId));}catch{throw fail('无法读取本机请求记录，尚未提交人工处理','LIGHTOG_REVIEW_STORAGE_UNAVAILABLE');}
  if(raw===null||raw===undefined)return memory.get(libraryId)??null;
  let receipt;try{receipt=JSON.parse(raw);}catch{throw fail('本机人工处理请求记录暂不可读，请先核对原请求','LIGHTOG_REVIEW_PENDING_UNREADABLE');}
  if(!plain(receipt)||receipt.version!==VERSION||receipt.library_id!==libraryId||!UUID.test(receipt.request_id??'')||!RUN.test(receipt.run_id??'')||!text(receipt.revision_ref)||!['DECISION','APPLICATION'].includes(receipt.kind)||!plain(receipt.body)||receipt.body.request_id!==receipt.request_id||receipt.body.revision_ref!==receipt.revision_ref)throw fail('本机人工处理请求记录不完整，请先核对原请求','LIGHTOG_REVIEW_PENDING_UNREADABLE');
  if(receipt.expected_correction!==undefined&&(receipt.kind!=='DECISION'||!plain(receipt.body.correction)||!plain(receipt.expected_correction)||!Object.entries(receipt.body.correction).every(([key,value])=>lightogReviewValuesEqual(value,receipt.expected_correction[key]))||!Object.keys(receipt.expected_correction).every(key=>Object.hasOwn(receipt.body.correction,key)||['text','statement','rule_text'].includes(key))))throw fail('本机知识修订回执期望不完整，请先核对原请求','LIGHTOG_REVIEW_PENDING_UNREADABLE');
  if(receipt.expected_effect!==undefined&&!['STATE_ONLY','VERSION_CHANGE'].includes(receipt.expected_effect))throw fail('本机处理动作效果记录不完整，请先核对原请求','LIGHTOG_REVIEW_PENDING_UNREADABLE');
  if((receipt.application_ref!==undefined||receipt.target_run_id!==undefined)&&(receipt.kind!=='APPLICATION'||!text(receipt.application_ref)||!RUN.test(receipt.target_run_id??'')||receipt.target_run_id===receipt.run_id))throw fail('本机应用回执绑定不完整，请先核对原请求','LIGHTOG_REVIEW_PENDING_UNREADABLE');
  memory.set(libraryId,receipt);return receipt;
 }
 function write(receipt){
  const raw=JSON.stringify(receipt);
  try{
   if(typeof storage?.setItem!=='function'||typeof storage?.getItem!=='function')throw Error();
   storage.setItem(key(receipt.library_id),raw);if(storage.getItem(key(receipt.library_id))!==raw)throw Error();
  }catch{throw fail('无法保留稳定的人工处理请求记录，尚未提交请求','LIGHTOG_REVIEW_PENDING_NOT_SAVED');}
  memory.set(receipt.library_id,clone(receipt));
 }
 function clear(receipt){
  const current=read(receipt.library_id);if(!current||current.request_id!==receipt.request_id)return false;
  try{if(typeof storage?.removeItem!=='function')throw Error();storage.removeItem(key(receipt.library_id));if(storage.getItem(key(receipt.library_id))!==null&&storage.getItem(key(receipt.library_id))!==undefined)throw Error();}
  catch{return false;}
  memory.delete(receipt.library_id);return true;
 }
 function pending(libraryId){
  try{const receipt=read(libraryId);return receipt?clone(receipt):null;}
  catch(error){return {library_id:libraryId,status:'RESULT_UNCONFIRMED',error:info(error),unreadable:true};}
 }
 const result=(status,receipt,{response,error}={})=>({status,...(receipt?{receipt:{...clone(receipt),...(response===undefined?{}:{response})}}:{}),...(receipt&&pending(receipt.library_id)?{pending:pending(receipt.library_id)}:{}),...(error?{error:info(error)}:{})});
 function markUnknown(receipt,error,response){
  const next={...receipt,status:'RESULT_UNCONFIRMED',response_received:response!==undefined};
  try{const current=read(receipt.library_id);if(current?.request_id===receipt.request_id)write(next);}catch{/* The originally persisted SUBMITTING receipt still blocks repeated requests. */}
  return result('UNCONFIRMED',next,{response,error});
 }
 const checkerFor=kind=>kind==='DECISION'?confirmDecision:confirmApplication;
 async function confirmed(receipt,response){
  const checker=checkerFor(receipt.kind);if(typeof checker!=='function')return false;
  return await checker(response,{libraryId:receipt.library_id,runId:receipt.run_id,revisionRef:receipt.revision_ref,requestId:receipt.request_id,kind:receipt.kind,body:clone(receipt.body),...(receipt.body.correction===undefined?{}:{expectedCorrection:clone(receipt.expected_correction??receipt.body.correction)}),...(receipt.expected_effect===undefined?{}:{expectedEffect:receipt.expected_effect}),acceptedApplicationRef:receipt.application_ref??null,targetRunId:receipt.target_run_id??null})===true;
 }
 async function submit(kind,args,fields){
  let receipt;
  try{
   if(!validScope(args)||typeof api!=='function'||typeof uuid!=='function')throw fail('人工处理请求的资料版本或运行引用无效','LIGHTOG_REVIEW_SCOPE_INVALID');
   const prior=read(args.libraryId);if(prior)return {status:'BUSY',pending:clone(prior)};
   const requestId=uuid();if(!UUID.test(requestId??''))throw fail('人工处理请求标识无效','LIGHTOG_REVIEW_REQUEST_ID_INVALID');
   receipt={version:VERSION,library_id:args.libraryId,run_id:args.runId,revision_ref:args.revisionRef,kind,request_id:requestId,status:'SUBMITTING',body:{...clone(fields),request_id:requestId,revision_ref:args.revisionRef}};
   if(kind==='DECISION'&&fields.correction!==undefined)receipt.expected_correction=lightogExpectedKnowledgeCorrection(args.sourceKnowledge,fields.correction);
   if(kind==='DECISION'&&args.expectedEffect!==undefined)receipt.expected_effect=args.expectedEffect;
   write(receipt);
  }catch(error){return {status:'REJECTED',...(args?.libraryId&&pending(args.libraryId)?{pending:pending(args.libraryId)}:{}),error:info(error)};}
  let response;
  try{response=await api(base(receipt.library_id,receipt.run_id)+(kind==='DECISION'?'/decisions':'/applications'),clone(receipt.body));}
  catch(error){if(rejected(error)){clear(receipt);return result('REJECTED',receipt,{error});}return markUnknown(receipt,error);}
  try{
   if(!await confirmed(receipt,response))return markUnknown(receipt,fail('请求已返回，但人工处理结果尚未由所属接口契约确认','LIGHTOG_REVIEW_RECEIPT_UNCONFIRMED'),response);
   clear(receipt);return result('CONFIRMED',{...receipt,status:'CONFIRMED'},{response});
  }catch(error){return markUnknown(receipt,error,response);}
 }
 return Object.freeze({
  pending,
  async saveDecision(args={}){
   if(!text(args.itemRef)||!text(args.action)||typeof args.reason!=='string'||!args.reason.isWellFormed()||args.reasonRequired!==false&&!text(args.reason))return {status:'REJECTED',error:info(fail('请选择具体事项，并按动作要求填写理由','LIGHTOG_REVIEW_DECISION_INVALID'))};
   return submit('DECISION',args,{item_ref:args.itemRef,action:args.action,reason:args.reason,...(args.correction===undefined?{}:{correction:clone(args.correction)}),...(args.definitionResolution===undefined?{}:{definition_resolution:clone(args.definitionResolution)})});
  },
  async apply(args={}){
   const fields=args.applicationFields===undefined?{}:args.applicationFields;
   if(!plain(fields)||Object.hasOwn(fields,'request_id')||Object.hasOwn(fields,'revision_ref'))return {status:'REJECTED',error:info(fail('应用字段不能覆盖程序维护的请求或版本引用','LIGHTOG_REVIEW_APPLICATION_FIELDS_INVALID'))};
   try{JSON.stringify(fields);clone(fields);}catch{return {status:'REJECTED',error:info(fail('应用字段无法保存为请求记录','LIGHTOG_REVIEW_APPLICATION_FIELDS_INVALID'))};}
   return submit('APPLICATION',args,fields);
  },
  // The caller validates the HTTP acceptance response before supplying these fields.
  // This binding protects the known target across reload; it never means APPLIED.
  bindAcceptedApplication({libraryId,runId,revisionRef,requestId,applicationRef,targetRunId}={}){
   let receipt;
   try{
    receipt=read(libraryId);
    if(!receipt||receipt.kind!=='APPLICATION'||receipt.request_id!==requestId||receipt.run_id!==runId||receipt.revision_ref!==revisionRef||!text(applicationRef)||!RUN.test(targetRunId??'')||targetRunId===runId)throw fail('应用接受回执未精确绑定原请求与新运行，未保存新的绑定','LIGHTOG_REVIEW_ACCEPTANCE_BINDING_MISMATCH');
    if(receipt.application_ref!==undefined&&(receipt.application_ref!==applicationRef||receipt.target_run_id!==targetRunId))throw fail('此请求已绑定另一份应用接受回执，未替换原绑定','LIGHTOG_REVIEW_ACCEPTANCE_BINDING_CONFLICT');
    const next={...receipt,application_ref:applicationRef,target_run_id:targetRunId};write(next);
    return result('UNCONFIRMED',next);
   }catch(error){return {status:'REJECTED',...(receipt?{receipt:clone(receipt),pending:pending(libraryId)}:{}),error:info(error)};}
  },
  async confirmReadback({libraryId,runId,revisionRef,requestId,response}={}){
   let receipt;
   try{
    receipt=read(libraryId);
    if(!receipt||receipt.request_id!==requestId||receipt.run_id!==runId||receipt.revision_ref!==revisionRef)throw fail('读回结果未精确绑定原人工处理请求，未解除保护','LIGHTOG_REVIEW_READBACK_BINDING_MISMATCH');
    if(!await confirmed(receipt,response))return markUnknown(receipt,fail('人工处理读回尚未确认，未解除保护','LIGHTOG_REVIEW_RECEIPT_UNCONFIRMED'),response);
    clear(receipt);return result('CONFIRMED',{...receipt,status:'CONFIRMED'},{response});
   }catch(error){return {status:receipt?'UNCONFIRMED':'REJECTED',...(receipt?{receipt:clone(receipt),pending:pending(libraryId)}:{}),error:info(error)};}
  }
 });
}

/** Changed fields preserve the visible body when a structural edit could recompose it. */
export function lightogCorrectionFromForm(form,record) {
 const read=name=>form.elements?.[name]?.value;
 const draft={},body=read('correction_text');
 if(typeof body==='string'&&body.trim()!==(record.statement??record.text??record.rule_text??'').trim()){
  if(!body.trim())throw Error('修订后的知识内容不能为空。');draft.text=body.trim();
 }
 for(const key of ['attribute','predicate','rule_name','unit','time_text','version_text','modality']){
  const value=read('correction_'+key);if(typeof value!=='string')continue;
  const normalized=value.trim()||null,old=record[key]??null;
  if(normalized!==old)draft[key]=normalized;
 }
 const raw=read('correction_raw_value');
 if(typeof raw==='string'){
  const kind=read('correction_value_type')??typeof record.raw_value;
  let value=raw;
  if(kind==='number'){value=Number(raw);if(!raw.trim()||!Number.isFinite(value))throw Error('请输入有限数值。');}
  else if(kind==='boolean'){if(!['true','false'].includes(raw.trim()))throw Error('布尔值请填写 true 或 false。');value=raw.trim()==='true';}
  else if(kind==='null')value=null;
  if(JSON.stringify(value)!==JSON.stringify(record.raw_value))draft.raw_value=value;
 }
 const conditions=read('correction_conditions');
 if(typeof conditions==='string'){
  const values=conditions.split('\n').map(value=>value.trim()).filter(Boolean);
  if(JSON.stringify(values)!==JSON.stringify(record.conditions??[]))draft.conditions=values;
 }
 const negation=read('correction_negation');
 if(typeof negation==='string'&&negation!==''){
  const value=negation==='true';if(value!==record.negation)draft.negation=value;
 }
 if(!Object.keys(draft).length)throw Error('请先修改需要纠正的知识内容或适用条件。');
 const structural=record.kind==='RELATION'?['predicate']:record.kind==='ATTRIBUTE'?['attribute','raw_value','unit']:record.kind==='RULE'?['rule_text','rule_name']:[];
 if(structural.some(key=>Object.hasOwn(draft,key))){
  if(typeof body!=='string'||!body.trim())throw Error('修订后的知识内容不能为空。');
  draft.text=body;
 }
 return draft;
}

/** A stable local receipt protects one analysis request. Read never starts a new call. */
export function createLightogAnalysisActions({api,uuid,storage=globalThis.localStorage}={}){
 const prefix='lightog.library-analysis.v1:',receiptKey=(libraryId,itemRef)=>prefix+libraryId+':'+encodeURIComponent(itemRef),terminal=new Set(['COMPLETED','PARTIAL','NO_NEW_INFORMATION','FAILED','STALE']);
 function read(libraryId,itemRef){
  try{const value=JSON.parse(storage.getItem(receiptKey(libraryId,itemRef))??'null');if(value===null)return null;if(value.library_id!==libraryId||value.item_ref!==itemRef||!UUID.test(value.request_id??'')||!text(value.revision_ref)||!RUN.test(value.run_id??''))throw Error();return value;}catch{return {library_id:libraryId,item_ref:itemRef,status:'UNKNOWN',unreadable:true};}
 }
 function write(receipt){const key=receiptKey(receipt.library_id,receipt.item_ref),raw=JSON.stringify(receipt);storage.setItem(key,raw);if(storage.getItem(key)!==raw)throw fail('无法保存分析原请求，尚未提交','LIGHTOG_ANALYSIS_RECEIPT_NOT_SAVED');}
 function accept(receipt,response){
  const statuses=['RUNNING','COMPLETED','PARTIAL','NO_NEW_INFORMATION','FAILED','UNKNOWN','STALE'];
  if(response?.policy!=='LIBRARY_PENDING_ANALYSIS_V1'||response.request_id!==receipt.request_id||response.item_ref!==receipt.item_ref||response.revision_ref!==receipt.revision_ref||!text(response.analysis_ref)||!statuses.includes(response.status))return null;
  return {...receipt,status:response.status,response:clone(response)};
 }
 async function request(receipt,post){
  let response;
  try{const url=base(receipt.library_id,receipt.run_id)+'/analysis';response=post?await api(url,{request_id:receipt.request_id,revision_ref:receipt.revision_ref,item_ref:receipt.item_ref}):await api(url+'?revision_ref='+encodeURIComponent(receipt.revision_ref)+'&item_ref='+encodeURIComponent(receipt.item_ref)+'&request_id='+encodeURIComponent(receipt.request_id));}
  catch(error){const next={...receipt,status:post&&rejected(error)?'FAILED':'UNKNOWN',error:info(error)};write(next);return {status:next.status,receipt:next};}
  const next=accept(receipt,response)??{...receipt,status:'UNKNOWN',error:{message:'分析回执尚未与原请求精确对应。'}};write(next);return {status:next.status,receipt:next};
 }
 return Object.freeze({pending:read,async start(args){
  if(!validScope(args)||!text(args.itemRef)||typeof api!=='function'||typeof uuid!=='function')return {status:'REJECTED'};
  const old=read(args.libraryId,args.itemRef);if(old&&(old.unreadable||!terminal.has(old.status)))return {status:'BUSY',receipt:old};
  if(old&&old.revision_ref===args.revisionRef&&old.input_fingerprint===(args.inputFingerprint??null))return {status:'ALREADY_FINISHED',receipt:old};
  const requestId=uuid();if(!UUID.test(requestId??''))return {status:'REJECTED'};
  const receipt={library_id:args.libraryId,run_id:args.runId,revision_ref:args.revisionRef,item_ref:args.itemRef,request_id:requestId,input_fingerprint:args.inputFingerprint??null,status:'RUNNING'};
  try{write(receipt);}catch(error){return {status:'REJECTED',error:info(error)};}return request(receipt,true);
 },async read({libraryId,itemRef}){const receipt=read(libraryId,itemRef);if(!receipt||receipt.unreadable)return {status:'UNKNOWN',receipt};return request(receipt,false);}});
}
