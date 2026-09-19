/**
 * 消息反馈存储（M9）：👍/👎 + 原因落 feedback 表，导出为评测候选集。
 * 同一消息重复反馈视为覆盖（先删后插，保证一条消息至多一条反馈）。
 */
import { randomUUID } from 'node:crypto'
import type { FeedbackItem } from '@multi-agent/shared'
import type { AppDb } from './db.js'
import { nowIso } from './sessions.js'

export interface FeedbackInput {
  sessionId: string
  messageId: string
  /** 1 = 好评，-1 = 差评 */
  rating: number
  reason?: string
  /** M57：反馈提交人（users.id；缺省 = 单用户兼容模式） */
  userId?: string
}

interface FeedbackRow {
  id: string
  session_id: string
  message_id: string
  rating: number
  reason: string | null
  user_id?: string | null
  created_at: string
}

function rowToItem(row: FeedbackRow): FeedbackItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id,
    rating: Number(row.rating),
    reason: row.reason ?? undefined,
    createdAt: row.created_at,
  }
}

export class FeedbackStore {
  constructor(private readonly db: AppDb) {}

  /** 写入/覆盖一条反馈（同 messageId 覆盖）；rating 仅允许 1 / -1 */
  add(input: FeedbackInput): FeedbackItem {
    const rating = input.rating >= 0 ? 1 : -1
    this.db.run('DELETE FROM feedback WHERE message_id = ?', input.messageId)
    const id = `fb_${randomUUID().slice(0, 8)}`
    const createdAt = nowIso()
    this.db.run(
      `INSERT INTO feedback (id, session_id, message_id, rating, reason, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.sessionId,
      input.messageId,
      rating,
      input.reason?.trim() || null,
      input.userId ?? null,
      createdAt,
    )
    return { id, sessionId: input.sessionId, messageId: input.messageId, rating, reason: input.reason?.trim() || undefined, createdAt }
  }

  getByMessage(messageId: string): FeedbackItem | undefined {
    const row = this.db.get<FeedbackRow>('SELECT * FROM feedback WHERE message_id = ?', messageId)
    return row ? rowToItem(row) : undefined
  }

  /** 导出（评测候选集来源）；sinceMs 限定时间窗 */
  listAll(sinceMs?: number, limit = 2000): FeedbackItem[] {
    const where = sinceMs ? 'WHERE created_at >= ?' : ''
    const params: Array<string | number> = sinceMs ? [new Date(Date.now() - sinceMs).toISOString()] : []
    params.push(Math.max(1, Math.round(limit)))
    const rows = this.db.all<FeedbackRow>(
      `SELECT * FROM feedback ${where} ORDER BY created_at DESC LIMIT ?`,
      ...params,
    )
    return rows.map(rowToItem)
  }

  /** 好评率统计（指标面板） */
  stats(sinceMs?: number): { total: number; up: number; down: number } {
    const where = sinceMs ? 'WHERE created_at >= ?' : ''
    const params: string[] = sinceMs ? [new Date(Date.now() - sinceMs).toISOString()] : []
    const row = this.db.get<{ total: number; up: number }>(
      `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN rating > 0 THEN 1 ELSE 0 END), 0) AS up FROM feedback ${where}`,
      ...params,
    )
    const total = Number(row?.total ?? 0)
    const up = Number(row?.up ?? 0)
    return { total, up, down: total - up }
  }
}
