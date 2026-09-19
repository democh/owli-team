/**
 * 金融数据网关（M34 §3.3）：能力路由 + 降级链 + 缓存 + 数据溯源。
 *
 * 路由表（文档 §3.3；标注「实测校准」处为实施期实测结论）：
 *   quote        eastmoney → tencent → sina → akshare(Py)
 *   kline 日/周/月  baostock(Py) → eastmoney → akshare(Py)
 *   kline 分钟     eastmoney → akshare(Py)
 *   indicator      ta(Py) → node-indicator（Node 自研库兜底；signals 统一走 Node 纯计算）
 *   fundamental    baostock(Py) → akshare(Py)
 *   calendar       baostock(Py) → akshare(Py)（结果入 finance_meta，TTL 12h）
 *   fund_profile   eastmoney-fund（实测校准：pingzhongdata 名称/费率完整度高于首期 akshare 档案）→ akshare(Py)
 *   fund_nav       eastmoney-fund → akshare(Py)
 *   news           个股：eastmoney 公告 → akshare；市场：sina 滚动
 *   symbol/screen  eastmoney clist（TTL 7d / 10min）→ akshare(Py)
 *
 * 降级语义：`source: 'auto' | 'node' | 'py'` 可强制层级（node/py 表示仅该层数据源）；
 * 降级发生时 `degraded` 注明失败原因链；缓存命中 `cache: 'hit'`，源全失败回退过期数据 `'stale'`。
 * 反爬联动：同一来源连续失败 ≥2 次进入 5 分钟冷却，路由自动跳过（防止风控升级），成功后清零。
 */
import type { AppDb } from '../store/db.js'
import { probePython } from './bridge/probe.js'
import { runBridge } from './bridge/runner.js'
import { ageFresh, createFinanceCache, CALENDAR_TTL_MS, SCREEN_BASE_TTL_MS, SYMBOL_MASTER_TTL_MS } from './cache.js'
import { num, str, type Fetcher, type SourceCtx } from './fetcher.js'
import { computeIndicator, type IndicatorName, type IndicatorSeries } from './indicator.js'
import { CN_TZ_OFFSET_MS, parseCnDate, type Adjust, type Period } from './period.js'
import { inferAssetType, inferExchange, type FinSymbol, type SymbolMasterRow } from './symbol.js'
import {
  fetchKline as emFetchKline,
  fetchQuotes as emFetchQuotes,
  fetchScreenRows,
  fetchSymbolList,
  searchSymbols,
} from './sources/eastmoney.js'
import { computeNavReturns, fetchFundBasic, fetchFundNav } from './sources/fund.js'
import { dedupeNews, fetchMarketNews, fetchNotices } from './sources/news.js'
import { fetchQuotes as sinaFetchQuotes } from './sources/sina.js'
import { fetchQuotes as tencentFetchQuotes } from './sources/tencent.js'
import type {
  FundNavPoint,
  FundNavSeries,
  FundProfile,
  FundamentalPeriod,
  FundamentalSeries,
  GatewayResult,
  KlineBar,
  KlineSeries,
  NewsItem,
  Quote,
  ScreenRow,
} from './types.js'

export type SourcePref = 'auto' | 'node' | 'py'
export type PyAvailability = 'ready' | 'partial' | 'absent'

export class GatewayError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GatewayError'
  }
}

export interface GatewayCfg {
  /** Python 解释器路径（空 = 自动探测；透传 probe / bridge） */
  python?: string
  /** Python 桥单任务超时（ms） */
  pyTimeoutMs?: number
  /** 金融源同域最小间隔（ms；0/缺省 = 复用 antiBotFetch 默认） */
  minIntervalMs?: number
}

export interface GatewayDeps {
  db: AppDb
  cfg?: GatewayCfg
  /** Node 源 Fetcher 注入（测试 = fixture 回放） */
  fetcher?: Fetcher
  /** Python 可用性（默认 probePython 探测结果；测试注入固定值） */
  pyStatus?: () => Promise<PyAvailability>
  /** Python 桥调用（默认 runBridge；返回 data 主体） */
  runPy?: (task: string, params: Record<string, unknown>) => Promise<unknown>
  now?: () => Date
}

export interface GatewayHealth {
  source: string
  fails: number
  cooling: boolean
  cooldownUntil?: string
  lastError?: string
}

export interface FinanceGateway {
  quote(syms: FinSymbol[], opts?: { source?: SourcePref }): Promise<GatewayResult<Quote[]>>
  kline(
    sym: FinSymbol,
    period: Period,
    adjust: Adjust,
    limit?: number,
    opts?: { source?: SourcePref },
  ): Promise<GatewayResult<KlineSeries>>
  indicator(
    name: IndicatorName,
    bars: KlineBar[],
    params?: Record<string, number>,
    opts?: { source?: SourcePref },
  ): Promise<GatewayResult<IndicatorSeries>>
  fundamental(
    sym: FinSymbol,
    opts?: { year?: number; quarter?: number; source?: SourcePref },
  ): Promise<GatewayResult<FundamentalSeries>>
  calendar(opts?: { year?: number; start?: string; end?: string; source?: SourcePref }): Promise<
    GatewayResult<{ start: string; end: string; days: string[] }>
  >
  fundProfile(code: string, kind: 'etf' | 'fund', opts?: { source?: SourcePref }): Promise<GatewayResult<FundProfile>>
  fundNav(code: string, limit?: number, opts?: { source?: SourcePref }): Promise<GatewayResult<FundNavSeries>>
  news(opts?: {
    symbol?: string
    market?: string
    limit?: number
    since?: string
    source?: SourcePref
  }): Promise<GatewayResult<NewsItem[]>>
  symbolMaster(opts?: { source?: SourcePref }): Promise<GatewayResult<SymbolMasterRow[]>>
  screenBase(opts?: { source?: SourcePref }): Promise<GatewayResult<ScreenRow[]>>
  search(query: string, opts?: { limit?: number; source?: SourcePref }): Promise<GatewayResult<SymbolMasterRow[]>>
  /** 数据源健康度（反爬联动：冷却中的源被路由跳过） */
  health(): GatewayHealth[]
  resetHealth(): void
}

// ---------------------------------------------------------------- 源健康度（反爬联动）

const FAIL_THRESHOLD = 2
const COOLDOWN_MS = 5 * 60_000

interface HealthState {
  fails: number
  coolingUntil: number
  lastError?: string
}

// ---------------------------------------------------------------- 编排队列

interface ChainStep<T> {
  /** 溯源名（即 GatewayResult.source；兼作健康度 key） */
  label: string
  layer: 'node' | 'py'
  run: () => Promise<T>
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** py 桥返回的 K 线数据（fin_bridge.py task_kline / engine=akshare 同构） */
interface PyKlineData {
  bars?: Array<{
    timestamp?: unknown
    open?: unknown
    high?: unknown
    low?: unknown
    close?: unknown
    volume?: unknown
    turnover?: unknown
  }>
}

/** py 桥返回的快照数据（fin_bridge.py task_quote） */
interface PyQuoteItem {
  code?: unknown
  name?: unknown
  price?: unknown
  changePct?: unknown
  change?: unknown
  open?: unknown
  prevClose?: unknown
  high?: unknown
  low?: unknown
  volume?: unknown
  turnover?: unknown
  turnoverRate?: unknown
  pe?: unknown
  pb?: unknown
  marketCap?: unknown
  floatMarketCap?: unknown
}

function toNum(v: unknown): number | undefined {
  return num(v)
}

/** py K 线 bars → KlineSeries（空数据抛错以便降级） */
function mapPyKline(
  raw: unknown,
  sym: FinSymbol,
  period: Period,
  adjust: Adjust,
  limit: number,
  source: string,
): KlineSeries {
  const data = (raw ?? {}) as PyKlineData
  const bars: KlineBar[] = []
  for (const item of data.bars ?? []) {
    const ts = toNum(item.timestamp)
    const open = toNum(item.open)
    const high = toNum(item.high)
    const low = toNum(item.low)
    const close = toNum(item.close)
    if (ts === undefined || open === undefined || high === undefined || low === undefined || close === undefined) {
      continue
    }
    const bar: KlineBar = { timestamp: ts, open, high, low, close, volume: toNum(item.volume) ?? 0 }
    const turnover = toNum(item.turnover)
    if (turnover !== undefined) bar.turnover = turnover
    bars.push(bar)
  }
  if (bars.length === 0) throw new GatewayError(`${source} K 线返回为空`)
  return {
    symbol: sym.symbol,
    name: sym.name ?? sym.code,
    period,
    adjust,
    bars: bars.slice(-limit),
    source,
    asOf: new Date().toISOString(),
  }
}

/** py 快照 items → Quote[]（空数据抛错以便降级） */
function mapPyQuotes(raw: unknown, asOf: string): Quote[] {
  const items = ((raw ?? {}) as { items?: PyQuoteItem[] }).items ?? []
  const out: Quote[] = []
  for (const item of items) {
    const code = str(item.code)
    const price = toNum(item.price)
    if (!/^\d{6}$/.test(code) || price === undefined) continue
    const type = inferAssetType(code) ?? 'stock'
    const ex = inferExchange(code, type)
    const quote: Quote = {
      symbol: `${ex ?? ''}${code}`,
      code,
      name: str(item.name),
      price,
      prevClose: toNum(item.prevClose) ?? 0,
      open: toNum(item.open) ?? 0,
      high: toNum(item.high) ?? 0,
      low: toNum(item.low) ?? 0,
      change: toNum(item.change) ?? 0,
      changePct: toNum(item.changePct) ?? 0,
      volume: toNum(item.volume) ?? 0,
      turnover: toNum(item.turnover) ?? 0,
      asOf,
      source: 'akshare',
    }
    const turnoverRate = toNum(item.turnoverRate)
    if (turnoverRate !== undefined) quote.turnoverRate = turnoverRate
    const pe = toNum(item.pe)
    if (pe !== undefined) quote.pe = pe
    const pb = toNum(item.pb)
    if (pb !== undefined) quote.pb = pb
    const marketCap = toNum(item.marketCap)
    if (marketCap !== undefined) quote.marketCap = marketCap
    const floatMarketCap = toNum(item.floatMarketCap)
    if (floatMarketCap !== undefined) quote.floatMarketCap = floatMarketCap
    out.push(quote)
  }
  if (out.length === 0) throw new GatewayError('akshare 快照返回为空')
  return out
}

/** py 基金净值 points（date/nav/changePct）→ FundNavPoint[] */
function mapPyNavPoints(raw: unknown): FundNavPoint[] {
  const points = ((raw ?? {}) as { points?: Array<Record<string, unknown>> }).points ?? []
  const out: FundNavPoint[] = []
  for (const item of points) {
    const ts = parseCnDate(str(item.date))
    const nav = toNum(item.nav)
    if (!Number.isFinite(ts) || nav === undefined) continue
    const point: FundNavPoint = { timestamp: ts, nav }
    const changePct = toNum(item.changePct)
    if (changePct !== undefined) point.changePct = changePct
    out.push(point)
  }
  return out.sort((a, b) => a.timestamp - b.timestamp)
}

/** akshare 个股新闻 items → NewsItem[] */
function mapPyNews(raw: unknown): NewsItem[] {
  const items =
    ((raw ?? {}) as { items?: Array<{ title?: unknown; url?: unknown; source?: unknown; publishedAt?: unknown; summary?: unknown }> })
      .items ?? []
  const out: NewsItem[] = []
  for (const item of items) {
    const title = str(item.title)
    const url = str(item.url)
    if (!title || !url) continue
    const news: NewsItem = { title, url, source: str(item.source) || '东方财富', tier: 'media' }
    const publishedAt = str(item.publishedAt)
    if (publishedAt) news.publishedAt = publishedAt
    const summary = str(item.summary)
    if (summary) news.summary = summary
    out.push(news)
  }
  if (out.length === 0) throw new GatewayError('akshare 新闻返回为空')
  return out
}

/** baostock 季频盈利行（task_fundamentals）→ FundamentalPeriod */
function mapBsProfitRow(row: Record<string, unknown>): FundamentalPeriod {
  const period = str(row.statDate) || str(row.pubDate)
  const out: FundamentalPeriod = { period }
  const put = (key: string, value: unknown): void => {
    const n = toNum(value)
    if (n !== undefined) out[key] = n
  }
  put('roe', row.roeAvg)
  put('netProfit', row.netProfit)
  put('revenue', row.MBRevenue)
  put('grossMargin', row.gpMargin)
  put('netMargin', row.npMargin)
  put('eps', row.epsTTM)
  return out
}

/** akshare 财务行（引擎兜底；列名随版本变化 → 宽松映射保底） */
function mapAkFundamentalRow(row: Record<string, unknown>): FundamentalPeriod {
  let period = ''
  for (const key of ['日期', '报告期', 'statDate', 'date']) {
    const value = str(row[key])
    if (value) {
      period = value.slice(0, 10)
      break
    }
  }
  const out: FundamentalPeriod = { period }
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined || value === '') continue
    const n = toNum(value)
    if (n !== undefined && typeof value !== 'string') {
      out[key] = n
    } else if (n !== undefined && /^[-+]?[\d.,%\s]+$/.test(value as string)) {
      out[key] = n
    } else if (typeof value === 'string' || typeof value === 'number') {
      out[key] = value
    }
  }
  return out
}

/** akshare 快照 items → 主数据行（screenBase / symbolMaster 的 Py 兜底） */
function mapPySymbolRows(raw: unknown): SymbolMasterRow[] {
  const items = ((raw ?? {}) as { items?: PyQuoteItem[] }).items ?? []
  const out: SymbolMasterRow[] = []
  for (const item of items) {
    const code = str(item.code)
    const name = str(item.name)
    if (!/^\d{6}$/.test(code) || !name) continue
    const type = inferAssetType(code) ?? 'stock'
    const exchange = inferExchange(code, type)
    out.push({ code, name, type, ...(exchange ? { exchange } : {}) })
  }
  if (out.length === 0) throw new GatewayError('akshare 列表返回为空')
  return out
}

/** akshare 快照 items → 筛选底表行（含行情列；screenBase 的 Py 兜底） */
function mapPyScreenRows(raw: unknown): ScreenRow[] {
  const items = ((raw ?? {}) as { items?: PyQuoteItem[] }).items ?? []
  const out: ScreenRow[] = []
  for (const item of items) {
    const code = str(item.code)
    const name = str(item.name)
    if (!/^\d{6}$/.test(code) || !name) continue
    const type = inferAssetType(code) ?? 'stock'
    const exchange = inferExchange(code, type)
    const row: ScreenRow = { code, name, type, ...(exchange ? { exchange } : {}) }
    const put = (key: keyof ScreenRow, value: unknown): void => {
      const n = toNum(value)
      if (n !== undefined) (row as unknown as Record<string, number>)[key] = n
    }
    put('price', item.price)
    put('changePct', item.changePct)
    put('volume', item.volume)
    put('turnover', item.turnover)
    put('turnoverRate', item.turnoverRate)
    put('pe', item.pe)
    put('pb', item.pb)
    put('marketCap', item.marketCap)
    put('floatMarketCap', item.floatMarketCap)
    out.push(row)
  }
  if (out.length === 0) throw new GatewayError('akshare 列表返回为空')
  return out
}

/** 本地主数据匹配（代码精确 / 前缀；名称精确 / 包含） */
function matchRows(rows: SymbolMasterRow[], query: string, limit: number): SymbolMasterRow[] {
  const q = query.trim()
  if (!q) return []
  const scored: Array<{ row: SymbolMasterRow; score: number }> = []
  for (const row of rows) {
    let score = -1
    if (row.code === q) score = 0
    else if (row.code.startsWith(q)) score = 1
    else if (row.name === q) score = 2
    else if (row.name.includes(q)) score = 3
    else if (row.code.includes(q)) score = 4
    if (score >= 0) scored.push({ row, score })
  }
  scored.sort((a, b) => a.score - b.score || a.row.code.localeCompare(b.row.code))
  return scored.slice(0, limit).map((s) => s.row)
}

/** 北京时间年份（交易日历默认区间用） */
function cnYear(date: Date): number {
  return new Date(date.getTime() + CN_TZ_OFFSET_MS).getUTCFullYear()
}

export function createFinanceGateway(deps: GatewayDeps): FinanceGateway {
  const cfg: GatewayCfg = deps.cfg ?? {}
  const nowFn = deps.now ?? ((): Date => new Date())
  const cache = createFinanceCache(deps.db)
  const healthMap = new Map<string, HealthState>()
  let lastProbeJson = ''
  let lastHealthJson = ''

  const pyStatusFn = deps.pyStatus ?? (async (): Promise<PyAvailability> => {
    const status = await probePython(cfg.python ? { python: cfg.python } : {})
    // finance_meta 落库（探测结果变化时写入；重启后可复用展示）
    const json = JSON.stringify(status)
    if (json !== lastProbeJson) {
      lastProbeJson = json
      cache.metaSet('py_probe', status)
    }
    return status.level
  })
  const runPyFn =
    deps.runPy ??
    (async (task: string, params: Record<string, unknown>): Promise<unknown> => {
      const res = await runBridge<unknown>(task, params, {
        ...(cfg.python ? { python: cfg.python } : {}),
        ...(cfg.pyTimeoutMs ? { timeoutMs: cfg.pyTimeoutMs } : {}),
      })
      return res.data
    })

  /** Node 源上下文（注入 Fetcher / 限速） */
  function sourceCtx(): SourceCtx {
    const ctx: SourceCtx = {}
    if (deps.fetcher) ctx.fetcher = deps.fetcher
    if (cfg.minIntervalMs && cfg.minIntervalMs > 0) ctx.minIntervalMs = cfg.minIntervalMs
    return ctx
  }

  // ---------- 健康度 ----------

  function isCooling(label: string): boolean {
    const state = healthMap.get(label)
    return !!state && state.coolingUntil > nowFn().getTime()
  }

  function sourceOk(label: string): void {
    healthMap.delete(label)
  }

  function sourceFail(label: string, message: string): void {
    const state = healthMap.get(label) ?? { fails: 0, coolingUntil: 0 }
    state.fails += 1
    state.lastError = message.slice(0, 200)
    if (state.fails >= FAIL_THRESHOLD) {
      state.coolingUntil = nowFn().getTime() + COOLDOWN_MS
    }
    healthMap.set(label, state)
  }

  // ---------- 降级链编排 ----------

  async function runChain<T>(
    steps: ChainStep<T>[],
    capability: string,
    pref: SourcePref,
    pyAvail: PyAvailability,
    opts: { asOfOf?: (data: T) => string } = {},
  ): Promise<GatewayResult<T>> {
    let candidates = steps.filter((s) => pref === 'auto' || s.layer === pref)
    if (candidates.length === 0) {
      if (pref === 'py') throw new GatewayError(`${capability} 无 Python 数据源（source=py 不可用，改用 auto）`)
      if (pref === 'node') throw new GatewayError(`${capability} 无 Node 数据源（source=node 不可用，改用 auto）`)
      throw new GatewayError(`${capability} 无可用数据源`)
    }
    if (pref === 'py' && pyAvail === 'absent') {
      throw new GatewayError(`${capability} 需要 Python 环境（探测 absent：安装依赖或改用 source=auto）`)
    }
    if (pref === 'auto' && pyAvail === 'absent') {
      candidates = candidates.filter((s) => s.layer !== 'py')
      if (candidates.length === 0) throw new GatewayError(`${capability} 仅 Python 数据源，但 Python 环境缺失`)
    }
    // 冷却跳过节流（反爬联动：全部冷却时仍按序尝试，避免无源可用）
    const cooling = candidates.filter((s) => isCooling(s.label))
    let skippedNote = ''
    if (cooling.length > 0 && cooling.length < candidates.length) {
      candidates = candidates.filter((s) => !isCooling(s.label))
      skippedNote = `冷却期跳过：${cooling.map((s) => s.label).join('、')}`
    }
    const failures: string[] = []
    for (const step of candidates) {
      try {
        const data = await step.run()
        sourceOk(step.label)
        const notes = [...failures, ...(skippedNote ? [skippedNote] : [])]
        return {
          data,
          source: step.label,
          asOf: opts.asOfOf?.(data) ?? nowFn().toISOString(),
          cache: 'miss',
          ...(notes.length > 0 ? { degraded: notes.join('；') } : {}),
        }
      } catch (err) {
        const message = errorMessage(err)
        sourceFail(step.label, message)
        failures.push(`${step.label}：${message}`)
      }
    }
    throw new GatewayError(`${capability} 全部数据源失败——${failures.join('；')}`)
  }

  // ---------- 能力实现 ----------

  function orderQuotes(syms: FinSymbol[], quotes: Quote[]): Quote[] {
    const byKey = new Map(quotes.map((q) => [q.symbol, q]))
    const out: Quote[] = []
    const used = new Set<string>()
    for (const sym of syms) {
      const hit = byKey.get(sym.symbol)
      if (hit) {
        out.push(hit)
        used.add(sym.symbol)
      }
    }
    for (const quote of quotes) if (!used.has(quote.symbol)) out.push(quote)
    return out
  }

  function quoteSource(quotes: Quote[]): string {
    const set = new Set(quotes.map((q) => q.source))
    return [...set].join('+') || 'n/a'
  }

  function latestAsOf(items: Array<{ asOf?: string }>, fallback: string): string {
    let best = ''
    for (const item of items) if (item.asOf && item.asOf > best) best = item.asOf
    return best || fallback
  }

  async function quote(
    syms: FinSymbol[],
    opts: { source?: SourcePref } = {},
  ): Promise<GatewayResult<Quote[]>> {
    const pref = opts.source ?? 'auto'
    const time = nowFn()
    if (syms.length === 0) {
      return { data: [], source: 'n/a', asOf: time.toISOString(), cache: 'hit' }
    }
    const cached = cache.quoteGetMany(syms.map((s) => s.symbol), time)
    const freshHits: Quote[] = []
    const staleHits: Quote[] = []
    const misses: FinSymbol[] = []
    for (const sym of syms) {
      const hit = cached.get(sym.symbol)
      if (hit?.fresh) freshHits.push(hit.quote)
      else {
        misses.push(sym)
        if (hit) staleHits.push(hit.quote)
      }
    }
    if (misses.length === 0) {
      return {
        data: orderQuotes(syms, freshHits),
        source: quoteSource(freshHits),
        asOf: latestAsOf(freshHits, time.toISOString()),
        cache: 'hit',
      }
    }
    const pyAvail = await pyStatusFn()
    const codes = misses.map((s) => s.code)
    const chain: ChainStep<Quote[]>[] = [
      { label: 'eastmoney', layer: 'node', run: () => emFetchQuotes(misses, sourceCtx()) },
      { label: 'tencent', layer: 'node', run: () => tencentFetchQuotes(misses, sourceCtx()) },
      { label: 'sina', layer: 'node', run: () => sinaFetchQuotes(misses, sourceCtx()) },
      {
        label: 'akshare',
        layer: 'py',
        run: async () => mapPyQuotes(await runPyFn('quote', { codes }), nowFn().toISOString()),
      },
    ]
    try {
      const res = await runChain(chain, '实时快照', pref, pyAvail)
      for (const q of res.data) cache.quotePut(q, time)
      return { ...res, data: orderQuotes(syms, [...freshHits, ...res.data]) }
    } catch (err) {
      const fallback = orderQuotes(syms, [...freshHits, ...staleHits])
      if (fallback.length > 0) {
        return {
          data: fallback,
          source: quoteSource(fallback),
          asOf: latestAsOf(fallback, time.toISOString()),
          cache: 'stale',
          degraded: `${errorMessage(err)}；返回缓存快照（${fallback.length} 条）`,
        }
      }
      throw err
    }
  }

  async function kline(
    sym: FinSymbol,
    period: Period,
    adjust: Adjust,
    limit = 250,
    opts: { source?: SourcePref } = {},
  ): Promise<GatewayResult<KlineSeries>> {
    const pref = opts.source ?? 'auto'
    const time = nowFn()
    const capped = Math.max(1, Math.min(limit, 500))
    const cached = cache.klineGet(sym.symbol, period, adjust, time)
    if (cached?.fresh) {
      return {
        data: { ...cached.series, bars: cached.series.bars.slice(-capped) },
        source: cached.series.source,
        asOf: cached.series.asOf,
        cache: 'hit',
      }
    }
    const pyAvail = await pyStatusFn()
    const isMinute = period.startsWith('min')
    const akshareStep: ChainStep<KlineSeries> = {
      label: 'akshare',
      layer: 'py',
      run: async () =>
        mapPyKline(
          await runPyFn('kline', { code: sym.symbol, period, adjust, engine: 'akshare' }),
          sym,
          period,
          adjust,
          capped,
          'akshare',
        ),
    }
    const chain: ChainStep<KlineSeries>[] = isMinute
      ? [
          { label: 'eastmoney', layer: 'node', run: () => emFetchKline(sym, period, adjust, capped, sourceCtx()) },
          akshareStep,
        ]
      : [
          {
            label: 'baostock',
            layer: 'py',
            run: async () =>
              mapPyKline(
                await runPyFn('kline', { code: sym.symbol, period, adjust }),
                sym,
                period,
                adjust,
                capped,
                'baostock',
              ),
          },
          { label: 'eastmoney', layer: 'node', run: () => emFetchKline(sym, period, adjust, capped, sourceCtx()) },
          akshareStep,
        ]
    try {
      const res = await runChain(chain, 'K 线', pref, pyAvail, { asOfOf: (series) => series.asOf })
      cache.klinePut(res.data, time)
      return res
    } catch (err) {
      if (cached) {
        return {
          data: { ...cached.series, bars: cached.series.bars.slice(-capped) },
          source: cached.series.source,
          asOf: cached.series.asOf,
          cache: 'stale',
          degraded: `${errorMessage(err)}；返回过期缓存（${cached.series.bars.length} 根）`,
        }
      }
      throw err
    }
  }

  async function indicator(
    name: IndicatorName,
    bars: KlineBar[],
    params: Record<string, number> = {},
    opts: { source?: SourcePref } = {},
  ): Promise<GatewayResult<IndicatorSeries>> {
    const pref = opts.source ?? 'auto'
    if (bars.length === 0) throw new GatewayError('指标计算需要非空 K 线数据')
    const pyAvail = await pyStatusFn()
    const chain: ChainStep<IndicatorSeries>[] = [
      {
        label: 'ta',
        layer: 'py',
        run: async () => {
          const raw = (await runPyFn('indicators', { name, params, bars })) as {
            points?: Array<{ timestamp?: unknown; values?: Record<string, number | null> }>
          }
          const points = (raw?.points ?? [])
            .map((p) => {
              const ts = toNum(p.timestamp)
              if (ts === undefined) return undefined
              return { timestamp: ts, values: p.values ?? {} }
            })
            .filter((p): p is { timestamp: number; values: Record<string, number | null> } => p !== undefined)
          if (points.length === 0) throw new GatewayError('ta 指标返回为空')
          // signals 统一走 Node 纯计算（本地零成本，口径与兜底一致）
          const signals = computeIndicator(name, bars, params).signals
          return { name, params: { ...params }, points, signals }
        },
      },
      {
        label: 'node-indicator',
        layer: 'node',
        run: async () => computeIndicator(name, bars, params),
      },
    ]
    return runChain(chain, `指标 ${name}`, pref, pyAvail)
  }

  async function fundamental(
    sym: FinSymbol,
    opts: { year?: number; quarter?: number; source?: SourcePref } = {},
  ): Promise<GatewayResult<FundamentalSeries>> {
    const pref = opts.source ?? 'auto'
    const pyAvail = await pyStatusFn()
    const nowIso = nowFn().toISOString()
    const chain: ChainStep<FundamentalSeries>[] = [
      {
        label: 'baostock',
        layer: 'py',
        run: async () => {
          const raw = (await runPyFn('fundamentals', {
            code: sym.symbol,
            ...(opts.year ? { year: opts.year } : {}),
            ...(opts.quarter ? { quarter: opts.quarter } : {}),
          })) as { rows?: Array<Record<string, unknown>> }
          const periods = (raw?.rows ?? []).map(mapBsProfitRow).filter((p) => p.period)
          if (periods.length === 0) throw new GatewayError('baostock 财务返回为空')
          return {
            symbol: sym.symbol,
            name: sym.name ?? sym.code,
            periods,
            source: 'baostock',
            asOf: nowIso,
          }
        },
      },
      {
        label: 'akshare',
        layer: 'py',
        run: async () => {
          const raw = (await runPyFn('fundamentals', { code: sym.symbol, engine: 'akshare' })) as {
            rows?: Array<Record<string, unknown>>
          }
          const periods = (raw?.rows ?? []).map(mapAkFundamentalRow)
          if (periods.length === 0) throw new GatewayError('akshare 财务返回为空')
          return {
            symbol: sym.symbol,
            name: sym.name ?? sym.code,
            periods,
            source: 'akshare',
            asOf: nowIso,
          }
        },
      },
    ]
    return runChain(chain, '财务数据', pref, pyAvail)
  }

  async function calendar(
    opts: { year?: number; start?: string; end?: string; source?: SourcePref } = {},
  ): Promise<GatewayResult<{ start: string; end: string; days: string[] }>> {
    const pref = opts.source ?? 'auto'
    const time = nowFn()
    const year = opts.year ?? cnYear(time)
    const start = opts.start ?? `${year}-01-01`
    const end = opts.end ?? `${year}-12-31`
    const metaKey = `trade_calendar:${start}:${end}`
    const hit = cache.metaGet<{ days: string[]; source: string }>(metaKey)
    if (hit && ageFresh(hit.updatedAt, CALENDAR_TTL_MS, time) && hit.value.days.length > 0) {
      return {
        data: { start, end, days: hit.value.days },
        source: hit.value.source,
        asOf: hit.updatedAt,
        cache: 'hit',
      }
    }
    const pyAvail = await pyStatusFn()
    const chain: ChainStep<{ start: string; end: string; days: string[] }>[] = [
      {
        label: 'baostock',
        layer: 'py',
        run: async () => {
          const raw = (await runPyFn('calendar', { start, end })) as { days?: string[] }
          if (!Array.isArray(raw?.days) || raw.days.length === 0) throw new GatewayError('baostock 交易日历为空')
          return { start, end, days: raw.days }
        },
      },
      {
        label: 'akshare',
        layer: 'py',
        run: async () => {
          const raw = (await runPyFn('calendar', { start, end, engine: 'akshare' })) as { days?: string[] }
          if (!Array.isArray(raw?.days) || raw.days.length === 0) throw new GatewayError('akshare 交易日历为空')
          return { start, end, days: raw.days }
        },
      },
    ]
    try {
      const res = await runChain(chain, '交易日历', pref, pyAvail)
      cache.metaSet(metaKey, { days: res.data.days, source: res.source }, time)
      return res
    } catch (err) {
      if (hit && hit.value.days.length > 0) {
        return {
          data: { start, end, days: hit.value.days },
          source: hit.value.source,
          asOf: hit.updatedAt,
          cache: 'stale',
          degraded: `${errorMessage(err)}；返回过期交易日历缓存`,
        }
      }
      throw err
    }
  }

  async function fundProfile(
    code: string,
    kind: 'etf' | 'fund',
    opts: { source?: SourcePref } = {},
  ): Promise<GatewayResult<FundProfile>> {
    const pref = opts.source ?? 'auto'
    const pyAvail = await pyStatusFn()
    const nowIso = nowFn().toISOString()
    const chain: ChainStep<FundProfile>[] = [
      {
        label: 'eastmoney-fund',
        layer: 'node',
        run: async () => {
          const info = await fetchFundBasic(code, sourceCtx())
          const returns = computeNavReturns(info.navTrend)
          const profile: FundProfile = {
            code,
            name: info.name || code,
            kind,
            source: 'eastmoney-fund',
            asOf: nowIso,
          }
          if (info.feeRate !== undefined) profile.feeRate = info.feeRate
          if (Object.keys(returns).length > 0) profile.returns = returns
          return profile
        },
      },
      {
        label: 'akshare',
        layer: 'py',
        run: async () => {
          const raw = await runPyFn('fund_profile', { code })
          const points = mapPyNavPoints(raw)
          if (points.length === 0) throw new GatewayError('akshare 基金数据为空')
          const returns = computeNavReturns(points)
          const profile: FundProfile = { code, name: code, kind, source: 'akshare', asOf: nowIso }
          if (Object.keys(returns).length > 0) profile.returns = returns
          return profile
        },
      },
    ]
    return runChain(chain, '基金档案', pref, pyAvail)
  }

  async function fundNav(
    code: string,
    limit = 250,
    opts: { source?: SourcePref } = {},
  ): Promise<GatewayResult<FundNavSeries>> {
    const pref = opts.source ?? 'auto'
    const capped = Math.max(1, Math.min(limit, 500))
    const pyAvail = await pyStatusFn()
    const chain: ChainStep<FundNavSeries>[] = [
      {
        label: 'eastmoney-fund',
        layer: 'node',
        run: () => fetchFundNav(code, capped, sourceCtx()),
      },
      {
        label: 'akshare',
        layer: 'py',
        run: async () => {
          const raw = await runPyFn('fund_profile', { code })
          const points = mapPyNavPoints(raw).slice(-capped)
          if (points.length === 0) throw new GatewayError('akshare 基金净值返回为空')
          return { code, name: code, points, source: 'akshare', asOf: nowFn().toISOString() }
        },
      },
    ]
    return runChain(chain, '基金净值', pref, pyAvail, { asOfOf: (s) => s.asOf })
  }

  async function news(
    opts: { symbol?: string; market?: string; limit?: number; since?: string; source?: SourcePref } = {},
  ): Promise<GatewayResult<NewsItem[]>> {
    const pref = opts.source ?? 'auto'
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50)
    const time = nowFn()
    const symbol = opts.symbol?.trim()
    /** 公告 / akshare 源需 6 位纯代码（调用方可能传 sh600519 等展示形） */
    const noticesCode = symbol ? (/(\d{6})/.exec(symbol)?.[1] ?? symbol) : ''
    const scope = symbol ? 'symbol' : 'market'
    const scopeKey = symbol ?? opts.market ?? 'cn'
    const sinceMs = opts.since ? Date.parse(opts.since) : undefined
    const applyFilter = (items: NewsItem[]): NewsItem[] => {
      let out = items
      if (sinceMs !== undefined && Number.isFinite(sinceMs)) {
        out = out.filter((item) => {
          if (!item.publishedAt) return true
          const ts = Date.parse(item.publishedAt.replace(' ', 'T'))
          return Number.isFinite(ts) ? ts >= sinceMs : true
        })
      }
      return dedupeNews(out).slice(0, limit)
    }
    const fresh = cache.newsGetFresh(scope, scopeKey, time)
    if (fresh.length >= limit) {
      return {
        data: applyFilter(fresh),
        source: 'cache',
        asOf: time.toISOString(),
        cache: 'hit',
      }
    }
    const pyAvail = await pyStatusFn()
    const chain: ChainStep<NewsItem[]>[] = symbol
      ? [
          { label: 'eastmoney', layer: 'node', run: () => fetchNotices(noticesCode, limit, sourceCtx()) },
          { label: 'akshare', layer: 'py', run: async () => mapPyNews(await runPyFn('news', { code: noticesCode, limit })) },
        ]
      : [{ label: 'sina', layer: 'node', run: () => fetchMarketNews(limit, sourceCtx()) }]
    try {
      const res = await runChain(chain, '新闻公告', pref, pyAvail)
      if (res.data.length > 0) cache.newsPut(scope, scopeKey, res.data, time)
      return { ...res, data: applyFilter([...fresh, ...res.data]) }
    } catch (err) {
      const all = cache.newsGetAll(scope, scopeKey)
      if (all.length > 0) {
        const sourceSet = [...new Set(all.map((n) => n.source))].join('+')
        return {
          data: applyFilter(all),
          source: sourceSet || 'cache',
          asOf: time.toISOString(),
          cache: 'stale',
          degraded: `${errorMessage(err)}；返回过期新闻缓存（${all.length} 条）`,
        }
      }
      throw err
    }
  }

  async function loadSymbolList(
    metaKey: string,
    ttlMs: number,
    capability: string,
    pref: SourcePref,
  ): Promise<GatewayResult<SymbolMasterRow[]>> {
    const time = nowFn()
    const hit = cache.metaGet<{ rows: SymbolMasterRow[]; source: string }>(metaKey)
    if (hit && ageFresh(hit.updatedAt, ttlMs, time) && hit.value.rows.length > 0) {
      return { data: hit.value.rows, source: hit.value.source, asOf: hit.updatedAt, cache: 'hit' }
    }
    const pyAvail = await pyStatusFn()
    const chain: ChainStep<SymbolMasterRow[]>[] = [
      { label: 'eastmoney', layer: 'node', run: () => fetchSymbolList(sourceCtx()) },
      { label: 'akshare', layer: 'py', run: async () => mapPySymbolRows(await runPyFn('quote', { all: true })) },
    ]
    try {
      const res = await runChain(chain, capability, pref, pyAvail)
      cache.metaSet(metaKey, { rows: res.data, source: res.source }, time)
      return res
    } catch (err) {
      if (hit && hit.value.rows.length > 0) {
        return {
          data: hit.value.rows,
          source: hit.value.source,
          asOf: hit.updatedAt,
          cache: 'stale',
          degraded: `${errorMessage(err)}；返回过期主数据（${hit.value.rows.length} 行）`,
        }
      }
      throw err
    }
  }

  async function loadScreenBase(pref: SourcePref): Promise<GatewayResult<ScreenRow[]>> {
    const time = nowFn()
    const hit = cache.metaGet<{ rows: ScreenRow[]; source: string }>('screen_base')
    if (hit && ageFresh(hit.updatedAt, SCREEN_BASE_TTL_MS, time) && hit.value.rows.length > 0) {
      return { data: hit.value.rows, source: hit.value.source, asOf: hit.updatedAt, cache: 'hit' }
    }
    const pyAvail = await pyStatusFn()
    const chain: ChainStep<ScreenRow[]>[] = [
      { label: 'eastmoney', layer: 'node', run: () => fetchScreenRows(sourceCtx()) },
      { label: 'akshare', layer: 'py', run: async () => mapPyScreenRows(await runPyFn('quote', { all: true })) },
    ]
    try {
      const res = await runChain(chain, '筛选底表', pref, pyAvail)
      cache.metaSet('screen_base', { rows: res.data, source: res.source }, time)
      return res
    } catch (err) {
      if (hit && hit.value.rows.length > 0) {
        return {
          data: hit.value.rows,
          source: hit.value.source,
          asOf: hit.updatedAt,
          cache: 'stale',
          degraded: `${errorMessage(err)}；返回过期筛选底表（${hit.value.rows.length} 行）`,
        }
      }
      throw err
    }
  }

  async function search(
    query: string,
    opts: { limit?: number; source?: SourcePref } = {},
  ): Promise<GatewayResult<SymbolMasterRow[]>> {
    const q = query.trim()
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50)
    const time = nowFn()
    const pref = opts.source ?? 'auto'
    if (!q) return { data: [], source: 'local', asOf: time.toISOString(), cache: 'hit' }
    let rows: SymbolMasterRow[] = []
    let degraded: string | undefined
    try {
      const master = await loadSymbolList('symbol_master', SYMBOL_MASTER_TTL_MS, '证券主数据', pref)
      rows = matchRows(master.data, q, limit)
    } catch (err) {
      degraded = `本地主数据不可用：${errorMessage(err)}`
    }
    if (rows.length === 0) {
      try {
        // 在线补充（东财 suggest：支持拼音首字母；失败静默——搜索为增强能力）
        const online = await searchSymbols(q, sourceCtx())
        if (online.length > 0) {
          return {
            data: matchRows(online, q, limit).length > 0 ? matchRows(online, q, limit) : online.slice(0, limit),
            source: 'eastmoney-suggest',
            asOf: time.toISOString(),
            cache: 'miss',
          }
        }
      } catch {
        // suggest 失败不影响本地结果
      }
    }
    return {
      data: rows,
      source: 'local',
      asOf: time.toISOString(),
      cache: rows.length > 0 ? 'hit' : 'miss',
      ...(degraded ? { degraded } : {}),
    }
  }

  return {
    quote,
    kline,
    indicator,
    fundamental,
    calendar,
    fundProfile,
    fundNav,
    news,
    symbolMaster: (opts = {}) =>
      loadSymbolList('symbol_master', SYMBOL_MASTER_TTL_MS, '证券主数据', opts.source ?? 'auto'),
    screenBase: (opts = {}) => loadScreenBase(opts.source ?? 'auto'),
    search,
    health(): GatewayHealth[] {
      const time = nowFn().getTime()
      const out: GatewayHealth[] = []
      for (const [source, state] of healthMap.entries()) {
        const item: GatewayHealth = {
          source,
          fails: state.fails,
          cooling: state.coolingUntil > time,
        }
        if (state.coolingUntil > time) item.cooldownUntil = new Date(state.coolingUntil).toISOString()
        if (state.lastError) item.lastError = state.lastError
        out.push(item)
      }
      // finance_meta 懒持久化（内容变化时写入；供设置面板 / fin_env 重启后参考）
      const json = JSON.stringify(out)
      if (json !== lastHealthJson) {
        lastHealthJson = json
        cache.metaSet('source_health', out)
      }
      return out
    },
    resetHealth(): void {
      healthMap.clear()
      lastHealthJson = ''
    },
  }
}
