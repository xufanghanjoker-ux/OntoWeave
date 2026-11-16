//! Pure cross-field checks for a schema-validated `QuestionSpec`.
//!
//! This mirrors `question_check` in the frozen Python fixture validator. It does
//! not interpret language, consult a model, infer facts, or perform product IO.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use crate::{need, Result, ValidationContext};

/// Check one question after its raw JSON has passed the `QuestionSpec` schema.
/// Schema validation is required before calling this function: core field
/// types and required nullable keys are intentionally not re-inferred here.
pub fn validate_question(q: &Value, ctx: &ValidationContext) -> Result<()> {
    let text = q["text"].as_str().unwrap();
    need(
        crate::wire::text_sha(text) == q["text_sha256"].as_str().unwrap(),
        "TEXT_HASH_MISMATCH",
    )?;

    let requirements = q["requirements"].as_array().unwrap();
    let ambiguities = q["ambiguities"].as_array().unwrap();
    let limitations = q["limitations"].as_array().unwrap();
    unique(requirements, "id")?;
    unique(ambiguities, "id")?;
    need(
        !requirements.is_empty() == (q["intent"] == "KNOWLEDGE_QUERY"),
        "INTENT_REQUIREMENTS_MISMATCH",
    )?;
    unique(limitations, "id")?;

    let ambiguity_ids = ids(ambiguities, "id");
    let limitation_ids = ids(limitations, "id");
    need(
        ambiguity_ids.is_disjoint(&limitation_ids),
        "DUPLICATE_LOCAL_ID",
    )?;
    let open_ids: BTreeSet<&str> = ambiguity_ids.union(&limitation_ids).copied().collect();
    let requirement_ids = ids(requirements, "id");
    let mut condition_ids = BTreeSet::new();
    for ambiguity in ambiguities {
        crate::wire::span_text(text, &ambiguity["mention"])?;
    }
    for limitation in limitations {
        crate::wire::span_text(text, &limitation["mention"])?;
    }

    let mut used_open_ids = BTreeSet::new();
    for requirement in requirements {
        let unresolved = string_set(&requirement["unresolved"]);
        need(unresolved.is_subset(&open_ids), "UNKNOWN_AMBIGUITY_REF")?;
        used_open_ids.extend(unresolved.iter().copied());
        let depends_on = string_set(&requirement["depends_on"]);
        need(
            depends_on.is_subset(&requirement_ids)
                && !depends_on.contains(requirement["id"].as_str().unwrap()),
            "REQUIREMENT_DEPENDENCY_INVALID",
        )?;

        let subjects = &requirement["subjects"];
        let members = subjects["members"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        unique(members, "local_id")?;
        match subjects["selector"].as_str().unwrap() {
            "DOCUMENT_GROUP" => {
                crate::wire::span_text(text, &subjects["group_mention"])?;
                need(
                    string_set(&subjects["basis_evidence_ids"])
                        .iter()
                        .all(|id| ctx.fragments.contains_key(*id)),
                    "UNKNOWN_EVIDENCE_REF",
                )?;
                let group = ctx.authority["groups"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|group| group["group_ref"] == subjects["group_ref"]);
                let member_ids: Vec<Value> = members
                    .iter()
                    .map(|member| member["local_id"].clone())
                    .collect();
                need(
                    group.is_some_and(|group| {
                        group["subject_local_ids"].as_array() == Some(&member_ids)
                    }),
                    "GROUP_REF_UNRESOLVED",
                )?;
            }
            "FAMILY" => {
                let family = ctx.families.get(subjects["family_ref"].as_str().unwrap());
                need(
                    family.is_some_and(|family| {
                        family["subject_slot"]["slot_id"] == subjects["slot_ref"]
                    }),
                    "FAMILY_REF_UNRESOLVED",
                )?;
            }
            "UNRESOLVED" => {
                crate::wire::span_text(text, &subjects["mention"])?;
                let ambiguity_ref = subjects["ambiguity_ref"].as_str().unwrap();
                need(
                    unresolved.contains(ambiguity_ref) && ambiguity_ids.contains(ambiguity_ref),
                    "UNRESOLVED_SELECTOR_NOT_DECLARED",
                )?;
            }
            "EXPLICIT" => {}
            // A schema-validated selector cannot take another value.
            _ => unreachable!("QuestionSpec schema must validate the selector first"),
        }
        for member in members {
            need(
                !member["question_spans"].as_array().unwrap().is_empty()
                    || !member["source_evidence_ids"].as_array().unwrap().is_empty(),
                "SUBJECT_WITHOUT_ANCHOR",
            )?;
            for span in member["question_spans"].as_array().unwrap() {
                crate::wire::span_text(text, span)?;
            }
            ctx.subject_refs(member)?;
        }

        let target = &requirement["target"];
        let target_spans = target["question_spans"].as_array().unwrap();
        for span in target_spans {
            crate::wire::span_text(text, span)?;
        }
        need(
            if target["origin"] == "QUESTION" {
                !target_spans.is_empty() && target["context_ref"].is_null()
            } else {
                !target["context_ref"].is_null()
            },
            "TARGET_ORIGIN_INVALID",
        )?;
        if target["origin"] == "CQ_FAMILY" {
            need(
                ctx.families
                    .contains_key(target["context_ref"].as_str().unwrap()),
                "FAMILY_REF_UNRESOLVED",
            )?;
        }
        if target["origin"] == "USER_DEFINITION" {
            need(
                authority_contains(&ctx.authority["user_definitions"], &target["context_ref"]),
                "USER_DEFINITION_REF_UNRESOLVED",
            )?;
        }
        if !target["predicate_ref"].is_null() {
            need(
                authority_contains(&ctx.authority["predicate_refs"], &target["predicate_ref"]),
                "PREDICATE_REF_UNRESOLVED",
            )?;
        }

        for condition in requirement["conditions"].as_array().unwrap() {
            need(
                condition_ids.insert(condition["id"].as_str().unwrap()),
                "DUPLICATE_LOCAL_ID",
            )?;
            crate::wire::span_text(text, &condition["mention"])?;
            let formal = condition["interpretation"] == "FORMALIZED";
            need(
                if formal {
                    condition["operator"] != "UNRESOLVED" && !condition["value"].is_null()
                } else {
                    condition["operator"] == "UNRESOLVED"
                        && condition["value"].is_null()
                        && !unresolved.is_empty()
                },
                "CONDITION_INTERPRETATION_INVALID",
            )?;
            if formal {
                let operator = condition["operator"].as_str().unwrap();
                let kind = condition["value"]["kind"].as_str().unwrap();
                need(
                    matches!(operator, "IN" | "NOT_IN") == (kind == "STRING_SET"),
                    "CONDITION_VALUE_TYPE_INVALID",
                )?;
                if matches!(operator, "GT" | "GE" | "LT" | "LE") {
                    need(
                        matches!(kind, "INTEGER" | "DECIMAL" | "DATE" | "INSTANT"),
                        "CONDITION_VALUE_TYPE_INVALID",
                    )?;
                }
            }
        }

        let structure = &requirement["structure"];
        need(
            !structure.is_null() == (requirement["operation"] == "RELATION"),
            "STRUCTURE_OPERATION_MISMATCH",
        )?;
        if !structure.is_null() {
            let kind = structure["kind"].as_str().unwrap();
            let set_match = structure["match"].as_str().unwrap();
            need(
                if matches!(kind, "COMBINATION" | "COMPARISON") {
                    matches!(set_match, "ALL" | "WITHIN")
                } else {
                    set_match == "NOT_APPLICABLE"
                },
                "STRUCTURE_SET_SEMANTICS_INVALID",
            )?;
            let roles = structure["roles"].as_array().unwrap();
            need(
                structure["directionality"] != "DIRECTED" || !roles.is_empty(),
                "STRUCTURE_DIRECTION_UNRESOLVED",
            )?;
            need(
                structure["directionality"] != "UNRESOLVED" || !unresolved.is_empty(),
                "STRUCTURE_DIRECTION_UNRESOLVED",
            )?;
            let member_ids = ids(members, "local_id");
            for role in roles {
                need(
                    string_set(&role["subject_local_ids"]).is_subset(&member_ids),
                    "STRUCTURE_ROLE_BINDING_INVALID",
                )?;
            }
        }
        let coverage = &requirement["coverage_request"];
        need(
            coverage["mode"] == "EXAMPLES" || coverage["limit"].is_null(),
            "COVERAGE_LIMIT_INVALID",
        )?;
    }
    need(used_open_ids == open_ids, "UNUSED_AMBIGUITY")?;
    validate_dependencies(requirements)
}

fn unique(rows: &[Value], key: &str) -> Result<()> {
    need(ids(rows, key).len() == rows.len(), "DUPLICATE_LOCAL_ID")
}

fn ids<'a>(rows: &'a [Value], key: &str) -> BTreeSet<&'a str> {
    rows.iter().map(|row| row[key].as_str().unwrap()).collect()
}

fn string_set(value: &Value) -> BTreeSet<&str> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect()
}

/// Python membership checks keys for an object and elements for an array.
/// Authority collections are not assumed to have the core payload's schema.
fn authority_contains(collection: &Value, value: &Value) -> bool {
    match collection {
        Value::Array(values) => values.contains(value),
        Value::Object(values) => value.as_str().is_some_and(|key| values.contains_key(key)),
        _ => false,
    }
}

/// Iterative depth-first traversal preserves dependency order and avoids an
/// unbounded Rust call stack for a schema-valid but deeply nested graph.
fn validate_dependencies(requirements: &[Value]) -> Result<()> {
    let edges: BTreeMap<&str, Vec<&str>> = requirements
        .iter()
        .map(|requirement| {
            (
                requirement["id"].as_str().unwrap(),
                requirement["depends_on"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|dependency| dependency.as_str().unwrap())
                    .collect(),
            )
        })
        .collect();
    let mut done = BTreeSet::new();
    let mut visiting = BTreeSet::new();
    for requirement in requirements {
        let root = requirement["id"].as_str().unwrap();
        let mut stack = vec![(root, false)];
        while let Some((node, exiting)) = stack.pop() {
            if exiting {
                visiting.remove(node);
                done.insert(node);
                continue;
            }
            need(!visiting.contains(node), "REQUIREMENT_DEPENDENCY_CYCLE")?;
            if done.contains(node) {
                continue;
            }
            visiting.insert(node);
            stack.push((node, true));
            // Unknown/self references were rejected in requirement order above.
            for dependency in edges[node].iter().rev() {
                stack.push((*dependency, false));
            }
        }
    }
    Ok(())
}
