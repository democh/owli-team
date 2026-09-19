/**
 * 数据库连接器抽象（M22）：PostgreSQL / MySQL / SQLite 三实现共同遵守的接口。
 *
 * 分层：
 * - Connector：无状态工厂（probe 驱动可用性 + connect 建立句柄）；
 * - Handle：会话句柄（内部含官方连接池；query/schema/version/close）；
 * - Manager（manager.ts）：按 connectionId 缓存句柄（配置指纹失效）+ 护栏 + 审计。
 */

export type DbKind = 'postgres' | 'mysql' | 'sqlite'

export interface DbQueryOptions {
  /** 返回行数上限（超出截断并标记） */
  maxRows: number
  /** 单次查询超时（毫秒；底层支持时生效） */
  timeoutMs: number
  /** 只读执行（只读事务包裹 / SQLite readOnly 打开） */
  readOnly: boolean
}

export interface DbQueryResult {
  columns: string[]
  rows: Array<Record<string, unknown>>
  /** 返回行数（截断前） */
  rowCount: number
  truncated: boolean
  durationMs: number
  /** 写语句影响行数（db_execute / 面板手动写） */
  affectedRows?: number
}

export interface DbColumnInfo {
  name: string
  type?: string
  nullable?: boolean
}

export interface DbTableInfo {
  schema?: string
  name: string
  kind?: string
  columns: DbColumnInfo[]
}

export interface DbSchemaSnapshot {
  tables: DbTableInfo[]
  truncated: boolean
}

export interface DbProbeResult {
  ok: boolean
  /** 驱动缺失等环境性问题的说明 */
  detail?: string
}

export interface DbHandle {
  query(sql: string, params: unknown[], opts: DbQueryOptions): Promise<DbQueryResult>
  schema(opts: { maxTables: number; timeoutMs: number }): Promise<DbSchemaSnapshot>
  version(): Promise<string | undefined>
  close(): Promise<void>
}

export interface DbConnector {
  readonly kind: DbKind
  /** 驱动可用性探测（缺失 → { ok:false, detail:'未安装 xx' }） */
  probe(): Promise<DbProbeResult>
  /** 建立句柄（内部含池）；配置非法 / 连接失败时抛中文错误 */
  connect(config: Record<string, unknown>, secret: Record<string, unknown>): Promise<DbHandle>
}

// ---------- config 读取辅助（连接 config 为宽松 JSON，逐字段安全读取） ----------

export function cfgString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key]
  if (typeof value === 'string' && value.trim()) return value.trim()
  return undefined
}

export function cfgNumber(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = config[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return fallback
}

export function cfgBool(config: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = config[key]
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 1) return true
  if (value === 'false' || value === 0) return false
  return fallback
}

/** 参数值归一化（跨驱动统一）：undefined → null；Date → ISO；对象 → JSON 字符串 */
export function normalizeParam(value: unknown): string | number | bigint | null | Uint8Array {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Uint8Array) return value
  if (value instanceof Date) return value.toISOString()
  return JSON.stringify(value)
}

/** 行值安全化（BigInt → string；Buffer → 短描述，避免 JSON 序列化炸裂） */
export function sanitizeRowValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) return `<binary ${value.byteLength}B>`
  if (value instanceof Date) return value.toISOString()
  return value
}

/** 标识符引用（按驱动方言；内部引号 / 反引号转义）——仅用于已白名单校验的表名 / 列名 */
export function quoteIdent(kind: DbKind, name: string): string {
  if (kind === 'mysql') return `\`${name.replaceAll('`', '``')}\``
  return `"${name.replaceAll('"', '""')}"`
}
