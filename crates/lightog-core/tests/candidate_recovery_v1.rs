use lightog_core::{common::{canonical_hash as hash,text_sha},knowledge_build,source_learning_v1 as learning,support_selection,candidate_recovery_v1 as recovery};
use serde_json::{json,Value};
fn fixture()->Value{
    let text="🚀 Mode Alpha.\nIt leaves the index unchanged.\nIt refers to mode Alpha.\nIf the same file is unstaged, abort.\n";let digest=text_sha(text);let size=text.encode_utf16().count();
    let snapshot=json!({"base_ref":"source_learning_authored","source_epoch":0,"graph_revision":null,"sources":[{"source_ref":"src","source_revision":"r1","original_sha256":digest,"text_sha256":digest,"parser_version":"authored/1"}]});
    let mut at=0;let fragments:Vec<_>=text.split_inclusive('\n').zip(["mode","assertion","antecedent","condition"]).map(|(quote,id)|{let start=at;at+=quote.encode_utf16().count();json!({"id":id,"origin":"SOURCE_FRAGMENT","source_ref":"src","source_revision":"r1","block_ref":"b","text_sha256":digest,"span":{"start":start,"end":at,"quote":quote,"offset_unit":"utf16_code_unit"},"claim_refs":[],"role":"PRIMARY"})}).collect();
    let es=json!({"contract_version":"lightog-demand/0.1","evidence_set_id":"es","snapshot":snapshot,"fragments":fragments});
    let context=json!({"examples":{"es":es},"source_texts":[{"source_ref":"src","source_revision":"r1","text":text,"original_sha256":digest,"parser_version":"authored/1","blocks":[{"block_ref":"b","start":0,"end":size}]}],"authority":{"requests":[],"allowed_snapshots":[snapshot],"claims":[],"receipts":[],"scope_bindings":[],"entities":[],"predicate_refs":[],"user_definitions":[],"groups":[],"entity_links":[]}});
    let question="How does mode Alpha affect the index?";
    let runtime=json!({"current_snapshot":snapshot,"grants":[{"request_ref":"request_authored","question_sha256":text_sha(question),"base_ref":snapshot["base_ref"],"source_epoch":0,"access_mode":"LEARN","learning_requested":true}],"persisted_job_sha256":null,"persisted_revision":0,"support_hold_candidate_sha256":[],"graph_record_sha256":null,"commit_record_sha256":null,"index_record_sha256":null,"index_payload_sha256":null});
    json!({"contract_version":learning::VERSION,"request":{"request_ref":"request_authored","raw_question":question,"cq_seeds":[{"seed_id":"seed_authored","text":question}],"kind":"DISCOVERY","policy_version":"authored-policy/1"},"evidence_set":es,"source_gap":null,"context":context,"runtime":runtime})
}
fn input(raw:Value)->Value {
 let f=fixture();let prepared=knowledge_build::prepare_extract(&json!({"evidence_set_ref":"es","cq_guidance":f["request"]["raw_question"],"trusted_context":f["context"]})).unwrap();
 let response=json!({"content":serde_json::to_string(&raw).unwrap(),"request_id":"authored_response","finish_reason":"stop"});
 let old=support_selection::execute("materialize_local_required_occurrence_v1",&json!({"prepared":prepared,"trusted_context":f["context"],"raw":response["content"],"unit_id":"original","max_candidates":8})).unwrap();
 let mut j=learning::execute("create",&f).unwrap()["job"].clone();
 for stage in ["RETRIEVING","EXTRACTING"]{let mut rt=f["runtime"].clone();rt["persisted_job_sha256"]=j["job_sha256"].clone();rt["persisted_revision"]=j["revision"].clone();j=learning::execute("step",&json!({"contract_version":learning::VERSION,"job":j,"context":f["context"],"runtime":rt,"next_stage":stage})).unwrap()["job"].clone();}
 let runtime=|j:&Value|{let mut r=f["runtime"].clone();r["persisted_job_sha256"]=j["job_sha256"].clone();r["persisted_revision"]=j["revision"].clone();r};
 j=learning::execute("begin_attempt",&json!({"contract_version":learning::VERSION,"job":j,"context":f["context"],"runtime":runtime(&j),"attempt_id":"attempt","phase":"EXTRACTION_000","request_sha256":"a".repeat(64)})).unwrap()["job"].clone();
 j=learning::execute("finish_attempt",&json!({"contract_version":learning::VERSION,"job":j,"context":f["context"],"runtime":runtime(&j),"attempt_id":"attempt","outcome":"RETURNED","request_id":"authored_response","response_sha256":hash(&response)})).unwrap()["job"].clone();
 json!({"origin_job":j,"batch_index":0,"current_snapshot":j["snapshot"],"prepared":prepared,"trusted_context":f["context"],"original_response":{"response":response},"original_materialized":old,"original_unit_id":"original","mode":"STRUCTURE","fact_index":0})
}
fn raw()->Value {json!({"entities":[{"local_id":"Alpha","surface":"Alpha","type_label":null,"mention_evidence_id":"mode","mention_occurrence":1},{"local_id":"index","surface":"index","type_label":null,"mention_evidence_id":"assertion","mention_occurrence":1}],"candidates":[{"kind":"ATTRIBUTE","subject_local_id":"Alpha","predicate":{"label":"leaves unchanged","description":"Preserved source behavior","evidence_ids":["assertion"]},"object":{"entity_local_id":"index","typed_value":null},"direction":"DIRECTED","description":"Mode Alpha leaves the index unchanged.","keywords":["index"],"qualifiers":{"scope":null,"modality":"REPORTED","negated":false,"unit":null,"effective_time":null},"conditions":[],"support_roles":{"assertion":["assertion"],"subject_scope":["mode"],"antecedent":["antecedent"],"condition":[]}}]})}
#[test]fn discriminator_repair_changes_no_semantic_fields_and_still_requires_review(){
 let original=raw();let p=input(original.clone());assert_eq!(p["original_materialized"]["quarantined"][0]["error_code"],"CANDIDATE_ATTRIBUTE_INVALID");
 let out=recovery::execute("prepare",&p).unwrap();let mut fixed=out["derived_raw"]["candidates"][0].clone();assert_eq!(fixed["kind"],"RELATION");fixed["kind"]=json!("ATTRIBUTE");assert_eq!(fixed,original["candidates"][0]);assert_eq!(out["materialized"]["candidates"].as_array().unwrap().len(),1);assert_eq!(out["semantic_support_certified"],false);
 assert!(recovery::execute("verify",&json!({"recovery_input":p})).is_err());
}
#[test]fn reverse_discriminator_is_generic_but_ambiguous_direction_is_not_guessed(){
 let mut r=raw();r["candidates"][0]["kind"]=json!("RELATION");r["candidates"][0]["object"]=json!({"entity_local_id":null,"typed_value":{"kind":"STRING","value":"unchanged"}});r["candidates"][0]["direction"]=json!("NONE");
 let p=input(r);assert_eq!(p["original_materialized"]["candidates"].as_array().unwrap().len(),1);assert_eq!(recovery::execute("prepare",&p).unwrap_err().code,"RECOVERY_FACT_NOT_STRUCTURAL_FAILURE");
 let mut r=raw();r["candidates"][0]["direction"]=json!("NONE");assert_eq!(recovery::execute("prepare",&input(r)).unwrap_err().code,"RECOVERY_REQUIRES_NEW_PROPOSAL");
}
#[test]fn source_and_original_response_are_bound(){let p=input(raw());let mut changed=p.clone();changed["current_snapshot"]["source_epoch"]=json!(99);assert_eq!(recovery::execute("prepare",&changed).unwrap_err().code,"RECOVERY_SOURCE_CHANGED");let mut changed=p.clone();changed["original_response"]["response"]["content"]=json!("{}");assert_eq!(recovery::execute("prepare",&changed).unwrap_err().code,"RECOVERY_ORIGINAL_RESPONSE_CHANGED");}
#[test]fn an_empty_result_requires_independent_review_of_every_fragment(){
 let mut p=input(json!({"entities":[],"candidates":[]}));p["mode"]=json!("EMPTY_BATCH");p["replacement_response"]=json!({"request_id":"new_proposal","finish_reason":"stop","content":"{\"entities\":[],\"candidates\":[]}"});
 assert_eq!(recovery::execute("verify",&json!({"recovery_input":p,"empty_review":{"decision":"NO_ASSERTIONS","request_id":"review","reason":"Authored check","evidence_ids":[]}})).unwrap_err().code,"RECOVERY_EMPTY_EVIDENCE_INCOMPLETE");
 let ids:Vec<_>=p["prepared"]["payload"]["evidence_menu"].as_array().unwrap().iter().map(|f|f["evidence_id"].clone()).collect();let out=recovery::execute("verify",&json!({"recovery_input":p,"empty_review":{"decision":"NO_ASSERTIONS","request_id":"review","reason":"Authored check, not semantic truth","evidence_ids":ids}})).unwrap();assert_eq!(out["empty_confirmed"],true);
}
