# ADR 0177：console 面板二批——五场景分支（客户管道 / 经营指标 / 节奏 / 融资进度与问答 / 主张与依据）

- 状态：Accepted
- 引入：批六（console 面板专业化，2026-09-19）
- 相关：[design.md §106](../design.md)、[docs/scene-chat-design.md §9](../scene-chat-design.md)（M41 §9 边界遗留项——「console 面板专业化另批评估」的落地）、ADR 0169（服务型容器族——数据源）、ADR 0144（单一解析红线）、ADR 0064（统一回填）、[client/src/components/scene/panels/ConsolePanel.tsx](../../client/src/components/scene/panels/ConsolePanel.tsx)

## 背景

- console 面板（dock 右区）现有分支（M66）：bi 指标区 + 取数链、sre 事故时间轴 + SLO；其余 console 场景仅通用「管道（kanban/pipe/board）+ 活动时间轴 + 交付件」；
- 遗留：ADR 0169 边界明示「sales / finance / funding / ops 的 console 面板专业化不在本批（另批评估）」；
- 数据源已就绪（场景协议容器约定 + 本批前已落容器）：sales `::: pipeline`（M41）· funding `::: progress` / `::: qa`（M41）· marketing 内容排期 `::: timeline` · ecommerce 经营指标 `::: kpi` + 大促节点 `::: timeline` · legal-personal 案件时间线 `::: timeline` + 主张与依据 `::: claim`；
- console 场景全量：bi / sre / ecommerce / funding / legal-personal / marketing / sales（finance 为 stream，无 console）。

## 决策

1. **场景分支矩阵（有容器数据才渲染对应段）**：
   - **sales**：`::: pipeline` → 「客户管道」——阶段列（线索/意向/报价/成交 + 未知归「其他」，与消息卡同口径）+ 列头「N 家 + 金额合计」（`numberWithSuffix` 可解析行才计入；全不可解析 → 不显示合计）+ 点卡定位来源消息；
   - **ecommerce**：「经营指标」（kpi → KpiCells 复用）+「大促节奏」（timeline 容器 → 节奏行，第三列 = 节点徽标）；
   - **marketing**：「内容节奏」（timeline 容器 → 节奏行，第三列 = 渠道 / 负责人徽标）；
   - **legal-personal**：「案件时间线」（timeline → 节奏行，第三列 = 节点类型徽标）+「主张与依据」（claim 容器 → 标题 + 条目（主张 + 依据）；条目层与消息卡同解析）；
   - **funding**：「融资进度」（`::: progress` → **ProgressCard 同组件渲染**）+「投资人问答」（`::: qa` → **QaCard 同组件渲染**）——两段各带「定位」按钮回源消息。
2. **同组件渲染原则（M38 汇聚板先例）**：进度 / 问答段直接复用消息内卡片组件（`rows` 由单一解析 `parseProgressItems` / `parseQaPairs` 产出 JSON 注入）——面板与消息零分叉；面板内嵌样式微调走 `.scene-console-embed` 作用域（不改造卡片）。
3. **通用时间轴让位规则扩展**：有专用时间轴语义的段在场时，通用「活动时间轴」不重复渲染——原 sre 规则扩展至节奏场景（marketing / ecommerce / legal）；节奏容器缺席时回落通用时间轴（既有口径保持）。
4. **claim 单一解析补全（ADR 0144 红线）**：新导出 `parseClaimLines`（列表标记双重剥离无害；细节 / 元信息行跳过——与卡上消费口径一致），`finalizeClaim`（mdast 路径）重构为共用同一解析——claim 容器自此 remark / panel 双路径同源。
5. **KpiCells 提取**：bi 指标 / sre SLO / ecommerce 经营指标三处 kpi 网格收敛为一个内部组件（DOM 与 M66 分支完全一致，attrs 由各分支 wrapper 保留）。
6. **mock 触发（E2E 数据源）**：「店铺走查」（store-operator → kpi + timeline）/「案件走查」（rights-advisor → timeline + claim）；marketing 由 content 基础剧本自带 timeline；sales / funding 复用 M41 触发块。触发词全仓唯一、块内不写 @。

## 理由

- **阶段列而非通用看板**：pipeline 与 kanban 语义不同（有固定阶段枚举与金额维度）——套用通用列会丢弃金额与未知阶段归一；专用段换来「合计 + 其他列」两处销售视角必需信息；
- **同组件渲染而非面板重写**：进度 / 问答卡在消息内与面板内形状一致，用户心智一次建立；重写面板原生版会引入第二套解析与样式（ADR 0144 红线指向的正是这类分叉）；
- **节奏段共用一份实现 + 场景化标题**：timeline 容器在三个场景语义近似（日期 + 事项 + 第三列），仅标题与第三列解读不同——参数化标题即可，否则三份近似代码；
- **让位规则而非并存**：专用段时间轴语义与通用活动时间轴重叠时并存会造成「同一事实两处展示」的噪声（sre 先例已确立该判断）；
- **合计在视图层派生**：金额合计是对容器数据的纯函数聚合（可解析行求和），不触发角色重算、不动服务器——不可解析金额不猜（字段原样展示）。

## 被否决的方案

- **pipeline 走通用 KanbanBoard**：丢弃阶段枚举与金额（见上）；
- **funding 面板重写进度 / 问答原生渲染**：违背同组件渲染原则；且 parseProgressItems / parseQaPairs 已有单一实现；
- **claim 面板视图带 detail 行**：面板是聚合视图（扫视层），全文细节留在消息卡；带 detail 会使聚合列表噪声化；
- **节奏段三场景各写一份**：参数化标题的成本远低于三份近似实现的维护成本；
- **合计用服务器 / calc 工具**：视图聚合不是业务计算（无口径问题、无精度要求）；引入工具调用会把渲染变成异步依赖。

## 边界与失效条件

- 测试锚点：`data-console-pipeline` / `data-pipe-stage` / `scene-pipe-total` / `data-console-rhythm` / `scene-rhythm-owner` / `data-console-progress` / `data-console-qa` / `data-console-claims` / `scene-claimcell-*` / `data-console-kpis`（ecommerce 复用 bi 锚点）/ `data-console-slo`（sre 不变）；
- 通用 `kanban/pipe/board` 段对新场景保持既有行为（pipeline 不进通用列——KANBAN_NAMES 不变）；
- finance（stream）无 console 面板，本 ADR 不涉；若未来 finance 改 dock，需评估补充分支；
- `parseClaimLines` 跳过细节 / 元信息行属行为约定：若未来 claim 协议允许「条目形态的细节行」，须同步调整（单测覆盖该边界）。
