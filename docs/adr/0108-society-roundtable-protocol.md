# ADR 0108：社会研讨协议——议题圆桌（M51-B）

- 状态：Accepted
- 引入：M51-B
- 相关：[design.md §62](../design.md)、[docs/scene-expansion-design.md](../scene-expansion-design.md)、[agents/society/_group.yaml](../../agents/society/_group.yaml)、[agents/society/_protocol.md](../../agents/society/_protocol.md)、ADR 0107（对弈协议泛化，judge → moderator 回填台账关闭）、ADR 0093（渠道与机制先例：deep-research / source-verification 技能）

## 背景

- 场景生态扩展（§5.2）判定：「一个社会议题想看全」的需求没有承接场景——辩论场（ADR 0107）做对抗裁决、深度研究做单一课题查证，均不覆盖「事实是什么 / 各方关切是什么 / 可行中间路径在哪」的多视角研讨；
- 社会议题的特殊性：① 多数说法需要事实核查（来源等级 / 核验状态），② 立场分歧常是价值分歧（无客观胜负），③ 收敛产物是「共识与分歧 + 可行建议区间」而非裁决或结论；
- 内容风险要求协议级护栏：聚焦民生 / 科技 / 文化 / 环境等非政治敏感议题，不作意识形态输出、不煽动对立、利益相关方为「合理代言推演」而非正式表态；
- M51-A 遗留台账：`judge.handoff → society.moderator`（议题需要多方视角时转研讨）待本批落地后回填。

## 决策

1. **社会研讨协议（写入 `agents/society/_protocol.md`，9 条铁律 + 4 条工具纪律）**：① 议题边界（红线：非政治敏感、不作意识形态输出、不煽动对立）② 事实分级（来源等级 / 日期 / 核验状态三要素，不可核实的标「待核实」不硬凑结论）③ 立场并列（价值分歧只呈现不判胜负；推演与事实分开标注）④ 政策伦理三框架（公平 / 权利 / 后果）⑤ 收敛口径（共识与分歧 + 可行建议区间：下沿 / 上沿 + 代价 + 前提）⑥ 模拟声明（非价值裁判、非决策建议、非各方正式表态）；
2. **`society` 议题圆桌（4 角色）**：chain `[moderator, fact-checker, stakeholder, policy-advisor]`、`rounds: true`、`parallel: true`（`parallelMax: 2`）、order 106、icon `globe`、theme 青蓝青绿——齐观（议题主持，`docs/议题观察报告-<主题>.md` 开场版 + 终局收口）/ 尚真（事实核查，`docs/事实基线-<主题>.md`）/ 方衡（立场图谱，`docs/立场图谱-<主题>.md`）/ 允中（政策伦理；「政策伦理 + 可行建议区间」章并入观察报告终局版）；
3. **观察报告两版覆盖语义**：moderator 开场版（议题与边界 / 研讨轮次记录 / 共识与分歧初稿 / 模拟声明）→ policy-advisor 收口版（议题与边界 / 共识与分歧 / 政策伦理 / 可行建议区间 / 模拟声明）后者覆盖前者；eval 断言以「政策伦理」「可行建议区间」校验最终版为收口版；
4. **技能与预设**：`source-verification`（尚真）/ `deep-research`（方衡）/ `formal-document`（齐观、允中）按角色预载；预设 `issue-roundtable`（齐观 · 尚真 · 方衡 · 允中，order 180）；
5. **回填台账关闭**：`judge.handoff` 追加 `moderator`（AGENT.md + mock preferredOf + m21 断言三处同步）——辩论需要多方视角时按 handoff 转齐观组织研讨；
6. **镜像面七件套同步**：mock.ts 四件套（SCRIPTS 4 条 / artifactFor 4 case / DISPLAY_NAMES 4 / preferredOf 4）+ `e2e/helpers.ts` AGENT_NAME +4（全量 85 角色 id→name 逐一相等）+ `m21.test.ts`（22 场景 / 85 角色 / 18 预设 / 协议断言 +1）+ README / CHANGELOG；
7. **stage 预写（M52 消费）**：`stage: {layout: roundtable, panel: pool}`——roundtable 布局 + pool 面板（多面板研讨池，区别于 debate/negotiation 的 arena 对席）；schema 非 strict，形态消费端 M52-B 实现；本批零前端改动。

## 理由

- **「看清」而非「裁决」是研讨类需求的本质**：辩论/谈判产出胜负或成交区间（对抗收敛），society 产出共识与分歧 + 可行建议区间（并列收敛）——协议以「不抹平分歧、不判胜负」为第一原则，与 debate 明确区隔；
- **事实与立场双轨**：fact-checker 与 stakeholder 分工（事实核查 vs 立场推理），两者交叉但不混同——核查不解读立场、立场推演不冒充事实，从协议层杜绝「用事实论证立场」或「用立场裁剪事实」；
- **政策伦理视角的独立价值**：允中补「政策工具 + 国际经验 + 三框架」而非给结论，可行建议区间（下沿 / 上沿 + 代价 + 前提）呈现取舍结构——比单一建议更诚实，也符合「非决策建议」的研究定位；
- **复用成熟机制**：文件覆盖（两次写同一路径）、handoff 转交、rounds/parallel 波次、mock 四件套均为既有能力，零引擎改动；
- **内容护栏是协议内容而非机制**：红线以协议铁律约束（提示词层），不引入敏感词过滤等机制——与 OPC「共同准绳」的边界处理一致。

## 被否决的方案

- **单角色「研究员」包干（扩大 research）**：多视角研讨的价值恰在分工——事实 / 立场 / 政策伦理由不同角色分别持有视角，单角色会退化为「一份查证报告」；与 deep-research 场景职责重叠；
- **stakeholder 兼做事实核查（省一个角色）**：职责混淆高风险（立场推演天然倾向选择性引用事实）；事实与立场分离是本场景的核心协议原则；
- **收敛输出「综合结论 / 建议」（替用户下判断）**：价值分歧无客观胜负，下结论即越权（价值裁判）；以「共识与分歧 + 可行建议区间」的并列结构呈现，判断权留给用户；
- **观察报告单版（moderator 定稿，policy-advisor 另写政策简报）**：两份文档增加用户阅读负担；「同一路径两版覆盖」使研讨有开场骨架、终局收口（政策伦理并入），mock 与 eval 断言也更精确（校验终局版特征章）；
- **stage 直接写 `layout: arena`（复用对弈席）**：society 是围桌研讨而非对抗对席，形态语义不符；roundtable + pool 由 M52-B 按 §5.2 设计点亮；
- **并行全开（parallelMax 4）**：研讨的事实核查与立场梳理可并行，但二者结论需在轮间交叉对齐（影响面口径）；`parallelMax: 2` 契合「核查 + 立场」两路并进、主持逐轮收束的节奏。

## 适用与失效条件

- 适用：任何「多视角研讨 + 并列收敛」的新场景（如听证研讨、社区议事）可复制模板（协议 + 观察报告两版覆盖 + roundtable/pool stage 三件套）；handoff 回填模式（跨场景联动延迟到目标场景落地后）为场景扩展批次的通用纪律；
- 失效条件：M52-B 点亮 `roundtable` / `pool` stage 后须复核 society 会话渲染（形态消费端替换预写声明）；`tactician.handoff → career.comp-advisor` 仍待 M51-C career 落地后回填——回填后须跑 `check:agents` 复核；
- 测试镜像面：`server/tests/mock-coverage.test.ts`（全量角色守护自动纳入 4 新角色）；`server/tests/m21.test.ts`（22 场景 / 85 角色 / 18 预设 / 协议断言）；`evals/tasks/23-society.json`（4 回合链路 + 3 交付件 + 终局版特征章 + turns_lte 5）。
