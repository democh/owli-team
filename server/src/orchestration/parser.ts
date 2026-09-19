/**
 * @ 解析器（§4 / §6.4）：
 * - 角色提及：匹配每个成员的 name（中文名）与 id，token 精确匹配（`@用户名` 不算 @用户、`@费利克斯` 不误判 `@费利`）；
 * - 交还判定：仅行首 `@用户 | @user | @你` 才算「交还用户」（ADR 4），句中提及不结束运行；
 * - M42（§71.5）：`::: minutes` 纪要容器内的 @ 是待办派活锚点（RT-4「用户确认后派活」），
 *   不构成即时应答转交——解析前剥离容器块（语法与 remark-ext 同源；未闭合不剥离，fail-safe）。
 */
import type { AgentDefinition } from '@multi-agent/shared'
import { MEMBER_SEP, USER_ALIASES } from '@multi-agent/shared'
import type { MemberInfo } from './members.js'

export interface ParseResult {
  text: string
  /** 解析出的成员键（按出现顺序去重，未经参与者过滤；M77 起支持分身实例键） */
  mentions: string[]
  /** 行首 @用户（交还信号） */
  handedToUser: boolean
}

/** @ 寻址目标：token → 命中的成员键列表（裸名 = 该角色主实例（编制序首位）） */
export interface MentionToken {
  token: string
  members: string[]
}

/**
 * M77：按会话成员实例构建 @ 寻址 token 表：
 * - 裸名（名字 / agentId）→ 该角色**主实例**（编制序首位，通常即首人格 / 经典实例）；
 * - 多实例时：`名字·灵魂名`（各实例有效灵魂）→ 单个实例；分身机器键 `agentId~soulId` 作为别名；
 * - 全伞（同角多位分身同时上场）改为**逐一点名**（显式优于隐式：裸名触发 N 轮/整波的代价不对称；
 *   Composer 候选提供「全部 N 位」一键插入）；
 * - 单实例行为与存量完全一致（裸名直达）。
 */
export function buildMentionTokens(members: MemberInfo[]): MentionToken[] {
  const tokens: MentionToken[] = []
  const seen = new Set<string>()
  const push = (token: string, membersOfToken: string[]): void => {
    const key = token.toLowerCase()
    if (!token || seen.has(key) || membersOfToken.length === 0) return
    seen.add(key)
    tokens.push({ token, members: membersOfToken })
  }
  // 按角色分组（保持编制序）
  const byAgent = new Map<string, MemberInfo[]>()
  for (const m of members) {
    const list = byAgent.get(m.agentId) ?? []
    list.push(m)
    byAgent.set(m.agentId, list)
  }
  for (const [agentId, list] of byAgent) {
    const agent = list[0]!.agent
    const primary = list[0]!.key
    // 裸名：名字与 id 均命中主实例（编制序首位）
    push(agent.name, [primary])
    push(agentId, [primary])
    if (list.length <= 1) continue
    // 多实例：实例级 token（名字·灵魂名）+ 分身机器键别名
    for (const m of list) {
      if (m.soulName) push(`${agent.name}·${m.soulName}`, [m.key])
      if (m.key.includes(MEMBER_SEP)) push(m.key, [m.key])
    }
  }
  return tokens
}

/** 存量兼容：按全局角色清单构建 token（角色 → 自身 id；不涉分身）。新调用方请用 buildMentionTokens + parseMentionsWithTokens。 */
export function parseMentions(raw: string, agents: AgentDefinition[]): ParseResult {
  const tokens: MentionToken[] = agents.map((a) => ({ token: a.name, members: [a.id] }))
  for (const a of agents) tokens.push({ token: a.id, members: [a.id] })
  return parseMentionsWithTokens(raw, tokens)
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 名字后不能紧跟字母 / 数字 / 下划线（避免 `@用户名`、`@pm2` 之类误匹配） */
const BOUNDARY = '(?![\\p{L}\\p{N}_])'
/**
 * M77：成员 token 边界额外排除 `·`——分身点名 token（`名字·灵魂名`）被拼错时
 * （如 `@卢娜·狂野哦`）不得回退到裸名分支（防「一个错字召唤全部实例」）。
 */
const MEMBER_BOUNDARY = '(?![\\p{L}\\p{N}_·])'

/** 容器标记行（与 remark-ext 同源：开标记 `::: name [参数]`、闭标记 `::: `；行首空白耐受、防 `::::`） */
const CONTAINER_OPEN_RE = /^:::(?!:)\s*([a-zA-Z][\w-]*)\s*(.*)$/
const CONTAINER_CLOSE_RE = /^:::\s*$/

/**
 * M42（§71.5）：剥离 `::: minutes` 容器块。纪要待办行 `- 待办 | @负责人 事项` 的 @ 是
 * 派活操作锚点（点击回填草稿、用户确认后发送），不是发言人的转交目标；不剥离会让引擎
 * 把纪要 owner 重新入队（无限外扩）。未闭合容器不剥离（与渲染侧「未闭合 → 内容展开」一致）。
 */
export function stripMinutesBlocks(raw: string): string {
  if (!raw.includes(':::')) return raw
  const lines = raw.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = CONTAINER_OPEN_RE.exec(lines[i]!.trim())
    if (!m || m[1]!.toLowerCase() !== 'minutes') {
      out.push(lines[i]!)
      continue
    }
    // 栈式匹配闭合（minutes 契约不含嵌套，此处按渲染侧语法容忍嵌套）
    let depth = 1
    let j = i + 1
    for (; j < lines.length && depth > 0; j++) {
      const t = lines[j]!.trim()
      if (CONTAINER_CLOSE_RE.test(t)) depth--
      else if (CONTAINER_OPEN_RE.test(t)) depth++
    }
    if (depth > 0) {
      // 未闭合：保持原文（fail-safe），后续行照常参与解析
      out.push(lines[i]!)
      continue
    }
    i = j - 1
  }
  return out.join('\n')
}

export function parseMentionsWithTokens(raw: string, tokens: MentionToken[]): ParseResult {
  const mentions: string[] = []
  // M42：minutes 容器内的 @ 不参与转交解析（派活锚点，用户确认制）
  const text = stripMinutesBlocks(raw)

  // 角色提及：组合 alternation，长 token 优先（回溯总能收敛到正确分支）
  const ordered = [...tokens].sort((a, b) => b.token.length - a.token.length)
  if (ordered.length > 0) {
    const lookup = new Map(ordered.map((t) => [t.token.toLowerCase(), t.members]))
    const alternation = ordered.map((t) => escapeRegExp(t.token)).join('|')
    const re = new RegExp(`@(${alternation})${MEMBER_BOUNDARY}`, 'giu')
    for (const match of text.matchAll(re)) {
      const members = lookup.get(match[1].toLowerCase())
      if (!members) continue
      // 裸名 fan-out：该角色全部实例按编制序追加（重复实例去重）
      for (const key of members) {
        if (!mentions.includes(key)) mentions.push(key)
      }
    }
  }

  // 行首 @用户（或 @user / @你）
  const userAlternation = USER_ALIASES.map(escapeRegExp).join('|')
  const userRe = new RegExp(`(?:^|\\n)[\\s>*_-]*@(${userAlternation})${BOUNDARY}`, 'iu')
  const handedToUser = userRe.test(text)

  return { text: raw, mentions, handedToUser }
}
