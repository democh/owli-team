/**
 * M83 批 C：kline-spec 扩展解析测试。
 * - 旧块零改动兼容（新字段全部可选、缺省 drawings=[] / signal=null / warnings=[]）；
 * - 主/副图枚举显式报错（模型自纠通道）；showPhases 类型不符降级；
 * - 增强字段（drawings / signal / analysis）降级：非法丢弃 + warnings，主图不受影响。
 */
import { describe, expect, it } from 'vitest'
import { deriveMainIndicator, deriveSubIndicator, parseKlineSpec } from '../src/lib/kline-spec'

const BARS = [
  { timestamp: 1757952000000, open: 1450, high: 1468, low: 1442, close: 1461, volume: 28300 },
  { timestamp: 1758038400000, open: 1461, high: 1475, low: 1450, close: 1456, volume: 22100 },
]

const ANALYSIS = {
  asOf: '2026-09-25T00:00:00.000Z',
  bars: 2,
  period: 'day',
  adjust: 'qfq',
  phases: {
    current: 'accumulation',
    confidence: 62,
    since: '2026-09-01',
    description: '低位缩量横盘、筹码集中',
    bands: [
      { ts: 1757952000000, phase: 'accumulation' },
      { ts: 1758038400000, phase: 'range' },
    ],
  },
  sentiment: { score: 42, stage: 'hesitate', pathLabel: '恐慌→犹豫→修复→乐观→狂热（当前：犹豫）' },
  levels: {
    support: { price: 1442, basis: '前低', touches: 2 },
    resistance: null,
    target: { price: 1520, basis: '前高延伸' },
  },
  features: [{ key: 'platform', label: '平台整理', confirmed: true }],
  drawings: [{ id: 'an-support', kind: 'hline', points: [{ ts: 1758038400000, price: 1442 }], label: '支撑 1442' }],
  notes: ['阶段判定为规则化统计口径，仅供复盘研究'],
}

const SIGNAL = {
  symbol: 'sh600519',
  period: 'day',
  ts: 1758038400000,
  direction: 'long',
  confidence: 0.6,
  horizon: 'swing',
  entry: 1456,
  stopLoss: 1430,
  takeProfit: [1500],
  riskReward: 1.69,
  rationale: '条件触发',
  groupId: 'strategy:演示',
}

describe('M83 kline-spec：旧块兼容', () => {
  it('仅 src + indicators：新字段缺省（drawings=[] / signal=null / warnings=[]）', () => {
    const r = parseKlineSpec(JSON.stringify({ src: 'charts/x.json', indicators: ['MA', 'VOL'] }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.mainIndicator).toBeUndefined()
    expect(r.spec.subIndicator).toBeUndefined()
    expect(r.spec.showPhases).toBeUndefined()
    expect(r.spec.drawings).toEqual([])
    expect(r.spec.signal).toBeNull()
    expect(r.spec.analysis).toBeUndefined()
    expect(r.spec.warnings).toEqual([])
  })
})

describe('M83 kline-spec：新字段解析', () => {
  it('主/副图枚举（大小写归一）+ showPhases + drawings / signal / analysis', () => {
    const r = parseKlineSpec(
      JSON.stringify({
        data: { bars: BARS },
        indicators: ['MA', 'VOL'],
        mainIndicator: 'kcb',
        subIndicator: 'macd',
        showPhases: true,
        drawings: [{ id: 'an-support', kind: 'hline', points: [{ ts: 1758038400000, price: 1442 }], label: '支撑 1442' }],
        signal: SIGNAL,
        analysis: ANALYSIS,
      }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.mainIndicator).toBe('KCB')
    expect(r.spec.subIndicator).toBe('MACD')
    expect(r.spec.showPhases).toBe(true)
    expect(r.spec.drawings).toHaveLength(1)
    expect(r.spec.drawings[0].kind).toBe('hline')
    expect(r.spec.signal?.direction).toBe('long')
    expect(r.spec.signal?.takeProfit).toEqual([1500])
    expect(r.spec.analysis?.phases.current).toBe('accumulation')
    expect(r.spec.analysis?.phases.bands).toHaveLength(2)
    expect(r.spec.analysis?.levels.support?.price).toBe(1442)
    expect(r.spec.warnings).toEqual([])
  })

  it('render 对象形态（快照 / 块模板统一口径）：主/副图 + showPhases 等价顶层字段；顶层优先', () => {
    const r = parseKlineSpec(
      JSON.stringify({
        src: 'charts/x.json',
        indicators: ['MA', 'VOL'],
        render: { mainIndicator: 'ma', subIndicator: 'vol', showPhases: false },
      }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.mainIndicator).toBe('MA')
    expect(r.spec.subIndicator).toBe('VOL')
    expect(r.spec.showPhases).toBe(false)
    // 顶层字段优先于 render
    const top = parseKlineSpec(JSON.stringify({ src: 'charts/x.json', mainIndicator: 'BOLL', render: { mainIndicator: 'KCB' } }))
    expect(top.ok).toBe(true)
    if (!top.ok) return
    expect(top.spec.mainIndicator).toBe('BOLL')
    // render 内非法枚举同样显式报错
    const bad = parseKlineSpec(JSON.stringify({ src: 'charts/x.json', render: { subIndicator: 'XYZ' } }))
    expect(bad.ok).toBe(false)
  })

  it('主/副图非法枚举 → 显式报错（含可选清单）', () => {
    const main = parseKlineSpec(JSON.stringify({ data: { bars: BARS }, mainIndicator: 'BOLL2' }))
    expect(main.ok).toBe(false)
    if (!main.ok) expect(main.error).toContain('不支持的主图指标 "BOLL2"')

    const sub = parseKlineSpec(JSON.stringify({ data: { bars: BARS }, subIndicator: 'VWAP' }))
    expect(sub.ok).toBe(false)
    if (!sub.ok) expect(sub.error).toContain('不支持的副图指标 "VWAP"')

    // 'none' 合法
    const none = parseKlineSpec(JSON.stringify({ data: { bars: BARS }, mainIndicator: 'none', subIndicator: 'none' }))
    expect(none.ok).toBe(true)
    if (none.ok) {
      expect(none.spec.mainIndicator).toBe('none')
      expect(none.spec.subIndicator).toBe('none')
    }
  })
})

describe('M83 kline-spec：增强字段降级', () => {
  it('showPhases 非布尔 → 忽略 + warning（主图仍可渲染）', () => {
    const r = parseKlineSpec(JSON.stringify({ data: { bars: BARS }, showPhases: 'yes' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.showPhases).toBeUndefined()
    expect(r.spec.warnings.some((w) => w.includes('showPhases'))).toBe(true)
  })

  it('drawings：单条非法只丢该条；kind 白名单外丢弃；数量超限提示', () => {
    const r = parseKlineSpec(
      JSON.stringify({
        data: { bars: BARS },
        drawings: [
          { id: 'ok', kind: 'hline', points: [{ ts: 1758038400000, price: 1442 }] },
          { id: 'bad-kind', kind: 'star', points: [{ ts: 1758038400000, price: 1442 }] },
          { id: 'bad-pt', kind: 'hline', points: [{ ts: 'x', price: 1 }] },
          'not-an-object',
        ],
      }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.drawings.map((d) => d.id)).toEqual(['ok'])
    expect(r.spec.warnings.filter((w) => w.includes('已丢弃')).length).toBe(3)
  })

  it('signal 非法 direction → 忽略为 null + warning', () => {
    const r = parseKlineSpec(JSON.stringify({ data: { bars: BARS }, signal: { direction: 'up', entry: 1 } }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.signal).toBeNull()
    expect(r.spec.warnings.some((w) => w.includes('signal.direction'))).toBe(true)
  })

  it('analysis 脏数据（缺 sentiment）→ 忽略分析 + warning；bars 仍正常', () => {
    const broken = { ...ANALYSIS, sentiment: undefined }
    const r = parseKlineSpec(JSON.stringify({ data: { bars: BARS }, analysis: broken }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.analysis).toBeUndefined()
    expect(r.spec.data?.bars).toHaveLength(2)
    expect(r.spec.warnings.some((w) => w.includes('analysis'))).toBe(true)
  })
})

describe('M83 kline-spec：主/副图缺省推导', () => {
  it('derive：legacy indicators → 主/副图；缺省 MA / VOL', () => {
    expect(deriveMainIndicator(['VOL', 'KCB', 'MA'])).toBe('KCB')
    expect(deriveSubIndicator(['MA', 'RSI'])).toBe('RSI')
    expect(deriveMainIndicator([])).toBe('MA')
    expect(deriveSubIndicator(['MA'])).toBe('VOL')
  })
})
