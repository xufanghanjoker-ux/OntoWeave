import {bindNativeBlockCQContext} from './native-block-cq-context-v4.mjs';
/** Pure, source-bound extraction work planning. No models, storage, or semantic merging. */
import {hash, clone, need, textField} from './cq-discovery-store-v2.mjs';

export const NATIVE_EXTRACTION_WINDOW_PLAN_VERSION = 'native-extraction-window-plan/1';
export const DEFAULT_NATIVE_EXTRACTION_WINDOW_TOKENS = 8000;
export const DEFAULT_NATIVE_EXTRACTION_CONCURRENCY = 4;
export const UTF8_UPPER_BOUND_TOKEN_METER = Object.freeze({
  strategy: 'utf8-byte-upper-bound/1', exact: false,
  count: text => Buffer.byteLength(text, 'utf8')
});
const OFFSET = 'utf16_code_unit';
const heading = unit => /heading|title|section_header/.test(unit.kind);
const scalar = (text, n) => n === 0 || n === text.length || !(/[\uD800-\uDBFF]/.test(text[n - 1]) && /[\uDC00-\uDFFF]/.test(text[n]));
const unitKey = u => JSON.stringify([u.doc_ref, u.revision, u.block_id, u.start, u.end]);
const unique = units => [...new Map(units.map(u => [unitKey(u), u])).values()];
const overlaps = (a, b) => a.block_id === b.block_id && a.start < b.end && b.start < a.end;
const sourcesOf = item => Array.isArray(item.source_refs) ? item.source_refs : [];

/**
 * 8k bounds material text: core source plus copied source headings/table headers.
 * Skill, tool schemas, CQ context and output allowance need a separate request gate.
 * An injected exact meter must declare a stable strategy (including tokenizer version).
 */
export function createNativeExtractionWindowPlan({snapshot, cqInput = {items: []}, families = {families: []},
  windowTokens, window_tokens, tokenMeter = UTF8_UPPER_BOUND_TOKEN_METER} = {}) {
  need(snapshot && textField(snapshot.snapshot_id) && Array.isArray(snapshot.documents), 'NATIVE_WINDOW_PLAN_SNAPSHOT_INVALID');
  const budget = windowTokens ?? window_tokens ?? DEFAULT_NATIVE_EXTRACTION_WINDOW_TOKENS;
  need(Number.isSafeInteger(budget) && budget > 0, 'NATIVE_WINDOW_PLAN_BUDGET_INVALID');
  need(tokenMeter && typeof tokenMeter.count === 'function' && textField(tokenMeter.strategy) && typeof tokenMeter.exact === 'boolean', 'NATIVE_WINDOW_PLAN_METER_INVALID');
  need(Array.isArray(cqInput.items) && Array.isArray(families.families), 'NATIVE_WINDOW_PLAN_CQ_INPUT_INVALID');
  const count = text => {const n = tokenMeter.count(text); need(Number.isSafeInteger(n) && n >= 0 && (!text.length || n > 0), 'NATIVE_WINDOW_PLAN_TOKEN_COUNT_INVALID'); return n;};
  const config = {version: NATIVE_EXTRACTION_WINDOW_PLAN_VERSION, window_tokens: budget, max_concurrency: DEFAULT_NATIVE_EXTRACTION_CONCURRENCY,
    token_count_strategy: tokenMeter.strategy, token_count_exact: tokenMeter.exact,
    heading_preference_min_tokens: Math.floor(budget / 2),
    budget_scope: 'CORE_AND_SOURCE_CONTEXT_TEXT_ONLY', offset_unit: OFFSET};
  const fingerprint = hash({snapshot, config, cqInput, families});
  const planRef = 'extraction_plan_' + fingerprint;
  const windows = [], gaps = [], coverage = [], documentIds = new Set();
  const warnEstimate = tokenMeter.exact ? [] : ['TOKEN_COUNT_IS_CONSERVATIVE_ESTIMATE_NOT_MODEL_TOKENIZER'];
  const gap = (unit, code, detail = {}) => gaps.push({code, doc_ref: unit.doc_ref, revision: unit.revision, block_id: unit.block_id,
    start: unit.start, end: unit.end, offset_unit: OFFSET, text_sha256: hash(unit.text), ...detail});
  const familyRows = families.families;
  const cqByDoc = doc => cqInput.items.filter(q => sourcesOf(q).some(s => s.doc_ref === doc.doc_id && (!s.revision || s.revision === doc.revision)));
  const cleanContexts = (core, context) => unique(context).filter(c => !core.some(u => overlaps(c, u))).sort((a, b) => a.start - b.start || a.end - b.end);
  const material = (core, context) => [...cleanContexts(core, context), ...core].map(u => u.text).join('\n\n');
  const fits = (core, context) => count(material(core, context)) <= budget;
  function emit(doc, core, context, warnings) {
    if (!core.length) return;
    context = cleanContexts(core, context);
    const text = material(core, context), token_count = count(text);
    need(token_count <= budget, 'NATIVE_WINDOW_PLAN_INTERNAL_OVERFLOW');
    const items = cqByDoc(doc), refs = new Set(items.map(q => q.cq_ref));
    const selectedFamilies = familyRows.filter(f => Array.isArray(f.member_refs) && f.member_refs.some(ref => refs.has(ref)))
      .map(f => ({...clone(f), matched_member_refs: f.member_refs.filter(ref => refs.has(ref))}));
    const identity = {source_snapshot_ref: snapshot.snapshot_id, doc_ref: doc.doc_id, revision: doc.revision,
      core_spans: core.map(({block_id, start, end}) => ({block_id, start, end})), context_spans: context.map(({block_id, start, end}) => ({block_id, start, end})), config, cq_refs: [...refs], family_refs: selectedFamilies.map(f => f.family_ref ?? hash(f))};
    windows.push({window_ref: 'extraction_work_' + hash({plan_ref: planRef, ...identity}), plan_ref: planRef, ...identity, title: doc.title ?? '',
      core_units: clone(core), context_units: clone(context), text, token_count, estimated_tokens: token_count,
      token_budget: budget, token_count_strategy: tokenMeter.strategy, token_count_exact: tokenMeter.exact,
      cq_items: clone(items), families: selectedFamilies,
      source_refs: [{doc_ref: doc.doc_id, revision: doc.revision}],
      warnings: [...new Set([...warnEstimate, ...(doc.warnings ?? []), ...warnings])], status: 'PENDING'});
  }
  for (const doc of snapshot.documents) {
    need(textField(doc.doc_id) && !documentIds.has(doc.doc_id) && textField(doc.revision) && typeof doc.content === 'string' && doc.content.isWellFormed() && Array.isArray(doc.blocks), 'NATIVE_WINDOW_PLAN_DOCUMENT_INVALID');
    documentIds.add(doc.doc_id);
    let previous = 0;
    const blockIds = new Set();
    const units = doc.blocks.map(block => {
      need(textField(block.block_id) && !blockIds.has(block.block_id) && Number.isSafeInteger(block.start) && Number.isSafeInteger(block.end) && block.start >= previous && block.end > block.start && block.end <= doc.content.length && scalar(doc.content, block.start) && scalar(doc.content, block.end), 'NATIVE_WINDOW_PLAN_BLOCK_INVALID');
      blockIds.add(block.block_id); previous = block.end;
      const body = {doc_ref: doc.doc_id, revision: doc.revision, block_id: block.block_id, kind: block.kind ?? 'text', start: block.start, end: block.end, offset_unit: OFFSET};
      return {...body, unit_ref: 'unit_' + hash([snapshot.snapshot_id, body]), text: doc.content.slice(block.start, block.end), provenance: clone(block.provenance ?? []), ...(block.table_geometry ? {table_geometry: clone(block.table_geometry)} : {})};
    });
    let path = [], core = [], context = [], warnings = [];
    const flush = () => {emit(doc, core, context, warnings); core = []; context = []; warnings = [];};
    const part = (unit, start, end, role = 'TEXT') => {
      const body = {...unit, start, end, text: doc.content.slice(start, end), parent_unit_ref: unit.unit_ref, part_role: role};
      body.unit_ref = 'unit_part_' + hash([planRef, doc.doc_id, doc.revision, unit.block_id, start, end]);
      return body;
    };
    function headingContext(unit, required = []) {
      const result = [...path];
      while (result.length && !fits([unit], [...result, ...required])) result.shift();
      return {context: result, warnings: result.length < path.length ? ['HEADING_CONTEXT_OMITTED_FOR_BUDGET'] : []};
    }
    function add(piece, required = [], extraWarnings = []) {
      const h = headingContext(piece, required), requested = unique([...h.context, ...required]);
      if (!fits([piece], requested)) {flush(); gap(piece, 'SOURCE_WITH_REQUIRED_CONTEXT_EXCEEDS_WINDOW'); return;}
      if (core.length && !fits([...core, piece], [...context, ...requested])) flush();
      core.push(piece); context = unique([...context, ...requested]); warnings.push(...h.warnings, ...extraWarnings);
    }
    function splitText(unit) {
      flush();
      const context = [...path];
      while (context.length && count(material([], context)) > Math.floor(budget / 4)) context.shift();
      const h = {context, warnings: context.length < path.length ? ['HEADING_CONTEXT_OMITTED_FOR_BUDGET'] : []};
      const patterns = [/\r?\n[ \t]*\r?\n+/gu, /[。！？!?]+[”’"')）]*[ \t]*(?:\r?\n)?|\.(?=\s|$)[ \t]*(?:\r?\n)?/gu, /\r?\n/gu];
      function divide(start, end, tier) {
        const piece = part(unit, start, end);
        if (fits([piece], h.context)) return [piece];
        if (tier === patterns.length) {gap(piece, 'NO_NATURAL_BOUNDARY_WITHIN_WINDOW'); return [];}
        const source = doc.content.slice(start, end), cuts = [...source.matchAll(patterns[tier])].map(m => start + m.index + m[0].length).filter(n => n > start && n < end && scalar(doc.content, n));
        if (!cuts.length) return divide(start, end, tier + 1);
        let from = start; const result = [];
        for (const to of [...cuts, end]) {result.push(...divide(from, to, tier + 1)); from = to;}
        return result;
      }
      for (const piece of divide(unit.start, unit.end, 0)) add(piece, [], h.warnings);
    }
    function splitTable(unit) {
      flush();
      const lines = [...unit.text.matchAll(/[^\n]*(?:\n|$)/gu)].filter(m => m[0].length).map(m => ({start: unit.start + m.index, end: unit.start + m.index + m[0].length, text: m[0]}));
      const nonempty = lines.filter(l => l.text.trim());
      const separator = line => /^\s*\|?(?:[ \t]*:?-{3,}:?[ \t]*\|)+[ \t]*:?-{3,}:?[ \t]*\|?\s*$/u.test(line) || /^\s*\|[ \t]*:?-{3,}:?[ \t]*\|\s*$/u.test(line);
      if (nonempty.length < 2 || !nonempty[0].text.trim().startsWith('|') || !separator(nonempty[1].text) || nonempty.slice(2).some(l => !l.text.trim().startsWith('|'))) {gap(unit, 'TABLE_STRUCTURE_UNRESOLVED'); return;}
      const header = part(unit, unit.start, nonempty[1].end, 'TABLE_HEADER');
      if (!fits([header], [])) {gap(unit, 'TABLE_HEADER_EXCEEDS_WINDOW'); return;}
      const rows = lines.filter(l => l.start >= header.end), pieces = [];
      for (const row of rows) {
        const piece = part(unit, row.start, row.end, 'TABLE_ROWS');
        if (!fits([piece], [header])) gap(piece, 'TABLE_ROW_WITH_HEADER_EXCEEDS_WINDOW'); else pieces.push(piece);
      }
      if (!pieces.length) {gap(header, 'TABLE_WITHOUT_PROCESSABLE_ROWS'); return;}
      // The first header is core once; repeated headers in later windows are context only.
      add(header);
      for (const piece of pieces) add(piece, [header]);
      flush();
    }
    for (const unit of units) {
      if (heading(unit)) {
        const marker = unit.text.match(/^\s*(#{1,6})\s/), level = marker ? marker[1].length : 1;
        // Titles are a useful boundary once a window is substantial, not an
        // instruction to create a separate model task for every small section.
        if (level <= 2 && core.length && count(material(core, context)) >= config.heading_preference_min_tokens) flush();
        path = path.filter(p => (p.heading_level ?? 1) < level);
        // Oversized heading is a source gap, not a reason to block the remaining document.
        if (fits([unit], [])) {add(unit); path.push({...unit, heading_level: level});} else gap(unit, 'HEADING_EXCEEDS_WINDOW');
      } else if (fits([unit], [])) add(unit);
      else if (unit.kind === 'table') splitTable(unit);
      else splitText(unit);
    }
    flush();
    const plannedByBlock = new Map(), gapsByBlock = new Map();
    for (const w of windows) if (w.doc_ref === doc.doc_id) for (const u of w.core_units) {
      if (!plannedByBlock.has(u.block_id)) plannedByBlock.set(u.block_id, []);
      plannedByBlock.get(u.block_id).push({start: u.start, end: u.end, status: 'PLANNED', window_ref: w.window_ref});
    }
    for (const g of gaps) if (g.doc_ref === doc.doc_id) {
      if (!gapsByBlock.has(g.block_id)) gapsByBlock.set(g.block_id, []);
      gapsByBlock.get(g.block_id).push({start: g.start, end: g.end, status: 'GAP', code: g.code});
    }
    for (const unit of units) {
      const segments = [...(plannedByBlock.get(unit.block_id) ?? []), ...(gapsByBlock.get(unit.block_id) ?? [])].sort((a, b) => a.start - b.start || a.end - b.end);
      let at = unit.start;
      for (const segment of segments) {need(segment.start === at && segment.end > at, 'NATIVE_WINDOW_PLAN_COVERAGE_OVERLAP_OR_HOLE'); at = segment.end;}
      need(at === unit.end, 'NATIVE_WINDOW_PLAN_COVERAGE_INCOMPLETE');
      coverage.push({doc_ref: doc.doc_id, revision: doc.revision, block_id: unit.block_id, start: unit.start, end: unit.end, segments,
        status: segments.some(s => s.status === 'GAP') ? 'HAS_GAPS' : 'PLANNED'});
    }
  }
  const routed = new Set(windows.flatMap(w => w.cq_refs));
  const result = {plan_ref: planRef, version: NATIVE_EXTRACTION_WINDOW_PLAN_VERSION, source_snapshot_ref: snapshot.snapshot_id, source_fingerprint: snapshot.fingerprint ?? hash(snapshot),
    config, windows, coverage, gaps, unrouted_cq_refs: cqInput.items.filter(q => !routed.has(q.cq_ref)).map(q => q.cq_ref),
    summary: {documents: snapshot.documents.length, source_blocks: coverage.length, windows: windows.length, planned_blocks: coverage.filter(c => c.status === 'PLANNED').length, blocks_with_gaps: coverage.filter(c => c.status === 'HAS_GAPS').length, gaps: gaps.length},
    warnings: [...warnEstimate, ...(gaps.length ? ['SOURCE_RANGES_REMAIN_UNPROCESSED'] : [])],
    semantic_completeness_certified: false};
  return {...result, plan_sha256: hash(result)};
}

/** Reuse a frozen Docling plan. Counts belong to cl100k_base, never Qwen. */
export function createNativeHybridExtractionWindowPlan({snapshot,hybridPlan,cqInput={items:[]},families={families:[]},familyInput,blockCQContext=null}={}){
 need(snapshot&&Array.isArray(snapshot.documents)&&hybridPlan,'NATIVE_HYBRID_EXTRACTION_PLAN_REQUIRED');
 const {plan_sha256,...payload}=hybridPlan;
 need(plan_sha256===hash(payload),'NATIVE_HYBRID_EXTRACTION_SOURCE_CHANGED');
 const sameSnapshot=hybridPlan.source_snapshot_ref===snapshot.snapshot_id&&hybridPlan.source_fingerprint===(snapshot.fingerprint??hash(snapshot));
 const sourceDocuments=hybridPlan.documents??hybridPlan.windows;
 need(sameSnapshot||Array.isArray(sourceDocuments)&&new Set(sourceDocuments.map(d=>d.doc_ref)).size===snapshot.documents.length&&snapshot.documents.every(d=>sourceDocuments.some(s=>s.doc_ref===d.doc_id&&s.revision===d.revision)),'NATIVE_HYBRID_EXTRACTION_SOURCE_CHANGED');
 need(hybridPlan.policy?.engine==='DoclingHybridChunker'&&hybridPlan.policy.tokenizer==='cl100k_base'&&hybridPlan.policy.max_tokens===8000&&hybridPlan.policy.token_count_exact===true&&Array.isArray(hybridPlan.windows)&&Array.isArray(hybridPlan.chunks),'NATIVE_HYBRID_EXTRACTION_POLICY_INVALID');
 const config={version:'HYBRID_EXTRACTION_V1',window_tokens:8000,max_concurrency:4,token_count_strategy:'cl100k_base',token_count_exact:true,model_tokenizer_match:'NOT_ASSERTED',budget_scope:'CONTEXTUALIZED_SOURCE_TEXT',offset_unit:null};
 const planRef='hybrid_extraction_plan_'+hash({snapshot_id:snapshot.snapshot_id,hybrid_plan_sha256:plan_sha256,cqInput,families,familyInput:familyInput??null,config}),used=[],seen=new Set();
 const chunks=new Map(hybridPlan.chunks.map(c=>[c.chunk_ref,c]));need(chunks.size===hybridPlan.chunks.length,'NATIVE_HYBRID_EXTRACTION_DUPLICATE_CHUNK');
 const origin=ref=>familyInput?.mapping?.[ref]?.origin_cq_ref??ref;
 const windows=hybridPlan.windows.map(w=>{
  const doc=snapshot.documents.find(d=>d.doc_id===w.doc_ref);need(doc&&doc.revision===w.revision&&!seen.has(w.window_ref),'NATIVE_HYBRID_EXTRACTION_WINDOW_SOURCE_INVALID');seen.add(w.window_ref);
  need(w.tokenizer==='cl100k_base'&&w.token_count_exact===true&&Number.isSafeInteger(w.token_count)&&w.token_count>0&&w.token_count<=8000&&w.token_budget===8000&&w.status==='PLANNED'&&typeof w.text==='string'&&w.text.isWellFormed(),'NATIVE_HYBRID_EXTRACTION_WINDOW_INVALID');
  const children=w.source_chunk_refs.map(ref=>chunks.get(ref));need(children.length>0&&children.every(c=>c&&c.doc_ref===w.doc_ref&&c.revision===w.revision&&c.status==='PLANNED')&&children.every((c,i)=>i===0||c.ordinal===children[i-1].ordinal+1)&&w.text===children.map(c=>c.contextualized_text).join('\n\n')&&w.text===w.contextualized_text,'NATIVE_HYBRID_EXTRACTION_SERIALIZATION_CHANGED');used.push(...w.source_chunk_refs);
  const blockRefs=[...new Set(children.flatMap(c=>c.source_block_refs))];need(hash(blockRefs)===hash(w.source_block_refs)&&blockRefs.every(ref=>doc.blocks.some(b=>b.block_id===ref)),'NATIVE_HYBRID_EXTRACTION_BLOCK_MAPPING_CHANGED');
  const core_units=blockRefs.map(ref=>{const b=doc.blocks.find(b=>b.block_id===ref),body={doc_ref:doc.doc_id,revision:doc.revision,block_id:b.block_id,kind:b.kind??'text',start:b.start,end:b.end,offset_unit:'utf16_code_unit'};return {...body,unit_ref:'unit_'+hash([snapshot.snapshot_id,body]),text:doc.content.slice(b.start,b.end),provenance:clone(b.provenance??[])};}).sort((a,b)=>a.start-b.start);
  const items=cqInput.items.filter(q=>(q.source_refs??familyInput?.mapping?.[q.cq_ref]?.source_refs??[]).some(s=>s.doc_ref===doc.doc_id&&(!s.revision||s.revision===doc.revision))),refs=new Set(items.map(q=>q.cq_ref));
  const routedFamilies=(families.families??[]).flatMap(f=>{const mappings=(f.member_refs??[]).flatMap(member_ref=>{const actual=refs.has(member_ref)?member_ref:items.find(q=>origin(q.cq_ref)===origin(member_ref))?.cq_ref;return actual?[{member_ref,cq_ref:actual,origin_cq_ref:origin(member_ref)}]:[];});return mappings.length?[{...clone(f),original_member_refs:clone(f.member_refs),member_refs:[...new Set(mappings.map(m=>m.cq_ref))],matched_member_refs:[...new Set(mappings.map(m=>m.cq_ref))],member_ref_mapping:mappings}]:[];});
  return {...clone(w),hybrid_plan_ref:hybridPlan.plan_ref,hybrid_plan_sha256:plan_sha256,hybrid_source_snapshot_ref:hybridPlan.source_snapshot_ref,source_snapshot_ref:snapshot.snapshot_id,plan_ref:planRef,material_format:'DOCLING_HYBRID_CONTEXTUALIZED',core_units,context_units:[],hybrid_chunks:children.map(c=>({chunk_ref:c.chunk_ref,source_items:clone(c.source_items),source_block_refs:clone(c.source_block_refs),headings:clone(c.headings)})),cq_items:clone(items),cq_refs:[...refs],families:routedFamilies,source_refs:[{doc_ref:doc.doc_id,revision:doc.revision}],token_count_strategy:'cl100k_base',estimated_tokens:w.token_count,warnings:[...w.warnings,'HYBRID_TEXT_HAS_NO_FLAT_CONTIGUOUS_OFFSETS'],status:'PENDING'};
 });
 need(new Set(used).size===used.length&&used.length===chunks.size&&[...chunks.keys()].every(ref=>used.includes(ref)),'NATIVE_HYBRID_EXTRACTION_CHUNK_COVERAGE_INVALID');
 const bound=blockCQContext?bindNativeBlockCQContext({windows,hybridPlan,cqInput,familyInput:familyInput??cqInput,families,...blockCQContext}):null;const routed=new Set((bound?.windows??windows).flatMap(w=>w.cq_refs));const value={plan_ref:planRef,version:'HYBRID_EXTRACTION_V1',source_snapshot_ref:snapshot.snapshot_id,source_fingerprint:snapshot.fingerprint??hash(snapshot),hybrid_plan_ref:hybridPlan.plan_ref,hybrid_plan_sha256:plan_sha256,config,windows:bound?.windows??windows,...(bound?{cq_binding:bound.binding}:{}),coverage:clone(hybridPlan.coverage),gaps:clone(hybridPlan.gaps),warnings:clone(hybridPlan.warnings),unrouted_cq_refs:cqInput.items.filter(q=>!routed.has(q.cq_ref)).map(q=>q.cq_ref),summary:{...clone(hybridPlan.summary),source_chunks:chunks.size},semantic_completeness_certified:false};return {...value,plan_sha256:hash(value)};
}
