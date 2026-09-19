/**
 * K 线周期与交易时段（M34）：周期枚举 / 各源参数映射 / A 股交易时段判定。
 *
 * 时区约定：A 股无夏令时，北京时间固定 UTC+8；日线时间戳 = 当日 00:00 北京时间。
 */

export type Period = 'day' | 'week' | 'month' | 'min5' | 'min15' | 'min30' | 'min60'
export type Adjust = 'qfq' | 'hfq' | 'none'

/** 周期 / 复权清单（tuple 常量：zod 枚举 / 路由参数校验直接复用） */
export const PERIODS = ['day', 'week', 'month', 'min5', 'min15', 'min30', 'min60'] as const satisfies readonly Period[]
export const ADJUSTS = ['qfq', 'hfq', 'none'] as const satisfies readonly Adjust[]

/** 北京时间与 UTC 的固定偏移（毫秒） */
export const CN_TZ_OFFSET_MS = 8 * 60 * 60 * 1_000

/** 东财 klt：101 日 / 102 周 / 103 月 / 5·15·30·60 分钟 */
export function periodToEastmoneyKlt(period: Period): string {
  switch (period) {
    case 'day':
      return '101'
    case 'week':
      return '102'
    case 'month':
      return '103'
    case 'min5':
      return '5'
    case 'min15':
      return '15'
    case 'min30':
      return '30'
    case 'min60':
      return '60'
  }
}

/** baostock frequency：d / w / m / 5 / 15 / 30 / 60 */
export function periodToBaoStock(period: Period): string {
  switch (period) {
    case 'day':
      return 'd'
    case 'week':
      return 'w'
    case 'month':
      return 'm'
    case 'min5':
      return '5'
    case 'min15':
      return '15'
    case 'min30':
      return '30'
    case 'min60':
      return '60'
  }
}

/** 东财 fqt：1 前复权 / 2 后复权 / 0 不复权 */
export function adjustToEastmoneyFqt(adjust: Adjust): string {
  return adjust === 'qfq' ? '1' : adjust === 'hfq' ? '2' : '0'
}

/** baostock adjustflag：2 前复权 / 1 后复权 / 3 不复权 */
export function adjustToBaoStock(adjust: Adjust): string {
  return adjust === 'qfq' ? '2' : adjust === 'hfq' ? '1' : '3'
}

/** 周期中文名（报告与摘要用） */
export function periodLabel(period: Period): string {
  const map: Record<Period, string> = {
    day: '日',
    week: '周',
    month: '月',
    min5: '5分钟',
    min15: '15分钟',
    min30: '30分钟',
    min60: '60分钟',
  }
  return map[period]
}

export function adjustLabel(adjust: Adjust): string {
  return adjust === 'qfq' ? '前复权' : adjust === 'hfq' ? '后复权' : '不复权'
}

/** 东财日期串（yyyy-MM-dd）→ 毫秒时间戳（按北京时间当日 00:00） */
export function parseCnDate(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date.trim())
  if (!m) return Number.NaN
  const utcMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return utcMs - CN_TZ_OFFSET_MS
}

/** 毫秒时间戳 → 北京日期 yyyy-MM-dd */
export function formatCnDate(ts: number): string {
  const d = new Date(ts + CN_TZ_OFFSET_MS)
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${d.getUTCFullYear()}-${mm}-${dd}`
}

/** 毫秒时间戳 → 北京日期时间 yyyy-MM-dd HH:mm */
export function formatCnDateTime(ts: number): string {
  const d = new Date(ts + CN_TZ_OFFSET_MS)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mi = String(d.getUTCMinutes()).padStart(2, '0')
  return `${formatCnDate(ts)} ${hh}:${mi}`
}

/** 北京时间周几（0=周日） */
function cnWeekday(date: Date): number {
  return new Date(date.getTime() + CN_TZ_OFFSET_MS).getUTCDay()
}

/** 北京时间小时分钟（数值对） */
function cnHourMinute(date: Date): [number, number] {
  const d = new Date(date.getTime() + CN_TZ_OFFSET_MS)
  return [d.getUTCHours(), d.getUTCMinutes()]
}

/**
 * 是否交易日（首期：周一至周五；节假日日历在 baostock 可用时经 finance_meta 增强，
 * 缺省不识别法定节假日——文档口径「日历优先 baostock，缺省内置周末规则」）。
 */
export function isTradingDay(date: Date, holidays?: Set<string>): boolean {
  const weekday = cnWeekday(date)
  if (weekday === 0 || weekday === 6) return false
  if (holidays && holidays.has(formatCnDate(date.getTime()))) return false
  return true
}

export interface TradingSessionState {
  /** 是否处于连续竞价时段内 */
  open: boolean
  /** 说明（中文，用于 UI 标注） */
  reason: string
}

/**
 * 交易时段判定（北京时间）：
 *   09:30-11:30 / 13:00-15:00 为连续竞价；11:30-13:00 午休；其余休市。
 * 仅作刷新节流与「数据新鲜度」标注，不用于交易决策。
 */
export function tradingSession(date: Date = new Date(), holidays?: Set<string>): TradingSessionState {
  if (!isTradingDay(date, holidays)) return { open: false, reason: '非交易日（周末/节假日）' }
  const [h, m] = cnHourMinute(date)
  const minutes = h * 60 + m
  if (minutes >= 9 * 60 + 30 && minutes < 11 * 60 + 30) return { open: true, reason: '交易中（上午）' }
  if (minutes >= 13 * 60 && minutes < 15 * 60) return { open: true, reason: '交易中（下午）' }
  if (minutes >= 9 * 60 + 15 && minutes < 9 * 60 + 30) return { open: false, reason: '集合竞价' }
  if (minutes >= 11 * 60 + 30 && minutes < 13 * 60) return { open: false, reason: '午间休市' }
  if (minutes < 9 * 60 + 15) return { open: false, reason: '开盘前' }
  return { open: false, reason: '已收盘' }
}

/** 交易时段内才轮询（前端行情刷新节流用） */
export function shouldPollQuotes(date: Date = new Date(), holidays?: Set<string>): boolean {
  return tradingSession(date, holidays).open
}
