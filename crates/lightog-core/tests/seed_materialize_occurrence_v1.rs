//! Original minimal-registry fixtures; no provider or semantic accuracy claims.
use lightog_core::{
    common::sha, knowledge_build, seed_materialize, semantic_review_v2, support_selection,
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
fn occurrence(p: &Value) -> Value {
    seed_materialize::execute("materialize_occurrence_v1", p).unwrap()
}
fn supported(mut p: Value) -> Value {
    let f = &mut p["raw"]["candidates"][0];
    f.as_object_mut().unwrap().remove("support_evidence_ids");
    f["support_roles"] =
        json!({"assertion":["e_material"],"subject_scope":[],"antecedent":[],"condition":[]});
    p
}
#[test]
fn unique_candidates_are_legacy_identical_and_old_rejects_new_selector() {
    let mut p = fixture();
    let old = material(&p);
    let new = occurrence(&p);
    assert_eq!(old["candidates"], new["candidates"]);
    assert_eq!(
        old["entity_resolution"][0]["entity"],
        new["entity_resolution"][0]["entity"]
    );
    assert_eq!(
        new["materializer_version"],
        "lightog-seed-materialize-occurrence/0.1"
    );
    p["raw"]["entities"][0]["mention_occurrence"] = json!(1);
    assert!(material(&p)["candidates"].as_array().unwrap().is_empty());
    assert_eq!(occurrence(&p)["candidates"], old["candidates"]);
}
#[test]
fn repeated_overlapping_and_unicode_select_exact_single_utf16_mention() {
    for (surface, ordinal, start) in [
        ("Oak", 2, 28),
        ("aba", 2, 34),
        ("🚀", 1, 0),
        ("中文", 1, 20),
    ] {
        let mut p = fixture();
        p["raw"]["entities"][0]["surface"] = json!(surface);
        p["raw"]["entities"][0]["mention_occurrence"] = json!(ordinal);
        if surface == "中文" {
            p["raw"]["entities"][1]["surface"] = json!("RefCell<T>");
        }
        let out = occurrence(&p);
        assert_eq!(
            out["candidates"].as_array().unwrap().len(),
            1,
            "{surface}: {out}"
        );
        let mentions = &out["candidates"][0]["entities"][0]["mentions"];
        assert_eq!(mentions.as_array().unwrap().len(), 1);
        assert_eq!(mentions[0]["span"]["start"], start, "{surface}");
    }
}
#[test]
fn missing_zero_out_of_range_float_and_no_exact_match_hold() {
    for selector in [
        Value::Null,
        json!(0),
        json!(3),
        json!(1.0),
        json!(-1),
        json!("1"),
    ] {
        let mut p = fixture();
        p["raw"]["entities"][0]["surface"] = json!("Oak");
        if !selector.is_null() {
            p["raw"]["entities"][0]["mention_occurrence"] = selector;
        }
        assert!(occurrence(&p)["candidates"].as_array().unwrap().is_empty());
    }
    let mut p = fixture();
    p["raw"]["entities"][0]["surface"] = json!("RefCell-T");
    p["raw"]["entities"][0]["mention_occurrence"] = json!(1);
    assert_eq!(
        occurrence(&p)["entity_resolution"][0]["error_code"],
        "ENTITY_SURFACE_NO_EXACT_MATCH"
    );
}
#[test]
fn same_surface_different_positions_remain_distinct_entities() {
    let mut p = fixture();
    for (i, n) in [(0, 1), (1, 2)] {
        p["raw"]["entities"][i]["surface"] = json!("Oak");
        p["raw"]["entities"][i]["mention_occurrence"] = json!(n);
    }
    let out = occurrence(&p);
    let built=knowledge_build::build(&json!({"candidates":out["candidates"],"snapshot":p["prepared"]["payload"]["snapshot"],"trusted_context":p["trusted_context"]})).unwrap();
    assert_eq!(built["graph"]["entities"].as_array().unwrap().len(), 2);
}
#[test]
fn support_receipt_replays_selection_and_rejects_tamper_and_source_drift() {
    let mut p = supported(fixture());
    p["raw"]["entities"][0]["surface"] = json!("Oak");
    p["raw"]["entities"][0]["mention_occurrence"] = json!(2);
    p["raw"]["candidates"][0]["qualifiers"]["negated"] = json!(true);
    let out = support_selection::execute("materialize_occurrence_v1", &p).unwrap();
    let c = &out["candidates"][0];
    let r = &out["receipts"][0];
    assert_eq!(c["qualifiers"]["negated"], true);
    assert_eq!(c["semantic_status"], "UNVERIFIED");
    support_selection::validate_receipt(c, r, &p["prepared"]).unwrap();
    for field in [
        "ordinal",
        "match_count",
        "span",
        "raw",
        "prepared_payload_sha256",
    ] {
        let mut t = r.clone();
        t["mention_occurrence_selection"][field] = json!("tampered");
        assert!(
            support_selection::validate_receipt(c, &t, &p["prepared"]).is_err(),
            "{field}"
        );
    }
    let q = json!({"contract_version":semantic_review_v2::VERSION,"candidates":out["candidates"],"prepared":p["prepared"],"trusted_context":p["trusted_context"],"receipts":out["receipts"],"context_evidence_ids":[],"max_context_utf16":12000});
    let ready = semantic_review_v2::execute("prepare", &q).unwrap();
    assert_eq!(
        ready["manifest"]["support_selection_version"],
        "lightog-support-selection/0.2"
    );
    let mut drift = q;
    drift["trusted_context"]["source_texts"][0]["source_revision"] = json!("v2");
    assert!(semantic_review_v2::execute("prepare", &drift).is_err());
}
#[test]
fn rust_authors_optional_selector_schema() {
    let p = fixture();
    let ready = support_selection::execute(
        "prepare_occurrence_v1",
        &json!({"prepared":p["prepared"],"trusted_context":p["trusted_context"]}),
    )
    .unwrap();
    assert_eq!(
        ready["registry_entity_schema"]["properties"]["mention_occurrence"]["type"],
        "integer"
    );
    assert_eq!(
        ready["registry_entity_schema"]["required"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
}

#[test]
fn receipt_cannot_be_downgraded_or_mix_batch_versions() {
    let p = supported(fixture());
    let newer = support_selection::execute("materialize_occurrence_v1", &p).unwrap();
    let mut r = newer["receipts"][0].clone();
    r["support_selection_version"] = json!(support_selection::VERSION);
    assert_eq!(
        support_selection::validate_receipt(&newer["candidates"][0], &r, &p["prepared"])
            .unwrap_err()
            .code,
        "SUPPORT_ROLE_VERSION_DOWNGRADE"
    );
    let mut other = p.clone();
    other["unit_id"] = json!("legacy_other_unit");
    let old = support_selection::execute("materialize", &other).unwrap();
    let q = json!({"contract_version":semantic_review_v2::VERSION,"candidates":[newer["candidates"][0],old["candidates"][0]],"prepared":p["prepared"],"trusted_context":p["trusted_context"],"receipts":[newer["receipts"][0],old["receipts"][0]],"context_evidence_ids":[],"max_context_utf16":12000});
    assert_eq!(
        semantic_review_v2::execute("prepare", &q).unwrap_err().code,
        "REVIEW_SUPPORT_VERSION_MIXED"
    );
}
#[test]
fn replay_detects_nested_occurrence_and_candidate_rebinding_even_after_hash_updates() {
    let mut p = supported(fixture());
    p["raw"]["entities"][0]["surface"] = json!("Oak");
    p["raw"]["entities"][0]["mention_occurrence"] = json!(2);
    let out = support_selection::execute("materialize_occurrence_v1", &p).unwrap();
    for mode in 0..5 {
        let mut c = out["candidates"][0].clone();
        let mut r = out["receipts"][0].clone();
        match mode {
            0 => r["mention_occurrence_selection"]["selections"][0]["ordinal"] = json!(1),
            1 => r["mention_occurrence_selection"]["selections"][0]["match_count"] = json!(1),
            2 => r["mention_occurrence_selection"]["selections"][0]["span"]["start"] = json!(24),
            3 => {
                r["mention_occurrence_selection"]["selections"][0]["source_revision"] =
                    json!("forged")
            }
            _ => {
                c["entities"][0]["mentions"][0]["span"]["start"] = json!(24);
                c["entities"][0]["mentions"][0]["span"]["end"] = json!(27);
                r["candidate_sha256"] = json!(lightog_core::common::canonical_hash(&c));
                r["mention_occurrence_selection"]["candidate_sha256"] =
                    r["candidate_sha256"].clone();
            }
        }
        assert!(
            support_selection::validate_receipt(&c, &r, &p["prepared"]).is_err(),
            "mode {mode}"
        );
    }
}
#[test]
fn surrogate_pair_length_and_fragment_start_are_kept_exact() {
    let mut p = fixture();
    p["raw"]["entities"][0]["surface"] = json!("🚀");
    p["raw"]["entities"][0]["mention_occurrence"] = json!(1);
    let out = occurrence(&p);
    assert_eq!(
        out["candidates"][0]["entities"][0]["mentions"][0]["span"]["end"],
        2
    );
    let mut c = out["candidates"][0].clone();
    c["entities"][0]["mentions"][0]["span"]["end"] = json!(1);
    assert!(knowledge_build::build(&json!({"candidates":[c],"snapshot":p["prepared"]["payload"]["snapshot"],"trusted_context":p["trusted_context"]})).is_err());
}

#[test]
fn text_boundary_preserves_integer_validation_and_rejects_duplicate_keys_without_repair() {
    let mut p = supported(fixture());
    p["raw"]["entities"][0]["surface"] = json!("Oak");
    p["raw"]["entities"][0]["mention_occurrence"] = json!(2);
    let object = support_selection::execute("materialize_occurrence_v1", &p).unwrap();
    let text = serde_json::to_string(&p["raw"]).unwrap();
    p["raw"] = json!(text.clone());
    let textual = support_selection::execute("materialize_occurrence_v1", &p).unwrap();
    assert_eq!(object["candidates"], textual["candidates"]);
    assert_eq!(object["receipts"], textual["receipts"]);
    assert_eq!(textual["raw_text_parse_receipt"]["syntax_repair"], false);
    p["raw"] = json!(text.replace("\"mention_occurrence\":2", "\"mention_occurrence\":1.0"));
    let held = support_selection::execute("materialize_occurrence_v1", &p).unwrap();
    assert!(held["candidates"].as_array().unwrap().is_empty());
    assert_eq!(
        held["entity_resolution"][0]["error_code"],
        "ENTITY_MENTION_OCCURRENCE_INVALID"
    );
    p["raw"] = json!(text.replacen(
        "\"mention_occurrence\":2",
        "\"mention_occurrence\":1,\"mention_occurrence\":2",
        1
    ));
    assert!(support_selection::execute("materialize_occurrence_v1", &p).is_err());
    for raw in ["{} {}", "Here is JSON: {}", "```python\n{}\n```"] {
        p["raw"] = json!(raw);
        assert!(support_selection::execute("materialize_occurrence_v1", &p).is_err());
    }
}
#[test]
fn explicit_null_selector_is_invalid_and_nonzero_fragment_origin_is_preserved() {
    let mut p = fixture();
    p["raw"]["entities"][0]["mention_occurrence"] = Value::Null;
    assert_eq!(
        occurrence(&p)["entity_resolution"][0]["error_code"],
        "ENTITY_MENTION_OCCURRENCE_INVALID"
    );
    p["raw"]["entities"][0]
        .as_object_mut()
        .unwrap()
        .remove("mention_occurrence");
    let f = &mut p["trusted_context"]["examples"]["source"]["fragments"][0];
    f["span"]["start"] = json!(3);
    f["span"]["quote"] = json!("RefCell<T> links 中文. Oak Oak ababa.");
    p["prepared"]=knowledge_build::prepare_extract(&json!({"evidence_set_ref":"es_material","cq_guidance":"direction only","trusted_context":p["trusted_context"]})).unwrap();
    let out = occurrence(&p);
    assert_eq!(
        out["candidates"][0]["entities"][0]["mentions"][0]["span"]["start"],
        3
    );
}
