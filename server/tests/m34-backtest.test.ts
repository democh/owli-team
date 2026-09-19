/**
 * M34 回测引擎测试（backtest.ts）：已知序列的绩效口径精确核对。
 *
 * 覆盖：buy-hold 的净值 / 收益 / 回撤 / 年化手算值；成本（费率 + 滑点）双边扣减公式；
 * ma-cross 信号「第 i 根收盘 → 第 i+1 根开盘成交」；末尾强制平仓；range 过滤；
 * 参数 / 样本校验；5 模板确定性与净值采样（>600 点）。
 * 纯计算零 IO：不打网络、不触 DB。
 */
import { describe, expect, it } from 'vitest'
import {
  BACKTEST_DEFAULT_PARAMS,
  BACKTEST_TEMPLATES,
  BacktestError,
  runBacktest,
  type BacktestTemplate,
} from '../src/finance/backtest.js'
import type { KlineBar } from '../src/finance/types.js'

const DAY = 86_400_000

/** 构造连续自然日 K 线（北京时间 00:00；open 缺省 = close，high/low 包络 open/close） */
function barsOf(closes: number[], opens?: number[]): KlineBar[] {
  const start = Date.parse('2026-08-03T00:00:00+08:00')
  return closes.map((close, i) => {
    const open = opens?.[i] ?? close
    return {
      timestamp: start + i * DAY,
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      volume: 1000 + i * 10,
    }
  })
}

describe('M34 回测：buy-hold 精确口径（零成本手算）', () => {
  // 序列（close）：100 → 100 → 110 → 120 → 90 → 95 → 100 → 105 → 110 → 115
  const closes = [100, 100, 110, 120, 90, 95, 100, 105, 110, 115]

  it('净值 / 总收益 / 基准 / 回撤 / 年化与手算一致', () => {
    const r = runBacktest(barsOf(closes), { template: 'buy-hold' }, { feeRate: 0, slippage: 0 })
    expect(r.bars).toBe(10)
    expect(r.from).toBe('2026-08-03')
    expect(r.to).toBe('2026-08-12')

    // 买入在第 1 根开盘（100）→ 单位 0.01；末尾强制平仓于第 10 根收盘（115）
    expect(r.metrics.totalReturn).toBeCloseTo(0.15, 12)
    expect(r.metrics.benchmarkReturn).toBeCloseTo(0.15, 12) // 首收 → 末收（无成本口径）
    // equity: 1.0 → 1.1 → 1.2 → 0.9 → … → 1.15；峰值 1.2 谷值 0.9 → 回撤 0.25
    expect(r.metrics.maxDrawdown).toBeCloseTo(0.25, 12)
    expect(r.metrics.annualReturn).toBeCloseTo(Math.pow(1.15, 365 / 10) - 1, 10)
    expect(Number.isFinite(r.metrics.sharpe)).toBe(true)
    expect(r.metrics.volatility).toBeGreaterThan(0)
  })

  it('成交明细：单笔、跨根计数、末尾强平标记', () => {
    const r = runBacktest(barsOf(closes), { template: 'buy-hold' }, { feeRate: 0, slippage: 0 })
    expect(r.trades).toHaveLength(1)
    const trade = r.trades[0]
    expect(trade.entryAt).toBe('2026-08-04') // 第 1 根（0 基）→ 次日展示
    expect(trade.exitAt).toBe('2026-08-12')
    expect(trade.entryPrice).toBeCloseTo(100, 10)
    expect(trade.exitPrice).toBeCloseTo(115, 10)
    expect(trade.returnPct).toBeCloseTo(0.15, 12)
    expect(trade.bars).toBe(8) // entryIdx=1 → lastIdx=9
    expect(trade.forced).toBe(true)
    expect(r.metrics.trades).toBe(1)
    expect(r.metrics.winRate).toBe(1)
    expect(r.notes.join('\n')).toContain('强制平仓')
  })

  it('成本口径：平价序列双边扣减 = (1−f)²×(卖出价/买入价) − 1（手算公式）', () => {
    const fee = 1 // 单边 1%
    const slip = 0.5 // 单边 0.5%
    const r = runBacktest(barsOf(Array(10).fill(100)), { template: 'buy-hold' }, { feeRate: fee, slippage: slip })
    // 买入价 100×1.005；卖出价 100×0.995；双边费率各 (1−0.01)
    const expected = ((1 - 0.01) * (1 - 0.01) * (100 * (1 - 0.005))) / (100 * (1 + 0.005)) - 1
    expect(r.metrics.totalReturn).toBeCloseTo(expected, 12)
    expect(r.metrics.benchmarkReturn).toBeCloseTo(0, 12)
    expect(r.trades[0].forced).toBe(true)
  })
})

describe('M34 回测：ma-cross 信号与次根成交', () => {
  // 15 根阴跌 → 尾段拉升 → 再回落：fast=2/slow=3 在 i=6 金叉（买）、i=10 死叉（卖）
  const closes = [100, 99, 98, 97, 96, 98, 101, 104, 107, 103, 99, 95]

  it('第 i 根收盘信号在第 i+1 根开盘成交（避免未来函数）', () => {
    const r = runBacktest(barsOf(closes), { template: 'ma-cross', params: { fast: 2, slow: 3 } }, { feeRate: 0, slippage: 0 })
    expect(r.params).toEqual({ fast: 2, slow: 3 })
    expect(r.trades).toHaveLength(1)
    const trade = r.trades[0]
    expect(trade.entryAt).toBe('2026-08-10') // 金叉 i=6 → 成交 i=7（08-03 + 7 天）
    expect(trade.exitAt).toBe('2026-08-14') // 死叉 i=10 → 成交 i=11
    expect(trade.returnPct).toBeCloseTo(95 / 104 - 1, 10)
    expect(trade.bars).toBe(4)
    expect(trade.forced).toBeUndefined()
    expect(r.metrics.trades).toBe(1)
    expect(r.metrics.winRate).toBe(0)
  })

  it('区间结束仍持仓 → 按最后收盘价强平并注明', () => {
    // 截断到上涨段中途（i=0..9）：金叉 i=6 → 成交 i=7（104），无死叉 → 强平于 i=9（103）
    const r = runBacktest(barsOf(closes.slice(0, 10)), { template: 'ma-cross', params: { fast: 2, slow: 3 } }, { feeRate: 0, slippage: 0 })
    expect(r.trades).toHaveLength(1)
    expect(r.trades[0].forced).toBe(true)
    expect(r.trades[0].exitAt).toBe('2026-08-12')
    expect(r.trades[0].returnPct).toBeCloseTo(103 / 104 - 1, 10)
  })

  it('自定义参数越界 / 顺序错误 → BacktestError', () => {
    const bars = barsOf(closes)
    expect(() => runBacktest(bars, { template: 'ma-cross', params: { fast: 10, slow: 5 } })).toThrow(/fast < slow/)
    expect(() => runBacktest(bars, { template: 'rsi-reversal', params: { oversold: 60 } })).toThrow(BacktestError)
    expect(() => runBacktest(bars, { template: 'rsi-reversal', params: { oversold: 30, period: 0 } })).toThrow(BacktestError)
  })
})

describe('M34 回测：range 过滤 / 样本与参数校验', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i)

  it('range 闭区间过滤（from/to 与根数）', () => {
    const r = runBacktest(barsOf(closes), { template: 'buy-hold' }, { range: { start: '2026-08-05', end: '2026-08-22' } })
    expect(r.from).toBe('2026-08-05')
    expect(r.to).toBe('2026-08-22')
    expect(r.bars).toBe(18)
  })

  it('过滤后样本不足 / 日期格式错误 → BacktestError', () => {
    expect(() => runBacktest(barsOf(closes), { template: 'buy-hold' }, { range: { start: '2026-08-18', end: '2026-08-22' } })).toThrow(/样本不足/)
    expect(() => runBacktest(barsOf(closes), { template: 'buy-hold' }, { range: { start: '2026/08/05' } })).toThrow(/yyyy-MM-dd/)
    expect(() => runBacktest(barsOf(Array(9).fill(100)), { template: 'buy-hold' })).toThrow(/样本不足/)
  })

  it('成本参数 / 模板校验', () => {
    const bars = barsOf(closes)
    expect(() => runBacktest(bars, { template: 'buy-hold' }, { feeRate: 3 })).toThrow(/feeRate/)
    expect(() => runBacktest(bars, { template: 'buy-hold' }, { slippage: -1 })).toThrow(/slippage/)
    expect(() => runBacktest(bars, { template: 'ghost' as BacktestTemplate })).toThrow(/未知策略模板/)
  })
})

describe('M34 回测：模板健壮性 / 确定性 / 净值采样', () => {
  it('5 模板全可运行：确定性输出（同输入逐位一致）+ 口径说明', () => {
    const closes = Array.from({ length: 300 }, (_, i) => 100 + i * 0.1 + 8 * Math.sin(i / 7))
    const bars = barsOf(closes)
    expect(BACKTEST_TEMPLATES).toHaveLength(5)
    for (const template of BACKTEST_TEMPLATES) {
      const a = runBacktest(bars, { template })
      const b = runBacktest(bars, { template })
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
      expect(a.params).toEqual(BACKTEST_DEFAULT_PARAMS[template])
      expect(Number.isFinite(a.metrics.totalReturn)).toBe(true)
      expect(Number.isFinite(a.metrics.maxDrawdown)).toBe(true)
      expect(a.notes.join('\n')).toContain('第 i 根收盘信号')
      expect(a.equity.length).toBeGreaterThan(0)
      expect(a.bars).toBe(300)
    }
  })

  it('净值曲线 >600 点均匀采样：保留首尾', () => {
    const bars = barsOf(Array.from({ length: 700 }, (_, i) => 100 + i))
    const r = runBacktest(bars, { template: 'buy-hold' })
    expect(r.equity).toHaveLength(600)
    expect(r.equity[0].timestamp).toBe(bars[1].timestamp)
    expect(r.equity[599].timestamp).toBe(bars[699].timestamp)
    // 基准 = 第 2 根收盘 / 第 1 根收盘（equity 从 i=1 起）
    expect(r.equity[0].benchmark).toBeCloseTo(bars[1].close / bars[0].close, 12)
  })
})
