/**
 * 模型 1 · 静态矩阵博弈（M34 §5.4）：多空对峙 + 纳什均衡 + 博弈类型识别 + 敏感性扫描。
 *
 * 收益函数（每方，比例口径）：
 *   U(own, opp) = 方向 × priceImpact × (eOwn − eOpp) − conflictCost × min(eOwn, eOpp)
 *                 + retreatLoss × [opp == retreat] − carryCost × costFactor(own)
 * 其中 e = capitalWeight × stress（资金加权强度，capital 不对称时弱方影响力小）；
 * 冲突项刻画双方同时高强度对撞的相互消耗；成本项为凸（≈ stress²，进攻边际成本递增）。
 *
 * 求解：纯策略纳什（最优反应不动点遍历）+ 混合策略（support enumeration + 高斯消元精确解，
 * 退化集合标记）；经典博弈类型（囚徒困境 / 懦夫 / 协调 / 智猪）按矩阵结构自动识别。
 */
import { ParamReader, pct, round, type ModelOutcome } from './types.js'

export type GameAction = 'aggressive' | 'hold' | 'retreat'

export const GAME_ACTIONS: readonly GameAction[] = ['aggressive', 'hold', 'retreat']

export const ACTION_LABELS: Record<GameAction, string> = {
  aggressive: '进攻',
  hold: '观望',
  retreat: '撤退',
}

/** 行动强度映射（进攻 = 全力施压，观望 = 部分持仓，撤退 = 平仓离场） */
const ACTION_STRESS: Record<GameAction, number> = { aggressive: 1, hold: 0.4, retreat: 0 }

/** 持仓成本因子（≈ stress²：进攻的边际成本大于边际强度） */
const ACTION_COST: Record<GameAction, number> = { aggressive: 1, hold: 0.16, retreat: 0 }

export interface MatrixParams {
  /** 多头资金规模（元；仅用于不对称资金加权） */
  capitalLong: number
  capitalShort: number
  /** 冲击系数（满强度差的价格变动比例） */
  priceImpact: number
  /** 持仓成本 / 期 */
  carryCost: number
  /** 双方同时进攻的对撞冲突成本 */
  conflictCost: number
  /** 撤退滑点损失（被对方捕获的部分） */
  retreatLoss: number
}

/** 可解析参数名（未知参数记 warning） */
export const MATRIX_KNOWN_PARAMS = ['capital', 'priceImpact', 'carryCost', 'conflictCost', 'retreatLoss'] as const

export function parseMatrixParams(reader: ParamReader): MatrixParams {
  const [capitalLong, capitalShort] = reader.pair('capital', [1e8, 1e8], { min: 1 })
  return {
    capitalLong,
    capitalShort,
    priceImpact: reader.num('priceImpact', 0.06, { min: 0, max: 1 }),
    carryCost: reader.num('carryCost', 0.03, { min: 0, max: 1 }),
    conflictCost: reader.num('conflictCost', 0.05, { min: 0, max: 1 }),
    retreatLoss: reader.num('retreatLoss', 0.03, { min: 0, max: 1 }),
  }
}

export interface PayoffCell {
  long: number
  short: number
}

export interface PureEquilibrium {
  long: GameAction
  short: GameAction
}

export interface MixedEquilibrium {
  /** 多头各策略概率（含 0 分量，便于前端直接渲染） */
  long: Record<GameAction, number>
  short: Record<GameAction, number>
  /** 退化：实际支持小于名义支持（某分量概率 ≈ 0） */
  degenerate: boolean
}

export type GameType = 'prisoners-dilemma' | 'chicken' | 'coordination' | 'stag-hunt' | 'other'

export const GAME_TYPE_LABELS: Record<GameType, string> = {
  'prisoners-dilemma': '囚徒困境',
  chicken: '懦夫博弈',
  coordination: '协调博弈',
  'stag-hunt': '智猪博弈',
  other: '其它结构',
}

export interface SensitivityEntry {
  param: string
  /** 扰动系数（0.9 / 1.1，即 ±10%） */
  factor: number
  value: number
  gameType: GameType
  gameTypeLabel: string
  pureNashCount: number
  /** 相对基准（类型或纯均衡数变化） */
  changed: boolean
}

export interface MatrixResult {
  actions: GameAction[]
  /** payoffs[i][j]：多头策略 i（行）× 空头策略 j（列） */
  payoffs: PayoffCell[][]
  pureNash: PureEquilibrium[]
  mixedNash: MixedEquilibrium[]
  dominant: { long?: GameAction; short?: GameAction }
  gameType: GameType
  gameTypeLabel: string
  sensitivity: SensitivityEntry[]
}

const EPS = 1e-9
const MIXED_EPS = 1e-7

// ---------------------------------------------------------------- 收益矩阵

export function payoffCell(params: MatrixParams, actionLong: GameAction, actionShort: GameAction): PayoffCell {
  const capRef = (params.capitalLong + params.capitalShort) / 2
  const weightLong = capRef > 0 ? params.capitalLong / capRef : 1
  const weightShort = capRef > 0 ? params.capitalShort / capRef : 1
  const effLong = weightLong * ACTION_STRESS[actionLong]
  const effShort = weightShort * ACTION_STRESS[actionShort]
  const priceMove = params.priceImpact * (effLong - effShort)
  const clash = params.conflictCost * Math.min(effLong, effShort)
  return {
    long: priceMove - clash + (actionShort === 'retreat' ? params.retreatLoss : 0) - params.carryCost * ACTION_COST[actionLong],
    short: -priceMove - clash + (actionLong === 'retreat' ? params.retreatLoss : 0) - params.carryCost * ACTION_COST[actionShort],
  }
}

export function buildPayoffs(
  params: MatrixParams,
  actions: readonly GameAction[] = GAME_ACTIONS,
): PayoffCell[][] {
  return actions.map((actionLong) => actions.map((actionShort) => payoffCell(params, actionLong, actionShort)))
}

// ---------------------------------------------------------------- 求解

/** 最优反应集合：给定对手策略（索引），返回该玩家的最优行动（含并列） */
export function bestResponsesFor(
  payoffs: PayoffCell[][],
  actions: readonly GameAction[],
  player: 'long' | 'short',
  opponentIndex: number,
): GameAction[] {
  const n = actions.length
  let best = -Infinity
  if (player === 'long') {
    for (let i = 0; i < n; i++) best = Math.max(best, payoffs[i][opponentIndex].long)
  } else {
    for (let j = 0; j < n; j++) best = Math.max(best, payoffs[opponentIndex][j].short)
  }
  const picks: GameAction[] = []
  for (let k = 0; k < n; k++) {
    const value = player === 'long' ? payoffs[k][opponentIndex].long : payoffs[opponentIndex][k].short
    if (value >= best - EPS) picks.push(actions[k])
  }
  return picks
}

/** 纯策略纳什均衡：双方互为最优反应的不动点遍历 */
export function findPureNash(payoffs: PayoffCell[][], actions: readonly GameAction[] = GAME_ACTIONS): PureEquilibrium[] {
  const out: PureEquilibrium[] = []
  const n = actions.length
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const longOk = bestResponsesFor(payoffs, actions, 'long', j).includes(actions[i])
      const shortOk = bestResponsesFor(payoffs, actions, 'short', i).includes(actions[j])
      if (longOk && shortOk) out.push({ long: actions[i], short: actions[j] })
    }
  }
  return out
}

/** 严格占优策略：对其它所有策略、在对手任意选择下都更优（最多各一个） */
export function findDominantStrategies(
  payoffs: PayoffCell[][],
  actions: readonly GameAction[] = GAME_ACTIONS,
): { long?: GameAction; short?: GameAction } {
  const n = actions.length
  const out: { long?: GameAction; short?: GameAction } = {}
  for (let a = 0; a < n; a++) {
    let dominant = true
    for (let b = 0; b < n && dominant; b++) {
      if (a === b) continue
      for (let j = 0; j < n; j++) {
        if (!(payoffs[a][j].long > payoffs[b][j].long + EPS)) {
          dominant = false
          break
        }
      }
    }
    if (dominant) {
      out.long = actions[a]
      break
    }
  }
  for (let a = 0; a < n; a++) {
    let dominant = true
    for (let b = 0; b < n && dominant; b++) {
      if (a === b) continue
      for (let i = 0; i < n; i++) {
        if (!(payoffs[i][a].short > payoffs[i][b].short + EPS)) {
          dominant = false
          break
        }
      }
    }
    if (dominant) {
      out.short = actions[a]
      break
    }
  }
  return out
}

/** 非空子集枚举（按大小升序；去重时保留最简支持先出现的解） */
function subsetsBySize(n: number): number[][] {
  const out: number[][] = []
  for (let size = 1; size <= n; size++) {
    const combo = (start: number, acc: number[]): void => {
      if (acc.length === size) {
        out.push([...acc])
        return
      }
      for (let i = start; i < n; i++) {
        acc.push(i)
        combo(i + 1, acc)
        acc.pop()
      }
    }
    combo(0, [])
  }
  return out
}

/** 高斯消元（部分主元，Gauss-Jordan）；奇异返回 undefined */
function solveLinear(matrix: number[][], rhs: number[]): number[] | undefined {
  const n = rhs.length
  const m = matrix.map((row, i) => [...row, rhs[i]])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return undefined
    const swap = m[col]
    m[col] = m[pivot]
    m[pivot] = swap
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const factor = m[r][col] / m[col][col]
      if (factor === 0) continue
      for (let c = col; c <= n; c++) m[r][c] -= factor * m[col][c]
    }
  }
  return m.map((row, i) => row[n] / row[i])
}

/**
 * 混合策略均衡：support enumeration（|I| = |J| 方阵精确解）+ 有效性验证。
 * 已知限制：|I| ≠ |J| 的退化支持对（欠定/超定）首期跳过。
 */
export function findMixedEquilibria(
  payoffs: PayoffCell[][],
  actions: readonly GameAction[] = GAME_ACTIONS,
): MixedEquilibrium[] {
  const n = actions.length
  const subsets = subsetsBySize(n)
  const found: MixedEquilibrium[] = []
  for (const supportLong of subsets) {
    for (const supportShort of subsets) {
      if (supportLong.length !== supportShort.length) continue
      // 纯组合（1×1）归入纯均衡，不重复计入混合
      if (supportLong.length === 1) continue
      const mix = solveSupportPair(payoffs, actions, supportLong, supportShort)
      if (!mix) continue
      if (found.some((item) => sameMix(item, mix, actions))) continue
      found.push(mix)
    }
  }
  return found
}

function solveSupportPair(
  payoffs: PayoffCell[][],
  actions: readonly GameAction[],
  supportLong: number[],
  supportShort: number[],
): MixedEquilibrium | undefined {
  const k = supportLong.length

  // τ（空头在 supportShort 上的混合）：使多头在 supportLong 上收益无差异（用 U_L 建方程）
  const tauMatrix: number[][] = []
  const tauRhs: number[] = []
  for (const i of supportLong) {
    const row = supportShort.map((j) => payoffs[i][j].long)
    row.push(-1)
    tauMatrix.push(row)
    tauRhs.push(0)
  }
  tauMatrix.push([...supportShort.map(() => 1), 0])
  tauRhs.push(1)
  const tauSolution = solveLinear(tauMatrix, tauRhs)
  if (!tauSolution) return undefined

  // σ（多头在 supportLong 上的混合）：使空头在 supportShort 上收益无差异（用 U_S 建方程）
  const sigmaMatrix: number[][] = []
  const sigmaRhs: number[] = []
  for (const j of supportShort) {
    const row = supportLong.map((i) => payoffs[i][j].short)
    row.push(-1)
    sigmaMatrix.push(row)
    sigmaRhs.push(0)
  }
  sigmaMatrix.push([...supportLong.map(() => 1), 0])
  sigmaRhs.push(1)
  const sigmaSolution = solveLinear(sigmaMatrix, sigmaRhs)
  if (!sigmaSolution) return undefined

  const tauRaw = tauSolution.slice(0, k)
  const valueLong = tauSolution[k]
  const sigmaRaw = sigmaSolution.slice(0, k)
  const valueShort = sigmaSolution[k]

  if (tauRaw.some((v) => v < -MIXED_EPS) || sigmaRaw.some((v) => v < -MIXED_EPS)) return undefined

  const tau = tauRaw.map((v) => Math.max(0, v))
  const sigma = sigmaRaw.map((v) => Math.max(0, v))
  const tauSum = tau.reduce((a, b) => a + b, 0)
  const sigmaSum = sigma.reduce((a, b) => a + b, 0)
  if (tauSum <= MIXED_EPS || sigmaSum <= MIXED_EPS) return undefined
  const tauNorm = tau.map((v) => v / tauSum)
  const sigmaNorm = sigma.map((v) => v / sigmaSum)

  // 支持外不更优：对手无法通过偏离支持集获得更高收益
  for (let i = 0; i < payoffs.length; i++) {
    if (supportLong.includes(i)) continue
    let value = 0
    for (let idx = 0; idx < supportShort.length; idx++) value += tauNorm[idx] * payoffs[i][supportShort[idx]].long
    if (value > valueLong + MIXED_EPS) return undefined
  }
  for (let j = 0; j < payoffs.length; j++) {
    if (supportShort.includes(j)) continue
    let value = 0
    for (let idx = 0; idx < supportLong.length; idx++) value += sigmaNorm[idx] * payoffs[supportLong[idx]][j].short
    if (value > valueShort + MIXED_EPS) return undefined
  }

  const long = emptyProbability(actions)
  const short = emptyProbability(actions)
  supportLong.forEach((i, idx) => {
    long[actions[i]] = round(sigmaNorm[idx], 6)
  })
  supportShort.forEach((j, idx) => {
    short[actions[j]] = round(tauNorm[idx], 6)
  })
  const degenerate = sigmaNorm.some((v) => v <= 1e-6) || tauNorm.some((v) => v <= 1e-6)
  return { long, short, degenerate }
}

function emptyProbability(actions: readonly GameAction[]): Record<GameAction, number> {
  const out = {} as Record<GameAction, number>
  for (const action of actions) out[action] = 0
  return out
}

function sameMix(a: MixedEquilibrium, b: MixedEquilibrium, actions: readonly GameAction[]): boolean {
  return actions.every(
    (action) => Math.abs(a.long[action] - b.long[action]) < 1e-6 && Math.abs(a.short[action] - b.short[action]) < 1e-6,
  )
}

// ---------------------------------------------------------------- 类型识别

/**
 * 经典博弈类型识别（结构签名，按优先级）：
 *   1. 囚徒困境：双方以「进攻」为严格占优，且存在双方都更优的格；
 *   2. 懦夫博弈：对撞双输（同向对齐格劣于均衡）、单方退让成解——恰两个反对称均衡 (a,b)/(b,a)，
 *      退让动作可为「撤退」或「观望」（如进攻×观望 / 观望×进攻）；
 *   3. 智猪博弈：非对称支配结构（一方主导行动 / 交叉支配）；
 *   4. 协调博弈：存在双方一致行动的纯均衡（共识解）；
 *   5. 其它：无支配且均衡形态混合。
 */
export function classifyGame(
  payoffs: PayoffCell[][],
  pureNash: PureEquilibrium[],
  dominant: { long?: GameAction; short?: GameAction },
): GameType {
  const actionIndex = (action: GameAction): number => GAME_ACTIONS.indexOf(action)

  if (dominant.long === 'aggressive' && dominant.short === 'aggressive') {
    const clash = payoffs[0][0]
    const betterExists = payoffs.some((row) =>
      row.some((cell) => cell.long > clash.long + EPS && cell.short > clash.short + EPS),
    )
    if (betterExists) return 'prisoners-dilemma'
  }

  // 懦夫/鹰鸽：恰两个反对称均衡 (a,b)/(b,a)（a ≠ b），且双方「同向对齐」结局（a,a）/（b,b）
  // 均劣于各自可达的最优均衡收益——对撞双输、单方退让成解。
  if (pureNash.length === 2) {
    const [first, second] = pureNash
    const mirrored = first.long === second.short && first.short === second.long && first.long !== first.short
    if (mirrored) {
      const bestLong = Math.max(
        payoffs[actionIndex(first.long)][actionIndex(first.short)].long,
        payoffs[actionIndex(second.long)][actionIndex(second.short)].long,
      )
      const bestShort = Math.max(
        payoffs[actionIndex(first.long)][actionIndex(first.short)].short,
        payoffs[actionIndex(second.long)][actionIndex(second.short)].short,
      )
      const alignedWorse = (action: GameAction): boolean => {
        const aligned = payoffs[actionIndex(action)][actionIndex(action)]
        return aligned.long < bestLong - EPS && aligned.short < bestShort - EPS
      }
      if (alignedWorse(first.long) && alignedWorse(first.short)) return 'chicken'
    }
  }

  const dominantLong = dominant.long !== undefined
  const dominantShort = dominant.short !== undefined
  if ((dominantLong || dominantShort) && dominant.long !== dominant.short) return 'stag-hunt'

  if (pureNash.some((n) => n.long === n.short)) return 'coordination'

  return 'other'
}

// ---------------------------------------------------------------- 敏感性扫描

const SENSITIVITY_KEYS = ['priceImpact', 'conflictCost', 'carryCost', 'retreatLoss'] as const

function scanSensitivity(
  base: MatrixParams,
  baseType: GameType,
  basePureCount: number,
): SensitivityEntry[] {
  const out: SensitivityEntry[] = []
  for (const key of SENSITIVITY_KEYS) {
    for (const factor of [0.9, 1.1]) {
      const perturbed: MatrixParams = { ...base, [key]: base[key] * factor }
      const payoffs = buildPayoffs(perturbed)
      const pureNash = findPureNash(payoffs)
      const dominant = findDominantStrategies(payoffs)
      const gameType = classifyGame(payoffs, pureNash, dominant)
      out.push({
        param: key,
        factor,
        value: round(perturbed[key]),
        gameType,
        gameTypeLabel: GAME_TYPE_LABELS[gameType],
        pureNashCount: pureNash.length,
        changed: gameType !== baseType || pureNash.length !== basePureCount,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------- 叙事与入口

function pairText(equilibrium: PureEquilibrium): string {
  return `${ACTION_LABELS[equilibrium.long]}×${ACTION_LABELS[equilibrium.short]}`
}

function matrixNarrative(result: MatrixResult): string {
  const { payoffs, pureNash, mixedNash, dominant, gameType } = result
  const clash = payoffs[0][0]
  const bothRetreat = payoffs[2][2]
  const parts: string[] = []
  switch (gameType) {
    case 'prisoners-dilemma': {
      parts.push(
        `囚徒困境：双方「进攻」为严格占优策略，但对撞双输（${pct(clash.long)} / ${pct(clash.short)}）；` +
          `一致撤退对双方更优（${pct(bothRetreat.long)} / ${pct(bothRetreat.short)}）却无法自我维持——个体理性导致集体非理性。`,
      )
      break
    }
    case 'chicken': {
      parts.push(
        `懦夫博弈：双方同时「进攻」对撞双输（${pct(clash.long)} / ${pct(clash.short)}）；` +
          `单方退让即可化解（退让方 ${pct(payoffs[2][0].long)}、进攻方 ${pct(payoffs[2][0].short)}）——先退让方损失最小，但双方都怕成为退让者。`,
      )
      break
    }
    case 'coordination': {
      const consensus = pureNash.find((n) => n.long === n.short)
      if (consensus) {
        const cell = payoffs[GAME_ACTIONS.indexOf(consensus.long)][GAME_ACTIONS.indexOf(consensus.short)]
        parts.push(
          `协调博弈：双方一致「${ACTION_LABELS[consensus.long]}」是稳定共识（${pct(cell.long)} / ${pct(cell.short)}），` +
            '一致行动优于单方冒进或错位行动。',
        )
      } else {
        parts.push('协调博弈：市场倾向于形成共识解。')
      }
      break
    }
    case 'stag-hunt': {
      const leader = dominant.long ? '多头' : '空头'
      const leaderAction = dominant.long ?? dominant.short
      const followerSide = dominant.long ? '空头' : '多头'
      parts.push(
        `智猪博弈：支配结构不对称——${leader}以「${leaderAction ? ACTION_LABELS[leaderAction] : ''}」主导行动，` +
          `${followerSide}最优反应为跟随（搭便车 / 规避对撞成本），呈「强者行动、弱者跟随」格局。`,
      )
      break
    }
    default:
      parts.push('非经典结构：无严格占优策略、均衡形态混合，需结合参数区间具体解读。')
      break
  }

  const dominantText: string[] = []
  if (dominant.long) dominantText.push(`多头「${ACTION_LABELS[dominant.long]}」`)
  if (dominant.short) dominantText.push(`空头「${ACTION_LABELS[dominant.short]}」`)
  if (dominantText.length > 0) parts.push(`严格占优策略：${dominantText.join('、')}。`)

  if (pureNash.length > 0) {
    parts.push(`纯策略均衡 ${pureNash.length} 个：${pureNash.map(pairText).join('、')}。`)
  } else {
    parts.push('无纯策略均衡（仅混合策略均衡）。')
  }
  if (mixedNash.length > 0) {
    const degenerate = mixedNash.filter((item) => item.degenerate).length
    parts.push(`混合策略均衡 ${mixedNash.length} 个${degenerate > 0 ? `（其中退化 ${degenerate} 个）` : ''}。`)
  }

  return parts.join('')
}

export function runMatrix(params: Record<string, unknown> | undefined): ModelOutcome<MatrixResult> {
  const reader = new ParamReader(params, MATRIX_KNOWN_PARAMS)
  const parsed = parseMatrixParams(reader)
  const payoffs = buildPayoffs(parsed)
  const pureNash = findPureNash(payoffs)
  const dominant = findDominantStrategies(payoffs)
  const mixedNash = findMixedEquilibria(payoffs)
  const gameType = classifyGame(payoffs, pureNash, dominant)
  const sensitivity = scanSensitivity(parsed, gameType, pureNash.length)

  const result: MatrixResult = {
    actions: [...GAME_ACTIONS],
    payoffs: payoffs.map((row) => row.map((cell) => ({ long: round(cell.long), short: round(cell.short) }))),
    pureNash: pureNash.map((item) => ({ ...item })),
    mixedNash,
    dominant,
    gameType,
    gameTypeLabel: GAME_TYPE_LABELS[gameType],
    sensitivity,
  }

  return {
    result,
    stats: {
      gameType,
      gameTypeLabel: GAME_TYPE_LABELS[gameType],
      pureNashCount: pureNash.length,
      mixedNashCount: mixedNash.length,
      dominantLong: dominant.long ? ACTION_LABELS[dominant.long] : '无',
      dominantShort: dominant.short ? ACTION_LABELS[dominant.short] : '无',
      clashLong: round(clashOf(payoffs, 'long')),
      clashShort: round(clashOf(payoffs, 'short')),
    },
    narrative: matrixNarrative(result),
    params: {
      capital: { long: parsed.capitalLong, short: parsed.capitalShort },
      priceImpact: parsed.priceImpact,
      carryCost: parsed.carryCost,
      conflictCost: parsed.conflictCost,
      retreatLoss: parsed.retreatLoss,
    },
    warnings: reader.warnings,
  }
}

function clashOf(payoffs: PayoffCell[][], side: 'long' | 'short'): number {
  return payoffs[0][0][side]
}
