/**
 * M63-B：行运盘（transit_pan）——行运行星 + 行运对本命 cross-aspects + 精确时点扫描。
 *
 * 口径（设计 docs/metaphysics-deepening-design.md 附录 A.6）：
 * - cross-aspects：行运行星 → 本命十星 + 四轴（共 14 目标）；仅主相位；orb ≤ 6°（行运收紧）；按 orb 升序；
 * - 扫描：步长 1 天 + 二分细化至分钟（容差 0.01°）；相位集 = 外行星（木土天海冥）×本命十星 + 四轴、
 *   内行星（日月水金火）×本命四轴（标准行运重点，防条目爆炸）；
 * - 扫描输出为「精确时点 + 影响窗」——参考区间，不出事件断言（协议红线）。
 */
import * as Astronomy from 'astronomy-engine'
import {
  BODIES,
  bodyLon,
  computeNatal,
  houseOf,
  localToUtcMs,
  norm360,
  signOf,
  type BodySpec,
  type NatalPlanet,
} from './natal.js'
import { PanError, parseDateTime } from './types.js'

const DAY = 86_400_000
const MIN = 60_000

/** 行运相位（orb ≤ 6° 统一口径） */
const TRANSIT_ASPECTS: Array<{ type: string; angle: number }> = [
  { type: '合相', angle: 0 },
  { type: '六合', angle: 60 },
  { type: '刑相', angle: 90 },
  { type: '拱相', angle: 120 },
  { type: '对分', angle: 180 },
]
const TRANSIT_ORB = 6

/** 外行星（扫描主集）/ 内行星（仅扫四轴） */
const OUTER_NAMES = new Set(['木星', '土星', '天王星', '海王星', '冥王星'])
const AXIS_NAMES = ['ASC', 'MC', 'DSC', 'IC'] as const

export interface TransitPlanet {
  name: string
  lon: number
  sign: string
  degInSign: number
  /** 行运星落在本命第几宫 */
  house: number
  retrograde: boolean
}

export interface TransitAspectHit {
  transitPlanet: string
  natalPoint: string
  type: string
  orb: number
}

export interface TransitScanHit {
  transitPlanet: string
  natalPoint: string
  type: string
  /** 精确时点（'YYYY-MM-DD HH:mm'，当地时区） */
  exact: string
  /** 影响窗（± 天） */
  windowDays: number
}

export interface TransitInput {
  birth: string
  timezone: string
  latitude: number
  longitude: number
  /** 行运时刻 'YYYY-MM-DD HH:mm'（当地钟表时间） */
  at: string
  houseSystem?: 'placidus' | 'equal'
  /** 扫描窗口起（'YYYY-MM' 或 'YYYY-MM-DD'；给出时必须同时给 scanTo） */
  scanFrom?: string
  scanTo?: string
  /** 影响窗天数（默认 14） */
  windowDays?: number
}

export interface TransitResult {
  natal: {
    input: { birth: string; timezone: string; latitude: number; longitude: number; houseSystem: string }
    utc: string
    houseSystem: 'placidus' | 'equal'
    angles: { asc: number; mc: number; dsc: number; ic: number }
    planets: NatalPlanet[]
  }
  /** 行运时刻回显（当地钟表时间 + UTC） */
  at: string
  utc: string
  planets: TransitPlanet[]
  aspects: TransitAspectHit[]
  scan: { from: string; to: string; hits: TransitScanHit[] } | null
  warnings: string[]
}

/** 最短带符号角差（a - b，归一化到 (-180, 180]） */
function signedDiff(a: number, b: number): number {
  return ((a - b + 540) % 360) - 180
}

/** 到目标相位的带符号残差（0 = 精确相位；归一化到 (-180,180]） */
function aspectResidual(lonA: number, lonB: number, angle: number): number {
  return ((signedDiff(lonA, lonB) - angle + 540) % 360) - 180
}

/** 'YYYY-MM' 或 'YYYY-MM-DD' → 当地 0 点 UTC 毫秒 */
function monthStartToUtcMs(timezone: string, text: string): number {
  const m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(text.trim())
  if (!m) throw new PanError(`扫描窗口格式非法：「${text}」`, '请用 YYYY-MM 或 YYYY-MM-DD 格式（如 2026-01）')
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = m[3] ? Number(m[3]) : 1
  if (mo < 1 || mo > 12 || d < 1 || d > 31) throw new PanError(`扫描窗口数值越界：「${text}」`, '请检查年月日取值')
  return localToUtcMs(timezone, y, mo, d, 0, 0)
}

/** UTC 毫秒 → 当地 'YYYY-MM-DD HH:mm'（用 Intl 反推） */
function utcMsToLocal(timezone: string, utcMs: number): string {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  const parts = dtf.formatToParts(new Date(utcMs))
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}`
}

/** 计算行运盘（golden 测试入口） */
export function computeTransit(input: TransitInput): TransitResult {
  if (!input.timezone || typeof input.timezone !== 'string') {
    throw new PanError('行运盘必须显式提供时区（timezone）', '请补充 IANA 时区名（如 Asia/Shanghai）后重试')
  }
  // 本命盘（直接复用 natal 计算；含宫头与四轴）
  const natal = computeNatal({
    birth: input.birth,
    timezone: input.timezone,
    latitude: input.latitude,
    longitude: input.longitude,
    ...(input.houseSystem ? { houseSystem: input.houseSystem } : {}),
  })
  const warnings: string[] = [...natal.warnings]

  const t = parseDateTime(input.at, '行运时刻')
  const atUtc = localToUtcMs(input.timezone, t.y, t.m, t.d, t.hh, t.mm)
  const time = Astronomy.MakeTime(new Date(atUtc))

  // 行运行星（与本命同算法；逆行按日差符号）
  const planets: TransitPlanet[] = BODIES.map((spec: BodySpec) => {
    const l0 = bodyLon(spec, time)
    const lPrev = bodyLon(spec, Astronomy.MakeTime(new Date(atUtc - DAY)))
    const dNorm = ((l0 - lPrev + 540) % 360) - 180
    const { sign, deg } = signOf(l0)
    return {
      name: spec.name,
      lon: l0,
      sign,
      degInSign: deg,
      house: houseOf(l0, natal.cusps),
      retrograde: dNorm < 0,
    }
  })

  // cross-aspects：行运星 × 本命十星 + 四轴；orb ≤ 6°；按 orb 升序
  const natalPoints: Array<{ name: string; lon: number }> = [
    ...natal.planets.map((p) => ({ name: p.name, lon: p.lon })),
    { name: 'ASC', lon: natal.angles.asc },
    { name: 'MC', lon: natal.angles.mc },
    { name: 'DSC', lon: natal.angles.dsc },
    { name: 'IC', lon: natal.angles.ic },
  ]
  const aspects: TransitAspectHit[] = []
  for (const tp of planets) {
    for (const np of natalPoints) {
      const diff = Math.abs(signedDiff(tp.lon, np.lon))
      for (const def of TRANSIT_ASPECTS) {
        const orb = Math.abs(diff - def.angle)
        if (orb <= TRANSIT_ORB) {
          aspects.push({ transitPlanet: tp.name, natalPoint: np.name, type: def.type, orb: Math.round(orb * 100) / 100 })
          break
        }
      }
    }
  }
  aspects.sort((a, b) => a.orb - b.orb)

  // 时点扫描（scanFrom / scanTo 成对给出）
  let scan: TransitResult['scan'] = null
  const hasFrom = typeof input.scanFrom === 'string' && input.scanFrom.trim() !== ''
  const hasTo = typeof input.scanTo === 'string' && input.scanTo.trim() !== ''
  if (hasFrom !== hasTo) {
    throw new PanError('扫描窗口必须同时提供 scanFrom 与 scanTo', '如 scanFrom: "2026-01", scanTo: "2026-12"')
  }
  if (hasFrom && hasTo) {
    const fromMs = monthStartToUtcMs(input.timezone, input.scanFrom!)
    const toMs = monthStartToUtcMs(input.timezone, input.scanTo!)
    if (toMs <= fromMs) throw new PanError('扫描窗口终点须晚于起点', '请检查 scanFrom / scanTo 取值')
    const days = Math.ceil((toMs - fromMs) / DAY)
    if (days > 732) throw new PanError(`扫描窗口过长（${days} 天）`, '单次扫描最长 2 年（732 天）；请拆分为多次')
    const windowDays = input.windowDays ?? 14

    // 扫描相位集：外行星 × （本命十星 + 四轴）、内行星 × 四轴
    // （月亮 × 四轴因每月多次的高频噪声排除，避免条目爆炸淹没外行星重点）
    const combos: Array<{ spec: BodySpec; np: { name: string; lon: number } }> = []
    for (let i = 0; i < BODIES.length; i++) {
      const spec = BODIES[i]!
      const isOuter = OUTER_NAMES.has(spec.name)
      const isMoon = spec.name === '月亮'
      for (const np of natalPoints) {
        const isAxis = (AXIS_NAMES as readonly string[]).includes(np.name)
        if (isOuter || (isAxis && !isMoon)) combos.push({ spec, np })
      }
    }

    // 预计算每日行星黄经（外行星 + 四轴扫描用内行星），减少重复计算
    const dayMs: number[] = []
    for (let ms = fromMs; ms <= toMs; ms += DAY) dayMs.push(ms)
    const usedBodies = Array.from(new Set(combos.map((c) => c.spec)))
    const lonByBodyDay = new Map<string, number[]>()
    for (const spec of usedBodies) {
      lonByBodyDay.set(
        spec.name,
        dayMs.map((ms) => bodyLon(spec, Astronomy.MakeTime(new Date(ms)))),
      )
    }

    const hits: TransitScanHit[] = []
    for (const combo of combos) {
      const lons = lonByBodyDay.get(combo.spec.name)!
      for (const def of TRANSIT_ASPECTS) {
        let prevMs = dayMs[0]!
        let prevRes = aspectResidual(lons[0]!, combo.np.lon, def.angle)
        for (let k = 1; k < dayMs.length; k++) {
          const ms = dayMs[k]!
          const res = aspectResidual(lons[k]!, combo.np.lon, def.angle)
          // 穿越检测（同号不穿越；跨 ±180 边界排除）
          if (prevRes !== 0 && res !== 0 && Math.sign(prevRes) !== Math.sign(res) && Math.abs(prevRes) < 30 && Math.abs(res) < 30) {
            // 二分细化至分钟（容差 0.01°）
            let lo = prevMs
            let hi = ms
            const loRes = prevRes
            for (let iter = 0; iter < 60 && hi - lo > MIN; iter++) {
              const mid = Math.floor((lo + hi) / 2)
              const midLon = bodyLon(combo.spec, Astronomy.MakeTime(new Date(mid)))
              const midRes = aspectResidual(midLon, combo.np.lon, def.angle)
              if (Math.abs(midRes) < 0.01) {
                lo = mid
                hi = mid
                break
              }
              if (Math.sign(midRes) === Math.sign(loRes)) lo = mid
              else hi = mid
            }
            const exactMs = Math.floor((lo + hi) / 2)
            hits.push({
              transitPlanet: combo.spec.name,
              natalPoint: combo.np.name,
              type: def.type,
              exact: utcMsToLocal(input.timezone, exactMs),
              windowDays,
            })
          }
          prevMs = ms
          prevRes = res
        }
      }
    }
    hits.sort((a, b) => (a.exact < b.exact ? -1 : a.exact > b.exact ? 1 : 0))
    // 条目上限（防爆）：按时间序截断到 40 条
    const capped = hits.slice(0, 40)
    if (hits.length > capped.length) {
      warnings.push(`扫描命中 ${hits.length} 条，按时间序截断至前 ${capped.length} 条展示`)
    }
    scan = {
      from: utcMsToLocal(input.timezone, fromMs).slice(0, 10),
      to: utcMsToLocal(input.timezone, toMs).slice(0, 10),
      hits: capped,
    }
  }

  return {
    natal: {
      input: {
        birth: natal.input.birth,
        timezone: natal.input.timezone,
        latitude: natal.input.latitude,
        longitude: natal.input.longitude,
        houseSystem: natal.input.houseSystem,
      },
      utc: natal.utc,
      houseSystem: natal.houseSystem,
      angles: natal.angles,
      planets: natal.planets,
    },
    at: input.at,
    utc: new Date(atUtc).toISOString().slice(0, 16).replace('T', ' '),
    planets,
    aspects,
    scan,
    warnings,
  }
}
