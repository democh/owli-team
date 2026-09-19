# ADR 0152：画布深度完善批——缺陷自愈 · 内核交互补全 · 联动互链 · 账本重核（M31 修订）

- 状态：Accepted
- 引入：画布完善批（2026-09-19）
- 相关：ADR 0138（画布 UX 修订）· ADR 0146（Agent 联动）· [client/src/lib/canvas.ts](../../client/src/lib/canvas.ts) · [client/src/components/canvas/CanvasView.tsx](../../client/src/components/canvas/CanvasView.tsx) · [server/src/orchestration/engine.ts](../../server/src/orchestration/engine.ts)

## 背景

两轮修订（ADR 0138 / 0146）后盘点出 12 项剩余优化，其中 **#1 僵尸 pending 是唯一已知真实缺陷**：服务端重启后任务内存丢失，但画布占位节点仍在永远呼吸（`pending` 无任何收口路径）；其余为内核交互补全（查找 / 工具态记忆 / ⌥ 复制 / 重连）、联动互链（消息定位 / 面板互链 / 他会话提示 / 等距吸附）、大画布性能档与测试账本重核。

## 决策

1. **僵尸占位自愈（#1）**：`media-store` 增 `jobsLoaded`（任务快照「成功拉取」门槛——拉取失败不得误标）；`CanvasView` 打开画布即 `load` → `canvas-store.reconcileStalePending(jobIds)`：`pending=true` 且 `jobId` 不在快照（服务端重启 / 历史清理）→ 转中断态（`pending:false + error='生成中断（任务已丢失，可重新生成）'`，`history:false` 不进撤销栈）。在快照中的任务（含活跃与终态）一律保留，等合流。
2. **失败节点「重新生成」（#2）**：`NodeContextMenu` 对 image/video 且 `error` 且非 pending 的节点给入口——按节点存留的谱系参数直接 `createJob`（text 类与首尾帧）；输入不齐（图生图 / 图生视频的输入图未随节点落存、首尾帧缺失）→ 回填生成面板引导补齐（不静默失败）。
3. **画布内查找（#3）**：`lib/canvas.searchNodes` 纯函数（九字段可搜 / 大小写不敏感 / limit 12；命中给 label + 类型标签 + 片段）；`CanvasSearch` 顶部居中浮层（`/` 快捷键 + 工具栏「查找节点」）；定位 = `setCenter`（zoom ≥1） + 程序化选中（`updateNode` 清旧选 / 置新选） + 闪环（连续定位不关面板，Esc 关闭）。
4. **工具态记忆（#4）**：手型/选择与网格吸附写入 `sessionStorage`（`ma:canvas:tool` / `ma:canvas:grid`；同 `ma:pn:*` 先例；隐私模式静默降级）。
5. **⌥ 起手拖拽复制（#5）**：`onNodeDragStart` 读 `altKey`——拖动集合以 RF 内部选中为准，`materializeClipboard(clip, 0, 0)` 零偏移副本落原位、原件随手指拖走（Figma 语义；仅起手判定，不做拖拽中切换）。
6. **边重连（#6）**：`onReconnect` —— 复用 `canConnect` 合法性矩阵 + 去重；**保持原 edge id**（重连 = 改端点，前端 key 稳定）；kind 以节点组合的 `canConnect` 结果为准。
7. **消息 → 画布精确定位（#7）**：`ToolCallRecord.meta` / `ToolResult.meta`（通用结构化元信息，可选字段）；engine 在 `runToolCall` 持久化 `entry.meta`；`canvas_write` 返回 `{ canvasNodes: [写入节点 id] }`、`media_*` 返回 `{ canvasNodes: [占位节点 id] }`；ToolCard「在画布查看」带 id → `requestAction('focus', { nodeIds })`（单节点居中选中 / 多节点取景 + 闪环；lazy 挂载后消费不丢）。
8. **节点 ↔ 生成面板互链（#8）**：`canvas-store` 增通用闪环通道 `nodeFlash`（`pulseNodes / consumeNodeFlash`）；面板任务行 hover → 画布对应 jobId 节点闪环；画布单选产物节点 → `selectedJobId` 面板行高亮。
9. **他会话写入提示（#9）**：`ui-store.otherCanvasWrites`（按会话计数）；ws-store 对 `by=agent` 且**非同会话**的广播计数 → 会话列表行内小点（`title='Agent 刚更新了该会话的画布'`）；切到该会话即清零（`SessionList` 监听 `currentId`）。
10. **等距吸附（#10）**：`computeSnap` 叠加 `distSnap`——被左右（或上下）两节点夹击且两侧间隙近似相等（≤ 阈值）时**吸附到等距中点**（优先于普通对齐，更强意图）；输出两条 `kind='dist'` 标记线（两侧间隙中点），前端以独立玫瑰色渲染（与主色对齐线区分）；像素画布无数值标注（数值无物理意义）。
11. **大画布性能档（#11）**：`onlyRenderVisibleElements` 自动启用（**>150 开 / <120 关**回差防临界抖动；小画布保持全量渲染零风险）；裁剪下重挂载会重播入场动画 → `.canvas-culling` 关闭 `.canvas-node-pop`；闪环 / 参考线为 ViewportPortal 覆盖层不受裁剪影响。
12. **测试账本重核（#12）**：design.md §12.1 与命令表更新为实测值——服务端 1169 例 / 90 套件、客户端 990 例 / 78 套件、E2E 96 条 / 40 spec。

## 理由

- 自愈走「打开画布时校验」而非前端补放 / 服务端全盘扫描：判定源（任务快照）天然在场且带 `jobsLoaded` 成功门槛，成本一次 GET；
- 查找 / 定位 / 闪环 / 互链全部复用既有原语（`searchNodes` 纯函数、`flashNodes` 泛化、`focus` 动作通道、`pulseNodes`），没有新增渲染体系；
- ⌥ 复制选「零偏移副本留原位」而非"拖拽中动态复制"：RF 拖拽锁定 mousedown 节点，起手判定是唯一可靠语义；
- 重连保持 edge id + 组合定 kind：与既有连线矩阵完全同源（不引入第二套合法性判断）；
- 性能档阈值 + 回差 + 动效关闭是「保守启用」路线：受控重建纪律（ADR 0093）不受冲击，大画布才切换。

## 被否决与边界

- **#6 重连的自动化 E2E**：RF 端点手柄拖拽在无头环境脆弱（命中几何依赖缩放 / 边选中态）——单测不可及（组件内回调），以手工验收 + 逻辑复用既有矩阵兜底（记为本批测试缺口）；
- **僵尸判定放宽到「任务不在活跃态」**：终态（succeeded/failed/canceled）时服务端会 settle（update/remove），前端抢判会与合流竞态——只在「任务完全不在快照」时判中断；
- **等距数值标注**：画布为像素世界无物理尺寸，只以双标记线表达"两侧等距"；
- **查找面板 ⌘F**：浏览器保留键不可拦截（同 ADR 0138 纪律），改用 `/` + 工具栏。

## 影响

- 前端：`lib/canvas.ts`（searchNodes / distSnap / SnapGuide.kind）、`CanvasSearch.tsx`（新）、`CanvasView.tsx`（查找 / 工具态记忆 / alt 复制 / reconnect / 裁剪档 / flashNodes 泛化 / focus 消费）、`CanvasToolbar.tsx`（查找钮）、`NodeContextMenu.tsx`（重新生成）、`canvas-store.ts`（reconcileStalePending / nodeFlash / focus 动作）、`ui-store.ts`（otherCanvasWrites）、`ws-store.ts`（他会话分支）、`SessionList.tsx`（行内小点）、`GenerationPanel.tsx`（互链）、`ToolCard.tsx`（meta 定位）、`media-store.ts`（jobsLoaded）、`index.css`（dist 线 / culling）；
- 服务端：`tools/registry.ts`（ToolResult.meta）、`orchestration/engine.ts`（entry.meta）、`tools/canvas.ts` / `tools/media.ts`（canvasNodes meta）；
- 共享：`shared/src/types.ts`（ToolCallRecord.meta）；
- 测试：client `m31-canvas`（+6：searchNodes ×3 / 等距 ×3）、`m31-canvas-agent`（+4 + ToolCard 定位改造）、`m31-media`（jobsLoaded 断言）；E2E `m31-canvas-ux`（+2：查找定位 / 大画布裁剪）、`m31-canvas-agent`（+1 自愈；「预置渲染」重写为**黑孔服务真实挂起任务**——从「快速失败」不确定性中解耦）；
- 文档：本 ADR、README 索引、design.md §49 修订注记 + §12.1 账本与命令表。

## 验证

- 隔离环境（8795 / e2e-ux）E2E **10/10 全绿**（含 `m31-canvas-interactions` 回归）；client 全量 990 例（1 例为并行批次 `m43-pk` 中间态，非本批）；server 全量 1169 例（1 例为并行批次 `store.test` 迁移 fixture 中间态，非本批）；三包 typecheck / lint 干净。

## 适用与失效条件

- 适用：全部会话画布；黑孔挂起任务模式（E2E）可用于任何「任务进行中」视觉验收；
- 失效条件：若媒体服务引入任务持久化（重启恢复）——僵尸判定需改为「任务表无此 id」；若画布引入虚拟坐标 / 物理尺寸——等距数值标注可恢复；
- 已知边界：⌥ 复制仅起手判定；重连未自动化覆盖；查找匹配为纯文本子串（无模糊 / 拼音）。
