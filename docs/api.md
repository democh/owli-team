# API 参考

> 与实现同步的接口表（单一事实源：`server/src/routes/*.ts` + `server/src/routes/schemas.ts`）。
> 系统架构、协议与编排语义见 [../design.md](../design.md)；配置项与运维见 [operations.md](operations.md)。

## 总述

- **Base**：全部挂载于 `/api`；开发模式经 Vite 代理（5173 → 8787），生产模式由服务端单端口托管。
- **错误**：统一 `{ "error": string }`（中文文案，前端直接 toast）。校验失败 = `400`（zod 首条 issue）。
- **鉴权**：默认监听 `127.0.0.1` 无鉴权；`BIND_ALL=true` 时强制 `AUTH_TOKEN`，所有 `/api/*` 请求需带 `Authorization: Bearer <token>` 或 cookie `auth_token`，否则 `401`（`/ws` 同样校验）。
- **限流**：`POST /api/sessions/:id/messages` 走限流护栏（`MESSAGE_RATE_LIMIT` 次/分钟），超限 `429`。
- **SSE**：`GET /api/runs/:runId/stream` 先快照重放再续流；事件类型见 design.md §6 与本文附录。
- **WS**：`/ws` 推送通知（`NotifyEvent`），`GET /api/notifications` 为降级轮询（同一 NotificationCenter）。
- **ID 形态**：全部为字符串 ID（`sess_*` / `run_*` / `msg_*` / `mem_*` / `apr_*`）。时间戳为 ISO 8601 字符串或毫秒数（字段名含 `Ms` 者为毫秒）。

## 1. 健康与元数据

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/health` | 健康检查 + 前端运行参数下发 | `{ ok, model, baseUrl, thinking, notifyPollMs }` |
| GET | `/api/agents` | 角色清单（人设 / 能力 / 转交 / 头像 / 工具 / Skill / 场景分组 / 灵魂元数据 / 快速组队预设） | `{ agents: AgentDefinition[], groups: AgentGroup[], presets: RosterPreset[] }`；agents 附 `group`、`souls: SoulMeta[]`、`defaultSoul`、`dispatch`（M46：全局唯一调度官标记）；presets 来自 `agents/_presets.yaml`（缺失时为空数组） |
| GET | `/api/agents/:id/avatar` | 角色形象照（读 `agents/<场景>/<id>/avatar.png`） | PNG 二进制（`ETag` + `Cache-Control`；无图 `404`） |
| GET | `/api/skills` | 技能索引（元数据，正文按需加载） | `{ skills: SkillMeta[] }` |

## 2. 项目与工作区（M6）

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/projects` | 项目列表 | `{ projects, allowedRoots }`（allowedRoots 供前端选择器校验） |
| GET | `/api/projects/:id` | 项目详情 | `{ project, sessionCount }` |
| POST | `/api/projects` | 新建项目 | `201 { project }` |
| PATCH | `/api/projects/:id` | 更新（name / workspaceMode / baseBranch） | `{ project }` |
| DELETE | `/api/projects/:id` | 删除项目（会话转为未关联，不删会话） | `{ ok, sessionsDetached }` |

**POST /api/projects 请求体**：

```json
{ "name": "my-app", "rootPath": "/abs/path/repo", "workspaceMode": "worktree", "baseBranch": "main" }
```

- `rootPath` 必须是绝对路径且在 `ALLOWED_ROOTS` 白名单内，否则 `400`；
- `workspaceMode`：`sandbox`（默认）/ `repo`（直接挂载）/ `worktree`（git worktree 隔离，推荐）；
- `worktree` 模式要求 `rootPath` 是 git 仓库（服务端会校验 `git rev-parse`）。

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/sessions/:id/worktree` | worktree 状态（模式 / 分支 / 主仓库 + 改动 diff） | `{ ...info, diff }`；非 worktree 会话返回模式信息与空 diff |
| POST | `/api/sessions/:id/worktree/merge` | 合并 `agent/<sid>` 分支回主仓库（**必须** `{ "confirm": true }`） | `{ ok, merged, branch }` |
| POST | `/api/sessions/:id/worktree/discard` | 丢弃 worktree（删目录 + 删分支） | `{ ok }` |

## 3. 会话

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/sessions` | 会话列表（含消息数 / 最后摘要） | `{ sessions: Session[] }` |
| POST | `/api/sessions` | 新建会话（M46：`participantIds` 空数组 → 填充全局唯一调度官；资产缺失 `400`） | `201 { session }` |
| GET | `/api/sessions/:id` | 会话详情（含全部消息与最近 Run 快照；`?limit=`/`?before=` 游标分页——最近 N 条 / 该 seq 之前的更早一页，limit ≤ 500，缺省全量） | `{ session, messages, latestRun, project, memberReads, hasMore?, totalCount?, memberStats? }` |
| PATCH | `/api/sessions/:id` | 重命名 / 切换「规划先行」`planFirst`（M24）/ 「串行执行」`serial`（M46-2，缺省开启）/ 「接力控制」`relay`（M86：`auto` / `manual` / `null` 恢复推导）/ 「自动编排」`autonomy`（M88：`auto` / `always-plan` / `never-plan` / `null` 恢复 auto；兼容 `planFirst`）/ **空间归属 `spaceId`**（P1；与改名同口径仅属主，校验存在性 + `notify:session-meta` 广播） | `{ session }` |
| DELETE | `/api/sessions/:id?deleteWorkspace=&keepWorktree=` | 删除会话；默认连工作区删除，worktree 会话默认丢弃（需保留传 `keepWorktree=true`） | `{ ok, deleteWorkspace, worktreeDiscarded }` |
| POST | `/api/sessions/:id/resume` | 断点继续（以 `interrupted` 快照启动新 Run） | `201 { runId, queue, queued }` |
| GET | `/api/sessions/:id/tasks` | 任务清单（`write_todos` 落库，跨 Run 继承） | `{ tasks: TaskItem[] }` |
| GET | `/api/search?q=&limit=&sessionId=` | 跨会话全文检索（FTS5 trigram + LIKE 回退；limit 默认 50、上限 100） | `{ results: [{ sessionId, sessionTitle, messageId, snippet, ... }] }` |
| POST | `/api/sessions/:id/members` | 添加成员（运行中允许；去重 + 校验角色存在；body `{ agentIds, souls? }`；M77：`agentIds` 可为成员键（分身 = `agentId~soulId`）；M46：与调度官 `invite_members` 共享内核，事件条措辞按发起者区分——用户「邀请了」/ 调度官「召集了」） | `201 { session, message }` （message = system 成员事件条） |
| DELETE | `/api/sessions/:id/members/:memberKey` | 移除成员实例（M77：按成员键；运行中拒绝：串行 = 当前发言人 / 并行波 = 波内进行中成员；队列中的就地移出并广播 `queue:updated`；至少保留 1 名） | `{ session, message }` |
| PATCH | `/api/sessions/:id/members/:memberKey` | 切换成员灵魂（body `{ soul: string \| null }`；经典实例：`null` = 恢复默认；分身实例：**键替换**（`luna~zen` → `luna~scholar`，运行中同步队列/便条），`null` → `400`；重复设置 / 同角其他实例已占用该灵魂 → `400`） | `{ session, message }` |

**POST /api/sessions 请求体**：

```json
{ "participantIds": ["pm", "architect"], "souls": { "architect": "wild" }, "title": "可选标题", "projectId": "可选项目", "spaceId": "可选空间（缺省 = 我的空间；default 不随行）" }
```

- `participantIds` 去重（M77：条目为**成员键** —— 经典 = `agentId`（存量兼容）、分身 = `agentId~soulId`；同角有效灵魂去重、无 souls 不可分身、同角 ≤ 4 实例，违者 `400`）；未知角色 `400`（M46：可省略或空数组 `[]` → 服务端填充全局唯一 `dispatch: true` 调度官，资产缺失 `400`）；指定 `projectId` 时先准备项目工作区（worktree 创建失败会回滚会话）；
- `souls` 可选：创建时即指定经典成员的灵魂覆盖（键必须 ∈ 经典成员键、值必须为该角色可用 soul，否则 `400`；**分身键不得出现在 souls**——分身灵魂内嵌在成员键中）；落库为 `Session.memberSouls`（`Record<memberKey, soulId>`），未指定成员走角色默认灵魂。
- **M16 成员事件语义（ADR 30）**：添加 / 移出 / 换灵魂三写操作均落一条 `role:'system'` 成员事件消息（`turnIndex: -1`，不进 LLM 窗口）并广播 `notify:members-changed`（payload = `{ session, message }`）；运行中加入的成员从下一回合 roster 即时生效。
- **M80-C 已读水位投影**：详情返回 `memberReads: Array<{ userId, lastReadSeq }>`（仅开启 `showReadReceipts` 的活跃成员；**请求者自身关闭 → 空投影**——对等双向；ADR 0208）；分页响应同口径；分页附 `hasMore` / `totalCount` / 全量战绩 `memberStats`（前端只加载最近一页时统计仍为全量口径）。

### 3.1 计划与评审（M24）

规划范式的计划生命周期（提交挂起 → 批准 / 驳回修订 → 派发执行 → 步骤进度 → 收口）见 design.md §40。`Plan` 关键字段：`status`（submitted / approved / executing / done / rejected / superseded / blocked）、`version`（驳回修订同 id 递增）、`steps[].ownerAgentId / mode / acceptance / status`。

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/sessions/:id/plans` | 会话计划与评审记录（任务面板 / 聊天计划卡数据源） | `{ plans: Plan[], reviews: ReviewRecord[] }` |
| PUT | `/api/sessions/:id/plans/:planId` | 编辑计划（title / goal / steps：改负责人 / 调序 / 增删 / risks；仅 `submitted`；负责人须为会话成员；广播 `plan:updated`） | `{ plan }` |
| POST | `/api/sessions/:id/plans/:planId/resolve` | 结算：有挂起 → 批准 / 驳回（feedback 回灌作者现场修订）；无挂起时 `approve` → 新起执行 Run（队列 = 步骤负责人） | `{ plan, launched: { runId, queue, queued } \| null }` |

**resolve 请求体**：`{ "decision": "approve | reject", "feedback": "可选（驳回反馈，回灌作者）" }`；非 `submitted` 计划 resolve → `404`。聊天计划卡与任务面板共用同一入口。

- 会话 `planFirst` 开关（「规划先行」）：`GET /api/sessions/:id` 返回、`PATCH` 切换；与消息级 `mode` 的优先级见 design.md §40.1。
- 会话 `serial` 开关（「串行执行」，M46-2）：**缺省开启**（波次逐位出场、前序产出可见）；`PATCH { "serial": false }` 关闭后同场景成员可并行成波（显式 `@≥2` / handoff 多目标生效）；fork 复制开关状态；决策见 ADR 0096。

## 4. 消息与上传

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| POST | `/api/sessions/:id/messages` | **双形态**：启动新 Run 或插话（见下） | `201 { message, runId, queue }` 或 `201 { message, injected: true, position, runId }` |
| POST | `/api/sessions/:id/dispatch` | **M86 手动派发下一棒**（body `{ agentId, note? }`；目标须在场，支持角色 id / 成员键；非 viewer）：活跃 Run → 插到队首（不打断当前发言人）；空闲 → 新起 Run（队列 = `[agentId]`，**跳过平台路由**）；落系统事件条并广播 `queue:updated` | `{ runId, queue, queued }` |
| PATCH | `/api/sessions/:id/messages/:messageId` | 编辑用户消息内容（运行中 `400`） | `{ message }` |
| DELETE | `/api/sessions/:id/messages/:messageId` | 删除用户消息（运行中 `400` ） | `{ ok }` |
| PUT | `/api/sessions/:id/messages/:messageId/reactions` | **M80-B**：挂表情回应（`{ emoji }`；幂等 toggle；写级成员，viewer `403`；兼容模式拒绝；同消息同用户 ≤8 种，超限 `429`；`isEmojiLike` 校验） | `{ reactions }` |
| DELETE | `/api/sessions/:id/messages/:messageId/reactions?emoji=` | 摘除本人回应（仅本人；query 传参） | `{ reactions }` |
| POST | `/api/sessions/:id/fork` | 从某条消息 fork 新会话（复制截至该条的历史） | `201 { session, copied }` |
| POST | `/api/sessions/:id/uploads` | 文件 / 图片上传到 `workspace/<sid>/uploads/` | `201 { path, size }` |
| POST | `/api/sessions/:id/attachments` | **M33 附件直传**（raw 二进制 ≤200MB，无 base64 膨胀；托盘附件通道） | `201 { attachment }` |

**双形态语义（ADR 10 / M3）**：

- 无活跃 Run → 启动新 Run：`{ "content": "帮我设计登录功能" }` → `201 { message, runId, queue }`，内容经 `GET /api/runs/:runId/stream` 消费；
- 有活跃 Run → 插话：写入当前 Run 的待注入队列，在下一回合边界注入上下文，并 emit `user:message` 事件。
- 消息级范式（M24）：body 可附 `{ "mode": "plan | execute | review" }`（Composer 三态 chip，仅对**下一条消息**生效、发送后自动复位；缺省沿用会话 `planFirst` 或 `execute`），随用户消息持久化并在 `turn:start` / `wave:start` 携带。
- **接力控制（M86，ADR 0223）**：`Session.relay` 控制「agent 之间是否自动接棒」。缺省按会话形态推导 —— `direct` / `group` 与**单成员编制**为 `manual`，零编制（待组队）与多成员 team 为 `auto`；`PATCH { "relay": "auto" | "manual" | null }` 显式覆盖。`manual` 下 `handoff` 工具只登记「建议下一棒」（回执说明不自动接棒，落 `handoff:suggested` 审计），不自动召集、不入队，Run 收尾交还用户；接棒只经 `POST /sessions/:id/dispatch` 由用户发起。已批准计划的步骤派发不受影响。
- **自动编排（M88，ADR 0226）**：未显式选择范式时，服务端按「意图判定」决定本回合是否先出计划 / 末段是否评审：
  - 优先级：消息级 `mode`（用户显式）> 文本显式指令（「先出计划 / 直接做 / 评审一下」）> 会话 `autonomy`（`always-plan` / `never-plan`，兼容 `planFirst=true`）> 复杂度推断 > 默认 `execute`；
  - 高风险动作（部署 / 正式发布 / 转账 / 签署…）**强制规划**（即使 `never-plan`）；置信度阈值按风险分档（low 0.75 / medium 0.55 / high 强制）；
  - 无 @ 消息：判定并入 PRS 的 `intent` 块（不额外调用模型）；`@直达` 消息只走规则层；
  - 可审计：用户消息返回 `mode` + `modeSource`（`user` / `rule` / `router` / `policy`）；SSE `run:start` 携带 `intent`，PRS 改判时补发 `intent:decided`；写扩散时发 `intent:suggest-plan`（仅建议）；
  - **首波评审仅限纯验收**：`intent.reviewFirst=true`（无产出动作的「评审 / 验收一下」）才以 review 范式开首波；「整理方案并检查」先执行，交付后过评审门（`needsReview`）。
  - 关闭开关：`PUT /api/settings { "autonomyEnabled": false }`（或 env `AUTONOMY_ENABLED=false`），关闭后回到旧语义（仅显式 mode / `planFirst`）。
- **收口评审门（M88）**：`intent.needsReview=true` 且计划含 `acceptance / expectedOutput`、无显式 `review` 步骤时，计划完成后的作者收口波以评审范式发言（`submit_review`，target = `plan:<id>`）。

**uploads 请求体**：`{ "name": "screenshot.png", "dataBase64": "..." }`；解码后 ≤ 8MB，超限 `413`；文件名做安全清洗后落盘，返回相对路径（可用于消息引用）。

**M33 附件直传（attachments）**：raw 二进制上传（`Content-Type` 任意，无 base64 膨胀）；文件名经 `x-file-name`（URL 编码）传递，媒体元数据经 `x-file-metadata`（JSON `{ durationMs, width, height }`，非法值静默丢弃）可选传递。类型白名单五类（图片 / 视频 / 音频 / Office 与 PDF 等文档 / 压缩包），可执行与脚本类拒绝（`400`）；图片尺寸服务端解析文件头（覆盖客户端元数据，不可伪造），视频时长取客户端读取的媒体元数据；落盘 `uploads/<ts36>-<name>`（成为普通交付件并广播 `artifact:updated`），响应 `201 { attachment: MessageAttachment }`（`path / name / kind / mime / size / width? / height? / durationMs? / uploadedAt`）。

**消息携带附件（M33）**：`POST /api/sessions/:id/messages` 的 body 可附 `attachments`（≤10 个；纯附件消息允许 `content` 为空）；服务端校验每个 `path` 以 `uploads/` 开头且文件真实存在（防伪造路径，`400`）。附件随用户消息持久化（消息接口回传 `attachments`）；图片附件在上下文装配时按护栏（全窗 ≤6 / 单条 ≤4 / 单图 ≤8MB）注入多模态 `image_url`，Office / PDF 附件由 `read_file` 自动提取文本（见 design.md §48）。

**M80 表情回应投影**：消息随行 `reactions: Array<{ emoji, count, userIds, mine }>`（`mine` 按请求者投影；批量聚合）；变更广播 `notify:reaction` 全量替换帧（`mine` 由客户端按 `userIds` 本地推导）。纯人类元数据：不进 LLM 上下文、不触发 Run、不计未读；agent 消息同样可挂。

## 5. 上下文与记忆（M2 / M25）

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/sessions/:id/context?agentId=` | 分层快照（L0–L5 各层 token 数、压缩水位、摘要正文；M25 起含 L1.5「语义召回」层与 `recalled` 明细） | `{ context }`（前端「上下文抽屉」数据源） |
| GET | `/api/sessions/:id/memory` | 记忆列表（会话 scope；M25 起条目含 scope/status/importance 等扩展字段） | `{ memory: MemoryItem[] }` |
| POST | `/api/sessions/:id/memory` | 手动新增记忆（会话 scope） | `201 { item, added }` |
| PATCH | `/api/sessions/:id/memory/:memId` | 编辑单条 | `{ item }` |
| DELETE | `/api/sessions/:id/memory/:memId` | 删除单条 | `{ ok: true }` |

**POST memory 请求体**：`{ "kind": "decision|constraint|glossary", "content": "..." }`；`kind` 枚举外 `400`；`added=false` 表示按内容哈希去重命中了已有条目。

### 5.1 跨 scope 记忆与语义召回（M25）

记忆四层关联：`session`（会话）/ `agent`（成员角色）/ `project`（项目，取自会话 `projectId`）/ `global`（全局）；`kind` 七类：`decision / constraint / glossary / artifact / fact / preference / lesson`；状态机 `active / superseded / archived / candidate`（candidate = Run 后沉淀的待审候选，不参与召回）。`GET /api/sessions/:id/context` 的 L1.5 层展示 `<recalled_memory>` 注入的条目数与 token 数，`recalled` 字段为召回明细。

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/memories?scope=&owner=&kind=&status=&q=&spaceId=&limit=&offset=` | 跨 scope 列表（`status` 缺省不过滤、`all` 同义；`q` = 内容子串过滤；**`spaceId=<id>`** = 该空间 + 跨域共享、**`spaceId=shared`** = 仅跨域共享（缺省不过滤——P2 记忆域）；limit 默认 200 / 上限 1000） | `{ memory: MemoryItem[] }` |
| GET | `/api/memories/stats` | 运行状态（后端 sqlite-vec/js / 扩展版本 / 模型 / 维度 / 队列积压 / 命中率） | `{ stats }` |
| POST | `/api/memories/reindex` | 后台重建（body `{ force? }`；`force=true` 丢弃 vec0 镜像从 BLOB 重灌；失败条目一并重试） | `{ result: { ok, model, dim, removed, requeued } }`；休眠时 `400` |
| POST | `/api/memories/recall` | 语义召回调试（评分明细；绕过召回开关，休眠 / 超时仍静默跳过） | `{ outcome: { items: RecalledMemory[], candidates, skipped? } }` |
| POST | `/api/memories/:id/supersede` | 时间有效性替代（body `{ newId }`；仅同 scope 同 owner；旧条目 → `superseded`） | `{ item }` |
| PATCH | `/api/memories/:id/status` | 状态流转（候选审核 `active / archived / candidate`；转 `active` 触发嵌入补账） | `{ item }` |
| POST | `/api/memories/:id/elevate` | **P5 前置**：提升为跨域共享（全局记忆，`space_id` 置 NULL；已全局拒绝）；仅条目归属者；审计 `memory.elevate` | `{ item }` |

- **recall 请求体**：`{ "query": "...", "sessionId?", "agentId?", "projectId?", "topK?": 8, "minScore?": 0.25, "budgetTokens?": 600 }`；评分 = `scope 权重 × (0.50·余弦相似 + 0.15·keyword + 0.10·entity + 0.15·importance + 0.10·recency)`；
- **embedding 连接**：凭据经连接中心 kind=`embedding`（SecretVault 加密，`secretSet` 标记，明文永不回传）；未配置连接且 env 无 `EMBEDDING_*` 时整模块休眠（零网络零影响）；
- **候选流（M25.4）**：`MEMORY_DIGEST_MODE=session|all` 时 Run 完成后异步沉淀候选（默认 `off` 零调用）；候选经审核转 `active` 后才参与召回，全流程记 `memory:digest` trace 与 usage（kind=`digest`）。

## 6. 交付件（v1 / M6 / M8 / M24 / M87）

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/sessions/:id/artifacts?limit=&offset=&paths=&refresh=` | 交付件列表（M87 索引读取，mtime 降序）：`paths` = 精确元数据（≤100，逗号分隔）；`refresh=1` 强制校准工作区；全量响应带 `ETag`（`If-None-Match` → `304`） | `{ artifacts, source: 'index' \| 'git', revision, total, hasMore }` |
| GET | `/api/sessions/:id/artifacts/changes?since=` | 增量同步：`revision > since` 的 upserts + 删除墓碑（客户端事件合并后只拉一次） | `{ revision, upserts, deletes }` |
| GET | `/api/sessions/:id/artifacts/content?path=&download=&raw=` | 内容：文本内联 JSON（≤ `ARTIFACT_MAX_BYTES`）；`raw=1` 文本原样直出（HTML / PDF 预览 iframe 走浏览器原生解析）；二进制 / 超限 `413` 引导下载；`download=1` 走文件流 | `{ path, kind, size, truncated, content }` |
| GET | `/api/sessions/:id/artifacts/preview?path=` | M24：Office 轻量解析（docx → HTML / xlsx → 工作表 / pptx → 幻灯片大纲）；8MB 上限 `413`；不支持的格式 `415`；解析失败（损坏 / 加密） `422` | `ArtifactPreview`（按 kind 判别联合） |
| GET | `/api/sessions/:id/artifacts/versions?path=` | 版本列表（新→旧，不带正文） | `{ versions: ArtifactVersionMeta[] }` |
| GET | `/api/sessions/:id/artifacts/diff?path=&from=&to=` | 两个版本间的 unified diff（`to` 缺省 = 最新；`from` 缺省 = 上一版；`from=0` = 空文件基线） | `{ path, from, to, diff, left?, right }` |

- `kind` 分类（M24，服务端 `classifyKind` 单点决定）：`markdown / code / html / chart / data / image / office / pdf / other`；`*.chart.json` → chart（先于 `.json` → code）、`.mmd/.mermaid` → chart、`.csv/.tsv` → data；
- 路径安全：`normalize` 后前缀校验 + 拒绝符号链接逃逸，非法路径 `400`；
- 版本内容未落库（二进制 / 超限）时 diff 返回 `400` 提示。

## 7. 运行与审批

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/runs/:runId/stream` | SSE 运行流（重附着：先快照重放再续流） | `text/event-stream`；运行不存在 `404` |
| POST | `/api/runs/:runId/stop` | 停止运行（真中断：含工具信号） | `{ ok }` |
| POST | `/api/runs/:runId/queue` | 运行中重排待出手棒次（指挥台 ↑↓ 调序；仅在场成员、去重；空队列 / 非法成员 `400`） | `{ queue: string[] }` |
| POST | `/api/runs/:runId/messages/:messageId/resume` | 继续生成（续写 `stopped`/`error` 的 Agent 消息） | `202 { accepted, runId }` |
| POST | `/api/runs/:runId/messages/:messageId/regenerate` | 重新生成（同上下文重跑该条消息，不重放工具副作用） | `202 { accepted, runId }` |
| GET | `/api/runs/:runId/usage` | 本 Run 用量与费用汇总 | `{ usage }` |
| GET | `/api/runs/:runId/trace?limit=` | Run 全链路轨迹（回合 / 工具 / 压缩 / 调度事件；limit 默认 500） | `{ run, events, usage }` |
| GET | `/api/runs/active` | 活跃 Run 列表（刷新后重附着定位） | `{ runs }` |
| GET | `/api/runs/:runId/approvals` | 某 Run 的审批列表（挂起 + 历史） | `{ approvals: ApprovalRequest[] }` |
| POST | `/api/runs/:runId/approvals/:approvalId` | 审批决定 | `{ approval }` |
| GET | `/api/notifications?since=&sessionId=&cursors=` | WS 降级轮询（同一 NotificationCenter；`cursors` = URL 编码 JSON `{sessionId: seq}`，M79-AF 只回各会话增量，缺省 / 非法值回退全量） | `{ items, ... }`（同 WS NotifyEvent） |

**审批请求体**：

```json
{ "decision": "approve | reject | custom", "feedback": "可选（custom 必填，修改意见回灌模型）" }
```

- `custom` 未附 `feedback` → `400`；审批不存在或已处理 → `404`；
- 超时（`APPROVAL_TIMEOUT_MS`，默认 10 分钟）视为拒绝并回灌「用户未响应，请改换方案」。

## 8. 设置（M8）

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/settings` | 当前生效的运行期设置 | `{ settings, fields }`（fields = 可写字段名列表） |
| PUT | `/api/settings` | 部分更新 → 写入 `data/settings.json` → 就地更新 AppConfig（无需重启） | `{ settings, applied: true }` |

**可写字段**（`RuntimeSettingsSchema`）：`llmModel`、`summaryModel`、`judgeModel`、`temperature`、`temperatureOverride`、`maxTurnsPerRun`、`contextBudgetTokens`、`keepRecentTurns`、`toolResultMaxTokens`、`toolDetailKeep`、`toolTimeoutMs`、`handoffMode`、`approvalMode`、`approvalTimeoutMs`、`allowRunCommand`、`allowSensitive`、`notifyPollMs`、`embeddingConnectionId`、`memoryRecallEnabled`、`memoryRecallTopK`、`memoryRecallMinScore`、`memoryRecallBudgetTokens`、`memoryDigestMode`（末六项为 M25 向量记忆，见 §5.1）。未知字段（strict）`400`。`temperatureOverride = true` 时忽略角色 front-matter 的 `temperature`，全部角色使用 `temperature`。

## 9. 指标与反馈（M9）

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/metrics/tools?sinceMs=` | 工具维度指标（次数 / 失败率 / 平均耗时） | `{ tools: [...] }` |
| GET | `/api/metrics/summary?sinceMs=` | 总览指标（回合数 / token / 费用 / 压缩次数 / 平均回合耗时） | `{ summary, byKind, tools, feedback }` |
| GET | `/api/metrics/scheduling?sinceMs=` | M61-D6 调度健康聚合（路由 / 降级 / 波次 / 并行 / 循环抑制 / 停滞抑制 / 写冲突 / 接单） | `{ scheduling: SchedulingStats }` |
| GET | `/api/metrics/agents?sinceMs=` | **M89 角色级质量指标**（按 agent 聚合：回合 / token / 费用 / 工具失败 / 计划步骤完成与阻塞 / 评审未通过；按调用量倒序） | `{ agents: AgentMetric[] }` |
| POST | `/api/feedback` | 消息反馈（👍/👎 + 原因） | `201 { item }` |
| GET | `/api/feedback?messageId=` 或 `?sinceMs=` | 反馈查询 | `{ items }` |
| GET | `/api/feedback/export?sinceMs=` | 导出为评测候选集 | `{ items, exportedAt }` |

**POST /api/feedback 请求体**：`{ "sessionId": "...", "messageId": "...", "rating": 1 | -1, "reason": "可选" }`。

## 10. WebSocket /ws

- 握手路径：`/ws`（`BIND_ALL=true` 时需带 token）；
- 服务端 → 客户端：`NotifyEvent`（`notify:*` 系列，见 design.md §18.4 事件表）；
- 心跳：`WS_HEARTBEAT_MS`；断线重连后按 `since` 补发（环形缓冲 `WS_REPLAY_BUFFER`）；
- WS 不可用时前端自动降级为 `GET /api/notifications?since=&cursors=` 轮询（间隔由 `/api/health` 的 `notifyPollMs` 下发；M79-AF：客户端携带 per-session 游标只拉增量，会话过多时回退全量）；
- 其他 WS 通道（noServer 模式，与 /ws 并存）：`/ws/stream`（浏览器帧流，M22）、`/ws/ssh`（SSH 交互终端，M23，见 §11.4）。

## 11. 连接中心（M22 / M23）

连接 = Agent 与用户共同操作外部系统的凭据载体（数据库 / SSH / 浏览器）。凭据 AES-256-GCM 加密落库（对外仅 `secretSet` 标记）；会话绑定后 Agent 工具方可使用；用户侧面板操作与 Agent 操作同落审计与 `notify:op` 操作流。

### 11.1 连接管理

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/connections/probe?kind=` | 驱动可用性探测（表单预检；kind ∈ postgres / mysql / sqlite） | `{ ok, detail? }` |
| GET | `/api/connections/ssh-preset` | SSH「本地」预置探测（admin；本机用户名 / SSH Agent / 默认私钥 / 22 端口可达；新建 SSH 表单一键填入） | `{ preset: { name, host, port, username, authMethod, privateKeyPath?, agentAvailable, sshdReachable } }` |
| GET | `/api/connections` | 连接列表 | `{ connections }`（含 kind / config / `secretSet` / status） |
| GET | `/api/connections/:id` | 连接详情 | `{ connection }` |
| POST | `/api/connections` | 新建（body `{ name, kind, config?, secret?, enabled? }`；kind ∈ postgres / mysql / sqlite / ssh / chrome / embedding / media（M31）/ llm（多 Provider，仅 admin）） | `{ connection }` |
| PUT | `/api/connections/:id` | 更新（部分字段；config / secret 变化使数据库与 SSH 缓存句柄失效重建） | `{ connection }` |
| DELETE | `/api/connections/:id` | 删除（先失效数据库 / SSH 句柄） | `{ ok: true }` |
| POST | `/api/connections/:id/test` | 测试连接（按 kind：db 探测 / SSH 登录验证 / CDP 端点与本机浏览器发现 / 嵌入端点（M25：回报模型与维度，供表单回填）/ 媒体连接（M31：适配器连通探测）/ 模型服务（llm：`GET {baseUrl}/models` 探活并回报模型样例））；结果回写连接状态 | `{ result: { ok, latencyMs?, detail?, error? }, connection }` |
| GET | `/api/audit?sessionId=&action=&since=&limit=` | 审计查询（CRUD / test / bind / 工具执行全量留痕；limit 默认 200） | `{ entries }` |

**连接 config 约定**：`postgres / mysql / sqlite`（host / port / database / user / file + `allowWrites`）；`ssh`（host / port / username / authMethod `password|key|agent` / privateKeyPath / `allowExec`）；`chrome`（mode managed | local | remote / endpoint / executablePath）；`embedding`（M25：baseUrl / model / dim（0 = 首次调用自动探测）/ batchSize / timeoutMs）；`media`（M31：provider `comfyui | sdwebui | openai | template` / baseUrl / models / defaultModel / capabilities / workflows?（ComfyUI 模板）/ template?（三段式异步任务）/ timeoutMs）；`llm`（多 Provider：baseUrl（必填，http(s)）/ models?（模型清单，供裸名引用与编辑器候选）；**名称不得含 `/`（名称即模型名前缀，Agent 以「名称/模型名」引用）**）。**secret**：db `password`；ssh `password` / `privateKey` / `passphrase`；embedding `apiKey`；media `apiKey?`；llm `apiKey`（本地免 Key 端点可留空；明文永不回传）。

### 11.2 会话绑定

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/sessions/:id/connections` | 会话已绑定连接清单 | `{ bindings }` |
| POST | `/api/sessions/:id/connections` | 绑定（body `{ connectionId }`） | `{ bindings }` |
| DELETE | `/api/sessions/:id/connections/:connectionId` | 解绑 | `{ bindings }` |

Agent 工具（db_* / ssh_exec / browser_*）均 `requireBinding`：未绑定直接拒绝并提示可用清单。`embedding` 连接全局共享、不参与会话绑定（绑定接口对其返回 `400`），在「设置 → 向量记忆」中选择启用；`media` 连接同纪律（M56）：全局共享、不参与会话绑定（绑定接口对其返回 `400`），在「设置 → 媒体生成」中配置启用；`llm`（多 Provider，ADR 0181）：全局共享、不参与会话绑定（绑定接口返回 `400`），在「设置 → 模型与生成 → 模型服务」配置——Agent 按 front-matter `model` 引用：推荐「服务名/模型名」（如 `deepseek/deepseek-flash`，前缀 = 连接名，命中后端点收到去前缀裸名），或写清单裸名（同名以创建序先者为准；含 `/` 的模型名直接写入清单按全串引用）；未命中回退系统默认。

### 11.3 数据库工作台（M23）

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/connections/:id/schema` | 对象树数据源：表 / 列结构快照（仅数据库类型连接） | `{ tables: DbPanelTable[], truncated }` |
| POST | `/api/connections/:id/sql` | 面板 SQL 执行（单一入口；读写判定在服务端） | 见下 |
| GET | `/api/connections/:id/tables/:table/rows?offset=&limit=&orderBy=&desc=&schema=` | 表数据分页浏览 | `{ columns, rows, offset, limit, hasMore, durationMs }` |

**POST /sql 请求体**：`{ "sql": "SELECT ...", "sessionId": "可选", "dryRun": false }`（sql ≤ 20000 字符）

- 读写判定：只读白名单（SELECT / WITH / EXPLAIN / PRAGMA / SHOW）→ `query`，其余 → `execute`；护栏拒绝的语句 `400`；
- `dryRun: true` 只做护栏判定不执行 → `{ mode, dryRun: true }`（面板写确认流：先预检 → 弹确认框 → 确认后正式执行）；
- 执行成功 → `{ mode, result: { columns, rows, rowCount, truncated?, durationMs, affectedRows? } }`（写语句受连接 `config.allowWrites` 约束，未开启 `400`）；
- 成功 / 失败均发 `notify:op`（`kind: 'db'`、`actor: 'user'`、查询含 `preview` 前 5 行）。

**表数据浏览**：表名 / 列名白名单校验（`quoteIdent` + 标识符正则，防注入）；`limit` 1–500 默认 100、`offset ≥ 0`；`limit+1` 探测 `hasMore`。

### 11.4 SSH 交互终端（M23）

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/connections/:id/ssh/terminal-token` | 签发终端一次性流 token（连接须为 ssh 且启用） | `{ token, topic, mode: 'takeover', expiresIn }` |

**WS `/ws/ssh?connectionId=<id>&token=<流token>`**：

- 升级：token 一次性（握手即消费）；通道鉴权同 `/ws`（`BIND_ALL` 时校验）；
- server → client：**二进制帧 = 终端输出字节流**（原样透传，防多字节字符被 JSON 切断）；JSON 帧 = `{ type: 'ready', cols, rows }` / `{ type: 'exit', code, signal? }` / `{ type: 'error', message }` / `{ type: 'pong' }`；
- client → server：**二进制帧 = 键盘输入**；JSON 帧 = `{ type: 'resize', cols, rows }` / `{ type: 'ping' }`；
- 每终端一条独立 SSH 连接（不与 Agent 缓存句柄共享）；ws 关闭即断开（幂等清理）；心跳 `WS_HEARTBEAT_MS`。

**ssh_exec（Agent 工具）**：需会话绑定 + 连接 `config.allowExec=true` + 每次调用审批；失败 / 成功均发 `notify:op`（`kind: 'ssh'`，`detail` 含 `$ 命令` 与 stdout/stderr 截断）。

**相关**：浏览器（CDP）端点（M22）见 `server/src/routes/browser.ts`（`/api/sessions/:id/browser`（启动 / 查询当前会话浏览器；启动 body 可选 `backend` / `startUrl` / `headless`——形态三源决策链：显式参数 → 连接 `config.headless` → `BROWSER_HEADLESS` 默认无头）、`/api/browser/discover`、`/sessions/:bsid/steps`、`/stream-token`、`/takeover`、`/release`、`/open-external`、`/close`、`/screenshots/...`）。

## 12. 资产控制台（M26）

M26 图形化管理面（ActivityRail + Agent / Skill 管理，决策见 ADR 50）。读写均为 `agents/`、`skills/` 目录（唯一事实源）：zod 校验 → `.tmp` 原子写 → mtime 热更新；删除一律软删除到 `data/trash/assets/<ISO 时间戳>/<相对路径>`；每个写操作成功后广播 `notify:assets-changed`（保留主题 `__assets__`，多标签同步、不进未读计数）。id / soulId / 技能名统一 `^[a-z][a-z0-9-]{0,39}$`（防路径穿越）；`prompts/` 回退模式下写操作 `400`。

### 12.1 Agent 管理

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/console/agents` | 角色清单（摘要 + 引用计数；破损文件仍列出，问题见 validate） | `{ agents: ConsoleAgentSummary[] }` |
| POST | `/api/console/agents` | 新建（可携 `newGroup` 内联建场景；id 全局唯一） | `{ agent: ConsoleAgentDetail }`；重复 id `409` |
| GET | `/api/console/agents/:id` | 详情（raw front-matter + 正文 + 灵魂列表 + 引用清单） | `{ agent }` |
| PUT | `/api/console/agents/:id` | 更新（id 不可改；`tools` / `skills` / `model` / `temperature` 传 `null` = 恢复「未配置」） | `{ agent }` |
| DELETE | `/api/console/agents/:id?force=1` | 软删除（无 force 且有引用 → `409 { error, refs }`；组内最后角色 → 整组入回收站） | `{ ok, deletedGroup }` |
| POST | `/api/console/agents/:id/duplicate` | 复制（`<id>-copy` 系列自动递增） | `{ agent }` |
| PUT | `/api/console/agents/:id/avatar` | 上传头像（body `{ "data": "<PNG base64>" }`；magic 校验 / ≤8MB；该路由单独 12mb JSON 上限） | `{ agent }` |
| DELETE | `/api/console/agents/:id/avatar` | 删除头像（入回收站） | `{ agent }` |
| PUT | `/api/console/agents/:id/souls/:soulId` | 写入 / 更新灵魂（`setDefault: true` 同步 front-matter `soul`） | `{ agent }` |
| DELETE | `/api/console/agents/:id/souls/:soulId` | 删除灵魂（显式指向时自动清 `soul` 字段；入回收站） | `{ agent }` |

**PUT /api/console/agents/:id 请求体**（`POST` 另需 `id` / `group` + 可选 `newGroup`）：

```json
{
  "name": "挑刺官", "role": "质量评审", "title": "需求反方",
  "capabilities": ["红队评审"], "avatar": { "icon": "shield", "gradient": ["#f59e0b", "#fbbf24"] },
  "soul": "", "handoff": ["pm"], "tools": ["read_file"], "skills": ["report"],
  "model": null, "temperature": 0.3, "body": "## 职责\n…"
}
```

- 三态：`tools: null` = 全部工具（不写键）/ `[]` = 空（编辑器拦截）/ `[...]` = 指定白名单；`skills: null` = 继承场景 `defaultSkills` / `[]` = 显式不预载 / `[...]` = 指定清单；
- 参数校验失败（zod / 非法 id / `prompts/` 回退模式）→ `400`；角色不存在 → `404`。

### 12.2 Skill 管理

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/console/skills` | 技能清单（含引用统计：角色预载 / 场景兜底） | `{ skills: ConsoleSkillSummary[] }` |
| POST | `/api/console/skills` | 新建（body 另需 `name`；name = 目录名，全局唯一） | `{ skill: ConsoleSkillDetail }`；重复 name `409` |
| GET | `/api/console/skills/:name` | 详情（front-matter + 正文 + 引用清单） | `{ skill }` |
| PUT | `/api/console/skills/:name` | 更新（name 不可改） | `{ skill }` |
| DELETE | `/api/console/skills/:name?force=1` | 软删除（无 force 且有引用 → `409 { error, refs }`；入回收站） | `{ ok: true }` |

### 12.3 场景 / 工具 / 校验

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/console/groups` | 场景清单（供新建向导；完整场景管理为二期） | `{ groups: AgentGroup[] }` |
| POST | `/api/console/groups` | 新建场景（写 `_group.yaml`；已存在 `409`） | `{ group }` |
| GET | `/api/console/tools` | 工具注册表元数据 + 分类 + 各角色白名单使用情况 | `{ tools: ConsoleToolInfo[] }` |
| POST | `/api/console/validate` | 资产校验聚合（front-matter 解析 / 语义 + skills 目录结构扫描） | `{ issues: ValidationIssue[] }` |
| POST | `/api/console/generate/agent` | **Agent Studio**：按描述生成 Agent 草稿（六段人设 / 场景 / 技能建议；**不落盘**，未装配 `503`） | `{ draft, issues, attempts, model }` |
| POST | `/api/console/generate/skill` | **Agent Studio**：按诉求生成 Skill 草稿（**不落盘**，未装配 `503`） | `{ draft, issues, attempts, model }` |

- `ConsoleToolInfo`：`{ name, description, category, readOnly, paramCount, usedByAgents, origin, server?, tier }`；分类为服务端内置映射（文件检索 / 联网 / 业务 / Git / 执行 / 连接自动化 / 记忆协作 / 范式 / 其它）；`origin: 'builtin' | 'mcp'`（M27：MCP 工具附 `server` = 服务器 slug，控制台显示来源徽章）；`tier: 'core' | 'deferred'`（M28：渐进披露层级——常驻 / 按需发现）；
- `ValidationIssue`：`{ level: 'error' | 'warning', path, message }`；聚合失败不 500（异常转 issue）。

## 13. MCP 接入与管理（M27）

M27 把 M5 预留的 MCP 空壳（`tools/mcp.ts`）升级为完整体系（决策见 ADR 53）：服务器 CRUD（凭据经 SecretVault 加密）→ 官方 `@modelcontextprotocol/sdk` 双传输（stdio / Streamable HTTP）→ 运行时生命周期 → 工具注入注册表（`mcp__<slug>__<tool>`）→ 会话级绑定（最小权限，未绑定不可见）→ 引擎审批策略（`mcp__` 规则）。未装配 MCP 时全部子路由 `503 { error: 'MCP 未装配' }`；全部写操作落审计（`mcp.*`）并广播 `notify:mcp-changed`（保留主题 `__mcp__`，不计未读，多标签刷新）。

M28 扩展（§13.5 / §13.6）：`mcp.json` 文件直配（生态标准 `mcpServers`，文件权威同步；决策见 ADR 54）与工具按需发现（MCP 工具默认延迟，`tool_search` 检索激活；`eagerLoad` 服务器豁免）。

### 13.1 服务器管理

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/mcp/servers` | 服务器清单（`secret` 明文永不回传，仅 `secretSet` 标记） | `{ servers: McpServerDefinition[] }` |
| GET | `/api/mcp/servers/:id` | 详情 | `{ server }`；不存在 `404` |
| POST | `/api/mcp/servers` | 新建（`source='ui'`） | `{ server }`；校验失败 / 重名 `400` |
| PUT | `/api/mcp/servers/:id` | 更新（`secret` 缺省 = 不修改 / `null` = 清空；启用 / 名称 / 传输 / 配置 / 凭据变化 → 静默重连；`enabled:false` → 断开回收并清工具快照）；`source='json'` → `409`（由 mcp.json 管理，请编辑配置文件后同步） | `{ server }`（回读终态） |
| DELETE | `/api/mcp/servers/:id` | 删除（先断连注销工具，再删行 + 级联解绑全部会话）；`source='json'` → `409`（删除 = 从配置文件移除后同步） | `{ ok: true }` |
| POST | `/api/mcp/servers/:id/test` | 测试连接（未连接时真实建立连接并注入工具） | `{ result: McpServerTestResult, server }` |
| POST | `/api/mcp/servers/:id/reconnect` | 重连（restart）；已禁用 `400` | `{ server }` |
| POST | `/api/mcp/servers/:id/refresh` | 刷新工具清单（`tools/list` → diff 注册 / 注销） | `{ server }` |

**POST /api/mcp/servers 请求体**：

```json
{
  "name": "filesystem", "displayName": "文件系统", "transport": "stdio",
  "config": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/notes"],
              "timeoutMs": 20000, "approvalPolicy": "risky", "readOnlyOverride": "auto" },
  "secret": { "env": { "API_KEY": "…" } },
  "enabled": true
}
```

- `name` = slug（`^[a-z][a-z0-9-]{0,39}$`，唯一，工具名前缀）；stdio 必填 `config.command`，http 必填 `config.url`（`http(s)://` 开头）；`timeoutMs` 范围 1s–600s（缺省 = 全局工具超时）；
- `secret`：stdio 用 `{ env: {...} }` / http 用 `{ headers: {...} }`，全量进 SecretVault（加密落库）；更新时缺省 = 不修改、`null` = 清空；
- `approvalPolicy`：`risky`（默认，仅写类工具过审批门）/ `always` / `never`；`readOnlyOverride`：`auto`（默认，采信服务器 `readOnlyHint`）/ `readonly` / `write`；
- `source: 'env' | 'ui' | 'json'`（来源：env 种子 / 管理台手动 / mcp.json 直配；json 源只读）；`config.eagerLoad = true` 时该服务器全部工具常驻（跳过延迟发现，M28）。

### 13.2 工具目录与授权矩阵

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/mcp/tools` | 全服务器工具目录 + 角色可达性矩阵 | `{ tools: McpToolDirectoryEntry[] }` |

- `McpToolDirectoryEntry`：`{ registeredName, rawName, server, serverId, description, readOnly, usedByAgents, reachable, deferByDefault? }`（M28：`deferByDefault = !eagerLoad`，管理台「常驻 / 按需」徽章数据源）；`usedByAgents` = 白名单精确或尾部 `*` 通配（`mcp__<slug>__*` / `mcp__*`）命中的角色 id；`reachable` 另含「未声明 tools 的角色 = 全部工具」；控制台对 `reachable=false` 显示零可达警示徽章。

### 13.3 会话绑定（最小权限）

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/sessions/:id/mcp-servers` | 当前会话绑定清单 | `{ bindings: SessionMcpBinding[] }`；会话不存在 `404` |
| POST | `/api/sessions/:id/mcp-servers` | 绑定（body `{ serverId }`；幂等） | `{ bindings }` |
| DELETE | `/api/sessions/:id/mcp-servers/:serverId` | 解绑（幂等） | `{ bindings }` |

- 工具可用性三层：服务器 `enabled + status='ok'`（已连接）∩ 会话绑定 ∩ Agent 白名单；未绑定会话的回合工具清单不含任何 `mcp__` 工具，执行期再校验一次（绑定中途解除的竞态兜底，按未知工具回灌）。

### 13.4 运行时语义（速记）

- 命名：`mcp__<slug>__<tool>`（总长 ≤64 字符：非法字符 → `_`、超长截断 tool 段 + 6 位稳定哈希、同服重名 `_2` / `_3`）；调用内部回传 raw 工具名；
- 连接：stdio 子进程 env = SDK 白名单基座 + 配置 env（**不透传进程 env**）；`tools/list_changed` 通知自动刷新工具；连接超时 15s；关停时 `stopAll` 回收 stdio 子进程；
- 调用结果：text 块拼接；image / audio / resource → 占位摘要（`[图片 image/png 123KB]`）；`structuredContent` 截 4KB；detail 硬上限 64KB；超时 / 中断经 `ctx.signal` 透传 SDK。

### 13.5 mcp.json 直配（M28）

生态标准 `mcpServers` 格式（Claude Desktop / Claude Code 配置可直接拷贝）；**文件权威**：启动同步（先于 `MCP_SERVERS` env 种子）→ mtime 轮询（`MCP_CONFIG_POLL_MS`，0=关）→ 手动同步。解析失败 / 文件缺失 → 整次跳过（绝不删库）；删除仅限「文件成功解析且缺失」的 `source='json'` 服务器。

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/mcp/json-config` | 状态（文件路径 / 是否存在 / 轮询间隔 / 最后同步 / 错误与告警 / 条目名 / 计数） | `{ config: McpJsonStatus }` |
| POST | `/api/mcp/json-config/sync` | 手动同步（`trigger='manual'`） | `{ result: McpJsonSyncResult, status, servers }` |
| POST | `/api/mcp/json-config/import` | 粘贴导入（body `{ json }`；校验 → 创建为 **ui 源**，同名冲突跳过并报告） | `{ outcome: McpJsonImportOutcome, servers }` |

- 字段映射：stdio `{command,args,env,cwd}` / http `{type:"http"|"streamable-http",url,headers}` + 扩展 `{enabled,displayName,eagerLoad,timeoutMs,approvalPolicy,readOnlyOverride}`；未知字段忽略 + 告警；
- 变量展开：字符串 `${VAR}` / `${VAR:-默认值}`（args / env / url / headers / cwd）；未定义且无默认 → 条目跳过 + 告警；
- `source='json'` 的服务器只读（PUT / DELETE / 启停 → `409`，含「由 mcp.json 管理」提示）；审计 `mcp.json-sync` / `mcp.json-import`；同步广播 `notify:mcp-changed`。

### 13.6 工具按需发现（M28）

- `AgentTool.tier: 'core' | 'deferred'`（缺省 core）：内置 22 常驻 / 34 延迟（web / git / db / browser / ssh / run_command / 画布创作四件套 / 定时任务三件套；金融投研 12 个 `fin_*` 随 `FINANCE_ENABLED=true` 并入延迟池）；MCP 工具 `tier = config.eagerLoad === true ? 'core' : 'deferred'`；
- 引擎 auto 判定（`TOOL_SEARCH_MODE=auto` 默认）：可延迟集合 ≥ `TOOL_SEARCH_MIN`（10）或 deferred schema token ≥ `TOOL_SEARCH_TOKEN_PCT%`（10%）预算 → 本回合启用；模型用 `tool_search(query, limit≤10)` 检索激活（写入 Run 级 activatedTools，跨回合保留不跨 Run）；未激活 deferred 直接调用 → 拒绝并回灌提示；
- 检索为 BM25 + 嵌入融合（`0.65*词法 + 0.35*语义`；嵌入缺省 / 失败静默退化为纯 BM25）；`TOOL_SEARCH_MODE=off` 一键回退全量加载。

## 14. 定时任务（M35）

会话级定时任务：到点自动让指定成员开工（run）或只发提醒（remind）。服务端 tick 独立驱动（`SCHEDULE_ENABLED` 可关）；agent 侧三工具 `schedule_task`（创建）/ `list_schedules`（只读）/ `manage_schedule`（pause / resume / remove / run_now）均 `tier='deferred'`（经 tool_search 激活，仅 8 个时间敏感角色白名单可发现）。

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/sessions/:id/schedules` | 本会话任务清单（next_run_at 升序） | `{ schedules: ScheduledTask[] }` |
| POST | `/api/sessions/:id/schedules` | 创建（body：title / kind / instruction / targetAgentId? / spec） | `{ task }` |
| PATCH | `/api/schedules/:id` | 部分更新（仅文案变化不打乱调度节奏；spec 变化全量重校验并重算 next） | `{ task }` |
| DELETE | `/api/schedules/:id` | 删除 | `{ ok: true }` |
| POST | `/api/schedules/:id/run` | 立即执行一次（不推进原定节奏；会话忙时 `400`） | `{ task, runId?, messageId?, skipped? }` |
| POST | `/api/schedules/:id/pause` | 暂停（保留配置可恢复） | `{ task }` |
| POST | `/api/schedules/:id/resume` | 恢复（重算 next 并重置失败计数） | `{ task }` |
| GET | `/api/schedules/upcoming?hours=24` | **P5**：跨会话「今日安排」聚合（未来窗口内的启用任务；按会话可见性过滤，与 `/runs/active` 同口径） | `{ tasks: Array<{ id, sessionId, sessionTitle?, title, kind, nextRunAt }> }` |

- 规格 `ScheduleSpec`：`{ kind:'once', at }`（ISO 含偏移，须为未来）或 `{ kind:'cron', expr }`（5 段「分 时 日 月 周」，支持 `*` / `n` / `a-b` / `a,b,c` / `*/n`）；可选 `tz`（IANA，缺省 = 服务器默认时区）；
- 触发语义：**run** 注入 `@target instruction` 用户消息（带 `scheduleId`，前端渲染「定时」徽章）并启动运行；**remind** 落 system 事件条（不进上下文，零 token）；忙时自动触发跳过留痕（`skipped-busy`）、超出补跑窗口（`SCHEDULE_CATCHUP_MS`）的错过触发记 `skipped-missed`、连续失败达阈值（`SCHEDULE_FAIL_LIMIT`，默认 3）自动暂停；
- 通知：`notify:schedule-changed`（payload `{ action: created / updated / deleted / fired / reminded / skipped-busy / skipped-missed / paused / error, task, message?, runId?, messageId? }`）与 `notify:schedule-reminder`（`{ task, messageId, message }`）；
- 未装配（服务未启动）→ 路由统一 `503`；错误码：任务不存在 `404`，参数校验 / 跨会话操作 / 最小间隔不足 / 单会话上限 `400`。

## 15. 金融投研（M34）

金融数据网关（三源混合 + 能力级降级链）与 `fin_*` 工具族的 HTTP 面（9 条路由，挂载 `/api` 之下；决策见 ADR 66，专项设计源 [finance-invest-design.md](finance-invest-design.md)）。`FINANCE_ENABLED=false`（默认）时路由统一 `503`（主区 Tab 与工具双不注册）；上游数据源全失败 `502`；zod 校验失败 `400`。响应统一携带 `source`（实际来源）、`asOf`（数据时点）与 `cache`（命中态；`stale` = 源全失败回退过期数据），降级时附 `degraded` 原因链。

### 15.1 环境与自选

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/finance/env` | 环境与数据源健康度（Python 桥探测 / 反爬冷却 / 运行参数回显；`?refresh=1` 强制重探） | `{ enabled, py, health, watchlistCount, settings: { quoteRefreshMs, minIntervalMs, snapshotDir, gameMaxPaths, gameSeed } }` |
| GET | `/api/finance/watchlist` | 自选列表（全局单表跨会话共享；sort 升序） | `{ items }` |
| POST | `/api/finance/watchlist` | 添加 / 更新自选（symbol 唯一 upsert；经网关归一化，`type` 可选消歧） | `{ item, created, label }`；未识别标的 `400` |
| DELETE | `/api/finance/watchlist/:symbol` | 移除自选（容错 6 位代码尾匹配；命中多条 `400`，不存在 `404`） | `{ ok, removed }` |

### 15.2 行情数据

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/finance/quote` | 批量实时行情（`symbols` 逗号分隔 ≤50） | `{ quotes, unresolved, source, asOf, cache?, degraded? }` |
| GET | `/api/finance/kline` | K 线 + 技术指标序列（行情 Tab 与图表数据源） | `{ kline, indicators, render, warnings?, cache, degraded? }` |
| GET | `/api/finance/search` | 标的检索（`q` ≤40 字符，代码 / 名称 / 拼音；`type` 过滤） | `{ rows, source, asOf, cache?, degraded? }` |
| GET | `/api/finance/news` | 个股公告 / 市场快讯（`symbol` / `market` / `limit` ≤20 / `since`） | `{ items, source, asOf, cache?, degraded? }` |

- **quote**：单次 ≤50（超出 `400`）；未识别标的单列 `unresolved`（不影响已识别部分；全部未识别 `400` 并引导 `/finance/search`）；
- **kline**：`period` ∈ day/week/month/min5…min60（缺省 day）、`adjust` ∈ qfq/hfq/none（缺省 qfq）、`limit` 5–500（缺省 250）；`indicators` = 渲染面板（逗号分隔，缺省 `MA,VOL`；可选 MA/EMA/VOL/MACD/RSI/KDJ/BOLL/ATR，非法值 `400`）——服务端只算 MA/EMA/MACD/RSI/KDJ/BOLL/ATR（VOL 由渲染端从 bars.volume 绘制），单项指标失败进 `warnings` 不阻断；K 线为空 `502`；
- **降级链**（网关内建）：quote `eastmoney → tencent → sina → akshare(Py)`；kline 日/周/月 `baostock(Py) → eastmoney → akshare(Py)`、分钟 `eastmoney → akshare(Py)`；`source` 参数（`auto|node|py`）可强制层级（quote / kline / news 支持）；
- **缓存与时效**：SQLite 缓存（K 线按 symbol+period+adjust 写覆盖，日/周/月线按北京时间自然日、分钟线 5 分钟；快照 10s 防抖；新闻 30 分钟；symbol 主档 7d；screen 底表 10min；交易日历 12h）；非交易时段不轮询；`asOf` = 数据时点，源全失败回退过期数据标 `cache: 'stale'`。

### 15.3 博弈推演

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| POST | `/api/finance/game` | 多空博弈推演（纯计算可复现、不耗 LLM；`action` ∈ matrix/sequence/evolve/simulate） | `{ ...GameResult, modelLabel, note? }` |

- 请求体：`{ action, topic ≤80, symbol?, params?, seed? }`（`seed` 缺省 = `FINANCE_GAME_SEED`）；`simulate` 的 `paths` 超 `FINANCE_GAME_MAX_PATHS` 按护栏截断并在 `note` 提示；参数越界 / 模型非法 `400`（GameError 中文文案）；
- `GameResult`：`{ model, topic, symbol?, params, seed, result, stats, narrative, warnings? }`；相同 `seed + params` 输出逐位一致（mulberry32 PRNG）；
- 前端「博弈」Tab 直连本路由调参重跑（毫秒级、不落盘；含场景预设与本地运行历史）；「交给 Agent 解读」注入 Composer 草稿——由成员用 `fin_game` 复现并落盘 `charts/` 快照后回贴 ```game 块。

## 16. 画布与媒体创作（M31）

会话级无限画布（JSON 单文档 + `version` 乐观锁）与媒体生成任务管线（连接中心 `media` 类 + 四适配器：comfyui / sdwebui / openai-compat / task-template）。10 条路由挂载 `/api` 之下；决策见 ADR 59 / ADR 61，设计见 design.md §49（**M56**：媒体连接全局共享、配置入口迁「设置 → 媒体生成」，决策见 ADR 0124 / design.md §76）。生产启动全部装配（未装配时对应路由 `503`）；会话不存在 `404`。

### 16.1 画布文档

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/sessions/:id/canvas` | 会话画布文档（无文档返回空白文档兜底） | `{ doc, mediaBound }`（`mediaBound` = 全局是否有启用中的媒体连接，生成面板引导用；M56 全局口径） |
| PUT | `/api/sessions/:id/canvas` | 用户保存（body `{ baseVersion, viewport, nodes, edges }`；乐观锁冲突 `409` 回传服务端最新版，前端空闲合流） | `{ doc }`；`409 { error, doc }` |

- 文档 `CanvasDoc`：`{ v: 1, sessionId, version, updatedAt, viewport { x, y, zoom }, nodes[], edges[] }`；`nodes` ≤ 2000 / `edges` ≤ 4000 / `zoom` 0.05–10，越界 `400`；7 类节点（image / video / note / prompt / mind / artifact / group）与边三分语义（`flow` 数据流 / `mind` 层级 / `ref` 引用）；
- agent 写入（`canvas_write` 工具）经 `CanvasStore.applyOps` 读-改-写（缺省 id 服务端生成 / 自动排布 / connect 去重 / remove 级联删边），完成后广播 `notify:canvas-changed`（payload `{ sessionId, version, by }`，`by='agent'`）。

### 16.2 媒体生成任务

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/media/providers` | 启用中的媒体连接的可用能力 / 模型 / 工作流模板清单（M56：全局，不区分会话；生成面板与 Agent 工具共用） | `{ providers }` |
| GET | `/api/sessions/:id/media/jobs` | 会话任务历史（内存，最近 50 条；产物以交付件为持久真相） | `{ jobs }` |
| POST | `/api/sessions/:id/media/jobs` | 创建任务（「创建即返回」；启用连接解析（M56：全局启用清单，缺省取首个启用）/ 能力裁剪 / 输入校验在服务端收口） | `{ job }`；校验失败 / 不可用 `400` |
| GET | `/api/media/jobs/:id` | 单任务状态 | `{ job }`；不存在 `404` |
| POST | `/api/media/jobs/:id/cancel` | 取消（含远端取消） | `{ job }` |
| POST | `/api/media/jobs/:id/retry` | 重试（重新入队） | `{ job }` |

- 能力 `capability` ∈ `text2image` / `image2image` / `text2video` / `image2video` / `firstlast2video`；请求体 `{ connectionId?, capability, model?, prompt, negative?, inputs? { images ≤ 4, firstFrame?, lastFrame? }, params? { width / height 64–4096, steps 1–150, seed, duration 1–60, workflowId }, canvasTarget? { x, y } }`；
- 状态机 `queued → running → succeeded / failed / canceled`；并发上限 2；超时护栏（图像 5 分钟 / 视频 10 分钟，连接 `timeoutMs` 可覆盖）；产物落 `workspace/<sid>/canvas/media/gen-*`（普通交付件 + `artifact:updated` 广播）；状态与进度节流推送 `notify:media-job`（payload `{ job }`）；
- **M56 全局口径**：媒体连接全局共享——`providersOf` 与任务连接解析均走全局启用清单；未配置引导「尚未配置媒体生成连接：请到「设置 → 媒体生成」创建并启用连接」；绑定接口对 media 返回 `400`（§11.2）；`media_generate` / `media_video` 工具与本路由同口径。

### 16.3 素材直传与脑图生成

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| POST | `/api/sessions/:id/media/upload` | 素材直传（raw 二进制 ≤ 200MB；文件名经 `x-file-name` URL 编码） | `{ path, kind, size }` |
| POST | `/api/sessions/:id/canvas/mind` | 脑图生成（LLM 结构化；只读调用，落画布由前端收口） | `{ tree, source }` |

- 上传白名单：图片 `png / jpg / jpeg / gif / webp / avif / bmp / svg`、视频 `mp4 / webm / mov / m4v`；空体 / 类型不支持 `400`，超限 `413`；落 `canvas/media/up-*` 成为普通交付件并广播 `artifact:updated`；
- 脑图 `source` ∈ `conversation` / `plans` / `tasks` / `memory` / `topic`（`topic` 来源必填 `topic` ≤ 200，否则 `400`）；来源无内容 / 输出不可用 `422`、模型调用失败 `502`。

Agent 侧对应四工具 `canvas_read` / `canvas_write` / `media_generate` / `media_video`（均 `tier='deferred'`，语义见 design.md §49.6）；画布主区 Tab 与指令条（M36）见 design.md §49 / §51。

## 17. 认证与账号（M57）

多用户基座（P1）：账号 / 登录 / 会话令牌 / API Key / 个人偏好；决策见 [ADR 0134](adr/0134-multi-user-foundation.md)。

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/auth/status` | 启动路由决策（公开） | `{ needsSetup, authRequired, multiUser }` |
| POST | `/api/auth/setup` | 首启创建首个管理员（仅无账号时可用；自动登录 + 回填存量归属） | `201 { user, mustChangePassword }` + `sid` cookie |
| POST | `/api/auth/login` | 登录（IP 限流 + 账号失败锁定；统一失败文案） | `{ user, mustChangePassword }` + `sid` cookie；锁定 `429` |
| POST | `/api/auth/logout` | 登出（撤销当前令牌，幂等；同时清 `sid` 与 legacy `auth_token` cookie） | `{ ok: true }`（清 cookie） |
| GET | `/api/auth/me` | 当前用户（客户端权限显隐依据；单用户兼容模式返回合成管理员） | `{ user, isAdmin, needsSetup, authRequired, multiUser }` |
| POST | `/api/auth/password` | 自助改密（校验原密码；吊销其它会话，当前会话保留） | `{ ok: true }` |
| GET/PUT | `/api/auth/preferences` | 个人偏好（`user_prefs`；与系统级 settings.json 分离；`searchable` / `allowFriendRequests` / `showReadReceipts`（M80-C，默认开）等） | `{ preferences }` |
| GET | `/api/users` | 账号清单（admin） | `{ users: UserInfo[] }` |
| POST | `/api/users` | 创建账号（admin；邀请制，未给密码则生成且仅返回一次） | `201 { user, initialPassword? }` |
| PATCH | `/api/users/:id` | 显示名 / 角色 / 状态（admin；禁用即时吊销全部会话） | `{ user }` |
| POST | `/api/users/:id/password` | 重置密码（admin；强制首登改密 + 吊销会话） | `{ user, initialPassword }` |
| DELETE | `/api/users/:id` | 删除账号（admin；不能删除自己 / 最后一个管理员） | `{ ok: true }` |
| GET/POST | `/api/users/:id/api-keys` | API Key 管理（admin 或本人；明文仅创建时返回一次） | `{ keys }` / `201 { key, raw }` |
| DELETE | `/api/users/:id/api-keys/:keyId` | 撤销 API Key | `{ ok: true }` |

**鉴权通道**：浏览器 `sid` HttpOnly cookie（登录 / setup 下发；`AUTH_COOKIE_SECURE=true` 时加 Secure）；CLI `Authorization: Bearer mk_*`（API Key）；legacy `AUTH_TOKEN`（Bearer / `auth_token` cookie / `/?token=`）映射最早管理员，兼容期保留。

**首登强制改密**：`mustChangePassword=true` 的账号在改密前仅可访问 `/api/health`、 `/api/auth/me`、`/api/auth/password`、`/api/auth/logout`、`/api/auth/preferences`，其余 `/api` 一律 `403`（防初始密码长期有效）。

**隔离语义（P1）**：登录态下所有 `/api/sessions*`、`/api/search`、`/api/runs/*`、`/api/notifications`、会话子资源（消息 / 交付件 / 画布 / 媒体 / 日程 / 绑定 / 浏览器）、`/api/finance/watchlist`、`/api/memories*` 均按属主过滤；跨用户访问一律 `404`。管理面（`/api/connections` 管理端与测试 / 工作台、`/api/mcp/*`、`/api/console/*`、`/api/metrics/*`、`/api/audit`、`PUT /api/settings`、`/api/users`）→ `admin`；成员可在自有会话绑定使用 `member_use=1` 的 system 连接（`GET /api/connections` 返回脱敏可用清单）。单用户兼容模式（尚无账号且未配 `AUTH_TOKEN`）保持旧行为（全部放行）。

## 18. 会话共享协作（M57 P2）

共享角色模型：`owner`（属主，`sessions.owner_id`）→ `editor`（可读写）→ `viewer`（只读，可自助退出）；读取 = owner ∪ 成员，写入 = owner / editor。决策见 [ADR 0142](adr/0142-session-sharing-collaboration.md)。

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/sessions/:id/shares` | 任何可见者 | 共享面板：`{ owner, members: SessionShare[] }` |
| POST | `/api/sessions/:id/shares` | 仅属主 | 邀请（body `{ username, role?: 'editor'\|'viewer' }`）；目标不存在 404 / 已在成员 409 / 邀请自己或属主 400 |
| PATCH | `/api/sessions/:id/shares/:userId` | 仅属主 | 改角色（`{ role }`） |
| DELETE | `/api/sessions/:id/shares/:userId` | 仅属主 | 移出共享 |
| POST | `/api/sessions/:id/leave` | 成员本人 | 自助退出（viewer 亦可；属主 400「不能退出」；direct 400「私聊不支持退出」——M79-AA） |

**行为变化（P2）**：

- `GET /api/sessions` 返回「本人 + 共享给我」，每项附 `role`（`owner` / `editor` / `viewer`）；
- `GET /api/search` 检索范围同步扩为「本人 + 共享」（跨用户仍不可见）；
- 会话子路由写操作（消息 / 插话 / 停止 / 审批 / 成员 / 画布 / 上传……）对 `viewer` 一律 `403`（`POST /sessions/:id/leave` 例外）；`DELETE /api/sessions/:id` 与共享管理仅属主；
- 共享会话（≥2 人类）上下文装配中人类消息改署昵称（`【Alice】…`），独占会话 / 兼容模式沿用 `【用户】`；`GET /api/sessions/:id` 附 `humanNames`（userId → 昵称；客户端消息气泡署名，兼容模式为空）；
- 变更广播 `notify:share-changed`（payload `{ sessionId, userId, action, role? }`）+ 审计 `session.share-*`；
- **连接最小权限复核（SSH / 数据库执行侧）**：`ssh_exec` / `db_*` 工具以「本 Run 触发者」复核——成员仅可用 `member_use=1` 的 system 连接（admin / 兼容模式 / 未知触发者不限）；`ssh.exec` / `db.*` 审计携带 `userId`（触发者）；工具只读结果缓存的键含会话与触发者（不跨用户复用）。

**群管理生命周期（M79-AA，ADR 0201）**：

- 群聊成员「退出群聊」= 复用 `POST /sessions/:id/leave`（退出后失去访问、群历史对其他成员保留）；群聊解散 = 属主 `DELETE /sessions/:id`（硬删除，所有成员失去访问）；
- 退出 / 移出留痕：会话内 append system 事件条（group「X 退出了群聊 / A 将 B 移出了群聊」；team「…协作」；direct 不适用）+ `notify:turn-end` 广播（同会话 upsert / 跨会话列表预览）；钩子装配见 `routes/index.ts`（`appendSystem`）；
- 群名称（`PATCH /sessions/:id { title }`）仅 group owner 可改（editor 403「仅群主可修改群名称」）；`routeMode` 等其他字段维持 M79-E 权限矩阵（editor 可写）；
- 解散广播 `notify:session-deleted` payload 增 `kind`（`{ kind: 'group' }` → 客户端「群聊已被解散」；toast 以 `session-deleted-<id>` 去重）。

## 19. 配额与用量（M57 P3）

按用户配额（并发 / 日 token / 月成本 / 会话数 / 存储）；无配额行 = 全部不限（兼容模式零变化）。决策见 [ADR 0147](adr/0147-user-quota-and-usage.md)。

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/usage/me` | 登录用户 | 个人用量汇总 + 生效限额：`{ summary: { todayTokens, monthCostUsd, sessions, storageMb, limits } }`（兼容模式 userId 为空串） |
| GET | `/api/users/:id/quota` | admin 或本人 | 生效限额（含与 `RUN_MAX_PER_USER` 取小后的并发上限） |
| PUT | `/api/users/:id/quota` | admin | 设置配额（五字段均可选；`null` = 清除该项回不限；全空自动清理）；审计 `auth.quota-set` |
| GET | `/api/users/:id/usage` | admin | 逐用户用量汇总（同 `/usage/me` 形状） |

**强制点与文案**：并发超限 → `POST /sessions/:id` 系列返回 400「同时进行的任务数已达上限」；日 token / 月成本超限 → 波次边界收束当前 Run（`run:end reason='quota'` + 系统事件条「用量配额已超限：…」）；会话数超限 → `POST /api/sessions` 403；存储超限 → 附件 / 画布素材上传 403（工作区体积实测 + 本次增量）。

## 20. 个人连接与成员可用开关（M57 P3）

`scope='personal'`（属主私有）与 system 连接的 `memberUse` 开关；决策见 [ADR 0148](adr/0148-personal-connections.md)。

| 行为 | 变化 |
| --- | --- |
| `ConnectionDefinition` | 新增 `scope`（system / personal）、`ownerId`、`memberUse`（默认 true） |
| `POST /api/connections` | 成员放行 → 一律落 personal（scope/owner 服务端定）；成员建 `embedding`/`media` → 403（全局单例） |
| `GET /api/connections` | 成员 = 可用 system（config 脱敏）+ 本人 personal（config 完整，自管需要） |
| `GET/PUT/DELETE /api/connections/:id`、`/test`、`/schema`、`/sql`、`/tables/:table/rows`、`/ssh/terminal-token` | 守卫从 adminOnly 改为 **admin 或属主**；成员访问 system / 他人 personal → 404 |
| `POST /api/sessions/:id/connections`（绑定） | 成员可绑：`member_use=1` 的 system ∪ 本人 personal；其余 403 |
| `PUT` 配额语义 | 成员改自有 personal 时 `memberUse` 字段被忽略（无意义）；admin 改 system 可关开关后：成员列表隐藏 / 绑定 403 / 工具执行拦截 |
| 账号删除 | 级联删除其 personal 连接（会话绑定随外键自动清理） |

## 21. 模型直连（BYOK，M57 P3）

用户自带 LLM 凭据（按会话属主解析；无凭据 = 系统默认）；决策见 [ADR 0153](adr/0153-user-byok-llm.md)。

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/auth/llm-credentials` | 登录用户 | 状态投影（绝不含密钥）：`{ status: { configured, baseUrl?, model?, updatedAt? } }`；兼容模式 `configured=false` |
| PUT | `/api/auth/llm-credentials` | 登录用户 | 保存 / 覆盖：`{ apiKey(≥8 必填), baseUrl?(http(s)), model? }`；审计 `auth.llm-credential-set`；兼容模式 400 |
| DELETE | `/api/auth/llm-credentials` | 登录用户 | 清除回系统默认；审计 `auth.llm-credential-clear`；兼容模式 400 |

**语义**：配置后本人会话的全部模型调用（回合 / 压缩摘要 / 记忆沉淀 / 脑图）走用户凭据；`baseUrl`/`model` 留空分别跟随系统默认；`usage.model` 记录实际生效模型（成本单价准确）；`LLM_MOCK=true` 时 BYOK 不参与（确定性优先）。

## 22. 个人 MCP（M57 P3）

成员的 personal MCP 服务器（属主私有；属主会话内自动授予工具）；决策见 [ADR 0157](adr/0157-user-personal-mcp.md)。

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/mcp/servers` | 登录用户 | admin = 全量；成员 = 绑定候选（全部 system ∪ 本人 personal） |
| GET | `/api/mcp/servers/:id` | ownerOrAdmin | 成员仅限自己的 personal；system / 他人 personal → 404 |
| POST | `/api/mcp/servers` | 登录用户 | admin = system；**成员一律落 personal**（scope/owner 服务端定）；审计 `mcp.create`（含 scope/ownerId） |
| PUT / DELETE / POST | `/api/mcp/servers/:id`（含 `/test` `/reconnect` `/refresh` 子路由） | ownerOrAdmin | 成员仅限自己的 personal |
| GET / POST `/api/mcp/json-config*`、GET `/api/mcp/tools` | 同上 | admin | 管理面（文件权威同步 / 授权矩阵） |
| POST | `/api/sessions/:id/mcp-servers` | 会话写权限 | 可绑：全部 system（现状）∪ 本人 personal；他人 personal → 404；personal 绑定后自动拉起连接 |
| GET | `/api/sessions/:id/mcp-servers` | 会话可见 | 绑定清单（防御性过滤：他人 personal 不出现） |

**语义**：personal 服务器仅在其**属主会话**中可用（`session.ownerId === server.ownerId`；非属主会话 / 无属主会话不可见）；执行侧再校验（`ctx.userId` = 会话属主，他人触发拒绝）；属主会话内**自动授予**该会话全部成员（无需管理员编辑 Agent 工具白名单）；账号删除级联清理（先断连再删行，绑定随 FK 解绑）。

## 23. 用户素材库（M68）

per-user 私人素材库（跨会话复用上传 / 收藏的图片 / 视频 / 音频）；独立菜单管理页面（ActivityRail「素材库」，全员可见）。决策见 [ADR 0158](adr/0158-user-material-library.md) · 设计见 [docs/material-library-design.md](material-library-design.md)。

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/library/items?query=&kind=&limit=` | 登录用户 | 我的素材列表（元数据，不含内容；新→旧；query 对展示名子串；limit ≤200）→ `{ items: LibraryItem[] }` |
| POST | `/api/library/uploads` | 登录用户 | raw 二进制上传（≤200MB，`x-file-name` 携原名；图片 / 视频 / 音频白名单；**存储配额闸门** 403）→ `{ item }` |
| GET | `/api/library/items/:id/content` | 登录用户（owner） | 内容流（sendFile 原生 Range / 206；MIME 白名单；非属主 404） |
| POST | `/api/library/items/:id/to-canvas` | 登录用户（owner） | **copy-on-use 入仓**：`{ sessionId }` → 拷贝为会话工作区 `library/ref-<ts>-<id><ext>` → `{ path, kind }`（前端 sendArtifact 落节点）；会话不可访问 404 |
| DELETE | `/api/library/items/:id` | 登录用户（owner） | 删除（行 + 文件双清；非属主 404） |
| GET | `/api/library/usage` | 登录用户 | 容量：`{ usage: { count, bytes, limitMb? } }`（limitMb 命中用户存储配额时下发） |

**语义**：owner 一律服务端取（登录身份；单用户兼容模式固定 `'local'`）——不信请求体（同 ADR 0148 纪律）；素材种类 `kind = image | video | audio`（扩展名 / MIME 白名单与附件通道 `util/mime.ts` 同口径）；存储落 `workspace/_library/u_<uid>/`（计入存储配额体积与备份面）；账号删除级联清空（行 + 属主目录）；存量会话素材**不自动入库**（按需「存为素材」列 P2）。


## 24. 社交协作（M79）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/inbox?since=&limit=` | 本人 | 收件箱增量（`{ items, cursor, unreadCount }`；actorName 随行投影） |
| POST | `/api/inbox/read` | 本人 | 单项 / 整段已读（`{ ids? }` 或 `{ upTo }`） |
| POST | `/api/sessions/:id/read` | 读级（viewer 亦可） | 会话已读上报（`{ seq }`；单调推进 + 本人其他端 `notify:read-state` 广播；**M80-C**：开关开 → 会话主题广播 `notify:read-receipt`，关闭者不广播且自身空投影——对等双向） |
| GET | `/api/ws/stats` | admin | 实时通道观测（连接 / 活跃用户 / 队列水位 / evictions / resyncs） |
| GET | `/api/me`（等价 `/api/auth/me`）· PATCH `/api/auth/profile` | 本人 | 画像维护（`displayName / headline / bio / avatar`；null = 清除） |
| GET | `/api/users/search?q=` | 成员 | 用户搜索（隐私开关：searchable=false 仅精确 username；排除自己 / 停用 / 拉黑对；30 次/分） |
| GET/POST | `/api/friends` · `/api/friends/requests`（GET/POST） | 成员 | 好友清单 / 请求收发（username 或 userId 寻址；日限流 20） |
| POST | `/api/friends/requests/:id/accept` · `/reject` | 接收方（reject 亦支持发出方撤回） | 请求处理 |
| DELETE | `/api/friends/:userId` | 任一方 | 解除好友 |
| POST | `/api/friends/:userId/block` · `/unblock` | 本人 | 拉黑（隐含解除；四面切断）/ 解除拉黑（仅拉黑方） |
| POST | `/api/chats/direct` | 成员（好友校验） | 私聊创建 / 复用（`dm_key` 唯一；`{ session, created }`） |
| POST | `/api/chats/group` | 成员 | 群聊创建（`{ title?, memberIds }`；1–50 人且须为创建人好友） |
| POST/DELETE | `/api/sessions/:id/hide` | 会话可见者 | 隐藏 / 取消（DM「删除」语义；新消息自动复现） |
| PATCH | `/api/sessions/:id` | owner / editor | 新增 `routeMode: 'auto' \| 'mention'`（触发策略；session-meta 广播 + 审计） |
| GET | `/api/sessions`（变更） | 现状 | `unreadCount` / `kind` / `routeMode` / `waitingOn` 随行；direct 标题 = 对端显示名；隐藏会话按「无未读」过滤 |
| POST | `/api/sessions/:id/messages`（拉黑面） | 拉黑对 | **人物私聊**内发新消息 → `403`（拉黑方「你已拉黑对方：解除后可继续聊天」/ 被拉黑方「对方设置了隐私限制，无法发送消息」；团队会话不受限；ADR 0198） |
| POST | `/api/auth/avatar` | 本人 | **图片头像上传**（raw 二进制 ≤2MB；魔数仅 PNG/JPEG/WebP——拒绝 SVG；返回 `{ user }`，avatar 投影为公开 URL） |
| GET | `/api/avatars/:file` | 登录用户 | 头像文件读取（文件名白名单防穿越；`immutable` 长缓存；缺失 404 → 客户端回退首字） |
| `notify:presence` | — | 好友 ∪ 同会话成员 | 收件人 = 好友 ∪ 主体所属会话的属主与全部人类成员（`createPresenceRecipients`；去重 / 排除本人 / 无关联不可见；ADR 0197） |

WS 新帧（`/ws`）：`notify:inbox` / `notify:read-state` / `notify:presence` / `notify:friends-changed` / `notify:session-meta` / `notify:read-receipt`（M80-C）/ `notify:reaction`（M80-B）/ `resync` / `error(code=conn_evicted|acl-changed)`；客户端 `read` / `inbox-ack`。详见 ADR 0188–0198、0206–0208。

## 25. 空间（Space，工作生活一体 P1–P3）

| 方法 | 路径 | 说明 | 关键返回 |
| --- | --- | --- | --- |
| GET | `/api/spaces` | 空间清单（内置「我的 / 工作 / 生活」+ 自建；按 sort） | `{ spaces: Space[] }` |
| POST | `/api/spaces` | 创建空间（`{ name, kind?, icon? }`；kind 缺省 custom；sort 递增） | `201 { space }` |
| PATCH | `/api/spaces/:id` | 改名 / 图标 / 排序 / 默认灵魂（`soulOverrides`：agentId → soulId，`null` 清除；内置可改展示元数据、不可改 kind） | `{ space }` |
| DELETE | `/api/spaces/:id` | 删除自建空间（**内置拒绝**；关联会话经外键置空回「我的」） | `{ ok, sessionsDetached }` |

- 会话归属：`Session.spaceId` 缺省 / `'default'` 不落字段（存量零迁移）；`POST /api/sessions` 可带 `spaceId`；`PATCH /api/sessions/:id { spaceId }` 与改名同口径（多用户仅属主）+ `notify:session-meta`；fork 继承源会话空间；
- 记忆域（P2）：`GET /api/memories?spaceId=`（见 §5.1）；召回谓词 = 同空间 ∪ 跨域共享；
- 默认灵魂（P3）：`soulOverrides` 在会话创建 / 成员入编时作为默认值解析（显式选择优先；分身键内嵌跳过）；
- 边界：空间为个人级视图层实体（多用户模式暂全实例共享，用户级隔离留待后续批次）；决策见 ADR 0209–0211。

## 26. 仪式订阅（P4-A，工作生活一体）

| 方法 | 路径 | 说明 | 返回 |
| --- | --- | --- | --- |
| GET | `/api/rituals` | 本人订阅清单（多用户按登录用户；兼容模式 'local'） | `{ rituals: RitualSubscription[] }` |
| POST | `/api/rituals` | 订阅场景仪式（`{ sceneId, spaceId? }`；title / cron / opener / members 从 `_group.yaml` 声明服务端解析并快照；同场景幂等；上限 10/用户） | `201 { ritual }` |
| DELETE | `/api/rituals/:id` | 退订（仅本人；跨用户 404） | `{ ok: true }` |
| PATCH | `/api/rituals/:id` | 编辑订阅（`{ enabled?, cron? }`；cron 变更与「恢复」均重校验并重算 next；仅本人） | `{ ritual }` |

- 到点行为（调度 tick 同轮）：建会话（标题 `${title} · MM-DD`，编制 = 订阅快照 members，空编制走 PRS）+ 落 opener 用户消息 → 启动协作运行；补跑窗口 / 失败留痕同 M35（`scheduled_tasks`）；
- 客户端入口：新建会话对话框场景卡「订阅 / 已订阅」toggle（仅声明 `ritual` 的场景）；声明为 cron 5 段表达式；决策见 ADR 0215。

## 附录 A：SSE 运行事件速查

| 事件 | 触发 | 关键字段 |
| --- | --- | --- |
| `user:message` | 用户消息入队（含插话注入） | `message` |
| `run:start` / `run:end` | Run 生命周期 | `runId, sessionId, queue`（首波成员） / `reason`（`completed` / `max_turns` / `stopped` / `error`） |
| `wave:start` | 波次启动（串行波也发、`members` 长度 1） | `runId, sessionId, waveIndex, members: string[], mode`（M24 本波范式） |
| `turn:start` / `turn:end` | 回合边界（成员粒度；并行波内多个并发） | `agentId, messageId, turnIndex`（= 波次号，同波消息共享） / `mode`（M24 回合范式） / `mentions`（调度器实际入队结果） |
| `message:delta` | 流式增量（正文 / 思考分通道） | `messageId, delta` |
| `tool:call` / `tool:result` | 工具执行 | `name, args` / `ok, summary, detail` |
| `artifact:updated` | 交付件写入 | `path, authorAgentId` |
| `context:compressed` | 压缩事件（含前后 token） | `before, after, untilSeq` |
| `agent-status` | 状态变化（`thinking` / `speaking` / `idle` / `done` / `error`） | `agentId, status` |
| `approval:requested` / `approval:resolved` | 审批生命周期 | `approval` |
| `plan:submitted` / `plan:updated` | 计划生命周期（M24：提交挂起 / 版本修订 / 状态推进） | `plan` |
| `review:submitted` | 评审结果提交（M24） | `review`（verdict / findings / target） |

**M15–M18 语义速记**：

- `handoff` 工具 `target` 接受 `string | string[]`（≤4；多目标 = fan-out 并行意图，`user` 仅允许单独使用；部分解析失败不拖累其他目标）；M87 增 `artifacts[]`（交接包，≤8；缺省自动带出本轮产出）与 `notes`（交接口径 ≤300 字），路径经索引校验后注入接手方回合指令；
- `turnIndex` 语义 = **波次号**：同波（并行）消息共享，前端按「同 runId + 同 turnIndex 连续 ≥2 条」推导并行协作组；波内成员互相不可见对方当前输出（统一基于波前历史）；
- 波次合并后的队列复用 `queue:updated` 广播；`maxTurnsPerRun` 语义 = 最大波数（波内人数不额外占配额）；并行上限 `PARALLEL_MAX`（场景可在 `_group.yaml` 用 `parallelMax` 覆盖）。

## 附录 B：鉴权与错误码约定

| 状态码 | 语义 |
| --- | --- |
| `400` | 参数校验失败 / 业务前置条件不满足（文案即原因） |
| `401` | 未登录 / 登录已失效（未 setup 的单用户兼容模式下：`BIND_ALL=true` 且 token 缺失 / 非法） |
| `403` | 角色越权（member 访问 admin 管理面 / 连接不允许成员使用）；非 GET 请求 Origin 不在白名单 |
| `404` | 资源不存在（会话 / 运行 / 消息 / 版本 / 审批）；**跨用户访问一律 404（不泄漏存在性）** |
| `413` | 上传或内联内容超限 |
| `429` | 消息接口触发限流（按用户）；登录失败锁定 / 登录接口限流 |
| `500` | 服务端异常（统一错误中间件兜底 + 落日志） |
