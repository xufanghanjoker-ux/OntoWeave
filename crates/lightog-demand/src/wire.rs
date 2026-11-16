//! Strict JSON, canonical bytes and exact UTF-16 positions. No I/O or normalization.
use crate::{need, Error, Result};
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fmt};

pub const MAX_INPUT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_DEPTH: usize = 96;
const SAFE: i64 = 9_007_199_254_740_991;

fn numeric_policy(text: &str) -> Result<()> {
    let bytes = text.as_bytes();
    let mut i = 0;
    let mut depth = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'\\' {
                    i += 2;
                } else if bytes[i] == b'"' {
                    i += 1;
                    break;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        match bytes[i] {
            b'{' | b'[' => {
                depth += 1;
                need(depth <= MAX_DEPTH, "WIRE_RESOURCE_LIMIT")?;
            }
            b'}' | b']' => {
                depth = depth.saturating_sub(1);
            }
            _ => {}
        }
        if bytes[i] == b'-' || bytes[i].is_ascii_digit() {
            let begin = i;
            i += 1;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || b".eE+-".contains(&bytes[i])) {
                i += 1;
            }
            let token = &text[begin..i];
            if token == "-0" {
                return Err(Error::new("WIRE_NEGATIVE_ZERO"));
            }
            if token.bytes().any(|c| b".eE".contains(&c)) {
                return Err(Error::new("WIRE_FLOAT_NOT_ALLOWED"));
            }
            let n = token
                .parse::<i128>()
                .map_err(|_| Error::new("WIRE_INTEGER_RANGE"))?;
            need(n.unsigned_abs() <= SAFE as u128, "WIRE_INTEGER_RANGE")?;
            continue;
        }
        i += 1;
    }
    Ok(())
}
// Before syntax validation, recognize only exact unquoted non-JSON numeric constants.
fn nonfinite(text: &str) -> bool {
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'"' {
            i += 1;
            while i < b.len() {
                if b[i] == b'\\' {
                    i += 2;
                } else if b[i] == b'"' {
                    i += 1;
                    break;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        for s in ["NaN", "Infinity", "-Infinity"] {
            if (i == 0 || b"[:, \r\n\t".contains(&b[i - 1])) && text[i..].starts_with(s) {
                let end = i + s.len();
                if end == b.len() || b",]} \r\n\t".contains(&b[end]) {
                    return true;
                }
            }
        }
        // Only slice text at character boundaries.
        i += text[i..].chars().next().unwrap().len_utf8();
    }
    false
}
struct Strict;
impl<'de> DeserializeSeed<'de> for Strict {
    type Value = Value;
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> std::result::Result<Value, D::Error> {
        d.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for Strict {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("strict JSON")
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<Value, E> {
        Ok(Value::Bool(v))
    }
    fn visit_unit<E: de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Value, E> {
        if v.unsigned_abs() > SAFE as u64 {
            return Err(E::custom("WIRE_INTEGER_RANGE"));
        }
        Ok(v.into())
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<Value, E> {
        if v > SAFE as u64 {
            return Err(E::custom("WIRE_INTEGER_RANGE"));
        }
        Ok(v.into())
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> std::result::Result<Value, E> {
        Err(E::custom("WIRE_FLOAT_NOT_ALLOWED"))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<Value, E> {
        Ok(v.into())
    }
    fn visit_string<E: de::Error>(self, v: String) -> std::result::Result<Value, E> {
        Ok(v.into())
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> std::result::Result<Value, A::Error> {
        let mut v = Vec::new();
        while let Some(x) = a.next_element_seed(Strict)? {
            v.push(x);
        }
        Ok(Value::Array(v))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> std::result::Result<Value, A::Error> {
        let mut out = Map::new();
        while let Some(k) = a.next_key::<String>()? {
            if out.contains_key(&k) {
                return Err(de::Error::custom("WIRE_DUPLICATE_KEY"));
            }
            out.insert(k, a.next_value_seed(Strict)?);
        }
        Ok(Value::Object(out))
    }
}
// These serde_json errors specifically describe an unpaired UTF-16 escape.
// A truncated or non-hex \u escape remains WIRE_INVALID_JSON.
fn unicode_error(message: &str) -> bool {
    message.contains("surrogate") || message.contains("unexpected end of hex escape")
}
pub fn strict_load(raw: &[u8]) -> Result<Value> {
    need(raw.len() <= MAX_INPUT_BYTES, "WIRE_RESOURCE_LIMIT")?;
    need(
        !raw.starts_with(&[0xef, 0xbb, 0xbf]),
        "WIRE_BOM_NOT_ALLOWED",
    )?;
    let text = std::str::from_utf8(raw).map_err(|_| Error::new("WIRE_INVALID_JSON"))?;
    if nonfinite(text) {
        return Err(Error::new("WIRE_FLOAT_NOT_ALLOWED"));
    }
    // Syntax is checked without converting numbers, preserving their lexical identity.
    serde_json::from_str::<Box<serde_json::value::RawValue>>(text).map_err(|e| {
        if e.to_string().contains("recursion limit") {
            Error::new("WIRE_RESOURCE_LIMIT")
        } else if unicode_error(&e.to_string()) {
            Error::new("WIRE_INVALID_UNICODE")
        } else {
            Error::new("WIRE_INVALID_JSON")
        }
    })?;
    numeric_policy(text)?;
    let mut d = serde_json::Deserializer::from_str(text);
    let result = Strict.deserialize(&mut d).map_err(|e| {
        let message = e.to_string();
        for code in [
            "WIRE_DUPLICATE_KEY",
            "WIRE_INTEGER_RANGE",
            "WIRE_FLOAT_NOT_ALLOWED",
        ] {
            if message.contains(code) {
                return Error::new(code);
            }
        }
        if unicode_error(&message) {
            Error::new("WIRE_INVALID_UNICODE")
        } else {
            Error::new("WIRE_INVALID_JSON")
        }
    })?;
    d.end().map_err(|_| Error::new("WIRE_INVALID_JSON"))?;
    Ok(result)
}
fn canonical_check(v: &Value, depth: usize) -> Result<()> {
    need(depth <= MAX_DEPTH, "WIRE_RESOURCE_LIMIT")?;
    match v {
        Value::Number(n) => {
            let valid = n
                .as_i64()
                .map(|v| v.unsigned_abs() <= SAFE as u64)
                .or_else(|| n.as_u64().map(|v| v <= SAFE as u64))
                .unwrap_or(false);
            need(valid, "WIRE_FLOAT_NOT_ALLOWED")?;
        }
        Value::Object(m) => {
            for (k, v) in m {
                let mut c = k.bytes();
                need(
                    c.next().is_some_and(|c| c.is_ascii_lowercase())
                        && c.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_'),
                    "WIRE_NON_ASCII_KEY",
                )?;
                canonical_check(v, depth + 1)?;
            }
        }
        Value::Array(a) => {
            for v in a {
                canonical_check(v, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}
pub fn canonical(v: &Value) -> Result<Vec<u8>> {
    canonical_check(v, 0)?;
    fn sorted(v: &Value) -> Value {
        match v {
            Value::Object(m) => {
                let keys: BTreeSet<_> = m.keys().collect();
                Value::Object(
                    keys.into_iter()
                        .map(|k| (k.clone(), sorted(&m[k])))
                        .collect(),
                )
            }
            Value::Array(a) => Value::Array(a.iter().map(sorted).collect()),
            _ => v.clone(),
        }
    }
    serde_json::to_vec(&sorted(v)).map_err(|_| Error::new("WIRE_INVALID_JSON"))
}
pub fn text_sha(text: &str) -> String {
    bytes_sha(text.as_bytes())
}
pub fn bytes_sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn sha(v: &Value) -> Result<String> {
    Ok(bytes_sha(&canonical(v)?))
}
#[derive(Debug, serde::Serialize)]
pub struct SpanResolution {
    pub text: String,
    pub utf8_start: usize,
    pub utf8_end: usize,
    pub utf16_length: usize,
    pub utf8_length: usize,
}
pub fn span_text(text: &str, span: &Value) -> Result<SpanResolution> {
    let a = span
        .get("start")
        .and_then(Value::as_u64)
        .ok_or_else(|| Error::new("SPAN_RANGE_INVALID"))? as usize;
    let b = span
        .get("end")
        .and_then(Value::as_u64)
        .ok_or_else(|| Error::new("SPAN_RANGE_INVALID"))? as usize;
    let length = text.encode_utf16().count();
    need(a < b && b <= length, "SPAN_RANGE_INVALID")?;
    let mut utf16 = 0;
    let (mut left, mut right) = (None, None);
    for (byte, c) in text.char_indices() {
        if utf16 == a {
            left = Some(byte);
        }
        if utf16 == b {
            right = Some(byte);
        }
        utf16 += c.len_utf16();
    }
    if b == utf16 {
        right = Some(text.len());
    }
    let left = left.ok_or_else(|| Error::new("SPAN_SPLITS_SURROGATE"))?;
    let right = right.ok_or_else(|| Error::new("SPAN_SPLITS_SURROGATE"))?;
    let quote = &text[left..right];
    if let Some(expected) = span.get("quote") {
        need(expected.as_str() == Some(quote), "SPAN_QUOTE_MISMATCH")?;
    }
    Ok(SpanResolution {
        text: quote.into(),
        utf8_start: left,
        utf8_end: right,
        utf16_length: length,
        utf8_length: text.len(),
    })
}
