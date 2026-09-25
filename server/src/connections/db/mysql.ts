/**
 * MySQL 连接器（M22）：基于官方 `mysql2` 驱动（依赖已声明于 server/package.json）。
 *
 * 关键行为：
 * - 连接池 connectionLimit=2；客户端查询超时（timeout 会断开连接，池自动重建）；
 * - 只读连接：`START TRANSACTION READ ONLY` … `ROLLBACK`（永不提交）；
 * - multipleStatements: false（护栏之外的第二层：驱动级禁多语句）；
 * - dateStrings: true（日期以字符串返回，避免时区二次转换）。
 */
import type { FieldPacket, Pool as MySqlPool, PoolOptions, ResultSetHeader } from 'mysql2/promise'
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
import { wrapSelectWithLimit } from './guard.js'

interface MySqlModule {
  createPool: (config: PoolOptions) => MySqlPool
}

async function loadMysql(): Promise<MySqlModule | undefined> {
  try {
    // CJS 包双形态兼容：命名导出优先，其次 default（Node ESM interop 差异）
    const mod = (await import('mysql2/promise')) as unknown as Partial<MySqlModule> & {
      default?: Partial<MySqlModule>
    }
    const createPool = mod.createPool ?? mod.default?.createPool
    if (typeof createPool !== 'function') return undefined
    return { createPool }
  } catch {
    return undefined
  }
}

/** SSL：true=校验证书；'no-verify'=显式关闭校验（用户选择）；对象=透传 */
function resolveSsl(config: Record<string, unknown>): PoolOptions['ssl'] {
  const raw = config.ssl
  if (raw === true || raw === 'true' || raw === 'require') return { rejectUnauthorized: true }
  if (raw === 'no-verify' || raw === 'allow' || raw === 'prefer') return { rejectUnauthorized: false }
  if (raw && typeof raw === 'object') return raw as PoolOptions['ssl']
  return undefined
}

class MySqlHandle implements DbHandle {
  constructor(
    private readonly pool: MySqlPool,
    private readonly readOnly: boolean,
    private readonly database: string | undefined,
  ) {}

  async query(sql: string, params: unknown[], opts: DbQueryOptions): Promise<DbQueryResult> {
    const started = Date.now()
    const conn = await this.pool.getConnection()
    const values = params.map(normalizeParam)
    let inTx = false
    try {
      if (opts.readOnly) {
        await conn.query('START TRANSACTION READ ONLY')
        inTx = true
      }
      // 行数下推：SELECT/WITH 包 LIMIT maxRows+1 由库端截断（防大结果集整包拉进内存）；+1 行仅作截断探测
      const wrapped = wrapSelectWithLimit(sql, opts.maxRows)
      const [rows, fields] = await conn.query({ sql: wrapped ?? sql, values, timeout: opts.timeoutMs })
      if (inTx) await conn.query('ROLLBACK')
      inTx = false
      if (Array.isArray(rows)) {
        const data = rows as Array<Record<string, unknown>>
        const overLimit = data.length > opts.maxRows
        const limited = overLimit ? data.slice(0, opts.maxRows) : data
        return {
          columns: (fields as FieldPacket[] | undefined)?.map((f) => f.name) ?? Object.keys(data[0] ?? {}),
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
      // 写语句：ResultSetHeader
      const header = rows as ResultSetHeader
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        durationMs: Date.now() - started,
        affectedRows: Number(header.affectedRows ?? 0),
      }
    } catch (err) {
      if (inTx) {
        try {
          await conn.query('ROLLBACK')
        } catch {
          // 连接可能已断：忽略
        }
      }
      throw new Error(friendlyMySqlError(err))
    } finally {
      conn.release()
    }
  }

  async schema(opts: { maxTables: number; timeoutMs: number }): Promise<DbSchemaSnapshot> {
    const conn = await this.pool.getConnection()
    try {
      const scope = this.database
        ? { where: 'table_schema = ?', params: [this.database] as unknown[] }
        : {
            where: "table_schema NOT IN ('mysql', 'performance_schema', 'sys', 'information_schema')",
            params: [] as unknown[],
          }
      const [tablesRaw] = await conn.query({
        sql: `SELECT table_schema, table_name, table_type FROM information_schema.tables
              WHERE ${scope.where} ORDER BY table_schema, table_name LIMIT ?`,
        values: [...scope.params, opts.maxTables + 1],
        timeout: opts.timeoutMs,
      })
      const tables = tablesRaw as Array<{ table_schema: string; table_name: string; table_type: string }>
      const truncated = tables.length > opts.maxTables
      const selected = tables.slice(0, opts.maxTables)
      const [colsRaw] = await conn.query({
        sql: `SELECT table_schema, table_name, column_name, data_type, is_nullable FROM information_schema.columns
              WHERE ${scope.where} ORDER BY table_schema, table_name, ordinal_position`,
        values: scope.params,
        timeout: opts.timeoutMs,
      })
      const byTable = new Map<string, Array<{ name: string; type?: string; nullable?: boolean }>>()
      for (const c of colsRaw as Array<{
        table_schema: string
        table_name: string
        column_name: string
        data_type: string
        is_nullable: string
      }>) {
        const key = `${c.table_schema}.${c.table_name}`
        const list = byTable.get(key) ?? []
        list.push({ name: c.column_name, type: c.data_type, nullable: c.is_nullable === 'YES' })
        byTable.set(key, list)
      }
      return {
        tables: selected.map((t) => ({
          schema: t.table_schema,
          name: t.table_name,
          kind: t.table_type === 'VIEW' ? 'view' : 'table',
          columns: byTable.get(`${t.table_schema}.${t.table_name}`) ?? [],
        })),
        truncated,
      }
    } finally {
      conn.release()
    }
  }

  async version(): Promise<string | undefined> {
    const conn = await this.pool.getConnection()
    try {
      const [rows] = await conn.query('SELECT VERSION() AS v')
      const v = (rows as Array<{ v?: string }>)[0]?.v
      return v ? `MySQL ${v}` : undefined
    } finally {
      conn.release()
    }
  }

  async close(): Promise<void> {
    try {
      await this.pool.end()
    } catch {
      // 已关闭：忽略
    }
  }
}

function friendlyMySqlError(err: unknown): string {
  const e = err as { message?: string; code?: string; errno?: number }
  if (e.code === 'ECONNREFUSED') return 'MySQL 连接被拒绝：请确认主机 / 端口 / 服务状态'
  if (e.code === 'ENOTFOUND') return 'MySQL 主机名无法解析'
  if (e.code === 'ER_ACCESS_DENIED_ERROR') return 'MySQL 认证失败：请检查用户名 / 密码'
  if (e.code === 'ER_BAD_DB_ERROR') return 'MySQL 数据库不存在'
  if (e.code === 'PROTOCOL_CONNECTION_LOST') return 'MySQL 连接已断开'
  if (e.code === 'ER_QUERY_TIMEOUT' || /timeout/i.test(e.message ?? '')) return 'MySQL 查询超时'
  if (e.code === 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION') return 'MySQL 只读事务拒绝写操作'
  return `MySQL 错误：${e.message ?? String(err)}`
}

export class MySqlConnector implements DbConnector {
  readonly kind = 'mysql' as const

  async probe(): Promise<DbProbeResult> {
    const mysql = await loadMysql()
    return mysql
      ? { ok: true }
      : { ok: false, detail: '未安装 mysql2 驱动（在 server/ 下执行 npm i mysql2 后重启）' }
  }

  async connect(config: Record<string, unknown>, secret: Record<string, unknown>): Promise<DbHandle> {
    const mysql = await loadMysql()
    if (!mysql) throw new Error('MySQL 驱动未安装：请在 server/ 下执行 npm i mysql2 后重启服务')
    const host = cfgString(config, 'host') ?? '127.0.0.1'
    const port = cfgNumber(config, 'port', 3306)
    const database = cfgString(config, 'database')
    const user = cfgString(config, 'username') ?? cfgString(config, 'user') ?? 'root'
    const password = typeof secret.password === 'string' ? secret.password : undefined
    const readOnly = cfgBool(config, 'readOnly', true)
    const timeoutMs = cfgNumber(config, 'timeoutMs', 15_000)
    const pool = mysql.createPool({
      host,
      port,
      user,
      password,
      database,
      ssl: resolveSsl(config),
      connectionLimit: cfgNumber(config, 'maxConnections', 2),
      connectTimeout: Math.min(Math.max(timeoutMs, 1_000), 60_000),
      // 驱动级禁多语句：护栏之外的第二层保险
      multipleStatements: false,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      namedPlaceholders: false,
      enableKeepAlive: true,
    })
    return new MySqlHandle(pool, readOnly, database)
  }
}
