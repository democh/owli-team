/**
 * API 路由聚合（§9）：全部挂载于 /api，错误统一 { error }（中文文案）。
 */
import { Router } from 'express'
import type { Request, RequestHandler } from 'express'
import type { AppConfig } from '../config.js'
import type { AuthUser } from '../auth/service.js'
import type { AuthService } from '../auth/service.js'
import type { AccessService } from '../auth/access.js'
import { assertRunAccess, createSessionAccessGuard } from '../auth/guards.js'
import type { UserStore } from '../store/users.js'
import { createAuthRouter } from './auth.js'
import { createInboxRouter } from './inbox.js'
import { createFriendsRouter } from './friends.js'
import { createChatsRouter } from './chats.js'
import type { InboxAddInput, InboxStore } from '../store/inbox.js'
import type { SessionReadsStore } from '../store/session-reads.js'
import type { FriendStore } from '../store/friends.js'
import type { SessionHideStore } from '../store/session-hides.js'
import { createLlmCredsRouter } from './llm-credentials.js'
import { createSharesRouter } from './shares.js'
import { createUsageRouter } from './usage.js'
import { createUsersRouter } from './users.js'
import type { ApprovalService } from '../approval.js'
import type { PlanReviewService } from '../plan-review.js'
import type { ContextService } from '../context/service.js'
import type { Engine } from '../orchestration/engine.js'
import type { ArtifactStore } from '../store/artifacts.js'
import type { ArtifactVersionStore } from '../store/artifact-versions.js'
import type { FeedbackStore } from '../store/feedback.js'
import type { MemoryStore } from '../store/memory.js'
import type { ToolMetricsStore } from '../store/metrics.js'
import type { PlanStore } from '../store/plans.js'
import type { ProjectStore } from '../store/projects.js'
import type { PromptLibrary } from '../store/prompts.js'
import type { ReviewStore } from '../store/reviews.js'
import type { RunEventStore } from '../store/run-events.js'
import type { RunStore } from '../store/runs.js'
import type { SessionMemberStore } from '../store/session-members.js'
import type { SessionStore } from '../store/sessions.js'
import type { QuotaService } from '../quota/service.js'
import type { LlmCredentialStore } from '../store/llm-credentials.js'
import type { SkillLibrary } from '../store/skills.js'
import type { TaskStore } from '../store/tasks.js'
import type { UsageStore } from '../store/usage.js'
import type { WorkspaceService } from '../workspace.js'
import type { NotifyHub } from '../ws.js'
import type { ConnectionStore } from '../store/connections.js'
import type { EmbeddingManager } from '../embeddings/manager.js'
import type { MemoryService } from '../memory/service.js'
import type { AuditStore } from '../store/audit.js'
import type { DbConnectionManager } from '../connections/db/manager.js'
import type { SshConnectionManager } from '../connections/ssh/manager.js'
import type { BrowserRuntime } from '../browser/runtime.js'
import type { StreamTokenService } from '../browser/stream-token.js'
import type { AssetManager } from '../assets/manager.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { McpServerStore } from '../store/mcp-servers.js'
import type { McpRuntimeManager } from '../mcp/manager.js'
import type { McpJsonConfigService } from '../mcp/json-config.js'
// M31：无限画布（文档存储 / 素材上传 / 脑图生成）
import type { CanvasStore } from '../canvas/store.js'
import type { MindGenerator } from '../canvas/mind.js'
import type { MediaService } from '../media/service.js'
// M35：定时任务（调度服务；缺省 = /schedules 路由 503 未装配）
import type { ScheduleService } from '../schedule/service.js'
// M34：金融投研（数据网关 + 自选列表存储；缺省 = /finance 路由 503 未启用）
import type { FinanceGateway } from '../finance/gateway.js'
import type { PyEnvStatus } from '../finance/bridge/probe.js'
import type { FinanceStore } from '../store/finance.js'
import { createAgentsRouter } from './agents.js'
import { createArtifactsRouter } from './artifacts.js'
import { createContextRouter } from './context.js'
import { createFeedbackRouter } from './feedback.js'
import { createMetricsRouter } from './metrics.js'
import { createProjectsRouter } from './projects.js'
import { createRunsRouter } from './runs.js'
import { createSessionsRouter } from './sessions.js'
import { createAttachmentsRouter } from './attachments.js'
import { createSettingsRouter } from './settings.js'
import { createSkillsRouter } from './skills.js'
import { createConnectionsRouter } from './connections.js'
import { createBrowserRouter } from './browser.js'
import { createMemoriesRouter } from './memories.js'
import { createConsoleRouter } from './console.js'
import { createMcpRouter } from './mcp.js'
import { createCanvasRouter } from './canvas.js'
import { createDesignScenesRouter } from './design-scenes.js'
import { createLibraryRouter } from './library.js'
import { createMediaRouter } from './media.js'
import { createSchedulesRouter } from './schedules.js'
import { createFinanceRouter } from './finance.js'

export interface ApiDeps {
  cfg: AppConfig
  prompts: PromptLibrary
  skills: SkillLibrary
  sessions: SessionStore
  artifacts: ArtifactStore
  /** 会话长期记忆（M2：context / memory 接口） */
  memory: MemoryStore
  /** 上下文服务（M2：分层快照） */
  context: ContextService
  /** 任务清单存储（M3：tasks 接口） */
  tasks: TaskStore
  /** 运行快照存储（M3：断点恢复） */
  runs: RunStore
  /** 工具指标存储（M5：/metrics/tools） */
  metrics: ToolMetricsStore
  /** 运行轨迹存储（M9：/runs/:id/trace 与指标聚合） */
  events: RunEventStore
  /** 消息反馈存储（M9：/feedback 与导出） */
  feedback: FeedbackStore
  /** 项目存储（M6：真实仓库挂载） */
  projects: ProjectStore
  /** 工作区服务（M6：sandbox/repo/worktree 解析与 worktree 生命周期） */
  workspace: WorkspaceService
  /** M57 P2：会话共享成员存储（角色矩阵 / 列表可见性 / 共享面板） */
  members: SessionMemberStore
  /** M57 P3：配额服务（用量看板 / 强制点断言；缺省 = 不限，行为与现状零差异） */
  quotas?: QuotaService
  /** M68：用户素材库（per-user 私人素材；缺省 = 素材库路由 503，测试零影响） */
  library?: import('../library/service.js').LibraryService
  /** M57 P3：用户 LLM 凭据（BYOK）存储（缺省 = 路由不挂载，测试零影响） */
  llmCredentials?: LlmCredentialStore
  /** M57 P3：BYOK 缓存失效回调（凭据变更 → 失效 provider 缓存） */
  llmCredsInvalidate?: (userId: string) => void
  /** 审批服务（M7：挂起 / 决定 / 查询） */
  approvals: ApprovalService
  /** M24：计划存储（/sessions/:id/plans；缺省 = 空列表，行为与现状零差异） */
  plans?: PlanStore
  /** M24：评审存储（/plans 随附 reviews） */
  reviews?: ReviewStore
  /** M24：计划审批服务（resolve 结算挂起；缺省 = 仅稍后批准路径） */
  planReviews?: PlanReviewService
  /** 交付件版本存储（M8：Diff 视图 / 版本列表） */
  versions: ArtifactVersionStore
  /** 用量与成本存储（M8：GET /runs/:id/usage 的本 Run 费用） */
  usage: UsageStore
  /** 消息接口限流（M7：index.ts 创建；测试可缺省） */
  messageLimiter?: RequestHandler
  /** M22：连接中心存储（CRUD / 会话绑定） */
  connections: ConnectionStore
  /** M22：操作审计存储 */
  audit: AuditStore
  /** M22：数据库连接管理器（测试 / 执行） */
  db: DbConnectionManager
  /** M23：SSH 连接管理器（测试 / 终端会话） */
  ssh: SshConnectionManager
  /** M25：嵌入管理（连接测试 / provider 失效 / 状态诊断） */
  embeddings: EmbeddingManager
  /** M25：向量记忆服务（列表统计 / 语义搜索 / 重建 / 候选审核） */
  memories: MemoryService
  /** M22：浏览器运行时（会话 / 步骤 / 系统打开） */
  browser: BrowserRuntime
  /** M22：流 token 服务（帧流 watch / takeover 授权） */
  streamTokens: StreamTokenService
  /** M26：资产控制台（Agent / Skill / 场景 读写与校验；唯一写盘通道） */
  assets: AssetManager
  /** M26：工具注册表（工具中心清单与授权情况） */
  tools: ToolRegistry
  /** M27：MCP 服务器存储（CRUD / 会话绑定；缺省 = MCP 路由 503 未装配） */
  mcp?: McpServerStore
  /** M27：MCP 运行时管理器（连接 / 测试 / 刷新 / 工具目录依赖） */
  mcpRuntime?: McpRuntimeManager
  /** M28：MCP JSON 直配服务（mcp.json 文件权威同步 / 状态 / 粘贴导入；缺省 = json-config 路由 503） */
  mcpJson?: McpJsonConfigService
  /** M31：画布文档存储（GET/PUT /sessions/:id/canvas；缺省 = 503 未装配） */
  canvas?: CanvasStore
  /** M31：脑图生成器（POST /sessions/:id/canvas/mind；缺省 = 503 未装配） */
  mind?: MindGenerator
  /** M31：媒体生成服务（连接适配器 + 任务管线；缺省 = /media 路由 503） */
  media?: MediaService
  /** M35：定时任务服务（CRUD / 启停 / 立即触发；缺省 = /schedules 路由 503） */
  schedules?: ScheduleService
  /** M34：金融数据网关（行情 / K 线 / 检索 / 新闻 / 博弈；缺省 = /finance 路由 503 未启用） */
  finance?: FinanceGateway
  /** M34：金融自选列表存储（/finance/watchlist；缺省 = 路由 503） */
  financeStore?: FinanceStore
  /** M34：Python 环境探测（/finance/env；缺省 = probePython 真实探测（10 分钟缓存；测试注入桩）） */
  financeProbe?: (opts: { python?: string; force?: boolean }) => Promise<PyEnvStatus>
  engine: Engine
  notify: NotifyHub
  /** M57：认证服务（登录态解析 / 账号管理） */
  auth: AuthService
  /** M57：访问控制（归属判定唯一事实源） */
  access: AccessService
  /** M57：账号存储（个人偏好读写） */
  users: UserStore
  /** M57：登录接口 IP 限流 */
  loginLimiter: RequestHandler
  /** M57：管理面守卫（admin / 单用户兼容模式放行） */
  requireAdmin: RequestHandler
  /** M79-A：用户收件箱存储（缺省 = /inbox 返回空 + 会话列表不附加未读，测试零影响） */
  inbox?: InboxStore
  /** M79-A：会话已读游标存储（缺省 = 会话列表不附加未读） */
  reads?: SessionReadsStore
  /** M79：收件箱投递（写库 + 用户主题实时帧；缺省 = 仅落库由调用方保证） */
  deliverInbox?: (input: InboxAddInput) => void
  /** M79-C：好友关系存储（缺省 = /friends 路由不挂载，测试零影响） */
  friends?: FriendStore
  /** M79-D：会话隐藏存储（DM「删除」语义；缺省 = 隐藏过滤跳过） */
  hides?: SessionHideStore
  /** M79-C：在线状态读取（好友清单 / 搜索结果随行投影；缺省 = 全部离线） */
  presence?: { isOnline: (userId: string) => boolean; lastSeenAt: (userId: string) => string | undefined }
}

export function createApiRouter(deps: ApiDeps): Router {
  const router = Router()

  router.get('/health', (_req, res) => {
    // 真实模型为唯一运行路径（§7.4）；M4：下发前端运行参数（通知轮询间隔）
    res.json({
      ok: true,
      model: deps.cfg.llmModel,
      baseUrl: deps.cfg.llmBaseUrl,
      thinking: deps.cfg.llmThinking,
      notifyPollMs: deps.cfg.notifyPollMs,
    })
  })

  /** M79-A：实时通道观测（admin）：连接数 / 活跃用户 / 队列水位 / 踢出与 resync 计数 */
  router.get('/ws/stats', deps.requireAdmin, (_req, res) => {
    res.json(deps.notify.stats())
  })

  // ---------- M57：多用户（认证 / 账号 / 归属守卫 / 管理面 gating） ----------

  const userOf = (req: Request): AuthUser | undefined => (req as Request & { user?: AuthUser }).user

  // 认证与账号（/auth/status|setup|login 在中间件白名单内公开；其余需登录态）
  router.use(
    createAuthRouter({
      cfg: deps.cfg,
      auth: deps.auth,
      users: deps.users,
      loginLimiter: deps.loginLimiter,
      // M79-Y：资料变更 → 好友联系人列表实时刷新（用户主题帧；好友 store 缺省时静默）
      onProfileChanged: (userId) => {
        if (!deps.friends) return
        for (const friend of deps.friends.listFriends(userId)) {
          deps.notify.publishToUser(friend.userId, 'notify:friends-changed', { userId })
        }
      },
    }),
  )
  // M57 P3：个人用量（GET /usage/me）
  router.use(createUsageRouter(deps))
  // M68：用户素材库（per-user；独立菜单管理页面的服务端面）
  router.use(createLibraryRouter(deps))
  // M57 P3：BYOK（用户 LLM 凭据；未装配时跳过——测试夹具无需改动）
  if (deps.llmCredentials) {
    router.use(
      createLlmCredsRouter({
        multiUser: () => deps.access.multiUser,
        credentials: deps.llmCredentials,
        audit: deps.audit,
        onChange: deps.llmCredsInvalidate,
      }),
    )
  }
  router.use(
    createUsersRouter({
      auth: deps.auth,
      requireAdmin: deps.requireAdmin,
      browser: deps.browser,
      // M57：删除账号的磁盘清理依赖
      sessions: deps.sessions,
      workspace: deps.workspace,
      // M57 P3：配额编辑 / 逐用户用量 / 设置审计
      quotas: deps.quotas,
      audit: deps.audit,
      // M57 P3：删除账号时清理 personal 连接
      connections: deps.connections,
      // M57 P3：删除账号时清理 personal MCP（先断连再删行）
      mcpServers: deps.mcp,
      mcpRuntime: deps.mcpRuntime,
      // M68：删除账号时清理素材库（materials 行 + _library/u_<uid>/）
      library: deps.library,
    }),
  )

  /**
   * M79-C：好友（请求 / 接受 / 拉黑 / 成员搜索）+ 通知联动。
   * 注册于会话守卫之前（/friends 与 /users/search 无会话域）；注册于 users 管理路由之后（路径不冲突）。
   */
  if (deps.friends) {
    router.use(
      createFriendsRouter({
        cfg: deps.cfg,
        access: deps.access,
        auth: deps.auth,
        users: deps.users,
        friends: deps.friends,
        audit: deps.audit,
        deliver: deps.deliverInbox,
        publishFriendsChanged: (userId, counterpartId, action) =>
          deps.notify.publishToUser(userId, 'notify:friends-changed', { userId: counterpartId, action }),
        presence: deps.presence,
      }),
    )
  }

  /**
   * M79-D：人物会话（私聊 / 群聊创建；免路由判定在 sessions 消息入口）。
   */
  if (deps.friends) {
    router.use(
      createChatsRouter({
        access: deps.access,
        auth: deps.auth,
        sessions: deps.sessions,
        members: deps.members,
        friends: deps.friends,
        hides: deps.hides,
        deliver: deps.deliverInbox,
        publishShareChanged: (sessionId, userId, action, role) =>
          deps.notify.publish({ type: 'notify:share-changed', sessionId, payload: { sessionId, userId, action, role } }),
      }),
    )
  }

  /**
   * M79-A：收件箱与已读（注册在会话守卫之前——`POST /sessions/:id/read` 为读级放行：
   * viewer 也应能清未读；其内部自行做 assertSession 归属校验）。
   */
  if (deps.inbox && deps.reads) {
    router.use(
      createInboxRouter({
        inbox: deps.inbox,
        reads: deps.reads,
        access: deps.access,
        auth: deps.auth,
        publishRead: (userId, sessionId, lastReadSeq) =>
          deps.notify.publishToUser(userId, 'notify:read-state', { sessionId, lastReadSeq, ts: Date.now() }),
      }),
    )
  }

  /**
   * 会话子资源全量守卫（M57 P1 + P2）：`/sessions/:id` 及其全部子路径（消息 / 成员 / 交付件 / 画布 / 日程 / 绑定……）。
   * 读取 = owner ∪ 共享成员；写入（POST/PATCH/PUT/DELETE）= owner / editor，viewer → 403
   *（例外 `POST /sessions/:id/leave` 允许 viewer 自助退出）；不存在 / 跨用户一律 404。
   */
  router.use('/sessions/:id', createSessionAccessGuard(deps.access))

  /** M57 P2：会话共享（/shares 属主管理；/leave 成员自助退出） */
  router.use(
    createSharesRouter({
      access: deps.access,
      auth: deps.auth,
      members: deps.members,
      audit: deps.audit,
      publish: (sessionId, userId, action, role) =>
        deps.notify.publish({ type: 'notify:share-changed', sessionId, payload: { sessionId, userId, action, role } }),
      // M79：被邀请人收件箱（实时到达，修复「刷新才发现」）
      deliver: deps.deliverInbox,
      // M79-D：群聊邀请限「邀请者好友」
      friends: deps.friends,
      // M79-E：成员移除 → 持球方清洗 + session-meta 广播
      onMemberRemoved: (sessionId, userId) => {
        if (deps.sessions.clearWaitingForUsers(sessionId, [userId])) {
          deps.notify.publish({
            type: 'notify:session-meta',
            sessionId,
            payload: { session: deps.sessions.getSession(sessionId) },
          })
        }
      },
      // M79-AA 群管理补全：退出 / 移出留痕——system 事件条 + turn-end 广播（同会话 upsert / 跨会话列表预览）
      appendSystem: (sessionId, content) => {
        if (!deps.sessions.getSession(sessionId)) return
        const message = deps.sessions.appendMessage({ sessionId, role: 'system', content, mentions: [], status: 'complete' })
        deps.notify.publish({ type: 'notify:turn-end', sessionId, payload: { message } })
      },
    }),
  )

  /**
   * 运行守卫：`/runs/:runId` 全部子路径（流 / 停止 / 审批 / 轨迹）按 run→session 归属校验；
   * M57 P2：写操作（停止 / 排队 / 审批）对 viewer 一律 403（读取仍为 owner ∪ 成员）。
   */
  router.use('/runs/:runId', (req, _res, next) => {
    try {
      const runId = req.params.runId
      const sessionId =
        deps.runs.get(runId)?.sessionId ??
        deps.engine.listActiveRuns().find((r) => r.runId === runId)?.sessionId
      assertRunAccess(deps.access, userOf(req), sessionId, req.method)
      next()
    } catch (err) {
      next(err)
    }
  })

  /**
   * 管理面（P1）：资产控制台 / 指标 / 审计 → admin；
   * M57 P3：`/mcp` 改为路由级门控（routes/mcp.ts：管理面 admin / personal 资源级 ownerOrAdmin），
   * 不再整体 admin 挂载（成员需可访问自己的 personal 服务器 CRUD 与绑定候选）。
   */
  router.use('/console', deps.requireAdmin)
  router.use('/metrics', deps.requireAdmin)
  router.use('/audit', deps.requireAdmin)

  router.use(createAgentsRouter(deps))
  router.use(createSkillsRouter(deps))
  router.use(createProjectsRouter(deps))
  router.use(createSettingsRouter(deps))
  router.use(createSessionsRouter(deps))
  // M33：附件上传（raw 二进制直传；对话附件托盘）
  router.use(createAttachmentsRouter(deps))
  router.use(createContextRouter(deps))
  router.use(createArtifactsRouter(deps))
  router.use(createRunsRouter(deps))
  router.use(createMetricsRouter(deps))
  router.use(createFeedbackRouter(deps))
  // M22：连接中心（数据库 / SSH / 浏览器接入 + 审计）
  router.use(createConnectionsRouter(deps))
  router.use(createBrowserRouter(deps))
  // M25：向量记忆（跨 scope 管理 / 统计 / 重建 / 语义搜索）
  router.use(createMemoriesRouter(deps))
  // M26：资产控制台（Agent / Skill / 场景 / 工具清单 / 校验）
  router.use(createConsoleRouter(deps))
  // M27：MCP 接入与管理（服务器 CRUD / 生命周期 / 工具目录 / 会话绑定）
  router.use(createMcpRouter(deps))
  // M31：无限画布（文档 / 素材上传 / 脑图生成）与媒体生成（任务管线 / 提供方清单）
  router.use(createCanvasRouter(deps))
  // M65-B：设计场景工作区文件（DesignScene 读写；工作室 3D 工作台）
  router.use(createDesignScenesRouter(deps))
  router.use(createMediaRouter(deps))
  // M35：定时任务（会话清单 / CRUD / 启停 / 立即触发）
  router.use(createSchedulesRouter(deps))
  // M34：金融投研（健康度 / 自选列表 / 行情 / K 线 / 检索 / 新闻 / 博弈推演）
  router.use(createFinanceRouter(deps))

  return router
}

/** 统一错误中间件（中文 { error }；透传 body-parser 等中间件抛出的 4xx 状态码，审核 M-2） */
export function apiErrorHandler(
  err: Error,
  _req: unknown,
  res: { status: (code: number) => { json: (body: unknown) => void } },
  _next: unknown,
): void {
  // body-parser 抛错携带 status / statusCode（413 请求体超限 / 400 JSON 语法错误等）
  const meta = err as unknown as { status?: unknown; statusCode?: unknown }
  const raw = meta.status ?? meta.statusCode
  const status = typeof raw === 'number' && raw >= 400 && raw < 600 ? raw : 500
  if (status === 413) {
    res.status(413).json({ error: '请求体过大：单文件上传上限 8MB（base64 编码后约 11MB）；其他请求上限 4MB' })
    return
  }
  const message = err instanceof Error ? err.message : '服务器内部错误'
  res.status(status).json({ error: message })
}
