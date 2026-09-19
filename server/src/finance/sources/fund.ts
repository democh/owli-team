/**
 * 天天基金源适配器（M34 §3.1）：场外基金净值 / 基础信息（Node 备源）。
 *
 * 接口：
 *   - 历史净值：api.fund.eastmoney.com/f10/lsjz（需 Referer: http://fundf10.eastmoney.com/）
 *   - 净值走势 / 名称 / 费率：fund.eastmoney.com/pingzhongdata/<code>.js（JS 变量提取）
 *
 * 基金档案（规模 / 持仓 / 分红）主源为 akshare（Python 桥）；Node 侧提供净值与基础信息兜底。
 */
import { parseCnDate, CN_TZ_OFFSET_MS } from '../period.js'
import type { FundNavPoint, FundNavSeries } from '../types.js'
import { num, parseJsonLoose, resolveFetcher, str, type SourceCtx } from '../fetcher.js'

const LSJZ = 'https://api.fund.eastmoney.com'
const PINGZHONG = 'https://fund.eastmoney.com'
const REFERER = 'http://fundf10.eastmoney.com/'

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
  /** 管理费率 % */
  feeRate?: number
  /** 净值走势（单位净值；pingzhongdata 自带） */
  navTrend: FundNavPoint[]
  source: string
}

/** 解析 pingzhongdata JS 变量（纯函数：提取 fS_name / fund_Rate / Data_netWorthTrend） */
export function parsePingzhongdata(text: string): FundBasicInfo {
  const name = /var\s+fS_name\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? ''
  const feeRate = num(/var\s+fund_Rate\s*=\s*"([^"]+)"/.exec(text)?.[1])
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
  return { code: '', name, feeRate, navTrend, source: 'eastmoney-fund' }
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
  })
  const info = parsePingzhongdata(res.text)
  return { ...info, code }
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
