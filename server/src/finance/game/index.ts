/**
 * 博弈引擎入口（M34 §5.4）：`runGame` 模型分发 + 快照构建（可复现资产）。
 *
 * 复现口径：相同 `seed + params` 输出逐位一致；快照含 meta（参数 / 种子 / 生成时间），
 * 落盘命名 `charts/game-<topic-slug>-<yyyymmddHHMM>.json`（kind: 'game'，写盘由工具层执行）。
 */
import { snapshotStamp } from '../snapshot.js'
import { runEvolve } from './evolve.js'
import { runMatrix } from './matrix.js'
import { runSequence } from './sequence.js'
import { runSimulate } from './simulate.js'
import { DEFAULT_GAME_SEED, GameError, GAME_MODELS, type GameModel, type GameResult, type GameScenario, type GameStats, type ModelOutcome } from './types.js'

export * from './types.js'
export * from './prng.js'
export * from './matrix.js'
export * from './sequence.js'
export * from './evolve.js'
export * from './simulate.js'

function normalizeSeed(seed: unknown): number {
  if (typeof seed !== 'number' || !Number.isFinite(seed)) return DEFAULT_GAME_SEED
  return Math.floor(seed)
}

/** 运行博弈推演（纯计算零 IO；未知模型 / 非法参数抛 GameError） */
export function runGame(scenario: GameScenario): GameResult {
  const action = scenario?.action
  if (!GAME_MODELS.includes(action)) {
    throw new GameError(`未知博弈模型：${String(action)}（可选：${GAME_MODELS.join(' / ')}）`)
  }
  const seed = normalizeSeed(scenario.seed)
  const topic = typeof scenario.topic === 'string' && scenario.topic.trim() ? scenario.topic.trim() : '未命名推演'
  const outcome: ModelOutcome<unknown> =
    action === 'matrix'
      ? runMatrix(scenario.params)
      : action === 'sequence'
        ? runSequence(scenario.params)
        : action === 'evolve'
          ? runEvolve(scenario.params)
          : runSimulate(scenario.params, seed)

  const result: GameResult = {
    model: action,
    topic,
    seed,
    params: outcome.params,
    result: outcome.result,
    stats: outcome.stats,
    narrative: outcome.narrative,
  }
  if (scenario.symbol) result.symbol = scenario.symbol
  if (outcome.warnings.length > 0) result.warnings = [...outcome.warnings]
  return result
}

// ---------------------------------------------------------------- 快照（可复现资产）

export interface GameSnapshot {
  kind: 'game'
  model: GameModel
  topic: string
  symbol?: string
  seed: number
  meta: {
    /** 规范化参数（复现用） */
    params: Record<string, unknown>
    /** 生成时间（ISO8601） */
    asOf: string
    note?: string
  }
  stats: GameStats
  narrative: string
  result: unknown
}

/** GameResult → game 快照（chart-snapshot 的博弈姊妹 schema） */
export function buildGameSnapshot(result: GameResult, opts: { asOf?: string; note?: string } = {}): GameSnapshot {
  return {
    kind: 'game',
    model: result.model,
    topic: result.topic,
    ...(result.symbol ? { symbol: result.symbol } : {}),
    seed: result.seed,
    meta: {
      params: result.params,
      asOf: opts.asOf ?? new Date().toISOString(),
      ...(opts.note ? { note: opts.note } : {}),
    },
    stats: result.stats,
    narrative: result.narrative,
    result: result.result,
  }
}

/** 快照文件名：`game-<topic-slug>-<yyyymmddHHMM>.json`（北京时间戳） */
export function gameSnapshotFilename(topic: string, date: Date = new Date()): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return `game-${slug || 'game'}-${snapshotStamp(date)}.json`
}
