/**
 * date_calc 工具（M21.2）：日期与排期计算 —— add / diff / list / period。
 * UTC 毫秒内部表示（日期字符串无时区歧义）；输出 ISO + 中文星期；纯函数可单测。
 */
import { z } from 'zod'
import type { ToolRuntime, ToolResult } from './registry.js'

const DAY_MS = 86_400_000
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const UNIT_LABELS: Record<string, string> = {
  day: '天',
  week: '周',
  month: '月',
  year: '年',
  'business-day': '个工作日',
  quarter: '个季度',
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 'YYYY-MM-DD' → UTC 零点毫秒；非法格式 / 非法日期抛中文错误 */
export function parseDate(s: string): number {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s.trim())
  if (!m) throw new Error(`日期格式错误：「${s}」，需为 YYYY-MM-DD（如 2025-04-01）`)
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const ms = Date.UTC(y, mo - 1, d)
  const dt = new Date(ms)
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new Error(`无效日期：${s}（该日期不存在）`)
  }
  return ms
}

export function fmtDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}（${WEEKDAYS[d.getUTCDay()]}）`
}

function todayMs(): number {
  const now = new Date()
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
}

export function isWeekend(ms: number): boolean {
  const day = new Date(ms).getUTCDay()
  return day === 0 || day === 6
}

/** 月末对齐加月（如 1-31 + 1 月 → 2-28/29；闰年 2-29 + 1 年 → 次年 2-28） */
export function addMonths(ms: number, n: number): number {
  const d = new Date(ms)
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + n
  const ty = Math.floor(total / 12)
  const tm = ((total % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate()
  return Date.UTC(ty, tm, Math.min(d.getUTCDate(), lastDay))
}

function shiftWeekend(ms: number): number {
  let cur = ms
  while (isWeekend(cur)) cur += DAY_MS
  return cur
}

/** 按单个单位步进（business-day 只计工作日；周末自动顺延到周一） */
function stepOnce(ms: number, unit: string, sign: 1 | -1): number {
  switch (unit) {
    case 'day':
      return ms + sign * DAY_MS
    case 'week':
      return ms + sign * 7 * DAY_MS
    case 'month':
      return addMonths(ms, sign)
    case 'year':
      return addMonths(ms, sign * 12)
    default: {
      let cur = ms
      let left = 1
      while (left > 0) {
        cur += sign * DAY_MS
        if (!isWeekend(cur)) left--
      }
      return cur
    }
  }
}

export function addUnit(base: number, amount: number, unit: string): number {
  if (unit === 'business-day') {
    const sign = amount >= 0 ? 1 : -1
    let cur = base
    for (let i = 0; i < Math.abs(amount); i++) cur = stepOnce(cur, unit, sign)
    return cur
  }
  if (unit === 'month') return addMonths(base, amount)
  if (unit === 'year') return addMonths(base, amount * 12)
  const factor = unit === 'week' ? 7 : 1
  return base + amount * factor * DAY_MS
}

/** 工作日间隔（含目标日、不含基准日的方向定义：向前为正，向后为负） */
export function businessDayDiff(from: number, to: number): number {
  if (to === from) return 0
  const sign = to > from ? 1 : -1
  let cur = from
  let count = 0
  while (cur !== to) {
    cur += sign * DAY_MS
    if (!isWeekend(cur)) count += sign
  }
  return count
}

function periodOf(base: number, unit: string): { start: number; end: number; label: string } {
  const d = new Date(base)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  switch (unit) {
    case 'week': {
      const dow = d.getUTCDay()
      const offset = dow === 0 ? 6 : dow - 1 // 周一为一周开始
      const start = base - offset * DAY_MS
      return { start, end: start + 6 * DAY_MS, label: '所在周（周一至周日）' }
    }
    case 'quarter': {
      const q = Math.floor(m / 3)
      const start = Date.UTC(y, q * 3, 1)
      const end = Date.UTC(y, q * 3 + 3, 0)
      return { start, end, label: `第 ${q + 1} 季度` }
    }
    case 'year':
      return { start: Date.UTC(y, 0, 1), end: Date.UTC(y, 11, 31), label: '自然年' }
    default:
      return { start: Date.UTC(y, m, 1), end: Date.UTC(y, m + 1, 0), label: '自然月' }
  }
}

export const dateCalcTool = {
  name: 'date_calc',
  readOnly: true,
  description:
    '日期与排期计算：add（加减，支持工作日）/ diff（自然日 + 工作日）/ list（排期列表，可跳周末）/ period（周 / 月 / 季 / 年起止）。排期与截止日一律用它核算，不拍脑袋报日期。',
  parameters: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['add', 'diff', 'list', 'period'], description: '操作类型' },
      base: { type: 'string', description: '基准日期 YYYY-MM-DD（缺省为今天）' },
      amount: { type: 'number', description: 'add：数量（可为负，如提前 3 天用 -3）' },
      unit: {
        type: 'string',
        enum: ['day', 'week', 'month', 'year', 'business-day', 'quarter'],
        description: 'add/diff 的单位；period 用 week/month/quarter/year',
      },
      to: { type: 'string', description: 'diff：目标日期 YYYY-MM-DD' },
      interval: { type: 'number', description: 'list：生成间隔（默认 1）' },
      count: { type: 'number', description: 'list：生成数量（1-60，默认 10）' },
      skip_weekends: { type: 'boolean', description: 'list：跳过周末（排期用，默认 false）' },
    },
    required: ['op'],
  },
  schema: z.object({
    op: z.enum(['add', 'diff', 'list', 'period']),
    base: z.string().optional(),
    amount: z.number().int().min(-10_000).max(10_000).optional(),
    unit: z.enum(['day', 'week', 'month', 'year', 'business-day', 'quarter']).optional(),
    to: z.string().optional(),
    interval: z.number().int().min(1).max(100).default(1),
    count: z.number().int().min(1).max(60).default(10),
    skip_weekends: z.boolean().default(false),
  }),
  async execute(
    args: {
      op: 'add' | 'diff' | 'list' | 'period'
      base?: string
      amount?: number
      unit?: string
      to?: string
      interval: number
      count: number
      skip_weekends: boolean
    },
    _ctx: ToolRuntime,
  ): Promise<ToolResult> {
    try {
      const base = args.base ? parseDate(args.base) : todayMs()
      switch (args.op) {
        case 'add': {
          if (args.amount === undefined) return { ok: false, summary: 'add 需要 amount（数量，可为负）' }
          const unit = args.unit ?? 'day'
          const result = addUnit(base, args.amount, unit)
          return {
            ok: true,
            summary: `${fmtDate(base)} ${args.amount >= 0 ? '+' : ''}${args.amount} ${UNIT_LABELS[unit]} = ${fmtDate(result)}`,
            detail: `${fmtDate(base)} ${args.amount >= 0 ? '+' : ''}${args.amount} ${UNIT_LABELS[unit]}\n结果：${fmtDate(result)}`,
          }
        }
        case 'diff': {
          if (!args.to) return { ok: false, summary: 'diff 需要 to（目标日期 YYYY-MM-DD）' }
          const to = parseDate(args.to)
          const natural = Math.round((to - base) / DAY_MS)
          const business = businessDayDiff(base, to)
          return {
            ok: true,
            summary: `${fmtDate(base)} → ${fmtDate(to)}：${Math.abs(natural)} 自然日 / ${Math.abs(business)} 工作日${natural < 0 ? '（向后）' : ''}`,
            detail: `基准：${fmtDate(base)}\n目标：${fmtDate(to)}\n自然日间隔：${natural} 天\n工作日间隔：${business} 天（周一至周五，不含基准日）`,
          }
        }
        case 'list': {
          const unit = args.unit ?? 'day'
          const start = args.skip_weekends ? shiftWeekend(base) : base
          const dates: string[] = []
          let cur = start
          for (let i = 0; i < args.count; i++) {
            const d = args.skip_weekends ? shiftWeekend(cur) : cur
            dates.push(fmtDate(d))
            cur = addUnit(d, args.interval, unit)
          }
          return {
            ok: true,
            summary: `已生成 ${args.count} 个排期日（${fmtDate(start).slice(0, 10)} 起，每 ${args.interval} ${UNIT_LABELS[unit]}）`,
            detail: dates.map((d, i) => `${i + 1}. ${d}`).join('\n'),
          }
        }
        default: {
          const unit = args.unit ?? 'month'
          if (!['week', 'month', 'quarter', 'year'].includes(unit)) {
            return { ok: false, summary: 'period 的 unit 只能是 week / month / quarter / year' }
          }
          const p = periodOf(base, unit)
          return {
            ok: true,
            summary: `${fmtDate(base)} 的${p.label}：${fmtDate(p.start)} ～ ${fmtDate(p.end)}`,
            detail: `基准：${fmtDate(base)}（${p.label}）\n起：${fmtDate(p.start)}\n止：${fmtDate(p.end)}`,
          }
        }
      }
    } catch (err) {
      return { ok: false, summary: `日期计算失败：${(err as Error).message}` }
    }
  },
}
