use lightog_demand::wire::MAX_INPUT_BYTES;
use serde_json::Value;
use std::{
    io::Write,
    process::{Command, Stdio},
};

const REQUEST: &str = r#"{"wire_version":"lightog-kernel/0.1","request_id":"limit","operation":"canonical","payload":null}"#;

fn run(input: &[u8]) -> Vec<Value> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_lightog-demand"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect()
}

#[test]
fn jsonl_delimiter_does_not_reduce_payload_limit() {
    let mut input = vec![b' '; MAX_INPUT_BYTES - REQUEST.len()];
    input.extend_from_slice(REQUEST.as_bytes());
    input.push(b'\n');
    assert_eq!(run(&input)[0]["ok"], true);
}

#[test]
fn oversized_record_is_drained_before_next_request() {
    let mut input = vec![b' '; MAX_INPUT_BYTES + 500];
    input.extend_from_slice(b"\n");
    input.extend_from_slice(REQUEST.as_bytes());
    input.push(b'\n');
    let responses = run(&input);
    assert_eq!(responses.len(), 2);
    assert_eq!(responses[0]["error"]["code"], "WIRE_RESOURCE_LIMIT");
    assert!(responses[0]["request_id"].is_null());
    assert_eq!(responses[1]["request_id"], "limit");
    assert_eq!(responses[1]["ok"], true);
}
