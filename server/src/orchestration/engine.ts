/**
 * 编排引擎（§6 / §29）：波次循环 + 工具循环 + SSE 广播 + WS 通知 + 运行与连接解耦（§18.2）。
 *
 * 一次 Run 的生命周期：
 *   launch（同步建记录、microtask 启动） → run:start → [wave 循环：规划 → 全波建消息 → 并发装配/生成 → 波级调度合并] → run:end
 * 串行 = 单成员波的特例；并行波内成员互相不可见对方当前输出，统一基于波前历史（§29）。
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Response } from 'express'
import type {
  AgentDefinition,
  AgentGroup,
  ChatMessage,
  NotifyType,
  Plan,
  RunEndReason,
  RunEvent,
  Session,
  ToolCallRecord,
  TurnMode,
  UsageSnapshot,
} from '@multi-agent/shared'
import { BLANK_SCENE_ID, baseAgentId, extractDeliveredPaths, sanitizeModelText, soulIdOfMember } from '@multi-agent/shared'
import type { AppConfig } from '../config.js'
import type { ApprovalOutcome, ApprovalService } from '../approval.js'
import type { PlanReviewService } from '../plan-review.js'
import { truncateToTokens } from '../context/tokenizer.js'
import type { ContextService, PreparedTurn } from '../context/service.js'
import { getLogger } from '../logger.js'
import { isContextLengthError, resilientStream } from '../llm/resilience.js'
import {
  abortError,
  isAbortError,
  type ChatRequest,
  type LlmMessageInput,
  type LlmProvider,
  type LlmToolCall,
  type LlmUsage,
} from '../llm/provider.js'
import type { ArtifactStore } from '../store/artifacts.js'
import { MAX_VERSION_CONTENT_BYTES, type ArtifactVersionStore } from '../store/artifact-versions.js'
import type { MemoryStore } from '../store/memory.js'
import { MemoryDigester, type DigestResult } from '../memory/digest.js'
import type { MemoryService } from '../memory/service.js'
import type { ToolMetricsStore } from '../store/metrics.js'
import type { PlanStore } from '../store/plans.js'
import type { QuotaService } from '../quota/service.js'
import type { UserLabeler } from '../context/user-label.js'
import type { PromptLibrary } from '../store/prompts.js'
import type { ReviewStore } from '../store/reviews.js'
import type { RunEventStore } from '../store/run-events.js'
import type { RunStore } from '../store/runs.js'
import { nowIso, type SessionStore } from '../store/sessions.js'
import type { SkillLibrary } from '../store/skills.js'
import type { TaskStore } from '../store/tasks.js'
import type { UsageStore } from '../store/usage.js'
import type {
  AgentTool,
  PlanSubmitInput,
  PlanSubmitOutcome,
  ToolRegistry,
  ToolResult,
  ToolRuntime,
  TodoItem,
} from '../tools/registry.js'
import { isToolAbortError } from '../tools/registry.js'
// M47：环境门控（未启用工具不进模型清单；git 组按会话模式过滤）
import { isGitToolName, toolUnavailableReason } from '../tools/availability.js'
import type { DbConnectionManager } from '../connections/db/manager.js'
import type { SshConnectionManager } from '../connections/ssh/manager.js'
import type { BrowserRuntime } from '../browser/runtime.js'
import type { ConnectionStore } from '../store/connections.js'
import type { McpRuntimeManager } from '../mcp/manager.js'
import type { CanvasStore } from '../canvas/store.js'
import type { MediaService } from '../media/service.js'
import type { ScheduleService } from '../schedule/service.js'
import type { FinanceGateway } from '../finance/gateway.js'
import type { FinanceStore } from '../store/finance.js'
import { isMcpToolName, mcpSlugOf } from '../mcp/naming.js'
import { toolCategory } from '../tools/categories.js'
import { groupOf, lexicalScores, renderDiscoveryBlock, toActivation } from '../tools/discovery.js'
import type { ToolDiscoveryService, ToolSearchEntry } from '../tools/discovery.js'
import { inviteMembersCore } from '../tools/roster.js'
import { buildRosterCatalogBlock } from './roster-catalog.js'
import { runPlatformRoute, type RouteAssignment } from './platform-router.js'
import { countTokensCalibrated } from '../context/tokenizer.js'
import { matchedSensitivePattern, normalizeRel } from '../tools/sensitive.js'
import { writeSse } from '../sse.js'
import { buildMentionTokens, parseMentionsWithTokens, type ParseResult } from './parser.js'
import { parseSessionHumanMentions, type HumanMentionInfo } from './humans.js'
import { resolveMembers } from './members.js'
import { decideHandoff, mergeWaveSchedule, planWave, waveSignature } from './scheduler.js'
import {
  detectWriteConflicts,
  extractWritePaths,
  newWaveWriteBuffer,
  recordWrite,
  type WaveWriteBuffer,
} from './write-tracking.js'

/** 通知发布端口（NotifyHub 满足；测试可注入 stub） */
export interface NotifyPort {
  publish(input: {
    type: NotifyType
    sessionId: string
    runId?: string
    payload: Record<string, unknown>
  }): unknown
  /** M79-AD：用户主题定向投递（审批等仅触发者可见的帧；缺省实现回退会话广播） */
  publishToUser?: (userId: string, type: NotifyType, payload: Record<string, unknown>) => unknown
}

export interface EngineDeps {
  cfg: AppConfig
  prompts: PromptLibrary
  skills: SkillLibrary
  sessions: SessionStore
  artifacts: ArtifactStore
  /** 会话长期记忆（remember 工具 / 上下文装配） */
  memory: MemoryStore
  /** M25：向量记忆服务（L1.5 召回 / remember 嵌入加速；缺省 = 休眠零影响） */
  memories?: MemoryService
  /** 上下文服务（M2：五层装配 + 压缩） */
  context: ContextService
  provider: LlmProvider
  tools: ToolRegistry
  notify: NotifyPort
  /** 任务清单存储（M3：write_todos 落库） */
  tasks: TaskStore
  /** 运行快照存储（M3：Run 持久化与断点恢复） */
  runs: RunStore
  /** 用量与成本存储（M4：每回合 / 摘要调用落库） */
  usage: UsageStore
  /** 工具指标存储（M5：次数 / 失败率 / 平均耗时） */
  metrics: ToolMetricsStore
  /** 审批服务（M7：高危动作挂起等待用户决定） */
  approvals: ApprovalService
  /** M24：计划存储（挂起 / 派发 / 状态迁移；缺省 = 范式编排关闭，全链路零差异） */
  plans?: PlanStore
  /** M24：评审存储（submit_review 落库并广播） */
  reviews?: ReviewStore
  /** M24：计划审批服务（write_plan 挂起等待；缺省 = write_plan 返回未启用） */
  planReviews?: PlanReviewService
  /** 交付件版本存储（M8：写类工具落地后记版，Diff 视图数据源；缺省 = 不记录） */
  versions?: ArtifactVersionStore
  /** M9：运行轨迹存储（trace 落库与指标聚合；缺省 = 不记录） */
  events?: RunEventStore
  /** M22：数据库连接管理器（缺省 = db_* 工具返回未启用提示） */
  db?: DbConnectionManager
  /** M23：SSH 连接管理器（缺省 = ssh_exec 工具返回未启用提示） */
  ssh?: SshConnectionManager
  /** M22：浏览器运行时（缺省 = browser_* 工具返回未启用提示） */
  browser?: BrowserRuntime
  /** M22：连接中心存储（会话绑定校验 / 可用连接清单） */
  connections?: ConnectionStore
  /** M27：MCP 运行时管理器（会话绑定过滤 / 审批策略；缺省 = 未装配 MCP，行为与现状零差异） */
  mcp?: McpRuntimeManager
  /** M31：画布文档存储（canvas_* 工具；缺省 = 工具返回未启用提示） */
  canvas?: CanvasStore
  /** M31：媒体生成服务（media_* 工具；缺省 = 工具返回未启用提示） */
  media?: MediaService
  /** M28：工具发现服务（tool_search 检索内核；缺省 = 禁用发现，全部工具直接加载） */
  toolSearch?: ToolDiscoveryService
  /** M34：金融数据网关（fin_* 工具；缺省 = FINANCE_ENABLED=false 或未装配，工具返回未启用提示） */
  finance?: FinanceGateway
  /** M34：金融自选列表存储（fin_watch 工具；缺省 = 工具返回未启用提示） */
  financeStore?: FinanceStore
  /** M47：会话是否为「真实仓库」模式（repo / worktree；缺省 = 不判定，git 工具保持可见） */
  isGitMode?: (sessionId: string) => boolean
  /** M57 P2：连接最小权限复核（共享会话下成员禁触达未开放连接；缺省 = 不复核） */
  connectionGuard?: (connectionId: string, triggerUserId?: string) => string | undefined
  /** M57 P3：配额服务（并发上限 / 波次边界用量闸门；缺省 = 不限，行为与现状零差异） */
  quotas?: QuotaService
  /** M57 P3：BYOK 生效模型解析（成本归因；缺省 = 系统默认模型） */
  billingModelFor?: (sessionId: string) => string | undefined
  /** M57：共享会话人类署名（记忆沉淀输入文本；缺省 = 「用户」） */
  userLabelFor?: (sessionId: string) => UserLabeler | undefined
  /** M79-E：会话人类成员（@ 真人寻址 / 持球过滤；缺省 = 无人类，行为零差异） */
  sessionHumans?: (sessionId: string) => HumanMentionInfo[]
  /** M79-E：收尾持球回调（写 waiting_on 后：session-meta 广播 + inbox 提醒；缺省 = 跳过） */
  onHandedTo?: (sessionId: string, targets: string[]) => void
}

/** M28：某成员最近一次回合的发现态（enabled = 启用按需发现；entries = 可检索的延迟工具条目） */
interface DiscoveryState {
  enabled: boolean
  entries: ToolSearchEntry[]
}

/** M79-Z：旁观端流式广播的合并窗口（毫秒；帧量 ~8fps/run，远低于 WS 背压阈值） */
const STREAM_BROADCAST_MS = 120

interface RunRecord {
  id: string
  sessionId: string
  /** M57 P2：本 Run 触发者（发起消息的 userId）；共享会话连接复核 / 归因用；兼容模式缺省 */
  triggerUserId?: string
  controller: AbortController
  subscribers: Set<Response>
  queue: string[]
  /** 本 Run 发言序列（含进行中） */
  spoken: string[]
  /** 当前波内进行中成员（串行 = 1 位；空 = 波间空闲；M16） */
  activeMembers: string[]
  fallbackUsed: boolean
  /** M48：本 Run 待平台路由（未 @ 消息 / 空编制开场；runLoop 开头消费一次） */
  routingPending: boolean
  handedToUser: boolean
  /** M79-E：指定交还（agent 行首 @具体人 → 持球写入依据；Run 内并集去重） */
  handedTo: string[]
  /** M79-AA：per-message 人类交还目标（@具体人；交接条渲染具体真人名的精确来源） */
  messageHumanMentions: Map<string, string[]>
  /** 待注入的用户插话消息 id（回合边界消费，不占用回合计数） */
  pendingUserMessages: string[]
  /** M16：本波各消息的 handoff 收集（按消息 id 分组；回合末只消费本回合的目标，避免并行波内交错取走） */
  pendingHandoffs: Map<string, HandoffEntry[]>
  /** M24：转交便条 —— agentId → 待注入的交接条目（接收方发言时消费清除；注入「上一棒期望」行） */
  handoffNotes: Map<string, HandoffEntry[]>
  /** M16：已完成波次的签名序列（循环检测输入；resume 后从空开始） */
  waveSignatures: string[]
  /** M16：每波串联文本（内容级循环检测输入） */
  waveTexts: string[]
  /** M61-D3：每波成功写动作计数（实质进展停滞检测输入） */
  waveWriteCounts: number[]
  /** M61-D3/D5：当前波内写跟踪缓冲（波末结算后重置） */
  waveWrites: WaveWriteBuffer
  /** M16：下一波强制并行（用户 @≥2 / handoff 多目标） */
  forceNextParallel: boolean
  /** 已完成回合数（随 runLoop 同步，供 runs 表持久化） */
  turnIndex: number
  /** M24：per-agent 任务清单（修复 §29 波内并发互相覆盖的已知限制） */
  todosByAgent: Map<string, TodoItem[]>
  skillCache: Map<string, string>
  /** M28：本 Run 已激活的延迟工具（tool_search 命中即激活；Run 级生命周期，不跨 Run） */
  activatedTools: Set<string>
  /** M28：各成员回合级发现态（执行门与检索范围依据；回合开始刷新，Run 结束即弃） */
  discoveryByAgent: Map<string, DiscoveryState>
  state: 'waiting' | 'running' | 'awaiting_approval' | 'awaiting_plan' | 'done'
  /** M24：本 Run 起步范式（首波默认；其后波复位 execute；派发步骤的 review 按成员覆盖） */
  mode: TurnMode
  /** M24：计划派发登记（agentId → 分配给他的步骤 id 序列） */
  planDispatch: Map<string, string[]>
  /** M24：本 Run 关联的活跃计划（派发 / 步骤推进 / 收口扫描输入） */
  activePlanIds: Set<string>
  /** M24：已提交未决的计划（挂起等待期间暂存） */
  pendingPlanIds: Set<string>
  /** M24：作者收口波是否已追加（每 Run 一次） */
  synthesisAdded: boolean
  /** M24：本 Run 内 write_plan 提交计数（规划波协议违规检测） */
  planSubmissions: number
  /** 审核 H-2：收尾幂等标记（finishRun 只生效一次；正常收尾与异常兜底共用） */
  finished?: boolean
}

type TurnOutcome =
  | {
      kind: 'ok'
      /** M16：本成员的原始提案（裁决与合并移至波级 mergeWaveSchedule） */
      proposal: TurnProposal
      durationMs: number
      promptTokens: number
      completionTokens: number
    }
  | { kind: 'stopped' }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string }

/** 成员在波末提交的转交提案（handoff 工具优先；文本 @ 兼容回退） */
interface TurnProposal {
  mentions: string[]
  handedToUser: boolean
  source: 'tool' | 'text'
}

/** M24：交接条目（handoff 工具一次调用的收集单位：来源 + 目标 + 原因 + 期望产出） */
interface HandoffEntry {
  from: string
  targets: string[]
  reason?: string
  expectedOutput?: string
}

export interface LaunchResult {
  runId: string
  queue: string[]
  queued: boolean
}

/** 工具参数解析（模型偶尔产出非法 JSON：以空对象兜底，由参数校验层回灌错误） */
function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

export class Engine {
  private runs = new Map<string, RunRecord>()

  /**
   * M79-Z：旁观端流式广播器（按 run 聚合）。
   * - delta 以 ~120ms 窗口合并后经 NotifyHub 广播（触发者仍走 SSE 流，不重复渲染）；
   * - flush 时机：窗口到期 / 回合收尾前（保证 delta 先于 turn-end 完整消息——顺序即客户端覆盖语义）；
   * - 收尾后残帧（record 已移除）直接丢弃——由 turn-end 的完整消息权威覆盖（最坏退化为「收尾整条」）。
   */
  private streamBroadcasts = new Map<
    string,
    { pending: Map<string, { agentId: string; memberKey: string; chunks: string[] }>; timer?: ReturnType<typeof setTimeout> }
  >()
  /** 会话 → 活跃 Run（M3 会话级互斥：同会话永远只有一个活跃 Run） */
  private sessionRuns = new Map<string, string>()
  /**
   * M79-AF：SSE 订阅者身份（res → userId；审批事件的定向过滤依据）。
   * - 未记录（兼容模式 / 直调 attach）→ 视为放行（行为与旧版零差异）；
   * - 随 attach 注册、取消订阅 / Run 收尾时清理。
   */
  private readonly subscriberUsers = new Map<Response, string | undefined>()
  private activeCount = 0
  private waiting: RunRecord[] = []
  /** M35：定时任务服务（本类构造时尚未存在 —— ScheduleService 需要 engine.launch 闭包，
   *  装配后由 setScheduleService 回填；未回填时 schedule_* 工具返回未启用提示） */
  private scheduleService?: ScheduleService

  constructor(private readonly deps: EngineDeps) {}

  /** M35：装配回填（Server 装配顺序：engine → ScheduleService(引用 engine 闭包) → 回填） */
  setScheduleService(service: ScheduleService): void {
    this.scheduleService = service
  }

  hasRun(runId: string): boolean {
    return this.runs.has(runId)
  }

  /** M79-AF：本 Run 触发者（审批操作权限复核依据；不存在 / 已收尾 → undefined） */
  triggerUserIdOf(runId: string): string | undefined {
    return this.runs.get(runId)?.triggerUserId
  }

  /**
   * 发起运行：用户消息已落库后调用。同步返回 runId（用于订阅），执行在 microtask 启动。
   * M24：opts.mode = Composer 消息级范式（仅本 Run 首波）；缺省按会话「规划先行」→ plan，否则 execute。
   */
  launch(sessionId: string, userMessageId: string, opts: { mode?: TurnMode } = {}): LaunchResult {
    const session = this.deps.sessions.getSession(sessionId)
    if (!session) throw new Error('会话不存在')
    if (this.activeRunOf(sessionId)) throw new Error('会话已有运行中的任务')
    this.assertUserCapacity(sessionId)
    const userMessage = this.deps.sessions
      .messages(sessionId)
      .find((m) => m.id === userMessageId && m.role === 'user')
    if (!userMessage) throw new Error('用户消息不存在')

    // 首发队列（M48 平台路由）：① @ 直达（零变化）② 消息级显式 plan/review 且有编制 → 编制首位
    // （目标已明确，直接投场景首棒）③ 未 @ / 空编制 → 交给平台路由步（引擎组队与派发，非角色回合）
    // （M15 起 members 顺序即编制顺序：建会话时已按场景 chain 排序落库）
    const parsed = this.parseSessionMentions(session, userMessage.content)
    const mentioned = parsed.mentions.filter((id) => session.participantIds.includes(id))
    const explicitMode = opts.mode === 'plan' || opts.mode === 'review'
    // M50：空场景单助手直通 —— 编制恰为一位空场景成员：未 @ 消息直达本人，跳过平台路由（加人 / 换人即退出）
    const soloBlank =
      session.participantIds.length === 1 &&
      this.deps.prompts.get(session.participantIds[0])?.group === BLANK_SCENE_ID
    const queue =
      mentioned.length > 0
        ? [...mentioned]
        : (soloBlank || explicitMode) && session.participantIds.length > 0
          ? [session.participantIds[0]]
          : []
    // M48：空队列 = 交给平台路由步（未 @ 消息 / 空编制开场；runLoop 开头消费）
    const needsRouting = queue.length === 0
    // M24：起步范式（显式消息级 > 会话规划先行 > 执行）；execute 不落库不广播（零差异）
    const mode: TurnMode = opts.mode ?? (session.planFirst ? 'plan' : 'execute')
    // 用户消息 mentions 持久化为解析结果（@chip 渲染依据）；M24：同时持久化消息级范式
    // M79-E：人类定向（humanMentions；@真人 / 行首 @用户 提及）随行持久化
    const launchHumans = this.deps.sessionHumans?.(session.id) ?? []
    const launchHumanParsed = parseSessionHumanMentions(session, this.deps.prompts, launchHumans, userMessage.content)
    this.deps.sessions.patchMessage(sessionId, userMessageId, {
      mentions: mentioned,
      mode: mode === 'execute' ? undefined : mode,
      ...(launchHumanParsed.humanMentions.length > 0 ? { humanMentions: launchHumanParsed.humanMentions } : {}),
    })
    this.deps.sessions.saveNow(sessionId)

    const record: RunRecord = {
      id: `run_${randomUUID().slice(0, 8)}`,
      sessionId,
      // M57 P2：触发者 = 发起本 Run 的用户消息作者（共享会话连接复核；兼容模式为 undefined）
      triggerUserId: userMessage.userId,
      controller: new AbortController(),
      subscribers: new Set(),
      queue,
      spoken: [],
      activeMembers: [],
      fallbackUsed: false,
      routingPending: needsRouting,
      handedToUser: false,
      handedTo: [],
      messageHumanMentions: new Map(),
      pendingUserMessages: [],
      pendingHandoffs: new Map(),
      handoffNotes: new Map(),
      waveSignatures: [],
      waveTexts: [],
      waveWriteCounts: [],
      waveWrites: newWaveWriteBuffer(),
      forceNextParallel: mentioned.length >= 2,
      turnIndex: 0,
      todosByAgent: new Map(),
      skillCache: new Map(),
      activatedTools: new Set(),
      discoveryByAgent: new Map(),
      state: 'waiting',
      mode,
      planDispatch: new Map(),
      activePlanIds: new Set(),
      pendingPlanIds: new Set(),
      synthesisAdded: false,
      planSubmissions: 0,
    }
    // runLoop 同步消费队列（首个 await 前 shift），返回初始快照避免竞态
    const initialQueue = [...queue]
    this.runs.set(record.id, record)
    this.sessionRuns.set(sessionId, record.id)
    this.deps.runs.create({
      id: record.id,
      sessionId,
      state: 'waiting',
      queue,
      // M57：运行归因（会话属主；单用户兼容模式缺省）
      userId: this.deps.sessions.getSession(sessionId)?.ownerId,
    })

    const queued = this.activeCount >= this.deps.cfg.asyncRunMax
    if (queued) {
      this.waiting.push(record)
      this.deps.notify.publish({
        type: 'notify:run-started',
        sessionId,
        runId: record.id,
        payload: { queue, queued: true },
      })
    } else {
      this.startRun(record)
    }
    return { runId: record.id, queue: initialQueue, queued }
  }

  /**
   * M24：稍后批准 —— 计划无挂起（用户停止后取消 / 历史提交）时的批准路径：新起执行 Run。
   * 队列 = 步骤负责人（按步骤序去重）；范式固定 execute（步骤自身的 review 覆盖）。
   */
  launchPlanExecution(sessionId: string, planId: string): LaunchResult {
    const { sessions, plans } = this.deps
    if (!plans) throw new Error('计划功能未启用')
    const session = sessions.getSession(sessionId)
    if (!session) throw new Error('会话不存在')
    if (this.activeRunOf(sessionId)) throw new Error('会话已有运行中的任务')
    this.assertUserCapacity(sessionId)
    const plan = plans.get(planId)
    if (!plan || plan.sessionId !== sessionId) throw new Error('计划不存在')
    if (plan.status === 'submitted') plans.setStatus(planId, 'approved')
    const approved = plans.get(planId)!
    if (approved.status !== 'approved') throw new Error(`计划状态为 ${approved.status}，无法发起执行`)
    const queue = this.planOwnerQueue(approved)
    if (queue.length === 0) throw new Error('计划没有可执行的步骤')

    const record: RunRecord = {
      id: `run_${randomUUID().slice(0, 8)}`,
      sessionId,
      controller: new AbortController(),
      subscribers: new Set(),
      queue,
      spoken: [],
      activeMembers: [],
      fallbackUsed: false,
      routingPending: false,
      handedToUser: false,
      handedTo: [],
      messageHumanMentions: new Map(),
      pendingUserMessages: [],
      pendingHandoffs: new Map(),
      handoffNotes: new Map(),
      waveSignatures: [],
      waveTexts: [],
      waveWriteCounts: [],
      waveWrites: newWaveWriteBuffer(),
      forceNextParallel: false,
      turnIndex: 0,
      todosByAgent: new Map(),
      skillCache: new Map(),
      activatedTools: new Set(),
      discoveryByAgent: new Map(),
      state: 'waiting',
      mode: 'execute',
      planDispatch: new Map(),
      activePlanIds: new Set(),
      pendingPlanIds: new Set(),
      synthesisAdded: false,
      planSubmissions: 0,
    }
    const initialQueue = [...queue]
    this.runs.set(record.id, record)
    this.sessionRuns.set(sessionId, record.id)
    this.deps.runs.create({
      id: record.id,
      sessionId,
      state: 'waiting',
      queue,
      userId: this.deps.sessions.getSession(sessionId)?.ownerId,
    })
    // M24：登记派发（planDispatch + plan→executing）先于首波：首个波次的成员即命中步骤
    this.registerPlanDispatch(record, approved)

    const queued = this.activeCount >= this.deps.cfg.asyncRunMax
    if (queued) {
      this.waiting.push(record)
      this.deps.notify.publish({
        type: 'notify:run-started',
        sessionId,
        runId: record.id,
        payload: { queue: [...queue], queued: true, planId },
      })
    } else {
      this.startRun(record)
    }
    return { runId: record.id, queue: initialQueue, queued }
  }

  /**
   * 订阅运行流：注册 + 快照重放（已产出内容先补再续流，§18.2）。
   * M79-AF：userId 随订阅记录 —— 审批事件的 SSE 补发 / 广播按「触发者 ∪ 会话属主」定向过滤
   * （缺省 undefined = 兼容模式 / 旧调用方，全部放行零差异）。
   */
  attach(runId: string, res: Response, userId?: string): (() => void) | null {
    const record = this.runs.get(runId)
    if (!record) return null
    record.subscribers.add(res)
    this.subscriberUsers.set(res, userId)

    writeSse(res, {
      type: 'run:start',
      runId: record.id,
      sessionId: record.sessionId,
      queue: [...record.queue],
    })
    // M16：并行波恢复 —— activeMembers 非空时先补波次标记（前端按波归组多路流）
    if (record.activeMembers.length > 0) {
      writeSse(res, {
        type: 'wave:start',
        runId: record.id,
        sessionId: record.sessionId,
        waveIndex: record.turnIndex,
        members: [...record.activeMembers],
      })
    }
    const live = this.deps.sessions
      .messages(record.sessionId)
      .filter((m) => m.runId === record.id && m.status === 'streaming')
    for (const message of live) {
      if (message.agentId) {
        writeSse(res, {
          type: 'turn:start',
          runId: record.id,
          agentId: message.agentId,
          memberKey: message.memberKey ?? message.agentId,
          messageId: message.id,
          turnIndex: message.turnIndex ?? 0,
        })
      }
      if (message.content)
        writeSse(res, { type: 'message:delta', messageId: message.id, delta: message.content })
      if (message.reasoning)
        writeSse(res, { type: 'reasoning:delta', messageId: message.id, delta: message.reasoning })
      for (const call of message.toolCalls ?? []) {
        writeSse(res, { type: 'tool:result', messageId: message.id, call })
      }
    }
    // M7/M10：补发未决审批 —— approval:requested 可能早于 SSE 建立（快模型首个工具调用）
    // 或来自刷新重附着；不补发会导致审批卡不出现、Run 永久挂起
    // M79-AF：仅补给「触发者 ∪ 会话属主」的订阅（审批定向口径与 WS 面 / 操作面统一）
    for (const approval of this.deps.approvals.pendingOf(record.id)) {
      if (this.canSeeApproval(record, res)) writeSse(res, { type: 'approval:requested', approval })
    }
    // M24：补发未决计划 —— plan:submitted 可能早于 SSE 建立或来自刷新重附着（计划卡依赖它）
    for (const plan of this.deps.planReviews?.pendingOf(record.sessionId) ?? []) {
      writeSse(res, { type: 'plan:submitted', plan })
    }
    return () => {
      record.subscribers.delete(res)
      this.subscriberUsers.delete(res)
    }
  }

  /**
   * M79-AF：审批可见性（触发者 ∪ 会话属主；未记录身份的订阅放行——兼容模式 / 旧调用方零差异）。
   * 与 notify 面（publishApprovalFrame 定向）及操作面（routes 审批守卫）同一口径。
   */
  private canSeeApproval(record: RunRecord, res: Response): boolean {
    if (!record.triggerUserId) return true
    const userId = this.subscriberUsers.get(res)
    if (!userId) return true
    if (userId === record.triggerUserId) return true
    const ownerId = this.deps.sessions.getSession(record.sessionId)?.ownerId
    return !!ownerId && userId === ownerId
  }

  /** M79-AF：审批事件 SSE 定向广播（逐订阅者过滤；非审批事件仍走 emit 全量） */
  private emitApproval(record: RunRecord, event: RunEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`
    for (const res of record.subscribers) {
      if (!res.writableEnded && this.canSeeApproval(record, res)) res.write(payload)
    }
  }

  /** 会话的活跃运行（M3 会话级互斥判定；不存在或已结束 → undefined） */
  activeRunOf(sessionId: string): { runId: string; queue: string[]; pendingUser: number } | undefined {
    const runId = this.sessionRuns.get(sessionId)
    if (!runId) return undefined
    const record = this.runs.get(runId)
    if (!record || record.state === 'done') {
      this.sessionRuns.delete(sessionId)
      return undefined
    }
    return { runId, queue: [...record.queue], pendingUser: record.pendingUserMessages.length }
  }

  /** 插话（M3）：运行中用户再发送 → 入当前 Run 的待注入队列（回合边界消费，不新建 Run） */
  inject(sessionId: string, userMessageId: string): { injected: true; position: number; runId: string } {
    const active = this.activeRunOf(sessionId)
    if (!active) throw new Error('会话没有运行中的任务，无法插话')
    const session = this.deps.sessions.getSession(sessionId)
    if (!session) throw new Error('会话不存在')
    const message = this.deps.sessions.messageById(sessionId, userMessageId)
    if (!message || message.role !== 'user') throw new Error('用户消息不存在')
    const record = this.runs.get(active.runId)!
    if (!record.pendingUserMessages.includes(userMessageId)) {
      record.pendingUserMessages.push(userMessageId)
    }
    // 插话同样解析 mentions（@chip 渲染依据），但不触发新 Run
    const parsed = this.parseSessionMentions(session, message.content)
    const mentioned = parsed.mentions.filter((id) => session.participantIds.includes(id))
    // M79-E：人类定向随行持久化（@真人）
    const injectHumans = this.deps.sessionHumans?.(session.id) ?? []
    const injectHumanParsed = parseSessionHumanMentions(session, this.deps.prompts, injectHumans, message.content)
    this.deps.sessions.patchMessage(sessionId, userMessageId, {
      mentions: mentioned,
      ...(injectHumanParsed.humanMentions.length > 0 ? { humanMentions: injectHumanParsed.humanMentions } : {}),
    })
    this.deps.sessions.saveNow(sessionId)
    this.deps.runs.update(record.id, { pendingUserMessages: [...record.pendingUserMessages] })
    return { injected: true, position: record.pendingUserMessages.length, runId: record.id }
  }

  /** 断点继续（M3）：以中断快照（队列 + 发言史 + 守卫状态）启动新 Run */
  resume(sessionId: string, runId?: string): LaunchResult {
    const session = this.deps.sessions.getSession(sessionId)
    if (!session) throw new Error('会话不存在')
    if (this.activeRunOf(sessionId)) throw new Error('会话已有运行中的任务')
    this.assertUserCapacity(sessionId)
    const snapshot = runId ? this.deps.runs.get(runId) : this.deps.runs.latestInterrupted(sessionId)
    if (!snapshot) throw new Error('没有可继续的中断运行')
    if (snapshot.sessionId !== sessionId) throw new Error('运行不属于该会话')
    if (snapshot.state !== 'interrupted') throw new Error('该运行不是中断状态，无需继续')
    const queue = snapshot.queue.filter((id) => session.participantIds.includes(id))
    if (queue.length === 0) throw new Error('中断运行没有待办队列，无法继续')

    const record: RunRecord = {
      id: `run_${randomUUID().slice(0, 8)}`,
      sessionId,
      controller: new AbortController(),
      subscribers: new Set(),
      queue,
      spoken: [...snapshot.spoken],
      activeMembers: [],
      fallbackUsed: snapshot.fallbackUsed,
      routingPending: false,
      handedToUser: false,
      handedTo: [],
      messageHumanMentions: new Map(),
      pendingUserMessages: [],
      pendingHandoffs: new Map(),
      handoffNotes: new Map(),
      waveSignatures: [],
      waveTexts: [],
      waveWriteCounts: [],
      waveWrites: newWaveWriteBuffer(),
      forceNextParallel: false,
      turnIndex: 0,
      todosByAgent: new Map(),
      skillCache: new Map(),
      activatedTools: new Set(),
      discoveryByAgent: new Map(),
      state: 'waiting',
      mode: 'execute',
      planDispatch: new Map(),
      activePlanIds: new Set(),
      pendingPlanIds: new Set(),
      synthesisAdded: false,
      planSubmissions: 0,
    }
    // 旧快照标记已恢复（防止重复继续）
    this.deps.runs.update(snapshot.id, { state: 'done', endedAt: nowIso() })

    const initialQueue = [...queue]
    this.runs.set(record.id, record)
    this.sessionRuns.set(sessionId, record.id)
    this.deps.runs.create({
      id: record.id,
      sessionId,
      state: 'waiting',
      queue,
      userId: this.deps.sessions.getSession(sessionId)?.ownerId,
    })

    const queued = this.activeCount >= this.deps.cfg.asyncRunMax
    if (queued) {
      this.waiting.push(record)
      this.deps.notify.publish({
        type: 'notify:run-started',
        sessionId,
        runId: record.id,
        payload: { queue: [...queue], queued: true, resumedFrom: snapshot.id },
      })
    } else {
      this.startRun(record)
    }
    return { runId: record.id, queue: initialQueue, queued }
  }

  /** 停止运行（幂等；排队中的 Run 直接取消收尾，避免 abort 无人消费导致悬挂） */
  stop(runId: string): boolean {
    const record = this.runs.get(runId)
    if (!record || record.state === 'done') return false
    // 审核 H-2：排队中的 Run 尚未 startRun —— abort 不会被任何执行体消费，直接移出等待队列并收尾
    if (record.state === 'waiting' && this.waiting.includes(record)) {
      this.waiting = this.waiting.filter((r) => r !== record)
      record.state = 'done'
      this.finishRun(record, 'stopped', undefined, 0)
      if (this.sessionRuns.get(record.sessionId) === record.id) this.sessionRuns.delete(record.sessionId)
      this.runs.delete(record.id)
      return true
    }
    record.controller.abort()
    return true
  }

  /**
   * M14：指挥台重排队列 —— 仅调整「未出手」成员的顺序（当前发言人已出队，不受影响）。
   * 过滤非参与者并去重；空队列拒绝（避免误收束）；替换队列引用 + 广播 queue:updated。
   */
  reorderQueue(runId: string, agentIds: string[]): { queue: string[] } {
    const record = this.runs.get(runId)
    if (!record) throw new Error('运行不存在或已结束')
    const session = this.deps.sessions.getSession(record.sessionId)
    if (!session) throw new Error('会话不存在')
    const seen = new Set<string>()
    const queue: string[] = []
    for (const id of agentIds) {
      if (seen.has(id) || !session.participantIds.includes(id)) continue
      seen.add(id)
      queue.push(id)
    }
    if (queue.length === 0) throw new Error('队列不能为空：至少保留一位待出手成员')
    record.queue = queue
    this.deps.runs.update(record.id, { queue: [...queue] })
    this.emit(record, {
      type: 'queue:updated',
      runId: record.id,
      sessionId: record.sessionId,
      queue: [...queue],
    })
    // M79-Y：群聊式全同步——重排广播到会话订阅者（触发者外的其他端/成员实时对齐队列）
    this.deps.notify.publish({
      type: 'notify:queue-updated',
      sessionId: record.sessionId,
      runId: record.id,
      payload: { queue: [...queue] },
    })
    this.trace(record, 'queue:updated', { queue: [...queue] })
    return { queue: [...queue] }
  }

  /** M16：成员是否正在发言（当前波内进行中） */
  isMemberActive(runId: string, agentId: string): boolean {
    return this.runs.get(runId)?.activeMembers.includes(agentId) ?? false
  }

  /**
   * M16：动态成员移出 —— 命中运行队列则剔除并广播 queue:updated（未命中为幂等空操作）。
   * 返回 { removed, queue } 供调用方判定。
   */
  removeFromQueue(runId: string, agentId: string): { removed: boolean; queue: string[] } {
    const record = this.runs.get(runId)
    if (!record) throw new Error('运行不存在或已结束')
    const idx = record.queue.indexOf(agentId)
    if (idx === -1) return { removed: false, queue: [...record.queue] }
    record.queue.splice(idx, 1)
    this.deps.runs.update(record.id, { queue: [...record.queue] })
    this.emit(record, {
      type: 'queue:updated',
      runId: record.id,
      sessionId: record.sessionId,
      queue: [...record.queue],
    })
    this.trace(record, 'queue:updated', { queue: [...record.queue] })
    return { removed: true, queue: [...record.queue] }
  }

  /**
   * M77：分身换装同步 —— 成员键原位替换（队列 / 波内进行中 / 已发言台账 / 未消费交接提案 / 交接便条），
   * 已落库的发言史不追溯；广播 queue:updated（指挥台与成员条实时刷新）。成员不在队列也未进行中时仍
   * 替换便条与台账（幂等）。
   *
   * 三个台账的处理口径：
   * - spoken：同席位移交（原键已出手 → 新键视为已出手）——防 fallback 选人时同席位借换装重复出手；
   * - pendingHandoffs：提案目标改写——防旧键经「资产存在」路径被平台重新召集（幽灵复活）；
   * - handoffNotes：便条合并到新键（接收方发言时消费）。
   */
  replaceMemberKey(runId: string, from: string, to: string): { queue: string[] } {
    const record = this.runs.get(runId)
    if (!record) throw new Error('运行不存在或已结束')
    record.queue = [...new Set(record.queue.map((id) => (id === from ? to : id)))]
    record.activeMembers = record.activeMembers.map((id) => (id === from ? to : id))
    record.spoken = [...new Set(record.spoken.map((id) => (id === from ? to : id)))]
    for (const entries of record.pendingHandoffs.values()) {
      for (const entry of entries) entry.targets = entry.targets.map((t) => (t === from ? to : t))
    }
    const notes = record.handoffNotes.get(from)
    if (notes) {
      record.handoffNotes.delete(from)
      record.handoffNotes.set(to, [...(record.handoffNotes.get(to) ?? []), ...notes])
    }
    this.deps.runs.update(record.id, { queue: [...record.queue] })
    this.emit(record, {
      type: 'queue:updated',
      runId: record.id,
      sessionId: record.sessionId,
      queue: [...record.queue],
    })
    this.trace(record, 'queue:updated', { queue: [...record.queue], memberSwap: { from, to } })
    return { queue: [...record.queue] }
  }

  /** M7：停止全部活跃 Run（优雅退出：各 Run 自行落盘 stopped 状态与已产出内容） */
  stopAll(): number {
    let count = 0
    for (const id of [...this.runs.keys()]) {
      if (this.stop(id)) count++
    }
    return count
  }

  /** M7：等待全部 Run 结束（优雅退出用，≤timeoutMs） */
  async waitIdle(timeoutMs: number): Promise<boolean> {
    const start = Date.now()
    while (this.runs.size > 0) {
      if (Date.now() - start > timeoutMs) return false
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return true
  }

  listActiveRuns(): Array<{ runId: string; sessionId: string; state: string; queue: string[] }> {
    return [...this.runs.values()].map((r) => ({
      runId: r.id,
      sessionId: r.sessionId,
      state: r.state,
      queue: [...r.queue],
    }))
  }

  /**
   * M4：继续生成——对已中断（stopped / error）的 Agent 消息续写剩余内容。
   * 复用原消息（不新建），以已产出内容为 assistant 前缀让模型接着写；
   * 完成后回到 complete（不触发调度 / 接力）；对外表现为一个轻量 Run。
   */
  resumeMessage(sessionId: string, messageId: string): { runId: string } {
    const { sessions } = this.deps
    const session = sessions.getSession(sessionId)
    if (!session) throw new Error('会话不存在')
    if (this.activeRunOf(sessionId)) throw new Error('会话已有运行中的任务')
    this.assertUserCapacity(sessionId)
    const message = sessions.messageById(sessionId, messageId)
    if (!message || message.role !== 'agent' || !message.agentId) throw new Error('只能续写 Agent 消息')
    if (message.status === 'streaming') throw new Error('该消息仍在生成中')
    if (message.status === 'complete') throw new Error('该消息已完整生成')
    if (!message.content.trim()) throw new Error('消息没有可续写的内容')

    const record: RunRecord = {
      id: `run_${randomUUID().slice(0, 8)}`,
      sessionId,
      controller: new AbortController(),
      subscribers: new Set(),
      queue: [],
      spoken: [],
      activeMembers: [],
      fallbackUsed: false,
      routingPending: false,
      handedToUser: false,
      handedTo: [],
      messageHumanMentions: new Map(),
      pendingUserMessages: [],
      pendingHandoffs: new Map(),
      handoffNotes: new Map(),
      waveSignatures: [],
      waveTexts: [],
      waveWriteCounts: [],
      waveWrites: newWaveWriteBuffer(),
      forceNextParallel: false,
      turnIndex: 0,
      todosByAgent: new Map(),
      skillCache: new Map(),
      activatedTools: new Set(),
      discoveryByAgent: new Map(),
      state: 'running',
      mode: 'execute',
      planDispatch: new Map(),
      activePlanIds: new Set(),
      pendingPlanIds: new Set(),
      synthesisAdded: false,
      planSubmissions: 0,
    }
    this.runs.set(record.id, record)
    this.sessionRuns.set(sessionId, record.id)
    this.deps.runs.create({
      id: record.id,
      sessionId,
      state: 'running',
      queue: [],
      userId: this.deps.sessions.getSession(sessionId)?.ownerId,
    })
    // 审核 H-2：执行体 reject 兜底（正常路径 finally 已收尾；finishRun 幂等防重复）
    void this.runResumeLoop(record, message).catch((err) => this.handleLoopReject(record, err, 1))
    return { runId: record.id }
  }

  /**
   * M8：重新生成——以相同上下文重跑某条 Agent 消息（仅文本，不重放工具副作用）。
   * 清空原消息后重写，完成后不触发调度；对外表现为一个轻量 Run。
   */
  regenerateMessage(sessionId: string, messageId: string): { runId: string } {
    const { sessions } = this.deps
    const session = sessions.getSession(sessionId)
    if (!session) throw new Error('会话不存在')
    if (this.activeRunOf(sessionId)) throw new Error('会话已有运行中的任务')
    this.assertUserCapacity(sessionId)
    const message = sessions.messageById(sessionId, messageId)
    if (!message || message.role !== 'agent' || !message.agentId) throw new Error('只能重新生成 Agent 消息')
    if (message.status === 'streaming') throw new Error('该消息仍在生成中')

    message.content = ''
    message.reasoning = undefined
    message.mentions = []
    message.toolCalls = []
    message.status = 'streaming'
    sessions.touch(sessionId, message.id)

    const record: RunRecord = {
      id: `run_${randomUUID().slice(0, 8)}`,
      sessionId,
      controller: new AbortController(),
      subscribers: new Set(),
      queue: [],
      spoken: [],
      activeMembers: [],
      fallbackUsed: false,
      routingPending: false,
      handedToUser: false,
      handedTo: [],
      messageHumanMentions: new Map(),
      pendingUserMessages: [],
      pendingHandoffs: new Map(),
      handoffNotes: new Map(),
      waveSignatures: [],
      waveTexts: [],
      waveWriteCounts: [],
      waveWrites: newWaveWriteBuffer(),
      forceNextParallel: false,
      turnIndex: 0,
      todosByAgent: new Map(),
      skillCache: new Map(),
      activatedTools: new Set(),
      discoveryByAgent: new Map(),
      state: 'running',
      mode: 'execute',
      planDispatch: new Map(),
      activePlanIds: new Set(),
      pendingPlanIds: new Set(),
      synthesisAdded: false,
      planSubmissions: 0,
    }
    this.runs.set(record.id, record)
    this.sessionRuns.set(sessionId, record.id)
    this.deps.runs.create({
      id: record.id,
      sessionId,
      state: 'running',
      queue: [],
      userId: this.deps.sessions.getSession(sessionId)?.ownerId,
    })
    // 审核 H-2：执行体 reject 兜底（正常路径 finally 已收尾；finishRun 幂等防重复）
    void this.runRegenerateLoop(record, message).catch((err) => this.handleLoopReject(record, err, 1))
    return { runId: record.id }
  }

  // ---------- 内部 ----------

  /**
   * M57：per-user 并发上限（活跃 + 排队；RUN_MAX_PER_USER=0 不限制）。
   * 会话无属主（单用户兼容模式）时跳过；超限抛中文错误（路由层回 400）。
   */
  private assertUserCapacity(sessionId: string): void {
    const ownerId = this.deps.sessions.getSession(sessionId)?.ownerId
    if (!ownerId) return
    // M57 P3：配额行覆盖系统默认（两者都存在取更小值——QuotaService.limitsOf 已合并）
    const max = this.deps.quotas?.limitsOf(ownerId).maxConcurrentRuns ?? this.deps.cfg.runMaxPerUser
    if (!max) return
    const active = [...this.runs.values()].filter(
      (record) => this.deps.sessions.getSession(record.sessionId)?.ownerId === ownerId,
    ).length
    if (active >= max) {
      throw new Error(`同时进行的任务数已达上限（${max} 个）：请等待现有任务完成或先停止后再试`)
    }
  }

  private startRun(record: RunRecord): void {
    record.state = 'running'
    this.activeCount++
    this.deps.runs.update(record.id, { state: 'running' })
    void this.runLoop(record)
      .catch((err) => {
        // 审核 H-2：runLoop 意外 reject 兜底 —— 正常路径内部已自收尾，这里只处理未捕获异常（finishRun 幂等防重复）
        this.handleLoopReject(record, err, record.turnIndex)
      })
      .finally(() => {
        record.state = 'done'
        if (this.sessionRuns.get(record.sessionId) === record.id) this.sessionRuns.delete(record.sessionId)
        this.activeCount--
        this.runs.delete(record.id)
        this.maybeStartWaiting()
      })
  }

  /**
   * M57 P3：配额超限收束——落系统事件条并即时广播（与并行写冲突提醒同路径）。
   * 容错：落库 / 广播失败不得阻断 Run 收束。
   */
  private notifyQuotaStop(record: RunRecord, detail: string): void {
    try {
      const message = this.deps.sessions.appendMessage({
        sessionId: record.sessionId,
        runId: record.id,
        role: 'system',
        content: `用量配额已超限：${detail}。本次运行已收束。`,
        mentions: [],
        status: 'complete',
      })
      this.deps.notify.publish({
        type: 'notify:plan-updated',
        sessionId: record.sessionId,
        runId: record.id,
        payload: { message },
      })
    } catch (err) {
      getLogger().error({ runId: record.id, err }, '配额收束提示落库失败（已继续收束）')
    }
  }

  /**
   * M57 P3：并入属主 personal MCP 的已注册工具（执行模式自动授予；去重）。
   * 背景：MCP 工具默认需 Agent 工具白名单授权，而 agent 为管理面资产（成员不可编辑）——
   * personal 服务器由属主自建，在属主会话内直接授予；绑定 / 连接 / 可用性由 filterForSession 复核。
   */
  private mergePersonalMcpTools(candidates: AgentTool[], ownerId?: string): AgentTool[] {
    if (!ownerId || !this.deps.mcp) return candidates
    const names = this.deps.mcp.personalToolNames(ownerId)
    if (names.length === 0) return candidates
    const merged = new Map(candidates.map((tool) => [tool.name, tool]))
    for (const name of names) {
      if (merged.has(name)) continue
      const tool = this.deps.tools.get(name)
      if (tool) merged.set(name, tool)
    }
    return [...merged.values()]
  }

  /**
   * 审核 H-2：Run 统一收尾（幂等）—— 正常路径与异常兜底共用。
   * 收尾链路逐环节容错：落库 / 事件 / 广播单点失败不得中断后续（否则 Run 悬挂、订阅者收不到 run:end）。
   * @param notifyEnd 是否广播 notify 完成事件（续写 / 重生成的轻量 Run 保持原语义不发）
   */
  private finishRun(
    record: RunRecord,
    reason: RunEndReason,
    errorMessage: string | undefined,
    waveIndex: number,
    notifyEnd = true,
  ): void {
    if (record.finished) return
    record.finished = true
    record.activeMembers = []
    const guard = (label: string, fn: () => void): void => {
      try {
        fn()
      } catch (err) {
        getLogger().error({ runId: record.id, label, err }, 'Run 收尾环节失败（已继续收尾）')
      }
    }
    guard('save', () => this.deps.sessions.saveNow(record.sessionId))
    guard('trace', () => this.trace(record, 'run:end', { reason, error: errorMessage, turns: waveIndex }))
    guard('emit', () =>
      this.emit(record, {
        type: 'run:end',
        runId: record.id,
        sessionId: record.sessionId,
        reason,
        error: errorMessage,
      }),
    )
    // M3：收尾快照（state=done；错误信息一并落盘）
    guard('snapshot', () =>
      this.deps.runs.update(record.id, {
        state: 'done',
        turnIndex: waveIndex,
        queue: [...record.queue],
        spoken: [...record.spoken],
        handedToUser: record.handedToUser,
        error: errorMessage ?? null,
        endedAt: nowIso(),
      }),
    )
    // M79-E：持球方写入（agent 行首 @具体人 → 指定交还）——仅 completed；成员校验过滤（仅在场人类）
    if (reason === 'completed' && record.handedTo.length > 0) {
      guard('waiting', () => {
        const humans = new Set((this.deps.sessionHumans?.(record.sessionId) ?? []).map((h) => h.userId))
        const targets = record.handedTo.filter((id) => humans.has(id))
        if (targets.length === 0) return
        this.deps.sessions.setWaitingOn(record.sessionId, targets)
        this.deps.onHandedTo?.(record.sessionId, targets)
      })
    }
    if (notifyEnd) {
      guard('notify', () => {
        const payload: Record<string, unknown> = { reason }
        if (reason === 'completed' && (record.handedToUser || record.handedTo.length > 0)) {
          if (record.handedTo.length > 0) payload.targets = [...record.handedTo]
          this.deps.notify.publish({
            type: 'notify:awaiting-user',
            sessionId: record.sessionId,
            runId: record.id,
            payload,
          })
        } else if (reason === 'error') {
          this.deps.notify.publish({
            type: 'notify:run-error',
            sessionId: record.sessionId,
            runId: record.id,
            payload: { error: errorMessage ?? '未知错误' },
          })
        } else {
          this.deps.notify.publish({
            type: 'notify:run-completed',
            sessionId: record.sessionId,
            runId: record.id,
            payload,
          })
        }
      })
    }
    guard('close', () => {
      for (const res of record.subscribers) {
        if (!res.writableEnded) res.end()
        this.subscriberUsers.delete(res) // M79-AF：收尾清理订阅者身份（防 Map 常驻）
      }
      record.subscribers.clear()
    })
    guard('digest', () => {
      const mode = this.deps.cfg.memoryDigestMode
      // M25.4：Run 后沉淀（默认关）—— session：仅主 Run（轻量 Run=续写/重生成 跳过）；all：含轻量 Run
      if (!this.deps.memories || mode === 'off' || reason !== 'completed') return
      if (mode === 'session' && !notifyEnd) return
      void this.digestAfterRun(record)
    })
  }

  /** M25.4：异步沉淀（fire-and-forget）——候选记忆待审；失败静默，绝不影响收尾结果 */
  private async digestAfterRun(record: RunRecord): Promise<void> {
    try {
      const digester = new MemoryDigester({
        cfg: this.deps.cfg,
        provider: this.deps.provider,
        sessions: this.deps.sessions,
        memory: this.deps.memory,
        usage: this.deps.usage,
        // M57：共享会话人类署名（沉淀输入文本）
        userLabelFor: this.deps.userLabelFor,
        poke: this.deps.memories ? () => this.deps.memories!.poke() : undefined,
      })
      const result: DigestResult = await digester.digestRun({ sessionId: record.sessionId, runId: record.id })
      if (result.ok) {
        this.trace(record, 'memory:digest', { candidates: result.candidates, added: result.added })
        if (result.added > 0) {
          getLogger().info(
            {
              sessionId: record.sessionId,
              runId: record.id,
              candidates: result.candidates,
              added: result.added,
            },
            '记忆沉淀完成（候选待审）',
          )
        }
      } else if (result.error) {
        getLogger().warn(
          { sessionId: record.sessionId, runId: record.id, err: result.error },
          '记忆沉淀失败（静默）',
        )
      }
    } catch (err) {
      getLogger().warn({ sessionId: record.sessionId, runId: record.id, err }, '记忆沉淀异常（静默）')
    }
  }

  /** 审核 H-2：执行体 reject 兜底（续写 / 重生成的轻量 Run；finishRun 幂等，正常路径已收尾时仅剩清理） */
  private handleLoopReject(record: RunRecord, err: unknown, waveIndex: number): void {
    getLogger().error(
      { runId: record.id, sessionId: record.sessionId, err },
      'Run 执行体异常终止（兜底收尾）',
    )
    this.finishRun(record, 'error', err instanceof Error ? err.message : String(err), waveIndex)
    if (this.sessionRuns.get(record.sessionId) === record.id) this.sessionRuns.delete(record.sessionId)
    this.runs.delete(record.id)
  }

  private maybeStartWaiting(): void {
    while (this.waiting.length > 0 && this.activeCount < this.deps.cfg.asyncRunMax) {
      const next = this.waiting.shift()!
      this.startRun(next)
    }
  }

  private emit(record: RunRecord, event: RunEvent): void {
    const streamOnly = event.type === 'message:delta' || event.type === 'reasoning:delta'
    if (streamOnly && record.subscribers.size === 0) return
    const payload = `data: ${JSON.stringify(event)}\n\n`
    for (const res of record.subscribers) {
      if (!res.writableEnded) res.write(payload)
    }
  }

  private async runLoop(record: RunRecord): Promise<void> {
    const { sessions, cfg } = this.deps
    const session = sessions.getSession(record.sessionId)
    // 审核 H-2：会话可能已被并发删除 —— 显式抛错，由 startRun 兜底收尾（不再悬挂 Run）
    if (!session) throw new Error('会话不存在（可能已被删除）')
    let reason: RunEndReason = 'completed'
    let errorMessage: string | undefined
    let waveIndex = 0

    this.emit(record, {
      type: 'run:start',
      runId: record.id,
      sessionId: record.sessionId,
      queue: [...record.queue],
    })
    this.trace(record, 'run:start', { queue: [...record.queue] })
    this.deps.notify.publish({
      type: 'notify:run-started',
      sessionId: record.sessionId,
      runId: record.id,
      payload: { queue: [...record.queue], turnCount: 0 },
    })

    // M48：平台路由步（PRS）——未 @ 消息 / 空编制开场：引擎完成「召集 + 派发」后再进入波次循环
    if (record.routingPending) {
      record.routingPending = false
      await this.routeByPlatform(record)
    }

    while (record.queue.length > 0 || record.pendingUserMessages.length > 0) {
      if (record.controller.signal.aborted) {
        reason = 'stopped'
        break
      }

      // M3：波次边界消费插话（不占用波次计数；作为下一波的额外 user 消息，装配器天然包含）
      if (record.pendingUserMessages.length > 0) {
        const injectedIds = record.pendingUserMessages.splice(0)
        this.deps.runs.update(record.id, { pendingUserMessages: [] })
        const injected = injectedIds
          .map((id) => sessions.messageById(record.sessionId, id))
          .filter((m): m is ChatMessage => Boolean(m && m.role === 'user'))
        for (const message of injected) this.emit(record, { type: 'user:injected', message })
        if (record.queue.length === 0 && injected.length > 0) {
          // 队列已空但仍有插话：按插话 @ / 未发言者 / 首位成员补充接手人，避免消息被吞
          const parsed = this.parseSessionMentions(session, injected.map((m) => m.content).join('\n'))
          const mentioned = parsed.mentions.filter((id) => session.participantIds.includes(id))
          const fresh = session.participantIds.filter((id) => !record.spoken.includes(id))
          const next =
            mentioned.length > 0
              ? mentioned
              : fresh.length > 0
                ? fresh.slice(0, 1)
                : session.participantIds.slice(0, 1)
          if (next.length > 0) record.queue.push(...next)
        }
      }
      // M16：动态成员变更防御 —— 队列只保留在场成员（移出成员由 members API 走 removeFromQueue 广播）
      record.queue = record.queue.filter((id) => session.participantIds.includes(id))
      if (record.queue.length === 0) break // 无接手人（理论不可达，防御性退出）

      // M57 P3：用量配额闸门（日 token / 月成本）——超限则落系统条提示并以 reason='quota' 收束本 Run
      const quotaBlock = session.ownerId ? this.deps.quotas?.blockedReason(session.ownerId) : undefined
      if (quotaBlock) {
        this.notifyQuotaStop(record, quotaBlock)
        reason = 'quota'
        break
      }

      if (waveIndex >= cfg.maxTurnsPerRun) {
        reason = 'turn-limit'
        break
      }

      // M16：波次规划（串行 = 单成员波特例；触发规则取并集：显式 @≥2 / handoff 多目标 / 场景 parallel）
      // M46-2：会话串行开关开启时并行上限收紧为 1（显式并行触发同样逐位出场，便于跟进查看）
      const wave = planWave({
        queue: record.queue,
        groupOf: (id) => this.agentGroup(id),
        globalParallelMax: session.serial ? 1 : cfg.parallelMax,
        forceParallel: record.forceNextParallel,
      })
      const missing = wave.members.find((id) => !this.deps.prompts.get(id))
      if (missing) {
        reason = 'error'
        errorMessage = `角色 ${missing} 不存在`
        break
      }
      record.forceNextParallel = false
      record.queue = record.queue.slice(wave.members.length)
      record.turnIndex = waveIndex

      const modes = wave.members.map((agentId) => this.turnModeOf(record, agentId, waveIndex))
      const waveMode = modes[0] ?? 'execute'
      // M24：波内成员命中的 pending 步骤置 in_progress（任务面板 / 提示词实时反映）
      this.markWaveStepsInProgress(record, wave.members)
      const submissionsBefore = record.planSubmissions

      this.emit(record, {
        type: 'wave:start',
        runId: record.id,
        sessionId: record.sessionId,
        waveIndex,
        members: [...wave.members],
        ...(waveMode === 'execute' ? {} : { mode: waveMode }),
      })
      this.trace(
        record,
        'wave:start',
        {
          members: [...wave.members],
          parallel: wave.parallel,
          ...(waveMode === 'execute' ? {} : { mode: waveMode }),
        },
        waveIndex,
      )

      // 全波先建消息（streaming 空消息、seq 连续）：turn:start 全部先于任何 turn:end；
      // 同波成员互相不可见对方当前输出，统一基于波前历史（§29 上下文隔离）
      const handles = wave.members.map((agentId, i) =>
        this.startWaveTurn(record, agentId, waveIndex, modes[i] ?? 'execute'),
      )
      // 波内进行中成员登记（members API 拒删判定 / attach 快照重放依据）
      record.activeMembers = [...wave.members]
      const outcomes = await Promise.all(
        handles.map((handle, i) =>
          this.executeTurn(record, handle.agentId, handle.message, waveIndex, {
            excludeMessageIds: handles.map((h) => h.message.id),
            parallelPeers: wave.parallel ? [...wave.members] : [],
            mode: modes[i] ?? 'execute',
          }),
        ),
      )
      record.activeMembers = []

      // 失败语义：任一 stopped → 整波中止；任一 timeout/error → 终止 Run（与串行现状一致）
      const stoppedIdx = outcomes.findIndex((o) => o.kind === 'stopped')
      const timeoutIdx = outcomes.findIndex((o) => o.kind === 'timeout')
      const errorIdx = outcomes.findIndex((o) => o.kind === 'error')
      if (stoppedIdx !== -1 || timeoutIdx !== -1 || errorIdx !== -1) {
        // 波中途失败：已正常产出的成员按完成收尾（失败成员由 executeTurn 自标记 stopped/error）
        for (let i = 0; i < handles.length; i++) {
          const outcome = outcomes[i]
          if (outcome.kind !== 'ok') continue
          this.finishTurn(record, handles[i], waveIndex, [], {
            durationMs: outcome.durationMs,
            promptTokens: outcome.promptTokens,
            completionTokens: outcome.completionTokens,
            source: outcome.proposal.source,
            loopSuppressed: false,
          })
        }
        // 防御性清理：异常路径不应残留波内 handoff 缓冲
        for (const handle of handles) record.pendingHandoffs.delete(handle.message.id)
        if (stoppedIdx !== -1) {
          reason = 'stopped'
        } else if (timeoutIdx !== -1) {
          reason = 'error'
          errorMessage = '回合超时，已中断本次运行'
        } else {
          const failed = outcomes[errorIdx] as Extract<TurnOutcome, { kind: 'error' }>
          reason = 'error'
          errorMessage = failed.message
        }
        break
      }
      const results = outcomes as Array<Extract<TurnOutcome, { kind: 'ok' }>>

      // 波末 fan-in：逐成员裁决（decideHandoff）→ 波级合并（mergeWaveSchedule）
      // M61-D3/D5：波内写跟踪结算（计数入列 → 冲突检测 → 重置；先于 merge 使停滞检测含本波）
      const waveWrites = record.waveWrites
      record.waveWriteCounts.push(waveWrites.count)
      record.waveWrites = newWaveWriteBuffer()
      this.reportWriteConflicts(record, waveWrites.byAgent, waveIndex)
      record.waveSignatures.push(waveSignature(wave.members))
      record.waveTexts.push(
        handles
          .map((h) => h.message.content.trim())
          .filter((t) => t.length > 0)
          .join('\n\n'),
      )
      const merge = mergeWaveSchedule({
        decisions: handles.map((handle, i) => ({
          agentId: handle.agentId,
          ...decideHandoff({
            mentions: results[i].proposal.mentions,
            handedToUser: results[i].proposal.handedToUser,
            participants: session.participantIds,
            currentAgentId: handle.agentId,
          }),
        })),
        participants: session.participantIds,
        queue: record.queue,
        signatures: record.waveSignatures,
        waveTexts: record.waveTexts,
        waveWriteCounts: record.waveWriteCounts,
        spoken: record.spoken,
        fallbackUsed: record.fallbackUsed,
        rounds: wave.members.some((id) => this.agentGroup(id)?.rounds === true),
      })
      record.queue = merge.queue
      record.handedToUser = record.handedToUser || merge.handedToUser
      record.fallbackUsed = merge.fallbackUsed
      record.forceNextParallel = merge.forceNextParallel
      // M24：波末计划收敛 —— 协议违规提示（规划波未产出计划）→ 批准派发 → 完成收口
      this.notePlanProtocolViolation(record, waveMode, submissionsBefore, waveIndex)
      this.dispatchApprovedPlans(record, waveIndex)
      this.maybeAppendSynthesisWave(record, waveIndex)
      // M24：计划执行保障 —— 队列被交还清空但仍有未完成步骤 → 补回剩余负责人（批准即执行到底）
      this.refillPlanQueue(record)
      this.trace(
        record,
        'schedule',
        {
          members: [...wave.members],
          parallel: wave.parallel,
          accepted: merge.acceptedByAgent,
          dropped: merge.dropped,
          queue: [...record.queue],
          handedToUser: merge.handedToUser,
          loopSuppressed: merge.loopSuppressed,
          stallSuppressed: merge.stallSuppressed,
          fallbackUsed: merge.fallbackUsed,
        },
        waveIndex,
      )
      // 波次合并后的队列广播（指挥台排队区 / 图谱排队序号徽章）
      this.emit(record, {
        type: 'queue:updated',
        runId: record.id,
        sessionId: record.sessionId,
        queue: [...record.queue],
      })

      // 逐成员收尾（turn:end 均携带合并后队列；mentions = 本人实际接手，波级交还 = ['user']）
      for (let i = 0; i < handles.length; i++) {
        this.finishTurn(record, handles[i], waveIndex, merge.acceptedByAgent[i]?.accepted ?? [], {
          durationMs: results[i].durationMs,
          promptTokens: results[i].promptTokens,
          completionTokens: results[i].completionTokens,
          source: results[i].proposal.source,
          // M61-D3：停滞抑制与循环抑制同走「抑制收尾」展示路径（TraceDrawer 分开标注）
          loopSuppressed: merge.loopSuppressed || merge.stallSuppressed,
        })
      }
      // 防御性清理：异常路径不应残留波内 handoff 缓冲
      for (const handle of handles) record.pendingHandoffs.delete(handle.message.id)

      waveIndex++
      record.turnIndex = waveIndex
      // M3：波次结束快照落盘（断点恢复依据；turnIndex = 已完成波数）
      this.deps.runs.update(record.id, {
        turnIndex: waveIndex,
        queue: [...record.queue],
        spoken: [...record.spoken],
        fallbackUsed: record.fallbackUsed,
        handedToUser: record.handedToUser,
      })
    }

    // 审核 H-2：统一收尾（幂等 + 逐环节容错；runLoop 主体异常由 startRun 兜底调用 finishRun）
    this.finishRun(record, reason, errorMessage, waveIndex)
  }

  /** M16：波内成员发言登记（全波先建消息：seq 连续、turn:start 全部先于任何 turn:end）；M24：携带本成员范式 */
  private startWaveTurn(
    record: RunRecord,
    /** M77：成员键（分身 = `agentId~soulId`；经典 = agentId）——波内身份/状态/事件归属 */
    agentId: string,
    waveIndex: number,
    mode: TurnMode,
  ): { agentId: string; message: ChatMessage } {
    const { sessions } = this.deps
    record.spoken.push(agentId)
    const baseId = baseAgentId(agentId)
    const message = sessions.appendMessage({
      sessionId: record.sessionId,
      runId: record.id,
      turnIndex: waveIndex,
      role: 'agent',
      // M77：agentId 保持基础角色（存量消费端零改动）；memberKey 记录具体说话实例（分身）
      agentId: baseId,
      memberKey: agentId,
      content: '',
      mentions: [],
      status: 'streaming',
      toolCalls: [],
      mode: mode === 'execute' ? undefined : mode,
    })
    this.emit(record, {
      type: 'turn:start',
      runId: record.id,
      agentId: baseId,
      memberKey: agentId,
      messageId: message.id,
      turnIndex: waveIndex,
      ...(mode === 'execute' ? {} : { mode }),
    })
    this.trace(record, 'turn:start', { agentId: baseId, memberKey: agentId, messageId: message.id }, waveIndex)
    // M3：等待首 token / 上下文准备（含压缩）统一表达为 thinking（首个输出后转 speaking）
    this.publishStatus(record, agentId, 'thinking', 'prepare')
    return { agentId, message }
  }

  /** M16：波内成员收尾（turn:end 携带合并后队列；mentions = 本人实际接手，波级交还 = ['user']） */
  /** M79-Z：累积一段流式文本（窗口合并；首次触发定时 flush） */
  private broadcastStreamDelta(record: RunRecord, message: ChatMessage, delta: string): void {
    if (!delta) return
    let state = this.streamBroadcasts.get(record.id)
    if (!state) {
      state = { pending: new Map() }
      this.streamBroadcasts.set(record.id, state)
    }
    const entry = state.pending.get(message.id) ?? {
      agentId: baseAgentId(message.memberKey ?? message.agentId ?? ''),
      memberKey: message.memberKey ?? message.agentId ?? '',
      chunks: [],
    }
    entry.chunks.push(delta)
    state.pending.set(message.id, entry)
    if (!state.timer) {
      state.timer = setTimeout(() => this.flushStreamBroadcast(record.id), STREAM_BROADCAST_MS)
      state.timer.unref?.()
    }
  }

  /** M79-AD：审批帧定向投递——仅触发者可见（含其多端）；会话其他真人不可见。
   *  无触发者（兼容模式 / 直调）时回退会话广播，行为零差异。 */
  private publishApprovalFrame(
    record: RunRecord,
    type: 'notify:approval-requested' | 'notify:approval-resolved',
    payload: Record<string, unknown>,
  ): void {
    const notify = this.deps.notify
    if (record.triggerUserId && notify.publishToUser) {
      notify.publishToUser(record.triggerUserId, type, payload)
      return
    }
    notify.publish({ type, sessionId: record.sessionId, runId: record.id, payload })
  }

  /** M79-Z：窗口合并帧广播（record 已不在 = 丢残余，由 turn-end 完整消息覆盖） */
  private flushStreamBroadcast(runId: string): void {
    const state = this.streamBroadcasts.get(runId)
    if (!state) return
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    const record = this.runs.get(runId)
    const pending = [...state.pending.entries()]
    state.pending.clear()
    if (record) {
      for (const [messageId, entry] of pending) {
        const delta = entry.chunks.join('')
        if (!delta) continue
        this.deps.notify.publish({
          type: 'notify:message-delta',
          sessionId: record.sessionId,
          runId: record.id,
          payload: { messageId, agentId: entry.agentId, memberKey: entry.memberKey, delta },
        })
      }
    }
    // 回收：run 已结束且无待发内容 → 清除聚合器（防 Map 常驻）
    if (!record && state.pending.size === 0 && !state.timer) this.streamBroadcasts.delete(runId)
  }

  private finishTurn(
    record: RunRecord,
    handle: { agentId: string; message: ChatMessage },
    waveIndex: number,
    mentions: string[],
    meta: {
      durationMs: number
      promptTokens: number
      completionTokens: number
      source: 'tool' | 'text'
      loopSuppressed: boolean
    },
  ): void {
    const { sessions } = this.deps
    const { agentId, message } = handle
    // M79-Z：收尾前先冲刷流式残帧（先 delta 后完整消息——客户端按序覆盖）
    this.flushStreamBroadcast(record.id)
    // M55：波级收尾二次净化（幂等兜底；覆盖 executeTurn 常规净化点之外的收尾路径）
    this.sanitizeAndAudit(record, message)
    message.status = 'complete'
    message.mentions = mentions
    // M79-AA：交还目标具体化——交接条渲染「from → 真人名」而非泛称「你的回合」。
    // 目标 = 本消息 @具体人（per-message）∪ @用户 展开（全体在场真人）；无人类列表时保底触发者。
    const humans = this.deps.sessionHumans?.(record.sessionId) ?? []
    let humanTargets = (record.messageHumanMentions.get(message.id) ?? []).filter((id) =>
      humans.some((h) => h.userId === id),
    )
    if (humanTargets.length === 0 && mentions.includes('user') && humans.length > 0) {
      humanTargets = humans.map((h) => h.userId)
    }
    if (humanTargets.length === 0 && mentions.includes('user') && record.triggerUserId) {
      humanTargets = [record.triggerUserId]
    }
    if (humanTargets.length > 0) {
      message.humanMentions = humanTargets
      sessions.patchMessage(record.sessionId, message.id, { humanMentions: humanTargets })
    }
    sessions.touch(record.sessionId, message.id)
    this.emit(record, {
      type: 'turn:end',
      messageId: message.id,
      agentId: baseAgentId(agentId),
      memberKey: agentId,
      mentions,
      queue: [...record.queue],
      status: 'complete',
    })
    this.trace(
      record,
      'turn:end',
      {
        agentId: baseAgentId(agentId),
        memberKey: agentId,
        messageId: message.id,
        mentions,
        queue: [...record.queue],
        status: 'complete',
        durationMs: meta.durationMs,
        promptTokens: meta.promptTokens,
        completionTokens: meta.completionTokens,
      },
      waveIndex,
    )
    this.deps.notify.publish({
      type: 'notify:turn-end',
      sessionId: record.sessionId,
      runId: record.id,
      payload: {
        agentId: baseAgentId(agentId),
        memberKey: agentId,
        messageId: message.id,
        mentions,
        queue: [...record.queue],
        loopSuppressed: meta.loopSuppressed,
        handoffSource: meta.source,
        // M79-U：携带完整消息——多真人会话的**其他成员**（及同账号其他标签页）无 SSE 流，
        // 经会话主题补投做同会话 upsert（此前仅触发者可见，其他成员需刷新；与 routes 层补播模式一致）
        message,
      },
    })
    this.publishStatus(record, agentId, 'done')
  }

  /** 成员所属场景（波次规划 / 循环阈值判定；角色或场景未注册 → undefined） */
  private agentGroup(agentId: string): AgentGroup | undefined {
    const agent = this.deps.prompts.get(agentId)
    if (!agent) return undefined
    return this.deps.prompts.groups().find((g) => g.id === agent.group)
  }

  /** 会话实时在场名单（M77：成员实例投影——id = 成员键，name = 展示 token；ToolRuntime 惰性 participants / 成员校验共用） */
  private liveRoster(sessionId: string): Array<{ id: string; name: string }> {
    const session = this.deps.sessions.getSession(sessionId)
    if (!session) return []
    return resolveMembers(session, this.deps.prompts).map((m) => ({ id: m.key, name: m.label }))
  }

  /** M77：会话 @ 解析（成员实例 token 表；裸名 = 主实例（编制序首位），多实例时 `@名字·灵魂名` 点名；全伞 = 逐一点名） */
  private parseSessionMentions(session: Session, text: string): ParseResult {
    return parseMentionsWithTokens(text, buildMentionTokens(resolveMembers(session, this.deps.prompts)))
  }

  /** M77：角色 id / 成员键 → 在场成员键（精确命中优先；否则该角色首个实例） */
  private resolveMemberKey(session: Session, idOrKey: string): string | undefined {
    if (session.participantIds.includes(idOrKey)) return idOrKey
    const base = baseAgentId(idOrKey)
    return session.participantIds.find((key) => baseAgentId(key) === base)
  }

  /**
   * M77：成员键 → 展示标签（自描述回退链）：在场实例标签 > 键内嵌灵魂还原（历史消息 / 已移除 / 已换键的
   * 实例：`名字·灵魂名`）> 角色名 > 键。经典键（无内嵌灵魂）不补后缀；灵魂资产已删时回退角色名。
   */
  private memberLabelOf(sessionId: string, key: string): string {
    const session = this.deps.sessions.getSession(sessionId)
    if (session) {
      const hit = resolveMembers(session, this.deps.prompts).find((m) => m.key === key)
      if (hit) return hit.label
    }
    const agent = this.deps.prompts.get(key)
    if (!agent) return key
    const embedded = soulIdOfMember(key)
    const soul = embedded ? this.deps.prompts.soul(key) : undefined
    return soul ? `${agent.name}·${soul.meta.name}` : agent.name
  }

  /** M77：会话成员标签表（memberKey → 展示 token；请求 meta / 目录「已在场」共用） */
  private memberLabelsOf(sessionId: string): Record<string, string> {
    const session = this.deps.sessions.getSession(sessionId)
    if (!session) return {}
    const labels: Record<string, string> = {}
    for (const m of resolveMembers(session, this.deps.prompts)) labels[m.key] = m.label
    return labels
  }

  /** 温度解析：「统一温度」开关（设置面板热切换）开启时忽略角色级配置，全部角色使用全局温度 */
  private temperatureOf(agent?: AgentDefinition): number {
    const { cfg } = this.deps
    return cfg.temperatureOverride ? cfg.temperature : (agent?.temperature ?? cfg.temperature)
  }

  /**
   * M61-D5：并行波写冲突提醒 —— 两成员修改同一文件时落系统事件条（role=system，不进 LLM 窗口）
   * + trace 留痕；仅真重叠产出（单成员波 / 无重叠零开销）。跟踪失败静默，绝不阻断主流程。
   */
  private reportWriteConflicts(
    record: RunRecord,
    byAgent: Map<string, Set<string>>,
    waveIndex: number,
  ): void {
    const pairs = detectWriteConflicts(byAgent)
    if (pairs.length === 0) return
    this.trace(record, 'wave:write-conflict', { pairs }, waveIndex)
    const nameOf = (id: string): string => this.deps.prompts.get(id)?.name ?? id
    const detail = pairs
      .map((p) => `${nameOf(p.a)} 与 ${nameOf(p.b)} 均修改了 ${p.paths.join('、')}`)
      .join('；')
    const message = this.deps.sessions.appendMessage({
      sessionId: record.sessionId,
      runId: record.id,
      role: 'system',
      content: `并行写冲突提醒：${detail}。请收敛方核对合并，避免互相覆盖。`,
      mentions: [],
      status: 'complete',
    })
    // 复用 plan-updated 通道即时插入系统事件条（与平台路由提示同路径）
    this.deps.notify.publish({
      type: 'notify:plan-updated',
      sessionId: record.sessionId,
      runId: record.id,
      payload: { message },
    })
  }

  /**
   * 输出截断提示（finish_reason=length）：正文达到单次输出上限（max_tokens）被截断——
   * 落系统事件条（role=system，不进 LLM 窗口，与并行写冲突提示同路径）让用户知晓不完整
   * 并给出可行动路径；不修改消息状态（内容已停止，非失败）。
   */
  private appendTruncationNotice(record: RunRecord, agentId: string, message: ChatMessage): void {
    const name = this.deps.prompts.get(baseAgentId(agentId))?.name ?? agentId
    const sys = this.deps.sessions.appendMessage({
      sessionId: record.sessionId,
      runId: record.id,
      role: 'system',
      content: `${name} 的发言达到单次输出上限被截断（正文可能不完整）：可对该消息「重新生成」，或让 ${name} 分批补齐剩余内容。`,
      mentions: [],
      status: 'complete',
    })
    this.trace(record, 'turn:truncated', { agentId, messageId: message.id })
    this.deps.notify.publish({
      type: 'notify:plan-updated',
      sessionId: record.sessionId,
      runId: record.id,
      payload: { message: sys },
    })
  }

  /**
   * M48：平台召集（共享内核 + trace）——落库 / 广播 / 事件条与成员 API 语义一致
   * （措辞「召集了」，主语「平台」）。source：route（平台路由决策）/ handoff（成员转交未在场者的自动增援）。
   */
  private enlistByPlatform(
    record: RunRecord,
    agentIds: string[],
    reason: string,
    source: 'route' | 'handoff',
  ): string[] {
    const result = inviteMembersCore(
      { sessions: this.deps.sessions, prompts: this.deps.prompts, notify: this.deps.notify },
      { sessionId: record.sessionId, agentIds, reason, verb: '召集了', actorName: '平台' },
    )
    if (!result.ok || result.added.length === 0) return []
    this.trace(record, 'routing:dispatched', { source, members: result.added, reason })
    return result.added
  }

  /** M48：应用路由派发 —— 任务便条注入（接手者回合显示「上一棒期望」）+ 队列填充 + 多目标并行 */
  private applyRouteAssignments(record: RunRecord, assignments: RouteAssignment[], reason: string): void {
    for (const { agentId, task, mode } of assignments) {
      if (record.queue.includes(agentId)) continue
      const notes = record.handoffNotes.get(agentId) ?? []
      // M61-D1：模式软建议（平台建议，非强制——执行权限仍由范式机制与工具白名单决定）
      const hint =
        mode === 'plan'
          ? '（平台建议：先 write_plan 提交规划再动手）'
          : mode === 'review'
            ? '（平台建议：按评审范式核对后 submit_review）'
            : ''
      notes.push({ from: '平台', targets: [agentId], reason, expectedOutput: hint ? `${task}${hint}` : task })
      record.handoffNotes.set(agentId, notes)
      record.queue.push(agentId)
    }
    if (assignments.length >= 2) record.forceNextParallel = true
  }

  /**
   * M61-D7：路由降级排序 —— 在场成员按「所属场景 chain 中位置」靠前者优先（上游角色优先接手）。
   * 不在任何 chain 的成员保持原序靠后；稳定排序（同 rank 按编制序）。
   */
  private fallbackOrder(session: { participantIds: string[] }): string[] {
    const rankOf = (id: string): number => {
      const group = this.agentGroup(id)
      if (!group) return 998
      // M77：成员键按基础角色计链序（分身与经典实例同链位）
      const i = group.chain.indexOf(baseAgentId(id))
      return i === -1 ? 997 : i
    }
    return [...session.participantIds].sort((a, b) => rankOf(a) - rankOf(b))
  }

  /** M61-D1：工作区交付件清单（浅层扫描 ≤30 条 / 截断 600 字符；失败静默返回空串） */
  private listDeliverables(sessionId: string): string {
    try {
      const root = this.deps.artifacts.ensureSessionDir(sessionId)
      const out: string[] = []
      const walk = (dir: string, prefix: string, depth: number): void => {
        if (out.length >= 30 || depth > 2) return
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (out.length >= 30) return
          if (entry.name.startsWith('.')) continue
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name
          if (entry.isDirectory()) walk(path.join(dir, entry.name), rel, depth + 1)
          else out.push(rel)
        }
      }
      walk(root, '', 0)
      return out.join('、').slice(0, 600)
    } catch {
      return ''
    }
  }

  /**
   * M48：平台路由步（PRS）——未 @ 消息 / 空编制开场的接手决策（非角色回合：不占波次、不产生消息）。
   * 流程：组装输入（需求 + 上下文 + 目录 + M61 会话简报）→ 结构化调用 → 召集落库 → 任务便条注入 → 队列填充；
   * 降级：失败且有编制 → 场景链首在场成员接手（M61-D7；trace 留 fallback 标记）；空编制无兜底 → 事件条提示并收尾。
   */
  private async routeByPlatform(record: RunRecord): Promise<void> {
    const { prompts, sessions } = this.deps
    const session = sessions.getSession(record.sessionId)
    if (!session) return
    // M77：成员标签表（分身 = 名字·灵魂名；目录「已在场」与上下文署名为可读性服务）
    const memberLabels = this.memberLabelsOf(record.sessionId)
    const userMessage = [...sessions.messages(record.sessionId)].reverse().find((m) => m.role === 'user')
    if (!userMessage) return
    // 最近上下文（帮助理解「继续」类指代；渲染截断控体积）
    const contextText = sessions
      .messages(record.sessionId)
      .filter((m) => m.id !== userMessage.id && m.role !== 'system' && m.content.trim() !== '')
      .slice(-4)
      .map((m) => {
        // M77：上下文署名优先成员标签（分身 = 名字·灵魂名）
        const who =
          m.role === 'user'
            ? '用户'
            : m.memberKey
              ? this.memberLabelOf(record.sessionId, m.memberKey)
              : (prompts.get(m.agentId ?? '')?.name ?? m.agentId ?? '成员')
        return `[${who}] ${m.content.trim().slice(0, 160)}`
      })
      .join('\n')
      .slice(0, 800)
    // M61-D1：路由输入增强 —— 会话阶段 / 最近接手者（去重参考）/ 已有交付件（防重复创建）
    const agentMsgs = sessions.messages(record.sessionId).filter((m) => m.role === 'agent')
    const recentHandlers = [
      ...new Set(
        agentMsgs
          .slice(-3)
          .map((m) => m.memberKey ?? m.agentId)
          .filter((id): id is string => Boolean(id)),
      ),
    ]
      .map((id) => `${this.memberLabelOf(record.sessionId, id)}(${id})`)
      .join('、')
    const outcome = await runPlatformRoute({
      cfg: this.deps.cfg,
      provider: this.deps.provider,
      catalog: buildRosterCatalogBlock(prompts, session.participantIds, memberLabels),
      userText: userMessage.content,
      contextText,
      stage: agentMsgs.length === 0 ? 'opening' : 'ongoing',
      recentHandlers,
      deliverables: this.listDeliverables(record.sessionId),
      presentIds: [...session.participantIds],
      // M50：空场景成员不进 PRS 可召集集（幻觉输出同样被 coerceRoutePlan 丢弃）
      knownIds: new Set(
        prompts
          .list()
          .filter((a) => a.group !== BLANK_SCENE_ID)
          .map((a) => a.id),
      ),
      usage: this.deps.usage,
      runId: record.id,
      sessionId: record.sessionId,
      signal: record.controller.signal,
    })
    if (!outcome.ok) {
      // M61-D7：降级接手从「编制首位」升级为「场景链首」在场成员（上游角色优先）
      const fallback = this.fallbackOrder(session)[0]
      this.trace(record, 'routing:dispatched', { fallback: true, error: outcome.error ?? '' })
      if (!fallback) {
        // 空编制且路由失败：可见提示 + 直接收尾（绝不静默）
        const message = sessions.appendMessage({
          sessionId: record.sessionId,
          runId: record.id,
          role: 'system',
          content: '平台未能为该需求匹配到合适的成员。请在「成员」面板手动邀请成员后重新发送。',
          mentions: [],
          status: 'complete',
        })
        // 复用 plan-updated 通道即时插入系统事件条（payload.message upsert；与协议违规提示同路径）
        this.deps.notify.publish({
          type: 'notify:plan-updated',
          sessionId: record.sessionId,
          runId: record.id,
          payload: { message },
        })
        return
      }
      this.applyRouteAssignments(
        record,
        [{ agentId: fallback, task: '按你的职责推进该需求' }],
        '平台路由失败，交由首位成员接手',
      )
      return
    }
    // 召集（PRS 决策的成员先落库，再派发；事件条「平台 召集了 …」可审计）
    if (outcome.members.length > 0) {
      this.enlistByPlatform(record, outcome.members, outcome.reason || '平台路由召集', 'route')
    }
    // M77：派发目标归一为在场成员键（角色 id → 经典实例 / 该角色首个实例）
    const currentSession = sessions.getSession(record.sessionId)
    const presentNow = new Set(currentSession?.participantIds ?? [])
    const valid = outcome.assignments
      .map((a) => ({
        ...a,
        agentId: currentSession ? (this.resolveMemberKey(currentSession, a.agentId) ?? a.agentId) : a.agentId,
      }))
      .filter((a) => presentNow.has(a.agentId))
    if (valid.length === 0) {
      // M61-D7：同降级路径 —— 场景链首成员接手
      const current = sessions.getSession(record.sessionId)
      const fallback = current ? this.fallbackOrder(current)[0] : undefined
      if (fallback)
        this.applyRouteAssignments(
          record,
          [{ agentId: fallback, task: '按你的职责推进该需求' }],
          outcome.reason,
        )
      return
    }
    this.trace(record, 'routing:dispatched', { assignments: valid, reason: outcome.reason })
    this.applyRouteAssignments(record, valid, outcome.reason)
  }

  /** 波内单成员执行：装配 → 流式生成 → 工具循环 → 转交提案（裁决与合并由波级 fan-in 统一收敛） */
  private async executeTurn(
    record: RunRecord,
    agentId: string,
    message: ChatMessage,
    turnIndex: number,
    opts: { excludeMessageIds: string[]; parallelPeers: string[]; mode: TurnMode },
  ): Promise<TurnOutcome> {
    const { cfg, prompts, skills, sessions } = this.deps
    const agent = prompts.get(agentId)
    if (!agent) return { kind: 'error', message: `角色 ${agentId} 不存在` }
    const session = sessions.getSession(record.sessionId)!

    // M24：回合指令范式扩展 —— 派发步骤（仅本人负责，含验收/期望产出）、评审目标、上一棒交接便条（全空 → 与现状文本零差异）
    const appliedSteps = this.planStepsFor(record, agentId)
    const reviewTargets = this.reviewTargetsFor(appliedSteps.filter((s) => s.ownerAgentId === agentId))
    const incomingHandoffs = record.handoffNotes.get(agentId) ?? []
    record.handoffNotes.delete(agentId)
    // M61-D4：接单回执 —— 消费交接便条即记录一次「已接单」（审计交接链闭环；纯观测）
    if (incomingHandoffs.length > 0) {
      this.trace(
        record,
        'handoff:accepted',
        {
          agentId,
          from: incomingHandoffs.map((h) => h.from).slice(0, 4),
          count: incomingHandoffs.length,
          reason: incomingHandoffs[0]?.reason?.slice(0, 120),
        },
        turnIndex,
      )
    }
    const turnExtra = {
      mode: opts.mode,
      planSteps: appliedSteps
        .filter((s) => s.ownerAgentId === agentId)
        .map((s) => ({
          planId: s.planId,
          stepId: s.stepId,
          content: s.content,
          acceptance: s.acceptance,
          expectedOutput: s.expectedOutput,
        })),
      reviewTargets,
      handoffs: incomingHandoffs.map((h) => ({
        from: prompts.get(h.from)?.name ?? h.from,
        expectedOutput: h.expectedOutput,
      })),
    }

    // M24：范式工具白名单（plan / review = 只读 + 范式工具）+ 本回合动态授权（派发步骤的 update_plan_step）
    // M27：MCP 工具按「服务器启用 + 已连接 + 会话绑定」过滤（未绑定不进入模型清单；执行期再校验兼容中途解绑）
    // M28：tool_search 恒并入候选（引擎授权；是否进 schema 由发现态决定）
    const baseCandidates = this.deps.tools.forAgent(agent, opts.mode, [
      ...(appliedSteps.length > 0 ? ['update_plan_step'] : []),
      'tool_search',
    ])
    // M57 P3：personal MCP 自动授予（仅 execute 模式；plan / review 保持只读白名单语义）
    const toolCandidates =
      opts.mode && opts.mode !== 'execute'
        ? baseCandidates
        : this.mergePersonalMcpTools(baseCandidates, session.ownerId)
    // M47：环境门控 —— 未启用的工具不进模型清单与可发现范围（防「必然失败」调用；执行期守卫仍在）
    const gitVisible = this.deps.isGitMode ? this.deps.isGitMode(record.sessionId) : true
    const availableTools = (
      this.deps.mcp ? this.deps.mcp.filterForSession(record.sessionId, toolCandidates, session.ownerId) : toolCandidates
    ).filter((tool) => {
      if (toolUnavailableReason(tool.name, cfg)) return false
      return gitVisible || !isGitToolName(tool.name)
    })
    // M28：本回合发现态（auto 阈值自适应；小集合 = 全量加载，行为与现状完全一致）
    const discovery = this.resolveDiscovery(availableTools)
    record.discoveryByAgent.set(agentId, discovery)

    // 上下文装配（M2：五层装配 + 预算压缩；压缩事件在流上广播；排除波内全部消息实现同波隔离）
    const prepared = await this.deps.context.prepareTurn({
      sessionId: record.sessionId,
      agentId,
      runId: record.id,
      // M79-J（§8.8）：人类花名册（human_roster + 交还指令；无人类不注入）
      humans: this.humanRosterFor(record.sessionId),
      queue: [...record.queue],
      excludeMessageIds: opts.excludeMessageIds,
      parallelPeers: opts.parallelPeers,
      signal: record.controller.signal,
      // M28：未加载能力的类别概览（仅发现启用时注入；未启用 → 空串不注入）
      toolDiscoveryBlock: this.discoveryBlockFor(record, discovery),
      ...turnExtra,
    })
    if (prepared.compression) this.publishCompression(record, prepared.compression)
    // M25：语义召回事件（L1.5 注入明细；未装配 memories 时 recalled 恒为 undefined）
    if (prepared.recalled) {
      this.trace(
        record,
        'memory:recall',
        {
          count: prepared.recalled.length,
          items: prepared.recalled.map((item) => ({ id: item.id, scope: item.scope, score: item.score })),
        },
        turnIndex,
      )
    }
    // M4：压缩后重试路径会重新装配，故为 let
    let system = prepared.system
    let window = prepared.messages
    let turnInstruction = prepared.turnInstruction
    const toolMessages: LlmMessageInput[] = []
    // M16：灵魂透传（会话覆盖 > 角色默认；mock 据此输出风格化文案）
    const effectiveSoul = prompts.soul(agentId, session.memberSouls?.[agentId])?.meta.id

    const turn = this.makeTurnSignal(record)
    const startedAt = Date.now()
    let promptTokens = 0
    let completionTokens = 0
    let reportedSpeaking = false
    let contextLengthRetried = false
    try {
      // 竞态兜底：run 在本回合开始前已被停止
      if (turn.signal.aborted) throw abortError()
      // 交付规格闭环：深度档放宽工具步数上限（骨架 + 多节填充 + 自检需要更多步）
      const maxSteps = prepared.deliverableSpec === 'deep' ? Math.max(cfg.maxToolSteps, 12) : cfg.maxToolSteps
      let step = 0
      /** 截断发生在本回合最后一子轮（无后续工具轮可补齐）——仅此时提示 */
      let truncatedAtEnd = false
      while (step < maxSteps) {
        // M28：每子轮重算工具清单 —— 发现启用时 = core ∪ 已激活（tool_search 激活在子轮间即时生效）；
        // 未启用时 = 全量（仅隐藏 tool_search，保持与 M28 前一致）
        const turnTools = discovery.enabled
          ? availableTools.filter((tool) => tool.tier !== 'deferred' || record.activatedTools.has(tool.name))
          : availableTools.filter((tool) => tool.name !== 'tool_search')
        const request: ChatRequest = {
          system,
          messages: [...window, { role: 'user', content: turnInstruction }, ...toolMessages],
          // 多 Provider：模型名命中模型服务清单 → 经该服务调用（未命中 = 系统默认）
          model: agent.model,
          // M57 P3：BYOK 凭据按会话属主解析
          sessionId: record.sessionId,
          temperature: this.temperatureOf(agent),
          thinking: cfg.llmThinking,
          tools: turnTools.length > 0 ? this.deps.tools.toSchema(turnTools) : undefined,
          meta: {
            agentId,
            participantIds: session.participantIds,
            spokenAgentIds: [...record.spoken],
            stepIndex: turnIndex,
            availableSkills: skills.list().map((s) => s.name),
            soul: effectiveSoul,
            // M77：成员标签表（mock 转交行 / 纪要署名；分身 = 名字·灵魂名）
            memberLabels: this.memberLabelsOf(record.sessionId),
            ...(opts.mode === 'execute' ? {} : { mode: opts.mode }),
          },
        }

        const pendingCalls: LlmToolCall[] = []
        /** 本子轮截断（finish_reason=length）：每子轮重置——有后续工具轮 = 模型已继续补齐，不提示 */
        let truncated = false
        /** 本子轮思考内容：开启思考时随 assistant(tool_calls) 消息回传给 API（硬性要求） */
        let stepReasoning = ''
        try {
          // M4：韧性包装——错误分类重试（429/5xx/网络类）+ 首 token / 空闲超时分层；
          // 已产出内容后失败不重试（防重复文本），交给「继续生成」路径
          for await (const chunk of resilientStream(
            (signal) => this.deps.provider.chatStream(request, signal),
            {
              maxAttempts: Math.max(1, cfg.llmMaxRetries),
              baseDelayMs: cfg.llmRetryBaseDelayMs,
              firstTokenTimeoutMs: cfg.firstTokenTimeoutMs,
              idleTimeoutMs: cfg.streamIdleTimeoutMs,
              parentSignal: turn.signal,
              onRetry: (info) => {
                getLogger().warn(
                  {
                    runId: record.id,
                    agentId,
                    attempt: info.attempt,
                    delayMs: info.delayMs,
                    reason: info.reason,
                  },
                  'LLM 请求失败，自动重试',
                )
                this.emit(record, {
                  type: 'error',
                  message: `模型请求失败（${info.reason}），${Math.max(1, Math.round(info.delayMs / 1000))}s 后自动重试`,
                })
              },
            },
          )) {
            if (chunk.type === 'text') {
              if (!reportedSpeaking) {
                reportedSpeaking = true
                this.publishStatus(record, agentId, 'speaking')
              }
              message.content += chunk.text
              this.emit(record, { type: 'message:delta', messageId: message.id, delta: chunk.text })
              // M79-Z：旁观端流式（节流聚合广播；触发者走 SSE 去重）
              this.broadcastStreamDelta(record, message, chunk.text)
              sessions.touch(record.sessionId, message.id)
            } else if (chunk.type === 'reasoning') {
              stepReasoning += chunk.text
              message.reasoning = (message.reasoning ?? '') + chunk.text
              this.emit(record, { type: 'reasoning:delta', messageId: message.id, delta: chunk.text })
              sessions.touch(record.sessionId, message.id)
            } else if (chunk.type === 'tool_calls') {
              pendingCalls.push(...chunk.calls)
            } else if (chunk.type === 'usage') {
              // M4：用量落库 + 流上广播（每回合一次）；M9：累计进 trace 回合条目
              promptTokens += chunk.usage.promptTokens
              completionTokens += chunk.usage.completionTokens
              this.recordTurnUsage(record, agentId, request.model, chunk.usage)
            } else if (chunk.type === 'truncated') {
              truncated = true
            }
          }
        } catch (streamErr) {
          // M4：context_length_exceeded → 强制压缩后重试本回合（整个 Run 仅一次）
          if (!contextLengthRetried && isContextLengthError(streamErr)) {
            contextLengthRetried = true
            const compressed = await this.deps.context.forceCompress({
              sessionId: record.sessionId,
              runId: record.id,
              signal: turn.signal,
            })
            if (compressed.compressed) {
              // 强制压缩已发生：立即发布事件（重新装配未必再触发常规压缩）
              this.publishCompression(record, {
                untilSeq: compressed.untilSeq,
                beforeTokens: compressed.beforeTokens ?? 0,
                afterTokens: compressed.afterTokens ?? 0,
                degraded: compressed.degraded,
              })
              const reprepared = await this.deps.context.prepareTurn({
                sessionId: record.sessionId,
                agentId,
                runId: record.id,
                // M79-J（§8.8）：人类花名册（human_roster + 交还指令；无人类不注入）
                humans: this.humanRosterFor(record.sessionId),
                queue: [...record.queue],
                excludeMessageIds: opts.excludeMessageIds,
                parallelPeers: opts.parallelPeers,
                signal: turn.signal,
                // M28：重新装配同样携带发现区块（激活态实时；无未激活条目 → 不注入）
                toolDiscoveryBlock: this.discoveryBlockFor(record, discovery),
                ...turnExtra,
              })
              system = reprepared.system
              window = reprepared.messages
              turnInstruction = reprepared.turnInstruction
              if (reprepared.compression) this.publishCompression(record, reprepared.compression)
              getLogger().warn({ runId: record.id, agentId }, '上下文超长：已强制压缩并重试本回合')
              continue // step 不增：重试当前子轮
            }
          }
          throw streamErr
        }

        if (pendingCalls.length === 0) {
          truncatedAtEnd = truncated
          break
        }
        toolMessages.push({
          role: 'assistant',
          content: '',
          reasoning: stepReasoning || undefined,
          toolCalls: pendingCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
        })
        await this.executeToolCalls(record, message, pendingCalls, toolMessages, turn.signal, turn.reason)
        step++
      }

      // 输出截断治理：正文被单次输出上限截断 → 系统事件条提示（不阻塞流程，可重新生成 / 分批补齐）
      if (truncatedAtEnd) this.appendTruncationNotice(record, agentId, message)

      // M16：转交提案收集（裁决与波级合并移至 mergeWaveSchedule；handoff 工具优先，文本 @ 兼容回退）
      // M24：条目式收集（携带来源与期望产出；非 user 目标留存便条，待其发言注入「上一棒期望」）
      // M48：目标不在场但资产存在 → 平台自动召集（成员增援无需手动邀请；落库后 decideHandoff 正常接手）
      // M55：收尾净化先于 @ 解析（仿写日志块内可能出现伪 @ 交还标记）
      this.sanitizeAndAudit(record, message)
      const parsed = this.parseSessionMentions(session, message.content)
      // M79-E：行首 @具体人（指定交还）→ 持球候选（Run 内并集；收尾过滤在场人类后写入 waiting_on）
      {
        const humans = this.deps.sessionHumans?.(session.id) ?? []
        if (humans.length > 0) {
          const humanParsed = parseSessionHumanMentions(session, this.deps.prompts, humans, message.content)
          for (const id of humanParsed.handedTo) {
            if (!record.handedTo.includes(id)) record.handedTo.push(id)
          }
          // M79-AA：per-message 交还目标（交接条「from → 真人名」精确来源；@用户 在收尾展开）
          if (humanParsed.handedTo.length > 0) {
            record.messageHumanMentions.set(message.id, [...humanParsed.handedTo])
          }
        }
      }
      const entries = record.pendingHandoffs.get(message.id) ?? []
      record.pendingHandoffs.delete(message.id)
      const toolHandoffs: string[] = []
      const enlistTargets = new Set<string>()
      for (const entry of entries) {
        for (const target of entry.targets) {
          if (!toolHandoffs.includes(target)) toolHandoffs.push(target)
          if (target === 'user') continue
          const notes = record.handoffNotes.get(target) ?? []
          notes.push(entry)
          record.handoffNotes.set(target, notes)
          if (!session.participantIds.includes(target) && this.deps.prompts.get(target))
            enlistTargets.add(target)
        }
      }
      if (enlistTargets.size > 0) {
        const speakerName = prompts.get(agentId)?.name ?? agentId
        this.enlistByPlatform(record, [...enlistTargets], `${speakerName} 转交时自动召集`, 'handoff')
      }
      const toolToUser = toolHandoffs.includes('user')
      const toolTargets = toolHandoffs.filter((t) => t !== 'user')
      const hasToolHandoff = toolHandoffs.length > 0

      let mentions: string[] = []
      let handedToUser = false
      if (cfg.handoffMode === 'text') {
        mentions = parsed.mentions
        handedToUser = parsed.handedToUser
      } else if (hasToolHandoff) {
        mentions = toolTargets
        handedToUser = toolToUser
      } else if (cfg.handoffMode === 'auto') {
        mentions = parsed.mentions
        handedToUser = parsed.handedToUser
      }
      // tool 模式且无工具调用：既不解析文本也不交还 → 走收尾兜底
      return {
        kind: 'ok',
        proposal: { mentions, handedToUser, source: hasToolHandoff ? 'tool' : 'text' },
        durationMs: Date.now() - startedAt,
        promptTokens,
        completionTokens,
      }
    } catch (err) {
      // M55：中断 / 异常收尾同样净化已产出的半截正文（幂等）
      this.sanitizeAndAudit(record, message)
      const aborted = isAbortError(err) || turn.signal.aborted
      this.trace(
        record,
        'turn:end',
        {
          agentId,
          messageId: message.id,
          status: aborted ? (turn.reason() === 'timeout' ? 'timeout' : 'stopped') : 'error',
          durationMs: Date.now() - startedAt,
          promptTokens,
          completionTokens,
        },
        turnIndex,
      )
      if (aborted) {
        if (turn.reason() === 'timeout') {
          message.status = 'error'
          sessions.touch(record.sessionId, message.id)
          this.emit(record, {
            type: 'error',
            message: `回合超时（${Math.round(cfg.turnTimeoutMs / 1000)}s），已中断`,
          })
          return { kind: 'timeout' }
        }
        message.status = 'stopped'
        sessions.touch(record.sessionId, message.id)
        return { kind: 'stopped' }
      }
      message.status = 'error'
      sessions.touch(record.sessionId, message.id)
      const text = err instanceof Error ? err.message : String(err)
      this.emit(record, { type: 'error', message: text })
      return { kind: 'error', message: text }
    } finally {
      turn.cleanup()
    }
  }

  /**
   * 工具调用批量执行（M5）：相邻只读工具并行（Promise.all），写类工具逐个串行；
   * 预建执行记录保证前端卡片与回灌顺序均为模型调用顺序（tool_call_id 对齐）。
   */
  private async executeToolCalls(
    record: RunRecord,
    message: ChatMessage,
    calls: LlmToolCall[],
    toolMessages: LlmMessageInput[],
    signal: AbortSignal,
    turnReason: () => 'stopped' | 'timeout' | undefined,
  ): Promise<void> {
    const { sessions } = this.deps
    const runtime = this.buildToolRuntime(record, message)

    // 预建执行记录（模型调用顺序）→ 前端卡片即时可见
    const running: ChatMessage['toolCalls'] = message.toolCalls ?? []
    const entries = new Map<string, ToolCallRecord>()
    for (const call of calls) {
      const entry: ToolCallRecord = {
        id: call.id,
        name: call.name,
        args: parseToolArgs(call.arguments),
        status: 'running',
        startedAt: new Date().toISOString(),
      }
      entries.set(call.id, entry)
      running.push(entry)
      this.emit(record, { type: 'tool:call', messageId: message.id, call: { ...entry } })
    }
    message.toolCalls = running
    sessions.touch(record.sessionId, message.id)

    let index = 0
    try {
      while (index < calls.length) {
        // M7：停止 / 超时后剩余工具不再执行（预建条目由 finally 结算为「未执行」，不留 running）
        if (signal.aborted) throw abortError()
        // 连续只读工具成批并行；写类（含未知工具）逐个串行，保持先后语义
        const readBatch = this.deps.tools.isReadOnly(calls[index].name)
        let end = index + 1
        if (readBatch) {
          while (end < calls.length && this.deps.tools.isReadOnly(calls[end].name)) end++
        }
        const group = calls.slice(index, end)
        const results: ToolResult[] = readBatch
          ? await Promise.all(
              group.map((call) =>
                this.runToolCall(record, message, call, entries.get(call.id)!, runtime, signal),
              ),
            )
          : [await this.runToolCall(record, message, group[0], entries.get(group[0].id)!, runtime, signal)]
        // 按调用顺序应用副作用并回灌（handoff 顺序 / 工具消息顺序）
        for (let i = 0; i < group.length; i++) {
          this.applyToolResult(record, message, group[i], results[i], toolMessages)
        }
        index = end
      }
    } finally {
      // M7：批次提前退出兜底（停止 / 超时 / 异常）—— 未结算条目必须收口，否则前端卡片永久转圈
      this.settleInterruptedCalls(record, message, calls, entries, signal, turnReason)
    }
  }

  /**
   * M7：中断收口 —— 将批次内仍未结算（status=running）的预建条目标记为「未执行」并广播 tool:result。
   * 触发场景：运行停止 / 回合超时后未轮到的工具调用（预建条目已下发前端，不回填将悬挂转圈）。
   */
  private settleInterruptedCalls(
    record: RunRecord,
    message: ChatMessage,
    calls: LlmToolCall[],
    entries: Map<string, ToolCallRecord>,
    signal: AbortSignal,
    turnReason: () => 'stopped' | 'timeout' | undefined,
  ): void {
    let settled = false
    for (const call of calls) {
      const entry = entries.get(call.id)
      if (!entry || entry.status !== 'running') continue
      // M47：未执行完的调用归入「已停止」语义（非工具失败；前端琥珀色呈现，不再是红卡）
      entry.status = 'stopped'
      entry.summary = !signal.aborted
        ? '运行中断，未执行'
        : turnReason() === 'timeout'
          ? '回合超时，未执行'
          : '运行已停止，未执行'
      entry.endedAt = new Date().toISOString()
      this.emit(record, { type: 'tool:result', messageId: message.id, call: { ...entry } })
      settled = true
    }
    if (settled) this.deps.sessions.touch(record.sessionId, message.id)
  }

  /** M5：按回合构建工具运行时（并行/串行共用；signal 由 execWithAbort 按工具注入） */
  private buildToolRuntime(record: RunRecord, message: ChatMessage): ToolRuntime {
    const { cfg, artifacts } = this.deps
    // M46：实时在场名单闭包（惰性 participants 数据源；同回合召集后即时反映）
    const liveParticipants = (): Array<{ id: string; name: string }> => this.liveRoster(record.sessionId)
    // M77：成员级身份（分身实例）——计划/任务/发现态按成员键归属；agentId 保持基础角色（归因/记忆）
    const memberId = message.memberKey ?? message.agentId!
    const runtime: ToolRuntime = {
      sessionId: record.sessionId,
      runId: record.id,
      agentId: message.agentId!,
      memberKey: memberId,
      // M57：会话属主（remember 的 global 记忆按用户隔离；单用户兼容模式缺省）
      userId: this.deps.sessions.getSession(record.sessionId)?.ownerId,
      // M57 P2：触发者（共享会话连接最小权限复核：以发起本 Run 的成员为准，而非会话属主）
      triggerUserId: record.triggerUserId,
      connectionGuard: this.deps.connectionGuard,
      workspace: artifacts.ensureSessionDir(record.sessionId),
      artifacts,
      skills: this.deps.skills,
      memory: this.deps.memory,
      // M25：向量记忆（remember 写入后 poke；project scope 归属由会话 projectId 决定）
      memories: this.deps.memories,
      projectId: this.deps.sessions.getSession(record.sessionId)?.projectId,
      tasks: this.deps.tasks,
      // M24：计划 / 评审通道（范式工具数据面；缺省时工具自行返回未启用）
      plans: this.deps.plans,
      reviews: this.deps.reviews,
      planSteps: this.planStepsFor(record, memberId),
      submitPlan:
        this.deps.plans && this.deps.planReviews
          ? (input: PlanSubmitInput, signal?: AbortSignal) => this.submitPlan(record, message, input, signal)
          : undefined,
      // 惰性读取（每次访问读实时成员表）——保证「同回合先召集、后 handoff」与计划负责人校验即时生效
      get participants() {
        return liveParticipants()
      },
      // M48：全量资产解析 —— handoff 目标不在场但资产存在 → 放行（由引擎自动召集为成员增援）
      // M50：空场景成员除外（通用助手不可被自动召集，解析不到 → 报「不在场」）
      resolveAgent: (token) => {
        const byId = this.deps.prompts.get(token)
        if (byId && byId.group !== BLANK_SCENE_ID) return { id: byId.id, name: byId.name }
        const match = this.deps.prompts.list().find((a) => a.group !== BLANK_SCENE_ID && a.name === token)
        return match ? { id: match.id, name: match.name } : undefined
      },
      todos: this.todosFor(record, memberId),
      allowRunCommand: cfg.allowRunCommand,
      allowedCommands: cfg.allowedCommands,
      allowSensitive: cfg.allowSensitive,
      webSearch: cfg.webSearch,
      httpUserAgent: cfg.httpUserAgent,
      httpMinIntervalMs: cfg.httpMinIntervalMs,
      httpTimeoutMs: cfg.httpTimeoutMs,
      // M7：审批通道（request_approval 工具 → 挂起等待；随回合信号停止而取消）
      requestApproval: (action, detail, options) =>
        this.requestApproval(record, message, action, detail, options, runtime.turnSignal),
      loadSkill: (name: string) => {
        const cached = record.skillCache.get(name)
        if (cached !== undefined) return { ok: true, body: cached, cached: true }
        const skill = this.deps.skills.get(name)
        if (!skill) {
          // M28：未命中回灌 top-3 相近候选（词法排序），替代全量技能名（降低无效回灌 token）
          return { ok: false, error: `技能「${name}」不存在。${this.skillCandidates(name)}` }
        }
        record.skillCache.set(name, skill.body)
        return { ok: true, body: skill.body }
      },
      // M28：工具按需发现（tool_search → 检索激活；命中工具下一子轮即时进入工具清单）
      searchTools: this.deps.toolSearch
        ? async (query: string, limit?: number) => {
            const service = this.deps.toolSearch
            const state = record.discoveryByAgent.get(message.memberKey ?? message.agentId!)
            // M47：未装配 / 发现未启用 = 全部工具已直接可用（非失败语义，防误报与无谓重试）
            if (!service || !state?.enabled) {
              return { ok: true, activated: [], direct: true, note: '当前所有工具均已直接可用，无需检索' }
            }
            try {
              const hits = await service.rank(query, state.entries, limit ?? cfg.toolSearchLimit)
              if (hits.length === 0) {
                this.trace(record, 'tool:search', { agentId: message.agentId, query, activated: [] })
                return { ok: true, activated: [], note: this.discoveryNoHitNote(state.entries) }
              }
              const activated = hits.map((hit) => toActivation(hit.entry))
              for (const hit of hits) record.activatedTools.add(hit.entry.name)
              this.trace(record, 'tool:search', {
                agentId: message.agentId,
                query,
                activated: activated.map((entry) => entry.name),
              })
              return { ok: true, activated }
            } catch (err) {
              return { ok: false, error: `工具检索失败：${err instanceof Error ? err.message : String(err)}` }
            }
          }
        : undefined,
      // M22：连接中心（数据库 / 浏览器工具的运行期依赖；未装配时工具返回明确提示）
      db: this.deps.db,
      ssh: this.deps.ssh,
      browser: this.deps.browser,
      connections: this.deps.connections,
      // M27：MCP 运行时（会话绑定校验 / 工具过滤 / 审批策略）
      mcp: this.deps.mcp,
      // M31：画布创作（canvas_* / media_* 工具运行期依赖；未装配时工具返回明确提示）
      canvas: this.deps.canvas,
      media: this.deps.media,
      // M35：定时任务（schedule_* 工具运行期依赖；未回填时工具返回未启用提示）
      scheduleRuntime: this.scheduleService,
      // M34：金融投研（fin_* 工具运行期依赖；未装配时工具返回未启用提示）
      finance: this.deps.finance,
      financeStore: this.deps.financeStore,
      // M22：数据库工具操作事件 → notify:op（前端直播窗/操作流实时可视化；浏览器侧由 BrowserRuntime 自行发布）
      opNotify: (op) =>
        this.deps.notify.publish({
          type: 'notify:op',
          sessionId: record.sessionId,
          runId: record.id,
          payload: {
            ...op,
            ts: new Date().toISOString(),
            sessionId: record.sessionId,
            runId: record.id,
            actor: message.agentId ?? 'agent',
          },
        }),
    }
    return runtime
  }

  // ---------- M28：工具按需发现（发现态判定 / 检索范围 / 执行门 / 回灌辅助） ----------

  /** 本回合发现态判定：off / 未装配 → 禁用；on → 强制启用；auto → 延迟集合规模自适应（小集合与现状一致） */
  private resolveDiscovery(availableTools: AgentTool[]): DiscoveryState {
    const { cfg } = this.deps
    const deferred = availableTools.filter((tool) => tool.tier === 'deferred')
    const entries = deferred.map((tool): ToolSearchEntry => {
      const mcp = isMcpToolName(tool.name)
      return {
        name: tool.name,
        description: tool.description,
        source: mcp ? 'mcp' : 'builtin',
        server: mcp ? mcpSlugOf(tool.name) : undefined,
        category: toolCategory(tool.name),
      }
    })
    if (!this.deps.toolSearch || cfg.toolSearchMode === 'off' || entries.length === 0) {
      return { enabled: false, entries }
    }
    if (cfg.toolSearchMode === 'on') return { enabled: true, entries }
    // auto：可延迟数达量级阈值，或延迟 schema token 达预算占比阈值 → 启用（critic 等小集合保持全量加载）
    if (entries.length >= cfg.toolSearchMin) return { enabled: true, entries }
    const schemaTokens = countTokensCalibrated(JSON.stringify(this.deps.tools.toSchema(deferred)))
    return { enabled: schemaTokens >= (cfg.contextBudgetTokens * cfg.toolSearchTokenPct) / 100, entries }
  }

  /** L3 发现区块（仅列未激活条目；未启用 / 全部已激活 → undefined 不注入） */
  private discoveryBlockFor(record: RunRecord, discovery: DiscoveryState): string | undefined {
    if (!discovery.enabled) return undefined
    const hidden = discovery.entries.filter((entry) => !record.activatedTools.has(entry.name))
    const block = renderDiscoveryBlock(hidden)
    return block || undefined
  }

  /** M79-J（§8.8）：会话人类花名册（human_roster + 交还指令；无人类返回 undefined 不注入） */
  private humanRosterFor(sessionId: string): Array<{ displayName: string; username: string; headline?: string }> | undefined {
    const humans = this.deps.sessionHumans?.(sessionId) ?? []
    if (humans.length === 0) return undefined
    return humans.map((h) => ({
      displayName: h.displayName,
      username: h.username,
      ...(h.headline ? { headline: h.headline } : {}),
    }))
  }

  /** 延迟工具执行门：发现启用 + tier=deferred + 未激活 → 拒绝（引导先 tool_search）；null = 放行 */
  private discoveryGate(record: RunRecord, message: ChatMessage, call: LlmToolCall): ToolResult | null {
    const state = record.discoveryByAgent.get(message.memberKey ?? message.agentId!)
    if (!state?.enabled) return null
    if (this.deps.tools.get(call.name)?.tier !== 'deferred') return null
    if (record.activatedTools.has(call.name)) return null
    // M47：不在本回合可发现范围内（环境未启用被过滤 / MCP 未绑定）→ 交由执行层给出精确原因，不给无效检索引导
    if (!state.entries.some((entry) => entry.name === call.name)) return null
    return {
      ok: false,
      summary: `工具 ${call.name} 未加载：该能力默认按需提供。请先调用 tool_search（query 描述你要做的事）检索激活后再调用。`,
    }
  }

  /** 空命中回灌：可用类别概览（防死路） */
  private discoveryNoHitNote(entries: ToolSearchEntry[]): string {
    const groups = new Map<string, number>()
    for (const entry of entries) {
      const label = groupOf(entry)
      groups.set(label, (groups.get(label) ?? 0) + 1)
    }
    const overview = [...groups.entries()].map(([label, count]) => `${label}（${count} 个）`).join('、')
    return `没有检索到匹配的工具。当前按需可用的能力：${overview || '（无）'}。请换用更宽泛或更常见的关键词（中英文均可）重试。`
  }

  /** load_skill 未命中回灌：top-3 相近候选；无候选时兜底全量技能名 */
  private skillCandidates(query: string): string {
    const all = this.deps.skills.list()
    if (all.length === 0) return '当前没有任何可用技能。'
    const entries = all.map((skill): ToolSearchEntry => ({
      name: skill.name,
      description: skill.description,
      source: 'builtin',
      category: '',
    }))
    const scores = lexicalScores(query, entries)
    const top = entries
      .map((entry, index) => ({ name: entry.name, score: scores[index] }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, 3)
      .map((item) => item.name)
    const names = all.map((skill) => skill.name).join('、')
    return top.length === 0 ? `可用技能：${names}` : `最相近的技能：${top.join('、')}。可用技能：${names}`
  }

  /** M5：单工具执行（thinking → 审批门 → execWithAbort（超时/取消护栏）→ 指标计时 → tool:result 事件） */
  private async runToolCall(
    record: RunRecord,
    message: ChatMessage,
    call: LlmToolCall,
    entry: ToolCallRecord,
    runtime: ToolRuntime,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    // M3：工具执行期间 Agent 处于 thinking（前端状态点）
    this.publishStatus(record, message.memberKey ?? message.agentId!, 'thinking', 'tool')
    // M7：回合信号写入 runtime（审批挂起时随 stop 取消）
    runtime.turnSignal = signal
    // M7：高危工具强制审批（APPROVAL_MODE=risky|all）→ 未通过不执行，回灌可修正反馈
    const gate = this.approvalGate(message, call, runtime)
    if (gate) {
      const denied = await this.approvalGateWait(record, message, call, entry, gate, signal)
      if (denied) return denied
    }
    const started = Date.now()
    let result: ToolResult
    // M28：延迟工具执行门 —— 「发现启用 + tier=deferred + 未激活」直接拒绝并引导先检索（不执行副作用）
    const denial = this.discoveryGate(record, message, call)
    if (denial) {
      result = denial
    } else {
      try {
        // M7：request_approval 需要等待用户（可达 APPROVAL_TIMEOUT_MS），放宽工具级超时
        // M24：write_plan 等待计划审批（默认无限等待 → 放开护栏，由回合信号控制生命周期）
        const timeoutMs =
          call.name === 'request_approval'
            ? this.deps.cfg.approvalTimeoutMs + 5_000
            : call.name === 'write_plan'
              ? this.planWaitToolTimeoutMs()
              : undefined
        result = await this.deps.tools.execWithAbort(call.name, entry.args, runtime, signal, timeoutMs)
      } catch (err) {
        const durationMs = Date.now() - started
        // M47：中断（用户停止 / 回合超时）不是工具失败 —— 不写失败指标，仅轨迹留痕
        if (isToolAbortError(err) || signal.aborted) {
          this.trace(record, 'tool', {
            name: call.name,
            ok: false,
            aborted: true,
            durationMs,
            summary: '运行已中断（未计入失败）',
          })
        } else {
          this.recordToolMetric(record, message.agentId!, call.name, false, durationMs)
          this.trace(record, 'tool', {
            name: call.name,
            ok: false,
            durationMs,
            summary: err instanceof Error ? err.message : String(err),
          })
        }
        throw err
      }
    }
    const durationMs = Date.now() - started
    this.recordToolMetric(record, message.agentId!, call.name, result.ok, durationMs)
    this.trace(record, 'tool', {
      name: call.name,
      ok: result.ok,
      durationMs,
      summary: result.summary?.slice(0, 160),
    })
    // M61-D3/D5：成功写动作 → 波内写跟踪（提取失败静默返回空集，绝不影响主流程）
    if (result.ok && message.agentId) {
      recordWrite(record.waveWrites, message.agentId, extractWritePaths(call.name, entry.args))
    }
    // M25：remember 成功 → 嵌入排队（worker 异步消费，失败静默不影响工具结果）
    if (call.name === 'remember' && result.ok) this.trace(record, 'memory:embed', { queued: true })
    this.publishStatus(record, message.memberKey ?? message.agentId!, 'speaking', 'tool-done')
    entry.status = result.ok ? 'ok' : 'error'
    entry.summary = result.summary
    // M31 修订：结构化元信息随工具记录持久化（消息侧「在画布查看」等精确定位依据）
    if (result.meta) entry.meta = result.meta
    entry.endedAt = new Date().toISOString()
    this.deps.sessions.touch(record.sessionId, message.id)
    this.emit(record, { type: 'tool:result', messageId: message.id, call: { ...entry } })
    return result
  }

  /**
   * M7：高风险工具审批门返回值：非 null = 需要用户批准。
   * APPROVAL_MODE=off 关闭；all 全部工具；risky（ 默认）覆盖：
   * APPROVAL_TOOLS 显式列表 + git_commit / git_restore / run_command + write_file 覆盖写已有文件 + 敏感文件（ALLOW_SENSITIVE 已放开时）。
   */
  private approvalGate(
    message: ChatMessage,
    call: LlmToolCall,
    runtime: ToolRuntime,
  ): { action: string; detail: string; options?: string[] } | null {
    const { cfg } = this.deps
    if (cfg.approvalMode === 'off') return null
    if (call.name === 'request_approval') return null // 审批工具自身即协议入口，不重复拦截
    const args = parseToolArgs(call.arguments)
    const agentName = message.memberKey
      ? this.memberLabelOf(message.sessionId, message.memberKey)
      : (this.deps.prompts.get(message.agentId ?? '')?.name ?? message.agentId ?? 'Agent')
    const argsJson = JSON.stringify(args)
    const argsBrief = argsJson.length > 1200 ? `${argsJson.slice(0, 1200)}…` : argsJson
    const generic = {
      action: `${agentName}请求执行 ${call.name}`,
      detail: `工具：${call.name}\n参数：\n${argsBrief}`,
    }
    if (cfg.approvalTools.includes(call.name)) return generic
    // M27：MCP 工具按服务器审批策略（默认 risky：写类工具拦截；never 显式豁免；always 全部拦截）
    const mcpInfo = this.deps.mcp?.approvalInfoFor(call.name)
    if (mcpInfo) {
      if (mcpInfo.policy === 'never') return null
      if (mcpInfo.policy === 'always' || !this.deps.tools.isReadOnly(call.name)) {
        return {
          action: `${agentName}请求调用 MCP 工具（${mcpInfo.slug}）`,
          detail: `工具：${call.name}\n服务器：${mcpInfo.slug}\n参数：\n${argsBrief}`,
        }
      }
    }
    if (cfg.approvalMode === 'all') return generic
    // risky（默认）：内置高危
    if (call.name === 'git_commit') {
      return {
        action: `${agentName}请求提交 git 变更`,
        detail: `提交信息：${String(args.message ?? '（未提供）')}\n工作区：${runtime.workspace}`,
      }
    }
    // git_restore：丢弃未提交改动不可逆，与 git_commit 同级拦截（staged=true 仅撤回暂存，风险较低仍统一拦截）
    if (call.name === 'git_restore') {
      return {
        action: `${agentName}请求还原文件（丢弃未提交改动）`,
        detail: `文件：${String(args.path ?? '（未提供）')}\n方式：${
          args.staged === true
            ? '仅撤回暂存（保留工作区改动）'
            : '丢弃工作区改动（不可逆，请确认此改动已无用）'
        }`,
      }
    }
    if (call.name === 'run_command') {
      return { action: `${agentName}请求执行命令`, detail: `命令：\n${String(args.command ?? '（未提供）')}` }
    }
    // M22：数据库写操作（最高危：数据不可逆修改）
    if (call.name === 'db_execute') {
      return {
        action: `${agentName}请求执行数据库写操作`,
        detail: `连接：${String(args.connection ?? '（未提供）')}\nSQL：\n${String(args.sql ?? '（未提供）').slice(0, 800)}`,
      }
    }
    // M23：SSH 远程命令（最高危：任意远程执行）
    if (call.name === 'ssh_exec') {
      return {
        action: `${agentName}请求在远程主机执行命令`,
        detail: `连接：${String(args.connection ?? '（未提供）')}\n命令：\n${String(args.command ?? '（未提供）').slice(0, 800)}`,
      }
    }
    // M22：浏览器页面执行 JS（高权限：可读写页面数据）
    if (call.name === 'browser_eval') {
      return {
        action: `${agentName}请求在浏览器页面执行 JS`,
        detail: `表达式：\n${String(args.expression ?? '（未提供）').slice(0, 800)}`,
      }
    }
    const pathArg = typeof args.path === 'string' && args.path ? args.path : undefined
    if (!pathArg) return null
    const rel = normalizeRel(pathArg)
    const pattern = matchedSensitivePattern(rel)
    // 敏感文件：默认由工具层直接拒绝（提示配置 ALLOW_SENSITIVE）；已放开时每次访问仍需批准
    if (pattern && cfg.allowSensitive) {
      return {
        action: `${agentName}请求访问敏感文件`,
        detail: `文件：${rel}\n命中规则：${pattern}\nALLOW_SENSITIVE 已开启，但敏感文件访问仍需逐次批准。`,
      }
    }
    if (call.name === 'write_file') {
      const full = path.resolve(runtime.workspace, rel)
      const inWorkspace = full === runtime.workspace || full.startsWith(runtime.workspace + path.sep)
      if (inWorkspace && fs.existsSync(full)) {
        return {
          action: `${agentName}请求覆盖已有文件`,
          detail: `文件：${rel}\n已有内容将被整体替换（如需小改建议用 apply_patch / edit_file）。`,
        }
      }
    }
    return null
  }

  /**
   * M7：执行审批门等待。返回非 null = 未通过（已标记 entry / 指标 / 事件），直接作为工具结果回灌模型；
   * 通过（approve / custom）返回 null，继续真实执行工具。
   */
  private async approvalGateWait(
    record: RunRecord,
    message: ChatMessage,
    call: LlmToolCall,
    entry: ToolCallRecord,
    gate: { action: string; detail: string; options?: string[] },
    signal: AbortSignal,
  ): Promise<ToolResult | null> {
    const outcome = await this.requestApproval(
      record,
      message,
      gate.action,
      gate.detail,
      gate.options,
      signal,
    )
    if (outcome.decision === 'approve' || outcome.decision === 'custom') return null
    const summary = outcome.cancelled
      ? '审批取消（运行已停止）'
      : outcome.timedOut
        ? '审批超时（用户未响应）'
        : '审批被拒绝'
    const detail = outcome.cancelled
      ? '运行已被停止，本次操作未执行。'
      : outcome.timedOut
        ? '用户未在时限内响应，视为拒绝。请改换无争议的方案继续，或在本轮结束时交还用户确认。'
        : `用户拒绝「${gate.action}」${outcome.feedback ? `：${outcome.feedback}` : '（未给出原因）'}。请根据反馈调整方案，不要重试同样的动作。`
    // M47：运行停止导致的审批取消归入「已停止」（非工具失败）；拒绝 / 超时仍记为失败（负向业务结果）
    entry.status = outcome.cancelled ? 'stopped' : 'error'
    entry.summary = summary
    entry.endedAt = new Date().toISOString()
    this.deps.sessions.touch(record.sessionId, message.id)
    this.emit(record, { type: 'tool:result', messageId: message.id, call: { ...entry } })
    this.publishStatus(record, message.memberKey ?? message.agentId!, 'speaking', 'approval-denied')
    if (!outcome.cancelled) this.recordToolMetric(record, message.agentId!, call.name, false, 0)
    return { ok: false, summary, detail }
  }

  /**
   * M7：发起审批（SSE + WS 广播；Run 落盘 awaiting_approval）并挂起等待。
   * 决定后恢复 running；signal 中止（用户停止）→ 审批取消（以拒绝收敛，工具立即返回）。
   */
  private async requestApproval(
    record: RunRecord,
    message: ChatMessage,
    action: string,
    detail: string,
    options: string[] | undefined,
    signal?: AbortSignal,
  ): Promise<ApprovalOutcome> {
    const approval = this.deps.approvals.create({
      runId: record.id,
      sessionId: record.sessionId,
      agentId: message.agentId,
      action,
      detail,
      options,
    })
    record.state = 'awaiting_approval'
    this.deps.runs.update(record.id, { state: 'awaiting_approval' })
    // M79-AF：审批 SSE 定向（触发者 ∪ 属主；视图与操作口径一致）
    this.emitApproval(record, { type: 'approval:requested', approval })
    // M79-AD：审批仅推送给触发者（避免会话其他真人被他人发起的审批打断/误批）
    this.publishApprovalFrame(record, 'notify:approval-requested', { approval })
    try {
      const outcome = await this.deps.approvals.wait(approval.id, signal)
      this.emitApproval(record, { type: 'approval:resolved', approval: outcome.approval })
      this.publishApprovalFrame(record, 'notify:approval-resolved', { approval: outcome.approval })
      return outcome
    } finally {
      if (record.state === 'awaiting_approval') {
        record.state = 'running'
        this.deps.runs.update(record.id, { state: 'running' })
      }
    }
  }

  /**
   * M24：计划提交（write_plan 工具通道）—— 创建 / 修订计划 → 登记挂起 → 广播 → 等待用户决定。
   * 结论回灌工具（批准 / 驳回+反馈 / 取消 / 被并行计划取代）；finally 恢复 Run 状态。
   */
  private async submitPlan(
    record: RunRecord,
    message: ChatMessage,
    input: PlanSubmitInput,
    signal?: AbortSignal,
  ): Promise<PlanSubmitOutcome> {
    const { plans, planReviews } = this.deps
    if (!plans || !planReviews) throw new Error('计划通道未启用')
    // M77：计划作者/步骤归属用成员键（分身实例；经典 = agentId）
    const agentId = message.memberKey ?? message.agentId!
    record.planSubmissions++
    // 修订路径：本 Run 内作者被驳回 → 同 id 版本递增重提（v2 现场修订）
    const rejected = plans.latestRejected(record.id, agentId)
    let plan = rejected
      ? plans.revise(rejected.id, {
          goal: input.goal,
          title: input.title,
          steps: input.steps,
          risks: input.risks,
        })
      : undefined
    if (!plan) {
      // 重规划：本 Run 中作者已有 approved / executing 计划 → 旧版 supersede（新版重新挂起）
      for (const planId of [...record.activePlanIds]) {
        const existing = plans.get(planId)
        if (
          existing &&
          existing.agentId === agentId &&
          (existing.status === 'approved' || existing.status === 'executing')
        ) {
          record.activePlanIds.delete(planId)
          const superseded = plans.setStatus(planId, 'superseded')
          if (superseded) this.emitPlanUpdated(record, superseded)
        }
      }
      plan = plans.create({
        sessionId: record.sessionId,
        runId: record.id,
        agentId,
        title: input.title,
        goal: input.goal,
        steps: input.steps,
        risks: input.risks,
      })
    }
    record.activePlanIds.add(plan.id)
    record.pendingPlanIds.add(plan.id)
    planReviews.create(plan)
    record.state = 'awaiting_plan'
    this.deps.runs.update(record.id, { state: 'awaiting_plan' })
    this.emit(record, { type: 'plan:submitted', plan })
    this.deps.notify.publish({
      type: 'notify:plan-submitted',
      sessionId: record.sessionId,
      runId: record.id,
      payload: { plan },
    })
    this.trace(record, 'plan:submitted', {
      planId: plan.id,
      title: plan.title,
      version: plan.version,
      steps: plan.steps.length,
    })
    try {
      const outcome = await planReviews.wait(plan.id, signal)
      return {
        decision: outcome.decision,
        plan: plans.get(plan.id) ?? plan,
        feedback: outcome.feedback,
        cancelled: outcome.cancelled,
        superseded: outcome.superseded,
      }
    } finally {
      record.pendingPlanIds.delete(plan.id)
      if (record.state === 'awaiting_plan') {
        record.state = 'running'
        this.deps.runs.update(record.id, { state: 'running' })
      }
    }
  }

  /**
   * M24：本成员本波范式 —— 派发步骤含 review（仅本人负责）→ review；首波用起步范式；其后 execute。
   * M48：平台路由步不占波次 —— 首波恒为业务首棒，起步范式（planFirst / 消息级）自然生效。
   */
  private turnModeOf(record: RunRecord, agentId: string, waveIndex: number): TurnMode {
    if (this.planStepsFor(record, agentId).some((s) => s.ownerAgentId === agentId && s.mode === 'review')) {
      return 'review'
    }
    return waveIndex === 0 ? record.mode : 'execute'
  }

  /** M24：本回合可操作的计划步骤（工具授权：步骤负责人或计划作者；指令注入侧再按 ownerAgentId 过滤） */
  private planStepsFor(
    record: RunRecord,
    agentId: string,
  ): Array<{
    planId: string
    stepId: string
    content: string
    ownerAgentId: string
    mode?: 'execute' | 'review'
    acceptance?: string
    expectedOutput?: string
  }> {
    const { plans } = this.deps
    if (!plans || record.activePlanIds.size === 0) return []
    const out: Array<{
      planId: string
      stepId: string
      content: string
      ownerAgentId: string
      mode?: 'execute' | 'review'
      acceptance?: string
      expectedOutput?: string
    }> = []
    for (const planId of record.activePlanIds) {
      const plan = plans.get(planId)
      if (!plan || (plan.status !== 'executing' && plan.status !== 'approved')) continue
      const isAuthor = plan.agentId === agentId
      for (const step of plan.steps) {
        if (step.status === 'done' || step.status === 'skipped') continue
        const owner = step.ownerAgentId ?? plan.agentId
        if (owner !== agentId && !isAuthor) continue
        out.push({
          planId: plan.id,
          stepId: step.id,
          content: step.content,
          ownerAgentId: owner,
          mode: step.mode,
          acceptance: step.acceptance,
          expectedOutput: step.expectedOutput,
        })
      }
    }
    return out
  }

  /** M24：评审目标构造 —— 评审型步骤 → 其所属计划（plan:<id> 寻址；同一计划去重） */
  private reviewTargetsFor(
    steps: Array<{ planId: string; mode?: 'execute' | 'review' }>,
  ): Array<{ target: string; content?: string }> {
    const seen = new Set<string>()
    const out: Array<{ target: string; content?: string }> = []
    for (const step of steps) {
      if (step.mode !== 'review' || seen.has(step.planId)) continue
      seen.add(step.planId)
      const plan = this.deps.plans?.get(step.planId)
      out.push({
        target: `plan:${step.planId}`,
        content: plan ? `${plan.title}｜核对全部步骤产出与验收` : undefined,
      })
    }
    return out
  }

  /** M24：per-agent 任务清单（§29 并发互踩修复：波内并行成员各持独立数组，互不覆盖） */
  private todosFor(record: RunRecord, agentId: string): TodoItem[] {
    let list = record.todosByAgent.get(agentId)
    if (!list) {
      list = []
      record.todosByAgent.set(agentId, list)
    }
    return list
  }

  /** M24：波启动 —— 本波成员命中的 pending 步骤置 in_progress 并广播（任务面板实时反映） */
  private markWaveStepsInProgress(record: RunRecord, members: string[]): void {
    const { plans } = this.deps
    if (!plans || record.planDispatch.size === 0) return
    const touched = new Set<string>()
    for (const member of members) {
      for (const stepId of record.planDispatch.get(member) ?? []) {
        const hit = plans.findByStepId(record.sessionId, stepId)
        if (!hit || hit.step.status !== 'pending') continue
        if (plans.setStepStatus(hit.plan.id, stepId, 'in_progress')) touched.add(hit.plan.id)
      }
    }
    for (const planId of touched) {
      const plan = plans.get(planId)
      if (plan) this.emitPlanUpdated(record, plan)
    }
  }

  /** M24：波末派发 —— 已批准计划：登记 planDispatch（plan→executing）并按步骤序前置并入队列 */
  private dispatchApprovedPlans(record: RunRecord, waveIndex: number): void {
    const { plans } = this.deps
    if (!plans) return
    for (const planId of [...record.activePlanIds]) {
      const plan = plans.get(planId)
      if (!plan) {
        record.activePlanIds.delete(planId)
        continue
      }
      if (plan.status !== 'approved') continue
      this.registerPlanDispatch(record, plan)
      // 步骤负责人按步骤序排在队首（与既有队列合并去重；先执行计划步骤，再回到常规接力）
      const owners = this.planOwnerQueue(plan)
      record.queue = [...owners, ...record.queue.filter((id) => !owners.includes(id))]
      // 批准意味着继续执行：清除「已交还用户」标记（避免收尾误发 awaiting-user 通知）
      record.handedToUser = false
      this.trace(record, 'plan:dispatched', { planId: plan.id, owners }, waveIndex)
    }
  }

  /** M24：登记派发（planDispatch + plan→executing）并广播（波末派发 / 稍后批准共用） */
  private registerPlanDispatch(record: RunRecord, plan: Plan): void {
    const { plans } = this.deps
    if (!plans) return
    for (const step of plan.steps) {
      const owner = step.ownerAgentId ?? plan.agentId
      const list = record.planDispatch.get(owner) ?? []
      if (!list.includes(step.id)) list.push(step.id)
      record.planDispatch.set(owner, list)
    }
    record.activePlanIds.add(plan.id)
    record.pendingPlanIds.delete(plan.id)
    const executing = plans.setStatus(plan.id, 'executing') ?? plans.get(plan.id)
    if (executing) this.emitPlanUpdated(record, executing)
  }

  /** M24：计划执行队列（步骤负责人按步骤序去重；已完成 / 跳过步骤剔除） */
  private planOwnerQueue(plan: Plan): string[] {
    const out: string[] = []
    for (const step of plan.steps) {
      if (step.status === 'done' || step.status === 'skipped') continue
      const owner = step.ownerAgentId ?? plan.agentId
      if (!out.includes(owner)) out.push(owner)
    }
    return out
  }

  /** M24：收口波 —— 计划全步完成（plan=done）→ 追加作者收口回合（每 Run 一次，作者已在队列则跳过） */
  private maybeAppendSynthesisWave(record: RunRecord, waveIndex: number): void {
    const { plans } = this.deps
    if (!plans || record.synthesisAdded) return
    for (const planId of [...record.activePlanIds]) {
      const plan = plans.get(planId)
      if (!plan) {
        record.activePlanIds.delete(planId)
        continue
      }
      if (plan.status !== 'done') continue
      record.activePlanIds.delete(planId)
      record.synthesisAdded = true
      if (!record.queue.includes(plan.agentId)) record.queue.push(plan.agentId)
      this.trace(record, 'plan:done', { planId: plan.id, synthesisAgent: plan.agentId }, waveIndex)
      break
    }
  }

  /**
   * M24：计划执行保障 —— 队列为空但仍有未完成步骤时，把剩余步骤负责人补回队列。
   * 语义：批准即授权引擎执行完整个计划，成员常规交还不能提前终止（用户可随时 stop）。
   */
  private refillPlanQueue(record: RunRecord): void {
    const { plans } = this.deps
    if (!plans || record.activePlanIds.size === 0 || record.queue.length > 0) return
    const owners: string[] = []
    for (const planId of record.activePlanIds) {
      const plan = plans.get(planId)
      if (!plan || (plan.status !== 'executing' && plan.status !== 'approved')) continue
      for (const step of plan.steps) {
        if (step.status === 'done' || step.status === 'skipped') continue
        const owner = step.ownerAgentId ?? plan.agentId
        if (!owners.includes(owner)) owners.push(owner)
      }
    }
    if (owners.length === 0) return
    record.queue.push(...owners)
    // 继续执行：清除交还标记（避免收尾误发 awaiting-user 通知）
    record.handedToUser = false
  }

  /** M24：规划波协议违规 —— 未提交任何计划：落 system 事件条 + trace（按既有规则继续收敛） */
  private notePlanProtocolViolation(
    record: RunRecord,
    waveMode: TurnMode,
    submissionsBefore: number,
    waveIndex: number,
  ): void {
    if (waveMode !== 'plan' || record.planSubmissions > submissionsBefore) return
    const content = '本轮为规划范式，但未提交任何计划（应调用 write_plan）。已按常规协作规则继续。'
    const message = this.deps.sessions.appendMessage({
      sessionId: record.sessionId,
      runId: record.id,
      turnIndex: waveIndex,
      role: 'system',
      content,
      mentions: [],
      status: 'complete',
    })
    this.trace(record, 'plan:protocol-violation', { messageId: message.id }, waveIndex)
    // 同会话即时插入事件条（payload.message 由前端 upsert；复用 notify:plan-updated 通道）
    this.deps.notify.publish({
      type: 'notify:plan-updated',
      sessionId: record.sessionId,
      runId: record.id,
      payload: { message },
    })
  }

  /** M24：计划变更广播（SSE + WS 双通道） */
  private emitPlanUpdated(record: RunRecord, plan: Plan): void {
    this.emit(record, { type: 'plan:updated', plan })
    this.deps.notify.publish({
      type: 'notify:plan-updated',
      sessionId: record.sessionId,
      runId: record.id,
      payload: { plan },
    })
  }

  /** M24：write_plan 工具级超时 —— 覆盖计划审批时长（默认无限等待 → 放开护栏） */
  private planWaitToolTimeoutMs(): number {
    const t = this.deps.cfg.planReviewTimeoutMs
    return t > 0 ? t + 5_000 : 2_147_483_647
  }

  /** M5：工具指标落库（指标失败不得影响运行主流程） */
  private recordToolMetric(
    record: RunRecord,
    agentId: string,
    toolName: string,
    ok: boolean,
    durationMs: number,
  ): void {
    try {
      this.deps.metrics.record({ toolName, ok, durationMs, agentId, sessionId: record.sessionId })
    } catch {
      // 忽略：观测数据缺失不影响协作
    }
  }

  /** 工具结果应用（M5）：handoff / 任务 / 交付件副作用 + 工具消息回灌（按调用顺序） */
  private applyToolResult(
    record: RunRecord,
    message: ChatMessage,
    call: LlmToolCall,
    result: ToolResult,
    toolMessages: LlmMessageInput[],
  ): void {
    const { sessions, cfg } = this.deps
    // M16：handoff（无副作用工具）→ 按消息分组收集（多目标 = fan-out 并行意图），波末由 mergeWaveSchedule 消费
    if (result.handoff) {
      // M24：条目化（来源 + 目标 + 原因 + expected_output；来源 id 在注入接收方指令时转为姓名）
      const list = record.pendingHandoffs.get(message.id) ?? []
      list.push({
        from: message.agentId ?? 'unknown',
        targets: [...result.handoff.targets],
        reason: result.handoff.reason,
        expectedOutput: result.handoff.expected_output,
      })
      record.pendingHandoffs.set(message.id, list)
    }
    // M3：任务清单更新广播（SSE + WS 双通道）
    if (result.tasks) {
      this.emit(record, { type: 'task:updated', tasks: result.tasks })
      this.deps.notify.publish({
        type: 'notify:task-updated',
        sessionId: record.sessionId,
        runId: record.id,
        payload: { tasks: result.tasks },
      })
    }

    // M24：计划变更（write_plan 结论 / update_plan_step 进度）→ SSE + WS 双通道
    if (result.plan) this.emitPlanUpdated(record, result.plan)
    // M24：评审判定（submit_review）→ 广播；fail 命中步骤 / 计划的阻塞后果已由工具落库
    if (result.review) {
      this.emit(record, { type: 'review:submitted', review: result.review })
      this.deps.notify.publish({
        type: 'notify:plan-updated',
        sessionId: record.sessionId,
        runId: record.id,
        payload: { review: result.review },
      })
    }

    // 交付件联动：消息 artifacts + artifact:updated（SSE / WS 双通道，§22.4）
    if (result.artifacts?.length) {
      const list = message.artifacts ?? []
      for (const artifactPath of result.artifacts) {
        if (!list.includes(artifactPath)) list.push(artifactPath)
        this.recordArtifactVersion(record, message, artifactPath)
        this.emit(record, {
          type: 'artifact:updated',
          path: artifactPath,
          authorAgentId: message.agentId,
        })
        this.deps.notify.publish({
          type: 'notify:artifact-updated',
          sessionId: record.sessionId,
          runId: record.id,
          payload: { path: artifactPath, authorAgentId: message.agentId },
        })
      }
      message.artifacts = list
      sessions.touch(record.sessionId, message.id)
    }

    // 回灌（参数校验失败 / 执行失败 → 错误摘要让模型自我修正，§21.2）
    // M2：工具结果按 TOOL_RESULT_MAX_TOKENS 截断，附「offset 续读」提示
    // M7：失败也优先回灌 detail（审批拒绝等场景的完整可修正反馈在 detail）
    const raw = result.ok
      ? (result.detail ?? result.summary)
      : (result.detail ?? `工具执行失败：${result.summary}`)
    const clipped = truncateToTokens(
      raw,
      cfg.toolResultMaxTokens,
      '（结果超长已截断：若为文件内容，请用 read_file 的 offset 参数继续读取）',
    )
    toolMessages.push({
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      content: clipped.text,
    })
  }

  /** M8：交付件版本记录（读磁盘现值入 artifact_versions；失败不影响主流程） */
  private recordArtifactVersion(record: RunRecord, message: ChatMessage, relPath: string): void {
    const versions = this.deps.versions
    if (!versions) return
    try {
      const read = this.deps.artifacts.read(record.sessionId, relPath, MAX_VERSION_CONTENT_BYTES)
      versions.record({
        sessionId: record.sessionId,
        path: relPath,
        content: read.content,
        size: read.size,
        authorAgentId: message.agentId,
        messageId: message.id,
      })
    } catch {
      // 版本记录失败（二进制 / 已删除 / 超限）：观测数据缺失不影响协作
    }
  }

  /** M3：Agent 状态通知（thinking / speaking / done；供前端顶栏状态点） */
  private publishStatus(
    record: RunRecord,
    agentId: string,
    status: 'thinking' | 'speaking' | 'done',
    phase?: string,
  ): void {
    this.deps.notify.publish({
      type: 'notify:agent-status',
      sessionId: record.sessionId,
      runId: record.id,
      payload: { agentId, status, ...(phase ? { phase } : {}) },
    })
  }

  /** M9：运行轨迹打点（观测失败不影响主流程） */
  private trace(
    record: RunRecord,
    type: string,
    payload: Record<string, unknown> = {},
    turnIndex?: number,
  ): void {
    if (!this.deps.events) return
    try {
      this.deps.events.record({
        runId: record.id,
        sessionId: record.sessionId,
        turnIndex: turnIndex ?? record.turnIndex,
        type,
        payload,
        // M57：用户归因（会话属主；单用户兼容模式缺省）
        userId: this.deps.sessions.getSession(record.sessionId)?.ownerId,
      })
    } catch {
      // 观测失败不影响主流程
    }
  }

  /**
   * M55（§77 / ADR 0125）：回合收尾净化 —— 剥离模型正文中仿写的 `[工具调用]` 日志块与协议
   * 标记泄漏（展示 / 落库 / 后续上下文统一干净），并审计「完成态落盘声明」与真实成功写调用的
   * 偏差（trace 留痕，不阻断、不改正文）。幂等；须在 mentions 解析与共享消费（落库 / 记忆
   * 沉淀 / 下一回合装配）之前调用。
   */
  private sanitizeAndAudit(record: RunRecord, message: ChatMessage): void {
    const before = message.content
    const cleaned = sanitizeModelText(before)
    if (cleaned !== before) {
      message.content = cleaned
      this.deps.sessions.touch(record.sessionId, message.id)
      this.trace(record, 'content:sanitized', {
        messageId: message.id,
        beforeChars: before.length,
        afterChars: cleaned.length,
      })
    }
    const claimed = extractDeliveredPaths(message.content)
    if (claimed.length === 0) return
    const delivered = new Set<string>()
    for (const call of message.toolCalls ?? []) {
      if (call.status !== 'ok') continue
      const args = call.args as Record<string, unknown> | undefined
      for (const key of ['path', 'output']) {
        const value = args?.[key]
        if (typeof value === 'string' && value) delivered.add(value)
      }
    }
    const unverified = claimed.filter((file) => !delivered.has(file))
    if (unverified.length > 0) {
      this.trace(record, 'delivery:unverified', { messageId: message.id, files: unverified })
      getLogger().warn(
        { runId: record.id, messageId: message.id, files: unverified },
        '正文存在未验证的落盘声明（无对应成功写调用）',
      )
    }
  }

  /** M4：压缩事件统一发布（SSE + 通知双通道；回合内与强制压缩重试共用） */
  private publishCompression(record: RunRecord, compression: NonNullable<PreparedTurn['compression']>): void {
    this.emit(record, {
      type: 'context:compressed',
      sessionId: record.sessionId,
      untilSeq: compression.untilSeq,
      beforeTokens: compression.beforeTokens,
      afterTokens: compression.afterTokens,
      degraded: compression.degraded,
    })
    this.trace(record, 'compression', {
      untilSeq: compression.untilSeq,
      beforeTokens: compression.beforeTokens,
      afterTokens: compression.afterTokens,
      degraded: compression.degraded,
    })
    this.deps.notify.publish({
      type: 'notify:context-compressed',
      sessionId: record.sessionId,
      runId: record.id,
      payload: { ...compression },
    })
  }

  /** M4：回合用量落库（cost 按单价表估算）并流上广播 */
  private recordTurnUsage(
    record: RunRecord,
    agentId: string,
    model: string | undefined,
    usage: LlmUsage,
  ): void {
    const resolvedModel = model || this.deps.billingModelFor?.(record.sessionId) || this.deps.cfg.llmModel
    const costUsd = this.deps.usage.record({
      runId: record.id,
      sessionId: record.sessionId,
      agentId,
      model: resolvedModel,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      kind: 'turn',
      // M57：用户归因（会话属主）
      userId: this.deps.sessions.getSession(record.sessionId)?.ownerId,
    })
    const snapshot: UsageSnapshot = {
      runId: record.id,
      sessionId: record.sessionId,
      agentId,
      model: resolvedModel,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costUsd,
      kind: 'turn',
    }
    this.emit(record, { type: 'usage', usage: snapshot })
  }

  /** M4：续写循环（resumeMessage 的执行体；只续文本，不进工具/调度） */
  private async runResumeLoop(record: RunRecord, message: ChatMessage): Promise<void> {
    const { sessions, cfg, prompts } = this.deps
    const session = sessions.getSession(record.sessionId)!
    const agentId = message.memberKey ?? message.agentId!
    const agent = prompts.get(agentId)
    let reason: RunEndReason = 'completed'
    let errorMessage: string | undefined

    this.emit(record, { type: 'run:start', runId: record.id, sessionId: record.sessionId, queue: [] })
    this.trace(record, 'run:start', { resumeMessageId: message.id })
    this.deps.notify.publish({
      type: 'notify:run-started',
      sessionId: record.sessionId,
      runId: record.id,
      payload: { queue: [], turnCount: 0, resumeMessageId: message.id },
    })

    const turn = this.makeTurnSignal(record)
    const turnIndex = message.turnIndex ?? 0
    const startedAt = Date.now()
    let promptTokens = 0
    let completionTokens = 0
    try {
      record.activeMembers = [agentId]
      message.status = 'streaming'
      sessions.touch(record.sessionId, message.id)
      this.publishStatus(record, agentId, 'thinking', 'prepare')
      this.emit(record, {
        type: 'turn:start',
        runId: record.id,
        agentId: baseAgentId(agentId),
        memberKey: agentId,
        messageId: message.id,
        turnIndex: message.turnIndex ?? 0,
      })
      this.trace(record, 'turn:start', { agentId: baseAgentId(agentId), memberKey: agentId, messageId: message.id }, turnIndex)

      const prepared = await this.deps.context.prepareTurn({
        sessionId: record.sessionId,
        agentId,
        runId: record.id,
        // M79-J（§8.8）：人类花名册（human_roster + 交还指令；无人类不注入）
        humans: this.humanRosterFor(record.sessionId),
        queue: [],
        excludeMessageIds: [message.id],
        signal: turn.signal,
      })
      if (prepared.compression) this.publishCompression(record, prepared.compression)

      const request: ChatRequest = {
        system: prepared.system,
        messages: [
          ...prepared.messages,
          { role: 'assistant', content: message.content },
          {
            role: 'user',
            content:
              '（你上一条回复被中断了。请从中断处自然续写剩余内容：不要重复已经说过的部分，不要重新开头。）',
          },
        ],
        model: agent?.model,
        temperature: this.temperatureOf(agent),
        thinking: false,
        meta: {
          agentId,
          participantIds: session.participantIds,
          spokenAgentIds: [...record.spoken],
          stepIndex: message.turnIndex ?? 0,
          soul: prompts.soul(agentId, session.memberSouls?.[agentId])?.meta.id,
          memberLabels: this.memberLabelsOf(record.sessionId),
        },
      }

      let truncated = false
      let reportedSpeaking = false
      for await (const chunk of resilientStream((signal) => this.deps.provider.chatStream(request, signal), {
        maxAttempts: Math.max(1, cfg.llmMaxRetries),
        baseDelayMs: cfg.llmRetryBaseDelayMs,
        firstTokenTimeoutMs: cfg.firstTokenTimeoutMs,
        idleTimeoutMs: cfg.streamIdleTimeoutMs,
        parentSignal: turn.signal,
      })) {
        if (chunk.type === 'text') {
          if (!reportedSpeaking) {
            reportedSpeaking = true
            this.publishStatus(record, agentId, 'speaking')
          }
          message.content += chunk.text
          this.emit(record, { type: 'message:delta', messageId: message.id, delta: chunk.text })
          // M79-Z：旁观端流式（节流聚合广播；触发者走 SSE 去重）
          this.broadcastStreamDelta(record, message, chunk.text)
          sessions.touch(record.sessionId, message.id)
        } else if (chunk.type === 'usage') {
          promptTokens += chunk.usage.promptTokens
          completionTokens += chunk.usage.completionTokens
          this.recordTurnUsage(record, agentId, request.model, chunk.usage)
        } else if (chunk.type === 'truncated') {
          truncated = true
        }
      }

      // M55：续写收尾净化（幂等；先于落库与下一回合上下文装配）
      this.sanitizeAndAudit(record, message)
      // 输出截断治理：续写再次触顶 → 系统事件条提示（正文仍不完整）
      if (truncated) this.appendTruncationNotice(record, agentId, message)
      message.status = 'complete'
      sessions.touch(record.sessionId, message.id)
      this.emit(record, {
        type: 'turn:end',
        messageId: message.id,
        agentId: baseAgentId(agentId),
        memberKey: agentId,
        mentions: message.mentions ?? [],
        queue: [],
        status: 'complete',
      })
      this.trace(
        record,
        'turn:end',
        {
          agentId,
          messageId: message.id,
          status: 'complete',
          durationMs: Date.now() - startedAt,
          promptTokens,
          completionTokens,
        },
        turnIndex,
      )
      this.publishStatus(record, agentId, 'done')
    } catch (err) {
      const aborted = isAbortError(err) || turn.signal.aborted
      this.trace(
        record,
        'turn:end',
        {
          agentId,
          messageId: message.id,
          status: aborted ? (turn.reason() === 'timeout' ? 'timeout' : 'stopped') : 'error',
          durationMs: Date.now() - startedAt,
          promptTokens,
          completionTokens,
        },
        turnIndex,
      )
      // M55：中断 / 异常收尾净化（幂等兜底）
      this.sanitizeAndAudit(record, message)
      message.status = aborted ? 'stopped' : 'error'
      sessions.touch(record.sessionId, message.id)
      if (!aborted) {
        const text = err instanceof Error ? err.message : String(err)
        errorMessage = text
        reason = 'error'
        this.emit(record, { type: 'error', message: text })
      } else if (turn.reason() === 'timeout') {
        reason = 'error'
        errorMessage = '回合超时，已中断'
      } else {
        reason = 'stopped'
      }
    } finally {
      record.activeMembers = []
      turn.cleanup()
      // 审核 H-2：统一收尾（幂等 + 逐环节容错；saveNow / trace 失败不再中断 Run 清理）
      this.finishRun(record, reason, errorMessage, 1, false)
      if (this.sessionRuns.get(record.sessionId) === record.id) this.sessionRuns.delete(record.sessionId)
      this.runs.delete(record.id)
    }
  }

  /** M8：重生成循环（regenerateMessage 的执行体；仅文本，不进工具/调度） */
  private async runRegenerateLoop(record: RunRecord, message: ChatMessage): Promise<void> {
    const { sessions, cfg, prompts } = this.deps
    const session = sessions.getSession(record.sessionId)!
    const agentId = message.memberKey ?? message.agentId!
    const agent = prompts.get(agentId)
    let reason: RunEndReason = 'completed'
    let errorMessage: string | undefined

    this.emit(record, { type: 'run:start', runId: record.id, sessionId: record.sessionId, queue: [] })
    this.trace(record, 'run:start', { regenerateMessageId: message.id })
    this.deps.notify.publish({
      type: 'notify:run-started',
      sessionId: record.sessionId,
      runId: record.id,
      payload: { queue: [], turnCount: 0, regenerateMessageId: message.id },
    })

    const turn = this.makeTurnSignal(record)
    const turnIndex = message.turnIndex ?? 0
    const startedAt = Date.now()
    let promptTokens = 0
    let completionTokens = 0
    try {
      record.activeMembers = [agentId]
      this.publishStatus(record, agentId, 'thinking', 'prepare')
      this.emit(record, {
        type: 'turn:start',
        runId: record.id,
        agentId: baseAgentId(agentId),
        memberKey: agentId,
        messageId: message.id,
        turnIndex: message.turnIndex ?? 0,
      })
      this.trace(record, 'turn:start', { agentId: baseAgentId(agentId), memberKey: agentId, messageId: message.id }, turnIndex)

      const prepared = await this.deps.context.prepareTurn({
        sessionId: record.sessionId,
        agentId,
        runId: record.id,
        // M79-J（§8.8）：人类花名册（human_roster + 交还指令；无人类不注入）
        humans: this.humanRosterFor(record.sessionId),
        queue: [],
        excludeMessageIds: [message.id],
        signal: turn.signal,
      })
      if (prepared.compression) this.publishCompression(record, prepared.compression)

      const request: ChatRequest = {
        system: prepared.system,
        messages: prepared.messages,
        model: agent?.model,
        temperature: this.temperatureOf(agent),
        thinking: cfg.llmThinking,
        meta: {
          agentId,
          participantIds: session.participantIds,
          spokenAgentIds: [...record.spoken],
          stepIndex: message.turnIndex ?? 0,
          soul: prompts.soul(agentId, session.memberSouls?.[agentId])?.meta.id,
          memberLabels: this.memberLabelsOf(record.sessionId),
        },
      }

      let truncated = false
      let reportedSpeaking = false
      for await (const chunk of resilientStream((signal) => this.deps.provider.chatStream(request, signal), {
        maxAttempts: Math.max(1, cfg.llmMaxRetries),
        baseDelayMs: cfg.llmRetryBaseDelayMs,
        firstTokenTimeoutMs: cfg.firstTokenTimeoutMs,
        idleTimeoutMs: cfg.streamIdleTimeoutMs,
        parentSignal: turn.signal,
      })) {
        if (chunk.type === 'text') {
          if (!reportedSpeaking) {
            reportedSpeaking = true
            this.publishStatus(record, agentId, 'speaking')
          }
          message.content += chunk.text
          this.emit(record, { type: 'message:delta', messageId: message.id, delta: chunk.text })
          // M79-Z：旁观端流式（节流聚合广播；触发者走 SSE 去重）
          this.broadcastStreamDelta(record, message, chunk.text)
          sessions.touch(record.sessionId, message.id)
        } else if (chunk.type === 'reasoning') {
          message.reasoning = (message.reasoning ?? '') + chunk.text
          this.emit(record, { type: 'reasoning:delta', messageId: message.id, delta: chunk.text })
          sessions.touch(record.sessionId, message.id)
        } else if (chunk.type === 'usage') {
          promptTokens += chunk.usage.promptTokens
          completionTokens += chunk.usage.completionTokens
          this.recordTurnUsage(record, agentId, request.model, chunk.usage)
        } else if (chunk.type === 'truncated') {
          truncated = true
        }
      }

      // M55：重生成收尾净化（幂等；先于落库与下一回合上下文装配）
      this.sanitizeAndAudit(record, message)
      // 输出截断治理：重生成再次触顶 → 系统事件条提示
      if (truncated) this.appendTruncationNotice(record, agentId, message)
      message.status = 'complete'
      sessions.touch(record.sessionId, message.id)
      this.emit(record, {
        type: 'turn:end',
        messageId: message.id,
        agentId: baseAgentId(agentId),
        memberKey: agentId,
        mentions: [],
        queue: [],
        status: 'complete',
      })
      this.trace(
        record,
        'turn:end',
        {
          agentId,
          messageId: message.id,
          status: 'complete',
          durationMs: Date.now() - startedAt,
          promptTokens,
          completionTokens,
        },
        turnIndex,
      )
      this.publishStatus(record, agentId, 'done')
    } catch (err) {
      const aborted = isAbortError(err) || turn.signal.aborted
      this.trace(
        record,
        'turn:end',
        {
          agentId,
          messageId: message.id,
          status: aborted ? (turn.reason() === 'timeout' ? 'timeout' : 'stopped') : 'error',
          durationMs: Date.now() - startedAt,
          promptTokens,
          completionTokens,
        },
        turnIndex,
      )
      // M55：中断 / 异常收尾净化（幂等兜底）
      this.sanitizeAndAudit(record, message)
      message.status = aborted ? 'stopped' : 'error'
      sessions.touch(record.sessionId, message.id)
      if (!aborted) {
        const text = err instanceof Error ? err.message : String(err)
        errorMessage = text
        reason = 'error'
        this.emit(record, { type: 'error', message: text })
      } else if (turn.reason() === 'timeout') {
        reason = 'error'
        errorMessage = '回合超时，已中断'
      } else {
        reason = 'stopped'
      }
    } finally {
      record.activeMembers = []
      turn.cleanup()
      // 审核 H-2：统一收尾（幂等 + 逐环节容错；saveNow / trace 失败不再中断 Run 清理）
      this.finishRun(record, reason, errorMessage, 1, false)
      if (this.sessionRuns.get(record.sessionId) === record.id) this.sessionRuns.delete(record.sessionId)
      this.runs.delete(record.id)
    }
  }

  /** 回合信号：用户停止（stopped）与回合超时（timeout）统一走 AbortSignal */
  private makeTurnSignal(record: RunRecord): {
    signal: AbortSignal
    reason: () => 'stopped' | 'timeout' | undefined
    cleanup: () => void
  } {
    const controller = new AbortController()
    let reason: 'stopped' | 'timeout' | undefined
    const onParentAbort = (): void => {
      reason ??= 'stopped'
      controller.abort()
    }
    record.controller.signal.addEventListener('abort', onParentAbort, { once: true })
    // 竞态兜底：run 在进入本回合前已被停止（对已 abort 的 signal 注册监听不会补发历史事件）
    if (record.controller.signal.aborted) onParentAbort()
    const timer = setTimeout(() => {
      reason ??= 'timeout'
      controller.abort()
    }, this.deps.cfg.turnTimeoutMs)
    return {
      signal: controller.signal,
      reason: () => reason,
      cleanup: () => {
        clearTimeout(timer)
        record.controller.signal.removeEventListener('abort', onParentAbort)
      },
    }
  }
}
