/** IM：仅自己删除（个人视图隐藏）；不删消息行，不影响未读聚合以外的事实。 */
import type { AppDb } from './db.js'
import { nowIso } from './sessions.js'

export class MessageHideStore {
  constructor(private readonly db: AppDb) {}

  hide(userId: string, sessionId: string, messageId: string): void {
    this.db.run(
      `INSERT INTO message_hides (user_id, message_id, session_id, hidden_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, message_id) DO NOTHING`,
      userId,
      messageId,
      sessionId,
      nowIso(),
    )
  }

  has(userId: string, messageId: string): boolean {
    return !!this.db.get('SELECT 1 AS ok FROM message_hides WHERE user_id = ? AND message_id = ?', userId, messageId)
  }

  /** 某用户在某会话内隐藏的消息 id 集合（会话读取过滤用） */
  ids(userId: string, sessionId: string): Set<string> {
    return new Set(
      this.db
        .all<{ message_id: string }>(
          'SELECT message_id FROM message_hides WHERE user_id = ? AND session_id = ?',
          userId,
          sessionId,
        )
        .map((row) => row.message_id),
    )
  }

  /** 恢复单条（服务端未暴露 UI；供消息恢复 / 测试使用） */
  remove(userId: string, messageId: string): boolean {
    return this.db.run('DELETE FROM message_hides WHERE user_id = ? AND message_id = ?', userId, messageId).changes > 0
  }
}
