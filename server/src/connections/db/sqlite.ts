/**
 * SQLite 连接器（M22）：基于 Node 内置 `node:sqlite`（与主库驱动一致，零新增依赖）。
 *
 * 特点与边界：
 * - 同步 API：在事件循环上执行（本地开发库体积有限；小查询毫秒级，可接受）；
 * - readOnly（默认）：以只读方式打开文件 + 护栏双保险；
 *   注意 allowWrites=true 时需以可写方式打开（与 manager 权限链 readOnly && !allowWrites 一致），
 *   否则护栏/审批门放行的写操作会撞上驱动层 readonly 报错；
 * - sqlite 无连接池概念，句柄 = 文件句柄（打开一次，管理器负责回收）；
 * - 不自动建库：路径不存在时明确报错（防误建空库掩盖配置错误）。
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import { getLogger } from '../../logger.js'
import { analyzeSql } from './guard.js'
import {
  cfgBool,
  cfgNumber,
  cfgString,
  normalizeParam,
  sanitizeRowValue,
  type DbConnector,
  type DbHandle,
  type DbProbeResult,
  type DbQueryOptions,
  type DbQueryResult,
  type DbSchemaSnapshot,
} from './types.js'

// node:sqlite 为实验内置模块（静态 import 在 vitest/vite 下解析失败），统一走 createRequire
const nodeRequire = createRequire(import.meta.url)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => DatabaseSyncType
}

interface SqliteColumnMeta {
  name: string
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): { changes: number | bigint }
  columns(): SqliteColumnMeta[]
}

interface SqliteDb {
  prepare(sql: string): SqliteStatement
  close(): void
}

class SqliteHandle implements DbHandle {
  private closed = false

  constructor(private readonly db: SqliteDb) {}

  async query(sql: string, params: unknown[], opts: DbQueryOptions): Promise<DbQueryResult> {
    const started = Date.now()
    const normalized = params.map(normalizeParam)
    const stmt = this.db.prepare(sql)
    const analysis = analyzeSql(sql)
    const isWrite =
      analysis.mutating ||
      !['SELECT', 'WITH', 'EXPLAIN', 'PRAGMA', 'TABLE', 'VALUES'].includes(analysis.firstKeyword)

    if (isWrite) {
      if (opts.readOnly) throw new Error('只读连接不允许执行写语句（护栏已在执行层拦截，此为兜底）')
      const result = stmt.run(...normalized)
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        durationMs: Date.now() - started,
        affectedRows: Number(result.changes ?? 0),
      }
    }

    const columns = stmt.columns().map((c) => c.name)
    const all = stmt.all(...normalized) as Array<Record<string, unknown>>
    const rowCount = all.length
    const limited = rowCount > opts.maxRows ? all.slice(0, opts.maxRows) : all
    return {
      columns,
      rows: limited.map((row) => {
        const out: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(row)) out[key] = sanitizeRowValue(value)
        return out
      }),
      rowCount,
      truncated: rowCount > opts.maxRows,
      durationMs: Date.now() - started,
    }
  }

  async schema(opts: { maxTables: number; timeoutMs: number }): Promise<DbSchemaSnapshot> {
    const tables = this.db
      .prepare(
        `SELECT name, type FROM sqlite_master
         WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
         ORDER BY name LIMIT ?`,
      )
      .all(opts.maxTables + 1) as Array<{ name: string; type: string }>
    const truncated = tables.length > opts.maxTables
    const out = tables.slice(0, opts.maxTables).map((t) => {
      let columns: Array<{ name: string; type?: string; nullable?: boolean }> = []
      try {
        const info = this.db.prepare(`PRAGMA table_info(${quoteSqliteIdent(t.name)})`).all() as Array<{
          name: string
          type: string
          notnull: number
        }>
        columns = info.map((c) => ({ name: c.name, type: c.type || undefined, nullable: c.notnull !== 1 }))
      } catch {
        // 视图或损坏表：列信息缺省
      }
      return { name: t.name, kind: t.type, columns }
    })
    return { tables: out, truncated }
  }

  async version(): Promise<string | undefined> {
    try {
      const row = this.db.prepare('SELECT sqlite_version() AS v').all()[0] as { v?: string } | undefined
      return row?.v ? `SQLite ${row.v}` : undefined
    } catch {
      return undefined
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      this.db.close()
    } catch {
      // 已关闭 / 句柄失效：忽略
    }
  }
}

function quoteSqliteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

export class SqliteConnector implements DbConnector {
  readonly kind = 'sqlite' as const

  async probe(): Promise<DbProbeResult> {
    return { ok: true } // node:sqlite 为内置模块，恒可用
  }

  async connect(config: Record<string, unknown>): Promise<DbHandle> {
    const rawPath = cfgString(config, 'path')
    if (!rawPath) throw new Error('SQLite 连接缺少 config.path（数据库文件绝对路径）')
    const file = path.resolve(rawPath)
    if (!fs.existsSync(file)) throw new Error(`SQLite 文件不存在：${file}（不会自动建库，请检查路径）`)
    const readOnly = cfgBool(config, 'readOnly', true) && !cfgBool(config, 'allowWrites', false)
    let db: SqliteDb
    try {
      db = new DatabaseSync(file, { readOnly })
    } catch (err) {
      // readOnly 打开失败时尝试读写打开（部分平台文件锁限制，如 WAL 文件缺 -shm 权限），
      // 再失败则原样抛出；回退意味着驱动层只读保证失效（护栏与执行层写拒绝仍生效），必须留痕。
      try {
        db = new DatabaseSync(file)
        getLogger().warn(
          { file, error: (err as Error).message },
          'SQLite 只读打开失败，已回退为读写打开（护栏与执行层仍限制写操作）',
        )
      } catch {
        throw new Error(`SQLite 打开失败：${(err as Error).message}`)
      }
    }
    // 兜底（config 里可显式 timeoutMs 覆盖；node:sqlite 无语句级超时，仅设置 busy 等待）
    try {
      const busyMs = cfgNumber(config, 'busyTimeoutMs', 5_000)
      ;(db as unknown as { exec(sql: string): void }).exec(
        `PRAGMA busy_timeout = ${Math.max(0, Math.round(busyMs))}`,
      )
    } catch {
      // PRAGMA 失败不影响主功能
    }
    return new SqliteHandle(db)
  }
}
