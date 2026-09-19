# ADR 0160：指标口径与取数链——kpi 五列 · kpiRowOf 单一解析 · bi 指标区与取数链

- 状态：Accepted
- 引入：M66 分析域批二（2026-09-19）
- 相关：[design.md §100](../design.md)、[docs/pk-game-analysis-design.md §6-N2](../pk-game-analysis-design.md)、ADR 0144（单一解析实现红线）、ADR 0114（冻结快照）、[remark-ext.ts](../../client/src/components/chat/md-ext/remark-ext.ts)、[KpiGroup.tsx](../../client/src/components/chat/md-ext/KpiGroup.tsx)、[ConsolePanel.tsx](../../client/src/components/scene/panels/ConsolePanel.tsx)、[derive.ts](../../client/src/components/scene/derive.ts)

## 背景

- `::: kpi` 容器（消息卡）为四列（名称 / 值 / 变化 / 目标），bi 协议红线要求数字可追溯「SQL + 口径 + 连接」三要素，但口径无结构化落位；
- bi 的取数过程（```sql 围栏）只存在于消息内；console 面板（bi 场景）为通用看板/时间轴，取数链与指标无聚合；
- 面板侧解析（raw 容器行）与消息侧解析（mdast 扁平文本）若无共享实现，结构稍复杂即漂移（ADR 0144 前例）。

## 决策

1. **kpi 五列（向后兼容）**：条目行扩展为 `名称 | 值 | 变化 | 目标 | 口径`——第 5 列可缺省，四列历史写法零变化；第 5 列经 `data-scope` 进消息卡，KpiItem 渲染口径徽章（截断 14 字 + hover 全文）；
2. **单一解析**：`kpiRowOf(raw)` 自 remark-ext 导出（含列表标记剥离）——remark 收尾（kpiItemNode）与场景面板（ConsolePanel 指标区）共用；`KpiRow` 类型同步导出；
3. **取数链派生**：新 `derive.sqlRunsOf(messages)`——成员消息 ```sql 围栏计数 + 首行摘要（excerptOf 口径）；**SQL 正文不复制渲染**（消息内代码块为唯一全文通道，防双实现与信息重复）；用户消息 / 无围栏消息跳过；
4. **console bi 分支**（`groupId === 'bi'`）：段序 = 指标区（kpi 卡网格 + 定位钮，`data-console-kpis`）→ 取数链（作者头像 + 摘要 + `SQL ×N` 徽章，点击定位，`data-console-sql`）→ 既有活动时间轴 / 交付件；非 bi / sre 场景行为零变化；面板就绪判定沿用既有「成员消息 / 管道 / 交付件」口径（零扩展）；
5. **资产**：bi 协议新增「渲染容器约定」段（条目 10–11：kpi 五列 / ```sql 围栏与结论行）；mock 触发块「指标走查」（kpi 双行含口径 + 单条 SQL）。

## 理由

- **向后兼容**：口径为可缺省列——历史消息 / 既有 mock 全量四列写法不受影响；
- **单一解析**：面板与消息两处共用 `kpiRowOf`（ADR 0144 红线复申）；`KpiItem` 组件面板与消息同组件复用（M38 先例）；
- **轻聚合**：取数链只做「条数 + 摘要 + 定位」，不复制 SQL 正文——面板职责是导航而非重复渲染。

## 被否决的方案

- **口径进独立容器 / 独立列**（如 `- 口径 | …` 行）：kpi 是单行条目语法，另起行破坏表格化；
- **面板拖取 SQL 正文渲染**：双实现 + 信息重复，且长 SQL 破坏面板密度；
- **新面板（第 7 类）承载指标**：console 分支足够，扩面板徒增注册面。

## 边界与失效条件

- 取数链条目依赖消息 id（定位锚点）；`sqlCount` 为围栏计数（嵌套 / 非常规围栏不计）；
- 口径列仅展示语义，不参与校验；若未来 bi 报告需机器可读口径，应以交付件附录为事实源（铁律 6 不变）。
