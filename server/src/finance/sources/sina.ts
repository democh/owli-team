/**
 * 新浪行情源适配器（M34 §3.1，快照二备）。
 *
 * 接口：hq.sinajs.cn/list=sh600519（GBK；必须带 Referer，否则 403）。
 * 字段（逗号分隔）：0 名称 / 1 今开 / 2 昨收 / 3 现价 / 4 最高 / 5 最低 / 6 买一 / 7 卖一 /
 *                  8 成交量(股) / 9 成交额(元) / … 30 日期 / 31 时间
 */
import type { FinSymbol } from '../symbol.js'
import { inferAssetType, inferExchange } from '../symbol.js'
import { CN_TZ_OFFSET_MS } from '../period.js'
import type { Quote } from '../types.js'
import { chunk, num, resolveFetcher, str, type SourceCtx } from '../fetcher.js'

const HQ = 'https://hq.sinajs.cn'
const REFERER = 'https://finance.sina.com.cn'

const IDX = {
  name: 0,
  open: 1,
  prevClose: 2,
  price: 3,
  high: 4,
  low: 5,
  volumeShares: 8,
  turnover: 9,
  date: 30,
  time: 31,
} as const

/** 解析 `var hq_str_sh600519="贵州茅台,1450.00,...";`（纯函数） */
export function parseSinaPayload(text: string, asOf = new Date().toISOString()): Quote[] {
  const out: Quote[] = []
  const re = /var hq_str_([a-z]{2}\d{6})="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const code = m[1].slice(2)
    const fields = m[2].split(',')
    const name = str(fields[IDX.name])
    const price = num(fields[IDX.price])
    if (!/^\d{6}$/.test(code) || price === undefined || name === '') continue
    const type = inferAssetType(code) ?? 'stock'
    const exchange = inferExchange(code, type)
    const prevClose = num(fields[IDX.prevClose]) ?? 0
    const change = prevClose ? price - prevClose : 0
    const changePct = prevClose ? (change / prevClose) * 100 : 0
    // 数据时间：日期 + 时间（北京时间）
    let dataTime = asOf
    const date = str(fields[IDX.date])
    const time = str(fields[IDX.time])
    const dt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
    const tt = /^(\d{2}):(\d{2}):(\d{2})$/.exec(time)
    if (dt && tt) {
      const ms = Date.UTC(
        Number(dt[1]),
        Number(dt[2]) - 1,
        Number(dt[3]),
        Number(tt[1]),
        Number(tt[2]),
        Number(tt[3]),
      )
      dataTime = new Date(ms - CN_TZ_OFFSET_MS).toISOString()
    }
    const volumeShares = num(fields[IDX.volumeShares]) ?? 0
    out.push({
      symbol: `${exchange ?? ''}${code}`,
      code,
      name,
      price,
      prevClose,
      open: num(fields[IDX.open]) ?? 0,
      high: num(fields[IDX.high]) ?? 0,
      low: num(fields[IDX.low]) ?? 0,
      change,
      changePct,
      volume: Math.round(volumeShares / 100), // 股 → 手
      turnover: num(fields[IDX.turnover]) ?? 0,
      asOf: dataTime,
      source: 'sina',
    })
  }
  return out
}

/** 批量快照（Referer 必需；每批 ≤60 标的） */
export async function fetchQuotes(symbols: FinSymbol[], ctx: SourceCtx = {}): Promise<Quote[]> {
  const fetcher = resolveFetcher(ctx)
  const out: Quote[] = []
  for (const group of chunk(symbols, 60)) {
    const list = group.map((s) => s.symbol).join(',')
    const res = await fetcher({
      url: `${HQ}/list=${list}`,
      accept: 'text/plain,*/*',
      headers: { referer: REFERER },
      signal: ctx.signal,
      minIntervalMs: ctx.minIntervalMs,
      timeoutMs: ctx.timeoutMs,
      userAgent: ctx.userAgent,
    })
    out.push(...parseSinaPayload(res.text))
  }
  if (out.length === 0) throw new Error('新浪快照无有效数据（接口可能已变更或被限流）')
  return out
}
