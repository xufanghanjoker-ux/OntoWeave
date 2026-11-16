# 原生查询 Rust 等价迁移契约 v1

2026-11-06，用户授权先等价迁移、再做算法优化。本轮以 [JS 冻结基线](../../tests/native-query-rust-v1/freeze.json)为行为依据，排序、方向、条件、引用坐标、计算、默认参数、业务错误及分页行为不随语言迁移改变。协议升级与算法优化分开记录。

## 所有权与边界

- `native_query_search_v1.rs`：搜索投影、分词、词法评分、实体匹配、向量校验与余弦、RRF、结果排序。
- `native_query_graph_v1.rs`：主体知识过滤、定向邻接、有界路径。
- `native_query_compute_v1.rs`：算术、数字出现判断与 UTF-16 精确 span 校验。
- `native_query_v1.rs`：版本化分发。共享 core 仅新增模块注册，不改已有 P3 或构建语义。
- JS：授权数据 reader、采用资格读取、模型网络/缓存、发放引用、operation/事务、不可预测游标及工具/产品接缝。Agent 由原生 Codex 与原有检索 Skill 承担。

## 跨进程协议

沿用 `lightog-core/0.1` JSONL 外层，新增 `module:'native_query_v1'`。payload 为 `{contract_version:'lightog-native-query-core/1',input}`。成功 data 为 `{contract_version,operation,result}`；Host 同时核对 request_id、协议版本和 operation。业务错误 code 原样返回。

| operation | input | result |
| --- | --- | --- |
| search_prepare | rows,args,type,scope,embedding_enabled | query、scored、groups 及排序所需元数据 |
| search_finish | prepared,query_vectors | rows,mode,capability,query_embedding_spaces |
| search_validate_vector | values,space | 校验后的原向量 |
| entity_prepare / entity_status | subjects,args / prepared,items | 实体候选准备 / 歧义判断 |
| fact_rows | facts | 保留字段的搜索投影 |
| graph_entity_facts / graph_expand / graph_paths | facts,subjects,args,execution? | unavailable 或 items,binding,metadata |
| compute_value | operation,values,weights?,digits? | value |
| numeric_mention | text,value | boolean |
| evidence_span | content,start,end,quote | boolean |

Schema 以 Rust 校验及调用方同源实现为准，不作为可供模型任意调用的新工具。同步公共 API 在迁移期保持同步，当前桥接使用 `spawnSync`；常驻/异步传输、索引或缓存优化不混入本次等价验收。

## 构建与配置

运行 `node scripts/build-native-query-rust-v1.mjs`。离线、锁定 Cargo 依赖，输出到独立 `target/native-query-rust-v1`，不覆盖主线 core 二进制。生成的 `core-lock.json` 绑定二进制、Rust 源码和冻结基线 hash；源码在构建中变化则失败。

默认 client 读取该 lock；隔离测试可由可信宿主同时提供绝对路径 `NATIVE_QUERY_CORE_BINARY` 和 `NATIVE_QUERY_CORE_SHA256`，不能从 HTTP/模型参数指定。缺 binary、digest 不符、wire 不匹配或进程失败均拒绝，不自动编译、不退回 JS。

## 验收

先验证冻结基线与实际 Rust 的差分，再运行原生检索完整工程测试。非确定 cursor 值允许分别发放，但存在性、分页内容、完整性与拒绝行为必须一致。浮点差异若存在需按具体字段、误差与排序影响单列，计算结果与派生引用不能笼统容差。非法 JSON wire 的技术边界单独记录，不宣称输入放宽。

本轮不调用业务 LLM，不修改合成金标，不切换共享产品默认入口，不宣称检索效果或时延提升。后续优化必须与本次 Rust 基线对照评测。

最终工程验收：114/114 测试、820/820 严格差分，见[迁移结果](../../docs/lightog-native-query-rust-equivalence-results-20261106.md)。冻结模型/Unicode/平台环境见 baseline manifest；新增数学与 Unicode 兼容模块保持原 JS 行为。相关第三方许可随源码保留在[说明](THIRD_PARTY_NOTICES.md)及 V8-LICENSE.txt。
