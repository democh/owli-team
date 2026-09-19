/**
 * Node 自研技术指标库（M34 §3.3「技术指标：ta（Py）主源，Node 兜底」）。
 *
 * 口径说明（与常见软件对齐）：
 *   - MA / EMA：EMA α = 2/(n+1)；
 *   - MACD(12,26,9)：DIF=EMA12−EMA26，DEA=EMA(DIF,9)，柱=(DIF−DEA)×2；
 *   - RSI(14)：Wilder 平滑；KDJ(9,3,3)：RSV 的 SMA(3,1) 递归；
 *   - BOLL(20,2)：总体标准差；ATR(14)：TR 的 Wilder 平滑。
 * 全部纯函数：输入 KlineBar[]，输出与 bars 等长的点位序列（期数不足处 value=null）。
 */
import type { KlineBar } from './types.js'
import { formatCnDate } from './period.js'

export type IndicatorName = 'MA' | 'EMA' | 'MACD' | 'RSI' | 'KDJ' | 'BOLL' | 'ATR'

export interface IndicatorPoint {
  timestamp: number
  /** 各输出线值（期数不足为 null；键名如 MA5 / DIF / K） */
  values: Record<string, number | null>
}

export interface IndicatorSeries {
  name: IndicatorName
  /** 实际参数 */
  params: Record<string, number>
  points: IndicatorPoint[]
  /** 信号摘要（金叉 / 死叉 / 超买超卖；供报告引用） */
  signals: string[]
}

const DEFAULT_PARAMS: Record<IndicatorName, Record<string, number>> = {
  MA: { periods: 5 },
  EMA: { period: 12 },
  MACD: { fast: 12, slow: 26, signal: 9 },
  RSI: { period: 14 },
  KDJ: { n: 9, k: 3, d: 3 },
  BOLL: { period: 20, mult: 2 },
  ATR: { period: 14 },
}

/** 简单移动平均（前 n-1 期为 null） */
export function sma(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null)
  if (period <= 0) return out
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

/** 指数移动平均（首值用第一个数据点；输出长度与输入一致） */
export function ema(values: number[], period: number): number[] {
  const out: number[] = []
  const alpha = 2 / (period + 1)
  for (let i = 0; i < values.length; i++) {
    out.push(i === 0 ? values[0] : alpha * values[i] + (1 - alpha) * out[i - 1])
  }
  return out
}

/** Wilder 平滑（RSI / ATR 口径：首值 = 前 period 个的均值，之后递归） */
export function wilderSmooth(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null)
  if (values.length < period || period <= 0) return out
  let sum = 0
  for (let i = 0; i < period; i++) sum += values[i]
  let prev = sum / period
  out[period - 1] = prev
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period
    out[i] = prev
  }
  return out
}

/** 中国软件口径的 SMA(X, N, M)：Y = (M*X + (N-M)*Y') / N（KDJ 用） */
function cnSma(values: Array<number | null>, n: number, m: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null)
  let prev: number | null = null
  for (let i = 0; i < values.length; i++) {
    const x = values[i]
    if (x === null) continue
    prev = prev === null ? x : (m * x + (n - m) * prev) / n
    out[i] = prev
  }
  return out
}

function closes(bars: KlineBar[]): number[] {
  return bars.map((b) => b.close)
}

/** 计算指标（bars 为空时返回空序列） */
export function computeIndicator(
  name: IndicatorName,
  bars: KlineBar[],
  params: Record<string, number> = {},
): IndicatorSeries {
  const p = { ...DEFAULT_PARAMS[name], ...params }
  const c = closes(bars)
  const points: IndicatorPoint[] = bars.map((bar) => ({ timestamp: bar.timestamp, values: {} }))
  const signals: string[] = []

  switch (name) {
    case 'MA':
    case 'EMA': {
      const periods =
        name === 'MA' ? [5, 10, 20, 60].filter((n) => n <= Math.max(c.length, 5)) : [p.period]
      for (const n of periods) {
        const series = name === 'MA' ? sma(c, n) : ema(c, n)
        for (let i = 0; i < bars.length; i++) {
          points[i].values[`${name}${n}`] = series[i] ?? null
        }
      }
      if (name === 'MA' && c.length > 20) {
        const ma5 = sma(c, 5)
        const ma20 = sma(c, 20)
        const cross = findCross(ma5, ma20)
        if (cross) signals.push(`MA5 ${cross.kind}MA20（${formatCnDate(bars[cross.index].timestamp)}）`)
      }
      break
    }
    case 'MACD': {
      const fast = p.fast
      const slow = p.slow
      const signalN = p.signal
      const emaFast = ema(c, fast)
      const emaSlow = ema(c, slow)
      const dif = emaFast.map((v, i) => v - emaSlow[i])
      const dea = ema(dif, signalN)
      for (let i = 0; i < bars.length; i++) {
        points[i].values.DIF = dif[i]
        points[i].values.DEA = dea[i]
        points[i].values.MACD = (dif[i] - dea[i]) * 2
      }
      const cross = findCross(dif, dea)
      if (cross) signals.push(`MACD ${cross.kind}（${formatCnDate(bars[cross.index].timestamp)}）`)
      break
    }
    case 'RSI': {
      const n = p.period
      const gains: number[] = [0]
      const losses: number[] = [0]
      for (let i = 1; i < c.length; i++) {
        const diff = c[i] - c[i - 1]
        gains.push(Math.max(diff, 0))
        losses.push(Math.max(-diff, 0))
      }
      const avgGain = wilderSmooth(gains, n)
      const avgLoss = wilderSmooth(losses, n)
      for (let i = 0; i < bars.length; i++) {
        const g = avgGain[i]
        const l = avgLoss[i]
        points[i].values[`RSI${n}`] = g === null || l === null ? null : l === 0 ? 100 : 100 - 100 / (1 + g / l)
      }
      const last = points[points.length - 1]?.values[`RSI${n}`]
      if (typeof last === 'number') {
        if (last >= 70) signals.push(`RSI${n}=${last.toFixed(1)}（超买区）`)
        else if (last <= 30) signals.push(`RSI${n}=${last.toFixed(1)}（超卖区）`)
      }
      break
    }
    case 'KDJ': {
      const n = p.n
      const rsv: Array<number | null> = new Array(bars.length).fill(null)
      for (let i = n - 1; i < bars.length; i++) {
        let hh = -Infinity
        let ll = Infinity
        for (let j = i - n + 1; j <= i; j++) {
          hh = Math.max(hh, bars[j].high)
          ll = Math.min(ll, bars[j].low)
        }
        rsv[i] = hh === ll ? 50 : ((c[i] - ll) / (hh - ll)) * 100
      }
      const k = cnSma(rsv, p.k, 1)
      const d = cnSma(k, p.d, 1)
      for (let i = 0; i < bars.length; i++) {
        const kv = k[i]
        const dv = d[i]
        points[i].values.K = kv
        points[i].values.D = dv
        points[i].values.J = kv === null || dv === null ? null : 3 * kv - 2 * dv
      }
      const cross = findCross(k, d)
      if (cross) signals.push(`KDJ ${cross.kind}（${formatCnDate(bars[cross.index].timestamp)}）`)
      break
    }
    case 'BOLL': {
      const n = p.period
      const mid = sma(c, n)
      for (let i = 0; i < bars.length; i++) {
        const mv = mid[i]
        if (mv === null) {
          points[i].values.MID = null
          points[i].values.UPPER = null
          points[i].values.LOWER = null
          continue
        }
        const start = i - n + 1
        let sum = 0
        for (let j = start; j <= i; j++) sum += (c[j] - mv) ** 2
        const sd = Math.sqrt(sum / n)
        points[i].values.MID = mv
        points[i].values.UPPER = mv + p.mult * sd
        points[i].values.LOWER = mv - p.mult * sd
      }
      const lastBar = bars[bars.length - 1]
      const lastVals = points[points.length - 1]?.values
      if (lastBar && lastVals && typeof lastVals.UPPER === 'number' && typeof lastVals.LOWER === 'number') {
        if (lastBar.close > lastVals.UPPER) signals.push('收盘价突破布林上轨')
        else if (lastBar.close < lastVals.LOWER) signals.push('收盘价跌破布林下轨')
      }
      break
    }
    case 'ATR': {
      // 首根 TR = high − low（与主流软件一致）；数据为空时保持空数组
      const tr: number[] = bars.length === 0 ? [] : [bars[0].high - bars[0].low]
      for (let i = 1; i < bars.length; i++) {
        const prevClose = bars[i - 1].close
        tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose)))
      }
      const atr = wilderSmooth(tr, p.period)
      for (let i = 0; i < bars.length; i++) points[i].values[`ATR${p.period}`] = atr[i]
      break
    }
  }

  return { name, params: p, points, signals }
}

/** 上穿/下穿检测（b 段逐点比较 a-b 符号变化；返回最近一次，含交叉点下标） */
function findCross(a: Array<number | null>, b: Array<number | null>): { kind: '金叉' | '死叉'; index: number } | null {
  let last: { kind: '金叉' | '死叉'; index: number } | null = null
  for (let i = 1; i < a.length; i++) {
    const a0 = a[i - 1]
    const b0 = b[i - 1]
    const a1 = a[i]
    const b1 = b[i]
    if (a0 === null || b0 === null || a1 === null || b1 === null) continue
    const prev = a0 - b0
    const cur = a1 - b1
    if (prev <= 0 && cur > 0) last = { kind: '金叉', index: i }
    else if (prev >= 0 && cur < 0) last = { kind: '死叉', index: i }
  }
  return last
}
