/**
 * 博弈引擎类型契约与参数助手（M34 §5.4）。
 *
 * 公共入参 `GameScenario` → 公共出参 `GameResult`；纯计算零网络零 IO。
 * 参数纪律：非法值抛 GameError（工具层转中文错误）；未知参数记 warning（宽容）。
 */

export type GameModel = 'matrix' | 'sequence' | 'evolve' | 'simulate'

/** 模型清单（tuple 常量：zod 枚举 / 路由参数校验直接复用） */
export const GAME_MODELS = ['matrix', 'sequence', 'evolve', 'simulate'] as const satisfies readonly GameModel[]

/** 默认种子（文档 §5.4 约定；相同 seed + params 输出逐位一致） */
export const DEFAULT_GAME_SEED = 20260918

export const MODEL_LABELS: Record<GameModel, string> = {
  matrix: '静态矩阵博弈',
  sequence: '序贯博弈（逆向归纳）',
  evolve: '演化博弈（复制动态）',
  simulate: 'ABM 蒙特卡洛',
}

export class GameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GameError'
  }
}

export interface GameScenario {
  /** 模型（工具 action：matrix | sequence | evolve | simulate） */
  action: GameModel
  /** 议题（如「茅台多空对峙」） */
  topic: string
  /** 关联标的（可选） */
  symbol?: string
  /** 模型参数（各模型自行解析；未知参数记 warning） */
  params?: Record<string, unknown>
  /** 随机种子（默认 20260918） */
  seed?: number
}

export type GameStatValue = number | string | boolean | number[]
export type GameStats = Record<string, GameStatValue>

export interface GameResult<R = unknown> {
  model: GameModel
  topic: string
  symbol?: string
  /** 规范化后的实际参数（回显，供快照与前端复跑） */
  params: Record<string, unknown>
  seed: number
  result: R
  /** 关键指标摘要（工具展示 / 结论卡用） */
  stats: GameStats
  /** 解要点文本（供模型引用） */
  narrative: string
  warnings?: string[]
}

/** 各模型统一返回（index 组装 GameResult） */
export interface ModelOutcome<R> {
  result: R
  stats: GameStats
  narrative: string
  /** 规范化参数回显 */
  params: Record<string, unknown>
  warnings: string[]
}

// ---------------------------------------------------------------- 参数助手

export interface NumOpts {
  min?: number
  max?: number
  /** 取整（四舍五入后校验范围） */
  int?: boolean
}

/** 参数读取器：未知参数记 warning；非法值抛 GameError */
export class ParamReader {
  readonly warnings: string[] = []
  private readonly params: Record<string, unknown>

  constructor(params: Record<string, unknown> | undefined, known: readonly string[]) {
    this.params = params ?? {}
    for (const key of Object.keys(this.params)) {
      if (!known.includes(key)) this.warnings.push(`未知参数已忽略：${key}`)
    }
  }

  has(key: string): boolean {
    return this.params[key] !== undefined && this.params[key] !== null
  }

  num(key: string, def: number, opts: NumOpts = {}): number {
    return this.readValue(key, this.params[key], def, opts)
  }

  /** 数值对：支持 number（对称）或 { long, short }（资本不对称） */
  pair(key: string, def: [number, number], opts: NumOpts = {}): [number, number] {
    const raw = this.params[key]
    if (raw === undefined || raw === null) return [def[0], def[1]]
    if (Array.isArray(raw)) {
      return [
        this.readValue(`${key}[0]`, raw[0], def[0], opts),
        this.readValue(`${key}[1]`, raw[1], def[1], opts),
      ]
    }
    if (typeof raw === 'object') {
      const obj = raw as { long?: unknown; short?: unknown }
      return [
        this.readValue(`${key}.long`, obj.long, def[0], opts),
        this.readValue(`${key}.short`, obj.short, def[1], opts),
      ]
    }
    const value = this.readValue(key, raw, def[0], opts)
    return [value, value]
  }

  /** 数值数组（如演化模型多初值） */
  numArray(key: string, def: number[], opts: NumOpts & { maxLen?: number } = {}): number[] {
    const raw = this.params[key]
    if (raw === undefined || raw === null) return [...def]
    if (!Array.isArray(raw)) throw new GameError(`参数 ${key} 应为数字数组`)
    if (raw.length === 0) throw new GameError(`参数 ${key} 不能为空数组`)
    if (opts.maxLen !== undefined && raw.length > opts.maxLen) {
      throw new GameError(`参数 ${key} 至多 ${opts.maxLen} 项`)
    }
    return raw.map((item, idx) => this.readValue(`${key}[${idx}]`, item, Number.NaN, opts))
  }

  /** 冲击事件数组 [{ round, size }]（ABM 预设时点大单；size 正 = 利多冲击） */
  shocks(key: string, maxLen = 20): Array<{ round: number; size: number }> {
    const raw = this.params[key]
    if (raw === undefined || raw === null) return []
    if (!Array.isArray(raw)) throw new GameError(`参数 ${key} 应为数组 [{ round, size }]`)
    if (raw.length > maxLen) throw new GameError(`参数 ${key} 至多 ${maxLen} 项`)
    return raw.map((item, idx) => {
      const obj = (item ?? {}) as { round?: unknown; size?: unknown }
      return {
        round: this.readValue(`${key}[${idx}].round`, obj.round, Number.NaN, { min: 0, int: true }),
        size: this.readValue(`${key}[${idx}].size`, obj.size, Number.NaN, { min: -20, max: 20 }),
      }
    })
  }

  /** 枚举（字符串参数，如 leader / feedback） */
  choice<T extends string>(key: string, def: T, allowed: readonly T[]): T {
    const raw = this.params[key]
    if (raw === undefined || raw === null) return def
    const value = String(raw) as T
    if (!allowed.includes(value)) {
      throw new GameError(`参数 ${key} 应为 ${allowed.join(' / ')}（收到：${String(raw)}）`)
    }
    return value
  }

  private readValue(key: string, raw: unknown, def: number, opts: NumOpts): number {
    if (raw === undefined || raw === null) {
      if (Number.isNaN(def)) throw new GameError(`参数 ${key} 必填`)
      return def
    }
    const value = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(value)) {
      throw new GameError(`参数 ${key} 应为数字（收到：${JSON.stringify(raw)}）`)
    }
    const out = opts.int ? Math.round(value) : value
    if (opts.min !== undefined && out < opts.min) throw new GameError(`参数 ${key} 不得小于 ${opts.min}`)
    if (opts.max !== undefined && out > opts.max) throw new GameError(`参数 ${key} 不得大于 ${opts.max}`)
    return out
  }
}

// ---------------------------------------------------------------- 数值格式化

/** 输出圆整（防浮点噪声进入快照与断言；默认 6 位） */
export function round(value: number, digits = 6): number {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** 百分比文本（+6.0% / -8.0%）；入参为比例（0.06 → +6.0%） */
export function pct(value: number, digits = 1): string {
  const text = (value * 100).toFixed(digits)
  return value > 0 ? `+${text}%` : `${text}%`
}
