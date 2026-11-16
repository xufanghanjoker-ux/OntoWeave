//! Versioned fine-menu, explicit-support source-fact gap state; old states stay frozen.
//! Serialized states/receipts are trusted-host bindings, not signatures or truth certificates.
use crate::common::{a, canonical_hash as hash, error, s, Result};
use serde_json::{json, Value};
use std::collections::BTreeSet;
pub const VERSION: &str = "lightog-source-gap-state/0.3";
fn need(ok: bool, code: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(error(code, code))
    }
}
fn shape(v: &Value, keys: &[&str]) -> Result<()> {
    let m = v
        .as_object()
        .ok_or_else(|| error("GAP_STATE_SHAPE", "GAP_STATE_SHAPE"))?;
    need(
        m.len() == keys.len() && keys.iter().all(|k| m.contains_key(*k)),
        "GAP_STATE_SHAPE",
    )
}
fn seal(mut v: Value) -> Value {
    v.as_object_mut().unwrap().remove("state_sha256");
    v["state_sha256"] = json!(hash(&v));
    v
}
fn checked(v: &Value) -> Result<Value> {
    let mut c = v.clone();
    c.as_object_mut()
        .ok_or_else(|| error("GAP_STATE_INVALID", "GAP_STATE_INVALID"))?
        .remove("state_sha256");
    need(
        v["version"] == VERSION && v["state_sha256"] == hash(&c),
        "GAP_STATE_HASH",
    )?;
    need(
        v["baseline_sha256"] == hash(&v["baseline"])
            && v["task_sha256"] == hash(&v["task"])
            && v["source_artifact_sha256"] == hash(&v["source_artifact"]),
        "GAP_STATE_INPUT_CHANGED",
    )?;
    Ok(v.clone())
}
fn returned_failure(mut st: Value, r: &Value, code: &str) -> Value {
    if let Some(row) = st["requests"].as_array_mut().and_then(|r| r.last_mut()) {
        row["status"] = json!("RETURNED_REJECTED_NO_RETRY");
        row["response_sha256"] = json!(hash(r));
        row["actual_call"] = r["actual_call"].clone();
        row["usage"] = r["usage"].clone();
        row["error_code"] = json!(code);
    }
    failure(st, code, false)
}
fn terminal(st: &Value) -> bool {
    s(&st["phase"]).starts_with("STOPPED") || st["phase"] == "COMPLETED"
}
fn failure(mut st: Value, code: &str, unknown: bool) -> Value {
    st["phase"] = json!("STOPPED_NO_RETRY");
    st["error_code"] = json!(code);
    st["unknown_outcome"] = json!(unknown);
    seal(st)
}
fn ids(candidates: &Value) -> Result<BTreeSet<String>> {
    let mut ids = BTreeSet::new();
    for c in candidates
        .as_array()
        .ok_or_else(|| error("GAP_CANDIDATES_INVALID", "GAP_CANDIDATES_INVALID"))?
    {
        let id = s(&c["candidate_id"]);
        need(
            !id.is_empty() && ids.insert(id.into()),
            "GAP_CANDIDATE_ID_COLLISION",
        )?;
    }
    Ok(ids)
}
fn menu(p: &Value) -> Result<Value> {
    shape(
        p,
        &["task", "retrieval", "source_artifact", "guidance", "mode"],
    )?;
    let src = &p["source_artifact"];
    let task = &p["task"];
    let r = &p["retrieval"];
    let snapshot = &src["snapshot"];
    crate::source_support_gap_v2::execute(
        "validate",
        &json!({"contract_version":crate::source_support_gap_v2::VERSION,"task":task,"source_artifact":src}),
    )?;
    need(
        ["COMPLETED", "COMPLETED_KNOWN_RERANK_FALLBACK"].contains(&s(&r["status"]))
            && r["purpose"] == "GAP"
            && r["mode"] == p["mode"]
            && ["LEXICAL", "HYBRID"].contains(&s(&p["mode"]))
            && r["result"]["snapshot"] == *snapshot,
        "GAP_RETRIEVAL_NOT_READY",
    )?;
    need(
        r["contexts"] == r["result"]["contexts"]
            && r["raw_fragments"] == r["contexts"]
            && !a(&r["contexts"]).is_empty(),
        "GAP_RETRIEVAL_CONTEXTS",
    )?;
    let b = &r["input_bindings"];
    need(
        b["task_sha256"] == hash(task)
            && b["artifact_sha256"] == hash(src)
            && b["active_graph_sha256"] == hash(&src["p2Build"])
            && b["source_sha256"] == src["source_sha256"]
            && b["snapshot_sha256"] == hash(snapshot)
            && b["query_sha256"] == crate::common::text_sha(s(&task["source_support_query"]))
            && r["query_text"] == task["source_support_query"],
        "GAP_RETRIEVAL_BINDING",
    )?;
    for req in [
        &r["payloads"]["document_request"],
        &r["payloads"]["graph_request"],
    ] {
        need(
            req["question"] == task["source_support_query"]
                && req["snapshot"] == *snapshot
                && req["queries"]
                    == json!({"document":task["source_support_query"],"entity":task["source_support_query"],"relation":task["source_support_query"]}),
            "GAP_RETRIEVAL_QUERY",
        )?;
    }
    let cap = r["budget_preview"]["limits"]["max_context_utf16"]
        .as_u64()
        .filter(|n| (1..=16000).contains(n))
        .ok_or_else(|| error("GAP_RETRIEVAL_BUDGET", "GAP_RETRIEVAL_BUDGET"))?;
    let replay = crate::evidence_routing::execute(
        "compose",
        &json!({"contract_version":"lightog-source-first-routing/0.1","document_request":r["payloads"]["document_request"],"graph_request":r["payloads"]["graph_request"],"policy":{"max_context_utf16":cap}}),
    )?;
    need(hash(&replay) == hash(&r["result"]), "GAP_RETRIEVAL_REPLAY")?;
    let mut known = std::collections::BTreeMap::new();
    for es in src["context"]["examples"]
        .as_object()
        .ok_or_else(|| error("GAP_CONTEXT_INVALID", "GAP_CONTEXT_INVALID"))?
        .values()
    {
        if es["snapshot"] == *snapshot {
            for f in a(&es["fragments"]) {
                let id = s(&f["id"]);
                if let Some(old) = known.insert(id.to_owned(), f.clone()) {
                    need(old == *f, "GAP_FRAGMENT_COLLISION")?;
                }
            }
        }
    }
    let mut selected = vec![];
    let mut seen = BTreeSet::new();
    let mut retrieved = vec![];
    for f in a(&r["contexts"]) {
        let id = s(&f["id"]);
        need(
            f["origin"] == "SOURCE_FRAGMENT" && known.get(id) == Some(f),
            "GAP_RAW_FRAGMENT_CHANGED",
        )?;
        if seen.insert(id.to_owned()) {
            selected.push(id.to_owned());
            retrieved.push(id.to_owned());
        }
    }
    for id in a(&task["source_evidence_ids"]) {
        if seen.insert(s(id).to_owned()) {
            selected.push(s(id).to_owned());
        }
    }
    for id in a(&task["candidate_ids"]) {
        let c = a(&src["all_proposal_candidates"])
            .iter()
            .find(|c| c["candidate_id"] == *id)
            .ok_or_else(|| error("GAP_PARENT_UNKNOWN", "GAP_PARENT_UNKNOWN"))?;
        for eid in a(&c["evidence_ids"]) {
            if seen.insert(s(eid).to_owned()) {
                selected.push(s(eid).to_owned());
            }
        }
    }
    let fragments: Vec<Value> = selected
        .iter()
        .map(|id| {
            known
                .get(id)
                .cloned()
                .ok_or_else(|| error("GAP_EVIDENCE_UNKNOWN", "GAP_EVIDENCE_UNKNOWN"))
        })
        .collect::<Result<_>>()?;
    let utf16: usize = fragments
        .iter()
        .map(|f| crate::common::len(s(&f["span"]["quote"])))
        .sum();
    need(utf16 <= 24000, "GAP_CONTEXT_LIMIT")?;
    let esid = format!(
        "source_gap_{}",
        &hash(&json!({"task":task,"fragments":fragments,"snapshot":snapshot}))[..24]
    );
    let es = json!({"contract_version":"lightog-demand/0.1","evidence_set_id":esid,"snapshot":snapshot,"fragments":fragments});
    let mut ctx = src["context"].clone();
    ctx["examples"][&esid] = es;
    let refined = crate::fine_source_evidence::execute("refine", &json!({
        "contract_version":crate::fine_source_evidence::VERSION,
        "evidence_set":ctx["examples"][&esid], "context":ctx
    }))?;
    let fine_id = s(&refined["evidence_set"]["evidence_set_id"]).to_owned();
    ctx["examples"][&fine_id] = refined["evidence_set"].clone();
    let prepared = crate::knowledge_build::prepare_extract(&json!({
        "evidence_set_ref":fine_id,"cq_guidance":p["guidance"],"trusted_context":ctx
    }))?;
    let menu = json!({"evidence_set":refined["evidence_set"],"prepared":prepared,"refinement":refined});
    Ok(
        json!({"context":ctx,"prepared":menu["prepared"],"menu":menu,"retrieval_lineage":{"task_sha256":hash(task),"source_artifact_sha256":hash(src),"retrieval_sha256":hash(r),"retrieved_fragment_ids":retrieved,"actual_extraction_menu_ids":a(&menu["prepared"]["payload"]["evidence_menu"]).iter().map(|f|f["evidence_id"].clone()).collect::<Vec<_>>(),"actual_extraction_menu_utf16":a(&menu["prepared"]["payload"]["evidence_menu"]).iter().map(|f|crate::common::len(s(&f["span"]["quote"]))).sum::<usize>(),"routing_source_evidence_ids":selected,"retrieved_utf16":a(&r["contexts"]).iter().map(|f|crate::common::len(s(&f["span"]["quote"]))).sum::<usize>(),"parent_locator_evidence_ids":task["source_evidence_ids"],"semantic_support_certified":false,"cq_coverage_proof":false}}),
    )
}
fn init(p: &Value) -> Result<Value> {
    shape(
        p,
        &[
            "baseline_artifact",
            "source",
            "cq_seeds",
            "source_artifact",
            "task",
            "context",
            "prepared",
            "session_id",
            "mode",
            "origin",
            "evaluation_label_set_sha256",
            "evaluation_started_at",
            "max_calls",
            "retrieval",
        ],
    )?;
    need(
        ["LEXICAL", "HYBRID"].contains(&s(&p["mode"]))
            && ["SYNTHETIC", "FRESH_MODEL"].contains(&s(&p["origin"]))
            && !s(&p["session_id"]).is_empty()
            && s(&p["session_id"]).len() <= 100
            && p["max_calls"] == 2,
        "GAP_STATE_SCOPE",
    )?;
    let base = &p["baseline_artifact"];
    let src = &p["source_artifact"];
    let selected = crate::source_support_gap_v2::execute(
        "prepare",
        &json!({"contract_version":crate::source_support_gap_v2::VERSION,"source":p["source"],"artifact":base,"cq_seeds":p["cq_seeds"]}),
    )?;
    need(
        selected["status"] == "SOURCE_SUPPORT_GAP_READY"
            && selected["task"] == p["task"]
            && selected["sourceArtifact"] == *src,
        "GAP_BASELINE_SELECTION_CHANGED",
    )?;
    need(
        base["source_id"] == src["source_id"]
            && base["source_sha256"] == src["source_sha256"]
            && base["snapshot"] == src["snapshot"]
            && base["p2Build"] == src["p2Build"]
            && base["all_proposal_candidates"] == src["all_proposal_candidates"],
        "GAP_BASELINE_PROJECTION_CHANGED",
    )?;
    crate::source_support_gap_v2::execute(
        "validate",
        &json!({"contract_version":crate::source_support_gap_v2::VERSION,"task":p["task"],"source_artifact":src}),
    )?;
    need(
        src["context"]["source_texts"] == p["context"]["source_texts"]
            && src["context"]["authority"] == p["context"]["authority"],
        "GAP_OLD_SOURCE_CONTEXT_CHANGED",
    )?;
    let old_examples = src["context"]["examples"]
        .as_object()
        .ok_or_else(|| error("GAP_CONTEXT_INVALID", "GAP_CONTEXT_INVALID"))?;
    need(
        old_examples
            .iter()
            .all(|(k, v)| p["context"]["examples"].get(k) == Some(v)),
        "GAP_OLD_EXAMPLE_CHANGED",
    )?;
    // Rebuild the retrieved fine menu at initialization; a caller cannot substitute
    // a coarse or unrelated EvidenceSet while retaining the new protocol version.
    let expected_menu = menu(&json!({"task":p["task"],"retrieval":p["retrieval"],
        "source_artifact":src,"guidance":selected["cq_guidance"],"mode":p["mode"]}))?;
    need(expected_menu["context"] == p["context"] && expected_menu["prepared"] == p["prepared"],
        "GAP_FINE_MENU_REPLAY_CHANGED")?;
    let old = ids(&base["all_proposal_candidates"])?;
    let active = ids(&base["p2Build"]["graph"]["candidate_archive"])?;
    need(
        active.is_subset(&old)
            && a(&p["task"]["candidate_ids"])
                .iter()
                .all(|id| !active.contains(s(id))),
        "GAP_PARENT_ALREADY_ACTIVE",
    )?;
    let rebuilt = crate::knowledge_build::build(
        &json!({"candidates":base["p2Build"]["graph"]["candidate_archive"],"patterns":base["p2Build"]["graph"]["pattern_archive"],"snapshot":base["snapshot"],"trusted_context":p["context"]}),
    )?;
    need(rebuilt == base["p2Build"], "GAP_OLD_ACTIVE_CHANGED")?;
    let prepared = crate::knowledge_build::prepare_extract(
        &json!({"evidence_set_ref":p["prepared"]["payload"]["evidence_set_ref"],"cq_guidance":p["prepared"]["payload"]["cq_guidance"],"trusted_context":p["context"]}),
    )?;
    need(
        prepared == p["prepared"] && prepared["payload"]["snapshot"] == base["snapshot"],
        "GAP_PREPARED_CHANGED",
    )?;
    Ok(seal(
        json!({"version":VERSION,"fine_menu_receipt":expected_menu["menu"]["refinement"]["receipt"],"phase":"READY_PROPOSAL","baseline":base,"baseline_sha256":hash(base),"source_artifact":src,"source_artifact_sha256":hash(src),"task":p["task"],"task_sha256":hash(&p["task"]),"context":p["context"],"prepared":prepared,"session_id":p["session_id"],"unit_id":format!("source_gap_{}", &hash(&json!([p["session_id"],p["mode"],hash(&p["task"])]))[..24]),"mode":p["mode"],"origin":p["origin"],"evaluation_label_set_sha256":p["evaluation_label_set_sha256"],"evaluation_started_at":p["evaluation_started_at"],"new_candidates":[],"new_eligible":[],"requests":[],"attempts":0,"unknown_outcome":false,"historical_calls_counted":0,"repair_calls":0,"retry_calls":0,"cq_coverage_proof":false,"publication_performed":false}),
    ))
}
fn start(p: &Value) -> Result<Value> {
    shape(p, &["state", "request"])?;
    let mut st = checked(&p["state"])?;
    let r = &p["request"];
    shape(r, &["kind", "messages", "max_tokens", "enable_thinking"])?;
    let proposal = st["phase"] == "READY_PROPOSAL";
    need(
        proposal || st["phase"] == "READY_REVIEW",
        "GAP_PHASE_NOT_READY_NO_RESEND",
    )?;
    need(
        r["kind"]
            == if proposal {
                "GAP_EXTRACT"
            } else {
                "SEMANTIC_REVIEW"
            }
            && r["max_tokens"] == if proposal { 6000 } else { 8000 }
            && r["enable_thinking"] == false
            && r["messages"].as_array().is_some_and(|a| a.len() == 2),
        "GAP_REQUEST_SCOPE",
    )?;
    let count = st["attempts"].as_u64().unwrap_or(99);
    need(count < 2, "GAP_CALL_CAP")?;
    let id = format!(
        "sg_{}",
        &hash(&json!([st["session_id"], st["mode"], st["task_sha256"], r]))[..36]
    );
    let mut req = r.clone();
    req["request_id"] = json!(id);
    st["pending_request"] = req.clone();
    st["attempts"] = json!(count + 1);
    st["phase"] = json!(if proposal {
        "WAIT_PROPOSAL"
    } else {
        "WAIT_REVIEW"
    });
    st["requests"].as_array_mut().unwrap().push(
        json!({"request_id":id,"kind":r["kind"],"status":"STARTED","request_sha256":hash(&req)}),
    );
    Ok(
        json!({"state":seal(st),"action":{"kind":"MODEL_IO","persist_before_send":true,"request":req},"retry_allowed":false}),
    )
}
fn response(st: &Value, r: &Value) -> Result<Value> {
    need(
        r["request_id"] == st["pending_request"]["request_id"]
            && r["content"].is_string()
            && r["actual_call"] == (st["origin"] == "FRESH_MODEL")
            && !s(&r["model"]).is_empty()
            && r["config_revision"].as_u64().is_some_and(|n| n > 0)
            && r["finish_reason"] != "length",
        "GAP_RESPONSE_BINDING",
    )?;
    if !st["model_binding"].is_null() {
        need(
            st["model_binding"]
                == json!({"model":r["model"],"config_revision":r["config_revision"]}),
            "GAP_MODEL_DRIFT",
        )?;
    }
    crate::model_json_boundary::parse(s(&r["content"]))
}
fn record(st: &mut Value, r: &Value, parsed: &Value) {
    st["model_binding"] = json!({"model":r["model"],"config_revision":r["config_revision"]});
    let last = st["requests"].as_array_mut().unwrap().last_mut().unwrap();
    last["status"] = json!("COMPLETED");
    last["response_sha256"] = json!(hash(r));
    last["json_boundary_receipt"] = parsed["receipt"].clone();
    last["actual_call"] = r["actual_call"].clone();
    last["usage"] = r["usage"].clone();
}
fn proposal(p: &Value) -> Result<Value> {
    shape(p, &["state", "response"])?;
    let mut st = checked(&p["state"])?;
    // Same completed proposal can be replayed; a changed receipt never replaces it.
    let key = hash(&p["response"]);
    if st["proposal_completion_sha256"] == key {
        return Ok(st);
    }
    need(st["phase"] == "WAIT_PROPOSAL", "GAP_PROPOSAL_PHASE")?;
    let parsed = match response(&st, &p["response"]) {
        Ok(v) => v,
        Err(e) => return Ok(returned_failure(st, &p["response"], &e.code)),
    };
    let namespace = crate::seed_materialize::execute(
        "namespace",
        &json!({"unit_id":st["unit_id"],"round_id":"source-support-1","stage":"GAP_EXTRACT"}),
    )?;
    let materialized = match crate::support_selection::execute(
        "materialize",
        &json!({"prepared":st["prepared"],"trusted_context":st["context"],"raw":parsed["parsed"],"unit_id":namespace["namespace_unit_id"],"max_candidates":8}),
    ) {
        Ok(v) => v,
        Err(e) => return Ok(returned_failure(st, &p["response"], &e.code)),
    };
    let run = (|| -> Result<Value> {
        let m = &materialized;
        need(
            m["original_support_selection_raw_sha256"] == hash(&parsed["parsed"]),
            "GAP_MATERIALIZATION_RAW_MISMATCH",
        )?;
        let old = ids(&st["baseline"]["all_proposal_candidates"])?;
        let new = ids(&m["candidates"])?;
        need(
            new.len() <= 8 && old.is_disjoint(&new),
            "GAP_NEW_ID_COLLIDES",
        )?;
        need(m["receipts"].is_array(), "GAP_RECEIPTS_REQUIRED")?;
        if new.is_empty() {
            need(
                a(&m["receipts"])
                    .iter()
                    .all(|r| r["status"] != "VALIDATED_CANDIDATE"),
                "GAP_RECEIPT_UNMATCHED",
            )?;
            return Ok(Value::Null);
        }
        let input = json!({"contract_version":crate::semantic_review_v2::VERSION,"candidates":m["candidates"],"prepared":st["prepared"],"trusted_context":st["context"],"receipts":m["receipts"],"context_evidence_ids":st["prepared"]["payload"]["evidence_menu"].as_array().unwrap().iter().map(|f|f["evidence_id"].clone()).collect::<Vec<_>>(),"max_context_utf16":24000});
        let review = crate::semantic_review_v2::execute("prepare", &input)?;
        Ok(json!({"input":input,"prepared":review}))
    })();
    match run {
        Err(e) => Ok(returned_failure(st, &p["response"], &e.code)),
        Ok(review) => {
            record(&mut st, &p["response"], &parsed);
            st["proposal_completion_sha256"] = json!(key);
            st["new_candidates"] = materialized["candidates"].clone();
            st["proposal_materialized"] = materialized.clone();
            st["proposal_raw_parsed"] = parsed["parsed"].clone();
            st["phase"] = json!(if review.is_null() {
                "COMPLETED"
            } else {
                "READY_REVIEW"
            });
            st["review_prepared"] = review;
            st["materialization_authority"] =
                json!("RUST_REGISTRY_CONVERSION_AND_RUST_VALIDATION_NOT_SEMANTIC_CERTIFICATE");
            Ok(seal(st))
        }
    }
}
fn review(p: &Value) -> Result<Value> {
    shape(p, &["state", "response"])?;
    let mut st = checked(&p["state"])?;
    let key = hash(&p["response"]);
    if st["review_completion_sha256"] == key {
        return Ok(st);
    }
    need(st["phase"] == "WAIT_REVIEW", "GAP_REVIEW_PHASE")?;
    let parsed = match response(&st, &p["response"]) {
        Ok(v) => v,
        Err(e) => return Ok(returned_failure(st, &p["response"], &e.code)),
    };
    let mut input = st["review_prepared"]["input"].clone();
    input["manifest"] = st["review_prepared"]["prepared"]["manifest"].clone();
    input["review_output"] = parsed["parsed"].clone();
    input["review_provenance"] = json!({"origin":st["origin"],"review_request_id":p["response"]["request_id"],"proposal_request_ids":[st["requests"][0]["request_id"]],"review_output_sha256":hash(&parsed["parsed"]),"model":p["response"]["model"],"config_revision":p["response"]["config_revision"]});
    match crate::semantic_review_v2::execute("apply", &input) {
        Err(e) => Ok(returned_failure(st, &p["response"], &e.code)),
        Ok(gate) => {
            record(&mut st, &p["response"], &parsed);
            st["new_eligible"] = gate["eligible_candidates"].clone();
            st["gate_input"] = input;
            st["gate_result"] = gate;
            st["review_completion_sha256"] = json!(key);
            st["phase"] = json!("COMPLETED");
            Ok(seal(st))
        }
    }
}
fn artifact(p: &Value) -> Result<Value> {
    shape(p, &["state"])?;
    let st = checked(&p["state"])?;
    need(terminal(&st), "GAP_NOT_TERMINAL")?;
    if !st["gate_input"].is_null() {
        let replay = crate::semantic_review_v2::execute("apply", &st["gate_input"])?;
        need(
            replay == st["gate_result"]
                && replay["eligible_candidates"] == st["new_eligible"]
                && replay["all_proposal_candidates"] == st["new_candidates"],
            "GAP_FINAL_GATE_REPLAY_CHANGED",
        )?;
    } else {
        need(
            a(&st["new_eligible"]).is_empty(),
            "GAP_UNREVIEWED_NEW_ELIGIBLE",
        )?;
    }
    let base = &st["baseline"];
    let mut active = a(&base["p2Build"]["graph"]["candidate_archive"]).to_vec();
    active.extend(a(&st["new_eligible"]).iter().cloned());
    let mut all = a(&base["all_proposal_candidates"]).to_vec();
    all.extend(a(&st["new_candidates"]).iter().cloned());
    ids(&json!(all))?;
    let build = crate::knowledge_build::build(
        &json!({"candidates":active,"patterns":base["p2Build"]["graph"]["pattern_archive"],"snapshot":base["snapshot"],"trusted_context":st["context"]}),
    )?;
    let activeids = ids(&build["graph"]["candidate_archive"])?;
    need(
        a(&st["task"]["candidate_ids"])
            .iter()
            .all(|id| !activeids.contains(s(id))),
        "GAP_PARENT_AUTO_PROMOTED",
    )?;
    let mut out = base.clone();
    out["context"] = st["context"].clone();
    out["p2Build"] = build;
    out["all_proposal_candidates"] = json!(all);
    let unit_id = format!(
        "source_gap_{}",
        &hash(&json!([st["session_id"], st["mode"], st["task_sha256"]]))[..24]
    );
    let mut batches = a(&base["semantic_batches"]).to_vec();
    if !st["gate_result"].is_null() {
        batches.push(json!({"unit_id":unit_id,"result":{"gate_input":st["gate_input"],"gate_result":st["gate_result"],"proposal_materialized":st["proposal_materialized"],"eligible_candidates":st["new_eligible"]}}));
    }
    out["semantic_batches"] = json!(batches);
    let mut prepared_batches = if base["prepared_batches"].is_array() {
        a(&base["prepared_batches"]).to_vec()
    } else {
        a(&base["semantic_batches"]).iter().map(|b|json!({"unit_id":b["unit_id"],"prepared":b["result"]["gate_input"]["prepared"],"receipts":b["result"]["gate_input"]["receipts"]})).collect()
    };
    prepared_batches.push(json!({"unit_id":unit_id,"prepared":st["prepared"],"receipts":st["proposal_materialized"]["receipts"].as_array().cloned().unwrap_or_default()}));
    let refs: BTreeSet<String> = prepared_batches
        .iter()
        .map(|b| s(&b["prepared"]["payload"]["evidence_set_ref"]).to_owned())
        .collect();
    out["prepared_batches"] = json!(prepared_batches);
    out["segment_evidence_set_refs"] = json!(refs);
    let mut failed = a(&base["failed_units"]).to_vec();
    if st["phase"] != "COMPLETED" {
        failed.push(json!({"unit_id":unit_id,"error_code":st["error_code"],"proposal_materialized":st["proposal_materialized"],"unknown_outcome":st["unknown_outcome"]}));
    }
    out["failed_units"] = json!(failed);
    out["origin"] = json!("ARCHIVED_BASELINE_PLUS_SOURCE_GAP_DIAGNOSTIC");
    out["evaluation_label_set_sha256"] = st["evaluation_label_set_sha256"].clone();
    out["evaluation_started_at"] = st["evaluation_started_at"].clone();
    out["source_gap_state"] = st.clone();
    out["source_gap_lineage"] = json!({"baseline_artifact_sha256":st["baseline_sha256"],"task_sha256":st["task_sha256"],"mode":st["mode"],"parent_promoted":false,"old_candidates_changed":false,"historical_calls_counted":0,"new_transport_attempts":st["attempts"]});
    out["cq_coverage_proof"] = json!(false);
    out["publication_performed"] = json!(false);
    Ok(out)
}
pub fn execute(op: &str, p: &Value) -> Result<Value> {
    need(
        serde_json::to_vec(p)
            .map_err(|_| error("GAP_STATE_INVALID", "GAP_STATE_INVALID"))?
            .len()
            <= 32 * 1024 * 1024,
        "GAP_STATE_RESOURCE_LIMIT",
    )?;
    match op {
        "menu" => menu(p),
        "init" => init(p),
        "start" => start(p),
        "proposal" => proposal(p),
        "review" => review(p),
        "artifact" => artifact(p),
        "stop" => {
            shape(p, &["state", "code", "unknown_outcome"])?;
            let st = checked(&p["state"])?;
            need(
                !s(&p["code"]).is_empty() && p["unknown_outcome"].is_boolean(),
                "GAP_STOP_REASON",
            )?;
            if terminal(&st) {
                Ok(st)
            } else {
                Ok(failure(st, s(&p["code"]), p["unknown_outcome"] == true))
            }
        }
        _ => Err(error(
            "GAP_STATE_OPERATION_UNKNOWN",
            "GAP_STATE_OPERATION_UNKNOWN",
        )),
    }
}
