//! Contract-specific calendar rules, independent of optional format-checker behavior.
use serde_json::Value;

fn date(text: &str) -> bool {
    let b = text.as_bytes();
    if b.len() != 10
        || b[4] != b'-'
        || b[7] != b'-'
        || b.iter()
            .enumerate()
            .any(|(i, c)| i != 4 && i != 7 && !c.is_ascii_digit())
    {
        return false;
    }
    let year = text[..4].parse::<u32>().unwrap_or(0);
    let month = text[5..7].parse::<usize>().unwrap_or(0);
    let day = text[8..].parse::<u32>().unwrap_or(0);
    if year == 0 || !(1..=12).contains(&month) {
        return false;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    day >= 1 && day <= days[month - 1]
}

fn instant(text: &str) -> bool {
    let b = text.as_bytes();
    if !text.is_ascii()
        || b.len() < 20
        || !date(&text[..10])
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || b[b.len() - 1] != b'Z'
    {
        return false;
    }
    for (start, max) in [(11, 23), (14, 59), (17, 59)] {
        if !b[start..start + 2].iter().all(u8::is_ascii_digit)
            || text[start..start + 2].parse::<u32>().unwrap_or(100) > max
        {
            return false;
        }
    }
    b.len() == 20
        || (b.len() >= 22 && b[19] == b'.' && b[20..b.len() - 1].iter().all(u8::is_ascii_digit))
}

pub(crate) fn valid(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            let own = match map.get("kind").and_then(Value::as_str) {
                Some("DATE") => map.get("value").and_then(Value::as_str).is_some_and(date),
                Some("INSTANT") => map
                    .get("value")
                    .and_then(Value::as_str)
                    .is_some_and(instant),
                Some("DECIMAL") => map
                    .get("value")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.bytes().any(|c| c.is_ascii_whitespace())),
                _ => true,
            };
            own && map.values().all(valid)
        }
        Value::Array(items) => items.iter().all(valid),
        _ => true,
    }
}
