/**
 * DSL 执行（M83 §4.3）：条件求值 → 边沿触发 → 信号 / 落图 / facts。
 *
 * 执行模型与 fin_backtest 对齐：第 i 根收盘产生信号（i+1 根开盘成交由回测引擎处理）；
 * `generateDslSignals` 为共享信号层——fin_strategy（信号落图）与 fin_backtest(template='dsl')
 * 共用同一实现，口径唯一。
 */
import type { Drawing, SignalSpec, SignalDirection } from '@multi-agent/shared'
import { formatCnDate, parseCnDate } from '../period.js'
import type { KlineBar } from '../types.js'
import { DslExprError, parseExpr, type ExprNode } from './expr.js'
import { boolArr, buildSeriesContext, evalExpr, valueAt, type SeriesContext } from './runtime.js'
import type { DslDrawingRule, DslSpec } from './types.js'

/** 执行护栏：最小样本 */
const MIN_BARS = 30

export interface DslRunOptions {
  symbol: string
  period: string
  adjust: string
  /** inputs 覆盖（仅允许声明过的键） */
  inputs?: Record<string, number | string | boolean>
}

export interface DslSignalHit {
  index: number
  side: 'buy' | 'sell'
  direction: SignalDirection
}

/** 单规则执行摘要（facts 用） */
export interface DslRuleFact {
  rule: number
  when: string
  direction: SignalDirection
  triggers: number
  last_when: boolean | null
  last_trigger_index: number | null
  last_trigger_date: string | null
}

export interface DslRunResult {
  success: true
  name: string
  facts: Record<string, unknown>
  signal: SignalSpec | null
  drawings: Drawing[]
  triggered: boolean
  notes: string[]
}

function mergeInputs(spec: DslSpec, override?: Record<string, number | string | boolean>): Record<string, number | string | boolean> {
  const merged: Record<string, number | string | boolean> = { ...spec.inputs }
  if (!override) return merged
  for (const key of Object.keys(override)) {
    if (!(key in spec.inputs)) {
      throw new DslExprError('INPUT_UNKNOWN', `inputs 覆盖含未声明参数「${key}」（请在策略 inputs 段声明）`)
    }
    merged[key] = override[key]
  }
  return merged
}

/** 布尔条件序列（边沿触发的前置） */
function evalBoolSeries(expr: string, ctx: SeriesContext, nodeOf: (e: string) => ExprNode): boolean[] {
  const v = evalExpr(nodeOf(expr), ctx)
  if (v.t !== 'bool') throw new DslExprError('TYPE', 'when 条件必须是布尔表达式（比较 / 逻辑 / cross_up 等）')
  return boolArr(v.b, ctx.n)
}

/** 逐规则边沿触发（false→true 的首根；第 0 根不触发） */
function edgeTriggers(bools: boolean[]): number[] {
  const out: number[] = []
  for (let i = 1; i < bools.length; i++) {
    if (!bools[i - 1] && bools[i]) out.push(i)
  }
  return out
}

/**
 * 共享信号层：DSL → 交易信号序列（buy / sell）。
 * 供 fin_backtest(template='dsl') 与 fin_strategy 共用；neutral 不产生可执行信号。
 */
export function generateDslSignals(bars: KlineBar[], spec: DslSpec, opts: DslRunOptions): DslSignalHit[] {
  if (bars.length < MIN_BARS) throw new DslExprError('BAR_LIMIT', `K 线样本不足（${bars.length} 根 < ${MIN_BARS} 根）：请扩大 limit`)
  const ctx = buildSeriesContext(bars, mergeInputs(spec, opts.inputs))
  const cache = new Map<string, ExprNode>()
  const nodeOf = (e: string): ExprNode => {
    let n = cache.get(e)
    if (!n) {
      n = parseExpr(e)
      cache.set(e, n)
    }
    return n
  }
  const hits: DslSignalHit[] = []
  for (const rule of spec.signals) {
    if (rule.emit.direction === 'neutral') continue
    const bools = evalBoolSeries(rule.when, ctx, nodeOf)
    const side: 'buy' | 'sell' = rule.emit.direction === 'long' ? 'buy' : 'sell'
    for (const index of edgeTriggers(bools)) hits.push({ index, side, direction: rule.emit.direction })
  }
  hits.sort((a, b) => a.index - b.index)
  return hits
}

/** 执行主入口（表达式错误抛 DslExprError；落图错误降级为 notes） */
export function runDsl(bars: KlineBar[], spec: DslSpec, opts: DslRunOptions): DslRunResult {
  if (bars.length < MIN_BARS) throw new DslExprError('BAR_LIMIT', `K 线样本不足（${bars.length} 根 < ${MIN_BARS} 根）：请扩大 limit`)
  const merged = mergeInputs(spec, opts.inputs)
  const ctx = buildSeriesContext(bars, merged)
  const cache = new Map<string, ExprNode>()
  const nodeOf = (e: string): ExprNode => {
    let n = cache.get(e)
    if (!n) {
      n = parseExpr(e)
      cache.set(e, n)
    }
    return n
  }

  // ① 逐规则触发
  const ruleFacts: DslRuleFact[] = []
  let lastTrigger: { rule: number; index: number } | null = null
  for (let ruleIndex = 0; ruleIndex < spec.signals.length; ruleIndex++) {
    const rule = spec.signals[ruleIndex]
    const bools = evalBoolSeries(rule.when, ctx, nodeOf)
    const triggers = edgeTriggers(bools)
    ruleFacts.push({
      rule: ruleIndex,
      when: rule.when,
      direction: rule.emit.direction,
      triggers: triggers.length,
      last_when: ctx.n > 0 ? bools[ctx.n - 1] : null,
      last_trigger_index: triggers.length > 0 ? triggers[triggers.length - 1] : null,
      last_trigger_date: triggers.length > 0 ? formatCnDate(ctx.timestamps[triggers[triggers.length - 1]]) : null,
    })
    const last = triggers.length > 0 ? triggers[triggers.length - 1] : -1
    if (last >= 0 && (lastTrigger === null || last > lastTrigger.index)) lastTrigger = { rule: ruleIndex, index: last }
  }

  // ② 信号构造（最近一次触发；各 emit 表达式在该根求值）
  const numAt = (expr: string | undefined, index: number): number | null => {
    if (!expr) return null
    const v = evalExpr(nodeOf(expr), ctx)
    if (v.t !== 'num') throw new DslExprError('TYPE', `「${expr}」需为数值表达式`)
    return valueAt(v.n, index)
  }
  let signal: SignalSpec | null = null
  if (lastTrigger) {
    const { rule: ri, index } = lastTrigger
    const emit = spec.signals[ri].emit
    const entry = numAt(emit.entry, index)
    const stopLoss = numAt(emit.stop_loss, index)
    const takeProfit = (emit.take_profit ?? [])
      .map((e) => numAt(e, index))
      .filter((v): v is number => v !== null)
    const riskReward =
      entry !== null && stopLoss !== null && takeProfit.length > 0 && Math.abs(entry - stopLoss) > 1e-9
        ? Math.round((Math.abs(takeProfit[0] - entry) / Math.abs(entry - stopLoss)) * 100) / 100
        : null
    signal = {
      symbol: opts.symbol,
      period: opts.period,
      ts: ctx.timestamps[index],
      direction: emit.direction,
      confidence: emit.confidence ?? 0.5,
      horizon: emit.horizon ?? 'swing',
      entry,
      stopLoss,
      takeProfit,
      riskReward,
      rationale: emit.rationale_hint || `条件触发：${emit.entry ? '' : ''}${ruleFacts[ri].when}`.trim(),
      groupId: `strategy:${spec.name}`,
    }
  }

  // ③ 落图（单条失败降级为 notes，不阻断）
  const notes: string[] = []
  const drawings: Drawing[] = []
  spec.drawings.forEach((rule, idx) => {
    try {
      const built = buildDrawing(rule, idx, ctx, nodeOf, spec.name)
      if (built) drawings.push(built)
      else notes.push(`落图 drawings[${idx}]（${rule.kind}）跳过：锚点或取值不可用`)
    } catch (err) {
      notes.push(`落图 drawings[${idx}]（${rule.kind}）失败：${(err as Error).message}`)
    }
  })

  const lastBar = bars[bars.length - 1]
  const facts: Record<string, unknown> = {
    name: spec.name,
    bars: ctx.n,
    inputs: merged,
    last: {
      ts: lastBar.timestamp,
      date: formatCnDate(lastBar.timestamp),
      open: lastBar.open,
      high: lastBar.high,
      low: lastBar.low,
      close: lastBar.close,
      volume: lastBar.volume,
    },
    triggered: lastTrigger !== null,
    trigger_index: lastTrigger?.index ?? null,
    trigger_date: lastTrigger ? formatCnDate(ctx.timestamps[lastTrigger.index]) : null,
    signals: ruleFacts,
  }
  if (!lastTrigger) {
    notes.push('未触发：可按 facts.signals 各规则的 last_when / triggers 排查（哪条 when 为假、历史是否触发过）')
  }
  notes.unshift('信号为边沿触发（第 i 根收盘产生；执行口径对齐回测：第 i+1 根开盘成交）')
  notes.push('规则化统计结果，不构成投资建议')

  return { success: true, name: spec.name, facts, signal, drawings, triggered: lastTrigger !== null, notes }
}

// ---------------------------------------------------------------- 落图

function resolveAnchor(x: number | string | undefined, fallback: number, ctx: SeriesContext): number | null {
  if (x === undefined) return fallback >= 0 && fallback < ctx.n ? fallback : null
  if (typeof x === 'number') {
    const idx = x < 0 ? ctx.n + x : x
    return idx >= 0 && idx < ctx.n ? idx : null
  }
  const ts = parseCnDate(x)
  if (!Number.isFinite(ts)) return null
  for (let i = 0; i < ctx.n; i++) {
    if (ctx.timestamps[i] >= ts) return i
  }
  return null
}

function buildDrawing(
  rule: DslDrawingRule,
  idx: number,
  ctx: SeriesContext,
  nodeOf: (e: string) => ExprNode,
  strategyName: string,
): Drawing | null {
  const groupId = `strategy:${strategyName}`
  const id = `dsl-${idx}`
  const numAt = (expr: string | undefined, index: number): number | null => {
    if (!expr) return null
    const v = evalExpr(nodeOf(expr), ctx)
    if (v.t !== 'num') throw new DslExprError('TYPE', `「${expr}」需为数值表达式`)
    return valueAt(v.n, index)
  }
  const style = {
    ...(rule.color ? { color: rule.color } : {}),
    ...(rule.dash !== undefined ? { dash: rule.dash } : {}),
  }
  const base: Pick<Drawing, 'id' | 'groupId' | 'label'> = {
    id,
    groupId,
    ...(rule.label ? { label: rule.label } : {}),
  }

  switch (rule.kind) {
    case 'hline': {
      const anchor = resolveAnchor(rule.x, ctx.n - 1, ctx)
      if (anchor === null) return null
      const price = numAt(rule.at, anchor)
      if (price === null) return null
      return { ...base, kind: 'hline', points: [{ ts: ctx.timestamps[anchor], price }], style }
    }
    case 'vline': {
      const anchor = resolveAnchor(rule.x, ctx.n - 1, ctx)
      if (anchor === null) return null
      const price = ctx.series.close[anchor] ?? 0
      return { ...base, kind: 'vline', points: [{ ts: ctx.timestamps[anchor], price }], style }
    }
    case 'textLabel': {
      const anchor = resolveAnchor(rule.x, ctx.n - 1, ctx)
      if (anchor === null) return null
      const price = numAt(rule.at, anchor)
      if (price === null) return null
      return { ...base, kind: 'textLabel', points: [{ ts: ctx.timestamps[anchor], price }], style }
    }
    case 'zone':
    case 'rect': {
      const from = resolveAnchor(rule.from, Math.max(0, ctx.n - 40), ctx)
      const to = resolveAnchor(rule.to, ctx.n - 1, ctx)
      if (from === null || to === null) return null
      const top = numAt(rule.top, to)
      const bottom = numAt(rule.bottom, to)
      if (top === null || bottom === null) return null
      if (from === to) return null
      return {
        ...base,
        kind: rule.kind,
        points: [
          { ts: ctx.timestamps[from], price: top },
          { ts: ctx.timestamps[to], price: bottom },
        ],
        style,
      }
    }
    case 'segment':
    case 'trendline':
    case 'ray':
    case 'fibonacci':
    case 'polyline': {
      const pts: Array<{ ts: number; price: number }> = []
      for (const p of rule.points ?? []) {
        const anchor = resolveAnchor(p.x, -1, ctx)
        if (anchor === null) return null
        const price = numAt(p.y, anchor)
        if (price === null) return null
        pts.push({ ts: ctx.timestamps[anchor], price })
      }
      if (pts.length < 2) return null
      return { ...base, kind: rule.kind, points: pts, style }
    }
    case 'position': {
      const start = Math.max(0, ctx.n - 40)
      const end = ctx.n - 1
      const entry = numAt(rule.entry, end)
      if (entry === null) return null
      const stop = numAt(rule.stop_loss, end)
      const target = numAt((rule.take_profit ?? [])[0], end)
      return {
        ...base,
        kind: 'position',
        points: [
          { ts: ctx.timestamps[start], price: entry },
          { ts: ctx.timestamps[end], price: entry },
        ],
        style: {
          ...style,
          ...(stop !== null ? { stop } : {}),
          ...(target !== null ? { target } : {}),
        },
      }
    }
  }
}
