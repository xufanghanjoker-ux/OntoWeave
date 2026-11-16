# Native build Host v1：工具契约和示例

此文件描述2026-11-06实现；示例引用均是占位符，不是真实运行回执。JSON Schema以 `web/native-build-host-v1.mjs` 的 `definitions(role)` 返回值为准；Host使用同一Schema验证参数，不维护第二份JSON镜像。

## 导出与调用

`createNativeBuildHost({store,catalog,libraryId,snapshotId,cqInput,families,runId,assertOpen})` 返回：

- `definitions(role)`、`call(role,name,args)`、`snapshot()`。
- `reviewInput()`、`recordReviewInvocation(preparedReceipt)`、`confirmReviewInvocation(finalReceipt)`。
- `buildIndexes({embed,embeddingSpace,capability})`、`query({view,query,vector,limit})`、`graph({view})`。
- `suspendFacts({fact_refs,evidence_refs,reason})` 用于可信冲突或身份错误的局部撤销。

EXTRACTION工具为 `lightog_list_build_sources`、`lightog_read_build_material`、`lightog_assemble_extraction_window`、`lightog_split_source_unit`、`lightog_locate_evidence`、`lightog_get_build_state`、`lightog_save_scope_plan`、`lightog_submit_extraction_batch`、`lightog_finish_extraction`。

REVIEW只提供 `lightog_get_review_batch`、`lightog_read_review_material`、`lightog_locate_review_evidence`、`lightog_save_local_review`。模型没有创建可信调用回执、采用、建索引或修改候选的权限。

## 示例提交

读取来源后，用工具返回的实际引用替换下例占位符：

```json
{
  "subjects": [],
  "tasks": [{
    "local_ref": "task_local_1", "cq_refs": ["Q01"],
    "scope_kind": "MODULE_OR_DOCUMENT", "module": "计费规则",
    "requirement": "取得计费公式和适用条件", "conditions": [],
    "source_refs": [{"doc_ref": "actual_doc_ref", "revision": "actual_revision"}]
  }],
  "cq_dispositions": [{
    "cq_ref": "Q01", "status": "TASKS", "task_local_refs": ["task_local_1"],
    "reason": "本轮原题的规则知识需求"
  }]
}
```

范围保存返回实际 `task_ref` 后，可以将模块任务本身作为候选主体：

```json
{
  "idempotency_key": "batch_1",
  "source_statements": [{"local_ref":"source_1","evidence_refs":["actual_evidence_ref"],"task_refs":["actual_task_ref"]}],
  "candidates": [{
    "local_ref":"rule_1", "kind":"RULE", "subject_ref":"actual_task_ref",
    "statement":"普通件运费为基础费与里程费之和",
    "rule_text":"运费=基础费+里程费；仅限普通件",
    "evidence_refs":["actual_evidence_ref"], "task_refs":["actual_task_ref"],
    "conditions":["仅限普通件"], "negation":false, "modality":"STATED", "gaps":[]
  }]
}
```

`local_ref`仅在本次提交内有效。修订已有候选时额外提供真实 `candidate_ref/expected_candidate_revision`；新版本不会继承旧核实。`RELATION`需要 `predicate/object_ref/direction:SUBJECT_TO_OBJECT`，`ATTRIBUTE`需要 `attribute/raw_value` 并保留单位。

结束抽取给出 `reason/coverage/gaps`；整题未完整时coverage选择PARTIAL或UNASSESSED。独立核实提交示例：

```json
{"rows":[{"candidate_ref":"actual_candidate_ref","decision":"SUPPORTED","evidence_refs":["actual_evidence_ref"],"reason":"原文支持完整公式和适用条件","identity_supported":true,"conditions_supported":true,"gaps":[]}]}
```

保存核实仅形成pending结果。Host先绑定prepared receipt，之后确认真实成功final receipt（相同invocation/run/role/runtime及请求绑定）才采用；FAILED/UNKNOWN不能激活。prepared的thread/turn可为空，final补入真实值。

## 读回与粒度

`view`为SOURCE或ADOPTED_FACT；空query显式枚举有效记录，不产生Embedding请求。快照、查询和图在父run完成或停止后仍能读回已确认产物；新操作继续受assertOpen约束，来源失效阻止现行查询资格。

来源检索记录按相邻完整块合组，最多3000个UTF-16字符、64处原始块证据，优先章节边界；原文文本直接切片，不用模型生成。每组保留各块精确引句和source spans。超大单块返回明确错误，不靠提高全run预算掩盖细碎向量开销。抽取窗口、解析块和检索记录三个粒度独立。

窗口可显式按自然边界拆出part；不可无损拆分的表格行返回缺口。完整Docling树/cell未由公共catalog提供时，窗口使用可验证的扁平来源块并返回局限告警。token估算标记为UTF-8字节上界，不声称是实测tokenizer。

可执行参数样例与持久化验收见六个同名 `.test.mjs` 文件，尤其 `web/native-build-host-v1.test.mjs`。这些测试使用临时SQLite和离线向量，不证明真实模型语义质量。
