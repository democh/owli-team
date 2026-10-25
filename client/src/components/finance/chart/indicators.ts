/**
 * 自研指标注册（M83 §5.1）：KCB 肯特纳 / ST 超级趋势 / DONCHIAN 唐奇安 / ICHIMOKU 一目均衡 + ATR。
 * - SAR 用 klinecharts 内置，不重复实现；
 * - registerIndicator 幂等（getSupportedIndicators 守卫，重复调用安全）；
 * - ICHIMOKU 以五线输出（云区 draw 回调留待后续批，先保证口径与线型）；
 * - 类型以 `as never` 桥接（v10 类型偏严，项目统一模式）。
 */
import { getSupportedIndicators, registerIndicator } from 'klinecharts'

interface Bar {
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/** 指数移动平均（首值为首数据点；与 K 线内核 MA/EMA 口径一致） */
function emaOf(values: number[], period: number): number[] {
  const out: number[] = []
  const alpha = 2 / (period + 1)
  for (let i = 0; i < values.length; i++) {
    out.push(i === 0 ? values[0] : alpha * values[i] + (1 - alpha) * out[i - 1])
  }
  return out
}

/** Wilder 平滑（ATR 口径） */
function wilderOf(values: number[], period: number): Array<number | null> {
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

/** ATR（TR 的 Wilder 平滑；首根 TR = high − low） */
function atrOf(bars: Bar[], period: number): Array<number | null> {
  if (bars.length === 0) return []
  const tr: number[] = [bars[0].high - bars[0].low]
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].close
    tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose)))
  }
  return wilderOf(tr, period)
}

/** 窗口极值（前 n-1 期为 null） */
function rollingExtreme(values: number[], period: number, kind: 'max' | 'min'): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null)
  for (let i = period - 1; i < values.length; i++) {
    let best = kind === 'max' ? -Infinity : Infinity
    for (let j = i - period + 1; j <= i; j++) best = kind === 'max' ? Math.max(best, values[j]) : Math.min(best, values[j])
    out[i] = best
  }
  return out
}

let registered = false

/** 幂等注册全部自研指标（每次 init 后调用安全） */
export function registerMarketIndicators(): void {
  if (registered) return
  registered = true
  const supported = getSupportedIndicators()

  // ATR（klinecharts 内置不含；口径 [14]，供分析表达复用）
  if (!supported.includes('ATR')) {
    registerIndicator({
      name: 'ATR',
      shortName: 'ATR',
      calcParams: [14],
      figures: [{ key: 'atr', title: 'ATR: ', type: 'line' }],
      calc: (dataList: Bar[], indicator: { calcParams: unknown[] }) => {
        const period = typeof indicator.calcParams[0] === 'number' ? (indicator.calcParams[0] as number) : 14
        const series = atrOf(dataList, period)
        return series.map((v) => (v === null ? {} : { atr: v }))
      },
    } as never)
  }

  // KCB 肯特纳通道：EMA20 中轴 ± 2×ATR10
  if (!supported.includes('KCB')) {
    registerIndicator({
      name: 'KCB',
      shortName: 'KCB',
      calcParams: [20, 10, 2],
      figures: [
        { key: 'mid', title: 'MID: ', type: 'line' },
        { key: 'up', title: 'UP: ', type: 'line' },
        { key: 'dn', title: 'DN: ', type: 'line' },
      ],
      calc: (dataList: Bar[], indicator: { calcParams: unknown[] }) => {
        const [emaP, atrP, mult] = [0, 1, 2].map((i) => (typeof indicator.calcParams[i] === 'number' ? (indicator.calcParams[i] as number) : [20, 10, 2][i]))
        const mid = emaOf(dataList.map((b) => b.close), emaP)
        const atr = atrOf(dataList, atrP)
        return dataList.map((_, i) => {
          const a = atr[i]
          if (a === null || a === undefined) return {}
          return { mid: mid[i], up: mid[i] + mult * a, dn: mid[i] - mult * a }
        })
      },
    } as never)
  }

  // ST 超级趋势：中线 ± 3×ATR10 按方向棘轮推进（两线输出：多头红 / 空头绿）
  if (!supported.includes('ST')) {
    registerIndicator({
      name: 'ST',
      shortName: 'ST',
      calcParams: [10, 3],
      figures: [
        { key: 'stUp', title: 'ST多: ', type: 'line', styles: () => ({ color: '#dc2828' }) },
        { key: 'stDn', title: 'ST空: ', type: 'line', styles: () => ({ color: '#0fa975' }) },
      ],
      calc: (dataList: Bar[], indicator: { calcParams: unknown[] }) => {
        const [atrP, mult] = [0, 1].map((i) => (typeof indicator.calcParams[i] === 'number' ? (indicator.calcParams[i] as number) : [10, 3][i]))
        const atr = atrOf(dataList, atrP)
        const out: Array<Record<string, number | undefined>> = []
        let finalUpper = -Infinity
        let finalLower = Infinity
        let direction = 1
        let hasDir = false
        for (let i = 0; i < dataList.length; i++) {
          const a = atr[i]
          const bar = dataList[i]
          if (a === null || a === undefined) {
            out.push({})
            continue
          }
          const hl2 = (bar.high + bar.low) / 2
          const upperBasic = hl2 + mult * a
          const lowerBasic = hl2 - mult * a
          finalUpper = upperBasic < finalUpper || (out[i - 1] && bar.close > finalUpper) ? upperBasic : finalUpper
          finalLower = lowerBasic > finalLower || (out[i - 1] && bar.close < finalLower) ? lowerBasic : finalLower
          if (!hasDir) {
            direction = 1
            hasDir = true
          } else if (bar.close > finalUpper) direction = 1
          else if (bar.close < finalLower) direction = -1
          const st = direction > 0 ? finalLower : finalUpper
          out.push(direction > 0 ? { stUp: st, stDn: undefined } : { stUp: undefined, stDn: st })
        }
        return out
      },
    } as never)
  }

  // DONCHIAN 唐奇安通道：N 根最高 / 最低 + 中轴
  if (!supported.includes('DONCHIAN')) {
    registerIndicator({
      name: 'DONCHIAN',
      shortName: 'DONCHIAN',
      calcParams: [20],
      figures: [
        { key: 'up', title: 'UP: ', type: 'line' },
        { key: 'mid', title: 'MID: ', type: 'line' },
        { key: 'dn', title: 'DN: ', type: 'line' },
      ],
      calc: (dataList: Bar[], indicator: { calcParams: unknown[] }) => {
        const period = typeof indicator.calcParams[0] === 'number' ? (indicator.calcParams[0] as number) : 20
        const up = rollingExtreme(dataList.map((b) => b.high), period, 'max')
        const dn = rollingExtreme(dataList.map((b) => b.low), period, 'min')
        return dataList.map((_, i) => {
          const u = up[i]
          const d = dn[i]
          if (u === null || d === null) return {}
          return { up: u, mid: (u + d) / 2, dn: d }
        })
      },
    } as never)
  }

  // ICHIMOKU 一目均衡：转换线(9) / 基准线(26) / 先行带A·B(52, 前移 26) / 迟行线(26, 后移 26)
  if (!supported.includes('ICHIMOKU')) {
    registerIndicator({
      name: 'ICHIMOKU',
      shortName: 'ICHIMOKU',
      calcParams: [9, 26, 52],
      figures: [
        { key: 'tenkan', title: 'TENKAN: ', type: 'line', styles: () => ({ color: '#2563eb' }) },
        { key: 'kijun', title: 'KIJUN: ', type: 'line', styles: () => ({ color: '#dc2626' }) },
        { key: 'senkouA', title: 'SENKOU A: ', type: 'line' },
        { key: 'senkouB', title: 'SENKOU B: ', type: 'line' },
        { key: 'chikou', title: 'CHIKOU: ', type: 'line', styles: () => ({ color: '#9333ea', style: 'dashed' }) },
      ],
      calc: (dataList: Bar[], indicator: { calcParams: unknown[] }) => {
        const [tenkanP, kijunP, senkouP] = [0, 1, 2].map((i) => (typeof indicator.calcParams[i] === 'number' ? (indicator.calcParams[i] as number) : [9, 26, 52][i]))
        const n = dataList.length
        const highs = dataList.map((b) => b.high)
        const lows = dataList.map((b) => b.low)
        const closes = dataList.map((b) => b.close)
        const hh = (period: number): Array<number | null> => rollingExtreme(highs, period, 'max')
        const ll = (period: number): Array<number | null> => rollingExtreme(lows, period, 'min')
        const tenkan = hh(tenkanP).map((h, i) => {
          const l = ll(tenkanP)[i]
          return h === null || l === null ? null : (h + l) / 2
        })
        const kijun = hh(kijunP).map((h, i) => {
          const l = ll(kijunP)[i]
          return h === null || l === null ? null : (h + l) / 2
        })
        const senkouBRaw = hh(senkouP).map((h, i) => {
          const l = ll(senkouP)[i]
          return h === null || l === null ? null : (h + l) / 2
        })
        return dataList.map((_, i) => {
          const shift = kijunP >= 0 ? kijunP : 26
          const aSrc = i - shift >= 0 ? (tenkan[i - shift] ?? null) : null
          const bSrc = i - shift >= 0 ? (kijun[i - shift] ?? null) : null
          const senkouA = aSrc === null || bSrc === null ? null : (aSrc + bSrc) / 2
          const senkouB = i - shift >= 0 ? (senkouBRaw[i - shift] ?? null) : null
          const chikou = i + shift < n ? closes[i + shift] : null
          const row: Record<string, number> = {}
          if (tenkan[i] !== null) row.tenkan = tenkan[i] as number
          if (kijun[i] !== null) row.kijun = kijun[i] as number
          if (senkouA !== null) row.senkouA = senkouA
          if (senkouB !== null) row.senkouB = senkouB
          if (chikou !== null) row.chikou = chikou
          return row
        })
      },
    } as never)
  }
}

/** 主图指标集合（切换时按名移除） */
export const MAIN_PANE_INDICATOR_NAMES = ['MA', 'EMA', 'BOLL', 'KCB', 'SAR', 'ICHIMOKU', 'ST', 'DONCHIAN'] as const
/** 副图指标集合（固定 paneId 一一对应） */
export const SUB_INDICATOR_NAMES = ['VOL', 'MACD', 'KDJ', 'RSI', 'ATR'] as const

/** 副图指标 → 固定 paneId（重复创建即替换语义） */
export function subPaneIdOf(name: string): string {
  return `${name.toLowerCase()}_pane`
}
