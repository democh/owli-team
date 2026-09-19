# Agent 与画布联动深化——全周期绑定与可感知协作（M31 修订设计）

> **状态**：已实施（2026-09-19）——A 任务全周期绑定 ✅ · B 写入可感知 ✅ · C 消息侧入口 ✅ · D 输入侧引用 ✅
> **关联**：M31 画布内核（design.md §49 / ADR 0059）· §49.6 Agent 闭环 · ADR 0138（画布 UX 修订）· ADR 0124（媒体连接全局化）
> **修订**：v1 初稿（2026-09-19）· v2 收口（同日）：按实际实施回写

## 1. 背景：现状盘点与四个缺口

现有通道（已确证）：

| 通道 | 实现 | 缺口 |
| --- | --- | --- |
| Agent → 画布（写） | `canvas_write` → `CanvasStore.applyOps`（读-改-写 + version+1 + 原子落盘 + 广播 `notify:canvas-changed {version, by}`） | 广播无 touched ids / 无 actor → 前端只能整体拉取，**无高亮、无角标、无作者** |
| Agent → 画布（媒体） | `media_generate/media_video` 创建即返回；**产物落位完全依赖前端 media-store.placeOutputs** | ① 前提是「该会话画布已加载」——用户未打开画布 → **静默放弃、无补偿**（工具描述却承诺"自动落到画布"）；② 生成中画布零表达（`canvas-breath` / `FlowEdge.flowing` 均为 P3 未接线）；③ placedJobs 为内存 Set，无持久补偿 |
| 画布 → Agent | 节点右键「引用到对话」· CanvasComposer 指令条 · `canvas_read` 摘要 | 引用入口藏在右键（低发现性）；发送时无「选中节点」上下文 |
| 消息侧 | ToolCard 通用渲染 | `canvas_*` / `media_*` 四工具**无 TOOL_META**（显示原始英文名 + JSON）；无「在画布查看」入口 |

## 2. 总体设计：三条原则

1. **服务端为真相**：凡"系统行为"（媒体产物落位 / 占位）由服务端在事务内完成——前端只负责渲染与提示，不做"在线才生效"的补偿逻辑；
2. **写入可感知**：Agent 的每一次画布写入，用户都能回答三问——**谁写的（actor/徽标）、写了什么（角标/闪环高亮）、在哪看（Tab 角标 + 消息侧入口）**；
3. **全周期可见**：媒体任务从提交那一秒起就在画布上有存在感（占位 → 完成后原地变产物 / 失败保留可重试 / 取消移除）。

## 3. A · 生成任务与画布节点全周期绑定

### 3.1 流程（服务端落位）

```
create ──▶ ① 落占位节点（add_node：pending=true / jobId / prompt / params / 首尾帧）
           位置 = canvasTarget ?? autoPosition（第二次任务自动错开：占位已在 nodes 里）
           广播 notify:canvas-changed（by=agent, touched）→ 画布实时出现呼吸占位
running ─▶ 进度节流广播 notify:media-job（前端节点内实时进度文案）
succeeded ▶ ② update_node 原地替换（artifact/pending=false）；多余产物 add_node 横向排开
failed   ▶ ② update_node 保留（error 文案 + pending=false，节点可重试）
canceled ▶ ② remove_node（用户主动取消 → 干净移除）
```

### 3.2 契约（shared）

- `CanvasImageData` / `CanvasVideoData` 加 `pending?: boolean`（生成中占位；完成/失败后清除）；
- `MediaJob` 加 `canvasNodeId?: string`（占位节点映射）与 `placedCanvas?: boolean`（落位结果；前端 toast 文案依据）；
- `MediaJobInput` 加 `placeOnCanvas?: boolean`（缺省 true；`media_*` 工具的 `place_on_canvas=false` 映射于此）。

### 3.3 服务端

- `CanvasStore.applyOps(sessionId, ops, opts?: { by?, reason? })`：`by` 注入节点顶层（仅 agent 写入），publish 扩展 meta（`actor` / `touched: {added, updated, removed}` / `reason: 'save' | 'ops' | 'media'`）；
- `MediaService` 注入 `canvas?`（结构接口，未装配时全部落位静默降级）；`create` 落占位、`finalize` 结算（幂等：仅状态真实转换时执行一次）；
- `server/src/tools/media.ts`：移除 `autoCanvasTarget`（服务端接管自动排布，天然错开并发任务）；`place_on_canvas` 透传。
- 广播语义：**落位广播统一 `by='agent'`**（前端合流 + 角标 + 高亮）；节点级 `by` 仅记录 agent actor（`actor='user'` 不记录 → 用户自己的任务节点无作者徽标）。

### 3.4 前端

- `media-store`：删除 `placeOutputs` / `placedJobs`（服务端已落位，防双写）；succeeded toast 按 `placedCanvas` 分流文案（已落到画布 / 产物已保存到交付件）；
- `ImageNode` / `VideoNode`：`data.pending` → 呼吸占位 + 实时进度文案（media-store jobs 按 jobId 查 `progressText`，缺省"生成中…"）；
- `CanvasView`：`toFlowEdges` 对「target 为 pending 节点」的边注入 `flowing`（**接线 P3 遗留的能量流动**）。

## 4. B · 写入可感知（谁 / 什么 / 在哪）

| 反馈面 | 设计 | 实现 |
| --- | --- | --- |
| **谁写的** | 节点作者徽标：节点左下角 14px AgentAvatar（title「由 X 写入」）；仅 agent 写入的节点有 | `CanvasStore.applyOps` 注入 `CanvasNode.by`（契约可选字段，sanitize 天然兼容）；`NodeShell` 内部从 canvas-store 查 by（**零侵入各节点组件**，选择器返回字符串引用稳定） |
| **写了什么** | 画布内：远端写入的节点位置浮现**闪环**（一次性 1.6s 描边脉冲；ViewportPortal 渲染，不碰节点数据/受控重建纪律） | canvas-store 记录 `remoteFlash {ids, nonce}`（广播 meta.touched 过滤仍存在的节点）→ CanvasView `useEffect(nonce)` → ViewportPortal 渲染 → 定时清理 |
| **在哪看** | 非画布 Tab：主区「画布」页签**未读角标**（计数，切画布清零——与交付件 `newArtifactCount` 同一模式） | `ui-store`：`newCanvasCount` / `noteCanvasWrite(n)` / `setMainTab('canvas')` 清零；`ws-store`：`notify:canvas-changed` 且 `by=agent` 且 `mainTab!=='canvas'` 时计数 |

广播 payload 增补：`{ sessionId, version, by, reason, actor?, touched: {added, updated, removed} }`——`ws-store` 透传给 `canvas-store.handleRemoteChange`，画布未加载（未打开过）时也计数（角标不依赖 doc）。

## 5. C · 消息侧入口（工具卡）

- `ToolCard` 补 TOOL_META：`canvas_read`（读取画布）/ `canvas_write`（画布写入）/ `media_generate`（生成图片）/ `media_video`（生成视频）——与既有 14 项同一视觉语言；
- 「在画布查看」按钮：`canvas_write` / `media_*` 且 `status==='ok'` 时在卡片行尾显示 → 点击切到画布 Tab（无会话时 toast 引导）；不展开折叠（stopPropagation）。

## 6. D · 输入侧引用（低摩擦）

- `CanvasComposer`：选中节点 >0 时浮现「引用选中 N」chip → 点击将选中节点逐行 `quoteForComposer` 插入草稿（复用既有引用文案管线），toast 确认；
- 与右键「引用到对话」（送 Composer）互补：此处送画布自身指令条——「看着画布说画布」。

## 7. 被否决与延后

| 项 | 决策 | 理由 |
| --- | --- | --- |
| 前端补放（打开画布时补偿未落位任务） | ✗ | 服务端落位是根因解；双端落位需幂等协议，复杂度不划算 |
| 节点作者徽标走各节点组件传参（8 组件） | ✗ | NodeShell 内查 store 零侵入且引用稳定（选择器返回字符串） |
| 闪环用节点 data 标记（`__flash`）驱动 | ✗ | 会引发受控重建（ADR 0093 纪律）；ViewportPortal 覆盖层完全不碰节点 |
| 实时进度百分比渲染进节点（每秒重渲染） | ✗ | 复用 media-store 现有节流广播（notify:media-job），节点仅订阅文案 |
| Agent 写入 toast 提示 | ✗ | 与交付件一致的克制纪律：角标 + 闪环 + 徽标三重静态反馈已足够；toast 留给终态 |
| 消息 → 画布精确节点定位 | 延后 | ToolCallRecord 无结构化画布字段；需工具事件管道扩展，另立批次 |
| 画布内「协作者光标」（agents 实时操作流） | 延后 | 需操作级流式广播（本批为写入级），收益未验证 |

## 8. 技术落位

```
shared/src/types.ts                     # pending / canvasNodeId / placedCanvas / placeOnCanvas / CanvasNode.by
server/src/canvas/store.ts              # applyOps(opts.by/reason) + 节点 by 注入 + publish meta（touched）
server/src/index.ts                     # publish payload 扩展 + MediaService 注入 canvasStore
server/src/media/service.ts             # 占位 / 结算（成功替换·失败保留·取消移除）/ 降级
server/src/tools/canvas.ts              # applyOps 传 by=ctx.agentId
server/src/tools/media.ts               # 移除 autoCanvasTarget（服务端接管）
client/src/stores/media-store.ts        # 移除前端落位；toast 按 placedCanvas 分流
client/src/stores/canvas-store.ts       # handleRemoteChange(meta) → remoteFlash
client/src/stores/ui-store.ts           # newCanvasCount / noteCanvasWrite / 切画布清零
client/src/stores/ws-store.ts           # canvas-changed 分支扩展（角标 + meta 透传）
client/src/components/layout/AppLayout.tsx        # 画布页签未读角标
client/src/components/canvas/CanvasView.tsx       # flowing 注入 + 闪环 ViewportPortal
client/src/components/canvas/nodes/NodeShell.tsx  # 作者徽标（内部查 store）
client/src/components/canvas/nodes/{Image,Video}Node.tsx  # pending 态
client/src/components/chat/ToolCard.tsx           # TOOL_META + 在画布查看
client/src/components/canvas/CanvasComposer.tsx   # 引用选中 chip
client/src/index.css                    # canvas-agent-flash keyframes（quiet-mode 同步）
```

## 9. 验收信号

| 目标 | 验收 |
| --- | --- |
| 落位可靠 | server 单测：占位创建（canvasTarget / autoPosition 错开）/ 成功原地替换 + 多产物排开 / 失败保留 / 取消移除 / 未装配 canvas 降级（placedCanvas=false） |
| 全周期可见 | E2E：pending 节点呼吸 + 进度文案；指向占位的 flow 边能量流动；client 单测：media-store 不再双写（toast 按 placedCanvas 分流） |
| 写入可感知 | server 单测：applyOps by 注入 + publish touched/actor；client 单测：handleNotify → 角标（非画布 Tab）与 remoteFlash（touched 过滤）；NodeShell 徽标渲染 |
| 消息侧 | client 单测：TOOL_META 四工具 + 「在画布查看」按钮行为 |
| 输入侧 | client 单测：引用选中 chip（插入引文 / 无选中隐藏） |
| 回归 | 既有 m31-canvas / m31-media / m31-tools / m35-frontend（handleNotify 先例）全绿；E2E m31-canvas-ux 回归 |
