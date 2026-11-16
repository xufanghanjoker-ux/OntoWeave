//! M5: additive invariants and published-work decisions. Storage remains a host adapter.
use crate::common::*;
use crate::retrieval::extraction_units;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
fn get<'a>(v: &'a Value, k: &str) -> &'a Value {
    v.get(k).unwrap_or(&Value::Null)
}
fn num(v: &Value, default: usize) -> usize {
    v.as_u64().map(|n| n as usize).unwrap_or(default)
}
fn deep_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).map(|w| deep_equal(v, w)).unwrap_or(false))
        }
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(v, w)| deep_equal(v, w))
        }
        (Value::Number(x), Value::Number(y)) => {
            x.as_f64() == y.as_f64()
                && !(x.as_f64() == Some(0.0)
                    && x.as_f64().unwrap().is_sign_negative()
                        != y.as_f64().unwrap().is_sign_negative())
        }
        _ => a == b,
    }
}
fn regex(p: &str) -> Regex {
    Regex::new(p).expect("frozen regex")
}
fn fields(v: &Value) -> Vec<String> {
    v.as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default()
}

pub fn validate_extension(schema: &Value, previous: &Value, options: &Value) -> Result<Value> {
    ensure(
        a(get(previous, "structural_predicate_ids"))
            .iter()
            .all(|id| a(get(schema, "structural_predicate_ids")).contains(id)),
        "持续学习不能撤下已发布结构谓词索引",
    )?;
    for field in ["entity_types", "entities", "predicates", "cq_plans"] {
        let key = if field == "cq_plans" { "cq_id" } else { "id" };
        for old in a(get(previous, field)) {
            let candidate = a(get(schema, field))
                .iter()
                .find(|row| get(row, key) == get(old, key));
            if field == "cq_plans"
                && s(get(old, "template")) == "UNKNOWN"
                && a(get(options, "resolvableIds")).contains(get(old, "cq_id"))
                && candidate.is_some()
            {
                continue;
            }
            let changed = if let Some(candidate) = candidate {
                let mut keys = fields(old);
                for k in fields(candidate) {
                    if !keys.contains(&k) {
                        keys.push(k);
                    }
                }
                keys.into_iter()
                    .filter(|k| {
                        old.get(k) != candidate.get(k)
                            && !match (old.get(k), candidate.get(k)) {
                                (Some(x), Some(y)) => deep_equal(x, y),
                                _ => false,
                            }
                    })
                    .collect::<Vec<_>>()
            } else {
                vec!["MISSING".into()]
            };
            ensure(candidate.map(|c|deep_equal(c,old)).unwrap_or(false),format!("持续学习不能静默改写已有{}，需独立修订流程；{} 差异字段：{}。本次只追加，请逐字保留旧对象，包括reason等说明字段。",field,s(get(old,key)),changed.join(",")))?;
        }
    }
    Ok(schema.clone())
}

pub fn simple_attribute_extension(
    schema: &Value,
    extension: &Value,
    requirements: &[Value],
) -> bool {
    if extension.is_null()
        || !a(get(extension, "changedSourceIds")).is_empty()
        || requirements.is_empty()
        || !requirements
            .iter()
            .all(|r| s(get(r, "mode")) == "ATTRIBUTE")
    {
        return false;
    }
    let previous = get(extension, "schema");
    if !deep_equal(get(schema, "entity_types"), get(previous, "entity_types"))
        || !deep_equal(get(schema, "entities"), get(previous, "entities"))
    {
        return false;
    }
    if validate_extension(
        schema,
        previous,
        &json!({"resolvableIds":get(extension,"resolvableIds")}),
    )
    .is_err()
    {
        return false;
    }
    let added: Vec<&Value> = a(get(schema, "predicates"))
        .iter()
        .filter(|p| {
            !a(get(previous, "predicates"))
                .iter()
                .any(|old| get(old, "id") == get(p, "id"))
        })
        .collect();
    if added.is_empty()
        || !added.iter().all(|p| {
            s(get(p, "value_type")) == "STRING"
                && s(get(p, "cardinality")) == "MANY"
                && !truthy(get(p, "structural"))
        })
    {
        return false;
    }
    let plans: Vec<&Value> = a(get(schema, "cq_plans"))
        .iter()
        .filter(|p| {
            !a(get(previous, "cq_plans"))
                .iter()
                .any(|old| get(old, "cq_id") == get(p, "cq_id"))
        })
        .collect();
    !plans.is_empty()
        && plans.iter().all(|p| {
            s(get(p, "template")) == "FACTS"
                && added.iter().any(|a| get(a, "id") == get(p, "predicate_id"))
                && a(get(schema, "entities"))
                    .iter()
                    .any(|e| get(e, "id") == get(p, "subject_id"))
                && p.get("object_value") == Some(&Value::Null)
        })
}
pub fn evidence_units(units: &[Value], evidence: &Value, sources: &[Value]) -> Result<Value> {
    ensure(
        evidence.is_array() && !a(evidence).is_empty(),
        "定向学习需要有效准入证据",
    )?;
    for e in a(evidence) {
        let source = sources.iter().find(|s| get(s, "id") == get(e, "source_id"));
        ensure(
            source
                .map(|source| {
                    get(source, "sha256") == get(e, "source_sha256")
                        && get(e, "start").as_u64().is_some()
                        && get(e, "end").as_u64().is_some()
                        && num(get(e, "end"), 0) > num(get(e, "start"), 0)
                        && slice16(
                            s(get(source, "content")),
                            num(get(e, "start"), 0),
                            num(get(e, "end"), 0),
                        ) == s(get(e, "quote"))
                })
                .unwrap_or(false),
            "定向学习的准入证据已失效",
        )?;
    }
    let selected: Vec<Value> = units
        .iter()
        .filter(|u| {
            a(evidence).iter().any(|e| {
                get(e, "source_id") == get(u, "source_id")
                    && num(get(e, "start"), 0) < num(get(u, "end"), 0)
                    && num(get(e, "end"), 0) > num(get(u, "start"), 0)
            })
        })
        .cloned()
        .collect();
    ensure(!selected.is_empty(), "准入证据没有对应资料窗口")?;
    Ok(json!(selected))
}
pub fn extension_extraction_schema(schema: &Value, previous: &Value, options: &Value) -> Value {
    let old: Vec<&Value> = a(get(previous, "predicates"))
        .iter()
        .map(|p| get(p, "id"))
        .collect();
    let targets = a(get(options, "targetPredicateIds"));
    let predicates: Vec<Value> = a(get(schema, "predicates"))
        .iter()
        .filter(|p| !old.contains(&get(p, "id")) || targets.contains(get(p, "id")))
        .cloned()
        .collect();
    let subjects: Vec<Value> = a(get(schema, "entities"))
        .iter()
        .filter(|e| {
            !a(get(previous, "entities"))
                .iter()
                .any(|old| get(old, "id") == get(e, "id"))
        })
        .map(|e| get(e, "id").clone())
        .collect();
    let mut result = schema.clone();
    result["predicates"] = if !predicates.is_empty() {
        json!(predicates)
    } else if !subjects.is_empty() {
        get(schema, "predicates").clone()
    } else {
        json!([])
    };
    json!({"schema":result,"new_subject_ids":subjects})
}
pub fn select_units(units: &[Value], question: &str) -> Value {
    let mut tokens: Vec<Vec<u16>> = Vec::new();
    for m in regex(r"[A-Za-z0-9_-]{2,}").find_iter(question) {
        let token = m.as_str().to_lowercase().encode_utf16().collect::<Vec<_>>();
        if !tokens.contains(&token) {
            tokens.push(token);
        }
    }
    // Frozen JS quirk: iteration count uses code points, but substring slicing uses
    // UTF16 offsets. Keep partial-surrogate tokens as u16, not replacement chars.
    for m in regex(r"\p{Script=Han}{2,}").find_iter(question) {
        let chars = m.as_str().chars().count();
        let raw: Vec<u16> = m.as_str().encode_utf16().collect();
        for i in 0..chars.saturating_sub(1) {
            let token = raw[i.min(raw.len())..(i + 2).min(raw.len())].to_vec();
            if !tokens.contains(&token) {
                tokens.push(token);
            }
        }
    }
    let matches = |u: &Value| {
        let text: Vec<u16> = s(get(u, "text")).to_lowercase().encode_utf16().collect();
        tokens
            .iter()
            .any(|token| token.is_empty() || text.windows(token.len()).any(|part| part == token))
    };
    let mut result: Vec<Value> = units.iter().filter(|u| matches(u)).cloned().collect();
    result.extend(units.iter().filter(|u| !matches(u)).cloned());
    json!(result)
}
pub fn additive_review_selection(claims: &[Value], retained: &[Value]) -> Result<Value> {
    let mut frozen: HashMap<String, &Value> = HashMap::new();
    for c in retained {
        frozen.insert(js_stringify(get(c, "id")), c);
    }
    let mut indices = Vec::new();
    for (i, c) in claims.iter().enumerate() {
        if let Some(old) = frozen.get(&js_stringify(get(c, "id"))) {
            ensure(deep_equal(c, old), "新增学习不得改写已发布声明")?;
        } else {
            indices.push(i);
        }
    }
    ensure(
        frozen
            .keys()
            .all(|id| claims.iter().any(|c| js_stringify(get(c, "id")) == *id)),
        "新增学习不得丢失已发布声明",
    )?;
    Ok(
        json!({"claims":indices.iter().map(|i|claims[*i].clone()).collect::<Vec<_>>(),"indices":indices}),
    )
}

pub fn extraction_dimension(p: &Value) -> Value {
    let schema = get(p, "schema");
    let mut plans: Vec<Value> = a(get(p, "cqs"))
        .iter()
        .filter_map(|q| {
            a(get(schema, "cq_plans"))
                .iter()
                .find(|plan| get(plan, "cq_id") == get(q, "id"))
        })
        .map(|p| {
            let mut p = p.clone();
            p.as_object_mut().unwrap().remove("cq_id");
            p.as_object_mut().unwrap().remove("reason");
            p
        })
        .collect();
    plans.sort_by(|a, b| locale_cmp(&js_stringify(a), &js_stringify(b)));
    let mut entities = a(get(schema, "entities")).to_vec();
    let mut types = a(get(schema, "entity_types")).to_vec();
    let mut predicates = a(get(get(p, "extractionSchema"), "predicates")).to_vec();
    for items in [&mut entities, &mut types, &mut predicates] {
        items.sort_by(|a, b| locale_cmp(s(get(a, "id")), s(get(b, "id"))));
    }
    let mut body = Map::new();
    body.insert("version".into(), json!("extraction_dimension_v1"));
    if let Some(contract) = p.get("contract") {
        body.insert("contract".into(), contract.clone());
    }
    body.insert(
        "definitions".into(),
        p.get("definitions").cloned().unwrap_or(json!("")),
    );
    body.insert(
        "as_of".into(),
        p.get("as_of").cloned().unwrap_or(Value::Null),
    );
    body.insert("entities".into(), json!(entities));
    body.insert("types".into(), json!(types));
    body.insert("predicates".into(), json!(predicates));
    body.insert("plans".into(), json!(plans));
    json!(canonical_hash(&Value::Object(body)))
}
fn ledger_key(base: &Value, dimension: &Value, unit: &Value) -> String {
    format!(
        "work_{}",
        &canonical_hash(&json!([
            base,
            dimension,
            get(unit, "id"),
            get(unit, "source_sha256"),
            if truthy(get(unit, "layout_hash")) {
                get(unit, "layout_hash")
            } else {
                &Value::Null
            }
        ]))[..32]
    )
}
pub fn ledger_lookup(p: &Value) -> Value {
    let row = get(p, "row");
    let unit = get(p, "unit");
    let dimension = get(p, "dimension");
    let base = get(p, "base_id");
    let id = ledger_key(base, dimension, unit);
    if row.is_null()
        || s(get(row, "id")) != id
        || get(row, "base_id") != base
        || get(row, "dimension") != dimension
        || get(row, "unit_id") != get(unit, "id")
        || get(row, "source_sha256") != get(unit, "source_sha256")
        || s(get(row, "status")) != "PUBLISHED_CHECKED"
        || !get(row, "claims").is_array()
    {
        return Value::Null;
    }
    let mut body = row.clone();
    body.as_object_mut().unwrap().remove("receipt_hash");
    if s(get(row, "receipt_hash")) != canonical_hash(&body) {
        return Value::Null;
    }
    let mut retained = HashMap::new();
    for c in a(get(p, "retained")) {
        retained.insert(js_stringify(get(c, "id")), c);
    }
    if a(get(row, "claims")).iter().all(|c| {
        retained
            .get(&js_stringify(get(c, "id")))
            .map(|x| canonical_hash(x) == s(get(c, "hash")))
            .unwrap_or(false)
    }) {
        row.clone()
    } else {
        Value::Null
    }
}
pub fn ledger_commit(p: &Value) -> Result<Value> {
    let job = get(p, "job");
    let work = get(get(job, "result"), "incremental_work");
    if !truthy(get(p, "published"))
        || s(get(job, "status")) != "READY"
        || work.is_null()
        || s(get(get(get(job, "result"), "gate"), "action")) != "ACCEPT_CANDIDATE"
    {
        return Ok(json!({"writes":[]}));
    }
    let sources = a(get(get(job, "input"), "sources"));
    let units = extraction_units(sources, &Value::Null)?;
    let mut writes = Vec::new();
    for id in a(get(work, "checked_unit_ids")) {
        let Some(raw) = units.iter().find(|u| get(u, "id") == id) else {
            continue;
        };
        let source = sources
            .iter()
            .find(|source| get(source, "id") == get(raw, "source_id"))
            .ok_or_else(|| fail("处理收据来源不存在"))?;
        let mut unit = raw.clone();
        unit["layout_hash"] = if truthy(get(source, "parsing")) {
            json!(sha(&json!(a(get(get(source, "parsing"), "blocks")))))
        } else {
            Value::Null
        };
        let claims: Vec<Value> = a(get(get(job, "result"), "claims"))
            .iter()
            .filter(|c| {
                a(get(work, "predicate_ids")).contains(get(c, "predicate_id"))
                    && get(c, "source_id") == get(&unit, "source_id")
                    && num(get(c, "start"), 0) < num(get(&unit, "end"), 0)
                    && num(get(c, "end"), 0) > num(get(&unit, "start"), 0)
            })
            .map(|c| json!({"id":get(c,"id"),"hash":canonical_hash(c)}))
            .collect();
        let id = ledger_key(get(p, "base_id"), get(work, "dimension"), &unit);
        let mut receipt = json!({"id":id,"base_id":get(p,"base_id"),"dimension":get(work,"dimension"),"unit_id":get(&unit,"id"),"source_id":get(&unit,"source_id"),"source_sha256":get(&unit,"source_sha256"),"status":"PUBLISHED_CHECKED","task_id":get(job,"id"),"claims":claims});
        let h = canonical_hash(&receipt);
        receipt["receipt_hash"] = json!(h);
        writes.push(json!({"kind":"learning_processed_dimension","id":id,"value":receipt}));
    }
    Ok(json!({"writes":writes}))
}

pub fn resolve_holds(p: &Value) -> Value {
    let job = get(p, "job");
    let empty = || json!({"resolved":[],"writes":[]});
    if s(get(job, "status")) != "READY"
        || s(get(get(get(job, "result"), "gate"), "action")) != "ACCEPT_CANDIDATE"
        || !truthy(get(job, "learning"))
    {
        return empty();
    }
    let published = a(get(p, "library_candidates"))
        .iter()
        .find(|r| get(r, "task_id") == get(job, "id"));
    let Some(published) = published else {
        return empty();
    };
    let state = a(get(p, "library_states"))
        .iter()
        .find(|r| get(r, "id") == get(published, "base_id"));
    let Some(state) = state else {
        return empty();
    };
    if s(get(published, "status")) != "PUBLISHED" || get(state, "head_task_id") != get(job, "id") {
        return empty();
    }
    let tasks = a(get(p, "tasks"));
    let mut ancestry = HashSet::from([js_stringify(get(job, "id"))]);
    let mut parent = get(get(job, "revision"), "parent_id").clone();
    while truthy(&parent) && !ancestry.contains(&js_stringify(&parent)) {
        ancestry.insert(js_stringify(&parent));
        parent = tasks
            .iter()
            .find(|t| get(t, "id") == &parent)
            .map(|t| get(get(t, "revision"), "parent_id").clone())
            .unwrap_or(Value::Null);
    }
    let mut resolved = Vec::new();
    let mut writes = Vec::new();
    for hold in a(get(p, "holds")) {
        if s(get(hold, "status")) == "RESOLVED"
            || get(hold, "base_id") != get(published, "base_id")
            || get(hold, "source_epoch") != get(state, "source_epoch")
        {
            continue;
        }
        let origin_id = if truthy(get(get(hold, "manifest"), "origin_task_id")) {
            get(get(hold, "manifest"), "origin_task_id")
        } else {
            get(hold, "id")
        };
        let Some(origin) = tasks.iter().find(|t| get(t, "id") == origin_id) else {
            continue;
        };
        let learning = get(origin, "learning");
        if !truthy(learning)
            || truthy(get(origin, "human_review"))
            || truthy(get(origin, "component_submission"))
            || get(learning, "observation_id") != get(get(job, "learning"), "observation_id")
            || get(learning, "base_task_id") != get(get(job, "learning"), "base_task_id")
            || !deep_equal(get(origin, "input"), get(job, "input"))
        {
            continue;
        }
        let issues = a(get(get(get(origin, "result"), "gate"), "issues"));
        let technical = !issues.is_empty()
            && issues
                .iter()
                .all(|i| s(get(i, "resolution")) == "AUTO_REVISE");
        let rechecked = !issues.is_empty()
            && issues
                .iter()
                .all(|i| matches!(s(get(i, "resolution")), "AUTO_REVISE" | "NEEDS_USER"))
            && a(get(p, "review_contract_rechecks")).iter().any(|r| {
                get(r, "parent_id") == get(origin, "id")
                    && ancestry.contains(&js_stringify(get(r, "task_id")))
            });
        if !technical && !rechecked {
            continue;
        }
        let mut value = hold.clone();
        value["status"] = json!("RESOLVED");
        value["resolved_by"] = get(job, "id").clone();
        value["resolution"] = json!(if technical {
            "SUPERSEDED_BY_REVALIDATED_LEARNING"
        } else {
            "SUPERSEDED_BY_PUBLISHED_CONTRACT_RECHECK"
        });
        writes.push(json!({"kind":"component_hold","id":get(hold,"id"),"value":value}));
        resolved.push(get(hold, "id").clone());
    }
    json!({"resolved":resolved,"writes":writes})
}

pub fn execute(op: &str, p: &Value) -> Result<Value> {
    match op {
        "validate_extension" => {
            validate_extension(get(p, "schema"), get(p, "previous"), get(p, "options"))
        }
        "simple_attribute_extension" => Ok(json!(simple_attribute_extension(
            get(p, "schema"),
            get(p, "extension"),
            a(get(p, "requirements"))
        ))),
        "extension_extraction_schema" => Ok(extension_extraction_schema(
            get(p, "schema"),
            get(p, "previous"),
            get(p, "options"),
        )),
        "select_units" | "select_learning_units" => {
            Ok(select_units(a(get(p, "units")), s(get(p, "question"))))
        }
        "evidence_units" | "evidence_learning_units" => {
            evidence_units(a(get(p, "units")), get(p, "evidence"), a(get(p, "sources")))
        }
        "additive_review_selection" => {
            additive_review_selection(a(get(p, "claims")), a(get(p, "retained")))
        }
        "dimension" | "extraction_dimension" => Ok(extraction_dimension(p)),
        "ledger.key" => Ok(json!(ledger_key(
            get(p, "base_id"),
            get(p, "dimension"),
            get(p, "unit")
        ))),
        "ledger.lookup" => Ok(ledger_lookup(p)),
        "ledger.commit" => ledger_commit(p),
        "resolve_holds" | "resolve_learning_holds" => Ok(resolve_holds(p)),
        _ => Err(error("CORE_OPERATION_UNKNOWN", format!("未知M5操作：{op}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_objects_ignore_key_order_but_not_field_changes() {
        let old = json!({"entity_types":[{"id":"t","label":"类型"}],"entities":[],"predicates":[],"cq_plans":[]});
        let mut next = old.clone();
        let entry = serde_json::from_str::<Value>(r#"{"label":"类型","id":"t"}"#).unwrap();
        next["entity_types"][0] = entry;
        assert!(validate_extension(&next, &old, &Value::Null).is_ok());
        next["entity_types"][0]["label"] = json!("改写");
        assert!(validate_extension(&next, &old, &Value::Null).is_err());
    }
    #[test]
    fn frozen_claims_cannot_be_modified_or_dropped() {
        let old = json!({"id":"c","value":"原值","quote":"原文"});
        assert!(additive_review_selection(&[], &[old.clone()]).is_err());
        let mut altered = old.clone();
        altered["value"] = json!("改值");
        assert!(additive_review_selection(&[altered], &[old.clone()]).is_err());
        let out =
            additive_review_selection(&[old.clone(), json!({"id":"n","value":"新增"})], &[old])
                .unwrap();
        assert_eq!(out["indices"], json!([1]));
    }
    #[test]
    fn selection_retains_nonmatching_units() {
        let units = vec![
            json!({"id":"first","text":"无关"}),
            json!({"id":"second","text":"Agent主体"}),
        ];
        let out = select_units(&units, "Agent是什么");
        assert_eq!(out[0]["id"], "second");
        assert_eq!(out[1]["id"], "first");
    }
}
