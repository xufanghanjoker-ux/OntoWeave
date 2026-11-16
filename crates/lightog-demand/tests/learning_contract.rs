//! Lifecycle contract checks, no scheduler/database/model.
use lightog_demand::{learning_contract::{execute,VERSION}, wire};
use serde_json::{json,Value};
fn load(text:&str)->Value{serde_json::from_str(text).unwrap()}
fn context()->Value{
    let q=load(include_str!("../../../contracts/demand-v0.1/examples/ungraphed-subject.json"));
    let es=load(include_str!("../../../contracts/demand-v0.1/examples/evidence-set.json"));
    let sources=load(include_str!("../../../fixtures/demand-contract-v0.1/source-texts.json"));
    let auth=load(include_str!("../../../fixtures/demand-contract-v0.1/validation-context.json"));
    json!({"examples":{"q":q,"e":es},"source_texts":sources["sources"],"authority":auth})
}
fn job(stage:&str,revision:u64)->Value{
    let mut intent=load(include_str!("../../../contracts/demand-v0.1/examples/background-learning.json"));
    intent["status"]=json!(match stage{"EXTRACTING"|"VALIDATING"|"COMMITTING"=>"RUNNING","COMPLETED"=>"PUBLISHED","FAILED"=>"FAILED","SUPERSEDED"|"STOPPED"=>"CANCELLED",_=>"QUEUED"});
    if matches!(stage,"EXTRACTING"|"VALIDATING"|"COMMITTING"|"COMPLETED"){intent["admission_evidence_ids"]=json!(["e_new"]);}
    json!({"contract_version":VERSION,"intent":intent,"stage":stage,"revision":revision,"dimension_sha256":"a".repeat(64),"policy_version":"learning-policy/1","scope":{"checked_unit_ids":[],"unsearched_unit_ids":["u1","u2"]},"commit_receipt_ref":if stage=="COMPLETED"{json!("commit_1")}else{Value::Null}})
}
fn payload(from:&str,to:&str)->Value{
    let prev=job(from,0);let next=job(to,1);
    let raw=context();let unit=|id:&str,index:usize|{let source=&raw["source_texts"][index];json!({"unit_id":id,"source_ref":source["source_ref"],"source_revision":source["source_revision"],"text_sha256":wire::text_sha(source["text"].as_str().unwrap()),"start":0,"end":source["text"].as_str().unwrap().encode_utf16().count()})};
    let units=json!([unit("u1",1),unit("u2",0)]);
    json!({"previous":prev,"next":next,"trusted_context":context(),"trusted_runtime":{"current_snapshot":prev["intent"]["snapshot"],"persisted_job_sha256":wire::sha(&prev).unwrap(),"persisted_revision":0,"scope_unit_ids":["u1","u2"],"units":units,"commits":[]}})
}
fn refresh(p:&mut Value){p["trusted_runtime"]["persisted_job_sha256"]=json!(wire::sha(&p["previous"]).unwrap());}
fn code(p:&Value)->&'static str{execute("transition",p).unwrap_err().code}
#[test] fn retrieval_can_start_without_fake_claims_or_admission(){
 let p=payload("QUEUED","RETRIEVING");let r=execute("transition",&p).unwrap();
 assert_eq!(r["execution"],"VALIDATED_NOT_PERSISTED");assert_eq!(r["answer_effect"],"UNCHANGED");
}
#[test] fn extraction_requires_actual_admission_evidence(){
 let mut p=payload("RETRIEVING","EXTRACTING");execute("transition",&p).unwrap();
 p["next"]["intent"]["admission_evidence_ids"]=json!([]);assert_eq!(code(&p),"LEARNING_EVIDENCE_MISSING");
}
#[test] fn read_only_cannot_be_queued(){
 let mut p=payload("QUEUED","RETRIEVING");
 for key in ["previous","next"] {p[key]["intent"]["request_ref"]=json!("req_synthetic");p[key]["intent"]["access_mode"]=json!("QUERY");}
 refresh(&mut p);assert_eq!(code(&p),"ACCESS_SCOPE_DENIED");
}
#[test] fn stored_record_hash_and_revision_control_transition(){
 let mut p=payload("QUEUED","RETRIEVING");p["trusted_runtime"]["persisted_job_sha256"]=json!("0".repeat(64));assert_eq!(code(&p),"LEARNING_CAS_MISMATCH");
 let mut p=payload("QUEUED","RETRIEVING");p["next"]["revision"]=json!(3);assert_eq!(code(&p),"LEARNING_REVISION_MISMATCH");
}
#[test] fn task_dimension_and_requirements_cannot_be_silently_rebound(){
 let mut p=payload("QUEUED","RETRIEVING");p["next"]["dimension_sha256"]=json!("b".repeat(64));assert_eq!(code(&p),"LEARNING_IDENTITY_CHANGED");
 let mut p=payload("QUEUED","RETRIEVING");p["next"]["intent"]["task_ref"]=json!("other_task");assert_eq!(code(&p),"LEARNING_IDENTITY_CHANGED");
}
#[test] fn stages_cannot_be_skipped_and_terminal_jobs_cannot_restart(){
 assert_eq!(code(&payload("QUEUED","COMMITTING")),"LEARNING_TRANSITION_DENIED");
 assert_eq!(code(&payload("FAILED","QUEUED")),"LEARNING_TRANSITION_DENIED");
}
#[test] fn old_sources_block_work_but_allow_explicit_superseding(){
 let mut p=payload("QUEUED","RETRIEVING");p["trusted_runtime"]["current_snapshot"]["source_epoch"]=json!(2);
 let current=p["trusted_runtime"]["current_snapshot"].clone();p["trusted_context"]["authority"]["allowed_snapshots"].as_array_mut().unwrap().push(current);
 assert_eq!(code(&p),"LEARNING_SOURCE_STALE");
 let mut p=payload("QUEUED","SUPERSEDED");p["trusted_runtime"]["current_snapshot"]["source_epoch"]=json!(2);execute("transition",&p).unwrap();
}
#[test] fn changed_graph_requires_rebase_before_commit(){
 let mut p=payload("VALIDATING","COMMITTING");p["trusted_runtime"]["current_snapshot"]["graph_revision"]=json!("graph_other");
 let current=p["trusted_runtime"]["current_snapshot"].clone();p["trusted_context"]["authority"]["allowed_snapshots"].as_array_mut().unwrap().push(current);
 assert_eq!(code(&p),"LEARNING_BASE_STALE");
}
#[test] fn unchecked_scope_and_previous_evidence_cannot_disappear(){
 let mut p=payload("QUEUED","RETRIEVING");p["next"]["scope"]["unsearched_unit_ids"]=json!(["u1"]);assert_eq!(code(&p),"LEARNING_SCOPE_CHANGED");
 let mut p=payload("QUEUED","RETRIEVING");p["previous"]["intent"]["admission_evidence_ids"]=json!(["e_new"]);refresh(&mut p);assert_eq!(code(&p),"LEARNING_EVIDENCE_REGRESSION");
}
#[test] fn checked_scope_cannot_regress_or_overlap(){
 let mut p=payload("QUEUED","RETRIEVING");p["previous"]["scope"]=json!({"checked_unit_ids":["u1"],"unsearched_unit_ids":["u2"]});refresh(&mut p);assert_eq!(code(&p),"LEARNING_SCOPE_REGRESSION");
 let mut p=payload("QUEUED","RETRIEVING");p["next"]["scope"]["checked_unit_ids"]=json!(["u1"]);assert_eq!(code(&p),"LEARNING_SCOPE_OVERLAP");
}
#[test] fn completion_requires_host_commit_and_explicit_index_state(){
 let mut p=payload("COMMITTING","COMPLETED");assert_eq!(code(&p),"LEARNING_COMMIT_UNVERIFIED");
 p["trusted_runtime"]["current_snapshot"]["graph_revision"]=json!("graph_next");
 let current=p["trusted_runtime"]["current_snapshot"].clone();p["trusted_context"]["authority"]["allowed_snapshots"].as_array_mut().unwrap().push(current);
 p["trusted_runtime"]["commits"]=json!([{"receipt_ref":"commit_1","task_ref":p["next"]["intent"]["task_ref"],"input_snapshot_sha256":wire::sha(&p["previous"]["intent"]["snapshot"]).unwrap(),"dimension_sha256":"a".repeat(64),"output_graph_revision":"graph_next","index_manifest_ref":"idx_next","index_state":"PENDING"}]);
 let r=execute("transition",&p).unwrap();assert_eq!(r["commit"]["index_state"],"PENDING");assert_eq!(r["answer_effect"],"UNCHANGED");
 p["trusted_runtime"]["commits"][0]["dimension_sha256"]=json!("b".repeat(64));assert_eq!(code(&p),"LEARNING_COMMIT_UNVERIFIED");
}
#[test] fn invalid_fields_cannot_be_accepted_as_approval(){
 let mut p=payload("QUEUED","RETRIEVING");p["next"]["semantic_complete"]=json!(true);assert_eq!(code(&p),"LEARNING_SHAPE_INVALID");
}
#[test] fn withdrawn_source_can_be_closed_without_regranting_historical_access(){
 let mut p=payload("RETRIEVING","SUPERSEDED");
 p["trusted_runtime"]["current_snapshot"]["source_epoch"]=json!(2);
 p["trusted_context"]["authority"]["allowed_snapshots"]=json!([]);
 p["trusted_context"]["source_texts"]=json!([]);
 execute("transition",&p).unwrap();
 // The very same revoked registry cannot authorize new work.
 p=payload("QUEUED","RETRIEVING");p["trusted_context"]["authority"]["allowed_snapshots"]=json!([]);
 assert_eq!(code(&p),"SOURCE_SNAPSHOT_MISMATCH");
}
#[test] fn admission_evidence_must_be_covered_by_trusted_selected_units(){
 let mut p=payload("RETRIEVING","EXTRACTING");
 let other=p["trusted_runtime"]["units"][1].clone();
 p["trusted_runtime"]["units"][0]=other;p["trusted_runtime"]["units"][0]["unit_id"]=json!("u1");
 assert_eq!(code(&p),"LEARNING_ADMISSION_OUTSIDE_SCOPE");
}
#[test] fn standalone_validate_cannot_self_report_completed(){
 let completed=job("COMPLETED",1);
 assert_eq!(execute("validate",&json!({"job":completed,"trusted_context":context()})).unwrap_err().code,"LEARNING_COMMIT_UNVERIFIED");
}
#[test] fn standalone_validate_has_strict_envelope(){
 assert_eq!(execute("validate",&json!({"job":job("QUEUED",0),"trusted_context":context(),"force_publish":true})).unwrap_err().code,"LEARNING_SHAPE_INVALID");
 assert_eq!(execute("validate",&json!({"job":job("QUEUED",0),"trusted_context":context(),"trusted_runtime":null})).unwrap_err().code,"LEARNING_SHAPE_INVALID");
}
#[test] fn request_cannot_borrow_another_library_or_epoch(){
 let mut p=payload("QUEUED","RETRIEVING");
 for r in p["trusted_context"]["authority"]["requests"].as_array_mut().unwrap(){if r["request_id"]=="req_learning" {r["context"]["base_ref"]=json!("other_library");}}
 assert_eq!(code(&p),"REQUEST_SNAPSHOT_MISMATCH");
}
