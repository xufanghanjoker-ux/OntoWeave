use lightog_core::{common::canonical_hash,knowledge_build,semantic_review};
use serde_json::{json,Value};
fn load(s:&str)->Value{serde_json::from_str(s).unwrap()}
fn proposal()->Value{
 let authority=load(include_str!("../../../fixtures/demand-contract-v0.1/validation-context.json"));
 let source=load(include_str!("../../../fixtures/demand-contract-v0.1/source-texts.json"));
 let es=load(include_str!("../../../contracts/demand-v0.1/examples/evidence-set.json"));
 let ctx=json!({"examples":{"e":es},"source_texts":source["sources"],"authority":authority});
 let mention=|local:&str,label:&str,start:usize,end:usize|json!({"local_id":local,"label":label,"entity_ref":null,"type_label":null,"mentions":[{"evidence_ref":"e_new","span":{"start":start,"end":end,"quote":label,"offset_unit":"utf16_code_unit"}}]});
 let candidate=json!({"contract_version":"lightog-knowledge/0.2","candidate_id":"c_review_1","kind":"RELATION","snapshot":es["snapshot"],"evidence_set_ref":"es_synthetic","evidence_ids":["e_new"],"entities":[mention("cloud","丁云",0,2),mention("region","欧洲",11,13)],"subject_local_id":"cloud","predicate":{"predicate_ref":null,"proposed_definition":{"label":"服务地区","description":"资料声明的服务地区","evidence_ids":["e_new"]}},"object":{"entity_local_id":"region","typed_value":null},"direction":"DIRECTED","description":"丁云在欧洲面向零售客户提供电话服务","keywords":["地区"],"qualifiers":{"scope":"面向零售客户","modality":"REPORTED","negated":false,"unit":null,"effective_time":null},"conditions":[{"id":"retail","text":"面向零售客户","evidence_ids":["e_new"],"support_status":"UNVERIFIED"}],"status":"CANDIDATE","semantic_status":"UNVERIFIED"});
 let prepared=knowledge_build::execute("prepare_extract",&json!({"evidence_set_ref":"es_synthetic","cq_guidance":"服务地区和必要条件","trusted_context":ctx})).unwrap();
 let receipt=json!({"candidate_id":candidate["candidate_id"],"status":"VALIDATED_CANDIDATE","validator":"RUST_P2_BUILD","candidate_sha256":canonical_hash(&candidate),"prepared_payload_sha256":canonical_hash(&prepared["payload"]),"fact_support_evidence_ids":["e_new"],"registry_anchor_evidence_ids":["e_new"]});
 json!({"contract_version":semantic_review::VERSION,"candidates":[candidate],"prepared":prepared,"trusted_context":ctx,"receipts":[receipt],"context_evidence_ids":[],"max_context_utf16":12000})
}
fn reviewed(mut p:Value)->Value{
 let prepared=semantic_review::execute("prepare",&p).unwrap();
 let rows:Vec<_>=p["candidates"].as_array().unwrap().iter().map(|c|{let mut dims=serde_json::Map::new();for dim in semantic_review::DIMENSIONS{dims.insert(dim.to_owned(),json!({"decision":"SUPPORTED","reason":"Synthetic judgment fixture, not an actual model result","evidence_ids":["e_new"]}));}json!({"candidate_id":c["candidate_id"],"decision":"SUPPORTED","dimensions":dims})}).collect();
 p["manifest"]=prepared["manifest"].clone();p["review_output"]=json!({"reviews":rows});p["review_provenance"]=json!({"origin":"SYNTHETIC","review_request_id":"review1","proposal_request_ids":["proposal1"],"review_output_sha256":canonical_hash(&p["review_output"]),"model":"synthetic-offline","config_revision":1});p
}
fn bind(p:&mut Value){p["review_provenance"]["review_output_sha256"]=json!(canonical_hash(&p["review_output"]));}
#[test]
fn eligible_graph_is_built_only_from_complete_bound_reviews_and_not_published(){
 let p=reviewed(proposal());let out=semantic_review::execute("apply",&p).unwrap();assert_eq!(out["eligible_candidates"].as_array().unwrap().len(),1);assert_eq!(out["reviewed_build"]["graph"]["candidate_archive"],out["eligible_candidates"]);assert_eq!(out["eligible_candidates"][0]["semantic_status"],"UNVERIFIED");assert_eq!(out["publication_performed"],false);assert_eq!(out["semantic_support_certified"],false);assert_eq!(out["review_origin"],"SYNTHETIC");
}
#[test]
fn one_bad_review_does_not_remove_an_independent_supported_candidate(){
 let mut p=proposal();let mut c=p["candidates"][0].clone();c["candidate_id"]=json!("c_review_2");c["qualifiers"]["negated"]=json!(true);let mut r=p["receipts"][0].clone();r["candidate_id"]=c["candidate_id"].clone();r["candidate_sha256"]=json!(canonical_hash(&c));p["candidates"].as_array_mut().unwrap().push(c);p["receipts"].as_array_mut().unwrap().push(r);let mut p=reviewed(p);p["review_output"]["reviews"][1]["dimensions"]["negation"]["decision"]=json!("UNSUPPORTED");bind(&mut p);let out=semantic_review::execute("apply",&p).unwrap();assert_eq!(out["eligible_candidates"].as_array().unwrap().len(),1);assert_eq!(out["quarantined"].as_array().unwrap().len(),1);assert_eq!(out["all_proposal_candidates"].as_array().unwrap().len(),2);
}
#[test]
fn unknown_or_partial_cannot_be_promoted_by_a_supported_rollup(){
 for verdict in ["UNKNOWN","PARTIAL","UNSUPPORTED"]{let mut p=reviewed(proposal());p["review_output"]["reviews"][0]["dimensions"]["subject"]["decision"]=json!(verdict);bind(&mut p);let out=semantic_review::execute("apply",&p).unwrap();assert!(out["eligible_candidates"].as_array().unwrap().is_empty());assert!(out["reviewed_build"]["profiles"].as_array().unwrap().is_empty());}
}
#[test]
fn changed_snapshot_context_candidate_or_receipt_invalidates_review(){
 for key in ["description","context","receipt"]{let mut p=reviewed(proposal());match key{"description"=>{p["candidates"][0]["description"]=json!("changed");p["receipts"][0]["candidate_sha256"]=json!(canonical_hash(&p["candidates"][0]));},"context"=>{p["trusted_context"]["authority"]["requests"]=json!([{"changed":true}]);},_=>p["receipts"][0]["extra_audit_metadata"]=json!("changed")};assert!(semantic_review::execute("apply",&p).is_err());}
}
#[test]
fn missing_duplicate_unknown_or_incomplete_review_cannot_build_graph(){
 for mode in 0..4{let mut p=reviewed(proposal());match mode{0=>p["review_output"]["reviews"]=json!([]),1=>{let r=p["review_output"]["reviews"][0].clone();p["review_output"]["reviews"].as_array_mut().unwrap().push(r);},2=>p["review_output"]["reviews"][0]["candidate_id"]=json!("unknown"),_=>{p["review_output"]["reviews"][0]["dimensions"].as_object_mut().unwrap().remove("conditions");}}bind(&mut p);assert!(semantic_review::execute("apply",&p).is_err());}
}
#[test]
fn review_cannot_repair_facts_or_inject_published_status(){
 let mut p=reviewed(proposal());p["review_output"]["reviews"][0]["status"]=json!("PUBLISHED");bind(&mut p);assert_eq!(semantic_review::execute("apply",&p).unwrap_err().code,"REVIEW_OUTPUT_INVALID");
}
#[test]
fn same_request_cannot_pose_as_independent_review_or_output_hash_be_replaced(){
 let mut p=reviewed(proposal());p["review_provenance"]["review_request_id"]=json!("proposal1");assert_eq!(semantic_review::execute("apply",&p).unwrap_err().code,"REVIEW_NOT_INDEPENDENT_CONTEXT");let mut p=reviewed(proposal());p["review_provenance"]["review_output_sha256"]=json!("false");assert_eq!(semantic_review::execute("apply",&p).unwrap_err().code,"REVIEW_OUTPUT_BINDING_MISMATCH");
}
#[test]
fn source_text_tampering_or_fake_validator_receipt_is_rejected(){
 let mut p=proposal();p["receipts"][0]["validator"]=json!("INJECTED_CALLER_VALIDATOR");assert!(semantic_review::execute("prepare",&p).is_err());let mut p=proposal();p["trusted_context"]["source_texts"][0]["text"]=json!("fake");assert!(semantic_review::execute("prepare",&p).is_err());
}
#[test]
fn menu_context_is_budgeted_and_never_silently_truncated(){
 let mut p=proposal();p["max_context_utf16"]=json!(1);assert_eq!(semantic_review::execute("prepare",&p).unwrap_err().code,"REVIEW_CONTEXT_LIMIT");
}
#[test]
fn unsupported_dimensions_can_report_missing_evidence_but_not_unknown_menu_ids(){
 let mut p=reviewed(proposal());p["review_output"]["reviews"][0]["dimensions"]["conditions"]["decision"]=json!("UNKNOWN");p["review_output"]["reviews"][0]["dimensions"]["conditions"]["evidence_ids"]=json!([]);bind(&mut p);assert!(semantic_review::execute("apply",&p).unwrap()["eligible_candidates"].as_array().unwrap().is_empty());p["review_output"]["reviews"][0]["dimensions"]["conditions"]["evidence_ids"]=json!(["fake"]);bind(&mut p);assert_eq!(semantic_review::execute("apply",&p).unwrap_err().code,"REVIEW_OUTPUT_EVIDENCE_UNKNOWN");
}
