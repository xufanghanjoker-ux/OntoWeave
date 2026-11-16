# P1 原文证据与旧声明兼容接缝

状态：纯 Rust 契约实现，未接入产品 HTTP、模型生成或后台队列。共享 QuestionSpec、EvidenceSet、CoverageReport、LearningIntent、AnswerResult 继续使用 `lightog-demand/0.1`；本接缝独立标识为 `lightog-evidence-bridge/0.1`。目录 v0.2 表示新增兼容边界，不将旧对象伪装成全体已升级。

## 输入和信任边界

`evidence_bridge::execute(operation, payload) -> Result<Value>` 提供两个操作。所有权限、有效来源快照、已发布声明记录和旧声明载荷由可信服务读取后分别填入；模型不得提交它们来自证“已发布”。纯函数不能认证调用者身份或访问实时数据库，服务必须在执行前和发送/提交前重新核对生命周期。错误只返回稳定错误码，不回显正文。

`context` 沿用已有 ValidationContext registry。新入口 `from_value_v2` 允许服务提供真实 PDF 的 `original_sha256` 与多块目录，Rust核验正文哈希、UTF-16原文和块归属。原件字节核验仍属于服务；不把解析正文当原 PDF 字节计算原件哈希。旧五字段文本上下文仍沿用严格0.1核验。

## compose

输入字段为 `request`、`context`、`legacy_claims`。

- request 必含 bridge_version、evidence_set_id、snapshot、source_fragments、legacy_claim_ids，不接受额外字段。
- source_fragments 是原有 EvidenceFragment，origin 必须 SOURCE_FRAGMENT，claim_refs 必须为空。可以在 graph_revision=null、无声明情况下构造合法原文证据。
- legacy_claim_ids 只选择可信服务传入的旧完整声明。发布资格必须由 context.authority.claims 中匹配图版本、来源版本和原文位置的 PUBLISHED 记录提供；旧声明自报 status 无效。权威发布记录还必须携带可信存储读取的完整 `legacy_payload`，与选中旧声明逐字段JSON等值；仅匹配ID和引文不授权修改主体、谓词、值、限定、语气或支持集。该完整payload不能由请求/候选临时生成后冒充可信记录。
- 每条旧声明的主证据生成 PUBLISHED_CLAIM 片段，所有 support_set 分别验证并生成 SOURCE_FRAGMENT 支持片段。跨块引文不能强行绑定一个块；应使用独立片段表达，否则明确拒绝。
- 旧声明的 id、value、scope、modality、比较符、单位、时间、support_set 及额外字段完整保留在 legacy_claims 侧车中，不重算身份。该侧车是兼容载荷，不是第二套正式声明格式。

输出包括原有 EvidenceSet、其全部片段来源派生的 basis、完整选中旧声明、claim_evidence 映射和 `semantic_support=NOT_CERTIFIED_BY_BRIDGE`。basis 反映证据包整体，最终答案的 basis 仍根据实际引用推导，两者不能混同。support_set 角色在侧车保留原词；转换后的 EvidenceFragment 仅使用原有 PRIMARY/CONDITION/CONTEXT，不能用简化角色覆写原始支持语义。

来源快照必须在 authority.allowed_snapshots，正文哈希和原文位置必须一致。每种列表和结果片段最多1024，序列化输入最大8MiB。纯函数不写索引、不创建学习、不调用数据库或模型。

## validate_answer_bundle

输入必含 context、question_spec、evidence_set、coverage_report、answer_result，learning_state=NOT_REQUESTED 时可省略 learning_intent；其他状态必须由服务提供 learning_intent。先以旧Schema检查各对象，再把它们注册到隔离上下文并运行旧语义约束，最后检查本次对象的引用互相一致。

- DOCUMENT 答案无需 claim；GRAPH/MIXED 由实际引用的证据 origin 推导，不接受自行指定错误 basis。
- 完整回答必须覆盖所有原子需求和条件收据，不能漏掉一个子需求仍填 ANSWERED。结论引用的证据必须属于其 requirement_ids 对应覆盖行的证据并集，且每项被引用需求至少有一个相交证据；不能用同EvidenceSet的另一段材料偷换覆盖依据。
- 请求的可信 base_ref 和 source_epoch 必须与答案、学习的来源快照一致，防止跨库或错epoch重用请求。QUERY 或未请求学习时，只允许 NOT_REQUESTED 且 task_ref=null。
- 允许答案 ANSWERED，同时后台 QUEUED 或 FAILED；LearningIntent 的状态、任务、来源和请求必须与答案一致。在旧0.1对象检查之外，桥要求 `authority.learning_tasks` 中有 task_ref、request_ref、question_spec_sha256、snapshot_sha256、status 完整匹配的可信任务记录；PUBLISHED 还要求任务 output_graph_revision、`authority.learning_commits` 的 COMMITTED 提交记录（commit_ref、task_ref、request_ref、question_spec_sha256、input_snapshot_sha256、output_graph_revision），并且输出图快照已在 allowed_snapshots 同库、同epoch、同sources范围中。记录必须来自服务持久化读取，纯函数不会创建任务或提交。
- 校验引用、覆盖和权限一致性不证明自然语言结论蕴含正确，不自动认证语义完整，也不代替真实的条件执行收据。

旧回答流程仍以 claim_ids 构造证据索引；此接缝为后续 P4 提供原文入口，不在 P1 接管该产品流程。P4消费旧声明时需要使用 claim_evidence 的完整支持集合，不得只引用主片段而把必需条件省略。

## 验证

`crates/lightog-demand/tests/evidence_bridge.rs` 使用已冻结原创合成资料，检查无图原文、旧声明身份与限定保留、多片段支持、虚假发布、来源过期、引文篡改、UTF-16代理对、回答/学习解耦、只读和覆盖防丢失。它们是契约边界检查，不是新抽取或问答质量实验。

已有生产旧声明可以包含有限小数，侧车应原样保留。共享需求的规范哈希仍采用0.1安全整数/DECIMAL政策，不能把带浮点旧侧车强行送入严格需求 canonical 哈希。实际RPC运输策略由统一服务边界决定。
