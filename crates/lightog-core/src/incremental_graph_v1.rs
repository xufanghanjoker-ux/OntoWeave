//! Ordered, source-bound candidate increments. A candidate projection is never
//! a published graph, even when every fragment has been accounted for.
use crate::common::{a, canonical_hash as hash, error, s, Result};
use serde_json::{json, Value};
use std::collections::BTreeSet;

pub const VERSION: &str = "lightog-incremental-graph/0.1";
fn need(ok: bool, code: &str) -> Result<()> { if ok { Ok(()) } else { Err(error(code, code)) } }
fn valid(ledger: &Value) -> Result<()> {
    need(ledger["contract_version"] == VERSION, "INCREMENTAL_VERSION_INVALID")?;
    need(ledger["task_ref"].as_str().is_some_and(|x| !x.is_empty())
        && ledger["source_snapshot"].is_object()
        && ledger["plan_sha256"].as_str().is_some_and(|x| !x.is_empty())
        && ledger["batch_count"].as_u64().is_some_and(|n| n > 0 && n <= 128)
        && ledger["entries"].is_array(), "INCREMENTAL_LEDGER_INVALID")?;
    let rows = a(&ledger["entries"]);
    need(rows.len() <= ledger["batch_count"].as_u64().unwrap() as usize, "INCREMENTAL_LEDGER_INVALID")?;
    for (i, row) in rows.iter().enumerate() {
        need(row["batch_index"] == i && ["ACCOUNTED", "TECHNICAL_HOLD"].contains(&s(&row["status"]))
            && row["entry_sha256"].as_str().is_some_and(|x| !x.is_empty()), "INCREMENTAL_LEDGER_INVALID")?;
        let mut unsigned = row.clone(); unsigned.as_object_mut().unwrap().remove("entry_sha256");
        need(row["entry_sha256"] == hash(&unsigned), "INCREMENTAL_ENTRY_CHANGED")?;
    }
    let mut unsigned = ledger.clone(); unsigned.as_object_mut().unwrap().remove("ledger_sha256");
    need(ledger["ledger_sha256"] == hash(&unsigned), "INCREMENTAL_LEDGER_CHANGED")
}
fn seal(mut value: Value, field: &str) -> Value { let digest = hash(&value); value[field] = json!(digest); value }
fn init(p: &Value) -> Result<Value> {
    need(p["contract_version"] == VERSION, "INCREMENTAL_VERSION_INVALID")?;
    let out = seal(json!({"contract_version": VERSION, "task_ref": p["task_ref"],
        "source_snapshot": p["source_snapshot"], "plan_sha256": p["plan_sha256"],
        "batch_count": p["batch_count"], "entries": [], "status": "CANDIDATE_ONLY",
        "semantic_support_certified": false, "publication_performed": false}), "ledger_sha256");
    valid(&out)?; Ok(out)
}
fn append(p: &Value) -> Result<Value> {
    let ledger = &p["ledger"]; valid(ledger)?;
    let i = p["batch_index"].as_u64().ok_or_else(|| error("INCREMENTAL_BATCH_INDEX_INVALID", "INCREMENTAL_BATCH_INDEX_INVALID"))? as usize;
    need(i < ledger["batch_count"].as_u64().unwrap() as usize, "INCREMENTAL_BATCH_INDEX_INVALID")?;
    let status = s(&p["status"]);
    need(["ACCOUNTED", "TECHNICAL_HOLD"].contains(&status), "INCREMENTAL_STATUS_INVALID")?;
    let entry = if status == "ACCOUNTED" {
        let input = &p["staging_input"];
        need(input["prepared"]["payload"]["snapshot"] == ledger["source_snapshot"], "INCREMENTAL_SOURCE_CHANGED")?;
        let candidates = a(&input["candidates"]);
        let receipt = if candidates.is_empty() {
            need(input["receipts"].as_array().is_some_and(|v| v.is_empty()), "INCREMENTAL_EMPTY_INVALID")?;
            json!({"empty_candidates": true, "input_sha256": hash(input)})
        } else {
            crate::candidate_staging_v1::execute("stage", input)?["staging_receipt"].clone()
        };
        let ids: Vec<_> = candidates.iter().map(|c| c["candidate_id"].clone()).collect();
        json!({"batch_index": i, "status": status, "request_id": p["request_id"],
            "staging_input_sha256": hash(input), "staging_receipt": receipt,
            "candidate_ids": ids, "candidates": candidates,
            "semantic_support_certified": false})
    } else {
        need(p["error_code"].as_str().is_some_and(|x| !x.is_empty()), "INCREMENTAL_HOLD_REASON_REQUIRED")?;
        json!({"batch_index": i, "status": status, "request_id": p["request_id"],
            "error_code": p["error_code"], "candidates": [], "candidate_ids": [],
            "semantic_support_certified": false})
    };
    need(entry["request_id"].as_str().is_some_and(|x| !x.is_empty()), "INCREMENTAL_REQUEST_ID_REQUIRED")?;
    let entry = seal(entry, "entry_sha256");
    let rows = a(&ledger["entries"]);
    if i < rows.len() {
        need(rows[i] == entry, "INCREMENTAL_BATCH_REPLAY_CHANGED")?;
        return Ok(json!({"ledger": ledger, "idempotent": true}));
    }
    need(i == rows.len(), "INCREMENTAL_BATCH_OUT_OF_ORDER")?;
    let existing: BTreeSet<String> = rows.iter().flat_map(|r| a(&r["candidate_ids"]).iter().filter_map(|x| x.as_str().map(str::to_owned))).collect();
    need(a(&entry["candidate_ids"]).iter().all(|x| !existing.contains(s(x))), "INCREMENTAL_CANDIDATE_ID_REUSED")?;
    let mut next = ledger.clone(); next["entries"].as_array_mut().unwrap().push(entry);
    next.as_object_mut().unwrap().remove("ledger_sha256");
    let next = seal(next, "ledger_sha256"); valid(&next)?;
    Ok(json!({"ledger": next, "idempotent": false}))
}
fn progress(p: &Value) -> Result<Value> {
    let ledger = &p["ledger"]; valid(ledger)?;
    let rows = a(&ledger["entries"]);
    let accounted = rows.iter().filter(|r| r["status"] == "ACCOUNTED").count();
    let holds = rows.iter().filter(|r| r["status"] == "TECHNICAL_HOLD").count();
    let candidates = rows.iter().map(|r| a(&r["candidates"]).len()).sum::<usize>();
    Ok(json!({"contract_version": VERSION, "batch_count": ledger["batch_count"],
        "processed": rows.len(), "accounted": accounted, "technical_hold": holds,
        "candidate_count": candidates, "all_batches_accounted": rows.len() == ledger["batch_count"].as_u64().unwrap() as usize && holds == 0,
        "publication_ready": false, "semantic_support_certified": false}))
}
fn project(p: &Value) -> Result<Value> {
    let ledger = &p["ledger"]; valid(ledger)?;
    let candidates: Vec<Value> = a(&ledger["entries"]).iter()
        .flat_map(|r| a(&r["candidates"]).iter().cloned()).collect();
    let build = crate::knowledge_build::build(&json!({"candidates": candidates,
        "snapshot": ledger["source_snapshot"], "trusted_context": p["trusted_context"]}))?;
    Ok(json!({"contract_version": VERSION, "task_ref": ledger["task_ref"],
        "ledger_sha256": ledger["ledger_sha256"], "candidate_count": candidates.len(),
        "build": build, "status": "CANDIDATE_PREVIEW_ONLY", "semantic_support_certified": false,
        "publication_performed": false}))
}
fn review_batch(p: &Value) -> Result<Value> {
    let ledger = &p["ledger"]; valid(ledger)?;
    let i = p["batch_index"].as_u64().ok_or_else(|| error("INCREMENTAL_BATCH_INDEX_INVALID", "INCREMENTAL_BATCH_INDEX_INVALID"))? as usize;
    let entry = a(&ledger["entries"]).get(i).ok_or_else(|| error("INCREMENTAL_BATCH_UNACCOUNTED", "INCREMENTAL_BATCH_UNACCOUNTED"))?;
    need(entry["status"] == "ACCOUNTED" && !a(&entry["candidates"]).is_empty(), "INCREMENTAL_REVIEW_BATCH_INVALID")?;
    let input = &p["review_input"];
    need(input["contract_version"] == crate::semantic_review_v4::VERSION,
        "INCREMENTAL_REVIEW_PROTOCOL_INVALID")?;
    need(input["candidates"] == entry["candidates"]
        && input["prepared"]["payload"]["snapshot"] == ledger["source_snapshot"],
        "INCREMENTAL_REVIEW_CANDIDATES_CHANGED")?;
    let mut staging = json!({});
    for field in ["candidates", "prepared", "trusted_context", "receipts", "context_evidence_ids", "max_context_utf16"] {
        staging[field] = input[field].clone();
    }
    staging["contract_version"] = json!(crate::candidate_staging_v1::VERSION);
    need(hash(&staging) == entry["staging_input_sha256"], "INCREMENTAL_REVIEW_STAGE_CHANGED")?;
    let checked = crate::semantic_review_v4::execute("apply", input)?;
    let eligible: BTreeSet<String> = a(&checked["eligible_candidates"]).iter().map(|c| s(&c["candidate_id"]).to_owned()).collect();
    let decisions: Vec<Value> = a(&entry["candidates"]).iter().map(|c| json!({
        "candidate_id": c["candidate_id"], "candidate_sha256": hash(c),
        "status": if eligible.contains(s(&c["candidate_id"])) { "MODEL_SUPPORTED" } else { "NEEDS_HUMAN" },
        "review_receipt_sha256": hash(&checked["review_receipt"])
    })).collect();
    Ok(json!({"contract_version": VERSION, "task_ref": ledger["task_ref"],
        "batch_index": i, "entry_sha256": entry["entry_sha256"],
        "review_protocol": crate::semantic_review_v4::VERSION,
        "decisions": decisions, "review_receipt": checked["review_receipt"],
        "semantic_support_certified": false, "publication_performed": false}))
}
fn decide_human(p: &Value) -> Result<Value> { decide_support_action(p, false) }
fn defer_source_audit(p:&Value)->Result<Value> {
    let keys=["ledger","batch_index","candidate_id","review_input","current_snapshot","reason","actor","action"];
    need(p.as_object().is_some_and(|o|o.len()==keys.len() && keys.iter().all(|k|o.contains_key(*k))),"INCREMENTAL_SOURCE_AUDIT_SHAPE_INVALID")?;
    decide_support_action(p,true)
}
fn decide_support_action(p: &Value, source_audit:bool) -> Result<Value> {
    let ledger = &p["ledger"]; valid(ledger)?;
    need(p["current_snapshot"] == ledger["source_snapshot"], if source_audit{"INCREMENTAL_SOURCE_AUDIT_SOURCE_CHANGED"}else{"INCREMENTAL_HUMAN_SOURCE_CHANGED"})?;
    let reviewed = review_batch(p)?;
    let id = s(&p["candidate_id"]);
    let rows: Vec<_> = a(&reviewed["decisions"]).iter().filter(|r| r["candidate_id"] == id).collect();
    need(rows.len() == 1, "INCREMENTAL_HUMAN_CANDIDATE_UNKNOWN")?;
    let action = s(&p["action"]);
    need((if source_audit{action=="DEFER" && p["actor"]=="ASSISTANT_SOURCE_AUDIT"}else{["CONFIRM_SUPPORT", "EXCLUDE", "DEFER"].contains(&action) && p["actor"]=="LOCAL_OPERATOR"})
        && p["reason"].as_str().is_some_and(|x| !x.trim().is_empty() && x.chars().count() <= 2000),
        if source_audit{"INCREMENTAL_SOURCE_AUDIT_INVALID"}else{"INCREMENTAL_HUMAN_DECISION_INVALID"})?;
    let mut decision = json!({"candidate_id": id,
        "candidate_sha256": rows[0]["candidate_sha256"],
        "entry_sha256": reviewed["entry_sha256"],
        "source_snapshot_sha256": hash(&ledger["source_snapshot"]),
        "review_receipt_sha256": hash(&reviewed["review_receipt"]),
        "action": action, "reason": p["reason"], "actor": p["actor"]});
    decision["decision_id"] = json!(format!("{}{}",if source_audit{"saud_"}else{"hsem_"}, &hash(&decision)[..32]));
    let mut out=json!({"contract_version": VERSION, "decision": decision,"publication_performed": false});
    if source_audit {out["source_audit_only"]=json!(true);}Ok(out)
}
fn assess(p: &Value) -> Result<Value> { assess_mode(p, false) }
fn assess_mode(p: &Value, partial: bool) -> Result<Value> {
    let ledger = &p["ledger"]; valid(ledger)?;
    need(p["current_snapshot"].is_object(), "INCREMENTAL_CURRENT_SOURCE_REQUIRED")?;
    let mut blockers = vec![];
    // This narrow path admits only the original, independently reviewed pool.
    // Recovery and operator support promotion retain their atomic semantics.
    if partial && !a(&p["recovery_bundles"]).is_empty() { blockers.push("PARTIAL_RECOVERY_UNSUPPORTED"); }
    if p["current_snapshot"] != ledger["source_snapshot"] { blockers.push("SOURCE_CHANGED"); }
    let entries = a(&ledger["entries"]);
    if entries.len() != ledger["batch_count"].as_u64().unwrap() as usize { blockers.push("BATCHES_UNACCOUNTED"); }
    if entries.iter().any(|e| e["status"] == "TECHNICAL_HOLD") { blockers.push("TECHNICAL_HOLD"); }
    let reports = a(&p["materialization_reports"]);
    let accounted: Vec<_> = entries.iter().filter(|e| e["status"] == "ACCOUNTED").collect();
    let mut recovered_keys=BTreeSet::new(); let mut recovered_candidates=vec![]; let mut recovery_held=vec![]; let mut recovery_excluded=0usize; let mut empty_sources=BTreeSet::new(); let mut empty_batches=BTreeSet::new();
    for repair in a(&p["recovery_bundles"]) {
        let input=&repair["recovery_input"];
        let i=input["batch_index"].as_u64().ok_or_else(||error("RECOVERY_BATCH_INVALID","RECOVERY_BATCH_INVALID"))? as usize;
        let entry=entries.get(i).ok_or_else(||error("RECOVERY_BATCH_INVALID","RECOVERY_BATCH_INVALID"))?;
        need(input["origin_job"]["task_ref"]==ledger["task_ref"]&&input["current_snapshot"]==ledger["source_snapshot"]&&input["original_materialized"]["candidates"]==entry["candidates"],"RECOVERY_LEDGER_BINDING_CHANGED")?;
        let report=reports.iter().find(|r|r["batch_index"]==i).ok_or_else(||error("RECOVERY_REPORT_MISSING","RECOVERY_REPORT_MISSING"))?;
        need(report["quarantined"]==input["original_materialized"]["quarantined"],"RECOVERY_REPORT_CHANGED")?;
        let key=if input["mode"]=="STRUCTURE"{format!("{i}:{}",input["fact_index"])}else{format!("{i}:EMPTY")};
        need(recovered_keys.insert(key),"RECOVERY_DUPLICATE")?;
        let verified=crate::candidate_recovery_v1::execute("verify",repair)?;
        recovered_candidates.extend(a(&verified["candidates"]).iter().cloned());
        recovery_held.extend(a(&verified["held_candidates"]).iter().map(|c|c["candidate_id"].clone()));recovery_excluded+=verified["excluded_candidates"].as_u64().unwrap_or(0) as usize;
        if verified["empty_confirmed"]==true {
            let sources:BTreeSet<_>=a(&input["prepared"]["payload"]["evidence_menu"]).iter().map(|f|s(&f["source_ref"])).collect();
            let reported:BTreeSet<_>=a(&report["source_refs"]).iter().map(s).collect();
            need(sources==reported,"RECOVERY_EMPTY_SOURCE_MAPPING_CHANGED")?;empty_batches.insert(i);
        }
    }
    let mut quarantined = 0usize;
    if reports.len() != accounted.len() { blockers.push("MATERIALIZATION_REPORT_MISSING"); }
    for entry in &accounted {
        let matches: Vec<_> = reports.iter().filter(|r| r["batch_index"] == entry["batch_index"]).collect();
        if matches.len() != 1 || matches[0]["status"] != "PERSISTED"
            || matches[0]["candidates_sha256"] != hash(&entry["candidates"])
            || !matches[0]["quarantined"].is_array() {
            blockers.push("MATERIALIZATION_REPORT_CHANGED");
            continue;
        }
        for item in a(&matches[0]["quarantined"]) {
            need(item["error_code"].as_str().is_some_and(|x| !x.is_empty()), "INCREMENTAL_QUARANTINE_INVALID")?;
            if !recovered_keys.contains(&format!("{}:{}",entry["batch_index"],item["fact_index"])) {quarantined += 1;}
        }
    }
    if quarantined > 0 { blockers.push("MATERIALIZATION_QUARANTINE"); }
    let bundles = a(&p["review_bundles"]);
    if p.get("source_audit_deferrals").is_some(){need(p["source_audit_deferrals"].is_array(),"INCREMENTAL_SOURCE_AUDIT_INVALID")?;}
    let audits=a(&p["source_audit_deferrals"]);let mut audit_ids=BTreeSet::new();let mut used_audits=BTreeSet::new();
    for audit in audits {
        let mut unsigned=audit.clone();
        need(unsigned.is_object(),"INCREMENTAL_SOURCE_AUDIT_INVALID")?;
        unsigned.as_object_mut().unwrap().remove("decision_id");
        need(audit["actor"]=="ASSISTANT_SOURCE_AUDIT" && audit["action"]=="DEFER"
            && audit["candidate_id"].as_str().is_some_and(|v|!v.is_empty()) && audit_ids.insert(s(&audit["candidate_id"]).to_owned())
            && audit["source_snapshot_sha256"]==hash(&ledger["source_snapshot"])
            && audit["reason"].as_str().is_some_and(|v|!v.trim().is_empty()&&v.chars().count()<=2000)
            && audit["decision_id"]==format!("saud_{}",&hash(&unsigned)[..32]),"INCREMENTAL_SOURCE_AUDIT_INVALID")?;
    }
    let human = a(&p["human_decisions"]); let mut human_ids = BTreeSet::new();
    for decision in human {
        need(decision["candidate_id"].as_str().is_some_and(|x| !x.is_empty())
            && human_ids.insert(s(&decision["candidate_id"]).to_owned())
            && decision["candidate_sha256"].as_str().is_some_and(|x| x.len() == 64)
            && decision["entry_sha256"].as_str().is_some_and(|x| x.len() == 64)
            && decision["source_snapshot_sha256"] == hash(&ledger["source_snapshot"])
            && ["CONFIRM_SUPPORT", "EXCLUDE", "DEFER"].contains(&s(&decision["action"]))
            && decision["reason"].as_str().is_some_and(|x| !x.trim().is_empty())
            && decision["actor"] == "LOCAL_OPERATOR", "INCREMENTAL_HUMAN_DECISION_INVALID")?;
    }
    let mut seen = BTreeSet::new(); let mut accepted = vec![]; let mut held = recovery_held; let mut excluded = recovery_excluded; let mut used_human = BTreeSet::new();
    for entry in entries.iter().filter(|e| e["status"] == "ACCOUNTED") {
        if a(&entry["candidates"]).is_empty() { continue; }
        let i = entry["batch_index"].as_u64().unwrap() as usize;
        let matches: Vec<_> = bundles.iter().filter(|b| b["batch_index"] == i).collect();
        if matches.is_empty() { blockers.push("SEMANTIC_REVIEW_MISSING"); continue; }
        need(matches.len() == 1 && seen.insert(i), "INCREMENTAL_REVIEW_DUPLICATED")?;
        let reviewed = review_batch(&json!({"ledger": ledger, "batch_index": i,
            "review_input": matches[0]["review_input"]}))?;
        for decision in a(&reviewed["decisions"]) {
            let candidate = a(&entry["candidates"]).iter().find(|c| c["candidate_id"] == decision["candidate_id"]).unwrap();
            let matches: Vec<_> = human.iter().filter(|h| h["candidate_id"] == decision["candidate_id"]).collect();
            let user = matches.first().copied();
            let audit=audits.iter().find(|d|d["candidate_id"]==decision["candidate_id"]);
            if let Some(d)=audit {
                need(d["candidate_sha256"]==hash(candidate) && d["entry_sha256"]==entry["entry_sha256"]
                    && d["review_receipt_sha256"]==hash(&reviewed["review_receipt"]),"INCREMENTAL_SOURCE_AUDIT_BINDING_CHANGED")?;
                used_audits.insert(s(&decision["candidate_id"]).to_owned());
            }
            if let Some(h) = user {
                need(h["candidate_sha256"] == hash(candidate) && h["entry_sha256"] == entry["entry_sha256"], "INCREMENTAL_HUMAN_BINDING_CHANGED")?;
                if partial {
                    let mut unsigned=h.clone(); unsigned.as_object_mut().unwrap().remove("decision_id");
                    need(h["review_receipt_sha256"] == hash(&reviewed["review_receipt"])
                        && h["decision_id"] == format!("hsem_{}", &hash(&unsigned)[..32]), "INCREMENTAL_HUMAN_BINDING_CHANGED")?;
                }
                used_human.insert(s(&decision["candidate_id"]).to_owned());
            }
            if user.is_some_and(|h| h["action"] == "EXCLUDE") { excluded += 1; }
            else if audit.is_some() || user.is_some_and(|h| h["action"] == "DEFER") { held.push(decision["candidate_id"].clone()); }
            else if decision["status"] == "MODEL_SUPPORTED" || (!partial && user.is_some_and(|h| h["action"] == "CONFIRM_SUPPORT")) { accepted.push(candidate.clone()); }
            else { held.push(decision["candidate_id"].clone()); }
        }
    }
    need(bundles.len() == seen.len(), "INCREMENTAL_REVIEW_EXTRA_BATCH")?;
    need(used_human.len() == human.len(), "INCREMENTAL_HUMAN_EXTRA_CANDIDATE")?;
    need(used_audits.len()==audits.len(),"INCREMENTAL_SOURCE_AUDIT_EXTRA_CANDIDATE")?;
    if !partial { accepted.extend(recovered_candidates.iter().cloned()); }
    if !held.is_empty() { blockers.push("SEMANTIC_DECISIONS_PENDING"); }
    if accepted.is_empty() && excluded > 0 { blockers.push("NO_ACCEPTED_CANDIDATES"); }
    if partial && accepted.is_empty() { blockers.push("NO_ACCEPTED_CANDIDATES"); }
    let source_refs: BTreeSet<String> = a(&ledger["source_snapshot"]["sources"]).iter()
        .filter_map(|source| source["source_ref"].as_str().map(str::to_owned)).collect();
    let candidate_evidence: BTreeSet<String> = entries.iter().flat_map(|entry| a(&entry["candidates"]).iter())
        .chain(recovered_candidates.iter()).flat_map(|candidate| a(&candidate["evidence_ids"]).iter().filter_map(|id| id.as_str().map(str::to_owned))).collect();
    let represented: BTreeSet<String> = p["trusted_context"]["examples"].as_object().into_iter()
        .flat_map(|examples| examples.values()).flat_map(|set| a(&set["fragments"]).iter())
        .filter(|fragment| candidate_evidence.contains(s(&fragment["id"])))
        .filter_map(|fragment| fragment["source_ref"].as_str().map(str::to_owned))
        .filter(|source| source_refs.contains(source)).collect();
    for source in &source_refs {
        let batches:Vec<_>=reports.iter().filter(|r|a(&r["source_refs"]).iter().any(|v|v==source)).collect();
        if !batches.is_empty()&&batches.iter().all(|r|r["batch_index"].as_u64().is_some_and(|i|empty_batches.contains(&(i as usize)))) {empty_sources.insert(source.clone());}
    }
    let unrepresented: Vec<String> = source_refs.difference(&represented).filter(|source| !empty_sources.contains(*source)).cloned().collect();
    if !unrepresented.is_empty() { blockers.push("SOURCE_COVERAGE_MISSING"); }
    let mut unique = BTreeSet::new(); blockers.retain(|code| unique.insert(*code));
    let mut coverage = json!({"planned": ledger["batch_count"], "processed": entries.len(),
        "accounted": entries.iter().filter(|e| e["status"] == "ACCOUNTED").count(),
        "technical_hold": entries.iter().filter(|e| e["status"] == "TECHNICAL_HOLD").count(),
        "accepted_candidates": accepted.len(), "held_candidates": held.len(), "excluded_candidates": excluded,
        "human_decisions": human.len(), "quarantined_proposals": quarantined,
        "sources_total": source_refs.len(), "sources_with_candidates": represented.len(), "sources_reviewed_without_assertions":empty_sources, "recovered_candidates":recovered_candidates.len(),
        "sources_without_candidates": unrepresented});
    if !audits.is_empty(){coverage["source_audit_deferrals"]=json!(audits.len());}
    if partial {
        let incomplete: Vec<_> = blockers.iter().copied().filter(|b| matches!(*b,"MATERIALIZATION_QUARANTINE"|"SEMANTIC_DECISIONS_PENDING")).collect();
        let hard: Vec<_> = blockers.iter().copied().filter(|b| !matches!(*b,"MATERIALIZATION_QUARANTINE"|"SEMANTIC_DECISIONS_PENDING")).collect();
        let ready=hard.is_empty() && !accepted.is_empty();
        let build=if ready { crate::knowledge_build::build(&json!({"candidates":accepted,"snapshot":ledger["source_snapshot"],"trusted_context":p["trusted_context"]}))? } else { Value::Null };
        let mut out=json!({"contract_version":VERSION,"publication_policy":crate::document_scope_coverage_v1::PARTIAL_POLICY,
            "status":if ready{"READY_FOR_SCOPE_REVIEW"}else{"BLOCKED"},"ready_for_scope_review":ready,
            "ready_for_index":false,"build":build,"eligible_candidates":if ready{json!(accepted)}else{json!([])},
            "eligible_candidate_ids":if ready{json!(accepted.iter().map(|c|c["candidate_id"].clone()).collect::<Vec<_>>())}else{json!([])},
            "blockers":blockers,"hard_blockers":hard,"incomplete_blockers":incomplete,"coverage":coverage,
            "candidate_ledger_sha256":ledger["ledger_sha256"],"assessment_input_sha256":hash(p),
            "semantic_support_certified":false,"publication_performed":false});
        if !audits.is_empty(){out["source_audit_deferrals_sha256"]=json!(hash(&p["source_audit_deferrals"]));}
        return Ok(seal(out,"admission_sha256"));
    }
    if !blockers.is_empty() { let mut out=json!({"contract_version": VERSION, "status": "BLOCKED",
        "blockers": blockers, "coverage": coverage, "ready_for_index": false,
        "publication_performed": false});if !audits.is_empty(){out["source_audit_deferrals_sha256"]=json!(hash(&p["source_audit_deferrals"]));}return Ok(out); }
    let build = crate::knowledge_build::build(&json!({"candidates": accepted,
        "snapshot": ledger["source_snapshot"], "trusted_context": p["trusted_context"]}))?;
    let mut out=json!({"contract_version": VERSION, "status": "READY_FOR_FORMAL_INDEX",
        "blockers": [], "coverage": coverage, "build": build,
        "candidate_ledger_sha256": ledger["ledger_sha256"], "graph_digest": build["graph"]["graph_digest"],
        "ready_for_index": true, "publication_performed": false});
    if !audits.is_empty(){out["source_audit_deferrals_sha256"]=json!(hash(&p["source_audit_deferrals"]));}Ok(out)
}
fn formal_bundle(p: &Value) -> Result<Value> {
    let assessed = assess(&p["assessment_input"])?;
    need(assessed["ready_for_index"] == true, "INCREMENTAL_PUBLICATION_NOT_READY")?;
    formal_bundle_for(p, &assessed)
}
fn formal_bundle_for(p: &Value, assessed: &Value) -> Result<Value> {
    let candidate = &p["candidate_write_set"];
    need(candidate["builds"].as_array().is_some_and(|rows| rows.len() == 1)
        && candidate["builds"][0]["task_ref"] == p["assessment_input"]["ledger"]["task_ref"]
        && candidate["read_snapshot"]["source_epoch"] == p["assessment_input"]["current_snapshot"]["source_epoch"]
        && candidate["builds"][0]["graph"]["snapshot"] == p["assessment_input"]["ledger"]["source_snapshot"],
        "INCREMENTAL_CANDIDATE_BUILD_CHANGED")?;
    let original = &candidate["builds"][0];
    let mut evidence_sets=a(&original["evidence_sets"]).to_vec();
    for profile in a(&assessed["build"]["profiles"]) {for reference in a(&profile["evidence_refs"]) {
        let id=&reference["evidence_set_ref"];
        if !evidence_sets.iter().any(|es|es["evidence_set_id"]==*id) {
            let es=&p["assessment_input"]["trusted_context"]["examples"][s(id)];
            need(es["evidence_set_id"]==*id,"RECOVERY_FORMAL_EVIDENCE_MISSING")?;evidence_sets.push(es.clone());
        }
    }}
    let build = json!({"graph":assessed["build"]["graph"], "profiles":assessed["build"]["profiles"],
        "evidence_sets":evidence_sets, "task_ref":original["task_ref"],
        "gate_input_sha256":original["gate_input_sha256"], "gate_result_sha256":hash(&assessed)});
    let body = json!({"contract_version":crate::source_learning_v1::BUNDLE_VERSION,
        "source_scope":candidate["source_scope"], "builds":[build]});
    let digest = hash(&body);
    let revision = format!("slg_{}", &digest[..32]);
    let mut snapshot = p["assessment_input"]["current_snapshot"].clone();
    snapshot["graph_revision"] = json!(revision);
    let bundle = json!({"contract_version":crate::source_learning_v1::BUNDLE_VERSION,
        "source_scope":candidate["source_scope"], "builds":body["builds"],
        "graph_digest":digest, "output_graph_revision":revision, "read_snapshot":snapshot});
    Ok(json!({"contract_version":VERSION, "write_set":bundle,
        "assessment_sha256":hash(&assessed), "publication_performed":false}))
}
fn confirm_publication(p: &Value) -> Result<Value> {
    let assessed = assess(&p["assessment_input"])?;
    need(assessed["ready_for_index"] == true, "INCREMENTAL_PUBLICATION_NOT_READY")?;
    let build = &p["candidate_build"];
    // The supplied build is the independently indexed formal projection.
    need(build["graph"] == assessed["build"]["graph"]
        && build["profiles"] == assessed["build"]["profiles"],
        "INCREMENTAL_FORMAL_INDEX_REBUILD_REQUIRED")?;
    let ack = &p["index_ack"];
    need(ack["status"] == "READY"
        && ack["graph_revision"] == p["candidate_graph_revision"]
        && ack["task_ref"] == p["assessment_input"]["ledger"]["task_ref"]
        && ack["index_payload_sha256"].as_str().is_some_and(|x| x.len() == 64),
        "INCREMENTAL_INDEX_NOT_READY")?;
    let mut receipt = json!({"contract_version": VERSION,
        "source_snapshot_sha256": hash(&p["assessment_input"]["current_snapshot"]),
        "candidate_ledger_sha256": p["assessment_input"]["ledger"]["ledger_sha256"],
        "review_bundles_sha256": hash(&p["assessment_input"]["review_bundles"]),
        "recovery_bundles_sha256":hash(&p["assessment_input"]["recovery_bundles"]),
        "graph_revision": p["candidate_graph_revision"],
        "graph_digest": build["graph"]["graph_digest"],
        "index_ack_sha256": hash(ack), "coverage": assessed["coverage"],
        "publication_status": "PUBLISHED"});
    if let Some(value)=assessed.get("source_audit_deferrals_sha256"){receipt["source_audit_deferrals_sha256"]=value.clone();}
    receipt["receipt_sha256"] = json!(hash(&receipt));
    Ok(json!({"contract_version": VERSION, "publication_receipt": receipt,
        "published_graph_revision": p["candidate_graph_revision"],
        "publication_performed": false, "host_commit_required": true}))
}
// Candidate admission is not publication. A fresh, complete per-task coverage
// receipt must independently name the exact admitted subset to be indexed.
pub const SCOPE_TASK_AUDIT_VERSION:&str="lightog-scope-task-audit/0.1";
fn scope_ids(v:&Value)->Result<BTreeSet<String>> {
    need(v.is_array() && a(v).len()<=4096,"SCOPE_TASK_AUDIT_IDS_INVALID")?;
    let mut out=BTreeSet::new();
    for id in a(v) {need(id.as_str().is_some_and(|x|!x.is_empty() && x.len()<=512) && out.insert(s(id).to_owned()),"SCOPE_TASK_AUDIT_IDS_INVALID")?;}
    Ok(out)
}
fn scope_task_decision(coverage:&Value,plan:&Value,task_id:&Value,reason:&Value)->Result<Value> {
    need(reason.as_str().is_some_and(|x|!x.trim().is_empty() && x.chars().count()<=2000),"SCOPE_TASK_AUDIT_REASON_INVALID")?;
    need(scope_ids(&coverage["supported_task_ids"])?.contains(s(task_id)),"SCOPE_TASK_AUDIT_TASK_NOT_SUPPORTED")?;
    let tasks:Vec<_>=a(&plan["tasks"]).iter().filter(|t|t["id"]==*task_id).collect();
    need(tasks.len()==1,"SCOPE_TASK_AUDIT_TASK_UNKNOWN")?;
    let mut decision=json!({"contract_version":SCOPE_TASK_AUDIT_VERSION,"actor":"ASSISTANT_SCOPE_AUDIT","action":"DEFER",
        "plan_id":coverage["plan_id"],"plan_sha256":hash(plan),"task_id":task_id,"task_sha256":hash(tasks[0]),
        "source_snapshot_sha256":hash(&coverage["snapshot"]),"coverage_receipt_hash":coverage["receipt_hash"],
        "coverage_prepared_sha256":coverage["prepared_sha256"],"admission_sha256":coverage["admission_sha256"],"reason":reason});
    decision["decision_id"]=json!(format!("scaud_{}",&hash(&decision)[..32]));Ok(decision)
}
fn defer_scope_task(p:&Value)->Result<Value> {
    let keys=["coverage_prepared","coverage_raw","coverage_receipt","current_snapshot","task_id","reason","actor","action"];
    need(p.as_object().is_some_and(|o|o.len()==keys.len() && keys.iter().all(|k|o.contains_key(*k))),"SCOPE_TASK_AUDIT_SHAPE_INVALID")?;
    need(p["actor"]=="ASSISTANT_SCOPE_AUDIT" && p["action"]=="DEFER","SCOPE_TASK_AUDIT_DEFER_ONLY")?;
    let coverage=&p["coverage_receipt"];
    need(coverage["readiness_policy"]==crate::document_scope_coverage_v1::PARTIAL_POLICY,"SCOPE_TASK_AUDIT_PARTIAL_REQUIRED")?;
    crate::document_scope_coverage_v1::execute("validate_receipt",&json!({"prepared":p["coverage_prepared"],"raw":p["coverage_raw"],"receipt":coverage,"current_snapshot":p["current_snapshot"]}))?;
    let decision=scope_task_decision(coverage,&p["coverage_prepared"]["input"]["plan"],&p["task_id"],&p["reason"])?;
    Ok(json!({"contract_version":SCOPE_TASK_AUDIT_VERSION,"decision":decision,"scope_audit_only":true,"publication_performed":false}))
}
/// A replayable, conservative projection. The original coverage rows and model
/// receipt remain untouched; these decisions can only remove reusable tasks.
pub fn scope_task_restriction(coverage:&Value,plan:&Value,snapshot:&Value,deferrals:&Value)->Result<Value> {
    need(coverage["readiness_policy"]==crate::document_scope_coverage_v1::PARTIAL_POLICY
        && coverage["plan_id"]==plan["plan_id"] && coverage["plan_sha256"]==hash(plan),"SCOPE_TASK_AUDIT_PLAN_CHANGED")?;
    let mut unsigned=coverage.clone();
    let digest=unsigned.as_object_mut().ok_or_else(||error("SCOPE_TASK_AUDIT_COVERAGE_INVALID","SCOPE_TASK_AUDIT_COVERAGE_INVALID"))?.remove("receipt_hash").unwrap_or(Value::Null);
    need(digest==hash(&unsigned),"SCOPE_TASK_AUDIT_COVERAGE_CHANGED")?;
    need(coverage["snapshot"]["base_ref"]==snapshot["base_ref"] && coverage["snapshot"]["source_epoch"]==snapshot["source_epoch"] && coverage["snapshot"]["sources"]==snapshot["sources"],"SCOPE_TASK_AUDIT_SOURCE_CHANGED")?;
    need(deferrals.is_array() && a(deferrals).len()<=1024,"SCOPE_TASK_AUDIT_DEFERRALS_INVALID")?;
    let mut deferred=BTreeSet::new();let mut decisions=vec![];
    for decision in a(deferrals) {
        need(decision["actor"]=="ASSISTANT_SCOPE_AUDIT" && decision["action"]=="DEFER","SCOPE_TASK_AUDIT_DEFER_ONLY")?;
        need(deferred.insert(s(&decision["task_id"]).to_owned()),"SCOPE_TASK_AUDIT_DUPLICATE_TASK")?;
        let expected=scope_task_decision(coverage,plan,&decision["task_id"],&decision["reason"])?;
        need(*decision==expected,"SCOPE_TASK_AUDIT_DECISION_CHANGED")?;decisions.push(decision.clone());
    }
    decisions.sort_by(|a,b|s(&a["task_id"]).cmp(s(&b["task_id"])));
    let supported:BTreeSet<_>=scope_ids(&coverage["supported_task_ids"])?.difference(&deferred).cloned().collect();
    let reusable:BTreeSet<_>=scope_ids(&coverage["reusable_task_ids"])?.difference(&deferred).cloned().collect();
    let selected:BTreeSet<_>=a(&coverage["rows"]).iter().filter(|r|reusable.contains(s(&r["task_id"]))).flat_map(|r|a(&r["candidate_ids"]).iter().map(|id|s(id).to_owned())).collect();
    need(selected.is_subset(&scope_ids(&coverage["eligible_candidate_ids"])?),"SCOPE_TASK_AUDIT_SUBSET_CHANGED")?;
    let unresolved:BTreeSet<_>=scope_ids(&coverage["unresolved_task_ids"])?.union(&deferred).cloned().collect();
    let mut blockers=a(&coverage["incomplete_blockers"]).to_vec();if !deferred.is_empty(){blockers.push(json!("SCOPE_TASK_AUDIT_DEFERRED"));}
    let partial_ready=coverage["partial_ready"]==true && !selected.is_empty();
    let mut out=json!({"contract_version":SCOPE_TASK_AUDIT_VERSION,"restriction_policy":"DEFER_ONLY_TASK_SUBTRACTION_V1",
        "plan_id":coverage["plan_id"],"plan_sha256":coverage["plan_sha256"],"coverage_receipt_hash":digest,
        "source_snapshot_sha256":hash(&coverage["snapshot"]),"admission_sha256":coverage["admission_sha256"],
        "task_count":a(&plan["tasks"]).len(),"task_scope_deferrals":decisions,"task_scope_deferrals_sha256":hash(&json!(decisions)),
        "audit_deferred_task_ids":deferred,"supported_task_ids":supported,"reusable_task_ids":reusable,"publishable_candidate_ids":selected,
        "unresolved_task_ids":unresolved,"source_insufficient_task_ids":coverage["source_insufficient_task_ids"],
        "all_supported":coverage["all_supported"]==true && deferred.is_empty(),"partial_ready":partial_ready,
        "ready_for_publication":coverage["ready_for_publication"]==true && deferred.is_empty(),
        "readiness_status":if deferred.is_empty(){coverage["readiness_status"].clone()}else if partial_ready{json!("PARTIAL_READY")}else{json!("BLOCKED")},
        "incomplete_blockers":blockers,"whole_scope_complete":false,"coverage_complete":false,"semantic_support_certified":false});
    out["restriction_hash"]=json!(hash(&out));Ok(out)
}
fn validate_partial_scope(p:&Value)->Result<(Value,Value)> {
    let admission=assess_mode(&p["assessment_input"],true)?;
    need(admission["ready_for_scope_review"]==true,"INCREMENTAL_PARTIAL_ADMISSION_BLOCKED")?;
    let prepared=&p["coverage_prepared"];
    let states=prepared["contract_version"]==crate::document_scope_coverage_v1::STATES_VERSION;
    need((prepared["contract_version"]==crate::document_scope_coverage_v1::PARTIAL_VERSION || states)
        && prepared["readiness_policy"]==crate::document_scope_coverage_v1::PARTIAL_POLICY
        && prepared["input"]["admission_input"]==p["assessment_input"]
        && prepared["admission_sha256"]==admission["admission_sha256"],"INCREMENTAL_PARTIAL_SCOPE_BINDING_CHANGED")?;
    let validated=crate::document_scope_coverage_v1::execute("validate_receipt",&json!({
        "prepared":prepared,"raw":p["coverage_raw"],"receipt":p["coverage_receipt"],
        "current_snapshot":p["assessment_input"]["current_snapshot"]}))?;
    need(validated["partial_ready"]==true,"INCREMENTAL_PARTIAL_SCOPE_NOT_READY")?;
    Ok((admission,validated))
}
fn restrict_scope_tasks(p:&Value)->Result<Value> {
    validate_partial_scope(p)?;
    scope_task_restriction(&p["coverage_receipt"],&p["coverage_prepared"]["input"]["plan"],&p["assessment_input"]["current_snapshot"],&p["task_scope_deferrals"])
}
fn partial_gate(p: &Value) -> Result<Value> {
    let (admission,mut validated)=validate_partial_scope(p)?;let prepared=&p["coverage_prepared"];
    let states=prepared["contract_version"]==crate::document_scope_coverage_v1::STATES_VERSION;
    let mut restriction=Value::Null;
    if let Some(deferrals)=p.get("task_scope_deferrals") {
        need(deferrals.is_array(),"SCOPE_TASK_AUDIT_DEFERRALS_INVALID")?;
        if !a(deferrals).is_empty() {
            restriction=scope_task_restriction(&p["coverage_receipt"],&prepared["input"]["plan"],&p["assessment_input"]["current_snapshot"],deferrals)?;
            for field in ["partial_ready","readiness_status","supported_task_ids","reusable_task_ids","publishable_candidate_ids","unresolved_task_ids","all_supported","incomplete_blockers"] {validated[field]=restriction[field].clone();}
            need(validated["partial_ready"]==true,"INCREMENTAL_PARTIAL_SCOPE_NOT_READY")?;
        }
    }
    let selected:BTreeSet<_>=a(&validated["publishable_candidate_ids"]).iter().map(|id|s(id).to_owned()).collect();
    let candidates:Vec<_>=a(&admission["eligible_candidates"]).iter().filter(|c|selected.contains(s(&c["candidate_id"]))).cloned().collect();
    need(!selected.is_empty() && selected.len()==candidates.len(),"INCREMENTAL_PARTIAL_SUBSET_CHANGED")?;
    let build=crate::knowledge_build::build(&json!({"candidates":candidates,
        "snapshot":p["assessment_input"]["ledger"]["source_snapshot"],"trusted_context":p["assessment_input"]["trusted_context"]}))?;
    let mut out=json!({"contract_version":VERSION,"publication_mode":"PARTIAL_SCOPE",
        "publication_policy":crate::document_scope_coverage_v1::PARTIAL_POLICY,
        "admission_sha256":admission["admission_sha256"],"assessment_input_sha256":hash(&p["assessment_input"]),
        "candidate_ledger_sha256":admission["candidate_ledger_sha256"],"coverage":admission["coverage"],
        "incomplete_blockers":if states{&validated["incomplete_blockers"]}else{&admission["incomplete_blockers"]},"scope_receipt_hash":p["coverage_receipt"]["receipt_hash"],
        "scope_plan_id":prepared["input"]["plan"]["plan_id"],"scope_plan_sha256":prepared["plan_sha256"],"scope_prepared_sha256":prepared["prepared_sha256"],
        "task_count":a(&prepared["review_tasks"]).len(),"supported_task_ids":validated["supported_task_ids"],
        "published_candidate_ids":selected,"reusable_task_ids":validated["reusable_task_ids"],
        "unresolved_task_ids":validated["unresolved_task_ids"],"source_insufficient_task_ids":validated["source_insufficient_task_ids"],
        "readiness_status":validated["readiness_status"],"build":build,"ready_for_partial_index":true,
        "whole_scope_complete":false,"coverage_complete":false,"semantic_support_certified":false,"publication_performed":false});
    if states {for field in ["review_protocol","protocol_held_task_ids","extraction_gap_task_ids","unknown_task_ids"]{out[field]=validated[field].clone();}}
    if let Some(value)=admission.get("source_audit_deferrals_sha256"){out["source_audit_deferrals_sha256"]=value.clone();}
    if !restriction.is_null(){out["scope_task_restriction"]=restriction.clone();out["task_scope_deferrals_sha256"]=restriction["task_scope_deferrals_sha256"].clone();out["audit_deferred_task_ids"]=restriction["audit_deferred_task_ids"].clone();}
    Ok(out)
}
fn partial_formal_bundle(p: &Value) -> Result<Value> {
    let selected=partial_gate(p)?;
    let snapshot=&p["assessment_input"]["current_snapshot"];
    need(p["candidate_write_set"]["source_scope"]==json!({"base_ref":snapshot["base_ref"],"source_epoch":snapshot["source_epoch"],"sources":snapshot["sources"]}),"INCREMENTAL_PARTIAL_SOURCE_SCOPE_CHANGED")?;
    // Do not carry unvalidated or unrelated evidence sets from the candidate
    // index. The shared builder adds only source sets used by selected profiles.
    let mut narrow=p.clone();
    need(narrow["candidate_write_set"]["builds"].as_array().is_some_and(|rows|rows.len()==1 && rows[0].is_object()),"INCREMENTAL_CANDIDATE_BUILD_CHANGED")?;
    narrow["candidate_write_set"]["builds"][0]["evidence_sets"]=json!([]);
    let mut out=formal_bundle_for(&narrow,&selected)?;
    for field in ["publication_mode","publication_policy","admission_sha256","scope_receipt_hash","scope_plan_id","scope_plan_sha256","task_count","supported_task_ids","published_candidate_ids","reusable_task_ids","unresolved_task_ids","source_insufficient_task_ids","readiness_status","whole_scope_complete","coverage_complete","incomplete_blockers"] {out[field]=selected[field].clone();}
    for field in ["review_protocol","protocol_held_task_ids","extraction_gap_task_ids","unknown_task_ids","source_audit_deferrals_sha256","scope_task_restriction","task_scope_deferrals_sha256","audit_deferred_task_ids"] {if let Some(value)=selected.get(field){out[field]=value.clone();}}
    Ok(out)
}
fn confirm_partial_publication(p: &Value) -> Result<Value> {
    let selected=partial_gate(p)?;
    let build=&p["candidate_build"];
    need(build["graph"]==selected["build"]["graph"] && build["profiles"]==selected["build"]["profiles"],"INCREMENTAL_FORMAL_INDEX_REBUILD_REQUIRED")?;
    let snapshot=&p["assessment_input"]["current_snapshot"];
    let source_scope=json!({"base_ref":snapshot["base_ref"],"source_epoch":snapshot["source_epoch"],"sources":snapshot["sources"]});
    let body=json!({"contract_version":crate::source_learning_v1::BUNDLE_VERSION,"source_scope":source_scope,"builds":[build]});
    need(build["task_ref"]==p["assessment_input"]["ledger"]["task_ref"]
        && build["gate_result_sha256"]==hash(&selected)
        && p["candidate_graph_revision"]==format!("slg_{}",&hash(&body)[..32]),"INCREMENTAL_PARTIAL_FORMAL_BINDING_CHANGED")?;
    let ack=&p["index_ack"];
    need(ack["status"]=="READY" && ack["graph_revision"]==p["candidate_graph_revision"]
        && ack["task_ref"]==p["assessment_input"]["ledger"]["task_ref"]
        && p["candidate_graph_revision"].as_str().is_some_and(|x|!x.is_empty())
        && ack["index_payload_sha256"].as_str().is_some_and(|x|x.len()==64),"INCREMENTAL_INDEX_NOT_READY")?;
    let mut receipt=json!({"contract_version":VERSION,"source_snapshot_sha256":hash(&p["assessment_input"]["current_snapshot"]),
        "candidate_ledger_sha256":p["assessment_input"]["ledger"]["ledger_sha256"],
        "review_bundles_sha256":hash(&p["assessment_input"]["review_bundles"]),
        "recovery_bundles_sha256":hash(&p["assessment_input"]["recovery_bundles"]),
        "graph_revision":p["candidate_graph_revision"],"graph_digest":build["graph"]["graph_digest"],
        "index_ack_sha256":hash(ack),"coverage":selected["coverage"],"publication_status":"PUBLISHED"});
    for field in ["publication_mode","publication_policy","admission_sha256","scope_receipt_hash","scope_plan_id","scope_plan_sha256","scope_prepared_sha256","task_count","supported_task_ids","published_candidate_ids","reusable_task_ids","unresolved_task_ids","source_insufficient_task_ids","readiness_status","whole_scope_complete","coverage_complete","incomplete_blockers"] {receipt[field]=selected[field].clone();}
    for field in ["review_protocol","protocol_held_task_ids","extraction_gap_task_ids","unknown_task_ids","source_audit_deferrals_sha256","scope_task_restriction","task_scope_deferrals_sha256","audit_deferred_task_ids"] {if let Some(value)=selected.get(field){receipt[field]=value.clone();}}
    receipt["receipt_sha256"]=json!(hash(&receipt));
    Ok(json!({"contract_version":VERSION,"publication_receipt":receipt,
        "published_graph_revision":p["candidate_graph_revision"],"publication_performed":false,"host_commit_required":true}))
}
pub fn execute(op: &str, p: &Value) -> Result<Value> {
    match op { "init" => init(p), "append" => append(p), "progress" => progress(p), "project" => project(p),
        "review_batch" => review_batch(p), "decide_human" => decide_human(p),"defer_source_audit"=>defer_source_audit(p),"defer_scope_task"=>defer_scope_task(p),"restrict_scope_tasks"=>restrict_scope_tasks(p),
        "assess_publication" => assess(p), "formal_bundle" => formal_bundle(p),
        "confirm_publication" => confirm_publication(p),
        "assess_partial_publication"=>assess_mode(p,true), "partial_formal_bundle"=>partial_formal_bundle(p),
        "confirm_partial_publication"=>confirm_partial_publication(p),
        "validate" => { valid(&p["ledger"])?; Ok(json!({"valid": true, "ledger_sha256": p["ledger"]["ledger_sha256"]})) },
        _ => Err(error("INCREMENTAL_OPERATION_UNKNOWN", "INCREMENTAL_OPERATION_UNKNOWN")) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordered_holds_never_publish_and_replay_is_exact() {
        let ledger = execute("init", &json!({"contract_version":VERSION,"task_ref":"job-1","source_snapshot":{"source_epoch":1},"plan_sha256":"plan","batch_count":2})).unwrap();
        let first = json!({"ledger":ledger,"batch_index":0,"status":"TECHNICAL_HOLD","request_id":"call-1","error_code":"MODEL_OUTPUT_UNKNOWN"});
        let appended = execute("append", &first).unwrap();
        assert!(execute("append", &json!({"ledger":appended["ledger"],"batch_index":1,"status":"TECHNICAL_HOLD","request_id":"call-2","error_code":"BAD"})).is_ok());
        assert_eq!(execute("append", &json!({"ledger":appended["ledger"],"batch_index":0,"status":"TECHNICAL_HOLD","request_id":"call-1","error_code":"MODEL_OUTPUT_UNKNOWN"})).unwrap()["idempotent"], true);
        assert!(execute("append", &json!({"ledger":appended["ledger"],"batch_index":0,"status":"TECHNICAL_HOLD","request_id":"call-1","error_code":"CHANGED"})).is_err());
        assert_eq!(execute("progress", &json!({"ledger":appended["ledger"]})).unwrap()["publication_ready"], false);
        let assessed = execute("assess_publication", &json!({"ledger":appended["ledger"],
            "current_snapshot":{"source_epoch":1},"review_bundles":[],"trusted_context":{}})).unwrap();
        assert_eq!(assessed["status"], "BLOCKED");
        assert!(a(&assessed["blockers"]).contains(&json!("TECHNICAL_HOLD")));
    }
    #[test]
    fn accounted_batch_with_quarantined_proposal_cannot_publish() {
        let snapshot = json!({"source_epoch":1});
        let ledger = execute("init", &json!({"contract_version":VERSION,"task_ref":"job-2",
            "source_snapshot":snapshot,"plan_sha256":"plan","batch_count":1})).unwrap();
        let staging = json!({"prepared":{"payload":{"snapshot":snapshot}},
            "candidates":[],"receipts":[]});
        let appended = execute("append", &json!({"ledger":ledger,"batch_index":0,
            "status":"ACCOUNTED","request_id":"returned-call","staging_input":staging})).unwrap();
        let assessed = execute("assess_publication", &json!({"ledger":appended["ledger"],
            "current_snapshot":snapshot,"review_bundles":[],"human_decisions":[],
            "materialization_reports":[{"batch_index":0,"status":"PERSISTED",
                "candidates_sha256":hash(&json!([])),"quarantined":[{"error_code":"CANDIDATE_RELATION_INVALID"}]}],
            "trusted_context":{}})).unwrap();
        assert_eq!(assessed["ready_for_index"], false);
        assert_eq!(assessed["coverage"]["quarantined_proposals"], 1);
        assert!(a(&assessed["blockers"]).contains(&json!("MATERIALIZATION_QUARANTINE")));
    }
    #[test]
    fn unrepresented_source_blocks_formal_publication() {
        let snapshot = json!({"source_epoch":2,"sources":[{"source_ref":"source_a"},{"source_ref":"source_b"}]});
        let ledger = execute("init", &json!({"contract_version":VERSION,"task_ref":"job-3",
            "source_snapshot":snapshot,"plan_sha256":"plan","batch_count":1})).unwrap();
        let appended = execute("append", &json!({"ledger":ledger,"batch_index":0,
            "status":"ACCOUNTED","request_id":"returned-call","staging_input":{
                "prepared":{"payload":{"snapshot":snapshot}},"candidates":[],"receipts":[]}})).unwrap();
        let assessed = execute("assess_publication", &json!({"ledger":appended["ledger"],
            "current_snapshot":snapshot,"review_bundles":[],"human_decisions":[],
            "materialization_reports":[{"batch_index":0,"status":"PERSISTED",
                "candidates_sha256":hash(&json!([])),"quarantined":[]}],"trusted_context":{"examples":{}}})).unwrap();
        assert_eq!(assessed["ready_for_index"], false);
        assert_eq!(assessed["coverage"]["sources_without_candidates"], json!(["source_a","source_b"]));
        assert!(a(&assessed["blockers"]).contains(&json!("SOURCE_COVERAGE_MISSING")));
    }
}
