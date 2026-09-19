/**
 * 天天基金源适配器（M34 §3.1）：场外基金净值 / 基础信息（Node 备源）。
 *
 * 接口：
 *   - 历史净值：api.fund.eastmoney.com/f10/lsjz（需 Referer: http://fundf10.eastmoney.com/）
 *   - 净值走势 / 名称 / 费率 / 规模：fund.eastmoney.com/pingzhongdata/<code>.js（JS 变量提取）
 *   - 基金概况：fundf10.eastmoney.com/jbgk_<code>.html（跟踪标的 / 净资产规模 / 管理费率）
 *   - 十大持仓：fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc（JS 包裹 HTML 表格）
 *   - 分红记录：fundf10.eastmoney.com/fhsp_<code>.html（页面内嵌表格）
 *
 * 档案类字段（规模 / 持仓 / 分红 / 跟踪标的）与净值同为 Node 源；akshare（Python 桥）备源。
 * 档案类扩展请求均为 best-effort，单点失败不阻断基金档案主流程。
 */
import { parseCnDate, CN_TZ_OFFSET_MS } from '../period.js'
import type { FundNavPoint, FundNavSeries } from '../types.js'
import { num, parseJsonLoose, resolveFetcher, str, type SourceCtx } from '../fetcher.js'

const LSJZ = 'https://api.fund.eastmoney.com'
const PINGZHONG = 'https://fund.eastmoney.com'
const FUNDF10 = 'https://fundf10.eastmoney.com'
const REFERER = 'http://fundf10.eastmoney.com/'
/** pingzhongdata 实测 ~760KB（含全量净值趋势与规模序列），默认 512KB 上限会误判 too-large */
export const PINGZHONG_MAX_BYTES = 2 * 1024 * 1024
/** jbgk / fhsp 档案页实测 45-55KB；512KB 留一倍余量 */
const ARCHIVE_MAX_BYTES = 512 * 1024

interface LsjzPayload {
  Data?: { LSJZList?: Array<Record<string, unknown>> }
  ErrCode?: number
  ErrMsg?: string
}

/** 解析 f10/lsjz 历史净值（纯函数；倒序列表，返回按时间升序） */
export function parseLsJzPayload(text: string): FundNavPoint[] {
  const payload = parseJsonLoose<LsjzPayload>(text)
  const list = payload.Data?.LSJZList
  if (!Array.isArray(list)) {
    throw new Error(`天天基金净值响应异常（ErrCode=${payload.ErrCode ?? '?'} ${payload.ErrMsg ?? ''}）`)
  }
  const out: FundNavPoint[] = []
  for (const row of list) {
    const date = str(row.FSRQ)
    const nav = num(row.DWJZ)
    const ts = parseCnDate(date)
    if (!Number.isFinite(ts) || nav === undefined) continue
    const point: FundNavPoint = { timestamp: ts, nav }
    const cumNav = num(row.LJJZ)
    if (cumNav !== undefined) point.cumNav = cumNav
    const pct = num(row.JZZZL)
    if (pct !== undefined) point.changePct = pct
    out.push(point)
  }
  return out.sort((a, b) => a.timestamp - b.timestamp)
}

/** 历史净值（分页拉取；limit ≤ 500） */
export async function fetchFundNav(code: string, limit: number, ctx: SourceCtx = {}): Promise<FundNavSeries> {
  const fetcher = resolveFetcher(ctx)
  const pageSize = Math.min(Math.max(limit, 1), 200)
  const pages = Math.min(Math.ceil(limit / pageSize), 5)
  const points: FundNavPoint[] = []
  for (let page = 1; page <= pages; page++) {
    const params = new URLSearchParams({ fundCode: code, pageIndex: String(page), pageSize: String(pageSize) })
    const res = await fetcher({
      url: `${LSJZ}/f10/lsjz?${params.toString()}`,
      accept: 'application/json',
      headers: { referer: REFERER },
      signal: ctx.signal,
      minIntervalMs: ctx.minIntervalMs,
      timeoutMs: ctx.timeoutMs,
      userAgent: ctx.userAgent,
    })
    points.push(...parseLsJzPayload(res.text))
    if (points.length >= limit) break
  }
  if (points.length === 0) throw new Error(`基金 ${code} 净值数据为空（代码可能不存在）`)
  const sorted = points.sort((a, b) => a.timestamp - b.timestamp).slice(-limit)
  return {
    code,
    name: code,
    points: sorted,
    source: 'eastmoney-fund',
    asOf: new Date().toISOString(),
  }
}

export interface FundBasicInfo {
  code: string
  name: string
  /** 申购费率 %（pingzhongdata fund_Rate；管理费率以 jbgk 档案为准，网关优先取档案值） */
  feeRate?: number
  /** 规模（亿元；Data_fluctuationScale 最新一期） */
  scale?: number
  /** 净值走势（单位净值；pingzhongdata 自带） */
  navTrend: FundNavPoint[]
  source: string
}

/** 解析 pingzhongdata JS 变量（纯函数：提取 fS_name / fund_Rate / Data_netWorthTrend / Data_fluctuationScale） */
export function parsePingzhongdata(text: string): FundBasicInfo {
  const name = /var\s+fS_name\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? ''
  const feeRate = num(/var\s+fund_Rate\s*=\s*"([^"]+)"/.exec(text)?.[1])
  // 规模序列：{"categories":[...],"series":[{"y":39.38,"mom":"48.93%"}...]} → 取最新一期 y
  let scale: number | undefined
  const scaleRaw = /var\s+Data_fluctuationScale\s*=\s*(\{[\s\S]*?\});/.exec(text)?.[1]
  if (scaleRaw) {
    try {
      const obj = JSON.parse(scaleRaw) as { series?: Array<{ y?: unknown }> }
      const last = obj.series?.[obj.series.length - 1]?.y
      if (typeof last === 'number' && Number.isFinite(last)) scale = last
    } catch {
      // 规模段解析失败不阻断（名称 / 费率 / 净值仍可用）
    }
  }
  const trendRaw = /var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/.exec(text)?.[1]
  const navTrend: FundNavPoint[] = []
  if (trendRaw) {
    try {
      const arr = JSON.parse(trendRaw) as Array<{ x?: number; y?: number; equityReturn?: number }>
      for (const item of arr) {
        const ts = typeof item.x === 'number' ? item.x : Number.NaN
        const nav = typeof item.y === 'number' ? item.y : Number.NaN
        if (!Number.isFinite(ts) || !Number.isFinite(nav)) continue
        const point: FundNavPoint = { timestamp: ts, nav }
        if (typeof item.equityReturn === 'number') point.changePct = item.equityReturn
        navTrend.push(point)
      }
    } catch {
      // 数据段解析失败不阻断（名称与费率仍可用）
    }
  }
  if (!name && navTrend.length === 0) throw new Error('基金基础信息解析失败（pingzhongdata 结构可能已变更）')
  const info: FundBasicInfo = { code: '', name, navTrend, source: 'eastmoney-fund' }
  if (feeRate !== undefined) info.feeRate = feeRate
  if (scale !== undefined) info.scale = scale
  return info
}

/** 基金基础信息（名称 / 费率 / 净值走势） */
export async function fetchFundBasic(code: string, ctx: SourceCtx = {}): Promise<FundBasicInfo> {
  const fetcher = resolveFetcher(ctx)
  const res = await fetcher({
    url: `${PINGZHONG}/pingzhongdata/${code}.js`,
    accept: 'text/javascript,*/*',
    signal: ctx.signal,
    minIntervalMs: ctx.minIntervalMs,
    timeoutMs: ctx.timeoutMs,
    userAgent: ctx.userAgent,
    maxBytes: PINGZHONG_MAX_BYTES,
  })
  const info = parsePingzhongdata(res.text)
  return { ...info, code }
}

export interface FundArchiveInfo {
  /** 跟踪标的（指数基金 / ETF；无跟踪标的时缺省） */
  trackingIndex?: string
  /** 净资产规模（亿元） */
  scale?: number
  /** 管理费率 % */
  feeRate?: number
}

/** HTML 标签剥离 + 空白归一（jbgk/fhsp 表格值清洗） */
function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

/** 解析 jbgk 基金概况页（跟踪标的 / 净资产规模 / 管理费率；纯函数） */
export function parseFundArchive(text: string): FundArchiveInfo {
  const out: FundArchiveInfo = {}
  const track = /<th>\s*跟踪标的\s*<\/th>\s*<td[^>]*>([\s\S]{0,100}?)(?:<\/td>|<th)/.exec(text)?.[1]
  const trackText = track ? stripHtml(track) : ''
  if (trackText && !trackText.includes('无跟踪标的')) out.trackingIndex = trackText
  const scale = num(/<th>\s*净资产规模\s*<\/th>\s*<td[^>]*>\s*([\d,.]+)\s*亿元/.exec(text)?.[1])
  if (scale !== undefined) out.scale = scale
  const feeRate = num(/<th>\s*管理费率\s*<\/th>\s*<td[^>]*>\s*([\d.]+)\s*%/.exec(text)?.[1])
  if (feeRate !== undefined) out.feeRate = feeRate
  return out
}

export interface FundHoldingRow {
  name: string
  code?: string
  weightPct: number
}

/** 解析 jjcc 持仓接口（JS 包裹 HTML；仅取最新一期表格；纯函数） */
export function parseFundHoldings(text: string, topN = 10): FundHoldingRow[] {
  const table = /<table[\s\S]*?<\/table>/.exec(text)?.[0]
  if (!table) return []
  const out: FundHoldingRow[] = []
  for (const row of table.match(/<tr>[\s\S]*?<\/tr>/g) ?? []) {
    const code = /<td><a[^>]*>([A-Za-z0-9.]{2,12})<\/a><\/td>/.exec(row)?.[1]
    const name = /<td class='tol'><a[^>]*>([^<]+)<\/a><\/td>/.exec(row)?.[1]
    const weight = /class='tor'>([\d.]+)%/.exec(row)?.[1]
    if (!code || !name || weight === undefined) continue
    const weightPct = Number(weight)
    if (!Number.isFinite(weightPct)) continue
    out.push({ name: name.trim(), code, weightPct })
    if (out.length >= topN) break
  }
  return out
}

export interface FundDividendRow {
  /** 权益登记日 yyyy-MM-dd */
  date: string
  /** 每份金额（元；由「每10份派现金」折算） */
  amount: number
}

/** 解析 fhsp 分红页（纯函数；每份金额 = 每10份派现金 / 10） */
export function parseFundDividends(text: string, limit = 10): FundDividendRow[] {
  const table = (text.match(/<table[\s\S]*?<\/table>/g) ?? []).find((tb) => tb.includes('权益登记日'))
  if (!table) return []
  const out: FundDividendRow[] = []
  for (const row of table.match(/<tr>[\s\S]*?<\/tr>/g) ?? []) {
    if (row.includes('<th')) continue
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => stripHtml(m[1]))
    const date = cells[1] ?? ''
    const raw = /派现金?\s*([\d.]+)/.exec(cells[3] ?? '')?.[1]
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || raw === undefined) continue
    const amount = Math.round((Number(raw) / 10) * 10_000) / 10_000
    if (!Number.isFinite(amount)) continue
    out.push({ date, amount })
    if (out.length >= limit) break
  }
  return out
}

/** 基金概况（跟踪标的 / 规模 / 管理费率；jbgk 页） */
export async function fetchFundArchive(code: string, ctx: SourceCtx = {}): Promise<FundArchiveInfo> {
  const fetcher = resolveFetcher(ctx)
  const res = await fetcher({
    url: `${FUNDF10}/jbgk_${code}.html`,
    headers: { referer: REFERER },
    signal: ctx.signal,
    minIntervalMs: ctx.minIntervalMs,
    timeoutMs: ctx.timeoutMs,
    userAgent: ctx.userAgent,
    maxBytes: ARCHIVE_MAX_BYTES,
  })
  return parseFundArchive(res.text)
}

/** 十大持仓（jjcc 接口；需 Referer） */
export async function fetchFundHoldings(code: string, ctx: SourceCtx = {}): Promise<FundHoldingRow[]> {
  const fetcher = resolveFetcher(ctx)
  const res = await fetcher({
    url: `${FUNDF10}/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=10&year=&month=`,
    headers: { referer: `${FUNDF10}/ccmx_${code}.html` },
    signal: ctx.signal,
    minIntervalMs: ctx.minIntervalMs,
    timeoutMs: ctx.timeoutMs,
    userAgent: ctx.userAgent,
    maxBytes: ARCHIVE_MAX_BYTES,
  })
  return parseFundHoldings(res.text)
}

/** 分红记录（fhsp 页） */
export async function fetchFundDividends(code: string, ctx: SourceCtx = {}): Promise<FundDividendRow[]> {
  const fetcher = resolveFetcher(ctx)
  const res = await fetcher({
    url: `${FUNDF10}/fhsp_${code}.html`,
    headers: { referer: REFERER },
    signal: ctx.signal,
    minIntervalMs: ctx.minIntervalMs,
    timeoutMs: ctx.timeoutMs,
    userAgent: ctx.userAgent,
    maxBytes: ARCHIVE_MAX_BYTES,
  })
  return parseFundDividends(res.text)
}

/** 由净值序列计算阶段收益 %（近 1/3/6/12 月；按 250 交易日折算） */
export function computeNavReturns(points: FundNavPoint[]): { m1?: number; m3?: number; m6?: number; y1?: number } {
  if (points.length < 2) return {}
  const sorted = [...points].sort((a, b) => a.timestamp - b.timestamp)
  const latest = sorted[sorted.length - 1].nav
  const back = (n: number): number | undefined => {
    const idx = sorted.length - 1 - n
    if (idx < 0) return undefined
    const base = sorted[idx].nav
    if (!base) return undefined
    return Math.round(((latest - base) / base) * 10_000) / 100
  }
  const DAYS = { m1: 21, m3: 63, m6: 126, y1: 250 } as const
  const out: { m1?: number; m3?: number; m6?: number; y1?: number } = {}
  for (const [key, n] of Object.entries(DAYS) as Array<[keyof typeof DAYS, number]>) {
    const v = back(n)
    if (v !== undefined) out[key] = v
  }
  return out
}

/** 数据时间标注辅助：净值最新一期日期（北京时间 yyyy-MM-dd） */
export function latestNavDate(points: FundNavPoint[]): string {
  if (points.length === 0) return ''
  const ts = Math.max(...points.map((p) => p.timestamp))
  return new Date(ts + CN_TZ_OFFSET_MS).toISOString().slice(0, 10)
}
