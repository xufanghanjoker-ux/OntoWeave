//! Versioned old/new semantic-gate replay for source support-gap selection.
//! Source-fact support-gap selection and binding. No model, HTTP, storage or
//! semantic inference; historical judgments only select a nonactive locator.
use crate::common::{a, canonical_hash as hash, error, len, s, sha, Result};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const VERSION: &str = "lightog-source-support-gap/0.2";
const NEUTRAL: &str = "Independently recheck this unverified source-fact proposal against the registered original source fragments. The immutable parent is a locator and a proposal, not evidence or a required positive conclusion. Propose a complete new source-grounded fact only if warranted; preserve subject, direction, negation, conditions, scope, modality, time and units. Contradicted, partial and unknown outcomes are allowed. Do not edit or promote the parent, assume an omitted restriction is absent, or infer CQ/full-document coverage.";
fn need(ok: bool, code: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(error(code, code))
    }
}
fn shape(v: &Value, keys: &[&str]) -> Result<()> {
    need(
        v.as_object()
            .is_some_and(|m| m.len() == keys.len() && keys.iter().all(|k| m.contains_key(*k))),
        "SOURCE_GAP_SHAPE_INVALID",
    )
}
fn rows<'a>(v: &'a Value, max: usize, code: &str) -> Result<&'a Vec<Value>> {
    let r = v.as_array().ok_or_else(|| error(code, code))?;
    need(r.len() <= max, code)?;
    Ok(r)
}
fn candidates(v: &Value) -> Result<BTreeMap<String, Value>> {
    let mut out = BTreeMap::new();
    for c in rows(v, 256, "SOURCE_GAP_CANDIDATE_ARCHIVE_INVALID")? {
        let id = s(&c["candidate_id"]);
        need(
            !id.is_empty() && out.insert(id.to_owned(), c.clone()).is_none(),
            "SOURCE_GAP_CANDIDATE_DUPLICATE",
        )?;
    }
    Ok(out)
}
fn fragments(context: &Value, snapshot: &Value) -> Result<BTreeMap<String, Value>> {
    let sets = context["examples"]
        .as_object()
        .ok_or_else(|| error("SOURCE_GAP_CONTEXT_INVALID", "SOURCE_GAP_CONTEXT_INVALID"))?;
    need(sets.len() <= 10000, "SOURCE_GAP_CONTEXT_LIMIT")?;
    let mut out = BTreeMap::new();
    for es in sets
        .values()
        .filter(|es| es.get("evidence_set_id").is_some() && es["snapshot"] == *snapshot)
    {
        for f in rows(&es["fragments"], 1024, "SOURCE_GAP_EVIDENCE_LIMIT")? {
            let id = s(&f["id"]);
            need(!id.is_empty(), "SOURCE_GAP_EVIDENCE_UNKNOWN")?;
            if let Some(old) = out.insert(id.to_owned(), f.clone()) {
                need(old == *f, "SOURCE_GAP_EVIDENCE_COLLISION")?;
            }
        }
    }
    Ok(out)
}
fn compose(artifact: &Value) -> Result<()> {
    let es = &artifact["evidenceSet"];
    lightog_demand::evidence_bridge::compose(&json!({"request":{"bridge_version":"lightog-evidence-bridge/0.1","evidence_set_id":es["evidence_set_id"],"snapshot":artifact["snapshot"],"source_fragments":es["fragments"],"legacy_claim_ids":[]},"context":artifact["context"],"legacy_claims":[]})).map_err(|e|error(e.code,e.code))?;
    need(
        es["snapshot"] == artifact["snapshot"],
        "SOURCE_GAP_SNAPSHOT_CHANGED",
    )
}
fn projection(artifact: &Value) -> Result<Value> {
    let mut out = Map::new();
    for key in [
        "source_id",
        "source_sha256",
        "snapshot",
        "evidenceSet",
        "context",
        "p2Build",
        "segment_evidence_set_refs",
        "all_proposal_candidates",
    ] {
        need(
            artifact.get(key).is_some(),
            "SOURCE_GAP_ARTIFACT_INCOMPLETE",
        )?;
        out.insert(key.to_owned(), artifact[key].clone());
    }
    Ok(Value::Object(out))
}
fn make_task(parent: &Value, artifact: &Value) -> Result<Value> {
    let parent_sha = hash(parent);
    let snapshot_sha = hash(&artifact["snapshot"]);
    let id =
        hash(&json!({"version":VERSION,"parent_sha256":parent_sha,"snapshot_sha256":snapshot_sha}));
    let mut semantics = Map::new();
    for key in [
        "kind",
        "description",
        "entities",
        "subject_local_id",
        "predicate",
        "object",
        "direction",
        "qualifiers",
        "conditions",
        "keywords",
    ] {
        semantics.insert(key.to_owned(), parent[key].clone());
    }
    let query=serde_json::to_string(&json!({"version":VERSION,"origin":"SOURCE_FACT","purpose":"RECHECK_UNVERIFIED_SOURCE_FACT_SUPPORT","source_id":artifact["source_id"],"source_sha256":artifact["source_sha256"],"parent_candidate_id":parent["candidate_id"],"parent_candidate_sha256":parent_sha,"source_fact":semantics,"neutral_instruction":NEUTRAL})).map_err(|_|error("SOURCE_GAP_QUERY_INVALID","SOURCE_GAP_QUERY_INVALID"))?;
    need(len(&query) <= 8000, "SOURCE_GAP_QUERY_BUDGET_EXCEEDED")?;
    let evidence: BTreeSet<_> = a(&parent["evidence_ids"])
        .iter()
        .cloned()
        .map(|v| s(&v).to_owned())
        .collect();
    Ok(
        json!({"version":VERSION,"task_id":format!("source_gap_{}",&id[..32]),"gap_id":format!("source_support_{}",&id[..32]),"kind":"SUPPORT_CLOSURE","origin":"SOURCE_FACT","status":"PLANNED_UNVERIFIED","description":NEUTRAL,"source_fact":parent,"source_fact_sha256":parent_sha,"candidate_ids":[parent["candidate_id"]],"candidate_bindings":[{"candidate_id":parent["candidate_id"],"candidate_sha256":parent_sha}],"source_evidence_ids":evidence,"selected_source_ids":[artifact["source_id"]],"source_id":artifact["source_id"],"source_sha256":artifact["source_sha256"],"snapshot":artifact["snapshot"],"snapshot_sha256":snapshot_sha,"conditions":parent["conditions"],"qualifiers":parent["qualifiers"],"direction":parent["direction"],"depends_on":[],"source_support_query":query,"source_support_query_sha256":sha(&json!(query)),"query_role":"UNVERIFIED_SOURCE_FACT_LOCATOR_NOT_QUESTION_SPEC","parent_policy":"IMMUTABLE_NOT_FACT_EVIDENCE_NOT_AUTOMATIC_PROMOTION","cq_coverage_proof":false,"semantic_support_certified":false,"execution_authorized":false,"publication_performed":false}),
    )
}
fn validate_task(task: &Value, artifact: &Value) -> Result<()> {
    compose(artifact)?;
    let all = candidates(&artifact["all_proposal_candidates"])?;
    let active = candidates(&artifact["p2Build"]["graph"]["candidate_archive"])?;
    let parent = all
        .get(s(&task["candidate_ids"][0]))
        .ok_or_else(|| error("SOURCE_GAP_PARENT_UNKNOWN", "SOURCE_GAP_PARENT_UNKNOWN"))?;
    need(
        !active.contains_key(s(&parent["candidate_id"])),
        "SOURCE_GAP_PARENT_ACTIVE",
    )?;
    crate::knowledge_build::build(
        &json!({"candidates":[parent],"snapshot":artifact["snapshot"],"trusted_context":artifact["context"]}),
    )?;
    need(
        *task == make_task(parent, artifact)?,
        "SOURCE_GAP_TASK_BINDING_CHANGED",
    )?;
    Ok(())
}
fn prepare(p: &Value) -> Result<Value> {
    shape(p, &["contract_version", "source", "artifact", "cq_seeds"])?;
    need(
        p["contract_version"] == VERSION,
        "SOURCE_GAP_VERSION_UNSUPPORTED",
    )?;
    let source = &p["source"];
    let original = &p["artifact"];
    let artifact = projection(original)?;
    need(
        !s(&source["id"]).is_empty()
            && source["content"].is_string()
            && source["sha256"] == sha(&source["content"])
            && artifact["source_id"] == source["id"]
            && artifact["source_sha256"] == source["sha256"],
        "SOURCE_GAP_SOURCE_CHANGED",
    )?;
    let snapshot = &artifact["snapshot"];
    let sources = rows(&snapshot["sources"], 1, "SOURCE_GAP_SOURCE_SCOPE_INVALID")?;
    need(sources.len() == 1, "SOURCE_GAP_SOURCE_SCOPE_INVALID")?;
    let row = &sources[0];
    need(
        row["source_ref"] == source["id"]
            && row["text_sha256"] == source["sha256"]
            && row["original_sha256"] == source["original_sha256"]
            && row["parser_version"] == source["parser_version"],
        "SOURCE_GAP_SOURCE_METADATA_CHANGED",
    )?;
    if let Some(revision) = source.get("source_revision").filter(|v| !v.is_null()) {
        need(
            *revision == row["source_revision"],
            "SOURCE_GAP_SOURCE_METADATA_CHANGED",
        )?;
    }
    let raw: Vec<_> = a(&artifact["context"]["source_texts"])
        .iter()
        .filter(|r| {
            r["source_ref"] == source["id"] && r["source_revision"] == row["source_revision"]
        })
        .collect();
    need(
        raw.len() == 1 && raw[0]["text"] == source["content"],
        "SOURCE_GAP_SOURCE_TEXT_CHANGED",
    )?;
    compose(&artifact)?;
    let seeds = rows(&p["cq_seeds"], 2, "SOURCE_GAP_CQ_HINTS_INVALID")?;
    let mut seed_ids = BTreeSet::new();
    let mut hints = vec![];
    for seed in seeds {
        shape(seed, &["seed_id", "text"])?;
        need(
            !s(&seed["seed_id"]).trim().is_empty()
                && len(s(&seed["seed_id"])) <= 160
                && seed_ids.insert(s(&seed["seed_id"]).to_owned())
                && !s(&seed["text"]).trim().is_empty()
                && len(s(&seed["text"])) <= 4096,
            "SOURCE_GAP_CQ_HINTS_INVALID",
        )?;
        hints.push(s(&seed["text"]));
    }
    let all = candidates(&artifact["all_proposal_candidates"])?;
    let active = candidates(&artifact["p2Build"]["graph"]["candidate_archive"])?;
    let known = fragments(&artifact["context"], snapshot)?;
    let mut seen = BTreeMap::new();
    let mut eligible = BTreeMap::new();
    let mut partial = BTreeMap::new();
    let mut receipts = vec![];
    let batches = rows(
        &original["semantic_batches"],
        32,
        "SOURCE_GAP_GATES_REQUIRED",
    )?;
    need(!batches.is_empty(), "SOURCE_GAP_GATES_REQUIRED")?;
    for batch in batches {
        let result = &batch["result"];
        let gate = &result["gate_input"];
        let replay = match s(&gate["contract_version"]) {
            crate::semantic_review::VERSION => crate::semantic_review::execute("apply", gate)?,
            crate::semantic_review_v2::VERSION => {
                crate::semantic_review_v2::execute("apply", gate)?
            }
            _ => {
                return Err(error(
                    "SOURCE_GAP_REVIEW_VERSION_UNSUPPORTED",
                    "SOURCE_GAP_REVIEW_VERSION_UNSUPPORTED",
                ))
            }
        };
        need(
            replay == result["gate_result"],
            "SOURCE_GAP_GATE_REPLAY_CHANGED",
        )?;
        need(
            gate["candidates"] == result["proposal_materialized"]["candidates"]
                && result["eligible_candidates"] == replay["eligible_candidates"],
            "SOURCE_GAP_BATCH_CHANGED",
        )?;
        need(
            gate["prepared"]["payload"]["snapshot"] == *snapshot,
            "SOURCE_GAP_BATCH_SNAPSHOT_CHANGED",
        )?;
        let local = fragments(&gate["trusted_context"], snapshot)?;
        for c in a(&gate["candidates"]) {
            let id = s(&c["candidate_id"]);
            need(
                seen.insert(id.to_owned(), c.clone()).is_none() && all.get(id) == Some(c),
                "SOURCE_GAP_PROPOSAL_HASH_CHANGED",
            )?;
            let refs = a(&c["evidence_ids"]).iter().map(s).chain(
                a(&c["entities"])
                    .iter()
                    .flat_map(|e| a(&e["mentions"]).iter().map(|m| s(&m["evidence_ref"]))),
            );
            for id in refs {
                need(
                    known.get(id).is_some() && known.get(id) == local.get(id),
                    "SOURCE_GAP_PARENT_EVIDENCE_CHANGED",
                )?;
            }
        }
        for c in a(&replay["eligible_candidates"]) {
            need(
                eligible
                    .insert(s(&c["candidate_id"]).to_owned(), c.clone())
                    .is_none(),
                "SOURCE_GAP_CANDIDATE_DUPLICATE",
            )?;
        }
        for q in a(&replay["quarantined"]) {
            let id = s(&q["candidate_id"]);
            let review = a(&gate["review_output"]["reviews"])
                .iter()
                .find(|r| r["candidate_id"] == id);
            let is_partial = review
                .and_then(|r| r["dimensions"].as_object())
                .is_some_and(|dims| dims.values().any(|d| d["decision"] == "PARTIAL"));
            if is_partial && !active.contains_key(id) {
                let c = all.get(id).ok_or_else(|| {
                    error("SOURCE_GAP_PARENT_UNKNOWN", "SOURCE_GAP_PARENT_UNKNOWN")
                })?;
                need(
                    q["candidate_sha256"] == hash(c),
                    "SOURCE_GAP_QUARANTINE_HASH_CHANGED",
                )?;
                partial.insert(id.to_owned(), c.clone());
            }
        }
        receipts.push(json!({"unit_id":batch["unit_id"],"gate_contract_version":gate["contract_version"],"gate_input_sha256":hash(gate),"gate_result_sha256":hash(&replay),"candidate_count":a(&gate["candidates"]).len(),"eligible_count":a(&replay["eligible_candidates"]).len(),"quarantined_count":a(&replay["quarantined"]).len()}));
    }
    need(seen == all, "SOURCE_GAP_PROPOSAL_ARCHIVE_INCOMPLETE")?;
    need(eligible == active, "SOURCE_GAP_ACTIVE_NOT_GATE_ELIGIBLE")?;
    need(
        a(&artifact["p2Build"]["graph"]["pattern_archive"]).is_empty(),
        "SOURCE_GAP_UNREVIEWED_PATTERNS_UNSUPPORTED",
    )?;
    let rebuilt = crate::knowledge_build::build(
        &json!({"candidates":artifact["p2Build"]["graph"]["candidate_archive"],"snapshot":snapshot,"trusted_context":artifact["context"]}),
    )?;
    need(
        rebuilt == artifact["p2Build"],
        "SOURCE_GAP_ACTIVE_BUILD_CHANGED",
    )?;
    for r in rows(
        &artifact["segment_evidence_set_refs"],
        128,
        "SOURCE_GAP_SEGMENT_REF_UNKNOWN",
    )? {
        need(
            artifact["context"]["examples"]
                .as_object()
                .is_some_and(|m| {
                    m.values()
                        .any(|es| es["evidence_set_id"] == *r && es["snapshot"] == *snapshot)
                }),
            "SOURCE_GAP_SEGMENT_REF_UNKNOWN",
        )?;
    }
    let selected = partial.first_key_value().map(|(_, c)| c);
    let task = selected.map(|c| make_task(c, &artifact)).transpose()?;
    if let Some(task) = &task {
        validate_task(task, &artifact)?;
    }
    Ok(
        json!({"version":VERSION,"status":if task.is_some(){"SOURCE_SUPPORT_GAP_READY"}else{"NO_GAP"},"task":task,"stop_reason":if selected.is_none(){json!("NO_QUARANTINED_PARTIAL_NONACTIVE_SOURCE_FACT")}else{Value::Null},"sourceArtifact":artifact,"cq_guidance":hints.join("\n"),"cq_seeds":seeds,"cq_role":"PRIORITY_HINT_ONLY_NO_FORMALIZATION_OR_COVERAGE_GATE","cq_coverage_proof":false,"semantic_support_certified":false,"new_api_calls":0,"publication_performed":false,"selection_receipt":{"version":VERSION,"selection_rule":"LEXICOGRAPHIC_CANDIDATE_ID_GATE_QUARANTINED_PARTIAL_NONACTIVE","baseline_artifact_sha256":hash(original),"source_artifact_sha256":hash(&artifact),"snapshot_sha256":hash(snapshot),"proposal_count":all.len(),"active_count":active.len(),"private_gate_replay":receipts,"eligible_gap_candidate_ids":partial.keys().collect::<Vec<_>>(),"selected_candidate_id":selected.map(|c|c["candidate_id"].clone()),"selected_candidate_sha256":selected.map(hash),"model_payload_policy":"DO_NOT_SEND_SELECTION_RECEIPT_OR_HISTORICAL_REVIEWS"}}),
    )
}
pub fn execute(op: &str, p: &Value) -> Result<Value> {
    need(
        serde_json::to_vec(p)
            .map_err(|_| error("SOURCE_GAP_INPUT_INVALID", "SOURCE_GAP_INPUT_INVALID"))?
            .len()
            <= 16 * 1024 * 1024,
        "SOURCE_GAP_RESOURCE_LIMIT",
    )?;
    match op {
        "prepare" => prepare(p),
        "validate" => {
            shape(p, &["contract_version", "task", "source_artifact"])?;
            need(
                p["contract_version"] == VERSION,
                "SOURCE_GAP_VERSION_UNSUPPORTED",
            )?;
            validate_task(&p["task"], &p["source_artifact"])?;
            Ok(
                json!({"version":VERSION,"validated":true,"task_sha256":hash(&p["task"]),"query_sha256":sha(&p["task"]["source_support_query"]),"selection_verified":false,"semantic_support_certified":false,"publication_performed":false}),
            )
        }
        _ => Err(error(
            "SOURCE_GAP_OPERATION_UNKNOWN",
            "SOURCE_GAP_OPERATION_UNKNOWN",
        )),
    }
}
