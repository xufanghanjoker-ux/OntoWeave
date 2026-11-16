//! Synthetic support-closure and applicability counterexamples. No provider,
//! labels, archived model review or source-truth certification is used here.
use lightog_core::{
    common::{canonical_hash as hash, sha},
    knowledge_build, semantic_review_v3 as review, support_selection,
};
use serde_json::{json, Value};
fn fixture() -> Value {
    let text="🚀 Mode Alpha.\nIt leaves the index unchanged.\nIt refers to mode Alpha.\nIf the same file is unstaged, abort.\n";
    let digest = sha(&json!(text));
    let size = text.encode_utf16().count();
    let snapshot = json!({"base_ref":"support_v2_authored","source_epoch":0,"graph_revision":null,"sources":[{"source_ref":"src","source_revision":"r1","original_sha256":digest,"text_sha256":digest,"parser_version":"authored/1"}]});
    let mut at = 0;
    let fragments:Vec<_>=text.split_inclusive('\n').zip(["mode","assertion","antecedent","condition"]).map(|(quote,id)|{let start=at;at+=quote.encode_utf16().count();json!({"id":id,"origin":"SOURCE_FRAGMENT","source_ref":"src","source_revision":"r1","block_ref":"b","text_sha256":digest,"span":{"start":start,"end":at,"quote":quote,"offset_unit":"utf16_code_unit"},"claim_refs":[],"role":"PRIMARY"})}).collect();
    let es = json!({"contract_version":"lightog-demand/0.1","evidence_set_id":"es","snapshot":snapshot,"fragments":fragments});
    let ctx = json!({"examples":{"es":es},"source_texts":[{"source_ref":"src","source_revision":"r1","text":text,"original_sha256":digest,"parser_version":"authored/1","blocks":[{"block_ref":"b","start":0,"end":size}]}],"authority":{"requests":[],"allowed_snapshots":[snapshot],"claims":[],"receipts":[],"scope_bindings":[],"entities":[],"predicate_refs":[],"user_definitions":[],"groups":[],"entity_links":[]}});
    let prepared=knowledge_build::prepare_extract(&json!({"evidence_set_ref":"es","cq_guidance":"Authored mode behavior","trusted_context":ctx})).unwrap();
    let raw = json!({"entities":[{"local_id":"Alpha","surface":"Alpha","type_label":null,"mention_evidence_id":"mode"}],"candidates":[{"kind":"ATTRIBUTE","subject_local_id":"Alpha","predicate":{"label":"index effect","description":"Effect on index state","evidence_ids":["assertion"]},"object":{"entity_local_id":null,"typed_value":{"kind":"STRING","value":"unchanged"}},"direction":"NONE","description":"Mode Alpha leaves the index unchanged.","keywords":["index"],"qualifiers":{"scope":"Mode Alpha","modality":"REPORTED","negated":false,"unit":null,"effective_time":null},"conditions":[],"support_roles":{"assertion":["assertion"],"subject_scope":["mode"],"antecedent":["antecedent"],"condition":[]}}]});
    json!({"prepared":prepared,"trusted_context":ctx,"raw":raw,"unit_id":"synthetic_support_v2","max_candidates":8})
}
fn material(p: &Value) -> Value {
    let mut p = p.clone();
    for e in p["raw"]["entities"].as_array_mut().unwrap() {
        e["mention_occurrence"] = json!(1);
    }
    support_selection::execute("materialize_required_occurrence_v1", &p).unwrap()
}
fn proposal(p: &Value) -> Value {
    let m = material(p);
    assert_eq!(m["candidates"].as_array().unwrap().len(), 1);
    json!({"contract_version":review::VERSION,"candidates":m["candidates"],"prepared":p["prepared"],"trusted_context":p["trusted_context"],"receipts":m["receipts"],"context_evidence_ids":["mode","assertion","antecedent","condition"],"max_context_utf16":12000})
}
fn reviewed(p: &Value) -> Value {
    let mut q = proposal(p);
    let ready = review::execute("prepare", &q).unwrap();
    q["manifest"] = ready["manifest"].clone();
    let mut dims = serde_json::Map::new();
    for d in review::DIMENSIONS {
        dims.insert(d.into(),json!({"decision":if d=="units"{"NOT_APPLICABLE"}else{"SUPPORTED"},"reason":"Synthetic independent review judgment fixture; not a semantic truth certificate.","evidence_ids":["assertion","mode","antecedent"]}));
    }
    q["review_output"] = json!({"reviews":[{"candidate_id":q["candidates"][0]["candidate_id"],"decision":"SUPPORTED","dimensions":dims,"readback":ready["manifest"]["candidates"][0]["readback_expectation"],"description_support":{"decision":"SUPPORTED","reason":"Authored narrative supported by selected source; not structural authority.","evidence_ids":["assertion","mode","antecedent"]},"structure_description_consistency":{"decision":"CONSISTENT","reason":"Authored consistency judgment of these unchanged fields; not a semantic certificate.","evidence_ids":["assertion","mode","antecedent"]}}]});
    q["review_provenance"] = json!({"origin":"SYNTHETIC","review_request_id":"review-v2","proposal_request_ids":["proposal-v2"],"review_output_sha256":hash(&q["review_output"]),"model":"synthetic-offline","config_revision":1});
    q
}
fn bind(p: &mut Value) {
    p["review_provenance"]["review_output_sha256"] = json!(hash(&p["review_output"]));
}

#[test]
fn prepared_view_is_top_level_only_projection_with_nested_semantics_preserved() {
    let mut f = fixture();
    f["raw"]["candidates"][0]["conditions"] =
        json!([{"text":"If same file is unstaged AND changed","evidence_ids":["condition"]}]);
    f["raw"]["candidates"][0]["support_roles"]["condition"] = json!(["condition"]);
    let q = proposal(&f);
    let p = review::execute("prepare", &q).unwrap();
    let atom = &p["structured_candidates"][0];
    let raw = &q["candidates"][0];
    assert!(atom.get("description").is_none());
    assert!(atom.get("keywords").is_none());
    for key in [
        "predicate",
        "object",
        "entities",
        "conditions",
        "qualifiers",
    ] {
        assert_eq!(atom[key], raw[key]);
    }
    assert_eq!(
        p["narrative_to_check"][0]["description"],
        raw["description"]
    );
    assert_eq!(p["review_view"][0]["structural_atom"], *atom);
    assert_eq!(
        p["review_view"][0]["readback_expectation"]["structured_candidate_sha256"],
        hash(atom)
    );
    assert_eq!(p["manifest"]["review_view_sha256"], hash(&p["review_view"]));
    assert!(p.get("candidates").is_none());
}
#[test]
fn correct_narrative_cannot_override_unsupported_structured_predicate_or_conflict() {
    let mut p = reviewed(&fixture());
    p["review_output"]["reviews"][0]["dimensions"]["predicate_object"]["decision"] =
        json!("UNSUPPORTED");
    p["review_output"]["reviews"][0]["structure_description_consistency"]["decision"] =
        json!("CONFLICT");
    bind(&mut p);
    let out = review::execute("apply", &p).unwrap();
    assert!(out["eligible_candidates"].as_array().unwrap().is_empty());
    assert!(out["quarantined"][0]["reasons"]
        .to_string()
        .contains("predicate_object"));
    assert!(out["quarantined"][0]["reasons"]
        .to_string()
        .contains("STRUCTURE_DESCRIPTION_NOT_CONSISTENT"));
}
#[test]
fn each_extra_judgment_is_required_and_can_veto_structurally_supported_candidate() {
    for (field, decision) in [
        ("description_support", "UNSUPPORTED"),
        ("description_support", "UNKNOWN"),
        ("structure_description_consistency", "CONFLICT"),
        ("structure_description_consistency", "UNKNOWN"),
        ("structure_description_consistency", "PARTIAL"),
    ] {
        let mut p = reviewed(&fixture());
        p["review_output"]["reviews"][0][field]["decision"] = json!(decision);
        bind(&mut p);
        assert!(review::execute("apply", &p).unwrap()["eligible_candidates"]
            .as_array()
            .unwrap()
            .is_empty());
    }
    let p = reviewed(&fixture());
    assert_eq!(
        review::execute("apply", &p).unwrap()["eligible_candidates"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn negation_direction_conditions_and_units_remain_independent_structural_vetoes() {
    for name in ["negation", "direction", "conditions", "units"] {
        let mut p = reviewed(&fixture());
        p["review_output"]["reviews"][0]["dimensions"][name]["decision"] = json!("UNSUPPORTED");
        bind(&mut p);
        assert!(
            review::execute("apply", &p).unwrap()["eligible_candidates"]
                .as_array()
                .unwrap()
                .is_empty(),
            "{name}"
        );
    }
    let mut f = fixture();
    f["raw"]["candidates"][0]["qualifiers"]["unit"] = json!("hours");
    let p = reviewed(&f);
    assert!(review::execute("apply", &p).unwrap()["eligible_candidates"]
        .as_array()
        .unwrap()
        .is_empty());
}
#[test]
fn readback_and_provenance_bind_the_entire_new_response_without_projection_relabeling() {
    for mode in 0..3 {
        let mut p = reviewed(&fixture());
        match mode {
            0 => {
                p["review_output"]["reviews"][0]["readback"]["structured_candidate_sha256"] =
                    json!("0".repeat(64))
            }
            1 => {
                p["review_output"]["reviews"][0]["readback"]["structure_field_sha256"]
                    ["predicate"] = json!("0".repeat(64))
            }
            _ => {
                p["review_output"]["reviews"][0]["readback"]
                    .as_object_mut()
                    .unwrap()
                    .remove("description_sha256");
            }
        }
        bind(&mut p);
        assert!(review::execute("apply", &p).is_err());
    }
    let mut p = reviewed(&fixture());
    p["review_output"]["reviews"][0]["description_support"]["reason"] =
        json!("Changed full new output");
    assert_eq!(
        review::execute("apply", &p).unwrap_err().code,
        "REVIEW_OUTPUT_BINDING_MISMATCH"
    );
}
#[test]
fn extra_positive_judgments_cannot_cite_unselected_anchor_or_context_as_support() {
    let mut f = fixture();
    f["raw"]["candidates"][0]["support_roles"]["subject_scope"] = json!([]);
    f["raw"]["candidates"][0]["support_roles"]["antecedent"] = json!([]);
    for field in ["description_support", "structure_description_consistency"] {
        let mut p = reviewed(&f);
        for dim in p["review_output"]["reviews"][0]["dimensions"]
            .as_object_mut()
            .unwrap()
            .values_mut()
        {
            dim["evidence_ids"] = json!(["assertion"]);
        }
        p["review_output"]["reviews"][0]["description_support"]["evidence_ids"] =
            json!(["assertion"]);
        p["review_output"]["reviews"][0]["structure_description_consistency"]["evidence_ids"] =
            json!(["assertion"]);
        p["review_output"]["reviews"][0][field]["evidence_ids"] = json!(["assertion", "mode"]);
        bind(&mut p);
        assert!(review::execute("apply", &p).unwrap()["eligible_candidates"]
            .as_array()
            .unwrap()
            .is_empty());
    }
}
#[test]
fn old_review_shape_na_extra_or_changed_source_cannot_pass_v3() {
    let mut p = reviewed(&fixture());
    for key in [
        "readback",
        "description_support",
        "structure_description_consistency",
    ] {
        p["review_output"]["reviews"][0]
            .as_object_mut()
            .unwrap()
            .remove(key);
    }
    bind(&mut p);
    assert!(review::execute("apply", &p).is_err());
    for field in ["description_support", "structure_description_consistency"] {
        let mut p = reviewed(&fixture());
        p["review_output"]["reviews"][0][field]["decision"] = json!("NOT_APPLICABLE");
        bind(&mut p);
        assert!(review::execute("apply", &p).is_err());
    }
    let mut p = reviewed(&fixture());
    p["trusted_context"]["source_texts"][0]["text"] = json!("changed");
    assert!(review::execute("apply", &p).is_err());
}
