use lightog_core::temporal_core_v1::execute;
use serde_json::{json, Value};

fn point(value: &str, precision: &str) -> Value {
    json!({"value": value, "precision": precision, "basis": "fixture"})
}

fn assertion(entity: &str, start: Value, end: Value) -> Value {
    json!({
        "content": {"subject_ref": "machine", "predicate": "operator", "value": entity},
        "valid_time": {"kind": "STATE", "start": start, "end": end},
        "state_group": {"key": "operators", "single_valued": true},
        "sources": [{"source_version_id": entity, "kind": "DOCUMENT", "role": "SUPPORT"}]
    })
}

fn open_end() -> Value {
    json!({"kind": "OPEN_AS_REPORTED"})
}

fn base(versions: Vec<Value>) -> Value {
    let seq = if versions.is_empty() { 0 } else { 1 };
    json!({
        "head": {"activation_seq": seq, "activation_ref": "fixture"},
        "versions": versions, "support_links": []
    })
}

fn request(id: &str, base: Value, updates: Vec<Value>) -> Value {
    json!({"request_id": id, "library_id": "fixture", "base": base, "updates": updates})
}

fn routing(prepare: Value) -> Value {
    execute(
        "prepare_fact_routing",
        &json!({
            "prepare": prepare, "groups": {"operators": {"unique_subject": true}}
        }),
    )
    .unwrap()
}

fn adopted(mut version: Value) -> Value {
    version["system"] = json!({
        "from_seq": 1, "to_seq": null, "recorded_from": "2026-09-01T00:00:00Z", "recorded_to": null
    });
    version
}

#[test]
fn preserves_explicit_end_and_the_legacy_operation_does_not_change() {
    let source_end = point("2026-08-10T00:00:00Z", "EXACT");
    let next_start = point("2026-07-10T00:00:00Z", "EXACT");
    let proposed = request(
        "overlap",
        base(vec![]),
        vec![
            json!({"kind": "ADD_FACT", "reason": "initial assertion",
            "assertion": assertion("A", point("2026-07-01T00:00:00Z", "EXACT"),
                                   json!({"kind": "EXACT", "point": source_end}))}),
            json!({"kind": "STATE_CHANGE", "reason": "later assertion", "authority": "ONTOLOGY_SINGLE_VALUE",
            "assertion": assertion("B", next_start.clone(), open_end())}),
        ],
    );
    let routed = routing(proposed.clone());
    let versions = routed["plan"]["new_versions"].as_array().unwrap();
    let earlier = versions
        .iter()
        .find(|row| row["content"]["value"] == "A")
        .unwrap();
    assert_eq!(
        earlier["valid_time"]["end"]["point"]["value"],
        source_end["value"]
    );
    assert!(earlier["derivation"].is_null());
    assert_eq!(routed["conflicts"].as_array().unwrap().len(), 1);

    let legacy = execute("prepare_change_set", &proposed).unwrap();
    let earlier = legacy["new_versions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["content"]["value"] == "A")
        .unwrap();
    assert_eq!(
        earlier["valid_time"]["end"]["point"]["value"],
        next_start["value"]
    );
}

#[test]
fn explicit_handover_preserves_month_precision_and_old_version() {
    let old = routing(request(
        "old",
        base(vec![]),
        vec![json!({"kind": "ADD_FACT", "reason": "initial assertion",
            "assertion": assertion("A", point("2026-01-01T00:00:00Z", "EXACT"), open_end())})],
    ));
    let predecessor = adopted(old["plan"]["new_versions"][0].clone());
    let handover = routing(request(
        "handover",
        base(vec![predecessor.clone()]),
        vec![
            json!({"kind": "ANCHORED_HANDOVER", "reason": "explicitly replaced",
            "target_version_id": predecessor["fact_version_id"],
            "assertion": assertion("B", point("2026-07", "MONTH"), open_end())}),
        ],
    ));
    let plan = &handover["plan"];
    let earlier = plan["new_versions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["content"]["value"] == "A")
        .unwrap();
    assert_eq!(earlier["valid_time"]["end"]["point"]["precision"], "MONTH");
    assert_eq!(earlier["valid_time"]["end"]["point"]["value"], "2026-07");
    assert_eq!(earlier["supersedes"], predecessor["fact_version_id"]);
    assert_eq!(handover["conflicts"], json!([]));
    assert_eq!(
        plan["close_versions"][0]["fact_version_id"],
        predecessor["fact_version_id"]
    );
}

#[test]
fn withdrawing_one_support_retains_the_others_and_the_fact_identity() {
    let mut first = assertion("A", point("2026-01-01T00:00:00Z", "EXACT"), open_end());
    first["sources"]
        .as_array_mut()
        .unwrap()
        .push(json!({"source_version_id": "independent", "kind": "DOCUMENT", "role": "SUPPORT"}));
    let old = routing(request(
        "old",
        base(vec![]),
        vec![json!({"kind": "ADD_FACT", "reason": "initial assertion", "assertion": first})],
    ));
    let previous = adopted(old["plan"]["new_versions"][0].clone());
    let routed = routing(request(
        "remove",
        base(vec![previous.clone()]),
        vec![
            json!({"kind": "WITHDRAW_SUPPORTS", "target_version_id": previous["fact_version_id"],
            "source_version_ids": ["A"], "reason": "old source withdrawn",
            "basis": {"source_version_id": "retraction", "kind": "SOURCE_REVISION", "role": "BACKGROUND"}}),
        ],
    ));
    let update = &routed["plan"]["new_versions"][0];
    assert_eq!(update["fact_id"], previous["fact_id"]);
    assert_eq!(update["supersedes"], previous["fact_version_id"]);
    assert_eq!(update["sources"][0]["source_version_id"], "independent");
    assert_eq!(update["sources"][1]["role"], "BACKGROUND");
}
