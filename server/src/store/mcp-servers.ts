/**
 * MCP 服务器存储（M27）：mcp_servers + session_mcp_servers 两表 CRUD 与会话绑定。
 *
 * 凭据安全：stdio env / http headers 经 SecretVault 加密后落 `secret_enc`；
 * 对外视图一律脱敏（仅 secretSet）；
 * 绑定语义：会话绑定的服务器即「Agent 可用清单」——工具运行时按此做最小权限校验。
 */
import { randomUUID } from 'node:crypto'
import type { McpServerConfig, McpServerDefinition, McpServerStatus, McpToolInfo, McpTransportKind } from '@multi-agent/shared'
import type { SecretVault } from '../connections/crypto.js'
import { isValidMcpSlug } from '../mcp/naming.js'
import type { AppDb } from './db.js'
import { nowIso } from './sessions.js'

export interface McpServerCreateInput {
  name: string
  displayName?: string | null
  transport: McpTransportKind
  config: McpServerConfig
  secret?: Record<string, unknown> | null
  enabled?: boolean
  source?: 'env' | 'ui' | 'json'
  /** M57 P3：作用域（缺省 system；personal 需同时给 ownerId） */
  scope?: 'system' | 'personal'
  ownerId?: string
}

export interface McpServerUpdatePatch {
  name?: string
  /** 缺省 = 不改动；null = 清空 */
  displayName?: string | null
  transport?: McpTransportKind
  config?: McpServerConfig
  /** 缺省 = 不改动；null = 清空 */
  secret?: Record<string, unknown> | null
  enabled?: boolean
}

interface McpServerRow {
  id: string
  name: string
  display_name: string | null
  transport: string
  config: string
  secret_enc: string | null
  tools_json: string
  status: string
  last_checked_at: string | null
  last_error: string | null
  enabled: number
  source: string
  /** M57 P3：作用域 / 属主（v14 列；旧库可能为 NULL） */
  scope: string | null
  owner_id: string | null
  created_at: string
  updated_at: string
}

interface BindingRow {
  server_id: string
  granted_at: string
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function parseTools(raw: string): McpToolInfo[] {
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return value.filter(
      (item): item is McpToolInfo =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as McpToolInfo).registeredName === 'string' &&
        typeof (item as McpToolInfo).rawName === 'string',
    )
  } catch {
    return []
  }
}

function toDefinition(row: McpServerRow): McpServerDefinition {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name ?? undefined,
    transport: row.transport as McpTransportKind,
    config: parseJsonObject(row.config) as McpServerConfig,
    secretSet: Boolean(row.secret_enc),
    enabled: row.enabled === 1,
    status: row.status as McpServerStatus,
    lastCheckedAt: row.last_checked_at ?? undefined,
    lastError: row.last_error ?? undefined,
    tools: parseTools(row.tools_json),
    source: row.source === 'env' ? 'env' : row.source === 'json' ? 'json' : 'ui',
    // M57 P3：旧库 NULL → system（与迁移默认一致）
    scope: (row.scope as 'system' | 'personal') ?? 'system',
    ownerId: row.owner_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class McpServerStore {
  constructor(
    private readonly db: AppDb,
    private readonly vault: SecretVault,
  ) {}

  // ---------- CRUD ----------

  list(): McpServerDefinition[] {
    const rows = this.db.all<McpServerRow>('SELECT * FROM mcp_servers ORDER BY created_at ASC')
    return rows.map(toDefinition)
  }

  /**
   * M57 P3：用户可见清单 = 全部 system 服务器（团队共享，成员可绑定使用）∪ 本人 personal。
   * 路由层对非本人 personal 条目做拒绝/过滤（成员不看 system 管理细节，但绑定候选需要 name/status）。
   */
  listForUser(userId: string): McpServerDefinition[] {
    const rows = this.db.all<McpServerRow>(
      `SELECT * FROM mcp_servers WHERE scope = 'system' OR (scope = 'personal' AND owner_id = ?) ORDER BY created_at ASC`,
      userId,
    )
    return rows.map(toDefinition)
  }

  /** M57 P3：personal 属主判定（会话绑定 / 工具执行 / 资源级守卫共用） */
  ownsPersonal(userId: string, id: string): boolean {
    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM mcp_servers WHERE id = ? AND scope = 'personal' AND owner_id = ?`,
      id,
      userId,
    )
    return Number(row?.n ?? 0) > 0
  }

  /** M57 P3：服务器属主（system 返回 undefined；引擎/运行时最小权限复核用） */
  ownerOf(id: string): string | undefined {
    const row = this.db.get<{ owner_id: string | null }>(
      `SELECT owner_id FROM mcp_servers WHERE id = ? AND scope = 'personal'`,
      id,
    )
    return row?.owner_id ?? undefined
  }

  /** M57 P3：删除某用户全部 personal 服务器（账号删除级联；绑定行随 FK 自动清理），返回删除数 */
  removePersonalOf(userId: string): number {
    const result = this.db.run(`DELETE FROM mcp_servers WHERE scope = 'personal' AND owner_id = ?`, userId)
    return result.changes
  }

  get(id: string): McpServerDefinition | undefined {
    const row = this.db.get<McpServerRow>('SELECT * FROM mcp_servers WHERE id = ?', id)
    return row ? toDefinition(row) : undefined
  }

  findByName(name: string): McpServerDefinition | undefined {
    const row = this.db.get<McpServerRow>('SELECT * FROM mcp_servers WHERE name = ?', name)
    return row ? toDefinition(row) : undefined
  }

  /** 解密凭据（内部使用；解密失败 / 未保存返回 undefined） */
  getSecret(id: string): Record<string, unknown> | undefined {
    const row = this.db.get<McpServerRow>('SELECT secret_enc FROM mcp_servers WHERE id = ?', id)
    if (!row?.secret_enc) return undefined
    const value = this.vault.decrypt(row.secret_enc)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  }

  create(input: McpServerCreateInput): McpServerDefinition {
    if (!isValidMcpSlug(input.name)) {
      throw new Error(`服务器名「${input.name}」非法：需为小写 slug（^[a-z][a-z0-9-]{0,39}$），将作为工具名前缀`)
    }
    if (this.findByName(input.name)) throw new Error(`MCP 服务器名「${input.name}」已存在`)
    const id = `mcp_${randomUUID().slice(0, 8)}`
    const ts = nowIso()
    const scope = input.scope === 'personal' ? 'personal' : 'system'
    this.db.run(
      `INSERT INTO mcp_servers (id, name, display_name, transport, config, secret_enc, tools_json, status, enabled, source, scope, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '[]', 'idle', ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.displayName ?? null,
      input.transport,
      JSON.stringify(input.config ?? {}),
      input.secret && Object.keys(input.secret).length > 0 ? this.vault.encrypt(input.secret) : null,
      input.enabled === false ? 0 : 1,
      input.source === 'env' ? 'env' : input.source === 'json' ? 'json' : 'ui',
      scope,
      scope === 'personal' ? (input.ownerId ?? null) : null,
      ts,
      ts,
    )
    return this.get(id)!
  }

  update(id: string, patch: McpServerUpdatePatch): McpServerDefinition | undefined {
    const current = this.get(id)
    if (!current) return undefined
    if (patch.name !== undefined && patch.name !== current.name) {
      if (!isValidMcpSlug(patch.name)) {
        throw new Error(`服务器名「${patch.name}」非法：需为小写 slug（^[a-z][a-z0-9-]{0,39}$）`)
      }
      if (this.findByName(patch.name)) throw new Error(`MCP 服务器名「${patch.name}」已存在`)
    }
    const sets: string[] = ['updated_at = ?']
    const params: Array<string | number | null> = [nowIso()]
    if (patch.name !== undefined) {
      sets.push('name = ?')
      params.push(patch.name)
    }
    if (patch.displayName !== undefined) {
      sets.push('display_name = ?')
      params.push(patch.displayName)
    }
    if (patch.transport !== undefined) {
      sets.push('transport = ?')
      params.push(patch.transport)
    }
    if (patch.config !== undefined) {
      sets.push('config = ?')
      params.push(JSON.stringify(patch.config))
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?')
      params.push(patch.enabled ? 1 : 0)
    }
    if (patch.secret !== undefined) {
      sets.push('secret_enc = ?')
      params.push(
        patch.secret && Object.keys(patch.secret).length > 0 ? this.vault.encrypt(patch.secret) : null,
      )
    }
    this.db.run(`UPDATE mcp_servers SET ${sets.join(', ')} WHERE id = ?`, ...params, id)
    return this.get(id)
  }

  remove(id: string): boolean {
    const result = this.db.run('DELETE FROM mcp_servers WHERE id = ?', id)
    return result.changes > 0
  }

  /** 测试 / 健康检查结果回写（状态灯数据源） */
  setStatus(id: string, status: McpServerStatus, error?: string): void {
    this.db.run(
      'UPDATE mcp_servers SET status = ?, last_checked_at = ?, last_error = ?, updated_at = ? WHERE id = ?',
      status,
      nowIso(),
      error ? error.slice(0, 500) : null,
      nowIso(),
      id,
    )
  }

  /** 工具清单快照回写（连接 / 刷新时更新） */
  setTools(id: string, tools: McpToolInfo[]): void {
    this.db.run('UPDATE mcp_servers SET tools_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(tools), nowIso(), id)
  }

  // ---------- 会话绑定 ----------

  bind(sessionId: string, serverId: string): void {
    this.db.run(
      `INSERT INTO session_mcp_servers (session_id, server_id, granted_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id, server_id) DO NOTHING`,
      sessionId,
      serverId,
      nowIso(),
    )
  }

  unbind(sessionId: string, serverId: string): boolean {
    const result = this.db.run(
      'DELETE FROM session_mcp_servers WHERE session_id = ? AND server_id = ?',
      sessionId,
      serverId,
    )
    return result.changes > 0
  }

  /** 会话已绑定的服务器（含禁用标记，调用方自行过滤 enabled） */
  serversOf(sessionId: string): Array<{ server: McpServerDefinition; grantedAt: string }> {
    const rows = this.db.all<BindingRow>(
      'SELECT server_id, granted_at FROM session_mcp_servers WHERE session_id = ? ORDER BY granted_at ASC',
      sessionId,
    )
    const out: Array<{ server: McpServerDefinition; grantedAt: string }> = []
    for (const row of rows) {
      const server = this.get(row.server_id)
      if (server) out.push({ server, grantedAt: row.granted_at })
    }
    return out
  }

  /** 绑定校验（工具运行时最小权限检查） */
  isBound(sessionId: string, serverId: string): boolean {
    const row = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM session_mcp_servers WHERE session_id = ? AND server_id = ?',
      sessionId,
      serverId,
    )
    return Number(row?.n ?? 0) > 0
  }
}
