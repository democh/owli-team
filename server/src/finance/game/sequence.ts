/**
 * 模型 2 · 序贯博弈（M34 §5.4）：先动方 → 跟随方 的两层决策树 + 逆向归纳。
 *
 * 叶收益复用矩阵模型公式（简化参数）；求解：跟随方在每个分支取最优反应，
 * 先动方选择使自身收益最大的分支 → 子博弈完美均衡路径；输出树结构与反事实对比。
 * （深度 3 为后续扩展点；首期深度 2。）
 */
import { ParamReader, pct, round, type ModelOutcome } from './types.js'
import {
  ACTION_LABELS,
  GAME_ACTIONS,
  MATRIX_KNOWN_PARAMS,
  payoffCell,
  parseMatrixParams,
  type GameAction,
  type PayoffCell,
} from './matrix.js'

export const SEQUENCE_KNOWN_PARAMS = [...MATRIX_KNOWN_PARAMS, 'leader'] as const

export type SequenceLeader = 'long' | 'short'

export interface SequenceTreeNode {
  id: string
  /** 该节点的决策者 */
  player: SequenceLeader
  /** 到达该节点所选的行动（root 无） */
  action?: GameAction
  actionLabel?: string
  children?: SequenceTreeNode[]
  /** 叶节点收益（双方） */
  payoffs?: PayoffCell
  /** 均衡路径上的节点 */
  onPath: boolean
  /** 该决策点上的最优选择（先动方均衡分支 / 跟随方最优反应） */
  optimal?: boolean
}

export interface SequenceCounterfactual {
  /** 先动方的替代行动 */
  action: GameAction
  /** 该分支上跟随方的最优反应 */
  followerBest: GameAction
  /** 该分支结局（含跟随方最优反应） */
  payoffs: PayoffCell
  /** 相对均衡的先动方收益差 */
  leaderDelta: number
}

export interface SequenceResult {
  leader: SequenceLeader
  follower: SequenceLeader
  actions: GameAction[]
  tree: SequenceTreeNode
  equilibrium: {
    path: Array<{ player: SequenceLeader; action: GameAction }>
    payoffs: PayoffCell
  }
  counterfactuals: SequenceCounterfactual[]
}

interface FollowBranch {
  action: GameAction
  best: GameAction
  payoffs: PayoffCell
}

const LEADER_LABELS: Record<SequenceLeader, string> = { long: '多头', short: '空头' }

export function runSequence(params: Record<string, unknown> | undefined): ModelOutcome<SequenceResult> {
  const reader = new ParamReader(params, SEQUENCE_KNOWN_PARAMS)
  const parsed = parseMatrixParams(reader)
  const leader = reader.choice<SequenceLeader>('leader', 'long', ['long', 'short'] as const)
  const follower: SequenceLeader = leader === 'long' ? 'short' : 'long'

  const cellFor = (leaderAction: GameAction, followerAction: GameAction): PayoffCell =>
    leader === 'long' ? payoffCell(parsed, leaderAction, followerAction) : payoffCell(parsed, followerAction, leaderAction)

  // 逆向归纳：跟随方在每个分支上取最优反应
  const branches: FollowBranch[] = GAME_ACTIONS.map((leaderAction) => {
    let bestFollower: GameAction = GAME_ACTIONS[0]
    let bestCell = cellFor(leaderAction, bestFollower)
    for (const followerAction of GAME_ACTIONS.slice(1)) {
      const cell = cellFor(leaderAction, followerAction)
      if (cell[follower] > bestCell[follower]) {
        bestFollower = followerAction
        bestCell = cell
      }
    }
    return { action: leaderAction, best: bestFollower, payoffs: bestCell }
  })

  // 先动方在跟随方最优反应下选择最优分支
  let equilibrium: FollowBranch = branches[0]
  for (const branch of branches.slice(1)) {
    if (branch.payoffs[leader] > equilibrium.payoffs[leader]) equilibrium = branch
  }

  const tree: SequenceTreeNode = {
    id: 'root',
    player: leader,
    onPath: true,
    children: branches.map((branch) => ({
      id: branch.action,
      player: follower,
      action: branch.action,
      actionLabel: ACTION_LABELS[branch.action],
      optimal: branch === equilibrium,
      onPath: branch === equilibrium,
      children: GAME_ACTIONS.map((followerAction) => {
        const cell = cellFor(branch.action, followerAction)
        return {
          id: `${branch.action}/${followerAction}`,
          player: follower,
          action: followerAction,
          actionLabel: ACTION_LABELS[followerAction],
          payoffs: { long: round(cell.long), short: round(cell.short) },
          optimal: followerAction === branch.best,
          onPath: branch === equilibrium && followerAction === branch.best,
        }
      }),
    })),
  }

  const counterfactuals: SequenceCounterfactual[] = branches
    .filter((branch) => branch !== equilibrium)
    .map((branch) => ({
      action: branch.action,
      followerBest: branch.best,
      payoffs: { long: round(branch.payoffs.long), short: round(branch.payoffs.short) },
      leaderDelta: round(branch.payoffs[leader] - equilibrium.payoffs[leader]),
    }))
    .sort((a, b) => b.leaderDelta - a.leaderDelta)

  const leaderLabel = LEADER_LABELS[leader]
  const followerLabel = LEADER_LABELS[follower]
  const equilibriumValue = equilibrium.payoffs[leader]
  const parts: string[] = [
    `${leaderLabel}主导（先动）的序贯博弈：均衡路径「${ACTION_LABELS[equilibrium.action]} → ${ACTION_LABELS[equilibrium.best]}」` +
      '（跟随方在每个分支取最优反应，先动方选择最优分支——子博弈完美均衡）。',
    `均衡结局：${leaderLabel} ${pct(equilibriumValue)} / ${followerLabel} ${pct(equilibrium.payoffs[follower])}。`,
  ]
  const alternative = counterfactuals[0]
  if (alternative) {
    parts.push(
      `反事实：若${leaderLabel}选择「${ACTION_LABELS[alternative.action]}」，跟随方将选「${ACTION_LABELS[alternative.followerBest]}」，` +
        `${leaderLabel}收益变为 ${pct(alternative.payoffs[leader])}（Δ ${pct(alternative.leaderDelta)}）。`,
    )
    const gap = equilibriumValue - alternative.payoffs[leader]
    parts.push(gap > 0.01 ? `先动优势显著（最优分支领先次优 ${pct(gap)}）。` : '先动优势不显著（各分支差距有限）。')
  }

  return {
    result: {
      leader,
      follower,
      actions: [...GAME_ACTIONS],
      tree,
      equilibrium: {
        path: [
          { player: leader, action: equilibrium.action },
          { player: follower, action: equilibrium.best },
        ],
        payoffs: { long: round(equilibrium.payoffs.long), short: round(equilibrium.payoffs.short) },
      },
      counterfactuals,
    },
    stats: {
      leader: LEADER_LABELS[leader],
      equilibriumPath: `${ACTION_LABELS[equilibrium.action]} → ${ACTION_LABELS[equilibrium.best]}`,
      leaderPayoff: round(equilibriumValue),
      followerPayoff: round(equilibrium.payoffs[follower]),
      firstMoverAdvantage: alternative ? round(equilibriumValue - alternative.payoffs[leader]) : 0,
    },
    narrative: parts.join(''),
    params: {
      leader,
      capital: { long: parsed.capitalLong, short: parsed.capitalShort },
      priceImpact: parsed.priceImpact,
      carryCost: parsed.carryCost,
      conflictCost: parsed.conflictCost,
      retreatLoss: parsed.retreatLoss,
    },
    warnings: reader.warnings,
  }
}
