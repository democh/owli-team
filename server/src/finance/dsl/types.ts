/**
 * DSL 规范类型（M83 §4.3）：策略 YAML 的运行时契约与 lint 结论类型。
 * 对外信号 / 落图契约（SignalSpec / Drawing）来自 shared，本文件只描述 DSL 文本形态。
 */
import type { DrawingKind, SignalDirection } from '@multi-agent/shared'

/** 信号规则 emit 段 */
export interface DslEmit {
  direction: SignalDirection
  /** 0–1；缺省 0.5 */
  confidence?: number
  horizon?: string
  rationale_hint?: string
  entry?: string
  stop_loss?: string
  take_profit?: string[]
}

export interface DslSignalRule {
  when: string
  emit: DslEmit
}

export interface DslDrawingPointRule {
  /** bar 索引（负 = 倒数）或 yyyy-MM-dd 日期 */
  x: number | string
  /** 价格表达式（在该锚点求值） */
  y: string
}

/** 落图规则（kind 语义与客户端 drawings 引擎映射一致） */
export interface DslDrawingRule {
  kind: DrawingKind
  /** 价格表达式（hline / textLabel） */
  at?: string
  /** 锚点（bar 索引：负 = 倒数；或 yyyy-MM-dd） */
  x?: number | string
  from?: number | string
  to?: number | string
  /** 区域上下沿表达式（zone / rect） */
  top?: string
  bottom?: string
  /** 交易计划（position） */
  entry?: string
  stop_loss?: string
  take_profit?: string[]
  /** 多点（segment / trendline / ray / fibonacci / polyline） */
  points?: DslDrawingPointRule[]
  label?: string
  color?: string
  dash?: boolean
}

/** 归一化策略规范（parse 成功后结构） */
export interface DslSpec {
  dsl: 1
  name: string
  description: string
  timeframes: string[]
  inputs: Record<string, number | string | boolean>
  signals: DslSignalRule[]
  drawings: DslDrawingRule[]
  llm: { system_hint: string; fields: string[] }
}

/** lint 发现（error 阻断执行；warning 提示） */
export interface DslFinding {
  level: 'error' | 'warning'
  code: string
  message: string
  /** 定位路径（如 signals[0].when / drawings[2].at） */
  path?: string
}

export type DslParseResult =
  | { ok: true; spec: DslSpec; findings: DslFinding[] }
  | { ok: false; findings: DslFinding[] }
