# ADR 0133：多 Agent 调度增强——路由简报 · 停滞抑制 · 写冲突防护 · 接单回执 · 调度指标（M61）

- 状态：Accepted
- 引入：M61
- 相关：[design.md §84](../design.md)、ADR 0101（调度平台化 / PRS——本批在其上叠加输入简报与降级升级）、ADR 0118（PK 四按钮裁决回填——mode 软建议沿用「只写草稿不直发」精神）、ADR 0094（裁决只在合并层——停滞判定同样在 mergeWaveSchedule 单一收口）、[server/src/orchestration/platform-router.ts](../../server/src/orchestration/platform-router.ts)、[server/src/orchestration/scheduler.ts](../../server/src/orchestration/scheduler.ts)、[server/src/orchestration/write-tracking.ts](../../server/src/orchestration/write-tracking.ts)、[server/src/orchestration/engine.ts](../../server/src/orchestration/engine.ts)、[server/src/store/run-events.ts](../../server/src/store/run-events.ts)

## 背景

- 专家级路线盘点确认多 Agent 调度七处短板（D1–D7）：① 路由输入薄（仅最近 4 条 ×160 字符，无阶段 / 交付件 / 去重信息）；② 平铺派发无阶段纪律；③ 循环检测无「实质进展」语义（纯文本重复 4 波才收尾，空谈无产出可更早识别）；④ 交接无闭环证据（发出有便条、接收无回执）；⑤ 并行写冲突只有协议约定（development `_protocol.md` 第 2 条），引擎零观测；⑥ 调度无聚合指标（trace 逐条有、全局健康不可见）；⑦ 路由失败降级只到「编制首位」（未利用场景 chain 的上下游语义）；
- 约束：全部改动不得改变既有行为（默认零差异）、不得引入新的审批 / 权限路径、编号顺延（v58 / ADR 0132 被并发批占用）。

## 决策

1. **D1 路由输入简报（零差异注入）**：PRS 输入新增 `<session_state>` 段（阶段 opening/ongoing + 最近接手者 + 已有交付件清单 ≤30 条 / 600 字符）；**空段不注入**——既有输入字节级不变（未渲染任何字段时 parts 数组与旧版一致）。输出 schema 增 `assignments[].mode`（execute/plan/review）——**软建议**：仅注入任务便条（「平台建议：先 write_plan…」）与 trace，不强制切换范式（范式权限仍由工具白名单 / 用户开关决定，与「显式 opt-in」原则一致）。ROUTE_SYSTEM 增复杂度分级 / 去重 / 阶段三纪律。
2. **D2 阶段化派发（提示词级）**：跨阶段需求只派第一阶段（接手方自行转交），避免一次派全链；不引入引擎级阶段状态机（YAGNI——PRS 单次调用的成本远低于维护多阶段调度态）。
3. **D3 实质进展停滞抑制（同签名两波）**：`detectStall(waveTexts, waveWriteCounts, waveSignatures)`——**同一成员**（波签名相同）连续两波「零成功写动作」且文本相似 >0.9 → 提前抑制交还。**职责划分**：单人重述（强停滞信号）由本检测 2 波收口；多人轮转重复仍交内容级循环（0.85 / 4 波）——两机制不重叠（M3 内容循环测试零变化）。有写动作即视为有实质进展（不误伤迭代型协作）。写动作来源为 `write-tracking`（write_file / edit_file / apply_patch 成功调用；apply_patch 从 `---/+++` 补丁头解析路径）——**零文件系统 IO**（不扫描工作区）。
4. **D4 接单回执（纯观测）**：接收方消费交接便条即记 `handoff:accepted` trace（from / count / reason）——交接链闭环审计，不改任何调度行为。
5. **D5 并行写冲突防护（波末系统事件条）**：波末对波内成员写路径集合两两求交 → 重叠时 `wave:write-conflict` trace + 系统事件条（落库 role:system、不进 LLM 窗口、复用 plan-updated 推送通道即时插入）；单成员波 / 无重叠零开销；跟踪失败静默（绝不阻断主流程）。
6. **D6 调度指标（从既有 trace 聚合）**：`RunEventStore.schedulingStats()` 从 run_events 聚合（routing:dispatched 的 fallback 分叉、wave:start 的 parallel、schedule 的 loopSuppressed / stallSuppressed、wave:write-conflict、handoff:accepted）——**零新埋点**（全部消费既有事件）；`GET /api/metrics/scheduling` + 指标面板「调度健康」分区（summary 同窗并行拉取，失败静默降级）。
7. **D7 链路降级升级**：路由失败接手从「编制首位」改为「场景链首」在场成员（按所属场景 chain 位置排序；未在 chain 上者靠后）——上游角色优先接手，与 M48 既有降级 trace 形状不变（`fallback: true`）。
8. **停滞抑制与循环抑制同走抑制路径**：`mergeWaveSchedule` 输出 `stallSuppressed` 与 `loopSuppressed` 并列（turn:end 的 loopSuppressed 标记合并二者用于「抑制收尾」展示，TraceDrawer 分开标注「停滞抑制」）；判定在 mergeWaveSchedule 单一收口（ADR 0094 分层：裁决只在合并层）。

## 理由

- **零差异注入**：所有输入增强走「空段不注入」，旧调用（测试替身 / 直连）字节级不变——既有 1088+ 测试零预期外变化；
- **零文件系统 IO 的写跟踪**：从工具调用参数提取路径比波前后工作区快照更精确（知道「谁写了什么」而不只是「变了什么」）且无 IO 成本；D3 与 D5 共享同一设施；
- **同签名两波**：同一成员重复自己上一轮的话是强停滞信号（多人轮转的重述可能是正常接力探讨）——精确化避免打断正常圆桌讨论；
- **软建议而非强制**：mode 不改变引擎机制（范式仍显式 opt-in），保持「默认零差异」与用户控制权；
- **指标零新埋点**：调度事件在 M9/M48 已全量落库——聚合只做读取，服务端零写入放大；
- **编号顺延**：v58 / ADR 0132 由并发批（头像圆角）占用 → 本批 v59 / ADR 0133（让位协议）。

## 被否决的方案

- **引擎级多阶段调度状态机（D2 重型版）**：违背「简单需求不给复杂机制」；提示词级纪律 + 降级 chain 已覆盖主要收益；
- **波前后工作区快照 diff（D3 原始设想）**：文件系统 IO 成本高且无法区分「谁写的」；工具调用参数跟踪更准更省；
- **stall 直接并入 loopSuppressed（无独立标记）**：审计需要区分「循环」与「停滞」两类抑制原因（指标与 TraceDrawer 均分开呈现）；
- **自动切换范式（mode 强制）**：改变既有行为边界，违背显式 opt-in；软建议（便条提示）保留用户与成员自主权；
- **写冲突阻断 / 排队**：并行波写同一文件可能是合法的分工（不同章节），引擎不应阻断——只提醒收敛方核对合并。
