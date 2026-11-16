//! P1 contract boundary tests. Original synthetic fixtures, no model or product writes.
use lightog_demand::{
    evidence_bridge::{execute, VERSION},
    wire,
};
use serde_json::{json, Value};
fn parse(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap()
}
fn authority() -> Value {
    parse(include_str!(
        "../../../fixtures/demand-contract-v0.1/validation-context.json"
    ))
}
fn context() -> Value {
    let sources = parse(include_str!(
        "../../../fixtures/demand-contract-v0.1/source-texts.json"
    ));
    json!({"examples":{},"source_texts":sources["sources"],"authority":authority()})
}
fn source_set() -> Value {
    parse(include_str!(
        "../../../contracts/demand-v0.1/examples/evidence-set.json"
    ))
}
fn source_payload() -> Value {
    let es = source_set();
    json!({"request":{"bridge_version":VERSION,"evidence_set_id":"es_bridge","snapshot":es["snapshot"],"source_fragments":es["fragments"],"legacy_claim_ids":[]},"context":context(),"legacy_claims":[]})
}
fn graph_payload() -> Value {
    let auth = authority();
    let published = &auth["claims"][0];
    let claim = json!({"id":"claim_d_europe","subject_id":"ent_d","predicate_id":"location","value":"欧洲","source_id":"src_new","quote":published["span"]["quote"],"start":0,"end":26,"modality":"CURRENT","comparator":"EQ","unit":null,"scope":"面向零售客户","effective_from":null,"time_raw":null,"offset_unit":"utf16_code_unit","support_set":[]});
    let mut p = json!({"request":{"bridge_version":VERSION,"evidence_set_id":"es_bridge","snapshot":auth["allowed_snapshots"][1],"source_fragments":[],"legacy_claim_ids":["claim_d_europe"]},"context":context(),"legacy_claims":[claim]});
    authorize_stored_payload(&mut p);
    p
}
fn authorize_stored_payload(p: &mut Value) {
    // Synthetic host registry: copy only when constructing an intentionally
    // stored fixture, never during compose or after a candidate is received.
    p["context"]["authority"]["claims"][0]["legacy_payload"] = p["legacy_claims"][0].clone();
}
fn bundle() -> Value {
    let mut p = json!({"context":context(),"question_spec":parse(include_str!("../../../contracts/demand-v0.1/examples/ungraphed-subject.json")),"evidence_set":source_set(),"coverage_report":parse(include_str!("../../../contracts/demand-v0.1/examples/source-answer-coverage.json")),"answer_result":parse(include_str!("../../../contracts/demand-v0.1/examples/source-answer.json")),"learning_intent":parse(include_str!("../../../contracts/demand-v0.1/examples/background-learning.json"))});
    authorize_learning_task(&mut p);
    p
}
fn authorize_learning_task(p: &mut Value) {
    let answer = &p["answer_result"];
    let task = json!({"task_ref":answer["learning_state"]["task_ref"],"request_ref":answer["request_ref"],"question_spec_sha256":answer["question_spec_sha256"],"snapshot_sha256":wire::sha(&answer["snapshot"]).unwrap(),"status":answer["learning_state"]["status"]});
    p["context"]["authority"]["learning_tasks"] = json!([task]);
}

#[test]
fn document_without_any_graph_or_claim_is_valid() {
    let out = execute("compose", &source_payload()).unwrap();
    assert_eq!(out["basis"], "DOCUMENT");
    assert!(out["legacy_claims"].as_array().unwrap().is_empty());
    assert!(out["evidence_set"]["snapshot"]["graph_revision"].is_null());
    assert!(out["evidence_set"]["fragments"]
        .as_array()
        .unwrap()
        .iter()
        .all(|f| f["claim_refs"] == json!([])));
}
#[test]
fn published_legacy_claim_is_mapped_without_changing_identity_or_qualifiers() {
    let p = graph_payload();
    let out = execute("compose", &p).unwrap();
    assert_eq!(out["basis"], "GRAPH");
    assert_eq!(out["legacy_claims"], p["legacy_claims"]);
    assert_eq!(
        out["evidence_set"]["fragments"][0]["claim_refs"],
        json!(["claim_d_europe"])
    );
    assert_eq!(out["semantic_support"], "NOT_CERTIFIED_BY_BRIDGE");
}
#[test]
fn primary_and_support_are_separate_positioned_evidence_and_raw_roles_survive() {
    let mut p = graph_payload();
    let es = source_set();
    let f = &es["fragments"][0];
    p["legacy_claims"][0]["support_set"] = json!([{"source_id":f["source_ref"],"quote":f["span"]["quote"],"start":f["span"]["start"],"end":f["span"]["end"],"role":"TABLE_HEADER","source_sha256":f["text_sha256"]}]);
    authorize_stored_payload(&mut p);
    let out = execute("compose", &p).unwrap();
    assert_eq!(out["basis"], "MIXED");
    assert_eq!(out["legacy_claims"], p["legacy_claims"]);
    assert_eq!(
        out["claim_evidence"][0]["support_evidence_ids"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        out["evidence_set"]["fragments"][1]["origin"],
        "SOURCE_FRAGMENT"
    );
}
#[test]
fn caller_cannot_smuggle_published_origin_through_raw_fragment() {
    let mut p = source_payload();
    p["request"]["source_fragments"][0]["origin"] = json!("PUBLISHED_CLAIM");
    assert_eq!(
        execute("compose", &p).unwrap_err().code,
        "EVIDENCE_ORIGIN_MISMATCH"
    );
}
#[test]
fn claim_self_reported_published_does_not_grant_authority() {
    let mut p = graph_payload();
    p["context"]["authority"]["claims"] = json!([]);
    p["legacy_claims"][0]["status"] = json!("PUBLISHED");
    assert_eq!(
        execute("compose", &p).unwrap_err().code,
        "CLAIM_REF_UNRESOLVED"
    );
}
#[test]
fn graph_snapshot_required() {
    let mut p = graph_payload();
    p["request"]["snapshot"] = source_set()["snapshot"].clone();
    assert_eq!(
        execute("compose", &p).unwrap_err().code,
        "CLAIM_REF_UNRESOLVED"
    );
}
#[test]
fn stale_snapshot_rejected_even_if_text_unchanged() {
    let mut p = source_payload();
    p["request"]["snapshot"]["source_epoch"] = json!(2);
    assert_eq!(
        execute("compose", &p).unwrap_err().code,
        "SOURCE_SNAPSHOT_MISMATCH"
    );
}
#[test]
fn modified_quote_rejected() {
    let mut p = graph_payload();
    p["legacy_claims"][0]["quote"] = json!("不存在的原文");
    assert!(execute("compose", &p).is_err());
}
#[test]
fn invalid_support_span_cannot_be_ignored() {
    let mut p = graph_payload();
    p["legacy_claims"][0]["support_set"] =
        json!([{"source_id":"src_compare","quote":"伪造","start":0,"end":2,"role":"CONDITION"}]);
    assert!(execute("compose", &p).is_err());
}
#[test]
fn source_hash_mismatch_rejected() {
    let mut p = graph_payload();
    p["legacy_claims"][0]["source_sha256"] = json!("0".repeat(64));
    assert_eq!(
        execute("compose", &p).unwrap_err().code,
        "EVIDENCE_HASH_MISMATCH"
    );
}
#[test]
fn duplicate_selection_and_unknown_fields_rejected() {
    let mut p = graph_payload();
    p["request"]["legacy_claim_ids"] = json!(["claim_d_europe", "claim_d_europe"]);
    assert_eq!(
        execute("compose", &p).unwrap_err().code,
        "BRIDGE_DUPLICATE_LEGACY_CLAIM"
    );
    let mut p = source_payload();
    p["request"]["assume_valid"] = json!(true);
    assert_eq!(
        execute("compose", &p).unwrap_err().code,
        "BRIDGE_INPUT_INVALID"
    );
}
#[test]
fn utf16_surrogate_pair_is_checked_exactly() {
    let text = "甲😀乙";
    let hash = wire::text_sha(text);
    let snapshot = json!({"base_ref":"kb_u","source_epoch":1,"graph_revision":null,"sources":[{"source_ref":"src_u","source_revision":"v1","text_sha256":hash,"original_sha256":hash,"parser_version":"text/1"}]});
    let mut p = json!({"request":{"bridge_version":VERSION,"evidence_set_id":"es_u","snapshot":snapshot,"source_fragments":[{"id":"e_u","origin":"SOURCE_FRAGMENT","source_ref":"src_u","source_revision":"v1","block_ref":"b_u","text_sha256":hash,"span":{"start":1,"end":3,"quote":"😀","offset_unit":"utf16_code_unit"},"claim_refs":[],"role":"PRIMARY"}],"legacy_claim_ids":[]},"context":{"examples":{},"source_texts":[{"source_ref":"src_u","source_revision":"v1","block_ref":"b_u","text":text,"original_utf8_text":text}],"authority":{"requests":[],"allowed_snapshots":[snapshot],"claims":[],"receipts":[],"scope_bindings":[],"entities":[],"predicate_refs":[],"user_definitions":[],"groups":[]}},"legacy_claims":[]});
    execute("compose", &p).unwrap();
    p["request"]["source_fragments"][0]["span"]["end"] = json!(2);
    assert!(execute("compose", &p).is_err());
}
#[test]
fn answer_can_be_document_based_while_background_queued_or_failed() {
    let mut p = bundle();
    assert_eq!(
        execute("validate_answer_bundle", &p).unwrap()["basis"],
        "DOCUMENT"
    );
    p["answer_result"]["learning_state"]["status"] = json!("FAILED");
    p["learning_intent"]["status"] = json!("FAILED");
    authorize_learning_task(&mut p);
    assert_eq!(
        execute("validate_answer_bundle", &p).unwrap()["answer_status"],
        "ANSWERED"
    );
}
#[test]
fn read_only_answer_must_not_claim_learning() {
    let mut p = bundle();
    p["answer_result"]["request_ref"] = json!("req_synthetic");
    p.as_object_mut().unwrap().remove("learning_intent");
    assert_eq!(
        execute("validate_answer_bundle", &p).unwrap_err().code,
        "ACCESS_SCOPE_DENIED"
    );
    p["answer_result"]["learning_state"] = json!({"status":"NOT_REQUESTED","task_ref":null});
    execute("validate_answer_bundle", &p).unwrap();
}
#[test]
fn claimed_basis_and_answer_learning_state_are_not_trusted() {
    let mut p = bundle();
    p["answer_result"]["basis"] = json!("GRAPH");
    assert_eq!(
        execute("validate_answer_bundle", &p).unwrap_err().code,
        "ANSWER_BASIS_MISMATCH"
    );
    let mut p = bundle();
    p["learning_intent"]["status"] = json!("FAILED");
    assert_eq!(
        execute("validate_answer_bundle", &p).unwrap_err().code,
        "BRIDGE_LEARNING_STATE_MISMATCH"
    );
}
#[test]
fn omitted_requirement_coverage_cannot_be_answered() {
    let mut p = bundle();
    p["coverage_report"]["requirements"] = json!([]);
    assert!(execute("validate_answer_bundle", &p).is_err());
}

// Synthetic parsed text and binary original bytes: exercises the P1 transport
// contract only, and does not stand in for a PDF parser acceptance test.
fn binary_multiblock_payload() -> Value {
    let text = "甲😀允许。\n乙禁止。";
    let text_hash = wire::text_sha(text);
    let original_hash = wire::bytes_sha(b"%PDF-1.7\n\x00\xffbinary-original\n%%EOF");
    let snapshot = json!({"base_ref":"kb_binary","source_epoch":3,"graph_revision":null,"sources":[{"source_ref":"src_pdf","source_revision":"pdf_v1","original_sha256":original_hash,"text_sha256":text_hash,"parser_version":"synthetic-parser/1"}]});
    json!({"request":{"bridge_version":VERSION,"evidence_set_id":"es_binary","snapshot":snapshot,"source_fragments":[{"id":"e_binary","origin":"SOURCE_FRAGMENT","source_ref":"src_pdf","source_revision":"pdf_v1","block_ref":"b2","text_sha256":text_hash,"span":{"start":7,"end":11,"quote":"乙禁止。","offset_unit":"utf16_code_unit"},"claim_refs":[],"role":"PRIMARY"}],"legacy_claim_ids":[]},"context":{"examples":{},"source_texts":[{"source_ref":"src_pdf","source_revision":"pdf_v1","text":text,"original_sha256":original_hash,"parser_version":"synthetic-parser/1","blocks":[{"block_ref":"b1","start":0,"end":6},{"block_ref":"b2","start":7,"end":11}]}],"authority":{"requests":[],"allowed_snapshots":[snapshot],"claims":[],"receipts":[],"scope_bindings":[],"entities":[],"predicate_refs":[],"user_definitions":[],"groups":[]}},"legacy_claims":[]})
}
#[test]
fn binary_original_hash_is_distinct_from_parsed_text_and_blocks_are_validated() {
    let p = binary_multiblock_payload();
    assert_ne!(
        p["request"]["snapshot"]["sources"][0]["original_sha256"],
        p["request"]["snapshot"]["sources"][0]["text_sha256"]
    );
    let out = execute("compose", &p).unwrap();
    assert_eq!(out["basis"], "DOCUMENT");
    assert_eq!(out["evidence_set"]["fragments"][0]["block_ref"], "b2");
}
#[test]
fn multiblock_wrong_block_and_unregistered_gap_are_rejected() {
    let mut p = binary_multiblock_payload();
    p["request"]["source_fragments"][0]["block_ref"] = json!("b1");
    assert_eq!(
        execute("compose", &p).unwrap_err().code,
        "UNKNOWN_BLOCK_REF"
    );
    let mut p = binary_multiblock_payload();
    p["request"]["source_fragments"][0]["span"] =
        json!({"start":6,"end":7,"quote":"\n","offset_unit":"utf16_code_unit"});
    assert_eq!(
        execute("compose", &p).unwrap_err().code,
        "UNKNOWN_BLOCK_REF"
    );
}
#[test]
fn cross_block_quote_requires_separate_fragments() {
    let mut p = binary_multiblock_payload();
    p["request"]["source_fragments"][0]["span"] =
        json!({"start":0,"end":11,"quote":"甲😀允许。\n乙禁止。","offset_unit":"utf16_code_unit"});
    assert_eq!(
        execute("compose", &p).unwrap_err().code,
        "UNKNOWN_BLOCK_REF"
    );
}
#[test]
fn parser_version_and_binary_original_hash_cannot_be_relabelled() {
    let mut p = binary_multiblock_payload();
    p["request"]["snapshot"]["sources"][0]["parser_version"] = json!("other-parser/1");
    assert_eq!(
        execute("compose", &p).unwrap_err().code,
        "PARSER_VERSION_MISMATCH"
    );
    let mut p = binary_multiblock_payload();
    p["request"]["snapshot"]["sources"][0]["original_sha256"] =
        p["request"]["snapshot"]["sources"][0]["text_sha256"].clone();
    assert_eq!(
        execute("compose", &p).unwrap_err().code,
        "ORIGINAL_HASH_MISMATCH"
    );
}
#[test]
fn finite_legacy_decimal_payload_is_preserved_without_rehashing_claim_identity() {
    let mut p = graph_payload();
    p["legacy_claims"][0]["value"] = json!(12.5);
    authorize_stored_payload(&mut p);
    let out = execute("compose", &p).unwrap();
    assert_eq!(out["legacy_claims"], p["legacy_claims"]);
}

#[test]
fn nontrivial_learning_state_requires_the_host_learning_intent() {
    let mut p = bundle();
    p.as_object_mut().unwrap().remove("learning_intent");
    assert_eq!(
        execute("validate_answer_bundle", &p).unwrap_err().code,
        "BRIDGE_LEARNING_INTENT_MISSING"
    );
}

#[test]
fn published_anchor_does_not_authorize_changed_legacy_semantics() {
    for (field, value) in [
        ("subject_id", json!("ent_other")),
        ("predicate_id", json!("other_predicate")),
        ("value", json!("其他地区")),
        ("scope", json!("无条件")),
        ("modality", json!("PLANNED")),
        ("unit", json!("kg")),
        ("comparator", json!("GT")),
        ("effective_from", json!("2025-01-01")),
        (
            "support_set",
            json!([{"source_id":"src_new","quote":"无关","start":0,"end":2,"role":"CONDITION"}]),
        ),
    ] {
        let mut p = graph_payload();
        p["legacy_claims"][0][field] = value;
        assert_eq!(
            execute("compose", &p).unwrap_err().code,
            "BRIDGE_LEGACY_PAYLOAD_MISMATCH",
            "{field}"
        );
    }
    let mut p = graph_payload();
    p["context"]["authority"]["claims"][0]
        .as_object_mut()
        .unwrap()
        .remove("legacy_payload");
    assert_eq!(
        execute("compose", &p).unwrap_err().code,
        "BRIDGE_LEGACY_PAYLOAD_MISMATCH"
    );
}

#[test]
fn learning_strings_without_persisted_task_or_commit_cannot_be_reported() {
    let mut p = bundle();
    p["context"]["authority"]["learning_tasks"] = json!([]);
    assert_eq!(
        execute("validate_answer_bundle", &p).unwrap_err().code,
        "BRIDGE_LEARNING_TASK_UNVERIFIED"
    );
    let mut p = bundle();
    p["answer_result"]["learning_state"]["status"] = json!("PUBLISHED");
    p["learning_intent"]["status"] = json!("PUBLISHED");
    p["learning_intent"]["admission_evidence_ids"] = json!(["e_new"]);
    authorize_learning_task(&mut p);
    assert_eq!(
        execute("validate_answer_bundle", &p).unwrap_err().code,
        "BRIDGE_LEARNING_COMMIT_UNVERIFIED"
    );
    let h = wire::sha(&p["answer_result"]["snapshot"]).unwrap();
    p["context"]["authority"]["learning_tasks"][0]["output_graph_revision"] = json!("graph_new");
    p["context"]["authority"]["learning_commits"] = json!([{"commit_ref":"commit_new","task_ref":"task_new_subject","request_ref":"req_learning","question_spec_sha256":p["answer_result"]["question_spec_sha256"],"input_snapshot_sha256":h,"output_graph_revision":"graph_new","status":"COMMITTED"}]);
    let mut published = p["answer_result"]["snapshot"].clone();
    published["graph_revision"] = json!("graph_new");
    p["context"]["authority"]["allowed_snapshots"]
        .as_array_mut()
        .unwrap()
        .push(published);
    execute("validate_answer_bundle", &p).unwrap();
    p["context"]["authority"]["learning_commits"][0]["input_snapshot_sha256"] =
        json!("0".repeat(64));
    assert_eq!(
        execute("validate_answer_bundle", &p).unwrap_err().code,
        "BRIDGE_LEARNING_COMMIT_UNVERIFIED"
    );
}

#[test]
fn answer_bundle_cannot_reuse_a_request_from_another_base_or_epoch() {
    for (field, value) in [
        ("base_ref", json!("other_base")),
        ("source_epoch", json!(9)),
    ] {
        let mut p = bundle();
        p["context"]["authority"]["requests"][1]["context"][field] = value;
        assert!(execute("validate_answer_bundle", &p).is_err(), "{field}");
    }
}

#[test]
fn final_statement_cannot_substitute_other_evidence_in_the_same_set() {
    let mut p = bundle();
    p["answer_result"]["statements"][0]["evidence_ids"] = json!(["e_cohort"]);
    assert_eq!(
        execute("validate_answer_bundle", &p).unwrap_err().code,
        "BRIDGE_STATEMENT_COVERAGE_MISMATCH"
    );
}

#[test]
fn stored_legacy_source_metadata_must_agree_with_the_trusted_snapshot() {
    for (field, value, code) in [
        (
            "original_sha256",
            json!("0".repeat(64)),
            "ORIGINAL_HASH_MISMATCH",
        ),
        (
            "parser_version",
            json!("other/1"),
            "PARSER_VERSION_MISMATCH",
        ),
        (
            "source_revision",
            json!("other_v2"),
            "SOURCE_REVISION_MISMATCH",
        ),
    ] {
        let mut p = graph_payload();
        p["legacy_claims"][0][field] = value;
        authorize_stored_payload(&mut p);
        assert_eq!(execute("compose", &p).unwrap_err().code, code);
    }
}
