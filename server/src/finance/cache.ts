/**
 * 金融数据缓存层（M34 §3.4）：finance_* 表读写 + TTL 判定（只做读一致性判断，不触网）。
 *
 * TTL 口径（与设计文档一致）：
 *   - kline：日/周/月线「当日内有效」（北京时间自然日）；分钟线 5 分钟；
 *   - quote：10 秒（仅防抖，不作展示数据源）；
 *   - news：30 分钟（scope + scopeKey 维度；URL 全局去重）；
 *   - meta：finance_meta kv（无内建 TTL，读方按 updatedAt 自行判断）。
 *
 * 过期数据不删除：调用方在源失败时可选择 stale 兜底（GatewayResult.cache = 'stale'）。
 */
import type { AppDb } from '../store/db.js'
import { formatCnDate, type Adjust, type Period } from './period.js'
import type { KlineSeries, NewsItem, Quote } from './types.js'

export const QUOTE_TTL_MS = 10_000
export const MINUTE_KLINE_TTL_MS = 5 * 60_000
export const NEWS_TTL_MS = 30 * 60_000
export const SYMBOL_MASTER_TTL_MS = 7 * 24 * 60 * 60_000
export const SCREEN_BASE_TTL_MS = 10 * 60_000
export const CALENDAR_TTL_MS = 12 * 60 * 60_000

export interface CachedKline {
  series: KlineSeries
  fetchedAt: string
  /** TTL 内（日/周/月线按北京时间自然日；分钟线 5 分钟） */
  fresh: boolean
}

export interface CachedQuote {
  quote: Quote
  fetchedAt: string
  /** TTL 内（10 秒） */
  fresh: boolean
}

export interface FinanceCache {
  klineGet(symbol: string, period: Period, adjust: Adjust, now?: Date): CachedKline | undefined
  klinePut(series: KlineSeries, now?: Date): void
  quoteGet(symbol: string, now?: Date): CachedQuote | undefined
  quoteGetMany(symbols: string[], now?: Date): Map<string, CachedQuote>
  quotePut(quote: Quote, now?: Date): void
  /** TTL（30 分钟）内的新闻（按发布时间倒序） */
  newsGetFresh(scope: string, scopeKey: string, now?: Date): NewsItem[]
  /** 全部缓存新闻（stale 兜底；按发布时间倒序） */
  newsGetAll(scope: string, scopeKey: string): NewsItem[]
  /** 写入并去重（URL 主键）；已存在则刷新 payload 与 fetched_at */
  newsPut(scope: string, scopeKey: string, items: NewsItem[], now?: Date): void
  metaGet<T>(key: string): { value: T; updatedAt: string } | undefined
  metaSet(key: string, value: unknown, now?: Date): void
}

function isMinutePeriod(period: Period): boolean {
  return period.startsWith('min')
}

/** K 线新鲜度：日/周/月线按北京时间自然日；分钟线 5 分钟 */
export function klineFresh(period: Period, fetchedAtIso: string, now: Date): boolean {
  const fetched = Date.parse(fetchedAtIso)
  if (!Number.isFinite(fetched)) return false
  if (isMinutePeriod(period)) return now.getTime() - fetched < MINUTE_KLINE_TTL_MS
  return formatCnDate(fetched) === formatCnDate(now.getTime())
}

/** 通用时间戳新鲜度（meta 用） */
export function ageFresh(updatedAtIso: string, ttlMs: number, now: Date): boolean {
  const at = Date.parse(updatedAtIso)
  return Number.isFinite(at) && now.getTime() - at < ttlMs
}

function parseJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

export function createFinanceCache(db: AppDb): FinanceCache {
  return {
    klineGet(symbol, period, adjust, now = new Date()): CachedKline | undefined {
      const row = db.get<{ payload: string; fetched_at: string }>(
        'SELECT payload, fetched_at FROM finance_kline_cache WHERE symbol = ? AND period = ? AND adjust = ?',
        symbol,
        period,
        adjust,
      )
      if (!row) return undefined
      const series = parseJson<KlineSeries>(row.payload)
      if (!series) return undefined
      return { series, fetchedAt: row.fetched_at, fresh: klineFresh(period, row.fetched_at, now) }
    },

    klinePut(series, now = new Date()): void {
      db.run(
        `INSERT INTO finance_kline_cache (symbol, period, adjust, payload, source, bars, as_of, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol, period, adjust) DO UPDATE SET
           payload = excluded.payload, source = excluded.source, bars = excluded.bars,
           as_of = excluded.as_of, fetched_at = excluded.fetched_at`,
        series.symbol,
        series.period,
        series.adjust,
        JSON.stringify(series),
        series.source,
        series.bars.length,
        series.asOf,
        now.toISOString(),
      )
    },

    quoteGet(symbol, now = new Date()): CachedQuote | undefined {
      const row = db.get<{ payload: string; fetched_at: string }>(
        'SELECT payload, fetched_at FROM finance_quote_cache WHERE symbol = ?',
        symbol,
      )
      if (!row) return undefined
      const quote = parseJson<Quote>(row.payload)
      if (!quote) return undefined
      return { quote, fetchedAt: row.fetched_at, fresh: ageFresh(row.fetched_at, QUOTE_TTL_MS, now) }
    },

    quoteGetMany(symbols, now = new Date()): Map<string, CachedQuote> {
      const out = new Map<string, CachedQuote>()
      for (const symbol of symbols) {
        const hit = this.quoteGet(symbol, now)
        if (hit) out.set(symbol, hit)
      }
      return out
    },

    quotePut(quote, now = new Date()): void {
      db.run(
        `INSERT INTO finance_quote_cache (symbol, payload, source, as_of, fetched_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(symbol) DO UPDATE SET
           payload = excluded.payload, source = excluded.source,
           as_of = excluded.as_of, fetched_at = excluded.fetched_at`,
        quote.symbol,
        JSON.stringify(quote),
        quote.source,
        quote.asOf,
        now.toISOString(),
      )
    },

    newsGetFresh(scope, scopeKey, now = new Date()): NewsItem[] {
      const cutoff = new Date(now.getTime() - NEWS_TTL_MS).toISOString()
      const rows = db.all<{ payload: string }>(
        `SELECT payload FROM finance_news_cache
         WHERE scope = ? AND scope_key = ? AND fetched_at >= ?
         ORDER BY published_at DESC`,
        scope,
        scopeKey,
        cutoff,
      )
      return rows.map((r) => parseJson<NewsItem>(r.payload)).filter((x): x is NewsItem => x !== undefined)
    },

    newsGetAll(scope, scopeKey): NewsItem[] {
      const rows = db.all<{ payload: string }>(
        `SELECT payload FROM finance_news_cache
         WHERE scope = ? AND scope_key = ? ORDER BY published_at DESC`,
        scope,
        scopeKey,
      )
      return rows.map((r) => parseJson<NewsItem>(r.payload)).filter((x): x is NewsItem => x !== undefined)
    },

    newsPut(scope, scopeKey, items, now = new Date()): void {
      const at = now.toISOString()
      for (const item of items) {
        if (!item.url) continue
        db.run(
          `INSERT INTO finance_news_cache (url, scope, scope_key, title, source, published_at, payload, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(url) DO UPDATE SET
             scope = excluded.scope, scope_key = excluded.scope_key, title = excluded.title,
             source = excluded.source, published_at = excluded.published_at,
             payload = excluded.payload, fetched_at = excluded.fetched_at`,
          item.url,
          scope,
          scopeKey,
          item.title,
          item.source,
          item.publishedAt ?? null,
          JSON.stringify(item),
          at,
        )
      }
    },

    metaGet<T>(key: string): { value: T; updatedAt: string } | undefined {
      const row = db.get<{ value: string; updated_at: string }>(
        'SELECT value, updated_at FROM finance_meta WHERE key = ?',
        key,
      )
      if (!row) return undefined
      const value = parseJson<T>(row.value)
      if (value === undefined) return undefined
      return { value, updatedAt: row.updated_at }
    },

    metaSet(key, value, now = new Date()): void {
      db.run(
        `INSERT INTO finance_meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        key,
        JSON.stringify(value),
        now.toISOString(),
      )
    },
  }
}
