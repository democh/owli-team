/**
 * M79-A：会话已读游标（session_reads 表）——未读服务端权威（设计 §9.4）。
 *
 * 口径（单一定义）：
 * - last_read_seq 以「消息 seq」为参照系；
 * - 未读 = seq > last_read_seq 且非本人消息（自己发的 user 消息不计）；
 * - 上报单调推进（max(既有, 新值)），回退请求忽略（防乱序覆盖）。
 */
import { nowIso } from './sessions.js'
import type { AppDb } from './db.js'

export class SessionReadsStore {
  constructor(private readonly db: AppDb) {}

  /** 读取已读游标（缺省 0） */
  get(userId: string, sessionId: string): number {
    const row = this.db.get<{ last_read_seq: number }>(
      'SELECT last_read_seq FROM session_reads WHERE user_id = ? AND session_id = ?',
      userId,
      sessionId,
    )
    return Number(row?.last_read_seq ?? 0)
  }

  /** 上报已读（单调推进：max(既有, seq)；返回生效值） */
  set(userId: string, sessionId: string, seq: number): number {
    const current = this.get(userId, sessionId)
    if (!Number.isSafeInteger(seq) || seq <= 0) return current
    const head = this.db.get<{ seq: number }>('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE session_id = ?', sessionId)
    const target = Math.min(seq, Number(head?.seq ?? 0))
    if (target <= current) return current
    this.db.run(
      `INSERT INTO session_reads (user_id, session_id, last_read_seq, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, session_id) DO UPDATE SET last_read_seq = MAX(session_reads.last_read_seq, excluded.last_read_seq), updated_at = excluded.updated_at`,
      userId,
      sessionId,
      target,
      nowIso(),
    )
    return this.get(userId, sessionId)
  }

  /**
   * 批量未读（会话列表聚合；避免 N+1）。
   * 返回 Map<sessionId, unreadCount>（无未读的会话不在 Map 中）。
   */
  unreadFor(userId: string, sessionIds: string[]): Map<string, number> {
    const out = new Map<string, number>()
    if (sessionIds.length === 0) return out
    const placeholders = sessionIds.map(() => '?').join(',')
    const rows = this.db.all<{ sid: string; n: number }>(
      `SELECT m.session_id AS sid, COUNT(*) AS n
       FROM messages m
       LEFT JOIN session_reads r ON r.session_id = m.session_id AND r.user_id = ?
       WHERE m.session_id IN (${placeholders})
         AND m.seq > COALESCE(r.last_read_seq, 0)
         AND (m.user_id IS NULL OR m.user_id <> ?)
         AND m.recalled_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM message_hides h WHERE h.message_id = m.id AND h.user_id = ?
         )
       GROUP BY m.session_id`,
      userId,
      ...sessionIds,
      userId,
      userId,
    )
    for (const row of rows) out.set(row.sid, Number(row.n))
    return out
  }
}
