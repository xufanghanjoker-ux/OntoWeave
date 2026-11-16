//! Mechanically validated, explicitly unreviewed navigation candidates.
//! Source-exact spans and proposal receipts do not certify entailment or identity.
use crate::common::{a, canonical_hash as hash, error, s, Result};
use std::collections::BTreeSet;
use serde_json::{json, Value};
pub const VERSION: &str = "lightog-candidate-staging/0.1";
pub const BATCH_VERSION: &str = "lightog-candidate-staging-batches/0.1";
pub const STATUS: &str = "CANDIDATE_UNREVIEWED";
pub const USAGE: &str = "NAVIGATION_ONLY";
fn need(ok: bool, code: &str) -> Result<()> { if ok { Ok(()) } else { Err(error(code,code)) } }
pub fn execute(op: &str, p: &Value) -> Result<Value> {
    if op == "assemble_batches" { return assemble_batches(p); }
    if op == "stage_batches" { return stage_batches(p); }
    need(op == "stage", "CANDIDATE_STAGING_OPERATION_UNKNOWN")?;
    need(p["contract_version"] == VERSION, "CANDIDATE_STAGING_VERSION_UNSUPPORTED")?;
    // Reuse only mechanical preparation: schema/source spans/receipt replay.
    // No model review, no apply(), no semantic dimension converted to positive.
    let mut input=p.clone(); input["contract_version"]=json!(crate::semantic_review_v2::VERSION);
    let checked=crate::semantic_review_v2::execute("prepare", &input)?;
    let version=checked["manifest"]["proposal_contract_version"].as_str().unwrap_or(crate::support_selection::REQUIRED_OCCURRENCE_VERSION);
    need([crate::support_selection::REQUIRED_OCCURRENCE_VERSION,crate::support_selection::LOCAL_REQUIRED_OCCURRENCE_VERSION].contains(&version)&&a(&p["candidates"]).iter().all(|c| { let matched:Vec<_>=a(&p["receipts"]).iter().filter(|r| r["candidate_id"]==c["candidate_id"]).collect(); matched.len()==1 && matched[0]["proposal_contract_version"]==version }), "CANDIDATE_STAGING_REQUIRED_PROPOSAL_CONTRACT")?;
    let mut receipt=json!({"contract_version":VERSION,"input_sha256":hash(p),"snapshot_sha256":hash(&p["prepared"]["payload"]["snapshot"]),"prepared_sha256":hash(&p["prepared"]),"proposal_contract_version":version,"candidate_bindings":checked["manifest"]["candidates"],"semantic_status":STATUS,"usage":USAGE,"semantic_support_certified":false,"semantic_review_performed":false,"source_exact_is_not_entailment":true});
    receipt["receipt_sha256"]=json!(hash(&receipt));
    Ok(json!({"contract_version":VERSION,"staged_candidates":p["candidates"],"staging_receipt":receipt,"semantic_status":STATUS,"usage":USAGE,"semantic_support_certified":false,"semantic_review_performed":false,"publication_performed":false}))
}

// A complete source plan is processed by bounded independent extraction calls.
// Aggregate fields are generated/replayed here, never substituted for per-batch
// preparation. They are for atomic commit exposure, not a larger model prompt.
fn assemble_batches(p:&Value)->Result<Value>{
    need(p.as_object().is_some_and(|o|o.len()==5&&["contract_version","evidence_set","refinement_context","refinement","batches"].iter().all(|k|o.contains_key(*k))),"CANDIDATE_BATCH_SHAPE_INVALID")?;
    need(p["contract_version"]==BATCH_VERSION,"CANDIDATE_BATCH_VERSION_INVALID")?;
    crate::fine_source_evidence::execute("validate_batches",&json!({"contract_version":crate::fine_source_evidence::VERSION,"evidence_set":p["evidence_set"],"context":p["refinement_context"],"refinement":p["refinement"]}))?;
    let plans=a(&p["refinement"]["batches"]);let rows=a(&p["batches"]);
    need(!plans.is_empty()&&plans.len()<=128&&plans.len()==rows.len(),"CANDIDATE_BATCH_COVERAGE_INVALID")?;
    let mut context=p["refinement_context"].clone();let mut candidates=vec![];let mut menu=vec![];let mut bindings=vec![];let mut ids=BTreeSet::new();let mut requests=BTreeSet::new();
    for (i,(plan,row)) in plans.iter().zip(rows).enumerate(){
        need(row.as_object().is_some_and(|o|o.len()==3&&o.contains_key("input")&&o.contains_key("phase")&&o.contains_key("request_id")),"CANDIDATE_BATCH_SHAPE_INVALID")?;
        need(row["phase"]==format!("EXTRACTION_{i:03}")&&row["request_id"].as_str().is_some_and(|r|!r.is_empty())&&requests.insert(s(&row["request_id"]).to_owned()),"CANDIDATE_BATCH_ATTEMPT_INVALID")?;
        let input=&row["input"];let es=&plan["evidence_set"];
        let mut batch_context=p["refinement_context"].clone();batch_context["examples"][s(&es["evidence_set_id"])]=es.clone();
        need(input["contract_version"]==VERSION&&input["trusted_context"]==batch_context,"CANDIDATE_BATCH_CONTEXT_CHANGED")?;
        let expected=crate::knowledge_build::prepare_extract(&json!({"evidence_set_ref":es["evidence_set_id"],"cq_guidance":input["prepared"]["payload"]["cq_guidance"],"trusted_context":batch_context}))?;
        need(input["prepared"]==expected,"CANDIDATE_BATCH_PREPARED_CHANGED")?;
        let result=if !a(&input["candidates"]).is_empty(){execute("stage",input)?}else{
            need(input.as_object().is_some_and(|o|o.len()==7)&&input["candidates"].is_array()&&input["receipts"].is_array(),"CANDIDATE_BATCH_EMPTY_INVALID")?;
            json!({"staging_receipt":{"input_sha256":hash(input),"empty_candidates":true,"semantic_support_certified":false}})
        };
        for c in a(&input["candidates"]){need(ids.insert(s(&c["candidate_id"]).to_owned()),"CANDIDATE_BATCH_ID_REUSED")?;candidates.push(c.clone());}
        menu.extend(a(&expected["payload"]["evidence_menu"]).iter().cloned());
        context["examples"][s(&es["evidence_set_id"])]=es.clone();
        bindings.push(json!({"batch_index":i,"phase":row["phase"],"request_id":row["request_id"],"input_sha256":hash(input),"staging_receipt":result["staging_receipt"]}));
    }
    let mut out=p.clone();out["candidates"]=json!(candidates);out["trusted_context"]=context;
    out["prepared"]=json!({"contract_version":"lightog-complete-batch-exposure/0.1","purpose":"COMMIT_COVERAGE_ONLY_NEVER_MODEL_CONTEXT","payload":{"snapshot":p["evidence_set"]["snapshot"],"evidence_menu":menu}});
    out["batch_attempt_bindings"]=json!(bindings);
    Ok(out)
}
fn stage_batches(p:&Value)->Result<Value>{
    need(p.as_object().is_some_and(|o|o.len()==9),"CANDIDATE_BATCH_SHAPE_INVALID")?;
    let base=json!({"contract_version":p["contract_version"],"evidence_set":p["evidence_set"],"refinement_context":p["refinement_context"],"refinement":p["refinement"],"batches":p["batches"]});
    let expected=assemble_batches(&base)?;need(expected==*p,"CANDIDATE_BATCH_AGGREGATE_CHANGED")?;
    let mut receipt=json!({"contract_version":BATCH_VERSION,"input_sha256":hash(p),"snapshot_sha256":hash(&p["evidence_set"]["snapshot"]),"batch_plan_sha256":p["refinement"]["receipt_sha256"],"batch_count":a(&p["batches"]).len(),"batch_attempt_bindings":p["batch_attempt_bindings"],"semantic_status":STATUS,"usage":USAGE,"semantic_support_certified":false,"semantic_review_performed":false,"all_batches_returned_binding_required_at_commit":true});
    receipt["receipt_sha256"]=json!(hash(&receipt));
    Ok(json!({"contract_version":BATCH_VERSION,"staged_candidates":p["candidates"],"staging_receipt":receipt,"semantic_status":STATUS,"usage":USAGE,"semantic_support_certified":false,"semantic_review_performed":false,"publication_performed":false}))
}
