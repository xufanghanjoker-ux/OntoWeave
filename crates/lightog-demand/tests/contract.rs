//! Focused type/schema/registry checks against the frozen contract fixtures.
//! No model calls, product service, network access, or new fixture generation.

use lightog_demand::{types, Kernel, ValidationContext};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

const SEED: &str = include_str!("../../../contracts/demand-v0.1/examples/seed.json");
const AUTHORITY: &str =
    include_str!("../../../fixtures/demand-contract-v0.1/validation-context.json");

fn assert_roundtrip<T: Serialize + DeserializeOwned>(raw: &str) {
    let fixture: Value = serde_json::from_str(raw).unwrap();
    let typed: T = serde_json::from_value(fixture.clone()).unwrap();
    let serialized = serde_json::to_value(&typed).unwrap();
    assert_eq!(
        serialized, fixture,
        "typed serialization must preserve every field and explicit null"
    );
    let reparsed: T = serde_json::from_value(serialized.clone()).unwrap();
    assert_eq!(serde_json::to_value(reparsed).unwrap(), serialized);
}

#[test]
fn question_spec_serde_roundtrip() {
    assert_roundtrip::<types::QuestionSpec>(SEED);
}

#[test]
fn cq_family_serde_roundtrip() {
    assert_roundtrip::<types::CQFamily>(include_str!(
        "../../../contracts/demand-v0.1/examples/cq-family.json"
    ));
}

#[test]
fn evidence_set_serde_roundtrip() {
    assert_roundtrip::<types::EvidenceSet>(include_str!(
        "../../../contracts/demand-v0.1/examples/evidence-set.json"
    ));
}

#[test]
fn coverage_report_serde_roundtrip() {
    assert_roundtrip::<types::CoverageReport>(include_str!(
        "../../../contracts/demand-v0.1/examples/source-answer-coverage.json"
    ));
}

#[test]
fn learning_intent_serde_roundtrip() {
    assert_roundtrip::<types::LearningIntent>(include_str!(
        "../../../contracts/demand-v0.1/examples/background-learning.json"
    ));
}

#[test]
fn answer_result_serde_roundtrip() {
    assert_roundtrip::<types::AnswerResult>(include_str!(
        "../../../contracts/demand-v0.1/examples/source-answer.json"
    ));
}

#[test]
fn demand_envelope_serde_roundtrip() {
    assert_roundtrip::<types::DemandEnvelope>(include_str!(
        "../../../contracts/demand-v0.1/examples/request-envelope.json"
    ));
}

#[test]
fn schema_rejects_a_missing_required_nullable_field() {
    let kernel = Kernel::new().unwrap();
    let mut fixture: Value = serde_json::from_str(SEED).unwrap();
    assert!(fixture["requirements"][0]["target"]["predicate_ref"].is_null());
    kernel.schema_check(&fixture, "QuestionSpec").unwrap();
    let removed = fixture["requirements"][0]["target"]
        .as_object_mut()
        .unwrap()
        .remove("predicate_ref");
    assert_eq!(removed, Some(Value::Null));

    // This boundary is why public Kernel validation checks raw JSON first:
    // an Option alone cannot distinguish a missing key from explicit null.
    assert!(serde_json::from_value::<types::QuestionSpec>(fixture.clone()).is_ok());
    let error = kernel.schema_check(&fixture, "QuestionSpec").unwrap_err();
    assert_eq!(error.code, "SCHEMA_INVALID");
}

#[test]
fn context_registry_rejects_conflicting_question_ids() {
    let kernel = Kernel::new().unwrap();
    let first: Value = serde_json::from_str(SEED).unwrap();
    let mut conflicting = first.clone();
    conflicting["requirements"][0]["target"]["label"] = json!("另一个目标");
    let authority: Value = serde_json::from_str(AUTHORITY).unwrap();
    let raw = json!({
        "examples": {"first": first, "conflicting": conflicting},
        "source_texts": [],
        "authority": authority
    });
    let error = ValidationContext::from_value(&raw, &kernel).unwrap_err();
    assert_eq!(error.code, "CONTEXT_DUPLICATE_ID");
}

#[test]
fn context_registry_allows_identical_question_records_under_different_fixture_names() {
    let kernel = Kernel::new().unwrap();
    let fixture: Value = serde_json::from_str(SEED).unwrap();
    let question_id = fixture["question_id"].as_str().unwrap().to_owned();
    let authority: Value = serde_json::from_str(AUTHORITY).unwrap();
    let raw = json!({
        "examples": {"first": fixture.clone(), "same_record": fixture},
        "source_texts": [],
        "authority": authority
    });
    let ctx = ValidationContext::from_value(&raw, &kernel).unwrap();
    assert_eq!(ctx.examples().len(), 2);
    assert_eq!(ctx.specs().len(), 1);
    assert!(ctx.specs().contains_key(&question_id));
}

#[test]
fn claim_identity_includes_graph_revision() {
    let kernel = Kernel::new().unwrap();
    let mut authority: Value = serde_json::from_str(AUTHORITY).unwrap();
    authority["claims"] = json!([
        {"claim_ref":"same_claim","graph_revision":"graph_v1"},
        {"claim_ref":"same_claim","graph_revision":"graph_v2"}
    ]);
    let mut raw = json!({"examples":{},"source_texts":[],"authority":authority});
    ValidationContext::from_value(&raw, &kernel).unwrap();
    raw["authority"]["claims"][1]["graph_revision"] = json!("graph_v1");
    assert_eq!(
        ValidationContext::from_value(&raw, &kernel)
            .unwrap_err()
            .code,
        "CONTEXT_DUPLICATE_ID"
    );
}
