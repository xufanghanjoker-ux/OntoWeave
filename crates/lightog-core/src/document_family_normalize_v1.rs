//! Whole-menu family normalization. This binds model proposals and their
//! provenance; it never certifies semantic equivalence or silently fixes anchors.
use crate::common::{a, canonical_hash as hash, error, js_stringify, len, nonempty, s, slice16, text_sha, Result};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const VERSION: &str = "lightog-document-family-normalize/0.4";
pub const SUBJECT_LOCATOR: &str = "EXACT_SOURCE_MENTION_WITNESS_UTF16/0.1";
pub const WITNESS_RULE: &str = "FIRST_REGISTERED_EXACT_SOURCE_MENTION";
const MAX_PROPOSALS: usize = 256;
const MAX_REVIEW_UTF16: usize = 64000;
const MAX_WITNESS_PROOF_ROWS: usize = 65536;
fn need(ok: bool, code: &str) -> Result<()> { if ok {Ok(())} else {Err(error(code,code))} }
fn shape(v: &Value, keys: &[&str]) -> Result<()> {
    need(v.as_object().is_some_and(|m|m.len()==keys.len() && keys.iter().all(|k|m.contains_key(*k))),"FAMILY_NORMALIZE_SHAPE_INVALID")
}
fn text(v: &Value, max: usize) -> bool {nonempty(v) && len(s(v))<=max}
fn array(v: &Value, max: usize) -> Result<&[Value]> {
    need(v.is_array() && a(v).len()<=max,"FAMILY_NORMALIZE_REVIEW_RESOURCE_LIMIT")?; Ok(a(v))
}
fn raw(v: &Value) -> Result<Value> {
    if v.is_string() {Ok(crate::model_json_boundary::parse(s(v))?["parsed"].clone())} else {Ok(v.clone())}
}
fn refs(v: &Value, max: usize, required: bool) -> Result<BTreeSet<String>> {
    let mut seen=BTreeSet::new();
    for value in array(v,max)? {
        need(text(value,160) && seen.insert(s(value).to_owned()),"FAMILY_NORMALIZE_REFERENCE_INVALID")?;
    }
    need(!required || !seen.is_empty(),"FAMILY_NORMALIZE_REFERENCE_REQUIRED")?; Ok(seen)
}
// Syntax only: initial proposals may name a wrong evidence ID or an absent
// surface. Those errors must reach the normalization model, unchanged.
fn proposal_family(f: &Value) -> Result<()> {
    shape(f,&["key","label","question","target","operation","conditions","evidence_ids","subjects"])?;
    need(text(&f["key"],128) && text(&f["label"],256) && text(&f["question"],4096) && text(&f["target"],2000),"FAMILY_NORMALIZE_PROPOSAL_INVALID")?;
    need(matches!(s(&f["operation"]),"LOOKUP"|"COMPARE"|"EXPLAIN"|"LIST"|"AGGREGATE"|"CONDITIONAL"),"FAMILY_NORMALIZE_OPERATION_INVALID")?;
    refs(&f["evidence_ids"],128,true)?;
    for c in array(&f["conditions"],32)? {
        shape(c,&["text","evidence_ids"])?;
        need(text(&c["text"],2000),"FAMILY_NORMALIZE_CONDITION_INVALID")?;
        refs(&c["evidence_ids"],128,true)?;
    }
    let subjects=array(&f["subjects"],128)?;
    need(!subjects.is_empty(),"FAMILY_NORMALIZE_SUBJECT_REQUIRED")?;
    for subject in subjects {
        shape(subject,&["surface","evidence_id","occurrence","rationale"])?;
        need(text(&subject["surface"],256) && text(&subject["evidence_id"],160) && text(&subject["rationale"],2000),"FAMILY_NORMALIZE_SUBJECT_INVALID")?;
        need(subject["occurrence"].as_u64().is_some_and(|n|n<10000),"FAMILY_NORMALIZE_OCCURRENCE_INVALID")?;
    }
    Ok(())
}
fn schema() -> Value {
    let txt=|n|json!({"type":"string","minLength":1,"maxLength":n});
    let refs=json!({"type":"array","minItems":1,"maxItems":128,"uniqueItems":true,"items":txt(160)});
    json!({"type":"object","additionalProperties":false,"required":["families","unresolved"],"properties":{
        "families":{"type":"array","maxItems":32,"items":{"type":"object","additionalProperties":false,"required":["key","label","question","target","operation","conditions","evidence_ids","subjects","origin_proposal_ids","normalization_rationale"],"properties":{
            "key":txt(128),"label":txt(256),"question":txt(4096),"target":txt(2000),"operation":{"enum":["LOOKUP","COMPARE","EXPLAIN","LIST","AGGREGATE","CONDITIONAL"]},
            "conditions":{"type":"array","maxItems":32,"items":{"type":"object","additionalProperties":false,"required":["text","evidence_ids"],"properties":{"text":txt(2000),"evidence_ids":refs}}},
            "evidence_ids":refs,"subjects":{"type":"array","minItems":1,"maxItems":128,"items":{"type":"object","additionalProperties":false,"required":["surface","source_ref","rationale"],"properties":{"surface":txt(256),"source_ref":txt(160),"rationale":txt(2000)}}},
            "origin_proposal_ids":{"type":"array","minItems":1,"maxItems":MAX_PROPOSALS,"uniqueItems":true,"items":txt(160)},"normalization_rationale":txt(8000)
        }}},
        "unresolved":{"type":"array","maxItems":MAX_PROPOSALS,"items":{"type":"object","additionalProperties":false,"required":["proposal_id","reason"],"properties":{"proposal_id":txt(160),"reason":txt(8000)}}}
    }})
}

fn registered_source_texts(original: &Value) -> Result<Vec<Value>> {
    let mut rows=vec![];let mut seen=BTreeSet::new();
    for source in a(&original["snapshot"]["sources"]) {
        need(text(&source["source_ref"],160) && seen.insert(s(&source["source_ref"]).to_owned()),"FAMILY_NORMALIZE_SOURCE_REF_AMBIGUOUS")?;
        let found:Vec<&Value>=a(&original["input"]["context"]["source_texts"]).iter().filter(|row|row["source_ref"]==source["source_ref"] && row["source_revision"]==source["source_revision"]).collect();
        need(found.len()==1 && found[0]["text"].is_string(),"FAMILY_NORMALIZE_SOURCE_TEXT_REQUIRED")?;
        let full=&found[0]["text"];
        need(source["text_sha256"]==text_sha(s(full)),"FAMILY_NORMALIZE_SOURCE_TEXT_CHANGED")?;
        rows.push(json!({"source_ref":source["source_ref"],"source_revision":source["source_revision"],"text_sha256":source["text_sha256"],"text_utf16":len(s(full)),"text":full}));
    }
    need(!rows.is_empty(),"FAMILY_NORMALIZE_SOURCE_TEXT_REQUIRED")?;Ok(rows)
}

fn occurrences(text: &str,surface: &str) -> Vec<usize> {
    let mut found=vec![];let mut offset=0;
    for (byte,scalar) in text.char_indices() {
        if text[byte..].starts_with(surface) {found.push(offset);}
        offset+=scalar.len_utf16();
    }
    found
}

// Exact text presence is only a source-mention witness, never a resolution of
// repeated names or semantic applicability. The program retains every exact
// candidate, then chooses the first fully registered witness deterministically.
fn bind_subject(prepared: &Value,family_key: &Value,subject_index: usize,subject: &Value,proof_remaining: usize) -> Result<(Value,Value)> {
    shape(subject,&["surface","source_ref","rationale"])?;
    need(text(&subject["surface"],256) && text(&subject["source_ref"],160) && text(&subject["rationale"],2000),"FAMILY_NORMALIZE_SUBJECT_INVALID")?;
    let source=a(&prepared["source_text_menu"]).iter().find(|row|row["source_ref"]==subject["source_ref"]).ok_or_else(||error("FAMILY_NORMALIZE_SOURCE_UNKNOWN","FAMILY_NORMALIZE_SOURCE_UNKNOWN"))?;
    let surface=s(&subject["surface"]);
    let matches=occurrences(s(&source["text"]),surface);
    need(!matches.is_empty(),"FAMILY_NORMALIZE_SUBJECT_NOT_FOUND")?;
    need(matches.len()<=proof_remaining,"FAMILY_NORMALIZE_REVIEW_RESOURCE_LIMIT")?;
    let mut proof_rows=matches.len();let mut mention_candidates=vec![];let mut chosen=Value::Null;
    for (occurrence,start) in matches.iter().copied().enumerate() {
        let end=start+len(surface);let span=json!({"start":start,"end":end,"quote":surface,"offset_unit":"utf16_code_unit"});
        let mut registered=vec![];
        for fragment in a(&prepared["source_evidence_menu"]).iter().filter(|row|row["source_ref"]==source["source_ref"] && row["source_revision"]==source["source_revision"] && row["span"]["start"].as_u64().is_some_and(|at|at<=start as u64) && row["span"]["end"].as_u64().is_some_and(|at|at>=end as u64)) {
            proof_rows+=1;need(proof_rows<=proof_remaining,"FAMILY_NORMALIZE_REVIEW_RESOURCE_LIMIT")?;
            let relative=start-fragment["span"]["start"].as_u64().unwrap() as usize;
            need(slice16(s(&fragment["span"]["quote"]),relative,relative+len(surface))==surface,"FAMILY_NORMALIZE_SUBJECT_FRAGMENT_CHANGED")?;
            let local=occurrences(s(&fragment["span"]["quote"]),surface).iter().position(|at|*at==relative).ok_or_else(||error("FAMILY_NORMALIZE_SUBJECT_FRAGMENT_CHANGED","FAMILY_NORMALIZE_SUBJECT_FRAGMENT_CHANGED"))?;
            need(local<10000,"FAMILY_NORMALIZE_OCCURRENCE_INVALID")?;
            let witness=json!({"evidence_id":fragment["evidence_id"],"fragment_occurrence":local,"fragment_span":fragment["span"]});
            if chosen.is_null() {chosen=json!({"occurrence":occurrence,"span":span,"evidence_id":fragment["evidence_id"],"fragment_occurrence":local,"fragment_span":fragment["span"]});}
            registered.push(witness);
        }
        mention_candidates.push(json!({"occurrence":occurrence,"span":span,"registered_fragments":registered}));
    }
    need(!chosen.is_null(),"FAMILY_NORMALIZE_SUBJECT_FRAGMENT_UNAVAILABLE")?;
    let converted=json!({"surface":subject["surface"],"evidence_id":chosen["evidence_id"],"occurrence":chosen["fragment_occurrence"],"rationale":subject["rationale"]});
    let binding=json!({"family_key":family_key,"subject_index":subject_index,"request":subject,"source_revision":source["source_revision"],"source_text_sha256":source["text_sha256"],"witness_rule":WITNESS_RULE,"selection_role":"SOURCE_MENTION_WITNESS_ONLY","mention_candidates":mention_candidates,"multiple_mentions":matches.len()>1,"chosen":chosen,"span":chosen["span"],"evidence_id":chosen["evidence_id"],"fragment_span":chosen["fragment_span"],"fragment_occurrence":chosen["fragment_occurrence"],"proof_rows":proof_rows,"identity_status":"SOURCE_MENTION_UNRESOLVED","identity_resolution_performed":false,"semantic_applicability_certified":false,"entity_ref":null,"locator_contract":SUBJECT_LOCATOR});
    Ok((converted,binding))
}

pub fn prepare(p: &Value) -> Result<Value> {
    shape(p,&["prepared_discovery","responses"])?;
    let original=&p["prepared_discovery"];
    need(*original==crate::document_scope_v1::prepare(&original["input"])? ,"FAMILY_NORMALIZE_DISCOVERY_PREPARED_CHANGED")?;
    // Regroup the same lossless fragments only. Fine evidence IDs do not depend
    // on grouping. This version rejects a menu too large for one global review.
    let mut global_input=original["input"].clone();
    global_input["max_batch_utf16"]=json!(24000);
    global_input["max_fragments_per_batch"]=json!(128);
    let normalized_prepared=crate::document_scope_v1::prepare(&global_input)?;
    need(normalized_prepared["batch_count"]==1,"FAMILY_NORMALIZE_REVIEW_RESOURCE_LIMIT")?;
    let original_menu: Vec<Value>=a(&original["batches"]).iter().flat_map(|b|a(&b["source_evidence_menu"]).iter().cloned()).collect();
    let global_menu=&normalized_prepared["batches"][0]["source_evidence_menu"];
    need(original_menu==a(global_menu),"FAMILY_NORMALIZE_SOURCE_MENU_CHANGED")?;
    let rows=array(&p["responses"],a(&original["batches"]).len())?;
    let mut returned=BTreeMap::<String,Value>::new();
    for row in rows {
        shape(row,&["batch_id","raw"])?;
        need(a(&original["batches"]).iter().any(|b|b["batch_id"]==row["batch_id"]),"FAMILY_NORMALIZE_DISCOVERY_BATCH_UNKNOWN")?;
        need(returned.insert(s(&row["batch_id"]).to_owned(),row["raw"].clone()).is_none(),"FAMILY_NORMALIZE_DISCOVERY_BATCH_DUPLICATE")?;
    }
    need(returned.len()==a(&original["batches"]).len(),"FAMILY_NORMALIZE_DISCOVERY_INCOMPLETE")?;
    let mut proposals=vec![]; let mut unknowns=vec![];
    for batch in a(&original["batches"]) {
        let response=raw(&returned[s(&batch["batch_id"])])?;
        shape(&response,&["families","unknowns"])?;
        let mut keys=BTreeSet::new();
        for (i,family) in array(&response["families"],32)?.iter().enumerate() {
            proposal_family(family)?;
            need(keys.insert(s(&family["key"]).to_owned()),"FAMILY_NORMALIZE_PROPOSAL_KEY_DUPLICATE")?;
            let binding=json!({"batch_id":batch["batch_id"],"family_index":i,"raw_family":family});
            proposals.push(json!({"proposal_id":format!("family_proposal_{}",&hash(&binding)[..32]),"batch_id":batch["batch_id"],"family_index":i,"family_sha256":hash(family),"raw_family":family}));
            need(proposals.len()<=MAX_PROPOSALS,"FAMILY_NORMALIZE_REVIEW_RESOURCE_LIMIT")?;
        }
        for (i,u) in array(&response["unknowns"],64)?.iter().enumerate() {
            need(text(u,4000),"FAMILY_NORMALIZE_UNKNOWN_INVALID")?;
            unknowns.push(json!({"batch_id":batch["batch_id"],"unknown_index":i,"reason":u}));
        }
    }
    // Existing scope unknowns are preserved verbatim. Its public contract has
    // 64 slots; refusing excess avoids a hidden loss at the adapter boundary.
    need(unknowns.len()<=64,"FAMILY_NORMALIZE_REVIEW_RESOURCE_LIMIT")?;
    let source_text_menu=registered_source_texts(original)?;
    let review=json!({"source_evidence_menu":global_menu,"source_text_menu":source_text_menu,"proposal_manifest":proposals,"original_unknowns":unknowns,"user_cqs":original["input"]["user_cqs"],"definitions":original["input"]["definitions"]});
    let review_units=len(&js_stringify(&review));
    need(review_units<=MAX_REVIEW_UTF16,"FAMILY_NORMALIZE_REVIEW_RESOURCE_LIMIT")?;
    // The provider sees the same finite identifier domain that the local
    // validator enforces. Long hashes are selected, not freely transcribed.
    // This prevents unknown reference spellings without guessing or repairing
    // any returned ID or certifying that a chosen reference supports a claim.
    let evidence_ids:Vec<Value>=a(global_menu).iter().map(|e|e["evidence_id"].clone()).collect();
    let proposal_ids:Vec<Value>=proposals.iter().map(|p|p["proposal_id"].clone()).collect();
    let source_refs:Vec<Value>=source_text_menu.iter().map(|source|source["source_ref"].clone()).collect();
    let mut output_schema=schema();
    let family=&mut output_schema["properties"]["families"]["items"]["properties"];
    family["evidence_ids"]["items"]["enum"]=json!(evidence_ids);
    family["conditions"]["items"]["properties"]["evidence_ids"]["items"]["enum"]=json!(evidence_ids);
    family["subjects"]["items"]["properties"]["source_ref"]["enum"]=json!(source_refs);
    if !proposal_ids.is_empty(){
        family["origin_proposal_ids"]["items"]["enum"]=json!(proposal_ids);
        output_schema["properties"]["unresolved"]["items"]["properties"]["proposal_id"]["enum"]=json!(proposal_ids);
    }else{
        output_schema["properties"]["families"]["maxItems"]=json!(0);
        output_schema["properties"]["unresolved"]["maxItems"]=json!(0);
    }
    let mut out=json!({"contract_version":VERSION,"subject_locator_contract":SUBJECT_LOCATOR,"input":p,"snapshot":original["snapshot"],"origin_discovery_prepared_sha256":hash(original),"origin_discovery_responses_sha256":hash(&p["responses"]),"normalized_prepared":normalized_prepared,"source_evidence_menu":global_menu,"source_menu_sha256":hash(global_menu),"source_text_menu":source_text_menu,"source_text_menu_sha256":hash(&json!(source_text_menu)),"proposal_manifest":proposals,"proposal_manifest_sha256":hash(&json!(proposals)),"original_unknowns":unknowns,"review_input_utf16":review_units,"omitted_proposals":0,"omitted_fragments":0,"truncated":false,"output_schema":output_schema,"semantic_faithfulness_certified":false,"semantic_support_certified":false,"coverage_complete":false,"model_called":false});
    out["prepared_sha256"]=json!(hash(&out)); Ok(out)
}

pub fn materialize(p: &Value) -> Result<Value> {
    shape(p,&["prepared","raw"])?;
    let prepared=&p["prepared"];
    need(*prepared==prepare(&prepared["input"])? ,"FAMILY_NORMALIZE_PREPARED_CHANGED")?;
    let output=raw(&p["raw"])?;
    shape(&output,&["families","unresolved"])?;
    let proposals: BTreeMap<String,Value>=a(&prepared["proposal_manifest"]).iter().map(|r|(s(&r["proposal_id"]).to_owned(),r.clone())).collect();
    let mut assignments=BTreeMap::<String,Vec<Value>>::new();
    let mut unresolved=BTreeMap::<String,Value>::new();
    let mut families=vec![]; let mut keys=BTreeSet::new();let mut subject_bindings=vec![];let mut witness_proof_rows=0;
    for f in array(&output["families"],32)? {
        shape(f,&["key","label","question","target","operation","conditions","evidence_ids","subjects","origin_proposal_ids","normalization_rationale"])?;
        need(text(&f["normalization_rationale"],8000),"FAMILY_NORMALIZE_RATIONALE_REQUIRED")?;
        let origin_ids=refs(&f["origin_proposal_ids"],MAX_PROPOSALS,true)?;
        need(origin_ids.iter().all(|id|proposals.contains_key(id)),"FAMILY_NORMALIZE_PROPOSAL_UNKNOWN")?;
        need(keys.insert(s(&f["key"]).to_owned()),"FAMILY_NORMALIZE_FAMILY_KEY_DUPLICATE")?;
        let mut normalized=f.clone();
        normalized.as_object_mut().unwrap().remove("origin_proposal_ids");
        normalized.as_object_mut().unwrap().remove("normalization_rationale");
        let requests=array(&f["subjects"],128)?;
        need(!requests.is_empty(),"FAMILY_NORMALIZE_SUBJECT_REQUIRED")?;
        let mut subjects=vec![];
        for (index,request) in requests.iter().enumerate() {
            let (converted,binding)=bind_subject(prepared,&f["key"],index,request,MAX_WITNESS_PROOF_ROWS-witness_proof_rows).map_err(|mut failure|{
                failure.details=Some(json!({"family_key":f["key"],"subject_index":index,"request":request,"locator_contract":SUBJECT_LOCATOR,"scope_build_held":true}));failure
            })?;
            witness_proof_rows+=binding["proof_rows"].as_u64().unwrap() as usize;
            subjects.push(converted);subject_bindings.push(binding);
        }
        normalized["subjects"]=json!(subjects);
        proposal_family(&normalized)?;
        for id in origin_ids {
            assignments.entry(id).or_default().push(json!({"family_key":f["key"],"family_sha256":hash(&normalized),"normalization_rationale":f["normalization_rationale"]}));
        }
        families.push(normalized);
    }
    for u in array(&output["unresolved"],MAX_PROPOSALS)? {
        shape(u,&["proposal_id","reason"])?;
        need(proposals.contains_key(s(&u["proposal_id"])),"FAMILY_NORMALIZE_PROPOSAL_UNKNOWN")?;
        need(text(&u["reason"],8000),"FAMILY_NORMALIZE_UNRESOLVED_REASON_REQUIRED")?;
        need(unresolved.insert(s(&u["proposal_id"]).to_owned(),u["reason"].clone()).is_none(),"FAMILY_NORMALIZE_UNRESOLVED_DUPLICATE")?;
    }
    need(proposals.keys().all(|id|assignments.contains_key(id)||unresolved.contains_key(id)),"FAMILY_NORMALIZE_PROPOSAL_UNACCOUNTED")?;
    let normalized_responses=json!([{"batch_id":prepared["normalized_prepared"]["batches"][0]["batch_id"],"raw":{"families":families,"unknowns":a(&prepared["original_unknowns"]).iter().map(|u|u["reason"].clone()).collect::<Vec<_>>()}}]);
    // Existing core alone resolves final mentions and seals the plan. Bad
    // normalized anchors cannot be hidden behind the provenance mapping.
    let plan=crate::document_scope_v1::materialize(&json!({"prepared":prepared["normalized_prepared"],"responses":normalized_responses}))?;
    crate::document_scope_v1::execute("validate_plan",&json!({"prepared":prepared["normalized_prepared"],"responses":normalized_responses,"plan":plan,"current_snapshot":prepared["snapshot"]}))?;
    let ready=unresolved.is_empty() && !a(&plan["tasks"]).is_empty() && plan["status"]=="SCOPE_PROPOSED" && plan["all_batches_returned"]==true && plan["all_source_text_in_menu"]==true;
    let mut family_ids=BTreeMap::new();
    for family in a(&normalized_responses[0]["raw"]["families"]) {
        let canonical=a(&plan["families"]).iter().find(|f|f["question"]==family["question"] && f["target"]==family["target"] && f["operation"]==family["operation"] && a(&f["conditions"]).iter().map(|c|c["text"].clone()).collect::<Vec<_>>()==a(&family["conditions"]).iter().map(|c|c["text"].clone()).collect::<Vec<_>>()).ok_or_else(||error("FAMILY_NORMALIZE_PLAN_MAPPING_INVALID","FAMILY_NORMALIZE_PLAN_MAPPING_INVALID"))?;
        family_ids.insert(hash(family),canonical["id"].clone());
    }
    let mapping: Vec<Value>=proposals.iter().map(|(id,proposal)|{
        let mapped: Vec<Value>=assignments.get(id).cloned().unwrap_or_default().into_iter().map(|mut row|{row["family_id"]=family_ids[s(&row["family_sha256"])].clone();row}).collect();
        json!({"proposal_id":id,"origin_batch_id":proposal["batch_id"],"origin_family_index":proposal["family_index"],"origin_family_sha256":proposal["family_sha256"],"normalized_families":mapped,"unresolved_reason":unresolved.get(id).cloned().unwrap_or(Value::Null)})
    }).collect();
    let mut receipt=json!({"contract_version":VERSION,"subject_locator_contract":SUBJECT_LOCATOR,"status":if ready{"SCOPE_NORMALIZED"}else if !unresolved.is_empty() || plan["status"]=="PARTIAL_SCOPE"{"PARTIAL_SCOPE"}else{"NO_SCOPE_DISCOVERED"},"snapshot":prepared["snapshot"],"prepared_sha256":prepared["prepared_sha256"],"origin_discovery_prepared_sha256":prepared["origin_discovery_prepared_sha256"],"origin_discovery_responses_sha256":prepared["origin_discovery_responses_sha256"],"origin_discovery_responses":prepared["input"]["responses"],"proposal_manifest_sha256":prepared["proposal_manifest_sha256"],"source_menu_sha256":prepared["source_menu_sha256"],"source_text_menu_sha256":prepared["source_text_menu_sha256"],"raw_response":p["raw"],"raw_sha256":hash(&p["raw"]),"parsed_output_sha256":hash(&output),"subject_bindings":subject_bindings,"subject_bindings_sha256":hash(&json!(subject_bindings)),"subject_bindings_complete":true,"mapping":mapping,"mapping_sha256":hash(&json!(mapping)),"unresolved":output["unresolved"],"original_unknowns":prepared["original_unknowns"],"normalized_prepared":prepared["normalized_prepared"],"normalized_responses":normalized_responses,"normalized_plan":if ready{plan.clone()}else{Value::Null},"partial_plan":if ready{Value::Null}else{plan.clone()},"plan_id":plan["plan_id"],"plan_sha256":hash(&plan),"all_proposals_accounted":true,"ready_for_scope_build":ready,"omitted_proposals":0,"omitted_fragments":0,"truncated":false,"semantic_faithfulness_certified":false,"semantic_support_certified":false,"coverage_complete":false,"publication_performed":false});
    receipt["receipt_hash"]=json!(hash(&receipt)); Ok(receipt)
}

pub fn execute(op: &str,p: &Value) -> Result<Value> {
    match op {
        "prepare"=>prepare(p),"materialize"=>materialize(p),
        "validate_receipt"=>{
            shape(p,&["prepared","raw","receipt","current_snapshot"])?;
            let actual=materialize(&json!({"prepared":p["prepared"],"raw":p["raw"]}))?;
            need(actual==p["receipt"],"FAMILY_NORMALIZE_RECEIPT_CHANGED")?;
            let source=&actual["snapshot"]; let current=&p["current_snapshot"];
            need(source["base_ref"]==current["base_ref"] && source["source_epoch"]==current["source_epoch"] && source["sources"]==current["sources"],"FAMILY_NORMALIZE_SOURCE_STALE")?;
            Ok(json!({"validated":true,"receipt_hash":actual["receipt_hash"],"plan_id":actual["plan_id"],"ready_for_scope_build":actual["ready_for_scope_build"],"all_proposals_accounted":true,"semantic_faithfulness_certified":false,"semantic_support_certified":false,"coverage_complete":false}))
        },
        _=>Err(error("FAMILY_NORMALIZE_OPERATION_UNKNOWN",op))
    }
}
