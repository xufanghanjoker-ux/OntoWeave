//! Original minimal-registry fixtures; no provider or semantic accuracy claims.
use lightog_core::{
    common::{canonical_hash as hash, sha},
    knowledge_build, seed_materialize,
};
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
fn material(p: &Value) -> Value {
    seed_materialize::execute("materialize", p).unwrap()
}
#[test]
fn registry_ids_anchors_and_cross_fact_connections_are_owned_by_rust() {
    let mut p = fixture();
    let fact = p["raw"]["candidates"][0].clone();
    p["raw"]["candidates"].as_array_mut().unwrap().push(fact);
    let r = material(&p);
    assert_eq!(r["candidates"].as_array().unwrap().len(), 2);
    let c = &r["candidates"][0];
    assert_eq!(c["entities"][0]["local_id"], "e_001");
    assert_eq!(c["entities"][0]["mentions"][0]["span"]["start"], 3);
    assert_eq!(c["entities"][0]["label"], "RefCell<T>");
    assert_eq!(c["entities"][1]["label"], "中文");
    assert_eq!(c["semantic_status"], "UNVERIFIED");
    assert_eq!(c["status"], "CANDIDATE");
    assert_eq!(r["receipts"][0]["validator"], "RUST_P2_BUILD");
    assert_eq!(r["raw_parsed_sha256"], hash(&p["raw"]));
    let built=knowledge_build::build(&json!({"candidates":r["candidates"],"snapshot":p["prepared"]["payload"]["snapshot"],"trusted_context":p["trusted_context"]})).unwrap();
    assert_eq!(built["graph"]["entities"].as_array().unwrap().len(), 2);
}
#[test]
fn duplicate_opaque_key_poison_all_dependents_even_when_first_row_has_shape_error() {
    let mut p = fixture();
    let duplicate = p["raw"]["entities"][0].clone();
    p["raw"]["entities"][0]["unexpected"] = json!(true);
    p["raw"]["entities"].as_array_mut().unwrap().push(duplicate);
    let mut good = p["raw"]["candidates"][0].clone();
    good["kind"] = json!("ENTITY");
    good["subject_local_id"] = json!("中文");
    good["predicate"] = Value::Null;
    good["object"] = Value::Null;
    good["direction"] = json!("NONE");
    p["raw"]["candidates"].as_array_mut().unwrap().push(good);
    let r = material(&p);
    assert_eq!(r["candidates"].as_array().unwrap().len(), 1);
    assert_eq!(
        r["quarantined"][0]["error_code"],
        "FACT_ENTITY_REFERENCE_UNRESOLVED"
    );
    assert_eq!(
        r["entity_resolution"][0]["error_code"],
        "ENTITY_REGISTRY_ID_DUPLICATE"
    );
    assert_eq!(
        r["entity_resolution"][2]["error_code"],
        "ENTITY_REGISTRY_ID_DUPLICATE"
    );
}
#[test]
fn canonical_id_imitation_is_unknown_unless_it_was_an_explicit_opaque_key() {
    let mut p = fixture();
    p["raw"]["candidates"][0]["subject_local_id"] = json!("e_001");
    let r = material(&p);
    assert!(r["candidates"].as_array().unwrap().is_empty());
    assert_eq!(
        r["symbol_projection"]["missing_key_map"][0]["internal_id"],
        "missing_001"
    );
    p["raw"]["entities"][0]["local_id"] = json!("e_001");
    assert_eq!(material(&p)["candidates"].as_array().unwrap().len(), 1);
}
#[test]
fn surface_requires_one_exact_match_including_overlaps_and_original_utf16() {
    for (surface, code) in [
        ("Oak", "ENTITY_SURFACE_AMBIGUOUS"),
        ("aba", "ENTITY_SURFACE_AMBIGUOUS"),
        ("refcell<T>", "ENTITY_SURFACE_NO_EXACT_MATCH"),
    ] {
        let mut p = fixture();
        p["raw"]["entities"][0]["surface"] = json!(surface);
        assert_eq!(material(&p)["entity_resolution"][0]["error_code"], code);
    }
    let mut p = fixture();
    p["raw"]["entities"][0]["surface"] = json!(" RefCell<T>");
    let r = material(&p);
    assert_eq!(r["candidates"][0]["entities"][0]["label"], " RefCell<T>");
    assert_eq!(
        r["candidates"][0]["entities"][0]["mentions"][0]["span"]["start"],
        2
    );
}
#[test]
fn semantic_fields_conditions_and_program_ids_are_preserved_without_promotion() {
    let mut p = fixture();
    let f = &mut p["raw"]["candidates"][0];
    f["qualifiers"] = json!({"scope":"Only this example","modality":"PLANNED","negated":true,"unit":"kg","effective_time":"2040"});
    f["conditions"] = json!([{"text":"A AND B only","evidence_ids":["e_material"]}]);
    let f = f.clone();
    let r = material(&p);
    let c = &r["candidates"][0];
    assert_eq!(c["qualifiers"], f["qualifiers"]);
    assert_eq!(c["direction"], f["direction"]);
    assert_eq!(c["conditions"][0]["text"], "A AND B only");
    assert_eq!(c["conditions"][0]["id"], "cond_001");
    assert_eq!(c["conditions"][0]["support_status"], "UNVERIFIED");
    assert_eq!(r["receipts"][0]["model_fact_local_id"], "f_001");
    assert_eq!(r["semantic_support_certified"], false);
}
#[test]
fn model_service_fields_or_fact_condition_ids_are_not_silently_overwritten() {
    for mode in 0..3 {
        let mut p = fixture();
        match mode {
            0 => p["raw"]["candidates"][0]["status"] = json!("PUBLISHED"),
            1 => p["raw"]["candidates"][0]["local_id"] = json!("model_fact_id"),
            _ => {
                p["raw"]["candidates"][0]["conditions"] =
                    json!([{"id":"model_condition","text":"Only A","evidence_ids":["e_material"]}])
            }
        };
        let r = material(&p);
        assert_eq!(r["quarantined"].as_array().unwrap().len(), 1);
        assert!(r["candidates"].as_array().unwrap().is_empty());
    }
}
#[test]
fn undeclared_predicate_support_and_prepared_drift_fail_closed() {
    let mut p = fixture();
    let mut f = p["trusted_context"]["examples"]["source"]["fragments"][0].clone();
    f["id"] = json!("e_other");
    p["trusted_context"]["examples"]["source"]["fragments"]
        .as_array_mut()
        .unwrap()
        .push(f);
    p["prepared"]=knowledge_build::prepare_extract(&json!({"evidence_set_ref":"es_material","cq_guidance":"hint","trusted_context":p["trusted_context"]})).unwrap();
    p["raw"]["candidates"][0]["predicate"]["evidence_ids"] = json!(["e_other"]);
    assert_eq!(
        material(&p)["quarantined"][0]["error_code"],
        "FACT_PREDICATE_SUPPORT_UNDECLARED"
    );
    p["prepared"]["payload"]["evidence_menu"][0]["span"]["quote"] = json!("Changed");
    assert!(seed_materialize::execute("materialize", &p).is_err());
}
#[test]
fn namespace_is_bound_to_unit_round_stage_and_oversize_envelope_never_truncated() {
    let p = json!({"unit_id":"a","round_id":"r1","stage":"GAP_EXTRACT"});
    let a = seed_materialize::execute("namespace", &p).unwrap();
    let mut other = p.clone();
    other["round_id"] = json!("r2");
    assert_ne!(a, seed_materialize::execute("namespace", &other).unwrap());
    let mut over = fixture();
    let f = over["raw"]["candidates"][0].clone();
    over["raw"]["candidates"] = json!(vec![f; 9]);
    assert!(seed_materialize::execute("materialize", &over).is_err());
}
