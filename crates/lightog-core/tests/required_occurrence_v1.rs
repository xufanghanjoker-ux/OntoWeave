//! Original minimal-registry fixtures; no provider or semantic accuracy claims.
use lightog_core::{common::sha, knowledge_build, semantic_review_v2, support_selection};
use serde_json::{json, Value};
fn fixture() -> Value {
    let text = "🚀 RefCell<T> links 中文. Oak Oak ababa.";
    let text_sha = sha(&json!(text));
    let snapshot = json!({"base_ref":"seed_material_authored","source_epoch":0,"graph_revision":null,"sources":[{"source_ref":"src_material","source_revision":"v1","original_sha256":text_sha,"text_sha256":text_sha,"parser_version":"authored/1"}]});
    let fragment = json!({"id":"e_material","origin":"SOURCE_FRAGMENT","source_ref":"src_material","source_revision":"v1","block_ref":"b_material","text_sha256":text_sha,"span":{"start":0,"end":text.encode_utf16().count(),"quote":text,"offset_unit":"utf16_code_unit"},"claim_refs":[],"role":"PRIMARY"});
    let es = json!({"contract_version":"lightog-demand/0.1","evidence_set_id":"es_material","snapshot":snapshot,"fragments":[fragment]});
    let context = json!({"examples":{"source":es},"source_texts":[{"source_ref":"src_material","source_revision":"v1","text":text,"original_sha256":text_sha,"parser_version":"authored/1","blocks":[{"block_ref":"b_material","start":0,"end":text.encode_utf16().count()}]}],"authority":{"requests":[],"allowed_snapshots":[snapshot],"claims":[],"receipts":[],"scope_bindings":[],"entities":[],"predicate_refs":[],"user_definitions":[],"groups":[],"entity_links":[]}});
    let prepared=knowledge_build::prepare_extract(&json!({"evidence_set_ref":"es_material","cq_guidance":"Original source discovery hint only","trusted_context":context})).unwrap();
    let raw = json!({"entities":[{"local_id":"RefCell<T>","surface":"RefCell<T>","type_label":null,"mention_evidence_id":"e_material"},{"local_id":"中文","surface":"中文","type_label":null,"mention_evidence_id":"e_material"}],"candidates":[{"kind":"RELATION","subject_local_id":"RefCell<T>","predicate":{"label":"links","description":"Original links relation","evidence_ids":["e_material"]},"object":{"entity_local_id":"中文","typed_value":null},"direction":"DIRECTED","description":"RefCell<T> links 中文.","keywords":["links"],"qualifiers":{"scope":null,"modality":"REPORTED","negated":false,"unit":null,"effective_time":null},"conditions":[],"support_evidence_ids":["e_material"]}]});
    json!({"prepared":prepared,"trusted_context":context,"raw":raw,"unit_id":"authored_registry_unit","max_candidates":8})
}
fn supported(mut p: Value) -> Value {
    let f = &mut p["raw"]["candidates"][0];
    f.as_object_mut().unwrap().remove("support_evidence_ids");
    f["support_roles"] =
        json!({"assertion":["e_material"],"subject_scope":[],"antecedent":[],"condition":[]});
    p
}

const REQUIRED: &str = "lightog-required-mention-occurrence/0.1";
fn strict(p: &Value) -> Value {
    support_selection::execute("materialize_required_occurrence_v1", p).unwrap()
}
fn explicit() -> Value {
    let mut p = supported(fixture());
    for e in p["raw"]["entities"].as_array_mut().unwrap() {
        e["mention_occurrence"] = json!(1);
    }
    p
}
fn review_input(p: &Value, m: &Value) -> Value {
    json!({"contract_version":semantic_review_v2::VERSION,"candidates":m["candidates"],"prepared":p["prepared"],"trusted_context":p["trusted_context"],"receipts":m["receipts"],"context_evidence_ids":[],"max_context_utf16":12000})
}
#[test]
fn rust_schema_requires_all_five_fields_and_unique_explicit_one_is_old_parity() {
    let p = explicit();
    let ready = support_selection::execute(
        "prepare_required_occurrence_v1",
        &json!({"prepared":p["prepared"],"trusted_context":p["trusted_context"]}),
    )
    .unwrap();
    assert_eq!(ready["proposal_contract_version"], REQUIRED);
    assert_eq!(
        ready["registry_entity_schema"]["required"]
            .as_array()
            .unwrap()
            .len(),
        5
    );
    assert!(ready["registry_entity_schema"]["required"]
        .as_array()
        .unwrap()
        .contains(&json!("mention_occurrence")));
    let old = support_selection::execute("materialize_occurrence_v1", &p).unwrap();
    let new = strict(&p);
    assert_eq!(new["candidates"], old["candidates"]);
    assert!(old.get("proposal_contract_version").is_none());
    assert_eq!(new["proposal_contract_version"], REQUIRED);
    assert_eq!(
        new["support_selection_version"],
        support_selection::OCCURRENCE_VERSION
    );
    let reviewed = semantic_review_v2::execute("prepare", &review_input(&p, &new)).unwrap();
    assert_eq!(reviewed["manifest"]["proposal_contract_version"], REQUIRED);
}
#[test]
fn missing_unique_or_repeated_selector_is_explicit_contract_failure_not_default() {
    for surface in ["RefCell<T>", "Oak"] {
        let mut p = explicit();
        p["raw"]["entities"][0]["surface"] = json!(surface);
        p["raw"]["entities"][0]
            .as_object_mut()
            .unwrap()
            .remove("mention_occurrence");
        let e = support_selection::execute("materialize_required_occurrence_v1", &p).unwrap_err();
        assert_eq!(e.code, "REQUIRED_OCCURRENCE_REGISTRY_INVALID");
        assert!(e
            .details
            .unwrap()
            .to_string()
            .contains("REQUIRED_OCCURRENCE_MISSING"));
    }
}
#[test]
fn all_registry_rows_are_checked_including_unused_invalid_row() {
    for selector in [
        Value::Null,
        json!(0),
        json!(3),
        json!(1.0),
        json!("1"),
        json!(-1),
    ] {
        let mut p = explicit();
        p["raw"]["entities"].as_array_mut().unwrap().push(json!({"local_id":"unused","surface":"Oak","type_label":null,"mention_evidence_id":"e_material","mention_occurrence":selector}));
        assert!(support_selection::execute("materialize_required_occurrence_v1", &p).is_err());
    }
    let mut p = explicit();
    p["raw"]["entities"][0]["surface"] = json!("RefCell-T");
    assert!(support_selection::execute("materialize_required_occurrence_v1", &p).is_err());
}
#[test]
fn repeated_exact_selection_preserves_single_span_and_negative_semantics() {
    let mut p = explicit();
    p["raw"]["entities"][0]["surface"] = json!("Oak");
    p["raw"]["entities"][0]["mention_occurrence"] = json!(2);
    p["raw"]["candidates"][0]["qualifiers"]["negated"] = json!(true);
    let out = strict(&p);
    let c = &out["candidates"][0];
    assert_eq!(c["entities"][0]["mentions"][0]["span"]["start"], 28);
    assert_eq!(c["entities"][0]["mentions"].as_array().unwrap().len(), 1);
    assert_eq!(c["qualifiers"]["negated"], true);
    assert_eq!(c["semantic_status"], "UNVERIFIED");
    assert_eq!(out["semantic_support_certified"], false);
    support_selection::validate_receipt(c, &out["receipts"][0], &p["prepared"]).unwrap();
}
#[test]
fn profile_and_all_registry_selector_tamper_are_replayed_not_merely_rehashed() {
    let p = explicit();
    let out = strict(&p);
    let c = &out["candidates"][0];
    for mode in 0..4 {
        let mut r = out["receipts"][0].clone();
        match mode {
            0 => {
                r["proposal_contract_profile"]["registry_validation"]["selections"][0]["ordinal"] =
                    json!(2)
            }
            1 => r["proposal_contract_profile"]["raw_sha256"] = json!("forged"),
            2 => r["proposal_contract_version"] = json!("unknown"),
            _ => {
                r.as_object_mut()
                    .unwrap()
                    .remove("proposal_contract_version");
            }
        }
        r["proposal_contract_profile_sha256"] = json!(lightog_core::common::canonical_hash(
            &r["proposal_contract_profile"]
        ));
        assert!(
            support_selection::validate_receipt(c, &r, &p["prepared"]).is_err(),
            "mode {mode}"
        );
    }
}
#[test]
fn optional_and_required_receipts_cannot_share_a_review_batch() {
    let p = explicit();
    let strict = strict(&p);
    let mut other = p.clone();
    other["unit_id"] = json!("optional-other");
    let old = support_selection::execute("materialize_occurrence_v1", &other).unwrap();
    let mut q = review_input(&p, &strict);
    q["candidates"]
        .as_array_mut()
        .unwrap()
        .push(old["candidates"][0].clone());
    q["receipts"]
        .as_array_mut()
        .unwrap()
        .push(old["receipts"][0].clone());
    assert_eq!(
        semantic_review_v2::execute("prepare", &q).unwrap_err().code,
        "REVIEW_PROPOSAL_CONTRACT_MIXED"
    );
}
#[test]
fn raw_text_keeps_strict_integer_and_existing_json_boundary() {
    let mut p = explicit();
    let old = strict(&p);
    let text = serde_json::to_string(&p["raw"]).unwrap();
    p["raw"] = json!(text.clone());
    let new = strict(&p);
    assert_eq!(old["receipts"], new["receipts"]);
    assert_eq!(old["candidates"], new["candidates"]);
    p["raw"] = json!(text.replacen("\"mention_occurrence\":1", "\"mention_occurrence\":1.0", 1));
    assert!(support_selection::execute("materialize_required_occurrence_v1", &p).is_err());
    p["raw"] = json!(text.replacen(
        "\"mention_occurrence\":1",
        "\"mention_occurrence\":1,\"mention_occurrence\":1",
        1
    ));
    assert!(support_selection::execute("materialize_required_occurrence_v1", &p).is_err());
}
