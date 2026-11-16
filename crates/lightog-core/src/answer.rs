//! Frozen answer evidence and synthesis contracts. No model, IO, random ID or clock.
use crate::common::*;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
fn get<'a>(v: &'a Value, k: &str) -> &'a Value {
    v.get(k).unwrap_or(&Value::Null)
}
fn copy(out: &mut Map<String, Value>, from: &Value, key: &str) {
    if let Some(v) = from.get(key) {
        out.insert(key.into(), v.clone());
    }
}
fn idx(k: &str) -> Option<u32> {
    k.parse::<u32>()
        .ok()
        .filter(|n| *n != u32::MAX && n.to_string() == k)
}
fn entries(v: &Value) -> Vec<(&String, &Value)> {
    let mut entries: Vec<_> = v
        .as_object()
        .map(|o| o.iter().collect())
        .unwrap_or_default();
    entries.sort_by(|a, b| match (idx(a.0), idx(b.0)) {
        (Some(a), Some(b)) => a.cmp(&b),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        _ => std::cmp::Ordering::Equal,
    });
    entries
}
fn unique(values: &[Value]) -> Vec<Value> {
    let mut seen = HashSet::new();
    values
        .iter()
        .filter(|v| seen.insert(js_stringify(v)))
        .cloned()
        .collect()
}
fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(_)) => js_stringify(v.unwrap()),
        Some(Value::Array(xs)) => xs
            .iter()
            .map(|x| {
                if x.is_null() {
                    String::new()
                } else {
                    js_string(Some(x))
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}
fn property(v: &Value) -> String {
    js_string(Some(v))
}
fn entities(job: &Value) -> &[Value] {
    a(get(get(get(job, "result"), "schema"), "entities"))
}
fn predicates(job: &Value) -> &[Value] {
    a(get(get(get(job, "result"), "schema"), "predicates"))
}
fn value_label(job: &Value, e: &Value) -> Option<Value> {
    if predicates(job)
        .iter()
        .any(|p| get(p, "id") == get(e, "predicate_id") && s(get(p, "value_type")) == "ENTITY")
    {
        Some(
            entities(job)
                .iter()
                .find(|x| get(x, "id") == get(e, "value"))
                .and_then(|x| x.get("name"))
                .filter(|v| truthy(v))
                .unwrap_or(get(e, "value"))
                .clone(),
        )
    } else {
        e.get("value").cloned()
    }
}

pub fn build_evidence(job: &Value, claims: &Value) -> Result<Value> {
    let sources = get(get(job, "input"), "sources");
    let mut index = Map::new();
    for c in a(claims) {
        let source = a(sources)
            .iter()
            .find(|source| get(source, "id") == get(c, "source_id"))
            .ok_or_else(|| fail("回答证据来源不存在"))?;
        ensure(
            crate::structure::support_valid(c, sources),
            "回答多段证据失效",
        )?;
        let context =
            crate::review::source_preview(source, c, &json!({"radius":420,"maxContext":2200}));
        ensure(truthy(get(&context, "valid")), "回答证据原文位置失效")?;
        let mut out = Map::new();
        for (k, v) in [
            ("claim_id", c.get("id")),
            ("subject_id", c.get("subject_id")),
        ] {
            if let Some(v) = v {
                out.insert(k.into(), v.clone());
            }
        }
        let subject = entities(job)
            .iter()
            .find(|e| get(e, "id") == get(c, "subject_id"))
            .and_then(|e| e.get("name"))
            .filter(|v| truthy(v))
            .or_else(|| c.get("subject_id"));
        if let Some(v) = subject {
            out.insert("subject".into(), v.clone());
        }
        copy(&mut out, c, "predicate_id");
        if let Some(label) = predicates(job)
            .iter()
            .find(|p| get(p, "id") == get(c, "predicate_id"))
            .and_then(|p| p.get("label"))
        {
            out.insert("predicate".into(), label.clone());
        }
        copy(&mut out, c, "value");
        if let Some(label) = value_label(job, c) {
            out.insert("value_label".into(), label);
        }
        for k in [
            "scope",
            "unit",
            "comparator",
            "modality",
            "effective_from",
            "time_raw",
            "source_id",
        ] {
            copy(&mut out, c, k);
        }
        for (k, source_key) in [("source_title", "title"), ("source_sha256", "sha256")] {
            if let Some(v) = source.get(source_key) {
                out.insert(k.into(), v.clone());
            }
        }
        for k in ["quote", "start", "end"] {
            copy(&mut out, c, k);
        }
        out.insert(
            "offset_unit".into(),
            if truthy(get(c, "offset_unit")) {
                c["offset_unit"].clone()
            } else {
                json!("utf16_code_unit")
            },
        );
        let document_id = c
            .get("document_id")
            .filter(|v| truthy(v))
            .or_else(|| {
                get(source, "parsing")
                    .get("document_id")
                    .filter(|v| truthy(v))
            })
            .cloned()
            .unwrap_or(Value::Null);
        out.insert("document_id".into(), document_id);
        out.insert(
            "locations".into(),
            if truthy(get(c, "locations")) {
                c["locations"].clone()
            } else {
                json!([])
            },
        );
        out.insert("context".into(), context);
        if truthy(get(c, "support_set")) {
            ensure(get(c, "support_set").is_array(), "多段证据集合无效")?;
            let support: Vec<Value> = a(get(c, "support_set"))
                .iter()
                .map(|e| {
                    let mut e = e.clone();
                    if let Some(title) = a(sources)
                        .iter()
                        .find(|source| get(source, "id") == get(&e, "source_id"))
                        .and_then(|s| s.get("title"))
                    {
                        e.as_object_mut()
                            .unwrap()
                            .insert("source_title".into(), title.clone());
                    } else {
                        e.as_object_mut().unwrap().remove("source_title");
                    }
                    e
                })
                .collect();
            out.insert("support_set".into(), json!(support));
        }
        index.insert(property(get(c, "id")), Value::Object(out));
    }
    Ok(Value::Object(index))
}

pub fn validate(raw: &Value, index: &Value, gate: &Value) -> Result<Value> {
    ensure(
        raw.get("classification") == gate.get("classification"),
        "综合回答不得更改门禁分类",
    )?;
    ensure(
        get(raw, "blocks").is_array() && !a(get(raw, "blocks")).is_empty(),
        "综合回答缺少正文",
    )?;
    ensure(
        !truthy(get(raw, "gaps"))
            || (get(raw, "gaps").is_array() && a(get(raw, "gaps")).iter().all(Value::is_string)),
        "缺口格式无效",
    )?;
    let mut used = Vec::new();
    let mut blocks = Vec::new();
    for (bi, b) in a(get(raw, "blocks")).iter().enumerate() {
        ensure(
            truthy(b)
                && (!truthy(get(b, "heading")) || get(b, "heading").is_string())
                && get(b, "statements").is_array()
                && !a(get(b, "statements")).is_empty(),
            "回答段落格式无效",
        )?;
        let mut statements = Vec::new();
        for (si, statement) in a(get(b, "statements")).iter().enumerate() {
            ensure(
                truthy(statement)
                    && get(statement, "text").is_string()
                    && !s(get(statement, "text")).trim_matches(js_ws).is_empty()
                    && get(statement, "claim_ids").is_array()
                    && !a(get(statement, "claim_ids")).is_empty(),
                "每条综合结论必须有完整文本和依据",
            )?;
            ensure(
                matches!(s(get(statement, "support_kind")), "DIRECT" | "SYNTHESIS"),
                "结论支持类型无效",
            )?;
            let ids = unique(a(get(statement, "claim_ids")));
            ensure(
                ids.iter().all(|id| index.get(property(id)).is_some()),
                "综合结论引用未知或未检索到的声明",
            )?;
            for id in &ids {
                if !used.contains(id) {
                    used.push(id.clone());
                }
            }
            statements.push(json!({"id":format!("statement_{bi}_{si}"),"text":s(get(statement,"text")).trim_matches(js_ws),"claim_ids":ids,"support_kind":statement["support_kind"]}));
        }
        blocks.push(json!({"heading":if truthy(get(b,"heading")){b["heading"].clone()}else{json!("")},"statements":statements}));
    }
    if truthy(get(gate, "comparisons")) || s(get(gate, "query_template")) == "ENTITIES" {
        let required: Vec<Value> = entries(index)
            .iter()
            .map(|(_, v)| get(v, "subject_id").clone())
            .collect();
        let covered: Vec<Value> = used
            .iter()
            .map(|id| get(index.get(property(id)).unwrap(), "subject_id").clone())
            .collect();
        ensure(
            required.iter().all(|id| covered.contains(id)),
            "综合回答遗漏有据主体",
        )?;
    }
    if s(get(gate, "classification")) == "CONFLICT" {
        ensure(
            entries(index)
                .iter()
                .all(|(key, _)| used.contains(&json!(key))),
            "冲突回答必须保留全部候选依据",
        )?;
    }
    let mut out = json!({"blocks":blocks,"gaps":if truthy(get(raw,"gaps")){raw["gaps"].clone()}else{json!([])}});
    if let Some(v) = raw.get("classification") {
        out.as_object_mut()
            .unwrap()
            .insert("classification".into(), v.clone());
    }
    Ok(out)
}

pub fn validate_review(review: &Value, draft: &Value) -> Result<Value> {
    let statements: Vec<&Value> = a(get(draft, "blocks"))
        .iter()
        .flat_map(|b| a(get(b, "statements")))
        .collect();
    ensure(
        truthy(review) && matches!(s(get(review, "verdict")), "PASS" | "REVISE"),
        "综合回答评审协议无效",
    )?;
    if s(get(review, "verdict")) == "REVISE" {
        return Ok(json!(false));
    }
    let rows = get(review, "statement_reviews");
    ensure(
        rows.is_array()
            && a(rows).len() == statements.len()
            && unique(
                &a(rows)
                    .iter()
                    .map(|r| get(r, "id").clone())
                    .collect::<Vec<_>>(),
            )
            .len()
                == statements.len(),
        "综合评审未逐条覆盖结论",
    )?;
    let valid = [
        "question_answered",
        "required_coverage_preserved",
        "no_unsupported_content",
    ]
    .iter()
    .all(|k| get(review, k) == &json!(true))
        && statements.iter().all(|statement| {
            a(rows).iter().any(|r| {
                get(r, "id") == get(statement, "id")
                    && [
                        "supported",
                        "conditions_preserved",
                        "identity_preserved",
                        "citation_complete",
                    ]
                    .iter()
                    .all(|k| get(r, k) == &json!(true))
            })
        });
    Ok(json!(valid))
}

pub fn source_draft(index: &Value, gate: &Value) -> Value {
    let mut groups: Vec<(Value, Vec<&Value>)> = Vec::new();
    for (_, c) in entries(index) {
        let id = get(c, "subject_id");
        if let Some((_, rows)) = groups.iter_mut().find(|(key, _)| key == id) {
            rows.push(c);
        } else {
            groups.push((id.clone(), vec![c]));
        }
    }
    let blocks:Vec<Value>=groups.iter().map(|(id,rows)|{let take=if s(get(gate,"classification"))=="CONFLICT"{rows.len()}else{3};let statements:Vec<Value>=rows.iter().take(take).enumerate().map(|(i,c)|{let value=c.get("value");let mut text=if value.map(|v|v.is_object()||v.is_array()||v.is_null()).unwrap_or(false){js_stringify(value.unwrap())}else{js_string(c.get("value_label").filter(|v|!v.is_null()).or(value))};if truthy(get(c,"unit")){text.push(' ');text.push_str(&js_string(c.get("unit")));}let comparator=get(c,"comparator");if truthy(comparator)&&s(comparator)!="EQ"{let label=match s(comparator){"GT"=>"大于","GE"=>"至少","LT"=>"小于","LE"=>"至多","APPROX"=>"约","UNKNOWN"=>"数值限定未知",x=>x};text.push_str(&format!("（{label}）"));}if truthy(get(c,"scope")){text.push_str(&format!("（适用条件：{}）",js_string(c.get("scope"))));}if s(get(c,"modality"))=="PLANNED"{text.push_str("（计划，非现行事实）");}json!({"id":format!("excerpt_{}_{}",js_string(Some(id)),i),"text":text,"claim_ids":[get(c,"claim_id")],"support_kind":"DIRECT"})}).collect();let mut b=Map::new();copy(&mut b,rows[0],"subject");if let Some(v)=b.remove("subject"){b.insert("heading".into(),v);}b.insert("statements".into(),json!(statements));Value::Object(b)}).collect();
    let mut result = json!({"blocks":blocks,"gaps":[]});
    if let Some(v) = gate.get("classification") {
        result["classification"] = v.clone();
    }
    result
}

pub fn finish(p: &Value) -> Result<Value> {
    let job = get(p, "job");
    let gate = get(p, "gate");
    let index = get(p, "index");
    let draft = get(p, "draft");
    let mode = get(p, "mode");
    let reason = p.get("reason");
    let review = get(p, "review");
    let statements: Vec<&Value> = a(get(draft, "blocks"))
        .iter()
        .flat_map(|b| a(get(b, "statements")))
        .collect();
    let cited_ids = unique(
        &statements
            .iter()
            .flat_map(|s| a(get(s, "claim_ids")))
            .cloned()
            .collect::<Vec<_>>(),
    );
    let cited: Vec<&Value> = cited_ids
        .iter()
        .map(|id| {
            index
                .get(property(id))
                .ok_or_else(|| fail("综合结论引用未知或未检索到的声明"))
        })
        .collect::<Result<_>>()?;
    let value_of = |e: &Value| {
        if s(get(gate, "query_template")) == "ENTITIES" {
            e.get("subject").cloned()
        } else {
            value_label(job, e)
        }
    };
    let comparison = truthy(get(gate, "comparisons"));
    let mut groups: Vec<(String, Vec<&Value>)> = Vec::new();
    for e in cited {
        let key = if comparison {
            js_string(get(e, "subject_id").into())
        } else {
            value_of(e)
                .as_ref()
                .map(js_stringify)
                .unwrap_or("undefined".into())
        };
        if let Some((_, rows)) = groups.iter_mut().find(|(k, _)| k == &key) {
            rows.push(e);
        } else {
            groups.push((key, vec![e]));
        }
    }
    let items: Vec<Value> = groups
        .iter()
        .map(|(_, rows)| {
            let value = if comparison {
                let mut values: Vec<Value> = Vec::new();
                let mut keys = HashSet::new();
                for e in rows {
                    let v = value_of(e).unwrap_or(Value::Null);
                    if keys.insert(js_stringify(&v)) {
                        values.push(v);
                    }
                }
                let mut value = json!({"values":values});
                if let Some(entity) = rows[0].get("subject") {
                    value["entity"] = entity.clone();
                }
                Some(value)
            } else {
                value_of(rows[0])
            };
            let mut evidence: Vec<(String, Value)> = Vec::new();
            for e in rows {
                let key = js_stringify(&json!([get(e, "source_id"), get(e, "quote")]));
                let mut item = Map::new();
                for k in ["source_id", "quote"] {
                    copy(&mut item, e, k);
                }
                if let Some((_, value)) = evidence.iter_mut().find(|(existing, _)| existing == &key) {
                    *value = Value::Object(item);
                } else {
                    evidence.push((key, Value::Object(item)));
                }
            }
            let qualifiers: Vec<Value> = rows
                .iter()
                .map(|e| {
                    let mut q = Map::new();
                    for k in [
                        "claim_id",
                        "subject_id",
                        "scope",
                        "unit",
                        "comparator",
                        "modality",
                        "effective_from",
                        "time_raw",
                    ] {
                        copy(&mut q, e, k);
                    }
                    Value::Object(q)
                })
                .collect();
            let mut item = json!({"evidence":evidence.into_iter().map(|(_,v)|v).collect::<Vec<_>>(),"qualifiers":qualifiers});
            if let Some(value) = value {
                item["value"] = value;
            }
            item
        })
        .collect();
    let meta = get(p, "meta");
    let publication = get(job, "publication");
    let mut snapshot = Map::new();
    if let Some(v) = meta.get("answer_id") {
        snapshot.insert("answer_id".into(), v.clone());
    }
    copy(&mut snapshot, job, "id");
    if let Some(id) = snapshot.remove("id") {
        snapshot.insert("task_id".into(), id);
    }
    snapshot.insert(
        "base_id".into(),
        if truthy(get(publication, "base_id")) {
            publication["base_id"].clone()
        } else {
            Value::Null
        },
    );
    snapshot.insert(
        "source_epoch".into(),
        publication
            .get("source_epoch")
            .cloned()
            .unwrap_or(Value::Null),
    );
    snapshot.insert(
        "review_hash".into(),
        if truthy(get(publication, "review_hash")) {
            publication["review_hash"].clone()
        } else {
            Value::Null
        },
    );
    if let Some(v) = meta.get("answered_at") {
        snapshot.insert("answered_at".into(), v.clone());
    }
    let mut full_result = Map::new();
    copy(&mut full_result, gate, "classification");
    full_result.insert(
        "facts".into(),
        json!(entries(index)
            .iter()
            .map(|(_, e)| (*e).clone())
            .collect::<Vec<_>>()),
    );
    let verification = if truthy(review) {
        let mut v = json!({"statement_count":statements.len()});
        if let Some(verdict) = review.get("verdict") {
            v["verdict"] = verdict.clone();
        }
        v
    } else {
        Value::Null
    };
    let mut result = json!({"synthesis":draft,"evidence_index":index,"snapshot":snapshot,"items":items,"coverage":{"view":mode,"total_claims":entries(index).len(),"all_values_shown":false},"full_result":full_result,"verification":verification});
    if let Some(v) = gate.get("classification") {
        result["classification"] = v.clone();
        result["gate"] = v.clone();
    }
    if let Some(mode) = p.get("mode") {
        result["answer_mode"] = mode.clone();
    } else {
        result["coverage"].as_object_mut().unwrap().remove("view");
    }
    if let Some(reason) = reason {
        result["reason"] = reason.clone();
    }
    Ok(result)
}

pub fn parse_json(p: &Value) -> Result<Value> {
    let content = get(p, "content");
    ensure(content.is_string(), "Model response is not text")?;
    let text = s(content).trim_matches(js_ws);
    let fence=Regex::new(r"(?is)^```(?:json)?[\t\n\r\x0b\x0c \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*\n(.*?)\n```$").unwrap();
    let raw = fence
        .captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str())
        .unwrap_or(text);
    let parsed = if let Some(decoded) = p.get("decoded") {
        decoded.clone()
    } else {
        serde_json::from_str(raw).map_err(|e| {
            error(
                "ANSWER_JSON_SYNTAX_INVALID",
                format!("模型JSON语法无效：{e}"),
            )
        })?
    };
    let chars: Vec<char> = raw.chars().collect();
    let mut stack: Vec<Option<HashSet<String>>> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '"' => {
                let start = i;
                i += 1;
                while i < chars.len() {
                    if chars[i] == '\\' {
                        i += 2;
                        continue;
                    }
                    if chars[i] == '"' {
                        break;
                    }
                    i += 1;
                }
                let mut j = i + 1;
                while j < chars.len() && js_ws(chars[j]) {
                    j += 1;
                }
                if j < chars.len() && chars[j] == ':' {
                    let token: String = chars[start..(i + 1).min(chars.len())].iter().collect();
                    let key: String =
                        serde_json::from_str(&token).map_err(|_| fail("JSON对象结构无效"))?;
                    let keys = stack
                        .last_mut()
                        .and_then(Option::as_mut)
                        .ok_or_else(|| fail("JSON对象结构无效"))?;
                    ensure(!keys.contains(&key),format!("JSON对象存在重复字段：{key}；多段正文必须使用独立数组对象，不能覆盖已有字段"))?;
                    keys.insert(key);
                }
            }
            '{' => stack.push(Some(HashSet::new())),
            '[' => stack.push(None),
            '}' | ']' => {
                stack.pop();
            }
            _ => {}
        }
        i += 1;
    }
    Ok(parsed)
}

pub fn execute(op: &str, p: &Value) -> Result<Value> {
    match op {
        "build_evidence" => build_evidence(get(p, "job"), get(p, "claims")),
        "validate" => validate(get(p, "raw"), get(p, "index"), get(p, "gate")),
        "validate_review" => validate_review(get(p, "review"), get(p, "draft")),
        "finish" => finish(p),
        "source_draft" => Ok(source_draft(get(p, "index"), get(p, "gate"))),
        "parse_json" => parse_json(p),
        _ => Err(error(
            "CORE_OPERATION_UNKNOWN",
            format!("未知回答操作：{op}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frozen_js_answer_contract_vectors() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../../../fixtures/core-migration-v0.1/answer-differential.json"
        ))
        .unwrap();
        let mut failures = Vec::new();
        for vector in a(&corpus["vectors"]) {
            let result = execute(s(&vector["operation"]), &vector["payload"]);
            match (vector["expected"]["ok"].as_bool().unwrap(), result) {
                (true, Ok(actual)) => {
                    if js_stringify(&canonical(&actual))
                        != js_stringify(&canonical(&vector["expected"]["value"]))
                    {
                        failures.push(format!("{}: output mismatch", vector["id"]));
                    }
                }
                (false, Err(error)) => {
                    if error.message != vector["expected"]["error"].as_str().unwrap() {
                        failures.push(format!(
                            "{}: unexpected error {}",
                            vector["id"], error.message
                        ));
                    }
                }
                (_, actual) => failures.push(format!("{}: unexpected {:?}", vector["id"], actual)),
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }
}
