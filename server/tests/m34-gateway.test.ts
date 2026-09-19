/**
 * M34 网关测试：路由降级链 / source 层级强制 / 缓存 TTL 与快照 / 源健康度冷却。
 *
 * 依赖注入：fake Fetcher（fixture 回放）+ fake runPy（Python 桥）+ 可控时钟；不打真实网络、不 spawn 进程。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { ageFresh, createFinanceCache, klineFresh } from '../src/finance/cache.js'
import { createFinanceGateway, GatewayError, type PyAvailability } from '../src/finance/gateway.js'
import { buildKlineSnapshot, snapshotFilename, snapshotStamp, writeChartSnapshot } from '../src/finance/snapshot.js'
import { parseSymbol, type FinSymbol } from '../src/finance/symbol.js'
import type { Fetcher } from '../src/finance/fetcher.js'
import { openDatabase, type AppDb } from '../src/store/db.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'finance')

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8')
}

function sym(code: string): FinSymbol {
  const r = parseSymbol(code)
  if (!r.ok) throw new Error(r.error)
  return r.symbol
}

/** 可控时钟（基准：北京时间 2026-09-18 10:00） */
let clock = new Date('2026-09-18T02:00:00.000Z')
function advance(ms: number): void {
  clock = new Date(clock.getTime() + ms)
}

interface Call {
  url: string
}

/** fixture 回放 Fetcher：fail 键命中抛错（模拟源失败）；failAll 动态全失败开关 */
function makeFetcher(opts: { fail?: string[]; failAll?: () => boolean; calls?: Call[] } = {}): Fetcher {
  const map: Record<string, string> = {
    'ulist.np': fixture('eastmoney-quote.json'),
    'kline/get': fixture('eastmoney-kline.json'),
    'clist/get': fixture('eastmoney-clist.json'),
    'suggest/get': fixture('eastmoney-suggest.json'),
    'qt.gtimg.cn': fixture('tencent-quote.txt'),
    'hq.sinajs.cn': fixture('sina-quote.txt'),
    'security/ann': fixture('notice.json'),
    'roll/get': fixture('sina-roll.json'),
    'f10/lsjz': fixture('fund-lsjz.json'),
    pingzhongdata: fixture('fund-pingzhongdata.js'),
    'jbgk_': fixture('fund-jbgk.html'),
    FundArchivesDatas: fixture('fund-jjcc.html'),
    'fhsp_': fixture('fund-fhsp.html'),
  }
  const fail = opts.fail ?? []
  return async (req) => {
    opts.calls?.push({ url: req.url })
    if (opts.failAll?.()) throw new Error('模拟全源失败')
    for (const key of fail) {
      if (req.url.includes(key)) throw new Error(`模拟源失败：${key}`)
    }
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
}

/** py 桥 K 线样例（与 fin_bridge.py 输出同构） */
const PY_BARS = [
  { timestamp: Date.parse('2026-09-16T00:00:00+08:00'), open: 1448, high: 1452, low: 1439, close: 1441, volume: 21000, turnover: 3.03e9 },
  { timestamp: Date.parse('2026-09-17T00:00:00+08:00'), open: 1450, high: 1468, low: 1442, close: 1461, volume: 28345, turnover: 4.136e9 },
]

interface PyHarness {
  status?: PyAvailability
  handlers?: Record<string, (params: Record<string, unknown>) => unknown>
  calls?: Array<{ task: string; params: Record<string, unknown> }>
}

function makeGateway(opts: { fetcher?: Fetcher; py?: PyHarness; db?: AppDb } = {}) {
  const db = opts.db ?? openDatabase(':memory:', { memory: true, noExtensions: true })
  const pyCalls = opts.py?.calls ?? []
  const gateway = createFinanceGateway({
    db,
    fetcher: opts.fetcher ?? makeFetcher(),
    pyStatus: async () => opts.py?.status ?? 'ready',
    runPy: async (task, params) => {
      pyCalls.push({ task, params })
      const handler = opts.py?.handlers?.[task]
      if (!handler) throw new Error(`fake bridge 未定义任务：${task}`)
      return handler(params)
    },
    now: () => new Date(clock),
  })
  return { db, gateway, pyCalls }
}

beforeEach(() => {
  clock = new Date('2026-09-18T02:00:00.000Z')
})

// ---------------------------------------------------------------- 缓存层

describe('M34 网关：缓存 TTL（cache.ts）', () => {
  it('klineFresh：日线按北京时间自然日；分钟线 5 分钟', () => {
    const base = new Date('2026-09-18T02:00:00Z') // 北京 10:00
    const fetched = base.toISOString()
    expect(klineFresh('day', fetched, base)).toBe(true)
    expect(klineFresh('day', fetched, new Date(base.getTime() + 6 * 3600_000))).toBe(true) // 北京 16:00 同日
    expect(klineFresh('day', fetched, new Date(base.getTime() + 15 * 3600_000))).toBe(false) // 北京次日 01:00
    expect(klineFresh('min5', fetched, new Date(base.getTime() + 4 * 60_000))).toBe(true)
    expect(klineFresh('min5', fetched, new Date(base.getTime() + 6 * 60_000))).toBe(false)
  })

  it('quote 10s / news 去重与 30 分钟窗口 / meta 读写', () => {
    const db = openDatabase(':memory:', { memory: true, noExtensions: true })
    const cache = createFinanceCache(db)
    const t0 = new Date('2026-09-18T02:00:00Z')

    cache.quotePut(
      {
        symbol: 'sh600519',
        code: '600519',
        name: '贵州茅台',
        price: 1461,
        prevClose: 1441,
        open: 1450,
        high: 1468,
        low: 1442,
        change: 20,
        changePct: 1.39,
        volume: 28345,
        turnover: 4.136e9,
        asOf: t0.toISOString(),
        source: 'eastmoney',
      },
      t0,
    )
    expect(cache.quoteGet('sh600519', new Date(t0.getTime() + 9_000))?.fresh).toBe(true)
    expect(cache.quoteGet('sh600519', new Date(t0.getTime() + 11_000))?.fresh).toBe(false)

    const news = (url: string, title: string) => ({
      url,
      title,
      source: '东方财富·公告',
      publishedAt: '2026-09-17 08:30:00',
      tier: 'official' as const,
    })
    cache.newsPut('symbol', '600519', [news('https://a', '公告一'), news('https://b', '公告二')], t0)
    cache.newsPut('symbol', '600519', [news('https://a', '公告一（重复不新增）')], t0)
    expect(cache.newsGetFresh('symbol', '600519', new Date(t0.getTime() + 29 * 60_000))).toHaveLength(2)
    expect(cache.newsGetFresh('symbol', '600519', new Date(t0.getTime() + 31 * 60_000))).toHaveLength(0)
    expect(cache.newsGetAll('symbol', '600519')).toHaveLength(2)

    cache.metaSet('symbol_master', { rows: [{ code: '600519', name: '贵州茅台', type: 'stock', exchange: 'sh' }] }, t0)
    const meta = cache.metaGet<{ rows: unknown[] }>('symbol_master')
    expect(meta?.value.rows).toHaveLength(1)
    expect(ageFresh(meta?.updatedAt ?? '', 60_000, new Date(t0.getTime() + 30_000))).toBe(true)
    expect(ageFresh(meta?.updatedAt ?? '', 60_000, new Date(t0.getTime() + 61_000))).toBe(false)
    db.close()
  })
})

// ---------------------------------------------------------------- 快照

describe('M34 网关：快照（snapshot.ts）', () => {
  const series = {
    symbol: 'sh600519',
    name: '贵州茅台',
    period: 'day' as const,
    adjust: 'qfq' as const,
    bars: [...PY_BARS],
    source: 'baostock',
    asOf: '2026-09-17T15:00:00+08:00',
  }

  it('snapshotFilename 北京时间戳 / buildKlineSnapshot 结构与拷贝语义', () => {
    const ts = new Date('2026-09-18T02:30:00Z') // 北京 10:30
    expect(snapshotStamp(ts)).toBe('202609181030')
    expect(snapshotFilename('sh600519', 'day', ts)).toBe('sh600519-day-202609181030.json')

    const snap = buildKlineSnapshot(series, {
      indicators: ['MA', 'MACD'],
      annotations: [{ type: 'priceLine', price: 1500, label: '压力位' }],
      note: 'baostock 主源',
    })
    expect(snap.kind).toBe('kline')
    expect(snap.meta).toMatchObject({ source: 'baostock', bars: 2, note: 'baostock 主源' })
    expect(snap.indicators).toEqual(['MA', 'MACD'])
    expect(snap.annotations?.[0]).toMatchObject({ type: 'priceLine', price: 1500 })
    expect(snap.bars[0]).not.toBe(series.bars[0]) // bar 为拷贝
  })

  it('writeChartSnapshot：写入工作区 charts/ 并返回相对路径', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-m34-snap-'))
    try {
      const snap = buildKlineSnapshot(series)
      const result = await writeChartSnapshot(workspace, 'charts', snap, { now: new Date('2026-09-18T02:30:00Z') })
      expect(result.path).toBe('charts/sh600519-day-202609181030.json')
      expect(fs.existsSync(result.absPath)).toBe(true)
      expect(result.bytes).toBeGreaterThan(0)
      const parsed = JSON.parse(fs.readFileSync(result.absPath, 'utf8')) as {
        kind: string
        meta: { source: string }
      }
      expect(parsed.kind).toBe('kline')
      expect(parsed.meta.source).toBe('baostock')
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------- quote 路由

describe('M34 网关：quote 路由 / 降级 / stale', () => {
  it('东财主源成功 → miss；TTL 内二次调用 → hit（不再取数）', async () => {
    const calls: Call[] = []
    const { gateway, db } = makeGateway({ fetcher: makeFetcher({ calls }) })
    try {
      const first = await gateway.quote([sym('600519'), sym('159915')])
      expect(first.source).toBe('eastmoney')
      expect(first.cache).toBe('miss')
      expect(first.data).toHaveLength(2)
      const count = calls.length
      advance(5_000)
      const second = await gateway.quote([sym('600519')])
      expect(second.cache).toBe('hit')
      expect(second.data[0].price).toBe(1461)
      expect(calls.length).toBe(count)
    } finally {
      db.close()
    }
  })

  it('主源失败 → 腾讯备源（degraded 溯源到 eastmoney）', async () => {
    const { gateway, db } = makeGateway({ fetcher: makeFetcher({ fail: ['ulist.np'] }) })
    try {
      const res = await gateway.quote([sym('600519')])
      expect(res.source).toBe('tencent')
      expect(res.data[0].price).toBe(1461)
      expect(res.degraded).toContain('eastmoney')
    } finally {
      db.close()
    }
  })

  it('Node 三源全败 → py akshare 兜底', async () => {
    const pyCalls: Array<{ task: string; params: Record<string, unknown> }> = []
    const { gateway, db } = makeGateway({
      fetcher: makeFetcher({ fail: ['ulist.np', 'qt.gtimg.cn', 'hq.sinajs.cn'] }),
      py: {
        handlers: {
          quote: () => ({
            items: [
              {
                code: '600519',
                name: '贵州茅台',
                price: 1461,
                changePct: 1.39,
                prevClose: 1441,
                open: 1450,
                high: 1468,
                low: 1442,
                change: 20,
                volume: 28345,
                turnover: 4.136e9,
              },
            ],
          }),
        },
        calls: pyCalls,
      },
    })
    try {
      const res = await gateway.quote([sym('600519')])
      expect(res.source).toBe('akshare')
      expect(res.data[0]).toMatchObject({ symbol: 'sh600519', price: 1461, source: 'akshare' })
      expect(res.degraded).toContain('sina')
      expect(pyCalls.map((c) => c.task)).toEqual(['quote'])
    } finally {
      db.close()
    }
  })

  it("source='node' 强制：不触碰 Python 桥；失败直接报错", async () => {
    const pyCalls: Array<{ task: string; params: Record<string, unknown> }> = []
    const { gateway, db } = makeGateway({
      fetcher: makeFetcher({ fail: ['ulist.np', 'qt.gtimg.cn', 'hq.sinajs.cn'] }),
      py: { handlers: { quote: () => ({ items: [] }) }, calls: pyCalls },
    })
    try {
      await expect(gateway.quote([sym('600519')], { source: 'node' })).rejects.toThrow(GatewayError)
      expect(pyCalls).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it("source='py' + 探测 absent → 明确报错（不降级）", async () => {
    const { gateway, db } = makeGateway({ py: { status: 'absent' } })
    try {
      await expect(gateway.quote([sym('600519')], { source: 'py' })).rejects.toThrow(/Python/)
    } finally {
      db.close()
    }
  })

  it('源全败 + 过期缓存 → stale 兜底（数据保留并注明降级）', async () => {
    let down = false
    const { gateway, db } = makeGateway({ fetcher: makeFetcher({ failAll: () => down }) })
    try {
      const first = await gateway.quote([sym('600519')])
      expect(first.cache).toBe('miss')
      advance(11_000) // quote TTL 10s 过期
      down = true
      const res = await gateway.quote([sym('600519')])
      expect(res.cache).toBe('stale')
      expect(res.data[0].price).toBe(1461)
      expect(res.degraded).toContain('全部数据源失败')
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------- kline 路由

describe('M34 网关：kline 路由', () => {
  it('日线：baostock（Py）主源成功；缓存复读不重复调桥', async () => {
    const pyCalls: Array<{ task: string; params: Record<string, unknown> }> = []
    const { gateway, db } = makeGateway({
      py: {
        handlers: { kline: (params) => ({ code: 'sh.600519', bars: PY_BARS, engine: params.engine ?? 'baostock' }) },
        calls: pyCalls,
      },
    })
    try {
      const res = await gateway.kline(sym('600519'), 'day', 'qfq', 250)
      expect(res.source).toBe('baostock')
      expect(res.data.bars).toHaveLength(2)
      expect(res.data.symbol).toBe('sh600519')
      const again = await gateway.kline(sym('600519'), 'day', 'qfq', 250)
      expect(again.cache).toBe('hit')
      expect(again.data.bars).toHaveLength(2)
      expect(pyCalls.filter((c) => c.task === 'kline')).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('日线：py 失败 → 东财备源（degraded 记录 baostock 失败）并写入缓存', async () => {
    const { gateway, db } = makeGateway({
      py: { handlers: { kline: () => { throw new Error('baostock 登录失败') } } },
    })
    try {
      const res = await gateway.kline(sym('600519'), 'day', 'qfq', 250)
      expect(res.source).toBe('eastmoney')
      expect(res.data.bars).toHaveLength(5)
      expect(res.degraded).toContain('baostock')
      const again = await gateway.kline(sym('600519'), 'day', 'qfq', 250)
      expect(again.cache).toBe('hit')
      expect(again.source).toBe('eastmoney')
    } finally {
      db.close()
    }
  })

  it('分钟线：链不含 baostock（直接东财）', async () => {
    const pyCalls: Array<{ task: string; params: Record<string, unknown> }> = []
    const { gateway, db } = makeGateway({ py: { handlers: { kline: () => ({ bars: [] }) }, calls: pyCalls } })
    try {
      const res = await gateway.kline(sym('600519'), 'min5', 'none', 100)
      expect(res.source).toBe('eastmoney')
      expect(pyCalls).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it("探测 absent：auto 过滤 py 环，直接东财（source='py' 时报错）", async () => {
    const pyCalls: Array<{ task: string; params: Record<string, unknown> }> = []
    const { gateway, db } = makeGateway({ py: { status: 'absent', calls: pyCalls } })
    try {
      const res = await gateway.kline(sym('600519'), 'day', 'qfq', 250)
      expect(res.source).toBe('eastmoney')
      expect(pyCalls).toHaveLength(0)
      await expect(gateway.kline(sym('002594'), 'day', 'qfq', 250, { source: 'py' })).rejects.toThrow(/Python/)
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------- indicator / fundamental / calendar

describe('M34 网关：indicator / fundamental / calendar', () => {
  const bars = PY_BARS.map((b) => ({ ...b }))

  it('indicator：ta（Py）主源 points + Node 纯计算补齐 signals', async () => {
    const pyPoints = bars.map((b) => ({ timestamp: b.timestamp, values: { MA5: b.close } }))
    const { gateway, db } = makeGateway({ py: { handlers: { indicators: () => ({ name: 'MA', points: pyPoints }) } } })
    try {
      const res = await gateway.indicator('MA', bars, {})
      expect(res.source).toBe('ta')
      expect(res.data.points).toHaveLength(bars.length)
      expect(Array.isArray(res.data.signals)).toBe(true)
    } finally {
      db.close()
    }
  })

  it('indicator：ta 失败 → Node 自研库兜底', async () => {
    const { gateway, db } = makeGateway({
      py: { handlers: { indicators: () => { throw new Error('ta 未安装') } } },
    })
    try {
      const res = await gateway.indicator('MA', bars, {})
      expect(res.source).toBe('node-indicator')
      expect(res.data.points).toHaveLength(bars.length)
      expect(res.degraded).toContain('ta')
    } finally {
      db.close()
    }
  })

  it('fundamental：baostock 失败 → akshare 引擎兜底', async () => {
    const { gateway, db } = makeGateway({
      py: {
        handlers: {
          fundamentals: (params) => {
            if (params.engine === 'akshare') return { rows: [{ 日期: '2026-06-30', 归母净利润: 123.4 }] }
            throw new Error('baostock 登录失败')
          },
        },
      },
    })
    try {
      const res = await gateway.fundamental(sym('600519'))
      expect(res.source).toBe('akshare')
      expect(res.data.periods[0].period).toBe('2026-06-30')
      expect(res.degraded).toContain('baostock')
    } finally {
      db.close()
    }
  })

  it('calendar：py 主源 + finance_meta 缓存（12h 内复读不调桥）', async () => {
    const pyCalls: Array<{ task: string; params: Record<string, unknown> }> = []
    const { gateway, db } = makeGateway({
      py: { handlers: { calendar: () => ({ days: ['2026-09-17', '2026-09-18'] }) }, calls: pyCalls },
    })
    try {
      const first = await gateway.calendar({ year: 2026 })
      expect(first.source).toBe('baostock')
      expect(first.data).toMatchObject({ start: '2026-01-01', end: '2026-12-31' })
      expect(first.data.days).toHaveLength(2)
      advance(60 * 60_000)
      const second = await gateway.calendar({ year: 2026 })
      expect(second.cache).toBe('hit')
      expect(pyCalls).toHaveLength(1)
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------- 基金 / 新闻 / 主数据

describe('M34 网关：基金 / 新闻 / 主数据 / 搜索', () => {
  it('fundProfile：天天基金主源（名称 / 费率 / 规模 / 持仓 / 分红）', async () => {
    const { gateway, db } = makeGateway()
    try {
      const res = await gateway.fundProfile('000001', 'fund')
      expect(res.source).toBe('eastmoney-fund')
      expect(res.data).toMatchObject({ code: '000001', name: '华夏成长混合', feeRate: 1.2, kind: 'fund', scale: 39.38 })
      // 费率语义：jbgk 管理费率（1.2%）优先于 pingzhongdata fund_Rate（申购费率 1.5%）
      // jbgk：无跟踪标的 → 缺省；jjcc 持仓（10 行）；fhsp 分红（3 条）
      expect(res.data.trackingIndex).toBeUndefined()
      expect(res.data.holdings).toHaveLength(10)
      expect(res.data.holdings?.[0]).toMatchObject({ code: '300308', name: '中际旭创', weightPct: 6.45 })
      expect(res.data.dividends).toHaveLength(3)
      expect(res.data.dividends?.[0]).toMatchObject({ date: '2025-09-22', amount: 0.01 })
    } finally {
      db.close()
    }
  })

  it('fundNav：天天基金历史净值（分页解析）', async () => {
    const { gateway, db } = makeGateway()
    try {
      const res = await gateway.fundNav('000001', 10)
      expect(res.source).toBe('eastmoney-fund')
      expect(res.data.points.length).toBeGreaterThan(0)
      expect(res.data.points[res.data.points.length - 1].nav).toBe(1.234)
    } finally {
      db.close()
    }
  })

  it('news：个股公告东财主源 + 30 分钟内缓存命中', async () => {
    const calls: Call[] = []
    const { gateway, db } = makeGateway({ fetcher: makeFetcher({ calls }) })
    try {
      const first = await gateway.news({ symbol: '600519', limit: 5 })
      expect(first.source).toBe('eastmoney')
      expect(first.data.length).toBeGreaterThan(0)
      expect(first.data[0].tier).toBe('official')
      const count = calls.length
      const second = await gateway.news({ symbol: '600519', limit: 1 })
      expect(second.cache).toBe('hit')
      expect(calls.length).toBe(count)
    } finally {
      db.close()
    }
  })

  it('news：市场要闻走新浪滚动', async () => {
    const { gateway, db } = makeGateway()
    try {
      const res = await gateway.news({ market: 'cn', limit: 5 })
      expect(res.source).toBe('sina')
      expect(res.data.length).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  it('symbolMaster：东财 clist 主数据（7 天缓存）+ search 本地匹配', async () => {
    const { gateway, db } = makeGateway()
    try {
      const master = await gateway.symbolMaster()
      expect(master.cache).toBe('miss')
      expect(master.data.length).toBeGreaterThanOrEqual(4)
      const hit = await gateway.symbolMaster()
      expect(hit.cache).toBe('hit')

      const byCode = await gateway.search('600519')
      expect(byCode.data[0]).toMatchObject({ code: '600519', name: '贵州茅台', type: 'stock' })
      const byName = await gateway.search('平安')
      expect(byName.data[0].code).toBe('000001')
      const byPrefix = await gateway.search('1599')
      expect(byPrefix.data[0].code).toBe('159915')
    } finally {
      db.close()
    }
  })

  it('symbolMaster：分页未完成 → 增量交付 + search 补 suggest；重启实例从游标续拉至完成', async () => {
    const paged: Fetcher = async (req) => {
      if (req.url.includes('suggest/get')) {
        return {
          status: 200,
          ok: true,
          statusText: 'OK',
          finalUrl: req.url,
          headers: new Headers(),
          text: fixture('eastmoney-suggest.json'),
          setCookies: [],
        }
      }
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
    const { gateway, db } = makeGateway({ fetcher: paged })
    try {
      // 第一轮：前台 6 页预算（股票段 pn1-6）→ 600 行增量返回，complete=false
      const first = await gateway.symbolMaster()
      expect(first.cache).toBe('miss')
      expect(first.data).toHaveLength(600)
      expect(first.degraded).toContain('增量加载中')
      // 增量期间 search：本地命中不足 → 在线 suggest 合并（source=local+suggest）
      const found = await gateway.search('600519')
      expect(found.source).toBe('local+suggest')
      expect(found.data[0].code).toBe('600519')
      // 重启实例（同库）：从持久化游标续拉（股票 pn7 + ETF pn1-2）→ 完整 800 行
      const g2 = makeGateway({ fetcher: paged, db }).gateway
      const rest = await g2.symbolMaster()
      expect(rest.data).toHaveLength(800)
      expect(rest.degraded).toBeUndefined()
      expect(rest.data.some((row) => row.code === '510000')).toBe(true)
      // 完整后命中缓存
      const hit = await g2.symbolMaster()
      expect(hit.cache).toBe('hit')
      expect(hit.data).toHaveLength(800)
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------- 健康度（反爬联动）

describe('M34 网关：源健康度冷却', () => {
  it('连续两次失败 → 冷却期跳过（第三次不再请求该源，degraded 注明）', async () => {
    const calls: Call[] = []
    const { gateway, db } = makeGateway({ fetcher: makeFetcher({ fail: ['ulist.np'], calls }) })
    try {
      await gateway.quote([sym('600519')]) // eastmoney 失败 1 → tencent 成功
      advance(11_000)
      await gateway.quote([sym('159915')]) // eastmoney 失败 2 → 进入冷却；tencent 成功
      const eastCalls = calls.filter((c) => c.url.includes('ulist.np')).length
      expect(eastCalls).toBe(2)

      advance(11_000) // 让 quote 缓存过期，确保第三次真正走链
      const res = await gateway.quote([sym('600519')])
      expect(res.source).toBe('tencent')
      expect(res.degraded).toContain('冷却期跳过')
      expect(calls.filter((c) => c.url.includes('ulist.np')).length).toBe(2)

      const health = gateway.health().find((h) => h.source === 'eastmoney')
      expect(health).toMatchObject({ fails: 2, cooling: true })
      expect(health?.cooldownUntil).toBeDefined()

      gateway.resetHealth()
      expect(gateway.health()).toHaveLength(0)
    } finally {
      db.close()
    }
  })
})
