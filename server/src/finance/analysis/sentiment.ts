/**
 * 市场情绪周期（M83 §4.2）：多因子加权 0–100 → 五档。
 *
 * 权重：趋势 40% + 量能 20% + 波动 15% + 位置 15% + 涨速 10%；
 * 分档：恐慌 0–20 / 犹豫 20–45 / 修复 45–65 / 乐观 65–85 / 狂热 85–100。
 * 口径：规则化统计（非涨跌预测），路径标签固定「恐慌→犹豫→修复→乐观→狂热」。
 */
import type { KlineAnalysisSentiment, SentimentStage } from '@multi-agent/shared'
import { clamp, rangePosition, scale01, type AnalysisContext } from './types.js'

/** 情绪档位中文名 */
export const SENTIMENT_CN: Record<SentimentStage, string> = {
  panic: '恐慌',
  hesitate: '犹豫',
  repair: '修复',
  optimistic: '乐观',
  euphoric: '狂热',
}

/** 固定路径标签 */
export const SENTIMENT_PATH = '恐慌→犹豫→修复→乐观→狂热'

/** 分数 → 档位 */
export function sentimentStageOf(score: number): SentimentStage {
  if (score < 20) return 'panic'
  if (score < 45) return 'hesitate'
  if (score < 65) return 'repair'
  if (score < 85) return 'optimistic'
  return 'euphoric'
}

/** 情绪判定主入口 */
export function analyzeSentiment(ctx: AnalysisContext): KlineAnalysisSentiment {
  const i = ctx.n - 1
  const close = ctx.closes[i]
  const ma20 = ctx.ma20[i]
  const ma60 = ctx.ma60[i]
  const back = Math.max(0, i - 10)
  const slope20 = ma20 !== null && ctx.ma20[back] !== null && ctx.ma20[back]! > 0 ? ma20 / ctx.ma20[back]! - 1 : null

  // ① 趋势（±1 → 0..1）
  let trendRaw = 0
  if (ma20 !== null) trendRaw += close > ma20 ? 0.3 : -0.3
  if (ma20 !== null && ma60 !== null) trendRaw += ma20 > ma60 ? 0.3 : -0.3
  if (slope20 !== null) trendRaw += slope20 > 0 ? 0.2 : -0.2
  if (ma60 !== null) trendRaw += close > ma60 ? 0.2 : -0.2
  const trend01 = clamp((trendRaw + 1) / 2, 0, 1)

  // ② 量能活跃度（量比 0.5–1.5 映射到 0.3–0.8）
  const vr = ctx.volRatio[i]
  const volume01 = vr === null ? 0.5 : 0.3 + 0.5 * scale01(vr, 0.5, 1.5)

  // ③ 波动分位（ATR% 在近期窗口中的位置）
  const atrFrom = Math.max(0, i - 120 + 1)
  const atrWindow = ctx.atrPct.slice(atrFrom, i + 1)
  let vol01 = 0.5
  if (atrWindow.length > 0) {
    let below = 0
    for (const v of atrWindow) if (v <= ctx.atrPct[i]) below++
    vol01 = below / atrWindow.length
  }

  // ④ 位置（区间分位）
  const pos01 = rangePosition(ctx, i) ?? 0.5

  // ⑤ 涨速（近 10 根涨跌幅 ±15% 映射 0..1）
  const ret10 = i >= 10 && ctx.closes[i - 10] > 0 ? close / ctx.closes[i - 10] - 1 : 0
  const mom01 = clamp(0.5 + ret10 / 0.3, 0, 1)

  const score = Math.round(clamp(40 * trend01 + 20 * volume01 + 15 * vol01 + 15 * pos01 + 10 * mom01, 0, 100))
  const stage = sentimentStageOf(score)
  return { score, stage, pathLabel: `${SENTIMENT_PATH}（当前：${SENTIMENT_CN[stage]}）` }
}
