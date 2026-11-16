# LightOG 共享需求契约 0.1（首版设计基线）

日期：2026-10-30。需求版本 `lightog-demand/0.1`，传输版本 `lightog-wire/0.1`。

2026-10-30用户同意按本版继续，作为首版实现基线；这不等于逐项语义预期已独立核实，亦不代表产品或Rust实现已通过验收。

本目录定义原文检索、图谱查询、后台学习共同消费的需求与证据格式。**这是接口与验收规范，尚未接入产品；首个隔离Rust校验内核已实现，不代表中文需求编译质量已经提高。** 代码目录中的Python脚本只校验这些规范附件，不是新的产品执行引擎。

Rust实现与复现步骤见 [lightog-demand](../../crates/lightog-demand/README.md)。

目标依据：[产品架构 v0.3](../../docs/product-architecture-v0.3-20261030.md)。少量CQ应能扩展资料内的同类问题并建图；新问题可以先基于原文回答，后台另行补图。

## 1. 对象与责任边界

| 对象 | 表达什么 | 不能据此认定什么 |
| --- | --- | --- |
| QuestionSpec | 用户问题、原子子需求、主体/目标/条件/结构/完整性 | 当前图已覆盖，或问题事实已成立 |
| CQFamily | 基于哪个种子、替换哪个主体槽、依何种依据扩展 | 同类对象身份相同或存在正式is-a关系 |
| EvidenceSet | 来源快照与可定位片段，支持图证据和直接原文 | 引用真实就等于结论语义正确 |
| CoverageReport | 每个子需求、主体和条件的实际处理与缺口 | 扫完窗口就已证明语义穷尽 |
| LearningIntent | 对同一需求的后台工作、权限和状态 | 前台答案已失败，或候选已经发布 |
| AnswerResult | 本次回答、证据依据、覆盖引用及独立学习状态 | 原文答案自动成为图谱知识 |
| DemandEnvelope | 迁移期内部传输、请求身份、可信调用上下文 | 模型可通过自报LEARN提升权限 |

`schema.json`采用[JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12/schema)。它检查形状与枚举；跨对象引用、来源状态、授权、语义支持还需执行对应规则。Schema通过不是产品验收通过。

## 2. QuestionSpec

顶层字段：`contract_version`、`question_id`、原问题`text/text_sha256`、`intent`、`requirements`、真实歧义`ambiguities`、技术表达限制`limitations`。

知识问题至少一个requirement；产品身份/问候/帮助等不生成知识需求。需求内容不依赖当前图是否存在实体/谓词；`entity_ref`和`predicate_ref`允许显式null，不允许编造ID。

### 2.1 一个requirement对应一个原子目标

| 字段 | 定义与消费方 |
| --- | --- |
| id | 本问题内唯一，检索、计划、回答、学习均引用它 |
| operation | EXPLAIN / LIST / COMPARE / FILTER / RELATION / RULE；规划与输出形式消费 |
| subjects | 本子需求自己的主体选择器；不能拿其他子需求的主体替换 |
| target | 一个目标维度及问句位置/外部定义来源；多目标拆开 |
| conditions | 本子需求的合取条件；检索可用作提示，执行/回答必须报告落实情况 |
| structure | RELATION需求的单一结构类别、集合语义与角色；其他操作为null |
| coverage_request | UNSPECIFIED / EXAMPLES / ALL_IN_SCOPE，以及可选示例数量 |
| depends_on | 依赖的子需求ID，用于结果比较/组合，必须无环 |
| unresolved | 引用实际歧义或技术表达限制；不能默默丢弃 |

示例：“除欧洲以外，甲云的交付地区和语言数量分别是什么？”拆为：

1. `r_region`：甲云／交付地区／排除欧洲。
2. `r_languages`：甲云／语言数量；没有排除欧洲这个条件。

明确禁止把“欧洲”条件推广到语言数量。详见[完整JSON](examples/multi-target-exclusion.json)。

“比较甲云在中国的部署条件和乙云在欧洲的部署条件”先生成两个带各自条件的叶子，再生成依赖这两个叶子结果的比较需求；比较节点不再不带条件重新查询一次。详见[条件作用域样例](examples/subject-scoped-conditions.json)。

`RULE`表示用户询问资料中的规则；不意味着允许执行文档指令或业务动作。

### 2.2 主体、目标与引用

主体选择器：

- EXPLICIT：问题明确提及的成员。
- DOCUMENT_GROUP：已核对的资料比较/分类集合；绑定组、问题中的指代和集合依据。
- FAMILY：问题族的展开范围；必须解析到已有family与slot。
- UNRESOLVED：确实存在指代歧义，引用ambiguity。

`SubjectTerm`区分问句中的`question_spans`和资料中的`source_mentions`。后者经`evidence_ref`定位到来源版本，再用`SourceSpan`定位提及。资料中发现的新成员不使用没有归属的问句位置。

本版家族成员的label使用可精确锚定的资料原称；规范名、别名或翻译归并留给带依据的身份解析，不由字符串相似直接确认。

所有引用必须在本次校验上下文的符号表中可解析。至少包含相关QuestionSpec、CQFamily、EvidenceSet、DocumentGroup、UserDefinition及可用图身份。外部对象未提供时返回`*_REF_UNRESOLVED`，不能标为通过，也不能直接说用户需要澄清。

### 2.3 条件与技术限制

条件保存原句位置、字段、操作符、类型化值及解释状态。0.1支持表达EQ、NE、GT、GE、LT、LE、IN、NOT_IN；字段包括目标值、范围、单位、语气和时间。

这些是**需求表达能力**，不代表当前查询执行器已经支持。CoverageReport必须分别记录是否落实。

`conditions[]`只表示AND。跨字段OR、复杂否定或暂不支持的时序组合，保留完整原句，使用UNRESOLVED条件和`limitations`；不能偷偷改成AND。技术不支持与用户歧义分开：前者可以明确能力限制或以有据的局部回答处理，后者才请求用户确定。详见[布尔限制样例](examples/unsupported-boolean.json)。

### 2.4 结构与方向

- 每个子需求只表达一个kind：RELATION、COMBINATION、COMPARISON或COMPOSITION。
- COMBINATION/COMPARISON使用ALL或WITHIN，作用域只属于当前子需求。
- ALL要求同一个模式满足所指定的参与者；两两模式不能凑成一个三方模式。
- WITHIN枚举指定集合内部的模式，不要求一个全体共同模式。
- RELATION/COMPOSITION使用NOT_APPLICABLE，不继承其他子需求的ALL/WITHIN。
- directionality为DIRECTED、UNDIRECTED或UNRESOLVED；方向已明确时必须有角色绑定。角色可为SUBJECT、OBJECT、WHOLE、PART、DEPENDENT、PROVIDER、PARTICIPANT。未知部分可作为待检索目标，不凭空发明参与者。

角色引用必须属于本子需求。方向是否忠实于中文问题仍需语义验收，Schema不能判断“依赖”究竟被理解对了没有。

## 3. CQFamily

0.1限定一个family引用一个seed requirement，避免一个替换槽横跨多个不同作用域。引用同时包含种子问题ID和完整QuestionSpec内容哈希；种子变化须重新核查家族。

`subject_slot`明确替换哪个局部主体及角色。目标维度、操作及其语义由被引用的种子需求继承，不重新用自然语言猜测。`condition_transfer`逐条件规定INVARIANT、SUBJECT_SPECIFIC或REQUIRES_RECHECK；主体专有条件不能传播给其他成员。

扩展依据可以是资料分类、资料比较集合或用户定义。前两者必须有来源证据，用户定义必须引用已保存的用户定义。family记录及成员关系只是规划依据，发布类型或事实仍需单独门禁。

“Agent本体是什么”可形成定义问题族，在资料确实把知识图谱本体列入相关比较框架时，替换主体槽并保留定义目标。不会据此自动增加部署、价格、性能问题，也不会自动发布is-a边。详见[种子](examples/seed.json)与[问题族](examples/cq-family.json)。

## 4. 统一证据与来源快照

SourceSnapshot固定知识库、来源epoch、可选图版本，以及各来源版本、原件哈希、正文哈希和解析版本。

EvidenceFragment区分：

- SOURCE_FRAGMENT：来源真实、位置准确的原文，不要求claim_ref；可在图尚未覆盖时用于回答。
- PUBLISHED_CLAIM：引用非空图版本及真实已发布claim，并保持其原文证据与来源版本一致。

候选claim不属于这两个类型的已发布图证据。不能把整块原文包装成假claim以复用旧回答入口。

QuestionSpan归属于QuestionSpec.text；SourceSpan归属于确定的解析正文版本。二者形状相同，但校验对象不同，不可混用。引用菜单、模型置信度或校验状态字段都不能代替真实原文检查。

运行时还必须检查有效来源集合，包含已上传生效但尚未入图的资料；撤回、替换或库生命周期变化后，相应证据不能继续充当当前证据。

## 5. CoverageReport、回答与后台任务

### 5.1 覆盖必须逐项记录

CoverageReport绑定QuestionSpec哈希、EvidenceSet及快照，每个requirement恰好一项，不能只报告成功目标。

每项记录主体收据、条件收据、证据、已检查和未检查的块，以及实际状态SATISFIED/PARTIAL/UNSUPPORTED/NEEDS_CLARIFICATION。明确主体与已展开集合必须逐主体覆盖；FAMILY须有可追踪的范围实例化绑定，不能对尚未展开的集合宣称全部满足。

条件APPLIED须引用可信处理收据；检索时使用了条件作为关键词，不等于执行中已落实。审计收据必须存在且绑定需求、条件/覆盖范围和来源快照，任意字符串不能作证明。

声明范围的块全集必须由可信上下文提供。checked与unsearched不相交且并集等于该范围，不能把未处理部分无记录删掉。

ALL_IN_SCOPE若仍局部、存在未检查块或缺少范围语义审计，不得宣称SATISFIED。`AUDITED_IN_SCOPE`表示有指定范围内的语义审计判断，仍不是数学穷尽证明或现实事实独立认证。

### 5.2 回答与学习状态分开

AnswerResult绑定request、QuestionSpec哈希、EvidenceSet、CoverageReport和快照；每条结论必须引用证据和所回答的子需求。

`basis`由真实证据origin推导为GRAPH、DOCUMENT、MIXED或NONE，不能自行填GRAPH。全文语义、条件保留和结论支持仍需回答评审。

AnswerResult与LearningIntent均绑定可信请求上下文。允许：

```text
answer_status = ANSWERED
basis = DOCUMENT
learning_state.status = QUEUED / RUNNING / FAILED
```

它表达“原文已支持回答，后台另行整理”，不会伪称图已更新。[原文答案](examples/source-answer.json)、[后台失败后的答案](examples/source-answer-learning-failed.json)、[只读答案](examples/readonly-source-answer.json)是不同请求模式/阶段的合法样例。

QUEUED仅表示任务持久化，允许等待原文学习准入；RUNNING抽取及PUBLISHED需要有据准入，发布还需完整门禁。LearningIntent不是模型可提交的发布命令。

权限来自服务认证后的可信上下文。QUERY禁止学习，LEARN才允许按本次请求策略排队；允许学习也不等于必须创建任务。NOT_REQUESTED必须没有task_ref。只读请求不写学习、候选图、索引或称呼记忆；审计和调用账本按独立执行协议记录。

## 6. 跨语言传输规则

### 6.1 编码与文本

- UTF-8、无BOM、严格JSON；拒绝无效编码、孤立代理项和重复键。
- 所有位置为UTF-16 code unit的半开区间`[start,end)`。Rust必须显式转换到UTF-8字节，Python字符下标不能直接传输。
- 原文不做NFC/NFKC、CRLF转LF、空白折叠或标点替换来修证据。检索归一化另存派生字段。
- 原件哈希计算原始字节；正文哈希计算原样正文UTF-8；对象内容哈希计算下述规范字节，三者不同。

### 6.2 lightog-cjson/0.1

这是本项目受限的规范序列化约定，不声称实现完整JCS标准。

- 对象字段键使用协议允许的ASCII；按ASCII字典序排列。数组保持顺序。
- 无额外空白、BOM或尾部换行；Unicode输出真实UTF-8。
- 双引号与反斜线分别转义；控制字符使用JSON标准短转义`\b/\t/\n/\f/\r`，其余U+0000–001F用小写`\u00xx`；斜线不转义。
- 原生JSON数字仅允许安全整数，范围`[-9007199254740991,9007199254740991]`；拒绝浮点/指数数值、NaN/Infinity、负零。精确小数使用TypedValue的DECIMAL字符串。
- DECIMAL规范字符串不含指数、前导零、无意义尾零或负零。`12.50`的原始表达保留在原文/提及中；规范数值写`12.5`。
- 所有对象中的必填字段都显式出现；明确无值用null，空集合用[]，未知用状态及原因，不能互相默认替换。未知核心字段拒绝；0.1不开放任意影响执行的扩展字段。

对象摘要为规范字节的SHA-256。规范化身份加版本前缀；已有产品ID与哈希不因此重算，迁移另建映射。question_id、request_id、内容摘要分别承担身份、幂等和内容校验职责。

两个键序不同的对象均应生成：

```json
{"a":null,"b":[2,1],"text":"甲😀"}
```

SHA-256：`3d7f44647aef4fee9164272c384a560f6a4989fe210ab479ed5ef5e39d72af69`。

### 6.3 信封与错误

DemandEnvelope是Node→Rust等内部边界的需求提案信封。`context`由可信服务填入，模型仅提出payload。校验payload_sha256不代表context获得授权。执行幂等指纹还须包含操作、可信context与依赖版本，不能仅按问题文本去重。

任何版本字符串不一致，0.1先明确拒绝，迁移时显式升级；不能静默猜测新字段。无网络依赖的Schema文件使用urn标识，不要求运行时下载Schema。

错误至少分层：WIRE/SCHEMA（编码、重复键、版本）、REFERENCE（悬空引用）、DEMAND（需求/计划）、EVIDENCE（来源/位置）、ACCESS（权限）、EXECUTION（超时等）。用户歧义、缺证、局部覆盖是业务状态，不冒充系统错误。

校验附件使用稳定机器错误码，便于后续Rust差分；它未定义或接入完整生产RPC错误响应。运行时仍须保留请求ID、可重试性及NOT_SENT/REPORTED/UNKNOWN计费状态，远端结果未知不盲目重发。

## 7. 验收与复跑

| 层 | 文件/方法 | 能证明什么 |
| --- | --- | --- |
| 形状与交叉约束 | schema、examples、negative-cases、validate_fixtures.py | 所声明样例的字段、引用、作用域和状态约束 |
| 跨语言固定向量 | wire-vectors.json | UTF-16/UTF-8转换、严格JSON、规范字节与哈希的预期 |
| 中文需求语义 | acceptance-catalog.json的S类 | 用户评审后冻结预期，再测模型编译；本轮没有执行模型 |
| 产品集成 | acceptance-catalog.json的I类 | 原文优先、后台独立、撤回、只读、幂等与共享需求；待实现 |

复跑不安装新依赖，使用项目已有环境中的jsonschema：

```sh
.venv-docling312/bin/python contracts/demand-v0.1/validate_fixtures.py
```

验证器读`fixtures/demand-contract-v0.1/validation-context.json`的原创合成权威上下文，核对请求权限、来源/图版本、claim与回执引用。它只证明固定样例之间的一致性，不能提供生产认证、真实来源生命周期、收据真实性或命题语义保证。空收据表用于验证虚构回执被拒绝，不代表真实审计流程已实现。

`source-texts.json`的原件也是原创UTF-8文本，仅用于字节哈希向量；不能把它当作PDF/DOCX解析验收。

## 8. 本次评审要确认的选择

1. 原子子需求是共享单位：每个有自己的主体、单目标、条件和结构语义。
2. CQFamily 0.1一次只替换一个种子子需求中的一个主体槽；复杂扩展可组合多个family。
3. 精确条件先支持合取与有限操作符；复杂布尔需求保留限制，不伪装成用户歧义。
4. 原文与图证据共享格式，前台答案和后台学习状态独立。
5. UTF-16外部位置保持兼容，跨语言新身份使用版本化规范JSON；既有身份不被重建。

这些选择确认后，再用Rust实现契约类型与纯函数校验，和本目录同一套向量做差分。不会先把该契约接进产品后再反向修改验收预期。


## 实现复核补充：日期与小数的完整匹配

2026-10-30 Rust/Python差分复核明确以下可移植约束（不修改原附件预期）：DATE为ASCII `YYYY-MM-DD`，年份0001–9999且为有效公历日期。INSTANT保持现有Schema的UTC子集：大写 `T`/`Z`，合法日期，小时00–23、分钟及秒00–59，可选小数秒含至少一位ASCII数字；不支持闰秒、offset或小写t/z。DECIMAL按既有表达式完整匹配，禁止尾换行。两端递归检查嵌套类型化值，不依赖Python可选date-time格式检查附件。新增边界见 [rust-review-vectors.json](../../fixtures/demand-contract-v0.1/rust-review-vectors.json)。
