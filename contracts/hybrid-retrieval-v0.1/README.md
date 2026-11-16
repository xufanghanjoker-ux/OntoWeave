# P3 Rust 联合召回候选契约

版本 `lightog-hybrid-retrieval/0.1`。`lightog_core::hybrid_retrieval::execute("search", payload)` 是可执行的纯 Rust 联合召回候选；不调用生成、Embedding 或 Reranker 服务，不读数据库，不发布知识。实际模型测试由主 Agent 与用户确认后执行。

## 输入与可信边界

完整形状见 schema.json；缺失必填字段与未知字段被拒绝。question 保存原问题，queries.document/entity/relation 分别是原文、实体和关系主题检索文本。问题解释及关键词由上游提供，核心不自动丢弃用户条件。snapshot 与 trusted_index.context 使用 P1 既有来源快照、EvidenceSet 和 ValidationContext。

trusted_index 包含 records、edges、manifests、context、evidence_token_counts、tokenizer。这个对象由服务构造，模型不能自报 authority 或发布/向量构建收据。

每条 record 包含 id、kind、text、entity_refs、evidence_ids、status、profile、embedding。kind 为 DOCUMENT/ENTITY/RELATION/PATTERN；DOCUMENT 文本必须逐字等于一个真实证据片段，status=SOURCE；其他记录为 DISCOVERY_HINT 或有已发布证据的 PUBLISHED。P2 的候选描述只作为 DISCOVERY_HINT，召回后仍回取原文。正式 P1 RetrievalProfile 可放入 profile，核对来源、原文依赖及文本完全一致；P2 尚未核实的描述不能假装正式已发布知识。

embedding 可空；存在时提供 index_id、values、text_sha256。实际正文 hash 必须与嵌入时文本一致，防止文本更新后继续使用旧向量。每个索引必须是 P1 校验过的 ACTIVE manifest，绑定当前来源/图快照、向量空间和可信构建收据；完整输入中对应 embedding 记录数必须与该代 records_total 一致。这里是精确扫描输入，不把截断的索引冒充完整 Top-K。

query_vectors 为独立的各组件查询向量，含 component、index_id、vector_space、query_text_sha256、values。DOCUMENT 对应 manifest 的 CHUNK；ENTITY、RELATION、PATTERN 各自匹配。不同模型空间可以分路计算查询向量后按名次融合，不能把一个模型的 query vector 直接投到另一个空间。维度、有限数值、非零范数、模型空间、组件及查询文本 hash 均校验。当前仅支持 COSINE 距离；没有配置向量时保留词法路径，绝不生成假向量。

来源失效时请求快照不通过；记录证据不在当前快照中会明确 excluded，不参与排序。非法原文或伪发布是错误，不静默吞掉。PUBLISHED 记录及边要求真实已发布片段，DISCOVERY_HINT 不作语义认证。

## 算法与固定默认参数

execute("defaults", {}) 返回参数；parameters.json 冻结本轮默认值。原有产品词法算法未被修改，以下是独立候选。

1. 每种组件分别建立词频和文档频率，执行英文词与中文连续二字词的词法排序，使用稀有度与词频饱和，取 channel_top_k。
2. 各组件在自身匹配空间执行精确 cosine，按 min_cosine 过滤后取 channel_top_k；同分按 record_id 升序。
3. 每个通道等权 RRF，分数为 sum(1/(rrf_k + rank))，rank 从1开始；取 result_top_k 种子。
4. 可选消费宿主的 Reranker 完整评分；candidate_set_sha256 必须匹配首次输出的问题、三路查询、快照以及候选ID、文本哈希、证据ID和状态的组合指纹，每项恰好一分。FAILED 且无分数时明确回退 RRF。核心只报告 HOST_SCORES_CONSUMED，不声称调用了服务。
5. 固定第一次种子集合，仅补直接边邻居；排序和上限确定，不从新邻居递归扩展。边必须有当前原文，图连接仅帮助召回；真正用于一跳扩展的边原文也加入该目标记录的完整证据预算，不只返回目标自己的证据。
6. 根据记录顺序组织完整证据。按来源版本、正文哈希和原文位置去重，保留 evidence_aliases 与 evidence_provenance 的全部原证据及发布依赖。记录所需的新证据整体超预算时，整条记录 deferred，不裁掉条件或把长引文截成看似通过的短句。

默认每通道20、种子12、RRF k=60、最多12个一跳邻居、上下文16000 UTF-16码元、min_cosine=0。默认字符预算只报告字符；提供 max_context_tokens 时，必须同时提供 tokenizer 和宿主对每个必要证据的计数收据 `{tokens,quote_sha256,tokenizer}`，缺失、非正计数、原文/分词器不匹配或同锚点别名计数冲突均拒绝。该预算仅计算证据引文，不包括结构化字段、提示词或分隔符，P4宿主必须另留完整请求开销。字符数不转换为虚构的token/费用。

候选种子最多 result_top_k，一跳扩展另受 max_graph_neighbors 约束，最终记录数可大于种子数。来源全文和向量输入受进程与单操作资源上限约束，预算及源位置不按 gold 调整。

## 输出与失败语义

输出 records（含分数、RETRIEVAL/ONE_HOP、状态、原记录证据、导航证据及合并后证据IDs）、contexts（原有 EvidenceFragment）、evidence_aliases、evidence_provenance、deferred、excluded 和 trace。trace 包含每路排名、重排前候选ID/hash、扩展ID、实际字符/token数和降级状态。

embedding_status 区分 NOT_CONFIGURED、CONFIGURED_QUERY_VECTOR_MISSING_LEXICAL_ONLY、HOST_VECTORS_CONSUMED_PARTIAL_CHANNELS 和 HOST_VECTORS_CONSUMED。rerank_status 区分 NOT_CONFIGURED、HOST_SCORES_CONSUMED、FAILED_FALLBACK_RRF。检索结果明确 LOCAL_RETRIEVAL_NOT_EXHAUSTIVE、publication_performed=false、model_calls_performed=0。

没有召回不能自动断言资料无能力；上下文命中也不证明自然语言蕴含或完整性。contexts 回取原文，profile 文本仍是候选线索；后续 P4 消费时必须保留 evidence_provenance，不能因去重丢掉已发布声明或必要辅助证据。

## 复杂度与验证

设 N 是记录数、T 是总分词数、Q 是查询词数、E 是输入边数、V 是向量维度。词法特征建立与排序约 O(T+NQ+N log N)，精确向量约 O(NV+N log N)，一跳边检查 O(E)。当前每次查询重建局部特征和扫描输入边，不宣称已实现持久化倒排或 ANN 性能；后续只有剖析需要时才优化缓存或 ANN，并单独验收召回损失。

当前22项Rust测试和3项Node投影测试使用原创合成文本与预制向量，验证算法与错误边界，不作为真实 Embedding 或问答收益。真实评测前冻结 source manifest；实现者不读取独立评测 Agent 的 HOLDOUT/gold，不根据留出结果修改参数。
