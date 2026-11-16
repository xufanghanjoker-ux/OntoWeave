//! Pure retrieval-window selection. Ranking and chunk generation remain outside this kernel.
pub mod fragments;
pub mod ranking;
pub mod evidence;
pub mod evidence_v2;
pub mod evidence_units;
use lightog_demand::{need, wire, Error, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub const VERSION: &str = "adjacent-source-context/0.1";
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    wire_version: String,
    request_id: String,
    operation: String,
    payload: Value,
}
#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
struct Block {
    kind: String,
    start: usize,
    end: usize,
    #[serde(default)]
    block_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Source {
    id: String,
    content: String,
    sha256: String,
    #[serde(default)]
    blocks: Vec<Block>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Unit {
    id: String,
    source_id: String,
    source_sha256: String,
    start: usize,
    end: usize,
    text: String,
    offset_unit: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Evidence {
    source_id: String,
    source_sha256: String,
    start: usize,
    end: usize,
    quote: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Options {
    max_context_units: usize,
    edge_chars: usize,
    max_context_chars: usize,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            max_context_units: 2,
            edge_chars: 1200,
            max_context_chars: 12000,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    sources: Vec<Source>,
    units: Vec<Unit>,
    #[serde(default)]
    ranked_ids: Vec<String>,
    #[serde(default)]
    positive_ids: Vec<String>,
    evidence: Vec<Evidence>,
    baseline_unit_ids: Option<Vec<String>>,
    evidence_unit_ids: Option<Vec<String>>,
    #[serde(default)]
    options: Options,
}
#[derive(Clone, Copy)]
struct Range {
    start: usize,
    end: usize,
}
fn overlaps(a: Range, b: Range) -> bool {
    a.start < b.end && b.start < a.end
}
fn unit_range(u: &Unit) -> Range {
    Range {
        start: u.start,
        end: u.end,
    }
}
fn evidence_range(e: &Evidence) -> Range {
    Range {
        start: e.start,
        end: e.end,
    }
}
fn uncovered(range: Range, covered: &[Range]) -> Vec<Range> {
    let mut ranges = vec![range];
    for c in covered {
        ranges = ranges
            .into_iter()
            .flat_map(|r| {
                if !overlaps(r, *c) {
                    vec![r]
                } else {
                    [
                        Range {
                            start: r.start,
                            end: r.end.min(c.start),
                        },
                        Range {
                            start: r.start.max(c.end),
                            end: r.end,
                        },
                    ]
                    .into_iter()
                    .filter(|r| r.end > r.start)
                    .collect()
                }
            })
            .collect();
    }
    ranges
}
// One index per original text: UTF16 positions that split a surrogate map to None.
struct TextIndex {
    bytes: Vec<Option<usize>>,
}
impl TextIndex {
    fn new(text: &str) -> Self {
        let mut bytes = Vec::with_capacity(text.len() + 1);
        for (i, c) in text.char_indices() {
            bytes.push(Some(i));
            if c.len_utf16() == 2 {
                bytes.push(None);
            }
        }
        bytes.push(Some(text.len()));
        Self { bytes }
    }
    fn valid(&self, r: Range) -> bool {
        r.start < r.end
            && self.bytes.get(r.start).is_some_and(Option::is_some)
            && self.bytes.get(r.end).is_some_and(Option::is_some)
    }
    fn text<'a>(&self, text: &'a str, r: Range) -> Result<&'a str> {
        need(self.valid(r), "CONTEXT_OFFSET_INVALID")?;
        let a = self
            .bytes
            .get(r.start)
            .and_then(|i| *i)
            .ok_or_else(|| Error::new("CONTEXT_OFFSET_INVALID"))?;
        let b = self
            .bytes
            .get(r.end)
            .and_then(|i| *i)
            .ok_or_else(|| Error::new("CONTEXT_OFFSET_INVALID"))?;
        text.get(a..b)
            .ok_or_else(|| Error::new("CONTEXT_OFFSET_INVALID"))
    }
    fn inward_start(&self, n: usize) -> usize {
        if self.bytes.get(n) == Some(&None) {
            n + 1
        } else {
            n
        }
    }
    fn inward_end(&self, n: usize) -> usize {
        if self.bytes.get(n) == Some(&None) {
            n.saturating_sub(1)
        } else {
            n
        }
    }
}
struct Validated {
    sources: HashMap<String, usize>,
    units: HashMap<String, usize>,
    indexes: Vec<TextIndex>,
    required: Vec<usize>,
    by_source: Vec<Vec<usize>>,
}
// The immutable 6000/400 extraction policy from web/source-context.mjs.
// Rebuilding only offsets closes the input boundary; lexical ranking stays outside Rust.
fn expected_windows(text: &str, index: &TextIndex) -> Vec<Range> {
    let chars: Vec<u16> = text.encode_utf16().collect();
    let mut result = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let mut end = index.inward_end((start + 6000).min(chars.len()));
        if end < chars.len() {
            let tail_start = (start + 5400).max(start);
            if let Some(at) =
                (tail_start..end).rfind(|&i| matches!(chars[i], 0x3002 | 0xFF01 | 0xFF1F | 0x000A))
            {
                let candidate = at + 1;
                if candidate > start + 500 {
                    end = candidate;
                }
            }
        }
        result.push(Range { start, end });
        if end == chars.len() {
            break;
        }
        let next = index.inward_end((start + 1).max(end.saturating_sub(400)));
        start = if next > start { next } else { end };
    }
    result
}
fn unique_ids(ids: &[String], map: &HashMap<String, usize>, code: &'static str) -> Result<()> {
    let mut seen = HashSet::new();
    need(
        ids.iter().all(|id| seen.insert(id) && map.contains_key(id)),
        code,
    )
}
fn validate(p: &Payload) -> Result<Validated> {
    need(
        !p.sources.is_empty() && p.sources.len() <= 8,
        "CONTEXT_SOURCES_INVALID",
    )?;
    need(
        !p.units.is_empty() && p.units.len() <= 4096 && p.evidence.len() <= 128,
        "CONTEXT_RESOURCE_LIMIT",
    )?;
    need(!p.evidence.is_empty(), "CONTEXT_EVIDENCE_REQUIRED")?;
    need(
        p.options.max_context_units <= 2,
        "CONTEXT_UNIT_BUDGET_INVALID",
    )?;
    need(
        (1..=1200).contains(&p.options.edge_chars),
        "CONTEXT_EDGE_BUDGET_INVALID",
    )?;
    need(
        p.options.max_context_chars <= 12000,
        "CONTEXT_CHAR_BUDGET_INVALID",
    )?;
    need(
        p.sources.iter().map(|s| s.content.len()).sum::<usize>() <= wire::MAX_INPUT_BYTES,
        "CONTEXT_RESOURCE_LIMIT",
    )?;
    let mut sources = HashMap::new();
    let mut indexes = Vec::new();
    for (i, s) in p.sources.iter().enumerate() {
        need(
            !s.id.is_empty() && sources.insert(s.id.clone(), i).is_none(),
            "CONTEXT_SOURCES_INVALID",
        )?;
        need(
            wire::text_sha(&s.content) == s.sha256,
            "CONTEXT_SOURCE_HASH_MISMATCH",
        )?;
        let index = TextIndex::new(&s.content);
        need(s.blocks.len() <= 4096, "CONTEXT_RESOURCE_LIMIT")?;
        for b in &s.blocks {
            need(
                !b.kind.is_empty()
                    && index.valid(Range {
                        start: b.start,
                        end: b.end,
                    }),
                "CONTEXT_BLOCK_OFFSET_INVALID",
            )?;
        }
        indexes.push(index);
    }
    let mut units = HashMap::new();
    let mut by_source = vec![Vec::new(); p.sources.len()];
    for (i, u) in p.units.iter().enumerate() {
        need(
            !u.id.is_empty() && units.insert(u.id.clone(), i).is_none(),
            "CONTEXT_DUPLICATE_UNIT",
        )?;
        let si = *sources
            .get(&u.source_id)
            .ok_or_else(|| Error::new("CONTEXT_UNIT_SOURCE_INVALID"))?;
        let s = &p.sources[si];
        let index = &indexes[si];
        need(
            u.source_sha256 == s.sha256
                && u.offset_unit == "utf16_code_unit"
                && index.valid(unit_range(u)),
            "CONTEXT_UNIT_INVALID",
        )?;
        need(
            index.text(&s.content, unit_range(u))? == u.text,
            "CONTEXT_UNIT_INVALID",
        )?;
        by_source[si].push(i);
    }
    for (si, list) in by_source.iter().enumerate() {
        need(
            list.windows(2)
                .all(|w| p.units[w[0]].start < p.units[w[1]].start),
            "CONTEXT_UNIT_ORDER_INVALID",
        )?;
        let expected = expected_windows(&p.sources[si].content, &indexes[si]);
        need(
            list.len() == expected.len()
                && list
                    .iter()
                    .zip(expected.iter())
                    .all(|(&i, r)| p.units[i].start == r.start && p.units[i].end == r.end),
            "CONTEXT_UNIT_DIRECTORY_INVALID",
        )?;
    }
    for e in &p.evidence {
        let si = *sources
            .get(&e.source_id)
            .ok_or_else(|| Error::new("CONTEXT_EVIDENCE_INVALID"))?;
        let s = &p.sources[si];
        let index = &indexes[si];
        need(
            e.source_sha256 == s.sha256 && index.valid(evidence_range(e)),
            "CONTEXT_EVIDENCE_INVALID",
        )?;
        need(
            index.text(&s.content, evidence_range(e))? == e.quote,
            "CONTEXT_EVIDENCE_INVALID",
        )?;
        // Do not accept a supplied unit universe that has a gap in the admission quote.
        let covered: Vec<_> = by_source[si]
            .iter()
            .map(|&u| unit_range(&p.units[u]))
            .collect();
        need(
            uncovered(evidence_range(e), &covered).is_empty(),
            "CONTEXT_EVIDENCE_NOT_COVERED",
        )?;
    }
    let required = by_source
        .iter()
        .flatten()
        .copied()
        .filter(|&i| {
            p.evidence.iter().any(|e| {
                e.source_id == p.units[i].source_id
                    && overlaps(evidence_range(e), unit_range(&p.units[i]))
            })
        })
        .collect();
    Ok(Validated {
        sources,
        units,
        indexes,
        required,
        by_source,
    })
}
fn same_section(s: &Source, a: usize, b: usize) -> bool {
    let (from, to) = (a.min(b), a.max(b));
    !s.blocks
        .iter()
        .any(|h| h.kind == "section_header" && h.start > from && h.start <= to)
}
#[derive(Clone)]
struct Proposal {
    unit: usize,
    anchors: Vec<String>,
    direction: &'static str,
    reasons: Vec<Value>,
    distance: usize,
    table: bool,
    assurance: &'static str,
}
fn proposal_value(c: &Proposal, p: &Payload, status: &str) -> Value {
    let u = &p.units[c.unit];
    json!({"unit_id":u.id,"source_id":u.source_id,"anchor_ids":c.anchors,"direction":c.direction,"reasons":c.reasons,"distance":c.distance,"section_assurance":c.assurance,"status":status})
}
pub fn execute(value: &Value) -> Result<Value> {
    let r: Request =
        serde_json::from_value(value.clone()).map_err(|_| Error::new("RPC_INVALID_REQUEST"))?;
    need(
        r.wire_version == "lightog-retrieval/0.1",
        "RPC_VERSION_UNSUPPORTED",
    )?;
    need(
        !r.request_id.is_empty() && r.request_id.len() <= 128,
        "RPC_INVALID_REQUEST",
    )?;
    plan(&r.operation, &r.payload)
}
pub fn plan(operation: &str, payload: &Value) -> Result<Value> {
    need(
        matches!(operation, "baseline" | "adjacent"),
        "RPC_OPERATION_UNKNOWN",
    )?;
    let p: Payload =
        serde_json::from_value(payload.clone()).map_err(|_| Error::new("RPC_INVALID_PAYLOAD"))?;
    let v = validate(&p)?;
    if operation == "baseline" {
        unique_ids(&p.ranked_ids, &v.units, "CONTEXT_RANKING_INVALID")?;
        need(
            p.ranked_ids.len() == p.units.len(),
            "CONTEXT_RANKING_INVALID",
        )?;
        unique_ids(&p.positive_ids, &v.units, "CONTEXT_POSITIVE_IDS_INVALID")?;
        let required: HashSet<_> = v.required.iter().map(|&i| p.units[i].id.as_str()).collect();
        let positives: HashSet<_> = p.positive_ids.iter().map(String::as_str).collect();
        let evidence_ids: Vec<_> = p
            .ranked_ids
            .iter()
            .filter(|id| required.contains(id.as_str()))
            .cloned()
            .collect();
        let mut chosen = evidence_ids.clone();
        let mut seen: HashSet<_> = chosen.iter().cloned().collect();
        for id in p
            .ranked_ids
            .iter()
            .filter(|id| positives.contains(id.as_str()))
        {
            if chosen.len() >= 4.max(required.len()) {
                break;
            }
            if seen.insert(id.clone()) {
                chosen.push(id.clone());
            }
        }
        return Ok(json!({"unit_ids":chosen,"evidence_unit_ids":evidence_ids}));
    }
    let baseline = p
        .baseline_unit_ids
        .as_ref()
        .ok_or_else(|| Error::new("CONTEXT_BASELINE_REQUIRED"))?;
    let evidence_ids = p
        .evidence_unit_ids
        .as_ref()
        .ok_or_else(|| Error::new("CONTEXT_EVIDENCE_UNIT_SET_MISMATCH"))?;
    unique_ids(baseline, &v.units, "CONTEXT_DUPLICATE_UNIT")?;
    unique_ids(evidence_ids, &v.units, "CONTEXT_EVIDENCE_UNIT_SET_MISMATCH")?;
    let required_ids: HashSet<_> = v.required.iter().map(|&i| p.units[i].id.as_str()).collect();
    need(
        evidence_ids.len() == required_ids.len()
            && evidence_ids
                .iter()
                .all(|id| required_ids.contains(id.as_str())),
        "CONTEXT_EVIDENCE_UNIT_SET_MISMATCH",
    )?;
    need(
        v.required
            .iter()
            .all(|&i| baseline.contains(&p.units[i].id)),
        "CONTEXT_MANDATORY_MISSING",
    )?;
    let capacity = 4.max(v.required.len());
    need(
        baseline.len() <= capacity,
        "CONTEXT_BASELINE_BUDGET_INVALID",
    )?;
    let cue = Regex::new(r"仅适用于|仅限于|仅限|仅当|仅在|只适用于|不适用于|前提条件|适用条件|例外|除外|但不|但是|不过|注意[:：]|上述(?:结论|能力|功能|规则|结果|方案)|该(?:结论|能力|功能|规则|结果|方案)|表注|续注|注[A-Za-z0-9]*[:：]").map_err(|_| Error::new("CONTEXT_POLICY_INVALID"))?;
    let link = Regex::new(r"(?:详?见)(?:本节|表)|前提为本节|采用本节")
        .map_err(|_| Error::new("CONTEXT_POLICY_INVALID"))?;
    let mut trace = Vec::new();
    let mut proposals: Vec<Proposal> = Vec::new();
    let mut proposal_index = HashMap::new();
    for &anchor_i in &v.required {
        let a = &p.units[anchor_i];
        let si = v.sources[&a.source_id];
        let s = &p.sources[si];
        let idx = &v.indexes[si];
        let ordered = &v.by_source[si];
        let at = ordered
            .iter()
            .position(|&i| i == anchor_i)
            .ok_or_else(|| Error::new("CONTEXT_UNIT_INVALID"))?;
        let anchored: Vec<_> = p
            .evidence
            .iter()
            .filter(|e| e.source_id == s.id && overlaps(evidence_range(e), unit_range(a)))
            .collect();
        let covered: Vec<_> = v
            .required
            .iter()
            .filter(|&&i| p.units[i].source_id == s.id)
            .map(|&i| unit_range(&p.units[i]))
            .collect();
        for before in [true, false] {
            let next = if before {
                at.checked_sub(1)
            } else {
                at.checked_add(1).filter(|&n| n < ordered.len())
            };
            let Some(next) = next else { continue };
            let neighbor_i = ordered[next];
            let u = &p.units[neighbor_i];
            if required_ids.contains(u.id.as_str()) {
                continue;
            }
            let novel_all = uncovered(unit_range(u), &covered);
            if !anchored.iter().any(|e| {
                novel_all.iter().all(|r| {
                    same_section(s, e.start, r.start) && same_section(s, e.start, r.end - 1)
                })
            }) {
                trace.push(
                    json!({"unit_id":u.id,"anchor_id":a.id,"status":"SKIPPED_SECTION_BOUNDARY"}),
                );
                continue;
            }
            let edge = if before {
                Range {
                    start: u.start.max(a.start.saturating_sub(p.options.edge_chars)),
                    end: u.end.min(a.start),
                }
            } else {
                Range {
                    start: u.start.max(a.end),
                    end: u.end.min(a.end.saturating_add(p.options.edge_chars)),
                }
            };
            let edge = Range {
                start: idx.inward_start(edge.start),
                end: idx.inward_end(edge.end),
            };
            if edge.end <= edge.start {
                continue;
            }
            let novel = uncovered(edge, &covered);
            if novel.is_empty() {
                continue;
            }
            let explicit_link = anchored.iter().any(|e| link.is_match(&e.quote));
            let shared_table = s.blocks.iter().filter(|b| b.kind == "table").any(|table| {
                novel.iter().any(|n| {
                    overlaps(
                        *n,
                        Range {
                            start: table.start,
                            end: table.end,
                        },
                    ) && anchored.iter().any(|e| {
                        e.start >= table.start
                            && e.end <= table.end
                            && same_section(s, e.start, table.start.max(n.start))
                    })
                })
            });
            if !explicit_link && !shared_table {
                trace.push(json!({"unit_id":u.id,"anchor_id":a.id,"status":"SKIPPED_NO_LINK","direction":if before {"PREVIOUS"} else {"NEXT"}}));
                continue;
            }
            let mut reasons = Vec::new();
            let mut reason_starts = Vec::new();
            let mut has_table = false;
            for span in &novel {
                let text = idx.text(&s.content, *span)?;
                for m in cue.find_iter(text) {
                    let start = span.start + text[..m.start()].encode_utf16().count();
                    let end = start + m.as_str().encode_utf16().count();
                    if anchored.iter().any(|e| same_section(s, e.start, start)) {
                        reasons.push(json!({"kind":"QUALIFIER_CUE","start":start,"end":end,"quote":m.as_str()}));
                        reason_starts.push(start);
                    }
                }
            }
            for table in s.blocks.iter().filter(|b| b.kind == "table") {
                let Some(novel_part) = novel.iter().find(|&&n| {
                    overlaps(
                        n,
                        Range {
                            start: table.start,
                            end: table.end,
                        },
                    )
                }) else {
                    continue;
                };
                let start = table.start.max(novel_part.start);
                if anchored.iter().any(|e| {
                    e.start >= table.start && e.end <= table.end && same_section(s, e.start, start)
                }) {
                    reasons.push(json!({"kind":"SAME_TABLE_CONTINUATION","start":start,"end":table.end.min(novel_part.end),"block_id":table.block_id}));
                    reason_starts.push(start);
                    has_table = true;
                }
            }
            let direction = if before { "PREVIOUS" } else { "NEXT" };
            if reasons.is_empty() {
                trace.push(json!({"unit_id":u.id,"anchor_id":a.id,"status":"SKIPPED_NO_SAFE_CUE","direction":direction}));
                continue;
            }
            let distance = anchored
                .iter()
                .flat_map(|e| reason_starts.iter().map(move |&r| r.abs_diff(e.start)))
                .min()
                .ok_or_else(|| Error::new("CONTEXT_POLICY_INVALID"))?;
            if let Some(&i) = proposal_index.get(&neighbor_i) {
                let c: &mut Proposal = &mut proposals[i];
                c.anchors.push(a.id.clone());
                c.reasons.extend(reasons);
                c.distance = c.distance.min(distance);
                c.table |= has_table;
            } else {
                proposal_index.insert(neighbor_i, proposals.len());
                proposals.push(Proposal {
                    unit: neighbor_i,
                    anchors: vec![a.id.clone()],
                    direction,
                    reasons,
                    distance,
                    table: has_table,
                    assurance: if s.blocks.iter().any(|b| b.kind == "section_header") {
                        "PARSER_SECTION_BOUNDARY"
                    } else {
                        "NO_SECTION_METADATA"
                    },
                });
            }
        }
    }
    proposals.sort_by(|a, b| {
        b.table
            .cmp(&a.table)
            .then(a.distance.cmp(&b.distance))
            .then(p.units[a.unit].source_id.cmp(&p.units[b.unit].source_id))
            .then(p.units[a.unit].start.cmp(&p.units[b.unit].start))
    });
    let mut chosen: Vec<_> = v.required.iter().map(|&i| p.units[i].id.clone()).collect();
    let mut seen: HashSet<_> = chosen.iter().cloned().collect();
    let mut count = 0;
    let mut chars = 0;
    for c in &proposals {
        let u = &p.units[c.unit];
        let len = u.end - u.start;
        if chosen.len() >= capacity
            || count >= p.options.max_context_units
            || chars + len > p.options.max_context_chars
        {
            trace.push(proposal_value(c, &p, "DEFERRED_BUDGET"));
            continue;
        }
        chosen.push(u.id.clone());
        seen.insert(u.id.clone());
        count += 1;
        chars += len;
        trace.push(proposal_value(c, &p, "SELECTED_CONTEXT"));
    }
    for id in baseline {
        if chosen.len() >= capacity {
            break;
        }
        if seen.insert(id.clone()) {
            chosen.push(id.clone());
        }
    }
    let displaced: Vec<_> = baseline.iter().filter(|id| !seen.contains(*id)).collect();
    let mut stamp = Vec::new();
    for s in &p.sources {
        let layout =
            serde_json::to_value(&s.blocks).map_err(|_| Error::new("CONTEXT_BLOCKS_INVALID"))?;
        stamp.push(
            json!({"source_id":s.id,"source_sha256":s.sha256,"layout_sha256":wire::sha(&layout)?}),
        );
    }
    Ok(
        json!({"unit_ids":chosen,"evidence_unit_ids":evidence_ids,"adjacent_context":{"version":VERSION,"source_stamp":stamp,"hops":1,"max_context_units":p.options.max_context_units,"max_context_chars":p.options.max_context_chars,"edge_chars":p.options.edge_chars,"context_unit_count":count,"context_characters":chars,"deferred":proposals.len()-count,"displaced_baseline_unit_ids":displaced,"trace":trace}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn payload() -> Value {
        let content = format!(
            "{}详见本节{}仅适用于小范围{}",
            "甲".repeat(5500),
            "甲".repeat(596),
            "乙".repeat(6900)
        );
        let sha = wire::text_sha(&content);
        let idx = TextIndex::new(&content);
        let units: Vec<_> = [(0,6000),(5600,11600),(11200,content.encode_utf16().count())].into_iter().enumerate().map(|(i,(start,end))| json!({"id":format!("u{i}"),"source_id":"s","source_sha256":sha,"start":start,"end":end,"text":idx.text(&content,Range{start,end}).unwrap(),"offset_unit":"utf16_code_unit"})).collect();
        json!({"sources":[{"id":"s","content":content,"sha256":sha,"blocks":[]}],"units":units,"ranked_ids":["u2","u0","u1"],"positive_ids":["u2","u1"],"evidence":[{"source_id":"s","source_sha256":sha,"start":5500,"end":5504,"quote":"详见本节"}],"baseline_unit_ids":["u0"],"evidence_unit_ids":["u0"]})
    }
    #[test]
    fn baseline_order_and_mandatory() {
        let p = payload();
        let r = plan("baseline", &p).unwrap();
        assert_eq!(r["unit_ids"], json!(["u0", "u2", "u1"]));
        assert_eq!(r["evidence_unit_ids"], json!(["u0"]));
    }
    #[test]
    fn adjacent_preserves_and_limits() {
        let p = payload();
        let original = p.clone();
        let r = plan("adjacent", &p).unwrap();
        assert_eq!(r["unit_ids"], json!(["u0", "u1"]));
        assert_eq!(r["adjacent_context"]["context_unit_count"], 1);
        assert_eq!(p, original);
    }
    #[test]
    fn section_and_duplicate_guards() {
        let mut p = payload();
        p["sources"][0]["blocks"] = json!([{"kind":"section_header","start":6500,"end":6504}]);
        assert_eq!(plan("adjacent", &p).unwrap()["unit_ids"], json!(["u0"]));
        p["evidence_unit_ids"] = json!(["u0", "u0"]);
        assert_eq!(
            plan("adjacent", &p).unwrap_err().code,
            "CONTEXT_EVIDENCE_UNIT_SET_MISMATCH"
        );
    }
    #[test]
    fn invalid_source_unit_budget() {
        let mut p = payload();
        p["sources"][0]["sha256"] = json!("bad");
        assert_eq!(
            plan("baseline", &p).unwrap_err().code,
            "CONTEXT_SOURCE_HASH_MISMATCH"
        );
        let mut p = payload();
        p["units"][0]["text"] = json!("bad");
        assert_eq!(
            plan("adjacent", &p).unwrap_err().code,
            "CONTEXT_UNIT_INVALID"
        );
        let mut p = payload();
        p["options"] = json!({"max_context_units":3,"edge_chars":1200,"max_context_chars":12000});
        assert_eq!(
            plan("adjacent", &p).unwrap_err().code,
            "CONTEXT_UNIT_BUDGET_INVALID"
        );
    }
    #[test]
    fn utf16_boundary() {
        let idx = TextIndex::new("甲😀乙");
        assert_eq!(
            idx.text("甲😀乙", Range { start: 1, end: 3 }).unwrap(),
            "😀"
        );
        assert!(!idx.valid(Range { start: 1, end: 2 }));
        assert_eq!(idx.inward_start(2), 3);
        assert_eq!(idx.inward_end(2), 1);
    }
    #[test]
    fn no_link_and_zero_budget() {
        let mut p = payload();
        p["evidence"][0]["start"] = json!(5490);
        p["evidence"][0]["end"] = json!(5492);
        p["evidence"][0]["quote"] = json!("甲甲");
        let r = plan("adjacent", &p).unwrap();
        assert_eq!(r["unit_ids"], json!(["u0"]));
        assert_eq!(
            r["adjacent_context"]["trace"][0]["status"],
            "SKIPPED_NO_LINK"
        );
        let mut p = payload();
        p["options"] = json!({"max_context_units":0,"edge_chars":1200,"max_context_chars":0});
        let r = plan("adjacent", &p).unwrap();
        assert_eq!(r["unit_ids"], json!(["u0"]));
        assert_eq!(
            r["adjacent_context"]["trace"][0]["status"],
            "DEFERRED_BUDGET"
        );
    }
    #[test]
    fn table_is_explicit_structural_link() {
        let mut p = payload();
        p["evidence"][0]["start"] = json!(5490);
        p["evidence"][0]["end"] = json!(5492);
        p["evidence"][0]["quote"] = json!("甲甲");
        p["sources"][0]["blocks"] =
            json!([{"kind":"table","start":5400,"end":6500,"block_id":"t1"}]);
        let r = plan("adjacent", &p).unwrap();
        assert_eq!(r["unit_ids"], json!(["u0", "u1"]));
        assert!(r["adjacent_context"]["trace"][0]["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["kind"] == "SAME_TABLE_CONTINUATION"));
    }
    #[test]
    fn multiple_mandatory_preserve_baseline_order() {
        let mut p = payload();
        p["evidence"][0]["start"] = json!(5700);
        p["evidence"][0]["end"] = json!(5702);
        p["evidence"][0]["quote"] = json!("甲甲");
        p["ranked_ids"] = json!(["u1", "u0", "u2"]);
        let b = plan("baseline", &p).unwrap();
        assert_eq!(b["evidence_unit_ids"], json!(["u1", "u0"]));
        p["baseline_unit_ids"] = json!(["u1", "u0"]);
        p["evidence_unit_ids"] = json!(["u1", "u0"]);
        let r = plan("adjacent", &p).unwrap();
        assert_eq!(r["unit_ids"], json!(["u0", "u1"]));
        assert_eq!(r["evidence_unit_ids"], json!(["u1", "u0"]));
    }
    #[test]
    fn closed_directory_rejects_missing_or_arbitrary_windows() {
        let mut p = payload();
        p["units"].as_array_mut().unwrap().remove(1);
        assert_eq!(
            plan("adjacent", &p).unwrap_err().code,
            "CONTEXT_UNIT_DIRECTORY_INVALID"
        );
        let mut p = payload();
        p["units"][1]["end"] = json!(11599);
        let text = p["units"][1]["text"]
            .as_str()
            .unwrap()
            .chars()
            .take(5999)
            .collect::<String>();
        p["units"][1]["text"] = json!(text);
        assert_eq!(
            plan("adjacent", &p).unwrap_err().code,
            "CONTEXT_UNIT_DIRECTORY_INVALID"
        );
    }
    #[test]
    fn source_policy_sentence_and_emoji_boundaries() {
        let text = format!("{}。{}", "甲".repeat(5500), "乙".repeat(6500));
        let ranges = expected_windows(&text, &TextIndex::new(&text));
        assert_eq!(
            (ranges[0].start, ranges[0].end, ranges[1].start),
            (0, 5501, 5101)
        );
        let text = format!("{}😀{}", "甲".repeat(5999), "乙".repeat(6500));
        let ranges = expected_windows(&text, &TextIndex::new(&text));
        assert_eq!((ranges[0].end, ranges[1].start), (5999, 5599));
    }
}
