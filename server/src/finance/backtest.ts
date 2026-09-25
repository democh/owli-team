/**
 * 回测引擎（M34 §3.3 / §5.1 fin_backtest）：Node 自研唯一实现（纯计算，零网络）。
 *
 * 执行模型（避免未来函数）：第 i 根收盘产生信号 → 第 i+1 根开盘成交；全仓多头、单标的；
 * 双边成本：单边费率 + 单边滑点（买入按开盘×(1+滑点)，卖出按开盘×(1−滑点)，买卖各扣一次费率）；
 * 区间结束仍持仓 → 按最后收盘价强制平仓（notes 注明，回撤/收益含该摩擦）。
 * 指标口径复用 indicator.ts（与 fin_indicator / 报告口径一致）。
 *
 * M83：`template='dsl'` 通道 —— 信号来源切换为 DSL 共享信号层（finance/dsl/exec.generateDslSignals），
 * 执行模型 / 成本 / 绩效指标完全复用；DSL 与模板策略在同一把尺下对比（口径唯一）。
 */
import { computeIndicator, sma } from './indicator.js'
import { DslExprError } from './dsl/expr.js'
import { generateDslSignals } from './dsl/exec.js'
import { parseDsl } from './dsl/spec.js'
import { formatCnDate, parseCnDate } from './period.js'
import type { KlineBar } from './types.js'

export type BacktestTemplate = 'ma-cross' | 'rsi-reversal' | 'macd-cross' | 'boll-breakout' | 'buy-hold' | 'dsl'

/** 模板清单（tuple 常量：zod 枚举 / 工具参数 schema 直接复用；'dsl' 需配套 dsl 源码） */
export const BACKTEST_TEMPLATES = [
  'ma-cross',
  'rsi-reversal',
  'macd-cross',
  'boll-breakout',
  'buy-hold',
  'dsl',
] as const satisfies readonly BacktestTemplate[]

/** 模板默认参数（工具说明与结果回显共用；dsl 无模板参数） */
export const BACKTEST_DEFAULT_PARAMS: Record<BacktestTemplate, Record<string, number>> = {
  'ma-cross': { fast: 5, slow: 20 },
  'rsi-reversal': { period: 14, oversold: 30, overbought: 70 },
  'macd-cross': { fast: 12, slow: 26, signal: 9 },
  'boll-breakout': { period: 20, mult: 2 },
  'buy-hold': {},
  dsl: {},
}

/** 默认单边费率 %（佣金 + 印花税综合近似）与单边滑点 % */
export const DEFAULT_FEE_RATE = 0.05
export const DEFAULT_SLIPPAGE = 0.02

export interface BacktestStrategy {
  template: BacktestTemplate
  params?: Record<string, number>
  /** template='dsl' 时的策略源码（YAML；lint 不过则回测失败） */
  dsl?: string
  /** DSL inputs 覆盖（仅限策略已声明键） */
  dslInputs?: Record<string, number | string | boolean>
}

export interface BacktestOptions {
  /** 单边费率 %（默认 0.05；[0, 2]） */
  feeRate?: number
  /** 单边滑点 %（默认 0.02；[0, 2]） */
  slippage?: number
  /** 区间（yyyy-MM-dd；闭区间，按 bar 时间戳过滤） */
  range?: { start?: string; end?: string }
}

export class BacktestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BacktestError'
  }
}

export interface BacktestTrade {
  entryAt: string
  exitAt: string
  entryPrice: number
  exitPrice: number
  /** 含双边费用与滑点的收益率（小数） */
  returnPct: number
  /** 持有 bar 数 */
  bars: number
  /** 区间结束强制平仓 */
  forced?: boolean
}

export interface BacktestMetrics {
  /** 区间总收益（小数，含成本） */
  totalReturn: number
  /** 年化收益（按自然日折算） */
  annualReturn: number
  /** 最大回撤（正数小数） */
  maxDrawdown: number
  /** 夏普比率（日频年化，无风险利率 0） */
  sharpe: number
  /** 胜率（无平仓交易时缺省） */
  winRate?: number
  /** 平仓交易数 */
  trades: number
  /** 盈亏比（总盈利 / 总亏损；无亏损或未盈利时缺省） */
  profitFactor?: number
  /** 同区间买入持有基准收益（小数） */
  benchmarkReturn: number
  /** 年化波动率（日频年化） */
  volatility: number
  bars: number
}

export interface BacktestEquityPoint {
  timestamp: number
  /** 归一化净值（起点 1.0，含成本） */
  equity: number
  /** 同区间买入持有基准（起点 1.0） */
  benchmark: number
}

export interface BacktestResult {
  template: BacktestTemplate
  params: Record<string, number>
  from: string
  to: string
  bars: number
  metrics: BacktestMetrics
  /** 净值曲线（>600 点均匀采样） */
  equity: BacktestEquityPoint[]
  trades: BacktestTrade[]
  notes: string[]
}

/** 信号（在 index 根收盘产生；执行在第 index+1 根开盘） */
interface SignalPoint {
  index: number
  side: 'buy' | 'sell'
}

function finiteParam(params: Record<string, number>, key: string, def: number, opts: { min?: number; max?: number } = {}): number {
  const raw = params[key]
  if (raw === undefined) return def
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new BacktestError(`策略参数 ${key} 应为数字`)
  }
  const min = opts.min ?? -Infinity
  const max = opts.max ?? Infinity
  if (raw < min || raw > max) {
    throw new BacktestError(`策略参数 ${key}=${raw} 超出范围（${min} ~ ${max}）`)
  }
  return raw
}

/** 生成交易信号（模板间互斥；指标口径依赖 indicator.ts 导出函数） */
function generateSignals(bars: KlineBar[], strategy: BacktestStrategy): { signals: SignalPoint[]; params: Record<string, number> } {
  const close = bars.map((bar) => bar.close)
  const merged = { ...BACKTEST_DEFAULT_PARAMS[strategy.template], ...(strategy.params ?? {}) }
  const signals: SignalPoint[] = []

  switch (strategy.template) {
    case 'buy-hold': {
      if (bars.length > 1) signals.push({ index: 0, side: 'buy' })
      return { signals, params: merged }
    }
    case 'dsl': {
      if (!strategy.dsl) throw new BacktestError("template='dsl' 需提供 dsl 源码（YAML）")
      const parsed = parseDsl(strategy.dsl)
      if (!parsed.ok) {
        const first = parsed.findings.find((f) => f.level === 'error')
        throw new BacktestError(
          `DSL 校验未通过：${first ? `${first.message}${first.path ? `（${first.path}）` : ''}` : '未知错误'}`,
        )
      }
      try {
        const hits = generateDslSignals(bars, parsed.spec, {
          symbol: '',
          period: 'day',
          adjust: 'qfq',
          ...(strategy.dslInputs ? { inputs: strategy.dslInputs } : {}),
        })
        for (const hit of hits) signals.push({ index: hit.index, side: hit.side })
      } catch (err) {
        if (err instanceof DslExprError) throw new BacktestError(`DSL 执行失败：${err.message}`)
        throw err
      }
      return { signals, params: merged }
    }
    case 'ma-cross': {
      const fast = Math.round(finiteParam(merged, 'fast', 5, { min: 1, max: 500 }))
      const slow = Math.round(finiteParam(merged, 'slow', 20, { min: 2, max: 500 }))
      if (fast >= slow) throw new BacktestError(`ma-cross 需要 fast < slow（当前 fast=${fast} / slow=${slow}）`)
      const f = sma(close, fast)
      const s = sma(close, slow)
      for (let i = 1; i < bars.length; i++) {
        const f0 = f[i - 1]
        const s0 = s[i - 1]
        const f1 = f[i]
        const s1 = s[i]
        if (f0 === null || s0 === null || f1 === null || s1 === null) continue
        if (f0 <= s0 && f1 > s1) signals.push({ index: i, side: 'buy' })
        else if (f0 >= s0 && f1 < s1) signals.push({ index: i, side: 'sell' })
      }
      return { signals, params: { fast, slow } }
    }
    case 'rsi-reversal': {
      const period = Math.round(finiteParam(merged, 'period', 14, { min: 2, max: 200 }))
      const oversold = finiteParam(merged, 'oversold', 30, { min: 1, max: 49 })
      const overbought = finiteParam(merged, 'overbought', 70, { min: 51, max: 99 })
      const series = computeIndicator('RSI', bars, { period })
      const values = series.points.map((point) => point.values[`RSI${period}`] ?? null)
      for (let i = 1; i < bars.length; i++) {
        const prev = values[i - 1]
        const cur = values[i]
        if (prev === null || cur === null) continue
        if (prev <= oversold && cur > oversold) signals.push({ index: i, side: 'buy' })
        else if (prev >= overbought && cur < overbought) signals.push({ index: i, side: 'sell' })
      }
      return { signals, params: { period, oversold, overbought } }
    }
    case 'macd-cross': {
      const fast = Math.round(finiteParam(merged, 'fast', 12, { min: 1, max: 200 }))
      const slow = Math.round(finiteParam(merged, 'slow', 26, { min: 2, max: 400 }))
      const signalN = Math.round(finiteParam(merged, 'signal', 9, { min: 1, max: 100 }))
      if (fast >= slow) throw new BacktestError(`macd-cross 需要 fast < slow（当前 fast=${fast} / slow=${slow}）`)
      const series = computeIndicator('MACD', bars, { fast, slow, signal: signalN })
      const dif = series.points.map((point) => point.values.DIF ?? null)
      const dea = series.points.map((point) => point.values.DEA ?? null)
      for (let i = 1; i < bars.length; i++) {
        const d0 = dif[i - 1]
        const e0 = dea[i - 1]
        const d1 = dif[i]
        const e1 = dea[i]
        if (d0 === null || e0 === null || d1 === null || e1 === null) continue
        if (d0 <= e0 && d1 > e1) signals.push({ index: i, side: 'buy' })
        else if (d0 >= e0 && d1 < e1) signals.push({ index: i, side: 'sell' })
      }
      return { signals, params: { fast, slow, signal: signalN } }
    }
    case 'boll-breakout': {
      const period = Math.round(finiteParam(merged, 'period', 20, { min: 2, max: 250 }))
      const mult = finiteParam(merged, 'mult', 2, { min: 0.5, max: 6 })
      const series = computeIndicator('BOLL', bars, { period, mult })
      const upper = series.points.map((point) => point.values.UPPER ?? null)
      const lower = series.points.map((point) => point.values.LOWER ?? null)
      for (let i = 1; i < bars.length; i++) {
        const u0 = upper[i - 1]
        const l0 = lower[i - 1]
        const u1 = upper[i]
        const l1 = lower[i]
        if (u0 === null || l0 === null || u1 === null || l1 === null) continue
        // 上轨突破开仓（趋势跟随）；下轨跌破离场
        if (close[i - 1] <= u0 && close[i] > u1) signals.push({ index: i, side: 'buy' })
        else if (close[i - 1] >= l0 && close[i] < l1) signals.push({ index: i, side: 'sell' })
      }
      return { signals, params: { period, mult } }
    }
    default: {
      throw new BacktestError(`未知策略模板「${String(strategy.template)}」（可用：${BACKTEST_TEMPLATES.join(' / ')}）`)
    }
  }
}

/** 区间过滤（闭区间；start/end 任一缺省为不限） */
function filterRange(bars: KlineBar[], range?: { start?: string; end?: string }): KlineBar[] {
  if (!range || (!range.start && !range.end)) return bars
  const startTs = range.start ? parseCnDate(range.start) : -Infinity
  const endTs = range.end ? parseCnDate(range.end) + 24 * 3600 * 1000 - 1 : Infinity
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) {
    throw new BacktestError('range 日期格式应为 yyyy-MM-dd')
  }
  return bars.filter((bar) => bar.timestamp >= startTs && bar.timestamp <= endTs)
}

/** 净值采样（>600 点均匀抽取，保留首尾） */
function sampleEquity(points: BacktestEquityPoint[], maxPoints = 600): BacktestEquityPoint[] {
  if (points.length <= maxPoints) return points
  const step = (points.length - 1) / (maxPoints - 1)
  const out: BacktestEquityPoint[] = []
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.round(i * step)])
  return out
}

/** 最大回撤（正数小数） */
function maxDrawdownOf(equity: number[]): number {
  let peak = -Infinity
  let mdd = 0
  for (const value of equity) {
    peak = Math.max(peak, value)
    if (peak > 0) mdd = Math.max(mdd, (peak - value) / peak)
  }
  return mdd
}

/**
 * 运行回测。bars 应为升序日线（≥10 根）；结果含绩效、净值曲线、成交明细与口径说明。
 */
export function runBacktest(barsInput: KlineBar[], strategy: BacktestStrategy, opts: BacktestOptions = {}): BacktestResult {
  const feeRate = opts.feeRate ?? DEFAULT_FEE_RATE
  const slippage = opts.slippage ?? DEFAULT_SLIPPAGE
  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate > 2) throw new BacktestError('feeRate 应为 0 ~ 2（%）')
  if (!Number.isFinite(slippage) || slippage < 0 || slippage > 2) throw new BacktestError('slippage 应为 0 ~ 2（%）')

  const bars = filterRange(barsInput, opts.range)
  if (bars.length < 10) {
    throw new BacktestError(`区间样本不足（${bars.length} 根 < 10 根）：请扩大区间或缩短指标周期`)
  }

  const { signals, params } = generateSignals(bars, strategy)
  const fee = feeRate / 100
  const slip = slippage / 100

  const byIndex = new Map<number, 'buy' | 'sell'>()
  for (const signal of signals) byIndex.set(signal.index, signal.side)

  let cash = 1
  let units = 0
  let entryIdx = -1
  let entryPrice = 0
  const closed: BacktestTrade[] = []
  const equitySeries: BacktestEquityPoint[] = []
  const benchmark = bars[0].close

  const equityOf = (index: number): number => (units > 0 ? units * bars[index].close : cash)

  for (let i = 1; i < bars.length; i++) {
    const signal = byIndex.get(i - 1)
    const open = bars[i].open
    if (signal === 'buy' && units === 0 && open > 0) {
      const px = open * (1 + slip)
      // 记入费率：单位成本 = px / (1 − fee)，卖出端再乘 (1 − fee) → 双边成本
      units = (cash * (1 - fee)) / px
      entryPrice = px
      entryIdx = i
      cash = 0
    } else if (signal === 'sell' && units > 0 && open > 0) {
      const px = open * (1 - slip)
      const proceeds = units * px * (1 - fee)
      closed.push({
        entryAt: formatCnDate(bars[entryIdx].timestamp),
        exitAt: formatCnDate(bars[i].timestamp),
        entryPrice: round6(entryPrice),
        exitPrice: round6(px),
        returnPct: (proceeds / (units * entryPrice)) - 1,
        bars: i - entryIdx,
      })
      cash = proceeds
      units = 0
      entryIdx = -1
    }
    equitySeries.push({
      timestamp: bars[i].timestamp,
      equity: equityOf(i),
      benchmark: bars[i].close / benchmark,
    })
  }

  // 区间结束强制平仓（最后收盘价 + 滑点/费率）
  const lastIdx = bars.length - 1
  let forcedNote = ''
  if (units > 0) {
    const px = bars[lastIdx].close * (1 - slip)
    const proceeds = units * px * (1 - fee)
    closed.push({
      entryAt: formatCnDate(bars[entryIdx].timestamp),
      exitAt: formatCnDate(bars[lastIdx].timestamp),
      entryPrice: round6(entryPrice),
      exitPrice: round6(px),
      returnPct: proceeds / (units * entryPrice) - 1,
      bars: lastIdx - entryIdx,
      forced: true,
    })
    cash = proceeds
    units = 0
    forcedNote = '区间结束仍持仓：已按最后收盘价（含滑点与费率）强制平仓'
  }
  const equityEnd = cash
  // 修正末点净值（强制平仓后）
  if (equitySeries.length > 0) equitySeries[equitySeries.length - 1].equity = equityEnd

  const equityValues = equitySeries.map((point) => point.equity)
  const dailyReturns: number[] = []
  for (let i = 1; i < equityValues.length; i++) {
    if (equityValues[i - 1] > 0) dailyReturns.push(equityValues[i] / equityValues[i - 1] - 1)
  }
  const mean = dailyReturns.length > 0 ? dailyReturns.reduce((acc, v) => acc + v, 0) / dailyReturns.length : 0
  const variance =
    dailyReturns.length > 1
      ? dailyReturns.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (dailyReturns.length - 1)
      : 0
  const std = Math.sqrt(variance)
  const sharpe = std > 1e-12 ? (mean / std) * Math.sqrt(252) : 0
  const volatility = std * Math.sqrt(252)

  const days = Math.max(1, (bars[lastIdx].timestamp - bars[0].timestamp) / 86_400_000 + 1)
  const totalReturn = equityEnd - 1
  const annualReturn = equityEnd > 0 ? Math.pow(equityEnd, 365 / days) - 1 : -1

  const wins = closed.filter((trade) => trade.returnPct > 0)
  const gainSum = wins.reduce((acc, trade) => acc + trade.returnPct, 0)
  const lossSum = closed.filter((trade) => trade.returnPct < 0).reduce((acc, trade) => acc + trade.returnPct, 0)

  const metrics: BacktestMetrics = {
    totalReturn,
    annualReturn,
    maxDrawdown: maxDrawdownOf(equityValues),
    sharpe,
    trades: closed.length,
    benchmarkReturn: bars[lastIdx].close / benchmark - 1,
    volatility,
    bars: bars.length,
  }
  if (closed.length > 0) metrics.winRate = wins.length / closed.length
  if (lossSum < 0) metrics.profitFactor = gainSum / Math.abs(lossSum)

  const notes = [
    `执行口径：第 i 根收盘信号 → 第 i+1 根开盘成交（避免未来函数）；全仓多头单标的`,
    `成本口径：单边费率 ${feeRate}% + 单边滑点 ${slippage}%（买卖各计一次）`,
    `年化口径：按自然日 ${Math.round(days)} 天折算；夏普按日频 ×√252（无风险利率 0）`,
  ]
  if (strategy.template === 'dsl') notes.push('信号源：DSL 策略（规则化边沿触发，口径与 fin_strategy 一致）')
  if (forcedNote) notes.push(forcedNote)
  if (closed.length === 0) notes.push('区间内无完整交易（信号未触发，可放宽参数或扩大区间）')

  return {
    template: strategy.template,
    params,
    from: formatCnDate(bars[0].timestamp),
    to: formatCnDate(bars[lastIdx].timestamp),
    bars: bars.length,
    metrics,
    equity: sampleEquity(equitySeries),
    trades: closed,
    notes,
  }
}

function round6(value: number): number {
  const factor = 1e6
  return Math.round(value * factor) / factor
}
