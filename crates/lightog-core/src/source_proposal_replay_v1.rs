//! Archived, known-returned extraction replay. No provider, dispatch, storage,
//! new model request or fabricated RETURNED observation. The trusted host owns
//! the archive/ledger readback; canonical hashes do not authenticate a provider.
use crate::common::{a,canonical_hash as hash,error,s,text_sha,Result};
use serde_json::{json,Value};
pub const POLICY:&str="source-learning-product-candidate-mvp-batched-replay-local-v1";
pub const VERSION:&str="lightog-source-proposal-replay/0.1";
fn need(ok:bool,code:&str)->Result<()>{if ok{Ok(())}else{Err(error(code,code))}}
fn shape(p:&Value,keys:&[&str])->Result<()>{need(p.as_object().is_some_and(|o|o.len()==keys.len()&&keys.iter().all(|k|o.contains_key(*k))),"CACHED_PROPOSAL_SHAPE_INVALID")}
fn scope(snapshot:&Value)->Value{json!({"base_ref":snapshot["base_ref"],"source_epoch":snapshot["source_epoch"],"sources":snapshot["sources"]})}
fn phase(value:&Value)->bool{let v=s(value);v=="EXTRACTION"||v.strip_prefix("EXTRACTION_").is_some_and(|suffix|suffix.len()==3&&suffix.bytes().all(|b|b.is_ascii_digit()))}
fn prepared(p:&Value,context:&Value)->Result<()>{
    let expected=crate::knowledge_build::prepare_extract(&json!({"evidence_set_ref":p["payload"]["evidence_set_ref"],"cq_guidance":p["payload"]["cq_guidance"],"trusted_context":context}))?;
    need(expected==*p,"CACHED_PROPOSAL_PREPARED_CHANGED")
}
/// Pure readback validation; it does not record an attempt or approve a candidate.
pub fn verify_cached_proposal(p:&Value)->Result<Value>{
    shape(p,&["contract_version","origin_job","origin_phase","original_request_archive","original_response_archive","original_prepared","original_context","current_snapshot","new_prepared","new_context"])?;
    need(p["contract_version"]==VERSION,"CACHED_PROPOSAL_VERSION_INVALID")?;
    need(serde_json::to_vec(p).map_err(|_|error("CACHED_PROPOSAL_SHAPE_INVALID","CACHED_PROPOSAL_SHAPE_INVALID"))?.len()<=32*1024*1024,"CACHED_PROPOSAL_RESOURCE_LIMIT")?;
    let job=&p["origin_job"];
    crate::source_learning_v1::validate_job_archive(job)?;
    need(phase(&p["origin_phase"]),"CACHED_PROPOSAL_PHASE_INVALID")?;
    need(["WAIT_REVIEW","WAIT_EVIDENCE","DEFERRED","FAILED","STOPPED","SUPERSEDED","COMPLETED"].contains(&s(&job["stage"])),"CACHED_PROPOSAL_ORIGIN_NOT_QUIESCENT")?;
    need(a(&job["attempts"]).iter().all(|x|x["outcome"]!="STARTED"&&x["outcome"]!="UNKNOWN"),"CACHED_PROPOSAL_ORIGIN_UNKNOWN_NO_REPLAY")?;
    let found:Vec<_>=a(&job["attempts"]).iter().filter(|x|x["phase"]==p["origin_phase"]).collect();
    need(found.len()==1&&found[0]["outcome"]=="RETURNED","CACHED_PROPOSAL_KNOWN_RETURNED_REQUIRED")?;
    let attempt=found[0];let req=&p["original_request_archive"];let resp=&p["original_response_archive"];
    shape(req,&["attempt_id","request_sha256","request"])?;shape(resp,&["attempt_id","request_sha256","response"])?;
    need(req["attempt_id"]==attempt["attempt_id"]&&resp["attempt_id"]==attempt["attempt_id"]&&req["request_sha256"]==attempt["request_sha256"]&&resp["request_sha256"]==attempt["request_sha256"]&&hash(&req["request"])==s(&attempt["request_sha256"]),"CACHED_PROPOSAL_REQUEST_ARCHIVE_CHANGED")?;
    let response=&resp["response"];
    need(response.is_object()&&response["request_id"]==attempt["request_id"]&&hash(response)==s(&attempt["response_sha256"]),"CACHED_PROPOSAL_RESPONSE_ARCHIVE_CHANGED")?;
    need(response["error_code"].is_null()&&["stop","completed"].contains(&s(&response["finish_reason"])),"CACHED_PROPOSAL_RESPONSE_INCOMPLETE")?;
    let raw=response["content"].as_str().filter(|r|!r.trim().is_empty()).ok_or_else(||error("CACHED_PROPOSAL_RAW_REQUIRED","CACHED_PROPOSAL_RAW_REQUIRED"))?;
    let parsed=crate::model_json_boundary::parse(raw)?;
    let value=&parsed["parsed"];
    need(value.as_object().is_some_and(|o|o.len()==2&&o.contains_key("entities")&&o.contains_key("candidates"))&&value["entities"].as_array().is_some_and(|r|r.len()<=24)&&value["candidates"].as_array().is_some_and(|r|r.len()<=8),"CACHED_PROPOSAL_RAW_ENVELOPE_INVALID")?;
    let original=&p["original_prepared"];let next=&p["new_prepared"];
    prepared(original,&p["original_context"])?;prepared(next,&p["new_context"])?;
    need(original["payload"]["snapshot"]==job["snapshot"]&&scope(&job["snapshot"])==scope(&p["current_snapshot"])&&scope(&next["payload"]["snapshot"])==scope(&p["current_snapshot"])&&next["payload"]["snapshot"]==p["current_snapshot"],"CACHED_PROPOSAL_SOURCE_SCOPE_CHANGED")?;
    need(original["payload"]["evidence_menu"]==next["payload"]["evidence_menu"]&&original["payload"]["cq_guidance"]==next["payload"]["cq_guidance"],"CACHED_PROPOSAL_NEW_PREPARATION_NOT_EQUIVALENT")?;
    let request=&req["request"];let messages=a(&request["messages"]);
    need(request["capability"]=="generation"&&messages.len()==2&&messages[0]["role"]=="system"&&messages[0]["content"].is_string()&&messages[1]["role"]=="user"&&messages[1]["content"].is_string(),"CACHED_PROPOSAL_ORIGINAL_PROMPT_INVALID")?;
    let user=crate::model_json_boundary::parse(s(&messages[1]["content"]))?["parsed"].clone();
    let expected_menu:Vec<_>=a(&original["payload"]["evidence_menu"]).iter().map(|f|json!({"evidence_id":f["evidence_id"],"text":f["span"]["quote"]})).collect();
    need(user["evidence_menu"]==json!(expected_menu)&&user["cq_guidance"]==original["payload"]["cq_guidance"]&&user["output_schema"].is_object(),"CACHED_PROPOSAL_ORIGINAL_PROMPT_SCOPE_CHANGED")?;
    let origin=json!({"task_ref":job["task_ref"],"job_sha256":job["job_sha256"],"policy_version":job["request"]["policy_version"],"phase":p["origin_phase"],"attempt_id":attempt["attempt_id"],"request_id":attempt["request_id"],"request_sha256":attempt["request_sha256"],"response_sha256":attempt["response_sha256"],"model":response["model"],"config_revision":response["config_revision"]});
    let mut receipt=json!({"contract_version":VERSION,"type":"CACHED_KNOWN_RESPONSE","origin":origin,"source_scope_sha256":hash(&scope(&p["current_snapshot"])),"origin_snapshot_sha256":hash(&job["snapshot"]),"current_snapshot_sha256":hash(&p["current_snapshot"]),"original_request_archive_sha256":hash(req),"original_response_archive_sha256":hash(resp),"original_prepared_sha256":hash(original),"original_context_sha256":hash(&p["original_context"]),"new_prepared_sha256":hash(next),"new_context_sha256":hash(&p["new_context"]),"origin_messages_sha256":hash(&request["messages"]),"origin_output_schema_sha256":hash(&user["output_schema"]),"raw_utf8_sha256":text_sha(raw),"raw_parsed_sha256":hash(value),"raw_text_parse_receipt":parsed["receipt"],"provenance_policy":"ORIGINAL_ARCHIVED_PROMPT_AND_RESPONSE_ONLY_NEW_PREPARED_IS_PROGRAMMATIC_REMATERIALIZATION","new_provider_request_emitted":false,"new_returned_observation_created":false,"provider_calls":0,"semantic_support_certified":false,"trust_boundary":"HOST_STORED_ARCHIVE_READBACK_NOT_REMOTE_PROVIDER_AUTHENTICATION"});
    receipt["replay_id"]=json!(format!("proposal_replay_{}",&hash(&receipt)[..32]));
    let digest=hash(&receipt);receipt["receipt_sha256"]=json!(digest);
    Ok(json!({"contract_version":VERSION,"replay_receipt":receipt,"receipt_sha256":digest,"raw":raw,"cached_response":response,"provenance":{"type":"CACHED_KNOWN_RESPONSE","origin":origin,"replay_receipt_sha256":digest,"new_provider_request_emitted":false,"semantic_support_certified":false},"provider_calls":0,"publication_performed":false,"semantic_support_certified":false}))
}
pub fn execute(op:&str,p:&Value)->Result<Value>{match op{
    "verify_cached_proposal"=>verify_cached_proposal(p),
    "validate_cached_proposal"=>{let mut input=p.clone();let replay=input.as_object_mut().and_then(|o|o.remove("replay")).ok_or_else(||error("CACHED_PROPOSAL_SHAPE_INVALID","CACHED_PROPOSAL_SHAPE_INVALID"))?;let expected=verify_cached_proposal(&input)?;need(replay==expected,"CACHED_PROPOSAL_REPLAY_CHANGED")?;Ok(json!({"validated":true,"receipt_sha256":expected["receipt_sha256"],"semantic_support_certified":false}))},
    _=>Err(error("CACHED_PROPOSAL_OPERATION_UNKNOWN","CACHED_PROPOSAL_OPERATION_UNKNOWN"))
}}
