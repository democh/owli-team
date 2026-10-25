/** IM：会话个人偏好（置顶 / 免打扰）；仅影响本人列表与提醒，不改变 ACL。 */
import type { SessionPrefs } from '@multi-agent/shared'
import type { AppDb } from './db.js'
import { nowIso } from './sessions.js'

interface PrefRow {
  session_id: string
  pinned: number
  muted: number
  archived: number
  marked_unread: number
}

export class SessionPrefsStore {
  constructor(private readonly db: AppDb) {}

  get(userId: string, sessionId: string): SessionPrefs {
    const row = this.db.get<PrefRow>(
      'SELECT session_id, pinned, muted, archived, marked_unread FROM session_prefs WHERE user_id = ? AND session_id = ?',
      userId,
      sessionId,
    )
    return {
      pinned: !!row?.pinned,
      muted: !!row?.muted,
      archived: !!row?.archived,
      markedUnread: !!row?.marked_unread,
    }
  }

  /** 批量投影（会话列表用；无记录 = 均关，不返回空行） */
  forSessions(userId: string, sessionIds: string[]): Map<string, SessionPrefs> {
    const out = new Map<string, SessionPrefs>()
    if (sessionIds.length === 0) return out
    const marks = sessionIds.map(() => '?').join(',')
    const rows = this.db.all<PrefRow>(
      `SELECT session_id, pinned, muted, archived, marked_unread FROM session_prefs WHERE user_id = ? AND session_id IN (${marks})`,
      userId,
      ...sessionIds,
    )
    for (const row of rows)
      out.set(row.session_id, {
        pinned: !!row.pinned,
        muted: !!row.muted,
        archived: !!row.archived,
        markedUnread: !!row.marked_unread,
      })
    return out
  }

  /** 部分更新（缺省字段保持原值）；返回更新后的投影 */
  set(userId: string, sessionId: string, patch: Partial<SessionPrefs>): SessionPrefs {
    const current = this.get(userId, sessionId)
    const next: SessionPrefs = {
      pinned: patch.pinned ?? current.pinned,
      muted: patch.muted ?? current.muted,
      archived: patch.archived ?? current.archived,
      markedUnread: patch.markedUnread ?? current.markedUnread,
    }
    this.db.run(
      `INSERT INTO session_prefs (user_id, session_id, pinned, muted, archived, marked_unread, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, session_id) DO UPDATE SET
         pinned = excluded.pinned, muted = excluded.muted,
         archived = excluded.archived, marked_unread = excluded.marked_unread,
         updated_at = excluded.updated_at`,
      userId,
      sessionId,
      next.pinned ? 1 : 0,
      next.muted ? 1 : 0,
      next.archived ? 1 : 0,
      next.markedUnread ? 1 : 0,
      nowIso(),
    )
    return next
  }
}
