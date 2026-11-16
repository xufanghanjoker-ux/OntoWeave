//! Frozen native-query graph navigation. Qualification and paging remain in Host.
use crate::common::{error, js_stringify, locale_cmp, nonempty, Result};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};

fn need(ok: bool, code: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(error(code, code))
    }
}
fn list(value: Option<&Value>) -> Vec<Value> {
    match value {
        None => vec![],
        Some(Value::Array(values)) => values.clone(),
        Some(value) => vec![value.clone()],
    }
}
fn nullish<'a>(value: Option<&'a Value>, fallback: Option<&'a Value>) -> Option<&'a Value> {
    value.filter(|value| !value.is_null()).or(fallback)
}
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
        other => js_stringify(other),
    }
}
fn direction(value: Option<&Value>, fallback: &str) -> Result<String> {
    let normalized = value
        .filter(|value| !value.is_null())
        .map(|value| js_string(value).to_uppercase())
        .unwrap_or_else(|| fallback.to_string());
    let result = match normalized.as_str() {
        "OUTGOING" => "OUT",
        "INCOMING" => "IN",
        other => other,
    };
    need(
        matches!(result, "OUT" | "IN" | "BOTH"),
        "NATIVE_QUERY_GRAPH_DIRECTION_INVALID",
    )?;
    Ok(result.to_string())
}
fn filtered(fact: &Value, args: &Value) -> bool {
    let kinds = list(nullish(args.get("kinds"), args.get("kind")));
    let predicates = list(args.get("predicates"));
    let predicate = nullish(fact.get("predicate"), fact.get("attribute"))
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| json!(""));
    (kinds.is_empty() || kinds.contains(&fact["kind"]))
        && (predicates.is_empty() || predicates.contains(&predicate))
}
fn known(value: &Value, entities: &HashSet<String>) -> Result<()> {
    need(
        nonempty(value) && value.as_str().is_some_and(|value| entities.contains(value)),
        "NATIVE_QUERY_ENTITY_UNKNOWN",
    )
}
fn safe_integer(value: &Value) -> Option<f64> {
    value.as_f64().filter(|number| {
        number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0
    })
}

#[derive(Clone)]
struct Step {
    from: String,
    to: String,
    reversed: bool,
    fact: Value,
}
impl Step {
    fn value(&self) -> Value {
        json!({"from_ref":self.from,"to_ref":self.to,"traversal_reversed":self.reversed,"fact":self.fact})
    }
}
#[derive(Clone)]
struct Path {
    nodes: Vec<String>,
    steps: Vec<Step>,
    path_ref: Option<String>,
}
impl Path {
    fn value(&self) -> Value {
        json!({"nodes":self.nodes,"steps":self.steps.iter().map(Step::value).collect::<Vec<_>>(),"path_ref":self.path_ref})
    }
}

pub fn execute(op: &str, payload: &Value) -> Result<Value> {
    let facts = payload["facts"].as_array().ok_or_else(|| {
        error(
            "NATIVE_QUERY_FACT_READER_INVALID",
            "NATIVE_QUERY_FACT_READER_INVALID",
        )
    })?;
    let subjects = payload["subjects"]
        .as_array()
        .ok_or_else(|| error("NATIVE_QUERY_READER_INVALID", "NATIVE_QUERY_READER_INVALID"))?;
    if facts.is_empty() {
        return Ok(json!({"unavailable":true}));
    }
    let args = &payload["args"];
    let mut entities: HashSet<String> = subjects
        .iter()
        .filter_map(|subject| subject["subject_ref"].as_str().map(String::from))
        .collect();
    for fact in facts {
        if let Some(value) = fact["subject_ref"].as_str() {
            entities.insert(value.to_string());
        }
        if fact["kind"] == "RELATION" {
            if let Some(value) = fact["object_ref"].as_str() {
                entities.insert(value.to_string());
            }
        }
        if let Some(participants) = fact["participants"].as_array() {
            for participant in participants {
                if let Some(value) = participant["subject_ref"].as_str() {
                    entities.insert(value.to_string());
                }
            }
        }
    }
    match op {
        "graph_entity_facts" => {
            known(&args["entity_ref"], &entities)?;
            let d = direction(args.get("direction"), "BOTH")?;
            let rows: Vec<_> = facts
                .iter()
                .filter(|fact| {
                    filtered(fact, args)
                        && ((d != "IN" && fact["subject_ref"] == args["entity_ref"])
                            || (d != "OUT"
                                && fact["kind"] == "RELATION"
                                && fact["object_ref"] == args["entity_ref"])
                            || (fact["kind"] == "RULE"
                                && fact["participants"].as_array().is_some_and(|participants| {
                                    participants.iter().any(|participant| {
                                        participant["subject_ref"] == args["entity_ref"]
                                    })
                                })))
                })
                .cloned()
                .collect();
            Ok(json!({"items":rows,"binding":{"type":"entity-facts"},"metadata":{}}))
        }
        "graph_expand" => {
            let seeds = list(args.get("seed_refs"));
            need(!seeds.is_empty(), "NATIVE_QUERY_GRAPH_SEEDS_REQUIRED")?;
            for seed in &seeds {
                known(seed, &entities)?;
            }
            let d = direction(args.get("direction"), "BOTH")?;
            let rows: Vec<_> = facts
                .iter()
                .filter(|fact| {
                    fact["kind"] == "RELATION"
                        && filtered(fact, args)
                        && ((d != "IN" && seeds.contains(&fact["subject_ref"]))
                            || (d != "OUT" && seeds.contains(&fact["object_ref"])))
                })
                .cloned()
                .collect();
            Ok(
                json!({"items":rows,"binding":{"type":"neighbors"},"metadata":{"seed_refs":seeds,"graph_hops":1}}),
            )
        }
        "graph_paths" => {
            known(&args["from_ref"], &entities)?;
            known(&args["to_ref"], &entities)?;
            let default_depth = json!(4);
            let default_work = json!(10000);
            let depth_value = nullish(
                args.get("max_depth"),
                nullish(payload["execution"].get("path_depth"), Some(&default_depth)),
            )
            .unwrap();
            let work_value = nullish(
                payload["execution"].get("max_path_edge_visits"),
                Some(&default_work),
            )
            .unwrap();
            let d = direction(args.get("direction"), "OUT")?;
            let depth = safe_integer(depth_value).filter(|value| *value >= 1.0 && *value <= 32.0);
            let work_limit = safe_integer(work_value).filter(|value| *value > 0.0);
            need(
                depth.is_some() && work_limit.is_some(),
                "NATIVE_QUERY_PATH_POLICY_INVALID",
            )?;
            let depth = depth.unwrap() as usize;
            let work_limit = work_limit.unwrap() as u64;
            let mut adjacency: HashMap<String, Vec<Step>> = HashMap::new();
            for fact in facts
                .iter()
                .filter(|fact| fact["kind"] == "RELATION" && filtered(fact, args))
            {
                let from = fact["subject_ref"].as_str().unwrap_or("");
                let to = fact["object_ref"].as_str().unwrap_or("");
                if d != "IN" {
                    adjacency.entry(from.to_string()).or_default().push(Step {
                        from: from.to_string(),
                        to: to.to_string(),
                        reversed: false,
                        fact: fact.clone(),
                    });
                }
                if d != "OUT" {
                    adjacency.entry(to.to_string()).or_default().push(Step {
                        from: to.to_string(),
                        to: from.to_string(),
                        reversed: true,
                        fact: fact.clone(),
                    });
                }
            }
            let from = args["from_ref"].as_str().unwrap();
            let to = args["to_ref"].as_str().unwrap();
            let mut queue = VecDeque::from([Path {
                nodes: vec![from.to_string()],
                steps: vec![],
                path_ref: None,
            }]);
            let mut paths = vec![];
            let mut work = 0u64;
            let mut bounded = false;
            while let Some(path) = queue.pop_front() {
                let node = path.nodes.last().unwrap();
                if node == to {
                    let mut complete = path;
                    complete.path_ref = Some(format!("path_{}", paths.len()));
                    paths.push(complete);
                    continue;
                }
                let next: Vec<_> = adjacency
                    .get(node)
                    .map(Vec::as_slice)
                    .unwrap_or(&[])
                    .iter()
                    .filter(|step| !path.nodes.contains(&step.to))
                    .collect();
                if path.steps.len() >= depth {
                    if !next.is_empty() {
                        bounded = true;
                    }
                    continue;
                }
                for step in next {
                    work += 1;
                    if work > work_limit {
                        bounded = true;
                        queue.clear();
                        break;
                    }
                    let mut expanded = path.clone();
                    expanded.nodes.push(step.to.clone());
                    expanded.steps.push(step.clone());
                    queue.push_back(expanded);
                }
            }
            paths.sort_by(|left, right| {
                left.steps.len().cmp(&right.steps.len()).then_with(|| {
                    locale_cmp(
                        &js_stringify(&json!(left.nodes)),
                        &js_stringify(&json!(right.nodes)),
                    )
                })
            });
            Ok(
                json!({"items":paths.iter().map(Path::value).collect::<Vec<_>>(),"binding":{"type":"paths","max_depth":depth,"workLimit":work_limit,"direction":d},"metadata":{"search_truncated":bounded,"max_depth":depth,"edge_visits":work,"coverage":"BOUNDED_GRAPH_SEARCH"}}),
            )
        }
        _ => Err(error("NATIVE_QUERY_CORE_OPERATION_UNKNOWN", op)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn payload() -> Value {
        json!({"subjects":[{"subject_ref":"A"},{"subject_ref":"B"},{"subject_ref":"C"}],"facts":[{"kind":"RELATION","subject_ref":"A","object_ref":"B","predicate":"connects"},{"kind":"RELATION","subject_ref":"B","object_ref":"C","predicate":"connects"}],"args":{"from_ref":"A","to_ref":"C"}})
    }
    #[test]
    fn directed_paths_keep_each_real_fact() {
        let value = execute("graph_paths", &payload()).unwrap();
        assert_eq!(value["items"][0]["nodes"], json!(["A", "B", "C"]));
        assert_eq!(value["items"][0]["steps"][0]["traversal_reversed"], false);
        assert_eq!(value["metadata"]["edge_visits"], 2);
    }
    #[test]
    fn reversed_edges_are_explicit() {
        let mut p = payload();
        p["args"] = json!({"from_ref":"C","to_ref":"A","direction":"IN"});
        let value = execute("graph_paths", &p).unwrap();
        assert_eq!(value["items"][0]["steps"][0]["traversal_reversed"], true);
    }
    #[test]
    fn work_truncation_matches_first_disallowed_visit() {
        let mut p = payload();
        p["execution"] = json!({"max_path_edge_visits":1});
        let value = execute("graph_paths", &p).unwrap();
        assert_eq!(value["metadata"]["edge_visits"], 2);
        assert_eq!(value["metadata"]["search_truncated"], true);
    }
    #[test]
    fn no_facts_precedes_argument_validation() {
        assert_eq!(
            execute("graph_paths", &json!({"facts":[],"subjects":[],"args":{}})).unwrap(),
            json!({"unavailable":true})
        );
    }
}
