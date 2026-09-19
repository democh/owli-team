/**
 * M63-B golden：行运盘（transit_pan）与合盘（synastry_pan）。
 *
 * 基准：本命 1990-05-12 14:30 Asia/Shanghai 31.23N/121.47E（与 m51/m63 同源）；
 * 行运 at 固定 → 全量确定性锁值；扫描窗口固定 → 时点序列确定性。
 */
import { describe, expect, it } from 'vitest'
import { computeSynastry } from '../src/pan/synastry.js'
import { computeTransit } from '../src/pan/transit.js'
import { PanError } from '../src/pan/types.js'

const NATAL = {
  birth: '1990-05-12 14:30',
  timezone: 'Asia/Shanghai',
  latitude: 31.23,
  longitude: 121.47,
}

describe('M63-B golden：行运盘（transit_pan）', () => {
  const r = computeTransit({
    ...NATAL,
    at: '2026-11-05 14:30',
    scanFrom: '2026-01',
    scanTo: '2026-12',
  })

  it('① 行运行星（锁定值 + 落本命宫 + 逆行旗标）', () => {
    const sun = r.planets.find((p) => p.name === '太阳')!
    expect(sun.sign).toBe('天蝎')
    expect(sun.degInSign).toBeCloseTo(12.85, 2)
    expect(sun.lon).toBeCloseTo(222.85, 2)
    expect(sun.retrograde).toBe(false)
    const merc = r.planets.find((p) => p.name === '水星')!
    expect(merc.retrograde).toBe(true)
    expect(r.planets).toHaveLength(10)
    expect(r.planets.every((p) => p.house >= 1 && p.house <= 12)).toBe(true)
  })

  it('② cross-aspects：orb ≤ 6、按 orb 升序、锁定首条', () => {
    expect(r.aspects.length).toBeGreaterThan(10)
    for (const a of r.aspects) {
      expect(a.orb).toBeLessThanOrEqual(6)
    }
    const orbs = r.aspects.map((a) => a.orb)
    expect(orbs).toEqual([...orbs].sort((x, y) => x - y))
    expect(r.aspects[0]).toEqual({ transitPlanet: '土星', natalPoint: '金星', type: '合相', orb: 0.07 })
  })

  it('③ 扫描：时点序列（时间序 + 格式 + 非月亮×四轴 + 影响窗）', () => {
    expect(r.scan).not.toBeNull()
    const hits = r.scan!.hits
    expect(hits.length).toBeGreaterThan(5)
    for (const h of hits) {
      expect(h.exact).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
      expect(h.windowDays).toBe(14)
    }
    // 时间序
    const times = hits.map((h) => h.exact)
    expect(times).toEqual([...times].sort())
    // 月亮 × 四轴被排除（高频噪声）
    expect(hits.some((h) => h.transitPlanet === '月亮' && ['ASC', 'MC', 'DSC', 'IC'].includes(h.natalPoint))).toBe(false)
    // 首条锁定（确定性）
    expect(hits[0]!.transitPlanet).toBe('木星')
  })

  it('④ 结构化错误：缺时区 / 扫描窗口不配对', () => {
    expect(() => computeTransit({ ...NATAL, timezone: '', at: '2026-11-05 14:30' })).toThrow(PanError)
    expect(() =>
      computeTransit({ ...NATAL, at: '2026-11-05 14:30', scanFrom: '2026-01' }),
    ).toThrow(/同时提供/)
    expect(() =>
      computeTransit({ ...NATAL, at: '2026-11-05 14:30', scanFrom: '2026-12', scanTo: '2026-01' }),
    ).toThrow(/终点/)
  })

  it('⑤ 无扫描参数 → scan null（单时刻盘）', () => {
    const single = computeTransit({ ...NATAL, at: '2026-11-05 14:30' })
    expect(single.scan).toBeNull()
    expect(single.aspects.length).toBeGreaterThan(0)
  })
})

describe('M63-B golden：合盘（synastry_pan）', () => {
  const A = NATAL
  const B = { birth: '1992-09-03 08:10', timezone: 'Asia/Shanghai', latitude: 31.23, longitude: 121.47 }
  const r = computeSynastry({ a: A, b: B, mode: 'composite' })

  it('① cross-aspects：orb ≤ 8、按 orb 升序、命名带侧前缀、对称去重', () => {
    expect(r.aspects.length).toBeGreaterThan(10)
    for (const a of r.aspects) {
      expect(a.orb).toBeLessThanOrEqual(8)
      expect(a.aPlanet).toMatch(/^[AB]/)
      expect(a.bPlanet).toMatch(/^[AB]/)
    }
    const orbs = r.aspects.map((a) => a.orb)
    expect(orbs).toEqual([...orbs].sort((x, y) => x - y))
    // 对称去重：星对键唯一
    const keys = r.aspects.map((a) => [a.aPlanet, a.bPlanet].sort().join('|'))
    expect(new Set(keys).size).toBe(keys.length)
    // 锁定首条
    expect(r.aspects[0]!.aPlanet).toBe('A冥王星')
    expect(r.aspects[0]!.bPlanet).toBe('B海王星')
    expect(r.aspects[0]!.orb).toBeCloseTo(0.08, 2)
  })

  it('② 交换 A/B → 镜像相位集（先对 r1 做侧互换再比对 r2）', () => {
    const swapped = computeSynastry({ a: B, b: A, mode: 'cross' })
    const swapName = (n: string): string => (n.startsWith('A') ? `B${n.slice(1)}` : n.startsWith('B') ? `A${n.slice(1)}` : n)
    const fmt = (list: typeof r.aspects): string[] =>
      list.map((a) => [[a.aPlanet, a.bPlanet].sort().join('-'), a.type, a.orb.toFixed(2)].join('|')).sort()
    const mirrored = r.aspects.map((a) => ({ aPlanet: swapName(a.aPlanet), bPlanet: swapName(a.bPlanet), type: a.type, orb: a.orb }))
    expect(fmt(swapped.aspects)).toEqual(fmt(mirrored))
  })

  it('③ 组合盘：短弧中点（锁定值）', () => {
    expect(r.composite).toHaveLength(10)
    const sun = r.composite!.find((p) => p.name === '太阳')!
    expect(sun.sign).toBe('巨蟹')
    expect(sun.degInSign).toBeCloseTo(16.0, 1)
  })

  it('④ 元素互补（A 风0 / B 风3 → 互补 风）', () => {
    expect(r.a.elements.air).toBe(0)
    expect(r.b.elements.air).toBe(3)
    expect(r.complement).toEqual(['风'])
  })

  it('⑤ 缺时区 → 结构化错误', () => {
    expect(() => computeSynastry({ a: { ...A, timezone: '' }, b: B })).toThrow(PanError)
  })
})
