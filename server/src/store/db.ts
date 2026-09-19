/**
 * SQLite 适配层（M1 数据地基）。
 *
 * 驱动：Node 内置 `node:sqlite`（Node 22.5+，本仓库要求 20+/推荐 22+，实测环境 24）。
 * 隔离在此文件的意义：全部 SQL 只经过 AppDb，若要换 better-sqlite3 只需新增一个 Driver 实现，
 * 业务侧（store/*）零改动。风险对策见计划 §15「better-sqlite3 原生编译失败」。
 *
 * 约定：
 * - 全部 SQL 使用位置参数 `?`（不依赖命名参数），保证驱动可替换；
 * - node:sqlite 不接受 boolean，统一用 0/1；
 * - 事务：嵌套时使用 savepoint，rollback 后状态自洽。
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import { getLogger } from '../logger.js'
import { MIGRATIONS } from './migrations.js'

// `node:sqlite` 是实验内置模块，未收录进 Node 的 builtinModules 清单，
// 静态 import 会被 Vite 解析为裸模块 'sqlite' 而失败（vitest）；改用 createRequire 走 Node 原生加载。
const nodeRequire = createRequire(import.meta.url)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (file: string, options?: { allowExtension?: boolean }) => DatabaseSyncType
}

export type SqlValue = string | number | bigint | null | Uint8Array

export interface RunResult {
  changes: number
  lastInsertRowid: number
}

export interface PreparedStatement {
  all<T = Record<string, unknown>>(...params: SqlValue[]): T[]
  get<T = Record<string, unknown>>(...params: SqlValue[]): T | undefined
  run(...params: SqlValue[]): RunResult
}

export interface SqlDriver {
  readonly name: string
  exec(sql: string): void
  prepare(sql: string): PreparedStatement
  close(): void
  /** M25：加载 SQLite 扩展（可选能力；返回是否加载成功；不支持的驱动缺省 undefined） */
  loadExtension?(file: string): boolean
}

/** node:sqlite 驱动适配（StatementSync 与目标接口同构，仅做类型收敛） */
class NodeSqliteDriver implements SqlDriver {
  readonly name = 'node:sqlite'
  private db: DatabaseSyncType
  /** M25：是否以 allowExtension 构造（旧版 Node 无该选项 → 扩展通道不可用，回落 JS 后端） */
  private readonly extensionCapable: boolean

  constructor(file: string, allowExtension = true) {
    if (allowExtension) {
      try {
        // 扩展加载硬前提（Node ≥ 22.13/23.5）：必须构造时开启，事后 enableLoadExtension 会报
        // "Cannot enable extension loading because it was disabled at database creation"
        this.db = new DatabaseSync(file, { allowExtension: true })
        this.extensionCapable = true
        return
      } catch {
        // 旧版 Node 不识别该选项：按普通模式重建（后续 loadExtension 一律拒绝）
      }
    }
    this.db = new DatabaseSync(file)
    this.extensionCapable = false
  }

  /** M25：加载扩展（如 sqlite-vec）。受控路径一次性加载，随后立即收回许可（最小权限）。 */
  loadExtension(file: string): boolean {
    if (!this.extensionCapable) return false
    const db = this.db as unknown as {
      enableLoadExtension?: (allow: boolean) => void
      loadExtension?: (path: string) => void
    }
    if (typeof db.enableLoadExtension !== 'function' || typeof db.loadExtension !== 'function') return false
    db.enableLoadExtension(true)
    try {
      db.loadExtension(file)
      return true
    } finally {
      try {
        db.enableLoadExtension(false)
      } catch {
        // 收回许可失败不影响已加载的扩展
      }
    }
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  prepare(sql: string): PreparedStatement {
    const stmt = this.db.prepare(sql)
    return {
      all: <T>(...params: SqlValue[]) => stmt.all(...params) as T[],
      get: <T>(...params: SqlValue[]) => stmt.get(...params) as T | undefined,
      run: (...params: SqlValue[]) => {
        const r = stmt.run(...params)
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
      },
    }
  }

  close(): void {
    this.db.close()
  }
}

export class AppDb {
  private cache = new Map<string, PreparedStatement>()
  private txDepth = 0

  constructor(
    private readonly driver: SqlDriver,
    readonly file: string,
  ) {}

  get driverName(): string {
    return this.driver.name
  }

  exec(sql: string): void {
    this.driver.exec(sql)
  }

  stmt(sql: string): PreparedStatement {
    let s = this.cache.get(sql)
    if (!s) {
      s = this.driver.prepare(sql)
      this.cache.set(sql, s)
    }
    return s
  }

  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[] {
    return this.stmt(sql).all<T>(...params)
  }

  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.stmt(sql).get<T>(...params)
  }

  run(sql: string, ...params: SqlValue[]): RunResult {
    return this.stmt(sql).run(...params)
  }

  /** 事务：最外层 BEGIN，嵌套用 savepoint */
  tx<T>(fn: () => T): T {
    const depth = this.txDepth++
    const savepoint = `sp_${depth}`
    this.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`)
    try {
      const result = fn()
      this.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`)
      return result
    } catch (err) {
      try {
        this.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`)
      } catch {
        // 回滚失败时保持原始异常（库可能已被关闭）
      }
      throw err
    } finally {
      this.txDepth = depth
    }
  }

  close(): void {
    this.cache.clear()
    this.driver.close()
  }

  /** M25：加载 SQLite 扩展（能力缺失 / 加载失败均返回 false，调用方降级；不抛出） */
  loadExtension(file: string): boolean {
    try {
      return this.driver.loadExtension?.(file) ?? false
    } catch (err) {
      getLogger().warn({ err: (err as Error).message, file }, 'SQLite 扩展加载失败（降级为 JS 后端）')
      return false
    }
  }

  // ---------- 通用键值（设置覆盖 / 游标） ----------

  kvGet(key: string): string | undefined {
    const row = this.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)
    return row?.value
  }

  kvSet(key: string, value: string): void {
    this.run(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
      new Date().toISOString(),
    )
  }
}

export interface MigrationReport {
  applied: number[]
  skipped: Array<{ version: number; reason: string }>
}

/** 迁移器：按 version 升序执行未应用的迁移，记录 schema_migrations */
export function applyMigrations(db: AppDb): MigrationReport {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`)
  const done = new Set(
    db.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => Number(r.version)),
  )
  const report: MigrationReport = { applied: [], skipped: [] }
  for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (done.has(migration.version)) continue
    try {
      db.tx(() => {
        db.exec(migration.sql)
        db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', migration.version, migration.name, new Date().toISOString())
      })
      report.applied.push(migration.version)
    } catch (err) {
      const reason = (err as Error).message
      // 审核 fix-low：ADD COLUMN 类迁移无 IF NOT EXISTS，旧库若结构已含该列（仅缺迁移记录）会报
      // duplicate column name。此时目标结构已存在，视为已应用并补记，保证「从旧库收敛到同一结构」。
      if (/duplicate column name/i.test(reason)) {
        db.run(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
          migration.version,
          migration.name,
          new Date().toISOString(),
        )
        report.applied.push(migration.version)
        continue
      }
      // 单个迁移失败：记录并继续（如 FTS5 不可用的构建 → 跳过全文索引，不影响主功能）
      report.skipped.push({ version: migration.version, reason })
    }
  }
  return report
}

export interface OpenDbOptions {
  /** 显式为 true 时附加只读打开（测试用） */
  memory?: boolean
  /** M25：禁用扩展通道（测试强制 JS 后端做双后端对照） */
  noExtensions?: boolean
}

/** 打开（必要时创建）数据库并完成迁移 */
export function openDatabase(file: string, opts: OpenDbOptions = {}): AppDb {
  const allowExtension = !opts.noExtensions
  if (opts.memory) {
    const db = new AppDb(new NodeSqliteDriver(':memory:', allowExtension), ':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    logMigrationReport(applyMigrations(db), ':memory:')
    return db
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new AppDb(new NodeSqliteDriver(file, allowExtension), file)
  // WAL：读写并发更友好；synchronous=NORMAL 在 WAL 下已足够安全
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  logMigrationReport(applyMigrations(db), file)
  return db
}

/** 审核 fix-low：迁移报告不再被丢弃——被跳过的迁移必须有告警（否则结构差异被静默掩盖） */
function logMigrationReport(report: MigrationReport, file: string): void {
  if (report.skipped.length === 0) return
  getLogger().warn(
    { db: file, applied: report.applied, skipped: report.skipped },
    '部分数据库迁移被跳过：当前结构与最新版可能不一致（详见 skipped.reason）',
  )
}

/** 默认库文件位置（data/app.db） */
export function defaultDbFile(dataDir: string): string {
  return path.join(dataDir, 'app.db')
}
