//! Frozen native-query arithmetic and exact-source primitives.
use crate::common::{error, len, Result};
use regex::Regex;
use serde_json::{json, Value};
use std::sync::OnceLock;
fn need(ok: bool, code: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(error(code, code))
    }
}
fn safe_integer(value: &Value) -> Option<f64> {
    value.as_f64().filter(|number| {
        number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0
    })
}
pub fn execute(op: &str, payload: &Value) -> Result<Value> {
    match op {
        "numeric_mention" => {
            static NUMBER: OnceLock<Regex> = OnceLock::new();
            let regex = NUMBER.get_or_init(|| Regex::new(r"[-+]?[0-9]+(?:\.[0-9]+)?").unwrap());
            let value = payload["value"].as_f64();
            let text = payload["text"].as_str().unwrap_or("");
            Ok(json!(value.is_some_and(|value| regex.find_iter(text).any(
                |matched| matched.as_str().parse::<f64>().ok() == Some(value)
            ))))
        }
        "evidence_span" => {
            let valid = if let (Some(content), Some(quote), Some(start), Some(end)) = (
                payload["content"].as_str(),
                payload["quote"].as_str(),
                safe_integer(&payload["start"]),
                safe_integer(&payload["end"]),
            ) {
                start >= 0.0
                    && end > start
                    && end <= len(content) as f64
                    && content
                        .encode_utf16()
                        .skip(start as usize)
                        .take((end - start) as usize)
                        .eq(quote.encode_utf16())
            } else {
                false
            };
            Ok(json!(valid))
        }
        "compute_value" => {
            let values = payload["values"].as_array().ok_or_else(|| {
                error(
                    "QUERY_COMPUTE_RESULT_INVALID",
                    "QUERY_COMPUTE_RESULT_INVALID",
                )
            })?;
            let values: Vec<f64> = values
                .iter()
                .map(|value| {
                    value.as_f64().ok_or_else(|| {
                        error(
                            "QUERY_COMPUTE_RESULT_INVALID",
                            "QUERY_COMPUTE_RESULT_INVALID",
                        )
                    })
                })
                .collect::<Result<_>>()?;
            let operation = payload["operation"].as_str().unwrap_or("");
            let result = match operation {
                "SUM" => values.iter().fold(0.0, |sum, value| sum + value),
                "MULTIPLY" => values.iter().fold(1.0, |product, value| product * value),
                "WEIGHTED_SUM" => {
                    let weights = payload["weights"].as_array();
                    need(
                        weights.is_some_and(|weights| weights.len() == values.len()),
                        "QUERY_COMPUTE_WEIGHTS_REQUIRED",
                    )?;
                    let weights: Vec<f64> = weights
                        .unwrap()
                        .iter()
                        .map(|value| {
                            value.as_f64().ok_or_else(|| {
                                error(
                                    "QUERY_COMPUTE_RESULT_INVALID",
                                    "QUERY_COMPUTE_RESULT_INVALID",
                                )
                            })
                        })
                        .collect::<Result<_>>()?;
                    values
                        .iter()
                        .zip(weights)
                        .fold(0.0, |sum, (value, weight)| sum + value * weight)
                }
                "DIVIDE" => {
                    need(
                        values.len() == 2 && values[1] != 0.0,
                        "QUERY_COMPUTE_DIVISION_INVALID",
                    )?;
                    values[0] / values[1]
                }
                "CEIL" => {
                    need(values.len() == 1, "QUERY_COMPUTE_ARITY")?;
                    values[0].ceil()
                }
                "ROUND_HALF_UP" => {
                    need(values.len() == 1, "QUERY_COMPUTE_ARITY")?;
                    let digits = payload
                        .get("digits")
                        .filter(|value| !value.is_null())
                        .and_then(Value::as_f64)
                        .unwrap_or(2.0);
                    let scale = 10f64.powf(digits);
                    let n = values[0] * scale;
                    let sign = if n == 0.0 { n } else { n.signum() };
                    sign * (n.abs() + 0.5 + f64::EPSILON * 1f64.max(n.abs())).floor() / scale
                }
                _ => f64::NAN,
            };
            need(result.is_finite(), "QUERY_COMPUTE_RESULT_INVALID")?;
            Ok(json!({"value":result}))
        }
        _ => Err(error("NATIVE_QUERY_CORE_OPERATION_UNKNOWN", op)),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arithmetic_preserves_js_floating_order() {
        assert_eq!(
            execute(
                "compute_value",
                &json!({"operation":"SUM","values":[1e16,-1e16,1]})
            )
            .unwrap(),
            json!({"value":1.0})
        );
        assert_eq!(
            execute(
                "compute_value",
                &json!({"operation":"ROUND_HALF_UP","values":[-1.005],"digits":2})
            )
            .unwrap(),
            json!({"value":-1.01})
        );
    }
    #[test]
    fn input_numbers_are_ascii_regex_mentions() {
        assert_eq!(
            execute(
                "numeric_mention",
                &json!({"text":"１２.５ / 12.5 / 1e3","value":12.5})
            )
            .unwrap(),
            true
        );
        assert_eq!(
            execute("numeric_mention", &json!({"text":"１２.５","value":12.5})).unwrap(),
            false
        );
    }
    #[test]
    fn unicode_spans_use_utf16_not_bytes() {
        assert_eq!(
            execute(
                "evidence_span",
                &json!({"content":"甲😀乙","start":1,"end":3,"quote":"😀"})
            )
            .unwrap(),
            true
        );
        assert_eq!(
            execute(
                "evidence_span",
                &json!({"content":"甲😀乙","start":1,"end":2,"quote":"😀"})
            )
            .unwrap(),
            false
        );
        assert_eq!(
            execute(
                "evidence_span",
                &json!({"content":"甲😀乙","start":1,"end":2,"quote":"�"})
            )
            .unwrap(),
            false
        );
    }
    #[test]
    fn division_and_overflow_keep_error_codes() {
        assert_eq!(
            execute(
                "compute_value",
                &json!({"operation":"DIVIDE","values":[1,0]})
            )
            .unwrap_err()
            .code,
            "QUERY_COMPUTE_DIVISION_INVALID"
        );
        assert_eq!(
            execute(
                "compute_value",
                &json!({"operation":"MULTIPLY","values":[1e308,10]})
            )
            .unwrap_err()
            .code,
            "QUERY_COMPUTE_RESULT_INVALID"
        );
    }
}
