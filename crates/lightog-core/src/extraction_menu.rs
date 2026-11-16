//! Exact source menus owned by the host, never by a language model.
//! This does not infer mentions, identity, predicates or semantic support.
use crate::common::{a, canonical_hash, error, js_ws, s, Result};
use serde_json::{json, Value};

pub const VERSION: &str = "lightog-extraction-menu/0.1";

fn need(ok: bool, code: &str) -> Result<()> {
    if ok { Ok(()) } else { Err(error(code, code)) }
}

// Boundaries use Rust character indices, then explicitly count UTF-16. No
// normalization, lossy slices, model offsets or string-search relocation.
fn ranges(text: &str, max_utf16: usize, max_items: usize) -> Result<Vec<(usize, usize)>> {
    let mut chars = text.char_indices().peekable();
    let mut result = vec![];
    let mut push = |begin: usize, end: usize| -> Result<()> {
        let raw = &text[begin..end];
        let trimmed = raw.trim_matches(js_ws);
        if trimmed.is_empty() { return Ok(()); }
        need(result.len() < max_items, "MENU_RESOURCE_LIMIT")?;
        let left = raw.len() - raw.trim_start_matches(js_ws).len();
        result.push((begin + left, begin + left + trimmed.len()));
        Ok(())
    };
    let mut begin = 0;
    let mut size = 0;
    while let Some((byte, c)) = chars.next() {
        if size + c.len_utf16() > max_utf16 {
            push(begin, byte)?;
            begin = byte;
            size = 0;
        }
        size += c.len_utf16();
        let end = byte + c.len_utf8();
        let next = chars.peek().map(|(_, c)| *c);
        let sentence = matches!(c, '。' | '！' | '？')
            || matches!(c, '.' | '!' | '?') && next.is_none_or(js_ws);
        let paragraph = c == '\n' && next == Some('\n');
        let hard = size >= max_utf16;
        if sentence || paragraph || hard {
            push(begin, end)?;
            begin = end;
            size = 0;
        }
    }
    if begin < text.len() { push(begin, text.len())?; }
    Ok(result)
}

pub fn execute(op: &str, payload: &Value) -> Result<Value> {
    need(op == "prepare", "MENU_OPERATION_UNKNOWN")?;
    need(serde_json::to_vec(payload).map_err(|_| error("MENU_SHAPE_INVALID", "MENU_SHAPE_INVALID"))?.len() <= 8 * 1024 * 1024, "MENU_RESOURCE_LIMIT")?;
    let obj = payload.as_object().ok_or_else(|| error("MENU_SHAPE_INVALID", "MENU_SHAPE_INVALID"))?;
    need(["evidence_set_ref", "cq_guidance", "trusted_context"].iter().all(|k| obj.contains_key(*k))
        && obj.keys().all(|k| ["evidence_set_ref", "cq_guidance", "trusted_context", "options"].contains(&k.as_str())), "MENU_SHAPE_INVALID")?;
    let opts = payload.get("options").cloned().unwrap_or(json!({}));
    let opts = opts.as_object().ok_or_else(|| error("MENU_SHAPE_INVALID", "MENU_SHAPE_INVALID"))?;
    need(opts.keys().all(|k| ["max_segment_utf16", "max_menu_items"].contains(&k.as_str())), "MENU_SHAPE_INVALID")?;
    let limit = |key: &str, default: u64, min: u64, max: u64| -> Result<usize> {
        let n = match opts.get(key) { Some(v) => v.as_u64().ok_or_else(|| error("MENU_RESOURCE_LIMIT", "MENU_RESOURCE_LIMIT"))?, None => default };
        need((min..=max).contains(&n), "MENU_RESOURCE_LIMIT")?;
        Ok(n as usize)
    };
    let max_segment = limit("max_segment_utf16", 1000, 32, 4000)?;
    let max_items = limit("max_menu_items", 128, 1, 128)?;
    let checked = crate::knowledge_build::prepare_extract(&json!({
        "evidence_set_ref":payload["evidence_set_ref"], "cq_guidance":payload["cq_guidance"], "trusted_context":payload["trusted_context"]
    }))?;
    let matches: Vec<_> = payload["trusted_context"]["examples"].as_object()
        .ok_or_else(|| error("MENU_SHAPE_INVALID", "MENU_SHAPE_INVALID"))?.values()
        .filter(|v| v["evidence_set_id"] == payload["evidence_set_ref"]).collect();
    need(matches.len() == 1, "MENU_EVIDENCE_SET_AMBIGUOUS")?;
    let parent = matches[0];
    let mut fragments = vec![];
    let mut provenance = vec![];
    let mut ids = std::collections::BTreeSet::new();
    for f in a(&parent["fragments"]) {
        need(f["origin"] == "SOURCE_FRAGMENT", "MENU_SOURCE_FRAGMENT_REQUIRED")?;
        let text = s(&f["span"]["quote"]);
        let origin = f["span"]["start"].as_u64().ok_or_else(|| error("MENU_SHAPE_INVALID", "MENU_SHAPE_INVALID"))?;
        for (byte_start, byte_end) in ranges(text, max_segment, max_items - fragments.len())? {
            let start = origin + text[..byte_start].encode_utf16().count() as u64;
            let end = start + text[byte_start..byte_end].encode_utf16().count() as u64;
            let span = json!({"start":start,"end":end,"quote":&text[byte_start..byte_end],"offset_unit":"utf16_code_unit"});
            let id = format!("seg_{}", &canonical_hash(&json!({"policy":VERSION,"snapshot":parent["snapshot"],"source_ref":f["source_ref"],"source_revision":f["source_revision"],"block_ref":f["block_ref"],"span":span}))[..24]);
            if !ids.insert(id.clone()) { continue; }
            need(fragments.len() < max_items, "MENU_RESOURCE_LIMIT")?;
            let mut fragment = f.clone(); fragment["id"] = json!(id); fragment["span"] = span;
            provenance.push(json!({"evidence_id":id,"parent_evidence_id":f["id"],"parent_evidence_set_ref":parent["evidence_set_id"]}));
            fragments.push(fragment);
        }
    }
    let es_id = format!("esm_{}", &canonical_hash(&json!({"policy":VERSION,"snapshot":parent["snapshot"],"fragments":fragments}))[..24]);
    let es = json!({"contract_version":"lightog-demand/0.1","evidence_set_id":es_id,"snapshot":parent["snapshot"],"fragments":fragments});
    // Validate the actual generated fragments through the same P1 source checks.
    let mut ctx = payload["trusted_context"].clone();
    ctx["examples"].as_object_mut().unwrap().insert(es_id.clone(), es.clone());
    let prepared = crate::knowledge_build::prepare_extract(&json!({"evidence_set_ref":es_id,"cq_guidance":payload["cq_guidance"],"trusted_context":ctx}))?;
    need(checked["payload"]["snapshot"] == prepared["payload"]["snapshot"], "BUILD_SNAPSHOT_MISMATCH")?;
    Ok(json!({"contract_version":VERSION,"evidence_set":es,"provenance":provenance,"prepared":prepared,"options":{"max_segment_utf16":max_segment,"max_menu_items":max_items},"model_called":false,"semantic_support_certified":false}))
}
