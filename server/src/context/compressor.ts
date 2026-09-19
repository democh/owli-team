/**
 * 滚动摘要压缩（M2 核心里程碑）。
 *
 * 触发（由 ContextService 判定）：装配估算 > CONTEXT_BUDGET_TOKENS × 0.7。
 *
 * 流程：
 * 1. 切分：取「旧摘要水位之后、最近 KEEP_RECENT_TURNS 个完整回合之前」的区间，
 *    以「回合组」（user → agent 序列）为原子单位，禁止从 tool 结果中间切开；
 * 2. 摘要：调 SUMMARY_MODEL 一次结构化输出（json_schema）；
 * 3. 合并：旧摘要 + 新区间 → 新摘要（去重），写 summaries 且 until_seq 前进；
 * 4. 提升：decisions / constraints / artifacts 合并进 memory（内容哈希去重）；
 * 5. 降级：摘要调用失败 → 水位不动 + 标记 degraded，装配侧退化为硬截断并提示。
 */
import type { ChatMessage } from '@multi-agent/shared'
import { getLogger } from '../logger.js'
import { resilientStream } from '../llm/resilience.js'
import type { ChatRequest, LlmProvider, LlmUsage } from '../llm/provider.js'
import type { AppConfig } from '../config.js'
import type { MemoryStore } from '../store/memory.js'
import type { SessionStore } from '../store/sessions.js'
import type { UsageStore } from '../store/usage.js'
import {
  coerceSummaryData,
  mergeSummaryData,
  renderSummaryData,
  type SummaryStore,
} from '../store/summaries.js'
import { attachmentOnlyNote } from '../util/attachments.js'
import { countTokensCalibrated, truncateToTokens } from './tokenizer.js'

/** 摘要调用使用的虚拟角色 id（测试替身与真实 Provider 均据此识别压缩请求） */
export const SUMMARY_AGENT_ID = '__summarizer__'

/** 结构化摘要的 JSON Schema（response_format 透传） */
export const SUMMARY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    completed: { type: 'array', items: { type: 'string' }, description: '已完成的事项（含结论）' },
    decisions: { type: 'array', items: { type: 'string' }, description: '已确认的关键决策' },
    constraints: { type: 'array', items: { type: 'string' }, description: '约束、口径、边界条件' },
    artifacts: { type: 'array', items: { type: 'string' }, description: '交付件路径（逐字保留）' },
    openQuestions: { type: 'array', items: { type: 'string' }, description: '未决问题' },
    nextSteps: { type: 'array', items: { type: 'string' }, description: '下一步计划' },
  },
  required: ['completed', 'decisions', 'constraints', 'artifacts', 'openQuestions', 'nextSteps'],
  additionalProperties: false,
}

const SUMMARY_SYSTEM = `你是多 Agent 协作会话的上下文压缩器。把「历史对话区间」压缩为结构化摘要，供后续回合继续工作使用。

规则：
- 只记录对后续工作有影响的信息：已完成事项、已确认决策、约束与口径、交付件路径、未决问题、下一步；
- 交付件路径、数字、口径必须逐字保留，不得发明原文不存在的内容；
- 若提供了旧摘要，将其与新区间合并（内容去重），输出合并后的完整摘要；
- 每条为凝练短句（≤60 字）；
- 只输出 JSON 对象，字段：completed / decisions / constraints / artifacts / openQuestions / nextSteps（字符串数组）。`

/** 摘要输入预算：区间渲染文本总量上限（避免摘要调用自身爆窗） */
const SUMMARY_INPUT_BUDGET_TOKENS = 24_000
const PER_MESSAGE_MAX_TOKENS = 800
const PER_MESSAGE_MIN_TOKENS = 160

export interface CompressorDeps {
  cfg: AppConfig
  provider: LlmProvider
  sessions: SessionStore
  summaries: SummaryStore
  memory: MemoryStore
  /** M4：摘要调用用量落库（kind='summary'） */
  usage?: UsageStore
}

export interface CompressionInput {
  sessionId: string
  /** 保留最近 N 个完整回合（agent 发言）不压缩 */
  keepRecentTurns: number
  signal?: AbortSignal
  /** M4：用量归属的 Run（压缩发生在某回合内） */
  runId?: string
}

export interface CompressionResult {
  /** 是否成功压缩（false = 无可压缩区间或失败降级） */
  compressed: boolean
  /** 压缩后水位（未压缩/失败时 = 原水位） */
  untilSeq: number
  /** 本次纳入摘要的消息条数 */
  summarizedMessages: number
  degraded: boolean
  /** 提升进 memory 的条目数 */
  memoryAdded: number
  /** M4：压缩前区间文本估算 token（事件展示用） */
  beforeTokens?: number
  /** M4：压缩后摘要文本估算 token（事件展示用） */
  afterTokens?: number
}

export class Compressor {
  constructor(private readonly deps: CompressorDeps) {}

  async compress(input: CompressionInput): Promise<CompressionResult> {
    const { sessions, summaries } = this.deps
    const existing = summaries.get(input.sessionId)
    const fromSeq = existing?.untilSeq ?? 0
    const candidates = sessions.messages(input.sessionId).filter((m) => (m.seq ?? 0) > fromSeq)

    const range = pickCompressionRange(candidates, input.keepRecentTurns)
    if (!range || range.length === 0) {
      return {
        compressed: false,
        untilSeq: fromSeq,
        summarizedMessages: 0,
        degraded: existing?.degraded ?? false,
        memoryAdded: 0,
      }
    }

    const lastSeq = range[range.length - 1].seq ?? fromSeq
    const historyText = renderForSummary(range)
    const historyTokens = countTokensCalibrated(historyText)
    const userContent = [
      existing && existing.content
        ? `<old_summary>\n${existing.content}\n</old_summary>\n\n将旧摘要与以下新区间合并：`
        : '',
      `<history>\n${historyText}\n</history>`,
    ]
      .filter(Boolean)
      .join('\n')

    let received = ''
    let usage: LlmUsage | undefined
    try {
      const controller = new AbortController()
      const onAbort = (): void => controller.abort()
      input.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const request: ChatRequest = {
          system: SUMMARY_SYSTEM,
          messages: [{ role: 'user', content: userContent }],
          model: this.deps.cfg.summaryModel || undefined,
          temperature: 0,
          responseFormat: { type: 'json_schema', name: 'session_summary', schema: SUMMARY_SCHEMA },
          meta: { agentId: SUMMARY_AGENT_ID, participantIds: [], stepIndex: 0 },
        }
        // 审核 M-3：摘要调用接入 resilience 层（错误分类重试 + 首 token / 流空闲超时），与回合主链路一致
        for await (const chunk of resilientStream(
          (signal) => this.deps.provider.chatStream(request, signal),
          {
            maxAttempts: Math.max(1, this.deps.cfg.llmMaxRetries),
            baseDelayMs: this.deps.cfg.llmRetryBaseDelayMs,
            firstTokenTimeoutMs: this.deps.cfg.firstTokenTimeoutMs,
            idleTimeoutMs: this.deps.cfg.streamIdleTimeoutMs,
            parentSignal: controller.signal,
            onRetry: (info) =>
              getLogger().warn(
                { sessionId: input.sessionId, attempt: info.attempt, delayMs: info.delayMs, reason: info.reason },
                '摘要压缩调用失败，自动重试',
              ),
          },
        )) {
          if (chunk.type === 'text') received += chunk.text
          else if (chunk.type === 'usage') usage = chunk.usage
        }
      } finally {
        input.signal?.removeEventListener('abort', onAbort)
      }
      // M4：摘要调用已发生 → 无论解析成败都记用量（失败也可能已产生费用）
      if (usage && this.deps.usage && input.runId) {
        this.deps.usage.record({
          runId: input.runId,
          sessionId: input.sessionId,
          agentId: SUMMARY_AGENT_ID,
          model: this.deps.cfg.summaryModel || this.deps.cfg.llmModel,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          kind: 'summary',
        })
      }
    } catch (err) {
      getLogger().warn(
        { err: (err as Error).message, sessionId: input.sessionId },
        '摘要压缩调用失败，降级为硬截断',
      )
      summaries.markDegraded(input.sessionId)
      return {
        compressed: false,
        untilSeq: fromSeq,
        summarizedMessages: range.length,
        degraded: true,
        memoryAdded: 0,
      }
    }

    const parsed = coerceSummaryData(extractJson(received))
    if (!parsed) {
      getLogger().warn({ sessionId: input.sessionId }, '摘要输出无法解析为结构化 JSON，降级为硬截断')
      summaries.markDegraded(input.sessionId)
      return {
        compressed: false,
        untilSeq: fromSeq,
        summarizedMessages: range.length,
        degraded: true,
        memoryAdded: 0,
      }
    }

    const merged = mergeSummaryData(existing?.data, parsed)
    const content = renderSummaryData(merged)
    const summaryTokens = countTokensCalibrated(content)
    summaries.save({
      sessionId: input.sessionId,
      untilSeq: lastSeq,
      data: merged,
      content,
      tokenCount: summaryTokens,
      degraded: false,
    })

    // 提升：决策 / 约束 / 交付件 → L1 记忆（永不裁剪层）
    const { memory } = this.deps
    const memoryAdded =
      memory.promote(input.sessionId, 'decision', merged.decisions, 'compress') +
      memory.promote(input.sessionId, 'constraint', merged.constraints, 'compress') +
      memory.promote(input.sessionId, 'artifact', merged.artifacts, 'compress')

    getLogger().info(
      {
        sessionId: input.sessionId,
        untilSeq: lastSeq,
        messages: range.length,
        memoryAdded,
      },
      '上下文已压缩',
    )
    return {
      compressed: true,
      untilSeq: lastSeq,
      summarizedMessages: range.length,
      degraded: false,
      memoryAdded,
      beforeTokens: historyTokens,
      afterTokens: summaryTokens,
    }
  }
}

/**
 * 切分压缩区间：水位之后的消息中，保留最近 keepRecentTurns 个「回合组」。
 * - 首选组级切分（组以 user 消息开头，天然原子）；
 * - 整个候选区只有一个组（长会话无用户插话）时，退化为按 agent 消息边界切分
 *  （历史消息中工具结果跟随所属 agent 消息，不存在被拆散的 tool 消息）。
 */
export function pickCompressionRange(
  messages: ChatMessage[],
  keepRecentTurns: number,
): ChatMessage[] | undefined {
  if (messages.length === 0 || keepRecentTurns <= 0) return undefined

  const groups: ChatMessage[][] = []
  for (const m of messages) {
    if (m.role === 'user' || groups.length === 0) groups.push([])
    groups[groups.length - 1].push(m)
  }

  let keptTurns = 0
  let splitGroup = groups.length
  for (let i = groups.length - 1; i >= 0; i--) {
    if (keptTurns >= keepRecentTurns) break
    keptTurns += groups[i].filter((m) => m.role === 'agent').length
    splitGroup = i
  }
  if (splitGroup > 0) {
    const range = groups.slice(0, splitGroup).flat()
    return range.length > 0 ? range : undefined
  }

  // 退化：单组长会话 —— 按 agent 消息边界切
  const agentIdx = messages.map((m, i) => (m.role === 'agent' ? i : -1)).filter((i) => i >= 0)
  if (agentIdx.length <= keepRecentTurns) return undefined
  const splitAt = agentIdx[agentIdx.length - keepRecentTurns]
  return splitAt > 0 ? messages.slice(0, splitAt) : undefined
}

/** 区间渲染为摘要输入文本（总量与单条双限制，避免摘要调用爆窗） */
export function renderForSummary(messages: ChatMessage[]): string {
  const per = Math.max(
    PER_MESSAGE_MIN_TOKENS,
    Math.min(PER_MESSAGE_MAX_TOKENS, Math.floor(SUMMARY_INPUT_BUDGET_TOKENS / Math.max(1, messages.length))),
  )
  const lines: string[] = []
  for (const m of messages) {
    const who = m.role === 'user' ? '用户' : `Agent(${m.agentId ?? '未知'})`
    const text = m.content.trim() || attachmentOnlyNote(m) || '（无文本，仅工具调用）'
    const { text: clipped } = truncateToTokens(text, per)
    lines.push(`[${who}] ${clipped}`)
    for (const call of m.toolCalls ?? []) {
      lines.push(`  · 工具 ${call.name}：${(call.summary ?? '').replace(/\s+/g, ' ').slice(0, 160)}`)
    }
  }
  return lines.join('\n')
}

/** 从模型输出中提取 JSON 对象（容忍前后解释文本 / markdown 围栏） */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}
