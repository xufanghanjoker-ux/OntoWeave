use lightog_core::{common::{len, slice16, text_sha}, extraction_menu::execute};
use serde_json::{json,Value};

fn input(text: &str) -> Value {
 let hash=text_sha(text);
 let snapshot=json!({"base_ref":"menu_test","source_epoch":0,"graph_revision":null,"sources":[{"source_ref":"source","source_revision":"rev1","original_sha256":hash,"text_sha256":hash,"parser_version":"test/1"}]});
 let fragment=json!({"id":"parent","origin":"SOURCE_FRAGMENT","source_ref":"source","source_revision":"rev1","block_ref":"block","text_sha256":hash,"span":{"start":0,"end":len(text),"quote":text,"offset_unit":"utf16_code_unit"},"claim_refs":[],"role":"PRIMARY"});
 let es=json!({"contract_version":"lightog-demand/0.1","evidence_set_id":"es_parent","snapshot":snapshot,"fragments":[fragment]});
 json!({"evidence_set_ref":"es_parent","cq_guidance":"Describe source-supported relations and conditions.","trusted_context":{"examples":{"input":es},"source_texts":[{"source_ref":"source","source_revision":"rev1","text":text,"original_sha256":hash,"parser_version":"test/1","blocks":[{"block_ref":"block","start":0,"end":len(text)}]}],"authority":{"requests":[],"allowed_snapshots":[snapshot],"claims":[],"receipts":[],"scope_bindings":[],"entities":[],"predicate_refs":[],"user_definitions":[],"groups":[],"entity_links":[]}}})
}
#[test]
fn generated_spans_are_exact_original_utf16_including_emoji_crlf_and_non_ascii() {
 let text="  😀 RefCell<T> checks at runtime.\r\nRc<T> shares ownership.\n\n  中文条件：未授权时禁止。  ";
 let v=execute("prepare",&input(text)).unwrap();
 let rows=v["evidence_set"]["fragments"].as_array().unwrap();assert!(rows.len()>=3);
 for f in rows {let span=&f["span"];assert_eq!(slice16(text,span["start"].as_u64().unwrap() as usize,span["end"].as_u64().unwrap() as usize),span["quote"].as_str().unwrap());assert_eq!(f["block_ref"],"block");assert_eq!(f["text_sha256"],text_sha(text));}
 assert_eq!(v["model_called"],false);assert_eq!(v["semantic_support_certified"],false);
}
#[test]
fn ids_and_prepared_menu_are_deterministic_and_not_model_chosen() {
 let payload=input("Alpha supports Beta. Beta requires permission.");
 let a=execute("prepare",&payload).unwrap();let b=execute("prepare",&payload).unwrap();assert_eq!(a,b);
 assert_eq!(a["prepared"]["payload"]["evidence_set_ref"],a["evidence_set"]["evidence_set_id"]);
 assert_eq!(a["prepared"]["payload"]["evidence_menu"].as_array().unwrap().len(),a["evidence_set"]["fragments"].as_array().unwrap().len());
}
#[test]
fn token_case_spaces_and_newlines_are_never_normalized() {
 let text="Alpha\t  supports\nBeta when\r\npermitted.\n\n| A | B |\n|---|---|\n| x | y |";
 let out=execute("prepare",&input(text)).unwrap();
 assert_eq!(out["evidence_set"]["fragments"][0]["span"]["quote"],"Alpha\t  supports\nBeta when\r\npermitted.");
 assert!(out["evidence_set"]["fragments"][1]["span"]["quote"].as_str().unwrap().contains("| A | B |\n|---|---|"));
}
#[test]
fn long_segments_split_on_unicode_scalar_boundaries_without_loss() {
 let text="😀中".repeat(50);let mut p=input(&text);p["options"]=json!({"max_segment_utf16":32});
 let out=execute("prepare",&p).unwrap();let pieces=out["evidence_set"]["fragments"].as_array().unwrap();
 assert_eq!(pieces.iter().map(|f|f["span"]["quote"].as_str().unwrap()).collect::<String>(),text);
 assert!(pieces.iter().all(|f|len(f["span"]["quote"].as_str().unwrap())<=32));
}
#[test]
fn strict_limit_splits_before_a_surrogate_pair_and_cjk_needs_no_whitespace() {
 let text=format!("{}😀{}","x".repeat(31),"z".repeat(9));let mut p=input(&text);p["options"]=json!({"max_segment_utf16":32});let out=execute("prepare",&p).unwrap();assert_eq!(out["evidence_set"]["fragments"][0]["span"]["quote"],"x".repeat(31));
 let out=execute("prepare",&input("甲执行。乙保存。丙核验。")).unwrap();assert_eq!(out["evidence_set"]["fragments"].as_array().unwrap().len(),3);
}
#[test]
fn duplicate_registry_set_ids_are_rejected_rather_than_choosing_one() {
 let mut p=input("Alpha supports Beta.");p["trusted_context"]["examples"]["other"]=p["trusted_context"]["examples"]["input"].clone();assert_eq!(execute("prepare",&p).unwrap_err().code,"MENU_EVIDENCE_SET_AMBIGUOUS");
}
#[test]
fn resource_limit_rejects_whole_menu_instead_of_silent_truncation() {
 let mut p=input("One. Two. Three.");p["options"]=json!({"max_menu_items":2});
 assert_eq!(execute("prepare",&p).unwrap_err().code,"MENU_RESOURCE_LIMIT");
}
#[test]
fn tampered_parent_quote_or_source_version_cannot_create_new_evidence() {
 let mut p=input("Alpha supports Beta.");p["trusted_context"]["examples"]["input"]["fragments"][0]["span"]["quote"]=json!("Fake data that differs");assert!(execute("prepare",&p).is_err());
 let mut p=input("Alpha supports Beta.");p["trusted_context"]["examples"]["input"]["snapshot"]["source_epoch"]=json!(2);assert!(execute("prepare",&p).is_err());
}
#[test]
fn exact_source_context_must_remain_inside_the_registered_block() {
 let mut p=input("First. Second.");p["trusted_context"]["source_texts"][0]["blocks"][0]["end"]=json!(6);assert!(execute("prepare",&p).is_err());
}
#[test]
fn unknown_options_and_model_supplied_authority_fields_are_rejected() {
 let mut p=input("Alpha supports Beta.");p["options"]=json!({"max_segment_utf16":0});assert!(execute("prepare",&p).is_err());
 let mut p=input("Alpha supports Beta.");p["options"]=json!({"first_match":true});assert!(execute("prepare",&p).is_err());
 let mut p=input("Alpha supports Beta.");p["verified"]=json!(true);assert!(execute("prepare",&p).is_err());
}
#[test]
fn segment_ids_bind_original_source_revision_and_snapshot() {
 let a=execute("prepare",&input("Alpha supports Beta.")).unwrap();let mut p=input("Alpha supports Beta.");
 let ctx=&mut p["trusted_context"];ctx["source_texts"][0]["source_revision"]=json!("rev2");ctx["examples"]["input"]["snapshot"]["sources"][0]["source_revision"]=json!("rev2");ctx["examples"]["input"]["fragments"][0]["source_revision"]=json!("rev2");ctx["authority"]["allowed_snapshots"][0]["sources"][0]["source_revision"]=json!("rev2");
 let b=execute("prepare",&p).unwrap();assert_ne!(a["evidence_set"]["fragments"][0]["id"],b["evidence_set"]["fragments"][0]["id"]);
}
