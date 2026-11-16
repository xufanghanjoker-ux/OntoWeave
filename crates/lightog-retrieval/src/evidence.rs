//! Covered-only evidence filtering. Admission anchors are supplied, never discovered here.
//! Bindings describe a bounded lexical/layout policy, not a semantic or factual proof.
use lightog_demand::{need, wire, Error, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub const VERSION: &str = "evidence-scope/0.1";
const AUDIT_LIMIT: usize = 256;
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
#[serde(deny_unknown_fields)]
struct Options {
    max_selected_chars: usize,
    max_fragments: usize,
    max_anchor_distance: usize,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            max_selected_chars: 16000,
            max_fragments: 128,
            max_anchor_distance: 6000,
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
    fn distance(self, r: Self) -> usize {
        self.start
            .saturating_sub(r.end)
            .max(r.start.saturating_sub(self.end))
    }
    fn len(self) -> usize {
        self.end - self.start
    }
}
fn ar(s: &Span) -> Range {
    Range {
        start: s.start,
        end: s.end,
    }
}
fn br(b: &Block) -> Range {
    Range {
        start: b.start,
        end: b.end,
    }
}
struct Index {
    bytes: Vec<Option<usize>>,
}
impl Index {
    fn new(s: &str) -> Self {
        let mut bytes = Vec::new();
        for (i, c) in s.char_indices() {
            bytes.push(Some(i));
            if c.len_utf16() == 2 {
                bytes.push(None);
            }
        }
        bytes.push(Some(s.len()));
        Self { bytes }
    }
    fn text<'a>(&self, s: &'a str, r: Range) -> Result<&'a str> {
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
        s.get(a..b)
            .ok_or_else(|| Error::new("EVIDENCE_OFFSET_INVALID"))
    }
}
fn covered(p: &Payload, sid: &str, r: Range) -> bool {
    let mut ranges: Vec<_> = p.covered.iter().filter(|c| c.source_id == sid).collect();
    ranges.sort_by_key(|c| c.start);
    let mut cursor = r.start;
    for c in ranges {
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
fn same_section(s: &Source, a: Range, b: Range) -> bool {
    let start = a.start.min(b.start);
    let end = (a.end - 1).max(b.end - 1);
    !s.blocks
        .iter()
        .any(|h| h.kind == "section_header" && h.start > start && h.start <= end)
}
// Keep punctuation, negations, conditions, and semicolon continuations together.
// Commas/semicolons cannot safely be cut without a discourse parser.
fn sentences(text: &str, base: usize) -> Vec<Range> {
    let mut out = Vec::new();
    let mut begin = 0;
    let mut position = 0;
    for c in text.chars() {
        position += c.len_utf16();
        if "。！？!?\n".contains(c) {
            if position > begin {
                out.push(Range {
                    start: base + begin,
                    end: base + position,
                });
            }
            begin = position;
        }
    }
    if position > begin {
        out.push(Range {
            start: base + begin,
            end: base + position,
        });
    }
    // Semicolons often separate independent subjects. Split only complete clauses,
    // retaining adversative/conditional continuations with the clause they qualify.
    let mut clauses = Vec::new();
    let index = Index::new(text);
    for whole in out {
        let local = Range {
            start: whole.start - base,
            end: whole.end - base,
        };
        let Ok(raw) = index.text(text, local) else {
            continue;
        };
        let mut begin = whole.start;
        let mut position = whole.start;
        let chars: Vec<_> = raw.chars().collect();
        for (i, c) in chars.iter().enumerate() {
            position += c.len_utf16();
            if !"；;".contains(*c) {
                continue;
            }
            let after: String = chars[i + 1..].iter().collect();
            let after = after.trim();
            let current = index
                .text(
                    text,
                    Range {
                        start: begin - base,
                        end: position - base,
                    },
                )
                .unwrap_or("")
                .trim();
            let continuation = ["但", "若", "如果", "仅", "而", "且", "除", "不", "并"]
                .iter()
                .any(|v| after.starts_with(v));
            // A later negative/scope clause can qualify the positive before it even
            // without a connective at its beginning. Only a new explicit technical
            // actor permits an independent clause boundary in that situation.
            let new_actor = after
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic());
            let scope_tail = qualifier(after) && !new_actor;
            let conditional = ["若", "如果", "当", "只有", "除"]
                .iter()
                .any(|v| current.starts_with(v));
            if !continuation && !conditional && !scope_tail {
                clauses.push(Range {
                    start: begin,
                    end: position,
                });
                begin = position;
            }
        }
        if whole.end > begin {
            clauses.push(Range {
                start: begin,
                end: whole.end,
            });
        }
    }
    clauses
}
fn compact(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}
fn subjects(q: &str) -> Vec<String> {
    let re = Regex::new(r"[A-Za-z][A-Za-z0-9_./-]*").expect("constant ASCII regex");
    let mut seen = HashSet::new();
    re.find_iter(q)
        .map(|m| m.as_str().to_owned())
        .filter(|s| seen.insert(s.clone()))
        .collect()
}
fn targets(q: &str) -> Vec<String> {
    // Remove complete interrogative operators before forming adjacent bigrams;
    // otherwise e.g. “率是” becomes an accidental apparent target.
    let mut cleaned = q.to_owned();
    for phrase in [
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
        cleaned = cleaned.replace(phrase, " ");
    }
    let stop: HashSet<&str> = [
        "什么",
        "为何",
        "为什",
        "么会",
        "怎么",
        "如何",
        "是否",
        "能否",
        "多少",
        "哪些",
        "资料",
        "中的",
        "中有",
        "这个",
        "这些",
        "那个",
        "那些",
        "对于",
        "关于",
        "分别",
        "要求",
        "需要",
        "应该",
        "能够",
        "可以",
        "不能",
        "直接",
        "条件",
        "限定",
        "约束",
        "规定",
        "解释",
        "含义",
        "对照",
        "表中",
        "列出",
        "根据",
        "上述",
        "以及",
        "有什么",
        "的是",
        "关系",
        "主体",
        "对象",
        "业务",
        "数据",
        "系统",
        "场景",
        "能力",
        "操作",
        "执行",
        "标准",
        "建议",
        "有何",
        "为其",
        "的是",
        "什么",
        "必须",
        "还是",
        "这里",
        "它们",
        "而言",
        "一个",
        "的是",
        "是否",
        "问题",
    ]
    .into_iter()
    .collect();
    let re = Regex::new(r"[\p{Script=Han}]+").expect("constant Han regex");
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for m in re.find_iter(&cleaned) {
        let chars: Vec<_> = m.as_str().chars().collect();
        for w in chars.windows(2) {
            let v: String = w.iter().collect();
            if !stop.contains(v.as_str()) && seen.insert(v.clone()) {
                out.push(v);
            }
        }
    }
    out
}
fn sufficient_target_link(terms: &[String], hits: &[String]) -> bool {
    // One generic shared tail (e.g. 备份策略 vs 缓存策略 sharing only 策略)
    // cannot establish the target. A two-character-only target may have one
    // bigram; longer requests require at least two distinct literal bigrams.
    !hits.is_empty() && (terms.len() == 1 || hits.len() >= 2)
}
fn table_actor_terms(s: &Source, idx: &Index, ids: &[String]) -> Result<Vec<String>> {
    let mut actors = Vec::new();
    for b in s.blocks.iter().filter(|b| ids.contains(&b.block_id)) {
        let text = idx.text(&s.content, br(b))?;
        actors.extend(subjects(text.lines().next().unwrap_or("")));
        for line in text.lines().skip(2) {
            if let Some(first) = line.trim().trim_start_matches('|').split('|').next() {
                actors.extend(subjects(first));
                let label = compact(first);
                if label.chars().any(|c| !c.is_ascii()) && (2..=64).contains(&label.chars().count())
                {
                    actors.push(label);
                }
            }
        }
    }
    actors.sort();
    actors.dedup();
    Ok(actors)
}
fn foreign_table_actor(text: &str, actors: &[String], question: &str) -> bool {
    actors.iter().any(|a| {
        literal_hits(question, &[a.clone()]).is_empty()
            && !literal_hits(text, &[a.clone()]).is_empty()
    })
}
fn literal_hits(text: &str, terms: &[String]) -> Vec<String> {
    // ASCII tokens use token equality: ABC must not bind ABC2 or XABC.
    let tokens = subjects(text);
    let squashed = compact(text);
    terms
        .iter()
        .filter(|term| {
            if term.is_ascii() {
                tokens.contains(term)
            } else {
                squashed.contains(term.as_str())
            }
        })
        .cloned()
        .collect()
}
fn qualifier(text: &str) -> bool {
    [
        "但",
        "若",
        "如果",
        "只有",
        "仅",
        "除",
        "前提",
        "不构成",
        "必须",
        "不得",
        "不能",
        "未",
        "不代表",
        "不",
        "对于",
    ]
    .iter()
    .any(|c| text.contains(c))
}
// An initial technical token is a potential actor, not automatically a question subject.
// A different initial actor blocks inheritance even if the paragraph contains an anchor.
fn foreign_initial_actor(text: &str, qsubjects: &[String]) -> bool {
    let text = text
        .trim()
        .trim_start_matches(|c| "但而且与及，,:：-—（(\"' ".contains(c));
    let first = subjects(text).into_iter().next();
    text.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && first.is_some_and(|v| !qsubjects.contains(&v))
}
struct Audit {
    rows: Vec<Value>,
    omitted: usize,
}
impl Audit {
    fn new() -> Self {
        Self {
            rows: Vec::new(),
            omitted: 0,
        }
    }
    fn push(&mut self, sid: &str, r: Range, reason: &str) {
        if self.rows.len() < AUDIT_LIMIT {
            self.rows
                .push(json!({"source_id":sid,"start":r.start,"end":r.end,"reason":reason}));
        } else {
            self.omitted += 1;
        }
    }
}
struct Selection {
    rows: Vec<Value>,
    keys: HashSet<(String, usize, usize)>,
    chars: usize,
}
impl Selection {
    fn add(
        &mut self,
        p: &Payload,
        s: &Source,
        idx: &Index,
        r: Range,
        role: &str,
        kind: &str,
        sub: &[String],
        target: &[String],
        anchors: Vec<Value>,
        basis: Vec<&str>,
    ) -> Result<bool> {
        if self.keys.contains(&(s.id.clone(), r.start, r.end)) {
            return Ok(true);
        }
        need(covered(p, &s.id, r), "EVIDENCE_SELECTION_OUTSIDE_COVERED")?;
        if self.rows.len() >= p.options.max_fragments
            || self.chars + r.len() > p.options.max_selected_chars
        {
            return Ok(false);
        }
        let quote = idx.text(&s.content, r)?;
        self.rows.push(json!({"source_id":s.id,"source_sha256":s.sha256,"start":r.start,"end":r.end,"quote":quote,"role":role,"binding":{"kind":kind,"subject_terms":sub,"target_terms":target,"anchor_spans":anchors,"basis":basis,"assurance":"BOUNDED_LEXICAL_OR_LAYOUT_LINK_NOT_SEMANTIC_PROOF"}}));
        self.keys.insert((s.id.clone(), r.start, r.end));
        self.chars += r.len();
        Ok(true)
    }
}

pub fn execute(v: &Value) -> Result<Value> {
    let r: Request =
        serde_json::from_value(v.clone()).map_err(|_| Error::new("RPC_INVALID_REQUEST"))?;
    need(
        r.wire_version == "lightog-evidence/0.1",
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
        p.options.max_selected_chars <= 64000
            && p.options.max_fragments <= 128
            && p.options.max_anchor_distance <= 6000,
        "EVIDENCE_BUDGET_INVALID",
    )?;
    // Reuse the existing strict source/hash/span/layout validator; zero fragment budget
    // obtains structural associations without admitting any outside-covered text.
    let projection = json!({"sources":p.sources,"evidence":p.anchors,"covered":p.covered,"options":{"max_fragments":0,"max_fragment_chars":1200,"max_total_chars":0,"max_distance":p.options.max_anchor_distance}});
    let layout = crate::fragments::plan(&projection)?;
    let indexes: Vec<_> = p.sources.iter().map(|s| Index::new(&s.content)).collect();
    let source_map: HashMap<_, _> = p
        .sources
        .iter()
        .enumerate()
        .map(|(i, s)| (s.id.as_str(), i))
        .collect();
    let qsub = subjects(&p.question);
    let qtarget = targets(&p.question);
    let mut selected = Selection {
        rows: Vec::new(),
        keys: HashSet::new(),
        chars: 0,
    };
    let mut excluded = Audit::new();
    let mut uncertain = Audit::new();
    let mut table_discussions: HashMap<(String, String), (Vec<Value>, Vec<String>)> =
        HashMap::new();
    for a in &p.anchors {
        need(
            covered(&p, &a.source_id, ar(a)),
            "EVIDENCE_ANCHOR_OUTSIDE_COVERED",
        )?;
        let i = source_map[a.source_id.as_str()];
        let s = &p.sources[i];
        let sub = literal_hits(&a.quote, &qsub);
        let tar = literal_hits(&a.quote, &qtarget);
        let binding = if sub.is_empty() {
            "ANCHOR_PARAGRAPH_CONTEXT"
        } else {
            "EXPLICIT_QUESTION_SUBJECT"
        };
        need(
            selected.add(
                &p,
                s,
                &indexes[i],
                ar(a),
                "ANCHOR",
                binding,
                &sub,
                &tar,
                vec![serde_json::to_value(a).map_err(|_| Error::new("EVIDENCE_ANCHOR_INVALID"))?],
                vec![
                    "IMMUTABLE_SUPPLIED_ADMISSION_ANCHOR",
                    "PRESERVATION_IS_NOT_RELEVANCE_VERIFICATION",
                ],
            )?,
            "EVIDENCE_ANCHOR_BUDGET_EXCEEDED",
        )?;
    }
    // Layout-derived pieces are limited to the anchor's associated table header/note.
    for a in layout["associations"].as_array().into_iter().flatten() {
        let Some(sid) = a["source_id"].as_str() else {
            continue;
        };
        let i = source_map[sid];
        let s = &p.sources[i];
        let idx = &indexes[i];
        let anchors = a["anchor_spans"].as_array().cloned().unwrap_or_default();
        let mut pieces = Vec::new();
        if a["kind"] == "SOURCE_TABLE_GROUP" {
            let mut members = Vec::new();
            let mut row_actors = Vec::new();
            for id in a["table_block_ids"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                if let Some(b) = s.blocks.iter().find(|b| b.block_id == id) {
                    members.push(b);
                    let text = idx.text(&s.content, br(b))?;
                    let header: String = text.split_inclusive('\n').take(2).collect();
                    pieces.push((
                        Range {
                            start: b.start,
                            end: b.start + header.encode_utf16().count(),
                        },
                        "TABLE_HEADER",
                    ));
                    row_actors.extend(subjects(text.lines().next().unwrap_or("")));
                    for line in text.lines().skip(2) {
                        if let Some(first) = line.trim().trim_start_matches('|').split('|').next() {
                            row_actors.extend(subjects(first));
                        }
                    }
                }
            }
            let ids: Vec<String> = a["table_block_ids"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            row_actors = table_actor_terms(s, idx, &ids)?;
            // Only the table group's direct following paragraph may inherit its
            // subject through an explicit table/discussion cue. No free neighbor hop.
            if let Some(tail) = members.iter().max_by_key(|b| b.end) {
                if let Some(next) = s
                    .blocks
                    .iter()
                    .find(|b| b.start >= tail.end && b.block_id != tail.block_id)
                {
                    let gap = if tail.end == next.start {
                        ""
                    } else {
                        idx.text(
                            &s.content,
                            Range {
                                start: tail.end,
                                end: next.start,
                            },
                        )?
                    };
                    let text = idx.text(&s.content, br(next))?.trim();
                    let cue=Regex::new(r"^(?:本表|该表|这[一二两三四五六七八九十0-9]*个?指标|这[一二两三四五六七八九十0-9]*项指标|本速查卡|选型建议[：:]|使用建议[：:])").expect("constant table discussion regex");
                    let anchored = p.anchors.iter().any(|e| {
                        e.source_id == sid
                            && members.iter().any(|b| br(b).contains(ar(e)))
                            && same_section(s, ar(e), br(next))
                            && ar(e).distance(br(next)) <= p.options.max_anchor_distance
                    });
                    if matches!(next.kind.as_str(), "text" | "paragraph")
                        && gap.trim().is_empty()
                        && cue.is_match(text)
                        && anchored
                    {
                        row_actors.sort();
                        row_actors.dedup();
                        table_discussions.insert(
                            (sid.to_owned(), next.block_id.clone()),
                            (anchors.clone(), row_actors),
                        );
                    }
                }
            }
        } else if a["kind"] == "TABLE_GROUP_NOTE" {
            if let (Some(start), Some(end)) = (a["start"].as_u64(), a["end"].as_u64()) {
                pieces.push((
                    Range {
                        start: start as usize,
                        end: end as usize,
                    },
                    "TABLE_NOTE",
                ));
            }
        }
        for (r, role) in pieces {
            if !covered(&p, sid, r) {
                uncertain.push(sid, r, "ASSOCIATED_LAYOUT_PIECE_NOT_FULLY_COVERED");
                continue;
            }
            if role == "TABLE_NOTE" {
                let raw = idx.text(&s.content, r)?;
                let ids: Vec<String> = a["table_block_ids"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect();
                let actors = table_actor_terms(s, idx, &ids)?;
                let note_body = raw
                    .trim()
                    .trim_start_matches("表注")
                    .trim_start_matches('注')
                    .trim_start_matches(['：', ':'])
                    .trim();
                if foreign_table_actor(raw, &actors, &p.question)
                    || foreign_initial_actor(note_body, &qsub)
                {
                    uncertain.push(sid, r, "TABLE_NOTE_OTHER_OR_UNRESOLVED_ROW_OWNER");
                    continue;
                }
                let owner_hit = actors
                    .iter()
                    .any(|a| !literal_hits(raw, &[a.clone()]).is_empty());
                let global = ["表中", "本表", "该表", "全表", "速查卡"]
                    .iter()
                    .any(|v| raw.contains(v));
                if !owner_hit && !global {
                    uncertain.push(sid, r, "TABLE_NOTE_ROW_SCOPE_UNRESOLVED");
                    continue;
                }
                if owner_hit && !sufficient_target_link(&qtarget, &literal_hits(raw, &qtarget)) {
                    uncertain.push(sid, r, "TABLE_NOTE_TARGET_NOT_DISTINCTIVE");
                    continue;
                }
            }
            if !selected.add(
                &p,
                s,
                idx,
                r,
                role,
                "TABLE_GROUP",
                &qsub,
                &qtarget,
                anchors.clone(),
                vec![
                    "EXISTING_SOURCE_LAYOUT_ASSOCIATION",
                    "NO_OTHER_TABLE_ROWS_ADMITTED",
                ],
            )? {
                uncertain.push(sid, r, "OPTIONAL_SELECTION_BUDGET");
            }
        }
    }
    for (si, s) in p.sources.iter().enumerate() {
        let idx = &indexes[si];
        let source_anchors: Vec<_> = p.anchors.iter().filter(|a| a.source_id == s.id).collect();
        for b in &s.blocks {
            if !matches!(b.kind.as_str(), "text" | "paragraph" | "list_item") {
                continue;
            }
            let relevant: Vec<_> = source_anchors
                .iter()
                .copied()
                .filter(|a| {
                    br(b).distance(ar(a)) <= p.options.max_anchor_distance
                        && same_section(s, ar(a), br(b))
                })
                .collect();
            if relevant.is_empty() {
                continue;
            }
            let text = idx.text(&s.content, br(b))?;
            for r in sentences(text, b.start) {
                if !covered(&p, &s.id, r) {
                    if p.covered
                        .iter()
                        .any(|c| c.source_id == s.id && c.start < r.end && r.start < c.end)
                    {
                        uncertain.push(&s.id, r, "SENTENCE_NOT_FULLY_COVERED_NO_TRUNCATION");
                    }
                    continue;
                }
                if source_anchors.iter().any(|a| ar(a).contains(r)) {
                    continue;
                }
                let raw = idx.text(&s.content, r)?;
                if raw.trim().is_empty() {
                    continue;
                }
                let sub = literal_hits(raw, &qsub);
                let tar = literal_hits(raw, &qtarget);
                let local: Vec<_> = relevant
                    .iter()
                    .copied()
                    .filter(|a| br(b).contains(ar(a)))
                    .collect();
                let foreign = foreign_initial_actor(raw, &qsub);
                let discussion = table_discussions.get(&(s.id.clone(), b.block_id.clone()));
                let table_foreign = discussion
                    .is_some_and(|(_, actors)| foreign_table_actor(raw, actors, &p.question));
                let table_inherited = discussion.is_some() && !foreign && !table_foreign;
                let explicit = !sub.is_empty() && !foreign;
                // Inheritance stays in exactly the anchor block, never the whole section.
                let continuation = [
                    "但", "不过", "然而", "其中", "上述", "该", "其", "这", "若", "如果", "仅",
                    "除", "前提", "例外", "因此",
                ]
                .iter()
                .any(|v| raw.trim_start().starts_with(v));
                let inherited = !qsub.is_empty()
                    && !local.is_empty()
                    && !foreign
                    && continuation
                    && local.iter().any(|a| {
                        a.end <= r.start
                            && !literal_hits(&a.quote, &qsub).is_empty()
                            && (a.end == r.start
                                || idx
                                    .text(
                                        &s.content,
                                        Range {
                                            start: a.end,
                                            end: r.start,
                                        },
                                    )
                                    .is_ok_and(|gap| {
                                        gap.chars()
                                            .all(|c| c.is_whitespace() || "。；;！？!?".contains(c))
                                    }))
                    });
                if table_foreign {
                    excluded.push(&s.id, r, "OTHER_TABLE_ACTOR_IN_DISCUSSION_CLAUSE");
                    continue;
                }
                if !explicit && !inherited && !table_inherited {
                    if qsub.is_empty() {
                        uncertain.push(&s.id, r, "NO_PARSED_LITERAL_SUBJECT_NO_PARAGRAPH_DEFAULT");
                    } else {
                        excluded.push(&s.id, r, "NO_QUESTION_SUBJECT_OR_LOCAL_ANCHOR_BINDING");
                    }
                    continue;
                }
                // Never reuse broad topic words such as 'constraint' as a target bridge.
                if !sufficient_target_link(&qtarget, &tar) {
                    uncertain.push(&s.id, r, "NO_DISTINCTIVE_QUESTION_TARGET_LINK");
                    continue;
                }
                let linked: Vec<_> = if explicit {
                    relevant
                        .iter()
                        .copied()
                        .filter(|a| !literal_hits(&a.quote, &sub).is_empty())
                        .collect()
                } else {
                    local
                };
                if !table_inherited && linked.is_empty() {
                    uncertain.push(&s.id, r, "QUESTION_SUBJECT_NOT_LINKED_TO_ADMISSION_ANCHOR");
                    continue;
                }
                let spans = if table_inherited {
                    discussion.map(|d| d.0.clone()).unwrap_or_default()
                } else {
                    linked
                        .iter()
                        .map(|a| serde_json::to_value(a).unwrap_or(Value::Null))
                        .collect()
                };
                let role = if qualifier(raw) {
                    "QUALIFIER"
                } else {
                    "DIRECT_SUPPORT"
                };
                let kind = if table_inherited {
                    "TABLE_GROUP"
                } else if explicit {
                    "EXPLICIT_QUESTION_SUBJECT"
                } else {
                    "ANCHOR_PARAGRAPH_CONTEXT"
                };
                let basis = if table_inherited {
                    vec![
                        "DIRECT_TABLE_GROUP_FOLLOWING_PARAGRAPH",
                        "EXPLICIT_TABLE_DISCUSSION_CUE",
                        "NON_GENERIC_QUESTION_TARGET_BIGRAM",
                        "NO_OTHER_TABLE_ACTOR_IN_CLAUSE",
                    ]
                } else if explicit {
                    vec![
                        "LITERAL_QUESTION_TECHNICAL_TOKEN",
                        "NON_GENERIC_QUESTION_TARGET_BIGRAM",
                        "SAME_SECTION_AND_BOUNDED_DISTANCE",
                    ]
                } else {
                    vec![
                        "SAME_ORIGINAL_ANCHOR_BLOCK",
                        "NON_GENERIC_QUESTION_TARGET_BIGRAM",
                        "NO_INITIAL_FOREIGN_TECHNICAL_ACTOR",
                    ]
                };
                if !selected.add(&p, s, idx, r, role, kind, &sub, &tar, spans, basis)? {
                    uncertain.push(&s.id, r, "OPTIONAL_SELECTION_BUDGET");
                }
            }
        }
    }
    Ok(
        json!({"policy_version":VERSION,"question_sha256":wire::text_sha(&p.question),"selected":selected.rows,"excluded":{"records":excluded.rows,"omitted_count":excluded.omitted},"uncertain":{"records":uncertain.rows,"omitted_count":uncertain.omitted},"trace":{"admission":"SUPPLIED_ANCHORS_REQUIRED_BASELINE_CONDITIONED_NOT_INITIAL_RETRIEVAL","source_stamp":layout["source_stamp"],"layout_policy_version":layout["policy_version"],"question_subject_terms":qsub,"question_target_terms":qtarget,"scope":"COVERED_ONLY_LEXICAL_LAYOUT_HEURISTIC_NOT_SEMANTIC_OR_FACT_PROOF","recursive_expansion":false,"uncovered_text_selected":false},"budget":{"max_selected_chars":p.options.max_selected_chars,"max_fragments":p.options.max_fragments,"max_anchor_distance":p.options.max_anchor_distance,"selected_characters":selected.chars,"selected_fragment_count":selected.keys.len(),"character_accounting":"SUM_EMITTED_UTF16_LENGTHS_OVERLAPS_COUNTED","anchor_overflow_policy":"ERROR_WITHOUT_PARTIAL_RESULT","audit_records_per_category":AUDIT_LIMIT}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(question: &str, parts: &[(&str, &str)], anchor: usize) -> Value {
        let mut content = String::new();
        let mut blocks = Vec::new();
        for (i, (kind, text)) in parts.iter().enumerate() {
            if i > 0 {
                content.push_str("\n\n");
            }
            let start = content.encode_utf16().count();
            content.push_str(text);
            let end = content.encode_utf16().count();
            blocks.push(json!({"block_id":format!("b{i}"),"kind":kind,"start":start,"end":end,"page_numbers":[1]}));
        }
        let a = &blocks[anchor];
        let len = content.encode_utf16().count();
        let sha = wire::text_sha(&content);
        json!({"question":question,"sources":[{"id":"s","content":content,"sha256":sha,"blocks":blocks}],"anchors":[{"source_id":"s","source_sha256":sha,"start":a["start"],"end":a["end"],"quote":parts[anchor].1}],"covered":[{"source_id":"s","start":0,"end":len}]})
    }
    fn quotes(v: &Value) -> String {
        v["selected"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["quote"].as_str().unwrap())
            .collect::<Vec<_>>()
            .join("\n")
    }
    #[test]
    fn subject_and_target_guards() {
        let p = fixture(
            "Alpha 业务主键如何唯一？",
            &[
                ("text", "Alpha 业务主键必须唯一。"),
                ("text", "Beta 业务主键仅在测试环境唯一。"),
                ("text", "Alpha 属性白名单必须校验。"),
                ("text", "Alpha 业务主键仅在生产环境生效。"),
            ],
            0,
        );
        let r = select(&p).unwrap();
        let q = quotes(&r);
        assert!(!q.contains("Beta"));
        assert!(!q.contains("白名单"));
        assert!(q.contains("生产环境"));
    }
    #[test]
    fn negative_exclusion_and_planned_time_stay_verbatim() {
        let text = "Alpha 覆盖率计划2028年达到90%；但仅限核心实体，不包括长尾实体，且不是已实现。";
        let p = fixture(
            "Alpha 覆盖率目标是什么？",
            &[("text", "Alpha 覆盖率有计划。"), ("text", text)],
            0,
        );
        let r = select(&p).unwrap();
        assert!(r["selected"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["quote"] == text && v["role"] == "QUALIFIER"));
    }
    #[test]
    fn no_cross_section_or_paragraph_inheritance() {
        let p = fixture(
            "Alpha 覆盖率是什么？",
            &[
                ("text", "Alpha 覆盖率为90%。"),
                ("text", "但覆盖率仅限付费账户。"),
                ("section_header", "另一章节"),
                ("text", "Alpha 覆盖率只对测试有效。"),
            ],
            0,
        );
        assert_eq!(select(&p).unwrap()["selected"].as_array().unwrap().len(), 1);
    }
    #[test]
    fn new_initial_actor_blocks_local_inheritance() {
        let mut p = fixture(
            "Alpha 覆盖率如何？",
            &[("text", "Alpha 覆盖率为90%。Beta 覆盖率为30%。")],
            0,
        );
        p["anchors"][0]["end"] = json!(14);
        p["anchors"][0]["quote"] = json!("Alpha 覆盖率为90%。");
        let r = select(&p).unwrap();
        assert!(!quotes(&r).contains("Beta"));
    }
    #[test]
    fn anchors_budget_hash_quote_and_utf16() {
        let p = fixture("Alpha 覆盖率？", &[("text", "😀Alpha 覆盖率为90%。")], 0);
        assert_eq!(
            select(&p).unwrap()["selected"][0]["quote"],
            p["anchors"][0]["quote"]
        );
        let mut bad = p.clone();
        bad["options"] =
            json!({"max_selected_chars":1,"max_fragments":128,"max_anchor_distance":6000});
        assert_eq!(
            select(&bad).unwrap_err().code,
            "EVIDENCE_ANCHOR_BUDGET_EXCEEDED"
        );
        let mut bad = p.clone();
        bad["sources"][0]["sha256"] = json!("bad");
        assert!(select(&bad).is_err());
        let mut bad = p.clone();
        bad["anchors"][0]["quote"] = json!("wrong");
        assert!(select(&bad).is_err());
        let mut bad = p.clone();
        bad["anchors"][0]["start"] = json!(1);
        assert!(select(&bad).is_err());
        let mut bad = p;
        bad["covered"] = json!([]);
        assert_eq!(
            select(&bad).unwrap_err().code,
            "EVIDENCE_ANCHOR_OUTSIDE_COVERED"
        );
    }
    #[test]
    fn covered_is_hard_boundary() {
        let mut p = fixture(
            "Alpha 覆盖率？",
            &[
                ("text", "Alpha 覆盖率有计划。"),
                ("text", "Alpha 覆盖率仅在生产环境达到90%。"),
            ],
            0,
        );
        let end = p["anchors"][0]["end"].clone();
        p["covered"][0]["end"] = end;
        assert_eq!(select(&p).unwrap()["selected"].as_array().unwrap().len(), 1);
    }
    #[test]
    fn same_level_other_table_is_not_a_row_candidate() {
        let h = "| 级别 | 特征 |\n| --- | --- |\n";
        let one = format!("{h}| L2 | Alpha闭环 |");
        let two = format!("{h}| L2 | Beta推理 |");
        let mut p = fixture(
            "Alpha L2 特征？",
            &[
                ("table", &one),
                ("section_header", "独立模型"),
                ("table", &two),
            ],
            0,
        );
        let start = one.find("| L2").unwrap();
        p["anchors"][0]["start"] = json!(one[..start].encode_utf16().count());
        p["anchors"][0]["quote"] = json!(&one[start..]);
        let r = select(&p).unwrap();
        assert!(quotes(&r).contains("Alpha闭环"));
        assert!(!quotes(&r).contains("Beta推理"));
    }
    #[test]
    fn no_ascii_prefix_subject_match() {
        assert!(literal_hits("Alpha2 覆盖率", &["Alpha".into()]).is_empty());
    }
    #[test]
    fn unknown_chinese_subject_never_defaults_same_paragraph() {
        let text = "甲云覆盖率为90%。乙云覆盖率为30%。";
        let mut p = fixture("甲云覆盖率是多少？", &[("text", text)], 0);
        let end = "甲云覆盖率为90%。".encode_utf16().count();
        p["anchors"][0]["end"] = json!(end);
        p["anchors"][0]["quote"] = json!("甲云覆盖率为90%。");
        let r = select(&p).unwrap();
        assert_eq!(r["selected"].as_array().unwrap().len(), 1);
        assert!(!quotes(&r).contains("乙云"));
        assert!(r["uncertain"]["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["reason"] == "NO_PARSED_LITERAL_SUBJECT_NO_PARAGRAPH_DEFAULT"));
    }
    #[test]
    fn inherited_subject_must_be_immediate_and_explicitly_continued() {
        let text = "Alpha 覆盖率为90%。乙云覆盖率为30%。但其覆盖率不是生产承诺。";
        let mut p = fixture("Alpha 覆盖率是多少？", &[("text", text)], 0);
        let quote = "Alpha 覆盖率为90%。";
        p["anchors"][0]["end"] = json!(quote.encode_utf16().count());
        p["anchors"][0]["quote"] = json!(quote);
        let r = select(&p).unwrap();
        assert_eq!(r["selected"].as_array().unwrap().len(), 1);
    }
    #[test]
    fn chinese_table_discussion_has_direct_scope_only() {
        let table = "| 指标 | 目标 |\n| --- | --- |\n| 实体覆盖率 | 90% |";
        let mut p = fixture(
            "实体覆盖率如何统计？",
            &[
                ("table", table),
                ("text", "这两个指标中，实体覆盖率仅统计核心实体。"),
                ("text", "该表实体覆盖率不包括历史数据。"),
            ],
            0,
        );
        let start = table.find("| 实体").unwrap();
        p["anchors"][0]["start"] = json!(table[..start].encode_utf16().count());
        p["anchors"][0]["quote"] = json!(&table[start..]);
        let r = select(&p).unwrap();
        assert!(r["selected"].as_array().unwrap().iter().any(|v| v["quote"]
            .as_str()
            .unwrap()
            .contains("仅统计核心实体")
            && v["binding"]["kind"] == "TABLE_GROUP"));
        assert!(!quotes(&r).contains("历史数据"));
    }
    #[test]
    fn table_discussion_does_not_broadcast_other_row_actor() {
        let table = "| 方案 | 覆盖率 |\n| --- | --- |\n| Alpha | 90% |\n| Beta | 60% |";
        let mut p = fixture(
            "Alpha 覆盖率如何？",
            &[
                ("table", table),
                (
                    "text",
                    "选型建议：Alpha 覆盖率仅统计核心实体；Beta 覆盖率仅统计长尾实体。",
                ),
            ],
            0,
        );
        let start = table.find("| Alpha").unwrap();
        let end = table[..start].len() + table[start..].find('\n').unwrap();
        p["anchors"][0]["start"] = json!(table[..start].encode_utf16().count());
        p["anchors"][0]["end"] = json!(table[..end].encode_utf16().count());
        p["anchors"][0]["quote"] = json!(&table[start..end]);
        let r = select(&p).unwrap();
        assert!(quotes(&r).contains("核心实体"));
        assert!(!quotes(&r).contains("长尾实体"));
    }
    #[test]
    fn partial_covered_sentence_is_uncertain_never_sliced() {
        let mut p = fixture(
            "Alpha 覆盖率？",
            &[
                ("text", "Alpha 覆盖率有计划。"),
                ("text", "Alpha 覆盖率仅限测试环境，不能作为生产承诺。"),
            ],
            0,
        );
        let start = p["sources"][0]["blocks"][1]["start"].as_u64().unwrap();
        p["covered"][0]["end"] = json!(start + 10);
        let r = select(&p).unwrap();
        assert_eq!(r["selected"].as_array().unwrap().len(), 1);
        assert!(r["uncertain"]["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["reason"] == "SENTENCE_NOT_FULLY_COVERED_NO_TRUNCATION"));
    }
    #[test]
    fn optional_budget_is_audited_and_anchors_retained() {
        let mut p = fixture(
            "Alpha 覆盖率？",
            &[
                ("text", "Alpha 覆盖率有计划。"),
                ("text", "Alpha 覆盖率仅限测试环境。"),
            ],
            0,
        );
        p["options"] =
            json!({"max_selected_chars":16000,"max_fragments":1,"max_anchor_distance":6000});
        let r = select(&p).unwrap();
        assert_eq!(r["selected"].as_array().unwrap().len(), 1);
        assert_eq!(r["selected"][0]["role"], "ANCHOR");
        assert!(r["uncertain"]["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["reason"] == "OPTIONAL_SELECTION_BUDGET"));
    }
    #[test]
    fn semicolon_negative_scope_is_not_cut_from_positive() {
        let text = "Alpha覆盖率为90%；生产环境不适用该覆盖率。";
        let p = fixture(
            "Alpha覆盖率是多少",
            &[("text", "Alpha覆盖率有定义。"), ("text", text)],
            0,
        );
        let r = select(&p).unwrap();
        let extra: Vec<_> = r["selected"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["role"] != "ANCHOR")
            .collect();
        assert_eq!(extra.len(), 1);
        assert_eq!(extra[0]["quote"], text);
        assert_eq!(extra[0]["role"], "QUALIFIER");
    }
    #[test]
    fn shared_generic_target_tail_is_not_distinctive() {
        let p = fixture(
            "Alpha备份策略是什么",
            &[
                ("text", "Alpha备份策略需要审批。"),
                ("text", "Alpha缓存策略允许自动刷新。"),
            ],
            0,
        );
        let r = select(&p).unwrap();
        assert_eq!(r["selected"].as_array().unwrap().len(), 1);
        assert!(!quotes(&r).contains("缓存"));
        assert!(r["uncertain"]["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["reason"] == "NO_DISTINCTIVE_QUESTION_TARGET_LINK"));
    }
    #[test]
    fn table_note_owner_is_not_broadcast_to_every_anchor_row() {
        let table = "| 方案 | 覆盖率 |\n| --- | --- |\n| Alpha | 90% |\n| Beta | 60% |";
        let mut p = fixture(
            "Alpha覆盖率是多少",
            &[
                ("table", table),
                ("text", "注：Beta覆盖率为30%，仅适用于测试环境。"),
            ],
            0,
        );
        let start = table.find("| Alpha").unwrap();
        let end = start + table[start..].find('\n').unwrap();
        p["anchors"][0]["start"] = json!(table[..start].encode_utf16().count());
        p["anchors"][0]["end"] = json!(table[..end].encode_utf16().count());
        p["anchors"][0]["quote"] = json!(&table[start..end]);
        let r = select(&p).unwrap();
        assert!(!quotes(&r).contains("Beta覆盖率"));
        assert!(r["uncertain"]["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["reason"] == "TABLE_NOTE_OTHER_OR_UNRESOLVED_ROW_OWNER"));
        let note = "注：表中符号表示暂无对应概念。";
        let mut p = fixture("Alpha覆盖率是多少", &[("table", table), ("text", note)], 0);
        p["anchors"][0]["start"] = json!(table[..start].encode_utf16().count());
        p["anchors"][0]["end"] = json!(table[..end].encode_utf16().count());
        p["anchors"][0]["quote"] = json!(&table[start..end]);
        assert!(quotes(&select(&p).unwrap()).contains(note));
    }
    #[test]
    fn multi_subject_support_links_only_matching_admission_anchor() {
        let mut p = fixture(
            "Alpha和Beta覆盖率是多少？",
            &[
                ("text", "Alpha覆盖率有定义。"),
                ("text", "Beta覆盖率有定义。"),
                ("text", "Alpha覆盖率为90%。"),
                ("text", "Beta覆盖率为30%。"),
            ],
            0,
        );
        let mut second = p["anchors"][0].clone();
        second["start"] = p["sources"][0]["blocks"][1]["start"].clone();
        second["end"] = p["sources"][0]["blocks"][1]["end"].clone();
        second["quote"] = json!("Beta覆盖率有定义。");
        p["anchors"].as_array_mut().unwrap().push(second);
        let r = select(&p).unwrap();
        for row in r["selected"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["role"] != "ANCHOR")
        {
            let actor = if row["quote"].as_str().unwrap().starts_with("Alpha") {
                "Alpha"
            } else {
                "Beta"
            };
            let anchors = row["binding"]["anchor_spans"].as_array().unwrap();
            assert_eq!(anchors.len(), 1);
            assert!(anchors[0]["quote"].as_str().unwrap().starts_with(actor));
        }
    }
}
