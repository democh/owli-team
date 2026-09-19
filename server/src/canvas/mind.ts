/**
 * M31：脑图生成（无限画布 P4）——按来源组装素材 → 结构化 JSON 树（summaryModel）。
 *
 * 来源：conversation（最近对话）/ plans（协作计划）/ tasks（任务清单）/ memory（会话记忆）/ topic（自定义主题）。
 * - 结构化输出（json_schema，meta.agentId = MIND_AGENT_ID）→ extractJson 解析（容忍围栏）→ coerceMindTree 归一化；
 * - 失败给出明确 code（empty=来源无内容 / llm=调用失败 / invalid=输出不可用），路由映射 422 / 502；
 * - 只读调用：落画布由前端 canvas-store 统一收口（服务端不写文档，避免与用户编辑互撞乐观锁）；
 * - 用量（kind='mind'）尽力记录（无 Run 归属，runId=''），不影响主流程。
 */
import type { ChatMessage, MindSource, MindTreeNode } from '@multi-agent/shared'
import type { AppConfig } from '../config.js'
import { extractJson } from '../context/compressor.js'
import { countTokensCalibrated, truncateToTokens } from '../context/tokenizer.js'
import { resilientStream } from '../llm/resilience.js'
import type { ChatRequest, LlmProvider, LlmUsage } from '../llm/provider.js'
import { getLogger } from '../logger.js'
import type { MemoryStore } from '../store/memory.js'
import type { PlanStore } from '../store/plans.js'
import type { SessionStore } from '../store/sessions.js'
import type { TaskStore } from '../store/tasks.js'
import type { UsageStore } from '../store/usage.js'
import { attachmentOnlyNote } from '../util/attachments.js'

/** 生成调用使用的虚拟角色 id（MockProvider 可据此选择脚本化输出） */
export const MIND_AGENT_ID = '__mind__'

/** 结构化脑图 JSON Schema（response_format 透传；三层定长，nodes 上限 1+6+36=43） */
export const MIND_TREE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '根节点：中心主题（≤20 字）' },
    children: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '一级分支（≤20 字）' },
          children: {
            type: 'array',
            maxItems: 6,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: '要点（≤24 字）' },
                children: {
                  type: 'array',
                  maxItems: 6,
                  items: {
                    type: 'object',
                    properties: { title: { type: 'string' } },
                    required: ['title'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['title'],
              additionalProperties: false,
            },
          },
        },
        required: ['title'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'children'],
  additionalProperties: false,
}

const MIND_SYSTEM = `你是无限画布的脑图生成器：把给定素材整理为一张可继续编辑的结构化脑图。

规则：
- 根节点 title = 中心主题（≤20 字）；一级分支 3-6 个（维度 / 阶段 / 主题簇），每个分支下 2-5 个要点；
- 用 children 数组表达层级，最多三层；标题精炼（≤24 字），不得发明素材中不存在的事实、路径与数字；
- 素材是任务清单时按「阶段 → 事项」组织；是计划时按「目标 → 步骤 → 交付」组织；
- 素材是对话时提炼结论、决策与待办；是主题时按通用知识框架展开；
- 只输出 JSON 对象：{ "title": "…", "children": [ { "title": "…", "children": [ { "title": "…" } ] } ] }`

/** 素材输入预算（token；避免生成本身爆窗） */
const MIND_INPUT_BUDGET_TOKENS = 6_000
const PER_MESSAGE_MAX_TOKENS = 400
/** 树形硬约束（归一化兜底：模型越界时截断） */
const MAX_DEPTH = 3
const MAX_CHILDREN = 6
const MAX_TITLE_CHARS = 60

export interface MindDeps {
  cfg: AppConfig
  provider: LlmProvider
  sessions: SessionStore
  tasks: TaskStore
  memory: MemoryStore
  /** M24 计划存储（缺省 = plans 来源给引导错误） */
  plans?: PlanStore
  /** M4 用量落库（kind='mind'；缺省 = 不记账） */
  usage?: UsageStore
}

export interface MindGenerateInput {
  sessionId: string
  source: MindSource
  /** source='topic' 时必填 */
  topic?: string
  signal?: AbortSignal
}

export type MindGenerateResult =
  | { ok: true; tree: MindTreeNode }
  | { ok: false; error: string; code: 'empty' | 'llm' | 'invalid' }

export class MindGenerator {
  constructor(private readonly deps: MindDeps) {}

  async generate(input: MindGenerateInput): Promise<MindGenerateResult> {
    const assembled = this.assemble(input)
    if (!assembled.ok) return { ok: false, code: 'empty', error: assembled.error }

    let received = ''
    let usage: LlmUsage | undefined
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    input.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const request: ChatRequest = {
        system: MIND_SYSTEM,
        messages: [
          { role: 'user', content: `<material source="${input.source}">\n${assembled.text}\n</material>` },
        ],
        model: this.deps.cfg.summaryModel || undefined,
        temperature: 0.3,
        responseFormat: { type: 'json_schema', name: 'mind_tree', schema: MIND_TREE_SCHEMA },
        meta: { agentId: MIND_AGENT_ID, participantIds: [], stepIndex: 0 },
      }
      for await (const chunk of resilientStream((signal) => this.deps.provider.chatStream(request, signal), {
        maxAttempts: Math.max(1, this.deps.cfg.llmMaxRetries),
        baseDelayMs: this.deps.cfg.llmRetryBaseDelayMs,
        firstTokenTimeoutMs: this.deps.cfg.firstTokenTimeoutMs,
        idleTimeoutMs: this.deps.cfg.streamIdleTimeoutMs,
        parentSignal: controller.signal,
        onRetry: (info) =>
          getLogger().warn(
            { sessionId: input.sessionId, attempt: info.attempt, reason: info.reason },
            '脑图生成调用失败，自动重试',
          ),
      })) {
        if (chunk.type === 'text') received += chunk.text
        else if (chunk.type === 'usage') usage = chunk.usage
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      getLogger().warn({ sessionId: input.sessionId, err: message }, '脑图生成调用失败')
      return { ok: false, code: 'llm', error: `模型调用失败：${message}` }
    } finally {
      input.signal?.removeEventListener('abort', onAbort)
    }

    if (usage) {
      this.deps.usage?.record({
        runId: '',
        sessionId: input.sessionId,
        agentId: MIND_AGENT_ID,
        model: this.deps.cfg.summaryModel || this.deps.cfg.llmModel,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        kind: 'mind',
      })
    }

    const tree = coerceMindTree(extractJson(received), assembled.rootTitle)
    if (!tree) {
      return { ok: false, code: 'invalid', error: '模型未返回可用的脑图结构：请重试，或换一个来源 / 主题' }
    }
    return { ok: true, tree }
  }

  /** 按来源组装素材（只读；空来源给引导性错误文案） */
  private assemble(input: MindGenerateInput): { ok: true; text: string; rootTitle: string } | { ok: false; error: string } {
    const sessionTitle = this.deps.sessions.getSession(input.sessionId)?.title?.trim() || '本会话'
    switch (input.source) {
      case 'conversation': {
        const messages = this.deps.sessions.messages(input.sessionId)
        if (messages.length === 0) {
          return { ok: false, error: '本会话还没有对话内容：先聊几句，再从对话生成脑图' }
        }
        return { ok: true, text: renderConversation(messages), rootTitle: sessionTitle }
      }
      case 'plans': {
        const plans = this.deps.plans?.list(input.sessionId) ?? []
        if (plans.length === 0) {
          return { ok: false, error: '本会话还没有协作计划：先用规划范式产出计划，再从计划生成脑图' }
        }
        const lines: string[] = []
        for (const plan of plans.slice(-5)) {
          lines.push(`## 计划《${plan.title}》（状态：${plan.status}）`)
          lines.push(`目标：${plan.goal}`)
          for (const step of plan.steps) {
            lines.push(`- 步骤${step.id}：${step.content}${step.ownerAgentId ? `（@${step.ownerAgentId}）` : ''} [${step.status}]`)
          }
          if (plan.risks.length > 0) lines.push(`- 风险：${plan.risks.join('；')}`)
        }
        return { ok: true, text: clipToBudget(lines.join('\n')), rootTitle: '计划全景' }
      }
      case 'tasks': {
        const items = this.deps.tasks.list(input.sessionId)
        if (items.length === 0) {
          return { ok: false, error: '本会话还没有任务清单：让 Agent 产出任务（write_todos）后，再从任务生成脑图' }
        }
        const lines = items.map(
          (t) => `- [${t.status}] ${t.content}${t.ownerAgentId ? `（@${t.ownerAgentId}）` : ''}`,
        )
        return { ok: true, text: clipToBudget(lines.join('\n')), rootTitle: '任务全景' }
      }
      case 'memory': {
        const items = this.deps.memory.listScoped('session', input.sessionId, { status: 'active', limit: 80 })
        if (items.length === 0) {
          return { ok: false, error: '本会话还没有启用的记忆：在「向量记忆」中审核并启用候选后，再从记忆生成脑图' }
        }
        const lines = items.map((m) => `- [${m.kind}] ${m.content}`)
        return { ok: true, text: clipToBudget(lines.join('\n')), rootTitle: '记忆图谱' }
      }
      case 'topic': {
        const topic = input.topic?.trim()
        if (!topic) return { ok: false, error: '自定义主题来源需提供 topic' }
        return { ok: true, text: `主题：${topic}`, rootTitle: topic.slice(0, 40) }
      }
    }
  }
}

/** 对话渲染（单条限长；预算内取最近内容优先——脑图主题更依赖近段结论与待办） */
export function renderConversation(messages: ChatMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    const who = m.role === 'user' ? '用户' : `Agent(${m.agentId ?? '未知'})`
    const { text } = truncateToTokens(
      m.content.trim() || attachmentOnlyNote(m) || '（无文本，仅工具调用）',
      PER_MESSAGE_MAX_TOKENS,
    )
    lines.push(`[${who}] ${text}`)
    for (const call of m.toolCalls ?? []) {
      lines.push(`  · 工具 ${call.name}：${(call.summary ?? '').replace(/\s+/g, ' ').slice(0, 120)}`)
    }
  }
  // 预算截断：从最新往前累加（同记忆沉淀范式）
  let used = 0
  let from = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = countTokensCalibrated(lines[i] ?? '')
    if (used + cost > MIND_INPUT_BUDGET_TOKENS) break
    used += cost
    from = i
  }
  return lines.slice(from).join('\n')
}

/** 预算截断（超预算截尾，保证请求不爆窗） */
function clipToBudget(text: string): string {
  const { text: clipped } = truncateToTokens(text, MIND_INPUT_BUDGET_TOKENS)
  return clipped
}

/**
 * 模型输出 → 归一化脑图树（容忍缺失字段）：
 * - 根节点缺 title 用 fallbackTitle；子节点缺 title 丢弃；
 * - 深度 / 子节点数 / 标题长度按硬约束截断；
 * - 根节点无任何子节点视为无效（返回 undefined，由调用方给明确错误）。
 */
export function coerceMindTree(raw: unknown, fallbackTitle: string): MindTreeNode | undefined {
  const root = coerceNode(raw, 0, fallbackTitle)
  if (!root || !root.children || root.children.length === 0) return undefined
  return root
}

function coerceNode(raw: unknown, depth: number, fallbackTitle: string): MindTreeNode | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as { title?: unknown; children?: unknown }
  const title = String(r.title ?? '')
    .trim()
    .slice(0, MAX_TITLE_CHARS)
  const finalTitle = title || (depth === 0 ? fallbackTitle : '')
  if (!finalTitle) return undefined
  const node: MindTreeNode = { title: finalTitle }
  if (depth >= MAX_DEPTH - 1 || !Array.isArray(r.children)) return node
  const children: MindTreeNode[] = []
  for (const entry of r.children) {
    const child = coerceNode(entry, depth + 1, '')
    if (child) children.push(child)
    if (children.length >= MAX_CHILDREN) break
  }
  if (children.length > 0) node.children = children
  return node
}
