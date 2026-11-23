# OntoWeave PostgreSQL 工作台

`unified-workbench-v2.mjs` 启动新版界面，`ontoweave-pg-gateway.mjs` 提供本机网关。`unified-workbench-v2.assets.json` 列出会部署的页面资源。

- [安装与启动](../docs/GETTING_STARTED.md)

`npm run check` 检查启动与前端入口。运行 `npm test` 会在禁用 Node SQLite 的环境中验证事实接收以及工作台资源。解析自检通过 `npm run setup:parser -- --yes` 执行。
