/**
 * M51-E：西方星盘计算（astronomy-engine + 自研宫位 / 相位算法）。
 *
 * - 时间：显式时区（IANA 名）→ UTC；缺时区直接拒绝（design §6.2 精度约定）；
 * - 行星：日 / 月 / 水 / 金 / 火 / 木 / 土 / 天 / 海 / 冥（黄经 + 星座度数 + 逆行）；
 * - 宫位：Placidus（不动点迭代，高纬 / 不收敛 → 降级等宫制 + 告警）或 Equal；
 * - 相位：主相位 0/60/90/120/180（合冲 orb 8°、刑拱 6°、六合 4°）。
 */
import * as Astronomy from 'astronomy-engine'
import { PanError, parseDateTime } from './types.js'

const DEG = Math.PI / 180
const RAD = 180 / Math.PI

export function norm360(x: number): number {
  const v = x % 360
  return v < 0 ? v + 360 : v
}

/** 黄经 → 星座 + 度（星座表 0=白羊） */
export const ZODIAC_SIGNS = [
  '白羊', '金牛', '双子', '巨蟹', '狮子', '处女', '天秤', '天蝎', '射手', '摩羯', '水瓶', '双鱼',
] as const

export function signOf(lon: number): { sign: string; deg: number } {
  const l = norm360(lon)
  const idx = Math.floor(l / 30)
  return { sign: ZODIAC_SIGNS[idx] ?? '白羊', deg: l - idx * 30 }
}

/** 时区偏移（分钟；对给定 UTC 时刻该时区的偏移，用 Intl 反推，DST 两次迭代收敛） */
export function tzOffsetMinutes(timezone: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const parts = dtf.formatToParts(new Date(utcMs))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0')
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  return Math.round((asUtc - utcMs) / 60_000)
}

/** 本地时刻（含 IANA 时区）→ UTC 毫秒（两次迭代处理 DST 边界） */
export function localToUtcMs(timezone: string, y: number, m: number, d: number, hh: number, mm: number): number {
  const guessLocal = Date.UTC(y, m - 1, d, hh, mm)
  let offset = tzOffsetMinutes(timezone, guessLocal)
  let utc = guessLocal - offset * 60_000
  offset = tzOffsetMinutes(timezone, utc)
  utc = guessLocal - offset * 60_000
  return utc
}

export interface NatalPlanet {
  name: string
  lon: number
  sign: string
  degInSign: number
  house: number
  retrograde: boolean
}

export interface NatalAspect {
  p1: string
  p2: string
  type: string
  orb: number
}

/** 四元素（火 / 土 / 风 / 水；星座序 0=白羊 每 4 循环） */
export type NatalElement = 'fire' | 'earth' | 'air' | 'water'
/** 三模式（基本 / 固定 / 变动；星座序 0=白羊 每 3 循环） */
export type NatalMode = 'cardinal' | 'fixed' | 'mutable'

export interface NatalResult {
  input: { birth: string; timezone: string; latitude: number; longitude: number; houseSystem: string }
  utc: string
  houseSystem: 'placidus' | 'equal'
  planets: NatalPlanet[]
  /** 12 宫头黄经（索引 0 = 第 1 宫头 = ASC） */
  cusps: number[]
  angles: { asc: number; mc: number; dsc: number; ic: number }
  aspects: NatalAspect[]
  /** 元素分布（按十大行星落座计数） */
  elements: Record<NatalElement, number>
  /** 三模式分布（按十大行星落座计数） */
  modes: Record<NatalMode, number>
  warnings: string[]
}

/** 星盘输入（仅公历；时区必须显式） */
export interface NatalInput {
  /** 公历出生时刻 'YYYY-MM-DD HH:mm'（当地钟表时间） */
  birth: string
  /** IANA 时区名（必填；不做缺省猜测） */
  timezone: string
  /** 出生地纬度（-90~90） */
  latitude: number
  /** 出生地经度（东经为正，-180~180） */
  longitude: number
  /** 宫位制（默认 placidus；高纬 / 不收敛时降级 equal） */
  houseSystem?: 'placidus' | 'equal'
}

export interface BodySpec {
  name: string
  body?: Astronomy.Body
  kind: 'sun' | 'moon' | 'planet'
}

export const BODIES: BodySpec[] = [
  { name: '太阳', kind: 'sun' },
  { name: '月亮', kind: 'moon' },
  { name: '水星', kind: 'planet', body: Astronomy.Body.Mercury },
  { name: '金星', kind: 'planet', body: Astronomy.Body.Venus },
  { name: '火星', kind: 'planet', body: Astronomy.Body.Mars },
  { name: '木星', kind: 'planet', body: Astronomy.Body.Jupiter },
  { name: '土星', kind: 'planet', body: Astronomy.Body.Saturn },
  { name: '天王星', kind: 'planet', body: Astronomy.Body.Uranus },
  { name: '海王星', kind: 'planet', body: Astronomy.Body.Neptune },
  { name: '冥王星', kind: 'planet', body: Astronomy.Body.Pluto },
]

export function bodyLon(spec: BodySpec, time: Astronomy.AstroTime): number {
  if (spec.kind === 'sun') return norm360(Astronomy.SunPosition(time).elon)
  if (spec.kind === 'moon') return norm360(Astronomy.EclipticGeoMoon(time).lon)
  const vec = Astronomy.GeoVector(spec.body!, time, true)
  return norm360(Astronomy.Ecliptic(vec).elon)
}

/** 黄赤交角（度；IAU 近似） */
function obliquity(jd: number): number {
  const T = (jd - 2451545.0) / 36525
  return 23.4392911 - 0.0130042 * T
}

/** 赤经 → 黄经（度） */
function raToLon(ra: number, eps: number): number {
  return norm360(Math.atan2(Math.sin(ra * DEG), Math.cos(ra * DEG) * Math.cos(eps * DEG)) * RAD)
}

/** 归一化到与参考角最近的等价角（差 ∈ (-180, 180]） */
function unwrapNear(x: number, ref: number): number {
  let v = x
  while (v - ref > 180) v -= 360
  while (v - ref <= -180) v += 360
  return v
}

/** 单点半弧（度）：H_semi = acos(−tan φ tan δ)；|高纬无定义| → NaN */
function semiArc(lon: number, eps: number, lat: number): number {
  const dec = Math.asin(Math.sin(eps * DEG) * Math.sin(lon * DEG)) * RAD
  const c = -Math.tan(lat * DEG) * Math.tan(dec * DEG)
  if (c <= -1 || c >= 1) return NaN
  return Math.acos(c) * RAD
}

/**
 * Placidus 中间宫头（不动点迭代）。
 * tgt 为「目标时角（西向为正）」：宫 11 → −SA/3；宫 12 → −2SA/3；
 * 宫 2 → −180 + 2(180−SA)/3（离 ASC 近）；宫 3 → −180 + (180−SA)/3（离 IC 近）。
 */
function placidusCusp(
  ramc: number,
  eps: number,
  lat: number,
  tgtKind: 11 | 12 | 2 | 3,
  seed: number,
): number {
  let lon = norm360(seed)
  for (let i = 0; i < 60; i++) {
    const sa = semiArc(lon, eps, lat)
    if (!Number.isFinite(sa)) return NaN
    const tgt =
      tgtKind === 11 ? -sa / 3
      : tgtKind === 12 ? (-2 * sa) / 3
      : tgtKind === 2 ? -180 + (2 * (180 - sa)) / 3
      : -180 + (180 - sa) / 3
    const raReq = norm360(ramc - tgt)
    // 赤经 → 黄经（选与当前 lon 同支的值）
    const cand = raToLon(raReq, eps)
    const next = unwrapNear(cand, lon)
    if (Math.abs(next - lon) < 1e-10) return norm360(next)
    lon = next
  }
  return norm360(lon)
}

/** 等宫制宫头（兜底） */
function equalCusps(asc: number): number[] {
  return Array.from({ length: 12 }, (_, i) => norm360(asc + i * 30))
}

export const ASPECT_DEFS: Array<{ type: string; angle: number; orb: number }> = [
  { type: '合相', angle: 0, orb: 8 },
  { type: '六合', angle: 60, orb: 4 },
  { type: '刑相', angle: 90, orb: 6 },
  { type: '拱相', angle: 120, orb: 6 },
  { type: '对分', angle: 180, orb: 8 },
]

/** 行星落宫（1-12；按宫头区间，支持跨 0°） */
export function houseOf(lon: number, cusps: number[]): number {
  for (let i = 0; i < 12; i++) {
    const a = cusps[i]!
    const b = cusps[(i + 1) % 12]!
    const span = norm360(b - a)
    const rel = norm360(lon - a)
    if (rel < span) return i + 1
  }
  return 12
}

/** 计算西方星盘（golden 测试入口） */
export function computeNatal(input: NatalInput): NatalResult {
  if (!input.timezone || typeof input.timezone !== 'string') {
    throw new PanError('星盘计算必须显式提供时区（timezone）', '请补充 IANA 时区名（如 Asia/Shanghai）后重试；星盘不做时区缺省猜测')
  }
  if (!Number.isFinite(input.latitude) || !Number.isFinite(input.longitude)) {
    throw new PanError('星盘计算必须提供出生地经纬度（latitude / longitude）', '请补充纬度（-90~90）与经度（-180~180，东经为正）')
  }
  const { latitude: lat, longitude: lon } = input
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new PanError(`经纬度越界：lat=${lat} lon=${lon}`, '纬度 [-90,90]、经度 [-180,180]（东经为正）')
  }
  const t = parseDateTime(input.birth, '出生时间')
  let utcMs: number
  try {
    utcMs = localToUtcMs(input.timezone, t.y, t.m, t.d, t.hh, t.mm)
  } catch {
    throw new PanError(`时区「${input.timezone}」无效`, '请使用 IANA 时区名（如 Asia/Shanghai / America/New_York）')
  }
  const time = Astronomy.MakeTime(new Date(utcMs))
  const warnings: string[] = []

  // 行星
  const dayMs = 86_400_000
  const planets: NatalPlanet[] = BODIES.map((spec) => {
    const l0 = bodyLon(spec, time)
    const lPrev = bodyLon(spec, Astronomy.MakeTime(new Date(utcMs - dayMs)))
    const dNorm = ((l0 - lPrev + 540) % 360) - 180
    const { sign, deg } = signOf(l0)
    return { name: spec.name, lon: l0, sign, degInSign: deg, house: 0, retrograde: dNorm < 0 }
  })

  // 宫位
  const lstHours = Astronomy.SiderealTime(time) + lon / 15
  const ramc = norm360(lstHours * 15)
  const jd = time.tt + 2451545.0 // TT 儒略日（近似用 tt 字段；精度足够宫位）
  const eps = obliquity(jd)
  const mc = norm360(Math.atan2(Math.sin(ramc * DEG), Math.cos(ramc * DEG) * Math.cos(eps * DEG)) * RAD)
  const asc = norm360(
    Math.atan2(Math.cos(ramc * DEG), -(Math.sin(ramc * DEG) * Math.cos(eps * DEG) + Math.tan(lat * DEG) * Math.sin(eps * DEG))) * RAD,
  )

  let houseSystem: 'placidus' | 'equal' = input.houseSystem ?? 'placidus'
  let cusps: number[]
  if (houseSystem === 'placidus' && Math.abs(lat) > 66) {
    warnings.push(`纬度 ${lat}° 处 Placidus 宫位制无定义（|纬度| > 66°），已降级等宫制`)
    houseSystem = 'equal'
  }
  if (houseSystem === 'equal') {
    cusps = equalCusps(asc)
  } else {
    const c11 = placidusCusp(ramc, eps, lat, 11, mc + 30)
    const c12 = placidusCusp(ramc, eps, lat, 12, mc + 60)
    const c2 = placidusCusp(ramc, eps, lat, 2, norm360(asc + 30))
    const c3 = placidusCusp(ramc, eps, lat, 3, norm360(asc + 60))
    if (![c11, c12, c2, c3].every(Number.isFinite)) {
      warnings.push('Placidus 迭代未收敛（该纬度 / 时刻组合），已降级等宫制')
      houseSystem = 'equal'
      cusps = equalCusps(asc)
    } else {
      // 1 = ASC；4 = IC；7 = DSC；10 = MC；中间宫由迭代给出（+180 得对宫）
      cusps = [
        asc,
        c2,
        c3,
        norm360(mc + 180),
        norm360(c11 + 180),
        norm360(c12 + 180),
        norm360(asc + 180),
        norm360(c2 + 180),
        norm360(c3 + 180),
        mc,
        c11,
        c12,
      ]
    }
  }

  // 行星落宫
  for (const p of planets) p.house = houseOf(p.lon, cusps)

  // 元素 / 模式分布（星座序：白羊 0 → 元素每 4 循环、模式每 3 循环）
  const elements: Record<NatalElement, number> = { fire: 0, earth: 0, air: 0, water: 0 }
  const modes: Record<NatalMode, number> = { cardinal: 0, fixed: 0, mutable: 0 }
  const ELEMENT_CYCLE: NatalElement[] = ['fire', 'earth', 'air', 'water']
  const MODE_CYCLE: NatalMode[] = ['cardinal', 'fixed', 'mutable']
  for (const p of planets) {
    const idx = Math.floor(norm360(p.lon) / 30)
    elements[ELEMENT_CYCLE[idx % 4]!] += 1
    modes[MODE_CYCLE[idx % 3]!] += 1
  }

  // 相位（仅主相位；日月含入）
  const aspects: NatalAspect[] = []
  for (let i = 0; i < planets.length; i++) {
    for (let j = i + 1; j < planets.length; j++) {
      const a = planets[i]!
      const b = planets[j]!
      const diff = Math.abs(((a.lon - b.lon + 540) % 360) - 180)
      for (const def of ASPECT_DEFS) {
        const orb = Math.abs(diff - def.angle)
        if (orb <= def.orb) {
          aspects.push({ p1: a.name, p2: b.name, type: def.type, orb: Math.round(orb * 100) / 100 })
          break
        }
      }
    }
  }

  const ic = norm360(mc + 180)
  return {
    input: {
      birth: input.birth,
      timezone: input.timezone,
      latitude: lat,
      longitude: lon,
      houseSystem: input.houseSystem ?? 'placidus',
    },
    utc: new Date(utcMs).toISOString().slice(0, 16).replace('T', ' '),
    houseSystem,
    planets,
    cusps,
    angles: { asc, mc, dsc: norm360(asc + 180), ic },
    aspects,
    elements,
    modes,
    warnings,
  }
}

/** 黄经格式化（如「双子 21.3°」） */
export function fmtLon(lon: number): string {
  const { sign, deg } = signOf(lon)
  return `${sign} ${deg.toFixed(1)}°`
}
