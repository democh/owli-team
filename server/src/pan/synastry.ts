/**
 * M63-B：合盘（synastry_pan）——双盘 cross-aspects（交角矩阵）+ 组合盘中点盘（mode=composite）。
 *
 * 口径（设计 docs/metaphysics-deepening-design.md 附录 A.6）：
 * - cross-aspects：A 十星 × B 十星 + A 星 × B 四轴 + B 星 × A 四轴；仅主相位；orb ≤ 8°；
 *   对称去重（同一星对只出一行）；按 orb 升序；
 * - 组合盘：各对行星黄经短弧中点（只做行星中点盘；组合宫位流派歧义大，v1 显式不提供）；
 * - 元素互补：双方各自计数 + 一方 ≤1 且另一方 ≥3 的元素标注；
 * - 合规：卡面含知情声明行（本盘仅基于双方出生数据的关系模式参考）。
 */
import {
  computeNatal,
  norm360,
  signOf,
  type NatalElement,
  type NatalMode,
  type NatalPlanet,
  type NatalResult,
} from './natal.js'
import { PanError } from './types.js'

const SYNASTRY_ASPECTS: Array<{ type: string; angle: number }> = [
  { type: '合相', angle: 0 },
  { type: '六合', angle: 60 },
  { type: '刑相', angle: 90 },
  { type: '拱相', angle: 120 },
  { type: '对分', angle: 180 },
]
const SYNASTRY_ORB = 8

export interface SynastryPersonInput {
  birth: string
  timezone: string
  latitude: number
  longitude: number
  /** 展示名（如「A」；缺省按 A / B 排位） */
  label?: string
}

export interface SynastryAspectHit {
  aPlanet: string
  bPlanet: string
  type: string
  orb: number
}

export interface SynastryInput {
  a: SynastryPersonInput
  b: SynastryPersonInput
  mode?: 'cross' | 'composite'
}

export interface SynastryResult {
  a: {
    label: string
    input: { birth: string; timezone: string; latitude: number; longitude: number }
    planets: NatalPlanet[]
    angles: { asc: number; mc: number; dsc: number; ic: number }
    elements: Record<NatalElement, number>
    modes: Record<NatalMode, number>
  }
  b: SynastryResult['a']
  aspects: SynastryAspectHit[]
  composite: Array<{ name: string; lon: number; sign: string; degInSign: number }> | null
  /** 元素互补（一方 ≤1 且另一方 ≥3 的元素中文名） */
  complement: string[]
  warnings: string[]
}

/** 最短带符号角差（a - b，归一化到 (-180, 180]） */
function signedDiff(a: number, b: number): number {
  return ((a - b + 540) % 360) - 180
}

const ELEMENT_CN: Record<NatalElement, string> = { fire: '火', earth: '土', air: '风', water: '水' }

function personOf(r: NatalResult, label: string): SynastryResult['a'] {
  return {
    label,
    input: {
      birth: r.input.birth,
      timezone: r.input.timezone,
      latitude: r.input.latitude,
      longitude: r.input.longitude,
    },
    planets: r.planets,
    angles: r.angles,
    elements: r.elements,
    modes: r.modes,
  }
}

/** 计算合盘（golden 测试入口） */
export function computeSynastry(input: SynastryInput): SynastryResult {
  const ra = computeNatal({
    birth: input.a.birth,
    timezone: input.a.timezone,
    latitude: input.a.latitude,
    longitude: input.a.longitude,
  })
  const rb = computeNatal({
    birth: input.b.birth,
    timezone: input.b.timezone,
    latitude: input.b.latitude,
    longitude: input.b.longitude,
  })
  const warnings: string[] = [...ra.warnings.map((w) => `A：${w}`), ...rb.warnings.map((w) => `B：${w}`)]

  const aPoints: Array<{ name: string; lon: number; side: 'a' }> = ra.planets.map((p) => ({ name: p.name, lon: p.lon, side: 'a' as const }))
  const bPoints = rb.planets.map((p) => ({ name: p.name, lon: p.lon, side: 'b' as const }))
  const aAxes = [
    { name: 'ASC', lon: ra.angles.asc },
    { name: 'MC', lon: ra.angles.mc },
    { name: 'DSC', lon: ra.angles.dsc },
    { name: 'IC', lon: ra.angles.ic },
  ]
  const bAxes = [
    { name: 'ASC', lon: rb.angles.asc },
    { name: 'MC', lon: rb.angles.mc },
    { name: 'DSC', lon: rb.angles.dsc },
    { name: 'IC', lon: rb.angles.ic },
  ]

  // cross-aspects：A 星 × B 星 + A 星 × B 四轴 + B 星 × A 四轴
  // 命名协议（卡面直用）：星名带侧前缀（A太阳 / B月亮 / BASC / AASC）——天然消歧；
  // 对称去重：以星对（排序后）为键，同一对只出一行
  const seen = new Set<string>()
  const aspects: SynastryAspectHit[] = []
  const addPair = (aName: string, aLon: number, bName: string, bLon: number): void => {
    const key = [aName, bName].sort().join('|')
    if (seen.has(key)) return
    const diff = Math.abs(signedDiff(aLon, bLon))
    for (const def of SYNASTRY_ASPECTS) {
      const orb = Math.abs(diff - def.angle)
      if (orb <= SYNASTRY_ORB) {
        aspects.push({ aPlanet: aName, bPlanet: bName, type: def.type, orb: Math.round(orb * 100) / 100 })
        seen.add(key)
        break
      }
    }
  }
  for (const ap of aPoints) {
    for (const bp of bPoints) addPair(`A${ap.name}`, ap.lon, `B${bp.name}`, bp.lon)
  }
  for (const ap of aPoints) {
    for (const bx of bAxes) addPair(`A${ap.name}`, ap.lon, `B${bx.name}`, bx.lon)
  }
  for (const bp of bPoints) {
    for (const ax of aAxes) addPair(`B${bp.name}`, bp.lon, `A${ax.name}`, ax.lon)
  }
  aspects.sort((x, y) => x.orb - y.orb)

  // 组合盘（短弧中点；只做行星）
  let composite: SynastryResult['composite'] = null
  if (input.mode === 'composite') {
    composite = ra.planets.map((pa, i) => {
      const pb = rb.planets[i]!
      // 短弧中点：从 pa 出发沿最短弧到 pb 的中点
      const mid = norm360(pa.lon + signedDiff(pb.lon, pa.lon) / 2)
      const { sign, deg } = signOf(mid)
      return { name: pa.name, lon: mid, sign, degInSign: deg }
    })
  }

  // 元素互补（一方 ≤1 且另一方 ≥3）
  const complement: string[] = []
  const keys: NatalElement[] = ['fire', 'earth', 'air', 'water']
  if (ra.planets.length > 0 && rb.planets.length > 0) {
    for (const k of keys) {
      const av = ra.elements[k]
      const bv = rb.elements[k]
      if ((av <= 1 && bv >= 3) || (bv <= 1 && av >= 3)) complement.push(ELEMENT_CN[k])
    }
  }

  return {
    a: personOf(ra, input.a.label ?? 'A'),
    b: personOf(rb, input.b.label ?? 'B'),
    aspects,
    composite,
    complement,
    warnings,
  }
}

/** 合盘输入校验辅助（工具层复用）：时区必填等由 computeNatal 抛出 PanError */
export function assertSynastryInput(input: SynastryInput): void {
  if (!input.a?.birth || !input.b?.birth) {
    throw new PanError('合盘必须提供双方出生数据（a / b）', '双方各自需要 birth + timezone + latitude + longitude')
  }
}
