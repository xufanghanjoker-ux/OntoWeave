//! Independently authored output documents, checked by the JSON Schema validator.
//! These tests say nothing about the truth of an LLM's semantic judgments.
use lightog_core::semantic_review_v4::{narrative_output_schema, structure_output_schema};
use serde_json::{json, Value};

const DIMS: [&str; 9] = ["subject", "predicate_object", "direction", "negation", "conditions", "scope", "time_modality", "units", "evidence_entailment"];
const FIELDS: [&str; 9] = ["kind", "entities", "subject_local_id", "predicate", "object", "direction", "qualifiers", "conditions", "evidence_ids"];
fn readback(narrative: bool) -> Value {
    let fields: serde_json::Map<String, Value> = FIELDS.into_iter().map(|k| (k.into(), json!("a".repeat(64)))).collect();
    let mut v = json!({"structured_candidate_sha256":"b".repeat(64),"structure_field_sha256":fields});
    if narrative { v["description_sha256"] = json!("c".repeat(64)); }
    v
}
fn judgment(decision: &str, refs: Value) -> Value {
    json!({"decision":decision,"reason":"Independent authored schema control, not semantic evidence.","evidence_ids":refs})
}
fn structure() -> Value {
    let dimensions: serde_json::Map<String, Value> = DIMS.into_iter().map(|d| (d.into(), judgment(if d == "units" {"NOT_APPLICABLE"} else {"SUPPORTED"}, json!(["selected"])))) .collect();
    json!({"reviews":[{"candidate_id":"original_candidate","decision":"SUPPORTED","dimensions":dimensions,"readback":readback(false)}]})
}
fn narrative() -> Value {
    json!({"reviews":[{"candidate_id":"original_candidate","decision":"SUPPORTED","readback":readback(true),"description_support":judgment("SUPPORTED",json!(["selected"])),"condition_exception_fidelity":judgment("SUPPORTED",json!(["selected"])),"structure_description_consistency":judgment("CONSISTENT",json!(["selected"]))}]})
}

#[test]
fn independent_a_positive_each_dimension_requires_a_reference_but_negative_diagnostics_can_be_empty() {
    let schema = structure_output_schema();
    let validator = jsonschema::validator_for(&schema).expect("valid exported A schema");
    assert!(validator.is_valid(&structure()));
    for dim in DIMS {
        for decision in ["SUPPORTED", "PARTIAL", "UNSUPPORTED", "UNKNOWN"] {
            let mut v = structure();
            v["reviews"][0]["dimensions"][dim] = judgment(decision, json!([]));
            assert_eq!(validator.is_valid(&v), decision != "SUPPORTED", "{dim} {decision}");
            v["reviews"][0]["dimensions"][dim]["evidence_ids"] = json!(["selected"]);
            assert!(validator.is_valid(&v), "nonempty {dim} {decision}");
        }
        let mut v = structure();
        v["reviews"][0]["dimensions"][dim] = judgment("NOT_APPLICABLE", json!([]));
        assert!(!validator.is_valid(&v), "empty NA {dim}");
        v["reviews"][0]["dimensions"][dim]["evidence_ids"] = json!(["selected"]);
        assert_eq!(validator.is_valid(&v), dim == "units", "NA is not a shortcut for {dim}");
    }
}

#[test]
fn independent_b_supported_and_consistent_require_refs_but_partial_unknown_conflict_do_not() {
    let schema = narrative_output_schema();
    let validator = jsonschema::validator_for(&schema).expect("valid exported B schema");
    assert!(validator.is_valid(&narrative()));
    for field in ["description_support", "condition_exception_fidelity", "structure_description_consistency"] {
        let consistency = field == "structure_description_consistency";
        let decisions = if consistency {vec!["CONSISTENT", "CONFLICT", "PARTIAL", "UNKNOWN"]} else {vec!["SUPPORTED", "UNSUPPORTED", "PARTIAL", "UNKNOWN"]};
        for decision in decisions {
            let mut v = narrative();
            v["reviews"][0][field] = judgment(decision, json!([]));
            assert_eq!(validator.is_valid(&v), !["SUPPORTED", "CONSISTENT"].contains(&decision), "{field} {decision}");
            v["reviews"][0][field]["evidence_ids"] = json!(["selected"]);
            assert!(validator.is_valid(&v));
        }
        let mut v = narrative();
        v["reviews"][0][field] = judgment("NOT_APPLICABLE", json!(["selected"]));
        assert!(!validator.is_valid(&v), "B has no NA shortcut: {field}");
    }
}
