//! Frozen schema/query-plan validation and finite answer execution.
use crate::common::*;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashSet;
fn has(v: &Value, k: &str) -> bool {
    v.as_object().is_some_and(|o| o.contains_key(k))
}
fn nul(v: &Value, k: &str) -> bool {
    has(v, k) && v[k].is_null()
}
fn txt(v: &Value, max: usize, field: &str) -> Result<()> {
    ensure(
        v.is_string() && !s(v).trim_matches(js_ws).is_empty() && len(s(v)) <= max,
        format!("{}无效或过长", field),
    )
}
fn ids(v: &Value, name: &str, max: usize) -> Result<()> {
    ensure(
        v.is_array() && a(v).len() <= max,
        format!("{}数量无效", name),
    )?;
    let re = Regex::new(r"^[a-zA-Z][a-zA-Z0-9_-]{0,79}$").unwrap();
    ensure(
        a(v).iter()
            .all(|r| r.is_object() && r["id"].is_string() && re.is_match(s(&r["id"]))),
        format!("{}ID无效", name),
    )?;
    ensure(
        a(v).iter()
            .map(|r| s(&r["id"]))
            .collect::<HashSet<_>>()
            .len()
            == a(v).len(),
        format!("{}ID重复", name),
    )
}
fn contains(rows: &Value, key: &str, v: &Value) -> bool {
    a(rows).iter().any(|r| &r[key] == v)
}
pub fn normalize_schema_envelope(raw: &Value, norm: &mut Vec<Value>) -> Result<Value> {
    ensure(raw["schema"].is_object(), "本体不是对象")?;
    let mut schema = raw["schema"].clone();
    for f in ["cq_plans", "structural_predicate_ids"] {
        if !has(raw, f) {
            continue;
        }
        if has(&schema, f) {
            ensure(schema[f] == raw[f], format!("本体内外层字段冲突：{}", f))?;
        } else {
            schema[f] = raw[f].clone();
            norm.push(json!({"field":f,"from":f,"to":format!("schema.{}",f),"rule":"SCHEMA_ENVELOPE_FIELD"}));
        }
    }
    Ok(schema)
}
pub fn validate_schema(raw: &Value, input: &Value, norm: &mut Vec<Value>) -> Result<Value> {
    ensure(raw.is_object() || raw.is_array(), "本体不是对象")?;
    let mut z = raw.clone();
    ids(&z["entity_types"], "实体类型", 20)?;
    ids(&z["entities"], "实体", 80)?;
    ids(&z["predicates"], "谓词", 30)?;
    let types: HashSet<String> = a(&z["entity_types"])
        .iter()
        .map(|x| s(&x["id"]).to_owned())
        .collect();
    let ents: HashSet<String> = a(&z["entities"])
        .iter()
        .map(|x| s(&x["id"]).to_owned())
        .collect();
    let preds: HashSet<String> = a(&z["predicates"])
        .iter()
        .map(|x| s(&x["id"]).to_owned())
        .collect();
    if has(&z, "structural_predicate_ids") {
        let ar = a(&z["structural_predicate_ids"]);
        ensure(
            z["structural_predicate_ids"].is_array()
                && ar.iter().map(js_stringify).collect::<HashSet<_>>().len() == ar.len()
                && ar
                    .iter()
                    .all(|x| x.as_str().is_some_and(|v| preds.contains(v))),
            "结构谓词索引无效",
        )?;
    }
    for t in a(&z["entity_types"]) {
        txt(&t["label"], 100, "类型名称")?;
    }
    for e in a(&z["entities"]) {
        txt(&e["name"], 150, "实体名称")?;
        ensure(types.contains(s(&e["type"])), "实体类型未定义")?;
        if has(e, "structure_kind") {
            ensure(
                ["RELATION", "COMBINATION", "COMPARISON", "COMPOSITION"]
                    .contains(&s(&e["structure_kind"])),
                "结构实体类型无效",
            )?;
            let ps = a(&e["participant_ids"]);
            ensure(e["participant_ids"].is_array()&&ps.len()>=2&&ps.iter().map(js_stringify).collect::<HashSet<_>>().len()==ps.len()&&ps.iter().all(|p|p.as_str().is_some_and(|v|ents.contains(v))&&p!=&e["id"]),format!("结构实体 {} 需绑定至少两个不同的已定义参与者，当前：{}；普通单主体属性不得伪装成多方模式，实际新参与者应先定义身份",s(&e["id"]),js_stringify(&e["participant_ids"])))?;
        }
    }
    for p in z["predicates"].as_array_mut().unwrap() {
        txt(&p["label"], 100, "谓词名称")?;
        ensure(
            ["STRING", "NUMBER", "ENTITY"].contains(&s(&p["value_type"])),
            "不支持的属性值类型",
        )?;
        ensure(
            nul(p, "unit") || (p["unit"].is_string() && len(s(&p["unit"])) <= 50),
            "单位无效",
        )?;
        ensure(
            !has(p, "cardinality") || ["ONE", "MANY"].contains(&s(&p["cardinality"])),
            "属性基数无效",
        )?;
        if has(p, "structural") {
            ensure(p["structural"].is_boolean(), "结构谓词标记无效")?;
        }
        if p["value_type"] != "ENTITY"
            && has(p, "range")
            && (p["range"].is_null()
                || p["range"] == p["value_type"]
                || p["range"].as_array().is_some_and(|x| x.is_empty()))
        {
            norm.push(json!({"predicate_id":p["id"],"field":"range","before":p["range"],"rule":"LITERAL_RANGE_ALREADY_DEFINED_BY_VALUE_TYPE"}));
            p.as_object_mut().unwrap().remove("range");
        }
        for f in ["domain", "range"] {
            if !has(p, f) {
                continue;
            }
            if p[f].is_string() && types.contains(s(&p[f])) {
                norm.push(json!({"predicate_id":p["id"],"field":f,"before":p[f],"after":[p[f]],"rule":"SINGLE_TYPE_TO_SET"}));
                p[f] = json!([p[f]]);
            }
            ensure(
                p[f].is_array()
                    && !a(&p[f]).is_empty()
                    && a(&p[f])
                        .iter()
                        .all(|x| x.as_str().is_some_and(|v| types.contains(v))),
                format!(
                    "谓词 {} 的 {} 必须是已定义类型ID数组，实际={}",
                    s(&p["id"]),
                    f,
                    js_stringify(&p[f])
                ),
            )?;
        }
    }
    ensure(
        z["cq_plans"].is_array() && a(&z["cq_plans"]).len() == a(&input["cqs"]).len(),
        "CQ查询计划不完整",
    )?;
    ensure(
        a(&z["cq_plans"])
            .iter()
            .map(|x| js_stringify(&x["cq_id"]))
            .collect::<HashSet<_>>()
            .len()
            == a(&input["cqs"]).len(),
        "CQ计划重复",
    )?;
    let snapshot = z.clone();
    for p in z["cq_plans"].as_array_mut().unwrap() {
        ensure(contains(&input["cqs"], "id", &p["cq_id"]), "未知CQ计划")?;
        let t = s(&p["template"]).to_owned();
        ensure(
            ["FACTS", "ENTITIES", "COMPARE", "STRUCTURE", "UNKNOWN"].contains(&t.as_str()),
            "不支持的查询模板",
        )?;
        let ps = a(&p["subject_ids"]);
        if t == "STRUCTURE" {
            ensure(
                p["subject_ids"].is_array()
                    && (1..=8).contains(&ps.len())
                    && ps.iter().map(js_stringify).collect::<HashSet<_>>().len() == ps.len()
                    && ps
                        .iter()
                        .all(|x| x.as_str().is_some_and(|v| ents.contains(v)))
                    && (!has(p, "structure_kind")
                        || p["structure_kind"].is_null()
                        || ["RELATION", "COMBINATION", "COMPARISON", "COMPOSITION"]
                            .contains(&s(&p["structure_kind"])))
                    && (!has(p, "structure_match")
                        || ["ALL", "WITHIN"].contains(&s(&p["structure_match"]))),
                "结构计划主体或结构类型无效",
            )?;
        }
        if t == "COMPARE" && !has(p, "subject_id") {
            p["subject_id"] = Value::Null;
            norm.push(json!({"field":"subject_id","cq_id":p["cq_id"],"after":null,"rule":"compare_unused_single_subject_null_v1"}));
        }
        if t == "COMPARE" {
            let ps = a(&p["subject_ids"]);
            ensure(
                p["subject_ids"].is_array()
                    && (2..=8).contains(&ps.len())
                    && ps.iter().map(js_stringify).collect::<HashSet<_>>().len() == ps.len()
                    && ps
                        .iter()
                        .all(|x| x.as_str().is_some_and(|v| ents.contains(v))),
                "比较计划需要2–8个不重复的已定义实体",
            )?;
        }
        ensure(
            nul(p, "subject_id") || p["subject_id"].as_str().is_some_and(|v| ents.contains(v)),
            "计划主体未定义",
        )?;
        ensure(
            nul(p, "predicate_id")
                || p["predicate_id"]
                    .as_str()
                    .is_some_and(|v| preds.contains(v)),
            "计划谓词未定义",
        )?;
        ensure(
            nul(p, "object_value")
                || p["object_value"].is_string()
                || p["object_value"].is_number(),
            "查询参数无效",
        )?;
        if t != "UNKNOWN" {
            ensure(truthy(&p["predicate_id"]), "查询计划缺少谓词")?;
        }
        if t == "STRUCTURE" {
            let pred = a(&snapshot["predicates"])
                .iter()
                .find(|r| r["id"] == p["predicate_id"])
                .unwrap_or(&Value::Null);
            ensure(
                crate::structure::is_structural_predicate(&snapshot, pred),
                "结构计划必须绑定已声明的结构谓词",
            )?;
        }
        ensure(
            !has(p, "reason") || (p["reason"].is_string() && len(s(&p["reason"])) <= 1000),
            "计划说明无效或超过1000字符",
        )?;
    }
    Ok(z)
}
pub fn query_plan_issues(schema: &Value, input: &Value) -> Value {
    let yes = Regex::new(
        r"(?i)是否|有没有|有无|能否|是不是|^(?:does|do|is|are|can|has|have)(?:$|[^A-Za-z0-9_])",
    )
    .unwrap();
    let mut out = Vec::new();
    for (i, p) in a(&schema["cq_plans"]).iter().enumerate() {
        let q = a(&input["cqs"])
            .iter()
            .find(|q| q["id"] == p["cq_id"])
            .map(|q| s(&q["question"]))
            .unwrap_or("");
        if !yes.is_match(q)
            || p["template"] == "UNKNOWN"
            || p["template"] == "COMPARE"
            || (p["template"] == "STRUCTURE"
                && p["structure_kind"] == "COMBINATION"
                && a(&p["subject_ids"]).len() >= 2
                && p["structure_match"] != "WITHIN")
            || !nul(p, "object_value")
        {
            continue;
        }
        out.push(json!({"issue_id":format!("query_target_{}",s(&p["cq_id"])),"code":"QUERY_TARGET_UNBOUND","resolution":"MANUAL_REVISION","target":format!("/schema/cq_plans/{}",i),"cq_ids":[p["cq_id"]],"explanation":"是否/能否类问题的查询计划缺少目标值；列出所有属性不能回答指定能力是否有来源支持。","suggested_change":"为本问题明确绑定object_value；若不能确定目标，使用UNKNOWN。不以其他能力或仅存在任意属性作为肯定依据。","counterexample":"询问制造业支持时，电商客服的来源陈述不能作为答案。该规则保守拦截，非完整自然语言理解。"}));
    }
    json!(out)
}
fn unknown(reason: Value) -> Value {
    json!({"classification":"UNKNOWN","value":null,"reason":reason,"claims":[]})
}
fn current(c: &Value, input: &Value) -> bool {
    c["modality"] == "CURRENT"
        && (!truthy(&input["as_of"])
            || !truthy(&c["effective_from"])
            || s(&c["effective_from"]) <= s(&input["as_of"]))
}
pub fn answer_plan(result: &Value, input: &Value, plan: &Value) -> Result<Value> {
    if result["status"] != "READY" {
        return Ok(unknown(json!("当前版本尚未通过评审门禁，不开放事实检索。")));
    }
    if !plan.is_null()
        && (a(&result["pending_components"]["predicate_ids"]).contains(&plan["predicate_id"])
            || a(&result["pending_components"]["cq_ids"]).contains(&plan["cq_id"]))
    {
        return Ok(
            json!({"classification":"CONFLICT","value":null,"claims":[],"reason":"相关证据或定义正在人工核对，当前不提供确定结论。","pending_review":true,"review_task_ids":if truthy(&result["pending_components"]["origin_task_ids"]){result["pending_components"]["origin_task_ids"].clone()}else{json!([])}}),
        );
    }
    if plan.is_null() || plan["template"] == "UNKNOWN" {
        return Ok(unknown(if truthy(&plan["reason"]) {
            plan["reason"].clone()
        } else {
            json!("当前版本没有覆盖这个问题。")
        }));
    }
    let unsafe_ = query_plan_issues(&json!({"cq_plans":[plan]}), input);
    if !a(&unsafe_).is_empty() {
        let mut r = unknown(json!(format!(
            "{}请修订查询计划后重新验证。",
            s(&unsafe_[0]["explanation"])
        )));
        r["query_policy"] = json!("target_binding_v1");
        r["issues"] = unsafe_;
        return Ok(r);
    }
    let schema = &result["schema"];
    if plan["template"] == "STRUCTURE" {
        let requested = a(&plan["subject_ids"]);
        if requested.is_empty() {
            return Ok(unknown(json!("结构查询需明确主体")));
        }
        let pred = |id: &Value| {
            a(&schema["predicates"])
                .iter()
                .find(|p| &p["id"] == id)
                .unwrap_or(&Value::Null)
        };
        if a(&result["pending_components"]["predicate_ids"])
            .iter()
            .any(|id| crate::structure::is_structural_predicate(schema, pred(id)))
        {
            return Ok(
                json!({"classification":"CONFLICT","claims":[],"pending_review":true,"reason":"相关结构正在核对"}),
            );
        }
        let rows: Vec<_> = a(&result["claims"])
            .iter()
            .filter(|c| current(c, input) && crate::structure::support_valid(c, &input["sources"]))
            .collect();
        let patterns: Vec<_> = a(&schema["entities"])
            .iter()
            .filter(|e| {
                truthy(&e["structure_kind"])
                    && (!truthy(&plan["structure_kind"])
                        || e["structure_kind"] == plan["structure_kind"])
                    && if plan["structure_match"] == "WITHIN" {
                        a(&e["participant_ids"]).len() >= 2
                            && a(&e["participant_ids"])
                                .iter()
                                .all(|id| requested.contains(id))
                    } else {
                        requested
                            .iter()
                            .all(|id| a(&e["participant_ids"]).contains(id))
                    }
            })
            .filter(|e| {
                a(&e["participant_ids"]).iter().all(|id| {
                    rows.iter().any(|c| {
                        c["subject_id"] == e["id"]
                            && &c["value"] == id
                            && pred(&c["predicate_id"])["value_type"] == "ENTITY"
                    })
                })
            })
            .collect();
        let matched: Vec<Value> = rows
            .into_iter()
            .filter(|c| {
                crate::structure::is_structural_predicate(schema, pred(&c["predicate_id"]))
                    && (patterns.iter().any(|e| e["id"] == c["subject_id"])
                        || ((!truthy(&plan["structure_kind"])
                            || plan["structure_kind"] == "RELATION")
                            && pred(&c["predicate_id"])["value_type"] == "ENTITY"
                            && requested
                                .iter()
                                .all(|id| id == &c["subject_id"] || id == &c["value"])))
                    && (nul(plan, "object_value")
                        || pred(&c["predicate_id"])["label"] == plan["object_value"]
                        || c["value"] == plan["object_value"])
            })
            .cloned()
            .collect();
        if !matched
            .iter()
            .any(|c| pred(&c["predicate_id"])["value_type"] == "ENTITY")
        {
            return Ok(unknown(json!(
                "当前没有支持这些主体关系及角色的完整现行证据"
            )));
        }
        return Ok(
            json!({"classification":"ATTRIBUTED_ONLY","value":null,"claims":matched,"structure_ids":patterns.iter().map(|e|&e["id"]).collect::<Vec<_>>(),"reason":"依据已发布的关系及完整模式角色回答，不将共现视作关系。"}),
        );
    }
    if plan["template"] == "COMPARE" {
        let mut comparisons = Vec::new();
        let mut claims = Vec::new();
        for id in a(&plan["subject_ids"]) {
            let mut p = plan.clone();
            p["template"] = json!("FACTS");
            p["subject_id"] = id.clone();
            let mut r = answer_plan(result, input, &p)?;
            let mut row = json!({"subject_id":id});
            for (k, v) in r.as_object_mut().unwrap().iter() {
                row[k] = v.clone();
            }
            claims.extend(a(&row["claims"]).to_vec());
            comparisons.push(row);
        }
        let class = if comparisons
            .iter()
            .any(|c| c["classification"] == "CONFLICT")
        {
            "CONFLICT"
        } else if comparisons
            .iter()
            .any(|c| c["classification"] == "ATTRIBUTED_ONLY")
        {
            "ATTRIBUTED_ONLY"
        } else {
            "UNKNOWN"
        };
        return Ok(
            json!({"classification":class,"value":null,"comparisons":comparisons,"claims":claims,"reason":"逐主体比较来源陈述；缺证项保持UNKNOWN，不据此排名或判定不具备能力。"}),
        );
    }
    let evidence: Vec<Value> = a(&result["claims"])
        .iter()
        .filter(|c| {
            (!truthy(&plan["subject_id"]) || c["subject_id"] == plan["subject_id"])
                && c["predicate_id"] == plan["predicate_id"]
                && (nul(plan, "object_value") || c["value"] == plan["object_value"])
        })
        .cloned()
        .collect();
    let matches: Vec<Value> = evidence
        .iter()
        .filter(|c| current(c, input))
        .cloned()
        .collect();
    if matches.is_empty() {
        let mut r = unknown(json!(
            "没有符合范围的现行证据；缺失不代表不存在，计划不算当前能力。"
        ));
        r["claims"] = json!(evidence);
        return Ok(r);
    }
    let predicate = a(&schema["predicates"])
        .iter()
        .find(|p| p["id"] == plan["predicate_id"]);
    let mut groups: Vec<(Value, Vec<&Value>)> = Vec::new();
    for c in &matches {
        let k = json!([
            c["subject_id"],
            c["predicate_id"],
            c["unit"],
            c["scope"],
            c["effective_from"]
        ]);
        if let Some((_, g)) = groups.iter_mut().find(|(x, _)| x == &k) {
            g.push(c)
        } else {
            groups.push((k, vec![c]));
        }
    }
    let conflict = predicate.is_some_and(|p| p["cardinality"] == "ONE")
        && groups.iter().any(|(_, g)| {
            (!has(g[0], "effective_from") || !g[0]["effective_from"].is_null())
                && g.iter().all(|c| c["comparator"] == "EQ")
                && g.iter()
                    .map(|c| js_stringify(&c["value"]))
                    .collect::<HashSet<_>>()
                    .len()
                    > 1
        });
    if conflict {
        return Ok(
            json!({"classification":"CONFLICT","value":null,"reason":"同主体、属性、范围、单位和明确时间下出现互斥陈述，未自动裁决。","claims":matches}),
        );
    }
    let values = if plan["template"] == "ENTITIES" {
        let mut out = Vec::new();
        for c in &matches {
            if !out.contains(&c["subject_id"]) {
                out.push(c["subject_id"].clone())
            }
        }
        out
    } else {
        matches.iter().map(|c| c["value"].clone()).collect()
    };
    Ok(
        json!({"classification":"ATTRIBUTED_ONLY","value":values,"reason":"按有限模板返回来源陈述；保留量词、范围和时间，不构成独立核实。","claims":matches}),
    )
}
pub fn execute(op: &str, p: &Value) -> Result<Value> {
    match op {
        "validate_input" => validate_input(&p["body"]),
        "validate_build_input" => validate_build_input(&p["input"]),
        "extraction_context" => Ok(extraction_context(&p["source"], &p["unit"])),
        "normalize_schema_envelope" => {
            let mut n = Vec::new();
            let z = normalize_schema_envelope(&p["raw"], &mut n)?;
            Ok(json!({"schema":z,"normalization":n}))
        }
        "validate_schema" => {
            let mut n = a(&p["normalization"]).to_vec();
            let z = validate_schema(&p["schema"], &p["input"], &mut n)?;
            Ok(json!({"schema":z,"normalization":n}))
        }
        "query_plan_issues" => Ok(query_plan_issues(&p["schema"], &p["input"])),
        "answer_plan" => answer_plan(&p["result"], &p["input"], &p["plan"]),
        "answer_cq" => {
            let plan = a(&p["result"]["schema"]["cq_plans"])
                .iter()
                .find(|x| x["cq_id"] == p["cq_id"])
                .unwrap_or(&Value::Null);
            answer_plan(&p["result"], &p["input"], plan)
        }
        _ => Err(error("CORE_OPERATION_UNSUPPORTED", "未知模型操作")),
    }
}
pub fn validate_input(body: &Value) -> Result<Value> {
    ensure(
        body["cqs"].is_array() && !a(&body["cqs"]).is_empty() && a(&body["cqs"]).len() <= 12,
        "需要1–12条CQ",
    )?;
    ensure(
        body["sources"].is_array()
            && !a(&body["sources"]).is_empty()
            && a(&body["sources"]).len() <= 8,
        "需要1–8份文本资料",
    )?;
    ensure(body["consent"] == true, "请明确允许向所配模型发送本次资料")?;
    let mut qs = Vec::new();
    for q in a(&body["cqs"]) {
        txt(q, 500, "CQ")?;
        qs.push(s(q).trim_matches(js_ws).to_owned());
    }
    ensure(
        qs.iter().collect::<HashSet<_>>().len() == qs.len(),
        "CQ重复，请先合并",
    )?;
    let mut sources = Vec::new();
    for (i, source) in a(&body["sources"]).iter().enumerate() {
        txt(&source["content"], usize::MAX, "资料正文")?;
        txt(&source["title"], 180, "资料标题")?;
        let mut row = json!({"id":format!("source_{}",i+1),"title":s(&source["title"]).trim_matches(js_ws),"content":source["content"],"source_role":"UPLOADED_ORIGIN_UNCONFIRMED"});
        if truthy(&source["parsing"]) {
            row["parsing"] = source["parsing"].clone();
        }
        row["sha256"] = json!(text_sha(s(&source["content"])));
        sources.push(row);
    }
    let defs = if body["definitions"].is_string() {
        s(&body["definitions"]).trim_matches(js_ws)
    } else {
        ""
    };
    ensure(len(defs) <= 3000, "业务定义过长")?;
    ensure(
        !truthy(&body["as_of"]) || (body["as_of"].is_string() && valid_date(s(&body["as_of"]))),
        "查询日期无效",
    )?;
    let name = if truthy(&body["name"]) {
        body["name"].clone()
    } else {
        json!("未命名知识模型")
    };
    txt(&name, 100, "名称")?;
    Ok(
        json!({"name":s(&name).trim_matches(js_ws),"definitions":defs,"as_of":if truthy(&body["as_of"]){body["as_of"].clone()}else{Value::Null},"cqs":qs.iter().enumerate().map(|(i,q)|json!({"id":format!("CQ-{:02}",i+1),"question":q})).collect::<Vec<_>>(),"sources":sources,"publication_allowed":false}),
    )
}
pub fn validate_build_input(input: &Value) -> Result<Value> {
    let check = |ok, msg| {
        if ok {
            Ok(())
        } else {
            Err(error("SYSTEM_BUILD_PREFLIGHT", msg))
        }
    };
    check(
        input["sources"].is_array()
            && !a(&input["sources"]).is_empty()
            && a(&input["sources"]).len() <= 8,
        "实际构建需要1–8份资料",
    )?;
    check(
        a(&input["sources"]).iter().all(|s| {
            s["content"].is_string()
                && !crate::common::s(&s["content"])
                    .trim_matches(js_ws)
                    .is_empty()
        }),
        "实际构建资料正文不能为空",
    )?;
    check(
        a(&input["sources"])
            .iter()
            .all(|s| text_sha(crate::common::s(&s["content"])) == crate::common::s(&s["sha256"])),
        "资料内容哈希不匹配",
    )?;
    Ok(input.clone())
}
pub fn extraction_context(source: &Value, unit: &Value) -> Value {
    let blocks = a(&source["parsing"]["blocks"]);
    let us = unit["start"].as_u64().unwrap_or(0) as usize;
    let ue = unit["end"].as_u64().unwrap_or(0) as usize;
    let heads: Vec<_> = blocks
        .iter()
        .filter(|b| {
            b["kind"] == "section_header" && b["end"].as_u64().is_some_and(|x| x <= us as u64)
        })
        .collect();
    let mut context = Vec::new();
    for b in heads.iter().skip(heads.len().saturating_sub(2)) {
        context.push(json!({"kind":"preceding_heading","start":b["start"],"end":b["end"],"text":slice16(s(&source["content"]),b["start"].as_u64().unwrap_or(0)as usize,b["end"].as_u64().unwrap_or(0)as usize)}));
    }
    for b in blocks.iter().filter(|b| {
        b["kind"] == "table"
            && b["start"].as_u64().is_some_and(|x| x < ue as u64)
            && b["end"].as_u64().is_some_and(|x| x > us as u64)
    }) {
        let start = b["start"].as_u64().unwrap_or(0) as usize;
        let text = slice16(
            s(&source["content"]),
            start,
            b["end"].as_u64().unwrap_or(0) as usize,
        );
        let header = text.split_inclusive('\n').take(2).collect::<String>();
        if !header.is_empty() {
            context.push(
                json!({"kind":"table_header","start":start,"end":start+len(&header),"text":header}),
            );
        }
    }
    json!({"version":"original_layout_context_v1","fragments":context,"rule":"只用于解释主体和表格列归属；引用仍须来自source_window内连续原文，不把上下文标题当成事实。"})
}
