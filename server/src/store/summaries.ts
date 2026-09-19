/**
 * 会话摘要存储（M2，L2 层）：滚动压缩产物的持久化与渲染。
 *
 * - 每会话一份滚动摘要（session_id 主键），until_seq 水位单调前进；
 * - data 为结构化摘要（供压缩器增量合并与 memory 提升），content 为渲染文本（装配与前端展示共用）；
 * - degraded：上次压缩失败的标记（成功压缩后自动清零）；失败时水位不动，装配侧退化为硬截断。
 */
import type { AppDb } from './db.js'

export interface SummaryData {
  completed: string[]
  decisions: string[]
  constraints: string[]
  artifacts: string[]
  openQuestions: string[]
  nextSteps: string[]
}

export function emptySummaryData(): SummaryData {
  return {
    completed: [],
    decisions: [],
    constraints: [],
    artifacts: [],
    openQuestions: [],
    nextSteps: [],
  }
}

export interface SummaryRecord {
  sessionId: string
  untilSeq: number
  content: string
  data: SummaryData
  tokenCount: number
  degraded: boolean
  updatedAt: string
}

interface SummaryRow {
  session_id: string
  until_seq: number
  content: string
  data: string
  token_count: number
  degraded: number
  updated_at: string
}

/** 结构化字段的渲染顺序与标题（L2 层与前端展示共用） */
const SECTION_LABEL: Array<[keyof SummaryData, string]> = [
  ['completed', '已完成'],
  ['decisions', '关键决策'],
  ['constraints', '约束与口径'],
  ['artifacts', '交付件'],
  ['openQuestions', '未决问题'],
  ['nextSteps', '下一步'],
]

/** 结构化摘要 → 文本（无有效内容时返回空串） */
export function renderSummaryData(data: SummaryData): string {
  const sections: string[] = []
  for (const [key, label] of SECTION_LABEL) {
    const items = data[key]
    if (!items || items.length === 0) continue
    sections.push(`## ${label}\n${items.map((c) => `- ${c}`).join('\n')}`)
  }
  return sections.join('\n\n')
}

function coerceList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '')).filter(Boolean)
}

/** 外部（模型产物 / DB JSON）→ 结构化摘要；非法结构返回 undefined */
export function coerceSummaryData(value: unknown): SummaryData | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const data = emptySummaryData()
  let hasArray = false
  for (const [key] of SECTION_LABEL) {
    if (Array.isArray(record[key])) hasArray = true
    data[key] = coerceList(record[key])
  }
  return hasArray ? data : undefined
}

/** 增量合并：旧摘要 + 新区间摘要（内容去重，列表截尾保留最新） */
export function mergeSummaryData(old: SummaryData | undefined, incoming: SummaryData): SummaryData {
  const base = old ?? emptySummaryData()
  const merge = (a: string[], b: string[], cap: number): string[] => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const item of [...a, ...b]) {
      const key = item.trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(key)
    }
    return out.length > cap ? out.slice(out.length - cap) : out
  }
  return {
    completed: merge(base.completed, incoming.completed, 40),
    decisions: merge(base.decisions, incoming.decisions, 60),
    constraints: merge(base.constraints, incoming.constraints, 60),
    artifacts: merge(base.artifacts, incoming.artifacts, 60),
    // 未决问题 / 下一步是「当下状态」：新区间有值则整体替换
    openQuestions: incoming.openQuestions.length > 0 ? incoming.openQuestions.slice(0, 20) : base.openQuestions,
    nextSteps: incoming.nextSteps.length > 0 ? incoming.nextSteps.slice(0, 20) : base.nextSteps,
  }
}

export class SummaryStore {
  constructor(private readonly db: AppDb) {}

  get(sessionId: string): SummaryRecord | undefined {
    const row = this.db.get<SummaryRow>('SELECT * FROM summaries WHERE session_id = ?', sessionId)
    if (!row) return undefined
    let data: SummaryData
    try {
      data = coerceSummaryData(JSON.parse(row.data)) ?? emptySummaryData()
    } catch {
      data = emptySummaryData()
    }
    return {
      sessionId: row.session_id,
      untilSeq: row.until_seq,
      content: row.content,
      data,
      tokenCount: row.token_count,
      degraded: row.degraded === 1,
      updatedAt: row.updated_at,
    }
  }

  /** 保存（成功压缩：until_seq 前进 + degraded 清零） */
  save(record: {
    sessionId: string
    untilSeq: number
    data: SummaryData
    content?: string
    tokenCount?: number
    degraded?: boolean
  }): SummaryRecord {
    const content = record.content ?? renderSummaryData(record.data)
    const now = new Date().toISOString()
    this.db.run(
      `INSERT INTO summaries (session_id, until_seq, content, data, token_count, degraded, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         until_seq = excluded.until_seq,
         content = excluded.content,
         data = excluded.data,
         token_count = excluded.token_count,
         degraded = excluded.degraded,
         updated_at = excluded.updated_at`,
      record.sessionId,
      record.untilSeq,
      content,
      JSON.stringify(record.data),
      record.tokenCount ?? 0,
      record.degraded ? 1 : 0,
      now,
    )
    return this.get(record.sessionId)!
  }

  /** 压缩失败：标记 degraded（水位不动，下次仍尝试压缩；装配侧退化为硬截断） */
  markDegraded(sessionId: string): void {
    const now = new Date().toISOString()
    if (this.get(sessionId)) {
      this.db.run('UPDATE summaries SET degraded = 1, updated_at = ? WHERE session_id = ?', now, sessionId)
      return
    }
    this.db.run(
      `INSERT INTO summaries (session_id, until_seq, content, data, token_count, degraded, updated_at)
       VALUES (?, 0, '', '{}', 0, 1, ?)`,
      sessionId,
      now,
    )
  }

  clear(sessionId: string): void {
    this.db.run('DELETE FROM summaries WHERE session_id = ?', sessionId)
  }
}
