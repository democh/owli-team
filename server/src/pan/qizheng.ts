/**
 * M63-E：七政四余计算（astronomy-engine 星历 + 四余近似）。
 *
 * 口径（设计 docs/metaphysics-deepening-design.md 附录 A.4，卡面固定声明）：
 * - 七政：太阳 / 太阴 / 水 / 金 / 火 / 木 / 土（黄经、落宫、逆行，与本命盘同源算法）；
 * - 四余：罗睺 = 月球平升交点 Ω、计都 = Ω+180°（Meeus 平根数，恒逆行）、
 *   月孛 = 月球平远地点（近地点平根数 + 180°，恒逆行）、紫炁 = 古法线性（28 年周天，1984-02-02 甲子历元锚定，争议口径）；
 * - 十二宫：回归黄道十二宫（戌宫 = 白羊起，黄经 30° 分界即中气过宫）；
 *   命宫 = 太阳宫 +（生时 − 卯）（「太阳过宫·生时推移」，卯时同太阳宫）；十二宫自命宫起逆布；
 * - 宫主：按宫位古典守护（戌白羊→火星…）；庙旺：中法（宫位）常见表锁定。
 * 版本边界：v1 不列二十八宿度（口径声明）；四余每行显式标注近似等级。
 */
import * as Astronomy from 'astronomy-engine'
import { BODIES, bodyLon, computeNatal, norm360, type NatalInput } from './natal.js'
import { PanError, parseDateTime } from './types.js'

/** 宫支（黄经序：0 = 黄经 [0,30) = 戌宫/白羊 —— 春分后入戌宫的回归黄道口径） */
const GONG_ZHI = ['戌', '酉', '申', '未', '午', '巳', '辰', '卯', '寅', '丑', '子', '亥'] as const
/** 黄经序 → 星座名（与宫支一一对应） */
const GONG_SIGN = ['白羊', '金牛', '双子', '巨蟹', '狮子', '处女', '天秤', '天蝎', '射手', '摩羯', '水瓶', '双鱼'] as const
/** 宫主（古典守护；中法名称） */
const GONG_LORD = ['火星', '金星', '水星', '太阴', '太阳', '水星', '金星', '火星', '木星', '土星', '土星', '木星'] as const
/** 十二宫名（命宫起，逆布序） */
const PALACE_NAMES = ['命宫', '财帛', '兄弟', '田宅', '男女', '奴仆', '夫妻', '疾厄', '迁移', '官禄', '福德', '相貌'] as const
/** 七政显示名（BODIES 名 → 中法名） */
const QIZHENG_NAME: Record<string, string> = { 太阳: '太阳', 月亮: '太阴', 水星: '水星', 金星: '金星', 火星: '火星', 木星: '木星', 土星: '土星' }
/** 庙旺（中法宫位表锁定） */
const MIAO_WANG: Array<{ star: string; miao?: string; wang?: string }> = [
  { star: '太阳', miao: '戌', wang: '巳' },
  { star: '太阴', miao: '亥', wang: '酉' },
  { star: '木星', miao: '寅', wang: '未' },
  { star: '火星', miao: '卯', wang: '午' },
  { star: '土星', miao: '丑', wang: '寅' },
  { star: '金星', miao: '酉', wang: '申' },
  { star: '水星', miao: '申', wang: '巳' },
]

const DAY = 86_400_000

export interface QizhengBody {
  name: string
  lon: number
  /** 落宫支（如「酉」） */
  gong: string
  /** 宫内度数 */
  degInGong: number
  retro: boolean
  /** 近似等级标注（四余） */
  note?: string
}

export interface QizhengPalace {
  name: string
  gong: string
  sign: string
  lord: string
  bodies: string[]
}

export interface QizhengResult {
  input: { birth: string; timezone: string; latitude: number; longitude: number }
  /** 七政 7 + 四余 4 = 11 */
  bodies: QizhengBody[]
  /** 命宫宫支（如「戌」） */
  mingGong: string
  palaces: QizhengPalace[]
  miaoWang: Array<{ star: string; miao?: string; wang?: string }>
  warnings: string[]
}

const gongOf = (lon: number): { gong: string; degInGong: number; bin: number } => {
  const l = norm360(lon)
  const bin = Math.floor(l / 30)
  return { gong: GONG_ZHI[bin]!, degInGong: l - bin * 30, bin }
}

/** 计算七政四余盘（golden 测试入口） */
export function computeQizheng(input: NatalInput): QizhengResult {
  const t = parseDateTime(input.birth, '出生时间')
  // 本命（校验时区 / 经纬度并取 UTC）
  const natal = computeNatal(input)
  const utcMs = Date.parse(`${natal.utc.replace(' ', 'T')}:00Z`)
  if (!Number.isFinite(utcMs)) throw new PanError('UTC 时刻解析失败', '请反馈该案例')
  const time = Astronomy.MakeTime(new Date(utcMs))
  const jdTT = time.tt + 2451545.0
  const T = (jdTT - 2451545.0) / 36525

  // 七政（与本命盘同源；月亮显示名「太阴」）
  const bodies: QizhengBody[] = BODIES.slice(0, 7).map((spec) => {
    const l0 = bodyLon(spec, time)
    const lPrev = bodyLon(spec, Astronomy.MakeTime(new Date(utcMs - DAY)))
    const dNorm = ((l0 - lPrev + 540) % 360) - 180
    const { gong, degInGong } = gongOf(l0)
    return {
      name: QIZHENG_NAME[spec.name] ?? spec.name,
      lon: l0,
      gong,
      degInGong,
      retro: dNorm < 0,
    }
  })

  // 四余（近似分级声明）
  const Omega = norm360(
    125.0445479 - 1934.1362891 * T + 0.0020754 * T * T + (T * T * T) / 467441 - (T * T * T * T) / 60616000,
  )
  const Pi = norm360(
    83.3532465 + 4069.0137287 * T - 0.01032 * T * T - (T * T * T) / 80053 + (T * T * T * T) / 18999000,
  )
  // 紫炁：古法线性（28 年周天；甲子历元 1984-02-02 起 0°，争议口径）
  const ms1984 = Date.UTC(1984, 1, 2)
  const daysSince = (utcMs - ms1984) / DAY
  const ziQi = norm360(daysSince * (360 / (28 * 365.2422)))
  const quartet: QizhengBody[] = [
    { name: '罗睺', lon: Omega, ...gongOf(Omega), retro: true, note: '近似：平交点 · 逆行' },
    { name: '计都', lon: norm360(Omega + 180), ...gongOf(norm360(Omega + 180)), retro: true, note: '近似：平交点 · 逆行' },
    { name: '月孛', lon: norm360(Pi + 180), ...gongOf(norm360(Pi + 180)), retro: true, note: '近似：平远地点 · 逆行' },
    { name: '紫炁', lon: ziQi, ...gongOf(ziQi), retro: false, note: '近似：古法线性 · 争议口径' },
  ]
  bodies.push(...quartet)

  // 命宫：太阳宫 +（生时 − 卯）（「太阳过宫·生时推移」；卯时同太阳宫）
  const sunBin = gongOf(bodies[0]!.lon).bin
  const hIdx = Math.floor(((t.hh + 1) % 24) / 2) // 时支序（子 0 … 亥 11）
  const mingBin = (sunBin + hIdx - 3 + 24) % 12
  const mingGong = GONG_ZHI[mingBin]!

  // 十二宫（命宫起逆布？——中法十二宫自命宫起沿黄经序顺布（戌→酉→… 与地支逆序一致））
  const palaces: QizhengPalace[] = PALACE_NAMES.map((name, k) => {
    const bin = (mingBin + k) % 12
    const gong = GONG_ZHI[bin]!
    return {
      name,
      gong,
      sign: GONG_SIGN[bin]!,
      lord: GONG_LORD[bin]!,
      bodies: bodies.filter((b) => b.gong === gong).map((b) => b.name),
    }
  })

  return {
    input: {
      birth: input.birth,
      timezone: input.timezone,
      latitude: input.latitude,
      longitude: input.longitude,
    },
    bodies,
    mingGong,
    palaces,
    miaoWang: MIAO_WANG,
    warnings: [
      `命宫 ${mingGong}（太阳过宫·生时推移；卯时同太阳宫）`,
      '口径：回归黄道十二宫·中气过宫·四余近似（罗计平交点 / 月孛平远地点 / 紫炁古法）；v1 不列二十八宿度',
    ],
  }
}
