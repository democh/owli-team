/**
 * M52-A：场景工作区派生（纯函数）——从消息派生面板与元件数据（§7.3 数据来源：纯前端派生）。
 * 容器行级解析与 md-ext remark-ext 同语义：`::: name arg` 块 / 字段行「键：值」/ 条目行「- 键 | 值」；
 * 未闭合块直接忽略（Markdown 渲染层会回退原文，此处不产生数据）。
 */
import type { ChatMessage } from '@multi-agent/shared'
import { parseVerdictArg, verdictStatusFromItems, type VerdictStatus } from '../../lib/verdict'

// ---------- ::: 容器块 ----------

export interface ParsedContainer {
  name: string
  /** 完整参数串（`pan bazi 主盘` → 'bazi 主盘'；`verdict 多方 终局` → '多方 终局'） */
  arg: string
  /** 块内原文行（不含首尾 ::: 行） */
  lines: string[]
  /** 整块原文（含 ::: 行；复制 / 兜底渲染用） */
  raw: string
}

const OPEN_RE = /^:::(?!:)\s*([a-zA-Z][\w-]*)\s*(.*)$/
const CLOSE_RE = /^:::\s*$/

export function parseContainers(content: string): ParsedContainer[] {
  const out: ParsedContainer[] = []
  const lines = content.split('\n')
  let i = 0
  while (i < lines.length) {
    const m = OPEN_RE.exec(lines[i]!)
    if (!m) {
      i++
      continue
    }
    let j = i + 1
    while (j < lines.length && !CLOSE_RE.test(lines[j]!)) j++
    if (j >= lines.length) {
      // 未闭合：不构成有效块（继续扫描后续行）
      i++
      continue
    }
    out.push({
      name: m[1]!,
      arg: (m[2] ?? '').trim(),
      lines: lines.slice(i + 1, j),
      raw: lines.slice(i, j + 1).join('\n'),
    })
    i = j + 1
  }
  return out
}

/** 会话全部消息 → 容器实例（保序：消息序 + 块序；seq 为同消息内块序号） */
export interface SceneContainer extends ParsedContainer {
  messageId: string
  messageAgentId?: string
  seq: number
}

export function containersOf(messages: ChatMessage[]): SceneContainer[] {
  const out: SceneContainer[] = []
  for (const msg of messages) {
    if (msg.role === 'user' || !msg.content.includes(':::')) continue
    const blocks = parseContainers(msg.content)
    blocks.forEach((b, seq) => out.push({ ...b, messageId: msg.id, messageAgentId: msg.agentId, seq }))
  }
  return out
}

// ---------- 盘面行（PanBoard 数据源；口径同 remark-ext finalizePan） ----------

export interface SceneRow {
  label: string
  value: string
}

export interface PanLines {
  fields: SceneRow[]
  items: SceneRow[]
}

/** 字段行 `键：值`（键 1–16 字符、不含冒号 / 竖线；同 remark-ext PAN_FIELD_RE） */
const PAN_FIELD_RE = /^([\p{L}\p{N}][^：:|]{0,15})[：:]\s*(.+)$/u

/** 条目行 `- 键 | 值`（首个 | 前为键；值内全角 ｜ 保留） */
const PAN_ITEM_RE = /^[-*]\s+(.+)$/

export function panRowsOf(lines: string[]): PanLines {
  const fields: SceneRow[] = []
  const items: SceneRow[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    const item = PAN_ITEM_RE.exec(line)
    if (item) {
      const content = item[1]!
      const idx = content.indexOf('|')
      if (idx > 0) {
        items.push({ label: content.slice(0, idx).trim(), value: content.slice(idx + 1).trim() })
      } else {
        items.push({ label: '', value: content.trim() })
      }
      continue
    }
    const f = PAN_FIELD_RE.exec(line)
    if (f) fields.push({ label: f[1]!.trim(), value: f[2]! })
  }
  return { fields, items }
}

// ---------- 标题（board 目录树数据源） ----------

export interface SceneHeading {
  level: number
  text: string
}

/** Markdown 标题提取（跳过 ``` 围栏内的行） */
export function headingsOf(content: string): SceneHeading[] {
  const out: SceneHeading[] = []
  let fenced = false
  for (const raw of content.split('\n')) {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const m = /^(#{1,4})\s+(.+)$/.exec(raw.trim())
    if (m) out.push({ level: m[1]!.length, text: m[2]!.trim() })
  }
  return out
}

// ---------- 成员消息 / 波次 ----------

/** 成员消息按作者分组（面板 / 席位发言流用；保序） */
export function memberMessagesOf(messages: ChatMessage[]): Map<string, ChatMessage[]> {
  const out = new Map<string, ChatMessage[]>()
  for (const msg of messages) {
    if (msg.role !== 'agent' || !msg.agentId) continue
    const list = out.get(msg.agentId)
    if (list) list.push(msg)
    else out.set(msg.agentId, [msg])
  }
  return out
}

/**
 * 摘要提取（席位发言流条目用，M52-D）：跳过围栏 / 容器 / 表格行 / 分隔线，
 * 剥图片、链接、标题、引用、列表与强调标记后取首段文本；超长截断（尾部 …）。
 * 无可用文本时返回 ''（渲染层回退占位）。
 */
export function excerptOf(content: string, max = 56): string {
  let fenced = false
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (fenced || line === '') continue
    if (line.startsWith(':::') || line.startsWith('|') || line.startsWith('$$')) continue
    if (/^[-*_]{3,}$/.test(line)) continue
    const text = line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/^([-*+]|\d+[.)])\s+/, '')
      .replace(/\*\*|`/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (text === '') continue
    return text.length > max ? `${text.slice(0, max)}…` : text
  }
  return ''
}

export interface SceneWave {
  turnIndex: number
  ids: string[]
  memberIds: string[]
}

/** 波次分组（turnIndex ≥ 0 的成员消息；回合轴 / 议程推进数据源） */
export function wavesOf(messages: ChatMessage[]): SceneWave[] {
  const byTurn = new Map<number, SceneWave>()
  for (const msg of messages) {
    if (msg.role !== 'agent' || msg.turnIndex == null || msg.turnIndex < 0) continue
    const wave = byTurn.get(msg.turnIndex)
    if (wave) {
      wave.ids.push(msg.id)
      if (msg.agentId) wave.memberIds.push(msg.agentId)
    } else {
      byTurn.set(msg.turnIndex, { turnIndex: msg.turnIndex, ids: [msg.id], memberIds: msg.agentId ? [msg.agentId] : [] })
    }
  }
  return [...byTurn.values()].sort((a, b) => a.turnIndex - b.turnIndex)
}

/** 当前波次（最后一个波次；无成员消息时为 undefined） */
export function currentWaveOf(messages: ChatMessage[]): SceneWave | undefined {
  const waves = wavesOf(messages)
  return waves[waves.length - 1]
}

/** 最后一条成员消息的作者（当前发言者；无则 undefined） */
export function speakingIdOf(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'agent' && m.agentId) return m.agentId
  }
  return undefined
}

// ---------- 裁决（arena 计分 / versus 数据源） ----------

export type SceneVerdictStatus = VerdictStatus

export interface SceneVerdict {
  status: SceneVerdictStatus
  title: string
  items: SceneRow[]
  messageId: string
}

/**
 * `::: verdict <多方|空方|僵持|正方|反方|自然语言前缀> [标题]` 容器 → 裁决实例（保序）。
 * M52-E：状态词容错（「空方领先」→ short）；首词未命中时退回条目「胜负」行判定
 * （口径与 remark-ext 共用 lib/verdict）。
 */
export function verdictsOf(messages: ChatMessage[]): SceneVerdict[] {
  const out: SceneVerdict[] = []
  for (const c of containersOf(messages)) {
    if (c.name !== 'verdict') continue
    const items = panRowsOf(c.lines).items
    const { status: headStatus, title } = parseVerdictArg(c.arg)
    const status = headStatus === 'none' ? verdictStatusFromItems(items) : headStatus
    out.push({ status, title, items, messageId: c.messageId })
  }
  return out
}

// ---------- checklist（coach 面板数据源） ----------

export interface SceneCheckItem {
  id: string
  label: string
  checked: boolean
}

/** `::: checklist [标题]` 容器行 → 勾选项（`- [x] 文本` / `- 文本`；同 remark-ext 口径的轻量版） */
export function checklistItemsOf(lines: string[]): SceneCheckItem[] {
  const out: SceneCheckItem[] = []
  lines.forEach((raw, i) => {
    const m = /^[-*]\s+(?:\[([xX ])\]\s*)?(.+)$/.exec(raw.trim())
    if (!m) return
    const text = m[2]!.trim()
    if (text === '') return
    out.push({ id: `i${i}`, label: text, checked: (m[1] ?? '').toLowerCase() === 'x' })
  })
  return out
}

// ---------- 交付件（面板 DeliveryPanel 数据源） ----------

/** 全部消息产出的交付件路径（去重保序） */
export function artifactsOf(messages: ChatMessage[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const msg of messages) {
    for (const path of msg.artifacts ?? []) {
      if (!seen.has(path)) {
        seen.add(path)
        out.push(path)
      }
    }
  }
  return out
}
