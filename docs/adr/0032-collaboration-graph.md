# ADR 0032：协作图谱视图——React Flow 选型与前端推导口径

- 状态：Accepted
- 引入：M17
- 相关：[design.md §28](../design.md)、ADR 25、ADR 5

## 背景

聊天流回答「说了什么」，但「谁把活交给了谁、当前在谁手上、编制预期是什么」需要一张协作拓扑图。备选技术：手写 SVG 布局（工作量大、交互从零做）、AntV G6 / elkjs（图分析强但对 React 集成与动画另起炉灶）、React Flow（官方 React 生态、nodes/edges 受控模型 + 内置交互）。

## 决策

**用 `@xyflow/react`（React Flow 12+，MIT）+ `@dagrejs/dagre` 分层布局实现协作图谱；数据口径全部纯前端推导，零后端改动**：

- **按需懒加载**：`React.lazy` + 动态 import → 图谱独立 chunk，不进入首屏、构建产物门槛不回升；
- **数据推导**（新增纯函数 `client/src/lib/graph.ts`，`buildGraph(messages, participants, groups, live)`）：
  - 接力实线 = 每条 agent 消息的 `mentions` 派生（引擎既有口径：非交还用户时 mentions 即实际接手成员）→ 去重合成边 + 权重（接手次数）与最近时间；
  - 编制虚线 = 各场景 `group.chain` 相邻对（与实线同向重合时以实线为准）；
- **实时状态复用现有 RunEvent**：`wave:start` / `turn:start`（发言中光晕）、`run:start` / `queue:updated` / `turn:end.queue`（排队序号）、`turn:end`（新接力边）——无新通道、无新 API；
- **不绘制用户节点**（用户不参与形象系统）：交接给用户以节点「待你指示」状态呈现；
- **降级**：reduced-motion / 安静模式关闭流动与入场动画；空态展示编制链预览。

## 理由

- React Flow 的受控 nodes/edges 模型与 zustand 状态归约天然契合；MiniMap / Controls / 缩放平移 / 无障碍由库内置，自研成本高一个数量级；
- 纯前端推导让图谱不引入后端状态（无新表、无新接口、无一致性问题），消息流 + 运行事件是唯一事实源——「图谱只是同数据的另一种视图」；
- mentions 派生口径与引擎「显示的事件 = 实际发生的调度」一脉相承（§6.4），避免虚假转交边；
- 懒加载把 240KB 级（gzip ~80KB）的图谱 chunk 挡在首屏之外，兑现既有包体门槛。

## 被否决的方案

- **AntV G6 / elkjs**：图分析能力强但 React 集成 / 自定义节点 / 动画都要另起一套，生态与示例数量低于 React Flow；
- **手写 SVG + dagre**：交互（缩放 / 拖拽 / minimap / fitview）从零实现，维护成本不可接受；
- **后端计算图数据并持久化**：引入第二事实源与一致性问题，收益为零（前端已有全部输入）；
- **首屏引入图谱库**：包体门槛回升，违背 ADR 25 的产物纪律。

## 影响

- `client/package.json` 新增 `@xyflow/react`、`@dagrejs/dagre`；
- TeamPanel 第 7 视图（图谱 tab + 全屏浮层）；`run-store` 叠加 wave 归约供图谱实时状态；
- CI 包体检查继续通过（图谱为独立懒加载 chunk）。
