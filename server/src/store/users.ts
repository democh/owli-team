/**
 * 账号存储（M57 多用户 P1）：users + user_prefs。
 *
 * 设计：
 * - password_hash 只在此层出现（对外一律经 toUserInfo 投影剥离）；
 * - 登录失败计数与锁定时间落库（`failed_login_count` / `locked_until`），跨重启存活；
 * - `backfillLegacyOwnership`：首个管理员 setup 后一次性回填存量数据归属（幂等）。
 */
import type { UserInfo, UserPreferences, UserRole, UserStatus } from '@multi-agent/shared'
import type { AppDb } from './db.js'
import { newId, nowIso } from './sessions.js'

interface UserRow {
  id: string
  username: string
  display_name: string
  password_hash: string
  role: string
  status: string
  must_change_password: number
  failed_login_count: number
  locked_until: string | null
  created_at: string
  updated_at: string
  last_login_at: string | null
  last_login_ip: string | null
}

/** 存储层完整记录（含凭据字段；仅 auth 模块可见） */
export interface UserRecord extends UserInfo {
  passwordHash: string
  failedLoginCount: number
  lockedUntil?: string
}

export function toUserInfo(record: UserRecord): UserInfo {
  const { passwordHash: _ph, failedLoginCount: _fc, lockedUntil: _lu, ...info } = record
  return info
}

function rowToUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role as UserRole,
    status: row.status as UserStatus,
    mustChangePassword: row.must_change_password === 1 ? true : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at ?? undefined,
    lastLoginIp: row.last_login_ip ?? undefined,
    passwordHash: row.password_hash,
    failedLoginCount: Number(row.failed_login_count ?? 0),
    lockedUntil: row.locked_until ?? undefined,
  }
}

/** 用户名规范化（登录不区分大小写；存储统一小写） */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase()
}

export class UserStore {
  constructor(private readonly db: AppDb) {}

  count(): number {
    const row = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')
    return Number(row?.n ?? 0)
  }

  countAdmins(): number {
    const row = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")
    return Number(row?.n ?? 0)
  }

  create(input: {
    username: string
    displayName: string
    passwordHash: string
    role: UserRole
    mustChangePassword?: boolean
  }): UserRecord {
    const ts = nowIso()
    const id = newId('u')
    this.db.run(
      `INSERT INTO users (id, username, display_name, password_hash, role, status, must_change_password, failed_login_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, 0, ?, ?)`,
      id,
      normalizeUsername(input.username),
      input.displayName.trim() || input.username.trim(),
      input.passwordHash,
      input.role,
      input.mustChangePassword ? 1 : 0,
      ts,
      ts,
    )
    return this.get(id)!
  }

  get(id: string): UserRecord | undefined {
    const row = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id)
    return row ? rowToUser(row) : undefined
  }

  getByUsername(username: string): UserRecord | undefined {
    const row = this.db.get<UserRow>('SELECT * FROM users WHERE username = ?', normalizeUsername(username))
    return row ? rowToUser(row) : undefined
  }

  list(): UserInfo[] {
    return this.db
      .all<UserRow>('SELECT * FROM users ORDER BY created_at ASC, rowid ASC')
      .map((row) => toUserInfo(rowToUser(row)))
  }

  /** 最早创建的管理员（legacy AUTH_TOKEN 映射目标 / 存量数据回填目标） */
  firstAdmin(): UserRecord | undefined {
    const row = this.db.get<UserRow>(
      "SELECT * FROM users WHERE role = 'admin' ORDER BY created_at ASC, rowid ASC LIMIT 1",
    )
    return row ? rowToUser(row) : undefined
  }

  update(
    id: string,
    patch: { displayName?: string; role?: UserRole; status?: UserStatus },
  ): UserRecord | undefined {
    const user = this.get(id)
    if (!user) return undefined
    const displayName = patch.displayName !== undefined ? patch.displayName.trim() : user.displayName
    if (!displayName) throw new Error('显示名不能为空')
    this.db.run(
      'UPDATE users SET display_name = ?, role = ?, status = ?, updated_at = ? WHERE id = ?',
      displayName,
      patch.role ?? user.role,
      patch.status ?? user.status,
      nowIso(),
      id,
    )
    return this.get(id)
  }

  setPassword(id: string, passwordHash: string, opts: { mustChange: boolean } = { mustChange: false }): void {
    this.db.run(
      'UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?',
      passwordHash,
      opts.mustChange ? 1 : 0,
      nowIso(),
      id,
    )
  }

  /** 登录失败：累加计数；达到阈值写入锁定截止时间（返回最新状态） */
  recordLoginFailure(id: string, threshold: number, lockMs: number): { failed: number; lockedUntil?: string } {
    const user = this.get(id)
    if (!user) return { failed: 0 }
    const failed = user.failedLoginCount + 1
    const lockedUntil = failed >= threshold ? new Date(Date.now() + lockMs).toISOString() : undefined
    this.db.run(
      'UPDATE users SET failed_login_count = ?, locked_until = ?, updated_at = ? WHERE id = ?',
      lockedUntil ? 0 : failed,
      lockedUntil ?? user.lockedUntil ?? null,
      nowIso(),
      id,
    )
    return { failed, lockedUntil }
  }

  recordLoginSuccess(id: string, ip: string): void {
    this.db.run(
      'UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = ?, last_login_ip = ?, updated_at = ? WHERE id = ?',
      nowIso(),
      ip,
      nowIso(),
      id,
    )
  }

  remove(id: string): boolean {
    return this.db.run('DELETE FROM users WHERE id = ?', id).changes > 0
  }

  // ---------- 个人偏好 ----------

  getPrefs(userId: string): UserPreferences {
    const row = this.db.get<{ prefs: string }>('SELECT prefs FROM user_prefs WHERE user_id = ?', userId)
    if (!row) return {}
    try {
      const parsed = JSON.parse(row.prefs) as unknown
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as UserPreferences)
        : {}
    } catch {
      return {}
    }
  }

  setPrefs(userId: string, patch: UserPreferences): UserPreferences {
    const merged = { ...this.getPrefs(userId), ...patch }
    this.db.run(
      `INSERT INTO user_prefs (user_id, prefs, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at`,
      userId,
      JSON.stringify(merged),
      nowIso(),
    )
    return merged
  }

  /**
   * 首个管理员 setup 后回填存量数据归属（幂等；单用户兼容模式下的历史数据归引导管理员）。
   * - sessions / projects：owner_id 为 NULL 的行（migration v14 之前创建）；
   * - watchlist：user_id 为 '' 的行；memory：user_id NULL + global scope owner 为空串的行；
   * - 归因表（runs / messages / usage / run_events / feedback / audit）：
   *   历史运行属于该管理员（单用户时期唯一用户），归因其名下以便按用户视图完整。
   */
  backfillLegacyOwnership(userId: string): void {
    this.db.tx(() => {
      this.db.run('UPDATE sessions SET owner_id = ? WHERE owner_id IS NULL', userId)
      this.db.run('UPDATE projects SET owner_id = ? WHERE owner_id IS NULL', userId)
      this.db.run("UPDATE finance_watchlist SET user_id = ? WHERE user_id = ''", userId)
      this.db.run('UPDATE memory SET user_id = ? WHERE user_id IS NULL', userId)
      this.db.run("UPDATE memory SET owner_id = ? WHERE scope = 'global' AND owner_id = ''", userId)
      this.db.run('UPDATE runs SET user_id = ? WHERE user_id IS NULL', userId)
      this.db.run("UPDATE messages SET user_id = ? WHERE user_id IS NULL AND role = 'user'", userId)
      this.db.run('UPDATE usage SET user_id = ? WHERE user_id IS NULL', userId)
      this.db.run('UPDATE run_events SET user_id = ? WHERE user_id IS NULL', userId)
      this.db.run('UPDATE feedback SET user_id = ? WHERE user_id IS NULL', userId)
      this.db.run("UPDATE audit_log SET user_id = ? WHERE user_id IS NULL AND actor = 'user'", userId)
      this.db.run(
        "UPDATE approvals SET decided_by = ? WHERE decided_by IS NULL AND status != 'pending'",
        userId,
      )
    })
  }
}
