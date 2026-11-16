//! Score and order the exact features supplied by the existing JS index.
//! Tokenization, NFKC, mention discovery and entity-neighbor discovery remain in JS.
use lightog_demand::{need, Error, Result};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    wire_version: String,
    request_id: String,
    operation: String,
    payload: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TermFrequency {
    term: String,
    count: u64,
}
fn nullable_entity<'de, D: Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Mention {
    normalized_mention: String,
    raw_utf16_length: u64,
    #[serde(deserialize_with = "nullable_entity")]
    entity_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Unit {
    id: String,
    source_id: String,
    start: u64,
    tie_break: u64,
    tf: Vec<TermFrequency>,
    mentions: Vec<Mention>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    normalized_question: String,
    query_terms: Vec<String>,
    direct_entity_ids: Vec<String>,
    neighbor_entity_ids: Vec<String>,
    units: Vec<Unit>,
}
#[derive(Serialize)]
struct Ranked {
    unit_id: String,
    score: f64,
    entity_recall_ids: Vec<String>,
    mention_recall: Vec<String>,
}
struct Scored {
    ranked: Ranked,
    tie_break: u64,
}

fn identifier(s: &str) -> bool {
    !s.is_empty() && s.len() <= 1024
}
fn unique_strings(values: &[String], limit: usize, code: &'static str) -> Result<()> {
    need(values.len() <= limit, "RANKING_RESOURCE_LIMIT")?;
    let mut seen = HashSet::new();
    need(values.iter().all(|s| identifier(s) && seen.insert(s)), code)
}
fn validate(p: &Payload) -> Result<()> {
    need(
        p.units.len() <= 4096 && p.normalized_question.len() <= 262144,
        "RANKING_RESOURCE_LIMIT",
    )?;
    unique_strings(&p.query_terms, 8192, "RANKING_QUERY_TERMS_INVALID")?;
    unique_strings(&p.direct_entity_ids, 8192, "RANKING_DIRECT_IDS_INVALID")?;
    unique_strings(&p.neighbor_entity_ids, 8192, "RANKING_NEIGHBOR_IDS_INVALID")?;
    let mut ids = HashSet::new();
    let mut ties = HashSet::new();
    let mut tf_total = 0;
    let mut mentions_total = 0;
    for u in &p.units {
        need(
            identifier(&u.id) && ids.insert(&u.id),
            "RANKING_UNIT_ID_INVALID",
        )?;
        need(
            identifier(&u.source_id) && u.start <= MAX_SAFE_INTEGER,
            "RANKING_UNIT_METADATA_INVALID",
        )?;
        need(
            u.tie_break <= MAX_SAFE_INTEGER && ties.insert(u.tie_break),
            "RANKING_TIE_BREAK_INVALID",
        )?;
        need(
            u.tf.len() <= 16384 && u.mentions.len() <= 4096,
            "RANKING_RESOURCE_LIMIT",
        )?;
        tf_total += u.tf.len();
        mentions_total += u.mentions.len();
        need(
            tf_total <= 1_048_576 && mentions_total <= 131072,
            "RANKING_RESOURCE_LIMIT",
        )?;
        let mut terms = HashSet::new();
        for tf in &u.tf {
            need(
                identifier(&tf.term) && terms.insert(&tf.term),
                "RANKING_TF_TERM_INVALID",
            )?;
            need(
                tf.count > 0 && tf.count <= MAX_SAFE_INTEGER,
                "RANKING_TF_COUNT_INVALID",
            )?;
        }
        for m in &u.mentions {
            // NFKC can expand a one-code-unit original. The original length must not
            // be recomputed from the normalized spelling (which is an input feature).
            need(
                m.raw_utf16_length <= MAX_SAFE_INTEGER && m.normalized_mention.len() <= 8192,
                "RANKING_MENTION_INVALID",
            )?;
            need(
                m.entity_id.as_ref().is_none_or(|id| id.len() <= 1024),
                "RANKING_MENTION_INVALID",
            )?;
        }
    }
    Ok(())
}

pub fn execute(value: &Value) -> Result<Value> {
    let r: Request =
        serde_json::from_value(value.clone()).map_err(|_| Error::new("RPC_INVALID_REQUEST"))?;
    need(
        r.wire_version == "lightog-ranking/0.1",
        "RPC_VERSION_UNSUPPORTED",
    )?;
    need(
        !r.request_id.is_empty() && r.request_id.len() <= 128,
        "RPC_INVALID_REQUEST",
    )?;
    need(r.operation == "rank", "RPC_OPERATION_UNKNOWN")?;
    rank(&r.payload)
}

pub fn rank(payload: &Value) -> Result<Value> {
    let p: Payload =
        serde_json::from_value(payload.clone()).map_err(|_| Error::new("RPC_INVALID_PAYLOAD"))?;
    validate(&p)?;
    let maps: Vec<HashMap<&str, u64>> = p
        .units
        .iter()
        .map(|u| u.tf.iter().map(|t| (t.term.as_str(), t.count)).collect())
        .collect();
    let df: Vec<usize> = p
        .query_terms
        .iter()
        .map(|q| maps.iter().filter(|tf| tf.contains_key(q.as_str())).count())
        .collect();
    let mut scored = Vec::with_capacity(p.units.len());
    for (i, u) in p.units.iter().enumerate() {
        let mut score = 0.0_f64;
        for (t, term) in p.query_terms.iter().enumerate() {
            if let Some(&n) = maps[i].get(term.as_str()) {
                // Preserve Math.log(1 + ratio), not log1p; preserve query-term order.
                let n = n as f64;
                score +=
                    (1.0 + (p.units.len() + 1) as f64 / (1 + df[t]) as f64).ln() * (n / (n + 1.5));
            }
        }
        // Legacy entity recall uses every truthy mention entity_id even when that
        // particular mention is absent from the question or shorter than two units.
        let entity_ids: HashSet<&str> = u
            .mentions
            .iter()
            .filter_map(|m| m.entity_id.as_deref())
            .filter(|s| !s.is_empty())
            .collect();
        let mut seen = HashSet::new();
        let mut mentions = Vec::new();
        for m in &u.mentions {
            if m.raw_utf16_length >= 2
                && p.normalized_question.contains(&m.normalized_mention)
                && seen.insert(m.normalized_mention.as_str())
            {
                mentions.push(m.normalized_mention.clone());
            }
        }
        let matched: Vec<String> = p
            .direct_entity_ids
            .iter()
            .filter(|id| entity_ids.contains(id.as_str()))
            .cloned()
            .collect();
        let neighbors = p
            .neighbor_entity_ids
            .iter()
            .filter(|id| entity_ids.contains(id.as_str()))
            .count();
        // JS computes this whole bonus expression first, then performs one +=.
        let bonus = (mentions.len().min(4) as f64 * 1.5 + matched.len() as f64 * 3.0)
            + if p.direct_entity_ids.len() > 1 && matched.len() == p.direct_entity_ids.len() {
                8.0
            } else {
                0.0
            }
            + neighbors as f64;
        score += bonus;
        need(score.is_finite() && score >= 0.0, "RANKING_NONFINITE_SCORE")?;
        mentions.truncate(12);
        scored.push(Scored {
            ranked: Ranked {
                unit_id: u.id.clone(),
                score,
                entity_recall_ids: matched,
                mention_recall: mentions,
            },
            tie_break: u.tie_break,
        });
    }
    scored.sort_by(|a, b| {
        b.ranked
            .score
            .total_cmp(&a.ranked.score)
            .then(a.tie_break.cmp(&b.tie_break))
    });
    let ranking: Vec<_> = scored.into_iter().map(|s| s.ranked).collect();
    let ranked_ids: Vec<_> = ranking.iter().map(|r| r.unit_id.as_str()).collect();
    // Response scores are ordinary JSON f64. The integer-only canonical wire hash
    // API is deliberately not called on this output.
    Ok(json!({"ranking":ranking,"ranked_ids":ranked_ids}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn unit(id: &str, tie: u64) -> Value {
        json!({"id":id,"source_id":"s","start":0,"tie_break":tie,"tf":[],"mentions":[]})
    }
    fn payload() -> Value {
        json!({"normalized_question":"aa bb","query_terms":["x"],"direct_entity_ids":["d2","d1"],"neighbor_entity_ids":["n"],"units":[{"id":"a","source_id":"s","start":0,"tie_break":1,"tf":[{"term":"x","count":2}],"mentions":[{"normalized_mention":"aa","raw_utf16_length":2,"entity_id":"d1"},{"normalized_mention":"bb","raw_utf16_length":2,"entity_id":"d2"},{"normalized_mention":"aa","raw_utf16_length":3,"entity_id":null},{"normalized_mention":"unmatched","raw_utf16_length":9,"entity_id":"n"}]},{"id":"b","source_id":"s","start":5,"tie_break":0,"tf":[],"mentions":[{"normalized_mention":"aa","raw_utf16_length":1,"entity_id":"d1"}]}]})
    }
    #[test]
    fn exact_bonus_features_and_order() {
        let p = payload();
        let before = p.clone();
        let r = rank(&p).unwrap();
        assert_eq!(r["ranked_ids"], json!(["a", "b"]));
        assert_eq!(r["ranking"][0]["entity_recall_ids"], json!(["d2", "d1"]));
        assert_eq!(r["ranking"][0]["mention_recall"], json!(["aa", "bb"]));
        assert!(
            (r["ranking"][0]["score"].as_f64().unwrap() - (2.5_f64.ln() * (2.0 / 3.5) + 18.0))
                .abs()
                < 1e-12
        );
        assert_eq!(r["ranking"][1]["score"], 3.0);
        assert_eq!(p, before);
    }
    #[test]
    fn empty_units_and_empty_query_are_valid() {
        let mut p = payload();
        p["units"] = json!([]);
        assert_eq!(rank(&p).unwrap()["ranked_ids"], json!([]));
        let mut p = payload();
        p["query_terms"] = json!([]);
        assert_eq!(rank(&p).unwrap()["ranking"][0]["score"], 18.0);
    }
    #[test]
    fn zero_scores_use_explicit_tie_break() {
        let p = json!({"normalized_question":"","query_terms":[],"direct_entity_ids":[],"neighbor_entity_ids":[],"units":[unit("a",10),unit("b",2)]});
        let r = rank(&p).unwrap();
        assert_eq!(r["ranked_ids"], json!(["b", "a"]));
        assert_eq!(r["ranking"][0]["score"], 0.0);
    }
    #[test]
    fn normalized_expansion_does_not_change_raw_length_gate() {
        let mut p = payload();
        p["query_terms"] = json!([]);
        p["direct_entity_ids"] = json!([]);
        p["neighbor_entity_ids"] = json!([]);
        p["normalized_question"] = json!("株式会社");
        p["units"] = json!([unit("a", 0)]);
        p["units"][0]["mentions"] =
            json!([{"normalized_mention":"株式会社","raw_utf16_length":1,"entity_id":null}]);
        assert_eq!(rank(&p).unwrap()["ranking"][0]["score"], 0.0);
    }
    #[test]
    fn mention_bonus_caps_at_four_but_recall_preserves_twelve() {
        let mut p = payload();
        let words: Vec<_> = (0..15).map(|i| format!("w{i}")).collect();
        p["normalized_question"] = json!(words.join(" "));
        p["query_terms"] = json!([]);
        p["direct_entity_ids"] = json!([]);
        p["neighbor_entity_ids"] = json!([]);
        p["units"] = json!([unit("a", 0)]);
        p["units"][0]["mentions"] = json!(words
            .iter()
            .map(|s| json!({"normalized_mention":s,"raw_utf16_length":2,"entity_id":null}))
            .collect::<Vec<_>>());
        let r = rank(&p).unwrap();
        assert_eq!(r["ranking"][0]["score"], 6.0);
        assert_eq!(r["ranking"][0]["mention_recall"], json!(words[..12]));
    }
    #[test]
    fn duplicate_and_integer_guards() {
        let mut p = payload();
        p["query_terms"] = json!(["x", "x"]);
        assert_eq!(rank(&p).unwrap_err().code, "RANKING_QUERY_TERMS_INVALID");
        let mut p = payload();
        p["units"][0]["tf"] = json!([{"term":"x","count":1},{"term":"x","count":2}]);
        assert_eq!(rank(&p).unwrap_err().code, "RANKING_TF_TERM_INVALID");
        let mut p = payload();
        p["units"][0]["tf"][0]["count"] = json!(0);
        assert_eq!(rank(&p).unwrap_err().code, "RANKING_TF_COUNT_INVALID");
        let mut p = payload();
        p["units"][1]["id"] = json!("a");
        assert_eq!(rank(&p).unwrap_err().code, "RANKING_UNIT_ID_INVALID");
        let mut p = payload();
        p["units"][1]["tie_break"] = json!(1);
        assert_eq!(rank(&p).unwrap_err().code, "RANKING_TIE_BREAK_INVALID");
        for key in ["direct_entity_ids", "neighbor_entity_ids"] {
            let mut p = payload();
            p[key] = json!(["d", "d"]);
            assert!(rank(&p).is_err());
        }
    }
    #[test]
    fn prototype_words_remain_plain_terms() {
        let mut p = payload();
        p["query_terms"] = json!(["__proto__"]);
        p["units"][0]["tf"] = json!([{"term":"__proto__","count":2}]);
        assert!(rank(&p).unwrap()["ranking"][0]["score"].as_f64().unwrap() > 18.0);
    }
    #[test]
    fn nullable_entity_field_is_required_and_other_types_rejected() {
        let mut p = payload();
        p["units"][0]["mentions"][0]
            .as_object_mut()
            .unwrap()
            .remove("entity_id");
        assert_eq!(rank(&p).unwrap_err().code, "RPC_INVALID_PAYLOAD");
        let mut p = payload();
        p["units"][0]["mentions"][0]["entity_id"] = json!(42);
        assert_eq!(rank(&p).unwrap_err().code, "RPC_INVALID_PAYLOAD");
    }
}
