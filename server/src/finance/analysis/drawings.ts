/**
 * 分析结论 → 落图（M83 §4.2）：中枢 / 箱体、支撑 / 压力 / 量度目标、探底位。
 *
 * 输出为 shared `Drawing[]`（groupId='analysis'），由客户端 chart/drawings 引擎统一消费——
 * 客户端零特判；id 确定性（同数据同 id），便于幂等重画与测试断言。
 */
import type { Drawing } from '@multi-agent/shared'
import type { AnalysisContext } from './types.js'
import type { LevelFindings } from './levels.js'

export const ANALYSIS_GROUP = 'analysis'

/** 落图配色（与客户端 phaseColors / 主题同族） */
export const ANALYSIS_COLORS = {
  support: '#0fa975',
  resistance: '#dc2828',
  target: '#f59e0b',
  box: '#8b5cf6',
  low: '#0ea5e9',
} as const

/** 分析落图构造（顺序固定：中枢 → 支撑 → 压力 → 目标 → 探底位） */
export function buildAnalysisDrawings(ctx: AnalysisContext, findings: LevelFindings, phaseCn: string): Drawing[] {
  const drawings: Drawing[] = []
  const lastTs = ctx.bars[ctx.n - 1].timestamp

  // ① 箱体 / 中枢
  if (findings.box) {
    const w = findings.box.toIndex - findings.box.fromIndex + 1
    drawings.push({
      id: 'an-box',
      kind: 'zone',
      groupId: ANALYSIS_GROUP,
      points: [
        { ts: ctx.bars[findings.box.fromIndex].timestamp, price: findings.box.top },
        { ts: lastTs, price: findings.box.bottom },
      ],
      label: '中枢',
      style: { color: ANALYSIS_COLORS.box },
      explain: `近 ${w} 根重叠区间（上沿 ${findings.box.top} / 下沿 ${findings.box.bottom}）`,
    })
  }

  // ② 支撑（水平线）
  const support = findings.levels.support
  if (support) {
    drawings.push({
      id: 'an-support',
      kind: 'hline',
      groupId: ANALYSIS_GROUP,
      points: [{ ts: lastTs, price: support.price }],
      label: `支撑 ${support.price}（${support.basis} · 触碰 ${support.touches} 次）`,
      style: { color: ANALYSIS_COLORS.support },
    })
  }

  // ③ 压力（水平线）
  const resistance = findings.levels.resistance
  if (resistance) {
    drawings.push({
      id: 'an-resistance',
      kind: 'hline',
      groupId: ANALYSIS_GROUP,
      points: [{ ts: lastTs, price: resistance.price }],
      label: `压力 ${resistance.price}（${resistance.basis} · 触碰 ${resistance.touches} 次）`,
      style: { color: ANALYSIS_COLORS.resistance },
    })
  }

  // ④ 量度目标（虚线）
  const target = findings.levels.target
  if (target) {
    drawings.push({
      id: 'an-target',
      kind: 'hline',
      groupId: ANALYSIS_GROUP,
      points: [{ ts: lastTs, price: target.price }],
      label: `量度目标 ${target.price}（${target.basis}）`,
      style: { color: ANALYSIS_COLORS.target, dash: true },
    })
  }

  // ⑤ 探底位（近期摆动低点，仅在近 30 根内才落，避免陈旧标注）
  const low = findings.recentSwingLow
  if (low && low.index >= ctx.n - 30) {
    drawings.push({
      id: 'an-low',
      kind: 'textLabel',
      groupId: ANALYSIS_GROUP,
      points: [{ ts: ctx.bars[low.index].timestamp, price: round2(low.price) }],
      label: `探底 ${round2(low.price)}`,
      style: { color: ANALYSIS_COLORS.low },
      explain: `当前阶段：${phaseCn}`,
    })
  }

  return drawings
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}
