# ADR 0161：事故时间轴分级与 SLO 区——timeline 第三列语义 · incidentLevelOf · console sre 分支

- 状态：Accepted
- 引入：M66 分析域批二（2026-09-19）
- 相关：[design.md §100](../design.md)、[docs/pk-game-analysis-design.md §6-N3](../pk-game-analysis-design.md)、ADR 0144（单一解析实现红线）、ADR 0114（冻结快照）、[remark-ext.ts](../../client/src/components/chat/md-ext/remark-ext.ts)、[ConsolePanel.tsx](../../client/src/components/scene/panels/ConsolePanel.tsx)、[derive.ts](../../client/src/components/scene/derive.ts)、[sre/_protocol.md](../../agents/sre/_protocol.md)

## 背景

- `::: timeline` 通用语法为 `日期 | 事项 | 负责人`；sre 场景事故时间轴需要「等级」维度（P0/P1/P2），原无结构化落位——分级只存在于复盘卡叙述与正文；
- console 面板（sre 场景）为通用消息摘要时间轴，无分级色带与筛选；
- SLO / 错误预算（sre 协议交付件内容）在面板无承接。

## 决策

1. **第三列场景语义约定**：sre 场景 timeline 条目第三列语义 = **等级**（`- 时间 | 事件 | 等级`）——协议显式写入（渲染容器约定条目 13）；通用场景仍为负责人（Timeline 消息卡行为零变化）；
2. **等级归一化**：新 `derive.incidentLevelOf(value)`——P0|严重|紧急 → p0；P1|高 → p1；P2|中 → p2；其余（含 低 / 观察 / 空）→ other；大小写不敏感（`toLowerCase` 后匹配）；
3. **单一解析**：`timelineRowOf(raw)` 自 remark-ext 导出（列表标记剥离），面板与消息两处共用；`TimelineRow` 类型同步导出；
4. **console sre 分支**（`groupId === 'sre'`）：段序 = 事故时间轴（时间 + 事件 + 等级徽标 + 左缘色带；筛选 chips 全部/P0/P1/P2，本地态 `ma:sc:tl:<sessionId>`，`data-console-incidents`）→ SLO 区（kpi 容器复用指标卡渲染，`data-console-slo`）→ 交付件；**有事故时间轴容器时通用「活动时间轴」让位**（无容器回落通用时间轴，保留既有效用）；
5. **资产**：sre 协议渲染容器约定追加条目 13–14（时间轴三列语义与等级词 / SLO kpi 五列含时间窗口径）；mock 触发块「事故走查」（四级 timeline + SLO kpi 双行）。

## 理由

- **列语义按场景解释**：timeline 语法保持单一（三列），等级归 sre 语义层（`incidentLevelOf`）——不为单场景扩列破坏通用语法；
- **归一化容忍中文档位**：真模型输出常写「严重 / 高」——归一化保证色带与筛选稳定；
- **让位而非并存**：事故时间轴与通用时间轴叠放会重复信息——有容器以专用为准，无容器回落兜底。

## 被否决的方案

- **新容器 `::: incident`**：timeline + 等级列足以承载，新容器徒增语法面（与 M63「ruling 不另起 verdict」同口径）；
- **在 remark-ext 内做等级映射**：等级是 sre 场景语义（非容器语法），放 derive 场景层，通用 Timeline 卡不染指；
- **筛选态落库**：交互态一律 `ma:sc:*` sessionStorage（ADR 0068 边界）。

## 边界与失效条件

- 非 sre 场景 timeline 第三列仍按负责人渲染（消息卡「派活」按钮语义不变）；
- 事故时间轴条目依赖 timeline 容器（未用容器的 prose 时间线不进面板）；
- 若未来引入 P3/观察专用色相，扩展 `incidentLevelOf` 词表与 CSS 色板即可（结构不变）。
