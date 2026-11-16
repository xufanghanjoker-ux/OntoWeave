//! Legacy capability directory/signature and finite parameter binding only.
use crate::common::*;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashSet;
fn has(v: &Value, k: &str) -> bool {
    v.get(k).is_some()
}
fn version_hash(job: &Value) -> String {
    let mut z = json!({});
    if has(job, "input") {
        z["input"] = job["input"].clone();
    }
    for k in ["schema", "claims"] {
        if has(&job["result"], k) {
            z[k] = job["result"][k].clone();
        }
    }
    if has(job, "status") {
        z["status"] = job["status"].clone();
    }
    sha(&z)
}
fn contract() -> Value {
    json!({"version":"structure_query_v1","selection":"ALL requires one mode containing all requested subjects; WITHIN enumerates modes inside the requested set","returns":"all structural ENTITY role bindings AND structural STRING explanations for each complete selected mode, plus matching direct relationships","predicate_id":"catalog anchor, not an exclusive result predicate filter","completeness":"a mode with missing participant bindings is not a complete answer"})
}
fn uniq(xs: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    for v in xs {
        if !out.contains(v) {
            out.push(v.clone())
        }
    }
    out
}
pub fn create_catalog(job: &Value, parent: &Value) -> Result<Value> {
    let schema = &job["result"]["schema"];
    ensure(truthy(schema), "当前版本没有已校验本体")?;
    let mut plans = Vec::new();
    for p in a(&schema["cq_plans"]) {
        plans.push(p.clone());
        if p["template"] == "COMPARE" {
            let mut f = p.clone();
            f["template"] = json!("FACTS");
            f["subject_id"] = p["subject_ids"][0].clone();
            f.as_object_mut().unwrap().remove("subject_ids");
            f["structural_projection"] = json!(true);
            plans.push(f);
        }
    }
    let structural: Vec<_> = a(&schema["predicates"])
        .iter()
        .filter(|p| crate::structure::is_structural_predicate(schema, p))
        .cloned()
        .collect();
    if !structural.is_empty()
        && a(&job["result"]["claims"]).iter().any(|c| {
            structural
                .iter()
                .any(|p| p["id"] == c["predicate_id"] && p["value_type"] == "ENTITY")
        })
    {
        plans.push(json!({"template":"STRUCTURE","predicate_id":structural[0]["id"],"subject_id":null,"subject_ids":[],"object_value":null,"structural_projection":true}));
    }
    let mut caps: Vec<Value> = Vec::new();
    for p in &plans {
        let template = s(&p["template"]);
        if !["FACTS", "ENTITIES", "COMPARE", "STRUCTURE"].contains(&template) {
            continue;
        }
        let pred = a(&schema["predicates"])
            .iter()
            .find(|x| x["id"] == p["predicate_id"])
            .ok_or_else(|| fail("能力引用未知谓词"))?;
        let ids = if ["COMPARE", "STRUCTURE"].contains(&template) {
            a(&p["subject_ids"]).to_vec()
        } else if truthy(&p["subject_id"]) {
            vec![p["subject_id"].clone()]
        } else {
            vec![]
        };
        let mut types = uniq(
            &ids.iter()
                .map(|id| {
                    a(&schema["entities"])
                        .iter()
                        .find(|e| &e["id"] == id)
                        .map(|e| e["type"].clone())
                        .unwrap_or(Value::Null)
                })
                .collect::<Vec<_>>(),
        );
        types.sort_by(|a, b| s(a).encode_utf16().cmp(s(b).encode_utf16()));
        let mut stypes = if types.is_empty() {
            uniq(
                &a(&schema["entities"])
                    .iter()
                    .map(|e| e["type"].clone())
                    .collect::<Vec<_>>(),
            )
        } else {
            types
        };
        stypes.sort_by(|a, b| s(a).encode_utf16().cmp(s(b).encode_utf16()));
        let mut semantics: Vec<Value> = stypes
            .iter()
            .map(|id| {
                a(&schema["entity_types"])
                    .iter()
                    .find(|t| &t["id"] == id)
                    .cloned()
                    .unwrap_or(Value::Null)
            })
            .collect();
        semantics.sort_by(|a, b| locale_cmp(s(&a["id"]), s(&b["id"])));
        let mut sig = json!({"template":template});
        if template == "STRUCTURE" {
            sig["structural_contract"] = json!(structural);
        }
        let mut pp = json!({"id":pred["id"],"label":pred["label"],"value_type":pred["value_type"]});
        if has(pred, "unit") {
            pp["unit"] = pred["unit"].clone();
        }
        pp["cardinality"] = if truthy(&pred["cardinality"]) {
            pred["cardinality"].clone()
        } else {
            Value::Null
        };
        sig["predicate"] = pp;
        sig["subject_types"] = json!(semantics);
        sig["definitions"] = if truthy(&job["input"]["definitions"]) {
            job["input"]["definitions"].clone()
        } else {
            json!("")
        };
        let signature = sha(&sig);
        let ci = if let Some(i) = caps.iter().position(|c| c["signature"] == signature) {
            i
        } else {
            let prior: Vec<_> = a(&parent["capabilities"])
                .iter()
                .filter(|c| c["signature"] == signature)
                .collect();
            let id = if prior.len() == 1 {
                prior[0]["id"].clone()
            } else {
                json!(format!(
                    "cap_{}",
                    &sha(
                        &json!({"signature":signature,"ambiguous_parent":if prior.len()>1{job["id"].clone()}else{Value::Null}})
                    )[..24]
                ))
            };
            let mut cap = json!({"id":id,"signature":signature,"template":template});
            if template == "STRUCTURE" {
                cap["execution_contract"] = contract();
            }
            cap["predicate_id"] = pred["id"].clone();
            cap["predicate"] = pred.clone();
            cap["status"] = json!(if prior.len() > 1 {
                "AMBIGUOUS"
            } else {
                "AVAILABLE"
            });
            cap["subject_types"] = json!(stypes);
            cap["parameters"] = json!(match template {
                "STRUCTURE" => vec![
                    "subject_ids",
                    "object_value",
                    "structure_kind",
                    "structure_match"
                ],
                "COMPARE" => vec!["subject_ids", "object_value"],
                "FACTS" => vec!["subject_id", "object_value"],
                _ => vec!["object_value"],
            });
            let mut defaults = json!({});
            if template == "STRUCTURE" {
                defaults["subject_ids"] = json!(a(&p["subject_ids"]));
                defaults["structure_kind"] = if truthy(&p["structure_kind"]) {
                    p["structure_kind"].clone()
                } else {
                    Value::Null
                };
                defaults["structure_match"] = if truthy(&p["structure_match"]) {
                    p["structure_match"].clone()
                } else {
                    json!("ALL")
                };
            } else if template == "COMPARE" {
                defaults["subject_ids"] = json!(a(&p["subject_ids"]));
            } else if template == "FACTS" && has(p, "subject_id") {
                defaults["subject_id"] = p["subject_id"].clone();
            }
            if has(p, "object_value") {
                defaults["object_value"] = p["object_value"].clone();
            }
            cap["defaults"] = defaults;
            cap["cq_ids"] = json!([]);
            cap["example_questions"] = json!([]);
            caps.push(cap);
            caps.len() - 1
        };
        let c = &mut caps[ci];
        if !truthy(&p["structural_projection"]) && !a(&c["cq_ids"]).contains(&p["cq_id"]) {
            c["cq_ids"].as_array_mut().unwrap().push(p["cq_id"].clone());
        }
        let question = a(&job["input"]["cqs"])
            .iter()
            .find(|q| q["id"] == p["cq_id"])
            .map(|q| q["question"].clone())
            .unwrap_or(Value::Null);
        if truthy(&question) && !truthy(&p["structural_projection"]) {
            c["example_questions"]
                .as_array_mut()
                .unwrap()
                .push(question);
        }
        if template == "STRUCTURE" && a(&c["example_questions"]).is_empty() {
            c["example_questions"]
                .as_array_mut()
                .unwrap()
                .push(json!("所选主体有哪些原文明示的关系、组合模式和角色分工？"));
        }
        if truthy(&p["structural_projection"])
            && template != "STRUCTURE"
            && a(&c["example_questions"]).is_empty()
        {
            let entity = a(&schema["entities"])
                .iter()
                .find(|e| e["id"] == p["subject_id"]);
            let name = entity
                .map(|e| s(&e["name"]))
                .filter(|x| !x.is_empty())
                .unwrap_or(s(&p["subject_id"]));
            c["example_questions"]
                .as_array_mut()
                .unwrap()
                .push(json!(format!("{}的{}是什么？", name, s(&pred["label"]))));
        }
    }
    let available: HashSet<String> = caps.iter().map(|c| js_stringify(&c["id"])).collect();
    for old in a(&parent["capabilities"]) {
        if available.contains(&js_stringify(&old["id"]))
            || caps.iter().any(|c| c["id"] == old["id"])
        {
            continue;
        }
        let n = a(&parent["capabilities"])
            .iter()
            .filter(|c| c["id"] == old["id"])
            .count();
        let mut p = old.clone();
        p["status"] = json!("UNAVAILABLE");
        p["reason"] = json!(if n > 1 {
            "父版本ID存在歧义，不能绑定；需要重新确认。"
        } else {
            "当前版本的语义、谓词或适用范围与旧能力不一致；旧ID保留供审计，需要重新确认。"
        });
        caps.push(p);
    }
    Ok(
        json!({"version":"capabilities_v1","task_id":job["id"],"task_hash":version_hash(job),"capabilities":caps}),
    )
}
pub fn bind(
    job: &Value,
    catalog: &Value,
    id: &Value,
    params: &Value,
    question: &Value,
) -> Result<Value> {
    ensure(
        catalog["task_id"] == job["id"],
        "能力目录不属于当前任务版本",
    )?;
    ensure(
        catalog["task_hash"] == version_hash(job),
        "任务内容已变化，请重新生成能力目录",
    )?;
    let found: Vec<_> = a(&catalog["capabilities"])
        .iter()
        .filter(|c| &c["id"] == id)
        .collect();
    ensure(found.len() == 1, "查询能力不存在或ID不唯一")?;
    let cap = found[0];
    ensure(
        cap["status"] == "AVAILABLE",
        if cap["status"] == "AMBIGUOUS" {
            "父版本能力映射有歧义，不能自动绑定"
        } else {
            "旧能力在当前版本不可用，语义或谓词绑定变化后需重新确认"
        },
    )?;
    let current = create_catalog(job, &Value::Null)?;
    let c = a(&current["capabilities"])
        .iter()
        .find(|c| c["signature"] == cap["signature"]);
    ensure(
        c.is_some_and(|c| {
            c["predicate_id"] == cap["predicate_id"]
                && sha(&c["predicate"]) == sha(&cap["predicate"])
                && sha(&c["parameters"]) == sha(&cap["parameters"])
                && sha(&c["subject_types"]) == sha(&cap["subject_types"])
        }),
        "能力语义与当前本体不一致",
    )?;
    ensure(params.is_object(), "参数必须是对象")?;
    ensure(
        params
            .as_object()
            .unwrap()
            .keys()
            .all(|k| a(&cap["parameters"]).contains(&json!(k))),
        "查询包含不允许的参数",
    )?;
    ensure(
        !truthy(question) || has(params, "object_value"),
        "新问题必须显式指定object_value，不继承种子目标",
    )?;
    let mut values = cap["defaults"].clone();
    for (k, v) in params.as_object().unwrap() {
        values[k] = v.clone();
    }
    let entities = &job["result"]["schema"]["entities"];
    let known = |id: &Value| {
        a(entities)
            .iter()
            .any(|e| &e["id"] == id && a(&cap["subject_types"]).contains(&e["type"]))
    };
    let template = s(&cap["template"]);
    let subject_ids = a(&values["subject_ids"]);
    if template == "STRUCTURE" {
        ensure(
            values["subject_ids"].is_array()
                && (1..=8).contains(&subject_ids.len())
                && uniq(subject_ids).len() == subject_ids.len()
                && subject_ids.iter().all(known)
                && (values.get("structure_kind") == Some(&Value::Null)
                    || ["RELATION", "COMBINATION", "COMPARISON", "COMPOSITION"]
                        .contains(&s(&values["structure_kind"])))
                && ["ALL", "WITHIN"].contains(&s(&values["structure_match"])),
            "结构查询需绑定已知主体和合法类型",
        )?;
    }
    if template == "COMPARE" {
        ensure(
            values["subject_ids"].is_array()
                && (2..=8).contains(&subject_ids.len())
                && uniq(subject_ids).len() == subject_ids.len()
                && subject_ids.iter().all(known),
            "比较需要2–8个不重复、类型匹配的已知主体",
        )?;
    }
    if template == "FACTS" {
        ensure(
            values["subject_id"].is_string() && known(&values["subject_id"]),
            "主体未知或类型不匹配",
        )?;
    }
    let value = &values["object_value"];
    let is_null = values.get("object_value") == Some(&Value::Null);
    if !is_null {
        if cap["predicate"]["value_type"] == "NUMBER" {
            ensure(
                value.is_number() && value.as_f64().is_some_and(f64::is_finite),
                "目标值必须是有限数值",
            )?;
        } else if cap["predicate"]["value_type"] == "ENTITY" {
            ensure(
                value.is_string() && a(entities).iter().any(|e| e["id"] == *value),
                "目标实体未知",
            )?;
        } else {
            ensure(
                value.is_string()
                    && !s(value).trim_matches(js_ws).is_empty()
                    && len(s(value)) <= 1000,
                "目标值必须是非空文本",
            )?;
        }
    }
    if template == "ENTITIES" {
        ensure(!is_null, "筛选实体需要明确目标值")?;
    }
    let qt = if truthy(question) {
        question.clone()
    } else {
        cap["example_questions"]
            .get(0)
            .filter(|v| truthy(v))
            .cloned()
            .unwrap_or(json!(""))
    };
    let temporal = Regex::new(
        r"(?i)[0-9]{4}[-年/][0-9]{1,2}|历史|当时|截至|生效|修订|as of|effective|amendment|previously",
    )
    .unwrap();
    ensure(
        !truthy(question) || !temporal.is_match(s(question)),
        "当前能力未实现完整时间语义",
    )?;
    let yes = Regex::new(
        r"(?i)是否|有没有|有无|能否|是不是|^(?:does|do|is|are|can|has|have)(?:$|[^A-Za-z0-9_])",
    )
    .unwrap();
    ensure(
        !yes.is_match(s(&qt))
            || !is_null
            || (template == "STRUCTURE"
                && values["structure_kind"] == "COMBINATION"
                && subject_ids.len() >= 2
                && values["structure_match"] == "ALL"),
        "本次问题缺少目标约束，需要澄清",
    )?;
    let mut input = job["input"].clone();
    input["cqs"] = json!([{"id":"QUERY","question":qt}]);
    let mut plan = json!({"cq_id":"QUERY","template":cap["template"],"predicate_id":cap["predicate_id"],"subject_id":if template=="FACTS"{values["subject_id"].clone()}else{Value::Null}});
    if ["COMPARE", "STRUCTURE"].contains(&template) {
        plan["subject_ids"] = json!(subject_ids);
    }
    if template == "STRUCTURE" {
        plan["structure_kind"] = values["structure_kind"].clone();
        plan["structure_match"] = values["structure_match"].clone();
    }
    if has(&values, "object_value") {
        plan["object_value"] = value.clone();
    }
    let issues = crate::model::query_plan_issues(&json!({"cq_plans":[plan]}), &input);
    ensure(a(&issues).is_empty(), "本次问题缺少目标约束，需要澄清")?;
    Ok(json!({"capability_id":cap["id"],"params":values,"plan":plan,"input":input,"issues":issues}))
}
pub fn execute(op: &str, p: &Value) -> Result<Value> {
    match op {
        "create_catalog" => create_catalog(
            &p["job"],
            p.get("parentCatalog")
                .unwrap_or(&p["options"]["parentCatalog"]),
        ),
        "bind" => bind(
            &p["job"],
            &p["catalog"],
            p.get("capabilityId").unwrap_or(&p["capability_id"]),
            p.get("params").unwrap_or(&json!({})),
            p.get("question").unwrap_or(&p["options"]["question"]),
        ),
        _ => Err(error("CORE_OPERATION_UNSUPPORTED", "未知能力操作")),
    }
}
