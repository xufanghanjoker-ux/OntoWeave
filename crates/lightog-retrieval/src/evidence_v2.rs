//! Independent evidence policy v2. Supplied anchors are admission only. Unverified
//! source context is retained separately and must never be consumed as a claim.
use lightog_demand::{need, wire, Error, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub const VERSION: &str = "evidence-scope/0.2";
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
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Source {
    id: String,
    content: String,
    sha256: String,
    blocks: Vec<Block>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Span {
    source_id: String,
    source_sha256: String,
    start: usize,
    end: usize,
    quote: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Covered {
    source_id: String,
    start: usize,
    end: usize,
}
#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Options {
    max_selected_chars: usize,
    max_context_chars: usize,
    max_fragments: usize,
    max_anchor_distance: usize,
    max_fallback_chars: usize,
    max_fallback_fragments: usize,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            max_selected_chars: 16000,
            max_context_chars: 16000,
            max_fragments: 128,
            max_anchor_distance: 6000,
            max_fallback_chars: 16000,
            max_fallback_fragments: 128,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    question: String,
    sources: Vec<Source>,
    anchors: Vec<Span>,
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
    fn contains(self, r: Self) -> bool {
        self.start <= r.start && r.end <= self.end
    }
    fn overlap(self, r: Self) -> bool {
        self.start < r.end && r.start < self.end
    }
    fn distance(self, r: Self) -> usize {
        self.start
            .saturating_sub(r.end)
            .max(r.start.saturating_sub(self.end))
    }
    fn len(self) -> usize {
        self.end - self.start
    }
}
fn br(b: &Block) -> Range {
    Range {
        start: b.start,
        end: b.end,
    }
}
fn ar(a: &Span) -> Range {
    Range {
        start: a.start,
        end: a.end,
    }
}
struct Index {
    bytes: Vec<Option<usize>>,
}
impl Index {
    fn new(t: &str) -> Self {
        let mut bytes = Vec::new();
        for (i, c) in t.char_indices() {
            bytes.push(Some(i));
            if c.len_utf16() == 2 {
                bytes.push(None);
            }
        }
        bytes.push(Some(t.len()));
        Self { bytes }
    }
    fn text<'a>(&self, t: &'a str, r: Range) -> Result<&'a str> {
        need(r.start < r.end, "EVIDENCE_OFFSET_INVALID")?;
        let a = self
            .bytes
            .get(r.start)
            .and_then(|v| *v)
            .ok_or_else(|| Error::new("EVIDENCE_OFFSET_INVALID"))?;
        let b = self
            .bytes
            .get(r.end)
            .and_then(|v| *v)
            .ok_or_else(|| Error::new("EVIDENCE_OFFSET_INVALID"))?;
        t.get(a..b)
            .ok_or_else(|| Error::new("EVIDENCE_OFFSET_INVALID"))
    }
}
fn compact(t: &str) -> String {
    t.chars().filter(|c| !c.is_whitespace()).collect()
}
fn qualifier_markers(text: &str) -> HashSet<String> {
    let marker =
        Regex::new(r"(?i)(?:v[0-9]+(?:\.[0-9]+)*|(?:19|20)[0-9]{2})").expect("constant regex");
    marker
        .find_iter(text)
        .filter(|m| {
            !text[..m.start()]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
                && !text[m.end()..]
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        })
        .map(|m| m.as_str().to_ascii_lowercase())
        .collect()
}
fn technical(t: &str) -> Vec<String> {
    let r = Regex::new(r"[A-Za-z][A-Za-z0-9_./-]*").expect("constant regex");
    let mut seen = HashSet::new();
    r.find_iter(t)
        .map(|m| m.as_str().trim_end_matches('.').to_owned())
        .filter(|v| !v.is_empty() && seen.insert(v.clone()))
        .collect()
}
fn question_owners(q: &str) -> Vec<String> {
    let operators: HashSet<&str> = [
        "what", "which", "when", "where", "why", "how", "does", "do", "is", "are", "was", "were",
        "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "with", "can", "could",
        "should", "must", "not", "it", "its", "this", "that", "these", "those", "please",
    ]
    .into_iter()
    .collect();
    technical(q)
        .into_iter()
        .filter(|v| {
            !operators.contains(v.to_ascii_lowercase().as_str())
                && v.chars()
                    .any(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_' || c == '-')
        })
        .collect()
}
fn literal(text: &str, term: &str) -> bool {
    if term.is_ascii() {
        technical(text).iter().any(|t| t == term)
    } else {
        compact(text).contains(&compact(term))
    }
}
fn question_literal(question: &str, term: &str) -> Option<String> {
    if !literal(question, term) {
        return None;
    }
    if term.is_ascii() {
        return Some(term.to_owned());
    }
    let target = compact(term);
    let mut normalized = String::new();
    let mut map = Vec::new();
    for (byte, c) in question.char_indices() {
        if c.is_whitespace() {
            continue;
        }
        let at = normalized.len();
        normalized.push(c);
        map.push((at, byte, byte + c.len_utf8()));
    }
    let start = normalized.find(&target)?;
    let end = start + target.len();
    let first = map.iter().find(|m| m.0 == start)?;
    let last = map.iter().rev().find(|m| m.0 < end)?;
    Some(question[first.1..last.2].to_owned())
}
fn hits(t: &str, terms: &[String]) -> Vec<String> {
    terms.iter().filter(|v| literal(t, v)).cloned().collect()
}
fn target_terms(question: &str) -> Vec<String> {
    let mut q = question.to_owned();
    for op in [
        "为什么",
        "是什么",
        "是多少",
        "有哪些",
        "有什么",
        "有何",
        "如何",
        "怎么",
        "是否",
        "能否",
        "什么",
        "哪些",
        "多少",
        "请问",
        "资料",
        "分别",
        "需要",
        "应该",
    ] {
        q = q.replace(op, " ");
    }
    let generic: HashSet<&str> = [
        "策略", "方案", "方法", "目标", "条件", "约束", "业务", "数据", "系统", "对象", "主体",
        "关系", "能力", "操作", "执行", "技术", "问题", "内容", "相关", "概念", "以及", "中的",
        "这个", "那些", "这些", "对于", "关于", "要求", "能够", "可以", "不能", "直接", "标准",
        "解释", "表中", "根据", "上述", "必须", "还是", "的是", "建议", "作用", "过程", "功能",
        "方面",
    ]
    .into_iter()
    .collect();
    let re = Regex::new(r"[\p{Script=Han}]+").expect("constant regex");
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for m in re.find_iter(&q) {
        let chars: Vec<_> = m.as_str().chars().collect();
        for w in chars.windows(2) {
            let v: String = w.iter().collect();
            if !generic.contains(v.as_str()) && seen.insert(v.clone()) {
                out.push(v);
            }
        }
    }
    // English targets are literal non-operator words. Technical owners are handled
    // separately; retaining a word here does not make it a subject.
    let stop: HashSet<&str> = [
        "what", "which", "when", "where", "why", "how", "does", "do", "is", "are", "was", "were",
        "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "with", "can", "could",
        "should", "must", "not", "it", "its", "this", "that", "these", "those", "please",
    ]
    .into_iter()
    .collect();
    for token in technical(question) {
        if token.len() >= 3
            && !stop.contains(token.to_ascii_lowercase().as_str())
            && seen.insert(token.clone())
        {
            out.push(token);
        }
    }
    out
}
fn outside_quotes(text: &str) -> String {
    let mut close = None;
    let mut out = String::new();
    for c in text.chars() {
        if let Some(end) = close {
            if c == end {
                close = None;
            }
            out.push(' ');
        } else {
            match c {
                '“' => {
                    close = Some('”');
                    out.push(' ');
                }
                '‘' => {
                    close = Some('’');
                    out.push(' ');
                }
                '"' => {
                    close = Some('"');
                    out.push(' ');
                }
                _ => out.push(c),
            }
        }
    }
    out
}
fn pronoun(token: &str) -> bool {
    [
        "it",
        "its",
        "they",
        "their",
        "this",
        "these",
        "that",
        "those",
        "however",
        "therefore",
        "if",
        "unless",
        "although",
        "when",
        "then",
        "the",
        "a",
        "an",
    ]
    .contains(&token.to_ascii_lowercase().as_str())
}
fn leading_actor(text: &str) -> Option<String> {
    let outside = outside_quotes(text);
    let prefix=Regex::new(r"(?i)^(?:(?:however|therefore|also|then)[,，:]?\s+|(?:the|a|an)\s+|(?:note|notes|remark|remarks|warning|example|examples)\s*[:：]\s*)").expect("constant regex");
    let base = outside
        .trim_start_matches(|c: char| c.is_whitespace() || "-—•*()（）0123456789.、".contains(c));
    let raw = prefix.replace(base, "");
    let raw = raw.as_ref();
    let first = technical(raw).into_iter().next()?;
    if pronoun(&first) {
        return None;
    }
    if ["e.g", "i.e", "etc"].contains(&first.as_str()) {
        return None;
    }
    let position = raw.find(&first)?;
    let before = &raw[..position];
    if position == 0 || before.trim_end().ends_with(['：', ':']) {
        Some(first)
    } else {
        None
    }
}
fn grammatical_continuation(text: &str) -> bool {
    let t = outside_quotes(text);
    let t = t.trim_start();
    [
        "其", "该", "此", "这", "上述", "前者", "后者", "但", "然而", "若", "如果", "只有", "除非",
        "即使", "虽然", "因此", "其中",
    ]
    .iter()
    .any(|v| t.starts_with(v))
        || technical(t).first().is_some_and(|v| pronoun(v))
}
fn qualifier(text: &str) -> bool {
    [
        "不", "仅", "若", "如果", "除", "必须", "须", "前提", "例外", "unless", "only", "except",
        "not ", "must ", "cannot", "without",
    ]
    .iter()
    .any(|v| text.to_ascii_lowercase().contains(v))
}
fn code_heading(text: &str) -> bool {
    let re=Regex::new(r"(?:[A-Za-z_][A-Za-z0-9_-]*:[A-Za-z_]|^[\[\]{};<>]|^(?:def |class |return |SELECT |MATCH ))").expect("constant regex");
    re.is_match(text.trim())
}
fn same_section(s: &Source, idx: &Index, a: Range, b: Range) -> bool {
    let start = a.start.min(b.start);
    let end = (a.end - 1).max(b.end - 1);
    !s.blocks.iter().any(|h| {
        h.kind == "section_header"
            && h.start > start
            && h.start <= end
            && !idx.text(&s.content, br(h)).is_ok_and(code_heading)
    })
}
fn covered(p: &Payload, sid: &str, r: Range) -> bool {
    let mut ranges: Vec<_> = p.covered.iter().filter(|v| v.source_id == sid).collect();
    ranges.sort_by_key(|v| v.start);
    let mut cursor = r.start;
    for v in ranges {
        if v.start > cursor {
            break;
        }
        cursor = cursor.max(v.end);
        if cursor >= r.end {
            return true;
        }
    }
    false
}
fn span(s: &Source, idx: &Index, r: Range) -> Result<Value> {
    Ok(
        json!({"source_id":s.id,"source_sha256":s.sha256,"start":r.start,"end":r.end,"quote":idx.text(&s.content,r)?}),
    )
}
// Atomic sentence boundaries do not split semicolon conditions. English decimal
// points, initials, URLs and common abbreviation punctuation stay inside a unit.
fn sentences(text: &str, base: usize) -> Vec<Range> {
    let chars: Vec<_> = text.chars().collect();
    let mut result = Vec::new();
    let mut start = base;
    let mut pos = base;
    let mut prefix = String::new();
    let mut quote = None;
    for (i, c) in chars.iter().enumerate() {
        pos += c.len_utf16();
        prefix.push(*c);
        if let Some(end) = quote {
            if *c == end {
                quote = None;
            }
            continue;
        } else if *c == '“' {
            quote = Some('”');
            continue;
        } else if *c == '‘' {
            quote = Some('’');
            continue;
        } else if *c == '"' {
            quote = Some('"');
            continue;
        }
        let mut boundary = "。！？!?".contains(*c);
        if *c == '.' {
            let prev = i.checked_sub(1).and_then(|j| chars.get(j));
            let next = chars.get(i + 1);
            let next_word = chars[i + 1..].iter().find(|c| !c.is_whitespace());
            let decimal = prev.is_some_and(|c| c.is_ascii_digit())
                && next.is_some_and(|c| c.is_ascii_digit());
            let abbreviation = [
                "e.g.", "i.e.", "et al.", "Dr.", "Mr.", "Mrs.", "Fig.", "Eq.", "vs.", "etc.",
            ]
            .iter()
            .any(|v| prefix.ends_with(v))
                || Regex::new(r"(?:[A-Z]\.){2,}$")
                    .expect("constant regex")
                    .is_match(&prefix);
            let word = prefix
                .trim_end_matches('.')
                .split_whitespace()
                .last()
                .unwrap_or("");
            let initial = word.len() == 1 && word.chars().all(|c| c.is_ascii_uppercase());
            boundary = !decimal
                && !abbreviation
                && !initial
                && !next.is_some_and(|c| c.is_alphanumeric())
                && !next_word.is_some_and(|c| c.is_ascii_lowercase());
        }
        if boundary {
            result.push(Range { start, end: pos });
            start = pos;
            prefix.clear();
        }
    }
    if pos > start {
        result.push(Range { start, end: pos });
    }
    result
}
#[derive(Clone)]
struct Owner {
    term: String,
    origin: Value,
}
#[derive(Clone)]
struct Unit {
    range: Range,
    block: usize,
    owner: Option<Owner>,
    explicit: bool,
    ambiguous: bool,
    quoted: bool,
}
fn owner_at(s: &Source, idx: &Index, r: Range, term: String, kind: &str) -> Result<Owner> {
    let mut origin = span(s, idx, r)?;
    origin["kind"] = json!(kind);
    Ok(Owner { term, origin })
}
fn heading_owner(s: &Source, idx: &Index, at: usize, q: &[String]) -> Result<Option<Owner>> {
    if let Some(h) = s.blocks.iter().rev().find(|h| {
        h.kind == "section_header"
            && h.end <= at
            && !idx.text(&s.content, br(h)).is_ok_and(code_heading)
    }) {
        let raw = idx.text(&s.content, br(h))?;
        if let Some(term) = leading_actor(raw) {
            return Ok(Some(owner_at(s, idx, br(h), term, "HEADING_OWNER")?));
        }
        let matching = hits(raw, q);
        if matching.len() == 1 {
            return Ok(Some(owner_at(
                s,
                idx,
                br(h),
                matching[0].clone(),
                "HEADING_QUESTION_TERM",
            )?));
        }
    }
    Ok(None)
}
fn argument_units(s: &Source, idx: &Index, q: &[String]) -> Result<Vec<Unit>> {
    let mut units = Vec::new();
    for (bi, b) in s.blocks.iter().enumerate() {
        if !matches!(b.kind.as_str(), "text" | "paragraph" | "list_item") {
            continue;
        }
        let mut current = heading_owner(s, idx, b.start, q)?;
        for range in sentences(idx.text(&s.content, br(b))?, b.start) {
            let raw = idx.text(&s.content, range)?;
            if raw.trim().is_empty() {
                continue;
            }
            let outside = outside_quotes(raw);
            let quoted = outside.trim() != raw.trim()
                && (raw.contains('“') || raw.contains('‘') || raw.contains('"'));
            let actors: Vec<_> = raw.split(['；', ';']).filter_map(leading_actor).collect();
            let distinct: HashSet<_> = actors.iter().collect();
            let ambiguous = distinct.len() > 1;
            let explicit = leading_actor(raw);
            if let Some(term) = explicit.clone() {
                current = Some(owner_at(s, idx, range, term, "EXPLICIT_ARGUMENT_OWNER")?);
            }
            let own = if ambiguous {
                None
            } else if explicit.is_some() || grammatical_continuation(raw) {
                current.clone()
            } else {
                None
            };
            units.push(Unit {
                range,
                block: bi,
                owner: own.clone(),
                explicit: explicit.is_some(),
                ambiguous,
                quoted,
            });
            if ambiguous || own.is_none() {
                current = None;
            }
        }
    }
    Ok(units)
}
#[derive(Clone)]
struct Cell {
    range: Range,
    text: String,
}
struct Table {
    block: usize,
    header: Range,
    columns: Vec<Cell>,
    rows: Vec<Vec<Cell>>,
}
fn cells(line: &str, start: usize) -> Option<Vec<Cell>> {
    let trimmed = line.trim();
    if !trimmed.starts_with('|') || !trimmed.ends_with('|') || trimmed.contains('\\') {
        return None;
    }
    let outer = line.find('|')?;
    let mut offset = start + line[..outer + 1].encode_utf16().count();
    let mut result = Vec::new();
    for raw in line[outer + 1..]
        .trim_end_matches(['\n', '\r'])
        .strip_suffix('|')?
        .split('|')
    {
        let left = raw.len() - raw.trim_start().len();
        let text = raw.trim();
        if text.is_empty() {
            return None;
        }
        let a = offset + raw[..left].encode_utf16().count();
        result.push(Cell {
            range: Range {
                start: a,
                end: a + text.encode_utf16().count(),
            },
            text: text.to_owned(),
        });
        offset += raw.encode_utf16().count() + 1;
    }
    Some(result)
}
fn parse_table(s: &Source, idx: &Index, bi: usize) -> Result<Option<Table>> {
    let b = &s.blocks[bi];
    let raw = idx.text(&s.content, br(b))?;
    let mut position = b.start;
    let mut lines = Vec::new();
    for line in raw.split_inclusive('\n') {
        lines.push((position, line));
        position += line.encode_utf16().count();
    }
    for i in 0..lines.len().saturating_sub(1) {
        let Some(columns) = cells(lines[i].1, lines[i].0) else {
            continue;
        };
        let Some(sep) = cells(lines[i + 1].1, lines[i + 1].0) else {
            continue;
        };
        if columns.len() != sep.len()
            || columns.len() < 2
            || !sep.iter().all(|c| {
                let t = c.text.trim_matches(':');
                t.len() >= 3 && t.chars().all(|c| c == '-')
            })
        {
            continue;
        }
        let mut rows = Vec::new();
        let mut valid = true;
        for &(at, line) in &lines[i + 2..] {
            if line.trim().is_empty() {
                continue;
            }
            let Some(row) = cells(line, at) else {
                valid = false;
                break;
            };
            if row.len() != columns.len() {
                valid = false;
                break;
            }
            rows.push(row);
        }
        if valid && !rows.is_empty() {
            return Ok(Some(Table {
                block: bi,
                header: Range {
                    start: lines[i].0,
                    end: lines[i + 1].0 + lines[i + 1].1.encode_utf16().count(),
                },
                columns,
                rows,
            }));
        }
    }
    Ok(None)
}
fn unsupported_table_structure(s: &Source, idx: &Index, b: &Block) -> Result<Range> {
    let raw = idx.text(&s.content, br(b))?;
    let mut end = b.start;
    let mut saw_pipe = false;
    for line in raw.split_inclusive('\n') {
        end += line.encode_utf16().count();
        if saw_pipe && line.contains('|') && line.contains("---") {
            return Ok(Range {
                start: b.start,
                end,
            });
        }
        saw_pipe = line.contains('|');
    }
    // Unknown syntax is retained as raw layout only, subject to the same budget;
    // it never acquires invented columns. Oversize retention explicitly defers.
    Ok(br(b))
}
struct TableScope {
    table: usize,
    owners: Vec<Owner>,
    columns: Vec<Value>,
}
struct Output {
    selected: Vec<Value>,
    fallback: Vec<Value>,
    pending: Vec<Value>,
    deferred: Vec<Value>,
    excluded: Vec<Value>,
    selected_chars: usize,
    fallback_chars: usize,
    keys: HashSet<(String, usize, usize)>,
    excluded_omitted: usize,
}
impl Output {
    fn new() -> Self {
        Self {
            selected: Vec::new(),
            fallback: Vec::new(),
            pending: Vec::new(),
            deferred: Vec::new(),
            excluded: Vec::new(),
            selected_chars: 0,
            fallback_chars: 0,
            keys: HashSet::new(),
            excluded_omitted: 0,
        }
    }
    fn already(&self, sid: &str, r: Range) -> bool {
        self.keys.contains(&(sid.to_owned(), r.start, r.end))
    }
    fn retained(&self, sid: &str, r: Range) -> bool {
        self.selected.iter().chain(self.fallback.iter()).any(|v| {
            v["source_id"] == sid
                && v["start"].as_u64().is_some_and(|a| a as usize <= r.start)
                && v["end"].as_u64().is_some_and(|b| b as usize >= r.end)
        })
    }
    fn room(&self, p: &Payload, r: Range, uncertain: bool) -> bool {
        self.selected.len() + self.fallback.len() < p.options.max_fragments
            && self.selected_chars + self.fallback_chars + r.len() <= p.options.max_context_chars
            && if uncertain {
                self.fallback.len() < p.options.max_fallback_fragments
                    && self.fallback_chars + r.len() <= p.options.max_fallback_chars
            } else {
                self.selected_chars + r.len() <= p.options.max_selected_chars
            }
    }
    fn defer(&mut self, s: &Source, r: Range, reason: &str, kind: &str) {
        self.deferred.push(json!({"source_id":s.id,"source_sha256":s.sha256,"start":r.start,"end":r.end,"reason":reason,"required_kind":kind,"sent_to_context":false}));
    }
    fn exclude(&mut self, s: &Source, r: Range, reason: &str) {
        if self.excluded.len() < 256 {
            self.excluded
                .push(json!({"source_id":s.id,"start":r.start,"end":r.end,"reason":reason}));
        } else {
            self.excluded_omitted += 1;
        }
    }
    fn selected(
        &mut self,
        p: &Payload,
        s: &Source,
        idx: &Index,
        r: Range,
        role: &str,
        binding: Value,
    ) -> Result<()> {
        if self.already(&s.id, r) {
            return Ok(());
        }
        need(covered(p, &s.id, r), "EVIDENCE_SELECTION_OUTSIDE_COVERED")?;
        if !self.room(p, r, false) {
            self.defer(
                s,
                r,
                "SHARED_CONTEXT_OR_SELECTED_BUDGET",
                "ASSERTED_EVIDENCE_RETENTION",
            );
            return Ok(());
        }
        let mut row = span(s, idx, r)?;
        row["role"] = json!(role);
        row["status"] = json!("ASSERTED_SOURCE_BINDING");
        row["binding"] = binding;
        self.selected.push(row);
        self.selected_chars += r.len();
        self.keys.insert((s.id.clone(), r.start, r.end));
        Ok(())
    }
    fn fallback(
        &mut self,
        p: &Payload,
        s: &Source,
        idx: &Index,
        r: Range,
        reason: &str,
        context: Vec<Value>,
    ) -> Result<()> {
        if self.retained(&s.id, r)
            || self
                .pending
                .iter()
                .any(|v| v["source_id"] == s.id && v["start"] == r.start && v["end"] == r.end)
        {
            return Ok(());
        }
        need(covered(p, &s.id, r), "EVIDENCE_SELECTION_OUTSIDE_COVERED")?;
        need(self.pending.len() < 4096, "EVIDENCE_RESOURCE_LIMIT")?;
        let mut row = span(s, idx, r)?;
        row["status"] = json!("UNCERTAIN_CONTEXT");
        row["reasons"] = json!([reason]);
        row["context_spans"] = json!(context);
        row["assurance"] = json!("UNVERIFIED_CONTEXT_NOT_CONFIRMED_CLAIM");
        self.pending.push(row);
        Ok(())
    }
    fn flush_fallback(&mut self, p: &Payload) {
        for row in std::mem::take(&mut self.pending) {
            let sid = row["source_id"].as_str().unwrap();
            let r = Range {
                start: row["start"].as_u64().unwrap() as usize,
                end: row["end"].as_u64().unwrap() as usize,
            };
            if self.retained(sid, r) {
                continue;
            }
            if !self.room(p, r, true) {
                let s = p.sources.iter().find(|s| s.id == sid).unwrap();
                self.defer(
                    s,
                    r,
                    "SHARED_CONTEXT_OR_FALLBACK_BUDGET",
                    "UNVERIFIED_CONTEXT_RETENTION",
                );
                continue;
            }
            self.keys.insert((sid.to_owned(), r.start, r.end));
            self.fallback_chars += r.len();
            self.fallback.push(row);
        }
    }
}
fn binding(
    kind: &str,
    subject: &[String],
    target: &[String],
    anchors: Vec<Value>,
    owners: Vec<Value>,
    columns: Vec<Value>,
    basis: &[&str],
) -> Value {
    json!({"kind":kind,"subject_terms":subject,"target_terms":target,"anchor_spans":anchors,"owner_spans":owners,"column_owners":columns,"basis":basis,"assurance":"BOUNDED_SOURCE_BINDING_NOT_EXTERNAL_FACT_VERIFICATION"})
}
pub fn execute(value: &Value) -> Result<Value> {
    let r: Request =
        serde_json::from_value(value.clone()).map_err(|_| Error::new("RPC_INVALID_REQUEST"))?;
    need(
        r.wire_version == "lightog-evidence-v2/0.1",
        "RPC_VERSION_UNSUPPORTED",
    )?;
    need(
        !r.request_id.is_empty() && r.request_id.len() <= 128,
        "RPC_INVALID_REQUEST",
    )?;
    need(r.operation == "select", "RPC_OPERATION_UNKNOWN")?;
    select(&r.payload)
}
pub fn select(payload: &Value) -> Result<Value> {
    let p: Payload =
        serde_json::from_value(payload.clone()).map_err(|_| Error::new("RPC_INVALID_PAYLOAD"))?;
    need(
        !p.question.trim().is_empty() && p.question.encode_utf16().count() <= 8192,
        "EVIDENCE_QUESTION_INVALID",
    )?;
    need(
        p.options.max_context_chars <= 64000
            && p.options.max_selected_chars <= 64000
            && p.options.max_fallback_chars <= 64000
            && p.options.max_fragments <= 128
            && p.options.max_fallback_fragments <= 128
            && p.options.max_anchor_distance <= 6000,
        "EVIDENCE_BUDGET_INVALID",
    )?;
    let layout = crate::fragments::plan(
        &json!({"sources":p.sources,"evidence":p.anchors,"covered":p.covered,"options":{"max_fragments":0,"max_fragment_chars":1200,"max_total_chars":0,"max_distance":p.options.max_anchor_distance}}),
    )?;
    let indexes: Vec<_> = p.sources.iter().map(|s| Index::new(&s.content)).collect();
    let source_map: HashMap<_, _> = p
        .sources
        .iter()
        .enumerate()
        .map(|(i, s)| (s.id.as_str(), i))
        .collect();
    let qtechnical = question_owners(&p.question);
    let qtargets = target_terms(&p.question);
    let mut out = Output::new();
    let mut candidate_count = 0;
    // Admission anchors remain mandatory but never count as asserted binding.
    for a in &p.anchors {
        let i = source_map[a.source_id.as_str()];
        let s = &p.sources[i];
        need(covered(&p, &s.id, ar(a)), "EVIDENCE_ANCHOR_OUTSIDE_COVERED")?;
        if out.already(&s.id, ar(a)) {
            continue;
        }
        need(
            out.room(&p, ar(a), false),
            "EVIDENCE_ANCHOR_BUDGET_EXCEEDED",
        )?;
        let mut row = serde_json::to_value(a).map_err(|_| Error::new("EVIDENCE_ANCHOR_INVALID"))?;
        row["role"] = json!("ANCHOR");
        row["status"] = json!("ADMISSION_ONLY");
        row["assurance"] = json!("SUPPLIED_ADMISSION_NOT_VERIFIED_RELEVANCE_OR_BINDING");
        out.selected.push(row);
        out.selected_chars += ar(a).len();
        out.keys.insert((s.id.clone(), a.start, a.end));
    }
    for (si, s) in p.sources.iter().enumerate() {
        let idx = &indexes[si];
        let units = argument_units(s, idx, &qtechnical)?;
        let anchors: Vec<_> = p.anchors.iter().filter(|a| a.source_id == s.id).collect();
        let mut tables = Vec::new();
        for (bi, b) in s.blocks.iter().enumerate() {
            if b.kind == "table" {
                if let Some(t) = parse_table(s, idx, bi)? {
                    tables.push(t);
                } else {
                    let linked = anchors
                        .iter()
                        .filter(|a| br(b).contains(ar(a)))
                        .map(|a| serde_json::to_value(a).unwrap())
                        .collect::<Vec<_>>();
                    if !linked.is_empty() {
                        let r = unsupported_table_structure(s, idx, b)?;
                        if covered(&p, &s.id, r) {
                            out.fallback(
                                &p,
                                s,
                                idx,
                                r,
                                "UNSUPPORTED_TABLE_SYNTAX_RAW_STRUCTURE_NOT_COLUMN_BINDING",
                                linked,
                            )?;
                        } else {
                            out.defer(
                                s,
                                r,
                                "UNSUPPORTED_TABLE_STRUCTURE_NOT_FULLY_COVERED",
                                "STRUCTURAL_CONTEXT_RETENTION",
                            );
                        }
                    }
                }
            }
        }
        let mut scopes = Vec::new();
        for (ti, t) in tables.iter().enumerate() {
            let b = &s.blocks[t.block];
            let linked: Vec<_> = anchors
                .iter()
                .copied()
                .filter(|a| br(b).contains(ar(a)))
                .collect();
            if linked.is_empty() {
                continue;
            }
            let mut owners = Vec::new();
            let mut columns = Vec::new();
            for a in &linked {
                for row in t.rows.iter().filter(|row| {
                    row.first().unwrap().range.start.saturating_sub(2) <= a.start
                        && a.end <= row.last().unwrap().range.end + 2
                }) {
                    for (col, h) in t.columns.iter().enumerate() {
                        let matching = hits(&h.text, &qtechnical);
                        if !matching.is_empty() {
                            owners.push(owner_at(
                                s,
                                idx,
                                h.range,
                                matching[0].clone(),
                                "TABLE_COLUMN_HEADER",
                            )?);
                            columns.push(json!({"table_block_id":b.block_id,"column_index":col,"header_span":span(s,idx,h.range)?,"cell_span":span(s,idx,row[col].range)?,"subject_terms":matching}));
                        }
                    }
                    if let Some(question_term) = question_literal(&p.question, &row[0].text) {
                        owners.push(owner_at(
                            s,
                            idx,
                            row[0].range,
                            question_term,
                            "TABLE_ROW_LABEL",
                        )?);
                    }
                }
            }
            let anchor_values = linked
                .iter()
                .map(|a| serde_json::to_value(a).unwrap())
                .collect::<Vec<_>>();
            let subject = owners
                .iter()
                .filter(|o| literal(&p.question, &o.term))
                .map(|o| o.term.clone())
                .collect::<Vec<_>>();
            if covered(&p, &s.id, t.header) {
                if !owners.is_empty() {
                    out.selected(
                        &p,
                        s,
                        idx,
                        t.header,
                        "TABLE_HEADER",
                        binding(
                            "TABLE_COLUMN",
                            &subject,
                            &[],
                            anchor_values.clone(),
                            owners.iter().map(|o| o.origin.clone()).collect(),
                            columns.clone(),
                            &[
                                "STRICT_MARKDOWN_HEADER_AND_CELL_OFFSETS",
                                "ROW_OR_COLUMN_OWNER_FROM_QUESTION_LITERAL",
                            ],
                        ),
                    )?;
                } else {
                    out.fallback(
                        &p,
                        s,
                        idx,
                        t.header,
                        "TABLE_OWNER_UNRESOLVED",
                        anchor_values.clone(),
                    )?;
                }
            } else {
                out.defer(
                    s,
                    t.header,
                    "TABLE_HEADER_NOT_FULLY_COVERED",
                    "STRUCTURAL_CONTEXT_RETENTION",
                );
            }
            scopes.push(TableScope {
                table: ti,
                owners,
                columns,
            });
        }
        let mut anchor_owners: Vec<(Range, Owner, usize)> = Vec::new();
        for a in &anchors {
            for u in units.iter().filter(|u| u.range.overlap(ar(a))) {
                if let Some(owner) = &u.owner {
                    if literal(&p.question, &owner.term) {
                        anchor_owners.push((ar(a), owner.clone(), u.block));
                    }
                }
            }
        }
        for scope in &scopes {
            let t = &tables[scope.table];
            for owner in &scope.owners {
                for a in &anchors {
                    if br(&s.blocks[t.block]).contains(ar(a)) {
                        anchor_owners.push((ar(a), owner.clone(), t.block));
                    }
                }
            }
        }
        // Existing source-layout associations only authorize structural context;
        // row-specific note scope still needs independent ownership evidence.
        for association in layout["associations"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|v| v["source_id"] == s.id && v["kind"] == "TABLE_GROUP_NOTE")
        {
            let (Some(start), Some(end)) =
                (association["start"].as_u64(), association["end"].as_u64())
            else {
                continue;
            };
            let r = Range {
                start: start as usize,
                end: end as usize,
            };
            if !covered(&p, &s.id, r) {
                out.defer(s, r, "NOTE_NOT_FULLY_COVERED", "TABLE_CONTEXT_RETENTION");
                continue;
            }
            let raw = idx.text(&s.content, r)?;
            let text = raw
                .trim()
                .trim_start_matches("表注")
                .trim_start_matches('注')
                .trim_start_matches(['：', ':'])
                .trim();
            let explicit = leading_actor(text);
            let refs = association["anchor_spans"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let group_ids: Vec<_> = association["table_block_ids"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            let owner_terms: Vec<_> = scopes
                .iter()
                .filter(|sc| {
                    group_ids.contains(&s.blocks[tables[sc.table].block].block_id.as_str())
                })
                .flat_map(|sc| sc.owners.iter().map(|o| o.term.clone()))
                .collect();
            if let Some(actor) = explicit {
                if !owner_terms.contains(&actor) {
                    out.exclude(s, r, "TABLE_NOTE_EXPLICIT_OTHER_OWNER");
                    continue;
                }
            }
            let global = [
                "表中",
                "本表",
                "该表",
                "全表",
                "速查卡",
                "this table",
                "the table",
                "all columns",
            ]
            .iter()
            .any(|v| raw.to_ascii_lowercase().contains(v));
            if global && !owner_terms.is_empty() {
                out.selected(
                    &p,
                    s,
                    idx,
                    r,
                    "TABLE_NOTE",
                    binding(
                        "TABLE_GROUP",
                        &owner_terms,
                        &[],
                        refs,
                        Vec::new(),
                        Vec::new(),
                        &[
                            "VERIFIED_SOURCE_TABLE_GROUP_NOTE",
                            "EXPLICIT_WHOLE_TABLE_REFERENCE_NOT_ROW_FACT",
                        ],
                    ),
                )?;
            } else {
                out.fallback(&p, s, idx, r, "TABLE_NOTE_ROW_SCOPE_NOT_CONFIRMED", refs)?;
            }
        }
        // A caption-prefixed table is parsed locally even when the older layout
        // kernel has no group for it. A direct note is retained with its original
        // table association; a row-specific statement never becomes global.
        let note_prefix =
            Regex::new(r"(?i)^(?:注|表注|note|notes)\s*[:：.]").expect("constant regex");
        for scope in &scopes {
            let t = &tables[scope.table];
            let b = &s.blocks[t.block];
            let Some(next) = s.blocks.get(t.block + 1) else {
                continue;
            };
            if !matches!(next.kind.as_str(), "text" | "paragraph") {
                continue;
            }
            let r = br(next);
            let raw = idx.text(&s.content, r)?;
            if !note_prefix.is_match(raw.trim()) || !same_section(s, idx, br(b), r) {
                continue;
            }
            if b.end < next.start
                && !idx
                    .text(
                        &s.content,
                        Range {
                            start: b.end,
                            end: next.start,
                        },
                    )?
                    .trim()
                    .is_empty()
            {
                continue;
            }
            if !covered(&p, &s.id, r) {
                out.defer(s, r, "NOTE_NOT_FULLY_COVERED", "TABLE_CONTEXT_RETENTION");
                continue;
            }
            if out.already(&s.id, r) {
                continue;
            }
            let refs = anchors
                .iter()
                .filter(|a| br(b).contains(ar(a)))
                .map(|a| serde_json::to_value(a).unwrap())
                .collect::<Vec<_>>();
            let body = note_prefix.replace(raw.trim(), "");
            if let Some(actor) = leading_actor(&body) {
                if !scope.owners.iter().any(|o| o.term == actor) {
                    out.exclude(s, r, "DIRECT_TABLE_NOTE_EXPLICIT_OTHER_OWNER");
                    continue;
                }
            }
            let global = [
                "表中",
                "本表",
                "该表",
                "全表",
                "this table",
                "the table",
                "all columns",
            ]
            .iter()
            .any(|v| raw.to_ascii_lowercase().contains(v));
            if global && !scope.owners.is_empty() {
                let terms = scope
                    .owners
                    .iter()
                    .map(|o| o.term.clone())
                    .collect::<Vec<_>>();
                out.selected(
                    &p,
                    s,
                    idx,
                    r,
                    "TABLE_NOTE",
                    binding(
                        "TABLE_GROUP",
                        &terms,
                        &[],
                        refs,
                        scope.owners.iter().map(|o| o.origin.clone()).collect(),
                        scope.columns.clone(),
                        &[
                            "DIRECT_SINGLE_TABLE_TAIL_NOTE",
                            "EXPLICIT_WHOLE_TABLE_REFERENCE_NOT_ROW_FACT",
                        ],
                    ),
                )?;
            } else {
                out.fallback(&p, s, idx, r, "DIRECT_TABLE_NOTE_SCOPE_UNVERIFIED", refs)?;
            }
        }
        // Anchor argument units are processed before distant context; fallback is
        // deterministic source-order and shares the exact same total budget.
        let mut ordered: Vec<_> = units.iter().collect();
        ordered.sort_by_key(|u| {
            (
                !anchors
                    .iter()
                    .any(|a| br(&s.blocks[u.block]).contains(ar(a))),
                u.range.start,
            )
        });
        for u in ordered {
            let r = u.range;
            if anchors.iter().any(|a| ar(a).contains(r)) {
                continue;
            }
            let near: Vec<_> = anchors
                .iter()
                .copied()
                .filter(|a| ar(a).distance(r) <= p.options.max_anchor_distance)
                .collect();
            if near.is_empty() {
                continue;
            }
            if !p.covered.iter().any(|c| {
                c.source_id == s.id
                    && (Range {
                        start: c.start,
                        end: c.end,
                    })
                    .overlap(r)
            }) {
                continue;
            }
            candidate_count += 1;
            need(candidate_count <= 4096, "EVIDENCE_RESOURCE_LIMIT")?;
            let raw = idx.text(&s.content, r)?;
            let outside = outside_quotes(raw);
            let targets = hits(&outside, &qtargets)
                .into_iter()
                .filter(|t| !qtechnical.contains(t))
                .collect::<Vec<_>>();
            let local = near.iter().any(|a| br(&s.blocks[u.block]).contains(ar(a)));
            let neighbor = near.iter().any(|a| {
                s.blocks.iter().enumerate().any(|(bi, b)| {
                    if !br(b).contains(ar(a)) || bi.abs_diff(u.block) > 2 {
                        return false;
                    }
                    if bi == u.block {
                        return true;
                    }
                    let lo = bi.min(u.block);
                    let hi = bi.max(u.block);
                    s.blocks[lo + 1..hi]
                        .iter()
                        .all(|b| b.kind == "section_header")
                })
            });
            let owner_or_topic = !hits(&outside, &qtechnical).is_empty()
                || u.owner
                    .as_ref()
                    .is_some_and(|o| literal(&p.question, &o.term));
            // Uncertainty retention is an admitted local context obligation, not
            // a promise to copy every sentence within the distance radius.
            if !local
                && !(neighbor && !targets.is_empty())
                && !(owner_or_topic && !targets.is_empty())
            {
                out.exclude(s, r, "NO_LOCAL_ARGUMENT_TABLE_OR_LITERAL_TOPIC_ADMISSION");
                continue;
            }
            let contexts = near
                .iter()
                .map(|a| serde_json::to_value(a).unwrap())
                .collect::<Vec<_>>();
            if !covered(&p, &s.id, r) {
                let relevant_owner = u
                    .owner
                    .as_ref()
                    .is_some_and(|o| literal(&p.question, &o.term));
                if local || (relevant_owner && !targets.is_empty()) {
                    out.defer(
                        s,
                        r,
                        "ATOMIC_SENTENCE_NOT_FULLY_COVERED",
                        "UNVERIFIED_CONTEXT_RETENTION",
                    );
                } else {
                    out.exclude(
                        s,
                        r,
                        "PARTIAL_WINDOW_EDGE_NOT_ADMITTED_AS_NECESSARY_CONTEXT",
                    );
                }
                continue;
            }
            let same_section_anchors: Vec<_> = near
                .iter()
                .copied()
                .filter(|a| same_section(s, idx, ar(a), r))
                .collect();
            if same_section_anchors.is_empty() {
                out.fallback(
                    &p,
                    s,
                    idx,
                    r,
                    "SECTION_BOUNDARY_NO_PROVEN_DISCOURSE_LINK",
                    contexts,
                )?;
                continue;
            }
            if u.ambiguous {
                out.fallback(
                    &p,
                    s,
                    idx,
                    r,
                    "MULTIPLE_SENTENCE_ACTORS_OR_SCOPE_AMBIGUITY",
                    contexts,
                )?;
                continue;
            }
            let requested = qualifier_markers(&p.question);
            if !requested.is_empty()
                && qualifier_markers(raw)
                    .iter()
                    .any(|m| !requested.contains(m))
            {
                out.fallback(
                    &p,
                    s,
                    idx,
                    r,
                    "VERSION_OR_TIME_QUALIFIER_CONFLICT_NO_IDENTITY_MERGE",
                    contexts,
                )?;
                continue;
            }
            let Some(owner) = &u.owner else {
                out.fallback(
                    &p,
                    s,
                    idx,
                    r,
                    "ELLIPTICAL_OR_UNRESOLVED_ARGUMENT_OWNER",
                    contexts,
                )?;
                continue;
            };
            if !literal(&p.question, &owner.term) {
                if !targets.is_empty() || local {
                    out.fallback(
                        &p,
                        s,
                        idx,
                        r,
                        "OTHER_OWNER_MAY_BE_RELATIONAL_ANSWER_NOT_CONFIRMED_IDENTITY",
                        contexts,
                    )?;
                } else {
                    out.exclude(s, r, "OTHER_OWNER_WITHOUT_LITERAL_QUESTION_TARGET");
                }
                continue;
            }
            let linked: Vec<_> = anchor_owners
                .iter()
                .filter(|(a, o, _)| {
                    o.term == owner.term
                        && same_section(s, idx, *a, r)
                        && a.distance(r) <= p.options.max_anchor_distance
                })
                .collect();
            if linked.is_empty() {
                out.fallback(
                    &p,
                    s,
                    idx,
                    r,
                    "QUESTION_OWNER_NOT_LINKED_TO_ADMISSION_ARGUMENT_OR_COLUMN",
                    contexts,
                )?;
                continue;
            }
            if targets.is_empty() {
                out.fallback(
                    &p,
                    s,
                    idx,
                    r,
                    "TARGET_LITERAL_UNRESOLVED_PRESERVE_IMPLEMENTATION_CONTEXT",
                    contexts,
                )?;
                continue;
            }
            if u.quoted && !u.explicit {
                out.fallback(
                    &p,
                    s,
                    idx,
                    r,
                    "QUOTED_CONTENT_CANNOT_ESTABLISH_INHERITED_SCOPE",
                    contexts,
                )?;
                continue;
            }
            // Inherited owner must remain in the very same original argument block.
            if !u.explicit && !linked.iter().any(|(_, _, bi)| *bi == u.block) {
                out.fallback(
                    &p,
                    s,
                    idx,
                    r,
                    "CROSS_BLOCK_ELLIPSIS_NOT_CONFIRMED",
                    contexts,
                )?;
                continue;
            }
            let linked_anchors = p
                .anchors
                .iter()
                .filter(|a| {
                    a.source_id == s.id
                        && linked
                            .iter()
                            .any(|(r, _, _)| r.start == a.start && r.end == a.end)
                })
                .map(|a| serde_json::to_value(a).unwrap())
                .collect();
            let table_columns = scopes
                .iter()
                .filter(|sc| sc.owners.iter().any(|o| o.term == owner.term))
                .flat_map(|sc| sc.columns.clone())
                .collect();
            out.selected(
                &p,
                s,
                idx,
                r,
                if qualifier(raw) {
                    "QUALIFIER"
                } else {
                    "DIRECT_SUPPORT"
                },
                binding(
                    if u.explicit {
                        "EXPLICIT_OWNER"
                    } else {
                        "ARGUMENT_UNIT"
                    },
                    &[owner.term.clone()],
                    &targets,
                    linked_anchors,
                    vec![owner.origin.clone()],
                    table_columns,
                    &[
                        "EXPLICIT_OWNER_RUN_OR_GRAMMATICAL_CONTINUATION",
                        "SOURCE_ARGUMENT_UNIT_OR_COLUMN_ANCHOR_LINK",
                        "NON_GENERIC_LITERAL_TARGET",
                        "ATOMIC_SENTENCE_NO_NEGATION_OR_SEMICOLON_TRUNCATION",
                    ],
                ),
            )?;
        }
    }
    out.flush_fallback(&p);
    let abstain = !out.deferred.is_empty();
    let mut reasons: Vec<_> = out
        .deferred
        .iter()
        .filter_map(|v| v["reason"].as_str())
        .map(str::to_owned)
        .collect();
    reasons.sort();
    reasons.dedup();
    Ok(
        json!({"policy_version":VERSION,"question_sha256":wire::text_sha(&p.question),"selected":out.selected,"fallback":out.fallback,"deferred":out.deferred,"abstain":{"required":abstain,"reason_codes":reasons},"excluded":{"records":out.excluded,"omitted_count":out.excluded_omitted},"trace":{"scope":"BASELINE_CONDITIONED_COVERED_ONLY_SOURCE_BINDING_WITH_UNVERIFIED_CONTEXT","admission":"SUPPLIED_ANCHORS_NOT_AUTOMATIC_INITIAL_RETRIEVAL","source_stamp":layout["source_stamp"],"layout_policy_version":layout["policy_version"],"recursive_expansion":false,"candidate_sentence_count":candidate_count,"fallback_is_not_confirmed_claim":true,"unknown_subsection_relation":"FALLBACK_NOT_ASSERTED","owner_extraction":"LITERAL_TECHNICAL_ACTOR_OR_TABLE_CELL_WITH_GRAMMATICAL_CONTINUATION"},"budget":{"max_context_chars":p.options.max_context_chars,"max_selected_chars":p.options.max_selected_chars,"max_fragments":p.options.max_fragments,"max_fallback_chars":p.options.max_fallback_chars,"max_fallback_fragments":p.options.max_fallback_fragments,"max_anchor_distance":p.options.max_anchor_distance,"selected_characters":out.selected_chars,"fallback_characters":out.fallback_chars,"total_context_characters":out.selected_chars+out.fallback_chars,"total_context_fragments":out.selected.len()+out.fallback.len(),"accounting":"SUM_EMITTED_UTF16_LENGTHS_OVERLAPS_COUNTED","anchor_overflow_policy":"ERROR_WITHOUT_PARTIAL_RESULT","deferred_sent_to_context":false}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(q: &str, parts: &[(&str, &str)], quote: &str) -> Value {
        let mut content = String::new();
        let mut blocks = Vec::new();
        for (i, (kind, text)) in parts.iter().enumerate() {
            if i > 0 {
                content.push_str("\n\n");
            }
            let start = content.encode_utf16().count();
            content.push_str(text);
            let end = content.encode_utf16().count();
            blocks.push(json!({"block_id":format!("b{i}"),"kind":kind,"start":start,"end":end,"page_numbers":[i+1]}));
        }
        let byte = content.find(quote).unwrap();
        let start = content[..byte].encode_utf16().count();
        let end = start + quote.encode_utf16().count();
        let sha = wire::text_sha(&content);
        let length = content.encode_utf16().count();
        json!({"question":q,"sources":[{"id":"s","content":content,"sha256":sha,"blocks":blocks}],"anchors":[{"source_id":"s","source_sha256":sha,"start":start,"end":end,"quote":quote}],"covered":[{"source_id":"s","start":0,"end":length}]})
    }
    fn asserted(r: &Value) -> String {
        r["selected"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["status"] != "ADMISSION_ONLY")
            .map(|r| r["quote"].as_str().unwrap())
            .collect::<Vec<_>>()
            .join("\n")
    }
    fn actual(r: &Value) -> String {
        r["selected"]
            .as_array()
            .unwrap()
            .iter()
            .chain(r["fallback"].as_array().unwrap())
            .map(|r| r["quote"].as_str().unwrap())
            .collect::<Vec<_>>()
            .join("\n")
    }
    fn assert_fallback_contract(r: &Value) {
        for row in r["fallback"].as_array().unwrap() {
            assert!(row.get("binding").is_none());
            assert!(row.get("role").is_none());
            assert!(row.get("subject_terms").is_none());
            assert!(row.get("target_terms").is_none());
            assert_eq!(row["status"], "UNCERTAIN_CONTEXT");
        }
        assert!(
            r["budget"]["total_context_characters"].as_u64().unwrap()
                <= r["budget"]["max_context_chars"].as_u64().unwrap()
        );
    }
    #[test]
    fn anchors_are_admission_only_not_asserted() {
        let p = fixture(
            "Alpha覆盖率？",
            &[("text", "Alpha覆盖率为90%。")],
            "Alpha覆盖率为90%。",
        );
        let r = select(&p).unwrap();
        assert_eq!(r["selected"][0]["status"], "ADMISSION_ONLY");
        assert!(r["selected"][0].get("binding").is_none());
        assert!(asserted(&r).is_empty());
    }
    #[test]
    fn unique_owner_grammatical_ellipsis_and_negative_scope() {
        let p = fixture(
            "Alpha覆盖率是多少？",
            &[(
                "text",
                "Alpha覆盖率为90%。其覆盖率仅限测试，生产环境不适用。",
            )],
            "Alpha覆盖率为90%。",
        );
        let r = select(&p).unwrap();
        assert!(asserted(&r).contains("生产环境不适用"));
        assert_eq!(
            r["selected"][1]["binding"]["subject_terms"],
            json!(["Alpha"])
        );
    }
    #[test]
    fn competitor_breaks_owner_chain() {
        let p = fixture(
            "Alpha覆盖率是多少？",
            &[(
                "text",
                "Alpha覆盖率为90%。Beta覆盖率为30%。其覆盖率仅限测试。",
            )],
            "Alpha覆盖率为90%。",
        );
        let r = select(&p).unwrap();
        assert!(!asserted(&r).contains("Beta"));
        assert!(!asserted(&r).contains("仅限测试"));
        assert_fallback_contract(&r);
    }
    #[test]
    fn unparsed_chinese_subject_and_unknown_intervening_sentence_are_not_inherited() {
        let p = fixture(
            "甲云覆盖率是多少？",
            &[("text", "甲云覆盖率为90%。乙云覆盖率为30%。")],
            "甲云覆盖率为90%。",
        );
        let r = select(&p).unwrap();
        assert!(!asserted(&r).contains("乙云"));
        assert!(actual(&r).contains("乙云"));
        let p = fixture(
            "Alpha覆盖率？",
            &[(
                "text",
                "Alpha覆盖率为90%。乙云覆盖率为30%。其覆盖率不适用生产。",
            )],
            "Alpha覆盖率为90%。",
        );
        assert!(!asserted(&select(&p).unwrap()).contains("生产"));
    }
    #[test]
    fn preceding_owner_can_bind_later_admission_in_same_argument_run() {
        let p = fixture(
            "Alpha跨库标识如何保持唯一？",
            &[(
                "text",
                "Alpha跨库标识不能沿用内部编号。其跨库标识需要独立主键。",
            )],
            "其跨库标识需要独立主键。",
        );
        let r = select(&p).unwrap();
        assert!(asserted(&r).contains("不能沿用内部编号"));
    }
    #[test]
    fn non_grammatical_ellipsis_is_retained_as_fallback() {
        let p = fixture(
            "Alpha旧索引何时删除？",
            &[(
                "list_item",
                "Alpha迁移旧索引需要审批。保留旧索引两个周期后再删除。",
            )],
            "Alpha迁移旧索引需要审批。",
        );
        let r = select(&p).unwrap();
        assert!(actual(&r).contains("两个周期"));
        assert!(!asserted(&r).contains("两个周期"));
        assert_fallback_contract(&r);
    }
    #[test]
    fn unknown_subsection_falls_back_code_pseudo_heading_does_not_define_scope() {
        let p = fixture(
            "Alpha覆盖率？",
            &[
                ("text", "Alpha覆盖率有定义。"),
                ("section_header", "另一个子节"),
                ("text", "Alpha覆盖率仅统计新对象。"),
            ],
            "Alpha覆盖率有定义。",
        );
        let r = select(&p).unwrap();
        assert!(!asserted(&r).contains("新对象"));
        assert!(actual(&r).contains("新对象"));
        let p = fixture(
            "Alpha覆盖率？",
            &[
                ("text", "Alpha覆盖率有定义。"),
                ("section_header", "rdfs:subClassOf ["),
                ("text", "Alpha覆盖率仅统计新对象。"),
            ],
            "Alpha覆盖率有定义。",
        );
        assert!(asserted(&select(&p).unwrap()).contains("新对象"));
    }
    #[test]
    fn quoted_negative_scope_does_not_become_narrative_binding() {
        let p = fixture(
            "Alpha覆盖率？",
            &[(
                "text",
                "Alpha覆盖率有定义。其日志引用“覆盖率仅限测试”，该引用并非当前规则。",
            )],
            "Alpha覆盖率有定义。",
        );
        let r = select(&p).unwrap();
        assert!(!asserted(&r).contains("仅限测试"));
        assert!(actual(&r).contains("该引用并非当前规则"));
    }
    #[test]
    fn english_decimal_abbreviations_and_pronoun_ownership() {
        let text="Alpha has coverage of 1.5 percent in U.S.A. settings, e.g. tests. It has coverage only in tests, not production.";
        let ranges = sentences(text, 0);
        assert_eq!(ranges.len(), 2);
        let p = fixture(
            "What is Alpha coverage?",
            &[("text", text)],
            "Alpha has coverage of 1.5 percent in U.S.A. settings, e.g. tests.",
        );
        let r = select(&p).unwrap();
        assert!(asserted(&r).contains("not production"));
    }
    #[test]
    fn english_new_actor_after_connective_does_not_inherit() {
        let p=fixture("What is Alpha coverage?",&[("text","Alpha has coverage of 90 percent. However, Beta has coverage of 30 percent. Its coverage excludes production.")],"Alpha has coverage of 90 percent.");
        assert!(!asserted(&select(&p).unwrap()).contains("30 percent"));
    }
    #[test]
    fn version_conflict_is_retained_without_confirmed_identity() {
        let p = fixture(
            "Alpha v2覆盖率是多少？",
            &[
                ("text", "Alpha v2覆盖率有定义。"),
                ("text", "Alpha v3覆盖率为90%。"),
            ],
            "Alpha v2覆盖率有定义。",
        );
        let r = select(&p).unwrap();
        assert!(!asserted(&r).contains("v3"));
        assert!(actual(&r).contains("v3"));
    }
    #[test]
    fn caption_before_header_column_owner_has_exact_original_cells() {
        let table="Table 7. Coverage by system\n| 指标 | Alpha | Beta |\n| --- | --- | --- |\n| 覆盖率 | 90% | 60% |";
        let p = fixture(
            "Alpha覆盖率是多少？",
            &[("table", table), ("text", "Alpha覆盖率仅统计活跃对象。")],
            "| 覆盖率 | 90% | 60% |",
        );
        let r = select(&p).unwrap();
        let row = r["selected"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["role"] == "TABLE_HEADER")
            .unwrap();
        let owner = &row["binding"]["column_owners"][0];
        assert_eq!(owner["column_index"], 1);
        assert_eq!(owner["header_span"]["quote"], "Alpha");
        assert_eq!(owner["cell_span"]["quote"], "90%");
        assert!(asserted(&r).contains("仅统计活跃对象"));
    }
    #[test]
    fn same_header_another_section_is_not_one_table_identity() {
        let a = "| 级别 | 特征 |\n| --- | --- |\n| L2 | Alpha闭环 |";
        let b = "| 级别 | 特征 |\n| --- | --- |\n| L2 | Beta推理 |";
        let p = fixture(
            "Alpha L2特征？",
            &[("table", a), ("section_header", "不同模型"), ("table", b)],
            "| L2 | Alpha闭环 |",
        );
        assert!(!actual(&select(&p).unwrap()).contains("Beta推理"));
    }
    #[test]
    fn note_scope_does_not_broadcast_other_row_and_english_global_note_is_traceable() {
        let table = "| 方案 | 覆盖率 |\n| --- | --- |\n| Alpha | 90% |\n| Beta | 60% |";
        let p = fixture(
            "Alpha覆盖率？",
            &[("table", table), ("text", "注：Beta覆盖率仅限测试。")],
            "| Alpha | 90% |",
        );
        assert!(!asserted(&select(&p).unwrap()).contains("Beta覆盖率"));
        let table = "Table 2. Comparison\n| Scheme | Coverage |\n| --- | --- |\n| Alpha | 90% |";
        let note = "Note: This table reports coverage of all schemes.";
        let p = fixture(
            "What is Alpha coverage?",
            &[("table", table), ("text", note)],
            "| Alpha | 90% |",
        );
        let r = select(&p).unwrap();
        assert!(actual(&r).contains(note));
    }
    #[test]
    fn shared_budget_deferred_abstain_and_anchor_strict_overflow() {
        let p = fixture(
            "Alpha覆盖率？",
            &[(
                "text",
                "Alpha覆盖率有定义。省略主体的覆盖率条件需要额外复核。",
            )],
            "Alpha覆盖率有定义。",
        );
        let mut tight = p.clone();
        let anchor = p["anchors"][0]["quote"]
            .as_str()
            .unwrap()
            .encode_utf16()
            .count();
        tight["options"] = json!({"max_context_chars":anchor+2});
        let r = select(&tight).unwrap();
        assert_eq!(r["abstain"]["required"], true);
        assert!(!r["deferred"].as_array().unwrap().is_empty());
        assert_fallback_contract(&r);
        tight["options"]["max_context_chars"] = json!(anchor - 1);
        assert_eq!(
            select(&tight).unwrap_err().code,
            "EVIDENCE_ANCHOR_BUDGET_EXCEEDED"
        );
    }
    #[test]
    fn unknown_unrelated_partial_window_edge_does_not_force_abstain() {
        let mut p = fixture(
            "Alpha覆盖率？",
            &[
                ("text", "Alpha覆盖率有定义。"),
                ("text", "无关段落涉及其他事项但尚未完成。"),
            ],
            "Alpha覆盖率有定义。",
        );
        let start = p["sources"][0]["blocks"][1]["start"].as_u64().unwrap();
        p["covered"][0]["end"] = json!(start + 4);
        let r = select(&p).unwrap();
        assert_eq!(r["abstain"]["required"], false);
    }
    #[test]
    fn other_owner_same_target_is_possible_relation_answer_fallback() {
        let p = fixture(
            "Alpha权限由谁负责？",
            &[
                ("text", "Alpha权限需要校验。"),
                ("text", "Beta权限校验服务负责拒绝未经许可的请求。"),
            ],
            "Alpha权限需要校验。",
        );
        let r = select(&p).unwrap();
        assert!(!asserted(&r).contains("Beta"));
        assert!(actual(&r).contains("Beta"));
        assert_fallback_contract(&r);
    }
    #[test]
    fn utf16_hash_quote_covered_and_v2_wire_boundary() {
        let p = fixture(
            "Alpha覆盖率？",
            &[("text", "😀Alpha覆盖率有定义。")],
            "😀Alpha覆盖率有定义。",
        );
        assert!(select(&p).is_ok());
        let mut invalid = p.clone();
        invalid["anchors"][0]["start"] = json!(1);
        assert!(select(&invalid).is_err());
        let mut invalid = p.clone();
        invalid["anchors"][0]["quote"] = json!("wrong");
        assert!(select(&invalid).is_err());
        let mut invalid = p.clone();
        invalid["sources"][0]["sha256"] = json!("wrong");
        assert!(select(&invalid).is_err());
        let mut invalid = p.clone();
        invalid["covered"] = json!([]);
        assert_eq!(
            select(&invalid).unwrap_err().code,
            "EVIDENCE_ANCHOR_OUTSIDE_COVERED"
        );
        assert_eq!(execute(&json!({"wire_version":"lightog-evidence/0.1","request_id":"t","operation":"select","payload":p})).unwrap_err().code,"RPC_VERSION_UNSUPPORTED");
    }
    #[test]
    fn unsupported_empty_cell_or_escaped_pipe_retains_raw_structure_without_binding() {
        for table in [
            "| Scheme | Coverage |\n| --- | --- |\n| Alpha | |",
            "| Scheme\\|Alias | Coverage |\n| --- | --- |\n| Alpha | 90% |",
        ] {
            let anchor = table.lines().last().unwrap();
            let p = fixture("What is Alpha coverage?", &[("table", table)], anchor);
            let r = select(&p).unwrap();
            assert!(r["selected"]
                .as_array()
                .unwrap()
                .iter()
                .all(|v| v["status"] == "ADMISSION_ONLY"));
            assert!(actual(&r).contains(table.lines().next().unwrap()));
            assert!(r["fallback"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v["reasons"][0]
                    == "UNSUPPORTED_TABLE_SYNTAX_RAW_STRUCTURE_NOT_COLUMN_BINDING"));
            assert_fallback_contract(&r);
        }
    }
    #[test]
    fn local_unknown_english_scope_is_retained_or_explicitly_deferred() {
        let mut p = fixture(
            "What limits apply to Alpha?",
            &[("text", "Alpha. Only in testing.")],
            "Alpha.",
        );
        let full = select(&p).unwrap();
        assert!(actual(&full).contains("Only in testing."));
        assert!(!asserted(&full).contains("Only in testing."));
        p["options"] = json!({"max_context_chars":16});
        let r = select(&p).unwrap();
        assert_eq!(r["abstain"]["required"], true);
        assert!(!r["deferred"].as_array().unwrap().is_empty());
        assert_fallback_contract(&r);
    }
    #[test]
    fn cjk_layout_whitespace_owner_records_question_literal_and_source_cell() {
        let table = "| 策略 | 优点 |\n| --- | --- |\n| 混合 策略 | 时效一致 |";
        let p = fixture(
            "混合策略的优点是什么？",
            &[("table", table)],
            "| 混合 策略 | 时效一致 |",
        );
        let r = select(&p).unwrap();
        let header = r["selected"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["role"] == "TABLE_HEADER")
            .unwrap();
        assert_eq!(header["binding"]["subject_terms"], json!(["混合策略"]));
        assert_eq!(header["binding"]["owner_spans"][0]["quote"], "混合 策略");
    }
}
