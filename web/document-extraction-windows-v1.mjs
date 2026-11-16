/** Deterministic, source-bound extraction windows. No semantic inference or model calls. */
import {hash, need, clone, textField} from './cq-discovery-store-v2.mjs';

const WINDOW = 'native_extraction_window_v1';
const READ = 'native_read_receipt_v1';
const EVIDENCE = 'native_evidence_v1';
const PART = 'native_source_unit_part_v1';
const VERSION = 'document-extraction-windows/1';
const SPLIT_VERSION = 'source-unit-natural-split/1';
const OFFSET = 'utf16_code_unit';
const scalarBoundary = (text, n) => n === 0 || n === text.length || !(text.charCodeAt(n - 1) >= 0xd800 && text.charCodeAt(n - 1) <= 0xdbff && text.charCodeAt(n) >= 0xdc00 && text.charCodeAt(n) <= 0xdfff);
const positive = (value, fallback, code) => {const n = value ?? fallback; need(Number.isSafeInteger(n) && n > 0, code); return n;};
const encodeCursor = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function position(cursor, binding, size) {
  if (cursor === undefined || cursor === null || cursor === '') return 0;
  let value;
  try {value = JSON.parse(Buffer.from(cursor, 'base64url').toString());} catch {need(false, 'NATIVE_WINDOW_CURSOR_INVALID');}
  need(value?.binding === binding && Number.isSafeInteger(value.position) && value.position >= 0 && value.position <= size, 'NATIVE_WINDOW_CURSOR_INVALID');
  return value.position;
}

export function createDocumentExtractionWindows({store, catalog, libraryId, snapshotId, runId, assertOpen = () => {}}) {
  need(store && catalog && [libraryId, snapshotId, runId].every(textField), 'NATIVE_WINDOW_CONTEXT_INVALID');
  const authority = {run_id:runId, library_id:libraryId, source_snapshot_ref:snapshotId};
  function source({checkOpen = true} = {}) {
    if (checkOpen) assertOpen();
    need(catalog.isCurrent(snapshotId, libraryId), 'NATIVE_WINDOW_SOURCE_STALE');
    const value = catalog.get(snapshotId, libraryId);
    need(value?.snapshot_id === snapshotId && Array.isArray(value.documents), 'NATIVE_WINDOW_SOURCE_INVALID');
    return value;
  }
  function document(docRef, revision, options) {
    need(textField(docRef) && textField(revision), 'NATIVE_WINDOW_DOCUMENT_REQUIRED');
    const d = source(options).documents.find(d => d.doc_id === docRef);
    need(d && d.revision === revision, 'NATIVE_WINDOW_DOCUMENT_FORBIDDEN');
    return d;
  }
  function units(d) {
    need(typeof d.content === 'string' && d.content.isWellFormed() && Array.isArray(d.blocks), 'NATIVE_WINDOW_SOURCE_INVALID');
    const ids = new Set(); let previous = 0;
    return d.blocks.map(b => {
      need(textField(b.block_id) && !ids.has(b.block_id) && Number.isSafeInteger(b.start) && Number.isSafeInteger(b.end) && b.start >= previous && b.end > b.start && b.end <= d.content.length && scalarBoundary(d.content, b.start) && scalarBoundary(d.content, b.end), 'NATIVE_WINDOW_SOURCE_UNIT_INVALID');
      ids.add(b.block_id); previous = b.end;
      const value = {doc_ref:d.doc_id, revision:d.revision, block_id:b.block_id, kind:b.kind ?? 'text', start:b.start, end:b.end, offset_unit:OFFSET};
      return {...value, unit_ref:'unit_' + hash([snapshotId, value]), text:d.content.slice(b.start, b.end), provenance:clone(b.provenance ?? []), ...(b.table_geometry ? {table_geometry:clone(b.table_geometry)} : {})};
    });
  }
  function warnings(d) {
    return [...clone(d.warnings ?? []), ...(d.parser ? ['解析文字及页码/bbox来自解析器；引句匹配不等于核实原件。'] : []), '窗口基于目录的扁平来源块；未加载完整Docling树/cell，未暴露的原始解析告警不能视为不存在。'];
  }
  function append(kind, ref, value) {
    const old = store.getRecord(kind, ref);
    if (old) {need(hash(old) === hash(value), 'NATIVE_WINDOW_IMMUTABLE_CONFLICT'); return old;}
    store.putRecord(kind, ref, clone(value)); return value;
  }
  function validRecord(kind, ref) {
    const record = store.getRecord(kind, ref);
    need(record && Object.entries(authority).every(([k,v]) => record[k] === v), 'NATIVE_WINDOW_RECORD_FORBIDDEN');
    const {record_sha256, ...payload} = record;
    need(record_sha256 === hash(payload), 'NATIVE_WINDOW_RECORD_CHANGED');
    return record;
  }
  const sealed = payload => ({...payload, record_sha256:hash(payload)});
  function partValue(record) {
    return Object.fromEntries(['unit_ref','parent_unit_ref','doc_ref','revision','block_id','kind','start','end','offset_unit','text','provenance','table_geometry','required_context_refs','part_role']
      .filter(key => Object.hasOwn(record, key)).map(key => [key, clone(record[key])]));
  }
  function resolveUnit(d, ref) {
    const original = units(d), whole = original.find(u => u.unit_ref === ref);
    if (whole) return whole;
    const record = validRecord(PART, ref), parent = original.find(u => u.unit_ref === record.parent_unit_ref);
    need(record.unit_ref === ref && parent && record.doc_ref === d.doc_id && record.revision === d.revision && record.block_id === parent.block_id &&
      record.parent_unit_sha256 === hash(parent) && Number.isSafeInteger(record.start) && Number.isSafeInteger(record.end) && record.start >= parent.start && record.end > record.start && record.end <= parent.end &&
      scalarBoundary(d.content, record.start) && scalarBoundary(d.content, record.end) && record.text === d.content.slice(record.start, record.end) &&
      hash(record.provenance) === hash(parent.provenance), 'NATIVE_WINDOW_PART_SOURCE_CHANGED');
    return partValue(record);
  }
  function splitGap(d, unit, cap, code, requiredChars) {
    return {accepted:false, status:'SPLIT_GAP', units:[], gaps:[{code, unit_ref:unit.unit_ref, doc_ref:d.doc_id, revision:d.revision, required_chars:requiredChars, max_chars:cap}],
      warnings:[...warnings(d), '该来源单元无法在当前预算内保持完整自然边界；未切断内容，需扩大预算或补充结构适配。'], body_returned:false, read_receipt_ref:null};
  }
  function naturalRanges(text, start, end, cap, tier = 0) {
    if (end - start <= cap) return {ranges:[{start,end}], gaps:[]};
    const patterns = [/\r?\n[ \t]*\r?\n+/gu, /[。！？!?]+[”’"')）]*[ \t]*(?:\r?\n)?|\.(?=\s|$)[ \t]*(?:\r?\n)?/gu, /\r?\n/gu];
    if (tier >= patterns.length) return {ranges:[], gaps:[{start,end}]};
    const section = text.slice(start,end), boundaries = [...section.matchAll(patterns[tier])].map(match => start + match.index + match[0].length).filter(n => n > start && n < end);
    if (!boundaries.length) return naturalRanges(text,start,end,cap,tier + 1);
    let from = start; const atoms = [], gaps = [];
    for (const to of [...boundaries,end]) {
      const result = naturalRanges(text,from,to,cap,tier + 1); atoms.push(...result.ranges); gaps.push(...result.gaps); from = to;
    }
    const ranges = [];
    for (const atom of atoms) {
      const previous = ranges.at(-1);
      if (previous && previous.end === atom.start && atom.end - previous.start <= cap) previous.end = atom.end;
      else ranges.push({...atom});
    }
    return {ranges,gaps};
  }
  function splitUnit({doc_ref, revision, unit_ref, max_chars} = {}) {
    const d = document(doc_ref, revision), cap = positive(max_chars, null, 'NATIVE_WINDOW_CHAR_BUDGET_REQUIRED');
    const unit = units(d).find(u => u.unit_ref === unit_ref); need(unit, 'NATIVE_WINDOW_UNIT_FORBIDDEN');
    let ranges, headerRanges = [];
    if (unit.kind === 'table' && unit.text.length > cap) {
      const lines = [...unit.text.matchAll(/[^\n]*(?:\n|$)/gu)].filter(match => match[0].length).map(match => ({start:match.index, end:match.index + match[0].length, text:match[0]}));
      const meaningful = lines.filter(line => line.text.trim());
      const separator = line => /^\s*\|?(?:[ \t]*:?-{3,}:?[ \t]*\|)+[ \t]*:?-{3,}:?[ \t]*\|?\s*$/u.test(line) || /^\s*\|[ \t]*:?-{3,}:?[ \t]*\|\s*$/u.test(line);
      if (meaningful.length < 2 || !meaningful[0].text.trim().startsWith('|') || !separator(meaningful[1].text) || meaningful.slice(2).some(line => !line.text.trim().startsWith('|')))
        return splitGap(d,unit,cap,'TABLE_STRUCTURE_UNRESOLVED',unit.text.length);
      const wide = lines.find(line => line.end - line.start > cap);
      if (wide) return splitGap(d,unit,cap,'TABLE_ROW_EXCEEDS_BUDGET',wide.end - wide.start);
      const headerEnd = meaningful[1].end;
      headerRanges = lines.filter(line => line.start < headerEnd).map(({start,end}) => ({start,end}));
      ranges = [...headerRanges];
      for (const line of lines.filter(line => line.start >= headerEnd)) {
        const previous = ranges.at(-1);
        if (previous && previous.start >= headerEnd && line.end - previous.start <= cap) previous.end = line.end;
        else ranges.push({start:line.start,end:line.end});
      }
    } else {
      const result = naturalRanges(unit.text,0,unit.text.length,cap);
      if (result.gaps.length) return splitGap(d,unit,cap,'NATURAL_BOUNDARY_EXCEEDS_BUDGET',Math.max(...result.gaps.map(gap => gap.end - gap.start)));
      ranges = result.ranges;
    }
    const descriptors = ranges.map(range => ({...range, unit_ref:'unit_part_' + hash([authority, SPLIT_VERSION, unit.unit_ref, unit.start + range.start, unit.start + range.end])}));
    const headerRefs = descriptors.filter(part => headerRanges.some(header => header.start === part.start && header.end === part.end)).map(part => part.unit_ref);
    const records = descriptors.map(part => {
      const isHeader = headerRefs.includes(part.unit_ref), {unit_ref:parentRef, ...original} = unit;
      return sealed({...authority, ...original, unit_ref:part.unit_ref, parent_unit_ref:parentRef, start:unit.start + part.start, end:unit.start + part.end,
        text:unit.text.slice(part.start,part.end), required_context_refs:isHeader ? [] : headerRefs, part_role:isHeader ? 'TABLE_HEADER' : unit.kind === 'table' ? 'TABLE_ROWS' : 'TEXT',
        parent_unit_sha256:hash(unit), split_strategy_version:SPLIT_VERSION});
    });
    store.transaction(() => {for (const record of records) append(PART, record.unit_ref, record);});
    return {accepted:true, status:'SPLIT_READY', units:records.map(record => {const {text,...metadata} = partValue(record); return {...metadata, chars:text.length};}),
      warnings:warnings(d), gaps:[], body_returned:false, read_receipt_ref:null, split_strategy_version:SPLIT_VERSION, max_chars:cap};
  }
  function rejectBudget(d, selected, charCap, tokenBudget) {
    const text = selected.map(u => u.text).join('\n\n'), estimated = Buffer.byteLength(text, 'utf8');
    if (text.length <= charCap && (tokenBudget === null || estimated <= tokenBudget)) return null;
    return {accepted:false, status:'BUDGET_EXCEEDED', code:'NATIVE_WINDOW_BUDGET_EXCEEDED', doc_ref:d.doc_id, revision:d.revision,
      required_chars:text.length, estimated_tokens:estimated, token_estimate_strategy:'utf8-byte-upper-bound/1', max_chars:charCap, token_budget:tokenBudget,
      suggestions:[{action:'SELECT_FEWER_COMPLETE_UNITS', unit_refs:selected.map(u => u.unit_ref)}, {action:'INCREASE_EXPLICIT_BUDGET', required_chars:text.length, estimated_tokens:estimated}],
      truncated:false, read_receipt_ref:null, window_ref:null, warnings:warnings(d)};
  }
  function saveWindow(d, selected, coreRefs, operation, args, budget) {
    let text = ''; const inputSegments = [], spans = [];
    for (const u of selected) {
      if (text) text += '\n\n';
      const start = text.length; text += u.text;
      const role = coreRefs.has(u.unit_ref) ? 'CORE' : 'CONTEXT';
      const span = {unit_ref:u.unit_ref, ...(u.parent_unit_ref ? {parent_unit_ref:u.parent_unit_ref} : {}), doc_ref:u.doc_ref, revision:u.revision, block_id:u.block_id, start:u.start, end:u.end, offset_unit:OFFSET, role, provenance:clone(u.provenance)};
      spans.push(span);
      inputSegments.push({input_start:start, input_end:text.length, source_span_index:spans.length - 1, unit_ref:u.unit_ref, role});
    }
    const payload = {...authority, contract_version:VERSION, doc_ref:d.doc_id, revision:d.revision, text, units:clone(selected), source_spans:spans, input_segments:inputSegments,
      offset_unit:OFFSET, estimated_tokens:Buffer.byteLength(text, 'utf8'), token_estimate_strategy:'utf8-byte-upper-bound/1', budget, warnings:warnings(d), structure_status:'FLAT_CATALOG_BLOCKS'};
    const windowRef = 'window_' + hash(payload), window = sealed({...payload, window_ref:windowRef});
    const readPayload = {...authority, operation, args:clone(args), window_ref:windowRef, source_spans:clone(spans), body_returned:selected.length > 0};
    const readRef = 'read_' + hash(readPayload), receipt = sealed({...readPayload, read_receipt_ref:readRef});
    store.transaction(() => {append(WINDOW, windowRef, window); append(READ, readRef, receipt);});
    return {...clone(window), accepted:true, read_receipt_ref:readRef, returned_chars:text.length};
  }
  function listUnits({doc_ref, revision, cursor, max_units} = {}) {
    const s = source();
    need(doc_ref !== undefined || revision === undefined, 'NATIVE_WINDOW_DOCUMENT_REQUIRED');
    const docs = doc_ref === undefined ? s.documents : s.documents.filter(d => d.doc_id === doc_ref && (revision === undefined || d.revision === revision));
    need(doc_ref === undefined || docs.length === 1, 'NATIVE_WINDOW_DOCUMENT_FORBIDDEN');
    const all = docs.flatMap(units), cap = positive(max_units, 100, 'NATIVE_WINDOW_PAGE_LIMIT_INVALID');
    const binding = hash([authority, 'list', doc_ref ?? null, revision ?? null]), start = position(cursor, binding, all.length);
    const page = all.slice(start, start + cap).map(({text, ...unit}) => ({...unit, chars:text.length}));
    return {source_snapshot_ref:snapshotId, units:page, total_units:all.length, next_cursor:start + page.length < all.length ? encodeCursor({binding, position:start + page.length}) : null,
      read_mode:'UNIT_DIRECTORY_ONLY', body_returned:false, offset_unit:OFFSET, structure_status:'FLAT_CATALOG_BLOCKS'};
  }
  function read({doc_ref, revision, cursor, max_chars} = {}) {
    const d = document(doc_ref, revision), all = units(d), cap = positive(max_chars, 64000, 'NATIVE_WINDOW_CHAR_BUDGET_INVALID');
    const binding = hash([authority, 'read', doc_ref, revision]), start = position(cursor, binding, all.length);
    const selected = []; let length = 0;
    for (const unit of all.slice(start)) {
      const next = length + (selected.length ? 2 : 0) + unit.text.length;
      if (next > cap) break;
      selected.push(unit); length = next;
    }
    if (!selected.length && start < all.length) return rejectBudget(d, [all[start]], cap, null);
    const result = saveWindow(d, selected, new Set(selected.map(u => u.unit_ref)), 'read', {doc_ref, revision, cursor:cursor ?? null, max_chars:cap}, {max_chars:cap, token_budget:null});
    return {...result, complete:start + selected.length === all.length, whole_document:start === 0 && selected.length === all.length, page_complete:true,
      next_cursor:start + selected.length < all.length ? encodeCursor({binding, position:start + selected.length}) : null};
  }
  function assemble({doc_ref, revision, core_unit_refs, context_unit_refs = [], max_chars, token_budget} = {}) {
    const d = document(doc_ref, revision);
    need(Array.isArray(core_unit_refs) && core_unit_refs.length > 0 && Array.isArray(context_unit_refs), 'NATIVE_WINDOW_SELECTION_REQUIRED');
    const refs = [...core_unit_refs, ...context_unit_refs];
    need(refs.every(textField) && new Set(refs).size === refs.length, 'NATIVE_WINDOW_UNIT_FORBIDDEN');
    let selected;
    try {selected = refs.map(ref => resolveUnit(d,ref)).sort((a,b) => a.start - b.start || a.end - b.end);} catch (error) {
      if (error.code === 'NATIVE_WINDOW_RECORD_FORBIDDEN') need(false, 'NATIVE_WINDOW_UNIT_FORBIDDEN'); throw error;
    }
    need(selected.every((unit,i) => i === 0 || selected[i - 1].end <= unit.start), 'NATIVE_WINDOW_UNIT_OVERLAP');
    const charCap = max_chars === undefined ? Number.MAX_SAFE_INTEGER : positive(max_chars, null, 'NATIVE_WINDOW_CHAR_BUDGET_INVALID');
    const tokenBudget = token_budget === undefined ? null : positive(token_budget, null, 'NATIVE_WINDOW_TOKEN_BUDGET_INVALID');
    const rejected = rejectBudget(d, selected, charCap, tokenBudget); if (rejected) return rejected;
    return saveWindow(d, selected, new Set(core_unit_refs), 'assemble', {doc_ref, revision, core_unit_refs:clone(core_unit_refs), context_unit_refs:clone(context_unit_refs)}, {max_chars:charCap, token_budget:tokenBudget});
  }
  function bindPlan(plan) {
    const d=document(plan.doc_ref,plan.revision),original=units(d),core=plan.core_units??[],context=plan.context_units??[];
    need(core.length>0&&Number.isSafeInteger(plan.token_budget)&&plan.token_budget>0,'NATIVE_WINDOW_PLAN_BINDING_INVALID');
    const actualRefs=new Map();
    for(const unit of [...core,...context]){
      const parent=original.find(u=>u.block_id===unit.block_id);
      need(parent&&unit.doc_ref===d.doc_id&&unit.revision===d.revision&&unit.start>=parent.start&&unit.end<=parent.end&&unit.end>unit.start&&scalarBoundary(d.content,unit.start)&&scalarBoundary(d.content,unit.end)&&unit.text===d.content.slice(unit.start,unit.end),'NATIVE_WINDOW_PLAN_SOURCE_CHANGED');
      if(unit.unit_ref===parent.unit_ref){need(unit.start===parent.start&&unit.end===parent.end,'NATIVE_WINDOW_PLAN_SOURCE_CHANGED');actualRefs.set(unit.unit_ref,parent.unit_ref);continue;}
      const ref='unit_part_'+hash([authority,parent.unit_ref,unit.start,unit.end,'planned-window-part/1']);actualRefs.set(unit.unit_ref,ref);
      append(PART,ref,sealed({...authority,...parent,unit_ref:ref,parent_unit_ref:parent.unit_ref,start:unit.start,end:unit.end,text:unit.text,
        required_context_refs:[],part_role:unit.part_role??'TEXT',parent_unit_sha256:hash(parent),split_strategy_version:'native-extraction-window-plan/1'}));
    }
    const read=assemble({doc_ref:d.doc_id,revision:d.revision,core_unit_refs:core.map(u=>actualRefs.get(u.unit_ref)),context_unit_refs:context.map(u=>actualRefs.get(u.unit_ref))});
    if(plan.token_count_strategy==='utf8-byte-upper-bound/1')need(Buffer.byteLength(read.text,'utf8')<=plan.token_budget,'NATIVE_WINDOW_PLAN_BUDGET_CHANGED');
    need(read.accepted!==false,'NATIVE_WINDOW_PLAN_BINDING_INVALID');return read;
  }
  function locateEvidence({window_ref, unit_ref, quote, occurrence} = {}) {
    source(); need(textField(window_ref) && textField(unit_ref) && textField(quote), 'NATIVE_EVIDENCE_INPUT_INVALID');
    const window = validRecord(WINDOW, window_ref), unit = window.units.find(u => u.unit_ref === unit_ref);
    need(unit, 'NATIVE_EVIDENCE_UNIT_FORBIDDEN');
    const d = document(unit.doc_ref, unit.revision), current = resolveUnit(d,unit_ref);
    need(current && hash(current) === hash(unit), 'NATIVE_WINDOW_RECORD_CHANGED');
    const matches = []; let at = 0;
    while ((at = unit.text.indexOf(quote, at)) !== -1) {if (scalarBoundary(unit.text, at) && scalarBoundary(unit.text, at + quote.length)) matches.push(at); at++;}
    need(matches.length > 0, 'NATIVE_EVIDENCE_QUOTE_NOT_FOUND');
    if (matches.length > 1 && occurrence === undefined) {
      const error = Object.assign(Error('NATIVE_EVIDENCE_AMBIGUOUS'), {code:'NATIVE_EVIDENCE_AMBIGUOUS', status:409,
        occurrences:matches.map((offset, i) => ({occurrence:i + 1, start:unit.start + offset, end:unit.start + offset + quote.length, offset_unit:OFFSET}))});
      throw error;
    }
    const chosen = occurrence ?? 1;
    need(Number.isSafeInteger(chosen) && chosen >= 1 && chosen <= matches.length, 'NATIVE_EVIDENCE_OCCURRENCE_INVALID');
    const start = unit.start + matches[chosen - 1], end = start + quote.length;
    const span = {unit_ref, ...(unit.parent_unit_ref ? {parent_unit_ref:unit.parent_unit_ref} : {}), doc_ref:unit.doc_ref, revision:unit.revision, block_id:unit.block_id, start, end, offset_unit:OFFSET, provenance:clone(unit.provenance)};
    const payload = {...authority, window_ref, unit_ref, doc_ref:unit.doc_ref, revision:unit.revision, block_id:unit.block_id, quote, start, end, offset_unit:OFFSET,
      occurrence:chosen, source_spans:[span], provenance:clone(unit.provenance), warnings:clone(window.warnings), representation:'VERBATIM_SOURCE', semantic_support_certified:false};
    const evidenceRef = 'evidence_' + hash(payload), record = sealed({...payload, evidence_ref:evidenceRef});
    store.transaction(() => append(EVIDENCE, evidenceRef, record)); return clone(record);
  }
  function snapshot() {
    const s = catalog.get(snapshotId, libraryId), all = s.documents.flatMap(units), reads = store.listRecords(READ).filter(r => Object.entries(authority).every(([k,v]) => r[k] === v));
    for (const read of reads) validRecord(READ, read.read_receipt_ref);
    const spans = reads.flatMap(r => r.source_spans), coverage = all.map(unit => {
      const ranges = spans.filter(span => span.doc_ref === unit.doc_ref && span.revision === unit.revision && span.block_id === unit.block_id && span.start < unit.end && span.end > unit.start)
        .map(span => ({start:Math.max(unit.start,span.start), end:Math.min(unit.end,span.end)})).sort((a,b) => a.start - b.start);
      let end = unit.start, readChars = 0;
      for (const range of ranges) {readChars += Math.max(0,range.end - Math.max(range.start,end)); end = Math.max(end,range.end);}
      return {unit_ref:unit.unit_ref, doc_ref:unit.doc_ref, revision:unit.revision, start:unit.start, end:unit.end, read_chars:readChars,
        status:readChars === 0 ? 'NOT_STARTED' : readChars === unit.end - unit.start ? 'SCAN_COMPLETE' : 'PARTIAL'};
    });
    const readUnits = coverage.filter(unit => unit.status === 'SCAN_COMPLETE'), readChars = coverage.reduce((total,unit) => total + unit.read_chars,0);
    return { ...authority, source_current:catalog.isCurrent(snapshotId, libraryId), reads:clone(reads), total_units:all.length, read_unit_count:readUnits.length, coverage,
      partial_unit_count:coverage.filter(unit => unit.status === 'PARTIAL').length, read_chars:readChars,
      unread_unit_refs:coverage.filter(unit => unit.status !== 'SCAN_COMPLETE').map(unit => unit.unit_ref), scan_status:readChars === 0 ? 'NOT_STARTED' : readUnits.length === all.length ? 'SCAN_COMPLETE' : 'PARTIAL',
      semantic_coverage_certified:false, windows:store.listRecords(WINDOW).filter(w => Object.entries(authority).every(([k,v]) => w[k] === v)).map(w => {validRecord(WINDOW, w.window_ref); return clone(w);})};
  }
  return {listUnits, read, splitUnit, assemble, bindPlan, locateEvidence, snapshot};
}
