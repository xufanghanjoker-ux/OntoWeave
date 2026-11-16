//! Document-led question-scope proposals. Models propose semantics; this module
//! validates source bindings, complete batching and exact mention positions only.
use crate::common::{a, canonical_hash as hash, error, index_of, len, nonempty, s, Result};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const VERSION: &str = "lightog-document-scope/0.1";
fn need(ok: bool, code: &str) -> Result<()> {
    if ok { Ok(()) } else { Err(error(code, code)) }
}
fn shape(v: &Value, keys: &[&str]) -> Result<()> {
    need(v.as_object().is_some_and(|m| m.len() == keys.len() && keys.iter().all(|k| m.contains_key(*k))), "DOCUMENT_SCOPE_SHAPE_INVALID")
}
fn text(v: &Value, max: usize) -> bool { nonempty(v) && len(s(v)) <= max }
fn array(v: &Value, max: usize) -> Result<&[Value]> {
    need(v.is_array() && a(v).len() <= max, "DOCUMENT_SCOPE_RESOURCE_LIMIT")?;
    Ok(a(v))
}
fn id(prefix: &str, value: &Value) -> String { format!("{prefix}_{}", &hash(value)[..32]) }

pub fn prepare(p: &Value) -> Result<Value> {
    shape(p, &["snapshot", "evidence_set", "context", "user_cqs", "definitions", "max_batch_utf16", "max_fragments_per_batch"])?;
    let es = &p["evidence_set"];
    need(es["snapshot"] == p["snapshot"], "DOCUMENT_SCOPE_SNAPSHOT_MISMATCH")?;
    need(p["definitions"].is_string() && len(s(&p["definitions"])) <= 16000, "DOCUMENT_SCOPE_DEFINITIONS_INVALID")?;
    for q in array(&p["user_cqs"], 256)? { need(text(q, 4096), "DOCUMENT_SCOPE_CQ_INVALID")?; }
    let cap = p["max_batch_utf16"].as_u64().filter(|n| (640..=24000).contains(n)).ok_or_else(|| error("DOCUMENT_SCOPE_BATCH_LIMIT_INVALID", "DOCUMENT_SCOPE_BATCH_LIMIT_INVALID"))? as usize;
    let count = p["max_fragments_per_batch"].as_u64().filter(|n| (1..=128).contains(n)).ok_or_else(|| error("DOCUMENT_SCOPE_BATCH_LIMIT_INVALID", "DOCUMENT_SCOPE_BATCH_LIMIT_INVALID"))? as usize;
    // Reuse the existing source validator and scalar-safe, lossless refinement.
    let refined = crate::fine_source_evidence::execute("refine_batches", &json!({"contract_version":crate::fine_source_evidence::VERSION,"evidence_set":es,"context":p["context"]}))?;
    let fragments: Vec<Value> = a(&refined["batches"]).iter().flat_map(|b| a(&b["evidence_set"]["fragments"]).iter().cloned()).collect();
    need(!fragments.is_empty(), "DOCUMENT_SCOPE_EVIDENCE_REQUIRED")?;
    let mut groups: Vec<Vec<Value>> = vec![];
    let mut current = vec![];
    let mut units = 0;
    for f in fragments {
        let n = len(s(&f["span"]["quote"]));
        if !current.is_empty() && (current.len() >= count || units + n > cap) {
            groups.push(current); current = vec![]; units = 0;
        }
        need(n <= cap, "DOCUMENT_SCOPE_FRAGMENT_TOO_LARGE")?;
        current.push(f); units += n;
    }
    if !current.is_empty() { groups.push(current); }
    let mut batches = vec![];
    for (i, group) in groups.iter().enumerate() {
        let menu: Vec<Value> = group.iter().map(|f| json!({"evidence_id":f["id"],"source_ref":f["source_ref"],"source_revision":f["source_revision"],"span":f["span"]})).collect();
        let binding = json!({"version":VERSION,"snapshot":p["snapshot"],"batch_index":i,"source_evidence_menu":menu,"user_cqs":p["user_cqs"],"definitions":p["definitions"]});
        batches.push(json!({"batch_id":id("scope_batch", &binding),"batch_index":i,"binding_sha256":hash(&binding),"source_evidence_menu":menu,"fragments":group,"input_utf16":group.iter().map(|f| len(s(&f["span"]["quote"]))).sum::<usize>()}));
    }
    let mut out = json!({"contract_version":VERSION,"input":p,"snapshot":p["snapshot"],"source_bindings":p["snapshot"]["sources"],"batches":batches,"batch_count":batches.len(),"input_utf16":refined["receipt"]["input_utf16"],"omitted_fragments":0,"truncated":false,"semantic_support_certified":false,"coverage_complete":false,"model_called":false});
    out["prepared_id"] = json!(id("scope_prepared", &out));
    Ok(out)
}

fn evidence(ids: &Value, menu: &BTreeMap<String, Value>) -> Result<Vec<Value>> {
    let ids = array(ids, 128)?;
    need(!ids.is_empty(), "DOCUMENT_SCOPE_EVIDENCE_REQUIRED")?;
    let mut seen = BTreeSet::new();
    ids.iter().map(|v| {
        need(v.is_string() && seen.insert(s(v)), "DOCUMENT_SCOPE_EVIDENCE_DUPLICATE")?;
        menu.get(s(v)).cloned().ok_or_else(|| error("DOCUMENT_SCOPE_EVIDENCE_UNKNOWN", "DOCUMENT_SCOPE_EVIDENCE_UNKNOWN"))
    }).collect()
}

pub fn materialize(p: &Value) -> Result<Value> {
    shape(p, &["prepared", "responses"])?;
    let prepared = &p["prepared"];
    let expected = prepare(&prepared["input"])?;
    need(*prepared == expected, "DOCUMENT_SCOPE_PREPARED_CHANGED")?;
    let rows = array(&p["responses"], a(&prepared["batches"]).len())?;
    let mut returned = BTreeMap::<String, Value>::new();
    for row in rows {
        shape(row, &["batch_id", "raw"])?;
        need(a(&prepared["batches"]).iter().any(|b| b["batch_id"] == row["batch_id"]), "DOCUMENT_SCOPE_BATCH_UNKNOWN")?;
        need(returned.insert(s(&row["batch_id"]).to_owned(), row["raw"].clone()).is_none(), "DOCUMENT_SCOPE_BATCH_DUPLICATE")?;
    }
    let mut families = BTreeMap::<String, Value>::new();
    let mut subjects = BTreeMap::<String, Value>::new();
    let mut tasks = BTreeMap::<String, Value>::new();
    let mut unknowns = vec![];
    let mut pending = vec![];
    for batch in a(&prepared["batches"]) {
        let Some(raw) = returned.get(s(&batch["batch_id"])) else { pending.push(batch["batch_id"].clone()); continue; };
        let raw = if raw.is_string() { crate::model_json_boundary::parse(s(raw))?["parsed"].clone() } else { raw.clone() };
        shape(&raw, &["families", "unknowns"])?;
        for u in array(&raw["unknowns"], 64)? {
            need(text(u, 4000), "DOCUMENT_SCOPE_UNKNOWN_INVALID")?;
            unknowns.push(json!({"batch_id":batch["batch_id"],"reason":u}));
        }
        let menu: BTreeMap<String, Value> = a(&batch["source_evidence_menu"]).iter().map(|m| (s(&m["evidence_id"]).to_owned(), m.clone())).collect();
        let mut local_keys = BTreeSet::new();
        for family in array(&raw["families"], 32)? {
            shape(family, &["key", "label", "question", "target", "operation", "conditions", "evidence_ids", "subjects"])?;
            need(text(&family["key"], 128) && local_keys.insert(s(&family["key"]).to_owned()), "DOCUMENT_SCOPE_FAMILY_KEY_INVALID")?;
            need(text(&family["label"], 256) && text(&family["question"], 4096) && text(&family["target"], 2000), "DOCUMENT_SCOPE_FAMILY_INVALID")?;
            need(matches!(s(&family["operation"]), "LOOKUP" | "COMPARE" | "EXPLAIN" | "LIST" | "AGGREGATE" | "CONDITIONAL"), "DOCUMENT_SCOPE_OPERATION_INVALID")?;
            let bound_evidence = evidence(&family["evidence_ids"], &menu)?;
            let mut conditions = vec![];
            for c in array(&family["conditions"], 32)? {
                shape(c, &["text", "evidence_ids"])?;
                need(text(&c["text"], 2000), "DOCUMENT_SCOPE_CONDITION_INVALID")?;
                conditions.push(json!({"text":c["text"],"evidence":evidence(&c["evidence_ids"], &menu)?,"semantic_status":"UNVERIFIED"}));
            }
            // Exact structural equality only. Synonymy and cohort membership
            // remain model proposals; names never become identity bindings.
            let signature = json!({"question":family["question"],"target":family["target"],"operation":family["operation"],"conditions":a(&family["conditions"]).iter().map(|c|c["text"].clone()).collect::<Vec<_>>()});
            let fid = id("cq_family", &signature);
            let subject_rows = array(&family["subjects"], 128)?;
            need(!subject_rows.is_empty(), "DOCUMENT_SCOPE_SUBJECT_REQUIRED")?;
            let entry = families.entry(fid.clone()).or_insert_with(|| json!({"id":fid,"label":family["label"],"question":family["question"],"target":family["target"],"operation":family["operation"],"conditions":conditions,"evidence":[],"subject_ids":[],"batch_ids":[],"semantic_status":"UNVERIFIED","coverage_status":"NOT_CHECKED"}));
            for e in &bound_evidence { if !a(&entry["evidence"]).contains(e) { entry["evidence"].as_array_mut().unwrap().push(e.clone()); } }
            for (index, condition) in conditions.iter().enumerate() {
                for e in a(&condition["evidence"]) {
                    if !a(&entry["conditions"][index]["evidence"]).contains(e) { entry["conditions"][index]["evidence"].as_array_mut().unwrap().push(e.clone()); }
                }
            }
            if !a(&entry["batch_ids"]).contains(&batch["batch_id"]) { entry["batch_ids"].as_array_mut().unwrap().push(batch["batch_id"].clone()); }
            for subject in subject_rows {
                shape(subject, &["surface", "evidence_id", "occurrence", "rationale"])?;
                need(text(&subject["surface"], 256) && text(&subject["rationale"], 2000), "DOCUMENT_SCOPE_SUBJECT_INVALID")?;
                let m = menu.get(s(&subject["evidence_id"])).ok_or_else(||error("DOCUMENT_SCOPE_EVIDENCE_UNKNOWN", "DOCUMENT_SCOPE_EVIDENCE_UNKNOWN"))?;
                let occurrence = subject["occurrence"].as_u64().filter(|n|*n < 10000).ok_or_else(||error("DOCUMENT_SCOPE_OCCURRENCE_INVALID", "DOCUMENT_SCOPE_OCCURRENCE_INVALID"))? as usize;
                let quote = s(&m["span"]["quote"]); let surface = s(&subject["surface"]);
                let mut matches = vec![]; let mut from = 0;
                while let Some(at) = index_of(quote, surface, from) { matches.push(at); from = at + 1; }
                let relative = *matches.get(occurrence).ok_or_else(||error("DOCUMENT_SCOPE_SUBJECT_NOT_FOUND", "DOCUMENT_SCOPE_SUBJECT_NOT_FOUND"))?;
                let begin = m["span"]["start"].as_u64().ok_or_else(||error("DOCUMENT_SCOPE_SPAN_INVALID", "DOCUMENT_SCOPE_SPAN_INVALID"))? as usize + relative;
                let anchor = json!({"source_ref":m["source_ref"],"source_revision":m["source_revision"],"span":{"start":begin,"end":begin+len(surface),"quote":surface,"offset_unit":"utf16_code_unit"}});
                let sid = id("scope_subject", &anchor);
                subjects.entry(sid.clone()).or_insert_with(|| json!({"id":sid,"surface":surface,"anchor":anchor,"evidence_id":subject["evidence_id"],"rationale":subject["rationale"],"identity_status":"SOURCE_MENTION_UNRESOLVED","entity_ref":null}));
                if !a(&entry["subject_ids"]).contains(&json!(sid)) { entry["subject_ids"].as_array_mut().unwrap().push(json!(sid)); }
                let task_key = json!({"family_id":fid,"subject_id":sid,"snapshot":prepared["snapshot"]});
                let tid = id("scope_task", &task_key);
                tasks.entry(tid.clone()).or_insert_with(|| json!({"id":tid,"family_id":fid,"subject_id":sid,"subject":subjects[&sid],"question":family["question"],"target":family["target"],"operation":family["operation"],"conditions":conditions,"evidence":bound_evidence,"batch_id":batch["batch_id"],"status":"PLANNED_UNVERIFIED","coverage_status":"NOT_CHECKED"}));
                need(tasks.len() <= 65536, "DOCUMENT_SCOPE_RESOURCE_LIMIT")?;
            }
        }
    }
    let mut scanned = vec![];
    for source in a(&prepared["source_bindings"]) {
        let source_batches: Vec<&Value> = a(&prepared["batches"]).iter().filter(|b|a(&b["source_evidence_menu"]).iter().any(|m|m["source_ref"]==source["source_ref"] && m["source_revision"]==source["source_revision"])).collect();
        let returned_count = source_batches.iter().filter(|b|returned.contains_key(s(&b["batch_id"]))).count();
        let mut ranges: Vec<(u64,u64)> = source_batches.iter().flat_map(|b|a(&b["source_evidence_menu"]).iter()).filter(|m|m["source_ref"]==source["source_ref"] && m["source_revision"]==source["source_revision"]).map(|m|(m["span"]["start"].as_u64().unwrap(),m["span"]["end"].as_u64().unwrap())).collect();
        ranges.sort(); let mut reached = 0u64; let mut gap = false;
        for (start,end) in ranges { if start > reached { gap=true; } reached=reached.max(end); }
        let full = a(&prepared["input"]["context"]["source_texts"]).iter().find(|r|r["source_ref"]==source["source_ref"] && r["source_revision"]==source["source_revision"]);
        let menu_complete = full.is_some_and(|r|!gap && reached==len(s(&r["text"])) as u64) && !source_batches.is_empty();
        scanned.push(json!({"source_ref":source["source_ref"],"source_revision":source["source_revision"],"planned_batches":source_batches.len(),"returned_batches":returned_count,"status":if source_batches.is_empty(){"NOT_IN_MENU"}else if returned_count<source_batches.len(){"PENDING"}else if !menu_complete{"PARTIAL_MENU"}else{"SCAN_RETURNED"},"menu_complete":menu_complete,"semantic_coverage_complete":false}));
    }
    let complete_menu = !scanned.is_empty() && scanned.iter().all(|r|r["menu_complete"]==true);
    let status = if !pending.is_empty() || !complete_menu {"PARTIAL_SCOPE"} else if families.is_empty(){"NO_SCOPE_DISCOVERED"}else{"SCOPE_PROPOSED"};
    let mut plan = json!({"contract_version":VERSION,"prepared_id":prepared["prepared_id"],"snapshot":prepared["snapshot"],"source_bindings":prepared["source_bindings"],"user_cqs":prepared["input"]["user_cqs"],"definitions":prepared["input"]["definitions"],"status":status,"families":families.into_values().collect::<Vec<_>>(),"subjects":subjects.into_values().collect::<Vec<_>>(),"tasks":tasks.into_values().collect::<Vec<_>>(),"scanned_sources":scanned,"pending_batches":pending,"unknowns":unknowns,"all_batches_returned":returned.len()==a(&prepared["batches"]).len(),"all_source_text_in_menu":complete_menu,"semantic_support_certified":false,"coverage_complete":false,"publication_performed":false,"responses_sha256":hash(&p["responses"])});
    plan["plan_id"] = json!(id("scope_plan", &plan));
    Ok(plan)
}

pub fn execute(op: &str, p: &Value) -> Result<Value> {
    match op {
        "prepare" => prepare(p),
        "materialize" => materialize(p),
        "validate_plan" => {
            shape(p, &["prepared", "responses", "plan", "current_snapshot"])?;
            let expected = materialize(&json!({"prepared":p["prepared"],"responses":p["responses"]}))?;
            need(expected == p["plan"], "DOCUMENT_SCOPE_PLAN_CHANGED")?;
            current_scope(&p["plan"], &p["current_snapshot"])?;
            Ok(json!({"validated":true,"plan_id":expected["plan_id"],"semantic_support_certified":false,"coverage_complete":false}))
        },
        "build_question" => {
            shape(p, &["plan", "current_snapshot"])?;
            let mut unsigned = p["plan"].clone();
            let original_id = unsigned.as_object_mut().ok_or_else(||error("DOCUMENT_SCOPE_PLAN_INVALID","DOCUMENT_SCOPE_PLAN_INVALID"))?.remove("plan_id").unwrap_or(Value::Null);
            need(original_id == id("scope_plan", &unsigned), "DOCUMENT_SCOPE_PLAN_CHANGED")?;
            current_scope(&p["plan"], &p["current_snapshot"])?;
            need(!a(&p["plan"]["tasks"]).is_empty(), "DOCUMENT_SCOPE_TASKS_REQUIRED")?;
            let guidance = json!({"scope_plan_id":original_id,"families":p["plan"]["families"],"tasks":p["plan"]["tasks"],"rules":["Extract facts for the proposed targets and source-anchored subjects only, preserving conditions, negation, time and units.","Question families and source mentions are unverified guidance, not factual evidence or confirmed entity identities.","Keep all source completeness and publication gates. Missing facts remain unknown; supporting context and relations may be retained when required by these tasks."]});
            Ok(json!({"question":format!("Discover source-grounded knowledge for document scope plan {}.",s(&original_id)),"cq_guidance":serde_json::to_string(&guidance).unwrap(),"scope_constraints":guidance,"plan_id":original_id,"semantic_support_certified":false}))
        },
        _ => Err(error("DOCUMENT_SCOPE_OPERATION_UNKNOWN",op))
    }
}

fn current_scope(plan: &Value, current: &Value) -> Result<()> {
    let bound=&plan["snapshot"];
    need(plan["contract_version"]==VERSION && bound["base_ref"]==current["base_ref"] && bound["source_epoch"]==current["source_epoch"] && bound["sources"]==current["sources"], "DOCUMENT_SCOPE_SOURCE_STALE")
}
