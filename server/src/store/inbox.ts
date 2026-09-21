/**
 * M79-A：用户收件箱（user_inbox 表）——跨会话个人事件的持久投递（权威层）。
 *
 * 语义（设计 §9.3）：
 * - 仅承载「跨会话个人事件」：好友请求 / 被邀请 / 被提及 / 持球提醒 / 系统；
 *   聊天逐条消息不入箱（未读 + 消息 seq 已足够，防膨胀）；
 * - seq 每用户单调递增（客户端游标 / 缺口检测依据；单进程串行写入无并发风险）；
 * - 已读：单项（ids）或整段（upTo）；保留期清理仅删已读且过期的项（未读恒保留）；
 * - hasRecent：通知聚合窗口依据（同会话同目标同类型 60s 内不重复入箱）。
 */
import type { InboxItem, InboxType } from '@multi-agent/shared'
import { newId, nowIso } from './sessions.js'
import type { AppDb } from './db.js'

interface InboxRow {
  id: string
  user_id: string
  seq: number
  type: string
  session_id: string | null
  actor_id: string | null
  title: string
  body: string | null
  payload: string | null
  read_at: string | null
  created_at: string
}

function rowToItem(row: InboxRow, actorName?: string): InboxItem {
  return {
    id: row.id,
    seq: Number(row.seq),
    type: row.type as InboxType,
    sessionId: row.session_id ?? undefined,
    actorId: row.actor_id ?? undefined,
    ...(actorName ? { actorName } : {}),
    title: row.title,
    body: row.body ?? undefined,
    readAt: row.read_at ?? undefined,
    createdAt: row.created_at,
  }
}

export interface InboxAddInput {
  userId: string
  type: InboxType
  title: string
  sessionId?: string
  actorId?: string
  body?: string
  payload?: Record<string, unknown>
}

export class InboxStore {
  constructor(private readonly db: AppDb) {}

  /** 入箱（返回落库条目；seq = 该用户当前最大值 + 1） */
  add(input: InboxAddInput): InboxItem {
    const row = this.db.get<{ next: number }>(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM user_inbox WHERE user_id = ?',
      input.userId,
    )
    const seq = Number(row?.next ?? 1)
    const ts = nowIso()
    const id = newId('ib')
    this.db.run(
      `INSERT INTO user_inbox (id, user_id, seq, type, session_id, actor_id, title, body, payload, read_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      id,
      input.userId,
      seq,
      input.type,
      input.sessionId ?? null,
      input.actorId ?? null,
      input.title,
      input.body ?? null,
      input.payload ? JSON.stringify(input.payload) : null,
      ts,
    )
    return {
      id,
      seq,
      type: input.type,
      sessionId: input.sessionId,
      actorId: input.actorId,
      title: input.title,
      body: input.body,
      createdAt: ts,
    }
  }

  /** 增量拉取（since 游标；升序；跨用户越权由调用方守卫） */
  listSince(userId: string, since: number, limit = 200): InboxItem[] {
    const rows = this.db.all<InboxRow>(
      'SELECT * FROM user_inbox WHERE user_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
      userId,
      Math.max(0, since),
      Math.max(1, limit),
    )
    return rows.map((row) => rowToItem(row))
  }

  /** 当前游标（该用户最大 seq） */
  cursor(userId: string): number {
    const row = this.db.get<{ cursor: number }>(
      'SELECT COALESCE(MAX(seq), 0) AS cursor FROM user_inbox WHERE user_id = ?',
      userId,
    )
    return Number(row?.cursor ?? 0)
  }

  unreadCount(userId: string): number {
    const row = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM user_inbox WHERE user_id = ? AND read_at IS NULL',
      userId,
    )
    return Number(row?.n ?? 0)
  }

  /** 归属校验读取（跨用户读取一律 undefined 对待） */
  get(userId: string, id: string): (InboxItem & { payload?: Record<string, unknown> }) | undefined {
    const row = this.db.get<InboxRow>('SELECT * FROM user_inbox WHERE user_id = ? AND id = ?', userId, id)
    if (!row) return undefined
    let payload: Record<string, unknown> | undefined
    try {
      payload = row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined
    } catch {
      payload = undefined
    }
    return { ...rowToItem(row), payload }
  }

  /** 单项已读（幂等；返回实际更新数） */
  markRead(userId: string, ids: string[]): number {
    if (ids.length === 0) return 0
    const ts = nowIso()
    let changed = 0
    for (const id of ids) {
      changed += this.db.run('UPDATE user_inbox SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL', ts, userId, id).changes
    }
    return changed
  }

  /** 整段已读（upTo 语义：seq <= upTo 全部标记；抗乱序） */
  markReadUpTo(userId: string, upTo: number): number {
    const ts = nowIso()
    return this.db.run('UPDATE user_inbox SET read_at = ? WHERE user_id = ? AND seq <= ? AND read_at IS NULL', ts, userId, Math.max(0, upTo)).changes
  }

  /**
   * 聚合窗口判定：窗口内是否已有同类型 + 同会话 + 同触发者的项。
   * 用途：同会话同目标的「提及 / 持球」通知 60s 内不重复入箱；窗口 ≤0 = 禁用（恒 false）。
   */
  hasRecent(userId: string, type: InboxType, sessionId: string | undefined, actorId: string | undefined, windowMs: number): boolean {
    if (windowMs <= 0) return false
    const cutoff = new Date(Date.now() - windowMs).toISOString()
    const row = this.db.get<{ id: string }>(
      `SELECT id FROM user_inbox
       WHERE user_id = ? AND type = ? AND session_id IS ? AND actor_id IS ? AND created_at >= ?
       LIMIT 1`,
      userId,
      type,
      sessionId ?? null,
      actorId ?? null,
      cutoff,
    )
    return !!row
  }

  /** 保留期清理：仅删「已读」且早于 cutoff 的项（未读恒保留；返回删除数） */
  cleanup(retentionDays: number): number {
    if (retentionDays <= 0) return 0
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
    return this.db.run('DELETE FROM user_inbox WHERE read_at IS NOT NULL AND created_at < ?', cutoff).changes
  }
}
