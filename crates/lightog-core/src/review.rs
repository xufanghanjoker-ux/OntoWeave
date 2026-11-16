//! Frozen M6 review-envelope algorithms. No model, runner attestation, or storage access.
use crate::common::{a, canonical_hash, error, s, text_sha, truthy, Result};
use serde_json::{json, Value};
use std::collections::HashSet;

const DIMS: [&str; 6] = [
    "CQ_COVERAGE",
    "SOURCE_SUPPORT",
    "ENTITY_SCOPE",
    "QUALIFIERS",
    "CONFLICT_LOGIC",
    "AUTHORITY_BOUNDARY",
];
const CODES: [&str; 14] = [
    "QUANTIFIER_LOSS",
    "SCOPE_LEAK",
    "DOCUMENT_SUBJECT_MISMATCH",
    "CONFIGURATION_MIX",
    "UNIT_ASSUMPTION",
    "FALSE_CONFLICT",
    "DUPLICATE_CORROBORATION",
    "SOURCE_PROMOTION",
    "UNTRUSTED_INSTRUCTION",
    "CQ_UNCOVERED",
    "MISSING_EVIDENCE",
    "BUSINESS_DEFINITION",
    "ENTITY_MERGE",
    "AUTHORIZATION",
];
fn obj(v: &Value) -> bool {
    v.is_object()
}
fn nonempty(v: &Value) -> bool {
    crate::common::nonempty(v)
}
fn allowed(code: &str, resolution: &str) -> bool {
    match code {
        "BUSINESS_DEFINITION" | "ENTITY_MERGE" | "AUTHORIZATION" => resolution == "NEEDS_USER",
        "CQ_UNCOVERED" | "MISSING_EVIDENCE" => {
            matches!(resolution, "AUTO_REVISE" | "WAIT_EVIDENCE")
        }
        x if CODES.contains(&x) => resolution == "AUTO_REVISE",
        _ => false,
    }
}
fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(x)) => x.clone(),
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
        Some(x) => crate::common::js_stringify(x),
    }
}
// JS Object.keys enumerates canonical array-index keys before the other insertion-ordered keys.
fn keys(v: &Value) -> Vec<String> {
    let Some(m) = v.as_object() else {
        return vec![];
    };
    let mut numeric = vec![];
    let mut other = vec![];
    for k in m.keys() {
        if let Ok(n) = k.parse::<u32>() {
            if n != u32::MAX && n.to_string() == *k {
                numeric.push((n, k.clone()));
                continue;
            }
        }
        other.push(k.clone());
    }
    numeric.sort_by_key(|p| p.0);
    numeric.into_iter().map(|p| p.1).chain(other).collect()
}
pub fn packet_hash(packet: &Value) -> String {
    canonical_hash(packet)
}
fn pointer_exists(root: &Value, pointer: &Value) -> bool {
    if !nonempty(pointer) || !s(pointer).starts_with('/') {
        return false;
    }
    let mut current = root.clone();
    for token in s(pointer)[1..].split('/') {
        let bytes = token.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'~' && (i + 1 == bytes.len() || !matches!(bytes[i + 1], b'0' | b'1')) {
                return false;
            }
            i += if bytes[i] == b'~' { 2 } else { 1 };
        }
        let key = token.replace("~1", "/").replace("~0", "~");
        current = match &current {
            Value::Object(m) => match m.get(&key) {
                Some(v) => v.clone(),
                None => return false,
            },
            Value::Array(xs) if key == "length" => json!(xs.len()),
            Value::Array(xs) => match key.parse::<usize>() {
                Ok(n) if n.to_string() == key && n < xs.len() => xs[n].clone(),
                _ => return false,
            },
            _ => return false,
        };
    }
    true
}
fn diag(code: &str, path: impl Into<String>, message: impl Into<String>) -> Value {
    json!({"code":code,"path":path.into(),"message":message.into(),"category":"SYSTEM_REVIEW_PROTOCOL_INVALID"})
}
fn ids(rows: &Value) -> Vec<Option<Value>> {
    a(rows).iter().map(|c| c.get("id").cloned()).collect()
}
fn contains(ids: &[Option<Value>], id: &Value) -> bool {
    ids.iter().any(|x| x.as_ref() == Some(id))
}
fn unique_count(ids: &[Option<Value>]) -> usize {
    let mut seen = vec![];
    for x in ids {
        if !seen.contains(x) {
            seen.push(x.clone());
        }
    }
    seen.len()
}

pub fn diagnose_review(packet: &Value, review: &Value) -> Vec<Value> {
    let mut ds = vec![];
    if !obj(review) {
        return vec![diag("REVIEW_NOT_OBJECT", "/", "评审响应必须是对象")];
    }
    if !obj(&review["coverage"]) {
        ds.push(diag("COVERAGE_MISSING", "/coverage", "缺少六维检查记录"));
    } else {
        for d in DIMS {
            if review["coverage"][d] != "CHECKED" {
                ds.push(diag(
                    "COVERAGE_NOT_CHECKED",
                    format!("/coverage/{d}"),
                    "该维度未完成检查",
                ));
            }
        }
    }
    if !review["issues"].is_array() {
        ds.push(diag("ISSUES_NOT_ARRAY", "/issues", "issues必须为数组"));
        return ds;
    }
    if !packet["cqs"].is_array() || !packet["evidence"].is_array() || !obj(&packet["proposal"]) {
        ds.push(diag(
            "PACKET_INVALID",
            "/packet",
            "评审包缺少问题、证据或提案",
        ));
        return ds;
    }
    let cqs = ids(&packet["cqs"]);
    let evidence = ids(&packet["evidence"]);
    if cqs.is_empty()
        || unique_count(&cqs) != cqs.len()
        || unique_count(&evidence) != evidence.len()
        || cqs
            .iter()
            .chain(&evidence)
            .any(|x| x.as_ref().is_none_or(|v| !nonempty(v)))
    {
        ds.push(diag(
            "PACKET_REFERENCE_IDS_INVALID",
            "/packet",
            "CQ和证据ID必须非空且各自唯一",
        ));
    }
    let mut seen: Vec<Value> = vec![];
    for (index, issue) in a(&review["issues"]).iter().enumerate() {
        let path = format!("/issues/{index}");
        if !obj(issue) {
            ds.push(diag("ISSUE_NOT_OBJECT", path, "问题条目必须为对象"));
            continue;
        }
        if !nonempty(&issue["issue_id"]) {
            ds.push(diag(
                "ISSUE_ID_MISSING",
                format!("{path}/issue_id"),
                "需要非空问题ID",
            ));
        } else if seen.contains(&issue["issue_id"]) {
            ds.push(diag(
                "ISSUE_ID_DUPLICATE",
                format!("{path}/issue_id"),
                "问题ID重复",
            ));
        }
        seen.push(issue["issue_id"].clone());
        let code = s(&issue["code"]);
        let known = CODES.contains(&code);
        if !known {
            ds.push(diag("ISSUE_CODE_UNKNOWN",format!("{path}/code"),format!("不支持的问题代码 {}；只能从以下问题代码选择：{}。coverage维度不是问题代码，不得将真实问题删除或改成正常观察来绕过校验。",js_string(issue.get("code")),CODES.join(", "))));
        }
        for field in ["explanation", "counterexample", "suggested_change"] {
            if !nonempty(&issue[field]) {
                ds.push(diag(
                    "ISSUE_TEXT_MISSING",
                    format!("{path}/{field}"),
                    "问题需要具体依据、反例和最小修订",
                ));
            }
        }
        if !pointer_exists(&packet["proposal"], &issue["target"]) {
            ds.push(diag(
                "TARGET_NOT_FOUND",
                format!("{path}/target"),
                "目标必须存在于proposal内部",
            ));
        }
        if !issue["cq_ids"].is_array() || a(&issue["cq_ids"]).is_empty() {
            ds.push(diag(
                "CQ_REFERENCE_MISSING",
                format!("{path}/cq_ids"),
                "问题必须关联至少一个CQ",
            ));
        } else if a(&issue["cq_ids"]).iter().any(|id| !contains(&cqs, id)) {
            ds.push(diag(
                "CQ_REFERENCE_UNKNOWN",
                format!("{path}/cq_ids"),
                "引用了不存在的CQ",
            ));
        }
        if !issue["evidence_ids"].is_array() {
            ds.push(diag(
                "EVIDENCE_REFERENCE_INVALID",
                format!("{path}/evidence_ids"),
                "证据引用必须是数组",
            ));
        } else if a(&issue["evidence_ids"])
            .iter()
            .any(|id| !contains(&evidence, id))
        {
            ds.push(diag(
                "EVIDENCE_REFERENCE_UNKNOWN",
                format!("{path}/evidence_ids"),
                "引用了不存在的证据",
            ));
        }
        let resolution = s(&issue["resolution"]);
        if !["AUTO_REVISE", "WAIT_EVIDENCE", "NEEDS_USER"].contains(&resolution) {
            ds.push(diag(
                "RESOLUTION_UNKNOWN",
                format!("{path}/resolution"),
                "不支持的处置方式",
            ));
        } else if known && !allowed(code, resolution) {
            ds.push(diag(
                "RESOLUTION_NOT_ALLOWED",
                format!("{path}/resolution"),
                "该问题代码不允许此处置方式",
            ));
        }
        if resolution == "AUTO_REVISE"
            && issue["evidence_ids"].is_array()
            && a(&issue["evidence_ids"]).is_empty()
            && code != "CQ_UNCOVERED"
        {
            ds.push(diag(
                "AUTO_REVISE_WITHOUT_EVIDENCE",
                format!("{path}/evidence_ids"),
                "自动语义修订需要已有证据；不猜测缺失事实",
            ));
        }
    }
    ds
}
fn decision(packet: &Value, review: &Value, action: &str, reason: &str, issues: Value) -> Value {
    let mut out = json!({"action":action,"reason":reason,"issues":issues,"independently_verified":false,"publication_approved":false});
    if action == "REVIEW_INCOMPLETE" {
        let ds = diagnose_review(packet, review);
        out["diagnostics"] = if ds.is_empty() {
            json!([diag(&reason.to_uppercase(), "/", reason)])
        } else {
            json!(ds)
        };
    }
    out
}
pub fn decide_review(
    packet: &Value,
    review: &Value,
    validation: &Value,
    execution: &Value,
) -> Value {
    let no = |action: &str, reason: &str| decision(packet, review, action, reason, json!([]));
    if !obj(packet) || !obj(validation) || !obj(execution) {
        return no("REVIEW_INCOMPLETE", "invalid_runner_envelope");
    }
    if !nonempty(&packet["packet_id"])
        || !obj(&packet["versions"])
        || ["schema", "sources", "cqs", "candidate"]
            .iter()
            .any(|k| !nonempty(&packet["versions"][*k]))
        || !obj(&packet["proposal"])
    {
        return no("REVIEW_INCOMPLETE", "invalid_packet_versions");
    }
    let binding = packet_hash(packet);
    if validation["packet_hash"] != binding || execution["packet_hash"] != binding {
        return no("REVIEW_INCOMPLETE", "stale_runner_binding");
    }
    if validation["status"] == "FAIL" {
        return no("REJECT", "deterministic_validation_failed");
    }
    if validation["status"] != "PASS" {
        return no("REVIEW_INCOMPLETE", "validation_not_completed");
    }
    if !obj(review)
        || !nonempty(&review["review_id"])
        || review["packet_id"] != packet["packet_id"]
        || review["packet_hash"] != binding
        || review["reviewer_run_id"] != execution["reviewer_run_id"]
        || [
            "reviewer_run_id",
            "reviewer_model",
            "reviewer_prompt_version",
            "independent_baseline_record_id",
            "builder_context_id",
            "reviewer_context_id",
        ]
        .iter()
        .any(|k| !nonempty(&execution[*k]))
        || execution["builder_context_id"] == execution["reviewer_context_id"]
        || execution["independent_baseline_completed"] != true
    {
        return no("REVIEW_INCOMPLETE", "invalid_or_nonindependent_review");
    }
    if !obj(&review["coverage"]) || DIMS.iter().any(|d| review["coverage"][*d] != "CHECKED") {
        return no("REVIEW_INCOMPLETE", "review_coverage_incomplete");
    }
    if !review["issues"].is_array()
        || !packet["cqs"].is_array()
        || a(&packet["cqs"]).is_empty()
        || !packet["evidence"].is_array()
    {
        return no("REVIEW_INCOMPLETE", "invalid_collections");
    }
    let cq_ids = ids(&packet["cqs"]);
    let evidence_ids = ids(&packet["evidence"]);
    if unique_count(&cq_ids) != cq_ids.len()
        || unique_count(&evidence_ids) != evidence_ids.len()
        || cq_ids
            .iter()
            .chain(&evidence_ids)
            .any(|x| x.as_ref().is_none_or(|v| !nonempty(v)))
    {
        return no("REVIEW_INCOMPLETE", "invalid_collection_ids");
    }
    let mut seen = vec![];
    for issue in a(&review["issues"]) {
        let code = s(&issue["code"]);
        let resolution = s(&issue["resolution"]);
        if !obj(issue)
            || !nonempty(&issue["issue_id"])
            || seen.contains(&issue["issue_id"])
            || !CODES.contains(&code)
            || ["explanation", "counterexample", "suggested_change"]
                .iter()
                .any(|k| !nonempty(&issue[*k]))
            || !pointer_exists(&packet["proposal"], &issue["target"])
            || !issue["cq_ids"].is_array()
            || a(&issue["cq_ids"]).is_empty()
            || a(&issue["cq_ids"]).iter().any(|id| !contains(&cq_ids, id))
            || !issue["evidence_ids"].is_array()
            || a(&issue["evidence_ids"])
                .iter()
                .any(|id| !contains(&evidence_ids, id))
            || !["AUTO_REVISE", "WAIT_EVIDENCE", "NEEDS_USER"].contains(&resolution)
        {
            return no("REVIEW_INCOMPLETE", "invalid_issue_reference");
        }
        if !allowed(code, resolution)
            || (resolution == "AUTO_REVISE"
                && a(&issue["evidence_ids"]).is_empty()
                && code != "CQ_UNCOVERED")
        {
            return no("REVIEW_INCOMPLETE", "invalid_resolution_policy");
        }
        seen.push(issue["issue_id"].clone());
    }
    for (resolution, action) in [
        ("NEEDS_USER", "NEEDS_USER"),
        ("WAIT_EVIDENCE", "WAIT_EVIDENCE"),
        ("AUTO_REVISE", "REQUEST_REVISION"),
    ] {
        if a(&review["issues"])
            .iter()
            .any(|i| i["resolution"] == resolution)
        {
            return decision(
                packet,
                review,
                action,
                "open_review_issues",
                review["issues"].clone(),
            );
        }
    }
    no("ACCEPT_CANDIDATE", "checked_candidate_only")
}
fn escape(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}
pub fn review_targets(proposal: &Value) -> Vec<Value> {
    fn visit(v: &Value, pointer: String, key: String, out: &mut Vec<Value>) {
        let kind = if v.is_array() {
            "COLLECTION"
        } else if v.is_object() {
            "OBJECT"
        } else {
            "FIELD"
        };
        let label = if v.is_object() {
            ["id", "cq_id", "name"]
                .iter()
                .find_map(|k| v.get(*k).filter(|x| truthy(x)))
                .cloned()
                .unwrap_or_else(|| json!(key))
        } else {
            json!(key)
        };
        let id = format!("target_{}", &text_sha(&pointer)[..16]);
        let mut row = json!({"ref":id,"target_ref":id,"pointer":pointer,"kind":kind,"label":label});
        if v.is_object() {
            row["fields"] = json!(keys(v));
        }
        out.push(row);
        if let Some(xs) = v.as_array() {
            for (i, x) in xs.iter().enumerate() {
                visit(x, format!("{pointer}/{i}"), i.to_string(), out);
            }
        } else if v.is_object() {
            for field in keys(v) {
                let x = &v[&field];
                if x.is_object()
                    || x.is_array()
                    || [
                        "value",
                        "template",
                        "predicate_id",
                        "subject_id",
                        "object_value",
                        "cardinality",
                        "scope",
                        "unit",
                        "modality",
                        "effective_from",
                        "comparator",
                    ]
                    .contains(&field.as_str())
                {
                    visit(x, format!("{pointer}/{}", escape(&field)), field, out);
                }
            }
        }
    }
    let mut out = vec![];
    if !proposal.is_object() {
        return out;
    }
    for k in keys(proposal) {
        visit(&proposal[&k], format!("/{}", escape(&k)), k, &mut out);
    }
    out
}
pub fn compile_review(packet: &Value, raw: &Value, quarantine: bool) -> Value {
    if !obj(raw) {
        return json!({"review":{"coverage":{},"issues":[],"observations":[]},"diagnostics":[diag("REVIEW_NOT_OBJECT","/","评审必须返回JSON对象")],"valid":false});
    }
    let targets = review_targets(&packet["proposal"]);
    let lookup = |r: &Value| targets.iter().find(|t| &t["ref"] == r);
    let mut ds = vec![];
    let mut issues = raw.get("issues").cloned();
    if let Some(Value::Array(xs)) = &mut issues {
        for (index, issue) in xs.iter_mut().enumerate() {
            if !obj(issue) {
                continue;
            }
            let path = format!("/issues/{index}");
            if let Some(r) = issue.get("target_ref") {
                if let Some(target) = lookup(r) {
                    if let Some(p) = issue.get("target") {
                        if p != &target["pointer"] {
                            ds.push(diag(
                                "TARGET_REF_POINTER_MISMATCH",
                                format!("{path}/target"),
                                "target_ref与旧target不一致",
                            ));
                        }
                    }
                    issue["target"] = target["pointer"].clone();
                } else {
                    ds.push(diag(
                        "TARGET_REF_UNKNOWN",
                        format!("{path}/target_ref"),
                        "必须选择目标菜单中的target_ref",
                    ));
                }
                if issue["finding"] != "VIOLATION" {
                    ds.push(diag(
                        "ISSUE_NOT_VIOLATION",
                        format!("{path}/finding"),
                        "issues只能报告VIOLATION；正常限制和注意事项放observations",
                    ));
                }
                for field in ["actual", "expected"] {
                    if !nonempty(&issue[field]) {
                        ds.push(diag(
                            "VIOLATION_DETAIL_MISSING",
                            format!("{path}/{field}"),
                            "需要明确实际错误与应有行为",
                        ));
                    }
                }
            }
            if issue.get("finding").is_some() && issue["finding"] != "VIOLATION" {
                ds.push(diag(
                    "ISSUE_SELF_CONTRADICTION",
                    format!("{path}/finding"),
                    "问题条目承认其不是错误，必须重新评审而非静默删除",
                ));
            }
            if nonempty(&issue["actual"])
                && nonempty(&issue["expected"])
                && s(&issue["actual"]).trim_matches(crate::common::js_ws)
                    == s(&issue["expected"]).trim_matches(crate::common::js_ws)
            {
                ds.push(diag(
                    "ISSUE_SELF_CONTRADICTION",
                    path,
                    "实际行为与预期相同，不能作为阻塞问题直接通过",
                ));
            }
        }
    }
    if packet["proposal"]["review_scope"]["mode"] == "CLAIM_BATCH_NOT_ENTIRE_KNOWLEDGE_BASE" {
        for (index, issue) in issues.as_ref().map(a).unwrap_or(&[]).iter().enumerate() {
            if issue["code"] == "CQ_UNCOVERED" {
                ds.push(diag("CLAIM_BATCH_GLOBAL_COVERAGE_OUT_OF_SCOPE",format!("/issues/{index}"),"分批声明评审无权要求本批覆盖所有CQ；请检查global_coverage，真实声明错误使用对应支持性代码"));
            }
            if issue["code"] == "DUPLICATE_CORROBORATION"
                && packet["proposal"]["review_scope"]["independent_corroboration_asserted"] == false
            {
                ds.push(diag("CORROBORATION_NOT_ASSERTED",format!("/issues/{index}"),"提案没有独立佐证或置信度聚合断言，不能仅因同来源声明重复而报该违例；语义重复可放observations"));
            }
        }
    }
    let observations = raw.get("observations").cloned().unwrap_or(json!([]));
    if !observations.is_array() {
        ds.push(diag(
            "OBSERVATIONS_NOT_ARRAY",
            "/observations",
            "非阻塞观察必须为数组",
        ));
    } else {
        for (index, observation) in a(&observations).iter().enumerate() {
            let path = format!("/observations/{index}");
            if !obj(observation) || !nonempty(&observation["text"]) {
                ds.push(diag("OBSERVATION_INVALID", path, "观察需要非空text"));
                continue;
            }
            if observation.get("target_ref").is_some()
                && lookup(&observation["target_ref"]).is_none()
            {
                ds.push(diag(
                    "OBSERVATION_TARGET_UNKNOWN",
                    format!("{path}/target_ref"),
                    "观察目标不存在",
                ));
            }
            for (field, values) in [
                ("cq_ids", ids(&packet["cqs"])),
                ("evidence_ids", ids(&packet["evidence"])),
            ] {
                if let Some(v) = observation.get(field) {
                    if !v.is_array() || a(v).iter().any(|id| !contains(&values, id)) {
                        ds.push(diag(
                            "OBSERVATION_REFERENCE_UNKNOWN",
                            format!("{path}/{field}"),
                            "观察引用必须来自评审包",
                        ));
                    }
                }
            }
        }
    }
    let invalid = if quarantine && observations.is_array() {
        let mut seen = HashSet::new();
        let mut v = vec![];
        for d in &ds {
            if matches!(
                s(&d["code"]),
                "OBSERVATION_REFERENCE_UNKNOWN" | "OBSERVATION_TARGET_UNKNOWN"
            ) {
                if let Some(i) = s(&d["path"])
                    .split('/')
                    .nth(2)
                    .and_then(|x| x.parse::<usize>().ok())
                {
                    if seen.insert(i) {
                        v.push(i);
                    }
                }
            }
        }
        v
    } else {
        vec![]
    };
    let quarantined:Vec<Value>=invalid.iter().map(|i|json!({"index":i,"observation":observations[*i],"diagnostics":ds.iter().filter(|d|s(&d["path"]).starts_with(&format!("/observations/{i}/"))).cloned().collect::<Vec<_>>()})).collect();
    if quarantine && observations.is_array() {
        ds.retain(|d| {
            !matches!(
                s(&d["code"]),
                "OBSERVATION_REFERENCE_UNKNOWN" | "OBSERVATION_TARGET_UNKNOWN"
            )
        });
    }
    let obs = if observations.is_array() {
        json!(a(&observations)
            .iter()
            .enumerate()
            .filter(|(i, _)| !invalid.contains(i))
            .map(|(_, v)| v.clone())
            .collect::<Vec<_>>())
    } else {
        observations
    };
    let coverage = raw
        .get("coverage")
        .filter(|x| truthy(x))
        .cloned()
        .unwrap_or(json!({}));
    let mut review = json!({"coverage":coverage});
    if let Some(v) = issues {
        review["issues"] = v;
    }
    review["observations"] = obs;
    ds.extend(diagnose_review(packet, &review));
    json!({"review":review,"diagnostics":ds,"quarantined_observations":quarantined,"valid":ds.is_empty()})
}

fn split_pair(t: &[u16], i: usize) -> bool {
    i > 0
        && i < t.len()
        && (0xD800..=0xDBFF).contains(&t[i - 1])
        && (0xDC00..=0xDFFF).contains(&t[i])
}
fn merge_ranges(mut rs: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    rs.retain(|(a, b)| b > a);
    rs.sort_by_key(|r| r.0);
    let mut out: Vec<(usize, usize)> = vec![];
    for (a, b) in rs {
        if let Some(last) = out.last_mut() {
            if a <= last.1 {
                last.1 = last.1.max(b);
                continue;
            }
        }
        out.push((a, b));
    }
    out
}
pub fn source_preview(source: &Value, claim: &Value, options: &Value) -> Value {
    use crate::common::{js_ws, len, slice16};
    let text = s(&source["content"]);
    let units: Vec<u16> = text.encode_utf16().collect();
    let quote = s(&claim["quote"]);
    // JSON transport cannot represent an isolated UTF16 surrogate as a Rust string.
    // The host encodes only such source-preview quote strings with this reserved tag;
    // all position, source, equality and split-pair checks still happen here in order.
    let transported_quote = claim["quote"]
        .as_object()
        .filter(|m| m.len() == 1)
        .and_then(|m| m.get("$lightog_utf16_v1"))
        .and_then(Value::as_array)
        .and_then(|rows| {
            rows.iter()
                .map(|v| {
                    v.as_u64()
                        .filter(|n| *n <= u16::MAX as u64)
                        .map(|n| n as u16)
                })
                .collect::<Option<Vec<_>>>()
        })
        .filter(|units| String::from_utf16(units).is_err());
    let quote_units = transported_quote
        .clone()
        .unwrap_or_else(|| quote.encode_utf16().collect());
    let quote_value = if transported_quote.is_some() {
        claim["quote"].clone()
    } else {
        json!(quote)
    };
    let invalid = |notice: &str| json!({"valid":false,"segments":[],"locator":"原文位置待核对","kind":"paragraph","quote":quote_value,"notice":notice});
    let integer = |v: &Value| {
        v.as_f64()
            .filter(|n| n.is_finite() && n.fract() == 0.0)
            .map(|n| n as i64)
    };
    let Some(start) = integer(&claim["start"]) else {
        return invalid("证据偏移无效，未猜测或重新搜索位置；请核对原件。");
    };
    let Some(end) = integer(&claim["end"]) else {
        return invalid("证据偏移无效，未猜测或重新搜索位置；请核对原件。");
    };
    if !source["content"].is_string()
        || quote_units.is_empty()
        || start < 0
        || end <= start
        || end > len(text) as i64
    {
        return invalid("证据偏移无效，未猜测或重新搜索位置；请核对原件。");
    }
    let (start, end) = (start as usize, end as usize);
    if truthy(&source["id"]) && truthy(&claim["source_id"]) && source["id"] != claim["source_id"] {
        return invalid("证据来源与当前资料不一致，未在其他资料中寻找同句。");
    }
    if truthy(&claim["offset_unit"]) && claim["offset_unit"] != "utf16_code_unit" {
        return invalid("证据偏移不是UTF16单位，需先核对定位契约。");
    }
    if units[start..end] != quote_units {
        return invalid("该偏移处原文与引文不一致，未改用同句的其他位置。");
    }
    if split_pair(&units, start) || split_pair(&units, end) {
        return invalid("证据偏移切入了完整Unicode字符，未移动原始定位。");
    }
    let radius = integer(options.get("radius").unwrap_or(&json!(280)));
    let budget = integer(options.get("maxContext").unwrap_or(&json!(1400)));
    if radius.is_none() || budget.is_none() || radius.unwrap() < 0 || budget.unwrap() < 1 {
        return invalid("预览上下文参数无效。");
    }
    let (radius, budget) = (radius.unwrap() as usize, budget.unwrap() as usize);
    let blocks: Vec<&Value> = a(&source["parsing"]["blocks"])
        .iter()
        .filter(|b| match (integer(&b["start"]), integer(&b["end"])) {
            (Some(a), Some(b)) => {
                a >= 0
                    && b > a
                    && b <= units.len() as i64
                    && !split_pair(&units, a as usize)
                    && !split_pair(&units, b as usize)
            }
            _ => false,
        })
        .collect();
    let containing: Vec<_> = blocks
        .iter()
        .copied()
        .filter(|b| {
            b["start"].as_u64().unwrap() as usize <= start
                && b["end"].as_u64().unwrap() as usize >= end
        })
        .collect();
    let overlapping: Vec<_> = blocks
        .iter()
        .copied()
        .filter(|b| {
            (b["start"].as_u64().unwrap() as usize) < end
                && (b["end"].as_u64().unwrap() as usize) > start
        })
        .collect();
    let table = containing
        .iter()
        .copied()
        .find(|b| s(&b["kind"]).to_lowercase() == "table");
    let safe_start = |i| if split_pair(&units, i) { i + 1 } else { i };
    let safe_end = |i| if split_pair(&units, i) { i - 1 } else { i };
    let around = |(a, b): (usize, usize), budget: usize| {
        let q = end - start;
        let allowance = if q > budget { 2 * radius } else { budget - q };
        let mut left = radius.min((allowance + 1) / 2).min(start - a);
        let right = radius.min(allowance.saturating_sub(left)).min(b - end);
        left = radius
            .min(start - a)
            .min(left + allowance.saturating_sub(left + right));
        (safe_start(start - left), safe_end(end + right))
    };
    let pages = |bs: &[&Value]| {
        let ext = source["parsing"]
            .get("extension")
            .filter(|v| truthy(v))
            .unwrap_or(&source["extension"]);
        if [".docx", ".doc"].contains(&s(ext).to_lowercase().as_str()) {
            return String::new();
        }
        let mut ps: Vec<i64> = bs
            .iter()
            .flat_map(|b| a(&b["provenance"]))
            .filter_map(|p| integer(&p["page_no"]))
            .filter(|p| *p > 0)
            .collect();
        ps.sort();
        ps.dedup();
        if ps.is_empty() {
            String::new()
        } else {
            format!(
                "第 {} 页 · ",
                ps.iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join("、")
            )
        }
    };
    let mut notice = if len(quote) > budget {
        Some("引文较长，完整保留；只展示有界邻接上下文。")
    } else {
        None
    };
    let ranges;
    let kind;
    let locator;
    if let Some(table) = table {
        kind = "table";
        let ta = table["start"].as_u64().unwrap() as usize;
        let tb = table["end"].as_u64().unwrap() as usize;
        let chunk = slice16(text, ta, tb);
        let re = regex::Regex::new(r"[^\r\n]*(?:\r\n|\n|\r|$)").unwrap();
        let mut cursor = ta;
        let lines: Vec<_> = re
            .find_iter(&chunk)
            .filter(|m| !m.as_str().is_empty())
            .map(|m| {
                let a = cursor;
                cursor += len(m.as_str());
                (
                    a,
                    cursor,
                    m.as_str().trim_end_matches(['\r', '\n']).to_string(),
                )
            })
            .collect();
        let hits: Vec<_> = lines
            .iter()
            .enumerate()
            .filter(|(_, l)| l.0 < end && l.1 > start)
            .map(|(i, _)| i)
            .collect();
        let first = hits[0];
        let last = *hits.last().unwrap();
        let sep = regex::Regex::new(r"^:?-{3,}:?$").unwrap();
        let divider = lines
            .iter()
            .enumerate()
            .find(|(i, l)| {
                *i > 0 && {
                    let v = l.2.trim_matches(js_ws);
                    let v = v.strip_prefix('|').unwrap_or(v);
                    v.strip_suffix('|').unwrap_or(v)
                }
                .split('|')
                .all(|c| sep.is_match(c.trim_matches(js_ws)))
            })
            .map(|(i, _)| i);
        let mut headers = vec![];
        if let Some(d) = divider {
            for i in [d - 1, d] {
                let l = &lines[i];
                let limit = (budget / 4).max(1);
                headers.push((l.0, safe_end(l.1.min(l.0 + limit))));
                if l.1 - l.0 > limit {
                    notice = Some("表头较宽，仅展示有界原文片段；完整表格请查看原件。");
                }
            }
        } else {
            notice = Some("未识别标准Markdown表头；展示命中行及相邻原文，不展开整张表。");
        }
        let header_size: usize = merge_ranges(
            headers
                .iter()
                .copied()
                .filter(|r| r.1 <= start || r.0 >= end)
                .collect(),
        )
        .iter()
        .map(|(a, b)| b - a)
        .sum();
        let body = around(
            (
                lines[first.saturating_sub(1)].0,
                lines[(last + 1).min(lines.len() - 1)].1,
            ),
            len(quote).max(budget.saturating_sub(header_size)),
        );
        headers.push(body);
        ranges = merge_ranges(headers);
        let number = blocks
            .iter()
            .filter(|b| s(&b["kind"]).to_lowercase() == "table")
            .position(|b| std::ptr::eq(*b, table))
            .unwrap()
            + 1;
        locator = format!(
            "{}表格 {} · 原文第 {}{} 行",
            pages(&[table]),
            number,
            first + 1,
            if last != first {
                format!("–{}", last + 1)
            } else {
                String::new()
            }
        );
    } else {
        kind = "paragraph";
        let left = start.saturating_sub(radius);
        let right = (end + radius).min(units.len());
        let offset = left.saturating_sub(4);
        let chunk = slice16(text, offset, (right + 4).min(units.len()));
        let re = regex::Regex::new(r"\r?\n[ \t]*(?:\r?\n)+").unwrap();
        let mut before = vec![];
        let mut after = vec![];
        for m in re.find_iter(&chunk) {
            let a = offset + len(&chunk[..m.start()]);
            let b = a + len(m.as_str());
            if b <= start && b >= left {
                before.push(b);
            }
            if a >= end && a <= right {
                after.push(a);
            }
        }
        let ra = if before.len() > 1 {
            left.max(before[before.len() - 2])
        } else {
            left
        };
        let rb = if after.len() > 1 {
            right.min(after[1])
        } else {
            right
        };
        ranges = vec![around((ra, rb), budget)];
        let block = containing.first().or(overlapping.first());
        let paragraph = if let Some(b) = block {
            format!(
                "文本块 {}",
                blocks.iter().position(|x| std::ptr::eq(*x, *b)).unwrap() + 1
            )
        } else {
            format!(
                "第 {} 段",
                1 + re.find_iter(&slice16(text, 0, start)).count()
            )
        };
        locator = format!("{}{}", pages(&overlapping), paragraph);
    }
    let segments:Vec<_>=ranges.into_iter().map(|(a,b)|{let x=a.max(start);let y=b.min(end);if x<y{json!({"start":a,"end":b,"before":slice16(text,a,x),"highlight":slice16(text,x,y),"after":slice16(text,y,b)})}else{json!({"start":a,"end":b,"before":if b<=start{slice16(text,a,b)}else{String::new()},"highlight":"","after":if a>=end{slice16(text,a,b)}else{String::new()}})}}).collect();
    let mut result =
        json!({"valid":true,"segments":segments,"locator":locator,"kind":kind,"quote":quote});
    if let Some(n) = notice {
        result["notice"] = json!(n);
    }
    result
}
pub fn make_packet(
    input: &Value,
    proposal: &Value,
    version: &Value,
    options: &Value,
) -> Result<Value> {
    use crate::common::{ensure, sha, slice16};
    let mut evidence = vec![];
    if !truthy(&proposal["claims"]) {
        for row in a(&crate::retrieval::context_sources(
            a(&input["sources"]),
            a(&input["cqs"]),
            &json!({}),
        )?) {
            let mut e = json!({"id":format!("doc_{}",s(&row["id"])),"source_id":row["id"],"text":row["text"]});
            if let Some(scope) = row.get("context_scope") {
                e["context_scope"] = scope.clone();
            }
            evidence.push(e);
        }
    }
    if truthy(&proposal["claims"]) {
        for c in a(&proposal["claims"]) {
            if evidence.iter().any(|e| e["id"] == c["evidence_id"]) {
                continue;
            }
            evidence
                .push(json!({"id":c["evidence_id"],"source_id":c["source_id"],"quote":c["quote"]}));
            if let Some(source) = a(&input["sources"])
                .iter()
                .find(|s| s["id"] == c["source_id"])
            {
                if c["start"].as_f64().is_some_and(|x| x.fract() == 0.0)
                    && c["end"].as_f64().is_some_and(|x| x.fract() == 0.0)
                {
                    let preview =
                        source_preview(source, c, &json!({"radius":400,"maxContext":2200}));
                    if preview["valid"] == true {
                        let id = format!(
                            "context_{}",
                            &sha(&json!({"source":source["id"],"segments":preview["segments"]}))
                                [..24]
                        );
                        if !evidence.iter().any(|e| e["id"] == id) {
                            let segs:Vec<_>=a(&preview["segments"]).iter().map(|r|json!({"start":r["start"],"end":r["end"],"text":slice16(s(&source["content"]),r["start"].as_u64().unwrap()as usize,r["end"].as_u64().unwrap()as usize)})).collect();
                            evidence.push(json!({"id":id,"source_id":source["id"],"text":segs.iter().map(|r|s(&r["text"])).collect::<Vec<_>>().join("\n…\n"),"segments":segs,"offset_unit":"utf16_code_unit","scope":if preview["kind"]=="table"{"ORIGINAL_TABLE_HEADER_AND_NEIGHBORS"}else{"ORIGINAL_NEIGHBORING_CONTEXT_NOT_FULL_DOCUMENT"}}));
                        }
                    }
                    let n = crate::common::len(s(&source["content"])) as i64;
                    let offset = |v: &Value| {
                        let x = v.as_f64().unwrap_or(0.0) as i64;
                        if x < 0 {
                            (n + x).max(0) as usize
                        } else {
                            x.min(n) as usize
                        }
                    };
                    let ca = offset(&c["start"]);
                    let cb = offset(&c["end"]);
                    let quote_matches =
                        slice16(s(&source["content"]), ca, cb.max(ca)) == s(&c["quote"]);
                    let mut pv = json!({"quote_matches_original":quote_matches,"start":c["start"],"end":c["end"],"offset_unit":"utf16_code_unit","semantic_support_not_certified":true});
                    if let Some(h) = source.get("sha256") {
                        pv["source_sha256"] = h.clone();
                    }
                    evidence
                        .iter_mut()
                        .find(|e| e["id"] == c["evidence_id"])
                        .unwrap()["program_validation"] = pv;
                }
            }
        }
        for c in a(&proposal["claims"]) {
            for e in a(&c["support_set"]) {
                let id = format!("support_{}", &sha(e)[..24]);
                if evidence.iter().any(|e| e["id"] == id) {
                    continue;
                }
                let mut r = json!({"id":id});
                if let Some(m) = e.as_object() {
                    for (k, v) in m {
                        r[k] = v.clone();
                    }
                }
                r["program_validation"] = json!({"quote_matches_original":crate::structure::support_valid(&json!({"support_set":[e]}),&input["sources"]),"semantic_support_not_certified":true});
                evidence.push(r);
            }
        }
    } else {
        for c in a(&options["structuralCandidates"]) {
            let source = a(&input["sources"])
                .iter()
                .find(|s| s["id"] == c["source_id"]);
            ensure(
                source.is_some_and(|src| {
                    slice16(
                        s(&src["content"]),
                        c["start"].as_u64().unwrap_or(0) as usize,
                        c["end"].as_u64().unwrap_or(0) as usize,
                    ) == s(&c["quote"])
                }),
                "结构建模证据已变化",
            )?;
            let source = source.unwrap();
            let mut r = json!({"id":c["id"],"source_id":c["source_id"],"quote":c["quote"],"start":c["start"],"end":c["end"],"program_validation":{"quote_matches_original":true,"semantic_support_not_certified":true}});
            if let Some(h) = source.get("sha256") {
                r["source_sha256"] = h.clone();
            }
            if let Some(ss) = c.get("support_set").filter(|x| truthy(x)) {
                r["support_set"] = ss.clone();
            }
            evidence.push(r);
        }
    }
    ensure(nonempty(&options["packet_id"]), "主机必须提供packet_id")?;
    Ok(
        json!({"query_execution_contract":{"STRUCTURE":{"version":"structure_query_v1","selection":"ALL requires one mode containing all requested subjects; WITHIN enumerates modes inside the requested set","returns":"all structural ENTITY role bindings AND structural STRING explanations for each complete selected mode, plus matching direct relationships","predicate_id":"catalog anchor, not an exclusive result predicate filter","completeness":"a mode with missing participant bindings is not a complete answer"}},"packet_id":options["packet_id"],"versions":{"schema":if truthy(&proposal["schema"]){sha(&proposal["schema"])}else{"user_schema_v1".into()},"sources":sha(&input["sources"]),"cqs":sha(&input["cqs"]),"candidate":sha(proposal)},"cqs":input["cqs"],"evidence":evidence,"proposal":proposal,"version":version,"coverage_scope":if truthy(&proposal["claims"]){"CLAIM_BATCH_WITH_BOUNDED_ORIGINAL_NEIGHBOR_CONTEXT_NOT_FULL_SOURCE_REVIEW"}else{"CQ_SAMPLED_SOURCE_CONTEXT_NOT_FULL_DOCUMENT_UNDERSTANDING"}}),
    )
}

pub fn execute(op: &str, p: &Value) -> Result<Value> {
    Ok(match op {
        "source_preview" => source_preview(&p["source"], &p["claim"], &p["options"]),
        "make_packet" => make_packet(&p["input"], &p["proposal"], &p["version"], &p["options"])?,
        "packet_hash" => json!(packet_hash(&p["packet"])),
        "diagnose_review" => json!(diagnose_review(&p["packet"], &p["review"])),
        "decide_review" => decide_review(
            &p["packet"],
            &p["review"],
            &p["validation"],
            &p["execution"],
        ),
        "review_targets" => json!(review_targets(&p["proposal"])),
        "compile_review" => compile_review(
            &p["packet"],
            &p["raw"],
            p["options"]["quarantineObservations"] == true,
        ),
        _ => {
            return Err(error(
                "UNKNOWN_REVIEW_OPERATION",
                format!("Unknown review operation: {op}"),
            ))
        }
    })
}
