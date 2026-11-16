//! P3 candidate: exact cosine + lexical RRF + bounded one-hop evidence recall.
//! No model/network/storage access. Derived descriptions are discovery hints.
use crate::common::{error, Result};
use lightog_demand::{knowledge_contract::KnowledgeKernel, wire, Kernel, ValidationContext};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use unicode_normalization::UnicodeNormalization;

pub const VERSION: &str = "lightog-hybrid-retrieval/0.1";
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    contract_version: String,
    question: String,
    queries: Queries,
    snapshot: Value,
    trusted_index: Index,
    query_vectors: Vec<QueryVector>,
    rerank: Option<Rerank>,
    options: Options,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Queries {
    document: String,
    entity: String,
    relation: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Index {
    records: Vec<Record>,
    edges: Vec<Edge>,
    manifests: Vec<Value>,
    context: Value,
    evidence_token_counts: BTreeMap<String, TokenCount>,
    tokenizer: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenCount {
    tokens: usize,
    quote_sha256: String,
    tokenizer: String,
}
#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct Record {
    id: String,
    kind: String,
    text: String,
    entity_refs: Vec<String>,
    evidence_ids: Vec<String>,
    status: String,
    profile: Option<Value>,
    embedding: Option<Embedding>,
}
#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct Embedding {
    index_id: String,
    values: Vec<f64>,
    text_sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QueryVector {
    component: String,
    index_id: String,
    vector_space: Value,
    query_text_sha256: String,
    values: Vec<f64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Edge {
    id: String,
    source_record_id: String,
    target_record_id: String,
    evidence_ids: Vec<String>,
    status: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rerank {
    status: String,
    model: String,
    candidate_set_sha256: String,
    scores: Vec<RerankScore>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RerankScore {
    record_id: String,
    score: f64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Options {
    channel_top_k: usize,
    result_top_k: usize,
    rrf_k: usize,
    max_graph_neighbors: usize,
    max_context_utf16: usize,
    max_context_tokens: Option<usize>,
    min_cosine: f64,
}
fn need(ok: bool, code: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(error(code, code))
    }
}
fn old<T>(r: lightog_demand::Result<T>) -> Result<T> {
    r.map_err(|e| error(e.code, e.code))
}
fn component(kind: &str) -> &str {
    if kind == "DOCUMENT" {
        "CHUNK"
    } else {
        kind
    }
}
fn query<'a>(r: &'a Request, kind: &str) -> &'a str {
    match kind {
        "DOCUMENT" | "CHUNK" => &r.queries.document,
        "ENTITY" => &r.queries.entity,
        _ => &r.queries.relation,
    }
}
fn terms(text: &str) -> Vec<String> {
    let normalized = text.nfkc().collect::<String>().to_lowercase();
    let mut out = vec![];
    let mut latin = String::new();
    let mut han = vec![];
    let flush = |latin: &mut String, han: &mut Vec<char>, out: &mut Vec<String>| {
        if !latin.is_empty() {
            out.push(std::mem::take(latin));
        }
        if han.len() == 1 {
            out.push(han[0].to_string());
        } else {
            for pair in han.windows(2) {
                out.push(pair.iter().collect());
            }
        }
        han.clear();
    };
    for c in normalized.chars() {
        if ('\u{3400}'..='\u{9fff}').contains(&c) {
            if !latin.is_empty() {
                out.push(std::mem::take(&mut latin));
            }
            han.push(c);
        } else if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            if !han.is_empty() {
                flush(&mut String::new(), &mut han, &mut out);
            }
            latin.push(c);
        } else {
            flush(&mut latin, &mut han, &mut out);
        }
    }
    flush(&mut latin, &mut han, &mut out);
    out
}
fn vector(values: &[f64], dim: usize) -> Result<f64> {
    need(
        values.len() == dim && !values.is_empty() && values.iter().all(|v| v.is_finite()),
        "P3_VECTOR_INVALID",
    )?;
    let norm = values.iter().map(|v| v * v).sum::<f64>().sqrt();
    need(norm.is_finite() && norm > 0.0, "P3_VECTOR_INVALID")?;
    Ok(norm)
}
fn cosine(left: &[f64], right: &[f64]) -> Result<f64> {
    let a = vector(left, right.len())?;
    let b = vector(right, left.len())?;
    let score = left
        .iter()
        .zip(right)
        .map(|(x, y)| (x / a) * (y / b))
        .sum::<f64>();
    need(score.is_finite(), "P3_VECTOR_INVALID")?;
    Ok(score.clamp(-1.0, 1.0))
}
fn anchor(f: &Value) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        f["source_ref"],
        f["source_revision"],
        f["span"]["start"],
        f["span"]["end"],
        f["text_sha256"]
    )
}
fn rank(mut rows: Vec<(String, f64)>, k: usize) -> Vec<(String, f64)> {
    rows.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    rows.truncate(k);
    rows
}

pub fn execute(op: &str, payload: &Value) -> Result<Value> {
    if op == "defaults" {
        need(payload == &json!({}), "P3_REQUEST_INVALID")?;
        return Ok(
            json!({"channel_top_k":20,"result_top_k":12,"rrf_k":60,"max_graph_neighbors":12,"max_context_utf16":16000,"max_context_tokens":null,"min_cosine":0.0}),
        );
    }
    need(op == "search", "P3_OPERATION_UNKNOWN")?;
    let request: Request = serde_json::from_value(payload.clone())
        .map_err(|_| error("P3_REQUEST_INVALID", "P3_REQUEST_INVALID"))?;
    search(&request)
}
fn search(r: &Request) -> Result<Value> {
    need(r.contract_version == VERSION, "P3_VERSION_UNSUPPORTED")?;
    need(
        !r.question.trim().is_empty() && r.question.len() <= 16000,
        "P3_QUERY_INVALID",
    )?;
    need(
        [&r.queries.document, &r.queries.entity, &r.queries.relation]
            .iter()
            .all(|q| q.len() <= 16000),
        "P3_QUERY_INVALID",
    )?;
    need(!r.queries.document.is_empty(), "P3_QUERY_INVALID")?;
    let o = &r.options;
    need(
        (1..=100).contains(&o.channel_top_k)
            && (1..=100).contains(&o.result_top_k)
            && (1..=10000).contains(&o.rrf_k)
            && o.max_graph_neighbors <= 100
            && o.max_context_utf16 <= 128000
            && o.max_context_utf16 > 0
            && o.max_context_tokens.is_none_or(|n| n > 0 && n <= 128000)
            && o.min_cosine.is_finite()
            && (-1.0..=1.0).contains(&o.min_cosine),
        "P3_OPTIONS_INVALID",
    )?;
    need(
        r.trusted_index.records.len() <= 10000
            && r.trusted_index.edges.len() <= 50000
            && r.trusted_index.manifests.len() <= 4
            && r.query_vectors.len() <= 4,
        "P3_RESOURCE_LIMIT",
    )?;
    need(
        r.trusted_index
            .records
            .iter()
            .map(|r| r.text.len())
            .sum::<usize>()
            <= 16 * 1024 * 1024
            && r.trusted_index
                .records
                .iter()
                .filter_map(|r| r.embedding.as_ref())
                .map(|e| e.values.len())
                .sum::<usize>()
                <= 2_000_000,
        "P3_RESOURCE_LIMIT",
    )?;
    let k = old(Kernel::new())?;
    let ctx = old(ValidationContext::from_value_v2(
        &r.trusted_index.context,
        &k,
    ))?;
    old(k.schema_check(&r.snapshot, "SourceSnapshot"))?;
    old(ctx.snapshot_check(&r.snapshot))?;
    let mut evidence = BTreeMap::<String, Value>::new();
    for value in ctx
        .examples()
        .values()
        .filter(|v| v.get("evidence_set_id").is_some() && v["snapshot"] == r.snapshot)
    {
        old(k.validate(value, "EvidenceSet", &ctx))?;
        for f in value["fragments"].as_array().unwrap() {
            let id = f["id"].as_str().unwrap().to_owned();
            if let Some(old) = evidence.insert(id, f.clone()) {
                need(old == *f, "P3_EVIDENCE_ID_COLLISION")?;
            }
        }
    }
    let knowledge = old(KnowledgeKernel::new())?;
    let mut manifests = BTreeMap::new();
    let mut manifest_components = BTreeSet::new();
    for manifest in &r.trusted_index.manifests {
        old(knowledge.validate(manifest, "IndexManifest", &ctx))?;
        need(
            manifest["status"] == "ACTIVE" && manifest["snapshot"] == r.snapshot,
            "P3_INDEX_NOT_CURRENT",
        )?;
        let id = manifest["index_id"].as_str().unwrap();
        need(
            manifests.insert(id, manifest).is_none()
                && manifest_components.insert(manifest["component"].as_str().unwrap()),
            "P3_INDEX_DUPLICATE",
        )?;
        need(
            manifest["vector_space"]["distance"] == "COSINE",
            "P3_DISTANCE_UNSUPPORTED",
        )?;
    }
    let mut vectors = BTreeMap::new();
    for q in &r.query_vectors {
        let manifest = manifests
            .get(q.index_id.as_str())
            .ok_or_else(|| error("P3_QUERY_INDEX_UNKNOWN", "P3_QUERY_INDEX_UNKNOWN"))?;
        need(
            q.component == manifest["component"] && q.vector_space == manifest["vector_space"],
            "P3_QUERY_SPACE_MISMATCH",
        )?;
        need(
            q.query_text_sha256 == wire::text_sha(query(r, &q.component)),
            "P3_QUERY_TEXT_MISMATCH",
        )?;
        vector(
            &q.values,
            q.vector_space["dimensions"].as_u64().unwrap() as usize,
        )?;
        need(
            vectors.insert(q.component.as_str(), q).is_none(),
            "P3_QUERY_VECTOR_DUPLICATE",
        )?;
    }
    let mut records = BTreeMap::<String, &Record>::new();
    let mut excluded = vec![];
    let mut ids = BTreeSet::new();
    for rec in &r.trusted_index.records {
        need(
            !rec.id.is_empty() && rec.id.len() <= 256 && ids.insert(rec.id.clone()),
            "P3_RECORD_ID_INVALID",
        )?;
        need(
            matches!(
                rec.kind.as_str(),
                "DOCUMENT" | "ENTITY" | "RELATION" | "PATTERN"
            ) && matches!(
                rec.status.as_str(),
                "SOURCE" | "DISCOVERY_HINT" | "PUBLISHED"
            ) && !rec.text.is_empty()
                && rec.text.len() <= 128000
                && !rec.evidence_ids.is_empty()
                && rec.evidence_ids.len() <= 128
                && rec.entity_refs.len() <= 128,
            "P3_RECORD_INVALID",
        )?;
        if rec.evidence_ids.iter().any(|id| !evidence.contains_key(id)) {
            excluded.push(json!({"record_id":rec.id,"reason":"EVIDENCE_NOT_IN_CURRENT_SNAPSHOT"}));
            continue;
        }
        if rec.kind == "DOCUMENT" {
            need(
                rec.status == "SOURCE"
                    && rec.evidence_ids.len() == 1
                    && rec.text == evidence[&rec.evidence_ids[0]]["span"]["quote"],
                "P3_DOCUMENT_TEXT_MISMATCH",
            )?;
        } else {
            need(rec.status != "SOURCE", "P3_RECORD_INVALID")?;
        }
        if rec.status == "PUBLISHED" {
            need(
                rec.evidence_ids
                    .iter()
                    .all(|id| evidence[id]["origin"] == "PUBLISHED_CLAIM"),
                "P3_PUBLICATION_UNVERIFIED",
            )?;
        }
        if let Some(profile) = &rec.profile {
            old(knowledge.validate(profile, "RetrievalProfile", &ctx))?;
            need(
                profile["snapshot"] == r.snapshot
                    && profile["profile_kind"] == rec.kind
                    && profile["text"] == rec.text
                    && profile["evidence_ids"] == json!(rec.evidence_ids),
                "P3_PROFILE_MISMATCH",
            )?;
        }
        if let Some(embedding) = &rec.embedding {
            let manifest = manifests
                .get(embedding.index_id.as_str())
                .ok_or_else(|| error("P3_RECORD_INDEX_UNKNOWN", "P3_RECORD_INDEX_UNKNOWN"))?;
            need(
                component(&rec.kind) == manifest["component"],
                "P3_RECORD_SPACE_MISMATCH",
            )?;
            need(
                embedding.text_sha256 == wire::text_sha(&rec.text),
                "P3_EMBEDDED_TEXT_MISMATCH",
            )?;
            vector(
                &embedding.values,
                manifest["vector_space"]["dimensions"].as_u64().unwrap() as usize,
            )?;
        }
        records.insert(rec.id.clone(), rec);
    }
    for (id, manifest) in &manifests {
        let count = r
            .trusted_index
            .records
            .iter()
            .filter(|r| r.embedding.as_ref().is_some_and(|e| e.index_id == *id))
            .count();
        need(
            manifest["records_total"].as_u64() == Some(count as u64),
            "P3_INDEX_CONTENT_INCOMPLETE",
        )?;
    }
    let mut channels = BTreeMap::<String, Vec<(String, f64)>>::new();
    for kind in ["DOCUMENT", "ENTITY", "RELATION", "PATTERN"] {
        let group: Vec<_> = records.values().filter(|rec| rec.kind == kind).collect();
        let qt: BTreeSet<_> = terms(query(r, kind)).into_iter().collect();
        let mut lex = vec![];
        let features: Vec<_> = group
            .iter()
            .map(|rec| {
                let mut tf = BTreeMap::<String, usize>::new();
                for word in terms(&rec.text) {
                    *tf.entry(word).or_default() += 1;
                }
                (rec, tf)
            })
            .collect();
        let df: BTreeMap<_, _> = qt
            .iter()
            .map(|term| {
                (
                    term.clone(),
                    features
                        .iter()
                        .filter(|(_, tf)| tf.contains_key(term))
                        .count() as f64,
                )
            })
            .collect();
        for (rec, tf) in &features {
            let mut score = 0.0;
            for term in &qt {
                let count = *tf.get(term).unwrap_or(&0) as f64;
                if count > 0.0 {
                    let df = df[term];
                    score += (1.0 + (group.len() as f64 + 1.0) / (df + 1.0)).ln() * count
                        / (count + 1.5);
                }
            }
            if score > 0.0 {
                lex.push((rec.id.clone(), score));
            }
        }
        channels.insert(format!("{kind}_LEXICAL"), rank(lex, o.channel_top_k));
        if let Some(q) = vectors.get(component(kind)) {
            let mut dense = vec![];
            for rec in &group {
                if let Some(v) = &rec.embedding {
                    need(v.index_id == q.index_id, "P3_RECORD_SPACE_MISMATCH")?;
                    let score = cosine(&q.values, &v.values)?;
                    if score >= o.min_cosine {
                        dense.push((rec.id.clone(), score));
                    }
                }
            }
            channels.insert(format!("{kind}_DENSE"), rank(dense, o.channel_top_k));
        }
    }
    let mut fused = BTreeMap::<String, f64>::new();
    for rows in channels.values() {
        for (i, (id, _)) in rows.iter().enumerate() {
            *fused.entry(id.clone()).or_default() += 1.0 / (o.rrf_k + i + 1) as f64;
        }
    }
    let mut ranked = rank(fused.into_iter().collect(), o.result_top_k);
    let candidate_ids: Vec<_> = ranked.iter().map(|(id, _)| id.clone()).collect();
    let candidate_fingerprints:Vec<_>=candidate_ids.iter().map(|id|{let rec=records[id];json!({"record_id":id,"text_sha256":wire::text_sha(&rec.text),"evidence_ids":rec.evidence_ids,"status":rec.status,"kind":rec.kind})}).collect();
    let candidate_hash = old(wire::sha(
        &json!({"question":r.question,"queries":{"document":r.queries.document,"entity":r.queries.entity,"relation":r.queries.relation},"snapshot":r.snapshot,"candidates":candidate_fingerprints}),
    ))?;
    let rerank_status = if let Some(rerank) = &r.rerank {
        need(
            !rerank.model.is_empty() && rerank.candidate_set_sha256 == candidate_hash,
            "P3_RERANK_SET_MISMATCH",
        )?;
        match rerank.status.as_str() {
            "COMPLETE" => {
                need(rerank.scores.len() == ranked.len(), "P3_RERANK_INCOMPLETE")?;
                let mut score_map = BTreeMap::new();
                for s in &rerank.scores {
                    need(
                        s.score.is_finite()
                            && candidate_ids.contains(&s.record_id)
                            && score_map.insert(s.record_id.clone(), s.score).is_none(),
                        "P3_RERANK_INVALID",
                    )?;
                }
                ranked.sort_by(|a, b| {
                    score_map[&b.0]
                        .total_cmp(&score_map[&a.0])
                        .then(a.0.cmp(&b.0))
                });
                "HOST_SCORES_CONSUMED"
            }
            "FAILED" => {
                need(rerank.scores.is_empty(), "P3_RERANK_INVALID")?;
                "FAILED_FALLBACK_RRF"
            }
            _ => return Err(error("P3_RERANK_INVALID", "P3_RERANK_INVALID")),
        }
    } else {
        "NOT_CONFIGURED"
    };
    let seeds: BTreeSet<_> = ranked.iter().map(|(id, _)| id.clone()).collect();
    let mut neighbors = BTreeSet::new();
    let mut navigation_sources = BTreeMap::<String, BTreeSet<String>>::new();
    let mut edge_ids = BTreeSet::new();
    for edge in &r.trusted_index.edges {
        need(
            !edge.id.is_empty()
                && edge_ids.insert(&edge.id)
                && matches!(edge.status.as_str(), "DISCOVERY_HINT" | "PUBLISHED")
                && !edge.evidence_ids.is_empty(),
            "P3_EDGE_INVALID",
        )?;
        if edge
            .evidence_ids
            .iter()
            .any(|id| !evidence.contains_key(id))
        {
            continue;
        }
        if edge.status == "PUBLISHED" {
            need(
                edge.evidence_ids
                    .iter()
                    .all(|id| evidence[id]["origin"] == "PUBLISHED_CLAIM"),
                "P3_PUBLICATION_UNVERIFIED",
            )?;
        }
        need(
            ids.contains(&edge.source_record_id) && ids.contains(&edge.target_record_id),
            "P3_EDGE_ENDPOINT_UNKNOWN",
        )?;
        if seeds.contains(&edge.source_record_id)
            && !seeds.contains(&edge.target_record_id)
            && records.contains_key(&edge.target_record_id)
        {
            neighbors.insert(edge.target_record_id.clone());
            navigation_sources
                .entry(edge.target_record_id.clone())
                .or_default()
                .extend(edge.evidence_ids.iter().cloned());
        }
        if seeds.contains(&edge.target_record_id)
            && !seeds.contains(&edge.source_record_id)
            && records.contains_key(&edge.source_record_id)
        {
            neighbors.insert(edge.source_record_id.clone());
            navigation_sources
                .entry(edge.source_record_id.clone())
                .or_default()
                .extend(edge.evidence_ids.iter().cloned());
        }
    }
    let expanded: Vec<_> = neighbors.into_iter().take(o.max_graph_neighbors).collect();
    for id in &expanded {
        ranked.push((id.clone(), 0.0));
    }
    if o.max_context_tokens.is_some() {
        need(
            r.trusted_index
                .tokenizer
                .as_ref()
                .is_some_and(|s| !s.is_empty()),
            "P3_TOKENIZER_REQUIRED",
        )?;
    }
    let mut selected = vec![];
    let mut contexts = vec![];
    let mut deferred = vec![];
    let mut anchors = BTreeMap::<String, String>::new();
    let mut aliases = BTreeMap::<String, String>::new();
    let mut context_utf16 = 0;
    let mut context_tokens = 0;
    for (id, score) in &ranked {
        let rec = records[id];
        let navigation: Vec<String> = navigation_sources
            .get(id)
            .map(|ids| ids.iter().cloned().collect())
            .unwrap_or_default();
        let required: Vec<String> = rec
            .evidence_ids
            .iter()
            .chain(navigation.iter())
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let mut pending = BTreeMap::new();
        for eid in &required {
            let f = &evidence[eid];
            let key = anchor(f);
            if !anchors.contains_key(&key) {
                pending
                    .entry(key)
                    .or_insert_with(|| (eid.clone(), f.clone()));
            }
        }
        let chars: usize = pending
            .values()
            .map(|(_, f)| f["span"]["quote"].as_str().unwrap().encode_utf16().count())
            .sum();
        let mut tokens = 0;
        if o.max_context_tokens.is_some() {
            let mut counts = BTreeMap::new();
            for eid in &required {
                let f = &evidence[eid];
                let key = anchor(f);
                let receipt = r
                    .trusted_index
                    .evidence_token_counts
                    .get(eid)
                    .ok_or_else(|| error("P3_TOKEN_COUNT_MISSING", "P3_TOKEN_COUNT_MISSING"))?;
                need(
                    receipt.tokens > 0 && receipt.tokens <= 128000,
                    "P3_TOKEN_COUNT_INVALID",
                )?;
                need(
                    Some(receipt.tokenizer.as_str()) == r.trusted_index.tokenizer.as_deref()
                        && receipt.quote_sha256
                            == wire::text_sha(f["span"]["quote"].as_str().unwrap()),
                    "P3_TOKEN_RECEIPT_MISMATCH",
                )?;
                if let Some(canonical) = anchors.get(&key) {
                    let prior = &r.trusted_index.evidence_token_counts[canonical];
                    need(prior.tokens == receipt.tokens, "P3_TOKEN_ALIAS_CONFLICT")?;
                }
                if let Some(prior) = counts.insert(key.clone(), receipt.tokens) {
                    need(prior == receipt.tokens, "P3_TOKEN_ALIAS_CONFLICT")?;
                }
            }
            for key in pending.keys() {
                tokens += counts[key];
            }
        }
        if context_utf16 + chars > o.max_context_utf16
            || o.max_context_tokens
                .is_some_and(|max| context_tokens + tokens > max)
        {
            deferred.push(json!({"record_id":id,"reason":"WHOLE_EVIDENCE_BUDGET"}));
            continue;
        }
        for (key, (eid, f)) in pending {
            anchors.insert(key, eid);
            contexts.push(f);
        }
        for eid in &required {
            aliases.insert(eid.clone(), anchors[&anchor(&evidence[eid])].clone());
        }
        context_utf16 += chars;
        context_tokens += tokens;
        selected.push(json!({"record_id":id,"kind":rec.kind,"score":score,"reason":if seeds.contains(id){"RETRIEVAL"}else{"ONE_HOP"},"status":rec.status,"entity_refs":rec.entity_refs,"evidence_ids":required,"record_evidence_ids":rec.evidence_ids,"navigation_evidence_ids":navigation,"text":rec.text,"semantic_support":"NOT_CERTIFIED_BY_RETRIEVAL"}));
    }
    let mut provenance = BTreeMap::<String, Vec<Value>>::new();
    for (original, canonical) in &aliases {
        provenance
            .entry(canonical.clone())
            .or_default()
            .push(evidence[original].clone());
    }
    Ok(
        json!({"contract_version":VERSION,"snapshot":r.snapshot,"evidence_provenance":provenance,"records":selected,"contexts":contexts,"evidence_aliases":aliases,"deferred":deferred,"excluded":excluded,"trace":{"channels":channels,"pre_rerank_candidate_ids":candidate_ids,"candidate_set_sha256":candidate_hash,"expanded_record_ids":expanded,"embedding_status":if manifests.is_empty(){"NOT_CONFIGURED"}else if vectors.is_empty(){"CONFIGURED_QUERY_VECTOR_MISSING_LEXICAL_ONLY"}else if vectors.len()<manifests.len(){"HOST_VECTORS_CONSUMED_PARTIAL_CHANNELS"}else{"HOST_VECTORS_CONSUMED"},"rerank_status":rerank_status,"context_utf16":context_utf16,"context_tokens":if o.max_context_tokens.is_some(){json!(context_tokens)}else{Value::Null},"tokenizer":r.trusted_index.tokenizer,"token_budget_scope":"SOURCE_QUOTES_ONLY_HOST_RESERVES_PROMPT_OVERHEAD","graph_hops":1,"coverage":"LOCAL_RETRIEVAL_NOT_EXHAUSTIVE","publication_performed":false,"model_calls_performed":0}}),
    )
}
