# OntoWeave

Temporal knowledge graphs and traceable memory for people and agents.

为人和Agent构建可追溯、持续演化的时序知识图谱。

**0.1.0-alpha.1 · 本机单用户Alpha预发布。** 抽取完整性、实体归一和事件表达仍在迭代，不承诺生产可用或基准领先。

## 工作方式

上传资料 → Docling解析 → 结构与token分块 → CQ发现 → 按需归族 → Codex语义抽取 → 程序接收和保存 → 局部对齐 → 图谱与索引。

原生Codex承载Agent和Skill；Rust处理事实版本与双时间读取，SQLite保存本机数据。图谱展示对象、关系、属性及来源；对话支持流式回答、Markdown和引用回溯。局部失败保留有效产物并记录缺口，任务完成不代表知识已正确。

## 安装与启动

首发验证目标为macOS本机。Linux、Windows尚未完成安装验收。需要Node.js 22.22+或24.15+、Rust工具链、Python 3.12及原生Codex可执行程序。

```sh
git clone https://github.com/xufanghanjoker-ux/OntoWeave.git
cd OntoWeave
npm ci
cargo build --locked -p lightog-core
npm run setup
npm run setup:runtime -- --codex=/absolute/path/to/codex
npm start
```

setup会提示安装独立Python环境与解析依赖，首次解析可能下载模型权重。setup:runtime仅生成本机协议锁，不调用模型。

当前运行验证的Codex版本为**0.169.0-alpha.11.1**，不承诺任意最新版兼容，也不分发桌面应用内二进制。无法取得匹配版本时，此Alpha的Agent链路不可用，不能通过删除运行锁绕过。

打开 **http://127.0.0.1:4332/**，在设置中配置生成与Embedding服务，创建工作空间并上传资料。生成服务需要兼容当前Codex提供方路径；只支持普通Chat Completions不足以证明可用。现有真实调用使用Qwen北京服务的qwen3.8-flash及Embedding，其他服务待验证。

运行配置与新数据保存在`.ontoweave/`，不进入源码发布。可用CQFORGE_PORT、CQFORGE_STORAGE指定端口和存储目录；旧数据不自动迁移。旧LightOG/CQForge包名、协议标识和环境变量保留兼容。

## 开发与限制

```sh
npm run check
npm run build:web
```

本地已有缓存不等于干净安装已验证。首发安装检查仍需结算，见[版本说明](docs/RELEASE_NOTES.md)。MCP、行动反馈等研究方案不等于正式交付。存在文本或未绑定值不等于图可直接回答。

仅用于本机可信单用户。资料、知识及诊断可能明文保存；不要公开本地端口，或提交密钥、业务资料、数据库和模型权重。见[安全说明](SECURITY.md)。

## 许可证

采用[Apache-2.0](LICENSE)。第三方依赖和字体保留各自许可证，见[第三方许可](THIRD_PARTY_NOTICES.md)。设计研究参考Utopia、Graphiti和LightRAG。
