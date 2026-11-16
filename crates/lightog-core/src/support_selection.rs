//! Explicit model-selected support roles. Roles are selections, not entailment
//! certificates. Registry anchors never silently become fact support.
use crate::common::{a, canonical_hash as hash, error, s, Result};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
pub const VERSION: &str = "lightog-support-selection/0.1";
pub const OCCURRENCE_VERSION: &str = "lightog-support-selection/0.2";
pub const LOCAL_REQUIRED_OCCURRENCE_VERSION: &str = "lightog-required-mention-occurrence/0.2";
pub const REQUIRED_OCCURRENCE_VERSION: &str = "lightog-required-mention-occurrence/0.1";
pub const ROLES: [&str; 4] = ["assertion", "subject_scope", "antecedent", "condition"];
fn need(ok: bool, code: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(error(code, code))
    }
}
fn ids(v: &Value, nonempty: bool) -> Result<BTreeSet<String>> {
    let rows = v
        .as_array()
        .ok_or_else(|| error("SUPPORT_ROLE_IDS_INVALID", "SUPPORT_ROLE_IDS_INVALID"))?;
    need(
        rows.len() <= 128 && (!nonempty || !rows.is_empty()),
        "SUPPORT_ROLE_IDS_INVALID",
    )?;
    let mut out = BTreeSet::new();
    for x in rows {
        need(
            x.as_str().is_some_and(|t| !t.is_empty()) && out.insert(s(x).to_owned()),
            "SUPPORT_ROLE_IDS_INVALID",
        )?;
    }
    Ok(out)
}
fn checked_prepared(p: &Value) -> Result<Value> {
    let expected = crate::knowledge_build::prepare_extract(
        &json!({"evidence_set_ref":p["prepared"]["payload"]["evidence_set_ref"],"cq_guidance":p["prepared"]["payload"]["cq_guidance"],"trusted_context":p["trusted_context"]}),
    )?;
    need(expected == p["prepared"], "SUPPORT_PREPARED_CHANGED")?;
    Ok(expected)
}
pub fn validate_roles(v: &Value) -> Result<BTreeSet<String>> {
    need(
        v.as_object()
            .is_some_and(|m| m.len() == ROLES.len() && ROLES.iter().all(|r| m.contains_key(*r))),
        "SUPPORT_ROLE_SHAPE_INVALID",
    )?;
    let mut all = BTreeSet::new();
    for role in ROLES {
        all.extend(ids(&v[role], role == "assertion")?);
    }
    Ok(all)
}
/// Revalidation for the versioned reviewer. The receipt is host-bound data,
/// never a remote model's authority or a semantic truth certificate.
pub fn validate_receipt(c: &Value, r: &Value, prepared: &Value) -> Result<()> {
    need(
        (r["support_selection_version"] == VERSION
            || r["support_selection_version"] == OCCURRENCE_VERSION)
            && r["support_roles_sha256"] == hash(&r["support_roles"])
            && r["support_selection_prepared_payload_sha256"] == hash(&prepared["payload"]),
        "SUPPORT_ROLE_RECEIPT_CHANGED",
    )?;
    if r["support_selection_version"] == OCCURRENCE_VERSION {
        let raw = &r["occurrence_support_raw"];
        let projection_version = r["structural_projection_version"].as_str();
        need(projection_version.is_none() || ["RELATION_LITERAL_ATTRIBUTE_V1", "SOURCE_DESCRIPTION_PREDICATE_V2"].contains(&projection_version.unwrap()),
            "OCCURRENCE_SUPPORT_RECEIPT_CHANGED")?;
        let projected = occurrence_support_projection(raw, prepared, projection_version)?;
        need(
            r["support_selection_raw_sha256"] == hash(raw)
                && r["occurrence_support_projection_sha256"] == hash(&projected)
                && r["mention_occurrence_selection"]["raw"] == projected
                && r["mention_occurrence_selection"]["unit_id"] == r["unit_id"]
                && r["mention_occurrence_selection"]["fact_index"] == r["fact_index"],
            "OCCURRENCE_SUPPORT_RECEIPT_CHANGED",
        )?;
        let i = r["fact_index"]
            .as_u64()
            .filter(|n| *n < a(&raw["candidates"]).len() as u64)
            .ok_or_else(|| {
                error(
                    "OCCURRENCE_SUPPORT_RECEIPT_CHANGED",
                    "OCCURRENCE_SUPPORT_RECEIPT_CHANGED",
                )
            })? as usize;
        let normalized = raw["candidates"][i]["kind"] == "RELATION"
            && projected["candidates"][i]["kind"] == "ATTRIBUTE";
        need(if normalized { r["structural_normalization"] == "RELATION_LITERAL_TO_ATTRIBUTE" }
            else { r["structural_normalization"].is_null() },
            "OCCURRENCE_SUPPORT_RECEIPT_CHANGED")?;
        let filled_predicate = raw["candidates"][i]["predicate"].is_null()
            && projected["candidates"][i]["predicate"].is_object();
        need(if filled_predicate { r["predicate_normalization"] == "SOURCE_DESCRIPTION_AS_PREDICATE" }
            else { r["predicate_normalization"].is_null() },
            "OCCURRENCE_SUPPORT_RECEIPT_CHANGED")?;
        need(
            raw["candidates"][i]["support_roles"] == r["support_roles"],
            "OCCURRENCE_SUPPORT_RECEIPT_CHANGED",
        )?;
        crate::seed_materialize::validate_occurrence_receipt(c, r, prepared)?;
        if [
            "proposal_contract_version",
            "proposal_contract_profile",
            "proposal_contract_profile_sha256",
        ]
        .iter()
        .any(|k| r.get(*k).is_some())
        {
            let is_local=r["proposal_contract_version"]==LOCAL_REQUIRED_OCCURRENCE_VERSION;
            let resolutions=&r["mention_occurrence_selection"]["host_resolutions"];
            let profile=if is_local{local_required_profile(prepared,raw,resolutions,&r["mention_occurrence_selection"]["excluded_fact_indices"])?}else{required_occurrence_profile(prepared,raw)?};
            need(
                r["proposal_contract_version"] == (if is_local{LOCAL_REQUIRED_OCCURRENCE_VERSION}else{REQUIRED_OCCURRENCE_VERSION})
                    && r["proposal_contract_profile"] == profile
                    && r["proposal_contract_profile_sha256"] == hash(&profile),
                "REQUIRED_OCCURRENCE_PROFILE_CHANGED",
            )?;
        }
    } else {
        need(
            [
                "mention_occurrence_selection",
                "occurrence_support_raw",
                "occurrence_support_projection_sha256",
                "proposal_contract_version",
                "proposal_contract_profile",
                "proposal_contract_profile_sha256",
            ]
            .iter()
            .all(|key| r.get(*key).is_none()),
            "SUPPORT_ROLE_VERSION_DOWNGRADE",
        )?;
    }
    let all = validate_roles(&r["support_roles"])?;
    need(
        all == ids(&r["fact_support_evidence_ids"], true)?,
        "SUPPORT_ROLE_UNION_CHANGED",
    )?;
    let menu: BTreeSet<_> = a(&prepared["payload"]["evidence_menu"])
        .iter()
        .map(|f| s(&f["evidence_id"]).to_owned())
        .collect();
    need(all.is_subset(&menu), "SUPPORT_ROLE_EVIDENCE_UNKNOWN")?;
    need(
        r["candidate_sha256"] == hash(c),
        "SUPPORT_ROLE_CANDIDATE_CHANGED",
    )?;
    let condition = ids(&r["support_roles"]["condition"], false)?;
    for row in a(&c["conditions"]) {
        need(
            ids(&row["evidence_ids"], true)?.is_subset(&condition),
            "SUPPORT_CONDITION_ROLE_UNDECLARED",
        )?;
    }
    Ok(())
}
fn prepare(p: &Value) -> Result<Value> {
    let prepared = checked_prepared(p)?;
    let schema = json!({"type":"object","additionalProperties":false,"required":ROLES,"properties":ROLES.iter().map(|r|(r.to_string(),json!({"type":"array","items":{"type":"string"},"uniqueItems":true,"minItems":if *r=="assertion"{1}else{0},"maxItems":128}))).collect::<serde_json::Map<_,_>>()});
    Ok(
        json!({"contract_version":VERSION,"prepared_payload_sha256":hash(&prepared["payload"]),"support_roles_schema":schema,"evidence_menu":prepared["payload"]["evidence_menu"],"instructions":["Choose current-menu IDs explicitly in support_roles: assertion (the behavior/fact), subject_scope (mode/title/class applicability), antecedent (referents required to interpret it), condition (qualifiers/exception/AND or OR conditions). Empty supplementary lists are allowed only when not needed by this proposed fact.","Select every fragment needed to connect the exact subject/mode and full conditions to the assertion. Do not infer sibling inheritance or change negation, direction or same-subject AND ownership.","Registry mention anchors locate terms only; they supply no fact support unless explicitly selected in a support role. Role selection is not approval; independent semantic review remains required.","Output a complete new proposal. Do not modify the old candidate, claim completeness or emit a review verdict."],"semantic_support_certified":false,"publication_performed":false}),
    )
}
fn prepare_occurrence(p: &Value) -> Result<Value> {
    let mut out = prepare(p)?;
    let selector = json!({"type":"integer","minimum":1,"maximum":9007199254740991u64,"description":"One-based ordinal of the exact, overlapping, case-sensitive surface matches in mention_evidence_id, in original source order. Omit only when there is exactly one match. This selects one mention, not an identity or semantic approval."});
    out["contract_version"] = json!(OCCURRENCE_VERSION);
    out["mention_occurrence_schema"] = selector.clone();
    out["registry_entity_schema"] = json!({"type":"object","additionalProperties":false,"required":["local_id","surface","type_label","mention_evidence_id"],"properties":{"local_id":{"type":"string","minLength":1,"maxLength":160},"surface":{"type":"string","minLength":1,"maxLength":160,"description":"Exact unchanged source substring. A repeated surface requires an explicit mention_occurrence; never rewrite spelling or punctuation to force uniqueness."},"type_label":{"type":["string","null"],"minLength":1,"maxLength":12000},"mention_evidence_id":{"type":"string","minLength":1},"mention_occurrence":selector}});
    out["occurrence_instructions"] = json!(["Choose one exact mention in the declared fragment. Count literal case-sensitive matches in original order, including overlaps, starting at 1. If repeated, set mention_occurrence to the intended match; if unique it may be omitted. Zero, out-of-range and non-integer selectors are invalid.","Keep surface and type_label unchanged. Do not merge all matching names into mentions or infer that repeated equal surfaces identify one real entity. Distinct registry entities can select distinct positions.","Rust computes the selected single UTF16 span. This position selection does not certify the subject, identity, negation, conditions or fact support. Explicit support roles and independent nine-dimension semantic review are still required."]);
    Ok(out)
}
fn prepare_required_occurrence(p: &Value) -> Result<Value> {
    let mut out = prepare_occurrence(p)?;
    out["proposal_contract_version"] = json!(REQUIRED_OCCURRENCE_VERSION);
    out["registry_entity_schema"]["required"] = json!([
        "local_id",
        "surface",
        "type_label",
        "mention_evidence_id",
        "mention_occurrence"
    ]);
    let description = "Required for EVERY registry entity, including a unique surface: use integer 1 when exactly one match exists. Otherwise choose the intended one-based ordinal of literal, case-sensitive, overlapping matches in the declared fragment. Never omit, default or infer identity.";
    out["mention_occurrence_schema"]["description"] = json!(description);
    out["registry_entity_schema"]["properties"]["mention_occurrence"] =
        out["mention_occurrence_schema"].clone();
    out["registry_entity_schema"]["properties"]["surface"]["description"] = json!("Exact unchanged source substring. Always specify mention_occurrence; preserve spelling, punctuation and case. Repeated equal names do not imply equal identity.");
    out["occurrence_instructions"] = json!(["Every entity MUST include mention_occurrence as a positive integer. For a unique exact match, explicitly output 1. For repeated literal case-sensitive matches (including overlaps), explicitly choose the intended match in original order starting at 1. No entity may omit the selector, even an unused registry entity.","All registry rows must resolve one exact selected mention before any candidate can materialize. Missing, null, zero, floating-point, non-integer, out-of-range or unmatched selectors reject this strict proposal. Do not repair labels or choose the first match automatically.","Rust computes a single absolute UTF16 source span. Position selection does not establish entity identity, subject ownership, negation, conditions or support. Explicit support roles and the unchanged independent nine-dimension review remain mandatory."]);
    Ok(out)
}
fn required_occurrence_profile(prepared: &Value, raw: &Value) -> Result<Value> {
    let registry_validation = crate::seed_materialize::required_occurrence_registry(prepared, raw)?;
    Ok(
        json!({"contract_version":REQUIRED_OCCURRENCE_VERSION,"prepared_payload_sha256":hash(&prepared["payload"]),"source_snapshot_sha256":hash(&prepared["payload"]["snapshot"]),"raw_sha256":hash(raw),"registry_sha256":hash(&raw["entities"]),"registry_validation":registry_validation,"policy":"EXPLICIT_POSITIVE_INTEGER_SELECTOR_FOR_ALL_REGISTRY_ROWS_NO_DEFAULT","semantic_support_certified":false}),
    )
}
fn materialize_required_occurrence(p: &Value) -> Result<Value> {
    checked_prepared(p)?;
    let mut input = p.clone();
    let parsed = if let Some(text) = p["raw"].as_str() {
        Some(crate::model_json_boundary::parse(text)?)
    } else {
        None
    };
    if let Some(value) = &parsed {
        input["raw"] = value["parsed"].clone();
    }
    let profile = required_occurrence_profile(&input["prepared"], &input["raw"])?;
    let mut out = materialize(&input, true)?;
    out["proposal_contract_version"] = json!(REQUIRED_OCCURRENCE_VERSION);
    out["proposal_contract_profile"] = profile.clone();
    out["proposal_contract_profile_sha256"] = json!(hash(&profile));
    for receipt in out["receipts"].as_array_mut().unwrap() {
        receipt["proposal_contract_version"] = json!(REQUIRED_OCCURRENCE_VERSION);
        receipt["proposal_contract_profile"] = profile.clone();
        receipt["proposal_contract_profile_sha256"] = json!(hash(&profile));
    }
    for c in a(&out["candidates"]) {
        let receipt = a(&out["receipts"])
            .iter()
            .find(|r| r["candidate_id"] == c["candidate_id"])
            .unwrap();
        validate_receipt(c, receipt, &input["prepared"])?;
    }
    if let Some(value) = parsed {
        out["raw_text_parse_receipt"] = value["receipt"].clone();
        out["raw_binding_policy"] =
            json!("PARSED_VALUE_RECEIPT_DISTINCT_FROM_EXACT_RESPONSE_BYTES");
    }
    Ok(out)
}
fn local_required_profile(prepared:&Value,raw:&Value,resolutions:&Value,excluded:&Value)->Result<Value>{
    let registry=crate::seed_materialize::local_occurrence_registry(prepared,raw,resolutions)?;
    Ok(json!({"contract_version":LOCAL_REQUIRED_OCCURRENCE_VERSION,"resolver_version":crate::seed_materialize::LOCAL_RESOLUTION_VERSION,"prepared_payload_sha256":hash(&prepared["payload"]),"source_snapshot_sha256":hash(&prepared["payload"]["snapshot"]),"raw_sha256":hash(raw),"registry_sha256":hash(&raw["entities"]),"registry_validation":registry,"host_resolutions":resolutions,"excluded_fact_indices":excluded,"policy":"EXPLICIT_SELECTOR_LOCAL_ISOLATION_UNIQUE_DECLARED_EVIDENCE_WHITESPACE_RECOVERY","semantic_support_certified":false}))
}
fn prepare_local_required(p:&Value)->Result<Value>{
    let mut out=prepare_required_occurrence(p)?;
    out["proposal_contract_version"]=json!(LOCAL_REQUIRED_OCCURRENCE_VERSION);
    out["resolver_version"]=json!(crate::seed_materialize::LOCAL_RESOLUTION_VERSION);
    out["occurrence_instructions"]=json!(["Every registry entity must include an explicit positive integer mention_occurrence. Prefer exact unchanged source surface and declared evidence ID. Source spans are never invented.","A source-exact unique whitespace-only mapping inside the declared evidence may be recovered by the program. Case, punctuation and brackets are never normalized. Multiple whitespace-mapped locations are quarantined, never chosen automatically by ordinal.","An unresolved registry entity quarantines only candidates that reference it. Unknown entity keys are not silently created. Position recovery does not establish identity or fact support; candidates remain unverified."]);
    Ok(out)
}
fn materialize_local_required(p:&Value)->Result<Value>{
    checked_prepared(p)?;let mut input=p.clone();
    let parsed=if let Some(text)=p["raw"].as_str(){Some(crate::model_json_boundary::parse(text)?)}else{None};
    if let Some(value)=&parsed{input["raw"]=value["parsed"].clone();}
    let resolutions=input.get("host_resolutions").cloned().unwrap_or(json!([]));input["host_resolutions"]=resolutions.clone();
    let excluded=input.get("excluded_fact_indices").cloned().unwrap_or(json!([]));input["excluded_fact_indices"]=excluded.clone();
    let profile=local_required_profile(&input["prepared"],&input["raw"],&resolutions,&excluded)?;
    let mut out=materialize_policy(&input,true,true)?;
    out["proposal_contract_version"]=json!(LOCAL_REQUIRED_OCCURRENCE_VERSION);out["resolver_version"]=json!(crate::seed_materialize::LOCAL_RESOLUTION_VERSION);
    out["proposal_contract_profile"]=profile.clone();out["proposal_contract_profile_sha256"]=json!(hash(&profile));
    for r in out["receipts"].as_array_mut().unwrap(){r["proposal_contract_version"]=json!(LOCAL_REQUIRED_OCCURRENCE_VERSION);r["proposal_contract_profile"]=profile.clone();r["proposal_contract_profile_sha256"]=json!(hash(&profile));}
    for c in a(&out["candidates"]){let r=a(&out["receipts"]).iter().find(|r|r["candidate_id"]==c["candidate_id"]).unwrap();validate_receipt(c,r,&input["prepared"])?;}
    if let Some(value)=parsed{out["raw_text_parse_receipt"]=value["receipt"].clone();out["raw_binding_policy"]=json!("PARSED_VALUE_RECEIPT_DISTINCT_FROM_EXACT_RESPONSE_BYTES");}Ok(out)
}
fn occurrence_support_projection(raw: &Value, prepared: &Value, version: Option<&str>) -> Result<Value> {
    need(
        raw.as_object().is_some_and(|m| {
            m.len() == 2 && m.contains_key("entities") && m.contains_key("candidates")
        }) && raw["entities"].as_array().is_some_and(|r| r.len() <= 24)
            && raw["candidates"].as_array().is_some_and(|r| r.len() <= 8),
        "OCCURRENCE_SUPPORT_RECEIPT_CHANGED",
    )?;
    let known: BTreeSet<_> = a(&prepared["payload"]["evidence_menu"])
        .iter()
        .map(|f| s(&f["evidence_id"]).to_owned())
        .collect();
    let mut out = raw.clone();
    for (i, f) in a(&raw["candidates"]).iter().enumerate() {
        need(
            f.is_object() && f.get("support_evidence_ids").is_none(),
            "SUPPORT_DUPLICATE_LEGACY_FIELD",
        )?;
        let all = validate_roles(&f["support_roles"])?;
        need(all.is_subset(&known), "SUPPORT_ROLE_EVIDENCE_UNKNOWN")?;
        let condition = ids(&f["support_roles"]["condition"], false)?;
        for c in a(&f["conditions"]) {
            need(
                ids(&c["evidence_ids"], true)?.is_subset(&condition),
                "SUPPORT_CONDITION_ROLE_UNDECLARED",
            )?;
        }
        out["candidates"][i]
            .as_object_mut()
            .unwrap()
            .remove("support_roles");
        out["candidates"][i]["support_evidence_ids"] = json!(all);
        if version.is_some() { project_literal_relation(&mut out["candidates"][i]); }
        if version == Some("SOURCE_DESCRIPTION_PREDICATE_V2") {
            project_source_description_predicate(&mut out["candidates"][i], &f["support_roles"]["assertion"]);
        }
    }
    Ok(out)
}
// A typed literal is a value, not an entity edge. This repairs only the model's
// choice of structural slot; the candidate still needs independent review.
fn project_literal_relation(fact: &mut Value) -> bool {
    if fact["kind"] == "RELATION" && fact["object"]["entity_local_id"].is_null()
        && fact["object"]["typed_value"].is_object() {
        fact["kind"] = json!("ATTRIBUTE");
        fact["direction"] = json!("NONE");
        true
    } else { false }
}
fn project_source_description_predicate(fact: &mut Value, assertion: &Value) -> bool {
    let label = fact["description"].as_str().unwrap_or("").trim();
    if ["RELATION", "ATTRIBUTE"].contains(&s(&fact["kind"]))
        && fact["predicate"].is_null() && !label.is_empty() && label.chars().count() <= 180
        && assertion.as_array().is_some_and(|ids| !ids.is_empty()) {
        fact["predicate"] = json!({"label":label,"description":label,"evidence_ids":assertion});
        true
    } else { false }
}
#[cfg(test)]
mod literal_relation_tests {
    use super::*;
    #[test]
    fn only_unbound_literal_relation_changes_structural_slot() {
        let mut literal = json!({"kind":"RELATION","direction":"DIRECTED",
            "object":{"entity_local_id":null,"typed_value":{"kind":"STRING","value":"administrators"}},
            "description":"Only administrators can export logs."});
        assert!(project_literal_relation(&mut literal));
        assert_eq!(literal["kind"], "ATTRIBUTE");
        assert_eq!(literal["direction"], "NONE");
        assert_eq!(literal["object"]["typed_value"]["value"], "administrators");
        assert_eq!(literal["description"], "Only administrators can export logs.");
        let mut linked = json!({"kind":"RELATION","direction":"DIRECTED",
            "object":{"entity_local_id":"role_1","typed_value":null}});
        assert!(!project_literal_relation(&mut linked));
        assert_eq!(linked["kind"], "RELATION");
        let mut missing = json!({"kind":"ATTRIBUTE","description":"Pine Relay retains queued messages for 7 days.",
            "predicate":null,"object":{"entity_local_id":null,"typed_value":{"kind":"STRING","value":"7 days"}}});
        assert!(project_source_description_predicate(&mut missing, &json!(["evidence_1"])));
        assert_eq!(missing["predicate"]["label"], "Pine Relay retains queued messages for 7 days.");
        assert_eq!(missing["predicate"]["evidence_ids"], json!(["evidence_1"]));
        assert!(!project_source_description_predicate(&mut missing, &json!(["evidence_1"])));
    }
}
fn materialize(p:&Value,occurrence:bool)->Result<Value>{materialize_policy(p,occurrence,false)}
fn materialize_policy(p: &Value, occurrence: bool, local:bool) -> Result<Value> {
    checked_prepared(p)?;
    let raw = &p["raw"];
    need(
        raw.as_object().is_some_and(|m| {
            m.len() == 2 && m.contains_key("entities") && m.contains_key("candidates")
        }),
        "SUPPORT_RAW_SHAPE_INVALID",
    )?;
    let facts = raw["candidates"]
        .as_array()
        .ok_or_else(|| error("SUPPORT_RAW_SHAPE_INVALID", "SUPPORT_RAW_SHAPE_INVALID"))?;
    let max = p["max_candidates"]
        .as_u64()
        .filter(|n| (1..=8).contains(n))
        .ok_or_else(|| error("SUPPORT_CANDIDATE_LIMIT", "SUPPORT_CANDIDATE_LIMIT"))?;
    need(facts.len() <= max as usize, "SUPPORT_CANDIDATE_LIMIT")?;
    let known: BTreeSet<_> = a(&p["prepared"]["payload"]["evidence_menu"])
        .iter()
        .map(|f| s(&f["evidence_id"]).to_owned())
        .collect();
    let mut projected = raw.clone();
    let mut roles_by_index = BTreeMap::new();
    for (i, f) in facts.iter().enumerate() {
        need(
            f.is_object() && f.get("support_evidence_ids").is_none(),
            "SUPPORT_DUPLICATE_LEGACY_FIELD",
        )?;
        let all = validate_roles(&f["support_roles"])?;
        need(all.is_subset(&known), "SUPPORT_ROLE_EVIDENCE_UNKNOWN")?;
        let condition = ids(&f["support_roles"]["condition"], false)?;
        for c in a(&f["conditions"]) {
            need(
                ids(&c["evidence_ids"], true)?.is_subset(&condition),
                "SUPPORT_CONDITION_ROLE_UNDECLARED",
            )?;
        }
        roles_by_index.insert(i, f["support_roles"].clone());
        projected["candidates"][i]
            .as_object_mut()
            .unwrap()
            .remove("support_roles");
        projected["candidates"][i]["support_evidence_ids"] = json!(all);
        project_literal_relation(&mut projected["candidates"][i]);
        project_source_description_predicate(&mut projected["candidates"][i], &f["support_roles"]["assertion"]);
    }
    let mut input = p.clone();
    input["raw"] = projected.clone();
    let mut out = crate::seed_materialize::execute(
        if local {"materialize_local_occurrence_v1"}else if occurrence {
            "materialize_occurrence_v1"
        } else {
            "materialize"
        },
        &input,
    )?;
    for r in out["receipts"].as_array_mut().unwrap() {
        let i = r["fact_index"].as_u64().unwrap() as usize;
        let roles = &roles_by_index[&i];
        r["support_selection_version"] = json!(if occurrence {
            OCCURRENCE_VERSION
        } else {
            VERSION
        });
        if occurrence {
            r["occurrence_support_raw"] = raw.clone();
            r["occurrence_support_projection_sha256"] = json!(hash(&projected));
            r["structural_projection_version"] = json!("SOURCE_DESCRIPTION_PREDICATE_V2");
            if raw["candidates"][i]["kind"] == "RELATION" && projected["candidates"][i]["kind"] == "ATTRIBUTE" {
                r["structural_normalization"] = json!("RELATION_LITERAL_TO_ATTRIBUTE");
            }
            if raw["candidates"][i]["predicate"].is_null() && projected["candidates"][i]["predicate"].is_object() {
                r["predicate_normalization"] = json!("SOURCE_DESCRIPTION_AS_PREDICATE");
            }
        }
        r["support_roles"] = roles.clone();
        r["support_roles_sha256"] = json!(hash(roles));
        r["support_selection_prepared_payload_sha256"] = json!(hash(&p["prepared"]["payload"]));
        r["support_selection_raw_sha256"] = json!(hash(raw));
    }
    for c in a(&out["candidates"]) {
        let r = a(&out["receipts"])
            .iter()
            .find(|r| r["candidate_id"] == c["candidate_id"])
            .unwrap();
        validate_receipt(c, r, &p["prepared"])?;
    }
    out["support_selection_version"] = json!(if occurrence {
        OCCURRENCE_VERSION
    } else {
        VERSION
    });
    out["original_support_selection_raw_sha256"] = json!(hash(raw));
    out["selected_projection_sha256"] = json!(hash(&projected));
    Ok(out)
}
/// Preserve numeric token types until ordinal validation. The receipt binds the
/// parsed value; exact response bytes remain a distinct host attempt artifact.
fn materialize_occurrence(p: &Value) -> Result<Value> {
    if let Some(text) = p["raw"].as_str() {
        let parsed = crate::model_json_boundary::parse(text)?;
        let mut input = p.clone();
        input["raw"] = parsed["parsed"].clone();
        let mut out = materialize(&input, true)?;
        out["raw_text_parse_receipt"] = parsed["receipt"].clone();
        out["raw_binding_policy"] =
            json!("PARSED_VALUE_RECEIPT_DISTINCT_FROM_EXACT_RESPONSE_BYTES");
        Ok(out)
    } else {
        materialize(p, true)
    }
}
pub fn execute(op: &str, p: &Value) -> Result<Value> {
    let mut required = match op {
        "prepare" | "prepare_occurrence_v1" | "prepare_required_occurrence_v1" | "prepare_local_required_occurrence_v1" => {
            vec!["prepared", "trusted_context"]
        }
        "materialize" | "materialize_occurrence_v1" | "materialize_required_occurrence_v1" | "materialize_local_required_occurrence_v1" | "materialize_local_correction_v1" => vec![
            "prepared",
            "trusted_context",
            "raw",
            "unit_id",
            "max_candidates",
        ],
        _ => {
            return Err(error(
                "SUPPORT_OPERATION_UNKNOWN",
                "SUPPORT_OPERATION_UNKNOWN",
            ))
        }
    };
    if op=="materialize_local_correction_v1"{required.extend(["host_resolutions","excluded_fact_indices"]);}
    need(
        p.as_object().is_some_and(|m| {
            m.len() == required.len()+usize::from(op=="materialize_local_required_occurrence_v1"&&m.contains_key("host_resolutions")) && required.iter().all(|k| m.contains_key(*k))
        }),
        "SUPPORT_INPUT_SHAPE_INVALID",
    )?;
    need(
        serde_json::to_vec(p)
            .map_err(|_| error("SUPPORT_INPUT_SHAPE_INVALID", "SUPPORT_INPUT_SHAPE_INVALID"))?
            .len()
            <= 8 * 1024 * 1024,
        "SUPPORT_RESOURCE_LIMIT",
    )?;
    match op {
        "prepare" => prepare(p),
        "prepare_occurrence_v1" => prepare_occurrence(p),
        "prepare_required_occurrence_v1" => prepare_required_occurrence(p),
        "prepare_local_required_occurrence_v1" => prepare_local_required(p),
        "materialize_local_required_occurrence_v1" | "materialize_local_correction_v1" => materialize_local_required(p),
        "materialize_required_occurrence_v1" => materialize_required_occurrence(p),
        "materialize_occurrence_v1" => materialize_occurrence(p),
        _ => materialize(p, false),
    }
}
