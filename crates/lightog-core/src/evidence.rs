//! Frozen JavaScript evidence-alignment compatibility.
use crate::common::*;
use regex::Regex;
use serde_json::{json, Value};
fn matches(h: &str, n: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut pos = 0;
    while let Some(i) = index_of(h, n, pos) {
        out.push(i);
        if out.len() > 1 {
            break;
        }
        pos = i + 1;
        if pos > len(h) {
            break;
        }
    }
    out
}
fn compact(t: &str) -> (String, Vec<usize>) {
    let cs: Vec<char> = t.chars().collect();
    let han = Regex::new(r"^\p{Script=Han}$").unwrap();
    let is_han = |c: char| han.is_match(&c.to_string());
    let ws = |c: char| matches!(c, ' ' | '\t' | '\r' | '\n' | '\u{a0}' | '\u{3000}');
    let mut out = String::new();
    let mut offsets = Vec::new();
    let (mut i, mut pos) = (0, 0);
    while i < cs.len() {
        if ws(cs[i]) && i > 0 && is_han(cs[i - 1]) {
            let mut j = i;
            while j < cs.len() && ws(cs[j]) {
                j += 1
            }
            if j < cs.len() && is_han(cs[j]) {
                pos += cs[i..j].iter().map(|c| c.len_utf16()).sum::<usize>();
                i = j;
                continue;
            }
        }
        out.push(cs[i]);
        for k in 0..cs[i].len_utf16() {
            offsets.push(pos + k)
        }
        pos += cs[i].len_utf16();
        i += 1
    }
    (out, offsets)
}
fn coded(code: &str, message: &str) -> CoreError {
    error(code, message)
}
pub fn align_quote(source: &Value, quote: &str) -> Result<Value> {
    let content = s(&source["content"]);
    let exact = matches(content, quote);
    if exact.len() == 1 {
        return Ok(
            json!({"start":exact[0],"end":exact[0]+len(quote),"quote":quote,"method":"EXACT"}),
        );
    }
    if exact.len() > 1 {
        return Err(coded(
            "EVIDENCE_AMBIGUOUS",
            "引文在原文出现多次，不能自动选择证据位置",
        ));
    }
    if !truthy(&source["parsing"]) {
        return Err(coded("EVIDENCE_NOT_FOUND", "引文不在原文中"));
    }
    let units: Vec<u16> = content.encode_utf16().collect();
    let mut value = String::new();
    let mut offsets = Vec::new();
    let mut gaps = Vec::new();
    let mut i = 0;
    while i < units.len() {
        if units[i] == 10 && units.get(i + 1) == Some(&10) {
            let mut end = i + 2;
            while units.get(end) == Some(&10) {
                end += 1
            }
            value.push('\n');
            offsets.push((i, end));
            gaps.push((i, end));
            i = end;
        } else {
            let width = if (0xd800..=0xdbff).contains(&units[i])
                && units
                    .get(i + 1)
                    .is_some_and(|u| (0xdc00..=0xdfff).contains(u))
            {
                2
            } else {
                1
            };
            value.push_str(&slice16(content, i, i + width));
            for k in 0..width {
                offsets.push((i + k, i + k + 1))
            }
            i += width;
        }
    }
    let re = Regex::new(r"\n{2,}").unwrap();
    let proposed = re.replace_all(quote, "\n").to_string();
    let found = matches(&value, &proposed);
    if found.len() == 1 && len(&proposed) > 0 {
        let start = offsets[found[0]].0;
        let end = offsets[found[0] + len(&proposed) - 1].1;
        let changed: Vec<_> = gaps.iter().filter(|g| g.0 >= start && g.1 <= end).collect();
        let blocks = a(&source["parsing"]["blocks"]);
        if !changed.is_empty()
            && changed.iter().all(|g| {
                blocks.iter().any(|b| b["end"].as_u64() == Some(g.0 as u64))
                    && blocks
                        .iter()
                        .any(|b| b["start"].as_u64() == Some(g.1 as u64))
            })
        {
            return Ok(
                json!({"start":start,"end":end,"quote":slice16(content,start,end),"method":"PARSER_BLOCK_SEPARATOR_NEWLINE_V1","model_quote":quote}),
            );
        }
    }
    let (original, off) = compact(content);
    let (proposed, _) = compact(quote);
    let found = matches(&original, &proposed);
    if found.is_empty() {
        return Err(coded(
            "EVIDENCE_NOT_FOUND",
            "引文不在原文中，中文排版空白对齐也未命中",
        ));
    }
    if found.len() != 1 {
        return Err(coded(
            "EVIDENCE_AMBIGUOUS",
            "空白对齐后引文不唯一，不能自动选择位置",
        ));
    }
    if proposed.is_empty() {
        return Err(coded(
            "EVIDENCE_NOT_FOUND",
            "引文不在原文中，中文排版空白对齐也未命中",
        ));
    }
    let start = off[found[0]];
    let end = off[found[0] + len(&proposed) - 1] + 1;
    ensure(
        a(&source["parsing"]["blocks"]).iter().any(|b| {
            b["start"].as_u64().is_some_and(|x| x <= start as u64)
                && b["end"].as_u64().is_some_and(|x| x >= end as u64)
        }),
        "空白对齐跨越解析文本块，需要重新引用连续原文",
    )
    .map_err(|_| {
        coded(
            "EVIDENCE_CROSSES_BLOCKS",
            "空白对齐跨越解析文本块，需要重新引用连续原文",
        )
    })?;
    Ok(
        json!({"start":start,"end":end,"quote":slice16(content,start,end),"method":"CJK_LAYOUT_WHITESPACE_V1","model_quote":quote}),
    )
}
pub fn execute(op: &str, p: &Value) -> Result<Value> {
    match op {
        "validate_claims" => validate_claims(&p["raw"], &p["schema"], &p["input"], &p["options"]),
        "reuse_verified_claim_spans" => {
            map_array(p.get("claims"), "claims")?;
            Ok(reuse_verified_claim_spans(
                &p["claims"],
                &p["previous"],
                &p["source"],
                &p["unit"],
            ))
        }
        "align_quote" => align_quote(&p["source"], s(&p["quote"])),
        _ => Err(error("CORE_OPERATION_UNSUPPORTED", "未知证据操作")),
    }
}
fn map_array(v: Option<&Value>, expression: &str) -> Result<()> {
    match v {
        Some(Value::Array(_)) => Ok(()),
        None => Err(error(
            "CORE_TYPE_ERROR",
            "Cannot read properties of undefined (reading 'map')",
        )),
        Some(Value::Null) => Err(error(
            "CORE_TYPE_ERROR",
            "Cannot read properties of null (reading 'map')",
        )),
        _ => Err(error(
            "CORE_TYPE_ERROR",
            format!("{}.map is not a function", expression),
        )),
    }
}
fn has(v: &Value, k: &str) -> bool {
    v.get(k).is_some()
}
fn nully(v: &Value, k: &str) -> bool {
    has(v, k) && v[k].is_null()
}
fn txt(v: &Value, max: usize, field: &str) -> Result<String> {
    ensure(
        v.is_string() && !s(v).trim_matches(js_ws).is_empty() && len(s(v)) <= max,
        format!("{}无效或过长", field),
    )?;
    Ok(s(v).trim_matches(js_ws).to_owned())
}
fn ix(v: &Value) -> Option<usize> {
    v.as_u64().and_then(|x| usize::try_from(x).ok())
}
pub fn reuse_verified_claim_spans(
    claims: &Value,
    previous: &Value,
    source: &Value,
    unit: &Value,
) -> Value {
    let sig = |c: &Value| {
        let mut z = json!({});
        for k in [
            "source_id",
            "subject_id",
            "predicate_id",
            "value",
            "quote",
            "modality",
            "comparator",
            "unit",
            "scope",
            "effective_from",
            "time_raw",
        ] {
            z[k] = c[k].clone();
        }
        sha(&z)
    };
    json!(a(claims)
        .iter()
        .map(|c| {
            if truthy(&c["evidence"])
                || truthy(&c["evidence_ref"])
                || has(c, "start")
                || has(c, "end")
            {
                return c.clone();
            }
            let mut spans = Vec::new();
            for p in a(previous) {
                if sig(p) == sig(c)
                    && p["source_id"] == source["id"]
                    && ix(&p["start"])
                        .zip(ix(&unit["start"]))
                        .is_some_and(|(x, y)| x >= y)
                    && ix(&p["end"])
                        .zip(ix(&unit["end"]))
                        .is_some_and(|(x, y)| x <= y)
                    && ix(&p["start"]).zip(ix(&p["end"])).is_some_and(|(x, y)| {
                        slice16(s(&source["content"]), x, y) == s(&p["quote"])
                    })
                    && !spans
                        .iter()
                        .any(|p2: &&Value| p2["start"] == p["start"] && p2["end"] == p["end"])
                {
                    spans.push(p)
                }
            }
            let mut row = c.clone();
            if spans.len() == 1 {
                row["start"] = spans[0]["start"].clone();
                row["end"] = spans[0]["end"].clone();
            }
            row
        })
        .collect::<Vec<_>>())
}
pub fn validate_claims(
    raw: &Value,
    schema: &Value,
    input: &Value,
    options: &Value,
) -> Result<Value> {
    let max = match options.get("maxClaims") {
        None => f64::INFINITY,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::String(t)) => {
            let t = t.trim_matches(js_ws);
            if t.is_empty() {
                0.0
            } else {
                t.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    };
    ensure(
        raw["claims"].is_array() && (a(&raw["claims"]).len() as f64) <= max,
        "候选声明数量无效",
    )?;
    map_array(input.get("sources"), "input.sources")?;
    map_array(schema.get("entities"), "schema.entities")?;
    map_array(schema.get("predicates"), "schema.predicates")?;
    let collect = truthy(&options["collectErrors"]);
    let repeated = truthy(&options["repeatedRepairReferences"]);
    let unit = &options["unit"];
    let mut claims = Vec::new();
    let mut norm = Vec::new();
    let mut issues = Vec::new();
    let mut ids = std::collections::HashSet::new();
    for (index, c) in a(&raw["claims"]).iter().enumerate() {
        let mut audit = Vec::new();
        let checked = (|| -> Result<Value> {
            let entity = a(&schema["entities"])
                .iter()
                .find(|e| e["id"] == c["subject_id"]);
            let predicate = a(&schema["predicates"])
                .iter()
                .find(|p| p["id"] == c["predicate_id"]);
            ensure(
                c.is_object() && entity.is_some() && predicate.is_some(),
                "声明引用未定义实体或谓词",
            )?;
            let source = a(&input["sources"])
                .iter()
                .find(|s| s["id"] == c["source_id"])
                .ok_or_else(|| fail("来源无效或变更"))?;
            ensure(
                text_sha(s(&source["content"])) == s(&source["sha256"]),
                "来源无效或变更",
            )?;
            let quote = txt(&c["quote"], 4000, "引文")?;
            let window = if truthy(unit) {
                unit
            } else {
                &c["source_window"]
            };
            let mut local = source.clone();
            let (mut ws, mut we) = (0, len(s(&source["content"])));
            if truthy(window) {
                let range = ix(&window["start"]).zip(ix(&window["end"]));
                ensure(
                    range.is_some_and(|(x, y)| y > x && y <= len(s(&source["content"]))),
                    "证据窗口范围无效",
                )?;
                (ws, we) = range.unwrap();
                if truthy(unit) {
                    ensure(
                        unit["source_id"] == source["id"]
                            && s(&unit["text"]) == slice16(s(&source["content"]), ws, we),
                        "抽取分块与原文不一致",
                    )?;
                }
                local["content"] = json!(slice16(s(&source["content"]), ws, we));
                if truthy(&source["parsing"]) {
                    let blocks: Vec<Value> = a(&source["parsing"]["blocks"])
                        .iter()
                        .filter(|b| {
                            ix(&b["start"]).unwrap_or(usize::MAX) < we
                                && ix(&b["end"]).unwrap_or(0) > ws
                        })
                        .map(|b| {
                            let mut r = b.clone();
                            r["start"] = json!(ix(&b["start"]).unwrap_or(0).max(ws) - ws);
                            r["end"] = json!(ix(&b["end"]).unwrap_or(0).min(we) - ws);
                            r
                        })
                        .collect();
                    local["parsing"]["blocks"] = json!(blocks);
                }
            }
            let alignment = if has(c, "start") || has(c, "end") {
                let r = ix(&c["start"]).zip(ix(&c["end"]));
                ensure(
                    r.is_some_and(|(x, y)| {
                        x >= ws
                            && y > x
                            && y <= we
                            && slice16(s(&source["content"]), x, y) == s(&c["quote"])
                    }),
                    "引文明确证据位置与当前原文不匹配",
                )?;
                json!({"quote":c["quote"],"start":c["start"],"end":c["end"],"method":"EXACT"})
            } else {
                let mut r = align_quote(&local, &quote)?;
                r["start"] = json!(ix(&r["start"]).unwrap_or(0) + ws);
                r["end"] = json!(ix(&r["end"]).unwrap_or(0) + ws);
                r
            };
            let start = ix(&alignment["start"]).unwrap_or(0);
            let aligned = &alignment["quote"];
            if alignment["method"] != "EXACT" {
                audit.push(json!({"index":index,"field":"quote","before":quote,"after":aligned,"rule":alignment["method"],"start":start,"end":alignment["end"],"source_id":source["id"],"source_sha256":source["sha256"]}));
            }
            ensure(
                ["CURRENT", "PLANNED"].contains(&s(&c["modality"])),
                "语气无效",
            )?;
            ensure(
                ["EQ", "GT", "GE", "LT", "LE", "APPROX", "UNKNOWN"].contains(&s(&c["comparator"])),
                "量词无效",
            )?;
            ensure(
                nully(c, "unit") || (c["unit"].is_string() && len(s(&c["unit"])) <= 100),
                "声明单位无效或过长",
            )?;
            ensure(
                nully(c, "scope") || (c["scope"].is_string() && len(s(&c["scope"])) <= 500),
                "范围无效",
            )?;
            ensure(
                nully(c, "effective_from")
                    || (c["effective_from"].is_string() && valid_date(s(&c["effective_from"]))),
                "有效时间无效，不得补造日期",
            )?;
            ensure(
                !has(c, "time_raw")
                    || c["time_raw"].is_null()
                    || (c["time_raw"].is_string() && len(s(&c["time_raw"])) <= 1000),
                "时间原句过长或格式无效",
            )?;
            let pred = predicate.unwrap();
            let mut value = c["value"].clone();
            if pred["value_type"] == "NUMBER"
                && value.is_string()
                && Regex::new(r"^(0|[1-9]\d*)$").unwrap().is_match(s(&value))
            {
                if let Ok(n) = s(&value).parse::<u64>() {
                    if n <= 9007199254740991 {
                        audit.push(json!({"index":index,"field":"value","before":value,"after":n,"rule":"integer_string_to_integer_v1"}));
                        value = json!(n);
                    }
                }
            }
            if pred["value_type"] == "NUMBER" {
                ensure(
                    value.is_number() && value.as_f64().is_some_and(f64::is_finite),
                    "数值属性类型错误",
                )?;
            } else if pred["value_type"] == "ENTITY" {
                ensure(
                    value.is_string() && a(&schema["entities"]).iter().any(|e| e["id"] == value),
                    "关系客体未定义",
                )?;
            } else {
                txt(&value, 1000, "属性值")?;
            }
            ensure(
                !truthy(&pred["domain"]) || a(&pred["domain"]).contains(&entity.unwrap()["type"]),
                "关系主体类型不匹配",
            )?;
            if pred["value_type"] == "ENTITY" {
                let et = a(&schema["entities"])
                    .iter()
                    .find(|e| e["id"] == value)
                    .unwrap();
                ensure(
                    !truthy(&pred["range"]) || a(&pred["range"]).contains(&et["type"]),
                    "关系客体类型不匹配",
                )?;
            }
            let support = crate::structure::normalize_support_set(c.get("support_set"), input)?;
            let mut normalized = json!({"subject_id":c["subject_id"],"predicate_id":c["predicate_id"],"value":value,"source_id":c["source_id"],"quote":aligned,"modality":c["modality"],"comparator":c["comparator"],"unit":c["unit"],"scope":c["scope"],"effective_from":c["effective_from"],"time_raw":if c["time_raw"].is_string(){c["time_raw"].clone()}else{Value::Null}});
            if let Some(support) = support {
                normalized["support_set"] = support;
            }
            let mut identity = normalized.clone();
            if truthy(window) {
                identity["evidence_anchor"] = json!({"start":start,"end":start+len(s(aligned))});
            }
            let id = format!("claim_{}", &sha(&identity)[..24]);
            ensure(repeated || !ids.contains(&id), "模型返回重复声明")?;
            if ids.contains(&id) {
                audit.push(json!({"index":index,"field":"claim","rule":"IDENTICAL_REPLACEMENT_REFERENCED_BY_MULTIPLE_TARGETS","claim_id":id}));
            }
            ids.insert(id.clone());
            let mut row = json!({"id":id});
            for (k, v) in normalized.as_object().unwrap() {
                row[k] = v.clone();
            }
            if truthy(window) {
                row["source_window"] = json!({"start":window["start"],"end":window["end"],"unit_id":if truthy(&window["id"]){window["id"].clone()}else if truthy(&window["unit_id"]){window["unit_id"].clone()}else{Value::Null}});
            }
            row["evidence_alignment"] = json!({"method":alignment["method"]});
            if has(&alignment, "model_quote") {
                row["evidence_alignment"]["model_quote"] = alignment["model_quote"].clone();
            }
            row["evidence_id"] = json!(format!(
                "ev_{}",
                &sha(&json!({"source":source["id"],"start":start,"quote":aligned}))[..24]
            ));
            row["start"] = json!(start);
            row["end"] = json!(start + len(s(aligned)));
            row["offset_unit"] = json!("utf16_code_unit");
            row["independently_verified"] = json!(false);
            if has(source, "source_role") {
                row["source_role"] = source["source_role"].clone();
            }
            if truthy(&source["parsing"]) {
                for k in ["document_id", "original_sha256", "parser_version"] {
                    if has(&source["parsing"], k) {
                        row[k] = source["parsing"][k].clone();
                    }
                }
                row["locations"] = json!(a(&source["parsing"]["blocks"])
                    .iter()
                    .filter(
                        |b| ix(&b["start"]).unwrap_or(usize::MAX) < start + len(s(aligned))
                            && ix(&b["end"]).unwrap_or(0) > start
                    )
                    .map(|b| {
                        let mut r = json!({});
                        for k in ["block_id", "kind", "provenance", "text_origin"] {
                            if has(b, k) {
                                r[k] = b[k].clone();
                            }
                        }
                        r
                    })
                    .collect::<Vec<_>>());
            }
            Ok(row)
        })();
        match checked {
            Ok(c) => {
                norm.extend(audit);
                claims.push(c)
            }
            Err(mut e) => {
                let issue = json!({"issue_id":format!("validation_{}",index),"index":index,"code":if e.code=="CORE_ASSERTION"{"ERR_ASSERTION"}else if e.code.is_empty(){"CLAIM_CONTRACT_INVALID"}else{&e.code},"source_id":if truthy(&c["source_id"]){c["source_id"].clone()}else{Value::Null},"subject_id":if truthy(&c["subject_id"]){c["subject_id"].clone()}else{Value::Null},"predicate_id":if truthy(&c["predicate_id"]){c["predicate_id"].clone()}else{Value::Null},"model_quote":if c["quote"].is_string(){json!(slice16(s(&c["quote"]),0,len(s(&c["quote"])).min(4000)))}else{Value::Null},"explanation":e.message,"resolution":"MANUAL_REVISION","target":format!("/claims/{}",index),"cq_ids":a(&input["cqs"]).iter().map(|q|&q["id"]).collect::<Vec<_>>(),"suggested_change":"核对对应原文，引用连续文本并保留原意；不自动改写事实或批准缺证声明。","counterexample":"数字、否定、标点、英文词间空格和来源不同均不能靠模糊匹配放行。"});
                if !collect {
                    e.details = Some(issue);
                    return Err(e);
                }
                issues.push(issue);
            }
        }
    }
    let mut out = json!({"claims":claims,"normalization":norm});
    if collect {
        out["issues"] = json!(issues);
        out["submitted"] = json!(a(&raw["claims"]).len());
    }
    Ok(out)
}
