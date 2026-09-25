/**
 * K 线分析契约（M83 批 A）：图表渲染 / 分析结论 / 策略信号 的跨端单源类型与枚举。
 *
 * server（分析引擎 / DSL 引擎 / 工具 / 快照）与 client（图表组件族 / 块解析）共用——
 * 主副图指标、落图 kind、阶段枚举的「多处人工同步」由此升级为编译器保证。
 * 纯类型 + 常量：零运行时依赖，双端安全引用。
 */

// ---------------------------------------------------------------- 指标枚举

/** 主图指标（K 线块 render.mainIndicator / 图表工具条；'none' 为合法渲染值，由消费方联合） */
export const MAIN_INDICATORS = ['MA', 'EMA', 'BOLL', 'KCB', 'SAR', 'ICHIMOKU', 'ST', 'DONCHIAN'] as const
export type MainIndicator = (typeof MAIN_INDICATORS)[number]

/** 副图指标 */
export const SUB_INDICATORS = ['VOL', 'MACD', 'KDJ', 'RSI', 'ATR'] as const
export type SubIndicator = (typeof SUB_INDICATORS)[number]

/** 渲染面板全量枚举（主图 + 副图；块 indicators 旧字段与 /finance/kline render 共用） */
export const KLINE_RENDER_INDICATORS = [...MAIN_INDICATORS, ...SUB_INDICATORS] as const
export type KlineRenderIndicator = (typeof KLINE_RENDER_INDICATORS)[number]

/** 块 / 快照的渲染配置（全部可选；缺省由消费方按 indicators 旧字段推导） */
export interface KlineRender {
  mainIndicator?: MainIndicator | 'none'
  subIndicator?: SubIndicator | 'none'
  showPhases?: boolean
}

// ---------------------------------------------------------------- 落图契约

/** 落图 kind 白名单（与 client chart/drawings.ts 映射表一一对应） */
export const DRAWING_KINDS = [
  'hline',
  'vline',
  'segment',
  'trendline',
  'ray',
  'zone',
  'rect',
  'textLabel',
  'position',
  'fibonacci',
  'polyline',
] as const
export type DrawingKind = (typeof DRAWING_KINDS)[number]

export interface DrawingPoint {
  /** 毫秒时间戳（与 bars 的口径一致） */
  ts: number
  price: number
}

export interface DrawingStyle {
  color?: string
  width?: number
  dash?: boolean
  fill?: string
  stop?: number
  target?: number
}

export interface Drawing {
  id: string
  kind: DrawingKind
  points: DrawingPoint[]
  label?: string
  style?: DrawingStyle
  groupId?: string
  explain?: string
  /** 质量分；<35 客户端淡化（预留） */
  quality?: number | null
  extend?: Record<string, unknown>
}

// ---------------------------------------------------------------- 信号契约

export type SignalDirection = 'long' | 'short' | 'neutral'

export interface SignalSpec {
  symbol: string
  period: string
  ts: number
  direction: SignalDirection
  confidence: number
  horizon: string
  entry: number | null
  stopLoss: number | null
  takeProfit: number[]
  riskReward: number | null
  rationale: string
  groupId?: string
}

// ---------------------------------------------------------------- 阶段 / 分析结论

/** 十阶段（与 client phaseColors / phaseBand overlay 一一对应） */
export const KLINE_PHASES = [
  'accumulation',
  'bottoming',
  'wash',
  'markup',
  'climax',
  'distribution',
  'markdown',
  'panic',
  'rebound',
  'range',
] as const
export type KlinePhase = (typeof KLINE_PHASES)[number]

/** 逐根阶段（历史阶段条 / 阶段色带消费） */
export interface KlinePhaseBand {
  ts: number
  phase: KlinePhase
}

/** 市场情绪档位（恐慌 → 狂热 五档） */
export const SENTIMENT_STAGES = ['panic', 'hesitate', 'repair', 'optimistic', 'euphoric'] as const
export type SentimentStage = (typeof SENTIMENT_STAGES)[number]

export interface KlineAnalysisPhaseInfo {
  current: KlinePhase
  /** 0-100（规则化强度加权，非概率） */
  confidence: number
  /** 当前阶段起始日（YYYY-MM-DD） */
  since: string
  /** 中文短描述（引擎确定性模板） */
  description: string
  bands: KlinePhaseBand[]
}

export interface KlineAnalysisSentiment {
  /** 0-100 */
  score: number
  stage: SentimentStage
  /** 固定路径标签（含当前档位标注） */
  pathLabel: string
}

/** 关键位出处引用（basis = 前高 / 前低 / 密集区 / 箱体…；touches = 触碰次数） */
export interface KlineLevelRef {
  price: number
  basis: string
  touches: number
}

export interface KlineTargetRef {
  price: number
  basis: string
}

export interface KlineAnalysisLevels {
  support: KlineLevelRef | null
  resistance: KlineLevelRef | null
  target: KlineTargetRef | null
}

/** 底部 / 形态特征标签（confirmed=false 表示近似口径） */
export interface KlineFeatureTag {
  key: string
  label: string
  confirmed: boolean
}

export interface KlineAnalysis {
  asOf: string
  bars: number
  period: string
  adjust: string
  phases: KlineAnalysisPhaseInfo
  sentiment: KlineAnalysisSentiment
  levels: KlineAnalysisLevels
  features: KlineFeatureTag[]
  drawings: Drawing[]
  /** 口径说明（固定含「阶段判定为规则化统计口径，仅供复盘研究」） */
  notes: string[]
}
