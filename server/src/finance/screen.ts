/**
 * 全市场筛选引擎（M34 §5.1 fin_screen）：底表（东财 clist 快照）→ 条件求值 → 排序 → 截断。
 *
 * 纯计算（零网络）：工具层取底表（网关 screenBase，10 分钟缓存）后交给本模块。
 * 条件 `{ field, op, value }`：数值字段 gt/gte/lt/lte/eq/neq/between，文本字段 contains/eq/neq。
 * 缺失语义：行缺该字段（源未提供行情列）→ 条件不成立（排除该行，避免「缺失当 0」的误判）。
 */
import type { ScreenRow } from './types.js'

export type ScreenOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'between' | 'contains'

/** 全部算子（工具入参白名单） */
export const SCREEN_OPS: readonly ScreenOp[] = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between', 'contains'] as const

export interface ScreenCondition {
  field: string
  op: ScreenOp
  /** between 传 [min, max]；数值/文本按字段类型 */
  value: number | string | [number, number]
}

export interface ScreenFieldSpec {
  key: string
  label: string
  kind: 'number' | 'string'
  unit?: string
}

/** 可筛选字段表（顺序即工具说明中的展示顺序） */
export const SCREEN_FIELDS: readonly ScreenFieldSpec[] = [
  { key: 'price', label: '最新价', kind: 'number', unit: '元' },
  { key: 'changePct', label: '涨跌幅', kind: 'number', unit: '%' },
  { key: 'turnoverRate', label: '换手率', kind: 'number', unit: '%' },
  { key: 'pe', label: '市盈率(动态)', kind: 'number', unit: '倍' },
  { key: 'pb', label: '市净率', kind: 'number', unit: '倍' },
  { key: 'marketCap', label: '总市值', kind: 'number', unit: '元（1 亿 = 1e8）' },
  { key: 'floatMarketCap', label: '流通市值', kind: 'number', unit: '元（1 亿 = 1e8）' },
  { key: 'turnover', label: '成交额', kind: 'number', unit: '元（1 亿 = 1e8）' },
  { key: 'volume', label: '成交量', kind: 'number', unit: '手' },
  { key: 'code', label: '代码', kind: 'string' },
  { key: 'name', label: '名称', kind: 'string' },
  { key: 'type', label: '品种（stock/etf/fund/index）', kind: 'string' },
] as const

export class ScreenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScreenError'
  }
}

const NUMERIC_OPS = new Set<ScreenOp>(['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between'])
const STRING_OPS = new Set<ScreenOp>(['contains', 'eq', 'neq'])

/** 字段查找（未知字段抛 ScreenError，附可用字段清单） */
export function screenFieldSpec(field: string): ScreenFieldSpec {
  const spec = SCREEN_FIELDS.find((entry) => entry.key === field)
  if (!spec) {
    throw new ScreenError(`不支持的筛选字段「${field}」（可用：${SCREEN_FIELDS.map((f) => f.key).join(' / ')}）`)
  }
  return spec
}

/** 单条条件校验（字段存在 / 算子适配 / 值类型） */
function validateCondition(cond: ScreenCondition): ScreenFieldSpec {
  if (!cond || typeof cond.field !== 'string' || !cond.field) {
    throw new ScreenError('筛选条件缺少 field')
  }
  const spec = screenFieldSpec(cond.field)
  if (!cond.op || !SCREEN_OPS.includes(cond.op)) {
    throw new ScreenError(`条件 ${cond.field} 的算子非法（可用：${SCREEN_OPS.join(' / ')}）`)
  }
  if (spec.kind === 'number') {
    if (!NUMERIC_OPS.has(cond.op)) {
      throw new ScreenError(`数值字段「${spec.label}」不支持算子 ${cond.op}（可用：gt / gte / lt / lte / eq / neq / between）`)
    }
    if (cond.op === 'between') {
      const pair = cond.value
      if (!Array.isArray(pair) || pair.length !== 2 || !Number.isFinite(pair[0]) || !Number.isFinite(pair[1])) {
        throw new ScreenError(`between 条件「${spec.label}」需要 [最小值, 最大值] 数值数组`)
      }
    } else if (typeof cond.value !== 'number' || !Number.isFinite(cond.value)) {
      throw new ScreenError(`条件「${spec.label}」需要数值 value`)
    }
  } else {
    if (!STRING_OPS.has(cond.op)) {
      throw new ScreenError(`文本字段「${spec.label}」不支持算子 ${cond.op}（可用：contains / eq / neq）`)
    }
    if (cond.op === 'between') {
      throw new ScreenError(`between 不适用于文本字段「${spec.label}」`)
    }
    if (typeof cond.value !== 'string' || !cond.value) {
      throw new ScreenError(`条件「${spec.label}」需要非空文本 value`)
    }
  }
  return spec
}

/** 数值相等容差（相对量级） */
function nearEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
}

/** 单行条件求值（缺失字段 → false） */
function matchesRow(row: ScreenRow, cond: ScreenCondition, spec: ScreenFieldSpec): boolean {
  const raw = (row as unknown as Record<string, unknown>)[cond.field]
  if (spec.kind === 'number') {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return false
    const v = cond.value as number | [number, number]
    switch (cond.op) {
      case 'gt':
        return raw > (v as number)
      case 'gte':
        return raw >= (v as number)
      case 'lt':
        return raw < (v as number)
      case 'lte':
        return raw <= (v as number)
      case 'eq':
        return nearEqual(raw, v as number)
      case 'neq':
        return !nearEqual(raw, v as number)
      case 'between': {
        const [min, max] = v as [number, number]
        return raw >= Math.min(min, max) && raw <= Math.max(min, max)
      }
      default:
        return false
    }
  }
  const text = typeof raw === 'string' ? raw : ''
  const target = cond.value as string
  switch (cond.op) {
    case 'contains':
      return text.toLowerCase().includes(target.toLowerCase())
    case 'eq':
      return text.toLowerCase() === target.toLowerCase()
    case 'neq':
      return text.toLowerCase() !== target.toLowerCase()
    default:
      return false
  }
}

export interface ScreenOrderBy {
  field: string
  desc?: boolean
}

export interface ScreenOutcome {
  /** 底表总行数 */
  total: number
  /** 命中行数（截断前） */
  matched: number
  /** 排序截断后的结果行 */
  rows: ScreenRow[]
}

/**
 * 筛选主入口：全条件 AND 语义 → 排序 → 截断。
 * orderBy 缺省保持底表原序；排序字段缺失的行恒排最后（方向无关）。
 */
export function screenRows(
  rows: ScreenRow[],
  conditions: ScreenCondition[] = [],
  opts: { orderBy?: ScreenOrderBy; limit?: number } = {},
): ScreenOutcome {
  const specs = conditions.map((cond) => validateCondition(cond))
  let orderSpec: ScreenFieldSpec | undefined
  if (opts.orderBy) {
    if (typeof opts.orderBy.field !== 'string' || !opts.orderBy.field) {
      throw new ScreenError('orderBy 缺少 field')
    }
    orderSpec = screenFieldSpec(opts.orderBy.field)
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100)

  const hit = rows.filter((row) => conditions.every((cond, i) => matchesRow(row, cond, specs[i])))
  if (orderSpec && opts.orderBy) {
    const desc = opts.orderBy.desc === true
    const spec = orderSpec
    hit.sort((a, b) => {
      const va = (a as unknown as Record<string, unknown>)[spec.key]
      const vb = (b as unknown as Record<string, unknown>)[spec.key]
      const missingA = va === undefined || va === null
      const missingB = vb === undefined || vb === null
      if (missingA && missingB) return 0
      if (missingA) return 1
      if (missingB) return -1
      let cmp: number
      if (spec.kind === 'number') cmp = (va as number) - (vb as number)
      else cmp = String(va).localeCompare(String(vb), 'zh-Hans-CN')
      return desc ? -cmp : cmp
    })
  }
  return { total: rows.length, matched: hit.length, rows: hit.slice(0, limit) }
}

/** 条件中文描述（工具 detail 用；值格式化含单位） */
export function describeScreenCondition(cond: ScreenCondition): string {
  const spec = screenFieldSpec(cond.field)
  const fmt = (value: number | string): string =>
    typeof value === 'number' ? (Number.isInteger(value) ? String(value) : value.toPrecision(6)) : value
  const unit = spec.unit ? ` ${spec.unit.replace(/（.*?）/g, '')}` : ''
  switch (cond.op) {
    case 'gt':
      return `${spec.label} > ${fmt(cond.value as number)}${unit}`
    case 'gte':
      return `${spec.label} ≥ ${fmt(cond.value as number)}${unit}`
    case 'lt':
      return `${spec.label} < ${fmt(cond.value as number)}${unit}`
    case 'lte':
      return `${spec.label} ≤ ${fmt(cond.value as number)}${unit}`
    case 'eq':
      return `${spec.label} = ${fmt(cond.value as number | string)}${cond.value === '' ? '' : unit}`
    case 'neq':
      return `${spec.label} ≠ ${fmt(cond.value as number | string)}`
    case 'between': {
      const [min, max] = cond.value as [number, number]
      return `${spec.label} ∈ [${fmt(min)}, ${fmt(max)}]${unit}`
    }
    case 'contains':
      return `${spec.label} 含「${cond.value as string}」`
    default:
      return `${spec.label} ${cond.op} ${fmt(cond.value as number | string)}`
  }
}
