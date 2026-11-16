//! M1 isolated production-representation compatibility. No inference or product writes.
use crate::{need, wire, Error, Kernel, Result, ValidationContext};
use serde::de::{MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fmt;

/// Preserve received JSON object insertion order solely for legacy JSON.stringify hashes.
/// Strict wire validation runs first. This is not the demand canonical hash algorithm.
#[derive(Clone)]
pub struct Ordered {
    pub value: Value,
    repr: String,
    fields: BTreeMap<String, Ordered>,
    items: Vec<Ordered>,
}
impl Ordered {
    fn scalar(value: Value) -> Self {
        Self {
            repr: value.to_string(),
            value,
            fields: BTreeMap::new(),
            items: vec![],
        }
    }
    fn get(&self, key: &str) -> Result<&Self> {
        self.fields
            .get(key)
            .ok_or_else(|| Error::new("M1_INPUT_INVALID"))
    }
}
impl<'de> Deserialize<'de> for Ordered {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Ordered;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("strict JSON")
            }
            fn visit_unit<E>(self) -> std::result::Result<Ordered, E> {
                Ok(Ordered::scalar(Value::Null))
            }
            fn visit_bool<E>(self, v: bool) -> std::result::Result<Ordered, E> {
                Ok(Ordered::scalar(json!(v)))
            }
            fn visit_i64<E>(self, v: i64) -> std::result::Result<Ordered, E> {
                Ok(Ordered::scalar(json!(v)))
            }
            fn visit_u64<E>(self, v: u64) -> std::result::Result<Ordered, E> {
                Ok(Ordered::scalar(json!(v)))
            }
            fn visit_str<E>(self, v: &str) -> std::result::Result<Ordered, E> {
                Ok(Ordered::scalar(json!(v)))
            }
            fn visit_string<E>(self, v: String) -> std::result::Result<Ordered, E> {
                Ok(Ordered::scalar(json!(v)))
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Ordered, A::Error> {
                let mut items = vec![];
                while let Some(v) = a.next_element::<Ordered>()? {
                    items.push(v);
                }
                Ok(Ordered {
                    value: Value::Array(items.iter().map(|v| v.value.clone()).collect()),
                    repr: format!(
                        "[{}]",
                        items
                            .iter()
                            .map(|v| v.repr.as_str())
                            .collect::<Vec<_>>()
                            .join(",")
                    ),
                    fields: BTreeMap::new(),
                    items,
                })
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Ordered, A::Error> {
                let mut fields = BTreeMap::new();
                let mut order = vec![];
                while let Some((k, v)) = a.next_entry::<String, Ordered>()? {
                    order.push(k.clone());
                    fields.insert(k, v);
                }
                // ECMAScript enumerates canonical array-index keys before other keys.
                let index = |k: &String| {
                    k.parse::<u32>()
                        .ok()
                        .filter(|i| *i != u32::MAX && i.to_string() == *k)
                };
                order.sort_by(|a, b| match (index(a), index(b)) {
                    (Some(a), Some(b)) => a.cmp(&b),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    _ => std::cmp::Ordering::Equal,
                });
                let repr = format!(
                    "{{{}}}",
                    order
                        .iter()
                        .map(|k| format!("{}:{}", json!(k), fields[k].repr))
                        .collect::<Vec<_>>()
                        .join(",")
                );
                Ok(Ordered {
                    value: Value::Object(
                        fields
                            .iter()
                            .map(|(k, v)| (k.clone(), v.value.clone()))
                            .collect(),
                    ),
                    repr,
                    fields,
                    items: vec![],
                })
            }
        }
        d.deserialize_any(V)
    }
}
pub fn parse(raw: &[u8]) -> Result<Ordered> {
    wire::strict_load(raw)?;
    serde_json::from_slice(raw).map_err(|_| Error::new("M1_INPUT_INVALID"))
}
fn arr<'a>(v: &'a Value, code: &'static str) -> Result<&'a Vec<Value>> {
    v.as_array().ok_or_else(|| Error::new(code))
}
fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn js_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\r' | '\u{b}' | '\u{c}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
fn string(v: &Value, max: usize) -> bool {
    v.as_str()
        .is_some_and(|v| !v.trim_matches(js_ws).is_empty() && v.encode_utf16().count() <= max)
}
fn truthy(v: &Value) -> bool {
    !v.is_null() && v != false && v != 0 && v != ""
}
fn unique(values: impl IntoIterator<Item = Value>) -> Vec<Value> {
    let mut out = vec![];
    for v in values {
        if !out.contains(&v) {
            out.push(v);
        }
    }
    out
}
fn u16_len(v: &str) -> usize {
    v.encode_utf16().count()
}
fn first(text: &str, quote: &str) -> Option<usize> {
    text.find(quote).map(|p| u16_len(&text[..p]))
}
fn slice(text: &str, start: usize, end: usize) -> Option<String> {
    let units: Vec<u16> = text.encode_utf16().collect();
    String::from_utf16(units.get(start..end)?).ok()
}
fn occurrences(text: &str, quote: &str) -> Vec<usize> {
    text.char_indices()
        .filter_map(|(p, _)| text[p..].starts_with(quote).then_some(p))
        .take(2)
        .collect()
}
fn blocks(v: &Value) -> Vec<&Value> {
    v["parsing"]["blocks"]
        .as_array()
        .map(|v| v.iter().collect())
        .unwrap_or_default()
}
fn compact(text: &str) -> (String, Vec<usize>) {
    let han = regex::Regex::new(r"^\p{Han}$").unwrap();
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let is_han = |c: char| han.is_match(&c.to_string());
    let gap = |c: char| matches!(c, ' ' | '\t' | '\r' | '\n' | '\u{a0}' | '\u{3000}');
    let mut keep = vec![true; chars.len()];
    let mut i = 0;
    while i < chars.len() {
        if gap(chars[i].1) {
            let start = i;
            while i < chars.len() && gap(chars[i].1) {
                i += 1;
            }
            if start > 0 && i < chars.len() && is_han(chars[start - 1].1) && is_han(chars[i].1) {
                keep[start..i].fill(false);
            }
        } else {
            i += 1;
        }
    }
    let mut value = String::new();
    let mut offsets = vec![];
    for (i, (p, c)) in chars.iter().enumerate() {
        if keep[i] {
            value.push(*c);
            offsets.push(*p);
        }
    }
    (value, offsets)
}
fn aligned(source: &Value, quote: &str) -> Option<(usize, usize, String)> {
    let content = source["content"].as_str()?;
    let found = occurrences(content, quote);
    if found.len() == 1 {
        return Some((
            u16_len(&content[..found[0]]),
            u16_len(&content[..found[0] + quote.len()]),
            "EXACT".into(),
        ));
    }
    if found.len() > 1 || !truthy(&source["parsing"]) {
        return None;
    }
    // Match only parser-inserted inter-block blank-line separators.
    let mut value = String::new();
    let mut offsets = vec![];
    let mut gaps = vec![];
    let chars: Vec<(usize, char)> = content.char_indices().collect();
    let mut i = 0;
    while i < chars.len() {
        let start = i;
        if chars[i].1 == '\n' && i + 1 < chars.len() && chars[i + 1].1 == '\n' {
            i += 2;
            while i < chars.len() && chars[i].1 == '\n' {
                i += 1;
            }
            let end = chars.get(i).map(|v| v.0).unwrap_or(content.len());
            value.push('\n');
            offsets.push((chars[start].0, end));
            gaps.push((chars[start].0, end));
        } else {
            value.push(chars[i].1);
            offsets.push((chars[i].0, chars[i].0 + chars[i].1.len_utf8()));
            i += 1;
        }
    }
    let proposed = regex::Regex::new(r"\n{2,}")
        .unwrap()
        .replace_all(quote, "\n")
        .into_owned();
    let found = occurrences(&value, &proposed);
    if found.len() == 1 {
        let ci = value[..found[0]].chars().count();
        let n = proposed.chars().count();
        if n > 0 {
            let (start, end) = (offsets[ci].0, offsets[ci + n - 1].1);
            let changed: Vec<_> = gaps
                .iter()
                .filter(|(a, b)| *a >= start && *b <= end)
                .collect();
            if !changed.is_empty()
                && changed.iter().all(|(a, b)| {
                    blocks(source)
                        .iter()
                        .any(|v| v["end"] == u16_len(&content[..*a]))
                        && blocks(source)
                            .iter()
                            .any(|v| v["start"] == u16_len(&content[..*b]))
                })
            {
                return Some((
                    u16_len(&content[..start]),
                    u16_len(&content[..end]),
                    "PARSER_BLOCK_SEPARATOR_NEWLINE_V1".into(),
                ));
            }
        }
    }
    let (value, offsets) = compact(content);
    let proposed = compact(quote).0;
    let found = occurrences(&value, &proposed);
    if found.len() != 1 || proposed.is_empty() {
        return None;
    }
    let ci = value[..found[0]].chars().count();
    let n = proposed.chars().count();
    let start = offsets[ci];
    let last = offsets[ci + n - 1];
    let end = last + content[last..].chars().next()?.len_utf8();
    let (a, b) = (u16_len(&content[..start]), u16_len(&content[..end]));
    blocks(source)
        .iter()
        .any(|v| {
            v["start"].as_u64().is_some_and(|v| v <= a as u64)
                && v["end"].as_u64().is_some_and(|v| v >= b as u64)
        })
        .then_some((a, b, "CJK_LAYOUT_WHITESPACE_V1".into()))
}
pub fn validate_scope(p: &Value) -> Result<Value> {
    let (raw, unit, options) = (&p["raw"], &p["unit"], &p["options"]);
    need(raw.is_object(), "M1_SCOPE_SHAPE")?;
    let subjects = arr(&raw["subjects"], "M1_SCOPE_SUBJECTS")?;
    need(subjects.len() <= 80, "M1_SCOPE_SUBJECTS")?;
    let text = unit["text"]
        .as_str()
        .ok_or_else(|| Error::new("M1_INPUT_INVALID"))?;
    let base = unit["start"]
        .as_u64()
        .ok_or_else(|| Error::new("M1_INPUT_INVALID"))? as usize;
    let mut valid = vec![];
    let mut errors = vec![];
    for (i, subject) in subjects.iter().enumerate() {
        need(
            string(&subject["name"], 150)
                && string(&subject["kind"], 100)
                && string(&subject["quote"], 2000),
            "M1_SCOPE_SUBJECT",
        )?;
        let mention = subject.get("mention").unwrap_or(&subject["name"]);
        need(string(mention, 300), "M1_SCOPE_MENTION")?;
        let mention = s(mention);
        let original = s(&subject["quote"]);
        if !original.contains(mention) {
            errors.push(json!(format!("第{}项：主体名不在该项引文中。mention必须复制quote里的连续原称，保留引号和空格；规范名称只能放在name中",i+1)));
            continue;
        }
        let mut pos = first(text, original);
        let mut quote = original.to_string();
        let mut method = None;
        let source = &options["source"];
        if pos.is_none()
            && truthy(&source["parsing"])
            && source["id"] == unit["source_id"]
            && source["sha256"] == unit["source_sha256"]
            && slice(
                s(&source["content"]),
                base,
                unit["end"].as_u64().unwrap_or(0) as usize,
            )
            .as_deref()
                == Some(text)
        {
            need(source["parsing"].is_object(), "M1_INPUT_INVALID")?;
            let mut local = source.clone();
            local["content"] = json!(text);
            let end = unit["end"].as_u64().unwrap_or(0) as usize;
            local["parsing"]["blocks"] = json!(blocks(source)
                .iter()
                .filter(|b| b["start"].as_u64().unwrap_or(u64::MAX) < end as u64
                    && b["end"].as_u64().unwrap_or(0) > base as u64)
                .map(|b| {
                    let mut b = (*b).clone();
                    b["start"] = json!((b["start"].as_u64().unwrap() as usize).max(base) - base);
                    b["end"] = json!((b["end"].as_u64().unwrap() as usize).min(end) - base);
                    b
                })
                .collect::<Vec<_>>());
            if let Some((start, end, m)) = aligned(&local, original) {
                quote = slice(text, start, end).unwrap();
                pos = Some(start);
                method = Some(m);
            }
        }
        if pos.is_none() || !quote.contains(mention) {
            errors.push(json!(format!(
                "第{}项：引文无法在当前原文块逐字定位，请保留空格和换行并引用连续文字",
                i + 1
            )));
            continue;
        }
        let start = base + pos.unwrap();
        let mention_start = start + first(&quote, mention).unwrap();
        let mut v = json!({"name":mention,"mention":mention,"kind":subject["kind"],"quote":quote,"source_id":unit["source_id"],"source_sha256":unit["source_sha256"],"start":start,"end":start+u16_len(&quote),"mention_start":mention_start,"mention_end":mention_start+u16_len(mention)});
        if subject["name"] != mention {
            v["proposed_name"] = subject["name"].clone();
        }
        if let Some(m) = method {
            v["evidence_alignment"] = json!({"method":m,"model_quote":original});
        }
        valid.push(v);
    }
    let tolerant = truthy(&options["tolerateInvalidCandidates"]);
    need(tolerant || errors.is_empty(), "M1_SCOPE_ANCHOR")?;
    let list = |name: &str| -> Result<Vec<Value>> {
        let a = arr(&raw[name], "M1_SCOPE_LIST")?;
        need(
            a.len() <= 12 && a.iter().all(|v| string(v, 500)),
            "M1_SCOPE_LIST",
        )?;
        Ok(unique(a.clone()))
    };
    let conditions = list("conditions")?;
    let invalid: Vec<Value> = conditions
        .iter()
        .enumerate()
        .filter(|(_, v)| !text.contains(s(v)))
        .map(|(i, v)| json!({"index":i,"quote":v}))
        .collect();
    need(tolerant || invalid.is_empty(), "M1_SCOPE_CONDITION")?;
    let mut mentions = vec![];
    for m in raw["entity_mentions"]
        .as_array()
        .into_iter()
        .flatten()
        .take(80)
    {
        if !string(&m["mention"], 150) {
            continue;
        }
        let Some(at) = first(text, s(&m["mention"])) else {
            continue;
        };
        let kind = if let Some(kind) = m["kind"].as_str() {
            String::from_utf16(&kind.encode_utf16().take(100).collect::<Vec<_>>())
                .map_err(|_| Error::new("M1_LEGACY_UNICODE_UNREPRESENTABLE"))?
        } else {
            "entity".into()
        };
        mentions.push(json!({"mention":m["mention"],"kind":kind,"source_id":unit["source_id"],"source_sha256":unit["source_sha256"],"start":base+at,"end":base+at+u16_len(s(&m["mention"]))}));
    }
    let mut out = json!({"unit_id":unit["id"],"subjects":valid,"entity_mentions":mentions,"targets":list("targets")?,"conditions":conditions.iter().filter(|v|text.contains(s(v))).collect::<Vec<_>>(),"internal_questions":list("internal_questions")?});
    if !errors.is_empty() || !invalid.is_empty() {
        out["rejected_candidates"] = json!({"subject_errors":errors,"condition_errors":invalid,"notice":"无法验证的规划线索已隔离，不作为主体或条件进入本体和声明证据；原始候选保留在阶段响应中。"});
    }
    Ok(out)
}
fn candidate_id(subject: &Value) -> String {
    format!(
        "candidate_{}",
        &wire::text_sha(&json!([subject["name"], subject["kind"]]).to_string())[..24]
    )
}
fn row_subjects(rows: &Value) -> Result<Vec<&Value>> {
    let mut out = vec![];
    for row in arr(rows, "M1_INPUT_INVALID")? {
        out.extend(arr(&row["subjects"], "M1_INPUT_INVALID")?);
    }
    Ok(out)
}
pub fn candidates(rows: &Value) -> Result<Value> {
    let mut out: Vec<Value> = vec![];
    for subject in row_subjects(rows)? {
        let id = candidate_id(subject);
        let mut v =
            json!({"id":id,"name":subject["name"],"kind":subject["kind"],"quote":subject["quote"]});
        if truthy(&subject["proposed_name"]) {
            v["proposed_name"] = subject["proposed_name"].clone();
        }
        if let Some(index) = out.iter().position(|v| v["id"] == id) {
            out[index] = v;
        } else {
            out.push(v);
        }
    }
    Ok(json!(out))
}
fn select(p: &Value) -> Result<Value> {
    let ids = arr(&p["raw"]["selected_subject_ids"], "M1_SCOPE_SELECTION")?;
    let menu = arr(&p["candidates"], "M1_SCOPE_SELECTION")?;
    need(
        ids.len() <= 80
            && unique(ids.clone()).len() == ids.len()
            && ids.iter().all(|id| menu.iter().any(|c| c["id"] == *id)),
        "M1_SCOPE_SELECTION",
    )?;
    Ok(json!(ids))
}
fn merge(p: &Ordered) -> Result<Value> {
    let v = &p.value;
    let rows = p.get("rows")?;
    let selection = &v["options"]["selectedSubjectIds"];
    let has_selection = truthy(selection);
    let mut out: Vec<(String, Value)> = vec![];
    for row in &rows.items {
        for subject in &row.get("subjects")?.items {
            let key = wire::text_sha(&subject.repr);
            if !out.iter().any(|(h, _)| *h == key) {
                out.push((key, subject.value.clone()));
            }
        }
    }
    let all = candidates(&v["rows"])?;
    let subjects: Vec<Value> = out
        .into_iter()
        .map(|(_, v)| v)
        .filter(|s| {
            !has_selection
                || selection
                    .as_array()
                    .is_some_and(|ids| ids.contains(&json!(candidate_id(s))))
        })
        .collect();
    need(
        unique(subjects.iter().map(|s| json!(candidate_id(s)))).len() <= 80,
        "M1_SCOPE_CAPACITY",
    )?;
    let rows = arr(&v["rows"], "M1_INPUT_INVALID")?;
    let collect = |key: &str, max: usize| {
        unique(
            rows.iter()
                .flat_map(|r| r[key].as_array().cloned().unwrap_or_default()),
        )
        .into_iter()
        .take(max)
        .collect::<Vec<_>>()
    };
    let rejected = |key: &str| {
        rows.iter()
            .map(|r| {
                r["rejected_candidates"][key]
                    .as_array()
                    .map(Vec::len)
                    .unwrap_or(0)
            })
            .sum::<usize>()
    };
    Ok(
        json!({"version":"internal_scope_v2","candidate_group_count":all.as_array().unwrap().len(),"unselected_candidate_group_count":if has_selection{all.as_array().unwrap().len()as i64-selection.as_array().map(Vec::len).unwrap_or(0)as i64}else{0},"seed_ids":arr(&v["input"]["cqs"],"M1_INPUT_INVALID")?.iter().map(|q|q["id"].clone()).collect::<Vec<_>>(),"subjects":subjects,"targets":collect("targets",30),"conditions":collect("conditions",80),"internal_questions":collect("internal_questions",80),"rejected_subject_count":rejected("subject_errors"),"rejected_condition_count":rejected("condition_errors"),"coverage":if rows.iter().any(|r|truthy(&r["rejected_candidates"])){"SCANNED_WITH_REJECTED_PROPOSALS"}else{"SCANNED_NOT_SEMANTIC_EXHAUSTIVENESS_PROOF"},"source_hashes":arr(&v["input"]["sources"],"M1_INPUT_INVALID")?.iter().map(|s|json!({"id":s["id"],"sha256":s["sha256"]})).collect::<Vec<_>>(),"unit_count":rows.len(),"notice":"内部计划与主体线索，name保留原文提及，proposed_name仅为未确认命名建议；仍须本体、抽取和独立评审校验，不直接发布为事实。"}),
    )
}
pub fn structure_intent(p: &Value) -> Result<Value> {
    let cqs = arr(&p["cqs"], "M1_INPUT_INVALID")?;
    let rows = arr(&p["raw"]["requirements"], "M1_STRUCTURE_COVERAGE")?;
    need(
        rows.len() == cqs.len()
            && unique(rows.iter().map(|r| r["cq_id"].clone())).len() == cqs.len(),
        "M1_STRUCTURE_COVERAGE",
    )?;
    for r in rows {
        need(
            cqs.iter().any(|q| q["id"] == r["cq_id"])
                && ["ATTRIBUTE", "RELATIONSHIP"].contains(&s(&r["mode"]))
                && string(&r["reason"], usize::MAX),
            "M1_STRUCTURE_REQUIREMENT",
        )?;
        if r["mode"] == "RELATIONSHIP" {
            need(
                r["kinds"].as_array().is_some_and(|k| {
                    !k.is_empty()
                        && k.iter().all(|v| {
                            ["RELATION", "COMBINATION", "COMPARISON", "COMPOSITION"].contains(&s(v))
                        })
                }) && ["ALL", "WITHIN"].contains(&s(&r["structure_match"])),
                "M1_STRUCTURE_RELATION",
            )?;
        }
    }
    for r in rows {
        if r.get("subject_group_id").is_some() {
            let groups = p["options"]["groups"].as_array();
            need(
                groups.is_some_and(|g| g.len() == 1 && g[0]["id"] == r["subject_group_id"])
                    && string(&r["group_mention"], usize::MAX)
                    && cqs
                        .iter()
                        .find(|q| q["id"] == r["cq_id"])
                        .is_some_and(|q| s(&q["question"]).contains(s(&r["group_mention"]))),
                "M1_STRUCTURE_GROUP",
            )?;
        }
    }
    Ok(json!(rows
        .iter()
        .map(|r| {
            let mut r = r.clone();
            if r["mode"] == "ATTRIBUTE" {
                r["kinds"] = json!([]);
                r["structure_match"] = json!("ALL");
            }
            r
        })
        .collect::<Vec<_>>()))
}
pub fn query_intent(raw: &Value) -> Result<Value> {
    need(
        [
            "ASSISTANT_IDENTITY",
            "GREETING",
            "PRODUCT_HELP",
            "KNOWLEDGE_QUERY",
            "OTHER",
        ]
        .contains(&s(&raw["intent"])),
        "M1_QUERY_INTENT",
    )?;
    if raw["intent"] == "KNOWLEDGE_QUERY" {
        need(
            ["IN_SCOPE", "OUT_OF_SCOPE", "UNCERTAIN"].contains(&s(&raw["relevance"])),
            "M1_QUERY_RELEVANCE",
        )?;
    }
    need(
        raw.get("needs_clarification").is_none_or(Value::is_boolean),
        "M1_QUERY_CLARIFICATION_TYPE",
    )?;
    if truthy(&raw["needs_clarification"]) {
        need(
            string(&raw["clarification_question"], usize::MAX),
            "M1_QUERY_CLARIFICATION",
        )?;
    }
    let mut out = raw.clone();
    out["relevance"] = if raw["intent"] == "KNOWLEDGE_QUERY" {
        raw["relevance"].clone()
    } else {
        json!("NOT_APPLICABLE")
    };
    out["needs_clarification"] = json!(raw["needs_clarification"] == true);
    Ok(out)
}

fn adapt(p: &Value, kernel: &Kernel) -> Result<Value> {
    let question = &p["question"];
    need(
        string(&question["id"], 128) && string(&question["text"], usize::MAX),
        "M1_ADAPTER_QUESTION",
    )?;
    need(
        p.get("scope_calls").is_none_or(Value::is_array),
        "M1_ADAPTER_SCOPE_CALLS",
    )?;
    if let Some(cq_id) = p["query_requirement"].get("cq_id") {
        need(cq_id == &question["id"], "M1_ADAPTER_IDENTITY_MISMATCH")?;
    }
    let query = query_intent(&p["query_requirement"])?;
    let mut scopes = vec![];
    for call in p["scope_calls"].as_array().into_iter().flatten() {
        scopes.push(validate_scope(call)?);
    }
    let structure = if p.get("structure_call").is_some() {
        let call = &p["structure_call"];
        let validated = structure_intent(call)?;
        need(
            call["cqs"].as_array().is_some_and(|cqs| {
                cqs.iter()
                    .any(|cq| cq["id"] == question["id"] && cq["question"] == question["text"])
            }),
            "M1_ADAPTER_IDENTITY_MISMATCH",
        )?;
        validated
    } else {
        Value::Null
    };
    let context=p.get("validation_context").cloned().unwrap_or_else(||json!({"examples":{},"source_texts":[],"authority":{"requests":[],"allowed_snapshots":[],"claims":[],"receipts":[],"scope_bindings":[],"entities":[],"predicate_refs":[],"user_definitions":[],"groups":[]}}));
    let mut spec = p.get("shared_proposal").cloned().unwrap_or(Value::Null);
    let mut origin = "CALLER_SUPPLIED_SHARED_PROPOSAL";
    if spec.is_null() && query["intent"] != "KNOWLEDGE_QUERY" {
        spec = json!({"contract_version":"lightog-demand/0.1","question_id":question["id"],"text":question["text"],"text_sha256":wire::text_sha(s(&question["text"])),"intent":query["intent"],"requirements":[],"ambiguities":[],"limitations":[]});
        origin = "NON_KNOWLEDGE_DIRECT_MAPPING";
    }
    if !spec.is_null() {
        need(
            spec["question_id"] == question["id"]
                && spec["text"] == question["text"]
                && spec["intent"] == query["intent"],
            "M1_ADAPTER_IDENTITY_MISMATCH",
        )?;
        let ctx = ValidationContext::from_value(&context, kernel)?;
        kernel.validate(&spec, "QuestionSpec", &ctx)?;
    }
    let gaps = if spec.is_null() {
        json!([{"code":"M1_ATOMIC_BINDINGS_MISSING","kind":"REPRESENTATION_GAP","detail":"旧生产需求缺少逐需求的主体/目标/条件绑定，无法无损构造QuestionSpec；保留原始数据，不猜测、不要求用户消除技术限制。"}])
    } else {
        json!([])
    };
    Ok(
        json!({"adapter_version":"lightog-production-demand/0.1","question":question,"legacy_input":p,"legacy_validated":{"query_requirement":query,"structure_requirements":structure,"scope_rows":scopes},"shared":{"question_spec":spec,"origin":if spec.is_null(){Value::Null}else{json!(origin)},"scope_hints_are_not_cq_family":true},"mapping":{"status":if spec.is_null(){"LEGACY_PRESERVED_SHARED_UNREPRESENTABLE"}else{"SHARED_VALIDATED_WITH_LEGACY_SIDECAR"},"gaps":gaps,"semantic_quality":"NOT_EVALUATED","scope_conditions_bound_to_requirements":false,"product_integration":"NOT_SWITCHED"}}),
    )
}
pub fn execute(request: &Ordered, kernel: &Kernel) -> Result<Value> {
    let v = &request.value;
    need(
        v["wire_version"] == "lightog-production-demand/0.1",
        "RPC_VERSION_UNSUPPORTED",
    )?;
    need(string(&v["request_id"], 128), "RPC_INVALID_REQUEST")?;
    let allowed = ["wire_version", "request_id", "operation", "payload"];
    need(
        v.as_object()
            .is_some_and(|v| v.len() == 4 && v.keys().all(|k| allowed.contains(&k.as_str()))),
        "RPC_INVALID_REQUEST",
    )?;
    let p = request.get("payload")?;
    match s(&v["operation"]) {
        "scope_validate" => validate_scope(&p.value),
        "scope_candidates" => candidates(&p.value["rows"]),
        "scope_select" => select(&p.value),
        "scope_merge" => merge(p),
        "structure_intent" => structure_intent(&p.value),
        "query_intent" => query_intent(&p.value["raw"]),
        "adapt" => adapt(&p.value, kernel),
        _ => Err(Error::new("RPC_OPERATION_UNKNOWN")),
    }
}
