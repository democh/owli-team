# ADR 0146：Agent 与画布联动深化——任务全周期绑定 + 写入可感知（M31 修订）

- 状态：Accepted
- 引入：画布联动批（2026-09-19）
- 相关：[docs/canvas-agent-linkage-design.md](../canvas-agent-linkage-design.md)（详细设计 · 四缺口盘点 · 被否决项）、[design.md §49.6](../design.md)、ADR 0059（画布内核与媒体工作台）、ADR 0138（画布 UX 修订）、ADR 0124（媒体连接全局化）、[server/src/media/service.ts](../../server/src/media/service.ts)、[client/src/stores/canvas-store.ts](../../client/src/stores/canvas-store.ts)

## 背景

画布 UX 修订（ADR 0138）之后，Agent ↔ 画布的「通道」齐全但「联动质量」有四个确证缺口：

- **媒体产物落位不可靠**：`media_generate / media_video` 工具描述承诺「完成后产物自动落到画布」，实际落位完全依赖前端 `media-store.placeOutputs`——前提是「该会话画布已加载（doc 非空）」；用户在别的 Tab / 从未打开画布时**静默放弃且无补偿**（产物只落交付件，用户后来打开画布看不到，agent 却以为已放好）；
- **生成中画布零表达**：提交后画布上无任何反馈，等完成才「啪」地出现节点；`canvas-breath`（骨架呼吸）与 `FlowEdge.flowing`（能量流动）均为 P3 遗留注释明示的未接线能力；
- **Agent 写入无感知**：`notify:canvas-changed` 广播只有 `{version, by}`——无 touched ids、无 actor，前端只能整体静默拉取：**没有角标**（用户错过写入）、**没有高亮**（不知道改了哪）、**没有作者**（不知道谁放的）；
- **消息侧断链**：`canvas_read / canvas_write / media_*` 四工具在 ToolCard 无 TOOL_META（显示原始英文名 + JSON），也无「在画布查看」入口。

## 决策

1. **服务端为真相（落位下沉）**：`MediaService` 注入 `canvas?: CanvasStore`（结构依赖，未装配静默降级）——
   - `create` 即落**占位节点**（add_node：`data.pending=true / jobId / prompt / params / 首尾帧`；位置 = `canvasTarget ?? autoPosition`——取消工具侧 `autoCanvasTarget` 预计算，并发任务由 autoPosition 天然错开）；`job.canvasNodeId / placedCanvas` 记录映射；
   - `finalize` 结算（仅状态首次转终态执行）：成功 → update_node 原地替换（artifact / pending:false）+ 多余产物 add_node 横向排开；失败 → update_node 保留（error + pending:false，节点可重试）；取消 → remove_node（干净移除）；
   - 广播顺序：canvas 变更先于 media-job（前端先合流节点再收 toast）；前端 `media-store.placeOutputs / placedJobs` 删除（防双写），toast 按 `job.placedCanvas` 分流。
2. **契约扩展（全部可选、向后兼容）**：`CanvasImageData / CanvasVideoData.pending?`、`MediaJob.canvasNodeId? / placedCanvas?`、`MediaJobInput.placeOnCanvas?`、`CanvasNode.by?`（写入者 agent id）。
3. **写入可感知三问**：
   - **谁写的**：`applyOps(opts.by)` 为 add_node 注入节点 by（update 保留原作者）；`NodeShell` 内部从 canvas-store 查 by → 左下角 14px AgentAvatar 徽标（title「由 X 写入」；零侵入各节点组件，选择器返回字符串引用稳定）；
   - **写了什么**：广播 meta 增 `touched {added, updated, removed}` 与 `actor`、`reason('ops'|'media'|'save')`；`canvas-store.handleRemoteChange(meta)` 合流后按 touched 过滤仍存在的节点 → `remoteFlash`；CanvasView 经 **ViewportPortal 覆盖层**渲染一次性闪环（1.8s 描边脉冲；不碰节点 data，遵守 ADR 0093 受控重建纪律）；
   - **在哪看**：`ui-store.newCanvasCount` + ws-store 在「by=agent 且同会话且非画布页」时按 touched 数累计 → AppLayout「画布」页签角标（与交付件 `newArtifactCount` 同模式）；进画布即清零。
4. **消息侧入口**：ToolCard 补四工具 TOOL_META（读取画布 / 画布写入 / 生成图片 / 生成视频）；完成态的写入类工具行尾挂「在画布查看」（切画布 Tab；无会话引导——**跳转按钮独立于折叠按钮，修复嵌套 button 的 ARIA 名称污染**）。
5. **输入侧引用**：CanvasComposer 在画布有选中节点时浮现「引用选中 N」chip → 逐行 `quoteForComposer` 插入草稿（与右键「引用到对话」同一文案管线，「看着画布说画布」）。

## 理由

- **可靠落位**是工具语义的兑现：agent 的承诺（自动落画布）不能以「用户恰好开着那个画布」为隐含前提；服务端落位同时天然获得「打开画布时内容已在」的最终一致性；
- **创建即占位**把「异步长任务」变成画布上的可见对象：呼吸 + 实时进度（复用 notify:media-job 节流广播）→ 完成原地替换；这不是装饰，而是把任务状态映射到空间位置上（用户在画布上直接看到「这里正在生成」）；
- **touched 精确高亮**优于「整画布闪烁」：基于广播携带的 id 集合做覆盖层闪环，零节点数据侵入、零受控重建风险；
- 角标 / 徽标 / 闪环构成**克制三重奏**：无 toast 打扰（toast 留给终态），与交付件（角标）的执行风格一致。

## 被否决的方案

- **前端补放**（打开画布时扫描未落位任务补偿）：把根因留在前端，且需双端幂等协议；服务端落位是根因解；
- **节点作者徽标经各节点组件传参**（8 个组件改造）：NodeShell 内查 store 零侵入且稳定；
- **闪环用节点 data（`__flash`）驱动**：会引发受控重建（ADR 0093 纪律）；
- **进度百分比由节点内轮询渲染**：复用 media-job 节流广播，节点仅订阅字符串；
- **Agent 写入 toast**：与交付件一致的克制纪律，角标 + 闪环 + 徽标已足够；toast 留给终态；
- **消息 → 画布精确节点定位**：ToolCallRecord 无结构化画布字段，需工具事件管道扩展——延后（本批「在画布查看」先给通道）；
- **「协作者光标」（agents 操作级实时流）**：写入级广播已可用，操作级流式（拖拽/选中跟随）收益未验证——延后。

## 影响

- 服务端：`canvas/store.ts`（`applyOps(opts.by/reason)` + by 注入 + touched 追踪 + publish meta；`save` 补 reason:'save' 空 meta）、`media/service.ts`（canvas 依赖 / 占位 / 结算 / 降级）、`tools/canvas.ts`（applyOps 传 `ctx.agentId`）、`tools/media.ts`（移除 autoCanvasTarget，`place_on_canvas` → `placeOnCanvas` 透传）、`index.ts`（publish payload 展开 meta + 装配注入）；
- 前端：`media-store`（删 placeOutputs/placedJobs，toast 按 placedCanvas）、`canvas-store`（remoteFlash / clearRemoteFlash / handleRemoteChange(meta)）、`ui-store`（newCanvasCount 族）、`ws-store`（canvas-changed 分支：meta 解析 + 角标）、`AppLayout`（页签角标）、`CanvasView`（闪环 ViewportPortal + flowing 注入——**接线 P3 能量流动**）、`ImageNode / VideoNode`（pending 呼吸 + 实时进度）、`NodeShell`（作者徽标）、`ToolCard`（TOOL_META + 在画布查看 + 结构去嵌套）、`CanvasComposer`（引用选中 chip）、`index.css`（canvas-agent-flash keyframes + quiet-mode/reduced-motion 同步）；
- 测试：server `m31-media`（+7 落位全周期）/ `m31-canvas-store`（+3 by/touched/meta）/ `m31-tools`（落位口径更新 + 降级）；client `m31-canvas-agent.test.tsx`（+7：角标 / handleNotify / remoteFlash / ToolCard）、`m31-media`（完成提示改口径）、`m36-frontend`（+2 引用选中）；E2E `m31-canvas-agent.spec.ts`（2：落位+闪环+角标 / 徽标+pending+能量边）；
- 文档：本 ADR、`docs/canvas-agent-linkage-design.md`、design.md §49.6 修订注记、`docs/adr/README.md` 索引。

## 适用与失效条件

- 适用：全部会话的画布视图与媒体工具链路；`place_on_canvas=false` 与「媒体服务未装配画布」为显式降级路径（placedCanvas falsy → toast 走交付件文案）；
- 失效条件：若引入「正式产物审批」（生成后需用户确认才落画布），占位→替换流程需改为「占位→候选→确认落位」；若媒体服务将来在其他进程（服务端无 canvas 句柄），落位需走事件回环；
- 已知边界：占位节点为 image/video 类型 + `data.pending` 标记（前端渲染分支），非独立节点类型；闪环为一次性视觉反馈（1.8s），错过不补；角标按 touched 计数（去重不考究，语义为「新写入热度」而非精确条目数）。
