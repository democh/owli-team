# ADR 0107：PK 对弈协议泛化——辩论场与谈判桌（M51-A）

- 状态：Accepted
- 引入：M51-A
- 相关：[design.md §61](../design.md)、[docs/scene-expansion-design.md](../scene-expansion-design.md)、[agents/debate/_group.yaml](../../agents/debate/_group.yaml)、[agents/negotiation/_group.yaml](../../agents/negotiation/_group.yaml)、ADR 0097（多空对弈协议化与 `::: verdict` 终局裁决卡，机制先例）

## 背景

- invest 场景的「多空对弈」（M34，ADR 0097）验证了「回合制对抗 + 证据挂载 + `::: verdict` 终局裁决」的玩法价值，但能力局限在投资标的（金融纪律 / `fin_*` 工具 / 免责声明口径）；
- 场景生态扩展（§5.1 / §5.6）判定：观点对抗（辩论）与利益博弈（谈判）无承接场景——「通用议题、双向对抗、胜负裁决」与「目标/底线/BATNA、多轮出价让步」是两类高频真实需求；
- 跨场景 handoff 受 `PromptLibrary.validate()` 全局校验约束（目标角色必须已存在）——`judge → society.moderator`（M51-B）、`tactician → career.comp-advisor`（M51-C）须延后回填，本批先落可用目标。

## 决策

1. **协议泛化（模板共用）**：debate / negotiation 与 invest 共用一套对弈协议（写入各场景 `_protocol.md`）——① 回合制（默认 3 轮可调、每轮必须回应上一轮、禁止复读）② 挂证据与置信度（辩论逐条证据 + 高/中/低；谈判逐轮报价 + 让步幅度 + 理由）③ 终局 `::: verdict` 复用（辩论「胜负 + 置信度 + 核心依据 + 翻盘条件」；谈判「成交区间（ZOPA）+ 得失评分 + 改进点」）④ 落盘与「模拟推演」声明，收尾由裁判 / 教练统一 @用户 ⑤ 并行纪律按场景定；
2. **`debate` 辩论场（4 角色）**：chain `[judge, affirmative, negative, evidence]`、`rounds: true`、`parallel: true`（正反同波立论）、order 102、icon `scale`、theme 红蓝对撞——立言（`docs/正方立论-<主题>.md`）/ 砺锋（`docs/反方立论-<主题>.md`）/ 昭实（`docs/证据清单-<主题>.md`，中立供弹药）/ 明断（`docs/辩论裁决-<主题>.md`）；与 red-team 单向挑刺、invest 限标的明确区隔；
3. **`negotiation` 谈判桌（3 角色）**：chain `[negotiator, counterpart, tactician]`、`rounds: true`、**`parallel: false`（严格串行出价，等待对方回应）**、order 104、icon `handshake`——谭成（`docs/谈判策略-<主题>.md`）/ 祁弈（`docs/对手档案-<主题>.md`，按设定立场真实还价）/ 苏纵（`docs/谈判复盘-<主题>.md`，旁观复盘）；
4. **技能与预设**：新建 `skills/debate`（立论/反驳模板、谬误清单、裁量口径）与 `skills/negotiation`（三桩/ZOPA/让步纪律、对手建模）；预设 `classic-debate`（order 160）、`negotiation-rehearsal`（order 170）；
5. **镜像面七件套同步**：mock.ts 四件套（SCRIPTS / artifactFor / DISPLAY_NAMES / preferredOf）+ `e2e/helpers.ts` AGENT_NAME + `m21.test.ts` 断言（21 场景 / 81 角色 / 17 预设）+ README / CHANGELOG；
6. **stage 预写（M52 消费）**：两场景 `_group.yaml` 预写 `stage: {layout: arena, seats}`——schema 非 strict（未知字段安全剥离），形态消费端 M52-A 实现；本批零前端改动。

## 理由

- **复用成熟机制而非新造**：回合语义、verdict 容器、声明纪律在 invest 已验证；泛化 = 写协议 + 配角色，零引擎 / 零容器改动；
- **串行 / 并行按博弈本质定**：辩论正反双方可同波独立立论（对抗发生在轮间回应）；谈判出价-还价存在严格因果依赖，并行会破坏博弈逻辑——`parallel: false` 是语义正确性而非性能取舍；
- **对手模拟是谈判彩排的核心价值**：`counterpart` 按「设定立场 + 性格」真实还价（可配强硬 / 拖延 / 情绪型），用户在下场前暴露自己的锚定与让步失误——这是纯策略助手给不了的；
- **handoff 按台账延后回填**：先写当下可用目标（辩论转 research.scout 补证据、谈判转 legal/finance 核条款），跨场景联动待 society / career 落地后回填，避免校验失败中断批次。

## 被否决的方案

- **不做独立场景，扩展 invest**：议题类型（通用观点 / 利益博弈 vs 投资标的）与工具需求（无 `fin_*`、无金融纪律）完全不同，塞进 invest 会造成职责混淆与协议污染；
- **辩论沿用 stream 纯对话（无裁决形态）**：辩论的核心体验是回合对抗与终局裁决的仪式感；M52 `arena` 形态（左席/中轴/右席）已在设计——本批先写 `stage` 声明；
- **谈判不设对手模拟（只做策略顾问）**：用户需求明确「模拟对手还价」的彩排价值；去掉 counterpart 则退化为普通策略文档场景；
- **新造裁决容器（如 `::: ruling`）替代 `::: verdict`**：verdict 已具备「首参数 + 条目」结构且三处消费（消息渲染 / 图谱 / E2E）已就绪，新造容器引入前端渲染二义与测试面复制；
- **judge 同时承担「流程裁判 + 内容裁决」并复用调度**：M48 已立原则「调度是平台能力、不人格化」（ADR 0101）——裁判是业务角色（裁量内容产出），编排由引擎负责，两者不混同；
- **两场景 `parallel` 都设 true（提速）**：谈判并行出价会产生「同时让步」的荒谬博弈记录，破坏复盘素材与 ZOPA 判断。

## 适用与失效条件

- 适用：任何「回合制对抗 + 终局裁决」的新场景（如模拟法庭、评审答辩）可复制模板（协议 + verdict + stage arena 三件套）；
- 失效条件：M51-B society 落地后回填 `judge.handoff → moderator`（议题转研讨）；M51-C career 落地后回填 `tactician.handoff → comp-advisor`（谈薪联动）——回填后须跑 `check:agents` 复核；
- 测试镜像面：`server/tests/mock-coverage.test.ts`（全量角色守护自动纳入 7 新角色：专属交付件 / 无兜底标记 / preferredOf 不漂移）；`server/tests/m21.test.ts`（21 场景 / 81 角色 / 17 预设 / 协议断言）；`evals/tasks/21-debate.json` / `22-negotiation.json`（链路 + 交付件 + verdict 关键字 + turns_lte）。
