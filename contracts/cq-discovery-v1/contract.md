# LightOG CQ-0/CQ-1 冻结契约 v1

日期：2026-11-05。依据：`docs/lightog-codex-foundation-cq-implementation-v1-20261104.md`。本契约只冻结离线开发接缝，未声明 Codex、MCP、Skill 或千问完整循环通过。

`stage-submission.schema.json` 定义提交的 JSON 结构；`runtime-port.d.ts` 定义项目运行端口；`web/cq-discovery-host-v2.mjs` 执行引用、读取、幂等、版本和状态检查。Schema 本身不校验语义、事实、来源支持或关系完整性。

1. 任务、资料和工作计划

- 宿主 `create({library_id, request_id, expected_source_epoch, purpose?, seed_questions?, budget?})` 冻结资料快照，生成任务、草案和工作单元 ID。相同请求与内容返回原任务；相同请求改变内容返回 `REQUEST_CONFLICT` 并留事件。未确认的已发请求阻止同库用新请求 ID 绕过。
- 服务端 `loadLibrary(libraryId)` 提供已保存的可信资料；不得直接接入 Agent 自报的解析对象。现有产品可用 `createProductDocumentCatalog({store,governance,runtime})`，只调用 `runtime.sources` 和 `governance.baseFor`，不调用 `runtime.view/ask`、回答准备、图谱、Embedding。
- 文档修订对标题、正文、完整解析元数据和来源修订取哈希；快照另绑定库、source_epoch 和文档集合。原件哈希、解析器版本、结构块保留。Docling 使用已有 `hydrateSource` 校验；TXT/MD 从保存正文生成段落块，不运行新解析器。
- 初始每文档一个 `CQ` 单元，另有一个全局 `FAMILY` 和一个 `SCOPE` 单元。发现采用显式 `SELECTIVE_BODY` 计划；至少读到每份指定文档的正文片段才能提交。执行完成只表示该选择性计划结束，不能宣称全文已读或 CQ 穷尽。完整/部分实际读取从持久 read 收据计算。
- 原始示例问题保存在任务的 `seed_questions`。阶段将其标记 `USER` 时须与原始问题一致；`DOCUMENT / USER / MODEL_IDEA` 分开。种子问题不因被保存而成为文档已支持的知识。
- `plan_change_request` 是可选建议。CQ-1 仅接受 `ADD_DISCOVERY`，字段为 `action/doc_ids/reason`；宿主生成新增单元、保留全部原单元和计划历史，并使依赖投影待重做。拆分、合并、删除建议均记录拒绝，待 CQ-4。

2. 资料工具

| 工具 | 参数 | 收据与限制 |
| --- | --- | --- |
| `lightog_list_documents` | `snapshot_id,cursor?,limit?` | 每页最多20文档，不含全文；每文档最多32目录项，截断可见。 |
| `lightog_read_document_units` | `snapshot_id,doc_id,revision,block_ids?,cursor?,max_chars?` | 正文256—12000 UTF-16单元、最多32块；长块可继续分页，不切断代理对。返回块内实际区间、标题、表头和截断标记。 |
| `lightog_search_documents` | `snapshot_id,query,cursor?,limit?` | 字面子串、不用向量；每页最多20命中。CQ 仅搜指定分区，B/C 可搜快照。只读命中不等于全文阅读。 |
| `lightog_submit_cq_stage` | 见 Schema | 原件先入库，再尝试投影；无答案或精确证据要求。 |
| `lightog_finalize_cq_draft` | `expected_draft_revision,unfinished_reason?` | SCOPE 上下文可请求完成；宿主核对计划、依赖、在途与未知状态。 |

`taskId/workUnitId` 由宿主绑定到工具上下文。目录可列出本快照全部文档，CQ 正文和搜索按单元分区。模型参数不能加入 task_id、路径、SQL、其他库或发布动作。所有错误为 `{ok:false,error:{code}}`；返回内容和请求参数一并存为读取收据。搜索为全文扫描得到有限命中，不作语义召回承诺。

这是可供 MCP 接入的本地域工具适配器，**尚不是 MCP 传输服务**。文档正文只是数据，不能提升工具权限；真实运行时的默认终端、任意文件和网络工具隔离仍须 CQ-2 验证。

3. 阶段、ID 和依赖

- 公共字段：工作单元、`stage`、快照、上游 `{artifact_id,version:1}`、预期草案修订、幂等键和 payload。CQ 另绑定 `input_read_refs`。每份原件是独立 ID 的不可变版本1，不原地升级。
- 模型提交 `local_key`，宿主原子分配业务 ID。收据的 `assigned_ids` 按 `cq/family/subject/scope` 分类映射，局部键只在各自集合中唯一。SCOPE 的局部主体引用仅解析为同次主体集合；后续引用本次输入 ID，不凭名称合并实体。
- CQ payload：`items[]`（问题、知识目标、origin 必填），可加 `open_questions`。FAMILY payload：`families[]`、`unassigned_cq_ids[]`；每条当前 CQ 必须归入至少一族或明确未归族。允许多对多映射。
- SCOPE payload：`subject_candidates[] / scope_candidates[] / unresolved_family_ids[]`。每个当前族须有范围建议或明确未决。`subject_bindings` 保留槽名、顺序及集合成员；缺必要槽不可伪装完整组合，可把该族保留未决。主题模板可以没有槽。
- FAMILY 绑定当前全部 CQ 产物；SCOPE 绑定当前全部 CQ 与 FAMILY 产物。更新一个 CQ 单元只替换其集合，其他 CQ 单元取并集。后续依赖失效时从当前投影移除，保存 `DEPENDENCY_REDO_REQUIRED` 事件，历史原件和草案修订继续可读。
- `expected_draft_revision` 冲突先归档。仅当该单元的基准头未变、来源和语义依赖一致时，独立单元可在宿主事务中本地重基。其他已知返回可显式调用 `reproject`；不会调模型，依赖改变则拒绝。
- 同幂等键、同完整信封哈希返回原收据；同键不同内容保留冲突原值，不覆盖。改变预期修订或读取收据也属于不同内容；须新键或显式本地重投影。
- 字段/引用错误只拒绝此次应用，合法信封的原件继续保留；未知工具、未知阶段和越权信封直接拒绝。

4. 来源线索与草案

`source_hints[]` 可以为空；非空至少 `doc_id/revision`。缺块为 `UNLOCATED`，合法块为 `VALID`，错误文档/修订/块为 `INVALID_REF`，原值保留、不猜位置。`VALID` 只说明引用可解析。来源变化使整份旧草案读视图为 `STALE`；不是改写旧原件。

草案固定 `status=DRAFT`；`validity=CURRENT/STALE` 与 `completion=PARTIAL/COMPLETE` 独立。集合为 CQ、族、主体候选、组合、未归族、未决及 open_questions。宿主强制 `identity_resolution/fact_verification/graph_publication = NOT_PERFORMED`。任何阶段不能设置 READY 或写入旧严格发布计划。

任务状态为实施文档中的九态。所有计划单元均有当前有效产物、无在途或未知请求时才能 `SUCCEEDED`；否则保留 `PARTIAL/UNKNOWN_HOLD/CANCELLED/STALE/FAILED` 及剩余单元。资料过期、取消、未知、失败分别追加事件，事件有每任务单调序号；最新状态不删除旧事件。

取消先提交 SQLite，再调用 interrupt；迟到产物仅归档。进程重启通过 `recover` 将未结算预约归为 UNKNOWN，保留预约用量并停发；既有产物仍可查。不实现未知自动重放，也未实现远程状态查询或人工解除未知门禁。

5. 存储与运行边界

复用 `store.mjs` 的 SQLite `workbench_records` 与同步 `BEGIN IMMEDIATE` 事务，不改数据库 schema。所有新记录前缀为 `cq_v2_`：snapshot、task、request、head、plan、artifact、submission、projection、draft、read、event。artifact/read/event/draft/plan 只追加；task/head 是可变指针。原件 JSON 直接持久存入独立记录，首版没有附件搬迁。

`legacy_v1` 仍为默认；`runOfflineCQTask(..., mode:'codex_v2')` 只是显式离线开发入口。未挂接旧产品调度器、HTTP、UI，不自动读取模型配置、不安装 Skill，也不打开产品数据库。B/C 投影是替身返回可用的基础契约，真实 Agent 语义接入分别属于 CQ-2/CQ-3。

`reserve/settle` 统一统计主/子 actor 的请求、输入输出预约、并发和时间；未知保留额度，已知失败仍计请求。无授权时默认请求上限0。本轮运行调用数全部为 **OFFLINE_SIMULATION**，不冒充真实模型用量。实际 Codex 每次推理前拦截、自动重试阻止及真实 token 限制尚未接入，`per_request_gate_verified=false`。不能把一次 turn 预约当成真实 N 次请求硬上限。

项目运行端口与官方 RPC 分开；`CODEX_UNCONNECTED.start()` 固定拒绝。固定 CLI `0.166.0-alpha.6` 本地生成的十份 Schema 及哈希保存在 `runtime-lock.json` 与对应目录。版本化生成方式和 stdio 接入依据 [OpenAI 官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)；本轮仅生成 Schema，未启动服务，未据此认定千问兼容。

`probe-plan.json` 冻结下一次探针的拟造输入、目标模型、历史服务 base URL、拟议 Responses 路径和新增资源上限。该路径兼容性 UNKNOWN。`prepare-cq-runtime-probe-v1.mjs` 生成可审阅哈希包，**不能发请求**。真实执行前必须补好逐请求出站门禁及固定版本权限验证，再让新增授权绑定具体输入、地址和预算；旧63/63额度不能复用。
