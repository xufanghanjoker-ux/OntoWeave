//! Versioned deterministic native-query kernel. No model, storage or adoption writes.
use crate::common::{error, Result};
use serde_json::{json, Value};

pub const VERSION: &str = "lightog-native-query-core/1";

pub fn execute(operation: &str, payload: &Value) -> Result<Value> {
    if payload["contract_version"] != VERSION {
        return Err(error("NATIVE_QUERY_CORE_VERSION_UNSUPPORTED", "NATIVE_QUERY_CORE_VERSION_UNSUPPORTED"));
    }
    let mut input = payload["input"].clone();
    if let Some(paths) = payload["negative_zero_paths"].as_array() {
        for path in paths {
            let segments = path.as_array().ok_or_else(|| error("NATIVE_QUERY_CORE_REQUEST_INVALID", "NATIVE_QUERY_CORE_REQUEST_INVALID"))?;
            let mut cursor = &mut input;
            for segment in segments {
                cursor = if let Some(key) = segment.as_str() { cursor.get_mut(key) }
                    else { segment.as_u64().and_then(|index| cursor.get_mut(index as usize)) }
                    .ok_or_else(|| error("NATIVE_QUERY_CORE_REQUEST_INVALID", "NATIVE_QUERY_CORE_REQUEST_INVALID"))?;
            }
            if cursor.as_f64() != Some(0.0) { return Err(error("NATIVE_QUERY_CORE_REQUEST_INVALID", "NATIVE_QUERY_CORE_REQUEST_INVALID")); }
            *cursor = serde_json::Number::from_f64(-0.0).map(Value::Number).unwrap();
        }
    }
    let input = &input;
    let result = match operation {
        "search_prepare" | "search_finish" | "search_validate_vector" | "entity_prepare" | "entity_status" | "fact_rows" =>
            crate::native_query_search_v1::execute(operation, input),
        "graph_entity_facts" | "graph_expand" | "graph_paths" =>
            crate::native_query_graph_v1::execute(operation, input),
        "compute_value" | "numeric_mention" | "evidence_span" =>
            crate::native_query_compute_v1::execute(operation, input),
        "capabilities" => Ok(json!({"algorithm_revision":"NATIVE_QUERY_BM25_RRF_V2","model_calls_performed":0,"publication_performed":false})),
        _ => Err(error("NATIVE_QUERY_CORE_OPERATION_UNKNOWN", "NATIVE_QUERY_CORE_OPERATION_UNKNOWN")),
    }?;
    Ok(json!({"contract_version":VERSION,"operation":operation,"result":result}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wire_and_operation_are_bound() {
        assert_eq!(execute("capabilities", &json!({"contract_version":"wrong"})).unwrap_err().code, "NATIVE_QUERY_CORE_VERSION_UNSUPPORTED");
        assert_eq!(execute("unknown", &json!({"contract_version":VERSION,"input":{}})).unwrap_err().code, "NATIVE_QUERY_CORE_OPERATION_UNKNOWN");
    }
    #[test]
    fn signed_zero_survives_the_json_boundary() {
        let value=execute("compute_value",&json!({"contract_version":VERSION,"input":{"operation":"ROUND_HALF_UP","values":[0.0]},"negative_zero_paths":[["values",0]]})).unwrap();
        assert!(value["result"]["value"].as_f64().unwrap().is_sign_negative());
    }
}
