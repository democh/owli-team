/**
 * M57 P2：会话共享成员存储（session_members 表）。
 *
 * 语义：
 * - owner 不进此表（由 sessions.owner_id 承载）；role 仅 editor / viewer；
 * - 权限矩阵：读取 = owner ∪ 成员；写 = owner / editor；viewer 只读（可自助 /leave 退出）；
 * - 会话删除 / 用户删除由外键 CASCADE 级联清理（见迁移 v16）。
 */
import type { SessionShareRole } from '@multi-agent/shared'
import type { AppDb } from './db.js'

export interface SessionMemberRecord {
  sessionId: string
  userId: string
  role: SessionShareRole
  /** 邀请人（users.id；可空：历史 / 系统） */
  invitedBy?: string
  createdAt: string
  updatedAt: string
}

interface MemberRow {
  session_id: string
  user_id: string
  role: string
  invited_by: string | null
  created_at: string
  updated_at: string
}

function rowToRecord(row: MemberRow): SessionMemberRecord {
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    role: row.role as SessionShareRole,
    invitedBy: row.invited_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class SessionMemberStore {
  constructor(private readonly db: AppDb) {}

  /** 会话的共享成员（按加入时间升序；不含 owner） */
  list(sessionId: string): SessionMemberRecord[] {
    return this.db
      .all<MemberRow>('SELECT * FROM session_members WHERE session_id = ? ORDER BY created_at ASC', sessionId)
      .map(rowToRecord)
  }

  /** 共享给我的全部记录（列表过滤 / WS 可见集） */
  listForUser(userId: string): SessionMemberRecord[] {
    return this.db
      .all<MemberRow>('SELECT * FROM session_members WHERE user_id = ? ORDER BY created_at ASC', userId)
      .map(rowToRecord)
  }

  get(sessionId: string, userId: string): SessionMemberRecord | undefined {
    const row = this.db.get<MemberRow>(
      'SELECT * FROM session_members WHERE session_id = ? AND user_id = ?',
      sessionId,
      userId,
    )
    return row ? rowToRecord(row) : undefined
  }

  has(sessionId: string, userId: string): boolean {
    return this.get(sessionId, userId) !== undefined
  }

  /** 共享人数（≥1 即「共享会话」，用于人类消息署名判定；不含 owner） */
  count(sessionId: string): number {
    const row = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM session_members WHERE session_id = ?', sessionId)
    return Number(row?.n ?? 0)
  }

  /** 新增 / 改角色（幂等 upsert）；返回是否首次创建 */
  upsert(sessionId: string, userId: string, role: SessionShareRole, invitedBy?: string): { record: SessionMemberRecord; created: boolean } {
    const now = new Date().toISOString()
    const existed = this.has(sessionId, userId)
    this.db.run(
      `INSERT INTO session_members (session_id, user_id, role, invited_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
      sessionId,
      userId,
      role,
      invitedBy ?? null,
      now,
      now,
    )
    return { record: this.get(sessionId, userId)!, created: !existed }
  }

  /** 移除成员（返回是否确有成员被移除） */
  remove(sessionId: string, userId: string): boolean {
    const existed = this.has(sessionId, userId)
    this.db.run('DELETE FROM session_members WHERE session_id = ? AND user_id = ?', sessionId, userId)
    return existed
  }
}
