/**
 * 操作审计存储（M22）：connections 生命周期 / 数据库查询 / 远程命令 / 浏览器动作的全量留痕。
 *
 * 设计原则：
 * - 记录「用户手动操作」与「Agent 工具操作」两类主体（actor: 'user' | agentId）；
 * - 写入失败绝不阻断主流程（内部兜底 try/catch，仅告警日志）；
 * - 保留策略：按 MAX_ROWS 滚动裁剪（本地应用规模足够；导出走 list 全量）。
 */
import { getLogger } from '../logger.js'
import type { AppDb } from './db.js'
import { nowIso } from './sessions.js'

/** 审计动作名（与 OpEvent.action 对齐；新动作直接追加字符串，不强制枚举收敛） */
export type AuditAction =
  | 'connection.create'
  | 'connection.update'
  | 'connection.delete'
  | 'connection.test'
  | 'connection.bind'
  | 'connection.unbind'
  | 'db.query'
  | 'db.execute'
  | 'db.schema'
  | 'db.browse'
  | 'ssh.exec'
  | 'ssh.terminal'
  | 'browser.start'
  | 'browser.attach'
  | 'browser.close'
  | 'browser.action'
  | 'browser.input'
  | 'browser.takeover'
  | 'browser.release'
  // M62：多用户浏览器资源治理（启动对账；实例关闭原因落 browser.close detail）
  | 'browser.reconcile'
  | 'mcp.create'
  | 'mcp.update'
  | 'mcp.delete'
  | 'mcp.test'
  | 'mcp.reconnect'
  | 'mcp.refresh'
  | 'mcp.bind'
  | 'mcp.unbind'
  // M28：mcp.json 直配（手动同步 / 粘贴导入）
  | 'mcp.json-sync'
  | 'mcp.json-import'
  // M57：多用户（账号 / 登录 / 归属）
  | 'auth.setup'
  | 'auth.login'
  | 'auth.logout'
  | 'auth.password-change'
  | 'auth.user-create'
  | 'auth.user-update'
  | 'auth.user-disable'
  | 'auth.user-delete'
  | 'auth.user-password-reset'
  | 'auth.apikey-create'
  | 'auth.apikey-revoke'
  // M57 P2：会话共享（邀请 / 改角色 / 移出 / 自助退出）
  | 'session.share-add'
  | 'session.share-update'
  | 'session.share-remove'
  | 'session.share-leave'
  /** P5 前置：空间私有记忆提升为跨域共享（全局记忆） */
  | 'memory.elevate'
  // M79-C：好友（请求 / 接受 / 拒绝 / 解除 / 拉黑 / 解除拉黑）
  | 'friend.request'
  | 'friend.accept'
  | 'friend.reject'
  | 'friend.remove'
  | 'friend.block'
  | 'friend.unblock'
  // M79-E：触发策略切换（auto / mention）
  | 'session.route-mode-set'
  // M86：接力控制切换（auto / manual）
  | 'session.relay-mode-set'
  // M88：自动编排策略切换（auto / always-plan / never-plan）
  | 'session.autonomy-set'
  // M57 P3：用户配额（管理侧设置）
  | 'auth.quota-set'
  // M57 P3：用户 LLM 凭据（BYOK）
  | 'auth.llm-credential-set'
  | 'auth.llm-credential-clear'
  // M82：运行期设置变更（管理侧；仅记字段清单，不落值）
  | 'settings.update'
  // M90：消息生命周期（撤回 / 仅自己删除）
  | 'message.recall'
  | 'message.hide-self'
  // M90：群主转让
  | 'session.owner-transfer'

export interface AuditInput {
  /** 'user' | agentId */
  actor: string
  action: AuditAction
  /** M57：操作人（users.id；系统 / Agent 动作为空） */
  userId?: string
  /** M57：请求来源 IP（登录 / 用户管理审计用） */
  ip?: string
  resourceType?: string
  resourceId?: string
  sessionId?: string
  runId?: string
  ok?: boolean
  detail?: Record<string, unknown>
  error?: string
}

export interface AuditEntry {
  id: number
  ts: string
  actor: string
  /** M57：操作人（users.id） */
  userId?: string
  /** M57：请求来源 IP */
  ip?: string
  action: string
  resourceType?: string
  resourceId?: string
  sessionId?: string
  runId?: string
  ok: boolean
  detail?: Record<string, unknown>
  error?: string
}

export interface AuditQuery {
  sessionId?: string
  action?: string
  since?: string
  limit?: number
}

interface AuditRow {
  id: number
  ts: string
  actor: string
  user_id: string | null
  ip: string | null
  action: string
  resource_type: string | null
  resource_id: string | null
  session_id: string | null
  run_id: string | null
  ok: number
  detail: string | null
  error: string | null
}

const MAX_ROWS = 20_000

export class AuditStore {
  constructor(private readonly db: AppDb) {}

  /** 写入一条审计（永不抛出；失败仅告警） */
  record(input: AuditInput): void {
    try {
      this.db.run(
        `INSERT INTO audit_log (ts, actor, user_id, ip, action, resource_type, resource_id, session_id, run_id, ok, detail, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        nowIso(),
        input.actor,
        input.userId ?? null,
        input.ip ?? null,
        input.action,
        input.resourceType ?? null,
        input.resourceId ?? null,
        input.sessionId ?? null,
        input.runId ?? null,
        input.ok === false ? 0 : 1,
        input.detail ? JSON.stringify(input.detail).slice(0, 8_000) : null,
        input.error ? input.error.slice(0, 2_000) : null,
      )
      // 滚动裁剪：每 100 条才做一次 COUNT（避免每次写入都全表统计）
      if (Math.random() < 0.01) this.trim()
    } catch (err) {
      getLogger().warn({ err, action: input.action }, '审计写入失败（不影响主流程）')
    }
  }

  private trim(): void {
    try {
      const row = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')
      const count = Number(row?.n ?? 0)
      if (count <= MAX_ROWS) return
      this.db.run(
        `DELETE FROM audit_log WHERE id IN (
           SELECT id FROM audit_log ORDER BY id ASC LIMIT ?
         )`,
        count - MAX_ROWS,
      )
    } catch {
      // 裁剪失败无妨（下次再试）
    }
  }

  list(query: AuditQuery = {}): AuditEntry[] {
    const where: string[] = []
    const params: Array<string | number> = []
    if (query.sessionId) {
      where.push('session_id = ?')
      params.push(query.sessionId)
    }
    if (query.action) {
      where.push('action = ?')
      params.push(query.action)
    }
    if (query.since) {
      where.push('ts >= ?')
      params.push(query.since)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 1_000)
    const rows = this.db.all<AuditRow>(`SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ?`, ...params, limit)
    return rows.map(toEntry).reverse()
  }
}

function toEntry(row: AuditRow): AuditEntry {
  return {
    id: Number(row.id),
    ts: row.ts,
    actor: row.actor,
    userId: row.user_id ?? undefined,
    ip: row.ip ?? undefined,
    action: row.action,
    resourceType: row.resource_type ?? undefined,
    resourceId: row.resource_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    runId: row.run_id ?? undefined,
    ok: row.ok === 1,
    detail: row.detail ? (parseJson(row.detail) as Record<string, unknown>) : undefined,
    error: row.error ?? undefined,
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}
