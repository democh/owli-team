/**
 * 东财源适配器（M34 §3.1，主干源）。
 *
 * 接口（实施时逐个实测验证；解析函数为纯函数，fixture 回放测试）：
 *   - 批量快照：push2.eastmoney.com/api/qt/ulist.np/get（secids 批量，fltt=2 浮点）
 *   - K 线：push2his.eastmoney.com/api/qt/stock/kline/get（klt/fqt/fields2）
 *   - 全市场列表：push2.eastmoney.com/api/qt/clist/get（fs 过滤段；股票 / ETF 两请求）
 *   - 搜索建议：searchapi.eastmoney.com/api/suggest/get（支持代码 / 名称 / 拼音）
 *
 * 约束：不直接 fetch，统一走注入 Fetcher（默认 antiBotFetch）；解析失败抛错由网关降级。
 */
import type { Exchange, FinSymbol, SymbolMasterRow } from '../symbol.js'
import { inferAssetType, inferExchange, parseSymbol } from '../symbol.js'
import {
  adjustToEastmoneyFqt,
  parseCnDate,
  periodToEastmoneyKlt,
  type Adjust,
  type Period,
} from '../period.js'
import type { KlineBar, KlineSeries, Quote, ScreenRow } from '../types.js'
import { chunk, num, parseJsonLoose, resolveFetcher, str, type SourceCtx } from '../fetcher.js'

const PUSH2 = 'https://push2.eastmoney.com'
const PUSH2HIS = 'https://push2his.eastmoney.com'
const SUGGEST = 'https://searchapi.eastmoney.com'

/** 快照字段（f2 最新价 … f23 市净率） */
const QUOTE_FIELDS = 'f1,f2,f3,f4,f5,f6,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23'

/** 全市场列表 fs 过滤段（实施时实测校准；股票：沪深京 A；ETF：场内基金） */
export const CLIST_FS_STOCK = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048'
export const CLIST_FS_ETF = 'b:MK0021,b:MK0022,b:MK0023,b:MK0024'

interface EmDiffRaw {
  f2?: unknown
  f3?: unknown
  f4?: unknown
  f5?: unknown
  f6?: unknown
  f8?: unknown
  f9?: unknown
  f10?: unknown
  f12?: unknown
  f13?: unknown
  f14?: unknown
  f15?: unknown
  f16?: unknown
  f17?: unknown
  f18?: unknown
  f20?: unknown
  f21?: unknown
  f23?: unknown
  code?: unknown
  name?: unknown
  market?: unknown
}

interface EmUlistPayload {
  data?: { diff?: EmDiffRaw[] | Record<string, EmDiffRaw> }
}

interface EmKlinePayload {
  data?: {
    code?: string
    name?: string
    klines?: string[]
  }
}

interface EmClistPayload {
  data?: { total?: number; diff?: EmDiffRaw[] | Record<string, EmDiffRaw> }
}

interface EmSuggestPayload {
  QuotationCodeTable?: { Data?: Array<Record<string, unknown>> }
}

/** 沪市 secid 前缀 = 1，其余（深/北）= 0 */
function secidOf(sym: FinSymbol): string {
  return sym.secid ?? `${sym.exchange === 'sh' ? '1' : '0'}.${sym.code}`
}

/** diff 字段容器归一（东财有时返回数组、有时返回索引对象） */
function diffRows(diff: EmDiffRaw[] | Record<string, EmDiffRaw> | undefined): EmDiffRaw[] {
  if (!diff) return []
  return Array.isArray(diff) ? diff : Object.values(diff)
}

/** 解析 ulist.np 快照 → Quote[]（纯函数） */
export function parseQuotePayload(text: string, asOf = new Date().toISOString()): Quote[] {
  const payload = parseJsonLoose<EmUlistPayload>(text)
  const rows = diffRows(payload.data?.diff)
  const out: Quote[] = []
  for (const row of rows) {
    const code = str(row.f12)
    const name = str(row.f14)
    const price = num(row.f2)
    if (!/^\d{6}$/.test(code) || price === undefined) continue
    const market = num(row.f13) // 1=沪 0=深（北交所亦 0）
    const exchange = market === 1 ? ('sh' as const) : undefined
    const type = inferAssetType(code) ?? 'stock'
    const ex = exchange ?? inferExchange(code, type)
    const prevClose = num(row.f18) ?? 0
    const change = num(row.f4) ?? (prevClose ? price - prevClose : 0)
    const changePct = num(row.f3) ?? (prevClose ? (change / prevClose) * 100 : 0)
    out.push({
      symbol: `${ex ?? ''}${code}`,
      code,
      name,
      price,
      prevClose,
      open: num(row.f17) ?? 0,
      high: num(row.f15) ?? 0,
      low: num(row.f16) ?? 0,
      change,
      changePct,
      volume: num(row.f5) ?? 0,
      turnover: num(row.f6) ?? 0,
      turnoverRate: num(row.f8),
      pe: num(row.f9),
      // f10 量比（未用）；f20 总市值、f21 流通市值（元）
      marketCap: num(row.f20),
      floatMarketCap: num(row.f21),
      pb: num(row.f23),
      asOf,
      source: 'eastmoney',
    })
  }
  return out
}

/** 批量快照（分片请求，secids ≤100/次） */
export async function fetchQuotes(symbols: FinSymbol[], ctx: SourceCtx = {}): Promise<Quote[]> {
  const fetcher = resolveFetcher(ctx)
  const out: Quote[] = []
  for (const group of chunk(symbols, 50)) {
    const secids = group.map(secidOf).join(',')
    const url = `${PUSH2}/api/qt/ulist.np/get?fltt=2&invt=2&fields=${QUOTE_FIELDS}&secids=${secids}`
    const res = await fetcher({
      url,
      accept: 'application/json',
      signal: ctx.signal,
      minIntervalMs: ctx.minIntervalMs,
      timeoutMs: ctx.timeoutMs,
      userAgent: ctx.userAgent,
    })
    out.push(...parseQuotePayload(res.text))
  }
  return out
}

/** 解析 K 线响应 → KlineBar[]（纯函数；列序 = date,open,close,high,low,volume,turnover） */
export function parseKlinePayload(text: string): { name: string; bars: KlineBar[] } {
  const payload = parseJsonLoose<EmKlinePayload>(text)
  const name = str(payload.data?.name)
  const klines = payload.data?.klines
  if (!Array.isArray(klines)) throw new Error('东财 K 线响应缺少 data.klines（接口可能已变更）')
  const bars: KlineBar[] = []
  for (const line of klines) {
    const parts = String(line).split(',')
    if (parts.length < 6) continue
    const ts = parseCnDate(parts[0])
    const open = num(parts[1])
    const close = num(parts[2])
    const high = num(parts[3])
    const low = num(parts[4])
    const volume = num(parts[5])
    if (!Number.isFinite(ts) || open === undefined || close === undefined || high === undefined || low === undefined) {
      continue
    }
    const bar: KlineBar = { timestamp: ts, open, high, low, close, volume: volume ?? 0 }
    const turnover = num(parts[6])
    if (turnover !== undefined) bar.turnover = turnover
    bars.push(bar)
  }
  if (bars.length === 0) throw new Error('东财 K 线响应无有效数据行')
  return { name, bars }
}

/** K 线（日/周/月/分钟；fqt 复权） */
export async function fetchKline(
  sym: FinSymbol,
  period: Period,
  adjust: Adjust,
  limit: number,
  ctx: SourceCtx = {},
): Promise<KlineSeries> {
  const fetcher = resolveFetcher(ctx)
  const params = new URLSearchParams({
    secid: secidOf(sym),
    klt: periodToEastmoneyKlt(period),
    fqt: adjustToEastmoneyFqt(adjust),
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57',
    beg: '0',
    end: '20500101',
    lmt: String(Math.max(1, Math.min(limit, 1_000))),
  })
  const res = await fetcher({
    url: `${PUSH2HIS}/api/qt/stock/kline/get?${params.toString()}`,
    accept: 'application/json',
    signal: ctx.signal,
    minIntervalMs: ctx.minIntervalMs,
    timeoutMs: ctx.timeoutMs,
    userAgent: ctx.userAgent,
  })
  const { name, bars } = parseKlinePayload(res.text)
  return {
    symbol: sym.symbol,
    name: name || sym.name || sym.code,
    period,
    adjust,
    bars,
    source: 'eastmoney',
    asOf: new Date().toISOString(),
  }
}

/** 解析全市场列表（clist）→ 主数据行（纯函数） */
export function parseClistPayload(text: string): SymbolMasterRow[] {
  const payload = parseJsonLoose<EmClistPayload>(text)
  const rows = diffRows(payload.data?.diff)
  const out: SymbolMasterRow[] = []
  for (const row of rows) {
    const code = str(row.f12 ?? row.code)
    const name = str(row.f14 ?? row.name)
    if (!/^\d{6}$/.test(code) || !name) continue
    const type = inferAssetType(code) ?? 'stock'
    const market = num(row.f13 ?? row.market)
    let exchange: Exchange | undefined = market === 1 ? 'sh' : market === 0 ? 'sz' : undefined
    if (type === 'stock' && /^(43|83|87|88|92)/.test(code)) exchange = 'bj'
    if (!exchange) exchange = inferExchange(code, type)
    out.push({ code, name, type, exchange })
  }
  return out
}

/** 全市场列表（股票 + ETF 两请求合并；每类分页 ≤5000 一条请求，po/np 控制排序） */
export async function fetchSymbolList(ctx: SourceCtx = {}): Promise<SymbolMasterRow[]> {
  const fetcher = resolveFetcher(ctx)
  const out: SymbolMasterRow[] = []
  for (const fs of [CLIST_FS_STOCK, CLIST_FS_ETF]) {
    const params = new URLSearchParams({
      pn: '1',
      pz: '6000',
      po: '0',
      np: '1',
      fltt: '2',
      invt: '2',
      fid: 'f12',
      fs,
      fields: 'f12,f13,f14',
    })
    const res = await fetcher({
      url: `${PUSH2}/api/qt/clist/get?${params.toString()}`,
      accept: 'application/json',
      signal: ctx.signal,
      minIntervalMs: ctx.minIntervalMs,
      timeoutMs: ctx.timeoutMs,
      userAgent: ctx.userAgent,
    })
    out.push(...parseClistPayload(res.text))
  }
  if (out.length === 0) throw new Error('东财全市场列表为空（接口可能已变更或被限流）')
  return out
}

/** 筛选底表行情列（f2 最新价 … f23 市净率） */
const SCREEN_COLS = 'f2,f3,f5,f6,f8,f9,f12,f13,f14,f20,f21,f23'

/** 解析筛选底表（clist 行情列）→ ScreenRow[]（纯函数；缺列自动跳过） */
export function parseScreenPayload(text: string): ScreenRow[] {
  const payload = parseJsonLoose<EmClistPayload>(text)
  const rows = diffRows(payload.data?.diff)
  const out: ScreenRow[] = []
  for (const row of rows) {
    const code = str(row.f12 ?? row.code)
    const name = str(row.f14 ?? row.name)
    if (!/^\d{6}$/.test(code) || !name) continue
    const type = inferAssetType(code) ?? 'stock'
    const market = num(row.f13 ?? row.market)
    let exchange: Exchange | undefined = market === 1 ? 'sh' : market === 0 ? 'sz' : undefined
    if (type === 'stock' && /^(43|83|87|88|92)/.test(code)) exchange = 'bj'
    if (!exchange) exchange = inferExchange(code, type)
    const item: ScreenRow = { code, name, type, ...(exchange ? { exchange } : {}) }
    const put = (key: keyof ScreenRow, value: unknown): void => {
      const n = num(value)
      if (n !== undefined) (item as unknown as Record<string, number>)[key] = n
    }
    put('price', row.f2)
    put('changePct', row.f3)
    put('volume', row.f5)
    put('turnover', row.f6)
    put('turnoverRate', row.f8)
    put('pe', row.f9)
    put('marketCap', row.f20)
    put('floatMarketCap', row.f21)
    put('pb', row.f23)
    out.push(item)
  }
  return out
}

/** 筛选底表（股票 + ETF 两请求合并，含行情列；一次拉全，网关缓存 10 分钟） */
export async function fetchScreenRows(ctx: SourceCtx = {}): Promise<ScreenRow[]> {
  const fetcher = resolveFetcher(ctx)
  const out: ScreenRow[] = []
  for (const fs of [CLIST_FS_STOCK, CLIST_FS_ETF]) {
    const params = new URLSearchParams({
      pn: '1',
      pz: '6000',
      po: '0',
      np: '1',
      fltt: '2',
      invt: '2',
      fid: 'f12',
      fs,
      fields: SCREEN_COLS,
    })
    const res = await fetcher({
      url: `${PUSH2}/api/qt/clist/get?${params.toString()}`,
      accept: 'application/json',
      signal: ctx.signal,
      minIntervalMs: ctx.minIntervalMs,
      timeoutMs: ctx.timeoutMs,
      userAgent: ctx.userAgent,
    })
    out.push(...parseScreenPayload(res.text))
  }
  if (out.length === 0) throw new Error('东财筛选底表为空（接口可能已变更或被限流）')
  return out
}

/** 解析搜索建议（suggest）→ 候选行（纯函数） */
export function parseSuggestPayload(text: string): SymbolMasterRow[] {
  const payload = parseJsonLoose<EmSuggestPayload>(text)
  const data = payload.QuotationCodeTable?.Data
  if (!Array.isArray(data)) return []
  const out: SymbolMasterRow[] = []
  for (const raw of data) {
    const code = str(raw.Code)
    const name = str(raw.Name)
    if (!/^\d{6}$/.test(code) || !name) continue // 仅 A 股体系（排除港美股）
    const stName = str(raw.SecurityTypeName)
    const classify = str(raw.Classify)
    const mkt = str(raw.MktNum)
    let type: SymbolMasterRow['type']
    if (/指数/.test(stName) || classify === 'Index') type = 'index'
    else if (/基金/.test(stName) || classify === 'Fund') type = inferAssetType(code) === 'etf' ? 'etf' : 'fund'
    else type = inferAssetType(code) ?? 'stock'
    if (type === 'stock' && /^(43|83|87|88|92)/.test(code)) {
      out.push({ code, name, type, exchange: 'bj' })
      continue
    }
    const exchange = mkt === '1' ? ('sh' as const) : inferExchange(code, type)
    out.push({ code, name, type, exchange })
  }
  // 去重（同 code+type）
  const seen = new Set<string>()
  return out.filter((row) => {
    const key = `${row.type}:${row.code}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 搜索（代码 / 名称 / 拼音首字母；token 为东财前端公开常量） */
export async function searchSymbols(query: string, ctx: SourceCtx = {}): Promise<SymbolMasterRow[]> {
  const fetcher = resolveFetcher(ctx)
  const params = new URLSearchParams({
    input: query,
    type: '14',
    count: '10',
    token: 'D43BF722C8E33BDC906FB84D85E326E8',
  })
  const res = await fetcher({
    url: `${SUGGEST}/api/suggest/get?${params.toString()}`,
    accept: 'application/json',
    signal: ctx.signal,
    minIntervalMs: ctx.minIntervalMs,
    timeoutMs: ctx.timeoutMs,
    userAgent: ctx.userAgent,
  })
  return parseSuggestPayload(res.text)
}

/** 便捷：解析单标的（东财 secid 直查；网关用于校验代码存在性） */
export async function resolveViaQuote(sym: FinSymbol, ctx: SourceCtx = {}): Promise<Quote | undefined> {
  const quotes = await fetchQuotes([sym], ctx)
  return quotes[0]
}

export { parseSymbol }
