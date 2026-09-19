# ADR 0060：会话级定时任务与到点协作（Session-Scheduled Tasks）

- 状态：Accepted
- 引入：M35
- 相关：[design.md §50](../design.md)、ADR 2（自主委派：handoff 工具优先）、ADR 11（SSE + WS 双通道）、ADR 18（SQLite + 迁移 + FTS）、ADR 20（会话级互斥 + 插话）、ADR 23（HITL 审批）、ADR 28（agents/ 包化与场景分组）、ADR 31（场景协议分层与技能包绑定）、ADR 38（业务工具集：零新增依赖）、ADR 49（计划派发与任务面板 2.0）、ADR 54（工具按需发现：渐进披露）、ADR 59（无限画布与媒体创作工作台：deferred + 白名单先例）

## 背景

- 协作目前完全由用户驱动：所有推进都发生在消息流中；「每天早上巡检一次」「下周三提醒我续费」「到点让某位成员开工」类时间驱动需求只能靠用户手动触发。
- 用户诉求：**增加定时任务相关的管理和 tool，让需要的 agent 添加相关功能，可以放进 tool_search 中** —— 即：① 管理面（用户可见可控的任务面板）；② 工具面（agent 可创建 / 查看 / 管理任务）；③ 按需授权（时间敏感角色持有，经渐进披露激活）。
- 硬约束：
  1. **零新增核心依赖**：不引入 cron 解析库（cron-parser / croner / node-cron），cron 解析 / 触发计算以内核纯函数自研，服务端与前端同源共用；
  2. **正确性**：时区（IANA / DST）语义正确——春季空洞顺延、秋季二义取较早；「工作日 09:00」类规则按墙钟直觉语义执行；
  3. **失控护栏**：会话忙时不得排队引爆、失败不得无限重试烧 token、最小触发间隔 5 分钟（防高频轮询）；
  4. **透明可审计**：agent 创建的任务对用户全程可见（面板 / 徽章 / 通知），可暂停 / 恢复 / 删除；触发与跳过都留痕；
  5. **能力不扩散**：定时工具只进 8 个时间敏感角色白名单（其余 60 角色不可发现），渐进披露（ADR 54）激活。

## 决策

1. **触发中心：会话级**——任务绑定单个会话（含创建者 / 目标成员 / 指令），`schedule_task` 只能建本会话任务、`manage_schedule` 只能管本会话任务（跨会话一律拒绝）；权限与上下文（注入消息落到哪）自然收敛。
2. **内核自研**（`shared/src/schedule.ts`，纯函数零依赖）——5 段 cron 解析（`*` / `n` / `a-b` / `a,b,c` / `*/n` / `a-b/n`；日与周同时受限取并集；周日 0/7）；`nextScheduleAt` 在墙钟域按天步进（上限约 4 年覆盖闰日模式），结果经两次偏移修正落回 UTC；时区经 `Intl.DateTimeFormat` 换算（不引入 tz 数据库）；`validateScheduleSpec` / `describeScheduleSpec` / `formatWallTime` 与解析同源。
3. **双动作语义**——`run`：到点注入 `@target instruction` 用户消息（带 `scheduleId`）→ `engine.launch` 启动协作运行；`remind`：落 role=system 事件条（不进上下文）+ `notify:schedule-reminder`（**零 token**）。高频场景是提醒（截止 / 账单 / 例会），显式二分使「提醒」不烧钱、「开工」走完整协作管道。
4. **忙时 skip 语义（不排队引爆）**——自动触发遇会话正忙按 `skipped-busy` 跳过并留痕（面板可见「上次跳过原因」）；手动触发（run_now）报错返回（用户在场，明确反馈优于静默）。排队等待会在用户不在场时形成连环引爆，不可控。
5. **补跑窗口**——服务启动时立即补一轮 tick：停机期间的错过触发在 `SCHEDULE_CATCHUP_MS`（默认 10 分钟）窗口内正常补跑，超窗按 `skipped-missed` 跳过留痕（避免重启后长时间离线任务的连环引爆）。
6. **失败护栏**——连续失败达 `SCHEDULE_FAIL_LIMIT`（默认 3）次自动暂停（`paused` 通知携带原因）；run 注入消息后启动失败时回收孤立消息（保持会话干净）；一次性任务触发后终结（nextRunAt=null），cron 持续推进。
7. **deferred 三件套 + tool_search 激活**——`schedule_task`（创建）/ `list_schedules`（只读）/ `manage_schedule`（pause / resume / remove / run_now），全部 `tier='deferred'`（对齐 ADR 54 / 59）；8 个时间敏感角色白名单：assistant / ops / sre / compliance / content / success / scout / life-admin；引导三处齐备（角色正文 / 全局协议 `<tool_policy>` / 场景协议 sre·finance·research）。
8. **透明双通道**——`notify:schedule-changed`（created / updated / deleted / fired / reminded / skipped-busy / skipped-missed / paused / error；payload 携带 task + message + runId）与 `notify:schedule-reminder`（task + messageId + message 实体）；前端右栏「定时」面板（TeamPanel 页签 + 命令面板入口）+ 注入消息「定时」徽章；用户可在面板直接建 / 管任务（人与 agent 同权，同一归约管道）。
9. **循环依赖解法**——ScheduleService 的 `launch` / `isBusy` 依赖以函数闭包注入（构造期不解析 engine），`engine.setScheduleService()` 在两侧就绪后回填；Engine ↔ ScheduleService 无构造环。
10. **持久化：迁移 v11 `scheduled_tasks` 表**——`nextRunAt` 在创建 / 触发时预计算（tick 只做 due 查询，不实时算 cron）；触发留痕字段（lastStatus / lastRunAt / lastRunId / lastError / runCount / failStreak）全量落库；启动修复缺 next 的循环任务（异常数据不静默永不触发）。

## 理由

- **自研内核 vs cron 库**：对齐「零新增核心依赖」纪律（ADR 38 先例）；5 段 cron + DST 两条修正规则实现完整可测（29 断言），且「解析 / 校验 / 描述 / 触发」四处同源——第三方库无法同时服务 server 与 client 的展示需求。
- **墙钟域按天步进**：`0 9 * * 1-5`（工作日 09:00）与「每月 1 号」的直觉语义都是墙钟语义；直接 UTC 迭代会在 DST 切换周产生一小时漂移。按天步进 + 两次偏移修正是正确性与实现复杂度的折中。
- **run / remind 二分**：提醒（截止日、账单、例会）占定时需求的绝对多数，让它跑一圈 Agent 是产品错配；二分让用户与 agent 的选择成本最低（工具描述内置引导）。
- **skip 而非 queue**：会话互斥（ADR 20）约束下单会话同时只有一个运行；排队引爆与「跳过留痕 + 面板可见 + 手动 run_now 补偿」相比，后者把控制权留给用户。
- **8 角色白名单而非全角色**：时间驱动是流程性能力（日程 / 巡检 / 节点提醒），全角色铺开会造成工具面噪声与职责稀释。与 v13「handoff 全角色接通」的方向相反但纪律一致：**先定可发现范围**——那次修的是「存在但不可达」，这次定的是「可达但按需」。
- **迁移 v11 表而非 JSON 文件**：tick 需要跨会话全局 due 查询与高频留痕更新，关系型存储天然适配（对齐 ADR 18 持久化路线）；单文档 JSON 适合低频整体读写的用户数据（画布先例），不适合调度器工作负载。
- **预计算 nextRunAt**：tick 每 30s 一次，实时全表算 cron 会随任务量线性变贵；预计算使 tick = 一次索引查询，成本与任务数解耦。

## 被否决的方案

- **引入 cron-parser / croner / node-cron**：多一个核心依赖换取约 200 行可完全自测的代码不划算；且双端（server + client）共用同一份「解析 / 校验 / 中文描述」的诉求第三方库难以满足。
- **全局任务中心（跨会话调度）**：权限模型（任务归属哪个会话）与上下文注入（消息落哪个会话 / 哪位成员）立即复杂化；本期以会话级收敛，跨会话编排留给用户经多会话手动组织。
- **全角色工具白名单**：工具面噪声 + 职责稀释（与 M31 画布的「场景无关创作能力」不同，定时是流程型能力，有明确的角色归属面）。
- **忙时排队等待（入队稍后跑）**：用户不在场时的连环引爆不可控；改为跳过留痕 + 面板「立即执行」手动补偿。
- **系统级桌面通知（Notification API）作为主通道**：浏览器权限与平台差异不可控；会话内 toast + 系统事件条 + 右栏面板为第一公民（复用既有 systemNotify 通道作增强）。
- **在 tick 中实时计算 next**：tick 频率 × 任务数的全表 cron 计算成本不可控；改为创建 / 触发时预计算 + 索引查询。
- **秒级 / 分钟级高频调度**：最小间隔护栏 `SCHEDULE_MIN_GAP_MS`（默认 5 分钟，硬下限 1 分钟）——高频轮询场景应走事件（SSE / WS）而非 cron。
- **一次性任务触发后删除**：保留为「已终结」记录（nextRunAt=null）供用户回看历史与复制重建；删除是显式动作（manage_schedule remove）。
- **把注入消息做成 assistant/system 消息并跳过 engine**：run 语义就是「以用户身份发起协作」，注入 user 消息 + `engine.launch` 复用全部既有管道（互斥 / 插话 / 通知 / 图谱），不造第二条执行路径。

## 适用与失效条件

- 适用：本地单用户部署（与既有 ADR 同一产品形态）；服务端进程常驻（tick 依赖进程存活；停机期间错过触发按补跑窗口裁决）；时间粒度 ≥ 分钟（5 段 cron）。
- 失效条件：
  - **多用户 / 多租户**：任务归属与 tick 资源隔离需重新设计（每租户配额 / 调度隔离 / 审计边界）；
  - **集群部署（多副本）**：tick 会多副本重复触发，需引入分布式锁或选主（单调度器实例）；
  - **强「错过必补」语义**（如计费 / 账务任务）：skipped-missed 折中需改为持久队列 + 重试策略 + 幂等键；
  - **秒级调度或万级任务量**：按天步进的 cron 计算与全表 due 查询需改为时间轮 / 优先队列 / 分片调度；
  - **需要跨会话编排**（「A 会话完成后再触发 B 会话」）：会话级边界失效，需引入任务 DAG 与跨会话权限模型。
