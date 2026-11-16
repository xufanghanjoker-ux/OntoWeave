# lightog-demand

2026-10-31新增M1隔离入口 `lightog-production-demand`：迁移生产范围、结构意图和查询意图校验，并提供保留旧数据的共享契约适配。它不改变下述原CLI版本，也未接入产品。运行 `npm run verify:m1`；细节与可手动验证样例见[M1验收说明](../../docs/m1-production-demand-20261031.md)。

共享需求契约 `lightog-demand/0.1` 的首个 Rust 实现。内核执行确定性检查：Schema、跨对象引用、需求依赖无环、条件与角色的局部绑定、来源哈希与原文位置、覆盖收据及请求权限的一致性。

原有校验接口不生成 QuestionSpec，不判断中文理解或证据是否真正支持结论，也不检索、推理、调用模型或发布图谱。新增M1仅对非知识意图作直接映射；知识问题不猜原子绑定。模型与现有 Node 产品链路尚未调用本 crate。

## 构建与检查

从仓库根目录执行。`rust-toolchain.toml` 固定本次验证的 Rust 1.99.1，依赖由 Cargo.lock 固定：

```sh
cargo test --locked
cargo build --locked
node scripts/test-demand-rust.mjs
```

若使用本次安装的项目局部工具链，先执行：

```sh
export CARGO_HOME="$PWD/local-runs/rust-toolchain/cargo"
export RUSTUP_HOME="$PWD/local-runs/rust-toolchain/rustup"
export PATH="$CARGO_HOME/bin:$PATH"
```

依赖已缓存时可给 Cargo 加 `--offline`。对照脚本使用现有 `.venv-docling312/bin/python`，需要 Python 的 jsonschema 包。可用 `LIGHTOG_DEMAND_PYTHON` 和 `LIGHTOG_DEMAND_BIN` 指定解释器及编译后的二进制。

## 调用边界

`target/debug/lightog-demand` 从标准输入逐行读取 JSON，请求和响应各占一行；不监听网络端口。例子：

```json
{"wire_version":"lightog-kernel/0.1","request_id":"demo-1","operation":"canonical","payload":{"b":[2,1],"a":null,"text":"甲😀"}}
```

成功返回 `{"request_id":"demo-1","ok":true,"data":...}`；失败返回 `{"request_id":...,"ok":false,"error":{"code":"..."}}`。严格 JSON 解析失败时 request_id 为 null。错误响应不包含原文；成功的 canonical/span 响应会按请求返回文本。

| operation | payload / 附加字段 | data |
| --- | --- | --- |
| canonical | 任意满足规范字节约定的 JSON 值 | canonical_utf8、sha256 |
| span | `{text,span:{start,end,quote?}}` | text、utf8_start/end、utf16_length、utf8_length |
| validate | 契约对象；顶层额外传 definition、context | definition |

validate 的 context 结构是 `{examples:{名称:契约对象},source_texts:[...],authority:{...}}`。本轮完整合成示范见 `scripts/test-demand-rust.mjs`。definition 对应 Schema 的 `$defs` 名称，主要对象为 QuestionSpec、CQFamily、EvidenceSet、CoverageReport、LearningIntent、AnswerResult 和 DemandEnvelope。

库调用顺序：`wire::strict_load` → `ValidationContext::from_value` → `Kernel::validate`。直接 serde 反序列化类型不能替代校验，尤其不能保证缺失的必填 nullable 字段得到拒绝。

## 信任与资源约束

context 必须由可信调用端从已验证的对象、实际来源快照、请求权限和发布收据中组装。当前构造器检查结构、标识冲突和部分注册表形状，不递归证明所有 context 对象的业务有效性，也不认证调用者。把 context 交给模型自行提供会使权限和来源检查失去意义。该 CLI 仅用于隔离验证，不能直接作为允许不可信输入自报 authority 的产品接口。

当前 source_texts 每个 source_ref/source_revision 对应一段完整提取文本和一个 block_ref；尚不是生产分块索引适配器。original_utf8_text 仅适用于合成文本测试，生产 PDF/Word 原始字节哈希需由可信资料适配层提供。

单条输入 JSON 上限 8 MiB，容器嵌套深度上限 96。UTF-16 使用半开区间；拒绝截断 emoji 代理项。严格拒绝重复字段、BOM、浮点/指数数字、负零及超过 JS 安全范围的整数，DECIMAL 使用契约规定的字符串。不得更改原文的 Unicode 规范化和换行。多个错误同时存在时不承诺所有实现的报错优先级一致。

进程启动时编译内嵌 Schema，依赖禁用远程 Schema 解析功能。此版本未测量生产吞吐量，验证时传递完整 context 也不是最终增量缓存方案。
