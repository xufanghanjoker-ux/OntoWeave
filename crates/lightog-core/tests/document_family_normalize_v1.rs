//! Offline authored model outputs. These test bindings, not semantic quality.
use lightog_core::{common::{a,len,text_sha},document_family_normalize_v1 as norm,document_scope_v1 as scope};
use serde_json::{json,Value};

fn input(texts:&[&str])->Value {
    let mut sources=vec![];let mut fragments=vec![];let mut source_texts=vec![];
    for (i,text) in texts.iter().enumerate() {
        let source_ref=format!("source_{i}");let sha=text_sha(text);let block=format!("b_{i}");
        sources.push(json!({"source_ref":source_ref,"source_revision":"v1","original_sha256":sha,"text_sha256":sha,"parser_version":"authored/1"}));
        fragments.push(json!({"id":format!("e_{i}"),"origin":"SOURCE_FRAGMENT","source_ref":source_ref,"source_revision":"v1","block_ref":block,"text_sha256":sha,"span":{"start":0,"end":len(text),"quote":text,"offset_unit":"utf16_code_unit"},"claim_refs":[],"role":"PRIMARY"}));
        source_texts.push(json!({"source_ref":source_ref,"source_revision":"v1","text":text,"original_sha256":sha,"parser_version":"authored/1","blocks":[{"block_ref":block,"start":0,"end":len(text)}]}));
    }
    let snapshot=json!({"base_ref":"normalize_authored","source_epoch":0,"graph_revision":null,"sources":sources});
    let es=json!({"contract_version":"lightog-demand/0.1","evidence_set_id":"normalize_es","snapshot":snapshot,"fragments":fragments});
    let context=json!({"examples":{"normalize_es":es},"source_texts":source_texts,"authority":{"requests":[],"allowed_snapshots":[snapshot],"claims":[],"receipts":[],"scope_bindings":[],"entities":[],"predicate_refs":[],"user_definitions":[],"groups":[],"entity_links":[]}});
    json!({"snapshot":snapshot,"evidence_set":es,"context":context,"user_cqs":[],"definitions":"","max_batch_utf16":24000,"max_fragments_per_batch":1})
}
fn family(e:&Value,subject:&str)->Value {
    json!({"key":"capacity","label":"Capacity","question":"What is {subject} capacity?","target":"capacity","operation":"LOOKUP","conditions":[{"text":"under video testing conditions","evidence_ids":[e]}],"evidence_ids":[e],"subjects":[{"surface":subject,"evidence_id":e,"occurrence":0,"rationale":"A source-mentioned proposed applicable subject."}]})
}
fn responses(p:&Value)->Value {
    json!(a(&p["batches"]).iter().enumerate().map(|(i,b)|json!({"batch_id":b["batch_id"],"raw":{"families":[family(&b["source_evidence_menu"][0]["evidence_id"],if i==0{"Maple"}else{"Birch"})],"unknowns":[]}})).collect::<Vec<_>>())
}
fn prepared()->Value {
    let p=scope::prepare(&input(&["🚀 Maple has capacity 10 under video testing conditions.","Birch has capacity 20 under video testing conditions."])).unwrap();
    norm::prepare(&json!({"prepared_discovery":p,"responses":responses(&p)})).unwrap()
}
fn normalized_family(p:&Value,menu_index:usize,surface:&str)->Value {
    let menu=&p["source_evidence_menu"][menu_index];let mut f=family(&menu["evidence_id"],surface);
    f["subjects"]=json!([{"surface":surface,"source_ref":menu["source_ref"],"rationale":"An exact source name; the program selects a source-mention witness without resolving identity."}]);f
}
fn normalized(p:&Value)->Value {
    let mut f=normalized_family(p,0,"Maple");
    f["subjects"].as_array_mut().unwrap().push(json!({"surface":"Birch","source_ref":p["source_evidence_menu"][1]["source_ref"],"rationale":"The same source-grounded knowledge demand with the same explicit test conditions."}));
    f["evidence_ids"]=json!(a(&p["source_evidence_menu"]).iter().map(|e|e["evidence_id"].clone()).collect::<Vec<_>>());
    f["conditions"][0]["evidence_ids"]=f["evidence_ids"].clone();
    f["origin_proposal_ids"]=json!(a(&p["proposal_manifest"]).iter().map(|p|p["proposal_id"].clone()).collect::<Vec<_>>());
    f["normalization_rationale"]=json!("Both original capacity demands retain the same explicit video conditions. Only subject mentions are generalized; measured endurance remains distinct.");
    json!({"families":[f],"unresolved":[]})
}
fn material(p:&Value,r:&Value)->Value {norm::materialize(&json!({"prepared":p,"raw":r})).unwrap()}

#[test]
fn cross_batch_global_normalization_retains_all_sources_and_uses_existing_sealed_plan() {
    let p=prepared();assert_eq!(a(&p["input"]["prepared_discovery"]["batches"]).len(),2);
    assert_eq!(p["normalized_prepared"]["batch_count"],1);assert_eq!(a(&p["source_evidence_menu"]).len(),2);
    let r=normalized(&p);let receipt=material(&p,&r);
    assert_eq!(receipt["status"],"SCOPE_NORMALIZED");assert_eq!(receipt["ready_for_scope_build"],true);
    assert_eq!(receipt["all_proposals_accounted"],true);assert_eq!(receipt["partial_plan"],Value::Null);
    assert_eq!(a(&receipt["mapping"]).len(),2);assert_eq!(a(&receipt["normalized_plan"]["tasks"]).len(),2);
    assert_eq!(receipt["mapping"][0]["normalized_families"][0]["family_id"],receipt["normalized_plan"]["families"][0]["id"]);
    assert_eq!(receipt["normalized_plan"]["subjects"].as_array().unwrap().iter().find(|s|s["surface"]=="Maple").unwrap()["anchor"]["span"]["start"],3);
    assert_eq!(receipt["semantic_faithfulness_certified"],false);assert_eq!(receipt["semantic_support_certified"],false);assert_eq!(receipt["coverage_complete"],false);
    let check=scope::execute("validate_plan",&json!({"prepared":receipt["normalized_prepared"],"responses":receipt["normalized_responses"],"plan":receipt["normalized_plan"],"current_snapshot":p["snapshot"]})).unwrap();assert_eq!(check["validated"],true);
}

#[test]
fn broken_original_anchor_is_retained_until_model_reanchors_and_final_anchor_is_strict() {
    let p=scope::prepare(&input(&["Maple has capacity. Birch has capacity."])).unwrap();let mut original=responses(&p);
    original[0]["raw"]["families"][0]["subjects"][0]["surface"]=json!("A chapter heading that is not in this fragment");
    original[0]["raw"]["families"][0]["subjects"][0]["evidence_id"]=json!("wrong_initial_id");
    assert!(scope::materialize(&json!({"prepared":p,"responses":original})).is_err());
    let prep=norm::prepare(&json!({"prepared_discovery":p,"responses":original})).unwrap();
    assert_eq!(prep["proposal_manifest"][0]["raw_family"],original[0]["raw"]["families"][0]);
    let mut f=normalized_family(&prep,0,"Maple");
    f["origin_proposal_ids"]=json!([prep["proposal_manifest"][0]["proposal_id"]]);f["normalization_rationale"]=json!("The original subject evidence ID was wrong; choose the exact Maple source mention without promoting the heading to an entity.");
    let mut output=json!({"families":[f],"unresolved":[]});assert_eq!(material(&prep,&output)["ready_for_scope_build"],true);
    output["families"][0]["subjects"][0]["surface"]=json!("Nonexistent");
    assert_eq!(norm::materialize(&json!({"prepared":prep,"raw":output})).unwrap_err().code,"FAMILY_NORMALIZE_SUBJECT_NOT_FOUND");
}

#[test]
fn every_original_proposal_must_be_accounted_and_invented_ids_cannot_hide_omission() {
    let p=prepared();let mut r=normalized(&p);r["families"][0]["origin_proposal_ids"].as_array_mut().unwrap().pop();
    assert_eq!(norm::materialize(&json!({"prepared":p,"raw":r})).unwrap_err().code,"FAMILY_NORMALIZE_PROPOSAL_UNACCOUNTED");
    r["families"][0]["origin_proposal_ids"].as_array_mut().unwrap().push(json!("invented"));
    assert_eq!(norm::materialize(&json!({"prepared":p,"raw":r})).unwrap_err().code,"FAMILY_NORMALIZE_PROPOSAL_UNKNOWN");
    r=normalized(&p);r["unresolved"]=json!([{"proposal_id":"invented","reason":"Cannot normalize it."}]);
    assert_eq!(norm::materialize(&json!({"prepared":p,"raw":r})).unwrap_err().code,"FAMILY_NORMALIZE_PROPOSAL_UNKNOWN");
}

#[test]
fn unresolved_even_if_also_mapped_blocks_full_scope_and_zero_proposals_do_not_mean_done() {
    let p=prepared();let mut r=normalized(&p);
    r["unresolved"]=json!([{"proposal_id":p["proposal_manifest"][0]["proposal_id"],"reason":"One original condition remains ambiguous; a mapping alone does not resolve it."}]);
    let receipt=material(&p,&r);assert_eq!(receipt["all_proposals_accounted"],true);assert_eq!(receipt["status"],"PARTIAL_SCOPE");
    assert_eq!(receipt["ready_for_scope_build"],false);assert_eq!(receipt["normalized_plan"],Value::Null);assert_eq!(a(&receipt["partial_plan"]["tasks"]).len(),2);
    let discovery=scope::prepare(&input(&["This source contains no discovered subject demand."])).unwrap();
    let empty=norm::prepare(&json!({"prepared_discovery":discovery,"responses":[{"batch_id":discovery["batches"][0]["batch_id"],"raw":{"families":[],"unknowns":[]}}]})).unwrap();
    let empty=material(&empty,&json!({"families":[],"unresolved":[]}));assert_eq!(empty["ready_for_scope_build"],false);assert_eq!(empty["status"],"NO_SCOPE_DISCOVERED");
}

#[test]
fn original_unknowns_are_preserved_and_one_proposal_can_split_into_distinct_targets() {
    let discovery=scope::prepare(&input(&["Maple has capacity 10 and measured endurance 8 under video testing conditions."])).unwrap();
    let mut original=responses(&discovery);original[0]["raw"]["unknowns"]=json!(["Reported test conditions are incomplete; not a universal world fact."]);
    let p=norm::prepare(&json!({"prepared_discovery":discovery,"responses":original})).unwrap();
    let mut f=normalized_family(&p,0,"Maple");f["origin_proposal_ids"]=json!([p["proposal_manifest"][0]["proposal_id"]]);f["normalization_rationale"]=json!("Split the compound source demand while preserving its stated test conditions and reported status.");
    let mut second=f.clone();second["key"]=json!("endurance");second["question"]=json!("What is {subject} measured endurance?");second["target"]=json!("measured endurance");
    let receipt=material(&p,&json!({"families":[f,second],"unresolved":[]}));
    assert_eq!(receipt["ready_for_scope_build"],true);assert_eq!(a(&receipt["mapping"][0]["normalized_families"]).len(),2);
    assert_eq!(receipt["normalized_responses"][0]["raw"]["unknowns"],original[0]["raw"]["unknowns"]);
    assert_eq!(receipt["original_unknowns"][0]["batch_id"],discovery["batches"][0]["batch_id"]);
    assert_eq!(receipt["normalized_plan"]["unknowns"][0]["reason"],original[0]["raw"]["unknowns"][0]);
}

#[test]
fn originals_prepared_raw_mapping_plan_and_current_source_are_replay_bound() {
    let p=prepared();let r=normalized(&p);let receipt=material(&p,&r);
    let validate=|p:&Value,r:&Value,receipt:&Value,snapshot:&Value|norm::execute("validate_receipt",&json!({"prepared":p,"raw":r,"receipt":receipt,"current_snapshot":snapshot}));
    assert_eq!(validate(&p,&r,&receipt,&p["snapshot"]).unwrap()["validated"],true);
    let mut graph=p["snapshot"].clone();graph["graph_revision"]=json!("published_graph_2");assert!(validate(&p,&r,&receipt,&graph).is_ok());
    let mut stale=graph.clone();stale["source_epoch"]=json!(1);assert_eq!(validate(&p,&r,&receipt,&stale).unwrap_err().code,"FAMILY_NORMALIZE_SOURCE_STALE");
    let mut changed=p.clone();changed["input"]["responses"][0]["raw"]["families"][0]["target"]=json!("endurance");assert_eq!(validate(&changed,&r,&receipt,&graph).unwrap_err().code,"FAMILY_NORMALIZE_PREPARED_CHANGED");
    let mut forged=receipt.clone();forged["mapping"][0]["normalized_families"]=json!([]);assert_eq!(validate(&p,&r,&forged,&graph).unwrap_err().code,"FAMILY_NORMALIZE_RECEIPT_CHANGED");
    forged=receipt.clone();forged["normalized_plan"]["tasks"]=json!([]);assert_eq!(validate(&p,&r,&forged,&graph).unwrap_err().code,"FAMILY_NORMALIZE_RECEIPT_CHANGED");
    let mut raw_changed=r.clone();raw_changed["families"][0]["normalization_rationale"]=json!("Changed explanation.");assert_eq!(validate(&p,&raw_changed,&receipt,&graph).unwrap_err().code,"FAMILY_NORMALIZE_RECEIPT_CHANGED");
}

#[test]
fn missing_discovery_batches_and_large_complete_menu_fail_without_subset() {
    let p=prepared();let mut missing=p["input"].clone();missing["responses"].as_array_mut().unwrap().pop();
    assert_eq!(norm::prepare(&missing).unwrap_err().code,"FAMILY_NORMALIZE_DISCOVERY_INCOMPLETE");
    let long=format!("Maple {} tail", "界".repeat(24010));let original=scope::prepare(&input(&[&long])).unwrap();
    let rows:Vec<Value>=a(&original["batches"]).iter().map(|b|json!({"batch_id":b["batch_id"],"raw":{"families":[],"unknowns":[]}})).collect();
    assert_eq!(norm::prepare(&json!({"prepared_discovery":original,"responses":rows})).unwrap_err().code,"FAMILY_NORMALIZE_REVIEW_RESOURCE_LIMIT");
}

#[test]
fn missing_source_text_cannot_be_hidden_by_complete_proposal_mapping() {
    let mut i=input(&["Maple has capacity under video testing conditions.","Birch has capacity under video testing conditions."]);
    i["evidence_set"]["fragments"].as_array_mut().unwrap().pop();
    let discovery=scope::prepare(&i).unwrap();
    let p=norm::prepare(&json!({"prepared_discovery":discovery,"responses":responses(&discovery)})).unwrap();
    let mut f=normalized_family(&p,0,"Maple");
    f["origin_proposal_ids"]=json!([p["proposal_manifest"][0]["proposal_id"]]);f["normalization_rationale"]=json!("Retain the visible proposal; another registered source is not present in this menu.");
    let receipt=material(&p,&json!({"families":[f],"unresolved":[]}));
    assert_eq!(receipt["all_proposals_accounted"],true);assert_eq!(receipt["ready_for_scope_build"],false);
    assert_eq!(receipt["normalized_plan"],Value::Null);assert_eq!(receipt["status"],"PARTIAL_SCOPE");assert_eq!(receipt["partial_plan"]["all_source_text_in_menu"],false);
}

#[test]
fn strict_json_schema_and_rationale_are_not_authority_escape_hatches() {
    let p=prepared();let mut r=normalized(&p);r["families"][0].as_object_mut().unwrap().remove("normalization_rationale");
    assert_eq!(norm::materialize(&json!({"prepared":p,"raw":r})).unwrap_err().code,"FAMILY_NORMALIZE_SHAPE_INVALID");
    r=normalized(&p);r["certified"]=json!(true);assert_eq!(norm::materialize(&json!({"prepared":p,"raw":r})).unwrap_err().code,"FAMILY_NORMALIZE_SHAPE_INVALID");
    assert_eq!(norm::materialize(&json!({"prepared":p,"raw":"{\"families\":[],\"families\":[],\"unresolved\":[]}"})).unwrap_err().code,"CORE_DUPLICATE_KEY");
    let mut original=p["input"].clone();original["responses"][0]["raw"]=json!("{\"families\":[],\"unknowns\":[],\"unknowns\":[]}");
    assert_eq!(norm::prepare(&original).unwrap_err().code,"CORE_DUPLICATE_KEY");
}

#[test]
fn full_menu_evidence_and_origin_ids_are_finite_enums_in_local_and_provider_schema() {
    let p=prepared();let schema=&p["output_schema"];
    let compiled=lightog_core::provider_schema_v1::compile_qwen(&json!({"contract_version":lightog_core::provider_schema_v1::VERSION,"name":"document_family_normalization","schema":schema})).unwrap();
    let projected=&compiled["response_format"]["json_schema"]["schema"];
    let evidence:std::collections::BTreeSet<String>=a(&p["source_evidence_menu"]).iter().map(|e|e["evidence_id"].as_str().unwrap().to_owned()).collect();
    let proposals:std::collections::BTreeSet<String>=a(&p["proposal_manifest"]).iter().map(|e|e["proposal_id"].as_str().unwrap().to_owned()).collect();
    let sources:std::collections::BTreeSet<String>=a(&p["source_text_menu"]).iter().map(|e|e["source_ref"].as_str().unwrap().to_owned()).collect();
    for path in [
        "/properties/families/items/properties/evidence_ids/items",
        "/properties/families/items/properties/conditions/items/properties/evidence_ids/items",
        "/properties/families/items/properties/subjects/items/properties/source_ref",
        "/properties/families/items/properties/origin_proposal_ids/items",
        "/properties/unresolved/items/properties/proposal_id"
    ] {
        let local=schema.pointer(path).unwrap();let remote=projected.pointer(path).unwrap();
        assert!(local["enum"].is_array(),"missing finite enum at {path}");
        let values:std::collections::BTreeSet<String>=a(&local["enum"]).iter().map(|v|v.as_str().unwrap().to_owned()).collect();
        let expected=if path.contains("proposal") {&proposals} else if path.contains("subjects") {&sources} else {&evidence};
        assert_eq!(&values,expected,"enum must contain the entire corresponding manifest at {path}");
        assert_eq!(remote["enum"],local["enum"],"provider projection lost enum at {path}");
    }
    assert_eq!(compiled["model_called"],false);assert_eq!(compiled["local_validation_required"],true);
}

#[test]
fn local_and_projected_normalization_schemas_reject_typo_ids_in_every_reference_position() {
    let p=prepared();let schema=&p["output_schema"];
    let compiled=lightog_core::provider_schema_v1::compile_qwen(&json!({"contract_version":lightog_core::provider_schema_v1::VERSION,"name":"normalization_references","schema":schema})).unwrap();
    let local=jsonschema::validator_for(schema).unwrap();let remote=jsonschema::validator_for(&compiled["response_format"]["json_schema"]["schema"]).unwrap();
    let correct=normalized(&p);assert!(local.is_valid(&correct));assert!(remote.is_valid(&correct));
    for path in ["/families/0/evidence_ids/0","/families/0/conditions/0/evidence_ids/0","/families/0/subjects/0/source_ref","/families/0/origin_proposal_ids/0"] {
        let mut typo=correct.clone();*typo.pointer_mut(path).unwrap()=json!("fine_typo_outside_current_manifest");
        assert!(!local.is_valid(&typo),"local schema accepted typo at {path}");assert!(!remote.is_valid(&typo),"provider schema accepted typo at {path}");
    }
    let mut unknown=correct.clone();unknown["unresolved"]=json!([{"proposal_id":"invented_proposal_id","reason":"A model may not fabricate a provenance reference."}]);
    assert!(!local.is_valid(&unknown));assert!(!remote.is_valid(&unknown));
}

#[test]
fn no_original_proposals_still_have_a_valid_projectable_schema_without_empty_enums() {
    let discovery=scope::prepare(&input(&["No question family has been discovered in this source."])).unwrap();
    let p=norm::prepare(&json!({"prepared_discovery":discovery,"responses":[{"batch_id":discovery["batches"][0]["batch_id"],"raw":{"families":[],"unknowns":[]}}]})).unwrap();
    let compiled=lightog_core::provider_schema_v1::compile_qwen(&json!({"contract_version":lightog_core::provider_schema_v1::VERSION,"name":"normalization_empty_manifest","schema":p["output_schema"]})).unwrap();
    let empty=json!({"families":[],"unresolved":[]});
    assert!(jsonschema::validator_for(&p["output_schema"]).unwrap().is_valid(&empty));
    assert!(jsonschema::validator_for(&compiled["response_format"]["json_schema"]["schema"]).unwrap().is_valid(&empty));
    assert_eq!(material(&p,&empty)["ready_for_scope_build"],false);
}

fn prepared_texts(texts:&[&str])->Value {
    let mut i=input(texts);i["max_fragments_per_batch"]=json!(128);
    let original=scope::prepare(&i).unwrap();norm::prepare(&json!({"prepared_discovery":original,"responses":responses(&original)})).unwrap()
}
fn located_output(p:&Value,subjects:Value)->Value {
    let mut f=normalized_family(p,0,"Maple");f["subjects"]=subjects;
    f["origin_proposal_ids"]=json!(a(&p["proposal_manifest"]).iter().map(|p|p["proposal_id"].clone()).collect::<Vec<_>>());
    f["normalization_rationale"]=json!("Authored semantic proposal; program localization proves exact source mention only, never applicability or entity identity.");
    json!({"families":[f],"unresolved":[]})
}
fn locator(surface:&str,source_ref:&str)->Value {
    json!({"surface":surface,"source_ref":source_ref,"rationale":"An authored exact source name; a citation witness does not resolve entity identity."})
}

#[test]
fn title_mention_is_bound_to_its_containing_header_fragment_not_adjacent_body_evidence() {
    let p=prepared_texts(&["🚀 Maple Relay\n\nIts measured capacity is 10 units."]);
    assert_eq!(a(&p["source_evidence_menu"]).len(),2);
    let mut output=located_output(&p,json!([locator("Maple Relay","source_0")]));
    let body=p["source_evidence_menu"][1]["evidence_id"].clone();
    output["families"][0]["evidence_ids"]=json!([body]);output["families"][0]["conditions"]=json!([]);
    let receipt=material(&p,&output);let binding=&receipt["subject_bindings"][0];
    assert_eq!(binding["request"],output["families"][0]["subjects"][0]);assert_eq!(binding["span"]["start"],3);assert_eq!(binding["span"]["end"],14);
    assert_eq!(binding["evidence_id"],p["source_evidence_menu"][0]["evidence_id"]);assert_ne!(binding["evidence_id"],body);
    assert_eq!(binding["fragment_occurrence"],0);assert_eq!(binding["identity_status"],"SOURCE_MENTION_UNRESOLVED");assert_eq!(binding["entity_ref"],Value::Null);
    assert_eq!(receipt["normalized_responses"][0]["raw"]["families"][0]["subjects"][0]["evidence_id"],binding["evidence_id"]);
    assert_eq!(receipt["normalized_plan"]["subjects"][0]["anchor"]["span"],binding["span"]);
    assert_eq!(receipt["subject_bindings_complete"],true);assert_eq!(receipt["semantic_support_certified"],false);
}

#[test]
fn all_exact_mentions_are_recorded_but_first_witness_does_not_resolve_names() {
    let p=prepared_texts(&["🚀 Maple\n\nAnother Maple occurs here.\n\nMaple occurs last."]);
    assert_eq!(a(&p["source_evidence_menu"]).len(),3);
    let output=located_output(&p,json!([locator("Maple","source_0")]));
    let receipt=material(&p,&output);let b=&receipt["subject_bindings"][0];
    assert_eq!(a(&b["mention_candidates"]).len(),3);assert_eq!(b["multiple_mentions"],true);assert_eq!(b["chosen"]["occurrence"],0);assert_eq!(b["span"]["start"],3);
    assert_eq!(b["witness_rule"],norm::WITNESS_RULE);assert_eq!(b["selection_role"],"SOURCE_MENTION_WITNESS_ONLY");
    assert_eq!(b["identity_status"],"SOURCE_MENTION_UNRESOLVED");assert_eq!(b["identity_resolution_performed"],false);assert_eq!(b["semantic_applicability_certified"],false);
    for menu_index in 0..3 {
        let candidate=&b["mention_candidates"][menu_index];assert_eq!(candidate["occurrence"],menu_index);
        assert_eq!(candidate["registered_fragments"][0]["fragment_occurrence"],0);assert_eq!(candidate["registered_fragments"][0]["evidence_id"],p["source_evidence_menu"][menu_index]["evidence_id"]);
    }
    assert_eq!(receipt["normalized_plan"]["subjects"][0]["identity_status"],"SOURCE_MENTION_UNRESOLVED");
}

#[test]
fn overlapping_exact_matches_and_utf16_offsets_are_preserved_and_locator_proof_is_sealed() {
    let p=prepared_texts(&["🚀 aaa has capacity."]);
    let output=located_output(&p,json!([locator("aa","source_0")]));
    let raw=format!(" \n{}\n ",serde_json::to_string(&output).unwrap());
    let receipt=material(&p,&json!(raw));assert_eq!(receipt["raw_response"],raw);
    assert_eq!(receipt["subject_bindings"][0]["span"]["start"],3);assert_eq!(receipt["subject_bindings"][0]["span"]["end"],5);assert_eq!(receipt["subject_bindings"][0]["fragment_occurrence"],0);
    assert_eq!(receipt["subject_bindings"][0]["mention_candidates"][1]["span"]["start"],4);assert_eq!(receipt["subject_bindings"][0]["mention_candidates"][1]["registered_fragments"][0]["fragment_occurrence"],1);
    let mut forged=receipt.clone();forged["subject_bindings"][0]["mention_candidates"].as_array_mut().unwrap().pop();
    assert_eq!(norm::execute("validate_receipt",&json!({"prepared":p,"raw":raw,"receipt":forged,"current_snapshot":p["snapshot"]})).unwrap_err().code,"FAMILY_NORMALIZE_RECEIPT_CHANGED");
}

#[test]
fn missing_exact_and_wrong_source_hold_without_fallback() {
    let p=prepared_texts(&["Maple has capacity.","Birch has capacity."]);
    for (request,code) in [
        (locator("maple","source_0"),"FAMILY_NORMALIZE_SUBJECT_NOT_FOUND"),
        (locator("Maple","source_1"),"FAMILY_NORMALIZE_SUBJECT_NOT_FOUND"),
        (locator("Maple","foreign_source"),"FAMILY_NORMALIZE_SOURCE_UNKNOWN")
    ] {
        let output=located_output(&p,json!([request]));
        let failure=norm::materialize(&json!({"prepared":p,"raw":output})).unwrap_err();assert_eq!(failure.code,code);
        let details=failure.details.unwrap();assert_eq!(details["scope_build_held"],true);assert_eq!(details["request"],request);
    }
}

#[test]
fn exact_mention_crossing_registered_fragment_boundary_is_not_synthesized_or_truncated() {
    let p=prepared_texts(&["Maple\n\nbody contains its measured capacity."]);
    let output=located_output(&p,json!([locator("Maple\n\nbody","source_0")]));
    assert_eq!(norm::materialize(&json!({"prepared":p,"raw":output})).unwrap_err().code,"FAMILY_NORMALIZE_SUBJECT_FRAGMENT_UNAVAILABLE");
}

#[test]
fn old_fragment_subject_protocol_is_not_reinterpreted_or_repaired_under_new_version() {
    let p=prepared_texts(&["Maple has capacity."]);let mut output=located_output(&p,json!([locator("Maple","source_0")]));
    output["families"][0]["subjects"]=family(&p["source_evidence_menu"][0]["evidence_id"],"Maple")["subjects"].clone();
    assert_eq!(norm::materialize(&json!({"prepared":p,"raw":output})).unwrap_err().code,"FAMILY_NORMALIZE_SHAPE_INVALID");
}

#[test]
fn old_global_occurrence_field_is_rejected_by_schema_and_core_without_reinterpretation() {
    let p=prepared_texts(&["Maple has capacity. Maple is mentioned again."]);let mut output=located_output(&p,json!([locator("Maple","source_0")]));
    output["families"][0]["subjects"][0]["occurrence"]=json!(12);
    let local=&p["output_schema"];assert!(!jsonschema::validator_for(local).unwrap().is_valid(&output));
    let compiled=lightog_core::provider_schema_v1::compile_qwen(&json!({"contract_version":lightog_core::provider_schema_v1::VERSION,"name":"no_model_count","schema":local})).unwrap();
    assert!(!jsonschema::validator_for(&compiled["response_format"]["json_schema"]["schema"]).unwrap().is_valid(&output));
    assert_eq!(norm::materialize(&json!({"prepared":p,"raw":output})).unwrap_err().code,"FAMILY_NORMALIZE_SHAPE_INVALID");
}

#[test]
fn first_exact_mention_without_registered_fragment_is_retained_while_first_registered_witness_is_chosen() {
    let text="Maple\n\nMaple has capacity.";let mut i=input(&[text]);i["max_fragments_per_batch"]=json!(128);
    i["evidence_set"]["fragments"][0]["span"]=json!({"start":7,"end":len(text),"quote":&text[7..],"offset_unit":"utf16_code_unit"});
    let original=scope::prepare(&i).unwrap();let p=norm::prepare(&json!({"prepared_discovery":original,"responses":responses(&original)})).unwrap();
    let output=located_output(&p,json!([locator("Maple","source_0")]));let receipt=material(&p,&output);let b=&receipt["subject_bindings"][0];
    assert_eq!(a(&b["mention_candidates"]).len(),2);assert_eq!(a(&b["mention_candidates"][0]["registered_fragments"]).len(),0);
    assert_eq!(b["chosen"]["occurrence"],1);assert_eq!(b["chosen"]["span"]["start"],7);assert_eq!(b["multiple_mentions"],true);
    assert_eq!(b["identity_resolution_performed"],false);assert_eq!(receipt["ready_for_scope_build"],false);assert_eq!(receipt["status"],"PARTIAL_SCOPE");
}

#[test]
fn witness_resource_overflow_holds_entire_scope_instead_of_dropping_exact_mentions() {
    let text="a".repeat(22000);let p=prepared_texts(&[&text]);
    let output=located_output(&p,json!([locator("a","source_0"),locator("a","source_0")]));
    let failure=norm::materialize(&json!({"prepared":p,"raw":output})).unwrap_err();
    assert_eq!(failure.code,"FAMILY_NORMALIZE_REVIEW_RESOURCE_LIMIT");assert_eq!(failure.details.unwrap()["scope_build_held"],true);
}
