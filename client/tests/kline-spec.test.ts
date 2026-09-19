/**
 * kline-spec 解析器（M34 §5.2，批 C1）：```kline 块 → KlineSpec 纯函数。
 * 契约：src / data 至少一项；bars 归一升序 + volume 缺省 0；indicators 大小写归一去重（缺省 MA+VOL）；
 * annotations ≤20；src 拒绝绝对路径与 `..`；错误信息面向用户（中文）。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KLINE_INDICATORS,
  KLINE_ADJUST_LABELS,
  KLINE_PERIOD_LABELS,
  KLINE_PERIODS,
  klineDefaultTitle,
  parseKlineSpec,
} from '../src/lib/kline-spec'

const bar = (over: Record<string, unknown> = {}) => ({
  timestamp: 1757952000000,
  open: 1450,
  high: 1468,
  low: 1442,
  close: 1461,
  volume: 2834500,
  ...over,
})

describe('parseKlineSpec：src / data 通道', () => {
  it('最小 src 引用：指标缺省 MA+VOL，annotations 空数组', () => {
    const r = parseKlineSpec('{"src":"charts/sh600519-day-202609181030.json"}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.src).toBe('charts/sh600519-day-202609181030.json')
    expect(r.spec.data).toBeUndefined()
    expect(r.spec.indicators).toEqual([...DEFAULT_KLINE_INDICATORS])
    expect(r.spec.annotations).toEqual([])
  })

  it('完整字段：indicators / annotations / title 全透传', () => {
    const r = parseKlineSpec(
      JSON.stringify({
        src: 'charts/sh600519-day-202609181030.json',
        indicators: ['MA', 'VOL', 'MACD'],
        annotations: [{ type: 'priceLine', price: 1500, label: '压力位' }],
        title: '贵州茅台 日K（前复权）',
      }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.indicators).toEqual(['MA', 'VOL', 'MACD'])
    expect(r.spec.annotations).toEqual([{ type: 'priceLine', price: 1500, label: '压力位' }])
    expect(r.spec.title).toBe('贵州茅台 日K（前复权）')
  })

  it('内联 data 数据集：元信息透传，volume 缺省 0，turnover 可选保留', () => {
    const r = parseKlineSpec(
      JSON.stringify({
        data: {
          kind: 'kline',
          symbol: 'sh600519',
          name: '贵州茅台',
          period: 'day',
          adjust: 'qfq',
          bars: [bar({ timestamp: 2 }), bar({ timestamp: 1, volume: undefined, turnover: 4.13e9 })],
        },
      }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const d = r.spec.data
    expect(d?.symbol).toBe('sh600519')
    expect(d?.period).toBe('day')
    expect(d?.adjust).toBe('qfq')
    // 乱序输入归一为升序
    expect(d?.bars.map((b) => b.timestamp)).toEqual([1, 2])
    expect(d?.bars[0].volume).toBe(0)
    expect(d?.bars[0].turnover).toBe(4.13e9)
  })

  it('data 数组简写 + 数字字符串容错', () => {
    const r = parseKlineSpec(JSON.stringify({ data: [bar({ close: '1461.5', volume: '100' })] }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.data?.bars[0].close).toBe(1461.5)
    expect(r.spec.data?.bars[0].volume).toBe(100)
  })

  it('data 为空 bars 数组 → 报错', () => {
    const r = parseKlineSpec('{"data":[]}')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('data 为空')
  })

  it('data.bars 非数组 / 条目缺字段 → 指出下标字段', () => {
    const bad = parseKlineSpec('{"data":{"bars":42}}')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('data.bars 必须是数组')

    const missing = parseKlineSpec(JSON.stringify({ data: [bar({ close: undefined })] }))
    expect(missing.ok).toBe(false)
    if (!missing.ok) {
      expect(missing.error).toContain('data[0]')
      expect(missing.error).toContain('close')
    }
  })
})

describe('parseKlineSpec：护栏与错误信息', () => {
  it('缺 src 与 data → 明确报缺', () => {
    const r = parseKlineSpec('{"indicators":["MA"]}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('缺少 src（快照路径）或 data（内联数据）')
  })

  it('JSON 语法错误 / 顶层非对象 → 中文错误', () => {
    const syntax = parseKlineSpec('{oops}')
    expect(syntax.ok).toBe(false)
    if (!syntax.ok) expect(syntax.error).toContain('JSON 解析失败')

    const arr = parseKlineSpec('[1,2]')
    expect(arr.ok).toBe(false)
    if (!arr.ok) expect(arr.error).toContain('顶层结构必须是 JSON 对象')
  })

  it('src 拒绝绝对路径与 .. 上跳', () => {
    for (const src of ['/etc/passwd', '../outside.json', 'charts/../../x.json', 'C:/x.json']) {
      const r = parseKlineSpec(JSON.stringify({ src }))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('会话工作区相对路径')
    }
  })

  it('indicators：未知名报错；大小写归一 + 去重；空数组回退缺省', () => {
    const bad = parseKlineSpec('{"src":"charts/a.json","indicators":["BOLL2"]}')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('不支持的指标 "BOLL2"')

    const norm = parseKlineSpec('{"src":"charts/a.json","indicators":["ma","MA","vol"]}')
    expect(norm.ok).toBe(true)
    if (norm.ok) expect(norm.spec.indicators).toEqual(['MA', 'VOL'])

    const empty = parseKlineSpec('{"src":"charts/a.json","indicators":[]}')
    expect(empty.ok).toBe(true)
    if (empty.ok) expect(empty.spec.indicators).toEqual(['MA', 'VOL'])
  })

  it('annotations：超 20 条 / 缺 type / price 非数字 → 报错', () => {
    const many = parseKlineSpec(
      JSON.stringify({ src: 'charts/a.json', annotations: Array.from({ length: 21 }, () => ({ type: 'priceLine' })) }),
    )
    expect(many.ok).toBe(false)
    if (!many.ok) expect(many.error).toContain('最多 20 条')

    const noType = parseKlineSpec('{"src":"charts/a.json","annotations":[{"price":1500}]}')
    expect(noType.ok).toBe(false)
    if (!noType.ok) expect(noType.error).toContain('annotations[0].type 必填')

    const badPrice = parseKlineSpec('{"src":"charts/a.json","annotations":[{"type":"priceLine","price":"abc"}]}')
    expect(badPrice.ok).toBe(false)
    if (!badPrice.ok) expect(badPrice.error).toContain('annotations[0].price 必须是数字')
  })
})

describe('kline-spec：标签与标题', () => {
  it('周期与复权标签覆盖 server 口径', () => {
    expect(KLINE_PERIODS).toEqual(['day', 'week', 'month', 'min5', 'min15', 'min30', 'min60'])
    for (const p of KLINE_PERIODS) expect(KLINE_PERIOD_LABELS[p]).toBeTruthy()
    expect(KLINE_ADJUST_LABELS).toMatchObject({ qfq: '前复权', hfq: '后复权', none: '不复权' })
  })

  it('klineDefaultTitle：完整元信息组合，缺项降级', () => {
    const full = klineDefaultTitle({ name: '贵州茅台', symbol: 'sh600519', period: 'day', adjust: 'qfq', bars: [] })
    expect(full).toBe('贵州茅台 日K（前复权）')

    const onlySymbol = klineDefaultTitle({ symbol: 'sh600519', bars: [] })
    expect(onlySymbol).toBe('sh600519')

    const min = klineDefaultTitle({ symbol: 'sh600519', period: 'min5', bars: [] })
    expect(min).toBe('sh600519 5分')

    expect(klineDefaultTitle(undefined)).toBe('K 线')
  })
})
