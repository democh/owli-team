# 多 Agent 协作开发团队

一个本地运行的「多 Agent 协作开发团队」Web 应用：你提出需求（可 `@` 指定角色），多个角色 Agent 在**同一会话共享上下文**，通过输出 `@某角色` **自主转交任务**，形成接力链——产品经理分派 → 架构设计 → UI/前端/后端实现 → 测试验证 → DevOps → 产品经理向你 `@用户` 汇总收尾。

- 每个 Agent 拥有独立人设与**专属卡通形象照**（AI 生图资产，造型与道具一一对应人设，见 §19）、职责描述与能力清单
- Agent 资产以**单包目录**组织于 `agents/<场景>/<id>/`：`AGENT.md` 定义 + 可选 `souls/` 灵魂变体 + `avatar.png` 形象照（§25–§26），**改完即生效、无需重启**
- **三套场景**（研发团队 / 头脑风暴 / 深度研究）可自由组合成员；支持运行中邀请 / 移出成员（聊天流内事件条，§27）、会话级切换灵魂、显式触发的 Run 内并行波次（§29）与协作图谱视图（§28）
- LLM 调用经 Node 后端代理（OpenAI 兼容协议，兼容 DeepSeek / OpenAI / Ollama），SSE 流式输出
- **异步执行 + WebSocket 通知**：Run 与连接解耦、可后台执行，完成 / 交还用户 / 异常经 WS 实时推送（见 §18）
- **研发工具与交付件**：Agent 内建工具集读写 `workspace/` 交付件、支持 Skill 按需加载，前端内置交付件浏览器（§21–§23）
- **`LLM_API_KEY` 为必填**：未配置时服务拒绝启动；唯一例外是显式开启 `LLM_MOCK=true`（脚本化 Mock，仅供 E2E / 离线演示）

> 本文档同时承担**项目说明**与**完整设计文档**：前半部分为使用指南，从「设计文档」章节起为系统设计（架构 / 协议 / 编排引擎 / 前端 / 决策记录）。

## 快速开始

环境要求：Node.js 22.5+（推荐 24，依赖内置 `node:sqlite`），npm 10+。

```bash
npm install        # 安装根 + client/server/shared 三个 workspace 依赖
npm run dev        # 一键启动：服务端 8787 + 客户端 5173
```

打开 http://localhost:5173 即可使用（启动前需在 `.env` 中配置 `LLM_API_KEY`，未配置时服务拒绝启动；无 Key 时可用 `LLM_MOCK=true` 走脚本化 Mock 体验全流程）。

### 演示脚本

1. 新建会话（勾选成员）→ 发送「帮我设计一个登录功能」，观察接力链实时推进：产品经理拆解需求 → `@架构师` → `@设计师` → `@前端` / `@后端` → `@QA` → `@DevOps` → `@用户` 汇总收尾；
2. 主区切到「交付件」Tab：各角色产出的 Markdown 交付件随写随现，可预览 / 查看版本 Diff；
3. 运行中再发一条消息 = **插话**（当前回合结束后注入上下文）；点「停止」可随时中断，「继续生成」可续写；
4. 高风险动作（`git_commit` / `git_restore` / `run_command` / 覆盖写等）在 `APPROVAL_MODE=risky`（默认）下弹出审批卡：批准 / 拒绝 / 自定义反馈；
5. 关闭页面任务照常推进，完成 / 交还 / 出错经 WebSocket 通知（未读角标 + 系统通知），刷新可经 `/api/runs/:runId/stream` 重附着运行流。

### 6.3 事件时序示例

```
data: {"type":"user:message", ...}
data: {"type":"run:start","runId":"...","sessionId":"...","queue":["pm"]}
data: {"type":"turn:start","runId":"...","agentId":"pm","messageId":"m1","turnIndex":1}
data: {"type":"message:delta","messageId":"m1","delta":"好的，"}
data: {"type":"message:delta","messageId":"m1","delta":"我先拆解需求…"}
data: {"type":"turn:end","messageId":"m1","agentId":"pm","mentions":["architect"],"queue":["architect"],"status":"complete"}
…（后续回合同上）…
data: {"type":"run:end","runId":"...","sessionId":"...","reason":"completed"}
```

### 6.4 turn:end.mentions 语义（一次真实性修复）

`turn:end.mentions` **不是**模型输出的原始提及，而是**调度器实际入队的结果**：

- 早期实现直接 emit 解析结果，曾出现 UI 显示「Felix → Vera 转交」但 Vera 并不在 3 人团队会话中的虚假事件（委派被守卫丢弃，展示却未丢弃）；
- 现在 `mentions` 取自 `ScheduleResult.accepted`（守卫过滤后真正接手的成员）；交还用户时恒为 `['user']`；
- 引擎还会先把句中 `'user'` 从候选里剔除再调度，保证「显示的事件 = 实际发生的调度」；
- 客户端另有一条渲染兜底：若本回合未解析出任何 @ 但队列非空（调度器收尾兜底），则以 `queue[0]` 展示转交事件条。

## 7. LLM 接入层

### 7.1 Provider 抽象

```ts
type LlmChunk =
  | { type: 'text'; text: string }               // 正文增量
  | { type: 'reasoning'; text: string }          // 思考增量（V4：独立通道，不进正文）
  | { type: 'tool_calls'; calls: LlmToolCall[] } // 聚合后的工具调用（§21.2）
  | { type: 'usage'; usage: LlmUsage }           // 用量（M4：include_usage 流末产出，写 usage 表）
  | { type: 'truncated' }                        // 输出截断（finish_reason=length：引擎落系统条提示，ADR 0186）
  | { type: 'done' }

interface LlmProvider {
  chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<LlmChunk>
}
```

- `ChatRequest{ system, messages, model?, temperature?, thinking?, tools?, responseFormat?, meta }`：`system` 为完整系统提示，`messages` 为对话窗口 + 回合指令；`tools` 为工具清单（OpenAI tools 协议，§21.2）；`responseFormat` 透传结构化输出（M2 摘要 / M9 评测 judge）；
- `ChatRequestMeta{ agentId, participantIds, spokenAgentIds?, stepIndex?, availableSkills? }`：运行期元信息，测试替身用它选择剧本与动态转交，真实 Provider 忽略；
- 选型 `AsyncIterable<LlmChunk>`：多通道增量（正文 / 思考 / 工具 / 用量）与 SSE 事件天然同构，真实实现与测试替身可完全互换；
- 契约要求：**必须响应 AbortSignal**（停止 / 超时依赖它中断底层请求）。

### 7.2 openai-compatible 实现

基于官方 openai SDK + 自定义 `baseURL` 发起流式请求（`stream: true`），逐段产出增量文本。任何 OpenAI 兼容端点均可接入（DeepSeek / OpenAI / Ollama / 自建网关），只需配置 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`。模型选择优先级：角色 front-matter 的 `model` > 全局 `LLM_MODEL`；`temperature` 同理。

**输出完整性治理**（ADR 0186）：请求显式下发 `max_tokens`（`LLM_MAX_OUTPUT_TOKENS`，`0` = 交给服务商默认）；流末 `finish_reason=length` → 产出 `truncated` chunk，引擎落系统事件条提示（末轮截断才提示；正文保留、可续写 / 重新生成）；**全程无收尾标记**（finish_reason / usage 双缺）且非主动中止 → `LlmStreamInterruptedError`（可重试分类，首增量前可安全重放）；OpenAI SDK 对 abort 为「静默结束迭代器」（不抛错）——韧性层（§7.4）循环退出前复核父级信号与超时相位，中断 / 超时不得被误判为「正常完成」。

### 7.3 测试替身（确定性驱动）

测试替身有两处，用途不同：

- `server/tests/mock-provider.ts`：**仅单测使用**，离线、零延时驱动全链路（engine 集成测试基于它，机制同构）——剧本库按主题撰写，`pickNext()` 运行时动态生成转交目标（优先「剧本撰写且在场」，否则按 `DEFAULT_CHAIN` 回退），候选只选本轮尚未发言者，无人可接时 `@用户` 收尾；
- `server/src/llm/mock.ts`：**`LLM_MOCK=true` 显式开关**（M10）下的脚本化 Provider，供 Playwright E2E 与离线演示使用——一次工具阶段产出真实工具调用（`write_todos` / `write_file` / `request_approval`），文本按 `LLM_MOCK_DELAY_MS` 分片流式产出；**镜像面标准**：演示剧本 / 交付件路径 / 显示名 / 转交首选按 `agents/` 资产全量镜像（每角色四件套齐备，交付路径与该角色「交付契约」一致），由 `server/tests/mock-coverage.test.ts` 全量防回归守护。

### 7.4 运行路径

默认只装配真实模型（OpenAI 兼容 Provider）；`LLM_API_KEY` 必填，**未配置且未开 `LLM_MOCK` 时启动即报错退出**（fail-fast）。启动日志打印模型与端点（如 `LLM: deepseek-flash @ https://api.deepseek.com/v1`），`npm run llm:ping "你好"` 可随时冒烟验证连通性。M4 起接入韧性层（错误分类重试 / 超时分层 / 并发限流 / usage 成本，ADR 21）。

## 8. 数据与持久化

### 8.1 数据模型

```ts
Project        { id, name, rootPath, workspaceMode: 'sandbox'|'repo'|'worktree', baseBranch?, createdAt, updatedAt }
Session        { id, projectId?, title, participantIds: string[], createdAt, updatedAt }
ChatMessage    { id, sessionId, runId?, turnIndex, role: 'user'|'agent', agentId?, content,
                 mentions: string[], status, artifacts?, toolCalls?, reasoning?, createdAt }
MessageStatus  = 'streaming' | 'complete' | 'error' | 'stopped'
Run            { id, sessionId, state, queue, turnIndex, pendingUserMessages, handedToUser, error?, ... }
```

`mentions` 随消息持久化，历史消息的 @chip 无需重新解析即可渲染；`reasoning`（思考模式）独立持久化，前端折叠展示。

### 8.2 存储策略（SQLite）

存储层为 **SQLite**，驱动隔离在 `server/src/store/db.ts`（当前为 Node 内置 `node:sqlite`；`SqlDriver` 接口预留可替换驱动；WAL、`foreign_keys=ON`），迁移器按 `schema_migrations` 顺序执行 `store/migrations/*.sql`：

- 会话 / 消息 / 运行 / 记忆 / 摘要 / 任务 / 交付件版本 / 审批 / usage / run_events / feedback / projects 全部落表（M1 一次建全量 schema）；
- `messages_fts`（FTS5 trigram）支撑跨会话全文检索；交付件文件本体仍在磁盘（`workspace/`），DB 只存索引与版本；
- 旧版 `data/sessions/*.json` 启动时一次性幂等导入（`store/legacy-import.ts`，原文件保留 + `.imported` 标记），也可手动 `npm run migrate:json`；
- 选型理由：需要事务、FTS、分页与迁移，JSON 全量重写不可持续（ADR 18，取代原 JSON 方案 ADR 6）。

### 8.3 崩溃恢复

进程重启时 `runs` 表中 `state='running'` 的 Run 标记为 `interrupted`，会话内提供「从断点继续」（复用队列 + 已产出消息）；`streaming` 消息改写为 `stopped`（半截内容保留展示）。

## 9. HTTP API

全部挂载于 `/api`，错误响应统一 `{ error: string }`（中文文案，前端直接 toast）。**完整接口表（方法 / 路径 / 说明 / 关键返回 / 请求体）见 [docs/api.md](docs/api.md)**，此处仅列资源概览：

| 资源 | 端点 | 引入 |
| --- | --- | --- |
| 健康与元数据 | `GET /api/health`、`GET /api/agents`、`GET /api/skills` | v1 |
| 会话 | `GET/POST /api/sessions`、`GET/PATCH/DELETE /api/sessions/:id`、`POST /api/sessions/:id/messages`（启动 Run 或插话）、`POST /api/sessions/:id/resume`（断点继续）、`PATCH/DELETE /api/sessions/:id/messages/:messageId`、`POST /api/sessions/:id/fork`、`POST /api/sessions/:id/uploads`、`GET /api/search`、`/api/sessions/:id/members`（增删改，M16）、`/api/sessions/:id/plans`（计划与评审，M24）、`POST /api/sessions/:id/attachments`（附件直传，M33） | M3/M8/M9/M16/M24/M33 |
| 运行 | `GET /api/runs/:runId/stream`（SSE 重附着）、`POST /api/runs/:runId/stop`、`POST /api/runs/:runId/queue`（队列干预：重排待出手棒次）、`POST /api/runs/:runId/messages/:messageId/resume`（继续生成）、`.../regenerate`（重新生成）、`GET /api/runs/:runId/usage`、`GET /api/runs/:runId/trace`、`GET /api/runs/active` | M4/M8/M9/M14 |
| 审批 | `GET /api/runs/:runId/approvals`、`POST /api/runs/:runId/approvals/:approvalId`（approve/reject/custom） | M7 |
| 上下文与记忆 | `GET /api/sessions/:id/context`、`GET/POST /api/sessions/:id/memory`、`PATCH/DELETE /api/sessions/:id/memory/:memId`、`/api/memories/*`（跨 scope：列表 / 统计 / 重建 / 召回 / 替代 / 状态，M25） | M2/M25 |
| 任务 | `GET /api/sessions/:id/tasks` | M3 |
| 项目与工作区 | `GET/POST /api/projects`、`GET/PATCH/DELETE /api/projects/:id`、`GET /api/sessions/:id/worktree`、`POST /api/sessions/:id/worktree/merge\|discard` | M6 |
| 交付件 | `GET /api/sessions/:id/artifacts`、`.../artifacts/content`、`.../artifacts/versions`、`.../artifacts/diff`、`.../artifacts/preview`（Office 轻量解析，M24） | v1/M8/M24 |
| 设置与观测 | `GET/PUT /api/settings`、`GET /api/metrics/tools`、`GET /api/metrics/summary`、`POST/GET /api/feedback`、`GET /api/feedback/export` | M8/M9 |
| 通知 | `WS /ws`、`GET /api/notifications`（降级轮询） | v1 |
| 连接中心 | `GET/POST /api/connections`、`GET/PUT/DELETE /api/connections/:id`、`POST /api/connections/:id/test`、`GET /api/audit`、`GET/POST/DELETE /api/sessions/:id/connections`（会话绑定）、`GET /api/connections/:id/schema\|sql\|tables`（数据库工作台）、`GET /api/connections/:id/ssh/terminal-token` + `WS /ws/ssh`、`/api/browser/*` + `WS /ws/stream` | M22/M23 |
| 资产控制台 | `/api/console/agents/*`（CRUD / 复制 / 头像 / 灵魂）、`/api/console/skills/*`（CRUD）、`GET/POST /api/console/groups`、`GET /api/console/tools`、`POST /api/console/validate` | M26 |
| MCP 接入与管理 | `/api/mcp/servers/*`（CRUD / test / reconnect / refresh）、`GET /api/mcp/tools`、`/api/sessions/:id/mcp-servers`（会话绑定）、`/api/mcp/json-config`（mcp.json 直配） | M27/M28 |
| 画布与媒体创作 | `GET/PUT /api/sessions/:id/canvas`、`POST /api/sessions/:id/canvas/mind`、`POST /api/sessions/:id/media/upload`、`GET /api/media/providers`、`GET/POST /api/sessions/:id/media/jobs`、`GET /api/media/jobs/:id` + `/cancel\|retry` | M31 |
| 金融投研 | `GET /api/finance/env`、`/api/finance/watchlist`（增删查）、`GET /api/finance/quote\|kline\|search\|news`、`POST /api/finance/game` | M34 |
| 定时任务 | `GET/POST /api/sessions/:id/schedules`、`PATCH/DELETE /api/schedules/:id`、`POST /api/schedules/:id/run\|pause\|resume` | M35 |

`POST /api/sessions/:id/messages` 是唯一「双形态」接口：无活跃 Run → 启动新 Run，返回 `201 { message, runId, queue }`（内容经 SSE `GET /api/runs/:runId/stream` 消费）；有活跃 Run → 插话，返回 `201 { message, injected: true, position, runId }`（ADR 10）。

`/ws` 与 `/api/notifications` 构成异步通知体系（§18）：Run 生命周期与连接解耦后，断线不中断执行，结果可补发、可重附着。

## 10. 前端设计

### 10.1 布局与组件树

三栏布局（react-resizable-panels 拖拽分栏，小屏可折叠右栏；宽屏左右栏均可整体收起 / 展开——显隐钮收敛于主区头部「对话 / 画布」页签两侧（常驻双态：展开态 = 隐藏 / 收起态 = 显示），见 §58.3）：

- **会话侧栏**：会话列表（标题 / 消息数 / 最后一条摘要）、新建（NewSessionDialog：轻量三人组 / 完整团队预置）、重命名、删除、会话导出；
- **聊天区**：消息流 → 成员消息（头像 + 名字 + 角色徽标 + Markdown 正文 + @chip）、用户消息、居中事件条（SystemEvent：转交 / 交还用户）；底部 Composer（@ 自动补全、运行中发送 = 插话、运行中显示停止；底栏右侧上下文电池格条：分段水位 + 点击开上下文抽屉，见 §88）；
- **右栏团队面板**（分段视图：成员 / 接力 / 战绩 / 任务，见 §20）：参与者职责卡（形象照 / 状态灯 / 名字 / 角色 / 能力标签 / 迷你战绩、@ 召唤与拍一拍）、发言中高亮与状态角标、转交纸飞机动画、接力链进度；右栏顶部仅保留分段视图控件（安静模式开关与实时连接状态指示位于全局顶栏，见 §42.1；面板显隐钮收敛于主区头部，见 §58.3）。

### 10.2 状态管理（zustand，六 store 各司其职）

| store           | 职责                                                                             | 关键 API                                                                   |
| --------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `agent-store`   | 角色定义（应用启动加载一次）+ 运行态状态（idle/speaking/thinking…）              | `agents`、`byId`、`setStatus`                                              |
| `session-store` | 会话列表 / 当前会话 / **消息 byId: Map + order: string[]**（让列表项 O(1) 订阅） | `upsertMessage`、`patchMessage`、`appendToMessage`、`refreshActiveSummary` |
| `run-store`     | 运行态状态机与 SSE 事件归约（全应用唯一事件入口）+ 审批列表与提交                 | `send`、`stop`、`handleEvent`、`approvals`、`respondApproval`、`resetTransient` |
| `task-store`    | 任务清单（`GET /api/sessions/:id/tasks`，右栏「任务」视图）                       | `load`、`items`                                                            |
| `ws-store`      | WebSocket 连接与异步通知（连接态 / 订阅 / 未读计数 / toast / 审批兜底，见 §18.5） | `init`、`ensureSubscribed`、`unread`、`reconnect`                          |
| `ui-store`      | 界面杂项：主区 / 右栏视图、安静模式、弹层开关、消息编辑与定位、跨组件插入通道 | `setMainTab`、`setRightView`、`toggleQuietMode`、`insertToComposer`、`focusMessage` |

设计要点：**消息永远只存在 session-store 一份**（`byId + order` 结构，虚拟列表按 id 订阅，见 ADR 25）；run-store 只维护瞬时运行态（`status: idle|running|stopping`、`queue`、`activeAgentId`、`handoffs`；审批挂起时 `approvals` 非空）；切换会话时 `resetTransient()` 清理瞬时状态，而归属其他会话的 SSE 事件仍靠 `runSessionId` 正确寻址；异步通知由 `ws-store` 独立归约，与 SSE 事件以 `runId + turnIndex` 幂等去重（§18.7）。

### 10.3 流式渲染管线

```
Composer → run-store.send() → lib/stream.ts（fetch POST）
   ├─ Content-Type: text/event-stream → 逐事件 handleEvent()
   └─ JSON { injected } → upsertMessage + toast（插话分支）
handleEvent → message:delta 写入 deltaBuffer（不直接 setState）
           → scheduleFlush() 40ms 后批量 appendToMessage → React 重渲染
```

- **手写 SSE 解析**（不用 EventSource，因为需要 POST 携带 body）：`TextDecoder` 流式解码 → 按 `\n\n` 切事件块 → 聚合 `data:` 行 → `JSON.parse` → 容错（心跳/无效块忽略、残余 buffer 兜底处理、AbortError 静默转为 onEnd）；
- **delta 40ms 批缓冲**：逐 token setState 会让 React 每秒重渲染上百次，批量 40ms（≈25fps）兼顾视觉连续性与渲染开销；`run:start` / `turn:start` / `turn:end` / `run:end` / `error` 到达时强制 `flushDeltas()`，保证阶段边界处消息内容完整；
- **占位消息**：`turn:start` 到达即建 `streaming` 占位（空内容 + 角色头像 + 打字光标），`turn:end` 用服务端 `status`/`mentions` 固化。

### 10.4 转交事件条（SystemEvent）

由 agent 消息的 `mentions` 驱动（随消息渲染、随滚动历史可见；streaming 中的消息不渲染），三分支生成：

1. `mentions` 含成员 → 「{发起人} → {目标头像+名字} · 任务转交」；
2. 含 `'user'` → 「{发起人} ⤵ 交还用户 · 等待确认」（琥珀色强调）；
3. 无任何 @ 但 `queue` 非空（调度器收尾兜底场景）→ 以 `queue[0]` 作为转交目标生成第 1 类事件。

交接条随消息持久化（同一份 `mentions` 同时用于「@用户 收尾」高亮）。**M11**：交接条目标头像可点击——一键向 Composer 插入 `@名字 `（点击接棒）；入场一拍动效 `handoff-in`（安静模式 / reduced-motion 下不播）。

### 10.5 @自动补全与提及渲染

- **输入侧**：`lib/mentions.ts` 从光标位置反查当前 `@查询区间`，候选 = 本会话参与者 + 用户（按 id/name 模糊过滤）；键盘交互 Enter/Tab 选中、Esc 关闭、↑↓ 导航；选中后回写 `@id ` 并更新光标；
- **渲染侧**：`remark-mentions` 插件在 Markdown 渲染管线中把 `@token` 转为品牌色 chip（仅会话内可识别 token，避免误芯片段）；chip 点击 → `ui-store.requestMentionInsert()` → Composer 消费插入，形成「点击引用」闭环；
- 前端解析与后端解析职责分离：前端只管显示与输入体验，**调度仍以服务端解析结果为准**；
- **M11 增强**：候选面板显示成员实时状态点（发言中 / 思考中脉冲）；标签匹配子串高亮；行首 `@` 提示「指定首棒」（服务端语义：`queue = mentions 顺序`，无 `@` 则由 PM 起手），行内 `@` 提示「仅提及」；Composer 上沿新增**指挥台成员条**（点击插入 `@名字 `；正在发言者流光、排队成员右上角序号角标、hover 提示注明队列位次）。

### 10.6 头像系统

主方案为**AI 生图卡通形象照**（详见 §19，v2 全量重设计为风格化 3D 卡通）：每个角色一张 1:1 风格化 3D 卡通（动画电影质感）纯白底半身像（存于 Agent 包内 `agents/<场景>/<id>/avatar.png`，512px，经 `/api/agents/:id/avatar` 直出），front-matter `avatar.image` 引用（同目录存在 avatar.png 时自动发现）；多级尺寸（16–96px）统一 `object-cover` + **组件内置 25% 等比圆角**（全站头像统一口径，ADR 0132；任意尺寸圆润度一致，调用方 className 可覆盖）；状态通过角标表达（thinking 省略号 / done 星星 / error 闪电，`animated=false` 时关闭）。未配置图片或加载失败（onError）自动回退「渐变 + lucide 图标」（`ICON_REGISTRY` 未命中回退 `User`）。

### 10.7 会话导出

按会话组装 Markdown（标题 + 参与者名单 + 按时间顺序的消息，角色消息标注名字与角色）下载，用于存档/分享协作记录。

### 10.8 包体与构建优化（M13）

- **shiki 白名单**：从全量入口（`bundledLanguages` → 每个语言一个构建 chunk、运行时按需 fetch）切换到 fine-grained bundle（`shiki/core` + oniguruma engine + 主题/语言子路径 import）；白名单 35 个常用语言按需懒加载、别名归一（`ts`→`typescript`、`sh`→`bash`、`yml`→`yaml`…），白名单外回退 `text`（仍可复制，无需网络往返）；新增语言只需在 `LANG_LOADERS` 加一行；
- **构建产物**：276 个 chunk / 10MB → 43 个文件 / 4MB（语言 chunk 250+ → 35，按需加载）；
- **主包拆分**：`react-vendor`（react/react-dom/scheduler，142KB）与 `radix-vendor`（85KB）独立 chunk，版本不变时命中浏览器缓存；业务主包 704KB → 478KB（gzip 219 → 144KB）；
- **高亮入口统一**：消息 Markdown 与交付件浏览器共用 `lib/shiki.highlightCode`（此前 ArtifactsView 单独 `import('shiki')` 引入全量入口）；
- **验证**：`tests/shiki.test.ts` 覆盖预载语言 / 别名与懒加载 / 白名单外回退；构建产物门槛见 §12.2。

### 10.9 运行中队列干预（M14）

- **入口**：团队面板「接力」视图底部的「指挥台」排队区（仅运行中显示）——未出手棒次的序号 chips，下一棒高亮，`↑`/`↓` 调整棒次立即生效；
- **协议**：`POST /api/runs/:runId/queue`（`{ agentIds: string[] }`）→ 引擎校验（仅会话在场成员、去重、空队列拒绝）后替换内存队列并落 trace，返回归一化后的 `{ queue }`；
- **一致性**：服务端广播 `queue:updated` 事件（RunEvent），前端乐观更新 + 失败回滚，SSE 广播幂等对齐；回合结束时调度器保留用户重排顺序（仅追加新 handoff 目标，不重排既有棒次）；
- **验证**：服务端集成（重排生效 + 守卫过滤 / 去重 / 空队列 / Run 不存在）+ 客户端组件（`tests/relay-queue.test.tsx`：渲染 / 乐观提交 / 回滚 / 空闲不渲染）。

## 11. 关键设计决策（ADR 汇总）

ADR 已拆分为独立文件（[`docs/adr/`](docs/adr/README.md)），每条含完整背景、结论理由与替代方案；**完整索引与状态汇总以 [docs/adr/README.md](docs/adr/README.md) 表格为准**（含 0097 起新增条目）；下表为至 0096 的历史快照（状态：**Accepted** 生效 / **Amended** 修订 / **Superseded** 被取代）：

| #   | 决策 | 状态 | 文件 |
| --- | ---- | ---- | ---- |
| 1 | LLM 调用位置：服务端代理 | Accepted | [0001](docs/adr/0001-server-side-llm-proxy.md) |
| 2 | 协作范式：自主委派（M3 起 handoff 工具优先，文本 @ 兼容回退） | Amended | [0002](docs/adr/0002-autonomous-delegation.md) |
| 3 | 发言并发度：顺序执行（M16 起为波次特例，修订见 33） | Amended | [0003](docs/adr/0003-sequential-speakers.md) |
| 4 | 交还判定：仅行首 `@用户` | Accepted | [0004](docs/adr/0004-await-user-line-start.md) |
| 5 | 流式通道：SSE | Accepted | [0005](docs/adr/0005-sse-run-stream.md) |
| 6 | 持久化：每会话 JSON 文件 | Superseded → 18 | [0006](docs/adr/0006-json-session-files.md) |
| 7 | 角色定义：prompts\*.md 文档驱动（M15 由 28 取代） | Superseded → 28 | [0007](docs/adr/0007-prompt-file-driven.md) |
| 8 | 无 Key 处理：启动即报错（`LLM_MOCK` 显式例外） | Amended | [0008](docs/adr/0008-fail-fast-without-key.md) |
| 9 | delta 渲染：40ms 批量合并（+150ms 渲染层节流） | Amended | [0009](docs/adr/0009-delta-batching.md) |
| 10 | 消息接口双形态（SSE/JSON）：一个入口兼顾新运行与插话 | Amended | [0010](docs/adr/0010-dual-shape-messages-endpoint.md) |
| 11 | 异步通知通道：SSE + WS 双通道 | Accepted | [0011](docs/adr/0011-sse-ws-dual-channel.md) |
| 12 | 运行生命周期与连接解耦 | Accepted | [0012](docs/adr/0012-run-detached-from-connection.md) |
| 13 | 头像方案：AI 生图卡通形象照 | Accepted | [0013](docs/adr/0013-ai-generated-avatars.md) |
| 14 | 工作区沙箱（+ALLOWED_ROOTS / repo / worktree） | Amended | [0014](docs/adr/0014-workspace-sandbox.md) |
| 15 | Skill 机制：文档驱动 + 渐进式披露 | Accepted | [0015](docs/adr/0015-skill-progressive-disclosure.md) |
| 16 | 前端主题：仅浅色 | Superseded → 24 | [0016](docs/adr/0016-light-theme-only.md) |
| 17 | 交付件浏览：主区 Tab（+版本 Diff） | Amended | [0017](docs/adr/0017-artifact-browser-main-tab.md) |
| 18 | 持久化：SQLite（内置 `node:sqlite` 驱动）+ 迁移 + FTS（M1，取代 6） | Accepted | [0018](docs/adr/0018-sqlite-persistence.md) |
| 19 | 上下文工程：五层装配 + 滚动摘要压缩 + 记忆（M2） | Accepted | [0019](docs/adr/0019-context-assembly-compression.md) |
| 20 | 会话级互斥 + 插话 + Run 快照恢复（M3） | Accepted | [0020](docs/adr/0020-session-mutex-interjection.md) |
| 21 | LLM 韧性层：重试 / 超时分层 / 并发限流 / usage（M4） | Accepted | [0021](docs/adr/0021-llm-resilience.md) |
| 22 | worktree 工作区隔离（git worktree + agent 分支）（M6） | Accepted | [0022](docs/adr/0022-worktree-workspace.md) |
| 23 | HITL 审批：request_approval + 挂起恢复（M7） | Accepted | [0023](docs/adr/0023-hitl-approval.md) |
| 24 | 深色主题（M8，取代 16；M11 被 27 取代） | Superseded → 27 | [0024](docs/adr/0024-dark-theme.md) |
| 25 | 前端性能架构：byId+order / 虚拟列表 / 渲染节流（M8） | Accepted | [0025](docs/adr/0025-frontend-store-performance.md) |
| 26 | 可观测与评测闭环：trace / metrics / eval / feedback（M9） | Accepted | [0026](docs/adr/0026-observability-eval.md) |
| 27 | 移除深色主题，回归仅浅色（M11） | Accepted | [0027](docs/adr/0027-remove-dark-theme.md) |
| 28 | Agent 包化与场景分组：agents/ 单包目录 + _group.yaml（M15，取代 7） | Accepted | [0028](docs/adr/0028-agent-packages-scenes.md) |
| 29 | Agent 灵魂层：可选人格变体 + 优先级护栏（M16） | Accepted | [0029](docs/adr/0029-soul-layer.md) |
| 30 | 会话动态成员：members API + system 消息（M16） | Accepted | [0030](docs/adr/0030-dynamic-members-system-messages.md) |
| 31 | 场景协议分层与技能包绑定（M18） | Accepted | [0031](docs/adr/0031-scene-protocols-skills.md) |
| 32 | 协作图谱：React Flow 选型 + 前端推导口径（M17） | Accepted | [0032](docs/adr/0032-collaboration-graph.md) |
| 33 | Run 内并行波次：显式触发、默认串行（M16，修订 3） | Accepted | [0033](docs/adr/0033-parallel-waves.md) |
| 34 | Markdown 渲染扩展：mermaid / chart / 容器语法与包体纪律（M19） | Accepted | [0034](docs/adr/0034-markdown-rendering-extensions.md) |
| 35 | 联网检索与反爬：web_search（百度双模式）+ web_fetch 反爬增强（M20） | Accepted | [0035](docs/adr/0035-web-search-baidu-anti-bot.md) |
| 36 | 协作图谱游戏化：拖拽 / 自适应折行赛道 / 双布局 / 导演镜头 / 档案面板（M21） | Accepted | [0036](docs/adr/0036-relay-graph-gameplay.md) |
| 37 | OPC 业务场景编制：6 场景 19 角色与业务工具纪律（M21） | Accepted | [0037](docs/adr/0037-opc-business-scenes.md) |
| 38 | 业务工具集：calc / date_calc / csv_analyze / template_fill（零新增依赖，M21） | Accepted | [0038](docs/adr/0038-business-tools.md) |
| 39 | 业务 Markdown 卡：kpi / timeline / mail / option 容器（M21） | Accepted | [0039](docs/adr/0039-business-markdown-cards.md) |
| 40 | 快速组队预设：_presets.yaml 资产化与建会话交互（M21） | Accepted | [0040](docs/adr/0040-preset-rosters.md) |
| 41 | 图谱交互深化：悬停预览 / 键盘导航 / 接力链追踪 / 时间轴回放（M22） | Accepted | [0041](docs/adr/0041-graph-interaction-depth.md) |
| 42 | 连接中心与 CDP 浏览器接入：凭据加密 / 会话绑定 / SQL 护栏 / 帧流分权（M22） | Accepted | [0042](docs/adr/0042-connections-center-cdp-browser.md) |
| 43 | 操作直播窗（LiveDock）与双视图联动：三态浮层 / 自动滑入 / 引用计数（M22） | Accepted | [0043](docs/adr/0043-live-dock-dual-view.md) |
| 44 | 数据库工作台（Navicat 式）与 SSH 交互终端：共享网格 / 写确认流 / xterm 多会话（M23） | Accepted | [0044](docs/adr/0044-database-workbench-ssh-terminal.md) |
| 45 | 外部技能适配规范：来源选择 / 改写原则 / 预载绑定（M23） | Accepted | [0045](docs/adr/0045-external-skill-adaptation.md) |
| 46 | 交付件多格式预览：9 类 kind / 服务端零依赖 Office 解析 / 沙箱直出（M24） | Accepted | [0046](docs/adr/0046-artifact-multiformat-preview.md) |
| 47 | 向量记忆：sqlite-vec 双后端 / 连接中心凭据 / 四层 scope 与 L1.5 语义召回（M25） | Accepted | [0047](docs/adr/0047-vector-memory-sqlite-vec.md) |
| 48 | 回合范式（规划 / 执行 / 评审）与计划审批挂起：opt-in 门控 / `awaiting_plan` / 驳回修订 v2（M24） | Accepted | [0048](docs/adr/0048-turn-modes-and-plan-approval.md) |
| 49 | 计划派发与任务面板 2.0：队列前置派发 / 按成员待办 / 双通道竞态守卫（M24） | Accepted | [0049](docs/adr/0049-plan-dispatch-task-board.md) |
| 50 | 资产控制台：ActivityRail + Agent / Skill 管理（软删除 / 引用检查 / 三态与配置矩阵）（M26） | Accepted | [0050](docs/adr/0050-asset-console.md) |
| 51 | 浏览器多标签页感知与激活页跟随：Target 发现 / opener 链与空白页观察 / 动作边界切换（M22） | Accepted | [0051](docs/adr/0051-browser-page-follow.md) |
| 52 | SQL 护栏加固与 query 只读纵深（诊断修复批）：大小写绕过 / PRAGMA setter / 可执行注释（M22 / M23） | Accepted | [0052](docs/adr/0052-sql-guard-hardening.md) |
| 53 | MCP 接入与管理：官方 SDK 双传输 / 凭据加密 / 会话绑定 / 通配授权与审批策略（M27） | Accepted | [0053](docs/adr/0053-mcp-integration.md) |
| 54 | 工具按需发现（渐进披露）：tier 元数据 / BM25+嵌入混合检索 / auto 阈值与 Run 级激活 / MCP JSON 直配文件权威同步（M28） | Accepted | [0054](docs/adr/0054-tool-progressive-disclosure.md) |
| 55 | 研发场景能力矩阵与编码代理能力基线：handoff 全局接通 / run_command 与 git 写按实现者授权 / 场景工程纪律 / debugging 技能（M29） | Accepted | [0055](docs/adr/0055-development-capabilities-code-baseline.md) |
| 56 | BI 场景与 NL2SQL 取数管道：单角色取数分析师 / db 只读三件套 / 取数纪律六条铁律 / nl2sql 技能与 tool_search 引导（M30） | Accepted | [0056](docs/adr/0056-bi-agent-nl2sql.md) |
| 57 | SRE 场景与 SSH 事故响应管道：单角色 SRE 工程师 / ssh_exec + git 只读边界 / 事故纪律十条 / incident-response 技能与 tool_search 引导（M32） | Accepted | [0057](docs/adr/0057-sre-agent-ssh-incident-response.md) |
| 58 | 专业级附件体系与多模态通道：双通道上传 / raw 直传与元数据可信化 / 装配护栏视觉注入 / 零依赖文档识别 / 托盘与消息内原生渲染（M33） | Accepted | [0058](docs/adr/0058-attachments-and-multimodal.md) |
| 59 | 无限画布与媒体创作工作台：React Flow v12 复用 / 会话级画布文档与乐观锁 / 四媒体适配器与「创建即返回」任务管线 / 脑图工坊 / Agent 闭环四工具与全角色白名单（M31） | Accepted | [0059](docs/adr/0059-infinite-canvas-media-studio.md) |
| 60 | 会话级定时任务与到点协作：自研 cron 内核与 Intl 时区 / run 与 remind 双动作 / 忙时 skip 与补跑窗口 / 失败自动暂停 / deferred 三件套与 8 角色白名单（M35） | Accepted | [0060](docs/adr/0060-session-scheduled-tasks.md) |
| 61 | 画布输入平权、设置主区页与媒体配置专业化：底部指令条 + 最近回复浮层 / MiniMap 移除 / 设置主区视图（26 项全量 + 资源概览 + 系统信息）/ 能力矩阵与编辑器校验 / pendingEditId 直达编辑（M36） | Accepted | [0061](docs/adr/0061-canvas-input-parity-settings-view.md) |
| 62 | 场景差异化限定于视图层派生：场景体验全部纯前端从既有消息字段派生，不动消息协议（M37） | Accepted | [0062](docs/adr/0062-scene-view-layer-derivation.md) |
| 63 | 场景资产扩展走 `_group.yaml`：guide（空态标题）/ agenda（议程模板）随 /api/agents 热更新（M37） | Accepted | [0063](docs/adr/0063-scene-assets-guide-agenda.md) |
| 64 | 交互卡片回填语义 = 生成草稿：composerInsert 只写草稿由用户确认发送；交互态存 sessionStorage 不落库（M37） | Accepted | [0064](docs/adr/0064-interactive-card-backfill.md) |
| 65 | 波次分隔与定位：分隔行用普通虚拟行（仅结构键）；「当前波次」用滚动位置派生的悬浮条（不用 CSS sticky）（M37） | Accepted | [0065](docs/adr/0065-wave-separator-and-strip.md) |
| 66 | 金融投研专项：三源混合网关（Node 源 + Python 桥 + 降级链）/ 反爬共享模块 / 12 个 `fin_*` 全量 deferred / charts 快照 / 行情 Tab 与博弈实验室 / invest 场景四路协作链（M34） | Accepted | [0066](docs/adr/0066-finance-research-suite.md) |
| 82 | 调度官为显式一等成员：资产角色 + 进入会话成员表，全部不变量原样成立（M46） | Superseded | [0082](docs/adr/0082-dispatcher-first-class-member.md) |
| 83 | `dispatch` 资产标记：front-matter `dispatch: true` 全局唯一 + check 校验 + 控制台 round-trip 保留（M46） | Superseded | [0083](docs/adr/0083-dispatch-asset-flag.md) |
| 84 | 空选择创建语义：`POST /sessions` 接受 `[]` → 服务端填充 `[调度官]`；资产缺失 400（M46） | Superseded | [0084](docs/adr/0084-empty-selection-session-creation.md) |
| 85 | 无 @ 路由调度优先：四分支（@ 直达 / 显式范式 / 调度官 / 兜底）；@ 与消息级范式零变化（M46） | Superseded | [0085](docs/adr/0085-no-mention-dispatcher-routing.md) |
| 86 | 召集单一收口：`invite_members` 仅调度官白名单可见；与成员 API 共享 `inviteMembersCore` 内核（M46） | Superseded | [0086](docs/adr/0086-invite-members-single-funnel.md) |
| 87 | roster_catalog 注入：仅调度官回合、只列未在场、内容签名 LRU 缓存（2–4k token 预算）（M46；M48 复用为平台路由输入） | Amended | [0087](docs/adr/0087-roster-catalog-injection.md) |
| 88 | 调度波恒 execute：`planFirst` 顺延业务首波（一次性标记消费）；调度不吃范式（M46） | Superseded | [0088](docs/adr/0088-dispatch-wave-execute-plan-deferral.md) |
| 89 | 工具运行时惰性 participants：同回合「先召集后交接」成立；handoff / plan / schedule 三处受益（M46；M48 继续服务 PRS 同回合召集→派发） | Amended | [0089](docs/adr/0089-lazy-participants-tool-runtime.md) |
| 90 | 调度接手护栏：同一 Run 调度官接手 ≤3 次 + 既有循环检测叠加（超出走常规 fallback）（M46） | Superseded | [0090](docs/adr/0090-dispatch-turn-guard.md) |
| 91 | 事件与广播复用：「召集了…加入协作」system 条 + `notify:members-changed` + trace `dispatch:invited`（M46；M48 沿用机制，trace 更名 `routing:dispatched`） | Amended | [0091](docs/adr/0091-invite-events-and-broadcast-reuse.md) |
| 92 | 收尾交付清单化与消息内交付明细：无交付件不渲染收尾卡；清单卡（件数 / 波次 / 作者 / 明细行）+ 消息内明细行；元数据会话级共享缓存（指纹含交付计数）（M37-6 修订；清单卡展示形态由 123 修订——分层默认） | Amended | [0092](docs/adr/0092-closeout-delivery-manifest.md) |
| 93 | 画布点击 / 拖动 / 选中交互修订：nodeClickDistance 与 nodeDragThreshold 统一 4px（消除吞 click 死区）；mergeNodes 重建转抄 selected；K 线图表区 nodrag + nowheel（M31 / M34 修订） | Accepted | [0093](docs/adr/0093-canvas-interaction-revision.md) |
| 94 | 派发优先于交还报备：mergeWaveSchedule 先收集 accepted 再判交还（`allHanded` 需无成员接手）；成员接手口径以 accepted 为准（M46-2） | Accepted | [0094](docs/adr/0094-dispatch-priority-over-handback.md) |
| 95 | 调度收口波：全链交还用户且队列空时追加调度官收口摘要（每 Run 一次；【收口汇总】指令 + `dispatch:closeout` trace）（M46-2） | Superseded | [0095](docs/adr/0095-dispatch-closeout-wave.md) |
| 96 | 会话级串行执行：默认开启（迁移 v12）；`globalParallelMax` 收紧为 1（显式 @≥2 亦逐位消化）；TaskView 芯片切换（M46-2） | Accepted | [0096](docs/adr/0096-session-serial-execution.md) |

> **M48 撤销（ADR 0101）**：上表 82–91 / 95 的调度官机制已撤销或修订（详见 §57）——82 / 83 / 84 / 85 / 86 / 88 / 90 / 95 → **Superseded**；87 / 89 / 91 的机制（目录注入 / 惰性 participants / 事件与广播）由平台路由步复用、trace 更名 `routing:dispatched` → **Amended**。97 起（现至 0116）的完整索引见 [docs/adr/README.md](docs/adr/README.md)。

## 12. 测试策略

### 12.1 自动化测试

- **服务端 1249 例 / 97 套件**（vitest；M68 批窗口实测，含 M38/M39 批与并发批次增量；2 例 m42 圆桌例会属并发 M69 资产扩容中间态——非本批）：parser / scheduler / prompts（agents 加载器：分组 / 灵魂 / 头像发现 / prompts 回退）、engine（集成）、context（装配 / 压缩 / 水位 / 降级 / soul 段 / 压缩并发幂等）、store（迁移 / JSON 导入 / FTS / 路径安全）、resilience（错误分类 / 退避 / 超时分层 / 压缩重试）、tools（沙箱 / 步数 / abort 无遗留副作用 / 并行 / 幂等缓存 / apply_patch / 敏感文件）、reasoning，以及 m3–m10 与 m15/m16 各里程碑回归套件（互斥插话 / handoff / 运行恢复 / usage / git worktree / 审批 / 鉴权限流与 ws 握手 / mock 开关 / members API / 波次 planWave 与 mergeWaveSchedule）与 m21（OPC 资产加载 / presets 校验 / 业务工具四件套）与 m22（连接中心全链路 / SQL 护栏 / 凭据加密 / 流 token / 浏览器帧流 / db 工具实时事件）与 m23（quoteIdent 引用转义 / tableData 分页与注入拦截 / SQL 面板 dryRun / SSH fake client 全链路 / ssh_exec 审计与审批）与 m27（MCP 接入：命名规范化 / 存储与会话绑定 / 运行时生命周期 / 引擎通配与会话过滤 / 管理 API 与审计广播）与 m28（工具按需发现：BM25+嵌入融合检索 / tier 与阈值自适应激活 / 执行门与 discovery 区块 / MCP JSON 直配解析与文件权威同步 / 管理 API 三端点）与 m29（可达性基线：handoff / remember · 编码代理能力：执行验证 / 版本控制 · 数据与环境分权）与 m30（BI 场景与角色资产 · 取数只读边界 · 方法论文档在场）与 m31（画布文档：读写与 applyOps · 媒体服务：状态机 / 队列 / 取消与超时 · 脑图生成 · 创作工具：读取摘要 / 批量写入 / 任务创建）与 m32（SRE 场景与角色资产 · SSH 诊断可达性 · 运行时绑定与 plan 收敛）与 m33（附件上传：白名单 / 文件名安全化 / 元数据可信化 · 消息持久化与防伪造路径 · 装配护栏与文档提取分流）与 m34（金融投研：三源网关 / 12 工具 / 行情 API / 博弈四模型，9 套件）与 m35（定时任务：cron 内核 / 服务 / 存储 / 工具 / 绑定 / API，6 套件）与 m48（调度平台化：平台路由步契约与降级 / 空编制与增援语义，2 套件）与 m50（空场景：资产与 M28 分层 / 直通路由 / 三层隔离 / 真 Mock 剧本全链，9 例）；
- **客户端 1107 例 / 95 套件**（M68 批窗口实测**全绿**；含 M38 批 21 例 `m38-cards.test.tsx` 与 M39 批 21 例 `m39-production.test.tsx` 与 M68 批 7 例 `m68-materials.test.tsx`）：session-store 归约（byId+order / 增删成员 / 换灵魂）、run-store 事件归约与 SSE 解析（含 wave:start）、消息渲染（chip / 流式 / 中断 / reasoning / system 事件条）、Composer 键盘交互、审批卡、Diff 渲染、快捷键帮助（M12）、命令面板命令（M13/M16）、shiki 白名单（M13）、指挥台排队调序（M14）、AgentPicker / 灵魂选择器 / 场景创建器 / 并行协作组 / 协作图谱（M16 / M22 深化：悬停预览 · 接力链追踪 · 时间轴回放）、Markdown 扩展（M19：容器语法 / 代码块工具条 / mermaid / chart / 灯箱 / TurnCard；M21 业务卡：kpi / timeline / mail / option）、快速组队与草稿预填（M21）、虚拟列表、WorktreeBar、ui-store、连接 / 浏览器面板与操作直播窗（M22：LiveDock 20 例）、数据库工作台与 SSH 终端（M23：工作台 store / 对象树纯函数 / 终端协议状态机 / SSH 表单与卡片入口，14 例）、操作直播 SSH 三合一（M23+：镜像纯函数 / busy 推导 / ssh 映射与审计回放 / 镜像广播 / DockSshView 交互 / 胶囊与窄卡，18 例）、MCP 管理台（M27：mcp-store 三路加载与会话绑定 / 服务器卡与授权矩阵 / 编辑器校验与凭据只写不读 / Rail 导航，15 例）、工具按需发现与 JSON 直配（M28：jsonConfig 加载与同步回写 / JSON 配置卡片与粘贴导入 / 来源徽章与只读保护 / eagerLoad 开关 / 工具「常驻·按需」列，13 例）、画布文档与媒体快照（M31：canConnect 连线矩阵 / 尺寸与剪贴板 / 节点交互与模板空态 / media-store 任务快照与完成落画布 / 脑图树操作与快捷编辑，78 例）、附件与多模态（M33：托盘三态与上传流 / 消息内图片网格与 Lightbox / 视频封面与音频条 / 文档卡跳转，11 例）、定时任务面板（M35：面板渲染 / 新建表单 / 双通道归约 / 徽章，8 例）、画布指令条与设置主区页（M36：26 项全量渲染与保存 / 资源概览直达 / 指令条键盘与范式 chip / 直达编辑消费，9 例）、场景化对话基座（M37：波次派生与分隔行 / 悬浮条与导航条窗口 / checklist·choice 回填与 fail-safe / 收尾交付清单派生与快照回填，25 例）、调度平台化（M48：空编制建会话与平台组队 / CommandPalette 快捷新建 / trace 三形状渲染，5 例）、建会话组队台（M50：来源搜索 / 来源切换重置编制与 souls / 编制行移出与清空 / 窄屏三页签，5 例）、空场景入口（M50：独立卡与预选 / 列表过滤 / 搜索与空态与提交 body / 命令面板同源，5 例）；
- **E2E 100 条用例 / 41 个 spec**（Playwright，`LLM_MOCK=true` + 生产单端口托管；v73 窗口实测 90 ✅——7 红甄别：1 例本批已修（m37 阶段条换显示）+ 3 例隔离复跑绿（环境抖动）+ 3 例并发批次域（M63 报价折线 / m34 新块 / M57 P3 配额）；**M68 批新增 `m68-library` 2 条（管理页上传→筛选→删除双清 / 放入画布 copy-on-use 入仓断言）隔离环境就地全绿**；含 M38 容器 2 条与 M39 生产包 3 条）：完整接力 / 插话 / 停止 / 刷新重附着 / 审批拒绝与批准 / 交付件 Diff / 交付件多格式预览（html / csv / docx / mermaid 分派）/ M12 微交互 / M14 窄屏响应式（抽屉壳 + 主链路，390×844）/ M16 运行中邀请接力 / 换灵魂风格变化 / 头脑风暴并行圆桌 / 协作图谱状态实时更新 / @ 两人并行双流 / 会话级串行双态（默认串行逐位 / 关闭后并行成波）/ M19 Markdown 扩展真实渲染（mermaid / echarts 懒加载 + 分栏 + TurnCard 徽章 / 裁决卡容器）/ M21 协作图谱游戏化 / M22 图谱深化（悬停预览卡 · 边固定 · 接力链追踪 · 时间轴回放）/ M21 OPC 业务链路双任务（周经营例会：preset 建会 → 并行汇报 → KPI / option 卡 → 交付件；内容营销战役：内容日历 timeline 卡 → 交付件）/ M24 计划审批（提交挂起 → 批准收口 / 驳回修订 v2）/ M25 向量记忆（嵌入连接 → L1.5 分层快照 / 记忆面板语义搜索）/ M26 资产控制台（Skill / Agent 新建 → 编辑 → 软删除 → 校验）/ M27 MCP 接入（新建 stdio 服务器 → 连接注入 → 会话绑定 → 通配授权 → 禁用/删除级联）/ M28 MCP JSON 直配（写文件 → 轮询自动同步 → 工具快照 → 会话绑定 → 变更 / 坏文件防误删 / 空清单删除）/ M31 画布交互（微移点击选中 / 双击编辑 / 拖动后选中保持 / 图表区 nodrag 手势，ADR 93）/ M33 附件上传与多模态渲染（双图托盘 → 纯附件发送 → 消息内图片 → Lightbox 切换 → 交付件面板）/ M34 投研链路三任务（两路 / 三路并行 → 主管收口 → 交付件；多空对弈 → 终局裁决）/ M37 场景化对话基座（议程 chips 预填 → 波次分隔行与悬浮阶段条 / checklist 点选回填闭环）/ M48 调度平台化（零选择开场 → 平台自动组队与派发 → 被召集成员开工；组队台预选 7 位研发链）/ M49 面板显隐（收敛于主区头部页签两侧的常驻显隐钮 / 刷新持久化 / ⌘B · ⌘⇧B 与命令面板同源 / 原位宽度恢复）/ M50 空场景（独立卡 → 单助手直聊 → 反向断言无平台召集 → 收尾与交付件）（`npm run e2e`，CI 已接入）；
- **评测 32 个 golden 任务**（含 M18 的 brainstorm / research、M21 的 OPC 业务链路、M25 的语义召回、M34 投研双任务、M48 平台路由委托任务、M50 空场景单助手直聊与 M51-A 辩论 / 谈判任务；v65 增调度专项四任务 routing-finance / handoff-receipts / scheduling-guards / parallel-guard 与 scheduling / no_stall 断言）：`npm run eval` 在隔离临时 DATA_DIR 下串行执行，与 `evals/baseline.json` 对比做回归门禁（改坏 prompt 即非零退出）；

### 12.2 手工验收清单

**v1 基线**

- 完整团队演示链：`PM → 架构 → 设计/前端/后端 → QA → PM @用户` 全链路与转交事件条一致；真实模型下接力链自洽；
- 运行中插话（点名插队/未点名进上下文）、停止按钮、刷新页面运行继续且恢复后可见完整记录；
- 异步运行：发送后立即关闭标签页 → 完成时收到系统通知与未读角标；重开页面经 `/api/runs/:runId/stream` 重附着可续看进行中内容；多标签页未读计数一致；
- 交付件：模型写文件 → 「交付件」Tab 实时出现（Markdown / 代码渲染、下载可用），消息 chip 可直达；工具卡与 Skill 加载在时间线正确展示；
- 首条消息后标题即时上榜（≈0.6s）；编辑 `prompts/*.md` 下一回合即生效。

**M10 专业化验收**

- 接力链自洽：全员出场，handoff 工具与文本 @ 回退路径都指向在场成员，无虚假转交事件；
- 上下文压缩后约束不丢：构造 30 回合长会话，压缩触发后首回合核心约束仍在 system（`GET /api/sessions/:id/context` 可验证分层与水位）；
- 真实仓库 worktree：挂载真实 git 仓库建 worktree 会话，改动只出现在 `agent/<sid>` 分支，主分支不受影响；「查看改动」可见 diff，合并需显式确认；
- 审批流可中断可恢复：`APPROVAL_MODE=all` 下触发审批 → 拒绝后模型收到反馈改方案；刷新页面审批卡仍在；超时（`APPROVAL_TIMEOUT_MS`）自动拒绝；
- 键盘可达与 a11y：列表 / 菜单 / 弹层焦点管理与 `aria-live` 播报；界面仅浅色主题（M11 起移除深色切换，ADR 27）；
- 生产单端口托管：`npm run build && npm start` 后 8787 单端口提供 API + 静态资源，E2E 全程基于该形态（mock 模式）；
- Docker 发布形态：`docker compose up -d --build`（未设 `AUTH_TOKEN` 直接报错）；浏览器 `http://127.0.0.1:8787/?token=<AUTH_TOKEN>` 种 cookie 后 HTTP + WS 全通，`docker compose ps` 健康检查为 healthy；
- 指派指挥台（M11）：Composer 上沿成员条点击插入 `@名字 `；正在发言者流光高亮、排队成员显示序号角标；行首 `@` 候选面板提示「指定首棒」、行内提示「仅提及」；交接条点击接手者头像一键接棒；团队面板成员卡「@ 召唤」；回合间隙显示「下一棒 · {名} 正在热身」；安静模式下交接条入场动效不播；
- 指派微交互（M12）：上滑后浮现「N 条新消息」浮标点击回底；审批卡 `⌘/Ctrl+Enter` 批准（带 kbd 提示）、`⌘/Ctrl+Backspace` 拒绝；`?` 打开快捷键帮助；成员卡单击弹出迷你档案（最近出手可点击定位）；接力视图顶部进度链实时高亮/打勾；
- 构建与包体（M13）：`npm run build` 产物文件 ≤ 50、主包 gzip ≤ 150KB；代码块常用语言（ts/tsx/js/json/bash/md/python/go/rust/java/cpp/css/html/yaml/diff/sql 等）着色正常，白名单外语言回退纯文本不报错；`⌘K` 命令面板可新建会话（全员参与并自动切换）/ 新建后可直接下达任务 / 打开运行 Trace / 切换安静模式（回显当前值）；
- 运行中队列干预（M14）：运行中团队面板「接力」视图出现「指挥台」排队区（下一棒高亮 + `↑`/`↓` 调序按钮）；调序后下一棒立即改变且不越界（首/尾 `↑`/`↓` 禁用）；空队列 / 非在场成员 / 已结束 Run 被拒绝（400）；其他标签页经 `queue:updated` 广播对齐；

**M15–M18 场景化扩展验收**

- 三场景完整演示：研发 / 头脑风暴 / 深度研究各自新建会话，走通「场景创建器（推荐编制预选）→ 接力 / 并行圆桌 → 交付件」全链路；
- 灵魂换装对比：同一角色（如卢娜）切换 狂野 / 禅意 / 考据派 灵魂，输出风格明显不同、职责与协作规则不变；「恢复默认」回落角色默认灵魂；
- 动态加人：运行中邀请卢娜入队并 @ 触发发言，「{邀请者} 邀请了 卢娜 加入协作」事件条落流；移出进行中成员被拒（400），移除排队成员从队列消失；
- 并行波次：@ 两位成员出现并行协作组双流式；头脑风暴 4 人圆桌同波输出；停止按钮中止整波（共享 AbortController）；
- 协作图谱：接力实线边与编制虚线正确、点击节点显示「接手 N 次」、运行时节点「发言中」高亮、并行波次同层高亮；
- 名录页：#/agents 按场景陈列全部 34 位角色（形象照 / 能力 / 技能 / 交接对象）；`GET /api/agents/:id/avatar` 头像直出；
- 迁移演练：`npm run migrate:agents` 幂等重跑无副作用；临时移除 `agents/` 后加载器回退 `prompts/` 并告警；恢复后 `check:agents` 与全量测试回归全绿。

**M19 Markdown 渲染扩展验收**

- 分栏与容器：`::: cols 2` / `::: col 标题` 双列网格与列标题（::before 取 data-title）；callout 六变体（tip/info/note/success/warning/danger）色板与图标；`::: details` 原生折叠；未闭合容器 / 未知容器名 fail-safe 不吞内容；
- 图表：mermaid 流程图 / 时序图懒加载渲染（首块加载 5.3MB 单文件 bundle，同源码命中缓存）；`chart` JSON（bar/line/area/pie/scatter）echarts 渲染，非法 JSON / 未知类型显示可读错误卡 + 源码回退；两者工具条含源码 / 全屏 / 复制，全屏浮层 Esc 关闭；
- 代码块：```` ```ts title="app.ts" {2,5-7} ```` 工具条显示文件名与语言、命中行高亮、复制可用；> 24 行折叠「展开全部 / 收起」；流式期间代码块 / 图表一律纯文本（完成后才渲染）；
- 阅读增强：图片点击灯箱放大（Esc 关闭）、宽表格横向滚动；
- TurnCard：agent 卡左侧组色主题条（按场景 theme 渐变）、头部角色与「第 N 波」徽章、流式进度线（完成后消失）、hover / focus-within 显现消息操作（窄屏常显）；
- 包体：产物 48 文件 ≤ 50、主包 gzip 109.7KB ≤ 150KB（mermaid / echarts 均为按需懒加载 chunk，md-vendor 拆分稳定依赖）。

## 13. 扩展指南

### 13.1 新增角色（无需改引擎代码）

1. 按场景建目录 `agents/<场景>/<id>/`，写入 `AGENT.md`（front-matter 元数据 + 人设正文；目录名即 id，`group` 由目录推导不需手写）：

```yaml
---
id: data                # 唯一 id；@data / @Nova 均可呼叫
name: Nova              # 显示名
role: 数据工程师          # 角色徽标
title: Data Engineer
description: 负责数据管道建模、指标口径与数据质量
capabilities: [数据建模, ETL, 指标口径, 数据质量]
avatar:
  icon: database                     # 回退图标名（avatar-icons.ts 注册）
  gradient: ["#0ea5e9", "#22d3ee"]   # 回退渐变
  # 同目录放 avatar.png 时会自动发现并覆盖 image 为 /api/agents/<id>/avatar
handoff: [architect, backend]   # 常见交接对象（可选，引导模型选择下游）
soul: wild                      # 可选：默认灵魂 id（对应 souls/wild.md；缺省取 souls/default.md）
model: ""               # 空 = 全局默认
temperature: 0.4
---
（此处为系统提示词正文：职责、工作方式、交接对象示例…）
```

2. （可选）灵魂变体：`souls/<soul-id>.md`（front-matter：id / name / tagline / icon / traits / tone / quirks + 正文，规范见 §26.2），同一角色可挂多套人格，会话内随时换装；无 `souls/` 目录 = 无灵魂，行为与现状完全一致；
3. （可选）形象与图标：生成 1 张 1:1 形象照放同目录 `avatar.png`（自动发现）；如需新图标，在 `client/src/lib/avatar-icons.ts` 的 `ICON_REGISTRY` 中 import 并注册一行（未命中回退 `User` 图标）；
4. 完成。服务端按目录 mtime 热更新，无需重启；`npm run check:agents`（旧名 `check:prompts` 为别名）可随时校验全部资产。新建会话时勾选该角色即可加入团队，完整操作手册见 [`agents/README.md`](agents/README.md)。

### 13.2 新增 SSE 事件

1. 在 `shared/src/types.ts` 的 `RunEvent` 联合类型中添加事件形状（协议单一事实源）；
2. 服务端在 engine 中 `emit`，客户端在 `run-store.handleEvent` 增加 case 归约；
3. 两端 TypeScript 会强制清单完整性（switch 穷举），不会遗漏处理分支。

### 13.3 接入新模型 / 网关

OpenAI 兼容端点只需改 `.env` 三件套（`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`）；非兼容协议则新增 `LlmProvider` 实现（实现 `chatStream` 并响应 AbortSignal），在 provider 工厂注册即可，编排层零改动。

### 13.4 常用调参入口

| 需求                  | 入口                                                         |
| --------------------- | ------------------------------------------------------------ |
| 改变团队协作行为/语气 | `agents/_protocol.md`（全局）或场景 / 单角色文档             |
| 单次运行回合数上限    | `MAX_TURNS_PER_RUN`                                          |
| 上下文预算（tokens）  | `CONTEXT_BUDGET_TOKENS`（压缩触发线 = 预算 × 0.7）            |
| 保留最近原文回合数    | `KEEP_RECENT_TURNS`（默认 6）                                 |
| 超时分层              | `FIRST_TOKEN_TIMEOUT_MS` / `STREAM_IDLE_TIMEOUT_MS` / `TURN_TIMEOUT_MS` |
| 重试与并发限流        | `LLM_MAX_RETRIES` / `LLM_MAX_CONCURRENCY`                     |
| 转交机制开关          | `HANDOFF_MODE=auto\|tool\|text`                               |
| 审批策略              | `APPROVAL_MODE=off\|risky\|all` / `APPROVAL_TOOLS`（§M7）     |
| 循环检测灵敏度        | `scheduler.ts` 的 `detectLoop` 波次签名窗口（默认最近 6 波）  |
| 并行上限（全局 / 场景）| `PARALLEL_MAX`（默认 3；=1 关闭）/ `_group.yaml` 的 `parallelMax` |
| 场景默认并行与轮次    | `_group.yaml` 的 `parallel` / `rounds` 开关（§25.2）          |

## 14. 目录结构

```
multi-agent/
├── Dockerfile                # 生产镜像（多阶段：构建 → node:24-slim 运行 + git + HEALTHCHECK）
├── docker-compose.yml        # 单端口部署（BIND_ALL + AUTH_TOKEN 强制、卷挂载 data/ 与 workspace/）
├── agents/                   # ★ Agent 资产包（核心资产，改完即生效，§25）
│   ├── README.md             # 新增 Agent / 灵魂的完整操作手册
│   ├── _protocol.md          # 全局协作协议（注入每个角色系统提示）
│   ├── development/          # 场景：研发团队（_group.yaml + pm/…/devops 七个角色包）
│   ├── brainstorm/           # 场景：头脑风暴（场景协议 + facilitator/ideator/challenger/refiner）
│   └── research/             # 场景：深度研究（场景协议 + lead/scout/analyst/verifier）
│       └── <id>/             # 单包自包含：AGENT.md + souls/*.md（可选）+ avatar.png
├── skills/                   # ★ Skill 库（SKILL.md，改完即生效，§23）
├── shared/                   # @multi-agent/shared 纯类型包（协议单一事实源）
│   └── src/types.ts          # RunEvent（SSE）与 NotifyEvent（WS）联合类型
├── docs/                     # API / 运维 / ADR（api.md / operations.md / adr/）
├── evals/                    # 评测任务（tasks/*.json + baseline.json + reports/）
├── e2e/                      # Playwright 主链路用例（mock 模式）
├── server/                   # Express API + 编排引擎 + LLM 接入 + SQLite 持久化
│   ├── src/
│   │   ├── routes/           # agents（groups / souls / avatar）/ sessions（members）/ runs / artifacts / …
│   │   ├── orchestration/    # engine（波次循环）/ scheduler（planWave / mergeWaveSchedule）/ parser
│   │   ├── context/          # tokenizer / assembler（L0 协议 + soul 段）/ compressor / memory 服务
│   │   ├── llm/              # provider 抽象 / openai 实现 / mock / resilience / 工厂
│   │   ├── tools/            # 工具注册表 / 内置工具（handoff 支持多目标 fan-out）/ 沙箱守卫（§21）
│   │   └── store/            # db / migrations / sessions（member_souls）/ runs / memory / usage …（SQLite）
│   └── tests/                # 18 套件：parser / scheduler / engine / context / tools / m3–m16 回归…
├── client/                   # React SPA（Vite 代理 /api → 8787）
│   └── src/
│       ├── components/       # layout / sessions（会话列表 / 组队台）/ agents（AgentPicker 等）/ chat（并行组）/ team（图谱）/
│       ├── stores/           # agent（groups）/ session / run（wave）/ task / ws / ui
│       ├── lib/              # api / stream / ws / mentions / graph（图谱推导）/ avatar-icons / export
│       └── pages/            # AgentsDirectory（#/agents 名录页）/ AvatarPreview
├── data/                     # app.db（SQLite）+ logs/ + worktrees/（gitignore）
└── workspace/<sessionId>/    # 交付件工作区（gitignore，§22.1）
```

## 15. 配置（.env）

复制 `.env.example` 为 `.env`（根目录）；**完整环境变量清单与运维说明见 [docs/operations.md](docs/operations.md)**。核心项：

| 变量                       | 默认                        | 说明                                                      |
| -------------------------- | --------------------------- | --------------------------------------------------------- |
| `PORT`                     | 8787                        | 服务端端口                                                |
| `LLM_BASE_URL`             | https://api.deepseek.com/v1 | OpenAI 兼容 Base URL                                      |
| `LLM_API_KEY`              | 空（必填）                  | API Key（未配置且未开 `LLM_MOCK` 时拒绝启动）             |
| `LLM_MODEL`                | deepseek-flash              | 模型名（角色 front-matter 可覆盖）                        |
| `LLM_MOCK`                 | false                       | 脚本化 Mock 开关（仅 E2E / 离线演示，生产勿开）           |
| `CONTEXT_BUDGET_TOKENS`    | 60000                       | 上下文 token 预算（压缩触发线 = ×0.7）                    |
| `MAX_TURNS_PER_RUN`        | 10                          | 单次运行最大回合数                                        |
| `FIRST_TOKEN_TIMEOUT_MS`   | 30000                       | 首 token 超时（配合 `STREAM_IDLE_TIMEOUT_MS` / `TURN_TIMEOUT_MS`）|
| `LLM_MAX_CONCURRENCY`      | 3                           | LLM 并发信号量（超限排队）                                |
| `HANDOFF_MODE`             | auto                        | 转交机制：auto（工具优先，文本回退）/ tool / text         |
| `APPROVAL_MODE`            | risky                       | 审批策略：off / risky（高风险工具）/ all                  |
| `ALLOWED_ROOTS`            | 空                          | 可挂载的项目根目录白名单（逗号分隔，§M6）                 |
| `ALLOW_RUN_COMMAND`        | false                       | 启用 `run_command`（白名单 + worktree cwd + 超时）        |
| `BIND_ALL` / `AUTH_TOKEN`  | false / 空                  | `BIND_ALL=true` 时强制要求 `AUTH_TOKEN`（否则拒绝启动）   |
| `DATA_DIR`                 | data                        | 数据目录（`app.db` / `logs/` / `worktrees/` 均居于其下）  |
| `AGENTS_DIR`               | agents                      | Agent 资产包目录（§25；旧 `PROMPTS_DIR` 兼容回退并告警）  |
| `PARALLEL_MAX`             | 3                           | Run 内并行波次成员上限（=1 关闭并行；场景可覆盖，§29）    |

WS / 通知 / 限流 / 敏感文件策略 / MCP 等其余变量默认即为安全值，按需在 `docs/operations.md` 查表调整。

接入示例：

```bash
# DeepSeek
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-xxx
LLM_MODEL=deepseek-chat

# OpenAI
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini

# 本地 Ollama
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=qwen2.5:14b
```

连通性冒烟：`npm run llm:ping "你好"`。

## 16. 常用脚本

| 命令                      | 说明                                                               |
| ------------------------- | ------------------------------------------------------------------ |
| `npm run dev`             | 并行启动 server（tsx watch）+ client（vite）                       |
| `npm run build`           | 全量构建：server（tsup → dist）+ client（tsc + vite build → dist） |
| `npm start`               | 单端口生产托管（8787，API + 静态资源）                             |
| `npm run test`            | 全量测试（服务端 1174 例 + 客户端 993 例，vitest）                   |
| `npm run typecheck`       | 全仓类型检查（含 e2e tsconfig）                                    |
| `npm run lint`            | ESLint 全仓检查                                                    |
| `npm run eval`            | 评测 32 个 golden 任务 + 与 baseline 对比（回归门禁）              |
| `npm run e2e`             | Playwright 97 条用例 / 42 个 spec（`LLM_MOCK` 模式）                         |
| `npm run migrate:json`    | 旧 JSON 会话一次性导入 SQLite                                      |
| `npm run migrate:agents`  | `prompts/` + `client/public/avatars/` 迁移到 `agents/` 包结构（幂等）|
| `npm run memory:reindex`  | 记忆向量重建：模型 / 维度切换后补账（`-- --force` 丢弃 vec0 镜像重灌、`-- --timeout 秒` 消费上限；断点续跑，M25）|
| `npm run check:agents`    | 校验 `agents/` 全部资产（目录 / 组 / soul / handoff；旧名别名保留）|
| `npm run check:skills`    | 校验 `skills/` 全部 Skill 文档                                     |
| `npm run llm:ping "你好"` | LLM 连通性冒烟（真实模型，需 Key）                                 |
| `npm run avatar:preview`  | 头像预览页（全部角色 × 尺寸 × 状态，§19.5）                        |

生产形态：`npm run build && npm start`，服务端自动托管 `client/dist` 静态资源（单端口 8787）。

## 17. v1 边界

- 默认单用户本地使用：仅监听 `127.0.0.1`；`BIND_ALL=true` 时强制 `AUTH_TOKEN` 并叠加 CORS 白名单与消息接口限流（M7）；LLM 费用与速率依赖自备 API Key；
- 一次 `@` 多人按顺序逐个发言（工具层已并行执行，见 ADR 14）；真·并行发言留待后续；
- 断线不丢任务：Run 与连接解耦（§18.2）——断线后后台继续执行，结果经 WS / 轮询补发，并可用 `/api/runs/:runId/stream` 重新附着；刷新恢复历史（进行中消息保留半截内容并可「继续生成」）；
- 通知中心仅驻内存：服务重启丢「未读提醒」但不丢数据（消息已落盘，§8）；
- 角色形象为内置 AI 生图资产，暂不提供界面内上传自定义形象（§19）；
- 内建研发向工具集与 Skill 加载（§21 / §23）：文件工具限定会话工作区；`run_command` 默认关闭；联网工具（`web_search` / `web_fetch`）不设访问限制（无启用开关与域名白名单，ADR 0136）；不含 RAG / 向量检索；
- 界面仅浅色主题（M11 起移除深色，ADR 27）与固定紧凑布局（§22.5）；不含多租户 / 配额体系与移动端专属布局；
- `model` / `temperature` 已按角色预留覆盖位。

## 18. 异步执行与 WebSocket 通知

### 18.1 背景与通道分工

v1 中 Run 生命周期绑定在发起请求的 SSE 连接上：刷新或关闭页面即中断执行。新需求：**Agent 可异步（后台）执行，完成或需要拍板时通过 WebSocket 主动通知用户**——用户可以切到别的会话继续干活、甚至关掉标签页，团队任务照常推进。

| 通道 | 作用域             | 职责                                          | 数据特征                   |
| ---- | ------------------ | --------------------------------------------- | -------------------------- |
| SSE  | 请求级（跟随单次 Run） | 当前会话逐字流式渲染（`message:delta`）、回合事件 | 高频、严格有序、单写者     |
| WS   | 应用级（全局长连接） | 异步运行生命周期通知、成员状态、未读提醒          | 低频、可重放、多标签页广播 |

原则：**SSE 管线保持不动**（不推翻已验证的 40ms 批缓冲与中断容错）；WS 只传「轻事件」，**绝不携带 token 级 delta**，避免双通道乱序（ADR 11）。

### 18.2 运行与连接解耦（后台执行）

- Run 本体由服务端 engine 持有，SSE 仅是其订阅者：连接断开时按 `RUN_DETACH_ON_DISCONNECT`（默认 `true`）**继续执行**，停止 / 超时逻辑不变；
- 进行中的 Run 可被任意新连接**重附着**：`GET /api/runs/:runId/stream` 先重放已产出内容（内存 streaming 消息快照）再续流；
- 并发后台 Run 上限 `ASYNC_RUN_MAX`（默认 3），超限的新运行请求排队（响应 `{ queued: true }`，轮到时经 WS 通知）；
- **测试替身同样触发全部通知事件**，单测可离线验证「发送 → 离开 → 收通知」完整链路。

### 18.3 服务端 WS 架构

```
http.Server ──▶ WsHub（单例，挂载 /ws）
                 ├─ ConnectionRegistry   连接表 + 心跳（30s ping，2 周期无响应剔除）
                 ├─ SubscriptionMap      Map<sessionId, Set<conn>>
                 ├─ NotificationCenter   每会话环形重放缓冲（200 条）+ 未读游标
                 └─ Replayer             重连补发（按 since 游标）
```

- engine 在各生命周期点调用 `hub.publish(sessionId, NotifyEvent)`；SSE 与 WS 是两个并行的消费端；
- 心跳：服务端 30s 发 `ping`，客户端应答 `pong`；超时连接被剔除并释放全部订阅；
- 通知中心仅驻内存（消息本身已有 §8 落盘保障），重启只丢「未读提醒」不丢数据。

### 18.4 消息协议

统一信封 `{ v: 1, id, type, ts, sessionId?, runId?, payload }`；类型并入 `shared/src/types.ts` 的 `NotifyEvent` 联合（与 `RunEvent` 并列，同为协议单一事实源）。

| 方向 | type                       | 说明                                                         |
| ---- | -------------------------- | ------------------------------------------------------------ |
| C→S  | `subscribe` / `unsubscribe` | 增量订阅会话通知（携带 sessionIds 列表）                     |
| C→S  | `ping` / `ack`             | 心跳；`ack` 上报已读游标（清未读计数）                       |
| S→C  | `notify:run-started`       | Run 开始（runId、发起 agent）                                |
| S→C  | `notify:turn-end`          | 回合结束（agentId、mentions 摘要，驱动面板动画与接力链）     |
| S→C  | `notify:run-completed`     | 正常收尾（reason、最后一条摘要）                             |
| S→C  | `notify:run-error`         | 运行异常（错误文案，前端 toast + 红点）                      |
| S→C  | `notify:awaiting-user`     | `@用户` 交还等拍板（最高优先级，触发系统通知）               |
| S→C  | `notify:agent-status`      | 成员状态流转（idle / speaking / thinking），驱动头像动画激活动效 |
| S→C  | `notify:artifact-updated`  | 交付件新增 / 变更（path、authorAgentId），驱动交付件视图实时刷新 |
| S→C  | `notify:task-updated`      | 任务清单变更（`write_todos` 落盘，M3/M8），驱动右栏「任务」视图刷新 |
| S→C  | `notify:approval-requested` | 审批请求（approval 全量对象；M7/M10）—— SSE 未挂接（如刷新、快模型早发）时前端兜底渲染审批卡 |
| S→C  | `notify:approval-resolved` | 审批已决（approve/reject/custom），多标签页同步状态与 toast |

### 18.5 前端接入（ws-store）

- `lib/ws.ts`：连接管理（指数退避 1s → 2s → … → 30s 无限重试）、心跳应答、断线期间暂存待发订阅；
- `ws-store`：连接态（`connecting | open | closed`）、每会话未读计数、toast 队列、`lastCursor`（重连带 `since` 补发）；
- **页面不可见时加强提醒**：`document.hidden` → 浏览器 Notification API（首次产生后台通知时引导授权）+ 标题闪烁`● 有新的协作动态`+ favicon 切换未读态（`/favicon.svg` ↔ `/favicon-unread.svg`，图标右上角红色通知点）；`notify:awaiting-user` 默认附带提示音（可关）；
- **降级轮询间隔由服务端下发**：`GET /api/health` 返回 `notifyPollMs`（M4），前端不再硬编码；WS 未连通且页面可见时自动轮询。
- 多标签页：各标签独立连接并行订阅；toast 以 `event.id` 去重——同一事件只在一个标签弹完整卡片，其余仅更新未读。

### 18.6 降级与容错

- WS 建连失败或被中间层切断 → 自动降级为 `NOTIFY_POLL_MS`（默认 5s）轮询 `GET /api/notifications?since=<cursor>`（同一 NotificationCenter，语义一致）；
- 重连成功后按 `since` 补发漏掉的通知；超出缓冲窗口仅回 `{ truncated: true }` 提示本次有丢失，不阻塞界面；
- 服务重启后前端靠既有的会话刷新兜底（`refreshActiveSummary`），未读提醒允许丢失。

### 18.7 与既有协议的关系

- `RunEvent`（SSE）= 一次运行的内容流；`NotifyEvent`（WS）= 跨会话的生命周期信号，两者职责不重叠；
- 对**当前正在观看的会话**，SSE 仍是唯一内容来源；`notify:*` 仅用于非当前会话（或前台运行在别的标签页时）的面板与未读更新；
- 两条通道以 `runId + turnIndex` 幂等去重，重复到达不会造成双份渲染或双份 toast。

## 19. 角色形象系统（AI 生图）

### 19.1 设计目标

- **一眼辨人（v2 强化）**：全部业务角色配备专属卡通形象照（v2 批 74 张起、后续批次逐批增补；M69 批 46 张 2026-09-19 落盘——见 §19.3 表尾；`interior` 三角色暂缺、回退渐变占位），靠「年龄 + 性别 + 脸型 + 发色发型 + 眼镜 / 胡须 + 肤色 + 职业道具」七维设定逐一区分（设定表见 §19.3），而非仅靠配色；统一纯白背景，可无缝嵌入任意底色容器；
- **卡通化（v2）**：风格化 3D 卡通（动画电影式渲染）——成人比例（约 1:4 头身，非 Q 版 / 幼态）、五官圆润简化、眼神略夸张、哑光黏土质感、色彩明快；头部占画面高度约 55%，保障 16–96px 小尺寸下的可辨识性；
- **成年团队感**：成年比例半身像，统一构图与柔和棚拍光，人物好看且专业；
- **面孔与命名一致**：西式命名角色（Felix / Ada / Iris / Leo / Max / Nova / Otto…）为欧美面孔，中文命名角色为东亚面孔；肤色、年龄带（24–52 岁）与发色错开；
- **零运行时开销**：静态图片资产（每角色一张 512×512 PNG），任意尺寸 `object-cover` 裁切，无逐帧动画与画布计算。

### 19.2 资产管线

```
agent 包内 avatar.png 自动发现 ──> avatar.image = /api/agents/<id>/avatar（服务端直出 + ETag 缓存）
        │ 命中
        ▼
   <AgentAvatar> 渲染 <img>（object-cover + 内置 25% 等比圆角，16–96px 任意尺寸；ADR 0132）
        │ 未配置 / 加载失败（onError）
        ▼
   回退：gradient 渐变 + lucide icon（ICON_REGISTRY 未命中 → User）
```

- 生成方式：统一提示词模板（同风格前缀：风格化 3D 卡通 / 成人比例 / 同构图 / 同纯白背景 / 同打光 + 各角色七维描述）批量生成，保证「全家福」一致性；
- 新角色接入：生成 1 张 1:1 形象照放 `agents/<场景>/<id>/avatar.png` 即可，无需改代码（自动发现并映射为 `/api/agents/<id>/avatar`）。

### 19.3 角色形象设定表

（v2 全量重设计设定表：生图提示词 = 统一风格前缀 + 本表设定；「面孔」栏与角色命名语言一致——西式命名欧美面孔、中文命名东亚面孔；invest 场景 5 行按 2026-09-17 批次成品观测补录。）

| 场景 · id | 角色 | 年龄 · 面孔 | 发型 · 面部细节 | 服装 | 职业道具 |
| --------- | ---- | ----------- | --------------- | ---- | -------- |
| bi · bi | 沈析 · BI 分析师 | 29 · 东亚女 · 清爽专业 | 黑波浪及肩发，侧分掖耳 | 玫瑰粉西装 + 白衬衫 | 数据看板平板 |
| brainstorm · facilitator | 梅森 · 风暴主持 | 34 · 东亚男 · 圆脸笑纹 | 黑色侧分短发 + 短山羊胡 | 芥末黄开衫 + 浅蓝衬衫 | 粗马克笔 + 便利贴 |
| brainstorm · ideator | 卢娜 · 狂想发散者 | 26 · 拉美裔女 · 雀斑梦眼 | 姜橘色爆炸卷发（不对称） | 珊瑚粉连帽衫 + 白 T | 发光灯泡 |
| brainstorm · challenger | 维克多 · 魔鬼代言人 | 38 · 欧美男 · 瘦削冷峻 | 深灰黑后梳发 + 两鬓灰白 | 酒红西装 + 黑高领 | 红白靶心卡片 |
| brainstorm · refiner | 索菲 · 收敛打磨者 | 29 · 欧美女 · 甜圆脸雀斑 | 栗棕中分低马尾 | 墨绿针织衫 + 白领 | 评分夹板 |
| development · pm | 费利 · 产品经理 | 30 · 欧美男 · 自信温和 | 深棕侧分短发 + 淡胡渣（蓝眼） | 藏青西装 + 白 T | 颈挂通话耳机 + 便利贴卡 |
| development · architect | 艾达 · 架构师 | 33 · 欧美女 · 知性从容 | 赭红低盘发 + 细黑圆框眼镜（绿眼） | 炭灰高领针织衫 | 蓝色蓝图卷 |
| development · designer | 艾瑞 · UI 设计师 | 28 · 欧美女 · 精致时尚 | 铂金波波头 + 品红挑染 + 耳饰 | 白衬衫（卷袖）+ 金项链 | 数位笔 + 色卡扇 |
| development · frontend | 里奥 · 前端工程师 | 25 · 欧美男 · 阳光少年 | 栗棕蓬松卷发 + 鼻梁雀斑 | 青色拉链卫衣 + 白 T | 头戴式耳机（戴上） |
| development · backend | 马克斯 · 后端工程师 | 31 · 欧美男 · 方正沉稳 | 深棕短发 + 短茬胡 | 墨绿衬衫（开领） | 咖啡杯 + 工牌 |
| development · qa | 诺娃 · 测试工程师 | 30 · 欧美女 · 锐利审视 | 棕发高马尾 + 侧扫刘海 | 深灰马甲 + 浅灰长袖 | 放大镜 + 检查清单 |
| development · devops | 奥托 · DevOps 工程师 | 35 · 欧美男 · 可靠老练 | 棕灰短发 + 全络腮胡 | 靛蓝工装夹克 + 深灰 T | 平板（uptime 柱状 + 齿轮） |
| development · ai-engineer | 凌智 · AI 工程师 | 28 · 东亚男 · 清瘦专注 | 黑色短碎发（侧削）+ 银细圆框镜 | 深青连帽衫 + 灰 T | 小机器人头部 |
| development · data-engineer | 宋渠 · 数据工程师 | 32 · 东亚男 · 冷静条理 | 黑色中分微卷发 + 短方盒胡 | 藏青衬衫 + 卡其马甲 | 数据管道图平板 |
| development · security | 沈盾 · 安全工程师 | 35 · 东亚男 · 警觉严肃 | 黑色寸头 + 两鬓微灰，浓眉 | 黑高领 + 深色战术马甲 | 蓝色护盾全息图 |
| development · tech-writer | 简文 · 技术文档工程师 | 27 · 东亚女 · 温润严谨 | 黑长直 + 齐刘海 + 玳瑁圆框镜 | 米白开衫 + 白衬衫 | 厚书 + 钢笔 |
| development · ux-researcher | 闻舒 · 用户研究员 | 30 · 东亚女 · 倾听好奇 | 深棕及颌波波头（掖耳） | 鼠尾草绿西装 + 白 T | 笔记本 + 录音笔 |
| development · ux-writer | 白墨 · 界面文案 | 26 · 东亚女 · 灵动精确 | 黑色高丸子头 + 碎发 | 长春花蓝衬衫 | 平板 + 对话气泡 |
| finance · compliance | 钟律 · 合规官 | 38 · 东亚女 · 沉稳威严 | 黑色法式卷盘发 + 珍珠发饰 | 炭灰立领套装（白饰边） | 皮质规则手册 + 红笔 |
| finance · finance | 周正 · 财务管家 | 42 · 东亚男 · 稳当和蔼 | 黑色侧分短发 + 半月阅读镜 | 灰西装 + 藏青领带 | 财务报表 + 计算器 |
| finance · ip | 乔衡 · 知识产权顾问 | 34 · 东亚男 · 缜密观察 | 黑色后梳中长发 + 金细圆框镜 | 深棕西装 + 米色衬衫 | 证书卷轴 + 火漆印 |
| finance · legal | 卢明 · 法务顾问 | 45 · 东亚男 · 严肃谨慎 | 花白短发（平梳）+ 浓直眉 | 黑色三件套 + 酒红领带 | 卷宗 + 钢笔 |
| finance · tax | 郑清 · 税务顾问 | 36 · 东亚女 · 细致温和 | 黑色低盘髻 + 无框眼镜 | 深蓝西装 + 象牙白衬衫 | 税表 + 计算器 |
| funding · fundraiser | 江源 · 融资顾问 | 39 · 东亚男 · 干练说服 | 黑色短发（前梳微翘） | 午夜蓝西装（免领带） | 路演材料夹 |
| funding · ir | 何洛 · 投资者关系 | 32 · 东亚女 · 从容得体 | 深棕长波浪半扎 + 珍珠耳钉 | 米白西装 + 丝巾 | 沟通简报 + 手机 |
| harness · harness | 知舟 · 总调度 | 35 · 东亚男 · 从容沉着 | 黑色利落短发（清爽侧分） | 深灰西装 + 靛蓝衬衫 + 挂绳工牌 | 节点连线平板 |
| health · fitness | 马骁 · 健身教练 | 33 · 东亚男 · 强壮爽朗（古铜肤） | 黑色寸头 | 青色运动背心 + 毛巾 | 哨子 |
| health · nutrition | 陶然 · 营养师 | 30 · 东亚女 · 圆脸元气 | 黑色编发丸子头 + 木簪 | 鲜绿围裙 + 白 T | 苹果 + 周菜单夹板 |
| health · wellness | 程眠 · 作息顾问 | 27 · 东亚女 · 恬静柔和 | 黑色长侧编发 | 薰衣草家居服 + 白绒开衫 | 洋甘菊马克杯 + 月牙枕 |
| home · chef | 唐味 · 厨房顾问 | 52 · 东亚男 · 圆脸开怀（笑纹） | 花白短发 + 浓眉 | 白厨师帽 + 橙围裙 | 木勺 + 煎锅 |
| home · home | 温居 · 家居管家 | 40 · 东亚女 · 整洁亲切 | 黑色及颌发 + 侧发夹 | 灰绿针织马甲 + 条纹衫 | 折叠毯 + 收纳篮 |
| home · parenting | 苗雨 · 育儿顾问 | 34 · 东亚女 · 温柔包容 | 黑色侧编发 + 碎刘海 | 黄油黄开衫 + 白衬衫 | 绘本 + 玩偶兔 |
| home · pet | 柯萌 · 宠物管家 | 26 · 东亚女 · 灵动雀跃 | 黑色短发齐刘海 + 爪印发夹 | 薄荷绿连帽衫 | 小奶狗 + 牵引绳 |
| invest · invest-lead | 祝衡 · 投研主管 | 47 · 东亚男 · 沉稳掌舵 | 黑色微卷侧分短发（两鬓灰白） | 藏青西装 + 白衬衫 | 趋势线平板 |
| invest · analyst-fa | 秦砚 · 基本面分析师 | 30 · 东亚男 · 严谨温和 | 黑色蓬松侧梳短发 + 金色细圆框眼镜 | 深灰马甲 + 白衬衫 + 浅蓝领带 | 财报册 |
| invest · analyst-ta | 雷动 · 技术面分析师 | 26 · 东亚男 · 锐利自信 | 黑色蓬松凌乱短发 + 浓眉 | 深灰连帽卫衣 | K 线平板 |
| invest · quant | 方程 · 量化策略师 | 32 · 东亚男 · 极客专注 | 深灰黑蓬松微卷发 + 黑框方圆眼镜 | 灰绿工装夹克 + 灰 T | 回测曲线笔记本 |
| invest · analyst-news | 闻笛 · 舆情新闻分析师 | 30 · 东亚女 · 温和敏锐 | 黑色及颌短发（侧分掖耳） | 珊瑚红西装 + 白内搭 | 耳麦（戴上）+ 快讯屏平板 |
| learning · language | 洛语 · 语言陪练 | 25 · 东亚女 · 活泼鼓励 | 深棕高半马尾（波浪） | 浅色牛仔夹克 + 白 T | 语言闪卡 + 气泡 |
| learning · reading | 舒卷 · 阅读搭子 | 30 · 东亚女 · 沉静专注 | 深棕松散波浪低马尾 + 琥珀猫眼镜 | 燕麦米开衫 + 锈红衬衫 | 摊开的精装书 + 书签 |
| learning · tutor | 裴知 · 学习导师 | 45 · 东亚男 · 儒雅耐心 | 黑色短发（两鬓灰白）+ 半月阅读镜 | 棕花呢夹克（肘补丁） | 书 + 红笔 |
| marketing · ads | 冯准 · 投放优化师 | 31 · 东亚男 · 锐利精准 | 黑色短发（侧削）+ 短山羊胡 | 珊瑚红 Polo | 扩音器 + 靶心 |
| marketing · brand | 云舒 · 品牌视觉 | 33 · 东亚女 · 优雅审美 | 黑色长直发（中分）+ 几何耳饰 | 白西装 + 黑上衣 | 色卡扇 + 品牌手册 |
| marketing · content | 林悦 · 内容策划 | 28 · 东亚女 · 灵感专注 | 深棕短波波头 + 空气刘海 | 驼色针织衫 + 粉衬衫 | 内容日历 + 铅笔 |
| marketing · growth | 高扬 · 增长负责人 | 34 · 东亚男 · 雄心实验 | 黑色短发（微乱）+ 淡胡渣 | 森林绿半拉链 + 白 T | 双色试管 + 上升图 |
| marketing · influencer | 米娅 · 红人营销 | 27 · 东亚女 · 星光闪耀 | 栗棕长卷发 + 窗帘刘海（颊痣） | 浅色牛仔夹克 + 白上衣 | 手机 + 环形补光灯 |
| marketing · localizer | 梁语 · 本地化专员 | 29 · 东亚女 · 精准细致 | 黑色中分及肩直发 | 石板蓝衬衫（细格） | 小地球仪 + 术语表 |
| marketing · pr | 颜声 · 公关经理 | 36 · 东亚男 · 从容有度 | 黑色侧分短发（利落鬓角） | 炭灰西装 + 白衬衫 | 采访麦克风 + 报纸 |
| marketing · seo | 韩枫 · 搜索投放 | 30 · 东亚男 · 分析洞察 | 黑色小丸子发髻（侧削）+ 短须 + 细方框镜 | 橄榄卡其军工装 | 笔记本（排名榜）+ 放大镜 |
| marketing · social | 苏晴 · 社媒运营 | 26 · 东亚女 · 元气互动 | 黑色双麻花辫 + 圆发夹 | 天蓝连帽衫 | 手机 + 点赞爱心气泡 |
| marketing · video | 娄映 · 视频编导 | 32 · 东亚男 · 艺术个性 | 黑毛线帽 + 低丸子 + 山羊胡 | 深橄榄编导夹克 | 场记板 + 镜头 |
| ops · assistant | 沐晨 · 行政助理 | 28 · 东亚女 · 高效明亮 | 黑色及肩发（双耳后掖）+ 珍珠夹 + 耳机 | 白衬衫 + 浅灰马甲 | 日程手账 + 咖啡 |
| ops · hr | 许澄 · 人事经理 | 35 · 东亚女 · 温暖可信 | 深棕及肩内扣发（侧分） | 灰粉西装 + 白衬衫 | 人事档案夹（握手标） |
| ops · ops | 齐安 · 运营经理 | 37 · 东亚男 · 条理镇定 | 黑色侧分短发 + 方框眼镜 | 灰蓝工装夹克 + 白衬衫 | 流程看板平板 |
| ops · recruiter | 罗宾 · 招聘外包 | 33 · 东亚男 · 亲和健谈 | 黑色短卷发 | 祖母绿衬衫 | 简历册 + 手机 + 工牌 |
| ops · supply | 何舟 · 供应链 | 40 · 东亚男 · 务实笃定 | 黑色短发（两鬓灰白）+ 八字胡 | 藏青工装衬衫（卷袖） | 比价夹板 + 纸箱 |
| ops · trainer | 段言 · 培训师 | 38 · 东亚男 · 热情表达 | 黑色短发（微卷） | 酒红针织衫 + 白衬衫领 | 翻页笔 + 流程图板 |
| personal · coach | 于清 · 生活教练 | 36 · 东亚女 · 温柔倾听 | 深棕柔软波浪及肩发（掖耳）+ 眼下痣 | 淡紫开衫 + 米色上衣 | 笔记本 + 笔 |
| personal · life-admin | 常乐 · 生活管家 | 31 · 东亚男 · 热心明亮 | 黑色整齐短发 + 细椭圆眼镜 | 浅牛仔衬衫 + 斜挎带 | 钥匙串 + 计划手账 |
| research · lead | 雷蒙 · 研究负责人 | 36 · 欧美男 · 沉稳从容 | 深棕微卷中长发（两鬓灰）+ 短须 | 藏青马甲 + 浅蓝衬衫 | 卷地图 + 黄铜罗盘胸针 |
| research · scout | 切斯特 · 情报检索员 | 27 · 欧美男 · 好奇敏锐 | 深棕卷发（耳后别铅笔）+ 雀斑 | 亮紫夹克 + 灰 T | 双筒望远镜 |
| research · analyst | 安娜 · 交叉分析师 | 31 · 欧美女 · 冷静理性 | 黑色齐肩直发（中分） | 青蓝针织衫 + 白衬衫 | 散点 / 矩阵图表平板 |
| research · verifier | 薇拉 · 事实核查员 | 33 · 欧美女 · 严谨不苟 | 黑色紧低盘发（中分）+ 细黑方框镜 | 藏蓝西装 + 灰衬衫 | 放大镜 + 红色印章 |
| sales · bd | 秦拓 · 商务拓展 | 35 · 东亚男 · 自信成交 | 黑色短发（顶部纹理） | 藏青细条纹西装 + 银领带 | 合作合同 + 拼图块 |
| sales · sales | 陆征 · 销售负责人 | 40 · 东亚男 · 温暖可亲（笑纹） | 黑色中长发（后梳） | 青绿西装 + 开领白衬衫 | 销售曲线手机 + 握手 |
| sales · success | 安然 · 客户成功 | 31 · 东亚女 · 关怀备至 | 黑色及肩发（外翻）+ 银耳环 | 奶油白西装 + 浅蓝衬衫 | 健康度看板平板 + 绿植 |
| sales · support | 夏禾 · 客服 | 24 · 东亚女 · 元气耐心 | 黑色波浪及肩发 + 侧发夹 | 浅绿 Polo + 挂绳 | 客服耳麦 + 气泡卡 |
| sre · sre | 江屿 · SRE 工程师 | 29 · 东亚男 · 警觉专注 | 黑色侧削短发（碎刘海）+ 银耳钉 | 炭灰技术卫衣（青柠饰）+ 挂绳 | 脉冲监控终端 + 值班传呼机 |
| strategy · chief | 柏川 · 幕僚长 | 42 · 东亚男 · 沉稳威严 | 黑色后梳短发（两鬓灰白） | 深炭灰西装 + 黑衬衫 | 皮质笔记本 + 银笔 |
| strategy · insight | 甄明 · 经营分析师 | 33 · 东亚男 · 分析观察 | 黑色中分短发 + 矩形眼镜 | 深蓝衬衫（卷袖） | 数据看板笔记本 + KPI 页 |
| strategy · pricing | 赛琳 · 定价顾问 | 30 · 东亚女 · 精明优雅 | 黑色中分高马尾 + 金耳坠 | 象牙白西装 + 黑上衣 | 天平 + 定价卡扇 |
| strategy · strategist | 顾远 · 商业分析师 | 41 · 东亚男 · 远见深思 | 黑色后梳短发 + 修剪全须 | 驼色大衣 + 深色高领 | 黑棋骑士 + 市场地图 |
| travel · travel | 牧野 · 行程规划师 | 32 · 东亚男 · 阳光冒险（古铜肤） | 黑色微卷中发 + 淡胡渣 | 橄榄绿工装衬衫 + 相机带 | 地图 + 行李箱 + 罗盘 |
| wealth · wealth | 钱程 · 理财顾问 | 35 · 东亚男 · 诚实稳健 | 黑色侧分短发（柔和） | 藏青西装 + 白衬衫 | 存钱罐 + 金币堆 |
| ecommerce · category-scout | 探市 · 选品参谋 | 31 · 东亚女 · 精明利落 | 黑色齐肩直发掖耳 + 细金框眼镜 | 米白针织衫 + 卡其马甲 | 数据图表平板 |
| ecommerce · listing-optimizer | 炼词 · Listing 优化师 | 27 · 东亚女 · 灵巧敏锐 | 深棕蓬松波波头 + 亮橙发夹 | 白 T + 橙色工装围裙 | 大号马克笔 + 词卡 |
| ecommerce · store-operator | 守铺 · 店铺运营 | 35 · 东亚男 · 圆脸和善 | 黑色短碎发 | 深青格纹衬衫 | 卷边排期表 + 对讲机 |
| ecommerce · shop-support | 暖客 · 客服专员 | 24 · 东亚女 · 温暖亲切 | 栗色马尾 + 客服耳麦 | 薄荷绿开衫 + 白衬衫 | 客服耳麦（戴） |
| creator · account-strategist | 立帜 · 账号定位师 | 29 · 东亚女 · 明亮自信 | 黑高马尾 + 品红挑染 | 品红西装外套 + 白上衣 | 小旗子道具 |
| creator · script-writer | 先声 · 脚本写手 | 26 · 东亚男 · 灵动幽默 | 深棕微卷短发 + 圆框眼镜 | 亮黄卫衣 | 场记板 |
| creator · growth-editor | 借风 · 增长编辑 | 30 · 东亚女 · 干练敏锐 | 黑长直侧分 | 深紫衬衫 | 上扬折线图平板 |
| creator · monetizer | 点金 · 商业化顾问 | 33 · 东亚男 · 沉稳精明 | 黑背头 + 无框眼镜 | 深灰西装 + 白衬衫 | 金币小道具 |
| legal-personal · rights-advisor | 持正 · 维权顾问 | 37 · 东亚男 · 方正严肃 | 短寸头 | 深蓝西装 + 白衬衫 | 小天平模型 |
| legal-personal · labor-advisor | 守薪 · 劳动争议顾问 | 32 · 东亚女 · 冷静缜密 | 及肩直发掖耳 | 炭灰职业套装 | 工资条 + 计算器 |
| legal-personal · contract-checker | 审微 · 合同审查 | 34 · 东亚女 · 细腻严谨 | 低马尾 + 细框眼镜 | 米色西装 | 放大镜 + 合同 |
| academic · lit-reviewer | 索隐 · 文献综述员 | 35 · 东亚女 · 学者气质 | 黑长微卷 + 细金属眼镜 | 深青针织衫 | 厚重典籍 |
| academic · methodologist | 定矩 · 研究方法顾问 | 40 · 东亚男 · 严谨沉稳 | 灰白鬓角短发 | 深灰高领 + 西装外套 | 尺规 + 实验记录本 |
| academic · paper-editor | 琢稿 · 学术编辑 | 33 · 东亚女 · 文雅专注 | 棕栗低髻 + 笔簪 | 墨绿衬衫 | 红笔批注稿 |
| academic · submit-advisor | 叩门 · 投稿顾问 | 38 · 东亚男 · 世故热情 | 侧分短发 + 半框眼镜 | 深蓝三件套 | 封蜡信封 |
| relationship · rel-coach | 知言 · 情感顾问 | 31 · 东亚女 · 温和坚定 | 中长直发 + 软围巾 | 暖橘针织连衣裙 | 双手捧心手势 |
| relationship · date-coach | 初见 · 相亲陪练 | 27 · 东亚女 · 甜美清爽 | 齐刘海波波头 | 樱粉针织衫 | 一束小花 |
| relationship · mediator | 居间 · 关系调解 | 36 · 东亚男 · 平和深沉 | 短发文雅 + 笑纹 | 灰蓝衬衫 | 双手平衡手势 |
| trpg · gm-host | 开卷 · GM 主持 | 30 · 东亚男 · 戏剧感强 | 黑发后梳整齐 | 酒红织锦马甲 + 黑衬衫 | 复古话筒 + 骰子 |
| trpg · scenario-writer | 构幕 · 剧本作者 | 29 · 东亚女 · 想象家气质 | 紫黑挑染马尾 | 深紫卫衣 | 剧本卷轴 |
| trpg · npc-player | 入戏 · NPC 扮演 | 33 · 东亚男 · 百变戏骨 | 中分长发束起 | 复古戏服外套 | 戏剧面具 |
| trpg · rule-keeper | 执规 · 规则裁判 | 41 · 东亚男 · 一丝不苟 | 短平头 + 银边眼镜 | 深绿马甲 + 衬衫 | 厚规则书 |
| tarot · tarot-reader | 观照 · 牌阵解读 | 30 · 东亚女 · 神秘沉静 | 黑长发 + 月亮耳饰 | 深紫长袍式上衣 | 塔罗牌扇形 |
| tarot · symbol-narrator | 释象 · 意象叙事 | 28 · 东亚女 · 艺术梦幻 | 卷发 + 星星发饰 | 靛蓝图腾开衫 | 星月挂饰 |
| tarot · tarot-historian | 考源 · 塔罗考据 | 44 · 东亚男 · 学术老练 | 灰发背头 + 圆框眼镜 | 深棕粗花呢西装 | 古籍 + 放大镜 |
| moot-court · plaintiff-counsel | 申言 · 原告代理 | 36 · 东亚男 · 锐利进取 | 短背头 + 无框眼镜 | 深蓝律师袍式西装 | 起诉状卷宗 |
| moot-court · defense-counsel | 析辩 · 被告代理 | 39 · 东亚女 · 沉着机敏 | 低盘发 + 珍珠耳钉 | 炭灰西装裙 | 质证清单 |
| moot-court · presiding-judge | 端衡 · 审判长 | 48 · 东亚男 · 威严公正 | 花白短发 + 浓眉 | 黑色法袍 | 法槌 |
| business-sim · sim-host | 掌局 · 推演主持 | 34 · 东亚男 · 精干操盘 | 黑色短发 | 深蓝商务衬衫 + 领带夹 | 沙盘小城市模型 |
| business-sim · market-referee | 市衡 · 市场裁判 | 37 · 东亚女 · 冷静中立 | 齐肩直发 + 细框眼镜 | 砖红西装 | 行情屏平板 |
| business-sim · review-coach | 温故 · 复盘教练 | 42 · 东亚男 · 长者智慧 | 灰发 + 温和皱纹 | 驼色开衫 | 翻开的复盘笔记 |
| philosophy · socratic-host | 叩问 · 追问主持 | 45 · 东亚男 · 智者诘问 | 银灰卷发 | 深绿粗针织衫 | 茶杯（双手端） |
| philosophy · thought-experimenter | 设境 · 思想实验 | 32 · 东亚女 · 诡思灵动 | 不对称短发 | 石板蓝衬衫 | 水晶球小摆件 |
| philosophy · ethics-moderator | 议善 · 伦理研讨 | 38 · 东亚女 · 端庄理性 | 低马尾 + 丝巾 | 米白西装 | 小天平 |
| travel · visa-advisor | 通境 · 签证顾问 | 35 · 东亚女 · 效率干练 | 短发 | 藏青马甲 + 白衬衫 | 护照 + 印章 |
| travel · local-curator | 寻巷 · 在地体验策划 | 29 · 东亚男 · 探路者活力 | 微卷黑发 | 军绿工装外套 | 地图 + 指南针 |
| wealth · insurance-planner | 保宁 · 保险规划师 | 40 · 东亚男 · 稳健可信 | 短寸 + 方正脸 | 深绿西装 | 盾牌徽章 + 保单 |
| wealth · big-ticket-advisor | 慎衡 · 大额决策顾问 | 43 · 东亚男 · 审慎持重 | 灰发侧分 | 深棕西装 | 计算器 + 购车卡片 |
| funding · valuation-modeler | 衡价 · 估值建模师 | 34 · 东亚女 · 精密冷静 | 直发掖耳 + 无框眼镜 | 深蓝西装 | 估值折线图板 |
| funding · datroom-keeper | 理卷 · 数据室管家 | 31 · 东亚女 · 井井有条 | 低马尾 | 浅灰衬衫 + 工作围裙 | 档案盒阵列 |
| bi · metric-governor | 正尺 · 指标治理官 | 37 · 东亚女 · 严谨校准 | 齐耳短发 + 金丝眼镜 | 墨绿衬衫 | 直尺 + 指标卡 |
| bi · viz-designer | 绘数 · 可视化设计师 | 28 · 东亚女 · 色彩敏锐 | 挑染卷发 + 耳饰 | 玫瑰粉上衣 | 色卡扇 + 图表板 |
| sre · capacity-planner | 度峰 · 容量规划师 | 36 · 东亚男 · 沉稳测算 | 黑色短发 + 无框眼镜 | 深灰工装衬衫 | 容量仪表盘 |
| sre · chaos-officer | 试雷 · 混沌演练官 | 33 · 东亚男 · 冒险气质 | 蓬乱黑发 | 防护马甲 | 故障指示灯 + 扳手 |
| personal · habit-coach | 立习 · 习惯教练 | 30 · 东亚女 · 清朗亲和 | 利落马尾 | 湖蓝卫衣 | 打卡日历卡 |
| ops · license-keeper | 执证 · 证照管家 | 45 · 东亚男 · 老成持重 | 银发整齐 | 深蓝工装夹克 | 证照文件袋 + 印章 |

> 注（2026-09-19 M69 头像批）：上述 46 行按成品观测回溯补录（统一风格前缀 v3：半写实 3D 卡通 / 成人比例约 1:4.5 / 纯白背景 / 哑光质感；同批生成 512×512 落盘）；M51 批 40 角色与 interior 批的形象以成品为准（未入表）。

用户（人类主角）不设头像：界面中不渲染用户形象（消息流、交接条、接力视图均不出现用户头像）。

图片资产位于各 Agent 包内（`agents/<场景>/<id>/avatar.png`，19 场景共 74 张，经 `GET /api/agents/:id/avatar` 直出）；旧版头像备份于 `data/avatar-backup-2026-09-17/`（本仓无 Git，替换不可逆，清理前先确认范围）。生成规格：纯白背景（#ffffff）· 半身像居中（头部占画面高约 55%）· 柔和棚拍光 · 风格化 3D 卡通（成人比例约 1:4 / 五官圆润简化 / 哑光黏土质感），1024px 生成后压缩至 512px 落盘；缺失 / 加载失败回退渐变 + 图标（不影响功能）。

### 19.4 状态与角标

| 状态     | 触发                       | 角标（animated 时）              | 备注                     |
| -------- | -------------------------- | -------------------------------- | ------------------------ |
| idle     | 默认                       | 无                               | 静态形象照               |
| speaking | turn:start → turn:end      | 无（消息气泡打字光标表达）       | 面板同步高亮             |
| thinking | 回合进行中                 | 右上角三点省略号（pa-dot 脉冲）  | 由 SSE / WS 状态驱动     |
| done     | turn:end                   | 右上角星星（pa-star 一次）       | 接棒仪式感               |
| error    | run:error / 回合异常       | 右上角红色闪电（pa-bolt 闪烁）   | 面板同步红点             |

- 角标仅 `animated` 且非 idle 时渲染；`prefers-reduced-motion` 与安静模式（§22.5）下动画自动关闭。

### 19.5 组件 API 与预览

```tsx
<AgentAvatar
  agent={agent}              // 未传 agent 时回退「中性底 + 图标」
  size={16 | 20 | 24 | 38 | 64 | 96}
  state="idle"               // idle | speaking | thinking | done | error
  animated                   // false = 纯图 + 无角标（列表 / 小尺寸场景）
/>
```

- 消息流 / 会话列表 / 职责卡 / 交付件作者标识使用该组件；顶栏品牌区仅文字标题，不带头像；
- 圆角：组件内置 25% 等比圆角（全站统一口径，ADR 0132）——所有头像展示（含 CSS 场景席位 `.scene-sr-avatar` / `.scene-rt-mini-seat`）同一比例；特例形态由调用方 className 覆盖；
- 预览工具 `npm run avatar:preview`：本地页展示「全部角色 × 尺寸 × 状态角标」+ 回退方案演示，改图后刷新即见；
- 旧「程序化像素头像」方案已废弃（辨识度不足），相关代码、测试与 CSS 动画已移除。

## 20. Agent 面板交互增强设计

### 20.1 设计原则

1. **状态即界面**：谁在跑、跑到哪一步、球在谁手里，不看聊天区也能从面板一眼读出；
2. **趣味不打扰**：动效集中在事件发生的一瞬，提供一键「安静模式」全关；
3. **零学习成本**：hover / 单击 / 双击全部沿用通用直觉，不引入需要记忆的复杂手势。

### 20.2 卡片信息架构（升级版）

```
┌────────────────────────────────────┐
│ [形象照·状态角标]  QA 诺娃     ● 待命 │  ← 状态灯（呼吸 / 流光）
│ 测试工程师                           │
│ [用例设计] [边界测试] [回归验证]       │  ← 能力标签（前 3 个）
│ [✦ test-plan]                 [拍一拍] │  ← Skill 徽标 · 拍一拍按钮
└────────────────────────────────────┘
```

### 20.3 交互清单

| 交互       | 行为                                                         | 实现要点                              |
| ---------- | ------------------------------------------------------------ | ------------------------------------- |
| hover 卡片 | 上浮 + 柔和投影（shadow-lift）+ 浮现「@」按钮（M11 起改为常驻 @ 召唤按钮，点击即插入 `@名字 `）                 | CSS transition 300ms                  |
| 单击卡片   | 滑出迷你档案浮层：人设一句话、能力、最近 3 次出手、常用交接对象（M12 已实装：Dialog + 会话消息聚合，最近出手可点击定位） | 复用 agent 定义 + 会话消息聚合        |
| 点击「@」/ 双击 | 插入 `@id ` 到 Composer 并聚焦（复用 `pendingMention` 通道） | 既有闭环，零新通道                    |
| 发言中     | 头像逐帧动画 + 卡片流光描边 + 接力链点亮当前节点                | 由 `agent-status` / `turn:start` 驱动 |
| 转交瞬间   | 接力链视图即时点亮新节点 + 当前卡片流光描边                    | 由 `turn:end.mentions` 驱动（纯 CSS 动效） |
| 拍一拍     | 成员卡「拍一拍」按钮 = 向会话插入轻量提醒「@名字 拍了拍你，继续加油！」 | 走既有插话通道，引擎零改动            |
| 快速切换   | `Alt + 1..9` 切换第 N 个会话                                  | AppLayout 全局快捷键统一监听          |
| 接力链视图 | 面板顶部进度链：已出手打勾 / 队列置灰 / 链尾「你」，当前发言者脉冲高亮（M12 已实装） | 由消息 `mentions` 归约 + run 队列      |
| 指挥台成员条（M11） | Composer 上沿成员 chips：点击插入 `@名字 `；发言者流光高亮、排队序号角标 | 订阅 agent 状态与 run 队列 |
| 一键接棒（M11） | 交接条点击接手者头像 → 插入 `@名字 `；团队面板成员卡「@ 召唤」同通道 | 复用 ui-store.insertToComposer |
| 回到底部（M12） | 上滑离开底部后浮现「↓ N 条新消息 / 回到最新」浮标，点击瞬时回底 | ChatArea 滚动监听 + 消息数基线        |
| 审批快捷键（M12） | 首张挂起卡：`⌘/Ctrl+Enter` 批准（反馈框打开时提交反馈）、`⌘/Ctrl+Backspace` 拒绝；按钮带 kbd 提示 | capture 阶段拦截，避免触发 Composer 的 Enter 发送 |
| 快捷键帮助（M12；Tab 化重设计见 ADR 0143） | `?` 键 / HeaderBar 键盘按钮 / ⌘K 命令面板打开：通用 / 输入框 / 审批卡 / 画布四组页签（一次一组；组内说明块 + 行内适用小字）；指派语义随「输入框」页签 | ui-store.helpOpen + Radix Tabs（ADR 0143） |
| 指挥台排队（M14） | 运行中「指挥台」区显示未出手棒次（序号 + 下一棒高亮），`↑`/`↓` 立即调序（乐观更新，SSE `queue:updated` 对齐） | run-store.reorderQueue + `POST /runs/:runId/queue` |
| 窄屏抽屉（M14） | ≤900px 左右栏折叠为抽屉；底部成员条点成员 chip 插入 `@名字 `（title 提示插入行为），团队开关打开团队抽屉 | AppLayout narrow 分支 + DialogContent.hideClose（避免右上角遮挡列表/面板按钮） |

### 20.4 趣味层

- **完成庆祝**：Run 正常收尾（`reason=completed`）时面板顶部撒一簇彩纸（14 片纯 CSS 动效，约 900ms；安静模式与 reduced-motion 下不触发）；
- **下一棒预告（M11）**：回合间隙在消息流尾部显示「下一棒 · {名字} 正在热身」（成员头像 + 后续排队人数），接力进程在对话区即可读；
- **迷你档案（M12）**：单击成员卡弹出档案浮层——人设一句话、能力/技能、最近 3 次出手（点击定位）、常用交接对象（会话统计，无数据时回退预设路线）；
- **战绩视图（战力榜）**：指标总览六卡（发言 / 交付件 / 被 cue / 工具调用 / 交接 / 完成回合）——除「完成回合」外点击指标卡即切换排行维度（再点恢复综合）；战力榜默认按综合贡献分（发言×10 + 交付×30 + 交接×15 + 工具×5）降序，前三名金银铜徽记、榜首金签 + 皇冠、行内进度条按当前维度归一化，同值并列名次、未出手成员沉底，运行中显示「实时」脉冲标记；「查看本次运行轨迹」入口（打开 Trace 抽屉）；
- **成就徽记**：破冰者（首位发言）/ 交付官（有交付件）/ 人气王（被 cue ≥3 次）/ 主力担当（发言 ≥4 次）/ 接力王（发起交接 ≥3 次）/ 实干家（工具调用 ≥6 次），达成时以 badge-pop 动效展示（chip tooltip 标注达成条件）；未达成者展示最接近解锁的一枚进度（如「主力担当 2/4」+ 还差几次提示）；
- **人味化时间**：卡片底部「刚刚 / 3 分钟前」。

### 20.5 布局与降级

- 右栏顶部改为**分段控件**：`成员 | 接力 | 战绩 | 任务 | 记忆 | 指标` 六视图（默认成员；安静模式开关与 WS 连接状态灯已上移至全局顶栏，见 §42.1），整体仍可拖拽调宽（react-resizable-panels）；
- 小屏（≤900px）：左右栏分别折叠为「会话抽屉」与「团队抽屉」（头部开关 + 底部成员快捷条一键 @）；抽屉内容不占用右上角（`hideClose`），避免遮挡列表头部「新建会话」与团队面板右上按钮（M14 修复）；
- 动效统一 300–400ms、`ease-out`；`prefers-reduced-motion` 或「安静模式」下仅保留状态色变化（不位移、不撒花）。

## 21. 工具系统与 Harness 能力

### 21.1 目标

Agent 从「只会说话」升级为「能动手交付」：在研发场景中通过集成工具读写工作区文件、产出交付件（§22），并具备基础 harness 能力——上下文装配、工具循环、沙箱护栏、任务清单与可观测。

### 21.2 Tool 抽象与执行

```ts
interface AgentTool<P = unknown> {
  name: string                        // 唯一名（模型可见）
  description: string                 // 何时用的能力说明（决定调用时机）
  parameters: JSONSchema              // 参数契约（转 OpenAI tools 协议）
  execute(args: P, ctx: ToolContext): Promise<ToolResult>
}
interface ToolContext { sessionId; runId; agentId; workspaceDir; skills: SkillHandle }
interface ToolResult   { ok: boolean; summary: string; detail?: string; artifacts?: string[] }
```

- **注册表**：`tools/registry.ts` 全量注册；角色 front-matter `tools: [...]` 声明可用清单，引擎按清单过滤（最小权限）；
- **协议**：OpenAI `tools` + `tool_choice: auto`；流式响应中聚合 `tool_calls` 增量 → 逐个执行 → 以 `role: 'tool'` 回灌 → 继续生成（同一回合最多 `MAX_TOOL_STEPS` 步，默认 8）；
- **护栏**：单工具超时 `TOOL_TIMEOUT_MS`（默认 20s）、失败重试 1 次、失败把错误摘要回灌模型自我修正；
- **可观测**：每次调用以 `tool:call / tool:result` SSE 事件广播，消息时间线渲染为可折叠「工具卡」（§21.5）。

### 21.3 内置工具集（首发 8 个）

| 工具 | 能力 | 安全边界 |
| ---- | ---- | -------- |
| `list_dir` | 列出工作区目录（树形） | 限定 workspace 前缀 |
| `read_file` | 读取文件内容（超长截断标记） | 同上；`ARTIFACT_MAX_BYTES` 上限 |
| `write_file` | 新建 / 覆盖交付件（自动建目录） | 同上；写后触发 `artifact:updated` |
| `edit_file` | old/new 精确替换编辑（防误改全量覆写） | 同上；未命中即失败回灌 |
| `search_text` | 内容检索（类 grep，返回 文件:行号） | 同上 |
| `write_todos` | 维护回合内任务清单（规划 + 进度） | 仅内存，随消息展示 |
| `load_skill` | 按需加载 Skill 正文（§23.3） | 仅已注册 Skill 名 |
| `run_command` | 受限命令执行（测试 / 构建等） | **默认关闭**；开启后白名单前缀 + 超时 + 输出截断 |

### 21.4 Harness 基本能力清单（本项目范围）

- 上下文装配：协作协议 + 人设 + Skill 索引 + 工作区文件清单 + 对话窗口（`ChatRequest.system` 装配管线）；
- 回合工具循环（§21.2）+ 步数 / 超时 / 重试护栏；
- 工作区沙箱：路径归一化 + 前缀校验，所有文件工具限定 `workspace/<sessionId>/`；
- 任务规划：`write_todos` 让多步交付可见、可跟踪；
- 可观测：工具卡（时间线）+ 交付件变更事件（§22.4）；
- 复用既有编排护栏：回合上限 / 循环检测 / 停止按钮对工具循环同样生效。

### 21.5 前端呈现

- 时间线内嵌**工具卡**：工具名 icon + 参数摘要 + 状态（运行中 / 成功 / 失败）+ 展开查看 result 摘要；同一回合相邻工具卡聚合成组；
- 消息末尾渲染**交付件 chip**（`message.artifacts`），点击跳转交付件视图定位（§22.4）；
- `run:end` 后工具卡冻结；失败工具卡红边展示错误摘要。

## 22. 交付件与 Workspace

### 22.1 目录约定

```
workspace/<sessionId>/       # 每会话独立工作区（WORKSPACE_DIR 默认 workspace/，gitignore）
├── docs/…                   # 各角色产出的交付件（示例）
└── …
```

- 工作区以**磁盘为唯一真相**（不像消息有内存副本）：交付件扫描直接读盘；
- 删除会话时可选择「连同工作区删除」（默认勾选）；导出会话时附交付件清单；
- 恢复策略：进程重启后工作区原样可用（无需恢复步骤）。

### 22.2 交付件模型

```ts
Artifact { path: string; size: number; mtime: number;
           kind: 'markdown' | 'code' | 'html' | 'chart' | 'data'   // M24：9 类，见 §38
               | 'image' | 'office' | 'pdf' | 'other';
           authorAgentId?: string; updatedAt: string }
```

- `kind` 由扩展名映射（渲染器选择依据）；M24 起为 9 类、由服务端 `classifyKind` 单点决定（见 §38）；
- `authorAgentId` 由工具调用方（写文件的 agent）回填；消息上的 `artifacts: string[]` 随消息持久化，历史会话无需重扫即可渲染 chip。

### 22.3 HTTP API（补充 §9）

- `GET /api/sessions/:id/artifacts`：深度遍历（忽略隐藏文件与 `node_modules`），按 mtime 降序；
- `GET /api/sessions/:id/artifacts/content?path=…`：文本内联返回（≤ `ARTIFACT_MAX_BYTES`，默认 512KB）；`raw=1` 文本原样直出（M24：HTML / PDF 预览 iframe 走浏览器原生解析）；二进制 / 超限走文件流下载；
- `GET /api/sessions/:id/artifacts/preview?path=…`（M24）：Office 轻量解析（docx → HTML / xlsx → 工作表 / pptx → 幻灯片大纲，8MB 上限），见 §38；
- 路径安全：`normalize` 后前缀校验 + 拒绝符号链接逃逸，非法路径返回 `400`。

### 22.4 前端交付件浏览器

- **入口**：聊天区顶部主视图切换「对话 | 交付件 (N)」（N = 文件数，实时更新）；消息内交付件 chip 点击直达；
- **布局**：左文件树（按目录缩进、类型 icon、变更高亮）+ 右预览面板；
- **预览**：Markdown 渲染（react-markdown）、代码高亮（shiki）+ 行号 + 复制按钮、图片直接预览、超限 / 二进制显示下载按钮；M24 扩展到 9 类（HTML 沙箱直出 / 图表 / 表格 / Office / PDF），文本类提供「预览 / 源码 / Diff」三态切换（见 §38）；
- **工具条**：作者头像徽标、更新时间、下载、复制路径、刷新；
- **实时性**：收到 `artifact:updated`（SSE / WS）→ 树局部刷新 + 当前文件若被更新显示「已更新 · 点击重载」提示条；
- **空状态**：引导文案「团队还没有产出交付件 — 试试让 PM 规划一份需求文档」。

### 22.5 组件体系与视觉规范

- **shadcn/ui + Tailwind**：组件复制式落库 `client/src/components/ui/`（无运行时锁定，可完全定制）；采用 Tabs / Card / Tooltip / Badge / ScrollArea / Dialog / Input / Separator / Toast 等；
- **图标**：`lucide-react` 统一线型专业图标（复用 `avatar-icons.ts` 的 `ICON_REGISTRY` 显式注册 + tree-shaking，作头像回退方案）；
- **应用图标（favicon）**：红橙兽面吉祥物（尖角耳上扬 + 白色 V 形面纹 + 锐利双眼，浅色圆角底，32px 原图内嵌 SVG）；基础态 `client/public/favicon.svg`，未读态 `favicon-unread.svg` 为同一图形叠加矢量红色通知点（两态图形完全一致，无换脸跳变）；
- **单主题（仅浅色）**：CSS variables 语义 token 单套定义；M11 起移除深色主题与切换入口（ADR 16 → 24 → 27）；全局固定紧凑布局（消息行距与 Markdown 正文按紧凑基线定义，无密度切换）；
- 动效语言与 §20 一致（300–400ms、ease-out，可降级）。

## 23. Skill 加载机制

### 23.1 概念

Skill = 可复用的领域工作流文档（如「代码评审清单」「接口设计规范」），与角色人设解耦：人设回答「你是谁」，Skill 回答「这类活怎么干」。

### 23.2 目录与格式

```
skills/<name>/SKILL.md     # front-matter 元数据 + 正文流程（可附 assets/）
```

```yaml
---
name: code-review
description: 代码评审清单：当需要审查实现代码质量、风格与安全时使用
tags: [review, quality]
---
（正文：评审步骤、检查清单、输出格式约定…）
```

- 校验：`npm run check:skills`（name 唯一、description 非空、目录名与 name 一致）；
- 热更新：mtime 检测，改完即生效（与 `prompts/` 同机制）。

### 23.3 渐进式披露（Progressive Disclosure）

1. **常驻索引**：系统提示注入 `<available_skills>`（仅 name + description）——模型知道「有什么可用」，但正文不占上下文；
2. **按需加载**：模型判断命中后调用 `load_skill(name)`，引擎把正文作为工具结果注入，同一 Run 内缓存避免重复加载；
3. **预载**：角色 front-matter `skills: [...]` 声明的 Skill 正文直接进系统提示（核心技能不必动态加载）。

### 23.4 与角色的关系

- 角色 front-matter 新增字段：`skills: [code-review]`（可选，预载）与 `tools: [...]`（可选，限定工具白名单，§21.2）；
- `/api/skills` 列表接口供前端「技能库」展示（右栏档案浮层展示成员装载的技能，§20.3）。

## 24. v1 实现纪要（历史存档）

> 本节记录 v1（初版）的落地过程与当时的验收标准，保留作历史参考；当前形态以 §1–§23 与 `docs/`（api / operations / adr）为准。

### 24.0 总览与依赖

```
M1 工程底座 → M2 会话基线 → M3 编排引擎 → M4 工具与交付件 → M5 Skill → M6 异步通知 → M7 头像与面板 → M8 打磨验收
```

- 技术栈定版：React 18 + TypeScript 5 + Vite + Tailwind + **shadcn/ui**（Radix 底座，复制式组件）+ **lucide-react**（专业线型图标）+ zustand + express + ws + vitest；
- **仅浅色主题**：不实现暗黑模式，不保留 `dark:` 分支与主题切换入口（ADR 16）；
- 每里程碑结束时「`typecheck` + `test` 全绿」为硬性门禁。

### 24.1 M1 工程底座（0.5–1 天）

- 初始化 monorepo（root / client / server / shared）与 tsconfig、vitest、eslint/prettier；
- `shared/src/types.ts`：Session / ChatMessage / RunEvent / NotifyEvent / Artifact / ToolCall / SkillMeta（协议单一事实源）；
- server：Express 骨架、`.env` 配置加载、`/api/health`、统一错误中间件（`{ error }` 中文）；
- client：Vite + Tailwind + shadcn init（button / card / tabs / tooltip / badge / scroll-area / dialog / input / separator），lucide-react 接入，**移除 dark 变体**。

验收：`npm run dev` 双端起、`npm run typecheck` 通过、health 返回 LLM 模式。

### 24.2 M2 角色与会话基线（1–2 天）

- `prompts/` 8 份角色文档 + `_protocol.md`；zod 校验 + mtime 热加载 + `check:prompts`；
- PromptLibrary 投影 `/api/agents`；前端三栏骨架 + 会话 CRUD + 消息流（Markdown + remark-mentions）+ Composer @ 补全；
- sessions 存储：内存真相 + 250ms 防抖落盘 + 启动恢复（streaming → stopped）；
- 头像先落像素版静态帧（动画在 M7），保留 lucide 回退。

验收：建会话发消息落盘可恢复；@ 补全键盘交互单测过。

### 24.3 M3 编排引擎与 LLM 接入（2–3 天）

- parser / scheduler / engine / transcript 按 §4–§6 语义实现（含 §6.4 mentions 真实语义、循环检测、收尾兜底）；
- provider 抽象 + openai-compatible（tools 协议留好扩展位）+ 测试替身（pickNext 动态转交、防回环、**脚本化 tool call** 供 M4 交付件闭环）；
- 客户端流式管线：手写 SSE 解析 + 40ms 批缓冲 + run-store 归约 + SystemEvent 转交条；
- 测试：parser / scheduler / prompts / engine 套件（26 例基线）。

验收：测试替身全链演示；真实模型五回合接力自洽。

### 24.4 M4 工具系统与交付件（2–3 天）

- `tools/`：registry + 8 内置工具 + zod 参数校验 + workspace 前缀沙箱（§21.3）；
- tool loop：聚合 `tool_calls` → 执行 → `role:'tool'` 回灌 → 继续（MAX_TOOL_STEPS / 超时 / 失败摘要回灌）；
- 交付件：扫描器 + `message.artifacts` 持久化 + `artifact:updated` 事件 + artifacts API（§22.3）；
- 前端：主区 Tab「对话 / 交付件(N)」：文件树 + 预览（Markdown / shiki 代码高亮 / 图片）+ chip 跳转 + 下载；
- 测试：沙箱逃逸、步数护栏、artifacts API。

验收：测试替身命中关键词触发 `write_file` 产出交付件，前端实时可见。

### 24.5 M5 Skill 机制（1–2 天）

- `skills/` 扫描（SKILL.md front-matter）+ `check:skills` + mtime 热加载 + `/api/skills`；
- 系统提示装配：`<available_skills>` 元数据索引 + 角色 `skills` 预载；`load_skill` 按需注入（同 Run 缓存）；
- 内置示例：code-review / api-design / test-plan。

验收：测试替身演示 load_skill；校验失败路径精确报错。

### 24.6 M6 异步执行与 WebSocket（1–2 天）

- WsHub（订阅 / 心跳 / 环形缓冲 / 重放）+ 通知中心 + `/api/notifications` 降级 + run 解耦与重附着（§18）；
- 前端 `lib/ws.ts` + `ws-store`（未读 / toast / 去重）+ 系统通知 / favicon 角标 / 标题闪烁。

验收：关页后台跑完 → 系统通知；多标签未读一致。

### 24.7 M7 像素头像与面板体验（2 天）

- PixelAvatar（图层矩阵合成 + 5 态 CSS steps 动画 + 调色板扩展 + seed 微扰）+ `avatar:preview`；
- 右栏三视图（成员 / 接力 / 战绩）+ 纸飞机转交 / 接力链 / 成就 / 彩纸 / 安静模式 / Alt+1..9 / 拍一拍（§20）；
- 全站头像替换 + 旧 lucide 回退保留。

验收：五态随事件切换；动效清单过。

### 24.8 M8 打磨与验收（1–2 天）

- 视觉统一（shadcn tokens，仅浅色）、空状态 / 加载态 / toast；
- 测试补齐至约 90 例；§12.2 手工验收全过（含新增交付件 / 工具 / Skill / 后台通知条目）；
- 生产形态：`npm run build` + 单端口 8787 托管验证。

### 24.9 风险与对策

- 真实模型 tool_calls 兼容性差异 → 以 DeepSeek 实测为准，未知字段丢弃、参数校验失败回灌重试；
- 文件沙箱逃逸 → 路径归一化 + 前缀校验单测全覆盖；
- 面板动效性能 → 全部 CSS 驱动，reduced-motion / 安静模式降级。

## 25. Agent 包与场景系统（M15）

### 25.1 单包目录结构

`agents/` 是唯一的 Agent 资产根（取代 `prompts/*.md` 平铺结构，一个版本周期双轨回退）：

```
agents/
├── _protocol.md            # 全局协作协议（注入每个角色的 L0）
├── CHANGELOG.md            # 角色变更记录
├── <场景>/                  # 场景目录 = 分组（目录名即 group id）
│   ├── _group.yaml         # 场景元数据（zod 校验）
│   ├── _protocol.md        # 场景协议（可选，追加在全局协议之后）
│   └── <id>/               # 单包自包含：一个目录装齐角色的一切
│       ├── AGENT.md        # front-matter 元数据 + 人设正文
│       ├── souls/          # 可选：灵魂变体（无 = 无灵魂，行为同现状，§26）
│       │   └── default.md
│       └── avatar.png      # 形象照（自动发现，§19）
```

- **目录即分组**：`group` 由目录名推导写入 `AgentDefinition.group`，不接受 front-matter 手写（防不一致）；id 跨组全局唯一；
- **头像自动发现**：`<agent>/avatar.png` 存在且 front-matter 未写 `avatar.image` 时自动置 `/api/agents/<id>/avatar`；
- 新增一个角色 = 新建一个目录（§13.1），不改引擎代码。

### 25.2 场景 _group.yaml

```yaml
id: brainstorm                       # 目录名一致
name: 头脑风暴                        # 展示名
description: 创意发散与点子打磨：先求量、再收敛，禁止过早评判
icon: lightbulb                      # lucide 图标名
theme: ["#f59e0b", "#fbbf24"]        # 场景主题色（组徽标 / 成员卡描边）
objective: 围绕议题产出可执行的创意方案集
chain: [facilitator, ideator, challenger, refiner]   # 默认接力链（创建会话时据此排序落库）
defaultSkills: [brainstorm-facilitation]             # 可选：场景默认技能
parallel: true                       # 可选：队列头部连续同组成员自动成波（§29）
rounds: true                         # 可选：圆桌模式（交替循环阈值 4 → 6）
parallelMax: 4                       # 可选：场景并行上限（覆盖全局 PARALLEL_MAX）
```

默认值：`parallel: false` / `rounds: false` / `parallelMax: 全局`；研发场景即默认值（行为与 v1 完全一致）。三个内置场景：`development`（研发团队，7 人）、`brainstorm`（头脑风暴 4 人，parallel + rounds）、`research`（深度研究 4 人，parallel）。

### 25.3 加载与校验

- 加载器（`server/src/store/prompts.ts`）：fast-glob 扫描 `agents/*/*/AGENT.md` + 解析组级 `_group.yaml` / 组级 `_protocol.md` / 根级 `_protocol.md`；**目录级 mtime 热更新**（改完即生效，无需重启）；
- `npm run check:agents`：目录结构 / `_group.yaml` schema / id 唯一 / handoff 指向存在 / soul id 唯一与引用有效 / 协议文件；`check:prompts` 保留为别名；
- `npm run migrate:agents`（幂等）：`prompts/*.md` → `agents/development/<id>/AGENT.md`，`client/public/avatars/<id>.png` → 对应包内 `avatar.png`；原目录保留一个版本周期（`--prune` 供后续清理）；
- **兼容回退**：env `AGENTS_DIR`（默认 `agents/`）、旧 `PROMPTS_DIR` 兼容读取并告警；`agents/` 不存在而 `prompts/` 存在时按旧逻辑加载 + 启动告警（安全网）。

### 25.4 协议分层与 L0 装配

系统提示 L0 层装配顺序（会话内稳定，prompt cache 友好）：

```
全局协议（agents/_protocol.md）
  + 场景协议（agents/<场景>/_protocol.md，存在时追加）
  + 角色人设（AGENT.md 正文）
  + 灵魂段（命中时追加，§26.3；含优先级护栏句）
```

场景协议对全局协议是「**追加**」而非覆盖——全局约束（交还判定、防循环、工具纪律）永远生效。

### 25.5 链序统一：participantIds

- 会话链序统一为 **`session.participantIds` 顺序**：创建会话时按所选场景的 `group.chain` 排序落库（跨场景混搭时以选择顺序追加）；`engine.ts` 旧的 `DEFAULT_START_ORDER` 已移除，链序不再有第二事实源；
- 调度器收尾兜底与 `mock.ts` 的 `pickNext` 兜底同步改用 participants 顺序。

### 25.6 API 形状

- `GET /api/agents` → `{ agents, groups }`：agents 附 `group` 字段与 `souls: SoulMeta[]`（id / name / tagline / traits / tone / icon）与 `defaultSoul`；groups 为场景元数据数组（含 icon / theme / chain）；
- `GET /api/agents/:id/avatar`：读该角色包 `avatar.png`（ETag + Cache-Control，404 兜底回退渐变 + 图标）。

## 26. Agent 灵魂层（Soul，M16）

### 26.1 分层模型

| 层 | 载体 | 回答 | 是否必配 |
| --- | --- | --- | --- |
| 协议层 | `_protocol.md`（全局 + 场景） | 怎么协作（最高约束） | 必配 |
| 职责层 | `AGENT.md` | 你是谁、干什么 | 必配 |
| 灵魂层 | `souls/<id>.md` | 怎么说、什么性格 | **可选** |

无 `souls/` 目录的 agent = 无灵魂，行为与 v1 完全一致；同一角色可挂多套灵魂，会话内随时换装（不改文件）。

### 26.2 SOUL 规范

```yaml
---
id: wild
name: 狂野
tagline: 嘴上没门，脑洞没边
icon: flame                        # lucide 图标（前端徽标）
traits: [话痨, 情绪外放, 爱夸张, 行动派]
tone: 热情跳脱，多用感叹句与比喻，爱起外号
quirks: [开口先来一句「兄弟们」, 激动时连发三条短句, 点子停不下来]
---
正文：表达示例、口头禅库、互动偏好与边界（不冒犯、不编造、不降智）。
```

- AGENT.md front-matter 可选 `soul: <soul-id>` 指定默认；未指定时取 `souls/default.md`；
- `check:agents` 校验 soul id 唯一、默认引用存在。

### 26.3 装配优先级与护栏

优先级：**会话覆盖（memberSouls）> 角色默认 `soul` > `souls/default.md` > 无灵魂**；灵魂段固定含护栏句：「*灵魂只影响表达风格与互动方式；你的职责边界、事实准确性与协作规则的优先级更高，不得因风格牺牲准确性。*」——装配顺序 + 提示词护栏双保险。

### 26.4 会话级换装

- `Session.memberSouls?: Record<agentId, soulId>`（sessions 表 `member_souls` JSON 列，追加迁移）；空 = 用角色默认；
- `POST /api/sessions/:id/members` 支持可选 `souls: Record<agentId, soulId>`（邀请时即选风格）；
- `PATCH /api/sessions/:id/members/:agentId` body `{ soul?: string | null }`：切换 / 恢复默认（null = 默认）；校验 soul 归属；切换落 system 消息「诺娃 换上了『亲和』灵魂」；
- 前端 SoulPicker（成员卡徽标点击 → 菜单切换 / 恢复默认）+ 名录页一屏对比各灵魂（tagline / traits）。

### 26.5 首批示例灵魂

| 角色 | 灵魂 | 定位 |
| --- | --- | --- |
| ideator 卢娜 | `wild` 狂野 / `zen` 禅意 / `scholar` 考据派 | 表达风格三极对照（默认 wild） |
| qa 诺娃 | `strict` 铁面 / `friendly` 亲和 | 默认 strict（输出「缺陷计数先行」） |
| facilitator 梅森 | `energetic` 元气主持 | 默认 energetic（「倒计时 3、2、1」） |

其余角色按 `agents/README.md` 指南自建；如需把某风格固化为独立「变体角色」，复制 agent 目录并调整默认 `soul` 即可。

## 27. 会话动态成员（M16）

### 27.1 API

- `POST /api/sessions/:id/members`，body `{ agentIds: string[], souls?: Record<agentId, soulId> }`：添加成员（去重、校验角色存在与 soul 归属、**运行中允许**）；返回 `{ session, message }`；
- `DELETE /api/sessions/:id/members/:agentId`：移除成员；**运行中拒绝（400）**——串行时为当前发言人，并行波次下为波内任一进行中成员；若被拒方在 Run 队列中则移出并广播 `queue:updated`（`removeFromQueue(runId, agentId)`）；会话至少保留 1 名成员；
- `PATCH /api/sessions/:id/members/:agentId`：切换灵魂（§26.4）。

### 27.2 成员事件 system 消息

- `ChatMessage.role` 扩展为 `'user' | 'agent' | 'system'`；成员变更（加入 / 移出 / 换灵魂）写入一条 `role:'system'` 消息（如「费利 邀请了 卢娜 加入协作」「诺娃 换上了『亲和』灵魂」，`agentId` = 涉事成员用于渲染头像，`mentions: []`，`turnIndex: -1`，`status: 'complete'`）；
- **不进 LLM 窗口**：`buildWindow` 过滤 system；engine 既有 `role === 'user'` 匹配天然安全；TypeScript 穷举点（MessageItem 渲染 / MessageActions / 导出 / fork 复制）由 typecheck 驱动补齐分支；会话导出将 system 渲染为分隔行。

### 27.3 运行中语义

- 加人后下一回合 roster 即时生效（assembler / scheduler / toolRuntime 实时读 participantIds），默认不自动发言，前端 toast 提示「@TA 试试」；
- 移除：当前发言人 / 波内进行中成员拒绝（400）；排队成员移出队列；
- 事件接线：`NotifyType` 增 `'notify:members-changed'`（payload：session + message）→ `ws-store` 当前会话 `upsertMessage` + 更新 participantIds，其他会话未读角标；`session-store` 增 `addMembers / removeMember / setMemberSoul`。

## 28. 协作图谱视图（M17 · M21 游戏化）

### 28.1 定位与数据口径

聊天流回答「说了什么」，图谱回答「如何协作」——节点 = 成员 agent（用户不参与形象系统，不绘制用户节点；交接给用户以节点「待你指示」状态呈现），边 = 接力关系与编制预期：

- 新增纯函数 `client/src/lib/graph.ts`：`buildGraph(messages, participants, groups, live)` → nodes / edges；
- **接力实线**：每条 agent 消息的 `mentions` 派生（引擎既有口径：非交还用户时 mentions 即实际接手成员）→ 去重合成边 + 权重（接手次数）与最近时间；
- **编制虚线**：各场景 `group.chain` 相邻对（预期接力链路；与实线同向重合时以实线为准）——跨场景混搭会话按各自场景 chain 叠加；
- 口径标注：会话历史未全量加载（分页 / 压缩窗口）时图上注明「基于最近 N 条消息」。

### 28.2 实时状态叠加（复用现有 RunEvent）

| 状态 | 事件来源 | 呈现 |
| --- | --- | --- |
| 发言中 | `wave:start` / `turn:start`（并行多成员并发） | 节点呼吸光晕 |
| 排队中 | `run:start` / `queue:updated` / `turn:end.queue` | 排队序号徽章 |
| 待你指示 | `turn:end` 交还用户且当前无进行中 Run | 节点「待你指示」浮标 |
| 接力 | `turn:end`（新增 accepted） | 新边入场 + 近期接力高亮 |

零后端改动：无新通道、无新 API。并行波次同层节点同时高亮 + fan-out / fan-in 边流动。

### 28.3 交互与降级

- 入口：TeamPanel「图谱」视图 tab（第 7 视图）+ 全屏浮层（Controls / 图例）；
- 交互：hover 淡化高亮入/出边（CSS 过渡，消除多线重叠处闪烁），「接手 N 次 · 最近时间」标签仅随点选成员 / 悬停边本身出现，点击固定高亮；
- 技术选型（ADR 32）：`@xyflow/react`（React Flow 12+）+ `@dagrejs/dagre` 分层布局；**懒加载独立 chunk**（`React.lazy` + 动态 import），不进入首屏、构建产物门槛不回升；
- 降级：reduced-motion / 安静模式关闭流动与入场动画；首次打开编排入场动画、空态展示编制链预览。

### 28.4 游戏化交互升级（M21，ADR 36）

M17 是「只读拓扑」；M21 在 React Flow 受控模型上做「作战圆桌」游戏化（可拖动 / 双布局 / 能量脉冲 / 导演镜头 / HUD / 档案面板），数据口径与懒加载纪律不变（零后端）：

- **自适应折行赛道**：`layoutGraph` 增 `chainPerRow` 选档（`pickChainPerRow(count, w, h)`；容器尺寸由 ResizeObserver 2px 防抖驱动）——单行适配缩放 ≥ 0.7 保持单行长链（全屏 / 宽容器保留接力语义），否则枚举 perRow 取「适配缩放最大」折行铺网格填满视野；适配缩放统一封顶 1（`FIT_MAX_ZOOM`：初始化 / 切布局 / 整理布局 / 双击空白 / Controls 适配按钮同口径）——小团队窄栏折行单列时不再把节点放大到超原生尺寸，只保证内容完整可见，手动缩放仍可达 2.2；dagre 只负责 (rank, 层内序) 排序，蛇形排布（偶数行左→右、奇数行右→左，折返处上下相邻）。修复窄栏单行内容溢出容器导致节点不可交互的根因（节点渲染尺寸 45px → ~120px）。
- **节点拖拽 + 位置记忆**：受控 nodes + `applyNodeChanges`；拖动终位记入 offsets（视图态，不持久化），布局重算 / 实时事件继续时手动位置优先、拖动中保留 state 位置防抖；「整理布局」清偏移平滑归位；拖动中卡片抬升（`.react-flow__node.dragging`）。
- **双布局**：接力链 ↔ 圆桌（radial + 中心图腾 CoreNode = 场景名 + 在场人数，仅 radial 出现）；切换用节点 style transition + fitView 动画平滑过渡。
- **边视觉语义（线型 × 颜色 × 曲线）**：主路径为平滑贝塞尔曲线（控制点沿出 / 入把手方向外推、行程越长越深；反向接力从节点外侧兜回，取代直角折线，两种布局统一口径）。线型 × 颜色词汇表：实线蓝 = 顺向接力（粗细随接手次数）；实线琥珀 + 光晕 = 最近一棒（`edge.recent`，与节点 recent 描边同源）；长虚线紫 = 回退接力（`layoutGraph.ranks` 判定目标排名在源之前，折行 / 拖动不改语义）；短虚线灰 = 编制预期；能量层颜色随语义（`--edge-color`）；图例随布局切档（回退项仅接力链）。
- **能量边与接力脉冲**：运行中接力边沿方向流动（`--flow-ms` 速度 / 粗细随接手次数）；接力 count 增长（非会话切换）触发边爆发 + 目标节点接收光环——脉冲 nonce 以 state 快照进入渲染依赖，避免 ref 不进依赖导致动画不触发。
- **导演镜头**：跟随当前发言者（无则队首）`setCenter` 平滑居中，全屏默认开启；dock = 布局切换 · 整理布局 · 导演镜头。
- **HUD 战况**：成员 / 接力 / 第 N 波（`run-store` 新增 `waveIndex`，wave:start 归因）/ 队列 / 最新接力（`summarizeGraph` 纯函数）。
- **档案工作面板（GraphInspector）**：点击节点滑出——状态徽章（发言中 / 排队第 N 位 / 待你指示 / 待命）/ 战绩三格（接手 · 交出 · 发言）/ 工作产出（交付件按 `authorAgentId` 归集，点击 `requestArtifact` 跳转交付件浏览器）/ 上下游 chips（点击换人，`neighborsOf`）/ 最近发言（点击定位对话区）/ 操作行：聚焦 · 拍一拍（`lib/agent-actions` 与成员卡共用）· @ 召唤（复用 `insertToComposer`）；节点上另叠加「⚡N」累计接手徽章。
- **悬停稳定化与画布底噪**：边标签不再随悬停节点弹出/收回（仅点选成员 / 悬停边本身时显示），淡化与描边变化全部走 CSS 过渡，消除多线重叠处的瞬时闪烁；**节点引用稳定化**——受控 `setNodes` 重建时，未变化节点复用对象引用、变化节点携带 React Flow 回传的 `measured`（`adoptUserNodes` 仅当引用相等或携带测量值时保留内部节点，否则把节点瞬间置为 `visibility: hidden` → hit-test 消失 → `mouseleave` → 状态回摆 → enter/leave 无限振荡，即悬停闪烁 + 点击失效的根因）；移除 MiniMap（窄栏里是纯底噪）与 React Flow 水印（`proOptions.hideAttribution`），画布只留内容与 dock。
- **降级**：quiet / reduced-motion 关闭流动、脉冲与入场动画；空态保留编制链预览。

### 28.5 交互深化 · 洞察与时间轴回放（M22，ADR 41）

M22 在 M21 游戏化之上做「看得懂、摸得着、回得去」的深化：全部为前端沉浸层（零后端、懒加载 chunk 纪律不变），洞察数据一律由纯函数推导：

- **A1 悬停预览卡（NodePreview）**：有意停留 280ms 才浮现（轻扫而过不弹）；内容 = 状态徽章（与档案面板同口径）+ 最近发言摘要 + 战绩三数（接手 / 交出 / 发言）+ 游离提示；`pointer-events: none` 绝不抢 hover→click 链路（消失仅由节点 `mouseleave` 驱动）；定位按 `rf.getViewport()` 流→屏坐标换算 + 右缘翻转 + 下缘钳制。
- **A2 双击聚焦**：双击节点 = 开档案 + `focusOn` 居中；双击空白 = `fitView` 适配视野（单击保持既有「关面板 / 取消固定」语义）。
- **A3 键盘导航**：新增 `nextNodeInDirection(positions, id, dir)` 纯函数（`lib/graph-layout.ts`；评分 = 主轴距离 + 2 × 垂直偏移，仅取严格正方向候选，无候选停在原地）——方向键沿几何最顺路邻居移动选中并居中；`1` / `2` 切布局、`T` 追踪选中者、`F` 导演镜头；输入框 / 可编辑区聚焦时全量跳过；**Esc 五层收起**：回放 → 追踪 → 固定边 → 全屏 → 选中。
- **A4 点击接力边溯源**：点击边固定「接手 N 次」标签 + 一次性重放流光（replay nonce 快照进渲染依赖，可与 live / burst 三种动画组合叠加）；再点取消。
- **A5 交还用户庆祝**：`awaitingUser` 从无到有 → 全图柔光脉冲（nonce 重放；回放模式下不触发）。
- **B1 接力链追踪（traceFrom）**：从成员出发沿接力边**双向 BFS ≤ 3 跳** → 链路成员集 + 链路边集；非成员降透明、dock 出「追踪 N 位」胶囊（Esc / 点击停止）；追踪口径接管焦点优先级（追踪 > 悬停 > 选中），链路内边为焦点边、其余降透明。
- **B2 游离成员口径（isolated）**：接力发生 ≥ 2 次后仍未接棒者 = 游离——节点虚线呼吸环（发言中不叠加）+ 预览卡 / 档案面板「还没接过棒 · 召唤 TA 加入接力」提示；阈值 ≥ 2 防止新会话全体误报。
- **B3 档案深化（GraphInspector 增量）**：专长 chips（`capabilities` 前 4 + `+N` 计数）、灵魂徽标（会话覆盖 > 角色默认，`activeSoulOf`）、接力链追踪按钮（激活态切「停止追踪」）。
- **C 时间轴回放（GraphReplay）**：以「消息条数」为粒度重建图——`liveMessages → slice(0, index) → buildGraph` 确定性切片，与实时口径永远同构；300ms / 条步进、拖拽定格（自动暂停）、播放到尾自动退出回实时、Esc / 「回到实时」退出；回放期间以 `REPLAY_LIVE` 空快照屏蔽发言 / 队列 / 待办，脉冲基线随模式切换静默重置（进出回放不误爆、回放推进正常触发脉冲）。
- **降级**：quiet / reduced-motion 全量关闭 4 组新动画（隔离环呼吸 / 重放流光 / 浮层入场 / 庆祝柔光）；状态与文案与 M21 面板同口径（`STATUS_LABEL` 复用）。

## 29. 并行波次编排（M16）

### 29.1 模型：回合循环 → 波次循环

Run 内的回合循环升级为**波次（Wave）循环**：每波 1..N 位成员，波内成员并行执行（各自装配 → 流式生成 → 工具循环 → 产出调度提议），波末统一 fan-in 收敛出下一波。**N=1 即原串行**——默认路径行为与 v1 完全一致（串行 = 单波特例）。

### 29.2 触发规则（取并集；均不满足 = 串行）

1. 用户消息 @ ≥2 位在场成员 → 首波并行（最多 `parallelMax` 人）；
2. 某成员 handoff 工具给出多目标（`target: string | string[]`，≤4；`user` 仅允许单独使用）→ 下一波并行；
3. 队列头部连续成员同属某个 `parallel: true` 的场景 → 自动成波（研发场景默认 false）。

配置：`PARALLEL_MAX`（env，默认 3；=1 关闭并行）、`_group.yaml` 的 `parallel` / `rounds` / `parallelMax`（场景覆盖）；`maxTurnsPerRun` 语义 = 最大波数（波内人数不额外占配额）。

### 29.3 隔离与收敛

- **planWave / mergeWaveSchedule**（`scheduler.ts` 两个纯函数）：`planWave(queue, session, opts)` 定波成员；`decideHandoff()` 单成员提议裁决（参与者过滤 / 自续抑制 / 重复剔除）；`mergeWaveSchedule()` 波次合并（按波内顺序收集 accepted 去重 → 下一波队列；**交还用户仅当全员交还 / 被抑制**）；fallback 每 Run 一次不变；
- **全波先建消息**：波启动时为全员统一 `appendMessage`（streaming 空消息、seq 连续）并登记 spoken——波内消息相邻、seq 单调；**`turnIndex` 语义升级为波次号**（同波消息共享）；
- **上下文隔离**：`prepareTurn` 的排除项为 `excludeMessageIds`（波内全部消息）——同波成员互相看不到对方当前输出，统一基于波前历史；`buildTurnInstruction` 增并行上下文行「本波并行成员：X、Y（你们同时工作、各自独立输出，完成后统一汇总）」；
- **handoff 回合级缓冲**：`record.pendingHandoffs` 按消息 id 分组收集，回合末只消费本回合的目标（避免并行波内成员交错取走彼此转交）；
- **循环检测升级**：输入改为**波次签名序列**（签名 = 波成员排序拼接、并行波带 `+`）——两人交替 / 单人连续判定基于签名；`rounds` 场景交替阈值放宽 4 → 6；内容级循环按「每波串联文本」相邻比较（避免同波正常相似被误判）；
- **压缩并发护栏**：波内多成员可能同时触发上下文压缩——`ContextService` 压缩入口会话级互斥 + 同水位幂等（先到者压缩、后到者复用结果并跳过重复广播）；
- **失败语义**：任一成员 stopped → 整波中止（共享 AbortController）；任一成员 timeout/error → 终止 Run；**审批按成员粒度挂起**（波内其他成员不受阻，多个审批卡并排呈现）；
- **已知限制（协议兜底）**：波内成员共享 `record.todos`（并发改写按最后写入生效）与工作区——协议提示成员分工、避免同波写同一文件，不做文件锁。

### 29.4 事件与前端

- 新增 SSE 事件 `wave:start`（`{ runId; sessionId; waveIndex; members: string[] }`；串行波也发、members 长度 1，前端统一处理）；`turn:start` / `turn:end` 保持成员粒度（并行时多个并发）；波次合并后的队列广播复用 `queue:updated`；`run:start.queue` = 首波成员；
- **聊天流并行组**：`同 runId + 同 turnIndex 连续 ≥2 条` agent 消息包一层「并行协作组」容器（组头：成员头像 chips + 「∥ 并行」+ 完成进度 N/M；组内各消息独立流式；单条波次渲染完全不变；组头可折叠；会话导出渲染为顺序条目并标注「（并行）」）；
- 运行状态条 / 指挥台同时显示多位发言中成员；停止 = 停整波（abort 广播已支持）；图谱视图并行波次同层高亮 + fan-out / fan-in 边流动；
- `run-store` 新增 `wave:start` 归约（记录 currentWave 成员）+ `queue:updated`  幂等对齐；持久化快照（queue / spoken / turnIndex）语义不变，`resume` 恢复后按正常波次规划继续；`attach` 快照重放对并行多流天然支持（切换会话 / 刷新后多流恢复）；旧串行数据兼容。

## 30. Markdown 渲染扩展（M19）

消息与交付件的 Markdown 管线在 GFM + shiki 白名单（§10.8）之上扩展：容器语法（分栏 / callout / details）、图表代码块（mermaid / chart）、代码块工具条、图片灯箱与表格滚动，以及 TurnCard（agent 消息卡）展示升级。决策与被否决方案见 ADR 34；流式纪律延续（ADR 9）：流式期间代码块与图表一律纯文本，完成态才高亮 / 渲染。

### 30.1 管道与容器语法

- 渲染入口保持 react-markdown v9；`remarkPlugins = [remarkGfm, remarkContainers, remarkCodeMeta, [remarkMentions, { names }]]`——**必须传 attacher 工厂函数本身**，传入已实例化 transformer 会被 unified 当作 attacher 调用而崩溃；
- 容器语法（`md-ext/remark-ext.ts`，自写解析器）：

| 语法 | 渲染 | 说明 |
| --- | --- | --- |
| `::: cols [2..4] [标题]` | `.md-cols` 网格（auto-fit minmax 240px） | 列数缺省自适应 |
| `::: col [标题]` | `.md-col` + `data-title`（CSS ::before 呈现列标题） | 位于 cols 内 |
| `::: tip/info/note/success/warning/danger [标题]` | CalloutCard 六变体（lucide 图标 + HSL 变量色板） | 缺省标题：提示 / 信息 / 笔记 / 成功 / 注意 / 危险 |
| `::: details 标题` | 原生 details/summary（正文 `.md-details-body`） | 默认折叠 |

- **兄弟节点级栈式解析**：`walk(parent)` 内维护 out/stack/buffer——纯文本段落含 `:::` 时逐行驱动栈（OPEN_RE / CLOSE_RE），非纯文本块级节点（列表 / 表格 / 代码块 / 嵌套容器）在栈非空时收进当前容器（跨空行正确归属）；MAX_DEPTH=8；
- **fail-safe**：未闭合容器收尾展开保内容（callout / col 拆壳、details 去 summary）；未知容器名整段保持原文；游离闭标记不吞后续内容；无标记时原树原样返回（不重建节点身份）。

### 30.2 图表代码块

`PreBlock` 按语言路由：`mermaid` → MermaidBlock；`chart` / `echarts` → ChartBlock；其余 → CodeBlock。

- **mermaid**（`lib/mermaid.ts`）：`import('mermaid/dist/mermaid.min.js?url')` 拿资源 URL，运行时注入 `<script>` 懒加载——**必须经典脚本注入**：esbuild IIFE 依赖全局作用域 var（`globalThis.__esbuild_esm_mermaid_nm[...]`），`import()` 在模块作用域下会报 `Cannot read properties of undefined (reading 'mermaid')`（实测验证）；`globalThis.mermaid` 单例 initialize（theme base + 蓝色主题变量、securityLevel strict、字体对齐）；`renderMermaid(code)` 同源码命中 mermaidCache（上限 100），失败向上抛 → 错误卡 + 自动展开源码；工具条：源码开关 / 全屏（Overlay）/ 复制；
- **chart**（`lib/chart-spec.ts` 纯解析 + `lib/chart.ts` 运行时）：解析与渲染分离——`parseChartSpec`（零依赖，主包内）校验 JSON schema 并输出可读中文错误；echarts 运行时随 `import()` 懒 chunk（静态命名导入 `echarts/core` + Bar/Line/Pie/Scatter + Grid/Legend/Title/Tooltip + CanvasRenderer，精确 tree-shake；566KB / gzip 194KB）；schema：

```json
{ "type": "bar|line|area|pie|scatter", "title": "各端预算", "labels": ["Web","iOS"],
  "series": [{ "name": "预算", "data": [12, 8] }] }
```

  兼容 `[x,y]` 点对 / `{value,name}` / 顶层 `data` 简写；`horizontal` / `stacked` 布尔位；ResizeObserver 自适应（jsdom 守卫）；失败态错误卡 + 源码回退。

### 30.3 代码块与阅读增强

- **meta 扩展**（`remarkCodeMeta`）：```` ```ts title="app.ts" {2,5-7} ```` → hProperties `data-title` / `data-lines`；`parseCodeMeta` 支持三种引号形态与 `{n,m-k}` 行号范围；
- **代码块工具条**：文件名（FileCode2 图标）+ 语言 + 行数 + 复制（clipboard → execCommand 回退，1.6s 状态复位）；shiki line transformer 输出 `.hl-line`（inline-block 满行宽 + 底色）；> 24 行折叠（max-height 280px + 渐隐 + 「展开全部 / 收起」）；高亮缓存上限 100；
- **图片灯箱**：img → ZoomableImage（span role=button + tabIndex，点击开 Overlay；createPortal 到 body 脱离消息卡层叠上下文；Esc / 遮罩点击关闭；body 滚动锁）；
- **表格**：table → `.md-table-wrap`（overflow-x: auto）宽表横向滚动。

### 30.4 TurnCard 展示优化（MessageItem）

- **组色主题条**：agent 消息按 `agent.group` 命中 `group.theme` 双色渐变左缘条（`data-turn-accent = theme[0]` 供测试与调试）；
- **头部徽章**：角色胶囊（`turn-role`）+ 波次徽章（`turnIndex ≥ 0` 显示「第 N 波」，title 注明本轮第 N 波发言）；
- **流式进度线**：运行中卡片顶部 turn-sweep 扫光（CSS 动画，完成后移除；reduced-motion / 安静模式关闭）；
- **操作显现**：MessageActions hover / focus-within 淡入，窄屏（max-md）常显；状态边框：error → destructive/40、stopped → amber-500/40。

### 30.5 包体与验证

- mermaid 12 ESM 入口会拆 60+ 懒 chunk（diagram / elk / cytoscape / katex），击穿产物门槛 → 采用单文件 bundle（1 个产物文件，5.3MB 懒加载）；echarts 566KB 懒 chunk；新增 md-vendor（react-markdown 生态 170KB / gzip 52.8KB）；
- **实测**：产物 48 文件（≤ 50）、主包 gzip 109.7KB（≤ 150KB）；
- 测试：`client/tests/markdown-ext.test.tsx` 25 例（纯函数 / 容器 7 / 代码块 3 / mermaid 4（mock）/ chart 4（mock）/ 灯箱表格 2 / TurnCard 3）；E2E `markdown-ext.spec.ts` 2 条（真实浏览器 mermaid / echarts 懒加载渲染与 TurnCard 徽章；虚拟列表滚顶策略规避消息 DOM 卸载）。

## 31. OPC 业务场景与角色编制（M21）

研发视角之外，一人公司（OPC）需要覆盖经营 / 市场 / 销售 / 财务 / 运营 / 融资的全职能协作。M21 在既有 3 场景 15 角色之上新增 6 个业务场景共 19 个角色（合计 9 场景 34 角色），全部走「资产即数据」路径：只增删 `agents/` 与 `skills/` 文件，零代码改动。决策与被否决方案见 ADR 37。

### 31.1 场景编制

| order | 场景 | 成员（chain） | 特性 |
| --- | --- | --- | --- |
| 5 | strategy 商业战略 | chief 幕僚长 → strategist 商业分析 → pricing 定价顾问 | rounds: true（多轮研讨）、场景协议（例会纪律） |
| 40 | marketing 市场增长 | growth 增长 → content 内容 → seo 搜索投放 → brand 品牌 | parallel: true / parallelMax: 3 / defaultSkills: [content-marketing] |
| 50 | sales 销售客户 | sales 销售 → success 客户成功 → support 客服 | 串行 |
| 60 | finance 财务法务 | finance 财务 → tax 税务 → legal 法务 | 串行、场景协议（合规红线） |
| 70 | ops 运营行政 | ops 运营 → assistant 行政 → recruiter 招聘 → supply 供应链 | 串行 |
| 80 | funding 融资资本 | fundraiser 融资顾问 → ir 投资者关系 | 串行 |

- 19 个角色沿用四段骨架（职责 / 工作方式 / 交付契约 / 协作接口），交付件统一 `docs/<文档类型>-<主题>.md`（经营简报 / 商业分析 / 定价方案 / 增长方案 / 内容日历 / 搜索投放 / 品牌规范 / 销售话术 / 客户成功 / 客服手册 / 财务测算 / 税务清单 / 合同审阅 / 运营SOP / 会议纪要 / 招聘方案 / 供应链方案 / 融资材料 / 投资人简报），与 mock 剧本、评测基线三方对齐；
- `handoff` 按「同场景接力链 + 跨场景协作」逐角色写定（如 chief → 各场景收敛者；pricing ↔ finance；legal ↔ sales）；
- 灵魂 4 个：chief 谋士 advisor / 管家 steward，content 灵感 muse / 数据 data；
- 技能 4 个：business-review（经营例会手册）、content-marketing（内容战役手册，marketing 场景预载）、financial-modeling（财务测算手册，finance / tax / pricing 预载）、contract-review（合同审阅手册，legal 预载）。

### 31.2 协议增补

全局 `_protocol.md <tool_policy>` 新增四条业务纪律：金额 / 比例 / 利率必须 `calc`（禁止心算）；日期与排期必须 `date_calc`；表格数据必须 `csv_analyze`（禁止目测汇总）；合同 / 报价 / 邮件等批量文档走 `template_fill`。

场景协议：`strategy/_protocol.md` 例会纪律（数字口径以 finance 为准；方案必须带成本与优先级；决策记录留痕）；`finance/_protocol.md` 合规红线（不背书法律意见；风险三级标注；敏感信息不外发；不臆造法规条款）。

### 31.3 头像与验证

- 19 张 `avatar.png` 沿用统一提示词模板批次生成（纯白底 / 3D 卡通电影质感 / 半身像 + 角色道具，512×512），个别失败自动回退 front-matter 的 gradient + icon，不阻塞；
- 验证：`npm run check:agents`（9 场景 / 34 角色 / 灵魂 / 协议 / 预设清单全通过）；`server/tests/m21.test.ts` 12 例（场景顺序、角色加载、场景协议、validate、presets 解析与非法成员报错）。

## 32. 业务工具集（M21）

业务场景的确定性要求：金额与比例不能心算、日期与排期不能估、表格不能目测汇总、批量文档不能手抄。M21 新增 4 个业务工具（零新增 npm 依赖），注册进 `createToolRegistry`；安全边界与选型见 ADR 38。

### 32.1 工具清单

| 工具 | 类型 | 入参 | 行为 |
| --- | --- | --- | --- |
| `calc` | readOnly | `{ expression }` | 自写 tokenizer + Pratt parser（禁止 eval / new Function）；四则 / 乘方 / 括号 + 函数表 20+（round/min/max/sum/avg、pct_change、gross_margin、markup、discount、cagr、compound、loan_payment、npv、irr（二分法）、roi、roas、cac、ltv、breakeven、net_after_tax）；错误中文化（函数报错附用法签名，便于按签名纠正），detail 分步展示求值过程 |
| `date_calc` | readOnly | `{ base?, op: add\|diff\|list\|period, amount?, unit?, to?, interval?, count?, skip_weekends? }` | add（day/week/month/year/business-day）、diff（自然日 + 工作日）、list（N 个排期日，可跳周末）、period（周 / 月 / 季 / 年起止，财务口径）；输出 ISO + 中文 + 星期 |
| `csv_analyze` | readOnly | `{ path, op: head\|describe\|groupby\|sort\|filter, column?, by?, agg?, where?, order?, limit?, columns? }` | 自写 RFC4180 子集解析（引号 / CRLF、.csv/.tsv 嗅探）；head / describe（列类型 / 空值 / 唯一值 / 数值统计）/ groupby / sort / filter（`列 操作符 值`，含 `~` 包含）；detail 返回 Markdown 表格（≤ 50 行） |
| `template_fill` | 写类 | `{ template, data, output, dry_run? }` | 工作区模板 `{{dot.path}}` 占位渲染 → 原子写；缺失变量汇总为错误清单（不静默）；dry_run 返回渲染预览（截断 2KB）不落盘；成功标记 artifacts |

- 沙箱纪律复用：`resolveInRoot` + `sensitiveRejection` + 5MB 体积上限；readOnly 三件套可进只读并行组；
- 协议纪律（§31.2）把「何时必须用」写进全局协议，工具白名单按角色最小授权。

### 32.2 验证

`server/tests/business-tools.test.ts` 24 例（正常 / 异常 / 安全路径 / 白名单过滤）；既有 `tools.test.ts` 不回归。

## 33. 业务 Markdown 卡（M21）

在 §30 容器体系之上新增 4 个业务容器（纯前端渲染、零后端改动），延续栈式解析 / fail-safe / 流式纪律（轻结构容器流式期间直接渲染）。决策见 ADR 39。

| 语法 | 用途 | 渲染与交互 |
| --- | --- | --- |
| `::: kpi [标题]`，条目 `- 名称 \| 值 \| 变化 \| 目标` | 经营 / 增长指标快照 | 数值卡组；涨跌色（+ 绿 / − 红）；有目标时进度条；点击数值复制；hover 显示原始行 |
| `::: timeline [标题]`，条目 `- 日期 \| 事项 \| 负责人` | 内容日历 / 发布排期 | 竖向时间轴；日期 chip + 负责人 chip；「今天」高亮（2026-07-01 / 07-01 / 7月1日 三形态） |
| `::: mail [主题]` + `收件人:/抄送:/主题:` 头部行 + 正文 | 客户跟进 / 通知草稿 | 邮件卡（字段块 + 正文）+ 「复制正文」（CopyButton，1.6s 状态复位） |
| `::: option [推荐\|备选\|否决\|待定] 标题` | 方案对比 / 决策纪要 | 方案卡 + 状态徽标（绿 / 蓝 / 红 / 灰）；未知状态降级中性标题卡 |

- 实现：`remark-ext.ts` 4 个 builder + finalize 结构化转换（kpi / timeline 列表项 → `data-*` 节点、mail 头部 → 字段节点、option 解析状态参数）；`Markdown.tsx` 按 `data-kpi / data-timeline / data-mail / data-option` 路由到 KpiGroup / Timeline / MailCard / OptionCard；`index.css` 约 200 行（卡组网格 / 涨跌色 HSL 变量 / 进度条 / 时间轴线 / 邮件头 / 徽标色）；
- fail-safe 与既有容器同构：未闭合展开保内容 / 未知容器保持原文 / 游离闭标记不误吞 / MAX_DEPTH 8；
- 测试：`client/tests/markdown-ext.test.tsx` 扩展 16 例（每容器解析 + fail-safe + mail 复制交互，现共 41 例）；E2E `m21-opc.spec.ts` 断言 KPI 卡（财务测算）/ timeline「今天」高亮 / option 推荐卡。
- 包体实测（M21 后）：产物 48 文件（≤ 50）、主包 gzip 124.0KB（≤ 150KB），零新增依赖。

## 34. 快速组队与建会话交互（M21）

真实高频任务是跨场景组队（周经营例会 / 内容战役 / 报税 / 融资），手动逐个挑人繁琐。M21 将「编制模板」资产化，并把建会话入口升级为「快速组队优先」。决策见 ADR 40。

### 34.1 预设资产 `agents/_presets.yaml`

6 条跨场景编制（id / name / description / icon / theme / members / prompt 开场指令模板 / order）：weekly-review 周经营例会（chief + finance + growth + sales）、content-campaign 内容营销战役（growth + content + seo + brand）、product-launch 产品发布冲刺（pm + growth + content + devops）、tax-season 报税合规检查（finance + tax + legal）、funding-round 融资冲刺（fundraiser + finance + ir + legal）、hiring-outsourcing 外包与招聘（recruiter + ops + legal）。

数据链路：loader 解析 + zod 校验（成员必须存在、id 唯一、members 非空）→ `collectFiles` 纳入热更新 → `validate()` 校验 → `GET /api/agents` 响应增加 `presets` → `client/src/stores/agent-store.ts`；`check:agents` 打印预设清单；文件缺失时整体为空数组（UI 自动隐藏）。

### 34.2 建会话对话框（三步流 Step 0）

> **M50 修订（ADR 0102）**：本节的两步向导交互（Step 0 选场景 → Step 1 配成员 + `重选场景`）已被 §59「建会话组队台」取代；下方资产语义（preset 预选 / 草稿键 / 原文案锚点）与 `pendingCreate` 通道原样保留。

- 顶部「快速组队」区：preset 卡片（icon + 名称 + 一句话 + 成员头像堆叠 + N 人）→ 点击进 Step 1（成员按 preset 预选、可微调），显示来源与「开场指令将预填」折叠预览；
- 下方「按场景组队」区：9 张场景卡（按钮语义与文案不变，既有 E2E 断言兼容）+「自由组合」入口；
- 创建成功：`preset.prompt` 写入 Composer 草稿键 `ma:draft:<sessionId>`（与 Composer draftKey 一致，避免切换竞态）→ toast「已预填开场指令」；
- Command Palette 新增「新建会话」分组（6 preset + 9 场景），经 `ui-store` 的 `pendingCreate` 状态预选打开对话框。

### 34.3 验证

client `tests/opc-frontend.test.tsx` 9 例（preset 预选 / 草稿预填 / palette 项）；E2E `m21-opc.spec.ts` 2 条（周经营例会：preset 建会 → 并行汇报 → KPI / option 卡 → 4 交付件；内容战役：timeline 卡 → 4 交付件）；presets 缺失时 UI 自动隐藏该区块。

## 35. 连接中心与操作直播（M22）

M22 把 Agent 的能力面从工作区文件扩展到「真实系统」：数据库（MySQL / PostgreSQL / SQLite）与浏览器（CDP），并让这两个面的操作在界面上「看得见、可接管、可回溯」。决策与被否决方案见 ADR 42 / 43。

管理入口（M26 控制台收敛）：连接清单与操作流水自右栏「连接」分段迁至左侧 rail「连接管理」视图（`appView='connections'`，见 §42.1）——连接是全局资源（不随会话切换）：「绑定」仍按会话隔离，右栏保留「浏览器」面板（实时控制中心；M49 起并入「实况」面板为浏览器面，见 §58.1）。终端 / 数据库工作台 / 直播窗空态跳转统一改为切控制台视图。

### 35.1 连接中心（服务端）

- 五表（v4 迁移，幂等）：`connections` / `session_connections` / `audit_log` / `browser_sessions` / `browser_steps`；
- 凭据：AES-256-GCM，密文 `v1:` 前缀 + 独立 `secrets.key`；对外只回 `secretSet`；解密失败静默 undefined（换钥不炸历史行）；
- 最小权限：会话绑定（`/api/sessions/:id/connections`），Agent 工具 `requireBinding: true`，未绑定直接拒绝并提示可用清单；
- SQL 护栏（纯函数 `connections/db/guard.ts`）：单语句 + 只读白名单（SELECT / WITH / EXPLAIN / PRAGMA / SHOW）+ 注释与字符串剥离 + 骨架兜底（data-modifying CTE / SELECT INTO / PRAGMA 赋值与括号赋值形式；危险关键字大小写不敏感；MySQL / MariaDB 可执行注释 `/*!` `/*M!` 内容按代码分析）；`mode='query'` 恒按只读执行（只读事务 / 驱动层拒绝，纵深防御——见 ADR 52）；
- 三连接器：sqlite（`node:sqlite` 零依赖）/ postgres / mysql（动态 import 驱动，未装驱动不阻塞启动）；管理器统一 execute / probe / closeAll + 审计落库；
- API：`/api/connections`（CRUD + test）、`/api/sessions/:id/connections`（绑定）、`/api/audit`（回放）、`/api/browser/*`（会话 / 步骤 / 截图 / 输入 / 接管）。

### 35.2 CDP 浏览器接入

- 三后端：managed（拉起本机 Chrome + 临时 Profile，缺省无头）/ local（优先复用本机实例，否则按专用持久 Profile 自启）/ remote（已有调试端点）；启动形态三源决策链：面板 / 接口显式参数 → 连接 `config.headless` → `BROWSER_HEADLESS`（默认无头；`local` 已有实例存活时沿用其实例形态）；
- BrowserRuntime：步骤记录（seq / actor / action / ok / durationMs / screenshotPath）+ 实时 `notify:op`；人工接管期间 Agent 动作挂起为「等待人工」；
- 页面跟随（多标签页，ADR 51）：Target 发现感知全部页面；当前管理页打开的新页（opener 链）与空白页的真实导航自动接管（切换 = 停旧帧流 + attach 新页 + 重开采集 + `switch_page` 步骤）；管理页关闭回退剩余页；页面级事件按 sessionId 过滤，切换只在动作边界（busy / settle 状态机）；
- 帧流：`/ws/stream` 独立通道 + token 分权（watch 可复用 / takeover 一次性）；服务端节流（5/12/24fps）+ 合并 + 背压丢帧；截图落盘经 `/api/browser/screenshots/...` 懒加载；
- 前端右栏「浏览器」面板 = 控制中心（M49 起为实况·浏览器面，见 §58.1）：接入方式三选一（空态卡片）/ 启动形态切换（无头 / 打开窗口）/ chrome 条（地址栏 + 流状态 + 无头 / 复用实例徽章）/ 帧画面 + 键鼠直通（与直播窗共用 `useBrowserFrameInput`）/ 接管与归还 / 步骤时间轴（截图证据）；
- 连接韧性（ADR 120）：CDP 协议层保活（`BROWSER_KEEPALIVE_MS` 默认 15s，两周期无入站判半开）→ 退避自动重连（重挂原管理页 + 恢复域 / 事件 / 帧流）；重连状态 `reconnecting`、动作入口等待恢复结果；`last_frame_at` 写库节流 5s；复用实例经 `external` 标注（形态由该实例决定）。

### 35.3 操作直播窗（LiveDock）与双视图

- 分工：右栏面板 = 控制中心与复盘；LiveDock = 实时直播（可拖动 / 缩放 / 边缘吸附 / 折叠）；M49 让位协同：宽屏（>900px）且右栏停在「实况」（操作已在右栏可见）→ 不自动滑入，仅对齐 tab 供手动展开（见 §58.5）；
- 三态：卡片（默认 420×320，范围 320–720 × 200–640）↔ 胶囊（280×36 摘要条）↔ 关闭（本次运行静音）；位置尺寸 localStorage 持久化；
- 自动滑入：`notify:op`（browser / db 类）首次到达展开 + 选中对应 tab；同一 Run 只弹一次；run-started 重置静音；run 结束 3s 回落胶囊；用户手选 tab 后 60s 内不被抢切；
- 不遮挡：右下锚定 + 底部 88px 避让 composer + 右栏 26% 避让（> 900px）+ z-40（命令面板之下）+ 边缘 14px 吸附 + 全程 clamp + Esc 折叠；
- 联动：与右栏「浏览器」面板共用 browser-store（引用计数 retainView / releaseView，归零才断流）、与「连接管理」控制台共用 connections-store（同一 ops 事件流）；数据库 tab 展示 SQL / 结果预览（前 5 行）/ 失败态 / 最近操作（可钉住查看）；「查看完整审计」一键跳转连接管理；
- 服务端：`ToolRuntime.opNotify` 钩子 + `OpEvent.preview`；db_schema / db_query / db_execute 成功与失败路径均发布实时事件（信封字段由引擎补齐）。

### 35.4 验证

server `tests/m22.test.ts` 15 例（SQL 护栏（含绕过加固回归）/ 凭据加密 / SQLite 全链路 / 会话绑定 / 审计 / 流 token / db 工具实时事件）+ `tests/browser-console.test.ts` 16 例（控制台采集 / 输入键序 / 工具可达性）+ `tests/browser-pages.test.ts` 8 例（多标签页感知 / 切换 / 回退 / 事件隔离）+ `tests/browser-resilience.test.ts` 7 例（断线自动重连 / 动作等待 / 重试耗尽 / 信息面）+ `tests/browser-keepalive.test.ts` 4 例（半开检测 / 健康端点不误判）；client `tests/m22-frontend.test.tsx` 15 例 + `tests/live-dock.test.tsx` 20 例（手势纯函数 / 状态机 / 三态组件 / 右栏联动 / 引用计数）；typecheck + 双端全量测试 + build 全绿。

## 36. 数据库工作台与 SSH 交互终端（M23）

M23 把连接中心从「Agent 能力的配置面」升级为「用户自己的操作面」：数据库以 Navicat 式工作台（对象树 / 数据网格 / SQL 编辑器）供用户直接浏览与执行，SSH 以完整终端（ssh2 + xterm.js）支持人工登录。决策与被否决方案见 ADR 44。

### 36.1 数据库工作台（主区「数据库」Tab）

- 布局：左窄栏对象树（连接选择 + 刷新 + 过滤 + schema 分组 + 表 / 列两级，双击开表）+ 右侧多标签（「查询」常驻第一 + 每表一个数据 Tab，可关闭）；
- 服务端 `manager.tableData` 统一出口：表名 / 列名白名单校验（标识符正则 + `quoteIdent`）防注入、`limit+1` 探测 hasMore、offset/limit 服务端钳制（1–500）；
- 共享 DataGrid：列排序三态循环（升 → 降 → 取消）、分页（每页行数可选）、行数范围徽章、刷新；
- SQL 面板：`POST /api/connections/:id/sql` 单一入口，读写判定在服务端（复用 guard.ts 护栏）；dryRun 预检 → 写语句弹确认对话框（SQL 全文 + 目标连接 + 写入开关状态）→ 确认后 confirmed 直发；只读语句自动两步直发；
- 与 Agent 同流：面板操作成功 / 失败均发 `notify:op`（actor:'user'、preview 前 5 行），直播窗与右栏操作流可见手工操作；
- 入口：右栏连接卡「打开」→ 主区切「数据库」并选中该连接；命令面板「数据库工作台」（M49 起统一为「展开 · 数据库工作台」深度工作台，见 §58.4）。

### 36.2 SSH 交互终端

- 连接表单（右栏）：主机 / 端口（默认 22）/ 用户名 / 认证方式（password | key | agent）；key 支持路径 + 内容粘贴 + passphrase；agent 提示 SSH_AUTH_SOCK；「允许 Agent 执行命令」独立开关（默认关闭）；「保存并测试」保存后真实 SSH 验证；
- 终端通道：`GET /api/connections/:id/ssh/terminal-token`（一次性 token）→ `WS /ws/ssh?connectionId=&token=`；二进制帧 = 终端字节流（防多字节切断）、JSON 帧 = 控制（ready / exit / error / pong；resize / ping）；每终端独立 SSH 连接，ws 关闭即断开；
- 前端（xterm.js + fit-addon，懒加载分包）：多会话 Tab + 状态徽章（connecting 脉冲 / open / closed / error + 终端尺寸）+ 断线手动重连 + 同连接二次 open 聚焦已有会话；SessionPane 隐藏保留 DOM（切换不丢历史输出）；空态连接卡片 +「+」快捷开新会话；
- Agent 侧对称面 `ssh_exec`：requireBinding + 连接「允许执行命令」开关 + 每次调用审批门（与 db_execute 同级最高危）+ opNotify 实时事件；非交互一次性命令，交互需求引导去终端页签；诊断修复批起对 `devops` 开放绑定（`backend` 同步开放 `db_*` 四工具，可达性修复见 ADR 52）；
- 入口：连接卡「终端」→ 主区切「终端」并打开会话；命令面板「SSH 终端」（M49 起统一为「展开 · SSH 终端」深度工作台，见 §58.4）。

### 36.3 操作直播三合一与 SSH 联动（M23+ 增强）

直播窗从「浏览器 / 数据库」双 tab 升级为「浏览器 / 数据库 / SSH」三合一直播，补齐 SSH 与 Agent 的联动断链（只读直播 + 终端镜像方向；完整交互保留在主区终端）：

- 三 tab 与自动跟随：`DockTab` 加 `ssh`，`noteOp` 将 `ssh.exec` 事件映射到 SSH tab 并参与自动滑入 / 60s 手选锁定 / 静音规则；
- 运行中操作面推导（`use-busy-ops`）：从消息流 `toolCalls.status === 'running'` 归约实况三类面（签名式 selector 保证引用稳定；Run 结束即清空防中断残留），驱动 tab 状态点与胶囊计数，零服务端改动；
- SSH tab 四段式（`DockSshView`）：ssh_exec 审批等待条（pending 且 action 含「远程主机」→ 琥珀条 + 命令详情 + 「去处理」跳对话页）→ 执行中提示 → 命令卡（概要 / 命令与输出 / 展开收起）→ 终端只读镜像 → 最近操作（可钉住）；底栏「终端」跳主区完整交互；
- 终端输出镜像：terminal-store 在输出字节处旁路（TextDecoder 流式解码防多字节切断），经 `terminal-mirror` 清洗（CSI / OSC 转义、`\r` 覆盖取末段、限行 / 超长截断）入行缓冲；「通知 + 拉取」订阅（`subscribeMirror` / `mirrorOf`）不进 zustand，避免高吞吐终端流触发全局重渲染；本地提示（exit / 断线 / 重连）双写 xterm 画面与镜像；
- 胶囊增强与窄卡自适应：胶囊前置类型图标（Database / Terminal / Globe / Activity）+ 活跃脉冲点（操作面运行中或帧流已连接）+ 多操作面计数徽标；卡片宽 < 380px 时 tab 图标化（label 转 title 提示）；
- 修复：connections-store 审计回放过滤补 `ssh.` 前缀（刷新 / 重连后 SSH 操作不再丢失）。

### 36.4 验证

server `tests/m23.test.ts` 22 例（quoteIdent 引用转义 / tableData 分页与注入拦截 / SSH 认证解析与 fake client 全链路 / 管理器护栏与句柄缓存 / /ws/ssh 终端通道 / ssh_exec 审批与审计）；client `tests/m23-frontend.test.tsx` 14 例（工作台 store 与对象树纯函数 / 终端 store 协议状态机 / SSH 表单与卡片入口）+ `tests/live-dock-ssh.test.tsx` 18 例（镜像纯函数 / busy 推导 / ssh 映射与审计回放 / 镜像广播与退订 / 审批与镜像 / 胶囊与窄卡）；`tests/m21.test.ts` 增加 backend / devops 工具绑定断言（可达性保障）；typecheck + 双端全量测试全绿。

## 37. 技能库扩展与全角色预载（M23）

M23 把技能库从 9 个扩展到 38 个，并把「预载技能」从 M21 的少数角色铺满全部 34 个角色：每个角色都有 1–4 个贴合职责的专项技能随系统提示直达，其余技能保持按需 `load_skill`。适配规范与被否决方案见 ADR 45。

### 37.1 来源与调研

- 官方：anthropics/skills 19 技能全量盘点（skill-creator / pptx / docx / xlsx / doc-coauthoring / canvas-design / frontend-design / webapp-testing / mcp-builder / brand-guidelines / internal-comms / theme-factory 等）；
- 社区：w95/awesome-claude-corporate-skills（166 技能 / 14 职能，MIT）、skills.sh 市场与多份 curated 清单；UI 方向另取 Vercel Web Interface Guidelines、AccessLint（WCAG 对比度 / 用色）、Bencium UX（MOTION-SPEC / 无障碍）、UI/UX Pro Max、triptease design-system；
- 筛选原则：能在本仓工具面内执行（无 Python / 无二进制产出 / run_command 默认关闭）。

### 37.2 适配原则（改写而非搬运）

- 单文件 `skills/<name>/SKILL.md`，中文正文，60–150 行；front-matter 三字段（name = 目录名 / description 含触发场景 / tags）；
- 不可执行源全量改写为「本仓可执行」方法论：pptx → deck-authoring（HTML 演示稿 + 讲稿）、xlsx → spreadsheet-modeling（CSV + 分析报告）、docx → formal-document（Markdown 正式文档）；pdf 技能放弃（无二进制解析能力，选型剔除）；
- 只引用真实工具与 Markdown 容器（§30 / §33）；预载角色缺该工具时打「如可用」兜底（13 个文件）；webapp-testing 对无浏览器工具的角色降级为「人工步骤单模式」。

### 37.3 技能清单（38）与预载绑定（34 角色）

- 9 存量 + 25 职能新增（skill-authoring / deck-authoring / spreadsheet-modeling / data-visualization / formal-document / comms-writing / brand-system / visual-design / doc-coauthoring / webapp-testing / frontend-design / mcp-server-building / strategic-planning / source-verification / red-team / prd-authoring / system-design / release-engineering / seo-optimizer / sales-outreach / customer-success / support-desk / recruiting / procurement / process-improvement）+ UI 四件套（design-system / interaction-motion / ui-review / react-performance）；按 11 组归类，总表见 agents/README.md「技能库与预载」；
- 34 角色全部显式配置 `skills:`（1–4 个）：research 4 角色共用 deep-research 底线 + 各自专项；designer 四件套、frontend 增 react-performance、qa 增 ui-review；marketing 组 content-marketing 显式化继承（brand 按职责改配 brand-system + visual-design）；
- `defaultSkills` 降为纯兜底：research / brainstorm / marketing 三组已全部显式化，机制保留供新场景使用。

### 37.4 验证

- `check:skills` 38 技能通过；34 角色 skills 引用交叉校验零缺失（脚本全量扫描）；
- 受影响断言同步：`tests/m21.test.ts` 技能断言更新为新映射；`tests/context.test.ts` 预算夹具随系统层扩容 6k → 10k（38 技能索引 + pm 预载后实测 8.3k，压缩触发与预算断言保持有效）；
- server 369 + client 258 测试全绿；eval 14/14；Markdown 扩展 41 单测复核通过（§30 容器与技能引用一致）。

## 38. 交付件多格式预览（M24）

交付件浏览（§22）此前只区分 markdown / code / image / data / other，HTML 报告、CSV 报表、Office 文档、mermaid 流程图与 echarts 配置点开只能看纯文本或下载。M24 把预览扩展到 9 类 kind：HTML 沙箱直出、全语言代码高亮、Markdown 全扩展、Office 服务端零依赖解析、表格与图表，并把「渲染器选择」收敛为服务端单点分类。决策与被否决方案见 ADR 46。

### 38.1 kind 分类与预览协议

- 9 类 kind：`markdown / code / html / chart / data / image / office / pdf / other`；`classifyKind` 约定优先——`*.chart.json` → chart（先于 `.json` → code）、`.mmd/.mermaid` → chart、`.csv/.tsv` → data、旧 Office 格式（`.doc/.xls/.ppt`）归 office 由前端引导下载；`isBinaryExt` 同步扩到 office / pdf / 压缩包 / 字体 / 音视频等，`read()` 绝不按 utf8 打开；
- `content?raw=1`（M24 新增）：文本按扩展名推断 Content-Type 原样直出（HTML / PDF 预览 iframe 需要浏览器原生解析），沿用既有路径安全与大小上限，不新增第二套文件端点；
- `preview?path=`（M24 新增）：docx → HTML / xlsx → 工作表 / pptx → 幻灯片大纲；8MB 上限 `413`、不支持格式 `415`、解析失败 `422`，响应为 `ArtifactPreview` 判别联合（shared 类型）。

### 38.2 服务端零依赖解析（docx / xlsx / pptx）

- `util/zip.ts`：中央目录定位 + `node:zlib` inflateRaw，按 `wanted` 谓词只解需要的条目；zip64 / 未知压缩方式 / 条目越界 / 单条解压 64MB 上限一律报错（防 zip 炸弹）；
- `util/office-preview.ts`：docx 扫描 `w:p` / `w:tbl` 顶层块 → 语义化 HTML（标题 / 段落 / 列表 / 表格 / 粗斜体，图片降级为占位标记）；xlsx 解析共享字符串 / 内联字符串 / 布尔 / 日期样式序列号 → 二维数组；pptx 按 `a:t` 占位符聚合 → 幻灯片大纲；
- 护栏：docx 段落 3000 / 表格行 200 / HTML 900KB，xlsx 300 行 × 64 列 × 20 表，pptx 60 页 × 40 行，超限输出 `truncated: true`，绝不 OOM / 卡死。

### 38.3 客户端预览分派（ArtifactsView）

- **分派**：html → `HtmlPreview`（`sandbox` iframe，raw 原文流，无 `allow-same-origin`）；pdf → `PdfPreview`（浏览器内置预览）；office → `OfficePreview`（拉 preview API，旧格式给下载引导）；data → `CsvPreview`（RFC4180 子集解析 + `DataTable`）；chart → 复用 §30 的 MermaidBlock / ChartBlock；code / markdown → shiki 高亮（35 语言白名单，白名单外回退纯文本）与 Markdown 全扩展渲染；
- **三态工具条**：「预览 / 源码 / Diff」——`hasSourceView`（markdown / html / chart / data）与 `isTextKind`（markdown / code / html / chart / data）决定入口可见性；文本类复制内容、二进制类复制路径；
- **直出与加载态解耦**：html / image / office / pdf 的预览分支不受内联内容加载影响（修复 iframe「闪现 → 卸载 → 重挂」），仅内容驱动的 kind 显示加载 / 错误态；html / pdf 用 `path + 版本` 作 key 强制刷新，图片 src 携带版本参数。

### 38.4 验证

- server `tests/office-preview.test.ts` 12 例（自建 zip fixture：docx 标题 / 列表 / 表格与护栏、xlsx 共享字符串 / 日期序列号、pptx 大纲、损坏与 zip64 报错）；client `tests/artifact-preview.test.tsx` 25 例（语言映射 / kind 判定 / URL 构造 / CSV 全边界 / 四类分派渲染）；
- E2E `artifact-preview.spec.ts`：经 uploads API 注入 html / csv / docx / mermaid 四格式逐一断言分派（沙箱 iframe 原文 h1、表格行列信息、服务端解析 HTML、mermaid 懒 chunk 渲染 SVG），与 `markdown-ext.spec.ts` 合计 3 条全绿（真实构建产物下的 shiki 高亮 / mermaid 懒加载回归验证）。

### 38.5 包体与门槛

- 产物 48 文件（≤ 50）：shiki 词法内核四件套（core / oniguruma 引擎 / 主题 / 内联 wasm，首次高亮同波懒加载）经 manualChunks 合并为单一 `shiki-core` 懒 chunk（-3 文件）；35 个语言 chunk 与 mermaid / echarts 懒 chunk（§30）保持按需；
- 主包 gzip 229.95KB（**超 150KB 门槛**）：M22 / M23 功能面增长的存量欠账（M21 记录 124.0KB），M24 自身 +2.2KB（多格式分派与预览组件均为静态引入，无新增依赖）；待后续按视图懒加载拆分处理，不阻塞本里程碑。

## 39. 向量记忆模块（M25）

记忆此前只有 M2 的会话内一层（L1 关键词记忆）。M25 引入四层关联（session / agent / project / global）的向量记忆：sqlite-vec 扩展优先、纯 JS 余弦兜底；嵌入凭据走连接中心（kind=`embedding`，SecretVault）；召回以 L1.5 层注入（`<recalled_memory>`）；Run 后可沉淀候选记忆待审。未配置嵌入服务时整模块休眠（零网络零影响）。决策与被否决方案见 ADR 47。

### 39.1 存储底座与迁移（v6 / v7）

- `db.ts`：SqlDriver 增可选 `loadExtension`；NodeSqliteDriver 构造改 `{ allowExtension: true }`（try/catch 兼容旧 Node）；`AppDb.loadExtension(path): boolean`；`OpenDbOptions.noExtensions` 供测试强制 JS 后端；
- v6（必成，纯 SQLite）：重建 memory（+ `scope / owner_id / importance / entities / status / supersedes / superseded_by / valid_from / valid_to / source_session_id / source_run_id / hits / last_used_at`；`session_id` 改可空 FK ON DELETE CASCADE）；唯一索引改 `(scope, owner_id, kind, hash)`；新增 `memory_vectors`（Float32LE BLOB 规范副本 + norm）、`embedding_cache`（text_hash + model）、`memory_embed_queue`（FK 级联）；旧数据事务内无损搬迁（scope='session'、importance=3、status='active'）；
- v7（可跳过）：`memory_fts`（FTS5 trigram）+ 同步触发器；缺失时 keyword 信号自动关闭、其余信号归一。

### 39.2 双后端向量索引与嵌入服务

- `memory/vectors.ts`：`VecIndex` 接口 + `SqliteVecIndex`（vec0 分区 KNN：`WHERE embedding MATCH ? AND k = ? AND bucket = ?`；DELETE+INSERT 写入）+ `JsCosineIndex`（BLOB 扫描 ≤2 万行/桶）；bootstrap（动态 import + `getLoadablePath`、`vec_version()` 探测、kv 标记不符自动从 BLOB 重灌镜像、孤儿清理、降级告警；加载后立即 `enableLoadExtension(false)`）；
- `embeddings/provider.ts`：OpenAI 兼容 `/embeddings` + Mock（token→sha1→维度桶投影 + L2 归一，确定性，dim 256）；
- `embeddings/manager.ts`：解析顺序 settings 连接 > env > 休眠；批量 + 超时 15s + 2 次退避重试；`embedding_cache` + 内存 LRU；`invalidate(connectionId)`（连接变更热失效）；`probe` / `probeConnection`（连接测试）；
- `memory/queue.ts`：embed 队列 worker（批量 flush、启动补账「active 且无向量」、失败退避；写入主路径 ADD-only + 近重复合并 cos ≥ 0.92）；`memory/service.ts` 汇总 recall / reindex / stats。

### 39.3 四层 scope 与混合评分

- scope：`session`（会话）/ `agent`（成员角色）/ `project`（取自 `session.projectId`）/ `global`；owner 分别为会话 id / 角色 id / 项目 id / `'global'`；
- kind 七类：`decision / constraint / glossary / artifact / fact / preference / lesson`；status 四态：`active / superseded / archived / candidate`（候选不参与召回，审核转 active 才入镜像）；
- 混合评分：`scope 权重 × (0.50·sim + 0.15·keyword + 0.10·entity + 0.15·importance + 0.10·recency)`，recency 半衰期 30 天；权重 session 1.0 / agent 0.95 / project 0.92 / global 0.90；
- 默认 topK=8、minScore=0.25、注入预算 600 tokens；时间有效性走 supersede（轻量版：不引入图数据库）。

### 39.4 召回注入（L1.5）

- `context/service.ts` + `assembler.ts`：prepareTurn 先取召回（超时 300ms，失败静默跳过）；`<recalled_memory>` 独立层（layers 增 L1.5）参与窗口预算扣减；排除 L1 已注入的 session active 条目（去重）；
- 快照 `ContextSnapshot.recalled` 存最近明细；trace 事件 `memory:recall`；前端 ContextBar 展示 L1.5 层与召回明细。

### 39.5 remember 工具扩展与 Run 后沉淀

- remember 工具扩展 scope / importance / supersedes 参数；MemoryStore `upsertScoped` 通用入口；
- digest（`memory/digest.ts`）：`MEMORY_DIGEST_MODE=off|session|all`（默认 off 零调用）；Run `completed` 收尾后异步沉淀（`session`=仅主 Run，`all`=含轻量 Run=续写/重生成）；结构化输出（`json_schema`）→ 候选写库（`status='candidate'`、`source='digest'`、sourceSessionId / sourceRunId 溯源）；usage kind=`digest`；trace `memory:digest`；LLM_MOCK 下 `__digester__` agentId 走确定性 mock 脚本。

### 39.6 连接中心、设置与前端

- 连接中心 kind=`embedding`：schema 枚举 + POST `/:id/test` 嵌入分支（回报 dim / latencyMs / model 供表单回填）+ PUT/DELETE 后 `embeddings.invalidate(id)` + 绑定接口拒绝（全局共享，在「设置 → 向量记忆」选择）；
- settings 白名单：`embeddingConnectionId`（nullable）/ `memoryEnabled` / `recallTopK` / `recallMinScore` / `recallBudgetTokens` / `memoryDigestMode`；env 全表见 operations.md；
- 前端：ConnectionsConsole 嵌入表单（apiKey 只写不读、dim 留空=探测）；SettingsView（M36 起主区设置页）「向量记忆」分组（连接下拉 + 召回参数 + 后端状态只读）；MemoryPanel（scope 分段 / 状态筛选 / 语义搜索评分 / supersede / 候选审核 / 重建）；ContextBar L1.5 层；MetricsPanel 增 `embed` / `digest` 用量标签；
- API：`/api/memories` 六端点（见 api.md §5.1）；旧 `/api/sessions/:id/memory` 保持兼容。

### 39.7 验证

- server 6 文件 67 例：`m25-store` 17（v6 迁移新库/旧库无损/幂等/级联、BLOB 往返、三表 store 状态机、upsertScoped 与渲染、双后端 top-k 一致与镜像重建、noExtensions 强制 JS）、`m25-embed` 13（mock 确定性投影与序关系、休眠零调用、缓存内存 + SQLite 两级、连接解析与密钥不回传、probeConnection、路由 CRUD/test/bind 分支）、`m25-recall` 16（评分公式与 scope 权重、recency 半衰期、keyword/entity 信号、状态过滤 + exclude + minScore + 渲染、topK 与预算严格截断、近重复合并、休眠与 300ms 超时降级、reindex、global 权重收敛）、`m25-api` 10（六端点 + remember 扩展 + 密钥不回传）、`m25-context` 5（L1.5 注入与快照明细、预算扣减）、`m25-digest` 6（coerce 纯函数、候选落库与溯源、off 短路、坏 JSON / 服务报错、引擎级 session 与 off）；
- client 2 文件 11 例：`m25-memory-panel` 7（scope 分段 / 状态筛选 / 候选审核 / 语义搜索评分 / supersede）+ `m25-frontend` 4（ConnectionsConsole 嵌入表单 / SettingsView 向量记忆分组 / ContextBar L1.5）；
- evals `15-memory-recall.json`：mock 嵌入下召回固定断言 + baseline 回归门禁；
- E2E `m25-memory.spec.ts` 2 例（零网络：不可达端点证明休眠零调用）：嵌入连接 → 测试 → 设置启用 → 对话后 L1.5 分层随快照输出（Mock 无 remember 调用 → 无召回注入断言）；新增记忆 → 队列补账 → 语义搜索返回评分（sim=1 → score ≈0.94）。

## 40. 协作范式（规划 / 执行 / 评审）与计划生命周期（M24）

接力链默认「边聊边干」：模型可直接动工写交付件，复杂任务在动工前没有一次「出稿即审」的节拍。M24 引入与角色正交的三类回合范式：**规划**（只读工具 + 产出结构化计划，提交即挂起等批准）、**执行**（现状工具集）、**评审**（只读工具 + 结构化判定）；批准的计划按步骤派发给负责人执行，全步完成后作者收口。范式为显式 opt-in，默认路径与现状零差异。决策与被否决方案见 ADR 48 / 49。

### 40.1 三范式与触发规则

- `TurnMode = 'plan' | 'execute' | 'review'`（shared 类型），与角色正交——范式决定工具白名单、回合指令模板与产出契约（plan 必交 `write_plan`、review 必交 `submit_review`），角色人设零改动；
- 触发优先级：① Composer 消息级选择（仅对下一条消息生效，发送后自动复位回「执行」）→ ② 会话「规划先行」`planFirst`（默认关闭的持续开关）→ ③ 派发步骤声明的 mode → ④ 默认 `execute`；用户消息持久化 `mode`（迁移 v5 `messages.mode`）；
- 误触发双保险：`write_plan` 仅存在于 plan 白名单（execute 模式模型看不到该工具，普通对话无法顺手提交计划）；即使提交，Run 立即挂起 `awaiting_plan`，批准前零自动执行。

### 40.2 范式工具门控（registry）

- `ToolRegistry.forAgent(agent, mode?)` = 范式白名单 ∩ 角色工具集；plan / review = 只读工具 ∪ `{write_plan | submit_review, handoff, remember, request_approval, load_skill, calc, date_calc, csv_analyze, web_search, web_fetch, list_dir, read_file, glob, grep, search_text, git_status / git_diff / git_log}`；execute = 现状（零差异）；
- 白名单不含任何写工具：plan / review 波在结构上不可能触发工具审批（回避「审批 × 计划」双挂起交叠）；新工具默认不进白名单（须显式列入）。

### 40.3 计划挂起与审批协议

- `server/src/plan-review.ts`：`PlanReviewService` 镜像 `approval.ts`（create / wait（signal 取消）/ resolve（approve | reject + feedback）/ pendingOf / persist）；Run 新增状态 `awaiting_plan`（与审批挂起同构）；`PLAN_REVIEW_TIMEOUT_MS` 默认 0（无限等待，可配；超时按驳回收敛）；
- 驳回修订：驳回反馈经工具结果回灌作者，作者同回合 `write_plan` 修订重提——同一 plan id、`version+1`、状态回 `submitted` 重新挂起（v2）；executing 中再次提交 = 重规划（旧版 supersede）；
- 停止与稍后批准：`awaiting_plan` 时 stop → 计划挂起取消（保持 `submitted` 供稍后处理）；无挂起时批准 → `launchPlanExecution(sessionId, planId)` 新起执行 Run（队列 = 步骤负责人）；
- 并行多计划：各自独立挂起；批准其一 → 其余自动 superseded（等待方以「已被取代」收敛）；plan 波未提交计划（协议违规）→ trace 事件 + system 事件条提示，按既有规则收束交还。

### 40.4 派发执行与步骤生命周期

- 波末 fan-in：被批准计划 → 执行队列 = 步骤负责人（按步骤序去重）**前置**并入 merge.queue（`scheduler.ts` 纯函数零改动）；plan → `executing`；`planDispatch: Map<agentId, stepId[]>` 登记本波代执行步骤，回合指令追加「你负责计划步骤：…」；
- 步骤状态机 `pending → in_progress → done | blocked | skipped`：波启动置命中成员的 pending 步骤 `in_progress`；`update_plan_step(step_id, status, note?)`（仅步骤 owner 或计划作者；blocked 必带 note）广播 `plan:updated`；全步 `done | skipped` → plan = `done` → 作者收口波（一次；`synthesisAdded` 防重入，作者已在队列则跳过）；
- 评审范式：`submit_review(target, verdict, findings[], evidence?)`（target ∈ `plan:<id>` / `step:<id>` / `artifact:<path>` / `message:<id>`）；`fail` 命中 step → 该步 `blocked`、命中 plan → plan `blocked`；`reviews` 表持久化 + 广播 `review:submitted`；
- §29 遗留修复：`todosByAgent: Map<agentId, TaskItem[]>` 消除波内并发待办互相覆盖。

### 40.5 上下文与提示词

- `buildSystemPrompt` 增 `<active_plans>` 块（L3：executing 计划的目标 / 步骤 / 负责人，全员可见）；
- `buildTurnInstruction(..., mode, extra)` 三模板：plan（只读、必须 write_plan、步骤需含 owner 与验收、提交后会挂起等待批准）+ review（注入评审目标与判定要求）+ execute（仅派发时追加派发步骤、仅有 expected_output 时追加「上一棒期望」行）；三模板统一在首行后追加语言纪律行（全程使用简体中文输出，含工具调用前的说明句；v97 语言批）；
- `pendingHandoffs` 条目化 `{from, reason, expected_output}` 注入接收方回合指令（指派闭环）；`agents/_protocol.md` 增 `<paradigm_modes>` 协议段；mock（`server/src/llm/mock.ts`）按回合 `mode` 输出 write_plan / submit_review / 派发时 update_plan_step。

### 40.6 API 与事件

- `GET /api/sessions/:id/plans` → `{ plans, reviews }`；`PUT /api/sessions/:id/plans/:planId`（编辑 title / goal / steps：改负责人 / 调序 / 增删；仅 submitted；负责人须在会话内；广播 `plan:updated`）；`POST .../plans/:planId/resolve`（有挂起 → 结算；无挂起 approve → `launchPlanExecution`，reject 仅改状态）——聊天卡与任务面板共用（见 api.md §3.1）；
- 事件：`plan:submitted` / `plan:updated` / `review:submitted`（RunEvent，SSE）；`notify:plan-submitted` / `notify:plan-updated`（WS）；`turn:start` / `wave:start` 增 `mode`；queue / 审批事件形状不变。

### 40.7 验证

- server 3 文件 41 例：`m24-plan` 8（plans / reviews 存储状态机、迁移 v5、planFirst 落库、消息 mode）、`m24-tools` 24（registry 门控白名单、write_plan 归属校验与驳回回灌、update_plan_step 权限、submit_review 阻塞、PlanReviewService 批准 / 驳回 / 取消 / 稍后批准）、`m24-engine` 9（全流程：plan 波挂起 → 批准 → 派发执行 → 步骤完成 → 收口；驳回 v2；停止 → 稍后批准；并行双计划 supersede；范式白名单；协议违规提示；planFirst 开关）；
- client `m24-plan.test.tsx` 20 例：plan-store 竞态守卫（含迟到回包单调守卫）/ 就地编辑 / 批准 / 驳回 / PlanReviewCard 驳回竞态表单收起 / TaskView 双形态与分组 / Composer 范式选择器；
- E2E `m24-plan.spec.ts` 2 条（规划挂起 → 批准 → 派发 → 收口 → 交付件；驳回 → v2 → 批准并收口），串联连跑 3 次全绿。

## 41. 任务面板 2.0 与范式指挥（M24）

任务面板此前只有「待办清单」单一形态；M24 按「是否执行 plan」双形态展示：有计划 → 计划板（步骤 / 负责人 / 进度 / 验收），无计划 → 原清单原样。决策见 ADR 49。

### 41.1 双形态与分组

- `TaskView` 2.0：存在待批准 / 执行中计划 → 计划板（卡片：状态徽章 / 进度条 / 作者；步骤行：状态图标 / 负责人头像 / 范式标 / 验收；执行中步骤实时更新）；无计划 → 现有清单原样保留（零差异）；
- 顶部「按计划 / 按成员」分组切换：按成员视角展示每人「已规划 · 步骤 x/y」；「规划先行」会话开关就地可切（PATCH `/api/sessions/:id`）。

### 41.2 聊天计划卡（PlanReviewCard）

- 待批准（submitted）：步骤表 + 就地编辑（标题 / 指派 / 调序 / 增删）+「批准并执行 / 驳回带反馈」（无挂起时服务端自动新起执行 Run，plan-store 挂接流转）；与 ApprovalPanel 同区渲染（Composer 上方）；
- 其余活跃态（approved / executing / blocked / rejected）：紧凑进度卡（实时步骤状态 + 评审标记 + 驳回反馈）；done / superseded 不占聊天区（面板可见），最多并列 2 张。

### 41.3 范式指挥入口

- Composer：执行 / 规划 / 评审三态 chip（默认「执行」，不持久化选择，仅对下一条消息生效并发送后自动复位，tooltip 明示）；会话级持续规划走「规划先行」开关；MessageItem 渲染 mode 徽章（规划 / 评审）；
- 指挥台队列 chips：有计划派发时显示对应步骤提示（title）。

### 41.4 数据通道与竞态守卫（plan-store）

- 双通道：SSE `plan:submitted / plan:updated / review:submitted`（run-store 转发）+ WS `notify:plan-*`（ws-store 转发；SSE 未挂接 / 非当前 Run 时兜底）；按会话绑定（load 绑定守卫，跨会话迟到响应丢弃）；
- updatedAt 单调守卫：`applyPlan` 拒绝 `updatedAt` 更旧的 incoming 快照——resolve / PUT 回包与 SSE 推送并存时，迟到旧快照（如驳回 v1 rejected）不得覆盖更新的 v2 重提状态；
- 表单主动收起：驳回 → v2 重提可能同批到达（React 合并渲染不卸载组件），`reject()` 结算成功后显式关闭表单（不依赖卸载清理）。

### 41.5 面板徽章与持久化

- 任务 Tab `PanelDef.badge` = 待批准计划数（无计划时无徽章）；TeamPanel 成员卡次行计划徽章（待批准 / 执行中 x/y）；ui-store `rightView` 持久化 localStorage；
- 验证：client `m24-plan.test.tsx` 覆盖双形态 / 分组 / 开关 / 计划板断言；E2E `m24-plan.spec.ts` 断言「任务 Tab 徽章（1 份计划待批准）→ 计划板 2/2 → 已完成」全链路；无计划会话既有面板测试零差异。

## 42. 资产控制台（M26）

Agent / Skill 资产此前只能手改文件；M26 提供图形化管理面：最左常驻图标导航栏 + Agent 管理 + Skill 管理 + 资产校验。决策与全量配置矩阵（一至三期）见 ADR 50。

### 42.1 导航与视图（ActivityRail）

- 布局：顶栏通栏（全宽：品牌 / 实时连接状态 / 安静模式 / 帮助；命令面板顶栏按钮已撤除——⌘K 键盘直达，见 §58.3；安静模式开关为全局 UI 偏好的常驻入口，自右栏面板头部上移）；44px icon-only rail 自顶栏下方起：工作台 / Agent 管理 / Skill 管理 / MCP 管理（M27，§43）/ 连接管理（设置 pin 底部——全应用唯一设置入口，入口不重复）；`ui-store.appView` 持久化 localStorage（`ma:appView`，非法值回退）；
- 控制台视图只切主区内容，**AppLayout 不卸载**（WS / Run 生命周期与后台运行保持）；CommandPalette 同步提供各控制台入口（Agent / Skill / MCP / 连接管理）；
- 连接管理（M26 收敛，自右栏「连接」面板迁入，见 §35）：连接是全局资源（不随会话切换），统一收进控制台维护——页头 + 清单卡片网格 + 新建/编辑表单限宽置顶 + 操作流水；「绑定」仍按会话隔离；右栏「浏览器」面板保留（实时控制中心）。

### 42.2 Agent 管理

- 列表：按场景分组（group.order）/ 搜索（名称 · id · 角色 · 头衔）/ 场景过滤；卡片徽章 = 工具数（-1 全部）· 技能数（-1 继承场景）· 灵魂数 · 引用数；
- 新建向导：选场景（或内联新建场景）→ 基本信息（id / name / role / 头衔 / 头像回退 / 正文模板）；
- 编辑器七页签：基本 / 人设 / 灵魂 / 工具（白名单三态）/ 技能（继承 · 不预载 · 指定三态）/ 交接 / 高级（model / temperature / 默认灵魂 / 资产路径与引用面）；
- 复制（`<id>-copy` 系列自动递增）与软删除（有引用 → 409 + 影响面清单 → force 二次确认）。

### 42.3 Skill 管理

- 卡片网格（1 / 2 / 3 列自适应，与 Agent 卡片同款布局）：名称 + 行数 + 标签、说明（2 行截断）、引用徽章（角色预载数 · 场景兜底数 · 未引用）与卡片内编辑 / 复制 / 删除操作；
- 新建（name = 目录名全局唯一）+ 复制（-copy 系列）+ 编辑（front-matter 表单 + 正文 Markdown 编辑 / 预览）+ 软删除；编辑器展示引用影响面警示。

### 42.4 校验与写入纪律（AssetManager）

- 唯一写盘入口：zod 复用运行时 schema → 固定字段顺序序列化 → 同目录 `.tmp` + rename 原子写 → 写后广播 `notify:assets-changed`（多标签 / 本页联动刷新，agentStore 同步）；
- 页头校验徽章（ValidateBanner）：绿 = 通过，琥珀 = 错误数 · 警告数，展开 issue 清单（路径 + 描述）并可重新校验；
- 安全与回滚：id / soulId / 技能名全链路 ID_RE 防路径穿越；头像仅 PNG magic 且 ≤8MB；软删除落 `data/trash/assets/<ISO 时间戳>/<相对路径>`；`prompts/` 回退模式拒绝写；
- 验证：server `m26-console.test.ts`（CRUD 全链路 / 三态 / 409 引用 / 回收站 / 热更新 / 校验聚合 / 工具元数据）、client `m26-console.test.tsx`（rail 切换 / 向导 / 编辑器保存语义 / 校验徽章）、E2E `m26-console.spec.ts`（新建 Skill → 新建 Agent 绑定技能与工具白名单 → 建会话成员选择器可见 → 编辑 → 软删除断言回收站 → 校验通过；资产唯一前缀 + 用例结束清理）。

## 43. MCP 接入与管理（M27）

M5 预留的 MCP 空壳（`tools/mcp.ts`）在 M27 升级为完整体系：服务器 CRUD（凭据加密）→ 官方 SDK 双传输（stdio + Streamable HTTP）→ 运行时生命周期 → 工具注入注册表（`mcp__<slug>__<tool>`）→ 会话绑定 + Agent 通配白名单 → 引擎审批策略 → 独立「MCP 管理」台（rail 第四入口）。决策与被否决方案见 ADR 53。

### 43.1 服务器与凭据

- `mcp_servers`（迁移 v8）：slug 唯一（`^[a-z][a-z0-9-]{0,39}$`，工具前缀）；stdio：`command` / `args` / `cwd`（缺省应用根目录），http：`url`；策略字段 `approvalPolicy`（risky / always / never）、`readOnlyOverride`（auto / readonly / write）、`timeoutMs`（1s–600s，缺省全局工具超时）；
- 凭据：stdio `env` / http `headers` 全量进 SecretVault（`secret_enc`，AES-256-GCM）；对外仅 `secretSet`；编辑留空 = 不修改、「清除凭据」= `secret: null`；明文永不回传；
- 种子：`MCP_SERVERS` 首启按 name 导入（`source='env'`，不存在才建）；此后 DB 为唯一真相，管理台为准。

### 43.2 传输与子进程安全

- 官方 `@modelcontextprotocol/sdk` 双传输；连接超时 15s；订阅 `tools/list_changed` 自动刷新（diff 注册 / 注销 + 读缓存失效）；`clientFactory` 可注入（单测用 InMemoryTransport）；
- 子进程：env = SDK 白名单基座 + 配置 env（**绝不透传进程 env**，防 `LLM_API_KEY` 泄漏）；argv 数组不过 shell；cwd 受控；stderr 转日志；`stopAll` 挂进关停链（stdio 子进程回收）。

### 43.3 工具注入与授权

- 命名：`mcp__<slug>__<tool>`（总长 ≤64：非法字符 → `_`、超长截断 tool 段 + 6 位稳定哈希、同服冲突 `_2` / `_3`）；保留 `registeredName → rawName` 映射，调用回传 raw；
- 三层可用性：`enabled + status='ok'`（已连接）∩ 会话绑定（`session_mcp_servers`，未绑定不可见）∩ Agent `tools` 白名单（精确名或尾部 `*` 通配 `mcp__<slug>__*` / `mcp__*`）；回合清单 `forAgent` → `filterForSession`，执行期再校验（绑定中途解除的竞态兜底）；
- 可达性闭环：`GET /api/mcp/tools` 输出授权矩阵（每台服务器工具被哪些 Agent 命中）；控制台对零可达服务器显示警示徽章；Agent 编辑器「MCP 服务器组」整组勾选写通配。

### 43.4 审批与只读语义

- readOnly：`annotations.readOnlyHint === true`（服务器级 `readOnlyOverride` 兜底无注解服务器）；只读工具可并行 + 60s 结果缓存；**无注解默认写类**（串行、不缓存、进审批门）；
- 审批：引擎 `approvalGate` 中 `mcp__` 规则位于 `APPROVAL_TOOLS` 之后、`all` 之前——`never` 豁免 / `always` 全拦 / `risky` 仅写类拦截；detail 含服务器 / 工具 / 参数摘要；
- 调用：per-server 超时 + `ctx.signal` 透传；结果扁平化——text 块拼接、image / audio / resource 占位摘要、`structuredContent` 截 4KB、detail 硬上限 64KB。

### 43.5 管理台与实时同步

- McpConsole：服务器清单（状态灯 idle / ok / error + 传输 / env 种子 / 凭据 / 工具数徽章 + 零角色可达警示）；操作：测试（真实连接）/ 重连 / 刷新工具 / 启停 / 编辑 / 删除 / 绑定当前会话；展开 = 工具清单（注册名 / 原始名 / 只读 / 角色可达性矩阵）；
- McpServerEditor：双传输表单 + 策略字段 + 凭据只写不读；删除 = 断开 + 注销工具 + 级联解绑（不可逆确认）；
- 实时：写操作 / 状态变化广播 `notify:mcp-changed`（主题 `__mcp__`，不计未读，多标签刷新）；审计 `mcp.*` 全量；CommandPalette 提供「打开 MCP 管理」。

### 43.6 验证

- server `m27-naming / store / manager / engine / api`（命名规范化与去重 / CRUD 与会话绑定与级联 / InMemoryTransport 生命周期与调用扁平化超时中断 / 通配白名单与会话过滤与审批门 / 管理 API 与审计广播）；夹具 `tests/fixtures/echo-mcp.mjs`（真实 SDK Server + stdio，单测与 E2E 共用）；
- client `m27-mcp.test.tsx`（mcp-store 三路加载与绑定守卫、管理台渲染与零可达警示、编辑器校验与入参与清除凭据、rail 导航）；
- E2E `m27-mcp.spec.ts`（新建 stdio 服务器 → 真实连接注入 6 工具 → 绑定会话 → Agent 通配授权翻绿 → 禁用注销 → 删除级联；唯一前缀 + 清理）。

## 44. 工具按需发现与 MCP JSON 直配（M28）

渐进披露从 Skill 层（ADR 15 / §23）下沉到工具层：核心工具常驻，重型连接类（web / git / db / browser / ssh / run_command）与全部 MCP 工具默认延迟，模型用 `tool_search` 混合检索（BM25 + 嵌入融合）激活后立即可用；同时打通 `mcp.json` 文件直配（生态标准 `mcpServers` 格式，文件权威同步）。决策与被否决方案见 ADR 54。

### 44.1 tier 元数据与常驻清单

- `AgentTool.tier?: 'core' | 'deferred'`（缺省 core）；内置常驻 22 个（list_dir / read_file / write_file / edit_file / apply_patch / search_text / glob / grep / calc / date_calc / csv_analyze / template_fill / remember / handoff / write_todos / load_skill / request_approval / write_plan / update_plan_step / submit_review / tool_search / invite_members（M46））；延迟 34 个（web_fetch / web_search / run_command + git×6 + db×4 + browser×13 + ssh_exec + 画布创作×4（M31）+ 定时任务×3（M35）；金融投研 12 个 `fin_*` 随 `FINANCE_ENABLED=true` 并入延迟池）；
- 范式三件套必须 core（mock 会调用：E2E 稳定 + plan/review 正确性优先）；MCP 工具 `tier = config.eagerLoad === true ? 'core' : 'deferred'`；
- 白名单语义不变：`forAgent` 先定「可发现范围」，tier 只影响「初始可见性」——授权矩阵 / 审计语义零变化。

### 44.2 混合检索与 tool_search

- `discovery.ts` 纯函数链：tokenize（拉丁按词 + 下划线 / 点 / 斜杠子词；CJK 单字 + 2-gram）→ BM25（k1=1.2 / b=0.75；name token 重复注入 ×3）归一化 → 查询整体子串命中工具名强先验 0.9；
- 语义融合（复用 M25 EmbeddingManager）：query / 条目向量 cosine → `0.65*词法 + 0.35*语义`；条目向量内存缓存（name+description hash 失效）；嵌入休眠 / 失败静默纯 BM25；
- `tool_search`（core / readOnly）：`query` + `limit`（1–10，默认 5）→ 排序 top-k → 写入 `RunRecord.activatedTools` → 返回激活清单（注册名 + 描述 + 「本 Run 内持续可用」）；无命中兜底类别概览（防死路）。

### 44.3 引擎集成

- `RunRecord.activatedTools: Set<string>`：Run 级生命周期（跨回合保留、不跨 Run）；
- auto 判定（每回合，基于该 Agent 实际可延迟集合）：`deferrableCount >= TOOL_SEARCH_MIN`（10）或 deferred schema token ≥ `TOOL_SEARCH_TOKEN_PCT%`（10%）预算 → 启用；`TOOL_SEARCH_MODE=auto | on | off`（off = 现状）；
- schema = core ∪ activated ∪ {tool_search}；重算移入工具循环（子轮间激活 → 下一子轮即时生效）；执行门：未激活 deferred 直接拒绝 + 回灌 tool_search 提示（审批门之前）；
- `<tool_discovery>` L3 区块（类别概览 ~150 token，仅启用时注入）；`load_skill` 未命中 → top-3 相近候选（复用排序）。

### 44.4 MCP JSON 直配

- `mcp.json`（生态标准 `mcpServers`，Claude Desktop / Claude Code 配置可直接拷贝）：stdio `{command,args,env,cwd}` / http `{type:http|streamable-http,url,headers}` + 扩展（enabled / displayName / eagerLoad / timeoutMs / approvalPolicy / readOnlyOverride）；`${VAR}` / `${VAR:-默认值}` 展开（args/env/url/headers/cwd）；条目级校验失败跳过 + 告警；
- 文件权威同步：启动（**先于** MCP_SERVERS env 种子）→ mtime 轮询（`MCP_CONFIG_POLL_MS`，0=关）→ API 手动；upsert（变更深比较 → 更新 + 重连）+ 删除缺失（仅 source='json'，级联解绑）；防误删：解析失败 / 文件缺失 → 整次跳过（绝不删库）+ declaredNames 白名单；
- `source: 'env' | 'ui' | 'json'`；json 源在管理台 / API 只读（编辑 / 删除 409）；secret 走 SecretVault（对外脱敏）；同步复用 `notify:mcp-changed` 广播 + 审计 `mcp.json-sync` / `mcp.json-import`。

### 44.5 管理台与配置

- McpConsole：「JSON 配置」卡片（路径 / 就绪 / 轮询间隔徽章 + 最后同步 + 条目 + 错误与告警 + 文件缺失时示例片段与「复制示例」 + 粘贴导入对话框）；服务器卡 source 徽章（env 种子 / 由 mcp.json 管理 / 手动）+「全部常驻」（eagerLoad）；json 源启停 / 编辑 / 删除禁用；
- McpServerEditor：「始终加载（跳过延迟发现）」开关（eagerLoad）；json 源整体只读（fieldset disabled + 横幅 + 仅「关闭」）；
- McpToolList：「加载」列（常驻 / 按需徽章）；mcp-store：`jsonConfig` 状态 + `syncJsonConfig` / `importJson` + 既有 notify 自动刷新；
- config：`TOOL_SEARCH_MODE` / `TOOL_SEARCH_MIN` / `TOOL_SEARCH_TOKEN_PCT` / `TOOL_SEARCH_LIMIT`（1–10）/ `MCP_CONFIG_FILE` / `MCP_CONFIG_POLL_MS`（0=关）；describeConfig 逐项覆盖。

### 44.6 验证

- server `m28-discovery`（分词 / BM25 / name 权重 / 强先验 / 无命中兜底 / 嵌入融合 mock / limit 上限）、`m28-engine-search`（阈值自适应 / 子轮间 schema 生效 / 执行门 / eagerLoad 豁免 / plan·review 交互 / activatedTools 生命周期）、`m28-json-config`（解析 / 展开 / 校验跳过 / 增删改同步 / 冲突 / 防误删 / 轮询 / 导入）、m27-api 扩展（json-config 三端点 + 409 只读）；
- client `m28-frontend.test.tsx`（mcp-store jsonConfig / JSON 卡片 / 徽章与只读 / eagerLoad 开关 / 工具「常驻·按需」列）；
- E2E `m28-json.spec.ts`（独立 MCP_CONFIG_FILE data/e2e-main/mcp.json + 轮询 1.5s：写文件 → 自动同步 → 服务器与工具快照 → 绑定 → 变更 / 坏文件防误删 / 空清单删除）。

## 45. 研发场景能力强化与编码代理能力基线（M29）

研发场景（development）是本项目的第一场景与最长接力链；本批对 7 角色做能力审计，修复「已建成能力未接通」的可达性缺口、对齐「职责 × 能力」矩阵，并把工程纪律上升为场景协议。零新增工具代码（授权接通 + 资产层设计）；决策与被否决方案见 ADR 55。

### 45.1 诊断：三类缺口

- **可达性**：① `handoff` 结构化转交工具在 34 角色白名单中零绑定——ADR 2 的「工具优先、文本 @ 回退」在 execute 范式下实际只剩文本回退，`reason` / `expected_output` 指派闭环与多目标 fan-out 从未在真实运行中触达；② `remember` 在研发 7 角色零绑定，与协议 `<context_semantics>` 及其他 6 场景（27/34 已绑定）不一致。
- **职责 × 能力错配**：`run_command`（跑测试 / 类型检查 / 构建）与 git 写操作（`git_branch` / `git_commit`）仅 devops 持有——frontend / backend / qa 无法自测与自提交；qa 无 `db_query`（数据一致性验证缺数据面手段）；designer 无浏览器能力（走查停在纸上）；pm 无 `calc` / `date_calc`（排期与指标口径靠心算）。
- **工程纪律**：无 development 场景协议；`code-review` 技能零预载且正文低于 60–150 行规范；无缺陷定位类技能。

### 45.2 编码代理能力基线（CAB，Code Agent Baseline）

六域最低能力集，研发角色按职责取子集：

| 域 | 能力 | 工具 | 护栏 |
| --- | --- | --- | --- |
| ① 代码导航 | 目录 / 读取 / 检索 | `list_dir` `read_file` `glob` `grep` `search_text` | 只读常驻；工作区沙箱（ADR 14） |
| ② 精准编辑 | 小改 / 补丁 / 覆写 | `edit_file` `apply_patch` `write_file(dry_run)` | 覆盖写走审批；原子写 + 中断保护 |
| ③ 执行验证 | 测试 / 类型检查 / 构建 | `run_command` | 白名单前缀 + `ALLOW_RUN_COMMAND` 开关 + 审批 + 15s 超时 + 元字符拒绝 |
| ④ 版本控制 | 状态 / 差异 / 历史 / 分支 / 提交 / 还原 | `git_status` `git_diff` `git_log` `git_branch` `git_commit` `git_restore` | 只读全员；写按实现者授权 + 审批；worktree 模式提交落 `agent/<sid>` 分支 |
| ⑤ 数据与环境 | 库 / 浏览器 / 远程 | `db_*`（backend 全量、qa 只读）/ `browser_*`（frontend·qa 全量、designer 只读子集）/ `ssh_exec`（devops） | 连接中心会话绑定；只读护栏 + 写开关 + 审批 |
| ⑥ 协作与记忆 | 转交 / 记忆 / 任务 / 技能 / 审批 | `handoff` `remember` `write_todos` `load_skill` `request_approval` | 成员在场校验；L1 永不裁剪 |

- 授权语义不变：白名单先定「可发现范围」，`tier='deferred'` 只影响初始可见性（ADR 54）——③④⑤ 重型工具经 `tool_search` 激活后本 Run 可用；
- 「能跑就跑」口径：有测试 / 构建命令时必须执行并把命令与结果写入交付件；`run_command` 未启用（开关关闭 / 非 git 目录）时给可执行的人工验证步骤，不许静默跳过。

### 45.3 研发 7 角色能力矩阵（目标态）

共同基线（全员）：`list_dir` `read_file` `write_file` `edit_file` `apply_patch` `search_text` `glob` `grep` `write_todos` `load_skill` `remember` `handoff` `request_approval`。

| 角色 | 增量能力（相对共同基线） | 预载技能 |
| --- | --- | --- |
| pm | `calc` `date_calc`（排期与指标口径）；git 只读三件套 | prd-authoring |
| architect | `web_search` `web_fetch`；git 只读三件套 + `git_restore` | system-design |
| designer | 浏览器只读子集（`open` `navigate` `snapshot` `screenshot` `console` `wait` `close`，走查取证不操作）；git 只读三件套 | visual-design / design-system / interaction-motion / ui-review |
| frontend | 浏览器全量 13；`web_search` `web_fetch`；`run_command`；`git_branch` `git_commit` `git_restore`；git 只读三件套 | frontend-design / react-performance / ui-review / debugging |
| backend | `db_*` 全量（含 `db_execute` 审批写）；`web_search` `web_fetch`；`run_command`；`git_branch` `git_commit` `git_restore`；git 只读三件套 | api-design / mcp-server-building / debugging |
| qa | 浏览器全量 13；`db_list_connections` `db_schema` `db_query`（只读，不含 `db_execute`）；`run_command`（复现与回归）；git 只读三件套 | test-plan / webapp-testing / ui-review / debugging |
| devops | `run_command`；git 全套（含 `git_branch` `git_commit`）；`ssh_exec`；`web_search` `web_fetch` | release-engineering |

- 职责边界不变：designer 只「看」不动页面（click / fill / eval 留给 frontend 自测与 qa 实测）；qa 是验证方不做写操作（无 `db_execute` / git 写）；发布动作仅 devops。

### 45.4 场景协议：研发工程纪律

新增 `agents/development/_protocol.md`（`<scene_protocol scene="development">`，追加在全局协议之后），六条纪律：

1. **代码改动纪律**：动手前先读后写（`read_file` / `grep` 摸清现状），最小 diff（`apply_patch` / `edit_file` 优先于全量覆写），遵循既有风格与目录约定，不顺手重构无关代码；确需改范围外文件先说明理由。
2. **共享文件所有权**：同一文件同一时刻只有一个负责人；并行波开始前声明文件 / 模块归属，交叉时停下并并入收敛方。
3. **验证闭环**：实现者自测（`run_command` 跑测试 / 类型检查；界面优先 `browser_*` 实测）→ 交棒携带可执行验证步骤 → qa 复验通过才算完成；测试未过不带病交棒。
4. **缺陷回交**：最小复现路径 + 期望 vs 实际 + 影响面；修复先复现再回归，回归证据留存（命令输出 / 截图摘要）。
5. **提交与发布纪律**：`git_commit` 前先 `git_status` / `git_diff` 自查；一次提交只含本任务改动；不 push、不改他人未完成改动；发布动作仅 devops 执行。
6. **依赖与配置纪律**：新增依赖先说明理由与替代方案并获用户批准；不擅改 `.env` 与依赖版本。

### 45.5 技能层

- 新增 `skills/debugging`（缺陷定位手册，六步法：症状采集 → 复现与最小化 → 证据链 → 假设验证循环 → 最小修复与回归 → 复盘沉淀）；预载 frontend / backend / qa。
- `code-review` 升级为完整评审手册（六组清单：正确性 / 边界 / 安全 / 性能 / 可维护性 / 测试 + 输出协议），维持按需 `load_skill` 加载（评审为周期性动作，不占常驻上下文）。

### 45.6 引擎与安全（零工具代码改动）

- 工具实现零改动：全部为白名单授权补齐与资产更新；`forAgent` / 延迟披露 / 审批门语义不变；
- 能力绑定 ≠ 能力启用：`run_command` 仍受 `ALLOW_RUN_COMMAND` 开关与审批门双重约束；`git_commit` / `git_restore` / `db_execute` / 覆盖写仍走审批；
- 命令白名单不扩展：项目侧以 package.json scripts（test / lint / typecheck）经 `npm run` 暴露验证入口（扩展 `npx <任意包>` 前缀被否决，供应链风险）。

### 45.7 验证

- 数据面：`server/tests/m29-code-bindings.test.ts`——34 角色全员含 `handoff`；研发 7 角色含 `remember`；frontend / backend / qa 含 `run_command`；frontend / backend 含写类 git；qa 含 db 只读三件套且不含 `db_execute`；designer 含浏览器只读子集且不含交互类；代码角色预载 `debugging`；
- 资产与回归：`npm run check:agents` / `npm run check:skills` / `npm run eval`（mock 15 个 golden 任务与基线无回归）/ server + client vitest 全绿；
- 手工验收：在启用 `ALLOW_RUN_COMMAND=true` 的 repo / worktree 项目会话中，frontend 跑一次 `npm run` 脚本并把结果写进交付件；qa 用 `db_query` 核对一条数据一致性结论。

## 46. BI 场景与 NL2SQL 取数管道（M30）

新增「商业智能」场景（bi）与 BI 分析师（沈析），把 M22/M23 已建成的数据库连接能力（连接中心 / 只读护栏 / 审批门）与 M21 业务工具（`csv_analyze` / `calc`）组合成一条 **NL2SQL 取数管道**：业务问题 → 口径对齐 → 库表探索 → SQL 生成 → 执行校验 → 交付解读。零新增工具代码（资产层 + 方法论文档）；决策与被否决方案见 ADR 56。

### 46.1 定位：与既有角色的职责切割

| 角色 | 管什么 | 不管什么 |
| --- | --- | --- |
| **bi（沈析，BI 分析师）** | 数据侧取数：库表探索、SQL 生成与校验、指标口径五要素、数据质量检视 | 不写库（无 `db_execute`）；不做经营解读（交 insight）；不管数据管道建设（交 data-engineer） |
| insight（甄明，经营分析师） | 业务侧解读：指标体系设计、波动归因、经营建议 | 不直连数据库（工具面向文件与检索） |
| data-engineer（宋渠） | 数据管道与建模：ETL、表结构变更、数据质量修复 | 不做业务取数（需求经 bi 转译） |
| finance（周正） | 财务口径权威：税 / 权责 / 收付口径裁定 | 不做系统化取数（测算用 csv_analyze / calc） |

切割原则：「**取数归 bi、解读归 insight、治数归 data-engineer、财务口径归 finance**」；交付路径互不覆盖（`docs/BI分析-` / `docs/经营分析-` / 数据工程类 / `docs/财务测算-`）。

### 46.2 场景与角色资产

- 场景 `agents/bi/_group.yaml`：id `bi` / 商业智能 / icon `database` / theme `#ec4899`（pink，第 16 个场景色）/ order 65（finance 与 ops 之间）/ chain `[bi]`（单角色，同 wealth / travel 先例）；
- 角色 `agents/bi/bi/AGENT.md`（沈析 / BI 分析师 / BI Analyst / temperature 0.3——取数需严谨）：四段骨架 + 交付契约 `docs/BI分析-<主题>.md`（问题与口径 / 数据来源与探索 / 查询与结果 / 可视化与解读 / 附录：SQL 与口径 / 数据质量说明）；
- handoff：`[insight, finance, data-engineer]`（取数结论交解读、财务口径交裁定、管道问题交治理）；
- 工具白名单：文件集（`list_dir` / `read_file` / `write_file` / `edit_file` / `apply_patch` / `search_text` / `glob` / `grep`）+ 数据库只读三件套（`db_list_connections` / `db_schema` / `db_query`）+ 业务工具（`csv_analyze` / `calc` / `date_calc`）+ 协作基线（`write_todos` / `load_skill` / `remember` / `handoff` / `request_approval`）；
- 头像：512×512 3D 卡通（粉西装 + 手持图表平板），缺失时回退 `database` 图标 + pink 渐变（新注册 `database` 到 `avatar-icons.ts`）。

### 46.3 NL2SQL 取数管道（六步法）

1. **口径澄清**：五要素（指标定义 / 时间窗 / 粒度 / 过滤 / 对比基准）；不明确时 `request_approval` 确认或显式列假设，禁止默默替用户定义口径；
2. **库表探索**：`db_list_connections`（未绑定时提醒用户在右侧面板「连接」页签绑定）→ `db_schema`（表 / 列 / 主键 / 可空）→ 小样本 `SELECT ... LIMIT` 抽查（枚举值 / 格式 / 空值率 / 量级）；
3. **SQL 生成**：显式列名（禁 `SELECT *`）、JOIN 显式 `ON` 且先验键唯一性（防一对多放大）、`GROUP BY` 完整、`COUNT(DISTINCT)` 与 `COUNT` 口径区分、时间窗左闭右开且时区显式、探索查询必带 `LIMIT`；
4. **执行校验**：`db_query`（单语句只读；结果默认展示前 30 行）+ 校验清单（行数量级 / 总量交叉 / NULL 分母 / 主键去重 / 单位量级 / 时间边界）；
5. **解读呈现**：结论先行 + `chart` / `mermaid` 渲染（data-visualization 技能选图规则）+ 口径就近标注；
6. **口径沉淀**：SQL 原文与执行信息（连接名 / 日期）入交付件附录；跨任务口径 `remember` 固化；数字可追溯三要素（SQL + 口径 + 连接）缺一不写进结论。

### 46.4 场景协议：取数纪律

新增 `agents/bi/_protocol.md`（`<scene_protocol scene="bi">`，四个场景协议之一），六条铁律：

1. **口径先行**：取数前对齐五要素；口径不明确时确认或标注假设，禁止默默替用户定义；
2. **只读取数**：只做只读查询，不写库 / 不建表 / 不导数（无 `db_execute`）；结构变更与管道问题交 data-engineer；
3. **SQL 纪律**：单条语句、显式列名、探索必带 `LIMIT`、时间范围显式、大表先小样本试跑；
4. **结果校验**：sanity check 先行；库侧与文件侧交叉对账（`csv_analyze`），不一致不得静默取一；
5. **数据安全**：明细脱敏（客户名 → 客户 A / 订单号 → \*\*\*1234）、未脱敏明细不落盘、样本量 < 5 不做个体结论；
6. **可复现**：交付件附录含 SQL 原文与执行信息；不可复现的数字不进结论。

### 46.5 技能层

- 新增 `skills/nl2sql`（NL2SQL 取数手册，约 90 行）：六步法 + SQL 生成规范（7 条）+ 执行校验清单（6 项）+ 常见陷阱表（口径漂移 / JOIN 放大 / 计数混用 / 时区偏移 / 样本偏差）+ 工具衔接（`db_*` 延迟加载经 `tool_search` 激活的引导）；
- bi 预载三技能：`nl2sql`（核心）+ `data-visualization`（呈现）+ `spreadsheet-modeling`（文件侧分析）；技能库 39 → 40；
- 快速组队预设 +1：`data-briefing`（数据快报：bi 取数 → insight 解读 → finance 核口径），预设 10 → 11。

### 46.6 引擎与安全（零工具代码改动）

- **零改动**：`db_*` 工具实现 / `forAgent` / 延迟披露 / 审批门语义全部不变；本批仅资产（场景 / 协议 / 技能 / 图标 / 预设）与测试适配；
- **只读边界**：bi 不持 `db_execute`（与 qa 只读三件套同先例）——写操作转交 data-engineer，需连接「允许写入」+ 会话绑定 + 审批三重护栏的场景不在 BI 职责内；
- **延迟披露兼容**：`db_*` 保持 `tier='deferred'`（ADR 54），初始不进工具清单；AGENT.md / 场景协议 / nl2sql 技能三处显式引导「先 `tool_search` 检索『数据库 / SQL / schema』激活再使用」，`<tool_discovery>` 区块的「数据库」分组概览提供发现面兜底；
- **数据安全**：明细脱敏与样本量约束上收为场景协议铁律（第 5 条），与 finance 协议的敏感信息条款对齐。

### 46.7 验证

- 数据面：`server/tests/m30-bi-nl2sql.test.ts`（12 断言）——bi 场景元数据 / 编制链 / 排序；沈析 handoff 与 temperature；db 只读三件套可达且不含 `db_execute`；文件侧与协作基线工具齐备；`createDbTools()` 全员维持 `deferred`（渐进披露契约）；`nl2sql` 技能正文含六步法与纪律关键词；bi 协议六条铁律在场；
- 适配：`m21.test.ts` 场景列表 +1（16 场景）/ 角色总数 67 / 场景协议断言 +bi / 预设 11 条（`data-briefing`）；
- 资产与回归：`npm run check:agents`（16 场景 / 67 角色）/ `check:skills`（40 技能）/ `npm run eval`（mock 15 个 golden 任务零回归）/ server + client vitest 全绿；
- 手工验收：绑定一个 SQLite / MySQL / PostgreSQL 连接后，在新会话选择 bi 角色提问「上季度各渠道订单量与客单价」，观察 `tool_search` 激活 → `db_schema` 探索 → `db_query` 取数 → 交付件附 SQL 与口径附录的完整链路；未绑定连接时应收到「右侧面板「连接」页签绑定」提示而不报错。

## 47. SRE 场景与 SSH 事故响应管道（M32）

新增「站点可靠性」场景（sre）与 SRE 工程师（江屿），把 M23 已建成的 SSH 远程执行能力（会话绑定 / allowExec 开关 / 审批门 / 30s 超时与输出截断）组合成一条 **生产事故响应管道**：分级 → 止血 → 证据采集 → 定位 → 修复验证 → 复盘。零新增工具代码（资产层 + 方法论文档）；决策与被否决方案见 ADR 57。

### 47.1 定位：与既有角色的职责切割

| 角色 | 管什么 | 不管什么 |
| --- | --- | --- |
| **sre（江屿，SRE 工程师）** | 生产运行态：事故分级与止血、SSH 只读诊断与证据链、SLO 与错误预算、容量评估、无责复盘 | 不提交代码（git 只读，修复交 backend）；不执行发布 / 回滚（交 devops）；不做回归验证（交 qa） |
| devops（奥托，交付工程师） | 发布与交付：CI/CD 流水线、部署与回滚执行、运行手册 | 不做事故分级与时间线主编（事故由 sre 主导，devops 配合执行） |
| backend（马克斯，后端工程师） | 代码缺陷修复（事故根因归属代码缺陷时接手） | 不做线上诊断与止血（证据链由 sre 提供） |
| qa（诺娃，测试工程师） | 回归验证与质量把关 | 不做生产运行态诊断 |

切割原则：「**运行态保障归 sre、变更交付归 devops、代码修复归 backend、回归验证归 qa**」；交付路径互不覆盖（`docs/事故复盘-` / `docs/可靠性方案-` / 部署类 / 测试类）。

### 47.2 场景与角色资产

- 场景 `agents/sre/_group.yaml`：id `sre` / 站点可靠性 / icon `activity` / theme `#84cc16`（lime，第 17 个场景色）/ order 15（development 与 brainstorm 之间——可靠性职能紧跟研发）/ chain `[sre]`（单角色，同 wealth / travel / bi 先例）；
- 角色 `agents/sre/sre/AGENT.md`（江屿 / SRE 工程师 / Site Reliability Engineer / temperature 0.3——事故处理需冷静严谨；开场白「先止血，再谈根因」）：四段骨架 + 交付契约 `docs/事故复盘-<主题>.md`（影响摘要 / 时间线（证据出处）/ 根因分析 / 处置过程 / 改进项表）与 `docs/可靠性方案-<主题>.md`（SLI 与 SLO / 错误预算与告警 / 容量评估 / 演练计划）；
- handoff：`[devops, backend, qa]`（发布回滚交奥托、代码修复交马克斯、回归验证交诺娃）；
- 工具白名单：文件集（`list_dir` / `read_file` / `write_file` / `edit_file` / `apply_patch` / `search_text` / `glob` / `grep`）+ 远程诊断（`ssh_exec`）+ 本地验证（`run_command`）+ git 只读三件套（`git_status` / `git_diff` / `git_log`，不含写类——变更定位）+ 度量与检索（`calc` / `date_calc` / `web_fetch` / `web_search`）+ 协作基线（`write_todos` / `load_skill` / `remember` / `handoff` / `request_approval`）；
- 头像：512×512 3D 卡通（炭灰技术卫衣 + 青柠挂饰 + 脉冲监控手持终端；v17 全角色头像重设计版，设定表见 §19.3），缺失时回退 `activity` 图标 + lime 渐变（新注册 `activity` 到 `avatar-icons.ts`）。

### 47.3 事故响应管道（六步工作法）

1. **分级与止血**：影响面（谁受影响 / 多大范围）与开始时间 → SEV1-3 分级；恢复服务优先于根因分析——回滚 / 降级 / 扩容 / 限流都是止血手段；
2. **证据采集**：`ssh_exec` 只读命令库（服务状态 / 日志 / 磁盘 / 内存 / 端口 / 健康检查 / 内核日志）逐条记录 exit code 与输出摘要；未绑定连接时提示用户在右侧面板「连接」页签绑定；
3. **定位**：变更即可疑——先核对最近变更（`git_log` / 发布记录 / 配置修改时间），无变更再排查资源（OOM / 磁盘满 / 连接耗尽）与依赖（下游超时 / DNS / 证书）；
4. **修复与验证**：变更类命令先说明影响范围与回退方式，经用户审批后执行；修复后确认服务恢复（健康检查 + 关键指标）并设观察窗口（如 10 分钟）；
5. **复盘**：时间线（统一时区 + 证据出处）+ 根因（5 Whys，可证伪）+ 改进项表（行动 / owner / 期限 / 验证方式）；MTTD / MTTA / MTTR 用 `date_calc` 核算；
6. **沉淀**：SLO 口径与容量基调用 `remember` 固化；高频故障的处置步骤固化为运行手册（runbook）。

### 47.4 场景协议：事故纪律

新增 `agents/sre/_protocol.md`（`<scene_protocol scene="sre">`，第五个场景协议），七条铁律 + 协作三条：

1. **证据先行**：先采集证据（服务状态 / 日志 / 指标 / 时间线）再下结论；不删改日志；假设必须可证伪，与证据冲突时改假设而不是改证据；
2. **止血优先，变更报批**：恢复服务优先于根因分析；一切变更类远程命令（重启 / 停服 / 删除 / 改配置）先说明影响范围与回退方式，经用户审批后执行（`ssh_exec` 每次调用均经审批门，审批 ≠ 免责）；
3. **SSH 使用纪律**：诊断默认只读命令；`ssh_exec` 为延迟加载工具——先 `tool_search` 检索「SSH / 远程 / 日志」激活再使用；单条非交互命令（默认 30s 超时 / 上限 120s）——长任务拆分为可超时的分段命令，交互会话引导用户在「终端」页签操作；未绑定连接提示绑定；
4. **变更即可疑**：定位阶段优先核对最近变更（`git_log` / 发布记录 / 配置修改时间）；
5. **时间线纪律**：所有时点统一时区并记录来源（证据出处）；MTTD / MTTA / MTTR 用 `date_calc` 核算，不拍脑袋；
6. **复盘无责**：对事不对人；改进项必须带「行动 / owner / 期限 / 验证方式」四要素；「加强监控」这类无验收标准的表述不得作为行动项；
7. **数据安全**：生产日志与配置中的敏感信息（IP / 凭据 / 客户数据）脱敏后再写入交付件；
8. **分工**：sre 管生产运行态（告警 / 事故 / 容量 / 可靠性度量）；devops 管发布与流水线；backend 管代码缺陷修复；qa 管回归验证——事故处置由 sre 主编时间线，修复责任按根因归属交接；
9. **与 development 场景交接**：事故根因为代码缺陷时 `handoff` 交 backend（附最小复现 + 证据链）；发布流程或流水线问题交 devops；修复后由 qa 回归验证；
10. **数据丢失风险处置**：删数据 / 回滚数据迁移 / 清空队列必须先 @用户 确认，禁止自行执行。

### 47.5 技能层

- 新增 `skills/incident-response`（事故响应手册，82 行）：SEV1-3 分级表 + 五步响应 + SSH 诊断命令库（systemctl / journalctl / df / free / dmesg / top / ss / curl 健康检查 / lsof / date）+ 定位检查表 + 时间线与度量（MTTD / MTTA / MTTR）+ 无责复盘模板 + SLO / 错误预算基础 + 反模式；
- sre 预载两技能：`incident-response`（核心）+ `debugging`（复用 M29 缺陷定位六步法，根因排查方法论）；技能库 40 → 41；
- 快速组队预设 +1：`incident-response`（线上故障响应：sre 止血 → devops 回滚 → backend 修复 → qa 回归），预设 11 → 12。

### 47.6 引擎与安全（零工具代码改动）

- **零改动**：`ssh_exec` 实现 / 会话绑定 / `allowExec` 开关 / 审批门 / 30s 超时 / 256KB 截断全部不变；本批仅资产（场景 / 协议 / 技能 / 图标 / 预设）与测试适配；
- **权限边界**：`ssh_exec` + `run_command` + git 只读三件套（不含 `git_branch` / `git_commit` / `git_restore`，与 qa `db_*` 只读三件套同先例）——SRE 不提交代码，修复经 `handoff` 交实现者；不持 `db_*`（数据取数归 bi 场景）；
- **四层安全链沿用**（M23 建成，本批不改动）：会话绑定校验 → 连接级「允许 Agent 执行命令」开关 → 每次调用审批门 → 超时与输出截断；
- **延迟披露兼容**：`ssh_exec` 保持 `tier='deferred'`（ADR 54），初始不进工具清单；AGENT.md / 场景协议第 3 条 / incident-response 技能三处显式引导「先 `tool_search` 检索『SSH / 远程 / 日志』激活再使用」，`<tool_discovery>` 区块的「SSH 远程」分组概览提供发现面兜底；
- **审批门语义**：`allowExec` 未开启时工具报错并提示开启路径；每次 `ssh_exec` 调用均弹审批卡——协议层明确「审批 ≠ 免责」，变更类命令仍需说明影响与回退方式。

### 47.7 验证

- 数据面：`server/tests/m32-sre.test.ts`（16 断言）——sre 场景元数据 / 编制链 / 排序；江屿 handoff 与 temperature；`ssh_exec` + `run_command` + git 只读三件套可达；git 写类与 `db_execute` 不持有；度量与协作工具齐备；**运行时绑定**（`forAgent` 真实解析全部白名单工具——`resolveTools` 对未知名静默丢弃的守护）与 **plan 范式收敛**（只读集合含 git 只读三件套、不含 `ssh_exec` / `run_command`）；`createSshTools()` 全员维持 `deferred`（渐进披露契约）；`incident-response` 技能在场（描述含触发场景 + 正文含止血 / SEV / 命令库关键词）；sre 协议十条纪律在场；devops 保留 `git_commit` + `ssh_exec`（发布通道不回退）；
- 适配：`m21.test.ts` 场景列表 +1（17 场景）/ 角色总数 68 / 场景协议断言 +sre / 预设 12 条（`incident-response`）；
- 资产与回归：`npm run check:agents`（17 场景 / 68 角色）/ `check:skills`（41 技能）/ `npm run eval`（mock 15 个 golden 任务零回归）/ server + client vitest 全绿；
- 手工验收：绑定一个 SSH 连接并开启「允许 Agent 执行命令」后，在新会话选择 sre 角色提问「线上订单服务响应变慢，先处理」——观察 `tool_search` 激活 → `ssh_exec` 只读采集（systemctl / journalctl / df）→ 分级与止血建议 → 审批门弹卡的完整链路；未绑定连接时应收到「右侧面板「连接」页签绑定」提示；未开启执行开关时应收到开关提示而不报错。

## 48. 专业级附件体系与多模态通道（M33）

M33 解决「附件在对话中只是文本引用」的体验断层：发图后模型看不到图（纯文本通道）、发 Office / PDF 后模型不知道内容（`read_file` 按 utf8 读取二进制直接拒读）、视频 / 音频只能给路径、消息气泡里附件只是 `@file:xxx` 一行文本。本批明确「**不用 Markdown 扩展**」——附件在消息内以组件级原生视图渲染（图片网格 / 视频播放器 / 音频条 / 文档卡），并打通「上传 → 识别 → 处理」全链路（视觉注入 / 文档文本提取 / 媒体元数据），交互对齐 Slack / Linear / ChatGPT 的托盘范式。

### 48.1 定位：两条上传通道并存

| 维度 | M8 通道（base64） | M33 通道（附件直传） |
| --- | --- | --- |
| 端点 | `POST /sessions/:id/uploads` | `POST /sessions/:id/attachments` |
| 编码与上限 | base64（体积膨胀 33%）/ ≤8MB | raw 二进制 / ≤200MB |
| 交互范式 | 上传 → 插入 `@file:path` 文本引用 | 附件托盘（缩略图 / 进度 / 可删）→ 消息内原生渲染 |
| 适用 | 小文件手动引用 | 图片 / 视频 / 音频 / Office / PDF 正式附件 |

两条通道产物同为 `uploads/` 下普通交付件（`artifact:updated` 广播），交付件面板 / Office 预览 / `@file` 候选全部复用；M8 通道与其存量测试零改动。

### 48.2 服务端上传端点与安全

- **端点**：`server/src/routes/attachments.ts`——raw body（`express.raw` ≤200MB，挂载在全局 json 4MB 限制之前，避免大文件被通用解析器拦下）；
- **协议**：文件名经 `x-file-name`（URL 编码）传递、媒体元数据经 `x-file-metadata`（JSON `{ durationMs, width, height }`）可选传递（非法 JSON / 越界值静默丢弃，不阻断上传）；
- **文件名安全化**：`safeFileName`——basename + 白名单字符（中英文 / 数字 / `._-`，其余替换为 `_`）+ 去前导点（防隐藏文件）+ 截断 120 字符 + 防路径穿越；
- **类型白名单**：五类扩展名（图片 / 视频 / 音频 / Office-PDF-文本 / 压缩包），可执行与脚本类拒绝（`400`）；
- **元数据可信化**：图片尺寸由服务端解析文件头（`util/image-meta.ts` 零依赖探测 png / jpeg / gif / webp / bmp，覆盖客户端元数据——不可伪造）；视频时长 / 分辨率取客户端媒体元数据（服务端无解码能力，弱可信、仅展示）；
- **落盘与广播**：`uploads/<ts36>-<name>`（时间戳 36 进制前缀防同名覆盖）→ 纳入交付件体系（`artifact:updated`）→ 响应 `201 { attachment: MessageAttachment }`（`path / name / kind / mime / size / width? / height? / durationMs? / uploadedAt`）。

### 48.3 多模态视觉注入（装配器三级护栏）

- **通道**：`LlmMessageInput.content` 放宽为 `string | LlmContentPart[]`（`{ type: 'text' } | { type: 'image_url' }`）；provider / openai 适配层透传消息数组，图片以 data URL 注入；
- **装配**：`buildWindow` 在窗口填充完成后**从后往前**为最近的图片附件构建多模态内容块（最近的消息最可能被追问）；
- **三级护栏**：全窗 ≤6 张 / 单条消息 ≤4 张 / 单图 ≤8MB（data URL 膨胀后仍低于模型请求体限制）；
- **文本占位**：未注入（超配额 / 超体积 / 读取失败 / 非视觉格式如 svg）的附件保留 `[附件]` 清单块（文件名 + 类型 / 尺寸 / 时长 / 体积），Office / PDF 附「可用 read_file 读取内容」引导——模型可感知附件存在并采取替代路径，优于静默丢弃；
- **计量同源**：视觉 token 按 `VISION_TOKENS_PER_IMAGE = 800` 计入窗口计量（`tokenizer.ts` 与装配器共用常量，压缩水位不低估多模态成本）；
- **可见性边界**：纯附件消息（无正文）同样进入上下文窗口——可见性过滤条件含 `attachments`，否则「只发一张图」的消息会被整体丢弃。

### 48.4 文档识别管道（read_file 增强）

- **零依赖提取器** `util/document-extract.ts`（不引入 pdfjs / mammoth / sheetjs）：
  - docx → 复用 office-preview 的 OXML → HTML → 文本（标题 / 列表 / 表格）；
  - xlsx → 工作表头 + TSV；
  - pptx → 幻灯片大纲；
  - pdf → 自实现（zlib inflate 解压流 + BT/ET 文本算子状态机 + 字面量 / UTF-16BE hex 字符串还原 + 乱码质量护栏——可打印字符占比过低时提示「疑似扫描件 / 字体编码不支持」而非输出垃圾）；
  - 输出上限 40 万字符（防超大文档挤爆上下文）；
- **read_file 分流**（`server/src/tools/builtin.ts`）：`.docx / .xlsx / .pptx / .pdf` 自动提取正文（≤32MB，超限引导拆分或改用 `search_text`）；二进制媒体（图片 / 音视频 / 压缩包）不做像素级读取，按类别给出可行动提示（图片提示「随附件以视觉输入提供」、音视频提示时长与关键帧截图、压缩包建议解包）；文本文件维持 M-5 体积预检（>8MB 拒绝）——M-5 存量用例已适配为文本 fixture（二进制路径不再触发读取，无内存风险）。

### 48.5 前端：托盘范式与消息内原生渲染

- **附件托盘**（`components/chat/AttachmentTray.tsx`）：拖拽 / 粘贴 / 选择文件 → 逐项上传——图片 / 视频显示本地 object URL 缩略图（发送前零网络预览）、文档显示类型化文件卡（图标 + 标签 + 体积）、上传中进度条、失败标红 + 原因、× 移除（上传中的项同时取消本地预览）；`apiUpload` 基于 XHR `upload.onprogress` 报告进度；发送前 `uploading` 状态拦截（不允许发送半成品附件）；
- **消息内原生渲染**（`components/chat/MessageAttachments.tsx`，按类型分流，**不做 Markdown 降级**）：
  - 图片网格：1 张大图（真实宽高比防布局跳变）/ 2-4 张两列 / 5+ 三列 + `+N` 收尾（最多 9 张）→ 点击 Lightbox（多图 ← → 键与按钮切换 / 计数 / Esc 与遮罩关闭）；
  - 视频：封面式播放器（首帧 + 播放键 + 时长 / 分辨率角标）→ 点击切换内联 controls 播放；
  - 音频：紧凑播放条；
  - 文档：类型图标卡（名称 + 体积）→ 点击 `requestArtifact` 打开右侧交付件面板（Office 服务端解析 / PDF iframe / 视频 Range 直出——复用 M24 / M30 既有能力）+ 下载直链；
- 附件块与正文并存（附件在上、正文 Markdown 在下，`mb-2` 间距）；Composer 引导文案更新为「可直接拖拽或粘贴图片 / 文档」。

### 48.6 持久化与会话链路

- **数据模型**：`ChatMessage.attachments?: MessageAttachment[]`（`shared/src/types.ts`）；DB 迁移 v9 为 `messages` 表增加 `attachments` 列（JSON 双写），消息重放 / fork / 重生成链路天然携带附件；
- **发送校验**：`sendMessageSchema` 校验 `attachments ≤10` + refine「正文或附件至少提供一个」（纯附件消息合法）；服务端发送时二次校验（`path` 必须以 `uploads/` 开头 + `resolveSafe` 真实存在——防伪造路径指向工作区外文件）；
- **会话命名**：纯附件消息以首个附件名兜底命名会话（无正文时不再落到「新会话」）；
- **CLI 兼容层**：`textOfContent(content)`（`llm/content.ts`）统一提取多模态数组的纯文本（mock provider / tokenizer / 压缩器 / 测试共用，避免多份实现漂移）。

### 48.7 验证

- 数据面：`server/tests/m33-attachments.test.ts`（13 断言）——上传端点（直传落盘 + 尺寸覆盖 / 白名单拒绝且不落盘 / 空体 / 文件名安全化 / 元数据取整与越界丢弃）；schema refine；发送集成（防伪造路径 / 上传→发送→DB 双端持久化 / 会话命名）；装配护栏（从后往前配额 / 超体积与读取失败跳过且补位 / 纯附件进窗口 / svg 不注入）；
- 识别面：`server/tests/m33-document-extract.test.ts`（13 断言）——docx / xlsx / pptx / pdf 四格式提取、乱码护栏、read_file 分流（文档自动提取 / 二进制提示 / 超限拒绝）；
- 组件面：`client/tests/m33-attachments.test.tsx`（11 测试）——托盘三态（空 / 上传中进度 / 完成与失败）、消息内四类渲染（图片网格 + Lightbox 切换 / PDF 文档卡跳转 / 视频封面切换 / 音频条）、Composer 附件流（选择 → 上传 → 发送携带 → 清空 / 上传中拦截 / 白名单拦截 / 移除后禁止发送）；
- 端到端：`e2e/m33-attachments.spec.ts`——`setInputFiles` 双图 → 托盘出现 → 纯附件发送 → 消息内图片 → Lightbox 切换与 Esc → 交付件面板可见；
- 回归：server vitest 53 文件 / 690 测试全绿；client 全量 39 文件 / 430 测试全绿；`tsc --noEmit`（server / client / shared / e2e）四包全绿；存量适配两处（store 迁移版本断言 9 / tools 的 M-5 用例改文本 fixture）；
- 手工验收：拖拽两张图片 + 一个 docx 到 Composer → 托盘显示缩略图与文档卡（进度 → 完成）→ 附一句说明发送 → 消息内图片网格 + 文档卡 → 点击图片 Lightbox 切换、点击文档卡右侧交付件面板预览 → 追问「刚才的图里有什么 / 文档讲了什么」，回答应基于视觉注入与文档提取文本；发送一张 >8MB 的图片应看到文本占位说明而非视觉理解。

## 49. 无限画布与媒体创作工作台（M31）

M31 把「创作」从对话消息流中解放出来：主区新增「画布」Tab（与对话 / 交付件 / 数据库 / 终端并列）——会话级空间化工作台，全场景通用（任何场景任何角色可用）。四大用途：**无限脑图**（对话 / 计划 / 任务 / 记忆 → 结构化脑图，Xmind 式编辑与导出 Markdown）、**媒体创作**（文生图 / 图生图 / 文生视频 / 图生视频 / 首尾帧视频，画布上直生 + 批量变体 + 历史再生成）、**Agent 协作**（`canvas_read / canvas_write / media_generate / media_video` 接通全角色，agent 产出自动上画布、画布节点可引用回对话）、**素材墙**（拖拽上传 / 交付件引用 / 消息「送上画布」，统一落交付件体系）。零新增核心依赖：复用协作图谱已引入的 `@xyflow/react` v12（决策记录见 ADR 59）。

### 49.1 数据模型与边语义

- **画布粒度：会话级单文档**——`data/canvas/<sessionId>.json`（JSON 单文档 + `version` 乐观锁 + tmp/rename 原子写 + debounce flush，对齐 settings 原子写模式）；`PUT` 带 `baseVersion`，冲突 `409` 回传服务端最新版，前端在本地空闲时拉取合流；
  预留全局素材库扩展位（本期不实现）。
- **7 类节点**（节点类型注册表可扩展）：image（artifact / prompt / 模型参数 / 生成谱系）/ video（播放 / 首尾帧标记）/ note / prompt（可作生成输入）/ mind（折叠 / 层级色）/ artifact（跳交付件）/ group（画框 / 可命名 / 可拖入包含）；
- **边三分语义**：`flow` 实线流动（生成数据流；生成中能量流动动效，复用协作图谱 RelayEdge 技法）/ `mind` 层级曲线 / `ref` 虚线关联——视觉语言与协作图谱同源。

### 49.2 服务端：画布文档与路由

- **文档存储** `server/src/canvas/store.ts`：内存缓存 + debounce flush + 原子写；`applyOps`（agent 写入，读-改-写）：add_node 缺省 `nd_*` id + `autoPosition`（空画布原点、否则右缘 +80 纵向对齐最上方）、connect 去重与悬空跳过、remove_node 级联删边，结束 `version+1` + 落盘 + 广播（`by='agent'`）；
- **路由** `server/src/routes/canvas.ts`：`GET/PUT /sessions/:id/canvas`（GET 附 `mediaBound` 供面板引导）、`POST /sessions/:id/canvas/mind`（脑图生成）、`POST /sessions/:id/media/upload`（素材直传：`express.raw` ≤200MB，落 `canvas/media/up-*` 成为交付件）；
- **脑图生成** `server/src/canvas/mind.ts`：按来源（conversation / plans / tasks / memory / topic）组装上下文 → summaryModel 结构化 JSON 树（失败给明确错误而非空结果）。

### 49.3 媒体生成：连接中心与四适配器

- **连接**：`ConnectionKind` 增加 `'media'`（config：`provider / baseUrl / models / capabilities / workflows? / template? / timeoutMs?`；secret：`apiKey?`——复用 SecretVault 加密与「明文永不回传」纪律）；连接中心为 media 类提供表单（提供方 / 地址 / 能力多选 / 工作流 JSON / 模板三段式 / 测试按钮）；
  未绑定会话在工具与生成面板均给「去绑定」引导（最小权限不变式）；
- **四适配器**（`server/src/media/adapters/`，零依赖）：`comfyui`（POST /prompt 提交 + 工作流占位符 `{{prompt}}/{{image}}/{{first_frame}}/{{last_frame}}` 深替换 + 输入图 /upload/image + 轮询 /history（期间 /queue 报位次）+ /view 取件 + /interrupt 取消；内置默认 txt2img 工作流）、`sdwebui`（/sdapi/v1/txt2img|img2img + /progress 报进度 + /interrupt 取消）、`openai-compat`（/images/generations|edits，b64_json 或 url）、`task-template`（提交-轮询-取件三段式：create 模板 + poll 间隔 / 超时 + extract 状态 / 进度 / 结果 URL 点路径，变量插值）；
- **任务管线** `server/src/media/service.ts`：状态机 queued → running → succeeded / failed / canceled；并发上限默认 2；超时护栏（图像 5min / 视频 10min，连接 `timeoutMs` 可覆盖）；每任务一个 AbortController（取消含远端取消）；产物落 `workspace/<sid>/canvas/media/gen-*.ext` 成为普通交付件（`artifact:updated` 广播）；进度节流广播 `notify:media-job`；
- **路由** `server/src/routes/media.ts`：任务创建 / 会话历史（内存，每会话最近 50 条）/ 单任务 / 取消 / 重试 / `GET /media/providers`（会话已绑定连接的可用能力 / 模型 / 工作流清单，面板与工具共用）。

> **M56 修订（ADR 0124 / §76）**：本节媒体连接的配置入口与**会话绑定**语义已收口——配置入口迁「设置 → 媒体生成」（连接管理不再呈现 media 类；四适配器与任务管线不变），未配置时工具与生成面板引导「去设置」而非「去绑定」；`GET /media/providers` 改全局启用连接清单（无 `sessionId`），`mediaBound` 改全局语义（全局存在启用中的媒体连接）。

### 49.4 前端：画布内核

- **入口**：`ui-store` 的 `MainTab` 加 `'canvas'`，AppLayout Tab（窄屏同样可用）+ `React.lazy` 懒加载画布 chunk（对齐 GraphView 模式）；
- **`stores/canvas-store.ts`**：受控更新（复用未变节点引用 / 保留 `measured` 与 `selected`——协作图谱踩坑纪律 + ADR 93）、undo/redo 快照栈（深度 50，拖拽起点前压栈）、节点 / 边 CRUD 与剪贴板、dirty/autosave（debounce 800ms + `baseVersion`）、远端 `notify:canvas-changed` 空闲合流、`sendArtifact`（外部产物上画布统一入口）与 pendingAction 动作通道（命令面板驱动，lazy 挂载后消费不丢动作）；
- **`CanvasView.tsx`**：ReactFlow 容器（selectionOnDrag 左键框选、Space + 中键平移、滚轮 / 捏合缩放 0.1–4、点击 / 拖动阈值统一 4px 消除吞 click 死区（ADR 93）、fitView 对齐图谱 FIT_MAX_ZOOM 口径）、Background Dots、可折叠 MiniMap、Controls；工具栏（添加 / 上传 / 模板 / 整理布局 / 适应视野 / 导出）+ 双击空白 CreateMenu + 右键 NodeContextMenu（上移下移 / 复制 / 删除 / 引用到对话 / 生成变体 / 设为首尾帧）+ 拖拽上传 + 对齐参考线 + 快捷键；
- **7 类节点组件 + FlowEdge**（`components/canvas/nodes/`）：统一骨架（选中描边 / 悬停操作行 / NodeResizer 图片视频便签画框），FlowEdge 三语义渲染 + 生成中能量流动；
- **`GenerationPanel.tsx`**（右侧浮动）：能力切换（文生 / 图生）/ prompt 与负面词（自动取上游 prompt 节点）/ 模型（连接声明）/ 尺寸步数种子数量 / 工作流模板选择 / 生成（⌘Enter）/ 进度与取消 / 会话历史（再生成 / 变体）；
- **`EmptyCanvas.tsx`** 四模板卡片（创作台 / 脑图工坊 / 分镜台 / 素材墙）+ 模板落位动画；**动效**（index.css `canvas-*` 段，全部响应 `.quiet-mode`）：节点入场 pop、生成骨架呼吸、完成 burst 光环、连线能量流动、拖拽上传边缘光效、对齐参考线。

> **M31 修订（ADR 0138，2026-09-19）**：画布交互深化与效果优化（对标专业无限画布；完整设计见 [docs/canvas-ux-design.md](docs/canvas-ux-design.md)）——① **能力门控**：未配置生图 / 生视频时，工具栏「媒体生成」、节点右键生成段、空画布「创作台 / 分镜台」模板、图片 / 视频节点空态生成话术全部不出现（`useMediaCapabilities` 按 canImage / canVideo 拆分；`media-store` 增 `providersLoaded` + `ensureProviders` 幂等源，画布挂载即拉取；「设置 → 媒体生成」保存 / 启停 / 删除后 `refreshProviders` 即时同步；生成面板与 Agent 工具兜底引导不变）；② **导航手感**（Figma / tldraw / Excalidraw 范式）：滚轮 / 双指 = 平移（`panOnScroll`）+ ⌘/Ctrl 滚轮 = 缩放、H / V 工具切换（hand 态左键拖拽平移 + grab 光标）、Space 临时平移、右下**缩放指示器**（实时百分比 + 步进 + 缩放到 100% / 适应视野 / 缩放到选区）、**⇧0 · ⇧1 · ⇧2** 快捷键（浏览器保留键 ⌘0 / ⌘1 避让，按 `e.code` 判定）、「对齐网格 10px」吸附开关（与智能参考线互斥，`snapToGrid`）；③ **反馈层次**：选中节点**关联边高亮**（受控边 data.related 视图层派生，不落文档）、拖拽节点**抬升**（独立 `scale` 属性避让入场动画 transform 填充）、框选框与 Controls 主题化（`--xy-selection-*` / `--xy-controls-*` 变量 + `.canvas-stage` 容器）、快捷键帮助新增「画布」分组；验证：client `m31-canvas-ux`（11，门控四组件 + 工具开关 + 生成入口注入）、`m31-canvas`（+3 门控口径）、E2E `m31-canvas-ux`（4：未配置隐藏 / 配置后出现并自清理 / 缩放指示器与快捷键 / 滚轮·手型手感）。

### 49.5 脑图工坊

- **纯函数层** `client/src/lib/mind.ts`：树操作（加子 / 加兄弟 / 删除子树 / 重挂 / 折叠 / 扁平化）、dagre 树布局、markdown 大纲解析与导出；
- **`MindDialog.tsx`**：来源选择（对话 / 计划 / 任务 / 记忆 / 主题）+ 生成中骨架 → 树落位展开动画；画布上 Xmind 式快捷编辑（Tab 子节点 / Enter 兄弟 / 折叠 / 一键整理）+ 导出 Markdown；mind 节点 / 边与 flow 语义分离（层级曲线）。

> **M31 修订（ADR 0180，2026-09-19）：脑图节点长文本折行**——渲染去 `whitespace-nowrap` + `break-words`（长文本在文本区 208px 内折行、不再溢出胶囊）、圆角 `rounded-2xl`（单行仍近胶囊 / 多行层次更稳）、编辑态 input 限宽；`estimateMindSize` 高度按折行行数展开（`34 + 20×(lines-1)`；token 贪心折行模拟：CJK 逐字 / 拉丁按词 / 超宽词硬拆），宽度公式不变——dagre 布局 / 加子落位 / 重挂命中 / 拖拽重挂检测全链随多行尺寸自动受益；同源常量（MIND_TEXT_MAX_W / MIND_LINE_H / MIND_BOX_BASE_H）与渲染样式成对维护。验证：client `m31-mind` 26 例（含折行断言），E2E `m31-canvas-ux`（7）+ `m31-canvas-interactions` 回归绿。

### 49.6 Agent 闭环与联动

- **四工具**（`server/src/tools/canvas.ts` / `media.ts`，全部 `tier='deferred'` 渐进披露）：`canvas_read`（只读；节点 / 边摘要 + 单节点 JSON）/ `canvas_write`（ops 批量：add_node / update_node / remove_node / connect / remove_edge；缺省 id 与服务端自动排布；写入广播 `by='agent'`）/ `media_generate`（text2image / image2image）/ `media_video`（text2video / image2video / firstlast2video）——「创建即返回」：同步入队后回灌 job id + 异步提示（规避工具执行窗口护栏），`canvasTarget` 由前端 media-store 在完成时自动放置；
- **白名单**：4 工具补入全部 68 角色 `tools` 字段（协作与创作能力为场景无关），`npm run check:agents` 守护注册表与白名单一致；
- **联动双入口**：消息交付件 chip hover「送上画布」与交付件面板「画布」按钮共用 `sendArtifact`（扩展名分类 → 图片 / 视频直出节点、其余 artifact 引用；落位与 server `autoPosition` 同语义）；画布节点右键「引用到对话」走既有 `insertToComposer` 通道；命令面板「画布」组（打开 / 新建便签 / 生成脑图 / 适应视野）；`ArtifactsView` 视频直出预览（Range）+「在画布打开」。

> **M31 修订（ADR 0146，2026-09-19）**：Agent 与画布联动深化（完整设计见 [docs/canvas-agent-linkage-design.md](docs/canvas-agent-linkage-design.md)）——① **任务全周期绑定**（服务端为真相）：`MediaService` 注入画布存储，**create 即落占位节点**（`data.pending=true / jobId / prompt / params`；位置 = `canvasTarget ?? autoPosition`，取消工具侧预计算使并发任务天然错开）→ 完成 **update_node 原地替换**（多余产物横向排开）/ 失败保留（error 可重试）/ 取消移除；`job.canvasNodeId / placedCanvas` 记录落位结果，前端 `placeOutputs` 删除防双写（toast 按 `placedCanvas` 分流）；不再要求「用户开着该会话画布」——未打开也可靠落位；② **写入可感知**：`applyOps(opts.by)` 注入节点作者（`CanvasNode.by`）；广播 meta 携 `touched/actor/reason` → 前端**页签未读角标**（同会话且非画布页时按 touched 计数，进画布清零）· 合流后 **ViewportPortal 写入闪环**（touched 过滤仍存在节点，一次性 1.8s，不碰节点数据）· 节点左下 **作者徽标**（NodeShell 内查 store，零侵入子组件）；③ **消息/输入侧入口**：ToolCard 画布四工具 TOOL_META（读取画布 / 画布写入 / 生成图片 / 生成视频）+ 完成态「在画布查看」；CanvasComposer「引用选中 N」chip（逐行 `quoteForComposer`）；④ **P3 遗留接线**：pending 占位的 `canvas-breath` 呼吸 + 实时进度（media-job 节流广播）、指向占位的 flow 边能量流动（`FlowEdge.flowing` 视图层派生）；验证：server m31-media（+7）/ m31-canvas-store（+3）/ m31-tools（口径更新），client m31-canvas-agent（7）/ m31-media·m36（口径），E2E m31-canvas-agent（2，含闪环/角标/徽标/pending/能量边）。

> **M31 修订（ADR 0152，2026-09-19）：画布深度完善批**——① 缺陷自愈：**僵尸 pending 占位**（服务端重启后任务丢失仍在呼吸）→ 打开画布时以 `jobsLoaded` 成功门槛拉 取任务快照，`reconcileStalePending` 把不在快照的 pending 节点转中断态（可「重新 生成」）；失败节点右键新增**「重新生成」**（按谱系参数直建，输入不齐降级回填面板）；② 内核交互补全：**画布内查找**（`searchNodes` 纯函数 + `/` 快捷键 + 定位居中/选中/闪环）、工具态记忆（手型 / 网格吸附 sessionStorage）、⌘拖拽复制（⌥ 起手 → 副本留原位）、**边重连**（合法性矩阵复用 + 保持 edge id）；③ 联动互链：`ToolCallRecord.meta` 通用结构化字段（engine 持久化；`canvas_write` / `media_*` 回灌 `canvasNodes`）→ 消息侧「在画布查看」升级为 **focus 精确定位**；生成面板任务行 hover → 节点闪环（`pulseNodes` 通道）、节点选中 → 面板行高亮；他会话 agent 写入 → 会话列表小点（切到该会话清零）；**等距吸附**（两侧夹击等距 → 吸附中点 + 玫瑰色双标记线）；④ 大画布性能档：>150 节点自动视口裁剪（<120 回差；裁剪下关闭入场动画）；⑤ 测试账本重核（§12.1：服务端 1169 例 × 客户端 990 例 × E2E 96 条 / 40 spec）。E2E 黑孔挂起任务模式（本机 socket 服务接受连接不响应）成为「任务进行中」视觉验收 的标准手法。

> **M68（ADR 0158，2026-09-19）：用户素材库**（承接 §49 预留「全局素材库扩展位」；评估与详设见 [docs/material-library-design.md](docs/material-library-design.md)）——**per-user 私人素材** + **独立菜单管理页面**（ActivityRail「素材库」全员入口 + MaterialsConsole：网格缩略图 / 预览灯箱 / 搜索筛选 / 容量条 / 拖拽上传 / hover 操作）；**归属** owner 服务端取（兼容模式 'local'；非属主 404；admin 不浏览他人素材）；**存储** `workspace/_library/u_<uid>/`（迁移 v19；配额统计增计一处 + `assertUserStorageAllowed` 用户级闸门）；**上传** 独立路径（raw ≤200MB + 图片/视频白名单）/ sendFile Range 内容流；**copy-on-use**（「放入画布」→ 入仓会话工作区 `library/ref-*` → `sendArtifact` 落节点；素材删除不回收已入仓副本）；账号删除级联（行 + 属主目录双清）；产物审批流评估结论 = 不新建（`APPROVAL_TOOLS` 配置即覆盖生成前审批）。验证：server `m68-library`（8）/ client `m68-materials`（7）/ E2E `m68-library`（2，隔离环境 8795 全绿）。

### 49.7 验证

- 数据面：`server/tests/m31-canvas-store.test.ts`（12）——读写 / 乐观锁 409 / applyOps 语义（自动排布 / 去重 / 级联）/ 广播；`server/tests/m31-media.test.ts`（20）——mock 适配器状态机 / 队列并发 / 取消与超时 / 占位符替换 / 模板插值；`server/tests/m31-mind.test.ts`（9）——mock LLM 生成 / 来源组装 / 失败明确；`server/tests/m31-tools.test.ts`（19）——未装配守卫 / 读取摘要 / 批量写入回灌 / 创建即返回 / canvasTarget 落位；
- 组件面：`client/tests/m31-canvas.test.tsx`（45）——连线矩阵 / 剪贴板 / 节点交互 / 送上画布 / 动作通道；`client/tests/m31-mind.test.tsx`（25）——树操作 / 导出 / 快捷编辑；`client/tests/m31-media.test.ts`（8）——任务快照与完成落画布；
- 回归：双端 typecheck / lint 全绿；`npm run check:agents` 通过（17 场景 / 68 角色）。

## 50. 会话级定时任务与到点协作（M35）

M35 让协作从「用户驱动」扩展到「时间驱动」：会话级定时任务——到点自动让指定成员开工（run）或只发提醒（remind）。三件套工具 `schedule_task / list_schedules / manage_schedule`（deferred）+ 右栏「定时」面板 + 到点注入消息的「定时」徽章，全部本地零网络：cron 解析 / 时区换算 / 触发计算在 shared 纯函数内核，服务端 tick 独立驱动（浏览器关闭不影响）。决策记录见 ADR 60。

### 50.1 数据与内核

- **迁移 v11**：`scheduled_tasks` 表（`id sch_*` / sessionId / title / kind / instruction / targetAgentId / spec JSON / timezone / enabled / createdBy / nextRunAt / lastRunAt / lastRunId / lastStatus / lastError / runCount / failStreak / 时间戳），`ScheduleStore`（`server/src/store/schedules.ts`）负责 CRUD 与触发留痕（settle / skip / pause 三态结算）；
- **shared 内核**（`shared/src/schedule.ts`，纯函数零依赖）：5 段 cron 解析（`*` / `n` / `a-b` / `a,b,c` / `*/n` / `a-b/n`；日与周同时受限取并集；周日 0/7）、`nextScheduleAt`（墙钟域按天步进、上限约 4 年覆盖闰日模式；DST 空洞顺延 / 二义取较早）、`validateScheduleSpec`（一次性须为未来 / cron 语法与间隔）、`describeScheduleSpec` + `formatWallTime`（中文规则描述与墙钟展示）——服务端与前端同源，不产生第二份实现；
- **时区**：`Intl.DateTimeFormat` 做 UTC ↔ 墙钟换算（不引入 tz 数据库）；`resolveScheduleTimezone` 归一化 spec.tz 或服务器默认时区（`SCHEDULE_TZ`，非法回退并告警一次）落 task.timezone。

### 50.2 调度服务（server/src/schedule/service.ts）

- **生命周期**：`start()` 在服务端 listen 后启动（启动修复缺 next 的循环任务 + 立即补一轮 + `setInterval` tick，默认 30s）；`stop()` 在 shutdown 时清理；
- **触发语义**：**run** = 注入 `@target instruction` 用户消息（带 `scheduleId`，前端渲染「定时」徽章）→ `engine.launch` 启动运行；**remind** = 落 role=system 事件条（不进上下文）+ `notify:schedule-reminder`（零 token）；
- **忙时与漏跑**：会话正忙（`activeRunOf`）自动触发按 skipped-busy 跳过留痕（不排队引爆），手动触发明确报错；停机恢复的错过触发在补跑窗口（`SCHEDULE_CATCHUP_MS` 默认 10min）内正常补跑，超窗按 skipped-missed 记录；
- **失败护栏**：连续失败达 `SCHEDULE_FAIL_LIMIT`（默认 3）次自动暂停并提醒；run 启动失败回收孤立注入消息保持会话干净；一次性任务触发后终结（nextRunAt=null），cron 持续推进；
- **循环依赖解法**：Service 依赖以函数闭包注入（`launch` / `isBusy`），`engine.setScheduleService()` 回填——Engine ↔ ScheduleService 无构造环；
- **通知双通道**：`notify:schedule-changed`（created/updated/deleted/fired/reminded/skipped-busy/skipped-missed/paused/error；payload 携带 task + message + runId）与 `notify:schedule-reminder`（task + messageId + message 实体）。

### 50.3 工具三件套与路由

- **工具**（`server/src/tools/schedule.ts`，全部 `tier='deferred'` 经 tool_search 激活；`ctx.scheduleRuntime` 注入 + 未装配守卫）：`schedule_task`（创建：kind run/remind；spec_kind once/cron；run 的目标必须是会话内成员——id 或显示名解析）/ `list_schedules`（只读清单：状态 / 规则 / 下次触发）/ `manage_schedule`（pause / resume / remove / run_now）——只能管理本会话任务；
- **路由**（`server/src/routes/schedules.ts`）：`GET/POST /sessions/:id/schedules`、`PATCH/DELETE /schedules/:id`、`POST /schedules/:id/run|pause|resume`（zod 校验；未装配 503）；
- **白名单（8 个时间敏感角色）**：assistant / ops / sre / compliance / content / success / scout / life-admin——其余 60 角色不持有（能力不扩散：deferred 可发现范围 = 白名单）；引导三处齐备（角色正文 / 全局协议 tool_policy / 场景协议 sre·finance·research），对齐 v16 ssh_exec 先例。

### 50.4 前端：面板 / 徽章 / 双通道归约

- **`stores/schedule-store.ts`**（zustand）：按会话绑定 + 操作回包与 WS 通知双通道归约（跨会话守卫：已绑定其他会话才丢弃）；load / applyTask / dropTask / create / update / remove / setEnabled / runNow；
- **`SchedulePanel.tsx`**（右栏面板；TeamPanel 自动页签 + 命令面板「右栏 · 定时」入口）：任务卡（状态徽章 ok / skipped-busy / skipped-missed / error / paused、规则描述、下次触发墙钟时间、「立即执行 / 暂停恢复 / 删除」）+ 新建表单（标题 / 类型 / 成员 / 指令 / 一次性-循环切换 / 预设 chips「每天 09:00 / 工作日 09:00 / 每小时 / 每 30 分钟」/ datetime-local）；
- **消息徽章**：到点注入的用户消息头部渲染「定时」徽章（来源可见、可溯源）；
- **ws-store 双分支**：`notify:schedule-changed`（fired 时 attach run + toast、paused 时 toast.error 呈现 lastError、deleted 时 dropTask）与 `notify:schedule-reminder`（同会话 upsertMessage + applyTask + toast；跨会话 toast + systemNotify + 未读计数）。

### 50.5 配置与验证

- **配置**（默认开启、纯本地零网络）：`SCHEDULE_ENABLED`（true）/ `SCHEDULE_TICK_MS`（30000）/ `SCHEDULE_TZ`（空 = 服务器时区）/ `SCHEDULE_MAX_PER_SESSION`（20）/ `SCHEDULE_MIN_GAP_MS`（300000 = 5 分钟最小触发间隔护栏）/ `SCHEDULE_CATCHUP_MS`（600000 = 10 分钟补跑窗口）/ `SCHEDULE_FAIL_LIMIT`（3）；
- 数据与内核：`server/tests/m35-schedule-cron.test.ts`（29）——cron 解析 / 触发计算 / DST / 校验 / 中文描述；`m35-schedule-store.test.ts`（13）——CRUD 与结算语义；`m35-schedule-service.test.ts`（16）——tick / 忙时 skip / 补跑窗口 / 失败护栏 / runNow；
- 工具与接口：`m35-schedule-tools.test.ts`（8）——工具语义与未装配守卫；`m35-schedule-api.test.ts`（8）——HTTP 往返与 503 语义；`m35-schedule-bindings.test.ts`（11）——8 角色白名单可达性 / 能力不扩散 / deferred 契约 / 三处引导在场；
- 组件面：`client/tests/m35-frontend.test.tsx`（8）——面板渲染 / 新建表单 / 双通道归约 / 徽章；
- 回归：四包 typecheck / lint 全绿；`npm run check:agents` 通过（17 场景 / 68 角色）；`npm run eval` mock 15/15 无回归。

## 51. 画布输入平权、设置主区页与媒体配置专业化（M36）

M36 是一次**工作现场平权 + 配置面专业化**的交互重构：画布补上与对话同级的输入能力——底部固定指令条（Enter 发送 / 运行中自动插话 / 最近回复浮层 / 成员快捷 @ / 范式 chip），消息进入当前会话、Agent 直接操作画布；移除右下角 MiniMap。设置从模态弹窗重构为独立主区视图（8 分组 26 项全量 + 资源概览 + 系统信息），媒体连接表单专业化（提供方卡片 / 能力矩阵 / 编辑器实时校验 / 联调说明）并与画布生成面板打通「直达编辑」。服务端零改动（字段集即既有 `RuntimeSettingsSchema` 白名单）。决策记录见 ADR 61。

### 51.1 画布指令条（CanvasComposer）

- **平权语义**：画布与对话同级的输入通道（不是对话的补充）——消息发送到当前会话、Agent 直接操作画布；不复制消息流（完整历史仍在对话 Tab，浮层只给最近窗口）；
- **指令条**：居中固定于画布底部；Enter 发送 / Shift+Enter 换行；运行中发送自动变为插话（按钮文案「插话」，回合边界消费）+「停止」按钮；
- **最近回复浮层**：输入条上方可展开（运行状态条 + 最近 14 条消息窗口 + 待审批提醒）；
- **成员与范式**：成员快捷条点击插入 `@名字`；范式三态 chip（执行 / 规划 / 评审）仅对下一条消息生效、发送后复位（与对话输入区同语义）；
- **草稿**：按会话持久化 `ma:draft:canvas:<sessionId>`，与对话输入框互不干扰；
- **MiniMap 移除**：右下角小地图删除（画布即全景，适应视野 / 缩放已足够），让位给生成面板与指令条浮层。

### 51.2 设置主区页（SettingsView）

- **形态迁移**：`AppView` 增 `'settings'`（localStorage `ma:appView` 持久化）；删除 SettingsDialog（弹窗形态退役）；入口为 ActivityRail 设置钮与命令面板（「打开设置」命令 + 视图组条目）；
- **8 分组 26 项全量**：模型与生成（主模型 / 摘要模型 / 评测模型 / 温度）、上下文（预算 / 保留回合 / 工具结果上限 / 工具明细保留）、向量记忆（嵌入连接 / 召回开关 / TopK / 门槛 / 预算 / 自动沉淀）、运行控制（回合上限 / 交接模式 / 降级轮询 / 工具超时）、工具与安全（审批模式 / 审批超时 / run_command / 敏感文件）、金融投研（启用 / 行情刷新 / 最小间隔 / Python 桥超时——M34 四项补齐）、资源与集成（连接 / MCP / 角色 / 技能计数 + 直达入口）、系统信息（`/api/health` 回显）；
- **交互**：左侧分类导航 scrollspy（点击定位 + 滚动高亮）；脏标记（「未保存改动」）；「保存并生效」全量 `PUT /api/settings`（热应用，金融「启用」项需重启）；
- **窄屏适配（<640px）**：分类导航收为顶部横向 chip 条（可横滚 + 点击定位联动高亮），表单行改纵向堆叠（字段名在控件上方、控件占满宽度）——390px 实测无横向溢出（表单区 scrollWidth/clientWidth = 338/338，修复前 351/178）；
- **加载**：`GET /api/settings` 与 FALLBACK 默认值合并（服务不可达时表单仍完整可用）；资源计数与系统信息并行拉取（失败静默降级不阻塞表单）。

### 51.3 媒体配置专业化与直达编辑

- **提供方卡片**：ComfyUI（本地生图 / 视频 / 首尾帧）/ SD WebUI / OpenAI 兼容 / 任务模板四卡，选中态高亮；提供方元数据（`capabilities` / `testHint`）为能力矩阵与联调说明的单一数据源；
- **能力矩阵**：与四适配器能力对齐（comfyui / template 全 5 项，sdwebui / openai 2 项）；切换提供方自动收敛已选能力；不支持项禁用虚线 +「该提供方不支持」；副文案说明「生成面板与 Agent 工具（media_generate / media_video）按此裁剪入口」；
- **工作流编辑器**（ComfyUI）：实时解析校验 → 状态徽章（解析失败 / 通过 · N 个工作流 / 未填写）+「格式化」（解析失败不落盘 + toast）+ 已解析明细；
- **模板编辑器**（任务模板）：三段式链路预览（`create.method path → poll.method ?? 'GET' path`）+ 占位符列表 + 校验徽章；
- **联调说明**：按提供方展示测试探活行为（ComfyUI `GET /system_stats`（版本与设备数）/ SD WebUI `/sdapi/v1/options` / OpenAI `/models` / 模板为静态校验）；
- **直达编辑通道**：`connections-store` 增 `pendingEditId` 单值通道（`requestEdit` / `consumePendingEdit`）——画布生成面板铅笔钮写入目标连接 id 并切至「连接管理」；连接中心在清单就绪后消费（实时 `getState()` 快照，避免挂载首帧闭包误判）、打开编辑表单并滚动置顶；目标不存在（已删除）时静默丢弃不悬挂。

> **M56 修订（ADR 0124 / §76）**：本节媒体配置表单与「直达编辑」消费点已迁「设置 → 媒体生成」（连接管理不再呈现 media 类）；通道机制沿用——铅笔钮改切至设置页媒体分组消费（`pendingEditId` 不变）。

### 51.4 验证

- 新增：`client/tests/m36-frontend.test.tsx`（9）——设置主区页（26 项全量渲染含金融 4 项 / PUT 全量保存与脏标记消失 / 资源计数与直达入口 / 系统信息回显）、画布指令条（Enter 发送清空 / 规划 chip 随下一条消息发送后复位 / 运行中插话与停止与成员 @）、直达编辑消费（就绪打开编辑表单 / 目标不存在丢弃不悬挂）；
- 存量适配：`client/tests/m25-frontend.test.tsx` 迁移为 `render(<SettingsView />)`（弹窗断言 → 主区视图）；`e2e/m25-memory.spec.ts` 设置交互改为主区视图（label 直选 + 「保存并生效」+ 「运行期设置」可见性；真实浏览器重跑 2/2 通过）；
- 回归：client 全量单测全绿（复核时 48 文件 / 572 用例，含并行工作流增量；M36 新增 9 例）；client `tsc --noEmit` 干净；改动文件 eslint 通过；全量 E2E 全绿（M36 复核运行时 34 条，含并行 M37 新增 spec）；服务端零改动（`RuntimeSettingsSchema` 26 项未变）。
- 目视验收（真实浏览器 1440×900 / 390×844，mock 模式隔离数据目录）：画布指令条完整可见（无 MiniMap、Enter 发送后「最近回复」浮层自动展开、运行中按钮变「插话」）；画布发送的消息出现在对话 Tab（进入当前会话）；窄屏设置页导航/表单无溢出（修复前后 351/178 → 338/338）；控制台仅 `/api/finance/env` 特性探测 503（设计内），无其他报错。

## 52. 场景化对话体验基座（M37）

M37 为场景组建立对话体验的通用基座：场景空态与议程（资产驱动）、波次分隔行与悬浮阶段条（滚动派生）、交互式容器族 v1（`::: checklist` / `::: choice` 与既有 option 增强）、收尾交付清单与彩纸、消息导航条。全部为**视图层派生**（ADR 62）：不动消息协议、不动编排语义；场景差异来自 `_group.yaml` 资产与渲染路由。专项设计源见 [docs/scene-chat-design.md](docs/scene-chat-design.md)（M37–M45 专项，M38–M45 规划待评审）；决策与被否决方案见 ADR 62–65、92。

### 52.1 场景资产扩展（guide / agenda）

- **资产字段**：`agents/_group.yaml` 新增可选 `guide`（空态标题）与 `agenda`（议程模板 `{ label, prompt }` 列表，2–4 条）；全量 18 场景（17 存量 + invest）齐备；`AgentGroupSchema`（`server/src/store/prompts.ts`）与 shared 类型同步，随 `/api/agents` 热更新（ADR 63）；
- **空态议程 chips**：`ChatArea` 空态区（`messageCount===0`）在标题下渲染「推荐开场」chips（title = prompt 全文）；点击经 `insertRef` 写入 Composer 草稿（不直发，ADR 64）；成员 chips 行为不变；
- **降级**：场景缺 `guide` 回退既有 `EMPTY_GUIDES`（development / brainstorm / research 三条内置文案）；`agenda` 缺省则不渲染该区块。

### 52.2 波次分隔行与悬浮阶段条

- **行派生**（`client/src/lib/chat-rows.ts`，纯函数可单测）：结构键 = `role~runId~turnIndex` 逐条拼接；`deriveRows` 三遍算法——骨架分段（同 `runId~turnIndex` 连续 ≥2 条成波，与 M16 语义一致）→ 波次起点标记（`segKey` 与上一个不同即起点）→ 插入 `wave-sep` 行并产出与 rows 对齐的 `waveOf` 与导航 `rail`；**仅当起点数 ≥2 才显示分隔行**；分隔行只依赖结构键——流式 delta 不改这些字段，字符串未变不重派生（ADR 65）；
- **分隔行**（`WaveSeparator`）：极轻量细线 + 「第 N 波」标签（无头像、无交互；头像由波次组头 / 悬浮条承载，避免重复堆叠与行高抖动）；
- **悬浮阶段条**（`WaveStrip`）：`onScroll` 维护视口窗口 `vp{first,last}`（变化才落 state）；`currentWave` = 首个可见行向后扫描的首个波次；仅在「上滑离开底部」时挂载于消息区顶部；显示波次号 + 成员头像流 + 名字；点击 → `focusMessage(memberIds[0])` 跳波起点（定位 + 闪光）；无波次不显示；
- **E2E 锚点**：分隔行 `data-wave-sep`、悬浮条 `data-wave-strip`（虚拟列表下类名 / 结构不稳定）。

### 52.3 交互式容器族 v1（checklist / choice）与回填通道

- **语法**（`remark-ext.ts` builder + finalize）：`::: checklist [标题]` 包裹 GFM 任务项列表（`- [x]` / `- [ ]`，非标 `- []` 前缀回退）、`::: choice [标题]` 包裹单选项列表；头部进 `data-*` 属性（`data-items` / `data-options` JSON + `data-count` + `data-raw` 原文兜底）；未闭合 / 未知容器按原文展开（fail-safe）；
- **checklist 卡**（`md-ext/ChecklistCard.tsx`）：标题 + 计数 + 勾选行（`is-done` 态）+ 进度条 + 「回填完成情况」；交互态用**覆盖表**（`Map<index, boolean>`，用户未触碰条目跟随内容初始 checked），存 `sessionStorage`（键 `ma:check:<sessionId>:<messageId>`；无消息上下文仅即时态不落存储）；流式期间整卡静态（行 / 按钮禁用）；
- **choice 卡**（`md-ext/ChoiceCard.tsx`）：单选项点选（再点取消）+「选这个」；回填「拍板：<选项>」；
- **option 增强**（既有卡）：头尾部加「选它」按钮 → 回填「拍板：<标题>」；
- **回填通道**（ADR 64）：统一 `ui-store.insertToComposer(text)` → `composerInsert`（nonce 递增）→ Composer 消费时 append 草稿 + focus；**由用户确认后发送**，不直发、不落库；checklist 回填文案 = 「完成情况回填 · 《标题》（x/y）」+ 任务清单 markdown（可编辑）；
- **上下文注入**（`md-ext/message-context.ts`）：`MessageItem` 经 `MessageContext.Provider` 提供 `{messageId, sessionId}`；完成态渲染缓存（LRU 200）按挂载位置求值——同一内容在不同消息下互不串态。

### 52.4 收尾交付清单（交付清单卡 + 彩纸，M37-6 修订 / ADR 92；分层默认续修订 / ADR 123）

- **无交付件不渲染**：每轮固定「本轮已交还」文案已移除（收束语义由「你的回合」交接条承载）；收尾卡只在**本轮有交付件**时渲染——尾条指纹（`id~role~status~user 提及~其他提及~本轮交付件计数`）派生，流式 delta 不改指纹；计数位让 `run:end` 快照回填（`refreshMessages` 补 `artifacts`）触发重派生；
- **清单卡**（`CloseoutCard`）：件数徽标（全量）+ 收束波次（最大 turnIndex+1）+ 交付者头像流（≤5 + 溢出计数）+「打开交付件面板」按钮；**分层默认**（ADR 123）——默认只展示最终交付：非过程产物按重要度（文档 > 图示与页面 > 媒体 > 源码文本 > 数据）稳定排序取前 `DELIVERY_PRIMARY_LIMIT`（5）；过程产物（路径首段命中 `charts` / `data` / `raw` / `cache` / `tmp` / `temp` / `logs`）与溢出项收进「其他 · N 件」组默认折叠，组头即箭头开关（全展示 / 收起；主区为空时自动展开）；**整清单可整体收起**（ADR 123 续）——头部左簇即开关（`data-delivery-collapse`），收起后仅留概要行与快捷继续，「其他」组状态保留；判定与分层为纯函数 `lib/delivery.ts`（只依赖路径，异步元数据不影响排序）；明细行 = 类型图标 / 目录 / 文件名 / 交付者 / 体积；快捷继续 chips（「继续推进 / 总结本轮」→ 草稿回填，ADR 64）；
- **消息内交付明细行**（`DeliveryList`：`ArtifactRow` / `DeliveryFiles`，替换原 chips）：kind 色系与交付件浏览器 / 图谱同源；行点击 `requestArtifact` 打开交付件视图，悬停浮现「送上画布」（`sendArtifact`）；元数据经 `lib/use-artifact-meta.ts` 会话级共享缓存补齐（按 sessionId + `artifactVersion` 单次拉取 / 并发去重 / 失败静默回退扩展名粗判 / 隐藏态不拉取）；
- **彩纸**：`ui/confetti.tsx` 抽共享 `ConfettiBurst`（14 片确定性参数、burst key 重放、quiet 静默；`StatsView` 战绩彩纸同步改用）；触发窗口 = 新近完成（重挂载 / 打开旧会话不重放）。

### 52.5 消息导航条（overview rail）

- **`MessageRail`**：≥20 条消息（`RAIL_MIN_MESSAGES`）时挂载于消息区右缘；条目来自 `deriveRows` 的 `rail`（一行一块：user / agent / system 色点）；细轨 + 视口窗口指示（`vp` 驱动）+ hover 展开预览；点击 → `focusMessage` 定位。

### 52.6 降级与安静模式登记

- 流式纪律（ADR 9）：新容器流式期间静态 / 纯文本，完成态才挂载重组件（ChecklistCard / ChoiceCard / CloseoutCard 均遵守）；
- fail-safe：未闭合容器、非法 `data-*` JSON、未知容器名 → 一律原文渲染（`parseChecklistItems` / `parseChoiceOptions` 返回空 → raw / children 回退）；
- quiet / reduced-motion：彩纸在 `.quiet-mode` 下不播放（卡保留）；分隔行与悬浮条为静态样式（无动效登记需求）；
- 窄屏：悬浮条与导航条在小屏自然收缩，不新增大布局。

### 52.7 验证

- client 单测：`chat-rows.test.ts`（10）——波次派生 / 分隔行插入条件 / rail 与 waveOf 对齐 / 结构键未变不重派生；`markdown-ext.test.tsx` 扩展（11）——checklist 解析·回填·流式禁用·非标前缀·未闭合 fail-safe、choice 点选、option「选它」；
- E2E：`m37-scene-chat.spec.ts`（2）——① 空态议程 chips 预填→发送→波次分隔行与悬浮阶段条；② mock 触发词 → checklist 卡→点选→回填完成情况进草稿→确认发送（真实浏览器通过）；
- 回归：四包 typecheck / lint 全绿；双端 vitest 全量（服务端 974 / 客户端 563）；`npm run build` 通过（主包 gzip 317.42 kB，存量欠账持续关注）；`npm run check:agents` 通过（18 场景 / 73 角色）；`npm run eval` mock 15/15 无回归；E2E 相邻既有 spec 未受影响（mock 仅新增触发词分支）。
- **M37-6 修订（ADR 92，2026-09-18）**：新增 `client/tests/closeout.test.tsx`（5）——无交付件不渲染（固定文案移除）/ 完整清单与元数据补齐 / 运行中不渲染 / 上限截断引导 / 快照回填后补；`e2e/m37-scene-chat.spec.ts` 断言改为 `[data-delivery-manifest]` + 清单明细行（真实浏览器 2/2 通过）；client 全量 581 例 / 49 套件全绿，typecheck / lint 干净（服务端零改动）。

## 53. 金融投研专项（M34）

M34 把「看行情 → 算指标 → 选股回测 → 博弈推演」的投研链路引入协作台：服务端新增**三源混合行情网关**（Node 直连源 + Python 生态桥 + 能力级降级链）与反爬共享模块，落地 12 个 `fin_*` 工具（全量延迟加载）；前端新增主区「行情」「博弈」双 Tab 与消息内渲染块；资产层新增 invest 场景五角色协作链（四路独立分析 → 交叉检验 → 主管收口）。专项设计源见 [docs/finance-invest-design.md](docs/finance-invest-design.md)；决策与被否决方案见 ADR 66。

> **M34 修订（ADR 97，2026-09-18）**：产品形态修订——「博弈」Tab 与 GameLab 独立面板移除（K 线 / 博弈不做单独面板，见 §53.3 修订）；「多空对弈」升级为协议驱动的 agent 对抗链路（逐轮立论 → 量化走子 → 终局裁决卡，见 §53.5 修订）；验证修订见 §53.7。

### 53.1 数据底座：三源混合网关与反爬共享模块

- **能力路由与降级链**（`server/src/finance/gateway.ts`）：按能力选源链逐级降级——quote `eastmoney → tencent → sina → akshare(Py)`；kline 日 / 周 / 月 `baostock(Py) → eastmoney → akshare(Py)`、分钟 `eastmoney → akshare(Py)`；indicator `ta(Py) → node-indicator`（信号侧统一 Node 纯计算）；fundamental / calendar `baostock(Py) → akshare(Py)`；fund_profile / fund_nav `eastmoney-fund → akshare(Py)`；news 个股公告（eastmoney → akshare）与市场快讯（sina 滚动）分链；symbol / screen 走 eastmoney clist（TTL 7d / 10min）。`source: 'auto' | 'node' | 'py'` 可强制层级；结果携带 `degraded` 原因链、`cache: 'hit' | 'stale'`（源全失败回退过期数据）与数据时点，全链可溯；
- **反爬共享模块**（`server/src/tools/http.ts`）：UA 池按 host 粘性、tough-cookie 会话罐、域名级限速 + 指数退避、风控页识别与 60s 冷却、GBK→gb18030 解码、流式体积上限；与网关联动——同源连续失败 ≥2 次进入 5 分钟冷却、路由自动跳过，成功后清零；冷却状态经 `GET /finance/env` 透出（cooling / cooldownUntil / lastError），「数据变慢」可定位；
- **Python 桥**（`server/src/finance/bridge/`）：解释器探测（`FINANCE_PYTHON` → `python3` → `python` → `py -3`）与核心包探测（baostock / akshare / pandas / ta / tablib），三档可用性 `ready / partial / absent`；runner 固定脚本 + stdin/stdout JSON、30s 超时 kill、并发信号量 1、env 净化；缺包不阻塞——Node 源兜底并注明降级原因；
- **K 线快照（可复现会话资产）**（`server/src/finance/snapshot.ts`）：`charts/<symbol>-<period>-<yyyymmddHHMM>.json`（北京时间命名；chart-snapshot schema = kind / symbol / name / period / adjust / meta（来源 · 抓取时间 · 条数）/ bars / indicators / annotations）——落盘进工作区交付件体系，可版本 diff，消息块与报告可引用；
- **指标计算**（`server/src/finance/indicator.ts`）：MA / EMA / MACD / RSI / KDJ / BOLL / ATR 七种（VOL 由渲染端从 bars.volume 绘制，不入计算），Node 与 Python 双实现同口径。

### 53.2 工具集：12 个 `fin_*`（全量延迟加载）

- **数据类 8**：`fin_env`（环境与数据源健康度）/ `fin_search`（标的检索，代码 / 名称 / 拼音）/ `fin_quote`（批量实时行情）/ `fin_kline`（K 线 + 指标 + 快照）/ `fin_indicator`（指标序列）/ `fin_fund`（基金档案与净值）/ `fin_fundamental`（财务基本面）/ `fin_news`（公告与快讯）；
- **量化类 4**：`fin_screen`（条件选股——首期仅股票 / ETF）/ `fin_backtest`（规则回测）/ `fin_game`（博弈推演：matrix / sequence / evolve / simulate 四模型——首期范围）/ `fin_watch`（自选管理，与行情 Tab 同源）；
- **双层门控**：全部 `tier='deferred'`（ADR 54）——初始不进工具清单，经 `tool_search` 检索激活（「金融行情」分组概览兜底发现面）；`FINANCE_ENABLED=true`（**默认关闭**，纯 opt-in）时才注册——关闭态工具中心无噪音、`/api/finance/*` 统一 503；
- **按角色分权**（见 53.5）：invest-lead 全量 12 个；quant 9 个；analyst-fa 7 个；analyst-ta 6 个；analyst-news 4 个。

### 53.3 前端：行情 / 博弈双 Tab 与渲染块

> **M34 修订（ADR 97，2026-09-18）**：「博弈」Tab 与 GameLab 已移除（「行情」Tab 保留）；K 线 / 博弈收敛为三形态——① 会话内 kline / game 围栏块（工具条新增「送上画布」直落画布节点）；② 画布节点 `GameNode`（配置态选模型 / 标的话题 / 场景预设 / 高级参数（种子 + 模型参数）→「运行推演」直连 `POST /api/finance/game`；结果态与消息块共用 `GameResultView` 内核；agent 或「送上画布」写入自动切结果态）与 `KlineNode`（空态输入标的直连 `GET /api/finance/kline` 拉取；结果态周期 / 复权切换 + 刷新写回节点）；③ Agent 通道 `canvas_write` / `canvas_read` 支持 `game` / `kline` 节点类型。另新增 `::: verdict` 终局裁决卡（多方红 / 空方绿 / 僵持灰）。
>
> **M34 修订（ADR 98，2026-09-18）**：「行情」Tab 与 `FinanceView` / `KlinePanel` 已移除（独立面板形态至此全部收敛）；Command Palette「行情」入口与 `MainTab` 类型同步移除。K 线 / 博弈承载维持三形态（会话块「送上画布」/ 画布节点 / Agent 通道）不变；`/api/finance/*` 网关、`fin_*` 工具与 `FINANCE_ENABLED` 门控原样保留。下述「主区 Tab」「FinanceView（行情）」两条描述失效（留存沿革）；「消息内渲染块」「设置面板」两条仍有效。

- **主区 Tab**（`AppLayout.tsx`）：「行情」「博弈」两项随 `financeEnabled === 'on'` 探测通过才可见（懒加载独立 chunk）；
- **FinanceView（行情）**：左栏自选列表（添加 / 移除 / 备注）+ 右栏 K 线（周期 / 复权 / 指标面板）/ 概况 / 新闻三页签；10s 轮询且**交易时段感知**（非交易时段停轮询；交易日 / 节假日日历经 `finance_meta` 缓存 12h）；涨红跌绿（A 股口径）；未启用时引导开启（含 Python 包状态提示）；
- **GameLab（博弈）**：四模型参数表单 + 4 个预设；直连 `POST /api/finance/game` **纯计算可复现**（seed 透传；paths 受 `FINANCE_GAME_MAX_PATHS` 护栏），不耗 LLM；运行历史上限 8 条；结果画布与消息块共用渲染内核（`GameResultView`）；
- **消息内渲染块**：```kline 围栏（`md-ext/KlineBlock.tsx`，klinecharts v10 懒加载）渲染蜡烛图 + 主副图指标 + 价格线标注；```game 围栏（`md-ext/GameBlock.tsx`）渲染博弈结果（矩阵 / 演化曲线 / 叙事）；
- **设置面板**：`financeMinIntervalMs`（金融源同域最小请求间隔 0–60s；0 = 复用反爬模块默认 1200ms）热读生效（`SettingsView.tsx`）。

### 53.4 HTTP API 与存储

- **路由**（`server/src/routes/finance.ts`，挂载 `/api` 之下 9 条）：`GET /finance/env`（环境与数据源健康度）；`GET | POST /finance/watchlist` + `DELETE /finance/watchlist/:symbol`（symbol 唯一 upsert，全局单表跨会话共享）；`GET /finance/quote`（批量 ≤50）；`GET /finance/kline`（周期 / 复权 / 指标面板）；`GET /finance/search`；`GET /finance/news`；`POST /finance/game`（纯计算；zod 校验失败 400）；未装配网关统一 503、上游源全失败 502（与 canvas 路由同语义）；
- **存储**：迁移 v10 五表——缓存三表（`finance_kline_cache` / `finance_quote_cache` / `finance_news_cache`）+ `finance_watchlist`（symbol 唯一 upsert；sort 升序 + 物理删除）+ `finance_meta`（kv：桥探测结果 / 交易日历等，TTL 由读方按 updatedAt 判断）；网关缓存（`finance/cache.ts`：symbol 主档 7d / screen 基表 10min / 日历 12h；`cache: 'stale'` 回退）。

### 53.5 Agent 资产：invest 场景与协作链

- **场景**（`agents/invest/_group.yaml`）：id `invest` / 投资研究 / order 62（finance 与 bi 之间）/ theme `#dc2626`（A 股涨色）/ `parallel: true` + `parallelMax: 4`（四路分析同波上限 = 全组）/ chain `[invest-lead, analyst-fa, analyst-ta, analyst-news, quant]`；场景协议「投研纪律九条」（数据可溯 / 不臆造 / 观点与事实分离 / 概率思维 / 风险先行 / 免责声明 / 工具纪律 / 分工与裁决 / 模拟推演不越界）；
- **5 角色**：祝衡（投研主管，报告收口）/ 秦砚（基本面）/ 雷动（技术面）/ 闻笛（舆情面）/ 方程（量化策略师：回测 + 博弈）；各持独立交付件契约（投研报告 / 基本面分析 / 技术面分析 / 舆情简报 / 策略方案·博弈推演）；
- **5 技能**（41 → 46）：technical-analysis / fundamental-analysis / investment-strategy / market-news-analysis / game-theory-trading；
- **2 预设**（12 → 14）：invest-review「投研快评」（两路分析 + 主管收口 3 回合）、strategy-research「策略研究」（三路 + 收口 4 回合）；mock 剧本与 golden 任务两条链路全脚本化。

> **M34 修订（ADR 97，2026-09-18）**：`invest/_protocol.md` 新增「多空对弈」四条（触发与阵容 / 回合纪律 / 走子口径 / 终局裁决写法）；预设 14 → 15 增 `bull-bear-duel`「多空对弈」（五角色全链：秦砚持多方 × 雷动持空方逐轮对抗、闻笛归堆证据弹药、方程逐轮量化走子、祝衡终局裁决）；`_group.yaml` agenda 增「多空对弈」入口；mock 对弈剧本与「博弈推演」交付件、golden 任务 `19-bull-bear-duel`、E2E 第 3 条链路全脚本化。

### 53.6 合规与安全

- **门控默认关闭**：`FINANCE_ENABLED` 默认 false——Tab 与 12 工具双不注册，纯 opt-in；关闭态路由 503 引导；
- **模拟不越界**：博弈 / 回测为模拟工具，不接实盘交易通道、不提供下单能力（协议第 9 条）；
- **免责声明**：投研交付件必须附非投资建议免责声明；观点与事实分离（事实带来源 + 时点，观点标概率）；
- **数据侧礼貌**：限速 + 冷却 + host 粘性（反爬模块）；Python 桥 env 净化不透传密钥；快照与产出统一落工作区沙箱（ADR 14）。

### 53.7 验证

- server 单测 9 文件：`m34-symbol` / `m34-sources` / `m34-gateway` / `m34-pybridge` / `m34-indicator` / `m34-backtest` / `m34-finance-tools` / `m34-finance-api` / `m34-game`；client 3 文件：`kline-spec` / `game-spec` / `m34-finance-view`；
- E2E：`m34-invest.spec.ts`（2）——投研快评（两路并行 → 主管收口 → 3 交付件）与策略研究（三路 → 4 交付件），真实浏览器通过；
- 评测：golden 15 → 17（invest-quick-review / invest-strategy-research），基线已刷新，mock 17/17；
- 回归：四包 typecheck 0 错误；server 全量 987 全绿；`npm run check:agents`（19 场景 / 74 角色）/ `check:skills`（46）通过；E2E 全量 34 条全绿。
- **M34 修订（ADR 97，2026-09-18）**：server `m31-tools` +2（game / kline 节点写入与摘要）；client `m31-canvas` / `m34-md-blocks` 扩展、`markdown-ext` 新增 verdict 用例（解析 / 渲染 / fail-safe），`m34-finance-view` 适配撤 Tab；E2E `m34-invest` 3 条（新增「多空对弈」：三路交锋 → 量化走子 → 终局裁决 + 5 交付件）+ `markdown-ext` verdict 用例；评测 golden 17 → 19（新增 `19-bull-bear-duel`，mock 19/19）；回归：四包 typecheck 0 错误；server 1017 / client 583 测试全绿；`check:agents`（19 场景 / 74 角色 / 预设 15）/ `check:skills`（46）通过。

## 54. 通用调度官与意图路由（M46）

> **M48 撤销（ADR 101，2026-09-18）**：本章调度官「知舟」与 `dispatch` 机制已整体撤销，调度上收引擎（平台路由步 PRS，见 §57）；下述描述仅作历史记录。

M46 把「新建会话」从「先选人再说话」翻转成「直接说话，调度官路由」：新增全局唯一调度官资产（场景「智能协作」· 角色「知舟」· `dispatch: true` 一等标记），空编制建会话由服务端显式落 `[调度官]`；引擎首发队列升级为**四分支路由**（@ 直达 / 消息级 plan·review 直投业务首棒 / 无 @ 交调度官 / 兜底编制链首位），调度官持 `invite_members`（与成员 API 共享内核）在**同一回合**完成「召集 → 派发」，成员增援经 `handoff` 回调度官二次召集。消息协议与数据库模型**零变更**、零新增端点、零新增事件类型（召集复用成员变更链路）；+1 场景 / +1 角色 / +1 工具（56 个）。专项设计源见 [docs/harness-dispatch-design.md](docs/harness-dispatch-design.md)；决策与被否决方案见 ADR 82–91。

### 54.1 调度官资产与 dispatch 标记

- **场景**（`agents/harness/_group.yaml`）：id `harness` / 智能协作 / **order 1 全局置顶**（三步流第一张卡）/ objective「把无定向的一句话需求路由到正确的角色与协作链」/ chain 单角色 `[harness]` / guide + agenda 三条（开发任务 / 头脑风暴 / 研究报告）；
- **角色**（`agents/harness/harness/AGENT.md`）：知舟 · 总调度（Dispatcher）——意图识别 / 阵容召集 / 任务派发 / 协作收口 / 澄清追问；工具白名单为最小协作集（只读检索 + `handoff` / `invite_members` / `remember` / `write_todos` / `request_approval` / `load_skill`），**不持任何交付件写工具**（纪律：不替成员干活）；
- **`dispatch: true` 全局唯一**：`AgentDefinition.dispatch?: boolean`（shared 类型）→ `PromptLibrary.validate()` 唯一性校验 + `check:agents` 输出 `harness：知舟（总调度） dispatch:✓` 双层保障；控制台字段序与 round-trip 保留（编辑不丢 / 复制不继承）；
- **透传**：Agent / 场景列表携带 dispatch 标记，前端 `DispatchBadge`（「调度」徽标，title 说明接手语义）四处复用：AgentPicker 角色卡 / 三步流 0 人提示条 / TeamPanel 成员卡 / 消息头（姓名与角色之间）。

### 54.2 会话创建：零选择开聊

- **服务端放宽**：`createSessionSchema.participantIds` 允许空数组；`POST /sessions` 空编制 → **显式填充调度官**（落库 `[调度官]`，非隐式虚拟成员）——调度官是普通成员，名单 / 移出 / 广播等全部不变量原样成立；
- **三步流**：场景卡选中后默认预选 = 调度官 + 场景链（研发团队 = 8 位）；逐位可取消（取消调度官不回加）；0 人提交按钮文案「交给调度官 · 0 位成员」+ 提示条「未选成员：知舟将接手识别需求、召集成员并派发任务」；
- **CommandPalette 修复**：「新会话」快捷入口由「全部角色塞入同一会话」（68 人全会话缺陷）改为「仅携带 `[调度官]`」，创建 toast 附「将接手调度」；
- **零变化回退**：无调度官资产时三步流维持旧行为（0 人提交禁用 + 旧文案），CommandPalette 回退全量编制——资产删除即回到 M46 前语义。

### 54.3 消息路由：四分支与插话补位

`launchRun` 首发队列四分支（按优先级互斥命中）：

1. **@ 直达（零变化）**：`mentioned.length > 0` → 仅 @ 成员；
2. **消息级显式 plan / review** → 首位**业务成员**（`businessFirst` = 编制链首位非调度官；规划 / 评审目标已明确，直投场景首棒更直接）；
3. **无 @ 且调度官在场** → `[调度官]`（意图识别与阵容召集；M46 前该场景盲投编制链首位）；
4. **兜底**：编制链第一位（无调度官会话与 M46 前逐字一致）。

**插话补位**（Run 运行中队列已空时的接手人顺序）：@ 成员 > 调度官（未达接手护栏上限）> 首位未发言者 > 编制链首位——运行中追补需求同样优先交调度官接手，顺带修掉「队列空时插话消息可能被吞」的边界。

### 54.4 召集闭环：invite_members 与惰性 participants

- **工具**（`server/src/tools/roster.ts`）：`invite_members`（core tier 写类；仅调度官工具白名单可见）——`agent_ids`（≤ `INVITE_MAX_MEMBERS = 20`）/ `scene_id` 整链召集二者可并用，已在场自动跳过（幂等）；
- **共享内核** `inviteMembersCore`：与成员 API `POST /sessions/:id/members` 同源——校验 / 编制链排序 / 事件条 / `notify: members-changed` 广播全链路一致；措辞区分（用户操作「邀请了」/ 调度官「召集了」，主语 = 调度官名），防语义漂移；
- **未知 id 回灌**（自我修正）：召集含未知角色 → 不中断 Run，返回 top-3 相近 id + 「请查阅 roster_catalog 核对角色 id」引导；
- **惰性 participants**：`buildToolRuntime` 的 `participants` 改 getter（每次访问读实时成员表）——同一回合「先 invite_members 再 handoff 派发新成员」直接成立（handoff 校验 / plan owner / schedule target 三处同受益，无需等回合边界）。

### 54.5 装配注入：roster_catalog 与调度回合指令

- **roster_catalog**（`server/src/orchestration/roster-catalog.ts`）：仅调度官回合注入 L3——列出**未在场**角色（按场景分组；场景行含 objective 与编制链，供 `scene_id` 整链召集）；description / objective 截断 60 字、在场明细展示上限 10（超出折叠计数）；**LRU 缓存 32**（键 = 资产内容签名 + 在场集合，资产热更新自动重建）；全员在场 / 非调度官回合不注入；
- **调度回合指令**（`assembler.ts`）：dispatch 角色且非 review / plan 时追加「【开场调度】」段——闲聊可直答交还 / 先召集后派发（每位目标附 reason 与 expected_output）/ ≤4 位优先 / 不越权替成员干活 / 调度说明 ≤120 字；成员 execute 回合在场含调度官时追加一行增援辅导（「handoff（或 @）回调度官，由其召集后再派发」）——成员增援为单一收口通道（ADR 0086），无调度官 roster 零变化。

### 54.6 范式与波次交互

- **调度波恒 execute**：首波仅含调度官且起步范式为 plan（会话 planFirst / 消息级）→ 置一次性顺延标记 `dispatchPlanDeferred`，本波照常 execute；业务首波消费标记返回 plan——「规划先行」不至于被调度开场吞掉；
- **接手护栏**：`DISPATCH_MAX_TURNS_PER_RUN = 3`——波规划时本波含调度官即计数（Run 级状态，不持久化）；达上限且队列含调度官 → 移出队列，队列空则首位未发言者兜底（与「调度官缺席」路径同语义）；**不中断 Run**、用户无感；
- **既有护栏叠加**：波签名 + 3-gram 循环检测与回合上限原样生效（专用上限管调度循环、既有检测管内容重播，职责正交）。

### 54.7 前端体验面

- 三步流 / CommandPalette / DispatchBadge（四处）见 54.1 / 54.2；
- **实时性**：召集复用成员变更链路——system 事件条落流（「召集了 费利、艾达、诺娃 加入协作」）+ `members-changed` 广播 → 成员面板 / 协作图谱 / 徽标态即时更新，前端零新增订阅；
- **轨迹**：TraceDrawer 新增「召集」行渲染（召集人 → 新增成员 · 场景整链 / 理由；无新增时收敛为一句确认）——`dispatch:invited` 载荷含召集人 `agentId`，审计可回答「谁召集了谁、为什么」；
- 调度官消息即普通成员消息（无特殊渲染路径），徽标来自 agent.dispatch 数据面。

### 54.8 验证

- server 2 套件 34 例：`m46-dispatch.test.ts`（12：四分支路由矩阵 / planFirst 顺延 / 接手护栏 / 成员增援回路）与 `m46-roster.test.ts`（22：内核分支 / 工具契约 / 目录渲染与缓存 / 调度回合指令与成员增援行）；
- client 1 套件 9 例（`m46-frontend.test.tsx`）：三步流（含 0 人提交与无资产回退）/ CommandPalette / 徽标渲染；
- E2E 2 条（`e2e/m46-harness.spec.ts`）：零选择开场全链（召集 → 面板增长 → 被召集者开工 → 收束交还）与三步流预选取消（真实浏览器通过）；
- 评测 17 → 18（`harness-dispatch`：`participants: ["harness"]`，4 回合完成 3 交付件 + 召集一致 / 派发目标断言 + 无回环 + 回合上限）；
- 计数镜像面：工具 55 → 56（core 21 → 22，`invite_members`）· 场景 18 → 19（角色 73 → 74）· E2E 34 → 36 条；
- 回归：四包 typecheck 0 错误；server 全量 1012 全绿 / client 全量 572 全绿；`check:agents`（19 场景 / 74 角色）/ `check:skills`（46）通过；eval 18/18；主包 gzip 317.94 kB。

## 55. 调度派发修复、收口汇总波与串行执行（M46-2）

> **M48 部分撤销（ADR 101，2026-09-18）**：调度收口波（§55.2）随调度官撤销删除——收口职责由「成员交还 + 收尾交付清单」承载；派发优先修复（§55.1）与串行执行（§55.3）保留。

M46-2 是 M46 上线后的真实故障修复批次（头脑风暴会话连续三次复现）：调度官同一条消息「先派发成员、末尾 @用户 报备」被波合并误判为全员交还 → accepted 静默丢弃、Run 结束、交付件从未产出（用户反馈「没有汇总给我」）。修复三件套：**派发优先于交还报备**（scheduler 合并定则）、**调度收口波**（全链交还前引擎追加调度官汇总，每 Run 一次）、**会话级串行执行**（默认开启：逐位出场、前序产出可见）。消息协议与数据库模型仅 +1 会话字段（迁移 v12）、零新增端点 / 事件类型；+0 场景 / +0 角色 / +0 工具。决策与被否决方案见 ADR 94–96。

### 55.1 派发丢失修复（mergeWaveSchedule）

- **根因**：`HANDOFF_MODE=auto` 下交还信号有双通道——行首 `@用户`（文本）与 `handoff(user)`（工具）；解析器把「行首 @用户」判为 `handedToUser = true` 的同时仍解析同条消息的成员提及。`mergeWaveSchedule` 旧逻辑 `allHanded = decisions.every(d => d.handedToUser)` 命中即早退（清空队列 / 丢弃本波全部 accepted / Run 结束）——单成员波内 `[{ handedToUser: true, accepted: ['facilitator'] }]` 即误触发，「先派发、再报备」的调度表达被静默吞掉；
- **修复**：先收集后判交还——`acceptedAll` 先按波内顺序收集全部 accepted（跨成员去重），`allHanded` 收紧为 `every(handedToUser) && acceptedAll.length === 0`：全员交还**且本波无任何成员接手**才是收尾交还；部分交还（含同条消息报备）视为不交还，Run 继续消费成员接手；
- **接手口径**：`acceptedByAgent` 有明确 accepted 时以成员为准（`['facilitator']`），仅纯 `@用户`（无成员）才标注 `['user']`——前端 HandoffBar 渲染成员胶囊而非「你的回合」，「派发生效」在 UI 上直接可见；
- **测试**：`scheduler.test.ts` +3 例（派发与报备并存 / 纯交还仍收尾 / 跨成员接手去重），套件 26 例全绿。

### 55.2 调度收口波

- **追加条件**（`engine.ts` `maybeAppendDispatchCloseout`，波合并后同帧判定）：`merge.handedToUser && queue 为空` + 本 Run 未追加过（`dispatchCloseoutAdded`，每 Run 一次）+ 未触发循环抑制（`loopSuppressed`）+ 调度官在场且本 Run 已发言（`spoken`）+ 调度官不在本波（自己交还无需再收口）+ `dispatchTurns < DISPATCH_MAX_TURNS_PER_RUN`（护栏复用）；
- **入队续跑**：`queue.push(调度官)` + `dispatchCloseoutPending = true` + `handedToUser = false`（清除交还标记）；trace `dispatch:closeout`（载荷 `dispatcherId`）；
- **收口指令**（`assembler.ts` 消费 pending）：【收口汇总】核对成果（读关键交付件）→ ≤200 字摘要（完成了什么 / 产出在哪 / 下一步建议）→ 不派发、不召集 → 摘要末尾另起一行 `@用户` 交还；收口回合不注入 roster_catalog；
- **协议对齐**：`agents/harness/_protocol.md` 调度纪律第 5 条与 `AGENT.md` 职责 / 用户交互节奏同步（「确认 → 派发 → 收口」节奏；收口回合不再派发）。

### 55.3 会话级串行执行（默认开启）

- **数据面**：`Session.serial?: boolean`（shared）；迁移 v12 `ALTER TABLE sessions ADD COLUMN serial INTEGER NOT NULL DEFAULT 1`（旧库升级即串行）；建会话默认开启（`opts.serial === false` 才关）；`PATCH /api/sessions/:id` 切换（`updateSessionSchema` 加字段）；
- **引擎**：波规划 `globalParallelMax: session.serial ? 1 : cfg.parallelMax`——显式 `@≥2` / handoff 多目标（forceParallel 分支）同样逐位消化；波内上下文隔离、收口波 / 合成波 / plan / review 编排规则原样生效（串行只限同波人数，不减波次）；
- **前端**：TaskView chips 行「串行执行」芯片（`ListOrdered` 图标，开启态高亮 + 「已开」；hasPlans 与 else 两个分支均渲染）——点按 PATCH + `applySession` + toast（开：「逐位出场，便于跟进查看」/ 关：「同场景成员可并行成波（推进更快）」）；
- **芯片状态同步修复**（e2e 实测暴露）：服务端以「键缺失」表示关闭（`serial` / `planFirst` / `memberSouls`），客户端 `applySession` 浅合并会残留旧值——关闭串行后芯片仍显示「已开」；修复为对上述缺省语义字段显式覆盖（保留 `messageCount` / `lastMessage` 等 summary 字段不整替），并补 store 单测锁定；
- **动机**：并行波内成员互不可见（§29）导致交付件脱节（真实案例：红队报告写「点子池尚未落盘（工作区当前为空）」）；串行默认让前序产出可见 + 消息逐条可读——「不需要并行，便于查看」成为默认体验，并行降为显式提速选项。

### 55.4 验证

- 单测：server 全量 1017 全绿（m16 / m24 并行用例显式 `{ serial: false }`；m46 两套件收口回合感知 + `dispatch:closeout` 断言；store 迁移版本 [1..12]）；client 全量 583 全绿（含 `applySession` 缺省语义字段回归 1 例）；四包 typecheck 0 错误；ESLint 通过；
- E2E：新增 `m16-serial` 2 条（默认串行逐位出场无并行组 / 芯片关闭后并行成波）；`m46-harness` 增收口波（「知舟 交还给用户」）与 3 份交付件断言；并行专项（m16-parallel / m16-brainstorm / m21-opc / m34-invest）经 `disableSerial` 适配；全量 41 条全绿（29 个 spec，含 approval 链路）；
- 评测：mock 19/19 ✅（`harness-dispatch` 剧本更新为含收口波的 5 回合链路，turns_lte 8；与基线对比无回归）；
- 文档：ADR 94–96、本页 §55、`agents/CHANGELOG.md` v24。

## 56. 工具可用性门控与失败语义收敛（M47）

M47 是「工具调用失败」专项修复批次：以生产库 `tool_metrics` 全量取证（593 次调用 / 17 次失败 + `run_events` 精确文案）定位六类系统性根因，按「必然失败优先消灭 → 报错精确可行动 → 负向语义不误报」三层收敛——核心为**环境门控单一事实来源**（`availability.ts`）与**引擎清单过滤**（未启用工具不进模型 schema 与工具发现范围），配套 registry 精确提示、tool_search「直接可用」语义、中断归因 `stopped`、calc 用法签名自愈。消息协议 / 数据库模型 / 端点 / 事件类型零变更；+0 场景 / +0 角色 / +0 工具（agents/ 资产零触碰）。决策与被否决方案见 ADR 99。

### 56.1 失败取证（生产库全量聚合）

`data/app.db` 的 `tool_metrics` 按工具聚合 + `run_events` 回查原始报错文案，17 次失败归因六类（非分散噪声，均为系统性根因）：

| 失败类 | 次数 | 根因 | 处置 |
| --- | --- | --- | --- |
| web_search / web_fetch | 6 | **环境未启用但清单可见**：工具始终注册进模型 schema（执行期才检查开关），`.env` 未启用 / 进程持旧环境时模型看到即调用 → 必然失败（网络类且诱发重试） | 引擎清单过滤：未启用不进 schema 与发现范围（治本） |
| fin_kline / fin_quote | 2 | **整组关闭 + 泛化报错**：`FINANCE_ENABLED=false` 时 `fin_*` 整组不注册，人设 / 白名单仍引导调用 → 「未知工具」，无法区分「不存在」与「未启用」 | `markUnavailable`：执行期返回精确配置指引 |
| tool_search | 3 | **正常态被记为失败**：发现未启用（小集合工具已全量直出）返回 `ok:false`，污染失败率；无参调用透出 zod 英文 `Required` | `direct:true` 语义（ok:true + note）+ 必填中文化 |
| write_file / remember | 4 | **中断被计入失败**：用户停止 / 回合超时走异常通道 → 落失败指标 + 前端红卡 | `'stopped'` 语义：不落指标 + 琥珀呈现 |
| calc | 1 | **报错不可行动**：`breakeven` 参数个数报错无用法签名，模型无法一步纠正 | 报错附 `usage` 签名（自愈） |
| write_plan | 1 | **负向业务结果**：用户驳回计划 | 保持 `ok:false`（协议依赖该回灌驱动修订） |

### 56.2 环境门控与引擎清单过滤

- **单一事实来源**（新模块 `server/src/tools/availability.ts`）：`toolUnavailableReason(name, cfg)` 集中判定环境门——run_command（`ALLOW_RUN_COMMAND`）；未启用返回统一 `DISABLED_SUMMARY` 文案（含「改哪个配置后重启」指引）；`GIT_TOOL_NAMES` + `isGitToolName` 供会话模式门复用；联网工具不设环境门控（见下方修订注记）；
- **清单过滤（治本）**：引擎 `availableTools` 构建时按 `toolUnavailableReason` 过滤——未启用工具**不进模型 schema、不进 `tool_search` 可发现范围**（发现区块与激活池同源）；执行期守卫**保留**（双保险：防旧会话快照 / 幻觉调用，命中仍得精确文案）；
- **行为对齐**：新增「环境门控类」工具时必须同步在 `availability.ts` 注册门控与文案，否则回退为清单盲区（模型可见但必然失败）。

> **联网工具去限制（ADR 0136）**：web_fetch 域名白名单机制与 web_search 启用开关整体移除——两工具无环境门控（始终可用）、无域名白名单（web_fetch 任意 http/https 地址可抓取，含重定向目标）；`WEB_FETCH_ALLOWED_DOMAINS` / `WEB_SEARCH_ENABLED` 配置项与 `WEB_FETCH_DISABLED_SUMMARY` / `WEB_SEARCH_DISABLED_SUMMARY` 文案一并删除（§56.1 表中两工具为 M47 历史取证口径）；保留反爬保护（限速 / 退避 / 风控冷却 / 体积上限 / 超时）。

### 56.3 会话模式门控（git 工具）

- `EngineDeps.isGitMode?: (sessionId) => boolean`（可选装配，**缺省 = 不判定**——eval / 单测零差异）；sandbox 会话无仓库 → git 6 工具不进清单（模型不再尝试注定失败的 git 操作）；repo / worktree 模式保持可见；生产装配 `workspace.isGitMode(sessionId)`（仓库有无是**会话级事实**，不做进程级开关）。

### 56.4 registry 三能力（精确提示）

- `markUnavailable(names, hint)`——整组关闭时登记「已知但未启用」：执行期返回配置指引（如 `fin_*` → 「金融工具未启用：设 `FINANCE_ENABLED=true` 后重启」）而非泛化「未知工具」；
- `unavailableNames()`——控制台工具白名单校验合并该清单（编辑引用 `fin_*` 的角色不再误报「未知工具」）；
- `describeParamIssue`——zod 校验首条问题本地化（必填缺失 →「query 为必填项」），替代透出英文 `Required`。

### 56.5 发现门精化与 direct 语义

- `discoveryGate` 仅对「**本回合可发现范围内**（entries 内）」的延迟工具给「先 `tool_search` 激活」引导；被环境过滤 / MCP 未绑定 → 放行到执行层给精确原因（不引导模型检索一个不存在的条目）；
- `tool_search` 非失败语义：未装配检索内核 / 发现未启用 → `{ ok: true, direct: true, note: '当前所有工具均已直接可用，无需检索' }`（`ToolSearchOutcome.direct` 新字段）；真正空命中才给改写建议。

### 56.6 中断语义收敛（stopped）

- **归因原则**：用户停止 / 回合超时 ≠ 工具失败——`ToolCallRecord.status` 新增 `'stopped'`；不写失败指标，trace 留痕 `aborted:true`；前端 ToolCard 琥珀 `CircleSlash`（不再是红卡）；
- **同归范围**：停止导致的审批取消、批次未执行条目（摘要「运行已停止，未执行」）同归 `stopped`；**用户驳回 / 审批超时仍为 `error`**（负向业务结果，保持回灌语义，如 write_plan 驳回驱动「按反馈修订 v2」）；
- **指标纯度**：失败率必须只反映「工具真的失败了」——用户停止是意图、用户驳回是决策，与执行失败在 UI（琥珀 vs 红）与指标（不计 vs 计）上可区分，否则仪表盘长期虚高、真实回归被掩盖。

### 56.7 calc 报错自愈

函数运行错误附 `usage` 签名（如「（用法：breakeven(固定成本, 单价, 单位变动成本) = …）」），模型按签名一步纠正参数个数类错误。

### 56.8 验证

- 单测：server 全量 1027 全绿（新增 `m47-tool-availability` 9 例：门控单测 / fin_* 精确提示 / 必填中文化 / schema 过滤与发现范围 / git 模式门 / direct 语义 / 中断不落失败指标；`m28-engine-search` 计数顺应 git 模式门 + 网关门控显式 pin（与环境解耦）；`m28-discovery` direct 两例；`m7` 停止收口 `stopped`）；client 全量 571 全绿；四包 typecheck 0 错误；ESLint 0 错误；build 通过；
- E2E：全量 41 条全绿（29 个 spec，含 approval 链路）；
- 评测：mock 19/19 ✅（与基线对比无回归）；check:agents 19 场景 / 74 角色 / 预设 15 通过；check:skills 46 通过；
- 文档：ADR 0099、本页 §56、`agents/CHANGELOG.md` v27。

## 57. 调度平台化：撤销调度官角色，调度上收引擎（M48）

M48 是调度机制的架构修订批次：用户反馈调度官「引入了一个新角色，感觉怪怪的」——意图识别与阵容召集是**平台能力**，不应人格化为资产角色；原则是「**所有 agent 都应是单一业务 harness agent**」（消费同一套 AGENT.md 工件、有业务职责、可被 @）。核心改动：删「智能协作」场景与「知舟」角色、`dispatch` 字段全链移除；调度上收引擎为**平台路由步（PRS，Platform Routing Step）**——未 @ 消息 / 空编制开场由引擎执行一次结构化 LLM 调用（**非角色回合**：不产生消息、不占波次、不参与交接队列），输出「召集名单 + 任务派发」后应用为事件条 / 任务便条 / 队列；成员增援自动化（handoff 目标不在场但资产存在 → 自动召集）。计数 19→18 场景 / 74→73 角色 / 56→55 工具；消息协议与数据库模型**零变更**、零新增端点 / 零新增事件类型。遗留专项设计文档 [docs/harness-dispatch-design.md](docs/harness-dispatch-design.md) 已随本次撤销收档（首部撤销注记）；决策与被否决方案见 ADR 101。

### 57.1 撤销与保留对照（M46 系列）

| M46 决策 | 处置 | 说明 |
| --- | --- | --- |
| 82 调度官一等成员 | 撤销 | `agents/harness/` 删除；「知舟」不再存在 |
| 83 `dispatch` 资产标记 | 撤销 | 字段从资产模式 / 校验 / 控制台 round-trip / 前端徽标全链移除 |
| 84 空选择创建填充 `[调度官]` | 撤销 | 空编制创建合法（`participantIds: []` 原样落库，首条消息走 PRS） |
| 85 无 @ 路由调度优先（四分支） | 撤销 | 改三分支：@ 直达 / 显式范式直投编制首位 / 平台路由步 |
| 86 召集单一收口（`invite_members` 仅调度官） | 撤销 | 工具移除（56→55）；召集三路（PRS / 增援 / 成员 API）共用 `inviteMembersCore` |
| 87 roster_catalog 注入 | 复用 | 改由 PRS 输入（未在场目录 + 在场名单），缓存机理不变 |
| 88 调度波恒 execute | 撤销 | PRS 非回合，无「调度波」概念 |
| 89 工具运行时惰性 participants | 复用 | PRS 同回合「先召集后派发」所需 |
| 90 调度接手护栏 ≤3 次 | 撤销 | 每 Run 仅一次 PRS 决策，无「多次接手」 |
| 91 事件与广播复用 | 复用 | 机制不变；trace `dispatch:invited` → `routing:dispatched` |
| 94 派发优先于交还报备 | 保留 | 波级合并机制（@ 多目标场景仍用） |
| 95 调度收口波 | 撤销 | 无调度官回合，收口由成员交还 + 收尾交付清单承载 |
| 96 会话级串行执行 | 保留 | 与调度层正交 |

### 57.2 平台路由步（PRS）：契约与容错

- **新模块** `server/src/orchestration/platform-router.ts`：`runPlatformRoute()` 一次结构化调用——`summaryModel`、temperature 0、`responseFormat: json_schema 'platform_route'`（`ROUTE_SCHEMA`）、`meta.agentId = '__router__'`（哨兵，与角色 id 空间隔离；mock 据此分派剧本）、用量 `kind='turn'`（与角色回合同口径审计）；复用 `resilientStream`（重试 / 首 token 超时 / 空闲超时）；
- **输入**：`<request>` 用户需求（最新用户消息）+ `<context>` 最近上下文（最近 4 条非 system 消息、各截 160 字、总 800）+ `roster_catalog` 未在场目录（ADR 87 复用，`buildRosterCatalogBlock`）+ 在场名单（空数组 = 零编制开场，全员可召集）；
- **输出**：`{ members[], assignments[{agentId, task}], reason }`——`assignments` 1–4 位有序（首位最先开工；≥2 位触发并行波 `forceNextParallel`）；`task` ≤120 字折叠截断（提示词要求 ≤60 字）；`reason` 截 200 字（审计用）；
- **容错**（`coerceRoutePlan` 纯函数，导出供单测）：`members` 仅保留「存在资产且未在场」（去重）；`assignments.agentId` 必须 ∈ 在场 ∪ members（`'user'` / 未知 / 重复一律丢弃）；`assignments` 为空 = 路由失败；**失败永不抛错**（`ok:false` + error，由引擎决定降级路径）。

### 57.3 启动三分支与降级路径

- **首发队列**（`launch()`）：① @ 直达（接消息内已解析 mentions，零变化）② 消息级显式 plan / review 且编制非空 → 编制首位（目标已明确，直接投场景首棒）③ 未 @ 或空编制 → `routingPending`（`runLoop` 开头执行 PRS 后进入波次循环）；
- **应用语义**：召集先落库（`inviteMembersCore`，verb「召集了」/ actor「平台」——事件条 + 广播 + 落库与成员 API 完全一致）→ 派发为任务便条（`handoffNotes` from「平台」：接手者回合显示「上一棒期望（来自 平台）」+ 一句话任务要点）+ 队列填充；召集后以 `presentNow` 复核派发目标；
- **降级**：调用 / 解析失败 → 有编制则在场首位接手（task「按你的职责推进该需求」，trace `{fallback:true, error}`）；空编制无兜底 → 系统事件条「平台未能为该需求匹配到合适的成员。请在「成员」面板手动邀请成员后重新发送。」并收尾——**绝不静默**。

### 57.4 成员增援自动化（handoff 未在场目标）

- 成员 handoff 的目标不在场但资产存在 → 引擎**自动召集**（`enlistByPlatform`，source='handoff'，reason「X 转交时自动召集」）后正常接手；解析层同步放行（不再把「目标不在场」判为协议违规）；
- 与 PRS 召集共用内核（`inviteMembersCore`），事件条 / 广播 / trace 同形——「成员增援无需手动邀请」。

### 57.5 资产 / 接口 / 前端收缩

- **资产**：删 `agents/harness/`（一场景一角色）；`dispatch` 字段从 `AgentDefinition`（shared）、`check:agents` 校验（唯一性检查）、控制台编辑 round-trip 全链移除；`_presets.yaml` 无引用；
- **接口**：`POST /sessions` 空编制合法（`participantIds: []` 不再填充）；`invite_members` 工具移除（56→55）；
- **前端**：删 `DispatchBadge`（AgentPicker / 三步流 / TeamPanel / 消息头四处徽标）与调度官预选位；0 人提交 = 「空编制创建 · 交给平台组队」（提示「未选成员：首条消息将由平台自动组队并派发任务」）；CommandPalette「新建会话」直建空编制会话（toast「会话已创建，直接描述需求即可（平台将自动组队）」）；空态引导「直接描述你的需求，平台将自动组队并派发任务」+「零成员创建：平台会识别你的需求，从资产库召集合适的角色，并把任务派发到位」；AppLayout「当前会话暂无成员 · 首条消息将自动组队」。

### 57.6 审计可见性（trace 三形状）

- `routing:dispatched` 三形状：`{source:'route'|'handoff', members, reason}`（召集，与事件条同源）/ `{assignments, reason}`（派发）/ `{fallback:true, error}`（降级）；
- TraceDrawer 依形状渲染：「平台召集 · {名单}」（detail：来源「需求路由 / 成员转交触发」+ 理由）/「平台派发 · {名单}」/「平台路由降级 · 在场成员接手」。

### 57.7 验证

- 单测：server 全量 1018 全绿（新增 `m48-routing` PRS 契约与降级 / `m48-roster` 空编制与增援语义；`m7` / `m21` / `m28` / `m47` 适配 PRS 直通）；client 全量 602 全绿（含新增 `m48-frontend` 5 例：空编制建会话三步流与快捷新建）；四包 typecheck 0 错误；ESLint 干净；build 通过；
- E2E：全量 41 条全绿（`m48-routing` 2 条：零选择开场 → 平台召集 3 成员 → 首棒开工 → 3 交付件；三步流场景预选不含调度官）；
- 评测：mock 19/19 ✅（`18-platform-routing`：`participants: []` 三回合——平台召集 → 接力 → 交付，与基线对比无回归）；check:agents 18 场景 / 73 角色 / 预设 15 通过；check:skills 46 通过；
- 文档：ADR 101（+ ADR 索引 Superseded / Amended 标注）、本页 §57、`agents/CHANGELOG.md` v28、`agents/README.md`、README。

## 58. 右栏实况面板合并与主区收敛（M49）

M49 是界面信息架构的收敛批次，**纯前端改动**（服务端与消息协议零变更）：① 「浏览器 / 交付件 / 数据库 / 终端」四个观看面合并为右栏「实况」面板（面板内 face 条即二级），Agent 操作到达自动聚焦到对应面（带三层护栏）；② 右栏 9 个平铺视图收敛为两级导航（一级团队 / 运行 / 实况，二级为组内子面板 chips）；③ 主区顶栏收敛为「对话 / 画布」+ 按需展开的深度工作台（交付件 / 数据库 / 终端，带返回）；④ 悬浮直播窗让位协同（右栏可见操作时不自动滑入）。决策与被否决方案见 ADR 100。

### 58.1 实况面板（LivePanel：四面合一）

- face 条即二级导航：`浏览器 | 交付件 | 数据库 | 终端`（图标 + 标签）；未读交付件计数徽标；运行中操作面脉冲点（`useBusyOpFaces` 从消息流 toolCalls 归约，见 §36.3）；右侧「暂停跟随」＋「在主区展开当前面」（浏览器面无展开项）；
- 浏览器面：现 `BrowserPanel` 原样并入——接入方式三选一 / chrome 条 / 帧流 + 键鼠直通 / 接管与归还 / 步骤时间轴；`retainView / releaseView` 引用计数语义不变（切面 = 断流 / 续流，与直播窗共用 browser-store）；
- 数据库面 / 终端面：复用 `DockDbView` / `DockSshView`，加 `surface: 'dock' | 'panel'` prop——panel 面底栏为「展开工作台 / 展开终端 + 连接管理」（走 `expandWorkspace`，不触浮窗）；dock 面（直播窗）行为不变；
- 交付件面：`ArtifactFeedView`（新建窄栏视图）——默认「跟最新」（软跟随路径 > 最近更新 > 列表最新）；点列表项 = 钉住（再点回跟随）；垂直三段（预览区 flex-1 内部滚动 → 操作行 引用 / 复制 / 下载 / 展开 → 最近文件列表，≤5 行滚动 +「全部文件 · N」）；预览器与主区共用（markdown / code-shiki / html / chart / data / image / video / pdf / office）；
- 空态极简（图标 + 一句文案）；面板 React.lazy 懒加载（帧流 / 预览器按需分包，不进首屏）。

### 58.2 跟随引擎（live-panel-store）

- 状态：`face`、`faceLockedAt`（切面 60s 锁）、`viewLockedRunId`（本 Run 视图锁）、`lastManualViewAt`（切视图 60s 锁）、`followPaused`、`pinnedArtifactPath` / `followArtifactPath`、未读活动点；决策抽纯函数 `resolveFollow(state, event, now)`（单测覆盖全规则）；
- 实况操作（browser / db / ssh）到达 → 自动切视图到实况 + 对应面；例外 = 本 Run 已手动切走视图 / 60s 内刚手动切过视图 / 60s 面锁（仅不抢面）/「暂停跟随」；
- 交付件软跟随：面板停在交付件面且未钉住 → 自动选最新；否则仅亮活动点（不抢视图、不抢页签）；消息 chip `requestArtifact` 到达 = 显式意图 → 切实况 + 交付件面 + 钉住；
- 手动语义：点一级 / 二级任意项 = 手动视图变更（锁本 Run 自动聚焦）；点一级「实况」= 恢复跟随；`beginRun` 重置 Run 级护栏（保留 face）；非当前会话事件不干扰；
- 接线（ws-store）：`notify:op` 顺序 = `livePanelStore.noteOp`（可能程序性切视图）→ `connections.pushOp` → `dockStore.noteOp`（让位判定即时生效）；artifact 双通道 → `ui-store.noteArtifact` + `livePanelStore.noteArtifact` 双写（不引入 store 环）。

### 58.3 右栏两级导航

- `registry.tsx`：`PanelDef` 增 `group` 字段；`GROUPS` 由 `PANEL_DEFS` 派生（单一事实来源）——团队 = 成员 / 接力 / 图谱 / 战绩；运行 = 任务 / 记忆 / 定时 / 指标；实况 = live（单子项，face 条即二级）；
- `TeamPanel` 外壳：一级 Tabs 3 项（团队 / 运行 / 实况；运行组聚合徽标 = 待批准计划数，实况组活动点）+ 组内二级 chips（组内单子项不渲染）；`lastOf` 组记忆（点一级回上次子面板，首次 = 组首项）；子面板渲染与插槽零改动；
- 持久化 v2：`ma:rightView` = `{ current, lastOf }`（v1 裸 id 自动迁移，`browser → live`；非法值回退「成员」）；
- 命令面板：「右栏 · X」条目直达「组 + 子面板」（自动展开所在组）；「右栏 · 浏览器」→「右栏 · 实况」。
- **面板显隐·左右对称（M49 后补 2026-09-18；09-19 收敛改版；09-19 二改·左钮回迁缘部把手）**：右钮收敛于主区头部最右端（`PanelToggleButton`，仅宽屏渲染）；左钮回迁为主区左缘垂直中部悬浮把手（`LeftPanelEdgeHandle`——默认不展示、悬停左缘热区淡入、移开淡出，半胶囊贴边、仅右侧圆角）——常驻双态：展开态 = 「隐藏 X 栏」（左 = 折角 ChevronLeft / 右 = PanelRightClose）、收起态 = 「显示 X 栏」（左 = 折角 ChevronRight / 右 = PanelRightOpen），同一钮原位切换；不再内嵌在会话头部（原 `SessionList onCollapse`）与右栏页签行（原 `TeamPanel onCollapse`），右栏无缘部浮动把手（原 `RightPanelEdgeHandle` 不回归）；与 `⌘B`（右）/ `⌘⇧B`（左）（窄屏映射对应抽屉开关）、命令面板「左 / 右栏：显示 / 隐藏」同源（`ui-store.toggleRightPanel` / `toggleLeftPanel`）；命令面板顶栏按钮同步撤除（⌘K 为唯一键盘入口，监听不变）。收起 = 对应分栏卸载（主区独占空间），分栏比例经 `onLayout` 原位记账、展开原位恢复（2 栏拆账兜底口径与挂载默认三栏一致：`S, 100−S−26, 26`）；持久化 `ma:rightPanelOpen` / `ma:leftPanelOpen`（默认展开，刷新保持）；`setRightView(view, { reveal })`：用户显式切换视图默认展开，程序性自动聚焦（跟随引擎）不抢展开，`openArtifact` chip 跳转强制展开。

### 58.4 主区收敛与入口改线

- 顶栏：常态仅「对话 / 画布」；深看态替换为「← 返回（对话 / 画布）｜工作台标题」（h-11 不变，防布局跳动）；
- `ui-store`：`deepFrom` / `expandWorkspace('artifacts' | 'database' | 'terminal')` / `closeWorkspaceView()`（返回 `deepFrom ?? 'chat'`）；`MainTab` 五值保留（内部状态与懒加载零破坏）；
- 入口改线：命令面板「展开 · 交付件 / Diff」「展开 · 数据库工作台」「展开 · SSH 终端」；消息 chip 与收尾清单行 → 实况 + 交付件面 + 钉住；连接管理「打开」与 Dock 跳转按钮 → `expandWorkspace`；`insertToComposer` / `focusMessage` 仍切「对话」。

### 58.5 直播窗让位协同

- `live-dock-store.noteOp` 前置判定：宽屏（>900px）且 `rightView === 'live'` 且右栏展开（`rightPanelOpen`，后补条件：收起时让位无从谈起）→ 不自动滑入（仅更新 `lastOp` / `tab` 供手动展开对齐，不消费 `autoRunId`）；
- 离开实况后同 Run 仍可兜底滑入；手动 `openDock` 不受限；窄屏（< 900px）自动滑入兜底、静音、胶囊回落语义不变。

### 58.6 验证

- 单测：client 全量 51 文件 602 例全绿（新增 `live-follow` 24 例 / `live-panel` 8 例；更新 `m22-frontend` / `m23-frontend` / `live-dock` / `closeout` / 命令面板用例）；四包 typecheck 0 错误；
- E2E：helpers 新增 `openWorkspace`（命令面板「展开 · X」+ 窄屏 Ctrl+K 兜底）；10 个 spec 旧入口（主区「交付件」页签）全量改线；两级导航用例（m24-plan / m16-serial / m25-memory 先点一级「运行」再点二级）；
- 构建：client build 通过；帧流 / 预览器 / xterm 懒加载分包不变。
- **面板显隐收敛改版（2026-09-19）**：显隐钮自面板头部（会话头部 / 右栏页签行）收敛至主区头部「对话 / 画布」页签两侧（`PanelToggleButton` 常驻双态，左栏同步，无缘部把手）；`right-panel`（4）/ `header-bar`（2，含「两钮已撤出顶栏」回归锚）单测，client 全量 56 文件 659 例全绿；`e2e/right-panel.spec.ts`（中区钮收起 / 原位切换展开 / 刷新持久化 / 原位宽度恢复 / ⌘B · ⌘⇧B 与命令面板同源 / 面板头部无钮断言）3 test 全绿；四包 typecheck 0 错误、lint 干净。
- **左钮回迁·左缘悬浮把手（2026-09-19 二改）**：左栏显隐自「页签左侧原位」回迁为主区左缘垂直中部悬浮把手（`LeftPanelEdgeHandle`：默认不展示、悬停左缘热区淡入、移开淡出；单折角箭头 ChevronLeft / ChevronRight 随态翻转），右钮仍为主区头部最右端面板图标；`right-panel` 单测改为把手形态断言（opacity-0 + group-hover 淡入类 + 折角箭头双态），`e2e/right-panel.spec.ts` 左栏用例改「悬停 opacity 0→1、移开回 0 / 贴主区左缘 / 垂直居中」位置断言——3 test 全绿；client / e2e typecheck 0 错误。

## 59. 建会话组队台（M50）

M50 重设计「新建会话」弹出框为**三栏组队台**（左「来源」→ 中「角色池」→ 右「编制」），一次成局取代 M16 两步向导（选场景 → 配成员，微调后回看需「重选场景」往返）与「15 预设 + 18 场景同屏长滚动」的信息堆叠；游戏感轻度化——仅体现在入选态、编制计数与成员行入场动效。**纯前端**：server / 协议 / DB / zustand store 零变更、零新增依赖。决策与被否决方案见 ADR 102。

### 59.1 三栏组队台（CreateSessionDialog）

- 桌面（≥1024px，`max-w-5xl` + `h-[min(86vh,760px)]`；右栏标题 Input 与创建按钮紧凑化 `h-8` + `text-[12px]`）：三栏常驻——左 `w-[236px]`：来源搜索（`搜索模板 / 场景…`，过滤名称与描述）+「快速组队」preset 行（`N 人` + 头像堆叠；组内空则整组含组名隐藏）+「按场景组队」group 行（`∥ 并行协作 · N 位推荐` / 描述 / `目标：…` / 链头像堆叠）+ 底部「自由组合」虚线按钮；中 `flex-1`：`AgentPicker fill`（卡点击 = 编制增删，`aria-pressed` 保留）；右 `w-[280px]`：来源徽标（preset → `快速组队 · {name}` chip / scene → `GroupBadge`）+「已微调」+ `已选 N 位` + 清空按钮 → 编制成员行（AgentAvatar + 姓名/角色 + `SoulPicker` + 移出按钮）→ preset 开场指令 `details` → 0 人提示 → 标题 Input → 创建按钮（两态原文案）；
- 窄屏（<1024px，`useMediaQuery('(max-width: 1023px)')`）：收敛为「来源 / 角色池 / 编制」三页签（条件渲染单面板，桌面/窄屏共享同一份 pane JSX）；点来源行后自动切「编制」页；390×844 抽屉内嵌套 Dialog 路径保持可用；
- 行语义：**点来源行 = 以推荐编制整体替换**（preset `members` / group `chain` ∩ 已知角色）并清 souls；池卡 = 单成员增删；移出按钮 `aria-label="移出编制"`（不含角色名——池卡保持「唯一含角色名的按钮」，避免 Playwright 严格模式二义）；清空编制保留来源（徽标呈「已微调」态，「已微调」为独立 span 不拼进 chip 文本）；「自由组合」清来源与编制（窄屏切「角色池」页）；
- 选择器锚点：来源行 `aria-label="组队来源：{name}"`——来源名称（如「研发团队」）会与同屏 AgentPicker 分组 Tab 的可访问名（`研发团队 7`）二义，e2e / 单测统一以该锚点定位（`m26-console` 同屏断言同步适配）；
- 轻度游戏化：入选态（边框 / 底色 / 勾选）、`已选 N 位` 计数徽标 `badge-pop`（`key={picked.length}` 重触发）、成员行 `.lineup-enter` 入场（320ms）——两个动画均加入 `@media (prefers-reduced-motion: reduce)` 与安静模式（`.quiet-mode`）双清单 `animation: none` 降级。

### 59.2 行为等价不变量（锚点全保留）

- 空编制合法（M48：`空编制创建 · 交给平台组队` + 0 人提示原文案）；`preset.prompt` → `ma:draft:<sessionId>` 草稿键（M21）；souls 仅保留最终编制（M46 过滤逻辑照搬）；
- `pendingCreate` 通道：SessionList 消费后经 `initialSource` 传入组队台（无效 id 回退无来源）；对话框无障碍名保持「新建会话」（e2e `getByRole('dialog', { name: '新建会话' })` 不变）；
- 原文案清单：`已选 N 位`（仅右栏一处）/ `快速组队 · {name}` / 开场指令 `details` / placeholder `会话标题（可选，默认自动生成）` / `创建并进入（N 位成员）` / `空编制创建 · 交给平台组队` / `未选成员：首条消息将由平台自动组队并派发任务` / `自由组合` / `按场景组队` / `快速组队`（区块名）/ `∥ 并行协作 · N 位推荐` / `目标：` / `N 人`；
- 删除项：副标题「新建会话 · 选场景/配成员」、「重选场景」按钮、两步向导状态（`createStep` 等）。

### 59.3 代码边界

- 新建 `client/src/components/sessions/CreateSessionDialog.tsx`（组队台全部状态与提交逻辑；props：`open` / `onOpenChange` / `initialSource?` / `onCreated`）；`SessionList.tsx` 瘦身（删除约 280 行旧创建逻辑与 JSX，仅留列表 CRUD / FTS 搜索 / pendingCreate 消费与对话框装配）；`AgentPicker.tsx` 新增 `fill?: boolean`（默认 false 保持 `max-h-72`——TeamPanel 邀请对话框零影响；true 时 `min-h-0 flex-1` 填满中栏）；`index.css` 新增 `.lineup-enter` 并加入两个降级清单。

### 59.4 验证

- 单测：client 全量 54 文件 621 例全绿（新增 `m50-frontend` 5 例：来源搜索 / 来源切换重置编制与 souls / 编制行移出 / 清空编制 / 窄屏三页签；适配 `m16-frontend` / `opc-frontend` / `m48-frontend` 锚点）；四包 typecheck 0 错误；ESLint 干净；build 通过；
- E2E：定向 6 spec 11 条全绿（`helpers.ts` 的 `createSession` / `createSessionByPreset` 锚点重写，30+ spec 零改动；inline 流程适配 `m14-responsive`（窄屏页签）/ `m48-routing`（组队台预选）/ `m26-console`（同屏「已选 7 位」））；
- E2E 全量：含并行落盘 spec 共 42 条；除 `m27-mcp`（见下行遗留说明）外全部通过——期间 4 条并行竞态假失败（reload / m16-members / m21-opc / stop：同仓双 Playwright 实例互踩 test-results 与 8788/8789 服务器）隔离复跑全绿；
- 遗留说明（非本批，已解决）：`m27-mcp` 失败根因 = 并行落盘的 `agents/blank/general` 白名单 `mcp__*` 通配命中一切 MCP 工具（服务端 `reachable` 恒真 → 「N 个工具零可达」警示不出现），与组队台零交集，交由 blank 批次处理——**已兑现**：断言按新语义适配（反向断言 + 矩阵命中徽章），见 §60.6；
- 文档：ADR 102、本页 §59 与 §34.2 修订注记、ADR README 索引、`docs/blank-scene-design.md` 让位记录、README。

## 60. 空场景——单 Agent 模式（M50）

M50 新增「空场景」（资产 id `blank`）——对应「不引入任何角色 agent，只使用一个通用的 harness agent 对话，单 agent 模式」的合法会话形态：会话只有一位成员「通用助手」（`general`，第 74 个角色，无业务人设 / 无 souls / 无 `handoff`），未 @ 消息**直达本人**（跳过平台路由步），每轮完成交还用户。它补齐「零选择」路径的第三种形态：空编制创建 = 交给平台组队（多 Agent），空场景 = 一个人干完（单 Agent）。决策与被否决方案见 ADR 103–106，专项全文见 [docs/blank-scene-design.md](docs/blank-scene-design.md)。

### 60.1 资产（ADR 103）

- `agents/blank/`：`_group.yaml`（name 空场景 / order 1 / `chain: [general]` / `guide`「直接说出你的需求，由通用助手独立完成」+ 4 条 agenda 推荐开场）+ `general/AGENT.md` + `_protocol.md`（单助手纪律：独立完成 / 工具直用 / 交付清晰 / 收尾直接 / 汇报诚实）——空态引导与推荐开场由资产驱动（M37 机制），零前端硬编码；
- 通用助手工具策略：`tools` 白名单 = 全部已启用工具 **− `handoff`**（54 精确项 + `fin_*` / `mcp__*` 通配）——「单助手纪律」的物理实现（不可转交）；运行时复用 M28 分层自动收敛：**20 项 core 常驻 + 34 项 deferred 经 `tool_search` 按需激活**（`resolveDiscovery` auto 模式：deferred ≥ 10 → 启用，系统提示注入 `<tool_discovery>` 概览；发现域 = 白名单内 deferred 集）；
- 与其他角色差异：无业务人设字段 / 无 soul / 不可被自动召集（§60.3）/ 单成员时不由 PRS 派发（§60.2）；控制台可编辑、mtime 热更新（与全部资产同一套工件）。

### 60.2 单助手直通路由（ADR 104）

- `launch()` 新增 `soloBlank` 判定：编制**恰为 1 人**且该成员 `group === BLANK_SCENE_ID` → 未 @ 消息直达本人（`queue: ['general']`、`queued: false`、零 PRS 请求、无 `routing:dispatched` trace、无 `__router__` 用量）；@ 直达语义零变化；
- **实时派生**：判定基于当前编制逐消息重算——加人（≥2）/ 换人即退出直通、恢复 PRS；无持久化标记、无迁移；
- **保守边界**：其他场景的单成员会话（`[pm]` 等）不享受直通（双条件含 group 判定）；空编制（0 人）仍走 PRS（「交给平台组队」语义不变）；
- `shared/src/types.ts` 导出 `BLANK_SCENE_ID = 'blank'`（server / client 单一事实源）；`launch()` 之外零引擎改动——收尾、波次、范式全部复用既有等价路径：无 handoff 的单成员波在波末兜底天然产出 `turn:end.mentions=['user']` + `notify:awaiting-user`（一问一答，非静默）。

### 60.3 通用助手不可自动召集（ADR 105）

三层隔离 + 一道白名单缺口，全部引擎侧（资产零标记）：

1. **目录隔离**：`buildRosterCatalogBlock` 不列 blank 场景与 `general`——PRS 候选池不含它（不在目录 = 不会提议）；
2. **输出过滤**：`coerceRoutePlan` 的 `knownIds` 排除它——幻觉输出 `members: ['general']` 被丢弃（trace 无记录、编制不变）；
3. **目标解析**：`resolveAgent` 排除它——`handoff('通用助手')` 拒「不在场」（显式回执，不走「未在场目标自动召集」路径）；
4. **白名单缺口**：`general.tools` 无 `handoff`（注册清单差集仅此一项）——自身不发起接力。

**刻意保留**：用户经成员面板**手动邀请** `general` 进任意会话——允许（与普通成员同权；在场时可被 PRS 正常派发）。自动 vs 手动的分界是用户意图。

### 60.4 入口形态（ADR 106）

- 组队台「来源」栏顶部「空场景」独立卡（置顶、微标「单 Agent · 1 位成员」、场景色主题、选中态勾选）——点击 = `pickSource({kind:'scene', id: BLANK_SCENE_ID})`（`chain: [general]` 预选 1 人），零新增代码路径；
- 「按场景组队」列表过滤 blank（去双入口）；搜索命中 / 不命中 / 全空态由 `blankHit` 与过滤后列表共同决定（独立卡在场时不出现「无匹配」误导）；
- **零特判面**：命令面板（`requestCreate('scene','blank')` → `pendingCreate` 通道 → 初始来源预置）、Composer @ 列表（order 1 自然居首）、成员选择器、控制台——全部自然生效。

### 60.5 mock 增补与实施对齐

- mock 四处增补：`SCRIPTS.general`（单助手口径 3 句，含 E2E 锚点「我来独立完成」）/ `artifactFor.general`（`docs/交付件-{topic}.md`，对齐全局口径）/ `DISPLAY_NAMES.general` / **范式信号适配（bug 修复）**——`write_plan` / `submit_review` 分支原以「工具清单含该工具」判定 M24 规划 / 评审范式，而 general 白名单常驻这两者（core 分层不折叠）→ 普通消息被误判为范式 → 发出 `write_plan` 挂起、Run 永不结束（eval `artifact_exists` 失败的直接根因）；修复为「范式信号仅对业务角色成立」（`meta.agentId !== 'general'`），业务角色语义零变化（回归：`m50-blank.test.ts` 真 Mock 剧本用例）；
- eval 断言器新增 `no_invite`（`server/src/eval/assertions.ts`）：「`routing:dispatched` 轨迹中不存在 `payload.members` 非空的条目」（覆盖 PRS 召集与 handoff 增援两种 source）——既有 `invited_members` 为「覆盖」语义（空数组 trivially 满足），无法表达「不得召集」；单测矩阵见 `server/tests/m9.test.ts`。

### 60.6 验证

- 单测：新增 `server/tests/m50-blank.test.ts`（9 例：资产与 M28 分层 / 直通双通道 / 收尾 / 三层隔离 / 实时派生 / 真 Mock 剧本全链）与 `client/tests/m50-blank-frontend.test.tsx`（5 例：独立卡 / 列表过滤 / 搜索与空态与提交 body / 命令面板）；`m21` / `m29` / `m35` 计数与例外适配（19 场景 / 74 角色 / `general` 为唯一无 `handoff` 例外）；
- E2E：新增 `e2e/m50-blank.spec.ts`（独立卡 → 已选 1 位 → 创建 → 直聊 → 反向断言无「平台 召集了 …」→ 收尾与交付件）；对照回归 `m48-routing.spec.ts` 全绿（PRS 路径零变化）；`playwright.config.ts` main project `testMatch` 增 `m50-.*`；
- E2E 全量（43 条 4.2m 全绿）：`m27-mcp` 三处断言按 M50 新语义适配——`general` 的 `mcp__*` 通配命中一切 MCP 工具（服务端 `reachable` 恒真），「N 个工具零可达」警示对新增服务器不再出现，改为反向断言（徽章隐藏 + 矩阵零「零角色可达」）+ 授权矩阵命中「通用助手」徽章（§59.5 遗留说明兑现）；
- 评测：新增 `evals/tasks/20-blank-scene.json`（`participants: ['general']` 直建会话；断言含 `no_invite` / `artifact_exists` / `run_end_reason=completed`）；
- 文档：ADR 103–106、本页 §60、ADR README 索引、`docs/blank-scene-design.md`（含让位记录修正）、`agents/CHANGELOG.md` v32。

## 61. 辩论场与谈判桌——PK 对弈协议泛化（M51-A）

M51 场景生态扩展（[docs/scene-expansion-design.md](docs/scene-expansion-design.md)）的首批双场景：辩论场（`debate`）与谈判桌（`negotiation`）——把 invest「多空对弈」（M34，ADR 0097）验证的对弈机制（回合制对抗 + 证据挂载 + `::: verdict` 终局裁决）泛化为三场景共用协议，承接「通用议题的观点对抗」与「利益博弈的谈判彩排」；正反并行立论 / 谈判严格串行出价按博弈本质差异化。决策与被否决方案见 ADR 0107。本批为纯资产 + 镜像面批次：零引擎 / 零前端 / 零容器改动，`stage` 声明预写、M52-A 消费。

### 61.1 对弈协议泛化（三场景共用模板）

- 写进 debate / negotiation `_protocol.md` 的五条共用协议：① 回合制（默认 3 轮可调、每轮必须回应上一轮、禁止复读）② 挂证据与置信度（辩论：观点与证据分离、逐条挂证据等级；谈判：报价 + 让步幅度 + 理由）③ 终局 `::: verdict` 复用（辩论「胜负 + 置信度 + 核心依据 + 翻盘条件」；谈判「成交区间（ZOPA）+ 得失评分 + 改进点」）④ 落盘与「模拟推演」声明（收尾由裁判 / 教练统一 @用户）⑤ 并行纪律按场景定；
- 与 invest 的既有 `DUEL_TRIGGER` 专属链差异化：辩论/谈判走常规 preferredOf 转交（不触发专属剧本替换），零引擎改动。

### 61.2 debate 辩论场（4 角色）

- `_group.yaml`：order 102 / icon `scale` / theme 红蓝对撞 / chain `[judge, affirmative, negative, evidence]` / `rounds: true` / `parallel: true`（正反同波立论）/ guide「抛出议题，开一场有裁决的辩论」/ agenda 4 条；`_protocol.md` 铁律 8 条（观点与证据分离 / 对事不对人 / 不偷换概念 / 回合纪律 / 诚实边界 / 中立纪律 / 模拟声明 / 议题边界）；
- 角色：立言（正方辩手，`docs/正方立论-<主题>.md`，handoff → 砺锋 / research.scout）/ 砺锋（反方辩手，`docs/反方立论-<主题>.md`，handoff → 立言 / scout）/ 昭实（证据官，中立供弹药，`docs/证据清单-<主题>.md`）/ 明断（裁判，`docs/辩论裁决-<主题>.md`）；与 red-team（单向挑刺）、invest（限标的）明确区隔；
- `stage` 预写：`{layout: arena, seats {left: [affirmative], right: [negative], center: [judge, evidence]}}`（M52-A 消费）。

### 61.3 negotiation 谈判桌（3 角色）

- `_group.yaml`：order 104 / icon `handshake` / theme 双色博弈 / `rounds: true` / **`parallel: false`（严格串行出价）** / guide「说说你要谈的事：谈什么、对方是谁、你的底线」+ agenda 4 条；`_protocol.md` 铁律 7 条（三桩先行 / 严格串行 / 每轮记录 / 对手真实 / 模拟声明 / 合规边界 / 隐私纪律）；
- 角色：谭成（谈判手，`docs/谈判策略-<主题>.md`，handoff → legal / finance）/ 祁弈（对手模拟，按设定立场真实还价，`docs/对手档案-<主题>.md`）/ 苏纵（教练复盘，`docs/谈判复盘-<主题>.md`）；
- `stage` 预写：`{layout: arena, seats {left: [negotiator], right: [counterpart], center: [tactician]}}`。

### 61.4 技能与预设

- `skills/debate`（结构表 / 立论反驳模板 / 逻辑谬误清单 / 裁判裁量口径 / 检查清单）、`skills/negotiation`（三桩表 / ZOPA 与锚定 / 让步纪律 / 对手建模三类（强硬 / 拖延 / 情绪型）/ 复盘口径）；
- 预设：`classic-debate`（明断 · 立言 · 砺锋 · 昭实，order 160）、`negotiation-rehearsal`（苏纵 · 谭成 · 祁弈，order 170）。

### 61.5 镜像面与验证

- 镜像面七件套：mock.ts 四件套（SCRIPTS 7 条含 artifactPath 与交接语义 / artifactFor 7 case 与交付契约对齐 / DISPLAY_NAMES 7 / preferredOf 7）+ `e2e/helpers.ts` AGENT_NAME +7（全量 81 角色 id→name 逐一相等，mock-coverage 守护）+ `m21.test.ts`（21 场景 / 81 角色 / 17 预设 / 协议断言 +2）+ README（统计与预载表）+ CHANGELOG；
- eval：新增 `21-debate.json`（4 交付件 × 3 内容断言 + handoff + turns_lte 5 + judge rubric）与 `22-negotiation.json`（3 交付件 × 3 内容断言 + handoff + turns_lte 4 + judge rubric）；`--update-baseline` 后全量 22/22 通过（debate 4 回合 / negotiation 3 回合，相邻任务零回归）；
- 门禁：check:agents 21 场景 / 81 角色 / 17 预设（7 新头像 ✓）；check:skills 48；server 75 文件 / 1031 测试、client 54 文件 / 621 测试全绿；四包 typecheck 0 错误；ESLint 干净；build 通过；
- 回填台账：judge → society.moderator（M51-B 后）、tactician → career.comp-advisor（M51-C 后）——回填后跑 check:agents；
- 文档：ADR 0107、本页 §61、ADR README 索引、`agents/README.md`、`docs/scene-expansion-design.md` §5.1 / §5.6、`agents/CHANGELOG.md` v33。

## 62. 议题圆桌——社会研讨多视角（M51-B）

M51 场景生态扩展（[docs/scene-expansion-design.md](docs/scene-expansion-design.md)）的第二批场景：议题圆桌（`society`）——承接「一个社会议题想看全」的需求（事实是什么 / 各方关切是什么 / 可行中间路径在哪）；4 角色分工（主持 / 事实核查 / 立场图谱 / 政策伦理）把「看清」落成可交付成果，收敛口径为「共识与分歧 + 可行建议区间」（并列收敛，不判胜负）。决策与被否决方案见 ADR 0108。本批为纯资产 + 镜像面批次：零引擎 / 零前端 / 零容器改动，`stage` 声明预写、M52-B 消费。

### 62.1 社会研讨协议（多视角共用模板）

- 写进 `agents/society/_protocol.md` 的 9 条铁律 + 4 条工具纪律：① 议题边界（红线：非政治敏感、不作意识形态输出、不煽动对立）② 事实分级（来源等级 / 日期 / 核验状态三要素；不可核实标「待核实」不硬凑）③ 立场并列（价值分歧只呈现不判胜负；推演与事实分开标注）④ 政策伦理三框架（公平 / 权利 / 后果）⑤ 收敛口径（共识与分歧 + 可行建议区间：下沿 / 上沿 + 代价 + 前提）⑥ 模拟声明（非价值裁判 / 非决策建议 / 非各方正式表态）；
- 与 debate / negotiation 的对弈协议（对抗收敛）差异化：society 为并列收敛——不抹平分歧、不判胜负、不下结论。

### 62.2 society 议题圆桌（4 角色）

- `_group.yaml`：order 106 / icon `globe` / theme 青蓝青绿 / chain `[moderator, fact-checker, stakeholder, policy-advisor]` / `rounds: true` / `parallel: true`（`parallelMax: 2`）/ guide「抛出一个议题，我们多视角研讨」/ agenda 4 条；
- 角色：齐观（议题主持，`docs/议题观察报告-<主题>.md` 开场版 + 终局收口；handoff → 尚真 / 方衡 / 允中）/ 尚真（事实核查，`docs/事实基线-<主题>.md`；skills source-verification）/ 方衡（立场图谱，`docs/立场图谱-<主题>.md`，含间接相关方与沉默方；skills deep-research）/ 允中（政策伦理 + 可行建议区间并入观察报告终局版；skills formal-document）；
- `stage` 预写：`{layout: roundtable, panel: pool}`（M52-B 消费）——围桌研讨语义，区别于 debate / negotiation 的 arena 对席。

### 62.3 观察报告两版覆盖语义

- moderator 开场版（议题与边界 / 研讨轮次记录 / 共识与分歧初稿 / 模拟声明）→ policy-advisor 收口版（议题与边界 / 共识与分歧 / 政策伦理 / 可行建议区间 / 模拟声明）后者覆盖前者（同一路径）；eval 以「政策伦理」「可行建议区间」校验最终版为收口版。

### 62.4 技能与预设

- skills 复用既有：source-verification / deep-research / formal-document（按角色预载，零新建技能）；
- 预设：`issue-roundtable`（齐观 · 尚真 · 方衡 · 允中，order 180）。

### 62.5 镜像面与验证

- 镜像面七件套：mock.ts 四件套（SCRIPTS 4 条 / artifactFor 4 case 与交付契约对齐 / DISPLAY_NAMES 4 / preferredOf 4 + judge 回填）+ `e2e/helpers.ts` AGENT_NAME +4（全量 85 角色 id→name 逐一相等，mock-coverage 守护）+ `m21.test.ts`（22 场景 / 85 角色 / 18 预设 / 协议断言 +1）+ README（统计与预载表）+ CHANGELOG；
- eval：新增 `23-society.json`（3 交付件 × 5 内容断言 + handoff + turns_lte 5 + judge rubric）；`--update-baseline` 后全量 23/23 通过（society 4 回合，相邻任务零回归）；
- 门禁：check:agents 22 场景 / 85 角色 / 18 预设（4 新头像 ✓）；check:skills 通过；server 75 文件 / 1031 测试、client 54 文件 / 621 测试全绿；四包 typecheck 0 错误；ESLint 干净；build 通过；相邻 E2E（m12-interactions / m16-members / m21-opc）4/4 全绿；
- 回填台账：judge → moderator 本批落地关闭（AGENT.md + mock preferredOf + m21 断言三处同步）；tactician → career.comp-advisor（M51-C 后）仍待；
- 文档：ADR 0108、本页 §62、ADR README 索引、`agents/README.md`、`docs/scene-expansion-design.md` §5.2、`agents/CHANGELOG.md` v34。

## 63. 工作创作三场景——创作工作室 · 职业发展 · 游戏工坊（M51-C）

M51 场景生态扩展（[docs/scene-expansion-design.md](docs/scene-expansion-design.md)）的第三批场景：写作（`writing`）、职业发展（`career`）、游戏工坊（`gamedesign`）——分别承接「长篇创作链」「求职陪跑」「游戏内容设计」三类需求（第 23-25 个场景，12 新角色）；三条领域红线各锚定一类失败模式（原创底线 / 履历真实 / 核心循环先行）。决策与被否决方案见 ADR 0109。本批为纯资产 + 镜像面批次：零引擎 / 零前端 / 零容器改动，`stage` 声明预写、M52-B 消费。

### 63.1 三条领域协议（各 11 条 = 铁律 7 + 工具 2 + 交接 / 声明 2）

- `writing`（「原创底线」）：不抄袭 / 不洗稿具体表达；参考标注来源与差异；编辑边界（只动语言与一致性，不擅改结构观点，重大改写列意见回 author 确认）；事实核对（非虚构附来源，不确定留白）；出版合规（真人真事风险提示）；
- `career`（「履历真实」）：不虚构经历 / 学历 / 成果 / 时间线；优化 = 真实亮点 STAR 化表达；候选人视角（与 recruiter 招聘方视角区隔）；薪资口径附来源时效（区间表达不承诺数字）；隐私纪律（脱敏与在职保密提示）；
- `gamedesign`（「核心循环先行」）：循环闭环不成立不进入数值与叙事细化；数值可解释禁魔数；「好玩」是假设需模拟验证（口径注明）；参考与原创标注。

### 63.2 三场景（4 角色各）

- `gamedesign` 游戏工坊：order 108 / icon `flame` / theme 紫粉 / chain `[game-designer, balance-designer, narrative-designer, playtester]` / `parallel: true`（`parallelMax: 3`，三路设计并行 + 验证收口）/ `rounds: false`——游心（玩法策划，`docs/游戏设计文档-<主题>.md`）/ 千衡（数值策划，`docs/数值平衡表-<主题>.md`）/ 织境（叙事策划，`docs/世界观设定-<主题>.md`）/ 百试（玩法验证，`docs/玩法测试报告-<主题>.md`）；`stage: {layout: dock, panel: board}`；
- `writing` 创作工作室：order 110 / icon `pen-tool` / theme 纸墨褐 / chain `[storyline, author, editor, publisher]` / `parallel: false`（串行创作链）——曲径（选题策划，`docs/选题大纲-<主题>.md`）/ 文藻（主笔，`docs/文稿-<主题>.md`）/ 锦言（编辑，`docs/定稿-<主题>.md`）/ 书远（出版顾问，`docs/出版方案-<主题>.md`，handoff → ip / pr）；`stage: {layout: dock, panel: board}`；
- `career` 职业发展：order 112 / icon `target` / theme 青绿 / chain `[career-advisor, resume-coach, interview-coach, comp-advisor]` / `parallel: false`（串行陪跑）——程途（职业顾问，`docs/职业规划-<主题>.md`）/ 履新（简历顾问，`docs/简历-<主题>.md`）/ 问达（面试教练，`docs/面试手册-<主题>.md`）/ 薪言（薪酬顾问，`docs/offer评估-<主题>.md`，handoff → negotiator / career-advisor）；`stage: {layout: dock, panel: coach}`。

### 63.3 技能与预设

- 新增 `skills/game-design`（设计分层 / 核心循环画法 / 数值体系 / 叙事咬合 / 玩法验证 / 检查清单）；writing / career 复用既有技能（零新建）；
- 预设：`writing-sprint`（曲径 · 文藻 · 锦言，order 190）、`job-hunt-sprint`（程途 · 履新 · 问达 · 薪言，order 200）、`game-kickoff`（游心 · 千衡 · 织境 · 百试，order 210）。

### 63.4 镜像面与验证

- 镜像面七件套：mock.ts 四件套 ×12（SCRIPTS 12 / artifactFor 12 与交付契约对齐 / DISPLAY_NAMES 12 / preferredOf 12 + tactician 回填）+ `TOPICS` 演示词表 +1（「求职」，尾部追加零回归）+ `e2e/helpers.ts` AGENT_NAME +12（全量 97 角色 id→name 逐一相等，mock-coverage 守护）+ `m21.test.ts`（25 场景 / 97 角色 / 21 预设 / 协议断言 +3）+ README（统计与预载表）+ CHANGELOG；
- eval：新增 `24-career.json`（4 交付件 × 4 内容断言 + handoff + turns_lte 5 + judge rubric）与 `25-gamedesign.json`（4 交付件 × 4 内容断言 + handoff + turns_lte 5 + judge rubric）；`--update-baseline` 后全量 25/25 通过（career / gamedesign 各 4 回合，相邻任务零回归）；
- 门禁：check:agents 25 场景 / 97 角色 / 21 预设（12 新头像 ✓）；check:skills 49；server 75 文件 / 1031 测试、client 54 文件 / 621 测试全绿；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过；相邻 E2E（m12-interactions / m16-members / m21-opc）4/4 全绿；
- 回填台账：tactician → comp-advisor 本批落地关闭（AGENT.md + mock preferredOf + m21 断言三处同步）；M51 回填台账全部关闭；
- 文档：ADR 0109、本页 §63、ADR README 索引、`agents/README.md`、`docs/scene-expansion-design.md` §5.3、`agents/CHANGELOG.md` v35。

## 64. 生活安居两场景——置业安家 · 家庭照护（M51-D）

M51 场景生态扩展（[docs/scene-expansion-design.md](docs/scene-expansion-design.md)）的第四批场景：置业安家（`housing`）、家庭照护（`care`）——分别承接「置业决策链」「照护事务支持」两类需求（第 26-27 个场景，6 新角色）；两条领域红线各锚定一类高风险失败模式（预算纪律 / 非医疗诊断）。决策与被否决方案见 ADR 0110。本批为纯资产 + 镜像面批次：零引擎 / 零前端 / 零容器改动，`stage` 声明预写、M52-B 消费。

### 64.1 两条领域协议（各 11 条 = 铁律 7 + 工具 2 + 交接 / 声明 2）

- `housing`（「预算纪律」）：首付来源与月供 / 收入比如实测算，不鼓励超还款能力方案（建议预留不低于 6 个月家庭开支的应急金）；房价 / 利率 / 政策数值注明来源与时效，不承诺涨跌、不制造焦虑；选房按维度打分给排序与理由，拍板权在用户；认购书 / 购房合同关键条款提示逐条核对；
- `care`（「非医疗诊断」）：不做诊断 / 不开药 / 不解读检查报告 / 不替代医生；陪诊边界只做「就医准备 + 过程记录」，医嘱只记录不加工；关注信号清单只列「值得留意的变化」与「出现以下情况请及时就医」；照护方案必须包含照护者排班轮值与自我关怀（喘息安排）。

### 64.2 两场景（3 角色各）

- `housing` 置业安家：order 114 / icon `map` / theme 砖橙 / chain `[home-finder, mortgage-advisor, reno-designer]` / `parallel: false`（串行决策链：需求 → 测算 → 落地）——择邻（选房参谋，`docs/选房对比-<主题>.md`）/ 家树（房贷顾问，`docs/贷款方案-<主题>.md`，handoff → wealth / legal）/ 筑居（装修规划师，`docs/装修方案-<主题>.md`）；`stage: {layout: dock, panel: board}`；
- `care` 家庭照护：order 116 / icon `heart-handshake` / theme 玫红 / chain `[care-planner, care-escort, elder-advisor]` / `parallel: false`（串行照护链）——顾宁（照护规划师，`docs/照护方案-<主题>.md`）/ 陪安（陪诊助手，`docs/陪诊记录-<主题>.md`）/ 颐和（康养顾问，`docs/康养建议-<主题>.md`）；`stage: {layout: dock, panel: coach}`。

### 64.3 技能与预设

- 零新建技能：两场景复用既有技能库（housing 按角色预载 deep-research / spreadsheet-modeling / financial-modeling / visual-design；care 预载 process-improvement / doc-coauthoring / formal-document / source-verification）；
- 预设：`home-purchase`（择邻 · 家树 · 筑居，order 220）、`care-plan`（顾宁 · 陪安 · 颐和，order 230）。

### 64.4 镜像面与验证

- 镜像面七件套：mock.ts 四件套 ×6（SCRIPTS 6 / artifactFor 6 与交付契约对齐 / DISPLAY_NAMES 6 / preferredOf 6）+ `TOPICS` 演示词表 +2（「购房」「长辈」，尾部追加零回归）+ `e2e/helpers.ts` AGENT_NAME +6（全量 103 角色 id→name 逐一相等，mock-coverage 守护）+ `m21.test.ts`（27 场景 / 103 角色 / 23 预设 / 协议断言 +2）+ README（统计与预载表）+ CHANGELOG；
- eval：新增 `26-housing.json`（3 交付件 + 4 内容断言（对比矩阵 / 砍价策略 / 压力测试 / 验收清单）+ handoff + turns_lte 4 + judge rubric）与 `27-care.json`（3 交付件 + 4 内容断言（排班与分工 / 非医疗声明 / 就诊记录 / 适老化改造清单）+ handoff + turns_lte 4 + judge rubric）；`--update-baseline` 后全量 27/27 通过（housing / care 各 3 回合，相邻任务零回归）；
- 门禁：check:agents 27 场景 / 103 角色 / 23 预设（6 新头像 ✓）；check:skills 49；server 75 文件 / 1031 测试、client 54 文件 / 621 测试全绿；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过；相邻 E2E（m12-interactions / m16-members / m21-opc）4/4 全绿；
- 文档：ADR 0110、本页 §64、ADR README 索引、`agents/README.md`、`docs/scene-expansion-design.md` §5.4、`agents/CHANGELOG.md` v36。

## 65. 命理占星两场景——传统数术 · 星象占星（M51-E）

M51 场景生态扩展（[docs/scene-expansion-design.md](docs/scene-expansion-design.md)）的最后一批场景：传统数术（`metaphysics`，7 角色）、星象占星（`astrology`，4 角色）——分别承接「传统术数研习」与「西方占星参考」两类文化研习需求（第 28-29 个场景，11 新角色）；两条领域红线各锚定一类失败模式（表述纪律 / 排盘可验），并以**排盘工具四件套 + `::: pan` 容器**首次实现「先盘后论」的结构化呈现。本批为工具 + 容器 + 资产批次：新增四个纯计算只读工具、一个 Markdown 容器与配套渲染，引擎零改动（`stage` 声明预写、M52-B 消费）。决策与被否决方案见 ADR 0111。至此 M51 五批全部落地（29 场景 / 114 角色 / 26 预设 / 51 技能 / 4 排盘工具）。

### 65.1 两条领域协议（各 11 条 = 铁律 7 + 工具纪律与协作 4）

- `metaphysics`（「表述纪律 + 排盘可验」）：文化研习与参考定位，不承诺预测准确率；医疗 / 投资 / 法律 / 婚育 / 生死不做结论性建议；禁止恐吓话术与付费化解暗示；结论给「参考区间」不给「必然」；先出盘后解读——先调排盘工具出盘面再基于盘面推演，禁止心算排盘或编造盘面；术语首次出现附白话释义；生辰隐私仅用于本次排盘；时辰存疑先给「时辰敏感度说明」不硬选；未工具化门类（大六壬 / 奇门 v1 无排盘工具）显式声明精度边界；起卦记录种子可复现；
- `astrology`（「盘面为据 + 参考不给宿命」）：星盘是自我参照与时机参考的语言，不承诺预测、不断言宿命；挑战性相位表述为「课题与成长点」，禁止灾祸恐吓；时区显式（缺省拒绝）、高纬自动降级等宫制并如实告警；时间不确定标注「上升与宫位敏感」不做单一定论；合盘需双方知情前提、不做关系走向断言；行运给「时间窗 + 触发点」不断言事件、不制造焦虑。

### 65.2 两场景（7 角色 / 4 角色）

- `metaphysics` 传统数术：order 118 / icon `moon` / theme 玄墨金 / chain `[bazi, ziwei, liuyao, meihua, qizheng, daliuren, qimen]` / `parallel: true`（parallelMax 4，多术可同波并行、各自落盘）/ `rounds: false` / `defaultSkills: [chinese-metaphysics]`——观复（四柱研习师，`docs/八字命盘-<主题>.md`）/ 星垣（紫微研习师，`docs/紫微命盘-<主题>.md`）/ 灼见（六爻研习师，`docs/六爻卦解-<主题>.md`）/ 溯机（大六壬研习师，`docs/大六壬课解-<主题>.md`）/ 心易（梅花研习师，`docs/梅花卦解-<主题>.md`）/ 步天（七政研习师，`docs/七政星盘-<主题>.md`）/ 奇正（奇门研习师，`docs/奇门局解-<主题>.md`）；`stage: {layout: dock, panel: chartboard}`（多盘 tab 面板，M52-B 消费）；
- `astrology` 星象占星：order 120 / icon `star` / theme 星夜蓝紫 / chain `[natal, transit, synastry, horary]` / `parallel: true`（parallelMax 4）/ `rounds: false` / `defaultSkills: [western-astrology]`——司辰（本命占星师，`docs/本命盘报告-<主题>.md`）/ 星移（行运占星师，`docs/行运报告-<主题>.md`）/ 合璧（关系占星师，`docs/合盘报告-<主题>.md`）/ 问星（卜卦择时师，`docs/择时报告-<主题>.md`）；`stage: {layout: dock, panel: chartboard}`（星盘轮盘 + 相位表，M52-B 消费）。

### 65.3 排盘工具四件套与 `::: pan` 容器

- **工具**（`server/src/pan/`：bazi / ziwei / natal / gua；tier=deferred + `tool_search`「排盘 / 命盘 / 星盘」检索激活；纯计算只读无审批，与 `fin_*` 同为「专业域工具」模式）：`bazi_pan`（四柱 / 十神 / 藏干 / 五行统计 / 大运流年 / 真太阳时校正告警；lunar-typescript）、`ziwei_pan`（十二宫 / 主星辅星 / 四化 / 五行局 / 大限；iztro）、`natal_pan`（行星 / 宫头 / 相位矩阵 / 四轴；astronomy-engine + 自研 Placidus 宫位与相位算法，高纬降级等宫制）、`gua_pan`（六爻 / 梅花：本卦变卦互卦 / 六亲六神世应 / 体用；规则代码化 + 种子可复现）；失败结构化报错（禁心算兜底）；白名单配给 metaphysics / astrology 全员；golden 案例测试 `server/tests/m51-pan.test.ts` 21 例（八字 / 紫微 / 星盘各 ≥3 例 + 卦固定种子复现）；
- **`::: pan` 容器**（design §7.7 契约）：`remark-ext` 新增 builder（`::: pan <bazi|ziwei|natal|gua> [标题]` + `键：值` 字段行 → `data-fields` + `- 键 | 值` 条目行 → `data-items`）+ 客户端 `PanCard` 渲染（四类型徽标 / 字段行 / 条目行 / raw 恒等兜底）；降级链：流式直接渲染（同 verdict 档）/ 未知类型通用「盘面」徽标 / 解析失败保持原文；测试 `client/tests/m51-md-pan.test.tsx` 10 例 + E2E `markdown-ext.spec.ts` 盘面卡用例（真实浏览器）；M52-B 升级 PanBoard 盘面板。

### 65.4 技能与预设

- 新增技能 2：`skills/chinese-metaphysics`（术数门类框架 / 排盘与解读流程 / 表述纪律 / 检查清单）、`skills/western-astrology`（本命 / 行运 / 合盘 / 择时的排盘与解读框架、时间精度与表述纪律——盘面为据、给参考不给宿命）；
- 预设 3：`chart-combo`（命盘合参：观复 · 星垣，order 240）、`oracle-crossread`（卦象互参：灼见 · 心易，order 250）、`full-horoscope`（星盘全解：司辰 · 星移 · 合璧，order 260）。

### 65.5 镜像面与验证

- 镜像面七件套：mock.ts 四件套 ×11（SCRIPTS 11 / artifactFor 11 与交付契约对齐 / DISPLAY_NAMES 11 / preferredOf 11）+ `TOPICS` 演示词表 +1（「前程」，尾部追加零回归）+ `e2e/helpers.ts` AGENT_NAME +11（全量 114 角色 id→name 逐一相等，mock-coverage 守护）+ `m21.test.ts`（29 场景 / 114 角色 / 26 预设 / 协议断言 +2 / 排盘工具绑定 it）+ `agents/README.md`（统计与预载表 +2 行）+ CHANGELOG；
- eval：新增 `28-metaphysics.json`（3 交付件 + 4 内容断言（排盘参数与校正告警 / 十二宫与命身宫 / 相位与平衡 / 参考声明）+ handoff_targets + turns_lte 4 + judge rubric）；`--update-baseline` 后全量 28/28 通过（metaphysics 3 回合，相邻任务零回归）；
- 门禁：check:agents 29 场景 / 114 角色 / 26 预设（11 新头像 ✓）；check:skills 51；server 76 文件 / 1053 测试、client 55 文件 / 631 测试全绿；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过；相邻 E2E 8/8 全绿（m12-interactions / m16-members / m21-opc / markdown-ext，含盘面卡用例）；
- 文档：ADR 0111、本页 §65、ADR README 索引、`agents/README.md`、`docs/scene-expansion-design.md` §5.5、`agents/CHANGELOG.md` v37。

## 66. 场景工作区体系——四形态容器 · 六面板注册表 · 12 元件库（M52-A）

M52（[docs/scene-expansion-design.md §7](docs/scene-expansion-design.md)）第一批「框架」：把 M51 各批预写的 `stage` 声明从 yaml 里的注释语义变为运行时渲染——四形态容器（stream / dock / roundtable / arena）+ 六面板注册表 + 12 元件库 + 纯前端派生 + 降级链与「切回纯列表」开关。纯前端 + 一个 shared 可选字段（零引擎 / 零协议 / 零消息数据层改动）；消息流在 stream 形态下零结构变化，任何异常一律回退聊天流。决策与被否决方案见 ADR 0112。

### 66.1 类型与声明（向后兼容）

- `GroupStageSchema`（shared）：`layout` 四枚举（stream / dock / roundtable / arena）、`panel` 六枚举（pool / versus / board / console / coach / chartboard）、`seats {left, center, right}`（角色 id 数组）、`parts`（12 元件名）；`AgentGroupSchema` 挂可选 `stage`——未声明即 stream，M51 已写的声明本批起生效；
- 校验：seats 引用角色存在性（m21 正负例 +2）——声明错误在资产检查期暴露而非运行时。

### 66.2 四形态容器与降级链（§7.2 / §7.3）

- **stream**：零新增结构直通（Fragment）——未声明场景与「切回纯列表」下与今天逐个字节一致；
- **dock**：左对话 + 右工作区（默认 340px；拖宽 clamp 260–520、折叠、关闭，localStorage `ma:sc:dock` 记忆）——折叠条与 reopen 小按钮；窄屏（<900px）右区收起为底部抽屉（默认收起）；
- **roundtable**：顶席位环（SeatRing，waiting / speaking 态）+ 中消息流 + 右汇聚板（AgendaTrack 波次进度 + panel）；窄屏席位环降为 SeatStrip 横条；
- **arena**（v1 按 §7.9 口径「席位分栏 + 回合轴 + 计分板」）：顶 Scoreboard（多空计数）+ 左 / 右 SeatCard 席位栏 + 中轴（center 席 + RoundTrack 回合轴 + 消息流）；窄屏 SeatStrip + 单流降级；
- **降级链**（`resolveStage` 纯函数）：未声明 / 非法 layout / arena 缺席位 / listMode → stream（`fallback: true` 标记异常，listMode 回退不算）；非法 panel 忽略（保留 layout）；parts 过滤非法项。

> **M58 修订（ADR 0127 / §79）**：dock 右区默认宽 340 → 360px、拖宽 clamp 260–520 → 280–640（拖拽零 React 渲染——ref 直改 + 抬手落盘；双击复位 / ←→ 键盘微调 16·48px / pointercancel 回滚）；独立操作条（折叠 / 关闭钮）删除——注入面板标题行（PanelShell 统一「图标 + 标题 + 徽标 + 操作合行」）；新增「无数据不展示」——面板未就绪（六口径见 §79.1）时右区 / 汇聚板 / 窄屏抽屉整体不渲染（直通纯对话流），有内容自动出现（组件级 PanelEmpty 空态保留为兜底）。

### 66.3 六面板与 12 元件库（§7.4 / §7.6）

- 六面板（注册表 `STAGE_PANEL_COMPONENTS`，element 注入容器切断循环导入）：pool 汇聚板（容器条目卡墙 + 深入回填）/ versus 局势面板（多空信号 + MomentumBar + 裁决卡）/ board 工序面板（标题目录树 + 版本线 + 交付件）/ console 看板面板（KanbanBoard + 时间轴）/ coach 陪跑面板（ProgressRing + CheckGrid 勾选）/ chartboard 盘面板（多盘 tabs + PanBoard）；
- 12 元件（`PART_NAMES`，kebab-case；`parts` 空声明 = 全启用）：MomentumBar / Scoreboard / RoundTrack / SeatRing / SeatCard / AgendaTrack / KanbanBoard / ClaimTree / ProgressRing / CheckGrid / VerdictPart / DeliveryPanel——空态一律 PanelEmpty（「不空白、不报错」）；
  > **v68 修订（2026-09-19）**：parts 可裁剪面收敛为实际受控的 arena 五件套（round-track / scoreboard / verdicts / claim-tree / offers）——「12 元件」中其余元件为容器 / 面板内部固定组成，不参与 parts 裁剪；debate / negotiation 首批声明落地，详见 §87。
- 纯前端派生（`derive.ts`）：parseContainers（行级 `::: name arg` 块扫描，未闭合忽略）/ panRowsOf / verdictsOf（多空·正反·僵持 → long / short / draw）/ checklistItemsOf / headingsOf（跳过围栏）/ wavesOf · speakingIdOf——工作区数据 = 消息流 + artifacts 的投影，零新增数据通道。

### 66.4 交互、持久化与性能

- 交互态：面板 tabs 与会话勾选覆盖走 sessionStorage（`ma:sc:tab:<sid>:<key>` / `ma:sc:checks:<sid>`）；「切回纯列表」开关 localStorage `ma:sc:list`（ChatArea 标题栏，仅声明 stage 的会话组显示）；回填统一 composerInsert 语义（深入展开 / 看解读 / 汇报进度 → Composer 草稿）；交付件打开复用 ui-store.requestArtifact（live-panel 订阅链）；
- 性能红线：工作区订阅 500ms 节流 + 流式冻结（streaming 期间冻结、完成态刷 新）；busy selector 全部返回原始值（流式 delta 不触发宿主重渲染）；虚拟列表与消 息数据层零改动（M60 修订：SideFeed 走实时快照例外——仅纯文本投影面不冻结， 容器解析面口径不变，见 §81 / ADR 0129）；
- 可达性：quiet-mode 与 prefers-reduced-motion 下场景过渡 / 脉冲 / 入场动画全关（index.css 收敛块）。

### 66.5 测试与门禁

- vitest：`client/tests/m52-stage.test.tsx` 22 例（resolveStage 降级链 6 / derive 纯函数 6 / 面板空态 4 / pool 集成回填 2 / SceneStage 宿主 4）；server `m21.test.ts` seats 正负例 +2；
- E2E：`e2e/m52-stage.spec.ts` 2 例（传统数术 dock 工作区空态与「切回纯列表」往返；窄屏抽屉默认收起可展开）——playwright `testMatch` 白名单开 `m52-.*`；
- 门禁：check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 76 文件 / 1055 测试、client 56 文件 / 653 测试全绿；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning，顺手清理 1 条本批引入）；build 通过（主包 gzip 330.91 kB，存量欠账持续关注）；eval 28/28 零回归；相邻 E2E 5/5 全绿（relay / m21-opc / m16-serial）；
- 文档：ADR 0112、本页 §66、ADR README 索引、`agents/CHANGELOG.md` v38；下一批：**M52-B** 点亮走查（已完成，见 §67）→ **M52-C** 既有场景接入（已完成，见 §69）。

## 67. 新场景点亮走查——十个声明场景渲染验证（M52-B）

M52（[docs/scene-expansion-design.md §7](docs/scene-expansion-design.md)）第二批「点亮」：对 M51 各批预写的十个 `stage` 声明逐一实测渲染（arena 2 / roundtable 1 / dock 7）——本批为**验证 + 测试批次**：零 src / 零资产 / 零协议改动（仅 `e2e/m52-stage.spec.ts` 与 `client/tests/m52-stage.test.tsx` 增补）；§66 框架本体零修订，走查闭环确认「声明即渲染」。

### 67.1 声明与渲染逐一核对（10/10）

- arena 2：`debate`（left affirmative / right negative / center judge · evidence）与 `negotiation`（left negotiator / right counterpart / center tactician）——席位分栏 + 计分板 + 中轴回合轴；发消息后「第 N 轮」与回合轴随流推进、终局交还用户；
- roundtable 1：`society`——席位环 4 席（waiting / speaking 态）+ 议程波次条（agenda 4 条：todo → doing → done）+ 右汇聚板（pool）；
- dock 7：board（`gamedesign` / `writing` / `housing`）、coach（`career` / `care`）、chartboard（`metaphysics` / `astrology`）——工作区开合 / 拖宽 / 折叠记忆（`ma:sc:dock`），面板空态与「切回纯列表」往返正常；
- 等价覆盖口径：同形态同面板组合以代表场景 E2E 全链（debate / society / writing / career / metaphysics）+ 全量 yaml 静态核对（10 场景声明与 §7.5 矩阵逐字段比对）闭环；未逐一复跑的 negotiation / gamedesign / housing / care / astrology 由相同组合的组件级走查覆盖。

### 67.2 测试与走查发现

- E2E `m52-stage.spec.ts` 2 → 7 例（+5）：roundtable 席位环与议程推进 / arena 全链（发消息 → 计分板轮次 + 回合轴 + 交还用户）/ dock·board / dock·coach / arena 窄屏（SeatStrip 横条 + 单流降级）；
- vitest `m52-stage.test.tsx` 22 → 25 例（+3 组件级走查）：arena 席位分栏（左 / 右 / 中轴实名 + 计分板「第 1 轮」）/ seats 成员不在场兜底（空栏 + 「左席 / 右席」占位 +「未开赛」）/ roundtable（席位环 4 名 + 议程 `scene-ag-doing` 推进 + 汇聚板空态）；
- 发现（均测试侧处理，零资产变更）：①「议题圆桌」为唯一预设（`issue-roundtable`）× 场景（`society`）同名对——创建对话框两来源区按钮 aria-label 相同，E2E 改用场景行独有「∥ 并行协作」特征文案精确定位；② board 面板空态文案「文稿结构与版本将在这里显示」偏 writing 语境（gamedesign / housing 共用），记入 M52-C 逐场景细化事项。

### 67.3 门禁

- mock 28/28 零回归（零 agents 资产变更，baseline 未动）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 76 文件 / 1055 测试、client 56 文件 / 656 测试（+3）全绿；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过（主包 gzip 330.90 kB，较 M52-A 330.91 kB 持平——零 src 变更）；
- E2E：`m52-stage.spec.ts` 7/7 全绿（含 arena 全链）；相邻回归 relay / m21-opc / m16-serial——m16-serial 首跑 1 例浏览器会话崩溃（Protocol error: session closed）偶发，复跑 2/2 全绿澄清非回归；
- 文档：本页 §67、`agents/CHANGELOG.md` v39；下一批：**M52-C** 既有场景接入（已完成，见 §69）、M42→roundtable（已完成，见 §71）/ M43→arena 合流增强（已完成，见 §72）。

## 68. 专业排盘卡增强——四张盘面卡专业化 · 契约测试 · 协议纪律（M53）

M51-E 交付排盘四件套与 `::: pan` 容器后，实测反馈盘面信息单薄（紫微 tab 仅命宫 3 行、八字 tab 仅 5 行），未达「专业命理师」盘面参考的丰富度；同期两处关联问题：盘面卡无标题使多盘 tab 区分退化（两个卦盘均显示类型名「gua」）、模型仿写 `[工具调用]` 日志与虚假落盘声明。本批为**工具 / 协议批次**：计算层四模块字段扩展、四张盘面卡重写（卡头标题 + 字段行 + 单一连续条目列表）、契约测试 `m53-pan-card.test.ts`、协议三处纪律（整卡复制 / 卡面复用 / 记录真实）；引擎与客户端零改动（`::: pan` 容器契约不变，M51-E 解析规则原样消费，零新增依赖）。决策与被否决方案见 ADR 0113。

### 68.1 计算层字段扩展（server/src/pan/）

- **bazi**：旬空（年 / 月 / 日 / 时四柱）· 地势（十二长生）· 胎元 / 胎息 / 命宫 / 身宫（含纳音）· 生肖星座 · 起运交运日期 · 大运流年当前标记；
- **ziwei**：四柱干支 · 生肖星座 · 来因宫 · 生年四化（禄权科忌 × 星）· 十二长生 · 杂曜（至多 6 个 + 省略号防行过长）· 当前大限标记；
- **natal**：元素（火土风水）与模式（基本 / 固定 / 变动）分布（十大行星按落座计数）；
- **gua**：卦气（起卦四柱 / 日辰旬空 / 农历）· 错卦综卦 · 卦体上下卦（卦象 · 五行）· 旬空爻标记 · 动爻变爻（干支五行六亲）。

### 68.2 四张盘面卡（server/src/tools/pan.ts）

- **卡头标题**（盘面板 tab 区分与用户指认依赖）：`四柱 庚午 辛巳 丁丑 丁未`（bazi）/ `紫微 土五局 ｜ 命宫 丙戌`（ziwei）/ `本命盘 <出生时刻>`（natal）/ `天雷无妄 → 天火同人`（gua，无动爻时仅本卦名）——两个卦盘以卦名区分，消解「重复的卦」标签退化；
- **卡体结构**：`键：值` 字段行在前 + 单一连续条目列表（`- 键 | 值`，值内分隔用全角 ｜）——与 remark-ext / chartboard 解析规则同源（finalizePan 只消费第一个 list；字段键 ≤16 字符）；
- **丰富度基线**：八字 11 字段 + 大运 8 步 + 流年 10 条（含当前标记）/ 紫微 6 字段 + 12 宫条目（主星亮度四化 · 辅星 · 杂曜 · 长生 · 大限）/ 星盘 3 字段 + 38 条目（10 行星 · 12 宫头 · 16 相位）/ 卦 9 字段 + 六爻条目（六神六亲 · 旬空 · 动爻变爻）；
- **引导句与描述**：统一「盘面卡（复制到回复渲染，整卡原样保留、勿增删字段）」；四件套工具描述升级为「唯一口径」表述（盘面数据必须出自工具，禁止心算或凭记忆推算）。

### 68.3 契约测试与协议纪律

- `server/tests/m53-pan-card.test.ts`（4 例）：与 remark-ext 解析规则同源复刻的卡格式不变量（卡头 kind / 标题非空 / 单一列表连续性 / 字段行正则 / 条目行格式）+ 四卡丰富度基线；`server/tests/m51-pan.test.ts` 21 例断言扩展（旬空 / 地势 / 胎元四宫 / 生肖 / 大运 toMatchObject / 生年四化 / 元素模式 / 卦气旬空 / 空亡爻 / 变爻）——两文件合计 25 例全绿；
- **协议**（agents/）：全局 `_protocol.md` tool_policy 新增「记录真实性（红线）」（`[工具调用]` 区块为系统注入的真实执行记录，禁仿写日志 / 编造结果 / 虚假落盘声明）；`metaphysics` / `astrology` 两场景 8 号追加「盘面卡整卡原样复制（含卡头标题，勿增删字段与条目）」、新增 12（卡面复用：同参数不重复起卦 / 排盘，先查历史；多成员同波先声明分工）与 13（记录真实红线）。

### 68.4 门禁

- mock 28/28 零回归（协议追加条款不影响脚本链路，baseline 未动）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 77 文件 / 1060 测试、client 56 文件 / 660 测试全绿；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；
- E2E：`markdown-ext.spec.ts` 4/4 全绿（含盘面卡 `::: pan` 渲染用例——卡头标题 / 字段行 / 条目行真实浏览器验证）；
- 文档：ADR 0113、本页 §68、`docs/adr/README.md` 索引、`agents/CHANGELOG.md` v40。

## 69. 既有场景接入——14 场景 stage 声明合入（M52-C）

M52（[docs/scene-expansion-design.md §7](docs/scene-expansion-design.md)）第三批「接入」：把 M51 既有 14 个场景逐一接入场景工作区体系（§66 框架）——按「零资产改动」原则只追加 `stage` 声明（不新增角色 / 技能 / 预设 / 协议）；本批为**声明 + 验证批次**：零 src / 零前端 / 零容器改动（仅 14 个 `_group.yaml` 追加 stage 块 + `server/tests/m21.test.ts` 断言同步 + `e2e/m52-stage.spec.ts` 走查增补）。至此 29 场景中 24 场景已声明，仅余 stream 四场景（development / finance / ops / home）保持未声明零改动（缺省即 stream）；blank 单 Agent 场景不在工作区体系内。

### 69.1 声明合入（14/14，与 §7.10 矩阵逐字段一致）

- C1 研讨域（roundtable·pool ×3，与 society 共用形态与面板）：`brainstorm` / `research` / `strategy`——席位环 + 议程波次 + 汇聚板；
- C2 工作域（dock ×6）：`sre` / `bi` / `marketing` / `sales` / `funding`（console：看板 + 时间轴 ×5）+ `invest`（versus：多空信号 + 裁决卡 ×1）；
- C3 生活域（dock·coach ×5）：`health` / `learning` / `travel` / `wealth` / `personal`——进度环 + 勾选；
- 接入原则落实：角色 / 协议 / 技能 / 预设 / 镜像面（mock 四件套 / TOPICS / AGENT_NAME / README）零变化；stream 四场景零改动（回归零风险）。

### 69.2 测试与走查

- `m21.test.ts`：新增「M52-C 既有场景接入：14 场景声明合入」断言（roundtable·pool ×3 / dock·console ×5 / dock·versus ×1 / dock·coach ×5 分组逐字段 + 全量总账「24 组已声明」）；「stream 四场景缺省」断言同步（未声明集合定为 development / finance / ops / home）；
- E2E `m52-stage.spec.ts` 7 → 22 例（+15）：C1 ×3（席位环 4/4/3 席 + 议程推进 + 汇聚板空态）、C2 ×6（console 五场景看板空态 + invest 局势面板空态）、C3 ×5（coach 五场景陪跑面板空态）、roundtable 窄屏（席位横条 + 汇聚板抽屉默认收起可展开）；
- 走查发现（测试侧处理，零资产变更）：「学习成长」场景与既有文案存在 `getByText` 子串歧义，E2E 定位精化为工作区面板作用域。
- 逐场景细化（补 §67.2 遗留，收尾补办）：面板空态文案逐场景化——board ×3（gamedesign「设计文档与数值表」/ writing「文稿结构与版本」/ housing「方案对比与预算测算」）+ coach ×7（health「打卡与周计划」/ learning「学习路径与打卡」/ travel「行程与预算」/ wealth「预算与目标进度」/ personal「事务清单与提醒」/ career「求职进度与产出物」/ care「照护排班与清单」），未收录场景均落中性默认；coach 内容区兜底标题同步场景化（checklist 容器无标题时按场景落「打卡 / 学习 / 行程 / 目标 / 事务 / 求职 / 照护清单」，未收录场景落中性「清单」）；组件测试补相应空态 / 兜底覆盖（`m52-stage.test.tsx` +5 → 34 例）；E2E 六处 coach 空态断言随场景语汇同步（用例数不变）。测试覆盖补缺（收尾续办）：面板内容态组件测试补齐——console 空态（原零覆盖）与管道/时间轴、board 目录树/版本线、versus 多空列/裁决卡、chartboard 盘面 tabs（`m52-stage.test.tsx` +5 → 39 例），兜底标题断言扩为 7 场景全轮询。

### 69.3 门禁

- check:agents 29 场景 / 114 角色 / 26 预设（零资产变更）；check:skills 51；server 76 文件 / 1056 测试（m21 +1）、client 56 文件 / 660 测试全绿；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过（主包 gzip 331.29 kB，较 M52-B +0.39 kB 系并发会话 client 改动所致，本批零 src 变更）；eval 28/28 零回归；
- E2E：`m52-stage.spec.ts` 22/22 全绿（14 场景 + 窄屏 + A/B 回归）；
- 相邻回归：m16-brainstorm / m21-opc（×2）/ relay 全绿；m16-serial「默认串行」干净环境通过、「关闭串行」4 次复跑均失败（最近 2 次为无并发干净环境）——诊断：服务端 Run 全部正常收束（done + handed_to_user=1），前端运行态滞留（并行组「1/2 完成」后 90s 未推进）致尾条消息未进视口、「你的回合」不渲染；判定非本批回归（零 src 变更、改动零交集），引入点在并发会话 client UI 改动窗口内；收尾复验：并发会话后续改动落盘后 2/2 全绿（27.5s），账目闭合；
- 收尾补办门禁（逐场景细化 + 测试补缺后）：client 56 文件 / 673 测试全绿（含并发会话增量；本批净 +10）、typecheck 0 错误、lint 0 错误（13 条既有 warning）、build 通过（主包 gzip 332.31 kB，含并发会话改动；测试补缺零 src 变更，结论沿用）、E2E `m52-stage.spec.ts` 22/22 全绿（复用并发会话 webServer 实例；coach 语汇同步后 50.6s、兜底标题后 55.0s 两轮复跑；补缺后同样零 src 变更）；
- 文档：本页 §69、`agents/CHANGELOG.md` v41；下一批：M42→roundtable（已完成，见 §71）/ M43→arena 合流增强（已完成，见 §72）。

## 70. arena 席位发言流 · 运行中回合号回填 · 贴底跟随末端锚定（M52-D）

M52（[docs/scene-expansion-design.md §7](docs/scene-expansion-design.md)）第四批「增补」：arena 左右席发言流以**投影版**先行落地（§7.2 目标形态「左 = 左席发言流 / 右 = 右席发言流」，先于 M43 合流），并修复运行链路三处实时性问题——运行中回合号缺省（§70.2）、贴底跟随被虚拟测量调整打断（§70.3）与运行流订阅晚到（§70.5，全量 E2E 甄别出的产品缺陷）；纯前端批次（零服务端 / 零资产 / 零容器协议改动）。

### 70.1 席位发言流投影（SideFeed）

- 新组件 `client/src/components/scene/SideFeed.tsx`：arena 左右席卡片下栏——该席成员消息投影为可定位条目（**最新在上**；多成员按消息序混排并显示名字；轮次徽标「第 N 轮」；标题挂全文；点击条目 `focusMessage` 定位原消息；空态「该席发言将显示在这里」——两侧留白补齐）；
- **投影而非拆流**：数据源复用 `useSceneMessages`（M52-A 的 500ms 节流 + 流式冻结），纯前端派生、不复制消息数据层、不触碰虚拟列表结构键契约（ADR 0112 约束 下与 §7.2 目标形态对齐，决策见 ADR 0114；M60 修订：SideFeed 改接 `useSceneLiveMessages` 实时快照——实时仅限纯文本投影面，容器解析面保持冻结，见 §81 / ADR 0129）；
- `derive.ts` 新增 `excerptOf`（正文摘录纯函数）：跳过代码围栏 / 表格 / 公式 / 分隔线，剥离 Markdown 标记，56 字符截断——条目显示首行正文；
- 零编制（成员不在场）时席位栏保持空（不注入发言流）；窄屏沿用 §7.3-4 降级（单流 + 席位横条）。

### 70.2 运行中回合号回填（turnIndex）

- 现象：运行中 arena 计分板「未开赛」、回合轴不前移、侧栏发言流无轮次徽标——直到刷新（run:end 全量刷新）才恢复；
- 根因：`run-store` 的 `turn:start` 归约**丢弃**服务端事件携带的 turnIndex（engine.ts 本就随 turn:start 下发 waveIndex，shared 类型已声明）——占位消息 turnIndex 缺省使「角色~运行~回合」结构键不满足波次 / 回合派生条件，实时面（计分板 / 回合轴 / 发言流轮次 / M16 并行成组）整体滞后至运行结束；
- 修复：`handleRunEvent` 的 `turn:start` 分支回填 `event.turnIndex`（运行中即推进，与 §18.2 重放路径同一数据口径）；单测 `run-events.test.ts` 锁定（turn:start → 消息 turnIndex 即时可读）；连带效果——并行组（M16）在运行中即可成组渲染（此前须等 run:end 全量刷新）。

### 70.3 贴底跟随末端锚定（虚拟列表测量竞态根治）

- 现象：流式收尾 / 收尾清单（CloseoutCard 为非虚拟化兄弟节点，异步撑高）后，视口偶发停在「距底 100–500px」处，或出现带瞬时大 gap 的离底翻转（「回到最新」浮标误现、尾条被剪枝）；
- 根因：程序化贴底（scrollTop = scrollHeight）后，虚拟列表对「上方行实测行高回填」按单项差值调整滚动偏移（virtual-core 的 applyScrollAdjustment），浏览器补发的 scroll 事件据此算出瞬时大 gap——离底判定被自身滚动回声误导；
- 修复（三层）：① 虚拟化器启用内建**末端锚定**——`anchorTo: 'end'`（贴底态按总量差补偿，不再被上方行重测拽离末端）+ `followOnAppend: true`（贴底时追加行走库内跟随）+ `scrollEndThreshold = STICK_BOTTOM_THRESHOLD`（与上滑判定同宽，用户上滑超出后两者同时停手）；② `BottomFollower` 补正窗口（数帧 rAF）+ `ResizeObserver` 观察子节点尺寸兜底 + `pinnedTopRef` 记录实际贴底偏移；③ `onScroll` **回声守卫**——偏移仍锚定在上次贴底位置（未被用户上拖）时视为自身滚动回声，立即补正、不做离底翻转；
- 容器加 `[overflow-anchor:none]`：消解浏览器原生滚动锚定与程序化贴底的竞争（波次分隔行中途插入 / 行高回填时不再与锚定策略拉扯）。

### 70.4 E2E 口径：虚拟剪枝是正确行为 · 断言先滚入渲染窗口

- 虚拟列表只渲染「视口 + overscan」内的行——视口贴底跟随时，流上方文本（并行组头 / 首条用户消息 / 早期回合）**不在 DOM**，`toBeVisible` 会落空（历史 flaky 根因）；
- 统一口径（与 M37 先例一致）：断言「流上方」文本前先滚入渲染窗口（`el.scrollTop = 0` + 派发 scroll），再断言；`reload` 场景以「滚顶 + 短断言」重试覆盖消息加载竞态，断言后滚底恢复贴底跟随；
- 加固五处：`m16-parallel`（运行中并行组断言 → 收束后滚顶断言）、`m16-serial` 关闭串行 / 默认串行（同口径，早期回合断言改收束后滚顶）、`reload` 重附着（首条用户消息，重试 + 滚底续看收束）、`m14` 长会话（首条消息断言前滚顶）；
- 运行收束竞态（同族第二类）：`m16-members`「运行中邀请」要求邀请链路在末波选人前落库（mock 整轮 7 波约 2.6–3.6s 收束）——原「等停止按钮」护栏在流式负载下实测可耗 ~1.9s，反把邀请挤出窗口；改为成员视图预切换（发送前）+ 邀请三步直发，落库时序由 +3.0s 提前至 ~+1.1s（「卢娜在后续回合发言」断言即邀请时效的强校验）。
- 竞态面收敛（E2E 基建调参）：收口期全量复跑又暴露同族一例——`reload` 重附着（机器负载下的刷新 + 重进耗时追平 mock 整轮 ~3.2s，重附着成功但「停止」可见窗口低于断言轮询精度，重进时运行已到尾声）；`playwright.config.ts` 全局 mock 节奏 `LLM_MOCK_DELAY_MS` 20 → 30ms/片（整轮 ~3.2s → ~4.8s）——页面初始化耗时不再与运行时长贴身赛跑，同族窗口系统性放宽；对等待式断言无影响（小超时断言静态排查均与运行节奏无关；新节奏单跑复验 9/9 全绿）。

### 70.5 运行流订阅晚到兜底（全量 E2E 甄别出的产品缺陷修复）

- 现象：全量 E2E 第三轮 `m50-blank`（单助手直聊）失败——发送后 30s 助手产出未出现，会话停在「1 条消息」（仅用户消息）、成员卡战绩「未出手」；手动刷新会话后才恢复（trace / 服务端 DB 双侧取证：Run 正常 `done` + `handed_to_user=1`，产出消息已落库）；
- 根因链：mock 单助手整轮仅约 600ms（瞬间产出 + 收尾即出栈）；前端 `send` 在消息 POST 响应返回后才 `attach(runId)` 订阅运行流——高负载下 POST 往返 + 订阅首跳跑输 Run 生命周期 → 服务端已 `finishRun` 并出栈（`runs.delete`）→ `/api/runs/:id/stream` **404** → 事件链整体缺失（`run:start` … `run:end` 全未送达）→ 无 `run:end` 归约就不触发全量刷新，UI 永久停在过期快照（真实用户弱机 / 高负载下同样可复现，非测试环境专属）；
- 修复（补全既有契约）：`sse.ts` 对订阅未命中的既有约定是「交由调用方刷新会话兜底」，`run-store.attach` 的 `onEnd` 彼时只置 `active:false`、未兑现该契约——现补全为：流结束携带 **HTTP 非 ok（404 订阅晚到）** 且**未见过 `run:end` 事件**（attach 内闭包标记 `sawEnd`）且**非主动取消**时，走与 `run:end` 同一口径的本地收尾（全量刷新 + 运行态清理），最终一致回到刷新后的真实状态；
- 兜底边界（仅 HTTP 非 ok）：「200 流异常自然结束但无 `run:end`」保持旧行为——真实链路 `run:end` 必达；且 client vitest 镜像面普遍以「200 + 非 SSE 体」充当流端点（首版过宽兜底即在此误触发全量刷新，mock 侧 `messages` 缺省致链式 Unhandled Rejection），`sse.ts` 的 `onEnd` 签名扩为携带 `httpStatus`、判定据此收窄，404 场景行为不变；
- 重构：`run:end` 归约体抽为 `endRunLocally(sessionId, reason?)` 供事件路径与兜底路径共用（幂等）；兜底路径无真实结束原因——不写 `lastEndReason`（不伪造），`stopped` / `turn-limit` 提示仍只由事件路径给出；
- 主动取消不兜底（切换会话 / `detach` / 新 `attach` 先行中止旧流）：`attach` 改持**局部 controller 引用**判断本流是否被主动中止（模块级 `controller` 会被后继 attach 覆盖，闭包读不到真实状态）；
- 单测：`run-events.test.ts` 新增 4 例——404 兜底刷新且不伪造结束原因 / 正常收尾仅事件路径刷新一次、兜底不追加 / 「200 流无 `run:end` 自然结束」不兜底（锁定新边界）/ 主动取消不触发兜底。

### 70.6 门禁

- check:agents 29 场景 / 114 角色 / 26 预设（零资产变更）；check:skills 51；server 77 文件 / 1060 测试、client 56 文件 / 677 测试全绿（本批新增：`run-events.test.ts` 回合号回填 + 订阅兜底 5 例 / `m52-stage.test.tsx` SideFeed 投影 4 例；另核对修订 §69 对 `m52-stage.test.tsx` 终值的 +4 计账误差——实测 M52-D 前 35 例、现 39 例，以本轮实测为准）；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过（主包 gzip 332.61 kB，较 §69 收尾 332.31 kB +0.30 kB = SideFeed + 订阅兜底 + 回合号回填净增）；eval 28/28 零回归（零资产变更，沿用基线）；
- 全量 E2E 六轮账目（收口链）：第 1 轮 2 例失败（m16-serial 关闭串行 / reload）→ 加固三例脆性断言（收束后滚顶）→ 第 2 轮 2 例失败（m16-members / m16-serial 默认串行）→ 邀请链路移出收束窗口 + 同口径加固（单跑 9/9 全绿）→ 第 3 轮 67/68（m50-blank——**产品缺陷**甄别 → §70.5 修复；单测补后 12/12 + 单跑 6/6）→ 第 4 轮 67/68（reload——**固有竞态**甄别 → mock 节奏 20→30ms 调参；单跑复验 9/9）→ 第 5 轮 **68/68 全绿**（7.3m）→ 兜底条件收窄（vitest 镜像面误触发修正，client 全量回归 677 全绿）后端到端复验：第 6 轮 **68/68 全绿**（7.5m；m50-blank 6.0s / reload 8.7s / m16 全 4 例 / m52-stage 22 例含 M52-D 侧栏断言）；
- 文档：本页 §70、ADR 0114、`docs/adr/README.md` 索引、`agents/CHANGELOG.md` v42；下一批：M42→roundtable（已完成，见 §71）/ M43→arena 合流增强（已完成，见 §72；§7.2 目标形态全量兑现）。

## 71. 圆桌会议范式——会议容器族 · 议题进度容器化 · 派活确认制（M42）

M37–M45 专项（[docs/scene-chat-design.md §10](docs/scene-chat-design.md)）的第三类「高阶交互范式」首批：把「会议」实现为 **roundtable 形态（M52-A，ADR 0112）+ 协议容器族**——会议声明卡（RT-1）/ 席位环（RT-2，形态承担）/ 议题进度容器化（RT-3）/ 纪要卡（RT-4）/ 散会胶囊（RT-5），决策见 ADR 0115；并修复引擎侧「纪要待办 @ 被当作转交」的波次外扩缺陷（ADR 0116）。协议更新（strategy / brainstorm）与 mock 例会链路（eval 13）同批落地；编号让位：原规划 §57 / ADR 0073–0074 → 实际 **§71 / ADR 0115–0116**（见 §10 落位注记）。

### 71.1 范式定位与容器族（RT-1 / RT-4）

- 启用口径：容器自描述（不引入会话级开关）——`::: meeting [标题]`（议题 `- [x] / - [>] / - 项` 三态）与 `::: minutes [标题]`（`- 键 | 值`，键 ∈ 决议 / 待办 / 风险，未识别键归决议栏）可被任意场景输出；议题进度容器化仅 roundtable 形态生效；
- remark-ext：`mdMeeting` / `mdMinutes` builder（条目转 `data-items` JSON，与 `lib/meeting` 纯函数同构解析）；React 侧 `MeetingCard`（标题 + 计数 + 三态行）/ `MinutesCard`（三栏 + 待办派活行）；
- fail-safe：未闭合容器无卡片壳（按普通段落渲染）、解析失败 / 空条目 → raw 静态兜底（`md-meeting-static` / `md-minutes-static`），其余内容照常；`::: meeting2` / `minutes2` 不误判（名严格匹配）；
- 样式：`client/src/index.css` md-meeting / md-minutes 卡族（三态行 / 派活行 / 首字回退）。

### 71.2 议题进度容器化（RT-3）

- `client/src/lib/meeting.ts` 纯函数族：`parseMeetingItems` / `meetingItemsOfLines` / `mergeMeetingItems`（后声明显式态覆盖、todo 不覆盖、新标签按首见追加）/ `effectiveState`（容器显式态优先、todo 时本地勾选兜底）/ `meetingProgress`（doneCount / currentIndex；running 时首未决点亮 doing）/ `meetingLabelHead` / `splitMinutesOwner`；
- 本地勾选 store：`sessionStorage ma:meeting:<sessionId>`（损坏 fail-safe 回空；`useMeetingChecks` 订阅跨组件即时同步——会议卡计数与议题进度条同源）；
- `RoundtableStage`：会话内全部 meeting 容器按标签合并驱动议程条；`AgendaTrack` heading「议题 x/n · 当前：XXX」/「议题 n/n · 已全部议决」；点击议题定位议题头词首条成员发言（无则回退会议声明消息）；无容器回退 M52-A 波次驱动（零回归）；
- 工作区冻结口径沿用（500ms 节流 + 流式冻结）——heading 中间态在 E2E 不可观测（收束后才更新），逐项推进渲染由组件测（`m52-stage.test.tsx` RT-3 组）覆盖。

### 71.3 纪要卡与派活确认制（RT-4）

- 三栏分组（未识别键归决议、空栏占位「—」）；待办行 `@负责人 事项` → 出勤成员头像（AgentAvatar）/ 非出勤首字回退；整行可点 → `composerInsert('@负责人 ')`（ADR 0064：只写草稿不直发）；流式期间派活行禁用（防与插话歧义）。

### 71.4 散会胶囊（RT-5）

- `AdjournPill`（ChatArea 挂载）：运行未活跃 && 末条非 system 消息含 `::: minutes` → 「散会 · 会议已收尾」静态事件条（无点击）；尾条指纹（id~role~status）隔离订阅，流式 delta 零额外重渲染。

### 71.5 引擎语义：纪要容器 @ 不参与转交解析（ADR 0116）

- 缺陷：`parseMentions` 任意位置 `@成员名` 即召唤 → minutes 待办行 `- 待办 | @负责人 事项` 被当转交，owner 重新入队、波次外扩（brainstorm 例会实测 5 → 8 波；eval `turns_lte 5` 失败）；
- 修复：`stripMinutesBlocks(raw)`（与 remark-ext 容器正则同源：`^:::(?!:)\s*([a-zA-Z][\w-]*)\s*(.*)$` / `^:::\s*$`；栈式深度匹配；未闭合 fail-safe 不剥离）——`parseMentions` 先剥离再解析成员提及与交还判定，返回 `text` 仍为原文（渲染 / 存档零感知）；
- 协议同步：待办 @ 是派活锚点、不构成转交；收尾发言另行**单独一行**交还（协议与解析层双保险）。

### 71.6 协议与 mock 链路（eval 13）

- 协议：`agents/strategy/_protocol.md` 条款 8 / 9（例会纪律：chief 开场声明 `::: meeting`、逐项逐字回标 `- [x] <议题原文>`、末位回交主持人、收尾 `::: minutes` 三栏 + 待办 @ 派活锚点 + 单独行交还）；`agents/brainstorm/_protocol.md` 新增「圆桌例会纪律」8 / 9 / 10；两侧交付段补「两会卡是消息内呈现，纪要卡不代替落盘」；
- mock：`MEETING_TRIGGER='例会'` + 主持人在场（`MEETING_HOSTS`：chief 优先，其次 facilitator）→ 开场声明（`::: meeting` 四议题）→ 成员逐项回标（`- [x]` 容器更新）→ 全体议毕回交主持人（「@主持人 议题都过完了，请主持收尾并出纪要」）→ 主持人收尾（minutes 三栏 + 自议题回标 + `@用户` 交还）；首 / 收尾判定走请求历史扫描去重（不依赖 spokenTimes）；
- eval：`opc-weekly-review`（13）——5 回合（turns_lte 5 临界）/ 交还用户 / 无循环。

### 71.7 测试

- server：`parser.test.ts` +4（minutes 容器剥离 / 未闭合 fail-safe / 块外 @ 照常 / 块内 @用户 不算交还）；`m42-meeting.test.ts` +3 新建（OPC 5 波链路 / brainstorm 5 波链路 / 非例会回归）；
- client：`m42-meeting.test.tsx` 新建 21（lib 纯函数 / 勾选 store / 会议卡 / 纪要卡 / 散会胶囊）；`m52-stage.test.tsx` +3（RT-3 容器合并推进 / 点击定位 / 本地勾选兜底）；`markdown-ext.test.tsx` +2（未闭合无卡片壳 / 名严格匹配）；
- E2E：`m42-roundtable.spec.ts` 新建 1（头脑风暴圆桌：会议卡 → 席位环 → 4/4 议决 → 纪要三栏派活 → 散会胶囊 → 滚顶本地勾选兜底；`playwright.config.ts` main 项目 testMatch 补 `m42-.*`）。

### 71.8 门禁

- check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 78 文件 / 1067 测试、client 57 文件 / 703 测试全绿（本批新增：parser 4 例 / `m42-meeting.test.ts` 3 例 / `m42-meeting.test.tsx` 21 例 / `m52-stage.test.tsx` +3 / `markdown-ext.test.tsx` +2）；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过（主包 gzip 335.05 kB，较 §70 收尾 332.61 kB +2.44 kB = 会议卡族 + 进度容器化 + 散会胶囊净增）；eval 28/28（含新增例外的 `opc-weekly-review` 临界 5 回合）；全量 E2E **69/69 全绿**（7.7m；新增 `m42-roundtable.spec.ts` 13.8s；`m52-stage` 22 例回归全绿）；
- 文档：本页 §71、ADR 0115 / 0116、`docs/adr/README.md` 索引、`docs/scene-chat-design.md §10` 落位注记、`agents/CHANGELOG.md` v43；下一批：M43→arena 合流增强（已完成，见本页 §72；v52 登记）。

## 72. 多方 PK 范式——对决组 · 配对卡 · 判定卡与 arena 合流（M43）

M37–M45 专项（[docs/scene-chat-design.md §11](docs/scene-chat-design.md)）的第四批「高阶交互范式」：把「对抗」实现为 **arena 形态（M52-A，ADR 0112）+ 协议容器族**——对决组（PK-1）/ 缺陷-修补配对卡（PK-2）/ 评审判定卡（PK-3）/ 裁决卡（PK-4）/ 计分板（PK-5），决策见 ADR 0117–0119；四容器（`::: claim` / `::: findings` / `::: offer` / `::: debate`）+ 五形态件 + arena 中轴合流（回合轴 + 裁决流 + 论断树 / 报价流面板）全量兑现 [docs/scene-expansion-design.md §7.2](docs/scene-expansion-design.md) 目标形态；协议更新（debate / negotiation / brainstorm）与 mock 剧本（含 `writePlanCall` 评审步骤）同批落地；编号让位：原规划 §58 / ADR 0075–0077 → 实际 **§72 / ADR 0117–0119**（见 §11 落位注记）。与 M34 金融博弈（计算结论）的边界照 §11.4。

### 72.1 触发口径与容器族（PK-1 / PK-2）

- 显式结构化触发（ADR 0117）：三入口——评审范式 ReviewRecord（PK-3）/ 容器 `::: debate <题面>`（对决显式声明）/ 结构化容器 claim · findings · offer；不做 mentions 交替启发式（误判错乱成本 ≫ 漏判）；
- remark-ext 四 builder（`mdClaim` / `mdFindings` / `mdOffer` / `mdDebate`）：条目统一转 `data-items` JSON（`finalizeClaim` / `finalizeFindings` / `finalizeFieldsAndItems`）；`data-title` = 参数整串（题面 / 标题 / 主题）；
- React 四卡（`client/src/components/chat/md-ext/`）：`ClaimCard`（主张 + 细节 + 论据树 + 「N 论据」计数；点论据 → composerInsert「请补充论据「X」的证据与出处」）/ `FindingsCard`（缺陷行三列：编号 / 描述 / 修补方向）/ `OfferCard`（字段行 + 条目行；`is-price` 高亮报价行）/ `DebateCard`（题面 + 双方立场）；
- fail-safe：未闭合容器无卡片壳（普通段落）；解析失败 / 空条目 → raw 静态兜底（`md-*-static`）；名严格匹配（`claim2` 不误判）；
- 样式：`client/src/index.css` md-claim / md-findings / md-offer / md-debate 卡族与 duel 二栏 / 计分板 / 判定卡（rvc）族。

### 72.2 缺陷-修补配对与「已响应」推导（PK-2）

- `client/src/lib/pk.ts` 纯函数族：`parseFindingsItems` / `findingsOfLines`（容器行轻量解析）/ `findingMentions`（正文「缺陷 N」编号扫描；排除 `- 缺陷 N |` 定义行）/ `respondedSig`（消息 id → 其后同会话消息的提及编号集合签名；结构化 `MessageLookup` 入参不跨层依赖 store，组件以 selector 订阅，跨消息即时点亮）/ `findingIdsOfSig`；
- 渲染口径：findings 行命中 → `data-responded` + 「已响应」徽章；头部计数「N/M 已响应」（M = 条目数，N = 被后续消息提及的编号数）；尾条 / 无场景 ctx 不标（未完结不判）；
- 配对不落库、不走服务端接口（数据已在前端消息流，ADR 0112 / 0117 同口径）。

### 72.3 对决布局 · 计分板与裁决卡（PK-1 / PK-4 / PK-5）

- WaveGroup duel 变体（ADR 0118）：`duel = duelSides(...) !== undefined && agentIds.length >= 2`——单行内二栏（left / right 各自纵向堆叠成员），center 席（judge / evidence）渲染于二栏之后；不成立 / 窄屏 → 普通并行组（零回归）；
- `duelSides` 分侧：席位优先（`stage.seats.left/right`）→ 中轴席声明（`seats.center`，如辩论场 judge / evidence）→ 姿态兜底（`DUEL_STANCE`：affirmative / ideator = left，negative / challenger = right）→ 其余计「无站位」；**全员各就各位（不存在无站位成员）且两侧均非空才成立**（混合波——如头脑风暴全员同波——降级普通并行组，经验账目见 §72.7 修复项）；
- 组头：阶段徽章（`duelPhaseOf`：波序 0 立论 / 1 反驳 / ≥2 修补）+ `DuelMeter` 计分条（`duelTally`：两侧发言数 / 被响应数，「vs」中轴）；
- 裁决卡（PK-4，ADR 0119）：仅最新波（`isLatestWave`）且非运行中 → `DuelVerdictActions` 四按钮（采纳「正」/ 采纳「反」/ 两案并保留 / 再来一轮）；点击 → `verdictTemplates(left, right)` 模板 composerInsert（只写草稿不直发；「再来一轮」含 `@双方`）；运行中禁用（title「运行中不可裁决：等待本波完成」）。

### 72.4 评审判定卡（PK-3）

- 触发：`message.mode === 'review' && runId && agentId` → `usePlanStore.reviews` 命中（runId + agentId 匹配）→ `ReviewVerdictCard`（+ 头部 `ReviewVerdictBadge` 替代常规「评审」徽章）；未命中回退常规徽章（零回归）；
- 呈现：verdict 徽章（pass / conditional / fail，`VERDICT_META` 与任务面板同源）+ target 引用（`formatReviewTarget`：plan → 「计划 pl_x」/ artifact → 「交付件 path」/ step / message 同构）+ findings 列表 + 证据计数；fail 附「关联步骤 / 计划已阻塞，修复后可复审」状态联动说明。

### 72.5 arena 中轴合流——裁决流 · 论断树 · 报价流（ArenaStage）

- 裁决流 `[data-verdict-flow]`：会话内 `::: verdict` 容器消息按时间投影为 chips（`duelVerdictLabel` 标题兜底）；点头像 / chip → `ctx.focus(messageId)` 定位原消息；
- 论断树 `[data-insight="claims"]`：`claimNodesOfContent` 投影全部 `::: claim` 消息 → `ClaimTree` 分层（主张 → 细节 → 论据 + 「N 论据」+ 证据行）；点论据 → composerInsert 补证模板；
- 报价流 `[data-insight="offers"]`：`offersOfContent(content, messageId)` 按消息实例化 + `offerAmount` / `formatOfferAmount` 数值化 + 相邻对比 delta（`is-down` / `is-up`）；条目 → `ctx.focus(messageId)`；
- 回合轴 / 席位发言流等既有形态件（M52-A / M52-D）照常且接收容器数据增强。

### 72.6 协议与 mock 剧本

- 协议：`agents/debate/_protocol.md` 条款 13（`::: claim` 主张展开 / `::: findings` 缺陷修补方向（编号稳定、回应复用「缺陷 N」点亮配对）/ `::: verdict` 终局裁决容器；容器内不写 @）；`agents/negotiation/_protocol.md` 条款 11（`::: offer` 报价容器字段行 + 报价流按数值自动对比让步幅度 + `::: verdict` 复盘）；`agents/brainstorm/_protocol.md` 条款 11（challenger `::: findings` + ideator / refiner 复用编号响应 + 收敛 `::: claim`）；
- mock：affirmative `::: claim`（三条论据挂证据与置信度）/ negative `::: findings`（三缺陷 + 修补方向）/ negotiator · counterpart `::: offer`（98 万 ↔ 68 万）/ judge `::: verdict 正方 辩论裁决（3 轮制）` / tactician `::: verdict 未成交 谈判复盘（ZOPA 68–82 万）`；evidence 剧本按「缺陷 1/2/3」逐条回补（配对全量点亮 + 「3/3 已响应」）；
- `writePlanCall` 评审步骤：用户点名「评审」→ 三步计划（产出 → 评审 `mode='review'`、owner 优先 qa 且排除执行者与规划者 → 汇总）+ `reviewSignal` 分支（submit_review verdict pass + 步骤 done）——E2E 评审链路（m24 判定卡）与既有 M24 链路同构。

### 72.7 测试

- client 单测：`m43-pk.test.ts` 新建 16（findings 解析 / 提及扫描 / 已响应签名 / duelSides（席位优先 / 姿态兜底 / 单侧降级）/ duelPhaseOf / duelTally / verdictTemplates / claim · offer 解析与数值化）；
- client 组件测：`m43-cards.test.tsx` 新建 19（四卡路由与交互 / 已响应徽章与计数 / 判定卡三态与 `formatReviewTarget` / WaveGroup duel 全量（二栏 / 阶段 / 计分 meter / 四键回填 / 窄屏回退 / 非最新波零裁决卡 / streaming 禁用）/ ArenaStage 合流（裁决流 focus / 论断树回填 / 报价流 delta））；
- E2E：`m43-pk.spec.ts` 新建 2（辩论场：`@立言 @砺锋` 首波并行走 duel（二栏 / 阶段徽章 / 计分板 / claim · findings 卡）；`@昭实` 回补 → 「3/3 已响应」；`@明断` 裁决 → 裁决流 chip `data-status=long`。谈判桌：`@谭成 @祁弈` 报价卡 + 报价流 98 万 → 68 万 delta「↓30 万」）；`m24-plan.spec.ts` +1（规划带「评审」→ 批准执行 → PK-3 判定卡 `data-verdict=pass` + 目标引用「计划 pl_」+ 任务面板 3/3；断言前分档滚扫定位被虚拟剪枝的评审回合）；
- 修复（实施期）：① `remark-ext.ts` finalize 补 `mdDebate` 分支（曾遗漏 → DebateCard 无 `data-items`，组件测甄别）；② `duelSides` 收窄「无站位成员不成对决」——姿态兜底曾将头脑风暴全员同波（facilitator / ideator / challenger / refiner）误判为对决（二栏拆散并行圆桌，`m16-brainstorm` 全量 E2E 甄别出回归）；修复后 `m16-brainstorm` / `m43-pk` / `m52-stage` 三组 E2E 25/25 全绿，单测断言同步更新（混合波降级 + 中轴席显式声明）。

### 72.8 门禁

- check:agents 29 场景 / 114 角色 / 26 预设（协议更新三份：debate 条款 13 / negotiation 条款 11 / brainstorm 条款 11）；check:skills 51；server 81 文件 / 1088 测试全绿（本批零净增——mock 剧本走既有流转断言面；窗口内含并发批次增量）；client 63 文件 / 830 测试全绿（本批新增 2 文件 35 例：`m43-pk.test.ts` 16 + `m43-cards.test.tsx` 19；窗口内含并发批次 M52-G/H、M58 增量）；全仓 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过（主包 `index-D_-8akSI.js` 1,233.68 kB / gzip 350.45 kB；含并发批次合流，点记录）；eval 28/28 零回归（mock；协议变更走既有断言面）；
- E2E 全量多轮账目：首轮 71/72——`m16-brainstorm` 甄别出 `duelSides` 姿态兜底误判（头脑风暴全员同波被拆成对决二栏），收窄为「全员各就各位且两侧均非空才成立」后定向复跑 `m16-brainstorm` / `m43-pk` / `m52-stage` = 25/25 全绿；第二 / 三轮 70/72——失败项复跑 4/4、6/6 全过（并发环境 flaky 甄别）；第五轮 70/76——2 例 ERR_CONNECTION_REFUSED（并发会话重启服务器）+ 1 例 trace ENOENT（录制噪声，v45 先例）+ 2 例 `m54-pan-interactive`（并发批次在制品），4 条 flaky 定点复跑全绿；
- 隔离复跑（并发窗口，独立端口 8791 / 独立 DATA_DIR）：22 例 20 过——`m43-pk` 辩论用例 2/2 失败（两次 repeat 同点），根因甄别为**批次外运行收束竞态**：隔离环境低负载下 `@昭实` 发送落在上一 run 收束后 0.6s（标准环境 +3.0s），`expectYourTurn` 的 `.first()` 被上一波残留胶囊提前满足 → 第三次发送时本 run 仍在运行 → 触发 Composer「切会话恢复草稿」效应（fill 值被清空 / 替换为残值）→ 发送钮持续 disabled（快照 `button [disabled]`；截图 value 空与残值两态 `data/m43gate-isolated-fail-repeat1.png` / `repeat2.png`）；后端证据：两会话 runs 全 `done + handed_to_user=1`、第三条用户消息缺失；**M43 未触碰 Composer / run-store**，同一用例标准环境第 2/3/5 轮全量与修复后定向 25/25 全过；加固（等待波完成态 + 余量）评估未实施——与 M52-D「放宽运行收束竞态窗口」既有口径一致，留待复现时再评估；
- 标准环境收口复跑（并发窗口关闭后）：`m43-pk` 2 例 + 第五轮 4 条 flaky 所在 spec（artifact-diff / artifact-preview / interject / right-panel）= **8/8 全绿**（1.5m）；
- 文档：本页 §72、ADR 0117–0119、`docs/adr/README.md` 索引、`docs/scene-chat-design.md §11` 落位注记、`docs/scene-expansion-design.md` §7.2 / §7.9 注记、`agents/CHANGELOG.md` v52。

## 73. 裁决状态容错与局势面板局面头——自然语言前缀 · 置信度加权 · 元条目剔除（M52-E）

用户实测反馈（截图）：投资研究（dock·versus）多空对弈会话出现「面板上方多方 0 / 空方 0 / 暂无信号，下方裁决卡完整」的割裂——根因是裁决容器首参数的**自然语言首词**（真实模型输出 `::: verdict 空方领先`，会话存档实锤）未命中精确状态词表（多方 / 空方 / 僵持）→ 派生层判 none → 全部条目被丢弃；同期补齐局势面板的「胜负 / 置信度」一等公民表达（§7.4 / §7.6 信息架构补齐）。**纯前端批次**（零服务端 / 零资产 / 零容器协议改动），决策见 ADR 0121。

### 73.1 裁决状态容错（lib/verdict 单一事实来源）

- 新建 `client/src/lib/verdict.ts` 纯函数面：`matchVerdictStatus`（状态词**精确或前缀**命中——「空方领先」「多方占优」→ 对应状态；正反方同构）/ `parseVerdictArg`（参数 → status + title：命中后标题取剩余部分；无剩余且首词非标准词 → 保留原文为标题）/ `verdictStatusFromItems`（首词未命中 → 条目「胜负」行 value 前缀兜底）/ `verdictConfidenceOf`（置信度条目解析，§73.2）；
- 镜像面接入同口径：`scene/derive.ts` 的 `verdictsOf`（前缀 + 胜负条目兜底；`SceneVerdictStatus` 改为 re-export）与 `md-ext/remark-ext.ts` 的 verdict builder（前缀；本地 `VERDICT_STATUS_MAP` / `VerdictStatus` 移除）——消息渲染与工作区派生两侧状态分类共用同一函数，不漂移；
- 未命中且无兜底 → 仍降级无状态标题卡（原行为零回归；既有「未知首词降级」用例不动）；自动受益面：ArenaStage 裁决流 chip / WaveGroup 对决徽章（`duelVerdictLabel`，status 消费方）。

### 73.2 置信度解析（幅度与展示分离）

- `verdictConfidenceOf(items)`：显式百分比（`/(\d{1,3})\s*%/`，1–100）直取 → `{ pct, label: '60%' }`；无百分比时定性词映射（**先低后高再中**：「中高」含高 → 80、「中低」含低 → 30）→ `{ pct: 80|60|30, label: 原词头部 }`（「中（60%）」场景显式百分比优先）；无法解析 → undefined；
- 定性映射**仅驱动局势条幅度，展示保留原词**（不伪造精度——「中」不显示为「60%」）。

### 73.3 局势面板信息架构（VersusPanel）

- 局面头 `.scene-vs-head`（新增）：最新裁决的胜负上移为面板头部（多方领先 / 空方领先 / 僵持；`scene-vs-head-long|short` 色板同 md-verdict 族 红 / 绿 / 灰）+ 置信度 chip（`.scene-vs-conf`「置信度 60%」/「置信度 中」；无置信度条目则省略；status none → 裁决标题兜底）；
- 局势条改「方向 × 置信度」加权（§7.6 置信度聚合口径落地）：最新裁决 status ≠ none 时 `momentum = dir × confidence.pct`（无置信度条目 → 满偏兜底——此前条目数差口径多数场景全偏 ±100，无区分度）；无有效裁决时保持条目数差基准（原行为）；
- 信号列剔除元信息条目（`/^(胜负|置信度|声明)/` 前缀——面板头 / 裁决卡 / 信号列不再三处重复）；裁决卡（VerdictPart）仍全量展示条目。

### 73.4 测试

- vitest：`m52-stage.test.tsx` +2（verdictsOf 自然语言前缀「空方领先」→ short + 条目「胜负」兜底；versus 面板局面头 + 元条目剔除 + 加权局势条右幅 30%）；`markdown-ext.test.tsx` +1（消息渲染面「空方领先」→ md-verdict-short + 徽章「空方」+ 标题保留原文）；既有断言零改动（精确词路径 / 未知词降级不变）；
- E2E：`m34-invest.spec.ts` 对弈用例 +2 断言（`.scene-vs-headline` = 多方领先；`.scene-vs-conf` = 置信度 中——mock 裁决 `::: verdict 多方 多空对弈裁决` + `- 置信度 | 中` 驱动）。

### 73.5 门禁

- check:agents 29 场景 / 114 角色 / 26 预设（零资产变更）；check:skills 51；client 60 文件 / 767 测试全绿（本批新增 3 例）；client typecheck 0 错误；ESLint 0 错误（本批引入的 1 条 warning 修复后）；build 通过（主包 gzip 346.50 kB；较 §71（v43）收尾 335.05 kB +11.45 kB——含中间批次增量，本批为 verdict 容错面 + 局面头 + 置信度映射净增）；eval 28/28 零回归（零资产变更，与基线零对比）；
- E2E：`m34-invest` 3 例 + `m52-stage` 22 例 = **25/25 全绿**（1.9m；含对弈用例新局面头断言与 invest versus 空态回归）；账目注记——首轮复跑曾 2 例失败（对弈局面头 not found / 投研快评 artifacts ENOENT），甄别为**残留旧 server（复用旧 dist）与并发 test-results 写入**的环境噪声，清场后干净复跑全绿；
- 文档：本页 §73、ADR 0121、`docs/adr/README.md` 索引、`agents/CHANGELOG.md` v44。

## 74. 裁决条目多空侧归因——翻盘条件归败方 · 阵营词归各方 · 方向兜底（M52-F）

用户实测追问「多方无数据？」：多空对弈会话（真实裁决 `::: verdict 空方领先`）局势面板空方列有数据、多方列恒「暂无信号」——根因是信号列归因「按裁决方向**整列倾泻**」（裁决 short 时全部非元条目进空方列；多方列仅「多方胜裁决」才有数据），而条目本身有方向（「翻盘条件」= 败方翻盘路径——真实会话该条目内容全为多方条件，mock 对称：多方领先裁决的翻盘条件为空方条件）。**纯前端批次**（零服务端 / 零资产 / 零协议改动），决策见 ADR 0122。

### 74.1 条目多空侧归因（lib/verdict 扩展）

- `verdictItemSide(label, status)` → `long | short | draw | meta`：元信息（`胜负 / 置信度 / 声明` 前缀）→ meta（ADR 0121 口径延续）；显式阵营词（多方 / 多头 / 正方 / 看多 ↔ long；空方 / 空头 / 反方 / 看空 ↔ short）**优先**；「翻盘条件」（含「翻盘」）→ 败方（空方领先归多方、多方领先归空方、僵持归中立区、none 归 meta）；其余条目 → 裁决方向侧；none → meta（不进信号列，裁决卡全量兜底）；`META_LABEL_RE` 由面板迁入本模块（单一事实来源）；
- 可辩护性锚点：真实会话空方领先裁决——核心依据（支持空方）→ 空方列；翻盘条件（周线站上 1355 / 站上 1292 / 底背离 / 公告利好，均为**多方**条件）→ 多方列；空方失效条件（条目名冠名）→ 空方列。

### 74.2 面板逐条分列（VersusPanel）

- `buildModel` 信号列构造由「按裁决方向整列倾泻」改为**逐条归因分侧**（`signalRowsOf` 移除）；跨轮累计口径不变（每轮裁决按各自方向归因）；列计数（cap-count）为条目数、局势条仍「方向 × 置信度」加权（ADR 0121 不变）；
- 效果：两列不再恒空——真实数据下多方 1 条（翻盘条件）/ 空方 2 条（核心依据 + 空方失效条件）；mock 数据下多方 1 条（核心依据）/ 空方 1 条（翻盘条件）；空态文案「暂无信号」仅在**该侧确无条目**时出现。

### 74.3 测试

- vitest：`m52-stage.test.tsx` 更新 M52-E 用例（整列断言 → 逐条分侧断言：空方 1 条 = 核心依据、多方 1 条 = 翻盘条件、无空态）+ 新增 2 例（阵营词「空方失效条件 / 多方失效条件」与「翻盘条件」各归各位；多方领先 → 翻盘条件归空方，mock 同构）；既有「verdict 容器 → 多空列与裁决卡」用例断言零改动（无方向条目仍归裁决方向侧）；
- E2E：`m34-invest.spec.ts` 对弈用例 +2 断言（`.scene-vs-long` / `.scene-vs-short` 各 1 条信号——mock 裁决核心依据归多方、翻盘条件归空方）。

### 74.4 门禁

- check:agents 29 场景 / 114 角色 / 26 预设（零资产变更）；check:skills 51；client 61 文件 / 785 测试全绿（本批更新 1 例 + 新增 2 例；窗口内含并发批次增量）；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过（server tsup；主包 gzip 349.35 kB——并发窗口含 M54 增量，经临时 outDir 验证后清理）；eval 28/28 零回归（零资产变更，与基线零对比）；server 81 文件 / 1088 测试全绿（含并发批次增量，窗口点记录）；
- E2E：`m34-invest` 3 例 + `m52-stage` 22 例 = **25/25 全绿**（56.2s；含对弈用例逐条分侧断言）；账目注记——首轮 1 例失败为 close 阶段 trace ENOENT（并发 test-results 争用：断言全过、截图实锤交付件齐全），窗口内有并发多轮 run 无法独占，遂以临时隔离配置（独立端口 / data / workspace / outputDir）复跑全绿，跑毕清理临时配置与构建产物；
- 文档：本页 §74、ADR 0122、`docs/adr/README.md` 索引、`agents/CHANGELOG.md` v46。

## 76. 媒体生成迁入设置——全局连接 · IA 收口（M56）

用户实测反馈（截图）：连接管理的「新建连接」出现媒体生成类型（ComfyUI / SD WebUI / OpenAI 兼容 / 任务模板）不合理——「这些应该放在设置里面，而不是连接管理」。根因：M31 起媒体连接沿用**会话绑定**语义（「连接管理建 → 会话绑定 → 才能生成」三跳），与「连接管理 = 按会话授予外部系统凭据」的心智（ADR 0042）冲突；媒体生成本质是**全局能力配置**——对齐 M25 embedding 先例（全局共享 / 不参与会话绑定 / 设置中启用）即可收口。**服务端 / 前端混合批次**（零 agents 资产变更），决策见 ADR 0124。

### 76.1 服务端：媒体连接全局化（去会话绑定）

- `MediaService.providersOf()` 无参——启用中的媒体连接清单（能力 / 模型 / 工作流模板）由全局 `connections.list()` 派生，生成面板与工具共用；`resolveConnection(connectionId?, capability)` 在全局启用连接中解析（缺省取首个启用连接）——未配置引导「尚未配置媒体生成连接：请到「设置 → 媒体生成」创建并启用连接」，指定 id 不可用「指定的媒体连接不存在或未启用」；
- `GET /media/providers` 不再接受 `sessionId`；`GET /sessions/:id/canvas` 的 `mediaBound` 改为全局语义（全局存在启用中的媒体连接），生成面板引导用；
- 绑定守卫：`POST /sessions/:id/connections` 对 media 返回 `400`（「媒体连接不参与会话绑定（在「设置 → 媒体生成」中配置启用）」——与 embedding 守卫同构相邻）；
- Agent 工具（media_generate / media_video）未配置引导文案同步指向「设置 → 媒体生成」。

### 76.2 客户端：设置页新增「媒体生成」分组（表单 / 清单迁入）

- 新建 `settings/MediaConnectionsSection`：连接清单（卡片 = 提供方徽章 / 状态点 / baseUrl · 首模型 · 能力数 / 启用开关 / 测试 / 编辑 / 删除）+ 新建与编辑表单（字段与校验自连接管理原样迁入）+ 保存并测试；设置页分组 +1（共 9 组）；
- 文案：计数「已配置 N 个连接 · 启用即全场景可用（无需会话绑定）」；空态「还没有媒体生成连接。创建并启用后，画布「媒体生成」面板与 Agent 工具（media_generate / media_video）即可用」；启用开关 toast「已启用（画布生成面板与 Agent 工具可用）」/「已停用（生成入口暂不可用）」，分组 hint「生成能力供应商（ComfyUI / SD WebUI / OpenAI 兼容 / 任务模板）；启用即全场景可用，无需会话绑定」；
- 「直达编辑」消费随表单迁移（`pendingEditId` 就绪后打开编辑表单；目标缺失 / 非媒体丢弃不悬挂）。

### 76.3 客户端：连接管理收口 + 生成面板引导改「去设置」

- `ConnectionsConsole`：媒体连接从清单过滤（计数与卡片只呈现非媒体；`KIND_META` 保留 media 映射 `hint: '已迁至设置'` 以维持 `ConnectionKind` 完整）、新建类型 chips 移除媒体、绑定按钮对 media 不出现；`pendingEditId` 消费整体移除（唯一生产者生成面板已改跳设置）；
- `GenerationPanel`：空态引导「还没有可用的媒体生成连接。到「设置 → 媒体生成」创建并启用（ComfyUI / SD WebUI / OpenAI 兼容 / 任务模板）后即可在画布直接生成」+「去设置」按钮（`requestSettingsFocus('media')` + `setAppView('settings')`）；铅笔「编辑当前提供方」= `requestEdit(connectionId)` + 同上二连；
- `media-store`：`/api/media/providers` 去 sessionId（刷新失败保留现有清单）；`canvas-store` / `CanvasView` 的 `mediaBound` 注释与消费改全局口径（不随会话切换）。

### 76.4 测试

- 服务端：`m31-media.test.ts`（helper `createMediaConnection` 去 bind；providersOf 全局语义重写——新启用连接无需绑定即入清单 / 停用即消失；未配置与 ghost 错误文案断言）+ `m31-tools.test.ts`（同法；未配置引导 summary / detail 断言）+ `m25-embed.test.ts` 新增 media 绑定守卫用例（`400` + 「不参与会话绑定」+「设置 → 媒体生成」）；
- 客户端：`m36-frontend.test.tsx` 分组断言 8→9（含「媒体生成」）+ 新增 3 例（直达编辑消费 / 目标缺失丢弃；连接管理媒体过滤 + 新建类型不含媒体）。

### 76.5 门禁

- check:agents 29 场景 / 114 角色 / 26 预设（零资产变更）；check:skills 51；server 81 文件 / 1088 测试、client 63 文件 / 816 测试全绿（复跑快照；本批面 = m31-media / m31-tools 改写 + m25-embed +1 例 + m36-frontend +3 例；窗口内含并发批次增量）；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过（主包 gzip 348.90 kB；窗口点记录，含并发批次增量）；eval 28/28 零回归（mock；零资产变更）；
- 注记：client 全量复跑首轮遇 `m48-frontend` / `m50-frontend` 组队台 3 例满载超时波动（并发批次 test-results 与运行争用；3 例均在未改动面——隔离复跑 10 例全绿、再复跑全套件全绿，同 §74.4 并发争用口径）；
- E2E：`m25-memory` 2/2 全绿（首轮 1 例 `browserContext.close` trace ENOENT 录制噪声（并发 test-results 争用），复跑干净）；
- 文档：本页 §76、ADR 0124、`docs/adr/README.md` 索引、`docs/api.md` §11 / §16、`agents/CHANGELOG.md` v47；历史章节修订注记：§49.3（媒体连接语义全局化）、§51.3（媒体表单与直达编辑消费点迁设置）。

## 77. 模型输出净化与落盘声明审计——仿写日志块剥离 · 协议标记泄漏清理 · 双端兜底（M55）

用户实测截图（s_a1a972a1）：聊天气泡出现 `[工具调用]` 文本块、`ziwei_pan({...})` 原始 JSON 参数与「紫微排盘完成」摘要；会话存档实锤该消息 tool_calls 为空、run 事件零工具调用——模型**仿写**上下文投影格式（`server/src/context/assembler.ts` 注入的 `[工具调用]\n- 名称(参数) → 摘要`）；同会话另一条消息两处声称 write_file「已写入 3.9KB」但无任何成功写调用（编造落盘声明），且泄漏全角竖线包裹的 `｜｜DSML｜｜` 协议标记。M53 已立「记录真实性」prompt 红线（§68 / ADR 0113），实测不可靠 → 本批代码级兜底：服务端落库前净化 + 落盘声明审计留痕 + 前端展示兜底（存量数据不动库）。零 agents 资产变更。

### 77.1 净化函数（shared/src/sanitize.ts）

- `sanitizeModelText(text)`：规则**宁窄勿宽 · 半截流式安全 · 幂等**——① `[工具调用]` 独立行 + 其后连续（空行 / 列表行 / 缩进续行）序列，仅当序列含 ≥1 条带箭头（→ / -> / =>）日志行时**整块删除**（无日志行 = 流式半截 → 保持原文待补齐整体命中；无标题行时单靠箭头不剥离——正常箭头列表不受影响）；② 协议标记行（整行匹配 `</?｜…DSML…`）整行删除（半截不匹配待补齐）；③ 删除造成的多余空行归一（≥3 换行压 2）+ 尾部空白去除；无命中快速短路（不含 `[工具调用]` 与全角竖线即原样返回）；
- `extractDeliveredPaths(text)`：完成态声明锚（已写入 / 已落盘 / 已生成 / 已保存 / 已创建 / 已覆盖 / 已输出；裸「落盘」须紧跟冒号且非「已落盘」）+ 60 字符窗口内文件路径（扩展名白名单）提取去重——仅供审计留痕，不改正文。

### 77.2 服务端收尾净化与审计（engine.ts）

- `sanitizeAndAudit(record, message)`（幂等）挂 6 处收尾点：executeTurn 的 parseMentions **之前**（仿写块内可能出现伪 @ 交还标记）与 catch 开头、finishTurn（波级收尾）、续写 / 重生成完成路径、异常 / 中断 catch（两处，replace_all 同构）——内存对象即净 → 落库 / FTS / 记忆沉淀 / 下一回合装配全干净（防模型看到自己脏文本形成自我强化循环）；
- 落盘声明审计：正文声明文件名 vs 成功写调用（status=ok 的 args.path / args.output）——不符 → trace `delivery:unverified` + logger.warn（留痕不阻断、不改正文）；净化命中 → trace `content:sanitized`（before/after 字符数）。

### 77.3 前端展示兜底（session-store）

- toStores（加载 / 全量刷新）与 upsertMessage 对 role=agent 净化 → 存量消息（历史回看）直接干净；消息气泡 / 画布舞台 / 侧栏发言流 / 收尾卡等全部 store 消费方一致受益；
- 流式 appendDelta：保留原始累积缓冲（rawStreams）——对「原始全文」求净化写回 content（若对已净化文本增量拼接，块内后续日志行会失去标题锚点成为孤行）；turn:start（续写 / 重生成复用消息 id）重置缓冲、回合收尾（非 streaming 补丁）释放、会话切换清空；用户消息豁免（引用系统格式属正常输入）。

### 77.4 测试与门禁

- `server/tests/m55-sanitize.test.ts` 9 例（真实样本：ziwei 编造调用记录 / bazi 协议标记泄漏；含半截保持、幂等、零拷贝、声明提取）+ `client/tests/m55-sanitize.test.ts` 5 例（跨分片块剥离与孤行回归 / 协议标记补齐 / 用户豁免 / 存量 upsert / 重生成缓冲重置）；
- 回归：eval 28/28 ✅；server 81 文件 / 1087 测试、client 62 文件 / 790 测试全绿；全仓 typecheck 0 错误；改动文件 ESLint 0 错误；client build 通过；E2E 全量 71/76（本批主链路 relay / reload / interject 等全绿；stop 隔离复跑通过；失败 5 例含 m54-pan-interactive ×3 与 right-panel——两文件在运行窗口内被并发 M54 批次修改 + trace ENOENT / 浏览器会话关闭等基础设施抖动，判定非本批回归）。

- 文档：本页 §77、ADR 0125、`docs/adr/README.md` 索引、`agents/CHANGELOG.md` v45。

## 78. 成员展示去重——标题栏头像组移除 · 输入条成员条席位让位（M52-G）

用户实测截图（谈判 arena 场景）红框标注两处成员表达并追问「是不是重复了，且输入框中的有必要展示吗」：① ChatArea 标题栏右侧头像组（`participants.slice(0, 7)` 纯装饰，无交互 / 无状态）；② 输入条上方成员条（M11 指挥台 chips：点击 @ 召唤 / 发言状态点 / 排队角标 / 新成员高亮）。叠加场景工作区体系（§66 / ADR 0112）落地后的 arena 席位卡 / roundtable 席位环（同样承载「点击 @ 召唤 + speaking/waiting 状态」），同一会话内成员被三处重复表达。**纯前端批次**（零服务端 / 零资产 / 零协议改动），决策见 ADR 0126。

> **成员条统一批修订（ADR 0135 / §86）**：本节的「输入条成员条席位让位」判定已撤销——成员条全场景统一常驻（arena 全员入席 / roundtable 不再让位，与席位同屏并存）；标题栏头像组移除维持不变。

### 78.1 展示矩阵与收口口径

- 成员展示面盘点：标题栏头像组（纯装饰）↔ 输入条成员条（交互：@ 召唤 / 状态点 / 排队角标 / 新成员高亮）↔ 场景席位（arena 席位卡 / roundtable 席位环 / 席位横条——交互 + 状态）↔ 窄屏 BottomMemberBar ↔ 右栏 TeamPanel；
- 收口口径（用户选定「席位覆盖时隐藏」）：① 标题栏头像组删除（纯装饰无信息增量，与席位 / 成员条构成三重冗余）；② 输入条成员条在「场景席位已覆盖全员」时让位隐藏（席位同构承载交互与状态）；stream / dock / 纯列表等无席位载体场景照常展示（成员入口不缺失）；③ 窄屏 BottomMemberBar 与右栏 TeamPanel 不在本次范围。

### 78.2 实现（ChatArea / Composer）

- ChatArea：删除标题栏右侧头像组（原 `participants.slice(0, 7)` 堆叠头像，无交互），注释留档；
- Composer：新增 `poolHidden` 判定（useMemo，依赖 session / agents / groups / listMode）——参与者为空（回退全部 agents 形态）不隐藏；取首个参与者所属场景组解析 `resolveStage(group?.stage, { listMode })`（与 SceneStage 渲染同源，单一事实来源）；listMode / fallback（未声明 / 非法 / arena 缺席位 / 纯列表）→ 不隐藏；roundtable（席位环恒展示全员）→ 隐藏；arena → 参与者**全部入席**（left / right / center 并集）才隐藏（有未入席成员保留，保证新成员可见可召唤）；
- 渲染条件 `{!disabled && poolSorted.length > 0 && !poolHidden && (`——@ 菜单、插入链路、状态点与排队角标逻辑零改动。

### 78.3 测试与门禁

- `client/tests/composer.test.tsx` 新增 describe 4 例（arena 全员入席 → 成员条隐藏且席位 `title=召唤` 缺席但 @ 菜单仍可用；arena 有未入席成员（苏纵）→ 保留；stream（无 stage 声明）→ 保留；纯列表（listMode）→ 恢复展示）；helpers 扩展（makeAgent 加 group 参数 / makeGroup / setSession）；
- check:agents 29 场景 / 114 角色 / 26 预设（零资产变更）；check:skills 51；client 63 文件 / 820 测试全绿（本批新增 4 例；窗口内含并发批次增量）；全仓 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；eval 28/28 零回归（mock；零 agents 资产变更）；client build 通过（本批窗口产物 `index-fBAX0Wfp.js` 1,231.13 kB；dist 窗口内后随并发批次重建，数值仅作点记录）；
- E2E：`m52-stage` 22 例 + `m43-pk` 2 例 = **24/24 全绿**（2.2m；影响面检查——全仓检索确认 e2e 无标题栏头像组依赖，`m43-pk` 走 sendMessage 直输 @、`m14-responsive` 走 BottomMemberBar，均不经成员条 DOM）；视觉核验：谈判（arena）场景实测截图 `data/m52g-negotiation-arena.png`（标题栏头像组消失 / 成员条让位 / 三张席位卡——谭成 / 苏纵 / 祁弈——保留）；
- 文档：本页 §78、ADR 0126、`docs/adr/README.md` 索引、`agents/CHANGELOG.md` v49。

## 79. 场景工作区就绪判定与面板标题合行——无数据不展示 · 折叠 / 关闭钮注入 · dock 拖拽增强（M58）

用户实测截图（传统数术 dock·chartboard 八字盘面）：右工作区面板标题行（「盘面面板」+ 徽标）与右上角折叠 `>` / 关闭 `×` 独立操作条各占一行；诉求原话「右侧面板 做成标题，放到 header 上，与关闭一行，整体优化设计i下，右侧面板没数据的时候可以先不展示，有内容之后在展示，并调整合理的宽度等，交互详细设计优化下」。本批把「对话即全部」的起步体验归还给对话区：未就绪不渲染工作区、就绪自动出现（挂载即真实数据）；面板标题与操作合行；dock 宽度与拖拽交互全面增强。**纯前端批次**（零服务端 / 零资产 / 零协议），决策见 ADR 0127。

### 79.1 就绪判定与「无数据不展示」（panel-ready）

- 纯函数 `panelReady(panel, { containers, verdicts, messages })`（新文件 `client/src/components/scene/panel-ready.ts`）：六面板逐一口径——chartboard = 有 `::: pan` 容器；pool = 有「结构化行（items / fields）或带 arg 标题」容器；versus = 有 `::: verdict` 裁决实例；board = 成员消息带 Markdown 标题（headingsOf）或存在交付件（artifactsOf）；console = 成员消息（role=agent && agentId）/ 管道列（kanban·pipe·board 有行）/ 交付件任一非空；coach = 有 `::: checklist` 容器；口径「宁可多显示不可漏显示」——判 true 最多多渲染空态，判 false 才隐藏（防「有数据但工作区不出现」的功能倒退）；
- hook `useScenePanelReady(panel)`（use-scene-data.ts）：单 useSceneMessages 订阅（500ms 节流 + 流式冻结口径同源）+ useMemo 内派生 containersOf / verdictsOf → panelReady；未声明面板（stream / arena）恒 false；
- 宿主接入（SceneStage）：未就绪 → `panel` 不下传——dock 提前 return children（连 `.scene-dock` 骨架都不渲染，完全直通纯对话流）、roundtable 无汇聚板 aside（`.scene-rt-aside` 零数量）、窄屏无抽屉；就绪自动出现（组件挂载即带真实数据，无「空态闪一下」）；手动 closed 状态尊重用户意图（有数据后出现 reopen 按钮而非自动弹出）；
- 组件级空态（PanelEmpty）保留为兜底（就绪判定与容器渲染间的时序）；单测双层口径——宿主断言「不渲染」、组件断言「空态」。

### 79.2 标题合行与面板壳收口

- `PanelShell` 标题行统一「图标 + 标题 + 徽标（贴左）+ 操作区右推（`.scene-panel-actions`）」；新增 `PanelChromeContext`（panels/chrome.tsx）——宿主把折叠 / 关闭钮注入面板标题行（`actions` prop 可覆盖），六面板注册表零 props 装配不变；
- `DockStage`：独立操作条 `.scene-dock-bar` 删除；折叠 / 关闭钮（`.scene-dock-act`，title「折叠工作区」/「关闭工作区」）经 chrome 注入面板标题行；折叠态竖条 / 展开按钮 / reopen 按钮（「显示工作区」）照旧；
- 滚动下沉：`.scene-panel-head` 固定（flex-shrink 0 + border-bottom）+ 新增 `.scene-panel-body`（flex:1 + min-height:0 + overflow-y auto + padding）——右区 / 抽屉 / 汇聚板三宿主同构；`.scene-drawer-body` 改 overflow hidden（防双重滚动）；`.scene-panel` / `.scene-dock-panel` / `.scene-rt-aside` 改 flex column 结构；
- 入场动画（`@keyframes scene-aside-in`）：右区 / 汇聚板 aside 就绪挂载淡入 + 10px 右移归位（0.18s ease-out）；quiet-mode / prefers-reduced-motion 全关。

### 79.3 dock 宽度与拖拽交互增强

- 宽度：默认 340 → 360px、clamp 260–520 → 280–640px（persist.ts `DOCK_DEFAULT` / `DOCK_MIN_W` / `DOCK_MAX_W`）；上限覆盖盘面 / 看板阅读，640 在 1280 桌面宽度下对话区仍保 ≥640px；
  > **批九修订（2026-09-19）**：固定宽度口径整体被取代——默认改容器 1/3（clamp 380–600）、上限改容器一半（左区恒保 ≥50%）、双击复位回自适应（存储 `width: number | null`，旧 360 迁移 null）；详见 §111 / ADR 0183。
- 拖拽零 React 渲染：pointerdown 记录起始宽 → pointermove 只改 `widthRef` + `asideRef.current.style.width`（不经 state）；抬手一次 commit（落态 + localStorage `ma:sc:dock`）；pointercancel 回滚起始宽度（不落盘）；组件卸载清理 body 光标 / 选择态；
- 三入口共用 commit：拖拽抬手 / 双击把手复位默认宽 / 键盘 ← →（16px 步进、Shift 48px 加速）；把手可聚焦（`role=separator` / `aria-orientation` / `aria-valuenow·min·max` / aria-label）；
- 拖拽态视觉：`.scene-dock-resizing`——全域 col-resize 光标 + 把手高亮 + body user-select none；grip 常态 transition + focus-visible 描边。

### 79.4 测试与门禁

- vitest：`m52-stage.test.tsx` 46 → 55 例——SceneStage 宿主用例重写（4 → 6：无数据不渲染 / 有数据渲染 + 标题合行断言（`.scene-panel-actions` 双钮 + title）/ 窄屏有数据抽屉 / 窄屏无数据不渲染 / listMode）；M52-B roundtable 汇聚板 1 → 2（有产物渲染 / 无产物不渲染）；新增 `M58 panelReady（六面板就绪口径）` describe 6 例（containersOf / verdictsOf 派生数据逐口径断言）；
- E2E：`m52-stage` 22 例断言全面改写（约 20 处空态断言 → 「不渲染」）+ 两条有数据路径（窄屏 SRE 发消息 → 抽屉出现；融资资本发消息 → 工作区出现 → 标题行折叠 / 关闭钮 → 折叠竖条 → 展开 → 关闭 → 「显示工作区」恢复全链）；chartboard 无 E2E 有数据路径（mock 不触发 pan 工具调用）由单测覆盖；
- 门禁：check:agents 29 场景 / 114 角色 / 26 预设（零资产变更）；check:skills 51；client 63 文件 / 830 测试全绿；typecheck 0 错误（client + e2e）；ESLint 改动文件 0 错误；eval 28/28 零回归（mock；零 agents 资产变更，沿用基线）；E2E `m52-stage` 22 + `m42-roundtable` 1 + `m34-invest` 3 = **26/26**（首轮 1 例 close 阶段 trace ENOENT——并发 test-results 写入环境噪声（断言全过），单跑复验通过）；
- 文档：ADR 0127、本页 §79、§66.2 修订注记、`docs/scene-expansion-design.md` §7.2 / §7.3 同步、`docs/adr/README.md` 索引、`agents/CHANGELOG.md` v50。

## 80. 席位环几何修正与议程清单化——头像精确落位 · 桌面坐沿 · 顶区左右平衡（M52-H）

用户实测反馈（截图）：社会议题研讨（roundtable·pool）顶部区域效果异常——浏览器实测测量确认四项缺陷：① 名字标签与虚线圆交叉不对称（顶席「尚真」深入圆内 14.3px / 左右席临界相切 0.4px / 底席在圆外 18px）；② 座位盒「头像 + 名字」整体居中定位 → 头像视觉中心偏高 8.3px（几何正圆却视觉偏心、圆穿左 / 右 / 下三个头像）；③ 底席「允中」名字下沿溢出 `scene-rt-top` 2.1px 被消息区覆盖；④ 宽屏（1600）顶区右侧 322px 全空（34%），议程条 23.6px 单行与 148px 席位环失衡。**纯前端批次**（零服务端 / 零资产 / 零协议改动），决策见 ADR 0128。

### 80.1 席位环几何修正（SeatRing）

- 座位盒 = 头像盒（`64 × 30`），名字改绝对定位不参与盒居中——盒中心 = transform 落位点 = 头像中心；参数 `RING_SIZE 152 / RING_RADIUS 54 / 头像 30`（回归测量 4 席半径 54±0.05 / 角度精确 0°/90°/180°/270°）；
- 桌面由虚线圆环改**实心圆面**（`inset 38px` 半径 38 与头像内缘 39 相切坐沿）；名字绝对定位在头像下 2px、带底色（`hsl(var(--background))`）——不与圆面交叉；
- 名字外溢承接：底席固定外溢约 13px 由 `.scene-rt-top` `padding-bottom`（0.9rem）接住（不再被消息区覆盖）。

### 80.2 议程清单化（AgendaTrack）

- 由单行 chips（12px 连接线）改**纵向清单**：与席位环等高并排（`scene-rt-top` align-stretch + 内部 `justify-content: center`）、撑满余宽（宽屏余宽由议程行填充）；
- 每步「状态点 + 标签 + 状态字（已完成 / 进行中 / 待办）」；状态点由竖向轨道线串联（`::before` 跨行 gap 连续；`:first-child / :last-child` 端点收束首末点、`:only-child` 隐藏）；
- 长标签单行省略；点击语义（onPick 回填 / 定位）与类名（`.scene-ag-*` / `[data-ag-heading]`）不变。

### 80.3 测试与门禁

- 类名 / DOM 语义 / 交互零改动——既有断言面（`.scene-seat-ring` / `.scene-ag-*` / `[data-ag-heading]`）零修改全绿：`client/tests/m52-stage.test.tsx` + `m42-meeting.test.tsx` 67 例通过；client 全量 63 文件 / 830 测试全绿；
- check:agents 29 场景 / 114 角色 / 26 预设（零资产变更）；check:skills 51；client typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；eval 28/28 零回归（mock）；client build 通过（`index-ClLPFCs9.js` 1,233.68 kB / gzip 350.44 kB）；
- E2E：`m52-stage` 22 例 + `m42-roundtable` 全绿（并发窗口实测；含席位环 4 席名字 / 议程文案断言）；
- 视觉核验：`data/social-issue-ring-2p4x.png`（环 2.4x 特写——头像环周均匀、名字白底不交叉、圆面坐沿）/ `data/social-issue-topreg-full-1p25x.png`（顶区全条带——议程清单 + 状态字撑满余宽）；
- 文档：本页 §80、ADR 0128、`docs/adr/README.md` 索引、`agents/CHANGELOG.md` v51、`docs/scene-expansion-design.md` 头部修订注记。

## 81. arena 席位发言流实时化与侧栏宽度自适应——双源接入 · clamp 宽度（M60）

用户实测反馈（arena：辩论场 / 谈判桌）：① 两侧席位发言流「不是实时展示的，等输出结束再展示」——M52-D 冻结口径（§70.1 / ADR 0114）下运行中侧栏长时间空白、收束瞬间批量刷新；②「全屏展示时两侧太窄」——侧栏固定 `164px`，宽宿主下与中轴体量失衡。**纯前端批次**（零服务端 / 零资产 / 零协议改动），决策见 ADR 0129。

### 81.1 双源接入（实时纯文本投影 × 冻结容器解析）

- 新 hook `useSceneLiveMessages`（use-scene-data.ts）：与 `useSceneMessages` 同构同节流（500ms）、**仅移除流式冻结**——纯文本投影面专用；容器解析面（containers / verdicts / panelReady 与 arena 论断树 / 报价流 / 裁决流）仍走冻结快照（半截容器不进派生，ADR 0114 / 0129）；
- ArenaStage 双源：冻结 `messages` 供裁决流 / 博弈面板 / 回合定位（零改动），实时 `liveMessages` 仅供 SideFeed 两席——条目在首个 delta 后 500ms 内入流并随发言增长（原：等整轮收束）；
- 流式态：条目 `data-streaming` 描边高亮 + 尾部闪烁光标（`caret-blink`；reduced-motion 关闭，与 typing-caret 同口径）；空正文 → 「发言中…」占位；收束后去标记、条目保持。

### 81.2 侧栏宽度自适应

- `.scene-arena-side` 固定 `164px` → `width: clamp(164px, 20%, 280px)`：窄宿保底 164px（原值不变），宽宿（含全屏 / 大屏）随宿主按比例放宽、280px 封顶；不新增断点，窄屏（<900px）仍走 §7.3-4 降级（侧栏不渲染）。
- **续修订（同日二轮实测反馈）**：`20% / 280px` → `24% / 360px`（用户原话「可以在宽一点」）——窄宿保底 164px 与窄屏降级口径不变；原 280px 上限即 ADR 0129 注明的「4K 重估点」，本次按实测提前重估。
- **续修订二轮（滚动条占位一致性）**：`.scene-arena-side` 追加 `scrollbar-gutter: stable`——两侧恒预留滚动条槽位：经典滚动条（鼠标模式）只占溢出的一侧，曾令左右内容区标尺差 ~15px（用户实测「两边宽度不一致」的观感来源；外框实测本就亚像素相等）；stable 后两侧内容宽度严格一致，overlay 模式无副作用。
- **续修订三轮（中轴让渡 + 条带瘦身）**：`24% / 360px` → `22% / 340px`（用户原话「中间内容有点小，看不完整一个消息」）——两侧仍同值严格一致；同批中轴顶部条带瘦身：`.scene-arena-center` / `.scene-arena-track` padding 0.4rem → 0.25rem、`.scene-arena-insights` max-height 190 → 150px（面板可内部滚动），为消息区让渡纵向空间（约 45px）；`WaveStrip` 悬浮条 top-2 → top-3.5（缓和与上方固定条带的贴近观感）。
- **续修订四轮（悬浮阶段条重塑为顶部方位条 + 贴顶边上移，同日）**：用户实测截图红框「重新优化」——药丸与消息头部同排交错（药丸「第 1 波 · 谭成」与消息头「13:25 你」并列）→ 顶部渐隐遮罩（`data-wave-scrim`）+ 药丸轻量化 + 「共 N 波」读数（≥2 波才显示）；二次实测红框「需要上移」→ 药丸偏移 `top-3.5` → `top-1`（贴顶边：不再下探到首条消息，呈渐隐区内的边缘读数——覆盖三轮的 14px 判定）。E2E 锚点 `data-wave-strip` 零改动。详见 ADR 0065 决策 4 续修订、`docs/scene-chat-design.md` §5.3 / §5.4 ⑧。

### 81.3 测试

- 组件测 `client/tests/m60-arena-live.test.tsx` 新建 3：流式消息即时入侧栏（`data-streaming` + 增量 500ms 节流刷新 + 收束去标记保持）/ 空正文流式 → 「发言中…」占位 / 冻结面边界（流式 `::: claim` 不进论断树、收束后出现——实时与冻结两通道互不越界）；
- E2E `e2e/m52-stage.spec.ts` arena 用例 +2 断言：run 收束前侧栏 `data-streaming` 条目可见（live 通道）；侧栏宽度 = clamp(164px, 宿主 24%, 360px)（误差 <2px，续修订同步）+ 视口放宽后随宿主变宽；续修订追加「左右两栏等宽」一致性核验（同一 clamp 公式 + 同一包含块，断言带数值消息输出；1280 / 1728 两档视口实测左右亚像素相等）；续修订二轮追加「滚动条占位一致性」核验（两侧 `scrollbar-gutter` computed = stable + `clientWidth` 严格一致——经典滚动条只占溢出一侧曾令内容区差 ~15px）。

### 81.4 门禁

- check:agents 29 场景 / 114 角色 / 26 预设（零资产变更）；check:skills 51；server 81 文件 / 1088 测试全绿（本批零净增）；client 65 文件 / 842 测试全绿（本批新增 1 文件 3 例：`m60-arena-live.test.tsx`；窗口内含并发批次增量）；全仓 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过（主包 `index-DU8GPVTx.js` 1,244.16 kB / gzip 354.02 kB；含并发批次合流，点记录）；eval 28/28 零回归（mock；零协议 / 零资产变更）；
- E2E 定向 24/24 全绿（2.2m）：`m52-stage.spec.ts` 22（含 arena 用例 +2 断言：收束前 `data-streaming` 可见 / 宽度 clamp 公式 + 视口放宽变宽）＋ `m43-pk.spec.ts` 2（arena 席位发言流回归——双源接入后对决组 / 配对卡 / 裁决流全链不变）；
- 文档：本页 §81、ADR 0129、`docs/adr/README.md` 索引、`docs/scene-expansion-design.md` 头部修订注记、`agents/CHANGELOG.md` v53。

---

## 82. roundtable 顶区重设计与汇聚板收起——俯视圆桌 · 横向步骤条 · 折叠 / 关闭（M59）

用户实测截图反馈（三处红框：顶区席位环 + 议程清单 / 含状态字区域 / 议程列表特写）：roundtable（社会议题研讨）顶区「太丑了，专业的角度设计下」并明确否决 M52-H（§80）的纵向议程清单（原话「不要用这个列表」）；质疑空面板（原话「还有空的面板？可以展示和收起」）。本批重做顶区（卡片带收束 + 席位环俯视圆桌化 + 议程横向步骤条化），汇聚板补折叠 / 关闭 / 恢复。**纯前端批次**（零服务端 / 零资产 / 零协议），决策见 ADR 0130（修订 ADR 0128 的议程形态与环面部分）。

### 82.1 空面板澄清与收起能力补全

- 「空面板」经核为用户所持 M58（v50）前版本：就绪判定（`panelReady`，§79 / ADR 0127）已保证「无数据不渲染」——roundtable 无产物不渲染汇聚板（SceneStage 未就绪不下传 `panel`）；
- 本批补全 roundtable 汇聚板**折叠 / 关闭 / 恢复**（此前仅 dock 具备）：`PanelChromeProvider` 注入折叠 / 关闭钮（汇聚板标题行右侧），折叠 → 34px rail（展开钮 + 竖标「汇聚板」），关闭 → 浮动恢复胶囊（`.scene-rt-reopen`）；偏好 `ma:sc:rt`（`RtPref {collapsed, closed}`）localStorage 全局记忆；窄屏抽屉不注入（抽屉自带收起）；
- 三态判定顺序：`closed` > `collapsed` > 展开——关闭态优先且不渲染 aside（恢复靠胶囊）；有数据且收起时胶囊常驻可恢复（尊重用户意图，口径同 M58）。

### 82.2 顶区卡片带与席位环 v3（俯视圆桌）

- `.scene-rt-top` 改**浅灰圆角卡片带**（`hsl(var(--muted) / 0.4)` / `border-radius 0.8rem` / `margin: 0.45rem 0.9rem 0.1rem` / `padding: 0.5rem 1rem 0.55rem`）——席位环与议程步骤条同行居中（`align-items: center`），内容由卡片边界收束、与消息流分层；窄屏（column）沿用降级；
- SeatRing v3（重写）：头像 `26px`、环半径 `40px`、实心桌面 `56px`（`hsl(var(--card))` + `inset 0 0 0 1px` 描边）；名字**径向朝外四向锚定**——`data-dir = up / right / down / left`（按落位角就近取，零 JS 布局分支），CSS 属性选择器定位（上下向 `left: 50%` + `translateX(-50%)`；左右向 `top: 50%` + `translateY(-50%)`），**无底色**（消除贴纸感与交叉）；发言席主色描边 + 外光环（双层 box-shadow）；
- 几何要点：落位公式 `rotate(θ) translateY(−R) rotate(−θ)` 下，页面方位角 = `θ − 90°`（θ=−90 落位在正左）——`nameDir` 以 `(angle − 90)` 归一取方位（实现期修复的整体 90° 偏移）；环容器 `176 × 138` 恰容纳四向名字（左右向 `max-width 32px`、上下向 `76px`，超出省略）。

### 82.3 议程横向步骤条 v3

- AgendaTrack 由 v51 纵向清单（含状态字）整体替换为**横向 stepper**：节点三态（done 实心 / doing 实心 + 光环 / todo 空心描边）+ 连线 + 标签；`heading` 摘要改贴卡片带右端（`margin-left: auto` + `max-width` 省略），不再逐行重复、不再铺满余宽；
- **连线连续性实现**：节点两侧半线（`.scene-ag-step::before` 至 `calc(50% − 7px)` / `::after` 自 `calc(50% + 7px)`）+ 相邻步骤间隙段 `.scene-ag-link`（26 × 2px，`data-state` 随前步）——标签空白区由半线贯穿、节点 `z-index: 1` 盖线端，拼接成连续轨道（修复「短划线」观感）；done 段三段同色（`.scene-ag-done::after` / `.scene-ag-link[data-state='done']` / `.scene-ag-done + .scene-ag-link + .scene-ag-step::before`）；
- 交互与断言面不变：`role=list` / `listitem`、`.scene-ag-step` / `.scene-ag-{state}` / `.scene-ag-label` / `[data-ag-heading]`、onPick 语义（会议议题定位 / 波次回填）零改动；heading 兜底口径补全（会议全议决 → 「议题 X/Y · 已全部议决」；波次驱动 → 「研讨推进中 · N/M」/ 全完成 → 「研讨步骤已全部完成」）。

### 82.4 测试与门禁

- `client/tests/m52-stage.test.tsx` 新增「M59 汇聚板收起（折叠 / 展开 / 关闭 / 恢复）」1 例全链（含 localStorage 清理）；
- client 68 文件 / 866 测试全绿（本批新增 2 例；窗口内含并发批次增量）；typecheck 0 错误；ESLint 0 错误（6 条既有 warning）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；eval 28/28（mock）；
- E2E 定向 `m52-stage` + `m42-roundtable` 23/23 全绿；client build 通过（主包 gzip 350.87 kB，含并发批次合流，点记录）；视觉核验截图 `data/m59-vis-top-done.png` / `m59-vis-ring.png` / `m59-vis-full.png` / `m59-vis-rail.png` 等 6 张；
- 文档：本页 §82、ADR 0130、`docs/adr/README.md` 索引（0128 → Amended）、`docs/scene-expansion-design.md` 头部修订注记、`agents/CHANGELOG.md` v54。

### 82.5 顶区居中与收起（续修订）

- **顶区内容组整体居中**（二轮反馈「居中是不是更好」）：`.scene-rt-top` 加 `justify-content: center` + `position: relative`（收起钮定位上下文）；议程不再撑满余宽——`.scene-agenda { flex: 1 → 0 1 auto }`、摘要 `.scene-ag-heading { margin-left: auto → 0 }` 跟随步骤条构成连续居中组；窄屏恢复原排布（`justify-content: flex-start` + agenda `flex: 1` + heading `margin-left: auto`）；
- **摘要让位优先级与轨道裁剪**（修复中等宽度重叠）：`.scene-ag-heading { flex-shrink: 99 }`（空间不足时摘要先收「…」，步骤条完整性优先）+ `.scene-ag-track { overflow: hidden }`（收缩后子项溢出绘制的兜底裁剪）——修复 1280 下「摘要与末步标签重叠」（轨道被 flex 压缩后固定宽 step 溢出绘制所致）；
- **顶区收起 / 展开**（二轮反馈「不能收起展开」——经实测汇聚板折叠 / 展开 / 关闭 / 恢复全链正常，判定为顶区缺收起能力，本批补全）：展开态右上角悬浮收起钮（ChevronUp，`title="收起席位环与议程"`）→ 收起态单行迷你条 `.scene-rt-top-mini`：小头像堆叠（`AgentAvatar` 16 + `.scene-rt-mini-seat` 负 margin 叠放 + 底色描边环）+ 摘要 `.scene-rt-mini-heading`（省略；无摘要兜底「N 席圆桌」）+ 展开钮（ChevronDown）；收起态席位环 / 席位条与议程卸载、摘要保留（识别与进度不丢）；偏好 `RtPref.topMini` 落 `ma:sc:rt`（旧值向后兼容）；窄屏迷你条保持单行；reduced-motion 收敛登记 `.scene-rt-top-toggle`；
- 实测（Playwright 临时 spec 双宽度布局测量）：1600 两侧留白 72px = 72px、1280 16px = 16px（对称）；1280 摘要缩略让位 + 轨道 4px 微裁（step 完整）、重叠 = −16px（零重叠）；顶区收起 / 展开 + 汇聚板折叠 / 展开 / 关闭 / 恢复全链 15.6s 通过后清理；`m52-stage.test.tsx` 新增「顶区收起 → 迷你条；展开恢复」1 例（本批合计 2 例）；截图 `data/m59c-3-top.png`（居中）/ `m59c-5-top-mini.png`（迷你条）/ `m59c-6-top-1280.png`（中等宽度降级）。

---

## 83. 可玩盘面——四张排盘卡的交互化与参与式游戏化（M54）

用户原话「**不要只是简单的表格，可以增加交互和游戏性，让用户参与感更强**」——M53（§68 / ADR 0113）交付的四张专业盘（八字 / 紫微 / 星盘 / 卦）信息已专业化（八字 11 字段 + 8 大运 + 10 流年；紫微 6 字段 + 12 宫；星盘 38 条目；卦 8–9 字段 + 六爻），但呈现仍是静态行渲染，阅读单向。关键机会：盘面数据已全量在卡内且卡格式被契约测试（`m53-pan-card`）锁定——交互化做到**纯前端派生、零工具、零协议变更**。本批按设计基线 `docs/pan-interactive-design.md`（947 行 v2）三分期一次收口：M54-A 基座 / M54-B 盘面 / M54-C 参与层与收口；**纯前端批次 + agents 侧仅 metaphysics 协议 #14 一条**，决策见 ADR 0131。

### 83.1 派生层与视图切换（M54-A）

- `model.ts` + `derive.ts` 从 `::: pan` 容器卡文本全量派生交互模型（黄经与度数 / 干支 / 大限年龄 / 世应动变 / 六爻数均取自卡内）；必需门（八字 = 四柱 + 五行 + 日主 + ≥1 大运；紫微 = 12 宫全项）不过 → `null` → 回退静态表格——表格为回退终点（`PanCard` 不替换为盘面，明细与 Agent 复制原文形态恒可达）；
- `PanView` 统一入口（kind 分发 + ErrorBoundary + Suspense）：四盘板全部懒加载（pan 目录单 chunk）、渲染失败回退调用方静态表格；板内选中态不进会话存储（§7.9 约束①）；
- 默认盘面 + 视图切换记忆 `ma:pn:view:<sid>:<mid>`（session，per-message）；流式期一律回退表格（半截卡不派生）；
- 单测 `m54-pan-derive.test.ts` 25 例（正常 / 边界 / 损坏 / 缺段 → null）。

### 83.2 四盘交互（M54-A / B）

- `BaziBoard`：四柱点看（柱详情）、五行能量、大运轨道（当前大运 ●、点选 scrub）、流年条、请教草稿（模板入 Composer）；
- `ZiweiBoard`：4×4 宫格（`data-branch` 定位）、三方四正（`.is-rel`）、大限巡游（`.is-current`）、生年四化着色（颜色 + 文字双编码）；
- `GuaBoard`：装卦回放（六爻逐爻进）、变卦剧场（开 / 关）、错·综预览、世应角标 + 空亡、爻详情随选中切换、无动爻禁用态（动爻随机：P(无动爻)=17.8%，禁用态为正常路径）；
- `NatalWheel`：轮盘（10 行星 / 16 弦 / 12 宫 / ASC·MC 轴，viewBox 等比缩放）、行星悬停浮标 + 点看详情、弦提示与中选、相位筛选（16 ⇄ 12）、矩阵互跳（点格回轮盘且中选）、请教此星 / 此相位草稿；
- 键盘可达（行星聚焦出浮标 + Enter 开详情；矩阵方向键换格 + Enter 激活）；reduced-motion 直出终态（卦盘重放不进运行态）；组件测 `m54-pan-boards.test.tsx` 33 例。

### 83.3 摇卦台与报数（M54-C）

- `TsToss` 摇卦台：公开仪式种子（crypto 随机、界面可见）+ `mulberry32(seed)` 现推六爻——与 `gua_pan`（method=coin）同源表逐位一致（单测断言）；流程 = 填写所问 → 开始（种子生成）→ 六次点击成卦（每次一爻）→ 揭晓（本卦 + 动爻 + 对照 6 行）；
- 存储 `ma:pn:toss`（session）只存 `{seed, question, done, startedAt}`——结果恒由种子现推（中断可续、复盘可算）；
- 「以此卦请解」→ 草稿携种子与 `gua_pan（method=coin，seed=…）` 参数入 Composer（不发送）；报数起卦页签草稿携两数与 `method=number`——**不本地预测卦名**（卦名唯一来源工具复算）；
- 组件测 `m54c-pan-toss.test.tsx` 8 例。

### 83.4 档案 · 合参 · 研习足迹（M54-C）

- 档案（`archive.ts`）：`ma:pn:archive:<sessionId>`（聊天卡 ⭐ 入口与面板统一，会话共享同键），上限 20 FIFO，本地私密不落库；抽屉（`.pn-arch-*`）支持存为档案 / 回看 / 对照；同型盘对照差异高亮（`diff.ts`），异类盘只并排（`.pn-arch-mix`「异类盘仅并排」）；
- 合参（`Almanac.tsx`）：同一年龄轴（0 → 两盘最晚终限）双泳道——泳道一 = 八字大运（当前段 ● + 当前大运内流年点）、泳道二 = 紫微大限（当前段 ●）；出生年已知（盘内「命造」公历日期）同轴双标年份（= 出生年 + 年龄），缺失只显年龄绝不虚构；点选任一段双泳道联动高亮 + 只读详情行；面板头部「合参」toggle；
- 研习足迹（`trail.ts`）：`ma:pn:trail:<sessionId>` 去重计数（看过 N 张盘 / 十二宫已游历 N/12 / 摇卦 N 次 / 请教 N 次），`PanView` 页脚只读小字——无连击 / 签到 / 成就墙等任何成瘾机制（合规红线）；
- 组件 / 单测：`m54c-pan-archive.test.tsx` 11 例、`m54c-pan-almanac.test.tsx` 5 例、`m54c-pan-diff.test.ts` 5 例。

### 83.5 协议 #14 与面板接入（M54-C）

- metaphysics `_protocol.md` 新增第 14 条「**摇卦复算核对**」：用户以摇卦台 / 报数起卦发来的草稿（含种子 / 两数）必须先经 `gua_pan` 复算——以工具盘面为准，禁止直接采信草稿中的卦名与动爻结论；解读前复述本卦 / 变卦 / 动爻 / 世应并核对一致，不一致以工具结果纠正并说明（与「起卦可复现」第 9 条呼应，诚实边界协议化）；
- 面板接入（ChartboardPanel / PanBoard）：多盘 tabs（会话内全部盘卡）；M54-C 面板补合参 toggle（同人双盘 → 双泳道）与档案抽屉；盘来源去重键（聊天卡传 messageId、面板传 chart.id）；「看解读」→ 消息定位语义不变；
- E2E `m54-pan-interactive.spec.ts` 8 例：卦盘 / 星盘 / 八字 / 紫微四盘主路径 + reduced-motion + 键盘走查（M54-B 6；八字 = 点柱详情 + 大运 scrub 空态补算，紫微含设计 §7.8 口径② 点宫高亮）+ 摇卦台全链 / 面板双盘 + 合参 + 档案（M54-C 2）；mock 侧新增触发词「盘面走查」（`PAN_TRIGGER`：bazi / ziwei 剧本尾部追加可派生盘卡——E2E 固定剧本口径同 M37 checklist 先例；收口期盘卡对齐真实全格式）。

### 83.6 测试与门禁

- M54 相关测试 87 例（derive 25 / boards 33 / toss 8 / archive 11 / almanac 5 / diff 5；窗口内含并发批次合流）；server 81 文件 / 1088 测试全绿；client 68 文件 / 866 测试全绿；全仓 typecheck 0 错误；ESLint 0 错误（既有 warning）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；
- eval 28/28 ✅（mock；含 metaphysics 3 回合；仅协议 #14 一条 agents 变更，与基线零回归）；
- E2E 定向 `m54-pan-interactive` 8/8 全绿（2.0m；收口期补八字 / 紫微主路径 2 例——四盘主路径全覆盖）；相邻回归 E2E 28/28 全绿（2.5m：`markdown-ext`（含盘面卡渲染）/ `m52-stage` / `m37-scene-chat`）；client build 通过（主包 `index-CjG-CB_G.js` 1,286.59 kB / gzip 354.98 kB；含并发批次合流，点记录）；
- 合规红线自检（§5.6）：无吉凶评分条 / 运势卡 / 签到 / 成就墙；全部回填只写草稿不发送不落库；档案 / 足迹本地私密；不预测卦名、不推测应期、不虚构数据；
- 文档：本页 §83、ADR 0131、`docs/adr/README.md` 索引、`docs/pan-interactive-design.md` 头部状态与实施落位注记、`docs/scene-expansion-design.md` 头部落地修订注记（M54）、`agents/CHANGELOG.md` v55。

### 83.7 视觉走查修复（收口后同日）

- 走查：临时 Playwright spec 复现真实用户路径（发卡 → 盘面渲染 → 交互 → 截图）共 17 张全量审读（四盘桌面 / 详情 / 窄屏 + 参与层 + 面板 + 弹窗），发现 2 项真实缺陷 + 3 项澄清；
- **缺陷 1（摇卦台层级）**：`TsToss` 未 Portal 化——遮罩渲染在消息虚拟列表行内，行 `transform: translateY()` 创建 stacking context「封层」，遮罩（z 85）实际层级 ≈ 0 → 被根上下文「波次条」（z-30）与「回到最新」（z-20）盖过并劫持点击（模态性破坏）；修复 = `createPortal(mask, document.body)`（直参与根上下文）；实证：`elementsFromPoint` 命中栈首元素自「WaveStrip 按钮」变为「`div.pn-toss-mask`」、祖先链无封层；组件测适配 `baseElement`（8 例零改动）；
- **缺陷 2（回到最新遮挡）**：胶囊 `justify-center` 居中线遮挡卡片底部操作区（窄屏「请教大运」按钮 / 表格回退态流年行，截图实锤）；修复 = 贴右下（`justify-end` + 右内边距）；m12 以 `title` 定位零改动，MessageRail（垂直中段）无冲突；
- 走查澄清（设计内行为，不修）：合参泳道段截断（轴对齐 + 详情行兜底）/ 大运轨道横滚（`overflow-x: auto` 设计）/ 足迹「看过 N 张盘」按来源去重（设计例原话）；
- 复验：client 68 文件 / 866 测试全绿 + typecheck / ESLint 0 错误；定向 E2E 11/11（`m12-interactions` 1 + `m37-scene-chat` 2 + `m54-pan-interactive` 8）；走查复截确认（成卦态弹窗完整体 / 四盘窄屏与表格回退态胶囊贴右下零遮挡）。

### 83.8 模态性深化修复（二次续完善，探针驱动）

- 探针（临时 Playwright 脚本，reduced-motion 直出）实测发现 2 项确凿缺陷 + 1 项设计缺口：① **Tab 焦点逃逸**——14 步 Tab 环实测 12 步焦点逃出弹窗（自定义弹窗无焦点约束，弹窗本身存续——纯焦点逃逸）；② **虚拟列表行回收卸载弹窗**——消息列表滚动 1800px 后 `.pn-toss` 消失（宿主在 `PanView` 消息行内，行被 `@tanstack/react-virtual` 回收即卸载；滚回不恢复，重开可恢复 = 存储兜底）；③ §5.1「chartboard 面板头部同按钮」未实现（面板无摇卦入口）；
- **宿主提升**：`ui-store` 新增 `panToss: PanTossRequest | null`（`{compare, sessionId}`）+ `openPanToss` / `closePanToss`；新组件 `TossHost.tsx`（`PanTossHost`）挂载于 `AppLayout.overlays`（宽 / 窄屏与控制台视图恒挂载）——弹窗与任何局部卸载解耦；请解草稿仍走 `insertToComposer` 全局通道（宿主直调，不自动发送），成卦 / 请教程在宿主落账；`PanView` 只发 `openPanToss` 请求（对照组装 `{title: model.ben, yao}` 快照）；
- **trail 订阅**：`trail.ts` 新增 `subscribeTrail(fn)`（`write()` 内 notify）——宿主不在 `PanView` 组件树内时的页脚跳组件刷新（E2E `摇卦 1 次` 断言链路保持）；
- **焦点约束（轻量 trap）**：`TsToss` 打开期挂 document 级 `keydown`（捕获）+ `focusin`——Tab 在台内首尾环回弹（尾 → 首 / 首 → 尾；焦点在台外时拉入首 / 尾元素）。面板为 portal 挂 body 末尾元素，浏览器无自然环回，须显式环回；配合遮罩点击 / Escape 关闭；
- **面板入口补齐（§5.1）**：`ChartboardPanel` 头部「亲手摇卦」（空态 / 有盘态恒渲染，与「合参」toggle 同排右对齐；`.pn-toss-enter` 独立类名——免与 `.pn-alm-toggle` 单元素定位冲突）；对照基线 = 会话内首个可派生卦盘（`derivePan('gua')`），无卦盘 → `compare = null` 仍可摇；
- 复验：探针复跑 **逃逸 12/14 → 0/14**、滚动 1800 前后与滚回 `.pn-toss` 恒为 1（小视口 900×560 / 窄屏 375 存续可测：弹窗 400×482 含内滚 / 353 宽零溢出；截图 `data/m54w-small-done.png` / `m54w-small-bottom.png` / `m54w-narrow-done.png`）；`m54c-pan-toss` 8 → 9（Tab 首尾环回 + 逃逸拉回）+ 新建 `m54d-pan-toss-host` 3 例（请求驱动开合 / 请解草稿 + 请教足迹 / 对照快照 + 摇卦足迹 + 无会话静默降级）→ client 69 文件 / 870 全绿；E2E `m54-pan-interactive` 8/8（面板摇卦入口新增断言：点入 → 弹窗 → Escape 关闭）+ 相邻回归 28/28；全仓 typecheck / ESLint 0 错误；client build 通过。

## 84. 多 Agent 调度增强——路由简报 · 停滞抑制 · 写冲突防护 · 接单回执 · 调度指标（M61）

- 决策依据：[ADR 0133](docs/adr/0133-dispatch-excellence.md)；证据：`server/tests/m61-dispatch.test.ts`（13 例）、`server/tests/scheduler.test.ts`、`server/tests/run-events` 断言链。

### 84.1 路由简报（D1/D2）

- PRS 输入新增 `<session_state>` 段（**空段不注入**，旧输入字节级不变）：阶段（opening = 尚无成员发言 / ongoing）+ 最近接手者（最近 3 条 agent 消息去重）+ 已有交付件清单（工作区浅扫 ≤30 条 / 600 字符，防重复创建）；
- ROUTE_SYSTEM 增三纪律：复杂度分级（简单直答 1 人 / 多面 2-4 人 / 跨阶段只派第一阶段）、去重（不重复派给最近接手且已交付的角色）、阶段（开场派上游 / 进行中接续不重头）；
- 输出 schema 增 `assignments[].mode`（execute/plan/review）——**软建议**：注入任务便条（「平台建议：先 write_plan 提交规划再动手」）与 trace，**不强制切换范式**（范式仍显式 opt-in）；白名单容错（非法值降级缺省）。

### 84.2 实质进展停滞抑制（D3）

- 新 `write-tracking.ts`：从成功写动作提取目标路径（write_file / edit_file 取 `path`；apply_patch 从 `---/+++` 补丁头解析，a/ b/ 剥离、/dev/null 剔除）——**零文件系统 IO**（不扫描工作区）；波内缓冲按成员归集（`record.waveWrites`），波末结算入 `waveWriteCounts`；
- `detectStall(waveTexts, waveWriteCounts, waveSignatures)`：**同一成员**连续两波零写动作 + 文本相似 >0.9 → 停滞抑制（比内容级循环 4 波更早）；**职责划分**——单人重述 2 波收口，多人轮转重复仍交内容级循环（0.85 / 4 波），两机制不重叠（M3 测试零变化）；有写动作即视为有实质进展（不误伤迭代型协作）；
- `mergeWaveSchedule` 输入增 `waveWriteCounts?`（缺省不检测——既有调用零差异）、输出增 `stallSuppressed`（与 loopSuppressed 同走抑制路径；turn:end 的抑制标记合并二者，TraceDrawer 分开标注「停滞抑制」）；判定在合并层单一收口（ADR 0094 分层）。

### 84.3 并行写冲突防护（D5）与接单回执（D4）

- 波末对波内成员写路径集合两两求交 → 重叠时 `wave:write-conflict` trace + 系统事件条（「并行写冲突提醒：X 与 Y 均修改了 <path>。请收敛方核对合并」；role:system 不进 LLM 窗口、复用 plan-updated 推送通道即时插入）；单成员波 / 无重叠零开销；跟踪失败静默（绝不阻断主流程）；
- 接收方消费交接便条即记 `handoff:accepted` trace（from / count / reason）——交接链闭环审计，纯观测不改调度行为。

### 84.4 链路降级升级（D7）

- 路由失败接手从「编制首位」改为「**场景链首**」在场成员（`fallbackOrder`：按所属场景 chain 位置排序，未在 chain 上者靠后，稳定排序）——上游角色优先接手；降级 trace 形状不变（`fallback: true`）；development chain 下 [backend, qa] 顺序与 M48 既有测试断言一致。

### 84.5 调度指标（D6）

- `RunEventStore.schedulingStats()`：从 run_events 聚合（routing:dispatched 的 fallback 分叉 / wave:start 的 parallel / schedule 的 loopSuppressed·stallSuppressed / wave:write-conflict / handoff:accepted）——**零新埋点**（全部消费既有事件）；
- `GET /api/metrics/scheduling?sinceMs=`（`{ scheduling: SchedulingStats }`）；指标面板新增「调度健康」分区（与 summary 同窗并行拉取，失败静默降级）——路由命中 / 降级、波次与并行、抑制（循环 / 停滞）、写冲突 / 接单四行读数。

### 84.6 验证与口径

- 新增 `m61-dispatch.test.ts` 13 例（写目标提取 / apply_patch 头解析 / 冲突检测 / detectStall 矩阵 7 断言 / merge 集成 3 例 / mode 容错 3 断言 / schedulingStats 聚合 / D5 引擎端到端含系统事件条与 notify）；
- 夹具适配：context 预算 12k → **13.2k**（随资产扩容上调，与 M23→M29 惯例一致）、m3 场景零变化（停滞不拦多人轮转）；
- eval 28/28 ✅；client 876/876 ✅（m9 面板窗口断言适配双端点）；server 定向全绿；E2E 定向 **6/6** ✅（`m48-routing` 2 + `m16-parallel` 1 + `m16-serial` 2 + `m42-roundtable` 1；新构建 42.3s）；
- 编号让位：v58 / ADR 0132 由并发批（头像圆角）占用 → 本批 CHANGELOG **v59** / **ADR 0133** / 本章节。

## 85. 多用户基座——账号认证 · 归属隔离 · 全链路守卫（M57 P1）

本地优先的单信任域架构（共享 `AUTH_TOKEN` / 无归属列 / 全局单例资源 / 无 ACL 通道）扩展为团队可用的多用户体系。设计基线：一体规划 P1/P2/P3；**P1 = 账号 + 硬隔离 + 全链路守卫**（本批落地服务端），决策见 [ADR 0134](docs/adr/0134-multi-user-foundation.md)。

### 85.1 认证与账号

- 数据：迁移 v13 四表 `users`（角色 / 状态 / 首登改密 / 失败计数与锁定）/ `auth_sessions`（令牌哈希 / 双过期 / 撤销）/ `api_keys` / `user_prefs`；
- 密码 scrypt（Node 内置，参数入库）+ 恒定时间比较；会话令牌为不透明随机串（`sa_`，只存 SHA-256），滑动 30 天 + 绝对 90 天；`sid` HttpOnly cookie（`AUTH_COOKIE_SECURE=true` 加 Secure）；CLI 经 `mk_` API Key；
- legacy `AUTH_TOKEN` 保留兼容（映射最早管理员 / 无账号时为合成管理员），带弃用告警；
- 首启：`GET /api/auth/status`（needsSetup）→ `POST /api/auth/setup` 创建首个管理员并**回填存量数据归属**（flushAll → 库内 UPDATE → 清 SessionStore 缓存）；此前为单用户兼容模式（行为与旧版一致）；
- 防爆破：登录 IP 限流（`LOGIN_RATE_LIMIT`）+ 账号失败锁定（`LOGIN_LOCKOUT_THRESHOLD` / `LOGIN_LOCKOUT_MS`，落库）；未知用户名执行哑哈希（防枚举）；
- 账号管理（admin）：创建（邀请制，初始密码仅返回一次）/ 禁用（即时吊销会话）/ 改角色 / 重置密码 / 删除；护栏：至少保留一名启用管理员、不能自禁 / 自删 / 自改角色。

### 85.2 归属与守卫

- 迁移 v14：`sessions` / `projects` / `runs` / `messages` / `approvals.decided_by` / `audit_log(user_id,ip)` / `usage` / `run_events` / `feedback` 归属列；`connections` / `mcp_servers` / `finance_watchlist` 唯一键重建（预留 `scope/owner_id`、`member_use`）；`memory.user_id` 用户维度（global 桶 `owner_id = 用户 id`）；
- `AccessService` 为归属判定唯一事实源；聚合层 `router.use('/sessions/:id')` 一次覆盖全部子资源（消息 / 成员 / 交付件 / 画布 / 媒体 / 日程 / 绑定 / 浏览器），`/runs/:runId` 经 run→session 反查；跨用户一律 404；
- 通道 ACL：WS 订阅逐会话校验（`__` 全局主题仅 admin）；`/api/notifications` 仅返回可见会话；流 token 载荷绑定用户；浏览器 bsid / 媒体任务 / 定时任务补守卫；
- 资源分层：管理面（连接 / MCP / 控制台 / 审计 / 指标 / 设置写）admin-only；成员可在自有会话绑定 `member_use=1` 的 system 连接（列表脱敏）；记忆检索（L1 / L1.5）与自选按用户。

### 85.3 公平性与归因

- `runs.user_id` + `RUN_MAX_PER_USER`（活跃 + 排队）上限；消息限流改按用户（未登录回退 IP）；
- 全量归因：usage / run_events / feedback / messages（人类作者）/ audit_log（user_id + ip）/ approvals.decided_by。

### 85.4 部署基线与后续

- `TRUST_PROXY`（nginx 单跳填 1）使限流 / 审计取真实 IP；TLS 终止在网关（应用不内置 HTTPS），配套 nginx 注意事项见 operations.md；
- 客户端已落地（AuthGate：首启向导 / 令牌入口 / 登录页 / 首登强制改密 / 401 全局回退；账号弹窗：改密 / 用户管理入口 / 登出；管理面仅 admin、成员设置页 = 个人偏好；`/api/auth/preferences` 可写 notifyPollMs）；P2（会话共享协作）已落地（§90 / ADR 0142：服务端角色矩阵 + `/shares` + 客户端共享弹窗 + E2E）；P3（配额 / 个人资源 / BYOK）为后续迭代；测试：`server/tests/m57-multiuser.test.ts` 7 例 + `client/tests/m57-auth.test.tsx` 10 例 + `e2e/m57-auth.spec.ts`（独立实例 8790：首启 → 登录 → 强制改密 → 跨用户隔离 + P2 共享全链路，幂等可重跑）。

### 85.5 文件与工作区布局（u_<uid> 嵌套）

- **新布局**：sandbox 工作区 `workspace/u_<uid>/<sid>/`、git worktree `WORKTREE_DIR/u_<uid>/<sid>/`、画布 `data/canvas/u_<uid>/<sid>.json`；无属主（单用户兼容模式 / 历史数据）继续用平面旧路径；
- **统一解析**：`WorkspaceService.resolveDir` / `canvasFileFor` 为唯一事实源（显式 `workspace_dir` 优先 → 无属主旧路径 → 有属主新嵌套；「新未建且旧存在」兼容回退旧路径）；ArtifactStore / 工具沙箱 / 画布存储均经此解析；
- **搬迁脚本**：`npm run migrate:workspace`（幂等、`-- --dry-run` 预览；仅搬迁有属主会话的 sandbox 目录与画布文件；worktree 不搬迁——既有位置由 `sessions.workspace_dir` 显式记录）；
- **删除账号级联**：`DELETE /api/users/:id` 顺序 = 关浏览器实例（M62）→ `WorkspaceService.purgeUser`（逐会话解除 worktree 注册 → `u_<uid>` 整树 + 旧平面目录/画布清理，全程「根内」安全校验）→ 删库（外键级联）；清理失败不阻断删除，响应回传 `warnings`；
- 测试：`server/tests/m57-workspace.test.ts` 5 例（解析四分支 / 画布回退 / 嵌套存读删与外部根拒删 / purgeUser 不影响他人 / 搬迁幂等 + dry-run）。

- M79-T 登录界面视觉优化（AuthPages）：品牌氛围背景（主/副光晕 + 细网格径向遮罩）+ 徽标品牌区 + 顶部渐变饰条卡片 + 居中头部（大徽章 + 标题 + 副标题）+ 输入框内嵌图标（用户/锁/令牌）与 h-10 圆角规格 + 密码可见切换（tabIndex=-1 不打断键盘流）+ 渐变主按钮（primary→violet + 柔和投影）+ 说明并入卡片底条；四页（登录/首启/令牌/强制改密）共用外壳同步受益；文案锚点 / label / id / role 全保留（m57-auth 单测与 E2E 零破坏）；
## 86. 成员条统一常驻——输入条成员条全场景一致展示 · 撤销席位让位判定（成员条统一批）

用户实测双会话截图对比（谈判 arena 会话 vs 投资研究 dock 会话）红框标注 Composer 上沿成员条区域并追问「为什么有的会话里面有，有的会话里面没有」，随后明确诉求「请统一下 / 所有的对话都需要统一」。本批撤销 M52-G（§78）的「席位覆盖时让位」判定：输入条成员条回归全场景常驻（Composer 常驻操作面），席位维持结构可视化，两者同屏并存。**纯前端批次**（零服务端 / 零资产 / 零协议改动），决策见 [ADR 0135](docs/adr/0135-member-strip-always-visible.md)。

### 86.1 统一口径与展示矩阵

- 口径（用户诉求「所有的对话都需要统一」）：输入条成员条全场景恒展示——arena（含全员入席）/ roundtable / dock / stream / 纯列表一律常驻；§78 的让位判定（`poolHidden`）整体撤销，标题栏头像组移除维持；
- 分工：席位（arena 席位卡 / roundtable 席位环）=「谁在哪个席」结构可视化（随消息滚动区离场）；成员条 = Composer 常驻操作面（@ 召唤 / 状态点 / 排队序号 / 新成员高亮）——并存是操作面 + 结构面双表达。

### 86.2 实现（Composer）

- 删除 `poolHidden` useMemo 与 `resolveStage` / `useSceneStore.listMode` 两处依赖引入；渲染条件回归 `{!disabled && poolSorted.length > 0}`；
- 席位组件零改动；@ 菜单 / 插入链路 / 高亮 / 排队角标逻辑零改动。

### 86.3 测试与门禁

- `client/tests/composer.test.tsx`：原 M52-G describe（4 例）改写为「统一常驻」五态——arena 全员入席（展示且点击插入 @名字）/ arena 部分入席（展示）/ roundtable（新增，展示）/ stream（展示）/ 纯列表（展示）；client 69 文件 / 877 测试全绿（本批窗口值，窗口内含并发批次增量）；全仓 typecheck 0 错误；改动文件 ESLint 0 错误（1 条存量 warning——apiPost 未使用，非本批引入）；client build 通过（本批窗口产物 `index-BqaYPHmG.js` 1,276.21 kB）；check:agents 114/114 达标 / check:skills 51/51；eval 28/28 ✅；
- E2E：`m52-stage` 21/22（唯一失败 = 融资资本 dock·console 收尾 trace ENOENT 基建抖动——该场景成员条改前改后同为展示，隔离复跑 1/1 通过）+ `m43-pk` 2/2 ✅（arena 辩论场 / 谈判桌——与本批最相关场景全绿）；补跑窗口遭遇并发会话 server 中间态（`ERR_ERL_KEY_GEN_IPV6`，M57 改动域）与 test-results 并发清理，判定非本批回归；
- 文档：本页 §86、ADR 0135、`docs/adr/README.md` 索引（0126 → Amended）、§78 修订注记、`agents/CHANGELOG.md` v66。

## 87. 场景交互深化——arena parts 精细化与首批场景声明（场景深度优化批）

用户要求「当前所有的场景深度优化（含交互）」：对 29 场景 × 四形态 × 六面板 × 12 元件做全量走查，处理发现的真实缺口。本批聚焦 arena 形态的 **parts 机制名实漂移**与**场景语义瑕疵**（纯前端 + 资产声明，零服务端逻辑改动）。

### 87.1 走查结论与缺口

- 形态面：5 stream / 18 dock / 4 roundtable / 2 arena——dock / roundtable 的交互链（拖宽 / 折叠 / 抽屉 / 席位回填 / 议程定位）与空态链（guide + agenda chips + 成员 chips）经走查完整无缺口；
- **缺口一（名实漂移）**：`PART_NAMES` 登记 12 个「幽灵」parts 名，实际受 parts 控制的仅 ArenaStage 的四个区块（scoreboard / round-track / verdicts / insights），`partEnabled` 导出零消费；
- **缺口二（语义失真）**：negotiation 无「胜负计分」语义，但 Scoreboard 恒显（0:0 / 未开赛）；debate 无「报价」语义，insights 一坨耦合导致声明无法裁剪报价流。

### 87.2 实现口径

- insights 拆分为 `claim-tree`（论断树）与 `offers`（报价流）两个独立 parts；`verdicts` 修正单复数（原登记 `verdict`）；
- `PART_NAMES` 收敛为 arena 五件套（round-track / scoreboard / verdicts / claim-tree / offers）；ArenaStage 的 `on()` 改用 `partEnabled`（单一事实来源）；
- 数据属性契约不变（`[data-insights]` / `[data-insight="claims"|"offers"]`）——既有组件级测试零改动。

### 87.3 场景声明（首批落地）

- `debate`：`parts: [round-track, scoreboard, verdicts, claim-tree]`（对齐 scene-expansion §7.8 原意；辩论无报价流）；
- `negotiation`：`parts: [round-track, verdicts, claim-tree, offers]`（**去 scoreboard**——消除恒显 0:0；报价流为谈判核心）；
- `invest`：不声明（多空对弈全要素默认集）——向后兼容，未声明场景行为不变。

### 87.4 验证

- client 全量 **888/888 ✅**（m52-stage +1：negotiation 无 scoreboard 保报价流 / debate 保 scoreboard 无报价流）；m43-cards（数据属性契约）与 m60-arena-live 零改动通过；
- 向后兼容：invest / 无 parts 声明夹具全启用等价；E2E（m43-pk / m52-stage）不受影响。

## 88. 上下文电池格条——用量条收编 Composer 底栏（上下文电池批）

用户实测截图（谈判 arena 会话）红框标注主区顶部「上下文 8% 15.7k / 200.0k tokens」横贯用量条，诉求「上下文不在 header 中展示，放到下方使用像电池容量的效果进行展示，优化设计下」；初版「壳体 + 连续填充」实现后，用户以参考图（5 段横条格条）反馈「不是完全按照电池展示，像这种」，同日修订为格条形态。本批为**纯前端批次**（零服务端 / 零资产 / 零协议改动），决策见 [ADR 0137](docs/adr/0137-context-battery-in-composer-footer.md)。

### 88.1 实现口径

- 位置迁移：`AppLayout` 删除主区头部通栏渲染（`mainTab === 'chat' && <ContextBar />` 与 import 一并移除）；`ContextBar` 改挂 `Composer` 底栏提示行右侧（`ml-auto` 右对齐），随输入区常驻；
- 电池格条（参考图样式）：5 段等宽横条纵向堆叠（每段 `h-[2px] w-5`、间距 `1.5px`、微圆角），`flex-col-reverse` 自下而上逐格点亮，无壳体无触点；点亮段数 = `⌈水位 × 5⌉`（非零水位至少 1 格）；百分比与 token 数值（如 `15.7k / 200.0k`，`sm` 以下隐藏数值仅留百分比）；
- 颜色分级：点亮段 < 70% emerald / 70–90% amber + 百分比变色 / ≥ 90% rose + 整组 `animate-pulse` 呼吸；未点亮段低对比灰（hover 微提亮）、点亮段 300ms 过渡；点击开上下文抽屉；
- 入口保留：title = `上下文 {pct}%（{estimated} / {budget} tokens）· 查看上下文分层与摘要`（保留原 E2E 选择器子串）；「本 Run 费用」与「轨迹」按钮同排保留在格条右侧；「已降级」徽标随格条显示；
- 取数零改动：会话切换 / 运行结束 / 压缩事件 / 点击刷新（`/api/sessions/:id/context` + `/api/runs/:id/usage`）。

### 88.2 验证

- client 全量 **888/888 ✅**（composer / m33 补 fetch 常挂起 stub、m24 `mockApi` 对 context / usage 端点挂起——电池挂载即取数，避免真实网络与 act 警告；m25 抽屉口径断言零改动）；
- 浏览器实测（DOM 核验）：页签行下无横贯条（`progressbar` 计数 0）；底栏右侧 5 段格条自下而上点亮（低水位 1 格绿色）、百分比 + token 数值右对齐无重叠；
- E2E：`m25-memory.spec.ts` 标题点击路径不变（子串匹配）；无位置依赖断言。

## 89. 多用户浏览器资源治理——实例隔离 · 页面分治 · 配额回收 · 连接线治理（M62）

M57 P1（§85 / ADR 0134）落地账号与归属守卫后，浏览器子系统仍按「单信任域、单机单用户」假设运行：Profile 全局共享（local 复用可跨用户接管登录态）、同实例多会话抢页、关闭链路断裂（`closeForSession` 无调用方）、无配额 / 无空闲回收 / 无启动对账（僵尸行 + 临时目录 + 无主进程三重残留）；连接线三处失真（remote 无租约 / 重连端点固化 / 健康状态不回写）、最小权限缺口（绑定与 `member_use` 未复核启动）。本批按 M62-A/B/C 一次性落地，全部治理以「owner 存在」为开关（兼容模式零变化）。专项设计见 [docs/browser-multiuser-design.md](docs/browser-multiuser-design.md)，决策见 [ADR 0139](docs/adr/0139-multiuser-browser-instance-governance.md) / [0140](docs/adr/0140-browser-connection-line-governance.md) / [0141](docs/adr/0141-browser-instance-observability.md)（编号让位：ADR 0137 / §88 已被上下文电池批、ADR 0138 已被画布 UX 批占用，原预定 0137–0139 / §88+ 顺延为 0139–0141 / §89）。

### 89.1 归属与 Profile 隔离

- 多用户 Profile 根 = `<dataDir>/browser-profile/u_<userId>/`（admin 同独立）；兼容模式沿用旧布局（零迁移）；`LaunchOptions.profileRoot` 语义不变（runtime 决策传入）；
- 实例注册表 `.ma-instance.json`（端点就绪写入：`browserSessionId / sessionId / userId / backend / pid / endpoint / headless / startedAt`）：崩溃恢复（pid 归属校验）、观测、复用归属防御（`userId` 不一致 → 拒绝接管并给可操作错误；缺失按既有语义放行）。

### 89.2 页面分治（同实例多会话）

- runtime 占用表 `endpoint → targetId → browserSessionId`；同端点已有其他活跃会话 → 新会话 `Target.createTarget` 自建管理页（`forceFreshTarget`）；
- `isForeignTarget` 三路径过滤：新页事件 / 空白页观察 / 回退候选——他人管理页永不接管；会话关闭 / 切页 / 管理页销毁均经 `onPageChange` 释放登记；
- 无隔离需求时保持 `attachToPage` 旧路径（ADR 0051 跟随语义与既有测试零改动）。

### 89.3 配额与空闲回收

- `BROWSER_MAX_PER_USER`（3）/ `BROWSER_MAX_TOTAL`（8）/ `BROWSER_IDLE_CLOSE_MS`（30min）/ `BROWSER_RECLAIM_INTERVAL_MS`（60s），0 = 不限 / 不回收；
- 超限先回收本用户空闲实例再拒绝（错误含当前值与出路）；检查点 = 新建实例前（复用不拦截）；
- 回收判定 = `ready` + `agent` + 非 busy + 无帧流订阅者（`subscriberCount`）+ 距最近活动（`lastActiveAt`）超阈值；`awaiting_human` / `human` / 兼容模式三重豁免；回收广播 `closed` 原因（面板提示再调用自动重启）。

### 89.4 生命周期闭环

- 关闭链路：会话删除 → `closeForSession`；用户删除 → `closeForUser`（含 DB 兜底行）；`shutdown` 补 `close_reason`；调用点带 `?.` / catch 容错（最小测试夹具未装配 browser 时跳过）；
- 启动对账 `reconcileOnStartup`：僵尸行（`closed_at IS NULL`）→ `service_restart`；注册表 pid 存活且 `ps` 命令行含 `--user-data-dir=<dir>` 才终止（SIGTERM → 2s → SIGKILL）；`managed-*` 目录删除、`local` 目录保留（仅清注册表与残留 `DevToolsActivePort`）；
- 迁移 v15：`browser_sessions` + `user_id` / `close_reason`（回填自 `sessions.owner_id` 并立索引）；`BrowserSessionInfo` 增可选 `ownerId` / `closeReason`。

### 89.5 连接线治理

- remote 独占租约（`conn:<id>` / `endpoint:<ws>`；占用者活跃才拒绝；`config.shareInstance=true` 显式放开）；
- 重连端点再解析：`resolveEndpoint` 注入（remote http(s) 重探 / local `DevToolsActivePort` 重读），失败回退固定端点；成功换端点更新内存与 DB；不引入进程级自动重启（ADR 0120 承袭）；
- 连接健康回写：启动 / 解析 / connect / start 失败与重连耗尽 → `error` + `lastError`；成功接入与自动重连成功 → `ok`；正常关闭不回写；30s 节流；
- 最小权限复核：`enabled` + 会话绑定（未绑定给绑定指引）+ 成员 `member_use`（admin 豁免），与 db / mcp 口径对齐；
- 帧流线：`StreamHub.subscriberCount` + 同用户 takeover 流转（`takeover_moved` 降级 watch；跨用户 `takeover_busy`；兼容模式沿用单持有者拒绝）。

### 89.6 观测与 UI

- `GET /api/browser/sessions`（admin）：归属 / 后端 / 状态 / URL / 空闲时长 / 订阅数（`listDetailed` 单一数据源）；
- 连接控制台「实例」页签（admin 可见，成员隐藏且不请求）行内关闭；`BrowserPanel` 复用徽章与空闲关闭文案对齐；
- 回放归属修复：已关闭 bsid 按库内 `user_id` 判定——成员可回看自己历史步骤 / 截图（此前仅 admin）。

### 89.7 验证

- server 全量 **1134/1134 ✅**（新增 `browser-multiuser` 11 例：归属隔离 / 复用防御 / 配额与回收豁免 / 关闭链路 / 启动对账 / 租约与最小权限 / 健康节流 / 页面分治 / 端点再解析 / 帧流流转；`browser-*` 六文件全绿）；
- client 全量 **892/892 ✅**（新增 `m62-browser-instances` 2 例：admin 实例页签与关闭 / 成员隐藏且不请求）；
- 四包 typecheck 0 错 / lint 0 错（既有 warning 基线）/ `npm run build` 通过；
- 兼容模式零变化：断言进 `browser-multiuser`（旧路径 / 旧语义）与既有 6 套件回归。

## 90. 会话共享协作——共享成员 · 角色矩阵 · 署名与可见性（M57 P2）

P1（§85）之后团队成员仍只能各看各的会话；本批引入会话级共享（owner / editor / viewer），把「同一份会话多人协作」纳入权限模型。决策见 [ADR 0142](docs/adr/0142-session-sharing-collaboration.md)。

### 90.1 数据模型与授权

- 迁移 v16 `session_members(session_id, user_id, role[editor|viewer], invited_by, created_at, updated_at)`（PK = 会话+用户；外键 CASCADE：删会话 / 删账号自动清理）；
- owner 不进表（仍由 `sessions.owner_id` 承载）；`AccessService` 扩展为角色唯一事实源：`sessionRole`（owner / editor / viewer / undefined）→ `canWriteSession`（owner / editor）→ `assertSessionWrite`（404 / 403）与 `assertSessionOwner`（仅属主）；单用户兼容模式全部放行（行为零差异）；
- `SessionStore.listForUser`（本人 + 共享，逐行标注 `role`）与 `search` 访问口径同步扩展；WS 可见集 / 通知降级轮询经 `visibleSessionIds` 自动覆盖共享会话。

### 90.2 路由与守卫

- 聚合守卫改为 `createSessionAccessGuard`（`auth/guards.ts`；测试可直接挂载）：读 = owner ∪ 成员（无权限 404）；写（非 GET/HEAD/OPTIONS）= owner / editor（viewer 403），唯一例外 `POST /sessions/:id/leave`（viewer 可自助退出）；`/runs/:runId` 守卫加 `assertRunAccess`（按方法施加写校验：停止 / 审批对 viewer 403）；
- 新路由 `/sessions/:id/shares`（GET 任何可见者 / POST·PATCH·DELETE 仅属主）与 `POST /sessions/:id/leave`；错误口径：未知账号 404、已在成员 409、邀请自己 / 属主 400、非成员移出 404；`DELETE /sessions/:id` 收紧为属主专属；
- 副作用：审计 `session.share-add|update|remove|leave` + 广播 `notify:share-changed`（payload `{ sessionId, userId, action, role? }`）。

### 90.3 上下文署名与验证

- 共享会话（成员数 ≥1）的人类消息在上下文装配中署昵称（`【Alice】…`；`ContextService.userLabelResolver` → assembler `userLabel`），独占会话 / 兼容模式沿用 `【用户】`（零差异）；M57 P3 收口：**压缩摘要 / 记忆沉淀输入文本同步署昵称**（`renderForSummary` / `renderForDigest` 接同一 `createUserLabelResolver`，缺省仍「用户」）；
- 测试：`server/tests/m57-p2-shares.test.ts` 5 例（HTTP 生命周期：邀请→editor 写→viewer 403→leave 404；属主专属与邀请校验；列表 role / 搜索 / WS 可见集 / 审计；署名装配；兼容模式），server 全量 **1139/1139 ✅**（86 文件）；四包 typecheck 0 错；
- 客户端已落地：会话头部「共享」入口（属主「共享」/ 成员「已共享 · 可协作 / 只读」徽章态）→ 共享弹窗（成员列表 + 角色切换 + 移出 + 邀请表单；成员可自助退出）；会话列表非属主会话带「协作 / 只读」徽章且按角色隐藏重命名（viewer）/ 删除（非 owner）；列表预览署名（他人人类消息显示昵称，`lastMessage.userId/userName` 服务端投影；自己 / 兼容模式仍「你」）；viewer 命中 ChatArea 横幅 + Composer 锁定（服务端 403 的前置提示）；消息气泡人类署名（他人消息显示昵称；`GET /sessions/:id` 响应新增 `humanNames` 投影，兼容模式仍为「你」）；`notify:share-changed` 入 ws-store（刷新列表；当前会话已不可见 → 清空并提示；面板正打开则同步刷新）；测试 `client/tests/m57-shares.test.tsx` 7 例（store 全链路 / 弹窗三视图 / 署名两分支 / ws 分支）全绿；client 全量 76 文件 942 例中 941 通过（唯一失败为并行 M31 媒体改版遗留旧测试，与本批无关）；E2E `e2e/m57-auth.spec.ts` 第二用例（邀请→协作徽章→转只读锁→移除，双上下文，幂等可重跑，本地 2/2 ×2 验证）。

### 90.4 连接最小权限复核（SSH / 数据库，同批收口）

- 缺口：绑定侧闸门（成员仅可绑 `member_use=1` 的 system 连接）不覆盖「admin 在会话里绑定未开放连接 → 会话共享给成员」与「member_use 事后撤销」两条路径；
- 执行侧复核：`createConnectionUseGuard`（connections/access.ts）以「本 Run 触发者」（`RunRecord.triggerUserId` ← 触发用户消息 `userId`）判定：兼容模式 / admin / 未知触发者（历史 run、系统触发）放行；成员仅放行 `member_use=1` 的 system 连接；`ssh_exec` / `db_schema` / `db_query` / `db_execute` 在解析连接后调用守卫，`db_list_connections` 对不可用连接标注「（未对成员开放，不可用）」；
- 归因：`DbExecInput` / `SshExecInput` 增 `actorUserId`，`ssh.exec` / `db.*` 审计补 `userId`（触发者）；
- 顺带修复（同一根因）：工具只读结果缓存键收紧为 `sessionId:triggerUserId:tool:args`——原键无会话 / 用户，跨会话或共享会话内同参调用会命中他人缓存而绕过复核（本回合同会话同用户仍正常去重）；
- 测试：`server/tests/m57-p2-conn-guard.test.ts` 5 例（守卫单元 / db_query 拒绝不执行与开放库真跑 / db_list 标注 / ssh 越守卫证伪 / 共享会话触发者口径）；server 全量 **1144/1144 ✅**（87 文件）。

### 90.5 全量隔离审计与归因补齐（同批收口）

- **审计归因补齐**：`mcp.*`（10 处：create/update/delete/test/reconnect/refresh/json-sync/json-import/bind/unbind）补 `userId` + `ip`（`actorOf`）；浏览器 runtime 的 `browser.start/attach/close` 审计补 `userId`（会话属主，与 detail.owner 双记录）；
- **全量巡检结论**（HTTP / 通道 / 工具 / 文件系统四层）：单用户兼容模式零差异；隔离面无新增缺口；剩余为计划内未做项（P3 个人资源与配额）；
- 测试：server 全量 **1146/1146 ✅**（87 文件），四包 typecheck 0 错。

## 91. 快捷键帮助 Tab 分组重设计——四组页签 · 说明块归位 · 键位表补齐（快捷键帮助 Tab 化批）

用户实测截图（红框：顶栏键盘按钮与弹出的「键盘快捷键」长列表）诉求「优化下，使用tab进行分组管理，重新设计优化下」——原 M12 面板四个分组纵向通铺于一屏：画布组超出视口后整层滚动、行标签单行截断（`truncate` 截掉适用说明）、可替代组合与同组合多键键帽平铺语义混淆、「指派语义」说明块底部常驻与输入语境割裂。本批为**纯前端批次**（零服务端 / 零资产 / 零协议改动；入口与 `ui-store.helpOpen` 契约零变化），决策见 [ADR 0143](docs/adr/0143-shortcut-help-tabbed-redesign.md)。

### 91.1 实现口径

- 分组页签：通用 / 输入框 / 审批卡 / 画布四组等宽页签（图标 + 标签；Radix Tabs 键盘可达），一次只呈现一组、非当前组不挂载；内容区 `min-h-[232px]` + `max-h-[52vh]` + 内部滚动（短组不塌陷、画布长组组内滚动）；
- 行结构升级：`keys: string[]` → `combos: string[][]`（外层 = 可替代组合，渲染以「/」分隔；内层 = 组合键，相邻键帽）＋ 可选次行 `note`（适用条件小字，取代原单行 `truncate`）；
- 说明块归位：「指派语义」迁入「输入框」页签（主色强调块，`AtSign` 图标）；「审批卡」页签补审批流语义块（批准 → 成员继续执行；拒绝 → 改换方案；附反馈提交 → 模型据此调整）；
- 键位表补齐（一律以代码绑定为准）：画布组新增「删除选中节点 / 连线」（Backspace · Delete，React Flow `deleteKeyCode`）与「保存并提交画布文档」（⌘S，`store.flush()`）、撤销 / 重做补 ⌘Y 备选；输入框组新增「关闭候选 / 清空命令」（Esc）＋候选补全适用说明（弹层打开时 Enter 为补全而非发送）；通用组「快捷键帮助」补 ⌘⇧/ 备选；
- 头部信息带与 a11y：图标徽章 + 标题 + 副题（「⌘ = Ctrl（非 macOS）· ? 键随时呼出，Esc 关闭」）＋ `DialogDescription` 补齐；页签选择组件内记忆（关闭重开停留上次分组）。

### 91.2 验证

- 单测：`client/tests/shortcut-help.test.tsx` 重写 5 例（显隐驱动 / 默认「通用」页签且非当前组不挂载 / 切「输入框」见候选键与指派语义 / 切「审批卡」「画布」/ 页签记忆）全绿；
- E2E：`e2e/m12-interactions.spec.ts` 步骤 1 更新为「`?` 打开 → 断言默认页签与通用键 → 切「输入框」断言指派语义 → 切「画布」断言画布组」，页签定位收敛于 `page.getByRole('dialog')` 作用域（避免与主区「画布」Tab 重名冲突）；实跑 1/1 ✅（生产构建单端口托管形态）；
- 视觉核查：隔离 harness + Chromium 2x 截图逐页签复核（键帽换行 / 留白 / 说明块排版无重叠）；client typecheck 0 错、ESLint 0 报错。

## 92. 研讨型渲染包——五容器族 · 汇聚板专业化 · 资产输出约定（M38）

全场景深度优化批一的 P0 落地：`docs/scene-chat-design.md` M38 原案（自 M37 起「规划待评审」）的容器族与汇聚板愿景全量兑现——点开全场景优化总账（批一：研讨域 brainstorm / research / strategy / society）。决策见 ADR 0144（容器族与汇聚板）与 ADR 0145（点亮本地互动态）；编号让位：原预定 ADR 0066–0068 → 实际 **0144–0145**，design.md 原预定 §53 → 实际 **§92**。

### 92.1 五容器族（remark-ext + 五卡片）

- `::: idea [N] 标题`——点子卡（IdeaCard）：字段行 / 条目同 pan 口径；字段「状态：候选 | 入选 | 被毙」→ 状态徽章（`IDEA_STATUS_MAP`，未命中无徽标）；「点亮」本地计数（`ma:sc:lights:<sessionId>`，ADR 0145）+「深入」回填草稿；
- `::: phase 阶段名`——阶段分隔条（PhaseBar）：发散 / 探索 → 暖色，收敛 / 评审 / 收口 → 冷色（`data-tone`），其余中性；消息流时序语义、不入卡墙；
- `::: score [标题]`——评分卡（ScoreCard）：条目 `- 名称 | 影响 8 | 信心 5 | 易度 7`；总分缺省 = 子项乘积（ICE 口径，与 refiner / facilitator 资产及 mock 先例 8×5×7=280 逐字一致），显式「总分 / 合计」列优先；按总分降序 + 条形归一；
- `::: sources [标题]`——来源卡组（SourcesCard）：条目 `- 标题 | URL | 日期 | 要点 | 高|中|低`（列可缺省、容忍裸 URL 与 markdown 链接）；域名 chip（去 www）+ 可信度徽章（高 / 中 / 低可信）；「引用」回填草稿；
- `::: decision [标题]`——决议卡（DecisionCard）：字段行「背景 / 决策 / 后果」按三要素排序（其余字段排后）；「确认拍板」回填草稿；
- **单一解析实现**：`parseIdeaArg / ideaStatusOf / parseScoreLines / parseSourceLines / domainOf` 自 remark-ext 导出，remark 收尾（mdast 扁平文本）与场景面板（容器原始行，双重剥离列表标记）共用——防双实现漂移；
- fail-safe 降级链不变式：未知容器名 / 游离闭标记保持原文；未闭合去壳展开；无有效条目 → `data-raw` 静态兜底；流式期间轻结构容器直接渲染。

### 92.2 汇聚板专业化（pool 面板）

- `idea / score / sources / decision` 与消息流**同组件渲染**（面板条瘦身：头像 + 类型徽标 + 定位按钮；卡片自带标题——避免双层壳体与标题重复）；
- `phase` 不入面板卡墙（分隔条语义）；其余容器名沿用通用卡墙（含 `::: ideas` 复数兼容路径）；
- 逐场景空态文案：brainstorm「点子将汇聚在这里」/ research「来源与证据将汇聚在这里」/ strategy「决议与矩阵将汇聚在这里」/ society「立场与事实将汇聚在这里」+ 中性默认；
- 点亮跨实例同步：`useSceneLights(sessionId)` 同源 hook（IdeaCard 自持 / PoolPanel 注入 litOverride + onToggleLight），`LIGHTS_EVENT` 事件广播（ADR 0145）。

### 92.3 资产与 mock（容器格式写入资产是面板出现的前提）

- 三份场景协议新增「渲染容器约定」段：brainstorm（点子编号 / 状态枚举 / 阶段条 / ICE 评分，条目 12–14）、research（来源五列 / 论断三分与置信度，条目 9–10）、strategy（决议三要素 / 权衡矩阵与显式总分，条目 10–11）；
- 5 个 AGENT.md「工作方式」各加一行输出约定：facilitator（phase）、ideator（idea）、refiner（score）、scout（sources）、chief（decision）；
- mock 三组触发块（唯一触发词「点子走查 / 来源走查 / 决议走查」，同 M37 checklist / M54 pan 先例；块内不写 @）：facilitator→phase、ideator→idea×2、refiner→score、scout→sources、verifier→claim、chief→decision。

### 92.4 验证

- 单测 / 组件测：`client/tests/m38-cards.test.tsx` 21 例（纯函数解析 / 五容器渲染与交互 / fail-safe / 汇聚板专业化与逐场景空态 / 点亮持久化）；受影响既有套件 `markdown-ext / m52-stage / m43-cards` 141 例全绿；
- E2E：`m16-brainstorm.spec.ts` 新增 M38 用例（阶段条 / 点子卡 ×2 / 评分卡 + 汇聚板沉淀 + 点亮与深入回填）与新增 `m38-research.spec.ts`（来源卡 / 论断卡 + 来源墙 + 引用回填）实跑通过；`playwright.config.ts` main 项目 testMatch 补 `m38-.*`；**全量 E2E 90/90 ✅**（8.6m，含并发批次增量）
- 回归门禁（本批收口实测）：server **1156/1156 ✅**、client **77 文件 951 例 ✅**（首轮 1 例 `m31-media` 属并发会话中间态假失败——隔离复跑与全量复跑均绿）、eval **32/32 ✅**（零回归）、`QUALITY_STRICT` check:agents **114+29 ✅** / `SKILL_STRICT` check:skills **51/51 ✅**、四包 typecheck 0 错、build 通过（主包 `index-DvMYoLdV.js` 1,322.77 kB / gzip 377.23 kB——含并发批次合流，点记录）；
- 资产门禁：`check:agents` 114/114 + 协议 29/29（新增段落不破坏质量红线 / 失败模式结构）；mock-coverage 四件套 4/4；
- 工程红线：单一解析实现（面板与消息同源）；容器内不写 @；冻结口径（ADR 0114）与回填语义（ADR 0064）零变化；零服务端逻辑改动（mock 仅增量触发块）。

## 93. 用户配额与用量看板——并发 · 日 token · 月成本 · 会话 · 存储（M57 P3-1）

P1/P2 完成后多用户体系具备隔离与协作能力，但资源消耗仍无人约束：单个成员可以无限建会话、无限跑任务、无限上传。本批落地配额体系（按用户覆盖）+ 用量看板（个人 + admin），决策见 [ADR 0147](docs/adr/0147-user-quota-and-usage.md)。

### 93.1 数据与强制点

- 迁移 v17 `user_quotas`（五列均可空：max_concurrent_runs / daily_tokens / monthly_cost_usd / max_sessions / max_storage_mb；无行 = 全部不限，兼容模式零变化；全空行自动清理）；
- `QuotaService`（quota/service.ts）为限额与用量的单一事实源：
  - **并发**：`limitsOf` 将用户配额与系统 `RUN_MAX_PER_USER` 取小；Engine.assertUserCapacity 消费（路由层 400 文案不变）；
  - **日 token / 月成本**：Engine 波次边界 `blockedReason` 闸门（基于 `usage.user_id` 当日 / 当月聚合）——超限时落系统事件条（与并行写冲突提醒同通道）并以 `run:end reason='quota'` 收束本 Run；
  - **会话数**：`POST /api/sessions` 前置断言（超限 403 中文文案）；
  - **存储**：附件 / 画布素材上传前置断言（工作区目录体积 + 本次增量，目录遍历带上限提前退出）。
- 用量聚合新增 `usage.sumByUser(userId, sinceIso?)`（时间窗可选）；`sessions.countForUser` 直查库（避免列表消息聚合开销）。

### 93.2 接口与客户端

- `GET /api/usage/me`（个人用量汇总 + 生效限额；兼容模式 userId 空串 → 前端隐藏）；
- `GET/PUT /api/users/:id/quota`（GET = admin 或本人；PUT = admin，null 清除该项，审计 `auth.quota-set`）；`GET /api/users/:id/usage`（admin）；
- 客户端：用户管理台行内「配额」按钮 → `QuotaDialog`（用量四指标 + 五项配额编辑，留空 = 不限）；个人设置页「我的用量」卡（今日 token / 本月成本 / 会话 / 存储，含限额分母；无上限时提示不限）；
- 语义细节：并发取小（三处同名口径统一）；日/月重置按**服务器本地时区**；金额 = LLM_PRICING_JSON 估算值；存储 MB 一位小数（上限未设时按 512MB 安全帽提前退出计数）。

### 93.3 验证

- 服务端 `tests/m57-p3-quota.test.ts` 8 例（QuotaStore 部分写入 / null 清除 / 全空行清理；limitsOf 取小；blockedReason 三态；会话闸门；上传闸门与 usageOf 汇总；HTTP：usage/me · 配额 PUT 成员 403 · admin 生效与审计 · 建会话 403；引擎：波次闸门 reason=quota + 系统条 / 无配额零生效）；
- 客户端 `tests/m57-p3-quota.test.tsx` 4 例（用量卡两态 / 配额弹窗回填与 null 提交 / 非法输入拒绝）；
- 全量：server 88 文件 1164 例 ✅ / client 78 文件 955 例 ✅ / 四包 typecheck 0 错。

## 95. 个人资源——personal 连接与成员可用开关（M57 P3-2）

§93（配额）之后，成员仍只能使用管理员开放的 system 连接；本批开放「成员自建个人连接」与「system 连接成员可用开关」两件事（v14 的 scope/owner_id 列启用，零迁移），决策见 [ADR 0148](docs/adr/0148-personal-connections.md)。

### 95.1 语义与数据

- `scope='personal' + owner_id`：仅属主可见 / 可用（自建自管）；system 连接新增 `member_use` 开关（默认 true = 保持旧行为）；
- `ConnectionDefinition` 增 `scope / ownerId / memberUse`（旧库 NULL → system / 可用，兼容零变化）；唯一索引 `(scope, owner, name)` 自 v14 已存在。

### 95.2 授权（四层保持一致）

- **列表**：成员 = 可用 system（config 脱敏）+ 本人 personal（config 完整，自管需要）；admin = 全量；
- **资源级守卫** `ownerOrAdmin`（详情 / 编辑 / 删除 / 测试 / SSH 终端签发 / 工作台 schema·sql·表数据）：admin 或属主；system 连接对成员一律 404（不泄漏存在性）；
- **执行侧**（createConnectionUseGuard）：成员 = member_use=1 system ∪ 本人 personal；浏览器 runtime 同口径（`connections.ownerOf` 比对会话属主）；会话绑定路由同口径；
- **开关生效**：admin 关 member_use 后，成员列表中即刻消失、绑定 403、已有绑定的工具调用被执行侧拦截；
- **删除账号级联**：`removePersonalOf`（connections.owner_id 无 users 外键，需显式清理；会话绑定行随 connection 外键自动清理）；成员创建 embedding/media 连接 403（全局单例，指引找管理员）。

### 95.3 客户端

- 成员：个人设置「我的连接」卡（列表 + 新建 / 编辑 / 删除；sqlite / postgres / mysql / ssh 紧凑表单；凭据加密留空 = 不修改）；建好后在**会话头部「资源」入口**绑定即可被 Agent 工具使用（M57 P3 收口：会话资源弹窗补齐成员自助绑定面）；
- 管理：连接编辑器新增「允许成员使用」开关（memberUse）；
- 兼容模式：个人连接卡不渲染（单用户走连接管理中心，行为零变化）。

### 95.4 验证

- 服务端 `tests/m57-p3-personal.test.ts` 5 例（Store：personal 创建 / listForUser / ownsPersonal / ownerOf / removePersonalOf 绑定级联 / memberUse 开关；执行守卫三态；HTTP：成员创建 → personal / 媒体 403 / 列表区分与脱敏 / 他人与 system → 404 / 成员改自有连接且 memberUse 被忽略 / 绑定 / memberUse 关闭后不可见且绑定 403）；server 全量 **89 文件 1169 例 ✅**；
- 客户端 `tests/m57-p3-personal.test.tsx` 4 例（列表过滤 / 新建 payload / 删除刷新 / 设置页门控）；
- 四包 typecheck 0 错；lint 0 错（本批文件）。

## 96. 模型直连（BYOK）——用户自带 LLM 凭据 · 按会话属主解析 · 成本归因（M57 P3-3）

§95（个人连接）之后，模型与 Key 仍是全团队共享的系统配置：成员无法使用自己的模型额度，也无法按人区分用量成本。本批落地 BYOK（Bring Your Own Key），决策见 [ADR 0153](docs/adr/0153-user-byok-llm.md)。

### 96.1 数据与解析

- 迁移 v18 `user_llm_credentials`（user_id PK，base_url / model 可空，secret_enc 必填；SecretVault 加密，密钥永不回显 / 永不出库；删除账号随 users FK 级联）；
- `ByokProvider`（llm/byok.ts）包装系统 provider：请求携带 `sessionId` → 会话属主配置了 BYOK → 用其凭据（每用户独立 provider 实例 = 独立限流闸门与韧性层）；无凭据 / 无会话 → 直通系统默认；`LLM_MOCK=true` 恒直通（E2E 确定性）；
- 解析覆盖全部模型调用点（均带会话上下文）：引擎回合（`ChatRequest.sessionId`）/ 压缩摘要 / 记忆沉淀 / 脑图生成；baseUrl / model 留空 = 分别跟随系统默认。

### 96.2 成本归因与接口

- 归因：`ByokProvider.modelFor(sessionId)` 注入引擎（`billingModelFor`）与压缩器——`usage.model` 记录**实际生效模型**，按 `LLM_PRICING_JSON` 各单价计费（无凭据 = undefined → 回退系统模型，零变化）；
- 接口（自助）：`GET /api/auth/llm-credentials`（状态投影，绝不含密钥；兼容模式 configured=false）、`PUT`（apiKey ≥8 必填 / baseUrl http(s) / model 可选；审计 `auth.llm-credential-set`）、`DELETE`（清除恢复系统默认；审计 `auth.llm-credential-clear`）；变更即失效 BYOK 缓存（下次调用重建）；
- 客户端：个人设置「模型直连（BYOK）」卡（状态徽章 / 地址·模型回显 / 更新凭据 / 恢复系统默认；仅多用户模式渲染）。

### 96.3 验证

- 服务端 `tests/m57-p3-byok.test.ts` 5 例（Store 加密往返 / status 不含密钥 / 清除；ByokProvider 四分支 + 缓存与 invalidate + Mock 直通 + modelFor；HTTP：GET 默认 / PUT 不回显密钥与审计与 onChange / 短 Key 与非法地址 400 / DELETE 清除 / 兼容模式 400）；server 全量 **90 文件 1174 例 ✅**；
- 客户端 `tests/m57-p3-byok.test.tsx` 3 例（表单与 payload / 已配置回显与清除 / 校验拒绝）；
- E2E `e2e/m57-auth.spec.ts` 第三用例（P3 收口）：配额闸门（admin 设 `maxSessions=1` → bob 第 2 会话 403 + 文案）；bob 设置页「我的用量 / 我的连接 / 模型直连（BYOK）」三卡在位；幂等自清理（起清配额、清自有会话，终删会话 + 复清配额）；
- 并发验证隔离：`playwright.config.ts` 新增 `outputDir: process.env.PW_OUTPUT_DIR || 'test-results'`（并行会话不复用同一 trace 目录，消除 ENOENT 假失败）+ auth 实例 `LOGIN_RATE_LIMIT=300` 余量；隔离后 3 连跑 3/3 ✓；
- 四包 typecheck 0 错；文档：api.md §21、operations §4.13。

## 97. 生产型渲染包——阶段映射 · 工序卡族 · 场景工具卡 · 波次网格（M39）

全场景深度优化批二的 P0 落地：`docs/scene-chat-design.md` M39 原案（工程型四场景 development / bi / sre / marketing）全面兑现。决策见 ADR **0149**（阶段映射表 / 悬浮条场景化 / 波次网格）、**0150**（场景工具卡变体与工具记录 meta 扩增）、**0151**（工序卡 / 验收单 / 复盘容器）；编号让位：原预定 ADR 0069 / 0070（+1 让位号）→ 实际 **0149–0151**（0146–0148 被并发批次 M57 P3-1/P3-2 与画布联动批占用），design.md 原预定 §54 → 实际 **§97**。

### 97.1 阶段映射与悬浮条场景化（DEV-1 / SR-1）

- 新文件 `client/src/lib/stage-map.ts`：**渲染知识常量表**（不进 `_group.yaml` 资产、不进服务端）——development 七段（需求 → 架构 → 设计 → 前端 → 后端 → 测试 → 部署；旁路角色折入相邻段，security / tech-writer 为序外标签只显示不计进度）；sre 五段（分级止血 → 回滚 → 修复 → 回归 → 复盘）；
- 纯函数 `stageOf`（角色 → 阶段名，DEV-2 行标签复用）与 `waveStage`（波次成员 → 去重按序标签 + 进度段 x/y）；未收录场景 / 全未映射 → undefined；
- `WaveStrip` 新增 `group` prop（ChatArea 传 `sceneGroup`）：命中时换显示「阶段名（多段 `·` 连接）· 阶段 x/y」（`data-wave-stage` 锚点；波次信息退入 `title`）；未命中沿用「第 N 波 · 共 N 波」——口径零变化。

### 97.2 波次网格（MK-1）

- `WaveGroup` 布局选项：`marketing / health` × 同波 **2–4 条** × 非窄屏 × 非对决 → 2 列网格（`grid-cols-2` + `data-wave-grid` 锚点）；单条 / 5 条以上 / 窄屏 / 其他场景回退纵向单列；对决（PK）优先级高于网格。

### 97.3 工序卡与验收单（DEV-2 / DEV-3）

- 交付明细行（`ArtifactRow`）增强：**阶段标签 chip**（`stageOf` 派生，未收录场景不渲染）+ **悬停预览 popover**（Radix Tooltip 懒挂载：完整路径 / 类型 / 体积 / 交付者 / 阶段 / 操作提示；完整内容预览仍走交付件视图，ADR 0079 边界）；`DeliveryFiles` 透传消息作者（`agentId`）——消息内行补作者头像；
- 收尾卡验收区（`CloseoutCard`，仅 development）：新纯函数 `client/src/lib/acceptance.ts` 的 `acceptanceOf(messages, runId)` 启发式派生——判定徽章（未通过 > 有条件通过 > 通过，扫描本轮 qa 消息）+ 未决项（`- 未决：… / - 待验证：… / - 遗留：…`，去重至多 5 条）；无 qa 内容 → 不渲染验收区（降级：仅列交付件）。

### 97.4 场景工具卡变体与工具记录 meta 扩增（BI-1 / SR-2）

- `ToolCard` 场景路由：`bi × db_query / db_schema` → **取数管道卡**（DbPipelineCard：已校验徽章 + 行数/耗时 + SQL 可展开 + 结果预览表 ≤5 行）；`sre × ssh_exec` → **证据卡**（SshEvidenceCard：exit 色徽 + 耗时 + 等宽命令块 + 输出折叠 + 截断徽章 + 停止/审批拒绝徽章）；其余场景 / 工具 / 无上下文 → 通用卡（现有实现保留）；
- 服务端 meta 扩增（`ToolResult.meta` 既有通道，随 ToolCallRecord 持久化）：db_query → `{ columns, rows≤5（单元格文本化 ≤160 字）, rowCount, durationMs }`；ssh_exec → `{ command≤500, exitCode, durationMs, output≤2000, truncated }`；历史消息 meta 缺省 → 卡片降级 summary 行；不另起数据管道（与 LiveDock 同源不重复）。

### 97.5 复盘卡（SR-3）

- 新容器 `::: postmortem [标题]`（remark-ext builder + finalizeFieldsAndItems）：字段行「分级 / 时间线 / 归因」按序渲染 + 条目行 `- 改进项 | 内容 | 归属`（归属渲染为 owner · 期限 chip）；fail-safe 与轻结构流式渲染同 M37–M43 口径；
- sre 协议新增「渲染容器约定」条目 12（与《事故复盘》改进项表同源；容器内不写 @）；复盘呈现以消息内复盘卡为主（收尾卡聚合变体留待真实需求，ADR 0082 条件性纪律）。

### 97.6 验证

- 单测 / 组件测：`client/tests/m39-production.test.tsx` 21 例（阶段映射纯函数 / 悬浮条换显示与回退 / 波次网格四态 / 工序卡阶段标签 / 验收派生与收尾卡验收区 / 两张工具卡结构·截断·拒绝态 / ToolCard 路由 / 复盘卡渲染与 fail-safe）全绿；受影响既有套件（closeout / wave-strip / m43-cards / m52-stage / markdown-ext / m38-cards）回归全绿（closeout 夹具补 TooltipProvider；行点击改 fireEvent 防负载抖动）；
- E2E：新增 `e2e/m39-production.spec.ts` 3 条（研发阶段条 + 收尾验收单 / 营销波次网格 / SRE 复盘卡）实跑 **3/3 ✅**；`playwright.config.ts` main 项目 testMatch 补 `m39-.*`；**域内回归定向**（m16-brainstorm / m38-research / m39-production / m52-stage）**28/28 ✅**；`m37-scene-chat` 断言按 DEV-1 换显示同步（研发药丸「需求 · 阶段 1/7」）后 **2/2 ✅**；
- **全量 E2E 实测与甄别**（97 条）：**90 ✅**；7 红——1 例本批已修（m37 阶段条换显示，属预期行为变更的断言同步）+ 3 例隔离复跑绿（m26-console / m27-mcp / m43-pk 辩论场，环境抖动）+ 3 例并发批次域（m43-pk 谈判桌＝M63 报价折线点位 4 vs 6、m34 多空对弈＝M63 新块四路走查、m57-auth P3 配额＝并发新 spec ECONNRESET；证据：spec 注释含「M63」、文件 mtime 19:50 为并发会话所写）；另首轮全量 20 红为 webServer 连接拒绝（并发 E2E 端口竞态，环境级）；
- 门禁：eval **32/32 ✅**；check:agents **114/114 + 协议 29/29 ✅**（sre 协议追加段落不破坏质量红线 / 失败模式结构）；check:skills **51/51 ✅**；server **1174/1174 ✅**；client **81 文件 993 例**（992 ✅；1 例 `m43-pk` 属并发 M63 批次 claims 扩展的未同步单测，非本批域）；四包 typecheck 0 错；ESLint 改动文件 0 错；build 通过（主包 `index-DuhgBAgt.js` 1,380.34 kB / gzip 395.14 kB——含并发批次合流，点记录）。

## 98. 对抗博弈主面——交锋计量板 · 交锋看板 · 轮次判定 · 参与仪式 · 报价折线 · 博弈走子板 · 四路观点卡（M64）

全场景深度优化「对抗 · 博弈 · 分析三域」批一的 P0–P1 落地（设计基线 [docs/pk-game-analysis-design.md](pk-game-analysis-design.md)）：arena（debate / negotiation）与 versus（invest）主面深化——交锋可计量、轮次可判定、参与有入口、报价可读图、走子可复现、观点可沉淀。决策见 ADR **0154**（交锋计量与交锋看板）/ **0155**（轮次判定与参与仪式）/ **0156**（报价折线 / 博弈走子板 / 四路观点卡）；编号让位：预定 ADR 0147–0151 与 M63 被并发批次（M57 P3-1/P3-2/P3-3 · 画布 / M39 · 盘面深化 / 家装工作室）占用 → 实际落 **ADR 0154–0156**、里程碑 **M64**、design.md **§98**、CHANGELOG **v76**（v74 / v75 先后被盘面深化 / 家装工作室批占用）。容器面全部纯前端派生 + 冻结口径（ADR 0114）；一切新交互只回填草稿（ADR 0064 / 0118）。

### 98.1 交锋计量板（A1）

- `lib/pk.duelTally` 扩展 `claims` 字段（claim 容器计数，按席位分侧；席位优先、`DUEL_STANCE` 兜底不变）；`Scoreboard` 升级为三层读数（发言 / 主张 / 交锋 x/y）+ 轮次读数 + 终局徽标——读数缺省时保持 v1 外观（向后兼容）；
- 交锋读数点击 → 定位该侧首个未响应缺陷消息；终局徽标点击 → 定位裁决消息；轮次读数：有 `::: ruling` 时「第 N 轮（进行中）/ 共 N 轮」，缺省回落波次口径（E2E `第 \d+ 轮` 断言零变化）。

### 98.2 交锋看板 CrossFire（A2 · U2）

- 新纯函数 `lib/pk.crossFireOf`（findings 条目 + 「已响应」全量提及扫描，口径同配对卡与 duelTally；未响应优先排序）；新元件 `parts/CrossFire`（双泳道：提缺 / 已响应计数 + 响应率条 + 「催回应」回填）；
- arena 中轴 insights 段序：交锋看板 → 论断树 → 报价流（有数据才显示）；`registry.PART_NAMES` 五件套 → **六件套**（+ `cross-fire`），debate `stage.parts` 声明同步（m21 断言同步）；brainstorm 汇聚板红队段复用（只读模式，不提供催回应）。

### 98.3 证据等级徽标与 claim 扩展字段（A3 · U1 / N1 前置）

- 新共用件 `lib/evidence.ts`：`gradeOf` 词表（官方 > 学术 > 权威媒体 > 待核实 + 色板，多命中取最高优先级）；`ClaimTree` 论据行渲染等级徽标 / 无证据「假设」徽标 / 无等级「补证据」回填；行改 `div[role=button]`（嵌套交互按钮合法化，既有选择器与断言不变）；
- claim 容器扩展字段行 `视角 / 倾向 / 置信度`（可选、各取首条）：`lib/pk.claimMetaOf` 单一解析（remark-ext finalizeClaim 与场景面板共用），消息卡 chips 同步；`stanceToneOf` 多空色键共用。

### 98.4 轮次判定与参与仪式（A4 / A5 / A6 · U3）

- 新容器 `::: ruling <正方|反方|多方|空方|僵持> 第 N 轮小结`（过程件，与终局 `::: verdict` 渲染分离）：RulingCard 轻卡（原始胜方词徽标 + 条目 chips）+ `derive.rulingsOf`（回合轴色点 + 轮次分 + A5 未决点引用源）；裁决流不含 ruling；
- 对抗参与条（`parts/ArenaActions`）：加一轮 / 叫停并裁决 / 倾向·左 / 倾向·右 / 倾向·僵持——模板集中 `lib/pk.TEMPLATES`（中轴席名注入、未决点引用、@ 显式）；终局结论条（`parts/ConclusionBar`）：L1 横条（胜负 + 置信度 + 翻盘条件 + 看裁决），会话级关闭记忆（`ma:sc:concl:<sid>`）。

### 98.5 报价折线与让步刻度（G1 / G2）

- 新纯函数 `lib/pk.offerSeriesOf`（双方序列 + 目标 / 底线 / BATNA 基准线 + 让步理由字段；不可解析点跳过）；新元件 `parts/OfferChart`（SVG 自绘：双折线 + 收敛走廊 + 基准线 + 数据点定位；有效点 < 2 不绘图）与 `OfferConcessions`（让步刻度：递减绿 / 扩大红警示 + 说明回填）；
- 报价段结构：图 → 让步刻度 → 既有列表（列表为明细不动，E2E 既有断言零变化）。
- **续修订（2026-09-19）报价图交互深化**：图例四层显隐（我方 / 对方 / 基准线 / 收敛走廊）+ 数据点悬停 / 聚焦浮层与同侧折线提亮 + 最新点脉冲光环（quiet 静态）与值标签 + 四档 y 轴刻度与网格 + 视图宽 ResizeObserver 自适应（1:1 零变形，jsdom 回落 320、高 156px）；报价段「图 / 表」切换（会话记忆 `ma:sc:tab:<sid>:offerchart`）+ 段级收起 / 展开（会话记忆 `ma:sc:tab:<sid>:offer-collapsed`；收起 = 仅头部一行）；洞察区高度上限 150px → min(62vh, 520px)（报价图完整展示，仅极端长度区内滚动）；同步增强非报价类图表交互：`SequenceView` 悬停分支淡化与反事实联动、`MomentumBar` 悬停双读数、`ProgressRing` 悬停明细 hint、`StudioPlanView` 悬停高亮与尺寸提示（轻量内联口径，零新依赖）。

### 98.6 博弈走子板与四路观点卡（G4 / N1 · U4）

- `derive.gameMovesOf`（```game 围栏扫描 + `parseGameSpec` 单一解析，失败仍可定位）：`parts/MoveBoard`（轮次 / 模型 / 标题 / 快照名 / 种子复制 + 「模型推演，非预测」声明条）；versus 空态「发起多空对弈」回填 `DUEL_PROMPT`（与 `_presets.yaml` bull-bear-duel 同文）；
- `parts/ViewCards` 四路观点（视角注册表序 + 倾向色条 + 置信度 + 依据数；分歧提示 chip → 裁决模板）；`panel-ready` versus 就绪口径扩展（带「视角」claim / ```game 围栏亦就绪）；面板场景分支注册表模式（console / pool / versus 同口径）。

### 98.7 验证

- 组件测：`client/tests/m63-pk-arena.test.tsx` **22 例**（证据词表 / claim 字段 / 交锋计量与看板 / ruling 渲染与派生 / ClaimTree 徽标 / arena 集成五组 / versus 集成 / pool 红队 / panelReady 扩展）；受影响既有套件（`m43-pk` claims 断言同步、`m43-cards / m52-stage / markdown-ext / m60-arena-live`）全绿；
- E2E：`m43-pk` 扩展（交锋走查 → 轮次色点 / 交锋看板 / 结论条 / 参与条；报价走查 → 折线 / 三桩基准线 / 让步刻度）实跑 **2/2 ✅** 与 `m34-invest` 扩展（四路走查 → 观点卡 / 走子板 / 声明条）实跑 **3/3 ✅**；`playwright.config.ts` main 项目 testMatch 补 `m63-.*`；补跑期间修复共享 helper（`createSession` 同名来源行 `.first()` / 新增 `backToChat`）；
- 资产：debate / negotiation / invest 三份协议「渲染容器约定」段 + judge / negotiator / 四分析师人设输出约定；mock 三组触发块（交锋走查 / 报价走查 / 四路走查——唯一触发词核对过）；check:agents / eval 门禁计入批一收口记录。

## 99. 个人 MCP——属主私有 · 属主会话自动授予（M57 P3 收官）

> 决策见 [ADR 0157](docs/adr/0157-user-personal-mcp.md)；P3「个人资源」两件套的第二件（第一件 = §95 个人连接）。

### 99.1 语义与四层守卫（复用 P3-2 模式）

- `mcp_servers.scope / owner_id`（v14 预留列，零迁移）启用：成员创建一律落 `scope='personal' + owner_id=本人`（服务端定，不信请求体）；`list()`（admin 全量）与 `listForUser(uid)`（全部 system ∪ 本人 personal）分流；
- `/mcp` 从「整体 admin 挂载」改为**路由级门控**（routes/index.ts 移除 blanket）：管理面 `json-config* / tools 授权矩阵` → `adminOnly`；服务器 CRUD + test/reconnect/refresh → `ownerOrAdmin`（system / 他人 personal → 404 不泄漏存在性）；session 绑定路由维持会话写权限 + personal 归属校验（他人 personal → 404）；
- 绑定清单 GET 防御性过滤他人 personal（历史 / 脏数据兜底）。

### 99.2 属主会话自动授予（本批核心）

- **可见性**：`filterForSession(sessionId, tools, sessionOwnerId?)` / `isToolUsable` 对 personal 要求 `server.ownerId === session.ownerId`（非属主 / 无属主会话不可见；缺省参数不做复核 = 兼容路径零变化）；
- **自动授予**：引擎 execute 模式在 `forAgent` 白名单结果上并入属主已注册 personal 工具（`personalToolNames(ownerId)` 按 `toolOwner` 反查 + 注册表取件去重）——绕过 Agent 工具白名单（agent 为管理面资产、成员无授予入口），plan / review 模式不并入；绑定 / 启用 / 连接状态仍由 `filterForSession` 统一复核；
- **执行侧最小权限**：`executeRegisteredTool` 以 `ctx.userId`（= 会话属主）复核，他人触发直接拒绝（`他人私有：无权使用`）。

### 99.3 绑定与级联

- `POST /sessions/:id/mcp-servers` 绑定 personal 后自动 `runtime.connect`（成员无管理台，不能手动重连）；system 绑定语义不变（沿用连接由管理台维护）；
- 账号删除：先 `mcpRuntime.disconnect`（注销工具 + 回收 stdio 子进程）再 `removePersonalOf`（`session_mcp_servers` 双 FK 级联解绑）；best-effort 不阻断删除；
- 审计：`mcp.create` detail 增 `scope / ownerId`；其余 mcp.* 审计沿用。

### 99.4 客户端

- 个人设置「我的 MCP」卡（多用户门控）：列表（展示名 / slug·transport / 状态灯 ok·error·idle）+ 新建（stdio：command + args / http：url；**保存即测试**并 toast 连接结果）+ 测试 / 重连 / 删除；
- 会话头部「资源」入口（M57 P3 收口）：会话资源弹窗（连接 / MCP 两页签；成员自助绑定面）——已绑定（解绑）+ 可绑定（绑定，候选 = system ∪ 本人 personal）；viewer 只读；管理台仍为 admin-only。

### 99.5 验证

- 服务端 `tests/m57-p3-mcp-personal.test.ts` 2 例：Store（create personal / listForUser / ownsPersonal / ownerOf / removePersonalOf 绑定级联）+ HTTP（成员创建落 personal · 列表分流 · 资源级 404 · 管理面 403 · 改自有 200 · 绑定自有 200 + 自动 connect / 他人 404 / system 200 · 清单防御性过滤）；
- `tests/m27-engine.test.ts` 扩展 2 例（新 `solo` 角色白名单无 mcp 为对照组）：属主会话自动授予（solo 也见 personal 工具）· 非属主 / 无属主会话绑定也不可见 · `personalToolNames` / `filterForSession(ownerId)` / 执行侧（ctx.userId 他人拒绝、属主放行）；
- 客户端 `tests/m57-p3-mcp-personal.test.tsx` 4 例（列表过滤与状态 / 新建 payload + 自动测试 + 刷新 / slug 校验拒绝 / 删除与重连路由）；`m57-p3-personal.test.tsx` 门控用例兼容通过；
- **P3-2/P3-4 共同收口件**：会话资源弹窗 `SessionResourcesDialog`（连接 / MCP 两页签；成员自助绑定面；viewer 只读）+ 客户端 `tests/m57-session-resources.test.tsx` 3 例；store 层按角色收敛管理面请求（mcp-store / connections-store `loadForSession` 对成员不再请求 tools / json-config / audit 等 adminOnly 端点）。

## 100. 分析域深化——指标口径 · 取数链 · 事故时间轴分级 · 立场泳道与共识分歧板（M66）

全场景深度优化「对抗 · 博弈 · 分析三域」批二的落地（设计基线 [docs/pk-game-analysis-design.md](pk-game-analysis-design.md) §6 / §7-U5）：console（bi / sre）与 pool（society）专业语汇承接——指标可核口径、取数可回溯、事故可分级、立场可沉淀、窄屏可收纳。决策见 ADR **0160**（kpi 五列与取数链）/ **0161**（事故时间轴分级与 SLO）/ **0162**（立场泳道与共识分歧板）；编号让位：预定 ADR 0147–0151 与 M63 / M65 被并发批次占用 → 实际落 **ADR 0160–0162**（0157–0159 被个人 MCP / 素材库 / 设计工作室占用）、里程碑 **M66**、design.md **§100**、CHANGELOG **v80**。容器面纯前端派生 + 冻结口径（ADR 0114）；一切回填只写草稿（ADR 0064）。

### 100.1 kpi 五列与取数链（N2）

- `kpi` 容器新增可缺省第 5 列「口径」（remark-ext `kpiRowOf` 单一解析：remark 收尾与面板共用；四列历史写法零变化）：消息卡渲染口径徽章（截断 + hover 全文）；
- 新 `derive.sqlRunsOf`（```sql 围栏计数与消息摘要；SQL 正文不复制——消息内代码块为唯一全文通道）；ConsolePanel **bi 分支**：指标区（kpi 卡网格 + 定位钮）→ 取数链（作者 + 摘要 + `SQL ×N` 徽章，点击定位）→ 既有时间轴 / 交付件；非 bi / sre 场景零变化（`data-console-kpis` / `data-console-sql` 锚点）。

### 100.2 事故时间轴分级与 SLO 区（N3）

- `timeline` 第三列在 sre 场景语义 = **等级**（协议条目 13）：`derive.incidentLevelOf`（P0|严重|紧急 → p0；P1|高 → p1；P2|中 → p2；其余 → other）；`timelineRowOf` 自 remark-ext 导出单一解析（列表标记剥离）；
- ConsolePanel **sre 分支**：事故时间轴（时间 + 事件 + 等级徽标 + 左缘色带；筛选 chips 全部/P0/P1/P2，本地态 `ma:sc:tl:<sessionId>`）→ SLO 区（kpi 复用指标卡）→ 交付件；有事故时间轴时通用「活动时间轴」让位（无容器回落）；
- sre 协议渲染容器约定条目 13–14（时间轴三列语义 / SLO kpi 五列）。

### 100.3 立场泳道与共识分歧板（N4）

- 新容器 `::: stance <立场方>`（字段行 主张 / 核心关切 / 被忽视视角，条目 `- 依据 | …`；StanceCard：三要素序 + 依据正文走 U1 证据等级徽标 + 「推演关切」回填）与 `::: split <标题>`（条目 `- 共识|分歧|存疑 | …`；SplitCard：三列分桶、分歧置中主位、未知键落「其他」行 fail-safe；分歧→中间路径模板 / 存疑→核实路径模板回填）；
- 汇聚板（pool）：**立场泳道**（按立场方分组，稳定哈希 6 色相 `data-hue`）与**共识分歧板**段（与消息卡同组件渲染 + 面板条瘦身）；`SPECIAL_CARDS` / `NON_GENERIC` 拆分（stance / split 不入通用卡墙，就绪判定沿用「结构化行 / 标题」口径零扩展）；
- society 协议渲染容器约定条目 14–15（立场三字段 / split 三类条目 / 事实基线 sources）；`TEMPLATES` 增 stanceAsk / splitPath / splitVerify。

### 100.4 窄屏洞察收纳（U5）与收尾合并（附）

- arena 窄屏：洞察区（交锋看板 / 论断树 / 报价流）收纳为「洞察区（N 段）」条（默认收起，展开为内联抽屉）；宽屏行为零变化（`data-insights-bar` / `data-insights` 锚点）；
- remark-ext 收尾合并：verdict / ruling / split 三族共用 `finalizeItemRows`（消除 M63 引入的重复实现；拆分桶解析 `splitBucketOf` 共享）；quiet / reduced-motion 新增元素全部静态化。

### 100.5 验证

- 组件测：`client/tests/m66-analysis-console.test.tsx` **14 例**（kpiRowOf / timelineRowOf / incidentLevelOf / sqlRunsOf 纯函数；口径徽章两态；stance 渲染与回填；split 三列分桶与回填；console bi / sre 分支与零变化；pool 泳道与共识板；arena 窄屏洞察条）；受影响既有套件（m52-stage / m38-cards / m63-pk-arena / markdown-ext）全绿；
- E2E：新增 `e2e/m66-analysis-console.spec.ts` 3 条（商业智能指标走查 / 站点可靠性事故走查 / 议题圆桌立场走查）实跑 **3/3 ✅**；`playwright.config.ts` main 项目 testMatch 补 `m66-.*`；
- 资产：bi / sre / society 三份协议「渲染容器约定」段；mock 三组触发块（指标走查 / 事故走查 / 立场走查——唯一触发词核对过）；check:agents / eval 门禁计入收口记录。

---

## 101. 场景扩展二批——十场景 · 场景玩法工具 · roll / cards / sim 容器族 · 牌阵台与卡片交互（M69）

设计蓝图见 [docs/scene-expansion-v2-design.md](docs/scene-expansion-v2-design.md)（交互与前端细化 / 容器与工具契约 / 镜像面清单）；决策见 [ADR 0166](docs/adr/0166-scene-expansion-v2-m69.md)；变更账 CHANGELOG v78。

### 101.1 十场景与形态

- 三域十场景：经营创作（ecommerce 电商经营 / creator 自媒体工作室）、实用（legal-personal 个人法务 / academic 学术论文 / relationship 情感关系）、玩法（trpg 跑团工坊 / tarot 塔罗研习 / moot-court 模拟法庭 / business-sim 商业沙盘 / philosophy 哲学茶室）；每场景 `_group.yaml` + 协议（三段式 + 质量红线 + 典型失败模式）+ 34 角色（六段骨架）；
- 形态声明 **dock ×6 / roundtable ×2 / arena ×2**（moot-court 与 business-sim 带 seats 与 parts——复用 arena 五件套）；协议统一「渲染容器约定」段规定各场景容器用法；
- **既有场景补强 12 角色**（travel / wealth / funding / bi / sre / personal / ops）——**不进 chain**（镜像面既有口径：建会话默认预选不扩，经成员微调或 M48 自动召集使用）；预设新增 5 个（创业启动 / 职业转型 / 年度复盘 / 电商增长 / 内容商业化）。

### 101.2 场景玩法工具（种子复现契约）

- `dice_roll`（trpg）：骰式解析（d20 / 3d6+2 / 2d10-1；骰数 ≤100、面数 ≤1000）+ **mulberry32 确定性 PRNG**——种子缺省随机生成并回显，**同种子逐位复现**（战报存档 / 回放）；输出含 `::: roll` 卡模板；
- `tarot_draw`（tarot）：78 张全表（22 大阿卡纳 + 4 花色 × 14 阶；正逆位 50%）+ 同款 PRNG（同种子牌序与正逆位复现）；输出含 `::: cards` 卡模板；
- 两者 tier=deferred + readOnly + 无审批（与 pan 四件套同模式）；registry / categories 登记（新分类「场景玩法」）；协议层「唯一口径」约束——判定 / 抽牌必须出自工具，禁止心算造数。

### 101.3 三容器族与卡片交互

- remark-ext 新增 `::: roll`（字段行：骰式/种子 + 明细/修正/总值）、`::: cards`（条目 `- 牌位 | 牌名 | 正逆位 | 关键词`）、`::: sim`（条目 `- 决策 | … | 反馈 | … | 指标 | …`）——`finalizeFieldsAndItems` 复用 + 收尾按 type 分派；
- 卡片组件：RollCard（骰面方块 + 总值 + 种子徽章 + **双按钮**：再掷一次（新种子）/ 复现本次（同种子，seed 缺省不渲染））、CardsCard（牌位行 + 正逆位标记 + **双按钮**：重抽一组（新种子）/ 深入解读）、SimCard（三段 + 指标 chips + 下个回合）；全部 `composerInsert` 回填模板句、流式禁用、raw 兜底；
- 面板文案场景化：pool（trpg / philosophy）、board（creator / academic）、coach（relationship）。

### 101.4 牌阵台（chartboard cards 区）

- ChartboardPanel 收集 `cards` 容器 → **复用 CardsCard 渲染**（面板与消息同组件，ADR 0144 纪律）；计数徽章 = pan + cards；
- **tarot 场景隐藏「亲手摇卦」**（体系隔离）且空态文案场景化（「对话中抽出的牌阵将显示在这里」）；pan 路径零变化（仅 charts.length > 0 时渲染 PanBoard）。

### 101.5 触发块与验证

- mock 三组触发块：「骰子走查」（gm-host → roll 卡）/「牌阵走查」（tarot-reader → cards 卡）/「回合走查」（sim-host → sim 卡）——E2E 与 eval 的确定性演示通道（索引走 baseId）；
- 验证账：check:agents **163/163 + 协议 40/40**；check:skills **60/60**；m69-tools **13/13**；m69-md-ext **14/14**（含面板牌阵台与双按钮）；mock-coverage **4/4**；m21 **19/19**；server 全量 1247/1249（2 例为并发批次 M77 中间态，收口后已转绿）；client 全量 1107/1107（95 文件）+ 本轮新增用例；E2E 定向 `e2e/m69-cards.spec.ts`。

## 102. 核心交付锚点范式——交付锚定条 · 变更卡 · 意见闭环 · 签收（M44）

全场景深度优化批三的落地：`docs/scene-chat-design.md` M44 原案（AF-1–AF-5）全面兑现——长会话获得「本轮核心交付是什么、改到第几版、谁改的、我的意见闭环了没」的常驻读数与协作闭环；与 M39 工序卡族（DEV-2）合流。决策见 ADR **0163**（锚点选择 / 钉选 / 锚定条）、**0164**（变更卡 / 提意见 / 闭环配对）、**0165**（签收收尾）；编号让位：原预定 ADR 0078–0080 → 实际 **0163–0165**（落盘窗口内 0143–0162 已被并发批次连续占用），design.md 原预定 §59 → 实际 **§102**（§93–§101 为并发批次）。

### 102.1 锚点与锚定条（AF-1）

- 新文件 `client/src/lib/focus-artifact.ts`（纯函数 + 本地态）：`pickFocusPath`（钉选 localStorage `ma:focus-artifact:<sid>` 优先 → `partitionDelivery` 重要度首个）· `commentDraft` / `signoffDraft` 模板 · `opinionsOf` / `closureOf` 闭环推导 · 已满意（`ma:m44-satisfied:<sid>`）与签收（`ma:signoff:<sid>`）本地集合；
- 新文件 `client/src/lib/artifact-versions.ts`：版本列表共享缓存（与 use-artifact-meta 同构：会话 + artifactVersion + 路径；失败静默）；
- `FocusBar`：对话区左上角常驻药丸（核心交付名 + vN + 修改者头像流 + 未闭环计数）+ 悬浮面板（版本线 ≤6 / 未闭环意见 ≤3 可「标记已满意」/ 钉选候选 ≤4 / 查看 Diff·提意见）；隐藏条件：无交付件 / 纯列表模式 / 窄屏。

### 102.2 变更卡与意见闭环（AF-2 / AF-3 / AF-4）

- `ChangeCard`：消息「产出交付件 + 写类工具调用（write_file / apply_patch / edit_file）」→ 变更语义——复用 `ArtifactRow`（扩展 `version` vN 徽章与 `trailing` 行尾槽位，卡族合并）；点击行打开交付件（完整 Diff 在交付件工作台，ADR 0079 边界；增删摘要按降级链）；
- `MessageActions` 新增「提意见（对交付件）」（成员消息含 artifacts 时）：`commentDraft` 模板入草稿（只写草稿不直发）；锚定条操作区同模板；
- 闭环（高置信，ADR 0080）：用户消息含「的意见」+ mentions 含非用户成员 + 正文命中交付件名（全名 / 主干取最长）→ 其后首个「同作者 + 同文件」成员消息配对 → 对应文件行尾「回应了你的意见」角标（`data-change-response`）；未配对 = 未闭环计数；低置信不计。

### 102.3 签收（AF-5）

- 收尾卡签收行（development 且锚点存在；`data-signoff` 携锚点）：锚点名 + vN（懒加载；未就绪按钮禁用）+ 闭环统计「已回应 N · 未闭环 M」+ 「签收」toggle（本地按版本 `path@vN`；签收时回填「已签收《名》vN。」草稿）；非 development → 普通验收单（降级不变）。

### 102.4 mock 与资产

- mock `REVISE_TRIGGER`（唯一触发词「修订走查」）：脚本化 write_file 的交付件内容追加修订段——同路径二次写内容变化 → 版本库哈希去重失效 → 产生 vN（E2E「意见 → 修改 → 闭环 → 签收」链路的确定性数据源）；
- **agents 资产零变更**（零协议 / 零人设；本批为前端 + mock 辅助脚本）。

### 102.5 验证

- 单测 / 组件测：`client/tests/m44-focus.test.tsx` 12 例（锚点选择 / 模板 / 意见识别正负例 / 闭环配对与误配防护与已满意排除 / 变更卡 vN 与回应角标与未配对角标缺省 / 锚定条读数与悬浮面板与钉选与隐藏三态 / 提意见菜单模板 / 签收回填与取消）全绿；受影响既有套件（closeout / m39-production / m38-cards / markdown-ext / m52-stage / m43-cards）**191 例**回归全绿；
- E2E：新增 `e2e/m44-artifact-focus.spec.ts` 1 条（单成员 pm：产出 v1 → 锚定条 → 提意见模板 → 「修订走查」→ v2 + 回应角标 + 未闭环归零 → 签收回填）实跑 **1/1 ✅**；域内回归（m37 / m38 / m39）**6/6 ✅**；`playwright.config.ts` main 项目 testMatch 补 `m44-.*`；
- 门禁（本批实测）：eval **34/34 ✅**（窗口内并发已扩至 34 任务，零回归）；check:agents（strict）**163/163 + 协议 40/40 ✅**；check:skills（strict）**60/60 ✅**；四包 typecheck 0 错；ESLint 改动文件 0 错；client build 通过（主包 `index-Dhgz3GQM.js` 1,483.13 kB / gzip 426.04 kB——含并发批次大幅合流，点记录）；
- **双端全量与全量 E2E 的并发窗口甄别**：client 全量 1126 例（1124 ✅，2 红为场景创建器/组队台用例——隔离复跑 **38/38 全绿**，并发中间态）；server 全量 4 红均为工具清单计数漂移（期望 57 / 实得 60，并发批次新增工具未同步 m28/m47 断言——本批未增删任何工具，非本批域）；全量 E2E 本轮遇**另两会话并发跑 E2E**（m43/m34/m66 与 m77 进程实证 + 8788 端口被占）→ 大面积连接级假失败（32 过），判定环境级；本批域内 E2E 已在隔离窗口全绿（m44 1/1 + m37/m38/m39 6/6），全量建议由收口方在零并发窗口错峰补跑。

## 103. 服务型渲染包——客户管道 · 测算表 · 风险色带 · 进度卡 · 问答卡 · 口径校验徽章（M41）

全场景深度优化批四的落地：`docs/scene-chat-design.md` M41 原案（服务域 sales / finance / funding / ops）的容器族与徽章全面兑现——业务容器族 v2 语法归一（决策项 0071）落地。决策见 ADR **0169**（服务型五容器与语法归一）、**0170**（口径校验徽章 FI-2）；编号让位：原预定 ADR 0071 / 0072 → 实际 **0169 / 0170**（落盘窗口内 0143–0168 被并发批次连续占用，四度顺延），design.md 原预定 §56 → 实际 **§103**（§93–§102 为并发/前批章节）。

### 103.1 五容器与卡片（v2 语法归一）

- `::: pipeline [标题]`（SA-1）——条目 `- 客户 | 阶段 | 金额 | 下一步`；阶段 ∈ {线索|意向|报价|成交}，未知归「其他」列；四列看板（grid-auto-columns 自适应）+ 点卡回填「跟进 <客户>：」草稿（ADR 0064）；
- `::: figures [标题]`（FI-1）——条目 `- 行名 | 值 | 说明`；值列右对齐（tabular-nums）；关键行启发式（合计/总计/小计/毛利/净额/净利/EBITDA/税后）加粗 + 淡底；
- `::: risk <高|中|低> [标题]`（FI-3）——首词参数命中才着色（未命中中性，不猜测等级）；顶部色带 + 等级标签，正文 children 原样保留；
- `::: progress [标题]`（FU-1）——条目 `- 章节 | 状态`（完成/进行中/待办；未识别 → 待办）；总进度条 = 完成数 / 总数；
- `::: qa [标题]`（FU-2）——条目 `- 问 | 答`（答案内 `|` 保留合并）；原生 details 折叠对（无 JS 状态、缓存安全）；
- 共享收尾：四类行集容器共用 `finalizeRowSet`（`data-rows` + `data-count` + `data-raw` 重建）；空行集保持原文 / 解析失败 raw 兜底 / 未闭合去壳展开（既有降级链）。

### 103.2 FI-2 口径校验徽章

- 新文件 `client/src/lib/calc-badge.ts`：`calcExpressionOf`（首个 `status='ok'` 的 calc → 表达式）；
- 消息头部徽章行（波次徽章之后）渲染「已核算」（`data-calc-badge`；`title=已核算：<表达式>`）；运行中 / 失败 calc 不亮；纯派生（零新字段 / 零新接口）。

### 103.3 OP 面收敛（不重复造卡）

- OP-1 纪要 = 既有 `::: minutes`（M42 已落，E2E 覆盖）；OP-2 SOP = 既有 `::: checklist`（M37，E2E 覆盖）；OP-3 招聘管道 = SA-1 复用（ops 输出 `::: pipeline` 即得同卡）。

### 103.4 mock 与资产

- mock 三组触发块（唯一词，同既有先例；块内不写 @）：「管道走查」（sales → pipeline）/「财务走查」（finance → figures + risk；**并在阶段一为 finance 追加脚本化 calc 调用**，供 FI-2 徽章 E2E 走查）/「融资走查」（fundraiser → progress + qa）；
- **agents 资产零变更**（零协议 / 零人设；前端 + mock 辅助脚本）。

### 103.5 验证

- 单测 / 组件测：`client/tests/m41-service.test.tsx` 13 例（五解析器归一与容错 / calcExpressionOf / 管道四列 + 其他列 + 回填 / figures 关键行 / risk 三态 / progress 进度条 / qa 折叠对 / pipeline fail-safe / FI-2 徽章正反例）全绿；
- E2E：新增 `e2e/m41-service.spec.ts` 3 条（销售管道 / 财务测算 + 风险 + 徽章 / 融资进度 + 问答）实跑 **3/3 ✅**（融资首轮一例为 close 阶段 trace ENOENT 归档基建噪声——隔离复跑 1/1 ✅）；域内回归（m44 / m38 / m39）**5/5 ✅**；`playwright.config.ts` main 项目 testMatch 补 `m41-.*`；
- 门禁（本批实测，窗口全绿）：eval **35/35 ✅**（窗口内并发已扩至 35 任务，零回归）；check:agents（strict）**165/165 + 协议 41/41 ✅**；check:skills（strict）**61/61 ✅**；client 全量 **100 文件 / 1155 例 ✅**；server 全量 **102 文件 / 1285 例 ✅**；四包 typecheck 0 错；ESLint 改动文件 0 错（首轮 2 条未用导入 warning 已清）；client build 通过（主包 `index-DwlZKXhN.js` 1,495.16 kB / gzip 428.78 kB——含并发批次合流，点记录）。

## 104. 陪跑型渲染包——三轨打卡 · 每日一练 · 情绪签到 · 目标环 · 记账流水 · 行程卡（M40）

全场景深度优化批五的落地：`docs/scene-chat-design.md` M40 原案（陪跑域 health / learning / personal / wealth / home / travel）的容器族与本地打卡口径全面兑现。决策见 ADR **0172**（打卡与 streak 本地口径）、**0173**（陪跑容器族与 HL-2/HL-8 收敛）；编号让位：原预定 ADR 0071（+让位链）→ 实际 **0172 / 0173**（落盘窗口内 0143–0171 被并发批次连续占用，五度顺延），design.md 原预定 §55 → 实际 **§104**（§93–§103 为并发/前批章节）。

### 104.1 六个容器与卡片

- `::: tracks [标题]`（HL-1）——条目 `- 轨道 | 计划摘要`；周网格（周一锚定 7 日，今日突出、任意格可点补记）+ 逐轨 streak 徽标 + 周进度环（ProgressRing 复用）；
- `::: quiz [标题]`（HL-3）——条目 `- A | 选项文本`；本地单选 + 「提交给成员」回填「我的答案：X。请批改并讲解。」；
- `::: mood [标题]`（HL-4）——1–5 档 + 档位词；「提交签到」回填「今日状态：N/5（档位词）。请据此调整今日建议。」；
- `::: goals [标题]`（HL-5）——条目 `- 目标 | 当前 | 目标值`；`numberWithSuffix`（支持「万」后缀）→ 逐行进度环；缺数值 / 非法退化文本（不猜）；
- `::: ledger [标题]`（HL-6）——条目 `- 日期 | 项目 | 金额`；金额右对齐 + 负数色标（脏值不猜正负）；
- `::: itinerary [标题]`（HL-7）——条目 `- 日期 | 交通 | 住宿 | 安排`；按天分组（首次出现序）+ 日期头（含周几）+ **今天高亮**（本地日期比对）+ 交通/住宿/安排三行图标；非日期首列 → 「未标日期」组；
- 共享收尾：行集容器复用 `finalizeRowSet`（`data-rows` + `data-count` + `data-raw`）；mood 无列表（默认收尾）；解析失败 raw 兜底 / 未闭合去壳展开（既有降级链）。

### 104.2 打卡与 streak 本地口径（HL-1 数据层）

- 新文件 `client/src/lib/habit.ts`：localStorage `ma:habit:<sessionId>`（按天日期集合）；纯函数 `localDateOf`（本地日期不依赖 UTC）· `shiftDate` · `weekDatesOf`（周一锚定）· `streakOf`（今天未打卡则从昨天起算；断签归零）· `toggleHabitDay`（不可变，含补记/取消）· `useHabit` hook；
- 边界：仅本地可信（不进导出 / 不落库）；隐私模式静默降级；与 sessionStorage「会话内勾选」（CheckGrid）两套机制并存、各司其职。

### 104.3 HL-2 / HL-8 收敛声明

- HL-2 学习路径 = 既有 `::: timeline` 复用（tutor AGENT.md 补一行输出约定，无新容器）；
- HL-8 清单汇总条 = 既有 checklist 卡自带计数条与进度条（M37-4 已覆盖）——零新增。

### 104.4 mock 与资产

- mock 五组触发块（唯一词，同既有先例；块内不写 @）：「打卡走查」（fitness → tracks）/「出题走查」（tutor → quiz）/「签到走查」（coach → mood）/「理财走查」（wealth → goals + ledger）/「行程走查」（travel → itinerary，**日期为动态相对值**：昨天/今天/明天，供今天高亮断言）；
- 资产：5 个 AGENT.md（fitness / tutor / coach / wealth / travel）「工作方式」各加一行输出约定——**零协议新增**（按原案 §8.4 口径）。

### 104.5 验证

- 单测 / 组件测：`client/tests/m40-companion.test.tsx` 14 例（habit 日期/周网格/streak/toggle/读写容错 · 六解析器与 numberWithSuffix · 三轨卡点格落盘与 streak 徽标与预置连续 2 天 · quiz 点选提交 · mood 档位回填 · goals 40%/53% 与非法降级 · ledger 负数色标 · itinerary 分组与今天高亮 · tracks fail-safe）全绿；
- E2E：新增 `e2e/m40-companion.spec.ts` 5 条（健康打卡 / 学习出题 / 出行行程 / 理财目标+流水 / 个人签到）实跑 **5/5 ✅**（并发会话常驻旧版 8788 服务——启用新加的 `PW_PORT` / `PW_DATA_DIR` 隔离：`PW_PORT=8795 PW_DATA_DIR=e2e-m40 PW_OUTPUT_DIR=/tmp/pw-m40`，同一窗口内 m41 回归 3/3 ✅；首轮 7/8——健康打卡点错「周日格」，改 `.is-today` 选择器后复跑全绿）；`playwright.config.ts`：main 项目 testMatch 补 `m40-.*` + main 链路增 `PW_PORT` / `PW_DATA_DIR` 环境隔离（默认行为不变，供并发会话避让）；
- 门禁（本批实测，窗口全绿）：eval **35/35 ✅**；check:agents（strict）**165/165 + 协议 41/41 ✅**（含本批 5 处 AGENT.md 行）；check:skills（strict）**61/61 ✅**；client 全量 **102 文件 / 1174 例 ✅**；server 全量 **102 文件 / 1285 例 ✅**；四包 typecheck 0 错；ESLint 改动文件 0 错（首轮 1 条未用变量 warning 已清）；client build 随隔离 E2E 的 webServer 构建通过。

## 105. 同角多魂——成员分身（M77）

灵魂层（§26）可多套人格，但成员身份只到「角色」粒度（`participantIds` + `memberSouls`：一角色一场会话最多一份成员身份、一个生效灵魂）。本节将成员身份升级为**成员键（memberKey）**，同一角色的不同人格以多实例同台（决策见 ADR 0174）。

### 105.1 成员键（共享事实源 `shared/src/members.ts`）

- 经典实例 = `agentId`（存量数据天然合法、**零迁移**）；分身实例 = `agentId~soulId`（自描述；agentId/soulId 字符集 `[a-z0-9-]` 不含 `~`）；
- `memberSouls` 语义不变（经典成员的换装覆盖）；有效灵魂：分身取键后缀，经典取「覆盖 > 角色默认 > 无」；
- 约束（`lineupError` 单源）：同角有效灵魂去重（含都无灵魂）；无 souls 角色不可分身；分身键灵魂必须存在；同角实例 ≤ 4；
- `PromptLibrary.get/body/soul/avatarFile` 容忍成员键（按首个 `~` 取 base）——存量调用自动兼容。

### 105.2 @ 寻址与会话装配

- 会话向 token 表（`buildMentionTokens(members)`）：裸名（角色名 / agentId）→ 该角色**主实例**（编制序首位；见 §105.10 口径修订）；多实例时 `名字·灵魂名`（有效灵魂，去重规则保证唯一）→ 单实例；分身机器键作别名；token 边界排除 `·`（拼错的分身点名不回落裸名）；
- 装配（`context/service.ts`）：roster 由成员实例投影（`label（memberKey｜role）`）；多实例时 L3 注入寻址指南（「@名字 只召集主实例；全员请逐一点名」）与 L0 身份标识行；窗口投影按成员键署名（分身 = `名字·灵魂名｜role`）；
- mock：脚本 / 风格 / 容器表按 base 查表（`baseAgentId(meta.agentId)`）；请求 meta 增 `memberLabels`，转交行与纪要待办按实例标签点名（`@卢娜·禅意 接力棒给你了`）。

### 105.3 引擎与数据归口

- 成员键贯穿 queue / spoken / activeMembers / RunSnapshot / turn 事件 / 计划与步骤归属 / 任务归属 / 工具 runtime（`memberKey`）；
- `ChatMessage.agentId` 保持基础角色 + 新增 `memberKey`（迁移 v20 `messages.member_key`）；artifacts 作者 / 记忆 agent-scope / 审批沿用基础角色；
- 分身换装（PATCH 成员键）= **键替换**：`participantIds` 原位替换 + 运行中 `replaceMemberKey`（队列 / 波内进行中 / 交接便条同步 + `queue:updated` 广播）；分身 `soul: null` → 400（无默认态）；PATCH 经典与分身均做同角灵魂冲突校验（400）；
- 事件条文案：同角多实例用实例标签（`卢娜·狂野 换上了『考据派』灵魂`），单实例 = 角色名（存量零回归）。

### 105.4 前端（组建 / 会话 / 消息）

- `lib/members.ts`：成员实例视图（标签 / 有效灵魂 / siblingCount / pinned）、`participationOf` / `encodeParticipation`（参与性格 ↔ 成员键确定性编解码：首人格走经典键、其余分身键）；
- 组队台：编制按角色一行（`lineupItems`），编制行 grid 定列（头像 ∣ 文本 ∣ 右侧组），文本列内「名字 + `×N 分身同台` 徽标」可变宽换行，右侧组（「参与性格」+ 移出 X）恒贴行右缘——移出钮不随内容换行而漂移；行内「参与性格」多选 `SoulParticipantPicker`（勾选 = 入编、全取消 = 默认单人）；AgentPicker 值域升级为成员键，卡片「+ 分身」菜单（未占用灵魂）走 **Portal + fixed 定位**（避开滚动容器裁剪与 Radix 遮罩的 pointer-events 封锁）；`SoulPicker` / `SoulParticipantPicker` 弹层同模式收口（原 `absolute` 相对定位在编制 `overflow-y-auto` 列表内被裁剪成残片），且打开期间触发钮因行内重排（参与人格增删致按钮变宽换行）漂移时跟随重算锚点；
- 会话内：成员卡按实例渲染（分身标「分身」、无「恢复默认」；@ 召唤 / 拍一拍 / 移除 / 计划徽章 / 战绩均按成员键）；消息气泡作者与点名 chips 按成员键解析（多实例显示 `名字·灵魂名`）；指挥条 / Composer @候选按实例（插入点名 token；多实例角色顶部增「全部 N 位」显式全伞条目，一键插入逐一点名多 token——见 §105.10）；图谱节点 = 成员实例（显示克隆入图）、接力边 from = `memberKey`；任务 / 规划 / 定时面板成员选项按实例投影；
- run-store：turn:start/end 优先 `memberKey`（消息 + 状态 + 队列）。

### 105.5 验证

- server `tests/m77-soul-instances.test.ts` **17 例**（解析 / token 边界 / **裸名=主实例** / **显式全伞双 token** / 创建与邀请校验 / 换装冲突 / 分身键替换 / 移出 / fork / 装配指南 / 引擎点名与全伞 / 并行波多实例同波 / 运行中换装队列同步 / 自描述回退署名 / 预览 memberKey / 席位迁移）；
- client `tests/m77-soul-instances.test.tsx` **21 例**（成员视图与编解码 / 回退标签 / 幽灵补位 / 组队台多选 payload / 成员卡换装与移除 / 气泡与点名 / Composer 实例条与插入 / **「全部 N 位」全伞条目** / run-store 归口 / 图谱 / 分身菜单未占用过滤 / 战绩实例归口 / 回退与预览 / 接力链与提意见）；
- e2e `m77-soul-instances.spec.ts` 2 条（多魂建编 → 点名 → 换装 → 显式全伞；会话内追加分身与同魂冲突拒绝）；
- 门禁：双端全量单测 / eval 基线 / check:agents（QUALITY_STRICT）/ check:skills 零回归（实跑账见 CHANGELOG）。

### 105.6 续完善（同批收口）

- **自描述回退标签**：成员键内嵌灵魂使「历史归属」不随实例动作丢失——已移除 / 已换键的实例（`luna~zen`）在消息、点名 chips、接力卡、路由上下文等处仍还原 `名字·灵魂名`（client `labelOfMemberKey` / server `memberLabelOf` 同一回退链）；经典键不补默认灵魂后缀，资产删除回退角色名；
- **幽灵补位**：`memberDisplayList(agents, session, extraKeys)` 统一面板成员选项——把历史计划作者 / 步骤负责人 / 评审人 / 定时目标等已离场引用键补成可读条目（计划卡 / 任务面板 / 定时面板不再裸秀 memberKey）；
- **实例级统计**：战绩（StatsView `computeStats` 按 `memberKey` 归口，分身各自入榜/计数/被 cue）与迷你档案（MiniDossier 按成员键统计与署名，交接对象过回退标签）均按实例呈现；
- **单实例 token 口径澄清**：`名字·灵魂名` 仅在同角多实例在场时生成（展示与解析同源）；单实例（含仅一个分身实例）一律裸名——因此「@卢娜·禅意」仅在同角 ≥2 实例时可用；
- **UI 打磨**：编制行窄栏换行（`flex-wrap` + 中间块 `min-w-[104px]`）、名录页灵魂变体区标注「可同台」用法提示；`+ 分身` 菜单 Portal 化后的外部点击判定需排除菜单自身。

### 105.7 展示面兜底（成员键全消费端审计）

对全客户端按「基础 id 解析」的展示点做了一次系统审计与收口——原属基础角色的展示点保持不变（工件作者 / 记忆 / 审批 `/计划列表/列表摘要的 agentId 兼容），其余展示面按成员实例渲染：

- **波次层**：并行组组头（WaveGroup）与悬浮阶段条（WaveStrip）署名改为实例（`卢娜·狂野、卢娜·禅意`）、头像仍取基础角色；组头订阅的成员键改为 `memberKey ?? agentId`（分身入组头）；对决分侧（PK-1）仍用基础角色 ids（席位声明口径不变），分栏映射同步改用 base 列表；
- **消息导航条**（MessageRail）与**「下一棒」热身行**（ChatArea）：署名过回退链；
- **场景层**：`SceneStage.agentOf` 升级为成员键容忍（在场实例预生成显示克隆并缓存引用稳定 → 席位 / 卡片 / 时间轴 / 取数链一次性全解）；`scene/derive` 的 `containersOf.messageAgentId` 与 `sqlRunsOf.agentId` 改成员键；`wavesOf.memberIds` / `useSceneData.speakingId` 保持基础角色（席位高亮比较口径）；
- **面板层**：TaskView / PlanReviewCard / SchedulePanel（含卡内目标署名）/ MiniDossier / StatsView / GraphView（接力摘要、工件按 base 匹配）统一走 `labelOfMemberKey` 或幽灵补位；
- **列表层**：`SessionSummary.lastMessage.memberKey`（迁移 v20 列已具备，仅 SELECT 增列）→ 会话列表预览署名可分辨实例（存量行为 NULL → 回退角色名）。

### 105.8 运行台账与交互面收口

- **运行台账随席位移交**（`engine.replaceMemberKey`）：队列 / 波内进行中 / **已发言史 spoken** / **未消费交接提案 pendingHandoffs.targets** / 交接便条 handoffNotes 五处同步——`spoken` 迁移防同席位借换装在同一 Run 内重复出手（fallback 选人不再把新键当未发言者）；提案目标改写防旧键经「资产存在」路径被平台重新召集（幽灵复活）；队列去重幂等；已落库发言史不追溯；
- **接力链 / 接力卡**：TeamPanel 步骤与镜像卡头像按成员键显示克隆（`memberAgentOf`，单实例零外观变化）——接力进度链同角双实例各自成节点、与队列键同源命中「当前高亮」，节点 title 走回退链；
- **提意见草稿**（AF-3）：@ 署名改成员实例（分身 = `名字·灵魂名`，草稿点名到具体实例；无键退化纯引用模板）；
- **回归面**：m12-interactions（进度链 + 迷你档案）E2E 已在验证集内。

### 105.9 画布层收口（最后审计盲区）

全仓横幅扫描补出的画布层（CanvasComposer，前几轮未覆盖）缺口，一并收口：

- **成员召唤条**：原按基础 id 解析 participantIds——分身键解析失败被过滤，极端情况下（仅分身入编）回退为「全体角色」错误列表；现走成员实例投影（id = 成员键、name = 标签），召唤插入 `@名字·灵魂名` 点名到具体分身；
- **运行状态条**：queue 首位的发言人署名改实例标签（分身不再回退「协作进行中」）；最近回复摘要署名同改；
- **近期消息浮层**：署名按实例；头像取基础角色；运行态徽标改按成员键读 statuses（原按 agentId 读，分身流式态恒 idle）；
- 边界重申：画布节点作者（node.by = 基础角色）与系统事件条头像保持角色级（文本已含实例标签）；死代码清理：`lib/members` 移除无消费方的 `instancesOf` / `presentSoulIds`。

### 105.10 口径修订：裸名 @ = 主实例（全伞改显式）

规划期曾选定「裸名 = 全伞」，收口评审后修订为「裸名 = **主实例**（编制序首位）」——判据：

1. **最小意外**：单实例会话中点按 `@名字` 的习惯，不应因中途追加分身而静默变为多人触发（编制首位在换装 / 增删后仍稳定指向该角色的首个实例，含分身键替换场景）；
2. **默认动作代价不对称**：误触全伞 = 意外 N 轮 / 整波并行（token 与注意力双耗）；误触主实例 = 1 轮，可立即纠偏；
3. **显式优于隐式**：界面从不展示「裸名会触发全员」这条规则（多实例展示一律 `名字·灵魂名`，与解析同源）；全伞改为 Composer @候选中的「名字（全部 N 位）」条目——一键插入逐一点名多 token（`@卢娜·狂野 @卢娜·禅意`），零新语法、草稿可编辑；
4. **模型侧口径同步**：L3 寻址指南改写为「@名字 只召集主实例；想让同角多位分身同时上场请逐一点名」；
5. **回归面**：单实例行为零变化（裸名直达；仅多实例场景的语义收敛）；e2e 因 mock 动态接力链无法区分队列差异，精确断言在 server 单测（waves 数 / 灵魂序列 / mentions 持久化）。

## 106. console 面板二批——客户管道 · 经营指标 · 节奏 · 融资进度与问答 · 主张与依据（批六）

全场景深度优化批六的落地：console 面板（dock 右区）全量场景分支补齐——ADR 0169 边界遗留项「sales / finance / funding / ops 的 console 面板专业化不在本批（另批评估）」的正式闭环（bi / sre 分支由 M66 已落；finance 为 stream 无 console，Ops 经 minutes/checklist 已覆盖）。决策见 ADR **0177**；编号让位：ADR 实际落 **0177**（0171–0176 于落盘窗口被并发批次连续占用——堪舆 v2 / M77 多魂 / 命理深化），design.md 实际落 **§106**（§105 为并发 M77 章节）。

### 106.1 场景分支矩阵（有容器数据才渲染对应段）

- **sales**：「客户管道」——`::: pipeline` 容器 → 阶段列（线索/意向/报价/成交 + 未知归「其他」，与消息卡同口径）+ 列头「N 家 + 金额合计」（`numberWithSuffix` 可解析行才计入；全不可解析不显示）+ 点卡定位；
- **ecommerce**：「经营指标」（kpi → KpiCells 复用）+「大促节奏」（timeline → 节奏行，第三列 = 节点徽标）；
- **marketing**：「内容节奏」（timeline → 节奏行，第三列 = 渠道/负责人徽标）；
- **legal-personal**：「案件时间线」（timeline → 节奏行，第三列 = 节点类型）+「主张与依据」（claim → 标题 + 条目（主张 + 依据）；条目层单一解析）；
- **funding**：「融资进度」（`::: progress` → **ProgressCard 同组件渲染**）+「投资人问答」（`::: qa` → **QaCard 同组件渲染**）——各带「定位」回源。
- 通用时间轴让位规则自 sre 扩展至节奏场景（有专用时间轴段时通用「活动时间轴」不重复渲染；容器缺席回落——既有口径保持）。

### 106.2 单一解析补全（ADR 0144 红线）与内部收敛

- 新导出 `parseClaimLines`（列表标记双重剥离无害；细节/元信息行跳过——与卡上消费口径一致）；`finalizeClaim`（mdast 路径）重构为共用——claim 容器自此 remark / panel 双路径同源；
- `KpiCells` 内部组件提取：bi 指标 / sre SLO / ecommerce 经营指标三处 kpi 网格收敛（DOM 与 M66 分支完全一致，attrs 由各分支 wrapper 保留）。

### 106.3 验证与收口账

- 组件测：`client/tests/console-scenes.test.tsx` 9 例（parseClaimLines 纯函数 / sales 阶段列 + 未知归「其他」+ 合计 + 定位 / 非目标场景零变化 / funding 同组件渲染 + 定位 / 节奏段三场景 + 让位 + 回落 / legal 主张与依据 / claim 卡渲染回归）全绿；
- 回归：m43-cards + m66-analysis-console + m52-stage + m69-md-ext 共 **110/110 ✅**（claim 重构与 KpiCells 提取零回归）；
- E2E：新增 `e2e/console-scenes.spec.ts` 5 条（销售管道 / 电商指标+节奏 / 市场内容节奏 / 法务时间线+主张 / 融资进度+问答）隔离窗口实跑 **5/5 ✅**（`PW_PORT=8795 PW_DATA_DIR=e2e-m40 PW_OUTPUT_DIR=/tmp/pw-b6`）；`playwright.config.ts` main 白名单补 `console-scenes`；
- mock：两组新触发块（「店铺走查」/「案件走查」）；marketing 由 content 基础剧本自带 timeline（零改动）；sales / funding 复用 M41 触发块；
- 门禁（本批实测）：eval **36/36 ✅**；check:agents（strict）**165/165 + 协议 41/41 ✅**；check:skills（strict）**61/61 ✅**；client 全量 **104 文件 / 1193 例 ✅**；server 全量 **103 文件 / 1294 例 ✅**；ESLint 改动文件 0 错（含顺手清理 ConsolePanel 存量未用导入 LayoutList）；typecheck——本批文件 0 错，唯一 2 处错误在 `team/GraphView|SchedulePanel`（并发会话 M77 域**落盘前 3–14 秒**的中间态，与 M57 窗口一度排除；非本批影响面）。
- 文档：ADR **0177**、CHANGELOG **v89**、`docs/adr/README.md` 索引、`docs/scene-chat-design.md` §9 落位注记（遗留项闭环）。

## 107. 家装设计工作室与风水阳宅——3D 空间设计 · 效果图链路 · 堪舆点评 · 择日与罗盘盘面（M65–M66 全批 + v2/v3 续）

家装设计工作室与风水阳宅专项的落地（设计基线 [docs/design-studio-design.md](docs/design-studio-design.md) v1.2；评审五项：风水独立成场景 / 择日 v1 不做（v2 已补）/ 方案书轻量打印 / 3D 锁定家装空间 / 媒体连接未配置保留扩展）。实施六批 + 三续：**M65-B0** 接装（three@0.175 / R3F 8.18 / drei 9.122；three-stack gzip 230.82KB ≤ 240KB 预算）、**M65-A** 资产（interior 场景 / 成竹·规方·塑光）、**M65-B** 3D 基座（DesignScene v1 契约 + 2D/3D 双视图 + design-scenes 通道）、**M65-C** 交互链路（layout / styleboard / render 三容器族 + 三卡片 + 工作台打开通道 + 快照入库 + 方案书打印）、**M66-A** 风水资产（fengshui 场景 / 司南·察隅 / luopan_pan 工具 golden 5 / 禁词四层扫描）、**M66-B** 盘面（luopan 第五盘卡：三环罗盘 + 八宅·飞星双盘 + 合规色带 + 九宫叠图）、**v2 三件**（zeri_pan 择日盘（建除十二神 + 冲煞 + 1–5 评分；日历基础域双锚 golden）/ 兼向判定（±4.5° 下卦带，仅 A 级）/ 叠图旋转对齐）、**v3** 自动找正（指北交互 + 快照识别）。编号让位：预定 §102/§103 于落盘窗口被并发批次（M44 核心交付锚点 / M41 服务型渲染包）占用 → 实际落 **§107**；ADR 0167（M65-C）/ 0168（M66-A）/ 0171（M66-B）/ 0175（v2）/ 0178（v3）；CHANGELOG v82 / v83 / v85 / v88 / v90。

### 107.1 场景与角色（2 场景 / 5 角色 / 3 技能 / 2 预设）

- **interior 家装设计工作室**（dock · studio 面板——第 7 类面板）：成竹（设计主案）/ 规方（空间规划）/ 塑光（3D 可视化）；技能 interior-design / 3d-visualization；预设「家装全案设计」；
- **fengshui 堪舆阳宅**（dock · chartboard）：察隅（户型解析——三态标注 + 坐向分级采集）/ 司南（堪舆判读——先盘后论 + 四维评述 + 改善参考 + 择日）；技能 fengshui；预设「入宅联审」（跨场景：察隅 → 司南 → 筑居）。

### 107.2 技术基座与容器族

- **3D 栈**：three.js + R3F v8（React 18 锁线）+ drei；懒加载唯一入口 studio-lazy（three-stack 独立 chunk）；DesignScene v1（mm 单位 / 俯视坐标北 = −Z / 13 类家具程序化族）；
- **三容器族**：`::: layout`（房间三段 + 方案源）/ `::: styleboard`（色卡 + 质感）/ `::: render`（键值 + 产物）——卡片五模式交互（回填 / 复制 / 流式禁用等，v57 纪律）；
- **盘面扩展**：PAN_KINDS 第 10 类 `luopan`（三环罗盘 / 双盘 / 宫位详情 / 叠图 tab）+ 第 11 类 `zeri`（推荐 chips / 星级 / 回填）；「::: pan luopan」先盘后论整卡。

### 107.3 风水工具化与合规

- **luopan_pan**（二十四山 / 八宅坐山派大游年歌 / 三元九运 + 流年入中星 / 洛书顺飞）+ **zeri_pan**（建除十二神 + 冲煞 + 评分；历法基础域 JDN / 日干支双锚 golden）；deferred + 只读 + 禁止心算兜底；
- **合规四层**：协议红线（不承诺吉凶必应 / 禁恐吓 / 数据分级 A/B/C / 流派口径显式）+ 禁词四层扫描（协议·人设·技能·mock，规范句豁免）+ 破日「诸事慎用日」表述 + 精度声明（近似节气 ±1 天）。

### 107.4 验证与收口账

- client 全量 **104 文件 / 1195 例 ✅**；server 全量 **103 文件 / 1294 例 ✅**；E2E `m65-studio` 1/1 + `m66-fengshui` 2/2（含 v2/v3 全链——择日卡 / 附件 / 叠图 / 旋转 / 指北）；eval 35/36（+interior +fengshui 任务；1 红为 M63 外部批中间态）；check:agents 165+41 / check:skills 61/61（strict）；
- **E2E 定式沉淀**：虚拟列表「回到最新」浮标轮询（jumpToLatest）；隔离跑（PW_PORT / PW_DATA_DIR——防常驻旧 mock 进程被 reuse）；先切对 tab 再点格（双盘断言）。

- 文档：ADR **0167 / 0168 / 0171 / 0175 / 0178**、CHANGELOG **v82 / v83 / v85 / v88 / v90**、`docs/design-studio-design.md`（专项基线全实施注记）、eval tasks `33-interior` / `34-fengshui`。

## 108. M45 轻回放——波次回放条（批八）

全场景深度优化总账的最后一批（条件性批次主动推进）：`docs/scene-chat-design.md` §13 M45 原案 R-1 落地（ADR 0081 预定口径正式兑现）；R-2 互动统计后端化**触发条件未出现**（无跨会话统计 / 审计需求信号）——维持条件性；R-3 面板联动扩展声明为**既有覆盖收敛**（「场景卡 → 面板定位」已由各面板定位按钮与 pool 定位普遍化）。决策见 ADR **0179**；编号让位：ADR 实际落 **0179**（0178 于落盘窗口被并发 M66-v3 占用），design.md 实际落 **§108**（§107 为并发 M65–M66 章节）。

### 108.1 派生与组件

- 新文件 `client/src/lib/wave-replay.ts`（纯函数）：
  - `waveNodesOf`——`waveOf` 唯一 `runId~turnIndex` 首次序（wave-sep 与成员行同源去重）；**单条波次成节**；锚点 = 本波首条成员消息；空锚点跳过；
  - `activeWaveIndexOf`——首个可见行起向前扫描的活跃波次序号（与悬浮阶段条同源）；
  - `createTrailingThrottle`——leading + trailing 150ms（连点合并尾沿最新；卸载 cancel）；
- 新组件 `client/src/components/chat/WaveScrubber.tsx`：**≥2 波**时在 Composer 之上常驻细条——`回放` 前缀 + prev/next + 数字刻度（点选跳转）+ 计数（`第 x/N 波` / `共 N 波`）；当前波高亮；端点禁用；
- ChatArea 挂载：跳转 = `focusMessage`（滚动 + 闪光复用——**不重建历史 UI 状态**，ADR 0081 边界）。

### 108.2 验证

- 单测：`client/tests/m45-replay.test.tsx` 10 例（waveNodesOf 去重/单条成节/锚点/计数 · activeWaveIndexOf 同源扫描与越界 · createTrailingThrottle leading+trailing/cancel · deriveRows 集成（结构键 → 节点）· WaveScrubber 刻度/高亮/计数/端点禁用/连点合并）全绿；
- E2E：新增 `e2e/m45-replay.spec.ts` 1 条（星象占星 + `disableSerial` + 全员 @ 两波 → 2 刻度 → 双击刻度两次闪光复用 + prev 端点禁用）实跑 **1/1 ✅**；`playwright.config.ts` main 白名单补 `m45-.*`；
- 域回归：m45-replay + m37-scene-chat ×2 + m12-interactions（ChatArea 关联面）隔离窗口实跑 **4/4 ✅**；
- 门禁（本批实测）：eval **36/36 ✅**；check:agents（strict）**165/165 + 协议 41/41 ✅**；check:skills（strict）**61/61 ✅**；client 全量 **105 文件 / 1214 例 ✅**；server 全量 **103 文件 / 1296 例 ✅**；ESLint 改动文件 0 错；
- E2E 口径踩坑（已沉淀 ADR 0179 边界）：并行场景须 `disableSerial` + 全员 @ 才收敛单波；短会话 align:center 下活跃序号可能钉在第一波——断言以「跳转触发 + 闪光」为准。

### 108.3 总账收官声明

本批之后，全场景深度优化 8 批总账**全部闭环**：批一 M38（§92）· 批二 M39（§97）· 批三 M44（§102）· 批四 M41（§103）· 批五 M40（§104）· 批六 console 二批（§106）· 批七编制增补（由并发 M69 批次落地——sre 试雷 / bi 正尺等补强角色）· 批八 M45（本 §108）。M45 R-2 为唯一维持条件性的事项（触发条件写入 ADR 0082 / §13.2）。

## 109. 外部技能与 MCP 安装批——8 技能 + 9 台免 Key MCP 服务器

用户发起的一次性资产扩张：按「当前全部 agent 定义」（165 角色 / 41 场景）从 GitHub / 官方生态检索适配的 Skill 与 MCP，**免 Key 口径**（需要 API Key 或身份声明的候选一律不装），逐个安装并逐个验证。技能适配仍按 ADR 45 改写为「本仓工具可执行」方法论；MCP 走 M28 `mcp.json` 文件权威直配（ADR 53 安全模型不变）。

### 109.1 技能清单（8）与来源

| 技能 | 外部来源 | 预载角色 | 定位 |
|---|---|---|---|
| literature-search | ykdojo/paper-search（OpenAlex 口径） | lit-reviewer · scout | 检索式构建 + 文献矩阵 + 综述结构（API 用法含 OpenAlex / arXiv / Semantic Scholar） |
| natural-writing | conorbronsdon/avoid-ai-writing | editor · content · paper-editor | 去 AI 腔 14 类特征 + 替换表 + 两遍改写 |
| test-driven-development | obra/superpowers | backend | 红-绿-重构 + 防假绿断言质量 |
| secure-coding | agamm/claude-code-owasp + Trail of Bits | security · ai-engineer | OWASP Top 10 检查表 + 密钥纪律 + AI/MCP 特有风险 |
| brand-naming | glacierphonk/naming | brand · account-strategist | 隐喻驱动发散 + 筛选矩阵 + 谐音安检 |
| translation-quality | HoraceLuBFA/en-zh-translation-polish | localizer · ux-writer | 翻译腔 10 类 + 术语表先行 + 回译核对 |
| user-persona | takechanman1228/claude-persona | ux-researcher · influencer | 行为变量分群 + 画像卡 + 概念反馈矩阵 |
| health-metrics | huifer/Claude-Ally-Health | 健康 3 角色按需（生活场景不硬配） | 指标趋势 + 体检口径 + 红线升级（非诊断） |

- 分组登记：研发工程 +2 / 研究与验证 +2 / 营销增长 +1 / 写作沟通 +2 / 生活沟通 +1；命理占星补登存量 fengshui（README 分组表此前漏登）；技能总量 61 → 69，`check:skills`（strict）69/69；
- 预载接线 14 个角色（均在 ≤4 上限内追加；m21 断言同步 4 处：security / content / brand / localizer）。

### 109.2 MCP 清单（9 台）与配置

`mcp.json`（仓库根，source='json' 文件权威；启动同步 + 5s mtime 轮询自动落地）：

| slug | 来源 | 传输 | 工具数 | 关键配置 | 授权角色（`mcp__<slug>__*`） |
|---|---|---|---|---|---|
| sequential-thinking | 官方参考服务器 | npx stdio | 1 | readOnly | 战略 4 / 研究 4 / 辩论 4 / 模拟法庭 3 / 投研 5 |
| memory | 官方参考服务器 | npx stdio | 9 | MEMORY_FILE_PATH → data/mcp/memory.json | 研究 4 / tutor / coach |
| time | 官方参考服务器 | uvx stdio | 2 | readOnly | travel 3 / assistant |
| weather | weather-mcp/weather-mcp（MIT） | npx stdio | 12 | 公制 + 24h + standard 工具集 | travel 3 / fitness / wellness |
| markitdown | microsoft/markitdown | uvx stdio | 1 | timeoutMs 120s | 法务财务族 7 + datroom-keeper + 学术 3 |
| deepwiki | Devin（HTTP 免 Key） | http | 3 | — | 研发 9 角色 |
| context7 | Upstash（HTTP 免 Key） | http | 2 | — | 研发 9 角色 |
| arxiv | blazickjp/arxiv-mcp-server | uvx stdio | 19 | --storage-path → data/mcp/arxiv | lit-reviewer / scout / verifier |
| yfinance | nrempel/yahoo-finance-mcp | npx stdio | 6 | readOnly | 投研 5 + valuation-modeler |

- 全部免 Key；需要 Key / 身份声明的候选（GitHub PAT、高德、Brave、SEC UA 等）按用户口径**未安装**；
- 只读服务器用 `readOnlyOverride: 'readonly'`（并行 + 缓存 + 免审批门）；memory / arxiv 保留默认写类策略（写类走审批）；
- 安装台账（验证）：9 台逐一真实握手成功（合计 **55 工具**）；app 侧日志确认全部 `MCP 服务器已连接`（含 markitdown 首装超时后重连复位）；
- 可达性：tools wildcard 接线 **50 个角色文件**；未绑定会话不可见（M27 最小权限语义不变）；general 既有 `mcp__*` 通配维持（可达矩阵守护语义同 m27-mcp E2E）。

### 109.3 验证与镜像面

- `check:skills`（SKILL_STRICT=1）**69/69 ✅**；`check:agents` **165/165 + 协议 41/41 ✅**；eval（mock）**36/36 ✅**；
- 测试同步：m21 技能断言 4 处；context.test.ts 预算夹具 14k → 15k（69 技能索引增重，实测 14.2k±）；m35 运行时绑定用例跳过 MCP 通配条目（格式守卫保留）；
- 镜像面：agents/README.md（统计 162→164 业务角色、69 技能分组、预载表 14 行、MCP 工具条目）；agents/CHANGELOG v92；本 §109。

### 109.4 边界与后续

- 会话级绑定后才对模型可见（会话头部「资源」入口 / MCP 管理台）；未绑定 = 零暴露；
- 第三方 MCP 视同不可信代码（ADR 53）：env 白名单、审批门、会话绑定三层不变；
- 后续可选：需要 Key 的服务器（GitHub / 高德等）在用户提供凭据后按同一 mcp.json 通道追加。

## 110. 报告专业化——交付规格闭环（v93）

**动因**：交付件不够专业、报告偏短或不完善。根因五层定位：①篇幅语义缺位（协议 200 字约束未区分对话与交付件）；②深度标准未量化（交付契约只有章节结构）；③长报告单次成文写不完（单次输出上限 + 无追加工具）；④无落盘质量信号与验收；⑤素材无沉淀。结论：不新增「写作 Agent」——横切三层（规格 / 工具 / 体检）改造（ADR 0182）。

### 110.1 四档规格（协议一等公民）

全局 `_protocol.md` 新增 `<deliverable_spec>`：「简短优先」限缩为对话发言（交付件不受 200 字约束）；四档 = 速览 ≤800 / 标准 1500–4000 / 深度 ≥4000（分章 + 图表 ≥2 + 来源编号 + 附录）/ 专项多件套；档位优先级 = 用户显式 > 计划验收 > 角色契约默认；分章撰写纪律（骨架占位 → 逐节填充，深度档禁止单次成文）+ 量化自检 + 报告可独立成立。

### 110.2 规格注入（引擎）

`context/deliverable-spec.ts`：会话级粘性解析（倒序扫用户消息：速览/简报/快评 vs 深度报告/详细报告/深度研究/尽量详细…；宽词「深入」不入表防误伤）→ execute 回合指令末行注入档位行（未声明不注入）；`PreparedTurn.deliverableSpec` 透明给引擎 → 深度档回合工具步数上限 8 → 12。

### 110.3 分章撰写（append）与落盘体检

- `write_file` 增 `mode=append`（空行衔接；不存在等价新建；dry-run / summary / diff 全链适配）；
- `util/doc-metrics.ts`：非空白字符 / 二级章节 / 表格 / 来源标记（URL + 「来源：」+ [编号]）单一实现；Markdown 落盘后体检指标随工具 detail 回灌（模型对照档位自检）；
- 体检与断言同口径：`assertions.ts` 三断言（`min_chars` / `min_sections` / `min_sources`，四处同改）复用 `measureDoc`。

### 110.4 资产三层与评测锚定

- 技能 `report-authoring`（+1 = 70）：四档表 / 分章流程 / 六类领域章节库（研究 / 投研 / 行业 / 经营复盘 / 决策方案 / 议题简报）/ 量化自检 / 反模式；
- 16 角色（research×4 / invest×5 / strategy×4 / bi×3）交付契约量化（默认档 + 下限 + 降档裁剪规则）+ 预载；README 预载表与分组同步；m21/m30 断言 6 处同步；
- eval：research / invest golden 补规格断言（按 mock 实测定标：130 字/4 节、300 字/6 节）；
- 测试：新 `tests/deliverable-spec.test.ts`（4 例）+ tools append/体检 + m9 断言用例；context 预算夹具 15k → 16k（实测 15.0k±）。

### 110.5 验证与边界

- 评测账（v93）：check:agents strict **165/165 + 协议 41/41**；check:skills strict **70/70**；eval **36/36**；server **106 文件 / 1328 例**；client **106 文件 / 1224 例**；四包 typecheck 0 错；E2E 定向 m34-invest + m50-blank **4/4**；
- **真实模型探针（v93 续，`--real` 设施）**：eval 支持 `--real`（真实模型执行 `real:true` 探针任务，不参与 mock 基线，`--keep` 保留工作区）+ 探针任务 `depth-report-spec`。三轮实测帐：骨架 559 字（回合耗尽）→ 10279 字（口径盲区两红）→ **13947 字 / S01–S20 / 占位 0 / judge 8 全绿**；实测修正三项：关键词表补「深度档」、min_sources 口径支持 `S-01`/裸编号（doc-metrics 共用）、体检增占位残留警告；探针任务 maxTurns 16（真实深度链预算）；三轮成本约 $2；
- **探针组扩编（v93 续）**：`invest-depth-report`（4 人链，6/7：报告 13355 字 / 8 章 / 13 表 / 四件交付件齐全；judge 6 扣于降级场景一手核验深度）+ `bi-monthly-analysis`（3 人链 + `seedFiles` 播种 CSV，5/6：17847 字 / 10 章 / 23 表）；三探针组就绪；任务侧纪律：`MAX_TOOL_STEPS=16` + 「不因口径待确认阻塞」；
- **交付件体检徽章（v93 续）**：`shared/src/doc-metrics.ts` 单一实现（server / eval / client 三端同口径）；ArtifactsView Markdown 预览体检条（字数 / 章节 / 表格 / 来源 / 占位警告）；
- 未实施（列后续）：专项档解析关键词、素材池（`docs/素材-<主题>/`）、L3 自动评审联动、体检未达标强制补全回合（先行观测再评估——探针实测已部分验证回灌提示对占位清理有效）；编排层实测观察（PRS 扩编一棒制 / 回合预算被探索耗尽 / 口径阻塞自锁）另批评估。

## 111. dock 右区宽度自适应——默认容器 1/3 · 上限最多一半 · 双击复位回自适应（批九）

用户实测反馈（两栏 dock 截图）：固定宽度口径不适应窗口——默认 360px 在宽屏下偏窄（盘面 / 看板阅读局促）、上限 640px 写死（宽屏无法继续拖宽、窄宿主又近乎占满）；诉求原话「这种两栏的可以优化下宽度，支持拖动到最大为1半默认可以增大点宽度或者根据实际窗口自适应等等」。本批把宽度口径整体改为**相对容器**：默认 = 容器 1/3、上限 = 容器一半（「最大为 1 半」，左对话区恒保 ≥50%），双击复位回自适应态。**纯前端微批**（零服务端 / 零资产 / 零协议），决策见 ADR 0183（修订 0127 的固定 clamp 280–640 口径；**编号让位**：§110 / ADR 0182 / v93 已被并行批「报告专业化」占用）。

### 111.1 宽度口径（persist.ts）

- 上限 `dockMaxW(容器) = max(280, ⌊容器 × 0.5⌋)`——右区最多占两栏区一半；默认 `dockDefaultW(容器) = min(clamp(round(容器/3), 380, 600), 上限)`——1280 宿主 ≈ 426 / 1440 ≈ 480 / 1920+ 600 封顶（宽屏较旧固定 360 明显变宽，窄宿主不挤占对话区）；生效宽 `clampDockW(宽, 容器)` 收敛到 [280, 上限]；
- 存储偏好语义升级 `DockPref.width: number | null`：null = 自适应（按容器比例，双击复位回到此态）；数值 = 拖拽 / 键盘显式宽。旧固定默认 360 在 `loadDockPref` 迁移为 null（未拖宽用户升级即获自适应默认）；存储只做下限护栏，上限在渲染期动态收敛——窗口临时压窄不写回存储，放宽后恢复原意图。

### 111.2 宿主与交互（DockStage）

- ResizeObserver 观测 `.scene-dock`（`useLayoutEffect` 挂载即量测 + 变更回调）：窗口缩放 / 会话栏开合 → 上限与自适应默认跟随（无 RO 环境以视口宽兜底首帧，量测为正才采用）；
- 拖拽（ref 直改零 React 渲染 + 抬手落盘）/ 双击复位（→ null 跟随窗口）/ 键盘 ← →（16 / Shift 48px）三入口共用同一动态口径；把手 aria：`aria-valuenow` 报生效宽、`aria-valuemax` 随容器收敛（不再固定 640）；
- `.scene-dock-aside { max-width: 50% }` CSS 硬上限兜底（JS 收敛之外的当帧保证：窗口骤缩 / 存量偏好超限）；折叠 / 关闭 / reopen 与首帧估计等既有链路零变化。

### 111.3 测试与门禁

- client `m52-stage` +4 例（58 → 62 ✅）：纯函数口径（上限半屏下取整 / 默认 1/3 双护栏 / clamp 收敛，8 断言）；存量迁移（360 → null / 720 保留 / 非法回落 280）；默认渲染 380px + 把手 aria（min 280 · now 380 · max 512）；超限收敛（存储 5000 → 渲染 512）+ 存储不改写 + 双击复位 + 键盘 ← 调宽（396 落盘）；
- E2E `m52-stage` 新增「批九 · dock 右区宽度」1 例：真实浏览器默认自适应（≥380 且不越半屏）→ 拖拽到容器最左缘 = 容器一半（±2px）→ 双击复位（±1px）→ 视口 1680 → 2400 变宽自适应跟随增大；同 spec 全量回归（含 M58 折叠 / 关闭全链与逐场景走查）—— 隔离环境（8795 / e2e-dockw）运行；
- typecheck（client + e2e）0 错误；ESLint 改动文件 0 错误。

### 111.4 边界与后续

- 窄屏（<900px）dock 右区走底部抽屉降级（§7.3-4），本口径不参与；容器 <560px 时上限退化为下限 280（半屏 < 280 以 280 为准，属极端宿主宽度）；
- 上限随 `.scene-dock` 实测宽自动跟随——宿主结构调整无需改代码；右区未来若改多面板并排 / 可拖分栏，需重估「单把手 + 单宽意图（number | null）」模型；
- 存储 `ma:sc:dock.width` 旧值全兼容（数值照旧 / 360 迁自适应 / 非法回落 null），无迁移脚本。

- 镜像面：`docs/scene-expansion-design.md`（§7.2 dock 行 + 头部修订注记 / 专项账）、ADR 0183 + `docs/adr/README.md` 索引、`agents/CHANGELOG.md` v94。

## 112. SSH「本地」预置——新建表单一键填入（连接中心微批）

新建 SSH 连接需逐项手填主机 / 端口 / 用户名 / 认证方式；「连本机」是开发与演示的最常见起点，但本机用户名、默认私钥路径、sshd 是否在监听都要人工查（macOS 默认不开启 sshd，需系统设置开「远程登录」）。本批给「连接管理 → 新建 SSH」加「本地（本机）」一键预置：服务端探测本机默认配置回填表单（凭据字段不动），决策与被否决方案见 ADR 0185。

- 探测（`server/src/connections/ssh/local-preset.ts`；`homeDir` / `env` / `username` / `probePort` 全可注入，单测零触网）：用户名 = `os.userInfo().username`（极端环境回退 `USER` / `USERNAME`）；认证优先级 agent（`SSH_AUTH_SOCK` 非空）> key（`~/.ssh` 默认私钥按 ed25519 → rsa → ecdsa 序，`~` 形式回传、由连接器既有 `expandHome` 展开）> password；22 端口 TCP 探测（600ms 超时，connect / timeout / error 三路收敛布尔，不抛错）；
- 端点：`GET /api/connections/ssh-preset`（adminOnly，注册先于 `/connections/:id` 防被 id 参数吞没）→ `{ preset: { name, host, port, username, authMethod, privateKeyPath?, agentAvailable, sshdReachable } }`；
- 前端（新建态专属）：表单顶部「本地（本机）」chip → 回填 name（仅在名称为空时）/ host / port / username / authMethod / privateKeyPath；行内提示探测结论（认证方式 + 22 端口未监听时给系统「远程登录」指引）；不代建连接（用户审阅后「保存 / 保存并测试」），`allowExec` 保持默认关；
- 验证：server `tests/m23.test.ts` 27 例（+5：探测默认键 / 认证优先级与私钥候选序 / 端口探测参数 / 路由形状 / 路由不被 `:id` 吞没）；client `tests/m23-frontend.test.tsx` 15 例（+1：一键预置回填与提示 + 保存载荷契约）。

- 镜像面：`docs/api.md` §11.1（端点行 + config 约定）、ADR 0185 + `docs/adr/README.md` 索引、`agents/CHANGELOG.md` v96。

## 113. 塔罗抽牌台——仪式化亲手抽牌与公版韦特牌面（M78）

M69 交付后塔罗抽牌是 AI 单方行为（用户只能看 `::: cards` 卡），与「塔罗研习」的参与感相背（用户诉求：交互性 / 可玩性 / 趣味性 / 亲手随机选牌 + 好看的完整卡片 / 专业卡牌）。本批给 tarot 场景补齐**亲手抽牌台**：复刻摇卦台（M54-C）已验证的「亲手仪式 → 交复现参数请解 → 工具复算逐位核对」模式，叠加 78 张公版韦特牌面视觉与研习设施；合规口径继承协议铁律与 `pan/trail.ts` 无奖励机制先例。决策与被否决方案见 ADR 0187；专项设计（交互详设 / 素材映射 / 合规自检 / 批次）见 `docs/tarot-ritual-design.md`。

- 抽牌台（`md-ext/tarot/TarotRitual.tsx`，全局宿主挂 AppLayout）：六阶段状态机 idle（静心：牌阵 + 所问）→ shuffle（洗牌，种子公开）→ cut（三堆点选置顶）→ draw（78 格牌背网格亲手选牌；roving tabindex / 撤销 / 牌位语义提示）→ reveal（逐张 3D 翻牌 600ms + 逆位落定）→ complete（复现参数 + 牌组构成事实 + 请解 / 同参数重放 / 重新洗牌）；进度存 `ma:tc:ritual` 只记参数与进度（关闭 / 刷新可续，与摇卦台同口径）；
- 诚实参与（选择即结果）：点选格位直接进 `picks` 复现参数（不做假交互）；正逆位在洗牌阶段一次性为 78 张定妥（「牌带正逆位」），切牌旋转与选牌只搬运不重置；本地牌面与工具复算逐位同源（`deck.ts` ↔ `server/src/tools/tarot.ts`，含 mulberry32 常数），正式牌面一律以工具复算为准；
- 工具扩展（`tarot_draw`）：增可选 `cut`（0/1/2 = 第 c 堆放最上）与 `picks`（不重复 0-77 整数，长度 = 牌阵张数，牌位序 = 点选序）；缺省（0 / [0..N-1]）与旧版逐位一致（m69 golden 不动）；summary / detail 追加复现三元组行；`::: cards` 卡模板契约不变；
- 牌面视觉（`client/public/tarot/`）：78 张公版韦特（Rider-Waite-Smith 1909，Public Domain；`mixvlad/TarotCards` 经 jsDelivr 拉取，`sips -Z 560` 压缩，6.52MB）+ 定制牌背「星月紫金」（ImageGen 设计稿 51KB + SVG 兜底）；三级降级链（位图 → 程序化文字牌·花色符号 × 点数阵列（马赛 pips 传统）→ 文本）；逆位中性口径（180° 倒置 + 虚线框 + 角标，无凶兆色）；许可登记 `client/public/tarot/rws/README.md`；拉取脚本 `tmp-fetch-tarot-cards.mjs`（断点续拉）；**用户走查修订**：弹窗 720→860px 放大与专业化（尺寸令牌迁 `:root` 全局共用 + 阶段条连接线 + 主按钮渐变投影）+ 修洗牌牌堆定位特异性冲突（`.tc-back` 基类 position 覆盖 `.tc-deck-pile` absolute 招致的堆叠炸裂——提权 + 基类去 position）+ 面板牌阵台（CardsBoard）同步改真实牌面（`TarotCardFace` + `.is-board` 变体，逆位倒置；测试锤点类名零变更）；
- 研习设施（无 gamification）：手记（自动记录 / 幂等 / 只存参数 / 重放 / 再请解 / 删除；`ma:tc:journal:*`）；78 张图鉴（分组浏览 + 遇见计数只读小字 + 问这张回填）；足迹从手记派生（抽过 / 遇见 / 请解）；入口三处（ChartboardPanel 空态即有 + CardsCard 第三按钮「亲手抽一组」；类名 `.tc-*` 独立命名空间，不复用 `.pn-*` 保 m69 断言）；
- 面板就绪修订：tarot 场景 chartboard **恒就绪**（`SceneStage.tsx` 一行：`panelReadyBase || （group.id==='tarot' && panel==='chartboard'）`）——空态即有「亲手抽牌 / 图鉴 / 手记」研习入口；`panelReady` 纯函数与其它场景「无数据不展示」口径不动；
- 协议同步：`agents/tarot/_protocol.md` 铁律 8（亲手抽牌按三元组复算、不采信转述牌面）+ 工具纪律参数口径；`tarot-reader/AGENT.md` 复算一行；`skills/tarot-reading` 复现三元组与检查清单条目；
- 验证：server 全量 **107 文件 / 1345 例 ✅**（含新增 m78 6 例：cut/picks golden / 旋转等价 / 校验 / 工具壳）；client 全量 **109 文件 / 1258 例 ✅**（新增 m78-deck 6 / m78-ritual 10，m69-md-ext 17 回归）；E2E `m78-tarot-ritual` **2/2 ✅** + 邻回归 m69-cards / m52-stage **25/25 ✅**；typecheck 全仓 0 错；check:agents 165/165 + 协议 41/41；check:skills 70/70；eval（mock 确定性）**36/36 ✅** 无回归。

- 镜像面：`docs/tarot-ritual-design.md`（专项设计）、ADR 0187 + `docs/adr/README.md` 索引、`agents/CHANGELOG.md` v98。

## 114. 社交协作——好友 · 私聊/群聊 · 真人入会话与 @ 调度 · 实时通道稳定化（M79）

多用户基座（M57）之后，本批打通「人 ↔ 人 ↔ Agent」的社交协作面：好友关系图 · 私聊与群聊 · 真人驻 Agent 会话与 @ 真人调度 · 通知/未读/在线状态的实时通道稳定化。设计与实现基线见 [docs/social-collab-design.md](docs/social-collab-design.md)（含前端交互与触发判断专题）；决策见 ADR **0188–0201**（编号让位：M78 / ADR 0187 / §113 已被塔罗批次占用，本批顺延落 M79 / 0188 起 / §114）。**批次 A–E 全量落地（F 前端收口 / G 隐私与可见性收口追加）**。

### 114.1 实时通道稳定化基座（M79-A）

- **用户主题 `u:<userId>`**：握手鉴权通过后服务端自动绑定本人身份（免客户端遗漏）；仅本人可订（admin 不可代订）；
- **三层投递**：WS 用户主题实时帧 → `user_inbox` 持久表（每用户 seq 单调；保留期 30 天仅清已读）→ REST `since` 补齐；客户端幂等合并 + seq 缺口检测补拉；**inbox 仅承载跨会话个人事件**（DM 逐条消息不入箱）；
- **未读服务端权威**：`session_reads` 单一事实源（`seq > last_read_seq 且非本人`）；WS `read` 帧 / REST 降级（viewer 读级放行）；多端 `notify:read-state` 广播；列表单查询聚合 `unreadCount`；
- **背压与连接治理**：待写队列上限 `WS_SEND_QUEUE_MAX=256` → `resync` 断开转 REST（不丢事件）；每用户连接上限 8 踢最旧；退避向下抖动 + 60s 探活 + 前台即时重连；ACL 撤销即时化（`acl-changed`）；`GET /api/ws/stats` 观测；
- **修复 M57 遗留缺口**：会话邀请从「刷新才发现」升级为 inbox 实时到达。

### 114.2 用户画像（M79-B）

- `headline / bio / avatar`（色块 / emoji；`kind:'image'` 预留）；`PATCH /api/auth/profile`（null 清除 + 校验）；投影面覆盖 /auth/me · users · ShareDialog · 会话详情 `humanProfiles`（**humanNames 保留不删**）；`HumanAvatar` 统一样式；他人人类消息左对齐 + 头像 + 头衔（自己的消息维持现状）。

### 114.3 好友体系与在线状态（M79-C）

- `friend_links` 单行双向状态机（pending / accepted / blocked；reject 删行可重发；block 隐含解除）；**拉黑四面切断**（请求 / 搜索双向 / 好友列表 / 私聊创建；被拉黑方不暴露事实）；
- 隐私开关（`searchable` / `allowFriendRequests`）+ 日限流 20 + 搜索 30 次/分；全部动作 inbox 实时到达 + `notify:friends-changed` + 审计（friend.*）；
- 在线状态：连接引用计数推导（多端 +1；离线延迟 30s；500ms 聚合）；**可见范围 = 好友面**（同会话扩展后置）；
- 客户端：左栏「会话 | 联系人」页签（请求区 / 搜索关系态按钮 / 好友列表（在线点 + 头衔 + 私聊 / 移除二次确认）/ 新建群聊）。

### 114.4 人物会话：私聊与群聊（M79-D）

- `sessions.kind: team / direct / group` + `dm_key` 唯一键（并发竞态兜底）；私聊仅好友（403 明确）+ 标题动态渲染（对端名）+ 隐藏即「删除」（**新消息自动复现**）；群聊 1–50 人 + 群邀请放宽（成员可邀自己好友；团队会话维持 owner-only）；chat 免路由（无 @agent 零引擎；混编群 @agent 正常唤起）；工作区零特判。

### 114.5 触发判断与真人 @ 调度（M79-E）

- **触发判断矩阵**（[ADR 0195](docs/adr/0195-trigger-matrix-and-route-mode.md)；**不做 LLM 意图分类**）：@agent 触发 · waiting 命中越过策略 · **人类定向（@真人 / 行首 @用户）仅存储** · 无定向按 `route_mode`（auto=PRS 现状零回归 / mention=静默；chat 恒 mention）；team 头部「AI 自动应答」开关 + 客户端静默发送轻提示；
- **真人 @ 寻址**：人类 token 表与 agent 隔离（显示名 → username 降级链；注册期互斥杜绝双命中）；`humanMentions` 消息字段 + chips 渲染 + inbox 提及通知（60s 聚合）；
- **持球方（零 Run 锁）**：agent 行首 @具体人 = 指定交还 → Run 收束后 `waiting_on` 写入 + `notify:session-meta` + 每目标 inbox `waiting`；头部琥珀徽章「等待 X 回复」+ 被点名者提示条；任何消息集合差清除 + 成员移除清洗；**等待永不挂起 Run**（互斥 / 配额 / 插话语义零变化）。

### 114.6 验证与边界

- 门禁：server **112 文件 / 1373 例**、client **113 文件 / 1278 例** 全绿；四包 typecheck 0 错；新增测试 6 文件（m79-realtime / profile / friends / chats / trigger（server）+ realtime / profile / contacts（client））；
- 迁移：v21（inbox/reads）→ v22（画像）→ v23（好友）→ v24（kind/dm_key/hides）→ v25（route_mode/waiting_on/human_mentions）；
- M79-F 前端收口（设计 §14 补齐）：群 / 私聊头部「成员」入口（ChatMembersDialog：名单 + 群主移出二次确认 + 「邀请好友」选择器，候选 = 好友 − 已在场）；ShareDialog 多人协作静默引导（owner + 已有成员 + auto → 一键切「仅点名唤起」）；会话列表筛选 chip（全部 / 团队 / 聊天）；命令面板「打开联系人 / 新建群聊」；
- E2E（补批）：`e2e/m79-social.spec.ts`（好友 UI 全链 → 私聊 → 群聊 → 邀请实时化 → @真人提及 → 触发策略零引擎）+ `e2e/m79-realtime.spec.ts`（多端未读实时增量 + read-state 对账）；auth 项目 5/5（含 m57-auth 回归零副作用；m57-auth 断言已按「共享会话并存」角色感知硬化——协作徽章 first() / 清理循环仅限 owner 属主会话）；`PW_AUTH_PORT` / `PW_AUTH_DATA_DIR` 隔离参数（默认 8790 / data/e2e-auth 零变化；并发会话防旧实例复用假失败）；
- M79-G 隐私与可见性收口：presence 可见域 = 好友 ∪ 同会话人类成员（`createPresenceRecipients` 工厂；客户端 `presenceMap` + `OnlineDot` 共用——成员弹窗 / @ 候选 / 联系人）；**admin 无会话内容旁路**经代码复核确认并回归固化（m79-privacy：详情 / 写 404、列表仅自有、搜索无命中、WS 可见集不含）——**更正**此前「admin 对私聊可见」表述，不引入 `DM_ADMIN_VISIBLE`（ADR 0197）；
- M79-H 拉黑消息面补完与微体验：拉黑对人物私聊发新消息 → 403 拒发（落库前；文案分视角不泄漏拉黑事实；团队协作面不受限、历史可回看——ADR 0198）；联系人离线点 tooltip「最后在线：x 分钟前」；E2E 补强（成员弹窗 / 同会话在线点 / 筛选 chip；行定位标题精确匹配）；
- M79-I 通知中心（持久收件箱 UI 落点）：顶栏「通知」+ 未读徽章；`InboxPanel`（类型标签 / 单项已读 `ids` / 全部已读 `upTo` / 会话类跳转打开 + 好友类跳联系人）；`inbox-store.ack`；联系人面板 ack 收敛（仅好友申请类自动已读）；banner 层叠修复（`relative z-40`）；
- M79-J 设计对账审计（行级补齐）：隐私开关卡 `MyPrivacyCard`（§14.9；GET/PUT `/auth/preferences`）+ UsersConsole 画像行；chat 头部（direct 在线点+头衔 / group「N 人」）+ 人类成员条 + chat placeholder（§14.4）；`<human_roster>` 注入 + 交还指令（§8.8；assembler/engine 透传，无人类零差异）；成员编制管理权限矩阵（§16：team/direct owner-only、group editor；`canManageLineup`）；ARIA 两处（§14.11）；
- M79-K E2E 终账（§17 ⑦）：mock 剧本标记 `[[handoff:姓名]]` → 行首 @真人；E2E 补 4c 持球全链（唤起 → 持球徽章 → 被点名提示条 → 回复清除）；连带修复：mock 触发块共享会话静默失效（`【…】` 泛匹配）、`notify:session-meta` 客户端零消费（ws-store 补归约）、`applySession` 空键残留（waiting/routeMode 显式归一）；
- M79-L 多实例演进（共享通知总线 + 跨实例 presence）：`NOTIFY_BUS=db` 可选启用（默认 memory 零变化）；NotifyHub 挂载 `DbNotifyBus`（本地下发不变 + 总线行跨实例传输；origin 排除防回环；启动游标不重放历史——缺口由 resync + REST 权威层补齐）；`presence_instances` 计数表（离线广播前合并全局合计 + 30s 心跳 + stale 回收）；迁移 v26；`INSTANCE_ID` / `ws/stats.bus`；ADR 0199；
- M79-M 聊天模式 @agent 边界（实测反馈收口）：纯人聊天 @agent 不触发（人类定向仅存储——现状语义，测试固化）；混编群 @agent 唤起 Run（正反例断言）；Composer 成员条人物会话不再回退「全量 agent 兜底」（team/场景空编制兜底保留）；
- M79-N 实测反馈三修：他人人类消息气泡 `w-fit`（短文本不再拉满全宽）；ShareDialog「从好友选择」快捷邀请（团队加真人免输用户名）；澄清私聊不可扩群（多人群请走新建群聊多选）。
- M79-O 新建会话直接拉真人：组队台编制栏增「协作成员（真人）」好友多选（创建后自动 editor 邀请；纯真人组合自动 routeMode=mention 防误触发；按钮计入真人）；E2E 5b 步端到端固化；
- M79-P 纯人聊天隐藏 AI 状态条：人物会话（无 agent 编制）不渲染范式 chips 与上下文/费用/轨迹条（`aiBarVisible`；混编群与 team/场景保留；快捷键提示保留）；
- M79-Q 真人图片头像：`UserAvatar.kind:'image'` 实装——客户端裁 256² + raw 上传（魔数校验，拒绝 SVG）；DB 文件名 / `toUserInfo` 唯一投影 URL；读取白名单 + immutable；换图/改色块/删号三路清理；HumanAvatar 失败回退首字；ADR 0200；
- M79-R 团队共享弹窗升级：好友多选批量邀请（勾选 + 「邀请（N 人）」；用户名输入保留兜底）+ 移出二次确认（与聊天成员弹窗一致）；文案锚点全保留（m57 单测/E2E 零破坏，E2E 补确认步）；
- M79-S 纯人聊天隐藏右栏（与 AI 状态条同口径）：direct/group 无 agent 编制时右栏 Panel 与显隐按钮不渲染（窄屏团队抽屉/底条同收）；不改用户偏好（切走恢复）；混编群与 team 不受影响；
- M79-U 多真人会话 agent 消息实时补投（缺陷修复）：notify:turn-end 帧附完整消息（engine finishTurn 唯一收尾路径一处修全链）；其他真人成员与同账号多标签经 WS 同会话 upsert 实时可见（此前需刷新）；跨会话 agent 维持不打扰（未读由 run-completed 聚合）；三层测试固化；
- M79-W 群聊式全同步（缺陷修复三处）：触发型人类消息（@agent/持球/auto）补广播（launch/inject 分支）；列表变化/首载自动全量订阅（不再依赖点击）；turn-end 跨会话统一处理（任何消息计未读 + 列表预览即时更新 + 权威对账；run-completed 去本地双计）；E2E 4e 固化双向实时与跨会话未读；
- M79-X 全同步审计收口：消息编辑/删除与会话删除补广播（turn-end(message)/notify:message-deleted/notify:session-deleted）+ 编辑/删除权限加固（仅作者，属主可删任意）；同会话列表预览即时；E2E 4f 固化；typing/已读回执/逐字旁观列为有意不做；
- M79-Y 穷举式全量审计第二批：计划批准/指挥台重排补广播（notify:plan-updated / notify:queue-updated）；ACL 撤销与踢出跨实例（bus kind 扩展 + listSince 映射修复，安全面）；资料变更好友广播（onProfileChanged）；context-compressed 客户端补 case；资源绑定/记忆实时同步缓办；
- M79-Z 旁观端流式（打字机对齐）：engine delta 120ms 节流聚合 → notify:message-delta（收尾前 flush 保证「先 delta 后完整消息」的按序覆盖）；客户端非触发者同会话首帧建 streaming 占位 + appendDelta（runId 守卫去重）；帧量 ~8fps 安全；三层测试固化；
- M79-AA 交接目标具体化 + 回放条收敛：交接条显示具体真人（@用户 → 全员在场真人，humanMentions 落库 + HumanAvatar 头像流/一键接棒；旧数据回退「你的回合」）；波次回放条去文字（图标开关）且默认隐藏、点击展开（2026-09-20 视觉改版：收起态 = 输入区上方靠右单图标胶囊，展开态 = 同一胶囊向左展开「上一波 / 刻度 / 下一波 / 计数」，替代整行空条；同 shadow-soft 阴影，入场复用浮动层动画——安静模式 / reduced-motion 已关闭）；
- M79-AB 断线重连权威补偿：用户主题帧（收件箱/邀请）断线窗口无游标可补——重连成功自动补收件箱快照 + 会话列表对账；降级轮询同补；修复"新建会话邀请要刷新"；
- M79-AC 半开连接自愈闭环：探活无应答 ≥2× 阈值判定半开 → 强制关闭走常规重连（+关闭握手兜底 +旧连接事件守卫）；修复"连接假死只能刷新恢复"；
- M79-AD 工作台打开通道/工具按钮/审批定向：打开请求事件改 store 通道（挂载后消费，根治"有的打开了有的没有"）；studio-btn 不换行+容器整行换行；审批帧定向触发者（publishToUser，其他真人不可见）；
- M79-AE 操作权限统一治理+通知补偿：改名/routeMode/serial/planFirst 全 kind 收敛 owner-only；worktree merge/discard → owner；会话删除/成员被移出 → 收件箱 system 通知；ChatArea 触发策略开关仅属主；内容协作写保持 editor+；
- M79-AA 群管理补全（生命周期闭环）：成员「退出群聊」与群主「解散群聊」入口落地成员弹窗（行内二次确认；chat 形态此前无退出/解散入口）；退出/移出补系统事件条留痕（群聊「群聊」/ 团队「协作」+ turn-end 广播）；群名 PATCH 收紧为 owner（设计 §12.3；editor 403）；direct `/leave` 400 防护（设计 §12.2 只有隐藏）；解散广播 payload 增 `kind`（「群聊已被解散」文案 + toast 去重）；列表行补群聊重命名入口（owner）；纯人聊天 AI 语义面收口——「资源」入口同口径隐藏（私聊 / 无 agent 编制群聊；team 与混编群保留，E2E 三态固化）；ADR 0201；
- 明示边界：会话内容可见性 = **owner ∪ 共享成员唯一事实源**（admin 无旁路；孤儿行兜底与 `__` 全局主题属 admin 例外）；单进程部署假定（多实例演进：权威层在 DB，替换快路径即可）；
- 镜像面：`docs/api.md §24` · `docs/operations.md §9`（含多实例部署手册）· `.env.example`（5 + M79-L 4 配置）· ADR 0188–0201 + README 索引 · `playwright.config.ts`（auth testMatch + PW_AUTH_* 隔离）· 本页。

## 115. 运行时上下文注入——时间 / 系统（运行时上下文批）

agent 此前对「现在」零感知：system 提示不含日期 / 时区 / 运行环境，模型只能凭训练记忆猜时间——「今天 / 本周」相对日期、时效性判断（价格 / 政策 / 新闻 / 版本）与排期核对缺统一依据。本批在装配必经路径为**全部角色 / 场景**注入运行时上下文（AGENT.md / 协议资产零改动），以两级拆分保护 prompt 前缀缓存。决策与被否决方案见 ADR 0202。

- 两级注入（`server/src/context/assembler.ts`）：**日期级**（当前日期 / 星期 / 时区 / 运行环境 + 纪律句）进 system L3 尾段 `<runtime_context>`——天级稳定（同一天内多回合字节级一致，「system + 历史窗口」前缀缓存不破坏）；**时刻级**（HH:mm）进回合指令（`buildTurnInstruction` 首行后的「当前时刻」行）——该消息每回合天然新建，分钟级变化零额外缓存损失；
- 口径：日期 `YYYY-MM-DD（周X）`；时区 `IANA 名（UTC±N）`（`Intl.DateTimeFormat`，偏移兼容半小时制）；运行环境 `macOS / Windows / Linux（arch）`（`process.platform` + `os.arch()`）；附纪律句（相对日期一律以此为准；时效信息不凭训练记忆臆断）；`now` 全可注入（缺省当前时刻——单测固定断言，避免时区 / 时钟依赖）；
- 展示：runtime 计入 L3（`snapshot` label 更新为「技能 / 工作区 / 运行时」）；
- 验证：server `tests/runtime-context.test.ts` 8 例（日期 / 星期 / 时区断言、**同日不同时刻字节级一致**（缓存友好性守护）、跨天变化、system 尾段位置（在花名册之后且不含时刻）、三范式时刻行、`prepareTurn` 跨角色 / 跨场景集成 + L3 label）；server 全量回归 **116 文件 / 1407 例 ✅** + typecheck 0 错。

- 镜像面：ADR 0202 + `docs/adr/README.md` 索引、根 README「上下文工程」行、本页。
