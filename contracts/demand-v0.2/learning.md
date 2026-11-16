# P1 后台学习生命周期契约

版本 `lightog-learning/0.2`，实现 `lightog-demand::learning_contract`。新增 LearningJob 包裹原有 `lightog-demand/0.1` LearningIntent，不替换原有需求、证据和回答格式。本模块只有纯校验与转换结果，没有队列、模型、存储写入或运行任务。

## 对象和旧状态映射

LearningJob 包含 intent、细分 stage、revision、dimension_sha256、policy_version、scope 和 commit_receipt_ref。scope 分别记录 checked_unit_ids 和 unsearched_unit_ids，二者不重叠；工作完成不代表语义穷尽。

| stage | 旧 intent.status |
| --- | --- |
| NOT_REQUESTED | NOT_REQUESTED |
| QUEUED、RETRIEVING、DEFERRED | QUEUED |
| EXTRACTING、VALIDATING、COMMITTING | RUNNING |
| COMPLETED | PUBLISHED |
| WAIT_EVIDENCE、WAIT_REVIEW、FAILED | 原同名状态 |
| STOPPED、SUPERSEDED | CANCELLED |

RETRIEVING 表示读取候选原文，允许尚无准入证据；进入 EXTRACTING 及以后工作必须有实际证据。未来服务若需把旧回答的 RUNNING 区分为正在检索，应消费细分 stage，不能改写旧 intent 的含义。

## validate

`execute("validate", {job,trusted_context[,trusted_runtime]})` 检查结构、原需求/证据引用、库/来源epoch、权限和状态映射。无 runtime 时不认证任务已持久化，返回 task_existence_certified=false。它不是执行指令，也不替代 transition 的选窗检查与 CAS。

COMPLETED 必须额外提供完整 trusted_runtime，并匹配其实际存储的任务摘要、修订号、当前来源和提交收据。单填 commit_receipt_ref 或 PUBLISHED 字符串不能通过。即使纯函数核对通过，可信记录和真实事务的所有权仍属于服务。

## transition

输入 previous、next、trusted_context、trusted_runtime，使用 `learning.schema.json` 严格检查全部字段。trusted_runtime 由服务读取：

- current_snapshot：当前来源和图状态。
- persisted_job_sha256、persisted_revision：真实存储的旧任务内容和修订号，用于比较并交换。
- scope_unit_ids 与 units：服务确定的选择范围和单元目录。每个单元绑定来源、版本、正文哈希及 UTF-16 范围。
- commits：真实提交收据，含任务、输入快照摘要、知识维度、输出图版本、索引 manifest 和 READY/PENDING 状态。

正常转换要求修订号加一，任务/请求/需求/来源/知识维度/策略保持身份，阶段不跳跃，已查范围与准入证据不被无记录删掉。选窗全集与可信单元目录一致，每份准入证据必须完整落在所选同源单元区间并集内；仅保存一个证据ID不能代替选中其实际原文。

活跃转换要求当前来源一致；提交前图基版变化须重新验证或重新排队，不能覆盖新图。COMPLETED 需要服务收据绑定任务、输入快照、维度和实际输出图；索引 READY/PENDING 分开返回，不能把图提交误报为索引已就绪。

来源撤回或删除后允许将可信存储的原任务关闭为 SUPERSEDED/STOPPED/FAILED。该分支只核对旧任务摘要、形状和身份，不再次授权历史证据，也不允许更改工作范围或准入证据。服务无需把撤回快照重新登记为当前有效，仍可正常收尾。

输出包含 job、idempotency_key、commit、answer_effect=UNCHANGED、semantic_completeness=NOT_PROVEN 和 execution=VALIDATED_NOT_PERSISTED。幂等键绑定需求、来源快照、知识维度与策略；跨问法复用仍需要后续需求映射，不根据句子相似自动合并。

终态不自动重启；新的来源或修订生成明确的新任务/收据链。服务必须在事务中再次比较旧任务修订号与来源/基版，再提交转换。预校验通过不代表数据库提交完成。

## 验证范围

17 项合成契约测试覆盖只读、准入、CAS、方向性状态转换、身份/范围保护、必选原文覆盖、来源撤回、图基版变化、完成收据及严格输入。它们不证明真实队列调度、语义学习收益或产品前后台解耦已经实现；这些留给 P5 和端到端验收。
