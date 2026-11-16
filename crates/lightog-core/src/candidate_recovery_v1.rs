//! Local, provenance-preserving recovery. No unchanged candidate is re-extracted.
use crate::common::{a, canonical_hash as hash, error, s, Result};
use serde_json::{json,Value};
use std::collections::BTreeSet;
fn need(ok:bool,c:&str)->Result<()>{if ok{Ok(())}else{Err(error(c,c))}}
pub const VERSION:&str="lightog-candidate-recovery/0.1";
fn origin(p:&Value)->Result<Value>{
 let j=&p["origin_job"];crate::source_learning_v1::validate_job_archive(j)?;
 need(p["current_snapshot"]==j["snapshot"]&&p["prepared"]["payload"]["snapshot"]==j["snapshot"],"RECOVERY_SOURCE_CHANGED")?;
 let response=&p["original_response"];let phase=format!("EXTRACTION_{:03}",p["batch_index"].as_u64().ok_or_else(||error("RECOVERY_BATCH_INVALID","RECOVERY_BATCH_INVALID"))?);
 let attempts:Vec<_>=a(&j["attempts"]).iter().filter(|x|x["phase"]==phase).collect();
 need(attempts.len()==1&&attempts[0]["outcome"]=="RETURNED"&&attempts[0]["response_sha256"]==hash(&response["response"]),"RECOVERY_ORIGINAL_RESPONSE_CHANGED")?;
 let m=crate::support_selection::execute("materialize_local_required_occurrence_v1",&json!({"prepared":p["prepared"],"trusted_context":p["trusted_context"],"raw":response["response"]["content"],"unit_id":p["original_unit_id"],"max_candidates":8}))?;
 need(m==p["original_materialized"],"RECOVERY_ORIGINAL_MATERIALIZATION_CHANGED")?;Ok(m)
}
fn prepare(p:&Value)->Result<Value>{
 let old=origin(p)?;let mut raw=crate::model_json_boundary::execute("parse",&json!({"raw":p["original_response"]["response"]["content"]}))?["parsed"].clone();
 let mode=s(&p["mode"]);
 if mode=="STRUCTURE"{
  let i=p["fact_index"].as_u64().ok_or_else(||error("RECOVERY_FACT_INVALID","RECOVERY_FACT_INVALID"))? as usize;
  let q:Vec<_>=a(&old["quarantined"]).iter().filter(|q|q["fact_index"]==i).collect();
  need(q.len()==1&&["CANDIDATE_ATTRIBUTE_INVALID","CANDIDATE_RELATION_INVALID"].contains(&s(&q[0]["error_code"])),"RECOVERY_FACT_NOT_STRUCTURAL_FAILURE")?;
  let mut f=a(&raw["candidates"]).get(i).cloned().ok_or_else(||error("RECOVERY_FACT_INVALID","RECOVERY_FACT_INVALID"))?;
  let entity=f["object"]["entity_local_id"].as_str().is_some_and(|x|!x.is_empty());
  let literal=f["object"]["typed_value"].is_object();
  if f["kind"]=="ATTRIBUTE"&&entity&&!literal&&["DIRECTED","UNDIRECTED"].contains(&s(&f["direction"])) {f["kind"]=json!("RELATION");}
  else if f["kind"]=="RELATION"&&!entity&&literal&&f["direction"]=="NONE" {f["kind"]=json!("ATTRIBUTE");}
  else{return Err(error("RECOVERY_REQUIRES_NEW_PROPOSAL","RECOVERY_REQUIRES_NEW_PROPOSAL"));}
  // Only the discriminator changes. Descriptions, evidence, direction, values,
  // participants, polarity and qualifiers are preserved byte-for-byte as JSON.
  raw["candidates"]=json!([f]);
 }else{
  need(mode=="EMPTY_BATCH"&&a(&old["candidates"]).is_empty()&&a(&old["quarantined"]).is_empty(),"RECOVERY_BATCH_NOT_EMPTY")?;
  need(p["replacement_response"]["request_id"].as_str().is_some_and(|x|!x.is_empty())&&p["replacement_response"]["finish_reason"]=="stop","RECOVERY_REPLACEMENT_INCOMPLETE")?;
  raw=crate::model_json_boundary::execute("parse",&json!({"raw":p["replacement_response"]["content"]}))?["parsed"].clone();
 }
 let unit=format!("local_recovery_{}",hash(&json!([p["origin_job"]["task_ref"],p["batch_index"],p["fact_index"],mode,hash(&raw)])));
 let m=crate::support_selection::execute("materialize_local_required_occurrence_v1",&json!({"prepared":p["prepared"],"trusted_context":p["trusted_context"],"raw":raw,"unit_id":unit,"max_candidates":8}))?;
 need(a(&m["quarantined"]).is_empty(),"RECOVERY_STILL_QUARANTINED")?;
 if mode=="STRUCTURE"{need(a(&m["candidates"]).len()==1,"RECOVERY_SINGLE_CANDIDATE_REQUIRED")?;}
 let staging=json!({"contract_version":crate::candidate_staging_v1::VERSION,"candidates":m["candidates"],"receipts":m["receipts"],"prepared":p["prepared"],"trusted_context":p["trusted_context"],"context_evidence_ids":a(&p["prepared"]["payload"]["evidence_menu"]).iter().map(|f|f["evidence_id"].clone()).collect::<Vec<_>>(),"max_context_utf16":24000});
 if !a(&m["candidates"]).is_empty(){crate::candidate_staging_v1::execute("stage",&staging)?;}
 Ok(json!({"contract_version":VERSION,"staging_input":staging,"materialized":m,"derived_raw":raw,"unit_id":unit,"original_response_sha256":hash(&p["original_response"]),"provenance_kind":if mode=="STRUCTURE"{"DISCRIMINATOR_ONLY_DERIVATION_NOT_A_NEW_MODEL_RESPONSE"}else{"EMPTY_BATCH_NEW_PROPOSAL"},"changed_fields":if mode=="STRUCTURE"{json!(["kind"])}else{json!([])},"original_raw_preserved":true,"semantic_support_certified":false,"publication_performed":false}))
}
fn verify(p:&Value)->Result<Value>{
 let derived=prepare(&p["recovery_input"])?;let st=&derived["staging_input"];let candidates=a(&st["candidates"]);
 if candidates.is_empty(){
  let review=&p["empty_review"];need(review["decision"]=="NO_ASSERTIONS"&&review["request_id"].as_str().is_some_and(|x|!x.is_empty())&&review["reason"].as_str().is_some_and(|x|!x.trim().is_empty()),"RECOVERY_EMPTY_UNCONFIRMED")?;
  let expected:BTreeSet<_>=a(&st["prepared"]["payload"]["evidence_menu"]).iter().map(|f|s(&f["evidence_id"])).collect();
  let actual:BTreeSet<_>=a(&review["evidence_ids"]).iter().map(s).collect();
  need(!expected.is_empty()&&expected==actual&&actual.len()==a(&review["evidence_ids"]).len(),"RECOVERY_EMPTY_EVIDENCE_INCOMPLETE")?;
  return Ok(json!({"candidates":[],"empty_confirmed":true,"receipt_sha256":hash(p)}));
 }
 let review=&p["review_input"];
 for field in ["candidates","receipts","prepared","trusted_context","context_evidence_ids","max_context_utf16"]{need(review[field]==st[field],"RECOVERY_REVIEW_BINDING_CHANGED")?;}
 need(review["contract_version"]==crate::semantic_review_v4::VERSION,"RECOVERY_REVIEW_VERSION_INVALID")?;
 let checked=crate::semantic_review_v4::execute("apply",review)?;
 let eligible:BTreeSet<_>=a(&checked["eligible_candidates"]).iter().map(|c|s(&c["candidate_id"])).collect();
 let mut seen=BTreeSet::new();let mut accepted=vec![];let mut held=vec![];let mut excluded=0usize;
 let human=a(&p["human_decisions"]);
 for d in human {
  let c=candidates.iter().find(|c|c["candidate_id"]==d["candidate_id"]).ok_or_else(||error("RECOVERY_HUMAN_CANDIDATE_UNKNOWN","RECOVERY_HUMAN_CANDIDATE_UNKNOWN"))?;
  let mut unsigned=d.clone();unsigned.as_object_mut().ok_or_else(||error("RECOVERY_HUMAN_INVALID","RECOVERY_HUMAN_INVALID"))?.remove("decision_id");
  need(seen.insert(s(&d["candidate_id"]))&&d["decision_id"]==format!("hr_{}",hash(&unsigned))&&d["candidate_sha256"]==hash(c)&&d["source_snapshot_sha256"]==hash(&p["recovery_input"]["current_snapshot"])&&d["review_receipt_sha256"]==hash(&checked["review_receipt"])&&d["actor"]=="LOCAL_OPERATOR"&&["CONFIRM_SUPPORT","EXCLUDE","DEFER"].contains(&s(&d["action"]))&&d["reason"].as_str().is_some_and(|x|!x.trim().is_empty()),"RECOVERY_HUMAN_BINDING_CHANGED")?;
 }
 for c in candidates {
  let d=human.iter().find(|d|d["candidate_id"]==c["candidate_id"]);
  if d.is_some_and(|d|d["action"]=="EXCLUDE"){excluded+=1;}
  else if d.is_some_and(|d|d["action"]=="DEFER"){held.push(c.clone());}
  else if eligible.contains(s(&c["candidate_id"]))||d.is_some_and(|d|d["action"]=="CONFIRM_SUPPORT"){accepted.push(c.clone());}
  else{held.push(c.clone());}
 }
 Ok(json!({"candidates":accepted,"all_candidates":candidates,"held_candidates":held,"excluded_candidates":excluded,"empty_confirmed":false,"review_receipt":checked["review_receipt"],"receipt_sha256":hash(p)}))
}
fn decide(p:&Value)->Result<Value>{
 let bundle=&p["bundle"];let verified=verify(bundle)?;
 need(p["current_snapshot"]==bundle["recovery_input"]["current_snapshot"],"RECOVERY_SOURCE_CHANGED")?;
 let c=a(&verified["all_candidates"]).iter().find(|c|c["candidate_id"]==p["candidate_id"]).ok_or_else(||error("RECOVERY_HUMAN_CANDIDATE_UNKNOWN","RECOVERY_HUMAN_CANDIDATE_UNKNOWN"))?;
 need(["CONFIRM_SUPPORT","EXCLUDE","DEFER"].contains(&s(&p["action"]))&&p["reason"].as_str().is_some_and(|x|!x.trim().is_empty()),"RECOVERY_HUMAN_INVALID")?;
 let mut d=json!({"contract_version":VERSION,"candidate_id":c["candidate_id"],"candidate_sha256":hash(c),"source_snapshot_sha256":hash(&p["current_snapshot"]),"review_receipt_sha256":hash(&verified["review_receipt"]),"action":p["action"],"reason":p["reason"],"actor":"LOCAL_OPERATOR"});
 d["decision_id"]=json!(format!("hr_{}",hash(&d)));Ok(json!({"decision":d}))
}
pub fn execute(op:&str,p:&Value)->Result<Value>{match op{"prepare"=>prepare(p),"verify"=>verify(p),"decide"=>decide(p),_=>Err(error("RECOVERY_OPERATION_UNKNOWN","RECOVERY_OPERATION_UNKNOWN"))}}
