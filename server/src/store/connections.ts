/**
 * 连接中心存储（M22）：connections + session_connections 两表 CRUD 与会话绑定。
 *
 * 凭据安全：secret 经 SecretVault 加密后落 `secret_enc`；对外视图一律脱敏（仅 secretSet）。
 * 绑定语义：会话绑定的连接即「Agent 可用清单」——工具运行时按此做最小权限校验。
 */
import { randomUUID } from 'node:crypto'
import type { ConnectionDefinition, ConnectionKind, ConnectionStatus } from '@multi-agent/shared'
import type { SecretVault } from '../connections/crypto.js'
import type { AppDb } from './db.js'
import { nowIso } from './sessions.js'

export interface ConnectionCreateInput {
  name: string
  kind: ConnectionKind
  config: Record<string, unknown>
  secret?: Record<string, unknown> | null
  enabled?: boolean
  /** M57 P3：作用域（缺省 system；personal 需同时给 ownerId） */
  scope?: 'system' | 'personal'
  ownerId?: string
  /** M57 P3：成员可用开关（仅 system 有意义；缺省 true 保持旧行为） */
  memberUse?: boolean
}

export interface ConnectionUpdatePatch {
  name?: string
  config?: Record<string, unknown>
  /** 缺省 = 不改动；null = 清空；对象 = 覆盖 */
  secret?: Record<string, unknown> | null
  enabled?: boolean
  /** M57 P3：成员可用开关（admin 对 system 连接） */
  memberUse?: boolean
}

interface ConnectionRow {
  id: string
  name: string
  kind: string
  config: string
  secret_enc: string | null
  status: string
  last_checked_at: string | null
  last_error: string | null
  enabled: number
  /** M57 P3：作用域 / 属主 / 成员可用（v14 列；旧库可能为 NULL） */
  scope: string | null
  owner_id: string | null
  member_use: number | null
  created_at: string
  updated_at: string
}

interface BindingRow {
  connection_id: string
  granted_at: string
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function toDefinition(row: ConnectionRow): ConnectionDefinition {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ConnectionKind,
    config: parseJson(row.config),
    status: row.status as ConnectionStatus,
    lastCheckedAt: row.last_checked_at ?? undefined,
    lastError: row.last_error ?? undefined,
    enabled: row.enabled === 1,
    secretSet: Boolean(row.secret_enc),
    // M57 P3：旧库 NULL → system / 成员可用（与迁移默认一致）
    scope: (row.scope as 'system' | 'personal') ?? 'system',
    ownerId: row.owner_id ?? undefined,
    memberUse: row.member_use === null ? true : row.member_use === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class ConnectionStore {
  constructor(
    private readonly db: AppDb,
    private readonly vault: SecretVault,
  ) {}

  // ---------- CRUD ----------

  list(): ConnectionDefinition[] {
    const rows = this.db.all<ConnectionRow>('SELECT * FROM connections ORDER BY created_at ASC')
    return rows.map(toDefinition)
  }

  /** M57：成员可用清单（system + enabled + member_use=1；config 脱敏由路由层处理） */
  listUsable(): ConnectionDefinition[] {
    const rows = this.db.all<ConnectionRow>(
      `SELECT * FROM connections WHERE scope = 'system' AND enabled = 1 AND member_use = 1 ORDER BY created_at ASC`,
    )
    return rows.map(toDefinition)
  }

  /** M57：成员可用判定（会话绑定校验：admin 可绑定任意；成员仅可用 member_use=1 的 system 连接） */
  memberUsable(id: string): boolean {
    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM connections WHERE id = ? AND scope = 'system' AND enabled = 1 AND member_use = 1`,
      id,
    )
    return Number(row?.n ?? 0) > 0
  }

  /**
   * M57 P3：用户可见清单 = 可用的 system 连接（enabled + member_use=1）∪ 本人 personal 连接（含禁用，便于管理）。
   * 路由层对非本人 personal / system 条目做 config 脱敏。
   */
  listForUser(userId: string): ConnectionDefinition[] {
    const rows = this.db.all<ConnectionRow>(
      `SELECT * FROM connections
       WHERE (scope = 'system' AND enabled = 1 AND member_use = 1) OR (scope = 'personal' AND owner_id = ?)
       ORDER BY created_at ASC`,
      userId,
    )
    return rows.map(toDefinition)
  }

  /** M57 P3：personal 属主判定（成员绑定 / 工具执行 / 资源级守卫共用） */
  ownsPersonal(userId: string, id: string): boolean {
    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM connections WHERE id = ? AND scope = 'personal' AND owner_id = ?`,
      id,
      userId,
    )
    return Number(row?.n ?? 0) > 0
  }

  /** M57 P3：连接属主（system 返回 undefined；浏览器 runtime 复用判定用） */
  ownerOf(id: string): string | undefined {
    const row = this.db.get<{ owner_id: string | null }>(
      `SELECT owner_id FROM connections WHERE id = ? AND scope = 'personal'`,
      id,
    )
    return row?.owner_id ?? undefined
  }

  /** M57 P3：删除某用户的全部 personal 连接（账号删除级联；绑定行由 FK CASCADE 自动清理），返回删除数 */
  removePersonalOf(userId: string): number {
    const result = this.db.run(`DELETE FROM connections WHERE scope = 'personal' AND owner_id = ?`, userId)
    return result.changes
  }

  get(id: string): ConnectionDefinition | undefined {
    const row = this.db.get<ConnectionRow>('SELECT * FROM connections WHERE id = ?', id)
    return row ? toDefinition(row) : undefined
  }

  findByName(name: string): ConnectionDefinition | undefined {
    const row = this.db.get<ConnectionRow>('SELECT * FROM connections WHERE name = ?', name)
    return row ? toDefinition(row) : undefined
  }

  /** 解密凭据（内部使用；解密失败返回 undefined —— 密钥更换后的降级语义） */
  getSecret(id: string): Record<string, unknown> | undefined {
    const row = this.db.get<ConnectionRow>('SELECT secret_enc FROM connections WHERE id = ?', id)
    if (!row?.secret_enc) return undefined
    const value = this.vault.decrypt(row.secret_enc)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  }

  create(input: ConnectionCreateInput): ConnectionDefinition {
    if (this.findByName(input.name)) throw new Error(`连接名「${input.name}」已存在`)
    const id = `conn_${randomUUID().slice(0, 8)}`
    const ts = nowIso()
    const scope = input.scope === 'personal' ? 'personal' : 'system'
    this.db.run(
      `INSERT INTO connections (id, name, kind, config, secret_enc, status, enabled, scope, owner_id, member_use, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.kind,
      JSON.stringify(input.config ?? {}),
      input.secret && Object.keys(input.secret).length > 0 ? this.vault.encrypt(input.secret) : null,
      input.enabled === false ? 0 : 1,
      scope,
      scope === 'personal' ? (input.ownerId ?? null) : null,
      input.memberUse === false ? 0 : 1,
      ts,
      ts,
    )
    return this.get(id)!
  }

  update(id: string, patch: ConnectionUpdatePatch): ConnectionDefinition | undefined {
    const current = this.get(id)
    if (!current) return undefined
    if (patch.name && patch.name !== current.name && this.findByName(patch.name)) {
      throw new Error(`连接名「${patch.name}」已存在`)
    }
    const sets: string[] = ['updated_at = ?']
    const params: Array<string | number | null> = [nowIso()]
    if (patch.name !== undefined) {
      sets.push('name = ?')
      params.push(patch.name)
    }
    if (patch.config !== undefined) {
      sets.push('config = ?')
      params.push(JSON.stringify(patch.config))
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?')
      params.push(patch.enabled ? 1 : 0)
    }
    // M57 P3：成员可用开关（仅 system 连接有意义；personal 传参忽略）
    if (patch.memberUse !== undefined && (current.scope ?? 'system') === 'system') {
      sets.push('member_use = ?')
      params.push(patch.memberUse ? 1 : 0)
    }
    if (patch.secret !== undefined) {
      sets.push('secret_enc = ?')
      params.push(
        patch.secret && Object.keys(patch.secret).length > 0 ? this.vault.encrypt(patch.secret) : null,
      )
    }
    this.db.run(`UPDATE connections SET ${sets.join(', ')} WHERE id = ?`, ...params, id)
    return this.get(id)
  }

  remove(id: string): boolean {
    const result = this.db.run('DELETE FROM connections WHERE id = ?', id)
    return result.changes > 0
  }

  /** 测试 / 健康检查结果回写（状态灯数据源） */
  setStatus(id: string, status: ConnectionStatus, error?: string): void {
    this.db.run(
      'UPDATE connections SET status = ?, last_checked_at = ?, last_error = ?, updated_at = ? WHERE id = ?',
      status,
      nowIso(),
      error ? error.slice(0, 500) : null,
      nowIso(),
      id,
    )
  }

  // ---------- 会话绑定 ----------

  bind(sessionId: string, connectionId: string): void {
    this.db.run(
      `INSERT INTO session_connections (session_id, connection_id, granted_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id, connection_id) DO NOTHING`,
      sessionId,
      connectionId,
      nowIso(),
    )
  }

  unbind(sessionId: string, connectionId: string): boolean {
    const result = this.db.run(
      'DELETE FROM session_connections WHERE session_id = ? AND connection_id = ?',
      sessionId,
      connectionId,
    )
    return result.changes > 0
  }

  /** 会话已绑定的连接（含禁用标记，调用方自行过滤 enabled） */
  connectionsOf(sessionId: string): Array<{ connection: ConnectionDefinition; grantedAt: string }> {
    const rows = this.db.all<BindingRow>(
      'SELECT connection_id, granted_at FROM session_connections WHERE session_id = ? ORDER BY granted_at ASC',
      sessionId,
    )
    const out: Array<{ connection: ConnectionDefinition; grantedAt: string }> = []
    for (const row of rows) {
      const connection = this.get(row.connection_id)
      if (connection) out.push({ connection, grantedAt: row.granted_at })
    }
    return out
  }

  /** 绑定校验（工具运行时最小权限检查） */
  isBound(sessionId: string, connectionId: string): boolean {
    const row = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM session_connections WHERE session_id = ? AND connection_id = ?',
      sessionId,
      connectionId,
    )
    return Number(row?.n ?? 0) > 0
  }
}
