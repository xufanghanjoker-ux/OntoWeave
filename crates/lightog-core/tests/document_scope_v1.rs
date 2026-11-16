//! Authored offline counterexamples. No provider calls or semantic quality claim.
use lightog_core::{common::{a, len, text_sha}, document_scope_v1 as scope};
use serde_json::{json, Value};

fn input(texts: &[&str]) -> Value {
    let mut refs=vec![]; let mut fragments=vec![]; let mut source_texts=vec![];
    for (i,text) in texts.iter().enumerate() {
        let source_ref=format!("source_{i}"); let sha=text_sha(text); let block=format!("block_{i}");
        refs.push(json!({"source_ref":source_ref,"source_revision":"v1","original_sha256":sha,"text_sha256":sha,"parser_version":"authored/1"}));
        fragments.push(json!({"id":format!("e_{i}"),"origin":"SOURCE_FRAGMENT","source_ref":source_ref,"source_revision":"v1","block_ref":block,"text_sha256":sha,"span":{"start":0,"end":len(text),"quote":text,"offset_unit":"utf16_code_unit"},"claim_refs":[],"role":"PRIMARY"}));
        source_texts.push(json!({"source_ref":source_ref,"source_revision":"v1","text":text,"original_sha256":sha,"parser_version":"authored/1","blocks":[{"block_ref":block,"start":0,"end":len(text)}]}));
    }
    let snapshot=json!({"base_ref":"scope_authored","source_epoch":0,"graph_revision":null,"sources":refs});
    let es=json!({"contract_version":"lightog-demand/0.1","evidence_set_id":"scope_es","snapshot":snapshot,"fragments":fragments});
    let context=json!({"examples":{"scope_es":es},"source_texts":source_texts,"authority":{"requests":[],"allowed_snapshots":[snapshot],"claims":[],"receipts":[],"scope_bindings":[],"entities":[],"predicate_refs":[],"user_definitions":[],"groups":[],"entity_links":[]}});
    json!({"snapshot":snapshot,"evidence_set":es,"context":context,"user_cqs":[],"definitions":"","max_batch_utf16":24000,"max_fragments_per_batch":64})
}
fn raw(batch: &Value, surface: &str) -> Value {
    let e=&batch["source_evidence_menu"][0]["evidence_id"];
    json!({"families":[{"key":"capacity","label":"Authored capacity","question":"What is the capacity of {subject}?","target":"capacity","operation":"LOOKUP","conditions":[{"text":"Under the stated test conditions only","evidence_ids":[e]}],"evidence_ids":[e],"subjects":[{"surface":surface,"evidence_id":e,"occurrence":0,"rationale":"Authored model proposal, not a certified identity."}]}],"unknowns":[]})
}
fn material(prepared: &Value, raws: Vec<Value>) -> Value {
    let responses: Vec<Value>=raws.into_iter().enumerate().map(|(i,r)|json!({"batch_id":prepared["batches"][i]["batch_id"],"raw":r})).collect();
    scope::materialize(&json!({"prepared":prepared,"responses":responses})).unwrap()
}

#[test]
fn source_bound_subjects_conditions_and_question_survive_without_fact_promotion() {
    let p=scope::prepare(&input(&["🚀 Maple has 10 units. Maple has a second mention. Birch has 20 units."])).unwrap();
    let mut r=raw(&p["batches"][0],"Maple");
    let e=r["families"][0]["subjects"][0]["evidence_id"].clone();
    r["families"][0]["subjects"].as_array_mut().unwrap().push(json!({"surface":"Maple","evidence_id":e,"occurrence":1,"rationale":"The later source mention."}));
    r["families"][0]["subjects"].as_array_mut().unwrap().push(json!({"surface":"Birch","evidence_id":e,"occurrence":0,"rationale":"Another proposed applicable subject."}));
    let plan=material(&p,vec![r]);
    assert_eq!(plan["status"],"SCOPE_PROPOSED");
    assert_eq!(a(&plan["subjects"]).len(),3);
    assert_eq!(a(&plan["families"][0]["subject_ids"]).len(),3);
    assert_eq!(a(&plan["tasks"]).len(),3);
    let first=a(&plan["subjects"]).iter().find(|s|s["anchor"]["span"]["start"]==3).unwrap();
    assert_eq!(first["surface"],"Maple");
    assert_eq!(first["identity_status"],"SOURCE_MENTION_UNRESOLVED");
    assert_eq!(first["entity_ref"],Value::Null);
    for task in a(&plan["tasks"]) {
        assert_eq!(task["question"],"What is the capacity of {subject}?");
        assert_eq!(task["conditions"][0]["text"],"Under the stated test conditions only");
        assert_eq!(task["status"],"PLANNED_UNVERIFIED");
    }
    assert_eq!(plan["semantic_support_certified"],false);
    assert_eq!(plan["coverage_complete"],false);
    assert_eq!(plan["scanned_sources"][0]["status"],"SCAN_RETURNED");
}

#[test]
fn batching_keeps_long_source_tail_and_all_unicode_scalars() {
    let text=format!("{} TailSubject has a condition.","🚀中".repeat(900));
    let mut source=input(&[&text]);source["max_batch_utf16"]=json!(640);source["max_fragments_per_batch"]=json!(1);
    let p=scope::prepare(&source).unwrap();
    assert!(a(&p["batches"]).len()>4);
    let reconstructed:String=a(&p["batches"]).iter().flat_map(|b|a(&b["source_evidence_menu"]).iter()).map(|m|m["span"]["quote"].as_str().unwrap()).collect();
    assert_eq!(reconstructed,text);
    let responses:Vec<Value>=a(&p["batches"]).iter().map(|b|json!({"batch_id":b["batch_id"],"raw":{"families":[],"unknowns":[]}})).collect();
    let plan=scope::materialize(&json!({"prepared":p,"responses":responses})).unwrap();
    assert_eq!(plan["all_batches_returned"],true);
    assert_eq!(plan["all_source_text_in_menu"],true);
    assert_eq!(plan["status"],"NO_SCOPE_DISCOVERED");
    assert_eq!(plan["coverage_complete"],false);
}

#[test]
fn missing_batch_or_unseen_source_menu_remains_partial() {
    let mut i=input(&["Maple has capacity.","Birch has capacity."]);i["max_fragments_per_batch"]=json!(1);
    let p=scope::prepare(&i).unwrap();
    let plan=material(&p,vec![raw(&p["batches"][0],"Maple")]);
    assert_eq!(plan["status"],"PARTIAL_SCOPE");
    assert_eq!(a(&plan["pending_batches"]).len(),1);
    assert_eq!(plan["scanned_sources"][1]["status"],"PENDING");
    i["evidence_set"]["fragments"].as_array_mut().unwrap().pop();
    let p=scope::prepare(&i).unwrap();
    let plan=material(&p,vec![raw(&p["batches"][0],"Maple")]);
    assert_eq!(plan["status"],"PARTIAL_SCOPE");
    assert_eq!(plan["scanned_sources"][1]["status"],"NOT_IN_MENU");
}

#[test]
fn no_inferred_semantic_merging_for_different_target_or_condition() {
    let p=scope::prepare(&input(&["Maple has capacity and endurance."])).unwrap();
    let mut r=raw(&p["batches"][0],"Maple");
    let mut other=r["families"][0].clone();other["key"]=json!("endurance");other["target"]=json!("endurance");
    r["families"].as_array_mut().unwrap().push(other);
    let mut conditional=r["families"][0].clone();conditional["key"]=json!("other_condition");conditional["conditions"][0]["text"]=json!("Only during video playback");
    r["families"].as_array_mut().unwrap().push(conditional);
    let plan=material(&p,vec![r]);assert_eq!(a(&plan["families"]).len(),3);assert_eq!(a(&plan["tasks"]).len(),3);
}

#[test]
fn exact_cross_batch_family_keeps_each_condition_source_and_distinct_subjects() {
    let mut i=input(&["Maple has capacity under stated conditions.","Birch has capacity under stated conditions."]);i["max_fragments_per_batch"]=json!(1);
    let p=scope::prepare(&i).unwrap();
    let plan=material(&p,vec![raw(&p["batches"][0],"Maple"),raw(&p["batches"][1],"Birch")]);
    assert_eq!(a(&plan["families"]).len(),1);
    assert_eq!(a(&plan["families"][0]["conditions"][0]["evidence"]).len(),2);
    assert_eq!(a(&plan["families"][0]["subject_ids"]).len(),2);
    assert_eq!(a(&plan["tasks"]).len(),2);
}

#[test]
fn unknowns_are_preserved_and_empty_result_is_never_absence_proof() {
    let p=scope::prepare(&input(&["Maple details are ambiguous."])).unwrap();
    let plan=material(&p,vec![json!({"families":[],"unknowns":["Condition applicability is unknown."]})]);
    assert_eq!(plan["unknowns"][0]["reason"],"Condition applicability is unknown.");
    assert_eq!(plan["status"],"NO_SCOPE_DISCOVERED");
    assert_eq!(plan["coverage_complete"],false);
}

#[test]
fn unknown_evidence_duplicate_keys_and_authority_fields_are_rejected() {
    let p=scope::prepare(&input(&["Maple has capacity."])).unwrap();
    for mode in 0..4 {
        let mut r=raw(&p["batches"][0],"Maple");
        if mode==0 {r["families"][0]["evidence_ids"]=json!(["foreign"]);}
        if mode==1 {r["families"][0]["subjects"][0]["surface"]=json!("Unseen");}
        if mode==2 {r["families"][0]["status"]=json!("APPROVED");}
        if mode==3 {let f=r["families"][0].clone();r["families"].as_array_mut().unwrap().push(f);}
        assert!(scope::materialize(&json!({"prepared":p,"responses":[{"batch_id":p["batches"][0]["batch_id"],"raw":r}]})).is_err());
    }
    let e=scope::materialize(&json!({"prepared":p,"responses":[{"batch_id":p["batches"][0]["batch_id"],"raw":"{\"families\":[],\"families\":[],\"unknowns\":[]}"}]})).unwrap_err();
    assert_eq!(e.code,"CORE_DUPLICATE_KEY");
}

#[test]
fn prepared_tamper_batch_replay_and_source_change_are_rejected() {
    let mut i=input(&["Maple has capacity.","Birch has capacity."]);i["max_fragments_per_batch"]=json!(1);
    let p=scope::prepare(&i).unwrap();let mut bad=p.clone();bad["snapshot"]["source_epoch"]=json!(1);
    assert_eq!(scope::materialize(&json!({"prepared":bad,"responses":[]})).unwrap_err().code,"DOCUMENT_SCOPE_PREPARED_CHANGED");
    let row=json!({"batch_id":p["batches"][0]["batch_id"],"raw":raw(&p["batches"][0],"Maple")});
    assert_eq!(scope::materialize(&json!({"prepared":p,"responses":[row,row]})).unwrap_err().code,"DOCUMENT_SCOPE_BATCH_DUPLICATE");
    let responses=json!([row]);let plan=scope::materialize(&json!({"prepared":p,"responses":responses})).unwrap();
    let checked=scope::execute("validate_plan",&json!({"prepared":p,"responses":responses,"plan":plan,"current_snapshot":p["snapshot"]})).unwrap();assert_eq!(checked["validated"],true);
    let mut changed=p["snapshot"].clone();changed["source_epoch"]=json!(2);
    assert_eq!(scope::execute("validate_plan",&json!({"prepared":p,"responses":responses,"plan":plan,"current_snapshot":changed})).unwrap_err().code,"DOCUMENT_SCOPE_SOURCE_STALE");
    let q=scope::execute("build_question",&json!({"plan":plan,"current_snapshot":p["snapshot"]})).unwrap();
    assert!(q["cq_guidance"].as_str().unwrap().contains("Under the stated test conditions only"));
    assert_eq!(q["scope_constraints"]["tasks"],plan["tasks"]);
}
