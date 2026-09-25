/**
 * M80-B：消息表情回应（message_reactions 表；docs/emoji-and-readreceipt-design.md §5.3）。
 *
 * - 三元组 (message_id, user_id, emoji) 唯一 = 幂等 toggle；随消息级联删除；
 * - 投影为 ReactionSummary 聚合（按 emoji 分组计数 + 回应者名单；mine 由调用方按 viewer 计算）；
 * - 权威层在 DB；WS `notify:reaction` 全量替换帧只是快路径（客户端幂等 upsert）。
 */
import type { ReactionSummary } from '@multi-agent/shared'
import { nowIso } from './sessions.js'
import type { AppDb } from './db.js'

interface ReactionRow {
  message_id: string
  user_id: string
  emoji: string
  created_at: string
}

export class ReactionStore {
  constructor(private readonly db: AppDb) {}

  /** 挂回应（幂等：已存在同 emoji 则不动；返回是否新增） */
  add(messageId: string, userId: string, emoji: string): boolean {
    const existing = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
      messageId,
      userId,
      emoji,
    )
    if (Number(existing?.n ?? 0) > 0) return false
    this.db.run(
      'INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)',
      messageId,
      userId,
      emoji,
      nowIso(),
    )
    return true
  }

  /** 摘回应（仅本人；返回是否删除） */
  remove(messageId: string, userId: string, emoji: string): boolean {
    this.db.run(
      'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
      messageId,
      userId,
      emoji,
    )
    return true
  }

  /** 单消息聚合投影（mine 按 viewerId；无回应返回空数组） */
  summaryFor(messageId: string, viewerId?: string): ReactionSummary[] {
    const rows = this.db.all<ReactionRow>(
      'SELECT message_id, user_id, emoji, created_at FROM message_reactions WHERE message_id = ? ORDER BY created_at ASC',
      messageId,
    )
    return aggregate(rows, viewerId)
  }

  /** 批量聚合（会话详情投影；避免 N+1）——返回 Map<messageId, ReactionSummary[]> */
  summaryForMessages(messageIds: string[], viewerId?: string): Map<string, ReactionSummary[]> {
    const out = new Map<string, ReactionSummary[]>()
    if (messageIds.length === 0) return out
    const placeholders = messageIds.map(() => '?').join(',')
    const rows = this.db.all<ReactionRow>(
      `SELECT message_id, user_id, emoji, created_at FROM message_reactions
       WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`,
      ...messageIds,
    )
    const byMessage = new Map<string, ReactionRow[]>()
    for (const row of rows) {
      const list = byMessage.get(row.message_id) ?? []
      list.push(row)
      byMessage.set(row.message_id, list)
    }
    for (const [mid, list] of byMessage) out.set(mid, aggregate(list, viewerId))
    return out
  }

  /** 单消息软限：同用户在同一条消息上最多挂 N 种（防刷屏滥用） */
  countOfUser(messageId: string, userId: string): number {
    const row = this.db.get<{ n: number }>(
      'SELECT COUNT(DISTINCT emoji) AS n FROM message_reactions WHERE message_id = ? AND user_id = ?',
      messageId,
      userId,
    )
    return Number(row?.n ?? 0)
  }
}

/** 行 → 聚合（保持 emoji 首现序；userIds 保持时间序） */
function aggregate(rows: ReactionRow[], viewerId?: string): ReactionSummary[] {
  const order: string[] = []
  const byEmoji = new Map<string, string[]>()
  for (const row of rows) {
    if (!byEmoji.has(row.emoji)) {
      byEmoji.set(row.emoji, [])
      order.push(row.emoji)
    }
    byEmoji.get(row.emoji)!.push(row.user_id)
  }
  return order.map((emoji) => {
    const userIds = byEmoji.get(emoji)!
    return { emoji, count: userIds.length, userIds, mine: !!viewerId && userIds.includes(viewerId) }
  })
}
