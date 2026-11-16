//! Original synthetic source-first checks; no model, evaluation corpus or gold.
use lightog_core::{
    evidence_routing::{execute, VERSION},
    hybrid_retrieval,
};
use lightog_demand::wire;
use serde_json::{json, Value};
fn fragment(id: &str, text: &str, start: usize, end: usize, hash: &str) -> Value {
    let units: Vec<u16> = text.encode_utf16().collect();
    json!({"id":id,"origin":"SOURCE_FRAGMENT","source_ref":"route_source","source_revision":"r1","block_ref":"whole","text_sha256":hash,"span":{"start":start,"end":end,"quote":String::from_utf16(&units[start..end]).unwrap(),"offset_unit":"utf16_code_unit"},"claim_refs":[],"role":"PRIMARY"})
}
fn record(id: &str, kind: &str, text: &str, evidence: Vec<&str>) -> Value {
    json!({"id":id,"kind":kind,"text":text,"entity_refs":[],"evidence_ids":evidence,"status":if kind=="DOCUMENT"{"SOURCE"}else{"DISCOVERY_HINT"},"profile":null,"embedding":null})
}
fn fixture(
    text: &str,
    spans: Vec<(&str, usize, usize)>,
    docs: Vec<&str>,
    graph: Vec<Value>,
    edges: Vec<Value>,
    query: &str,
    budget: usize,
) -> Value {
    let hash = wire::text_sha(text);
    let length = text.encode_utf16().count();
    let snapshot = json!({"base_ref":"routing_synthetic","source_epoch":0,"graph_revision":null,"sources":[{"source_ref":"route_source","source_revision":"r1","original_sha256":hash,"text_sha256":hash,"parser_version":"synthetic/1"}]});
    let fragments: Vec<_> = spans
        .into_iter()
        .map(|(id, start, end)| fragment(id, text, start, end, &hash))
        .collect();
    let es = json!({"contract_version":"lightog-demand/0.1","evidence_set_id":"routing_es","snapshot":snapshot,"fragments":fragments});
    let context = json!({"examples":{"es":es},"source_texts":[{"source_ref":"route_source","source_revision":"r1","text":text,"original_sha256":hash,"parser_version":"synthetic/1","blocks":[{"block_ref":"whole","start":0,"end":length}]}],"authority":{"requests":[],"allowed_snapshots":[snapshot],"claims":[],"receipts":[],"scope_bindings":[],"entities":[],"predicate_refs":[],"user_definitions":[],"groups":[],"entity_links":[]}});
    let mut options = hybrid_retrieval::execute("defaults", &json!({})).unwrap();
    options["max_context_utf16"] = json!(budget);
    let doc_records: Vec<_> = docs
        .iter()
        .map(|id| {
            let f = fragments.iter().find(|f| f["id"] == *id).unwrap();
            record(
                &format!("doc_{id}"),
                "DOCUMENT",
                f["span"]["quote"].as_str().unwrap(),
                vec![id],
            )
        })
        .collect();
    let base = json!({"contract_version":hybrid_retrieval::VERSION,"question":query,"queries":{"document":query,"entity":query,"relation":query},"snapshot":snapshot,"trusted_index":{"records":doc_records,"edges":[],"manifests":[],"context":context,"evidence_token_counts":{},"tokenizer":null},"query_vectors":[],"rerank":null,"options":options});
    let mut graph_request = base.clone();
    graph_request["trusted_index"]["records"] = json!(graph);
    graph_request["trusted_index"]["edges"] = json!(edges);
    json!({"contract_version":VERSION,"document_request":base,"graph_request":graph_request,"policy":{"max_context_utf16":budget}})
}
#[test]
fn keeps_document_result_exactly_and_links_contained_source_evidence() {
    let p = fixture(
        "signal alpha notes.",
        vec![("coarse", 0, 19), ("fine", 7, 12)],
        vec!["coarse"],
        vec![record("p", "ENTITY", "signal", vec!["fine"])],
        vec![],
        "signal",
        32,
    );
    let out = execute("compose", &p).unwrap();
    assert_eq!(out["contexts"], out["document_result"]["contexts"]);
    assert_eq!(out["records"][0]["routing_reason"], "COVERED_LINK");
    assert_eq!(
        out["coverage_links"][0]["coverage"][0]["covered_span"]["quote"],
        "alpha"
    );
    assert_eq!(out["trace"]["base_sequence_preserved"], true);
    assert_eq!(out["trace"]["added_graph_utf16"], 0);
    assert_eq!(
        out["document_result"],
        hybrid_retrieval::execute("search", &p["document_request"]).unwrap()
    );
    assert_eq!(
        out["graph_result"],
        hybrid_retrieval::execute("search", &p["graph_request"]).unwrap()
    );
}
#[test]
fn same_quote_at_another_source_interval_is_not_treated_as_covered() {
    let p = fixture(
        "signal x signal x",
        vec![("coarse", 0, 8), ("other", 9, 17)],
        vec!["coarse"],
        vec![record("p", "ENTITY", "signal", vec!["other"])],
        vec![],
        "signal",
        32,
    );
    let out = execute("compose", &p).unwrap();
    assert_eq!(out["contexts"].as_array().unwrap().len(), 2);
    assert_eq!(out["trace"]["added_graph_utf16"], 8);
    assert_eq!(out["records"][0]["routing_reason"], "ADDED_WHOLE_GROUP");
}
#[test]
fn coverage_can_use_gap_free_union_of_multiple_original_contexts() {
    let p = fixture(
        "signalA signalB trailing",
        vec![("left", 0, 8), ("right", 8, 16), ("whole", 0, 16)],
        vec!["left", "right"],
        vec![record("p", "RELATION", "signalA signalB", vec!["whole"])],
        vec![],
        "signalA signalB",
        32,
    );
    let out = execute("compose", &p).unwrap();
    assert_eq!(out["contexts"], out["document_result"]["contexts"]);
    assert_eq!(
        out["coverage_links"][0]["coverage"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(out["trace"]["added_graph_utf16"], 0);
}
#[test]
fn unicode_coverage_uses_exact_utf16_and_preserves_surrogate_pairs() {
    let p = fixture(
        "signal😀 next",
        vec![("coarse", 0, 13), ("emoji", 6, 8)],
        vec!["coarse"],
        vec![record("p", "ENTITY", "signal", vec!["emoji"])],
        vec![],
        "signal",
        32,
    );
    let out = execute("compose", &p).unwrap();
    let piece = &out["coverage_links"][0]["coverage"][0];
    assert_eq!(piece["covered_span"]["quote"], "😀");
    assert_eq!(
        piece["covering_context_relative_span"],
        json!({"start":6,"end":8,"offset_unit":"utf16_code_unit"})
    );
}
fn grouped(budget: usize) -> Value {
    let text = "signal base padding...........TARGETCOND!NAV!!";
    fixture(
        text,
        vec![
            ("base", 0, 30),
            ("seed", 0, 6),
            ("target", 30, 36),
            ("condition", 36, 41),
            ("navigation", 41, 46),
        ],
        vec!["base"],
        vec![
            record("seed", "ENTITY", "signal", vec!["seed"]),
            record("neighbor", "RELATION", "quiet", vec!["target", "condition"]),
        ],
        vec![
            json!({"id":"edge","source_record_id":"seed","target_record_id":"neighbor","evidence_ids":["navigation"],"status":"DISCOVERY_HINT"}),
        ],
        "signal",
        budget,
    )
}
#[test]
fn navigation_and_condition_dependencies_are_committed_as_a_complete_group() {
    let out = execute("compose", &grouped(64)).unwrap();
    let neighbor = out["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["record_id"] == "neighbor")
        .unwrap();
    assert_eq!(
        neighbor["evidence_ids"],
        json!(["condition", "navigation", "target"])
    );
    assert_eq!(neighbor["navigation_evidence_ids"], json!(["navigation"]));
    assert_eq!(out["trace"]["added_graph_utf16"], 16);
    assert_eq!(
        out["coverage_links"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|l| l["graph_record_id"] == "neighbor")
            .count(),
        3
    );
}
#[test]
fn insufficient_combined_budget_defers_entire_graph_group_without_partial_links() {
    let out = execute("compose", &grouped(40)).unwrap();
    assert_eq!(out["contexts"], out["document_result"]["contexts"]);
    assert_eq!(out["deferred"][0]["record_id"], "neighbor");
    assert_eq!(out["deferred"][0]["reason"], "DEFERRED_WHOLE_GROUP");
    assert_eq!(out["trace"]["added_graph_utf16"], 0);
    assert!(out["coverage_links"]
        .as_array()
        .unwrap()
        .iter()
        .all(|l| l["graph_record_id"] != "neighbor"));
}
#[test]
fn incompatible_snapshot_queries_options_and_token_budget_are_rejected() {
    let p = grouped(64);
    for key in ["question", "queries", "snapshot", "options"] {
        let mut bad = p.clone();
        bad["graph_request"][key] = json!({"changed":true});
        assert_eq!(
            execute("compose", &bad).unwrap_err().code,
            "ROUTING_REQUEST_MISMATCH"
        );
    }
    let mut token = p.clone();
    token["document_request"]["options"]["max_context_tokens"] = json!(20);
    token["graph_request"]["options"]["max_context_tokens"] = json!(20);
    assert_eq!(
        execute("compose", &token).unwrap_err().code,
        "ROUTING_TOKEN_BUDGET_UNSUPPORTED"
    );
    let mut policy = p.clone();
    policy["policy"]["max_context_utf16"] = json!(63);
    assert_eq!(
        execute("compose", &policy).unwrap_err().code,
        "ROUTING_BUDGET_MISMATCH"
    );
}
#[test]
fn alias_links_keep_each_original_dependency_even_when_the_anchor_is_identical() {
    let p = fixture(
        "signal alpha notes.",
        vec![("coarse", 0, 19), ("alias_a", 7, 12), ("alias_b", 7, 12)],
        vec!["coarse"],
        vec![record(
            "p",
            "RELATION",
            "signal",
            vec!["alias_a", "alias_b"],
        )],
        vec![],
        "signal",
        32,
    );
    let out = execute("compose", &p).unwrap();
    let links = out["coverage_links"].as_array().unwrap();
    assert_eq!(links.len(), 2);
    assert_eq!(links[0]["requested_evidence_id"], "alias_a");
    assert_eq!(links[1]["requested_evidence_id"], "alias_b");
    assert_eq!(links[1]["canonical_graph_evidence_id"], "alias_a");
    assert_eq!(links[1]["requested_evidence"]["id"], "alias_b");
    assert_eq!(out["contexts"], out["document_result"]["contexts"]);
}
#[test]
fn a_gap_in_existing_intervals_requires_the_whole_requested_fragment() {
    let p = fixture(
        "signalA XsignalB ending",
        vec![("left", 0, 8), ("right", 9, 17), ("whole", 0, 17)],
        vec!["left", "right"],
        vec![record("p", "RELATION", "signalA signalB", vec!["whole"])],
        vec![],
        "signalA signalB",
        40,
    );
    let out = execute("compose", &p).unwrap();
    assert_eq!(out["trace"]["base_document_utf16"], 16);
    assert_eq!(out["trace"]["added_graph_utf16"], 17);
    assert_eq!(out["contexts"][2]["span"]["quote"], "signalA XsignalB ");
}
