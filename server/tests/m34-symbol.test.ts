/**
 * M34 金融符号归一化测试：多形态输入 / 消歧优先级 / secid 映射 / 错误路径。
 */
import { describe, expect, it } from 'vitest'
import {
  buildFinSymbol,
  formatSymbol,
  fromSecid,
  inferAssetType,
  inferExchange,
  parseSymbol,
  toSecid,
  type SymbolMaster,
} from '../src/finance/symbol.js'

/** 模拟主数据（在线缓存的替身）：覆盖与内置表冲突的消歧入口 */
const master: SymbolMaster = {
  byCode(code, type) {
    const rows = [
      { code: '600519', name: '贵州茅台', type: 'stock' as const, exchange: 'sh' as const },
      { code: '000001', name: '平安银行', type: 'stock' as const, exchange: 'sz' as const },
      { code: '000001', name: '华夏成长混合', type: 'fund' as const },
      { code: '159915', name: '创业板ETF', type: 'etf' as const, exchange: 'sz' as const },
    ]
    const hit = rows.filter((r) => r.code === code && (!type || r.type === type))
    if (hit.length === 1) return hit[0]
    // 接口约定：无 type 且多品种时场内（非 fund）优先
    return hit.find((r) => r.type !== 'fund')
  },
  search(query, limit = 8) {
    const rows = [
      { code: '600519', name: '贵州茅台', type: 'stock' as const, exchange: 'sh' as const },
      { code: '600809', name: '山西汾酒', type: 'stock' as const, exchange: 'sh' as const },
      { code: '000858', name: '五粮液', type: 'stock' as const, exchange: 'sz' as const },
    ]
    return rows.filter((r) => r.name.includes(query)).slice(0, limit)
  },
}

describe('M34 符号前缀推断', () => {
  it('inferAssetType：板块与品种判定', () => {
    expect(inferAssetType('600519')).toBe('stock')
    expect(inferAssetType('688981')).toBe('stock')
    expect(inferAssetType('300750')).toBe('stock')
    expect(inferAssetType('430047')).toBe('stock')
    expect(inferAssetType('510300')).toBe('etf')
    expect(inferAssetType('588000')).toBe('etf')
    expect(inferAssetType('159915')).toBe('etf')
    expect(inferAssetType('399006')).toBe('index')
    expect(inferAssetType('12345')).toBeUndefined()
  })

  it('inferExchange：场内/场外与北交所', () => {
    expect(inferExchange('600519', 'stock')).toBe('sh')
    expect(inferExchange('000001', 'stock')).toBe('sz')
    expect(inferExchange('430047', 'stock')).toBe('bj')
    expect(inferExchange('399006', 'index')).toBe('sz')
    expect(inferExchange('000300', 'index')).toBe('sh')
    expect(inferExchange('000001', 'fund')).toBeUndefined()
  })

  it('toSecid / fromSecid：沪 1 深北 0', () => {
    expect(toSecid('sh', '600519')).toBe('1.600519')
    expect(toSecid('sz', '000001')).toBe('0.000001')
    expect(toSecid('bj', '430047')).toBe('0.430047')
    expect(toSecid(undefined, '000001')).toBeUndefined()
    expect(fromSecid('1.600519')).toEqual({ exchange: 'sh', code: '600519' })
    expect(fromSecid('0.430047')).toEqual({ exchange: 'sz', code: '430047' })
    expect(fromSecid('2.600519')).toBeUndefined()
  })
})

describe('M34 parseSymbol：输入形态', () => {
  it('纯代码：前缀推断 + secid 派生', () => {
    const r = parseSymbol('600519')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.symbol).toMatchObject({ type: 'stock', exchange: 'sh', symbol: 'sh600519', secid: '1.600519' })
    }
  })

  it('交易所前缀 / 后缀 / secid 三形态等价', () => {
    for (const input of ['sh600519', 'SH600519', '600519.SH', '1.600519']) {
      const r = parseSymbol(input)
      expect(r.ok, input).toBe(true)
      if (r.ok) expect(r.symbol.symbol, input).toBe('sh600519')
    }
    const ss = parseSymbol('600519.SS')
    expect(ss.ok && ss.symbol.exchange).toBe('sh')
  })

  it('深 ETF：159915 前缀推断', () => {
    const r = parseSymbol('159915')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.symbol).toMatchObject({ type: 'etf', exchange: 'sz', secid: '0.159915' })
  })

  it('北交所：43/83/87 段（exp 0.xxxxxx 段纠正）', () => {
    const prefixed = parseSymbol('bj430047')
    expect(prefixed.ok && prefixed.symbol.exchange).toBe('bj')
    const secid = parseSymbol('0.430047')
    expect(secid.ok && secid.symbol.exchange).toBe('bj')
  })

  it('显式 type=index：沪指数 000300 / 深指数 399006', () => {
    const hs300 = parseSymbol('000300', { type: 'index' })
    expect(hs300.ok).toBe(true)
    if (hs300.ok) expect(hs300.symbol).toMatchObject({ type: 'index', exchange: 'sh', name: '沪深300' })
    const cyb = parseSymbol('399006', { type: 'index' })
    expect(cyb.ok && cyb.symbol.exchange).toBe('sz')
  })

  it('显式 type=fund：场外基金（无交易所、纯代码展示）', () => {
    const r = parseSymbol('000001', { type: 'fund' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.symbol).toMatchObject({ type: 'fund', symbol: '000001' })
    expect(r.ok && r.symbol.exchange).toBeUndefined()
    expect(r.ok && r.symbol.secid).toBeUndefined()
  })

  it('内置指数名称兜底（离线可用）', () => {
    expect(parseSymbol('上证指数')).toMatchObject({ ok: true })
    const r = parseSymbol('上证指数')
    if (r.ok) expect(r.symbol).toMatchObject({ type: 'index', code: '000001', exchange: 'sh' })
    const cyb = parseSymbol('创业板指')
    if (cyb.ok) expect(cyb.symbol.code).toBe('399006')
  })
})

describe('M34 parseSymbol：消歧与主数据', () => {
  it('主数据优先：000001 → 平安银行（sz stock）', () => {
    const r = parseSymbol('000001', { master })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.symbol).toMatchObject({ name: '平安银行', type: 'stock', exchange: 'sz' })
  })

  it('type 过滤主数据：000001 + type=fund → 场外基金', () => {
    const r = parseSymbol('000001', { type: 'fund', master })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.symbol.name).toBe('华夏成长混合')
  })

  it('名称唯一命中直接返回；多命中给候选错误', () => {
    const single = parseSymbol('茅台', { master })
    expect(single.ok).toBe(true)
    if (single.ok) expect(single.symbol.code).toBe('600519')

    const many: SymbolMaster = {
      byCode: () => undefined,
      search: () => [
        { code: '600000', name: '甲公司', type: 'stock', exchange: 'sh' },
        { code: '600001', name: '甲公司B', type: 'stock', exchange: 'sh' },
      ],
    }
    const multi = parseSymbol('甲', { master: many })
    expect(multi.ok).toBe(false)
    if (!multi.ok) expect(multi.error).toContain('命中多个标的')
  })

  it('无主数据且歧义段无前缀：给明确引导错误', () => {
    const r = parseSymbol('123456')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('无法确定品种')
    expect(parseSymbol('')).toMatchObject({ ok: false })
    expect(parseSymbol('不存在的公司')).toMatchObject({ ok: false })
  })

  it('formatSymbol：场外基金纯代码 / 场内带前缀', () => {
    expect(formatSymbol({ type: 'fund', code: '000001' })).toBe('000001')
    expect(formatSymbol({ type: 'stock', code: '600519', exchange: 'sh' })).toBe('sh600519')
    expect(formatSymbol({ type: 'etf', code: '159915', exchange: 'sz' })).toBe('sz159915')
  })

  it('buildFinSymbol：name 覆盖与 secid 派生一致', () => {
    const built = buildFinSymbol({ code: '600519', name: '贵州茅台', type: 'stock', exchange: 'sh' })
    expect(built).toMatchObject({ symbol: 'sh600519', secid: '1.600519', name: '贵州茅台' })
    const renamed = buildFinSymbol({ code: '600519', type: 'stock', exchange: 'sh' }, '茅台')
    expect(renamed.name).toBe('茅台')
  })
})
