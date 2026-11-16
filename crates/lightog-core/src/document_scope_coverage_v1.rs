//! Independent source-scope coverage observations. No model calls, keyword
//! matching, fact certification or publication writes occur in this module.
use crate::common::{a, canonical_hash as hash, error, len, s, text_sha, Result};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const VERSION: &str = "lightog-document-scope-coverage/0.1";
pub const PARTIAL_VERSION: &str = "lightog-document-scope-coverage/0.2";
pub const PARTIAL_POLICY: &str = "PARTIAL_SUPPORTED_TASKS_V1";
pub const STATES_VERSION: &str = "lightog-document-scope-coverage/0.3";
pub const STATES_PROTOCOL: &str = "SOURCE_CANDIDATE_COVERAGE_STATES_V1";
fn need(ok: bool, code: &str) -> Result<()> { if ok { Ok(()) } else { Err(error(code, code)) } }
fn shape(value: &Value, keys: &[&str]) -> Result<()> {
    need(value.as_object().is_some_and(|o| o.len()==keys.len() && keys.iter().all(|k|o.contains_key(*k))), "SCOPE_COVERAGE_SHAPE_INVALID")
}
fn string(value: &Value, max: usize) -> bool { value.as_str().is_some_and(|v| !v.trim().is_empty() && len(v)<=max) }
fn array<'a>(value: &'a Value, max: usize) -> Result<&'a [Value]> {
    need(value.is_array() && a(value).len()<=max, "SCOPE_COVERAGE_RESOURCE_LIMIT")?;
    Ok(a(value))
}
fn ids(value: &Value) -> Result<BTreeSet<String>> {
    let mut result=BTreeSet::new();
    for id in array(value,4096)? {
        need(string(id,512) && result.insert(s(id).to_owned()), "SCOPE_COVERAGE_ID_INVALID")?;
    }
    Ok(result)
}
fn schema() -> Value {
    let refs=json!({"type":"array","maxItems":4096,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":512}});
    json!({"type":"object","additionalProperties":false,"required":["rows"],"properties":{"rows":{"type":"array","minItems":1,"maxItems":1024,"items":{"type":"object","additionalProperties":false,"required":["task_id","decision","candidate_ids","evidence_ids","reason"],"properties":{
        "task_id":{"type":"string","minLength":1,"maxLength":512},"decision":{"enum":["SUPPORTED","SOURCE_INSUFFICIENT","EXTRACTION_GAP","UNKNOWN"]},"candidate_ids":refs,"evidence_ids":refs,"reason":{"type":"string","minLength":1,"maxLength":8000}
    }}}}})
}
fn states_schema(task_ids:&BTreeSet<String>,candidate_ids:&BTreeSet<String>,evidence_ids:Vec<&String>)->Value {
    let refs=|values:Value|json!({"type":"array","maxItems":4096,"uniqueItems":true,"items":{"type":"string","enum":values}});
    json!({"type":"object","additionalProperties":false,"required":["rows"],"properties":{"rows":{"type":"array","minItems":task_ids.len(),"maxItems":task_ids.len(),"items":{"type":"object","additionalProperties":false,"required":["task_id","source_evidence_state","candidate_answer_state","candidate_ids","evidence_ids","reason"],"properties":{
        "task_id":{"type":"string","enum":task_ids},"source_evidence_state":{"enum":["ANSWER_PRESENT","INSUFFICIENT","UNKNOWN"]},
        "candidate_answer_state":{"enum":["COMPLETE","PARTIAL","ABSENT","UNKNOWN"]},"candidate_ids":refs(json!(candidate_ids)),"evidence_ids":refs(json!(evidence_ids)),
        "reason":{"type":"string","minLength":1,"maxLength":8000}
    }}}}})
}
fn source_menu_complete(snapshot:&Value, menu:&Value)->Result<bool>{
    let sources=a(&snapshot["sources"]);
    let mut complete=!sources.is_empty();
    for source in sources {
        let mut fragments:Vec<&Value>=a(menu).iter().filter(|m|m["source_ref"]==source["source_ref"] && m["source_revision"]==source["source_revision"]).collect();
        fragments.sort_by_key(|m|(m["span"]["start"].as_u64().unwrap(),m["span"]["end"].as_u64().unwrap()));
        let mut units:Vec<u16>=vec![];let mut gap=false;
        for fragment in fragments {
            let start=fragment["span"]["start"].as_u64().unwrap() as usize;
            let quote:Vec<u16>=s(&fragment["span"]["quote"]).encode_utf16().collect();
            if start>units.len(){gap=true;break;}
            let overlap=(units.len()-start).min(quote.len());
            need(units[start..start+overlap]==quote[..overlap],"SCOPE_COVERAGE_EVIDENCE_OVERLAP_CHANGED")?;
            units.extend_from_slice(&quote[overlap..]);
        }
        let text=String::from_utf16(&units).map_err(|_|error("SCOPE_COVERAGE_UNICODE_INVALID","SCOPE_COVERAGE_UNICODE_INVALID"))?;
        complete &= !gap && string(&source["text_sha256"],128) && text_sha(&text)==s(&source["text_sha256"]);
    }
    Ok(complete)
}
pub fn prepare(p: &Value) -> Result<Value> {
    let partial=p["readiness_policy"]==PARTIAL_POLICY;
    let states=p["review_protocol"]==STATES_PROTOCOL;
    if states { need(partial,"SCOPE_COVERAGE_STATES_PARTIAL_POLICY_REQUIRED")?;shape(p,&["plan","candidates","evidence_menu","snapshot","readiness_policy","admission_input","review_protocol"])?; }
    else if partial { shape(p,&["plan","candidates","evidence_menu","snapshot","readiness_policy","admission_input"])?; }
    else { shape(p,&["plan","candidates","evidence_menu","snapshot"])?; }
    // This reuses the source-scope seal and current source validator. The graph
    // may have changed since discovery; base, source epoch and sources may not.
    crate::document_scope_v1::execute("build_question", &json!({"plan":p["plan"],"current_snapshot":p["snapshot"]}))?;
    let tasks=array(&p["plan"]["tasks"],1024)?;
    need(!tasks.is_empty(),"SCOPE_COVERAGE_TASKS_REQUIRED")?;
    let mut task_ids=BTreeSet::new();
    for task in tasks { need(string(&task["id"],512) && task_ids.insert(s(&task["id"]).to_owned()),"SCOPE_COVERAGE_TASK_ID_INVALID")?; }
    let mut menu=BTreeMap::new();
    for fragment in array(&p["evidence_menu"],4096)? {
        let span=&fragment["span"];
        let start=span["start"].as_u64(); let end=span["end"].as_u64();
        need(string(&fragment["evidence_id"],512) && start.is_some() && end.is_some_and(|e| e>start.unwrap()) && span["quote"].as_str().is_some_and(|q|len(q) as u64==end.unwrap()-start.unwrap()),"SCOPE_COVERAGE_EVIDENCE_INVALID")?;
        need(a(&p["snapshot"]["sources"]).iter().any(|source|source["source_ref"]==fragment["source_ref"] && source["source_revision"]==fragment["source_revision"]),"SCOPE_COVERAGE_SOURCE_STALE")?;
        need(menu.insert(s(&fragment["evidence_id"]).to_owned(),fragment.clone()).is_none(),"SCOPE_COVERAGE_EVIDENCE_DUPLICATE")?;
    }
    need(!menu.is_empty(),"SCOPE_COVERAGE_EVIDENCE_REQUIRED")?;
    let menu_complete=source_menu_complete(&p["snapshot"],&p["evidence_menu"])?;
    let discovery_complete=p["plan"]["all_batches_returned"]==true && p["plan"]["all_source_text_in_menu"]==true && p["plan"]["pending_batches"]==json!([]);
    let mut candidate_ids=BTreeSet::new();
    for candidate in array(&p["candidates"],4096)? {
        need(string(&candidate["id"],512) && candidate_ids.insert(s(&candidate["id"]).to_owned()),"SCOPE_COVERAGE_CANDIDATE_INVALID")?;
        let support=ids(&candidate["evidence_ids"])?;
        need(!support.is_empty() && support.iter().all(|id|menu.contains_key(id)),"SCOPE_COVERAGE_CANDIDATE_EVIDENCE_INVALID")?;
        need(string(&candidate["description"],16000),"SCOPE_COVERAGE_CANDIDATE_INVALID")?;
    }
    let admission=if partial {
        need(p["admission_input"]["current_snapshot"]==p["snapshot"],"SCOPE_COVERAGE_ADMISSION_SOURCE_CHANGED")?;
        let checked=crate::incremental_graph_v1::execute("assess_partial_publication",&p["admission_input"])?;
        need(checked["ready_for_scope_review"]==true,"SCOPE_COVERAGE_ADMISSION_BLOCKED")?;
        let originals:BTreeMap<_,_>=a(&checked["eligible_candidates"]).iter().map(|c|(s(&c["candidate_id"]).to_owned(),c)).collect();
        need(candidate_ids==originals.keys().cloned().collect(),"SCOPE_COVERAGE_ADMISSION_POOL_CHANGED")?;
        for candidate in a(&p["candidates"]) {
            let original=originals[s(&candidate["id"])];
            let mut restored=candidate.clone();restored.as_object_mut().unwrap().remove("id");
            restored["evidence_ids"]=original["evidence_ids"].clone();
            need(restored==*original,"SCOPE_COVERAGE_ADMISSION_CANDIDATE_CHANGED")?;
            let fragments=&p["admission_input"]["trusted_context"]["examples"][s(&original["evidence_set_ref"])]["fragments"];
            let mut original_support=BTreeSet::new();
            for id in a(&original["evidence_ids"]) {
                let found:Vec<_>=a(fragments).iter().filter(|f|f["id"]==*id).collect();
                need(found.len()==1,"SCOPE_COVERAGE_ADMISSION_EVIDENCE_MISSING")?;
                original_support.insert(hash(&json!({"source_ref":found[0]["source_ref"],"source_revision":found[0]["source_revision"],"span":found[0]["span"]})));
            }
            let mapped:BTreeSet<_>=a(&candidate["evidence_ids"]).iter().map(|id|{
                let f=&menu[s(id)];hash(&json!({"source_ref":f["source_ref"],"source_revision":f["source_revision"],"span":f["span"]}))
            }).collect();
            need(original_support==mapped,"SCOPE_COVERAGE_ADMISSION_EVIDENCE_CHANGED")?;
        }
        checked
    } else {Value::Null};
    let manifest=json!({"task_ids":task_ids,"candidate_ids":candidate_ids,"evidence_ids":menu.keys().collect::<Vec<_>>()});
    let mut prepared=json!({"contract_version":if states{STATES_VERSION}else if partial{PARTIAL_VERSION}else{VERSION},"input":p,"manifest":manifest,"review_tasks":tasks,"candidates":p["candidates"],"evidence_menu":p["evidence_menu"],"output_schema":if states{states_schema(&task_ids,&candidate_ids,menu.keys().collect())}else{schema()},
        "plan_sha256":hash(&p["plan"]),"snapshot_sha256":hash(&p["snapshot"]),"candidates_sha256":hash(&p["candidates"]),"evidence_menu_sha256":hash(&p["evidence_menu"]),"manifest_sha256":hash(&manifest),"source_menu_complete":menu_complete,"scope_discovery_complete":discovery_complete});
    if partial {
        prepared["readiness_policy"]=json!(PARTIAL_POLICY);
        prepared["admission_sha256"]=admission["admission_sha256"].clone();
        prepared["eligible_candidate_ids"]=admission["eligible_candidate_ids"].clone();
        prepared["incomplete_blockers"]=admission["incomplete_blockers"].clone();
    }
    if states {prepared["review_protocol"]=json!(STATES_PROTOCOL);}
    prepared["prepared_sha256"]=json!(hash(&prepared));
    Ok(prepared)
}
pub fn materialize(p: &Value) -> Result<Value> {
    shape(p,&["prepared","raw"])?;
    let prepared=&p["prepared"];
    need(*prepared==prepare(&prepared["input"])? ,"SCOPE_COVERAGE_PREPARED_CHANGED")?;
    let raw=if p["raw"].is_string(){crate::model_json_boundary::parse(s(&p["raw"]))?["parsed"].clone()}else{p["raw"].clone()};
    shape(&raw,&["rows"])?;
    if prepared["contract_version"]==STATES_VERSION {return materialize_states(prepared,&raw,if p["raw"].is_string(){json!(text_sha(s(&p["raw"])))}else{Value::Null});}
    let expected=ids(&prepared["manifest"]["task_ids"])?;
    let menu=ids(&prepared["manifest"]["evidence_ids"])?;
    let candidates:BTreeMap<String,Value>=a(&prepared["candidates"]).iter().map(|c|(s(&c["id"]).to_owned(),c.clone())).collect();
    let rows=array(&raw["rows"],1024)?;
    need(rows.len()==expected.len(),"SCOPE_COVERAGE_TASKS_INCOMPLETE")?;
    let mut seen=BTreeSet::new();let mut ready=prepared["source_menu_complete"]==true && prepared["scope_discovery_complete"]==true;let mut all_supported=true;let mut any_insufficient=false;
    for row in rows {
        shape(row,&["task_id","decision","candidate_ids","evidence_ids","reason"])?;
        need(expected.contains(s(&row["task_id"])) && seen.insert(s(&row["task_id"]).to_owned()),"SCOPE_COVERAGE_TASK_UNKNOWN_OR_DUPLICATE")?;
        need(string(&row["reason"],8000),"SCOPE_COVERAGE_REASON_REQUIRED")?;
        let selected=ids(&row["candidate_ids"])?;let evidence=ids(&row["evidence_ids"])?;
        need(selected.iter().all(|id|candidates.contains_key(id)) && evidence.is_subset(&menu),"SCOPE_COVERAGE_REFERENCE_UNKNOWN")?;
        match s(&row["decision"]) {
            "SUPPORTED"=>{
                need(!selected.is_empty() && !evidence.is_empty(),"SCOPE_COVERAGE_SUPPORTED_REFERENCES_REQUIRED")?;
                let mut support=BTreeSet::new();
                for id in &selected {
                    let candidate_support=ids(&candidates[id]["evidence_ids"])?;
                    need(!candidate_support.is_disjoint(&evidence),"SCOPE_COVERAGE_CANDIDATE_SUPPORT_NOT_CITED")?;
                    support.extend(candidate_support);
                }
                need(evidence.is_subset(&support),"SCOPE_COVERAGE_SUPPORTED_EVIDENCE_NOT_DECLARED")?;
            },
            "SOURCE_INSUFFICIENT"=>{
                need(selected.is_empty() && !evidence.is_empty(),"SCOPE_COVERAGE_INSUFFICIENT_SOURCE_REQUIRED")?;
                all_supported=false;any_insufficient=true;
            },
            "EXTRACTION_GAP"=>{need(!evidence.is_empty(),"SCOPE_COVERAGE_GAP_SOURCE_REQUIRED")?;ready=false;all_supported=false;},
            "UNKNOWN"=>{ready=false;all_supported=false;},
            _=>return Err(error("SCOPE_COVERAGE_DECISION_INVALID","SCOPE_COVERAGE_DECISION_INVALID"))
        }
    }
    need(seen==expected,"SCOPE_COVERAGE_TASKS_INCOMPLETE")?;
    let mut result=json!({"contract_version":prepared["contract_version"],"plan_id":prepared["input"]["plan"]["plan_id"],"snapshot":prepared["input"]["snapshot"],"plan_sha256":prepared["plan_sha256"],"snapshot_sha256":prepared["snapshot_sha256"],"candidates_sha256":prepared["candidates_sha256"],"evidence_menu_sha256":prepared["evidence_menu_sha256"],"manifest_sha256":prepared["manifest_sha256"],"prepared_sha256":prepared["prepared_sha256"],"raw_sha256":hash(&raw),"rows":rows,
        "all_tasks_accounted":true,"all_supported":all_supported,"ready_for_publication":ready,"limited_available":ready && any_insufficient,"source_menu_complete":prepared["source_menu_complete"],"scope_discovery_complete":prepared["scope_discovery_complete"],"coverage_scope":"DECLARED_TASKS_AND_VISIBLE_SOURCE_MENU_ONLY","coverage_complete":false,"semantic_support_certified":false});
    if prepared["contract_version"]==PARTIAL_VERSION {
        let supported:BTreeSet<_>=rows.iter().filter(|r|r["decision"]=="SUPPORTED").map(|r|s(&r["task_id"]).to_owned()).collect();
        let source_ready=prepared["source_menu_complete"]==true && prepared["scope_discovery_complete"]==true;
        let reusable=if source_ready{supported.clone()}else{BTreeSet::new()};
        let publishable:BTreeSet<_>=rows.iter().filter(|r|reusable.contains(s(&r["task_id"]))).flat_map(|r|a(&r["candidate_ids"]).iter().map(|id|s(id).to_owned())).collect();
        let partial_ready=source_ready && !publishable.is_empty();
        result["readiness_policy"]=json!(PARTIAL_POLICY);
        result["admission_sha256"]=prepared["admission_sha256"].clone();
        result["eligible_candidate_ids"]=prepared["eligible_candidate_ids"].clone();
        result["incomplete_blockers"]=prepared["incomplete_blockers"].clone();
        result["partial_ready"]=json!(partial_ready);
        result["readiness_status"]=json!(if ready && any_insufficient{"LIMITED_AVAILABLE"}else if ready{"READY"}else if partial_ready{"PARTIAL_READY"}else{"BLOCKED"});
        result["supported_task_ids"]=json!(supported);
        result["reusable_task_ids"]=json!(reusable);
        result["publishable_candidate_ids"]=json!(publishable);
        result["source_insufficient_task_ids"]=json!(rows.iter().filter(|r|r["decision"]=="SOURCE_INSUFFICIENT").map(|r|r["task_id"].clone()).collect::<Vec<_>>());
        result["unresolved_task_ids"]=json!(rows.iter().filter(|r|r["decision"]=="UNKNOWN"||r["decision"]=="EXTRACTION_GAP").map(|r|r["task_id"].clone()).collect::<Vec<_>>());
    }
    result["receipt_hash"]=json!(hash(&result));
    Ok(result)
}
fn supported_refs(selected:&BTreeSet<String>,evidence:&BTreeSet<String>,candidates:&BTreeMap<String,Value>)->Result<()> {
    need(!selected.is_empty() && !evidence.is_empty(),"SCOPE_COVERAGE_SUPPORTED_REFERENCES_REQUIRED")?;
    let mut support=BTreeSet::new();
    for id in selected {
        let declared=ids(&candidates[id]["evidence_ids"])?;
        need(!declared.is_disjoint(evidence),"SCOPE_COVERAGE_CANDIDATE_SUPPORT_NOT_CITED")?;
        support.extend(declared);
    }
    need(evidence.is_subset(&support),"SCOPE_COVERAGE_SUPPORTED_EVIDENCE_NOT_DECLARED")
}
fn state_row_refs(row:&Value,candidates:&BTreeMap<String,Value>,menu:&BTreeSet<String>)->Result<()> {
    let selected=ids(&row["candidate_ids"])?;let evidence=ids(&row["evidence_ids"])?;
    need(selected.iter().all(|id|candidates.contains_key(id)) && evidence.is_subset(menu),"SCOPE_COVERAGE_REFERENCE_UNKNOWN")?;
    match s(&row["candidate_answer_state"]) {
        "COMPLETE"=>supported_refs(&selected,&evidence,candidates)?,
        "PARTIAL"=>need(!selected.is_empty(),"SCOPE_COVERAGE_PARTIAL_CANDIDATES_REQUIRED")?,
        "ABSENT"=>need(selected.is_empty(),"SCOPE_COVERAGE_ABSENT_CANDIDATES_NOT_EMPTY")?,
        _=>{}
    }
    if row["source_evidence_state"]!="UNKNOWN" {need(!evidence.is_empty(),"SCOPE_COVERAGE_SOURCE_EVIDENCE_REQUIRED")?;}
    Ok(())
}
// The raw two-axis observations remain untouched. Only derived, protocol-valid
// COMPLETE candidate answers can be published; full source quotes cannot turn
// a PARTIAL or ABSENT candidate answer into a complete graph answer.
fn materialize_states(prepared:&Value,raw:&Value,raw_text_sha256:Value)->Result<Value> {
    let expected=ids(&prepared["manifest"]["task_ids"])?;let menu=ids(&prepared["manifest"]["evidence_ids"])?;
    let candidates:BTreeMap<String,Value>=a(&prepared["candidates"]).iter().map(|c|(s(&c["id"]).to_owned(),c.clone())).collect();
    let rows=array(&raw["rows"],1024)?;need(rows.len()==expected.len(),"SCOPE_COVERAGE_TASKS_INCOMPLETE")?;
    let mut seen=BTreeSet::new();
    // Task conservation, parse/shape and source/admission bindings are global
    // invariants. They are never converted to per-task holds.
    for row in rows {
        shape(row,&["task_id","source_evidence_state","candidate_answer_state","candidate_ids","evidence_ids","reason"])?;
        need(expected.contains(s(&row["task_id"])) && seen.insert(s(&row["task_id"]).to_owned()),"SCOPE_COVERAGE_TASK_UNKNOWN_OR_DUPLICATE")?;
        need(string(&row["reason"],8000) && row["candidate_ids"].is_array() && row["evidence_ids"].is_array(),"SCOPE_COVERAGE_SHAPE_INVALID")?;
        need(["ANSWER_PRESENT","INSUFFICIENT","UNKNOWN"].contains(&s(&row["source_evidence_state"])) && ["COMPLETE","PARTIAL","ABSENT","UNKNOWN"].contains(&s(&row["candidate_answer_state"])),"SCOPE_COVERAGE_STATE_INVALID")?;
    }
    need(seen==expected,"SCOPE_COVERAGE_TASKS_INCOMPLETE")?;
    let mut observations=vec![];let mut supported=BTreeSet::new();let mut insufficient=BTreeSet::new();let mut gap=BTreeSet::new();let mut unknown=BTreeSet::new();let mut held=BTreeSet::new();let mut publishable=BTreeSet::new();
    for row in rows {
        let source=s(&row["source_evidence_state"]);let candidate=s(&row["candidate_answer_state"]);
        let mut errors=vec![];
        if source=="INSUFFICIENT" && candidate=="COMPLETE" {errors.push("SCOPE_COVERAGE_STATES_CONTRADICT".to_owned());}
        if let Err(e)=state_row_refs(row,&candidates,&menu) {errors.push(e.code);}
        let derived=if source=="UNKNOWN" || candidate=="UNKNOWN" {"UNKNOWN"}
            else if source=="INSUFFICIENT" {"SOURCE_INSUFFICIENT"}
            else if candidate=="COMPLETE" {"SUPPORTED"}else{"EXTRACTION_GAP"};
        let valid=errors.is_empty();let task=s(&row["task_id"]).to_owned();
        if !valid {held.insert(task.clone());}
        else {match derived {
            "SUPPORTED"=>{supported.insert(task.clone());publishable.extend(ids(&row["candidate_ids"])?);},
            "SOURCE_INSUFFICIENT"=>{insufficient.insert(task.clone());},
            "EXTRACTION_GAP"=>{gap.insert(task.clone());},_=>{unknown.insert(task.clone());}
        }}
        observations.push(json!({"task_id":row["task_id"],"source_evidence_state":row["source_evidence_state"],"candidate_answer_state":row["candidate_answer_state"],
            "original_row_sha256":hash(row),"derived_decision":if valid{json!(derived)}else{Value::Null},"effective_status":if valid{derived}else{"PROTOCOL_HOLD"},"protocol_valid":valid,"error_codes":errors}));
    }
    let source_ready=prepared["source_menu_complete"]==true && prepared["scope_discovery_complete"]==true;
    let unresolved:BTreeSet<_>=gap.union(&unknown).cloned().chain(held.iter().cloned()).collect();
    let ready=source_ready && unresolved.is_empty();let all_supported=supported.len()==expected.len();
    let reusable=if source_ready{supported.clone()}else{BTreeSet::new()};
    if !source_ready {publishable.clear();}
    let partial_ready=source_ready && !publishable.is_empty();
    let mut incomplete=a(&prepared["incomplete_blockers"]).to_vec();if !held.is_empty(){incomplete.push(json!("SCOPE_ROW_PROTOCOL_HOLD"));}
    let mut result=json!({"contract_version":STATES_VERSION,"readiness_policy":PARTIAL_POLICY,"review_protocol":STATES_PROTOCOL,
        "plan_id":prepared["input"]["plan"]["plan_id"],"snapshot":prepared["input"]["snapshot"],"plan_sha256":prepared["plan_sha256"],"snapshot_sha256":prepared["snapshot_sha256"],"candidates_sha256":prepared["candidates_sha256"],"evidence_menu_sha256":prepared["evidence_menu_sha256"],"manifest_sha256":prepared["manifest_sha256"],"prepared_sha256":prepared["prepared_sha256"],"raw_sha256":hash(raw),"raw_text_sha256":raw_text_sha256,
        "rows":rows,"row_observations":observations,"all_tasks_accounted":true,"all_supported":all_supported,"ready_for_publication":ready,"limited_available":ready && !insufficient.is_empty(),"partial_ready":partial_ready,
        "readiness_status":if ready && !insufficient.is_empty(){"LIMITED_AVAILABLE"}else if ready{"READY"}else if partial_ready{"PARTIAL_READY"}else{"BLOCKED"},
        "supported_task_ids":supported,"reusable_task_ids":reusable,"publishable_candidate_ids":publishable,"source_insufficient_task_ids":insufficient,"unresolved_task_ids":unresolved,"extraction_gap_task_ids":gap,"unknown_task_ids":unknown,"protocol_held_task_ids":held,
        "source_menu_complete":prepared["source_menu_complete"],"scope_discovery_complete":prepared["scope_discovery_complete"],"admission_sha256":prepared["admission_sha256"],"eligible_candidate_ids":prepared["eligible_candidate_ids"],"incomplete_blockers":incomplete,
        "coverage_scope":"DECLARED_TASKS_AND_VISIBLE_SOURCE_MENU_ONLY","coverage_complete":false,"semantic_support_certified":false});
    result["receipt_hash"]=json!(hash(&result));Ok(result)
}
pub fn execute(op: &str, p: &Value) -> Result<Value> {
    match op {
        "prepare"=>prepare(p),
        "materialize"=>materialize(p),
        "validate_receipt"=>{
            shape(p,&["prepared","raw","receipt","current_snapshot"])?;
            let actual=materialize(&json!({"prepared":p["prepared"],"raw":p["raw"]}))?;
            need(actual==p["receipt"],"SCOPE_COVERAGE_RECEIPT_CHANGED")?;
            need(p["current_snapshot"]==actual["snapshot"],"SCOPE_COVERAGE_CURRENT_SNAPSHOT_CHANGED")?;
            let mut checked=json!({"validated":true,"receipt_hash":actual["receipt_hash"],"ready_for_publication":actual["ready_for_publication"],"all_supported":actual["all_supported"],"limited_available":actual["limited_available"],"semantic_support_certified":false});
            if actual["contract_version"]==PARTIAL_VERSION || actual["contract_version"]==STATES_VERSION {for field in ["readiness_policy","admission_sha256","eligible_candidate_ids","incomplete_blockers","partial_ready","readiness_status","supported_task_ids","reusable_task_ids","publishable_candidate_ids","source_insufficient_task_ids","unresolved_task_ids"] {checked[field]=actual[field].clone();}}
            if actual["contract_version"]==STATES_VERSION {for field in ["review_protocol","row_observations","protocol_held_task_ids","extraction_gap_task_ids","unknown_task_ids"]{checked[field]=actual[field].clone();}}
            Ok(checked)
        },
        _=>Err(error("SCOPE_COVERAGE_OPERATION_UNKNOWN",op))
    }
}
