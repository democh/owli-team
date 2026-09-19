/**
 * 模型 4 · ABM 蒙特卡洛（M34 §5.4）：主体建模 + 级联机制 + 路径统计。
 *
 * 主体（权重参数化）：多头趋势派（动量上行加多）/ 空头趋势派（动量下行加空）/ 均值回归套利者
 * （偏离均线反向承接）/ 做市商（吸收趋势净流、缓冲动量）/ 噪音散户（随机小单）/ 机构大单
 * （预设时点冲击事件）。
 * 每轮：净订单流 flow_t → 价格冲击 ΔP = λ·flow_t + σ·ε_t → 更新多空累积盈亏 →
 * 级联：空头浮亏 > cascadeThreshold 触发被动平仓（买入 = 挤空），多头同理（踩踏）。
 *
 * 确定性：全部随机来自 mulberry32(seed)，相同 seed + params 输出逐位一致。
 * 计算护栏：默认 500 路径 × 120 轮；上限 2000 × 240（工具超时内）。
 */
import { GameError, ParamReader, pct, round, type ModelOutcome } from './types.js'
import { mulberry32, type Prng } from './prng.js'

export interface ShockEvent {
  /** 触发轮次（0 起） */
  round: number
  /** 冲击规模（正 = 利多方向的大单） */
  size: number
}

export interface SimulateParams {
  initialPrice: number
  /** 冲击系数（订单流 → 价格变动比例） */
  lambda: number
  /** 白噪声波动 */
  sigma: number
  rounds: number
  paths: number
  longWeight: number
  shortWeight: number
  arbWeight: number
  mmLiquidity: number
  retailNoise: number
  /** 级联触发阈值（浮亏比例） */
  cascadeThreshold: number
  /** 级联冲击流规模 */
  cascadeFlow: number
  momentumWindow: number
  momentumScale: number
  /** 僵持判定带宽（|终值涨跌| ≤ band） */
  stalemateBand: number
  shockEvents: ShockEvent[]
}

export const SIMULATE_KNOWN_PARAMS = [
  'initialPrice',
  'lambda',
  'sigma',
  'rounds',
  'paths',
  'longWeight',
  'shortWeight',
  'arbWeight',
  'mmLiquidity',
  'retailNoise',
  'cascadeThreshold',
  'cascadeFlow',
  'momentumWindow',
  'momentumScale',
  'stalemateBand',
  'shockEvents',
] as const

export interface SimulateBands {
  rounds: number[]
  p5: number[]
  p25: number[]
  p50: number[]
  p75: number[]
  p95: number[]
}

export interface QuantileSummary {
  mean: number
  p5: number
  p50: number
  p95: number
}

export interface HistogramBin {
  binStart: number
  count: number
}

export interface SimulateResult {
  initialPrice: number
  rounds: number
  paths: number
  /** 价格分位带（按轮次） */
  bands: SimulateBands
  /** 抽样路径（前 ≤20 条，用于叠加绘制） */
  samplePaths: number[][]
  /** 终值分布直方图（30 bins） */
  finalHistogram: HistogramBin[]
  /** 多空累积盈亏分布（比例口径） */
  pnl: { long: QuantileSummary; short: QuantileSummary }
  /** 最大回撤分布 */
  maxDrawdown: QuantileSummary
  /** 事件概率（互斥归类） */
  events: { squeeze: number; crash: number; stalemate: number; other: number }
  /** 级联触发路径占比 */
  cascade: { shortSqueezed: number; longSqueezed: number; squeezeRoundMean: number }
}

export function parseSimulateParams(reader: ParamReader): SimulateParams {
  const rounds = reader.num('rounds', 120, { min: 1, max: 240, int: true })
  const shockEvents = reader.shocks('shockEvents')
  shockEvents.forEach((event, idx) => {
    if (event.round >= rounds) {
      throw new GameError(`参数 shockEvents[${idx}].round 超出推演轮次范围（0 ~ ${rounds - 1}）`)
    }
  })
  return {
    initialPrice: reader.num('initialPrice', 100, { min: 0.01, max: 1e9 }),
    lambda: reader.num('lambda', 0.01, { min: 0, max: 1 }),
    sigma: reader.num('sigma', 0.004, { min: 0, max: 1 }),
    rounds,
    paths: reader.num('paths', 500, { min: 1, max: 2000, int: true }),
    longWeight: reader.num('longWeight', 1, { min: 0, max: 10 }),
    shortWeight: reader.num('shortWeight', 1, { min: 0, max: 10 }),
    arbWeight: reader.num('arbWeight', 0.4, { min: 0, max: 10 }),
    mmLiquidity: reader.num('mmLiquidity', 0.5, { min: 0, max: 1 }),
    retailNoise: reader.num('retailNoise', 0.3, { min: 0, max: 10 }),
    cascadeThreshold: reader.num('cascadeThreshold', 0.08, { min: 0.001, max: 1 }),
    cascadeFlow: reader.num('cascadeFlow', 0.6, { min: 0, max: 10 }),
    momentumWindow: reader.num('momentumWindow', 10, { min: 2, max: 60, int: true }),
    momentumScale: reader.num('momentumScale', 0.005, { min: 1e-5, max: 0.5 }),
    stalemateBand: reader.num('stalemateBand', 0.02, { min: 0, max: 1 }),
    shockEvents,
  }
}

interface PathResult {
  prices: Float64Array
  longPnl: number
  shortPnl: number
  maxDrawdown: number
  shortSqueezed: boolean
  longSqueezed: boolean
  squeezeRound: number
}

/** 单路径模拟（顺序消费同一 PRNG 流，保证确定性） */
function simulatePath(prng: Prng, params: SimulateParams): PathResult {
  const { initialPrice, lambda, sigma, rounds, momentumScale } = params
  const window = Math.max(2, params.momentumWindow)
  const prices = new Float64Array(rounds + 1)
  prices[0] = initialPrice
  let maSum = initialPrice
  let maCount = 1
  let longPnl = 0
  let shortPnl = 0
  let shortSqueezed = false
  let longSqueezed = false
  let squeezeRound = -1
  let peak = initialPrice
  let maxDrawdown = 0

  for (let t = 0; t < rounds; t++) {
    const price = prices[t]
    const ma = maSum / maCount
    const deviation = ma > 0 ? (price - ma) / ma : 0
    const trend = Math.tanh(deviation / momentumScale)
    const trendFlow = params.longWeight * Math.max(trend, 0) + params.shortWeight * Math.min(trend, 0)
    // 订单流：趋势派（正反馈）− 套利者（均值回归）− 做市商（吸收趋势失衡）+ 散户噪音 + 事件冲击
    let flow = trendFlow - params.arbWeight * trend - params.mmLiquidity * trendFlow
    flow += params.retailNoise * prng.normal()
    for (const event of params.shockEvents) {
      if (event.round === t) flow += event.size
    }
    // 级联：空头浮亏触发被动平仓（买入 = 挤空）；多头浮亏触发止损（踩踏）
    if (!shortSqueezed && shortPnl < -params.cascadeThreshold) {
      shortSqueezed = true
      squeezeRound = t
      flow += params.cascadeFlow
    }
    if (!longSqueezed && longPnl < -params.cascadeThreshold) {
      longSqueezed = true
      flow -= params.cascadeFlow
    }

    const ret = lambda * flow + sigma * prng.normal()
    const nextPrice = Math.max(price * (1 + ret), price * 1e-6)
    prices[t + 1] = nextPrice
    longPnl += ret
    shortPnl -= ret
    if (nextPrice > peak) peak = nextPrice
    const drawdown = peak > 0 ? 1 - nextPrice / peak : 0
    if (drawdown > maxDrawdown) maxDrawdown = drawdown

    maSum += nextPrice
    maCount += 1
    if (maCount > window) {
      maSum -= prices[t + 1 - window]
      maCount = window
    }
  }
  return { prices, longPnl, shortPnl, maxDrawdown, shortSqueezed, longSqueezed, squeezeRound }
}

/** 分位（线性插值，输入需已升序） */
export function quantile(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length
  if (n === 0) return Number.NaN
  if (n === 1) return sorted[0]
  const pos = q * (n - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const frac = pos - lo
  return sorted[lo] * (1 - frac) + sorted[hi] * frac
}

function summarize(sorted: ArrayLike<number>): QuantileSummary {
  let sum = 0
  for (let i = 0; i < sorted.length; i++) sum += sorted[i]
  return {
    mean: round(sum / sorted.length),
    p5: round(quantile(sorted, 0.05)),
    p50: round(quantile(sorted, 0.5)),
    p95: round(quantile(sorted, 0.95)),
  }
}

export function runSimulate(params: Record<string, unknown> | undefined, seed: number): ModelOutcome<SimulateResult> {
  const reader = new ParamReader(params, SIMULATE_KNOWN_PARAMS)
  const parsed = parseSimulateParams(reader)
  const prng = mulberry32(seed)
  const pathResults: PathResult[] = []
  for (let i = 0; i < parsed.paths; i++) pathResults.push(simulatePath(prng, parsed))

  // 价格分位带（按轮次）
  const bands: SimulateBands = { rounds: [], p5: [], p25: [], p50: [], p75: [], p95: [] }
  const column = new Float64Array(parsed.paths)
  for (let t = 0; t <= parsed.rounds; t++) {
    for (let p = 0; p < parsed.paths; p++) column[p] = pathResults[p].prices[t]
    column.sort()
    bands.rounds.push(t)
    bands.p5.push(round(quantile(column, 0.05), 4))
    bands.p25.push(round(quantile(column, 0.25), 4))
    bands.p50.push(round(quantile(column, 0.5), 4))
    bands.p75.push(round(quantile(column, 0.75), 4))
    bands.p95.push(round(quantile(column, 0.95), 4))
  }

  // 终值直方图（30 bins）
  const finals = pathResults.map((path) => path.prices[parsed.rounds])
  const finalMin = Math.min(...finals)
  const finalMax = Math.max(...finals)
  const binCount = 30
  const binWidth = (finalMax - finalMin) / binCount || 1
  const finalHistogram: HistogramBin[] = Array.from({ length: binCount }, (_, i) => ({
    binStart: round(finalMin + i * binWidth, 4),
    count: 0,
  }))
  for (const value of finals) {
    const idx = Math.min(binCount - 1, Math.max(0, Math.floor((value - finalMin) / binWidth)))
    finalHistogram[idx].count += 1
  }

  // 多空累积盈亏 / 最大回撤分布
  const longPnlSorted = Float64Array.from(pathResults.map((path) => path.longPnl)).sort()
  const shortPnlSorted = Float64Array.from(pathResults.map((path) => path.shortPnl)).sort()
  const drawdownSorted = Float64Array.from(pathResults.map((path) => path.maxDrawdown)).sort()

  // 事件概率（互斥归类：挤空 → 踩踏 → 僵持 → 其它）
  const events = { squeeze: 0, crash: 0, stalemate: 0, other: 0 }
  let shortSqueezePaths = 0
  let longSqueezePaths = 0
  let squeezeRoundSum = 0
  for (const path of pathResults) {
    const totalReturn = path.prices[parsed.rounds] / parsed.initialPrice - 1
    if (path.shortSqueezed) {
      shortSqueezePaths += 1
      if (path.squeezeRound >= 0) squeezeRoundSum += path.squeezeRound
    }
    if (path.longSqueezed) longSqueezePaths += 1
    if (path.shortSqueezed && totalReturn > 0) events.squeeze += 1
    else if (path.longSqueezed && totalReturn < 0) events.crash += 1
    else if (Math.abs(totalReturn) <= parsed.stalemateBand) events.stalemate += 1
    else events.other += 1
  }

  const result: SimulateResult = {
    initialPrice: parsed.initialPrice,
    rounds: parsed.rounds,
    paths: parsed.paths,
    bands,
    samplePaths: pathResults.slice(0, Math.min(20, parsed.paths)).map((path) =>
      Array.from(path.prices, (value) => round(value, 4)),
    ),
    finalHistogram,
    pnl: { long: summarize(longPnlSorted), short: summarize(shortPnlSorted) },
    maxDrawdown: summarize(drawdownSorted),
    events: {
      squeeze: round(events.squeeze / parsed.paths, 6),
      crash: round(events.crash / parsed.paths, 6),
      stalemate: round(events.stalemate / parsed.paths, 6),
      other: round(events.other / parsed.paths, 6),
    },
    cascade: {
      shortSqueezed: round(shortSqueezePaths / parsed.paths, 6),
      longSqueezed: round(longSqueezePaths / parsed.paths, 6),
      squeezeRoundMean: shortSqueezePaths > 0 ? round(squeezeRoundSum / shortSqueezePaths, 4) : -1,
    },
  }

  const medianReturn = result.bands.p50[parsed.rounds] / parsed.initialPrice - 1
  const p5Return = result.bands.p5[parsed.rounds] / parsed.initialPrice - 1
  const p95Return = result.bands.p95[parsed.rounds] / parsed.initialPrice - 1
  const eventPct = (value: number): string => `${(value * 100).toFixed(1)}%`
  const drawdownText = (value: number): string => `${(value * 100).toFixed(1)}%`
  const parts: string[] = [
    `ABM 蒙特卡洛（${parsed.paths} 路径 × ${parsed.rounds} 轮，种子 ${seed}）：` +
      `终值中位 ${pct(medianReturn)}（P5 ${pct(p5Return)} ~ P95 ${pct(p95Return)}）。`,
    `事件概率：挤空 ${eventPct(result.events.squeeze)} / 踩踏 ${eventPct(result.events.crash)} / ` +
      `僵持 ${eventPct(result.events.stalemate)} / 其它 ${eventPct(result.events.other)}。`,
    `累积盈亏中位：多头 ${pct(result.pnl.long.p50)}、空头 ${pct(result.pnl.short.p50)}；` +
      `最大回撤中位 ${drawdownText(result.maxDrawdown.p50)}（P95 ${drawdownText(result.maxDrawdown.p95)}）。`,
  ]
  if (result.cascade.shortSqueezed > 0) {
    const roundText =
      result.cascade.squeezeRoundMean >= 0 ? `（中位触发约第 ${result.cascade.squeezeRoundMean.toFixed(0)} 轮）` : ''
    parts.push(`空头级联触发路径占比 ${eventPct(result.cascade.shortSqueezed)}${roundText}，挤空风险需关注。`)
  }

  return {
    result,
    stats: {
      squeezeProb: result.events.squeeze,
      crashProb: result.events.crash,
      stalemateProb: result.events.stalemate,
      otherProb: result.events.other,
      medianReturn: round(medianReturn),
      p5Return: round(p5Return),
      p95Return: round(p95Return),
      maxDrawdownP50: result.maxDrawdown.p50,
      maxDrawdownP95: result.maxDrawdown.p95,
      shortSqueezeRatio: result.cascade.shortSqueezed,
      longSqueezeRatio: result.cascade.longSqueezed,
    },
    narrative: parts.join(''),
    params: {
      initialPrice: parsed.initialPrice,
      lambda: parsed.lambda,
      sigma: parsed.sigma,
      rounds: parsed.rounds,
      paths: parsed.paths,
      longWeight: parsed.longWeight,
      shortWeight: parsed.shortWeight,
      arbWeight: parsed.arbWeight,
      mmLiquidity: parsed.mmLiquidity,
      retailNoise: parsed.retailNoise,
      cascadeThreshold: parsed.cascadeThreshold,
      cascadeFlow: parsed.cascadeFlow,
      momentumWindow: parsed.momentumWindow,
      momentumScale: parsed.momentumScale,
      stalemateBand: parsed.stalemateBand,
      ...(parsed.shockEvents.length > 0 ? { shockEvents: parsed.shockEvents.map((event) => ({ ...event })) } : {}),
    },
    warnings: reader.warnings,
  }
}
