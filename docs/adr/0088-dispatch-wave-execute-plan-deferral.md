# ADR 0088：调度波恒 execute（Dispatcher Waves Always Execute; `planFirst` Deferred to the First Business Wave）

- 状态：Accepted
- 引入：M46
- 相关：[design.md §54](../design.md)、ADR 24（回合范式与计划审批的会话语义）、ADR 48（回合范式：opt-in 门控 / awaiting_plan）、ADR 85（无 @ 路由调度优先）

## 背景

- 会话级 `planFirst`（「规划先行」）作用于首波（ADR 24 / 48）：首波成员按 `mode = plan` 发言（只读门控，`forAgent(agent, 'plan')` 自动收敛为只读工具 ∪ 范式工具）；
- 调度官接手后首波可能被其占用（ADR 85 分支 ③），两难：
  - 若调度波吃 `plan` 范式：`invite_members` 非只读 → 只读门控下工具不可见 → 调度无法召集（首波语义「僵死」）；
  - 若简单忽略 `planFirst`：会话级「规划先行」静默失效（永久破洞）；
- 约束：规划语义保留、调度可用、消息级显式范式不走调度官（ADR 85）、`notePlanProtocolViolation` 检查语义不受影响。

## 决策

1. `turnModeOf`（engine.ts）：`waveIndex === 0` 且**本波成员全为调度官**且 `record.mode === 'plan'` → 本波返回 `execute`，并置一次性标记 `dispatchPlanDeferred = true`；
2. `waveIndex === 1`（业务首波）：消费标记（置回 false）并返回 `plan`——规划先行顺延到业务成员身上生效；
3. 调度官在**任何波**都是 `execute`（调度是编排原语，不吃范式）；范式之间的既有判定（计划步骤 owner 的 review 波）不受影响；
4. 消息级显式 `plan` / `review` 本就绕过调度官（ADR 85 分支 ②），不进本规则。

## 理由

- **两难解的顺延方案**：调度执行召集原语、规划在业务成员身上生效——两个语义都不牺牲，且实现是单标记 + 两个消费点；
- **一次性标记**：`dispatchPlanDeferred` 只被业务首波消费一次，无泄漏、无累积（Run 结束即消亡，不进持久化）；
- **调度恒 execute 的一致性**：避免「调度在 plan 态被只读门控掐死」这一类条件分支——调度官的工具面与范式无关，行为可预测（mock / eval 稳定）；
- **检查语义不受影响**：`notePlanProtocolViolation` 只在 plan 波检查——顺延后检查发生在真实的规划波（业务首波），语义更准确。

## 被否决的方案

- **调度官参与 plan 波**：`invite_members` 非只读，范式只读门控下不可见 → 召集不可能（功能直接消失）；
- **忽略 planFirst**（首波被调度占即失效）：会话级设置静默失效——用户开了「规划先行」却得到执行范式，无任何提示；
- **无条件把 planFirst 挪到第二波**：@ 直达场景（首波即业务首波、单波收束）下语义漂移——第二波未必存在；
- **调度官降级为只读工具集参与 plan 波**（只回答不召集）：「只说话不办事的空转回合」，违背调度职责。

## 适用与失效条件

- 适用：会话级 `planFirst` + 调度官占首波的组合形态（含无 @ 触发）；
- 失效条件：
  - **范式体系扩展**（新增范式类型）——需按同一「标记顺延」模式逐一处理分支；
  - **多调度官连续波**（调度官占据多波）——标记消费点（`waveIndex === 1`）需重估为「首个非全调度波」；
  - **调度官承担规划职责**（产品定位变化）——本 ADR 的核心前提（调度不吃范式）需重新评审。
