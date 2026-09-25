/**
 * K 线分析引擎（M83 §4.2）：`analyzeKline` 主编排（纯函数，零网络，确定性）。
 *
 * 同一 bars + 参数 ⇒ 同一结果（asOf 除外）；引擎零 LLM 调用——
 * 短文案由确定性模板生成，深度解读留给 Agent 在 facts 之上撰写。
 */
import type { KlineAnalysis } from '@multi-agent/shared'
import type { KlineBar } from '../types.js'
import { ANALYSIS_PARAMS, buildContext } from './types.js'
import { PHASE_CN, detectPhases } from './phase.js'
import { findLevels } from './levels.js'
import { analyzeSentiment } from './sentiment.js'
import { findFeatures } from './features.js'
import { buildAnalysisDrawings } from './drawings.js'

export * from './types.js'
export * from './phase.js'
export * from './levels.js'
export * from './sentiment.js'
export * from './features.js'
export * from './drawings.js'

export interface AnalyzeKlineMeta {
  period: string
  adjust: string
  /** 结果时间戳（测试可注入；缺省当前时间） */
  now?: Date
}

/** 分析主编排（bars 为空抛错；由工具层转为错误卡） */
export function analyzeKline(bars: KlineBar[], meta: AnalyzeKlineMeta): KlineAnalysis {
  if (bars.length === 0) throw new Error('无 K 线数据')
  const ctx = buildContext(bars)
  const phases = detectPhases(ctx)
  // 样本不足：置信度降档（×0.7）+ notes 声明（设计稿 §4.2）
  const insufficient = bars.length < ANALYSIS_PARAMS.minBars
  if (insufficient) phases.confidence = Math.round(phases.confidence * 0.7)
  const sentiment = analyzeSentiment(ctx)
  const findings = findLevels(ctx)
  const features = findFeatures(ctx)
  const drawings = buildAnalysisDrawings(ctx, findings, PHASE_CN[phases.current])
  const notes = [
    '阶段判定为规则化统计口径，仅供复盘研究',
    '关键位为摆动点聚类口径（±1.2% 容差 / 同类最短间隔 8 根）',
    '市场情绪为多因子加权（0-100），不构成涨跌预测',
    ...(insufficient ? [`样本不足（${bars.length} 根 < ${ANALYSIS_PARAMS.minBars} 根）：阶段与关键位结论仅供参考`] : []),
  ]
  return {
    asOf: (meta.now ?? new Date()).toISOString(),
    bars: bars.length,
    period: meta.period,
    adjust: meta.adjust,
    phases,
    sentiment,
    levels: findings.levels,
    features,
    drawings,
    notes,
  }
}
