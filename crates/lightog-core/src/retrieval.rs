//! M4: frozen source context and learning-index algorithms. No storage or clock.
use crate::common::*;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use unicode_normalization::UnicodeNormalization;

pub const SOURCE_CONTEXT_VERSION: &str = "source_context_v1";
pub const LEARNING_INDEX_VERSION: &str = "chunk_entity_retrieval_v1";
fn get<'a>(v: &'a Value, k: &str) -> &'a Value {
    v.get(k).unwrap_or(&Value::Null)
}
fn num(v: &Value, default: usize) -> usize {
    v.as_u64().map(|x| x as usize).unwrap_or(default)
}
fn field(map: &mut Map<String, Value>, v: &Value, k: &str) {
    if let Some(x) = v.get(k) {
        map.insert(k.into(), x.clone());
    }
}
fn write(row: &Value) -> Value {
    json!({"kind":"learning_source_index","id":row["id"],"value":row})
}
fn boundary(text: &str, index: usize) -> usize {
    let u: Vec<u16> = text.encode_utf16().collect();
    if index > 0
        && index < u.len()
        && (0xdc00..=0xdfff).contains(&u[index])
        && (0xd800..=0xdbff).contains(&u[index - 1])
    {
        index - 1
    } else {
        index
    }
}
fn integer_option(options: &Value, key: &str, default: usize) -> Result<usize> {
    match options.get(key) {
        None => Ok(default),
        Some(v) => {
            ensure(v.as_u64().is_some(), "分块参数无效")?;
            Ok(v.as_u64().unwrap() as usize)
        }
    }
}
fn unique_push<T: PartialEq>(v: &mut Vec<T>, x: T) {
    if !v.contains(&x) {
        v.push(x);
    }
}
fn normalized(text: &str) -> String {
    text.nfkc().collect::<String>().to_lowercase()
}
fn regex(pattern: &str) -> Regex {
    Regex::new(pattern).expect("frozen regex")
}
// Node v22.22.1 V8 src/base/ieee754.cc log, adapted to Rust to retain
// Math.log rounding instead of the host libc's potentially different last bit.
// Original fdlibm notice: Copyright (C) 1993 by Sun Microsystems, Inc.
// All rights reserved. Developed at SunSoft, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this software is freely
// granted, provided that this notice is preserved.
// Modified original: Copyright 2016 the V8 project authors. All rights reserved.
// Reference: https://github.com/nodejs/node/blob/v22.22.1/deps/v8/src/base/ieee754.cc
// V8 license: https://github.com/nodejs/node/blob/v22.22.1/deps/v8/LICENSE
// Copyright 2014, the V8 project authors. All rights reserved.
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
// * Redistributions of source code must retain the above copyright notice,
//   this list of conditions and the following disclaimer.
// * Redistributions in binary form must reproduce the above copyright notice,
//   this list of conditions and the following disclaimer in the documentation
//   and/or other materials provided with the distribution.
// * Neither the name of Google Inc. nor the names of its contributors may be
//   used to endorse or promote products derived from this software without
//   specific prior written permission.
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.
fn legacy_math_log(mut x: f64) -> f64 {
    let hi = f64::from_bits(0x3fe62e42fee00000);
    let lo = f64::from_bits(0x3dea39ef35793c76);
    let lg1 = f64::from_bits(0x3fe5555555555593);
    let lg2 = f64::from_bits(0x3fd999999997fa04);
    let lg3 = f64::from_bits(0x3fd2492494229359);
    let lg4 = f64::from_bits(0x3fcc71c51d8e78af);
    let lg5 = f64::from_bits(0x3fc7466496cb03de);
    let lg6 = f64::from_bits(0x3fc39a09d078c69f);
    let lg7 = f64::from_bits(0x3fc2f112df3e5244);
    let mut hx = (x.to_bits() >> 32) as i32;
    let lx = x.to_bits() as u32;
    let mut k = 0i32;
    if hx < 0x00100000 {
        if ((hx & 0x7fffffff) as u32 | lx) == 0 {
            return f64::NEG_INFINITY;
        }
        if hx < 0 {
            return f64::NAN;
        }
        k -= 54;
        x *= f64::from_bits(0x4350000000000000);
        hx = (x.to_bits() >> 32) as i32;
    }
    if hx >= 0x7ff00000 {
        return x + x;
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000fffff;
    let mut i = (hx + 0x95f64) & 0x100000;
    x = f64::from_bits((x.to_bits() & 0xffffffff) | (((hx | (i ^ 0x3ff00000)) as u64) << 32));
    k += i >> 20;
    let f = x - 1.0;
    if (0x000fffff & (2 + hx)) < 3 {
        if f == 0.0 {
            return if k == 0 {
                0.0
            } else {
                k as f64 * hi + k as f64 * lo
            };
        }
        let r = f * f * (0.5 - 0.33333333333333333 * f);
        return if k == 0 {
            f - r
        } else {
            k as f64 * hi - ((r - k as f64 * lo) - f)
        };
    }
    let ss = f / (2.0 + f);
    let dk = k as f64;
    let z = ss * ss;
    i = hx - 0x6147a;
    let w = z * z;
    let j = 0x6b851 - hx;
    let t1 = w * (lg2 + w * (lg4 + w * lg6));
    let t2 = z * (lg1 + w * (lg3 + w * (lg5 + w * lg7)));
    i |= j;
    let r = t2 + t1;
    if i > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 {
            f - (hfsq - ss * (hfsq + r))
        } else {
            dk * hi - ((hfsq - (ss * (hfsq + r) + dk * lo)) - f)
        }
    } else if k == 0 {
        f - ss * (f - r)
    } else {
        dk * hi - ((ss * (f - r) - dk * lo) - f)
    }
}

fn index_terms(text: &str) -> Vec<String> {
    let text = normalized(text);
    let mut terms: Vec<String> = regex(r"[a-z][a-z0-9_-]{1,}")
        .find_iter(&text)
        .map(|m| m.as_str().into())
        .collect();
    for m in regex(r"\p{Script=Han}{2,}").find_iter(&text) {
        let chars: Vec<char> = m.as_str().chars().collect();
        for p in chars.windows(2) {
            terms.push(p.iter().collect());
        }
    }
    terms
}
fn keywords(cqs: &[Value]) -> Vec<String> {
    let text = cqs
        .iter()
        .map(|q| {
            if let Some(x) = q.as_str() {
                x.to_owned()
            } else {
                let x = get(q, "question");
                if truthy(x) {
                    s(x).to_owned()
                } else {
                    s(get(q, "text")).to_owned()
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    let mut words = Vec::new();
    for m in regex(r"[A-Za-z0-9_-]{2,}").find_iter(&text) {
        unique_push(&mut words, m.as_str().to_owned());
    }
    for m in regex(r"\p{Script=Han}{2,}").find_iter(&text) {
        let chars: Vec<char> = m.as_str().chars().collect();
        for p in chars.windows(2) {
            unique_push(&mut words, p.iter().collect());
        }
    }
    words
}
fn names(entity: &Value) -> Vec<String> {
    let name = s(get(entity, "name"));
    let mut v = vec![name.to_owned()];
    v.extend(
        name.split(['（', '）', '(', ')'])
            .map(|x| x.trim_matches(js_ws).to_owned()),
    );
    v.into_iter().filter(|x| len(x) >= 2).collect()
}

pub fn extraction_units(sources: &[Value], options: &Value) -> Result<Vec<Value>> {
    let max = integer_option(options, "maxChars", 6000)?;
    let overlap = integer_option(options, "overlap", 400)?;
    ensure(max >= 100 && overlap < max, "分块参数无效")?;
    let mut units = Vec::new();
    for source in sources {
        ensure(get(source, "content").is_string(), "来源正文无效")?;
        let text = s(get(source, "content"));
        let total = len(text);
        let source_hash = if truthy(get(source, "sha256")) {
            source["sha256"].clone()
        } else {
            json!(text_sha(text))
        };
        let mut start = 0;
        while start < total {
            let mut end = boundary(text, start.saturating_add(max).min(total));
            if end < total {
                let tail_start = (start + max).saturating_sub(overlap + 200).max(start);
                let tail = slice16(text, tail_start, end);
                let mut candidate = None;
                let mut at = tail_start;
                for ch in tail.chars() {
                    if matches!(ch, '。' | '！' | '？' | '\n') {
                        candidate = Some(at + ch.len_utf16());
                    }
                    at += ch.len_utf16();
                }
                if let Some(c) = candidate {
                    if c > start + overlap + 100 {
                        end = c;
                    }
                }
            }
            let mut identity = Map::new();
            field(&mut identity, source, "id");
            let idv = identity.remove("id");
            let mut idbody = Map::new();
            if let Some(x) = idv {
                idbody.insert("source_id".into(), x);
            }
            idbody.insert("source_hash".into(), source_hash.clone());
            idbody.insert("start".into(), json!(start));
            idbody.insert("end".into(), json!(end));
            idbody.insert("policy".into(), json!(SOURCE_CONTEXT_VERSION));
            idbody.insert("maxChars".into(), json!(max));
            idbody.insert("overlap".into(), json!(overlap));
            let mut u = Map::new();
            u.insert(
                "id".into(),
                json!(format!("unit_{}", &sha(&Value::Object(idbody))[..24])),
            );
            if let Some(x) = source.get("id") {
                u.insert("source_id".into(), x.clone());
            }
            field(&mut u, source, "title");
            u.insert("source_sha256".into(), source_hash.clone());
            u.insert("start".into(), json!(start));
            u.insert("end".into(), json!(end));
            u.insert("text".into(), json!(slice16(text, start, end)));
            u.insert("offset_unit".into(), json!("utf16_code_unit"));
            u.insert("policy".into(), json!(SOURCE_CONTEXT_VERSION));
            units.push(Value::Object(u));
            if end == total {
                break;
            }
            let next = boundary(text, (start + 1).max(end.saturating_sub(overlap)));
            start = if next > start { next } else { end };
        }
    }
    Ok(units)
}
pub fn context_sources(sources: &[Value], cqs: &[Value], options: &Value) -> Result<Value> {
    if sources.is_empty() {
        return Ok(json!([]));
    }
    let max = integer_option(options, "maxChars", 16000)?;
    ensure(max >= sources.len(), "上下文预算无效")?;
    let share = max / sources.len();
    let words = keywords(cqs);
    let mut out = Vec::new();
    for source in sources {
        let text = s(get(source, "content"));
        let total = len(text);
        let window = (share / 3).min(1000).max(1);
        let mut base = Map::new();
        for k in ["id", "title", "source_role"] {
            field(&mut base, source, k);
        }
        if total <= share {
            base.insert("text".into(), json!(text));
            base.insert("context_scope".into(),json!({"mode":"CQ_RELEVANT_SAMPLES","complete":true,"ranges":[{"start":0,"end":total}],"source_characters":total,"policy":SOURCE_CONTEXT_VERSION}));
            out.push(Value::Object(base));
            continue;
        }
        let mut starts = Vec::new();
        unique_push(&mut starts, 0usize);
        unique_push(&mut starts, total.saturating_sub(window));
        for i in 1..=8 {
            unique_push(&mut starts, boundary(text, total * i / 9));
        }
        for word in &words {
            let mut from = 0;
            for _ in 0..20 {
                if let Some(pos) = index_of(text, word, from) {
                    unique_push(&mut starts, boundary(text, pos.saturating_sub(window / 3)));
                    from = pos + 1;
                } else {
                    break;
                }
            }
        }
        let mut candidates: Vec<(usize, usize, usize)> = starts
            .into_iter()
            .map(|start| {
                let end = boundary(text, (start + window).min(total));
                let part = slice16(text, start, end);
                let score = words.iter().filter(|w| part.contains(w.as_str())).count();
                (start, end, score)
            })
            .collect();
        candidates.sort_by(|a, b| b.2.cmp(&a.2).then(a.0.cmp(&b.0)));
        let tail = (boundary(text, total.saturating_sub(window)), total);
        let mut selected = vec![tail];
        let mut size = tail.1 - tail.0;
        for (start, end, _) in candidates {
            if selected.iter().any(|r| r.0 < end && r.1 > start) {
                continue;
            }
            if size + end - start + 5 > share {
                continue;
            }
            selected.push((start, end));
            size += end - start + 5;
        }
        selected.sort_by_key(|x| x.0);
        let chosen = selected
            .iter()
            .map(|r| slice16(text, r.0, r.1))
            .collect::<Vec<_>>()
            .join("\n…\n");
        base.insert("text".into(), json!(chosen));
        base.insert("context_scope".into(),json!({"mode":"CQ_RELEVANT_SAMPLES","complete":false,"ranges":selected.iter().map(|r|json!({"start":r.0,"end":r.1})).collect::<Vec<_>>(),"source_characters":total,"policy":SOURCE_CONTEXT_VERSION,"notice":"仅CQ相关有限样本，不代表全文理解；全文将分块抽取。"}));
        out.push(Value::Object(base));
    }
    Ok(json!(out))
}
pub fn claim_review_batches(claims: &[Value], options: &Value) -> Result<Value> {
    let max_claims = num(get(options, "maxClaims"), 40);
    let max_chars = num(get(options, "maxChars"), 24000);
    let mut batches = Vec::new();
    let mut current: Vec<Value> = Vec::new();
    let mut indices = Vec::new();
    let mut size = 2;
    fn flush(batches: &mut Vec<Value>, current: &mut Vec<Value>, indices: &mut Vec<usize>) {
        if current.is_empty() {
            return;
        }
        let ids: Vec<Value> = current.iter().map(|c| get(c, "id").clone()).collect();
        batches.push(json!({"id":format!("claims_{}",&sha(&json!(ids))[..24]),"claims":current,"indices":indices}));
        current.clear();
        indices.clear();
    }
    for (i, claim) in claims.iter().enumerate() {
        let mut obj = Map::new();
        for key in [
            "id",
            "subject_id",
            "predicate_id",
            "value",
            "source_id",
            "quote",
            "modality",
            "comparator",
            "unit",
            "scope",
            "effective_from",
            "time_raw",
            "start",
            "end",
            "offset_unit",
            "evidence_id",
            "source_role",
            "independently_verified",
            "support_set",
        ] {
            field(&mut obj, claim, key);
        }
        let projected = Value::Object(obj);
        let n = len(&js_stringify(&projected));
        ensure(
            n + 2 <= max_chars,
            "单条声明超出评审批次容量，需要缩小引文或属性范围，原始资料未截断",
        )?;
        if current.len() >= max_claims || size + n + usize::from(!current.is_empty()) > max_chars {
            flush(&mut batches, &mut current, &mut indices);
            size = 2;
        }
        size += n + usize::from(!current.is_empty());
        current.push(projected);
        indices.push(i);
    }
    flush(&mut batches, &mut current, &mut indices);
    if batches.is_empty() {
        batches.push(json!({"id":"claims_empty","claims":[],"indices":[]}));
    }
    Ok(json!(batches))
}

fn mention_rows(unit: &Value, entities: &[Value]) -> Vec<Value> {
    let text = s(get(unit, "text"));
    let offset = num(get(unit, "start"), 0);
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    let mut add = |mention: String, start: usize, origin: &str, entity: Option<Value>| {
        let suffix = entity
            .as_ref()
            .filter(|e| truthy(e))
            .map(|e| s(e))
            .unwrap_or("");
        let key = format!("{}:{}:{}", start, len(&mention), suffix);
        if !seen.insert(key) {
            return;
        }
        let mut row = json!({"mention":mention,"start":offset+start,"end":offset+start+len(&mention),"origin":origin});
        if let Some(e) = entity {
            if truthy(&e) {
                row.as_object_mut().unwrap().insert("entity_id".into(), e);
            }
        }
        result.push(row);
    };
    for e in entities {
        for label in names(e) {
            let mut from = 0;
            while from < len(text) {
                if let Some(at) = index_of(text, &label, from) {
                    add(
                        label.clone(),
                        at,
                        "KNOWN_LABEL_RECALL_ONLY",
                        e.get("id").cloned(),
                    );
                    from = at + len(&label);
                } else {
                    break;
                }
            }
        }
    }
    let pattern = regex(
        r#"(?-u:\b)[A-Z][A-Za-z0-9_-]{2,}(?:[\t\n\r\x0b\x0c \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]+[A-Z][A-Za-z0-9_-]{2,}){0,2}(?-u:\b)|[“「]([^”」\n]{2,30})[”」]"#,
    );
    for captures in pattern.captures_iter(text) {
        let all = captures.get(0).unwrap();
        let matched = captures.get(1);
        let word = matched.unwrap_or(all);
        if matched.is_some() && len(word.as_str()) > 30 {
            continue;
        }
        let at = len(&text[..all.start()]) + usize::from(matched.is_some());
        add(word.as_str().into(), at, "LEXICAL_CANDIDATE", None);
    }
    result
}

pub fn ensure_index(p: &Value) -> Result<Value> {
    let base = s(get(p, "base_id"));
    ensure(!base.is_empty(), "索引必须按知识库隔离")?;
    let sources = a(get(p, "sources"));
    let entities = a(get(p, "entities"));
    let old_rows = a(get(p, "rows"));
    let units = extraction_units(sources, &Value::Null)?;
    let entity_hash = canonical_hash(&json!(entities));
    let mut rows = Vec::new();
    let mut writes = Vec::new();
    for source in sources {
        let content = s(get(source, "content"));
        ensure(
            truthy(get(source, "sha256")) && text_sha(content) == s(get(source, "sha256")),
            "索引来源哈希不一致",
        )?;
        let blocks = a(get(get(source, "parsing"), "blocks"));
        let context_hash = canonical_hash(&json!(blocks));
        let id = format!(
            "index_{}",
            &canonical_hash(&json!([
                base,
                source["id"],
                source["sha256"],
                LEARNING_INDEX_VERSION,
                SOURCE_CONTEXT_VERSION
            ]))[..32]
        );
        let old = old_rows.iter().find(|r| s(get(r, "id")) == id);
        let source_units: Vec<Value> = units
            .iter()
            .filter(|u| get(u, "source_id") == get(source, "id"))
            .cloned()
            .collect();
        let valid = old
            .map(|r| {
                get(r, "units").is_array()
                    && s(get(r, "base_id")) == base
                    && get(r, "source_id") == get(source, "id")
                    && s(get(r, "version")) == LEARNING_INDEX_VERSION
                    && get(r, "source_sha256") == get(source, "sha256")
                    && s(get(r, "context_hash")) == context_hash
                    && s(get(r, "digest")) == canonical_hash(get(r, "units"))
                    && a(get(r, "units")).len() == source_units.len()
                    && a(get(r, "units"))
                        .iter()
                        .zip(&source_units)
                        .all(|(u, expected)| {
                            get(u, "id") == get(expected, "id")
                                && get(u, "start") == get(expected, "start")
                                && get(u, "end") == get(expected, "end")
                                && get(u, "tf")
                                    .as_object()
                                    .map(|tf| {
                                        tf.values().all(|n| {
                                            n.as_f64()
                                                .map(|n| n.is_finite() && n > 0.0)
                                                .unwrap_or(false)
                                        })
                                    })
                                    .unwrap_or(true)
                        })
            })
            .unwrap_or(false);
        let entities_changed = old
            .map(|r| s(get(r, "entity_hash")) != entity_hash)
            .unwrap_or(true);
        let mut row;
        if !valid {
            let mut metas = Vec::new();
            for u in &source_units {
                let mut tf: Map<String, Value> = Map::new();
                for term in index_terms(s(get(u, "text"))) {
                    let count = tf.get(&term).and_then(Value::as_u64).unwrap_or(0) + 1;
                    tf.insert(term, json!(count));
                }
                let start = num(get(u, "start"), 0);
                let end = num(get(u, "end"), 0);
                let headers: Vec<&Value> = blocks
                    .iter()
                    .filter(|b| {
                        s(get(b, "kind")) == "section_header" && num(get(b, "end"), 0) <= start
                    })
                    .collect();
                let contexts: Vec<Value> = headers
                    .iter()
                    .skip(headers.len().saturating_sub(2))
                    .copied()
                    .chain(blocks.iter().filter(|b| {
                        matches!(s(get(b, "kind")), "table" | "section_header")
                            && num(get(b, "start"), 0) < end
                            && num(get(b, "end"), 0) > start
                    }))
                    .map(|b| {
                        let mut m = Map::new();
                        for key in ["block_id", "kind", "start", "end"] {
                            field(&mut m, b, key);
                        }
                        Value::Object(m)
                    })
                    .collect();
                let length: u64 = tf.values().map(|v| v.as_u64().unwrap()).sum();
                metas.push(json!({"id":u["id"],"start":start,"end":end,"context":contexts,"tf":tf,"length":length,"mentions":mention_rows(u,entities)}));
            }
            row = json!({"id":id,"base_id":base,"source_id":source["id"],"source_sha256":source["sha256"],"context_hash":context_hash,"version":LEARNING_INDEX_VERSION,"units":metas,"entity_hash":entity_hash,"status":"RETRIEVAL_HINTS_NOT_KNOWLEDGE","created_at":get(p,"created_at")});
        } else {
            row = old.unwrap().clone();
            if entities_changed {
                for u in row["units"].as_array_mut().unwrap() {
                    let original = source_units
                        .iter()
                        .find(|x| get(x, "id") == get(u, "id"))
                        .unwrap();
                    let mut mentions: Vec<Value> = a(get(u, "mentions"))
                        .iter()
                        .filter(|m| s(get(m, "origin")) != "KNOWN_LABEL_RECALL_ONLY")
                        .cloned()
                        .collect();
                    mentions.extend(
                        mention_rows(original, entities)
                            .into_iter()
                            .filter(|m| s(get(m, "origin")) == "KNOWN_LABEL_RECALL_ONLY"),
                    );
                    u["mentions"] = json!(mentions);
                }
                row["entity_hash"] = json!(entity_hash);
            }
        }
        row["digest"] = json!(canonical_hash(get(&row, "units")));
        if !valid || entities_changed {
            writes.push(write(&row));
        }
        rows.push(row);
    }
    Ok(json!({"units":units,"rows":rows,"writes":writes}))
}

pub fn enrich_index(p: &Value) -> Result<Value> {
    let mut ensured = ensure_index(p)?;
    let scope = get(p, "scope_row");
    let mut writes = a(get(&ensured, "writes")).to_vec();
    for row in ensured["rows"].as_array_mut().unwrap() {
        let found = a(get(row, "units"))
            .iter()
            .position(|u| get(u, "id") == get(scope, "unit_id"));
        let Some(index) = found else {
            continue;
        };
        let source = a(get(p, "sources"))
            .iter()
            .find(|s| get(s, "id") == get(row, "source_id"))
            .ok_or_else(|| fail("索引来源无效"))?;
        let unit = &mut row["units"][index];
        let mut changed = false;
        for m in a(get(scope, "entity_mentions"))
            .iter()
            .chain(a(get(scope, "subjects")))
        {
            let mention = if truthy(get(m, "mention")) {
                get(m, "mention")
            } else {
                get(m, "name")
            };
            let start = m
                .get("mention_start")
                .filter(|x| !x.is_null())
                .or_else(|| m.get("start"))
                .and_then(Value::as_u64);
            let Some(start) = start.map(|n| n as usize) else {
                continue;
            };
            let end = num(get(m, "mention_end"), start + len(s(mention)));
            if start < num(get(unit, "start"), 0)
                || end > num(get(unit, "end"), 0)
                || slice16(s(get(source, "content")), start, end) != s(mention)
            {
                continue;
            }
            if !a(get(unit, "mentions")).iter().any(|x| {
                num(get(x, "start"), usize::MAX) == start && num(get(x, "end"), usize::MAX) == end
            }) {
                unit["mentions"].as_array_mut().unwrap().push(json!({"mention":mention,"start":start,"end":end,"origin":"MODEL_SOURCE_MENTION_NOT_IDENTITY"}));
                changed = true;
            }
        }
        if changed {
            row["digest"] = json!(canonical_hash(get(row, "units")));
            writes.push(write(row));
        }
    }
    ensured["writes"] = json!(writes);
    Ok(ensured)
}

pub fn rank_index(p: &Value) -> Result<Value> {
    let mut ensured = ensure_index(p)?;
    let units = a(get(&ensured, "units"));
    let rows = a(get(&ensured, "rows"));
    let metas: HashMap<String, &Value> = rows
        .iter()
        .flat_map(|r| a(get(r, "units")))
        .map(|u| (s(get(u, "id")).into(), u))
        .collect();
    let mut query_terms = Vec::new();
    for term in index_terms(s(get(p, "question"))) {
        unique_push(&mut query_terms, term);
    }
    let df: Vec<usize> = query_terms
        .iter()
        .map(|term| {
            metas
                .values()
                .filter(|u| {
                    get(u, "tf")
                        .get(term)
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0)
                        > 0.0
                })
                .count()
        })
        .collect();
    let entities = a(get(p, "entities"));
    let normalized_question = normalized(s(get(p, "question")));
    let direct: Vec<Value> = entities
        .iter()
        .filter(|e| {
            names(e)
                .iter()
                .any(|n| normalized_question.contains(&normalized(n)))
        })
        .map(|e| get(e, "id").clone())
        .collect();
    let mut direct_unique = Vec::new();
    for d in direct {
        unique_push(&mut direct_unique, d);
    }
    let direct = direct_unique;
    let mut neighbors: Vec<Value> = Vec::new();
    for c in a(get(p, "claims"))
        .iter()
        .filter(|c| direct.contains(get(c, "subject_id")) || direct.contains(get(c, "value")))
    {
        for id in [
            get(c, "subject_id").clone(),
            if get(c, "value").is_string() {
                get(c, "value").clone()
            } else {
                Value::Null
            },
        ] {
            if !direct.contains(&id) && entities.iter().any(|e| get(e, "id") == &id) {
                unique_push(&mut neighbors, id);
            }
        }
    }
    let mut ranked = Vec::new();
    for u in units {
        let m = metas[s(get(u, "id"))];
        let ids: Vec<Value> = a(get(m, "mentions"))
            .iter()
            .map(|x| get(x, "entity_id").clone())
            .filter(truthy)
            .collect();
        let mut score = 0.0f64;
        for (i, term) in query_terms.iter().enumerate() {
            let n = get(m, "tf")
                .get(term)
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            if n != 0.0 {
                score += legacy_math_log(1.0 + (units.len() + 1) as f64 / (1 + df[i]) as f64)
                    * (n / (n + 1.5));
            }
        }
        let mut mention_matches = Vec::new();
        for x in a(get(m, "mentions")) {
            let mention = s(get(x, "mention"));
            if len(mention) >= 2 && normalized_question.contains(&normalized(mention)) {
                unique_push(&mut mention_matches, normalized(mention));
            }
        }
        let matched: Vec<Value> = direct
            .iter()
            .filter(|id| ids.contains(id))
            .cloned()
            .collect();
        let bonus = (mention_matches.len().min(4) as f64 * 1.5 + matched.len() as f64 * 3.0)
            + if direct.len() > 1 && matched.len() == direct.len() {
                8.0
            } else {
                0.0
            }
            + neighbors.iter().filter(|id| ids.contains(id)).count() as f64;
        score += bonus;
        let mut value = u.clone();
        value["retrieval_score"] = json!(score);
        value["entity_recall_ids"] = json!(matched);
        value["mention_recall"] = json!(mention_matches.into_iter().take(12).collect::<Vec<_>>());
        ranked.push(value);
    }
    ranked.sort_by(|a, b| {
        b["retrieval_score"]
            .as_f64()
            .unwrap()
            .partial_cmp(&a["retrieval_score"].as_f64().unwrap())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| locale_cmp(s(get(a, "source_id")), s(get(b, "source_id"))))
            .then(num(get(a, "start"), 0).cmp(&num(get(b, "start"), 0)))
    });
    ensured
        .as_object_mut()
        .unwrap()
        .insert("ranked".into(), json!(ranked));
    Ok(ensured)
}

pub fn validate_plan(plan: &Value, sources: &[Value], evidence: &[Value]) -> Result<Vec<Value>> {
    let units = extraction_units(sources, &Value::Null)?;
    let stamp: Vec<Value> = sources
        .iter()
        .map(|s| json!([s["id"], s["sha256"]]))
        .collect();
    ensure(
        s(get(plan, "version")) == LEARNING_INDEX_VERSION
            && js_stringify(get(plan, "source_stamp")) == js_stringify(&json!(stamp)),
        "局部学习索引版本或来源已变化",
    )?;
    let ids = a(get(plan, "unit_ids"));
    let distinct: HashSet<String> = ids.iter().map(js_stringify).collect();
    ensure(
        get(plan, "unit_ids").is_array()
            && !ids.is_empty()
            && distinct.len() == ids.len()
            && ids
                .iter()
                .all(|id| units.iter().any(|u| get(u, "id") == id)),
        "局部学习窗口无效",
    )?;
    for e in evidence {
        let source = sources.iter().find(|x| get(x, "id") == get(e, "source_id"));
        ensure(
            source
                .map(|source| {
                    get(source, "sha256") == get(e, "source_sha256")
                        && slice16(
                            s(get(source, "content")),
                            num(get(e, "start"), 0),
                            num(get(e, "end"), 0),
                        ) == s(get(e, "quote"))
                })
                .unwrap_or(false),
            "局部学习准入证据已变化",
        )?;
        ensure(
            units
                .iter()
                .filter(|u| {
                    get(e, "source_id") == get(u, "source_id")
                        && num(get(e, "start"), 0) < num(get(u, "end"), 0)
                        && num(get(e, "end"), 0) > num(get(u, "start"), 0)
                })
                .all(|u| ids.contains(get(u, "id"))),
            "局部学习不得遗漏准入证据窗口",
        )?;
    }
    Ok(units
        .into_iter()
        .filter(|u| ids.contains(get(u, "id")))
        .collect())
}
pub fn plan_index(p: &Value) -> Result<Value> {
    let mut result = rank_index(p)?;
    let ranked = a(get(&result, "ranked"));
    let evidence = a(get(p, "evidence"));
    let required: Vec<Value> = ranked
        .iter()
        .filter(|u| {
            evidence.iter().any(|e| {
                get(e, "source_id") == get(u, "source_id")
                    && num(get(e, "start"), 0) < num(get(u, "end"), 0)
                    && num(get(e, "end"), 0) > num(get(u, "start"), 0)
            })
        })
        .cloned()
        .collect();
    ensure(!required.is_empty(), "局部学习缺少准入证据窗口")?;
    let mut ids: Vec<Value> = required.iter().map(|u| get(u, "id").clone()).collect();
    for u in ranked
        .iter()
        .filter(|u| u["retrieval_score"].as_f64().unwrap_or(0.0) > 0.0)
    {
        if ids.len() >= 4usize.max(required.len()) {
            break;
        }
        unique_push(&mut ids, get(u, "id").clone());
    }
    let plan = json!({"version":LEARNING_INDEX_VERSION,"base_id":get(p,"base_id"),"source_stamp":a(get(p,"sources")).iter().map(|s|json!([s["id"],s["sha256"]])).collect::<Vec<_>>(),"unit_ids":ids,"evidence_unit_ids":required.iter().map(|u|get(u,"id").clone()).collect::<Vec<_>>(),"total_units":ranked.len(),"coverage":"LOCAL_RETRIEVAL_NOT_EXHAUSTIVE","ranking":ranked.iter().take(8).map(|u|json!({"unit_id":u["id"],"score":u["retrieval_score"],"entity_ids":u["entity_recall_ids"]})).collect::<Vec<_>>()});
    result["plan"] = plan;
    Ok(result)
}
pub fn expand_index(p: &Value) -> Result<Value> {
    let previous = get(p, "previous");
    validate_plan(previous, a(get(p, "sources")), &[])?;
    let mut result = rank_index(p)?;
    let ranked = a(get(&result, "ranked"));
    let mut ids = a(get(previous, "unit_ids")).to_vec();
    let target = ranked.len().min(ids.len() + 4);
    for u in ranked {
        if ids.len() >= target {
            break;
        }
        unique_push(&mut ids, get(u, "id").clone());
    }
    let mut plan = previous.clone();
    plan["unit_ids"] = json!(ids);
    plan["expansion_round"] = json!(num(get(previous, "expansion_round"), 0) + 1);
    plan["coverage"] = json!(if ids.len() == ranked.len() {
        "ALL_WINDOWS_SELECTED_NOT_SEMANTIC_COMPLETENESS"
    } else {
        "LOCAL_RETRIEVAL_NOT_EXHAUSTIVE"
    });
    result["plan"] = plan;
    Ok(result)
}

pub fn index_keys(p: &Value) -> Result<Value> {
    let base = s(get(p, "base_id"));
    ensure(!base.is_empty(), "索引必须按知识库隔离")?;
    Ok(json!(a(get(p, "sources"))
        .iter()
        .map(|source| {
            format!(
                "index_{}",
                &canonical_hash(&json!([
                    base,
                    source["id"],
                    source["sha256"],
                    LEARNING_INDEX_VERSION,
                    SOURCE_CONTEXT_VERSION
                ]))[..32]
            )
        })
        .collect::<Vec<_>>()))
}

pub fn execute(op: &str, p: &Value) -> Result<Value> {
    match op {
        "source.extraction_units" | "extraction_units" => Ok(json!(extraction_units(
            a(get(p, "sources")),
            get(p, "options")
        )?)),
        "source.context_sources" | "context_sources" => {
            context_sources(a(get(p, "sources")), a(get(p, "cqs")), get(p, "options"))
        }
        "source.claim_review_batches" | "claim_review_batches" => {
            claim_review_batches(a(get(p, "claims")), get(p, "options"))
        }
        "index.keys" => index_keys(p),
        "index.ensure" => ensure_index(p),
        "index.enrich" => enrich_index(p),
        "index.rank" => rank_index(p),
        "index.plan" => plan_index(p),
        "index.expand" => expand_index(p),
        "index.validate_plan" | "validate_learning_plan" => Ok(json!(validate_plan(
            get(p, "plan"),
            a(get(p, "sources")),
            a(get(p, "evidence"))
        )?)),
        _ => Err(error("CORE_OPERATION_UNKNOWN", format!("未知M4操作：{op}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frozen_utf16_and_raw_hash_identity() {
        let out = extraction_units(
            &[json!({"id":"s","title":"unicode","content":"甲😀乙。"})],
            &Value::Null,
        )
        .unwrap();
        assert_eq!(out[0]["id"], "unit_32fd8a168e3f5673cab55084");
        assert_eq!(out[0]["end"], 5);
        let batch =
            claim_review_batches(&[json!({"id":"c","value":"😀","ignored":1})], &Value::Null)
                .unwrap();
        assert_eq!(batch[0]["id"], "claims_fd2079a3096d5abb9bdf54cc");
        assert!(batch[0]["claims"][0].get("ignored").is_none());
    }
    #[test]
    fn extreme_overlap_progresses_without_splitting_pairs() {
        let text = "😀".repeat(120);
        let units = extraction_units(
            &[json!({"id":"s","content":text})],
            &json!({"maxChars":100,"overlap":99}),
        )
        .unwrap();
        assert_eq!(units.last().unwrap()["end"], 240);
        for pair in units.windows(2) {
            assert!(pair[1]["start"].as_u64() > pair[0]["start"].as_u64());
        }
        assert!(units.iter().all(|u| !s(&u["text"]).contains('\u{fffd}')));
    }
    #[test]
    fn index_snapshot_preserves_rows_and_prototype_terms() {
        let content = "ｃｏｎｓｔｒｕｃｔｏｒ constructor prototype __proto__ Agent";
        let p = json!({"base_id":"kb","sources":[{"id":"s","sha256":text_sha(content),"content":content}],"entities":[],"rows":[],"created_at":"FROZEN"});
        let first = ensure_index(&p).unwrap();
        assert_eq!(first["rows"][0]["units"][0]["tf"]["constructor"], 2);
        let mut next = p.clone();
        next["rows"] = first["rows"].clone();
        let again = ensure_index(&next).unwrap();
        assert_eq!(again["writes"], json!([]));
        assert_eq!(again["rows"], first["rows"]);
    }
    #[test]
    fn frozen_js_m4_m5_vectors() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../../../fixtures/core-migration-v0.1/m4-m5-differential.json"
        ))
        .unwrap();
        let mut failures = Vec::new();
        for vector in a(&corpus["vectors"]) {
            let result = if vector["module"] == "retrieval" {
                execute(s(&vector["operation"]), &vector["payload"])
            } else {
                crate::learning::execute(s(&vector["operation"]), &vector["payload"])
            };
            match (vector["expected"]["ok"].as_bool().unwrap(), result) {
                (true, Ok(actual)) => {
                    if js_stringify(&canonical(&actual))
                        != js_stringify(&canonical(&vector["expected"]["value"]))
                    {
                        failures.push(format!("{}: output mismatch", vector["id"]));
                    }
                }
                (false, Err(error)) => {
                    if error.message != vector["expected"]["error"].as_str().unwrap() {
                        failures.push(format!(
                            "{}: error {} GOT {}",
                            vector["id"], vector["expected"]["error"], error.message
                        ));
                    }
                }
                (_, actual) => failures.push(format!("{}: unexpected {:?}", vector["id"], actual)),
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }
}
