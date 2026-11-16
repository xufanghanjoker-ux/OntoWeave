//! JSONL process boundary for local Node/Python adapters. Never echoes source payloads on errors.
use lightog_demand::{need, wire, Error, Kernel, Result, ValidationContext};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, BufRead, Read, Write};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    wire_version: String,
    request_id: String,
    operation: String,
    payload: Value,
    definition: Option<String>,
    context: Option<Value>,
}
fn run(kernel: &Kernel, value: &Value) -> Result<Value> {
    let r: Request =
        serde_json::from_value(value.clone()).map_err(|_| Error::new("RPC_INVALID_REQUEST"))?;
    need(
        r.wire_version == "lightog-kernel/0.1",
        "RPC_VERSION_UNSUPPORTED",
    )?;
    need(
        !r.request_id.is_empty() && r.request_id.len() <= 128,
        "RPC_INVALID_REQUEST",
    )?;
    match r.operation.as_str() {
        "validate" => {
            let definition = r
                .definition
                .ok_or_else(|| Error::new("RPC_INVALID_REQUEST"))?;
            let raw = r.context.ok_or_else(|| Error::new("RPC_INVALID_REQUEST"))?;
            let ctx = ValidationContext::from_value(&raw, kernel)?;
            kernel.validate(&r.payload, &definition, &ctx)?;
            Ok(json!({"definition":definition}))
        }
        "canonical" => {
            need(
                r.definition.is_none() && r.context.is_none(),
                "RPC_INVALID_REQUEST",
            )?;
            let bytes = wire::canonical(&r.payload)?;
            Ok(
                json!({"canonical_utf8":String::from_utf8(bytes.clone()).map_err(|_|Error::new("WIRE_INVALID_UNICODE"))?,"sha256":wire::bytes_sha(&bytes)}),
            )
        }
        "span" => {
            need(
                r.definition.is_none() && r.context.is_none(),
                "RPC_INVALID_REQUEST",
            )?;
            let text = r.payload["text"]
                .as_str()
                .ok_or_else(|| Error::new("RPC_INVALID_REQUEST"))?;
            serde_json::to_value(wire::span_text(text, &r.payload["span"])?)
                .map_err(|_| Error::new("RPC_INVALID_REQUEST"))
        }
        _ => Err(Error::new("RPC_OPERATION_UNKNOWN")),
    }
}
fn main() {
    let kernel = match Kernel::new() {
        Ok(k) => k,
        Err(e) => {
            eprintln!("{}", e.code);
            std::process::exit(1)
        }
    };
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let mut output = stdout.lock();
    loop {
        let mut line = Vec::new();
        let read = match (&mut input)
            .take(wire::MAX_INPUT_BYTES as u64 + 2)
            .read_until(b'\n', &mut line)
        {
            Ok(n) => n,
            Err(_) => break,
        };
        if read == 0 {
            break;
        }
        let oversized = line.len() - usize::from(line.ends_with(b"\n")) > wire::MAX_INPUT_BYTES;
        if oversized && !line.ends_with(b"\n") {
            loop {
                let mut discard = Vec::new();
                let n = (&mut input)
                    .take(8192)
                    .read_until(b'\n', &mut discard)
                    .unwrap_or(0);
                if n == 0 || discard.ends_with(b"\n") {
                    break;
                }
            }
        }
        if line.ends_with(b"\n") {
            line.pop();
        }
        let parsed = if oversized {
            Err(Error::new("WIRE_RESOURCE_LIMIT"))
        } else {
            wire::strict_load(&line)
        };
        let id = parsed
            .as_ref()
            .ok()
            .and_then(|v| v.get("request_id"))
            .filter(|v| v.is_string())
            .cloned()
            .unwrap_or(Value::Null);
        let result = parsed.and_then(|v| run(&kernel, &v));
        let response = match result {
            Ok(data) => json!({"request_id":id,"ok":true,"data":data}),
            Err(e) => json!({"request_id":id,"ok":false,"error":{"code":e.code}}),
        };
        if serde_json::to_writer(&mut output, &response).is_err()
            || writeln!(&mut output).is_err()
            || output.flush().is_err()
        {
            break;
        }
    }
}
