# 原生检索 v1 并行实施契约

2026-11-06：用户要求检索独立于正在执行的导入和建图链路并行开发与验证。本会话负责检索新增命名空间，不修改主线正在使用的共享 runtime、构建模块、数据库或产品默认入口。依据 [开发实施方案](../../docs/lightog-native-agent-retrieval-implementation-plan-v1-20261106.md)。

语言分工更新：search、graph 及 Host 计算的确定性内核已按[版本化 Rust 契约](../native-query-rust-v1/README.md)迁移；JS 保留数据、模型、游标、事务和产品适配。该变更不升级业务检索策略，原 Agent 和检索 Skill 沿用。

## 文件所有权

- 检索数据与图工具：`web/native-query-view-v1.mjs`、`web/native-query-search-v1.mjs`、`web/native-query-graph-v1.mjs` 及同名测试。
- 原生查询执行：`web/native-query-operation-v1.mjs`、`web/native-query-runtime-v1.mjs`、`web/native-query-model-v1.mjs` 及同名测试；查询 Skill 草稿 `docs/skill-drafts/lightog-retrieval-answer/`。
- 查询 Host 与集成：`web/native-query-host-v1.mjs`、`web/native-query-product-v1.mjs`、`web/native-query-http-v1.mjs`、`web/native-query-build-adapter-v1.mjs` 及同名测试，本文及结果报告。
- 独立验证：`tests/native-query-v1/`、`scripts/run-native-query-offline-v1.mjs`。不修改已冻结的合成资料或金标来迎合实现。

共享 `native-agent-runtime-v1`、`native-build-*`、`source-models-v1`、`server/product-http`、package.json 只读；需要的最终接入作为单独、可审阅的主线改动交付，不用覆盖式复制修改它们。

## 可信数据读取端口

Host 由构造参数获得 reader；模型和 HTTP 请求不能指定 reader 或开启 oracle 模式。所有方法可同步。

```text
reader.scope() -> {library_id, source_snapshot_ref, source_epoch, manifest_ref,
  source_current, embedding_spaces?:[{space_ref,model,revision,dimensions,input_strategy,distance}],
  reader_manifest_ref?,adoption_revision_ref?,source_index_revision?,fact_index_revision?,
  source_index_coverage?:'NONE'|'PARTIAL'|'COMPLETE',...非模型可见执行元数据}
reader.assertCurrent() -> true 或抛出有 code 的错误
reader.documents() -> [{doc_ref,revision,title,content,state:'ACTIVE'|'HISTORICAL'|'FUTURE',
  blocks:[{block_ref,start,end,kind?}], ...}]
reader.subjects() -> [{subject_ref,surface,aliases?:[],source_refs:[],evidence?:[]}]
reader.facts() -> 当前可查询事实数组
reader.evidence(ref) -> 精确证据或 null
```

事实共同字段：`fact_ref,kind,subject_ref,conditions,negation,modality,source_refs,evidence`；RELATION 另有 `predicate,object_ref,direction:'SUBJECT_TO_OBJECT'`，ATTRIBUTE 有 `attribute,raw_value,unit`，RULE 有 `rule_text,participants`。证据字段为 `evidence_ref,doc_ref,revision,start,end,quote,offset_unit:'utf16_code_unit'`。可含 `time_text/version_text`；不从文本时间自动承诺双时态。

事实及来源记录可带 `embedding:{space_ref,values}`；只有能验证兼容的已存向量才进入语义通道。查询 `embed(texts,{inputType:'query',embeddingSpace,signal?})` 返回向量数组。没有配置时明确使用词法，不合成向量；同类候选 RRF，不把分数当采用资格。

生产 adapter 通过 Build Host 的有效事实过滤取得事实；source-only 默认不提供事实。隔离测试 reader 使用人工 oracle，但不造生产采用回执，测试资格只在 Host 与报告元数据中。两者都必须校验真实文本、修订和精确证据。

## 数据与图模块 API

`createNativeQueryView({store?,libraryId,sourceSnapshot,subjects?,readFacts?,isCurrent?,metadata?})` 返回上述 reader。`sourceSnapshot` 包含 `source_snapshot_ref,source_epoch,documents`。文档 content 和证据坐标保持 UTF-16；读取时以 isCurrent 及生产 readFacts 检查资格。不在 view 中按名字合并主体。

`createNativeQuerySearch({reader,embed?,signal?})` 返回 `findEntities(args)`、`searchFacts(args)`、`searchSources(args)`、`readEvidence(args)`。`query` 为自然文本；可选 `keywords,kind(s),subject_refs,source_refs,cursor,page_size`。返回 `{status,items,evidence?,next_cursor,truncated,scope,...}`；不包裹 ok，Host 统一封装。cursor 绑定实际参数与快照，未知或被篡改的 cursor 拒绝。

事实可用 `predicates` 精确过滤关系 predicate 或属性 attribute；事实资格来自 reader，不接受来源 `states`。`states` 仅作用于原文来源。`nativeQueryScope(reader)` 是 prompt、工具结果、operation 与公开状态共同使用的白名单；Embedding 配置仅公开已定义的模型空间字段，额外连接配置不进入记录。

`createNativeQueryGraph({reader})` 返回 `getEntityFacts(args)`、`expandGraph(args)`、`findPaths(args)`。参数使用真实 `entity_ref/seed_refs/from_ref/to_ref`，可选 `predicates,direction,cursor,page_size`。只沿实际业务 RELATION；属性和规则通过实体事实读取。路径结果保留逐跳事实及证据，不推因果。技术深度和分页策略显式返回截断，不作为逐题业务额度。

## 查询 operation 和模型

`createNativeQueryOperation({store,queryId?,libraryId,input,execution?:{timeout_ms,max_request_bytes,max_response_bytes,...},now?})` 返回 `state/assertActive/beginRequest/recordReturned/recordFailed/recordUnknown/recordProgress/stageAnswer/confirmAnswer/cancel/stop`。不接受或要求生成次数、Embedding 批次或金额限额。

`beginRequest({kind,role,requestMetadata?})` 返回 `{request_ref,signal?}`；结算方法接受 request_ref 和 `{usage?,reason?}`。`recordProgress({tool_name,args_hash,evidence_refs,result_hash?})` 识别完全相同且无新证据的动作；合理不同参数或下一页可继续。stageAnswer 持久化答案，confirmAnswer 只在实际引用检查、无未结算请求、已知收尾后完成。取消、UNKNOWN、失败不自动重放。

`createNativeQueryModelBinding(profile)` 返回无凭据的配置绑定。模型名称不固定，协议首先支持原生 Codex 兼容 Responses；凭据在 transport 闭包，原生工具循环不由 SDK 替代。

`runNativeQueryAgent({store,operation,tools,skillPaths?,prompt,runtimeDirectory,modelBinding,upstream,runtimeFactory?})` 使用锁定原生 app-server。tools 为 `{definitions:array,call(name,args),isComplete()}`，upstream 为 `({body,signal,request_id}) => {status,body:AsyncIterable<Buffer>}`。返回 `{receipt,events,complete}`。允许注入 scripted runner用于离线，必须记录执行标签。

## Host 和产品 API

`createNativeQueryHost({reader,operation,embed?})` 返回 `{definitions,call,isComplete,snapshot,confirmAnswer}`。tools.call 统一 `{ok:true,result}` 或 `{ok:false,error:{code}}`。无命中、歧义、分页和能力未配置为业务结果；权限、来源、引用和协议错误为错误。

工具名为 `lightog_find_entities/lightog_search_facts/lightog_search_sources/lightog_read_evidence/lightog_get_entity_facts/lightog_expand_graph/lightog_find_paths/lightog_compute/lightog_submit_answer`。完整同源 Schema 由 Host definitions 输出。答案参数为 `{status,statements:[{text,evidence_refs,fact_refs?,calculation_refs?}],unanswered:[],clarification?}`。事实引用必须已经发放、确认时仍有效且语义不变；只有真实采用策略及表示同时匹配时标为 ADOPTED_FACT，oracle 夹具仅为 STRUCTURED_SOURCE_EVIDENCE。计算输入来源为 EVIDENCE、QUESTION 或已发放 CALCULATION，结果保留规则和传递证据；算术工具不认证公式解释的语义正确性。

`createNativeQueryProduct({store,resolveReader,agentRunner?,modelRuntime?,runtimeDirectory,...})` 提供 `ask/status/cancel/whenIdle`。ask 只需 `{libraryId,question,requestId,context?}`，模型配置由宿主获取，不从问答参数注入。旧构建 consent/limits 不迁入。default reader 来自库级 manifest，测试 reader 只能构造时注入。

`modelRuntime({libraryId}) -> {modelBinding|profile,upstream,embed?}`。返回模型绑定经工厂重新投影验证，实际凭据只由 upstream 闭包持有。Query Embedding 请求与生成请求一样受观测、取消和 UNKNOWN 管理。状态另返回 `provider_outcome_unknown`；FAILED、CANCELLED 或 INTERRUPTED 不表示所有并发服务结果已知。

`createNativeBuildQueryReader({store,catalog,libraryId,snapshotId,build?,originRunRef?})` 从 catalog 读取规范化原文；有可信 build 时，复用已有索引并与 Build Host 的有效采用事实求交。部分来源索引保留未覆盖 canonical span 的词法回退，不重做文档向量。

`createNativeQueryRegistry({store,resolveReader})` 的 `register({libraryId,exportRef,sourceSnapshotRef,expectedManifestRef?})` 先验证可信 reader 再 CAS 选择唯一库头；`open(libraryId)` 返回绑定该库头的 reader，所有读取及答案确认检测头变化。不能按最新 run 自动拼接历史。

`createNativeQueryHttp({product,json,parseBody,authorize})` 提供 `/api/product/libraries/:libraryId/native-query/ask|capabilities|queries/:queryId|queries/:queryId/cancel`；默认拒绝授权。主线最终挂载需复用原产品认证、body 大小限制和现有 UI。此并行交付未切换默认入口。

## 验证分层

独立临时 SQLite、合成资料和 oracle reader 可在无真实建图产物时推进。先验证工具、模型配置、原生 Codex 加模拟 Responses 和 HTTP；真实 LLM 的语义成绩另列。不得读取历史日志查 Key、借用主线正在使用的数据库或把 scripted 答案称为真实模型效果。真实构建就绪后，用只读 build adapter 接入同一套查询端口，不重复导入、抽取或采用。
