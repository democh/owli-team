/**
 * M34 测试：/api 金融投研路由（createFinanceRouter）——环境健康度 / 自选 CRUD / 行情 / K 线 / 检索 / 新闻 / 博弈。
 * 未装配网关 503；参数非法 400；自选缺失 404；上游数据源全失败 502。
 *
 * 环境：makeEnv（全量装配）+ 真实网关（fixture 回放 Fetcher，零网络零 spawn）+ FinanceStore
 * + express listen(0) 真实 HTTP 往返；Python 探测注入桩（不 spawn 解释器）。
 */
import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import type { PyEnvStatus } from '../src/finance/bridge/probe.js'
import type { Fetcher } from '../src/finance/fetcher.js'
import { createFinanceGateway } from '../src/finance/gateway.js'
import { createFinanceRouter } from '../src/routes/finance.js'
import type { ApiDeps } from '../src/routes/index.js'
import { FinanceStore } from '../src/store/finance.js'
import { makeEnv } from './helpers.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'finance')

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8')
}

/** 固定时钟（北京时间 2026-09-18 10:00） */
const CLOCK = new Date('2026-09-18T02:00:00.000Z')

/** fixture 回放 Fetcher（与 m34-finance-tools 同构：clist 双底表 / kline / 公告 / 快讯…） */
function makeFetcher(): Fetcher {
  return async (req) => {
    const url = req.url
    let text: string | undefined
    if (url.includes('clist/get')) {
      const isEtf = /MK002[1-4]/.test(url)
      text = fixture(isEtf ? 'eastmoney-clist-screen-etf.json' : 'eastmoney-clist-screen.json')
    } else if (url.includes('ulist.np')) text = fixture('eastmoney-quote.json')
    else if (url.includes('kline/get')) text = fixture('eastmoney-kline-long.json')
    else if (url.includes('suggest/get')) text = fixture('eastmoney-suggest.json')
    else if (url.includes('security/ann')) text = fixture('notice.json')
    else if (url.includes('roll/get')) text = fixture('sina-roll.json')
    if (text === undefined) throw new Error(`无匹配 fixture：${url}`)
    return {
      status: 200,
      ok: true,
      statusText: 'OK',
      finalUrl: url,
      headers: new Headers(),
      text,
      setCookies: [],
    }
  }
}

const PY_STATUS: PyEnvStatus = {
  level: 'ready',
  at: CLOCK.getTime(),
  python: '/usr/bin/python3',
  version: '3.12.4',
  packages: { baostock: { installed: true, version: '0.8.9' } },
  missing: [],
  summary: 'Python 3.12.4 就绪（5/5 必需包）',
}

const JSON_HEADERS = { 'content-type': 'application/json' }

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0)) {
    await fn().catch(() => undefined)
  }
})

/** 挂 router 到临时端口；返回 base url（/api 前缀由调用方处理） */
async function listenRouter(router: express.Router): Promise<string> {
  const app = express()
  app.use(express.json())
  app.use('/api', router)
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  )
  return `http://127.0.0.1:${port}`
}

async function makeApi(overrides: Record<string, unknown> = {}) {
  const env = makeEnv({
    financeEnabled: true,
    financeGameMaxPaths: 50,
    financeGameSeed: 20260918,
    ...overrides,
  })
  const gateway = createFinanceGateway({
    db: env.db,
    fetcher: makeFetcher(),
    pyStatus: async () => 'ready',
    runPy: async (task) => {
      throw new Error(`fake bridge 未定义任务：${task}`)
    },
    now: () => new Date(CLOCK),
  })
  const store = new FinanceStore(env.db)
  const deps = {
    cfg: env.cfg,
    finance: gateway,
    financeStore: store,
    financeProbe: async () => PY_STATUS,
    engine: env.engine,
    notify: env.notify,
  } as unknown as ApiDeps
  const url = await listenRouter(createFinanceRouter(deps))
  return { env, gateway, store, url }
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) })
}

describe('M34 路由：未装配与健康度', () => {
  it('缺省金融网关时统一 503（env / watchlist / game）', async () => {
    const env = makeEnv()
    const deps = { cfg: env.cfg, engine: env.engine, notify: env.notify } as unknown as ApiDeps
    const url = await listenRouter(createFinanceRouter(deps))
    const endpoints: Array<[string, () => Promise<Response>]> = [
      [`${url}/api/finance/env`, () => fetch(`${url}/api/finance/env`)],
      [`${url}/api/finance/watchlist`, () => fetch(`${url}/api/finance/watchlist`)],
      [`${url}/api/finance/game`, () => post(`${url}/api/finance/game`, { action: 'matrix', topic: 't' })],
    ]
    for (const [label, run] of endpoints) {
      const res = await run()
      expect(res.status, label).toBe(503)
      expect(((await res.json()) as { error: string }).error).toContain('未启用')
    }
  })

  it('GET env：Python 状态 / 数据源健康度 / 自选数 / 运行参数回显', async () => {
    const { url, store, env } = await makeApi()
    store.add({ symbol: 'sh600519', type: 'stock', name: '贵州茅台' })
    const res = await fetch(`${url}/api/finance/env`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      enabled: boolean
      py: PyEnvStatus
      health: unknown[]
      watchlistCount: number
      settings: Record<string, unknown>
    }
    expect(body.enabled).toBe(true)
    expect(body.py.level).toBe('ready')
    expect(body.py.summary).toContain('Python 3.12.4')
    expect(body.health).toEqual([])
    expect(body.watchlistCount).toBe(1)
    expect(body.settings.gameMaxPaths).toBe(50)
    expect(body.settings.gameSeed).toBe(20260918)
    expect(body.settings.quoteRefreshMs).toBe(env.cfg.financeQuoteRefreshMs)
    expect(body.settings.minIntervalMs).toBe(env.cfg.financeMinIntervalMs)
  })
})

describe('M34 路由：自选列表 CRUD', () => {
  it('POST 添加（归一化 upsert）/ GET 清单 / DELETE 移除（含 6 位代码容错）', async () => {
    const { url, store } = await makeApi()
    const empty = await fetch(`${url}/api/finance/watchlist`)
    expect(((await empty.json()) as { items: unknown[] }).items).toEqual([])

    const add = await post(`${url}/api/finance/watchlist`, { symbol: '600519' })
    expect(add.status).toBe(200)
    const added = (await add.json()) as { item: { symbol: string; name: string; type: string }; created: boolean; label: string }
    expect(added.created).toBe(true)
    expect(added.item.symbol).toBe('sh600519')
    expect(added.item.name).toBe('贵州茅台')
    expect(added.item.type).toBe('stock')
    expect(added.label).toContain('股票')

    // 重复添加 = 更新（note 覆盖，created=false）
    const again = await post(`${url}/api/finance/watchlist`, { symbol: 'sh600519', note: '长期跟踪' })
    const updated = (await again.json()) as { item: { note?: string }; created: boolean }
    expect(updated.created).toBe(false)
    expect(updated.item.note).toBe('长期跟踪')
    expect(store.count()).toBe(1)

    const etf = await post(`${url}/api/finance/watchlist`, { symbol: '159915' })
    expect(((await etf.json()) as { item: { symbol: string } }).item.symbol).toBe('sz159915')

    // 6 位代码容错删除（sh600519 ← 600519）
    const del = await fetch(`${url}/api/finance/watchlist/600519`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    const removed = (await del.json()) as { ok: boolean; removed: { symbol: string } }
    expect(removed.ok).toBe(true)
    expect(removed.removed.symbol).toBe('sh600519')
    expect(store.count()).toBe(1)

    const ghost = await fetch(`${url}/api/finance/watchlist/sh999999`, { method: 'DELETE' })
    expect(ghost.status).toBe(404)
  })

  it('POST 非法参数 400（未识别标的 / zod 校验）', async () => {
    const { url } = await makeApi()
    const bad = await post(`${url}/api/finance/watchlist`, { symbol: '不存在的标的xyz' })
    expect(bad.status).toBe(400)
    const badBody = (await bad.json()) as { error: string; detail?: string }
    expect(badBody.error).toContain('无法识别')
    // 在线候选检索命中 suggest fixture → 附候选明细
    expect(badBody.detail ?? '').toContain('600519')

    const noSymbol = await post(`${url}/api/finance/watchlist`, {})
    expect(noSymbol.status).toBe(400)
    expect(((await noSymbol.json()) as { error: string }).error).toContain('参数非法')
  })
})

describe('M34 路由：行情 / K 线 / 检索 / 新闻', () => {
  it('GET quote：批量行情（归一 + 价格口径）与 400 分支', async () => {
    const { url } = await makeApi()
    const res = await fetch(`${url}/api/finance/quote?symbols=600519,159915`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      quotes: Array<{ symbol: string; price: number; changePct: number; source: string }>
      unresolved: string[]
      source: string
    }
    expect(body.quotes).toHaveLength(2)
    expect(body.unresolved).toEqual([])
    const mt = body.quotes.find((q) => q.symbol === 'sh600519')!
    expect(mt.price).toBe(1461)
    expect(mt.changePct).toBe(1.39)
    expect(body.source).toBe('eastmoney')

    const none = await fetch(`${url}/api/finance/quote?symbols=${encodeURIComponent('不存在的标的xyz')}`)
    expect(none.status).toBe(400)
    expect(((await none.json()) as { error: string }).error).toContain('全部标的未能识别')

    const many = await fetch(`${url}/api/finance/quote?symbols=${Array.from({ length: 51 }, () => '600519').join(',')}`)
    expect(many.status).toBe(400)
    expect(((await many.json()) as { error: string }).error).toContain('最多 50')

    const missing = await fetch(`${url}/api/finance/quote`)
    expect(missing.status).toBe(400)
  })

  it('GET kline：K 线 + 指标序列（默认 MA/VOL；指标面板可调）与 400 分支', async () => {
    const { url } = await makeApi()
    const res = await fetch(`${url}/api/finance/kline?symbol=600519&period=day&adjust=qfq&limit=30`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      kline: { symbol: string; period: string; adjust: string; bars: Array<{ close: number }>; source: string }
      indicators: Array<{ name: string; points: unknown[]; signals: string[] }>
      render: string[]
    }
    expect(body.kline.symbol).toBe('sh600519')
    expect(body.kline.period).toBe('day')
    expect(body.kline.adjust).toBe('qfq')
    expect(body.kline.bars).toHaveLength(30)
    expect(body.kline.bars[29].close).toBe(136)
    expect(body.render).toEqual(['MA', 'VOL'])
    expect(body.indicators.map((i) => i.name)).toEqual(['MA'])
    expect(body.indicators[0].points).toHaveLength(30)

    const macd = await fetch(`${url}/api/finance/kline?symbol=600519&limit=30&indicators=MACD,VOL`)
    const multi = (await macd.json()) as { indicators: Array<{ name: string }>; render: string[] }
    expect(multi.indicators.map((i) => i.name)).toEqual(['MACD'])
    expect(multi.render).toEqual(['MACD', 'VOL'])

    const badIndicator = await fetch(`${url}/api/finance/kline?symbol=600519&indicators=XYZ`)
    expect(badIndicator.status).toBe(400)
    expect(((await badIndicator.json()) as { error: string }).error).toContain('指标不支持')

    const badPeriod = await fetch(`${url}/api/finance/kline?symbol=600519&period=hour`)
    expect(badPeriod.status).toBe(400)
  })

  it('GET search / news：检索命中与个股公告（official 信源）', async () => {
    const { url } = await makeApi()
    const search = await fetch(`${url}/api/finance/search?q=600519`)
    expect(search.status).toBe(200)
    const rows = ((await search.json()) as { rows: Array<{ code: string; name: string }> }).rows
    expect(rows.some((r) => r.code === '600519' && r.name === '贵州茅台')).toBe(true)

    const news = await fetch(`${url}/api/finance/news?symbol=sh600519&limit=10`)
    expect(news.status).toBe(200)
    const items = ((await news.json()) as { items: Array<{ title: string; tier?: string; symbol?: string }> }).items
    expect(items).toHaveLength(2)
    expect(items[0].tier).toBe('official')
    expect(items[0].title).toContain('贵州茅台')
    expect(items[0].symbol).toBe('600519')
  })
})

describe('M34 路由：博弈推演', () => {
  it('POST game：matrix 静态推演（默认种子 / 模型标签 / 统计口径）', async () => {
    const { url } = await makeApi()
    const res = await post(`${url}/api/finance/game`, { action: 'matrix', topic: '茅台多空对峙推演' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      model: string
      modelLabel: string
      topic: string
      seed: number
      params: Record<string, unknown>
      stats: Record<string, unknown>
      result: { gameType: string }
      narrative: string
    }
    expect(body.model).toBe('matrix')
    expect(body.modelLabel).toBe('静态矩阵博弈')
    expect(body.topic).toBe('茅台多空对峙推演')
    expect(body.seed).toBe(20260918)
    expect(body.stats.gameType).toBe('chicken')
    expect(body.result.gameType).toBe('chicken')
    expect(body.narrative.length).toBeGreaterThan(0)
    expect(body.params.capital).toBeDefined()
  })

  it('POST game：simulate paths 受护栏截断并注明；GameError / zod 校验 400', async () => {
    const { url } = await makeApi()
    const res = await post(`${url}/api/finance/game`, {
      action: 'simulate',
      topic: '压力位攻防',
      params: { paths: 9999 },
      seed: 42,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { params: { paths: number }; note?: string; seed: number }
    expect(body.params.paths).toBe(50)
    expect(body.note ?? '').toContain('限制为 50')
    expect(body.seed).toBe(42)

    const gameErr = await post(`${url}/api/finance/game`, { action: 'matrix', topic: 'x', params: { capital: 0 } })
    expect(gameErr.status).toBe(400)
    expect(((await gameErr.json()) as { error: string }).error).toContain('不得小于 1')

    const bad = await post(`${url}/api/finance/game`, { action: 'bogus', topic: 'x' })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toContain('博弈参数非法')
  })
})
