/**
 * 序贯博弈视图（M34 §6.4）：博弈树（自绘 SVG）——
 * 根 = 先动方 → 分支 = 先动方行动（跟随方最优反应节点）→ 叶 = 跟随方行动与收益对；
 * 均衡路径高亮加粗、反事实分支虚线灰；下方列出反事实对比（选了别的分支会怎样）。
 * 交互（轻量内联口径）：悬停分支 → 其余分支淡化；点击 / 回车分支节点（或点击反事实条目）→
 * 锁定对照（分支激活 + 对应反事实条目高亮）。
 */
import * as React from 'react'
import { cn } from '../../lib/utils'
import { ACTION_LABELS, fmtNum, PLAYER_LABELS, type GameAction, type SequenceResult, type SequenceTreeNode } from './types'

const ROW_H = 26
const TOP_PAD = 26
const ROOT_X = 20
const BRANCH_X = 210
const LEAF_X = 420
const WIDTH = 620

function leafText(node: SequenceTreeNode): string {
  if (!node.payoffs) return ''
  return `${PLAYER_LABELS.long} ${fmtNum(node.payoffs.long, 3, true)} / ${PLAYER_LABELS.short} ${fmtNum(node.payoffs.short, 3, true)}`
}

export function SequenceView({ result }: { result: SequenceResult }): React.JSX.Element {
  // 悬停分支（其余分支淡化）与锁定对照（分支 / 反事实条目联动高亮）
  const [hot, setHot] = React.useState<string | undefined>(undefined)
  const [pin, setPin] = React.useState<GameAction | undefined>(undefined)
  const togglePin = (action?: GameAction): void => {
    if (!action) return
    setPin((prev) => (prev === action ? undefined : action))
  }
  const branches = result.tree.children ?? []
  const leavesPerBranch = Math.max(1, ...branches.map((b) => b.children?.length ?? 0))
  const height = TOP_PAD + branches.length * leavesPerBranch * ROW_H + 8

  const leafY = (b: number, k: number): number => TOP_PAD + (b * leavesPerBranch + k) * ROW_H + ROW_H / 2
  const branchY = (b: number): number => {
    const count = branches[b].children?.length ?? 1
    return (leafY(b, 0) + leafY(b, count - 1)) / 2
  }
  const rootY = branches.length > 0 ? (branchY(0) + branchY(branches.length - 1)) / 2 : height / 2

  return (
    <div className="md-game-sequence">
      <svg viewBox={`0 0 ${WIDTH} ${height}`} className="md-game-svg" role="img" aria-label="序贯博弈树">
        {/* 根（先动方） */}
        <rect x={ROOT_X} y={rootY - 12} width={104} height={24} rx={5} fill="#0f172a" />
        <text x={ROOT_X + 52} y={rootY + 4} textAnchor="middle" className="md-game-svg-root">
          {PLAYER_LABELS[result.leader]}（先动）
        </text>

        {branches.map((branch, b) => {
          const by = branchY(b)
          const leaves = branch.children ?? []
          return (
            <g
              key={branch.id}
              className={cn('md-game-branch', hot !== undefined && hot !== branch.id && 'is-dim')}
              onMouseEnter={() => setHot(branch.id)}
              onMouseLeave={() => setHot(undefined)}
            >
              {/* 根 → 分支 */}
              <line
                x1={ROOT_X + 104}
                y1={rootY}
                x2={BRANCH_X}
                y2={by}
                stroke={branch.onPath ? '#0f172a' : '#cbd5e1'}
                strokeWidth={branch.onPath ? 1.6 : 1}
                strokeDasharray={branch.onPath ? undefined : '3 3'}
              />
              <rect
                x={BRANCH_X}
                y={by - 11}
                width={86}
                height={22}
                rx={5}
                className={cn('md-game-nodebox', pin !== undefined && pin === branch.action && 'is-active')}
                fill={branch.onPath ? 'rgba(37, 99, 235, 0.08)' : '#ffffff'}
                stroke={branch.onPath ? '#0f172a' : '#cbd5e1'}
                strokeWidth={branch.onPath ? 1.4 : 1}
                role="button"
                tabIndex={0}
                aria-label={`分支 ${branch.actionLabel ?? ''}${branch.onPath ? '（均衡路径）' : ''}；点击对照反事实`}
                onClick={() => togglePin(branch.action)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    togglePin(branch.action)
                  }
                }}
              />
              <text x={BRANCH_X + 43} y={by + 4} textAnchor="middle" className="md-game-svg-label">
                {branch.actionLabel ?? ''}
                {branch.onPath ? ' ●' : ''}
              </text>
              {leaves.map((leaf, k) => {
                const ly = leafY(b, k)
                return (
                  <g key={leaf.id}>
                    <line
                      x1={BRANCH_X + 86}
                      y1={by}
                      x2={LEAF_X}
                      y2={ly}
                      stroke={leaf.onPath ? '#0f172a' : '#cbd5e1'}
                      strokeWidth={leaf.onPath ? 1.6 : 1}
                      strokeDasharray={leaf.onPath ? undefined : '3 3'}
                    />
                    <circle cx={LEAF_X - 6} cy={ly} r={2.4} fill={leaf.onPath ? '#0f172a' : leaf.optimal ? '#64748b' : '#cbd5e1'} />
                    <text x={LEAF_X + 4} y={ly + 4} className={leaf.onPath ? 'md-game-svg-leaf is-path' : 'md-game-svg-leaf'}>
                      {ACTION_LABELS[(leaf.action ?? 'hold') as keyof typeof ACTION_LABELS]}：{leafText(leaf)}
                      {leaf.optimal ? ' ★' : ''}
                    </text>
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>

      <div className="md-game-legend">
        <span className="md-game-legend-item">● 均衡路径（子博弈完美）</span>
        <span className="md-game-legend-item">★ 跟随方最优反应</span>
      </div>

      {result.counterfactuals.length > 0 && (
        <div className="md-game-counterfactual">
          {result.counterfactuals.map((cf) => (
            <div
              key={cf.action}
              className={cn('md-game-counterfactual-item', pin === cf.action && 'is-active')}
              role="button"
              tabIndex={0}
              title="点击与上方分支联动对照"
              onClick={() => togglePin(cf.action)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  togglePin(cf.action)
                }
              }}
            >
              反事实：若{PLAYER_LABELS[result.leader]}选「{ACTION_LABELS[cf.action]}」，跟随方将选「{ACTION_LABELS[cf.followerBest]}」，
              {PLAYER_LABELS[result.leader]}收益 {fmtNum(cf.payoffs[result.leader], 3, true)}（Δ {fmtNum(cf.leaderDelta, 3, true)}）
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
