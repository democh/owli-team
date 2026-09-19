# ADR 0049：计划派发、按成员待办与任务面板 2.0

- 状态：Accepted
- 引入：M24
- 相关：[design.md §41](../design.md)、ADR 48（回合范式与计划审批）、ADR 33（并行波次）、ADR 42（双通道事件）、ADR 25（前端性能架构）

## 背景

- 计划批准后需要「谁在什么时机动工」的确定性通道：派发不能只靠聊天里 @ 传播；步骤进度要实时可见；全步完成后要有收口人。
- §29 已知限制：`write_todos` 的待办是 Run 级单数组，波内并发（并行成员同时改写）会互相覆盖——派发执行要让每个成员看到自己的待办。
- 客户端需要：计划在批准前可读可改（改指派 / 调序 / 增删）；任务面板按「是否执行 plan」双形态展示；聊天内计划卡与面板共用同一数据源与结算入口。

## 决策

1. **派发**：波末 fan-in 时，被批准计划 → 执行队列 = 步骤负责人（按步骤序去重）**前置**并入 merge.queue；plan → `executing`；`RunRecord.planDispatch: Map<agentId, stepId[]>` 登记本波代执行步骤；execute 回合指令追加「你负责计划步骤：…」。
2. **步骤生命周期**：波启动把命中成员的 pending 步骤置 `in_progress`；`update_plan_step(step_id, status, note?)` 权限 = 步骤 owner 或计划作者（服务端校验，`blocked` 必带 note）；广播 `plan:updated`；全步 `done | skipped` → plan = `done`。
3. **收口**：plan = done 时追加作者收口波（仅一次；作者已在队列则跳过）；`synthesisAdded` 防重入。
4. **按成员待办**：`RunRecord.todosByAgent: Map<agentId, TaskItem[]>` 修复 §29 并发覆盖限制；RunRecord 另增 `mode` / `activePlanIds` / `pendingPlanIds` 等计划编排字段。
5. **评审落库与阻塞**：`submit_review(target, verdict, findings[], evidence?)`；target 支持 `plan:<id>` / `step:<id>` / `artifact:<path>` / `message:<id>`；`fail` 命中 step → 该步 `blocked`、命中 plan → plan `blocked`；广播 `review:submitted`（`reviews` 表持久化）。
6. **指派闭环**：`pendingHandoffs` 升级为携带 `{from, reason, expected_output}` 的条目化注入（接收方回合指令）；仅派发时注入计划步骤、仅有 `expected_output` 时追加「上一棒期望」行（既有回合指令文本不变，旧断言零差异）。
7. **客户端双通道与竞态守卫**：`plan-store` 按会话绑定（load 绑定守卫）；SSE `plan:*` / `review:*` 与 WS `notify:plan-*` 双通道归约；`applyPlan` 增加 **updatedAt 单调守卫**——迟到回包（resolve / PUT 响应体是旧版本快照）不得覆盖更新的 SSE 状态（驳回→v2 重提的真实竞态，窗口约 5–45ms）。
8. **聊天卡不依赖卸载清理**：`PlanReviewCard` 驳回结算成功后**主动**收起表单——rejected 与 v2 `submitted` 可能同批到达（React 合并渲染，组件不卸载），依赖「切紧凑态卸载」会把 v2 卡卡在确认驳回态（E2E 实测复现）。
9. **任务面板 2.0**：`TaskView` 双形态——有计划 → 计划板（状态徽章 / 进度条 / 作者 / 步骤行：状态 / 负责人 / 范式标 / 验收）；无计划 → 原任务清单；顶部「按计划 / 按成员」分组切换 + 「规划先行」会话开关；`PanelDef.badge`（待批准计划数）+ TeamPanel 成员卡计划徽章 + 指挥台队列 chips 步骤提示（title）。
10. **API 共用结算入口**：`GET .../plans`（列表 + reviews）、`PUT .../plans/:id`（编辑仅 submitted；负责人须在会话内；广播 `plan:updated`）、`POST .../plans/:id/resolve`（有挂起 → 结算；无挂起 approve → `launchPlanExecution`，reject 仅改状态）——聊天卡与任务面板共用。

## 理由

- 队列**前置**（而非替换）保留波内其它成员的既有调度语义，`scheduler.ts` 纯函数零改动（ADR 33 语义不动）；
- 步骤 owner 是唯一执行触发源：派发队列、回合指令、面板展示三处同一事实，职责无歧义；
- 批准前窗口完成就地编辑（调指派 / 调序 / 增删），避免执行中改计划引起的状态歧义；
- updatedAt 单调守卫是双信道系统的必要护栏：任何「请求回包 + 推送」并存的前端归约都应有等价的陈旧快照拒绝规则；
- 表单收起显式化：UI 状态清理不应依赖组件卸载这一脆弱的隐含假设（React 批渲染会打破它）。

## 被否决的方案

- **批准即队列重建（清空再排）**：波内其它待发言成员被吞，破坏零差异红线；
- **步骤进度由模型自由文本汇报（不落库）**：面板无法实时、mock / E2E 不可断言；
- **客户端依赖「驳回后切紧凑态卸载」清理表单**：同批渲染不卸载 → 表单永久卡住（复现于 E2E，修复为主动收起）；
- **resolve 回包全量信任（无守卫）**：迟到旧快照覆盖新状态，卡片永久停在已驳回（E2E 偶发根因）；
- **任务面板另建第三套 store**：复用 task-store 形态，plan-store 独立成 store、面板合成展示，避免 store 间同步；
- **面板编辑开放到 executing / blocked**：执行中改步骤会让「已派发步骤 id」失效（planDispatch 悬挂），编辑收敛在 submitted。

## 适用与失效条件

- 适用：mock 与真实模型均可驱动（mock 按回合元数据 `mode` 走确定性脚本：write_plan / submit_review / update_plan_step）；无 plans 会话在面板 / 事件 / 聊天卡上零差异。
- 失效条件：步骤数远超队列容量时应分波派发（当前一次并入，受 `PARALLEL_MAX` 与波数上限约束）；未来若引入「多人同时编辑同一计划」，需补并发编辑冲突策略（当前仅 submitted 期编辑 + 单用户操作面）。
