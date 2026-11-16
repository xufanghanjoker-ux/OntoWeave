//! Source-first composition of two independently validated, unchanged P3 searches.
//! No model, gold, evidence cutting, or claim publication.
use crate::common::{a, canonical_hash, error, s, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const VERSION: &str = "lightog-source-first-routing/0.1";
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Policy {
    max_context_utf16: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    contract_version: String,
    document_request: Value,
    graph_request: Value,
    policy: Policy,
}
fn need(ok: bool, code: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(error(code, code))
    }
}
fn number(v: &Value) -> Result<usize> {
    v.as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| error("ROUTING_SPAN_INVALID", "ROUTING_SPAN_INVALID"))
}
fn same_source(a: &Value, b: &Value) -> bool {
    ["source_ref", "source_revision", "text_sha256"]
        .iter()
        .all(|k| a[*k] == b[*k])
}
fn slice16(text: &str, begin: usize, end: usize) -> Result<String> {
    let chars: Vec<u16> = text.encode_utf16().collect();
    need(begin <= end && end <= chars.len(), "ROUTING_SPAN_INVALID")?;
    String::from_utf16(&chars[begin..end])
        .map_err(|_| error("ROUTING_UNICODE_BOUNDARY", "ROUTING_UNICODE_BOUNDARY"))
}
fn coverage(fragment: &Value, contexts: &[Value]) -> Result<Option<Vec<Value>>> {
    let start = number(&fragment["span"]["start"])?;
    let end = number(&fragment["span"]["end"])?;
    let mut cursor = start;
    let mut pieces = vec![];
    while cursor < end {
        let mut best: Option<(usize, usize, usize)> = None;
        for (index, context) in contexts.iter().enumerate() {
            if !same_source(fragment, context) {
                continue;
            }
            let from = number(&context["span"]["start"])?;
            let to = number(&context["span"]["end"])?;
            if from <= cursor && cursor < to && best.is_none_or(|(_, _, prior_end)| to > prior_end)
            {
                best = Some((index, from, to));
            }
        }
        let Some((index, from, to)) = best else {
            return Ok(None);
        };
        let stop = to.min(end);
        let expected = slice16(s(&fragment["span"]["quote"]), cursor - start, stop - start)?;
        let actual = slice16(
            s(&contexts[index]["span"]["quote"]),
            cursor - from,
            stop - from,
        )?;
        need(expected == actual, "ROUTING_COVERAGE_TEXT_MISMATCH")?;
        pieces.push(json!({"covering_context_id":contexts[index]["id"],"covering_context_index":index,
            "source_ref":fragment["source_ref"],"source_revision":fragment["source_revision"],"text_sha256":fragment["text_sha256"],
            "covered_span":{"start":cursor,"end":stop,"quote":actual,"offset_unit":"utf16_code_unit"},
            "covering_context_relative_span":{"start":cursor-from,"end":stop-from,"offset_unit":"utf16_code_unit"},
            "requested_evidence_relative_span":{"start":cursor-start,"end":stop-start,"offset_unit":"utf16_code_unit"}}));
        cursor = stop;
    }
    Ok(Some(pieces))
}
fn evidence(result: &Value) -> Result<BTreeMap<String, Value>> {
    let mut map = BTreeMap::new();
    let values = a(&result["contexts"]).iter().chain(
        result["evidence_provenance"]
            .as_object()
            .into_iter()
            .flat_map(|m| m.values())
            .flat_map(|v| a(v).iter()),
    );
    for fragment in values {
        let id = s(&fragment["id"]).to_owned();
        need(!id.is_empty(), "ROUTING_EVIDENCE_UNRESOLVED")?;
        if let Some(old) = map.get(&id) {
            need(old == fragment, "ROUTING_EVIDENCE_ID_COLLISION")?;
        } else {
            map.insert(id, fragment.clone());
        }
    }
    Ok(map)
}

pub fn execute(op: &str, payload: &Value) -> Result<Value> {
    need(op == "compose", "ROUTING_OPERATION_UNKNOWN")?;
    let request: Request = serde_json::from_value(payload.clone())
        .map_err(|_| error("ROUTING_SHAPE_INVALID", "ROUTING_SHAPE_INVALID"))?;
    need(
        request.contract_version == VERSION,
        "ROUTING_VERSION_UNSUPPORTED",
    )?;
    let budget = request.policy.max_context_utf16;
    need((1..=16000).contains(&budget), "ROUTING_BUDGET_INVALID")?;
    let doc = &request.document_request;
    let graph = &request.graph_request;
    for key in ["question", "queries", "snapshot", "options"] {
        need(
            doc.get(key).is_some() && doc[key] == graph[key],
            "ROUTING_REQUEST_MISMATCH",
        )?;
    }
    for req in [doc, graph] {
        need(
            req["options"]["max_context_tokens"].is_null(),
            "ROUTING_TOKEN_BUDGET_UNSUPPORTED",
        )?;
        need(
            req["options"]["max_context_utf16"].as_u64() == Some(budget as u64),
            "ROUTING_BUDGET_MISMATCH",
        )?;
    }
    need(
        doc["trusted_index"]["records"]
            .as_array()
            .is_some_and(|rows| rows.iter().all(|r| r["kind"] == "DOCUMENT"))
            && doc["trusted_index"]["edges"]
                .as_array()
                .is_some_and(|rows| rows.is_empty()),
        "ROUTING_DOCUMENT_LANE_INVALID",
    )?;
    let document_result = crate::hybrid_retrieval::execute("search", doc)?;
    let graph_result = crate::hybrid_retrieval::execute("search", graph)?;
    let document_evidence = evidence(&document_result)?;
    let graph_evidence = evidence(&graph_result)?;
    for (id, value) in &document_evidence {
        if let Some(other) = graph_evidence.get(id) {
            need(value == other, "ROUTING_EVIDENCE_ID_COLLISION")?;
        }
    }
    let mut contexts = a(&document_result["contexts"]).to_vec();
    let base_utf16: usize = contexts
        .iter()
        .map(|f| s(&f["span"]["quote"]).encode_utf16().count())
        .sum();
    need(base_utf16 <= budget, "ROUTING_BASE_BUDGET_EXCEEDED")?;
    let mut used = base_utf16;
    let mut records = vec![];
    let mut deferred = vec![];
    let mut links = vec![];
    let mut decisions = vec![];
    let mut references = 0;
    for record in a(&graph_result["records"]) {
        let mut staged = contexts.clone();
        let before = staged.len();
        let mut record_links = vec![];
        for id in a(&record["evidence_ids"]) {
            references += 1;
            need(references <= 65536, "ROUTING_RESOURCE_LIMIT")?;
            let requested_id = s(id);
            let canonical_id = graph_result["evidence_aliases"]
                .get(requested_id)
                .and_then(Value::as_str)
                .unwrap_or(requested_id);
            let fragment = graph_evidence
                .get(requested_id)
                .or_else(|| graph_evidence.get(canonical_id))
                .ok_or_else(|| {
                    error("ROUTING_EVIDENCE_UNRESOLVED", "ROUTING_EVIDENCE_UNRESOLVED")
                })?;
            if let Some(canonical) = graph_evidence.get(canonical_id) {
                need(
                    same_source(fragment, canonical) && fragment["span"] == canonical["span"],
                    "ROUTING_ALIAS_MISMATCH",
                )?;
            }
            let pieces = match coverage(fragment, &staged)? {
                Some(pieces) => pieces,
                None => {
                    staged.push(fragment.clone());
                    coverage(fragment, &staged)?.ok_or_else(|| {
                        error("ROUTING_COVERAGE_INCOMPLETE", "ROUTING_COVERAGE_INCOMPLETE")
                    })?
                }
            };
            record_links.push(json!({"graph_record_id":record["record_id"],"requested_evidence_id":requested_id,
                "canonical_graph_evidence_id":canonical_id,"resolved_fragment_id":fragment["id"],"requested_evidence":fragment,"coverage":pieces}));
        }
        let added: usize = staged[before..]
            .iter()
            .map(|f| s(&f["span"]["quote"]).encode_utf16().count())
            .sum();
        if used + added > budget {
            let decision = json!({"record_id":record["record_id"],"reason":"DEFERRED_WHOLE_GROUP","evidence_ids":record["evidence_ids"],"navigation_evidence_ids":record["navigation_evidence_ids"],"required_new_utf16":added,"remaining_utf16":budget-used});
            deferred.push(decision.clone());
            decisions.push(decision);
            continue;
        }
        let reason = if added == 0 {
            "COVERED_LINK"
        } else {
            "ADDED_WHOLE_GROUP"
        };
        let mut kept = record.clone();
        kept["routing_reason"] = json!(reason);
        decisions.push(json!({"record_id":record["record_id"],"reason":reason,"evidence_ids":record["evidence_ids"],"added_context_ids":staged[before..].iter().map(|f|f["id"].clone()).collect::<Vec<_>>(),"added_utf16":added}));
        contexts = staged;
        used += added;
        records.push(kept);
        links.extend(record_links);
    }
    let base = a(&document_result["contexts"]);
    need(contexts[..base.len()] == *base, "ROUTING_BASE_CHANGED")?;
    Ok(
        json!({"contract_version":VERSION,"snapshot":doc["snapshot"],"contexts":contexts,"records":records,
        "deferred":deferred,"coverage_links":links,"document_result":document_result,"graph_result":graph_result,
        "trace":{"base_document_utf16":base_utf16,"added_graph_utf16":used-base_utf16,"context_utf16":used,"max_context_utf16":budget,
            "base_doc_context_ids":base.iter().map(|f|f["id"].clone()).collect::<Vec<_>>(),"base_sequence_preserved":true,
            "base_contexts_sha256":canonical_hash(&json!(base)),"record_decisions":decisions,"policy":"SOURCE_FIRST_GRAPH_SUPPLEMENT",
            "coverage_policy":"EXACT_SAME_SOURCE_REVISION_HASH_GAP_FREE_UTF16_INTERVALS","original_p3_results_changed":false,
            "graph_benefit_claim_allowed":false,"semantic_support_certified":false,"publication_performed":false,"model_calls_performed":0}}),
    )
}
