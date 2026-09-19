/**
 * 登录会话与 API Key 存储（M57 多用户 P1）。
 *
 * 安全约定：
 * - 明文令牌绝不出现在本层之外：仅存 SHA-256 哈希（token_hash）；
 * - 双重过期：滑动过期（expires_at，每次校验续期）+ 绝对过期（absolute_expires_at，不可续期）；
 * - 撤销即时生效（revoked_at 非空即失效）。
 */
import type { ApiKeyInfo } from '@multi-agent/shared'
import type { AppDb } from './db.js'
import { newId, nowIso } from './sessions.js'

export interface AuthSessionRecord {
  id: string
  userId: string
  tokenHash: string
  createdAt: string
  expiresAt: string
  absoluteExpiresAt: string
  lastSeenAt: string
  revokedAt?: string
  userAgent?: string
  ip?: string
}

interface AuthSessionRow {
  id: string
  user_id: string
  token_hash: string
  created_at: string
  expires_at: string
  absolute_expires_at: string
  last_seen_at: string
  revoked_at: string | null
  user_agent: string | null
  ip: string | null
}

function toRecord(row: AuthSessionRow): AuthSessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at ?? undefined,
    userAgent: row.user_agent ?? undefined,
    ip: row.ip ?? undefined,
  }
}

export class AuthSessionStore {
  constructor(private readonly db: AppDb) {}

  create(input: {
    userId: string
    tokenHash: string
    expiresAt: string
    absoluteExpiresAt: string
    userAgent?: string
    ip?: string
  }): AuthSessionRecord {
    const ts = nowIso()
    const id = newId('as')
    this.db.run(
      `INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at, absolute_expires_at, last_seen_at, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.userId,
      input.tokenHash,
      ts,
      input.expiresAt,
      input.absoluteExpiresAt,
      ts,
      input.userAgent ?? null,
      input.ip ?? null,
    )
    return {
      id,
      userId: input.userId,
      tokenHash: input.tokenHash,
      createdAt: ts,
      expiresAt: input.expiresAt,
      absoluteExpiresAt: input.absoluteExpiresAt,
      lastSeenAt: ts,
      userAgent: input.userAgent,
      ip: input.ip,
    }
  }

  /** 有效会话查询（未撤销 + 双过期均未到） */
  findValidByHash(tokenHash: string, now = nowIso()): AuthSessionRecord | undefined {
    const row = this.db.get<AuthSessionRow>(
      `SELECT * FROM auth_sessions
       WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ? AND absolute_expires_at > ?`,
      tokenHash,
      now,
      now,
    )
    return row ? toRecord(row) : undefined
  }

  /** 滑动续期（last_seen 节流由调用方控制） */
  touch(id: string, expiresAt: string): void {
    this.db.run('UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', nowIso(), expiresAt, id)
  }

  revoke(id: string): void {
    this.db.run('UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', nowIso(), id)
  }

  /** 撤销某用户全部会话（exceptId 用于「改密后保留当前会话」） */
  revokeAllForUser(userId: string, exceptId?: string): number {
    const result = exceptId
      ? this.db.run(
          'UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL',
          nowIso(),
          userId,
          exceptId,
        )
      : this.db.run('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', nowIso(), userId)
    return result.changes
  }

  /** 清理过期 / 已撤销的历史行（随登录轻量触发） */
  prune(now = nowIso()): void {
    this.db.run(
      'DELETE FROM auth_sessions WHERE absolute_expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)',
      now,
      now,
    )
  }
}

export interface ApiKeyRecord extends ApiKeyInfo {
  userId: string
  tokenHash: string
}

interface ApiKeyRow {
  id: string
  user_id: string
  name: string
  token_hash: string
  created_at: string
  expires_at: string | null
  last_used_at: string | null
  revoked_at: string | null
}

function toApiKey(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? undefined,
    lastUsedAt: row.last_used_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
  }
}

export class ApiKeyStore {
  constructor(private readonly db: AppDb) {}

  create(input: { userId: string; name: string; tokenHash: string; expiresAt?: string }): ApiKeyRecord {
    const id = newId('ak')
    const ts = nowIso()
    this.db.run(
      `INSERT INTO api_keys (id, user_id, name, token_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      input.userId,
      input.name.trim() || 'API Key',
      input.tokenHash,
      ts,
      input.expiresAt ?? null,
    )
    return toApiKey(this.db.get<ApiKeyRow>('SELECT * FROM api_keys WHERE id = ?', id)!)
  }

  findValidByHash(tokenHash: string, now = nowIso()): ApiKeyRecord | undefined {
    const row = this.db.get<ApiKeyRow>(
      `SELECT * FROM api_keys
       WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
      tokenHash,
      now,
    )
    return row ? toApiKey(row) : undefined
  }

  touchUsed(id: string): void {
    this.db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', nowIso(), id)
  }

  get(id: string): ApiKeyRecord | undefined {
    const row = this.db.get<ApiKeyRow>('SELECT * FROM api_keys WHERE id = ?', id)
    return row ? toApiKey(row) : undefined
  }

  listForUser(userId: string): ApiKeyInfo[] {
    return this.db
      .all<ApiKeyRow>('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC', userId)
      .map((row) => {
        const { userId: _u, tokenHash: _t, ...info } = toApiKey(row)
        return info
      })
  }

  revoke(id: string): boolean {
    return this.db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', nowIso(), id).changes > 0
  }
}
