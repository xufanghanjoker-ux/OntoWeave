//! Provider I/O schema projection only. Never changes the authoritative local
//! schema, review judgments or gate. Only unsupported uniqueItems is omitted.
use crate::common::{canonical_hash as hash, error, s, Result};
use serde_json::{json, Value};
use std::collections::BTreeSet;
pub const VERSION: &str = "lightog-provider-schema/0.1";
pub const TARGET: &str = "QWEN_CHAT_COMPLETIONS_JSON_SCHEMA_STRICT";
fn need(ok:bool,code:&str)->Result<()>{if ok{Ok(())}else{Err(error(code,code))}}
fn fault(code:&str,path:&str,keyword:&str)->crate::common::CoreError{let mut e=error(code,code);e.details=Some(json!({"schema_path":path,"keyword":keyword}));e}
fn token(key:&str)->String{key.replace('~',"~0").replace('/',"~1")}
fn at(parent:&str,key:&str)->String{format!("{parent}/{}",token(key))}
struct Compiler{omissions:Vec<Value>,refs:Vec<(String,String)>,schema_paths:BTreeSet<String>,nodes:usize}
impl Compiler{
 fn walk(&mut self,v:&Value,path:&str,depth:usize)->Result<Value>{
  self.nodes+=1;need(depth<=128&&self.nodes<=50000,"PROVIDER_SCHEMA_RESOURCE_LIMIT")?;self.schema_paths.insert(path.to_owned());if v.is_boolean(){return Ok(v.clone());}
  let map=v.as_object().ok_or_else(||fault("PROVIDER_SCHEMA_NODE_INVALID",path,""))?;let mut out=serde_json::Map::new();
  for (key,value) in map{let field=at(path,key);match key.as_str(){
   "uniqueItems"=>{need(value.is_boolean(),"PROVIDER_SCHEMA_KEYWORD_VALUE_INVALID")?;self.omissions.push(json!({"path":field,"keyword":key,"value":value,"reason":"QWEN_UNSUPPORTED_LOCAL_VALIDATION_REQUIRED"}));},
   "properties"|"$defs"|"dependentSchemas"=>{let entries=value.as_object().ok_or_else(||fault("PROVIDER_SCHEMA_KEYWORD_VALUE_INVALID",&field,key))?;let mut projected=serde_json::Map::new();for(name,child)in entries{projected.insert(name.clone(),self.walk(child,&at(&field,name),depth+1)?);}out.insert(key.clone(),Value::Object(projected));},
   "items"|"additionalProperties"|"unevaluatedProperties"|"unevaluatedItems"|"not"|"if"|"then"|"else"=>{out.insert(key.clone(),self.walk(value,&field,depth+1)?);},
   "allOf"|"anyOf"|"oneOf"|"prefixItems"=>{let entries=value.as_array().ok_or_else(||fault("PROVIDER_SCHEMA_KEYWORD_VALUE_INVALID",&field,key))?;if key!="prefixItems"{need(!entries.is_empty(),"PROVIDER_SCHEMA_KEYWORD_VALUE_INVALID")?;}let mut projected=vec![];for(index,child)in entries.iter().enumerate(){projected.push(self.walk(child,&at(&field,&index.to_string()),depth+1)?);}out.insert(key.clone(),json!(projected));},
   // These values are instance data or semantic hints, never schema nodes.
   "enum"=>{need(value.as_array().is_some_and(|a|!a.is_empty()),"PROVIDER_SCHEMA_KEYWORD_VALUE_INVALID")?;out.insert(key.clone(),value.clone());},
   "const"|"default"=>{out.insert(key.clone(),value.clone());},
   "examples"=>{need(value.is_array(),"PROVIDER_SCHEMA_KEYWORD_VALUE_INVALID")?;out.insert(key.clone(),value.clone());},
   "required"=>{string_set(value,&field)?;out.insert(key.clone(),value.clone());},
   "dependentRequired"=>{let entries=value.as_object().ok_or_else(||fault("PROVIDER_SCHEMA_KEYWORD_VALUE_INVALID",&field,key))?;for(name,child)in entries{string_set(child,&at(&field,name))?;}out.insert(key.clone(),value.clone());},
   "type"=>{let allowed=["string","number","integer","boolean","null","array","object"];if let Some(t)=value.as_str(){need(allowed.contains(&t),"PROVIDER_SCHEMA_TYPE_INVALID")?;}else{string_set(value,&field)?;need(value.as_array().is_some_and(|a|!a.is_empty()&&a.iter().all(|x|allowed.contains(&s(x)))),"PROVIDER_SCHEMA_TYPE_INVALID")?;}out.insert(key.clone(),value.clone());},
   "$ref"=>{let reference=value.as_str().ok_or_else(||fault("PROVIDER_SCHEMA_REF_INVALID",&field,key))?;need((reference=="#"||reference.starts_with("#/"))&&!reference.contains('%'),"PROVIDER_SCHEMA_EXTERNAL_OR_UNSUPPORTED_REF")?;self.refs.push((field,reference.to_owned()));out.insert(key.clone(),value.clone());},
   "minLength"|"maxLength"|"minItems"|"maxItems"|"minProperties"|"maxProperties"=>{need(value.as_u64().is_some_and(|n|n<=9007199254740991),"PROVIDER_SCHEMA_KEYWORD_VALUE_INVALID")?;out.insert(key.clone(),value.clone());},
   "minimum"|"maximum"|"exclusiveMinimum"|"exclusiveMaximum"=>{need(value.as_f64().is_some_and(|n|n.is_finite()),"PROVIDER_SCHEMA_KEYWORD_VALUE_INVALID")?;out.insert(key.clone(),value.clone());},
   "pattern"|"format"|"contentMediaType"|"contentEncoding"|"title"|"description"|"$schema"|"$id"|"$comment"=>{need(value.is_string(),"PROVIDER_SCHEMA_KEYWORD_VALUE_INVALID")?;out.insert(key.clone(),value.clone());},
   "deprecated"|"readOnly"|"writeOnly"=>{need(value.is_boolean(),"PROVIDER_SCHEMA_KEYWORD_VALUE_INVALID")?;out.insert(key.clone(),value.clone());},
   "multipleOf"|"contains"|"minContains"|"maxContains"|"additionalItems"|"patternProperties"|"propertyNames"=>return Err(fault("PROVIDER_SCHEMA_UNSUPPORTED_KEYWORD",&field,key)),
   _=>return Err(fault("PROVIDER_SCHEMA_UNKNOWN_KEYWORD",&field,key)),
  }}Ok(Value::Object(out))
 }
}
fn string_set(v:&Value,path:&str)->Result<()>{let a=v.as_array().ok_or_else(||fault("PROVIDER_SCHEMA_KEYWORD_VALUE_INVALID",path,""))?;let mut seen=BTreeSet::new();for item in a{need(item.is_string()&&seen.insert(s(item)),"PROVIDER_SCHEMA_KEYWORD_VALUE_INVALID")?;}Ok(())}
pub fn compile_qwen(p:&Value)->Result<Value>{
 let m=p.as_object().ok_or_else(||error("PROVIDER_SCHEMA_INPUT_INVALID","PROVIDER_SCHEMA_INPUT_INVALID"))?;need(m.len()==3&&["contract_version","name","schema"].iter().all(|k|m.contains_key(*k)),"PROVIDER_SCHEMA_INPUT_INVALID")?;need(p["contract_version"]==VERSION,"PROVIDER_SCHEMA_VERSION_UNSUPPORTED")?;let name=p["name"].as_str().ok_or_else(||error("PROVIDER_SCHEMA_NAME_INVALID","PROVIDER_SCHEMA_NAME_INVALID"))?;need(!name.is_empty()&&name.len()<=64&&name.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'_'||c==b'-'),"PROVIDER_SCHEMA_NAME_INVALID")?;
 let original=&p["schema"];need(original.is_object(),"PROVIDER_SCHEMA_ROOT_OBJECT_REQUIRED")?;need(serde_json::to_vec(original).map_err(|_|error("PROVIDER_SCHEMA_INPUT_INVALID","PROVIDER_SCHEMA_INPUT_INVALID"))?.len()<=2*1024*1024,"PROVIDER_SCHEMA_RESOURCE_LIMIT")?;let mut compiler=Compiler{omissions:vec![],refs:vec![],schema_paths:BTreeSet::new(),nodes:0};let provider=compiler.walk(original,"",0)?;
 for(path,reference)in &compiler.refs{let pointer=&reference[1..];need(compiler.schema_paths.contains(pointer)&&original.pointer(pointer).is_some(),"PROVIDER_SCHEMA_UNRESOLVED_OR_NONSCHEMA_REF")?;let _=path;}
 compiler.omissions.sort_by(|a,b|s(&a["path"]).cmp(s(&b["path"])));let format=json!({"type":"json_schema","json_schema":{"name":name,"strict":true,"schema":provider}});let mut receipt=json!({"contract_version":VERSION,"target":TARGET,"response_format":format,"full_schema_sha256":hash(original),"provider_schema_sha256":hash(&provider),"response_format_sha256":hash(&format),"omission_paths":compiler.omissions.iter().map(|o|o["path"].clone()).collect::<Vec<_>>(),"omissions":compiler.omissions,"local_validation_required":true,"local_validation_performed":false,"local_enforcement":"ORIGINAL_FULL_SCHEMA_AND_EXISTING_RUST_GATE_REMAIN_AUTHORITATIVE; COMPILER_DOES_NOT_VALIDATE_RESPONSES","fallback_performed":false,"model_called":false,"publication_performed":false,"semantic_support_certified":false,"provider_documentation":"https://help.aliyun.com/en/model-studio/qwen-structured-output","provider_caveat":"Provider schema syntax and decoder behavior do not prove local uniqueness, exact-one semantics, source entailment or truth."});receipt["receipt_sha256"]=json!(hash(&receipt));Ok(receipt)
}
pub fn execute(op:&str,p:&Value)->Result<Value>{match op{"compile_qwen"=>compile_qwen(p),_=>Err(error("PROVIDER_SCHEMA_OPERATION_UNKNOWN","PROVIDER_SCHEMA_OPERATION_UNKNOWN"))}}
