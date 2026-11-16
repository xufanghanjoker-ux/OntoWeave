//! Synthetic support-closure and applicability counterexamples. No provider,
//! labels, archived model review or source-truth certification is used here.
use lightog_core::{
    common::{canonical_hash as hash, sha, text_sha},
    knowledge_build, semantic_review_v4 as review, support_selection,
};
use serde_json::{json, Value};
use lightog_core::{candidate_staging_v1 as staging, document_scope_v1 as scope,
    document_scope_coverage_v1 as coverage, document_family_route_v1 as route,
    incremental_graph_v1 as inc, common::{a,s}};
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
    assert_eq!(m["candidates"].as_array().unwrap().len(), 3);
    json!({"contract_version":review::VERSION,"candidates":m["candidates"],"prepared":p["prepared"],"trusted_context":p["trusted_context"],"receipts":m["receipts"],"context_evidence_ids":["mode","assertion","antecedent","condition"],"max_context_utf16":12000})
}
fn judgment(decision:&str)->Value{json!({"decision":decision,"reason":"Authored synthetic model judgment, never a semantic certificate.","evidence_ids":["assertion","mode","antecedent"]})}
fn output(q:&Value,role:&str)->Value{serde_json::from_str(q[role]["raw_output"].as_str().unwrap()).unwrap()}
fn rebind(q:&mut Value,role:&str,v:Value){let raw=serde_json::to_string(&v).unwrap();q[role]["raw_output"]=json!(raw);q[role]["review_provenance"]["review_output_sha256"]=json!(hash(&v));q[role]["review_provenance"]["raw_output_sha256"]=json!(text_sha(&raw));}
fn complete(f:&Value)->Value{let mut q=proposal(f);let ready=review::execute("prepare",&q).unwrap();q["manifest"]=ready["manifest"].clone();for(role,key)in[("structure","structure_review"),("narrative","narrative_review")]{let rows:Vec<_>=ready[role]["review_view"].as_array().unwrap().iter().map(|v|{let mut row=json!({"candidate_id":v["candidate_id"],"decision":"SUPPORTED","readback":v["readback_expectation"]});if role=="structure"{let dims:serde_json::Map<_,_>=review::DIMENSIONS.iter().map(|d|((*d).to_owned(),judgment(if *d=="units"{"NOT_APPLICABLE"}else{"SUPPORTED"}))).collect();row["dimensions"]=json!(dims);}else{row["description_support"]=judgment("SUPPORTED");row["condition_exception_fidelity"]=judgment("SUPPORTED");row["structure_description_consistency"]=judgment("CONSISTENT");}row}).collect();let parsed=json!({"reviews":rows});let raw=serde_json::to_string(&parsed).unwrap();q[key]=json!({"manifest":ready[role]["manifest"],"raw_output":raw,"review_provenance":{"origin":"SYNTHETIC","review_request_id":format!("review-{role}"),"proposal_request_ids":["proposal"],"review_output_sha256":hash(&parsed),"raw_output_sha256":text_sha(&raw),"model":"authored-split-fixture","config_revision":1}});}q}

fn case() -> Value {
    let mut f=fixture();
    for i in 1..3 {
        let mut c=f["raw"]["candidates"][0].clone();
        c["predicate"]["label"]=json!(format!("authored variant {i}"));
        c["description"]=json!(format!("Authored variant {i} of the index statement."));
        f["raw"]["candidates"].as_array_mut().unwrap().push(c);
    }
    let mut review=complete(&f);
    // Both raw judgments say SUPPORTED, but the local positive-role reference
    // gate holds the third candidate. Partial publication may not promote it.
    let mut raw=output(&review,"structure_review");
    raw["reviews"][2]["dimensions"]["units"]["evidence_ids"]=json!([]);
    rebind(&mut review,"structure_review",raw);
    let mut stage=review.clone();
    for key in ["manifest","structure_review","narrative_review"] {stage.as_object_mut().unwrap().remove(key);}
    stage["contract_version"]=json!(staging::VERSION);
    let snapshot=f["trusted_context"]["examples"]["es"]["snapshot"].clone();
    let ledger=inc::execute("init",&json!({"contract_version":inc::VERSION,"task_ref":"partial-job","source_snapshot":snapshot,"plan_sha256":"authored-plan","batch_count":1})).unwrap();
    let ledger=inc::execute("append",&json!({"ledger":ledger,"batch_index":0,"status":"ACCOUNTED","request_id":"proposal","staging_input":stage})).unwrap()["ledger"].clone();
    let assessment=json!({"ledger":ledger,"current_snapshot":snapshot,"materialization_reports":[{"batch_index":0,"status":"PERSISTED","candidates_sha256":hash(&review["candidates"]),"quarantined":[{"fact_index":3,"error_code":"FACT_ENTITY_REFERENCE_UNRESOLVED"}],"source_refs":["src"]}],"review_bundles":[{"batch_index":0,"review_input":review}],"human_decisions":[],"recovery_bundles":[],"trusted_context":f["trusted_context"]});
    let admitted=inc::execute("assess_partial_publication",&assessment).unwrap();
    assert_eq!(admitted["ready_for_scope_review"],true);
    assert_eq!(a(&admitted["eligible_candidates"]).len(),2);
    let es=&f["trusted_context"]["examples"]["es"];
    let sp=scope::prepare(&json!({"snapshot":snapshot,"evidence_set":es,"context":f["trusted_context"],"user_cqs":[],"definitions":"","max_batch_utf16":24000,"max_fragments_per_batch":64})).unwrap();
    let ev=&sp["batches"][0]["source_evidence_menu"][0]["evidence_id"];
    let families:Vec<_>=(0..16).map(|i|json!({"key":format!("family-{i}"),"label":format!("Authored family {i}"),"question":format!("What authored behavior {i} applies to {{subject}}?"),"target":format!("behavior-{i}"),"operation":"LOOKUP","conditions":[],"evidence_ids":[ev],"subjects":[{"surface":"Alpha","evidence_id":ev,"occurrence":0,"rationale":"Authored subject mention."}]})).collect();
    let plan=scope::materialize(&json!({"prepared":sp,"responses":[{"batch_id":sp["batches"][0]["batch_id"],"raw":{"families":families,"unknowns":[]}}]})).unwrap();
    let menu:Vec<_>=a(&es["fragments"]).iter().map(|e|json!({"evidence_id":e["id"],"source_ref":e["source_ref"],"source_revision":e["source_revision"],"span":e["span"]})).collect();
    let candidates:Vec<_>=a(&admitted["eligible_candidates"]).iter().map(|c|{let mut c=c.clone();c["id"]=c["candidate_id"].clone();c}).collect();
    let input=json!({"plan":plan,"snapshot":snapshot,"evidence_menu":menu,"candidates":candidates,"readiness_policy":coverage::PARTIAL_POLICY,"admission_input":assessment});
    let project=inc::execute("project",&json!({"ledger":ledger,"trusted_context":f["trusted_context"]})).unwrap();
    let write_set=json!({"contract_version":lightog_core::source_learning_v1::BUNDLE_VERSION,"source_scope":{"base_ref":snapshot["base_ref"],"source_epoch":snapshot["source_epoch"],"sources":snapshot["sources"]},"read_snapshot":snapshot,"builds":[{"task_ref":"partial-job","graph":project["build"]["graph"],"profiles":project["build"]["profiles"],"evidence_sets":[es],"gate_input_sha256":"a".repeat(64),"gate_result_sha256":"b".repeat(64)}]});
    json!({"input":input,"assessment":assessment,"candidate_write_set":write_set})
}
fn scoped(c:&Value)->Value {
    let prepared=coverage::prepare(&c["input"]).unwrap();
    assert_eq!(a(&prepared["review_tasks"]).len(),16);
    let candidate=&prepared["candidates"][0];
    let rows:Vec<_>=a(&prepared["review_tasks"]).iter().enumerate().map(|(i,t)|json!({"task_id":t["id"],"decision":if i==0{"SUPPORTED"}else if i==1{"SOURCE_INSUFFICIENT"}else if i==2{"EXTRACTION_GAP"}else{"UNKNOWN"},"candidate_ids":if i==0{json!([candidate["id"]])}else{json!([])},"evidence_ids":if i<3{candidate["evidence_ids"].clone()}else{json!([])},"reason":"Authored per-task judgment, not a truth certificate."})).collect();
    let raw=json!({"rows":rows});
    let receipt=coverage::materialize(&json!({"prepared":prepared,"raw":raw})).unwrap();
    json!({"assessment_input":c["assessment"],"candidate_write_set":c["candidate_write_set"],"coverage_prepared":prepared,"coverage_raw":raw,"coverage_receipt":receipt})
}

#[test]
fn admission_is_replayed_but_is_not_scope_readiness_or_atomic_publication() {
    let c=case();
    let admitted=inc::execute("assess_partial_publication",&c["assessment"]).unwrap();
    assert_eq!(admitted["ready_for_index"],false);
    assert_eq!(a(&admitted["eligible_candidate_ids"]).len(),2);
    assert_eq!(admitted["incomplete_blockers"],json!(["MATERIALIZATION_QUARANTINE","SEMANTIC_DECISIONS_PENDING"]));
    assert_eq!(inc::execute("assess_publication",&c["assessment"]).unwrap()["ready_for_index"],false);
    assert!(inc::execute("partial_formal_bundle",&json!({"assessment_input":c["assessment"],"candidate_write_set":c["candidate_write_set"]})).is_err());
    for mode in 0..4 {
        let mut i=c["input"].clone();
        match mode {0=>i["candidates"][0]["description"]=json!("rewritten"),1=>{i["candidates"].as_array_mut().unwrap().pop();},2=>i["admission_input"]["review_bundles"][0]["review_input"]["structure_review"]["raw_output"]=json!("{}"),_=>i["candidates"][0]["evidence_ids"]=json!(["condition"])}
        assert!(coverage::prepare(&i).is_err(),"admission tamper {mode}");
    }
}
#[test]
fn partial_receipt_keeps_all_tasks_and_only_publishes_supported_row_subset() {
    let c=case();let p=scoped(&c);let r=&p["coverage_receipt"];
    assert_eq!(r["contract_version"],coverage::PARTIAL_VERSION);
    assert_eq!(r["readiness_status"],"PARTIAL_READY");assert_eq!(r["partial_ready"],true);
    assert_eq!(r["ready_for_publication"],false);assert_eq!(r["coverage_complete"],false);
    assert_eq!(a(&r["rows"]).len(),16);assert_eq!(a(&r["supported_task_ids"]).len(),1);
    assert_eq!(a(&r["source_insufficient_task_ids"]).len(),1);assert_eq!(a(&r["unresolved_task_ids"]).len(),14);
    assert_eq!(a(&r["publishable_candidate_ids"]).len(),1);
    let out=inc::execute("partial_formal_bundle",&p).unwrap();
    assert_eq!(out["publication_mode"],"PARTIAL_SCOPE");
    assert_eq!(a(&out["write_set"]["builds"][0]["graph"]["candidate_archive"]).len(),1);
    assert_eq!(out["published_candidate_ids"],r["publishable_candidate_ids"]);
    let mut confirm=p.clone();confirm["candidate_build"]=out["write_set"]["builds"][0].clone();
    confirm["candidate_graph_revision"]=out["write_set"]["output_graph_revision"].clone();
    confirm["index_ack"]=json!({"status":"READY","task_ref":"partial-job","graph_revision":confirm["candidate_graph_revision"],"index_payload_sha256":"c".repeat(64),"backend":"LEXICAL"});
    let committed=inc::execute("confirm_partial_publication",&confirm).unwrap();
    assert_eq!(committed["publication_receipt"]["whole_scope_complete"],false);
    assert_eq!(committed["publication_receipt"]["reusable_task_ids"],r["supported_task_ids"]);
    confirm["candidate_build"]=c["candidate_write_set"]["builds"][0].clone();
    assert_eq!(inc::execute("confirm_partial_publication",&confirm).unwrap_err().code,"INCREMENTAL_FORMAL_INDEX_REBUILD_REQUIRED");
}
#[test]
fn partial_route_reuses_only_current_supported_tasks() {
    let c=case();let p=scoped(&c);let receipt=&p["coverage_receipt"];
    let routep=route::prepare(&json!({"plan":c["input"]["plan"],"snapshot":c["input"]["snapshot"],"question":"Authored same-family paraphrase","coverage_receipt":receipt})).unwrap();
    let t=&c["input"]["plan"]["tasks"][0];
    let raw=json!({"route":"SAME_SCOPE_REUSE","family_ids":[t["family_id"]],"subject_ids":[t["subject_id"]],"task_ids":[t["id"]],"reason":"Authored route."});
    assert_eq!(route::materialize(&json!({"prepared":routep,"raw":raw})).unwrap()["reuse_eligible"],true);
    for i in 1..16 {
        let t=&c["input"]["plan"]["tasks"][i];
        let mut r=raw.clone();r["family_ids"]=json!([t["family_id"]]);r["subject_ids"]=json!([t["subject_id"]]);r["task_ids"]=json!([t["id"]]);
        assert_eq!(route::materialize(&json!({"prepared":routep,"raw":r})).unwrap_err().code,"FAMILY_ROUTE_REUSE_NOT_COVERED");
    }
}
#[test]
fn incomplete_source_missing_rows_unknown_or_changed_proof_cannot_publish() {
    let c=case();let p=scoped(&c);
    for mode in 0..5 {
        let mut q=p.clone();
        match mode {0=>{q["coverage_raw"]["rows"].as_array_mut().unwrap().pop();},1=>q["coverage_receipt"]["publishable_candidate_ids"]=c["input"]["candidates"].as_array().unwrap().iter().map(|v|v["id"].clone()).collect(),2=>q["assessment_input"]["current_snapshot"]["source_epoch"]=json!(1),3=>q["coverage_prepared"]["input"]["admission_input"]["review_bundles"]=json!([]),_=>q["candidate_write_set"]["source_scope"]["source_epoch"]=json!(1)}
        assert!(inc::execute("partial_formal_bundle",&q).is_err(),"partial publication tamper {mode}");
    }
    let mut input=c["input"].clone();input["evidence_menu"].as_array_mut().unwrap().pop();
    let prepared=coverage::prepare(&input).unwrap();assert_eq!(prepared["source_menu_complete"],false);
    let r=coverage::materialize(&json!({"prepared":prepared,"raw":p["coverage_raw"]})).unwrap();
    assert_eq!(r["partial_ready"],false);assert_eq!(r["reusable_task_ids"],json!([]));
    let mut raw=p["coverage_raw"].clone();raw["rows"][0]["decision"]=json!("UNKNOWN");raw["rows"][0]["candidate_ids"]=json!([]);
    let r=coverage::materialize(&json!({"prepared":p["coverage_prepared"],"raw":raw})).unwrap();
    assert_eq!(r["partial_ready"],false);assert_eq!(r["readiness_status"],"BLOCKED");
}
#[test]
fn operator_confirmation_cannot_promote_role_held_candidate_in_partial_mode() {
    let c=case();let mut assessment=c["assessment"].clone();
    let human=inc::execute("decide_human",&json!({"ledger":assessment["ledger"],"batch_index":0,"review_input":assessment["review_bundles"][0]["review_input"],"current_snapshot":assessment["current_snapshot"],"candidate_id":assessment["ledger"]["entries"][0]["candidates"][2]["candidate_id"],"action":"CONFIRM_SUPPORT","actor":"LOCAL_OPERATOR","reason":"Authored operator assertion."})).unwrap();
    assessment["human_decisions"]=json!([human["decision"]]);
    let out=inc::execute("assess_partial_publication",&assessment).unwrap();
    assert_eq!(a(&out["eligible_candidate_ids"]).len(),2);assert_eq!(out["coverage"]["held_candidates"],1);
    assessment["human_decisions"][0]["review_receipt_sha256"]=json!("0".repeat(64));
    assert_eq!(inc::execute("assess_partial_publication",&assessment).unwrap_err().code,"INCREMENTAL_HUMAN_BINDING_CHANGED");
}
#[test]
fn exclusion_and_deferral_remove_locally_supported_atoms_and_hard_source_checks_remain() {
    let c=case();
    for action in ["EXCLUDE","DEFER"] {
        let mut input=c["assessment"].clone();
        let human=inc::execute("decide_human",&json!({"ledger":input["ledger"],"batch_index":0,"review_input":input["review_bundles"][0]["review_input"],"current_snapshot":input["current_snapshot"],"candidate_id":input["ledger"]["entries"][0]["candidates"][0]["candidate_id"],"action":action,"actor":"LOCAL_OPERATOR","reason":"Authored operator hold."})).unwrap();
        input["human_decisions"]=json!([human["decision"]]);
        assert_eq!(a(&inc::execute("assess_partial_publication",&input).unwrap()["eligible_candidate_ids"]).len(),1);
    }
    for mode in 0..3 {
        let mut input=c["assessment"].clone();
        match mode {0=>input["current_snapshot"]["source_epoch"]=json!(9),1=>input["materialization_reports"]=json!([]),_=>input["review_bundles"]=json!([])}
        let out=inc::execute("assess_partial_publication",&input).unwrap();
        assert_eq!(out["ready_for_scope_review"],false);assert_eq!(out["ready_for_index"],false);
        assert!(!a(&out["hard_blockers"]).is_empty());assert_eq!(out["eligible_candidate_ids"],json!([]));
    }
}
#[test]
fn all_declared_supported_or_source_insufficient_keeps_finite_states_without_whole_scope_claim() {
    let c=case();let p=scoped(&c);
    for insufficient in [false,true] {
        let mut raw=p["coverage_raw"].clone();
        for row in raw["rows"].as_array_mut().unwrap() {
            row["decision"]=json!("SUPPORTED");row["candidate_ids"]=p["coverage_raw"]["rows"][0]["candidate_ids"].clone();
            row["evidence_ids"]=p["coverage_raw"]["rows"][0]["evidence_ids"].clone();
        }
        if insufficient {raw["rows"][1]["decision"]=json!("SOURCE_INSUFFICIENT");raw["rows"][1]["candidate_ids"]=json!([]);}
        let r=coverage::materialize(&json!({"prepared":p["coverage_prepared"],"raw":raw})).unwrap();
        assert_eq!(r["ready_for_publication"],true);assert_eq!(r["partial_ready"],true);
        assert_eq!(r["readiness_status"],if insufficient{"LIMITED_AVAILABLE"}else{"READY"});
        assert_eq!(r["coverage_complete"],false);assert_eq!(a(&r["reusable_task_ids"]).len(),if insufficient{15}else{16});
    }
}

fn state_prepared(c:&Value)->Value {
    let mut input=c["input"].clone();input["review_protocol"]=json!(coverage::STATES_PROTOCOL);
    coverage::prepare(&input).unwrap()
}
fn state_rows(p:&Value)->Value {
    let candidates=a(&p["candidates"]);let evidence=candidates[0]["evidence_ids"].clone();
    let mut rows:Vec<_>=a(&p["review_tasks"]).iter().map(|t|json!({"task_id":t["id"],"source_evidence_state":"ANSWER_PRESENT","candidate_answer_state":"ABSENT","candidate_ids":[],"evidence_ids":evidence,"reason":"Authored complete source answer is not represented by an eligible candidate."})).collect();
    for i in [0,1,4,6,7] {rows[i]["candidate_ids"]=json!([candidates[i%2]["id"]]);rows[i]["evidence_ids"]=candidates[i%2]["evidence_ids"].clone();rows[i]["candidate_answer_state"]=json!("COMPLETE");}
    rows[1]["candidate_answer_state"]=json!("PARTIAL");rows[1]["reason"]=json!("The original source has the complete answer, while these candidates represent only 2 of 6 required parts. A full source quotation does not complete the candidate answer.");
    rows[3]["source_evidence_state"]=json!("INSUFFICIENT");
    rows[4]["source_evidence_state"]=json!("UNKNOWN");
    rows[5]["candidate_answer_state"]=json!("UNKNOWN");
    rows[6]["source_evidence_state"]=json!("INSUFFICIENT");
    rows[7]["evidence_ids"].as_array_mut().unwrap().push(json!("condition"));
    rows[8]["source_evidence_state"]=json!("INSUFFICIENT");rows[8]["candidate_answer_state"]=json!("PARTIAL");rows[8]["candidate_ids"]=json!([candidates[1]["id"]]);rows[8]["reason"]=json!("The inspected source and admitted candidate contain only a bounded portion, not the complete task answer.");
    rows[9]["source_evidence_state"]=json!("INSUFFICIENT");rows[9]["candidate_answer_state"]=json!("UNKNOWN");
    json!({"rows":rows})
}
#[test]
fn source_and_candidate_axes_derive_full_task_states_without_promoting_two_of_six() {
    let c=case();let p=state_prepared(&c);let raw=state_rows(&p);
    assert_eq!(p["contract_version"],coverage::STATES_VERSION);assert_eq!(p["review_protocol"],coverage::STATES_PROTOCOL);
    assert_eq!(p["output_schema"]["properties"]["rows"]["minItems"],16);
    assert!(p["output_schema"]["properties"]["rows"]["items"]["properties"].get("decision").is_none());
    assert!(jsonschema::validator_for(&p["output_schema"]).unwrap().is_valid(&raw));
    let r=coverage::materialize(&json!({"prepared":p,"raw":raw})).unwrap();
    assert_eq!(r["rows"],raw["rows"]);assert_eq!(a(&r["rows"]).len(),16);
    for (i,state) in [(0,"SUPPORTED"),(1,"EXTRACTION_GAP"),(2,"EXTRACTION_GAP"),(3,"SOURCE_INSUFFICIENT"),(4,"UNKNOWN"),(5,"UNKNOWN"),(6,"PROTOCOL_HOLD"),(7,"PROTOCOL_HOLD"),(8,"SOURCE_INSUFFICIENT"),(9,"UNKNOWN")] {
        assert_eq!(r["row_observations"][i]["effective_status"],state,"row {i}");
    }
    assert_eq!(a(&r["supported_task_ids"]).len(),1);assert_eq!(a(&r["protocol_held_task_ids"]).len(),2);
    assert_eq!(r["row_observations"][6]["error_codes"],json!(["SCOPE_COVERAGE_STATES_CONTRADICT"]));
    assert_eq!(r["row_observations"][7]["error_codes"],json!(["SCOPE_COVERAGE_SUPPORTED_EVIDENCE_NOT_DECLARED"]));
    assert!(r["row_observations"][7]["derived_decision"].is_null());
    assert_eq!(r["rows"][7]["candidate_answer_state"],"COMPLETE");assert_eq!(r["rows"][7]["evidence_ids"],raw["rows"][7]["evidence_ids"]);
    assert_eq!(r["partial_ready"],true);assert_eq!(r["ready_for_publication"],false);assert_eq!(r["semantic_support_certified"],false);
}
#[test]
fn states_reference_errors_are_task_holds_and_not_source_insufficiency_or_raw_repairs() {
    let c=case();let p=state_prepared(&c);let mut raw=state_rows(&p);
    raw["rows"][8]["candidate_answer_state"]=json!("COMPLETE");raw["rows"][8]["candidate_ids"]=json!(["foreign_candidate"]);
    raw["rows"][9]["evidence_ids"]=json!(["foreign_evidence"]);
    raw["rows"][10]["candidate_answer_state"]=json!("PARTIAL");
    raw["rows"][11]["candidate_ids"]=json!([p["candidates"][0]["id"]]);
    raw["rows"][12]["evidence_ids"]=json!(["condition","condition"]);
    raw["rows"][13]["evidence_ids"]=json!([]);
    let r=coverage::materialize(&json!({"prepared":p,"raw":raw})).unwrap();
    assert_eq!(r["rows"],raw["rows"]);
    for i in 8..14 {assert_eq!(r["row_observations"][i]["effective_status"],"PROTOCOL_HOLD");assert_eq!(r["row_observations"][i]["protocol_valid"],false);assert!(!a(&r["source_insufficient_task_ids"]).contains(&raw["rows"][i]["task_id"]));}
    assert_eq!(a(&r["supported_task_ids"]).len(),1);
}
#[test]
fn states_global_task_shape_source_and_admission_changes_still_reject_everything() {
    let c=case();let p=state_prepared(&c);let raw=state_rows(&p);
    for mode in 0..5 {
        let mut q=raw.clone();
        match mode {0=>{q["rows"].as_array_mut().unwrap().pop();},1=>q["rows"][1]=q["rows"][0].clone(),2=>q["rows"][0]["decision"]=json!("SUPPORTED"),3=>q["rows"][0]["source_evidence_state"]=json!("UNINSPECTED"),_=>q["rows"][0]["candidate_ids"]=Value::Null}
        assert!(coverage::materialize(&json!({"prepared":p,"raw":q})).is_err(),"global failure {mode}");
    }
    for mode in 0..2 {let mut q=p.clone();if mode==0 {q["input"]["snapshot"]["source_epoch"]=json!(3);}else{q["input"]["admission_input"]["review_bundles"]=json!([]);}assert!(coverage::materialize(&json!({"prepared":q,"raw":raw})).is_err());}
    let old=coverage::prepare(&c["input"]).unwrap();
    assert_eq!(old["contract_version"],coverage::PARTIAL_VERSION);assert!(coverage::materialize(&json!({"prepared":old,"raw":raw})).is_err());
}
#[test]
fn states_receipts_formal_subset_and_routes_replay_effective_support_only() {
    let c=case();let prepared=state_prepared(&c);let raw=state_rows(&prepared);let raw_text=raw.to_string();
    let receipt=coverage::materialize(&json!({"prepared":prepared,"raw":raw_text})).unwrap();
    let validated=coverage::execute("validate_receipt",&json!({"prepared":prepared,"raw":raw_text,"receipt":receipt,"current_snapshot":c["input"]["snapshot"]})).unwrap();
    assert_eq!(validated["row_observations"],receipt["row_observations"]);assert_eq!(receipt["raw_text_sha256"],text_sha(&raw_text));
    let p=json!({"assessment_input":c["assessment"],"candidate_write_set":c["candidate_write_set"],"coverage_prepared":prepared,"coverage_raw":raw_text,"coverage_receipt":receipt});
    let out=inc::execute("partial_formal_bundle",&p).unwrap();
    assert_eq!(out["review_protocol"],coverage::STATES_PROTOCOL);assert_eq!(out["protocol_held_task_ids"],receipt["protocol_held_task_ids"]);
    assert_eq!(a(&out["write_set"]["builds"][0]["graph"]["candidate_archive"]).len(),1);
    let mut confirm=p.clone();confirm["candidate_build"]=out["write_set"]["builds"][0].clone();confirm["candidate_graph_revision"]=out["write_set"]["output_graph_revision"].clone();
    confirm["index_ack"]=json!({"status":"READY","task_ref":"partial-job","graph_revision":confirm["candidate_graph_revision"],"index_payload_sha256":"c".repeat(64),"backend":"LEXICAL"});
    assert_eq!(inc::execute("confirm_partial_publication",&confirm).unwrap()["publication_receipt"]["review_protocol"],coverage::STATES_PROTOCOL);
    let routep=route::prepare(&json!({"plan":c["input"]["plan"],"snapshot":c["input"]["snapshot"],"question":"Authored new paraphrase","coverage_receipt":receipt})).unwrap();
    for i in 0..16 {
        let t=&c["input"]["plan"]["tasks"][i];let r=json!({"route":"SAME_SCOPE_REUSE","family_ids":[t["family_id"]],"subject_ids":[t["subject_id"]],"task_ids":[t["id"]],"reason":"Authored candidate route."});
        assert_eq!(route::materialize(&json!({"prepared":routep,"raw":r})).is_ok(),i==0,"only COMPLETE effective support is reusable: {i}");
    }
    let mut tampered=p.clone();tampered["coverage_receipt"]["row_observations"][7]["protocol_valid"]=json!(true);tampered["coverage_receipt"]["row_observations"][7]["derived_decision"]=json!("SUPPORTED");
    assert!(inc::execute("partial_formal_bundle",&tampered).is_err());
}
#[test]
fn original_answer_present_without_complete_candidates_is_never_source_insufficient_or_ready() {
    let c=case();let prepared=state_prepared(&c);let mut raw=state_rows(&prepared);
    for row in raw["rows"].as_array_mut().unwrap() {row["source_evidence_state"]=json!("ANSWER_PRESENT");row["candidate_answer_state"]=json!("ABSENT");row["candidate_ids"]=json!([]);row["evidence_ids"]=prepared["candidates"][0]["evidence_ids"].clone();}
    let r=coverage::materialize(&json!({"prepared":prepared,"raw":raw})).unwrap();
    assert_eq!(a(&r["extraction_gap_task_ids"]).len(),16);assert_eq!(r["source_insufficient_task_ids"],json!([]));assert_eq!(r["partial_ready"],false);assert_eq!(r["publishable_candidate_ids"],json!([]));
}
fn audit_input(c:&Value)->Value {
    let p=&c["assessment"];
    json!({"ledger":p["ledger"],"batch_index":0,"candidate_id":p["ledger"]["entries"][0]["candidates"][0]["candidate_id"],"review_input":p["review_bundles"][0]["review_input"],"current_snapshot":p["current_snapshot"],"actor":"ASSISTANT_SOURCE_AUDIT","action":"DEFER","reason":"Authored source audit: the asserted actor remains unresolved; preserve the original model review and defer publication."})
}
#[test]
fn source_audit_deferral_only_removes_admission_without_rewriting_model_or_human_reviews() {
    let c=case();let audit=inc::execute("defer_source_audit",&audit_input(&c)).unwrap();
    assert_eq!(audit["source_audit_only"],true);assert!(audit["decision"]["decision_id"].as_str().unwrap().starts_with("saud_"));
    let mut assessment=c["assessment"].clone();assessment["source_audit_deferrals"]=json!([audit["decision"]]);
    for op in ["assess_publication","assess_partial_publication"] {
        let result=inc::execute(op,&assessment).unwrap();
        assert_eq!(result["coverage"]["accepted_candidates"],1);assert_eq!(result["coverage"]["held_candidates"],2);
        assert_eq!(result["coverage"]["human_decisions"],0);assert_eq!(result["coverage"]["source_audit_deferrals"],1);
        assert_eq!(result["source_audit_deferrals_sha256"],hash(&assessment["source_audit_deferrals"]));
    }
    let original=inc::execute("review_batch",&json!({"ledger":assessment["ledger"],"batch_index":0,"review_input":assessment["review_bundles"][0]["review_input"]})).unwrap();
    assert_eq!(original["decisions"][0]["status"],"MODEL_SUPPORTED");
    assert_eq!(assessment["review_bundles"],c["assessment"]["review_bundles"]);
    let mut user=audit_input(&c);user["actor"]=json!("LOCAL_OPERATOR");user["action"]=json!("CONFIRM_SUPPORT");
    let human=inc::execute("decide_human",&user).unwrap();assessment["human_decisions"]=json!([human["decision"]]);
    let result=inc::execute("assess_partial_publication",&assessment).unwrap();
    assert_eq!(result["coverage"]["accepted_candidates"],1);assert_eq!(result["coverage"]["human_decisions"],1);assert_eq!(result["coverage"]["source_audit_deferrals"],1);
    let mut input=c["input"].clone();input["review_protocol"]=json!(coverage::STATES_PROTOCOL);input["admission_input"]=assessment.clone();
    input["candidates"].as_array_mut().unwrap().retain(|candidate|candidate["id"]!=audit["decision"]["candidate_id"]);
    let prepared=coverage::prepare(&input).unwrap();let candidate=&prepared["candidates"][0];
    let mut rows:Vec<_>=a(&prepared["review_tasks"]).iter().map(|t|json!({"task_id":t["id"],"source_evidence_state":"ANSWER_PRESENT","candidate_answer_state":"ABSENT","candidate_ids":[],"evidence_ids":candidate["evidence_ids"],"reason":"Authored remaining source task has no complete eligible answer."})).collect();
    rows[0]["candidate_answer_state"]=json!("COMPLETE");rows[0]["candidate_ids"]=json!([candidate["id"]]);
    let raw=json!({"rows":rows});let receipt=coverage::materialize(&json!({"prepared":prepared,"raw":raw})).unwrap();
    let p=json!({"assessment_input":assessment,"candidate_write_set":c["candidate_write_set"],"coverage_prepared":prepared,"coverage_raw":raw,"coverage_receipt":receipt});
    let formal=inc::execute("partial_formal_bundle",&p).unwrap();
    assert_eq!(formal["source_audit_deferrals_sha256"],hash(&assessment["source_audit_deferrals"]));
    assert_eq!(formal["published_candidate_ids"],json!([candidate["id"]]));
    assert!(!a(&formal["published_candidate_ids"]).contains(&audit["decision"]["candidate_id"]));
}
#[test]
fn source_audit_cannot_upgrade_and_replays_candidate_source_entry_and_review_bindings() {
    let c=case();let input=audit_input(&c);
    for mode in 0..4 {let mut p=input.clone();match mode {0=>p["action"]=json!("CONFIRM_SUPPORT"),1=>p["action"]=json!("EXCLUDE"),2=>p["actor"]=json!("LOCAL_OPERATOR"),_=>p["extra"]=json!(true)}assert!(inc::execute("defer_source_audit",&p).is_err());}
    let audit=inc::execute("defer_source_audit",&input).unwrap();
    for field in ["candidate_sha256","entry_sha256","source_snapshot_sha256","review_receipt_sha256","action","actor","candidate_id"] {
        let mut d=audit["decision"].clone();d[field]=if field=="action"{json!("CONFIRM_SUPPORT")}else if field=="actor"{json!("LOCAL_OPERATOR")}else if field=="candidate_id"{json!("foreign_candidate")}else{json!("0".repeat(64))};
        d.as_object_mut().unwrap().remove("decision_id");d["decision_id"]=json!(format!("saud_{}",&hash(&d)[..32]));
        let mut p=c["assessment"].clone();p["source_audit_deferrals"]=json!([d]);
        assert!(inc::execute("assess_partial_publication",&p).is_err(),"audit binding {field}");
    }
    let mut p=c["assessment"].clone();p["human_decisions"]=json!([audit["decision"]]);
    assert!(inc::execute("assess_partial_publication",&p).is_err(),"assistant audit is not a human decision");
}

fn scope_audit_case()->Value {
    let c=case();let prepared=state_prepared(&c);let mut raw=state_rows(&prepared);
    for row in raw["rows"].as_array_mut().unwrap(){row["source_evidence_state"]=json!("ANSWER_PRESENT");row["candidate_answer_state"]=json!("ABSENT");row["candidate_ids"]=json!([]);row["evidence_ids"]=prepared["candidates"][0]["evidence_ids"].clone();}
    for i in 0..3 {let candidate=&prepared["candidates"][i%2];raw["rows"][i]["candidate_answer_state"]=json!("COMPLETE");raw["rows"][i]["candidate_ids"]=json!([candidate["id"]]);raw["rows"][i]["evidence_ids"]=candidate["evidence_ids"].clone();}
    let receipt=coverage::materialize(&json!({"prepared":prepared,"raw":raw})).unwrap();
    json!({"assessment_input":c["assessment"],"candidate_write_set":c["candidate_write_set"],"coverage_prepared":prepared,"coverage_raw":raw,"coverage_receipt":receipt})
}
fn scope_audit_decision(p:&Value,index:usize)->Value {
    inc::execute("defer_scope_task",&json!({"coverage_prepared":p["coverage_prepared"],"coverage_raw":p["coverage_raw"],"coverage_receipt":p["coverage_receipt"],"current_snapshot":p["assessment_input"]["current_snapshot"],"task_id":p["coverage_prepared"]["review_tasks"][index]["id"],"reason":"Assistant source audit: condition applicability is unresolved; preserve the valid fact and original model output.","actor":"ASSISTANT_SCOPE_AUDIT","action":"DEFER"})).unwrap()["decision"].clone()
}
#[test]
fn scope_task_defer_only_subtracts_tasks_and_rebuilds_their_candidate_union_without_raw_changes() {
    let mut p=scope_audit_case();let raw=p["coverage_raw"].clone();let receipt=p["coverage_receipt"].clone();
    assert_eq!(a(&receipt["reusable_task_ids"]).len(),3);
    let original=inc::execute("partial_formal_bundle",&p).unwrap();
    let mut empty=p.clone();empty["task_scope_deferrals"]=json!([]);assert_eq!(inc::execute("partial_formal_bundle",&empty).unwrap(),original);
    let decision=scope_audit_decision(&p,1);assert!(s(&decision["decision_id"]).starts_with("scaud_"));
    assert_eq!(decision["actor"],"ASSISTANT_SCOPE_AUDIT");assert_eq!(decision["action"],"DEFER");
    p["task_scope_deferrals"]=json!([decision]);let restriction=inc::execute("restrict_scope_tasks",&p).unwrap();
    assert_eq!(a(&restriction["reusable_task_ids"]).len(),2);assert_eq!(a(&restriction["supported_task_ids"]).len(),2);
    assert_eq!(a(&restriction["publishable_candidate_ids"]).len(),1);assert_eq!(a(&restriction["unresolved_task_ids"]).len(),14);
    assert_eq!(restriction["task_count"],16);assert_eq!(restriction["audit_deferred_task_ids"],json!([p["coverage_prepared"]["review_tasks"][1]["id"]]));
    let out=inc::execute("partial_formal_bundle",&p).unwrap();assert_eq!(out["scope_task_restriction"],restriction);
    assert_eq!(a(&original["write_set"]["builds"][0]["graph"]["candidate_archive"]).len(),2);
    assert_eq!(a(&out["write_set"]["builds"][0]["graph"]["candidate_archive"]).len(),1);
    assert_ne!(out["write_set"]["output_graph_revision"],original["write_set"]["output_graph_revision"]);
    let mut confirm=p.clone();confirm["candidate_build"]=out["write_set"]["builds"][0].clone();confirm["candidate_graph_revision"]=out["write_set"]["output_graph_revision"].clone();
    confirm["index_ack"]=json!({"status":"READY","task_ref":"partial-job","graph_revision":confirm["candidate_graph_revision"],"index_payload_sha256":"c".repeat(64),"backend":"LEXICAL"});
    let confirmed=inc::execute("confirm_partial_publication",&confirm).unwrap();assert_eq!(confirmed["publication_receipt"]["scope_task_restriction"],restriction);
    assert_eq!(p["coverage_raw"],raw);assert_eq!(p["coverage_receipt"],receipt);
}
#[test]
fn scope_task_deferral_cannot_upgrade_or_escape_receipt_task_source_and_actor_bindings() {
    let mut p=scope_audit_case();let decision=scope_audit_decision(&p,1);
    for mode in 0..6 {let mut d=decision.clone();match mode {0=>d["actor"]=json!("LOCAL_OPERATOR"),1=>d["action"]=json!("CONFIRM_SUPPORT"),2=>d["coverage_receipt_hash"]=json!("changed"),3=>d["task_id"]=p["coverage_prepared"]["review_tasks"][0]["id"].clone(),4=>d["source_snapshot_sha256"]=json!("changed"),_=>d["reason"]=json!("rewritten")};p["task_scope_deferrals"]=json!([d]);assert!(inc::execute("restrict_scope_tasks",&p).is_err(),"tamper {mode}");assert!(inc::execute("partial_formal_bundle",&p).is_err());}
    p["task_scope_deferrals"]=json!([decision,decision]);assert!(inc::execute("restrict_scope_tasks",&p).is_err());
    let mut invalid=json!({"coverage_prepared":p["coverage_prepared"],"coverage_raw":p["coverage_raw"],"coverage_receipt":p["coverage_receipt"],"current_snapshot":p["assessment_input"]["current_snapshot"],"task_id":p["coverage_prepared"]["review_tasks"][4]["id"],"reason":"Cannot turn an unready task into a support decision.","actor":"ASSISTANT_SCOPE_AUDIT","action":"DEFER"});
    assert!(inc::execute("defer_scope_task",&invalid).is_err());invalid["task_id"]=p["coverage_prepared"]["review_tasks"][0]["id"].clone();invalid["action"]=json!("CONFIRM_SUPPORT");assert!(inc::execute("defer_scope_task",&invalid).is_err());
}
#[test]
fn scope_task_deferral_routes_replay_restrictions_and_never_reuse_a_deferred_task() {
    let mut p=scope_audit_case();p["task_scope_deferrals"]=json!([scope_audit_decision(&p,1)]);
    let restriction=inc::execute("restrict_scope_tasks",&p).unwrap();
    let input=json!({"plan":p["coverage_prepared"]["input"]["plan"],"snapshot":p["assessment_input"]["current_snapshot"],"question":"Authored scope task paraphrase","coverage_receipt":p["coverage_receipt"],"scope_task_restriction":restriction});
    let prepared=route::prepare(&input).unwrap();assert_eq!(a(&prepared["manifest"]["supported_task_ids"]).len(),2);assert_eq!(prepared["coverage_rows"],p["coverage_receipt"]["rows"]);
    for i in 0..3 {let task=&p["coverage_prepared"]["review_tasks"][i];let raw=json!({"route":"SAME_SCOPE_REUSE","family_ids":[task["family_id"]],"subject_ids":[task["subject_id"]],"task_ids":[task["id"]],"reason":"Authored route, never a semantic certificate."});let result=route::materialize(&json!({"prepared":prepared,"raw":raw}));assert_eq!(result.is_ok(),i!=1);if let Ok(receipt)=result {assert_eq!(receipt["scope_task_restriction_hash"],restriction["restriction_hash"]);}}
    let mut tampered=input.clone();tampered["scope_task_restriction"]["reusable_task_ids"]=p["coverage_receipt"]["reusable_task_ids"].clone();let mut unsigned=tampered["scope_task_restriction"].clone();unsigned.as_object_mut().unwrap().remove("restriction_hash");tampered["scope_task_restriction"]["restriction_hash"]=json!(hash(&unsigned));assert!(route::prepare(&tampered).is_err());
}
#[test]
fn deferring_all_supported_tasks_blocks_publication_without_dropping_the_scope_plan() {
    let mut p=scope_audit_case();p["task_scope_deferrals"]=json!((0..3).map(|i|scope_audit_decision(&p,i)).collect::<Vec<_>>());
    let restriction=inc::execute("restrict_scope_tasks",&p).unwrap();assert_eq!(restriction["partial_ready"],false);assert_eq!(restriction["task_count"],16);assert_eq!(a(&restriction["unresolved_task_ids"]).len(),16);assert!(a(&restriction["publishable_candidate_ids"]).is_empty());assert!(inc::execute("partial_formal_bundle",&p).is_err());assert_eq!(a(&p["coverage_receipt"]["rows"]).len(),16);
}
