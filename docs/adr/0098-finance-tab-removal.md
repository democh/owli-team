# ADR 0098：撤除主区「行情」Tab（Finance Tab Removal）

- 状态：Accepted
- 引入：M34 呈现形态修订（续 ADR 97；2026-09-18）
- 相关：[design.md §53](../design.md)、[docs/finance-invest-design.md §6.2](../finance-invest-design.md)、[client/src/components/layout/AppLayout.tsx](../../client/src/components/layout/AppLayout.tsx)、[client/src/components/chat/md-ext/KlineBlock.tsx](../../client/src/components/chat/md-ext/KlineBlock.tsx)、[client/src/components/canvas/nodes/KlineNode.tsx](../../client/src/components/canvas/nodes/KlineNode.tsx)、ADR 66（金融投研专项）、ADR 97（K 线 / 博弈的会话与画布呈现）

## 背景

- M34 首期把金融投研落成主区「行情」「博弈」双 Tab；ADR 97 已撤除「博弈」Tab 与 GameLab（当时「行情」Tab / FinanceView 保留）；
- 保留期复盘：行情 Tab 仍是与协作主线并行的功能孤岛——自选列表与盯盘式轮询发生在会话之外，与「证据 → 讨论 → 交付件」的协作链路无交集；K 线的看盘诉求已由三形态覆盖（会话内 ```kline 块 / 画布 KlineNode / Agent `canvas_write` 通道）；
- 用户明确要求：删除行情面板。

## 决策

1. **撤除主区「行情」Tab**：移除 `FinanceView` / `KlinePanel` / `trading-hours` 组件、`AppLayout` 的 Tab 触发（含懒加载）、Command Palette「行情 / 自选」入口、`MainTab` 联合类型中的 `'finance'`、`.finance-kline-canvas` 样式与面板专用单测（runGame 契约测试迁移保留）；
2. **承载形态不变**：K 线仍由 ① 会话内 ```kline 块（工具条「送上画布」）、② 画布 `KlineNode`（空态直连网关拉取 / 结果态周期复权切换写回节点）、③ Agent 通道（`canvas_write` / `canvas_read` 的 kline 类型）三形态提供；博弈仍为会话 game 块 + 画布 `GameNode` + 协议化「多空对弈」链路；
3. **机制层与门控零改动**：`/api/finance/*` 网关、12 个 `fin_*` 工具、`finance_watchlist` 存储与 `FINANCE_ENABLED` 门控原样保留；`useFinanceEnabled` 前端探测 hook 随入口移除（服务端 `GET /finance/env` 路由保留）；设置页「金融投研」分组（启用 / 行情刷新 / 最小间隔 / Python 桥超时）与配置面保留。

## 理由

- **视图层纯收缩**：面板是纯视图层派生（ADR 97 已判定机制层不受影响）——撤除只减少入口与维护面，不动工具链 / 数据通道 / 存储；
- **协作台定位一致**：金融能力的价值入口是「会话与画布」（结论可引用、结果可落盘、快照可追溯），独立面板只能「看」不能「协作」；
- **形态收敛完成**：ADR 97 否决了「把 K 线 / 博弈塞进独立面板」的方向，本次把最后一个独立面板撤除，K 线 / 博弈入口全部收敛到会话与画布。

## 被否决的方案

- **保留行情 Tab（维持现状）**：与协作主线并行的面板无协作出口，其刷新轮询 / 自选管理成本与使用价值不匹配；
- **把行情能力并入其他主区 Tab（如画布扩展页签）**：仍是独立面板形态，换汤不换药；
- **连 K 线块 / 画布节点一并移除**：块与节点是会话上下文内的承载（与证据 / 交付件自然合流），与面板的孤立性有本质差别，保留。

## 适用与失效条件

- 适用：主区 Tab 集合聚焦「对话 / 交付件 / 画布 / 数据库 / 终端」；金融入口收敛为会话块与画布节点（Agent 工具面独立于 UI，不受影响）；
- 失效条件：若未来重现「重度投研工作台」需求（多屏盯盘 / 批量对比 / 面板级复用），按 ADR 97 同款失效条件在独立视图层重新评估；机制层（网关 / 工具 / 存储 / 门控）不受影响，纯视图层派生。
