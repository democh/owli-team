/**
 * Run 后记忆沉淀（M25.4）：把已收尾 Run 的对话区间提取为「候选记忆」。
 *
 * - 默认关（memoryDigestMode='off' → 零调用零写入）；触发判定在引擎收口（主 Run / 轻量 Run）；
 * - 结构化输出（json_schema，meta.agentId='__digester__'）→ extractJson 解析（容忍围栏）→
 *   upsertScoped(status='candidate')：候选必须先经「记忆面板」审核（PATCH → active）才参与召回；
 * - 近重复合并（worker cos ≥ 0.92）只在 active 间发生：候选不会顶掉既有 active 记忆（worker 不镜像非 active）；
 * - 失败静默（仅日志）：沉淀属于后台增强，绝不影响主链路与 Run 收尾。
 */
import type { ChatMessage, MemoryKind, MemoryScope } from '@multi-agent/shared'
import type { AppConfig } from '../config.js'
import { extractJson } from '../context/compressor.js'
import { countTokensCalibrated, truncateToTokens } from '../context/tokenizer.js'
import { resilientStream } from '../llm/resilience.js'
import type { ChatRequest, LlmProvider, LlmUsage } from '../llm/provider.js'
import { getLogger } from '../logger.js'
import type { MemoryStore } from '../store/memory.js'
import { MEMORY_KINDS } from '../store/memory.js'
import type { SessionStore } from '../store/sessions.js'
import type { UsageStore } from '../store/usage.js'
import { attachmentOnlyNote } from '../util/attachments.js'

/** 沉淀调用使用的虚拟角色 id（MockProvider 据此选择脚本化输出） */
export const DIGEST_AGENT_ID = '__digester__'

/** 结构化沉淀的 JSON Schema（response_format 透传） */
export const DIGEST_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...MEMORY_KINDS], description: '记忆类型' },
          content: { type: 'string', description: '独立可读的凝练短句（≤80 字）' },
          scope: { type: 'string', enum: ['session', 'global'], description: 'session 本会话 / global 跨会话通用' },
          importance: { type: 'integer', description: '重要度 1-5（默认 3）' },
        },
        required: ['kind', 'content'],
        additionalProperties: false,
      },
      description: '值得长期保留的候选记忆（最多 5 条，没有则空数组）',
    },
  },
  required: ['candidates'],
  additionalProperties: false,
}

const DIGEST_SYSTEM = `你是多 Agent 协作会话的记忆沉淀器。把「本回合对话记录」中值得长期保留的结论提取为候选记忆，供人工审核后注入后续回合。

规则：
- 只提取有长期价值的条目：已确认的决策（decision）、约束与口径（constraint）、术语（glossary）、交付件路径（artifact）、事实（fact）、用户偏好（preference）、经验教训（lesson）；
- 不提取过程性描述、寒暄、一次性状态；用户偏好与跨项目通用规则 scope=global，其余 scope=session；
- content 为独立可读的凝练短句（≤80 字），不得发明原文不存在的内容；数字、路径、口径逐字保留；
- 宁缺毋滥：最多 5 条，没有值得沉淀的内容返回空数组；
- importance：1-5（默认 3，用户偏好与硬约束取 4-5）；
- 只输出 JSON 对象：{ "candidates": [ { "kind", "content", "scope", "importance" } ] }`

/** 沉淀输入预算：对话渲染文本总量上限（避免沉淀调用自身爆窗） */
const DIGEST_INPUT_BUDGET_TOKENS = 6_000
const PER_MESSAGE_MAX_TOKENS = 600
const MAX_CANDIDATES = 5
const MAX_CONTENT_CHARS = 400

export interface DigestDeps {
  cfg: AppConfig
  provider: LlmProvider
  sessions: SessionStore
  memory: MemoryStore
  /** M4：沉淀调用用量落库（kind='digest'） */
  usage?: UsageStore
  /** 写入后加速嵌入消费（MemoryService.poke；缺省 = worker 定时器兜底） */
  poke?: () => Promise<number>
}

export interface DigestInput {
  sessionId: string
  runId: string
  signal?: AbortSignal
}

export interface DigestResult {
  ok: boolean
  /** 模型给出的候选条数 */
  candidates: number
  /** 实际新增入库的候选条数（内容哈希去重后） */
  added: number
  skipped?: string
  error?: string
}

export class MemoryDigester {
  constructor(private readonly deps: DigestDeps) {}

  /** 沉淀一个已收尾 Run：取「最后一条用户消息起」的对话区间 → 结构化提取 → 候选入库 */
  async digestRun(input: DigestInput): Promise<DigestResult> {
    if (this.deps.cfg.memoryDigestMode === 'off') {
      return { ok: false, candidates: 0, added: 0, skipped: '沉淀已关闭（设置 → 向量记忆 → 自动沉淀）' }
    }
    const range = this.recentTurn(input.sessionId)
    if (range.length === 0) return { ok: false, candidates: 0, added: 0, skipped: '无对话内容' }
    const transcript = renderForDigest(range)

    let received = ''
    let usage: LlmUsage | undefined
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    input.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const request: ChatRequest = {
        system: DIGEST_SYSTEM,
        messages: [{ role: 'user', content: `<transcript>\n${transcript}\n</transcript>` }],
        model: this.deps.cfg.summaryModel || undefined,
        temperature: 0,
        responseFormat: { type: 'json_schema', name: 'memory_digest', schema: DIGEST_SCHEMA },
        meta: { agentId: DIGEST_AGENT_ID, participantIds: [], stepIndex: 0 },
      }
      // 与回合主链路 / 摘要一致的 resilience 层（错误分类重试 + 首 token / 流空闲超时）
      for await (const chunk of resilientStream((signal) => this.deps.provider.chatStream(request, signal), {
        maxAttempts: Math.max(1, this.deps.cfg.llmMaxRetries),
        baseDelayMs: this.deps.cfg.llmRetryBaseDelayMs,
        firstTokenTimeoutMs: this.deps.cfg.firstTokenTimeoutMs,
        idleTimeoutMs: this.deps.cfg.streamIdleTimeoutMs,
        parentSignal: controller.signal,
        onRetry: (info) =>
          getLogger().warn(
            { sessionId: input.sessionId, runId: input.runId, attempt: info.attempt, reason: info.reason },
            '记忆沉淀调用失败，自动重试',
          ),
      })) {
        if (chunk.type === 'text') received += chunk.text
        else if (chunk.type === 'usage') usage = chunk.usage
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      getLogger().warn({ sessionId: input.sessionId, runId: input.runId, err: message }, '记忆沉淀调用失败（静默）')
      return { ok: false, candidates: 0, added: 0, error: message }
    } finally {
      input.signal?.removeEventListener('abort', onAbort)
    }

    // 调用已发生 → 无论解析成败都记用量（失败也可能已产生费用）
    if (usage) {
      this.deps.usage?.record({
        runId: input.runId,
        sessionId: input.sessionId,
        agentId: DIGEST_AGENT_ID,
        model: this.deps.cfg.summaryModel || this.deps.cfg.llmModel,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        kind: 'digest',
      })
    }

    const candidates = coerceDigestCandidates(extractJson(received))
    let added = 0
    for (const candidate of candidates) {
      const owner = candidate.scope === 'global' ? 'global' : input.sessionId
      const result = this.deps.memory.upsertScoped(candidate.scope, owner, candidate.kind, candidate.content, {
        status: 'candidate',
        source: 'digest',
        sourceSessionId: input.sessionId,
        sourceRunId: input.runId,
        importance: candidate.importance,
      })
      if (result?.added) added++
    }
    if (added > 0) void this.deps.poke?.()
    return { ok: true, candidates: candidates.length, added }
  }

  /**
   * 本 Run 的对话区间：最后一条用户消息起的全部消息。
   * （主 Run 以用户消息起步；续写 / 重生成的轻量 Run 同尾区间 → 内容哈希去重天然兜底重复沉淀。）
   */
  private recentTurn(sessionId: string): ChatMessage[] {
    const messages = this.deps.sessions.messages(sessionId)
    if (messages.length === 0) return []
    let from = messages.length - 1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') {
        from = i
        break
      }
    }
    return messages.slice(from)
  }
}

interface DigestCandidate {
  kind: MemoryKind
  content: string
  scope: Extract<MemoryScope, 'session' | 'global'>
  importance: number
}

/** 解析模型输出为候选（容忍缺失字段；非法 kind / 空内容丢弃；上限截断） */
export function coerceDigestCandidates(raw: unknown): DigestCandidate[] {
  const obj = raw as { candidates?: unknown } | undefined
  if (!obj || !Array.isArray(obj.candidates)) return []
  const out: DigestCandidate[] = []
  for (const entry of obj.candidates) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const kind = String(e.kind ?? '')
    const content = String(e.content ?? '')
      .trim()
      .slice(0, MAX_CONTENT_CHARS)
    if (!MEMORY_KINDS.includes(kind as MemoryKind) || !content) continue
    const scope: DigestCandidate['scope'] = e.scope === 'global' ? 'global' : 'session'
    const importance = Math.min(5, Math.max(1, Math.round(Number(e.importance ?? 3) || 3)))
    out.push({ kind: kind as MemoryKind, content, scope, importance })
    if (out.length >= MAX_CANDIDATES) break
  }
  return out
}

/** 区间渲染为沉淀输入文本（总量预算内取最近内容；单条限长） */
export function renderForDigest(messages: ChatMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    const who = m.role === 'user' ? '用户' : `Agent(${m.agentId ?? '未知'})`
    const text = m.content.trim() || attachmentOnlyNote(m) || '（无文本，仅工具调用）'
    const { text: clipped } = truncateToTokens(text, PER_MESSAGE_MAX_TOKENS)
    lines.push(`[${who}] ${clipped}`)
    for (const call of m.toolCalls ?? []) {
      lines.push(`  · 工具 ${call.name}：${(call.summary ?? '').replace(/\s+/g, ' ').slice(0, 160)}`)
    }
  }
  // 预算截断：从最新往前累加（最近内容优先保留）
  let used = 0
  let from = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = countTokensCalibrated(lines[i] ?? '')
    if (used + cost > DIGEST_INPUT_BUDGET_TOKENS) break
    used += cost
    from = i
  }
  return lines.slice(from).join('\n')
}
