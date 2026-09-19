/**
 * M51-E：排盘工具计算层（纯函数，无 IO / 无 ToolRuntime 依赖；golden 测试直接调用）。
 *
 * 四件套：bazi（四柱八字）/ ziwei（紫微斗数）/ natal（西方星盘）/ gua（六爻梅花）。
 * 失败语义（design §6.2）：库计算失败 → 结构化错误 + 建议，禁止心算兜底。
 */

/** 计算层结构化错误（工具层转 ToolResult.ok=false） */
export class PanError extends Error {
  readonly hint: string
  constructor(message: string, hint: string) {
    super(message)
    this.name = 'PanError'
    this.hint = hint
  }
}

/** 出生时刻输入（公历 / 农历二选一；农历闰月用负月号显式表达） */
export interface BirthInput {
  /** 'YYYY-MM-DD HH:mm'（calendar=solar 时为公历；calendar=lunar 时为农历日期 + 时分） */
  birth: string
  calendar: 'solar' | 'lunar'
  /** 农历闰月标记（calendar=lunar 且该年该月为闰月时置 true；库用负月号表达） */
  isLeapMonth?: boolean
  gender: 'male' | 'female'
  /** 出生地经度（东经为正，单位度）；缺省时按 timezone 标准经线估算 */
  longitude?: number
  /** 真太阳时校正（默认开启；给出校正分钟告警） */
  trueSolarTime?: boolean
  /** IANA 时区名（如 Asia/Shanghai；用于标准经线估算） */
  timezone?: string
}

/** 常用时区的标准经线（度，东经为正）；未收录时区 → 不校正经度并告警 */
export const TIMEZONE_MERIDIAN: Record<string, number> = {
  UTC: 0,
  'Asia/Shanghai': 120,
  'Asia/Chongqing': 120,
  'Asia/Harbin': 120,
  'Asia/Tokyo': 135,
  'Asia/Seoul': 135,
  'Asia/Singapore': 120,
  'Asia/Hong_Kong': 120,
  'Asia/Taipei': 120,
  'Asia/Bangkok': 105,
  'Asia/Kolkata': 82.5,
  'Asia/Dubai': 60,
  'Europe/London': 0,
  'Europe/Paris': 15,
  'Europe/Berlin': 15,
  'Europe/Moscow': 45,
  'America/New_York': -75,
  'America/Chicago': -90,
  'America/Denver': -105,
  'America/Los_Angeles': -120,
  'America/Sao_Paulo': -45,
  'Australia/Sydney': 150,
  'Pacific/Auckland': 180,
}

/** 'YYYY-MM-DD HH:mm' 解析（时分缺省 00:00；非法 → PanError） */
export function parseDateTime(text: string, field: string): { y: number; m: number; d: number; hh: number; mm: number } {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(text.trim())
  if (!m) throw new PanError(`${field} 格式非法：「${text}」`, '请用「YYYY-MM-DD HH:mm」格式，如 1990-05-12 14:30')
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const hh = m[4] ? Number(m[4]) : 0
  const mi = m[5] ? Number(m[5]) : 0
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59) {
    throw new PanError(`${field} 数值越界：「${text}」`, '请检查月 / 日 / 时分取值')
  }
  return { y, m: mo, d, hh, mm: mi }
}

/** 一年中的第 N 天（1-366；用于均时差近似） */
export function dayOfYear(y: number, m: number, d: number): number {
  const start = Date.UTC(y, 0, 1)
  const cur = Date.UTC(y, m - 1, d)
  return Math.floor((cur - start) / 86_400_000) + 1
}

/** 均时差近似（分钟；NOAA 简化式，误差 ±30s 量级，足够时辰分界判断） */
export function equationOfTime(y: number, m: number, d: number): number {
  const n = dayOfYear(y, m, d)
  const b = (2 * Math.PI * (n - 81)) / 364
  return 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b)
}

/** 经度时差（分钟；相对标准经线，东经为正 → 提前） */
export function longitudeCorrection(longitude: number, meridian: number): number {
  return (longitude - meridian) * 4
}

/** 时间加减分钟（返回新 {y,m,d,hh,mm}；允许跨日进位） */
export function shiftMinutes(
  t: { y: number; m: number; d: number; hh: number; mm: number },
  minutes: number,
): { y: number; m: number; d: number; hh: number; mm: number } {
  const base = Date.UTC(t.y, t.m - 1, t.d, t.hh, t.mm) + Math.round(minutes * 60_000)
  const dt = new Date(base)
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    hh: dt.getUTCHours(),
    mm: dt.getUTCMinutes(),
  }
}

/** 'YYYY-MM-DD HH:mm' 格式化 */
export function fmtDateTime(t: { y: number; m: number; d: number; hh: number; mm: number }): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(t.y, 4)}-${p(t.m)}-${p(t.d)} ${p(t.hh)}:${p(t.mm)}`
}

/** 真太阳时校正结果：校正后时刻 + 告警行列表 + 校正量（分钟） */
export interface TrueSolarResult {
  corrected: { y: number; m: number; d: number; hh: number; mm: number }
  warnings: string[]
  /** 校正总量（分钟，四舍五入；未校正 / 跳过 → null） */
  correctionMinutes: number | null
}

/**
 * 真太阳时校正（默认开启）：经度时差 + 均时差。
 * - 未给经度：按 timezone 标准经线估算；未收录时区 → 不校正 + 告警；
 * - 校正量四舍五入到分钟；|校正| ≥ 1 分钟时给出告警行。
 */
export function applyTrueSolarTime(
  input: BirthInput,
  t: { y: number; m: number; d: number; hh: number; mm: number },
): TrueSolarResult {
  const warnings: string[] = []
  if (input.trueSolarTime === false) return { corrected: t, warnings, correctionMinutes: null }
  let meridian: number | undefined
  if (typeof input.longitude === 'number') {
    if (input.longitude < -180 || input.longitude > 180) {
      throw new PanError(`经度越界：${input.longitude}`, '经度取值范围 [-180, 180]（东经为正）')
    }
    meridian = input.timezone ? TIMEZONE_MERIDIAN[input.timezone] : undefined
    if (meridian === undefined) meridian = input.longitude
    if (input.timezone && TIMEZONE_MERIDIAN[input.timezone] === undefined) {
      warnings.push(`时区「${input.timezone}」未收录，按出生地经度自身为基准不做经度时差（真太阳时仅含均时差）`)
      meridian = input.longitude
    }
  } else if (input.timezone) {
    meridian = TIMEZONE_MERIDIAN[input.timezone]
    if (meridian === undefined) {
      warnings.push(`时区「${input.timezone}」未收录且未提供出生地经度，真太阳时校正跳过（结果按标准时间排盘）`)
      return { corrected: t, warnings, correctionMinutes: null }
    }
  } else {
    warnings.push('未提供出生地经度 / 时区，真太阳时校正跳过（结果按标准时间排盘）')
    return { corrected: t, warnings, correctionMinutes: null }
  }
  const lonCorr = typeof input.longitude === 'number' ? longitudeCorrection(input.longitude, meridian) : 0
  const eot = equationOfTime(t.y, t.m, t.d)
  const total = lonCorr + eot
  const corrected = shiftMinutes(t, total)
  const sign = total >= 0 ? '+' : '-'
  const abs = Math.abs(total)
  if (abs >= 1) {
    warnings.push(`已按真太阳时校正 ${sign}${Math.round(abs)} 分钟（经度时差 ${Math.round(lonCorr)}m + 均时差 ${Math.round(eot)}m）`)
  } else {
    warnings.push(`真太阳时校正量 ${total.toFixed(1)} 分钟（小于 1 分钟，未调整）`)
  }
  return { corrected, warnings, correctionMinutes: Math.round(total) }
}

/** 五行统计键（木火土金水） */
export type WuXingKey = 'wood' | 'fire' | 'earth' | 'metal' | 'water'

/** 干支 → 五行（干与支分列；用于统计） */
export const GAN_WUXING: Record<string, WuXingKey> = {
  甲: 'wood', 乙: 'wood',
  丙: 'fire', 丁: 'fire',
  戊: 'earth', 己: 'earth',
  庚: 'metal', 辛: 'metal',
  壬: 'water', 癸: 'water',
}
export const ZHI_WUXING: Record<string, WuXingKey> = {
  寅: 'wood', 卯: 'wood',
  巳: 'fire', 午: 'fire',
  辰: 'earth', 戌: 'earth', 丑: 'earth', 未: 'earth',
  申: 'metal', 酉: 'metal',
  亥: 'water', 子: 'water',
}
