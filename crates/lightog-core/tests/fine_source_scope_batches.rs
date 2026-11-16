//! Complete task-group × source-context coverage, original synthetic fixtures.
use lightog_core::{common::{a,canonical_hash as hash,len,s,text_sha},document_scope_v1 as scope,fine_source_evidence as fine};
use serde_json::{json,Value};
use std::collections::{BTreeMap,BTreeSet};

fn fixture(subject_count:usize, filler:usize)->Value {
 let mut texts=[String::new(),String::new()];let mut names=vec![];
 for i in 0..subject_count {let name=format!("Model{i:03}");texts[i%2].push_str(&format!("{name} has a documented parameter.\n"));names.push((i%2,name));}
 for(i,text)in texts.iter_mut().enumerate(){text.push_str(&"Context only. 🚀 \r\n".repeat(filler));text.push_str(&format!("SOURCE_{i}_UNIQUE_TAIL😀"));}
 let mut refs=vec![];let mut fragments=vec![];let mut source_texts=vec![];
 for(i,text)in texts.iter().enumerate(){let source=format!("source_{i}");let block=format!("block_{i}");let sha=text_sha(text);
  refs.push(json!({"source_ref":source,"source_revision":"v1","original_sha256":sha,"text_sha256":sha,"parser_version":"authored/1"}));
  fragments.push(json!({"id":format!("original_{i}"),"origin":"SOURCE_FRAGMENT","source_ref":source,"source_revision":"v1","block_ref":block,"text_sha256":sha,"span":{"start":0,"end":len(text),"quote":text,"offset_unit":"utf16_code_unit"},"claim_refs":[],"role":"PRIMARY"}));
  source_texts.push(json!({"source_ref":source,"source_revision":"v1","text":text,"original_sha256":sha,"parser_version":"authored/1","blocks":[{"block_ref":block,"start":0,"end":len(text)}]}));
 }
 let snapshot=json!({"base_ref":"scope_matrix_authored","source_epoch":0,"graph_revision":null,"sources":refs});
 let es=json!({"contract_version":"lightog-demand/0.1","evidence_set_id":"matrix_es","snapshot":snapshot,"fragments":fragments});
 let context=json!({"examples":{"matrix_es":es},"source_texts":source_texts,"authority":{"requests":[],"allowed_snapshots":[snapshot],"claims":[],"receipts":[],"scope_bindings":[],"entities":[],"predicate_refs":[],"user_definitions":[],"groups":[],"entity_links":[]}});
 let prepared=scope::prepare(&json!({"snapshot":snapshot,"evidence_set":es,"context":context,"user_cqs":[],"definitions":"","max_batch_utf16":24000,"max_fragments_per_batch":64})).unwrap();
 let responses:Vec<Value>=a(&prepared["batches"]).iter().map(|batch|{
  let subjects:Vec<Value>=names.iter().filter_map(|(source,name)|{
   let m=a(&batch["source_evidence_menu"]).iter().find(|m|m["source_ref"]==format!("source_{source}") && s(&m["span"]["quote"]).contains(name))?;
   Some(json!({"surface":name,"evidence_id":m["evidence_id"],"occurrence":0,"rationale":"Authored source-mentioned subject."}))
  }).collect();
  let ids:Vec<String>=subjects.iter().map(|row|s(&row["evidence_id"]).to_owned()).collect::<BTreeSet<_>>().into_iter().collect();
  let families=if subjects.is_empty(){json!([])}else{json!([{"key":"parameter","label":"Parameter","question":"What is the documented parameter of {subject}?","target":"documented parameter","operation":"LOOKUP","conditions":[],"evidence_ids":ids,"subjects":subjects}])};
  json!({"batch_id":batch["batch_id"],"raw":{"families":families,"unknowns":[]}})
 }).collect();
 let plan=scope::materialize(&json!({"prepared":prepared,"responses":responses})).unwrap();
 assert_eq!(a(&plan["tasks"]).len(),subject_count);
 json!({"contract_version":fine::VERSION,"evidence_set":es,"context":context,"scope_plan":plan})
}
fn run(p:&Value)->Value{fine::execute("refine_scope_batches",p).unwrap()}
fn validate(p:&Value,r:&Value)->Value{fine::execute("validate_batches",&json!({"contract_version":fine::VERSION,"evidence_set":p["evidence_set"],"context":p["context"],"refinement":r})).unwrap()}

#[test]
fn every_task_group_receives_every_source_without_new_evidence_or_silent_tail_loss(){
 let p=fixture(9,0);let original=p.clone();let r=run(&p);
 assert_eq!(r["receipt"]["group_count"],3);assert_eq!(r["receipt"]["base_batch_count"],1);assert_eq!(a(&r["batches"]).len(),3);
 assert_eq!(a(&r["groups"][0]["scope_task_ids"]).len(),4);assert_eq!(a(&r["groups"][1]["scope_task_ids"]).len(),4);assert_eq!(a(&r["groups"][2]["scope_task_ids"]).len(),1);
 let mut task_ids=BTreeSet::new();let mut es_ids=BTreeSet::new();
 for(index,batch)in a(&r["batches"]).iter().enumerate(){
  assert_eq!(batch["batch_index"],index);assert!(es_ids.insert(s(&batch["evidence_set"]["evidence_set_id"])));
  assert_eq!(batch["scope_task_ids"],r["groups"][index]["scope_task_ids"]);
  for task in a(&batch["scope_task_ids"]){task_ids.insert(s(task).to_owned());}
  let mut rebuilt=BTreeMap::<String,String>::new();
  for f in a(&batch["evidence_set"]["fragments"]){rebuilt.entry(s(&f["source_ref"]).to_owned()).or_default().push_str(s(&f["span"]["quote"]));}
  for source in a(&p["context"]["source_texts"]){assert_eq!(rebuilt[s(&source["source_ref"])],s(&source["text"]));}
  assert_eq!(batch["evidence_set"]["fragments"],r["batches"][0]["evidence_set"]["fragments"]);
 }
 assert_eq!(task_ids.len(),9);assert_eq!(r["receipt"]["single_partition_claimed"],false);
 assert_eq!(r["receipt"]["output_utf16"].as_u64().unwrap(),r["receipt"]["unique_source_menu_utf16"].as_u64().unwrap()*3);
 assert_eq!(r["receipt"]["omitted_scope_tasks"],0);assert_eq!(r["receipt"]["truncated"],false);assert_eq!(r["scope_plan"],p["scope_plan"]);
 assert_eq!(validate(&p,&r)["validated"],true);assert_eq!(p,original);
}

#[test]
fn multiple_source_context_batches_are_repeated_completely_for_every_group(){
 let p=fixture(5,900);let r=run(&p);let base_count=r["receipt"]["base_batch_count"].as_u64().unwrap()as usize;
 assert!(base_count>1);assert_eq!(a(&r["batches"]).len(),base_count*2);
 for group in 0..2{
  let mut rebuilt=BTreeMap::<String,String>::new();
  for(index,batch)in a(&r["batches"]).iter().filter(|b|b["task_group_index"]==group).enumerate(){
   assert_eq!(batch["base_batch_index"],index);assert!(batch["receipt"]["output_utf16"].as_u64().unwrap()<=24000);
   for f in a(&batch["evidence_set"]["fragments"]){assert!(len(s(&f["span"]["quote"]))<=640);rebuilt.entry(s(&f["source_ref"]).to_owned()).or_default().push_str(s(&f["span"]["quote"]));}
  }
  for source in a(&p["context"]["source_texts"]){assert_eq!(rebuilt[s(&source["source_ref"])],s(&source["text"]));}
 }
 assert_eq!(validate(&p,&r)["validated"],true);
}

#[test]
fn missing_duplicated_reassigned_source_task_or_sealed_plan_is_rejected(){
 let p=fixture(5,0);let r=run(&p);
 for mode in 0..7{let mut bad=r.clone();match mode{
  0=>{bad["batches"].as_array_mut().unwrap().pop();},
  1=>{let b=bad["batches"][0].clone();bad["batches"][1]=b;},
  2=>bad["batches"][0]["scope_task_ids"]=bad["batches"][1]["scope_task_ids"].clone(),
  3=>bad["batches"][0]["evidence_set"]["fragments"][0]["span"]["quote"]=json!("changed"),
  4=>bad["groups"][0]["scope_task_ids"]=json!([]),
  5=>bad["scope_plan"]["tasks"][0]["target"]=json!("unbound target"),
  _=>bad["receipt"]["output_utf16"]=json!(1)
 }
 assert!(fine::execute("validate_batches",&json!({"contract_version":fine::VERSION,"evidence_set":p["evidence_set"],"context":p["context"],"refinement":bad})).is_err(),"mode {mode}");
 }
}

#[test]
fn source_changes_and_more_than_128_matrix_items_fail_explicitly_without_a_subset(){
 let p=fixture(1,0);let mut stale=p.clone();stale["scope_plan"]["snapshot"]["source_epoch"]=json!(1);
 assert!(fine::execute("refine_scope_batches",&stale).is_err());
 // An integrity-sealed large plan isolates the planner's resource boundary;
 // it is not a claim that a model discovered these 513 semantic tasks.
 let mut over=p.clone();let t=over["scope_plan"]["tasks"][0].clone();
 over["scope_plan"]["tasks"]=json!((0..513).map(|i|{let mut task=t.clone();task["id"]=json!(format!("resource_task_{i}"));task}).collect::<Vec<_>>());
 over["scope_plan"].as_object_mut().unwrap().remove("plan_id");over["scope_plan"]["plan_id"]=json!(format!("scope_plan_{}",&hash(&over["scope_plan"])[..32]));
 assert_eq!(fine::execute("refine_scope_batches",&over).unwrap_err().code,"FINE_SOURCE_SCOPE_WORK_RESOURCE_LIMIT");
}

#[test]
fn original_compact_and_isolated_paths_are_unchanged_by_scope_partition(){
 let p=fixture(5,0);let old=json!({"contract_version":fine::VERSION,"evidence_set":p["evidence_set"],"context":p["context"]});
 let isolated=fine::execute("refine_batches",&old).unwrap();let compact=fine::execute("refine_compact_batches",&old).unwrap();
 assert_eq!(a(&isolated["batches"]).len(),2);assert_eq!(a(&compact["batches"]).len(),1);
 let _scope=run(&p);
 assert_eq!(fine::execute("refine_batches",&old).unwrap(),isolated);assert_eq!(fine::execute("refine_compact_batches",&old).unwrap(),compact);
 for r in [&isolated,&compact]{assert_eq!(r["receipt"]["single_partition_claimed"],Value::Null);assert_eq!(r["scope_plan"],Value::Null);assert_eq!(validate(&p,r)["validated"],true);}
}
