# lightog-retrieval

隔离Rust检索内核，尚未被产品服务调用。窗口选择、评分排序、片段补齐及证据精筛的算法、输入校验和资源门禁在本crate；现有JS提供原文单元、分词/索引特征投影及跨进程适配。不存在调用JS实现算法的Rust壳层。

新增独立 `lightog-context` 程序提供段落/表注片段补齐，实现在 `src/fragments.rs`；旧baseline/adjacent函数仅增加模块导出，其选择逻辑保持不变。片段实验及新RPC见[fragments-v2](../../experiments/retrieval-context/fragments-v2/README.md)，仍未接入产品。

后续新增 `lightog-rank`（`src/ranking.rs`）和 `lightog-evidence`（`src/evidence.rs`），分别提供评分排序与证据归属精筛；JS仍保留原分词/NFKC/索引和实体提示投影。26题评分差分通过；精筛虽减少无关命中，也误删必要证据，本轮未采用。输入协议与结果见[隔离证据精筛实验](../../experiments/evidence-scope/v1/README.md)。以下旧baseline/adjacent协议保持不变。

独立 v2 为 `lightog-evidence-v2`（`src/evidence_v2.rs`），RPC `lightog-evidence-v2/0.1`。省略主体、跨句条件和表头归属的有界判断与不确定保留均在 Rust 执行；ADMISSION_ONLY、确定绑定、无binding的fallback、deferred/abstain分开，共用16000字符/128片段预算。38题真实对照的筛选误删24→6，仍未通过门槛、未接入产品，详见[v2实验](../../experiments/evidence-scope/v2/README.md)。旧模块不覆写。

结构单元新增 `lightog-evidence-units`（`src/evidence_units.rs`），长驻JSONL `build/compose`，索引按source/layout/policy绑定并跨问题复用。独立header/caption/note及多part续句可从旧covered外定向补取，结构关联不作语义确认。49题主补全保留83→90/106，但2条错误/12条不确定结构连接及6次依赖未闭合未过门槛，未采用。见[完整单元实验](../../experiments/evidence-units/v1/README.md)。

两个操作依次验证：

- `baseline`：等价复现当前JS必选证据窗口和最多四槽的正分数窗口补齐，保留排序顺序。
- `adjacent`：在基线之上优先选择同来源一跳邻窗的显式续文限定或表格续注；所有必选证据保留，预算不足明确deferred，不递归扩展。

内核检查来源SHA256、UTF16原文偏移、完整默认6000/400窗口目录、重复ID、解析章节及资源上界。目录按同一分块策略重建，不能通过删掉中间窗将远处内容伪装成一跳邻居。补入整窗的新增部分不得穿过解析章节边界。没有章节元数据时不声称语义归属保证。

## 构建和调用

仓库根目录执行：

```sh
cargo test --offline --locked --workspace
cargo build --offline --locked -p lightog-retrieval
node --test experiments/retrieval-context/v1/test.mjs
```

项目局部工具链配置见 [lightog-demand](../lightog-demand/README.md)。产物 `target/debug/lightog-retrieval` 从标准输入逐行读取JSON并逐行返回结果，不监听端口，不调用模型、数据库或学习任务。

RPC版本为 `lightog-retrieval/0.1`。请求含 `request_id`、`operation` 和 `payload`；payload包括sources及其解析blocks、完整units、evidence。baseline另含 `ranked_ids` 与 `positive_ids`；adjacent另含 `baseline_unit_ids`、`evidence_unit_ids` 和整数options。上游词法分数只转换成已有排名及正分数集合，不在内核中重新计算。

成功响应 `{request_id,ok:true,data:{unit_ids,evidence_unit_ids,adjacent_context?}}`；失败只返回错误码，不回显正文。JSONL复用需求内核的严格JSON规则：8MiB单条上限、重复键及非法Unicode拒绝；超限请求排空后仍可处理下一条。

算法是有限结构召回，不证明候选原文在语义上支持结论。显式引用/同表结构及限定词只是召回依据，不能直接发布为事实。后续[真实资料13案验证](../../docs/retrieval-context-real-v1-20261031.md)未发现覆盖改善，表注仍漏，当前继续保留旁路。

以上真实13案结论属于旧整窗候选；片段级新候选单独评测和归档，不覆写历史结果。

完整实验、冻结协议及统计见 [旁路目录](../../experiments/retrieval-context/v1/README.md)；后续模块按 [先迁移Rust再优化](../../docs/rsi-rust-first-workflow-20261031.md) 执行。
