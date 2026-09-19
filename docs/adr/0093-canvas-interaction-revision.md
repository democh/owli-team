# ADR 0093：画布点击 / 拖动 / 选中交互修订（Canvas Click, Drag & Selection Revision）

- 状态：Accepted
- 引入：M31 / M34（画布交互修订）
- 相关：ADR 59（无限画布与媒体创作工作台：受控更新纪律）、ADR 32（协作图谱视图：React Flow 选型与前端推导口径）

## 背景

- 用户报告「画布的内容不能选中进行交互」：节点（尤其 K 线节点）轻点无反应 / 选中不稳定，拖动松手后选中框消失，拖 K 线图表会把整个节点拖走；
- 实验取证（Playwright 事件日志 + 逐帧拖动探针）确认三处根因：
  1. **点击容差死角**：React Flow 默认 `nodeClickDistance=0` + `nodeDragThreshold=1`——按下后 0~1px 的微移（触摸板 / 鼠标点按常态）落在死区：d3 drag 判定「已移动」在 mouseup 后吞掉 click（单击选中 / 双击 / 节点内点击派发失败），且位移未达拖动阈值不进入拖动（无 startDrag 选中路径）→ 轻点无反应；
  2. **受控重建丢 selected**：拖动结束 `commitPositions` 回写文档（debounce 保存）→ doc 变化触发受控重建 `mergeNodes` → 位置变化节点走重建分支（只携带 `measured`）→ React Flow 内部维护的 `selected` 被抹掉 → 松手瞬间选中框消失；
  3. **K 线图表区拖动冲突**：图表区（`canvas-kline-frame`）未标 `nodrag`——拖图表平移行情时 d3 接管为节点拖动（图表交互失效、节点被误移）。

## 决策

1. **点击 / 拖动阈值统一 4px**：`ReactFlow` 显式传 `nodeClickDistance={4}` 与 `nodeDragThreshold={4}`——≤4px 一律按点击（click 正常派发），>4px 才进入节点拖动；点击与拖动之间不留死角，触摸板微移常态被覆盖；
2. **受控重建契约补充 selected**：`mergeNodes` 重建分支在保留 `measured` 之外再转抄旧节点的 `selected`——`selected` 由 React Flow 内部交互维护（外部受控层不产出），文档回写引发的重建必须转抄，否则当场抹选中；契约字段 = 未变引用 / `measured` / `selected`；
3. **K 线图表区 `nodrag` + `nowheel`**：滚轮缩放与拖动平移归图表自身，不触发画布缩放与节点拖动；节点拖动 / 缩放走标题栏、边框与 NodeResizer（`nodrag` 元素完全绕过 d3：不吞 click、不触发拖动）。

## 理由

- **4px 取同值**：d3 的 clickDistance（吞 click 判定）与 XYDrag 的 threshold（startDrag 判定）是两套独立机制，分别取默认值 0 / 1 时天然存在 (0,1]px 死区；取同值把「点击 / 拖动」划分为互补区间，任何位移都有明确归属；4px 覆盖触摸板抖动，又小于有意拖动的最小意图位移；
- **selected 转抄而非外部建模**：选中态是多选 / 框选 / 快捷键复合交互的内部态（host state），外部层（doc）不建模；重建时最小成本转抄，避免双向同步与回写竞态；
- **nodrag 逃生舱**：图表需要原生平移 / 缩放手势；`nodrag` 是 React Flow 官方机制、语义最直接，与画布既有「节点内按钮一律 nodrag」纪律一致。

## 被否决的方案

- **只调大 nodeDragThreshold**：阈值上移只是移动死区（0~阈值仍吞 click 且不拖动），必须同时给 clickDistance 容差；
- **nodeClickDistance / nodeDragThreshold 置 0**：任何微移都算拖动，点击与拖动不可分（轻点即位移、双击编辑被拖动吞掉）；
- **doc 模型显式建模 selected（外部权威）**：选中为 React Flow 内部复合交互态，外部建模徒增同步与竞态；未来若引入协作 / 持久化选中再重估；
- **图表区事件拦截（stopPropagation / pointer-events）**：需保留图表滚轮缩放与拖动平移，事件拦截无法两全；`pointer-events:none` 会让图表不可交互；
- **图表区降级为静态图**：损失行情平移 / 缩放，与 K 线块能力对齐纪律冲突。

## 适用与失效条件

- 适用：画布 Tab（CanvasView 受控 ReactFlow）全部节点类型；K 线 / 图表类节点交互；协作图谱不受影响（独立组件，非受控文档语义）。
- 失效条件：
  - React Flow 升级若改变 `nodeClickDistance` / `nodeDragThreshold` 默认值或 XYDrag 判定逻辑，需按本 ADR 背景复验死区；
  - 若画布引入触屏优先手势（长按拖动 / 双指），4px 点击容差需重新校准；
  - 若未来 doc 显式建模选中（多人 / 持久化选中），`mergeNodes` 的 selected 转抄应改为外部权威来源。
