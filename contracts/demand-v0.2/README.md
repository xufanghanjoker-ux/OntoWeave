# P1 共享契约扩展与 Rust 接缝

本目录扩展而不替换 [demand-v0.1](../demand-v0.1/README.md)。QuestionSpec、CQFamily、EvidenceSet、CoverageReport、LearningIntent、AnswerResult 和已有身份继续采用原格式；新对象独立版本化。P1 已实现离线 Rust 校验与统一 debug RPC，尚未接管产品问答、抽取、向量检索或后台任务。

| 模块 | 新接口 | 实现与边界 |
| --- | --- | --- |
| [证据与回答](evidence-bridge.md) | compose、validate_answer_bundle | 直接原文、旧完整声明、覆盖和学习状态的安全消费 |
| [候选与索引](knowledge.md) | validate、index_transition、validate_index_set | 新关系提案、派生描述、索引空间和切换写计划 |
| [学习生命周期](learning.md) | validate、transition | 准入、范围、版本、CAS、撤回和提交收据 |
| 来源上下文 | ValidationContext::from_value_v2 | 原件与正文分开、多块目录与精确位置 |

统一进程信封保持 `lightog-core/0.1`，module 分别为 `p1_evidence`、`p1_knowledge`、`p1_learning`；operation 和 payload 见对应文档。构建 `target/debug/lightog-core` 后可通过 JSONL 调用。RPC 只面向服务内部，不是让模型自行认证 authority 的公共接口。

## 来源上下文扩展

旧 from_value 继续接受五字段文本原件 fixture。显式使用 from_value_v2 时，同时支持新 source_texts 行，字段由 [source-context.schema.json](source-context.schema.json) 定义：source_ref、source_revision、text、original_sha256、parser_version、blocks。

服务从真实原件核验 original_sha256，Rust 从原样解析正文核验 text_sha256。不能对正文哈希后冒充 PDF 原件哈希。blocks 中每项有唯一 block_ref 及 UTF-16 半开区间，位置必须处于正文合法边界；原文不做规范化。

证据必须落在其登记块内。旧声明未携 block_ref 时，选择唯一最小的包含块；没有包含块或同宽歧义明确拒绝。服务可以显式登记真实解析块或有来源依据的窗口，不能为通过校验临时伪造块归属。跨块支持以独立片段表达。

CoverageReport 使用登记的全部块构造 checked/unsearched 全集。跨来源同名 block_ref 明确拒绝，服务需要提供稳定的来源命名空间，不能靠集合去重隐藏遗漏。

来源有效集合、发布载荷、任务和索引/提交收据从可信服务状态读取。Rust 检查这些输入之间是否一致，不从 JSON 中“可信=true”得到权限，不证明原件字节已由服务正确验证，也不认证自然语言蕴含。

## 兼容与验收

不重算旧 claim ID；旧有限小数载荷完整保存在兼容侧车中；只对共享协议对象采用既有安全整数/DECIMAL 和规范哈希。新增定义不假装已完成旧计划的复合执行能力。

复跑 `npm run verify:p01`。验证包括 65 项新增契约测试、既有 Rust workspace、671 项原始响应差分、67+21 项采用能力差分、9 项独立边界检查和成本账本。完整结果与源码/二进制哈希按运行保存在 local-runs，不改写旧交付报告。
