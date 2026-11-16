//! Equivalent port of frozen demand-shadow v6 (including its v5.1 binder).
//! Deliberately finite syntax. No candidate repair, entity guessing, model or storage.
use crate::common::*;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashSet;
pub const VERSION: &str = "passive_endpoints_predicate_v6";
/// Admission policy at the product boundary, not an added recognition rule.
pub fn check_declined(record: &Value) -> Result<Value> {
    if record["status"] != "DECLINED_UNVERIFIED" {
        return Ok(json!({"status":"NOT_APPLICABLE"}));
    }
    let reason = s(&record["reason_code"]);
    if reason.starts_with("AUDIT_")
        || reason.starts_with("RECOGNITION_CONDITION_")
        || reason.starts_with("BINDING_RELATION_")
        || !a(&record["recognition"]["conditions"]).is_empty()
    {
        let mut e = error(
            "ADOPTED_CQ_CANDIDATE_REJECTED",
            "本次问题候选未通过关系端点或条件校验，未忽略这些信息继续执行，也未开始学习。",
        );
        e.details = Some(
            json!({"reason_code":reason,"recognition":record["recognition"],"question":record["question"]}),
        );
        return Err(e);
    }
    Ok(json!({"status":"LEGACY_CONTINUATION_UNVERIFIED"}))
}
fn need(ok: bool, code: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(error(code, code))
    }
}
fn rx(pattern: &str, text: &str) -> bool {
    Regex::new(pattern).unwrap().is_match(text)
}
fn start(v: &Value) -> usize {
    v["start"].as_u64().unwrap() as usize
}
fn end(v: &Value) -> usize {
    v["end"].as_u64().unwrap() as usize
}
fn clean(text: &str) -> String {
    text.chars()
        .filter(|c| !js_ws(*c) && !['“', '”', '"', '\''].contains(c))
        .collect()
}
fn directive(text: &str) -> bool {
    rx(
        r"^(?:(?:请问|请|先|再|另|另外|分别|说明|解释|列出|列举|介绍|比较|对比|一下))*$",
        &clean(text),
    )
}
fn fields(v: &Value, keys: &[&str]) -> Result<()> {
    need(
        v.as_object()
            .is_some_and(|m| m.len() == keys.len() && keys.iter().all(|k| m.contains_key(*k))),
        "RECOGNITION_SHAPE_INVALID",
    )
}
fn strings(v: &Value) -> Result<()> {
    let rows = a(v);
    need(
        v.is_array()
            && rows.len() <= 32
            && rows
                .iter()
                .all(|s| s.as_str().is_some_and(|t| !t.is_empty()))
            && rows.iter().collect::<HashSet<_>>().len() == rows.len(),
        "RECOGNITION_LIST_INVALID",
    )
}
fn occurrences(question: &str, quote: &str) -> Result<Vec<Value>> {
    let mut rows = vec![];
    let mut from = 0;
    while let Some(at) = index_of(question, quote, from) {
        need(rows.len() < 32, "RECOGNITION_RESOURCE_LIMIT")?;
        rows.push(
            json!({"start":at,"end":at+len(quote),"quote":quote,"offset_unit":"utf16_code_unit"}),
        );
        from = at + 1;
        if from > len(question) {
            break;
        }
    }
    Ok(rows)
}
pub fn recognize(question: &str, raw: &Value) -> Result<Value> {
    need(len(question) <= 4096, "RECOGNITION_RESOURCE_LIMIT")?;
    let raw = raw
        .as_str()
        .ok_or_else(|| error("IR_INPUT_INVALID", "IR_INPUT_INVALID"))?;
    need(raw.len() <= 8 * 1024 * 1024, "IR_INPUT_INVALID")?;
    let data =
        lightog_demand::wire::strict_load(raw.as_bytes()).map_err(|e| error(e.code, e.code))?;
    fields(&data, &["subjects", "targets", "conditions"])?;
    strings(&data["subjects"])?;
    strings(&data["targets"])?;
    need(
        data["conditions"].is_array() && a(&data["conditions"]).len() <= 32,
        "RECOGNITION_LIST_INVALID",
    )?;
    let mut subjects = vec![];
    for (i, q) in a(&data["subjects"]).iter().enumerate() {
        let spans = occurrences(question, s(q))?;
        need(!spans.is_empty(), "RECOGNITION_SUBJECT_NOT_LITERAL")?;
        for mut span in spans {
            span["label"] = q.clone();
            span["id"] = json!(format!("s{i}"));
            subjects.push(span);
        }
    }
    let mut selected: Vec<Value> = subjects
        .iter()
        .filter(|v| {
            !subjects
                .iter()
                .any(|o| o["label"] != v["label"] && start(o) <= start(v) && end(v) <= end(o))
        })
        .cloned()
        .collect();
    need(
        a(&data["subjects"])
            .iter()
            .all(|q| selected.iter().any(|v| v["label"] == *q)),
        "RECOGNITION_SUBJECT_SUBSTRING_ONLY",
    )?;
    let mut targets = vec![];
    for q in a(&data["targets"]) {
        let spans = occurrences(question, s(q))?;
        need(!spans.is_empty(), "RECOGNITION_TARGET_NOT_LITERAL")?;
        targets.extend(spans.into_iter().filter(|v| {
            !selected
                .iter()
                .any(|sub| start(sub) <= start(v) && end(v) <= end(sub))
        }));
    }
    let mut conditions = vec![];
    for c in a(&data["conditions"]) {
        fields(c, &["quote", "value"])?;
        need(
            c["quote"].is_string()
                && !s(&c["quote"]).is_empty()
                && c["value"].is_string()
                && !s(&c["value"]).is_empty(),
            "RECOGNITION_CONDITION_INVALID",
        )?;
        let spans = occurrences(question, s(&c["quote"]))?;
        need(
            !spans.is_empty() && s(&c["quote"]).contains(s(&c["value"])),
            "RECOGNITION_CONDITION_NOT_LITERAL",
        )?;
        for mut span in spans {
            span["value"] = c["value"].clone();
            conditions.push(span);
        }
    }
    need(
        targets.iter().enumerate().all(|(i, t)| {
            targets
                .iter()
                .enumerate()
                .all(|(j, u)| i == j || end(t) <= start(u) || end(u) <= start(t))
        }),
        "RECOGNITION_TARGET_OVERLAP",
    )?;
    need(
        targets.iter().all(|t| {
            selected
                .iter()
                .all(|u| end(t) <= start(u) || end(u) <= start(t))
                && conditions
                    .iter()
                    .all(|u| end(t) <= start(u) || end(u) <= start(t))
        }),
        "RECOGNITION_ROLE_OVERLAP",
    )?;
    need(
        conditions
            .iter()
            .map(|c| format!("{}|{}|{}", start(c), end(c), s(&c["value"])))
            .collect::<HashSet<_>>()
            .len()
            == conditions.len(),
        "RECOGNITION_CONDITION_DUPLICATE",
    )?;
    selected.sort_by_key(start);
    targets.sort_by_key(start);
    conditions.sort_by_key(start);
    Ok(json!({"data":data,"subjects":selected,"targets":targets,"conditions":conditions}))
}
fn endpoint(raw: &str, at: usize) -> Result<Value> {
    let trimmed = raw.trim_matches(js_ws);
    let mut quote = trimmed;
    let mut inner = 0;
    if (trimmed.starts_with('“') && trimmed.ends_with('”'))
        || (trimmed.starts_with('"') && trimmed.ends_with('"'))
    {
        quote = slice_ref(trimmed, 1, len(trimmed) - 1);
        inner = 1;
        need(
            !quote.is_empty() && !rx("[“”\"]", quote),
            "AUDIT_PASSIVE_FRAME_UNSUPPORTED",
        )?;
    } else {
        need(
            rx(r"^[\p{L}\p{N}_()（）.\-]+$", quote) && !rx("[被与和及或不的所在于]", quote),
            "AUDIT_PASSIVE_FRAME_UNSUPPORTED",
        )?;
    }
    let offset = index_of(raw, trimmed, 0).unwrap_or(0);
    Ok(json!({"quote":quote,"start":at+offset+inner,"end":at+offset+inner+len(quote)}))
}
fn slice_ref(text: &str, from: usize, to: usize) -> &str {
    let byte_at = |n| {
        let mut units = 0;
        for (i, c) in text.char_indices() {
            if units == n {
                return i;
            }
            units += c.len_utf16();
        }
        text.len()
    };
    &text[byte_at(from)..byte_at(to)]
}
pub fn passive_frames(question: &str) -> Result<Vec<Value>> {
    let clauses = Regex::new(r"[^，,；;。！？?\n]+").unwrap();
    let directive = Regex::new(r"^(?:请说明|请解释|请问|请介绍|请)").unwrap();
    let names = r#"(?:“[^”]+”|"[^"]+"|[^“”"被]+?)"#;
    let frame = Regex::new(&format!(
        "^({names})被({names})(所)?依赖(?:吗|呢|的方向|的关系)?$"
    ))
    .unwrap();
    let quoted = Regex::new(r#"“[^”]*”|"[^"]*""#).unwrap();
    let mut frames = vec![];
    for m in clauses.find_iter(question) {
        let mut text = m.as_str();
        let mut at = len(&question[..m.start()]);
        if let Some(d) = directive.find(text) {
            text = &text[d.end()..];
            at += len(d.as_str());
        }
        let outside = quoted
            .replace_all(text, |c: &regex::Captures<'_>| {
                " ".repeat(len(c.get(0).unwrap().as_str()))
            })
            .into_owned();
        if rx("被.*依赖", &outside) {
            need(
                !rx(
                    "并非|并不是|未必|从未|尚未|没有|未曾|不曾|并不|不被|不是被|(?:未|没|无|非)被",
                    &outside,
                ),
                "AUDIT_PASSIVE_FRAME_UNSUPPORTED",
            )?;
        }
        let Some(c) = frame.captures(text) else {
            need(
                !rx("^(?:被|由).+依赖的", &outside) && !rx("被.*依赖", &outside),
                "AUDIT_PASSIVE_FRAME_UNSUPPORTED",
            )?;
            continue;
        };
        let patient = endpoint(c.get(1).unwrap().as_str(), at)?;
        let agent = endpoint(
            c.get(2).unwrap().as_str(),
            at + len(c.get(1).unwrap().as_str()) + 1,
        )?;
        need(
            patient["quote"] != agent["quote"],
            "AUDIT_REFLEXIVE_RELATION_UNSUPPORTED",
        )?;
        let pred = at + len(&text[..text.rfind("依赖").unwrap()]);
        frames.push(json!({"start":at,"end":len(&question[..m.end()]),"patient":patient,"agent":agent,"predicate":{"quote":"依赖","start":pred,"end":pred+2}}));
    }
    Ok(frames)
}
pub fn audit(question: &str, r: &Value) -> Result<Value> {
    let frames = passive_frames(question)?;
    let mut trace = vec![];
    for f in &frames {
        need(
            [&f["patient"], &f["agent"]].iter().all(|e| {
                a(&r["subjects"]).iter().any(|s| {
                    s["label"] == e["quote"] && s["start"] == e["start"] && s["end"] == e["end"]
                })
            }),
            "AUDIT_PASSIVE_ENDPOINT_MISSING",
        )?;
        need(
            !a(&r["conditions"])
                .iter()
                .any(|c| start(c) >= start(f) && end(c) <= end(f)),
            "AUDIT_PARTICIPANT_AS_CONDITION",
        )?;
        need(
            a(&r["targets"]).iter().any(|t| {
                t["quote"] == "依赖"
                    && t["start"] == f["predicate"]["start"]
                    && t["end"] == f["predicate"]["end"]
            }),
            "AUDIT_PREDICATE_NOT_RECOGNIZED",
        )?;
        trace.push(json!({"rule":"PASSIVE_RECOGNITION_AUDIT","frame":f,"matched_original_endpoints":true,"matched_original_predicate":true}));
    }
    Ok(
        json!({"status":if frames.is_empty(){"NOT_APPLICABLE"}else{"PASS"},"frames":frames,"trace":trace}),
    )
}
fn member(v: &Value) -> Value {
    json!({"local_id":v["id"],"label":v["label"],"question_spans":[{"start":v["start"],"end":v["end"],"quote":v["quote"],"offset_unit":"utf16_code_unit"}],"entity_ref":null,"source_evidence_ids":[],"source_mentions":[]})
}
fn make(
    id: usize,
    operation: &str,
    subjects: &[Value],
    t: &Value,
    structure: Value,
    deps: Vec<Value>,
) -> Value {
    json!({"id":format!("r{id}"),"operation":operation,"subjects":{"selector":"EXPLICIT","members":subjects.iter().map(member).collect::<Vec<_>>()},"target":{"label":t["quote"],"question_spans":[{"start":t["start"],"end":t["end"],"quote":t["quote"],"offset_unit":"utf16_code_unit"}],"predicate_ref":null,"origin":"QUESTION","context_ref":null},"conditions":[],"structure":structure,"coverage_request":{"mode":"UNSPECIFIED","limit":null},"depends_on":deps,"unresolved":[]})
}
fn erase(text: &str, from: usize, to: usize) -> String {
    format!(
        "{}{}{}",
        slice16(text, 0, from),
        " ".repeat(to - from),
        slice16(text, to, len(text))
    )
}
fn bind(id: &str, question: &str, r: &Value) -> Result<Value> {
    let rs = a(&r["subjects"]);
    let rt = a(&r["targets"]);
    let rc = a(&r["conditions"]);
    need(
        !rs.is_empty() && !rt.is_empty(),
        "BINDING_EMPTY_RECOGNITION",
    )?;
    need(
        !rs.iter()
            .any(|v| ["它", "它们", "这个", "那个"].contains(&s(&v["label"]))),
        "BINDING_UNRESOLVED_PRONOUN",
    )?;
    let mut hidden = question.to_string();
    for sub in rs {
        hidden = erase(&hidden, start(sub), end(sub));
    }
    need(
        !rx("所有|全部|或|不是不", &hidden),
        "BINDING_COMPLEX_EXPRESSION_UNSUPPORTED",
    )?;
    let cues: Vec<usize> = Regex::new("比较|对比")
        .unwrap()
        .find_iter(question)
        .map(|m| len(&question[..m.start()]))
        .filter(|at| !rs.iter().any(|v| start(v) <= *at && *at < end(v)))
        .collect();
    need(cues.len() <= 1, "BINDING_MULTIPLE_COMPARISONS_UNSUPPORTED")?;
    for at in &cues {
        need(
            !rx(
                "(?:不|不要|不需要|无需|不用|不得|不必|不能)(?:进行)?$",
                &slice16(question, at.saturating_sub(8), *at),
            ),
            "BINDING_NEGATED_COMPARISON",
        )?;
    }
    let mut req = vec![];
    let mut trace = vec![];
    let (mut used_s, mut used_t, mut used_c) = (HashSet::new(), HashSet::new(), HashSet::new());
    for m in Regex::new(r"[^，,；;。！？?\n]+")
        .unwrap()
        .find_iter(question)
    {
        let from = len(&question[..m.start()]);
        let to = len(&question[..m.end()]);
        let clause = m.as_str();
        let subjects: Vec<Value> = rs
            .iter()
            .filter(|v| start(v) >= from && end(v) <= to)
            .cloned()
            .collect();
        let targets: Vec<Value> = rt
            .iter()
            .filter(|v| start(v) >= from && end(v) <= to)
            .cloned()
            .collect();
        let conditions: Vec<Value> = rc
            .iter()
            .filter(|v| start(v) >= from && end(v) <= to)
            .cloned()
            .collect();
        if targets.is_empty() {
            need(
                subjects.is_empty() && conditions.is_empty(),
                "BINDING_UNCONSUMED_CLAUSE",
            )?;
            continue;
        }
        if subjects.is_empty()
            && rx(
                "^(?:请)?(?:说明|解释)(?:这一)?依赖(?:关系|方向)$",
                &clean(clause),
            )
            && req
                .iter()
                .any(|v: &Value| v["structure"]["kind"] == "RELATION")
        {
            for t in &targets {
                used_t.insert(start(t));
            }
            trace.push(json!({"rule":"META_DIRECTION_REFERENCE","from":from,"to":to}));
            continue;
        }
        need(!subjects.is_empty(), "BINDING_NO_LOCAL_SUBJECT")?;
        for c in &conditions {
            need(
                !subjects
                    .iter()
                    .any(|v| start(v) <= start(c) && end(c) <= end(v)),
                "BINDING_CONDITION_INSIDE_SUBJECT",
            )?;
        }
        let dependencies: Vec<_> = targets.iter().filter(|t| t["quote"] == "依赖").collect();
        if !dependencies.is_empty() {
            need(
                dependencies.len() == 1
                    && targets.len() == 1
                    && subjects.len() == 2
                    && conditions.is_empty(),
                "BINDING_RELATION_PATTERN_UNSUPPORTED",
            )?;
            let (a, b, t) = (&subjects[0], &subjects[1], dependencies[0]);
            need(
                directive(&slice16(question, from, start(a))),
                "BINDING_UNCONSUMED_PREFIX",
            )?;
            let (dependent, provider);
            if end(a) <= start(t)
                && end(t) <= start(b)
                && clean(&slice16(question, end(a), start(t))).is_empty()
                && clean(&slice16(question, end(t), start(b))).is_empty()
            {
                dependent = a;
                provider = b;
                need(
                    rx(
                        "^(?:吗|呢|的方向|的关系)?$",
                        &clean(&slice16(question, end(b), to)),
                    ),
                    "BINDING_RELATION_SUFFIX_UNSUPPORTED",
                )?;
            } else if end(a) <= start(b)
                && end(b) <= start(t)
                && clean(&slice16(question, end(a), start(b))) == "被"
                && rx("^(?:所)?$", &clean(&slice16(question, end(b), start(t))))
            {
                dependent = b;
                provider = a;
                need(
                    rx(
                        "^(?:吗|呢|的方向|的关系)?$",
                        &clean(&slice16(question, end(t), to)),
                    ),
                    "BINDING_RELATION_SUFFIX_UNSUPPORTED",
                )?;
            } else {
                return Err(error(
                    "BINDING_RELATION_PATTERN_UNSUPPORTED",
                    "BINDING_RELATION_PATTERN_UNSUPPORTED",
                ));
            }
            req.push(make(req.len(),"RELATION",&subjects,t,json!({"kind":"RELATION","match":"NOT_APPLICABLE","directionality":"DIRECTED","roles":[{"role":"DEPENDENT","subject_local_ids":[dependent["id"]]},{"role":"PROVIDER","subject_local_ids":[provider["id"]]}]}),vec![]));
            for sub in &subjects {
                used_s.insert(start(sub));
            }
            used_t.insert(start(t));
            trace.push(json!({"rule":"EXACT_BINARY_DEPENDENCY","dependent":dependent["label"],"provider":provider["label"]}));
            continue;
        }
        need(
            targets.iter().all(|t| {
                ![
                    "组合", "组成", "部分", "构成", "组件", "部件", "比较", "对比", "方向",
                ]
                .contains(&s(&t["quote"]))
            }),
            "BINDING_TARGET_TYPE_UNSUPPORTED",
        )?;
        let mut atoms: Vec<(Value, Value, usize)> = vec![];
        for t in &targets {
            let preceding: Vec<_> = subjects.iter().filter(|v| end(v) <= start(t)).collect();
            let sub = *preceding.last().ok_or_else(|| {
                error(
                    "BINDING_SUBJECT_AFTER_TARGET_UNSUPPORTED",
                    "BINDING_SUBJECT_AFTER_TARGET_UNSUPPORTED",
                )
            })?;
            if preceding.len() > 1 {
                let prev = preceding[preceding.len() - 2];
                need(
                    !rx(
                        "^(?:与|和|及|以及|、)$",
                        &clean(&slice16(question, end(prev), start(sub))),
                    ),
                    "BINDING_SHARED_TARGET_UNSUPPORTED",
                )?;
            }
            let prior = atoms.iter().rev().find(|a| start(&a.0) == start(sub));
            let previous_end = prior.map(|a| end(&a.1)).unwrap_or_else(|| end(sub));
            let mut gap = slice16(question, previous_end, start(t));
            for c in &conditions {
                if start(c) >= previous_end && end(c) <= start(t) {
                    gap = erase(&gap, start(c) - previous_end, end(c) - previous_end);
                }
            }
            need(
                rx(
                    "^(?:的|所|支持|提供|有|有哪些|如何|和|与|及|以及|、|又|分别)*$",
                    &clean(&gap),
                ),
                "BINDING_PROPERTY_LINK_UNSUPPORTED",
            )?;
            if prior.is_none() {
                if preceding.len() < 2 {
                    need(
                        directive(&slice16(question, from, start(sub))),
                        "BINDING_UNCONSUMED_PREFIX",
                    )?;
                } else {
                    need(
                        atoms.last().is_some_and(|a| {
                            rx(
                                "^(?:和|与|及|以及|、|还有|并|而)*$",
                                &clean(&slice16(question, end(&a.1), start(sub))),
                            )
                        }),
                        "BINDING_SUBJECT_CONNECTOR_UNSUPPORTED",
                    )?;
                }
            }
            let index = req.len();
            req.push(make(
                index,
                if t["quote"] == "是什么" {
                    "EXPLAIN"
                } else {
                    "LIST"
                },
                std::slice::from_ref(sub),
                t,
                Value::Null,
                vec![],
            ));
            atoms.push((sub.clone(), t.clone(), index));
            used_s.insert(start(sub));
            used_t.insert(start(t));
        }
        for c in &conditions {
            need(
                !rx(r"(?i)[和与及、，,；;&/]|\bor\b", s(&c["value"])),
                "BINDING_MULTI_VALUE_UNSUPPORTED",
            )?;
            let owner = subjects
                .iter()
                .rev()
                .find(|v| end(v) <= start(c))
                .ok_or_else(|| {
                    error(
                        "BINDING_CONDITION_OWNER_UNSUPPORTED",
                        "BINDING_CONDITION_OWNER_UNSUPPORTED",
                    )
                })?;
            let owned: Vec<_> = atoms
                .iter()
                .filter(|a| start(&a.0) == start(owner))
                .collect();
            need(owned.len() == 1, "BINDING_CONDITION_SCOPE_AMBIGUOUS")?;
            need(
                !rx("不要排除|不排除|并非|不在|或", &slice16(question, from, to)),
                "BINDING_CONDITION_POLARITY_UNSUPPORTED",
            )?;
            let val = s(&c["value"]);
            let quote = s(&c["quote"]);
            let (field, operator, value);
            if [
                format!("在{val}"),
                format!("在{val}的"),
                format!("在{val}下"),
                format!("在{val}下的"),
            ]
            .iter()
            .any(|v| v == quote)
            {
                need(
                    end(c) <= start(&owned[0].1),
                    "BINDING_SCOPE_POSITION_UNSUPPORTED",
                )?;
                field = "SCOPE";
                operator = "EQ";
                value = json!({"kind":"STRING","value":val});
            } else if [
                format!("排除{val}"),
                format!("除{val}以外"),
                format!("不包括{val}"),
                format!("不含{val}"),
                format!("不要列{val}"),
            ]
            .iter()
            .any(|v| v == quote)
            {
                field = "TARGET_VALUE";
                operator = "NOT_IN";
                value = json!({"kind":"STRING_SET","value":[val]});
            } else {
                return Err(error(
                    "BINDING_CONDITION_PATTERN_UNSUPPORTED",
                    "BINDING_CONDITION_PATTERN_UNSUPPORTED",
                ));
            }
            let mention = json!({"start":c["start"],"end":c["end"],"quote":c["quote"],"offset_unit":"utf16_code_unit"});
            req[owned[0].2]["conditions"].as_array_mut().unwrap().push(json!({"id":format!("c{}",used_c.len()),"mention":mention,"field":field,"operator":operator,"value":value,"interpretation":"FORMALIZED"}));
            used_c.insert(start(c));
            trace.push(json!({"rule":"LOCAL_CONDITION_BINDING","subject":owner["label"],"target":owned[0].1["quote"],"field":field,"mention":mention}));
        }
        let last = end(targets.last().unwrap());
        let mut suffix = slice16(question, last, to);
        for c in &conditions {
            if start(c) >= last {
                suffix = erase(&suffix, start(c) - last, end(c) - last);
            }
        }
        need(
            rx(
                "^(?:分别|是|什么|多少|几种|有哪些|有|吗|呢|各自|的)*$",
                &clean(&suffix),
            ),
            "BINDING_UNCONSUMED_SUFFIX",
        )?;
        if cues.iter().any(|c| *c >= from && *c < to) {
            need(
                atoms.len() >= 2
                    && atoms
                        .iter()
                        .map(|a| a.0["label"].clone())
                        .collect::<HashSet<_>>()
                        .len()
                        == atoms.len()
                    && atoms
                        .iter()
                        .map(|a| a.1["quote"].clone())
                        .collect::<HashSet<_>>()
                        .len()
                        == 1,
                "BINDING_COMPARISON_PATTERN_UNSUPPORTED",
            )?;
            let children: Vec<Value> = atoms.iter().map(|a| req[a.2]["id"].clone()).collect();
            req.push(make(
                req.len(),
                "COMPARE",
                &atoms.iter().map(|a| a.0.clone()).collect::<Vec<_>>(),
                &atoms[0].1,
                Value::Null,
                children.clone(),
            ));
            trace.push(json!({"rule":"PROGRAM_COMPARISON_AGGREGATE","children":children}));
        }
    }
    need(
        rs.iter().all(|v| used_s.contains(&start(v))),
        "BINDING_UNCONSUMED_SUBJECT",
    )?;
    need(
        rt.iter().all(|v| used_t.contains(&start(v))),
        "BINDING_UNCONSUMED_TARGET",
    )?;
    need(
        rc.iter().all(|v| used_c.contains(&start(v))),
        "BINDING_UNCONSUMED_CONDITION",
    )?;
    let spec = json!({"contract_version":"lightog-demand/0.1","question_id":id,"text":question,"text_sha256":sha(&json!(question)),"intent":"KNOWLEDGE_QUERY","requirements":req,"ambiguities":[],"limitations":[]});
    let kernel = lightog_demand::Kernel::new().map_err(|e| error(e.code, e.code))?;
    let context=lightog_demand::ValidationContext::from_value(&json!({"examples":{},"source_texts":[],"authority":{"requests":[],"allowed_snapshots":[],"claims":[],"receipts":[],"scope_bindings":[],"entities":[],"predicate_refs":[],"user_definitions":[],"groups":[]}}),&kernel).map_err(|e|error(e.code,e.code))?;
    kernel
        .validate(&spec, "QuestionSpec", &context)
        .map_err(|e| error(e.code, e.code))?;
    Ok(json!({"spec":spec,"trace":trace}))
}
pub fn compile(p: &Value) -> Result<Value> {
    need(p["question"].is_string(), "RECOGNITION_RESOURCE_LIMIT")?;
    let question = s(&p["question"]);
    let recognized = recognize(question, &p["raw"])?;
    let audited = audit(question, &recognized)?;
    let mut result = bind(s(&p["id"]), question, &recognized)?;
    let mut trace = a(&audited["trace"]).to_vec();
    trace.extend(a(&result["trace"]).iter().cloned());
    result["trace"] = json!(trace);
    result["recognized"] = recognized;
    result["audit"] = audited;
    Ok(result)
}
/// Compatibility check only: never synthesize a compound plan or resolve an alias.
pub fn check_plan(p: &Value) -> Result<Value> {
    let spec = &p["spec"];
    let plan = &p["plan"];
    let schema = &p["schema"];
    let req = a(&spec["requirements"]);
    if plan["template"] == "UNKNOWN" {
        return Ok(json!({"status":"NOT_EXECUTED_UNKNOWN_PLAN","compiler_version":VERSION}));
    }
    let gap = if req.len() != 1 {
        Some("MULTI_REQUIREMENT_LEGACY_PLAN_GAP")
    } else if !a(&req[0]["conditions"]).is_empty() {
        Some("CONDITION_LEGACY_PLAN_GAP")
    } else if req[0]["operation"] == "RELATION" {
        Some("DIRECTIONAL_RELATION_LEGACY_PLAN_GAP")
    } else {
        None
    };
    if let Some(reason) = gap {
        let mut e = error(
            "ADOPTED_CQ_PLAN_UNREPRESENTABLE",
            "本次需求已识别，但当前查询协议不能完整执行；未丢弃条件或部分目标后继续。",
        );
        e.details = Some(json!({"reason":reason,"question_spec":spec,"plan":plan}));
        return Err(e);
    }
    if p["compatibility_only"] == true {
        return Ok(json!({"status":"LEGACY_FORMAT_REPRESENTABLE_NOT_SEMANTIC_VERIFICATION"}));
    }
    let r = &req[0];
    let mut checks = vec![];
    let mut delegated = vec![];
    for subject in a(&r["subjects"]["members"]) {
        let candidates: Vec<_> = a(&schema["entities"])
            .iter()
            .filter(|e| e["name"] == subject["label"])
            .collect();
        if candidates.len() == 1 {
            let ids = if plan["subject_ids"].is_array() {
                a(&plan["subject_ids"]).to_vec()
            } else {
                vec![plan["subject_id"].clone()]
            };
            need(
                ids == vec![candidates[0]["id"].clone()],
                "ADOPTED_CQ_SUBJECT_PLAN_CONFLICT",
            )?;
            checks.push(json!("EXACT_SUBJECT_ID"));
        } else {
            delegated.push(json!("SUBJECT_SEMANTICS_EXISTING_WORKFLOW"));
        }
    }
    let predicates: Vec<_> = a(&schema["predicates"])
        .iter()
        .filter(|v| v["label"] == r["target"]["label"])
        .collect();
    if predicates.len() == 1 {
        need(
            plan["predicate_id"] == predicates[0]["id"],
            "ADOPTED_CQ_TARGET_PLAN_CONFLICT",
        )?;
        checks.push(json!("EXACT_TARGET_PREDICATE"));
    } else {
        delegated.push(json!("TARGET_SEMANTICS_EXISTING_WORKFLOW"));
    }
    Ok(
        json!({"status":if delegated.is_empty(){"CONSISTENT"}else{"PARTIAL_LITERAL_CHECK_SEMANTICS_DELEGATED"},"checks":checks,"delegated":delegated,"compiler_version":VERSION}),
    )
}
