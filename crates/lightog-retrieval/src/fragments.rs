//! Fragment-only, source-layout recall. Associations are not facts or entity identity.
//! Admission evidence is immutable; selected fragments never become expansion anchors.
use lightog_demand::{need, wire, Error, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub const VERSION: &str = "source-fragments/0.2";
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    wire_version: String,
    request_id: String,
    operation: String,
    payload: Value,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Block {
    block_id: String,
    kind: String,
    start: usize,
    end: usize,
    page_numbers: Vec<u32>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Source {
    id: String,
    content: String,
    sha256: String,
    blocks: Vec<Block>,
}
#[derive(Clone, Deserialize, Serialize)]
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
struct Covered {
    source_id: String,
    start: usize,
    end: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Options {
    max_fragments: usize,
    max_fragment_chars: usize,
    max_total_chars: usize,
    max_distance: usize,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            max_fragments: 6,
            max_fragment_chars: 1200,
            max_total_chars: 2400,
            max_distance: 6000,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    sources: Vec<Source>,
    evidence: Vec<Evidence>,
    covered: Vec<Covered>,
    #[serde(default)]
    options: Options,
}
#[derive(Clone, Copy, Debug)]
struct Range {
    start: usize,
    end: usize,
}
impl Range {
    fn contains(self, other: Self) -> bool {
        self.start <= other.start && other.end <= self.end
    }
    fn distance(self, other: Self) -> usize {
        self.start
            .saturating_sub(other.end)
            .max(other.start.saturating_sub(self.end))
    }
    fn length(self) -> usize {
        self.end - self.start
    }
}
fn br(b: &Block) -> Range {
    Range {
        start: b.start,
        end: b.end,
    }
}
fn er(e: &Evidence) -> Range {
    Range {
        start: e.start,
        end: e.end,
    }
}
struct TextIndex {
    bytes: Vec<Option<usize>>,
}
impl TextIndex {
    fn new(text: &str) -> Self {
        let mut bytes = Vec::with_capacity(text.len() + 1);
        for (i, c) in text.char_indices() {
            bytes.push(Some(i));
            if c.len_utf16() == 2 {
                bytes.push(None)
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
        need(self.valid(r), "FRAGMENT_OFFSET_INVALID")?;
        let a = self.bytes[r.start].ok_or_else(|| Error::new("FRAGMENT_OFFSET_INVALID"))?;
        let b = self.bytes[r.end].ok_or_else(|| Error::new("FRAGMENT_OFFSET_INVALID"))?;
        text.get(a..b)
            .ok_or_else(|| Error::new("FRAGMENT_OFFSET_INVALID"))
    }
}
struct Validated {
    indexes: Vec<TextIndex>,
}
fn validate(p: &Payload) -> Result<Validated> {
    need(
        !p.sources.is_empty() && p.sources.len() <= 8,
        "FRAGMENT_SOURCES_INVALID",
    )?;
    need(
        !p.evidence.is_empty() && p.evidence.len() <= 128 && p.covered.len() <= 32768,
        "FRAGMENT_RESOURCE_LIMIT",
    )?;
    need(
        p.options.max_fragments <= 6
            && p.options.max_fragment_chars <= 1200
            && p.options.max_total_chars <= 2400
            && p.options.max_distance <= 6000,
        "FRAGMENT_BUDGET_INVALID",
    )?;
    need(
        p.sources.iter().map(|s| s.content.len()).sum::<usize>() <= wire::MAX_INPUT_BYTES,
        "FRAGMENT_RESOURCE_LIMIT",
    )?;
    let mut sources = HashMap::new();
    let mut indexes = Vec::new();
    for (i, s) in p.sources.iter().enumerate() {
        need(
            !s.id.is_empty() && sources.insert(s.id.clone(), i).is_none(),
            "FRAGMENT_SOURCE_ID_INVALID",
        )?;
        need(
            wire::text_sha(&s.content) == s.sha256,
            "FRAGMENT_SOURCE_HASH_MISMATCH",
        )?;
        need(s.blocks.len() <= 4096, "FRAGMENT_RESOURCE_LIMIT")?;
        let index = TextIndex::new(&s.content);
        let mut ids = HashSet::new();
        for (bi, b) in s.blocks.iter().enumerate() {
            need(
                !b.block_id.is_empty() && ids.insert(&b.block_id),
                "FRAGMENT_BLOCK_ID_DUPLICATE",
            )?;
            need(
                !b.kind.is_empty() && index.valid(br(b)),
                "FRAGMENT_BLOCK_OFFSET_INVALID",
            )?;
            need(
                bi == 0 || s.blocks[bi - 1].end <= b.start,
                "FRAGMENT_BLOCK_ORDER_INVALID",
            )?;
            need(
                b.page_numbers.len() <= 32
                    && b.page_numbers.iter().all(|&n| n > 0 && n <= 100000)
                    && b.page_numbers.windows(2).all(|w| w[0] < w[1]),
                "FRAGMENT_PAGE_METADATA_INVALID",
            )?;
        }
        indexes.push(index);
    }
    for e in &p.evidence {
        let si = *sources
            .get(&e.source_id)
            .ok_or_else(|| Error::new("FRAGMENT_EVIDENCE_INVALID"))?;
        need(
            e.source_sha256 == p.sources[si].sha256 && indexes[si].valid(er(e)),
            "FRAGMENT_EVIDENCE_INVALID",
        )?;
        need(
            indexes[si].text(&p.sources[si].content, er(e))? == e.quote,
            "FRAGMENT_EVIDENCE_INVALID",
        )?;
    }
    for c in &p.covered {
        let si = *sources
            .get(&c.source_id)
            .ok_or_else(|| Error::new("FRAGMENT_COVERED_INVALID"))?;
        need(
            indexes[si].valid(Range {
                start: c.start,
                end: c.end,
            }),
            "FRAGMENT_COVERED_INVALID",
        )?;
    }
    Ok(Validated { indexes })
}
fn same_section(s: &Source, a: Range, b: Range) -> bool {
    let start = a.start.min(b.start);
    let end = (a.end - 1).max(b.end - 1);
    !s.blocks
        .iter()
        .any(|h| h.kind == "section_header" && h.start > start && h.start <= end)
}
fn whitespace_between(s: &Source, index: &TextIndex, a: usize, b: usize) -> Result<bool> {
    if a == b {
        return Ok(true);
    }
    if a > b {
        return Ok(false);
    }
    Ok(index
        .text(&s.content, Range { start: a, end: b })?
        .trim()
        .is_empty())
}
fn fully_covered(p: &Payload, source: &str, r: Range) -> bool {
    let mut ranges: Vec<_> = p
        .covered
        .iter()
        .filter(|c| c.source_id == source)
        .map(|c| Range {
            start: c.start,
            end: c.end,
        })
        .collect();
    ranges.sort_by_key(|r| r.start);
    let mut cursor = r.start;
    for c in ranges {
        if c.end <= cursor {
            continue;
        }
        if c.start > cursor {
            break;
        }
        cursor = cursor.max(c.end);
        if cursor >= r.end {
            return true;
        }
    }
    false
}
#[derive(Clone)]
struct Header {
    columns: Vec<String>,
    range: Range,
}
fn header(s: &Source, index: &TextIndex, b: &Block) -> Result<Option<Header>> {
    let text = index.text(&s.content, br(b))?;
    let mut byte = 0;
    let mut first = None;
    for line in text.split_inclusive('\n') {
        if first.is_none() && line.trim().is_empty() {
            byte += line.len();
            continue;
        }
        if let Some((start, line1)) = first.take() {
            let parse = |raw: &str| -> Option<Vec<String>> {
                let t = raw.trim();
                if !t.starts_with('|') || !t.ends_with('|') || t.contains('\\') {
                    return None;
                }
                Some(
                    t[1..t.len() - 1]
                        .split('|')
                        .map(|c| {
                            c.chars()
                                .filter(|ch| !ch.is_whitespace())
                                .collect::<String>()
                        })
                        .collect(),
                )
            };
            let Some(columns) = parse(line1) else {
                return Ok(None);
            };
            let Some(separator) = parse(line) else {
                return Ok(None);
            };
            if columns.is_empty()
                || columns.iter().any(String::is_empty)
                || columns.len() != separator.len()
                || !separator.iter().all(|s| {
                    let t = s.trim_matches(':');
                    t.len() >= 3 && t.chars().all(|c| c == '-')
                })
            {
                return Ok(None);
            }
            let start = b.start + text[..start].encode_utf16().count();
            let end = b.start + text[..byte + line.len()].encode_utf16().count();
            return Ok(Some(Header {
                columns,
                range: Range { start, end },
            }));
        } else {
            first = Some((byte, line));
        }
        byte += line.len();
    }
    Ok(None)
}
#[derive(Clone)]
struct Group {
    members: Vec<usize>,
    headers: Vec<Header>,
}
fn table_groups(s: &Source, index: &TextIndex, trace: &mut Vec<Value>) -> Result<Vec<Group>> {
    let tables: Vec<_> = s
        .blocks
        .iter()
        .enumerate()
        .filter(|(_, b)| b.kind == "table")
        .map(|(i, _)| i)
        .collect();
    let mut parsed = HashMap::new();
    for &i in &tables {
        if let Some(h) = header(s, index, &s.blocks[i])? {
            parsed.insert(i, h);
        } else {
            trace.push(json!({"source_id":s.id,"block_id":s.blocks[i].block_id,"status":"SKIPPED_TABLE_HEADER_UNSUPPORTED"}));
        }
    }
    let mut groups = Vec::new();
    let mut at = 0;
    while at < tables.len() {
        let first = tables[at];
        let Some(first_h) = parsed.get(&first) else {
            at += 1;
            continue;
        };
        let mut members = vec![first];
        let mut headers = vec![first_h.clone()];
        at += 1;
        while at < tables.len() {
            let prev = *members
                .last()
                .ok_or_else(|| Error::new("FRAGMENT_POLICY_INVALID"))?;
            let next = tables[at];
            let a = &s.blocks[prev];
            let b = &s.blocks[next];
            let Some(h) = parsed.get(&next) else { break };
            let continuous = a
                .page_numbers
                .last()
                .zip(b.page_numbers.first())
                .is_some_and(|(&a, &b)| a + 1 == b);
            if h.columns != headers[0].columns
                || !continuous
                || !same_section(s, br(a), br(b))
                || !whitespace_between(s, index, a.end, b.start)?
            {
                break;
            }
            members.push(next);
            headers.push(h.clone());
            at += 1;
        }
        if members.len() > 3 {
            trace.push(json!({"source_id":s.id,"table_block_ids":members.iter().map(|&i|&s.blocks[i].block_id).collect::<Vec<_>>(),"status":"SKIPPED_TABLE_GROUP_LIMIT"}));
            continue;
        }
        groups.push(Group { members, headers });
    }
    Ok(groups)
}
fn paragraph(b: &Block) -> bool {
    matches!(b.kind.as_str(), "paragraph" | "text" | "list_item")
}
fn note_pages(table: &Block, note: &Block) -> bool {
    table
        .page_numbers
        .last()
        .zip(note.page_numbers.first())
        .is_some_and(|(&a, &b)| b == a || b == a + 1)
}
#[derive(Clone)]
struct Candidate {
    source: usize,
    range: Range,
    kind: &'static str,
    reason: &'static str,
    anchors: Vec<usize>,
    tables: Vec<String>,
    block_id: String,
    terms: Vec<String>,
    priority: u8,
}
fn add(candidates: &mut Vec<Candidate>, mut candidate: Candidate) {
    if let Some(old) = candidates.iter_mut().find(|c| {
        c.source == candidate.source
            && c.range.start == candidate.range.start
            && c.range.end == candidate.range.end
    }) {
        for a in candidate.anchors.drain(..) {
            if !old.anchors.contains(&a) {
                old.anchors.push(a)
            }
        }
        for t in candidate.tables.drain(..) {
            if !old.tables.contains(&t) {
                old.tables.push(t)
            }
        }
        if candidate.priority < old.priority {
            old.kind = candidate.kind;
            old.reason = candidate.reason;
            old.priority = candidate.priority;
        }
        for t in candidate.terms {
            if !old.terms.contains(&t) {
                old.terms.push(t)
            }
        }
    } else {
        candidates.push(candidate)
    }
}
fn anchor_spans(p: &Payload, anchors: &[usize]) -> Vec<Value> {
    anchors.iter().map(|&i|{let e=&p.evidence[i];json!({"source_id":e.source_id,"source_sha256":e.source_sha256,"start":e.start,"end":e.end,"quote":e.quote})}).collect()
}
fn generic(term: &str) -> bool {
    matches!(
        term,
        "本节"
            | "本表"
            | "上述"
            | "规则"
            | "前提"
            | "功能"
            | "系统"
            | "结果"
            | "方案"
            | "例外"
            | "条件"
            | "本文"
            | "本书"
            | "结论"
            | "注意"
            | "信息"
            | "情况"
            | "问题"
            | "要求"
            | "能力"
    )
}
fn stable_terms(anchor: &str, target: &str) -> Result<Vec<String>> {
    let ascii = Regex::new(r"[A-Za-z][A-Za-z0-9_./-]{1,63}")
        .map_err(|_| Error::new("FRAGMENT_POLICY_INVALID"))?;
    let stop = [
        "the", "and", "this", "that", "with", "from", "into", "only", "table", "note", "rule",
        "system", "function", "none", "true", "false",
    ];
    let a: HashSet<_> = ascii
        .find_iter(anchor)
        .map(|m| m.as_str())
        .filter(|t| !stop.contains(&t.to_ascii_lowercase().as_str()))
        .collect();
    let mut terms: Vec<String> = ascii
        .find_iter(target)
        .filter_map(|m| a.contains(m.as_str()).then(|| m.as_str().to_owned()))
        .collect();
    let quoted = Regex::new(r#"“([^”\n]{2,64})”|"([^"\n]{2,64})""#)
        .map_err(|_| Error::new("FRAGMENT_POLICY_INVALID"))?;
    for captures in quoted.captures_iter(anchor) {
        if let Some(m) = captures.get(1).or_else(|| captures.get(2)) {
            if !generic(m.as_str()) && target.contains(m.as_str()) {
                terms.push(m.as_str().to_owned())
            }
        }
    }
    let topic=Regex::new(r"^(?:对于|关于)([^，,:：。\n]{2,48})[，,:：]|^(?:上述|该)([^，,:：。\n]{2,32}?)(?:仅|只|不|可|需|适用|允许|要求|的)").map_err(|_|Error::new("FRAGMENT_POLICY_INVALID"))?;
    if let Some(c) = topic.captures(target.trim()) {
        if let Some(m) = c.get(1).or_else(|| c.get(2)) {
            let term = m.as_str().trim();
            if !generic(term) && anchor.contains(term) {
                terms.push(term.to_owned())
            }
        }
    }
    terms.sort();
    terms.dedup();
    Ok(terms)
}

pub fn execute(value: &Value) -> Result<Value> {
    let r: Request =
        serde_json::from_value(value.clone()).map_err(|_| Error::new("RPC_INVALID_REQUEST"))?;
    need(
        r.wire_version == "lightog-context/0.1",
        "RPC_VERSION_UNSUPPORTED",
    )?;
    need(
        !r.request_id.is_empty() && r.request_id.len() <= 128,
        "RPC_INVALID_REQUEST",
    )?;
    need(r.operation == "fragments", "RPC_OPERATION_UNKNOWN")?;
    plan(&r.payload)
}
pub fn plan(payload: &Value) -> Result<Value> {
    let p: Payload =
        serde_json::from_value(payload.clone()).map_err(|_| Error::new("RPC_INVALID_PAYLOAD"))?;
    let v = validate(&p)?;
    let mut trace = Vec::new();
    let mut associations = Vec::new();
    let mut candidates = Vec::new();
    let note =
        Regex::new(r"^(?:注|表注)\s*[:：]").map_err(|_| Error::new("FRAGMENT_POLICY_INVALID"))?;
    let local_reference = Regex::new(r"(?:详?见)(本节注|本节说明|本节前提|本节例外)")
        .map_err(|_| Error::new("FRAGMENT_POLICY_INVALID"))?;
    let numbered_reference = Regex::new(r"(?:详?见)(表[A-Za-z0-9]+(?:[-－.][A-Za-z0-9]+)*)")
        .map_err(|_| Error::new("FRAGMENT_POLICY_INVALID"))?;
    let caption = Regex::new(r"^(表[A-Za-z0-9]+(?:[-－.][A-Za-z0-9]+)*)(?:\s|[:：]|$)")
        .map_err(|_| Error::new("FRAGMENT_POLICY_INVALID"))?;
    let qualifier = Regex::new(r"^(?:对于|关于|但是|但|不过|前提|例外|上述|该)")
        .map_err(|_| Error::new("FRAGMENT_POLICY_INVALID"))?;
    for (si, s) in p.sources.iter().enumerate() {
        let index = &v.indexes[si];
        let groups = table_groups(s, index, &mut trace)?;
        let source_evidence: Vec<_> = p
            .evidence
            .iter()
            .enumerate()
            .filter(|(_, e)| e.source_id == s.id)
            .map(|(i, _)| i)
            .collect();
        let mut group_anchors: Vec<Vec<usize>> = groups
            .iter()
            .map(|g| {
                source_evidence
                    .iter()
                    .copied()
                    .filter(|&ei| {
                        g.members
                            .iter()
                            .any(|&bi| br(&s.blocks[bi]).contains(er(&p.evidence[ei])))
                    })
                    .collect()
            })
            .collect();
        // A numbered reference is resolved only through an exact unique source caption,
        // immediately followed by its table. Bare "see table" is never a free-form link.
        for &ei in &source_evidence {
            let e = &p.evidence[ei];
            let mut seen_references = HashSet::new();
            for reference in numbered_reference.captures_iter(&e.quote) {
                let label = reference
                    .get(1)
                    .ok_or_else(|| Error::new("FRAGMENT_POLICY_INVALID"))?
                    .as_str();
                if !seen_references.insert(label.to_owned()) {
                    continue;
                }
                need(seen_references.len() <= 32, "FRAGMENT_RESOURCE_LIMIT")?;
                let mut matches = Vec::new();
                for (bi, b) in s.blocks.iter().enumerate() {
                    if !matches!(b.kind.as_str(), "text" | "paragraph" | "section_header") {
                        continue;
                    }
                    let text = index.text(&s.content, br(b))?;
                    if !caption
                        .captures(text.trim())
                        .and_then(|c| c.get(1))
                        .is_some_and(|m| m.as_str() == label)
                    {
                        continue;
                    }
                    let Some(next) = s.blocks.get(bi + 1) else {
                        continue;
                    };
                    if next.kind != "table"
                        || !same_section(s, er(e), br(next))
                        || er(e).distance(br(next)) > p.options.max_distance
                        || !whitespace_between(s, index, b.end, next.start)?
                    {
                        continue;
                    }
                    if let Some(gi) = groups.iter().position(|g| g.members.contains(&(bi + 1))) {
                        matches.push(gi)
                    }
                }
                matches.sort_unstable();
                matches.dedup();
                if matches.len() == 1 {
                    let gi = matches[0];
                    if !group_anchors[gi].contains(&ei) {
                        group_anchors[gi].push(ei)
                    }
                    associations.push(json!({"kind":"EXPLICIT_TABLE_REFERENCE","source_id":s.id,"reference":label,"anchor_spans":anchor_spans(&p,&[ei]),"table_block_ids":groups[gi].members.iter().map(|&bi|&s.blocks[bi].block_id).collect::<Vec<_>>()}));
                } else {
                    trace.push(json!({"source_id":s.id,"anchor_start":e.start,"status":"SKIPPED_REFERENCE_UNRESOLVED","reference":label,"candidate_count":matches.len()}));
                }
            }
        }
        for (gi, g) in groups.iter().enumerate() {
            let anchors = &group_anchors[gi];
            if anchors.is_empty() {
                continue;
            }
            let ids: Vec<_> = g
                .members
                .iter()
                .map(|&bi| s.blocks[bi].block_id.clone())
                .collect();
            associations.push(json!({"kind":"SOURCE_TABLE_GROUP","source_id":s.id,"table_block_ids":ids,"page_numbers":g.members.iter().flat_map(|&bi|s.blocks[bi].page_numbers.iter().copied()).collect::<Vec<_>>(),"header_columns":g.headers[0].columns,"anchor_spans":anchor_spans(&p,anchors),"assurance":"SOURCE_LAYOUT_ASSOCIATION_NOT_ENTITY_IDENTITY"}));
            if g.headers.iter().any(|h| fully_covered(&p, &s.id, h.range)) {
                trace.push(json!({"source_id":s.id,"table_block_ids":ids,"status":"SKIPPED_HEADER_ALREADY_COVERED"}));
            } else {
                let h = g
                    .headers
                    .iter()
                    .min_by_key(|h| {
                        anchors
                            .iter()
                            .map(|&ei| h.range.distance(er(&p.evidence[ei])))
                            .min()
                            .unwrap_or(usize::MAX)
                    })
                    .ok_or_else(|| Error::new("FRAGMENT_POLICY_INVALID"))?;
                if anchors.iter().any(|&ei| {
                    h.range.distance(er(&p.evidence[ei])) <= p.options.max_distance
                        && same_section(s, er(&p.evidence[ei]), h.range)
                }) {
                    add(
                        &mut candidates,
                        Candidate {
                            source: si,
                            range: h.range,
                            kind: "TABLE_HEADER",
                            reason: "SAME_TABLE_GROUP_HEADER",
                            anchors: anchors.clone(),
                            tables: ids.clone(),
                            block_id: ids[0].clone(),
                            terms: Vec::new(),
                            priority: 1,
                        },
                    );
                }
            }
            let tail_i = *g
                .members
                .last()
                .ok_or_else(|| Error::new("FRAGMENT_POLICY_INVALID"))?;
            let tail = &s.blocks[tail_i];
            let Some(b) = s.blocks.get(tail_i + 1) else {
                continue;
            };
            if !paragraph(b)
                || !note.is_match(index.text(&s.content, br(b))?.trim())
                || !whitespace_between(s, index, tail.end, b.start)?
            {
                continue;
            }
            if !note_pages(tail, b) {
                trace.push(json!({"source_id":s.id,"block_id":b.block_id,"status":"SKIPPED_NOTE_PAGE_METADATA"}));
                continue;
            }
            let note_anchors: Vec<_> = anchors
                .iter()
                .copied()
                .filter(|&ei| {
                    same_section(s, er(&p.evidence[ei]), br(b))
                        && er(&p.evidence[ei]).distance(br(b)) <= p.options.max_distance
                })
                .collect();
            if note_anchors.is_empty() {
                trace.push(json!({"source_id":s.id,"block_id":b.block_id,"status":"SKIPPED_NOTE_SECTION_OR_DISTANCE"}));
                continue;
            }
            add(
                &mut candidates,
                Candidate {
                    source: si,
                    range: br(b),
                    kind: "TABLE_NOTE",
                    reason: "CONTIGUOUS_TABLE_GROUP_TAIL_NOTE",
                    anchors: note_anchors.clone(),
                    tables: ids.clone(),
                    block_id: b.block_id.clone(),
                    terms: Vec::new(),
                    priority: 0,
                },
            );
            associations.push(json!({"kind":"TABLE_GROUP_NOTE","source_id":s.id,"table_block_ids":ids,"note_block_id":b.block_id,"start":b.start,"end":b.end,"anchor_spans":anchor_spans(&p,&note_anchors)}));
        }
        for &ei in &source_evidence {
            let e = &p.evidence[ei];
            // A local-section reference needs exactly one independently located matching
            // paragraph. Multiple plausible referents are refused, not ranked into certainty.
            let mut seen_references = HashSet::new();
            for reference in local_reference.captures_iter(&e.quote) {
                let whole = reference
                    .get(0)
                    .ok_or_else(|| Error::new("FRAGMENT_POLICY_INVALID"))?;
                let next = e.quote[whole.end()..].chars().next();
                need(
                    next.is_none_or(|ch| {
                        ch.is_whitespace() || "，,。；;：:！？?、)）]】”\"'".contains(ch)
                    }),
                    "FRAGMENT_REFERENCE_SUFFIX_UNSUPPORTED",
                )?;
                let label = reference
                    .get(1)
                    .ok_or_else(|| Error::new("FRAGMENT_POLICY_INVALID"))?
                    .as_str();
                if !seen_references.insert(label.to_owned()) {
                    continue;
                }
                let prefix = match label {
                    "本节注" => "注",
                    "本节说明" => "说明",
                    "本节前提" => "前提",
                    _ => "例外",
                };
                let mut found = Vec::new();
                for (bi, b) in s.blocks.iter().enumerate() {
                    if !paragraph(b)
                        || br(b).contains(er(e))
                        || !same_section(s, er(e), br(b))
                        || er(e).distance(br(b)) > p.options.max_distance
                    {
                        continue;
                    }
                    let t = index.text(&s.content, br(b))?.trim();
                    let marked = if prefix == "注" {
                        note.is_match(t)
                    } else {
                        t.starts_with(&format!("{prefix}："))
                            || t.starts_with(&format!("{prefix}:"))
                    };
                    if marked {
                        found.push(bi)
                    }
                }
                if found.len() == 1 {
                    let b = &s.blocks[found[0]];
                    add(
                        &mut candidates,
                        Candidate {
                            source: si,
                            range: br(b),
                            kind: "PARAGRAPH_QUALIFIER",
                            reason: "UNIQUE_EXPLICIT_SECTION_REFERENCE",
                            anchors: vec![ei],
                            tables: Vec::new(),
                            block_id: b.block_id.clone(),
                            terms: Vec::new(),
                            priority: 0,
                        },
                    );
                    associations.push(json!({"kind":"EXPLICIT_SECTION_REFERENCE","source_id":s.id,"reference":label,"block_id":b.block_id,"anchor_spans":anchor_spans(&p,&[ei])}));
                } else {
                    trace.push(json!({"source_id":s.id,"anchor_start":e.start,"status":"SKIPPED_REFERENCE_UNRESOLVED","reference":label,"candidate_count":found.len()}));
                }
            }
            let Some(bi) = s
                .blocks
                .iter()
                .position(|b| (paragraph(b) || b.kind == "table") && br(b).contains(er(e)))
            else {
                continue;
            };
            let anchor = &s.blocks[bi];
            for ni in [
                bi.checked_sub(1),
                bi.checked_add(1).filter(|&n| n < s.blocks.len()),
            ]
            .into_iter()
            .flatten()
            {
                let b = &s.blocks[ni];
                if !paragraph(b) {
                    continue;
                }
                let gap = if b.start < anchor.start {
                    whitespace_between(s, index, b.end, anchor.start)?
                } else {
                    whitespace_between(s, index, anchor.end, b.start)?
                };
                if !gap
                    || !same_section(s, er(e), br(b))
                    || er(e).distance(br(b)) > p.options.max_distance
                {
                    continue;
                }
                let text = index.text(&s.content, br(b))?;
                if !qualifier.is_match(text.trim()) {
                    continue;
                }
                if ni < bi {
                    let prefix = text.trim();
                    let explicit_precondition = [
                        "前提：",
                        "前提:",
                        "前提条件：",
                        "前提条件:",
                        "适用前提：",
                        "适用前提:",
                    ]
                    .iter()
                    .any(|p| prefix.starts_with(p));
                    if !explicit_precondition {
                        trace.push(json!({"source_id":s.id,"block_id":b.block_id,"anchor_start":e.start,"status":"SKIPPED_BACKWARD_REFERENCE_UNSUPPORTED"}));
                        continue;
                    }
                }
                let terms = stable_terms(&e.quote, text)?;
                if terms.is_empty() {
                    trace.push(json!({"source_id":s.id,"block_id":b.block_id,"anchor_start":e.start,"status":"SKIPPED_NO_STABLE_LITERAL_LINK"}));
                    continue;
                }
                add(
                    &mut candidates,
                    Candidate {
                        source: si,
                        range: br(b),
                        kind: "PARAGRAPH_QUALIFIER",
                        reason: "ADJACENT_QUALIFIER_WITH_LITERAL_LINK",
                        anchors: vec![ei],
                        tables: Vec::new(),
                        block_id: b.block_id.clone(),
                        terms,
                        priority: 2,
                    },
                );
            }
        }
    }
    candidates.sort_by(|a, b| {
        a.priority
            .cmp(&b.priority)
            .then_with(|| {
                let distance = |c: &Candidate| {
                    c.anchors
                        .iter()
                        .map(|&ei| c.range.distance(er(&p.evidence[ei])))
                        .min()
                        .unwrap_or(usize::MAX)
                };
                distance(a).cmp(&distance(b))
            })
            .then(p.sources[a.source].id.cmp(&p.sources[b.source].id))
            .then(a.range.start.cmp(&b.range.start))
    });
    let mut fragments = Vec::new();
    let mut chars = 0;
    let mut novel_chars = 0;
    let mut deferred = 0;
    for c in candidates {
        let s = &p.sources[c.source];
        let span = c.range;
        if fully_covered(&p, &s.id, span) {
            trace.push(json!({"source_id":s.id,"block_id":c.block_id,"status":"SKIPPED_ALREADY_COVERED","start":span.start,"end":span.end}));
            continue;
        }
        if span.length() > p.options.max_fragment_chars
            || chars + span.length() > p.options.max_total_chars
            || fragments.len() >= p.options.max_fragments
        {
            deferred += 1;
            trace.push(json!({"source_id":s.id,"block_id":c.block_id,"status":"DEFERRED_BUDGET","start":span.start,"end":span.end,"characters":span.length()}));
            continue;
        }
        let quote = v.indexes[c.source].text(&s.content, span)?;
        chars += span.length();
        let mut covered: Vec<_> = p
            .covered
            .iter()
            .filter(|r| r.source_id == s.id && r.start < span.end && span.start < r.end)
            .map(|r| Range {
                start: r.start.max(span.start),
                end: r.end.min(span.end),
            })
            .collect();
        covered.sort_by_key(|r| r.start);
        let mut cursor = span.start;
        let mut old = 0;
        for r in covered {
            let start = r.start.max(cursor);
            if r.end > start {
                old += r.end - start;
                cursor = r.end
            }
        }
        novel_chars += span.length() - old;
        fragments.push(json!({"source_id":s.id,"source_sha256":s.sha256,"start":span.start,"end":span.end,"quote":quote,"kind":c.kind,"reason":c.reason,"anchor_spans":anchor_spans(&p,&c.anchors),"table_block_ids":c.tables,"block_id":c.block_id,"literal_link_terms":c.terms}));
        trace.push(json!({"source_id":s.id,"block_id":c.block_id,"status":"SELECTED_FRAGMENT","kind":c.kind,"start":span.start,"end":span.end}));
    }
    let mut stamp = Vec::new();
    for s in &p.sources {
        stamp.push(json!({"source_id":s.id,"source_sha256":s.sha256,"layout_sha256":wire::sha(&serde_json::to_value(&s.blocks).map_err(|_|Error::new("FRAGMENT_BLOCKS_INVALID"))?)?}));
    }
    Ok(
        json!({"policy_version":VERSION,"source_stamp":stamp,"fragments":fragments,"associations":associations,"trace":trace,"deferred_count":deferred,"fragment_characters":chars,"novel_characters":novel_chars,"budget":{"max_fragments":p.options.max_fragments,"max_fragment_chars":p.options.max_fragment_chars,"max_total_chars":p.options.max_total_chars,"max_distance":p.options.max_distance},"scope":"BOUNDED_SOURCE_LAYOUT_RECALL_NOT_FACT_OR_IDENTITY_PROOF","recursive_expansion":false}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(same_page: bool, missing_page: bool, new_section: bool) -> Value {
        let h = "| 中文术语 | Semantic Ontology | KG Schema |\n| --- | --- | --- |\n";
        let a = format!("{h}| 标签 | — (无标签概念) | Node Label |");
        let b = format!("{h}| 权限 | — (无权限概念) | Graph ACL |");
        let note = "注：表中\" - \"表示该本体论体系中不存在直接对应的概念。";
        let mut content = String::new();
        let mut blocks = Vec::new();
        let mut push = |id: &str, kind: &str, text: &str, pages: Vec<u32>| {
            let start = content.encode_utf16().count();
            content.push_str(text);
            let end = content.encode_utf16().count();
            blocks.push(
                json!({"block_id":id,"kind":kind,"start":start,"end":end,"page_numbers":pages}),
            );
            content.push_str("\n\n");
        };
        push(
            "a",
            "table",
            &a,
            if missing_page { vec![] } else { vec![149] },
        );
        if new_section {
            push("section", "section_header", "另章", vec![150]);
        }
        push("b", "table", &b, vec![if same_page { 149 } else { 150 }]);
        push(
            "note",
            "text",
            note,
            vec![if same_page { 149 } else { 150 }],
        );
        push("appendix", "section_header", "附录B", vec![151]);
        let sha = wire::text_sha(&content);
        let start = h.encode_utf16().count();
        let end = a.encode_utf16().count();
        json!({"sources":[{"id":"s","content":content,"sha256":sha,"blocks":blocks}],"evidence":[{"source_id":"s","source_sha256":sha,"start":start,"end":end,"quote":&a[h.len()..]}],"covered":[{"source_id":"s","start":0,"end":end}],"options":{"max_fragments":6,"max_fragment_chars":1200,"max_total_chars":2400,"max_distance":6000}})
    }
    #[test]
    fn known_cross_page_note_shape() {
        let p = fixture(false, false, false);
        let before = p.clone();
        let r = plan(&p).unwrap();
        assert_eq!(r["fragments"].as_array().unwrap().len(), 1);
        assert_eq!(r["fragments"][0]["kind"], "TABLE_NOTE");
        assert_eq!(r["fragments"][0]["table_block_ids"], json!(["a", "b"]));
        assert_eq!(p, before);
    }
    #[test]
    fn same_header_is_not_same_table() {
        for p in [
            fixture(true, false, false),
            fixture(false, true, false),
            fixture(false, false, true),
        ] {
            let r = plan(&p).unwrap();
            assert!(r["fragments"].as_array().unwrap().is_empty());
        }
    }
    #[test]
    fn budgets_do_not_truncate_note() {
        let mut p = fixture(false, false, false);
        p["options"]["max_fragment_chars"] = json!(3);
        let r = plan(&p).unwrap();
        assert!(r["fragments"].as_array().unwrap().is_empty());
        assert_eq!(r["deferred_count"], 1);
        let p = fixture(false, false, false);
        let mut p = p;
        let range = json!({"source_id":"s","start":p["sources"][0]["blocks"][2]["start"],"end":p["sources"][0]["blocks"][2]["end"]});
        p["covered"].as_array_mut().unwrap().push(range);
        assert!(plan(&p).unwrap()["fragments"]
            .as_array()
            .unwrap()
            .is_empty());
    }
    #[test]
    fn source_and_metadata_are_strict() {
        let mut p = fixture(false, false, false);
        p["sources"][0]["sha256"] = json!("bad");
        assert_eq!(plan(&p).unwrap_err().code, "FRAGMENT_SOURCE_HASH_MISMATCH");
        let mut p = fixture(false, false, false);
        p["sources"][0]["blocks"][1]["start"] = json!(0);
        assert_eq!(plan(&p).unwrap_err().code, "FRAGMENT_BLOCK_ORDER_INVALID");
        let mut p = fixture(false, false, false);
        p["sources"][0]["blocks"][1]["block_id"] = json!("a");
        assert_eq!(plan(&p).unwrap_err().code, "FRAGMENT_BLOCK_ID_DUPLICATE");
    }
    #[test]
    fn utf16_rejects_half_surrogate() {
        let text = "甲😀乙";
        let sha = wire::text_sha(text);
        let p = json!({"sources":[{"id":"s","content":text,"sha256":sha,"blocks":[{"block_id":"p","kind":"text","start":0,"end":4,"page_numbers":[1]}]}],"evidence":[{"source_id":"s","source_sha256":sha,"start":1,"end":2,"quote":"甲"}],"covered":[]});
        assert_eq!(plan(&p).unwrap_err().code, "FRAGMENT_EVIDENCE_INVALID");
    }
    #[test]
    fn stable_literal_links_not_generic_cues() {
        assert!(stable_terms("该功能可以使用", "但该功能仅在例外时使用")
            .unwrap()
            .is_empty());
        assert_eq!(
            stable_terms("BOM supports query", "但 BOM 仅在满足前提时成立").unwrap(),
            vec!["BOM"]
        );
        assert_eq!(
            stable_terms("退款规则已经声明", "对于退款规则，仅在审批后执行").unwrap(),
            vec!["退款规则"]
        );
        assert!(stable_terms("Agent", "但 GraphAgent 需要审批")
            .unwrap()
            .is_empty());
    }
    fn paragraph_fixture(parts: &[(&str, &str)], anchor: usize) -> Value {
        let mut content = String::new();
        let mut blocks = Vec::new();
        for (i, (kind, text)) in parts.iter().enumerate() {
            let start = content.encode_utf16().count();
            content.push_str(text);
            let end = content.encode_utf16().count();
            blocks.push(json!({"block_id":format!("p{i}"),"kind":kind,"start":start,"end":end,"page_numbers":[1]}));
            content.push_str("\n\n");
        }
        let a = &blocks[anchor];
        let sha = wire::text_sha(&content);
        json!({"sources":[{"id":"s","content":content,"sha256":sha,"blocks":blocks}],"evidence":[{"source_id":"s","source_sha256":sha,"start":a["start"],"end":a["end"],"quote":parts[anchor].1}],"covered":[{"source_id":"s","start":a["start"],"end":a["end"]}]})
    }
    #[test]
    fn forward_qualifier_and_backward_scope_are_distinct() {
        let p = paragraph_fixture(
            &[
                ("text", "BOM 声明支持查询。"),
                ("text", "但 BOM 仅在审批后可用。"),
                ("text", "但 BOM 还有其他前提。"),
            ],
            0,
        );
        let r = plan(&p).unwrap();
        assert_eq!(r["fragments"].as_array().unwrap().len(), 1);
        assert_eq!(r["fragments"][0]["block_id"], "p1");
        assert_eq!(r["fragments"][0]["kind"], "PARAGRAPH_QUALIFIER");
        let p = paragraph_fixture(
            &[
                ("text", "但 BOM 仅在审批后可用。"),
                ("text", "BOM 声明支持查询。"),
            ],
            1,
        );
        assert!(plan(&p).unwrap()["fragments"]
            .as_array()
            .unwrap()
            .is_empty());
        let p = paragraph_fixture(
            &[
                ("text", "前提：BOM 已通过审批。"),
                ("text", "BOM 声明支持查询。"),
            ],
            1,
        );
        assert_eq!(plan(&p).unwrap()["fragments"].as_array().unwrap().len(), 1);
        let p = paragraph_fixture(
            &[
                ("text", "BOM 声明支持查询。"),
                ("code", "但 BOM 仅在审批后可用。"),
            ],
            0,
        );
        assert!(plan(&p).unwrap()["fragments"]
            .as_array()
            .unwrap()
            .is_empty());
    }
    #[test]
    fn explicit_reference_requires_exact_unique_referent() {
        let p = paragraph_fixture(
            &[
                ("text", "BOM 声明详见本节注。"),
                ("text", "注：仅适用于当前版本。"),
            ],
            0,
        );
        assert_eq!(plan(&p).unwrap()["fragments"].as_array().unwrap().len(), 1);
        for suffix in ["A", "1", "释"] {
            let anchor = format!("BOM 声明详见本节注{suffix}。");
            let p = paragraph_fixture(&[("text", &anchor), ("text", "注：其他对象的说明。")], 0);
            assert_eq!(
                plan(&p).unwrap_err().code,
                "FRAGMENT_REFERENCE_SUFFIX_UNSUPPORTED"
            );
        }
        let p = paragraph_fixture(
            &[
                ("text", "BOM 声明详见本节注。"),
                ("text", "注：第一个对象。"),
                ("text", "注：第二个对象。"),
            ],
            0,
        );
        assert!(plan(&p).unwrap()["fragments"]
            .as_array()
            .unwrap()
            .is_empty());
        let p = paragraph_fixture(
            &[
                ("text", "BOM 声明详见本节注。"),
                ("section_header", "另章"),
                ("text", "注：另章对象。"),
            ],
            0,
        );
        assert!(plan(&p).unwrap()["fragments"]
            .as_array()
            .unwrap()
            .is_empty());
    }
    #[test]
    fn partial_coverage_still_returns_entire_original_note() {
        let mut p = fixture(false, false, false);
        let b = p["sources"][0]["blocks"][2].clone();
        p["covered"]
            .as_array_mut()
            .unwrap()
            .push(json!({"source_id":"s","start":b["start"],"end":b["start"].as_u64().unwrap()+3}));
        let r = plan(&p).unwrap();
        let f = &r["fragments"][0];
        assert_eq!(f["start"], b["start"]);
        assert_eq!(f["end"], b["end"]);
        assert_eq!(
            r["fragment_characters"].as_u64().unwrap() - r["novel_characters"].as_u64().unwrap(),
            3
        );
    }
}
