# lightog-core

LightOG现有确定性核心的Rust兼容实现，覆盖约定的M1–M6。它不调用模型、访问数据库或自行发布知识。模型/HTTP/任务编排和可信事务适配由Node承担。

统一验收运行程序：`target/release/lightog-core`。完整交付与验收记录见 [迁移总报告](../../docs/rust-core-migration-complete-20261031.md)。

## 运行协议

默认从stdin逐行读取请求，stdout逐行返回响应；`--json`读取一个可以带缩进的JSON文档。请求：

```json
{"wire_version":"lightog-core/0.1","request_id":"example","module":"primitives","operation":"hash","payload":"abc"}
```

成功：`{request_id,ok:true,data}`；失败：`{request_id,ok:false,error:{code,message,details}}`。拒绝重复字段、非法JSON/Unicode及超过32MiB的请求；核心生产兼容层支持有限小数，与需求契约的整数/DECIMAL规范是不同层次。

模块：`demand`、`model`、`evidence`、`structure`、`retrieval`、`learning`、`review`、`governance`、`capability`、`answer`；`primitives`用于兼容验证。接口清单：

- `MODEL_EVIDENCE_STRUCTURE_API.json`
- `M6-API.md`
- `contracts/core-baseline-v0.1/m4-m5-api.{md,json}`
- `contracts/core-baseline-v0.1/answer-api.{md,json}`

生产适配使用常驻JSONL子进程；Node主线程同步等待独立传输worker，不向Rust传递数据库句柄或模型客户端。所有域判断均执行Rust操作；进程失败明确报错，不回退旧JS算法。

## 构建与验收

```sh
cargo build --release --offline --locked -p lightog-core
cargo test --offline --locked --workspace
npm run verify:rust
```

项目局部工具链沿用 [lightog-demand](../lightog-demand/README.md) 的环境配置。首次在其他机器构建时需先按Cargo.lock取得依赖；当前工作区已具备缓存。验收脚本同时使用现有Python参考校验与解析环境。

固定671项数据/错误回放、106项Rust测试和544项产品测试已通过。这里的“通过”按总报告中明确的跨语言错误映射计算，不声称原生错误栈或所有可能输入都逐字节相等，不代表模型语义质量提升。
