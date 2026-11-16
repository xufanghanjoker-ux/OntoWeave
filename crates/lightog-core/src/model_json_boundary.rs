//! A single complete JSON value, optionally wrapped in one complete Markdown fence.
//! Model syntax/meaning is never repaired. The unwrapped text stays byte-preserving.
use crate::common::*;
use regex::Regex;
use serde_json::{json, Value};
use std::sync::OnceLock;

pub fn parse(raw: &str) -> Result<Value> {
    ensure(raw.len() <= 1024 * 1024, "SINGLE_JSON_RAW_INVALID")?;
    let ascii_ws = |c: char| matches!(c, ' ' | '\t' | '\n' | '\r');
    let fenced = raw.trim_start_matches(ascii_ws).starts_with("```");
    let json_text = if fenced {
        static FENCE: OnceLock<Regex> = OnceLock::new();
        let regex = FENCE.get_or_init(|| Regex::new(
            r"\A[\t\r\n ]*```(?:[jJ][sS][oO][nN])?[\t ]*\r?\n([\s\S]*)\r?\n```[\t\r\n ]*\z"
        ).expect("constant fence regex"));
        let captures = regex.captures(raw).ok_or_else(|| fail("SINGLE_JSON_FENCE_INVALID"))?;
        captures.get(1).expect("capture exists").as_str()
    } else { raw };
    // The existing Rust wire parser rejects duplicate keys, invalid syntax,
    // nonfinite numbers and trailing values before any serialization can occur.
    let parsed = crate::rpc::parse(json_text.as_bytes())?;
    let normalized = json_text.trim_matches(js_ws);
    Ok(json!({
        "parsed": parsed,
        "canonicalJson": normalized,
        "receipt": {
            "version": "lightog-single-json-envelope/0.1",
            "policy": "ONE_COMPLETE_JSON_OPTIONAL_OUTER_FENCE_ONLY",
            "outer_fence_removed": fenced,
            "raw_sha256": text_sha(raw),
            "raw_utf16": len(raw),
            "unwrapped_json_sha256": text_sha(json_text),
            "canonical_json_sha256": text_sha(normalized),
            "parsed_value_sha256": canonical_hash(&parsed),
            "canonical_json_policy": "TRIMMED_UNWRAPPED_JSON_NOT_RESERIALIZED",
            "duplicate_keys": "REJECTED_BEFORE_CANONICALIZATION",
            "syntax_repair": false,
            "semantic_fields_changed": false,
            "new_model_calls": 0
        }
    }))
}

pub fn execute(op: &str, payload: &Value) -> Result<Value> {
    ensure(op == "parse", "MODEL_JSON_OPERATION_UNKNOWN")?;
    let raw = payload["raw"].as_str().ok_or_else(|| fail("SINGLE_JSON_RAW_INVALID"))?;
    parse(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fence_and_raw_parse_have_identical_values() {
        let raw = r#"{"subject":"🦀","value":3}"#;
        let wrapped = format!(" \n```json\n{raw}\n```\n");
        let a = parse(raw).unwrap(); let b = parse(&wrapped).unwrap();
        assert_eq!(a["parsed"], b["parsed"]);
        assert_eq!(b["canonicalJson"], raw);
        assert_eq!(b["receipt"]["raw_utf16"], len(&wrapped));
        assert_eq!(b["receipt"]["syntax_repair"], false);
    }
    #[test]
    fn numeric_and_escape_text_is_never_reserialized() {
        let raw = r#"{"minus_zero":-0,"exponent":1e2,"escaped":"\u0041"}"#;
        let output = parse(raw).unwrap();
        assert_eq!(output["canonicalJson"], raw);
        assert_eq!(output["receipt"]["canonical_json_sha256"], text_sha(raw));
    }
    #[test]
    fn duplicate_even_when_escaped_and_nonfinite_are_rejected() {
        for raw in [r#"{"a":1,"\u0061":2}"#, r#"{"a":1e309}"#] {
            assert!(parse(raw).is_err(), "{raw}");
        }
    }
    #[test]
    fn commentary_multiple_json_and_invalid_fences_are_rejected() {
        for raw in ["Here is JSON:\n{}", "{} {}", "```json\n{}\n``` trailing", "```python\n{}\n```", "```json\n{}"] {
            assert!(parse(raw).is_err(), "{raw}");
        }
    }
}
