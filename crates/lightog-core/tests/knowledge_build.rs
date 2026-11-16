use lightog_core::knowledge_build::execute;
use serde_json::{json, Value};
fn load(s: &str) -> Value {
    serde_json::from_str(s).unwrap()
}
fn context() -> Value {
    let mut authority = load(include_str!(
        "../../../fixtures/demand-contract-v0.1/validation-context.json"
    ));
    authority["entities"]
        .as_array_mut()
        .unwrap()
        .push(json!("ent_d"));
    let sources = load(include_str!(
        "../../../fixtures/demand-contract-v0.1/source-texts.json"
    ));
    json!({"examples":{"e":load(include_str!("../../../contracts/demand-v0.1/examples/evidence-set.json")),"q":load(include_str!("../../../contracts/demand-v0.1/examples/seed.json"))},"source_texts":sources["sources"],"authority":authority})
}
fn candidate(id: &str) -> Value {
    let ctx = context();
    let mention = |local: &str, label: &str, start: usize, end: usize| json!({"local_id":local,"label":label,"entity_ref":null,"type_label":null,"mentions":[{"evidence_ref":"e_new","span":{"start":start,"end":end,"quote":label,"offset_unit":"utf16_code_unit"}}]});
    json!({"contract_version":"lightog-knowledge/0.2","candidate_id":id,"kind":"RELATION","snapshot":ctx["examples"]["e"]["snapshot"],"evidence_set_ref":"es_synthetic","evidence_ids":["e_new"],"entities":[mention("cloud","丁云",0,2),mention("region","欧洲",11,13)],"subject_local_id":"cloud","predicate":{"predicate_ref":null,"proposed_definition":{"label":"服务地区","description":"资料声明的服务地区","evidence_ids":["e_new"]}},"object":{"entity_local_id":"region","typed_value":null},"direction":"DIRECTED","description":"丁云在欧洲面向零售客户提供电话服务","keywords":["地区"],"qualifiers":{"scope":"面向零售客户","modality":"REPORTED","negated":false,"unit":null,"effective_time":null},"conditions":[{"id":"retail","text":"面向零售客户","evidence_ids":["e_new"],"support_status":"UNVERIFIED"}],"status":"CANDIDATE","semantic_status":"UNVERIFIED"})
}
fn build(candidates: Vec<Value>) -> Value {
    execute(
        "build",
        &json!({"candidates":candidates,"trusted_context":context()}),
    )
    .unwrap()
}
#[test]
fn new_relation_does_not_require_existing_schema_or_query_plan() {
    let out = build(vec![candidate("c1")]);
    assert_eq!(out["graph"]["statements"].as_array().unwrap().len(), 1);
    assert_eq!(out["graph"]["status"], "CANDIDATE_GRAPH");
    assert_eq!(out["publication_performed"], false);
    assert!(out["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["kind"] == "RELATION" && r["text"].as_str().unwrap().contains("零售客户")));
}
#[test]
fn same_anchor_and_semantics_aggregate_evidence_without_changing_status() {
    let out = build(vec![candidate("c1"), candidate("c2")]);
    assert_eq!(out["graph"]["entities"].as_array().unwrap().len(), 2);
    assert_eq!(out["graph"]["statements"].as_array().unwrap().len(), 1);
    assert_eq!(
        out["graph"]["statements"][0]["candidate_ids"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        out["graph"]["statements"][0]["semantic_status"],
        "UNVERIFIED"
    );
}
#[test]
fn condition_negation_plan_and_direction_are_distinct_semantics() {
    let c = candidate("c1");
    let mut variants = vec![c.clone()];
    for (i, key, value) in [
        ("c2", "negated", json!(true)),
        ("c3", "modality", json!("PLANNED")),
        ("c4", "scope", json!("其他范围")),
    ] {
        let mut v = c.clone();
        v["candidate_id"] = json!(i);
        v["qualifiers"][key] = value;
        variants.push(v);
    }
    let mut reversed = c.clone();
    reversed["candidate_id"] = json!("c5");
    reversed["subject_local_id"] = json!("region");
    reversed["object"]["entity_local_id"] = json!("cloud");
    variants.push(reversed);
    assert_eq!(
        build(variants)["graph"]["statements"]
            .as_array()
            .unwrap()
            .len(),
        5
    );
}
#[test]
fn entity_label_equality_never_confirms_cross_anchor_identity() {
    let mut c2 = candidate("c2");
    c2["entities"][0]["label"] = json!("欧洲");
    let out = build(vec![candidate("c1"), c2]);
    assert_eq!(out["graph"]["entities"].as_array().unwrap().len(), 2);
    assert!(out["graph"]["entities"]
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["identity_status"] == "PROVISIONAL_ANCHOR"));
}
#[test]
fn known_id_self_report_needs_trusted_mention_binding() {
    let mut c = candidate("c1");
    c["entities"][0]["entity_ref"] = json!("ent_d");
    assert_eq!(
        execute(
            "build",
            &json!({"candidates":[c],"trusted_context":context()})
        )
        .unwrap_err()
        .code,
        "BUILD_ENTITY_LINK_UNVERIFIED"
    );
}
#[test]
fn confirmed_links_have_stable_identity_and_receipts() {
    let mut raw = context();
    let mut c = candidate("c1");
    c["entities"][0]["entity_ref"] = json!("ent_d");
    let f = &raw["examples"]["e"]["fragments"][1];
    raw["authority"]["entity_links"] = json!([{"entity_ref":"ent_d","status":"CONFIRMED","base_ref":c["snapshot"]["base_ref"],"source_ref":f["source_ref"],"source_revision":f["source_revision"],"text_sha256":f["text_sha256"],"span":c["entities"][0]["mentions"][0]["span"],"receipt_ref":"identity_receipt"}]);
    let out = execute("build", &json!({"candidates":[c],"trusted_context":raw})).unwrap();
    assert!(out["graph"]["entities"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["identity_status"] == "CONFIRMED_LINK"));
}
#[test]
fn tampered_quote_and_withdrawn_sources_cannot_build() {
    let mut c = candidate("c1");
    c["entities"][0]["mentions"][0]["span"]["quote"] = json!("伪造");
    assert!(execute(
        "build",
        &json!({"candidates":[c],"trusted_context":context()})
    )
    .is_err());
    let mut raw = context();
    raw["authority"]["allowed_snapshots"] = json!([]);
    assert!(execute(
        "build",
        &json!({"candidates":[candidate("c1")],"trusted_context":raw})
    )
    .is_err());
}
#[test]
fn multi_party_pattern_keeps_roles_not_pairwise_clique() {
    let c = candidate("c1");
    let p = json!({"kind":"COMBINATION","label":"示意组合候选","roles":[{"candidate_id":"c1","entity_local_id":"cloud","role":"提供方"},{"candidate_id":"c1","entity_local_id":"region","role":"区域"}],"evidence_set_ref":"es_synthetic","evidence_ids":["e_new"],"qualifiers":{"scope":"资料自述","negated":false,"modality":"REPORTED","unit":null,"effective_time":null}});
    let out = execute(
        "build",
        &json!({"candidates":[c],"patterns":[p],"trusted_context":context()}),
    )
    .unwrap();
    assert_eq!(out["graph"]["patterns"].as_array().unwrap().len(), 1);
    assert_eq!(
        out["graph"]["patterns"][0]["roles"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(out["graph"]["statements"].as_array().unwrap().len(), 1);
}
#[test]
fn build_is_deterministic_under_candidate_permutation() {
    let a = candidate("c1");
    let mut b = candidate("c2");
    b["qualifiers"]["negated"] = json!(true);
    assert_eq!(build(vec![a.clone(), b.clone()]), build(vec![b, a]));
}
#[test]
fn merge_requires_exact_trusted_graph_and_cas_then_preserves_old_claims() {
    let old = build(vec![candidate("c1")])["graph"].clone();
    let mut c = candidate("c2");
    c["qualifiers"]["negated"] = json!(true);
    let delta = build(vec![c])["graph"].clone();
    let mut raw = context();
    raw["authority"]["candidate_graphs"] = json!([old, delta]);
    let mut p = json!({"previous":old,"delta":delta,"expected_graph_digest":old["graph_digest"],"trusted_context":raw});
    let out = execute("merge", &p).unwrap();
    assert_eq!(out["graph"]["statements"].as_array().unwrap().len(), 2);
    assert_eq!(out["requires_host_atomic_compare_and_swap"], true);
    p["expected_graph_digest"] = json!("wrong");
    assert_eq!(execute("merge", &p).unwrap_err().code, "BUILD_CAS_MISMATCH");
    p["trusted_context"]["authority"]["candidate_graphs"] = json!([]);
    assert_eq!(
        execute("merge", &p).unwrap_err().code,
        "BUILD_GRAPH_NOT_TRUSTED"
    );
}
#[test]
fn model_menu_retains_raw_evidence_but_does_not_call_model() {
    let out=execute("prepare_extract",&json!({"evidence_set_ref":"es_synthetic","cq_guidance":"服务地区是什么？","trusted_context":context()})).unwrap();
    assert_eq!(out["model_called"], false);
    assert_eq!(out["payload"]["evidence_menu"].as_array().unwrap().len(), 2);
}
#[test]
fn cq_family_instantiates_same_target_with_source_bound_new_member() {
    let f = load(include_str!(
        "../../../contracts/demand-v0.1/examples/cq-family.json"
    ));
    let out = execute("family", &json!({"family":f,"trusted_context":context()})).unwrap();
    assert_eq!(out["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(
        out["tasks"][0]["requirement"]["subjects"]["members"][0]["label"],
        "知识图谱本体"
    );
    assert_eq!(out["semantic_cohort_certified"], false);
}
#[test]
fn family_cannot_invent_group_without_anchored_evidence() {
    let mut f = load(include_str!(
        "../../../contracts/demand-v0.1/examples/cq-family.json"
    ));
    f["cohort_basis"]["evidence_ids"] = json!([]);
    assert!(execute("family", &json!({"family":f,"trusted_context":context()})).is_err());
}
#[test]
fn empty_model_result_is_explicit_not_failed_or_fabricated() {
    let ctx = context();
    let out = execute(
        "build",
        &json!({"candidates":[],"snapshot":ctx["examples"]["e"]["snapshot"],"trusted_context":ctx}),
    )
    .unwrap();
    assert!(out["graph"]["statements"].as_array().unwrap().is_empty());
    assert!(out["profiles"].as_array().unwrap().is_empty());
}
#[test]
fn identity_resolution_is_explicitly_rebuildable_and_reversible() {
    let old = build(vec![candidate("c1")])["graph"].clone();
    let mut raw = context();
    raw["authority"]["candidate_graphs"] = json!([old]);
    let anchor = &old["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["label"] == "丁云")
        .unwrap()["anchors"][0];
    raw["authority"]["entity_links"] = json!([{"entity_ref":"ent_d","status":"CONFIRMED","base_ref":old["snapshot"]["base_ref"],"source_ref":anchor["source_ref"],"source_revision":anchor["source_revision"],"text_sha256":anchor["text_sha256"],"span":anchor["span"],"receipt_ref":"resolution_1"}]);
    let resolved = execute(
        "rebuild",
        &json!({"previous":old,"expected_graph_digest":old["graph_digest"],"trusted_context":raw}),
    )
    .unwrap();
    assert_eq!(resolved["identity_revision_explicit"], true);
    assert_ne!(resolved["graph"]["graph_digest"], old["graph_digest"]);
    raw["authority"]["candidate_graphs"] = json!([resolved["graph"]]);
    raw["authority"]["entity_links"] = json!([]);
    let reversed=execute("rebuild",&json!({"previous":resolved["graph"],"expected_graph_digest":resolved["graph"]["graph_digest"],"trusted_context":raw})).unwrap();
    assert_eq!(reversed["graph"], old);
}
#[test]
fn existing_condition_transfer_must_be_explicitly_invariant() {
    let mut raw = context();
    let mut seed = raw["examples"]["q"].clone();
    seed["requirements"][0]["conditions"] = json!([{"id":"seed_condition","mention":{"start":0,"end":5,"quote":"Agent","offset_unit":"utf16_code_unit"},"field":"SCOPE","operator":"EQ","value":{"kind":"STRING","value":"Agent"},"interpretation":"FORMALIZED"}]);
    raw["examples"]["q"] = seed.clone();
    let mut family = load(include_str!(
        "../../../contracts/demand-v0.1/examples/cq-family.json"
    ));
    family["seed_question_spec_sha256"] = json!(lightog_demand::wire::sha(&seed).unwrap());
    family["condition_transfer"] =
        json!([{"condition_id":"seed_condition","policy":"REQUIRES_RECHECK"}]);
    assert_eq!(
        execute("family", &json!({"family":family,"trusted_context":raw}))
            .unwrap_err()
            .code,
        "BUILD_FAMILY_CONDITION_UNRESOLVED"
    );
}

#[test]
fn explicit_known_ref_cannot_hide_competing_trusted_identity_links() {
    let mut raw = context();
    let mut c = candidate("c1");
    c["entities"][0]["entity_ref"] = json!("ent_d");
    let f = &raw["examples"]["e"]["fragments"][1];
    let link = json!({"entity_ref":"ent_d","status":"CONFIRMED","base_ref":c["snapshot"]["base_ref"],"source_ref":f["source_ref"],"source_revision":f["source_revision"],"text_sha256":f["text_sha256"],"span":c["entities"][0]["mentions"][0]["span"],"receipt_ref":"r1"});
    let mut other = link.clone();
    other["entity_ref"] = json!("other_entity");
    raw["authority"]["entities"]
        .as_array_mut()
        .unwrap()
        .push(json!("other_entity"));
    raw["authority"]["entity_links"] = json!([link, other]);
    assert_eq!(
        execute("build", &json!({"candidates":[c],"trusted_context":raw}))
            .unwrap_err()
            .code,
        "BUILD_ENTITY_LINK_AMBIGUOUS"
    );
}
#[test]
fn profile_dependencies_do_not_collect_unrelated_or_tampered_registry_sets() {
    let mut raw = context();
    let mut extra = raw["examples"]["e"].clone();
    extra["evidence_set_id"] = json!("unrelated_set");
    extra["snapshot"]["graph_revision"] = json!("old_graph");
    extra["fragments"][1]["id"] = json!("forged_alias");
    extra["fragments"][1]["span"]["quote"] = json!("伪造");
    raw["examples"]["unused"] = extra;
    let out = execute(
        "build",
        &json!({"candidates":[candidate("c1")],"trusted_context":raw}),
    )
    .unwrap();
    assert!(out["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|p| p["evidence_refs"].as_array().unwrap())
        .all(|r| r["evidence_set_ref"] == "es_synthetic"));
}
#[test]
fn normalization_cannot_turn_distinct_local_roles_into_an_implicit_self_relation() {
    let mut c = candidate("c1");
    c["entities"][1]["mentions"] = c["entities"][0]["mentions"].clone();
    assert_eq!(
        execute(
            "build",
            &json!({"candidates":[c],"trusted_context":context()})
        )
        .unwrap_err()
        .code,
        "BUILD_RELATION_IDENTITY_COLLAPSED"
    );
}

#[test]
fn pattern_cannot_bypass_qualifier_shape_through_a_null_container() {
    let c = candidate("c1");
    let p = json!({"kind":"COMBINATION","label":"模式候选","roles":[{"candidate_id":"c1","entity_local_id":"cloud","role":"提供方"},{"candidate_id":"c1","entity_local_id":"region","role":"地区"}],"evidence_set_ref":"es_synthetic","evidence_ids":["e_new"],"qualifiers":null});
    assert_eq!(
        execute(
            "build",
            &json!({"candidates":[c],"patterns":[p],"trusted_context":context()})
        )
        .unwrap_err()
        .code,
        "SCHEMA_INVALID"
    );
}
