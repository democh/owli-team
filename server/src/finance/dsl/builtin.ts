/**
 * 内置示例策略（M83 §4.3）：4 条可直接 lint / run 的 DSL 源码。
 *
 * - `ma-cross` / `boll-breakout` / `rsi-reversal` 与 fin_backtest 同参数模板对齐——
 *   用于「模板 ↔ DSL」一致性测试（引擎正确性强验证）；
 * - `volume-breakout` 为展示策略（放量突破）。
 */
export interface DslBuiltin {
  key: string
  name: string
  description: string
  source: string
}

const MA_CROSS = `dsl: 1
name: 均线金叉死叉
description: MA 快线上穿慢线做多信号；下穿做空信号（与回测模板 ma-cross 同口径）
timeframes: [1d]
inputs:
  fast: 5
  slow: 20
signals:
  - when: "cross_up(ma(close, inputs.fast), ma(close, inputs.slow))"
    emit:
      direction: long
      confidence: 0.5
      horizon: swing
      rationale_hint: 均线金叉
      entry: "close"
      stop_loss: "close - 2 * atr(14)"
      take_profit: ["close + 3 * atr(14)"]
  - when: "cross_down(ma(close, inputs.fast), ma(close, inputs.slow))"
    emit:
      direction: short
      confidence: 0.5
      horizon: swing
      rationale_hint: 均线死叉
      entry: "close"
      stop_loss: "close + 2 * atr(14)"
      take_profit: ["close - 3 * atr(14)"]
`

const BOLL_BREAKOUT = `dsl: 1
name: 布林轨道突破
description: 收盘上穿上轨做多；下穿下轨做空（与回测模板 boll-breakout 同口径）
timeframes: [1d]
inputs:
  period: 20
  mult: 2
signals:
  - when: "cross_up(close, bb_up(inputs.period, inputs.mult))"
    emit:
      direction: long
      confidence: 0.5
      horizon: swing
      rationale_hint: 上穿布林上轨
      entry: "close"
      stop_loss: "bb_mid(inputs.period)"
      take_profit: ["close + 2 * atr(14)"]
  - when: "cross_down(close, bb_low(inputs.period, inputs.mult))"
    emit:
      direction: short
      confidence: 0.5
      horizon: swing
      rationale_hint: 下穿布林下轨
      entry: "close"
      stop_loss: "bb_mid(inputs.period)"
      take_profit: ["close - 2 * atr(14)"]
`

const RSI_REVERSAL = `dsl: 1
name: RSI 超卖超买反转
description: RSI 上穿超卖线做多；下穿超买线做空（与回测模板 rsi-reversal 同口径）
timeframes: [1d]
inputs:
  period: 14
  oversold: 30
  overbought: 70
signals:
  - when: "ref(rsi(inputs.period), 1) <= inputs.oversold and rsi(inputs.period) > inputs.oversold"
    emit:
      direction: long
      confidence: 0.5
      horizon: short
      rationale_hint: RSI 超卖修复
      entry: "close"
      stop_loss: "close - 2 * atr(14)"
      take_profit: ["close + 2 * atr(14)"]
  - when: "ref(rsi(inputs.period), 1) >= inputs.overbought and rsi(inputs.period) < inputs.overbought"
    emit:
      direction: short
      confidence: 0.5
      horizon: short
      rationale_hint: RSI 超买回落
      entry: "close"
      stop_loss: "close + 2 * atr(14)"
      take_profit: ["close - 2 * atr(14)"]
`

const VOLUME_BREAKOUT = `dsl: 1
name: 放量突破 60 日高点
description: 收盘突破前 60 根最高价且 5 日均量放大 1.5 倍（展示策略）
timeframes: [1d]
inputs:
  window: 60
  volRatio: 1.5
signals:
  - when: "close > ref(hhv(high, inputs.window), 1) and vol_ma(5) > inputs.volRatio * vol_ma(60)"
    emit:
      direction: long
      confidence: 0.6
      horizon: swing
      rationale_hint: 放量突破区间高点
      entry: "close"
      stop_loss: "close - 2 * atr(14)"
      take_profit: ["close + 3 * atr(14)", "hhv(high, 120)"]
drawings:
  - kind: hline
    at: "ref(hhv(high, inputs.window), 1)"
    x: -1
    label: 突破位
    dash: true
`

/** 内置策略清单（顺序稳定；key 作引用名） */
export const DSL_BUILTINS: DslBuiltin[] = [
  { key: 'ma-cross', name: '均线金叉死叉', description: 'MA 快慢线交叉（与回测模板同口径）', source: MA_CROSS },
  { key: 'boll-breakout', name: '布林轨道突破', description: '收盘穿越布林上下轨（与回测模板同口径）', source: BOLL_BREAKOUT },
  { key: 'rsi-reversal', name: 'RSI 超卖超买反转', description: 'RSI 穿越 30/70（与回测模板同口径）', source: RSI_REVERSAL },
  { key: 'volume-breakout', name: '放量突破 60 日高点', description: '突破 + 量能确认（展示策略）', source: VOLUME_BREAKOUT },
]

/** 按 key 取内置策略 */
export function builtinOf(key: string): DslBuiltin | undefined {
  return DSL_BUILTINS.find((b) => b.key === key)
}
