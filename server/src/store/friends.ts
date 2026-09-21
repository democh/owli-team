/**
 * M79-C：好友关系存储（friend_links 表）——单行双向状态机（设计 §11）。
 *
 * 状态机：
 *   无关系 ──request──▶ pending ──accept──▶ accepted ──remove──▶ 无关系
 *                         │  └─reject──▶ 无关系（行删除，可再申请，受日限流）
 *                         └─block──▶ blocked ──unblock──▶ 无关系
 *
 * 约定：
 * - 单行双向：user_a < user_b（字典序）；视角层面的 pending-in / pending-out 由 requested_by 推导；
 * - blocked 对双方呈现「无关系」（relation 返回 'blocked' 仅用于守卫，列表/搜索一律排除）；
 * - 账号删除随 users FK 级联清理。
 */
import type { FriendState } from '@multi-agent/shared'
import type { AppDb } from './db.js'
import { newId, nowIso } from './sessions.js'

interface FriendLinkRow {
  id: string
  user_a: string
  user_b: string
  state: string
  requested_by: string
  message: string | null
  blocked_by: string | null
  created_at: string
  updated_at: string
}

export interface FriendLinkRecord {
  id: string
  userA: string
  userB: string
  state: 'pending' | 'accepted' | 'blocked'
  requestedBy: string
  message?: string
  blockedBy?: string
  createdAt: string
  updatedAt: string
}

function rowToRecord(row: FriendLinkRow): FriendLinkRecord {
  return {
    id: row.id,
    userA: row.user_a,
    userB: row.user_b,
    state: row.state as FriendLinkRecord['state'],
    requestedBy: row.requested_by,
    message: row.message ?? undefined,
    blockedBy: row.blocked_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 对方 id（相对于 viewer） */
export function otherOf(record: FriendLinkRecord, viewerId: string): string {
  return record.userA === viewerId ? record.userB : record.userA
}

export class FriendStore {
  constructor(private readonly db: AppDb) {}

  private pair(a: string, b: string): [string, string] {
    return a < b ? [a, b] : [b, a]
  }

  /** 原始行（含 blocked；内部守卫用） */
  find(a: string, b: string): FriendLinkRecord | undefined {
    const [userA, userB] = this.pair(a, b)
    const row = this.db.get<FriendLinkRow>('SELECT * FROM friend_links WHERE user_a = ? AND user_b = ?', userA, userB)
    return row ? rowToRecord(row) : undefined
  }

  byId(id: string): FriendLinkRecord | undefined {
    const row = this.db.get<FriendLinkRow>('SELECT * FROM friend_links WHERE id = ?', id)
    return row ? rowToRecord(row) : undefined
  }

  /** 视角关系态（blocked 仅守卫用；展示层应排除该行） */
  relation(viewerId: string, otherId: string): FriendState {
    const record = this.find(viewerId, otherId)
    if (!record) return 'none'
    if (record.state === 'pending') return record.requestedBy === viewerId ? 'pending-out' : 'pending-in'
    return record.state // accepted | blocked
  }

  areFriends(a: string, b: string): boolean {
    return this.find(a, b)?.state === 'accepted'
  }

  /** 任一方向拉黑（发布侧守卫：被拉黑方不可发起请求 / 私聊 / 被搜到） */
  hasBlockedPair(a: string, b: string): boolean {
    return this.find(a, b)?.state === 'blocked'
  }

  /** 发起请求（调用方须先校验：无既有行 / 未拉黑 / 非好友） */
  request(requesterId: string, targetId: string, message?: string): FriendLinkRecord {
    const [userA, userB] = this.pair(requesterId, targetId)
    const ts = nowIso()
    const id = newId('fl')
    this.db.run(
      `INSERT INTO friend_links (id, user_a, user_b, state, requested_by, message, blocked_by, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, NULL, ?, ?)`,
      id,
      userA,
      userB,
      requesterId,
      message?.trim() || null,
      ts,
      ts,
    )
    return this.byId(id)!
  }

  /** 接受（调用方须先校验：pending 且 viewer 为接收方） */
  accept(id: string): FriendLinkRecord | undefined {
    this.db.run("UPDATE friend_links SET state = 'accepted', updated_at = ? WHERE id = ? AND state = 'pending'", nowIso(), id)
    return this.byId(id)
  }

  /** 拒绝 / 撤回 / 解除：删行（幂等） */
  removeRow(id: string): boolean {
    return this.db.run('DELETE FROM friend_links WHERE id = ?', id).changes > 0
  }

  /** 解除好友关系（按对；accepted 行删除；返回是否命中） */
  removePair(a: string, b: string): boolean {
    const [userA, userB] = this.pair(a, b)
    return this.db.run("DELETE FROM friend_links WHERE user_a = ? AND user_b = ? AND state = 'accepted'", userA, userB).changes > 0
  }

  /** 拉黑（隐含解除）：无行则建 blocked；任何既有状态一律覆盖为 blocked */
  block(actorId: string, otherId: string): FriendLinkRecord {
    const [userA, userB] = this.pair(actorId, otherId)
    const existing = this.find(actorId, otherId)
    const ts = nowIso()
    if (existing) {
      this.db.run("UPDATE friend_links SET state = 'blocked', blocked_by = ?, updated_at = ? WHERE id = ?", actorId, ts, existing.id)
      return this.byId(existing.id)!
    }
    const id = newId('fl')
    this.db.run(
      `INSERT INTO friend_links (id, user_a, user_b, state, requested_by, message, blocked_by, created_at, updated_at)
       VALUES (?, ?, ?, 'blocked', ?, NULL, ?, ?, ?)`,
      id,
      userA,
      userB,
      actorId,
      actorId,
      ts,
      ts,
    )
    return this.byId(id)!
  }

  /** 解除拉黑（仅拉黑方可解除；回「无关系」） */
  unblock(actorId: string, otherId: string): boolean {
    const record = this.find(actorId, otherId)
    if (!record || record.state !== 'blocked' || record.blockedBy !== actorId) return false
    return this.removeRow(record.id)
  }

  /** 好友清单（accepted；按成为好友时间升序） */
  listFriends(userId: string): Array<{ userId: string; since: string }> {
    const rows = this.db.all<FriendLinkRow>(
      "SELECT * FROM friend_links WHERE state = 'accepted' AND (user_a = ? OR user_b = ?) ORDER BY updated_at ASC, rowid ASC",
      userId,
      userId,
    )
    return rows.map((row) => ({ userId: row.user_a === userId ? row.user_b : row.user_a, since: row.updated_at }))
  }

  /** 待处理请求（收发两视图；pending 且含 viewer） */
  listPending(userId: string): { incoming: FriendLinkRecord[]; outgoing: FriendLinkRecord[] } {
    const rows = this.db.all<FriendLinkRow>(
      "SELECT * FROM friend_links WHERE state = 'pending' AND (user_a = ? OR user_b = ?) ORDER BY created_at ASC, rowid ASC",
      userId,
      userId,
    )
    const incoming: FriendLinkRecord[] = []
    const outgoing: FriendLinkRecord[] = []
    for (const row of rows) {
      const record = rowToRecord(row)
      if (record.requestedBy === userId) outgoing.push(record)
      else incoming.push(record)
    }
    return { incoming, outgoing }
  }

  /** 日限流计数（该用户近 windowMs 内发起的全部请求行，含已成行） */
  countRequestsSince(requesterId: string, sinceIso: string): number {
    const row = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM friend_links WHERE requested_by = ? AND created_at >= ?',
      requesterId,
      sinceIso,
    )
    return Number(row?.n ?? 0)
  }
}
