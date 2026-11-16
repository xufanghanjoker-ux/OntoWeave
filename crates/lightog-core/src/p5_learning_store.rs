//! P5 partial durable-queue state rules. Host owns files/locks/current source data.
//! No graph commit adapter exists here: COMPLETED is deliberately unavailable.
use crate::common::{a,canonical_hash,error,s,Result};
use serde_json::{json,Value};
use std::collections::BTreeSet;

pub const VERSION:&str="lightog-p5-durable-queue/0.1";
const STATUS:&str="P5_PARTIAL_DURABLE_QUEUE_NO_COMMIT";
fn need(ok:bool,code:&str)->Result<()>{if ok{Ok(())}else{Err(error(code,code))}}
fn shape(v:&Value,keys:&[&str])->Result<()>{need(v.as_object().is_some_and(|m|m.len()==keys.len()&&keys.iter().all(|k|m.contains_key(*k))),"P5_STORE_SHAPE_INVALID")}
fn identifier(v:&Value)->bool{v.as_str().is_some_and(|s|!s.is_empty()&&s.len()<=128&&s.bytes().all(|c|c.is_ascii_alphanumeric()||b"_-.:/".contains(&c)))}
fn digest(v:&Value)->bool{s(v).len()==64&&s(v).bytes().all(|c|c.is_ascii_digit()||(b'a'..=b'f').contains(&c))}
fn sha(v:&Value)->Result<String>{lightog_demand::wire::sha(v).map_err(|e|error(e.code,e.code))}
fn seal(state:&mut Value){state["state_sha256"]=Value::Null;state["state_sha256"]=json!(canonical_hash(state));}
fn validate_state(state:&Value)->Result<()> {
    shape(state,&["contract_version","revision","jobs","state_sha256"])?;
    need(state["contract_version"]==VERSION&&state["revision"].as_u64().is_some()&&state["jobs"].as_array().is_some_and(|r|r.len()<=1024),"P5_STORE_SHAPE_INVALID")?;
    let mut copy=state.clone();copy["state_sha256"]=Value::Null;
    need(state["state_sha256"]==canonical_hash(&copy),"P5_STORE_DIGEST_MISMATCH")?;
    let mut tasks=BTreeSet::new();let mut keys=BTreeSet::new();
    for row in a(&state["jobs"]) {
        shape(row,&["task_ref","idempotency_key","job","job_sha256","attempts"])?;
        need(identifier(&row["task_ref"])&&digest(&row["idempotency_key"])&&row["job"].is_object()&&row["job"]["intent"]["task_ref"]==row["task_ref"]&&row["job"]["revision"].as_u64().is_some()&&row["job_sha256"]==sha(&row["job"])?&&row["attempts"].as_array().is_some_and(|a|a.len()<=256),"P5_STORE_JOB_INVALID")?;
        need(tasks.insert(s(&row["task_ref"]))&&keys.insert(s(&row["idempotency_key"])),"P5_STORE_DUPLICATE_JOB")?;
        let mut ids=BTreeSet::new();let mut phases=BTreeSet::new();
        for attempt in a(&row["attempts"]) {
            shape(attempt,&["attempt_id","phase","request_sha256","outcome","request_id","response_sha256"])?;
            need(identifier(&attempt["attempt_id"])&&identifier(&attempt["phase"])&&digest(&attempt["request_sha256"])&&ids.insert(s(&attempt["attempt_id"]))&&phases.insert(s(&attempt["phase"]))&&["STARTED","RETURNED","UNKNOWN"].contains(&s(&attempt["outcome"])),"P5_STORE_ATTEMPT_INVALID")?;
            need(if attempt["outcome"]=="RETURNED" {identifier(&attempt["request_id"])&&digest(&attempt["response_sha256"])}else{attempt["request_id"].is_null()&&attempt["response_sha256"].is_null()},"P5_STORE_ATTEMPT_INVALID")?;
        }
    }
    Ok(())
}
fn finish(mut state:Value,changed:bool,task:Value,result_status:&str)->Result<Value>{
    if changed {let rev=state["revision"].as_u64().unwrap().checked_add(1).ok_or_else(||error("P5_STORE_REVISION_OVERFLOW","P5_STORE_REVISION_OVERFLOW"))?;state["revision"]=json!(rev);seal(&mut state);}
    validate_state(&state)?;
    Ok(json!({"contract_version":VERSION,"implementation_status":STATUS,"status":result_status,"state":state,"task":task,"changed":changed,"answer_effect":"UNCHANGED","graph_commit_performed":false,"index_refresh_performed":false,"publication_performed":false,"semantic_completeness":"NOT_PROVEN"}))
}
fn row_index(state:&Value,task:&Value)->Result<usize>{need(identifier(task),"P5_TASK_INVALID")?;a(&state["jobs"]).iter().position(|r|r["task_ref"]==*task).ok_or_else(||error("P5_TASK_NOT_FOUND","P5_TASK_NOT_FOUND"))}
fn unknown(row:&Value)->bool{a(&row["attempts"]).iter().any(|x|x["outcome"]=="STARTED"||x["outcome"]=="UNKNOWN")}
pub fn execute(op:&str,p:&Value)->Result<Value>{
    let fields:&[&str]=match op{
        "init"=>&["contract_version"],
        "inspect"=>&["contract_version","state"],
        "admit"=>&["contract_version","state","expected_revision","job","context"],
        "transition"=>&["contract_version","state","expected_revision","task_ref","next_job","context","runtime"],
        "provider_start"=>&["contract_version","state","expected_revision","task_ref","attempt_id","phase","request_sha256","context","current_snapshot"],
        "provider_result"=>&["contract_version","state","expected_revision","task_ref","attempt_id","outcome","request_id","response_sha256"],
        _=>return Err(error("P5_STORE_OPERATION_UNKNOWN","P5_STORE_OPERATION_UNKNOWN"))
    };
    shape(p,fields)?;need(p["contract_version"]==VERSION,"P5_STORE_VERSION_UNSUPPORTED")?;
    if op=="init" {let mut state=json!({"contract_version":VERSION,"revision":0,"jobs":[],"state_sha256":null});seal(&mut state);return finish(state,false,Value::Null,"EMPTY");}
    validate_state(&p["state"])?;
    if op=="inspect" {return finish(p["state"].clone(),false,Value::Null,"LOADED_PERSISTED_STATE");}
    need(p["expected_revision"].as_u64().is_some()&&p["expected_revision"]==p["state"]["revision"],"P5_STORE_CAS_MISMATCH")?;
    let mut state=p["state"].clone();
    if op=="admit" {
        let job=&p["job"];
        if !job["intent"].is_object()||job["intent"]["question_spec_sha256"].is_null() {return finish(state,false,Value::Null,"BLOCKED_MISSING_TYPED_INTENT");}
        need(job["stage"]=="QUEUED"&&job["revision"]==0,"P5_ADMIT_REQUIRES_NEW_QUEUED_JOB")?;
        lightog_demand::learning_contract::execute("validate",&json!({"job":job,"trusted_context":p["context"]})).map_err(|e|error(e.code,e.code))?;
        let intent=&job["intent"];
        let key=sha(&json!({"contract_version":lightog_demand::learning_contract::VERSION,"question_spec_sha256":intent["question_spec_sha256"],"requirement_ids":intent["requirement_ids"],"snapshot":intent["snapshot"],"dimension_sha256":job["dimension_sha256"],"policy_version":job["policy_version"]}))?;
        if let Some(existing)=a(&state["jobs"]).iter().find(|r|r["idempotency_key"]==key){let existing=existing.clone();return finish(state,false,existing,"IDEMPOTENT_EXISTING_JOB");}
        need(identifier(&intent["task_ref"])&&!a(&state["jobs"]).iter().any(|r|r["task_ref"]==intent["task_ref"])&&a(&state["jobs"]).len()<1024,"P5_TASK_COLLISION_OR_LIMIT")?;
        let row=json!({"task_ref":intent["task_ref"],"idempotency_key":key,"job":job,"job_sha256":sha(job)?,"attempts":[]});
        state["jobs"].as_array_mut().unwrap().push(row.clone());return finish(state,true,row,"QUEUED");
    }
    let i=row_index(&state,&p["task_ref"])?;let row=state["jobs"][i].clone();
    if op=="transition" {
        let next=&p["next_job"];need(next["stage"]!="COMPLETED","P5_COMMIT_ADAPTER_NOT_IMPLEMENTED")?;
        let terminal=["STOPPED","FAILED","SUPERSEDED"].contains(&s(&next["stage"]));
        need(!unknown(&row)||terminal,"P5_PROVIDER_OUTCOME_UNKNOWN_NO_AUTOMATIC_RETRY")?;
        shape(&p["runtime"],&["current_snapshot","scope_unit_ids","units"])?;
        let runtime=json!({"current_snapshot":p["runtime"]["current_snapshot"],"scope_unit_ids":p["runtime"]["scope_unit_ids"],"units":p["runtime"]["units"],"persisted_job_sha256":row["job_sha256"],"persisted_revision":row["job"]["revision"],"commits":[]});
        let checked=lightog_demand::learning_contract::execute("transition",&json!({"previous":row["job"],"next":next,"trusted_context":p["context"],"trusted_runtime":runtime})).map_err(|e|error(e.code,e.code))?;
        need(checked["idempotency_key"]==row["idempotency_key"],"P5_IDEMPOTENCY_CHANGED")?;
        state["jobs"][i]["job"]=checked["job"].clone();state["jobs"][i]["job_sha256"]=json!(sha(&checked["job"])?);
        let updated=state["jobs"][i].clone();return finish(state,true,updated,"TRANSITIONED");
    }
    if op=="provider_start" {
        need(["RETRIEVING","EXTRACTING","VALIDATING"].contains(&s(&row["job"]["stage"])),"P5_PROVIDER_STAGE_DENIED")?;
        lightog_demand::learning_contract::execute("validate",&json!({"job":row["job"],"trusted_context":p["context"]})).map_err(|e|error(e.code,e.code))?;
        need(p["current_snapshot"]==row["job"]["intent"]["snapshot"],"P5_PROVIDER_SOURCE_OR_BASE_STALE")?;
        need(identifier(&p["attempt_id"])&&identifier(&p["phase"])&&digest(&p["request_sha256"]),"P5_PROVIDER_ATTEMPT_INVALID")?;
        need(!unknown(&row)&&!a(&row["attempts"]).iter().any(|x|x["phase"]==p["phase"]||x["attempt_id"]==p["attempt_id"]),"P5_PROVIDER_OUTCOME_UNKNOWN_OR_PHASE_ALREADY_ATTEMPTED")?;
        need(a(&row["attempts"]).len()<256,"P5_PROVIDER_ATTEMPT_LIMIT")?;
        state["jobs"][i]["attempts"].as_array_mut().unwrap().push(json!({"attempt_id":p["attempt_id"],"phase":p["phase"],"request_sha256":p["request_sha256"],"outcome":"STARTED","request_id":null,"response_sha256":null}));
        let updated=state["jobs"][i].clone();return finish(state,true,updated,"ATTEMPT_STARTED_PERSIST_BEFORE_PROVIDER");
    }
    need(identifier(&p["attempt_id"])&&["RETURNED","UNKNOWN"].contains(&s(&p["outcome"])),"P5_PROVIDER_RESULT_INVALID")?;
    let j=a(&row["attempts"]).iter().position(|x|x["attempt_id"]==p["attempt_id"]).ok_or_else(||error("P5_PROVIDER_ATTEMPT_NOT_FOUND","P5_PROVIDER_ATTEMPT_NOT_FOUND"))?;
    need(row["attempts"][j]["outcome"]=="STARTED","P5_PROVIDER_RESULT_ALREADY_RECORDED")?;
    need(if p["outcome"]=="RETURNED" {identifier(&p["request_id"])&&digest(&p["response_sha256"])}else{p["request_id"].is_null()&&p["response_sha256"].is_null()},"P5_PROVIDER_RESULT_INVALID")?;
    for key in ["outcome","request_id","response_sha256"]{state["jobs"][i]["attempts"][j][key]=p[key].clone();}
    let updated=state["jobs"][i].clone();finish(state,true,updated,"PROVIDER_RESULT_RECORDED_NOT_SEMANTIC_APPROVAL")
}
