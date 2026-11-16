# Native full chain v1：本轮实施契约与文件所有权

## 2026-11-11 已批准的逐条恢复与窗口隔离覆盖

本节仅覆盖本轮新恢复运行；旧运行、响应、语义包、知识草稿及其失败历史不迁移、不改写。用户已批准先完成离线验证，再从产品入口复用 Novel-25646 的现有 CQ、问题族和保存产物，继续建图、索引及冻结的 10 道事实题和 10 道推理题评测。遇到新的中断先报备，不自动修复后继续真实运行。

- 原生 Codex app-server、Skill、MCP 架构保留。恢复位于现有程序参数派生与保存接收层；先正常解析、再安全修复、再尝试独立完整业务条目恢复。原 SSE、调用身份、参数副本、原始文本与派生审计分别保存；不猜补业务语义，不将 `gaps` 或嵌套字段误认成陈述。
- 正常空批次、部分恢复、全坏原稿分开处理。不可恢复的占位参数不得生成正常空 proposal；坏 FINISH 或缺 FINISH 不得伪造 Agent 成功。程序部分收尾需原生执行已结束、请求和工具调用全部结算、有效草稿真实可读回，并有独立部分收尾凭据。
- 已确认完整 RETURNED 响应中的格式/记录问题可按条目、批次或窗口局部降级；不改请求结算状态。UNKNOWN、来源/权限/调用身份异常、写冲突、用户取消和全局超时继续硬停止。有效窗口继续组织、建图与索引，缺口和部分覆盖状态同时保留。
- 共享参数/runtime 实现 owner 为「LightOG · 全链路集成验证」：`native-tool-arguments-v1.mjs`、恢复 helper、必要的 `native-agent-runtime-v1.mjs` 接缝和对应测试；先发布内部恢复接口。产品恢复所需共享接缝由此 owner 与主 session 对齐后修改。
- 语义保存/组织/窗口实现 owner 为「LightOG · 原生抽取与知识构建」：`native-semantic-package-v1.mjs`、`native-windowed-extraction-v1.mjs`、必要的组织/读包/Build Host/Index 和对应测试；不修改上一条的共享文件。
- 「LightOG 产品性能与精度基线评测」负责独立离线验收、产物冻结与唯一真实运行；不修改被测生产代码、Skill、旧冻结目录或题目/金标。A/B 离线交付经主 session 验收后，评测线才从真实产品入口新建恢复运行。根 session 负责本契约和集成协调。
- 不重跑 CQ、问题族或已保存的语义发现，不因恢复重置来源身份；已封存包按凭据复用、未封存草稿按原保存凭据导入。仅从旧响应恢复内容不会证明语义正确。当前没有可恢复产物的范围先盘点并报主 session，不擅自重做前段。

## 2026-11-07 已批准的 v5 实施覆盖

用户已批准 `docs/lightog-tolerant-knowledge-build-implementation-plan-v5-20261107.md`。以下覆盖本文件中关于新构建强制精确证据／Review后索引的旧要求；旧运行不迁移、不改历史默认。

- 新构建输入固定 `knowledge_build_policy: EXTRACT_AND_INDEX_V1`；缺字段的历史run按原严格语义读回。
- CQ adapter、Build Host及family validate入口接受 `knowledgeBuildPolicy` 参数；主线从saved input传递。
- Build Host `call(role,name,args,callContext)` 接受仅程序可见调用上下文 `{invocation_ref,tool_call_ref,mcp_request_id,mcp_session_ref}`。MCP→broker→引用wrapper→业务Host保留该上下文，模型Schema不加入系统字段。
- Build快照新增 `knowledge_build_policy`、`knowledge`、`processing_summary`（received/structured/text/skipped/warnings等计数）、`knowledge_index`；允许附逐条处理原因。`EXTRACTED_KNOWLEDGE` 是新默认知识图／查询视图，原文与旧采用事实保持含义。
- 新主链抽取后直接建图／词法／向量，不调用强制REVIEW。条目缺陷按保留、文本降级、跳过和告警处理，不因质量缺口结束run；整段原生工具JSON仍无法解析、真实服务／数据库故障、UNKNOWN等按技术边界报告。
- 原文件owner延续。主线内部子任务独占MCP/runtime/references端口与HTTP/UI，抽取session不编辑这些；主线独占full-chain/product/material-view。集成session只改tests/scripts/report，不改生产实现。模型外发由主session从产品入口串行执行，各模块仅离线。

以下正文为历史v4契约与兼容记录；与上述冲突处以本节及v5为准。

2026-11-06：用户已批准 v4 开始实施。本文件是本轮公共接口冻结点；业务模型的实时测试由主 session 单独串行执行，其他 session 只做离线／mock 测试。不得让每条工作线各发一次模型请求。

主计划：`docs/lightog-native-full-chain-implementation-plan-v4-20261106.md`。

## 所有权

- 主 session：本契约；`web/native-full-run-v1.mjs`、`web/native-agent-runtime-v1.mjs`、`web/native-agent-mcp-v1.mjs`、`web/native-full-chain-v1.mjs`、产品 API／现有 UI 接入；共享 runtime/store/CQ controller 原文件；package.json。新增端口优先，不改旧发布语义。
- CQ session：`web/native-cq-source-adapter-v1.mjs` 与同名测试。复用 CQ Skill，不改公共旧 controller/runtime/store/API。
- 问题族 session：`web/native-family-input-adapter-v1.mjs` 与同名测试。复用归族 Skill，不改公共旧 controller/runtime/store/API。
- 抽取 session：`web/document-extraction-windows-v1.mjs`、`web/native-scope-plan-v1.mjs`、`web/native-extraction-output-v1.mjs`、`web/native-local-admission-v1.mjs`、`web/native-build-index-v1.mjs`、`web/native-build-host-v1.mjs` 和对应测试；`docs/skill-drafts/lightog-{scope-planning,extraction,local-review}/`。新采用／索引在新命名空间实施，可直接复用 SQLite records 端口，不要求为首个切片新增 Rust 后端。不得借用旧 PUBLISHED。
- 集成验证 session：`tests/native-full-chain-v1/`、`scripts/run-native-full-chain-offline-v1.mjs`、`scripts/run-native-full-chain-confirmed-v1.mjs`、`docs/lightog-native-full-chain-validation-20261106.md`。不改被测公共代码；接口不符报主 session。

## 公共数据

现有 SQLite store：`getRecord(kind,id)`、`putRecord(kind,id,value)`、`listRecords(kind)`、`transaction(fn)`，同步；沿用现有 `createStore`。新模块用独立 `native_*_v1` kind，不写旧正式头。哈希用 `cq-discovery-store-v2.mjs` 的 canonical/hash；模型不填权威ID或哈希。

来源目录是现有 catalog：`get(snapshotId,libraryId)` → `{snapshot_id,source_epoch,documents:[{doc_id,revision,title,content,blocks,parser,...}]}`，`isCurrent(snapshotId,libraryId)`；文档必须来自真实产品解析目录。source_refs统一 `{doc_ref,revision}`；block位置为UTF-16，来源一律保留文档+版本，不只block_id。

CQ保存为 `{input_ref,items:[{cq_ref,question,source_hint?,notes?,source_refs:[],read_receipt_refs:[]}]}`，引用由Host生成。family输入可以聚合；以问题族适配器返回的唯一items[].cq_ref为member_refs。逐题 source_refs 可多个或明确未知，不能广播整库来源。

## CQ来源适配器（CQ session实现）

导出 `createNativeCQSourceAdapter({store,catalog,libraryId,snapshotId,runId,assertOpen})`。返回：

- `definitions()`：`lightog_list_cq_documents`、`lightog_read_cq_material`、`lightog_save_cq_list` 的MCP tool定义；读取可指定doc_ref/revision/cursor/max_chars。保存每题带已读来源引用／读取回执或明确来源未知。
- `call(name,args)` → Promise或同步 `{ok:true,result}`／`{ok:false,error:{code}}`。
- `snapshot()` → `{cq_input:null|上述CQ输入,reads:[],scan_status,...}`；saveCQ仅保存阶段产物，不finalize整个run；拒绝来源过期、越权、引用冲突。支持多文档与完整cursor，保留provenance/解析告警。

## 问题族适配器（问题族 session实现）

导出 `createNativeFamilyInput({runId,sourceSnapshotRef,inputs})`，inputs为上面的CQ输入数组；返回 `{input_ref,items,mapping}`，items[].cq_ref是唯一成员引用，mapping保留origin_input_ref/origin_cq_ref/source_refs/原题备注。不裁剪超限。另导出 `validateNativeFamilyOutput({input,args})`，复用旧结构验证器，返回经过验证的 `{input_ref,families,unassigned}`。模型调用工具名继续 `lightog_save_cq_families`。归族语义仍在Skill，不写JS归族规则。

## 构建 Host（抽取 session实现）

导出 `createNativeBuildHost({store,catalog,libraryId,snapshotId,cqInput,families,runId,assertOpen})`，assertOpen为主run的同步检查函数。返回：

- `definitions(role)`：role=`EXTRACTION`时提供读取来源/组窗、保存范围、提交来源与候选、结束抽取；role=`REVIEW`时仅查看待核实批次/来源和保存局部核实结论，独立上下文不读取Generator私有推理。
- `call(role,name,args)` → `{ok,result}`或`{ok:false,error:{code}}`；同步或Promise均可。
- `snapshot()` → `{scope,candidates,adoption,source_index,fact_index,extraction_complete,review_complete,...}`，可增加字段。
- `reviewInput()` → 独立核实包；`recordReviewInvocation(receipt)`在REVIEW调用前由主host绑定独立runtime/role/输入哈希；不能由模型自己传“我已独立审查”。
- `buildIndexes({embed,embeddingSpace,capability})` → Promise，capability=`LEXICAL|VECTOR|HYBRID`，embed为Host已计费/计数包装的函数 `async(texts,{inputType})=>vectors`；embeddingSpace包含model/revision/dimensions/input_strategy/distance，缺配置不造向量。来源/事实分别激活。
- `query({view,query,vector,limit})` → 真实已存储来源或有效采用事实及证据，view=`SOURCE|ADOPTED_FACT`，默认词法，有向量时兼容性检查；`graph({view})`返回持久图。采用新policy，逐候选证据/身份/条件及coverage分开。

scope/extraction/review工具的具体参数由抽取线写JSON Schema+样例并回报；主session从definitions动态导出，不再硬编码同一套Schema。一次明确局部补读：改写候选产生新revision，旧核实不能继承；首轮不自动二审。

## 父run与模型执行（主session实现）

`createNativeFullRun({store,runId,input,limits,now})`返回`state()`、`assertOpen()`、`checkpoint(stage,payload,parentRefs)`、`reserve({kind,role,requestBytes,items,textChars})`、`settle(requestRef,{outcome,usage,reason})`、`stop(reason,status)`、`complete(summary)`。kind=`GENERATION|EMBEDDING`，outcome=`RETURNED|FAILED|UNKNOWN`。新建子角色不重置父预算；首次外发计时，所有并发原子预留，失败/未知阻止后续外发；重启遗留RESERVED标UNKNOWN且不重发。

`runNativeAgent({store,run,role,tools,skillPaths,prompt,runtimeDirectory,upstream,model})`使用固定Codex app-server+原生Skills+MCP。tools为`{definitions:array,call(name,args),isComplete()}`，upstream为既有单目的地 `({body,signal,request_id})=>{status,body:AsyncIterable<Buffer>}`，不重写模型请求。返回独立运行receipt和events。不会由Host直接LLM调用完成语义任务。

`createNativeFullChain({store,catalog,libraryId,snapshotId,runId,limits,agentRunner,embed,embeddingSpace})`封装全链。返回 `run({runtimeDirectory,upstream,capability})`、`snapshot()`、`query(args)`、`graph(args)`。agentRunner默认runNativeAgent，可注入scripted runner，仅离线标MOCK。具体主入口导出与upload product wiring由主session回报。

## 验收与真实运行

先对最小纵切做离线、实际Docling本地解析、实际固定Codex+模拟Responses接线；然后主session只执行一份获准短资料一次顺序真实链，固定 qwen3.8-flash / 原北京服务，不后台学习、不rerank、不A/B/C。本轮真实执行包由主session生成后固定总次数/时限/文本量，沿用用户已提供凭据与测试授权，不因旧测试历史预算而重置/借用额度。未完成核实/索引不能标完成。

## 本轮原生实测后的兼容补充

- MCP 资源/模板枚举返回真实空集合；仅提供业务工具不等于资源枚举失败。资源读取越权仍拒绝。
- 原生工具结果保留上限显式 65536 tokens。实际 225 单元结果下一 wire 完整保留；Host 读取记录不自动证明模型完整看到/理解。
- 可选的空/纯空白 family notes 视作未填写，原始输出、规范化路径与验证结果独立归档；其它门槛保持。
- Agent 短引用层 `native-agent-references-v1` 作用于 Host prompt/工具数据：工具输入前还原真实引用，真实来源/Schema/权限校验继续执行。映射按 run+role 持久化并审计，未发放/跨role引用拒绝；原文、问题、语义字段与校验哈希不改。Responses 本身不重写。
- 重复引句/未找到引句是明确的 `NEEDS_LOCATION` 业务反馈，无 evidence_ref 时不能提交为有效事实；Agent可按实际位置补定位或留下缺口。来源/权限/Schema/网络故障与UNKNOWN仍按硬停止处理。
- 问题族保存后由 Host 的 `materializeNativeFamilyRefs` 发放本轮合法 `family_ref`，下游只消费实际返回的值，不由 Agent 猜编号。
- 短文可通过公开读取/定位工具生成 canonical 完整预载；`projectNativeBuildContextForAgent` 只精简单文档单窗口重复元数据，公共出处显式继承，全部引句、证据/单元引用和位置保留。Host 中的出处、资格、原 CQ mapping 不删除；多来源或不一致时返回原视图。仅度量字节，不能由此宣称模型 tokens 或质量改善。
- 完整模型响应内的 `function_call.arguments` 必须为合法 JSON；非法时保持本次请求 RETURNED/已知usage，但业务 run FAILED，响应不交给 Codex。新请求 reserve 前还检查原生 `function_call_output` 的协议级工具错误，覆盖未经过 MCP 的本地解析失败。审计只记录协议字段与hash，不读取私有推理、不修复原参数、不重写请求或响应。
- 经用户另行明确允许，可用独立新 run 导入成功确认的 CQ/FAMILY 检查点进行受控后半段验证；不重开旧 FAILED、不重置累计预算，不冒充从上传连续完成的新全链。此次真实后半段已因本地工具 JSON 错误人工停止，第4请求 UNKNOWN；当前累计22次生成/0Embedding，后续离线修复不构成真实重试权限。
