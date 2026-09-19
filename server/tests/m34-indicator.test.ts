/**
 * M34 技术指标测试：口径断言（MA/EMA/MACD/RSI/KDJ/BOLL/ATR）+ 信号生成。
 * 回归点：findCross 曾用 timestamp=0 占位导致信号日期显示 1970-01-01。
 */
import { describe, expect, it } from 'vitest'
import { computeIndicator, ema, sma, wilderSmooth } from '../src/finance/indicator.js'
import { parseCnDate } from '../src/finance/period.js'
import type { KlineBar } from '../src/finance/types.js'

const DAY = 86_400_000

/** 构造日线 bars：close 序列给定，high/low 由 close 放大/缩小生成（自 2026-01-01 起） */
function makeBars(closes: number[]): KlineBar[] {
  const start = parseCnDate('2026-01-01')
  return closes.map((close, i) => ({
    timestamp: start + i * DAY,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1000 + i,
  }))
}

describe('M34 指标基础函数', () => {
  it('sma：滑动窗口与前置 null', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4])
    expect(sma([1, 2], 3)).toEqual([null, null])
  })

  it('ema：首值取第一个数据点，α=2/(n+1)', () => {
    const out = ema([1, 2, 3], 2)
    expect(out[0]).toBe(1)
    expect(out[1]).toBeCloseTo(5 / 3, 10) // 2/3×2 + 1/3×1
    expect(out[2]).toBeCloseTo(23 / 9, 10) // 2/3×3 + 1/3×5/3
  })

  it('wilderSmooth：首值为前 n 个均值，之后递归', () => {
    const out = wilderSmooth([1, 2, 3, 4, 5], 3)
    expect(out.slice(0, 2)).toEqual([null, null])
    expect(out[2]).toBe(2) // (1+2+3)/3
    expect(out[3]).toBeCloseTo(8 / 3, 10) // (2×2+4)/3
    expect(out[4]).toBeCloseTo(31 / 9, 10) // (2×8/3+5)/3
  })
})

describe('M34 MA / EMA 指标', () => {
  it('MA：多周期输出 + 金叉信号使用真实日期（回归 1970 占位缺陷）', () => {
    // 前 25 根平盘 10，后 15 根自 10.5 起每根 +0.5：MA5 于第 26 根（i=25）上穿 MA20
    const closes = [...Array(25).fill(10), ...Array.from({ length: 15 }, (_, i) => 10.5 + i * 0.5)]
    const series = computeIndicator('MA', makeBars(closes))
    expect(series.points).toHaveLength(40)
    expect(series.points[19].values.MA5).toBeCloseTo(10, 10)
    expect(series.points[25].values.MA5).toBeCloseTo(10.1, 10) // (10×4+10.5)/5
    expect(series.points[25].values.MA20).toBeCloseTo(10.025, 10) // (10×19+10.5)/20
    // 60 周期超出数据长度被过滤
    expect(series.points[39].values.MA60).toBeUndefined()
    expect(series.signals.some((s) => s.includes('金叉') && s.includes('2026-01-26'))).toBe(true)
  })

  it('EMA：自定义周期输出（长度与 bars 一致）', () => {
    const bars = makeBars(Array.from({ length: 30 }, (_, i) => 10 + i * 0.1))
    const series = computeIndicator('EMA', bars, { period: 12 })
    expect(series.points).toHaveLength(30)
    expect(typeof series.points[29].values.EMA12).toBe('number')
  })
})

describe('M34 MACD / RSI', () => {
  it('MACD：柱 = 2×(DIF−DEA)，信号日期非 1970', () => {
    const bars = makeBars(Array.from({ length: 60 }, (_, i) => 10 + Math.sin(i / 5) * 2 + i * 0.05))
    const series = computeIndicator('MACD', bars)
    const pt = series.points[59]
    const { DIF, DEA, MACD } = pt.values
    expect(typeof DIF).toBe('number')
    expect(MACD).toBeCloseTo(((DIF as number) - (DEA as number)) * 2, 10)
    expect(series.signals.length).toBeGreaterThan(0)
    for (const s of series.signals) {
      expect(s).not.toContain('1970-01-01')
      expect(s).toMatch(/20\d\d-\d\d-\d\d/)
    }
  })

  it('RSI：单调上涨 → 100（超买信号）', () => {
    const bars = makeBars(Array.from({ length: 30 }, (_, i) => 10 + i))
    const series = computeIndicator('RSI', bars)
    expect(series.points[20].values.RSI14).toBe(100)
    expect(series.points[12].values.RSI14).toBeNull() // 期数不足
    expect(series.signals.some((s) => s.includes('超买'))).toBe(true)
  })
})

describe('M34 KDJ / BOLL / ATR', () => {
  it('KDJ：J = 3K−2D，金叉信号使用真实日期', () => {
    // 前 12 根平盘 10，随后自 11 起阶梯上涨：K 于 i=12 上穿 D
    // （只取 10 根上涨段：斜率恒定会使 RSV 缓降、后段 K 再度下穿 D 覆盖金叉）
    const closes = [...Array(12).fill(10), ...Array.from({ length: 10 }, (_, i) => 11 + i)]
    const series = computeIndicator('KDJ', makeBars(closes))
    for (const p of series.points) {
      const { K, D, J } = p.values
      if (K !== null && D !== null) expect(J).toBeCloseTo(3 * K - 2 * D, 10)
      else expect(J).toBeNull()
    }
    expect(series.signals.some((s) => s.includes('金叉') && s.includes('2026-01-13'))).toBe(true)
  })

  it('BOLL：中轨=SMA(n)，上下轨=±mult×总体标准差', () => {
    const closes = [10, 11, 10, 12, 11, 10, 11, 12, 13, 11, 10, 12, 11, 10, 11, 12, 10, 11, 12, 11, 10]
    const series = computeIndicator('BOLL', makeBars(closes))
    const i = 20
    const win = closes.slice(i - 19, i + 1)
    const mid = win.reduce((a, b) => a + b, 0) / win.length
    const sd = Math.sqrt(win.reduce((a, b) => a + (b - mid) ** 2, 0) / win.length)
    expect(series.points[i].values.MID).toBeCloseTo(mid, 10)
    expect(series.points[i].values.UPPER).toBeCloseTo(mid + 2 * sd, 10)
    expect(series.points[i].values.LOWER).toBeCloseTo(mid - 2 * sd, 10)
    expect(series.points[18].values.MID).toBeNull() // 期数不足
  })

  it('ATR：首根 TR=high−low，Wilder 平滑', () => {
    const t0 = parseCnDate('2026-09-14')
    const bars: KlineBar[] = [
      { timestamp: t0, open: 10, high: 11, low: 9, close: 10, volume: 1 },
      { timestamp: t0 + DAY, open: 10, high: 12, low: 10, close: 11, volume: 1 },
      { timestamp: t0 + 2 * DAY, open: 11, high: 11.5, low: 9, close: 9.5, volume: 1 },
    ]
    // TR = [2, 2, 2.5] → period=3 时首值 (2+2+2.5)/3
    const series = computeIndicator('ATR', bars, { period: 3 })
    expect(series.points[2].values.ATR3).toBeCloseTo(6.5 / 3, 10)
    expect(series.points[1].values.ATR3).toBeNull()
  })
})

describe('M34 指标边界', () => {
  it('空 bars：不抛错、空点位、无信号', () => {
    for (const name of ['MA', 'EMA', 'MACD', 'RSI', 'KDJ', 'BOLL', 'ATR'] as const) {
      const series = computeIndicator(name, [])
      expect(series.points).toHaveLength(0)
      expect(series.signals).toHaveLength(0)
    }
  })

  it('数据不足：全部为 null 且无信号', () => {
    const series = computeIndicator('RSI', makeBars([10, 11, 12]))
    expect(series.points.every((p) => p.values.RSI14 === null)).toBe(true)
    expect(series.signals).toHaveLength(0)
  })
})
