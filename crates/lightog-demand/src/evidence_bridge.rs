//! P1 pure compatibility boundary. The host supplies trusted lifecycle/publication
//! records; this module performs no model calls, database access or job dispatch.
//! Shared objects retain lightog-demand/0.1; the bridge envelope is versioned alone.
use crate::{
    context::{array, named, strings},
    need, wire, Error, Kernel, Result, ValidationContext,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;

pub const VERSION: &str = "lightog-evidence-bridge/0.1";
const MAX_ROWS: usize = 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ComposeRequest {
    bridge_version: String,
    evidence_set_id: String,
    snapshot: Value,
    source_fragments: Vec<Value>,
    legacy_claim_ids: Vec<String>,
}
fn shape(v: &Value, keys: &[&str], optional: &[&str]) -> Result<()> {
    let obj = v
        .as_object()
        .ok_or_else(|| Error::new("BRIDGE_INPUT_INVALID"))?;
    need(
        keys.iter().all(|k| obj.contains_key(*k))
            && obj
                .keys()
                .all(|k| keys.contains(&k.as_str()) || optional.contains(&k.as_str())),
        "BRIDGE_INPUT_INVALID",
    )
}
fn source_fragment(id: &str, anchor: &Value, snapshot: &Value, role: &str) -> Result<Value> {
    let source = array(&snapshot["sources"])
        .iter()
        .find(|s| {
            s["source_ref"] == anchor["source_ref"]
                && s["source_revision"] == anchor["source_revision"]
        })
        .ok_or_else(|| Error::new("SOURCE_REVISION_MISMATCH"))?;
    Ok(
        json!({"id":id,"origin":"SOURCE_FRAGMENT","source_ref":anchor["source_ref"],"source_revision":anchor["source_revision"],"block_ref":anchor["block_ref"],"text_sha256":source["text_sha256"],"span":anchor["span"],"claim_refs":[],"role":role}),
    )
}
fn legacy_anchor(legacy: &Value, snapshot: &Value, ctx: &ValidationContext) -> Result<Value> {
    let source = array(&snapshot["sources"])
        .iter()
        .find(|s| s["source_ref"] == legacy["source_id"])
        .ok_or_else(|| Error::new("SOURCE_REVISION_MISMATCH"))?;
    let key = (
        named(source, "source_ref")?,
        named(source, "source_revision")?,
    );
    let raw = ctx
        .sources
        .get(&key)
        .ok_or_else(|| Error::new("SOURCE_REVISION_MISMATCH"))?;
    if let Some(hash) = legacy.get("source_sha256") {
        need(hash == &source["text_sha256"], "EVIDENCE_HASH_MISMATCH")?;
    }
    for (field, code) in [
        ("original_sha256", "ORIGINAL_HASH_MISMATCH"),
        ("parser_version", "PARSER_VERSION_MISMATCH"),
        ("source_revision", "SOURCE_REVISION_MISMATCH"),
    ] {
        if let Some(value) = legacy.get(field) {
            need(value == &source[field], code)?;
        }
    }
    let span = json!({"start":legacy["start"],"end":legacy["end"],"quote":legacy["quote"],"offset_unit":"utf16_code_unit"});
    if let Some(unit) = legacy.get("offset_unit") {
        need(unit == "utf16_code_unit", "BRIDGE_OFFSET_UNIT_UNSUPPORTED")?;
    }
    wire::span_text(
        raw["text"]
            .as_str()
            .ok_or_else(|| Error::new("CONTEXT_INVALID"))?,
        &span,
    )?;
    let block_ref = ctx.block_for_span(&key.0, &key.1, &span)?;
    Ok(
        json!({"source_ref":source["source_ref"],"source_revision":source["source_revision"],"block_ref":block_ref,"span":span}),
    )
}

/// Compose existing EvidenceSet records, preserving complete legacy payloads in a
/// separate compatibility sidecar. The sidecar is not a new truth/claim format.
pub fn compose(payload: &Value) -> Result<Value> {
    shape(payload, &["request", "context", "legacy_claims"], &[])?;
    let request: ComposeRequest = serde_json::from_value(payload["request"].clone())
        .map_err(|_| Error::new("BRIDGE_INPUT_INVALID"))?;
    need(
        request.bridge_version == VERSION,
        "BRIDGE_VERSION_UNSUPPORTED",
    )?;
    need(
        request.source_fragments.len() <= MAX_ROWS && request.legacy_claim_ids.len() <= MAX_ROWS,
        "BRIDGE_RESOURCE_LIMIT",
    )?;
    let legacy = payload["legacy_claims"]
        .as_array()
        .ok_or_else(|| Error::new("BRIDGE_INPUT_INVALID"))?;
    need(legacy.len() <= MAX_ROWS, "BRIDGE_RESOURCE_LIMIT")?;
    let kernel = Kernel::new()?;
    let ctx = ValidationContext::from_value_v2(&payload["context"], &kernel)?;
    kernel.schema_check(&request.snapshot, "SourceSnapshot")?;
    ctx.snapshot_check(&request.snapshot)?;
    let mut seen = BTreeSet::new();
    for row in legacy {
        need(
            seen.insert(named(row, "id")?),
            "BRIDGE_DUPLICATE_LEGACY_CLAIM",
        )?;
    }
    let mut fragments = request.source_fragments.clone();
    for f in &fragments {
        kernel.schema_check(f, "EvidenceFragment")?;
        need(
            f["origin"] == "SOURCE_FRAGMENT" && array(&f["claim_refs"]).is_empty(),
            "EVIDENCE_ORIGIN_MISMATCH",
        )?;
    }
    let mut selected = BTreeSet::new();
    let mut claims = vec![];
    let mut mappings = vec![];
    for cid in &request.legacy_claim_ids {
        need(
            selected.insert(cid.clone()),
            "BRIDGE_DUPLICATE_LEGACY_CLAIM",
        )?;
        let claim = legacy
            .iter()
            .find(|c| c["id"] == cid.as_str())
            .ok_or_else(|| Error::new("BRIDGE_LEGACY_CLAIM_MISSING"))?;
        need(
            claim.is_object()
                && [
                    "subject_id",
                    "predicate_id",
                    "value",
                    "modality",
                    "comparator",
                    "unit",
                    "scope",
                    "effective_from",
                ]
                .iter()
                .all(|k| claim.get(k).is_some()),
            "BRIDGE_LEGACY_CLAIM_INVALID",
        )?;
        let anchor = legacy_anchor(claim, &request.snapshot, &ctx)?;
        // Publication status must come from service authority, never claim.status.
        let published = array(&ctx.authority["claims"]).iter().find(|c| {
            c["claim_ref"] == cid.as_str()
                && c["graph_revision"] == request.snapshot["graph_revision"]
                && c["status"] == "PUBLISHED"
                && ["source_ref", "source_revision", "block_ref", "span"]
                    .iter()
                    .all(|k| c[k] == anchor[k])
        });
        need(
            !request.snapshot["graph_revision"].is_null() && published.is_some(),
            "CLAIM_REF_UNRESOLVED",
        )?;
        // Trusted publication metadata must bind the complete stored payload,
        // not merely a reusable quote. Finite legacy decimals remain JSON values;
        // no demand canonicalization or model-generated digest is accepted here.
        need(
            published.and_then(|record| record.get("legacy_payload")) == Some(claim),
            "BRIDGE_LEGACY_PAYLOAD_MISMATCH",
        )?;
        let primary_id = format!(
            "eb_{}",
            &wire::sha(&json!([request.evidence_set_id, cid]))?[..32]
        );
        let mut primary = source_fragment(&primary_id, &anchor, &request.snapshot, "PRIMARY")?;
        primary["origin"] = json!("PUBLISHED_CLAIM");
        primary["claim_refs"] = json!([cid]);
        fragments.push(primary);
        let mut support_ids = vec![];
        if let Some(support) = claim.get("support_set") {
            let supports = support
                .as_array()
                .ok_or_else(|| Error::new("BRIDGE_LEGACY_CLAIM_INVALID"))?;
            need(supports.len() <= MAX_ROWS, "BRIDGE_RESOURCE_LIMIT")?;
            for (i, s) in supports.iter().enumerate() {
                let a = legacy_anchor(s, &request.snapshot, &ctx)?;
                let id = format!(
                    "es_{}",
                    &wire::sha(&json!([request.evidence_set_id, cid, i]))?[..32]
                );
                let role = if s["role"] == "CONDITION" {
                    "CONDITION"
                } else {
                    "CONTEXT"
                };
                fragments.push(source_fragment(&id, &a, &request.snapshot, role)?);
                support_ids.push(id);
            }
        }
        claims.push(claim.clone());
        mappings.push(json!({"claim_ref":cid,"primary_evidence_id":primary_id,"support_evidence_ids":support_ids}));
    }
    need(fragments.len() <= MAX_ROWS, "BRIDGE_RESOURCE_LIMIT")?;
    let es = json!({"contract_version":"lightog-demand/0.1","evidence_set_id":request.evidence_set_id,"snapshot":request.snapshot,"fragments":fragments});
    kernel.validate(&es, "EvidenceSet", &ctx)?;
    let mut graph = false;
    let mut document = false;
    for f in array(&es["fragments"]) {
        graph |= f["origin"] == "PUBLISHED_CLAIM";
        document |= f["origin"] == "SOURCE_FRAGMENT";
    }
    let basis = match (graph, document) {
        (true, true) => "MIXED",
        (true, false) => "GRAPH",
        (false, true) => "DOCUMENT",
        _ => "NONE",
    };
    Ok(
        json!({"bridge_version":VERSION,"evidence_set":es,"basis":basis,"legacy_claims":claims,"claim_evidence":mappings,"semantic_support":"NOT_CERTIFIED_BY_BRIDGE"}),
    )
}

/// Validate a proposed answer bundle using the existing shared validators. This
/// establishes references/coverage/access consistency, not textual entailment.
pub fn validate_answer_bundle(payload: &Value) -> Result<Value> {
    shape(
        payload,
        &[
            "context",
            "question_spec",
            "evidence_set",
            "coverage_report",
            "answer_result",
        ],
        &["learning_intent"],
    )?;
    let kernel = Kernel::new()?;
    let mut raw = payload["context"].clone();
    let examples = raw["examples"]
        .as_object_mut()
        .ok_or_else(|| Error::new("CONTEXT_INVALID"))?;
    for (field, definition) in [
        ("question_spec", "QuestionSpec"),
        ("evidence_set", "EvidenceSet"),
        ("coverage_report", "CoverageReport"),
        ("answer_result", "AnswerResult"),
        ("learning_intent", "LearningIntent"),
    ] {
        if let Some(v) = payload.get(field) {
            kernel.schema_check(v, definition)?;
            if !examples.values().any(|old| old == v) {
                let key = format!("bridge_{field}");
                need(!examples.contains_key(&key), "CONTEXT_DUPLICATE_ID")?;
                examples.insert(key, v.clone());
            }
        }
    }
    let ctx = ValidationContext::from_value_v2(&raw, &kernel)?;
    for (field, definition) in [
        ("question_spec", "QuestionSpec"),
        ("evidence_set", "EvidenceSet"),
        ("coverage_report", "CoverageReport"),
        ("answer_result", "AnswerResult"),
        ("learning_intent", "LearningIntent"),
    ] {
        if let Some(v) = payload.get(field) {
            kernel.validate(v, definition, &ctx)?;
        }
    }
    let answer = &payload["answer_result"];
    ctx.request_snapshot_check(
        &answer["request_ref"],
        &answer["question_spec_sha256"],
        &answer["snapshot"],
    )?;
    if let Some(learning) = payload.get("learning_intent") {
        ctx.request_snapshot_check(
            &learning["request_ref"],
            &learning["question_spec_sha256"],
            &learning["snapshot"],
        )?;
    }
    need(
        answer["learning_state"]["status"] == "NOT_REQUESTED"
            || payload.get("learning_intent").is_some(),
        "BRIDGE_LEARNING_INTENT_MISSING",
    )?;
    let coverage = &payload["coverage_report"];
    let es = &payload["evidence_set"];
    let q = &payload["question_spec"];
    need(
        answer["question_id"] == q["question_id"]
            && coverage["question_id"] == q["question_id"]
            && answer["coverage_report_ref"] == coverage["coverage_report_id"]
            && answer["evidence_set_ref"] == es["evidence_set_id"]
            && coverage["evidence_set_ref"] == es["evidence_set_id"]
            && answer["snapshot"] == coverage["snapshot"],
        "BRIDGE_BUNDLE_REFERENCE_MISMATCH",
    )?;
    // Coverage receipts and the final prose must refer to the same evidence
    // for each atomic requirement; global EvidenceSet membership is not enough.
    for statement in array(&answer["statements"]) {
        let used = strings(&statement["evidence_ids"]);
        let requirements = strings(&statement["requirement_ids"]);
        let mut allowed = BTreeSet::new();
        for requirement in &requirements {
            let row = array(&coverage["requirements"])
                .iter()
                .find(|r| r["requirement_id"] == requirement.as_str())
                .ok_or_else(|| Error::new("BRIDGE_STATEMENT_COVERAGE_MISMATCH"))?;
            let evidence = strings(&row["evidence_ids"]);
            need(
                !used.is_disjoint(&evidence),
                "BRIDGE_STATEMENT_COVERAGE_MISMATCH",
            )?;
            allowed.extend(evidence);
        }
        need(
            used.is_subset(&allowed),
            "BRIDGE_STATEMENT_COVERAGE_MISMATCH",
        )?;
    }
    if let Some(learning) = payload.get("learning_intent") {
        need(
            learning["question_id"] == answer["question_id"]
                && learning["request_ref"] == answer["request_ref"]
                && learning["snapshot"] == answer["snapshot"]
                && learning["status"] == answer["learning_state"]["status"]
                && learning["task_ref"] == answer["learning_state"]["task_ref"],
            "BRIDGE_LEARNING_STATE_MISMATCH",
        )?;
    }
    if answer["learning_state"]["status"] != "NOT_REQUESTED" {
        let snapshot_hash = wire::sha(&answer["snapshot"])?;
        let task = array(&ctx.authority["learning_tasks"]).iter().find(|task| {
            task["task_ref"] == answer["learning_state"]["task_ref"]
                && task["request_ref"] == answer["request_ref"]
                && task["question_spec_sha256"] == answer["question_spec_sha256"]
                && task["snapshot_sha256"] == snapshot_hash
                && task["status"] == answer["learning_state"]["status"]
        });
        need(task.is_some(), "BRIDGE_LEARNING_TASK_UNVERIFIED")?;
        if answer["learning_state"]["status"] == "PUBLISHED" {
            let task = task.unwrap();
            let graph = task["output_graph_revision"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| Error::new("BRIDGE_LEARNING_COMMIT_UNVERIFIED"))?;
            let commit = array(&ctx.authority["learning_commits"]).iter().any(|c| {
                c["task_ref"] == task["task_ref"]
                    && c["request_ref"] == task["request_ref"]
                    && c["question_spec_sha256"] == task["question_spec_sha256"]
                    && c["input_snapshot_sha256"] == snapshot_hash
                    && c["output_graph_revision"] == graph
                    && c["status"] == "COMMITTED"
                    && c["commit_ref"].as_str().is_some_and(|s| !s.is_empty())
            });
            let published_snapshot = array(&ctx.authority["allowed_snapshots"]).iter().any(|s| {
                s["base_ref"] == answer["snapshot"]["base_ref"]
                    && s["source_epoch"] == answer["snapshot"]["source_epoch"]
                    && s["sources"] == answer["snapshot"]["sources"]
                    && s["graph_revision"] == graph
            });
            need(
                commit && published_snapshot,
                "BRIDGE_LEARNING_COMMIT_UNVERIFIED",
            )?;
        }
    }
    Ok(
        json!({"bridge_version":VERSION,"validated":true,"basis":answer["basis"],"answer_status":answer["answer_status"],"learning_state":answer["learning_state"],"semantic_support":"NOT_CERTIFIED_BY_BRIDGE"}),
    )
}

pub fn execute(operation: &str, payload: &Value) -> Result<Value> {
    need(
        serde_json::to_vec(payload)
            .map_err(|_| Error::new("BRIDGE_INPUT_INVALID"))?
            .len()
            <= wire::MAX_INPUT_BYTES,
        "BRIDGE_RESOURCE_LIMIT",
    )?;
    match operation {
        "compose" => compose(payload),
        "validate_answer_bundle" => validate_answer_bundle(payload),
        _ => Err(Error::new("BRIDGE_OPERATION_UNKNOWN")),
    }
}
