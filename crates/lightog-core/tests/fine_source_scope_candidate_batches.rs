//! Original offline matrix/staging compatibility tests. Synthetic proposals are
//! unverified navigation candidates, not semantic coverage or publication proof.
use lightog_core::{
    candidate_staging_v1 as staging,
    common::{a, len, s, text_sha},
    document_scope_v1 as scope,
    fine_source_evidence as fine,
    knowledge_build,
    support_selection,
};
use serde_json::{json, Value};
use std::collections::BTreeSet;

fn fixture() -> Value {
    let text=(0..5).map(|i|format!("Maple Relay metric {i} is value {i}. ")).collect::<String>();
    let sha=text_sha(&text);
    let snapshot=json!({"base_ref":"scope_matrix_staging_authored","source_epoch":0,"graph_revision":null,"sources":[{"source_ref":"original","source_revision":"v1","text_sha256":sha,"original_sha256":sha,"parser_version":"authored/1"}]});
    let fragment=json!({"id":"parent_source","origin":"SOURCE_FRAGMENT","source_ref":"original","source_revision":"v1","block_ref":"block","text_sha256":sha,"span":{"start":0,"end":len(&text),"quote":text,"offset_unit":"utf16_code_unit"},"claim_refs":[],"role":"PRIMARY"});
    let es=json!({"contract_version":"lightog-demand/0.1","evidence_set_id":"matrix_original_es","snapshot":snapshot,"fragments":[fragment]});
    let context=json!({"examples":{"original":es},"source_texts":[{"source_ref":"original","source_revision":"v1","text":text,"original_sha256":sha,"parser_version":"authored/1","blocks":[{"block_ref":"block","start":0,"end":len(&text)}]}],"authority":{"requests":[],"allowed_snapshots":[snapshot],"claims":[],"receipts":[],"scope_bindings":[],"entities":[],"predicate_refs":[],"user_definitions":[],"groups":[],"entity_links":[]}});
    let prepared=scope::prepare(&json!({"snapshot":snapshot,"evidence_set":es,"context":context,"user_cqs":[],"definitions":"","max_batch_utf16":24000,"max_fragments_per_batch":64})).unwrap();
    let eid=&prepared["batches"][0]["source_evidence_menu"][0]["evidence_id"];
    let families:Vec<Value>=(0..5).map(|i|json!({"key":format!("metric_{i}"),"label":format!("Metric {i}"),"question":format!("What is {{subject}}'s metric {i}?"),"target":format!("metric {i}"),"operation":"LOOKUP","conditions":[],"evidence_ids":[eid],"subjects":[{"surface":"Maple Relay","evidence_id":eid,"occurrence":0,"rationale":"Authored source mention, not a confirmed entity identity."}]})).collect();
    let plan=scope::materialize(&json!({"prepared":prepared,"responses":[{"batch_id":prepared["batches"][0]["batch_id"],"raw":{"families":families,"unknowns":[]}}]})).unwrap();
    let refinement=fine::execute("refine_scope_batches",&json!({"contract_version":fine::VERSION,"evidence_set":es,"context":context,"scope_plan":plan})).unwrap();
    assert_eq!(a(&refinement["groups"]).len(),2);
    assert_eq!(a(&refinement["batches"]).len(),2);
    json!({"evidence_set":es,"context":context,"scope_plan":plan,"refinement":refinement})
}

fn proposal(evidence_id:&Value,target:&str) -> Value {
    let i=target.strip_prefix("metric ").unwrap();
    json!({"entities":[{"local_id":"maple","surface":"Maple Relay","type_label":"Relay service","mention_evidence_id":evidence_id,"mention_occurrence":1}],"candidates":[{
        "kind":"ATTRIBUTE","subject_local_id":"maple","predicate":{"label":target,"description":format!("Authored {target} property."),"evidence_ids":[evidence_id]},
        "object":{"entity_local_id":null,"typed_value":{"kind":"STRING","value":format!("value {i}")}},"direction":"NONE","description":format!("Maple Relay metric {i} is value {i}."),"keywords":["Maple Relay",target],
        "qualifiers":{"scope":null,"modality":"REPORTED","negated":false,"unit":null,"effective_time":null},"conditions":[],"support_roles":{"assertion":[evidence_id],"subject_scope":[],"antecedent":[],"condition":[]}
    }]})
}

fn assembly_input(f:&Value,reuse_namespace:bool)->Value {
    let mut rows=vec![];
    for (index,batch) in a(&f["refinement"]["batches"]).iter().enumerate() {
        let es=&batch["evidence_set"];let mut context=f["context"].clone();
        context["examples"][s(&es["evidence_set_id"])]=es.clone();
        let prepared=knowledge_build::prepare_extract(&json!({"evidence_set_ref":es["evidence_set_id"],"cq_guidance":format!("Authored task group {}",index),"trusted_context":context})).unwrap();
        let task_id=&batch["scope_task_ids"][0];
        let task=a(&f["scope_plan"]["tasks"]).iter().find(|task|task["id"]==*task_id).unwrap();
        let raw=proposal(&prepared["payload"]["evidence_menu"][0]["evidence_id"],s(&task["target"]));
        let unit=if reuse_namespace{"matrix_task_batch_reused".to_owned()}else{format!("matrix_task_batch_{index:03}")};
        let material=support_selection::execute("materialize_local_required_occurrence_v1",&json!({"prepared":prepared,"trusted_context":context,"raw":raw,"unit_id":unit,"max_candidates":8})).unwrap();
        assert_eq!(a(&material["candidates"]).len(),1);
        assert!(a(&material["quarantined"]).is_empty());
        let input=json!({"contract_version":staging::VERSION,"candidates":material["candidates"],"prepared":prepared,"trusted_context":context,"receipts":material["receipts"],"context_evidence_ids":a(&prepared["payload"]["evidence_menu"]).iter().map(|e|e["evidence_id"].clone()).collect::<Vec<_>>(),"max_context_utf16":24000});
        rows.push(json!({"input":input,"phase":format!("EXTRACTION_{index:03}"),"request_id":format!("authored_request_{index:03}")}));
    }
    json!({"contract_version":staging::BATCH_VERSION,"evidence_set":f["evidence_set"],"refinement_context":f["context"],"refinement":f["refinement"],"batches":rows})
}

#[test]
fn repeated_source_context_in_two_scope_groups_assembles_with_composite_evidence_and_distinct_candidate_namespaces() {
    let f=fixture();
    let groups=a(&f["refinement"]["batches"]);
    assert_ne!(groups[0]["evidence_set"]["evidence_set_id"],groups[1]["evidence_set"]["evidence_set_id"]);
    assert_eq!(groups[0]["evidence_set"]["fragments"],groups[1]["evidence_set"]["fragments"]);
    let input=assembly_input(&f,false);
    let assembled=staging::execute("assemble_batches",&input).unwrap();
    let candidate_ids:BTreeSet<&str>=a(&assembled["candidates"]).iter().map(|c|s(&c["candidate_id"])).collect();
    assert_eq!(candidate_ids.len(),2);
    let evidence_sets:BTreeSet<&str>=a(&assembled["candidates"]).iter().map(|c|s(&c["evidence_set_ref"])).collect();
    assert_eq!(evidence_sets.len(),2);
    let staged=staging::execute("stage_batches",&assembled).unwrap();
    assert_eq!(a(&staged["staged_candidates"]).len(),2);
    assert_eq!(staged["semantic_support_certified"],false);
    assert_eq!(staged["publication_performed"],false);
    let built=knowledge_build::build(&json!({"candidates":assembled["candidates"],"snapshot":f["evidence_set"]["snapshot"],"trusted_context":assembled["trusted_context"]})).unwrap();
    assert_eq!(a(&built["graph"]["entities"]).len(),1,"The same exact source anchor is not a new identity in another task group");
    assert_eq!(a(&built["graph"]["entities"][0]["anchors"]).len(),1);
    assert_eq!(a(&built["graph"]["entities"][0]["evidence_refs"]).len(),2,"Both evidence-set aliases remain explicitly reversible");
    assert_eq!(a(&built["graph"]["statements"]).len(),2);
}

#[test]
fn reusing_the_same_materialization_namespace_across_matrix_groups_is_rejected() {
    let f=fixture();let input=assembly_input(&f,true);
    assert_eq!(staging::execute("assemble_batches",&input).unwrap_err().code,"CANDIDATE_BATCH_ID_REUSED");
}

#[test]
fn dropping_a_matrix_work_item_cannot_pass_complete_batch_assembly() {
    let f=fixture();let mut input=assembly_input(&f,false);
    input["batches"].as_array_mut().unwrap().pop();
    assert_eq!(staging::execute("assemble_batches",&input).unwrap_err().code,"CANDIDATE_BATCH_COVERAGE_INVALID");
}
