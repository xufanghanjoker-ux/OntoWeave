//! Native-query v1 search compatibility kernel. Network, reader qualification,
//! query-vector caching and opaque cursor state remain Host adapters.
use crate::common::{a, canonical_hash, error, js_stringify, js_ws, s, text_sha, truthy, Result};
use regex::Regex;
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use unicode_normalization::UnicodeNormalization;
#[path = "native_query_unicode_v1.rs"]
mod unicode;

fn need(ok: bool, code: &str) -> Result<()> {
    if ok { Ok(()) } else { Err(error(code, code)) }
}
fn list(value: Option<&Value>) -> Vec<Value> {
    match value { None => vec![], Some(Value::Array(v)) => v.clone(), Some(v) => vec![v.clone()] }
}
fn coalesce<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values.iter().find_map(|v| v.filter(|x| !x.is_null()))
}
fn join_value(value: Option<&Value>) -> String {
    match value { None | Some(Value::Null) => String::new(), Some(Value::String(v)) => v.clone(), Some(v) => js_stringify(v) }
}
fn wire_marker() -> &'static Regex {
    static MARKER: OnceLock<Regex> = OnceLock::new();
    MARKER.get_or_init(|| Regex::new("\u{E000}(?:p|s[0-9a-f]{4})\u{E000}").unwrap())
}
fn in_ranges(ch: char, ranges: &[(u32,u32)]) -> bool {
    let value = ch as u32;
    ranges.binary_search_by(|(start,end)| if value < *start { Ordering::Greater } else if value > *end { Ordering::Less } else { Ordering::Equal }).is_ok()
}
fn wire_characters(text: &str) -> Vec<(Option<char>,String)> {
    let mut out = Vec::new();let mut previous=0;
    for found in wire_marker().find_iter(text) {
        out.extend(text[previous..found.start()].chars().map(|ch|(Some(ch),ch.to_string())));
        let marker=found.as_str();out.push((if marker.chars().nth(1)==Some('p'){Some('\u{e000}')}else{None},marker.to_string()));previous=found.end();
    }
    out.extend(text[previous..].chars().map(|ch|(Some(ch),ch.to_string())));out
}
fn wire_utf16(text: &str) -> Vec<u16> {
    let mut units=Vec::new();
    for (character,encoded) in wire_characters(text) {
        if let Some(character)=character { units.extend(character.encode_utf16(&mut [0;2]).iter().copied()); }
        else { units.push(u16::from_str_radix(&encoded[4..8],16).unwrap()); }
    }
    units
}
fn wire_nonempty(value: &Value) -> bool {
    value.as_str().is_some_and(|text| String::from_utf16(&wire_utf16(text)).is_ok_and(|text|!text.trim_matches(js_ws).is_empty()))
}
fn wire_compare(left: &str,right: &str) -> Ordering {
    static COLLATOR:OnceLock<icu_collator::CollatorBorrowed<'static>>=OnceLock::new();
    COLLATOR.get_or_init(||icu_collator::Collator::try_new(icu_locale::locale!("en-US").into(),Default::default()).expect("compiled en-US collation data"))
        .compare_utf16(&wire_utf16(left),&wire_utf16(right))
}
fn fold(text: &str) -> String {
    let characters=wire_characters(text);
    let mut preceding=Vec::with_capacity(characters.len());let mut cased=false;
    for (ch,_)in &characters {
        preceding.push(cased);
        if !ch.is_some_and(|c|in_ranges(c,unicode::CASE_IGNORABLE)){cased=ch.is_some_and(|c|in_ranges(c,unicode::CASED));}
    }
    let mut following=vec![false;characters.len()];cased=false;
    for index in (0..characters.len()).rev() {
        let ch=characters[index].0;following[index]=cased;
        if !ch.is_some_and(|c|in_ranges(c,unicode::CASE_IGNORABLE)){cased=ch.is_some_and(|c|in_ranges(c,unicode::CASED));}
    }
    let mut lower=String::new();
    for(index,(ch,encoded))in characters.iter().enumerate() {
        match ch {
            None=>lower.push_str(encoded),
            Some('\u{e000}')if encoded.len()>3=>lower.push_str(encoded),
            Some('\u{03a3}')if preceding[index]&&!following[index]=>lower.push('\u{03c2}'),
            Some(ch)=>match unicode::LOWERCASE.binary_search_by_key(&(*ch as u32),|(key,_)|*key){Ok(index)=>lower.push_str(unicode::LOWERCASE[index].1),Err(_)=>lower.push(*ch)},
        }
    }
    // Unicode normalization is stable for already-assigned characters. Keep
    // frozen Node-17 unassigned scalars inert when using the newer Rust table.
    let mut normalized=String::new();let mut segment=String::new();
    for ch in lower.chars() {
        if in_ranges(ch,unicode::ASSIGNED){segment.push(ch);}
        else{normalized.extend(segment.nfkc());segment.clear();normalized.push(ch);}
    }
    normalized.extend(segment.nfkc());normalized
}
fn wire_text_hash(value: &Value) -> String {
    let Some(text) = value.as_str() else { return canonical_hash(value); };
    let mut serialized = String::from("\"");
    let mut previous = 0;
    for found in wire_marker().find_iter(text) {
        let encoded = serde_json::to_string(&text[previous..found.start()]).unwrap();
        serialized.push_str(&encoded[1..encoded.len()-1]);
        let marker = found.as_str();
        if marker.chars().nth(1) == Some('p') { serialized.push('\u{E000}'); }
        else { serialized.push_str("\\u");serialized.push_str(&marker[4..8]); }
        previous = found.end();
    }
    let encoded = serde_json::to_string(&text[previous..]).unwrap();
    serialized.push_str(&encoded[1..encoded.len()-1]);serialized.push('"');
    text_sha(&serialized)
}
fn classify(ch: char) -> u8 {
    if in_ranges(ch,unicode::HAN) { 1 }
    else if ch=='_'||ch=='-'||in_ranges(ch,unicode::LETTER_NUMBER) { 2 }
    else { 0 }
}
fn tokens(text: &str) -> Vec<String> {
    let normalized = fold(&wire_marker().replace_all(text, "\u{FFFD}"));
    let mut parts: Vec<(u8, String)> = Vec::new();
    for ch in normalized.chars() {
        let kind = classify(ch);
        if kind == 0 { parts.push((0, String::new())); continue; }
        if let Some((last, value)) = parts.last_mut() {
            if *last == kind { value.push(ch); continue; }
        }
        parts.push((kind, ch.to_string()));
    }
    let mut result = Vec::new();
    for (kind, part) in parts {
        if kind == 2 { result.push(part); }
        else if kind == 1 {
            let chars: Vec<_> = part.chars().collect();
            result.extend(chars.iter().map(|c| c.to_string()));
            result.extend(chars.windows(2).map(|pair| pair.iter().collect()));
        }
    }
    result
}
pub const RANKING_REVISION: &str = "native-query-bm25-rrf/2";
const BM25_K1: f64 = 1.2;
const BM25_B: f64 = 0.75;
fn lexical_scores(rows: &[Value], query: &str) -> Vec<f64> {
    let query_terms: HashSet<_> = tokens(query).into_iter().collect();
    let features: Vec<_> = rows.iter().map(|row| {
        let words=tokens(s(&row["search_text"]));
        let length=words.len() as f64;
        let mut tf=HashMap::<String,usize>::new();
        for word in words { *tf.entry(word).or_default()+=1; }
        (tf,length)
    }).collect();
    let n=rows.len() as f64;
    let average=if n>0.0 {features.iter().map(|(_,len)|len).sum::<f64>()/n} else {0.0};
    // Sort query terms for deterministic floating-point summation.
    let mut query_terms:Vec<_>=query_terms.into_iter().collect();query_terms.sort();
    let df:HashMap<_,_>=query_terms.iter().map(|term| (term,features.iter().filter(|(tf,_)|tf.contains_key(term)).count() as f64)).collect();
    features.iter().map(|(tf,len)|query_terms.iter().map(|term| {
        let count=*tf.get(term).unwrap_or(&0) as f64;
        if count==0.0 {return 0.0;}
        let idf=(1.0+(n-df[term]+0.5)/(df[term]+0.5)).ln();
        idf*count*(BM25_K1+1.0)/(count+BM25_K1*(1.0-BM25_B+BM25_B*len/average.max(1.0)))
    }).sum()).collect()
}

// Same normalized Kahan order as the frozen Node 22 / V8 12.4 Math.hypot
// baseline. A chain of f64::hypot would have a different rounding order.
fn js_hypot(values: &[f64]) -> f64 {
    let maximum = values.iter().fold(0.0_f64, |max, x| max.max(x.abs()));
    if maximum == 0.0 { return 0.0; }
    let mut sum = 0.0;
    let mut compensation = 0.0;
    for value in values {
        let normalized = value.abs() / maximum;
        let summand = normalized * normalized - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * maximum
}
fn checked_space(space: &Value) -> Result<()> {
    let dimensions = space["dimensions"].as_u64().unwrap_or(0);
    need(wire_nonempty(&space["space_ref"]) && wire_nonempty(&space["model"]) && dimensions > 0 && dimensions <= 32768 && s(&space["distance"]).to_uppercase() == "COSINE", "NATIVE_QUERY_EMBEDDING_SPACE_INVALID")
}
fn checked_vector(values: &Value, space: &Value) -> Result<Vec<f64>> {
    let numbers: Vec<_> = a(values).iter().filter_map(Value::as_f64).collect();
    need(values.is_array() && numbers.len() == a(values).len() && numbers.len() as u64 == space["dimensions"].as_u64().unwrap_or(0) && numbers.iter().all(|n| n.is_finite()) && numbers.iter().any(|n| *n != 0.0) && js_hypot(&numbers).is_finite(), "NATIVE_QUERY_VECTOR_INVALID")?;
    Ok(numbers)
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum SourceMode { CurrentKnowledge, DocumentEvidence }
fn source_mode(args: &Value) -> Result<SourceMode> {
    match args.get("source_mode") {
        None => Ok(SourceMode::CurrentKnowledge),
        Some(Value::String(value)) if value == "CURRENT_KNOWLEDGE" => Ok(SourceMode::CurrentKnowledge),
        Some(Value::String(value)) if value == "DOCUMENT_EVIDENCE" => Ok(SourceMode::DocumentEvidence),
        _ => Err(error("NATIVE_QUERY_SOURCE_MODE_INVALID", "NATIVE_QUERY_SOURCE_MODE_INVALID")),
    }
}
fn document_source_refs(row: &Value) -> Vec<Value> {
    if let Some(value) = coalesce(&[row.get("source_refs")]) { a(value).to_vec() }
    else if truthy(&row["doc_ref"]) { vec![json!({"doc_ref":row["doc_ref"],"revision":row["revision"]})] }
    else { vec![] }
}
fn allowed(row: &Value, args: &Value) -> Result<bool> {
    let mode = source_mode(args)?;
    if mode == SourceMode::DocumentEvidence && (row["origin_layer"] == "HUMAN_CORRECTION" || row["answer_authority"] == "HUMAN_CORRECTION") {
        return Ok(false);
    }
    let sources = list(args.get("source_refs"));
    let states = list(args.get("states"));
    let subjects = list(args.get("subject_refs"));
    let kinds = list(coalesce(&[args.get("kinds"), args.get("kind")]));
    let predicates = list(args.get("predicates"));
    need(predicates.iter().all(wire_nonempty), "NATIVE_QUERY_PREDICATES_INVALID")?;
    // Only the qualified reader may derive context. A present empty/null value
    // must not silently recover historical document evidence or broaden scope.
    let refs = if mode == SourceMode::CurrentKnowledge {
        row.get("context_source_refs").map(|value| a(value).to_vec()).unwrap_or_else(|| document_source_refs(row))
    } else { document_source_refs(row) };
    Ok((sources.is_empty() || refs.iter().any(|r| sources.iter().any(|source| if source.is_string() { source == &r["doc_ref"] } else { source["doc_ref"] == r["doc_ref"] && (source.get("revision").is_none() || source["revision"] == r["revision"]) })))
        && (states.is_empty() || states.contains(&row["state"]))
        && (kinds.is_empty() || kinds.contains(&row["kind"]))
        && (predicates.is_empty() || predicates.iter().any(|p| coalesce(&[row.get("predicate"), row.get("attribute")]).is_some_and(|value|p==value)))
        && (subjects.is_empty() || subjects.contains(&row["subject_ref"]) || subjects.contains(&row["object_ref"]) || a(&row["participants"]).iter().any(|p| subjects.contains(&p["subject_ref"]))))
}
fn query_text(args: &Value) -> Result<String> {
    need(args.is_object() || args.is_array(), "NATIVE_QUERY_SEARCH_INPUT_INVALID")?;
    need(args.get("query").is_none() || args["query"].is_string() && wire_utf16(s(&args["query"])).len() <= 16000, "NATIVE_QUERY_SEARCH_TEXT_INVALID")?;
    let words = list(args.get("keywords"));
    need(words.iter().all(wire_nonempty), "NATIVE_QUERY_KEYWORDS_INVALID")?;
    let mut values = vec![join_value(coalesce(&[args.get("query")]))];
    values.extend(words.iter().map(|v| join_value(Some(v))));
    let mut seen=HashSet::new();
    Ok(fold(&values.join(" ")).split_whitespace().filter(|word|seen.insert((*word).to_string())).collect::<Vec<_>>().join(" "))
}
fn search_prepare(payload: &Value) -> Result<Value> {
    let args = &payload["args"];
    let query = query_text(args)?;
    source_mode(args)?;
    let enumerate = query.is_empty();
    let mut spaces: Vec<Value> = Vec::new();
    for space in a(&payload["scope"]["embedding_spaces"]) {
        checked_space(space)?;
        if let Some(index) = spaces.iter().position(|s| s["space_ref"] == space["space_ref"]) { spaces[index] = space.clone(); }
        else { spaces.push(space.clone()); }
    }
    let mut scored = Vec::new();
    for input in a(&payload["rows"]) {
        if !allowed(input, args)? { continue; }
        let mut row = input.clone();
        row["lexical_score"] = json!(0.0);
        row["vector_score"] = Value::Null;
        scored.push(row);
    }
    if !enumerate {
        let scores=lexical_scores(&scored,&query);
        for(row,score)in scored.iter_mut().zip(scores){row["lexical_score"]=json!(score);}
    }
    let mut groups: Vec<Value> = Vec::new();
    for row in &scored {
        let embedding = &row["embedding"];
        if !truthy(embedding) { continue; }
        let space = spaces.iter().find(|s| s["space_ref"] == embedding["space_ref"]).ok_or_else(|| error("NATIVE_QUERY_RECORD_SPACE_UNKNOWN", "NATIVE_QUERY_RECORD_SPACE_UNKNOWN"))?;
        checked_vector(&embedding["values"], space)?;
        if let Some(digest) = embedding.get("text_sha256") {
            let text = coalesce(&[row.get("vector_text"), row.get("text"), row.get("search_text")]).unwrap_or(&Value::Null);
            need(digest.as_str() == Some(wire_text_hash(text).as_str()), "NATIVE_QUERY_VECTOR_TEXT_MISMATCH")?;
        }
        if !groups.iter().any(|g| g["space_ref"] == space["space_ref"]) { groups.push(json!({"space_ref":space["space_ref"],"space":space})); }
    }
    Ok(json!({"ranking_revision":RANKING_REVISION,"query_components":{"query":args["query"],"keywords":args["keywords"]},"source_refs":args["source_refs"],"query":query,"enumerate":enumerate,"scored":scored,"groups":groups,"type":payload["type"],"embedding_enabled":payload["embedding_enabled"]}))
}
fn score(row: &Value, key: &str) -> f64 { row[key].as_f64().unwrap_or(0.0) }
fn by_score(a: &Value, b: &Value, key: &str) -> Ordering {
    score(b,key).partial_cmp(&score(a,key)).unwrap_or(Ordering::Equal).then_with(|| wire_compare(s(&a["record_ref"]), s(&b["record_ref"])))
}
fn search_finish(payload: &Value) -> Result<Value> {
    let prepared = &payload["prepared"];
    need(prepared["ranking_revision"]==RANKING_REVISION,"NATIVE_QUERY_RANKING_REVISION_MISMATCH")?;
    let groups = a(&prepared["groups"]);
    let mut rows = a(&prepared["scored"]).to_vec();
    let vectors = a(&payload["query_vectors"]);
    for group in groups {
        let Some(query) = vectors.iter().find(|q| q["space_ref"] == group["space_ref"]) else { continue; };
        let query = checked_vector(&query["values"], &group["space"])?;
        let query_norm = js_hypot(&query);
        for row in &mut rows {
            if row["embedding"]["space_ref"] != group["space_ref"] { continue; }
            let values = checked_vector(&row["embedding"]["values"], &group["space"])?;
            let norm = js_hypot(&values);
            let mut cosine = 0.0;
            for (left, right) in query.iter().zip(values) { cosine += left / query_norm * (right / norm); }
            row["vector_score"] = json!(cosine);
        }
    }
    let ranked = |key: &str| {
        let mut selected: Vec<_> = rows.iter().filter(|r| !r[key].is_null() && (key != "lexical_score" || score(r,key) > 0.0)).collect();
        selected.sort_by(|a,b| by_score(a,b,key));
        let mut ranks = HashMap::new();
        for (index,row) in selected.iter().enumerate() { ranks.insert(s(&row["record_ref"]).to_string(), index+1); }
        ranks
    };
    let lexical = ranked("lexical_score");
    let vector = ranked("vector_score");
    let enumerate = prepared["enumerate"] == true;
    let mode = if enumerate { "ENUMERATE" } else if !vector.is_empty() { "HYBRID" } else { "LEXICAL" };
    let mut selected = Vec::new();
    for mut row in rows {
        let record = s(&row["record_ref"]).to_string();
        if !enumerate && !lexical.contains_key(&record) && !vector.contains_key(&record) { continue; }
        if !enumerate {
            let fused = if mode == "HYBRID" { lexical.get(&record).map_or(0.0,|rank| 1.0/(60+rank) as f64) + vector.get(&record).map_or(0.0,|rank| 1.0/(60+rank) as f64) } else { score(&row,"lexical_score") };
            row["score"] = json!(fused);
            row["lexical_rank"] = json!(lexical.get(&record));
            row["vector_rank"] = json!(vector.get(&record));
        }
        selected.push(row);
    }
    if enumerate { selected.sort_by(|a,b| wire_compare(s(&a["record_ref"]),s(&b["record_ref"]))); }
    else { selected.sort_by(|a,b| by_score(a,b,"score")); }
    if prepared["type"] == "entities" {
        selected.sort_by(|a,b| truthy(&b["exact_match"]).cmp(&truthy(&a["exact_match"])).then_with(|| by_score(a,b,"score")));
    }
    for(index,row)in selected.iter_mut().enumerate(){row["rrf_rank"]=json!(index+1);row["ranking_revision"]=json!(RANKING_REVISION);}
    for row in &mut selected { if let Some(object) = row.as_object_mut() { for field in ["search_text","vector_text","embedding"] { object.remove(field); } } }
    Ok(json!({"ranking_revision":RANKING_REVISION,"rows":selected,"mode":mode,"capability":if groups.is_empty(){"LEXICAL"}else if prepared["embedding_enabled"]==true{"HYBRID"}else{"LEXICAL_QUERY_EMBEDDING_UNAVAILABLE"},"query_embedding_spaces":if vector.is_empty(){vec![]}else{groups.iter().map(|g|g["space_ref"].clone()).collect::<Vec<_>>()}}))
}
fn entity_prepare(payload: &Value) -> Result<Value> {
    let args = &payload["args"];
    source_mode(args)?;
    let mentions = list(args.get("mentions"));
    need(mentions.iter().all(wire_nonempty), "NATIVE_QUERY_MENTIONS_INVALID")?;
    let mut wanted_values = mentions.clone();
    wanted_values.extend(list(args.get("keywords")));
    if truthy(&args["query"]) { wanted_values.push(args["query"].clone()); }
    // Public tool schemas already require text; preserve a coded tool failure
    // for non-string direct ports rather than silently coercing an object.
    need(wanted_values.iter().all(Value::is_string), "QUERY_TOOL_FAILED")?;
    let wanted: Vec<_> = wanted_values.iter().map(|v|fold(s(v))).collect();
    let mut params = args.clone();
    let mut query = vec![join_value(coalesce(&[args.get("query")]))];
    query.extend(mentions.iter().map(|v|join_value(Some(v))));
    params["query"] = json!(query.join(" ").trim_matches(js_ws));
    let mut rows = Vec::new();
    let mut exact = Vec::new();
    for subject in a(&payload["subjects"]) {
        let mut names = vec![s(&subject["surface"]).to_string()];
        names.extend(a(&subject["aliases"]).iter().map(|v|s(v).to_string()));
        let hit = names.iter().any(|name|wanted.contains(&fold(name)));
        let mut row = json!({"record_ref":subject["subject_ref"]});
        for (key,value) in subject.as_object().into_iter().flatten() { row[key] = value.clone(); }
        row["search_text"] = json!(names.join(" "));
        row["vector_text"] = coalesce(&[subject.get("description"),subject.get("surface")]).cloned().unwrap_or(Value::Null);
        row["exact_match"] = json!(hit);
        if hit { exact.push(row.clone()); }
        rows.push(row);
    }
    let ambiguous = wanted.iter().any(|term| exact.iter().filter(|subject| {
        std::iter::once(&subject["surface"]).chain(a(&subject["aliases"])).any(|name|fold(s(name))==*term)
    }).count()>1);
    let count = exact.len();
    Ok(json!({"rows":if count>0{exact}else{rows},"args":params,"wanted":wanted,"exact_count":count,"exact_ambiguous":ambiguous}))
}
fn fact_rows(payload: &Value) -> Value {
    Value::Array(a(&payload["facts"]).iter().map(|fact| {
        let mut parts = vec![join_value(fact.get("text")),join_value(fact.get("statement")),join_value(fact.get("subject_ref")),join_value(fact.get("predicate")),join_value(fact.get("object_ref")),join_value(fact.get("attribute")),
            if fact.get("raw_value").is_some(){ match &fact["raw_value"] { Value::String(v)=>v.clone(), value=>js_stringify(value) } } else { String::new() },join_value(fact.get("unit")),join_value(fact.get("rule_text"))];
        parts.extend(a(&fact["conditions"]).iter().map(|v|join_value(Some(v))));
        parts.extend([join_value(fact.get("exceptions")),join_value(fact.get("attributes")),join_value(fact.get("conditions").filter(|v|!v.is_array()))]);
        parts.extend([join_value(fact.get("modality")),if truthy(&fact["negation"]){"NEGATED".to_string()}else{String::new()},join_value(fact.get("time_text")),join_value(fact.get("version_text"))]);
        let mut seen=HashSet::new();
        let text = Value::String(parts.into_iter().filter(|p|!p.is_empty()&&seen.insert(p.clone())).collect::<Vec<_>>().join(" "));
        let mut row = fact.clone();
        row["record_ref"] = fact["fact_ref"].clone();
        row["search_text"] = text.clone();
        row["vector_text"] = coalesce(&[fact.get("text"),fact.get("statement"),fact.get("rule_text")]).cloned().unwrap_or(text.clone());
        row["text"] = coalesce(&[fact.get("text"),fact.get("statement"),fact.get("rule_text")]).cloned().unwrap_or(text);
        row["evidence_refs"] = json!(a(&fact["evidence"]).iter().map(|e|e["evidence_ref"].clone()).collect::<Vec<_>>());
        row
    }).collect())
}

pub fn execute(op: &str, payload: &Value) -> Result<Value> {
    match op {
        "search_prepare" => search_prepare(payload),
        "search_finish" => search_finish(payload),
        "search_validate_vector" => { checked_vector(&payload["values"], &payload["space"])?; Ok(payload["values"].clone()) },
        "entity_prepare" => entity_prepare(payload),
        "entity_status" => { let p=&payload["prepared"];let items=a(&payload["items"]);Ok(json!(p["exact_ambiguous"]==true || p["exact_count"]==0 && truthy(&p["args"]["query"]) && items.len()>1 && items[0]["score"]==items[1]["score"])) },
        "fact_rows" => Ok(fact_rows(payload)),
        _ => Err(error("NATIVE_QUERY_CORE_OPERATION_UNKNOWN", op)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_scope_current_human_context_is_not_document_evidence() {
        let human=json!({"record_ref":"human","origin_layer":"HUMAN_CORRECTION","answer_authority":"HUMAN_CORRECTION",
            "context_source_refs":[{"doc_ref":"A","revision":"1"}],"source_refs":[],"original_source_refs":[{"doc_ref":"B","revision":"9"}]});
        assert!(allowed(&human,&json!({"source_refs":[{"doc_ref":"A","revision":"1"}]})).unwrap());
        assert!(!allowed(&human,&json!({"source_refs":["B"]})).unwrap());
        assert!(!allowed(&human,&json!({"source_refs":[{"doc_ref":"A","revision":"2"}]})).unwrap());
        for args in [json!({"source_mode":"DOCUMENT_EVIDENCE"}),json!({"source_mode":"DOCUMENT_EVIDENCE","source_refs":["A"]})] {
            assert!(!allowed(&human,&args).unwrap());
        }
        let authority_only=json!({"origin_layer":"EXTRACTED_KNOWLEDGE","answer_authority":"HUMAN_CORRECTION","source_refs":[{"doc_ref":"A","revision":"1"}]});
        let origin_only=json!({"origin_layer":"HUMAN_CORRECTION","source_refs":[{"doc_ref":"A","revision":"1"}]});
        assert!(!allowed(&authority_only,&json!({"source_mode":"DOCUMENT_EVIDENCE"})).unwrap());
        assert!(!allowed(&origin_only,&json!({"source_mode":"DOCUMENT_EVIDENCE"})).unwrap());
    }
    #[test]
    fn source_scope_document_mode_uses_evidence_refs_and_exact_requested_revision() {
        let row=json!({"record_ref":"extracted","context_source_refs":[{"doc_ref":"A","revision":"1"}],
            "source_refs":[{"doc_ref":"B","revision":"2"}],"original_source_refs":[{"doc_ref":"C","revision":"3"}]});
        assert!(allowed(&row,&json!({"source_refs":["A"]})).unwrap());
        assert!(!allowed(&row,&json!({"source_refs":["B"]})).unwrap());
        assert!(!allowed(&row,&json!({"source_mode":"DOCUMENT_EVIDENCE","source_refs":["A"]})).unwrap());
        assert!(allowed(&row,&json!({"source_mode":"DOCUMENT_EVIDENCE","source_refs":[{"doc_ref":"B","revision":"2"}]})).unwrap());
        assert!(!allowed(&row,&json!({"source_mode":"DOCUMENT_EVIDENCE","source_refs":[{"doc_ref":"B","revision":"1"}]})).unwrap());
        for mode in ["CURRENT_KNOWLEDGE","DOCUMENT_EVIDENCE"] {
            assert!(!allowed(&row,&json!({"source_mode":mode,"source_refs":["C"]})).unwrap());
        }
    }
    #[test]
    fn source_scope_present_empty_null_or_false_context_never_falls_back() {
        for context in [json!([]),Value::Null,json!(false),json!(0)] {
            let row=json!({"context_source_refs":context,"source_refs":[{"doc_ref":"A","revision":"1"}],"doc_ref":"A","revision":"1"});
            assert!(!allowed(&row,&json!({"source_refs":["A"]})).unwrap());
            assert!(allowed(&row,&json!({"source_mode":"DOCUMENT_EVIDENCE","source_refs":["A"]})).unwrap());
        }
    }
    #[test]
    fn source_scope_legacy_document_fallback_preserves_presence_and_null_rules() {
        for mode in ["CURRENT_KNOWLEDGE","DOCUMENT_EVIDENCE"] {
            let args=json!({"source_mode":mode,"source_refs":[{"doc_ref":"A","revision":"1"}]});
            assert!(allowed(&json!({"doc_ref":"A","revision":"1"}),&args).unwrap());
            assert!(allowed(&json!({"source_refs":null,"doc_ref":"A","revision":"1"}),&args).unwrap());
            assert!(!allowed(&json!({"source_refs":[],"doc_ref":"A","revision":"1"}),&args).unwrap());
            assert!(!allowed(&json!({"source_refs":false,"doc_ref":"A","revision":"1"}),&args).unwrap());
            assert!(!allowed(&json!({"doc_ref":"A","revision":"2"}),&args).unwrap());
            assert!(!allowed(&json!({"original_source_refs":[{"doc_ref":"A","revision":"1"}]}),&args).unwrap());
        }
    }
    #[test]
    fn source_scope_invalid_mode_is_coded_even_for_empty_search_and_entity_pools() {
        for mode in [json!("UNKNOWN"),Value::Null,json!(false),json!(0),json!(""),json!([])] {
            let payload=json!({"args":{"source_mode":mode},"rows":[],"subjects":[]});
            assert_eq!(search_prepare(&payload).unwrap_err().code,"NATIVE_QUERY_SOURCE_MODE_INVALID");
            assert_eq!(entity_prepare(&payload).unwrap_err().code,"NATIVE_QUERY_SOURCE_MODE_INVALID");
        }
    }
    #[test]
    fn source_scope_fact_and_entity_projections_keep_qualified_context_and_mode() {
        let fact=json!({"fact_ref":"corrected","text":"current human statement","origin_layer":"HUMAN_CORRECTION",
            "answer_authority":"HUMAN_CORRECTION","context_source_refs":[{"doc_ref":"A","revision":"1"}],"source_refs":[],
            "original_source_refs":[{"doc_ref":"B","revision":"2"}],"conditions":["only the stated context"]});
        let rows=fact_rows(&json!({"facts":[fact]}));
        for key in ["context_source_refs","source_refs","origin_layer","answer_authority","conditions"] { assert_eq!(rows[0][key],fact[key]); }
        let current=search_prepare(&json!({"args":{"source_refs":["A"]},"rows":rows,"scope":{},"type":"facts"})).unwrap();
        assert_eq!(a(&current["scored"]).len(),1);
        let evidence=search_prepare(&json!({"args":{"source_mode":"DOCUMENT_EVIDENCE"},"rows":rows,"scope":{},"type":"facts"})).unwrap();
        assert!(a(&evidence["scored"]).is_empty());
        let subject=json!({"subject_ref":"subject","surface":"subject","context_source_refs":[{"doc_ref":"A","revision":"1"}],"source_refs":[]});
        let entity=entity_prepare(&json!({"args":{"source_mode":"CURRENT_KNOWLEDGE","source_refs":["A"]},"subjects":[subject]})).unwrap();
        assert_eq!(entity["args"]["source_mode"],"CURRENT_KNOWLEDGE");
        assert_eq!(entity["rows"][0]["context_source_refs"],json!([{"doc_ref":"A","revision":"1"}]));
        let matched=search_prepare(&json!({"args":entity["args"],"rows":entity["rows"],"scope":{},"type":"entities"})).unwrap();
        assert_eq!(a(&matched["scored"]).len(),1);
    }
    #[test]
    fn bm25_uses_authorized_corpus_idf_saturation_and_length_normalization() {
        let rows=vec![json!({"search_text":"rare common"}),json!({"search_text":"common common common common common"})];
        let scores=lexical_scores(&rows,"rare rare common");
        let norm=1.2*(0.25+0.75*2.0/3.5);
        let expected=(2.0_f64).ln()*2.2/(1.0+norm)+(1.0_f64+0.5/2.5).ln()*2.2/(1.0+norm);
        assert!((scores[0]-expected).abs()<1e-12);
        assert!(scores[0]>scores[1]);
        assert_eq!(scores,lexical_scores(&rows,"rare common"));
    }
    #[test]
    fn full_knowledge_and_qualifiers_do_not_change_vector_binding() {
        let fact=json!({"fact_ref":"f","text":"中文说明. Complete English text: NOT valid above 60 C.","statement":"简述","conditions":["only model N-4"],"negation":true,"unit":"C","exceptions":["separate authorization"],"embedding":{"text_sha256":"unchanged","values":[1,0]}});
        let rows=fact_rows(&json!({"facts":[fact]}));let row=&rows[0];
        assert_eq!(row["text"],fact["text"]);assert_eq!(row["statement"],fact["statement"]);assert_eq!(row["vector_text"],fact["text"]);assert_eq!(row["embedding"],fact["embedding"]);
        for part in ["Complete English","简述","only model N-4","NEGATED","separate authorization"]{assert!(s(&row["search_text"]).contains(part));}
    }
    #[test]
    fn scope_is_not_query_text_and_normalization_keeps_versions_and_negation() {
        let q=query_text(&json!({"query":" Ｎ-4  NOT  v2.1 ","keywords":["n-4","NOT"],"source_refs":["Manual Title"]})).unwrap();
        assert_eq!(q,"n-4 not v2.1");
        let p=search_prepare(&json!({"rows":[{"record_ref":"in","source_refs":[{"doc_ref":"D","revision":"1"}],"search_text":"author editor"},{"record_ref":"out","source_refs":[{"doc_ref":"E","revision":"1"}],"search_text":"author editor"}],"args":{"query":"author","source_refs":["D"]},"scope":{},"type":"facts"})).unwrap();
        assert_eq!(a(&p["scored"]).len(),1);assert_eq!(p["query"],"author");assert_eq!(p["ranking_revision"],RANKING_REVISION);
    }
    #[test]
    fn han_tokens_keep_unigrams_then_bigrams_and_normalization() {
        assert_eq!(tokens("Ａbc 中文字🙂"), vec!["abc","中","文","字","中文","文字"]);
    }
    #[test]
    fn exact_entities_remain_ambiguous_and_exclude_partial_candidates() {
        let prepared=entity_prepare(&json!({"args":{"query":"晨星"},"subjects":[{"subject_ref":"a","surface":"晨星"},{"subject_ref":"b","surface":"晨星"},{"subject_ref":"c","surface":"晨星公司"}]})).unwrap();
        assert_eq!(prepared["exact_count"],2);assert_eq!(prepared["exact_ambiguous"],true);assert_eq!(a(&prepared["rows"]).len(),2);
    }
    #[test]
    fn zero_and_overflowing_norm_vectors_are_rejected() {
        let space=json!({"dimensions":2});
        assert_eq!(checked_vector(&json!([0,0]),&space).unwrap_err().code,"NATIVE_QUERY_VECTOR_INVALID");
        assert_eq!(checked_vector(&json!([1.7e308,1.7e308]),&space).unwrap_err().code,"NATIVE_QUERY_VECTOR_INVALID");
        assert!(checked_vector(&json!([1e-300,1e-300]),&space).is_ok());
    }
    #[test]
    fn reversible_wire_markers_are_separators_and_keep_the_original_json_hash() {
        assert_eq!(tokens("a\u{e000}sd800\u{e000}b"),vec!["a","b"]);
        assert_eq!(tokens("a\u{e000}p\u{e000}b"),vec!["a","b"]);
        assert_eq!(wire_text_hash(&json!("value\u{e000}sd800\u{e000}")),text_sha("\"value\\ud800\""));
        assert_eq!(wire_text_hash(&json!("value\u{e000}p\u{e000}")),canonical_hash(&json!("value\u{e000}")));
    }
}
