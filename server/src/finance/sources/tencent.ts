/**
 * 腾讯行情源适配器（M34 §3.1，快照兜底）。
 *
 * 接口：qt.gtimg.cn/q=sh600519,sz000001（GBK，批量）。
 * 解析契约：字段以 `~` 分隔（索引见下方注释；接口若变更，仅需修 parse 函数并有测试保护）。
 */
import type { FinSymbol } from '../symbol.js'
import { inferAssetType, inferExchange } from '../symbol.js'
import { CN_TZ_OFFSET_MS } from '../period.js'
import type { Quote } from '../types.js'
import { chunk, num, resolveFetcher, str, type SourceCtx } from '../fetcher.js'

const QT = 'https://qt.gtimg.cn'

/** 腾讯字段索引（0 起）：1 名称 / 2 代码 / 3 现价 / 4 昨收 / 5 今开 / 6 量(手) / 30 时间(yyyyMMddHHmmss)
 *  31 涨跌 / 32 涨跌% / 33 最高 / 34 最低 / 37 额(万) / 38 换手% / 39 PE / 44 流通市值(亿) / 45 总市值(亿) / 46 PB */
const IDX = {
  name: 1,
  code: 2,
  price: 3,
  prevClose: 4,
  open: 5,
  volume: 6,
  time: 30,
  change: 31,
  changePct: 32,
  high: 33,
  low: 34,
  turnoverWan: 37,
  turnoverRate: 38,
  pe: 39,
  floatCapYi: 44,
  capYi: 45,
  pb: 46,
} as const

/** 解析 `v_sh600519="1~贵州茅台~600519~...";`（多行/单行；纯函数） */
export function parseTencentPayload(text: string, asOf = new Date().toISOString()): Quote[] {
  const out: Quote[] = []
  const re = /v_([a-z]{2}\d{6})="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const fields = m[2].split('~')
    const code = str(fields[IDX.code])
    const name = str(fields[IDX.name])
    const price = num(fields[IDX.price])
    if (!/^\d{6}$/.test(code) || price === undefined || name === '') continue
    const type = inferAssetType(code) ?? 'stock'
    const exchange = inferExchange(code, type)
    const prevClose = num(fields[IDX.prevClose]) ?? 0
    const change = num(fields[IDX.change]) ?? (prevClose ? price - prevClose : 0)
    const changePct = num(fields[IDX.changePct]) ?? (prevClose ? (change / prevClose) * 100 : 0)
    // 数据时间：yyyyMMddHHmmss → ISO（北京时间）
    let dataTime = asOf
    const t = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(str(fields[IDX.time]))
    if (t) {
      const ms = Date.UTC(Number(t[1]), Number(t[2]) - 1, Number(t[3]), Number(t[4]), Number(t[5]), Number(t[6]))
      dataTime = new Date(ms - CN_TZ_OFFSET_MS).toISOString()
    }
    const turnoverWan = num(fields[IDX.turnoverWan])
    const capYi = num(fields[IDX.capYi])
    const floatCapYi = num(fields[IDX.floatCapYi])
    const quote: Quote = {
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
      volume: num(fields[IDX.volume]) ?? 0,
      turnover: turnoverWan !== undefined ? turnoverWan * 10_000 : 0,
      turnoverRate: num(fields[IDX.turnoverRate]),
      pe: num(fields[IDX.pe]),
      marketCap: capYi !== undefined ? capYi * 1e8 : undefined,
      floatMarketCap: floatCapYi !== undefined ? floatCapYi * 1e8 : undefined,
      pb: num(fields[IDX.pb]),
      asOf: dataTime,
      source: 'tencent',
    }
    out.push(quote)
  }
  return out
}

/** 批量快照（GBK 由 antiBotFetch 解码；每批 ≤60 标的） */
export async function fetchQuotes(symbols: FinSymbol[], ctx: SourceCtx = {}): Promise<Quote[]> {
  const fetcher = resolveFetcher(ctx)
  const out: Quote[] = []
  for (const group of chunk(symbols, 60)) {
    const list = group.map((s) => s.symbol).join(',')
    const res = await fetcher({
      url: `${QT}/q=${list}`,
      accept: 'text/plain,*/*',
      signal: ctx.signal,
      minIntervalMs: ctx.minIntervalMs,
      timeoutMs: ctx.timeoutMs,
      userAgent: ctx.userAgent,
    })
    out.push(...parseTencentPayload(res.text))
  }
  if (out.length === 0) throw new Error('腾讯快照无有效数据（接口可能已变更或被限流）')
  return out
}
