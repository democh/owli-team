/**
 * 上下文服务（M2）：回合装配 + 预算校验 + 压缩触发 + 快照（API）。
 *
 * prepareTurn：装配 → 估算 > 预算 × 0.7 → 压缩 → 重新装配。
 * snapshot：  供前端「上下文抽屉」展示 L0-L5 分层、水位、摘要与记忆。
 */
import type { ChatMessage, ContextLayer, ContextSnapshot, RecalledMemory, TurnMode } from '@multi-agent/shared'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from '../config.js'
import type { LlmMessageInput } from '../llm/provider.js'
import type { MemoryService, RecallOutcome } from '../memory/service.js'
import type { ArtifactStore } from '../store/artifacts.js'
import type { MemoryStore } from '../store/memory.js'
import type { PlanStore } from '../store/plans.js'
import type { PromptLibrary } from '../store/prompts.js'
import type { SessionMemberStore } from '../store/session-members.js'
import type { SessionStore } from '../store/sessions.js'
import type { SkillLibrary } from '../store/skills.js'
import type { SummaryStore } from '../store/summaries.js'
import type { UserStore } from '../store/users.js'
import { buildActivePlansBlock, buildSystemPrompt, buildTurnInstruction, buildWindow, foldWorkspaceListing, VISION_MAX_BYTES } from './assembler.js'
import type { RosterMember, TurnInstructionExtra } from './assembler.js'
import { parseDeliverableSpec, type DeliverableTier } from './deliverable-spec.js'
import { resolveMembers } from '../orchestration/members.js'
import { createUserLabelResolver } from './user-label.js'
import type { CompressionResult, Compressor } from './compressor.js'
import { countTokensCalibrated } from './tokenizer.js'
import { mimeOfExt } from '../util/mime.js'

/** 压缩触发线：装配估算 > 预算 × 该系数（计划 §四） */
export const COMPRESS_THRESHOLD = 0.7

export interface ContextServiceDeps {
  cfg: AppConfig
  prompts: PromptLibrary
  skills: SkillLibrary
  sessions: SessionStore
  artifacts: ArtifactStore
  memory: MemoryStore
  summaries: SummaryStore
  compressor: Compressor
  /** M24：计划存储（执行中计划装配 <active_plans>；缺省 = 不注入） */
  plans?: PlanStore
  /** M25：向量记忆服务（语义召回 L1.5；缺省 = 不召回，既有行为零差异） */
  memories?: MemoryService
  /** M57 P2：共享成员（共享会话人类消息署昵称；缺省 = 沿用【用户】） */
  members?: SessionMemberStore
  /** M57 P2：账号存储（昵称解析；与 members 同时提供才生效） */
  users?: UserStore
}

export interface PrepareTurnInput {
  sessionId: string
  agentId: string
  runId: string
  /** 已排队的后续发言（回合指令展示用） */
  queue: string[]
  /** 排除的消息（本回合/本波刚创建的 streaming 空消息；M16 扩展为数组） */
  excludeMessageIds?: string[]
  /** M16：本波并行成员（含自己；仅并行波传入） */
  parallelPeers?: string[]
  signal?: AbortSignal
  /** M24：本回合范式（plan / review 注入对应模板；缺省 execute = 与现状一致） */
  mode?: TurnMode
  /** M24：派发给本成员的执行步骤（execute 波追加「你负责的计划步骤」） */
  planSteps?: TurnInstructionExtra['planSteps']
  /** M24：评审目标（review 波注入） */
  reviewTargets?: TurnInstructionExtra['reviewTargets']
  /** M24：上一棒交接期望（{from, expectedOutput}；仅带期望时渲染） */
  handoffs?: TurnInstructionExtra['handoffs']
  /** M28：按需工具发现概览（<tool_discovery>；启用发现时注入 L3，未启用不注入） */
  toolDiscoveryBlock?: string
  /** M79-J（§8.8）：会话人类成员（human_roster + 回合交还指令；无人类 = 不注入） */
  humans?: Array<{ displayName: string; username: string; headline?: string }>
}

export interface PreparedTurn {
  system: string
  messages: LlmMessageInput[]
  turnInstruction: string
  layers: ContextLayer[]
  estimatedTokens: number
  /** M25：本回合语义召回明细（L1.5；未启用 / 无召回时 undefined） */
  recalled?: RecalledMemory[]
  /** 交付规格声明（用户消息解析；undefined = 未声明，按角色契约默认档） */
  deliverableSpec?: DeliverableTier
  /** 本回合发生了压缩（引擎据此 emit context:compressed） */
  compression?: {
    untilSeq: number
    beforeTokens: number
    afterTokens: number
    degraded: boolean
  }
}

export class ContextService {
  /** M16：会话级压缩互斥（并行波内多成员同时超预算时串行化；先到者压缩、后到者复用成果） */
  private compressions = new Map<string, Promise<unknown>>()
  /** M25：每会话最近一次召回（snapshot 复用；LRU 上限 50） */
  private lastRecalls = new Map<string, RecallOutcome>()

  constructor(private readonly deps: ContextServiceDeps) {}

  // ---------- M57 P2：共享会话昵称署名 ----------

  /** 共享会话（owner 之外存在 ≥1 共享成员）→ 返回昵称解析器；否则 undefined（行为零差异）。 */
  private userLabelResolver(sessionId: string): ((message: ChatMessage) => string | undefined) | undefined {
    return createUserLabelResolver(this.deps)(sessionId)
  }

  async prepareTurn(input: PrepareTurnInput): Promise<PreparedTurn> {
    const { cfg } = this.deps
    // M25：语义召回（超时 / 失败静默；同一回合的多次重装配复用同一结果）
    const recall = await this.recallFor(input)
    const first = this.assemble(input, recall)
    if (first.estimatedTokens <= cfg.contextBudgetTokens * COMPRESS_THRESHOLD) {
      return first
    }

    // M16：同水位幂等——记录压缩前水位；持锁后若先到者已推进水位，则直接复用成果并跳过重复广播
    const watermark = this.deps.summaries.get(input.sessionId)?.untilSeq ?? 0
    let reused = false
    const result = await this.withCompressionLock(input.sessionId, async () => {
      const current = this.deps.summaries.get(input.sessionId)?.untilSeq ?? 0
      if (current > watermark) {
        reused = true
        return undefined
      }
      return this.deps.compressor.compress({
        sessionId: input.sessionId,
        keepRecentTurns: cfg.keepRecentTurns,
        signal: input.signal,
        runId: input.runId,
      })
    })

    if (reused) {
      const second = this.assemble(input, recall)
      if (second.estimatedTokens <= cfg.contextBudgetTokens) return second
      // 复用后仍超总预算 → 走更激进压缩（正常广播本次结果）
      const forced = await this.withCompressionLock(input.sessionId, () =>
        this.deps.compressor.compress({ sessionId: input.sessionId, keepRecentTurns: 1, signal: input.signal, runId: input.runId }),
      )
      if (!forced?.compressed) return second
      const third = this.assemble(input, recall)
      return {
        ...third,
        compression: {
          untilSeq: forced.untilSeq,
          beforeTokens: first.estimatedTokens,
          afterTokens: third.estimatedTokens,
          degraded: forced.degraded,
        },
      }
    }

    if (!result?.compressed) return first

    let second = this.assemble(input, recall)
    let compression = {
      untilSeq: result.untilSeq,
      beforeTokens: first.estimatedTokens,
      afterTokens: second.estimatedTokens,
      degraded: result.degraded,
    }

    // M4：压缩后仍超总预算（发送前预算校验）→ 更激进地再压一次（只保留最近 1 个完整回合）
    if (second.estimatedTokens > cfg.contextBudgetTokens) {
      const forced = await this.withCompressionLock(input.sessionId, () =>
        this.deps.compressor.compress({ sessionId: input.sessionId, keepRecentTurns: 1, signal: input.signal, runId: input.runId }),
      )
      if (forced?.compressed) {
        second = this.assemble(input, recall)
        compression = {
          untilSeq: forced.untilSeq,
          beforeTokens: first.estimatedTokens,
          afterTokens: second.estimatedTokens,
          degraded: forced.degraded,
        }
      }
    }

    return { ...second, compression }
  }

  /** M4：强制压缩（context_length_exceeded 兜底重试路径），保留下限可指定（默认只留最近 1 回合） */
  async forceCompress(input: {
    sessionId: string
    runId?: string
    keepRecentTurns?: number
    signal?: AbortSignal
  }): Promise<CompressionResult> {
    return this.withCompressionLock(input.sessionId, () =>
      this.deps.compressor.compress({
        sessionId: input.sessionId,
        keepRecentTurns: Math.max(1, input.keepRecentTurns ?? 1),
        signal: input.signal,
        runId: input.runId,
      }),
    )
  }

  /** M16：会话级压缩互斥（同会话压缩串行化；先到者失败不阻塞后到者） */
  private async withCompressionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const pending = this.compressions.get(sessionId)
    if (pending) {
      try {
        await pending
      } catch {
        // 先到者失败：本路径自行压缩
      }
    }
    const task = fn()
    this.compressions.set(sessionId, task as Promise<unknown>)
    try {
      return await task
    } finally {
      if (this.compressions.get(sessionId) === (task as Promise<unknown>)) this.compressions.delete(sessionId)
    }
  }

  /** 快照：某会话（指定成员视角）的分层上下文结构（GET /api/sessions/:id/context） */
  snapshot(sessionId: string, agentId?: string): ContextSnapshot {
    const session = this.deps.sessions.getSession(sessionId)
    if (!session) throw new Error('会话不存在')
    // M25：复用最近一次召回（snapshot 不触发新召回）
    const recall = this.lastRecalls.get(sessionId)
    const targetId =
      agentId && session.participantIds.includes(agentId) ? agentId : (session.participantIds[0] ?? '')
    const prepared = targetId
      ? this.assemble({ sessionId, agentId: targetId, runId: 'snapshot', queue: [] }, recall)
      : undefined

    const summary = this.deps.summaries.get(sessionId)
    const budget = this.deps.cfg.contextBudgetTokens
    const estimated = prepared?.estimatedTokens ?? 0
    return {
      sessionId,
      budgetTokens: budget,
      estimatedTokens: estimated,
      usageRatio: budget > 0 ? Math.round((estimated / budget) * 100) / 100 : 0,
      layers: prepared?.layers ?? [],
      summary: summary?.content || undefined,
      untilSeq: summary?.untilSeq ?? 0,
      degraded: summary?.degraded ?? false,
      compressedAt: summary && summary.untilSeq > 0 ? summary.updatedAt : undefined,
      memory: this.deps.memory.list(sessionId),
      recalled: recall && recall.items.length > 0 ? recall.items : undefined,
    }
  }

  // ---------- 内部 ----------

  private assemble(input: PrepareTurnInput, recall?: RecallOutcome | null): PreparedTurn {
    const { cfg, prompts, skills, sessions, summaries, memory } = this.deps
    const agent = prompts.get(input.agentId)
    if (!agent) throw new Error(`角色 ${input.agentId} 不存在`)
    const session = sessions.getSession(input.sessionId)
    if (!session) throw new Error('会话不存在')
    // M77：花名册按成员实例投影（分身展示 `名字·灵魂名`，@ 寻址与队列/计划归属同源）
    const memberInfos = resolveMembers(session, prompts)
    const roster: RosterMember[] = memberInfos.map((m) => ({
      key: m.key,
      agentId: m.agentId,
      label: m.label,
      role: m.agent.role,
    }))
    const memberLabels: Record<string, string> = {}
    for (const m of memberInfos) memberLabels[m.key] = m.label

    // 灵魂（§26 · M77）：会话覆盖（经典）> 成员键内嵌（分身）> 角色默认（souls/default.md）；无灵魂 = 不注入
    const soul = prompts.soul(input.agentId, session.memberSouls?.[input.agentId])

    // 预载 Skill（front-matter skills 的正文直接进提示）
    const preloaded: Array<{ name: string; body: string }> = []
    for (const name of agent.skills ?? []) {
      const skill = skills.get(name)
      if (skill) preloaded.push({ name: skill.name, body: skill.body })
    }

    // L1 记忆 / L2 摘要
    const summaryRecord = summaries.get(input.sessionId)
    const summaryBlock =
      summaryRecord && summaryRecord.content
        ? `<session_summary>\n（以下是更早历史的摘要，原文已被省略）\n\n${summaryRecord.content}\n</session_summary>`
        : ''
    const memoryBlock = memory.render(input.sessionId)
    // M25 L1.5：语义召回块（预算截断已在 MemoryService 内完成）
    const recalledBlock = recall?.rendered ?? ''
    // 运行时上下文（时间 / 系统）：日期级进 system（L3 尾段，天级稳定护缓存）；时刻级进回合指令（每回合新建）
    const now = new Date()

    const systemPrompt = buildSystemPrompt({
      protocol: prompts.protocolText,
      groupProtocol: prompts.groupProtocol(agent.group),
      agent,
      agentBody: prompts.body(agent.id),
      soul: soul ?? undefined,
      // P1：声纹（voice.md；无文件 = undefined 不注入，行为零差异）
      voice: prompts.voice(agent.id),
      roster,
      selfKey: input.agentId,
      preloadedSkills: preloaded,
      skillsIndex: skills.indexText(),
      workspaceListing: foldWorkspaceListing(this.describeWorkspace(input.sessionId)),
      memoryBlock,
      recalledBlock,
      summaryBlock,
      // M24：执行中计划（无 plans 存储 / 无执行计划 → 空串不注入，保持现状零差异）
      activePlansBlock: buildActivePlansBlock(
        this.deps.plans?.byStatus(input.sessionId, ['executing']) ?? [],
        roster,
      ),
      // M28：按需工具发现概览（未启用发现 / 无未加载条目 → undefined 不注入）
      toolDiscoveryBlock: input.toolDiscoveryBlock,
      // M79-J（§8.8）：人类花名册软约束（无人类 → undefined 不注入，旧文本零差异）
      humans: input.humans,
      now,
    })

    // 交付规格（报告专业化）：从用户消息解析档位声明（会话级粘性；未声明 → undefined 不注入）
    const deliverableSpec = parseDeliverableSpec(
      sessions
        .messages(input.sessionId)
        .filter((m) => m.role === 'user' && m.content.trim())
        .map((m) => m.content),
    )

    // P1：声纹示例轮换（以会话消息数为种子，同一会话内逐回合轮转，防过拟合单一例句）
    const voiceExamples = prompts.voice(agent.id)?.examples ?? []
    const voiceExample =
      voiceExamples.length > 0
        ? voiceExamples[sessions.messages(input.sessionId).length % voiceExamples.length]
        : undefined

    const turnInstruction = buildTurnInstruction(
      agent,
      roster,
      input.queue,
      input.parallelPeers ?? [],
      input.mode ?? 'execute',
      {
        planSteps: input.planSteps,
        reviewTargets: input.reviewTargets,
        handoffs: input.handoffs,
        selfKey: input.agentId,
        deliverableSpec,
        voiceExample,
        // M79-J（§8.8）：人类交还指令（无人类 → 不注入）
        humans: input.humans?.map((h) => ({ displayName: h.displayName })),
        now,
      },
    )
    const instructionTokens = countTokensCalibrated(turnInstruction)
    const systemTokens =
      systemPrompt.layers.l0 +
      systemPrompt.layers.l1 +
      systemPrompt.layers.l1_5 +
      systemPrompt.layers.l2 +
      systemPrompt.layers.l3

    // L4/L5：预算驱动的对话窗口
    const fromSeq = summaryRecord?.untilSeq ?? 0
    const excludeIds = new Set(input.excludeMessageIds ?? [])
    const messages = sessions.messages(input.sessionId).filter((m) => !excludeIds.has(m.id))
    // 窗口预算 = 总预算 − 系统层 − 回合指令 − 余量；下限 400 保证至少带回最近一个回合
    const windowBudget = Math.max(400, cfg.contextBudgetTokens - systemTokens - instructionTokens - 256)
    // M33：图片附件加载（本次装配内缓存；读失败 / 越界静默降级为文本占位）
    const imageCache = new Map<string, { mime: string; dataUrl: string } | undefined>()
    const loadImage = (relPath: string): { mime: string; dataUrl: string } | undefined => {
      if (imageCache.has(relPath)) return imageCache.get(relPath)
      let result: { mime: string; dataUrl: string } | undefined
      try {
        const full = this.deps.artifacts.resolveSafe(input.sessionId, relPath)
        // 防御纵深：磁盘体积为准（消息内 size 元数据可能被伪造 / 为历史脏数据）；超限降级为文本占位
        const stat = fs.statSync(full)
        if (stat.isFile() && stat.size <= VISION_MAX_BYTES) {
          const buf = fs.readFileSync(full)
          const mime = mimeOfExt(path.extname(relPath))
          result = { mime, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
        }
      } catch {
        result = undefined
      }
      imageCache.set(relPath, result)
      return result
    }
    const window = buildWindow({
      messages,
      agentId: agent.id,
      // M77：分身实例自我判定与成员标签（他人消息前缀含 `·灵魂名`）
      selfKey: input.agentId,
      memberLabels,
      agents: prompts.list(),
      fromSeq,
      budgetTokens: windowBudget,
      toolDetailKeep: cfg.toolDetailKeep,
      loadImage,
      // M57 P2：共享会话（owner + ≥1 成员）人类消息署昵称；独占会话 / 兼容模式沿用【用户】
      userLabel: this.userLabelResolver(input.sessionId),
    })

    // 硬截断 / 压缩降级提示（L4 层）
    const notice =
      summaryRecord?.degraded || window.droppedGroups > 0
        ? '<context_notice>部分较早的历史消息已因上下文预算被省略。关键结论请查阅会话记忆、摘要或工作区文件；不要凭记忆臆测被省略的内容。</context_notice>'
        : ''
    const noticeTokens = notice ? countTokensCalibrated(notice) : 0

    const l4Tokens = Math.max(0, window.tokens - window.toolTokens)
    const layers: ContextLayer[] = [
      { key: 'L0', label: soul ? '协议 + 人设 + 灵魂' : '协议 + 人设', tokens: systemPrompt.layers.l0 },
      {
        key: 'L1',
        label: '会话记忆',
        tokens: systemPrompt.layers.l1,
        detail: memoryBlock ? undefined : '（暂无记忆）',
      },
      // M25：L1.5 语义召回（未装配 memories 时不显示，保证既有快照零差异）
      ...(this.deps.memories
        ? [
            {
              key: 'L1.5' as const,
              label: '语义召回',
              tokens: systemPrompt.layers.l1_5,
              detail: recalledBlock
                ? `${recall?.items.length ?? 0} 条（候选 ${recall?.candidates ?? 0}）`
                : (recall?.skipped ?? '（无召回）'),
            },
          ]
        : []),
      {
        key: 'L2',
        label: '历史摘要',
        tokens: systemPrompt.layers.l2,
        detail: summaryRecord
          ? `水位 seq=${summaryRecord.untilSeq}${summaryRecord.degraded ? '（上次压缩失败，已降级）' : ''}`
          : '（未压缩）',
      },
      { key: 'L3', label: '技能 / 工作区 / 运行时', tokens: systemPrompt.layers.l3 },
      { key: 'L4', label: '对话窗口', tokens: l4Tokens, detail: `${window.groups} 个回合组${window.retainedUserMessages > 0 ? `（早期用户发言保留 ${window.retainedUserMessages} 条）` : ''}` },
      { key: 'L5', label: '工具调用记录', tokens: window.toolTokens },
    ]

    return {
      system: notice ? `${systemPrompt.text}\n\n${notice}` : systemPrompt.text,
      messages: window.messages,
      turnInstruction,
      layers,
      estimatedTokens: systemTokens + noticeTokens + window.tokens + instructionTokens,
      recalled: recall && recall.items.length > 0 ? recall.items : undefined,
      deliverableSpec,
    }
  }

  /** M25：语义召回（超时 / 失败静默；查询 = 最近一条用户消息，回退最近一条非空消息） */
  private async recallFor(input: PrepareTurnInput): Promise<RecallOutcome | null> {
    const memories = this.deps.memories
    if (!memories) return null
    const session = this.deps.sessions.getSession(input.sessionId)
    if (!session) return null
    const query = this.recallQuery(this.deps.sessions.messages(input.sessionId), new Set(input.excludeMessageIds ?? []))
    if (!query) return null
    // 与 L1 去重：会话记忆块（active）中的条目不再注入
    const exclude = new Set(
      this.deps.memory.listScoped('session', input.sessionId, { status: 'active' }).map((item) => item.id),
    )
    const outcome = await memories.recall({
      query,
      sessionId: input.sessionId,
      agentId: input.agentId,
      projectId: session.projectId,
      exclude,
      // M57：多用户隔离（global 桶按用户切分 + 命中行按用户过滤；单用户兼容模式 session.ownerId 为空 → 行为同旧版）
      userId: session.ownerId,
      // P2：空间域隔离（同空间 + 跨域共享记忆可召回；缺省 default 与存量行为一致）
      spaceId: session.spaceId ?? 'default',
    })
    this.rememberRecall(input.sessionId, outcome)
    return outcome
  }

  /** 召回查询文本：最近一条用户消息优先（截断 500 字符），排除本回合 streaming 消息 */
  private recallQuery(messages: ChatMessage[], excluded: Set<string>): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!
      if (m.role === 'user' && !excluded.has(m.id) && m.content.trim()) return m.content.trim().slice(0, 500)
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!
      if (!excluded.has(m.id) && m.content.trim()) return m.content.trim().slice(0, 500)
    }
    return ''
  }

  /** 最近一次召回缓存（snapshot 复用；LRU 上限 50） */
  private rememberRecall(sessionId: string, outcome: RecallOutcome): void {
    this.lastRecalls.delete(sessionId)
    this.lastRecalls.set(sessionId, outcome)
    while (this.lastRecalls.size > 50) {
      const oldest = this.lastRecalls.keys().next().value
      if (oldest === undefined) break
      this.lastRecalls.delete(oldest)
    }
  }

  /** 工作区文件清单（>20 行由 foldWorkspaceListing 折叠为目录统计） */
  private describeWorkspace(sessionId: string): string {
    const files = this.deps.artifacts.list(sessionId)
    if (files.length === 0) return ''
    return files
      .slice(0, 40)
      .map((f) => `- ${f.path}（${Math.max(1, Math.round(f.size / 1024))}KB）`)
      .join('\n')
  }
}
