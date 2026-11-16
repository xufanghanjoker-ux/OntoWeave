//! Synthetic support-closure and applicability counterexamples. No provider,
//! labels, archived model review or source-truth certification is used here.
use lightog_core::{
    common::{canonical_hash as hash, sha},
    knowledge_build, semantic_review_v2 as review, support_selection,
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
    support_selection::execute("materialize", p).unwrap()
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
    q["review_output"] = json!({"reviews":[{"candidate_id":q["candidates"][0]["candidate_id"],"decision":"SUPPORTED","dimensions":dims}]});
    q["review_provenance"] = json!({"origin":"SYNTHETIC","review_request_id":"review-v2","proposal_request_ids":["proposal-v2"],"review_output_sha256":hash(&q["review_output"]),"model":"synthetic-offline","config_revision":1});
    q
}
fn bind(p: &mut Value) {
    p["review_provenance"]["review_output_sha256"] = json!(hash(&p["review_output"]));
}
#[test]
fn explicit_scope_and_antecedent_are_bound_in_receipts_and_never_published() {
    let p = fixture();
    let m = material(&p);
    assert_eq!(
        m["receipts"][0]["fact_support_evidence_ids"],
        json!(["antecedent", "assertion", "mode"])
    );
    assert_eq!(
        m["receipts"][0]["support_roles"]["subject_scope"],
        json!(["mode"])
    );
    assert_eq!(m["publication_performed"], false);
    assert_eq!(m["semantic_support_certified"], false);
}
#[test]
fn registry_anchor_is_not_automatically_promoted_to_fact_support() {
    let mut p = fixture();
    p["raw"]["candidates"][0]["support_roles"]["subject_scope"] = json!([]);
    p["raw"]["candidates"][0]["support_roles"]["antecedent"] = json!([]);
    let m = material(&p);
    assert_eq!(
        m["receipts"][0]["fact_support_evidence_ids"],
        json!(["assertion"])
    );
    assert_eq!(
        m["receipts"][0]["registry_anchor_evidence_ids"],
        json!(["mode"])
    );
    assert!(m["candidates"][0]["evidence_ids"]
        .as_array()
        .unwrap()
        .contains(&json!("mode")));
    let mut q = reviewed(&p);
    q["review_output"]["reviews"][0]["dimensions"]["subject"]["decision"] = json!("PARTIAL");
    bind(&mut q);
    assert!(review::execute("apply", &q).unwrap()["eligible_candidates"]
        .as_array()
        .unwrap()
        .is_empty());
}
#[test]
fn roles_reject_unknown_empty_assertion_duplicate_and_legacy_support() {
    for mode in 0..4 {
        let mut p = fixture();
        match mode {
            0 => {
                p["raw"]["candidates"][0]["support_roles"]["subject_scope"] =
                    json!(["foreign-source"])
            }
            1 => p["raw"]["candidates"][0]["support_roles"]["assertion"] = json!([]),
            2 => {
                p["raw"]["candidates"][0]["support_roles"]["assertion"] =
                    json!(["assertion", "assertion"])
            }
            _ => p["raw"]["candidates"][0]["support_evidence_ids"] = json!(["mode"]),
        };
        assert!(support_selection::execute("materialize", &p).is_err());
    }
}
#[test]
fn condition_support_requires_explicit_condition_role() {
    let mut p = fixture();
    p["raw"]["candidates"][0]["conditions"] =
        json!([{"text":"If the same file is unstaged","evidence_ids":["condition"]}]);
    assert_eq!(
        support_selection::execute("materialize", &p)
            .unwrap_err()
            .code,
        "SUPPORT_CONDITION_ROLE_UNDECLARED"
    );
    p["raw"]["candidates"][0]["support_roles"]["condition"] = json!(["condition"]);
    assert_eq!(material(&p)["candidates"].as_array().unwrap().len(), 1);
}
#[test]
fn units_not_applicable_is_retained_as_distinct_judgment() {
    let p = reviewed(&fixture());
    let out = review::execute("apply", &p).unwrap();
    assert_eq!(out["eligible_candidates"].as_array().unwrap().len(), 1);
    assert_eq!(
        out["review_receipt"]["reviews"][0]["dimensions"]["units"]["decision"],
        "NOT_APPLICABLE"
    );
    assert_eq!(out["semantic_support_certified"], false);
}
#[test]
fn top_level_or_semantic_dimension_cannot_hide_behind_not_applicable() {
    for top in [false, true] {
        let mut p = reviewed(&fixture());
        if top {
            p["review_output"]["reviews"][0]["decision"] = json!("NOT_APPLICABLE");
        } else {
            p["review_output"]["reviews"][0]["dimensions"]["conditions"]["decision"] =
                json!("NOT_APPLICABLE");
        }
        bind(&mut p);
        assert!(review::execute("apply", &p).is_err());
    }
}
#[test]
fn absent_unit_is_not_a_semantic_certificate_and_unknown_still_holds() {
    let mut p = reviewed(&fixture());
    p["review_output"]["reviews"][0]["dimensions"]["units"]["decision"] = json!("UNKNOWN");
    bind(&mut p);
    assert!(review::execute("apply", &p).unwrap()["eligible_candidates"]
        .as_array()
        .unwrap()
        .is_empty());
}
#[test]
fn declared_unit_vetoes_not_applicable_without_silent_supported_mapping() {
    let mut f = fixture();
    f["raw"]["candidates"][0]["qualifiers"]["unit"] = json!("hours");
    let p = reviewed(&f);
    let out = review::execute("apply", &p).unwrap();
    assert!(out["eligible_candidates"].as_array().unwrap().is_empty());
    assert!(out["quarantined"][0]["reasons"]
        .as_array()
        .unwrap()
        .contains(&json!("NOT_APPLICABLE_CONFLICTS_WITH_DECLARED_UNIT")));
}
#[test]
fn not_applicable_requires_declared_source_support_not_just_a_reason() {
    let mut p = reviewed(&fixture());
    p["review_output"]["reviews"][0]["dimensions"]["units"]["evidence_ids"] = json!([]);
    bind(&mut p);
    let out = review::execute("apply", &p).unwrap();
    assert!(out["eligible_candidates"].as_array().unwrap().is_empty());
}
#[test]
fn support_role_change_after_prepare_invalidates_manifest() {
    let mut p = reviewed(&fixture());
    p["receipts"][0]["support_roles"]["antecedent"] = json!([]);
    assert!(review::execute("apply", &p).is_err());
}
#[test]
fn source_drift_or_candidate_rebinding_is_rejected() {
    for src in [false, true] {
        let mut p = reviewed(&fixture());
        if src {
            p["trusted_context"]["source_texts"][0]["text"] = json!("replacement");
        } else {
            p["candidates"][0]["description"] = json!("Changed subject and meaning");
        }
        assert!(review::execute("apply", &p).is_err());
    }
}
#[test]
fn schema_and_roles_are_rust_authored_and_version_bound() {
    let f = fixture();
    let ready = support_selection::execute(
        "prepare",
        &json!({"prepared":f["prepared"],"trusted_context":f["trusted_context"]}),
    )
    .unwrap();
    assert_eq!(
        ready["support_roles_schema"]["required"],
        json!(support_selection::ROLES)
    );
    let r = review::execute("prepare", &proposal(&f)).unwrap();
    assert_eq!(
        r["review_output_schema"]["properties"]["reviews"]["items"]["properties"]["dimensions"]
            ["properties"]["units"]["properties"]["decision"]["enum"][4],
        "NOT_APPLICABLE"
    );
    assert_eq!(
        r["manifest"]["support_selection_version"],
        support_selection::VERSION
    );
}

#[test]
fn mixed_anchor_and_assertion_citations_cannot_launder_undeclared_scope_support() {
    let mut f = fixture();
    f["raw"]["candidates"][0]["support_roles"]["subject_scope"] = json!([]);
    let mut p = reviewed(&f);
    for dim in p["review_output"]["reviews"][0]["dimensions"]
        .as_object_mut()
        .unwrap()
        .values_mut()
    {
        dim["evidence_ids"] = json!(["assertion", "mode"]);
    }
    bind(&mut p);
    let out = review::execute("apply", &p).unwrap();
    assert!(out["eligible_candidates"].as_array().unwrap().is_empty());
    assert!(out["quarantined"][0]["reasons"]
        .as_array()
        .unwrap()
        .contains(&json!("NEEDS_SUPPORT_EXPANSION:scope")));
    assert!(out["quarantined"][0]["reasons"]
        .as_array()
        .unwrap()
        .contains(&json!("NEEDS_SUPPORT_EXPANSION:units")));
}
