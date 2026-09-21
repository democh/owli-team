/**
 * 五层上下文装配（M2）：从「截断式」升级为「预算 + 分层」。
 *
 * L0 静态（协议 + 人设）     永不裁剪，字节级稳定（命中 prompt cache）
 * L1 记忆（<session_memory>） 永不裁剪，超限按 kind 优先级丢（MemoryStore.render）
 * L1.5 召回（<recalled_memory>）语义召回（M25）；预算截断由召回层完成
 * L2 摘要（<session_summary>）永不裁剪，滚动合并
 * L3 半静态（花名册 / 技能 / 工作区 / 运行时）可裁剪：>20 文件折叠为目录级统计
 * L4 动态（最近若干回合原文） 按 token 预算从后往前填「回合组」
 * L5 工具（历史工具调用）     优先裁剪：最近 N 条保留摘要，更早折叠
 *
 * 回合组原子性：切分/填充以组为单位，组内消息不拆分（当前架构历史中无独立
 * tool 消息，工具结果跟随其所属 agent 消息渲染，因此不存在「tool 消息孤儿」）。
 *
 * 运行时上下文（时间 / 系统）：两级注入以保护前缀缓存——日期 / 时区 / 运行环境
 * 进 L3 尾段 <runtime_context>（天级稳定，跨天前 system 字节级一致）；精确时刻
 * 进回合指令（每回合天然新建的最后一条 user 消息，零额外缓存损失）。
 */
import os from 'node:os'
import type { AgentDefinition, ChatMessage, MessageAttachment, Plan, SoulMeta, ToolCallRecord, TurnMode } from '@multi-agent/shared'
import type { LlmContentPart, LlmMessageInput } from '../llm/provider.js'
import { isVisionImage } from '../util/mime.js'
import { buildSpecInstructionLine, type DeliverableTier } from './deliverable-spec.js'
import { countTokensCalibrated, VISION_TOKENS_PER_IMAGE } from './tokenizer.js'

// ---------- L0-L3：system 提示 ----------

/** 灵魂段输入（store/prompts.ts 的 SoulDoc 投影；仅取装配所需字段） */
export interface SoulSegment {
  meta: SoulMeta
  quirks: string[]
  body: string
}

/**
 * M77：花名册成员（成员实例投影）。经典实例 = agentId；分身实例 = `agentId~soulId`；
 * label 为展示 token（多实例时含 `·灵魂名` 后缀）。存量调用方可直接传 AgentDefinition[]（自动归一）。
 */
export interface RosterMember {
  /** 成员键（@ 寻址与队列/计划归属依据） */
  key: string
  /** 基础角色 id */
  agentId: string
  /** 展示 token（裸名或 `名字·灵魂名`） */
  label: string
  role: string
}

/** 花名册归一（兼容存量调用方的 AgentDefinition[]） */
function toRosterMembers(roster: Array<RosterMember | AgentDefinition>): RosterMember[] {
  return roster.map((item) =>
    'key' in item ? item : { key: item.id, agentId: item.id, label: item.name, role: item.role },
  )
}

export interface SystemPromptInput {
  protocol: string
  /** 场景协议（可选，追加在全局协议之后） */
  groupProtocol?: string
  agent: AgentDefinition
  agentBody: string
  /** 灵魂段（可选：会话覆盖 > 角色默认；无灵魂 = 不注入） */
  soul?: SoulSegment
  /** 团队成员（含自己；M77：成员实例投影，兼容 AgentDefinition[]） */
  roster: Array<RosterMember | AgentDefinition>
  /** M77：本回合说话成员键（分身实例标识；缺省 = 经典实例） */
  selfKey?: string
  /** 预载 Skill（front-matter skills，正文直接进提示） */
  preloadedSkills: Array<{ name: string; body: string }>
  /** <available_skills> 常驻索引 */
  skillsIndex: string
  /** 工作区文件清单（无文件时为空串） */
  workspaceListing: string
  /** L1：会话记忆块（<session_memory>…</session_memory>，无记忆时为空串） */
  memoryBlock: string
  /** M25 L1.5：语义召回块（<recalled_memory>…</recalled_memory>，无召回时为空串） */
  recalledBlock?: string
  /** L2：历史摘要块（<session_summary>…</session_summary>，未压缩时为空串） */
  summaryBlock: string
  /** M79-J（§8.8）：会话人类成员（<human_roster> 软约束注入；无人类 = 不注入，旧文本零差异） */
  humans?: Array<{ displayName: string; username: string; headline?: string }>
  /** M24：执行中计划块（<active_plans>…</active_plans>，无执行计划时为空串） */
  activePlansBlock?: string
  /** M28：按需工具发现块（<tool_discovery>…</tool_discovery>；未启用 / 无未加载条目时为空串） */
  toolDiscoveryBlock?: string
  /** 运行时上下文（L3 尾段 <runtime_context>：日期 / 时区 / 运行环境）；缺省取当前时刻 */
  now?: Date
}

export interface SystemLayerTokens {
  l0: number
  l1: number
  /** M25：语义召回（<recalled_memory>）token 数 */
  l1_5: number
  l2: number
  l3: number
}

export interface SystemPromptOutput {
  text: string
  layers: SystemLayerTokens
}

/** 工作区清单折叠：超过 maxLines 行时按目录聚合（L3 裁剪策略） */
export function foldWorkspaceListing(listing: string, maxLines = 20): string {
  const lines = listing.split('\n').filter((l) => l.trim() !== '')
  if (lines.length <= maxLines) return listing
  const byDir = new Map<string, number>()
  for (const line of lines) {
    const filePath = line.replace(/^-\s*/, '').replace(/（.*$/, '')
    const idx = filePath.lastIndexOf('/')
    const dir = idx > 0 ? filePath.slice(0, idx) : '（根目录）'
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1)
  }
  const summary = [...byDir.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([dir, n]) => `- ${dir}/：${n} 个文件`)
  return `${summary.join('\n')}\n（文件较多已折叠为目录统计；用 list_dir 查看明细）`
}

// ---------- 运行时上下文（时间 / 系统） ----------

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 运行系统展示名（darwin → macOS 等；带架构） */
function platformLabel(): string {
  const arch = os.arch()
  const name =
    process.platform === 'darwin'
      ? 'macOS'
      : process.platform === 'win32'
        ? 'Windows'
        : process.platform === 'linux'
          ? 'Linux'
          : process.platform
  return `${name}（${arch}）`
}

/** 本地时区展示（IANA 名 + UTC 偏移；如 Asia/Shanghai（UTC+8）） */
function timezoneLabel(now: Date): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const offsetMin = -now.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  const offset = abs % 60 === 0 ? `UTC${sign}${abs / 60}` : `UTC${sign}${Math.floor(abs / 60)}:${pad2(abs % 60)}`
  return `${zone}（${offset}）`
}

/**
 * 运行时上下文块（L3 尾段）：当前日期 / 时区 / 运行环境。
 * 天级稳定：同一天内任意时刻装配结果字节级一致（不破坏 system 前缀缓存）；
 * 精确时刻由回合指令注入（buildTurnInstruction），跨天时仅尾段变化。
 */
export function buildRuntimeContext(now: Date = new Date()): string {
  const weekday = WEEKDAYS[now.getDay()]
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
  return [
    '<runtime_context>',
    `- 当前日期：${date}（${weekday}）；时区：${timezoneLabel(now)}`,
    `- 运行环境：${platformLabel()}`,
    '- 涉及「今天 / 明天 / 本周 / 今年」等相对日期时一律以此为准；精确时刻见回合指令；时效性信息（价格 / 政策 / 新闻 / 版本）不要凭训练记忆臆断，以可核实的最新来源为准。',
    '</runtime_context>',
  ].join('\n')
}

/** 灵魂段（L0 组成部分：只影响表达风格；职责与协议优先级更高） */
function buildSoulSection(soul: SoulSegment): string {
  const parts: string[] = [`# 你的灵魂：${soul.meta.name}（${soul.meta.id}）`]
  if (soul.meta.tagline) parts.push(soul.meta.tagline)
  const profile: string[] = []
  if (soul.meta.tone) profile.push(`- 语气与表达：${soul.meta.tone}`)
  if (soul.meta.traits.length > 0) profile.push(`- 性格特质：${soul.meta.traits.join('、')}`)
  if (soul.quirks.length > 0) profile.push(`- 口癖与小习惯：${soul.quirks.join('；')}`)
  if (profile.length > 0) parts.push(profile.join('\n'))
  if (soul.body.trim()) parts.push(soul.body.trim())
  parts.push('（灵魂只影响表达风格与互动方式；你的职责边界、事实准确性与协作规则的优先级更高，不得因风格牺牲准确性。）')
  return parts.join('\n\n')
}

export function buildSystemPrompt(input: SystemPromptInput): SystemPromptOutput {
  const { protocol, groupProtocol, agent, agentBody, preloadedSkills, skillsIndex, workspaceListing, soul } = input
  const roster = toRosterMembers(input.roster)
  const rosterLine = roster.map((m) => `${m.label}（${m.key}｜${m.role}）`).join('、')
  // 交接对象：角色 id → 实例（优先经典实例，否则该角色首个实例）
  const memberOfAgent = (agentId: string): RosterMember | undefined =>
    roster.find((m) => m.key === agentId) ?? roster.find((m) => m.agentId === agentId)
  const handoffLine = agent.handoff.length
    ? agent.handoff
        .map((id) => memberOfAgent(id))
        .filter((m): m is RosterMember => Boolean(m))
        .map((m) => `${m.label}（${m.key}）`)
        .join('、')
    : '（无预设，按需选择）'
  // M77：同角多实例寻址指南（仅真有分身时注入，避免无谓提示）
  const multiCounts = new Map<string, number>()
  for (const m of roster) multiCounts.set(m.agentId, (multiCounts.get(m.agentId) ?? 0) + 1)
  const hasMulti = [...multiCounts.values()].some((n) => n > 1)
  const self = input.selfKey ? roster.find((m) => m.key === input.selfKey) : undefined
  const identityNote = self && self.label !== agent.name ? `\n\n你在本会话的身份标识：${self.label}（${self.key}）——与其他同名分身区分使用。` : ''

  // L0：全局协议 +（场景协议）+ 人设 +（灵魂段）——顺序与内容在会话内稳定，命中 prompt cache
  const l0 = [
    protocol.trim(),
    (groupProtocol ?? '').trim(),
    `# 你当前的角色\n\n你是 **${agent.name}**（${agent.role}）。${identityNote}\n\n${agentBody.trim()}`,
    soul ? buildSoulSection(soul) : '',
  ]
    .filter((s) => s !== '')
    .join('\n\n---\n\n')

  // L1：会话记忆
  const l1 = input.memoryBlock.trim()

  // L1.5：语义召回（M25；预算截断已在召回层完成）
  const l1_5 = (input.recalledBlock ?? '').trim()

  // L2：历史摘要
  const l2 = input.summaryBlock.trim()

  // L3：花名册 / 技能 / 工作区（可裁剪）
  const l3Sections: string[] = [
    `# 团队花名册\n\n本会话成员：${rosterLine}\n\n你的常用交接对象：${handoffLine}${
      hasMulti
        ? '\n\n同名多实例寻址：@名字 只召集该角色的主实例（编制首位）；想让同角多位分身同时上场，请逐一点名（@名字·灵魂名）。'
        : ''
    }`,
  ]
  // M79-J（§8.8）：人类花名册软约束（仅当在场人类非空；<300 token）
  if (input.humans && input.humans.length > 0) {
    const humanLine = input.humans
      .map((h) => `${h.displayName}${h.headline ? `（${h.headline}）` : ''} · @${h.username}`)
      .join(' · ')
    l3Sections.push(
      `<human_roster>\n本会话人类成员（可点名交付）：${humanLine}\n人类之间的交流是讨论与协调，无需你响应；仅当被点名或指令明确指向你时行动。\n需要把任务交给具体的人：在回复行首用 @显示名，运行将交还并通知对方。\n</human_roster>`,
    )
  }
  if (preloadedSkills.length > 0) {
    l3Sections.push(preloadedSkills.map((s) => `# 已装载技能：${s.name}\n\n${s.body.trim()}`).join('\n\n'))
  }
  if (skillsIndex) l3Sections.push(`# 可加载的技能（需要时用 load_skill 工具加载正文）\n\n${skillsIndex}`)
  if (workspaceListing) {
    l3Sections.push(
      `# 当前工作区文件\n\n${workspaceListing}\n\n用 read_file 可查看内容；产出交付件请用 write_file 写入本工作区。`,
    )
  }
  // M24：执行中计划（L3 半静态；全员可见，任务面板与提示词同源）
  const activePlansBlock = (input.activePlansBlock ?? '').trim()
  if (activePlansBlock) l3Sections.push(activePlansBlock)
  // M28：按需工具发现（L3 半静态；未加载能力类别概览 + tool_search 引导）
  const toolDiscoveryBlock = (input.toolDiscoveryBlock ?? '').trim()
  if (toolDiscoveryBlock) l3Sections.push(toolDiscoveryBlock)
  // 运行时上下文（L3 尾段；天级稳定——同一天内字节级一致，时刻不进 system 以保护前缀缓存）
  l3Sections.push(buildRuntimeContext(input.now))
  const l3 = l3Sections.join('\n\n---\n\n')

  const sections = [l0, l1, l1_5, l2, l3].filter((s) => s.trim() !== '')
  const layers: SystemLayerTokens = {
    l0: countTokensCalibrated(l0),
    l1: l1 ? countTokensCalibrated(l1) : 0,
    l1_5: l1_5 ? countTokensCalibrated(l1_5) : 0,
    l2: l2 ? countTokensCalibrated(l2) : 0,
    l3: countTokensCalibrated(l3),
  }
  return { text: sections.join('\n\n---\n\n'), layers }
}

// ---------- L4 / L5：对话窗口 ----------

export interface WindowInput {
  /** 会话全部消息（按 seq 升序） */
  messages: ChatMessage[]
  agentId: string
  /** M77：本回合说话成员键（分身实例；缺省 = 经典实例 agentId） */
  selfKey?: string
  /** M77：成员键 → 展示标签（他人消息前缀用；缺省 = 角色名） */
  memberLabels?: Record<string, string>
  agents: AgentDefinition[]
  /** 压缩水位：只取 seq > fromSeq 的消息 */
  fromSeq: number
  /** L4+L5 可用 token 预算 */
  budgetTokens: number
  /** L5：最近 N 条工具调用保留参数与摘要，更早折叠 */
  toolDetailKeep: number
  /**
   * M33：图片加载回调（同步）——图片附件 → data URL；未提供 = 不注入图片（保持纯文本）。
   * 由 ContextService 注入（读文件 + 会话内缓存 + 体积护栏）。
   */
  loadImage?: (relPath: string) => { mime: string; dataUrl: string } | undefined
  /**
   * M57 P2：共享会话（≥2 人类）的人类消息署名解析（返回昵称；缺省 / 未命中 = 【用户】）。
   * 由 ContextService 注入（共享会话才提供；单用户 / 独占会话行为零差异）。
   */
  userLabel?: (message: ChatMessage) => string | undefined
}

export interface WindowOutput {
  messages: LlmMessageInput[]
  /** 窗口总 token（含工具渲染） */
  tokens: number
  /** 其中工具渲染部分的 token（L5） */
  toolTokens: number
  /** 纳入的回合组数 */
  groups: number
  /** 因预算被丢弃的组数（>0 时 system 需提示「部分历史已省略」） */
  droppedGroups: number
  truncated: boolean
}

interface RenderedMessage {
  message: ChatMessage
  text: string
  toolTokens: number
  tokens: number
}

const MESSAGE_OVERHEAD = 4
const ARGS_PREVIEW_CHARS = 140
/** M33：视觉注入护栏——全窗口最多图片数 / 单条消息最多图片数 / 单图体积上限（超出降级为文本占位） */
const VISION_MAX_IMAGES = 6
const VISION_MAX_PER_MESSAGE = 4
export const VISION_MAX_BYTES = 8 * 1024 * 1024

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** 附件一句话描述（文本占位与视觉通道并行：模型看图，文本保留文件名与元信息） */
function describeAttachment(att: MessageAttachment): string {
  const size = humanSize(att.size)
  if (att.kind === 'image') {
    const dim = att.width && att.height ? `${att.width}×${att.height}，` : ''
    return `图片，${dim}${size}`
  }
  if (att.kind === 'video') {
    const dur = att.durationMs ? `时长 ${(att.durationMs / 1000).toFixed(1)}s，` : ''
    return `视频，${dur}${size}`
  }
  if (att.kind === 'office' || att.kind === 'pdf') return `文档，${size}，可用 read_file 读取内容`
  return `${att.kind}，${size}`
}

/** M33：附件清单块（无附件时为空串） */
function renderAttachments(message: ChatMessage): string {
  const list = message.attachments ?? []
  if (list.length === 0) return ''
  return `\n\n[附件]\n${list.map((a) => `- ${a.name}（${describeAttachment(a)}）`).join('\n')}`
}

/** 单条工具调用的投影：detail 保留参数与摘要；折叠只保留一行摘要 */
function renderToolCall(call: ToolCallRecord, detail: boolean): string {
  const summary = (call.summary ?? call.status).replace(/\s+/g, ' ').slice(0, detail ? 200 : 80)
  if (!detail) return `- ${call.name} → ${summary}`
  const argsText = JSON.stringify(call.args ?? {})
  const args = argsText.length > ARGS_PREVIEW_CHARS ? `${argsText.slice(0, ARGS_PREVIEW_CHARS)}…` : argsText
  return `- ${call.name}${args === '{}' ? '' : `(${args})`} → ${summary}`
}

/** 对话窗口投影：自己 → assistant；他人 → assistant + 身份前缀；用户 → user + 【昵称 / 用户】前缀（共享会话署昵称） */
function projectContent(
  message: ChatMessage,
  selfKey: string,
  agents: AgentDefinition[],
  memberLabels?: Record<string, string>,
  userLabel?: (message: ChatMessage) => string | undefined,
): string {
  if (message.role === 'user') return `【${userLabel?.(message) ?? '用户'}】${message.content}`
  const key = message.memberKey ?? message.agentId
  if (key === selfKey) return message.content
  const other = agents.find((a) => a.id === message.agentId)
  const label = memberLabels?.[key ?? ''] ?? other?.name
  const prefix = other ? `${label ?? other.name}｜${other.role}` : label ?? (message.agentId ?? '未知成员')
  return `【${prefix}】${message.content}`
}

/**
 * 预算驱动的窗口装配：
 * 1. 过滤水位后的消息并渲染（含 L5 工具折叠）；
 * 2. 按「回合组」（以 user 消息为界）从后往前填充预算；
 * 3. 最近的组超预算时对其内部消息做行级截断（保证至少带回最后一个回合）。
 */
export function buildWindow(input: WindowInput): WindowOutput {
  const { messages, agentId, agents, fromSeq, budgetTokens, toolDetailKeep, loadImage, userLabel } = input
  const selfKey = input.selfKey ?? agentId

  const visible = messages.filter(
    (m) =>
      m.role !== 'system' &&
      (m.seq ?? 0) > fromSeq &&
      // M33：纯附件消息（无正文）同样进入窗口（文本占位 + 视觉注入依据）
      (m.content.trim() !== '' || (m.toolCalls?.length ?? 0) > 0 || (m.attachments?.length ?? 0) > 0),
  )
  if (visible.length === 0) {
    return { messages: [], tokens: 0, toolTokens: 0, groups: 0, droppedGroups: 0, truncated: false }
  }

  // L5：全局统计工具调用，最近 toolDetailKeep 条保留 detail
  const toolEntries: Array<{ m: number; c: number }> = []
  visible.forEach((m, i) => {
    for (let c = 0; c < (m.toolCalls?.length ?? 0); c++) toolEntries.push({ m: i, c })
  })
  const detailFrom = Math.max(0, toolEntries.length - toolDetailKeep)
  const detailSet = new Set(toolEntries.slice(detailFrom).map((e) => `${e.m}:${e.c}`))

  const rendered: RenderedMessage[] = visible.map((m, i) => {
    const base = projectContent(m, selfKey, agents, input.memberLabels, userLabel)
    const attachmentBlock = renderAttachments(m)
    const callLines = (m.toolCalls ?? []).map((call, c) => renderToolCall(call, detailSet.has(`${i}:${c}`)))
    const toolBlock = callLines.length > 0 ? `\n\n[工具调用]\n${callLines.join('\n')}` : ''
    const text = `${base}${attachmentBlock}${toolBlock}`
    const toolTokens = toolBlock ? countTokensCalibrated(toolBlock) : 0
    return { message: m, text, toolTokens, tokens: countTokensCalibrated(text) + MESSAGE_OVERHEAD }
  })

  // 回合组：以 user 消息为组边界（组内保持原子）
  const groups: RenderedMessage[][] = []
  for (const item of rendered) {
    if (item.message.role === 'user' || groups.length === 0) groups.push([])
    groups[groups.length - 1].push(item)
  }

  const selected: RenderedMessage[][] = []
  let used = 0
  let droppedGroups = 0
  for (let i = groups.length - 1; i >= 0; i--) {
    const cost = groups[i].reduce((n, item) => n + item.tokens, 0)
    if (selected.length > 0 && used + cost > budgetTokens) {
      droppedGroups = i + 1
      break
    }
    selected.unshift(groups[i])
    used += cost
  }

  // 最近的组仍超预算 → 组内行级截断（保证最后一个回合尽量完整带回）
  let truncated = false
  if (used > budgetTokens && selected.length > 0) {
    const group = selected[0]
    const per = Math.max(120, Math.floor(budgetTokens / Math.max(1, group.length)))
    for (const item of group) {
      if (item.tokens <= per) continue
      const kept = splitLinesByTokens(item.text, per)
      if (kept !== item.text) {
        item.text = `${kept}\n\n（受上下文预算限制，此消息后续内容已省略）`
        item.tokens = countTokensCalibrated(item.text) + MESSAGE_OVERHEAD
        truncated = true
      }
    }
    used = selected.flat().reduce((n, item) => n + item.tokens, 0)
  }

  const flat = selected.flat()
  // M33：视觉注入——最近消息的图片附件升级为多模态内容块（从后往前填充，全局与单条双重限量；
  // 未注入的图片仍保留文本占位，模型可感知其存在并提示用户重新发送或改用文字描述）
  const windowMessages: LlmMessageInput[] = flat.map((item) => ({
    role: item.message.role === 'user' ? ('user' as const) : ('assistant' as const),
    content: item.text,
  }))
  let visionTokens = 0
  if (loadImage) {
    let remaining = VISION_MAX_IMAGES
    for (let i = flat.length - 1; i >= 0 && remaining > 0; i--) {
      const images = (flat[i].message.attachments ?? [])
        .filter((a) => a.kind === 'image' && isVisionImage(a.mime) && a.size <= VISION_MAX_BYTES)
        .slice(0, VISION_MAX_PER_MESSAGE)
      if (images.length === 0) continue
      const parts: LlmContentPart[] = [{ type: 'text', text: flat[i].text }]
      for (const img of images) {
        if (remaining <= 0) break
        const loaded = loadImage(img.path)
        if (!loaded) continue
        parts.push({ type: 'image_url', image_url: { url: loaded.dataUrl } })
        remaining--
        visionTokens += VISION_TOKENS_PER_IMAGE
      }
      if (parts.length > 1) windowMessages[i].content = parts
    }
  }
  return {
    messages: windowMessages,
    tokens: used + visionTokens,
    toolTokens: flat.reduce((n, item) => n + item.toolTokens, 0),
    groups: selected.length,
    droppedGroups,
    truncated,
  }
}

/** 按 token 上限保留完整行前缀（行边界截断） */
function splitLinesByTokens(text: string, maxTokens: number): string {
  const lines = text.split('\n')
  const out: string[] = []
  let used = 0
  for (const line of lines) {
    const cost = countTokensCalibrated(line) + 1
    if (used + cost > maxTokens && out.length > 0) break
    out.push(line)
    used += cost
  }
  return out.join('\n')
}

// ---------- 回合指令 ----------

/** M24：执行中计划块（L3；用户可见字段与任务面板同口径，步骤负责人全员可读） */
const PLAN_STEP_ICON = { pending: '☐', in_progress: '◐', done: '☑', blocked: '⛔', skipped: '⇥' } as const

export function buildActivePlansBlock(plans: Plan[], roster: Array<RosterMember | AgentDefinition>): string {
  if (plans.length === 0) return ''
  const members = toRosterMembers(roster)
  const nameOf = (id: string) => members.find((m) => m.key === id)?.label ?? id
  const blocks: string[] = []
  for (const plan of plans) {
    const doneCount = plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length
    const stepLines = plan.steps.map((step) => {
      const meta = [`负责人：${nameOf(step.ownerAgentId ?? plan.agentId)}`]
      if (step.mode === 'review') meta.push('范式：评审')
      if (step.expectedOutput) meta.push(`期望产出：${step.expectedOutput}`)
      if (step.acceptance) meta.push(`验收：${step.acceptance}`)
      return `- ${PLAN_STEP_ICON[step.status]} ${step.id} ${step.content}｜${meta.join('｜')}`
    })
    blocks.push(`## 计划「${plan.title}」（${plan.id}｜进度 ${doneCount}/${plan.steps.length}）\n目标：${plan.goal}\n${stepLines.join('\n')}`)
  }
  return `<active_plans>\n（以下计划正在执行中；你负责的步骤用 update_plan_step 汇报进度）\n\n${blocks.join('\n\n')}\n</active_plans>`
}

/** M24：回合指令的范式扩展（计划派发 / 评审目标 / 上一棒交接期望） */
export interface TurnInstructionExtra {
  /** 派发给本成员的执行步骤（execute 波追加「你负责的计划步骤」行） */
  planSteps?: Array<{
    planId: string
    stepId: string
    content: string
    acceptance?: string
    expectedOutput?: string
  }>
  /** 评审目标（review 模板注入；target 如 step:s1 / plan:pl_x） */
  reviewTargets?: Array<{ target: string; content?: string }>
  /** 收到的交接期望（仅有 expectedOutput 时渲染「上一棒期望」行，保证旧文本不变） */
  handoffs?: Array<{ from: string; expectedOutput?: string }>
  /** M77：本回合说话成员键（分身实例；缺省 = 经典实例 agent.id） */
  selfKey?: string
  /** M79-J（§8.8）：在场人类（收尾段「行首 @显示名 交还」指令；无人类 = 不注入） */
  humans?: Array<{ displayName: string }>
  /** 交付规格声明（用户消息解析；execute 波注入档位提示行） */
  deliverableSpec?: DeliverableTier
  /** 运行时时刻（HH:mm 行）；缺省取当前时刻 */
  now?: Date
}

/** 回合指令：附加在窗口末尾的最后一条 user 消息（M24：按范式选择模板；execute 保持现文本） */
export function buildTurnInstruction(
  agent: AgentDefinition,
  roster: Array<RosterMember | AgentDefinition>,
  queue: string[],
  parallelPeers: string[] = [],
  mode: TurnMode = 'execute',
  extra: TurnInstructionExtra = {},
): string {
  const members = toRosterMembers(roster)
  const selfKey = extra.selfKey ?? agent.id
  const labelOf = (key: string): string => members.find((m) => m.key === key)?.label ?? key
  const others = members.filter((m) => m.key !== selfKey).map((m) => `${m.label}（${m.key}）`)
  const queueLine = queue.length ? queue.map((id) => labelOf(id)).join(' → ') : '（无）'
  const lines: string[] = []
  if (mode === 'plan') {
    lines.push(
      `现在轮到你（${agent.name}）以规划范式发言（本轮只读：不写文件、不执行改动）。`,
      `- 你的任务：基于当前上下文产出可执行的协作计划，并调用 write_plan 工具提交（提交后本回合挂起，等待用户批准或驳回）；`,
      `- 步骤要求：每步包含内容与负责人（owner，必须是本会话在场成员）；建议附期望产出（expected_output）或验收标准（acceptance）；`,
      `- 被驳回时按反馈修订后重新提交；批准后引擎将按步骤负责人派发执行；`,
      `- 可交接成员：${others.join('、')}；`,
      `- 已排队的后续发言：${queueLine}。`,
    )
  } else if (mode === 'review') {
    const targets = extra.reviewTargets?.length
      ? extra.reviewTargets.map((t) => `${t.target}${t.content ? `（${t.content}）` : ''}`).join('；')
      : '（见上下文中的计划与近期产出）'
    lines.push(
      `现在轮到你（${agent.name}）以评审范式发言（只读评审：不写文件、不执行改动）。`,
      `- 评审目标：${targets}；`,
      `- 请核对事实与验收标准，调用 submit_review 工具给出结构化判定（pass / conditional / fail）与发现、证据；fail 会阻塞对应步骤或计划，请给出可修复的明确依据；`,
      `- 可交接成员：${others.join('、')}；`,
      `- 已排队的后续发言：${queueLine}。`,
    )
  } else {
    lines.push(
      `现在轮到你（${agent.name}）发言。`,
      `- 若需要队友继续推进，请在回复末尾另起一行写「@成员名 交接说明」，行首 @ 才会生效；`,
      `- 若需要用户拍板或补充信息，请另起一行以 @用户 开头；`,
      `- 需要暂时不在场的角色协作时，直接 handoff 该角色（平台会自动召集后接手）；`,
      `- 可交接成员：${others.join('、')}；`,
      `- 已排队的后续发言：${queueLine}。`,
    )
    const specLine = buildSpecInstructionLine(extra.deliverableSpec)
    if (specLine) lines.push(specLine)
  }
  if (parallelPeers.length > 0) {
    const peers = parallelPeers.map((id) => labelOf(id)).join('、')
    lines.splice(1, 0, `- 本波并行成员：${peers}（你们同时工作、各自独立输出，完成后统一汇总；不要依赖对方的本轮输出）。`)
  }
  // 输出语言纪律（全局协议 <output_contract> 的回合级复述）：防止工具调用前的说明句漂移为英文
  lines.splice(1, 0, '- 全程使用简体中文输出（含工具调用前的说明句）；技术术语 / 工具名 / 文件路径可保留英文。')
  // 运行时时刻（分钟级——回合指令每回合天然新建，不进 system 以保护前缀缓存；日期 / 时区见 <runtime_context>）
  const now = extra.now ?? new Date()
  lines.splice(1, 0, `- 当前时刻：${pad2(now.getHours())}:${pad2(now.getMinutes())}（当天日期与时区见系统提示）。`)
  // M24：计划派发 —— 你负责的步骤（完成后用 update_plan_step 汇报）
  if (extra.planSteps?.length) {
    const assigned = extra.planSteps
      .map((s) => `${s.stepId} ${s.content}${s.acceptance ? `（验收：${s.acceptance}）` : ''}`)
      .join('；')
    lines.push(`- 你负责的计划步骤（完成后用 update_plan_step 汇报）：${assigned}。`)
  }
  // M24：上一棒交接期望（仅带期望产出时渲染，保持既有指令文本零差异）
  for (const handoff of extra.handoffs ?? []) {
    if (!handoff.expectedOutput) continue
    lines.push(`- 上一棒期望（来自 ${handoff.from}）：${handoff.expectedOutput}`)
  }
  // M79-J（§8.8）：人类交还指令（仅在场人类非空；行首 @显示名 = 指定交还）
  if ((extra.humans?.length ?? 0) > 0) {
    const names = extra.humans!.map((h) => `@${h.displayName}`).join(' / ')
    lines.push(`- 可把任务交还给具体的人（行首 ${names}），或 @用户 泛指交还。`)
  }
  return lines.join('\n')
}
