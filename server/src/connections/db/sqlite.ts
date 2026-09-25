/**
 * SQLite 连接器（M22）：基于 Node 内置 `node:sqlite`（与主库驱动一致，零新增依赖）。
 *
 * 特点与边界：
 * - worker 线程执行（修复：node:sqlite 为同步 API，慢查询会冻结主事件循环——所有会话的
 *   ws / 审批 / 其他工具全部卡住）；每个连接句柄 = 一个独立 worker（单连接串行，语义不变）；
 * - 语句级超时生效：超时即 terminate worker（SQLite 无中断 API，终止是唯一可靠手段），
 *   句柄标记损坏（isBroken），管理器下次调用自动重建；
 * - readOnly（默认）：worker 内以只读方式打开文件 + 护栏双保险；
 *   注意 allowWrites=true 时需以可写方式打开（与 manager 权限链 readOnly && !allowWrites 一致），
 *   否则护栏/审批门放行的写操作会撞上驱动层 readonly 报错；
 * - 不自动建库：路径不存在时明确报错（防误建空库掩盖配置错误）。
 *
 * 实现说明：worker 代码以 eval 字符串内联（非独立文件）——dev（tsx）/ vitest / 生产 dist
 * 三种加载形态下路径解析都不需要特殊处理，且 worker 内代码无需打包器介入。
 */
import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { getLogger } from '../../logger.js'
import { analyzeSql, wrapSelectWithLimit } from './guard.js'
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

/** worker 端源码（纯 JS / CommonJS；eval 模式加载，勿用 TS 语法与 ESM import） */
const WORKER_SOURCE = String.raw`
const { parentPort } = require('node:worker_threads')
const { DatabaseSync } = require('node:sqlite')

let db = null

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"'
}

function handle(msg) {
  const { id, op } = msg
  try {
    if (op === 'open') {
      let fallback = false
      try {
        db = new DatabaseSync(msg.path, { readOnly: msg.readOnly })
      } catch (err) {
        // 只读打开失败时回退读写打开（如 WAL 缺 -shm 权限）；护栏与执行层仍限制写，主线程负责告警
        db = new DatabaseSync(msg.path)
        fallback = msg.readOnly === true
        if (!fallback) throw err
      }
      try {
        db.exec('PRAGMA busy_timeout = ' + Math.max(0, Math.round(msg.busyMs || 0)))
      } catch {}
      parentPort.postMessage({ id, ok: true, result: { readOnlyFallback: fallback } })
      return
    }
    if (!db) throw new Error('worker 尚未打开数据库')
    if (op === 'query') {
      const stmt = db.prepare(msg.sql)
      if (msg.write) {
        const r = stmt.run(...msg.params)
        parentPort.postMessage({ id, ok: true, result: { affectedRows: Number(r.changes || 0) } })
      } else {
        const columns = stmt.columns().map((c) => c.name)
        const rows = stmt.all(...msg.params)
        parentPort.postMessage({ id, ok: true, result: { columns, rows } })
      }
      return
    }
    if (op === 'schema') {
      const tables = db
        .prepare(
          "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT ?",
        )
        .all(msg.maxTables + 1)
      const truncated = tables.length > msg.maxTables
      const out = tables.slice(0, msg.maxTables).map((t) => {
        let columns = []
        try {
          columns = db
            .prepare('PRAGMA table_info(' + quoteIdent(t.name) + ')')
            .all()
            .map((c) => ({ name: c.name, type: c.type || undefined, nullable: c.notnull !== 1 }))
        } catch {
          // 视图或损坏表：列信息缺省
        }
        return { name: t.name, kind: t.type, columns }
      })
      parentPort.postMessage({ id, ok: true, result: { tables: out, truncated } })
      return
    }
    if (op === 'version') {
      let v
      try {
        const row = db.prepare('SELECT sqlite_version() AS v').all()[0]
        v = row && row.v ? 'SQLite ' + row.v : undefined
      } catch {}
      parentPort.postMessage({ id, ok: true, result: { version: v } })
      return
    }
    if (op === 'close') {
      try {
        if (db) db.close()
      } catch {}
      db = null
      parentPort.postMessage({ id, ok: true, result: {} })
      return
    }
    throw new Error('未知操作：' + op)
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: (err && err.message) || String(err) })
  }
}

parentPort.on('message', handle)
`

// ---------- RPC 消息类型 ----------

interface WorkerRequest {
  id: number
  op: 'open' | 'query' | 'schema' | 'version' | 'close'
  [key: string]: unknown
}

interface WorkerResponse {
  id: number
  ok: boolean
  result?: Record<string, unknown>
  error?: string
}

interface PendingCall {
  resolve: (result: Record<string, unknown>) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

class SqliteHandle implements DbHandle {
  private worker: Worker
  private seq = 0
  private readonly pending = new Map<number, PendingCall>()
  private broken = false
  private closed = false

  private constructor() {
    this.worker = new Worker(WORKER_SOURCE, { eval: true })
    this.worker.unref() // 不阻止进程退出（测试 / 关闭收尾阶段句柄未显式 close 时不挂起）
    this.worker.on('message', (msg: WorkerResponse) => {
      const call = this.pending.get(msg.id)
      if (!call) return
      this.pending.delete(msg.id)
      clearTimeout(call.timer)
      if (msg.ok) call.resolve(msg.result ?? {})
      else call.reject(new Error(msg.error ?? 'SQLite worker 执行失败'))
    })
    const onDead = (err?: Error): void => {
      if (this.closed) return
      this.broken = true
      const failure = err ?? new Error('SQLite worker 异常退出')
      for (const call of this.pending.values()) {
        clearTimeout(call.timer)
        call.reject(failure)
      }
      this.pending.clear()
    }
    this.worker.on('error', onDead)
    this.worker.on('exit', (code) => {
      if (code !== 0) onDead()
    })
  }

  /** 建立连接（worker 启动 + 打开文件；只读回退时主线程告警留痕） */
  static async open(file: string, readOnly: boolean, busyMs: number): Promise<SqliteHandle> {
    const handle = new SqliteHandle()
    try {
      const res = await handle.rpc('open', { path: file, readOnly, busyMs }, 15_000)
      if (res.readOnlyFallback === true) {
        getLogger().warn(
          { file },
          'SQLite 只读打开失败，已回退为读写打开（护栏与执行层仍限制写操作）',
        )
      }
      return handle
    } catch (err) {
      await handle.close()
      throw err
    }
  }

  /** 句柄损坏（超时终止 / worker 崩溃）——管理器据此自动重建 */
  isBroken(): boolean {
    return this.broken
  }

  /** RPC 调用（带超时；超时 = 终止 worker + 标记损坏，下次调用由管理器重建句柄） */
  private rpc(op: WorkerRequest['op'], payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('SQLite 连接已关闭'))
    if (this.broken) {
      return Promise.reject(new Error('SQLite 连接已损坏（前次超时或 worker 崩溃），请重试（将自动重建）'))
    }
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.broken = true
        void this.worker.terminate()
        reject(new Error(`SQLite 查询超时（${timeoutMs}ms），已终止连接（下次调用自动重建）`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      const msg: WorkerRequest = { id, op, ...payload }
      this.worker.postMessage(msg)
    })
  }

  async query(sql: string, params: unknown[], opts: DbQueryOptions): Promise<DbQueryResult> {
    const started = Date.now()
    const normalized = params.map(normalizeParam)
    const analysis = analyzeSql(sql)
    const isWrite =
      analysis.mutating ||
      !['SELECT', 'WITH', 'EXPLAIN', 'PRAGMA', 'TABLE', 'VALUES'].includes(analysis.firstKeyword)

    if (isWrite) {
      if (opts.readOnly) throw new Error('只读连接不允许执行写语句（护栏已在执行层拦截，此为兜底）')
      const res = await this.rpc('query', { sql, params: normalized, write: true }, opts.timeoutMs)
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        durationMs: Date.now() - started,
        affectedRows: Number(res.affectedRows ?? 0),
      }
    }

    // 行数下推：SELECT/WITH 包 LIMIT maxRows+1 由库端截断（防整表读入内存）；多出的 1 行仅作截断探测
    const finalSql = wrapSelectWithLimit(sql, opts.maxRows) ?? sql
    const res = await this.rpc('query', { sql: finalSql, params: normalized, write: false }, opts.timeoutMs)
    const all = (res.rows ?? []) as Array<Record<string, unknown>>
    const overLimit = all.length > opts.maxRows
    const limited = overLimit ? all.slice(0, opts.maxRows) : all
    return {
      columns: (res.columns ?? []) as string[],
      rows: limited.map((row) => {
        const out: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(row)) out[key] = sanitizeRowValue(value)
        return out
      }),
      rowCount: limited.length,
      truncated: overLimit,
      durationMs: Date.now() - started,
    }
  }

  async schema(opts: { maxTables: number; timeoutMs: number }): Promise<DbSchemaSnapshot> {
    const res = await this.rpc('schema', { maxTables: opts.maxTables }, opts.timeoutMs)
    return {
      tables: (res.tables ?? []) as DbSchemaSnapshot['tables'],
      truncated: res.truncated === true,
    }
  }

  async version(): Promise<string | undefined> {
    try {
      const res = await this.rpc('version', {}, 10_000)
      return typeof res.version === 'string' ? res.version : undefined
    } catch {
      return undefined
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      if (!this.broken) await this.rpc('close', {}, 5_000)
    } catch {
      // 已损坏 / 已关闭：忽略
    }
    for (const call of this.pending.values()) {
      clearTimeout(call.timer)
      call.reject(new Error('SQLite 连接已关闭'))
    }
    this.pending.clear()
    await this.worker.terminate().catch(() => undefined)
  }
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
    const busyMs = cfgNumber(config, 'busyTimeoutMs', 5_000)
    try {
      return await SqliteHandle.open(file, readOnly, busyMs)
    } catch (err) {
      throw new Error(`SQLite 打开失败：${(err as Error).message}`)
    }
  }
}
