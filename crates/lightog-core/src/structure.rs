//! Frozen structural contracts; no model execution or semantic certification.
use crate::common::*;
use crate::evidence::align_quote;
use serde_json::{json, Value};
use std::collections::HashSet;
pub const STRUCTURE_CONTRACT: &str = "structure_learning_v9";
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
fn kinds(v: &Value) -> bool {
    ["RELATION", "COMBINATION", "COMPARISON", "COMPOSITION"].contains(&s(v))
}
fn unique(v: &Value) -> bool {
    a(v).iter().map(js_stringify).collect::<HashSet<_>>().len() == a(v).len()
}
fn nonempty(v: &Value) -> bool {
    v.is_string() && !s(v).trim_matches(js_ws).is_empty()
}
fn offset(v: &Value) -> Option<usize> {
    v.as_u64().and_then(|x| usize::try_from(x).ok())
}
fn aligned_span(source: &Value, r: &Value) -> Value {
    json!({"source_id":source["id"],"source_sha256":source["sha256"],"quote":r["quote"],"start":r["start"],"end":r["end"]})
}
pub fn is_structural_predicate(schema: &Value, p: &Value) -> bool {
    !p.is_null()
        && (p["structural"] == true || a(&schema["structural_predicate_ids"]).contains(&p["id"]))
}
pub fn normalize_support_set(rows: Option<&Value>, input: &Value) -> Result<Option<Value>> {
    let Some(rows) = rows else { return Ok(None) };
    ensure(
        rows.is_array() && !a(rows).is_empty() && a(rows).len() <= 12,
        "多段证据集合无效",
    )?;
    let mut out = Vec::new();
    for e in a(rows) {
        let source = a(&input["sources"])
            .iter()
            .find(|s| s["id"] == e["source_id"])
            .ok_or_else(|| fail("多段证据来源或引文无效"))?;
        ensure(
            text_sha(s(&source["content"])) == s(&source["sha256"])
                && nonempty(&e["quote"])
                && len(s(&e["quote"])) <= 4000,
            "多段证据来源或引文无效",
        )?;
        let range = offset(&e["start"]).zip(offset(&e["end"]));
        if has(e, "start") || has(e, "end") {
            ensure(
                range.is_some_and(|(x, y)| y > x && y <= len(s(&source["content"]))),
                "多段证据位置无效",
            )?;
        }
        let r = if let Some((x, y)) =
            range.filter(|(x, y)| slice16(s(&source["content"]), *x, *y) == s(&e["quote"]))
        {
            json!({"start":x,"end":y,"quote":e["quote"]})
        } else {
            align_quote(source, s(&e["quote"]))?
        };
        ensure(
            nonempty(&e["role"]) && len(s(&e["role"])) <= 300,
            "多段证据需说明支持的角色/字段",
        )?;
        let row = json!({"source_id":source["id"],"source_sha256":source["sha256"],"start":r["start"],"end":r["end"],"quote":r["quote"],"role":e["role"],"offset_unit":"utf16_code_unit"});
        out.push(row);
    }
    Ok(Some(json!(out)))
}
pub fn support_valid(claim: &Value, sources: &Value) -> bool {
    a(&claim["support_set"]).iter().all(|e| {
        a(sources)
            .iter()
            .find(|s| s["id"] == e["source_id"])
            .is_some_and(|source| {
                text_sha(s(&source["content"])) == s(&source["sha256"])
                    && source["sha256"] == e["source_sha256"]
                    && offset(&e["start"])
                        .zip(offset(&e["end"]))
                        .is_some_and(|(x, y)| {
                            slice16(s(&source["content"]), x, y) == s(&e["quote"])
                        })
            })
    })
}
pub fn validate_structure_intent(raw: &Value, cqs: &Value, groups: &Value) -> Result<Value> {
    ensure(cqs.is_array(), "结构需求未覆盖实际问题")?;
    let rs = &raw["requirements"];
    ensure(
        rs.is_array()
            && a(rs).len() == a(cqs).len()
            && unique(&json!(a(rs)
                .iter()
                .map(|r| &r["cq_id"])
                .collect::<Vec<_>>())),
        "结构需求未覆盖实际问题",
    )?;
    for r in a(rs) {
        ensure(
            a(cqs).iter().any(|q| q["id"] == r["cq_id"])
                && ["ATTRIBUTE", "RELATIONSHIP"].contains(&s(&r["mode"]))
                && nonempty(&r["reason"]),
            "需求主体、模式或说明无效",
        )?;
        if r["mode"] == "RELATIONSHIP" {
            ensure(
                r["kinds"].is_array()
                    && !a(&r["kinds"]).is_empty()
                    && a(&r["kinds"]).iter().all(kinds)
                    && ["ALL", "WITHIN"].contains(&s(&r["structure_match"])),
                "关系需求必须明确合法结构类别及ALL/WITHIN集合语义",
            )?;
        }
        if has(r, "subject_group_id") {
            ensure(
                a(groups).len() == 1
                    && groups[0]["id"] == r["subject_group_id"]
                    && nonempty(&r["group_mention"])
                    && a(cqs)
                        .iter()
                        .find(|q| q["id"] == r["cq_id"])
                        .is_some_and(|q| s(&q["question"]).contains(s(&r["group_mention"]))),
                "主体集合称呼未绑定唯一已评审群组",
            )?;
        }
    }
    Ok(json!(a(rs)
        .iter()
        .map(|r| {
            let mut x = r.clone();
            if r["mode"] == "ATTRIBUTE" {
                x["kinds"] = json!([]);
                x["structure_match"] = json!("ALL");
            }
            x
        })
        .collect::<Vec<_>>()))
}
pub fn assert_structure_plans(schema: &Value, requirements: &Value) -> Result<()> {
    if !requirements.is_array() && !requirements.is_string() {
        return Err(error("CORE_TYPE_ERROR", "requirements is not iterable"));
    }
    for r in a(requirements) {
        if r["mode"] != "RELATIONSHIP" {
            continue;
        }
        let p = a(&schema["cq_plans"])
            .iter()
            .find(|p| p["cq_id"] == r["cq_id"])
            .unwrap_or(&Value::Null);
        if p["template"] == "UNKNOWN" {
            continue;
        }
        let pred = a(&schema["predicates"])
            .iter()
            .find(|x| x["id"] == p["predicate_id"])
            .unwrap_or(&Value::Null);
        let composition = a(&r["kinds"]).len() == 1
            && r["kinds"][0] == "COMPOSITION"
            && p["template"] == "FACTS"
            && pred["value_type"] == "ENTITY"
            && is_structural_predicate(schema, pred);
        let m = if truthy(&p["structure_match"]) {
            s(&p["structure_match"])
        } else {
            "ALL"
        };
        ensure(composition||(p["template"]=="STRUCTURE"&&(!truthy(&p["structure_kind"])||a(&r["kinds"]).contains(&p["structure_kind"]))&&m==s(&r["structure_match"])),format!("问题 {} 询问{}结构及角色，不能用原有文本属性逐主体介绍代替。请按需求编译STRUCTURE/{}，确无证据时UNKNOWN",s(&r["cq_id"]),a(&r["kinds"]).iter().map(s).collect::<Vec<_>>().join("/"),s(&r["structure_match"])))?;
        for k in a(&r["kinds"])
            .iter()
            .filter(|k| **k == "COMBINATION" || **k == "COMPARISON")
        {
            ensure(a(&schema["entities"]).iter().any(|e|e["structure_kind"]==*k),format!("结构查询缺少 {} 模式元数据。模式实体需显式包含structure_kind与participant_ids，不可仅写ontology_pattern类型名",s(k)))?;
        }
    }
    Ok(())
}
pub fn validate_structure_selection(
    raw: &Value,
    candidates: &Value,
    requirements: &Value,
) -> Result<Value> {
    ensure(
        candidates.is_array() && requirements.is_array(),
        "结构范围裁决未覆盖全部候选",
    )?;
    ensure(
        raw["items"].is_array()
            && a(&raw["items"]).len() == a(candidates).len()
            && unique(&json!(a(&raw["items"])
                .iter()
                .map(|r| &r["candidate_id"])
                .collect::<Vec<_>>())),
        "结构范围裁决未覆盖全部候选",
    )?;
    let active: Vec<_> = a(requirements)
        .iter()
        .filter(|r| r["mode"] == "RELATIONSHIP")
        .collect();
    let allowed: Vec<_> = active
        .iter()
        .flat_map(|r| a(&r["kinds"]))
        .cloned()
        .collect();
    let mut rows = a(&raw["items"]).to_vec();
    for r in &mut rows {
        ensure(
            a(candidates).iter().any(|c| c["id"] == r["candidate_id"])
                && ["ADMIT", "OUT_OF_SCOPE"].contains(&s(&r["decision"]))
                && kinds(&r["kind"])
                && nonempty(&r["reason"]),
            "结构范围裁决引用或类型无效",
        )?;
        if r["decision"] == "ADMIT"
            && active.len() == a(requirements).len()
            && !allowed.contains(&r["kind"])
        {
            r["normalization"] = json!({"model_decision":"ADMIT","rule":"STRUCTURE_KIND_OUTSIDE_REQUIREMENTS","required_kinds":allowed.iter().fold(Vec::<Value>::new(),|mut xs,x|{if !xs.contains(x){xs.push(x.clone())}xs})});
            r["decision"] = json!("OUT_OF_SCOPE");
            r["reason"] = json!(format!(
                "程序范围约束：该结构类型不属于本轮需求；保留线索供后续提问。原模型理由：{}",
                s(&r["reason"])
            ));
        }
    }
    Ok(json!(rows))
}
pub fn structure_reference_menu(candidates: &Value, claims: &Value) -> Value {
    json!({"candidates":a(candidates).iter().enumerate().map(|(i,c)|{let mut r=c.clone();r["id"]=json!(format!("C{}",i+1));r}).collect::<Vec<_>>(),"claims":a(claims).iter().enumerate().map(|(i,c)|{let mut r=c.clone();r["id"]=json!(format!("F{}",i+1));r}).collect::<Vec<_>>()})
}
pub fn restore_structure_references(
    raw: &Value,
    candidates: &Value,
    claims: &Value,
) -> Result<Value> {
    ensure(raw["items"].is_array(), "结构裁决缺少items")?;
    let mut out = raw.clone();
    let mut rows = Vec::new();
    for r in a(&raw["items"]) {
        let ci = (0..a(candidates).len())
            .find(|i| s(&r["candidate_id"]) == format!("C{}", i + 1))
            .ok_or_else(|| fail("候选引用必须使用当前菜单的C编号，不能使用CQ id或其他批次编号"))?;
        let mut row = r.clone();
        row["candidate_id"] = candidates[ci]["id"].clone();
        if has(r, "claim_ids") {
            ensure(r["claim_ids"].is_array(), "声明引用必须使用当前菜单的F编号")?;
            let mut ids = Vec::new();
            for id in a(&r["claim_ids"]) {
                let i = (0..a(claims).len())
                    .find(|i| s(id) == format!("F{}", i + 1))
                    .ok_or_else(|| fail("声明引用必须使用当前菜单的F编号"))?;
                ids.push(claims[i]["id"].clone());
            }
            row["claim_ids"] = json!(ids);
        }
        rows.push(row);
    }
    out["items"] = json!(rows);
    Ok(out)
}
pub fn structure_fragments(source: &Value, unit: &Value, context: &Value) -> Value {
    let mut out = Vec::new();
    let text = s(&unit["text"]);
    let base = offset(&unit["start"]).unwrap_or(0);
    let mut pos = 0;
    for line in text.split_inclusive('\n') {
        if line == "\n" {
            pos += 1;
            continue;
        }
        let end = base + pos + len(line);
        out.push(json!({"ref":format!("f{}",out.len()),"start":base+pos,"end":end,"text":slice16(s(&source["content"]),base+pos,end)}));
        pos += len(line);
    }
    for f in a(context) {
        if !out
            .iter()
            .any(|r| r["start"] == f["start"] && r["end"] == f["end"])
        {
            let mut r = json!({"ref":format!("h{}",out.len())});
            for (k, v) in f.as_object().into_iter().flatten() {
                r[k] = v.clone();
            }
            out.push(r);
        }
    }
    json!(out)
}
fn materialize_one(
    e: &Value,
    sources: &Value,
    fragments: &Value,
    provided: &Value,
) -> Result<Value> {
    let sr = if truthy(&e["evidence_ref"]) {
        &e["evidence_ref"]
    } else {
        &e["evidence"]["start_ref"]
    };
    let er = if truthy(&e["evidence_ref"]) {
        &e["evidence_ref"]
    } else if !has(&e["evidence"], "end_ref") {
        sr
    } else {
        &e["evidence"]["end_ref"]
    };
    if !truthy(sr) && !truthy(er) {
        return Ok(e.clone());
    }
    let x = a(fragments).iter().find(|f| &f["ref"] == sr);
    let y = a(fragments).iter().find(|f| &f["ref"] == er);
    ensure(x.is_some() && y.is_some(), "声明证据片段引用或范围无效")?;
    let (x, y) = (x.unwrap(), y.unwrap());
    let (start, end) = (
        offset(&x["start"]).unwrap_or(usize::MAX),
        offset(&y["end"]).unwrap_or(0),
    );
    ensure(
        x["source_id"] == y["source_id"]
            && (!truthy(&e["source_id"]) || e["source_id"] == x["source_id"])
            && end > start
            && end - start <= 4000,
        "声明证据片段引用或范围无效",
    )?;
    ensure(
        a(provided).iter().any(|p| {
            p["source_id"] == x["source_id"]
                && offset(&p["start"]).is_some_and(|v| v <= start)
                && offset(&p["end"]).is_some_and(|v| v >= end)
        }),
        "声明证据跨越未提供的原文范围",
    )?;
    let source = a(sources)
        .iter()
        .find(|s| s["id"] == x["source_id"])
        .ok_or_else(|| fail("声明证据来源无效"))?;
    let mut c = e.clone();
    c["source_id"] = source["id"].clone();
    c["quote"] = json!(slice16(s(&source["content"]), start, end));
    c["start"] = json!(start);
    c["end"] = json!(end);
    Ok(c)
}
pub fn materialize_claim_evidence(
    claims: &Value,
    sources: &Value,
    unit: &Value,
    fragments: &Value,
    provided: &Value,
) -> Result<Value> {
    map_array(Some(claims), "claims")?;
    let mut out = Vec::new();
    for original in a(claims) {
        let mut c = materialize_one(original, sources, fragments, provided)?;
        if truthy(&c["evidence"]) || truthy(&c["evidence_ref"]) {
            ensure(
                c["source_id"] == unit["source_id"]
                    && offset(&c["start"])
                        .zip(offset(&unit["start"]))
                        .is_some_and(|(x, y)| x >= y)
                    && offset(&c["end"])
                        .zip(offset(&unit["end"]))
                        .is_some_and(|(x, y)| x <= y),
                "声明主证据必须属于当前原文窗口",
            )?;
        }
        if truthy(&c["support_set"]) {
            ensure(c["support_set"].is_array(), "多段证据集合无效")?;
            c["support_set"] = json!(a(&c["support_set"])
                .iter()
                .map(|e| materialize_one(e, sources, fragments, provided))
                .collect::<Result<Vec<_>>>()?);
        }
        out.push(c);
    }
    Ok(json!(out))
}
pub fn validate_structure_discovery(
    raw: &Value,
    unit: &Value,
    source: &Value,
    options: &Value,
) -> Result<Value> {
    ensure(
        raw["candidates"].is_array() && a(&raw["candidates"]).len() <= 16,
        "结构候选列表无效",
    )?;
    let fragments = &options["fragments"];
    let collect = truthy(&options["collectErrors"]);
    let (mut candidates, mut issues, mut excluded) = (Vec::new(), Vec::new(), Vec::new());
    let (us, ue) = (
        offset(&unit["start"]).unwrap_or(0),
        offset(&unit["end"]).unwrap_or(0),
    );
    for (index, original) in a(&raw["candidates"]).iter().enumerate() {
        let checked = (|| -> Result<Option<Value>> {
            let mut c = original.clone();
            ensure(c.is_object(), "结构候选必须是对象")?;
            ensure(c["participants"].is_array(), "结构候选缺少参与者列表")?;
            if truthy(&c["evidence"]) {
                let first = a(fragments)
                    .iter()
                    .find(|f| f["ref"] == c["evidence"]["start_ref"]);
                let last = a(fragments)
                    .iter()
                    .find(|f| f["ref"] == c["evidence"]["end_ref"]);
                if first.zip(last).is_some_and(|(f, l)| {
                    [f, l].iter().all(|r| {
                        ["table_header", "preceding_heading"].contains(&s(&r["kind"]))
                            && offset(&r["end"]).is_some_and(|x| x <= us)
                    })
                }) {
                    excluded.push(json!({"index":index,"original":original,"reason":"AUXILIARY_CONTEXT_ONLY：仅引用当前窗口外的表头/标题，没有本块事实命题；辅助上下文不能单独发布关系。原始正文仍按所属窗口扫描。"}));
                    return Ok(None);
                }
                let r = first
                    .zip(last)
                    .and_then(|(f, l)| offset(&f["start"]).zip(offset(&l["end"])));
                ensure(r.is_some_and(|(x,y)|x>=us&&y<=ue&&y>x&&y-x<=4000),format!("结构证据ref范围无效：{}。只能逐字选择菜单ref，start_ref/end_ref须按正文顺序，不能把字符偏移当ref，也不能合并超过4000字符的多个独立结构",js_stringify(&c["evidence"])))?;
                let (x, y) = r.unwrap();
                c["quote"] = json!(slice16(s(&source["content"]), x, y));
            }
            for p in c["participants"].as_array_mut().unwrap() {
                ensure(p.is_object(), "结构参与者必须是对象")?;
                if truthy(&p["mention_ref"]) {
                    let f = a(fragments)
                        .iter()
                        .find(|f| f["ref"] == p["mention_ref"])
                        .ok_or_else(|| fail("参与者原文ref无效"))?;
                    ensure(
                        offset(&f["start"])
                            .zip(offset(&f["end"]))
                            .is_some_and(|(x, y)| {
                                slice16(s(&source["content"]), x, y) == s(&f["text"])
                            }),
                        "参与者原文ref无效",
                    )?;
                    let mut anchor = f;
                    if p["mention"].is_string() && !s(&f["text"]).contains(s(&p["mention"])) {
                        let origin = offset(&f["start"]).unwrap_or(0);
                        let mut matches: Vec<_> = a(fragments)
                            .iter()
                            .filter(|a| {
                                offset(&a["start"])
                                    .zip(offset(&a["end"]))
                                    .is_some_and(|(x, y)| {
                                        x >= us
                                            && y <= ue
                                            && slice16(s(&source["content"]), x, y) == s(&a["text"])
                                            && s(&a["text"]).contains(s(&p["mention"]))
                                            && x.abs_diff(origin) <= 2000
                                    })
                            })
                            .collect();
                        matches.sort_by_key(|a| offset(&a["start"]).unwrap_or(0).abs_diff(origin));
                        if !matches.is_empty()
                            && (matches.len() == 1
                                || offset(&matches[0]["start"]).unwrap_or(0).abs_diff(origin)
                                    < offset(&matches[1]["start"]).unwrap_or(0).abs_diff(origin))
                        {
                            anchor = matches[0];
                            p["anchor_resolution"] = json!({"method":"EXACT_NEAREST_VERIFIED_FRAGMENT","submitted_ref":p["mention_ref"],"resolved_ref":anchor["ref"]});
                        }
                    }
                    p["mention_quote"] = anchor["text"].clone();
                    p["mention_ref"] = anchor["ref"].clone();
                }
            }
            ensure(kinds(&c["kind"]), "结构类型无效")?;
            ensure(
                ["DIRECT", "REQUIRED_STRUCTURE", "IN_SCOPE_RELATION"].contains(&s(&c["relevance"])),
                "结构范围无效",
            )?;
            ensure(
                nonempty(&c["label"])
                    && len(s(&c["label"])) <= 150
                    && nonempty(&c["reason"])
                    && len(s(&c["reason"])) <= 800,
                "结构名称或范围理由无效",
            )?;
            ensure(
                nonempty(&c["quote"]) && len(s(&c["quote"])) <= 4000,
                "结构原文无效",
            )?;
            let mut local = source.clone();
            local["content"] = unit["text"].clone();
            if truthy(&source["parsing"]) {
                local["parsing"]["blocks"] = json!(a(&source["parsing"]["blocks"])
                    .iter()
                    .filter(|b| offset(&b["start"]).unwrap_or(usize::MAX) < ue
                        && offset(&b["end"]).unwrap_or(0) > us)
                    .map(|b| {
                        let mut r = b.clone();
                        r["start"] = json!(offset(&b["start"]).unwrap_or(0).max(us) - us);
                        r["end"] = json!(offset(&b["end"]).unwrap_or(0).min(ue) - us);
                        r
                    })
                    .collect::<Vec<_>>());
            }
            let aligned = align_quote(&local, s(&c["quote"]))?;
            ensure(
                (2..=12).contains(&a(&c["participants"]).len()),
                "结构至少需要两个参与者",
            )?;
            let mut support = Vec::new();
            for p in a(&c["participants"]) {
                ensure(
                    nonempty(&p["mention"])
                        && len(s(&p["mention"])) <= 300
                        && nonempty(&p["role"])
                        && len(s(&p["role"])) <= 300,
                    "结构参与者必须具有原文提及与具体角色",
                )?;
                if !s(&aligned["quote"]).contains(s(&p["mention"])) {
                    ensure(p["mention_quote"].is_string()&&s(&p["mention_quote"]).contains(s(&p["mention"])),format!("参与者 {} 不在quote中。不要用规范名称作mention；请复制当前unit中的原称，并给mention_quote引用包含它的完整表头/先行词。如表格行只含取值，主体从表头独立引用，不将两段拼接。",js_stringify(&p["mention"])))?;
                    let (mut a, offset) = match align_quote(&local, s(&p["mention_quote"])) {
                        Ok(a) => (a, us),
                        Err(e) => {
                            let fragment = a(fragments).iter().find(|f| {
                                offset(&f["start"])
                                    .zip(offset(&f["end"]))
                                    .is_some_and(|(x, y)| {
                                        slice16(s(&source["content"]), x, y) == s(&f["text"])
                                            && s(&f["text"]).contains(s(&p["mention_quote"]))
                                    })
                            });
                            let Some(f) = fragment else { return Err(e) };
                            (
                                align_quote(&json!({"content":f["text"]}), s(&p["mention_quote"]))?,
                                offset(&f["start"]).unwrap_or(0),
                            )
                        }
                    };
                    ensure(
                        s(&a["quote"]).contains(s(&p["mention"])),
                        "参与者原称与表头/先行词不一致",
                    )?;
                    a["start"] = json!(offset + a["start"].as_u64().unwrap_or(0) as usize);
                    a["end"] = json!(offset + a["end"].as_u64().unwrap_or(0) as usize);
                    let mut row = aligned_span(source, &a);
                    row["role"] = json!(format!("参与者身份与列归属：{}", s(&p["mention"])));
                    row["offset_unit"] = json!("utf16_code_unit");
                    support.push(row);
                }
            }
            ensure(
                unique(&json!(a(&c["participants"])
                    .iter()
                    .map(|p| &p["mention"])
                    .collect::<Vec<_>>())),
                "结构参与者重复",
            )?;
            let start = us + offset(&aligned["start"]).unwrap_or(0);
            let end = us + offset(&aligned["end"]).unwrap_or(0);
            let digest = sha(&json!([
                source["sha256"],
                start,
                end,
                c["kind"],
                a(&c["participants"])
                    .iter()
                    .map(|p| json!({"mention":p["mention"],"role":p["role"]}))
                    .collect::<Vec<_>>()
            ]));
            let id = format!("structure_{}", &digest[..24]);
            c["id"] = json!(id);
            c["structure_entity_id"] = json!(id);
            c["quote"] = aligned["quote"].clone();
            c["source_id"] = source["id"].clone();
            c["source_sha256"] = source["sha256"].clone();
            c["start"] = json!(start);
            c["end"] = json!(end);
            c["unit_id"] = unit["id"].clone();
            if !support.is_empty() {
                c["support_set"] = json!(support);
            }
            Ok(Some(c))
        })();
        match checked {
            Ok(Some(c)) => candidates.push(c),
            Ok(None) => (),
            Err(e) => {
                if !collect {
                    return Err(e);
                }
                issues.push(json!({"index":index,"candidate":original,"error":e.message}));
            }
        }
    }
    if collect {
        Ok(json!({"candidates":candidates,"issues":issues,"excluded":excluded}))
    } else {
        Ok(json!(candidates))
    }
}
pub fn validate_structure_repair(
    raw: &Value,
    issues: &Value,
    unit: &Value,
    source: &Value,
    options: &Value,
) -> Result<Value> {
    let protocol = |ok: bool, msg: &str| {
        if ok {
            Ok(())
        } else {
            Err(error("SYSTEM_REPAIR_PROTOCOL_INVALID", msg))
        }
    };
    protocol(raw["decisions"].is_array(), "候选修复须返回 decisions 数组")?;
    let ds = a(&raw["decisions"]);
    protocol(ds.iter().all(Value::is_object), "候选修复决定必须是对象")?;
    protocol(
        ds.len() == a(issues).len()
            && unique(&json!(ds.iter().map(|d| &d["index"]).collect::<Vec<_>>())),
        "候选修复未逐项回应",
    )?;
    for d in ds {
        protocol(
            a(issues).iter().any(|i| i["index"] == d["index"])
                && ["REPLACE", "OUT_OF_SCOPE"].contains(&s(&d["action"]))
                && nonempty(&d["reason"]),
            "候选修复引用、动作或理由无效",
        )?;
        if d["action"] == "REPLACE" {
            protocol(d["candidate"].is_object(),"REPLACE 必须提供完整 candidate 对象；若原文不支持该候选，应明确返回 OUT_OF_SCOPE，不能省略 candidate。")?;
        }
    }
    let (mut candidates, mut excluded) = (Vec::new(), Vec::new());
    for d in ds {
        if d["action"] == "REPLACE" {
            let v = validate_structure_discovery(
                &json!({"candidates":[d["candidate"]]}),
                unit,
                source,
                options,
            )?;
            ensure(v.is_array(), "结构候选修复结果无效")?;
            candidates.extend(a(&v).to_vec());
        } else {
            let old = a(issues).iter().find(|i| i["index"] == d["index"]).unwrap();
            excluded
                .push(json!({"index":d["index"],"original":old["candidate"],"reason":d["reason"]}));
        }
    }
    Ok(json!({"candidates":candidates,"excluded":excluded}))
}
pub fn attach_existing_query_roles(
    item: &Value,
    candidate: &Value,
    schema: &Value,
    claims: &Value,
) -> Value {
    let mut item = item.clone();
    if item["status"] != "COVERED" || item["coverage_mode"] != "STRUCTURE" {
        return item;
    }
    let plans: Vec<_> = a(&schema["cq_plans"])
        .iter()
        .filter(|p| a(&item["cq_ids"]).contains(&p["cq_id"]) && p["template"] == "STRUCTURE")
        .collect();
    let mut choices = Vec::new();
    for e in a(&schema["entities"]) {
        let participants = a(&e["participant_ids"]);
        if e["structure_kind"] != candidate["kind"]
            || participants.len() < 2
            || !plans.iter().any(|p| {
                if p["structure_match"] == "WITHIN" {
                    participants
                        .iter()
                        .all(|id| a(&p["subject_ids"]).contains(id))
                } else {
                    a(&p["subject_ids"])
                        .iter()
                        .all(|id| participants.contains(id))
                }
            })
        {
            continue;
        }
        let roles: Vec<_> = a(claims)
            .iter()
            .filter(|c| {
                c["subject_id"] == e["id"]
                    && a(&schema["predicates"]).iter().any(|p| {
                        p["id"] == c["predicate_id"]
                            && p["value_type"] == "ENTITY"
                            && is_structural_predicate(schema, p)
                    })
                    && participants.contains(&c["value"])
            })
            .collect();
        if participants
            .iter()
            .all(|id| roles.iter().any(|c| &c["value"] == id))
        {
            choices.push((e, roles));
        }
    }
    if choices.is_empty() {
        return item;
    }
    let mut anchors = vec![candidate];
    anchors.extend(a(&candidate["support_set"]));
    let distance = |c: &&Value| -> i128 {
        if anchors.iter().any(|a| {
            a["source_id"] == c["source_id"]
                && offset(&a["start"]).unwrap_or(usize::MAX) < offset(&c["end"]).unwrap_or(0)
                && offset(&a["end"]).unwrap_or(0) > offset(&c["start"]).unwrap_or(usize::MAX)
        }) {
            -1
        } else if c["source_id"] == candidate["source_id"] {
            offset(&c["start"])
                .unwrap_or(0)
                .abs_diff(offset(&candidate["start"]).unwrap_or(0)) as i128
        } else {
            9007199254740991
        }
    };
    let mut added = Vec::new();
    for (e, roles) in &choices {
        for id in a(&e["participant_ids"]) {
            let mut rs: Vec<_> = roles
                .iter()
                .copied()
                .filter(|c| &c["value"] == id)
                .collect();
            rs.sort_by(|a, b| {
                distance(a)
                    .cmp(&distance(b))
                    .then_with(|| locale_cmp(s(&a["id"]), s(&b["id"])))
            });
            if let Some(r) = rs.first() {
                if !a(&item["claim_ids"]).contains(&r["id"]) && !added.contains(&r["id"]) {
                    added.push(r["id"].clone());
                }
            }
        }
    }
    if !added.is_empty() {
        let mut ids = a(&item["claim_ids"]).to_vec();
        ids.extend(added.clone());
        item["claim_ids"] = json!(ids);
        item["role_binding_resolution"] = json!({"method":"EXISTING_COMPLETE_TYPED_QUERY_PATTERNS","pattern_ids":choices.iter().map(|(e,_)|&e["id"]).collect::<Vec<_>>(),"selection":"ENUMERATE_QUERY_MATCHES_WITHOUT_MERGING_MODES","added_claim_ids":added,"semantic_support_not_certified":true});
        if choices.len() == 1 {
            item["role_binding_resolution"]["pattern_id"] = choices[0].0["id"].clone();
        }
    }
    item
}
fn overlap(e: &Value, o: &Value) -> bool {
    e["source_id"] == o["source_id"]
        && offset(&e["start"]).unwrap_or(usize::MAX) < offset(&o["end"]).unwrap_or(0)
        && offset(&e["end"]).unwrap_or(0) > offset(&o["start"]).unwrap_or(usize::MAX)
}
pub fn validate_structure_audit(
    raw: &Value,
    candidates: &Value,
    claims: &Value,
    requirements: &Value,
    schema: &Value,
) -> Result<Value> {
    ensure(candidates.is_array(), "结构审计未覆盖全部候选")?;
    ensure(
        raw["items"].is_array() && a(&raw["items"]).len() == a(candidates).len(),
        "结构审计未覆盖全部候选",
    )?;
    let mut ids = HashSet::new();
    let mut out = Vec::new();
    for original in a(&raw["items"]) {
        let mut item = original.clone();
        let c = a(candidates)
            .iter()
            .find(|c| c["id"] == item["candidate_id"])
            .ok_or_else(|| fail("结构审计候选引用错误"))?;
        ensure(ids.insert(js_stringify(&c["id"])), "结构审计候选引用错误")?;
        ensure(
            ["COVERED", "MISSING", "OUT_OF_SCOPE"].contains(&s(&item["status"]))
                && nonempty(&item["reason"]),
            "结构审计结论无效",
        )?;
        if !a(requirements).is_empty() {
            ensure(
                item["cq_ids"].is_array()
                    && unique(&item["cq_ids"])
                    && a(&item["cq_ids"])
                        .iter()
                        .all(|id| a(requirements).iter().any(|r| &r["cq_id"] == id))
                    && (item["status"] == "OUT_OF_SCOPE" || !a(&item["cq_ids"]).is_empty()),
                "结构审计必须绑定当前实际CQ，不能猜测知识表示要求",
            )?;
            let relevant: Vec<_> = a(requirements)
                .iter()
                .filter(|r| a(&item["cq_ids"]).contains(&r["cq_id"]))
                .collect();
            item["coverage_mode"] =
                json!(if relevant.iter().any(|r| r["mode"] == "RELATIONSHIP") {
                    "STRUCTURE"
                } else {
                    "ATTRIBUTE"
                });
            if !relevant.is_empty()
                && relevant
                    .iter()
                    .all(|r| r["mode"] == "RELATIONSHIP" && !a(&r["kinds"]).contains(&c["kind"]))
            {
                let status = item["status"].clone();
                item["status"] = json!("OUT_OF_SCOPE");
                item["normalization"] =
                    json!({"model_status":status,"rule":"STRUCTURE_KIND_OUTSIDE_BOUND_CQS"});
                item["reason"] = json!(format!(
                    "该结构类型不属于所绑定问题要求。{}",
                    s(&item["reason"])
                ));
            }
        }
        ensure(
            item["claim_ids"].is_array()
                && a(&item["claim_ids"])
                    .iter()
                    .all(|id| a(claims).iter().any(|c| &c["id"] == id)),
            "结构审计引用未知声明",
        )?;
        if !schema.is_null() {
            item = attach_existing_query_roles(&item, c, schema, claims);
        }
        if item["status"] == "COVERED" && !item["support_relation"].is_null() {
            ensure(
                [
                    "SAME_PASSAGE",
                    "OVERLAPPING_SOURCE_SPAN",
                    "EQUIVALENT_STATEMENT",
                ]
                .contains(&s(&item["support_relation"])),
                "结构覆盖证据关系无效",
            )?;
        }
        let equivalent = item["status"] == "COVERED"
            && !a(requirements).is_empty()
            && item["support_relation"] == "EQUIVALENT_STATEMENT"
            && nonempty(&item["support_reason"])
            && !a(&item["claim_ids"]).is_empty();
        if equivalent {
            item["coverage_verification"] = json!("SEMANTIC_MODEL_JUDGMENT_NOT_PROGRAM_CERTIFIED");
        }
        let supported = a(&item["claim_ids"])
            .iter()
            .filter_map(|id| a(claims).iter().find(|r| &r["id"] == id))
            .any(|r| {
                let mut es = vec![r];
                es.extend(a(&r["support_set"]));
                let mut os = vec![c];
                os.extend(a(&c["support_set"]));
                es.iter().any(|e| os.iter().any(|o| overlap(e, o)))
            });
        if item["status"] == "COVERED" && !equivalent && !supported {
            item["status"] = json!("MISSING");
            item["normalization"] =
                json!({"model_status":"COVERED","rule":"NO_BOUND_ORIGINAL_SUPPORT"});
            item["reason"] = json!(format!(
                "现有引用未绑定该结构的原文，需补查。{}",
                s(&item["reason"])
            ));
        }
        out.push(item);
    }
    Ok(json!(out))
}
pub fn execute(op: &str, p: &Value) -> Result<Value> {
    match op {
        "support_valid" => Ok(json!(support_valid(&p["claim"], &p["sources"]))),
        "normalize_support_set" => Ok(normalize_support_set(
            p.get("rows").or_else(|| p.get("support_set")),
            &p["input"],
        )?
        .unwrap_or(Value::Null)),
        "is_structural_predicate" => Ok(json!(is_structural_predicate(
            &p["schema"],
            &p["predicate"]
        ))),
        "validate_structure_intent" => validate_structure_intent(
            &p["raw"],
            &p["cqs"],
            p.get("groups").unwrap_or(&p["options"]["groups"]),
        ),
        "assert_structure_plans" => {
            assert_structure_plans(&p["schema"], &p["requirements"])?;
            Ok(Value::Null)
        }
        "validate_structure_selection" => {
            validate_structure_selection(&p["raw"], &p["candidates"], &p["requirements"])
        }
        "structure_reference_menu" => {
            map_array(p.get("candidates"), "candidates")?;
            if has(p, "claims") {
                map_array(p.get("claims"), "claims")?;
            }
            Ok(structure_reference_menu(&p["candidates"], &p["claims"]))
        }
        "restore_structure_references" => {
            restore_structure_references(&p["raw"], &p["candidates"], &p["claims"])
        }
        "structure_fragments" => Ok(structure_fragments(&p["source"], &p["unit"], &p["context"])),
        "materialize_claim_evidence" => {
            map_array(p.get("claims"), "claims")?;
            materialize_claim_evidence(
                &p["claims"],
                &p["sources"],
                &p["unit"],
                &p["fragments"],
                &p["provided"],
            )
        }
        "validate_structure_discovery" => {
            validate_structure_discovery(&p["raw"], &p["unit"], &p["source"], &p["options"])
        }
        "validate_structure_repair" => validate_structure_repair(
            &p["raw"],
            &p["issues"],
            &p["unit"],
            &p["source"],
            &p["options"],
        ),
        "attach_existing_query_roles" => Ok(attach_existing_query_roles(
            &p["item"],
            &p["candidate"],
            &p["schema"],
            &p["claims"],
        )),
        "validate_structure_audit" => validate_structure_audit(
            &p["raw"],
            &p["candidates"],
            &p["claims"],
            &p["options"]["requirements"],
            p["options"].get("schema").unwrap_or(&p["schema"]),
        ),
        "learning_observation_id" => {
            let normalized = s(&p["question"])
                .trim_matches(js_ws)
                .split(js_ws)
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase();
            Ok(json!(format!(
                "obs_{}",
                &sha(&json!([
                    p["base"],
                    normalized,
                    p["epoch"],
                    STRUCTURE_CONTRACT
                ]))[..32]
            )))
        }
        _ => Err(error("CORE_OPERATION_UNSUPPORTED", "未知结构操作")),
    }
}
