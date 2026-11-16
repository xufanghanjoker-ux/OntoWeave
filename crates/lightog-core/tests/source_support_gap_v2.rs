//! Versioned source-gap replay; authored synthetic source and judgments only.
use lightog_core::{
    common::{canonical_hash as hash, sha},
    knowledge_build, semantic_review, semantic_review_v2, source_support_gap,
    source_support_gap_v2, support_selection,
};
use serde_json::{json, Value};
fn fixture(partial: bool) -> Value {
    let text = "🍁 Maple has capacity in Europe. Birch has capacity in Europe.";
    let source = json!({"id":"source_gap_authored","content":text,"sha256":sha(&json!(text)),"original_sha256":sha(&json!(text)),"parser_version":"authored-synthetic/1","source_revision":"v1"});
    let snapshot = json!({"base_ref":"eval_source_gap_authored","source_epoch":0,"graph_revision":null,"sources":[{"source_ref":source["id"],"source_revision":"v1","text_sha256":source["sha256"],"original_sha256":source["original_sha256"],"parser_version":source["parser_version"]}]});
    let es = json!({"contract_version":"lightog-demand/0.1","evidence_set_id":"es_source_gap_authored","snapshot":snapshot,"fragments":[{"id":"e_authored","origin":"SOURCE_FRAGMENT","source_ref":source["id"],"source_revision":"v1","block_ref":"block_authored","text_sha256":source["sha256"],"span":{"start":0,"end":text.encode_utf16().count(),"quote":text,"offset_unit":"utf16_code_unit"},"claim_refs":[],"role":"PRIMARY"}]});
    let context = json!({"examples":{"raw":es},"source_texts":[{"source_ref":source["id"],"source_revision":"v1","text":text,"original_sha256":source["original_sha256"],"parser_version":source["parser_version"],"blocks":[{"block_ref":"block_authored","start":0,"end":text.encode_utf16().count()}]}],"authority":{"requests":[],"allowed_snapshots":[snapshot],"claims":[],"receipts":[],"scope_bindings":[],"entities":[],"predicate_refs":[],"user_definitions":[],"groups":[],"entity_links":[]}});
    let prepared=knowledge_build::prepare_extract(&json!({"evidence_set_ref":es["evidence_set_id"],"cq_guidance":"An unformalized hint, not a closed target.","trusted_context":context})).unwrap();
    let mut all = vec![];
    let mut active = vec![];
    let mut batches = vec![];
    for id in ["c_z_partial", "c_active", "c_a_partial"] {
        let nonactive = id != "c_active";
        let name = if nonactive { "Birch" } else { "Maple" };
        let byte = text.find(name).unwrap();
        let start = text[..byte].encode_utf16().count();
        let candidate = json!({"contract_version":"lightog-knowledge/0.2","candidate_id":id,"kind":"ATTRIBUTE","snapshot":snapshot,"evidence_set_ref":es["evidence_set_id"],"evidence_ids":["e_authored"],"entities":[{"local_id":"subject","label":name,"entity_ref":null,"type_label":"Example","mentions":[{"evidence_ref":"e_authored","span":{"start":start,"end":start+name.encode_utf16().count(),"quote":name,"offset_unit":"utf16_code_unit"}}]}],"subject_local_id":"subject","predicate":{"predicate_ref":null,"proposed_definition":{"label":"capacity","description":"Authored capacity proposal","evidence_ids":["e_authored"]}},"object":{"entity_local_id":null,"typed_value":{"kind":"STRING","value":"10"}},"direction":"NONE","description":"An unverified capacity proposal with original restrictions.","keywords":["capacity"],"qualifiers":{"scope":"Europe","modality":if nonactive{"PLANNED"}else{"CURRENT"},"negated":nonactive,"unit":"MiB","effective_time":"2030"},"conditions":[{"id":"scope1","text":"Europe AND example scope","evidence_ids":["e_authored"],"support_status":"UNVERIFIED"}],"status":"CANDIDATE","semantic_status":"UNVERIFIED"});
        let receipt = json!({"candidate_id":id,"status":"VALIDATED_CANDIDATE","validator":"RUST_P2_BUILD","candidate_sha256":hash(&candidate),"prepared_payload_sha256":hash(&prepared["payload"]),"fact_support_evidence_ids":["e_authored"],"registry_anchor_evidence_ids":["e_authored"]});
        let mut p = json!({"contract_version":semantic_review::VERSION,"candidates":[candidate],"prepared":prepared,"trusted_context":context,"receipts":[receipt],"context_evidence_ids":[],"max_context_utf16":12000});
        let m = semantic_review::execute("prepare", &p).unwrap();
        let mut dims = serde_json::Map::new();
        for dim in semantic_review::DIMENSIONS {
            dims.insert(dim.to_owned(),json!({"decision":if nonactive&&partial&&dim=="scope"{"PARTIAL"}else{"SUPPORTED"},"reason":"SYNTHETIC_OLD_REVIEW_SECRET_DO_NOT_SEND","evidence_ids":["e_authored"]}));
        }
        p["manifest"] = m["manifest"].clone();
        p["review_output"] = json!({"reviews":[{"candidate_id":id,"decision":if nonactive&&partial{"PARTIAL"}else{"SUPPORTED"},"dimensions":dims}]});
        p["review_provenance"] = json!({"origin":"SYNTHETIC","review_request_id":format!("review_{id}"),"proposal_request_ids":[format!("proposal_{id}")],"review_output_sha256":hash(&p["review_output"]),"model":"SYNTHETIC_ONLY","config_revision":1});
        let gate = semantic_review::execute("apply", &p).unwrap();
        all.push(candidate.clone());
        active.extend(gate["eligible_candidates"].as_array().unwrap().clone());
        batches.push(json!({"unit_id":id,"result":{"gate_input":p,"gate_result":gate,"proposal_materialized":{"candidates":[candidate]},"eligible_candidates":gate["eligible_candidates"]}}));
    }
    let built = knowledge_build::build(
        &json!({"candidates":active,"snapshot":snapshot,"trusted_context":context}),
    )
    .unwrap();
    json!({"contract_version":source_support_gap_v2::VERSION,"source":source,"cq_seeds":[{"seed_id":"unformalized","text":"This question cannot currently be formalized; still recheck the source."}],"artifact":{"source_id":source["id"],"source_sha256":source["sha256"],"snapshot":snapshot,"evidenceSet":es,"context":context,"p2Build":built,"all_proposal_candidates":all,"semantic_batches":batches,"segment_evidence_set_refs":[es["evidence_set_id"]]}})
}
fn upgrade(p: &mut Value, index: usize) {
    let r = &mut p["artifact"]["semantic_batches"][index]["result"];
    let mut input = r["gate_input"].clone();
    input["contract_version"] = json!(semantic_review_v2::VERSION);
    let payload_hash = hash(&input["prepared"]["payload"]);
    for receipt in input["receipts"].as_array_mut().unwrap() {
        let roles = json!({"assertion":["e_authored"],"subject_scope":[],"antecedent":[],"condition":["e_authored"]});
        receipt["support_selection_version"] = json!(support_selection::VERSION);
        receipt["support_roles"] = roles.clone();
        receipt["support_roles_sha256"] = json!(hash(&roles));
        receipt["support_selection_prepared_payload_sha256"] = json!(payload_hash);
    }
    input["manifest"] = semantic_review_v2::prepare(&input).unwrap()["manifest"].clone();
    let gate = semantic_review_v2::execute("apply", &input).unwrap();
    r["gate_input"] = input;
    r["gate_result"] = gate.clone();
    r["eligible_candidates"] = gate["eligible_candidates"].clone();
}
#[test]
fn old_baseline_preserves_selection_and_source_projection() {
    let p = fixture(true);
    let mut old = p.clone();
    old["contract_version"] = json!(source_support_gap::VERSION);
    let before = source_support_gap::execute("prepare", &old).unwrap();
    let after = source_support_gap_v2::execute("prepare", &p).unwrap();
    assert_eq!(before["sourceArtifact"], after["sourceArtifact"]);
    assert_eq!(before["task"]["source_fact"], after["task"]["source_fact"]);
    assert_eq!(
        before["selection_receipt"]["eligible_gap_candidate_ids"],
        after["selection_receipt"]["eligible_gap_candidate_ids"]
    );
    assert_eq!(after["task"]["candidate_ids"][0], "c_a_partial");
}
#[test]
fn mixed_legacy_and_explicit_support_gates_are_replayed_by_their_exact_version() {
    let mut p = fixture(true);
    upgrade(&mut p, 0);
    upgrade(&mut p, 2);
    let out = source_support_gap_v2::execute("prepare", &p).unwrap();
    assert_eq!(out["task"]["candidate_ids"][0], "c_a_partial");
    let receipts = out["selection_receipt"]["private_gate_replay"]
        .as_array()
        .unwrap();
    assert_eq!(
        receipts[0]["gate_contract_version"],
        semantic_review_v2::VERSION
    );
    assert_eq!(
        receipts[1]["gate_contract_version"],
        semantic_review::VERSION
    );
    assert!(!out["sourceArtifact"]
        .to_string()
        .contains("SYNTHETIC_OLD_REVIEW_SECRET_DO_NOT_SEND"));
}
#[test]
fn new_only_gates_are_reusable_and_task_validation_is_version_bound() {
    let mut p = fixture(true);
    for i in 0..3 {
        upgrade(&mut p, i);
    }
    let out = source_support_gap_v2::execute("prepare", &p).unwrap();
    let valid = json!({"contract_version":source_support_gap_v2::VERSION,"task":out["task"],"source_artifact":out["sourceArtifact"]});
    assert_eq!(
        source_support_gap_v2::execute("validate", &valid).unwrap()["validated"],
        true
    );
}
#[test]
fn unknown_downgraded_or_changed_mixed_gate_cannot_reuse_a_manifest() {
    for mode in 0..4 {
        let mut p = fixture(true);
        upgrade(&mut p, 0);
        match mode {
            0 => {
                p["artifact"]["semantic_batches"][0]["result"]["gate_input"]["contract_version"] =
                    json!("unrecognized/99")
            }
            1 => {
                p["artifact"]["semantic_batches"][0]["result"]["gate_input"]["contract_version"] =
                    json!(semantic_review::VERSION)
            }
            2 => {
                p["artifact"]["semantic_batches"][0]["result"]["gate_input"]["receipts"][0]
                    ["support_roles"]["assertion"] = json!([])
            }
            _ => {
                p["artifact"]["semantic_batches"][1]["result"]["gate_result"]
                    ["eligible_candidates"] = json!([])
            }
        };
        assert!(source_support_gap_v2::execute("prepare", &p).is_err());
    }
}
#[test]
fn changing_legacy_gate_to_new_version_does_not_fabricate_support_role_receipt() {
    let mut p = fixture(true);
    p["artifact"]["semantic_batches"][0]["result"]["gate_input"]["contract_version"] =
        json!(semantic_review_v2::VERSION);
    assert!(source_support_gap_v2::execute("prepare", &p).is_err());
}
