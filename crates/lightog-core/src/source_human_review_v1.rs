//! Human judgement binds a source choice; it never certifies model facts or
//! performs graph writes. The host supplies persisted items and current sources.
use crate::common::{a, canonical_hash as hash, error, len, s, slice16, text_sha, Result};
use serde_json::{json, Value};
use std::collections::BTreeSet;
pub const VERSION: &str = "lightog-source-human-review/0.1";
fn need(ok: bool, code: &str) -> Result<()> {if ok {Ok(())} else {Err(error(code, code))}}
fn source_scope(v: &Value) -> Value {json!({"base_ref":v["base_ref"],"source_epoch":v["source_epoch"],"sources":v["sources"]})}
fn boundary(text: &str, n: usize) -> bool {n == 0 || text.chars().scan(0, |p,c| {*p+=c.len_utf16();Some(*p)}).any(|p| p==n)}
fn item_hash(item: &Value) -> String {let mut v=item.clone();v.as_object_mut().unwrap().remove("item_revision");hash(&v)}
fn checked_options(item: &Value, sources: &Value) -> Result<()> {
    let options=item["options"].as_array().ok_or_else(||error("HUMAN_REVIEW_OPTIONS_INVALID","HUMAN_REVIEW_OPTIONS_INVALID"))?;
    need(options.len()<=128,"HUMAN_REVIEW_OPTIONS_INVALID")?;
    let mut ids=BTreeSet::new();
    for o in options {
        need(!s(&o["id"]).is_empty() && ids.insert(s(&o["id"])) && !s(&o["evidence_id"]).is_empty(),"HUMAN_REVIEW_OPTIONS_INVALID")?;
        let found:Vec<_>=a(sources).iter().filter(|r|r["source_ref"]==o["source_ref"]&&r["source_revision"]==o["source_revision"]).collect();
        need(found.len()==1,"HUMAN_REVIEW_SOURCE_UNAVAILABLE")?;
        let source=found[0]; let text=source["text"].as_str().ok_or_else(||error("HUMAN_REVIEW_SOURCE_INVALID","HUMAN_REVIEW_SOURCE_INVALID"))?;
        let start=o["span"]["start"].as_u64().ok_or_else(||error("HUMAN_REVIEW_SPAN_INVALID","HUMAN_REVIEW_SPAN_INVALID"))? as usize;
        let end=o["span"]["end"].as_u64().ok_or_else(||error("HUMAN_REVIEW_SPAN_INVALID","HUMAN_REVIEW_SPAN_INVALID"))? as usize;
        need(start<end && end<=len(text) && boundary(text,start) && boundary(text,end) && !s(&o["span"]["quote"]).is_empty() && slice16(text,start,end)==s(&o["span"]["quote"]),"HUMAN_REVIEW_SPAN_INVALID")?;
        if !o["context_span"].is_null(){
            let cs=o["context_span"]["start"].as_u64().ok_or_else(||error("HUMAN_REVIEW_CONTEXT_INVALID","HUMAN_REVIEW_CONTEXT_INVALID"))? as usize;
            let ce=o["context_span"]["end"].as_u64().ok_or_else(||error("HUMAN_REVIEW_CONTEXT_INVALID","HUMAN_REVIEW_CONTEXT_INVALID"))? as usize;
            need(cs<=start&&ce>=end&&ce<=len(text)&&boundary(text,cs)&&boundary(text,ce)&&slice16(text,cs,ce)==s(&o["context_span"]["quote"])&&o["context_quote"]==o["context_span"]["quote"],"HUMAN_REVIEW_CONTEXT_INVALID")?;
        }
        need(source["text_sha256"].is_null()||source["text_sha256"]==text_sha(text),"HUMAN_REVIEW_SOURCE_HASH_CHANGED")?;
        let snapshot_sources=a(&item["source_snapshot"]["sources"]);
        need(snapshot_sources.iter().any(|r|r["source_ref"]==o["source_ref"]&&r["source_revision"]==o["source_revision"]&&r["text_sha256"]==text_sha(text)),"HUMAN_REVIEW_SOURCE_HASH_CHANGED")?;
    }
    Ok(())
}
fn prepare(p: &Value)->Result<Value>{
    let mut item=p["item"].clone();
    need(item.is_object()&&item["kind"]=="MENTION_SCOPE"&&item["origin"].is_object()&&item["candidate"].is_object(),"HUMAN_REVIEW_ITEM_INVALID")?;
    need(source_scope(&item["source_snapshot"])==source_scope(&p["current_snapshot"]),"HUMAN_REVIEW_SOURCE_STALE")?;
    checked_options(&item,&p["source_texts"])?;
    item["contract_version"]=json!(VERSION);
    item["id"]=json!(format!("review_{}",&hash(&json!({"origin":item["origin"],"candidate":item["candidate"],"scope":source_scope(&item["source_snapshot"])}))[..32]));
    item["status"]=json!("OPEN");
    let mut actions=vec![];
    if !a(&item["options"]).is_empty(){actions.push(json!({"id":"SELECT_OCCURRENCE","label":"采用这处原文"}));}
    actions.push(json!({"id":"EXCLUDE_CANDIDATE","label":"不采用相关候选"}));
    actions.push(json!({"id":"DEFER","label":"稍后处理"}));
    item["actions"]=json!(actions);item["semantic_support_certified"]=json!(false);
    item.as_object_mut().unwrap().remove("item_revision");
    item["item_revision"]=json!(item_hash(&item));Ok(item)
}
fn decide(p: &Value)->Result<Value>{
    let item=&p["item"];let command=&p["command"];
    need(item.is_object()&&item["contract_version"]==VERSION&&item["item_revision"]==item_hash(item),"HUMAN_REVIEW_ITEM_CHANGED")?;
    need(command["item_revision"]==item["item_revision"],"HUMAN_REVIEW_REVISION_STALE")?;
    need(source_scope(&item["source_snapshot"])==source_scope(&p["current_snapshot"]),"HUMAN_REVIEW_SOURCE_STALE")?;
    checked_options(item,&p["source_texts"])?;
    let action=s(&command["action"]);
    need(a(&item["actions"]).iter().any(|a|a["id"]==action),"HUMAN_REVIEW_ACTION_INVALID")?;
    need(p["actor"]["kind"]=="LOCAL_OPERATOR"&&!s(&p["actor"]["id"]).is_empty()&&!s(&command["request_id"]).is_empty(),"HUMAN_REVIEW_ACTOR_REQUIRED")?;
    need(command["reason"].is_null()||command["reason"].as_str().is_some_and(|s|len(s)<=4000),"HUMAN_REVIEW_REASON_INVALID")?;
    let selected=if action=="SELECT_OCCURRENCE"{
        a(&item["options"]).iter().find(|o|o["id"]==command["option_id"]).cloned().ok_or_else(||error("HUMAN_REVIEW_OPTION_INVALID","HUMAN_REVIEW_OPTION_INVALID"))?
    }else{need(command["option_id"].is_null(),"HUMAN_REVIEW_OPTION_UNEXPECTED")?;Value::Null};
    let body=json!({"contract_version":VERSION,"item_id":item["id"],"item_revision":item["item_revision"],"origin":item["origin"],"current_snapshot":p["current_snapshot"],"actor":p["actor"],"request_id":command["request_id"],"action":action,"selected_option":selected,"reason":command["reason"],"semantic_support_certified":false,"model_raw_rewritten":false,"graph_committed":false});
    let mut receipt=body.clone();receipt["decision_id"]=json!(format!("decision_{}",&hash(&body)[..32]));receipt["receipt_sha256"]=json!(hash(&receipt));Ok(receipt)
}
pub fn execute(op:&str,p:&Value)->Result<Value>{
    need(p["contract_version"]==VERSION,"HUMAN_REVIEW_VERSION_INVALID")?;
    match op {"prepare"=>prepare(p),"prepare_many"=>{
        need(p["items"].as_array().is_some_and(|v|v.len()<=256),"HUMAN_REVIEW_BATCH_INVALID")?;
        let mut items=vec![];let mut errors=vec![];
        for (index,item) in a(&p["items"]).iter().enumerate(){
            match prepare(&json!({"item":item,"current_snapshot":p["current_snapshot"],"source_texts":p["source_texts"]})){
                Ok(value)=>items.push(value),Err(e)=>errors.push(json!({"index":index,"origin":item["origin"],"error_code":e.code}))
            }
        }
        Ok(json!({"items":items,"errors":errors}))
    },"decide"=>decide(p),"validate_decision"=>{
        let receipt=&p["decision"];let mut v=receipt.clone();need(v.is_object(),"HUMAN_REVIEW_RECEIPT_INVALID")?;v.as_object_mut().unwrap().remove("receipt_sha256");
        need(receipt["receipt_sha256"]==hash(&v),"HUMAN_REVIEW_RECEIPT_CHANGED")?;
        need(source_scope(&receipt["current_snapshot"])==source_scope(&p["current_snapshot"]),"HUMAN_REVIEW_SOURCE_STALE")?;
        let expected=decide(&json!({"item":p["item"],"command":{"item_revision":receipt["item_revision"],"request_id":receipt["request_id"],"action":receipt["action"],"option_id":receipt["selected_option"]["id"],"reason":receipt["reason"]},"actor":receipt["actor"],"current_snapshot":receipt["current_snapshot"],"source_texts":p["source_texts"]}))?;
        need(expected==*receipt,"HUMAN_REVIEW_RECEIPT_CHANGED")?;Ok(receipt.clone())
    },_=>Err(error("HUMAN_REVIEW_OPERATION_UNKNOWN",op))}
}
