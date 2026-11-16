//! Long-lived JSONL structure-index service; build once and compose many queries.
use lightog_demand::{wire, Error};
use serde_json::{json, Value};
use std::io::{self, BufRead, Read, Write};
fn main() {
    let mut engine = lightog_retrieval::evidence_units::Engine::default();
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
            .filter(|v| v.as_str().is_some_and(|v| !v.is_empty() && v.len() <= 128))
            .cloned()
            .unwrap_or(Value::Null);
        let result = parsed.and_then(|v| engine.execute(&v));
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
