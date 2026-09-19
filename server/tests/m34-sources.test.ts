/**
 * M34 源适配器测试：fixture 回放（解析纯函数 + 注入 Fetcher 的取数流程），不打真实网络。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { chunk, num, parseJsonLoose } from '../src/finance/fetcher.js'
import { parseSymbol, type FinSymbol } from '../src/finance/symbol.js'
import * as eastmoney from '../src/finance/sources/eastmoney.js'
import * as tencent from '../src/finance/sources/tencent.js'
import * as sina from '../src/finance/sources/sina.js'
import {
  computeNavReturns,
  parseFundArchive,
  parseFundDividends,
  parseFundHoldings,
  parseLsJzPayload,
  parsePingzhongdata,
} from '../src/finance/sources/fund.js'
import { dedupeNews, parseNoticePayload, parseSinaRollPayload } from '../src/finance/sources/news.js'
import type { Fetcher } from '../src/finance/fetcher.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'finance')

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8')
}

/** fixture 回放 Fetcher：按 URL 片段匹配返回样例响应，并记录请求 URL */
function replayFetcher(map: Record<string, string>): { fetcher: Fetcher; urls: string[] } {
  const urls: string[] = []
  const fetcher: Fetcher = async (req) => {
    urls.push(req.url)
    for (const [key, text] of Object.entries(map)) {
      if (req.url.includes(key)) {
        return {
          status: 200,
          ok: true,
          statusText: 'OK',
          finalUrl: req.url,
          headers: new Headers(),
          text,
          setCookies: [],
        }
      }
    }
    throw new Error(`无匹配 fixture：${req.url}`)
  }
  return { fetcher, urls }
}

function sym(code: string): FinSymbol {
  const r = parseSymbol(code)
  if (!r.ok) throw new Error(r.error)
  return r.symbol
}

describe('M34 fetcher 工具函数', () => {
  it('num：容错解析（千分位 / 百分号 / 空值）', () => {
    expect(num('1,234.5')).toBe(1234.5)
    expect(num('2.35%')).toBe(2.35)
    expect(num('')).toBeUndefined()
    expect(num('-')).toBeUndefined()
    expect(num(NaN)).toBeUndefined()
    expect(num(0)).toBe(0)
  })

  it('parseJsonLoose：JSONP 包裹与非 JSON 报错', () => {
    expect(parseJsonLoose<{ a: number }>('cb({"a":1});')).toEqual({ a: 1 })
    expect(parseJsonLoose<{ a: number }>('{"a":1}')).toEqual({ a: 1 })
    expect(() => parseJsonLoose('not json')).toThrow('不是合法 JSON')
  })

  it('chunk：分片', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })
})

describe('M34 东财源适配器', () => {
  it('parseQuotePayload：快照字段映射（价/涨跌/市值/PE/PB）', () => {
    const quotes = eastmoney.parseQuotePayload(fixture('eastmoney-quote.json'))
    expect(quotes).toHaveLength(2)
    const [mt, etf] = quotes
    expect(mt).toMatchObject({
      symbol: 'sh600519',
      code: '600519',
      name: '贵州茅台',
      price: 1461,
      prevClose: 1441,
      changePct: 1.39,
      volume: 28345,
      source: 'eastmoney',
    })
    expect(mt.marketCap).toBe(1.836e12)
    expect(mt.pe).toBeCloseTo(30.12, 2)
    expect(etf).toMatchObject({ symbol: 'sz159915', name: '创业板ETF', price: 2.345 })
  })

  it('fetchQuotes：URL 构造与分片（>50 拆两请求）', async () => {
    const { fetcher, urls } = replayFetcher({ 'ulist.np': fixture('eastmoney-quote.json') })
    const symbols = Array.from({ length: 60 }, (_, i) => sym(String(600000 + i)))
    const quotes = await eastmoney.fetchQuotes(symbols, { fetcher })
    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain('secids=1.600000')
    expect(urls[0]).toContain('fltt=2')
    expect(quotes).toHaveLength(4) // 两个 fixture 响应各 2 行
  })

  it('parseKlinePayload：列序（开/收/高/低/量/额）与时间戳', () => {
    const { name, bars } = eastmoney.parseKlinePayload(fixture('eastmoney-kline.json'))
    expect(name).toBe('贵州茅台')
    expect(bars).toHaveLength(5)
    const last = bars[4]
    expect(last.open).toBe(1450)
    expect(last.close).toBe(1461)
    expect(last.high).toBe(1468)
    expect(last.low).toBe(1442)
    expect(last.volume).toBe(28345)
    expect(last.turnover).toBeCloseTo(4.136e9, 0)
    // 2026-09-17 00:00 北京时间 = UTC 前一天 16:00
    expect(new Date(last.timestamp).toISOString()).toBe('2026-09-16T16:00:00.000Z')
  })

  it('fetchKline：klt/fqt/lmt 参数（周线 + 后复权）', async () => {
    const { fetcher, urls } = replayFetcher({ 'kline/get': fixture('eastmoney-kline.json') })
    const series = await eastmoney.fetchKline(sym('600519'), 'week', 'hfq', 120, { fetcher })
    expect(urls[0]).toContain('klt=102')
    expect(urls[0]).toContain('fqt=2')
    expect(urls[0]).toContain('lmt=120')
    expect(series).toMatchObject({ period: 'week', adjust: 'hfq', symbol: 'sh600519', source: 'eastmoney' })
  })

  it('parseKlinePayload：接口变更（缺 klines）→ 明确报错', () => {
    expect(() => eastmoney.parseKlinePayload('{"rc":0,"data":{}}')).toThrow('缺少 data.klines')
  })

  it('parseClistPayload：全市场列表（含北交所纠正）', () => {
    const rows = eastmoney.parseClistPayload(fixture('eastmoney-clist.json'))
    expect(rows).toHaveLength(4)
    expect(rows.find((r) => r.code === '430047')).toMatchObject({ type: 'stock', exchange: 'bj' })
    expect(rows.find((r) => r.code === '159915')).toMatchObject({ type: 'etf', exchange: 'sz' })
  })

  it('parseSuggestPayload：类型映射 + 排除港股', () => {
    const rows = eastmoney.parseSuggestPayload(fixture('eastmoney-suggest.json'))
    expect(rows.map((r) => r.code)).toEqual(['600519', '159915', '000001', '399006'])
    expect(rows[1]).toMatchObject({ type: 'etf', exchange: 'sz' })
    expect(rows[3]).toMatchObject({ type: 'index', exchange: 'sz' })
  })

  it('searchSymbols：limit → count 参数（clamp 1..20）', async () => {
    const { fetcher, urls } = replayFetcher({ 'suggest/get': fixture('eastmoney-suggest.json') })
    await eastmoney.searchSymbols('600519', { fetcher }, 5)
    expect(urls[0]).toContain('count=5')
    await eastmoney.searchSymbols('600519', { fetcher }, 99)
    expect(urls[1]).toContain('count=20')
  })

  it('fetchSymbolListSweep：pn 分页 + 游标续拉（budget 截断；股票 650 行 / ETF 150 行）', async () => {
    const urls: string[] = []
    const paged: Fetcher = async (req) => {
      urls.push(req.url)
      const u = new URL(req.url)
      const pn = Number(u.searchParams.get('pn'))
      const isEtf = (u.searchParams.get('fs') ?? '').includes('MK00')
      const total = isEtf ? 150 : 650
      const prefix = isEtf ? 510000 : 600000
      const rows: Array<Record<string, unknown>> = []
      for (let i = (pn - 1) * 100; i < Math.min(pn * 100, total); i++) {
        rows.push({ f12: String(prefix + i), f13: 1, f14: `标的${i}` })
      }
      return {
        status: 200,
        ok: true,
        statusText: 'OK',
        finalUrl: req.url,
        headers: new Headers(),
        text: JSON.stringify({ rc: 0, data: { total, diff: rows } }),
        setCookies: [],
      }
    }
    // 第一轮：budget=2 → 股票段前 2 页（200 行），游标指向 pn=3
    const first = await eastmoney.fetchSymbolListSweep(undefined, 2, { fetcher: paged })
    expect(first.pagesFetched).toBe(2)
    expect(first.done).toBe(false)
    expect(first.rows).toHaveLength(200)
    expect(first.next).toEqual({ seg: 0, page: 3 })
    // 第二轮：从游标续拉（股票剩余 5 页 + ETF 2 页）→ 完成（共 600 行）
    const second = await eastmoney.fetchSymbolListSweep(first.next, 10, { fetcher: paged })
    expect(second.done).toBe(true)
    expect(second.rows).toHaveLength(600)
    expect(urls[0]).toContain('pn=1')
    expect(urls[0]).toContain('pz=100')
    expect(urls[0]).toContain('ut=bd1d9ddb04089700cf9c27f6f7426281')
    expect(urls[2]).toContain('pn=3')
    // ETF 段首次请求（第一轮 2 页后为 urls[2..6]，ETF 起始于 urls[7]）
    expect(urls[7]).toContain('MK00')
  })
})

describe('M34 腾讯 / 新浪源适配器', () => {
  it('parseTencentPayload：~ 分隔字段映射（GBK 内容由 antiBotFetch 解码后传入）', () => {
    const quotes = tencent.parseTencentPayload(fixture('tencent-quote.txt'))
    expect(quotes).toHaveLength(2)
    const [mt] = quotes
    expect(mt).toMatchObject({
      symbol: 'sh600519',
      name: '贵州茅台',
      price: 1461,
      prevClose: 1441,
      changePct: 1.39,
      volume: 28345,
      source: 'tencent',
    })
    expect(mt.turnover).toBe(4_136_000_000)
    expect(mt.marketCap).toBeCloseTo(1.83602e12, 0)
    expect(mt.asOf.startsWith('2026-09-17')).toBe(true)
    const etf = quotes[1]
    expect(etf).toMatchObject({ symbol: 'sz159915', name: '创业板ETF' })
    expect(etf.changePct).toBeCloseTo(-0.85, 2)
  })

  it('fetchQuotes：拼装 list 参数', async () => {
    const { fetcher, urls } = replayFetcher({ 'qt.gtimg.cn': fixture('tencent-quote.txt') })
    const quotes = await tencent.fetchQuotes([sym('600519'), sym('159915')], { fetcher })
    expect(urls[0]).toBe('https://qt.gtimg.cn/q=sh600519,sz159915')
    expect(quotes).toHaveLength(2)
  })

  it('parseSinaPayload：逗号分隔字段（股→手 折算）', () => {
    const quotes = sina.parseSinaPayload(fixture('sina-quote.txt'))
    expect(quotes).toHaveLength(1)
    expect(quotes[0]).toMatchObject({
      symbol: 'sh600519',
      name: '贵州茅台',
      price: 1461,
      prevClose: 1441,
      volume: 28345,
      source: 'sina',
    })
    expect(quotes[0].turnover).toBe(4_136_000_000)
    expect(quotes[0].asOf.startsWith('2026-09-17')).toBe(true)
  })
})

describe('M34 天天基金源适配器', () => {
  it('parseLsJzPayload：净值字段与时间升序', () => {
    const points = parseLsJzPayload(fixture('fund-lsjz.json'))
    expect(points).toHaveLength(4)
    expect(points[0].timestamp).toBeLessThan(points[3].timestamp)
    expect(points[3]).toMatchObject({ nav: 1.234, cumNav: 3.456, changePct: 0.32 })
  })

  it('parseLsJzPayload：坏响应报错', () => {
    expect(() => parseLsJzPayload('{"Data":{}}')).toThrow('响应异常')
  })

  it('parsePingzhongdata：名称 / 费率 / 规模 / 净值走势提取', () => {
    const info = parsePingzhongdata(fixture('fund-pingzhongdata.js'))
    expect(info.name).toBe('华夏成长混合')
    expect(info.feeRate).toBe(1.5)
    expect(info.scale).toBe(39.38)
    expect(info.navTrend).toHaveLength(4)
    // 无规模序列（旧数据 / 货币基金）→ 缺省不报错
    const noScale = parsePingzhongdata('var fS_name = "测试基金"; var Data_netWorthTrend = [{"x":1757952000000,"y":1.2}];')
    expect(noScale.scale).toBeUndefined()
    expect(noScale.name).toBe('测试基金')
  })

  it('parseFundArchive：跟踪标的（无则缺省）/ 净资产规模 / 管理费率', () => {
    const info = parseFundArchive(fixture('fund-jbgk.html'))
    expect(info.scale).toBe(39.38)
    expect(info.feeRate).toBe(1.2)
    expect(info.trackingIndex).toBeUndefined() // 000001 为「该基金无跟踪标的」
    const etf = parseFundArchive(
      '<tr><th>业绩比较基准</th><td>沪深300指数</td><th>跟踪标的</th><td>沪深300指数</td></tr>',
    )
    expect(etf.trackingIndex).toBe('沪深300指数')
  })

  it('parseFundHoldings：取最新一期表格（10 行）+ 代码/名称/权重', () => {
    const rows = parseFundHoldings(fixture('fund-jjcc.html'))
    expect(rows).toHaveLength(10)
    expect(rows[0]).toMatchObject({ code: '300308', name: '中际旭创', weightPct: 6.45 })
    expect(rows[4]).toMatchObject({ code: '600519', name: '贵州茅台' })
    // 第二期（上期）表格不混入
    expect(rows.some((row) => row.code === '601899')).toBe(false)
  })

  it('parseFundDividends：每10份派现金折算每份 + 跳过无分红表格', () => {
    const rows = parseFundDividends(fixture('fund-fhsp.html'))
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ date: '2025-09-22', amount: 0.01 })
    expect(rows[2].amount).toBeCloseTo(0.23, 4)
  })

  it('computeNavReturns：阶段收益计算', () => {
    const points = Array.from({ length: 30 }, (_, i) => ({
      timestamp: Date.parse('2026-08-01T00:00:00Z') + i * 86_400_000,
      nav: 1 + i * 0.001,
    }))
    const returns = computeNavReturns(points)
    // 最新 1.029 vs 21 个交易日前 1.008 → +2.08%
    expect(returns.m1).toBeCloseTo(2.08, 1)
    expect(returns.m3).toBeUndefined() // 数据不足 63 期
  })
})

describe('M34 新闻源适配器', () => {
  it('parseNoticePayload：公告（official 等级 + URL 构造）', () => {
    const items = parseNoticePayload(fixture('notice.json'))
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ tier: 'official', symbol: '600519', source: '东方财富·公告' })
    expect(items[0].url).toContain('AN202609170001')
  })

  it('parseSinaRollPayload：滚动新闻（media 等级）', () => {
    const items = parseSinaRollPayload(fixture('sina-roll.json'))
    expect(items).toHaveLength(3)
    expect(items[0].tier).toBe('media')
    expect(items[0].source).toBe('新浪财经')
  })

  it('dedupeNews：URL 去重 + 时间倒序', () => {
    const items = [
      { title: 'A', url: 'https://x/1', source: 's', publishedAt: '2026-09-17 10:00:00' },
      { title: 'A2', url: 'https://x/1', source: 's', publishedAt: '2026-09-17 09:00:00' },
      { title: 'B', url: 'https://x/2', source: 's', publishedAt: '2026-09-18 09:00:00' },
    ]
    const out = dedupeNews(items)
    expect(out).toHaveLength(2)
    expect(out[0].title).toBe('B')
  })
})
