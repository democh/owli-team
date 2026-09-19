# ADR 0097：K 线 / 博弈的会话与画布呈现（Session & Canvas Presentation）

- 状态：Accepted
- 引入：M34 修订（M34-2 / M34-3）
- 相关：[design.md §53](../design.md)、[docs/finance-invest-design.md §6.4](../finance-invest-design.md)、[client/src/components/chat/md-ext/GameBlock.tsx](../../client/src/components/chat/md-ext/GameBlock.tsx)、[client/src/components/chat/md-ext/KlineBlock.tsx](../../client/src/components/chat/md-ext/KlineBlock.tsx)、[client/src/components/canvas/nodes/GameNode.tsx](../../client/src/components/canvas/nodes/GameNode.tsx)、[client/src/components/canvas/nodes/KlineNode.tsx](../../client/src/components/canvas/nodes/KlineNode.tsx)、[client/src/components/chat/md-ext/VerdictCard.tsx](../../client/src/components/chat/md-ext/VerdictCard.tsx)、[server/src/tools/canvas.ts](../../server/src/tools/canvas.ts)、[agents/invest/_protocol.md](../../agents/invest/_protocol.md)、ADR 59（无限画布）、ADR 66（金融投研专项）

## 背景

- M34 首期把 K 线 / 博弈落成主区「行情」「博弈」双 Tab，其中博弈为 GameLab 独立面板（调参 → 运行 → 三栏结果）；
- 实际使用暴露形态问题：① 独立面板是功能孤岛——结果要「人搬回对话」才能与证据、交付件合流，与协作台定位冲突；② GameLab 是单机参数沙盘，没有 agent 参与，博弈的价值（多角色真实对抗、输出可追责的终局结论）无法成立；③ 用户明确纠偏：K 线与博弈应是 chat / 画布上的特殊交互，不是单独面板、不是呆板效果，要能让 agent 之间进行博弈输出最终结果；
- 复盘参照：会话内 kline / game 围栏块（M34 首期已有）是正确的方向，但「只读呈现」不足以承接「继续调参 / 换周期」的工作台诉求——画布（ADR 59，会话级 React Flow 文档）天然可承接。

## 决策

1. **撤除独立面板**：移除主区「博弈」Tab 与 GameLab 组件（「行情」Tab / FinanceView 保留）；Command Palette 同步撤「博弈」入口；GameLab 的模型 / 预设 / 调参 / 运行能力迁移进画布节点；
2. **三形态承载**（同一份数据、同一套渲染内核：game-spec / kline-spec / GameResultView / KlineCanvas）：
   - ① 会话内块：kline / game 围栏（流式显示源码，完成终态渲染），工具条新增「送上画布」（K 线 bars 内联 / 博弈数据集含结果）；
   - ② 画布节点：`GameNode` 配置态（模型 / 标的 / 话题 / 场景预设 / 高级参数（种子 + 模型参数）→「运行推演」直连 `POST /api/finance/game`）→ 结果态（与消息块共用内核；agent `canvas_write` 或「送上画布」写入自动切结果态）；`KlineNode` 空态（输入标的「拉取行情」直连 `GET /api/finance/kline`）→ 结果态（周期 / 复权切换 + 刷新，切换结果写回节点）；
   - ③ Agent 通道：`canvas_write` / `canvas_read` 支持 `game` / `kline` 节点类型（摘要 digest：博弈「有结果 / 配置态」、K 线「标的 / 名称 / 周期 / 根数」），Agent 可把 `fin_game` / `fin_kline` 产物直接落画布；
3. **对抗博弈协议化**（「让 agent 之间博弈输出最终结果」）：invest 协议新增「多空对弈」四条（触发与阵容 / 回合纪律 / 走子口径 / 终局裁决写法）；预设 `bull-bear-duel` 一键发起（五角色全链：多方秦砚 × 空方雷动逐轮对抗、闻笛归堆证据弹药、方程量化走子、祝衡终局裁决）；方程经 `fin_game` 逐轮走子并落快照；主管以 `::: verdict` 裁决卡落卡（胜负三方「多方 / 空方 / 僵持」+ 置信度 + 核心依据 + 翻盘条件）；
4. **可复现不变**：博弈运行仍为纯计算（seed 透传、`FINANCE_GAME_MAX_PATHS` 护栏、不耗 LLM）；「模型推演，非预测」标注与快照路径要求原样保留。

## 理由

- **呈现与协作同轨**：块与画布节点都落在会话上下文里（画布是会话级文档），结论 / 证据 / 交付件天然可追溯、可引用、可版本化（画布自动保存 + 撤销历史）；独立面板则需要人肉搬运结果；
- **一个内核三种入口，零分叉**：数据解析（game-spec / kline-spec）与渲染内核（GameResultView / KlineCanvas）三处共用——修一次全对；画布节点与消息块的懒加载 chunk 同源（不进主包）；
- **工作台实体 vs 仅本地**：K 线块的周期切换仅本地展示（不改快照），画布节点的切换写回节点（用户的工作台资产）——两种语义各有其位，互不污染；
- **agent 对抗才是博弈本体的产品化**：逐轮立论（挂证据与置信度、回应对方论据）→ 量化走子 → 终局裁决的协议链路，让博弈输出「可追责的最终结果」而非一组参数曲线；裁决卡是结论的固定容器，可被报告引用与复核。

## 被否决的方案

- **保留 GameLab 仅优化视觉**：形态本身（独立面板 / 单机沙盘）与「会话与画布」定位冲突——优化视觉不解决「搬结果」与「无 agent 参与」；
- **博弈做成独立应用 / 页面**：与协作台定位相悖，用户明确要求 chat 或画布承载；
- **只保留消息块（不做画布节点）**：块是「看」的终态（流式纪律），无法承接「继续调参 / 切周期 / 重新拉取」；
- **agent 直接产出静态图 / 文字结论（不落节点与快照）**：失去可复现性（seed / 快照路径 / 统一降级），且与既有 `fin_*` 工具链割裂；
- **把 K 线 / 博弈塞进「行情」Tab 扩展页签**：仍是独立面板形态，换汤不换药。

## 适用与失效条件

- 适用：K 线 / 博弈的全部呈现入口（会话块 / 画布节点 / Agent 通道）；`FINANCE_ENABLED` 门控不变——关闭态行情 Tab 隐藏、画布节点运行报「服务未启用」；画布工具白名单（全角色 `canvas_*` 已具）不变；
- 失效条件：若未来出现「重度投研工作台」需求（多屏盯盘 / 批量对比 / 面板级复用），可在独立视图层重新评估布局；机制层（节点类型 / 渲染内核 / 工具 / 协议）不受影响，纯视图层派生。
