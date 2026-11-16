//! Synthetic P1 boundary tests, not extraction or retrieval quality evaluation.
use lightog_demand::{
    knowledge_contract::{execute, KnowledgeKernel},
    wire, Kernel, ValidationContext,
};
use serde_json::{json, Value};

fn raw_context() -> Value {
    let source: Value = serde_json::from_str(include_str!(
        "../../../fixtures/demand-contract-v0.1/source-texts.json"
    ))
    .unwrap();
    let authority: Value = serde_json::from_str(include_str!(
        "../../../fixtures/demand-contract-v0.1/validation-context.json"
    ))
    .unwrap();
    let evidence: Value = serde_json::from_str(include_str!(
        "../../../contracts/demand-v0.1/examples/evidence-set.json"
    ))
    .unwrap();
    let graph: Value = serde_json::from_str(include_str!(
        "../../../contracts/demand-v0.1/examples/graph-evidence-set.json"
    ))
    .unwrap();
    json!({"examples":{"evidence":evidence,"graph":graph},"source_texts":source["sources"],"authority":authority})
}
fn ctx(raw: &Value) -> ValidationContext {
    ValidationContext::from_value(raw, &Kernel::new().unwrap()).unwrap()
}
fn candidate(raw: &Value) -> Value {
    let mention = |local_id: &str, label: &str, start: usize, end: usize| json!({"local_id":local_id,"label":label,"entity_ref":null,"type_label":null,"mentions":[{"evidence_ref":"e_new","span":{"start":start,"end":end,"quote":label,"offset_unit":"utf16_code_unit"}}]});
    json!({"contract_version":"lightog-knowledge/0.2","candidate_id":"candidate_new","kind":"RELATION","snapshot":raw["examples"]["evidence"]["snapshot"],"evidence_set_ref":"es_synthetic","evidence_ids":["e_new"],"entities":[mention("cloud","丁云",0,2),mention("europe","欧洲",11,13)],"subject_local_id":"cloud","predicate":{"predicate_ref":null,"proposed_definition":{"label":"服务地区","description":"资料报告服务的地区","evidence_ids":["e_new"]}},"object":{"entity_local_id":"europe","typed_value":null},"direction":"DIRECTED","description":"丁云在欧洲提供服务，待核对","keywords":["服务地区"],"qualifiers":{"scope":"零售客户","modality":"REPORTED","negated":false,"unit":null,"effective_time":null},"conditions":[{"id":"retail","text":"面向零售客户","evidence_ids":["e_new"],"support_status":"UNVERIFIED"}],"status":"CANDIDATE","semantic_status":"UNVERIFIED"})
}
fn profile(raw: &Value) -> Value {
    json!({"contract_version":"lightog-knowledge/0.2","profile_id":"profile_new","profile_revision":"p1","profile_kind":"RELATION","snapshot":raw["examples"]["graph"]["snapshot"],"subject_ref":null,"evidence_set_ref":"es_graph_synthetic","evidence_ids":["e_graph_new"],"claim_refs":["claim_d_europe"],"text":"丁云在欧洲面向零售客户提供电话服务。","keywords":["客服"],"text_policy":"grounded-description/1","status":"DERIVED_INDEX","semantic_status":"NOT_FACT"})
}
fn index(raw: &Value, id: &str) -> Value {
    json!({"contract_version":"lightog-knowledge/0.2","index_id":id,"index_revision":"v1","component":"RELATION","snapshot":raw["examples"]["graph"]["snapshot"],"vector_space":{"provider":"synthetic","model":"fixture-model","model_revision":"1","dimensions":3,"normalization":"L2","distance":"COSINE","text_policy":"grounded-description/1","tokenizer_version":"fixture/1"},"status":"READY","records_total":2,"vectors_completed":2,"build_receipt_ref":format!("build_{id}")})
}
fn receipt(raw: &mut Value, index: &Value) {
    raw["authority"]["receipts"].as_array_mut().unwrap().push(json!({"receipt_ref":index["build_receipt_ref"],"kind":"INDEX_BUILD","status":"COMPLETE","index_id":index["index_id"],"index_revision":index["index_revision"],"snapshot_sha256":wire::sha(&index["snapshot"]).unwrap(),"vector_space_sha256":wire::sha(&index["vector_space"]).unwrap(),"component":index["component"],"records_total":index["records_total"],"vectors_completed":index["vectors_completed"]}));
}

#[test]
fn unknown_predicate_and_ungraphed_entities_are_valid_unverified_candidates() {
    let raw = raw_context();
    let value = candidate(&raw);
    let result = execute(
        "validate",
        &json!({"definition":"ExtractionCandidate","value":value,"trusted_context":raw}),
    )
    .unwrap();
    assert_eq!(result["validated"], true);
    assert_eq!(result["semantic_support_certified"], false);
    assert_eq!(result["publication_performed"], false);
}
#[test]
fn candidate_cannot_self_certify_conditions_or_become_published() {
    let raw = raw_context();
    let kernel = KnowledgeKernel::new().unwrap();
    let mut value = candidate(&raw);
    value["conditions"][0]["support_status"] = json!("SUPPORTED");
    assert_eq!(
        kernel
            .validate(&value, "ExtractionCandidate", &ctx(&raw))
            .unwrap_err()
            .code,
        "SCHEMA_INVALID"
    );
    value = candidate(&raw);
    value["status"] = json!("PUBLISHED");
    assert_eq!(
        kernel
            .validate(&value, "ExtractionCandidate", &ctx(&raw))
            .unwrap_err()
            .code,
        "SCHEMA_INVALID"
    );
}
#[test]
fn predicate_must_be_existing_or_proposed_never_silently_invented() {
    let raw = raw_context();
    let kernel = KnowledgeKernel::new().unwrap();
    let context = ctx(&raw);
    let mut value = candidate(&raw);
    value["predicate"]["proposed_definition"] = Value::Null;
    assert_eq!(
        kernel
            .validate(&value, "ExtractionCandidate", &context)
            .unwrap_err()
            .code,
        "PREDICATE_PROPOSAL_INVALID"
    );
    value["predicate"]["predicate_ref"] = json!("nonexistent");
    assert_eq!(
        kernel
            .validate(&value, "ExtractionCandidate", &context)
            .unwrap_err()
            .code,
        "PREDICATE_REF_UNRESOLVED"
    );
}
#[test]
fn candidate_rejects_dangling_identity_evidence_and_wrong_raw_position() {
    let raw = raw_context();
    let kernel = KnowledgeKernel::new().unwrap();
    let context = ctx(&raw);
    let mut value = candidate(&raw);
    value["object"]["entity_local_id"] = json!("missing");
    assert_eq!(
        kernel
            .validate(&value, "ExtractionCandidate", &context)
            .unwrap_err()
            .code,
        "CANDIDATE_RELATION_INVALID"
    );
    value = candidate(&raw);
    value["conditions"][0]["evidence_ids"] = json!(["unknown"]);
    assert_eq!(
        kernel
            .validate(&value, "ExtractionCandidate", &context)
            .unwrap_err()
            .code,
        "UNKNOWN_EVIDENCE_REF"
    );
    value = candidate(&raw);
    value["entities"][0]["mentions"][0]["span"]["start"] = json!(1);
    assert!(kernel
        .validate(&value, "ExtractionCandidate", &context)
        .is_err());
}
#[test]
fn withdrawal_and_tampered_underlying_evidence_are_rejected() {
    let mut raw = raw_context();
    let value = candidate(&raw);
    raw["authority"]["allowed_snapshots"] = json!([]);
    assert_eq!(
        KnowledgeKernel::new()
            .unwrap()
            .validate(&value, "ExtractionCandidate", &ctx(&raw))
            .unwrap_err()
            .code,
        "SOURCE_SNAPSHOT_MISMATCH"
    );
    raw = raw_context();
    raw["examples"]["evidence"]["fragments"][1]["span"]["quote"] = json!("伪造引文");
    assert!(KnowledgeKernel::new()
        .unwrap()
        .validate(&value, "ExtractionCandidate", &ctx(&raw))
        .is_err());
}
#[test]
fn profile_preserves_exact_published_claim_dependencies_and_is_not_a_fact() {
    let raw = raw_context();
    let kernel = KnowledgeKernel::new().unwrap();
    let context = ctx(&raw);
    let mut value = profile(&raw);
    kernel
        .validate(&value, "RetrievalProfile", &context)
        .unwrap();
    value["claim_refs"] = json!([]);
    assert_eq!(
        kernel
            .validate(&value, "RetrievalProfile", &context)
            .unwrap_err()
            .code,
        "PROFILE_CLAIM_DEPENDENCY_MISMATCH"
    );
    value = profile(&raw);
    value["claim_refs"] = json!(["fake"]);
    assert_eq!(
        kernel
            .validate(&value, "RetrievalProfile", &context)
            .unwrap_err()
            .code,
        "PROFILE_CLAIM_DEPENDENCY_MISMATCH"
    );
    value = profile(&raw);
    value["semantic_status"] = json!("VERIFIED_FACT");
    assert_eq!(
        kernel
            .validate(&value, "RetrievalProfile", &context)
            .unwrap_err()
            .code,
        "SCHEMA_INVALID"
    );
}
#[test]
fn source_only_profile_does_not_require_fake_claims() {
    let raw = raw_context();
    let mut value = profile(&raw);
    value["snapshot"] = raw["examples"]["evidence"]["snapshot"].clone();
    value["evidence_set_ref"] = json!("es_synthetic");
    value["evidence_ids"] = json!(["e_new"]);
    value["claim_refs"] = json!([]);
    KnowledgeKernel::new()
        .unwrap()
        .validate(&value, "RetrievalProfile", &ctx(&raw))
        .unwrap();
}
#[test]
fn index_ready_requires_complete_host_bound_build_receipt() {
    let mut raw = raw_context();
    let mut value = index(&raw, "index_new");
    let kernel = KnowledgeKernel::new().unwrap();
    assert_eq!(
        kernel
            .validate(&value, "IndexManifest", &ctx(&raw))
            .unwrap_err()
            .code,
        "INDEX_BUILD_RECEIPT_UNRESOLVED"
    );
    receipt(&mut raw, &value);
    kernel
        .validate(&value, "IndexManifest", &ctx(&raw))
        .unwrap();
    value["vectors_completed"] = json!(1);
    assert_eq!(
        kernel
            .validate(&value, "IndexManifest", &ctx(&raw))
            .unwrap_err()
            .code,
        "INDEX_BUILD_INCOMPLETE"
    );
}
#[test]
fn mixed_embedding_spaces_or_self_reported_active_are_rejected() {
    let mut raw = raw_context();
    let value = index(&raw, "index_new");
    receipt(&mut raw, &value);
    let kernel = KnowledgeKernel::new().unwrap();
    let mut modified = value.clone();
    modified["vector_space"]["dimensions"] = json!(4);
    assert_eq!(
        kernel
            .validate(&modified, "IndexManifest", &ctx(&raw))
            .unwrap_err()
            .code,
        "INDEX_BUILD_RECEIPT_MISMATCH"
    );
    modified = value;
    modified["status"] = json!("ACTIVE");
    assert_eq!(
        kernel
            .validate(&modified, "IndexManifest", &ctx(&raw))
            .unwrap_err()
            .code,
        "INDEX_ACTIVE_REF_UNRESOLVED"
    );
}
#[test]
fn activation_returns_cas_plan_and_allows_rebuilt_new_vector_space() {
    let mut raw = raw_context();
    let mut previous = index(&raw, "index_old");
    previous["status"] = json!("ACTIVE");
    receipt(&mut raw, &previous);
    raw["authority"]["active_indexes"] = json!([previous]);
    let mut next = index(&raw, "index_new");
    next["vector_space"]["model"] = json!("new-model");
    next["vector_space"]["dimensions"] = json!(4);
    receipt(&mut raw, &next);
    let kernel = KnowledgeKernel::new().unwrap();
    let context = ctx(&raw);
    let plan = kernel
        .index_transition(&previous, &next, &json!("index_old"), &context)
        .unwrap();
    assert_eq!(plan["activate"]["status"], "ACTIVE");
    assert_eq!(plan["supersede"]["status"], "SUPERSEDED");
    assert_eq!(plan["requires_host_atomic_compare_and_swap"], true);
    assert_eq!(
        kernel
            .index_transition(&previous, &next, &json!("other"), &context)
            .unwrap_err()
            .code,
        "INDEX_CAS_MISMATCH"
    );
}
#[test]
fn same_index_identity_cannot_be_reused_for_new_generation() {
    let mut raw = raw_context();
    let mut previous = index(&raw, "index_old");
    receipt(&mut raw, &previous);
    previous["status"] = json!("ACTIVE");
    raw["authority"]["active_indexes"] = json!([previous]);
    let mut next = previous.clone();
    next["status"] = json!("READY");
    assert_eq!(
        KnowledgeKernel::new()
            .unwrap()
            .index_transition(&previous, &next, &json!("index_old"), &ctx(&raw))
            .unwrap_err()
            .code,
        "INDEX_ID_REUSE_FORBIDDEN"
    );
}
#[test]
fn first_activation_refuses_hidden_existing_index() {
    let mut raw = raw_context();
    let next = index(&raw, "index_new");
    receipt(&mut raw, &next);
    let mut old = index(&raw, "index_old");
    old["status"] = json!("ACTIVE");
    raw["authority"]["active_indexes"] = json!([old]);
    assert_eq!(
        KnowledgeKernel::new()
            .unwrap()
            .index_transition(&Value::Null, &next, &Value::Null, &ctx(&raw))
            .unwrap_err()
            .code,
        "INDEX_CAS_MISMATCH"
    );
}

#[test]
fn valid_indexes_from_different_spaces_cannot_share_one_query_vector() {
    let mut raw = raw_context();
    let mut relation = index(&raw, "relation_index");
    relation["status"] = json!("ACTIVE");
    receipt(&mut raw, &relation);
    let mut entity = index(&raw, "entity_index");
    entity["component"] = json!("ENTITY");
    entity["vector_space"]["model"] = json!("different-model");
    entity["status"] = json!("ACTIVE");
    receipt(&mut raw, &entity);
    raw["authority"]["active_indexes"] = json!([relation, entity]);
    let kernel = KnowledgeKernel::new().unwrap();
    let context = ctx(&raw);
    kernel
        .validate(&relation, "IndexManifest", &context)
        .unwrap();
    kernel.validate(&entity, "IndexManifest", &context).unwrap();
    assert_eq!(
        kernel
            .validate_index_set(
                &[relation.clone(), entity],
                &relation["vector_space"],
                &context
            )
            .unwrap_err()
            .code,
        "INDEX_VECTOR_SPACE_MISMATCH"
    );
    kernel
        .validate_index_set(&[relation.clone()], &relation["vector_space"], &context)
        .unwrap();
}

#[test]
fn duplicate_active_generations_block_cas_plan() {
    let mut raw = raw_context();
    let mut previous = index(&raw, "index_old");
    previous["status"] = json!("ACTIVE");
    let mut other = previous.clone();
    other["index_id"] = json!("other");
    raw["authority"]["active_indexes"] = json!([previous, other]);
    let next = index(&raw, "index_next");
    receipt(&mut raw, &next);
    assert_eq!(
        KnowledgeKernel::new()
            .unwrap()
            .index_transition(&previous, &next, &json!("index_old"), &ctx(&raw))
            .unwrap_err()
            .code,
        "INDEX_ACTIVE_REGISTRY_CONFLICT"
    );
}

#[test]
fn rpc_does_not_treat_missing_previous_as_explicit_null() {
    let raw = raw_context();
    assert_eq!(
        execute(
            "index_transition",
            &json!({"next":index(&raw,"index_new"),"trusted_context":raw})
        )
        .unwrap_err()
        .code,
        "RPC_INVALID_REQUEST"
    );
}

#[test]
fn production_source_context_reuses_original_hash_and_exact_block_validation() {
    let mut raw = raw_context();
    for source in raw["source_texts"].as_array_mut().unwrap() {
        let text = source["text"].as_str().unwrap().to_owned();
        let original = source["original_utf8_text"].as_str().unwrap().to_owned();
        let block = source["block_ref"].clone();
        source.as_object_mut().unwrap().remove("original_utf8_text");
        source.as_object_mut().unwrap().remove("block_ref");
        source["original_sha256"] = json!(wire::text_sha(&original));
        source["parser_version"] = json!("synthetic-text/1");
        source["blocks"] = json!([{"block_ref":block,"start":0,"end":text.encode_utf16().count()}]);
    }
    let value = candidate(&raw);
    execute(
        "validate",
        &json!({"definition":"ExtractionCandidate","value":value,"trusted_context":raw}),
    )
    .unwrap();
}
