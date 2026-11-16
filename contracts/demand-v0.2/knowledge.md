# LightOG 抽取候选与派生索引契约

版本：`lightog-knowledge/0.2`。实现：`crates/lightog-demand/src/knowledge_contract.rs`。本契约属于 P1 接缝，不执行模型抽取、建图、向量检索、数据库写入或索引切换。

## 与既有共享需求的关系

不替换 `lightog-demand/0.1` 的 QuestionSpec、EvidenceSet、SourceSnapshot、SourceMention、SourceSpan 和 TypedValue。新增对象的 `snapshot`、提及和类型值直接引用旧定义；`evidence_set_ref` 指向可信上下文中的既有 EvidenceSet。运行时从两个已检入 schema 离线组合定义，不请求网络 schema，不改旧数据 ID 或哈希。

`knowledge.schema.json` 只定义新增对象，外部引用使用 `urn:lightog-demand:0.1#/$defs/...`。Rust 将其解析为旧 schema 的对应定义。仅检查新增 schema 不等于通过来源与符号表检查。

## ExtractionCandidate

表示一个尚未发布的实体、关系或属性候选。所有候选固定 `status=CANDIDATE`、`semantic_status=UNVERIFIED`。字段包括原文快照、证据集合、证据 ID、局部实体与逐字提及、主体、谓词或新定义提案、客体、方向、描述、关键词、限定与条件。

局部实体允许 `entity_ref=null`，已知实体引用则必须存在于服务提供的 `authority.entities`。每个实体至少一处 SourceMention；Rust 复核 UTF-16 原文位置、精确 quote，并要求提及落在所引用证据范围内。规范标签可能不同于原称，不能用标签替代提及证明。

RELATION 使用两个不同的局部实体 ID，方向为 DIRECTED 或 UNDIRECTED；ATTRIBUTE 使用 TypedValue，方向为 NONE；ENTITY 不使用谓词和客体。复杂模式继续由后续结构契约承载，本契约不把多方角色压平成已经确认的二元事实。

谓词必须二选一：引用已有 predicate_ref，或提供带证据的新 proposed_definition。后者不要求旧 schema 已有谓词，也不依赖 cq_plans；校验成功仍只是允许保留提案，不会新增正式谓词。

scope、modality、negated、unit、effective_time 显式保留。条件分别记录文本和证据 ID，support_status 固定 UNVERIFIED。引用存在不能证明该条件或关系被原文语义支持，不能由候选自行填 SUPPORTED 或 PASS 取得认证。

## RetrievalProfile

实体、关系或模式的派生检索文本，固定 `status=DERIVED_INDEX`、`semantic_status=NOT_FACT`。保存 profile_id/revision、原文快照、evidence_set_ref、evidence_ids、claim_refs、文本策略及关键词。

可使用纯原文证据且 claim_refs 为空，不生成假 claim。使用图证据时，claim_refs 必须恰好等于所选片段关联的已发布 claim 集合；原始 EvidenceSet 重新经过旧 Kernel 的发布、图版本、位置与来源检查。不能隐藏被依赖的声明，也不能引用另一个无关图版本中的声明。

profile 中的文字尚未经过语义核对。验证不证明摘要完整保留原文条件，不允许把 profile 自报成已验证事实；未来生成器和摘要质量属于 P2/P3 的独立评测。来源撤回使快照不再出现在 allowed_snapshots 时，profile 无法通过当前验证。

## IndexManifest

保存不可变一代索引的身份、组件、来源/图快照、向量空间和构建计数。VectorSpace 明确 provider、model、可空 model_revision、dimensions、normalization、distance、text_policy、tokenizer_version；model_revision 为空只表示服务无法固定版本，不声称向量空间长期稳定。

BUILDING 不能提供完成收据；READY/ACTIVE/SUPERSEDED 必须全部向量完成，并关联服务侧 INDEX_BUILD 收据。收据从独立的 `authority.receipts` 输入，匹配以下内容：

```text
receipt_ref, kind=INDEX_BUILD, status=COMPLETE,
index_id, index_revision, component,
snapshot_sha256, vector_space_sha256,
records_total, vectors_completed
```

服务只能在实际构建核对后登记收据。Rust 核对绑定关系，不能验证外部数据库里真的存在这些向量。ACTIVE 还需与 `authority.active_indexes` 中一个完整 manifest 相同；候选自报 ACTIVE 不会被接受。

变更模型、维度或文本策略必须构建新 index_id 并取得匹配收据，不在同一索引代内混用向量空间。`index_transition` 接收可信服务读到的 previous、READY next 和 expected_previous_index_id：

1. 验 next 的来源、空间、完成计数与服务收据。
2. 首次切换要求 previous 和 expected 为 null，服务登记中同库同组件没有现行索引。
3. 替换要求 previous 是服务登记的 ACTIVE；expected 匹配前代 ID，同库同组件且新旧 index_id 不同。
4. 返回 activate/supersede 写集及 `requires_host_atomic_compare_and_swap=true`。

旧代的快照可以已经过时，因此替换操作只核对其完整身份与服务登记；新代必须通过当前快照检查。生成写集并非完成原子切换：服务必须在事务中重新比较现行代并一并提交，否则不得向用户报告已激活。

`validate_index_set` 检查同一次向量查询选用的最多四个 ACTIVE manifest：向量空间必须与该请求的 expected_vector_space 完全一致，来源/图快照相同，组件不重复。各自构建合法但模型不同的两个索引也不能共享一个查询向量。不同空间若分别计算查询并独立排名，可以在后续 P3 用排名融合；本接口不禁止这种分路检索，只拒绝直接混用向量。

## 调用与可信边界

`execute("validate", {definition,value,trusted_context})` 校验 ExtractionCandidate、RetrievalProfile 或 IndexManifest。返回 validated=true 时同时明确 semantic_support_certified=false、publication_performed=false。

`execute("index_transition", {previous,next,expected_previous_index_id,trusted_context})` 返回切换计划。trusted_context 复用需求内核的 examples、source_texts、authority，服务从可信状态构造；模型只提交 value，不得自行提交 authority 或 INDEX_BUILD 收据。这里的“可信”是调用边界责任，不由 JSON 内某个标记或签名字段自动建立。

`execute("validate_index_set", {manifests,expected_vector_space,trusted_context})` 返回空间与快照兼容性。每种调用都检查顶层字段完整且无未知字段；省略 previous 不等于显式 previous=null。重复的同库同组件 ACTIVE 记录阻断切换，避免忽略冲突的现行代。

所有对象拒绝未知字段和缺失的必填 nullable 字段。原文不规范化，检索归一化只能保存为派生文本。source epoch、正文/原件哈希、图版本、UTF-16 边界及可空值沿用原契约；生产 PDF 原件哈希由服务侧原件核验，不能对解析文字重新哈希后冒充。

## 固定验证范围

Rust 测试使用原创合成资料和既有合成需求夹具，覆盖新关系无需旧谓词/计划、候选不能自证、悬空实体/证据、原文位置、来源撤回、图依赖、纯原文 profile、构建收据、维度变化、ACTIVE 冒认、CAS 与同代复用拒绝。

这些结果只证明契约与有限反例行为，不证明真实模型抽取、实体消歧、摘要支持、检索收益、索引原子性或产品链路已接入。
