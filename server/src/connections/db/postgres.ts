/**
 * PostgreSQL 连接器（M22）：基于官方 `pg` 驱动（依赖已声明于 server/package.json）。
 *
 * 关键行为：
 * - 连接池 max=2（单连接并发上限）；statement_timeout + query_timeout 双层超时；
 * - 只读连接：查询包 `BEGIN READ ONLY` … `ROLLBACK`（永不提交，写语句即使穿透护栏也会被 PG 拒绝）；
 * - schema 走 information_schema（排除 pg_catalog / information_schema）。
 */
import type { Pool as PgPool, PoolConfig } from 'pg'
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

interface PgModule {
  Pool: new (config: PoolConfig) => PgPool
}

async function loadPg(): Promise<PgModule | undefined> {
  try {
    const mod = (await import('pg')) as unknown as PgModule & { default?: PgModule }
    const Pool = mod.Pool ?? mod.default?.Pool
    return Pool ? { Pool } : undefined
  } catch {
    return undefined
  }
}

/** SSL 配置：true=校验证书；'no-verify'=显式关闭校验（自签名/内网场景的用户选择）；对象=透传 tls 选项 */
function resolveSsl(config: Record<string, unknown>): PoolConfig['ssl'] {
  const raw = config.ssl
  if (raw === true || raw === 'true' || raw === 'require') return { rejectUnauthorized: true }
  if (raw === 'no-verify' || raw === 'allow' || raw === 'prefer') return { rejectUnauthorized: false }
  if (raw && typeof raw === 'object') return raw as PoolConfig['ssl']
  return undefined
}

class PgHandle implements DbHandle {
  constructor(
    private readonly pool: PgPool,
    private readonly readOnly: boolean,
  ) {}

  async query(sql: string, params: unknown[], opts: DbQueryOptions): Promise<DbQueryResult> {
    const started = Date.now()
    const client = await this.pool.connect()
    const values = params.map(normalizeParam)
    let inTx = false
    try {
      if (opts.readOnly) {
        await client.query('BEGIN READ ONLY')
        inTx = true
      }
      const analysis = analyzeSql(sql)
      const isWrite =
        analysis.mutating ||
        !['SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'TABLE', 'VALUES'].includes(analysis.firstKeyword)
      // 行数下推：SELECT/WITH 包 LIMIT maxRows+1 由库端截断（防大结果集整包拉进内存）；+1 行仅作截断探测
      const text = isWrite ? sql : (wrapSelectWithLimit(sql, opts.maxRows) ?? sql)
      const res = await client.query({ text, values })
      if (inTx) await client.query('ROLLBACK')
      inTx = false
      const rows = (res.rows ?? []) as Array<Record<string, unknown>>
      const overLimit = rows.length > opts.maxRows
      const limited = overLimit ? rows.slice(0, opts.maxRows) : rows
      return {
        columns: (res.fields ?? []).map((f) => f.name),
        rows: limited.map((row) => {
          const out: Record<string, unknown> = {}
          for (const [key, value] of Object.entries(row)) out[key] = sanitizeRowValue(value)
          return out
        }),
        rowCount: limited.length,
        truncated: overLimit,
        durationMs: Date.now() - started,
        affectedRows: isWrite ? (res.rowCount ?? undefined) : undefined,
      }
    } catch (err) {
      if (inTx) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // 连接可能已断：忽略
        }
      }
      throw new Error(friendlyPgError(err))
    } finally {
      client.release()
    }
  }

  async schema(opts: { maxTables: number; timeoutMs: number }): Promise<DbSchemaSnapshot> {
    const client = await this.pool.connect()
    try {
      const tablesRes = await client.query<{ table_schema: string; table_name: string; table_type: string }>(
        `SELECT table_schema, table_name, table_type FROM information_schema.tables
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         ORDER BY table_schema, table_name LIMIT $1`,
        [opts.maxTables + 1],
      )
      const truncated = tablesRes.rows.length > opts.maxTables
      const selected = tablesRes.rows.slice(0, opts.maxTables)
      const colsRes = await client.query<{
        table_schema: string
        table_name: string
        column_name: string
        data_type: string
        is_nullable: string
      }>(
        `SELECT table_schema, table_name, column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         ORDER BY table_schema, table_name, ordinal_position`,
      )
      const byTable = new Map<string, Array<{ name: string; type?: string; nullable?: boolean }>>()
      for (const c of colsRes.rows) {
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
      client.release()
    }
  }

  async version(): Promise<string | undefined> {
    const client = await this.pool.connect()
    try {
      const res = await client.query<{ version: string }>('SELECT version() AS version')
      const raw = res.rows[0]?.version
      if (!raw) return undefined
      return raw.split(' on ')[0]?.slice(0, 120) ?? raw.slice(0, 120)
    } finally {
      client.release()
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

function friendlyPgError(err: unknown): string {
  const e = err as { message?: string; code?: string }
  if (e.code === 'ECONNREFUSED') return 'PostgreSQL 连接被拒绝：请确认主机 / 端口 / 服务状态'
  if (e.code === 'ENOTFOUND') return 'PostgreSQL 主机名无法解析'
  if (e.code === '28P01' || e.code === '28000') return 'PostgreSQL 认证失败：请检查用户名 / 密码'
  if (e.code === '3D000') return 'PostgreSQL 数据库不存在'
  if (e.code === '57014') return 'PostgreSQL 语句超时（statement_timeout）'
  if (e.code === '25006') return 'PostgreSQL 只读事务拒绝写操作'
  return `PostgreSQL 错误：${e.message ?? String(err)}`
}

export class PostgresConnector implements DbConnector {
  readonly kind = 'postgres' as const

  async probe(): Promise<DbProbeResult> {
    const pg = await loadPg()
    return pg ? { ok: true } : { ok: false, detail: '未安装 pg 驱动（在 server/ 下执行 npm i pg 后重启）' }
  }

  async connect(config: Record<string, unknown>, secret: Record<string, unknown>): Promise<DbHandle> {
    const pg = await loadPg()
    if (!pg) throw new Error('PostgreSQL 驱动未安装：请在 server/ 下执行 npm i pg 后重启服务')
    const host = cfgString(config, 'host') ?? '127.0.0.1'
    const port = cfgNumber(config, 'port', 5432)
    const database = cfgString(config, 'database')
    if (!database) throw new Error('PostgreSQL 连接缺少 config.database')
    const user = cfgString(config, 'username') ?? cfgString(config, 'user') ?? 'postgres'
    const password = typeof secret.password === 'string' ? secret.password : undefined
    const readOnly = cfgBool(config, 'readOnly', true)
    const timeoutMs = cfgNumber(config, 'timeoutMs', 15_000)
    const pool = new pg.Pool({
      host,
      port,
      database,
      user,
      password,
      ssl: resolveSsl(config),
      max: cfgNumber(config, 'maxConnections', 2),
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: Math.min(Math.max(timeoutMs, 1_000), 60_000),
      statement_timeout: Math.min(Math.max(timeoutMs, 1_000), 120_000),
      query_timeout: Math.min(Math.max(timeoutMs, 1_000), 120_000),
      application_name: 'multi-agent',
    })
    return new PgHandle(pool, readOnly)
  }
}
