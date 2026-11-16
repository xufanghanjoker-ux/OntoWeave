//! Synthetic semantic judgments against actual scope/core contracts. No models.
use lightog_core::{common::{a,len,text_sha},document_scope_v1 as scope,document_scope_coverage_v1 as coverage};
use serde_json::{json,Value};

fn fixture()->Value{
 let text="🚀 Maple has capacity 10 under video testing. Birch has capacity 20 under video testing.";let sha=text_sha(text);
 let snapshot=json!({"base_ref":"coverage_authored","source_epoch":0,"graph_revision":null,"sources":[{"source_ref":"s","source_revision":"v1","original_sha256":sha,"text_sha256":sha,"parser_version":"authored/1"}]});
 let es=json!({"contract_version":"lightog-demand/0.1","evidence_set_id":"es","snapshot":snapshot,"fragments":[{"id":"e","origin":"SOURCE_FRAGMENT","source_ref":"s","source_revision":"v1","block_ref":"b","text_sha256":sha,"span":{"start":0,"end":len(text),"quote":text,"offset_unit":"utf16_code_unit"},"claim_refs":[],"role":"PRIMARY"}]});
 let ctx=json!({"examples":{"es":es},"source_texts":[{"source_ref":"s","source_revision":"v1","text":text,"original_sha256":sha,"parser_version":"authored/1","blocks":[{"block_ref":"b","start":0,"end":len(text)}]}],"authority":{"requests":[],"allowed_snapshots":[snapshot],"claims":[],"receipts":[],"scope_bindings":[],"entities":[],"predicate_refs":[],"user_definitions":[],"groups":[],"entity_links":[]}});
 let p=scope::prepare(&json!({"snapshot":snapshot,"evidence_set":es,"context":ctx,"user_cqs":[],"definitions":"","max_batch_utf16":24000,"max_fragments_per_batch":64})).unwrap();
 let ev=p["batches"][0]["source_evidence_menu"][0]["evidence_id"].clone();
 let proposal=json!({"families":[{"key":"capacity","label":"Capacity","question":"What is the capacity of {subject}?","target":"capacity","operation":"LOOKUP","conditions":[{"text":"Under video testing","evidence_ids":[ev]}],"evidence_ids":[ev],"subjects":[{"surface":"Maple","evidence_id":ev,"occurrence":0,"rationale":"Authored source mention."},{"surface":"Birch","evidence_id":ev,"occurrence":0,"rationale":"Authored source mention."}]}],"unknowns":[]});
 let plan=scope::materialize(&json!({"prepared":p,"responses":[{"batch_id":p["batches"][0]["batch_id"],"raw":proposal}]})).unwrap();
 json!({"plan":plan,"snapshot":snapshot,"evidence_menu":p["batches"][0]["source_evidence_menu"],"candidates":[{"id":"c_maple","description":"Maple capacity is 10 under video testing.","subject_label":"Maple","evidence_ids":[ev]},{"id":"c_birch","description":"Birch capacity is 20 under video testing.","subject_label":"Birch","evidence_ids":[ev]}]})
}
fn rows(p:&Value)->Value{
 let e=&p["manifest"]["evidence_ids"][0];
 json!({"rows":a(&p["review_tasks"]).iter().map(|t|json!({"task_id":t["id"],"decision":"SUPPORTED","candidate_ids":[if t["subject"]["surface"]=="Maple"{"c_maple"}else{"c_birch"}],"evidence_ids":[e],"reason":"Authored independent judgment with the same source, subject and condition."})).collect::<Vec<_>>()})
}
#[test]
fn every_task_is_accounted_and_receipt_binds_the_exact_review_without_certifying_semantics(){
 let input=fixture();let p=coverage::prepare(&input).unwrap();let raw=rows(&p);
 assert_eq!(p["review_tasks"],input["plan"]["tasks"]);assert_eq!(a(&p["review_tasks"]).len(),2);assert_eq!(p["review_tasks"][0]["conditions"][0]["text"],"Under video testing");
 let r=coverage::materialize(&json!({"prepared":p,"raw":raw.to_string()})).unwrap();
 assert_eq!(r["ready_for_publication"],true);assert_eq!(r["all_supported"],true);assert_eq!(r["all_tasks_accounted"],true);assert_eq!(r["semantic_support_certified"],false);assert_eq!(r["coverage_complete"],false);
 let validated=coverage::execute("validate_receipt",&json!({"prepared":p,"raw":raw,"receipt":r,"current_snapshot":input["snapshot"]})).unwrap();assert_eq!(validated["validated"],true);
}
#[test]
fn explicit_source_insufficiency_is_finite_limited_availability_not_full_support(){
 let p=coverage::prepare(&fixture()).unwrap();let mut raw=rows(&p);raw["rows"][1]["decision"]=json!("SOURCE_INSUFFICIENT");raw["rows"][1]["candidate_ids"]=json!([]);
 let r=coverage::materialize(&json!({"prepared":p,"raw":raw})).unwrap();assert_eq!(r["ready_for_publication"],true);assert_eq!(r["limited_available"],true);assert_eq!(r["all_supported"],false);assert_eq!(r["coverage_complete"],false);
}
#[test]
fn missing_extraction_and_unknown_cannot_become_publication_ready(){
 let p=coverage::prepare(&fixture()).unwrap();for decision in ["EXTRACTION_GAP","UNKNOWN"]{let mut raw=rows(&p);raw["rows"][1]["decision"]=json!(decision);raw["rows"][1]["candidate_ids"]=json!([]);let r=coverage::materialize(&json!({"prepared":p,"raw":raw})).unwrap();assert_eq!(r["ready_for_publication"],false);assert_eq!(r["all_supported"],false);assert_eq!(r["limited_available"],false);}
}
#[test]
fn missing_duplicate_foreign_tasks_or_references_are_rejected(){
 let p=coverage::prepare(&fixture()).unwrap();
 for mode in 0..6{let mut raw=rows(&p);match mode{0=>{raw["rows"].as_array_mut().unwrap().pop();},1=>raw["rows"][1]=raw["rows"][0].clone(),2=>raw["rows"][0]["task_id"]=json!("not_in_scope"),3=>raw["rows"][0]["candidate_ids"]=json!(["foreign"]),4=>raw["rows"][0]["evidence_ids"]=json!(["foreign"]),_=>raw["rows"][0]["approved"]=json!(true)}assert!(coverage::materialize(&json!({"prepared":p,"raw":raw})).is_err());}
}
#[test]
fn insufficient_and_supported_need_distinct_provenance(){
 let p=coverage::prepare(&fixture()).unwrap();
 for mode in 0..4{let mut raw=rows(&p);match mode{0=>raw["rows"][0]["candidate_ids"]=json!([]),1=>raw["rows"][0]["evidence_ids"]=json!([]),2=>raw["rows"][0]["decision"]=json!("SOURCE_INSUFFICIENT"),_=>{raw["rows"][0]["decision"]=json!("EXTRACTION_GAP");raw["rows"][0]["evidence_ids"]=json!([]);}}assert!(coverage::materialize(&json!({"prepared":p,"raw":raw})).is_err());}
}
#[test]
fn menu_source_scope_candidate_support_and_unicode_lengths_are_validated(){
 for mode in 0..4{let mut i=fixture();match mode{0=>i["evidence_menu"][0]["source_revision"]=json!("old"),1=>i["evidence_menu"][0]["span"]["end"]=json!(1),2=>i["candidates"][0]["evidence_ids"]=json!(["missing"]),_=>{let e=i["evidence_menu"][0].clone();i["evidence_menu"].as_array_mut().unwrap().push(e);}}assert!(coverage::prepare(&i).is_err());}
}
#[test]
fn receipts_and_prepared_data_cannot_be_rebound_or_rewritten(){
 let i=fixture();let p=coverage::prepare(&i).unwrap();let raw=rows(&p);let r=coverage::materialize(&json!({"prepared":p,"raw":raw})).unwrap();
 let mut changed=p.clone();changed["candidates"][0]["description"]=json!("tampered");assert!(coverage::materialize(&json!({"prepared":changed,"raw":raw})).is_err());
 let mut changed=r.clone();changed["ready_for_publication"]=json!(false);assert!(coverage::execute("validate_receipt",&json!({"prepared":p,"raw":raw,"receipt":changed,"current_snapshot":i["snapshot"]})).is_err());
 let mut stale=i["snapshot"].clone();stale["source_epoch"]=json!(1);assert_eq!(coverage::execute("validate_receipt",&json!({"prepared":p,"raw":raw,"receipt":r,"current_snapshot":stale})).unwrap_err().code,"SCOPE_COVERAGE_CURRENT_SNAPSHOT_CHANGED");
 assert_eq!(coverage::materialize(&json!({"prepared":p,"raw":"{\"rows\":[],\"rows\":[]}"})).unwrap_err().code,"CORE_DUPLICATE_KEY");
}
#[test]
fn partial_menu_cannot_turn_local_insufficiency_into_scope_publication(){
 let mut i=fixture();let units:Vec<u16>=i["evidence_menu"][0]["span"]["quote"].as_str().unwrap().encode_utf16().take(12).collect();
 i["evidence_menu"][0]["span"]["quote"]=json!(String::from_utf16(&units).unwrap());i["evidence_menu"][0]["span"]["end"]=json!(12);
 let p=coverage::prepare(&i).unwrap();assert_eq!(p["source_menu_complete"],false);
 let mut raw=rows(&p);raw["rows"][1]["decision"]=json!("SOURCE_INSUFFICIENT");raw["rows"][1]["candidate_ids"]=json!([]);
 let r=coverage::materialize(&json!({"prepared":p,"raw":raw})).unwrap();assert_eq!(r["ready_for_publication"],false);assert_eq!(r["limited_available"],false);
}
#[test]
fn consistent_overlaps_are_merged_and_conflicting_overlaps_are_rejected(){
 let mut i=fixture();let mut duplicate=i["evidence_menu"][0].clone();duplicate["evidence_id"]=json!("overlap_alias");i["evidence_menu"].as_array_mut().unwrap().push(duplicate);
 assert_eq!(coverage::prepare(&i).unwrap()["source_menu_complete"],true);
 let original=i["evidence_menu"][1]["span"]["quote"].as_str().unwrap().to_owned();i["evidence_menu"][1]["span"]["quote"]=json!(original.replace("Maple","Yaple"));
 assert_eq!(coverage::prepare(&i).unwrap_err().code,"SCOPE_COVERAGE_EVIDENCE_OVERLAP_CHANGED");
}
