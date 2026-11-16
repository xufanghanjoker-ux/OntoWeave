//! Original synthetic provenance/partition counterexamples; no provider or gold.
use lightog_core::{common::{canonical_hash, text_sha}, fine_source_evidence};
use serde_json::{json, Value};

fn fixture(text: &str, start: usize, end: usize) -> Value {
    let sha = text_sha(text);
    let snapshot = json!({"base_ref":"fine_test_base","source_epoch":0,"graph_revision":null,"sources":[{"source_ref":"fine_test_source","source_revision":"v1","text_sha256":sha,"original_sha256":sha,"parser_version":"synthetic/1"}]});
    let quote = String::from_utf16(&text.encode_utf16().collect::<Vec<_>>()[start..end]).unwrap();
    let es = json!({"contract_version":"lightog-demand/0.1","evidence_set_id":"fine_test_es","snapshot":snapshot,"fragments":[{"id":"old_coarse","origin":"SOURCE_FRAGMENT","source_ref":"fine_test_source","source_revision":"v1","block_ref":"fine_block","text_sha256":sha,"span":{"start":start,"end":end,"quote":quote,"offset_unit":"utf16_code_unit"},"claim_refs":[],"role":"PRIMARY"}]});
    let context = json!({"examples":{"raw":es},"source_texts":[{"source_ref":"fine_test_source","source_revision":"v1","text":text,"original_sha256":sha,"parser_version":"synthetic/1","blocks":[{"block_ref":"fine_block","start":0,"end":text.encode_utf16().count()}]}],"authority":{"requests":[],"allowed_snapshots":[snapshot],"claims":[],"receipts":[],"scope_bindings":[],"entities":[],"predicate_refs":[],"user_definitions":[],"groups":[],"entity_links":[]}});
    json!({"contract_version":fine_source_evidence::VERSION,"evidence_set":es,"context":context})
}
fn whole(text: &str) -> Value { fixture(text, 0, text.encode_utf16().count()) }
fn refine(p: &Value) -> Value { fine_source_evidence::execute("refine", p).unwrap() }

#[test]
fn partition_is_exact_lossless_and_not_semantic_certification() {
    let text = format!("😀 heading::\r\n\tOnly --merge applies.\r\n\r\n{}\r\n\r\nIf the same file differs AND has unstaged changes, abort.\r\n", "原文; ".repeat(450));
    let p = whole(&text); let before = p.clone(); let out = refine(&p);
    assert_eq!(before, p);
    let rows = out["evidence_set"]["fragments"].as_array().unwrap();
    assert!(rows.len() > 3);
    let joined: String = rows.iter().map(|f| f["span"]["quote"].as_str().unwrap()).collect();
    assert_eq!(joined, text);
    let mut end = 0;
    for f in rows { assert_eq!(f["span"]["start"], end); end = f["span"]["end"].as_u64().unwrap(); assert!(f["span"]["quote"].as_str().unwrap().encode_utf16().count() <= 640); assert_ne!(f["id"], "old_coarse"); }
    assert_eq!(out["receipt"]["semantic_support_certified"], false);
    assert_eq!(out["receipt"]["policy"]["source_enlarged"], false);
    assert_eq!(out["receipt"]["input_utf16"], out["receipt"]["output_utf16"]);
}

#[test]
fn refinement_never_adds_unretrieved_prefix_or_suffix() {
    let text = "SECRET prefix\n\n😀 only retrieved source.\n\nSECRET suffix";
    let byte = text.find('😀').unwrap(); let start = text[..byte].encode_utf16().count();
    let end = start + "😀 only retrieved source.".encode_utf16().count();
    let out = refine(&fixture(text, start, end));
    assert_eq!(out["evidence_set"]["fragments"].as_array().unwrap().len(), 1);
    assert_eq!(out["evidence_set"]["fragments"][0]["span"]["start"], start);
    assert_eq!(out["evidence_set"]["fragments"][0]["span"]["end"], end);
    assert!(!out["evidence_set"]["fragments"].to_string().contains("SECRET"));
}

#[test]
fn repeated_quotes_have_distinct_absolute_ids_and_reproducible_output() {
    let p = whole("same.\n\nsame.\n\n"); let out = refine(&p);
    assert_eq!(out, refine(&p));
    let rows = out["evidence_set"]["fragments"].as_array().unwrap();
    assert_eq!(rows[0]["span"]["quote"], rows[1]["span"]["quote"]);
    assert_ne!(rows[0]["id"], rows[1]["id"]);
    assert_ne!(rows[0]["span"]["start"], rows[1]["span"]["start"]);
}

#[test]
fn duplicate_parent_ranges_share_subspan_and_preserve_parent_trace() {
    let mut p = whole("heading::\nbody.\n\ncondition.");
    let mut second = p["evidence_set"]["fragments"][0].clone(); second["id"] = json!("second_coarse");
    p["evidence_set"]["fragments"].as_array_mut().unwrap().push(second);
    let out = refine(&p);
    assert_eq!(out["evidence_set"]["fragments"].as_array().unwrap().len(), 2);
    assert_eq!(out["receipt"]["fragments"][0]["parent_evidence_ids"], json!(["old_coarse", "second_coarse"]));
}

#[test]
fn source_revision_hash_quote_block_or_surrogate_drift_fails_before_refinement() {
    let p = whole("😀 repeated original.\n\nconditions.");
    for mutation in 0..6 {
        let mut bad = p.clone();
        match mutation {
            0 => bad["evidence_set"]["fragments"][0]["text_sha256"] = json!("0".repeat(64)),
            1 => bad["evidence_set"]["fragments"][0]["source_revision"] = json!("v2"),
            2 => bad["evidence_set"]["fragments"][0]["span"]["quote"] = json!("invented quote"),
            3 => bad["evidence_set"]["fragments"][0]["span"]["start"] = json!(1),
            4 => bad["evidence_set"]["fragments"][0]["block_ref"] = json!("unknown_block"),
            _ => bad["context"]["source_texts"][0]["text"] = json!("different source"),
        }
        assert!(fine_source_evidence::execute("refine", &bad).is_err(), "mutation {mutation}");
    }
}

#[test]
fn output_receipt_id_span_and_full_coarse_substitution_tampering_reject() {
    let p = whole("heading::\n\nmode effect.\n\nif both conditions then abort."); let out = refine(&p);
    let mut check = p.clone(); check["refinement"] = out.clone();
    assert_eq!(fine_source_evidence::execute("validate", &check).unwrap()["validated"], true);
    for mutation in 0..4 {
        let mut bad = check.clone();
        match mutation {
            0 => bad["refinement"]["evidence_set"]["fragments"][0]["span"]["start"] = json!(1),
            1 => bad["refinement"]["receipt"]["fragments"][0]["semantic_role_certified"] = json!(true),
            2 => bad["refinement"]["evidence_set"] = p["evidence_set"].clone(),
            _ => bad["refinement"]["evidence_set"]["fragments"][0]["id"] = json!("old_coarse"),
        }
        assert_eq!(fine_source_evidence::execute("validate", &bad).unwrap_err().code, "FINE_SOURCE_REFINEMENT_CHANGED");
    }
    assert_eq!(out["receipt"]["input_evidence_set_sha256"], canonical_hash(&p["evidence_set"]));
}

#[test]
fn fragment_and_context_budgets_fail_without_silent_truncation() {
    let rows = whole(&"a\n\n".repeat(129));
    let compacted = refine(&rows);
    assert!(compacted["evidence_set"]["fragments"].as_array().unwrap().len() < 128);
    assert_eq!(compacted["receipt"]["output_utf16"], 387);
    let over = whole(&"a".repeat(24001));
    assert_eq!(fine_source_evidence::execute("refine", &over).unwrap_err().code, "FINE_SOURCE_CONTEXT_BUDGET_EXCEEDED");
    let mut empty = whole("available but not retrieved"); empty["evidence_set"]["fragments"] = json!([]);
    assert_eq!(refine(&empty)["evidence_set"]["fragments"], json!([]));
}

#[test]
fn resource_compaction_is_exact_with_many_blank_paragraphs_and_original_offsets() {
    let text = format!("{}TAIL😀", "😀短段\r\n\r\n".repeat(900));
    let p = whole(&text); let out = refine(&p);
    let rows = out["evidence_set"]["fragments"].as_array().unwrap();
    assert!(rows.len() <= 128);
    assert_eq!(rows.iter().map(|f| f["span"]["quote"].as_str().unwrap()).collect::<String>(), text);
    assert!(out["receipt"]["policy"]["resource_compaction"].is_string());
    let mut end = 0;
    for f in rows { assert_eq!(f["span"]["start"], end); end = f["span"]["end"].as_u64().unwrap(); assert!(f["span"]["quote"].as_str().unwrap().encode_utf16().count() <= 640); }
    assert_eq!(end as usize, text.encode_utf16().count());
    let mut validation = p; validation["refinement"] = out;
    assert_eq!(fine_source_evidence::execute("validate", &validation).unwrap()["validated"], true);
}

#[test]
fn batches_partition_long_source_without_tail_loss_or_larger_single_model_context() {
    let text = format!("{}UNIQUE_TAIL😀", "😀 if A AND B, abort.\r\n\r\n".repeat(2500));
    let p = whole(&text);
    assert_eq!(fine_source_evidence::execute("refine", &p).unwrap_err().code, "FINE_SOURCE_CONTEXT_BUDGET_EXCEEDED");
    let out = fine_source_evidence::execute("refine_batches", &p).unwrap();
    let batches = out["batches"].as_array().unwrap(); assert!(batches.len() > 1);
    let mut joined = String::new(); let mut last = 0;
    for b in batches {
        let rows = b["evidence_set"]["fragments"].as_array().unwrap(); assert!(rows.len() <= 128);
        assert!(b["receipt"]["output_utf16"].as_u64().unwrap() <= 24000);
        for f in rows { assert_eq!(f["span"]["start"], last); last = f["span"]["end"].as_u64().unwrap(); joined.push_str(f["span"]["quote"].as_str().unwrap()); }
    }
    assert_eq!(joined, text); assert_eq!(out["receipt"]["truncated"], false);
    assert_eq!(out["execution_performed"], false);
    let mut check = p.clone(); check["refinement"] = out.clone();
    assert_eq!(fine_source_evidence::execute("validate_batches", &check).unwrap()["validated"], true);
    check["refinement"]["batches"].as_array_mut().unwrap().pop();
    assert_eq!(fine_source_evidence::execute("validate_batches", &check).unwrap_err().code, "FINE_SOURCE_REFINEMENT_CHANGED");
}

#[test]
fn batches_do_not_merge_distinct_blocks_and_reject_source_drift() {
    let text = "a".repeat(129);
    let mut p = whole(&text);
    let template = p["evidence_set"]["fragments"][0].clone();
    let rows: Vec<Value> = (0..129).map(|i| {let mut f=template.clone(); f["id"]=json!(format!("parent_{i}")); f["block_ref"]=json!(format!("block_{i}")); f["span"]=json!({"start":i,"end":i+1,"quote":"a","offset_unit":"utf16_code_unit"}); f}).collect();
    p["evidence_set"]["fragments"] = json!(rows);
    p["context"]["source_texts"][0]["blocks"] = json!((0..129).map(|i|json!({"block_ref":format!("block_{i}"),"start":i,"end":i+1})).collect::<Vec<_>>());
    let out=fine_source_evidence::execute("refine_batches", &p).unwrap();
    assert_eq!(out["batches"].as_array().unwrap().len(),2);
    assert_eq!(out["receipt"]["output_fragments"],129);
    assert_eq!(out["batches"][1]["evidence_set"]["fragments"][0]["block_ref"],"block_128");
    p["evidence_set"]["fragments"][128]["source_revision"]=json!("other");
    assert!(fine_source_evidence::execute("refine_batches", &p).is_err());
}

#[test]
fn batches_isolate_sources_and_accept_legacy_receipts() {
    let mut p = whole("Pine Relay keeps logs for seven days.");
    let maple = "Maple Relay encrypts delivery logs.";
    let maple_sha = text_sha(maple);
    let mut second = p["evidence_set"]["fragments"][0].clone();
    second["id"] = json!("maple_evidence");
    second["source_ref"] = json!("maple_source");
    second["source_revision"] = json!("v2");
    second["block_ref"] = json!("maple_block");
    second["text_sha256"] = json!(maple_sha);
    second["span"] = json!({"start":0,"end":maple.encode_utf16().count(),"quote":maple,"offset_unit":"utf16_code_unit"});
    p["evidence_set"]["fragments"].as_array_mut().unwrap().push(second);
    p["evidence_set"]["snapshot"]["sources"].as_array_mut().unwrap().push(json!({"source_ref":"maple_source","source_revision":"v2","text_sha256":maple_sha,"original_sha256":maple_sha,"parser_version":"synthetic/1"}));
    p["context"]["source_texts"].as_array_mut().unwrap().push(json!({"source_ref":"maple_source","source_revision":"v2","text":maple,"original_sha256":maple_sha,"parser_version":"synthetic/1","blocks":[{"block_ref":"maple_block","start":0,"end":maple.encode_utf16().count()}]}));
    p["context"]["authority"]["allowed_snapshots"][0] = p["evidence_set"]["snapshot"].clone();
    let out = fine_source_evidence::execute("refine_batches", &p).unwrap();
    assert_eq!(out["receipt"]["policy"]["source_isolation"], "SOURCE_REF_AND_REVISION_V1");
    let batches = out["batches"].as_array().unwrap();
    assert_eq!(batches.len(), 2);
    assert_eq!(batches[0]["evidence_set"]["fragments"][0]["source_ref"], "fine_test_source");
    assert_eq!(batches[1]["evidence_set"]["fragments"][0]["source_ref"], "maple_source");
    let mut check = p; check["refinement"] = out;
    assert_eq!(fine_source_evidence::execute("validate_batches", &check).unwrap()["validated"], true);

    let mut legacy = whole("Pine Relay keeps logs for seven days.");
    let mut old_plan = fine_source_evidence::execute("refine_batches", &legacy).unwrap();
    old_plan["receipt"]["policy"].as_object_mut().unwrap().remove("source_isolation");
    old_plan["receipt_sha256"] = json!(canonical_hash(&old_plan["receipt"]));
    legacy["refinement"] = old_plan;
    assert_eq!(fine_source_evidence::execute("validate_batches", &legacy).unwrap()["validated"], true);
}
