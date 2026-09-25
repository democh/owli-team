/**
 * SQL 护栏（M22 数据库连接）：注释/字符串剥离 → 多语句拒绝 → 只读白名单 → 危险关键字兜底。
 *
 * 设计立场（安全侧）：
 * - 「误伤」可接受（拒绝执行 + 明确原因回灌模型，模型可改写语句）；「漏放」不可接受；
 * - 只读判定 = 首关键字白名单 + 骨架（字符串字面量与注释已剥离）不含任何危险关键字；
 *   例：`WITH x AS (DELETE ...) SELECT`（data-modifying CTE）会被 DELETE 关键字拦截；
 * - 加固（诊断修复批）：危险关键字匹配大小写不敏感；PRAGMA 赋值与括号赋值形式（只读名单外）视为写；
 *   MySQL / MariaDB 可执行注释（`/*!` / `/*M!`）内容会被服务器真实执行，按代码参与分析而不剥离；
 * - 写类语句（db_execute）仍拒绝多语句（简化审计与回灌，不做批处理解析）。
 */

export interface SqlAnalysis {
  ok: boolean
  /** ok=false 时的拒绝原因（中文，直接回灌模型） */
  reason?: string
  /** 切分后的语句（尾部空段已忽略） */
  statements: string[]
  firstKeyword: string
  /** 骨架是否含数据修改/DDL 意图（危险关键字命中） */
  mutating: boolean
}

/** 只读首关键字白名单（覆盖 PG / MySQL / SQLite 的常见只读入口） */
const READONLY_FIRST = new Set([
  'SELECT',
  'WITH',
  'EXPLAIN',
  'SHOW',
  'DESCRIBE',
  'DESC',
  'PRAGMA',
  'TABLE',
  'VALUES',
])

/**
 * 危险关键字（骨架全词匹配）。
 * 含 INTO（PG `SELECT ... INTO` 建表 / MySQL `INTO OUTFILE`）与 ANALYZE（PG 会写统计）。
 */
const DANGEROUS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'UPSERT',
  'REPLACE',
  'TRUNCATE',
  'DROP',
  'ALTER',
  'CREATE',
  'RENAME',
  'GRANT',
  'REVOKE',
  'COMMENT',
  'CALL',
  'DO',
  'COPY',
  'LOAD',
  'VACUUM',
  'REINDEX',
  'ATTACH',
  'DETACH',
  'LOCK',
  'UNLOCK',
  'SET',
  'USE',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'EXECUTE',
  'PREPARE',
  'DEALLOCATE',
  'DISCARD',
  'CLUSTER',
  'NOTIFY',
  'LISTEN',
  'UNLISTEN',
  'REFRESH',
  'CHECKPOINT',
  'KILL',
  'FLUSH',
  'OPTIMIZE',
  'REPAIR',
  'ANALYZE',
  'HANDLER',
  'IMPORT',
  'EXPORT',
  'INTO',
  'OUTFILE',
  'DUMPFILE',
  'LOAD_FILE',
]

const DANGEROUS_RE = new RegExp(`\\b(${DANGEROUS.join('|')})\\b`, 'i')

/** 只读 PRAGMA 的「括号参数」名单（其余括号形式 = 赋值，如 `PRAGMA journal_mode(wal)`） */
const READONLY_PRAGMA_PAIRS = new Set([
  'table_info',
  'table_xinfo',
  'index_info',
  'index_list',
  'index_xinfo',
  'foreign_key_list',
  'database_list',
  'collation_list',
  'function_list',
  'module_list',
  'pragma_list',
  'compile_options',
  'table_list',
  'integrity_check',
  'quick_check',
])

/**
 * PRAGMA 是否含写意图：`=` 赋值（大小写不敏感）或括号赋值形式（只读名单外一律拒绝；
 * 名称无法静态识别——如引号包裹——同样按写处理）。纯查询形式（`PRAGMA journal_mode`）放行。
 */
function pragmaMutating(skeleton: string): boolean {
  const trimmed = skeleton.trim()
  if (!/^PRAGMA\b/i.test(trimmed)) return false
  if (trimmed.includes('=')) return true
  if (!trimmed.includes('(')) return false
  const pair = /^PRAGMA\s+(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)\s*\(/.exec(trimmed)
  return !(pair && READONLY_PRAGMA_PAIRS.has(pair[1]!.toLowerCase()))
}

interface ScanResult {
  /** 注释与字符串字面量已剥离（字符串替换为 ''），用于关键字匹配 */
  skeleton: string
  /** 原文切分后的语句（字符串内的分号不受影响） */
  statements: string[]
}

/** 逐字符状态机扫描：剥离注释 / 字符串，按顶层分号切分语句 */
function scan(sql: string): ScanResult {
  let skeleton = ''
  const statements: string[] = []
  let current = ''
  let i = 0
  const n = sql.length
  const push = (): void => {
    const trimmed = current.trim()
    if (trimmed) statements.push(trimmed)
    current = ''
  }

  while (i < n) {
    const ch = sql[i]!
    // 行注释 --
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++
      continue
    }
    // MySQL / MariaDB 可执行注释（/*! …… */ 与 /*M! …… */）：内容会被服务器真实执行，
    // 不能当普通注释剥离——跳过起始标记后按代码继续扫描（内容含分号即触发多语句拒绝）
    if (
      ch === '/' &&
      sql[i + 1] === '*' &&
      (sql[i + 2] === '!' || (sql[i + 2] === 'M' && sql[i + 3] === '!'))
    ) {
      i += sql[i + 2] === '!' ? 3 : 4
      continue
    }
    // 块注释 /* */
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      continue
    }
    // 单引号字符串（'' 转义）
    if (ch === "'") {
      current += ch
      i++
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          current += "''"
          i += 2
          continue
        }
        if (sql[i] === "'") {
          current += "'"
          i++
          break
        }
        current += sql[i]
        i++
      }
      skeleton += "''"
      continue
    }
    // 双引号标识符（PG/SQLite；MySQL 默认也是字符串，处理一致）
    if (ch === '"') {
      current += ch
      i++
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          current += '""'
          i += 2
          continue
        }
        if (sql[i] === '"') {
          current += '"'
          i++
          break
        }
        current += sql[i]
        i++
      }
      skeleton += '""'
      continue
    }
    // 反引号标识符（MySQL）
    if (ch === '`') {
      current += ch
      i++
      while (i < n && sql[i] !== '`') {
        current += sql[i]
        i++
      }
      current += '`'
      i++
      skeleton += '``'
      continue
    }
    // 美元引号（PG $$...$$ / $tag$...$tag$）
    if (ch === '$') {
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (match) {
        const tag = match[0]
        const end = sql.indexOf(tag, i + tag.length)
        if (end >= 0) {
          current += sql.slice(i, end + tag.length)
          i = end + tag.length
          skeleton += "''"
          continue
        }
      }
    }
    // 顶层分号：切分语句
    if (ch === ';') {
      push()
      skeleton += ';'
      i++
      continue
    }
    current += ch
    skeleton += ch
    i++
  }
  push()
  return { skeleton, statements }
}

/** 静态分析一条 SQL（不做数据库连接） */
export function analyzeSql(sql: string): SqlAnalysis {
  const raw = sql.trim()
  if (!raw) return { ok: false, reason: 'SQL 为空', statements: [], firstKeyword: '', mutating: false }
  const { skeleton, statements } = scan(raw)
  if (statements.length === 0) {
    return { ok: false, reason: 'SQL 为空（仅注释）', statements: [], firstKeyword: '', mutating: false }
  }
  if (statements.length > 1) {
    return {
      ok: false,
      reason: `仅支持单条语句（检测到 ${statements.length} 条）：请拆分后逐条执行`,
      statements,
      firstKeyword: '',
      mutating: true,
    }
  }
  const firstKeyword = (/^[\s(]*([A-Za-z_]+)/.exec(skeleton)?.[1] ?? '').toUpperCase()
  const mutating = DANGEROUS_RE.test(skeleton) || pragmaMutating(skeleton)
  return { ok: true, statements, firstKeyword, mutating }
}

/** 只读断言：只允许白名单首关键字且骨架无危险意图 */
export function assertReadOnlySql(sql: string): { ok: true } | { ok: false; reason: string } {
  const analysis = analyzeSql(sql)
  if (!analysis.ok) return { ok: false, reason: analysis.reason ?? 'SQL 不合法' }
  if (!READONLY_FIRST.has(analysis.firstKeyword)) {
    return {
      ok: false,
      reason: `只读模式仅允许 ${[...READONLY_FIRST].join(' / ')} 开头的语句（当前：${analysis.firstKeyword || '未知'}）。如需写操作，请在连接上开启「允许写入」并使用 db_execute。`,
    }
  }
  if (analysis.mutating) {
    return {
      ok: false,
      reason:
        '语句包含可能修改数据的片段（如 data-modifying CTE / SELECT INTO / 会话设置），已被只读护栏拒绝',
    }
  }
  return { ok: true }
}

/** 面板 SQL 路由判定（M23）：白名单首关键字 + 骨架无危险意图 → 只读（query），否则写（execute） */
export function isReadOnlyStatement(analysis: SqlAnalysis): boolean {
  return analysis.ok && READONLY_FIRST.has(analysis.firstKeyword) && !analysis.mutating
}

/** 写断言（db_execute）：只拒绝多语句，危险动作交由审批门与连接开关控制 */
export function assertWritableSql(sql: string): { ok: true } | { ok: false; reason: string } {
  const analysis = analyzeSql(sql)
  if (!analysis.ok) return { ok: false, reason: analysis.reason ?? 'SQL 不合法' }
  return { ok: true }
}

/**
 * 只读查询的行数下推（修复「全量读入内存再截断」）：
 * 对 SELECT / WITH 单语句包一层 `SELECT * FROM (...) LIMIT maxRows+1`，
 * 让数据库端只返回 maxRows+1 行（+1 用于探测是否截断，避免 COUNT）。
 * 其余首关键字（EXPLAIN / SHOW / PRAGMA / TABLE / VALUES）结果集天然很小，不包裹（返回 null）。
 * 说明：WITH 包裹为派生表形式（PG / SQLite / MySQL 8 / MariaDB 均支持 CTE 出现在子查询开头）。
 */
export function wrapSelectWithLimit(sql: string, maxRows: number): string | null {
  const analysis = analyzeSql(sql)
  if (!analysis.ok || analysis.statements.length !== 1) return null
  if (analysis.firstKeyword !== 'SELECT' && analysis.firstKeyword !== 'WITH') return null
  const stmt = analysis.statements[0]!
  const limit = Math.max(1, Math.trunc(maxRows)) + 1
  return `SELECT * FROM (${stmt}) AS __ma_row_limit LIMIT ${limit}`
}
