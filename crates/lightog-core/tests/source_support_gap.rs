//! Original SYNTHETIC source/review judgments. Real Rust kernels, no provider/IO/gold.
use lightog_core::{
    common::{canonical_hash as hash, sha},
    knowledge_build, semantic_review, source_support_gap,
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
    json!({"contract_version":source_support_gap::VERSION,"source":source,"cq_seeds":[{"seed_id":"unformalized","text":"This question cannot currently be formalized; still recheck the source."}],"artifact":{"source_id":source["id"],"source_sha256":source["sha256"],"snapshot":snapshot,"evidenceSet":es,"context":context,"p2Build":built,"all_proposal_candidates":all,"semantic_batches":batches,"segment_evidence_set_refs":[es["evidence_set_id"]]}})
}
#[test]
fn deterministic_partial_nonactive_selection_preserves_source_fact_semantics() {
    let p = fixture(true);
    let before = p.clone();
    let r = source_support_gap::execute("prepare", &p).unwrap();
    assert_eq!(p, before);
    assert_eq!(r["status"], "SOURCE_SUPPORT_GAP_READY");
    assert_eq!(r["task"]["candidate_ids"][0], "c_a_partial");
    let parent = &p["artifact"]["all_proposal_candidates"][2];
    assert_eq!(r["task"]["source_fact"], *parent);
    for key in ["conditions", "qualifiers", "direction"] {
        assert_eq!(r["task"][key], parent[key]);
    }
    assert_eq!(
        r["sourceArtifact"]["p2Build"]["graph"]["candidate_archive"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(r["task"]["qualifiers"]["negated"], true);
    assert_eq!(r["task"]["qualifiers"]["effective_time"], "2030");
    assert_eq!(r["task"]["source_fact"]["semantic_status"], "UNVERIFIED");
}
#[test]
fn private_review_is_not_model_payload_or_question_spec() {
    let r = source_support_gap::execute("prepare", &fixture(true)).unwrap();
    let public = json!({"task":r["task"],"sourceArtifact":r["sourceArtifact"]});
    assert!(!public
        .to_string()
        .contains("SYNTHETIC_OLD_REVIEW_SECRET_DO_NOT_SEND"));
    assert!(r["task"].get("requirement").is_none());
    assert!(r["sourceArtifact"].get("semantic_batches").is_none());
    assert_eq!(r["task"]["origin"], "SOURCE_FACT");
    assert_eq!(r["task"]["cq_coverage_proof"], false);
    assert_eq!(r["new_api_calls"], 0);
}
#[test]
fn no_partial_review_returns_no_gap_without_cq_formalization() {
    let r = source_support_gap::execute("prepare", &fixture(false)).unwrap();
    assert_eq!(r["status"], "NO_GAP");
    assert!(r["task"].is_null());
    assert_eq!(
        r["sourceArtifact"]["p2Build"]["graph"]["candidate_archive"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
}
#[test]
fn source_snapshot_proposal_and_gate_drift_fail_closed() {
    for mode in 0..5 {
        let mut p = fixture(true);
        match mode {
            0 => p["source"]["content"] = json!("changed"),
            1 => p["artifact"]["snapshot"]["source_epoch"] = json!(999),
            2 => p["artifact"]["all_proposal_candidates"][0]["description"] = json!("changed"),
            3 => {
                p["artifact"]["semantic_batches"][0]["result"]["gate_result"]
                    ["quarantined"] = json!([])
            }
            _ => {
                p["artifact"]["all_proposal_candidates"]
                    .as_array_mut()
                    .unwrap()
                    .pop();
            }
        }
        assert!(source_support_gap::execute("prepare", &p).is_err());
    }
}
#[test]
fn task_query_and_original_condition_hashes_are_verified_in_rust() {
    let r = source_support_gap::execute("prepare", &fixture(true)).unwrap();
    for mode in 0..5 {
        let mut p = json!({"contract_version":source_support_gap::VERSION,"task":r["task"],"source_artifact":r["sourceArtifact"]});
        match mode {
            0 => p["task"]["qualifiers"]["negated"] = json!(false),
            1 => p["task"]["conditions"] = json!([]),
            2 => p["task"]["source_support_query"] = json!("changed"),
            3 => p["task"]["old_review"] = json!({"decision":"SUPPORTED"}),
            _ => p["task"]["candidate_bindings"][0]["candidate_sha256"] = json!("bad"),
        };
        assert!(source_support_gap::execute("validate", &p).is_err());
    }
    assert_eq!(source_support_gap::execute("validate",&json!({"contract_version":source_support_gap::VERSION,"task":r["task"],"source_artifact":r["sourceArtifact"]})).unwrap()["validated"],true);
}
#[test]
fn query_is_deterministic_original_semantics_not_a_positive_repair_instruction() {
    let p = fixture(true);
    let a = source_support_gap::execute("prepare", &p).unwrap();
    let b = source_support_gap::execute("prepare", &p).unwrap();
    assert_eq!(a["task"], b["task"]);
    let query: Value =
        serde_json::from_str(a["task"]["source_support_query"].as_str().unwrap()).unwrap();
    assert_eq!(query["origin"], "SOURCE_FACT");
    assert_eq!(query["source_fact"]["qualifiers"], a["task"]["qualifiers"]);
    assert_eq!(query["source_fact"]["conditions"], a["task"]["conditions"]);
    assert!(a["task"]["description"]
        .as_str()
        .unwrap()
        .contains("Contradicted, partial and unknown outcomes are allowed"));
}
