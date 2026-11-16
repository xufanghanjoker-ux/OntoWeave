use lightog_core::rpc::{response, MAX_BYTES};
use serde_json::json;
use std::io::{self, BufRead, Read, Write};
fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args == ["--json"] {
        let mut raw = vec![];
        if (&mut input)
            .take(MAX_BYTES as u64 + 1)
            .read_to_end(&mut raw)
            .is_err()
        {
            std::process::exit(1);
        }
        if serde_json::to_writer(&mut output, &response(&raw)).is_err()
            || writeln!(&mut output).is_err()
        {
            std::process::exit(1);
        }
        return;
    }
    if !args.is_empty() {
        eprintln!("CORE_ARGUMENT_INVALID");
        std::process::exit(2);
    }
    loop {
        let mut raw = vec![];
        let n = match (&mut input)
            .take(MAX_BYTES as u64 + 2)
            .read_until(b'\n', &mut raw)
        {
            Ok(n) => n,
            Err(_) => break,
        };
        if n == 0 {
            break;
        }
        let oversized = raw.len() - usize::from(raw.ends_with(b"\n")) > MAX_BYTES;
        if oversized && !raw.ends_with(b"\n") {
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
        if raw.ends_with(b"\n") {
            raw.pop();
        }
        let out = if oversized {
            json!({"request_id":null,"ok":false,"error":{"code":"CORE_RESOURCE_LIMIT","message":"record too large","details":null}})
        } else {
            response(&raw)
        };
        if serde_json::to_writer(&mut output, &out).is_err()
            || writeln!(&mut output).is_err()
            || output.flush().is_err()
        {
            break;
        }
    }
}
