/**
 * 服务端入口：装配全部模块并监听端口（§14 / §24）。
 *
 * 装配顺序（M1）：
 *   env 配置 → settings.json 覆盖 → 日志 → SQLite（迁移 + 旧 JSON 一次性导入）→ 各 Store/Engine → HTTP
 * 安全：默认仅监听 127.0.0.1；BIND_ALL=true 时 config 层强制要求 AUTH_TOKEN。
 * 生产形态下同时托管 client/dist 静态资源（单端口 8787）。
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import cors from 'cors'
import express from 'express'
import { ApprovalService } from './approval.js'
import { PlanReviewService } from './plan-review.js'
// M57：多用户（认证服务 / 访问控制 / 账号存储）
import { AccessService } from './auth/access.js'
import { AuthService, type AuthUser } from './auth/service.js'
import { ApiKeyStore, AuthSessionStore } from './store/auth-sessions.js'
import { UserStore } from './store/users.js'
import { configWarnings, describeConfig, ensureDirSync, loadConfig } from './config.js'
import { Compressor } from './context/compressor.js'
import { ContextService } from './context/service.js'
import { createProvider } from './llm/factory.js'
import { LlmProviderRouter } from './llm/provider-router.js'
import { closeLogger, initLogger } from './logger.js'
import { createAuthMiddleware, createCorsOptions, createLoginLimiter, createMessageLimiter, createOriginGuard, createRequireAdmin, createTokenEntryMiddleware } from './middleware.js'
import { Engine } from './orchestration/engine.js'
import { apiErrorHandler, createApiRouter } from './routes/index.js'
import { applySettingsToConfig, readSettingsFile } from './settings.js'
import { ArtifactStore } from './store/artifacts.js'
import { ArtifactVersionStore } from './store/artifact-versions.js'
import { defaultDbFile, openDatabase } from './store/db.js'
import { FeedbackStore } from './store/feedback.js'
import { importLegacySessions, pendingLegacyFiles } from './store/legacy-import.js'
import { MemoryStore } from './store/memory.js'
import { ToolMetricsStore } from './store/metrics.js'
import { PlanStore } from './store/plans.js'
import { ProjectStore } from './store/projects.js'
import { PromptLibrary } from './store/prompts.js'
import { ReviewStore } from './store/reviews.js'
import { RunEventStore } from './store/run-events.js'
import { RunStore } from './store/runs.js'
import { ScheduleStore } from './store/schedules.js'
import { RitualStore } from './store/rituals.js'
import { findSystemRitual } from './schedule/system-rituals.js'
import { createConnectionUseGuard } from './connections/access.js'
import { createUserLabelResolver } from './context/user-label.js'
import { ByokProvider } from './llm/byok.js'
import { QuotaService } from './quota/service.js'
import { LibraryService } from './library/service.js'
import { LlmCredentialStore } from './store/llm-credentials.js'
import { MaterialStore } from './store/materials.js'
import { QuotaStore } from './store/quotas.js'
import { SessionMemberStore } from './store/session-members.js'
import { SessionStore } from './store/sessions.js'
import { SpaceStore } from './store/spaces.js'
import { SkillLibrary } from './store/skills.js'
import { SummaryStore } from './store/summaries.js'
import { TaskStore } from './store/tasks.js'
import { UsageStore } from './store/usage.js'
import { createToolRegistry } from './tools/builtin.js'
import { parseMcpServerSeeds } from './tools/mcp.js'
import { WorkspaceService } from './workspace.js'
import { NotifyHub } from './ws.js'
import { InboxStore } from './store/inbox.js'
import type { InboxAddInput } from './store/inbox.js'
import { SessionReadsStore } from './store/session-reads.js'
import { ReactionStore } from './store/reactions.js'
import { FriendStore } from './store/friends.js'
import { SessionHideStore } from './store/session-hides.js'
import { PresenceTracker } from './realtime/presence.js'
import { createPresenceRecipients } from './realtime/presence-recipients.js'
import { DbNotifyBus } from './realtime/notify-bus-db.js'
import { NotifyBusStore } from './store/notify-bus.js'
import { PresenceInstanceStore } from './store/presence-instances.js'
import { sessionHumans } from './orchestration/humans.js'
// M26：资产控制台（唯一写盘通道：zod 校验 → 原子写 → 回收站软删除）
import { AssetManager } from './assets/manager.js'
import { AssetGenerator } from './assets/generator.js'
import { MCP_TOPIC, type NotifyType } from '@multi-agent/shared'
// M22：连接中心（凭据加密 / 连接存储 / 审计 / 数据库 / 浏览器 / 帧流）
import { SecretVault } from './connections/crypto.js'
import { ConnectionStore } from './store/connections.js'
import { AuditStore } from './store/audit.js'
import { configureEgress } from './net/egress.js'
import { DbConnectionManager } from './connections/db/manager.js'
import { SshConnectionManager } from './connections/ssh/manager.js'
import { EmbeddingManager } from './embeddings/manager.js'
import { MemoryService } from './memory/service.js'
import { EmbeddingCacheStore, EmbedQueueStore, MemoryVectorStore } from './store/memory-vectors.js'
import { BrowserRuntime } from './browser/runtime.js'
import { StreamTokenService } from './browser/stream-token.js'
import { StreamHub } from './stream.js'
import { SshTerminalHub } from './ssh-terminal.js'
// M27：MCP 接入与管理（SDK 双传输 / 生命周期 / 工具注入 / 会话绑定）
import { McpRuntimeManager } from './mcp/manager.js'
import { McpServerStore } from './store/mcp-servers.js'
// M28：MCP JSON 直配（mcp.json 文件权威同步：启动先于 env 种子 → mtime 轮询 → 手动同步）
import { McpJsonConfigService } from './mcp/json-config.js'
// M28：工具按需发现（BM25 + 嵌入语义混合检索；tool_search 内核）
import { ToolDiscoveryService } from './tools/discovery.js'
// M31：无限画布与媒体创作（画布文档存储 / 媒体生成服务与适配器）
import { CanvasStore } from './canvas/store.js'
import { MindGenerator } from './canvas/mind.js'
import { MediaService } from './media/service.js'
import { comfyUiAdapter } from './media/adapters/comfyui.js'
import { sdWebUiAdapter } from './media/adapters/sdwebui.js'
import { openAiCompatAdapter } from './media/adapters/openai-compat.js'
import { taskTemplateAdapter } from './media/adapters/task-template.js'
// M35：定时任务（调度服务；engine 创建后回填，供 schedule_* 工具与路由使用）
import { ScheduleService } from './schedule/service.js'
// M34：金融投研（数据网关 + 自选列表存储；FINANCE_ENABLED=false 时网关不创建，工具不注册）
import { createFinanceGateway } from './finance/gateway.js'
import { FinanceStore } from './store/finance.js'

const cfg = loadConfig()
applySettingsToConfig(cfg, readSettingsFile(cfg.settingsFile))
const log = initLogger(cfg)

// 真实模型为默认运行路径（§7.4）：未配置 Key 且未显式开启 Mock 时直接拒绝启动
if (!cfg.llmApiKey && !cfg.llmMock) {
  log.error('未配置 LLM_API_KEY：请在 .env 中配置真实模型 API Key 后重启（离线演示可显式设置 LLM_MOCK=true）')
  process.exit(1)
}

// ---------- 存储：SQLite 为唯一真相 ----------
const db = openDatabase(cfg.dbFile || defaultDbFile(cfg.dataDir))
const legacyDir = path.join(cfg.dataDir, 'sessions')
const pending = pendingLegacyFiles(legacyDir)
if (pending.length > 0) {
  const result = importLegacySessions(db, legacyDir)
  log.info(
    { imported: result.imported.length, sessions: result.sessionCount, messages: result.messageCount },
    '旧 JSON 会话已导入',
  )
  for (const failure of result.failed) log.error({ file: failure.file, err: failure.error }, '旧 JSON 导入失败')
}

const prompts = new PromptLibrary({ agentsDir: cfg.agentsDir, promptsDir: cfg.promptsDir })
const skills = new SkillLibrary(cfg.skillsDir)
const sessions = new SessionStore(db)
// 空间（Space）存储（迁移 v27 落种内置三空间；构造时 ensureBuiltins 校正）
const spaceStore = new SpaceStore(db)
// M6：项目层 + 工作区服务（artifact 工作区根由 WorkspaceService 解析：sandbox/repo/worktree）
const projects = new ProjectStore(db, cfg.allowedRoots)
const workspace = new WorkspaceService({ cfg, sessions, projects })
const artifacts = new ArtifactStore(cfg.workspaceDir, (sid) => workspace.resolveDir(sid))
// M8：交付件版本存储（写类工具落地后记版；Diff 视图数据源）
const versions = new ArtifactVersionStore(db)
// M25：嵌入队列（写入即入队；worker 未启动时仅积累，启用后消费）
const embedQueue = new EmbedQueueStore(db)
// P2：记忆域隔离——写入时按来源会话解析空间域（解析不到 = 跨域共享全局记忆）
const memory = new MemoryStore(db, embedQueue, (sid) => sessions.getSession(sid)?.spaceId ?? 'default')
const summaries = new SummaryStore(db)
const taskStore = new TaskStore(db)
const runStore = new RunStore(db)
// M35：定时任务存储（迁移 v11；会话删除级联清理）
const scheduleStore = new ScheduleStore(db)
const ritualStore = new RitualStore(db)
const usageStore = new UsageStore(db, cfg.llmPricing)
const metricsStore = new ToolMetricsStore(db)
// M9：运行轨迹（trace / 指标）与消息反馈
const eventsStore = new RunEventStore(db)
const feedbackStore = new FeedbackStore(db)
// M24：计划 / 评审存储与计划审批服务（范式协作：write_plan 提交后挂起等待用户批准）
const planStore = new PlanStore(db)
const reviewStore = new ReviewStore(db)
const planReviews = new PlanReviewService({ plans: planStore, timeoutMs: cfg.planReviewTimeoutMs })
let provider = createProvider(cfg)
const tools = createToolRegistry(cfg)
// M26：资产控制台（Agent / Skill 读写；软删除到 data/trash/assets；写后依赖 mtime 热更新自动生效）
const assets = new AssetManager({
  agentsDir: cfg.agentsDir,
  skillsDir: cfg.skillsDir,
  trashDir: path.join(cfg.dataDir, 'trash', 'assets'),
  prompts,
  skills,
  sessions,
  // M47：白名单校验含「已注册但未启用」工具名（如 FINANCE_ENABLED=false 的 fin_*；编辑引用它们的角色不报错）
  toolNames: () => [...tools.list().map((tool) => tool.name), ...tools.unavailableNames()],
})
// M27：MCP_SERVERS 仅作启动种子（历史格式 `name=command args…` / `name=https://…`，逗号分隔）
const mcpSeeds = parseMcpServerSeeds(cfg.mcpServers)
// M57：NotifyHub 惰性读取认证依赖（WS 订阅 ACL；构造时 auth/access 尚未初始化）
// M79-A：收件箱 / 已读存储（用户主题投递的权威层；WS `read` 帧与 REST 路由共用）
const inboxStore = new InboxStore(db)
const sessionReads = new SessionReadsStore(db)
// M80-B：消息表情回应
const reactionStore = new ReactionStore(db)
// M79-C：好友关系存储 + 在线状态（用户主题扇出）
const friendStore = new FriendStore(db)
// M79-D：会话隐藏（DM「删除」语义）
const sessionHides = new SessionHideStore(db)
let presence: PresenceTracker | undefined
// M79-L：跨实例 presence 计数表（NOTIFY_BUS=db 时启用；memory 模式 undefined = 现状）
let presenceInstances: PresenceInstanceStore | undefined
const notify = new NotifyHub(
  cfg,
  () => ({ auth, access }),
  () => ({ inbox: inboxStore, reads: sessionReads, showReadReceipts: (userId) => users.getPrefs(userId).showReadReceipts !== false }),
  {
    // M79-L：连接计数同步写跨实例表（db 模式；countOf 为写表时的本地引用计数）
    onConnect: (userId) => {
      presence?.connect(userId)
      if (presenceInstances) presenceInstances.setCount(cfg.instanceId, userId, presence?.countOf(userId) ?? 1)
    },
    onDisconnect: (userId) => {
      presence?.disconnect(userId)
      if (presenceInstances) presenceInstances.setCount(cfg.instanceId, userId, presence?.countOf(userId) ?? 0)
    },
  },
)
/** M79：收件箱投递（写库 + 用户主题实时帧；actorName 随行投影） */
const deliverInbox = (input: InboxAddInput): void => {
  const item = inboxStore.add(input)
  const actorName = input.actorId ? auth.getUser(input.actorId)?.displayName : undefined
  notify.publishToUser(input.userId, 'notify:inbox', { item: { ...item, ...(actorName ? { actorName } : {}) } })
}
// M79-C：在线状态推导（聚合窗口 cfg.presenceAggregateMs；可见域 = 好友 ∪ 同会话人类成员）
// 装配位置在 sessionMembers 之后（收件人计算依赖成员存储；NotifyHub 钩子为惰性引用）

// ---------- M22：连接中心装配（数据库 / SSH / 浏览器接入） ----------
ensureDirSync(cfg.dataDir)
const vault = SecretVault.load({
  keyMaterial: process.env.CONNECTION_SECRET_KEY,
  keyFile: cfg.connectionSecretFile,
})
if (vault.source === 'ephemeral') {
  log.warn('连接凭据使用临时密钥（密钥文件不可写）：重启后已保存的连接凭据不可解密，需重新保存')
}
const connectionStore = new ConnectionStore(db, vault)
// M82：联网出口层（默认 direct：未配置时全链路行为与历史一致）
const egress = configureEgress({ cfg, connections: connectionStore })
const auditStore = new AuditStore(db)
// M57 P3：BYOK 包装（按会话属主解析用户 LLM 凭据；无凭据 / Mock 直通系统 provider；凭据变更 invalidate 重建）
const llmCredentials = new LlmCredentialStore(db, vault)
const byokProvider = new ByokProvider({
  base: provider,
  cfg,
  sessions,
  credentials: llmCredentials,
  createFor: (creds) =>
    createProvider({
      ...cfg,
      llmApiKey: creds.apiKey,
      llmBaseUrl: creds.baseUrl || cfg.llmBaseUrl,
      llmModel: creds.model || cfg.llmModel,
    }),
})
provider = byokProvider
// 多 Provider：模型名命中模型服务清单 → 经该服务调用（未命中透传 BYOK → 系统默认）
const llmProviderRouter = new LlmProviderRouter({
  base: provider,
  cfg,
  connections: connectionStore,
  createFor: ({ baseUrl, apiKey }) => createProvider({ ...cfg, llmBaseUrl: baseUrl, llmApiKey: apiKey }),
})
provider = llmProviderRouter

// Agent Studio：资产生成器（描述 → 草稿；不落盘，落盘走既有控制台创建链路）
const assetGen = new AssetGenerator({ provider, cfg, prompts, skills })
// M57：多用户装配（账号 / 登录会话 / API Key / 访问控制；无账号时保持单用户兼容模式）
const users = new UserStore(db)
const authSessions = new AuthSessionStore(db)
const apiKeys = new ApiKeyStore(db)
const auth = new AuthService({ cfg, users, authSessions, apiKeys, audit: auditStore, sessions })
// M57 P2：会话共享成员（owner 之外的角色：editor / viewer）；P2/P3：共享会话人类署名解析
const sessionMembers = new SessionMemberStore(db)
const userLabelResolver = createUserLabelResolver({ members: sessionMembers, users })
const access = new AccessService({ isMultiUser: () => auth.multiUser, sessions, projects, members: sessionMembers })
// M79-G：在线状态扇出（可见域 = 好友 ∪ 同会话人类成员；聚合窗口吸收抖动）
const presenceRecipients = createPresenceRecipients({ friends: friendStore, sessions, members: sessionMembers })
presence = new PresenceTracker({
  aggregateMs: cfg.presenceAggregateMs,
  onFlush: (events) => {
    for (const ev of events) {
      // M79-L：跨实例合并——其他实例仍有活跃连接（非 stale）时跳过离线广播，防「A 断开但 B 在线」误判
      if (!ev.online && presenceInstances && presenceInstances.globalCount(ev.userId, PRESENCE_STALE_MS) > 0) continue
      for (const recipient of presenceRecipients(ev.userId)) {
        notify.publishToUser(recipient, 'notify:presence', {
          users: [{ userId: ev.userId, online: ev.online, ...(ev.lastSeenAt ? { lastSeenAt: ev.lastSeenAt } : {}) }],
        })
      }
    }
  },
})
// M79-L：多实例演进（NOTIFY_BUS=db）——共享通知总线（帧跨实例投递）+ 跨实例 presence 表
const PRESENCE_STALE_MS = 60_000
let notifyBusStore: NotifyBusStore | undefined
if (cfg.notifyBus === 'db') {
  notifyBusStore = new NotifyBusStore(db)
  presenceInstances = new PresenceInstanceStore(db)
  notify.attachTransport(new DbNotifyBus({ store: notifyBusStore, instanceId: cfg.instanceId, pollMs: cfg.notifyBusPollMs }))
  log.info({ instanceId: cfg.instanceId, pollMs: cfg.notifyBusPollMs }, '通知总线已启用（多实例模式）')
}

// M57 P3：配额（user_quotas；缺省不限；存储体积按工作区目录 + M68 用户素材库目录计量）
const quotaStore = new QuotaStore(db)
const quotaService = new QuotaService({
  cfg,
  quotas: quotaStore,
  sessions,
  usage: usageStore,
  dirOf: (sid) => workspace.resolveDir(sid),
  // M68：素材目录（workspace/_library/u_<uid>）计入存储体积（路径口径与 LibraryService.userDirOf 一致）
  libraryUserDirOf: (uid) => path.join(cfg.workspaceDir, '_library', `u_${uid.replace(/[^a-zA-Z0-9_-]/g, '') || 'local'}`),
})
// M68：用户素材库（per-user 私人素材；文件在 workspace/_library/u_<id>/；独立菜单管理页面的服务端面）
const materialStore = new MaterialStore(db)
const libraryService = new LibraryService({
  cfg,
  materials: materialStore,
  assertUserStorage: (uid, extra) => quotaService.assertUserStorageAllowed(uid, extra),
  // 会话可访问判定：兼容模式（无账号）放行；多用户按共享角色矩阵（可读即可访问——
  //   service 层兜底存在性；M79-AF：入仓为会话工作区写操作，viewer 写闸门由路由层把关 403）
  canAccessSession: (uid, sid) => access.canAccessSession(uid === 'local' ? undefined : ({ id: uid } as AuthUser), sid),
  sessionDirOf: (sid) => workspace.resolveDir(sid),
})
// M27：MCP 接入（服务器 CRUD + 会话绑定 + 连接生命周期 + 工具注入 mcp__<slug>__<tool>）
const mcpStore = new McpServerStore(db, vault)
const mcpManager = new McpRuntimeManager({
  store: mcpStore,
  registry: tools,
  rootDir: cfg.rootDir,
  defaultTimeoutMs: cfg.toolTimeoutMs,
  publish: (payload) => notify.publish({ type: 'notify:mcp-changed', sessionId: MCP_TOPIC, payload }),
})
// M28：MCP JSON 直配（文件权威）：启动同步先于 MCP_SERVERS env 种子（同名以 json 为准）；
// 解析失败 / 文件缺失 → 整次跳过（绝不删库）；同步结果经 notify:mcp-changed 广播（UI 自动刷新）
const mcpJson = new McpJsonConfigService({
  filePath: cfg.mcpConfigFile,
  pollMs: cfg.mcpConfigPollMs,
  store: mcpStore,
  runtime: mcpManager,
  publish: (payload) => notify.publish({ type: 'notify:mcp-changed', sessionId: MCP_TOPIC, payload }),
})
try {
  const result = await mcpJson.sync('startup')
  const changed = result.summary.created + result.summary.updated + result.summary.removed
  if (!result.ok) log.warn({ errors: result.errors }, 'MCP JSON 配置启动同步已跳过（不删除任何服务器）')
  else if (changed > 0) log.info({ ...result.summary }, 'MCP JSON 配置启动同步完成')
} catch (err) {
  log.warn({ err: (err as Error).message }, 'MCP JSON 配置启动同步失败')
}
mcpJson.start()
// 种子导入：MCP_SERVERS 中不存在同名服务器才创建（source='env'）；此后 DB 为唯一真相，管理台为准
let mcpSeeded = 0
for (const seed of mcpSeeds) {
  if (mcpStore.findByName(seed.name)) continue
  try {
    mcpStore.create({
      name: seed.name,
      displayName: seed.name,
      transport: seed.transport,
      config: seed.config,
      source: 'env',
    })
    mcpSeeded += 1
  } catch (err) {
    log.warn({ name: seed.name, err: (err as Error).message }, 'MCP 种子导入失败')
  }
}
if (mcpSeeded > 0) log.info(`MCP：已从 MCP_SERVERS 导入 ${mcpSeeded} 个服务器（此后以管理台为准）`)
// 非阻塞启动：连接全部启用服务器；单台失败置 status=error 并广播，不阻断启动
void mcpManager.start().catch((err) => log.warn({ err: (err as Error).message }, 'MCP 启动连接失败'))
// M25：嵌入管理（模型凭据走连接中心 SecretVault；未配置 = 休眠：零网络、零影响）
const embeddings = new EmbeddingManager({ cfg, connections: connectionStore, cache: new EmbeddingCacheStore(db) })
// M25：向量记忆装配（BLOB 规范副本 + 双后端索引懒引导 + L1.5 召回服务；模型/维度变化时自动重建镜像）
const memoryVectors = new MemoryVectorStore(db)
const memories = new MemoryService({
  cfg,
  db,
  store: memory,
  vectors: memoryVectors,
  queue: embedQueue,
  embeddings,
})
void memories.start().catch((err) => log.warn({ err: (err as Error).message }, '向量记忆服务启动失败（召回将跳过）'))
const dbManager = new DbConnectionManager(cfg, connectionStore, auditStore)
dbManager.start()
// M23：SSH 连接管理器（测试 / Agent 命令 / 终端会话）
const sshManager = new SshConnectionManager(cfg, connectionStore, auditStore)
sshManager.start()
// M31：画布文档存储（data/canvas[/u_<uid>]/<sid>.json；agent 写入后广播 notify:canvas-changed）
const canvasStore = new CanvasStore({
  dataDir: cfg.dataDir,
  // M57：多用户嵌套布局（data/canvas/u_<uid>/<sid>.json；旧文件回退平面路径）
  fileFor: (sid) => workspace.canvasFileFor(sid),
  // M31 修订：广播携带 touched（前端写入高亮）/ actor（作者徽标）/ reason（来源区分）
  publish: (sessionId, version, by, meta) =>
    notify.publish({ type: 'notify:canvas-changed', sessionId, payload: { sessionId, version, by, ...meta } }),
})
// M31：媒体生成服务（四适配器注册；全局连接，未配置的连接在创建任务时给「设置 → 媒体生成」引导错误）
// M31 修订：注入画布存储——任务创建落占位 / 终态结算（未装配 canvas 时落位降级）
const mediaService = new MediaService({ connections: connectionStore, artifacts, notify, canvas: canvasStore })
mediaService.register(comfyUiAdapter)
mediaService.register(sdWebUiAdapter)
mediaService.register(openAiCompatAdapter)
mediaService.register(taskTemplateAdapter)
// M31：脑图生成器（五来源 → summaryModel 结构化 JSON 树；只读调用）
const mindGenerator = new MindGenerator({ cfg, provider, sessions, tasks: taskStore, plans: planStore, memory, usage: usageStore })
const streamTokens = new StreamTokenService(cfg.browserStreamTokenTtlMs)
const browserRuntime = new BrowserRuntime({
  cfg,
  db,
  audit: auditStore,
  connections: connectionStore,
  publish: (topic, message) => streamHub?.publish(topic, message),
  notify: (event) =>
    notify.publish({
      type: `notify:${event.type}` as NotifyType,
      sessionId: event.sessionId,
      payload: event.payload,
    }),
  // M62：多用户浏览器治理（owner 解析 / 订阅计数 / 管理员判定；兼容模式 owner 恒 undefined → 治理不生效）
  ownerOfSession: (sessionId) => sessions.getSession(sessionId)?.ownerId,
  subscriberCount: (topic) => streamHub?.subscriberCount(topic) ?? 0,
  isAdminUser: (userId) => users.get(userId)?.role === 'admin',
})
const streamHub: StreamHub = new StreamHub(cfg, browserRuntime, streamTokens, () => ({ auth }))
// M62：启动对账（僵尸行 / 孤儿进程 / 临时目录）与空闲回收循环（best-effort，不阻断启动）
void browserRuntime.reconcileOnStartup()
browserRuntime.startReclaimLoop()
// M23：SSH 交互终端通道（/ws/ssh；一次性 token 握手即消费；M57：token 与登录用户绑定）
const sshTerminalHub = new SshTerminalHub(cfg, sshManager, streamTokens, () => ({ auth }))
const compressor = new Compressor({ cfg, provider, sessions, summaries, memory, usage: usageStore, billingModelFor: (sid) => byokProvider.modelFor(sid), userLabelFor: (sid) => userLabelResolver(sid) })
const context = new ContextService({ cfg, prompts, skills, sessions, artifacts, memory, memories, summaries, compressor, plans: planStore, members: sessionMembers, users })
// M28：工具按需发现（混合检索：BM25 词法打底 + 嵌入语义融合 0.35；未配置 / 失败 = 静默退化纯词法）
const toolDiscovery = new ToolDiscoveryService({
  embedder: { embed: async (texts) => (await embeddings.embed(texts)).vecs },
})
// M7：审批服务（高危工具挂起等待用户决定；超时按 APPROVAL_TIMEOUT_MS 视为拒绝）
// 审核 M-4：决策留痕落库（approvals 表）
const approvals = new ApprovalService({ timeoutMs: cfg.approvalTimeoutMs, db })
// M34：金融数据网关（缓存 / 来源路由 / 反爬通道 / Python 桥；开关关闭时 undefined → fin_* 工具返回未启用提示）
// 配置用 getter 热读 AppConfig：设置面板修改 节流间隔 / 桥超时 / 解释器 后下一请求即生效（无需重启）
const financeGateway = cfg.financeEnabled
  ? createFinanceGateway({
      db,
      cfg: {
        get python() {
          return cfg.financePython || undefined
        },
        get pyTimeoutMs() {
          return cfg.financePyTimeoutMs
        },
        get minIntervalMs() {
          return cfg.financeMinIntervalMs
        },
      },
    })
  : undefined
// M34：自选列表存储（fin_watch 与 REST API 同源；FINANCE_ENABLED=false 时工具不注册即不可达）
const financeStore = new FinanceStore(db)
const engine = new Engine({
  cfg,
  prompts,
  skills,
  sessions,
  artifacts,
  memory,
  memories,
  context,
  provider,
  tools,
  notify,
  tasks: taskStore,
  runs: runStore,
  usage: usageStore,
  metrics: metricsStore,
  approvals,
  // M24：范式协作（计划挂起 / 派发 / 评审）
  plans: planStore,
  reviews: reviewStore,
  planReviews,
  versions,
  events: eventsStore,
  // M22：连接中心（数据库 / 浏览器工具运行期依赖）
  db: dbManager,
  ssh: sshManager,
  browser: browserRuntime,
  connections: connectionStore,
  // M27：MCP（会话绑定过滤 / 审批策略）
  mcp: mcpManager,
  // M28：工具按需发现（tool_search 检索内核）
  toolSearch: toolDiscovery,
  // M31：画布创作（canvas_* / media_* 工具运行期依赖）
  canvas: canvasStore,
  media: mediaService,
  // M34：金融投研（fin_* 工具运行期依赖；FINANCE_ENABLED=true 时才有网关）
  finance: financeGateway,
  financeStore,
  // M47：会话模式门控（sandbox 无仓库 → git 工具不进模型清单；repo / worktree 模式保持可见）
  isGitMode: (sessionId) => workspace.isGitMode(sessionId),
  // M57 P2：连接最小权限复核（共享会话下成员禁触达未开放连接；兼容模式放行）
  connectionGuard: createConnectionUseGuard({ multiUser: () => auth.multiUser, users, connections: connectionStore }),
  // M57 P3：配额（并发上限 / 波次边界用量闸门；无配额行 = 不限）
  quotas: quotaService,
  // M57 P3：BYOK 生效模型（成本归因；无凭据 = undefined 回退系统默认）
  billingModelFor: (sid) => byokProvider.modelFor(sid),
  // M57：共享会话人类署名（记忆沉淀输入文本）
  userLabelFor: (sid) => userLabelResolver(sid),
  // M79-E：@ 真人寻址（会话人类解析）与收尾持球（waiting_on + session-meta + inbox 提醒）
  sessionHumans: (sid) => {
    const session = sessions.getSession(sid)
    return session ? sessionHumans(session, auth, sessionMembers) : []
  },
  onHandedTo: (sid, targets) => {
    const session = sessions.getSession(sid)
    notify.publish({ type: 'notify:session-meta', sessionId: sid, payload: { session } })
    for (const target of targets) {
      // 同会话同目标 60s 聚合（防多 agent 同波交还刷屏）
      if (inboxStore.hasRecent(target, 'waiting', sid, undefined, 60_000)) continue
      deliverInbox({
        userId: target,
        type: 'waiting',
        title: session?.title ?? '会话',
        sessionId: sid,
        body: '在会话中被点名：等待你的回复',
      })
    }
  },
})
// M35：定时任务服务（引用 engine.launch / activeRunOf 闭包避免循环依赖；建后回填 engine 工具层）
const scheduleService = new ScheduleService({
  cfg,
  schedules: scheduleStore,
  sessions,
  notify,
  launch: (sessionId, userMessageId) => engine.launch(sessionId, userMessageId),
  isBusy: (sessionId) => Boolean(engine.activeRunOf(sessionId)),
  // P4：仪式订阅（场景声明解析 + 到点生成会话并注入 opener）
  rituals: ritualStore,
  resolveRitual: (sceneId) => {
    const group = prompts.groups().find((x) => x.id === sceneId)
    return group?.ritual ? { declaration: group.ritual, chain: group.chain, sceneId: group.id } : undefined
  },
  resolveSystemRitual: (ritualId) => {
    const item = findSystemRitual(ritualId)
    if (!item) return undefined
    const group = prompts.groups().find((x) => x.id === item.sceneId)
    return { declaration: item.declaration, chain: group?.chain ?? [], sceneId: item.sceneId }
  },
  spawnRitualSession: (sub) => {
    try {
      const now = new Date()
      const day = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      const session = sessions.create(sub.members, `${sub.title} · ${day}`, {
        ownerId: sub.userId === 'local' ? undefined : sub.userId,
        spaceId: sub.spaceId,
      })
      const message = sessions.appendMessage({
        sessionId: session.id,
        role: 'user',
        userId: session.ownerId,
        content: sub.opener,
        mentions: [],
        status: 'complete',
      })
      return message.id ? { sessionId: session.id, messageId: message.id } : null
    } catch {
      // 失败不抛（service 层记录 settle 错误并推进 next，避免同轮重试风暴）
      return null
    }
  },
})
engine.setScheduleService(scheduleService)

const app = express()
// M57：反向代理信任（nginx 网关单跳：限流 / 审计取 X-Forwarded-For 真实 IP；TRUST_PROXY='1' | 'true'）
const trustProxy = parseTrustProxy(cfg.trustProxy)
if (trustProxy !== false) app.set('trust proxy', trustProxy)
// M7：CORS 收窄（ALLOWED_ORIGINS 白名单；未配置时仅本机来源）
app.use(cors(createCorsOptions(cfg)))
// M57：非 GET 请求 Origin 校验（CSRF 第二道防线；无 Origin 的 CLI / 测试请求放行）
app.use(createOriginGuard(cfg))
// 审核 M-2：上传接口单独放宽 body 上限（8MB 文件 base64 后 ~10.7MB，全局 4mb 会先拒）
app.use('/api/sessions/:id/uploads', express.json({ limit: '12mb' }))
// M26：头像上传通道（base64 PNG ≤8MB，同上传接口模式，须在全局 4mb 之前）
app.use('/api/console/agents/:id/avatar', express.json({ limit: '12mb' }))
// M31：画布素材直传（raw 二进制 ≤200MB；fetch body 直传，无 base64 膨胀，须在全局 4mb 之前）
app.use('/api/sessions/:id/media/upload', express.raw({ type: () => true, limit: '200mb' }))
// M68：素材库上传（raw 二进制 ≤200MB；仅上传端点，其余素材库端点走全局 JSON 解析）
app.use('/api/library/uploads', express.raw({ type: () => true, limit: '200mb' }))
// M33：对话附件直传（raw 二进制 ≤200MB；同 M31 模式，须在全局 4mb 之前）
app.use('/api/sessions/:id/attachments', express.raw({ type: () => true, limit: '200mb' }))
// M79-Q：真人头像上传（raw 二进制 ≤4mb；业务上限 2MB，须在全局 4mb 之前）
app.use('/api/auth/avatar', express.raw({ type: () => true, limit: '4mb' }))
app.use(express.json({ limit: '4mb' }))
// M10：浏览器首次授权入口（Docker/局域网）：/?token=<AUTH_TOKEN> → 种 cookie + 跳回 /（未配置 token 时为 no-op）
app.use(createTokenEntryMiddleware(cfg))
// M57：登录态解析（sid cookie / Bearer API Key / legacy AUTH_TOKEN）+ 公开路由白名单
app.use('/api', createAuthMiddleware(cfg, auth))
app.use(
  '/api',
  createApiRouter({
    cfg,
    prompts,
    skills,
    sessions,
    artifacts,
    memory,
    context,
    tasks: taskStore,
    runs: runStore,
    metrics: metricsStore,
    events: eventsStore,
    feedback: feedbackStore,
    projects,
    workspace,
    // 空间（Space）：工作生活一体的一级信息架构（迁移 v27）
    spaces: spaceStore,
    members: sessionMembers,
    // M57 P3：配额服务（用量接口 / 强制点）
    quotas: quotaService,
    // M68：用户素材库（/api/library/*；独立菜单管理页面）
    library: libraryService,
    // M57 P3：BYOK（凭据存储 + 缓存失效；路由在 routes/index 按存在性挂载）
    llmCredentials,
    llmCredsInvalidate: (userId) => byokProvider.invalidate(userId),
    approvals,
    // M24：范式协作（计划接口 / 审批结算）
    plans: planStore,
    reviews: reviewStore,
    planReviews,
    versions,
    usage: usageStore,
    messageLimiter: createMessageLimiter(cfg),
    // M57：多用户（登录限流 / 管理面守卫 / 认证与访问服务）
    loginLimiter: createLoginLimiter(cfg),
    requireAdmin: createRequireAdmin(auth),
    auth,
    access,
    users,
    // M79-A：收件箱 / 已读（/inbox、/sessions/:id/read、会话列表 unreadCount）
    inbox: inboxStore,
    reads: sessionReads,
    // M80-B：表情回应（/sessions/:id/messages/:mid/reactions）
    reactions: reactionStore,
    // M79-C：好友（/friends、/users/search）+ 收件箱投递 + 在线状态
    friends: friendStore,
    deliverInbox,
    presence,
    // M79-D：会话隐藏 + 人物会话（/chats/*）
    hides: sessionHides,
    engine,
    notify,
    // M22：连接中心
    connections: connectionStore,
    audit: auditStore,
    db: dbManager,
    ssh: sshManager,
    // M82：联网出口（出口代理测试 / 连接与设置变更失效）
    egress,
    // M25：向量记忆（管理 / 统计 / 重建 / 语义搜索）
    memories,
    browser: browserRuntime,
    streamTokens,
    embeddings,
    // M26：资产控制台（唯一写盘通道 + 工具中心）
    assets,
    assetGen,
    tools,
    // M27：MCP（服务器管理 / 生命周期 / 工具目录 / 会话绑定）
    mcp: mcpStore,
    mcpRuntime: mcpManager,
    // M28：MCP JSON 直配（状态 / 手动同步 / 粘贴导入）
    mcpJson,
    // M31：无限画布（文档 / 素材上传 / 脑图生成）与媒体生成（任务管线 / 提供方）
    canvas: canvasStore,
    mind: mindGenerator,
    media: mediaService,
    // M35：定时任务（会话清单 / CRUD / 启停 / 立即触发）
    schedules: scheduleService,
    // M34：金融投研（健康度 / 自选列表 / 行情 / K 线 / 检索 / 新闻 / 博弈推演）
    finance: financeGateway,
    financeStore,
  }),
)

// 生产形态：托管 client/dist（SPA fallback，不拦截 /api 与 /ws）
const clientDist = path.join(cfg.rootDir, 'client', 'dist')
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist))
  app.get(/^\/(?!api\/|ws$).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'))
  })
}

app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  log.error({ err }, 'API 未捕获错误')
  apiErrorHandler(err, req, res, next)
})

const server = http.createServer(app)
notify.attach(server)
// M22：浏览器帧流 / 输入通道（/ws/stream，与 /ws 并存）
streamHub.attach(server)
// M23：SSH 交互终端通道（/ws/ssh）
sshTerminalHub.attach(server)

// M79-A：收件箱保留期清理（启动一轮 + 每日一轮；仅删已读过期项，未读恒保留）
const inboxCleanup = (): void => {
  try {
    const removed = inboxStore.cleanup(cfg.inboxRetentionDays)
    if (removed > 0) log.info({ removed }, '收件箱已清理过期的已读项')
  } catch (err) {
    log.warn({ err }, '收件箱清理失败（下轮重试）')
  }
}
inboxCleanup()
const inboxCleanupTimer = setInterval(inboxCleanup, 86_400_000)
inboxCleanupTimer.unref?.()

// M79-L：多实例维护轮（db 模式）——总线保留期清理 + presence 心跳（防长连行 stale）+ stale 行回收
const busMaintenanceTimer = cfg.notifyBus === 'db' ? setInterval(() => {
  try {
    notifyBusStore?.cleanup(cfg.notifyBusRetentionMinutes)
    if (presenceInstances) {
      presenceInstances.touchInstance(cfg.instanceId)
      presenceInstances.pruneStale(PRESENCE_STALE_MS * 3)
    }
  } catch (err) {
    log.warn({ err }, '总线维护轮失败（下轮重试）')
  }
}, 30_000) : undefined
busMaintenanceTimer?.unref?.()

const host = cfg.bindAll ? '0.0.0.0' : '127.0.0.1'
server.listen(cfg.port, host, () => {
  log.info(`服务已启动：http://${host === '0.0.0.0' ? 'localhost' : host}:${cfg.port}`)
  log.info(`LLM: ${cfg.llmModel} @ ${cfg.llmBaseUrl}（DB 驱动: ${db.driverName}）`)
  log.info(`上下文: 预算 ${cfg.contextBudgetTokens} tokens / 保留最近 ${cfg.keepRecentTurns} 回合`)
  for (const line of describeConfig(cfg)) log.info(line)
  if (cfg.authToken) {
    log.info('浏览器首次访问：http://<主机>:' + cfg.port + '/?token=<AUTH_TOKEN>（种 cookie 后直接访问 / 即可）')
  }
  // M57：多用户状态（首启前为单用户兼容模式；setup 后进入账号体系）
  if (auth.multiUser) {
    log.info(`多用户模式：已启用 ${auth.listUsers().length} 个账号（管理入口 /api/users；登录 / 首启接口 /api/auth/*）`)
  } else {
    log.info('尚未初始化账号：单用户兼容模式（行为与旧版一致）；浏览器访问 / 或调用 POST /api/auth/setup 创建管理员')
  }
  for (const warning of configWarnings) log.warn(warning)
  // M35：HTTP 就绪后启动调度（立即补一轮 → 周期 tick；缺省 tick 30s）
  scheduleService.start()
})

// 优雅退出：停止接受连接 → 停止活跃 Run 并等待落盘（≤10s）→ 关闭日志
let closing = false
const finishShutdown = (): void => {
  void (async () => {
    // M22：先收流与浏览器（外部进程需一并清理），再关库；M23：SSH 终端与句柄同序清理
    sshTerminalHub.close()
    streamHub?.close()
    await browserRuntime.shutdown().catch(() => undefined)
    await sshManager.closeAll().catch(() => undefined)
    await dbManager.closeAll().catch(() => undefined)
    // M82：关闭出口连接池（未配置出口时为空操作）
    await egress.invalidate().catch(() => undefined)
    // M27：注销 MCP 工具并关闭全部连接（含 stdio 子进程回收）
    mcpJson.stop()
    await mcpManager.stopAll().catch(() => undefined)
    // M31：中止运行中的媒体任务（产物已落盘的部分保留）
    mediaService.stopAll()
    memories.stop()
    notify.close()
    sessions.close()
    db.close()
    closeLogger()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref()
  })()
}
const shutdown = (): void => {
  if (closing) return
  closing = true
  log.info('正在退出…')
  // M35：先停调度（阻止新触发，避免退出期间注入消息发起 Run）
  scheduleService.stop()
  const active = engine.listActiveRuns().length
  if (active > 0) {
    log.info(`等待 ${active} 个活跃运行落盘（≤10s）…`)
    engine.stopAll()
    void engine.waitIdle(10_000).finally(finishShutdown)
  } else {
    finishShutdown()
  }
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// M7：全局异常捕获（落盘 + 日志；本地工具场景不直接退出进程，保持会话可用）
process.on('unhandledRejection', (reason) => {
  log.error({ err: reason }, '未处理的 Promise 拒绝')
})
process.on('uncaughtException', (err) => {
  log.error({ err }, '未捕获异常')
})
// M27：进程退出兜底 —— 同步强杀残留 MCP stdio 子进程（正常路径已由 finishShutdown 异步关闭）
process.on('exit', () => mcpManager.killOrphansSync())

/** TRUST_PROXY 解析：''/'false'/'off'/'0' = 关闭；'true'/'on' = 信任全部；正整数 = 信任跳数（nginx 单跳填 1） */
function parseTrustProxy(raw: string): boolean | number {
  const value = raw.trim().toLowerCase()
  if (!value || value === 'false' || value === 'off' || value === '0') return false
  if (value === 'true' || value === 'on') return true
  const hops = Number(value)
  return Number.isInteger(hops) && hops > 0 ? hops : false
}
