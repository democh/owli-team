# ADR 0048：回合范式（规划 / 执行 / 评审）与计划审批挂起

- 状态：Accepted
- 引入：M24
- 相关：[design.md §40](../design.md)、ADR 2（自主委派）、ADR 23（HITL 审批）、ADR 33（并行波次）、ADR 11（SSE + WS 双通道）

## 背景

- 自治接力链默认「边聊边干」：模型可直接调用写工具改动工作区，没有「先规划、经用户批准、再执行」的节拍；复杂多步骤任务在动工前缺少一次用户修正方向的机会。
- 需求：① 与角色正交的三类回合范式（规划 / 执行 / 评审），决定工具白名单、回合指令模板与产出契约；② 规划产出结构化计划并**挂起等待用户批准**（批准前零自动执行）；③ 驳回可带反馈、作者据此现场修订重提；④ 评审产出结构化判定（pass / conditional / fail）且 fail 可阻塞计划 / 步骤；⑤ **默认零差异**——不显式选择范式时全链路与现状完全一致。
- 硬约束：不改变调度器波次算法（ADR 33，`scheduler.ts` 纯函数不动）；queue / 审批事件形状不变（ADR 11，queue 仍为 `string[]`）；无 plans 的会话在工具、事件、面板、提示词上保持现状；34 个 `AGENT.md` 无需逐个修改。

## 决策

1. **三范式模型**：`TurnMode = 'plan' | 'execute' | 'review'`，与角色正交（同一角色在三种范式下走同一份人设，仅工具白名单 / 回合指令 / 产出契约不同）。
2. **触发优先级（显式 opt-in，默认不触发）**：① Composer 消息级范式选择（仅对**下一条消息**生效，发送后自动复位回「执行」）→ ② 会话「规划先行」`planFirst`（默认关闭的持续开关）→ ③ 派发步骤声明的 mode → ④ 默认 `execute`。用户消息持久化 mode（`messages.mode` / `ChatMessage.mode`），Run 级记录本波默认范式。
3. **误触发双保险**：`write_plan` 仅存在于 plan 范式工具白名单（execute 模式模型看不到该工具，普通对话无法顺手提交计划）；即使提交，Run 也立即进入 `awaiting_plan` 挂起，批准前无任何自动执行。
4. **范式工具门控**：`ToolRegistry.forAgent(agent, mode?)` 取范式白名单与角色工具集的交集；plan / review = 只读工具 ∪ `{write_plan | submit_review, handoff, remember, request_approval, load_skill, calc, date_calc, csv_analyze, web_search, web_fetch, list_dir, read_file, glob, grep, search_text, git_status / git_diff / git_log}`——**不含任何写工具**，审批门自然不再触发；execute = 现状（零差异）。
5. **计划挂起协议镜像审批**：`PlanReviewService`（`create / wait(signal 取消) / resolve(approve | reject + feedback) / pendingOf / persist`）与 `approval.ts` 同构；`RunSnapshot.state` 新增 `awaiting_plan`；`PLAN_REVIEW_TIMEOUT_MS` 默认 0 = 无限等待（可配，超时按驳回收敛）。
6. **驳回修订（同 id version+1）**：驳回（可带反馈）经工具结果回灌作者，作者在同一回合内可 `write_plan` 修订重提——同一 plan id、`version+1`、状态回 `submitted` 重新挂起（v2 卡）；executing 中再次提交 = 重规划（旧版 supersede，新版重新挂起）。
7. **停止与稍后批准**：`awaiting_plan` 时 stop → 计划挂起取消（计划保持 `submitted` 供稍后处理）；无挂起时批准 → `launchPlanExecution(sessionId, planId)` 新起执行 Run（队列 = 步骤负责人）。
8. **并行波多计划**：各自独立挂起；批准其一 → 其余自动 superseded（等待方以「已被取代」收敛）。
9. **协议违规不静默**：plan 波未提交计划 → trace 事件 + system 事件条提示，按既有规则收束交还。
10. **事件 / 持久化 / API**：`RunEvent` 增 `plan:submitted` / `plan:updated` / `review:submitted`，`turn:start` 与 `wave:start` 增 `mode`；`NotifyType` 增 `notify:plan-submitted` / `notify:plan-updated`；迁移 v5（`plans` / `reviews` 表 + `sessions.plan_first` + `messages.mode`）；API 三端点（`GET .../plans`、`PUT` 编辑仅 submitted、`POST .../resolve`）与会话 `planFirst` 开关（见 api.md §3.1）。

## 理由

- 范式与角色正交：34 个角色零改动即获得三范式能力（白名单交集自动生效），避免「每个角色写三份人设」的资产爆炸；
- 挂起式审批复用已验证的 HITL 语义（ADR 23）：用户决策即恢复点，重附着 / 停止 / 恢复 / WS 通知全部沿用，无第二种 Run 生命周期；
- 驳回 + 现场修订保持计划谱系单线（同 id 增版本），聊天卡 / 面板 / 评审 / 派发全部按 id 聚合，无需跟踪多实例合并；
- 只读白名单使 plan / review 波在结构上不可能触发工具审批，规避「审批 × 计划」双挂起交叠的状态爆炸；
- 零差异红线使存量主链路与 eval 基线在默认路径上不动（回归面可控）。

## 被否决的方案

- **默认即规划（强制先出计划）**：破坏「边聊边干」主体验，误触发面大；opt-in + 双保险（工具不可见 + 挂起）更安全；
- **计划审批新起 Run**：同 Run 挂起与审批同构、语义全复用，新 Run 会引入第二套「挂起中 Run」的停止 / 重附着 / 快照逻辑；
- **驳回生成新 plan id（v2 新记录）**：谱系断裂——面板、评审、派发、聊天卡都要按 id 聚合，改为同 id version+1；
- **并入 ApprovalRequest**：审批是「工具级一次性确认」，计划是「可编辑、可修订、可 supersede 的领域对象」，并入后编辑 / 修订 / 版本语义无处安放；
- **review 范式放开写工具**：评审必须只读（改动应回到 plan / execute 波并走审批），否则「评审中顺手改」破坏可回溯性；
- **给没选范式的会话也注入 plan 段提示词**：违反零差异红线，且诱导模型在普通对话里规划。

## 适用与失效条件

- 适用：单会话内人机同席的计划流转；并行场景 ≤ 现有 `PARALLEL_MAX`；新增工具默认**不进** plan / review 白名单，须显式列入（白名单是 opt-in 的）。
- 失效条件：需要「多方案并行对比后择一执行」（当前单计划谱系 + supersede 只支持线性演进）；多用户分布式审批（挂起模型是单用户决策）；范式与角色强耦合的场景（如专职评审角色常驻 review）出现时，可能需要角色级默认范式补丁。
