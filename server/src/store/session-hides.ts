/**
 * M79-D：会话隐藏存储（session_hides 表）。
 *
 * 语义（设计 §12.2）：
 * - 仅从「本人列表」隐藏（DM「删除」语义；不影响对方）；
 * - 新消息自动复现：查询侧「hidden && unreadCount == 0」才过滤（有未读即强制显示）；
 * - 会话 / 用户删除随 FK 级联清理。
 */
import type { AppDb } from './db.js'
import { nowIso } from './sessions.js'

export class SessionHideStore {
  constructor(private readonly db: AppDb) {}

  hide(userId: string, sessionId: string): void {
    this.db.run(
      `INSERT INTO session_hides (user_id, session_id, hidden_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id, session_id) DO UPDATE SET hidden_at = excluded.hidden_at`,
      userId,
      sessionId,
      nowIso(),
    )
  }

  unhide(userId: string, sessionId: string): boolean {
    return this.db.run('DELETE FROM session_hides WHERE user_id = ? AND session_id = ?', userId, sessionId).changes > 0
  }

  isHidden(userId: string, sessionId: string): boolean {
    const row = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM session_hides WHERE user_id = ? AND session_id = ?',
      userId,
      sessionId,
    )
    return Number(row?.n ?? 0) > 0
  }

  /** 本人隐藏的会话集合（列表过滤依据） */
  hiddenFor(userId: string): Set<string> {
    const rows = this.db.all<{ session_id: string }>('SELECT session_id FROM session_hides WHERE user_id = ?', userId)
    return new Set(rows.map((r) => r.session_id))
  }
}
