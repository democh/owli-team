/**
 * 博弈结果视图（M34 §6.4）：按模型分派渲染内核 + 结论 chips + narrative + 免责标注。
 * 消息块（GameBlock）与画布博弈节点（GameNode）共用；数据来自 game 快照（result/stats/narrative）。
 */
import * as React from 'react'
import { EvolveView } from './EvolveView'
import { MatrixView } from './MatrixView'
import { SequenceView } from './SequenceView'
import { SimulateView } from './SimulateView'
import { fmtNum, fmtPct, PLAYER_LABELS, type EvolveResult, type MatrixResult, type SequenceResult, type SimulateResult } from './types'
import type { GameModelName } from '../../lib/game-spec'

type Stats = Record<string, unknown>

function str(stats: Stats, key: string): string | undefined {
  const v = stats[key]
  return typeof v === 'string' ? v : undefined
}

function num(stats: Stats, key: string): number | undefined {
  const v = stats[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 结论 chips：按模型取服务端 stats 的可读要点（缺项自动跳过） */
export function gameStatsChips(model: GameModelName, stats: Stats | undefined): Array<{ label: string; value: string }> {
  if (!stats) return []
  const chips: Array<{ label: string; value: string }> = []
  const push = (label: string, value: string | undefined): void => {
    if (value !== undefined && value !== '') chips.push({ label, value })
  }
  if (model === 'matrix') {
    push('博弈结构', str(stats, 'gameTypeLabel'))
    const pure = num(stats, 'pureNashCount')
    const mixed = num(stats, 'mixedNashCount')
    if (pure !== undefined || mixed !== undefined) push('均衡', `纯 ${pure ?? 0} / 混合 ${mixed ?? 0}`)
    push('占优（多头）', str(stats, 'dominantLong'))
    push('占优（空头）', str(stats, 'dominantShort'))
  } else if (model === 'sequence') {
    push('先动方', str(stats, 'leader'))
    push('均衡路径', str(stats, 'equilibriumPath'))
    const leaderPayoff = num(stats, 'leaderPayoff')
    const followerPayoff = num(stats, 'followerPayoff')
    if (leaderPayoff !== undefined && followerPayoff !== undefined) {
      push('均衡收益', `${PLAYER_LABELS.long} ${fmtNum(leaderPayoff, 3, true)} / ${PLAYER_LABELS.short} ${fmtNum(followerPayoff, 3, true)}`)
    }
    const advantage = num(stats, 'firstMoverAdvantage')
    if (advantage !== undefined) push('先动优势', fmtNum(advantage, 3, true))
  } else if (model === 'evolve') {
    const stable = num(stats, 'stableCount')
    const fixed = num(stats, 'fixedPointCount')
    if (fixed !== undefined) push('固定点', `${fixed} 个（稳定 ${stable ?? 0}）`)
    const ess = stats.ess
    if (Array.isArray(ess) && ess.length > 0) push('ESS', ess.map((x) => fmtNum(x as number, 3)).join(' / '))
    if (stats.neutral === true) push('中性区间', '无渐进稳定解')
  } else if (model === 'simulate') {
    const squeeze = num(stats, 'squeezeProb')
    const crash = num(stats, 'crashProb')
    const stalemate = num(stats, 'stalemateProb')
    if (squeeze !== undefined) push('挤空', fmtPct(squeeze, 1))
    if (crash !== undefined) push('踩踏', fmtPct(crash, 1))
    if (stalemate !== undefined) push('僵持', fmtPct(stalemate, 1))
    const median = num(stats, 'medianReturn')
    if (median !== undefined) push('中位收益', fmtPct(median, 2, true))
    const dd = num(stats, 'maxDrawdownP95')
    if (dd !== undefined) push('回撤 P95', fmtPct(dd, 1))
  }
  return chips
}

export interface GameResultViewProps {
  model: GameModelName
  result: unknown
  stats?: Stats
  narrative?: string
  /** 随机种子（复现口径展示） */
  seed?: number
}

export function GameResultView({ model, result, stats, narrative, seed }: GameResultViewProps): React.JSX.Element {
  const kernel = (() => {
    if (typeof result !== 'object' || result === null) {
      return <div className="md-game-missing">结果数据缺失（快照不含 result 字段）</div>
    }
    switch (model) {
      case 'matrix':
        return <MatrixView result={result as MatrixResult} />
      case 'sequence':
        return <SequenceView result={result as SequenceResult} />
      case 'evolve':
        return <EvolveView result={result as EvolveResult} />
      case 'simulate':
        return <SimulateView result={result as SimulateResult} />
    }
  })()

  const chips = gameStatsChips(model, stats)
  return (
    <div className="md-game-result">
      {chips.length > 0 && (
        <div className="md-game-chips">
          {chips.map((chip) => (
            <span key={`${chip.label}-${chip.value}`} className="md-game-chip">
              <span className="md-game-chip-label">{chip.label}</span>
              <span className="md-game-chip-value">{chip.value}</span>
            </span>
          ))}
        </div>
      )}
      {kernel}
      {narrative && <div className="md-game-narrative">{narrative}</div>}
      <div className="md-game-footnote">模型推演，非预测{seed !== undefined ? ` · 种子 ${seed}（相同种子可复现）` : ''}</div>
    </div>
  )
}
