/**
 * M48：平台路由步（Platform Routing Step，PRS）。
 *
 * 调度上收引擎：未 @ 消息 / 空编制开场不再交给「调度官角色」回合，而是由引擎做一次
 * 结构化 LLM 调用（非角色回合：不产生消息、不占波次、不参与交接队列），输出
 * 「召集名单 + 任务派发」，由引擎应用为：召集落库（事件条可审计）+ 任务便条注入 + 队列填充。
 *
 * - 输入：用户需求 + 最近上下文 + 未在场角色目录（roster_catalog 同源渲染）+ 在场名单；
 * - 输出（json_schema，meta.agentId='__router__'）→ extractJson 解析（容忍围栏）→ 校验：
 *   未知角色 / 已在场 / 'user' 目标一律丢弃；assignments 为空 = 路由失败（ok:false）；
 * - 降级：调用失败 / 解析失败 → ok:false + error（引擎侧兜底：在场首位接手；空编制则事件条提示收尾），
 *   绝不阻断主链路；
 * - 用量：kind='turn'（agentId='__router__'，与角色回合同口径审计）。
 */
import { extractJson } from '../context/compressor.js'
import { resilientStream } from '../llm/resilience.js'
import type { ChatRequest, LlmProvider, LlmUsage } from '../llm/provider.js'
import { getLogger } from '../logger.js'
import type { AppConfig } from '../config.js'
import type { UsageStore } from '../store/usage.js'

/** 路由调用使用的虚拟角色 id（MockProvider 据此选择脚本化输出；与角色 id 空间隔离） */
export const ROUTER_AGENT_ID = '__router__'

/** assignments 上限（并行 fan-out 语义与 handoff 多目标对齐） */
export const ROUTE_MAX_ASSIGNMENTS = 4
/** task 要点截断（写不清 = 便条无效；超长截断防注入失控） */
const TASK_MAX_CHARS = 120

/** 结构化路由输出的 JSON Schema（response_format 透传） */
export const ROUTE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    members: {
      type: 'array',
      items: { type: 'string' },
      description: '需要召集的未在场角色 id 列表（可空；仅在现有成员无法覆盖需求时召集）',
    },
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: '接手角色 id（在场成员，或本次召集的 members 之一）' },
          task: { type: 'string', description: '一句话任务要点（写清期望产出）' },
        },
        required: ['agentId', 'task'],
        additionalProperties: false,
      },
      description: '任务派发（按处理顺序 1-4 位，首位最先开工）',
    },
    reason: { type: 'string', description: '一句话决策理由（写入审计轨迹）' },
  },
  required: ['members', 'assignments', 'reason'],
  additionalProperties: false,
}

const ROUTE_SYSTEM = `你是多 Agent 协作平台的路由器。根据用户的最新需求与会话上下文，从角色目录中决定「这一棒派给谁、要不要先召集人手」。

规则：
- assignments：把任务派给 1-4 位角色（按处理顺序排列，首位最先开工）；优先复用已在场成员；task 为一句可执行的任务要点（≤60 字，写清期望产出）；
- members：仅当现有在场成员明显无法覆盖需求时，才从目录中召集未在场角色（id 列表，可空）；被召集者会自动加入会话；
- 不要把任务派给 "user"；不要发明目录之外的 id；@ 直达的消息不会经过你（无需处理）；
- reason：一句话决策理由（供用户审计）；
- 只输出 JSON 对象：{ "members": [], "assignments": [ { "agentId", "task" } ], "reason": "…" }`

export interface PlatformRouteInput {
  cfg: AppConfig
  provider: LlmProvider
  /** 未在场角色目录渲染（roster_catalog 同源；由引擎传入，空编制 = 全员可召集） */
  catalog: string
  /** 用户需求正文（最新一条用户消息） */
  userText: string
  /** 最近上下文渲染（可选；空串 = 仅本次消息） */
  contextText?: string
  /** 会话在场成员 id（空数组 = 零编制开场） */
  presentIds: string[]
  /** 全量角色 id（校验用） */
  knownIds: Set<string>
  /** M4：路由调用用量落库 */
  usage?: UsageStore
  runId?: string
  sessionId?: string
  signal?: AbortSignal
}

export interface RouteAssignment {
  agentId: string
  task: string
}

export interface PlatformRouteOutcome {
  ok: boolean
  /** 需召集的未在场角色（已剔除未知 / 已在场） */
  members: string[]
  /** 任务派发（有序；首位首发） */
  assignments: RouteAssignment[]
  reason: string
  error?: string
}

/** 路由失败（调用异常 / 解析失败 / assignments 空）的稳定返回值 */
function failed(error: string): PlatformRouteOutcome {
  return { ok: false, members: [], assignments: [], reason: '', error }
}

/**
 * 执行平台路由步：一次结构化调用 → 校验后的「召集 + 派发」方案。
 * 失败永不抛错（返回 ok:false），由引擎决定降级路径。
 */
export async function runPlatformRoute(input: PlatformRouteInput): Promise<PlatformRouteOutcome> {
  const { cfg, provider } = input
  const parts = [`<request>\n${input.userText.trim()}\n</request>`]
  if (input.contextText?.trim()) parts.push(`<context>\n${input.contextText.trim()}\n</context>`)
  if (input.catalog.trim()) parts.push(input.catalog.trim())
  const request: ChatRequest = {
    system: ROUTE_SYSTEM,
    messages: [{ role: 'user', content: parts.join('\n\n') }],
    model: cfg.summaryModel || undefined,
    temperature: 0,
    responseFormat: { type: 'json_schema', name: 'platform_route', schema: ROUTE_SCHEMA },
    meta: { agentId: ROUTER_AGENT_ID, participantIds: [...input.presentIds], stepIndex: 0 },
  }

  let received = ''
  let usage: LlmUsage | undefined
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  input.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for await (const chunk of resilientStream((signal) => provider.chatStream(request, signal), {
      maxAttempts: Math.max(1, cfg.llmMaxRetries),
      baseDelayMs: cfg.llmRetryBaseDelayMs,
      firstTokenTimeoutMs: cfg.firstTokenTimeoutMs,
      idleTimeoutMs: cfg.streamIdleTimeoutMs,
      parentSignal: controller.signal,
      onRetry: (info) =>
        getLogger().warn(
          { sessionId: input.sessionId, runId: input.runId, attempt: info.attempt, reason: info.reason },
          '平台路由调用失败，自动重试',
        ),
    })) {
      if (chunk.type === 'text') received += chunk.text
      else if (chunk.type === 'usage') usage = chunk.usage
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    getLogger().warn({ sessionId: input.sessionId, runId: input.runId, err: message }, '平台路由调用失败（降级）')
    return failed(message)
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
  }

  // 调用已发生 → 无论解析成败都记用量（失败也可能已产生费用）
  if (usage) {
    input.usage?.record({
      runId: input.runId ?? '',
      sessionId: input.sessionId ?? '',
      agentId: ROUTER_AGENT_ID,
      model: cfg.summaryModel || cfg.llmModel,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      kind: 'turn',
    })
  }

  const plan = coerceRoutePlan(extractJson(received), {
    presentIds: input.presentIds,
    knownIds: input.knownIds,
  })
  if (!plan) return failed('路由输出无法解析或没有可派发的任务')
  return { ok: true, ...plan }
}

/**
 * 路由输出的容错解析（导出供单测）：
 * - members：仅保留「存在于资产且未在场」的 id（去重）；
 * - assignments：agentId 必须 ∈ 在场 ∪ members（'user' 与未知一律丢弃），task 折叠截断，去重；
 * - assignments 为空 → null（路由失败）。
 */
export function coerceRoutePlan(
  raw: unknown,
  opts: { presentIds: string[]; knownIds: Set<string> },
): { members: string[]; assignments: RouteAssignment[]; reason: string } | null {
  const obj = raw as { members?: unknown; assignments?: unknown; reason?: unknown } | undefined
  if (!obj || typeof obj !== 'object') return null
  const present = new Set(opts.presentIds)

  const members: string[] = []
  for (const item of Array.isArray(obj.members) ? obj.members : []) {
    const id = String(item ?? '').trim()
    if (id === '' || id === 'user') continue
    if (!opts.knownIds.has(id) || present.has(id) || members.includes(id)) continue
    members.push(id)
  }

  const eligible = new Set([...present, ...members])
  const assignments: RouteAssignment[] = []
  for (const item of Array.isArray(obj.assignments) ? obj.assignments : []) {
    const entry = item as { agentId?: unknown; task?: unknown } | undefined
    const agentId = String(entry?.agentId ?? '').trim()
    const task = String(entry?.task ?? '').trim().replace(/\s+/g, ' ')
    if (agentId === '' || task === '' || agentId === 'user') continue
    if (!eligible.has(agentId) || assignments.some((a) => a.agentId === agentId)) continue
    if (assignments.length >= ROUTE_MAX_ASSIGNMENTS) break
    assignments.push({ agentId, task: task.length > TASK_MAX_CHARS ? `${task.slice(0, TASK_MAX_CHARS)}…` : task })
  }
  if (assignments.length === 0) return null

  const reason = String(obj.reason ?? '').trim().slice(0, 200)
  return { members, assignments, reason }
}
