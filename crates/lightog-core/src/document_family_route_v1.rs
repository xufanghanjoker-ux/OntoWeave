//! Validates a model-proposed family route against immutable source scope and
//! persisted coverage observations. This does not infer semantic equivalence.
use crate::common::{a, canonical_hash as hash, error, len, s, text_sha, Result};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const VERSION: &str = "lightog-document-family-route/0.1";
fn need(ok: bool, code: &str) -> Result<()> { if ok {Ok(())} else {Err(error(code,code))} }
fn shape(v: &Value, keys: &[&str]) -> Result<()> {
    need(v.as_object().is_some_and(|m|m.len()==keys.len() && keys.iter().all(|k|m.contains_key(*k))),"FAMILY_ROUTE_SHAPE_INVALID")
}
fn text(v: &Value, max: usize) -> bool {v.as_str().is_some_and(|t|!t.trim().is_empty() && len(t)<=max)}
fn array(v: &Value, max: usize) -> Result<&[Value]> {need(v.is_array() && a(v).len()<=max,"FAMILY_ROUTE_RESOURCE_LIMIT")?;Ok(a(v))}
fn ids(v: &Value) -> Result<BTreeSet<String>> {
    let mut ids=BTreeSet::new();
    for value in array(v,4096)? {need(text(value,512) && ids.insert(s(value).to_owned()),"FAMILY_ROUTE_ID_INVALID")?;}
    Ok(ids)
}
fn scope_equal(a: &Value,b: &Value)->bool {
    a["base_ref"]==b["base_ref"] && a["source_epoch"]==b["source_epoch"] && a["sources"]==b["sources"]
}
fn schema()->Value {
    let refs=json!({"type":"array","maxItems":4096,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":512}});
    json!({"type":"object","additionalProperties":false,"required":["route","family_ids","subject_ids","task_ids","reason"],"properties":{
        "route":{"enum":["SAME_SCOPE_REUSE","SAME_FAMILY_NEW_SCOPE","NEW_FAMILY","UNKNOWN"]},
        "family_ids":refs,"subject_ids":refs,"task_ids":refs,"reason":{"type":"string","minLength":1,"maxLength":8000}
    }})
}

pub fn prepare(p:&Value)->Result<Value> {
    if p.get("scope_task_restriction").is_some(){shape(p,&["plan","question","snapshot","coverage_receipt","scope_task_restriction"])?;}else{shape(p,&["plan","question","snapshot","coverage_receipt"])?;}
    need(text(&p["question"],4096),"FAMILY_ROUTE_QUESTION_INVALID")?;
    let plan=&p["plan"];
    crate::document_scope_v1::execute("build_question",&json!({"plan":plan,"current_snapshot":p["snapshot"]}))?;
    let mut families=BTreeSet::new();
    for family in array(&plan["families"],4096)? {need(text(&family["id"],512) && families.insert(s(&family["id"]).to_owned()),"FAMILY_ROUTE_FAMILY_INVALID")?;}
    let mut subjects=BTreeSet::new();
    for subject in array(&plan["subjects"],4096)? {need(text(&subject["id"],512) && subjects.insert(s(&subject["id"]).to_owned()),"FAMILY_ROUTE_SUBJECT_INVALID")?;}
    let mut tasks=BTreeMap::new();
    for task in array(&plan["tasks"],4096)? {
        need(text(&task["id"],512) && families.contains(s(&task["family_id"])) && subjects.contains(s(&task["subject_id"])) && task["subject"]["id"]==task["subject_id"],"FAMILY_ROUTE_TASK_INVALID")?;
        let family=a(&plan["families"]).iter().find(|f|f["id"]==task["family_id"]).unwrap();
        need(a(&family["subject_ids"]).contains(&task["subject_id"]),"FAMILY_ROUTE_TASK_BINDING_INVALID")?;
        need(tasks.insert(s(&task["id"]).to_owned(),task.clone()).is_none(),"FAMILY_ROUTE_TASK_INVALID")?;
    }
    let mut supported=BTreeSet::new();
    let mut coverage_hash=Value::Null;
    let coverage=&p["coverage_receipt"];
    if !coverage.is_null() {
        let states=coverage["contract_version"]==crate::document_scope_coverage_v1::STATES_VERSION;
        let partial=coverage["contract_version"]==crate::document_scope_coverage_v1::PARTIAL_VERSION || states;
        need((coverage["contract_version"]==crate::document_scope_coverage_v1::VERSION || partial) && coverage["plan_id"]==plan["plan_id"] && coverage["plan_sha256"]==hash(plan),"FAMILY_ROUTE_COVERAGE_PLAN_CHANGED")?;
        need(scope_equal(&coverage["snapshot"],&p["snapshot"]),"FAMILY_ROUTE_COVERAGE_SOURCE_STALE")?;
        let mut unsigned=coverage.clone();
        let receipt_hash=unsigned.as_object_mut().ok_or_else(||error("FAMILY_ROUTE_COVERAGE_INVALID","FAMILY_ROUTE_COVERAGE_INVALID"))?.remove("receipt_hash").unwrap_or(Value::Null);
        need(receipt_hash==hash(&unsigned),"FAMILY_ROUTE_COVERAGE_CHANGED")?;
        coverage_hash=receipt_hash;
        let rows=array(&coverage["rows"],4096)?;
        need(rows.len()==tasks.len() && coverage["all_tasks_accounted"]==true,"FAMILY_ROUTE_COVERAGE_INCOMPLETE")?;
        let mut seen=BTreeSet::new();
        let mut held=BTreeSet::new();let mut gaps=BTreeSet::new();let mut unknowns=BTreeSet::new();let mut insufficient=BTreeSet::new();
        let observations=if states{array(&coverage["row_observations"],4096)?}else{&[]};
        if states {need(observations.len()==rows.len() && coverage["review_protocol"]==crate::document_scope_coverage_v1::STATES_PROTOCOL,"FAMILY_ROUTE_COVERAGE_INVALID")?;}
        for row in rows {
            need(tasks.contains_key(s(&row["task_id"])) && seen.insert(s(&row["task_id"]).to_owned()),"FAMILY_ROUTE_COVERAGE_TASK_INVALID")?;
            let decision=if states {
                let found:Vec<_>=observations.iter().filter(|o|o["task_id"]==row["task_id"]).collect();
                need(found.len()==1,"FAMILY_ROUTE_COVERAGE_INVALID")?;let o=found[0];
                need(o["source_evidence_state"]==row["source_evidence_state"] && o["candidate_answer_state"]==row["candidate_answer_state"] && o["original_row_sha256"]==hash(row)
                    && o["protocol_valid"].is_boolean() && o["error_codes"].is_array(),"FAMILY_ROUTE_COVERAGE_INVALID")?;
                let source=s(&row["source_evidence_state"]);let candidate=s(&row["candidate_answer_state"]);
                need(["ANSWER_PRESENT","INSUFFICIENT","UNKNOWN"].contains(&source) && ["COMPLETE","PARTIAL","ABSENT","UNKNOWN"].contains(&candidate),"FAMILY_ROUTE_COVERAGE_INVALID")?;
                if o["protocol_valid"]==true {
                    let derived=if source=="UNKNOWN"||candidate=="UNKNOWN"{"UNKNOWN"}else if source=="INSUFFICIENT"{"SOURCE_INSUFFICIENT"}else if candidate=="COMPLETE"{"SUPPORTED"}else{"EXTRACTION_GAP"};
                    need(!(source=="INSUFFICIENT"&&candidate=="COMPLETE") && a(&o["error_codes"]).is_empty() && o["derived_decision"]==derived && o["effective_status"]==derived,"FAMILY_ROUTE_COVERAGE_INVALID")?;
                    derived
                }else{
                    need(!a(&o["error_codes"]).is_empty() && o["derived_decision"].is_null() && o["effective_status"]=="PROTOCOL_HOLD","FAMILY_ROUTE_COVERAGE_INVALID")?;
                    "PROTOCOL_HOLD"
                }
            }else{s(&row["decision"])};
            need(matches!(decision,"SUPPORTED"|"SOURCE_INSUFFICIENT"|"EXTRACTION_GAP"|"UNKNOWN"|"PROTOCOL_HOLD") && (states || decision!="PROTOCOL_HOLD"),"FAMILY_ROUTE_COVERAGE_INVALID")?;
            match decision {"PROTOCOL_HOLD"=>{held.insert(s(&row["task_id"]).to_owned());},"EXTRACTION_GAP"=>{gaps.insert(s(&row["task_id"]).to_owned());},"UNKNOWN"=>{unknowns.insert(s(&row["task_id"]).to_owned());},"SOURCE_INSUFFICIENT"=>{insufficient.insert(s(&row["task_id"]).to_owned());},_=>{}}
            if decision=="SUPPORTED" {
                need(!ids(&row["candidate_ids"])?.is_empty() && !ids(&row["evidence_ids"])?.is_empty(),"FAMILY_ROUTE_COVERAGE_INVALID")?;
                supported.insert(s(&row["task_id"]).to_owned());
            }
        }
        if states {
            let unresolved:BTreeSet<_>=gaps.union(&unknowns).cloned().chain(held.iter().cloned()).collect();
            need(ids(&coverage["protocol_held_task_ids"])?==held && ids(&coverage["extraction_gap_task_ids"])?==gaps && ids(&coverage["unknown_task_ids"])?==unknowns
                && ids(&coverage["source_insufficient_task_ids"])?==insufficient && ids(&coverage["unresolved_task_ids"])?==unresolved,"FAMILY_ROUTE_COVERAGE_INVALID")?;
        }
        if partial {
            need(coverage["readiness_policy"]==crate::document_scope_coverage_v1::PARTIAL_POLICY
                && coverage["coverage_complete"]==false
                && ids(&coverage["supported_task_ids"])?==supported,"FAMILY_ROUTE_COVERAGE_INVALID")?;
            let reusable=ids(&coverage["reusable_task_ids"])?;
            let source_ready=coverage["source_menu_complete"]==true && coverage["scope_discovery_complete"]==true;
            need(reusable==if source_ready{supported.clone()}else{BTreeSet::new()},"FAMILY_ROUTE_COVERAGE_INVALID")?;
            let expected_candidates:BTreeSet<_>=rows.iter().filter(|r|reusable.contains(s(&r["task_id"]))).flat_map(|r|a(&r["candidate_ids"]).iter().map(|id|s(id).to_owned())).collect();
            need(ids(&coverage["publishable_candidate_ids"])?==expected_candidates
                && expected_candidates.is_subset(&ids(&coverage["eligible_candidate_ids"])?)
                && coverage["partial_ready"]==json!(source_ready && !expected_candidates.is_empty()),"FAMILY_ROUTE_COVERAGE_INVALID")?;
            supported=reusable;
        }
    }
    if let Some(restriction)=p.get("scope_task_restriction") {
        need(!coverage.is_null() && restriction.is_object(),"FAMILY_ROUTE_SCOPE_TASK_AUDIT_INVALID")?;
        let actual=crate::incremental_graph_v1::scope_task_restriction(coverage,plan,&p["snapshot"],&restriction["task_scope_deferrals"])?;
        need(*restriction==actual,"FAMILY_ROUTE_SCOPE_TASK_AUDIT_CHANGED")?;
        supported=ids(&actual["reusable_task_ids"])?;
    }
    let manifest=json!({"family_ids":families,"subject_ids":subjects,"task_ids":tasks.keys().collect::<Vec<_>>(),"supported_task_ids":supported});
    let mut prepared=json!({"contract_version":VERSION,"input":p,"manifest":manifest,"question":p["question"],"snapshot":p["snapshot"],"families":plan["families"],"subjects":plan["subjects"],"tasks":plan["tasks"],"coverage_rows":if coverage.is_null(){json!([])}else{coverage["rows"].clone()},"coverage_receipt_hash":coverage_hash,"question_sha256":text_sha(s(&p["question"])),"plan_sha256":hash(plan),"snapshot_sha256":hash(&p["snapshot"]),"output_schema":schema(),"semantic_equivalence_certified":false});
    if let Some(restriction)=p.get("scope_task_restriction"){prepared["scope_task_restriction_hash"]=restriction["restriction_hash"].clone();}
    prepared["prepared_sha256"]=json!(hash(&prepared));
    Ok(prepared)
}

pub fn materialize(p:&Value)->Result<Value> {
    shape(p,&["prepared","raw"])?;
    let prepared=&p["prepared"];
    need(*prepared==prepare(&prepared["input"])? ,"FAMILY_ROUTE_PREPARED_CHANGED")?;
    let raw=if p["raw"].is_string(){crate::model_json_boundary::parse(s(&p["raw"]))?["parsed"].clone()}else{p["raw"].clone()};
    shape(&raw,&["route","family_ids","subject_ids","task_ids","reason"])?;
    need(text(&raw["reason"],8000),"FAMILY_ROUTE_REASON_REQUIRED")?;
    let families=ids(&raw["family_ids"])?;let subjects=ids(&raw["subject_ids"])?;let tasks=ids(&raw["task_ids"])?;
    need(families.is_subset(&ids(&prepared["manifest"]["family_ids"])?) && subjects.is_subset(&ids(&prepared["manifest"]["subject_ids"])?) && tasks.is_subset(&ids(&prepared["manifest"]["task_ids"])?),"FAMILY_ROUTE_REFERENCE_UNKNOWN")?;
    let mut task_families=BTreeSet::new();let mut task_subjects=BTreeSet::new();
    for task in a(&prepared["tasks"]).iter().filter(|t|tasks.contains(s(&t["id"]))) {
        task_families.insert(s(&task["family_id"]).to_owned());task_subjects.insert(s(&task["subject_id"]).to_owned());
    }
    let reuse=match s(&raw["route"]) {
        "SAME_SCOPE_REUSE"=>{
            need(!tasks.is_empty() && tasks.is_subset(&ids(&prepared["manifest"]["supported_task_ids"])?) && families==task_families && subjects==task_subjects,"FAMILY_ROUTE_REUSE_NOT_COVERED")?;
            true
        },
        "SAME_FAMILY_NEW_SCOPE"=>{
            need(!families.is_empty() && task_families.is_subset(&families),"FAMILY_ROUTE_NEW_SCOPE_BINDING_INVALID")?;
            for sid in &subjects {
                need(a(&prepared["families"]).iter().any(|f|families.contains(s(&f["id"])) && a(&f["subject_ids"]).contains(&json!(sid))),"FAMILY_ROUTE_NEW_SCOPE_BINDING_INVALID")?;
            }
            false
        },
        "NEW_FAMILY"=>{need(families.is_empty() && subjects.is_empty() && tasks.is_empty(),"FAMILY_ROUTE_NEW_FAMILY_REFERENCES_INVALID")?;false},
        "UNKNOWN"=>false,
        _=>return Err(error("FAMILY_ROUTE_DECISION_INVALID","FAMILY_ROUTE_DECISION_INVALID"))
    };
    let mut receipt=json!({"contract_version":VERSION,"plan_id":prepared["input"]["plan"]["plan_id"],"route":raw["route"],"family_ids":raw["family_ids"],"subject_ids":raw["subject_ids"],"task_ids":raw["task_ids"],"reason":raw["reason"],"reuse_eligible":reuse,"learning_proposed":matches!(s(&raw["route"]),"SAME_FAMILY_NEW_SCOPE"|"NEW_FAMILY"),"question_sha256":prepared["question_sha256"],"plan_sha256":prepared["plan_sha256"],"snapshot":prepared["snapshot"],"snapshot_sha256":prepared["snapshot_sha256"],"coverage_receipt_hash":prepared["coverage_receipt_hash"],"prepared_sha256":prepared["prepared_sha256"],"raw_sha256":hash(&raw),"semantic_equivalence_certified":false,"coverage_complete":false,"execution_performed":false});
    if let Some(value)=prepared.get("scope_task_restriction_hash"){receipt["scope_task_restriction_hash"]=value.clone();}
    receipt["receipt_hash"]=json!(hash(&receipt));Ok(receipt)
}

pub fn execute(op:&str,p:&Value)->Result<Value> {
    match op {
        "prepare"=>prepare(p),"materialize"=>materialize(p),
        "validate_receipt"=>{
            shape(p,&["prepared","raw","receipt","current_snapshot"])?;
            let actual=materialize(&json!({"prepared":p["prepared"],"raw":p["raw"]}))?;
            need(actual==p["receipt"],"FAMILY_ROUTE_RECEIPT_CHANGED")?;
            need(actual["snapshot"]==p["current_snapshot"],"FAMILY_ROUTE_CURRENT_SNAPSHOT_CHANGED")?;
            Ok(json!({"validated":true,"receipt_hash":actual["receipt_hash"],"route":actual["route"],"reuse_eligible":actual["reuse_eligible"],"semantic_equivalence_certified":false}))
        },
        _=>Err(error("FAMILY_ROUTE_OPERATION_UNKNOWN",op))
    }
}
