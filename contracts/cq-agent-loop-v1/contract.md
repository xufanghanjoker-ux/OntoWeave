# CQ-2B 阶段 A 业务闭环契约 v1

2026-11-05。依据主实施文档 §3.3–3.5、§4.5、§5.3、§6.3、§7.5。业务记录版本 `lightog-cq-agent-loop/1`，受控工具集 `lightog-cq-loop-tools/1`，MCP服务器 `2.1.0`。固定工具定义见同目录 `mcp-tools.json`；执行前比较实际定义的规范化哈希，既有任务不能更换工具哈希或限制。

本轮只实现 CQ 发现与补全角色。抽取和检索角色继续按主文档设计，未创建对应 Skill、发布工具或子 Agent。原 `lightog_cq_stage_v1` 信封不变；修订/拆分关系保存在独立检查点记录，不把新字段直接塞入旧范围发布契约。

1. 状态与计数

- 业务任务沿用原九态；业务循环另有 RUNNING、HANDOFF_PENDING、AWAITING_CONTINUATION、COMPLETED、STOPPED。资料单元状态为 PENDING、RUNNING、PAUSED、FINISHED。
- 初始发现业务轮记1；每个获准的 READ、SEARCH、REVISE_CQ、REQUEST_WORK_UNIT 决策创建新的发现轮记录。FINISH/STOP不要求凑新轮。Codex原生执行轮次、业务轮次、CQ检查点和外部推理请求分别计数。
- 每个 CQ submit 是检查点，不是单元结束；原生 turn/completed 也不结束业务单元。没有明确业务决策而结束原生轮次时保存部分草案与 KNOWN_FAILURE/MISSING_EXPLICIT_BUSINESS_DECISION，不自动再开一轮。
- FINISH_UNIT 需要有效检查点、当前单元的实际正文读取、已处理的计划动作及无悬空分页。它可保留身份等未决项，不要求答案或事实支持。所有CQ单元都有结束记录时，阶段A循环可COMPLETED；B/C尚未执行则整个任务和草案仍PARTIAL。

2. 新工具

`lightog_get_cq_progress({cursor?,limit?})` 返回当前单元/计划、草案修订、带工作单元归属的CQ摘要、实际读取范围、近期缺口决策、上游产物引用和剩余限制；摘要最多20条，长问题/目标有显式截断标记，不返回全库全文。每次查看保存所见草案/计划修订，便于确认复查发生在哪个检查点。

`lightog_record_cq_decision` 公共字段为：预期计划修订、预期草案修订、幂等键、next_action、简短reason。继续动作需gap.kind/description/expected_information，可引用本任务的CQ和工具收据；READ/SEARCH目标必须与实际工具参数及当前授权范围一致。reason等短字段≤600字符，不要求私有推理过程。

| next_action | 宿主行为 |
| --- | --- |
| READ / SEARCH | 校验具体缺口与范围；批准后用原工具执行，保存实际返回并关联决策。检查点之后不能无决策补读，不能通过参数变更读另一个目标。 |
| REVISE_CQ | 允许在已知资料上修订；不必为修改措辞强制再读。无进展仍受计数限制。 |
| REQUEST_WORK_UNIT | 选取已有未完成CQ单元，或通过原ADD_DISCOVERY追加新单元；保留全部原分区、计划版本和后续依赖失效，保存调度记录。旧上下文不获得新权限。 |
| FINISH_UNIT | 保存PLANNED_WORK_COMPLETE、最后检查点/修订、实际读取与未决说明。只结束本单元。 |
| STOP_PARTIAL | 保存SOURCE_LIMITATION、KNOWN_FAILURE或BUDGET_OR_TIME_LIMIT及未处理事项。生命周期状态由宿主决定，模型不能自报READY或SUCCEEDED。 |

资料过期、取消、未知覆盖所有继续建议；已知返回仍可归档，但不再应用为活跃检查点。拒绝的工具/范围/决策保留独立拒绝记录。相同决策键与相同内容返回原收据；改内容不覆盖。所有决策做计划/草案CAS。

3. 检查点和进展

阶段提交可在新MCP适配层附 `revision_links[]`，包含 from_cq_ids、to_local_keys、relation和reason。关系可为 SPLIT、REVISED、RETIRED、UNCHANGED；SPLIT需至少两个去向，旧引用限本单元前版CQ。宿主将局部键映射到新业务ID，并保存前后草案修订、原件引用与修订/拆分关系。旧StageArtifact原件不覆盖，其他单元取并集；新CQ使依赖的旧B/C投影待重做。

进展由新返回范围及归一后的知识目标/操作线索对比作确定性观察。更换ID、单纯改问法、把关系自称REVISED均不能单独算新增；语义同义/质量仍需独立判断，`semantic_progress_certified=false`。零命中记录NO_NEW及“未认证无知识”，可以根据其他线索改查。相同读取的次数、无进展次数、业务轮数、原生轮数与工作单元数均有宿主上限，不替代外部逐请求门禁。

4. 跨单元与原生续发

优先在同一原生轮次内完成补查。需要换单元或下一轮处理时，必须有持久继续/调度决策、前轮已知completed结果及有效来源。Host签发一次性turn_permit；领取、绑定分别记录，不能重用。新的原生执行记录起始请求索引，结束只引用本轮实际请求。

首版跨单元使用新的受控原生执行和不可变MCP上下文：旧桥接在前轮结束后关闭，再以新绑定运行。旧线程/轮次和runtime_handle完整留在历史，新活跃指针只能通过permit更新，不能清空运行引用或账本。不同上下文保留拒绝越权的能力；这不是外层循环重跑旧入口。

取消/来源过期优先于轮次断线，不能被未知原生终态抹去；未知请求仍保留预约。未确认的原生执行结果即便请求都已知，也不能以新会话重跑。停止/完成后的重复入口只返回持久结果，不发送请求或产生无意义的新草案修订。

允许至多一次、计入原预算的原生收尾生成；资源触限、取消、过期、未知或持续无进展后不续发。若业务单元已经FINISH，但预算不足以生成原生收尾文字，拒绝额外请求且保留业务结束记录，不把它改判成未完成。

原生接入继续遵循锁定版 [Codex App Server](https://learn.chatgpt.com/docs/app-server) 的线程/轮次协议。业务许可与完成语义是本项目实现，不能由官方turn结束事件推导。

5. 持久化与边界

复用现有SQLite事务与 `cq_v2_*` 记录：agent_loop当前状态；discovery_round、loop_decision、loop_checkpoint、loop_observation、loop_progress_view、loop_rejection、loop_dispatch、loop_end；loop_native_start/binding/end与turn_permit/use。原件追加，状态/指针按CAS更新，不写旧正式图或旧运行档案。

新入口 `runAutonomousCQStageA` 仅在显式codex_v2下运行，原CQ-2A往返入口和四工具模式仍作为兼容回归。自主模式只开放六个CQ工具；finalize、B/C、抽取、检索和发布工具均不开放。Skill、MCP定义、wire和SSE白名单同步更新。没有新增自由模型客户端，所有推理共用原逐请求门禁。

脚本化响应能验证工程闭环，不能证明真实模型自主发现遗漏。新真实探针必须重冻工具/Skill/材料/预算与独立期望，后者不送入Agent。旧六请求包未批准且不复用；本次离线实现不授权任何外部模型调用。
