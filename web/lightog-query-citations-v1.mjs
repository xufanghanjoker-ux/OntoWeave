/** Read-only citation targets. Coordinates and graph references are never inferred from text. */
import {lightogDocumentKey, resolveLightogSources} from './lightog-reading-data-v1.mjs';

const list = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const strings = value => list(value).filter(text);
const unique = values => [...new Set(values)];
const copy = value => structuredClone(value);
const precisions = new Set(['EXACT_SPAN', 'BLOCK_ASSOCIATION', 'DOCUMENT_ONLY']);
const offsetUnits = new Set(['utf16_code_unit', 'utf16_code_units']);

function matchingBinding(row, target, document) {
  return (!text(row?.doc_ref) || row.doc_ref === target.doc_ref) &&
    (!text(row?.revision) || row.revision === target.revision) &&
    (!text(row?.source_snapshot_ref) || !text(document?.source_snapshot_ref) || row.source_snapshot_ref === document.source_snapshot_ref);
}

/** Only named original block references are eligible. A mapping type string or index record is not a locator. */
function retainedBlockRefs(target, document) {
  if (!document) return [];
  const candidates = [];
  const collect = row => {
    if (Array.isArray(row)) {row.forEach(collect); return;}
    if (!object(row) || !matchingBinding(row, target, document)) return;
    candidates.push(row.block_ref, row.block_id, ...strings(row.block_refs), ...strings(row.source_block_refs));
    for (const item of list(row.source_items)) {
      if (object(item) && matchingBinding(item, target, document)) candidates.push(item.block_ref, item.block_id, item.self_ref);
    }
    for (const key of ['blocks', 'items', 'mappings']) if (Array.isArray(row[key])) row[key].forEach(collect);
  };
  collect(target); collect(target.source_mapping);
  const supplied = new Set(candidates.filter(text));
  return unique(list(document.blocks).filter(block => [block.id, block.block_id, block.ref].some(ref => text(ref) && supplied.has(ref))).map(block => block.id ?? block.block_id));
}

function targetSource(target, model, citationId, targetIndex) {
  const requested = precisions.has(target.precision) ? target.precision : 'DOCUMENT_ONLY';
  const document = model?.documentByKey?.get(lightogDocumentKey(target.doc_ref, target.revision));
  const ref = {doc_ref: target.doc_ref, revision: target.revision,
    ...(text(target.title) ? {title: target.title} : {}),
    ...(text(target.source_snapshot_ref) ? {source_snapshot_ref: target.source_snapshot_ref} : {})};
  if (requested !== 'DOCUMENT_ONLY') ref.block_refs = retainedBlockRefs(target, document);
  const spans = list(target.spans);
  const evidence = requested === 'EXACT_SPAN' ? spans.filter(span => {
    if (!object(span) || !matchingBinding(span, target, document)) return false;
    const unit = span.offset_unit ?? target.offset_unit;
    return unit === undefined || offsetUnits.has(unit);
  }).map(span => ({...copy(span), doc_ref: target.doc_ref, revision: target.revision,
    ...(text(span.source_snapshot_ref ?? target.source_snapshot_ref) ? {source_snapshot_ref: span.source_snapshot_ref ?? target.source_snapshot_ref} : {}),
    offset_unit: 'utf16_code_unit'})) : [];
  // The existing resolver validates exact same-version slices; BLOCK and DOCUMENT pass no ranges.
  const resolved = resolveLightogSources({source_refs: [ref], evidence}, model)[0];
  const precision = resolved.available && resolved.segments.length ? 'EXACT_SPAN' : resolved.available && resolved.block_ids.length ? 'BLOCK_ASSOCIATION' : 'DOCUMENT_ONLY';
  const readableQuotes = unique([target.quote, ...spans.flatMap(span => [span?.quote, span?.span?.quote])].filter(text));
  const unverified = unique([...list(resolved.unverified_quotes), ...readableQuotes.filter(quote => !resolved.quotes.includes(quote))]);
  let note;
  if (!resolved.available) note = '此引用的原资料版本或来源绑定暂不可读，不能替用当前版本。';
  else if (precision === 'EXACT_SPAN') note = unverified.length ? '已保留可校验的原文范围；另有引句的位置尚未确认。' : '已按该资料版本核对原文范围。';
  else if (precision === 'BLOCK_ASSOCIATION') note = '仅保存块级关联；未把块内容当作精确原句。';
  else if (requested === 'EXACT_SPAN') note = '引用范围未能与保留正文核对，现按资料级展示。';
  else if (requested === 'BLOCK_ASSOCIATION') note = '未找到该版本的真实解析块，现按资料级展示。';
  else note = '资料级来源；未提供可定位的引句。';
  return {...resolved, citation_ref: citationId, target_index: targetIndex,
    requested_precision: requested, precision,
    precision_label: precision === 'EXACT_SPAN' ? '已校验原文范围' : precision === 'BLOCK_ASSOCIATION' ? '原文块级关联' : '资料级来源',
    precision_note: note, unverified_quotes: unverified,
    warnings: [
      ...(!precisions.has(target.precision) ? ['引用精度未提供，按资料级展示。'] : []),
      ...(!resolved.available || precision !== requested || unverified.length ? [note] : [])
    ]};
}

/** The GET citation bundle is already query-bound by the Host. This adapter performs local target checks only. */
export function projectLightogQueryCitation(citation, model, {historical = false} = {}) {
  const input = object(citation) ? citation : {};
  const id = text(input.citation_ref) ? input.citation_ref : null;
  const supportSources = list(input.source_targets).filter(object).map((target, index) => targetSource(target, model, id, index));
  const humanSources = list(input.human_sources).filter(object).map(source => ({...copy(source),
    original_source_targets: undefined, evidence_nature: 'HUMAN_STATEMENT'}));
  const definitionSources=list(input.definition_sources).filter(source=>object(source)&&source.kind==='HUMAN_DEFINITION_SELECTION'&&source.evidence_nature==='HUMAN_DEFINITION_CHOICE'&&source.authority_scope==='NORMALIZED_DEFINITION_ONLY').map(copy);
  const backgroundSources = list(input.human_sources).filter(object).flatMap(source => list(source.original_source_targets)
    .filter(object).map(target => ({target, source}))).map(({target,source},index) => ({
      ...targetSource(target, model, id, supportSources.length + index),
      evidence_role: 'CORRECTION_BACKGROUND_ONLY', knowledge_ref: source.knowledge_ref,
      review_event_ref: source.review_event_ref, action_label: '打开修订前原文',
      precision_note: '仅供对照修订前知识；不表示原文支持人工更正后的内容。'}));
  const sources = [...supportSources, ...backgroundSources];
  const data = model?.graph_data;
  const knowledgeIds = historical ? [] : unique(strings(input.knowledge_refs)).filter(ref => model?.knowledgeById?.has(ref));
  const entityIds = historical ? [] : unique(strings(input.entity_refs)).filter(ref => data?.nodes?.has(ref));
  const relationIds = historical ? [] : unique(strings(input.relation_refs)).filter(ref => data?.edges?.has(ref));
  const anchoredKnowledge = knowledgeIds.some(ref => {
    const knowledge = model.knowledgeById.get(ref);
    return list(knowledge.entity_ids).some(id => data?.nodes?.has(id)) || list(knowledge.relation_ids).some(id => data?.edges?.has(id));
  });
  const originalWarnings = Array.isArray(input.warnings) ? input.warnings : input.warnings === undefined || input.warnings === null ? [] : [input.warnings];
  const warnings = [...copy(originalWarnings), ...unique(sources.flatMap(source => source.warnings))];
  if (historical) warnings.push('历史引用保留原资料版本，当前图谱与知识跳转已停用。');
  return {id, kind: text(input.kind) ? input.kind : 'UNKNOWN',
    representation: typeof input.representation === 'string' ? input.representation : null,
    label: text(input.label) ? input.label : input.kind === 'GRAPH' ? '图谱知识' : '原文来源',
    text: typeof input.text === 'string' ? input.text : '',
    conditions: input.conditions === undefined ? [] : copy(input.conditions), warnings, sources,
    ...(humanSources.length ? {human_sources: humanSources, records: copy(list(input.records)), original_sources: backgroundSources} : {}),
    ...(definitionSources.length?{definition_sources:definitionSources,records:copy(list(input.records))}:{}),
    ...(text(input.definition_selection_status)?{definition_selection_status:input.definition_selection_status}:{}),
    ...(Array.isArray(input.definition_selection_warnings)?{definition_selection_warnings:copy(input.definition_selection_warnings)}:{}),
    knowledge_ids: knowledgeIds, entity_ids: entityIds, relation_ids: relationIds,
    graph_available: !historical && Boolean(entityIds.length || relationIds.length || anchoredKnowledge)};
}
