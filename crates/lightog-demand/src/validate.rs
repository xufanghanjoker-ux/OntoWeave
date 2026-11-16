//! Contextual invariants ported from the frozen reference, independent of model output.
use crate::{
    context::{array, named, strings, unique},
    need,
    question::validate_question,
    wire, Error, Result, ValidationContext,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub fn validate(v: &Value, definition: &str, ctx: &ValidationContext) -> Result<()> {
    match definition {
        "QuestionSpec" => validate_question(v, ctx)?,
        "CQFamily" => family(v, ctx)?,
        "EvidenceSet" => evidence(v, ctx)?,
        "CoverageReport" | "LearningIntent" => {
            let q = ctx
                .specs
                .get(v["question_id"].as_str().unwrap())
                .ok_or_else(|| Error::new("UNKNOWN_QUESTION_REF"))?;
            need(
                wire::sha(q)? == v["question_spec_sha256"],
                "SPEC_HASH_MISMATCH",
            )?;
            ctx.snapshot_check(&v["snapshot"])?;
            let reqs: BTreeMap<&str, &Value> = array(&q["requirements"])
                .iter()
                .map(|r| (r["id"].as_str().unwrap(), r))
                .collect();
            if definition == "CoverageReport" {
                coverage(v, q, &reqs, ctx)?;
            } else {
                learning(v, &reqs, ctx)?;
            }
        }
        "DemandEnvelope" => {
            validate_question(&v["payload"], ctx)?;
            need(
                wire::sha(&v["payload"])? == v["payload_sha256"],
                "PAYLOAD_HASH_MISMATCH",
            )?;
            let c = &v["context"];
            need(
                c["access_mode"] != "QUERY" || c["learning_requested"] == false,
                "ACCESS_SCOPE_DENIED",
            )?;
            need(
                c == ctx.trusted_request(&v["request_id"], &v["payload_sha256"])?,
                "ACCESS_SCOPE_DENIED",
            )?;
        }
        "AnswerResult" => answer(v, ctx)?,
        _ => {}
    }
    Ok(())
}
fn family(v: &Value, ctx: &ValidationContext) -> Result<()> {
    let seed = ctx
        .specs
        .get(v["seed_question_id"].as_str().unwrap())
        .ok_or_else(|| Error::new("UNKNOWN_QUESTION_REF"))?;
    need(
        wire::sha(seed)? == v["seed_question_spec_sha256"],
        "SPEC_HASH_MISMATCH",
    )?;
    let selected = strings(&v["seed_requirement_ids"]);
    let byid: BTreeMap<_, _> = array(&seed["requirements"])
        .iter()
        .map(|r| (r["id"].as_str().unwrap().to_owned(), r))
        .collect();
    need(
        selected.iter().all(|id| byid.contains_key(id)),
        "UNKNOWN_REQUIREMENT_REF",
    )?;
    let mut local = BTreeSet::new();
    let mut cids = BTreeSet::new();
    for id in &selected {
        for m in array(&byid[id]["subjects"]["members"]) {
            local.insert(m["local_id"].as_str().unwrap());
        }
        for c in array(&byid[id]["conditions"]) {
            cids.insert(c["id"].as_str().unwrap().to_owned());
        }
    }
    need(
        local.contains(
            v["subject_slot"]["replace_subject_local_id"]
                .as_str()
                .unwrap(),
        ),
        "FAMILY_SLOT_INVALID",
    )?;
    let co = &v["cohort_basis"];
    need(
        if co["kind"] == "USER_DEFINED" {
            !co["user_definition_ref"].is_null()
        } else {
            !array(&co["evidence_ids"]).is_empty() && co["user_definition_ref"].is_null()
        },
        "COHORT_BASIS_MISSING",
    )?;
    if co["kind"] == "USER_DEFINED" {
        need(
            array(&ctx.authority["user_definitions"]).contains(&co["user_definition_ref"]),
            "USER_DEFINITION_REF_UNRESOLVED",
        )?;
    }
    need(
        strings(&co["evidence_ids"]).is_subset(&ctx.evidence_ids()),
        "UNKNOWN_EVIDENCE_REF",
    )?;
    unique(array(&v["members"]), "local_id")?;
    unique(array(&v["condition_transfer"]), "condition_id")?;
    need(
        cids == array(&v["condition_transfer"])
            .iter()
            .map(|c| c["condition_id"].as_str().unwrap().to_owned())
            .collect(),
        "FAMILY_CONDITION_TRANSFER_INCOMPLETE",
    )?;
    for m in array(&v["members"]) {
        need(
            array(&m["question_spans"]).is_empty(),
            "FAMILY_MEMBER_QUESTION_SPAN_FORBIDDEN",
        )?;
        ctx.subject_refs(m)?;
        need(
            array(&m["source_mentions"])
                .iter()
                .any(|x| x["span"]["quote"] == m["label"]),
            "FAMILY_MEMBER_LABEL_UNANCHORED",
        )?;
    }
    Ok(())
}
fn evidence(v: &Value, ctx: &ValidationContext) -> Result<()> {
    ctx.snapshot_check(&v["snapshot"])?;
    let rows = array(&v["snapshot"]["sources"]);
    unique(rows, "source_ref")?;
    unique(array(&v["fragments"]), "id")?;
    for f in array(&v["fragments"]) {
        let key = (named(f, "source_ref")?, named(f, "source_revision")?);
        let source = ctx
            .sources
            .get(&key)
            .ok_or_else(|| Error::new("SOURCE_REVISION_MISMATCH"))?;
        let record = rows
            .iter()
            .find(|s| {
                s["source_ref"] == f["source_ref"] && s["source_revision"] == f["source_revision"]
            })
            .ok_or_else(|| Error::new("SOURCE_REVISION_MISMATCH"))?;
        need(
            f["text_sha256"] == record["text_sha256"]
                && f["text_sha256"] == wire::text_sha(source["text"].as_str().unwrap()),
            "EVIDENCE_HASH_MISMATCH",
        )?;
        ctx.block_check(&key.0, &key.1, &f["block_ref"], &f["span"])?;
        wire::span_text(source["text"].as_str().unwrap(), &f["span"])?;
        need(
            if f["origin"] == "PUBLISHED_CLAIM" {
                !array(&f["claim_refs"]).is_empty()
            } else {
                array(&f["claim_refs"]).is_empty()
            },
            "EVIDENCE_ORIGIN_MISMATCH",
        )?;
        if f["origin"] == "PUBLISHED_CLAIM" {
            need(
                !v["snapshot"]["graph_revision"].is_null(),
                "GRAPH_SNAPSHOT_MISSING",
            )?;
            for cid in array(&f["claim_refs"]) {
                need(
                    array(&ctx.authority["claims"]).iter().any(|c| {
                        c["claim_ref"] == *cid
                            && c["graph_revision"] == v["snapshot"]["graph_revision"]
                            && c["status"] == "PUBLISHED"
                            && ["source_ref", "source_revision", "block_ref", "span"]
                                .iter()
                                .all(|k| c[k] == f[k])
                    }),
                    "CLAIM_REF_UNRESOLVED",
                )?;
            }
        }
    }
    Ok(())
}
fn coverage(
    v: &Value,
    q: &Value,
    reqs: &BTreeMap<&str, &Value>,
    ctx: &ValidationContext,
) -> Result<()> {
    let es = ctx
        .evidence_sets
        .get(v["evidence_set_ref"].as_str().unwrap())
        .ok_or_else(|| Error::new("SOURCE_SNAPSHOT_MISMATCH"))?;
    need(es["snapshot"] == v["snapshot"], "SOURCE_SNAPSHOT_MISMATCH")?;
    let allowed: BTreeSet<String> = array(&es["fragments"])
        .iter()
        .map(|f| f["id"].as_str().unwrap().to_owned())
        .collect();
    let mut all_blocks = BTreeSet::new();
    for s in array(&v["snapshot"]["sources"]) {
        let source = ctx
            .sources
            .get(&(named(s, "source_ref")?, named(s, "source_revision")?))
            .ok_or_else(|| Error::new("SOURCE_REVISION_MISMATCH"))?;
        if let Some(id)=source["block_ref"].as_str() {
            need(all_blocks.insert(id.to_owned()),"BLOCK_REF_COLLISION")?;
        } else {
            for block in array(&source["blocks"]) {
                need(all_blocks.insert(named(block,"block_ref")?),"BLOCK_REF_COLLISION")?;
            }
        }
    }
    let rows = array(&v["requirements"]);
    unique(rows, "requirement_id")?;
    let rids: BTreeSet<String> = rows
        .iter()
        .map(|r| r["requirement_id"].as_str().unwrap().to_owned())
        .collect();
    need(
        rids == reqs.keys().map(|s| s.to_string()).collect(),
        "REQUIREMENT_COVERAGE_INCOMPLETE",
    )?;
    for r in rows {
        let expected = reqs[r["requirement_id"].as_str().unwrap()];
        let ids = strings(&r["evidence_ids"]);
        need(ids.is_subset(&allowed), "UNKNOWN_EVIDENCE_REF")?;
        need(
            r["basis"] == ctx.basis_for(&r["evidence_ids"])?,
            "ANSWER_BASIS_MISMATCH",
        )?;
        unique(array(&r["condition_receipts"]), "condition_id")?;
        let cids: BTreeSet<String> = array(&expected["conditions"])
            .iter()
            .map(|c| c["id"].as_str().unwrap().to_owned())
            .collect();
        need(
            cids == array(&r["condition_receipts"])
                .iter()
                .map(|c| c["condition_id"].as_str().unwrap().to_owned())
                .collect(),
            "CONDITION_COVERAGE_INCOMPLETE",
        )?;
        let checked = strings(&r["checked_block_refs"]);
        let unsearched = strings(&r["unsearched_block_refs"]);
        need(checked.is_disjoint(&unsearched), "COVERAGE_BLOCK_OVERLAP")?;
        need(
            checked.union(&unsearched).cloned().collect::<BTreeSet<_>>() == all_blocks,
            "COVERAGE_SCOPE_INCOMPLETE",
        )?;
        unique(array(&r["subject_receipts"]), "subject_local_id")?;
        let members = array(&expected["subjects"]["members"]);
        if !members.is_empty() {
            let mids: BTreeSet<String> = members
                .iter()
                .map(|m| m["local_id"].as_str().unwrap().to_owned())
                .collect();
            need(
                mids == array(&r["subject_receipts"])
                    .iter()
                    .map(|m| m["subject_local_id"].as_str().unwrap().to_owned())
                    .collect(),
                "SUBJECT_COVERAGE_INCOMPLETE",
            )?;
        }
        for s in array(&r["subject_receipts"]) {
            need(
                strings(&s["evidence_ids"]).is_subset(&ids),
                "UNKNOWN_EVIDENCE_REF",
            )?;
        }
        for c in array(&r["condition_receipts"]) {
            need(
                c["status"] != "APPLIED" || !c["receipt_ref"].is_null(),
                "MISSING_CONDITION_RECEIPT",
            )?;
            if !c["receipt_ref"].is_null() {
                ctx.receipt_check(
                    &c["receipt_ref"],
                    "CONDITION_APPLIED",
                    v,
                    &r["requirement_id"],
                    Some(&c["condition_id"]),
                )?;
            }
        }
        if !r["coverage_receipt_ref"].is_null() {
            ctx.receipt_check(
                &r["coverage_receipt_ref"],
                "COVERAGE_AUDIT",
                v,
                &r["requirement_id"],
                None,
            )?;
        }
        if r["status"] == "SATISFIED" {
            need(
                !ids.is_empty() && array(&expected["unresolved"]).is_empty(),
                "UNSUPPORTED_SATISFACTION",
            )?;
            need(
                !array(&r["subject_receipts"]).is_empty()
                    && array(&r["subject_receipts"]).iter().all(|s| {
                        s["status"] == "SATISFIED" && !array(&s["evidence_ids"]).is_empty()
                    }),
                "SUBJECT_COVERAGE_INCOMPLETE",
            )?;
            if expected["subjects"]["selector"] == "FAMILY" {
                need(
                    array(&ctx.authority["scope_bindings"]).contains(&r["scope_binding_ref"]),
                    "SCOPE_BINDING_UNRESOLVED",
                )?;
            }
            need(
                array(&r["condition_receipts"])
                    .iter()
                    .all(|c| c["status"] == "APPLIED"),
                "CONDITION_NOT_APPLIED",
            )?;
            if expected["coverage_request"]["mode"] == "ALL_IN_SCOPE" {
                need(
                    r["scope_status"] == "DECLARED_SCOPE_CHECKED"
                        && unsearched.is_empty()
                        && r["semantic_coverage"] == "AUDITED_IN_SCOPE"
                        && !r["coverage_receipt_ref"].is_null(),
                    "EXHAUSTIVE_COVERAGE_NOT_ESTABLISHED",
                )?;
            }
        }
        need(
            r["semantic_coverage"] != "AUDITED_IN_SCOPE" || !r["coverage_receipt_ref"].is_null(),
            "MISSING_COVERAGE_RECEIPT",
        )?;
        if r["status"] == "NEEDS_CLARIFICATION" {
            let aids: BTreeSet<String> = array(&q["ambiguities"])
                .iter()
                .map(|a| a["id"].as_str().unwrap().to_owned())
                .collect();
            need(
                !strings(&expected["unresolved"]).is_disjoint(&aids),
                "DEMAND_NOT_AMBIGUOUS",
            )?;
        }
    }
    Ok(())
}
fn learning(v: &Value, reqs: &BTreeMap<&str, &Value>, ctx: &ValidationContext) -> Result<()> {
    let access = ctx.trusted_request(&v["request_ref"], &v["question_spec_sha256"])?;
    need(
        v["access_mode"] == access["access_mode"]
            && (v["learning_requested"] == false || access["learning_requested"] == true),
        "ACCESS_SCOPE_DENIED",
    )?;
    need(
        strings(&v["requirement_ids"])
            .iter()
            .all(|id| reqs.contains_key(id.as_str())),
        "UNKNOWN_REQUIREMENT_REF",
    )?;
    need(
        strings(&v["admission_evidence_ids"]).is_subset(&ctx.evidence_ids()),
        "UNKNOWN_EVIDENCE_REF",
    )?;
    need(
        v["learning_requested"] == true
            || (v["status"] == "NOT_REQUESTED" && v["task_ref"].is_null()),
        "LEARNING_NOT_REQUESTED",
    )?;
    need(
        v["status"] != "NOT_REQUESTED"
            || (v["learning_requested"] == false && v["task_ref"].is_null()),
        "LEARNING_NOT_REQUESTED",
    )?;
    need(
        v["access_mode"] != "QUERY"
            || (v["learning_requested"] == false
                && v["status"] == "NOT_REQUESTED"
                && v["task_ref"].is_null()),
        "ACCESS_SCOPE_DENIED",
    )?;
    if v["status"] != "NOT_REQUESTED" {
        need(!v["task_ref"].is_null(), "LEARNING_TASK_MISSING")?;
    }
    if v["status"] == "RUNNING" || v["status"] == "PUBLISHED" {
        need(
            !array(&v["admission_evidence_ids"]).is_empty(),
            "LEARNING_EVIDENCE_MISSING",
        )?;
    }
    Ok(())
}
fn answer(v: &Value, ctx: &ValidationContext) -> Result<()> {
    let q = ctx
        .specs
        .get(v["question_id"].as_str().unwrap())
        .ok_or_else(|| Error::new("UNKNOWN_QUESTION_REF"))?;
    need(
        wire::sha(q)? == v["question_spec_sha256"],
        "SPEC_HASH_MISMATCH",
    )?;
    let es = ctx
        .evidence_sets
        .get(v["evidence_set_ref"].as_str().unwrap())
        .ok_or_else(|| Error::new("SOURCE_SNAPSHOT_MISMATCH"))?;
    need(v["snapshot"] == es["snapshot"], "SOURCE_SNAPSHOT_MISMATCH")?;
    let access = ctx.trusted_request(&v["request_ref"], &v["question_spec_sha256"])?;
    ctx.snapshot_check(&v["snapshot"])?;
    let reports: Vec<_> = ctx
        .examples
        .values()
        .filter(|x| x["coverage_report_id"] == v["coverage_report_ref"])
        .collect();
    need(
        reports.len() == 1 && reports[0]["question_spec_sha256"] == v["question_spec_sha256"],
        "UNKNOWN_COVERAGE_REF",
    )?;
    let reqs: BTreeSet<String> = array(&q["requirements"])
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_owned())
        .collect();
    unique(array(&v["statements"]), "id")?;
    let allowed: BTreeSet<String> = array(&es["fragments"])
        .iter()
        .map(|f| f["id"].as_str().unwrap().to_owned())
        .collect();
    let mut used = BTreeSet::new();
    let mut answered = BTreeSet::new();
    for s in array(&v["statements"]) {
        let ids = strings(&s["evidence_ids"]);
        need(ids.is_subset(&allowed), "UNKNOWN_EVIDENCE_REF")?;
        let rs = strings(&s["requirement_ids"]);
        need(rs.is_subset(&reqs), "UNKNOWN_REQUIREMENT_REF")?;
        used.extend(ids);
        answered.extend(rs);
    }
    let ids: Value = used.iter().cloned().collect::<Vec<_>>().into();
    need(v["basis"] == ctx.basis_for(&ids)?, "ANSWER_BASIS_MISMATCH")?;
    if v["answer_status"] == "ANSWERED" {
        need(
            !array(&v["statements"]).is_empty()
                && array(&reports[0]["requirements"])
                    .iter()
                    .all(|r| r["status"] == "SATISFIED"),
            "ANSWER_COVERAGE_INCOMPLETE",
        )?;
        need(answered == reqs, "ANSWER_COVERAGE_INCOMPLETE")?;
    }
    need(
        v["learning_state"]["status"] == "NOT_REQUESTED"
            || !v["learning_state"]["task_ref"].is_null(),
        "LEARNING_TASK_MISSING",
    )?;
    need(
        v["learning_state"]["status"] != "NOT_REQUESTED"
            || v["learning_state"]["task_ref"].is_null(),
        "LEARNING_NOT_REQUESTED",
    )?;
    if access["access_mode"] == "QUERY" || access["learning_requested"] == false {
        need(
            v["learning_state"] == serde_json::json!({"status":"NOT_REQUESTED","task_ref":null}),
            "ACCESS_SCOPE_DENIED",
        )?;
    }
    Ok(())
}
