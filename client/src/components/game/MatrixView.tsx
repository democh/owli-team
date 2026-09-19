/**
 * 静态矩阵博弈视图（M34 §6.4）：3×3 收益矩阵热力图（自绘 SVG）——
 * 双色域：单元格左半多头（蓝）/ 右半空头（橙），透明度按收益强度归一；
 * 纯均衡格加边框 + 徽标；悬停（或键盘聚焦）显示双方收益与最优反应；混合均衡概率表在下方。
 */
import * as React from 'react'
import { ACTION_LABELS, fmtNum, PLAYER_LABELS, type GameAction, type MatrixResult } from './types'

const CELL_W = 96
const CELL_H = 52
const GAP = 4
const HEAD_W = 52
const HEAD_H = 22

const LONG_COLOR = '#2563eb'
const SHORT_COLOR = '#f97316'

function intensity(value: number, max: number): number {
  if (max <= 0) return 0.1
  return Math.min(0.72, Math.max(0.07, Math.abs(value) / max))
}

function isNash(result: MatrixResult, i: number, j: number): boolean {
  const row = result.actions[i]
  const col = result.actions[j]
  return result.pureNash.some((n) => n.long === row && n.short === col)
}

/** 最优反应：行 i 的最大多头收益列 / 列 j 的最大空头收益行 */
function bestResponses(result: MatrixResult): { longBest: GameAction[]; shortBest: GameAction[] } {
  const longBest: GameAction[] = []
  const shortBest: GameAction[] = []
  result.actions.forEach((_, i) => {
    let best = 0
    for (let j = 1; j < result.actions.length; j++) {
      if (result.payoffs[i][j].long > result.payoffs[i][best].long) best = j
    }
    longBest.push(result.actions[best])
  })
  result.actions.forEach((_, j) => {
    let best = 0
    for (let i = 1; i < result.actions.length; i++) {
      if (result.payoffs[i][j].short > result.payoffs[best][j].short) best = i
    }
    shortBest.push(result.actions[best])
  })
  return { longBest, shortBest }
}

export function MatrixView({ result }: { result: MatrixResult }): React.JSX.Element {
  const [hover, setHover] = React.useState<{ i: number; j: number } | undefined>(undefined)
  const n = result.actions.length
  const width = HEAD_W + n * (CELL_W + GAP) + 2
  const height = HEAD_H + n * (CELL_H + GAP) + 2
  const maxAbs = Math.max(...result.payoffs.flatMap((row) => row.flatMap((cell) => [Math.abs(cell.long), Math.abs(cell.short)])), 1e-9)
  const { longBest, shortBest } = bestResponses(result)

  const hoverCell = hover ? result.payoffs[hover.i][hover.j] : undefined
  const hoverText = hover
    ? `${ACTION_LABELS[result.actions[hover.i]]} × ${ACTION_LABELS[result.actions[hover.j]]}：` +
      `${PLAYER_LABELS.long} ${fmtNum(hoverCell!.long, 3, true)} / ${PLAYER_LABELS.short} ${fmtNum(hoverCell!.short, 3, true)}` +
      `｜最优反应：${PLAYER_LABELS.long}→${ACTION_LABELS[longBest[hover.i]]}、${PLAYER_LABELS.short}→${ACTION_LABELS[shortBest[hover.j]]}`
    : `悬停单元格查看收益明细｜${result.gameTypeLabel}`

  return (
    <div className="md-game-matrix">
      <svg viewBox={`0 0 ${width} ${height}`} className="md-game-svg" role="img" aria-label={`收益矩阵（${result.gameTypeLabel}）`}>
        {/* 列头（空头策略） */}
        {result.actions.map((action, j) => (
          <text
            key={`col-${action}`}
            x={HEAD_W + j * (CELL_W + GAP) + CELL_W / 2}
            y={HEAD_H - 7}
            textAnchor="middle"
            className="md-game-svg-axis"
          >
            {ACTION_LABELS[action]}
          </text>
        ))}
        {/* 行头（多头策略） */}
        {result.actions.map((action, i) => (
          <text
            key={`row-${action}`}
            x={HEAD_W - 6}
            y={HEAD_H + i * (CELL_H + GAP) + CELL_H / 2 + 3}
            textAnchor="end"
            className="md-game-svg-axis"
          >
            {ACTION_LABELS[action]}
          </text>
        ))}
        {result.payoffs.map((row, i) =>
          row.map((cell, j) => {
            const x = HEAD_W + j * (CELL_W + GAP)
            const y = HEAD_H + i * (CELL_H + GAP)
            const nash = isNash(result, i, j)
            const active = hover?.i === i && hover?.j === j
            return (
              <g
                key={`${i}-${j}`}
                className="md-game-cell"
                tabIndex={0}
                onMouseEnter={() => setHover({ i, j })}
                onMouseLeave={() => setHover(undefined)}
                onFocus={() => setHover({ i, j })}
                onBlur={() => setHover(undefined)}
              >
                <rect x={x} y={y} width={CELL_W / 2} height={CELL_H} rx={3} fill={LONG_COLOR} opacity={intensity(cell.long, maxAbs)} />
                <rect
                  x={x + CELL_W / 2}
                  y={y}
                  width={CELL_W / 2}
                  height={CELL_H}
                  rx={3}
                  fill={SHORT_COLOR}
                  opacity={intensity(cell.short, maxAbs)}
                />
                <rect
                  x={x}
                  y={y}
                  width={CELL_W}
                  height={CELL_H}
                  rx={3}
                  fill="none"
                  stroke={nash ? '#0f172a' : active ? '#64748b' : '#e2e8f0'}
                  strokeWidth={nash ? 1.6 : 1}
                />
                <text x={x + CELL_W * 0.25} y={y + CELL_H / 2 + 4} textAnchor="middle" className="md-game-svg-num">
                  {fmtNum(cell.long, 3, true)}
                </text>
                <text x={x + CELL_W * 0.75} y={y + CELL_H / 2 + 4} textAnchor="middle" className="md-game-svg-num">
                  {fmtNum(cell.short, 3, true)}
                </text>
                {nash && (
                  <text x={x + CELL_W - 4} y={y + 11} textAnchor="end" className="md-game-svg-nash">
                    均衡
                  </text>
                )}
              </g>
            )
          }),
        )}
      </svg>

      <div className="md-game-legend">
        <span className="md-game-legend-item" style={{ color: LONG_COLOR }}>
          ■ {PLAYER_LABELS.long}收益
        </span>
        <span className="md-game-legend-item" style={{ color: SHORT_COLOR }}>
          ■ {PLAYER_LABELS.short}收益
        </span>
        {(result.dominant.long || result.dominant.short) && (
          <span className="md-game-legend-item">
            占优策略：{result.dominant.long ? `${PLAYER_LABELS.long}→${ACTION_LABELS[result.dominant.long]}` : ''}
            {result.dominant.short ? `${result.dominant.long ? '、' : ''}${PLAYER_LABELS.short}→${ACTION_LABELS[result.dominant.short]}` : ''}
          </span>
        )}
      </div>

      <div className="md-game-matrix-info">{hoverText}</div>

      {result.mixedNash.length > 0 && (
        <div className="md-game-mixed">
          <span className="md-game-mixed-title">混合策略均衡</span>
          {result.mixedNash.map((mix, idx) => (
            <span key={idx} className="md-game-mixed-item">
              {PLAYER_LABELS.long} [{result.actions.map((a) => `${ACTION_LABELS[a]} ${(mix.long[a] * 100).toFixed(0)}%`).join(' / ')}]；{' '}
              {PLAYER_LABELS.short} [{result.actions.map((a) => `${ACTION_LABELS[a]} ${(mix.short[a] * 100).toFixed(0)}%`).join(' / ')}]
              {mix.degenerate ? '（退化）' : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
