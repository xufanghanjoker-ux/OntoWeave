use lightog_demand::wire;
use serde_json::json;

#[test]
fn distinguishes_unicode_escapes_from_invalid_json() {
    for raw in [
        r#"{"x":"\ud800"}"#,
        r#"{"x":"\udc00"}"#,
        r#"{"x":"\ud800x"}"#,
    ] {
        assert_eq!(
            wire::strict_load(raw.as_bytes()).unwrap_err().code,
            "WIRE_INVALID_UNICODE"
        );
    }
    for raw in [r#"{"x":"\u123"}"#, r#"{"x":"\uZZZZ"}"#] {
        assert_eq!(
            wire::strict_load(raw.as_bytes()).unwrap_err().code,
            "WIRE_INVALID_JSON"
        );
    }
    assert_eq!(
        wire::strict_load(br#"{"x":"\ud83d\ude00"}"#).unwrap()["x"],
        "😀"
    );
}

#[test]
fn decoded_duplicates_and_numeric_lexemes_are_checked_before_value_conversion() {
    let cases: &[(&[u8], &str)] = &[
        (br#"{"a":1,"\u0061":2}"#, "WIRE_DUPLICATE_KEY"),
        (b"-0", "WIRE_NEGATIVE_ZERO"),
        (b"1e0", "WIRE_FLOAT_NOT_ALLOWED"),
        (b"9007199254740992", "WIRE_INTEGER_RANGE"),
        (b"\xef\xbb\xbf{}", "WIRE_BOM_NOT_ALLOWED"),
    ];
    for (raw, code) in cases {
        assert_eq!(wire::strict_load(raw).unwrap_err().code, *code);
    }
    assert_eq!(
        wire::strict_load(br#"["-0","1e3","NaN"]"#).unwrap(),
        json!(["-0", "1e3", "NaN"])
    );
}

#[test]
fn canonical_hash_preserves_array_order_and_utf8() {
    let v = json!({"text":"甲😀", "b":[2,1], "a":null});
    assert_eq!(
        String::from_utf8(wire::canonical(&v).unwrap()).unwrap(),
        "{\"a\":null,\"b\":[2,1],\"text\":\"甲😀\"}"
    );
    assert_eq!(
        wire::sha(&v).unwrap(),
        "3d7f44647aef4fee9164272c384a560f6a4989fe210ab479ed5ef5e39d72af69"
    );
    assert_ne!(
        wire::sha(&v).unwrap(),
        wire::sha(&json!({"a":null,"b":[1,2],"text":"甲😀"})).unwrap()
    );
}

#[test]
fn utf16_offsets_do_not_normalize_text_or_split_surrogates() {
    let text = "甲😀乙e\u{301}\r\nZ";
    let span = wire::span_text(text, &json!({"start":1,"end":3,"quote":"😀"})).unwrap();
    assert_eq!(
        (
            span.utf8_start,
            span.utf8_end,
            span.utf16_length,
            span.utf8_length
        ),
        (3, 7, 9, 16)
    );
    assert_eq!(
        wire::span_text(text, &json!({"start":2,"end":3}))
            .unwrap_err()
            .code,
        "SPAN_SPLITS_SURROGATE"
    );
    assert_eq!(
        wire::span_text(text, &json!({"start":4,"end":6,"quote":"é"}))
            .unwrap_err()
            .code,
        "SPAN_QUOTE_MISMATCH"
    );
}

#[test]
fn limits_return_errors() {
    assert_eq!(
        wire::strict_load(&vec![b' '; wire::MAX_INPUT_BYTES + 1])
            .unwrap_err()
            .code,
        "WIRE_RESOURCE_LIMIT"
    );
    let raw = format!(
        "{}0{}",
        "[".repeat(wire::MAX_DEPTH + 1),
        "]".repeat(wire::MAX_DEPTH + 1)
    );
    assert_eq!(
        wire::strict_load(raw.as_bytes()).unwrap_err().code,
        "WIRE_RESOURCE_LIMIT"
    );
}
