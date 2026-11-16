# 抽取提示词来源与 LightOG 改编

核对日期：2026-11-06。开源依据为当日可取得的官方 main，尚未固定 commit；本文为中文改编说明，不复制完整上游提示词。草稿未激活，不代表构建工具或核实政策已经实现。

## 实际提示词位置

| 来源 | 实际位置 | 可借方法 | 不直接复制 |
| --- | --- | --- | --- |
| LightRAG | [prompt.py](https://github.com/HKUDS/LightRAG/blob/main/lightrag/prompt.py)，entity_extraction_system_prompt、entity_extraction_user_prompt、entity_continue_extraction_user_prompt 及其 JSON 版本 | 从限定正文抽对象和关系；区分定位背景；补抽只处理遗漏／纠正 | 默认无向关系、固定实体类型、英文命名和元组分隔符、完成标记；关系强度不是可信度 |
| Utopia | [open.rs](https://github.com/deeplethe/utopia/blob/main/crates/utopia-extract/src/open.rs)，OPEN_SYSTEM、OPEN_TABLE_RULES、build_open_messages | 先引用再陈述；保留语气、限定；表格与表头／单位一起读取 | 位置数组、上游时间接口及穷举数字目标；不能让 LightOG 依赖其对象 ID 或写库政策 |
| Graphiti | [extract_nodes.py](https://github.com/getzep/graphiti/blob/main/graphiti_core/prompts/extract_nodes.py) 的 extract_text；[extract_edges.py](https://github.com/getzep/graphiti/blob/main/graphiti_core/prompts/extract_edges.py) 的 edge | 当前正文与背景分开；引用实际主体；保留具体细节和新增限定 | 部分提示中的抽象概念排除、两个不同实体间的边限制、episode 索引和时间归一约定；PRD 指标、单主体属性和规则仍要表达 |
| NVIDIA auto-ontology | [term_extractor.py](https://github.com/NVIDIA/auto-ontology/blob/main/auto_ontology/semantic/term_extractor.py) 的 extract_term | 小单元语义编译、引用结构约束、生成与认证分层 | 当前是数据库表／列术语抽取，不直接用于 Docling 正文；不复制每表一 Term、前 40 列及遗漏归首项的处理 |
| LightRAG 论文 v3 | 用户 PDF 第 14 页，§7.3.1 Fig.4；[论文](https://arxiv.org/abs/2410.05779v3) | 对象、关系及说明的抽取组织方式 | 第 14 页 Fig.5 是评测问题生成；给定 PDF 未公开独立补抽提示，不能把草稿补查规则称为论文原版 |
| 本体论文 v1 | 用户 PDF 附录 C.3 第 13–15 页、C.6 第 16–19 页；[论文](https://arxiv.org/abs/2412.20942v1) | 从 CQ 找所需关系／属性模式，再依据资料抽实例知识 | 固定题数、先产 CQ 答案、Wikidata／OWL/Turtle，以及把逆属性直接视为同向关系 |

本地论文原件：`<local research path omitted from release>`、`<local research path omitted from release>`。

## LightOG 的适配重点

1. 原 CQ 与问题族是阅读、抽取和主体扩展的输入；原文仍是事实依据，宽泛族名不能抹掉成员需求。
2. 文档中常有参数、公式、分类表、例外和规划状态，不能仅抽实体间概括性关系。
3. 引句与模型规范化描述分别保存；源文可索引、结构化知识采用和整题覆盖分别判断。
4. 抽取 Skill 负责候选及缺口。独立核实、采用、图提交和索引由后续角色／工具承担，不写成抽取自评闭环。
5. 固定工具 Schema、来源与输出映射以实施时冻结的宿主契约为准；草稿不增加另一套自有 LLM 工具循环。

这些是 LightOG 的工程改编，不是上游项目已经实现的统一协议或已验证收益。

大批资料的解析、分块、抽取窗口和跨块处理见 [四项目抽取与分块对照](../../../lightog-extraction-chunking-reference-design-v1-20261106.md)；这些由宿主工具承接，不把所有工程逻辑塞入 Skill。

## 当前检查范围

Skill 格式校验通过。一次内部合成材料审阅保留了表头单位、地区条件、否定及规划语气，并将同族其他主体作为待登记范围，未伪造原 CQ 对应关系。审阅也提示：只影响未来具体问题的细节不宜成为当前阻断，已据此收紧缺口说明。

这些检查不是 qwen3.8-flash 实测或原生抽取工具接线验收。当前运行时仍只接通已验证的 CQ／问题族 Skills；本草稿未激活。
