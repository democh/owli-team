/**
 * 测试辅助：真实 prompts/skills + 临时 data/workspace 目录 + 测试替身 Provider（零延时）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { NotifyType } from '@multi-agent/shared'
import { ApprovalService } from '../src/approval.js'
import { PlanReviewService } from '../src/plan-review.js'
// M57：多用户（测试装配：无账号 → 单用户兼容模式，全部放行）
import { AccessService } from '../src/auth/access.js'
import { AuthService } from '../src/auth/service.js'
import { loadConfig, type AppConfig } from '../src/config.js'
import { Compressor } from '../src/context/compressor.js'
import { ContextService } from '../src/context/service.js'
import { MockProvider } from '../src/llm/mock.js'
import type { ChatRequest, LlmChunk } from '../src/llm/provider.js'
import { Engine } from '../src/orchestration/engine.js'
import { sessionHumans as sessionHumansOf } from '../src/orchestration/humans.js'
import { ArtifactStore } from '../src/store/artifacts.js'
import { ArtifactVersionStore } from '../src/store/artifact-versions.js'
import { ApiKeyStore, AuthSessionStore } from '../src/store/auth-sessions.js'
import { openDatabase } from '../src/store/db.js'
import { FeedbackStore } from '../src/store/feedback.js'
import { MemoryStore } from '../src/store/memory.js'
import { ToolMetricsStore } from '../src/store/metrics.js'
import { PlanStore } from '../src/store/plans.js'
import { ProjectStore } from '../src/store/projects.js'
import { PromptLibrary } from '../src/store/prompts.js'
import { ReviewStore } from '../src/store/reviews.js'
import { RunEventStore } from '../src/store/run-events.js'
import { RunStore } from '../src/store/runs.js'
import { SessionMemberStore } from '../src/store/session-members.js'
import { SessionStore } from '../src/store/sessions.js'
import { createUserLabelResolver } from '../src/context/user-label.js'
import { QuotaService } from '../src/quota/service.js'
import { QuotaStore } from '../src/store/quotas.js'
import { SkillLibrary } from '../src/store/skills.js'
import { SummaryStore } from '../src/store/summaries.js'
import { TaskStore } from '../src/store/tasks.js'
import { UsageStore } from '../src/store/usage.js'
import { UserStore } from '../src/store/users.js'
import { createToolRegistry } from '../src/tools/builtin.js'
import { WorkspaceService } from '../src/workspace.js'

export function makeTmpDir(prefix = 'ma-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export interface PublishedNotification {
  type: NotifyType
  sessionId: string
  runId?: string
  payload: Record<string, unknown>
}

export function makeEnv(overrides: Partial<AppConfig> = {}) {
  const base = loadConfig()
  const cfg: AppConfig = {
    ...base,
    dataDir: makeTmpDir('ma-data-'),
    workspaceDir: makeTmpDir('ma-ws-'),
    // 测试基线：思考模式默认关闭，避免受本地 .env 影响（需要时在 overrides 显式开启）
    llmThinking: false,
    ...overrides,
  }
  cfg.dbFile = path.join(cfg.dataDir, 'app.db')
  // M6：worktree 目录必须隔离到临时 data（绝不指向真实仓库的 data/worktrees）
  cfg.worktreeDir = path.join(cfg.dataDir, 'worktrees')
  cfg.logLevel = 'silent'
  const prompts = new PromptLibrary({ agentsDir: cfg.agentsDir, promptsDir: cfg.promptsDir, onWarn: () => {} })
  const skills = new SkillLibrary(cfg.skillsDir)
  const db = openDatabase(cfg.dbFile)
  const sessions = new SessionStore(db)
  const projects = new ProjectStore(db, cfg.allowedRoots)
  const workspace = new WorkspaceService({ cfg, sessions, projects })
  const artifacts = new ArtifactStore(cfg.workspaceDir, (sid) => workspace.resolveDir(sid))
  const versions = new ArtifactVersionStore(db)
  const memory = new MemoryStore(db)
  const summaries = new SummaryStore(db)
  const tasks = new TaskStore(db)
  const runs = new RunStore(db)
  const usage = new UsageStore(db, cfg.llmPricing)
  const metrics = new ToolMetricsStore(db)
  // M24：计划 / 评审存储与审批服务（范式协作）
  const plans = new PlanStore(db)
  const reviews = new ReviewStore(db)
  const planReviews = new PlanReviewService({ plans, timeoutMs: cfg.planReviewTimeoutMs })
  // M9：轨迹 / 反馈 / 指标
  const events = new RunEventStore(db)
  const feedback = new FeedbackStore(db)
  const provider = new MockProvider({ delayMs: 0 })
  const tools = createToolRegistry(cfg)
  const published: PublishedNotification[] = []
  // M79-AD：用户主题定向投递收集（审批定向等）
  const publishedToUser: Array<{ userId: string; type: string; payload: Record<string, unknown> }> = []
  const notify = {
    publish: (input: PublishedNotification) => {
      published.push(input)
      return input
    },
    publishToUser: (userId: string, type: string, payload: Record<string, unknown>) => {
      publishedToUser.push({ userId, type, payload })
      return { userId, type, payload }
    },
  }
  // M57：多用户服务（真实实例；测试库无账号 → 单用户兼容模式）
  const users = new UserStore(db)
  const authSessions = new AuthSessionStore(db)
  const apiKeys = new ApiKeyStore(db)
  const auth = new AuthService({ cfg, users, authSessions, apiKeys, sessions })
  // M57 P2：会话共享成员（角色矩阵 / 列表可见性）；P2/P3：共享会话人类署名解析
  const sessionMembers = new SessionMemberStore(db)
  const userLabelResolver = createUserLabelResolver({ members: sessionMembers, users })
  const access = new AccessService({ isMultiUser: () => auth.multiUser, sessions, projects, members: sessionMembers })
  const compressor = new Compressor({ cfg, provider, sessions, summaries, memory, usage, userLabelFor: (sid) => userLabelResolver(sid) })
  // M57 P3：配额（缺省不限；存储体积按工作区目录计量）
  const quotaStore = new QuotaStore(db)
  const quotaService = new QuotaService({ cfg, quotas: quotaStore, sessions, usage, dirOf: (sid) => workspace.resolveDir(sid) })
  const context = new ContextService({ cfg, prompts, skills, sessions, artifacts, memory, summaries, compressor, plans, members: sessionMembers, users })
  // M7：审批服务（测试默认短超时场景由用例覆写 cfg.approvalTimeoutMs）；审核 M-4：留痕落库
  const approvals = new ApprovalService({ timeoutMs: cfg.approvalTimeoutMs, db })
  const engine = new Engine({
    cfg,
    prompts,
    skills,
    sessions,
    artifacts,
    memory,
    context,
    provider,
    tools,
    notify,
    tasks,
    // M57 P3：配额（并发上限 / 波次边界用量闸门）
    quotas: quotaService,
    // M57：共享会话人类署名（沉淀输入文本）
    userLabelFor: (sid) => userLabelResolver(sid),
    runs,
    usage,
    metrics,
    approvals,
    // M24：范式协作
    plans,
    reviews,
    planReviews,
    versions,
    events,
    // M47：会话模式门控（与生产装配一致；sandbox 会话 git 工具不进模型清单，repo / worktree 保持可见）
    isGitMode: (sessionId) => workspace.isGitMode(sessionId),
    // M79-AA：会话人类成员（与生产装配同口径；无 owner / 无成员的测试会话返回空 → 行为零差异）
    sessionHumans: (sid) => {
      const session = sessions.getSession(sid)
      return session ? sessionHumansOf(session, auth, sessionMembers) : []
    },
  })
  return {
    cfg,
    prompts,
    skills,
    sessions,
    artifacts,
    versions,
    projects,
    workspace,
    memory,
    summaries,
    tasks,
    runs,
    usage,
    metrics,
    events,
    feedback,
    context,
    compressor,
    provider,
    tools,
    engine,
    approvals,
    plans,
    reviews,
    planReviews,
    notify,
    published,
    publishedToUser,
    db,
    // M57：多用户（路由测试直接 env as ApiDeps 强转；提供真实实例）
    users,
    auth,
    access,
    members: sessionMembers,
    // M57 P3：配额（路由测试直接 env as ApiDeps 强转）
    quotas: quotaService,
    quotaStore,
    quotaService,
  }
}

/** 轮询等待 Run 结束（runs 表移除即完成） */
export async function waitRunFinished(engine: Engine, runId: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (engine.hasRun(runId)) {
    if (Date.now() - start > timeoutMs) throw new Error(`run ${runId} 超时未结束`)
    await new Promise((r) => setTimeout(r, 15))
  }
}

/** 发送用户消息并等待 Run 完成 */
export async function sendAndWait(
  env: ReturnType<typeof makeEnv>,
  sessionId: string,
  content: string,
): Promise<void> {
  const message = env.sessions.appendMessage({
    sessionId,
    role: 'user',
    content,
    mentions: [],
    status: 'complete',
  })
  const { runId } = env.engine.launch(sessionId, message.id)
  await waitRunFinished(env.engine, runId)
}

/** 追加用户消息（不启动 Run）：配合 engine.launch / engine.inject 使用 */
export function appendUserMessage(
  env: ReturnType<typeof makeEnv>,
  sessionId: string,
  content: string,
  /** M79-AD：触发者（审批定向等场景需要）；缺省 = 无触发者（兼容） */
  userId?: string,
): { id: string } {
  return env.sessions.appendMessage({
    sessionId,
    role: 'user',
    content,
    mentions: [],
    status: 'complete',
    ...(userId ? { userId } : {}),
  })
}

/**
 * M48：脚本化 Provider 的平台路由直通 —— responseFormat 请求（PRS）→ 派发在场首位。
 * 保持旧「未 @ 消息由编制首位接手」语义不变；不消费 round 计数、不污染断言数组。
 * 返回 null = 非路由请求（调用方继续走原剧本）。
 */
export function routePassThrough(req: ChatRequest): LlmChunk[] | null {
  // 仅拦截平台路由步请求（digest / summarize 等其它结构化调用照常走调用方剧本）
  if (req.responseFormat?.name !== 'platform_route') return null
  const first = req.meta.participantIds[0]
  const plan = first
    ? { members: [], assignments: [{ agentId: first, task: '继续推进' }], reason: '测试直通' }
    : { members: [], assignments: [], reason: '' }
  return [
    { type: 'text', text: JSON.stringify(plan) },
    { type: 'done' },
  ]
}
