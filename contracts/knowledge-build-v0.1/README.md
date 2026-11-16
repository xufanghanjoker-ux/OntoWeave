# P2 CQ 引导的候选建图

版本 `lightog-build/0.1`。实现为 `crates/lightog-core/src/knowledge_build.rs`，纯 Rust，不调用模型、嵌入、数据库或服务。它消费 P1 ExtractionCandidate 与已有 EvidenceSet；输出的是候选图和检索线索，不能作为已发布事实。

## API

`knowledge_build::execute(operation,payload)` 返回 core Result，错误仅含稳定代码，不回显正文。

| operation | 必填字段 | 输出 |
| --- | --- | --- |
| prepare_extract | evidence_set_ref、cq_guidance、trusted_context | 模型提示、完整候选 schema 和原文菜单；model_called=false |
| family | family、trusted_context | 同目标继承后的逐成员任务，尚未检查覆盖 |
| build | candidates、trusted_context | graph 和 profiles；可选 patterns，空 candidates 时必填 snapshot |
| merge | previous、delta、expected_graph_digest、trusted_context | 同来源快照内的增量聚合与 CAS 写计划 |
| rebuild | previous、expected_graph_digest、trusted_context | 依当前可信身份链接重建候选图、显式身份映射和 CAS 写计划 |
| project | graph、trusted_context | 从可信候选图产生确定性检索文本 |

共享 QuestionSpec、CQFamily、EvidenceSet 和 SourceSnapshot 仍为 demand/0.1；candidates 是 knowledge/0.2 的 ExtractionCandidate，不要求旧 Schema 已有谓词或 cq_plans。

## 信任与来源

trusted_context 的原文、快照、已确认实体等由服务填入。build 对全部候选调用 P1 KnowledgeKernel；family 验证原始 QuestionSpec、CQFamily 及证据集合。引用、哈希、UTF-16 位置可由程序验证，关系蕴含、同族身份和角色含义仍是未核实语义。

模型给 entity_ref 也不能自行确认身份。服务必须提供 authority.entity_links，其中每个链接含 entity_ref、status=CONFIRMED、base_ref、source_ref、source_revision、text_sha256、精确 span 和非空 receipt_ref；所指实体还需在 authority.entities。每处提及必须有唯一匹配链接，竞争链接返回明确错误。模型没有给已知ID时，可信链接可解析原文提及。

无可信身份绑定时，以知识库与原文提及锚点生成 PROVISIONAL_ANCHOR 身份。同名、同类型或向量相似不触发跨锚点身份合并。已确认链接保留原始锚点，图保留完整 candidate_archive、pattern_archive；撤销链接后可由 rebuild 还原临时身份。该操作是显式身份修订，不混入无声增量合并。

原文来源必须属于当前允许快照，不能借候选自报 PUBLISHED。merge/project/rebuild 中，输入完整图还必须与 authority.candidate_graphs 的服务存储读取逐字段相同，且 graph_digest 匹配；expected_graph_digest 是服务事务的比较并交换条件，不代替事务。

## 聚合与关系

实体保留标签、类型标签、提及锚点和候选记录。归一后的关系两端仍必须不同，不能用两个局部ID指向同一锚点绕过自关系限制。模式限定使用 P1 CandidateQualifiers 校验，不接受 null 或少字段的快捷路径。

关系语义身份包含主体、谓词/新谓词定义、客体、方向、限定和条件；描述、关键词、证据及原始候选ID作为附加记录聚合。

不同否定、计划、条件、时间或方向不合并。UNDIRECTED 的端点可按确定性顺序规范化，DIRECTED 不能反向。新谓词定义保留原标签和说明，证据引用保存在 condition_records 中，不用同名谓词自动替代既有定义。

merge 只允许相同来源/图快照，保留旧行语义，重复原文支持集合去重。来源新增/替换、撤回与正式发布的实际事务由后续 P5 实现，不伪称本模块已实现跨来源生命周期同步。

组合、比较和组成以 patterns 保存。每个模式有 label、kind、roles、evidence_set_ref、evidence_ids、qualifiers；role 使用 candidate_id 与 entity_local_id 引用已验证参与者。每个模式至少两名不同参与者，角色不转换成无条件的二元关系团。模式语义固定 UNVERIFIED。

## CQFamily

family 使用已有 SourceMention 和 cohort_basis 接收有原文提及的同族扩展提案，不按名称中共同的词判定同类。它按种子目标生成成员任务，并保留原文分类依据。需要继承条件时只接受明确 INVARIANT，SUBJECT_SPECIFIC 与 REQUIRES_RECHECK 不静默套给新主体，返回 BUILD_FAMILY_CONDITION_UNRESOLVED。

成员替换保留种子主体槽的 local_id，成员自身 local_id 另存 family_member_local_id，避免既有角色引用悬空。带 depends_on 的需求目前返回 BUILD_FAMILY_DEPENDENCY_UNSUPPORTED，不把未展开的依赖返回为可执行计划。

任务是 PLANNED_UNVERIFIED，coverage=NOT_CHECKED；返回 semantic_cohort_certified=false。模型发现与独立同族语义裁定需要后续真实测试，不把现有固定 family 实例化当成已解决 QF-01。

## 检索文本与 P3

profiles 字段为 id、owner_id、kind、entity_refs、text、evidence_refs、evidence_ids、snapshot、status=DISCOVERY_HINT。evidence_refs 保留 evidence_set_ref 与 evidence_id，扁平 evidence_ids 只为下游兼容。

实体 profile 仅使用实际候选提及绑定的已验 evidence_refs，不从整个 registry 搜同位置并追加其他集合。

实体文本包含标签和类型；关系文本包含端点名称、谓词、方向、限定、条件、关键词和原始描述；模式文本保存参与角色及限定。全部为确定性文本组织，没有额外摘要模型成本。

候选描述可以用于候选发现和向量召回，但必须回到原文构造回答证据。DISCOVERY_HINT 不是 PUBLISHED_CLAIM，不能把描述直接当成语义已认证的证据。P3 应按 evidence_refs 重新验证和物化原文。

## 资源和停止

每次输入最多8MiB，最多256个候选、64个模式，每模式最多12个角色；图最多4096实体/声明、512模式。合并后归档不超过256个候选，以保证重建资源有界。单检索描述最多64000字节，超限明确失败，不裁掉条件后伪称完整。

建图依候选数、参与者和证据规模线性扫描，实体/声明用有序映射聚合；当前实体 profile 回查证据采用有界的实体×片段扫描，尚无大规模性能结论。输入候选和图目录达到上限时停止，不无限扩展。

## 验证与未完成

固定原创合成测试验证新关系无需旧计划、证据聚合、条件/否定/计划/方向区分、身份拒绝与可信绑定、角色保存、排列确定性、CAS、来源失效、空结果、身份重建回退和同族任务继承。

这些不是模型抽取准确率、关系召回率或同族发现质量评测。实际模型调用须由主 Agent 与用户确认范围和预算后执行；本模块不访问密钥。当前 P2 是候选算法与消费接口，尚未接入正式产品知识发布。
