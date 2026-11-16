//! Source-only answer rules. I/O and lifecycle observations are supplied by the
//! host; source provenance, draft/review acceptance and final status are kernel rules.
use crate::common::{a, canonical_hash, error, len, s, text_sha, Result};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const VERSION: &str = "lightog-source-first-answer/0.1";
pub const KERNEL_VERSION: &str = "lightog-source-answer-rust/0.1";
const DIMS: [&str; 9] = crate::semantic_review::DIMENSIONS;
const DECISIONS: [&str; 4] = ["SUPPORTED", "PARTIAL", "UNSUPPORTED", "UNKNOWN"];
const COVERAGE: [&str; 4] = ["COVERED", "PARTIAL", "UNSUPPORTED", "UNKNOWN"];
const GENERATION_SYSTEM_SHA: &str = "b8be522abe2c54290eb370afbf05430a4f51f01ff998e36627238b7cc4f0c777";
const REVIEW_SYSTEM_SHA: &str = "e5a97da9425c28d4d0dc9b88b906909edfae1588aa10829c7c287979b296ab52";

fn need(ok: bool, code: &str) -> Result<()> { if ok { Ok(()) } else { Err(error(code, code)) } }
fn shape(v: &Value, keys: &[&str], code: &str) -> Result<()> {
    need(v.as_object().is_some_and(|m| m.len() == keys.len() && keys.iter().all(|k| m.contains_key(*k))), code)
}
fn text(v: &Value, max: usize) -> bool { v.as_str().is_some_and(|x| !x.trim().is_empty() && len(x) <= max) }
fn digest(v: &Value) -> bool { s(v).len() == 64 && s(v).bytes().all(|x| x.is_ascii_hexdigit() && !x.is_ascii_uppercase()) }
fn set(v: &Value) -> BTreeSet<String> { a(v).iter().map(|x| s(x).to_owned()).collect() }
fn refs(v: &Value, allowed: &BTreeSet<String>, nonempty: bool) -> Result<BTreeSet<String>> {
    let rows = v.as_array().ok_or_else(|| error("ANSWER_REFERENCE_INVALID", "ANSWER_REFERENCE_INVALID"))?;
    let ids = set(v);
    need(rows.len() <= 128 && (!nonempty || !rows.is_empty()) && rows.len() == ids.len()
        && rows.iter().all(|r| r.is_string() && allowed.contains(s(r))), "ANSWER_REFERENCE_INVALID")?;
    Ok(ids)
}
fn id_schema() -> Value { json!({"type":"array","maxItems":128,"uniqueItems":true,"items":{"type":"string"}}) }
fn answer_schema() -> Value {
    let mut statement_ids = id_schema(); statement_ids["minItems"] = json!(1);
    json!({"type":"object","additionalProperties":false,"required":["answer_status","statements","gaps"],"properties":{
        "answer_status":{"enum":["ANSWERED","PARTIAL","UNKNOWN"]},
        "statements":{"type":"array","maxItems":16,"items":{"type":"object","additionalProperties":false,"required":["text","evidence_ids"],"properties":{"text":{"type":"string","minLength":1,"maxLength":4000},"evidence_ids":statement_ids}}},
        "gaps":{"type":"array","maxItems":32,"items":{"type":"string","minLength":1,"maxLength":2000}}
    }})
}
fn review_schema(prepared: &Value, draft: &Value) -> Value {
    let dimension = json!({"type":"object","additionalProperties":false,"required":["decision","reason","evidence_ids"],"properties":{"decision":{"enum":DECISIONS},"reason":{"type":"string","minLength":1,"maxLength":4000},"evidence_ids":id_schema()}});
    let coverage = json!({"type":"object","additionalProperties":false,"required":["decision","reason","statement_ids","evidence_ids"],"properties":{"decision":{"enum":COVERAGE},"reason":{"type":"string","minLength":1,"maxLength":4000},"statement_ids":id_schema(),"evidence_ids":id_schema()}});
    let mut requirement = coverage.clone(); requirement["required"] = json!(["requirement_id","decision","reason","statement_ids","evidence_ids"]);
    requirement["properties"]["requirement_id"] = json!({"type":"string"});
    let dimensions = Value::Object(DIMS.iter().map(|d| (d.to_string(),dimension.clone())).collect());
    json!({"type":"object","additionalProperties":false,"required":["statements","requirements","question","gaps"],"properties":{
        "statements":{"type":"array","minItems":a(&draft["statements"]).len(),"maxItems":a(&draft["statements"]).len(),"items":{"type":"object","additionalProperties":false,"required":["statement_id","dimensions"],"properties":{"statement_id":{"type":"string"},"dimensions":{"type":"object","additionalProperties":false,"required":DIMS,"properties":dimensions}}}},
        "requirements":{"type":"array","minItems":a(&prepared["manifest"]["requirement_ids"]).len(),"maxItems":a(&prepared["manifest"]["requirement_ids"]).len(),"items":requirement},"question":coverage,
        "gaps":{"type":"array","maxItems":32,"items":{"type":"string","minLength":1,"maxLength":2000}}
    }})
}
fn validate_messages(messages: &Value, system_sha: &str, expected: &Value) -> Result<()> {
    need(messages.as_array().is_some_and(|m| m.len()==2), "ANSWER_PREPARED_BINDING_CHANGED")?;
    for message in a(messages) { shape(message,&["role","content"],"ANSWER_PREPARED_BINDING_CHANGED")?; }
    need(messages[0]["role"]=="system" && messages[1]["role"]=="user" && text_sha(s(&messages[0]["content"]))==system_sha,
        "ANSWER_PREPARED_BINDING_CHANGED")?;
    let user = crate::rpc::parse(s(&messages[1]["content"]).as_bytes())?;
    need(user==*expected,"ANSWER_PREPARED_BINDING_CHANGED")
}
fn validate_prepared(prepared: &Value, context: &Value) -> Result<()> {
    shape(prepared,&["contract_version","question","question_spec","evidence_set","source_evidence_menu","manifest","binding_sha256","messages","output_schema","source_validation","model_called"],"ANSWER_PREPARED_BINDING_CHANGED")?;
    need(prepared["contract_version"]==VERSION && text(&prepared["question"],4096) && prepared["model_called"]==false,"ANSWER_QUESTION_INVALID")?;
    let es=&prepared["evidence_set"];
    need(es["contract_version"]=="lightog-demand/0.1" && es["fragments"].as_array().is_some_and(|r|r.len()<=128),"SOURCE_EVIDENCE_SET_REQUIRED")?;
    let count:usize=a(&es["fragments"]).iter().map(|f|len(s(&f["span"]["quote"]))).sum();
    need(count<=24000,"SOURCE_CONTEXT_BUDGET_EXCEEDED")?;
    let receipt=lightog_demand::evidence_bridge::execute("compose",&json!({"request":{"bridge_version":"lightog-evidence-bridge/0.1","evidence_set_id":es["evidence_set_id"],"snapshot":es["snapshot"],"source_fragments":es["fragments"],"legacy_claim_ids":[]},"context":context,"legacy_claims":[]})).map_err(|e|error(e.code,e.code))?;
    need(receipt["evidence_set"]==*es && a(&receipt["legacy_claims"]).is_empty(),"SOURCE_COMPOSITION_CHANGED")?;
    let menu:Vec<Value>=a(&es["fragments"]).iter().map(|f| {let mut row=f.clone();row["evidence_id"]=f["id"].clone();row}).collect();
    need(prepared["source_evidence_menu"]==json!(menu),"ANSWER_PREPARED_BINDING_CHANGED")?;
    let spec=&prepared["question_spec"];
    if !spec.is_null() {
        need(spec["text"]==prepared["question"] && spec["text_sha256"]==text_sha(s(&prepared["question"])),"ANSWER_QUESTION_SPEC_MISMATCH")?;
        let checked=crate::demand::execute("adapt",&json!({"question":{"id":spec["question_id"],"text":prepared["question"]},"query_requirement":{"cq_id":spec["question_id"],"intent":"KNOWLEDGE_QUERY","relevance":"IN_SCOPE","needs_clarification":false},"shared_proposal":spec,"validation_context":{"examples":{},"source_texts":[],"authority":context["authority"]}}))?;
        need(checked["shared"]["question_spec"]==*spec,"ANSWER_QUESTION_SPEC_CHANGED")?;
    }
    let schema=answer_schema();need(prepared["output_schema"]==schema,"ANSWER_PREPARED_BINDING_CHANGED")?;
    validate_messages(&prepared["messages"],GENERATION_SYSTEM_SHA,&json!({"question":prepared["question"],"question_spec":spec,"source_evidence_menu":menu,"coverage_scope":"RETRIEVED_SOURCE_FRAGMENTS_ONLY","output_schema":schema}))?;
    let requirement_ids:Vec<Value>=a(&spec["requirements"]).iter().map(|r|r["id"].clone()).collect();
    let manifest=json!({"contract_version":VERSION,"question_sha256":text_sha(s(&prepared["question"])),"question_spec_sha256":if spec.is_null(){Value::Null}else{json!(canonical_hash(spec))},"evidence_set_sha256":canonical_hash(es),"trusted_context_sha256":canonical_hash(context),"snapshot_sha256":canonical_hash(&es["snapshot"]),"evidence_menu_sha256":canonical_hash(&json!(menu)),"requirement_ids":requirement_ids,"context_utf16":count,"coverage_scope":"RETRIEVED_SOURCE_FRAGMENTS_ONLY","transport":"BUFFERED_COMPLETE","max_provider_calls":2,"repair_limit":0,"retry_limit":0,"messages_sha256":canonical_hash(&prepared["messages"]),"output_schema_sha256":canonical_hash(&schema)});
    need(prepared["manifest"]==manifest && prepared["binding_sha256"]==canonical_hash(&manifest),"ANSWER_PREPARED_BINDING_CHANGED")?;
    need(prepared["source_validation"]==json!({"validator":"RUST_P1_EVIDENCE_COMPOSE","basis":receipt["basis"],"legacy_claim_count":0,"semantic_support_certified":false}),"ANSWER_PREPARED_BINDING_CHANGED")
}
fn draft_value(prepared:&Value, parsed:&Value, raw_sha:&str)->Result<Value> {
    shape(parsed,&["answer_status","statements","gaps"],"ANSWER_OUTPUT_SHAPE_INVALID")?;
    need(["ANSWERED","PARTIAL","UNKNOWN"].contains(&s(&parsed["answer_status"])) && parsed["statements"].as_array().is_some_and(|v|v.len()<=16)
        && parsed["gaps"].as_array().is_some_and(|v|v.len()<=32&&v.iter().all(|g|text(g,2000))),"ANSWER_OUTPUT_INVALID")?;
    let menu:BTreeSet<String>=a(&prepared["source_evidence_menu"]).iter().map(|f|s(&f["evidence_id"]).to_owned()).collect();let mut statements=vec![];
    for (i,row) in a(&parsed["statements"]).iter().enumerate() {
        shape(row,&["text","evidence_ids"],"ANSWER_STATEMENT_SHAPE_INVALID")?;need(text(&row["text"],4000),"ANSWER_STATEMENT_INVALID")?;refs(&row["evidence_ids"],&menu,true)?;
        statements.push(json!({"statement_id":format!("statement_{:03}",i+1),"text":row["text"],"evidence_ids":row["evidence_ids"]}));
    }
    need(parsed["answer_status"]!="ANSWERED"||!statements.is_empty(),"ANSWER_EMPTY_SUCCESS_INVALID")?;
    Ok(json!({"answer_status":parsed["answer_status"],"statements":statements,"gaps":parsed["gaps"],"raw_output_sha256":raw_sha,"semantic_support_certified":false}))
}
fn validate_draft(prepared:&Value,draft:&Value)->Result<()> {
    shape(draft,&["answer_status","statements","gaps","raw_output_sha256","semantic_support_certified"],"ANSWER_DRAFT_BINDING_CHANGED")?;
    need(digest(&draft["raw_output_sha256"]),"ANSWER_DRAFT_BINDING_CHANGED")?;
    let statements:Vec<Value>=a(&draft["statements"]).iter().map(|r|json!({"text":r["text"],"evidence_ids":r["evidence_ids"]})).collect();
    let checked=draft_value(prepared,&json!({"answer_status":draft["answer_status"],"statements":statements,"gaps":draft["gaps"]}),s(&draft["raw_output_sha256"]))?;
    need(*draft==checked,"ANSWER_DRAFT_BINDING_CHANGED")
}
fn validate_review_prepared(prepared:&Value,draft:&Value,review_prepared:&Value)->Result<()> {
    shape(review_prepared,&["manifest","messages","output_schema","messages_sha256"],"ANSWER_REVIEW_BINDING_CHANGED")?;
    let schema=review_schema(prepared,draft);let bindings:Vec<Value>=a(&draft["statements"]).iter().map(|row|json!({"statement_id":row["statement_id"],"statement_sha256":canonical_hash(row),"evidence_ids":row["evidence_ids"]})).collect();
    let manifest=json!({"contract_version":VERSION,"stage":"INDEPENDENT_ANSWER_REVIEW","prepared_binding_sha256":prepared["binding_sha256"],"draft_sha256":canonical_hash(draft),"snapshot_sha256":prepared["manifest"]["snapshot_sha256"],"statement_bindings":bindings,"requirement_ids":prepared["manifest"]["requirement_ids"],"dimensions":DIMS,"schema_sha256":canonical_hash(&schema)});
    need(review_prepared["manifest"]==manifest&&review_prepared["output_schema"]==schema&&review_prepared["messages_sha256"]==canonical_hash(&review_prepared["messages"]),"ANSWER_REVIEW_BINDING_CHANGED")?;
    validate_messages(&review_prepared["messages"],REVIEW_SYSTEM_SHA,&json!({"manifest":manifest,"question":prepared["question"],"question_spec":prepared["question_spec"],"answer_draft":draft,"source_evidence_menu":prepared["source_evidence_menu"],"output_schema":schema})).map_err(|_|error("ANSWER_REVIEW_BINDING_CHANGED","ANSWER_REVIEW_BINDING_CHANGED"))
}
fn coverage(row:&Value,requirement:bool,statements:&BTreeMap<String,Value>,eligible:&BTreeSet<String>,menu:&BTreeSet<String>)->Result<()> {
    shape(row,if requirement{&["requirement_id","decision","reason","statement_ids","evidence_ids"]}else{&["decision","reason","statement_ids","evidence_ids"]},"ANSWER_REVIEW_COVERAGE_SHAPE")?;
    need(COVERAGE.contains(&s(&row["decision"]))&&text(&row["reason"],4000),"ANSWER_REVIEW_COVERAGE_INVALID")?;
    let all_ids=statements.keys().cloned().collect();refs(&row["statement_ids"],&all_ids,false)?;refs(&row["evidence_ids"],menu,false)?;
    if row["decision"]=="COVERED" {let selected=refs(&row["statement_ids"],eligible,true)?;let cited=selected.iter().flat_map(|id|set(&statements[id]["evidence_ids"])).collect();refs(&row["evidence_ids"],&cited,true)?;}
    Ok(())
}
fn review_value(prepared:&Value,draft:&Value,parsed:&Value,raw_sha:&str)->Result<Value> {
    shape(parsed,&["statements","requirements","question","gaps"],"ANSWER_REVIEW_SHAPE_INVALID")?;
    need(parsed["statements"].as_array().is_some_and(|r|r.len()==a(&draft["statements"]).len()) && parsed["requirements"].as_array().is_some_and(|r|r.len()==a(&prepared["manifest"]["requirement_ids"]).len()) && parsed["gaps"].as_array().is_some_and(|r|r.len()<=32&&r.iter().all(|g|text(g,2000))),"ANSWER_REVIEW_SET_INCOMPLETE")?;
    let menu=a(&prepared["source_evidence_menu"]).iter().map(|f|s(&f["evidence_id"]).to_owned()).collect();
    let statements:BTreeMap<String,Value>=a(&draft["statements"]).iter().map(|row|(s(&row["statement_id"]).to_owned(),row.clone())).collect();let mut seen=BTreeSet::new();let mut eligible=BTreeSet::new();
    for row in a(&parsed["statements"]) {
        shape(row,&["statement_id","dimensions"],"ANSWER_REVIEW_STATEMENT_SHAPE")?;
        let id=s(&row["statement_id"]);need(row["statement_id"].is_string()&&statements.contains_key(id)&&seen.insert(id.to_owned()),"ANSWER_REVIEW_STATEMENT_UNKNOWN_OR_DUPLICATE")?;
        shape(&row["dimensions"],&DIMS,"ANSWER_REVIEW_DIMENSIONS_INCOMPLETE")?;let own=set(&statements[id]["evidence_ids"]);let mut supported=true;
        for dimension in DIMS {let v=&row["dimensions"][dimension];shape(v,&["decision","reason","evidence_ids"],"ANSWER_REVIEW_DIMENSION_SHAPE")?;need(DECISIONS.contains(&s(&v["decision"]))&&text(&v["reason"],4000),"ANSWER_REVIEW_DECISION_INVALID")?;refs(&v["evidence_ids"],&menu,false)?;if v["decision"]=="SUPPORTED" {refs(&v["evidence_ids"],&own,true)?;}else{supported=false;}}
        if supported{eligible.insert(id.to_owned());}
    }
    let requirement_ids=set(&prepared["manifest"]["requirement_ids"]);let mut seen_req=BTreeSet::new();
    for row in a(&parsed["requirements"]) {coverage(row,true,&statements,&eligible,&menu)?;need(row["requirement_id"].is_string()&&requirement_ids.contains(s(&row["requirement_id"]))&&seen_req.insert(s(&row["requirement_id"]).to_owned()),"ANSWER_REVIEW_REQUIREMENT_UNKNOWN_OR_DUPLICATE")?;}
    coverage(&parsed["question"],false,&statements,&eligible,&menu)?;let all_covered=a(&parsed["requirements"]).iter().all(|r|r["decision"]=="COVERED");
    if parsed["question"]["decision"]=="COVERED" {need(all_covered,"ANSWER_REVIEW_COMPOUND_COVERAGE_INCOMPLETE")?;}
    let kept:Vec<Value>=a(&draft["statements"]).iter().filter(|r|eligible.contains(s(&r["statement_id"]))).cloned().collect();let quarantined:Vec<Value>=a(&draft["statements"]).iter().filter(|r|!eligible.contains(s(&r["statement_id"]))).map(|r|r["statement_id"].clone()).collect();
    Ok(json!({"review_output":parsed,"review_output_sha256":raw_sha,"eligible_statements":kept,"quarantined_statement_ids":quarantined,"fully_covered":parsed["question"]["decision"]=="COVERED"&&all_covered,"semantic_truth_certified":false}))
}
fn finish(p:&Value)->Result<Value> {
    let prepared=&p["prepared"];let draft=&p["draft"];let review=&p["review"];
    need(text(&p["answer_id"],96)&&s(&p["answer_id"]).bytes().enumerate().all(|(i,c)|c.is_ascii_alphanumeric()||(i>0&&(c==b'_'||c==b'-'))),"ANSWER_ARTIFACT_LOCATION_INVALID")?;
    need(p["source_invalid"].is_boolean()&&p["errors"].is_array(),"ANSWER_FINAL_STATE_INVALID")?;
    for e in a(&p["errors"]) {shape(e,&["stage","code"],"ANSWER_FINAL_STATE_INVALID")?;need(text(&e["stage"],4000)&&text(&e["code"],4000),"ANSWER_FINAL_STATE_INVALID")?;}
    if !draft.is_null(){validate_draft(prepared,draft)?;}
    if !review.is_null() {
        need(!draft.is_null(),"ANSWER_REVIEW_WITHOUT_DRAFT")?;validate_review_prepared(prepared,draft,&p["review_prepared"])?;
        need(digest(&review["review_output_sha256"]),"ANSWER_REVIEW_BINDING_CHANGED")?;
        let checked=review_value(prepared,draft,&review["review_output"],s(&review["review_output_sha256"]))?;need(*review==checked,"ANSWER_REVIEW_BINDING_CHANGED")?;
    }
    let invalid=p["source_invalid"]==true;let supported=!invalid&&!a(&review["eligible_statements"]).is_empty();let full=supported&&review["fully_covered"]==true&&draft["answer_status"]=="ANSWERED";
    let menu=&prepared["source_evidence_menu"];let evidence_index=if invalid{json!({})}else{Value::Object(a(menu).iter().map(|f|(s(&f["evidence_id"]).to_owned(),f.clone())).collect())};
    Ok(json!({"contract_version":VERSION,"answer_id":p["answer_id"],"question":prepared["question"],"status":if invalid{"SOURCE_INVALIDATED"}else if supported{if full{"ANSWERED"}else{"PARTIAL"}}else{"EXTRACTIVE_FALLBACK"},"answer_status":if invalid||!supported{"UNKNOWN"}else if full{"ANSWERED"}else{"PARTIAL"},"basis":if a(menu).is_empty(){"NONE"}else{"DOCUMENT"},"coverage_scope":"RETRIEVED_SOURCE_FRAGMENTS_ONLY","source_exhaustiveness_certified":false,"statements":if supported{review["eligible_statements"].clone()}else{json!([])},"excerpts":if !invalid&&!supported{menu.clone()}else{json!([])},"evidence_index":evidence_index,"snapshot":prepared["evidence_set"]["snapshot"],"requirement_coverage":if !review.is_null()&&!invalid{review["review_output"]["requirements"].clone()}else{json!([])},"gaps":if !review.is_null()&&!invalid{review["review_output"]["gaps"].clone()}else{json!(["仅返回当前检索片段，未生成可经独立审核的完整回答；不表示整篇资料没有依据。"])},"errors":p["errors"],"verification":{"verdict":if invalid{"SOURCE_INVALIDATED"}else if supported{"INDEPENDENT_REVIEW_SUPPORTED"}else{"EXTRACTS_ONLY_NOT_SYNTHESIZED"},"semantic_truth_certified":false,"source_validator":"RUST_P1_EVIDENCE_COMPOSE","reviewed":!review.is_null()},"streaming":{"transport":"BUFFERED_COMPLETE","native_token_stream":false,"answer_blocks":"AFTER_INDEPENDENT_REVIEW_ONLY"},"learning_state":{"status":"NOT_REQUESTED","task_ref":null},"publication_performed":false}))
}
pub fn execute(op:&str,p:&Value)->Result<Value> {
    let keys:&[&str]=match op {"plan"=>&["prepared","context"],"draft"=>&["prepared","context","raw"],"review"=>&["prepared","context","draft","review_prepared","raw"],"final"=>&["prepared","context","answer_id","draft","review_prepared","review","errors","source_invalid"],_=>return Err(error("ANSWER_SOURCE_OPERATION_UNKNOWN","ANSWER_SOURCE_OPERATION_UNKNOWN"))};
    shape(p,keys,"ANSWER_SOURCE_PAYLOAD_INVALID")?;validate_prepared(&p["prepared"],&p["context"])?;
    match op {
        "plan"=>Ok(json!({"kernel_version":KERNEL_VERSION,"allow_generation":!a(&p["prepared"]["source_evidence_menu"]).is_empty(),"max_calls":2,"repair_calls":0,"retry_calls":0,"preflight_errors":if a(&p["prepared"]["source_evidence_menu"]).is_empty(){json!([{"stage":"PREFLIGHT","code":"NO_RETRIEVED_SOURCE_FRAGMENTS"}])}else{json!([])}})),
        "draft"=>{need(p["raw"].is_string(),"ANSWER_OUTPUT_INVALID")?;let boundary=crate::model_json_boundary::parse(s(&p["raw"]))?;draft_value(&p["prepared"],&boundary["parsed"],&text_sha(s(&p["raw"])))},
        "review"=>{validate_draft(&p["prepared"],&p["draft"])?;validate_review_prepared(&p["prepared"],&p["draft"],&p["review_prepared"])?;need(p["raw"].is_string(),"ANSWER_REVIEW_SHAPE_INVALID")?;let boundary=crate::model_json_boundary::parse(s(&p["raw"]))?;review_value(&p["prepared"],&p["draft"],&boundary["parsed"],&text_sha(s(&p["raw"])))},
        "final"=>finish(p),_=>unreachable!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn prepared() -> Value { json!({"source_evidence_menu":[{"evidence_id":"own"},{"evidence_id":"context_only"}],"manifest":{"requirement_ids":["r_a","r_b"]}}) }
    fn draft() -> Value { draft_value(&prepared(),&json!({"answer_status":"ANSWERED","statements":[{"text":"Authored Cedar statement.","evidence_ids":["own"]}],"gaps":[]}),&text_sha("synthetic")).unwrap() }
    fn review() -> Value {
        let dimensions=Value::Object(DIMS.iter().map(|k|(k.to_string(),json!({"decision":"SUPPORTED","reason":"Authored synthetic assessment.","evidence_ids":["own"]}))).collect());
        let coverage=json!({"decision":"COVERED","reason":"Authored complete two-part assessment.","statement_ids":["statement_001"],"evidence_ids":["own"]});
        let mut first=coverage.clone();first["requirement_id"]=json!("r_a");let mut second=coverage.clone();second["requirement_id"]=json!("r_b");
        json!({"statements":[{"statement_id":"statement_001","dimensions":dimensions}],"requirements":[first,second],"question":coverage,"gaps":[]})
    }
    #[test]
    fn source_answer_statement_ids_and_utf16_resource_limits() {
        let d=draft();assert_eq!(d["statements"][0]["statement_id"],"statement_001");
        let mut raw=json!({"answer_status":"ANSWERED","statements":[{"text":"😀".repeat(2000),"evidence_ids":["own"]}],"gaps":[]});
        assert!(draft_value(&prepared(),&raw,"synthetic").is_ok());raw["statements"][0]["text"]=json!("😀".repeat(2001));
        assert_eq!(draft_value(&prepared(),&raw,"synthetic").unwrap_err().code,"ANSWER_STATEMENT_INVALID");
        let mut changed=d;changed["statements"][0]["statement_id"]=json!("statement_999");assert!(validate_draft(&prepared(),&changed).is_err());
    }
    #[test]
    fn source_answer_all_nine_dimensions_and_own_support_required() {
        for dimension in DIMS {
            let mut r=review();r["statements"][0]["dimensions"][dimension]["decision"]=json!("UNKNOWN");
            r["question"]["decision"]=json!("PARTIAL");for row in r["requirements"].as_array_mut().unwrap(){row["decision"]=json!("PARTIAL");}
            let out=review_value(&prepared(),&draft(),&r,"synthetic").unwrap();assert!(a(&out["eligible_statements"]).is_empty());assert_eq!(out["fully_covered"],false);
            let mut r=review();r["statements"][0]["dimensions"][dimension]["evidence_ids"]=json!(["context_only"]);assert!(review_value(&prepared(),&draft(),&r,"synthetic").is_err());
        }
    }
    #[test]
    fn source_answer_compound_coverage_cannot_hide_partial_requirement() {
        let mut r=review();r["requirements"][1]["decision"]=json!("PARTIAL");
        assert_eq!(review_value(&prepared(),&draft(),&r,"synthetic").unwrap_err().code,"ANSWER_REVIEW_COMPOUND_COVERAGE_INCOMPLETE");
        r["question"]["decision"]=json!("PARTIAL");assert_eq!(review_value(&prepared(),&draft(),&r,"synthetic").unwrap()["fully_covered"],false);
        r["requirements"].as_array_mut().unwrap().pop();assert_eq!(review_value(&prepared(),&draft(),&r,"synthetic").unwrap_err().code,"ANSWER_REVIEW_SET_INCOMPLETE");
    }
    #[test]
    fn source_answer_unknown_ids_duplicate_sets_and_approval_fields_reject() {
        let mut r=review();r["requirements"][1]["requirement_id"]=json!("r_a");assert!(review_value(&prepared(),&draft(),&r,"synthetic").is_err());
        let mut r=review();r["statements"][0]["statement_id"]=json!("invented");assert!(review_value(&prepared(),&draft(),&r,"synthetic").is_err());
        let mut r=review();r["approved"]=json!(true);assert_eq!(review_value(&prepared(),&draft(),&r,"synthetic").unwrap_err().code,"ANSWER_REVIEW_SHAPE_INVALID");
    }
}
