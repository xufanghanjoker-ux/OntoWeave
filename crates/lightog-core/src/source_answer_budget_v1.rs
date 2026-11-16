//! Point-in-time ASK embedding admission. No reservations, provider I/O or answer semantics.
use crate::common::{canonical_hash, error, s, text_sha, Result};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
pub const VERSION: &str = "lightog-source-answer-budget/0.1";
const BATCH_LIMIT: u64 = 20;
fn need(ok: bool, code: &str) -> Result<()> { if ok { Ok(()) } else { Err(error(code, code)) } }
fn sha(v: &Value) -> bool { v.as_str().is_some_and(|s| s.len()==64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))) }
fn hashes(v: &Value) -> Result<BTreeSet<String>> {
    let rows=v.as_array().ok_or_else(||error("SOURCE_EMBEDDING_PLAN_INPUT_INVALID","hash list required"))?;
    need(rows.len()<=100000,"SOURCE_EMBEDDING_PLAN_INPUT_INVALID")?;
    rows.iter().map(|v| {need(sha(v),"SOURCE_EMBEDDING_PLAN_INPUT_INVALID")?;Ok(s(v).to_owned())}).collect()
}
fn run(p: &Value, validate: bool) -> Result<Value> {
    need(p["contract_version"]==VERSION,"SOURCE_EMBEDDING_PLAN_VERSION_INVALID")?;
    let scope=&p["scope"];
    need(scope["version"]=="lightog-source-product-budget/1" && scope["context"]["operation"]=="ASK" && scope["source_stamp"].is_object() && scope["snapshot"].is_object() && scope["models"].is_object(),"SOURCE_EMBEDDING_PLAN_SCOPE_INVALID")?;
    let question=scope["context"]["question"].as_str().ok_or_else(||error("SOURCE_EMBEDDING_PLAN_SCOPE_INVALID","question required"))?;
    let documents=hashes(&p["document_text_sha256s"])?;
    let queries=hashes(&p["query_text_sha256s"])?;
    need(queries==BTreeSet::from([text_sha(question)]),"SOURCE_EMBEDDING_PLAN_QUERY_BINDING_INVALID")?;
    let rows=p["cache_observations"].as_array().ok_or_else(||error("SOURCE_EMBEDDING_PLAN_INPUT_INVALID","cache observations required"))?;
    let mut observed=BTreeMap::new();
    for row in rows {let id=s(&row["cache_id"]);need(!id.is_empty() && observed.insert(id.to_owned(),row).is_none(),"SOURCE_EMBEDDING_PLAN_CACHE_OBSERVATIONS_INVALID")?;}
    let binding=&scope["models"]["embedding"];
    let configured=!binding.is_null();
    if configured {need(binding["role"]=="embedding" && binding["model"].as_str().is_some_and(|s|!s.is_empty()) && binding["config_revision"].as_u64().is_some_and(|n|n>0) && binding["dimensions"].as_u64().is_some_and(|n|(1..=32768).contains(&n)),"SOURCE_EMBEDDING_PLAN_MODEL_INVALID")?;}
    let dimensions=binding["dimensions"].as_u64().unwrap_or(0) as usize;
    let mut expected=BTreeSet::new();let mut missing_document=vec![];let mut missing_query=vec![];let mut blocked=vec![];let mut cache_hits=0;
    if configured {for (kind,texts) in [("document",&documents),("query",&queries)] {for digest in texts {
        let id=canonical_hash(&json!({"binding":binding,"input_type":kind,"text_sha256":digest}));expected.insert(id.clone());
        let row=observed.get(&id).ok_or_else(||error("SOURCE_EMBEDDING_PLAN_CACHE_OBSERVATIONS_INVALID","required cache observation missing"))?;
        let cached=&row["cache"];let pending=&row["pending"];
        // An unfinished durable send always blocks, even if a contradictory cache was supplied.
        if matches!(s(&pending["status"]),"STARTED"|"UNKNOWN_NO_AUTOMATIC_RESEND") {blocked.push(id.clone());}
        if !cached.is_null() {
            need(cached["id"]==id && cached["text_sha256"]==*digest && cached["input_type"]==kind && canonical_hash(&cached["binding"])==canonical_hash(binding) && cached["completed_attempt_id"].as_str().is_some_and(|s|!s.is_empty()),"SOURCE_VECTOR_CACHE_CHANGED")?;
            let values=cached["values"].as_array().ok_or_else(||error("SOURCE_VECTOR_CACHE_CHANGED","vector values required"))?;
            need(values.len()==dimensions && values.iter().all(|v|v.as_f64().is_some_and(|n|n.is_finite())) && values.iter().any(|v|v.as_f64().is_some_and(|n|n!=0.0)),"SOURCE_VECTOR_CACHE_CHANGED")?;cache_hits+=1;
        } else if kind=="document" {missing_document.push(digest.clone());} else {missing_query.push(digest.clone());}
    }}}
    need(observed.keys().cloned().collect::<BTreeSet<_>>()==expected,"SOURCE_EMBEDDING_PLAN_CACHE_OBSERVATIONS_INVALID")?;
    let document_batches=(missing_document.len() as u64).div_ceil(BATCH_LIMIT);let query_batches=(missing_query.len() as u64).div_ceil(BATCH_LIMIT);let total=document_batches+query_batches;
    let mut remaining=Value::Null;
    if validate {
        need(blocked.is_empty(),"SOURCE_EMBEDDING_OUTCOME_UNKNOWN_CONFIRMATION_REQUIRED")?;
        if configured {
            let budget=&p["budget"];need(budget["status"]=="AUTHORIZED","SOURCE_BUDGET_REQUIRED")?;
            need(budget["scope_sha256"]==canonical_hash(scope),"SOURCE_BUDGET_SCOPE_CHANGED")?;
            if budget["mode"]=="AUTOMATIC_TASK_PLAN" {crate::source_execution_v1::execute("validate_embedding",&json!({"contract_version":crate::source_execution_v1::VERSION,"execution":budget,"scope":scope,"embedding_plan":{"status":"READY","scope_sha256":canonical_hash(scope),"document_batches":document_batches,"query_batches":query_batches}}))?;}else{let limit=budget["limits"]["embedding"].as_u64().ok_or_else(||error("SOURCE_EMBEDDING_BUDGET_INVALID","embedding limit required"))?;
            let used=budget["used"]["embedding"].as_u64().ok_or_else(||error("SOURCE_EMBEDDING_BUDGET_INVALID","embedding usage required"))?;
            need(limit<=10000 && used<=limit,"SOURCE_EMBEDDING_BUDGET_INVALID")?;
            remaining=json!(limit-used);need(total<=limit-used,"SOURCE_EMBEDDING_BUDGET_INSUFFICIENT_PREFLIGHT")?;}
        }
    }
    Ok(json!({"contract_version":VERSION,"status":if blocked.is_empty(){"READY"}else{"BLOCKED_UNKNOWN"},"scope_sha256":canonical_hash(scope),"snapshot_sha256":canonical_hash(&scope["snapshot"]),"embedding_binding_sha256":canonical_hash(binding),"cache_observations_sha256":canonical_hash(&p["cache_observations"]),"configured":configured,"batch_limit":BATCH_LIMIT,"document_unique_texts":documents.len(),"query_unique_texts":queries.len(),"cache_hits":cache_hits,"missing_document_text_sha256s":missing_document,"missing_query_text_sha256s":missing_query,"document_batches":document_batches,"query_batches":query_batches,"required_embedding_batches":total,"blocked_cache_ids":blocked,"embedding_remaining":remaining,"budget_validated":validate,"only_embedding_preflight":true,"generation_and_reranker_budget_guaranteed":false,"point_in_time_only":true,"reservation_performed":false,"provider_calls_performed":0}))
}
pub fn execute(op: &str,p: &Value)->Result<Value>{match op {"plan"=>run(p,false),"validate"=>run(p,true),_=>Err(error("CORE_OPERATION_UNKNOWN",op))}}
