/**
 * 底部 / 形态特征标签（M83 §4.2）：地量地价 / 筹码集中 / 平台整理 / 三角形整理。
 *
 * 口径纪律：confirmed=false 表示近似口径（如筹码集中为量价代理），UI 以描边区分；
 * 仅输出「命中的」标签（未命中不占位）；顺序固定，便于测试与展示稳定。
 */
import type { KlineFeatureTag } from '@multi-agent/shared'
import { sma } from '../indicator.js'
import { ANALYSIS_PARAMS, percentileRank, windowExtreme, type AnalysisContext } from './types.js'

/** 特征中文名（与服务端输出 key 一一对应） */
export const FEATURE_LABELS: Record<string, string> = {
  'dry-volume-price': '地量地价',
  'chip-concentration': '筹码集中',
  platform: '平台整理',
  triangle: '三角形整理',
}

/** 特征判定主入口（仅返回命中项，顺序固定） */
export function findFeatures(ctx: AnalysisContext): KlineFeatureTag[] {
  const out: KlineFeatureTag[] = []
  const i = ctx.n - 1
  const close = ctx.closes[i]

  // ① 地量地价：5 日均量分位 ≤15% 且收盘价分位 ≤20%（双低）
  const vol5 = sma(ctx.volumes, 5)
  const vol5From = Math.max(0, i - 120 + 1)
  const vol5Window: number[] = []
  for (let j = vol5From; j <= i; j++) if (vol5[j] !== null) vol5Window.push(vol5[j]!)
  const closeFrom = Math.max(0, i - 120 + 1)
  const closeWindow = ctx.closes.slice(closeFrom, i + 1)
  if (
    vol5Window.length >= 20 &&
    percentileRank(vol5Window, vol5[i] ?? 0) <= ANALYSIS_PARAMS.dryVolumeQuantile &&
    percentileRank(closeWindow, close) <= ANALYSIS_PARAMS.dryPriceQuantile
  ) {
    out.push({ key: 'dry-volume-price', label: FEATURE_LABELS['dry-volume-price'], confirmed: true })
  }

  // ② 筹码集中（近似口径）：近 60 根中位价为带心、±5% 带内成交量占比 ≥60%
  const chipFrom = Math.max(0, i - 60 + 1)
  const chipCloses = ctx.closes.slice(chipFrom, i + 1)
  if (chipCloses.length >= 30) {
    const center = median(chipCloses)
    const band = center * ANALYSIS_PARAMS.chipBandPct
    let inBand = 0
    let total = 0
    for (let j = chipFrom; j <= i; j++) {
      total += ctx.volumes[j]
      if (Math.abs(ctx.closes[j] - center) <= band) inBand += ctx.volumes[j]
    }
    if (total > 0 && inBand / total >= ANALYSIS_PARAMS.chipShare) {
      out.push({ key: 'chip-concentration', label: FEATURE_LABELS['chip-concentration'], confirmed: false })
    }
  }

  // ③ 平台整理：近 20 根振幅 ≤10%
  const pw = ANALYSIS_PARAMS.platformWindow
  if (ctx.n >= pw) {
    const hi = windowExtreme(ctx.highs, i - pw + 1, i, 'max')
    const lo = windowExtreme(ctx.lows, i - pw + 1, i, 'min')
    if (hi && lo && lo.value > 0 && (hi.value - lo.value) / lo.value <= ANALYSIS_PARAMS.platformAmplitude) {
      out.push({ key: 'platform', label: FEATURE_LABELS.platform, confirmed: true })
    }
  }

  // ④ 三角形整理：近 40 根（前后各 20 根）区间收敛 ≥30%
  const tw = ANALYSIS_PARAMS.triangleWindow
  if (ctx.n >= tw) {
    const from = i - tw + 1
    const mid = from + Math.floor(tw / 2) - 1
    const h1 = windowExtreme(ctx.highs, from, mid, 'max')
    const l1 = windowExtreme(ctx.lows, from, mid, 'min')
    const h2 = windowExtreme(ctx.highs, mid + 1, i, 'max')
    const l2 = windowExtreme(ctx.lows, mid + 1, i, 'min')
    if (h1 && l1 && h2 && l2) {
      const r1 = h1.value - l1.value
      const r2 = h2.value - l2.value
      if (r1 > 0 && 1 - r2 / r1 >= ANALYSIS_PARAMS.triangleShrink) {
        out.push({ key: 'triangle', label: FEATURE_LABELS.triangle, confirmed: true })
      }
    }
  }

  return out
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}
