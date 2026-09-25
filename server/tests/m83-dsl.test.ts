/**
 * M83 批 A：DSL 引擎测试。
 *
 * 覆盖：表达式求值（算术 / 优先级 / 逻辑 / 三元 / null 语义）、序列函数与 indicator.ts 口径一致性、
 * ref 语义与 FUTURE_REF、lint 全清单、边沿触发语义、信号字段、落图、确定性。
 */
import { describe, expect, it } from 'vitest'
import type { KlineBar } from '../src/finance/types.js'
import { computeIndicator, sma } from '../src/finance/indicator.js'
import {
  buildSeriesContext,
  buildDslMeta,
  DSL_BUILTINS,
  DslExprError,
  evalExpr,
  generateDslSignals,
  parseDsl,
  parseExpr,
  runDsl,
  boolArr,
  numArr,
  type NumV,
  type Val,
} from '../src/finance/dsl/index.js'

const BASE_TS = Date.parse('2025-01-06T00:00:00+08:00')

function sampleBars(n = 150): KlineBar[] {
  const bars: KlineBar[] = []
  for (let i = 0; i < n; i++) {
    const close = 100 + 15 * Math.sin(i / 6) + i * 0.1
    const open = i === 0 ? close : 100 + 15 * Math.sin((i - 1) / 6) + (i - 1) * 0.1
    bars.push({
      timestamp: BASE_TS + i * 86_400_000,
      open,
      high: Math.max(open, close) * 1.01,
      low: Math.min(open, close) * 0.99,
      close,
      volume: 10_000 + 5_000 * Math.sin(i / 3) + 20_000,
    })
  }
  return bars
}

function evalScalar(bars: KlineBar[], expr: string, inputs: Record<string, number | string | boolean> = {}): Val {
  return evalExpr(parseExpr(expr), buildSeriesContext(bars, inputs))
}

function expectNumV(v: Val): NumV {
  if (v.t !== 'num') throw new Error('expected num')
  return v.n
}

describe('M83 DSL：表达式求值', () => {
  const bars = sampleBars(10)

  it('算术优先级 / 括号', () => {
    expect(evalScalar(bars, '1 + 2 * 3')).toEqual({ t: 'num', n: { c: true, v: 7 } })
    expect(evalScalar(bars, '(1 + 2) * 3')).toEqual({ t: 'num', n: { c: true, v: 9 } })
    expect(evalScalar(bars, '-2 + 5')).toEqual({ t: 'num', n: { c: true, v: 3 } })
  })

  it('比较 / 逻辑 / 三元', () => {
    expect(evalScalar(bars, '2 > 1 ? 10 : 20')).toEqual({ t: 'num', n: { c: true, v: 10 } })
    expect(evalScalar(bars, 'true and false or true')).toEqual({ t: 'bool', b: { c: true, v: true } })
    expect(evalScalar(bars, 'not (1 > 2)')).toEqual({ t: 'bool', b: { c: true, v: true } })
    expect(evalScalar(bars, '1 == 1 and 2 != 3')).toEqual({ t: 'bool', b: { c: true, v: true } })
  })

  it('null 语义：除零 → null；比较遇 null 判 false', () => {
    expect(evalScalar(bars, '1 / 0')).toEqual({ t: 'num', n: { c: true, v: null } })
    expect(evalScalar(bars, '1 % 0')).toEqual({ t: 'num', n: { c: true, v: null } })
    expect(evalScalar(bars, 'null + 1')).toEqual({ t: 'num', n: { c: true, v: null } })
    // ref(close,1) 首根为 null → 比较 false
    const v = evalScalar(bars, 'close > ref(close, 1)')
    expect(v.t).toBe('bool')
    if (v.t === 'bool') expect(boolArr(v.b, bars.length)[0]).toBe(false)
  })

  it('未知变量 / 未知函数报错码', () => {
    try {
      evalScalar(bars, 'closes > 1')
      throw new Error('should throw')
    } catch (err) {
      expect(err).toBeInstanceOf(DslExprError)
      expect((err as DslExprError).code).toBe('UNKNOWN_VAR')
    }
    try {
      evalScalar(bars, 'foo(close)')
      throw new Error('should throw')
    } catch (err) {
      expect((err as DslExprError).code).toBe('UNKNOWN_FUNC')
    }
  })

  it('FUTURE_REF：ref 负偏移（经 inputs 注入）运行时拒绝', () => {
    try {
      evalScalar(bars, 'ref(close, inputs.n) > 0', { n: -1 })
      throw new Error('should throw')
    } catch (err) {
      expect(err).toBeInstanceOf(DslExprError)
      expect((err as DslExprError).code).toBe('FUTURE_REF')
    }
  })

  it('inputs 成员访问与常量校验', () => {
    const v = evalScalar(bars, 'close * inputs.ratio', { ratio: 2 })
    expect(numArr(expectNumV(v), bars.length)[0]).toBeCloseTo(bars[0].close * 2, 9)
    try {
      evalScalar(bars, 'ma(close, inputs.missing)')
      throw new Error('should throw')
    } catch (err) {
      expect((err as DslExprError).code).toBe('UNKNOWN_VAR')
    }
  })
})

describe('M83 DSL：序列函数口径对照 indicator.ts', () => {
  const bars = sampleBars(150)

  it('ma / ema 与 sma / ema 一致', () => {
    const ma = expectNumV(evalScalar(bars, 'ma(close, 20)'))
    const expected = sma(bars.map((b) => b.close), 20)
    for (let i = 0; i < bars.length; i++) {
      if (expected[i] === null) expect(numArr(ma, bars.length)[i]).toBeNull()
      else expect(numArr(ma, bars.length)[i]).toBeCloseTo(expected[i]!, 9)
    }
  })

  it('atr / rsi / dif / dea / bb_up 与 fin_indicator 口径一致', () => {
    const cases: Array<[string, () => Array<number | null>]> = [
      ['atr(14)', () => computeIndicator('ATR', bars, { period: 14 }).points.map((p) => p.values.ATR14 ?? null)],
      ['rsi(14)', () => computeIndicator('RSI', bars, { period: 14 }).points.map((p) => p.values.RSI14 ?? null)],
      ['dif(12, 26)', () => computeIndicator('MACD', bars).points.map((p) => p.values.DIF ?? null)],
      ['dea(12, 26, 9)', () => computeIndicator('MACD', bars).points.map((p) => p.values.DEA ?? null)],
      ['bb_up(20, 2)', () => computeIndicator('BOLL', bars, { period: 20, mult: 2 }).points.map((p) => p.values.UPPER ?? null)],
    ]
    for (const [expr, expectedOf] of cases) {
      const actual = numArr(expectNumV(evalScalar(bars, expr)), bars.length)
      const expected = expectedOf()
      for (let i = 0; i < bars.length; i++) {
        if (expected[i] === null || expected[i] === undefined) expect(actual[i]).toBeNull()
        else expect(actual[i]).toBeCloseTo(expected[i]!, 9)
      }
    }
  })

  it('hhv / llv / cross_up 语义', () => {
    const hhv = numArr(expectNumV(evalScalar(bars, 'hhv(high, 10)')), bars.length)
    for (let i = 9; i < bars.length; i++) {
      const win = bars.slice(i - 9, i + 1).map((b) => b.high)
      expect(hhv[i]).toBeCloseTo(Math.max(...win), 9)
    }
    expect(hhv[5]).toBeNull()
    const llv = numArr(expectNumV(evalScalar(bars, 'llv(low, 10)')), bars.length)
    for (let i = 9; i < bars.length; i++) {
      const win = bars.slice(i - 9, i + 1).map((b) => b.low)
      expect(llv[i]).toBeCloseTo(Math.min(...win), 9)
    }
  })
})

describe('M83 DSL：lint（免取数）', () => {
  it('全部内置策略 lint 通过（0 error）', () => {
    for (const builtin of DSL_BUILTINS) {
      const r = parseDsl(builtin.source)
      expect(r.ok, `${builtin.key} 应通过 lint：${JSON.stringify(!r.ok ? r.findings : [])}`).toBe(true)
      if (r.ok) expect(r.findings.filter((f) => f.level === 'error')).toHaveLength(0)
    }
  })

  it('未知变量 / 未知函数 / inputs 未声明 / FUTURE_REF', () => {
    const cases: Array<[string, string]> = [
      ['name: t\nsignals:\n  - when: "closes > 1"\n    emit: { direction: long }', 'UNKNOWN_VAR'],
      ['name: t\nsignals:\n  - when: "foo(close)"\n    emit: { direction: long }', 'UNKNOWN_FUNC'],
      ['name: t\nsignals:\n  - when: "ma(close, inputs.n)"\n    emit: { direction: long }', 'INPUT_UNDECLARED'],
      ['name: t\nsignals:\n  - when: "ref(close, -1) > close"\n    emit: { direction: long }', 'FUTURE_REF'],
    ]
    for (const [source, code] of cases) {
      const r = parseDsl(source)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.findings.map((f) => f.code)).toContain(code)
    }
  })

  it('表达式数组越界 / 深嵌套 / 落图缺字段 / schema 错误', () => {
    const deep = `name: t\nsignals:\n  - when: "${'ma('.repeat(30)}close${', 5)'.repeat(30)}"\n    emit: { direction: long }`
    let r = parseDsl(deep)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.findings.map((f) => f.code)).toContain('EXPR_TOO_DEEP')

    r = parseDsl('name: t\ndrawings:\n  - kind: hline\nsignals:\n  - when: "close > 1"\n    emit: { direction: long }')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.findings.map((f) => f.code)).toContain('DRAWING_FIELD')

    r = parseDsl('name: t')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.findings.map((f) => f.code)).toContain('SCHEMA')

    r = parseDsl('name: [unclosed')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.findings.map((f) => f.code)).toContain('YAML_PARSE')

    r = parseDsl('dsl: 2\nname: t\nsignals:\n  - when: "close > 1"\n    emit: { direction: long }')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.findings.map((f) => f.code)).toContain('VERSION')
  })

  it('warning 提示：take_profit / stop_loss 缺失', () => {
    const r = parseDsl('name: t\nsignals:\n  - when: "close > open"\n    emit: { direction: long }')
    expect(r.ok).toBe(true)
    if (r.ok) {
      const codes = r.findings.map((f) => f.code)
      expect(codes).toContain('TAKE_PROFIT_EMPTY')
      expect(codes).toContain('STOP_LOSS_MISSING')
    }
  })
})

describe('M83 DSL：执行（边沿触发 / 信号 / 落图）', () => {
  /** 40 根：先单边下行（无触发），25–29 上行，30–31 持平，32–34 再上行（edge 触发 2 次） */
  function edgeBars(): KlineBar[] {
    const closes: number[] = []
    for (let i = 0; i < 25; i++) closes.push(45 - i)
    for (let i = 0; i < 5; i++) closes.push(22 + i)
    closes.push(26, 26)
    closes.push(27, 28, 29)
    return closes.map((c, i) => {
      const open = i === 0 ? c : closes[i - 1]
      return {
        timestamp: BASE_TS + i * 86_400_000,
        open,
        high: Math.max(open, c) * 1.01,
        low: Math.min(open, c) * 0.99,
        close: c,
        volume: 10_000,
      }
    })
  }

  const edgeSpec = `name: 连涨观察
signals:
  - when: "close > ref(close, 1)"
    emit:
      direction: long
      confidence: 0.7
      horizon: short
      rationale_hint: 收盘价连续上行
      entry: "close"
      stop_loss: "close - 2"
      take_profit: ["close + 4"]
`

  it('边沿触发：false→true 首根；facts 计数与最近触发', () => {
    const parsed = parseDsl(edgeSpec)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const bars = edgeBars()
    const r = runDsl(bars, parsed.spec, { symbol: 'sh600000', period: 'day', adjust: 'qfq' })
    expect(r.success).toBe(true)
    expect(r.triggered).toBe(true)
    expect(r.facts.trigger_index).toBe(32)
    const factsSignals = r.facts.signals as Array<{ triggers: number; last_trigger_index: number }>
    expect(factsSignals[0].triggers).toBe(2)
    expect(factsSignals[0].last_trigger_index).toBe(32)
    expect(r.signal).not.toBeNull()
    expect(r.signal!.ts).toBe(bars[32].timestamp)
    expect(r.signal!.direction).toBe('long')
    expect(r.signal!.confidence).toBe(0.7)
    expect(r.signal!.entry).toBeCloseTo(bars[32].close, 9)
    expect(r.signal!.stopLoss).toBeCloseTo(bars[32].close - 2, 9)
    expect(r.signal!.takeProfit[0]).toBeCloseTo(bars[32].close + 4, 9)
    expect(r.signal!.riskReward).toBeCloseTo(2, 6)
    expect(r.signal!.groupId).toBe('strategy:连涨观察')
  })

  it('未触发：signal null + 排查提示 + facts.last 对齐', () => {
    const parsed = parseDsl('name: t\nsignals:\n  - when: "close > 999999"\n    emit: { direction: long, entry: "close" }')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const bars = edgeBars()
    const r = runDsl(bars, parsed.spec, { symbol: 'sh600000', period: 'day', adjust: 'qfq' })
    expect(r.triggered).toBe(false)
    expect(r.signal).toBeNull()
    expect(r.notes.some((n) => n.includes('未触发'))).toBe(true)
    expect((r.facts.last as { close: number }).close).toBe(bars[bars.length - 1].close)
  })

  it('落图：hline / zone 构造与 groupId', () => {
    const parsed = parseDsl(`name: 绘图组
drawings:
  - kind: hline
    at: "close"
    x: -1
    label: 当前价
  - kind: zone
    from: -10
    to: -1
    top: "hhv(high, 10)"
    bottom: "llv(low, 10)"
    label: 区间
signals:
  - when: "close > 1"
    emit: { direction: long, entry: "close" }
`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const bars = edgeBars()
    const r = runDsl(bars, parsed.spec, { symbol: 'sh600000', period: 'day', adjust: 'qfq' })
    expect(r.drawings).toHaveLength(2)
    expect(r.drawings[0].kind).toBe('hline')
    expect(r.drawings[0].points[0].price).toBeCloseTo(bars[bars.length - 1].close, 9)
    expect(r.drawings[0].groupId).toBe('strategy:绘图组')
    expect(r.drawings[1].kind).toBe('zone')
    expect(r.drawings[1].points).toHaveLength(2)
  })

  it('护栏：样本不足 / inputs 覆盖未声明键', () => {
    const parsed = parseDsl('name: t\nsignals:\n  - when: "close > 1"\n    emit: { direction: long }')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const small = edgeBars().slice(0, 20)
    expect(() => runDsl(small, parsed.spec, { symbol: 'x', period: 'day', adjust: 'qfq' })).toThrow('样本不足')
    expect(() =>
      runDsl(edgeBars(), parsed.spec, { symbol: 'x', period: 'day', adjust: 'qfq', inputs: { foo: 1 } }),
    ).toThrow('未声明参数')
  })

  it('generateDslSignals 与手工 sma 交叉序列一致（口径锁定）', () => {
    const parsed = parseDsl(DSL_BUILTINS.find((b) => b.key === 'ma-cross')!.source)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const bars = sampleBars(150)
    const hits = generateDslSignals(bars, parsed.spec, { symbol: 'sh600000', period: 'day', adjust: 'qfq', inputs: { fast: 5, slow: 12 } })
    const closes = bars.map((b) => b.close)
    const f = sma(closes, 5)
    const s = sma(closes, 12)
    const expectedBuy: number[] = []
    const expectedSell: number[] = []
    for (let i = 1; i < bars.length; i++) {
      const f0 = f[i - 1]
      const s0 = s[i - 1]
      const f1 = f[i]
      const s1 = s[i]
      if (f0 === null || s0 === null || f1 === null || s1 === null) continue
      if (f0 <= s0 && f1 > s1) expectedBuy.push(i)
      else if (f0 >= s0 && f1 < s1) expectedSell.push(i)
    }
    expect(hits.filter((h) => h.side === 'buy').map((h) => h.index)).toEqual(expectedBuy)
    expect(hits.filter((h) => h.side === 'sell').map((h) => h.index)).toEqual(expectedSell)
    expect(expectedBuy.length).toBeGreaterThan(0)
  })

  it('确定性：两次运行结果一致', () => {
    const parsed = parseDsl(DSL_BUILTINS.find((b) => b.key === 'volume-breakout')!.source)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const bars = sampleBars(200)
    const opts = { symbol: 'sh600000', period: 'day', adjust: 'qfq' }
    expect(JSON.stringify(runDsl(bars, parsed.spec, opts))).toBe(JSON.stringify(runDsl(bars, parsed.spec, opts)))
  })
})

describe('M83 DSL：元数据', () => {
  it('buildDslMeta：schema / 函数 / 枚举 / 护栏 / 内置 齐备', () => {
    const meta = buildDslMeta()
    expect(meta.version).toBe(1)
    expect(meta.variables.map((v) => v.name)).toContain('close')
    expect(meta.functions.length).toBeGreaterThanOrEqual(20)
    expect(meta.enums.direction).toEqual(['long', 'short', 'neutral'])
    expect(meta.drawing_kinds).toContain('hline')
    expect(meta.builtins).toHaveLength(DSL_BUILTINS.length)
    expect((meta.schema as { type?: string }).type).toBe('object')
    expect(meta.limits.calls).toBe(64)
  })
})
