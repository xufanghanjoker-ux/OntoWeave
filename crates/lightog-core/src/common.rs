//! Compatibility primitives, not a new domain algorithm.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{cmp::Ordering, fmt, sync::OnceLock};

#[derive(Debug, Clone)]
pub struct CoreError {
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}
impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for CoreError {}
pub type Result<T> = std::result::Result<T, CoreError>;
pub fn error(code: impl Into<String>, message: impl Into<String>) -> CoreError {
    CoreError {
        code: code.into(),
        message: message.into(),
        details: None,
    }
}
pub fn fail(message: impl Into<String>) -> CoreError {
    error("CORE_ASSERTION", message)
}
pub fn ensure(ok: bool, message: impl Into<String>) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(fail(message))
    }
}
pub fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub fn a(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
pub fn len(s: &str) -> usize {
    s.encode_utf16().count()
}
pub fn js_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\r' | '\u{b}' | '\u{c}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
pub fn nonempty(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|s| !s.trim_matches(js_ws).is_empty())
}
pub fn slice16(s: &str, start: usize, end: usize) -> String {
    let u: Vec<u16> = s.encode_utf16().collect();
    let start = start.min(u.len());
    let end = end.min(u.len()).max(start);
    String::from_utf16_lossy(&u[start..end])
}
pub fn index_of(s: &str, needle: &str, from: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(from.min(len(s)));
    }
    let mut at = 0;
    for (p, c) in s.char_indices() {
        if at >= from && s[p..].starts_with(needle) {
            return Some(at);
        }
        at += c.len_utf16();
    }
    None
}
fn index_key(k: &str) -> Option<u32> {
    k.parse::<u32>()
        .ok()
        .filter(|n| *n != u32::MAX && n.to_string() == k)
}
pub fn js_stringify(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => {
            let n = n.as_f64().unwrap();
            if !n.is_finite() {
                "null".into()
            } else {
                ryu_js::Buffer::new().format(n).to_string()
            }
        }
        Value::String(s) => serde_json::to_string(s).unwrap(),
        Value::Array(v) => format!(
            "[{}]",
            v.iter().map(js_stringify).collect::<Vec<_>>().join(",")
        ),
        Value::Object(m) => {
            let mut keys: Vec<_> = m.keys().collect();
            keys.sort_by(|a, b| match (index_key(a), index_key(b)) {
                (Some(a), Some(b)) => a.cmp(&b),
                (Some(_), None) => Ordering::Less,
                (None, Some(_)) => Ordering::Greater,
                _ => Ordering::Equal,
            });
            format!(
                "{{{}}}",
                keys.iter()
                    .map(|k| format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap(),
                        js_stringify(&m[*k])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}
pub fn text_sha(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
pub fn sha(v: &Value) -> String {
    match v {
        Value::String(s) => text_sha(s),
        _ => text_sha(&js_stringify(v)),
    }
}
pub fn canonical(v: &Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(canonical).collect()),
        Value::Object(m) => {
            let mut keys: Vec<_> = m.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            Value::Object(
                keys.into_iter()
                    .map(|k| (k.clone(), canonical(&m[k])))
                    .collect(),
            )
        }
        _ => v.clone(),
    }
}
pub fn canonical_hash(v: &Value) -> String {
    text_sha(&js_stringify(&canonical(v)))
}
pub fn valid_date(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(i, b)| i != 4 && i != 7 && !b.is_ascii_digit())
    {
        return false;
    }
    let Ok(y) = s[0..4].parse::<u32>() else {
        return false;
    };
    let Ok(m) = s[5..7].parse::<u32>() else {
        return false;
    };
    let Ok(d) = s[8..10].parse::<u32>() else {
        return false;
    };
    let max = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
                29
            } else {
                28
            }
        }
        _ => 0,
    };
    d > 0 && d <= max
}
pub fn locale_cmp(a: &str, b: &str) -> Ordering {
    static C: OnceLock<icu_collator::CollatorBorrowed<'static>> = OnceLock::new();
    C.get_or_init(|| {
        icu_collator::Collator::try_new(icu_locale::locale!("en-US").into(), Default::default())
            .expect("compiled en-US collation data")
    })
    .compare(a, b)
}
