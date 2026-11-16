# OntoWeave 安装与启动

当前版本为 `v0.1.0-alpha.1`，验证目标为 macOS 本机可信单用户。Linux、Windows及企业生产部署尚未完成验收。

## 环境准备

| 依赖 | 要求 |
|---|---|
| Node.js | `>=22.22 <23` 或 `>=24.15 <25` |
| Rust | 使用仓库中的 `rust-toolchain.toml` |
| Python | 3.12；解析依赖使用独立环境 |
| Codex | 仅支持 `0.169.0-alpha.11.1`，需匹配本机协议锁 |

Codex可执行程序需自行安装，本项目不分发桌面应用内二进制。无法取得上述匹配版本时，此Alpha的Agent链路不可用，不可删除或绕过运行锁。

## 安装

```sh
git clone https://github.com/xufanghanjoker-ux/OntoWeave.git
cd OntoWeave
npm ci
cargo build --locked -p lightog-core
npm run setup
npm run setup:runtime -- --codex=/absolute/path/to/codex
npm start
```

`setup`会提示安装独立Python环境与解析依赖，首次解析可能下载模型权重。`setup:runtime`生成本机协议锁，不调用模型。

## 配置与使用

打开 **http://127.0.0.1:4332/**，在设置中配置生成与Embedding服务，然后创建工作空间并上传资料。

生成服务需兼容当前Codex提供方路径；普通Chat Completions兼容不足以证明可用。现有真实生成调用使用Qwen北京服务的 `qwen3.8-flash`，其他服务与型号待验证。

本机配置和数据保存在 `.ontoweave/`。可以通过 `CQFORGE_PORT`、`CQFORGE_STORAGE` 指定端口和存储目录。旧LightOG/CQForge环境变量及内部标识保留兼容，旧工作空间不自动迁移。

## 验证边界

首发副本已检查锁定npm依赖安装、Rust与前端构建、Codex协议准备、空库启动及所选6项测试；未在该副本重跑完整Python解析环境与模型权重安装，或真实模型全链路。

抽取完整性、实体归一、事件表达及恢复体验仍在迭代。保存成功、图已显示和部分结果可读不代表知识完整或正确。见[版本说明](RELEASE_NOTES.md)。

仅用于本机可信单用户。资料、知识和诊断可能明文保存；不要公开本机端口，或提交密钥、业务资料、数据库和模型权重。见[安全说明](../SECURITY.md)。
