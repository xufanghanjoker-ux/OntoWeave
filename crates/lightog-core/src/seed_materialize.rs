//! Registry/symbol projection and exact source-mention materialization. No model,
//! semantic repair, identity guessing, storage or publication. One Rust validator
//! per complete fact; invalid references quarantine only their dependent facts.
use crate::common::{a, canonical_hash as hash, error, js_ws, len, s, sha, Result};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
pub const VERSION: &str = "lightog-seed-materialize/0.1";
pub const OCCURRENCE_VERSION: &str = "lightog-seed-materialize-occurrence/0.1";
pub const LOCAL_OCCURRENCE_VERSION: &str = "lightog-seed-materialize-local-occurrence/0.1";
pub const LOCAL_RESOLUTION_VERSION: &str = "lightog-local-mention-resolution/0.1";
pub const LOCAL_SELECTION_VERSION: &str = "lightog-mention-occurrence-local-selection/0.1";
pub const OCCURRENCE_SELECTION_VERSION: &str = "lightog-mention-occurrence-selection/0.1";
const ADAPTER: &str = "lightog-p2-registry-extraction/0.2";
const SYMBOL: &str = "lightog-p2-opaque-symbols/0.1";
fn need(ok: bool, code: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(error(code, code))
    }
}
fn shape(v: &Value, keys: &[&str], code: &str) -> Result<()> {
    need(
        v.as_object()
            .is_some_and(|m| m.len() == keys.len() && keys.iter().all(|k| m.contains_key(*k))),
        code,
    )
}
fn id(v: &Value, code: &str) -> Result<()> {
    let t = s(v);
    let mut chars = t.chars();
    need(
        !t.is_empty()
            && t.len() <= 128
            && chars.next().is_some_and(|c| c.is_ascii_alphabetic())
            && chars.all(|c| c.is_ascii_alphanumeric() || "_.:-".contains(c)),
        code,
    )
}
fn opaque(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|t| !t.is_empty() && t.chars().count() <= 160)
}
fn generated(prefix: &str, index: usize) -> String {
    format!("{prefix}_{:03}", index + 1)
}
fn unique(values: impl IntoIterator<Item = Value>) -> Vec<Value> {
    let mut seen = BTreeSet::new();
    values
        .into_iter()
        .filter(|v| seen.insert(hash(v)))
        .collect()
}
fn reference(
    raw: &Value,
    slot: &str,
    keys: &BTreeMap<String, usize>,
    key_rows: &[Value],
    missing: &mut BTreeMap<String, usize>,
    missing_rows: &mut Vec<Value>,
    receipt: &mut Value,
) -> Value {
    let (value, status) = if !opaque(raw) {
        (raw.clone(), "INVALID_KEY")
    } else if let Some(i) = keys.get(s(raw)) {
        (key_rows[*i]["internal_id"].clone(), "REGISTRY_KEY")
    } else {
        let at = if let Some(i) = missing.get(s(raw)) {
            *i
        } else {
            let i = missing_rows.len();
            missing.insert(s(raw).to_owned(), i);
            missing_rows.push(json!({"opaque_key":raw,"internal_id":generated("missing",i)}));
            i
        };
        (missing_rows[at]["internal_id"].clone(), "UNKNOWN_KEY")
    };
    receipt["references"].as_array_mut().unwrap().push(json!({"slot":slot,"original_key":raw,"internal_id":if status=="INVALID_KEY"{Value::Null}else{value.clone()},"status":status}));
    value
}
fn project(raw: &Value) -> Result<(Value, Value)> {
    shape(raw, &["entities", "candidates"], "SYMBOL_ENVELOPE_INVALID")?;
    let mut keys = BTreeMap::new();
    let mut key_rows = vec![];
    for (i, e) in a(&raw["entities"]).iter().enumerate() {
        if opaque(&e["local_id"]) {
            let key = s(&e["local_id"]);
            let at = if let Some(i) = keys.get(key) {
                *i
            } else {
                let at = key_rows.len();
                keys.insert(key.to_owned(), at);
                key_rows.push(
                    json!({"opaque_key":key,"internal_id":generated("e",at),"registry_indices":[]}),
                );
                at
            };
            key_rows[at]["registry_indices"]
                .as_array_mut()
                .unwrap()
                .push(json!(i));
        }
    }
    let mut registry = vec![];
    let entities:Vec<_>=a(&raw["entities"]).iter().enumerate().map(|(i,e)|{
  let key=&e["local_id"];let mapping=keys.get(s(key)).filter(|_|opaque(key)).map(|i|&key_rows[*i]);
  registry.push(json!({"registry_index":i,"original_key_present":e.as_object().is_some_and(|o|o.contains_key("local_id")),"original_key":key,"original_entry_sha256":hash(e),"key_status":if mapping.is_some(){"MAPPED_EXACT_KEY"}else{"INVALID_KEY"},"internal_id":mapping.map(|m|m["internal_id"].clone()),"duplicate_key":mapping.is_some_and(|m|a(&m["registry_indices"]).len()>1)}));
  let mut out=e.clone();if let Some(m)=mapping{out["local_id"]=m["internal_id"].clone();}out
 }).collect();
    let mut missing = BTreeMap::new();
    let mut missing_rows = vec![];
    let mut facts = vec![];
    let mut candidates = vec![];
    for (i, f) in a(&raw["candidates"]).iter().enumerate() {
        let mut receipt = json!({"fact_index":i,"generated_fact_local_id":generated("f",i),"original_fact_sha256":hash(f),"original_fact_local_id_present":f.as_object().is_some_and(|o|o.contains_key("local_id")),"references":[],"conditions":[],"projection_errors":[]});
        let mut out = f.clone();
        if f.is_object() {
            out["local_id"] = json!(generated("f", i));
            if let Some(id) = f.get("local_id") {
                receipt["original_fact_local_id"] = id.clone();
                receipt["projection_errors"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!("MODEL_FACT_ID_FORBIDDEN"));
            }
            if let Some(v) = f.get("subject_local_id") {
                out["subject_local_id"] = reference(
                    v,
                    "subject_local_id",
                    &keys,
                    &key_rows,
                    &mut missing,
                    &mut missing_rows,
                    &mut receipt,
                );
            }
            if f["object"].is_object()
                && f["object"]
                    .get("entity_local_id")
                    .is_some_and(|v| !v.is_null())
            {
                out["object"]["entity_local_id"] = reference(
                    &f["object"]["entity_local_id"],
                    "object.entity_local_id",
                    &keys,
                    &key_rows,
                    &mut missing,
                    &mut missing_rows,
                    &mut receipt,
                );
            }
            if let Some(conditions) = f["conditions"].as_array() {
                let mut out_conditions = vec![];
                for (j, c) in conditions.iter().enumerate() {
                    let mut entry = json!({"condition_index":j,"generated_condition_id":generated("cond",j),"original_condition_sha256":hash(c),"original_id_present":c.as_object().is_some_and(|m|m.contains_key("id"))});
                    let mut projected = c.clone();
                    if c.is_object() {
                        if let Some(id) = c.get("id") {
                            entry["original_id"] = id.clone();
                            receipt["projection_errors"]
                                .as_array_mut()
                                .unwrap()
                                .push(json!("MODEL_CONDITION_ID_FORBIDDEN"));
                        }
                        projected["id"] = json!(generated("cond", j));
                    }
                    receipt["conditions"].as_array_mut().unwrap().push(entry);
                    out_conditions.push(projected);
                }
                out["conditions"] = json!(out_conditions);
            }
            if !a(&receipt["projection_errors"]).is_empty() {
                out["symbol_projection_errors"] = receipt["projection_errors"].clone();
            }
        }
        facts.push(receipt);
        candidates.push(out);
    }
    let projected = json!({"entities":entities,"candidates":candidates});
    let projection = json!({"version":SYMBOL,"raw_input_sha256":hash(raw),"original_registry_sha256":hash(&raw["entities"]),"projected_input_sha256":hash(&projected),"key_map":key_rows,"missing_key_map":missing_rows,"registry":registry,"facts":facts});
    Ok((projected, projection))
}
fn menu(prepared: &Value) -> Result<BTreeMap<String, Value>> {
    let mut map = BTreeMap::new();
    for f in a(&prepared["payload"]["evidence_menu"]) {
        id(&f["evidence_id"], "PREPARED_EVIDENCE_ID_INVALID")?;
        let span = &f["span"];
        need(
            span["offset_unit"] == "utf16_code_unit"
                && span["start"]
                    .as_u64()
                    .zip(span["end"].as_u64())
                    .is_some_and(|(a, b)| b > a && b - a == len(s(&span["quote"])) as u64)
                && span["quote"].is_string(),
            "PREPARED_EVIDENCE_SPAN_INVALID",
        )?;
        need(
            map.insert(s(&f["evidence_id"]).to_owned(), f.clone())
                .is_none(),
            "PREPARED_EVIDENCE_ID_DUPLICATE",
        )?;
    }
    Ok(map)
}
// Only whitespace is removable. Case, punctuation, brackets and every other
// scalar remain exact. The mapped span always points back to original bytes.
fn whitespace_ranges(quote:&str,surface:&str)->Vec<(usize,usize)>{
    let needle:Vec<char>=surface.chars().filter(|c|!js_ws(*c)).collect();
    let source:Vec<(usize,char)>=quote.char_indices().filter(|(_,c)|!js_ws(*c)).collect();
    if needle.is_empty()||needle.len()>source.len(){return vec![];}
    (0..=source.len()-needle.len()).filter_map(|i|{
        source[i..i+needle.len()].iter().map(|(_,c)|*c).eq(needle.iter().copied())
            .then(||(source[i].0,source[i+needle.len()-1].0+source[i+needle.len()-1].1.len_utf8()))
    }).collect()
}
fn local_choices(e:&Value,fragment:&Value,registry_index:usize,projection:&Value,config:&Value)->Vec<Value>{
    let quote=s(&fragment["span"]["quote"]);let surface=s(&e["surface"]);
    let exact:Vec<_>=quote.char_indices().filter_map(|(b,_)|quote[b..].starts_with(surface).then_some((b,b+surface.len()))).collect();
    let mode=if exact.is_empty(){"UNIQUE_WHITESPACE_DIFFERENCE"}else{"EXACT"};
    let ranges=if exact.is_empty(){whitespace_ranges(quote,surface)}else{exact};
    // Bind immutable fragment content once, not once for every repeated match.
    // The prefix table is populated only at scalar boundaries used by ranges;
    // it preserves the exact UTF16 offsets of the former prefix rescans.
    let fragment_sha=hash(fragment);
    let mut utf16_prefix=vec![0usize;quote.len()+1];let mut units=0;
    for (byte,c) in quote.char_indices(){utf16_prefix[byte]=units;units+=c.len_utf16();utf16_prefix[byte+c.len_utf8()]=units;}
    ranges.into_iter().enumerate().map(|(ordinal,(start,end))|{
        let absolute=fragment["span"]["start"].as_u64().unwrap()+utf16_prefix[start] as u64;
        let mut choice=json!({"resolver_version":LOCAL_RESOLUTION_VERSION,"prepared_payload_sha256":config["prepared_payload_sha256"],"registry_index":registry_index,"original_entry_sha256":projection["registry"][registry_index]["original_entry_sha256"],"evidence_id":e["mention_evidence_id"],"source_ref":fragment["source_ref"],"source_revision":fragment["source_revision"],"block_ref":fragment["block_ref"],"fragment_sha256":fragment_sha,"start":absolute,"end":absolute+(utf16_prefix[end]-utf16_prefix[start])as u64,"quote":&quote[start..end],"mention_occurrence":ordinal+1,"match_mode":mode,"model_surface":surface,"semantic_support_certified":false});
        choice["choice_id"]=json!(format!("mention_choice_{}",&hash(&choice)[..32]));choice
    }).collect()
}
fn checked_exclusions(raw:&Value,excluded:&Value)->Result<()>{let rows=excluded.as_array().ok_or_else(||error("LOCAL_MENTION_EXCLUSIONS_INVALID","LOCAL_MENTION_EXCLUSIONS_INVALID"))?;let mut seen=BTreeSet::new();need(rows.len()<=8&&rows.iter().all(|r|r.as_u64().is_some_and(|i|i<a(&raw["candidates"]).len()as u64&&seen.insert(i))),"LOCAL_MENTION_EXCLUSIONS_INVALID")}
fn checked_host_resolutions(raw:&Value,resolutions:&Value)->Result<()>{
    let rows=resolutions.as_array().ok_or_else(||error("LOCAL_MENTION_HOST_RESOLUTIONS_INVALID","LOCAL_MENTION_HOST_RESOLUTIONS_INVALID"))?;
    need(rows.len()<=24,"LOCAL_MENTION_HOST_RESOLUTIONS_INVALID")?;let mut seen=BTreeSet::new();
    for row in rows{shape(row,&["registry_index","choice_id"],"LOCAL_MENTION_HOST_RESOLUTIONS_INVALID")?;need(row["registry_index"].as_u64().is_some_and(|n|n<a(&raw["entities"]).len()as u64&&seen.insert(n))&&s(&row["choice_id"]).starts_with("mention_choice_")&&s(&row["choice_id"]).len()==47,"LOCAL_MENTION_HOST_RESOLUTIONS_INVALID")?;}Ok(())
}
fn resolve(
    raw: &Value,
    menu: &BTreeMap<String, Value>,
    projection: &Value,
    occurrence: bool,
    snapshot: &Value,
) -> (BTreeMap<String, Value>, Vec<Value>) { resolve_policy(raw,menu,projection,occurrence,snapshot,None) }
fn resolve_policy(raw:&Value,menu:&BTreeMap<String,Value>,projection:&Value,occurrence:bool,snapshot:&Value,local_policy:Option<&Value>)->(BTreeMap<String,Value>,Vec<Value>){
    let mut counts = BTreeMap::new();
    for e in a(raw) {
        if e["local_id"].is_string() {
            *counts.entry(s(&e["local_id"])).or_insert(0) += 1;
        }
    }
    let mut by_id = BTreeMap::new();
    let mut resolution = vec![];
    for (i, e) in a(raw).iter().enumerate() {
        let local = if e["local_id"].is_string() {
            e["local_id"].clone()
        } else {
            Value::Null
        };
        let mut choices=vec![];
        let result = (|| -> Result<Value> {
            need(
                local.is_null() || counts.get(s(&local)) == Some(&1),
                "ENTITY_REGISTRY_ID_DUPLICATE",
            )?;
            let mut keys = vec!["local_id", "surface", "type_label", "mention_evidence_id"];
            if occurrence && e.get("mention_occurrence").is_some() {
                keys.push("mention_occurrence");
            }
            shape(e, &keys, "ENTITY_REGISTRY_SHAPE_INVALID")?;
            id(&e["local_id"], "ENTITY_LOCAL_ID_INVALID")?;
            let surface = s(&e["surface"]);
            need(
                e["surface"].is_string()
                    && !surface.trim_matches(js_ws).is_empty()
                    && len(surface) <= 160,
                "ENTITY_SURFACE_INVALID",
            )?;
            need(
                e["type_label"].is_null()
                    || e["type_label"]
                        .as_str()
                        .is_some_and(|v| !v.is_empty() && len(v) <= 12000),
                "ENTITY_TYPE_LABEL_INVALID",
            )?;
            id(&e["mention_evidence_id"], "ENTITY_EVIDENCE_ID_INVALID")?;
            let fragment = menu
                .get(s(&e["mention_evidence_id"]))
                .ok_or_else(|| error("ENTITY_EVIDENCE_UNKNOWN", "ENTITY_EVIDENCE_UNKNOWN"))?;
            let quote = s(&fragment["span"]["quote"]);
            // Exact old selector behavior is retained for every historical op.
            let matches:Vec<_>=quote.char_indices().filter_map(|(byte,_)|quote[byte..].starts_with(surface).then_some(byte)).collect();
            let (ordinal,source_surface,start,host_choice)=if let Some(config)=local_policy{
                choices=local_choices(e,fragment,i,projection,config);
                let override_row=a(&config["host_resolutions"]).iter().find(|r|r["registry_index"]==i);
                let selected=if let Some(r)=override_row{
                    choices.iter().find(|c|c["choice_id"]==r["choice_id"]).ok_or_else(||error("LOCAL_MENTION_HOST_CHOICE_INVALID","LOCAL_MENTION_HOST_CHOICE_INVALID"))?
                }else{
                    need(e.get("mention_occurrence").is_some(),"REQUIRED_OCCURRENCE_MISSING")?;
                    let ordinal=e["mention_occurrence"].as_u64().filter(|n|*n>=1).ok_or_else(||error("ENTITY_MENTION_OCCURRENCE_INVALID","ENTITY_MENTION_OCCURRENCE_INVALID"))? as usize;
                    need(!choices.is_empty(),"ENTITY_SURFACE_NO_EXACT_OR_WHITESPACE_MATCH")?;
                    if matches.is_empty(){need(choices.len()==1,"ENTITY_SURFACE_WHITESPACE_AMBIGUOUS")?;need(ordinal==1,"ENTITY_MENTION_OCCURRENCE_INVALID")?;}
                    need(ordinal<=choices.len(),"ENTITY_MENTION_OCCURRENCE_INVALID")?;&choices[ordinal-1]
                };
                (selected["mention_occurrence"].as_u64().unwrap()as usize,s(&selected["quote"]).to_owned(),selected["start"].as_u64().unwrap(),override_row.cloned())
            }else{
                need(!matches.is_empty(),"ENTITY_SURFACE_NO_EXACT_MATCH")?;
                let ordinal=if occurrence&&e.get("mention_occurrence").is_some(){e["mention_occurrence"].as_u64().filter(|v|*v>=1&&*v<=matches.len()as u64).ok_or_else(||error("ENTITY_MENTION_OCCURRENCE_INVALID","ENTITY_MENTION_OCCURRENCE_INVALID"))?as usize}else{need(matches.len()==1,"ENTITY_SURFACE_AMBIGUOUS")?;1};
                (ordinal,surface.to_owned(),fragment["span"]["start"].as_u64().unwrap()+len(&quote[..matches[ordinal-1]])as u64,None)
            };
            let entity=json!({"local_id":e["local_id"],"label":source_surface,"entity_ref":null,"type_label":e["type_label"],"mentions":[{"evidence_ref":e["mention_evidence_id"],"span":{"start":start,"end":start+len(&source_surface)as u64,"quote":source_surface,"offset_unit":"utf16_code_unit"}}]});
            let mut row = json!({"registry_index":i,"local_id":local,"status":"RESOLVED_ANCHOR","entity":entity});
            if occurrence {
                let source = a(&snapshot["sources"])
                    .iter()
                    .find(|src| {
                        src["source_ref"] == fragment["source_ref"]
                            && src["source_revision"] == fragment["source_revision"]
                    })
                    .unwrap_or(&Value::Null);
                row["occurrence_selection"] = json!({"registry_index":i,"local_id":local,"original_key":projection["registry"][i]["original_key"],"mention_evidence_id":e["mention_evidence_id"],"source_ref":fragment["source_ref"],"source_revision":fragment["source_revision"],"text_sha256":source["text_sha256"],"fragment_sha256":hash(fragment),"ordinal":ordinal,"match_count":matches.len(),"span":entity["mentions"][0]["span"]});
                if local_policy.is_some(){
                    let selected=&choices[ordinal-1];
                    let model_chars:Vec<_>=surface.char_indices().filter(|(_,c)|!js_ws(*c)).collect();
                    let source_chars:Vec<_>=source_surface.char_indices().filter(|(_,c)|!js_ws(*c)).collect();
                    let mapping:Vec<_>=model_chars.iter().zip(&source_chars).map(|((b,c),(sb,sc))|json!({"model_start":len(&surface[..*b]),"model_end":len(&surface[..*b])+c.len_utf16(),"source_start":start+len(&source_surface[..*sb])as u64,"source_end":start+len(&source_surface[..*sb])as u64+sc.len_utf16()as u64})).collect();
                    row["occurrence_selection"]["match_count"]=json!(choices.len());
                    row["occurrence_selection"]["resolver_version"]=json!(LOCAL_RESOLUTION_VERSION);
                    row["occurrence_selection"]["match_mode"]=selected["match_mode"].clone();
                    row["occurrence_selection"]["choice_id"]=selected["choice_id"].clone();
                    row["occurrence_selection"]["model_surface"]=json!(surface);
                    row["occurrence_selection"]["source_surface"]=json!(source_surface);
                    row["occurrence_selection"]["non_whitespace_scalar_mapping"]=json!(mapping);
                    row["occurrence_selection"]["host_resolution"]=json!(host_choice);
                    row["occurrence_selection"]["semantic_support_certified"]=json!(false);
                }
            }
            Ok(row)
        })();
        let mut entry = match result {
            Ok(v) => v,
            Err(e) => {
                json!({"registry_index":i,"local_id":local,"status":"QUARANTINED","error_code":e.code})
            }
        };
        if local_policy.is_some(){entry["resolver_version"]=json!(LOCAL_RESOLUTION_VERSION);entry["choices"]=json!(choices);}
        entry["symbol_projection_version"] = json!(SYMBOL);
        entry["original_registry_index"] = json!(i);
        entry["original_key"] = projection["registry"][i]["original_key"].clone();
        if !local.is_null() {
            by_id.insert(s(&local).to_owned(), entry.clone());
        }
        resolution.push(entry);
    }
    (by_id, resolution)
}
fn evidence_ids(ids: &Value, menu: &BTreeMap<String, Value>, code: &str) -> Result<()> {
    let rows = ids.as_array().ok_or_else(|| error(code, code))?;
    need(!rows.is_empty() && rows.len() <= 10000, code)?;
    let mut seen = BTreeSet::new();
    for v in rows {
        id(v, code)?;
        need(seen.insert(s(v)), code)?;
        need(menu.contains_key(s(v)), "FACT_EVIDENCE_UNKNOWN")?;
    }
    Ok(())
}
fn convert(
    f: &Value,
    cid: &str,
    prepared: &Value,
    menu: &BTreeMap<String, Value>,
    registry: &BTreeMap<String, Value>,
) -> Result<(Value, Vec<Value>)> {
    shape(
        f,
        &[
            "local_id",
            "kind",
            "subject_local_id",
            "predicate",
            "object",
            "direction",
            "description",
            "keywords",
            "qualifiers",
            "conditions",
            "support_evidence_ids",
        ],
        "FACT_SHAPE_INVALID",
    )?;
    id(&f["local_id"], "FACT_LOCAL_ID_INVALID")?;
    id(&f["subject_local_id"], "FACT_SUBJECT_ID_INVALID")?;
    evidence_ids(
        &f["support_evidence_ids"],
        menu,
        "FACT_SUPPORT_EVIDENCE_INVALID",
    )?;
    if !f["predicate"].is_null() {
        shape(
            &f["predicate"],
            &["label", "description", "evidence_ids"],
            "FACT_PREDICATE_SHAPE_INVALID",
        )?;
        evidence_ids(
            &f["predicate"]["evidence_ids"],
            menu,
            "FACT_PREDICATE_EVIDENCE_INVALID",
        )?;
        need(
            a(&f["predicate"]["evidence_ids"])
                .iter()
                .all(|id| a(&f["support_evidence_ids"]).contains(id)),
            "FACT_PREDICATE_SUPPORT_UNDECLARED",
        )?;
    }
    let conditions = f["conditions"]
        .as_array()
        .ok_or_else(|| error("FACT_CONDITIONS_INVALID", "FACT_CONDITIONS_INVALID"))?;
    need(conditions.len() <= 10000, "FACT_CONDITIONS_INVALID")?;
    for c in conditions {
        shape(
            c,
            &["id", "text", "evidence_ids"],
            "FACT_CONDITION_SHAPE_INVALID",
        )?;
        evidence_ids(&c["evidence_ids"], menu, "FACT_CONDITION_EVIDENCE_INVALID")?;
        need(
            a(&c["evidence_ids"])
                .iter()
                .all(|id| a(&f["support_evidence_ids"]).contains(id)),
            "FACT_CONDITION_SUPPORT_UNDECLARED",
        )?;
    }
    let mut refs = vec![f["subject_local_id"].clone()];
    if !f["object"].is_null() {
        shape(
            &f["object"],
            &["entity_local_id", "typed_value"],
            "FACT_OBJECT_SHAPE_INVALID",
        )?;
        if !f["object"]["entity_local_id"].is_null() {
            id(&f["object"]["entity_local_id"], "FACT_OBJECT_ID_INVALID")?;
            if !refs.contains(&f["object"]["entity_local_id"]) {
                refs.push(f["object"]["entity_local_id"].clone());
            }
        }
    }
    let errors:Vec<_>=refs.iter().filter(|id|registry.get(s(id)).is_none_or(|r|r["status"]!="RESOLVED_ANCHOR")).map(|id|json!({"local_id":id,"error_code":registry.get(s(id)).map(|r|r["error_code"].clone()).unwrap_or(json!("ENTITY_REFERENCE_UNKNOWN"))})).collect();
    if !errors.is_empty() {
        let mut e = error(
            "FACT_ENTITY_REFERENCE_UNRESOLVED",
            "FACT_ENTITY_REFERENCE_UNRESOLVED",
        );
        e.details = Some(json!(errors));
        return Err(e);
    }
    let entities: Vec<_> = refs
        .iter()
        .map(|id| registry[s(id)]["entity"].clone())
        .collect();
    let anchors = unique(
        entities
            .iter()
            .map(|e| e["mentions"][0]["evidence_ref"].clone()),
    );
    let evidence = unique(
        a(&f["support_evidence_ids"])
            .iter()
            .cloned()
            .chain(anchors.iter().cloned()),
    );
    let conditions: Vec<_> = conditions
        .iter()
        .map(|c| {
            let mut c = c.clone();
            c["support_status"] = json!("UNVERIFIED");
            c
        })
        .collect();
    Ok((
        json!({"contract_version":"lightog-knowledge/0.2","candidate_id":cid,"kind":f["kind"],"snapshot":prepared["payload"]["snapshot"],"evidence_set_ref":prepared["payload"]["evidence_set_ref"],"evidence_ids":evidence,"entities":entities,"subject_local_id":f["subject_local_id"],"predicate":if f["predicate"].is_null(){Value::Null}else{json!({"predicate_ref":null,"proposed_definition":f["predicate"]})},"object":f["object"],"direction":f["direction"],"description":f["description"],"keywords":f["keywords"],"qualifiers":f["qualifiers"],"conditions":conditions,"status":"CANDIDATE","semantic_status":"UNVERIFIED"}),
        anchors,
    ))
}
fn occurrence_binding(
    prepared: &Value,
    raw: &Value,
    unit: &Value,
    index: usize,
    candidate: &Value,
    resolution: &[Value],
    local: Option<&Value>,
) -> Value {
    let used: BTreeSet<_> = a(&candidate["entities"])
        .iter()
        .map(|e| s(&e["local_id"]))
        .collect();
    let selections: Vec<_> = resolution
        .iter()
        .filter(|r| used.contains(s(&r["local_id"])))
        .map(|r| r["occurrence_selection"].clone())
        .collect();
    let mut binding=json!({"contract_version":OCCURRENCE_SELECTION_VERSION,"prepared_payload_sha256":hash(&prepared["payload"]),"source_snapshot_sha256":hash(&prepared["payload"]["snapshot"]),"raw_sha256":hash(raw),"raw":raw,"unit_id":unit,"fact_index":index,"candidate_sha256":hash(candidate),"selections":selections,"semantic_support_certified":false});
    if let Some(config)=local{binding["contract_version"]=json!(LOCAL_SELECTION_VERSION);binding["resolver_version"]=json!(LOCAL_RESOLUTION_VERSION);binding["host_resolutions"]=config["host_resolutions"].clone();binding["excluded_fact_indices"]=config["excluded_fact_indices"].clone();}
    binding
}
/// Mechanical replay only: a selected position does not certify entity identity or fact support.
pub fn validate_occurrence_receipt(
    candidate: &Value,
    receipt: &Value,
    prepared: &Value,
) -> Result<()> {
    let binding = &receipt["mention_occurrence_selection"];
    let raw = &binding["raw"];
    shape(
        raw,
        &["entities", "candidates"],
        "OCCURRENCE_RECEIPT_CHANGED",
    )?;
    need(
        raw["entities"].as_array().is_some_and(|r| r.len() <= 24)
            && raw["candidates"].as_array().is_some_and(|r| r.len() <= 8),
        "OCCURRENCE_RECEIPT_CHANGED",
    )?;
    let index = binding["fact_index"]
        .as_u64()
        .filter(|v| *v < a(&raw["candidates"]).len() as u64)
        .ok_or_else(|| error("OCCURRENCE_RECEIPT_CHANGED", "OCCURRENCE_RECEIPT_CHANGED"))?
        as usize;
    need(
        binding["unit_id"]
            .as_str()
            .is_some_and(|v| !v.is_empty() && len(v) <= 256),
        "OCCURRENCE_RECEIPT_CHANGED",
    )?;
    let (projected, projection) = project(raw)?;
    let menu = menu(prepared)?;
    let config=if binding["contract_version"]==LOCAL_SELECTION_VERSION{checked_host_resolutions(raw,&binding["host_resolutions"])?;checked_exclusions(raw,&binding["excluded_fact_indices"])?;need(!a(&binding["excluded_fact_indices"]).contains(&json!(index)),"OCCURRENCE_RECEIPT_CHANGED")?;Some(json!({"prepared_payload_sha256":hash(&prepared["payload"]),"host_resolutions":binding["host_resolutions"],"excluded_fact_indices":binding["excluded_fact_indices"]}))}else{need(binding["contract_version"]==OCCURRENCE_SELECTION_VERSION,"OCCURRENCE_RECEIPT_CHANGED")?;None};
    let (registry,resolution)=resolve_policy(&projected["entities"],&menu,&projection,true,&prepared["payload"]["snapshot"],config.as_ref());
    let namespace = sha(&binding["unit_id"]);
    let cid = format!("c_v2_{}_{:03}", &namespace[..16], index + 1);
    let fact = &projected["candidates"][index];
    let (expected, anchors) = convert(fact, &cid, prepared, &menu, &registry)?;
    need(
        receipt["candidate_id"] == cid
            && receipt["candidate_sha256"] == hash(&expected)
            && receipt["input_fact_sha256"] == hash(fact)
            && receipt["entity_registry_sha256"] == hash(&projected["entities"])
            && receipt["prepared_payload_sha256"] == hash(&prepared["payload"])
            && receipt["symbol_raw_input_sha256"] == hash(raw)
            && receipt["symbol_original_fact_sha256"]
                == projection["facts"][index]["original_fact_sha256"]
            && receipt["fact_support_evidence_ids"] == fact["support_evidence_ids"]
            && receipt["registry_anchor_evidence_ids"] == json!(anchors)
            && expected == *candidate
            && *binding
                == occurrence_binding(
                    prepared,
                    raw,
                    &binding["unit_id"],
                    index,
                    &expected,
                    &resolution,
                    config.as_ref(),
                ),
        "OCCURRENCE_RECEIPT_CHANGED",
    )
}
/// Strict proposal preflight. Every registry row must explicitly select one
/// resolvable exact mention, including rows unused by otherwise valid facts.
/// This is a mechanical contract check, never an entity identity judgment.
pub fn required_occurrence_registry(prepared: &Value, raw: &Value) -> Result<Value> {
    shape(
        raw,
        &["entities", "candidates"],
        "REQUIRED_OCCURRENCE_RAW_INVALID",
    )?;
    need(
        raw["entities"]
            .as_array()
            .is_some_and(|rows| rows.len() <= 24)
            && raw["candidates"]
                .as_array()
                .is_some_and(|rows| rows.len() <= 8),
        "REQUIRED_OCCURRENCE_RAW_INVALID",
    )?;
    let (projected, projection) = project(raw)?;
    let menu = menu(prepared)?;
    let (_, rows) = resolve(
        &projected["entities"],
        &menu,
        &projection,
        true,
        &prepared["payload"]["snapshot"],
    );
    let mut errors = vec![];
    for (i, entity) in a(&raw["entities"]).iter().enumerate() {
        let code = if entity.get("mention_occurrence").is_none() {
            Some("REQUIRED_OCCURRENCE_MISSING")
        } else if rows[i]["status"] != "RESOLVED_ANCHOR" {
            Some(s(&rows[i]["error_code"]))
        } else {
            None
        };
        if let Some(code) = code {
            errors.push(
                json!({"registry_index":i,"original_key":entity["local_id"],"error_code":code}),
            );
        }
    }
    if !errors.is_empty() {
        let mut e = error(
            "REQUIRED_OCCURRENCE_REGISTRY_INVALID",
            "REQUIRED_OCCURRENCE_REGISTRY_INVALID",
        );
        e.details = Some(json!(errors));
        return Err(e);
    }
    Ok(
        json!({"entity_count":rows.len(),"selections":rows.iter().map(|r|r["occurrence_selection"].clone()).collect::<Vec<_>>(),"semantic_support_certified":false}),
    )
}
/// Versioned local registry validation: unresolved rows are retained, not a batch veto.
pub fn local_occurrence_registry(prepared:&Value,raw:&Value,resolutions:&Value)->Result<Value>{
    shape(raw,&["entities","candidates"],"REQUIRED_OCCURRENCE_RAW_INVALID")?;
    need(raw["entities"].as_array().is_some_and(|r|r.len()<=24)&&raw["candidates"].as_array().is_some_and(|r|r.len()<=8),"REQUIRED_OCCURRENCE_RAW_INVALID")?;
    checked_host_resolutions(raw,resolutions)?;
    let (projected,projection)=project(raw)?;let menu=menu(prepared)?;
    let config=json!({"prepared_payload_sha256":hash(&prepared["payload"]),"host_resolutions":resolutions});
    let (_,rows)=resolve_policy(&projected["entities"],&menu,&projection,true,&prepared["payload"]["snapshot"],Some(&config));
    for r in a(resolutions){need(rows[r["registry_index"].as_u64().unwrap()as usize]["status"]=="RESOLVED_ANCHOR","LOCAL_MENTION_HOST_CHOICE_INVALID")?;}
    Ok(json!({"resolver_version":LOCAL_RESOLUTION_VERSION,"entity_count":rows.len(),"resolved_count":rows.iter().filter(|r|r["status"]=="RESOLVED_ANCHOR").count(),"quarantined_count":rows.iter().filter(|r|r["status"]=="QUARANTINED").count(),"entity_resolution":rows,"host_resolutions":resolutions,"isolation":"ENTITY_AND_REFERENCING_CANDIDATES_ONLY","semantic_support_certified":false}))
}
fn materialize(p:&Value,occurrence:bool)->Result<Value>{materialize_policy(p,occurrence,false)}
fn materialize_policy(p: &Value, occurrence: bool, local:bool) -> Result<Value> {
    let mut shaped=p.clone();if local{shaped.as_object_mut().ok_or_else(||error("SEED_MATERIALIZE_SHAPE_INVALID","SEED_MATERIALIZE_SHAPE_INVALID"))?.remove("host_resolutions");shaped.as_object_mut().unwrap().remove("excluded_fact_indices");}
    shape(
        &shaped,
        &[
            "prepared",
            "trusted_context",
            "raw",
            "unit_id",
            "max_candidates",
        ],
        "SEED_MATERIALIZE_SHAPE_INVALID",
    )?;
    need(
        p["unit_id"]
            .as_str()
            .is_some_and(|v| !v.is_empty() && len(v) <= 256),
        "SEED_MATERIALIZE_UNIT_INVALID",
    )?;
    let max = p["max_candidates"]
        .as_u64()
        .filter(|v| (1..=8).contains(v))
        .ok_or_else(|| error("SEED_MATERIALIZE_LIMIT", "SEED_MATERIALIZE_LIMIT"))?;
    let expected = crate::knowledge_build::prepare_extract(
        &json!({"evidence_set_ref":p["prepared"]["payload"]["evidence_set_ref"],"cq_guidance":p["prepared"]["payload"]["cq_guidance"],"trusted_context":p["trusted_context"]}),
    )?;
    need(
        expected == p["prepared"],
        "SEED_MATERIALIZE_PREPARED_CHANGED",
    )?;
    let raw = &p["raw"];
    shape(raw, &["entities", "candidates"], "SYMBOL_ENVELOPE_INVALID")?;
    need(
        raw["entities"].as_array().is_some_and(|r| r.len() <= 24)
            && raw["candidates"]
                .as_array()
                .is_some_and(|r| r.len() <= max as usize),
        "SYMBOL_COLLECTION_LIMIT",
    )?;
    let (projected, projection) = project(raw)?;
    let menu = menu(&p["prepared"])?;
    let resolutions=p.get("host_resolutions").cloned().unwrap_or(json!([]));
    let excluded=p.get("excluded_fact_indices").cloned().unwrap_or(json!([]));
    let config=if local{checked_host_resolutions(raw,&resolutions)?;checked_exclusions(raw,&excluded)?;Some(json!({"prepared_payload_sha256":hash(&p["prepared"]["payload"]),"host_resolutions":resolutions,"excluded_fact_indices":excluded}))}else{None};
    let (registry,resolution)=resolve_policy(&projected["entities"],&menu,&projection,occurrence,&p["prepared"]["payload"]["snapshot"],config.as_ref());
    let namespace = sha(&p["unit_id"]);
    let registry_hash = hash(&projected["entities"]);
    let payload_hash = hash(&p["prepared"]["payload"]);
    let mut candidates = vec![];
    let mut quarantined = vec![];
    let mut receipts = vec![];
    for (i, f) in a(&projected["candidates"]).iter().enumerate() {
        let cid = format!("c_v2_{}_{:03}", &namespace[..16], i + 1);
        let symbol = &projection["facts"][i];
        let mut receipt = json!({"adapter_version":ADAPTER,"unit_id":p["unit_id"],"fact_index":i,"model_fact_local_id":f.get("local_id").filter(|v|v.is_string()).cloned(),"candidate_id":cid,"input_fact_sha256":hash(f),"entity_registry_sha256":registry_hash,"prepared_payload_sha256":payload_hash,"validator":"RUST_P2_BUILD","semantic_support_certified":false,"symbol_projection_version":SYMBOL,"symbol_raw_input_sha256":projection["raw_input_sha256"],"symbol_original_fact_index":i,"symbol_original_fact_sha256":symbol["original_fact_sha256"],"symbol_generated_fact_local_id":symbol["generated_fact_local_id"]});
        if !a(&symbol["projection_errors"]).is_empty() {
            receipt["symbol_projection_errors"] = symbol["projection_errors"].clone();
        }
        let result = (|| -> Result<Value> {
            need(!local||!a(&excluded).contains(&json!(i)),"HOST_EXCLUDED_CANDIDATE")?;
            let (candidate, anchors) = convert(f, &cid, &p["prepared"], &menu, &registry)?;
            receipt["fact_support_evidence_ids"] = f["support_evidence_ids"].clone();
            receipt["registry_anchor_evidence_ids"] = json!(anchors);
            receipt["candidate_sha256"] = json!(hash(&candidate));
            if occurrence {
                receipt["mention_occurrence_selection"] = occurrence_binding(
                    &p["prepared"],
                    raw,
                    &p["unit_id"],
                    i,
                    &candidate,
                    &resolution,
                    config.as_ref(),
                );
            }
            let built = crate::knowledge_build::build(
                &json!({"candidates":[candidate],"snapshot":p["prepared"]["payload"]["snapshot"],"trusted_context":p["trusted_context"]}),
            )?;
            if built["graph"]["graph_digest"].is_string() {
                receipt["graph_digest"] = built["graph"]["graph_digest"].clone();
            }
            Ok(candidate)
        })();
        match result {
            Ok(candidate) => {
                receipt["status"] = json!("VALIDATED_CANDIDATE");
                candidates.push(candidate);
            }
            Err(e) => {
                receipt["status"] = json!("QUARANTINED");
                receipt["error_code"] = json!(e.code);
                let mut q = json!({"fact_index":i,"model_fact_local_id":receipt["model_fact_local_id"],"candidate_id":cid,"error_code":e.code});
                if let Some(details) = e.details.filter(|v| v.is_array()) {
                    q["entity_errors"] = details;
                }
                quarantined.push(q);
            }
        }
        receipts.push(receipt);
    }
    Ok(
        json!({"materializer_version":if local {LOCAL_OCCURRENCE_VERSION}else if occurrence {OCCURRENCE_VERSION} else {VERSION},"adapter_version":ADAPTER,"unit_id":p["unit_id"],"candidates":candidates,"quarantined":quarantined,"entity_resolution":resolution,"receipts":receipts,"symbol_projection_version":SYMBOL,"symbol_projection":projection,"raw_parsed_sha256":hash(raw),"semantic_support_certified":false,"publication_performed":false}),
    )
}
/// Preserve numeric token types until ordinal validation. The receipt binds the
/// parsed value; exact response bytes remain a distinct host attempt artifact.
fn materialize_occurrence(p: &Value) -> Result<Value> {
    if let Some(text) = p["raw"].as_str() {
        let parsed = crate::model_json_boundary::parse(text)?;
        let mut input = p.clone();
        input["raw"] = parsed["parsed"].clone();
        let mut out = materialize(&input, true)?;
        out["raw_text_parse_receipt"] = parsed["receipt"].clone();
        out["raw_binding_policy"] =
            json!("PARSED_VALUE_RECEIPT_DISTINCT_FROM_EXACT_RESPONSE_BYTES");
        Ok(out)
    } else {
        materialize(p, true)
    }
}
pub fn execute(op: &str, p: &Value) -> Result<Value> {
    need(
        serde_json::to_vec(p)
            .map_err(|_| {
                error(
                    "SEED_MATERIALIZE_INPUT_INVALID",
                    "SEED_MATERIALIZE_INPUT_INVALID",
                )
            })?
            .len()
            <= 16 * 1024 * 1024,
        "SEED_MATERIALIZE_RESOURCE_LIMIT",
    )?;
    match op {
        "materialize" => materialize(p, false),
        "materialize_occurrence_v1" => materialize_occurrence(p),
        "materialize_local_occurrence_v1" => materialize_policy(p,true,true),
        "namespace" => {
            shape(
                p,
                &["unit_id", "round_id", "stage"],
                "SEED_NAMESPACE_SHAPE_INVALID",
            )?;
            need(
                p["unit_id"]
                    .as_str()
                    .is_some_and(|v| !v.is_empty() && len(v) <= 256)
                    && p["round_id"]
                        .as_str()
                        .is_some_and(|v| !v.trim().is_empty() && len(v) <= 128)
                    && ["DISCOVERY", "GAP_EXTRACT"].contains(&s(&p["stage"])),
                "SEED_NAMESPACE_INPUT_INVALID",
            )?;
            let digest = hash(
                &json!({"protocol_version":"lightog-p2-seed-expansion/0.1","unit_id":p["unit_id"],"round_id":p["round_id"],"stage":p["stage"]}),
            );
            Ok(
                json!({"version":VERSION,"unit_id":format!("seed_{digest}"),"namespace_unit_id":format!("seed_{digest}"),"namespace_policy":"PROTOCOL_UNIT_STAGE_ROUND_SHA256_V1"}),
            )
        }
        _ => Err(error(
            "SEED_MATERIALIZE_OPERATION_UNKNOWN",
            "SEED_MATERIALIZE_OPERATION_UNKNOWN",
        )),
    }
}
