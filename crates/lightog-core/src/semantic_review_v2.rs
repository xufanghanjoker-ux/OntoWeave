//! Versioned explicit-role semantic review gate. units NOT_APPLICABLE is retained
//! as a distinct model judgment, never translated into SUPPORTED.
//! Evidence-bound semantic review gate. Model judgments remain judgments, never
//! publication authority. This kernel checks bindings and applies decisions; it
//! does not infer entailment, repair semantics, or authenticate a remote caller.
use crate::common::{a, canonical_hash, error, s, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const VERSION: &str = "lightog-semantic-review/0.2";
pub const DIMENSIONS: [&str; 9] = [
    "subject",
    "predicate_object",
    "direction",
    "negation",
    "conditions",
    "scope",
    "time_modality",
    "units",
    "evidence_entailment",
];
fn need(ok: bool, code: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(error(code, code))
    }
}
fn shape(v: &Value, required: &[&str], optional: &[&str]) -> Result<()> {
    let m = v
        .as_object()
        .ok_or_else(|| error("REVIEW_SHAPE_INVALID", "REVIEW_SHAPE_INVALID"))?;
    need(
        required.iter().all(|k| m.contains_key(*k))
            && m.keys()
                .all(|k| required.contains(&k.as_str()) || optional.contains(&k.as_str())),
        "REVIEW_SHAPE_INVALID",
    )
}
fn ids(v: &Value, nonempty: bool) -> Result<BTreeSet<String>> {
    let rows = v
        .as_array()
        .ok_or_else(|| error("REVIEW_EVIDENCE_INVALID", "REVIEW_EVIDENCE_INVALID"))?;
    need(
        rows.len() <= 10000 && (!nonempty || !rows.is_empty()),
        "REVIEW_EVIDENCE_INVALID",
    )?;
    let mut set = BTreeSet::new();
    for id in rows {
        need(
            id.as_str().is_some_and(|s| !s.is_empty()) && set.insert(s(id).to_owned()),
            "REVIEW_EVIDENCE_INVALID",
        )?;
    }
    Ok(set)
}
fn proposal_shape(p: &Value, apply: bool) -> Result<()> {
    let required = [
        "contract_version",
        "candidates",
        "prepared",
        "trusted_context",
        "receipts",
        "context_evidence_ids",
        "max_context_utf16",
    ];
    if apply {
        shape(
            p,
            &[
                required.as_slice(),
                &["manifest", "review_output", "review_provenance"],
            ]
            .concat(),
            &[],
        )
    } else {
        shape(p, &required, &[])
    }
}
pub fn prepare(p: &Value) -> Result<Value> {
    need(
        p["contract_version"] == VERSION,
        "REVIEW_VERSION_UNSUPPORTED",
    )?;
    let candidates = p["candidates"]
        .as_array()
        .ok_or_else(|| error("REVIEW_SHAPE_INVALID", "REVIEW_SHAPE_INVALID"))?;
    need(
        !candidates.is_empty() && candidates.len() <= 64,
        "REVIEW_BATCH_LIMIT",
    )?;
    let receipts = p["receipts"]
        .as_array()
        .ok_or_else(|| error("REVIEW_SHAPE_INVALID", "REVIEW_SHAPE_INVALID"))?;
    need(receipts.len() <= 256, "REVIEW_BATCH_LIMIT")?;
    let budget = p["max_context_utf16"]
        .as_u64()
        .filter(|n| (1..=24000).contains(n))
        .ok_or_else(|| error("REVIEW_CONTEXT_LIMIT", "REVIEW_CONTEXT_LIMIT"))?;
    let raw_prepared = &p["prepared"];
    let expected = crate::knowledge_build::prepare_extract(
        &json!({"evidence_set_ref":raw_prepared["payload"]["evidence_set_ref"],"cq_guidance":raw_prepared["payload"]["cq_guidance"],"trusted_context":p["trusted_context"]}),
    )?;
    need(*raw_prepared == expected, "REVIEW_PREPARED_MISMATCH")?;
    let es_ref = s(&expected["payload"]["evidence_set_ref"]);
    let snapshot = &expected["payload"]["snapshot"];
    let payload_hash = canonical_hash(&expected["payload"]);
    let menu: BTreeMap<_, _> = a(&expected["payload"]["evidence_menu"])
        .iter()
        .map(|f| (s(&f["evidence_id"]).to_owned(), f.clone()))
        .collect();
    need(
        menu.len() == a(&expected["payload"]["evidence_menu"]).len(),
        "REVIEW_MENU_AMBIGUOUS",
    )?;
    let mut candidate_ids = BTreeSet::new();
    let mut bindings = vec![];
    let mut support_version: Option<String> = None;
    let mut proposal_contract: Option<Value> = None;
    let mut selected = ids(&p["context_evidence_ids"], false)?;
    need(
        selected.iter().all(|id| menu.contains_key(id)),
        "REVIEW_CONTEXT_EVIDENCE_UNKNOWN",
    )?;
    for c in candidates {
        need(
            candidate_ids.insert(s(&c["candidate_id"]).to_owned()),
            "REVIEW_CANDIDATE_DUPLICATE",
        )?;
        need(
            c["snapshot"] == *snapshot && c["evidence_set_ref"] == es_ref,
            "REVIEW_SNAPSHOT_OR_SET_MISMATCH",
        )?;
        // Revalidate actual source/identity/semantic shape rather than trusting a receipt.
        crate::knowledge_build::build(
            &json!({"candidates":[c],"snapshot":snapshot,"trusted_context":p["trusted_context"]}),
        )?;
        let matched: Vec<_> = receipts
            .iter()
            .filter(|r| r["candidate_id"] == c["candidate_id"])
            .collect();
        need(matched.len() == 1, "REVIEW_PROPOSAL_RECEIPT_AMBIGUOUS")?;
        let r = matched[0];
        crate::support_selection::validate_receipt(c, r, &expected)?;
        if let Some(version) = &support_version {
            need(
                version == s(&r["support_selection_version"]),
                "REVIEW_SUPPORT_VERSION_MIXED",
            )?;
        } else {
            support_version = Some(s(&r["support_selection_version"]).to_owned());
        }
        if let Some(version) = &proposal_contract {
            need(
                *version == r["proposal_contract_version"],
                "REVIEW_PROPOSAL_CONTRACT_MIXED",
            )?;
        } else {
            proposal_contract = Some(r["proposal_contract_version"].clone());
        }
        let candidate_hash = canonical_hash(c);
        need(
            r["status"] == "VALIDATED_CANDIDATE"
                && r["validator"] == "RUST_P2_BUILD"
                && r["candidate_sha256"] == candidate_hash
                && r["prepared_payload_sha256"] == payload_hash,
            "REVIEW_PROPOSAL_RECEIPT_MISMATCH",
        )?;
        let support = ids(&r["fact_support_evidence_ids"], true)?;
        let anchors = ids(&r["registry_anchor_evidence_ids"], true)?;
        let actual_anchors: BTreeSet<String> = a(&c["entities"])
            .iter()
            .flat_map(|e| {
                a(&e["mentions"])
                    .iter()
                    .map(|m| s(&m["evidence_ref"]).to_owned())
            })
            .collect();
        let all = ids(&c["evidence_ids"], true)?;
        need(
            anchors == actual_anchors
                && support.union(&anchors).cloned().collect::<BTreeSet<_>>() == all
                && all.iter().all(|id| menu.contains_key(id)),
            "REVIEW_SUPPORT_ROLE_MISMATCH",
        )?;
        if !c["predicate"].is_null() && c["predicate"]["predicate_ref"].is_null() {
            need(
                ids(&c["predicate"]["proposed_definition"]["evidence_ids"], true)?
                    .is_subset(&support),
                "REVIEW_PREDICATE_SUPPORT_MISMATCH",
            )?;
        }
        for condition in a(&c["conditions"]) {
            need(
                ids(&condition["evidence_ids"], true)?.is_subset(&support),
                "REVIEW_CONDITION_SUPPORT_MISMATCH",
            )?;
        }
        selected.extend(all);
        bindings.push(json!({"candidate_id":c["candidate_id"],"candidate_sha256":candidate_hash,"proposal_receipt_sha256":canonical_hash(r),"evidence_set_ref":es_ref,"fact_support_evidence_ids":support,"registry_anchor_evidence_ids":anchors,"support_roles":r["support_roles"],"support_roles_sha256":r["support_roles_sha256"]}));
    }
    let review_menu: Vec<_> = selected
        .iter()
        .map(|id| {
            let mut f = menu[id].clone();
            f["evidence_set_ref"] = json!(es_ref);
            f
        })
        .collect();
    let count: usize = review_menu
        .iter()
        .map(|f| s(&f["span"]["quote"]).encode_utf16().count())
        .sum();
    need(count <= budget as usize, "REVIEW_CONTEXT_LIMIT")?;
    let mut manifest = json!({"contract_version":VERSION,"snapshot_sha256":canonical_hash(snapshot),"prepared_payload_sha256":payload_hash,"trusted_context_sha256":canonical_hash(&p["trusted_context"]),"review_menu_sha256":canonical_hash(&json!(review_menu)),"candidates":bindings,"dimensions":DIMENSIONS,"max_context_utf16":budget,"context_utf16":count,"rubric_version":"explicit-support-applicability/2","support_selection_version":support_version.as_deref().unwrap_or(crate::support_selection::VERSION),"not_applicable_allowed_dimensions":["units"],"not_applicable_policy":"EXPLICIT_MODEL_JUDGMENT_RETAINED_WITH_SOURCE_CITATIONS_NO_SEMANTIC_CERTIFICATE","review_output_schema_sha256":canonical_hash(&output_schema()),"candidate_schema_sha256":canonical_hash(&expected["candidate_schema"])});
    if let Some(version) = proposal_contract.filter(|v| !v.is_null()) {
        manifest["proposal_contract_version"] = version;
    }
    let hash = canonical_hash(&manifest);
    manifest["batch_sha256"] = json!(hash);
    manifest["batch_id"] = json!(format!("sr_{}", &hash[..24]));
    Ok(
        json!({"contract_version":VERSION,"manifest":manifest,"review_menu":review_menu,"candidates":candidates,"model_called":false,"publication_performed":false,"semantic_support_certified":false,"review_output_schema":output_schema()}),
    )
}
#[derive(Serialize, Deserialize, PartialEq, Clone)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum Decision {
    Supported,
    Partial,
    Unsupported,
    Unknown,
    NotApplicable,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Dimension {
    decision: Decision,
    reason: String,
    evidence_ids: Vec<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Review {
    candidate_id: String,
    decision: Decision,
    dimensions: BTreeMap<String, Dimension>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReviewOutput {
    reviews: Vec<Review>,
}
fn apply(p: &Value) -> Result<Value> {
    let checked = prepare(p)?;
    need(
        p["manifest"] == checked["manifest"],
        "REVIEW_MANIFEST_MISMATCH",
    )?;
    let raw = &p["review_output"];
    let output: ReviewOutput = serde_json::from_value(raw.clone())
        .map_err(|_| error("REVIEW_OUTPUT_INVALID", "REVIEW_OUTPUT_INVALID"))?;
    let provenance = &p["review_provenance"];
    shape(
        provenance,
        &[
            "origin",
            "review_request_id",
            "proposal_request_ids",
            "review_output_sha256",
            "model",
            "config_revision",
        ],
        &[],
    )?;
    need(
        ["FRESH_MODEL", "ARCHIVED_MODEL", "SYNTHETIC"].contains(&s(&provenance["origin"]))
            && provenance["review_request_id"]
                .as_str()
                .is_some_and(|x| !x.is_empty())
            && provenance["model"].as_str().is_some_and(|x| !x.is_empty())
            && provenance["config_revision"]
                .as_u64()
                .is_some_and(|n| n > 0),
        "REVIEW_PROVENANCE_INVALID",
    )?;
    let proposal_ids = ids(&provenance["proposal_request_ids"], true)?;
    need(
        !proposal_ids.contains(s(&provenance["review_request_id"])),
        "REVIEW_NOT_INDEPENDENT_CONTEXT",
    )?;
    let output_hash = canonical_hash(raw);
    need(
        provenance["review_output_sha256"] == output_hash,
        "REVIEW_OUTPUT_BINDING_MISMATCH",
    )?;
    let candidates = a(&p["candidates"]);
    let by_id: BTreeMap<_, _> = candidates
        .iter()
        .map(|c| (s(&c["candidate_id"]), c))
        .collect();
    need(
        output.reviews.len() == candidates.len(),
        "REVIEW_CANDIDATE_COVERAGE_MISMATCH",
    )?;
    let menu_ids: BTreeSet<_> = a(&checked["review_menu"])
        .iter()
        .map(|f| s(&f["evidence_id"]).to_owned())
        .collect();
    let mut seen = BTreeSet::new();
    let mut eligible = vec![];
    let mut quarantined = vec![];
    let mut reviews = vec![];
    for review in output.reviews {
        need(
            by_id.contains_key(review.candidate_id.as_str())
                && seen.insert(review.candidate_id.clone()),
            "REVIEW_CANDIDATE_COVERAGE_MISMATCH",
        )?;
        need(
            review.dimensions.len() == DIMENSIONS.len()
                && DIMENSIONS
                    .iter()
                    .all(|d| review.dimensions.contains_key(*d)),
            "REVIEW_DIMENSION_COVERAGE_MISMATCH",
        )?;
        need(
            review.decision != Decision::NotApplicable,
            "REVIEW_TOP_LEVEL_NOT_APPLICABLE_INVALID",
        )?;
        let binding = a(&checked["manifest"]["candidates"])
            .iter()
            .find(|c| c["candidate_id"] == review.candidate_id)
            .unwrap();
        let support = ids(&binding["fact_support_evidence_ids"], true)?;
        let candidate = by_id[review.candidate_id.as_str()];

        let mut reasons = vec![];
        if review.decision != Decision::Supported {
            reasons.push("TOP_LEVEL_NOT_SUPPORTED".to_owned());
        }
        for (name, dim) in &review.dimensions {
            need(
                !dim.reason.trim().is_empty() && dim.reason.encode_utf16().count() <= 4000,
                "REVIEW_REASON_INVALID",
            )?;
            let cited = ids(&json!(dim.evidence_ids), false)?;
            need(cited.is_subset(&menu_ids), "REVIEW_OUTPUT_EVIDENCE_UNKNOWN")?;
            if dim.decision == Decision::NotApplicable {
                need(name == "units", "REVIEW_NOT_APPLICABLE_DIMENSION_INVALID")?;
                // Positive structured unit metadata vetoes N/A. Absence is only a
                // mechanical guard; the independent model remains responsible for meaning.
                if !candidate["qualifiers"]["unit"].is_null()
                    || !candidate["object"]["typed_value"]["unit"].is_null()
                    || !candidate["object"]["typed_value"]["units"].is_null()
                {
                    reasons.push("NOT_APPLICABLE_CONFLICTS_WITH_DECLARED_UNIT".to_owned());
                }
                if cited.is_disjoint(&support) {
                    reasons.push(format!("NO_FACT_SUPPORT:{name}"));
                } else if !cited.is_subset(&support) {
                    reasons.push(format!("NEEDS_SUPPORT_EXPANSION:{name}"));
                }
            } else if dim.decision != Decision::Supported {
                reasons.push(format!("DIMENSION_NOT_SUPPORTED:{name}"));
            } else if cited.is_disjoint(&support) {
                reasons.push(format!("NO_FACT_SUPPORT:{name}"));
            } else if !cited.is_subset(&support) {
                reasons.push(format!("NEEDS_SUPPORT_EXPANSION:{name}"));
            }
        }
        let accepted = reasons.is_empty();
        let mut decision = serde_json::to_value(&review)
            .map_err(|_| error("REVIEW_OUTPUT_INVALID", "REVIEW_OUTPUT_INVALID"))?;
        decision["candidate_sha256"] = binding["candidate_sha256"].clone();
        decision["gate_status"] = json!(if accepted {
            "REVIEW_ELIGIBLE_CANDIDATE"
        } else {
            "QUARANTINED"
        });
        decision["gate_reasons"] = json!(reasons);
        if accepted {
            eligible.push(candidate.clone());
        } else {
            quarantined.push(json!({"candidate_id":review.candidate_id,"candidate_sha256":binding["candidate_sha256"],"reasons":reasons}));
        }
        reviews.push(decision);
    }
    need(
        seen.len() == by_id.len(),
        "REVIEW_CANDIDATE_COVERAGE_MISMATCH",
    )?;
    let graph = crate::knowledge_build::build(
        &json!({"candidates":eligible,"snapshot":p["prepared"]["payload"]["snapshot"],"trusted_context":p["trusted_context"]}),
    )?;
    let receipt = json!({"contract_version":VERSION,"manifest":checked["manifest"],"review_output_sha256":output_hash,"review_provenance":provenance,"reviews":reviews,"eligible_candidate_ids":eligible.iter().map(|c|c["candidate_id"].clone()).collect::<Vec<_>>(),"candidate_archive_sha256":canonical_hash(&graph["graph"]["candidate_archive"]),"semantic_support_certified":false,"publication_performed":false});
    Ok(
        json!({"contract_version":VERSION,"manifest":checked["manifest"],"eligible_candidates":eligible,"quarantined":quarantined,"all_proposal_candidates":p["candidates"],"review_receipt":receipt,"reviewed_build":graph,"review_origin":provenance["origin"],"semantic_support_certified":false,"publication_performed":false}),
    )
}
pub fn output_schema() -> Value {
    let mut dims = serde_json::Map::new();
    for name in DIMENSIONS {
        let decisions = if name == "units" {
            json!([
                "SUPPORTED",
                "PARTIAL",
                "UNSUPPORTED",
                "UNKNOWN",
                "NOT_APPLICABLE"
            ])
        } else {
            json!(["SUPPORTED", "PARTIAL", "UNSUPPORTED", "UNKNOWN"])
        };
        dims.insert(name.into(),json!({"type":"object","additionalProperties":false,"required":["decision","reason","evidence_ids"],"properties":{"decision":{"type":"string","enum":decisions},"reason":{"type":"string","minLength":1,"maxLength":4000},"evidence_ids":{"type":"array","items":{"type":"string"},"uniqueItems":true,"maxItems":128}},"allOf":[{"if":{"properties":{"decision":{"enum":["SUPPORTED","NOT_APPLICABLE"]}},"required":["decision"]},"then":{"properties":{"evidence_ids":{"minItems":1}}}}]}));
    }
    json!({"type":"object","additionalProperties":false,"required":["reviews"],"properties":{"reviews":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["candidate_id","decision","dimensions"],"properties":{"candidate_id":{"type":"string"},"decision":{"type":"string","enum":["SUPPORTED","PARTIAL","UNSUPPORTED","UNKNOWN"]},"dimensions":{"type":"object","additionalProperties":false,"required":DIMENSIONS,"properties":dims}}}}}})
}
pub fn execute(op: &str, p: &Value) -> Result<Value> {
    need(
        serde_json::to_vec(p)
            .map_err(|_| error("REVIEW_SHAPE_INVALID", "REVIEW_SHAPE_INVALID"))?
            .len()
            <= 8 * 1024 * 1024,
        "REVIEW_RESOURCE_LIMIT",
    )?;
    match op {
        "prepare" => {
            proposal_shape(p, false)?;
            prepare(p)
        }
        "apply" => {
            proposal_shape(p, true)?;
            apply(p)
        }
        _ => Err(error(
            "REVIEW_OPERATION_UNKNOWN",
            "REVIEW_OPERATION_UNKNOWN",
        )),
    }
}
