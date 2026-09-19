/**
 * 工具注册表（§21.2 + M5）：AgentTool 抽象 + 参数校验 + 超时/中断护栏 + 幂等缓存。
 *
 * M5 升级：
 * - execWithAbort：超时 / 外部取消（回合停止）→ abort 工具内部 signal；
 *   工具必须尊重 ctx.signal（写入走「临时文件 → 检查 aborted → 原子 rename」）；
 * - readOnly 标记：只读工具可被引擎并行执行，并享受 (name, args) 维度 60s 幂等缓存；
 * - 写类工具成功后整体失效读缓存（防陈旧命中）。
 */
import type { z, ZodIssue } from 'zod'
import type { Plan, ReviewRecord, TaskItem, TurnMode } from '@multi-agent/shared'
import type { ApprovalOutcome } from '../approval.js'
import type { ArtifactStore } from '../store/artifacts.js'
import type { MemoryStore } from '../store/memory.js'
import type { MemoryService } from '../memory/service.js'
import type { PlanStore } from '../store/plans.js'
import type { ReviewStore } from '../store/reviews.js'
import type { SkillLibrary } from '../store/skills.js'
import type { TaskStore } from '../store/tasks.js'
import type { LlmToolSchema } from '../llm/provider.js'
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

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'done'
}

/** 工具执行上下文：由引擎按回合构建 */
export interface ToolRuntime {
  sessionId: string
  runId: string
  agentId: string
  /** 会话工作区绝对路径（workspace/<sessionId>） */
  workspace: string
  artifacts: ArtifactStore
  skills: SkillLibrary
  /** 会话长期记忆（remember 工具写入，L1 永不裁剪层） */
  memory: MemoryStore
  /** M25：向量记忆服务（remember 写入后 poke 加速嵌入；缺省 = 仅 L1 会话记忆行为） */
  memories?: MemoryService
  /** M25：本会话关联项目 id（project scope 记忆归属；缺省 = null，不可写 project scope） */
  projectId?: string
  /** 任务清单存储（write_todos 落库，跨 Run 继承） */
  tasks: TaskStore
  /** 在场成员（id + 显示名）：handoff 目标校验与错误回灌（M46：引擎注入惰性读取，同回合召集后即时可见） */
  participants: Array<{ id: string; name: string }>
  /** M48：全量资产解析（引擎注入）——handoff 目标资产存在但未在场时放行，由引擎自动召集后接手 */
  resolveAgent?: (token: string) => { id: string; name: string } | undefined
  /** 本 Run 任务清单（write_todos 写入，仅内存） */
  todos: TodoItem[]
  allowRunCommand: boolean
  /** run_command 白名单前缀（M5 配置化；为空时用内置默认表） */
  allowedCommands: string[]
  /** 敏感文件策略开关（SENSITIVE_PATTERNS 默认拒绝读写） */
  allowSensitive: boolean
  /** web_fetch 白名单域名（为空 = 禁用该工具） */
  webFetchAllowedDomains: string[]
  /** web_search 配置（enabled=false 时工具不可用；apiKey 非空 = 官方 API 模式） */
  webSearch: { enabled: boolean; apiKey: string; apiUrl: string; htmlUrl: string }
  /** 联网工具浏览器 UA 覆盖（空 = 内置 Chrome 桌面版） */
  httpUserAgent: string
  /** 联网工具同域名最小请求间隔（毫秒，反爬限速；0 = 不限速） */
  httpMinIntervalMs: number
  /** 联网工具单次请求超时（毫秒） */
  httpTimeoutMs: number
  /** M5：工具执行信号（execWithAbort 注入；超时/取消时 abort，工具内部需感知） */
  signal?: AbortSignal
  /** M7：本回合信号（引擎内部写入：审批等待随回合停止而取消；工具实现不应依赖） */
  turnSignal?: AbortSignal
  /** M7：审批通道（引擎注入；缺省 = 未启用审批，request_approval 返回错误提示） */
  requestApproval?(action: string, detail: string, options?: string[]): Promise<ApprovalOutcome>
  /** load_skill 实现（含同 Run 缓存），未知技能返回错误 */
  loadSkill(name: string): { ok: boolean; body?: string; error?: string; cached?: boolean }
  /** M28：工具按需发现（tool_search 实现；缺省 = 未装配发现服务，工具返回明确提示） */
  searchTools?(query: string, limit?: number): Promise<ToolSearchOutcome>
  /** M22：数据库连接管理器（db_* 工具；缺省 = 工具返回未启用提示） */
  db?: DbConnectionManager
  /** M23：SSH 连接管理器（ssh_exec 工具；缺省 = 工具返回未启用提示） */
  ssh?: SshConnectionManager
  /** M22：浏览器运行时（browser_* 工具；缺省 = 工具返回未启用提示） */
  browser?: BrowserRuntime
  /** M22：连接中心存储（会话绑定校验 / 可用连接清单） */
  connections?: ConnectionStore
  /** M27：MCP 运行时管理器（会话绑定校验 / 工具过滤 / 审批策略；缺省 = 未装配 MCP） */
  mcp?: McpRuntimeManager
  /** M31：画布文档存储（canvas_* 工具；缺省 = 工具返回未启用提示） */
  canvas?: CanvasStore
  /** M31：媒体生成服务（media_* 工具；缺省 = 工具返回未启用提示） */
  media?: MediaService
  /** M22：操作事件实时推送（notify:op）—— 数据库工具执行后上报，供前端直播窗/操作流即时可视化 */
  opNotify?: (op: ToolOpEvent) => void
  /** M24：计划存储（update_plan_step / submit_review 的权限校验与落库；缺省 = 范式工具返回未启用） */
  plans?: PlanStore
  /** M24：评审存储（submit_review 落库） */
  reviews?: ReviewStore
  /** M24：计划提交通道（引擎注入：创建/修订计划 → 挂起等待批准 → 回灌结论） */
  submitPlan?(input: PlanSubmitInput, signal?: AbortSignal): Promise<PlanSubmitOutcome>
  /** M24：本回合可更新的计划步骤（引擎按「步骤负责人或计划作者」计算） */
  planSteps?: Array<{ planId: string; stepId: string; content: string }>
  /** M35：定时任务服务（schedule_task / list_schedules / manage_schedule；缺省 = 工具返回未启用提示） */
  scheduleRuntime?: ScheduleService
  /** M34：金融数据网关（fin_* 工具；缺省 = FINANCE_ENABLED=false 或未装配，工具返回未启用提示） */
  finance?: FinanceGateway
  /** M34：金融自选列表存储（fin_watch 工具；缺省 = 工具返回未启用提示） */
  financeStore?: FinanceStore
}

/** M28：单条工具激活记录（tool_search 命中；引擎闭包写入 Run 级激活集合） */
export interface ToolSearchActivation {
  name: string
  description: string
  source: 'builtin' | 'mcp'
  /** source=mcp 时的服务器 slug */
  server?: string
}

/** M28：工具检索结果（无命中时 note 给出类别概览与改写建议） */
export interface ToolSearchOutcome {
  ok: boolean
  /** 命中的工具（已激活，本 Run 内持续可用） */
  activated?: ToolSearchActivation[]
  /** 补充提示（兜底引导语） */
  note?: string
  /** M47：发现未启用（全部工具已直接可用）——非失败语义，防误报与无谓重试 */
  direct?: boolean
  error?: string
}

/** 工具层上报的操作事件（引擎补齐 sessionId/runId/actor/ts 后发布为 notify:op） */
export interface ToolOpEvent {
  id: string
  kind: 'db' | 'ssh'
  action: string
  target?: string
  status: 'ok' | 'error'
  durationMs?: number
  summary?: string
  detail?: string
  preview?: { columns: string[]; rows: Array<Record<string, unknown>> }
}

/** M24：write_plan 提交入参（负责人已解析为成员 id；缺省 = 计划作者） */
export interface PlanSubmitInput {
  title: string
  goal: string
  steps: Array<{
    content: string
    ownerAgentId?: string
    /** review = 该步骤以评审范式执行 */
    mode?: 'execute' | 'review'
    expectedOutput?: string
    acceptance?: string
  }>
  risks?: string[]
}

/** M24：计划审批结论（挂起结算后回灌 write_plan 工具） */
export interface PlanSubmitOutcome {
  decision: 'approve' | 'reject'
  /** 最新计划快照（批准 / 驳回 / 取消后） */
  plan: Plan
  /** 驳回反馈（用户填写） */
  feedback?: string
  /** 运行停止导致的取消（计划保持 submitted，可稍后批准；区别于用户驳回） */
  cancelled?: boolean
  /** M24：被同会话并行批准的其它计划取代（superseded，计划不再执行） */
  superseded?: boolean
}

export interface ToolResult {
  ok: boolean
  /** 单行摘要（工具卡展示） */
  summary: string
  /** 回灌模型的详细结果（缺省时用 summary） */
  detail?: string
  /** 产出的交付件（工作区相对路径） */
  artifacts?: string[]
  /** write_todos 更新后的任务清单（引擎广播 task:updated） */
  tasks?: TaskItem[]
  /** handoff 工具解析后的转交目标（成员 id 或 'user'；多目标 = fan-out 并行意图；引擎按消息分组收集）
   *  M24：携带缘由与期望产出 —— 注入接收方回合指令（指派闭环） */
  handoff?: { targets: string[]; reason?: string; expected_output?: string }
  /** M24：计划变更结果（引擎广播 plan:updated / 收口检测） */
  plan?: Plan
  /** M24：评审记录（引擎广播 review:submitted） */
  review?: ReviewRecord
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface AgentTool<P = any> {
  name: string
  /** 何时用的能力说明（决定模型的调用时机） */
  description: string
  /** JSON Schema（转 OpenAI tools 协议） */
  parameters: Record<string, unknown>
  /** 运行期参数校验 */
  schema: z.ZodType<P>
  /** M5：只读工具（可并行 + 幂等缓存）；缺省视为写类（串行、不缓存） */
  readOnly?: boolean
  /**
   * M28：加载层级（渐进披露）。core = 每回合常驻模型工具清单；
   * deferred = 默认不加载，经 tool_search 检索激活后本 Run 内可用（缺省视为 core，行为与 M27 前一致）。
   */
  tier?: 'core' | 'deferred'
  execute(args: P, ctx: ToolRuntime): Promise<ToolResult>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = AgentTool<any>

/** 与 provider.abortError 语义一致（isAbortError 按 name 判定） */
export function toolAbortError(): Error {
  const err = new Error('操作已被中断')
  err.name = 'AbortError'
  return err
}

export function isToolAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/** M47：参数校验首条问题（zod 英文文案本地化：必填缺失 → 「为必填项」） */
function describeParamIssue(issue: ZodIssue): string {
  const field = issue.path.join('.') || '参数'
  if (issue.code === 'invalid_type' && (issue as { received?: unknown }).received === 'undefined') {
    return `${field} 为必填项`
  }
  return `${field} ${issue.message}`
}

/** 稳定序列化（键排序）→ 缓存键；保证同参数不同键序命中同一缓存 */
function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`).join(',')}}`
}

/** 只读工具幂等缓存 TTL（§M5：60s） */
const READ_CACHE_TTL_MS = 60_000
/** 只读缓存容量上限（审核 M-6：防长会话大量不同参数读取导致内存无界增长） */
const READ_CACHE_MAX_ENTRIES = 500

/** M24：plan / review 范式的附加工具（只读集之外的可用工具；execute 范式不受影响） */
const MODE_EXTRA_TOOLS: Record<'plan' | 'review', string[]> = {
  plan: ['write_plan', 'handoff', 'remember', 'request_approval'],
  review: ['submit_review', 'handoff', 'remember', 'request_approval'],
}

/**
 * M27：工具白名单匹配（未声明 / 空数组 = 全部工具）。
 * 条目支持尾部 `*` 通配（`mcp__<slug>__*` 整台 MCP 服务器 / `mcp__*` 全部 MCP 工具）。
 * 供授权矩阵（/api/mcp/tools）与 UI 复用，语义与 forAgent 保持一致。
 */
export function matchesToolPattern(tools: string[] | undefined, name: string): boolean {
  if (!tools || tools.length === 0) return true
  return tools.some((entry) => (entry.endsWith('*') ? name.startsWith(entry.slice(0, -1)) : entry === name))
}

export class ToolRegistry {
  private tools = new Map<string, AnyTool>()
  private readCache = new Map<string, { result: ToolResult; expiresAt: number }>()
  /** M47：已注册但当前环境不可用的工具提示（如 FINANCE_ENABLED=false 的 fin_*） */
  private unavailable = new Map<string, string>()

  constructor(private readonly toolTimeoutMs: number) {}

  register(tool: AnyTool): void {
    if (this.tools.has(tool.name)) throw new Error(`工具重名：${tool.name}`)
    this.tools.set(tool.name, tool)
  }

  /** M47：登记「已知但未启用」的工具名（同类能力整组关闭）——执行期给出精确指引而非泛化「未知工具」 */
  markUnavailable(names: string[], hint: string): void {
    for (const name of names) this.unavailable.set(name, hint)
  }

  /** 未启用工具名清单（控制台白名单校验用：编辑引用它们的角色不应报「未知工具」） */
  unavailableNames(): string[] {
    return [...this.unavailable.keys()]
  }

  /** M27：注销工具（MCP 服务器断开 / 工具清单变化时回收）；读缓存整体失效防陈旧命中 */
  unregister(name: string): boolean {
    const removed = this.tools.delete(name)
    if (removed) this.readCache.clear()
    return removed
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name)
  }

  list(): AnyTool[] {
    return [...this.tools.values()]
  }

  /** M5：只读判定（未知工具按写类处理，保守串行） */
  isReadOnly(name: string): boolean {
    return this.tools.get(name)?.readOnly === true
  }

  /** 手动失效只读缓存（外部文件系统状态变化后 / 测试驱动多状态场景） */
  clearReadCache(): void {
    this.readCache.clear()
  }

  /** 角色工具白名单过滤（未声明 = 全部可用；最小权限，§21.2）
   *  M24：mode 非 execute 时收敛为「只读工具 ∪ 范式附加工具」——不包含任何写类工具（审批门不再触发）；
   *  extraTools：引擎按回合动态授权（如派发执行波的 update_plan_step）。
   *  M27：白名单条目支持尾部 `*` 通配（mcp__<slug>__* 整台 MCP 服务器 / mcp__* 全部 MCP 工具）。 */
  forAgent(agent: { tools?: string[] }, mode?: TurnMode, extraTools?: string[]): AnyTool[] {
    if (!mode || mode === 'execute') {
      const base =
        !agent.tools || agent.tools.length === 0
          ? this.list()
          : this.resolveTools(agent.tools)
      return this.withExtras(base, extraTools)
    }
    const allowed = new Map<string, AnyTool>()
    for (const tool of this.tools.values()) if (tool.readOnly === true) allowed.set(tool.name, tool)
    for (const name of [...MODE_EXTRA_TOOLS[mode], ...(extraTools ?? [])]) {
      const tool = this.tools.get(name)
      if (tool) allowed.set(tool.name, tool)
    }
    return [...allowed.values()]
  }

  /** M24：并入回合级动态授权工具（保持既有顺序，新增项追加） */
  private withExtras(base: AnyTool[], extraTools?: string[]): AnyTool[] {
    if (!extraTools || extraTools.length === 0) return base
    const merged = new Map(base.map((t) => [t.name, t]))
    for (const name of extraTools) {
      const tool = this.tools.get(name)
      if (tool) merged.set(tool.name, tool)
    }
    return [...merged.values()]
  }

  /** M27：白名单解析（精确名 + 尾部 `*` 通配；保持声明顺序、按名去重） */
  private resolveTools(names: string[]): AnyTool[] {
    const out = new Map<string, AnyTool>()
    for (const entry of names) {
      if (entry.endsWith('*')) {
        const prefix = entry.slice(0, -1)
        for (const [name, tool] of this.tools) if (name.startsWith(prefix)) out.set(name, tool)
      } else {
        const tool = this.tools.get(entry)
        if (tool) out.set(entry, tool)
      }
    }
    return [...out.values()]
  }

  /** OpenAI tools 协议投影 */
  toSchema(tools: AnyTool[]): LlmToolSchema[] {
    return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
  }

  /** 兼容入口：无外部信号的执行（内部委托 execWithAbort） */
  async execute(name: string, rawArgs: unknown, ctx: ToolRuntime): Promise<ToolResult> {
    return this.execWithAbort(name, rawArgs, ctx)
  }

  /**
   * M5 执行主通道：未知工具 → 参数校验 → 幂等缓存 → 超时/中断护栏 → 失败重试 1 次。
   * - 超时：abort 工具内 signal，返回超时摘要（工具应自行放弃写入）；
   * - 外部取消（signal aborted）：abort 工具内 signal 并上抛 AbortError（引擎置 stopped）；
   * - readOnly 工具成功结果缓存 60s；写类工具执行后整体失效读缓存。
   */
  async execWithAbort(
    name: string,
    rawArgs: unknown,
    ctx: ToolRuntime,
    signal?: AbortSignal,
    timeoutMs = this.toolTimeoutMs,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      // M47：已知但整组未启用的工具（如金融关闭时的 fin_*）→ 精确「未启用」提示，模型可如实向用户说明并降级
      const hint = this.unavailable.get(name)
      return { ok: false, summary: hint ?? `未知工具「${name}」，可用工具见清单` }
    }

    const parsed = tool.schema.safeParse(rawArgs)
    if (!parsed.success) {
      return { ok: false, summary: `参数校验失败：${describeParamIssue(parsed.error.issues[0])}` }
    }

    // 幂等缓存（仅只读工具）
    const cacheable = tool.readOnly === true
    const key = cacheable ? `${name}:${stableKey(rawArgs)}` : ''
    if (cacheable) {
      const hit = this.readCache.get(key)
      if (hit && hit.expiresAt > Date.now()) {
        return { ...hit.result, summary: `${hit.result.summary}（缓存命中，本回合未重复执行）` }
      }
      if (hit) this.readCache.delete(key)
    }

    const run = async (): Promise<ToolResult> => {
      const controller = new AbortController()
      const onParentAbort = (): void => controller.abort()
      if (signal?.aborted) throw toolAbortError()
      signal?.addEventListener('abort', onParentAbort, { once: true })

      let timer: ReturnType<typeof setTimeout> | undefined
      let execPromise: Promise<ToolResult> | undefined
      const timeoutResult = new Promise<ToolResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort()
          resolve({ ok: false, summary: `工具执行超时（>${Math.round(timeoutMs / 1000)}s），已中断` })
        }, timeoutMs)
      })

      try {
        execPromise = tool.execute(parsed.data, { ...ctx, signal: controller.signal })
        const result = await Promise.race([execPromise, timeoutResult])
        if (signal?.aborted) throw toolAbortError()
        return result
      } finally {
        // 超时/取消后工具可能后发 reject（如原子写检查 aborted 抛错）→ 消费掉防 unhandledRejection
        void execPromise?.catch(() => undefined)
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onParentAbort)
      }
    }

    const cacheIfEligible = (result: ToolResult): ToolResult => {
      if (cacheable && result.ok) {
        // 审核 M-6：容量上限 FIFO 淘汰（Map 保持插入序；先删后插保证重读的键排到队尾）
        this.readCache.delete(key)
        this.readCache.set(key, { result, expiresAt: Date.now() + READ_CACHE_TTL_MS })
        while (this.readCache.size > READ_CACHE_MAX_ENTRIES) {
          const oldest = this.readCache.keys().next().value
          if (oldest === undefined) break
          this.readCache.delete(oldest)
        }
      }
      if (!cacheable) this.readCache.clear() // 写类执行后：读缓存整体失效
      return result
    }

    try {
      return cacheIfEligible(await run())
    } catch (err) {
      // 中断（用户停止 / 超时联动）不做失败重试，直接上抛
      if (isToolAbortError(err) || signal?.aborted) throw err
      // 失败重试 1 次（§21.2）
      try {
        return cacheIfEligible(await run())
      } catch (retryErr) {
        if (isToolAbortError(retryErr) || signal?.aborted) throw retryErr
        return { ok: false, summary: `工具失败（已重试）：${(retryErr as Error).message}` }
      }
    }
  }
}
