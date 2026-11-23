# OntoWeave 安装与启动

`v0.2.0-alpha.2` 是面向 macOS 本机单用户的源码预览版。PostgreSQL 保存工作空间、知识版本、检索索引及问答会话。

## 准备环境

| 依赖 | 要求 |
|---|---|
| Node.js | 22.22+（22.x）或 24.15+（24.x） |
| Rust | 使用仓库中 `rust-toolchain.toml` 指定的工具链 |
| Python | 3.12，将 API 和 Docling 安装在两个环境中 |
| PostgreSQL | 本机 Unix socket，已安装 pgvector。验收环境使用 PostgreSQL 17.5 与 pgvector 0.8.0 |
| Codex CLI | 本版针对 `0.171.0-alpha.13`，安装时核对本机协议 |

## 安装

在解压或克隆的 OntoWeave 源码目录执行。

```sh
umask 077
mkdir -p .ontoweave
npm ci
cargo build --locked -p lightog-core
python3.12 -m venv .venv-pg-cq
.venv-pg-cq/bin/python -m pip install -r requirements-pg-cq.lock -r python/ontoweave_api/requirements.lock
npm run setup:parser -- --yes
```

解析环境安装 Docling 和分词器，首次准备会下载所需的公开解析权重与分词数据。已有匹配版本的 Codex CLI 可直接使用。以下命令在 Apple Silicon 上将 npm 发布的 [Codex CLI 0.171.0-alpha.13](https://www.npmjs.com/package/@openai/codex/v/0.171.0-alpha.13) 安装到本项目的私有运行目录。

```sh
npm install --prefix .ontoweave/codex-cli --no-audit --no-fund @openai/codex@0.171.0-alpha.13
```

## 配置本机工作台

在你的 PostgreSQL 实例中创建空数据库 `ontoweave_publication_product_real`，并在该数据库启用 pgvector。连接角色需要能够创建应用 schema 和表，并读取 `pg_control_system()` 和服务器的 `data_directory` 设置，以核对启动目标实例。以下命令使用当前终端选择的本机 PostgreSQL 实例。

```sh
createdb ontoweave_publication_product_real
psql -d ontoweave_publication_product_real -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

如果连接角色是专用的普通角色，由管理员把它设为这个数据库的所有者。可以授予该角色 `pg_read_all_settings`，以及当前数据库中 `pg_catalog.pg_control_system()` 的执行权。工作台使用这些权限核对连接的实例。

```sh
cp configs/workbench.example.json .ontoweave/workbench.json
```

在 `.ontoweave/workbench.json` 填写同一实例的 Unix socket 目录、端口和数据库角色。需要数据库密码时使用 PostgreSQL 的 `.pgpass` 或 `PGPASSFILE`。随后生成本机配置和 Codex 运行锁并启动。

```sh
npm run setup:workbench -- --config .ontoweave/workbench.json --codex "$PWD/.ontoweave/codex-cli/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"
npm start -- --config .ontoweave/workbench.json
```

如果你已单独安装同版本原生二进制，使用实际路径替换上面的 `--codex` 参数。

打开启动日志显示的本机工作台地址，在「设置」保存受支持的千问北京服务凭据，然后新建工作空间。当前验收配置使用 `qwen3.8-flash` 与 `qwen3.7-text-embedding-flash`，向量维度为 1024。

## 验证一轮

新建空间并上传一份短 Markdown。确认图谱发布后，在资料目录打开正文；从问答发起一个原文可以回答的问题，点开引用回看来源。接下来可以在同一空间追加或替换资料，核对发布后的图谱和资料目录。

备份时同时保留 PostgreSQL 数据库与本机运行目录。后者包含设置、凭据及运行产物。详见[安全说明](../SECURITY.md)和[版本说明](RELEASE_NOTES.md)。
