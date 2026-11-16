//! Original offline route and provenance counterexamples, not model evaluations.
use lightog_core::{common::{a,canonical_hash as hash,len,text_sha},document_scope_v1 as scope,document_scope_coverage_v1 as coverage,document_family_route_v1 as route};
use serde_json::{json,Value};

fn fixture()->Value {
    let text="Maple Relay has capacity 10. Birch Relay has capacity 20. Video tests only.";
    let sha=text_sha(text);
    let snapshot=json!({"base_ref":"family_route_authored","source_epoch":0,"graph_revision":null,"sources":[{"source_ref":"original","source_revision":"v1","original_sha256":sha,"text_sha256":sha,"parser_version":"authored/1"}]});
    let fragment=json!({"id":"e","origin":"SOURCE_FRAGMENT","source_ref":"original","source_revision":"v1","block_ref":"b","text_sha256":sha,"span":{"start":0,"end":len(text),"quote":text,"offset_unit":"utf16_code_unit"},"claim_refs":[],"role":"PRIMARY"});
    let es=json!({"contract_version":"lightog-demand/0.1","evidence_set_id":"es","snapshot":snapshot,"fragments":[fragment]});
    let context=json!({"examples":{"es":es},"source_texts":[{"source_ref":"original","source_revision":"v1","text":text,"original_sha256":sha,"parser_version":"authored/1","blocks":[{"block_ref":"b","start":0,"end":len(text)}]}],"authority":{"requests":[],"allowed_snapshots":[snapshot],"claims":[],"receipts":[],"scope_bindings":[],"entities":[],"predicate_refs":[],"user_definitions":[],"groups":[],"entity_links":[]}});
    let prepared=scope::prepare(&json!({"snapshot":snapshot,"evidence_set":es,"context":context,"user_cqs":[],"definitions":"","max_batch_utf16":24000,"max_fragments_per_batch":64})).unwrap();
    let evidence=&prepared["batches"][0]["source_evidence_menu"][0]["evidence_id"];
    let family=json!({"key":"capacity","label":"Capacity","question":"What is {subject}'s capacity?","target":"capacity","operation":"LOOKUP","conditions":[{"text":"Video tests only","evidence_ids":[evidence]}],"evidence_ids":[evidence],"subjects":[{"surface":"Maple Relay","evidence_id":evidence,"occurrence":0,"rationale":"Authored first source subject"},{"surface":"Birch Relay","evidence_id":evidence,"occurrence":0,"rationale":"Authored second source subject"}]});
    let plan=scope::materialize(&json!({"prepared":prepared,"responses":[{"batch_id":prepared["batches"][0]["batch_id"],"raw":{"families":[family],"unknowns":[]}}]})).unwrap();
    let candidates:Vec<Value>=a(&plan["tasks"]).iter().enumerate().map(|(i,t)|json!({"id":format!("candidate_{i}"),"description":format!("Authored capacity candidate for {}",t["subject"]["surface"]),"evidence_ids":[evidence]})).collect();
    let c=coverage::prepare(&json!({"plan":plan,"candidates":candidates,"evidence_menu":prepared["batches"][0]["source_evidence_menu"],"snapshot":snapshot})).unwrap();
    let rows:Vec<Value>=a(&plan["tasks"]).iter().enumerate().map(|(i,t)|json!({"task_id":t["id"],"decision":"SUPPORTED","candidate_ids":[format!("candidate_{i}")],"evidence_ids":[evidence],"reason":"Authored independently supported scope fixture."})).collect();
    let receipt=coverage::materialize(&json!({"prepared":c,"raw":{"rows":rows}})).unwrap();
    json!({"plan":plan,"snapshot":snapshot,"question":"Under the stated video conditions, how much capacity does Maple Relay have?","coverage_receipt":receipt})
}
fn reuse(prepared:&Value,index:usize)->Value {
    let task=&prepared["tasks"][index];
    json!({"route":"SAME_SCOPE_REUSE","family_ids":[task["family_id"]],"subject_ids":[task["subject_id"]],"task_ids":[task["id"]],"reason":"Authored exact task-scope routing proposal."})
}
fn apply(prepared:&Value,raw:&Value)->Value {route::materialize(&json!({"prepared":prepared,"raw":raw})).unwrap()}

#[test]
fn reuse_requires_supported_task_and_its_exact_family_and_subject_sets() {
    let p=route::prepare(&fixture()).unwrap();let raw=reuse(&p,0);let r=apply(&p,&raw);
    assert_eq!(r["reuse_eligible"],true);assert_eq!(r["learning_proposed"],false);assert_eq!(r["semantic_equivalence_certified"],false);
    assert_eq!(r["coverage_receipt_hash"],p["input"]["coverage_receipt"]["receipt_hash"]);
    let mut missing=raw.clone();missing["subject_ids"]=json!([]);
    assert_eq!(route::materialize(&json!({"prepared":p,"raw":missing})).unwrap_err().code,"FAMILY_ROUTE_REUSE_NOT_COVERED");
    let mut extra=raw.clone();extra["subject_ids"].as_array_mut().unwrap().push(p["tasks"][1]["subject_id"].clone());
    assert_eq!(route::materialize(&json!({"prepared":p,"raw":extra})).unwrap_err().code,"FAMILY_ROUTE_REUSE_NOT_COVERED");
}

#[test]
fn missing_or_insufficient_coverage_never_grants_reuse() {
    let mut input=fixture();input["coverage_receipt"]=Value::Null;
    let p=route::prepare(&input).unwrap();
    assert_eq!(route::materialize(&json!({"prepared":p,"raw":reuse(&p,0)})).unwrap_err().code,"FAMILY_ROUTE_REUSE_NOT_COVERED");
    let mut input=fixture();input["coverage_receipt"]["rows"][0]["decision"]=json!("SOURCE_INSUFFICIENT");input["coverage_receipt"]["rows"][0]["candidate_ids"]=json!([]);
    let mut unsigned=input["coverage_receipt"].clone();unsigned.as_object_mut().unwrap().remove("receipt_hash");input["coverage_receipt"]["receipt_hash"]=json!(hash(&unsigned));
    let p=route::prepare(&input).unwrap();
    assert_eq!(route::materialize(&json!({"prepared":p,"raw":reuse(&p,0)})).unwrap_err().code,"FAMILY_ROUTE_REUSE_NOT_COVERED");
}

#[test]
fn new_scope_may_reference_a_family_without_inventing_a_new_subject_id() {
    let p=route::prepare(&fixture()).unwrap();
    let raw=json!({"route":"SAME_FAMILY_NEW_SCOPE","family_ids":[p["families"][0]["id"]],"subject_ids":[],"task_ids":[],"reason":"The question introduces an unbound subject or changed measurement condition."});
    let r=apply(&p,&raw);assert_eq!(r["reuse_eligible"],false);assert_eq!(r["learning_proposed"],true);
    let mut forged=raw.clone();forged["subject_ids"]=json!(["invented_subject"]);
    assert_eq!(route::materialize(&json!({"prepared":p,"raw":forged})).unwrap_err().code,"FAMILY_ROUTE_REFERENCE_UNKNOWN");
}

#[test]
fn new_family_and_unknown_remain_distinct_without_lexical_inference() {
    let p=route::prepare(&fixture()).unwrap();
    let new=json!({"route":"NEW_FAMILY","family_ids":[],"subject_ids":[],"task_ids":[],"reason":"Authored model decision that a different target is required."});
    assert_eq!(apply(&p,&new)["learning_proposed"],true);
    let mut unknown=new.clone();unknown["route"]=json!("UNKNOWN");unknown["reason"]=json!("Identity and applicable conditions cannot be determined.");
    let r=apply(&p,&unknown);assert_eq!(r["learning_proposed"],false);assert_eq!(r["reuse_eligible"],false);
    let mut invalid=new.clone();invalid["family_ids"]=json!([p["families"][0]["id"]]);
    assert_eq!(route::materialize(&json!({"prepared":p,"raw":invalid})).unwrap_err().code,"FAMILY_ROUTE_NEW_FAMILY_REFERENCES_INVALID");
}

#[test]
fn stale_plan_coverage_and_changed_prepared_are_rejected() {
    let mut input=fixture();input["snapshot"]["source_epoch"]=json!(1);
    assert_eq!(route::prepare(&input).unwrap_err().code,"DOCUMENT_SCOPE_SOURCE_STALE");
    let mut input=fixture();input["coverage_receipt"]["plan_id"]=json!("other_plan");
    assert_eq!(route::prepare(&input).unwrap_err().code,"FAMILY_ROUTE_COVERAGE_PLAN_CHANGED");
    let mut input=fixture();input["coverage_receipt"]["rows"][0]["reason"]=json!("changed");
    assert_eq!(route::prepare(&input).unwrap_err().code,"FAMILY_ROUTE_COVERAGE_CHANGED");
    let p=route::prepare(&fixture()).unwrap();let mut changed=p.clone();changed["question"]=json!("Different condition");
    assert_eq!(route::materialize(&json!({"prepared":changed,"raw":reuse(&p,0)})).unwrap_err().code,"FAMILY_ROUTE_PREPARED_CHANGED");
}

#[test]
fn raw_duplicate_keys_unknown_ids_and_extra_authority_are_rejected() {
    let p=route::prepare(&fixture()).unwrap();
    assert_eq!(route::materialize(&json!({"prepared":p,"raw":"{\"route\":\"UNKNOWN\",\"route\":\"NEW_FAMILY\",\"family_ids\":[],\"subject_ids\":[],\"task_ids\":[],\"reason\":\"x\"}"})).unwrap_err().code,"CORE_DUPLICATE_KEY");
    let mut raw=reuse(&p,0);raw["approved"]=json!(true);
    assert_eq!(route::materialize(&json!({"prepared":p,"raw":raw})).unwrap_err().code,"FAMILY_ROUTE_SHAPE_INVALID");
    let mut raw=reuse(&p,0);raw["task_ids"]=json!(["foreign_task"]);
    assert_eq!(route::materialize(&json!({"prepared":p,"raw":raw})).unwrap_err().code,"FAMILY_ROUTE_REFERENCE_UNKNOWN");
}

#[test]
fn route_receipt_cannot_be_replayed_after_graph_snapshot_or_question_changes() {
    let p=route::prepare(&fixture()).unwrap();let raw=reuse(&p,0);let receipt=apply(&p,&raw);
    let valid=route::execute("validate_receipt",&json!({"prepared":p,"raw":raw,"receipt":receipt,"current_snapshot":p["snapshot"]})).unwrap();assert_eq!(valid["validated"],true);
    let mut snapshot=p["snapshot"].clone();snapshot["graph_revision"]=json!("new_formal_version");
    assert_eq!(route::execute("validate_receipt",&json!({"prepared":p,"raw":raw,"receipt":receipt,"current_snapshot":snapshot})).unwrap_err().code,"FAMILY_ROUTE_CURRENT_SNAPSHOT_CHANGED");
    let mut receipt=receipt.clone();receipt["question_sha256"]=json!(text_sha("different question"));
    assert_eq!(route::execute("validate_receipt",&json!({"prepared":p,"raw":raw,"receipt":receipt,"current_snapshot":p["snapshot"]})).unwrap_err().code,"FAMILY_ROUTE_RECEIPT_CHANGED");
}
