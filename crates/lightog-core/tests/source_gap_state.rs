use lightog_core::source_gap_state;
// Original SYNTHETIC source/review judgments. Real Rust kernels, no provider/IO/gold.
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

fn initialized() -> Value {
    let f = fixture(true);
    let ready = source_support_gap::execute("prepare", &f).unwrap();
    source_gap_state::execute("init",&json!({"baseline_artifact":f["artifact"],"source":f["source"],"cq_seeds":f["cq_seeds"],"source_artifact":ready["sourceArtifact"],"task":ready["task"],"context":f["artifact"]["context"],"prepared":f["artifact"]["semantic_batches"][0]["result"]["gate_input"]["prepared"],"session_id":"original_synthetic_state","mode":"LEXICAL","origin":"SYNTHETIC","evaluation_label_set_sha256":null,"evaluation_started_at":"2030-01-01T00:00:00Z","max_calls":2})).unwrap()
}
fn start(st: &Value, review: bool) -> Value {
    source_gap_state::execute("start",&json!({"state":st,"request":{"kind":if review{"SEMANTIC_REVIEW"}else{"GAP_EXTRACT"},"messages":[{"role":"system","content":"Original synthetic instructions"},{"role":"user","content":"Synthetic source only"}],"max_tokens":if review{8000}else{6000},"enable_thinking":false}})).unwrap()["state"].clone()
}
fn candidate(st: &Value) -> Value {
    let mut c = st["baseline"]["all_proposal_candidates"][0].clone();
    c["candidate_id"] = json!("c_new_state");
    c
}
fn proposal(st: &Value) -> Value {
    let c = candidate(st);
    let raw = json!({"entities":[{"local_id":"Birch<T>","surface":"Birch","type_label":"Example","mention_evidence_id":"e_authored"}],"candidates":[{"kind":c["kind"],"subject_local_id":"Birch<T>","predicate":c["predicate"]["proposed_definition"],"object":c["object"],"direction":c["direction"],"description":c["description"],"keywords":c["keywords"],"qualifiers":c["qualifiers"],"conditions":[{"text":"Europe AND example scope","evidence_ids":["e_authored"]}],"support_evidence_ids":["e_authored"]}]});
    json!({"request_id":st["pending_request"]["request_id"],"content":format!("```json\n{}\n```",raw),"actual_call":false,"model":"synthetic-state","config_revision":1,"finish_reason":"stop"})
}
fn proposed() -> Value {
    let st = start(&initialized(), false);
    let r = proposal(&st);
    source_gap_state::execute("proposal", &json!({"state":st,"response":r})).unwrap()
}
fn review(st: &Value, decision: &str) -> Value {
    let mut dims = serde_json::Map::new();
    for d in semantic_review::DIMENSIONS {
        dims.insert(d.into(),json!({"decision":decision,"reason":"Authored synthetic review only","evidence_ids":["e_authored"]}));
    }
    let r = json!({"reviews":[{"candidate_id":st["new_candidates"][0]["candidate_id"],"decision":decision,"dimensions":dims}]});
    json!({"request_id":st["pending_request"]["request_id"],"content":r.to_string(),"actual_call":false,"model":"synthetic-state","config_revision":1,"finish_reason":"stop"})
}
#[test]
fn request_is_committed_before_io_and_cannot_be_reissued() {
    let st = initialized();
    let pending = start(&st, false);
    assert_eq!(pending["attempts"], 1);
    assert_eq!(pending["requests"][0]["status"], "STARTED");
    assert!(source_gap_state::execute("start", &json!({"state":pending,"request":{}})).is_err());
}
#[test]
fn unknown_stops_without_adding_or_promoting_parent() {
    let st = start(&initialized(), false);
    let stopped = source_gap_state::execute(
        "stop",
        &json!({"state":st,"code":"TRANSPORT_UNKNOWN","unknown_outcome":true}),
    )
    .unwrap();
    assert_eq!(stopped["unknown_outcome"], true);
    let out = source_gap_state::execute("artifact", &json!({"state":stopped})).unwrap();
    assert_eq!(out["p2Build"], stopped["baseline"]["p2Build"]);
    assert_eq!(
        out["all_proposal_candidates"],
        stopped["baseline"]["all_proposal_candidates"]
    );
}
#[test]
fn proposals_do_not_enter_graph_before_review() {
    let st = proposed();
    assert_eq!(st["phase"], "READY_REVIEW");
    assert!(st["new_eligible"].as_array().unwrap().is_empty());
    assert!(source_gap_state::execute("artifact", &json!({"state":st})).is_err());
}
#[test]
fn supported_new_candidate_merges_only_after_bound_review() {
    let st = start(&proposed(), true);
    let r = review(&st, "SUPPORTED");
    let complete = source_gap_state::execute("review", &json!({"state":st,"response":r})).unwrap();
    assert_eq!(complete["phase"], "COMPLETED");
    let out = source_gap_state::execute("artifact", &json!({"state":complete})).unwrap();
    assert_eq!(
        out["p2Build"]["graph"]["candidate_archive"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(out["all_proposal_candidates"].as_array().unwrap().len(), 4);
    let parent = &complete["task"]["candidate_ids"][0];
    assert!(!out["p2Build"]["graph"]["candidate_archive"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["candidate_id"] == *parent));
    assert_eq!(
        &out["all_proposal_candidates"].as_array().unwrap()[..3],
        complete["baseline"]["all_proposal_candidates"]
            .as_array()
            .unwrap()
            .as_slice()
    );
}
#[test]
fn partial_review_never_removes_old_active_facts() {
    let st = start(&proposed(), true);
    let complete = source_gap_state::execute(
        "review",
        &json!({"state":st,"response":review(&st,"PARTIAL")}),
    )
    .unwrap();
    let out = source_gap_state::execute("artifact", &json!({"state":complete})).unwrap();
    assert_eq!(out["p2Build"], complete["baseline"]["p2Build"]);
    assert_eq!(out["all_proposal_candidates"].as_array().unwrap().len(), 4);
}
#[test]
fn invalid_raw_and_duplicate_keys_stop_without_eligible_facts() {
    for content in [
        "{\"x\":1,\"x\":2}",
        "{\"entities\":[],\"candidates\":false}",
    ] {
        let st = start(&initialized(), false);
        let mut r = proposal(&st);
        r["content"] = json!(content);
        let stopped =
            source_gap_state::execute("proposal", &json!({"state":st,"response":r})).unwrap();
        assert_eq!(stopped["phase"], "STOPPED_NO_RETRY");
        assert!(stopped["new_eligible"].as_array().unwrap().is_empty());
    }
}
#[test]
fn exact_completed_response_replay_is_idempotent_but_changed_response_fails() {
    let st = start(&initialized(), false);
    let r = proposal(&st);
    let done = source_gap_state::execute("proposal", &json!({"state":st,"response":r})).unwrap();
    let replay =
        source_gap_state::execute("proposal", &json!({"state":done,"response":r})).unwrap();
    assert_eq!(done, replay);
    let mut changed = r;
    changed["model"] = json!("another");
    assert!(
        source_gap_state::execute("proposal", &json!({"state":done,"response":changed})).is_err()
    );
}
#[test]
fn tampered_serialized_state_and_wrong_review_model_are_rejected() {
    let mut st = initialized();
    st["attempts"] = json!(0);
    st["mode"] = json!("HYBRID");
    assert!(source_gap_state::execute(
        "stop",
        &json!({"state":st,"code":"STOP","unknown_outcome":false})
    )
    .is_err());
    let st = start(&proposed(), true);
    let mut r = review(&st, "SUPPORTED");
    r["model"] = json!("drifted");
    let out = source_gap_state::execute("review", &json!({"state":st,"response":r})).unwrap();
    assert_eq!(out["phase"], "STOPPED_NO_RETRY");
    assert_eq!(out["error_code"], "GAP_MODEL_DRIFT");
}
