# ADR 0105：通用助手不可自动召集——三层隔离（M50）

- 状态：Accepted
- 引入：M50
- 相关：[design.md §60](../design.md)、[docs/blank-scene-design.md](../blank-scene-design.md)、[server/src/orchestration/roster-catalog.ts](../../server/src/orchestration/roster-catalog.ts)、[server/src/orchestration/platform-router.ts](../../server/src/orchestration/platform-router.ts)、ADR 0103（空场景资产，白名单无 `handoff`）、ADR 0101（PRS knownIds 过滤）、ADR 0087（roster_catalog 注入）

## 背景

- 通用助手 `general` 是资产型角色（ADR 0103）——可被用户手动邀请进任意会话；但**被自动拉入**会制造语义混乱：「单 Agent 模式」被平台悄悄变回多角色协作，且业务场景的 PRS 派发可能把通用任务给到它；
- 自动召集存在三条现实路径，必须全部封堵：① PRS 的 `roster_catalog` 注入（模型据目录幻觉召集 `general`）；② PRS 输出的 `members: ['general']`（即使不在目录中）；③ handoff 的目标解析（文本 / 工具转交到「通用助手」）；
- 单助手纪律（白名单无 `handoff`，ADR 0103）只封堵了「general 作为转交发起方」，其余三条路径需引擎侧隔离。

## 决策

三层隔离 + 一道白名单缺口，全部在引擎侧（资产无需任何标记）：

1. **目录隔离（roster_catalog）**：`buildRosterCatalogBlock` 不列 `blank` 场景与 `general`——PRS 的候选池天然不含它，模型无从据目录召集（不在目录 = 不会提议）；
2. **输出过滤（knownIds）**：`coerceRoutePlan` 以「场景可召集目录」的 `knownIds` 过滤 `members`——即使模型幻觉输出 `['general', ...]`，也被丢弃（trace 无 `members` 记录、编制不变、无系统事件条）；
3. **目标解析（resolveAgent）**：`handoff('通用助手')` 经 `resolveAgent` 过滤（blank 场景角色不在解析域）→ 拒「不在场」，且**不**走「未在场目标自动召集」路径（M48 为业务角色设计）——波末兜底交还用户；
4. **白名单缺口**：`general.tools` 无 `handoff`（注册清单差集仅此一项）——它自己也不会发起接力。

**边界（刻意保留）**：用户经成员面板**手动邀请** `general` 进业务会话——允许（与普通成员同权）；此时它在场，可被 PRS 正常派发（它不是「不可用」，只是「不可被自动拉入」）。

## 理由

- **自动 vs 手动的分界是用户意图**：自动召集是平台代用户决策（必须保守——单 Agent 模式不该被平台变回多角色）；手动邀请是用户明示（必须放行——资产型角色的题中之义）；
- **三层各守一段，纵深防御**：目录（不发生提议）→ 过滤（提议被丢弃）→ 解析（转交被拒绝）——任一层的失效不导致自动召集成立（单测逐层覆盖）；
- **错误语义显式**：handoff 拒「不在场」是有回执的明确错误（模型可据此改选目标），而非静默丢弃（会引发模型反复重试或困惑）；
- **零新机制**：三层均复用既有过滤点（目录构造 / knownIds / resolveAgent），无新增守卫代码路径。

## 被否决的方案

- **控制台级隐藏 `general`（软删除 / 不可见）**：违背资产型（用户应能编辑它）；机制应表现为引擎行为而非资产隐藏；
- **handoff 静默丢弃目标**：模型无法理解失败原因，可能循环重试；显式「不在场」回执让模型改道（或交还）；
- **在 PRS 提示词中写「不要召集 general」**：提示词约束不可靠（幻觉仍可能）；knownIds 过滤是确定性防线；
- **禁止手动邀请 `general` 进业务会话**：过度限制——用户把通用助手拉进团队协作是合法用法（如借它做跨域检索）；只隔离「自动」路径；
- **把 `general` 从 `/api/agents` 全量清单中剔除**：前端资产面板 / @ 列表 / 成员邀请全部依赖该清单；剔除会连带禁用合法手动路径。

## 适用与失效条件

- 适用：PRS 全部召集路径（未 @ 开场 / 空编制 / 增援）与 handoff 目标解析；手动邀请与 @ 直达不受影响；
- 失效条件：若未来 PRS 更换目录来源或新增召集通道（如平台侧模板），需同步评估是否绕过三层隔离；`knownIds` 的定义若改为「全量角色」而非「场景可召集目录」，过滤效力失效（回归见 `m50-blank.test.ts` 隔离组用例）；
- 测试镜像面：`server/tests/m50-blank.test.ts`（目录不含 general / PRS 幻觉召集被丢弃且无事件条 / handoff 拒「不在场」无自动召集）；`e2e/m50-blank.spec.ts` 反向断言「平台 召集了 …」不可见。
