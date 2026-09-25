/**
 * 统计引擎 Node 侧（M84 H2）：事件检测器（significance 的 events 来源）+ Node 兜底基础统计。
 *
 * 口径纪律（设计稿 §5.3）：
 * - 全量统计（偏度 / 峰度 / 分位 / ADF / 滚动相关 / t 检验 / bootstrap CI）由 Python 桥提供；
 * - Node 兜底仅给「可确定性计算且不涉及分布假设」的基础量（区间涨跌 / 年化收益波动 / 最大回撤 / Pearson）；
 * - 显著性检验不提供 Node 近似值（统计能力不允许降级为猜测）。
 * 本模块纯计算零网络：bars / 事件参数由工具层传入。
 */
import { sma } from './indicator.js'
import type { KlineBar } from './types.js'

// ---------------------------------------------------------------- 事件检测器

/** 内置事件检测器清单（significance 的事件来源；与工具参数枚举同源） */
export const EVENT_KINDS = ['ma_cross_up', 'ma_cross_down', 'drop_pct', 'rise_pct', 'volume_spike', 'touch_level'] as const
export type EventKind = (typeof EVENT_KINDS)[number]

/** 事件参数（全部可选；按 kind 取用并默认化） */
export interface EventSpec {
  kind: EventKind
  /** ma_cross：快线周期（默认 5） */
  fast?: number
  /** ma_cross：慢线周期（默认 20） */
  slow?: number
  /** drop_pct / rise_pct：幅度阈值 %（默认 5） */
  pct?: number
  /** drop_pct / rise_pct：回看窗口根数（默认 1）；volume_spike：基准均量窗口（默认 60） */
  window?: number
  /** volume_spike：量比阈值（默认 2） */
  ratio?: number
  /** touch_level：关键位价格（必填） */
  price?: number
  /** touch_level：容差 %（默认 0 = 严格触碰） */
  tolerancePct?: number
}

export type EventDetectResult = { ok: true; events: number[]; label: string } | { ok: false; error: string }

/** 事件中文描述（输出与快照用） */
export function eventLabel(spec: EventSpec): string {
  switch (spec.kind) {
    case 'ma_cross_up':
      return `MA${spec.fast ?? 5} 上穿 MA${spec.slow ?? 20}`
    case 'ma_cross_down':
      return `MA${spec.fast ?? 5} 下穿 MA${spec.slow ?? 20}`
    case 'drop_pct':
      return `${spec.window ?? 1} 根内跌幅 ≥${spec.pct ?? 5}%`
    case 'rise_pct':
      return `${spec.window ?? 1} 根内涨幅 ≥${spec.pct ?? 5}%`
    case 'volume_spike':
      return `量比 ≥${spec.ratio ?? 2}（基准 ${spec.window ?? 60} 根均量）`
    case 'touch_level':
      return `触及 ${spec.price ?? '?'}${spec.tolerancePct ? `（容差 ±${spec.tolerancePct}%）` : ''}`
  }
}

/** 检测事件触发下标（升序；空数组 = 未触发） */
export function detectEvents(bars: KlineBar[], spec: EventSpec): EventDetectResult {
  const n = bars.length
  if (n < 30) return { ok: false, error: `K 线样本不足（${n} 根 < 30 根）` }
  const closes = bars.map((b) => b.close)
  const label = eventLabel(spec)

  switch (spec.kind) {
    case 'ma_cross_up':
    case 'ma_cross_down': {
      const fast = Math.round(spec.fast ?? 5)
      const slow = Math.round(spec.slow ?? 20)
      if (fast < 1 || slow < 2 || fast >= slow) {
        return { ok: false, error: `ma_cross 需要 1 ≤ fast < slow（当前 fast=${fast} / slow=${slow}）` }
      }
      const f = sma(closes, fast)
      const s = sma(closes, slow)
      const out: number[] = []
      for (let i = 1; i < n; i++) {
        const f0 = f[i - 1]
        const s0 = s[i - 1]
        const f1 = f[i]
        const s1 = s[i]
        if (f0 === null || s0 === null || f1 === null || s1 === null) continue
        if (spec.kind === 'ma_cross_up' ? f0 <= s0 && f1 > s1 : f0 >= s0 && f1 < s1) out.push(i)
      }
      return { ok: true, events: out, label }
    }
    case 'drop_pct':
    case 'rise_pct': {
      const window = Math.round(spec.window ?? 1)
      const pct = spec.pct ?? 5
      if (window < 1) return { ok: false, error: 'window 需 ≥ 1' }
      if (!(pct > 0 && pct < 100)) return { ok: false, error: 'pct 需在 (0, 100) 区间（百分比数值）' }
      const out: number[] = []
      for (let i = window; i < n; i++) {
        if (closes[i - window] <= 0) continue
        const change = closes[i] / closes[i - window] - 1
        if (spec.kind === 'drop_pct' ? change <= -pct / 100 : change >= pct / 100) out.push(i)
      }
      return { ok: true, events: out, label }
    }
    case 'volume_spike': {
      const window = Math.round(spec.window ?? 60)
      const ratio = spec.ratio ?? 2
      if (window < 5) return { ok: false, error: 'volume_spike 的 window 需 ≥ 5' }
      if (ratio < 1) return { ok: false, error: 'ratio 需 ≥ 1' }
      const base = sma(bars.map((b) => b.volume), window)
      const out: number[] = []
      for (let i = window - 1; i < n; i++) {
        const avg = base[i]
        if (avg === null || avg <= 0) continue
        if (bars[i].volume >= ratio * avg) out.push(i)
      }
      return { ok: true, events: out, label }
    }
    case 'touch_level': {
      const price = spec.price
      if (typeof price !== 'number' || !(price > 0)) return { ok: false, error: 'touch_level 需要 price（正数关键位价格）' }
      const tol = spec.tolerancePct ?? 0
      if (tol < 0 || tol > 10) return { ok: false, error: 'tolerancePct 需在 0–10（百分比数值）' }
      const upper = price * (1 + tol / 100)
      const lower = price * (1 - tol / 100)
      const out: number[] = []
      for (let i = 0; i < n; i++) {
        // 严格触碰 = bar 区间覆盖关键位；容差模式放宽为 高低点或收盘进入容差带
        const covered = bars[i].low <= price && bars[i].high >= price
        const inBand = bars[i].low <= upper && bars[i].high >= lower
        if (tol > 0 ? inBand : covered) out.push(i)
      }
      return { ok: true, events: out, label }
    }
  }
}

// ---------------------------------------------------------------- Node 兜底基础统计

export interface StatsSeriesInput {
  name: string
  timestamps: number[]
  closes: number[]
}

export interface SeriesSummary {
  name: string
  points: number
  first: number
  last: number
  changePct: number
  annualReturnPct: number | null
  annualVolPct: number | null
  maxDrawdownPct: number
}

export interface CorrelationMatrix {
  names: string[]
  /** 收益 Pearson 矩阵（对齐后；样本不足处为 null） */
  pearson: Array<Array<number | null>>
  points: number
}

export interface NodeSummaryResult {
  engine: 'node'
  summaries: SeriesSummary[]
  correlation: CorrelationMatrix | null
  /** 缺失项（Python 统计扩展才能提供） */
  missing: string[]
}

const PERIODS_PER_YEAR = 250

/** 年化收益（复合；样本 <2 返回 null） */
function annualReturnOf(closes: number[]): number | null {
  if (closes.length < 2 || closes[0] <= 0 || closes[closes.length - 1] <= 0) return null
  const ratio = closes[closes.length - 1] / closes[0]
  return (Math.pow(ratio, PERIODS_PER_YEAR / (closes.length - 1)) - 1) * 100
}

/** 年化波动（日收益样本标准差 × √250） */
function annualVolOf(closes: number[]): number | null {
  if (closes.length < 3) return null
  const returns: number[] = []
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] <= 0) continue
    returns.push(closes[i] / closes[i - 1] - 1)
  }
  if (returns.length < 2) return null
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1)
  return Math.sqrt(variance) * Math.sqrt(PERIODS_PER_YEAR) * 100
}

/** 最大回撤 %（正数） */
function maxDrawdownOf(closes: number[]): number {
  let peak = -Infinity
  let mdd = 0
  for (const c of closes) {
    peak = Math.max(peak, c)
    if (peak > 0) mdd = Math.max(mdd, (peak - c) / peak)
  }
  return mdd * 100
}

/** Pearson 相关系数（样本 <3 或零方差返回 null） */
function pearsonOf(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length)
  if (n < 3) return null
  let ma = 0
  let mb = 0
  for (let i = 0; i < n; i++) {
    ma += a[i]
    mb += b[i]
  }
  ma /= n
  mb /= n
  let cov = 0
  let va = 0
  let vb = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma
    const db = b[i] - mb
    cov += da * db
    va += da * da
    vb += db * db
  }
  if (va <= 0 || vb <= 0) return null
  return cov / Math.sqrt(va * vb)
}

/**
 * Node 兜底基础统计（Python 统计扩展不可用时）：
 * 区间涨跌 / 年化收益 / 年化波动 / 最大回撤 + 收益 Pearson 矩阵（按时间戳对齐）。
 */
export function nodeSummary(series: StatsSeriesInput[]): NodeSummaryResult {
  const summaries: SeriesSummary[] = series.map((s) => {
    const closes = s.closes
    return {
      name: s.name,
      points: closes.length,
      first: closes[0] ?? 0,
      last: closes[closes.length - 1] ?? 0,
      changePct: closes.length > 1 && closes[0] > 0 ? (closes[closes.length - 1] / closes[0] - 1) * 100 : 0,
      annualReturnPct: annualReturnOf(closes),
      annualVolPct: annualVolOf(closes),
      maxDrawdownPct: maxDrawdownOf(closes),
    }
  })

  let correlation: CorrelationMatrix | null = null
  if (series.length >= 2) {
    // 对齐：时间戳交集 → 各序列收盘对齐 → 收益序列
    const maps = series.map((s) => new Map(s.timestamps.map((ts, i) => [ts, s.closes[i]])))
    const common: number[] = []
    for (const ts of series[0].timestamps) {
      if (maps.every((m) => m.has(ts))) common.push(ts)
    }
    if (common.length >= 4) {
      const alignedReturns = maps.map((m) => {
        const closes = common.map((ts) => m.get(ts)!)
        const returns: number[] = []
        for (let i = 1; i < closes.length; i++) returns.push(closes[i] / closes[i - 1] - 1)
        return returns
      })
      const matrix: Array<Array<number | null>> = alignedReturns.map((a, i) =>
        alignedReturns.map((b, j) => (i === j ? 1 : pearsonOf(a, b))),
      )
      correlation = { names: series.map((s) => s.name), pearson: matrix, points: common.length - 1 }
    }
  }

  return {
    engine: 'node',
    summaries,
    correlation,
    missing: ['偏度 / 峰度 / 分位', '收益分布直方图', 'Spearman 秩相关', '滚动相关', 'ADF 平稳性'],
  }
}

// ---------------------------------------------------------------- Python 桥结果契约（消费侧类型）

/** 桥任务 stats 输出（fin_bridge.py task_stats 同构） */
export interface PyStatsResult {
  names: string[]
  engine: string
  items: {
    summary?: Array<{
      name: string
      points: number
      first: number
      last: number
      changePct: number
      annualReturnPct: number | null
      annualVolPct: number | null
      maxDrawdownPct: number
      percentile: number | null
      skew: number | null
      kurtosis: number | null
    }>
    distribution?: Array<{
      name: string
      quantilesPct: Record<string, number>
      buckets: Array<{ from: number; to: number; count: number }>
    }>
    correlation?: {
      names: string[]
      pearson: Array<Array<number | null>>
      spearman: Array<Array<number | null>>
      rollingWindow: number
      rollingLast: Record<string, number | null>
      points: number
    }
    stationarity?: Array<{ name: string; priceP: number | null; returnP: number | null }>
  }
  notes: string[]
}

/** 桥任务 significance 输出（fin_bridge.py task_significance 同构） */
export interface PySignificanceResult {
  events: number
  bars: number
  alpha: number
  bonferroniAlpha: number
  bootstrap: number
  seed: number
  horizons: Array<{
    horizon: number
    samples: number
    meanPct: number | null
    medianPct: number | null
    winRate: number | null
    profitFactor: number | null
    tStat: number | null
    pValue: number | null
    significant: boolean | null
    ciLowPct: number | null
    ciHighPct: number | null
    baselineMeanPct: number | null
    excessPct: number | null
  }>
  notes: string[]
}
