/**
 * @ 解析器（§4 / §6.4）：
 * - 角色提及：匹配每个成员的 name（中文名）与 id，token 精确匹配（`@用户名` 不算 @用户、`@费利克斯` 不误判 `@费利`）；
 * - 交还判定：仅行首 `@用户 | @user | @你` 才算「交还用户」（ADR 4），句中提及不结束运行；
 * - M42（§71.5）：`::: minutes` 纪要容器内的 @ 是待办派活锚点（RT-4「用户确认后派活」），
 *   不构成即时应答转交——解析前剥离容器块（语法与 remark-ext 同源；未闭合不剥离，fail-safe）。
 */
import type { AgentDefinition } from '@multi-agent/shared'
import { USER_ALIASES } from '@multi-agent/shared'

export interface ParseResult {
  text: string
  /** 解析出的成员 id（按出现顺序去重，未经参与者过滤） */
  mentions: string[]
  /** 行首 @用户（交还信号） */
  handedToUser: boolean
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 名字后不能紧跟字母 / 数字 / 下划线（避免 `@用户名`、`@pm2` 之类误匹配） */
const BOUNDARY = '(?![\\p{L}\\p{N}_])'

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

export function parseMentions(raw: string, agents: AgentDefinition[]): ParseResult {
  const mentions: string[] = []
  // M42：minutes 容器内的 @ 不参与转交解析（派活锚点，用户确认制）
  const text = stripMinutesBlocks(raw)

  // 角色提及：组合 alternation，长 token 优先（回溯总能收敛到正确分支）
  const tokens: Array<{ token: string; id: string }> = []
  for (const agent of agents) {
    tokens.push({ token: agent.name, id: agent.id })
    tokens.push({ token: agent.id, id: agent.id })
  }
  tokens.sort((a, b) => b.token.length - a.token.length)
  if (tokens.length > 0) {
    const lookup = new Map(tokens.map((t) => [t.token.toLowerCase(), t.id]))
    const alternation = tokens.map((t) => escapeRegExp(t.token)).join('|')
    const re = new RegExp(`@(${alternation})${BOUNDARY}`, 'giu')
    for (const match of text.matchAll(re)) {
      const id = lookup.get(match[1].toLowerCase())
      if (id && !mentions.includes(id)) mentions.push(id)
    }
  }

  // 行首 @用户（或 @user / @你）
  const userAlternation = USER_ALIASES.map(escapeRegExp).join('|')
  const userRe = new RegExp(`(?:^|\\n)[\\s>*_-]*@(${userAlternation})${BOUNDARY}`, 'iu')
  const handedToUser = userRe.test(text)

  return { text: raw, mentions, handedToUser }
}
