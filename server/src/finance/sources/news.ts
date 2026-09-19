/**
 * 新闻 / 公告源适配器（M34 §3.1）：东财公告为主源，新浪财经滚动为兜底。
 *
 * 接口：
 *   - 个股公告：np-anotice-stock.eastmoney.com/api/security/ann（按 stock_list 过滤）
 *   - 市场要闻：feed.mix.sina.com.cn/api/roll/get（财经滚动，JSON）
 *
 * 去重键 = URL；信源等级：公告 = official，媒体 = media。
 */
import { CN_TZ_OFFSET_MS } from '../period.js'
import type { NewsItem } from '../types.js'
import { num, parseJsonLoose, resolveFetcher, str, type SourceCtx } from '../fetcher.js'

const NOTICE = 'https://np-anotice-stock.eastmoney.com'
const SINA_ROLL = 'https://feed.mix.sina.com.cn'

interface NoticePayload {
  data?: {
    list?: Array<{
      title?: unknown
      notice_date?: unknown
      art_code?: unknown
      display_time?: unknown
      codes?: Array<{ stock_code?: unknown; short_name?: unknown }>
    }>
  }
}

/** 解析东财公告列表（纯函数） */
export function parseNoticePayload(text: string, limit = 20): NewsItem[] {
  const payload = parseJsonLoose<NoticePayload>(text)
  const list = payload.data?.list
  if (!Array.isArray(list)) throw new Error('东财公告响应缺少 data.list（接口可能已变更）')
  const out: NewsItem[] = []
  for (const row of list.slice(0, limit)) {
    const title = str(row.title)
    const artCode = str(row.art_code)
    if (!title || !artCode) continue
    const stockCode = str(row.codes?.[0]?.stock_code)
    const date = str(row.notice_date)
    out.push({
      title,
      url: `https://data.eastmoney.com/notices/detail/${stockCode}/${artCode}.html`,
      source: '东方财富·公告',
      publishedAt: date,
      tier: 'official',
      symbol: stockCode || undefined,
    })
  }
  return out
}

/** 个股公告（stockCode 6 位；limit ≤ 50） */
export async function fetchNotices(stockCode: string, limit: number, ctx: SourceCtx = {}): Promise<NewsItem[]> {
  const fetcher = resolveFetcher(ctx)
  const params = new URLSearchParams({
    sr: '-1',
    page_size: String(Math.min(Math.max(limit, 1), 50)),
    page_index: '1',
    ann_type: 'A',
    client_source: 'web',
    stock_list: stockCode,
  })
  const res = await fetcher({
    url: `${NOTICE}/api/security/ann?${params.toString()}`,
    accept: 'application/json',
    signal: ctx.signal,
    minIntervalMs: ctx.minIntervalMs,
    timeoutMs: ctx.timeoutMs,
    userAgent: ctx.userAgent,
  })
  return parseNoticePayload(res.text, limit)
}

interface SinaRollPayload {
  result?: {
    data?: Array<{
      title?: unknown
      url?: unknown
      intro?: unknown
      ctime?: unknown
      media_name?: unknown
    }>
  }
}

/** 解析新浪财经滚动（纯函数；ctime 为秒级时间戳字符串） */
export function parseSinaRollPayload(text: string, limit = 20): NewsItem[] {
  const payload = parseJsonLoose<SinaRollPayload>(text)
  const list = payload.result?.data
  if (!Array.isArray(list)) throw new Error('新浪滚动新闻响应缺少 result.data（接口可能已变更）')
  const out: NewsItem[] = []
  for (const row of list.slice(0, limit)) {
    const title = str(row.title)
    const url = str(row.url)
    if (!title || !url) continue
    const ctime = num(row.ctime)
    const item: NewsItem = {
      title,
      url,
      source: str(row.media_name) || '新浪财经',
      tier: 'media',
    }
    if (ctime !== undefined) {
      item.publishedAt = new Date(ctime * 1_000 - CN_TZ_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ')
    }
    const intro = str(row.intro)
    if (intro) item.summary = intro
    out.push(item)
  }
  return out
}

/** 市场要闻（新浪财经滚动；lid=2516 为财经频道） */
export async function fetchMarketNews(limit: number, ctx: SourceCtx = {}): Promise<NewsItem[]> {
  const fetcher = resolveFetcher(ctx)
  const params = new URLSearchParams({
    pageid: '153',
    lid: '2516',
    k: '',
    num: String(Math.min(Math.max(limit, 1), 50)),
    page: '1',
  })
  const res = await fetcher({
    url: `${SINA_ROLL}/api/roll/get?${params.toString()}`,
    accept: 'application/json',
    signal: ctx.signal,
    minIntervalMs: ctx.minIntervalMs,
    timeoutMs: ctx.timeoutMs,
    userAgent: ctx.userAgent,
  })
  return parseSinaRollPayload(res.text, limit)
}

/** 合并去重（URL 键；发布时间倒序） */
export function dedupeNews(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>()
  const out: NewsItem[] = []
  for (const item of items) {
    const key = item.url || item.title
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
}
