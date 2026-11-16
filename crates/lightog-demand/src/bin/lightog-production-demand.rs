//! Separate M1 JSONL entry; never imported by the product server.
use lightog_demand::{production, wire, Error, Kernel};
use serde_json::{json, Value};
use std::io::{self, BufRead, Read, Write};
fn response(raw: &[u8], kernel: &Kernel) -> Value {
    let parsed = if raw.len() > wire::MAX_INPUT_BYTES {
        Err(Error::new("WIRE_RESOURCE_LIMIT"))
    } else {
        production::parse(raw)
    };
    let id = parsed
        .as_ref()
        .ok()
        .and_then(|v| v.value.get("request_id"))
        .filter(|v| v.is_string())
        .cloned()
        .unwrap_or(Value::Null);
    match parsed.and_then(|v| production::execute(&v, kernel)) {
        Ok(data) => json!({"request_id":id,"ok":true,"data":data}),
        Err(e) => json!({"request_id":id,"ok":false,"error":{"code":e.code}}),
    }
}
fn main() {
    let kernel = match Kernel::new() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{}", e.code);
            std::process::exit(1)
        }
    };
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args == ["--json"] {
        let mut raw = vec![];
        if (&mut input)
            .take(wire::MAX_INPUT_BYTES as u64 + 1)
            .read_to_end(&mut raw)
            .is_err()
        {
            std::process::exit(1);
        }
        let r = response(&raw, &kernel);
        if serde_json::to_writer(&mut output, &r).is_err() || writeln!(&mut output).is_err() {
            std::process::exit(1);
        }
        return;
    }
    if !args.is_empty() {
        eprintln!("M1_INVALID_ARGUMENT");
        std::process::exit(2);
    }
    loop {
        let mut line = vec![];
        let n = match (&mut input)
            .take(wire::MAX_INPUT_BYTES as u64 + 2)
            .read_until(b'\n', &mut line)
        {
            Ok(n) => n,
            Err(_) => break,
        };
        if n == 0 {
            break;
        }
        let oversized = line.len() - usize::from(line.ends_with(b"\n")) > wire::MAX_INPUT_BYTES;
        if oversized && !line.ends_with(b"\n") {
            loop {
                let mut discard = vec![];
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
            production::parse(&line)
        };
        let id = parsed
            .as_ref()
            .ok()
            .and_then(|v| v.value.get("request_id"))
            .filter(|v| v.is_string())
            .cloned()
            .unwrap_or(Value::Null);
        let result = parsed.and_then(|v| production::execute(&v, &kernel));
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
