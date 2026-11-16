//! P3 deterministic algorithm checks with original synthetic inputs, no model quality claims.
use lightog_core::hybrid_retrieval::{execute, VERSION};
use lightog_demand::wire;
use serde_json::{json, Value};
fn load(s: &str) -> Value {
    serde_json::from_str(s).unwrap()
}
fn base() -> Value {
    let es = load(include_str!(
        "../../../contracts/demand-v0.1/examples/evidence-set.json"
    ));
    let sources = load(include_str!(
        "../../../fixtures/demand-contract-v0.1/source-texts.json"
    ));
    let auth = load(include_str!(
        "../../../fixtures/demand-contract-v0.1/validation-context.json"
    ));
    json!({"contract_version":VERSION,"question":"丁云在哪里提供服务？","queries":{"document":"丁云 服务","entity":"丁云","relation":"服务 地区"},"snapshot":es["snapshot"],"trusted_index":{"records":[rec("doc","DOCUMENT",es["fragments"][1]["span"]["quote"].as_str().unwrap(),"e_new"),rec("cloud","ENTITY","丁云","e_new"),rec("service","RELATION","丁云 服务 地区 欧洲","e_new")],"edges":[],"manifests":[],"context":{"examples":{"e":es},"source_texts":sources["sources"],"authority":auth},"evidence_token_counts":{},"tokenizer":null},"query_vectors":[],"rerank":null,"options":execute("defaults",&json!({})).unwrap()})
}
fn rec(id: &str, kind: &str, text: &str, eid: &str) -> Value {
    json!({"id":id,"kind":kind,"text":text,"entity_refs":[],"evidence_ids":[eid],"status":if kind=="DOCUMENT"{"SOURCE"}else{"DISCOVERY_HINT"},"profile":null,"embedding":null})
}
fn dense(
    p: &mut Value,
    record: usize,
    index_id: &str,
    component: &str,
    model: &str,
    values: Value,
) {
    let space = json!({"provider":"synthetic-test","model":model,"model_revision":"frozen/1","dimensions":2,"normalization":"NONE","distance":"COSINE","text_policy":"raw/1","tokenizer_version":"fixture/1"});
    let m = json!({"contract_version":"lightog-knowledge/0.2","index_id":index_id,"index_revision":"v1","component":component,"snapshot":p["snapshot"],"vector_space":space,"status":"ACTIVE","records_total":1,"vectors_completed":1,"build_receipt_ref":format!("build_{index_id}")});
    let receipt = json!({"receipt_ref":m["build_receipt_ref"],"kind":"INDEX_BUILD","status":"COMPLETE","index_id":index_id,"index_revision":"v1","component":component,"snapshot_sha256":wire::sha(&p["snapshot"]).unwrap(),"vector_space_sha256":wire::sha(&space).unwrap(),"records_total":1,"vectors_completed":1});
    p["trusted_index"]["context"]["authority"]["receipts"]
        .as_array_mut()
        .unwrap()
        .push(receipt);
    if !p["trusted_index"]["context"]["authority"]["active_indexes"].is_array() {
        p["trusted_index"]["context"]["authority"]["active_indexes"] = json!([]);
    }
    p["trusted_index"]["context"]["authority"]["active_indexes"]
        .as_array_mut()
        .unwrap()
        .push(m.clone());
    p["trusted_index"]["manifests"]
        .as_array_mut()
        .unwrap()
        .push(m);
    let text = p["trusted_index"]["records"][record]["text"]
        .as_str()
        .unwrap()
        .to_owned();
    p["trusted_index"]["records"][record]["embedding"] =
        json!({"index_id":index_id,"values":values,"text_sha256":wire::text_sha(&text)});
    let q = match component {
        "CHUNK" => "document",
        "ENTITY" => "entity",
        _ => "relation",
    };
    let query_hash = wire::text_sha(p["queries"][q].as_str().unwrap());
    p["query_vectors"].as_array_mut().unwrap().push(json!({"component":component,"index_id":index_id,"vector_space":space,"query_text_sha256":query_hash,"values":[1.0,0.0]}));
}
#[test]
fn lexical_returns_raw_evidence_not_a_fake_embedding_result() {
    let p = base();
    let out = execute("search", &p).unwrap();
    assert_eq!(out["trace"]["embedding_status"], "NOT_CONFIGURED");
    assert_eq!(out["contexts"].as_array().unwrap().len(), 1);
    assert_eq!(out["contexts"][0]["id"], "e_new");
    assert!(out["records"].as_array().unwrap().len() > 1);
    assert_eq!(out["trace"]["context_tokens"], Value::Null);
}
#[test]
fn exact_cosine_works_with_host_vectors_and_does_not_require_lexical_overlap() {
    let mut p = base();
    p["queries"]["document"] = json!("xyz");
    p["queries"]["entity"] = json!("");
    p["queries"]["relation"] = json!("");
    dense(&mut p, 0, "idx_doc", "CHUNK", "m1", json!([1.0, 0.0]));
    let out = execute("search", &p).unwrap();
    assert_eq!(out["records"][0]["record_id"], "doc");
    assert_eq!(out["trace"]["embedding_status"], "HOST_VECTORS_CONSUMED");
    assert_eq!(out["trace"]["model_calls_performed"], 0);
}
#[test]
fn dimension_zero_vectors_and_stale_embedded_text_are_rejected() {
    for value in [json!([0.0, 0.0]), json!([1.0])] {
        let mut p = base();
        dense(&mut p, 0, "idx_doc", "CHUNK", "m1", value);
        assert_eq!(execute("search", &p).unwrap_err().code, "P3_VECTOR_INVALID");
    }
    let mut p = base();
    dense(&mut p, 0, "idx_doc", "CHUNK", "m1", json!([1.0, 0.0]));
    p["trusted_index"]["records"][0]["embedding"]["text_sha256"] = json!("0".repeat(64));
    assert_eq!(
        execute("search", &p).unwrap_err().code,
        "P3_EMBEDDED_TEXT_MISMATCH"
    );
}
#[test]
fn different_spaces_are_allowed_only_with_separate_matching_query_vectors() {
    let mut p = base();
    dense(&mut p, 0, "idx_doc", "CHUNK", "m1", json!([1.0, 0.0]));
    dense(&mut p, 1, "idx_entity", "ENTITY", "m2", json!([1.0, 0.0]));
    execute("search", &p).unwrap();
    p["query_vectors"][1]["vector_space"]["model"] = json!("m1");
    assert_eq!(
        execute("search", &p).unwrap_err().code,
        "P3_QUERY_SPACE_MISMATCH"
    );
}
#[test]
fn query_vector_is_bound_to_exact_channel_text() {
    let mut p = base();
    dense(&mut p, 0, "idx_doc", "CHUNK", "m1", json!([1.0, 0.0]));
    p["queries"]["document"] = json!("different query");
    assert_eq!(
        execute("search", &p).unwrap_err().code,
        "P3_QUERY_TEXT_MISMATCH"
    );
}
#[test]
fn stale_or_unresolved_record_evidence_is_excluded_with_trace() {
    let mut p = base();
    p["trusted_index"]["records"][0]["evidence_ids"] = json!(["old_version_evidence"]);
    let out = execute("search", &p).unwrap();
    assert_eq!(
        out["excluded"][0]["reason"],
        "EVIDENCE_NOT_IN_CURRENT_SNAPSHOT"
    );
    assert!(out["records"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["record_id"] != "doc"));
}
#[test]
fn revoked_snapshot_cannot_be_searched() {
    let mut p = base();
    p["trusted_index"]["context"]["authority"]["allowed_snapshots"] = json!([]);
    assert_eq!(
        execute("search", &p).unwrap_err().code,
        "SOURCE_SNAPSHOT_MISMATCH"
    );
}
#[test]
fn document_index_cannot_invent_or_normalize_original_text() {
    let mut p = base();
    p["trusted_index"]["records"][0]["text"] = json!("丁云在所有地区均提供服务");
    assert_eq!(
        execute("search", &p).unwrap_err().code,
        "P3_DOCUMENT_TEXT_MISMATCH"
    );
}
#[test]
fn discovery_hint_cannot_be_promoted_to_published_by_label() {
    let mut p = base();
    p["trusted_index"]["records"][1]["status"] = json!("PUBLISHED");
    assert_eq!(
        execute("search", &p).unwrap_err().code,
        "P3_PUBLICATION_UNVERIFIED"
    );
}
#[test]
fn graph_expansion_is_one_hop_from_fixed_initial_seed_only() {
    let mut p = base();
    p["trusted_index"]["records"] = json!([
        rec("a", "ENTITY", "seed", "e_new"),
        rec("b", "ENTITY", "unrelated", "e_new"),
        rec("c", "ENTITY", "also unrelated", "e_new")
    ]);
    p["queries"] = json!({"document":"seed","entity":"seed","relation":"seed"});
    p["trusted_index"]["edges"] = json!([{"id":"ab","source_record_id":"a","target_record_id":"b","evidence_ids":["e_new"],"status":"DISCOVERY_HINT"},{"id":"bc","source_record_id":"b","target_record_id":"c","evidence_ids":["e_new"],"status":"DISCOVERY_HINT"}]);
    let out = execute("search", &p).unwrap();
    assert_eq!(out["trace"]["expanded_record_ids"], json!(["b"]));
    assert_eq!(out["records"].as_array().unwrap().len(), 2);
}
#[test]
fn whole_evidence_is_deferred_when_budget_cannot_preserve_it() {
    let mut p = base();
    p["options"]["max_context_utf16"] = json!(2);
    let out = execute("search", &p).unwrap();
    assert!(out["contexts"].as_array().unwrap().is_empty());
    assert!(!out["deferred"].as_array().unwrap().is_empty());
}
#[test]
fn token_budget_requires_real_host_counts_and_tokenizer() {
    let mut p = base();
    p["options"]["max_context_tokens"] = json!(10);
    assert_eq!(
        execute("search", &p).unwrap_err().code,
        "P3_TOKENIZER_REQUIRED"
    );
    p["trusted_index"]["tokenizer"] = json!("host-tokenizer/1");
    assert_eq!(
        execute("search", &p).unwrap_err().code,
        "P3_TOKEN_COUNT_MISSING"
    );
    let quote = p["trusted_index"]["context"]["examples"]["e"]["fragments"][1]["span"]["quote"]
        .as_str()
        .unwrap();
    p["trusted_index"]["evidence_token_counts"] = json!({"e_new":{"tokens":11,"quote_sha256":wire::text_sha(quote),"tokenizer":"host-tokenizer/1"}});
    let out = execute("search", &p).unwrap();
    assert!(out["contexts"].as_array().unwrap().is_empty());
    p["trusted_index"]["evidence_token_counts"]["e_new"]["tokens"] = json!(10);
    assert_eq!(
        execute("search", &p).unwrap()["trace"]["context_tokens"],
        10
    );
}
#[test]
fn rerank_consumes_complete_host_scores_for_exact_candidate_set() {
    let mut p = base();
    let out = execute("search", &p).unwrap();
    let ids = out["trace"]["pre_rerank_candidate_ids"].as_array().unwrap();
    p["rerank"] = json!({"status":"COMPLETE","model":"test-reranker","candidate_set_sha256":out["trace"]["candidate_set_sha256"],"scores":ids.iter().enumerate().map(|(i,id)|json!({"record_id":id,"score":i as f64})).collect::<Vec<_>>()});
    let result = execute("search", &p).unwrap();
    assert_eq!(result["trace"]["rerank_status"], "HOST_SCORES_CONSUMED");
    assert_eq!(
        result["records"][0]["record_id"],
        ids.last().unwrap().clone()
    );
    p["rerank"]["scores"] = json!([]);
    assert_eq!(
        execute("search", &p).unwrap_err().code,
        "P3_RERANK_INCOMPLETE"
    );
}
#[test]
fn failed_reranker_is_explicit_and_preserves_rrf_order() {
    let mut p = base();
    let out = execute("search", &p).unwrap();
    p["rerank"] = json!({"status":"FAILED","model":"test-reranker","candidate_set_sha256":out["trace"]["candidate_set_sha256"],"scores":[]});
    let fallback = execute("search", &p).unwrap();
    assert_eq!(out["records"], fallback["records"]);
    assert_eq!(fallback["trace"]["rerank_status"], "FAILED_FALLBACK_RRF");
}
#[test]
fn deterministic_ties_and_anchor_dedup_keep_all_provenance_aliases() {
    let p = base();
    let first = execute("search", &p).unwrap();
    let second = execute("search", &p).unwrap();
    assert_eq!(first, second);
    assert_eq!(first["contexts"].as_array().unwrap().len(), 1);
    assert_eq!(first["evidence_aliases"]["e_new"], "e_new");
    assert_eq!(
        first["evidence_provenance"]["e_new"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn unknown_fields_and_resource_bounds_are_not_ignored() {
    let mut p = base();
    p["bypass_validation"] = json!(true);
    assert_eq!(
        execute("search", &p).unwrap_err().code,
        "P3_REQUEST_INVALID"
    );
    let mut p = base();
    p["options"]["max_graph_neighbors"] = json!(999);
    assert_eq!(
        execute("search", &p).unwrap_err().code,
        "P3_OPTIONS_INVALID"
    );
}
#[test]
fn published_graph_edge_needs_published_evidence() {
    let mut p = base();
    p["trusted_index"]["edges"] = json!([{"id":"fake","source_record_id":"cloud","target_record_id":"service","evidence_ids":["e_new"],"status":"PUBLISHED"}]);
    assert_eq!(
        execute("search", &p).unwrap_err().code,
        "P3_PUBLICATION_UNVERIFIED"
    );
}
#[test]
fn exact_index_input_must_match_receipted_full_record_count() {
    let mut p = base();
    dense(&mut p, 0, "idx_doc", "CHUNK", "m1", json!([1.0, 0.0]));
    p["trusted_index"]["records"][0]["embedding"] = Value::Null;
    assert_eq!(
        execute("search", &p).unwrap_err().code,
        "P3_INDEX_CONTENT_INCOMPLETE"
    );
}
#[test]
fn configured_index_without_query_vector_reports_lexical_degradation() {
    let mut p = base();
    dense(&mut p, 0, "idx_doc", "CHUNK", "m1", json!([1.0, 0.0]));
    p["query_vectors"] = json!([]);
    let out = execute("search", &p).unwrap();
    assert_eq!(
        out["trace"]["embedding_status"],
        "CONFIGURED_QUERY_VECTOR_MISSING_LEXICAL_ONLY"
    );
    assert!(!out["contexts"].as_array().unwrap().is_empty());
}
#[test]
fn rerank_receipt_cannot_be_replayed_for_another_query_or_changed_record_text() {
    let mut p = base();
    let first = execute("search", &p).unwrap();
    let ids = first["trace"]["pre_rerank_candidate_ids"]
        .as_array()
        .unwrap();
    p["rerank"] = json!({"status":"COMPLETE","model":"test-reranker","candidate_set_sha256":first["trace"]["candidate_set_sha256"],"scores":ids.iter().map(|id|json!({"record_id":id,"score":1.0})).collect::<Vec<_>>()});
    execute("search", &p).unwrap();
    p["question"] = json!("另一个问题，但候选ID完全相同");
    assert_eq!(
        execute("search", &p).unwrap_err().code,
        "P3_RERANK_SET_MISMATCH"
    );
    p["question"] = base()["question"].clone();
    p["trusted_index"]["records"][2]["text"] = json!("丁云 服务 地区 欧洲 条件已改变");
    assert_eq!(
        execute("search", &p).unwrap_err().code,
        "P3_RERANK_SET_MISMATCH"
    );
}
#[test]
fn token_receipts_bind_exact_quote_and_tokenizer_and_reject_alias_conflict() {
    let mut p = base();
    p["options"]["max_context_tokens"] = json!(100);
    p["trusted_index"]["tokenizer"] = json!("tok/1");
    let quote = p["trusted_index"]["context"]["examples"]["e"]["fragments"][1]["span"]["quote"]
        .as_str()
        .unwrap();
    p["trusted_index"]["evidence_token_counts"] =
        json!({"e_new":{"tokens":10,"quote_sha256":wire::text_sha(quote),"tokenizer":"tok/1"}});
    execute("search", &p).unwrap();
    p["trusted_index"]["evidence_token_counts"]["e_new"]["tokenizer"] = json!("tok/old");
    assert_eq!(
        execute("search", &p).unwrap_err().code,
        "P3_TOKEN_RECEIPT_MISMATCH"
    );
    p["trusted_index"]["evidence_token_counts"]["e_new"]["tokenizer"] = json!("tok/1");
    p["trusted_index"]["evidence_token_counts"]["e_new"]["quote_sha256"] = json!("0".repeat(64));
    assert_eq!(
        execute("search", &p).unwrap_err().code,
        "P3_TOKEN_RECEIPT_MISMATCH"
    );
    let mut p = base();
    p["options"]["max_context_tokens"] = json!(100);
    p["trusted_index"]["tokenizer"] = json!("tok/1");
    let mut alias = p["trusted_index"]["context"]["examples"]["e"]["fragments"][1].clone();
    alias["id"] = json!("e_alias");
    let quote_hash = wire::text_sha(alias["span"]["quote"].as_str().unwrap());
    p["trusted_index"]["context"]["examples"]["e"]["fragments"]
        .as_array_mut()
        .unwrap()
        .push(alias);
    p["trusted_index"]["records"]
        .as_array_mut()
        .unwrap()
        .push(rec("alias", "ENTITY", "丁云", "e_alias"));
    p["trusted_index"]["evidence_token_counts"] = json!({"e_new":{"tokens":10,"quote_sha256":quote_hash,"tokenizer":"tok/1"},"e_alias":{"tokens":11,"quote_sha256":quote_hash,"tokenizer":"tok/1"}});
    assert_eq!(
        execute("search", &p).unwrap_err().code,
        "P3_TOKEN_ALIAS_CONFLICT"
    );
}
#[test]
fn one_hop_navigation_evidence_is_retained_or_whole_neighbor_is_deferred() {
    let mut p = base();
    p["trusted_index"]["records"] = json!([
        rec("a", "ENTITY", "seed", "e_new"),
        rec("b", "ENTITY", "unrelated", "e_new")
    ]);
    p["queries"] = json!({"document":"seed","entity":"seed","relation":"seed"});
    p["trusted_index"]["edges"] = json!([{"id":"ab","source_record_id":"a","target_record_id":"b","evidence_ids":["e_cohort"],"status":"DISCOVERY_HINT"}]);
    let out = execute("search", &p).unwrap();
    assert_eq!(out["contexts"].as_array().unwrap().len(), 2);
    assert_eq!(
        out["records"][1]["navigation_evidence_ids"],
        json!(["e_cohort"])
    );
    assert!(out["records"][1]["evidence_ids"]
        .as_array()
        .unwrap()
        .contains(&json!("e_cohort")));
    p["options"]["max_context_utf16"] = json!(30);
    let out = execute("search", &p).unwrap();
    assert_eq!(out["records"].as_array().unwrap().len(), 1);
    assert_eq!(out["deferred"][0]["record_id"], "b");
}
