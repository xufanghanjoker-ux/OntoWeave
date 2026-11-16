//! Authored source/semantic judgments, no provider, gold or storage claims.
use lightog_core::{
    common::{canonical_hash as hash, text_sha},
    knowledge_build, semantic_review_v2 as review, semantic_review_v3 as structured_review,
    source_learning_v1 as learning, support_selection,
};
use serde_json::{json, Value};

fn fixture() -> Value {
    let text="🚀 Mode Alpha.\nIt leaves the index unchanged.\nIt refers to mode Alpha.\nIf the same file is unstaged, abort.\n";
    let digest = text_sha(text);
    let size = text.encode_utf16().count();
    let snapshot = json!({"base_ref":"source_learning_authored","source_epoch":0,"graph_revision":null,"sources":[{"source_ref":"src","source_revision":"r1","original_sha256":digest,"text_sha256":digest,"parser_version":"authored/1"}]});
    let mut at = 0;
    let fragments:Vec<_>=text.split_inclusive('\n').zip(["mode","assertion","antecedent","condition"]).map(|(quote,id)|{let start=at;at+=quote.encode_utf16().count();json!({"id":id,"origin":"SOURCE_FRAGMENT","source_ref":"src","source_revision":"r1","block_ref":"b","text_sha256":digest,"span":{"start":start,"end":at,"quote":quote,"offset_unit":"utf16_code_unit"},"claim_refs":[],"role":"PRIMARY"})}).collect();
    let es = json!({"contract_version":"lightog-demand/0.1","evidence_set_id":"es","snapshot":snapshot,"fragments":fragments});
    let context = json!({"examples":{"es":es},"source_texts":[{"source_ref":"src","source_revision":"r1","text":text,"original_sha256":digest,"parser_version":"authored/1","blocks":[{"block_ref":"b","start":0,"end":size}]}],"authority":{"requests":[],"allowed_snapshots":[snapshot],"claims":[],"receipts":[],"scope_bindings":[],"entities":[],"predicate_refs":[],"user_definitions":[],"groups":[],"entity_links":[]}});
    let question = "How does mode Alpha affect the index?";
    let runtime = json!({"current_snapshot":snapshot,"grants":[{"request_ref":"request_authored","question_sha256":text_sha(question),"base_ref":snapshot["base_ref"],"source_epoch":0,"access_mode":"LEARN","learning_requested":true}],"persisted_job_sha256":null,"persisted_revision":0,"support_hold_candidate_sha256":[],"graph_record_sha256":null,"commit_record_sha256":null,"index_record_sha256":null,"index_payload_sha256":null});
    json!({"contract_version":learning::VERSION,"request":{"request_ref":"request_authored","raw_question":question,"cq_seeds":[{"seed_id":"seed_authored","text":question}],"kind":"DISCOVERY","policy_version":"authored-policy/1"},"evidence_set":es,"source_gap":null,"context":context,"runtime":runtime})
}
fn gate(f: &Value, unit: &str, required: bool) -> Value {
    let es = &f["evidence_set"];
    let context = &f["context"];
    let prepared=knowledge_build::prepare_extract(&json!({"evidence_set_ref":es["evidence_set_id"],"cq_guidance":f["request"]["raw_question"],"trusted_context":context})).unwrap();
    let mut raw = json!({"entities":[{"local_id":"Alpha","surface":"Alpha","type_label":null,"mention_evidence_id":"mode"}],"candidates":[{"kind":"ATTRIBUTE","subject_local_id":"Alpha","predicate":{"label":"index effect","description":"Effect on index state","evidence_ids":["assertion"]},"object":{"entity_local_id":null,"typed_value":{"kind":"STRING","value":"unchanged"}},"direction":"NONE","description":"Mode Alpha leaves the index unchanged.","keywords":["index"],"qualifiers":{"scope":"Mode Alpha","modality":"REPORTED","negated":false,"unit":null,"effective_time":null},"conditions":[],"support_roles":{"assertion":["assertion"],"subject_scope":["mode"],"antecedent":["antecedent"],"condition":[]}}]});
    raw["entities"][0]["mention_occurrence"] = json!(1);
    let m=support_selection::execute(if required{"materialize_required_occurrence_v1"}else{"materialize_occurrence_v1"},&json!({"prepared":prepared,"trusted_context":context,"raw":raw,"unit_id":unit,"max_candidates":8})).unwrap();
    assert_eq!(m["candidates"].as_array().unwrap().len(), 1);
    let mut q = json!({"contract_version":review::VERSION,"candidates":m["candidates"],"prepared":prepared,"trusted_context":context,"receipts":m["receipts"],"context_evidence_ids":["mode","assertion","antecedent","condition"],"max_context_utf16":12000});
    q["manifest"] = review::execute("prepare", &q).unwrap()["manifest"].clone();
    let dimensions:serde_json::Map<_,_>=review::DIMENSIONS.iter().map(|d|(d.to_string(),json!({"decision":if *d=="units"{"NOT_APPLICABLE"}else{"SUPPORTED"},"reason":"Authored independent synthetic judgment, not certified world truth.","evidence_ids":["assertion","mode","antecedent"]}))).collect();
    q["review_output"] = json!({"reviews":[{"candidate_id":q["candidates"][0]["candidate_id"],"decision":"SUPPORTED","dimensions":dimensions}]});
    q["review_provenance"] = json!({"origin":"SYNTHETIC","review_request_id":format!("review_{unit}"),"proposal_request_ids":[format!("proposal_{unit}")],"review_output_sha256":hash(&q["review_output"]),"model":"synthetic-offline","config_revision":1});
    q
}
fn payload(f: &Value, j: &Value) -> Value {
    let mut runtime = f["runtime"].clone();
    runtime["persisted_job_sha256"] = j["job_sha256"].clone();
    runtime["persisted_revision"] = j["revision"].clone();
    json!({"contract_version":learning::VERSION,"job":j,"context":f["context"],"runtime":runtime})
}
fn job(f: &Value) -> Value {
    learning::execute("create", f).unwrap()["job"].clone()
}
fn validating(f: &Value) -> Value {
    let mut j = job(f);
    for stage in ["RETRIEVING", "EXTRACTING", "VALIDATING"] {
        let mut p = payload(f, &j);
        p["next_stage"] = json!(stage);
        j = learning::execute("step", &p).unwrap()["job"].clone();
    }
    j
}

// The old gate helper above only authors fixture candidates; no model response
// is translated or relabelled. This is a fresh SYNTHETIC v3 output below.
fn structured_gate(f: &Value, unit: &str, required: bool) -> Value {
    let authored = gate(f, unit, required);
    let input = json!({"contract_version":structured_review::VERSION,"candidates":authored["candidates"],"prepared":authored["prepared"],"trusted_context":authored["trusted_context"],"receipts":authored["receipts"],"context_evidence_ids":authored["context_evidence_ids"],"max_context_utf16":authored["max_context_utf16"]});
    let prepared = structured_review::execute("prepare", &input).unwrap();
    let mut q = input;
    let dims:serde_json::Map<_,_>=structured_review::DIMENSIONS.iter().map(|d|(d.to_string(),json!({"decision":if *d=="units"{"NOT_APPLICABLE"}else{"SUPPORTED"},"reason":"Fresh authored synthetic structural judgment only.","evidence_ids":["assertion","mode","antecedent"]}))).collect();
    q["manifest"] = prepared["manifest"].clone();
    q["review_output"] = json!({"reviews":[{"candidate_id":q["candidates"][0]["candidate_id"],"decision":"SUPPORTED","dimensions":dims,"readback":prepared["review_view"][0]["readback_expectation"],"description_support":{"decision":"SUPPORTED","reason":"Fresh authored synthetic description support.","evidence_ids":["assertion","mode","antecedent"]},"structure_description_consistency":{"decision":"CONSISTENT","reason":"Fresh authored synthetic structure/description consistency.","evidence_ids":["assertion","mode","antecedent"]}}]});
    q["review_provenance"] = json!({"origin":"SYNTHETIC","review_request_id":format!("new_structured_{unit}"),"proposal_request_ids":[format!("proposal_{unit}")],"review_output_sha256":hash(&q["review_output"]),"model":"authored-structured-fixture","config_revision":1});
    q
}
#[test]
fn new_persisted_policies_require_v3_and_required_profile_while_old_policy_keeps_v2() {
    for policy in [
        "source-learning-product-structured-review-v1",
        "source-learning-product-rebuild-structured-review-v1",
    ] {
        let mut f = fixture();
        f["request"]["policy_version"] = json!(policy);
        let j = validating(&f);
        let mut p = payload(&f, &j);
        p["base_graph"] = Value::Null;
        p["gate_input"] = structured_gate(&f, policy, true);
        assert!(learning::execute("prepare_commit", &p).is_ok());
        p["gate_input"] = gate(&f, policy, true);
        assert_eq!(
            learning::execute("prepare_commit", &p).unwrap_err().code,
            "SOURCE_LEARNING_GATE_BINDING_INVALID"
        );
        p["gate_input"] = structured_gate(&f, policy, false);
        assert_eq!(
            learning::execute("prepare_commit", &p).unwrap_err().code,
            "SOURCE_LEARNING_REQUIRED_PROPOSAL_CONTRACT"
        );
    }
    let mut f = fixture();
    f["request"]["policy_version"] = json!("source-learning-product-required-occurrence-v1");
    let j = validating(&f);
    let mut p = payload(&f, &j);
    p["base_graph"] = Value::Null;
    p["gate_input"] = gate(&f, "old_required", true);
    assert!(learning::execute("prepare_commit", &p).is_ok());
    p["gate_input"] = structured_gate(&f, "old_required", true);
    assert_eq!(
        learning::execute("prepare_commit", &p).unwrap_err().code,
        "SOURCE_LEARNING_GATE_BINDING_INVALID"
    );
}
#[test]
fn p5_commit_replays_description_and_consistency_veto_instead_of_trusting_supported_rollup() {
    for field in ["description_support", "structure_description_consistency"] {
        let mut f = fixture();
        f["request"]["policy_version"] = json!("source-learning-product-structured-review-v1");
        let j = validating(&f);
        let mut q = structured_gate(&f, field, true);
        q["review_output"]["reviews"][0][field]["decision"] =
            json!(if field == "description_support" {
                "UNSUPPORTED"
            } else {
                "CONFLICT"
            });
        q["review_provenance"]["review_output_sha256"] = json!(hash(&q["review_output"]));
        let mut p = payload(&f, &j);
        p["base_graph"] = Value::Null;
        p["gate_input"] = q;
        assert_eq!(
            learning::execute("prepare_commit", &p).unwrap_err().code,
            "SOURCE_LEARNING_NO_ELIGIBLE_CANDIDATES"
        );
    }
}
