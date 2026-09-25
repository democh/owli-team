/**
 * 增强字段解析（M83 §5.2）：`drawings` / `signal` / `analysis` 的宽松收窄 + 降级。
 *
 * 纪律（与主契约分离）：
 * - `bars` / `indicators` 非法 → 显式报错（模型自纠通道，见 kline-spec.ts）；
 * - 增强字段非法 → 丢弃该条 / 该字段并收集 warnings，主图照常渲染
 *   （增强数据脏不应让图挂掉；引擎 / 工具产出的数据天然合法，此防线只兜模型手写块）。
 * 类型全部来自 shared 契约（单源），本模块零依赖纯函数。
 */
import {
  DRAWING_KINDS,
  KLINE_PHASES,
  SENTIMENT_STAGES,
  type Drawing,
  type DrawingKind,
  type KlineAnalysis,
  type KlineFeatureTag,
  type KlineLevelRef,
  type KlinePhase,
  type KlinePhaseBand,
  type KlineTargetRef,
  type SignalSpec,
  type SignalDirection,
} from '@multi-agent/shared'

export interface Parsed<T> {
  value?: T
  warnings: string[]
}

/** 增强字段上限（与设计稿一致：drawings ≤60 条） */
export const ENHANCE_LIMITS = { drawings: 60, bands: 500 } as const

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

// ---------------------------------------------------------------- drawings

function parseDrawing(raw: unknown): Drawing | null {
  if (!isObj(raw)) return null
  const kind = typeof raw.kind === 'string' ? raw.kind.trim() : ''
  if (!(DRAWING_KINDS as readonly string[]).includes(kind)) return null
  const pointsRaw = Array.isArray(raw.points) ? raw.points : []
  const points: Array<{ ts: number; price: number }> = []
  for (const p of pointsRaw) {
    if (!isObj(p)) return null
    const ts = num(p.ts)
    const price = num(p.price)
    if (ts === undefined || price === undefined) return null
    points.push({ ts, price })
  }
  if (points.length === 0) return null
  const styleRaw = isObj(raw.style) ? raw.style : undefined
  const style = styleRaw
    ? {
        ...(typeof styleRaw.color === 'string' ? { color: styleRaw.color } : {}),
        ...(num(styleRaw.width) !== undefined ? { width: num(styleRaw.width)! } : {}),
        ...(typeof styleRaw.dash === 'boolean' ? { dash: styleRaw.dash } : {}),
        ...(typeof styleRaw.fill === 'string' ? { fill: styleRaw.fill } : {}),
        ...(num(styleRaw.stop) !== undefined ? { stop: num(styleRaw.stop)! } : {}),
        ...(num(styleRaw.target) !== undefined ? { target: num(styleRaw.target)! } : {}),
      }
    : undefined
  const quality = num(raw.quality)
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : `d-${kind}-${points[0].ts}`,
    kind: kind as DrawingKind,
    points,
    ...(typeof raw.label === 'string' && raw.label !== '' ? { label: raw.label } : {}),
    ...(style && Object.keys(style).length > 0 ? { style } : {}),
    ...(typeof raw.groupId === 'string' && raw.groupId !== '' ? { groupId: raw.groupId } : {}),
    ...(typeof raw.explain === 'string' && raw.explain !== '' ? { explain: raw.explain } : {}),
    ...(quality !== undefined ? { quality } : {}),
  }
}

/** drawings 解析（单条非法只丢该条；上限 60） */
export function parseDrawings(raw: unknown): Parsed<Drawing[]> {
  const warnings: string[] = []
  if (raw === undefined || raw === null) return { value: [], warnings }
  if (!Array.isArray(raw)) return { warnings: ['drawings 必须是数组（已忽略）'] }
  if (raw.length > ENHANCE_LIMITS.drawings) warnings.push(`drawings 超过 ${ENHANCE_LIMITS.drawings} 条（仅取前 ${ENHANCE_LIMITS.drawings}）`)
  const value: Drawing[] = []
  const slice = raw.slice(0, ENHANCE_LIMITS.drawings)
  slice.forEach((item, i) => {
    const d = parseDrawing(item)
    if (d) value.push(d)
    else warnings.push(`drawings[${i}] 非法（已丢弃）`)
  })
  return { value, warnings }
}

// ---------------------------------------------------------------- signal

/** 信号解析（非法 → null + warning） */
export function parseSignal(raw: unknown): Parsed<SignalSpec | null> {
  if (raw === undefined || raw === null) return { value: null, warnings: [] }
  if (!isObj(raw)) return { warnings: ['signal 应为对象（已忽略）'] }
  const direction = raw.direction
  if (direction !== 'long' && direction !== 'short' && direction !== 'neutral') {
    return { warnings: ['signal.direction 非法（应为 long / short / neutral；已忽略）'] }
  }
  const takeProfitRaw = Array.isArray(raw.takeProfit) ? raw.takeProfit : []
  const takeProfit = takeProfitRaw.map((v) => num(v)).filter((v): v is number => v !== undefined)
  const entry = num(raw.entry) ?? null
  const stopLoss = num(raw.stopLoss) ?? null
  const confidence = num(raw.confidence)
  const value: SignalSpec = {
    symbol: typeof raw.symbol === 'string' ? raw.symbol : '',
    period: typeof raw.period === 'string' ? raw.period : '',
    ts: num(raw.ts) ?? 0,
    direction: direction as SignalDirection,
    confidence: confidence ?? 0.5,
    horizon: typeof raw.horizon === 'string' ? raw.horizon : 'swing',
    entry,
    stopLoss,
    takeProfit,
    riskReward: num(raw.riskReward) ?? null,
    rationale: typeof raw.rationale === 'string' ? raw.rationale : '',
    ...(typeof raw.groupId === 'string' && raw.groupId !== '' ? { groupId: raw.groupId } : {}),
  }
  return { value, warnings: [] }
}

// ---------------------------------------------------------------- analysis

function parseBand(raw: unknown): KlinePhaseBand | null {
  if (!isObj(raw)) return null
  const ts = num(raw.ts)
  const phase = typeof raw.phase === 'string' ? raw.phase : ''
  if (ts === undefined || !(KLINE_PHASES as readonly string[]).includes(phase)) return null
  return { ts, phase: phase as KlinePhase }
}

function parseLevelRef(raw: unknown): KlineLevelRef | null {
  if (!isObj(raw)) return null
  const price = num(raw.price)
  if (price === undefined) return null
  return {
    price,
    basis: typeof raw.basis === 'string' ? raw.basis : '',
    touches: num(raw.touches) ?? 0,
  }
}

function parseTargetRef(raw: unknown): KlineTargetRef | null {
  if (!isObj(raw)) return null
  const price = num(raw.price)
  if (price === undefined) return null
  return { price, basis: typeof raw.basis === 'string' ? raw.basis : '' }
}

/** 分析结论解析（形状任一关键块缺失 → 忽略整个字段 + warning） */
export function parseKlineAnalysis(raw: unknown): Parsed<KlineAnalysis> {
  if (raw === undefined || raw === null) return { warnings: [] }
  if (!isObj(raw)) return { warnings: ['analysis 应为对象（已忽略）'] }
  const phasesRaw = raw.phases
  const sentimentRaw = raw.sentiment
  if (!isObj(phasesRaw) || !isObj(sentimentRaw)) {
    return { warnings: ['analysis.phases / sentiment 缺失（已忽略分析面板）'] }
  }
  const current = typeof phasesRaw.current === 'string' ? phasesRaw.current : ''
  if (!(KLINE_PHASES as readonly string[]).includes(current)) {
    return { warnings: ['analysis.phases.current 非法（已忽略分析面板）'] }
  }
  const stage = typeof sentimentRaw.stage === 'string' ? sentimentRaw.stage : ''
  if (!(SENTIMENT_STAGES as readonly string[]).includes(stage)) {
    return { warnings: ['analysis.sentiment.stage 非法（已忽略分析面板）'] }
  }
  const bandsRaw = Array.isArray(phasesRaw.bands) ? phasesRaw.bands : []
  const bands = bandsRaw
    .slice(0, ENHANCE_LIMITS.bands)
    .map((b) => parseBand(b))
    .filter((b): b is KlinePhaseBand => b !== null)
  const levelsRaw = isObj(raw.levels) ? raw.levels : {}
  const featuresRaw = Array.isArray(raw.features) ? raw.features : []
  const features: KlineFeatureTag[] = []
  for (const f of featuresRaw) {
    if (!isObj(f) || typeof f.label !== 'string' || f.label === '') continue
    features.push({
      key: typeof f.key === 'string' ? f.key : f.label,
      label: f.label,
      confirmed: f.confirmed !== false,
    })
  }
  const drawings = parseDrawings(raw.drawings)
  const notes = Array.isArray(raw.notes) ? raw.notes.filter((n): n is string => typeof n === 'string') : []
  const value: KlineAnalysis = {
    asOf: typeof raw.asOf === 'string' ? raw.asOf : '',
    bars: num(raw.bars) ?? 0,
    period: typeof raw.period === 'string' ? raw.period : '',
    adjust: typeof raw.adjust === 'string' ? raw.adjust : '',
    phases: {
      current: current as KlinePhase,
      confidence: num(phasesRaw.confidence) ?? 0,
      since: typeof phasesRaw.since === 'string' ? phasesRaw.since : '',
      description: typeof phasesRaw.description === 'string' ? phasesRaw.description : '',
      bands,
    },
    sentiment: {
      score: num(sentimentRaw.score) ?? 0,
      stage: stage as KlineAnalysis['sentiment']['stage'],
      pathLabel: typeof sentimentRaw.pathLabel === 'string' ? sentimentRaw.pathLabel : '',
    },
    levels: {
      support: parseLevelRef(levelsRaw.support),
      resistance: parseLevelRef(levelsRaw.resistance),
      target: parseTargetRef(levelsRaw.target),
    },
    features,
    drawings: drawings.value ?? [],
    notes,
  }
  return { value, warnings: [...drawings.warnings, ...(bands.length < bandsRaw.length ? ['analysis.phases.bands 存在非法条目（已丢弃）'] : [])] }
}
