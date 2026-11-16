# LightOG Rust 内核

当前 Cargo workspace 包含三个内核；M1–M6 已接入独立 Rust 验收版，默认 4321 产品未切换：

- [`lightog-demand`](lightog-demand/README.md)：共享需求契约0.1的类型、确定性校验及JSONL接口。
- [`lightog-retrieval`](lightog-retrieval/README.md)：检索窗口选择的等价迁移、有界邻接及段落/表注片段补齐；新增独立lightog-context程序，词法排序与上游分块仍由现有JS提供。
- [`lightog-core`](lightog-core/README.md)：统一 M1–M6 生产兼容核心，覆盖本体/计划、事实/证据、检索/回答、增量保留及评审/发布纯规则；候选运行时没有 JS 域算法回退。

内核不调用模型、访问数据库或执行学习任务。历史 retrieval 优化不因本次迁移而自动采用；统一 core 复现冻结生产策略。后续算法模块按[先等价迁移Rust，再优化](../docs/rsi-rust-first-workflow-20261031.md)执行。

2026-10-31：M1–M6迁移及隔离集成验收完成，见[交付记录与验收入口](../docs/rust-core-migration-complete-20261031.md)、[迁移状态清单](../contracts/core-baseline-v0.1/manifest.json)。671项差分、106项Rust测试、544项产品测试通过。用户已确认统一验收完成，迁移阶段收口；后续方向待讨论，不自动开展算法优化；QF-01/QP-01等原业务缺口保持记录。

后续既有候选接入：冻结v6有限CQ编译器已迁入core，片段补齐v2通过原Rust实现接入4323；未达标候选继续排除。见[采用清单与接入验收](../docs/algorithm-adoption-20261031.md)。本轮没有新增算法优化。

实施与验证记录见 [Rust 需求内核首版](../docs/rust-demand-kernel-20261030.md)。
