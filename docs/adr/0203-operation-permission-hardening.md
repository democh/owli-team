# ADR 0203：操作权限收口——viewer 写闸门补全与审批定向口径统一（M79-AF）

- 状态：Accepted
- 引入：M79-AF（2026-09-20）
- 相关：[server/src/routes/browser.ts](../../server/src/routes/browser.ts)、[server/src/routes/schedules.ts](../../server/src/routes/schedules.ts)、[server/src/routes/media.ts](../../server/src/routes/media.ts)、[server/src/routes/runs.ts](../../server/src/routes/runs.ts)、[server/src/orchestration/engine.ts](../../server/src/orchestration/engine.ts)、[client/src/stores/ws-store.ts](../../client/src/stores/ws-store.ts)、[server/tests/m79-af-permissions.test.ts](../../server/tests/m79-af-permissions.test.ts)

## 背景

M79-AD 将审批 WS 帧定向给触发者（「批准只推送给对话的人」），但只做了通知面。全量审计（多用户 × 多 Agent 同会话：同步展示 / 消息发送 / 调度 / 推送 / 操作）发现三类不一致：

1. **viewer 越权（3 处）**：资源级端点不以 `/sessions/:id` 为前缀，绕过了 `createSessionAccessGuard`，自建检查误用**读**校验（`canAccessSession`）——
   - `browser`：takeover / stream-token(takeover) / release / close → viewer 可人工接管浏览器、发键盘鼠标输入、关闭会话；
   - `schedules`：`/schedules/:id` 的 PATCH/DELETE/run/pause/resume → viewer 可改删触发定时任务（可间接发起 Run）；
   - `media`：`/media/jobs/:id` 的 cancel/retry → viewer 可取消/重试媒体任务；
   - 另有既有缺陷：media `guardJob` 返回结构体却被 `!guardJob(req)` 取反（对象恒真）→ **守卫整体从未生效**（含跨用户读取）。
2. **审批口径分裂**：推送定向触发者，但决定端点（`POST /runs/:runId/approvals/:id`）与读面（`GET .../approvals` + SSE attach 补发）仍是「任何 editor 可见可批」——其他成员切会话 attach 活跃 Run 即见审批卡。
3. **交还提示泛广播**：`notify:awaiting-user` 会话主题广播，非持球方也收到「等待你的指示」。

## 决策

1. **操作面子资源统一「写闸门」**（与 `/sessions` 写闸门口径逐字一致）：
   - browser：新增 `canOperateBsid`（活跃会话 = `canWriteSession`；可读不可写 → 403「只读共享（viewer）：无操作权限」；不可读 → 404 不泄漏）——takeover / stream-token(takeover) / release / close 四处使用；watch token / steps / screenshots 保持读校验；
   - schedules：`guardTask` 追加 `canWriteSession`（该守卫全部使用方均为写操作）→ viewer 403；
   - media：`guardJob(req, forWrite)`（cancel / retry 传 true）→ viewer 403；GET 保持读校验；同时修正恒假判定缺陷；
   - **扫尾补漏（穷举核对的追加面）**：`library` to-canvas（入仓 = 向会话工作区拷贝文件的写操作）→ 路由层写校验（viewer 403 / 不可读 404）；`feedback` 单条查询（GET `?messageId=`）→ 会话归属（非成员视同未反馈 `item:null`，不泄漏存在性）。核实无缺口：finance watchlist（按 userId 归属）、memories 状态变更（ownedByUser）、context / memory 端点（`/sessions/:id` 前缀受守卫）、feedback 全量 / 导出（admin）。
2. **审批四面对齐「触发者 ∪ 会话属主」**（admin 对无权会话由守卫 404 前置拦截，M79-G 隐私语义无旁路）：
   - 操作：`POST /runs/:runId/approvals/:id` 非触发者且非属主 → 403（触发者缺失的兼容模式 / 历史直调放行，零差异）；
   - 读面：`GET /runs/:runId/approvals` 非触发者/非属主返回空列表；
   - SSE：`engine.attach` 记录订阅者 userId；`approval:requested/resolved` 的实时广播与待决补发按同口径逐订阅者过滤（未记录身份 = 放行，兼容零差异）；
   - WS：维持 M79-AD `publishApprovalFrame` 定向。
3. **交还提示定向**：`notify:awaiting-user` 客户端按 `payload.targets ∪ 会话属主` gating（**帧保持会话广播**——元数据级无敏感内容，gating 在展示层，改动最小）；无 targets（泛指 @用户）保持原广播语义。
4. **前端展示层 gating 双保险**（服务端为准）：ApprovalPanel（viewer 不渲染决策按钮与快捷键）、RelayQueue 调序、BrowserPanel/DockBrowserView（接管/归还/关闭/画面输入，`useBrowserFrameInput(enabled)`）、SchedulePanel（新建/触发/启停/删除）、GenerationPanel（提交/取消/再生成）、**MessageActions 消息操作菜单**（编辑=作者本人、删除=作者/属主（agent/system 不受限）、重新生成/续写/fork=非 viewer；兼容模式 role/userId 缺省全放行）、**M79-AH 画布只读模式**（store 闸门：mutate/applyLocal/undo/redo 拦截 + save 防御；视口浏览允许且不落盘；ReactFlow 拖拽/连接/删除键/右键/双击/拖放禁用；工具栏写类按钮禁用 + 只读浮条）、**PlanReviewCard 计划卡**（批准/驳回/保存修改禁用；草稿仅本地 + 提示）。

## 被否决的方案

- **恢复审批会话广播（任何 editor 可批）**：与 M79-AD 用户诉求（「批准只推送给对话的人」）相悖；触发者离线由属主兜底已覆盖可用性；
- **按角色细分「运行操作」权限（停止 / 重排限触发者）**：群聊协作需要 editor 急停与调序；维持 `canWriteSession`，仅审批收口；
- **平台自动召集（route / handoff 增援）纳入编制权限校验**：调度属平台职责（M48 设计），「编制管理」指人类入口（成员 API / 弹窗）；平台召集经 trace 可审计，豁免对齐既有 ADR 0101 精神；
- **`notify:awaiting-user` 改服务端定向**：需新增用户主题信封与文案源（会话标题随行），收益同 gating 而改动面更大；帧无敏感内容，展示层 gating 足够。

## 边界与后续

- admin 对**无归属历史行**仍可兜底（`ownsOrAdmin`），对成员私有会话一律 404（m79-privacy 固化）；
- 定时任务/媒体任务的**归属语义为「任务 → 所属会话 → 会话成员」共管**（写 = `canWriteSession`）。**「发起人私有」收紧经评估否决（2026-09-21）**：任务属会话级资产（定时注入 / 生成消耗均在会话维度），创建者∪属主收紧会导致发起人离场（休假 / 移出）后任务失管、owner 无法运维；维持共管更稳。若未来确需创建者维度（如审计追溯），以「记录 createdBy + 展示归属」而非权限收紧实现；
- **降级轮询增量游标（已实施）**：`GET /api/notifications` 增可选 `cursors`（URL 编码 JSON `{sessionId: seq}`；客户端 `pollUrlOf` 携带 per-session 游标只拉增量，序列化超长/非法/缺省回退全量）——`NotifyHub.list` 的过滤下界 = `cursors[sid] ?? since`（各会话 seq 独立计数器，单值 since 无法跨会话表达）；语义与 WS 重连补发一致（游标过新 = 无补发，数据面由 M79-AB REST 补偿兜底）；
- 已知边界（不在本批）：跨实例 SSE 订阅者身份按连接实例记录（跨实例漂移重连由 REST 快照补齐）；跨实例 seq 游标不可比（ADR 0199 既定）。
