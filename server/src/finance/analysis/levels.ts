/**
 * 关键位（M83 §4.2）：摆动点聚类 → 支撑 / 压力；箱体识别 → 量度目标。
 *
 * 口径（设计稿固化）：
 * - 摆动点：swing high = high[i] 为左右各 3 根窗口的严格最大值（swing low 对称）；
 * - 聚类：近 120 根内 ±1.2% 容差合并、同类最短间隔 8 根、按触碰次数排序；
 * - basis：触 3 次及以上记「密集区」，否则「前高 / 前低」；
 * - 量度目标：箱体（上下沿重叠比 ≥60% 且振幅 ≤35%）→ 箱高量度；无箱体 → 前高延伸。
 */
import type { KlineAnalysisLevels, KlineLevelRef, KlineTargetRef } from '@multi-agent/shared'
import { ANALYSIS_PARAMS, windowExtreme, type AnalysisContext } from './types.js'

export interface SwingPoint {
  index: number
  price: number
}

export interface BoxFinding {
  fromIndex: number
  toIndex: number
  top: number
  bottom: number
}

export interface LevelFindings {
  levels: KlineAnalysisLevels
  box: BoxFinding | null
  /** 最近一个摆动低点（落图 textLabel 用；窗口内无则 null） */
  recentSwingLow: SwingPoint | null
}

/** 摆动点检测（左右各 swingWindow 根非严格极值：容平；平底/平顶由聚类合并为同一触碰位） */
export function findSwingPoints(ctx: AnalysisContext, kind: 'high' | 'low'): SwingPoint[] {
  const w = ANALYSIS_PARAMS.swingWindow
  const src = kind === 'high' ? ctx.highs : ctx.lows
  const raw: SwingPoint[] = []
  for (let i = w; i < ctx.n - w; i++) {
    let isSwing = true
    for (let j = i - w; j <= i + w; j++) {
      if (j === i) continue
      // 非严格：邻居严格更极端才否决（等值不算否决——平底容平）
      if (kind === 'high' ? src[j] > src[i] : src[j] < src[i]) {
        isSwing = false
        break
      }
    }
    if (isSwing) raw.push({ index: i, price: src[i] })
  }
  // 同类最短间隔：8 根内只保留更极端者
  const gap = ANALYSIS_PARAMS.clusterGap
  const out: SwingPoint[] = []
  for (const p of raw) {
    const last = out[out.length - 1]
    if (last && p.index - last.index < gap) {
      const keep = kind === 'high' ? Math.max(last.price, p.price) : Math.min(last.price, p.price)
      if (keep === p.price) out[out.length - 1] = p
    } else {
      out.push(p)
    }
  }
  return out
}

interface Cluster {
  price: number
  touches: number
  lastIndex: number
}

/** 近 window 根内聚类（±容差、价格升序贪心合并） */
function clusterPoints(points: SwingPoint[], window: number, n: number): Cluster[] {
  const tol = ANALYSIS_PARAMS.clusterTolerance
  const recent = points.filter((p) => p.index >= n - window)
  const sorted = [...recent].sort((a, b) => a.price - b.price)
  const clusters: Cluster[] = []
  for (const p of sorted) {
    const last = clusters[clusters.length - 1]
    if (last && Math.abs(p.price - last.price) / last.price <= tol) {
      last.price = (last.price * last.touches + p.price) / (last.touches + 1)
      last.touches += 1
      last.lastIndex = Math.max(last.lastIndex, p.index)
    } else {
      clusters.push({ price: p.price, touches: 1, lastIndex: p.index })
    }
  }
  return clusters
}

function toRef(c: Cluster, kind: 'high' | 'low'): KlineLevelRef {
  return {
    price: round2(c.price),
    basis: c.touches >= 3 ? '密集区' : kind === 'high' ? '前高' : '前低',
    touches: c.touches,
  }
}

/** 箱体识别（上下沿中带重叠比 ≥ 阈值且振幅受限） */
export function findBox(ctx: AnalysisContext): BoxFinding | null {
  const p = ANALYSIS_PARAMS
  if (ctx.n < p.boxWindowMin) return null
  const from = Math.max(0, ctx.n - p.boxWindowMax)
  const to = ctx.n - 1
  const w = to - from + 1
  const top = windowExtreme(ctx.highs, from, to, 'max')
  const bottom = windowExtreme(ctx.lows, from, to, 'min')
  if (!top || !bottom || bottom.value <= 0) return null
  const h = top.value - bottom.value
  if (h / bottom.value > p.boxAmplitudeMax) return null
  const bandLow = bottom.value + 0.25 * h
  const bandHigh = bottom.value + 0.75 * h
  let overlap = 0
  for (let i = from; i <= to; i++) {
    if (ctx.highs[i] >= bandLow && ctx.lows[i] <= bandHigh) overlap++
  }
  if (overlap / w < p.boxOverlap) return null
  return { fromIndex: from, toIndex: to, top: round2(top.value), bottom: round2(bottom.value) }
}

/** 关键位主入口 */
export function findLevels(ctx: AnalysisContext): LevelFindings {
  const p = ANALYSIS_PARAMS
  const close = ctx.closes[ctx.n - 1] ?? 0
  const highClusters = clusterPoints(findSwingPoints(ctx, 'high'), p.rangeWindow, ctx.n)
  const lowClusters = clusterPoints(findSwingPoints(ctx, 'low'), p.rangeWindow, ctx.n)

  const belowLows = lowClusters.filter((c) => c.price < close)
  const aboveHighs = highClusters.filter((c) => c.price > close)
  const supportCluster = belowLows.length > 0 ? belowLows.reduce((a, b) => (b.price > a.price ? b : a)) : null
  const resistanceCluster = aboveHighs.length > 0 ? aboveHighs.reduce((a, b) => (b.price < a.price ? b : a)) : null

  // 量度目标：箱体量度优先，否则前高延伸
  const box = findBox(ctx)
  let target: KlineTargetRef | null = null
  if (box) {
    const h = box.top - box.bottom
    const price = close < box.bottom ? box.bottom - h : box.top + h
    target = { price: round2(price), basis: `箱体量度（${box.bottom} ~ ${box.top}）` }
  } else {
    const hi = windowExtreme(ctx.highs, Math.max(0, ctx.n - 250), ctx.n - 1, 'max')
    if (hi) target = { price: round2(hi.value), basis: '前高延伸' }
  }

  const lows = findSwingPoints(ctx, 'low')
  const recentSwingLow = lows.length > 0 ? lows[lows.length - 1] : null

  return {
    levels: {
      support: supportCluster ? toRef(supportCluster, 'low') : null,
      resistance: resistanceCluster ? toRef(resistanceCluster, 'high') : null,
      target,
    },
    box,
    recentSwingLow,
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}
