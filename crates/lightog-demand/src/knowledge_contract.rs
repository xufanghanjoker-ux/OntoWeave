//! P1 extraction/index proposals. Pure validation, no extraction, vector I/O or publication.
use crate::{
    context::{array, strings, unique},
    need, wire, Error, Kernel, Result, ValidationContext,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub struct KnowledgeKernel {
    kernel: Kernel,
    validators: BTreeMap<String, jsonschema::Validator>,
}

fn local_refs(value: &mut Value) {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(reference)) = map.get_mut("$ref") {
                if let Some(name) = reference.strip_prefix("urn:lightog-demand:0.1#/$defs/") {
                    *reference = format!("#/$defs/{name}");
                }
            }
            for nested in map.values_mut() {
                local_refs(nested);
            }
        }
        Value::Array(rows) => {
            for row in rows {
                local_refs(row);
            }
        }
        _ => {}
    }
}

impl KnowledgeKernel {
    pub fn new() -> Result<Self> {
        let old: Value =
            serde_json::from_str(include_str!("../../../contracts/demand-v0.1/schema.json"))
                .map_err(|_| Error::new("KERNEL_SCHEMA_INVALID"))?;
        let new: Value = serde_json::from_str(include_str!(
            "../../../contracts/demand-v0.2/knowledge.schema.json"
        ))
        .map_err(|_| Error::new("KERNEL_SCHEMA_INVALID"))?;
        let mut defs = old["$defs"]
            .as_object()
            .ok_or_else(|| Error::new("KERNEL_SCHEMA_INVALID"))?
            .clone();
        for (name, value) in new["$defs"]
            .as_object()
            .ok_or_else(|| Error::new("KERNEL_SCHEMA_INVALID"))?
        {
            need(
                defs.insert(name.clone(), value.clone()).is_none(),
                "KERNEL_SCHEMA_COLLISION",
            )?;
        }
        let mut definitions = Value::Object(defs);
        local_refs(&mut definitions);
        let mut validators = BTreeMap::new();
        for name in new["$defs"].as_object().unwrap().keys() {
            let wrapper = json!({"$schema":"https://json-schema.org/draft/2020-12/schema","$defs":definitions,"$ref":format!("#/$defs/{name}")});
            let validator = jsonschema::draft202012::options()
                .should_validate_formats(true)
                .build(&wrapper)
                .map_err(|_| Error::new("KERNEL_SCHEMA_INVALID"))?;
            validators.insert(name.clone(), validator);
        }
        Ok(Self {
            kernel: Kernel::new()?,
            validators,
        })
    }

    pub fn schema_check(&self, value: &Value, definition: &str) -> Result<()> {
        let validator = self
            .validators
            .get(definition)
            .ok_or_else(|| Error::new("SCHEMA_DEFINITION_UNKNOWN"))?;
        need(validator.is_valid(value), "SCHEMA_INVALID")?;
        // Enforce the existing wire integer and decimal rules on nested values too.
        wire::canonical(value)?;
        Ok(())
    }

    fn evidence<'a>(&self, value: &Value, ctx: &'a ValidationContext) -> Result<&'a Value> {
        ctx.snapshot_check(&value["snapshot"])?;
        let evidence = ctx
            .evidence_sets
            .get(value["evidence_set_ref"].as_str().unwrap())
            .ok_or_else(|| Error::new("UNKNOWN_EVIDENCE_SET_REF"))?;
        self.kernel.validate(evidence, "EvidenceSet", ctx)?;
        need(
            value["snapshot"] == evidence["snapshot"],
            "SOURCE_SNAPSHOT_MISMATCH",
        )?;
        let available = array(&evidence["fragments"])
            .iter()
            .map(|f| f["id"].as_str().unwrap().to_owned())
            .collect();
        need(
            strings(&value["evidence_ids"]).is_subset(&available),
            "UNKNOWN_EVIDENCE_REF",
        )?;
        Ok(evidence)
    }

    pub fn validate(&self, value: &Value, definition: &str, ctx: &ValidationContext) -> Result<()> {
        self.schema_check(value, definition)?;
        match definition {
            "ExtractionCandidate" => self.candidate(value, ctx),
            "RetrievalProfile" => self.profile(value, ctx),
            "IndexManifest" => self.index(value, ctx),
            _ => Err(Error::new("KNOWLEDGE_ROOT_DEFINITION_REQUIRED")),
        }
    }

    fn candidate(&self, value: &Value, ctx: &ValidationContext) -> Result<()> {
        self.evidence(value, ctx)?;
        let evidence_ids = strings(&value["evidence_ids"]);
        let entities = array(&value["entities"]);
        unique(entities, "local_id")?;
        let local: BTreeSet<ValueKey> = entities
            .iter()
            .map(|e| ValueKey(e["local_id"].as_str().unwrap().to_owned()))
            .collect();
        let has = |v: &Value| {
            v.as_str()
                .is_some_and(|x| local.contains(&ValueKey(x.to_owned())))
        };
        need(
            has(&value["subject_local_id"]),
            "CANDIDATE_ENTITY_REF_UNRESOLVED",
        )?;
        for entity in entities {
            if !entity["entity_ref"].is_null() {
                need(
                    array(&ctx.authority["entities"]).contains(&entity["entity_ref"]),
                    "ENTITY_REF_UNRESOLVED",
                )?;
            }
            for mention in array(&entity["mentions"]) {
                need(
                    evidence_ids.contains(mention["evidence_ref"].as_str().unwrap()),
                    "UNKNOWN_EVIDENCE_REF",
                )?;
                let fragment = ctx
                    .fragments
                    .get(mention["evidence_ref"].as_str().unwrap())
                    .ok_or_else(|| Error::new("UNKNOWN_EVIDENCE_REF"))?;
                let source = ctx
                    .sources
                    .get(&(
                        fragment["source_ref"].as_str().unwrap().into(),
                        fragment["source_revision"].as_str().unwrap().into(),
                    ))
                    .ok_or_else(|| Error::new("SOURCE_REVISION_MISMATCH"))?;
                wire::span_text(source["text"].as_str().unwrap(), &mention["span"])?;
                need(
                    mention["span"]["start"].as_u64().unwrap()
                        >= fragment["span"]["start"].as_u64().unwrap()
                        && mention["span"]["end"].as_u64().unwrap()
                            <= fragment["span"]["end"].as_u64().unwrap(),
                    "SOURCE_MENTION_OUTSIDE_EVIDENCE",
                )?;
            }
        }
        unique(array(&value["conditions"]), "id")?;
        for condition in array(&value["conditions"]) {
            need(
                strings(&condition["evidence_ids"]).is_subset(&evidence_ids),
                "UNKNOWN_EVIDENCE_REF",
            )?;
        }
        if value["kind"] == "ENTITY" {
            need(
                value["predicate"].is_null()
                    && value["object"].is_null()
                    && value["direction"] == "NONE",
                "CANDIDATE_KIND_MISMATCH",
            )?;
        } else {
            need(
                value["predicate"].is_object() && value["object"].is_object(),
                "CANDIDATE_KIND_MISMATCH",
            )?;
            let predicate = &value["predicate"];
            need(
                predicate["predicate_ref"].is_null() != predicate["proposed_definition"].is_null(),
                "PREDICATE_PROPOSAL_INVALID",
            )?;
            if predicate["predicate_ref"].is_null() {
                need(
                    strings(&predicate["proposed_definition"]["evidence_ids"])
                        .is_subset(&evidence_ids),
                    "UNKNOWN_EVIDENCE_REF",
                )?;
            } else {
                need(
                    array(&ctx.authority["predicate_refs"]).contains(&predicate["predicate_ref"]),
                    "PREDICATE_REF_UNRESOLVED",
                )?;
            }
            if value["kind"] == "RELATION" {
                need(
                    value["direction"] != "NONE"
                        && has(&value["object"]["entity_local_id"])
                        && value["object"]["typed_value"].is_null()
                        && value["subject_local_id"] != value["object"]["entity_local_id"],
                    "CANDIDATE_RELATION_INVALID",
                )?;
            } else {
                need(
                    value["direction"] == "NONE"
                        && value["object"]["entity_local_id"].is_null()
                        && value["object"]["typed_value"].is_object(),
                    "CANDIDATE_ATTRIBUTE_INVALID",
                )?;
                self.kernel
                    .schema_check(&value["object"]["typed_value"], "TypedValue")?;
            }
        }
        Ok(())
    }

    fn profile(&self, value: &Value, ctx: &ValidationContext) -> Result<()> {
        let evidence = self.evidence(value, ctx)?;
        if !value["subject_ref"].is_null() {
            need(
                array(&ctx.authority["entities"]).contains(&value["subject_ref"]),
                "ENTITY_REF_UNRESOLVED",
            )?;
        }
        let selected = strings(&value["evidence_ids"]);
        let claims: BTreeSet<String> = array(&evidence["fragments"])
            .iter()
            .filter(|f| selected.contains(f["id"].as_str().unwrap()))
            .flat_map(|f| strings(&f["claim_refs"]))
            .collect();
        need(
            strings(&value["claim_refs"]) == claims,
            "PROFILE_CLAIM_DEPENDENCY_MISMATCH",
        )?;
        Ok(())
    }

    fn index(&self, value: &Value, ctx: &ValidationContext) -> Result<()> {
        ctx.snapshot_check(&value["snapshot"])?;
        need(
            value["vectors_completed"].as_u64().unwrap()
                <= value["records_total"].as_u64().unwrap(),
            "INDEX_BUILD_COUNT_INVALID",
        )?;
        if value["status"] == "BUILDING" {
            need(
                value["build_receipt_ref"].is_null(),
                "INDEX_BUILD_RECEIPT_INVALID",
            )?;
        } else {
            need(
                value["records_total"] == value["vectors_completed"],
                "INDEX_BUILD_INCOMPLETE",
            )?;
            let receipt = array(&ctx.authority["receipts"])
                .iter()
                .find(|r| {
                    r["receipt_ref"] == value["build_receipt_ref"]
                        && !value["build_receipt_ref"].is_null()
                })
                .ok_or_else(|| Error::new("INDEX_BUILD_RECEIPT_UNRESOLVED"))?;
            need(
                receipt["kind"] == "INDEX_BUILD"
                    && receipt["status"] == "COMPLETE"
                    && receipt["index_id"] == value["index_id"]
                    && receipt["index_revision"] == value["index_revision"]
                    && receipt["snapshot_sha256"] == wire::sha(&value["snapshot"])?
                    && receipt["vector_space_sha256"] == wire::sha(&value["vector_space"])?
                    && receipt["component"] == value["component"]
                    && receipt["records_total"] == value["records_total"]
                    && receipt["vectors_completed"] == value["vectors_completed"],
                "INDEX_BUILD_RECEIPT_MISMATCH",
            )?;
        }
        if value["status"] == "ACTIVE" {
            need(
                array(&ctx.authority["active_indexes"]).contains(value),
                "INDEX_ACTIVE_REF_UNRESOLVED",
            )?;
        }
        Ok(())
    }

    /// Returns a write plan, not an atomic database operation. Host must CAS the expected active ID.
    pub fn index_transition(
        &self,
        previous: &Value,
        next: &Value,
        expected_previous: &Value,
        ctx: &ValidationContext,
    ) -> Result<Value> {
        self.validate(next, "IndexManifest", ctx)?;
        need(next["status"] == "READY", "INDEX_NOT_READY")?;
        let current: Vec<&Value> = array(&ctx.authority["active_indexes"])
            .iter()
            .filter(|i| {
                i["snapshot"]["base_ref"] == next["snapshot"]["base_ref"]
                    && i["component"] == next["component"]
            })
            .collect();
        if previous.is_null() {
            need(expected_previous.is_null(), "INDEX_CAS_MISMATCH")?;
            need(current.is_empty(), "INDEX_CAS_MISMATCH")?;
        } else {
            self.schema_check(previous, "IndexManifest")?;
            need(
                previous["status"] == "ACTIVE"
                    && array(&ctx.authority["active_indexes"]).contains(previous),
                "INDEX_ACTIVE_REF_UNRESOLVED",
            )?;
            need(
                current.len() == 1 && current[0] == previous,
                "INDEX_ACTIVE_REGISTRY_CONFLICT",
            )?;
            need(
                previous["index_id"] == *expected_previous,
                "INDEX_CAS_MISMATCH",
            )?;
            need(
                previous["snapshot"]["base_ref"] == next["snapshot"]["base_ref"]
                    && previous["component"] == next["component"],
                "INDEX_SCOPE_MISMATCH",
            )?;
            need(
                previous["index_id"] != next["index_id"],
                "INDEX_ID_REUSE_FORBIDDEN",
            )?;
        }
        let mut active = next.clone();
        active["status"] = json!("ACTIVE");
        let mut superseded = previous.clone();
        if superseded.is_object() {
            superseded["status"] = json!("SUPERSEDED");
        }
        Ok(
            json!({"expected_previous_index_id":expected_previous,"activate":active,"supersede":superseded,"requires_host_atomic_compare_and_swap":true}),
        )
    }

    /// Compatibility for a retrieval request. Separate rank lists may be fused, but raw vectors
    /// from different spaces cannot be queried with one embedding or directly compared.
    pub fn validate_index_set(
        &self,
        manifests: &[Value],
        expected_space: &Value,
        ctx: &ValidationContext,
    ) -> Result<()> {
        need(
            !manifests.is_empty() && manifests.len() <= 4,
            "INDEX_SET_INVALID",
        )?;
        self.schema_check(expected_space, "VectorSpace")?;
        let mut components = BTreeSet::new();
        for manifest in manifests {
            self.validate(manifest, "IndexManifest", ctx)?;
            need(manifest["status"] == "ACTIVE", "INDEX_NOT_ACTIVE")?;
            need(
                manifest["vector_space"] == *expected_space,
                "INDEX_VECTOR_SPACE_MISMATCH",
            )?;
            need(
                manifest["snapshot"] == manifests[0]["snapshot"],
                "INDEX_SNAPSHOT_MISMATCH",
            )?;
            need(
                components.insert(manifest["component"].as_str().unwrap()),
                "INDEX_COMPONENT_DUPLICATE",
            )?;
        }
        Ok(())
    }
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct ValueKey(String);

/// Trusted context is an explicit host input, never fields inside the proposal being validated.
pub fn execute(operation: &str, payload: &Value) -> Result<Value> {
    let fields: &[&str] = match operation {
        "validate" => &["definition", "value", "trusted_context"],
        "index_transition" => &[
            "previous",
            "next",
            "expected_previous_index_id",
            "trusted_context",
        ],
        "validate_index_set" => &["manifests", "expected_vector_space", "trusted_context"],
        _ => return Err(Error::new("RPC_OPERATION_UNKNOWN")),
    };
    need(
        payload.as_object().is_some_and(|map| {
            map.len() == fields.len() && fields.iter().all(|key| map.contains_key(*key))
        }),
        "RPC_INVALID_REQUEST",
    )?;
    let kernel = KnowledgeKernel::new()?;
    let ctx = ValidationContext::from_value_v2(&payload["trusted_context"], &kernel.kernel)?;
    match operation {
        "validate" => {
            let definition = payload["definition"]
                .as_str()
                .ok_or_else(|| Error::new("RPC_INVALID_REQUEST"))?;
            kernel.validate(&payload["value"], definition, &ctx)?;
            Ok(
                json!({"definition":definition,"contract_version":"lightog-knowledge/0.2","validated":true,"semantic_support_certified":false,"publication_performed":false}),
            )
        }
        "index_transition" => kernel.index_transition(
            &payload["previous"],
            &payload["next"],
            &payload["expected_previous_index_id"],
            &ctx,
        ),
        "validate_index_set" => {
            let manifests = payload["manifests"]
                .as_array()
                .ok_or_else(|| Error::new("RPC_INVALID_REQUEST"))?;
            kernel.validate_index_set(manifests, &payload["expected_vector_space"], &ctx)?;
            Ok(
                json!({"compatible":true,"manifest_count":manifests.len(),"semantic_support_certified":false}),
            )
        }
        _ => Err(Error::new("RPC_OPERATION_UNKNOWN")),
    }
}
