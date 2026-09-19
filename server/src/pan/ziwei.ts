/**
 * M51-E：紫微斗数计算（iztro 封装）。
 *
 * 输入同八字（公历 / 农历 + 时辰 + 性别 + 真太阳时校正）；
 * 输出十二宫（宫名 / 主星辅星 / 亮度 / 四化）/ 五行局 / 命主身主 / 大限。
 * 时辰映射（iztro 约定）：0=早子时(00:00-01:00)…7=未时(13:00-15:00)…11=亥时，12=晚子时(23:00-24:00)。
 */
import { astro } from 'iztro'
import { toLunar } from './bazi.js'
import { BirthInput, PanError, parseDateTime } from './types.js'

export interface ZiweiStar {
  name: string
  brightness?: string
  /** 四化（禄 / 权 / 科 / 忌；无 → 空） */
  mutagen?: string
}

export interface ZiweiPalace {
  name: string
  heavenlyStem: string
  earthlyBranch: string
  /** 命宫 / 身宫标记 */
  isSoulPalace: boolean
  isBodyPalace: boolean
  majorStars: ZiweiStar[]
  minorStars: ZiweiStar[]
  /** 杂曜名（长生十二神之外的辅佐星曜） */
  adjectiveStars: string[]
  /** 长生十二神（长生 / 沐浴 / 冠带 / …） */
  changSheng: string
  /** 大限年龄段 [起, 止]（虚岁） */
  decadalRange: [number, number]
  /** 当前大限所在宫（按当前虚岁落入） */
  isCurrentDecadal: boolean
}

/** 命身宫定位（宫名 + 宫干支） */
export interface ZiweiPalaceRef {
  name: string
  ganZhi: string
}

export interface ZiweiResult {
  input: { birth: string; calendar: string; gender: string; corrected: string; correction: number | null }
  solar: string
  lunar: string
  /** 干支纪年四柱（如「庚午 辛巳 丁丑 丁未」） */
  chineseDate: string
  /** 生肖 / 星座 */
  zodiac: string
  sign: string
  timeLabel: string
  timeRange: string
  fiveElementsClass: string
  soul: string
  body: string
  /** 命宫 / 身宫 / 来因宫（宫名 + 干支；来因宫无标记时为 null） */
  soulPalace: ZiweiPalaceRef
  bodyPalace: ZiweiPalaceRef
  laiYinPalace: ZiweiPalaceRef | null
  /** 生年四化（禄 / 权 / 科 / 忌 → 星名列表；按禄权科忌排序，仅含有星项） */
  mutagenStars: Array<{ mutagen: string; stars: string[] }>
  palaces: ZiweiPalace[]
  warnings: string[]
}

/** HH:mm → iztro 时辰序号（0-12；23 时为晚子时 12 号，0 时为早子时 0 号） */
export function timeToIndex(hh: number, mm = 0): number {
  const h = hh + mm / 60
  if (h >= 23) return 12
  if (h < 1) return 0
  return Math.floor((h + 1) / 2)
}

/** 时辰序号 → 中文时段标签 */
const TIME_LABEL = ['早子时', '丑时', '寅时', '卯时', '辰时', '巳时', '午时', '未时', '申时', '酉时', '戌时', '亥时', '晚子时']

interface IztroStar {
  name: string
  brightness?: string
  mutagen?: string
}

// iztro 星对象（StructuralAstrolabe 运行时形状；仅取所需字段）
function pickStars(stars: Array<{ name: string; brightness?: string; mutagen?: string }> | undefined): ZiweiStar[] {
  if (!stars) return []
  return stars.map((s) => ({
    name: s.name,
    ...(s.brightness ? { brightness: s.brightness } : {}),
    ...(s.mutagen ? { mutagen: s.mutagen } : {}),
  }))
}

/** 生年四化固定顺序 */
const MUTAGEN_ORDER = ['禄', '权', '科', '忌']

/** 计算紫微斗数盘（golden 测试入口） */
export function computeZiwei(input: BirthInput): ZiweiResult {
  const { lunar, corrected, warnings, correction } = toLunar(input)
  const t = parseDateTime(corrected, '校正后时间')
  const ti = timeToIndex(t.hh, t.mm)
  const genderLabel = input.gender === 'male' ? '男' : '女'

  let chart: ReturnType<typeof astro.bySolar>
  try {
    // 走公历入口（农历已在 toLunar 中转为公历 + 校验）；fixLeap=true 按通行口径
    const solar = lunar.getSolar()
    const solarStr = `${solar.getYear()}-${solar.getMonth()}-${solar.getDay()}`
    chart = astro.bySolar(solarStr, ti, genderLabel, true, 'zh-CN')
  } catch (err) {
    throw new PanError(`紫微排盘失败：${err instanceof Error ? err.message : String(err)}`, '请核对出生日期与时辰后在重试；如仍失败请反馈该案例')
  }

  // 当前大限宫（按当前虚岁落入；出生年按公历年计）
  const birthYear = Number(chart.solarDate.split('-')[0])
  const nominalAge = new Date().getFullYear() - birthYear + 1

  const palaces: ZiweiPalace[] = chart.palaces.map((p) => ({
    name: p.name,
    heavenlyStem: p.heavenlyStem,
    earthlyBranch: p.earthlyBranch,
    isSoulPalace: p.name === '命宫',
    isBodyPalace: p.isBodyPalace === true,
    majorStars: pickStars(p.majorStars as unknown as IztroStar[]),
    minorStars: pickStars(p.minorStars as unknown as IztroStar[]),
    adjectiveStars: (p.adjectiveStars ?? []).map((s) => s.name),
    changSheng: p.changsheng12 ?? '',
    decadalRange: [p.decadal.range[0], p.decadal.range[1]] as [number, number],
    isCurrentDecadal: nominalAge >= p.decadal.range[0] && nominalAge <= p.decadal.range[1],
  }))

  const ref = (name: string, ganZhi: string): ZiweiPalaceRef => ({ name, ganZhi })
  const soulPalace = palaces.find((p) => p.isSoulPalace)
  const bodyPalace = palaces.find((p) => p.isBodyPalace)
  const laiYinRaw = chart.palaces.find(
    (p) => (p as unknown as { isOriginalPalace?: boolean }).isOriginalPalace === true,
  )

  // 生年四化收集（主星 + 辅星；按禄权科忌排序）
  const collected: Record<string, string[]> = {}
  for (const p of chart.palaces) {
    for (const s of [...p.majorStars, ...p.minorStars]) {
      if (s.mutagen) (collected[s.mutagen] ??= []).push(s.name)
    }
  }
  const mutagenStars = MUTAGEN_ORDER.filter((m) => (collected[m]?.length ?? 0) > 0).map((m) => ({
    mutagen: m,
    stars: collected[m]!,
  }))

  return {
    input: {
      birth: input.birth,
      calendar: input.calendar === 'solar' ? '公历' : `农历${input.isLeapMonth ? '（闰月）' : ''}`,
      gender: genderLabel,
      corrected,
      correction,
    },
    solar: `${chart.solarDate}`,
    lunar: `${chart.lunarDate}`,
    chineseDate: `${chart.chineseDate}`,
    zodiac: `${chart.zodiac}`,
    sign: `${chart.sign}`,
    timeLabel: TIME_LABEL[ti] ?? chart.time,
    timeRange: chart.timeRange,
    fiveElementsClass: chart.fiveElementsClass,
    soul: chart.soul,
    body: chart.body,
    soulPalace: soulPalace ? ref(soulPalace.name, `${soulPalace.heavenlyStem}${soulPalace.earthlyBranch}`) : ref('', ''),
    bodyPalace: bodyPalace ? ref(bodyPalace.name, `${bodyPalace.heavenlyStem}${bodyPalace.earthlyBranch}`) : ref('', ''),
    laiYinPalace: laiYinRaw ? ref(laiYinRaw.name, `${laiYinRaw.heavenlyStem}${laiYinRaw.earthlyBranch}`) : null,
    mutagenStars,
    palaces,
    warnings,
  }
}
