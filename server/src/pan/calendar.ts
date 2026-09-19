/**
 * M66 续完善：历法基础域（纯计算，零依赖）——儒略日 / 日干支 / 节气近似月建。
 *
 * 口径与声明：
 * - 日干支锚定公开基准 2000-01-01 = 戊午日（序 54），公式 `(JDN + 49) mod 60`（甲子 = 0）；
 * - 月建以节气「节」为界（立春后寅月……小寒后丑月），节日期按通用近似公式（1900–2100，
 *   个别年份 ±1 天）——边界日建议以专业历书复核（输出随声明）。
 */

/** 十天干 / 十二地支 */
export const GAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'] as const
export const ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'] as const

/** 公历日期 → 儒略日数（JDN，正午制整数；标准 Gregorian 公式） */
export function jdnOf(y: number, m: number, d: number): number {
  const a = Math.floor((14 - m) / 12)
  const yy = y + 4800 - a
  const mm = m + 12 * a - 3
  return (
    d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045
  )
}

export interface GanzhiDay {
  /** 甲子序 0–59（甲子 = 0） */
  index: number
  gan: string
  zhi: string
  /** 日柱（如「丙申」） */
  name: string
  /** 地支序（子 = 0） */
  zhiIndex: number
}

/** 日干支（golden：2000-01-01 = 戊午 / 2024-01-01 = 甲子 / 2026-09-19 = 丙申） */
export function dayGanzhi(y: number, m: number, d: number): GanzhiDay {
  const index = (((jdnOf(y, m, d) + 49) % 60) + 60) % 60
  const zi = index % 12
  return { index, gan: GAN[index % 10]!, zhi: ZHI[zi]!, name: `${GAN[index % 10]!}${ZHI[zi]!}`, zhiIndex: zi }
}

/** 12「节」的 21 世纪近似常数（小寒→立春→惊蛰→清明→立夏→芒种→小暑→立秋→白露→寒露→立冬→大雪） */
const JIE_C: Record<number, number> = {
  1: 5.4055,
  2: 3.87,
  3: 5.63,
  4: 4.81,
  5: 5.52,
  6: 5.678,
  7: 7.108,
  8: 7.5,
  9: 7.646,
  10: 8.318,
  11: 7.438,
  12: 7.18,
}

/** 某年某月「节」的近似日期（golden：2026-02 立春 = 4 日 / 2026-09 白露 = 7 日） */
export function jieDayOf(y: number, month: number): number {
  const c = JIE_C[month]!
  const yy = y % 100
  return Math.floor(yy * 0.2422 + c) - Math.floor(yy / 4)
}

export interface MonthZhi {
  /** 月支（节气月建） */
  zhi: string
  /** 月支序（子 = 0） */
  index: number
  /** 是否在当月「节」之前（节前属上月建） */
  beforeJie: boolean
}

/** 节气月建（golden：2026-09-19 白露后 → 酉月；2024-01-01 小寒前 → 子月） */
export function monthZhiOf(y: number, m: number, d: number): MonthZhi {
  const jie = jieDayOf(y, m)
  const beforeJie = d < jie
  // 节后：m 月的节 → 月支序 = m % 12（2 月→寅 / 12 月→子 / 1 月→丑）；节前：上月建 (m+11)%12（1 月→子）
  const index = beforeJie ? (m + 11) % 12 : m % 12
  return { zhi: ZHI[index]!, index, beforeJie }
}

/** 生肖（子鼠…亥猪） */
export const ZODIAC = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'] as const

/** 格式化（YYYY-MM-DD） */
export function fmtDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** 解析 YYYY-MM-DD（不合法返回 undefined） */
export function parseDate(s: string): { y: number; m: number; d: number } | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim())
  if (!m) return undefined
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined
  const check = new Date(Date.UTC(y, mo - 1, d))
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return undefined
  return { y, m: mo, d }
}

/** 下一日（跨月 / 跨年安全；用 UTC 日期推进） */
export function nextDay(y: number, m: number, d: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d))
  t.setUTCDate(t.getUTCDate() + 1)
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}

/** 星期（周日 = 0） */
export function weekdayOf(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

export const WEEK_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const
