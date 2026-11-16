//! Source packing changes context utilization, never source text or review gates.
use lightog_core::{common::{a,canonical_hash,len,s,text_sha},fine_source_evidence as fine};
use serde_json::{json,Value};
use std::collections::BTreeMap;

fn input(texts:&[String])->Value{
 let mut sources=vec![];let mut fragments=vec![];let mut source_texts=vec![];
 for (i,text) in texts.iter().enumerate(){
  let source=format!("source_{i}");let revision=format!("revision_{i}");let block=format!("block_{i}");let sha=text_sha(text);
  sources.push(json!({"source_ref":source,"source_revision":revision,"text_sha256":sha,"original_sha256":sha,"parser_version":"authored/1"}));
  fragments.push(json!({"id":format!("original_{i}"),"origin":"SOURCE_FRAGMENT","source_ref":source,"source_revision":revision,"block_ref":block,"text_sha256":sha,"span":{"start":0,"end":len(text),"quote":text,"offset_unit":"utf16_code_unit"},"claim_refs":[],"role":"PRIMARY"}));
  source_texts.push(json!({"source_ref":source,"source_revision":revision,"text":text,"original_sha256":sha,"parser_version":"authored/1","blocks":[{"block_ref":block,"start":0,"end":len(text)}]}));
 }
 let snapshot=json!({"base_ref":"compact_batches_authored","source_epoch":0,"graph_revision":null,"sources":sources});
 let es=json!({"contract_version":"lightog-demand/0.1","evidence_set_id":"compact_es","snapshot":snapshot,"fragments":fragments});
 let context=json!({"examples":{"compact_es":es},"source_texts":source_texts,"authority":{"requests":[],"allowed_snapshots":[snapshot],"claims":[],"receipts":[],"scope_bindings":[],"entities":[],"predicate_refs":[],"user_definitions":[],"groups":[],"entity_links":[]}});
 json!({"contract_version":fine::VERSION,"evidence_set":es,"context":context})
}
fn check(p:&Value,result:&Value){
 let mut request=p.clone();request["refinement"]=result.clone();
 assert_eq!(fine::execute("validate_batches",&request).unwrap()["validated"],true);
 assert_eq!(result["receipt_sha256"],canonical_hash(&result["receipt"]));
 assert_eq!(result["receipt"]["input_utf16"],result["receipt"]["output_utf16"]);
 assert_eq!(result["receipt"]["omitted_fragments"],0);assert_eq!(result["receipt"]["truncated"],false);
 assert_eq!(result["receipt"]["semantic_support_certified"],false);assert_eq!(result["execution_performed"],false);
 for batch in a(&result["batches"]){
  assert!(a(&batch["evidence_set"]["fragments"]).len()<=128);
  assert!(batch["receipt"]["output_utf16"].as_u64().unwrap()<=24000);
  for fragment in a(&batch["evidence_set"]["fragments"]){assert!(len(s(&fragment["span"]["quote"]))<=640);}
 }
}
fn reconstruct(result:&Value)->BTreeMap<String,String>{
 let mut text=BTreeMap::<String,String>::new();
 let mut ends=BTreeMap::<String,u64>::new();
 for batch in a(&result["batches"]){for (fragment,binding) in a(&batch["evidence_set"]["fragments"]).iter().zip(a(&batch["receipt"]["fragments"])){
  let source=s(&fragment["source_ref"]).to_owned();let revision=s(&fragment["source_revision"]);
  assert_eq!(revision,format!("revision_{}",source.strip_prefix("source_").unwrap()));
  assert_eq!(binding["source_ref"],fragment["source_ref"]);assert_eq!(binding["source_revision"],fragment["source_revision"]);
  assert_eq!(binding["evidence_id"],fragment["id"]);assert!(!a(&binding["parent_evidence_ids"]).is_empty());
  let end=ends.entry(source.clone()).or_default();assert_eq!(fragment["span"]["start"],*end);*end=fragment["span"]["end"].as_u64().unwrap();
  text.entry(source).or_default().push_str(s(&fragment["span"]["quote"]));
 }}text
}

#[test]
fn multiple_sources_fit_one_compact_batch_while_default_source_isolation_is_unchanged(){
 let texts=vec!["Maple capacity.\r\n\r\nOnly under testing. 😀".to_owned(),"Birch has a separate result.\n\n不可合并身份。".to_owned(),"Cedar tail evidence.\r\n".to_owned()];let p=input(&texts);let original=p.clone();
 let isolated=fine::execute("refine_batches",&p).unwrap();assert_eq!(a(&isolated["batches"]).len(),3);assert_eq!(isolated["receipt"]["policy"]["source_isolation"],"SOURCE_REF_AND_REVISION_V1");
 let compact=fine::execute("refine_compact_batches",&p).unwrap();assert_eq!(a(&compact["batches"]).len(),1);assert!(compact["receipt"]["policy"]["source_isolation"].is_null());check(&p,&compact);check(&p,&isolated);
 for (i,text) in texts.iter().enumerate(){assert_eq!(&reconstruct(&compact)[&format!("source_{i}")],text);}
 assert_eq!(p,original);assert_eq!(fine::execute("refine_batches",&p).unwrap(),isolated);
}
#[test]
fn compact_batches_keep_the_24k_limit_and_every_source_tail_with_unicode_and_crlf(){
 let texts=vec![format!("{}MAPLE_UNIQUE_TAIL😀","😀 条件A AND B。\r\n\r\n".repeat(750)),format!("{}BIRCH_UNIQUE_TAIL🛰","原文\t line; ".repeat(1400)),format!("{}CEDAR_UNIQUE_TAIL","third subject. ".repeat(900))];
 let p=input(&texts);let result=fine::execute("refine_compact_batches",&p).unwrap();assert!(a(&result["batches"]).len()>1);check(&p,&result);
 let rebuilt=reconstruct(&result);for(i,text)in texts.iter().enumerate(){assert_eq!(&rebuilt[&format!("source_{i}")],text);}
 assert!(result["receipt"]["input_utf16"].as_u64().unwrap()>24000);
}
#[test]
fn compact_batches_still_split_at_128_fragments_without_merging_distinct_parent_blocks(){
 let text="a".repeat(129);let mut p=input(&[text]);let original=p["evidence_set"]["fragments"][0].clone();
 let fragments:Vec<Value>=(0..129).map(|i|{let mut f=original.clone();f["id"]=json!(format!("parent_{i}"));f["block_ref"]=json!(format!("block_{i}"));f["span"]=json!({"start":i,"end":i+1,"quote":"a","offset_unit":"utf16_code_unit"});f}).collect();
 p["evidence_set"]["fragments"]=json!(fragments);p["context"]["source_texts"][0]["blocks"]=json!((0..129).map(|i|json!({"block_ref":format!("block_{i}"),"start":i,"end":i+1})).collect::<Vec<_>>());
 let result=fine::execute("refine_compact_batches",&p).unwrap();assert_eq!(a(&result["batches"]).len(),2);assert_eq!(result["batches"][1]["evidence_set"]["fragments"][0]["block_ref"],"block_128");assert_eq!(result["receipt"]["output_fragments"],129);check(&p,&result);
}
#[test]
fn compact_receipt_replays_and_rejects_policy_tail_reference_or_source_mutations(){
 let p=input(&["Maple original.\n\nMAPLE_TAIL".to_owned(),"Birch original.\n\nBIRCH_TAIL".to_owned()]);let result=fine::execute("refine_compact_batches",&p).unwrap();check(&p,&result);
 for mode in 0..4{let mut request=p.clone();let mut changed=result.clone();match mode{
  0=>changed["receipt"]["policy"]["source_isolation"]=json!("SOURCE_REF_AND_REVISION_V1"),
  1=>{changed["batches"][0]["evidence_set"]["fragments"].as_array_mut().unwrap().pop();},
  2=>changed["batches"][0]["receipt"]["fragments"][0]["source_ref"]=json!("borrowed_source"),
  _=>request["context"]["source_texts"][0]["text"]=json!("Changed source")}
  request["refinement"]=changed;assert!(fine::execute("validate_batches",&request).is_err(),"mode {mode}");
 }
}
