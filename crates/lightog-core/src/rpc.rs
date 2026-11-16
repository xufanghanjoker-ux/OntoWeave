//! Duplicate-key rejecting finite JSON. Distinct from the integer-only demand wire.
use crate::common::*;
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{json, Map, Value};
use std::fmt;
pub const MAX_BYTES: usize = 64 * 1024 * 1024;
struct Strict(Value);
impl<'de> Deserialize<'de> for Strict {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Strict;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("finite JSON")
            }
            fn visit_unit<E>(self) -> std::result::Result<Strict, E> {
                Ok(Strict(Value::Null))
            }
            fn visit_bool<E>(self, v: bool) -> std::result::Result<Strict, E> {
                Ok(Strict(json!(v)))
            }
            fn visit_i64<E>(self, v: i64) -> std::result::Result<Strict, E> {
                Ok(Strict(json!(v)))
            }
            fn visit_u64<E>(self, v: u64) -> std::result::Result<Strict, E> {
                Ok(Strict(json!(v)))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<Strict, E> {
                if !v.is_finite() {
                    return Err(E::custom("CORE_NONFINITE_NUMBER"));
                }
                Ok(Strict(json!(v)))
            }
            fn visit_str<E>(self, v: &str) -> std::result::Result<Strict, E> {
                Ok(Strict(json!(v)))
            }
            fn visit_string<E>(self, v: String) -> std::result::Result<Strict, E> {
                Ok(Strict(json!(v)))
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Strict, A::Error> {
                let mut v = vec![];
                while let Some(x) = a.next_element::<Strict>()? {
                    v.push(x.0);
                }
                Ok(Strict(Value::Array(v)))
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Strict, A::Error> {
                let mut m = Map::new();
                while let Some((k, v)) = a.next_entry::<String, Strict>()? {
                    if m.insert(k, v.0).is_some() {
                        return Err(de::Error::custom("CORE_DUPLICATE_KEY"));
                    }
                }
                Ok(Strict(Value::Object(m)))
            }
        }
        d.deserialize_any(V)
    }
}
pub fn parse(raw: &[u8]) -> Result<Value> {
    if raw.len() > MAX_BYTES {
        return Err(error("CORE_RESOURCE_LIMIT", "record too large"));
    }
    let mut d = serde_json::Deserializer::from_slice(raw);
    let v = Strict::deserialize(&mut d).map_err(|e| {
        error(
            if e.to_string().contains("CORE_DUPLICATE_KEY") {
                "CORE_DUPLICATE_KEY"
            } else {
                "CORE_JSON_INVALID"
            },
            e.to_string(),
        )
    })?;
    d.end()
        .map_err(|e| error("CORE_JSON_INVALID", e.to_string()))?;
    Ok(v.0)
}
pub fn execute(v: &Value) -> Result<Value> {
    if v["wire_version"] != "lightog-core/0.1" {
        return Err(error(
            "CORE_VERSION_UNSUPPORTED",
            "unsupported core wire version",
        ));
    }
    ensure(
        v["request_id"].is_string() && !s(&v["request_id"]).is_empty(),
        "CORE_REQUEST_INVALID",
    )?;
    let p = &v["payload"];
    let op = s(&v["operation"]);
    match s(&v["module"]) {
        "temporal_core_v1" => crate::temporal_core_v1::execute(op,p),
        "model_json" => crate::model_json_boundary::execute(op,p),
        "source_support_gap" => crate::source_support_gap::execute(op,p),
        "source_support_gap_v2" => crate::source_support_gap_v2::execute(op,p),
        "source_gap_state" => crate::source_gap_state::execute(op,p),
        "source_gap_state_v2" => crate::source_gap_state_v2::execute(op,p),
        "source_gap_state_v3" => crate::source_gap_state_v3::execute(op,p),
        "source_answer" => crate::source_answer::execute(op,p),
        "source_execution_v1" => crate::source_execution_v1::execute(op,p),
        "source_human_review_v1" => crate::source_human_review_v1::execute(op,p),
        "source_proposal_replay_v1" => crate::source_proposal_replay_v1::execute(op,p),
        "source_answer_budget_v1" => crate::source_answer_budget_v1::execute(op,p),
        "fine_source_evidence" => crate::fine_source_evidence::execute(op,p),
        "p5_learning_store" => crate::p5_learning_store::execute(op,p),
        "source_learning_v1" => crate::source_learning_v1::execute(op,p),
        "seed_materialize" => crate::seed_materialize::execute(op,p),
        "p2_semantic_review" => crate::semantic_review::execute(op,p),
        "semantic_review_v2" => crate::semantic_review_v2::execute(op,p),
        "semantic_review_v3" => crate::semantic_review_v3::execute(op,p),
        "semantic_review_v4" => crate::semantic_review_v4::execute(op,p),
        "candidate_staging_v1" => crate::candidate_staging_v1::execute(op,p),
        "candidate_recovery_v1" => crate::candidate_recovery_v1::execute(op,p),
        "document_scope_v1" => crate::document_scope_v1::execute(op,p),
        "document_scope_coverage_v1" => crate::document_scope_coverage_v1::execute(op,p),
        "document_family_route_v1" => crate::document_family_route_v1::execute(op,p),
        "document_family_normalize_v1" => crate::document_family_normalize_v1::execute(op,p),
        "incremental_graph_v1" => crate::incremental_graph_v1::execute(op,p),
        "provider_schema_v1" => crate::provider_schema_v1::execute(op,p),
        "support_selection" => crate::support_selection::execute(op,p),
        "source_first_routing" => crate::evidence_routing::execute(op,p),
        "p2_menu" => crate::extraction_menu::execute(op,p),
        "p3_retrieval" => crate::hybrid_retrieval::execute(op,p),
        "native_query_v1" => crate::native_query_v1::execute(op,p),
        "p2_knowledge" => crate::knowledge_build::execute(op,p),
        "p1_evidence" => lightog_demand::evidence_bridge::execute(op,p).map_err(|e|error(e.code,e.code)),
        "p1_knowledge" => lightog_demand::knowledge_contract::execute(op,p).map_err(|e|error(e.code,e.code)),
        "p1_learning" => lightog_demand::learning_contract::execute(op,p).map_err(|e|error(e.code,e.code)),
        "adopted_cq" => match op {
            "compile" => crate::cq_compiler::compile(p),
            "check_plan" => crate::cq_compiler::check_plan(p),
            "check_declined" => crate::cq_compiler::check_declined(&p["record"]),
            "recognize" => crate::cq_compiler::recognize(s(&p["question"]), &p["raw"]),
            "audit" => crate::cq_compiler::audit(s(&p["question"]), &p["recognized"]),
            "passive_frames" => Ok(json!(crate::cq_compiler::passive_frames(s(&p["question"]))?)),
            _ => Err(error("CORE_OPERATION_UNKNOWN",op))
        },
        "adopted_context" => crate::adopted_context::execute(op,p),
        "answer" => crate::answer::execute(op, p),
        "capability" => crate::capability::execute(op, p),
        "demand" => crate::demand::execute(op, p),
        "model" => crate::model::execute(op, p),
        "evidence" => crate::evidence::execute(op, p),
        "structure" => crate::structure::execute(op, p),
        "retrieval" => crate::retrieval::execute(op, p),
        "learning" => crate::learning::execute(op, p),
        "review" => crate::review::execute(op, p),
        "governance" => crate::governance::execute(op, p),
        "primitives" => match op {
            "hash" => {
                Ok(json!({"json":js_stringify(p),"sha":sha(p),"canonical_hash":canonical_hash(p)}))
            }
            "compare" => Ok(json!(match locale_cmp(s(&p["left"]), s(&p["right"])) {
                std::cmp::Ordering::Less => -1,
                std::cmp::Ordering::Equal => 0,
                std::cmp::Ordering::Greater => 1,
            })),
            _ => Err(error("CORE_OPERATION_UNKNOWN", op)),
        },
        _ => Err(error("CORE_MODULE_UNKNOWN", s(&v["module"]))),
    }
}
pub fn response(raw: &[u8]) -> Value {
    let parsed = parse(raw);
    let id = parsed
        .as_ref()
        .ok()
        .and_then(|v| v.get("request_id"))
        .cloned()
        .unwrap_or(Value::Null);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        parsed.and_then(|v| execute(&v))
    }))
    .unwrap_or_else(|_| {
        Err(error(
            "CORE_INTERNAL_PANIC",
            "Rust core rejected an unsupported state",
        ))
    });
    match result {
        Ok(data) => json!({"request_id":id,"ok":true,"data":data}),
        Err(e) => {
            json!({"request_id":id,"ok":false,"error":{"code":e.code,"message":e.message,"details":e.details}})
        }
    }
}
