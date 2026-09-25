/**
 * 分析引擎内部契约（M83 §4.2）：预计算上下文 + 参数常量 + 工具函数。
 *
 * 纪律（设计稿 §4.2）：
 * - 严格回看窗口（无未来函数）；全序列指标一次 O(n) 预计算，逐根判定只做查表；
 * - 参数集中于此（ANALYSIS_PARAMS），测试直接引用，避免魔法数散落；
 * - 对外契约类型全部来自 shared（kline-contract），本文件不出对外类型。
 */
import { sma, wilderSmooth } from '../indicator.js'
import type { KlineBar } from '../types.js'

/** 分析参数常量（口径固化点；调整即全链生效，测试断言引用本体） */
export const ANALYSIS_PARAMS = {
  /** 区间分位 / 关键位回看窗口 */
  rangeWindow: 120,
  /** 摆动点窗口（左右各 n 根） */
  swingWindow: 3,
  /** 摆动点聚类容差（相对价格） */
  clusterTolerance: 0.012,
  /** 同类摆动点最短间隔（根） */
  clusterGap: 8,
  /** 地量阈值（分位 ≤） */
  dryVolumeQuantile: 0.15,
  /** 地价阈值（分位 ≤） */
  dryPriceQuantile: 0.2,
  /** 筹码集中：价格带 ± 比例 */
  chipBandPct: 0.05,
  /** 筹码集中：带内成交量占比阈值 */
  chipShare: 0.6,
  /** 平台整理：窗口（根）与振幅上限 */
  platformWindow: 20,
  platformAmplitude: 0.1,
  /** 三角形收敛：窗口（根）与收敛比阈值 */
  triangleWindow: 40,
  triangleShrink: 0.3,
  /** 箱体识别：窗口（根）/ 中带重叠比阈值 / 振幅上限 */
  boxWindowMin: 40,
  boxWindowMax: 80,
  boxOverlap: 0.6,
  boxAmplitudeMax: 0.35,
  /** 逐根回放平滑：最短段长（根） */
  minSegment: 3,
  /** 样本不足阈值（低于此值结论降级声明） */
  minBars: 60,
} as const

/** 预计算上下文（全序列一次计算，逐根判定 O(1) 查表） */
export interface AnalysisContext {
  bars: KlineBar[]
  n: number
  closes: number[]
  highs: number[]
  lows: number[]
  volumes: number[]
  ma20: Array<number | null>
  ma60: Array<number | null>
  atr14: Array<number | null>
  /** ATR / close 序列（非空点） */
  atrPct: number[]
  /** 5 日均量 / 60 日均量（量比序列） */
  volRatio: Array<number | null>
}

/** 构建上下文（全序列指标一次计算） */
export function buildContext(bars: KlineBar[]): AnalysisContext {
  const n = bars.length
  const closes = bars.map((b) => b.close)
  const highs = bars.map((b) => b.high)
  const lows = bars.map((b) => b.low)
  const volumes = bars.map((b) => b.volume)
  const ma20 = sma(closes, 20)
  const ma60 = sma(closes, 60)
  const tr: number[] = n === 0 ? [] : [bars[0].high - bars[0].low]
  for (let i = 1; i < n; i++) {
    const prevClose = bars[i - 1].close
    tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose)))
  }
  const atr14 = wilderSmooth(tr, 14)
  const atrPct = atr14.map((a, i) => (a === null || closes[i] <= 0 ? 0 : a / closes[i]))
  const vol5 = sma(volumes, 5)
  const vol60 = sma(volumes, 60)
  const volRatio: Array<number | null> = new Array(n).fill(null)
  for (let i = 0; i < n; i++) {
    const v5 = vol5[i]
    const v60 = vol60[i]
    volRatio[i] = v5 !== null && v60 !== null && v60 > 0 ? v5 / v60 : null
  }
  return { bars, n, closes, highs, lows, volumes, ma20, ma60, atr14, atrPct, volRatio }
}

// ---------------------------------------------------------------- 工具函数

/** 截断到 [lo, hi] */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** 线性映射 [from, to] → [0, 1]（越界截断） */
export function scale01(v: number, from: number, to: number): number {
  if (to === from) return 0
  return clamp((v - from) / (to - from), 0, 1)
}

/** 百分位排名：value 在 values 中的分位（0..1；空/单样本返回 0.5） */
export function percentileRank(values: number[], value: number): number {
  if (values.length === 0) return 0.5
  let below = 0
  for (const v of values) if (v <= value) below++
  return below / values.length
}

/** 窗口最值（闭区间 [from, to]，越界自动截断；空窗口返回 null） */
export function windowExtreme(
  values: number[],
  from: number,
  to: number,
  kind: 'max' | 'min',
): { index: number; value: number } | null {
  let index = -1
  let best = kind === 'max' ? -Infinity : Infinity
  for (let i = Math.max(0, from); i <= Math.min(values.length - 1, to); i++) {
    const v = values[i]
    if ((kind === 'max' && v > best) || (kind === 'min' && v < best)) {
      best = v
      index = i
    }
  }
  return index < 0 ? null : { index, value: best }
}

/** 区间分位（close 在近 window 根 low..high 中的位置 0..1；样本不足返回 null） */
export function rangePosition(ctx: AnalysisContext, i: number, window = ANALYSIS_PARAMS.rangeWindow): number | null {
  const from = Math.max(0, i - window + 1)
  const highs = windowExtreme(ctx.highs, from, i, 'max')
  const lows = windowExtreme(ctx.lows, from, i, 'min')
  if (!highs || !lows || highs.value <= lows.value) return null
  return clamp((ctx.closes[i] - lows.value) / (highs.value - lows.value), 0, 1)
}
