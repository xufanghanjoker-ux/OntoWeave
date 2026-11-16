//! Frozen dependency/publication rules over trusted service snapshots. No storage or clock access.
use crate::common::{a, ensure, error, fail, locale_cmp, s, sha, truthy, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
fn strv(v: &Value) -> String {
    s(v).to_string()
}
fn arr(v: Vec<Value>) -> Value {
    Value::Array(v)
}
fn unique(xs: impl IntoIterator<Item = Value>) -> Vec<Value> {
    let mut out = vec![];
    for x in xs {
        if !out.contains(&x) {
            out.push(x);
        }
    }
    out
}
fn js_str(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::String(x) => x.clone(),
        Value::Array(xs) => xs
            .iter()
            .map(|x| {
                if x.is_null() {
                    String::new()
                } else {
                    js_str(x)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
        x => crate::common::js_stringify(x),
    }
}
fn sorted_js(mut xs: Vec<Value>) -> Vec<Value> {
    xs.sort_by(|x, y| js_str(x).encode_utf16().cmp(js_str(y).encode_utf16()));
    xs
}
fn field_copy(dst: &mut Value, src: &Value, keys: &[&str]) {
    for k in keys {
        if let Some(v) = src.get(*k) {
            dst[*k] = v.clone();
        }
    }
}
fn find_by<'a>(rows: &'a Value, key: &str, id: &Value) -> Option<&'a Value> {
    a(rows).iter().find(|x| &x[key] == id)
}
fn exec_schema(schema: &Value, input: &Value) -> Result<Value> {
    Ok(
        crate::model::execute("validate_schema", &json!({"schema":schema,"input":input}))?
            ["schema"]
            .clone(),
    )
}
fn plan_issues(schema: &Value, input: &Value) -> Result<Value> {
    crate::model::execute("query_plan_issues", &json!({"schema":schema,"input":input}))
}
fn extension(schema: &Value, previous: &Value, resolvable: &Value) -> Result<Value> {
    crate::learning::execute(
        "validate_extension",
        &json!({"schema":schema,"previous":previous,"options":{"resolvableIds":resolvable}}),
    )
}
fn support_valid(claim: &Value, sources: &Value) -> Result<bool> {
    Ok(
        crate::structure::execute("support_valid", &json!({"claim":claim,"sources":sources}))?
            == true,
    )
}

pub fn source_key(source: &Value) -> String {
    let doc = source["parsing"]["document_id"].clone();
    let doc = if truthy(&doc) { doc } else { Value::Null };
    format!(
        "src_{}",
        &sha(&json!([doc, source["title"], sha(&source["content"])]))[..32]
    )
}
fn no(reason: &str) -> Value {
    json!({"eligible":false,"reason":reason})
}
fn root(parent: &[usize], i: usize) -> usize {
    if parent[i] == i {
        i
    } else {
        root(parent, parent[i])
    }
}
fn join(parent: &mut [usize], predicates: &[String], items: Vec<String>) {
    let mut unique = vec![];
    for x in items {
        if predicates.contains(&x) && !unique.contains(&x) {
            unique.push(x);
        }
    }
    if unique.is_empty() {
        return;
    }
    let first = predicates.iter().position(|x| x == &unique[0]).unwrap();
    for p in unique.iter().skip(1) {
        let i = predicates.iter().position(|x| x == p).unwrap();
        let dest = root(parent, first);
        let from = root(parent, i);
        parent[from] = dest;
    }
}
fn signature(result: &Value, p: &str) -> String {
    let predicate = a(&result["schema"]["predicates"])
        .iter()
        .find(|x| x["id"] == p)
        .cloned()
        .unwrap_or(Value::Null);
    let claims = sorted_js(
        a(&result["claims"])
            .iter()
            .filter(|c| c["predicate_id"] == p)
            .map(|c| json!([c["id"], sha(c)]))
            .collect(),
    );
    let plans: Vec<Value> = a(&result["schema"]["cq_plans"])
        .iter()
        .filter(|x| x["predicate_id"] == p)
        .cloned()
        .collect();
    sha(&json!([predicate, claims, plans]))
}
pub fn plan_component_publication(base: &Value, job: &Value, options: &Value) -> Result<Value> {
    if base.is_null()
        || base["status"] != "READY"
        || job["status"] != "REVIEW_REQUIRED"
        || job["result"]["review_stage"] != "claims_review"
    {
        return Ok(no("NO_PUBLISHED_BASE_OR_CLAIMS_REVIEW"));
    }
    if sha(&json!([
        base["input"]["definitions"],
        base["input"]["as_of"]
    ])) != sha(&json!([job["input"]["definitions"], job["input"]["as_of"]]))
    {
        return Ok(no("GLOBAL_SEMANTICS_CHANGED"));
    }
    let mut schema = job["result"]["schema"].clone();
    let prior = &base["result"]["schema"];
    let fields: [(&str, &[&str]); 4] = [
        ("entity_types", &["id", "label"]),
        ("entities", &["id", "name", "type"]),
        (
            "predicates",
            &["id", "label", "value_type", "unit", "cardinality"],
        ),
        (
            "cq_plans",
            &[
                "cq_id",
                "template",
                "subject_id",
                "subject_ids",
                "predicate_id",
                "object_value",
                "reason",
            ],
        ),
    ];
    let known = ["entity_types", "entities", "predicates", "cq_plans"];
    if schema
        .as_object()
        .is_none_or(|m| m.keys().any(|k| !known.contains(&k.as_str())))
        || fields.iter().any(|(key, allowed)| {
            a(&schema[*key]).iter().any(|row| {
                row.as_object()
                    .is_some_and(|m| m.keys().any(|k| !allowed.contains(&k.as_str())))
            })
        })
    {
        return Ok(no("UNSUPPORTED_DEPENDENCY_FIELDS"));
    }
    let resolvable = arr(a(&prior["cq_plans"])
        .iter()
        .filter(|p| p["template"] == "UNKNOWN")
        .map(|p| p["cq_id"].clone())
        .collect());
    if exec_schema(&schema, &job["input"]).is_err()
        || extension(&schema, prior, &resolvable).is_err()
    {
        return Ok(no("NON_ADDITIVE_ONTOLOGY"));
    }
    let predicates: Vec<String> = a(&schema["predicates"])
        .iter()
        .map(|p| strv(&p["id"]))
        .collect();
    let mut parent: Vec<usize> = (0..predicates.len()).collect();
    let entities = a(&schema["entities"]).to_vec();
    let types = a(&schema["entity_types"]).to_vec();
    let mut entity_refs: HashMap<String, Vec<String>> =
        entities.iter().map(|e| (strv(&e["id"]), vec![])).collect();
    let mut add_ref = |id: &Value, p: &Value| {
        let pid = strv(p);
        if predicates.contains(&pid) {
            if let Some(xs) = entity_refs.get_mut(s(id)) {
                if !xs.contains(&pid) {
                    xs.push(pid);
                }
            }
        }
    };
    for c in a(&job["result"]["claims"]) {
        add_ref(&c["subject_id"], &c["predicate_id"]);
        if find_by(&schema["predicates"], "id", &c["predicate_id"])
            .is_some_and(|p| p["value_type"] == "ENTITY")
        {
            add_ref(&c["value"], &c["predicate_id"]);
        }
    }
    for p in a(&schema["cq_plans"]) {
        add_ref(&p["subject_id"], &p["predicate_id"]);
        for id in a(&p["subject_ids"]) {
            add_ref(id, &p["predicate_id"]);
        }
        if find_by(&schema["predicates"], "id", &p["predicate_id"])
            .is_some_and(|p| p["value_type"] == "ENTITY")
        {
            add_ref(&p["object_value"], &p["predicate_id"]);
        }
    }
    for e in &entities {
        if find_by(&prior["entities"], "id", &e["id"]).is_none() {
            join(
                &mut parent,
                &predicates,
                entity_refs.get(s(&e["id"])).cloned().unwrap_or_default(),
            );
        }
    }
    for t in &types {
        if find_by(&prior["entity_types"], "id", &t["id"]).is_none() {
            let refs = entities
                .iter()
                .filter(|e| e["type"] == t["id"])
                .flat_map(|e| entity_refs.get(s(&e["id"])).cloned().unwrap_or_default())
                .collect();
            join(&mut parent, &predicates, refs);
        }
    }
    let claims = a(&job["result"]["claims"]);
    for (i, x) in claims.iter().enumerate() {
        for y in claims.iter().skip(i + 1) {
            if x["source_id"] == y["source_id"]
                && x["start"].as_f64().unwrap_or(f64::NAN) < y["end"].as_f64().unwrap_or(f64::NAN)
                && y["start"].as_f64().unwrap_or(f64::NAN) < x["end"].as_f64().unwrap_or(f64::NAN)
            {
                join(
                    &mut parent,
                    &predicates,
                    vec![strv(&x["predicate_id"]), strv(&y["predicate_id"])],
                );
            }
        }
    }
    let issues = a(&job["result"]["gate"]["issues"]);
    if issues.is_empty() && options["allowNoIssues"] != true {
        return Ok(no("NO_BOUND_ISSUES"));
    }
    let mut issue_refs: Vec<Vec<String>> = vec![];
    let re_claim = regex::Regex::new(r"^/claims/(\d+)(?:/|$)").unwrap();
    let re_pred = regex::Regex::new(r"^/schema/predicates/(\d+)(?:/|$)").unwrap();
    let re_plan = regex::Regex::new(r"^/schema/cq_plans/(\d+)(?:/|$)").unwrap();
    let re_entity = regex::Regex::new(r"^/schema/entities/(\d+)(?:/|$)").unwrap();
    for issue in issues {
        let target = s(&issue["target"]);
        let mut refs = vec![];
        if let Some(m) = re_claim.captures(target) {
            if let Some(c) = m[1].parse::<usize>().ok().and_then(|i| claims.get(i)) {
                refs.push(strv(&c["predicate_id"]));
            }
        } else if target == "/claims" && !a(&issue["evidence_ids"]).is_empty() {
            refs = claims
                .iter()
                .filter(|c| a(&issue["evidence_ids"]).contains(&c["evidence_id"]))
                .map(|c| strv(&c["predicate_id"]))
                .collect();
        } else if let Some(m) = re_pred.captures(target) {
            refs.push(
                m[1].parse::<usize>()
                    .ok()
                    .and_then(|i| a(&schema["predicates"]).get(i))
                    .map(|x| strv(&x["id"]))
                    .unwrap_or_default(),
            );
        } else if let Some(m) = re_plan.captures(target) {
            refs.push(
                m[1].parse::<usize>()
                    .ok()
                    .and_then(|i| a(&schema["cq_plans"]).get(i))
                    .map(|x| strv(&x["predicate_id"]))
                    .unwrap_or_default(),
            );
        } else if let Some(m) = re_entity.captures(target) {
            refs = m[1]
                .parse::<usize>()
                .ok()
                .and_then(|i| entities.get(i))
                .and_then(|e| entity_refs.get(s(&e["id"])))
                .cloned()
                .unwrap_or_default();
        } else {
            return Ok(no("UNBOUNDED_ISSUE"));
        }
        if refs.is_empty() || refs.iter().any(|p| !predicates.contains(p)) {
            return Ok(no("UNBOUND_DEPENDENCY"));
        }
        for cqid in a(&issue["cq_ids"]) {
            let Some(p) = find_by(&schema["cq_plans"], "cq_id", cqid) else {
                return Ok(no("UNKNOWN_CQ_DEPENDENCY"));
            };
            if truthy(&p["predicate_id"]) {
                refs.push(strv(&p["predicate_id"]));
            }
        }
        join(&mut parent, &predicates, refs.clone());
        issue_refs.push(refs);
    }
    let mut blocked = vec![];
    for refs in &issue_refs {
        for p in refs {
            if let Some(i) = predicates.iter().position(|x| x == p) {
                let ri = root(&parent, i);
                if !blocked.contains(&ri) {
                    blocked.push(ri);
                }
            }
        }
    }
    let held: Vec<String> = predicates
        .iter()
        .enumerate()
        .filter(|(i, _)| blocked.contains(&root(&parent, *i)))
        .map(|(_, p)| p.clone())
        .collect();
    let safe: Vec<String> = predicates
        .iter()
        .enumerate()
        .filter(|(i, _)| !blocked.contains(&root(&parent, *i)))
        .map(|(_, p)| p.clone())
        .collect();
    if options["allowUnchanged"] != true
        && !safe
            .iter()
            .any(|p| signature(&base["result"], p) != signature(&job["result"], p))
    {
        let mut result = no("NO_INDEPENDENT_CHANGE");
        result["hold"] = json!({"origin_task_id":job["id"],"held_predicate_ids":held,"held_cq_ids":a(&schema["cq_plans"]).iter().filter(|p|held.contains(&strv(&p["predicate_id"]))).map(|p|p["cq_id"].clone()).collect::<Vec<_>>()});
        return Ok(result);
    }
    let retained: Vec<Value> = a(&schema["predicates"])
        .iter()
        .filter(|p| {
            safe.contains(&strv(&p["id"]))
                || find_by(&prior["predicates"], "id", &p["id"]).is_some()
        })
        .cloned()
        .collect();
    let held_cqs: Vec<Value> = a(&schema["cq_plans"])
        .iter()
        .filter(|p| held.contains(&strv(&p["predicate_id"])))
        .map(|p| p["cq_id"].clone())
        .collect();
    schema["predicates"] = arr(retained);
    schema["cq_plans"]=arr(a(&schema["cq_plans"]).iter().map(|p|if held_cqs.contains(&p["cq_id"])&&!a(&prior["cq_plans"]).iter().any(|old|old["cq_id"]==p["cq_id"]&&old["template"]!="UNKNOWN"){json!({"cq_id":p["cq_id"],"template":"UNKNOWN","subject_id":null,"predicate_id":null,"object_value":null,"reason":"相关依赖正在核对，尚未发布。"})}else{p.clone()}).collect());
    let result_claims: Vec<Value> = claims
        .iter()
        .filter(|c| safe.contains(&strv(&c["predicate_id"])))
        .cloned()
        .collect();
    let mut needed: Vec<Value> = a(&prior["entities"])
        .iter()
        .map(|e| e["id"].clone())
        .collect();
    for c in &result_claims {
        needed.push(c["subject_id"].clone());
        if find_by(&schema["predicates"], "id", &c["predicate_id"])
            .is_some_and(|p| p["value_type"] == "ENTITY")
        {
            needed.push(c["value"].clone());
        }
    }
    for p in a(&schema["cq_plans"]) {
        needed.push(p["subject_id"].clone());
        needed.extend(a(&p["subject_ids"]).to_vec());
        if find_by(&schema["predicates"], "id", &p["predicate_id"])
            .is_some_and(|p| p["value_type"] == "ENTITY")
        {
            needed.push(p["object_value"].clone());
        }
    }
    schema["entities"] = arr(entities
        .into_iter()
        .filter(|e| needed.contains(&e["id"]))
        .collect());
    let needed_types: Vec<Value> = a(&prior["entity_types"])
        .iter()
        .map(|t| t["id"].clone())
        .chain(a(&schema["entities"]).iter().map(|e| e["type"].clone()))
        .collect();
    schema["entity_types"] = arr(types
        .into_iter()
        .filter(|t| needed_types.contains(&t["id"]))
        .collect());
    if exec_schema(&schema, &job["input"]).is_err() {
        return Ok(no("INCOMPLETE_DEPENDENCIES"));
    }
    match plan_issues(&schema, &job["input"]) {
        Ok(v) if !a(&v).is_empty() => return Ok(no("INCOMPLETE_QUERY_DEPENDENCIES")),
        Err(_) => return Ok(no("INCOMPLETE_DEPENDENCIES")),
        _ => {}
    }
    match crate::evidence::execute(
        "validate_claims",
        &json!({"raw":{"claims":result_claims},"schema":schema,"input":job["input"],"options":{"collectErrors":true}}),
    ) {
        Ok(v) => {
            if !a(&v["issues"]).is_empty() || a(&v["claims"]).len() != result_claims.len() {
                return Ok(no("INVALID_COMPONENT_EVIDENCE"));
            }
        }
        Err(_) => return Ok(no("INCOMPLETE_DEPENDENCIES")),
    }
    let roots = unique((0..predicates.len()).map(|i| json!(root(&parent, i))));
    let components:Vec<Value>=roots.iter().map(|ri|{let ri=ri.as_u64().unwrap()as usize;json!({"id":format!("component_{}",&sha(&json!([job["id"],predicates[ri]]))[..24]),"predicate_ids":predicates.iter().enumerate().filter(|(i,_)|root(&parent,*i)==ri).map(|(_,p)|p.clone()).collect::<Vec<_>>(),"issue_indexes":issue_refs.iter().enumerate().filter(|(_,refs)|refs.iter().any(|p|predicates.iter().position(|x|x==p).is_some_and(|i|root(&parent,i)==ri))).map(|(i,_)|i).collect::<Vec<_>>(),"status":if blocked.contains(&ri){"HELD"}else{"REVIEW_REQUIRED"}})}).collect();
    let manifest = json!({"version":"dependency_components_v1","origin_task_id":job["id"],"base_task_id":base["id"],"source_hash":sha(&job["input"]["sources"]),"origin_result_hash":sha(&job["result"]),"safe_predicate_ids":safe,"held_predicate_ids":held,"held_cq_ids":held_cqs,"components":components});
    Ok(
        json!({"eligible":true,"candidate":{"schema":schema,"claims":result_claims},"manifest":manifest,"hash":sha(&manifest)}),
    )
}

#[derive(Clone)]
struct Snapshot {
    tasks: Vec<Value>,
    records: Vec<Value>,
    writes: Vec<Value>,
}
impl Snapshot {
    fn new(v: &Value) -> Self {
        Self {
            tasks: a(&v["tasks"]).to_vec(),
            records: a(&v["records"]).to_vec(),
            writes: vec![],
        }
    }
    fn record(&self, kind: &str, id: &Value) -> Value {
        self.records
            .iter()
            .find(|r| r["kind"] == kind && &r["id"] == id)
            .map(|r| r.get("value").unwrap_or(&r["payload"]).clone())
            .unwrap_or(Value::Null)
    }
    fn list(&self, kind: &str) -> Vec<Value> {
        self.records
            .iter()
            .filter(|r| r["kind"] == kind)
            .map(|r| r.get("value").unwrap_or(&r["payload"]).clone())
            .collect()
    }
    fn task(&self, id: &Value) -> Value {
        self.tasks
            .iter()
            .find(|t| &t["id"] == id)
            .cloned()
            .unwrap_or(Value::Null)
    }
    fn put(&mut self, kind: &str, id: Value, value: Value) {
        let row = json!({"kind":kind,"id":id,"value":value});
        if let Some(i) = self
            .records
            .iter()
            .position(|r| r["kind"] == kind && r["id"] == id)
        {
            self.records[i] = row;
        } else {
            self.records.push(row);
        }
        self.writes
            .push(json!({"op":"put_record","kind":kind,"id":id,"value":value}));
    }
    fn save(&mut self, task: &Value) {
        if let Some(i) = self.tasks.iter().position(|t| t["id"] == task["id"]) {
            self.tasks[i] = task.clone();
        } else {
            self.tasks.push(task.clone());
        }
        self.writes.push(json!({"op":"save_task","task":task}));
    }
    fn active(&self, id: &Value) -> bool {
        !["TRASHED", "PURGING", "PURGED"]
            .contains(&s(&self.record("library_lifecycle", id)["status"]))
    }
    fn assert_active(&self, id: &Value) -> Result<()> {
        if !self.active(id) {
            return Err(error(
                "LIBRARY_UNAVAILABLE",
                "知识库已移入回收站或删除，请先恢复。",
            ));
        }
        Ok(())
    }
    fn pending(&self, id: &Value, epoch: &Value) -> Vec<Value> {
        let mut out = vec![];
        for kind in ["component_release", "component_hold"] {
            for mut r in self.list(kind) {
                if &r["base_id"] != id || &r["source_epoch"] != epoch || r["status"] == "RESOLVED" {
                    continue;
                }
                for (cur, field) in [
                    ("current_held_predicate_ids", "held_predicate_ids"),
                    ("current_held_cq_ids", "held_cq_ids"),
                ] {
                    if !r[cur].is_null() {
                        r["manifest"][field] = r[cur].clone();
                    }
                }
                out.push(r);
            }
        }
        out
    }
    fn review_hash(&self, id: &Value, epoch: &Value) -> String {
        let rows = self
            .pending(id, epoch)
            .iter()
            .map(|r| {
                json!([
                    r["id"],
                    r["manifest"]["held_predicate_ids"],
                    r["manifest"]["held_cq_ids"],
                    if truthy(&r["additional_held_predicate_ids"]) {
                        r["additional_held_predicate_ids"].clone()
                    } else {
                        json!([])
                    },
                    if truthy(&r["additional_held_cq_ids"]) {
                        r["additional_held_cq_ids"].clone()
                    } else {
                        json!([])
                    }
                ])
            })
            .collect();
        sha(&arr(sorted_js(rows)))
    }
}
fn now(p: &Value) -> Result<Value> {
    ensure(p["now"].as_str().is_some(), "可信服务适配器必须提供now时间")?;
    Ok(p["now"].clone())
}
fn write_result(st: &Snapshot, result: Value) -> Value {
    json!({"result":result,"writes":st.writes})
}
pub fn knowledge_bases(tasks: &[Value]) -> Result<Value> {
    let visible: Vec<&Value> = tasks
        .iter()
        .filter(|t| !truthy(&t["benchmark_run_id"]))
        .collect();
    let mut by_id = HashMap::new();
    for (i, t) in visible.iter().enumerate() {
        by_id.insert(strv(&t["id"]), i);
    }
    let mut groups: Vec<(Value, Vec<Value>)> = vec![];
    for task in &visible {
        let mut current = *task;
        let mut seen = vec![];
        loop {
            let parent = &current["revision"]["parent_id"];
            if !truthy(parent) {
                break;
            }
            let Some(i) = by_id.get(s(parent)) else {
                break;
            };
            if seen.contains(&current["id"]) {
                return Err(error(
                    "CORE_LEGACY_ERROR",
                    "版本关系存在循环，不能自动合并知识库",
                ));
            }
            seen.push(current["id"].clone());
            current = visible[*i];
        }
        let id = format!("kb_{}", s(&current["id"]));
        let pos = groups
            .iter()
            .position(|(g, _)| g["id"] == id)
            .unwrap_or_else(|| {
                groups.push((
                    json!({"id":id,"root_task_id":current["id"],"name":current["input"]["name"]}),
                    vec![],
                ));
                groups.len() - 1
            });
        groups[pos].1.push((*task).clone());
    }
    let mut out = vec![];
    for (g, mut rows) in groups {
        rows.sort_by(|x, y| {
            locale_cmp(s(&x["created_at"]), s(&y["created_at"]))
                .then_with(|| locale_cmp(s(&x["id"]), s(&y["id"])))
        });
        let latest = rows.last().ok_or_else(|| fail("版本尚未保存"))?;
        let ready = rows
            .iter()
            .rev()
            .find(|t| t["status"] == "READY" && t["result"]["status"] == "READY");
        let selected = ready.unwrap_or(latest);
        let root = visible[*by_id
            .get(s(&g["root_task_id"]))
            .ok_or_else(|| fail("版本尚未保存"))?];
        let mut v = json!({"id":g["id"],"name":g["name"],"root_task_id":g["root_task_id"],"current_task_id":ready.map(|t|t["id"].clone()).unwrap_or(Value::Null),"latest_task_id":latest["id"],"open_task_id":selected["id"],"status":if ready.is_some(){json!("READY")}else{latest["status"].clone()},"latest_status":latest["status"],"version_count":rows.len(),"task_ids":rows.iter().map(|t|t["id"].clone()).collect::<Vec<_>>(),"source_count":a(&selected["input"]["sources"]).len(),"cq_count":a(&root["input"]["cqs"]).len(),"learned_question_count":a(&selected["input"]["cqs"]).len().saturating_sub(a(&root["input"]["cqs"]).len()),"claim_count":a(&selected["result"]["claims"]).len(),"lineage_incomplete":truthy(&root["revision"]["parent_id"])});
        if let Some(vt) = latest.get("created_at") {
            v["updated_at"] = vt.clone();
        }
        out.push(v);
    }
    out.sort_by(|x, y| {
        locale_cmp(s(&y["updated_at"]), s(&x["updated_at"]))
            .then_with(|| locale_cmp(s(&x["id"]), s(&y["id"])))
    });
    Ok(arr(out))
}
fn begin(st: &mut Snapshot, job: &Value) -> Result<Value> {
    if !truthy(&job["internal_scope"]) || truthy(&job["benchmark_run_id"]) {
        return Ok(Value::Null);
    }
    let old = st.record("library_candidate", &job["id"]);
    if truthy(&old) {
        st.assert_active(&old["base_id"])?;
        return Ok(old);
    }
    let bases = knowledge_bases(&st.tasks)?;
    let base = a(&bases)
        .iter()
        .find(|b| a(&b["task_ids"]).contains(&job["id"]))
        .cloned()
        .ok_or_else(|| fail("版本尚未保存"))?;
    st.assert_active(&base["id"])?;
    let mut state = st.record("library_state", &base["id"]);
    if !truthy(&state) {
        state =
            json!({"id":base["id"],"head_task_id":null,"revision":0,"source_epoch":0,"sources":{}});
        for source in a(&job["input"]["sources"]) {
            let key = source_key(source);
            state["sources"][&key] = json!({"key":key,"title":source["title"],"sha256":sha(&source["content"]),"active":true});
        }
        st.put("library_state", base["id"].clone(), state.clone());
    }
    if truthy(&job["revision"]["parent_id"]) {
        let parent = st.record("library_candidate", &job["revision"]["parent_id"]);
        let intended = if truthy(&job["component_base_task_id"]) {
            job["component_base_task_id"].clone()
        } else if truthy(&job["learning"]["base_task_id"]) {
            job["learning"]["base_task_id"].clone()
        } else if parent["status"] == "PUBLISHED" {
            parent["task_id"].clone()
        } else {
            parent["expected_head"].clone()
        };
        if intended != state["head_task_id"] {
            return Err(error(
                "PUBLICATION_STALE",
                "候选基于旧知识版本，需重新校验，不能以当前版本身份发布",
            ));
        }
    }
    let c = json!({"task_id":job["id"],"base_id":base["id"],"expected_head":state["head_task_id"],"expected_revision":state["revision"],"expected_source_epoch":state["source_epoch"],"input_hash":sha(&job["input"]),"status":"CANDIDATE"});
    st.put("library_candidate", job["id"].clone(), c.clone());
    Ok(c)
}
fn publish(st: &mut Snapshot, job: &Value, p: &Value) -> Result<Value> {
    let c = st.record("library_candidate", &job["id"]);
    if !truthy(&c) {
        return Ok(Value::Null);
    }
    let mut state = st.record("library_state", &c["base_id"]);
    st.assert_active(&c["base_id"])?;
    if c["status"] == "PUBLISHED" {
        ensure(
            c["result_hash"] == sha(&job["result"]),
            "已发布结果不可改写",
        )?;
        return Ok(c);
    }
    if c["status"] != "CANDIDATE" {
        return Err(error("PUBLICATION_REJECTED", "候选已停止或失效"));
    }
    if truthy(&job["cancel_requested"]) {
        return Err(error("PUBLICATION_CANCELLED", "已停止的候选不发布"));
    }
    ensure(
        job["status"] == "READY"
            && job["result"]["status"] == "READY"
            && job["result"]["gate"]["action"] == "ACCEPT_CANDIDATE",
        "候选尚未通过全部构建门禁",
    )?;
    ensure(
        a(&plan_issues(&job["result"]["schema"], &job["input"])?).is_empty(),
        "查询计划仍存在未解决约束",
    )?;
    ensure(c["input_hash"] == sha(&job["input"]), "候选输入已变化")?;
    if state["source_epoch"] != c["expected_source_epoch"]
        || a(&job["input"]["sources"])
            .iter()
            .any(|s| !truthy(&state["sources"][source_key(s)]["active"]))
    {
        return Err(error(
            "SOURCE_REVOKED",
            "资料范围已变化，候选需重新验证，未发布",
        ));
    }
    if state["head_task_id"] != c["expected_head"] || state["revision"] != c["expected_revision"] {
        return Err(error(
            "PUBLICATION_STALE",
            "已有新版本发布，候选需重新校验，未覆盖当前版本",
        ));
    }
    for claim in a(&job["result"]["claims"]) {
        ensure(
            support_valid(claim, &job["input"]["sources"])?,
            "候选多段证据失效",
        )?;
        let source = find_by(&job["input"]["sources"], "id", &claim["source_id"]);
        let valid = source.is_some_and(|source| {
            sha(&source["content"]) == source["sha256"]
                && crate::common::slice16(
                    s(&source["content"]),
                    claim["start"].as_u64().unwrap_or(0) as usize,
                    claim["end"].as_u64().unwrap_or(0) as usize,
                ) == s(&claim["quote"])
        });
        ensure(valid, "候选证据无效")?;
    }
    let mut published = c.clone();
    published["status"] = json!("PUBLISHED");
    published["result_hash"] = json!(sha(&job["result"]));
    published["published_at"] = now(p)?;
    st.save(job);
    st.put("library_candidate", job["id"].clone(), published.clone());
    state["head_task_id"] = job["id"].clone();
    state["revision"] = json!(state["revision"].as_i64().unwrap_or(0) + 1);
    st.put("library_state", state["id"].clone(), state);
    Ok(published)
}
fn change_source(st: &mut Snapshot, op: &str, p: &Value) -> Result<Value> {
    let base = &p["base_id"];
    st.assert_active(base)?;
    let mut state = st.record("library_state", base);
    let key = s(&p["key"]);
    if op == "revoke" {
        ensure(truthy(&state), "知识库尚未启用来源管理")?;
        ensure(truthy(&state["sources"][key]), "来源不属于此知识库")?;
        if !truthy(&state["sources"][key]["active"]) {
            return Ok(state);
        }
        let epoch = state["source_epoch"].as_i64().unwrap_or(0) + 1;
        let at = now(p)?;
        state["source_epoch"] = json!(epoch);
        state["sources"][key]["active"] = json!(false);
        state["sources"][key]["revoked_at"] = at.clone();
        st.put(
            "source_change",
            json!(sha(&json!([base, epoch]))),
            json!({"base_id":base,"key":key,"source_epoch":epoch,"action":"REVOKED","at":at}),
        );
        st.put("library_state", state["id"].clone(), state.clone());
        return Ok(state);
    }
    let source = &p["source"];
    let next_key = source_key(source);
    if op == "add_source" {
        ensure(truthy(&state), "知识库尚未启用来源管理")?;
        if truthy(&state["sources"][&next_key]["active"]) {
            return Ok(json!({"state":state,"added":false}));
        }
        ensure(
            sha(&source["content"]) == source["sha256"],
            "新资料哈希无效",
        )?;
        let existed = truthy(&state["sources"][&next_key]);
        st.put(
            "library_source",
            json!(sha(&json!([base, next_key]))),
            json!({"base_id":base,"key":next_key,"source":source}),
        );
        let epoch = state["source_epoch"].as_i64().unwrap_or(0) + 1;
        state["source_epoch"] = json!(epoch);
        state["sources"][&next_key] =
            json!({"key":next_key,"title":source["title"],"sha256":source["sha256"],"active":true});
        st.put("source_change",json!(sha(&json!([base,epoch]))),json!({"base_id":base,"key":next_key,"source_epoch":epoch,"action":if existed{"REACTIVATED"}else{"ADDED"},"at":now(p)?}));
        st.put("library_state", base.clone(), state.clone());
        return Ok(json!({"state":state,"added":true}));
    }
    ensure(
        truthy(&state["sources"][key]["active"]),
        "只能替换当前有效资料",
    )?;
    if key == next_key {
        return Ok(json!({"state":state,"changed":false}));
    }
    ensure(
        !truthy(&state["sources"][&next_key]["active"]),
        "替换资料已在使用，请先核对来源",
    )?;
    ensure(
        sha(&source["content"]) == source["sha256"],
        "替换资料哈希无效",
    )?;
    st.put(
        "library_source",
        json!(sha(&json!([base, next_key]))),
        json!({"base_id":base,"key":next_key,"source":source}),
    );
    let at = now(p)?;
    let epoch = state["source_epoch"].as_i64().unwrap_or(0) + 1;
    state["source_epoch"] = json!(epoch);
    state["sources"][key]["active"] = json!(false);
    state["sources"][key]["revoked_at"] = at.clone();
    state["sources"][key]["replaced_by"] = json!(next_key);
    state["sources"][&next_key] = json!({"key":next_key,"title":source["title"],"sha256":source["sha256"],"active":true,"replaces":key});
    st.put("source_change",json!(sha(&json!([base,epoch]))),json!({"base_id":base,"key":next_key,"previous_key":key,"source_epoch":epoch,"action":"REPLACED","at":at}));
    st.put("library_state", base.clone(), state.clone());
    Ok(json!({"state":state,"changed":true}))
}
fn view(st: &Snapshot, job: &Value) -> Result<Value> {
    let c = st.record("library_candidate", &job["id"]);
    let mut out = job.clone();
    if !truthy(&c) {
        if !truthy(&job["internal_scope"]) {
            return Ok(out);
        }
        if truthy(&job["result"]) {
            let mut result = job["result"].clone();
            result["status"] = json!("BUILDING");
            result["claims"] = json!([]);
            result["answers"] = json!([]);
            out["result"] = result;
        } else {
            out["result"] = Value::Null;
        }
        out["publication"] = json!({"status":"UNREGISTERED"});
        return Ok(out);
    }
    st.assert_active(&c["base_id"])?;
    let state = st.record("library_state", &c["base_id"]);
    let published = c["status"] == "PUBLISHED" && job["status"] == "READY";
    let mut result = if truthy(&job["result"]) {
        job["result"].clone()
    } else {
        Value::Null
    };
    if truthy(&result) {
        if let Some(m) = result.as_object_mut() {
            m.remove("answers");
        }
        let pending = st.pending(&c["base_id"], &state["source_epoch"]);
        let mut manifests = vec![];
        if truthy(&result["component_publication"]) {
            manifests.push(result["component_publication"].clone());
        }
        for r in pending {
            let mut m = r["manifest"].clone();
            for field in ["held_predicate_ids", "held_cq_ids"] {
                let extra = if field == "held_predicate_ids" {
                    "additional_held_predicate_ids"
                } else {
                    "additional_held_cq_ids"
                };
                let mut xs = a(&m[field]).to_vec();
                xs.extend(a(&r[extra]).to_vec());
                m[field] = arr(xs);
            }
            manifests.push(m);
        }
        if !manifests.is_empty() {
            result["pending_components"] = json!({"predicate_ids":unique(manifests.iter().flat_map(|m|a(&m["held_predicate_ids"]).to_vec())),"cq_ids":unique(manifests.iter().flat_map(|m|a(&m["held_cq_ids"]).to_vec())),"origin_task_ids":unique(manifests.iter().filter(|m|!a(&m["held_predicate_ids"]).is_empty()||!a(&m["held_cq_ids"]).is_empty()).map(|m|m["origin_task_id"].clone()))});
        }
        let mut visible = vec![];
        for claim in a(&result["claims"]) {
            let source = find_by(&job["input"]["sources"], "id", &claim["source_id"]);
            let Some(source) = source else {
                continue;
            };
            if !truthy(&state["sources"][source_key(source)]["active"])
                || !support_valid(claim, &job["input"]["sources"])?
            {
                continue;
            }
            let all = a(&claim["support_set"]).iter().all(|e| {
                find_by(&job["input"]["sources"], "id", &e["source_id"])
                    .is_some_and(|s| truthy(&state["sources"][source_key(s)]["active"]))
            });
            if all {
                visible.push(claim.clone());
            }
        }
        result["claims"] = arr(visible);
        if !published {
            result["status"] = json!("BUILDING");
        }
    }
    out["result"] = result;
    out["publication"] = json!({"status":c["status"],"base_id":c["base_id"],"source_epoch":state["source_epoch"],"review_hash":st.review_hash(&c["base_id"],&state["source_epoch"]),"revoked_source_ids":a(&job["input"]["sources"]).iter().filter(|s|!truthy(&state["sources"][source_key(s)]["active"])).map(|s|s["id"].clone()).collect::<Vec<_>>()});
    Ok(out)
}
fn stamp(st: &Snapshot, id: &Value) -> Result<Value> {
    let c = st.record("library_candidate", id);
    if !truthy(&c) {
        return Ok(Value::Null);
    }
    st.assert_active(&c["base_id"])?;
    let state = st.record("library_state", &c["base_id"]);
    Ok(
        json!({"base_id":c["base_id"],"source_epoch":state["source_epoch"],"review_hash":st.review_hash(&c["base_id"],&state["source_epoch"])}),
    )
}
fn assert_stamp(st: &Snapshot, expected: &Value) -> Result<Value> {
    if truthy(expected) {
        st.assert_active(&expected["base_id"])?;
        let current = st.record("library_state", &expected["base_id"]);
        if current["source_epoch"] != expected["source_epoch"] {
            return Err(error(
                "SOURCE_REVOKED",
                "回答期间资料已撤回，请按当前资料重新提问",
            ));
        }
        let invalid = if truthy(&expected["review_hash"]) {
            expected["review_hash"]
                != st.review_hash(&expected["base_id"], &expected["source_epoch"])
        } else {
            !st.pending(&expected["base_id"], &expected["source_epoch"])
                .is_empty()
        };
        if invalid {
            return Err(error(
                "KNOWLEDGE_REVIEW_CHANGED",
                "回答期间争议范围已变化，请按当前状态重新提问",
            ));
        }
    }
    Ok(Value::Null)
}
fn assert_candidate_sources(st: &Snapshot, id: &Value) -> Result<Value> {
    let c = st.record("library_candidate", id);
    if truthy(&c) {
        st.assert_active(&c["base_id"])?;
    }
    if !truthy(&c) || c["status"] != "CANDIDATE" {
        return Ok(Value::Null);
    }
    let state = st.record("library_state", &c["base_id"]);
    let job = st.task(id);
    if state["source_epoch"] != c["expected_source_epoch"]
        || a(&job["input"]["sources"])
            .iter()
            .any(|s| !truthy(&state["sources"][source_key(s)]["active"]))
    {
        let mut e = error("SOURCE_REVOKED", "处理期间资料范围已变化，未继续发送模型");
        e.details = Some(json!({"billing_status":"NOT_SENT"}));
        return Err(e);
    }
    Ok(Value::Null)
}
fn libraries(st: &Snapshot) -> Result<Value> {
    let mut out = vec![];
    for base in a(&knowledge_bases(&st.tasks)?) {
        let life = st.record("library_lifecycle", &base["id"]);
        let mut named = base.clone();
        named["name"] = if truthy(&life["name"]) {
            life["name"].clone()
        } else {
            base["name"].clone()
        };
        named["lifecycle_status"] = if truthy(&life["status"]) {
            life["status"].clone()
        } else {
            json!("ACTIVE")
        };
        named["trashed_at"] = if truthy(&life["trashed_at"]) {
            life["trashed_at"].clone()
        } else {
            Value::Null
        };
        let state = st.record("library_state", &base["id"]);
        if !truthy(&state) || !st.active(&base["id"]) {
            out.push(named);
            continue;
        }
        let head = if truthy(&state["head_task_id"]) {
            st.task(&state["head_task_id"])
        } else {
            Value::Null
        };
        let has_head = truthy(&head);
        named["current_task_id"] = if has_head {
            head["id"].clone()
        } else {
            Value::Null
        };
        named["open_task_id"] = if has_head {
            head["id"].clone()
        } else {
            base["latest_task_id"].clone()
        };
        named["status"] = if has_head {
            json!("READY")
        } else if base["latest_status"] == "READY" {
            json!("REVIEW_REQUIRED")
        } else {
            base["latest_status"].clone()
        };
        named["claim_count"] = if has_head {
            json!(a(&view(st, &head)?["result"]["claims"]).len())
        } else {
            json!(0)
        };
        named["source_epoch"] = state["source_epoch"].clone();
        named["review_hash"] = json!(st.review_hash(&base["id"], &state["source_epoch"]));
        let sources = state["sources"]
            .as_object()
            .map(|m| m.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        named["source_count"] = json!(sources.iter().filter(|s| truthy(&s["active"])).count());
        named["sources"] = arr(sources
            .iter()
            .map(|s| {
                let mut v = json!({});
                field_copy(&mut v, s, &["key", "title", "active"]);
                v
            })
            .collect());
        out.push(named);
    }
    Ok(arr(out))
}

pub fn execute(op: &str, p: &Value) -> Result<Value> {
    if op == "source_key" {
        return Ok(json!(source_key(&p["source"])));
    }
    if op == "plan_component_publication" {
        return plan_component_publication(&p["base"], &p["job"], &p["options"]);
    }
    if op == "knowledge_bases" {
        return knowledge_bases(a(&p["tasks"]));
    }
    let mut st = Snapshot::new(&p["snapshot"]);
    match op {
        "begin" => {
            let v = begin(&mut st, &p["job"])?;
            Ok(write_result(&st, v))
        }
        "publish" => {
            let v = publish(&mut st, &p["job"], p)?;
            Ok(write_result(&st, v))
        }
        "revoke" | "add_source" | "replace_source" => {
            let v = change_source(&mut st, op, p)?;
            Ok(write_result(&st, v))
        }
        "view" => view(&st, &p["job"]),
        "stamp" => stamp(&st, &p["task_id"]),
        "assert_stamp" => assert_stamp(&st, &p["expected"]),
        "assert_candidate_sources" => assert_candidate_sources(&st, &p["task_id"]),
        "query" => {
            let job = view(&st, &st.task(&p["task_id"]))?;
            let input = p
                .get("input")
                .filter(|v| truthy(v))
                .unwrap_or(&job["input"]);
            let result = job
                .get("result")
                .filter(|v| truthy(v))
                .cloned()
                .unwrap_or(json!({"status":job["status"]}));
            let mut answer = crate::model::execute(
                "answer_plan",
                &json!({"result":result,"input":input,"plan":p["plan"]}),
            )?;
            answer["backend"] = json!("SQLITE");
            answer["task_id"] = p["task_id"].clone();
            answer["version"] = p["task_id"].clone();
            Ok(answer)
        }
        "libraries" => libraries(&st),
        "base_for" => Ok(st.record("library_state", &p["base_id"])),
        "candidate_for" => Ok(st.record("library_candidate", &p["task_id"])),
        "review_hash" => Ok(json!(st.review_hash(&p["base_id"], &p["source_epoch"]))),
        _ => Err(error(
            "UNKNOWN_GOVERNANCE_OPERATION",
            format!("Unknown governance operation: {op}"),
        )),
    }
}
