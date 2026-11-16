//! P1 pure lifecycle contract. The service owns runtime/CAS/commit receipts;
//! this module never dispatches jobs, writes state, or treats answers as evidence.
use crate::{need, wire, Error, Kernel, Result, ValidationContext};
use serde_json::{json, Value};
use std::collections::BTreeSet;

pub const VERSION: &str = "lightog-learning/0.2";

fn ids(value: &Value) -> BTreeSet<&str> {
    value.as_array().unwrap().iter().map(|v|v.as_str().unwrap()).collect()
}

fn schema_check(value: &Value, definition: &str) -> Result<()> {
    let extension: Value = serde_json::from_str(include_str!("../../../contracts/demand-v0.2/learning.schema.json"))
        .map_err(|_| Error::new("LEARNING_SCHEMA_INVALID"))?;
    let base: Value = serde_json::from_str(include_str!("../../../contracts/demand-v0.1/schema.json"))
        .map_err(|_| Error::new("LEARNING_SCHEMA_INVALID"))?;
    let mut defs = base["$defs"].as_object().unwrap().clone();
    for (key, def) in extension["$defs"].as_object().unwrap() { defs.insert(key.clone(), def.clone()); }
    let wrapper = json!({"$schema":"https://json-schema.org/draft/2020-12/schema","$defs":defs,"$ref":format!("#/$defs/{definition}")});
    let validator = jsonschema::draft202012::options().build(&wrapper)
        .map_err(|_| Error::new("LEARNING_SCHEMA_INVALID"))?;
    need(validator.is_valid(value), "LEARNING_SHAPE_INVALID")?;
    if definition=="LearningTransition" {
        // Legacy payload sidecars in trusted context may contain finite floats;
        // only the new shared protocol is subject to demand wire number rules.
        wire::canonical(&value["previous"])?;
        wire::canonical(&value["next"])?;
        wire::canonical(&value["trusted_runtime"])?;
    } else { wire::canonical(value)?; }
    Ok(())
}

fn coarse(stage: &str) -> &'static str {
    match stage {
        "NOT_REQUESTED" => "NOT_REQUESTED",
        "QUEUED" | "RETRIEVING" | "DEFERRED" => "QUEUED",
        "EXTRACTING" | "VALIDATING" | "COMMITTING" => "RUNNING",
        "COMPLETED" => "PUBLISHED",
        "WAIT_EVIDENCE" => "WAIT_EVIDENCE",
        "WAIT_REVIEW" => "WAIT_REVIEW",
        "STOPPED" | "SUPERSEDED" => "CANCELLED",
        _ => "FAILED",
    }
}

pub fn validate_job(job: &Value, ctx: &ValidationContext) -> Result<()> {
    validate_job_shape(job)?;
    let kernel = Kernel::new()?;
    // Validate every supplied evidence set: a registry entry is not approval.
    for value in ctx.examples().values().filter(|v| v.get("evidence_set_id").is_some()) {
        kernel.validate(value, "EvidenceSet", ctx)?;
    }
    kernel.validate(&job["intent"], "LearningIntent", ctx)?;
    ctx.request_snapshot_check(&job["intent"]["request_ref"],&job["intent"]["question_spec_sha256"],&job["intent"]["snapshot"])?;
    for id in job["intent"]["admission_evidence_ids"].as_array().unwrap() {
        let fragment = ctx.fragments.get(id.as_str().unwrap()).ok_or_else(||Error::new("UNKNOWN_EVIDENCE_REF"))?;
        need(job["intent"]["snapshot"]["sources"].as_array().unwrap().iter().any(|source|
            source["source_ref"] == fragment["source_ref"] && source["source_revision"] == fragment["source_revision"]
            && source["text_sha256"] == fragment["text_sha256"]), "LEARNING_EVIDENCE_SNAPSHOT_MISMATCH")?;
    }
    Ok(())
}

fn validate_job_shape(job:&Value)->Result<()> {
    schema_check(job,"LearningJob")?;
    let stage = job["stage"].as_str().unwrap();
    need(job["intent"]["status"] == coarse(stage), "LEARNING_STAGE_MISMATCH")?;
    need((stage == "COMPLETED") == job["commit_receipt_ref"].is_string(), "LEARNING_COMMIT_RECEIPT_REQUIRED")?;
    let checked: BTreeSet<_> = ids(&job["scope"]["checked_unit_ids"]);
    let unsearched: BTreeSet<_> = ids(&job["scope"]["unsearched_unit_ids"]);
    need(checked.is_disjoint(&unsearched), "LEARNING_SCOPE_OVERLAP")?;
    // Scope is a work record, never a semantic completeness certificate.
    Ok(())
}

fn allowed(from: &str, to: &str) -> bool {
    match from {
        "QUEUED" => matches!(to,"RETRIEVING"|"STOPPED"|"SUPERSEDED"|"FAILED"|"DEFERRED"),
        "RETRIEVING" => matches!(to,"EXTRACTING"|"WAIT_EVIDENCE"|"WAIT_REVIEW"|"DEFERRED"|"STOPPED"|"SUPERSEDED"|"FAILED"),
        "EXTRACTING" => matches!(to,"VALIDATING"|"WAIT_REVIEW"|"WAIT_EVIDENCE"|"DEFERRED"|"STOPPED"|"SUPERSEDED"|"FAILED"),
        "VALIDATING" => matches!(to,"COMMITTING"|"WAIT_REVIEW"|"WAIT_EVIDENCE"|"DEFERRED"|"STOPPED"|"SUPERSEDED"|"FAILED"),
        "COMMITTING" => matches!(to,"COMPLETED"|"SUPERSEDED"|"FAILED"),
        "WAIT_EVIDENCE" | "WAIT_REVIEW" | "DEFERRED" => matches!(to,"QUEUED"|"STOPPED"|"SUPERSEDED"|"FAILED"),
        _ => false,
    }
}

pub fn transition(payload: &Value) -> Result<Value> {
    schema_check(payload, "LearningTransition")?;
    let kernel = Kernel::new()?;
    let ctx = ValidationContext::from_value_v2(&payload["trusted_context"], &kernel)?;
    let previous = &payload["previous"];
    let next = &payload["next"];
    let runtime = &payload["trusted_runtime"];
    let from = previous["stage"].as_str().unwrap();
    let to = next["stage"].as_str().unwrap();
    let terminal=matches!(to,"SUPERSEDED"|"STOPPED"|"FAILED");
    if terminal {
        // A revoked/deleted source must not prevent closing the exact stored job.
        // Its persisted digest is authoritative; no old evidence is used or
        // granted current validity on this branch.
        validate_job_shape(previous)?;
        validate_job_shape(next)?;
        need(previous["scope"]==next["scope"]
            && previous["intent"]["admission_evidence_ids"]==next["intent"]["admission_evidence_ids"],"LEARNING_TERMINAL_MUTATION")?;
    } else {
        validate_job(previous, &ctx)?;
        validate_job(next, &ctx)?;
    }
    // The service must populate this from its stored record, never model output.
    need(runtime["persisted_job_sha256"] == wire::sha(previous)?
        && runtime["persisted_revision"] == previous["revision"], "LEARNING_CAS_MISMATCH")?;
    let revision = previous["revision"].as_u64().unwrap();
    need(next["revision"].as_u64() == revision.checked_add(1), "LEARNING_REVISION_MISMATCH")?;
    for key in ["contract_version", "dimension_sha256", "policy_version"] {
        need(previous[key] == next[key], "LEARNING_IDENTITY_CHANGED")?;
    }
    for key in ["contract_version", "question_id", "question_spec_sha256", "requirement_ids", "snapshot", "access_mode", "learning_requested", "task_ref", "request_ref"] {
        need(previous["intent"][key] == next["intent"][key], "LEARNING_IDENTITY_CHANGED")?;
    }
    need(allowed(from,to), "LEARNING_TRANSITION_DENIED")?;
    kernel.schema_check(&runtime["current_snapshot"], "SourceSnapshot")?;
    let input = &previous["intent"]["snapshot"];
    let current = &runtime["current_snapshot"];
    let sources_current = ["base_ref", "source_epoch", "sources"].iter().all(|key| input[key] == current[key]);
    let active = matches!(to,"QUEUED"|"RETRIEVING"|"EXTRACTING"|"VALIDATING"|"COMMITTING"|"COMPLETED");
    if active {
        ctx.snapshot_check(current)?;
        need(sources_current, "LEARNING_SOURCE_STALE")?;
        if to != "COMPLETED" { need(input["graph_revision"] == current["graph_revision"], "LEARNING_BASE_STALE")?; }
    }
    let old_checked: BTreeSet<_> = ids(&previous["scope"]["checked_unit_ids"]);
    let new_checked: BTreeSet<_> = ids(&next["scope"]["checked_unit_ids"]);
    need(old_checked.is_subset(&new_checked), "LEARNING_SCOPE_REGRESSION")?;
    let old_universe: BTreeSet<_> = previous["scope"]["checked_unit_ids"].as_array().unwrap().iter()
        .chain(previous["scope"]["unsearched_unit_ids"].as_array().unwrap()).map(|v|v.as_str().unwrap()).collect();
    let new_universe: BTreeSet<_> = next["scope"]["checked_unit_ids"].as_array().unwrap().iter()
        .chain(next["scope"]["unsearched_unit_ids"].as_array().unwrap()).map(|v|v.as_str().unwrap()).collect();
    let trusted_universe: BTreeSet<_> = ids(&runtime["scope_unit_ids"]);
    need(old_universe.is_subset(&new_universe) && new_universe == trusted_universe, "LEARNING_SCOPE_CHANGED")?;
    let old_admission: BTreeSet<_> = ids(&previous["intent"]["admission_evidence_ids"]);
    let new_admission: BTreeSet<_> = ids(&next["intent"]["admission_evidence_ids"]);
    need(old_admission.is_subset(&new_admission), "LEARNING_EVIDENCE_REGRESSION")?;
    if !terminal { validate_units(next,runtime,&ctx)?; }
    let mut commit = Value::Null;
    if to == "COMPLETED" {
        let receipts = runtime["commits"].as_array().unwrap();
        let matches: Vec<_> = receipts.iter().filter(|r| r["receipt_ref"] == next["commit_receipt_ref"]).collect();
        need(matches.len()==1, "LEARNING_COMMIT_UNVERIFIED")?;
        let receipt = matches[0];
        need(receipt["task_ref"] == next["intent"]["task_ref"]
            && receipt["input_snapshot_sha256"] == wire::sha(input)?
            && receipt["dimension_sha256"] == next["dimension_sha256"]
            && receipt["output_graph_revision"] == current["graph_revision"], "LEARNING_COMMIT_UNVERIFIED")?;
        commit = receipt.clone();
    }
    let key = wire::sha(&json!({"contract_version":VERSION,"question_spec_sha256":next["intent"]["question_spec_sha256"],"requirement_ids":next["intent"]["requirement_ids"],"snapshot":input,"dimension_sha256":next["dimension_sha256"],"policy_version":next["policy_version"]}))?;
    Ok(json!({"job":next,"idempotency_key":key,"commit":commit,"answer_effect":"UNCHANGED","semantic_completeness":"NOT_PROVEN","execution":"VALIDATED_NOT_PERSISTED"}))
}

pub fn execute(op: &str, payload: &Value) -> Result<Value> {
    match op {
        "validate" => {
            let object=payload.as_object().ok_or_else(||Error::new("LEARNING_SHAPE_INVALID"))?;
            need(object.contains_key("job")&&object.contains_key("trusted_context")
                &&object.keys().all(|k|matches!(k.as_str(),"job"|"trusted_context"|"trusted_runtime")),"LEARNING_SHAPE_INVALID")?;
            if let Some(runtime)=payload.get("trusted_runtime") {schema_check(runtime,"LearningRuntime")?;}
            let kernel=Kernel::new()?;
            let ctx=ValidationContext::from_value_v2(&payload["trusted_context"],&kernel)?;
            validate_job(&payload["job"],&ctx)?;
            let job=&payload["job"];
            if job["stage"]=="COMPLETED" {
                let runtime=payload.get("trusted_runtime").ok_or_else(||Error::new("LEARNING_COMMIT_UNVERIFIED"))?;
                schema_check(runtime,"LearningRuntime")?;
                need(runtime["persisted_job_sha256"]==wire::sha(job)?&&runtime["persisted_revision"]==job["revision"],"LEARNING_CAS_MISMATCH")?;
                ctx.snapshot_check(&runtime["current_snapshot"])?;
                need(["base_ref","source_epoch","sources"].iter().all(|k|job["intent"]["snapshot"][k]==runtime["current_snapshot"][k]),"LEARNING_SOURCE_STALE")?;
                let matching:Vec<_>=runtime["commits"].as_array().unwrap().iter().filter(|r|r["receipt_ref"]==job["commit_receipt_ref"]).collect();
                need(matching.len()==1,"LEARNING_COMMIT_UNVERIFIED")?;
                let receipt=matching[0];
                need(receipt["task_ref"]==job["intent"]["task_ref"]&&receipt["dimension_sha256"]==job["dimension_sha256"]
                    && receipt["input_snapshot_sha256"]==wire::sha(&job["intent"]["snapshot"])?
                    && receipt["output_graph_revision"]==runtime["current_snapshot"]["graph_revision"],"LEARNING_COMMIT_UNVERIFIED")?;
            }
            Ok(json!({"valid":true,"execution":"VALIDATED_NOT_PERSISTED","task_existence_certified":job["stage"]=="COMPLETED"}))
        }
        "transition" => transition(payload),
        _ => Err(Error::new("LEARNING_OPERATION_UNKNOWN")),
    }
}

fn validate_units(job:&Value,runtime:&Value,ctx:&ValidationContext)->Result<()> {
    let mut unit_ids=BTreeSet::new();
    for unit in runtime["units"].as_array().unwrap() {
        need(unit_ids.insert(unit["unit_id"].as_str().unwrap()),"LEARNING_UNIT_DUPLICATE")?;
        let source=ctx.sources.get(&(unit["source_ref"].as_str().unwrap().to_owned(),unit["source_revision"].as_str().unwrap().to_owned()))
            .ok_or_else(||Error::new("SOURCE_REVISION_MISMATCH"))?;
        let record=job["intent"]["snapshot"]["sources"].as_array().unwrap().iter().find(|s|s["source_ref"]==unit["source_ref"]&&s["source_revision"]==unit["source_revision"])
            .ok_or_else(||Error::new("LEARNING_UNIT_SNAPSHOT_MISMATCH"))?;
        need(record["text_sha256"]==unit["text_sha256"]&&unit["text_sha256"]==wire::text_sha(source["text"].as_str().unwrap()),"EVIDENCE_HASH_MISMATCH")?;
        wire::span_text(source["text"].as_str().unwrap(),unit)?;
    }
    need(unit_ids==ids(&runtime["scope_unit_ids"]),"LEARNING_UNIT_SCOPE_MISMATCH")?;
    for id in job["intent"]["admission_evidence_ids"].as_array().unwrap() {
        let evidence=&ctx.fragments[id.as_str().unwrap()];
        let mut ranges:Vec<(u64,u64)>=runtime["units"].as_array().unwrap().iter()
            .filter(|u|u["source_ref"]==evidence["source_ref"]&&u["source_revision"]==evidence["source_revision"])
            .map(|u|(u["start"].as_u64().unwrap(),u["end"].as_u64().unwrap())).collect();
        ranges.sort();
        let mut covered=evidence["span"]["start"].as_u64().unwrap();
        let end=evidence["span"]["end"].as_u64().unwrap();
        for (start,stop) in ranges {if start<=covered {covered=covered.max(stop);}}
        need(covered>=end,"LEARNING_ADMISSION_OUTSIDE_SCOPE")?;
    }
    Ok(())
}
