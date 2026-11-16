/** Product catalog -> native CQ tools. No inference, grouping or parent-run finalization. */
import {hash, need, clone, textField} from './cq-discovery-store-v2.mjs';

const STATE = 'native_cq_source_adapter_v1';
const RECEIPT = 'native_cq_read_receipt_v1';
const INPUT = 'native_cq_input_v1';
const PROPOSAL = 'native_cq_proposal_v1';
export const NATIVE_CQ_TOLERANT_POLICY = 'EXTRACT_AND_INDEX_V1';
const TOOLS = ['lightog_list_cq_documents', 'lightog_read_cq_material', 'lightog_save_cq_list'];
const DIRECTORY_PAGE_SIZE = 20;
const LEGACY_SAVE_CONTRACT = 'LEGACY_V1';
export const NATIVE_CQ_PRODUCT_SAVE_CONTRACT = 'SOURCE_DOC_REFS_V1';
const LEGACY_READ_CONTRACT = 'LEGACY_V1';
export const NATIVE_CQ_PRODUCT_READ_CONTRACT = 'NEXT_UNREAD_V1';
const object = (properties, required = []) => ({type:'object', properties, required, additionalProperties:false});
const str = {type:'string', minLength:1};
const refs = {type:'array', uniqueItems:true, items:str};
const sourceRef = object({doc_ref:str, revision:str}, ['doc_ref', 'revision']);
const keys = (value, allowed) => need(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => allowed.includes(k)), 'NATIVE_CQ_ARGUMENTS_INVALID');
const strings = value => Array.isArray(value) && value.every(textField) && new Set(value).size === value.length;
const sameSource = (a, b) => a.doc_ref === b.doc_ref && a.revision === b.revision;
const preview = (text, limit) => {
  const part = text.slice(0, limit);
  return /[\uD800-\uDBFF]$/.test(part) ? part.slice(0,-1) : part;
};

function definitions(saveContract, readContract, knowledgeBuildPolicy) {
  const tools = [
    {name:TOOLS[0], description:'分页列出本次快照文档，Host固定每页最多20项，不接收limit或页大小参数。目录不是正文阅读。指定doc_ref/revision可分页查看该文档的结构目录；有next_cursor时继续调用本工具直至为空；文档条目的directory_next_cursor用于该文档目录续页。',
      inputSchema:object({cursor:str, doc_ref:str, revision:str})},
    {name:TOOLS[1], description:'按实际文档及修订分页读取正文，默认最多12000个UTF-16字符/256个单元，返回来源、真实read_receipt_ref、UTF-16位置及可得的解析告警/provenance。保留next_cursor；目录或单页不代表全文已读。',
      inputSchema:object({doc_ref:str, revision:str, cursor:str, max_chars:{type:'integer', minimum:256, maximum:12000, default:12000}, max_units:{type:'integer', minimum:1, maximum:512, default:256}, block_ids:{type:'array', minItems:1, maxItems:64, uniqueItems:true, items:str}}, ['doc_ref', 'revision'])},
    {name:TOOLS[2], description:'保存本轮CQ阶段原稿，不结束父run。每题只引用其实际已读来源和对应回执，可有多个来源；来源未定时source_status=UNKNOWN、source_refs为空并说明source_unknown_reason。source_hint仅导航，不是事实核验。',
      inputSchema:object({items:{type:'array', maxItems:100, items:object({
        question:{type:'string', minLength:1, maxLength:1200}, source_hint:{type:'string', minLength:1, maxLength:300}, notes:{type:'string', minLength:1, maxLength:600},
        source_status:{enum:['KNOWN', 'UNKNOWN']}, source_refs:{type:'array', uniqueItems:true, items:sourceRef}, read_receipt_refs:refs,
        source_unknown_reason:{type:'string', minLength:1, maxLength:600}
      }, ['question', 'source_status', 'source_refs', 'read_receipt_refs'])}}, ['items'])}
  ].map(tool => ({...tool, annotations:{readOnlyHint:tool.name !== TOOLS[2], destructiveHint:false, idempotentHint:true, openWorldHint:false}}));
  if (readContract === NATIVE_CQ_PRODUCT_READ_CONTRACT) {
    tools[1].description = '读取所选获准文档的下一页正文，每次最多12000个UTF-16字符/256单元。只填doc_ref；修订、正文游标和分页进度由Host管理，不填写cursor/revision/偏移。has_more=true时可再次选同文档继续；complete=true或status=READ_COMPLETE表示该文档已读完，READ_COMPLETE且read_performed=false不产生新正文或回执。其他文档必须明确选择，不自动读取。';
    tools[1].inputSchema = object({doc_ref:str}, ['doc_ref']);
  }
  if (saveContract === NATIVE_CQ_PRODUCT_SAVE_CONTRACT) {
    tools[2].description = '保存本轮CQ阶段原稿，不结束父run。每题由你选择实际已读来源文档source_doc_refs，可选多个；Host绑定当前修订和真实读取回执，不需要填写revision/source_refs/read_receipt_refs/source_status。来源未定时source_doc_refs为空并说明source_unknown_reason。source_hint仅导航，不代表事实核验。';
    tools[2].inputSchema = object({items:{type:'array', maxItems:100, items:object({
      question:{type:'string', minLength:1, maxLength:1200}, source_hint:{type:'string', minLength:1, maxLength:300}, notes:{type:'string', minLength:1, maxLength:600},
      source_doc_refs:refs, source_unknown_reason:{type:'string', minLength:1, maxLength:600}
    }, ['question','source_doc_refs'])}}, ['items']);
  }
  if (knowledgeBuildPolicy === NATIVE_CQ_TOLERANT_POLICY) {
    tools[2].description = '处理并保存本轮CQ阶段，不结束父run。question表达问题，可选source_doc_refs选择已读文档及source_hint/notes。按条保留可用问题，空白或损坏条目跳过计数；逐题来源不可靠时明确UNKNOWN，不猜来源。多余字段原稿保留、忽略告警。查看processed/processing_summary/warnings，已处理不等于每条已保存；不为告警再开评审或修订循环。';
    tools[2].inputSchema = object({items:{type:'array',items:{...object({
      question:{type:'string'},source_doc_refs:refs,source_hint:{type:'string'},notes:{type:'string'},source_unknown_reason:{type:'string'}
    },['question']),additionalProperties:true}}},['items']);
    tools[2].inputSchema.additionalProperties = true;
  }
  return tools;
}

function metadata(doc) {
  const available = Object.hasOwn(doc, 'warnings') || Object.hasOwn(doc, 'parse_warnings') || !!doc.parser && Object.hasOwn(doc.parser, 'warnings');
  return {parser:clone(doc.parser ?? null), parse_status:doc.parse_status ?? null,
    parse_warnings_status:available ? 'AVAILABLE' : 'UNAVAILABLE',
    parse_warnings:clone(doc.warnings ?? doc.parse_warnings ?? doc.parser?.warnings ?? null)};
}

function mergeRanges(ranges) {
  const merged = [];
  for (const range of ranges.sort((a,b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({...range});
  }
  return merged;
}

export function createNativeCQSourceAdapter({store, catalog, libraryId, snapshotId, runId, assertOpen, saveContract = LEGACY_SAVE_CONTRACT, readContract = LEGACY_READ_CONTRACT, knowledgeBuildPolicy = null}) {
  need([libraryId, snapshotId, runId].every(textField) && typeof assertOpen === 'function', 'NATIVE_CQ_BINDING_REQUIRED');
  need([LEGACY_SAVE_CONTRACT,NATIVE_CQ_PRODUCT_SAVE_CONTRACT].includes(saveContract), 'NATIVE_CQ_SAVE_CONTRACT_INVALID');
  need([LEGACY_READ_CONTRACT,NATIVE_CQ_PRODUCT_READ_CONTRACT].includes(readContract), 'NATIVE_CQ_READ_CONTRACT_INVALID');
  need(knowledgeBuildPolicy === null || knowledgeBuildPolicy === NATIVE_CQ_TOLERANT_POLICY, 'NATIVE_CQ_KNOWLEDGE_POLICY_INVALID');
  const source = clone(catalog.get(snapshotId, libraryId));
  need(source.snapshot_id === snapshotId && source.library_id === libraryId && Array.isArray(source.documents), 'NATIVE_CQ_SNAPSHOT_INVALID');
  const binding = hash({runId, libraryId, snapshotId, source});
  const load = () => store.getRecord(STATE, runId);
  store.transaction(() => {
    const old = load();
    if (old) {
      need(old.binding === binding, 'NATIVE_CQ_RUN_BINDING_CONFLICT');
      need((old.save_contract ?? LEGACY_SAVE_CONTRACT) === saveContract, 'NATIVE_CQ_SAVE_CONTRACT_CONFLICT');
      need((old.read_contract ?? LEGACY_READ_CONTRACT) === readContract, 'NATIVE_CQ_READ_CONTRACT_CONFLICT');
      need((old.knowledge_build_policy ?? null) === knowledgeBuildPolicy, 'NATIVE_CQ_KNOWLEDGE_POLICY_CONFLICT');
    }
    else store.putRecord(STATE, runId, {version:'native-cq-source-adapter/1', run_id:runId, library_id:libraryId, source_snapshot_ref:snapshotId, binding,
      save_contract:saveContract, read_contract:readContract, knowledge_build_policy:knowledgeBuildPolicy, cq_input:null, reads:[], directory_seen:[]});
  });
  function current() {
    const open = assertOpen();
    need(!open?.then && open !== false, 'NATIVE_CQ_RUN_NOT_OPEN');
    need(catalog.isCurrent(snapshotId, libraryId) && hash({runId, libraryId, snapshotId, source:catalog.get(snapshotId, libraryId)}) === binding, 'NATIVE_CQ_SOURCE_STALE');
    need(load()?.binding === binding, 'NATIVE_CQ_RUN_BINDING_CONFLICT');
    need((load().save_contract ?? LEGACY_SAVE_CONTRACT) === saveContract, 'NATIVE_CQ_SAVE_CONTRACT_CONFLICT');
    need((load().read_contract ?? LEGACY_READ_CONTRACT) === readContract, 'NATIVE_CQ_READ_CONTRACT_CONFLICT');
    need((load().knowledge_build_policy ?? null) === knowledgeBuildPolicy, 'NATIVE_CQ_KNOWLEDGE_POLICY_CONFLICT');
  }
  function document(docRef, revision) {
    need(textField(docRef) && textField(revision), 'NATIVE_CQ_SOURCE_REF_REQUIRED');
    const doc = source.documents.find(d => d.doc_id === docRef);
    need(doc && doc.revision === revision, 'NATIVE_CQ_SOURCE_FORBIDDEN');
    return doc;
  }
  function beforeReading() { current(); need(load().cq_input === null, 'NATIVE_CQ_STAGE_ALREADY_SAVED'); }
  function directoryPage(doc, cursor) {
    const entries = doc.blocks.filter(b => /heading|title|table/.test(b.kind ?? ''));
    const pageBinding = hash([binding, 'directory', doc.doc_id, doc.revision]);
    let start = 0;
    if (cursor !== undefined) {
      try { const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        need(decoded.binding === pageBinding && Number.isSafeInteger(decoded.start) && decoded.start >= 0 && decoded.start <= entries.length, 'NATIVE_CQ_DIRECTORY_CURSOR_INVALID'); start = decoded.start;
      } catch { need(false, 'NATIVE_CQ_DIRECTORY_CURSOR_INVALID'); }
    }
    const end = Math.min(entries.length, start + DIRECTORY_PAGE_SIZE);
    return {directory:entries.slice(start, end).map(b => {
      const title = preview(doc.content.slice(b.start,b.end),120);
      return {...clone(b), title, title_truncated:b.end - b.start > title.length};
    }),
      directory_total:entries.length, page_size:DIRECTORY_PAGE_SIZE, returned_items:end - start,
      next_cursor:end < entries.length ? Buffer.from(JSON.stringify({binding:pageBinding, start:end})).toString('base64url') : null};
  }
  function list(args) {
    keys(args, ['cursor', 'doc_ref', 'revision']); beforeReading();
    if (args.cursor !== undefined) need(textField(args.cursor), 'NATIVE_CQ_CURSOR_INVALID');
    if (args.doc_ref !== undefined || args.revision !== undefined) {
      const d = document(args.doc_ref, args.revision);
      return {source_snapshot_ref:snapshotId, doc_ref:d.doc_id, revision:d.revision, read_mode:'DIRECTORY_ONLY', ...metadata(d), ...directoryPage(d, args.cursor)};
    }
    const page = catalog.list({snapshot_id:snapshotId, library_id:libraryId, cursor:args.cursor, limit:DIRECTORY_PAGE_SIZE});
    const documents = page.documents.map(row => {
      const doc = document(row.doc_id, row.revision), dir = directoryPage(doc);
      const {doc_id, ...rest} = row;
      return {...rest, doc_ref:doc_id, ...metadata(doc), directory:dir.directory, directory_total:dir.directory_total,
        directory_truncated:dir.next_cursor !== null, directory_page_size:dir.page_size, directory_returned_items:dir.returned_items, directory_next_cursor:dir.next_cursor};
    });
    const state = load(); state.directory_seen = [...new Set([...state.directory_seen, ...documents.map(d => d.doc_ref)])]; store.putRecord(STATE, runId, state);
    return {...page, source_snapshot_ref:snapshotId, page_size:DIRECTORY_PAGE_SIZE, returned_items:documents.length,
      limits:{...page.limits, documents:DIRECTORY_PAGE_SIZE, directory_entries_per_document:DIRECTORY_PAGE_SIZE}, documents};
  }
  function read(args) {
    if (readContract === NATIVE_CQ_PRODUCT_READ_CONTRACT) {
      keys(args, ['doc_ref']); beforeReading();
      const doc = source.documents.find(d => d.doc_id === args.doc_ref);
      need(doc, 'NATIVE_CQ_SOURCE_FORBIDDEN');
      need(doc.parse_status === undefined || doc.parse_status === 'READABLE', 'NATIVE_CQ_PARSE_NOT_READABLE');
      const reads = load().reads.filter(r => r.run_id === runId && r.source_snapshot_ref === snapshotId && r.body_returned &&
        sameSource(r.source_ref,{doc_ref:doc.doc_id,revision:doc.revision}));
      for (const receipt of reads) {
        const retained = store.getRecord(RECEIPT,receipt.read_receipt_ref);
        need(retained && hash(retained) === hash(receipt), 'NATIVE_CQ_READ_RECEIPT_CONFLICT');
      }
      // Only the continuation of an actual prior page may advance this document.
      const last = reads.at(-1);
      if (last?.result.next_cursor === null) return {
        status:'READ_COMPLETE',read_performed:false,source_snapshot_ref:snapshotId,doc_ref:doc.doc_id,revision:doc.revision,
        title:doc.title,...metadata(doc),has_more:false,complete:true,returned_chars:0,units:[],complete_scope:'DOCUMENT_BODY_UNITS'
      };
      const page = readPage({doc_ref:doc.doc_id,revision:doc.revision,...(last ? {cursor:last.result.next_cursor} : {})});
      const {next_cursor,...body} = page;
      return {...body,status:'PAGE_READ',read_performed:true,has_more:next_cursor !== null};
    }
    return readPage(args);
  }
  function readPage(args) {
    keys(args, ['doc_ref', 'revision', 'cursor', 'max_chars', 'max_units', 'block_ids']); beforeReading();
    const doc = document(args.doc_ref, args.revision);
    need(doc.parse_status === undefined || doc.parse_status === 'READABLE', 'NATIVE_CQ_PARSE_NOT_READABLE');
    if (args.cursor !== undefined) need(textField(args.cursor), 'NATIVE_CQ_CURSOR_INVALID');
    const body = catalog.read({snapshot_id:snapshotId, library_id:libraryId, doc_id:doc.doc_id, revision:doc.revision,
      cursor:args.cursor, max_chars:args.max_chars ?? 12000, max_units:args.max_units ?? 256, block_ids:args.block_ids});
    need(body.doc_id === doc.doc_id && body.revision === doc.revision && body.offset_unit === 'utf16_code_unit', 'NATIVE_CQ_READ_BINDING_INVALID');
    const units = body.units.map(unit => {
      const block = doc.blocks.find(b => b.block_id === unit.block_id);
      need(block && unit.start >= block.start && unit.end <= block.end && unit.end > unit.start && unit.text === doc.content.slice(unit.start, unit.end), 'NATIVE_CQ_READ_SPAN_INVALID');
      return {...clone(block), ...clone(unit),
        ...(typeof unit.heading === 'string' ? {heading:preview(unit.heading,unit.heading.length)} : {}),
        ...(typeof unit.table_header === 'string' ? {table_header:preview(unit.table_header,unit.table_header.length)} : {}),
        provenance:clone(block.provenance ?? []), provenance_status:Object.hasOwn(block, 'provenance') ? 'AVAILABLE' : 'UNAVAILABLE'};
    });
    need(body.next_cursor === null || units.length > 0, 'NATIVE_CQ_READ_NO_PROGRESS');
    const {doc_id, ...rest} = body;
    const result = {...rest, source_snapshot_ref:snapshotId, doc_ref:doc_id, title:doc.title, ...metadata(doc), units,
      complete:body.next_cursor === null, complete_scope:args.block_ids ? 'SELECTED_BLOCKS' : 'DOCUMENT_BODY_UNITS'};
    const read_receipt_ref = 'cq_read_' + hash({binding, request:args, result});
    const receipt = {read_receipt_ref, run_id:runId, source_snapshot_ref:snapshotId, source_ref:{doc_ref:doc_id, revision:doc.revision},
      request:clone(args), result:clone(result), body_returned:units.length > 0};
    const old = store.getRecord(RECEIPT, read_receipt_ref);
    need(!old || hash(old) === hash(receipt), 'NATIVE_CQ_READ_RECEIPT_CONFLICT');
    store.putRecord(RECEIPT, read_receipt_ref, receipt);
    const state = load(); if (!state.reads.some(r => r.read_receipt_ref === read_receipt_ref)) state.reads.push(receipt);
    store.putRecord(STATE, runId, state);
    return {...result, read_receipt_ref};
  }
  function bindSelectedSources(args, state) {
    return {items:args.items.map(item => {
      keys(item, ['question','source_hint','notes','source_doc_refs','source_unknown_reason']);
      need(strings(item.source_doc_refs), 'NATIVE_CQ_SOURCE_DOC_REFS_INVALID');
      const source_refs = [], read_receipt_refs = [];
      for (const docRef of item.source_doc_refs) {
        const doc = source.documents.find(d => d.doc_id === docRef);
        need(doc, 'NATIVE_CQ_SOURCE_FORBIDDEN');
        const reads = state.reads.filter(r => r.run_id === runId && r.source_snapshot_ref === snapshotId && r.body_returned &&
          r.source_ref.doc_ref === docRef && r.source_ref.revision === doc.revision);
        need(reads.length > 0, 'NATIVE_CQ_SOURCE_NOT_READ');
        for (const receipt of reads) {
          const retained = store.getRecord(RECEIPT, receipt.read_receipt_ref);
          need(retained && hash(retained) === hash(receipt), 'NATIVE_CQ_READ_RECEIPT_CONFLICT');
          read_receipt_refs.push(receipt.read_receipt_ref);
        }
        source_refs.push({doc_ref:docRef, revision:doc.revision});
      }
      const {source_doc_refs, ...business} = clone(item);
      return {...business, source_status:source_refs.length ? 'KNOWN' : 'UNKNOWN', source_refs, read_receipt_refs};
    })};
  }
  function save(args) {
    if (knowledgeBuildPolicy === NATIVE_CQ_TOLERANT_POLICY) return saveTolerant(args);
    keys(args, ['items']); current();
    need(Array.isArray(args.items) && args.items.length <= 100, 'NATIVE_CQ_ITEMS_INVALID');
    const state = load();
    need(state.reads.some(r => r.body_returned), 'NATIVE_CQ_BODY_NOT_READ');
    const agentInput = clone(args);
    if (saveContract === NATIVE_CQ_PRODUCT_SAVE_CONTRACT) args = bindSelectedSources(args, state);
    for (const item of args.items) {
      keys(item, ['question', 'source_hint', 'notes', 'source_status', 'source_refs', 'read_receipt_refs', 'source_unknown_reason']);
      need(textField(item.question) && item.question.length <= 1200, 'NATIVE_CQ_QUESTION_INVALID');
      for (const [key, max] of [['source_hint',300], ['notes',600], ['source_unknown_reason',600]]) if (Object.hasOwn(item, key)) need(textField(item[key]) && item[key].length <= max, 'NATIVE_CQ_OPTION_INVALID');
      need(Array.isArray(item.source_refs) && strings(item.read_receipt_refs), 'NATIVE_CQ_SOURCE_REFS_INVALID');
      const sources = item.source_refs;
      for (const ref of sources) { keys(ref, ['doc_ref','revision']); document(ref.doc_ref, ref.revision); }
      need(new Set(sources.map(ref => hash(ref))).size === sources.length, 'NATIVE_CQ_SOURCE_REFS_DUPLICATE');
      const receipts = item.read_receipt_refs.map(ref => state.reads.find(r => r.read_receipt_ref === ref));
      need(receipts.every(r => r?.body_returned && r.run_id === runId && r.source_snapshot_ref === snapshotId), 'NATIVE_CQ_READ_RECEIPT_FORBIDDEN');
      if (item.source_status === 'UNKNOWN') {
        need(sources.length === 0 && textField(item.source_unknown_reason), 'NATIVE_CQ_UNKNOWN_SOURCE_INVALID');
      } else {
        need(item.source_status === 'KNOWN' && sources.length > 0 && item.source_unknown_reason === undefined, 'NATIVE_CQ_KNOWN_SOURCE_INVALID');
        need(sources.every(ref => receipts.some(r => sameSource(ref, r.source_ref))) && receipts.every(r => sources.some(ref => sameSource(ref, r.source_ref))), 'NATIVE_CQ_SOURCE_READ_MISMATCH');
      }
    }
    const inputHash = hash(args);
    if (state.cq_input) { need(state.cq_input_hash === inputHash, 'NATIVE_CQ_ALREADY_SAVED'); return {saved:true, stage_complete:true, parent_run_complete:false, ...clone(state.cq_input)}; }
    const cq_input = {input_ref:'native_cq_input_' + hash({binding, inputHash}), run_id:runId, source_snapshot_ref:snapshotId,
      items:args.items.map((item, i) => ({cq_ref:'Q' + String(i + 1).padStart(2,'0'), ...clone(item)}))};
    const old = store.getRecord(INPUT, cq_input.input_ref);
    need(!old || hash(old) === hash(cq_input), 'NATIVE_CQ_INPUT_CONFLICT');
    store.putRecord(INPUT, cq_input.input_ref, cq_input);
    store.putRecord(STATE, runId, {...state, cq_input, cq_input_hash:inputHash,
      ...(saveContract === NATIVE_CQ_PRODUCT_SAVE_CONTRACT ? {cq_agent_input:agentInput} : {})});
    return {saved:true, stage_complete:true, parent_run_complete:false, ...clone(cq_input)};
  }
  function saveTolerant(args) {
    current();
    const state = load(), rawHash = hash(args);
    const receipt = s => ({processed:true,saved:true,stage_complete:true,parent_run_complete:false,...clone(s.cq_input),
      processing_summary:clone(s.processing_summary),warnings:clone(s.warnings),processing_results:clone(s.processing_results),source_context_ref:s.cq_proposal_ref});
    if (state.cq_input) { need(state.cq_input_hash === rawHash,'NATIVE_CQ_ALREADY_SAVED'); return receipt(state); }
    const warnings = [], processing_results = [], items = [];
    const warn = (index,code,field) => warnings.push({index,code,...(field ? {field} : {})});
    const record = value => value && typeof value === 'object' && !Array.isArray(value);
    const verifiedReads = state.reads.filter(r => r.body_returned);
    for (const r of verifiedReads) {
      const retained = store.getRecord(RECEIPT,r.read_receipt_ref);
      need(r.run_id === runId && r.source_snapshot_ref === snapshotId &&
        source.documents.some(d => sameSource(r.source_ref,{doc_ref:d.doc_id,revision:d.revision})) &&
        retained && hash(retained) === hash(r),'NATIVE_CQ_READ_RECEIPT_CONFLICT');
    }
    // Run-level traceability is separate from the precise source selection of every CQ.
    const source_context = {role:'RUN_INPUT_CONTEXT_NOT_ITEM_EVIDENCE',source_snapshot_ref:snapshotId,
      available_source_refs:source.documents.map(d => ({doc_ref:d.doc_id,revision:d.revision})),
      read_receipt_refs:verifiedReads.map(r => r.read_receipt_ref)};
    if (!verifiedReads.length) warn(null,'CQ_NO_BODY_READ');
    const inputItems = record(args) && Array.isArray(args.items) ? args.items : [];
    if (!record(args) || !Array.isArray(args.items)) warn(null,'CQ_ITEMS_INVALID');
    if (record(args)) for (const key of Object.keys(args)) if (key !== 'items') warn(null,'CQ_EXTRA_FIELD_IGNORED',key);
    for (const [offset,original] of inputItems.entries()) {
      const index = offset + 1, start = warnings.length;
      if (!record(original) || !textField(original.question)) {
        warn(index,'CQ_INVALID_QUESTION_SKIPPED'); processing_results.push({index,status:'SKIPPED',reason:'CQ_INVALID_QUESTION_SKIPPED'}); continue;
      }
      const item = {cq_ref:'Q'+String(items.length+1).padStart(2,'0'),question:original.question};
      for (const key of ['source_hint','notes']) if (Object.hasOwn(original,key)) {
        if (textField(original[key])) item[key] = original[key]; else warn(index,'CQ_OPTIONAL_FIELD_IGNORED',key);
      }
      const allowed = ['question','source_hint','notes','source_doc_refs','source_unknown_reason'];
      // The legacy form may still explicitly select documents; revisions/receipts remain Host-owned.
      const explicit = original.source_doc_refs ?? (saveContract === LEGACY_SAVE_CONTRACT && Array.isArray(original.source_refs)
        ? original.source_refs.map(r => r?.doc_ref) : undefined);
      for (const key of Object.keys(original)) if (!allowed.includes(key)) warn(index,'CQ_EXTRA_FIELD_IGNORED',key);
      if (explicit !== undefined && !Array.isArray(explicit)) warn(index,'CQ_SOURCE_SELECTION_INVALID','source_doc_refs');
      const selected = new Set(), source_refs = [], read_receipt_refs = [];
      for (const docRef of Array.isArray(explicit) ? explicit : []) {
        if (!textField(docRef)) { warn(index,'CQ_SOURCE_SELECTION_INVALID','source_doc_refs'); continue; }
        if (selected.has(docRef)) { warn(index,'CQ_DUPLICATE_SOURCE_IGNORED','source_doc_refs'); continue; }
        selected.add(docRef);
        const doc = source.documents.find(d => d.doc_id === docRef);
        if (!doc) {warn(index,'CQ_UNKNOWN_DOCUMENT','source_doc_refs');continue;}
        const reads = verifiedReads.filter(r => sameSource(r.source_ref,{doc_ref:docRef,revision:doc.revision}));
        if (!reads.length) {warn(index,'CQ_UNREAD_DOCUMENT','source_doc_refs');continue;}
        source_refs.push({doc_ref:docRef,revision:doc.revision});read_receipt_refs.push(...reads.map(r => r.read_receipt_ref));
      }
      Object.assign(item,{source_status:source_refs.length ? 'KNOWN' : 'UNKNOWN',source_refs,read_receipt_refs});
      if (!source_refs.length) {
        item.source_unknown_reason = textField(original.source_unknown_reason) ? original.source_unknown_reason : '未绑定可靠的逐题来源；本轮真实资料与读取上下文另存。';
        warn(index,'CQ_SOURCE_UNKNOWN');
      } else if (Object.hasOwn(original,'source_unknown_reason')) warn(index,'CQ_UNUSED_UNKNOWN_REASON_IGNORED','source_unknown_reason');
      items.push(item);processing_results.push({index,status:'ACCEPTED',cq_ref:item.cq_ref,warning_count:warnings.length-start});
    }
    if (!items.length) warn(null,'CQ_NO_USABLE_ITEMS');
    const processing_summary = {received:inputItems.length,accepted:items.length,skipped:inputItems.length-items.length,
      unknown_sources:items.filter(i => i.source_status === 'UNKNOWN').length,warning_count:warnings.length,all_skipped:items.length===0};
    const cq_proposal_ref = 'native_cq_proposal_'+hash({binding,rawHash,knowledgeBuildPolicy});
    const cq_input = {input_ref:'native_cq_input_'+hash({binding,rawHash,knowledgeBuildPolicy}),run_id:runId,source_snapshot_ref:snapshotId,items};
    const proposal = {proposal_ref:cq_proposal_ref,run_id:runId,knowledge_build_policy:knowledgeBuildPolicy,agent_input:clone(args),
      source_context,cq_input_ref:cq_input.input_ref,processing_summary,warnings,processing_results};
    need(!store.getRecord(PROPOSAL,cq_proposal_ref) && !store.getRecord(INPUT,cq_input.input_ref),'NATIVE_CQ_INPUT_CONFLICT');
    store.putRecord(PROPOSAL,cq_proposal_ref,proposal);store.putRecord(INPUT,cq_input.input_ref,cq_input);
    const saved = {...state,cq_input,cq_input_hash:rawHash,cq_agent_input:clone(args),cq_proposal_ref,source_context,processing_summary,warnings,processing_results};
    store.putRecord(STATE,runId,saved);return receipt(saved);
  }
  function snapshot() {
    const state = clone(load());
    const documents = source.documents.map(doc => {
      const units = state.reads.filter(r => r.source_ref.doc_ref === doc.doc_id && r.source_ref.revision === doc.revision).flatMap(r => r.result.units);
      const blocks = doc.blocks.map(block => {
        const ranges = mergeRanges(units.filter(u => u.block_id === block.block_id).map(u => ({start:u.start,end:u.end})));
        const covered_chars = ranges.reduce((n,r) => n + r.end - r.start, 0);
        return {block_id:block.block_id, start:block.start, end:block.end, covered_chars, read_ranges:ranges};
      });
      const total_chars = blocks.reduce((n,b) => n + b.end - b.start, 0), read_chars = blocks.reduce((n,b) => n + b.covered_chars, 0);
      return {doc_ref:doc.doc_id, revision:doc.revision, total_chars, read_chars, scan_status:read_chars === 0 ? 'UNREAD' : read_chars === total_chars ? 'COMPLETE' : 'PARTIAL', blocks};
    });
    return {...state, documents, scan_status:documents.length > 0 && documents.every(d => d.scan_status === 'COMPLETE') ? 'COMPLETE' : documents.some(d => d.read_chars > 0) ? 'PARTIAL' : 'NOT_STARTED'};
  }
  return {definitions:() => definitions(saveContract,readContract,knowledgeBuildPolicy), snapshot, call(name, args = {}) {
    try { return store.transaction(() => { need(TOOLS.includes(name), 'NATIVE_CQ_TOOL_FORBIDDEN'); return {ok:true, result:name === TOOLS[0] ? list(args) : name === TOOLS[1] ? read(args) : save(args)}; }); }
    catch (error) { return {ok:false, error:{code:error.code ?? 'NATIVE_CQ_TOOL_FAILED'}}; }
  }};
}
