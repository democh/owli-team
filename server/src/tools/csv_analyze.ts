/**
 * csv_analyze 工具（M21.2）：CSV/TSV 读取与分析 —— head / describe / groupby / sort / filter。
 * 零依赖：自写 RFC4180 子集解析（引号转义 / CRLF / BOM）；.csv/.tsv 嗅探。
 * 沙箱：resolveInRoot + 敏感文件拒绝 + 5MB 体积上限；detail 返回 Markdown 表格（≤50 行）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { resolveInRoot } from '../util/paths.js'
import { sensitiveRejection } from './sensitive.js'
import type { ToolRuntime, ToolResult } from './registry.js'

const MAX_CSV_BYTES = 5 * 1024 * 1024
const MAX_TABLE_ROWS = 50

function relOfWorkspace(workspace: string, full: string): string {
  const base = fs.existsSync(workspace) ? fs.realpathSync(workspace) : path.resolve(workspace)
  return path.relative(base, full).split(path.sep).join('/')
}

/** RFC4180 子集解析（可单测）：双引号包裹 / "" 转义 / CRLF 与 LF / 末尾空行剔除 / BOM 剥离 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  let src = text
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      field = ''
      rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''))
}

function isNumeric(v: string): boolean {
  const t = v.trim()
  return t !== '' && /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)
}

function toNum(v: string): number {
  return Number(v.trim())
}

function escapeCell(v: string): string {
  return v.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function mdTable(header: string[], rows: string[][]): string {
  const line = (cells: string[]): string => `| ${cells.map(escapeCell).join(' | ')} |`
  return [line(header), `| ${header.map(() => '---').join(' | ')} |`, ...rows.map(line)].join('\n')
}

function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n)
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

interface Table {
  header: string[]
  rows: string[][]
  columnIndex: Map<string, number>
}

function loadTable(
  rawPath: string,
  workspace: string,
  allowSensitive: boolean,
): { ok: true; table: Table; delimiter: string } | { ok: false; summary: string } {
  const full = resolveInRoot(workspace, rawPath)
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return { ok: false, summary: `文件不存在：${rawPath}` }
  }
  const guard = sensitiveRejection(relOfWorkspace(workspace, full), allowSensitive, '读取')
  if (guard) return { ok: false, summary: guard }
  const size = fs.statSync(full).size
  if (size > MAX_CSV_BYTES) {
    return { ok: false, summary: `文件过大（${(size / 1024 / 1024).toFixed(1)}MB，上限 5MB），请先拆分或抽样` }
  }
  const text = fs.readFileSync(full, 'utf8')
  // 分隔符嗅探：.tsv → Tab；否则按首行 Tab / 逗号计数取多者
  const firstLine = text.split(/\r?\n/)[0] ?? ''
  const delimiter =
    rawPath.toLowerCase().endsWith('.tsv') ? '\t' : (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? '\t' : ','
  const parsed = parseDelimited(text, delimiter)
  if (parsed.length === 0) return { ok: false, summary: `文件为空：${rawPath}` }
  const header = parsed[0].map((h, i) => (h.trim() === '' ? `列${i + 1}` : h.trim()))
  const rows = parsed.slice(1).filter((r) => r.some((c) => c.trim() !== ''))
  if (rows.length === 0) return { ok: false, summary: `没有数据行（只有表头）：${rawPath}` }
  return { ok: true, table: { header, rows, columnIndex: new Map(header.map((h, i) => [h, i])) }, delimiter }
}

function pickColumns(table: Table, columns: string[]): { ok: true; header: string[]; rows: string[][] } | { ok: false; summary: string } {
  if (columns.length === 0) return { ok: true, header: table.header, rows: table.rows }
  const missing = columns.filter((c) => !table.columnIndex.has(c))
  if (missing.length > 0) {
    return { ok: false, summary: `列不存在：${missing.join('、')}；可用列：${table.header.join('、')}` }
  }
  const idx = columns.map((c) => table.columnIndex.get(c) ?? 0)
  return { ok: true, header: columns, rows: table.rows.map((r) => idx.map((i) => r[i] ?? '')) }
}

interface WhereClause {
  column: string
  op: '=' | '!=' | '>' | '>=' | '<' | '<=' | '~'
  value: string
}

function parseWhere(where: string): WhereClause | undefined {
  const m = /^\s*(.+?)\s*(>=|<=|!=|=|>|<|~)\s*(.+?)\s*$/.exec(where)
  if (!m) return undefined
  return { column: m[1], op: m[2] as WhereClause['op'], value: m[3] }
}

function matchWhere(cell: string, cond: WhereClause): boolean {
  const bothNum = isNumeric(cell) && isNumeric(cond.value)
  switch (cond.op) {
    case '=':
      return bothNum ? toNum(cell) === toNum(cond.value) : cell.trim() === cond.value
    case '!=':
      return bothNum ? toNum(cell) !== toNum(cond.value) : cell.trim() !== cond.value
    case '~':
      return cell.toLowerCase().includes(cond.value.toLowerCase())
    case '>':
      return bothNum ? toNum(cell) > toNum(cond.value) : cell.trim() > cond.value
    case '>=':
      return bothNum ? toNum(cell) >= toNum(cond.value) : cell.trim() >= cond.value
    case '<':
      return bothNum ? toNum(cell) < toNum(cond.value) : cell.trim() < cond.value
    default:
      return bothNum ? toNum(cell) <= toNum(cond.value) : cell.trim() <= cond.value
  }
}

export const csvAnalyzeTool = {
  name: 'csv_analyze',
  readOnly: true,
  description:
    '读取工作区 CSV/TSV 并分析：head（预览）/ describe（列类型与统计）/ groupby（分组聚合，agg 形如 "sum:金额"）/ sort（排序）/ filter（筛选，where 形如 "金额 > 1000"）。表格数据必须用它汇总，禁止目测。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区内 CSV/TSV 相对路径' },
      op: { type: 'string', enum: ['head', 'describe', 'groupby', 'sort', 'filter'], description: '操作类型' },
      column: { type: 'string', description: 'sort/filter 的目标列名' },
      by: { type: 'string', description: 'groupby 的分组列名' },
      agg: { type: 'string', description: 'groupby 聚合，形如 "sum:金额"（count/sum/avg/min/max；缺省 count）' },
      where: { type: 'string', description: 'filter 条件，形如 "金额 > 1000"、"渠道 ~ 抖音"（= != > >= < <= ~包含）' },
      order: { type: 'string', enum: ['asc', 'desc'], description: 'sort 排序方向（默认 desc）' },
      limit: { type: 'number', description: '返回行数上限（1-50，默认 20）' },
      columns: { type: 'array', items: { type: 'string' }, description: '只显示这些列（缺省全部）' },
    },
    required: ['path', 'op'],
  },
  schema: z.object({
    path: z.string().min(1),
    op: z.enum(['head', 'describe', 'groupby', 'sort', 'filter']),
    column: z.string().optional(),
    by: z.string().optional(),
    agg: z.string().optional(),
    where: z.string().optional(),
    order: z.enum(['asc', 'desc']).default('desc'),
    limit: z.number().int().min(1).max(MAX_TABLE_ROWS).default(20),
    columns: z.array(z.string()).default([]),
  }),
  async execute(
    args: {
      path: string
      op: 'head' | 'describe' | 'groupby' | 'sort' | 'filter'
      column?: string
      by?: string
      agg?: string
      where?: string
      order: 'asc' | 'desc'
      limit: number
      columns: string[]
    },
    ctx: ToolRuntime,
  ): Promise<ToolResult> {
    try {
      const loaded = loadTable(args.path, ctx.workspace, ctx.allowSensitive)
      if (!loaded.ok) return { ok: false, summary: loaded.summary }
      const { table } = loaded
      const shape = `${table.header.length} 列 × ${table.rows.length} 行`

      switch (args.op) {
        case 'head': {
          const picked = pickColumns(table, args.columns)
          if (!picked.ok) return { ok: false, summary: picked.summary }
          const shown = picked.rows.slice(0, args.limit)
          return {
            ok: true,
            summary: `预览 ${shown.length} 行（${shape}）`,
            detail: mdTable(picked.header, shown),
          }
        }
        case 'describe': {
          const lines: string[] = []
          for (let i = 0; i < table.header.length; i++) {
            const col = table.header[i]
            const values = table.rows.map((r) => r[i] ?? '')
            const nonEmpty = values.filter((v) => v.trim() !== '')
            const numeric = nonEmpty.filter(isNumeric)
            const unique = new Set(nonEmpty).size
            const isNum = nonEmpty.length > 0 && numeric.length / nonEmpty.length >= 0.8
            if (isNum) {
              const nums = numeric.map(toNum)
              const sum = nums.reduce((a, b) => a + b, 0)
              lines.push(
                mdTable(
                  ['列', '类型', '非空', '空值', '唯一值', '最小', '最大', '平均', '合计'],
                  [[col, '数值', String(nonEmpty.length), String(values.length - nonEmpty.length), String(unique), fmtNum(Math.min(...nums)), fmtNum(Math.max(...nums)), fmtNum(sum / nums.length), fmtNum(sum)]],
                ),
              )
            } else {
              lines.push(
                mdTable(
                  ['列', '类型', '非空', '空值', '唯一值', '示例'],
                  [[col, '文本', String(nonEmpty.length), String(values.length - nonEmpty.length), String(unique), nonEmpty.slice(0, 3).join(' / ').slice(0, 60)]],
                ),
              )
            }
          }
          return { ok: true, summary: `列统计完成（${shape}）`, detail: lines.join('\n\n') }
        }
        case 'groupby': {
          if (!args.by) return { ok: false, summary: 'groupby 需要 by（分组列名）' }
          const byIdx = table.columnIndex.get(args.by)
          if (byIdx === undefined) return { ok: false, summary: `分组列不存在：${args.by}；可用列：${table.header.join('、')}` }
          let aggName = 'count'
          let aggCol = ''
          if (args.agg) {
            const m = /^(count|sum|avg|min|max)(?::(.+))?$/.exec(args.agg.trim())
            if (!m) return { ok: false, summary: `agg 格式错误：「${args.agg}」，应为 "sum:金额" 或 "count"` }
            aggName = m[1]
            aggCol = m[2] ?? ''
            if (aggName !== 'count' && !aggCol) {
              return { ok: false, summary: `${aggName} 需要指定列：如 "sum:金额"` }
            }
            if (aggCol && !table.columnIndex.has(aggCol)) {
              return { ok: false, summary: `聚合列不存在：${aggCol}；可用列：${table.header.join('、')}` }
            }
          }
          const groups = new Map<string, { values: number[]; count: number }>()
          for (const row of table.rows) {
            const key = (row[byIdx] ?? '').trim() || '（空）'
            const rec = groups.get(key) ?? { values: [], count: 0 }
            rec.count++
            if (aggName !== 'count') {
              const cell = (row[table.columnIndex.get(aggCol) ?? 0] ?? '').trim()
              // 空值跳过（不参与 sum/avg/min/max）；非空且非数值 → 报错不静默
              if (cell !== '') {
                if (!isNumeric(cell)) {
                  return { ok: false, summary: `列「${aggCol}」包含非数值内容（"${cell.slice(0, 20)}"），无法 ${aggName}` }
                }
                rec.values.push(toNum(cell))
              }
            }
            groups.set(key, rec)
          }
          const aggLabel = aggName === 'count' ? '行数' : `${aggName}(${aggCol})`
          const entries = [...groups.entries()].map(([key, rec]) => {
            const value =
              aggName === 'count'
                ? rec.count
                : rec.values.length === 0
                  ? NaN
                  : aggName === 'sum'
                    ? rec.values.reduce((a, b) => a + b, 0)
                    : aggName === 'avg'
                      ? rec.values.reduce((a, b) => a + b, 0) / rec.values.length
                      : aggName === 'min'
                        ? Math.min(...rec.values)
                        : Math.max(...rec.values)
            return [key, Number.isNaN(value) ? '—' : fmtNum(value), String(rec.count)] as string[]
          })
          entries.sort((a, b) => {
            const x = a[1] === '—' ? Number.NEGATIVE_INFINITY : Number(a[1])
            const y = b[1] === '—' ? Number.NEGATIVE_INFINITY : Number(b[1])
            return y - x
          })
          const shown = entries.slice(0, args.limit)
          return {
            ok: true,
            summary: `按「${args.by}」分组 ${entries.length} 组（${aggLabel} 降序，显示 ${shown.length} 组）`,
            detail: mdTable([args.by, aggLabel, '行数'], shown),
          }
        }
        case 'sort': {
          if (!args.column) return { ok: false, summary: 'sort 需要 column（排序列名）' }
          const idx = table.columnIndex.get(args.column)
          if (idx === undefined) return { ok: false, summary: `排序列不存在：${args.column}；可用列：${table.header.join('、')}` }
          const numericCol = table.rows.every((r) => !(r[idx] ?? '').trim() || isNumeric(r[idx] ?? ''))
          const sorted = [...table.rows].sort((a, b) => {
            const x = a[idx] ?? ''
            const y = b[idx] ?? ''
            const cmp = numericCol ? toNum(x || '0') - toNum(y || '0') : x.localeCompare(y, 'zh')
            return args.order === 'desc' ? -cmp : cmp
          })
          const shown = sorted.slice(0, args.limit)
          const pickedHeader = args.columns.length > 0 ? table.header.filter((h) => args.columns.includes(h)) : table.header
          const pickedIdx = pickedHeader.map((h) => table.columnIndex.get(h) ?? 0)
          return {
            ok: true,
            summary: `按「${args.column}」${args.order === 'desc' ? '降序' : '升序'}（显示 ${shown.length} / ${table.rows.length} 行）`,
            detail: mdTable(pickedHeader, shown.map((r) => pickedIdx.map((i) => r[i] ?? ''))),
          }
        }
        default: {
          if (!args.where) return { ok: false, summary: 'filter 需要 where（如 "金额 > 1000"）' }
          const cond = parseWhere(args.where)
          if (!cond) {
            return { ok: false, summary: `where 格式错误：「${args.where}」，应为 "列 操作符 值"（操作符：= != > >= < <= ~）` }
          }
          const idx = table.columnIndex.get(cond.column)
          if (idx === undefined) return { ok: false, summary: `列不存在：${cond.column}；可用列：${table.header.join('、')}` }
          const matched = table.rows.filter((r) => matchWhere(r[idx] ?? '', cond))
          const shown = matched.slice(0, args.limit)
          const pickedHeader = args.columns.length > 0 ? table.header.filter((h) => args.columns.includes(h)) : table.header
          const pickedIdx = pickedHeader.map((h) => table.columnIndex.get(h) ?? 0)
          return {
            ok: true,
            summary: `筛选命中 ${matched.length} / ${table.rows.length} 行（显示前 ${shown.length} 行）`,
            detail: mdTable(pickedHeader, shown.map((r) => pickedIdx.map((i) => r[i] ?? ''))),
          }
        }
      }
    } catch (err) {
      return { ok: false, summary: `表格分析失败：${(err as Error).message}` }
    }
  },
}
