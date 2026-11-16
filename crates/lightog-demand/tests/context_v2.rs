use lightog_demand::{evidence_bridge, wire, Kernel, ValidationContext};
use serde_json::{json,Value};
fn load(s:&str)->Value{serde_json::from_str(s).unwrap()}
fn bundle()->Value{
 let sources=load(include_str!("../../../fixtures/demand-contract-v0.1/source-texts.json"));
 json!({"context":{"examples":{},"source_texts":sources["sources"],"authority":load(include_str!("../../../fixtures/demand-contract-v0.1/validation-context.json"))},"question_spec":load(include_str!("../../../contracts/demand-v0.1/examples/ungraphed-subject.json")),"evidence_set":load(include_str!("../../../contracts/demand-v0.1/examples/evidence-set.json")),"coverage_report":load(include_str!("../../../contracts/demand-v0.1/examples/source-answer-coverage.json")),"answer_result":load(include_str!("../../../contracts/demand-v0.1/examples/readonly-source-answer.json"))})
}
fn multi_block_bundle()->Value {
 let mut p=bundle();
 let text=p["context"]["source_texts"][0]["text"].as_str().unwrap().to_owned();
 let len=text.encode_utf16().count();
 let split=text.find('。').unwrap()+'。'.len_utf8();let first=text[..split].to_owned();let boundary=first.encode_utf16().count();
 p["evidence_set"]["fragments"][0]["span"]["end"]=json!(boundary);p["evidence_set"]["fragments"][0]["span"]["quote"]=json!(first);
 // Synthetic binary artifact hash intentionally differs from parsed text.
 let original=wire::bytes_sha(b"%PDF-1.7\0synthetic-artifact");
 p["context"]["source_texts"][0]=json!({"source_ref":"src_compare","source_revision":"src_compare_v1","text":text,"original_sha256":original,"parser_version":"parser-fixture/2","blocks":[{"block_ref":"src_compare_b1","start":0,"end":boundary},{"block_ref":"src_compare_b2","start":boundary,"end":len}]});
 for field in ["evidence_set","coverage_report","answer_result"]{p[field]["snapshot"]["sources"][0]["original_sha256"]=json!(original);p[field]["snapshot"]["sources"][0]["parser_version"]=json!("parser-fixture/2");}
 p["context"]["authority"]["allowed_snapshots"]=json!([p["evidence_set"]["snapshot"]]);
 p["coverage_report"]["requirements"][0]["unsearched_block_refs"]=json!(["src_compare_b1","src_compare_b2"]);
 p
}
#[test] fn complete_answer_bundle_supports_binary_artifact_and_multiple_blocks(){
 let p=multi_block_bundle();let r=evidence_bridge::execute("validate_answer_bundle",&p).unwrap();
 assert_eq!(r["basis"],"DOCUMENT");
}
#[test] fn missing_unsearched_pdf_block_is_not_complete_coverage(){
 let mut p=multi_block_bundle();p["coverage_report"]["requirements"][0]["unsearched_block_refs"]=json!(["src_compare_b1"]);
 assert_eq!(evidence_bridge::execute("validate_answer_bundle",&p).unwrap_err().code,"COVERAGE_SCOPE_INCOMPLETE");
}
#[test] fn cross_source_block_collisions_are_rejected_instead_of_collapsed(){
 let mut p=multi_block_bundle();p["context"]["source_texts"][0]["blocks"][1]["block_ref"]=json!("src_new_b1");
 assert_eq!(evidence_bridge::execute("validate_answer_bundle",&p).unwrap_err().code,"BLOCK_REF_COLLISION");
}
#[test] fn v2_registry_is_explicit_and_does_not_silently_change_old_constructor(){
 let p=multi_block_bundle();let k=Kernel::new().unwrap();
 assert_eq!(ValidationContext::from_value(&p["context"],&k).unwrap_err().code,"CONTEXT_INVALID");
 ValidationContext::from_value_v2(&p["context"],&k).unwrap();
}
#[test] fn duplicate_or_out_of_range_block_catalogue_is_rejected(){
 let mut p=multi_block_bundle();p["context"]["source_texts"][0]["blocks"][1]["block_ref"]=json!("src_compare_b1");
 assert!(ValidationContext::from_value_v2(&p["context"],&Kernel::new().unwrap()).is_err());
 let mut p=multi_block_bundle();p["context"]["source_texts"][0]["blocks"][1]["end"]=json!(999999);
 assert!(ValidationContext::from_value_v2(&p["context"],&Kernel::new().unwrap()).is_err());
}
