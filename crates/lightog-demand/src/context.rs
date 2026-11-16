//! Explicit validation inputs. The caller owns authorization and source lifecycle.
use crate::{need, wire, Error, Kernel, Result};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub(crate) fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub(crate) fn strings(v: &Value) -> BTreeSet<String> {
    array(v)
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
pub(crate) fn unique(rows: &[Value], key: &str) -> Result<()> {
    let mut seen = BTreeSet::new();
    for r in rows {
        let id = r
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| Error::new("CONTEXT_INVALID"))?;
        need(seen.insert(id), "DUPLICATE_LOCAL_ID")?;
    }
    Ok(())
}
pub(crate) fn named(v: &Value, key: &str) -> Result<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| Error::new("CONTEXT_INVALID"))
}
fn insert(map: &mut BTreeMap<String, Value>, key: String, v: &Value) -> Result<()> {
    if let Some(old) = map.get(&key) {
        need(old == v, "CONTEXT_DUPLICATE_ID")?;
    } else {
        map.insert(key, v.clone());
    }
    Ok(())
}
fn definition(v: &Value) -> Option<&'static str> {
    if v.get("wire_version").is_some() {
        Some("DemandEnvelope")
    } else if v.get("text").is_some() && v.get("question_id").is_some() {
        Some("QuestionSpec")
    } else if v.get("family_id").is_some() {
        Some("CQFamily")
    } else if v.get("evidence_set_id").is_some() {
        Some("EvidenceSet")
    } else if v.get("coverage_report_id").is_some() {
        Some("CoverageReport")
    } else if v.get("admission_evidence_ids").is_some() {
        Some("LearningIntent")
    } else if v.get("answer_status").is_some() {
        Some("AnswerResult")
    } else {
        None
    }
}

#[derive(Debug, Clone)]
pub struct ValidationContext {
    pub(crate) examples: BTreeMap<String, Value>,
    pub(crate) specs: BTreeMap<String, Value>,
    pub(crate) families: BTreeMap<String, Value>,
    pub(crate) fragments: BTreeMap<String, Value>,
    pub(crate) evidence_sets: BTreeMap<String, Value>,
    pub(crate) sources: BTreeMap<(String, String), Value>,
    pub(crate) authority: Value,
}
impl ValidationContext {
    /// Read-only registries; construction validates shapes before indexed access.
    pub fn examples(&self) -> &BTreeMap<String, Value> {
        &self.examples
    }
    pub fn specs(&self) -> &BTreeMap<String, Value> {
        &self.specs
    }
    pub fn authority(&self) -> &Value {
        &self.authority
    }

    pub fn from_value(raw: &Value, kernel: &Kernel) -> Result<Self> {
        Self::from_value_impl(raw, kernel, false)
    }
    /// Additive P1 context: original file hashes and the block catalogue must be
    /// read/verified by the trusted host. We verify parsed text and span bounds;
    /// we do not claim to hash binary PDF bytes which are not supplied here.
    pub fn from_value_v2(raw: &Value, kernel: &Kernel) -> Result<Self> {
        Self::from_value_impl(raw, kernel, true)
    }
    fn from_value_impl(raw: &Value, kernel: &Kernel, allow_v2: bool) -> Result<Self> {
        let object = raw
            .as_object()
            .ok_or_else(|| Error::new("CONTEXT_INVALID"))?;
        need(
            object.len() == 3
                && object.contains_key("examples")
                && object.contains_key("source_texts")
                && object.contains_key("authority"),
            "CONTEXT_INVALID",
        )?;
        let examples = raw["examples"]
            .as_object()
            .ok_or_else(|| Error::new("CONTEXT_INVALID"))?;
        let source_rows = raw["source_texts"]
            .as_array()
            .ok_or_else(|| Error::new("CONTEXT_INVALID"))?;
        need(
            examples.len() <= 10_000 && source_rows.len() <= 10_000,
            "WIRE_RESOURCE_LIMIT",
        )?;
        let mut ctx = Self {
            examples: BTreeMap::new(),
            specs: BTreeMap::new(),
            families: BTreeMap::new(),
            fragments: BTreeMap::new(),
            evidence_sets: BTreeMap::new(),
            sources: BTreeMap::new(),
            authority: raw["authority"].clone(),
        };
        for (name, v) in examples {
            let kind = definition(v).ok_or_else(|| Error::new("CONTEXT_INVALID"))?;
            kernel
                .schema_check(v, kind)
                .map_err(|_| Error::new("CONTEXT_INVALID"))?;
            ctx.examples.insert(name.clone(), v.clone());
            match kind {
                "QuestionSpec" => insert(&mut ctx.specs, named(v, "question_id")?, v)?,
                "CQFamily" => insert(&mut ctx.families, named(v, "family_id")?, v)?,
                "EvidenceSet" => {
                    insert(&mut ctx.evidence_sets, named(v, "evidence_set_id")?, v)?;
                    for f in array(&v["fragments"]) {
                        insert(&mut ctx.fragments, named(f, "id")?, f)?;
                    }
                }
                _ => {}
            }
        }
        for s in source_rows {
            let fields = [
                "source_ref",
                "source_revision",
                "block_ref",
                "text",
                "original_utf8_text",
            ];
            let legacy = s.as_object().is_some_and(|m| m.len() == fields.len())
                && fields.iter().all(|k| s.get(k).is_some_and(Value::is_string));
            if !legacy {
                let keys = ["source_ref","source_revision","text","original_sha256","parser_version","blocks"];
                need(allow_v2 && s.as_object().is_some_and(|m| m.len()==keys.len())
                    && keys.iter().all(|k|s.get(k).is_some())
                    && keys[..5].iter().all(|k|s[*k].as_str().is_some_and(|v|!v.is_empty()))
                    && s["original_sha256"].as_str().is_some_and(|v|v.len()==64&&v.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)))
                    && s["blocks"].as_array().is_some_and(|a|!a.is_empty()&&a.len()<=10000), "CONTEXT_INVALID")?;
                unique(array(&s["blocks"]),"block_ref")?;
                for block in array(&s["blocks"]) {
                    need(block.as_object().is_some_and(|m|m.len()==3)
                        && block["block_ref"].as_str().is_some_and(|v|!v.is_empty())
                        && block.get("start").is_some()&&block.get("end").is_some(), "CONTEXT_INVALID")?;
                    wire::span_text(s["text"].as_str().unwrap(),block)?;
                }
            }
            let key = (named(s, "source_ref")?, named(s, "source_revision")?);
            need(
                ctx.sources.insert(key, s.clone()).is_none(),
                "CONTEXT_DUPLICATE_ID",
            )?;
        }
        let fields = [
            "requests",
            "allowed_snapshots",
            "claims",
            "receipts",
            "scope_bindings",
            "entities",
            "predicate_refs",
            "user_definitions",
            "groups",
        ];
        need(
            ctx.authority.is_object()
                && fields
                    .iter()
                    .all(|k| ctx.authority.get(k).is_some_and(Value::is_array)),
            "CONTEXT_INVALID",
        )?;
        for (field, key) in [
            ("requests", "request_id"),
            ("receipts", "receipt_ref"),
            ("groups", "group_ref"),
        ] {
            unique(array(&ctx.authority[field]), key)
                .map_err(|_| Error::new("CONTEXT_DUPLICATE_ID"))?;
        }
        let mut claims = BTreeSet::new();
        for claim in array(&ctx.authority["claims"]) {
            need(
                claims.insert((named(claim, "graph_revision")?, named(claim, "claim_ref")?)),
                "CONTEXT_DUPLICATE_ID",
            )?;
        }
        for r in array(&ctx.authority["requests"]) {
            kernel
                .schema_check(&r["context"], "AccessContext")
                .map_err(|_| Error::new("CONTEXT_INVALID"))?;
            need(r["question_spec_sha256"].is_string(), "CONTEXT_INVALID")?;
        }
        for s in array(&ctx.authority["allowed_snapshots"]) {
            kernel
                .schema_check(s, "SourceSnapshot")
                .map_err(|_| Error::new("CONTEXT_INVALID"))?;
        }
        Ok(ctx)
    }
    pub fn evidence_ids(&self) -> BTreeSet<String> {
        self.fragments.keys().cloned().collect()
    }
    pub fn subject_refs(&self, m: &Value) -> Result<()> {
        need(
            strings(&m["source_evidence_ids"]).is_subset(&self.evidence_ids()),
            "UNKNOWN_EVIDENCE_REF",
        )?;
        if !m["entity_ref"].is_null() {
            need(
                array(&self.authority["entities"]).contains(&m["entity_ref"]),
                "ENTITY_REF_UNRESOLVED",
            )?;
        }
        for mention in array(&m["source_mentions"]) {
            need(
                array(&m["source_evidence_ids"]).contains(&mention["evidence_ref"]),
                "UNKNOWN_EVIDENCE_REF",
            )?;
            let f = self
                .fragments
                .get(mention["evidence_ref"].as_str().unwrap())
                .ok_or_else(|| Error::new("UNKNOWN_EVIDENCE_REF"))?;
            let source = self
                .sources
                .get(&(named(f, "source_ref")?, named(f, "source_revision")?))
                .ok_or_else(|| Error::new("SOURCE_REVISION_MISMATCH"))?;
            wire::span_text(source["text"].as_str().unwrap(), &mention["span"])?;
            let number = |v: &Value| v.as_u64().unwrap_or(u64::MAX);
            need(
                number(&f["span"]["start"]) <= number(&mention["span"]["start"])
                    && number(&mention["span"]["start"]) < number(&mention["span"]["end"])
                    && number(&mention["span"]["end"]) <= number(&f["span"]["end"]),
                "SOURCE_MENTION_OUTSIDE_EVIDENCE",
            )?;
        }
        if array(&m["question_spans"]).is_empty() {
            need(
                !array(&m["source_mentions"]).is_empty(),
                "SUBJECT_WITHOUT_ANCHOR",
            )?;
        }
        Ok(())
    }
    pub fn snapshot_check(&self, snapshot: &Value) -> Result<()> {
        for s in array(&snapshot["sources"]) {
            let source = self
                .sources
                .get(&(named(s, "source_ref")?, named(s, "source_revision")?))
                .ok_or_else(|| Error::new("SOURCE_REVISION_MISMATCH"))?;
            need(
                s["text_sha256"].as_str()
                    == Some(wire::text_sha(source["text"].as_str().unwrap()).as_str()),
                "EVIDENCE_HASH_MISMATCH",
            )?;
            if let Some(original) = source["original_utf8_text"].as_str() {
                need(s["original_sha256"].as_str()==Some(wire::text_sha(original).as_str()),"ORIGINAL_HASH_MISMATCH")?;
            } else {
                need(s["original_sha256"]==source["original_sha256"],"ORIGINAL_HASH_MISMATCH")?;
                need(s["parser_version"]==source["parser_version"],"PARSER_VERSION_MISMATCH")?;
            }
        }
        need(
            array(&self.authority["allowed_snapshots"]).contains(snapshot),
            "SOURCE_SNAPSHOT_MISMATCH",
        )
    }
    pub fn block_check(&self, source_ref: &str, revision: &str, block_ref: &Value, span: &Value) -> Result<()> {
        let row=self.sources.get(&(source_ref.to_owned(),revision.to_owned())).ok_or_else(||Error::new("SOURCE_REVISION_MISMATCH"))?;
        if row.get("original_utf8_text").is_some() {
            return need(row["block_ref"]==*block_ref,"UNKNOWN_BLOCK_REF");
        }
        wire::span_text(row["text"].as_str().unwrap(),span)?;
        need(array(&row["blocks"]).iter().any(|b|b["block_ref"]==*block_ref
            && b["start"].as_u64()<=span["start"].as_u64()
            && b["end"].as_u64()>=span["end"].as_u64()),"UNKNOWN_BLOCK_REF")
    }
    pub fn block_for_span(&self, source_ref: &str, revision: &str, span: &Value) -> Result<String> {
        let row=self.sources.get(&(source_ref.to_owned(),revision.to_owned())).ok_or_else(||Error::new("SOURCE_REVISION_MISMATCH"))?;
        wire::span_text(row["text"].as_str().unwrap(),span)?;
        if let Some(id)=row["block_ref"].as_str() {return Ok(id.to_owned());}
        let start=span["start"].as_u64().ok_or_else(||Error::new("SPAN_RANGE_INVALID"))?;
        let end=span["end"].as_u64().ok_or_else(||Error::new("SPAN_RANGE_INVALID"))?;
        let mut blocks:Vec<_>=array(&row["blocks"]).iter().filter(|b|b["start"].as_u64().unwrap()<=start&&b["end"].as_u64().unwrap()>=end).collect();
        blocks.sort_by_key(|b|b["end"].as_u64().unwrap()-b["start"].as_u64().unwrap());
        let first=blocks.first().ok_or_else(||Error::new("UNKNOWN_BLOCK_REF"))?;
        need(blocks.len()==1 || first["end"].as_u64().unwrap()-first["start"].as_u64().unwrap()
            < blocks[1]["end"].as_u64().unwrap()-blocks[1]["start"].as_u64().unwrap(),"BLOCK_REF_AMBIGUOUS")?;
        named(first,"block_ref")
    }
    pub fn basis_for(&self, ids: &Value) -> Result<&'static str> {
        let mut origins = BTreeSet::new();
        for id in array(ids) {
            let f = self
                .fragments
                .get(
                    id.as_str()
                        .ok_or_else(|| Error::new("UNKNOWN_EVIDENCE_REF"))?,
                )
                .ok_or_else(|| Error::new("UNKNOWN_EVIDENCE_REF"))?;
            origins.insert(named(f, "origin")?);
        }
        Ok(if origins.len() > 1 {
            "MIXED"
        } else if origins.contains("SOURCE_FRAGMENT") {
            "DOCUMENT"
        } else if !origins.is_empty() {
            "GRAPH"
        } else {
            "NONE"
        })
    }
    pub fn trusted_request(&self, request_ref: &Value, spec_hash: &Value) -> Result<&Value> {
        let r = array(&self.authority["requests"])
            .iter()
            .find(|r| r["request_id"] == *request_ref && r["question_spec_sha256"] == *spec_hash)
            .ok_or_else(|| Error::new("REQUEST_CONTEXT_UNRESOLVED"))?;
        Ok(&r["context"])
    }
    pub fn request_snapshot_check(&self, request_ref: &Value, spec_hash: &Value, snapshot: &Value) -> Result<()> {
        let access=self.trusted_request(request_ref,spec_hash)?;
        need(access["base_ref"]==snapshot["base_ref"]&&access["source_epoch"]==snapshot["source_epoch"],"REQUEST_SNAPSHOT_MISMATCH")
    }
    pub fn receipt_check(
        &self,
        receipt_ref: &Value,
        kind: &str,
        report: &Value,
        rid: &Value,
        cid: Option<&Value>,
    ) -> Result<()> {
        let digest = wire::sha(&report["snapshot"])?;
        need(
            array(&self.authority["receipts"]).iter().any(|r| {
                r["receipt_ref"] == *receipt_ref
                    && r["kind"] == kind
                    && r["question_spec_sha256"] == report["question_spec_sha256"]
                    && r["snapshot_sha256"] == digest
                    && r["requirement_id"] == *rid
                    && cid.is_none_or(|id| r["condition_id"] == *id)
            }),
            "RECEIPT_REF_UNRESOLVED",
        )
    }
}
