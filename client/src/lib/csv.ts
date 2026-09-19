/**
 * CSV / TSV 解析（M24 交付件表格预览）：
 * - RFC 4180 风格：引号包裹字段、`""` 转义、引号内换行 / 分隔符；
 * - 分隔符自动检测（, ; \t |）：取首个非空行中引号外的出现最多次者；
 * - 行列上限护栏（默认 500 行 × 80 列），超出返回 truncated；单元格超长截断。
 */

export interface ParsedTable {
  /** 检测出的分隔符（用于工具栏展示） */
  delimiter: string
  rows: string[][]
  truncated: boolean
}

const DEFAULT_MAX_ROWS = 500
const DEFAULT_MAX_COLS = 80
const MAX_CELL_CHARS = 500

const CANDIDATES = [',', ';', '\t', '|'] as const

export function detectDelimiter(text: string): string {
  const firstLine = firstContentLine(text)
  let best = ','
  let bestCount = 0
  for (const d of CANDIDATES) {
    const count = countOutsideQuotes(firstLine, d)
    if (count > bestCount) {
      best = d
      bestCount = count
    }
  }
  return best
}

/** 首个非空行（BOM 已剥离；引号内的换行不打断行扫描——简化：按物理行取首行） */
function firstContentLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/\r$/, '')
    if (trimmed.trim()) return trimmed
  }
  return ''
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') i++
      else inQuotes = !inQuotes
    } else if (!inQuotes && ch === delimiter) {
      count++
    }
  }
  return count
}

export function parseDelimited(
  text: string,
  opts?: { maxRows?: number; maxCols?: number; delimiter?: string },
): ParsedTable {
  const maxRows = opts?.maxRows ?? DEFAULT_MAX_ROWS
  const maxCols = opts?.maxCols ?? DEFAULT_MAX_COLS
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const delimiter = opts?.delimiter ?? detectDelimiter(source)

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let truncated = false
  /** 因 maxRows 提前中断（区别于仅列截断：末行仍应入表） */
  let stopped = false

  const pushField = (): void => {
    if (row.length < maxCols) {
      row.push(field.length > MAX_CELL_CHARS ? `${field.slice(0, MAX_CELL_CHARS)}…` : field)
    } else {
      truncated = true
    }
    field = ''
  }
  const pushRow = (): void => {
    // 跳过完全空行（单个空字段）
    if (!(row.length <= 1 && (row[0] ?? '') === '')) rows.push(row)
    row = []
  }

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
      continue
    }
    if (ch === delimiter) {
      pushField()
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++
      pushField()
      if (rows.length >= maxRows) {
        truncated = true
        stopped = true
        break
      }
      pushRow()
      continue
    }
    field += ch
  }
  if (!stopped && (field !== '' || row.length > 0)) {
    pushField()
    if (rows.length >= maxRows) truncated = true
    else pushRow()
  }

  // 列宽归一（尾行短列用空串补齐，便于表格渲染）
  const width = rows.reduce((n, r) => Math.max(n, r.length), 0)
  for (const r of rows) {
    while (r.length < width) r.push('')
  }
  return { delimiter, rows, truncated }
}

/** 分隔符展示名（UI 提示用） */
export function delimiterLabel(delimiter: string): string {
  if (delimiter === '\t') return 'Tab'
  if (delimiter === ',') return '逗号'
  if (delimiter === ';') return '分号'
  if (delimiter === '|') return '竖线'
  return delimiter
}
