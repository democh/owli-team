/**
 * 博弈视图共享类型（M34 §6.4；镜像 server/src/finance/game/* 的结果子集，仅取渲染所需字段）。
 * 消息块（GameBlock）与画布博弈节点（GameNode）共用。
 */
export type GameAction = 'aggressive' | 'hold' | 'retreat'

export const ACTION_LABELS: Record<GameAction, string> = { aggressive: '进攻', hold: '观望', retreat: '撤退' }

export interface PayoffCell {
  long: number
  short: number
}

export interface MatrixResult {
  actions: GameAction[]
  /** payoffs[i][j]：多头策略 i（行）× 空头策略 j（列） */
  payoffs: PayoffCell[][]
  pureNash: Array<{ long: GameAction; short: GameAction }>
  mixedNash: Array<{ long: Record<GameAction, number>; short: Record<GameAction, number>; degenerate: boolean }>
  dominant: { long?: GameAction; short?: GameAction }
  gameType: string
  gameTypeLabel: string
}

export interface SequenceTreeNode {
  id: string
  player: 'long' | 'short'
  action?: GameAction
  actionLabel?: string
  children?: SequenceTreeNode[]
  payoffs?: PayoffCell
  onPath: boolean
  optimal?: boolean
}

export interface SequenceResult {
  leader: 'long' | 'short'
  follower: 'long' | 'short'
  tree: SequenceTreeNode
  equilibrium: { path: Array<{ player: 'long' | 'short'; action: GameAction }>; payoffs: PayoffCell }
  counterfactuals: Array<{ action: GameAction; followerBest: GameAction; payoffs: PayoffCell; leaderDelta: number }>
}

export interface EvolveResult {
  feedback: string
  fixedPoints: Array<{ x: number; stable: boolean; kind: string }>
  ess: number[]
  curves: Array<{ x0: number; points: Array<{ t: number; x: number }> }>
  neutral: boolean
}

export interface SimulateResult {
  initialPrice: number
  rounds: number
  paths: number
  bands: { rounds: number[]; p5: number[]; p25: number[]; p50: number[]; p75: number[]; p95: number[] }
  samplePaths: number[][]
  finalHistogram: Array<{ binStart: number; count: number }>
  pnl: { long: { mean: number; p5: number; p50: number; p95: number }; short: { mean: number; p5: number; p50: number; p95: number } }
  maxDrawdown: { mean: number; p5: number; p50: number; p95: number }
  events: { squeeze: number; crash: number; stalemate: number; other: number }
}

/** 玩家中文标签 */
export const PLAYER_LABELS: Record<'long' | 'short', string> = { long: '多头', short: '空头' }

/** 数值 → 千分位（可带正负号） */
export function fmtNum(v: number, digits = 3, sign = false): string {
  if (!Number.isFinite(v)) return '—'
  const text = Math.abs(v) >= 1e6 ? v.toExponential(2) : v.toFixed(digits).replace(/\.?0+$/, '')
  return `${sign && v > 0 ? '+' : ''}${text}`
}

/** 小数收益口径 → 百分比 */
export function fmtPct(v: number, digits = 2, sign = false): string {
  if (!Number.isFinite(v)) return '—'
  return `${sign && v > 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`
}
