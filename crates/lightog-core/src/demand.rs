//! M1 legacy validators behind the unified finite-number process boundary.
use crate::common::*;
use serde_json::{json, Value};
fn old<T>(r: lightog_demand::Result<T>) -> Result<T> {
    r.map_err(|e| {
        let message = match e.code {
            "M1_SCOPE_SHAPE" => "内部学习范围格式无效",
            "M1_SCOPE_SUBJECTS" => "内部主体范围无效",
            "M1_SCOPE_SUBJECT" => "内部主体格式无效",
            "M1_SCOPE_MENTION" => "内部主体原文提及格式无效",
            "M1_SCOPE_ANCHOR" => "内部主体没有原文锚点",
            "M1_SCOPE_CONDITION" => "内部条件没有原文依据",
            "M1_SCOPE_LIST" => "内部学习范围字段无效",
            "M1_STRUCTURE_COVERAGE" => "结构需求未覆盖实际问题",
            "M1_STRUCTURE_REQUIREMENT" => "需求主体、模式或说明无效",
            "M1_STRUCTURE_RELATION" => "关系需求必须明确合法结构类别及ALL/WITHIN集合语义",
            "M1_STRUCTURE_GROUP" => "主体集合称呼未绑定唯一已评审群组",
            "M1_QUERY_INTENT" => "问题意图缺失或无效",
            "M1_QUERY_RELEVANCE" => "知识查询相关性缺失或无效",
            "M1_QUERY_CLARIFICATION_TYPE" => "澄清标识无效",
            "M1_QUERY_CLARIFICATION" => "澄清须说明需要用户确定的内容",
            _ => e.code,
        };
        error(e.code, message)
    })
}
pub fn execute(op: &str, p: &Value) -> Result<Value> {
    match op {
        "scope_validate" => {
            let result = lightog_demand::production::validate_scope(p);
            if let Err(e) = &result {
                if e.code == "M1_SCOPE_ANCHOR" || e.code == "M1_SCOPE_CONDITION" {
                    let mut relaxed = p.clone();
                    if !relaxed["options"].is_object() {
                        relaxed["options"] = json!({});
                    }
                    relaxed["options"]["tolerateInvalidCandidates"] = json!(true);
                    relaxed["raw"]["targets"] = json!([]);
                    relaxed["raw"]["internal_questions"] = json!([]);
                    if e.code == "M1_SCOPE_ANCHOR" {
                        relaxed["raw"]["conditions"] = json!([]);
                    }
                    if let Ok(v) = lightog_demand::production::validate_scope(&relaxed) {
                        let rows = &v["rejected_candidates"];
                        let message = if e.code == "M1_SCOPE_ANCHOR" {
                            format!(
                                "内部主体没有原文锚点：{}",
                                a(&rows["subject_errors"])
                                    .iter()
                                    .map(s)
                                    .collect::<Vec<_>>()
                                    .join("；")
                            )
                        } else {
                            format!(
                                "内部条件没有原文依据：{}",
                                a(&rows["condition_errors"])
                                    .iter()
                                    .map(|v| format!(
                                        "第{}项 {} 不在当前块中；保留原文空格与换行，不改写条件",
                                        v["index"].as_u64().unwrap_or(0) + 1,
                                        js_stringify(&v["quote"])
                                    ))
                                    .collect::<Vec<_>>()
                                    .join("；")
                            )
                        };
                        return Err(error(e.code, message));
                    }
                }
            }
            old(result)
        }
        "scope_candidates" => old(lightog_demand::production::candidates(&p["rows"])),
        "structure_intent" => old(lightog_demand::production::structure_intent(p)),
        "query_intent" => old(lightog_demand::production::query_intent(&p["raw"])),
        "scope_select" => {
            let ids = a(&p["raw"]["selected_subject_ids"]);
            ensure(
                p["raw"]["selected_subject_ids"].is_array()
                    && ids.len() <= 80
                    && ids.iter().enumerate().all(|(i, id)| {
                        !ids[..i].contains(id) && a(&p["candidates"]).iter().any(|c| c["id"] == *id)
                    }),
                "内部范围选择只能引用最多80个不同的已锚定候选标识",
            )?;
            Ok(json!(ids))
        }
        "scope_merge" => {
            let rows = a(&p["rows"]);
            let all = old(lightog_demand::production::candidates(&p["rows"]))?;
            let selected = p["options"].get("selectedSubjectIds").filter(|v| truthy(v));
            let mut seen = vec![];
            let mut subjects = vec![];
            for row in rows {
                for subject in a(&row["subjects"]) {
                    let key = sha(subject);
                    if !seen.contains(&key) {
                        seen.push(key);
                        subjects.push(subject.clone());
                    }
                }
            }
            let cid =
                |v: &Value| format!("candidate_{}", &sha(&json!([v["name"], v["kind"]]))[..24]);
            if let Some(ids) = selected {
                subjects.retain(|v| a(ids).contains(&json!(cid(v))));
            }
            let mut groups = vec![];
            for sub in &subjects {
                let id = cid(sub);
                if !groups.contains(&id) {
                    groups.push(id);
                }
            }
            ensure(
                groups.len() <= 80,
                "相关主体超过当前构建容量，已保存范围扫描结果，请缩小本次资料范围",
            )?;
            let collect = |key: &str, max: usize| {
                let mut v = vec![];
                for row in rows {
                    for x in a(&row[key]) {
                        if !v.contains(x) {
                            v.push(x.clone());
                        }
                    }
                }
                v.truncate(max);
                v
            };
            Ok(
                json!({"version":"internal_scope_v2","candidate_group_count":a(&all).len(),"unselected_candidate_group_count":selected.map(|s|a(&all).len()as i64-a(s).len()as i64).unwrap_or(0),"seed_ids":a(&p["input"]["cqs"]).iter().map(|v|v["id"].clone()).collect::<Vec<_>>(),"subjects":subjects,"targets":collect("targets",30),"conditions":collect("conditions",80),"internal_questions":collect("internal_questions",80),"rejected_subject_count":rows.iter().map(|r|a(&r["rejected_candidates"]["subject_errors"]).len()).sum::<usize>(),"rejected_condition_count":rows.iter().map(|r|a(&r["rejected_candidates"]["condition_errors"]).len()).sum::<usize>(),"coverage":if rows.iter().any(|r|truthy(&r["rejected_candidates"])){"SCANNED_WITH_REJECTED_PROPOSALS"}else{"SCANNED_NOT_SEMANTIC_EXHAUSTIVENESS_PROOF"},"source_hashes":a(&p["input"]["sources"]).iter().map(|v|json!({"id":v["id"],"sha256":v["sha256"]})).collect::<Vec<_>>(),"unit_count":rows.len(),"notice":"内部计划与主体线索，name保留原文提及，proposed_name仅为未确认命名建议；仍须本体、抽取和独立评审校验，不直接发布为事实。"}),
            )
        }
        "adapt" => {
            let r = json!({"wire_version":"lightog-production-demand/0.1","request_id":"core-adapt","operation":"adapt","payload":p});
            let raw = serde_json::to_vec(&r).unwrap();
            let req = old(lightog_demand::production::parse(&raw))?;
            let k = old(lightog_demand::Kernel::new())?;
            old(lightog_demand::production::execute(&req, &k))
        }
        _ => Err(error("CORE_OPERATION_UNKNOWN", op)),
    }
}
