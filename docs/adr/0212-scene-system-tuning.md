# ADR 0212：场景体系调优——心理支持新增 · 对抗推演域收敛 · 事实核查收编

- 状态：Accepted
- 引入：v99（2026-09-22/23）
- 相关：[agents/CHANGELOG.md](../../agents/CHANGELOG.md)（v99）、[agents/wellness-mind/emotion-companion/AGENT.md](../../agents/wellness-mind/emotion-companion/AGENT.md)、[agents/funding/dd-analyst/AGENT.md](../../agents/funding/dd-analyst/AGENT.md)、[server/src/llm/mock.ts](../../server/src/llm/mock.ts)、[evals/tasks/57-wellness-mind.json](../../evals/tasks/57-wellness-mind.json)

## 背景

全量盘点（40 场景 / 165 角色）暴露三类结构问题：① 心理情绪支持是最大空白（relationship / care 均明确排除诊疗）；② 对抗推演域同质化（debate / business-sim 与 negotiation / moot-court / society 重叠）；③ society/fact-checker 与 research/verifier 职能重复。

## 决策

1. **新增 `wellness-mind/` 心理支持场景**（emotion-companion 听澜 / mindfulness-guide 安屿 / psycho-educator 知澄）：**非治疗定位 + 危机红线零容忍**（危机信号不交接给任何人、直接对用户响应并给出专业渠道）+ 倾听先于建议；协议含质量红线与典型失败模式；串行陪跑链路（陪谈 → 练习 → 科普）+ dock/coach 形态。
2. **新增 `funding/dd-analyst` 卫衡**（投资人视角一级市场尽调：业务 / 财务 / 团队 / 法务四线清单 + 红旗分级 + 证据三级标注），接入 fundraiser → dd-analyst → ir 链路（`fundraiser` handoff 同步）。
3. **下线 `debate/`（4 角色）与 `business-sim/`（3 角色）整场景**；**`society/fact-checker` 收编并入 moderator（齐观）**——协议分工改「主持先行核查事实基线 → 立场 / 政策伦理并行 → 收口」，观察报告新增事实基线章，齐观补挂 `source-verification` 与 web 检索工具；预设 `classic-debate` 删除、`issue-roundtable` 改 3 人链路。
4. **配套补强**：组队预设 33 → 43（+11 新增 / −1 classic-debate）；灵魂变体 +6；声纹 +3（听澜 / 观照 / 观复）；health 补挂 `health-metrics`；eval 39 → 59（场景覆盖扩展 + `23-society` 三人链路重写、`21-debate` 删除）；镜像四件套同步（mock / e2e helpers / agents README / CHANGELOG）。

## 被否决的方案

- **保留 debate / business-sim 但做「差异化改造」**：与谈判桌（negotiation）/ 模拟庭审（moot-court）/ 议题圆桌（society）/ 博弈推演类场景的差异面过窄，改造维护成本高于收编收益。
- **保留 fact-checker 独立角色**：与 research/verifier 职责重复；「主持先行核查事实基线」收编进圆桌语义更自然（一次性事实核对，而非独立产出角色）。
- **心理场景做「治疗 / 诊断」定位**：合规红线不可越——非医疗建议、不给诊断；危机信号直达专业渠道。

## 边界与后续

- 心理支持场景的**危机红线为永久约束**（协议层固化；`57-wellness-mind` eval 覆盖）；后续新增心理类角色不得弱化该红线；
- 后续再引入对抗 / 推演类场景，须先论证与既有场景（谈判桌 / 模拟庭审 / 议题圆桌 / 博弈推演）的差异面；
- 镜像面：`agents/CHANGELOG.md` v99、design.md **§118**、`agents/README.md`、根 README、`e2e/helpers.ts`、`evals/tasks/*`、本 ADR + `docs/adr/README.md` 索引。
