//! Product adapters around frozen adjacent/fragment policies. No new recall rules.
use crate::common::*;
use serde_json::{json, Value};
use std::collections::BTreeSet;
fn old<T>(r: lightog_demand::Result<T>) -> Result<T> {
    r.map_err(|e| error(e.code, e.code))
}
fn offsets(v: &Value) -> Value {
    json!({"source_id":v["source_id"],"start":v["start"],"end":v["end"]})
}
fn projected_sources(sources: &[Value], pages: bool) -> Vec<Value> {
    sources.iter().map(|source|{let blocks:Vec<Value>=a(&source["parsing"]["blocks"]).iter().map(|b|{
  let mut block=json!({"block_id":b.get("block_id").unwrap_or(&Value::Null),"kind":b["kind"],"start":b["start"],"end":b["end"]});
  if pages {let numbers:BTreeSet<u64>=a(&b["provenance"]).iter().filter_map(|p|p["page_no"].as_u64().filter(|n|*n>0)).collect();block["page_numbers"]=json!(numbers);}
  block
 }).collect();json!({"id":source["id"],"content":source["content"],"sha256":source["sha256"],"blocks":blocks})}).collect()
}
fn evidence_rows(evidence: &[Value]) -> Vec<Value> {
    evidence.iter().map(|e|json!({"source_id":e["source_id"],"source_sha256":e["source_sha256"],"start":e["start"],"end":e["end"],"quote":e["quote"]})).collect()
}
fn fragment_payload(sources: &[Value], evidence: &[Value], covered: Vec<Value>) -> Value {
    json!({"sources":projected_sources(sources,true),"evidence":evidence_rows(evidence),"covered":covered,"options":{"max_fragments":6,"max_fragment_chars":1200,"max_total_chars":2400,"max_distance":6000}})
}
fn fragments_for_plan(sources: &[Value], plan: &Value, evidence: &[Value]) -> Result<Value> {
    let selected = crate::retrieval::validate_plan(plan, sources, evidence)?;
    let mut covered = vec![];
    for unit in selected {
        covered.push(offsets(&unit));
        let source = sources
            .iter()
            .find(|s| s["id"] == unit["source_id"])
            .unwrap();
        let context =
            crate::model::execute("extraction_context", &json!({"source":source,"unit":unit}))?;
        for f in a(&context["fragments"]) {
            let mut f = f.clone();
            f["source_id"] = source["id"].clone();
            covered.push(offsets(&f));
        }
    }
    old(lightog_retrieval::fragments::plan(&fragment_payload(
        sources, evidence, covered,
    )))
}
pub fn augment_plan(p: &Value) -> Result<Value> {
    let sources = a(&p["sources"]);
    let evidence = a(&p["evidence"]);
    let base = &p["plan"];
    let all = crate::retrieval::extraction_units(sources, &json!({}))?;
    let unit_rows:Vec<Value>=all.iter().map(|u|json!({"id":u["id"],"source_id":u["source_id"],"source_sha256":u["source_sha256"],"start":u["start"],"end":u["end"],"text":u["text"],"offset_unit":u["offset_unit"]})).collect();
    let adjacent = old(lightog_retrieval::plan(
        "adjacent",
        &json!({"sources":projected_sources(sources,false),"units":unit_rows,"evidence":evidence_rows(evidence),"baseline_unit_ids":base["unit_ids"],"evidence_unit_ids":base["evidence_unit_ids"],"options":{"max_context_units":2,"edge_chars":1200,"max_context_chars":12000}}),
    ))?;
    let mut plan = base.clone();
    for (k, v) in adjacent.as_object().unwrap() {
        plan[k] = v.clone();
    }
    plan["source_fragments"] = fragments_for_plan(sources, &plan, evidence)?;
    plan["fragment_admission_evidence"] = json!(evidence_rows(evidence));
    plan["coverage"] = json!("LOCAL_RETRIEVAL_NOT_EXHAUSTIVE");
    Ok(plan)
}
pub fn unit_context(p: &Value) -> Result<Value> {
    let plan = &p["plan"];
    if plan["source_fragments"].is_null() {
        return Ok(json!([]));
    }
    let sources = a(&p["sources"]);
    crate::retrieval::validate_plan(plan, sources, a(&plan["fragment_admission_evidence"]))?;
    let unit = &p["unit"];
    // Re-evaluate the frozen fragment policy against exactly the recorded windows.
    // No second adjacency expansion, no trusted model-authored supplemental spans.
    let regenerated = fragments_for_plan(sources, plan, a(&plan["fragment_admission_evidence"]))?;
    if regenerated != plan["source_fragments"] {
        return Err(error(
            "FRAGMENT_LAYOUT_OR_PLAN_STALE",
            "FRAGMENT_LAYOUT_OR_PLAN_STALE",
        ));
    }
    let mut out = vec![];
    for f in a(&plan["source_fragments"]["fragments"]) {
        let source = sources
            .iter()
            .find(|s| s["id"] == f["source_id"])
            .ok_or_else(|| error("FRAGMENT_SOURCE_STALE", "FRAGMENT_SOURCE_STALE"))?;
        if source["sha256"] != f["source_sha256"]
            || sha(&source["content"]) != source["sha256"]
            || slice16(
                s(&source["content"]),
                f["start"].as_u64().unwrap_or(usize::MAX as u64) as usize,
                f["end"].as_u64().unwrap_or(0) as usize,
            ) != s(&f["quote"])
        {
            return Err(error("FRAGMENT_SOURCE_STALE", "FRAGMENT_SOURCE_STALE"));
        }
        if f["source_id"] == unit["source_id"]
            && a(&f["anchor_spans"]).iter().any(|e| {
                e["source_id"] == unit["source_id"]
                    && e["start"].as_u64() < unit["end"].as_u64()
                    && e["end"].as_u64() > unit["start"].as_u64()
            })
        {
            out.push(json!({"source_id":f["source_id"],"start":f["start"],"end":f["end"],"text":f["quote"],"kind":f["kind"],"adopted_policy":lightog_retrieval::fragments::VERSION,"context_only":true}));
        }
    }
    Ok(json!(out))
}
pub fn answer_evidence(p: &Value) -> Result<Value> {
    let job = &p["job"];
    let claims = a(&p["claims"]);
    let sources = a(&job["input"]["sources"]);
    let mut index = crate::answer::build_evidence(job, &p["claims"])?;
    if claims.is_empty() {
        return Ok(index);
    }
    // The frozen policy is bounded at 128 anchors. Explicitly retain legacy evidence above it.
    if claims.len() > 128 {
        for row in index.as_object_mut().unwrap().values_mut() {
            row["context"]["supplement_status"] = json!("NOT_APPLIED_ANCHOR_RESOURCE_LIMIT");
        }
        return Ok(index);
    }
    let evidence: Vec<Value> = claims
        .iter()
        .map(|c| {
            let mut e = c.clone();
            e["source_sha256"] =
                sources.iter().find(|s| s["id"] == c["source_id"]).unwrap()["sha256"].clone();
            e
        })
        .collect();
    let covered = index
        .as_object()
        .unwrap()
        .values()
        .flat_map(|row| {
            a(&row["context"]["segments"])
                .iter()
                .map(|s| json!({"source_id":row["source_id"],"start":s["start"],"end":s["end"]}))
        })
        .collect();
    let supplement = old(lightog_retrieval::fragments::plan(&fragment_payload(
        sources, &evidence, covered,
    )))?;
    let mut assigned = BTreeSet::new();
    for row in index.as_object_mut().unwrap().values_mut() {
        let additions: Vec<Value> = a(&supplement["fragments"])
            .iter()
            .filter(|f| {
                a(&f["anchor_spans"]).iter().any(|e| {
                    e["source_id"] == row["source_id"]
                        && e["start"] == row["start"]
                        && e["end"] == row["end"]
                })
            })
            .filter(|f| assigned.insert(js_stringify(&offsets(f))))
            .cloned()
            .collect();
        row["context"]["source_fragments"] = json!(additions);
        row["context"]["supplement_status"] = json!("APPLIED");
        row["context"]["supplement_policy"] = json!(lightog_retrieval::fragments::VERSION);
    }
    Ok(index)
}
pub fn execute(op: &str, p: &Value) -> Result<Value> {
    match op {
        "fragments" => old(lightog_retrieval::fragments::plan(p)),
        "augment_plan" => augment_plan(p),
        "unit_context" => unit_context(p),
        "answer_evidence" => answer_evidence(p),
        "review_context" => Ok(json!(p["index"]
            .as_object()
            .into_iter()
            .flat_map(|index| index.values())
            .flat_map(|row| a(&row["context"]["source_fragments"]).iter().cloned())
            .collect::<Vec<_>>())),
        _ => Err(error("CORE_OPERATION_UNKNOWN", op)),
    }
}
