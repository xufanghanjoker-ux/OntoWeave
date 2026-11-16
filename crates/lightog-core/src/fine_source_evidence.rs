//! Lossless structural refinement of already-retrieved, validated source spans.
//! Boundaries are navigation aids, never certified subject/scope/entailment.
use crate::common::{a, canonical_hash, error, len, s, text_sha, Result};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const VERSION: &str = "lightog-fine-source-evidence/0.1";
pub const MAX_FRAGMENT_UTF16: usize = 640;
const MAX_FRAGMENTS: usize = 128;
const MAX_CONTEXT_UTF16: usize = 24000;

fn need(ok: bool, code: &str) -> Result<()> {
    if ok { Ok(()) } else { Err(error(code, code)) }
}
fn shape(v: &Value, keys: &[&str]) -> Result<()> {
    need(v.as_object().is_some_and(|m| m.len() == keys.len() && keys.iter().all(|k| m.contains_key(*k))), "FINE_SOURCE_PAYLOAD_INVALID")
}
fn compose(es: &Value, context: &Value) -> Result<Value> {
    lightog_demand::evidence_bridge::execute("compose", &json!({
        "request":{"bridge_version":"lightog-evidence-bridge/0.1","evidence_set_id":es["evidence_set_id"],"snapshot":es["snapshot"],"source_fragments":es["fragments"],"legacy_claim_ids":[]},
        "context":context,"legacy_claims":[]
    })).map_err(|e| error(e.code, e.code))
}

// Return a byte partition, including all original whitespace. No normalization,
// fuzzy matching, source enlargement or surrogate splitting is permitted.
fn structural_parts(text: &str) -> Vec<(usize, usize)> {
    let mut paragraphs = vec![];
    let mut start = 0;
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        offset += line.len();
        if line.trim().is_empty() && offset > start {
            paragraphs.push((start, offset));
            start = offset;
        }
    }
    if start < text.len() { paragraphs.push((start, text.len())); }
    let mut out = vec![];
    for (mut at, end) in paragraphs {
        while at < end {
            let tail = &text[at..end];
            if len(tail) <= MAX_FRAGMENT_UTF16 { out.push((at, end)); break; }
            let mut units = 0;
            let mut cap = 0;
            let mut newline = 0;
            let mut sentence = 0;
            let mut whitespace = 0;
            for (byte, c) in tail.char_indices() {
                if units + c.len_utf16() > MAX_FRAGMENT_UTF16 { break; }
                units += c.len_utf16();
                cap = byte + c.len_utf8();
                if units >= 64 {
                    if c == '\n' { newline = cap; }
                    if matches!(c, '.' | '!' | '?' | '。' | '！' | '？' | ';' | '；') { sentence = cap; }
                    if c.is_whitespace() { whitespace = cap; }
                }
            }
            let mut cut = if newline > 0 { newline } else if sentence > 0 { sentence } else if whitespace > 0 { whitespace } else { cap };
            if tail[..cut].ends_with('\r') && tail[cut..].starts_with('\n') { cut -= 1; }
            // cap always contains at least one complete Unicode scalar value.
            debug_assert!(cut > 0 && tail.is_char_boundary(cut));
            out.push((at, at + cut));
            at += cut;
        }
    }
    out
}

// Coalesce only adjacent spans from the same parent. Every byte/UTF16 offset
// remains original; boundaries are mechanical, never semantic scope inference.
fn compact_parts(text: &str, parts: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = vec![];
    for (start, end) in parts {
        if let Some(last) = out.last_mut() {
            if last.1 == start && len(&text[last.0..end]) <= MAX_FRAGMENT_UTF16 {
                last.1 = end;
                continue;
            }
        }
        out.push((start, end));
    }
    out
}

fn refine_inner(es: &Value, context: &Value, batched: bool, source_isolation: bool) -> Result<Value> {
    need(es["contract_version"] == "lightog-demand/0.1" && es["fragments"].is_array(), "FINE_SOURCE_EVIDENCE_REQUIRED")?;
    if !batched { need(a(&es["fragments"]).len() <= MAX_FRAGMENTS, "FINE_SOURCE_INPUT_RESOURCE_LIMIT")?; }
    let input_utf16: usize = a(&es["fragments"]).iter().map(|f| len(s(&f["span"]["quote"]))).sum();
    if !batched { need(input_utf16 <= MAX_CONTEXT_UTF16, "FINE_SOURCE_CONTEXT_BUDGET_EXCEEDED")?; }
    let validated = compose(es, context)?;
    need(validated["evidence_set"] == *es && a(&validated["legacy_claims"]).is_empty(), "FINE_SOURCE_COMPOSITION_CHANGED")?;
    let parts: Vec<Vec<(usize, usize)>> = a(&es["fragments"]).iter()
        .map(|parent| structural_parts(s(&parent["span"]["quote"]))).collect();
    let compact = parts.iter().map(Vec::len).sum::<usize>() > MAX_FRAGMENTS;
    let mut fragments: Vec<Value> = vec![];
    let mut bindings: Vec<Value> = vec![];
    let mut existing = BTreeMap::<String, usize>::new();
    for (parent, parts) in a(&es["fragments"]).iter().zip(parts) {
        let quote = s(&parent["span"]["quote"]);
        let absolute = parent["span"]["start"].as_u64().ok_or_else(|| error("FINE_SOURCE_SPAN_INVALID", "FINE_SOURCE_SPAN_INVALID"))? as usize;
        for (start, end) in if compact { compact_parts(quote, parts) } else { parts } {
            let part = &quote[start..end];
            let begin = absolute + len(&quote[..start]);
            let finish = begin + len(part);
            let identity = json!({"version":VERSION,"source_ref":parent["source_ref"],"source_revision":parent["source_revision"],"block_ref":parent["block_ref"],"text_sha256":parent["text_sha256"],"start":begin,"end":finish,"quote_sha256":text_sha(part),"role":parent["role"]});
            let hash = canonical_hash(&identity);
            if let Some(index) = existing.get(&hash) {
                let ids = bindings[*index]["parent_evidence_ids"].as_array_mut().unwrap();
                if !ids.contains(&parent["id"]) { ids.push(parent["id"].clone()); }
                continue;
            }
            let id = format!("fine_{}", &hash[..32]);
            let mut f = parent.clone();
            f["id"] = json!(id);
            f["span"] = json!({"start":begin,"end":finish,"quote":part,"offset_unit":"utf16_code_unit"});
            existing.insert(hash, fragments.len());
            fragments.push(f);
            bindings.push(json!({"evidence_id":id,"parent_evidence_ids":[parent["id"]],"source_ref":parent["source_ref"],"source_revision":parent["source_revision"],"block_ref":parent["block_ref"],"text_sha256":parent["text_sha256"],"start":begin,"end":finish,"quote_sha256":text_sha(part),"boundary_kind":"STRUCTURAL_SUBSPAN","semantic_role_certified":false}));
        }
    }
    if batched { return batch_output(es, context, fragments, bindings, input_utf16, compact, source_isolation); }
    need(fragments.len() <= MAX_FRAGMENTS, "FINE_SOURCE_OUTPUT_RESOURCE_LIMIT")?;
    let id = format!("fine_es_{}", &canonical_hash(&json!({"version":VERSION,"input":es}))[..32]);
    let mut next = es.clone(); next["evidence_set_id"] = json!(id); next["fragments"] = json!(fragments);
    let checked = compose(&next, context)?;
    need(checked["evidence_set"] == next, "FINE_SOURCE_COMPOSITION_CHANGED")?;
    let output_utf16: usize = a(&next["fragments"]).iter().map(|f| len(s(&f["span"]["quote"]))).sum();
    let mut result = json!({"contract_version":VERSION,"evidence_set":next,"receipt":{
        "input_evidence_set_sha256":canonical_hash(es),"output_evidence_set_sha256":canonical_hash(&next),"context_sha256":canonical_hash(context),"snapshot_sha256":canonical_hash(&es["snapshot"]),
        "policy":{"max_fragment_utf16":MAX_FRAGMENT_UTF16,"max_fragments":MAX_FRAGMENTS,"max_context_utf16":MAX_CONTEXT_UTF16,"boundaries":"PARAGRAPH_THEN_BOUNDED_LINE_PUNCTUATION_OR_SCALAR","whitespace_preserved":true,"source_enlarged":false},
        "input_utf16":input_utf16,"output_utf16":output_utf16,"input_fragments":a(&es["fragments"]).len(),"output_fragments":a(&next["fragments"]).len(),"fragments":bindings,
        "validator":"RUST_P1_EVIDENCE_COMPOSE","semantic_support_certified":false,"publication_performed":false,"model_called":false
    }});
    // Preserve historical output byte-for-byte when no resource compaction was needed.
    if compact { result["receipt"]["policy"]["resource_compaction"] = json!("ADJACENT_SAME_PARENT_EXACT_SUBSPANS_MAX_640"); }
    Ok(result)
}

fn batch_output(es: &Value, context: &Value, fragments: Vec<Value>, bindings: Vec<Value>, input_utf16: usize, compact: bool, source_isolation: bool) -> Result<Value> {
    let mut batches = vec![];
    let mut first = 0;
    while first < fragments.len() {
        let mut end = first;
        let mut units = 0;
        while end < fragments.len() && end - first < MAX_FRAGMENTS {
            if source_isolation && end > first &&
                (fragments[end]["source_ref"] != fragments[first]["source_ref"] ||
                 fragments[end]["source_revision"] != fragments[first]["source_revision"]) { break; }
            let n = len(s(&fragments[end]["span"]["quote"]));
            if units + n > MAX_CONTEXT_UTF16 { break; }
            units += n;
            end += 1;
        }
        need(end > first, "FINE_SOURCE_BATCH_PARTITION_INVALID")?;
        let rows = &fragments[first..end];
        let mut next = es.clone();
        next["fragments"] = json!(rows);
        next["evidence_set_id"] = json!(format!("fine_batch_es_{}", &canonical_hash(&json!({"version":VERSION,"input":es,"index":batches.len(),"fragments":rows}))[..32]));
        let checked = compose(&next, context)?;
        need(checked["evidence_set"] == next, "FINE_SOURCE_COMPOSITION_CHANGED")?;
        batches.push(json!({"batch_index":batches.len(),"evidence_set":next,"receipt":{
            "input_evidence_set_sha256":canonical_hash(es),"output_evidence_set_sha256":canonical_hash(&next),"context_sha256":canonical_hash(context),"snapshot_sha256":canonical_hash(&es["snapshot"]),
            "output_utf16":units,"output_fragments":end-first,"fragments":bindings[first..end],
            "semantic_support_certified":false,"publication_performed":false,"model_called":false
        }}));
        first = end;
    }
    let output_utf16: usize = fragments.iter().map(|f| len(s(&f["span"]["quote"]))).sum();
    let batch_hashes: Vec<String> = batches.iter().map(canonical_hash).collect();
    let receipt = json!({"input_evidence_set_sha256":canonical_hash(es),"context_sha256":canonical_hash(context),"snapshot_sha256":canonical_hash(&es["snapshot"]),
        "policy":{"max_fragment_utf16":MAX_FRAGMENT_UTF16,"max_fragments_per_batch":MAX_FRAGMENTS,"max_context_utf16_per_batch":MAX_CONTEXT_UTF16,"adjacent_same_parent_compaction":compact,"whitespace_preserved":true,"source_enlarged":false},
        "input_utf16":input_utf16,"output_utf16":output_utf16,"input_fragments":a(&es["fragments"]).len(),"output_fragments":fragments.len(),"batch_count":batches.len(),"ordered_batch_sha256":batch_hashes,
        "coverage":"ALL_INPUT_SOURCE_SPANS_EXACT_PARTITION_WITH_IDENTICAL_SUBSPAN_DEDUPLICATION","omitted_fragments":0,"truncated":false,
        "validator":"RUST_P1_EVIDENCE_COMPOSE","semantic_support_certified":false,"publication_performed":false,"model_called":false});
    let mut receipt = receipt;
    if source_isolation { receipt["policy"]["source_isolation"] = json!("SOURCE_REF_AND_REVISION_V1"); }
    Ok(json!({"contract_version":VERSION,"batches":batches,"receipt":receipt,"receipt_sha256":canonical_hash(&receipt),"execution_performed":false}))
}

const SCOPE_TASK_PARTITION: &str = "SCOPE_TASK_GROUPS_OF_4_FULL_SOURCE_MATRIX_V1";
const MAX_SCOPE_TASKS_PER_GROUP: usize = 4;
const MAX_SCOPE_WORK_ITEMS: usize = 128;

// The same original evidence is intentionally reused for every task group.
// This is a complete context × task matrix, not a larger extraction budget or
// a claim that one model response exhausts all facts in the source text.
fn refine_scope_inner(es: &Value, context: &Value, scope_plan: &Value) -> Result<Value> {
    crate::document_scope_v1::execute("build_question", &json!({"plan":scope_plan,"current_snapshot":es["snapshot"]}))?;
    let tasks = scope_plan["tasks"].as_array().ok_or_else(||error("FINE_SOURCE_SCOPE_TASKS_REQUIRED","FINE_SOURCE_SCOPE_TASKS_REQUIRED"))?;
    need(!tasks.is_empty(), "FINE_SOURCE_SCOPE_TASKS_REQUIRED")?;
    let mut ids = BTreeSet::new();
    for task in tasks {
        need(task["id"].as_str().is_some_and(|id|!id.is_empty() && ids.insert(id.to_owned())), "FINE_SOURCE_SCOPE_TASK_ID_INVALID")?;
    }
    let base = refine_inner(es, context, true, false)?;
    let base_batches = a(&base["batches"]);
    need(!base_batches.is_empty(), "FINE_SOURCE_SCOPE_SOURCE_REQUIRED")?;
    let group_count = (tasks.len()+MAX_SCOPE_TASKS_PER_GROUP-1)/MAX_SCOPE_TASKS_PER_GROUP;
    let total = base_batches.len().checked_mul(group_count).filter(|n|*n<=MAX_SCOPE_WORK_ITEMS)
        .ok_or_else(||error("FINE_SOURCE_SCOPE_WORK_RESOURCE_LIMIT","FINE_SOURCE_SCOPE_WORK_RESOURCE_LIMIT"))?;
    let scope_hash = canonical_hash(scope_plan);
    let base_hash = canonical_hash(&base);
    let groups: Vec<Value> = tasks.chunks(MAX_SCOPE_TASKS_PER_GROUP).enumerate().map(|(index, rows)|{
        let ids:Vec<Value> = rows.iter().map(|r|r["id"].clone()).collect();
        let binding=json!({"policy":SCOPE_TASK_PARTITION,"scope_plan_sha256":scope_hash,"task_group_index":index,"scope_task_ids":ids});
        json!({"task_group_index":index,"scope_task_ids":ids,"task_group_sha256":canonical_hash(&binding)})
    }).collect();
    let mut batches=Vec::with_capacity(total);
    for group in &groups {
        for (base_index, source_batch) in base_batches.iter().enumerate() {
            let index=batches.len();let mut next=source_batch["evidence_set"].clone();
            let binding=json!({"policy":SCOPE_TASK_PARTITION,"scope_plan_sha256":scope_hash,"base_batch_plan_sha256":base_hash,"base_batch_index":base_index,"task_group_index":group["task_group_index"],"task_group_sha256":group["task_group_sha256"],"batch_index":index,"original_evidence_set_sha256":canonical_hash(&source_batch["evidence_set"])});
            next["evidence_set_id"]=json!(format!("fine_scope_batch_es_{}",&canonical_hash(&binding)[..32]));
            let checked=compose(&next,context)?;
            need(checked["evidence_set"]==next,"FINE_SOURCE_COMPOSITION_CHANGED")?;
            let mut receipt=source_batch["receipt"].clone();
            receipt["output_evidence_set_sha256"]=json!(canonical_hash(&next));
            receipt["base_batch_sha256"]=json!(canonical_hash(source_batch));
            receipt["scope_plan_sha256"]=json!(scope_hash);
            receipt["task_group_sha256"]=group["task_group_sha256"].clone();
            receipt["scope_task_ids"]=group["scope_task_ids"].clone();
            receipt["original_evidence_reused"]=json!(true);
            batches.push(json!({"batch_index":index,"base_batch_index":base_index,"task_group_index":group["task_group_index"],"scope_task_ids":group["scope_task_ids"],"evidence_set":next,"receipt":receipt}));
        }
    }
    let output_utf16:usize=batches.iter().map(|b|b["receipt"]["output_utf16"].as_u64().unwrap() as usize).sum();
    let output_fragments:usize=batches.iter().map(|b|a(&b["evidence_set"]["fragments"]).len()).sum();
    let hashes:Vec<String>=batches.iter().map(canonical_hash).collect();
    let receipt=json!({"input_evidence_set_sha256":canonical_hash(es),"context_sha256":canonical_hash(context),"snapshot_sha256":canonical_hash(&es["snapshot"]),
        "policy":{"task_partition":SCOPE_TASK_PARTITION,"max_scope_tasks_per_group":MAX_SCOPE_TASKS_PER_GROUP,"max_work_items":MAX_SCOPE_WORK_ITEMS,"max_fragment_utf16":MAX_FRAGMENT_UTF16,"max_fragments_per_batch":MAX_FRAGMENTS,"max_context_utf16_per_batch":MAX_CONTEXT_UTF16,"source_isolation":"MIXED_COMPACT_SOURCE_BATCHES","whitespace_preserved":true,"source_enlarged":false,"original_evidence_reused":true},
        "scope_plan_sha256":scope_hash,"scope_plan":scope_plan,"groups":groups,"task_count":tasks.len(),"group_count":group_count,"base_batch_plan_sha256":base_hash,"base_batch_receipt_sha256":base["receipt_sha256"],"base_batch_count":base_batches.len(),
        "input_utf16":base["receipt"]["input_utf16"],"unique_source_menu_utf16":base["receipt"]["output_utf16"],"output_utf16":output_utf16,"input_fragments":base["receipt"]["input_fragments"],"unique_source_menu_fragments":base["receipt"]["output_fragments"],"output_fragments":output_fragments,"batch_count":batches.len(),"ordered_batch_sha256":hashes,
        "coverage":"EVERY_SCOPE_TASK_GROUP_HAS_EVERY_COMPLETE_BASE_SOURCE_CONTEXT_BATCH","original_text_partition_per_group":true,"single_partition_claimed":false,"omitted_fragments":0,"omitted_scope_tasks":0,"truncated":false,"validator":"RUST_P1_EVIDENCE_COMPOSE","semantic_support_certified":false,"publication_performed":false,"model_called":false});
    Ok(json!({"contract_version":VERSION,"scope_plan":scope_plan,"groups":groups,"batches":batches,"receipt":receipt,"receipt_sha256":canonical_hash(&receipt),"execution_performed":false}))
}

pub fn execute(op: &str, payload: &Value) -> Result<Value> {
    match op {
        "refine_scope_batches" => {
            shape(payload, &["contract_version", "evidence_set", "context", "scope_plan"])?;
            need(payload["contract_version"] == VERSION, "FINE_SOURCE_VERSION_UNSUPPORTED")?;
            refine_scope_inner(&payload["evidence_set"],&payload["context"],&payload["scope_plan"])
        },
        "refine" | "refine_batches" | "refine_compact_batches" => {
            shape(payload, &["contract_version", "evidence_set", "context"])?;
            need(payload["contract_version"] == VERSION, "FINE_SOURCE_VERSION_UNSUPPORTED")?;
            // Opt-in multi-source packing changes only batch boundaries. The
            // original operation retains its source/revision isolation policy.
            // Absence of source_isolation in the receipt is the existing
            // non-isolated policy encoding consumed by validate_batches.
            refine_inner(&payload["evidence_set"], &payload["context"], op != "refine", op == "refine_batches")
        },
        "validate" | "validate_batches" => {
            shape(payload, &["contract_version", "evidence_set", "context", "refinement"])?;
            need(payload["contract_version"] == VERSION, "FINE_SOURCE_VERSION_UNSUPPORTED")?;
            let source_isolation = op == "validate_batches" && payload["refinement"]["receipt"]["policy"]["source_isolation"] == "SOURCE_REF_AND_REVISION_V1";
            let expected = if op == "validate_batches" && payload["refinement"]["receipt"]["policy"]["task_partition"] == SCOPE_TASK_PARTITION {
                refine_scope_inner(&payload["evidence_set"], &payload["context"], &payload["refinement"]["scope_plan"])?
            } else {refine_inner(&payload["evidence_set"], &payload["context"], op == "validate_batches", source_isolation)?};
            need(canonical_hash(&expected) == canonical_hash(&payload["refinement"]), "FINE_SOURCE_REFINEMENT_CHANGED")?;
            Ok(json!({"validated":true,"receipt_sha256":canonical_hash(&expected["receipt"]),"semantic_support_certified":false}))
        },
        _ => Err(error("FINE_SOURCE_OPERATION_UNKNOWN", "FINE_SOURCE_OPERATION_UNKNOWN"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partitions_preserve_unicode_crlf_and_exact_whitespace() {
        for text in ["😀 A\r\n\r\n标题::\r\n  if same file A AND B then abort.\r\n", &"😀".repeat(900), &format!("{}\r\nnext", "a".repeat(639))] {
            let rows = structural_parts(text);
            assert_eq!(rows.iter().map(|(a,b)| &text[*a..*b]).collect::<String>(), text);
            for (start,end) in rows { assert!(len(&text[start..end]) <= MAX_FRAGMENT_UTF16); assert!(!text[start..end].ends_with('\r') || !text[end..].starts_with('\n')); }
        }
    }
}
