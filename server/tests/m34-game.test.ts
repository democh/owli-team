/**
 * M34 博弈引擎测试（§5.4）：PRNG 确定性 / 矩阵求解（纯 + 混合纳什 / 类型识别 / 敏感性）/
 * 序贯逆向归纳 / 演化复制动态 / ABM 蒙特卡洛统计与护栏 / 入口与快照。
 *
 * 纯计算零网络；全部确定性断言（相同 seed + params 输出逐位一致）。
 */
import { describe, expect, it } from 'vitest'
import {
  buildGameSnapshot,
  findDominantStrategies,
  findMixedEquilibria,
  findPureNash,
  gameSnapshotFilename,
  GAME_ACTIONS,
  mulberry32,
  runGame,
  runMatrix,
  runSimulate,
  type EvolveResult,
  type GameResult,
  type MatrixResult,
  type PayoffCell,
  type SequenceResult,
  type SimulateResult,
} from '../src/finance/game/index.js'
import { GameError, DEFAULT_GAME_SEED } from '../src/finance/game/types.js'

// ---------------------------------------------------------------- PRNG

describe('M34 博弈：PRNG（mulberry32 确定性）', () => {
  it('同 seed 序列一致且落在 [0,1)；不同 seed 序列不同', () => {
    const a = mulberry32(20260918)
    const b = mulberry32(20260918)
    const c = mulberry32(20260919)
    const seqA: number[] = []
    const seqB: number[] = []
    const seqC: number[] = []
    for (let i = 0; i < 64; i++) {
      seqA.push(a.next())
      seqB.push(b.next())
      seqC.push(c.next())
    }
    expect(seqA).toEqual(seqB)
    expect(seqA).not.toEqual(seqC)
    for (const value of seqA) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it('normal() 统计性质（均值 ≈ 0、标准差 ≈ 1）', () => {
    const prng = mulberry32(42)
    const samples: number[] = []
    for (let i = 0; i < 20000; i++) samples.push(prng.normal())
    const mean = samples.reduce((acc, v) => acc + v, 0) / samples.length
    const variance = samples.reduce((acc, v) => acc + (v - mean) ** 2, 0) / samples.length
    expect(Math.abs(mean)).toBeLessThan(0.05)
    expect(Math.abs(Math.sqrt(variance) - 1)).toBeLessThan(0.05)
  })
})

// ---------------------------------------------------------------- 矩阵博弈

function matrixResult(params?: Record<string, unknown>): GameResult<MatrixResult> {
  return runGame({ action: 'matrix', topic: '多空对峙', ...(params ? { params } : {}) }) as GameResult<MatrixResult>
}

describe('M34 博弈：静态矩阵（收益矩阵 / 纯均衡 / 类型识别）', () => {
  it('默认参数：双方进攻对撞双输，收益矩阵数值符合公式', () => {
    const out = matrixResult()
    const payoffs = out.result.payoffs
    // (进攻, 进攻)：对撞双输
    expect(payoffs[0][0].long).toBeCloseTo(-0.08, 6)
    expect(payoffs[0][0].short).toBeCloseTo(-0.08, 6)
    // (进攻, 撤退)：进攻方 +6.0%、撤退方 -6.0%
    expect(payoffs[0][2]).toMatchObject({ long: 0.06, short: -0.06 })
    expect(payoffs[2][0]).toMatchObject({ long: -0.06, short: 0.06 })
    // (撤退, 撤退)：和平离场 +3.0%
    expect(payoffs[2][2]).toMatchObject({ long: 0.03, short: 0.03 })
    // (进攻, 观望) / (观望, 观望)
    expect(payoffs[0][1].long).toBeCloseTo(-0.014, 6)
    expect(payoffs[1][1].long).toBeCloseTo(-0.0248, 6)
  })

  it('默认参数识别为懦夫博弈：纯均衡恰为 进攻×撤退 / 撤退×进攻，对撞格非均衡', () => {
    const out = matrixResult()
    expect(out.result.gameType).toBe('chicken')
    expect(out.stats.gameTypeLabel).toBe('懦夫博弈')
    const pure = out.result.pureNash
    expect(pure).toHaveLength(2)
    expect(pure).toContainEqual({ long: 'aggressive', short: 'retreat' })
    expect(pure).toContainEqual({ long: 'retreat', short: 'aggressive' })
    expect(pure).not.toContainEqual({ long: 'aggressive', short: 'aggressive' })
    expect(out.result.dominant.long).toBeUndefined()
    expect(out.result.dominant.short).toBeUndefined()
    expect(out.narrative).toContain('懦夫博弈')
  })

  it('囚徒困境参数（conflictCost≈0）：双方「进攻」严格占优但存在双赢协调格', () => {
    const out = matrixResult({ conflictCost: 0.005 })
    expect(out.result.gameType).toBe('prisoners-dilemma')
    expect(out.result.dominant).toMatchObject({ long: 'aggressive', short: 'aggressive' })
    expect(out.result.pureNash).toEqual([{ long: 'aggressive', short: 'aggressive' }])
    expect(out.narrative).toContain('囚徒困境')
  })

  it('协调参数（高持仓成本）：存在双方一致行动的共识均衡', () => {
    const out = matrixResult({ priceImpact: 0.045, conflictCost: 0.02, carryCost: 0.06 })
    expect(out.result.gameType).toBe('coordination')
    expect(out.result.pureNash).toContainEqual({ long: 'hold', short: 'hold' })
    expect(out.result.dominant).toMatchObject({ long: 'hold', short: 'hold' })
  })

  it('智猪参数（资本不对称）：交叉支配 + 强者行动 / 弱者跟随', () => {
    const out = matrixResult({ conflictCost: 0.02, capital: { long: 2e8, short: 5e7 } })
    expect(out.result.gameType).toBe('stag-hunt')
    expect(out.result.dominant).toEqual({ long: 'aggressive', short: 'hold' })
    expect(out.result.pureNash).toEqual([{ long: 'aggressive', short: 'hold' }])
    expect(out.narrative).toContain('智猪博弈')
    expect(out.params.capital).toEqual({ long: 2e8, short: 5e7 })
  })

  it('capital 支持对称数值形态；参数越界 / 非数字抛 GameError，未知参数记 warning', () => {
    const symmetric = matrixResult({ capital: 1e8 })
    expect(symmetric.params.capital).toEqual({ long: 1e8, short: 1e8 })
    expect(symmetric.result.gameType).toBe('chicken')

    expect(() => runGame({ action: 'matrix', topic: 't', params: { capital: 0 } })).toThrow(GameError)
    expect(() => runGame({ action: 'matrix', topic: 't', params: { priceImpact: 'abc' } })).toThrow(/数字/)

    const unknown = matrixResult({ mystery: 1 })
    expect(unknown.warnings?.[0]).toContain('未知参数')
  })

  it('敏感性扫描：4 参数 × ±10% 共 8 条，默认点结构稳定（懦夫型保持）', () => {
    const out = matrixResult()
    expect(out.result.sensitivity).toHaveLength(8)
    expect(out.result.sensitivity.every((entry) => entry.gameType === 'chicken')).toBe(true)
    expect(out.result.sensitivity.every((entry) => entry.pureNashCount === 2)).toBe(true)
    expect(out.result.sensitivity.map((entry) => entry.param)).toEqual([
      'priceImpact', 'priceImpact', 'conflictCost', 'conflictCost', 'carryCost', 'carryCost', 'retreatLoss', 'retreatLoss',
    ])
  })

  it('边界参数点：接近临界时 ±10% 可改变均衡结构（chicken → 囚徒困境）', () => {
    // priceImpact = 0.09 为实证刀锋点：基准仍为懦夫型，+10% 翻转成囚徒困境（进攻占优）
    const out = matrixResult({ priceImpact: 0.09 })
    expect(out.result.gameType).toBe('chicken')
    const changed = out.result.sensitivity.filter((entry) => entry.changed)
    expect(changed.length).toBeGreaterThan(0)
    expect(
      changed.some(
        (entry) => entry.param === 'priceImpact' && entry.factor === 1.1 && entry.gameType === 'prisoners-dilemma',
      ),
    ).toBe(true)
    // 反向：基准囚徒困境，-10% 退回懦夫型
    const pdBase = matrixResult({ priceImpact: 0.098 })
    expect(pdBase.result.gameType).toBe('prisoners-dilemma')
    expect(
      pdBase.result.sensitivity.some(
        (entry) => entry.param === 'priceImpact' && entry.factor === 0.9 && entry.changed && entry.gameType === 'chicken',
      ),
    ).toBe(true)
  })
})

describe('M34 博弈：混合策略均衡（support enumeration）', () => {
  it('石头剪刀布（3×3）：唯一混合均衡 (1/3, 1/3, 1/3)，无纯均衡', () => {
    const rps: PayoffCell[][] = [
      [
        { long: 0, short: 0 },
        { long: 1, short: -1 },
        { long: -1, short: 1 },
      ],
      [
        { long: -1, short: 1 },
        { long: 0, short: 0 },
        { long: 1, short: -1 },
      ],
      [
        { long: 1, short: -1 },
        { long: -1, short: 1 },
        { long: 0, short: 0 },
      ],
    ]
    expect(findPureNash(rps, GAME_ACTIONS)).toEqual([])
    const mixed = findMixedEquilibria(rps, GAME_ACTIONS)
    expect(mixed.length).toBeGreaterThanOrEqual(1)
    const uniform = mixed.find((item) => Math.abs(item.long.aggressive - 1 / 3) < 1e-6)
    expect(uniform).toBeDefined()
    expect(uniform?.long.hold).toBeCloseTo(1 / 3, 6)
    expect(uniform?.long.retreat).toBeCloseTo(1 / 3, 6)
    expect(uniform?.short.aggressive).toBeCloseTo(1 / 3, 6)
    expect(uniform?.degenerate).toBe(false)
  })

  it('默认矩阵：混合均衡概率有效（各分量 ∈ [0,1] 且和 = 1）', () => {
    const out = matrixResult()
    expect(out.result.mixedNash.length).toBeGreaterThanOrEqual(1)
    for (const item of out.result.mixedNash) {
      const longSum = GAME_ACTIONS.reduce((acc, action) => acc + (item.long[action] ?? 0), 0)
      const shortSum = GAME_ACTIONS.reduce((acc, action) => acc + (item.short[action] ?? 0), 0)
      expect(longSum).toBeCloseTo(1, 6)
      expect(shortSum).toBeCloseTo(1, 6)
      for (const action of GAME_ACTIONS) {
        expect(item.long[action] ?? 0).toBeGreaterThanOrEqual(0)
        expect(item.short[action] ?? 0).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('支配策略检出：严格占优逐行逐列验证；匹配硬币（零和）无支配', () => {
    const dominance: PayoffCell[][] = [
      [
        { long: 3, short: 0 },
        { long: 3, short: 1 },
      ],
      [
        { long: 2, short: 0 },
        { long: 2, short: 1 },
      ],
    ]
    const dominant = findDominantStrategies(dominance, ['aggressive', 'hold'])
    // 多头：aggressive 两列均严格优于 hold（3 > 2）；空头：hold 两行均严格优于 aggressive（1 > 0）
    expect(dominant.long).toBe('aggressive')
    expect(dominant.short).toBe('hold')

    const matchingPennies: PayoffCell[][] = [
      [
        { long: 1, short: -1 },
        { long: -1, short: 1 },
      ],
      [
        { long: -1, short: 1 },
        { long: 1, short: -1 },
      ],
    ]
    const none = findDominantStrategies(matchingPennies, ['aggressive', 'hold'])
    expect(none.long).toBeUndefined()
    expect(none.short).toBeUndefined()
  })
})

// ---------------------------------------------------------------- 序贯博弈

function sequenceResult(params?: Record<string, unknown>): GameResult<SequenceResult> {
  return runGame({ action: 'sequence', topic: '先动', ...(params ? { params } : {}) }) as GameResult<SequenceResult>
}

describe('M34 博弈：序贯博弈（逆向归纳）', () => {
  it('默认（多头主导）：均衡路径 进攻 → 撤退；树含 3 分支 × 3 叶', () => {
    const out = sequenceResult()
    const tree = out.result.tree
    expect(tree.player).toBe('long')
    expect(tree.children).toHaveLength(3)
    for (const branch of tree.children ?? []) {
      expect(branch.children).toHaveLength(3)
      for (const leaf of branch.children ?? []) {
        expect(leaf.payoffs).toBeDefined()
      }
    }
    expect(out.result.equilibrium.path).toEqual([
      { player: 'long', action: 'aggressive' },
      { player: 'short', action: 'retreat' },
    ])
    expect(out.result.equilibrium.payoffs).toMatchObject({ long: 0.06, short: -0.06 })
    expect(out.stats.equilibriumPath).toBe('进攻 → 撤退')
  })

  it('均衡路径 / 最优反应标记：onPath 贯穿 root → 均衡分支 → 均衡叶', () => {
    const out = sequenceResult()
    const tree = out.result.tree
    expect(tree.onPath).toBe(true)
    const onPathBranches = (tree.children ?? []).filter((branch) => branch.onPath)
    expect(onPathBranches).toHaveLength(1)
    expect(onPathBranches[0].action).toBe('aggressive')
    expect(onPathBranches[0].optimal).toBe(true)
    const onPathLeaves = (onPathBranches[0].children ?? []).filter((leaf) => leaf.onPath)
    expect(onPathLeaves).toHaveLength(1)
    expect(onPathLeaves[0].action).toBe('retreat')
    for (const branch of tree.children ?? []) {
      expect((branch.children ?? []).filter((leaf) => leaf.optimal)).toHaveLength(1)
    }
  })

  it('反事实对比：替代分支（观望 / 撤退）结局与收益差', () => {
    const out = sequenceResult()
    const counterfactuals = out.result.counterfactuals
    expect(counterfactuals).toHaveLength(2)
    expect(counterfactuals[0].action).toBe('retreat')
    expect(counterfactuals[0].followerBest).toBe('aggressive')
    expect(counterfactuals[0].leaderDelta).toBeCloseTo(-0.12, 6)
    const hold = counterfactuals.find((item) => item.action === 'hold')
    expect(hold?.followerBest).toBe('aggressive')
    expect(hold?.leaderDelta).toBeCloseTo(-0.1208, 6)
    expect(out.stats.firstMoverAdvantage).toBeCloseTo(0.12, 6)
  })

  it("leader='short'：角色反转（空头先动、收益归属对调）", () => {
    const out = sequenceResult({ leader: 'short' })
    expect(out.result.leader).toBe('short')
    expect(out.result.follower).toBe('long')
    expect(out.result.equilibrium.payoffs).toMatchObject({ long: -0.06, short: 0.06 })
    expect(out.narrative).toContain('空头主导')

    expect(() => runGame({ action: 'sequence', topic: 't', params: { leader: 'both' } })).toThrow(GameError)
  })
})

// ---------------------------------------------------------------- 演化博弈

function evolveResult(params?: Record<string, unknown>): GameResult<EvolveResult> {
  return runGame({ action: 'evolve', topic: '演化', ...(params ? { params } : {}) }) as GameResult<EvolveResult>
}

describe('M34 博弈：演化博弈（复制动态）', () => {
  it('默认参数：固定点 0 / 0.5 / 1，ESS = 0.5，各初值向均衡收敛', () => {
    const out = evolveResult()
    const points = out.result.fixedPoints
    expect(points).toHaveLength(3)
    expect(points.map((point) => point.x)).toEqual([0, 0.5, 1])
    expect(points.find((point) => point.x === 0.5)?.stable).toBe(true)
    expect(points.filter((point) => point.x !== 0.5).every((point) => !point.stable)).toBe(true)
    expect(out.result.ess).toEqual([0.5])
    expect(out.result.curves).toHaveLength(5)
    const finals = out.result.curves.map((curve) => curve.points[curve.points.length - 1].x)
    expect(finals[0]).toBeGreaterThan(0.3) // x0 = 0.05 明显上移
    expect(finals[4]).toBeLessThan(0.7) // x0 = 0.95 明显下移
    expect(out.result.neutral).toBe(false)
  })

  it('强正反馈参数：两极分化（赢家通吃），边界 0 / 1 为 ESS', () => {
    const out = evolveResult({ priceImpact: 0.08, carryCost: 0.1 })
    expect(out.result.ess).toEqual([0, 1])
    const finals = out.result.curves.map((curve) => curve.points[curve.points.length - 1].x)
    expect(finals[0]).toBeLessThan(0.01)
    expect(finals[4]).toBeGreaterThan(0.99)
    expect(out.narrative).toContain('两极分化')
  })

  it('logistic 反馈：固定点结构正常（0.5 稳定）', () => {
    const out = evolveResult({ feedback: 'logistic', priceImpact: 0.02, carryCost: 0.1 })
    expect(out.result.feedback).toBe('logistic')
    const interior = out.result.fixedPoints.filter((point) => point.kind === 'interior')
    expect(interior.some((point) => Math.abs(point.x - 0.5) < 1e-3 && point.stable)).toBe(true)
  })

  it('中性退化（2 × priceImpact = carryCost）：无渐进稳定解 + warning', () => {
    const out = evolveResult({ priceImpact: 0.05, carryCost: 0.1 })
    expect(out.result.neutral).toBe(true)
    expect(out.result.ess).toEqual([])
    expect(out.warnings?.some((warning) => warning.includes('中性'))).toBe(true)
  })

  it('自定义初值 / 护栏：initialValues 生效；积分步数超限抛错', () => {
    const out = evolveResult({ initialValues: [0.1, 0.9], duration: 40 })
    expect(out.result.curves.map((curve) => curve.x0)).toEqual([0.1, 0.9])
    expect(out.params.duration).toBe(40)
    expect(() => runGame({ action: 'evolve', topic: 't', params: { duration: 200, dt: 0.001 } })).toThrow(
      /步数过大/,
    )
  })
})

// ---------------------------------------------------------------- ABM 蒙特卡洛

function simulateResult(params?: Record<string, unknown>, seed?: number): GameResult<SimulateResult> {
  return runGame({
    action: 'simulate',
    topic: '推演',
    ...(params ? { params } : {}),
    ...(seed !== undefined ? { seed } : {}),
  }) as GameResult<SimulateResult>
}

describe('M34 博弈：ABM 蒙特卡洛', () => {
  it('确定性：同 seed + params 输出逐位一致；不同 seed 结果不同', () => {
    const params = { rounds: 30, paths: 40 }
    const a = simulateResult(params, 7)
    const b = simulateResult(params, 7)
    const c = simulateResult(params, 8)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c))
  })

  it('统计结构：分位带单调、抽样路径数、直方图总数 = 路径数、事件概率互斥归 1', () => {
    const out = simulateResult({ rounds: 60, paths: 100 })
    const bands = out.result.bands
    expect(bands.rounds).toHaveLength(61)
    for (let i = 0; i < bands.p5.length; i++) {
      expect(bands.p5[i]).toBeLessThanOrEqual(bands.p25[i] + 1e-9)
      expect(bands.p25[i]).toBeLessThanOrEqual(bands.p50[i] + 1e-9)
      expect(bands.p50[i]).toBeLessThanOrEqual(bands.p75[i] + 1e-9)
      expect(bands.p75[i]).toBeLessThanOrEqual(bands.p95[i] + 1e-9)
      expect(bands.p5[i]).toBeGreaterThan(0) // 价格正性保护
    }
    expect(out.result.samplePaths).toHaveLength(20)
    expect(out.result.samplePaths[0]).toHaveLength(61)
    const bins = out.result.finalHistogram
    expect(bins).toHaveLength(30)
    expect(bins.reduce((acc, bin) => acc + bin.count, 0)).toBe(100)
    const { squeeze, crash, stalemate, other } = out.result.events
    expect(squeeze + crash + stalemate + other).toBeCloseTo(1, 6)
  })

  it('挤空场景（大额利多冲击 + 低阈值）：空头级联与挤空概率显著上升', () => {
    const out = simulateResult({
      shockEvents: [
        { round: 20, size: 2.5 },
        { round: 40, size: 2.5 },
      ],
      cascadeThreshold: 0.05,
    })
    expect(out.result.cascade.shortSqueezed).toBeGreaterThan(0.6)
    expect(out.result.events.squeeze).toBeGreaterThan(0.5)
    expect(out.result.pnl.long.p50).toBeGreaterThan(0)
    expect(out.narrative).toContain('挤空')
  })

  it('默认参数回显（文档口径：500 × 120 / 阈值 0.08）', () => {
    const out = simulateResult()
    expect(out.params).toMatchObject({ rounds: 120, paths: 500, cascadeThreshold: 0.08, sigma: 0.004 })
    expect(out.stats.squeezeProb).toBeGreaterThanOrEqual(0)
    expect(out.stats.squeezeProb).toBeLessThanOrEqual(1)
  })

  it('护栏：paths / rounds 越界与事件轮次超界均抛 GameError', () => {
    expect(() => runGame({ action: 'simulate', topic: 't', params: { paths: 3000 } })).toThrow(/paths/)
    expect(() => runGame({ action: 'simulate', topic: 't', params: { rounds: 500 } })).toThrow(/rounds/)
    expect(() =>
      runGame({ action: 'simulate', topic: 't', params: { rounds: 10, shockEvents: [{ round: 12, size: 1 }] } }),
    ).toThrow(/轮次/)
  })

  it('护栏上限 2000 × 240 可在超时内完成（< 2s）', () => {
    const started = Date.now()
    const out = runSimulate({ paths: 2000, rounds: 240 }, DEFAULT_GAME_SEED)
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(2000)
    expect(out.result.paths).toBe(2000)
  })
})

// ---------------------------------------------------------------- 入口与快照

describe('M34 博弈：入口分发与快照', () => {
  it('未知模型抛 GameError；默认 seed = 20260918；topic 清洗与 symbol 传递', () => {
    expect(() => runGame({ action: 'poker' as never, topic: 't' })).toThrow(/未知博弈模型/)
    const out = runGame({ action: 'matrix', topic: '  茅台多空对峙  ', symbol: 'sh600519' })
    expect(out.seed).toBe(DEFAULT_GAME_SEED)
    expect(out.topic).toBe('茅台多空对峙')
    expect(out.symbol).toBe('sh600519')
    expect(out.model).toBe('matrix')
  })

  it('buildGameSnapshot：kind/model/seed/meta.params/narrative/result 完整', () => {
    const out = runGame({ action: 'matrix', topic: '茅台多空对峙', symbol: 'sh600519' })
    const snapshot = buildGameSnapshot(out, { asOf: '2026-09-18T10:30:00+08:00', note: '首期校准' })
    expect(snapshot.kind).toBe('game')
    expect(snapshot.model).toBe('matrix')
    expect(snapshot.seed).toBe(DEFAULT_GAME_SEED)
    expect(snapshot.meta.asOf).toBe('2026-09-18T10:30:00+08:00')
    expect(snapshot.meta.note).toBe('首期校准')
    expect(snapshot.meta.params).toMatchObject({ priceImpact: 0.06 })
    expect(snapshot.narrative).toContain('懦夫博弈')
    expect(snapshot.result).toBeDefined()
  })

  it('gameSnapshotFilename：北京时间戳与 topic slug（保留中文）', () => {
    const date = new Date('2026-09-18T02:30:00Z') // 北京 10:30
    expect(gameSnapshotFilename('茅台多空对峙', date)).toBe('game-茅台多空对峙-202609181030.json')
    expect(gameSnapshotFilename('贵州茅台 600519 多空对峙！', date)).toBe('game-贵州茅台-600519-多空对峙-202609181030.json')
    expect(gameSnapshotFilename('!!!', date)).toBe('game-game-202609181030.json')
  })
})

// ---------------------------------------------------------------- 矩阵求解辅助函数（内部导出一致性）

describe('M34 博弈：矩阵求解辅助函数', () => {
  it('runMatrix 与 runGame 分发结果一致；纯均衡计数与 stats 对齐', () => {
    const direct = runMatrix({})
    const viaGame = matrixResult()
    expect(JSON.stringify(direct.result)).toBe(JSON.stringify(viaGame.result))
    expect(viaGame.stats.pureNashCount).toBe(viaGame.result.pureNash.length)
    expect(viaGame.stats.mixedNashCount).toBe(viaGame.result.mixedNash.length)
  })
})
