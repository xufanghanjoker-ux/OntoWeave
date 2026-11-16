# 核心契约衔接清单 0.1

状态：M1–M6生产兼容迁移与隔离集成已完成；目标复合计划仍为设计。总结果见[交付与验收记录](../../docs/rust-core-migration-complete-20261031.md)，历史路线见 [核心 Rust 基线](../../docs/core-rust-baseline-20261031.md)。

本目录只组织已有契约与待补接口，不修改 `demand-v0.1`，不改变现有 JSONL 请求版本。

实施更新：M1独立兼容进程 `lightog-production-demand/0.1` 保留；见[M1适配与验证](../../docs/m1-production-demand-20261031.md)。新增统一生产兼容RPC `lightog-core/0.1` 并接入独立验收版；它不升级领域需求契约，不实现目标复合计划协议。默认产品未切换。

## 对象衔接

| 统一概念 | 当前生产表示 | 既有契约/实现 | 迁移决策 |
|---|---|---|---|
| 问题与原子需求 | cqs、结构意图、query requirements 等 | demand-v0.1 QuestionSpec；lightog-demand 校验 | 显式适配；不猜测缺失条件，不将旧模板当完整需求 |
| 同族问题 | internal_learning_scope、可选 CQ proposal | CQFamily 已设计并有隔离校验 | 来源和槽位绑定明确；完整生产适配尚待实现 |
| 本体定义 | schema.entity_types/entities/predicates；schema 内还混存 cq_plans | validateSchema 等现有 JS | 基线保留格式与 ID，目标层区分本体和计划；不在迁移时自动赋予继承、公理或身份等价 |
| 查询计划 | schema.cq_plans：每 CQ 恰好一条有限模板 | validateSchema / answerPlan | 先等价迁移；多 requirement 计划包属于版本化升级，尚无可执行新 Schema |
| 候选事实 | claims + quote/support_set/scope/time 等 | validateClaims、structure-learning、alignQuote | 迁移原文定位与类型规则；原样 scope 不冒充已结构化条件；新条件/否定表示另列升级 |
| 原文及已发布图证据 | source-context、claim 证据包、有效资料快照 | EvidenceSet / SourceSnapshot | 来源版本绑定，区分 SOURCE_FRAGMENT 与 PUBLISHED_CLAIM；候选事实不能伪装成已发布证据 |
| 覆盖与处理范围 | CQ 结果、阶段回执、extraction ledger | CoverageReport | 显式逐需求、主体和条件映射；缺失标明未覆盖，不能默认 SATISFIED |
| 前台答案和后台学习 | answer、observation、learning job | AnswerResult / LearningIntent | 两条状态独立；仅服务端可信请求决定是否允许学习 |
| 校验与发布结果 | gate、issues、READY、版本事务 | evaluator-gate、governance、component-publication | 算法建议与事务提交分开；READY 不等于 PUBLISHED |

## 版本与数值边界

- `lightog-demand/0.1` 是领域契约版本；`lightog-wire/0.1` 是该契约文档中的跨语言规范。
- demand CLI 当前实际请求使用 `lightog-kernel/0.1`，retrieval CLI 使用 `lightog-retrieval/0.1`；原独立程序继续保留版本。统一生产兼容RPC另用 `lightog-core/0.1`，通过显式适配接入。
- 本目录的 `core-baseline-plan/0.1` 只标识清单格式。统一运行接口见[core说明](../../crates/lightog-core/README.md)，不让旧调用静默进入新协议。
- 旧 ID、JSON.stringify 摘要与 lightog-cjson 摘要分别保存，禁止全库静默重算。小数、null/缺失字段和 Unicode/UTF-16 位置必须有往返样例；无法无损映射时显式失败或保留版本化旧表示。
- 可信原文、来源版本、权限和发布收据由服务适配层提供；模型生成的同名字段不构成授权和有效性证明。

## 复合计划设计方向

一个问题对应一个计划包；每个原子需求必须绑定叶子计划或明确缺口。聚合节点只能组合已定义叶子，不得绕过条件。多个目标不通过重复 cq_id 的旧计划数组实现。

`design-examples.json` 的局部 requirement、leaf 和 condition 字段仅为人工审阅用缩略表示，不是 QuestionSpec、CQFamily 或任何现有 Schema 的合法完整实例。示例中的实体/谓词绑定为人工设定的目标设计，不是已验证抽取结果；不包含可运行计划或真实处理收据。

具体复合计划 JSON Schema、编译器与旧计划转换仍未实现。生产兼容RPC已有实现和API清单，不能将其与这些领域协议升级混为一谈。
