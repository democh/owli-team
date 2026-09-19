/**
 * 数据库连接管理器（M22）：连接中心 → 护栏 → 连接器 → 审计 的编排层。
 *
 * 职责：
 * - 句柄缓存：按 connectionId 缓存（配置/凭据指纹变化时优雅重建）；空闲回收（定时器）；
 * - 权限链：enabled 检查 → 会话绑定检查（Agent 调用时）→ 只读/写护栏 → 执行；
 * - 审计：每次执行落审计（成功与失败都记，失败带 error）。
 *
 * 说明：manager 不直连 notify（保持存储层无关性）；
 * notify:op 的实时推送由上层（工具运行时 / 路由）负责。
 */
import { createHash } from 'node:crypto'
import type { ConnectionDefinition, ConnectionTestResult } from '@multi-agent/shared'
import type { AppConfig } from '../../config.js'
import type { AuditStore } from '../../store/audit.js'
import type { ConnectionStore } from '../../store/connections.js'
import { MySqlConnector } from './mysql.js'
import { PostgresConnector } from './postgres.js'
import { SqliteConnector } from './sqlite.js'
import { analyzeSql, assertReadOnlySql, assertWritableSql } from './guard.js'
import {
  cfgBool,
  cfgNumber,
  quoteIdent,
  type DbConnector,
  type DbHandle,
  type DbKind,
  type DbQueryResult,
  type DbSchemaSnapshot,
} from './types.js'

const DB_KINDS: readonly DbKind[] = ['postgres', 'mysql', 'sqlite']

function isDbKind(kind: string): kind is DbKind {
  return (DB_KINDS as readonly string[]).includes(kind)
}

export interface DbExecInput {
  connectionId: string
  /** mode='schema' 时忽略 */
  sql?: string
  params?: unknown[]
  mode: 'query' | 'execute' | 'schema'
  /** 'user' | agentId */
  actor: string
  sessionId?: string
  runId?: string
  /** M57 P2：触发者用户 id（审计归因；兼容模式缺省） */
  actorUserId?: string
  /** Agent 调用时必须校验会话绑定；面板手动调用可关 */
  requireBinding?: boolean
}

export interface DbExecOutcome {
  connection: ConnectionDefinition
  mode: DbExecInput['mode']
  query?: DbQueryResult
  schema?: DbSchemaSnapshot
  durationMs: number
}

/** M23 数据库工作台：表数据分页浏览入参 */
export interface TableDataInput {
  connectionId: string
  table: string
  schema?: string
  offset: number
  limit: number
  orderBy?: string
  desc?: boolean
  actor: string
  sessionId?: string
  runId?: string
}

export interface TableDataOutcome {
  columns: string[]
  rows: Array<Record<string, unknown>>
  offset: number
  limit: number
  /** limit+1 探测：还有更多行（避免对大表做 COUNT） */
  hasMore: boolean
  durationMs: number
}

interface HandleEntry {
  handle: DbHandle
  fingerprint: string
  lastUsedAt: number
}

export class DbConnectionManager {
  private readonly connectors = new Map<DbKind, DbConnector>([
    ['sqlite', new SqliteConnector()],
    ['postgres', new PostgresConnector()],
    ['mysql', new MySqlConnector()],
  ])

  private readonly handles = new Map<string, HandleEntry>()
  /** 并发合并：同一连接的句柄建立只发一次 */
  private readonly inflight = new Map<string, Promise<DbHandle>>()
  private sweeper?: NodeJS.Timeout

  constructor(
    private readonly cfg: AppConfig,
    private readonly store: ConnectionStore,
    private readonly audit: AuditStore,
  ) {}

  /** 启动空闲句柄回收（index.ts 组装时调用；进程退出前 closeAll） */
  start(): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => {
      void this.sweepIdle()
    }, 60_000)
    this.sweeper.unref?.()
  }

  async closeAll(): Promise<void> {
    if (this.sweeper) {
      clearInterval(this.sweeper)
      this.sweeper = undefined
    }
    const entries = [...this.handles.values()]
    this.handles.clear()
    this.inflight.clear()
    await Promise.allSettled(entries.map((e) => e.handle.close()))
  }

  private async sweepIdle(): Promise<void> {
    const deadline = Date.now() - this.cfg.dbPoolIdleMs
    for (const [id, entry] of [...this.handles.entries()]) {
      if (entry.lastUsedAt >= deadline) continue
      this.handles.delete(id)
      try {
        await entry.handle.close()
      } catch {
        // 回收失败无妨
      }
    }
  }

  /** 驱动可用性（连接表单预检 / 测试） */
  async probe(kind: DbKind): Promise<{ ok: boolean; detail?: string }> {
    const connector = this.connectors.get(kind)
    if (!connector) return { ok: false, detail: `不支持的数据库类型：${kind}` }
    return connector.probe()
  }

  private fingerprintOf(
    connection: ConnectionDefinition,
    secret: Record<string, unknown> | undefined,
  ): string {
    return createHash('sha256')
      .update(JSON.stringify(connection.config))
      .update('|')
      .update(JSON.stringify(secret ?? {}))
      .digest('hex')
      .slice(0, 16)
  }

  /** 取得（或建立）连接句柄；调用方保证 connection.kind 合法 */
  private async ensureHandle(connection: ConnectionDefinition): Promise<DbHandle> {
    const kind = connection.kind as DbKind
    const secret = this.store.getSecret(connection.id) ?? {}
    const fingerprint = this.fingerprintOf(connection, secret)
    const cached = this.handles.get(connection.id)
    if (cached && cached.fingerprint === fingerprint) {
      cached.lastUsedAt = Date.now()
      return cached.handle
    }
    const pending = this.inflight.get(connection.id)
    if (pending) return pending

    const task = (async (): Promise<DbHandle> => {
      const connector = this.connectors.get(kind)
      if (!connector) throw new Error(`不支持的数据库类型：${kind}`)
      const handle = await connector.connect(connection.config, secret)
      const old = this.handles.get(connection.id)
      this.handles.set(connection.id, { handle, fingerprint, lastUsedAt: Date.now() })
      if (old) {
        try {
          await old.handle.close()
        } catch {
          // 旧句柄关闭失败无妨
        }
      }
      return handle
    })()
    this.inflight.set(connection.id, task)
    try {
      return await task
    } finally {
      this.inflight.delete(connection.id)
    }
  }

  /** 解析连接 + 权限链校验（返回连接与只读标记） */
  private resolve(input: DbExecInput): { connection: ConnectionDefinition; readOnly: boolean } {
    const connection = this.store.get(input.connectionId)
    if (!connection) throw new Error('连接不存在')
    if (!connection.enabled) throw new Error(`连接「${connection.name}」已禁用`)
    if (!isDbKind(connection.kind))
      throw new Error(`连接「${connection.name}」不是数据库类型（${connection.kind}）`)
    if (input.requireBinding && input.sessionId) {
      if (!this.store.isBound(input.sessionId, connection.id)) {
        throw new Error(`会话未绑定连接「${connection.name}」：请在「连接管理」中先绑定`)
      }
    }
    const allowWrites = cfgBool(connection.config, 'allowWrites', false)
    const connReadOnly = cfgBool(connection.config, 'readOnly', true)
    const readOnly = connReadOnly && !allowWrites
    return { connection, readOnly }
  }

  /** 执行查询 / 写 / schema（统一入口；失败也落审计后抛错） */
  async exec(input: DbExecInput): Promise<DbExecOutcome> {
    const started = Date.now()
    let connection: ConnectionDefinition | undefined
    try {
      const resolved = this.resolve(input)
      connection = resolved.connection
      const { readOnly } = resolved
      const timeoutMs = cfgNumber(connection.config, 'timeoutMs', this.cfg.dbQueryTimeoutMs)
      const maxRows = cfgNumber(connection.config, 'maxRows', this.cfg.dbQueryMaxRows)

      if (input.mode === 'schema') {
        const handle = await this.ensureHandle(connection)
        const schema = await handle.schema({ maxTables: this.cfg.dbSchemaMaxTables, timeoutMs })
        const durationMs = Date.now() - started
        this.audit.record({
          actor: input.actor,
          action: 'db.schema',
          userId: input.actorUserId,
          resourceType: 'connection',
          resourceId: connection.id,
          sessionId: input.sessionId,
          runId: input.runId,
          detail: { tables: schema.tables.length, truncated: schema.truncated, durationMs },
        })
        return { connection, mode: 'schema', schema, durationMs }
      }

      const sql = input.sql ?? ''
      if (input.mode === 'query') {
        const verdict = assertReadOnlySql(sql)
        if (!verdict.ok) throw new Error(verdict.reason)
      } else {
        if (readOnly) {
          throw new Error(
            `连接「${connection.name}」为只读：如需写操作，请在连接设置中开启「允许写入」（将经过审批门）`,
          )
        }
        const verdict = assertWritableSql(sql)
        if (!verdict.ok) throw new Error(verdict.reason)
      }

      const handle = await this.ensureHandle(connection)
      // mode='query' 恒按只读执行（工具契约）：即便连接开了「允许写入」，也只读事务 / 驱动层拒绝
      // ——护栏之外的第二道防线（纵深防御）。
      const query = await handle.query(sql, input.params ?? [], {
        maxRows,
        timeoutMs,
        readOnly: readOnly || input.mode === 'query',
      })
      const durationMs = Date.now() - started
      const analysis = analyzeSql(sql)
      this.audit.record({
        actor: input.actor,
        action: input.mode === 'query' ? 'db.query' : 'db.execute',
        userId: input.actorUserId,
        resourceType: 'connection',
        resourceId: connection.id,
        sessionId: input.sessionId,
        runId: input.runId,
        detail: {
          kind: connection.kind,
          sql: sql.slice(0, 500),
          params: (input.params ?? []).length,
          firstKeyword: analysis.firstKeyword,
          rowCount: query.rowCount,
          truncated: query.truncated,
          affectedRows: query.affectedRows,
          durationMs,
        },
      })
      return { connection, mode: input.mode, query, durationMs }
    } catch (err) {
      const durationMs = Date.now() - started
      this.audit.record({
        actor: input.actor,
        action: input.mode === 'schema' ? 'db.schema' : input.mode === 'query' ? 'db.query' : 'db.execute',
        userId: input.actorUserId,
        resourceType: 'connection',
        resourceId: input.connectionId,
        sessionId: input.sessionId,
        runId: input.runId,
        ok: false,
        detail: { sql: (input.sql ?? '').slice(0, 500), durationMs },
        error: (err as Error).message,
      })
      throw err
    }
  }

  /**
   * 表数据分页浏览（M23 数据库工作台）：表名 / 列名按结构快照白名单校验，
   * SQL 由服务端拼装（标识符按方言引用），始终只读执行并落审计。
   */
  async tableData(input: TableDataInput): Promise<TableDataOutcome> {
    const started = Date.now()
    const connection = this.store.get(input.connectionId)
    if (!connection) throw new Error('连接不存在')
    if (!connection.enabled) throw new Error(`连接「${connection.name}」已禁用`)
    if (!isDbKind(connection.kind))
      throw new Error(`连接「${connection.name}」不是数据库类型（${connection.kind}）`)
    const kind = connection.kind
    const timeoutMs = cfgNumber(connection.config, 'timeoutMs', this.cfg.dbQueryTimeoutMs)
    const limit = Math.min(Math.max(Math.trunc(input.limit) || 100, 1), 500)
    const offset = Math.max(Math.trunc(input.offset) || 0, 0)

    try {
      const handle = await this.ensureHandle(connection)
      const snapshot = await handle.schema({ maxTables: this.cfg.dbSchemaMaxTables, timeoutMs })
      const byName = snapshot.tables.filter((t) => t.name === input.table)
      const target = input.schema ? byName.find((t) => t.schema === input.schema) : byName[0]
      if (!target) {
        throw new Error(
          `表「${input.table}」不在结构快照中（共 ${snapshot.tables.length} 张表）——请刷新结构后重试`,
        )
      }
      const columnNames = new Set(target.columns.map((c) => c.name))
      if (input.orderBy && !columnNames.has(input.orderBy)) {
        throw new Error(`排序列「${input.orderBy}」不存在于表「${input.table}」`)
      }
      const qualifier = (target.schema ? [target.schema, target.name] : [target.name])
        .map((name) => quoteIdent(kind, name))
        .join('.')
      const order = input.orderBy
        ? ` ORDER BY ${quoteIdent(kind, input.orderBy)} ${input.desc ? 'DESC' : 'ASC'}`
        : ''
      // limit+1 探测是否还有更多行（避免对大表做 COUNT；行数注入已钳制）
      const sql = `SELECT * FROM ${qualifier}${order} LIMIT ${limit + 1} OFFSET ${offset}`
      const result = await handle.query(sql, [], { maxRows: limit + 1, timeoutMs, readOnly: true })
      const hasMore = result.rows.length > limit
      const rows = hasMore ? result.rows.slice(0, limit) : result.rows
      const durationMs = Date.now() - started
      this.audit.record({
        actor: input.actor,
        action: 'db.browse',
        resourceType: 'connection',
        resourceId: connection.id,
        sessionId: input.sessionId,
        runId: input.runId,
        detail: {
          table: target.name,
          schema: target.schema,
          offset,
          limit,
          orderBy: input.orderBy,
          desc: input.desc,
          hasMore,
          rows: rows.length,
          durationMs,
        },
      })
      return { columns: result.columns, rows, offset, limit, hasMore, durationMs }
    } catch (err) {
      this.audit.record({
        actor: input.actor,
        action: 'db.browse',
        resourceType: 'connection',
        resourceId: connection.id,
        sessionId: input.sessionId,
        runId: input.runId,
        ok: false,
        detail: { table: input.table, offset, limit, durationMs: Date.now() - started },
        error: (err as Error).message,
      })
      throw err
    }
  }

  /** 连接测试（回写状态灯 + 审计）：驱动探测 → 建句柄 → 版本查询 */
  async test(connectionId: string, actor: string): Promise<ConnectionTestResult> {
    const started = Date.now()
    const connection = this.store.get(connectionId)
    if (!connection) return { ok: false, error: '连接不存在' }
    if (!isDbKind(connection.kind)) return { ok: false, error: `「${connection.name}」不是数据库连接` }
    const probe = await this.probe(connection.kind)
    if (!probe.ok) {
      this.store.setStatus(connection.id, 'error', probe.detail)
      this.audit.record({
        actor,
        action: 'connection.test',
        resourceType: 'connection',
        resourceId: connection.id,
        ok: false,
        error: probe.detail,
      })
      return { ok: false, error: probe.detail }
    }
    try {
      // 测试时强制重建句柄（避免命中陈旧缓存掩盖配置错误）
      const cached = this.handles.get(connection.id)
      if (cached) {
        this.handles.delete(connection.id)
        await cached.handle.close().catch(() => undefined)
      }
      const handle = await this.ensureHandle(connection)
      const version = await handle.version()
      const latencyMs = Date.now() - started
      this.store.setStatus(connection.id, 'ok')
      this.audit.record({
        actor,
        action: 'connection.test',
        resourceType: 'connection',
        resourceId: connection.id,
        detail: { latencyMs, version },
      })
      return { ok: true, latencyMs, detail: version }
    } catch (err) {
      const message = (err as Error).message
      this.store.setStatus(connection.id, 'error', message)
      this.audit.record({
        actor,
        action: 'connection.test',
        resourceType: 'connection',
        resourceId: connection.id,
        ok: false,
        error: message,
      })
      return { ok: false, error: message }
    }
  }

  /** 连接移除 / 更新后的句柄失效（路由层在 delete/update 后调用） */
  async invalidate(connectionId: string): Promise<void> {
    const entry = this.handles.get(connectionId)
    if (!entry) return
    this.handles.delete(connectionId)
    try {
      await entry.handle.close()
    } catch {
      // 忽略
    }
  }
}
