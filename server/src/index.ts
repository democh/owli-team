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
import { configWarnings, describeConfig, ensureDirSync, loadConfig } from './config.js'
import { Compressor } from './context/compressor.js'
import { ContextService } from './context/service.js'
import { createProvider } from './llm/factory.js'
import { closeLogger, initLogger } from './logger.js'
import { createAuthMiddleware, createCorsOptions, createMessageLimiter, createTokenEntryMiddleware } from './middleware.js'
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
import { SessionStore } from './store/sessions.js'
import { SkillLibrary } from './store/skills.js'
import { SummaryStore } from './store/summaries.js'
import { TaskStore } from './store/tasks.js'
import { UsageStore } from './store/usage.js'
import { createToolRegistry } from './tools/builtin.js'
import { parseMcpServerSeeds } from './tools/mcp.js'
import { WorkspaceService } from './workspace.js'
import { NotifyHub } from './ws.js'
// M26：资产控制台（唯一写盘通道：zod 校验 → 原子写 → 回收站软删除）
import { AssetManager } from './assets/manager.js'
import { MCP_TOPIC, type NotifyType } from '@multi-agent/shared'
// M22：连接中心（凭据加密 / 连接存储 / 审计 / 数据库 / 浏览器 / 帧流）
import { SecretVault } from './connections/crypto.js'
import { ConnectionStore } from './store/connections.js'
import { AuditStore } from './store/audit.js'
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
// M6：项目层 + 工作区服务（artifact 工作区根由 WorkspaceService 解析：sandbox/repo/worktree）
const projects = new ProjectStore(db, cfg.allowedRoots)
const workspace = new WorkspaceService({ cfg, sessions, projects })
const artifacts = new ArtifactStore(cfg.workspaceDir, (sid) => workspace.dirFor(sid))
// M8：交付件版本存储（写类工具落地后记版；Diff 视图数据源）
const versions = new ArtifactVersionStore(db)
// M25：嵌入队列（写入即入队；worker 未启动时仅积累，启用后消费）
const embedQueue = new EmbedQueueStore(db)
const memory = new MemoryStore(db, embedQueue)
const summaries = new SummaryStore(db)
const taskStore = new TaskStore(db)
const runStore = new RunStore(db)
// M35：定时任务存储（迁移 v11；会话删除级联清理）
const scheduleStore = new ScheduleStore(db)
const usageStore = new UsageStore(db, cfg.llmPricing)
const metricsStore = new ToolMetricsStore(db)
// M9：运行轨迹（trace / 指标）与消息反馈
const eventsStore = new RunEventStore(db)
const feedbackStore = new FeedbackStore(db)
// M24：计划 / 评审存储与计划审批服务（范式协作：write_plan 提交后挂起等待用户批准）
const planStore = new PlanStore(db)
const reviewStore = new ReviewStore(db)
const planReviews = new PlanReviewService({ plans: planStore, timeoutMs: cfg.planReviewTimeoutMs })
const provider = createProvider(cfg)
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
const notify = new NotifyHub(cfg)

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
const auditStore = new AuditStore(db)
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
// M31：画布文档存储（data/canvas/<sid>.json；agent 写入后广播 notify:canvas-changed）
const canvasStore = new CanvasStore({
  dataDir: cfg.dataDir,
  publish: (sessionId, version, by) =>
    notify.publish({ type: 'notify:canvas-changed', sessionId, payload: { sessionId, version, by } }),
})
// M31：媒体生成服务（四适配器注册；全局连接，未配置的连接在创建任务时给「设置 → 媒体生成」引导错误）
const mediaService = new MediaService({ connections: connectionStore, artifacts, notify })
mediaService.register(comfyUiAdapter)
mediaService.register(sdWebUiAdapter)
mediaService.register(openAiCompatAdapter)
mediaService.register(taskTemplateAdapter)
// M31：脑图生成器（五来源 → summaryModel 结构化 JSON 树；只读调用）
const mindGenerator = new MindGenerator({ cfg, provider, sessions, tasks: taskStore, plans: planStore, memory, usage: usageStore })
const streamTokens = new StreamTokenService(cfg.browserStreamTokenTtlMs)
let streamHub: StreamHub | undefined
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
})
streamHub = new StreamHub(cfg, browserRuntime, streamTokens)
// M23：SSH 交互终端通道（/ws/ssh；一次性 token 握手即消费）
const sshTerminalHub = new SshTerminalHub(cfg, sshManager, streamTokens)
const compressor = new Compressor({ cfg, provider, sessions, summaries, memory, usage: usageStore })
const context = new ContextService({ cfg, prompts, skills, sessions, artifacts, memory, memories, summaries, compressor, plans: planStore })
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
})
// M35：定时任务服务（引用 engine.launch / activeRunOf 闭包避免循环依赖；建后回填 engine 工具层）
const scheduleService = new ScheduleService({
  cfg,
  schedules: scheduleStore,
  sessions,
  notify,
  launch: (sessionId, userMessageId) => engine.launch(sessionId, userMessageId),
  isBusy: (sessionId) => Boolean(engine.activeRunOf(sessionId)),
})
engine.setScheduleService(scheduleService)

const app = express()
// M7：CORS 收窄（ALLOWED_ORIGINS 白名单；未配置时仅本机来源）+ AUTH_TOKEN 校验（配置即启用）
app.use(cors(createCorsOptions(cfg)))
// 审核 M-2：上传接口单独放宽 body 上限（8MB 文件 base64 后 ~10.7MB，全局 4mb 会先拒）
app.use('/api/sessions/:id/uploads', express.json({ limit: '12mb' }))
// M26：头像上传通道（base64 PNG ≤8MB，同上传接口模式，须在全局 4mb 之前）
app.use('/api/console/agents/:id/avatar', express.json({ limit: '12mb' }))
// M31：画布素材直传（raw 二进制 ≤200MB；fetch body 直传，无 base64 膨胀，须在全局 4mb 之前）
app.use('/api/sessions/:id/media/upload', express.raw({ type: () => true, limit: '200mb' }))
// M33：对话附件直传（raw 二进制 ≤200MB；同 M31 模式，须在全局 4mb 之前）
app.use('/api/sessions/:id/attachments', express.raw({ type: () => true, limit: '200mb' }))
app.use(express.json({ limit: '4mb' }))
// M10：浏览器首次授权入口（Docker/局域网）：/?token=<AUTH_TOKEN> → 种 cookie + 跳回 /（未配置 token 时为 no-op）
app.use(createTokenEntryMiddleware(cfg))
app.use('/api', createAuthMiddleware(cfg))
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
    approvals,
    // M24：范式协作（计划接口 / 审批结算）
    plans: planStore,
    reviews: reviewStore,
    planReviews,
    versions,
    usage: usageStore,
    messageLimiter: createMessageLimiter(cfg),
    engine,
    notify,
    // M22：连接中心
    connections: connectionStore,
    audit: auditStore,
    db: dbManager,
    ssh: sshManager,
    // M25：向量记忆（管理 / 统计 / 重建 / 语义搜索）
    memories,
    browser: browserRuntime,
    streamTokens,
    embeddings,
    // M26：资产控制台（唯一写盘通道 + 工具中心）
    assets,
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

const host = cfg.bindAll ? '0.0.0.0' : '127.0.0.1'
server.listen(cfg.port, host, () => {
  log.info(`服务已启动：http://${host === '0.0.0.0' ? 'localhost' : host}:${cfg.port}`)
  log.info(`LLM: ${cfg.llmModel} @ ${cfg.llmBaseUrl}（DB 驱动: ${db.driverName}）`)
  log.info(`上下文: 预算 ${cfg.contextBudgetTokens} tokens / 保留最近 ${cfg.keepRecentTurns} 回合`)
  for (const line of describeConfig(cfg)) log.info(line)
  if (cfg.authToken) {
    log.info('浏览器首次访问：http://<主机>:' + cfg.port + '/?token=<AUTH_TOKEN>（种 cookie 后直接访问 / 即可）')
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
