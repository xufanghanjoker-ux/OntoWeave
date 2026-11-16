use lightog_core::{source_human_review_v1 as review,common::{len,text_sha}};
use serde_json::{json,Value};
fn fixture()->Value{
 let text="🚀 SOP 层用于执行；SOP 层用于流程。";
 let snapshot=json!({"base_ref":"kb_review","source_epoch":0,"graph_revision":null,"sources":[{"source_ref":"source_1","source_revision":"v1","text_sha256":text_sha(text)}]});
 let options:Vec<_>=text.match_indices("SOP 层").enumerate().map(|(i,(at,_))|{let start=len(&text[..at]);json!({"id":format!("choice_{i}"),"label":format!("原文位置{}",i+1),"evidence_id":"paragraph_1","source_ref":"source_1","source_revision":"v1","span":{"start":start,"end":start+len("SOP 层"),"quote":"SOP 层","offset_unit":"utf16_code_unit"}})}).collect();
 json!({"contract_version":review::VERSION,"item":{"kind":"MENTION_SCOPE","title":"请选择指向","candidate":{"text":"SOP层处理执行","surface":"SOP层"},"origin":{"task_ref":"sl_origin","batch_index":1,"registry_index":0,"local_id":"sop","raw_sha256":"a".repeat(64)},"source_snapshot":snapshot,"options":options},"current_snapshot":snapshot,"source_texts":[{"source_ref":"source_1","source_revision":"v1","text":text}]})
}
fn prepared()->Value{let p=fixture();let item=review::execute("prepare",&p).unwrap();json!({"contract_version":review::VERSION,"item":item,"current_snapshot":p["current_snapshot"],"source_texts":p["source_texts"],"command":{"request_id":"request_1","item_revision":item["item_revision"],"action":"SELECT_OCCURRENCE","option_id":"choice_1","reason":"这里指向流程中的主体"},"actor":{"kind":"LOCAL_OPERATOR","id":"local-workbench"}})}
#[test]fn exact_choice_records_human_location_judgement_without_certifying_fact_or_graph(){
 let p=prepared();let d=review::execute("decide",&p).unwrap();assert_eq!(d["selected_option"]["id"],"choice_1");assert_eq!(d["semantic_support_certified"],false);assert_eq!(d["graph_committed"],false);assert_eq!(d["model_raw_rewritten"],false);
 let valid=json!({"contract_version":review::VERSION,"item":p["item"],"decision":d,"current_snapshot":p["current_snapshot"],"source_texts":p["source_texts"]});assert_eq!(review::execute("validate_decision",&valid).unwrap(),d);
}
#[test]fn stale_source_and_stale_item_revision_cannot_apply_even_if_quote_exists(){
 let mut p=prepared();p["current_snapshot"]["source_epoch"]=json!(1);assert_eq!(review::execute("decide",&p).unwrap_err().code,"HUMAN_REVIEW_SOURCE_STALE");
 let mut p=prepared();p["command"]["item_revision"]=json!("old");assert_eq!(review::execute("decide",&p).unwrap_err().code,"HUMAN_REVIEW_REVISION_STALE");
}
#[test]fn background_graph_progress_does_not_invalidate_the_same_sources(){
 let p=prepared();let d=review::execute("decide",&p).unwrap();let mut current=p["current_snapshot"].clone();current["graph_revision"]=json!("new_graph");
 assert_eq!(review::execute("validate_decision",&json!({"contract_version":review::VERSION,"item":p["item"],"decision":d,"current_snapshot":current,"source_texts":p["source_texts"]})).unwrap(),d);
}
#[test]fn tampered_quote_cut_surrogate_or_changed_source_hash_is_rejected(){
 let mut p=fixture();p["item"]["options"][0]["span"]["quote"]=json!("编造");assert_eq!(review::execute("prepare",&p).unwrap_err().code,"HUMAN_REVIEW_SPAN_INVALID");
 let mut p=fixture();p["item"]["options"][0]["span"]["start"]=json!(1);assert_eq!(review::execute("prepare",&p).unwrap_err().code,"HUMAN_REVIEW_SPAN_INVALID");
 let mut p=fixture();p["source_texts"][0]["text_sha256"]=json!("b".repeat(64));assert_eq!(review::execute("prepare",&p).unwrap_err().code,"HUMAN_REVIEW_SOURCE_HASH_CHANGED");
}
#[test]fn unknown_option_and_mutated_item_cannot_choose_a_new_span(){
 let mut p=prepared();p["command"]["option_id"]=json!("not_in_menu");assert_eq!(review::execute("decide",&p).unwrap_err().code,"HUMAN_REVIEW_OPTION_INVALID");
 let mut p=prepared();p["item"]["options"][0]["span"]["start"]=json!(999);assert_eq!(review::execute("decide",&p).unwrap_err().code,"HUMAN_REVIEW_ITEM_CHANGED");
}
#[test]fn exclusion_and_deferral_are_explicit_non_location_actions(){
 for action in ["EXCLUDE_CANDIDATE","DEFER"]{let mut p=prepared();p["command"]["action"]=json!(action);p["command"]["option_id"]=Value::Null;let d=review::execute("decide",&p).unwrap();assert_eq!(d["action"],action);assert!(d["selected_option"].is_null());}
}
#[test]fn receipt_tampering_is_detected_before_correction(){
 let p=prepared();let mut d=review::execute("decide",&p).unwrap();d["action"]=json!("EXCLUDE_CANDIDATE");assert_eq!(review::execute("validate_decision",&json!({"contract_version":review::VERSION,"item":p["item"],"decision":d,"current_snapshot":p["current_snapshot"],"source_texts":p["source_texts"]})).unwrap_err().code,"HUMAN_REVIEW_RECEIPT_CHANGED");
}
#[test]fn review_context_must_be_the_actual_surrounding_source_not_a_misleading_paragraph(){
 let mut p=fixture();let text=p["source_texts"][0]["text"].as_str().unwrap().to_owned();
 p["item"]["options"][0]["context_span"]=json!({"start":0,"end":len(&text),"quote":text,"offset_unit":"utf16_code_unit"});
 p["item"]["options"][0]["context_quote"]=json!(text);assert!(review::execute("prepare",&p).is_ok());
 p["item"]["options"][0]["context_quote"]=json!("另一个人的上下文");assert_eq!(review::execute("prepare",&p).unwrap_err().code,"HUMAN_REVIEW_CONTEXT_INVALID");
}
#[test]fn preparing_many_items_preserves_valid_items_and_reports_bad_ones_individually(){
 let p=fixture();let mut invalid=p["item"].clone();invalid["options"][0]["span"]["quote"]=json!("并非原文");
 let result=review::execute("prepare_many",&json!({"contract_version":review::VERSION,"items":[p["item"],invalid],"current_snapshot":p["current_snapshot"],"source_texts":p["source_texts"]})).unwrap();
 assert_eq!(result["items"].as_array().unwrap().len(),1);assert_eq!(result["errors"][0]["index"],1);assert_eq!(result["errors"][0]["error_code"],"HUMAN_REVIEW_SPAN_INVALID");
}
