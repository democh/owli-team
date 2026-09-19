/**
 * web_search 工具：联网检索（百度，双模式）。
 * - API 模式（推荐）：配置 BAIDU_SEARCH_API_KEY 时走千帆「百度搜索」官方 API
 *   （结构化结果、每月免费额度、无风控问题）；
 * - HTML 模式（默认，免 Key）：抓取百度结果页并解析（浏览器头 + 域名限速 + 退避重试 +
 *   风控识别与冷却，反爬细节见 tools/http.ts）。
 * 只读 → 可并行 + 幂等缓存；被风控拦截时返回明确提示（不重试不加剧封禁）。
 */
import { z } from 'zod'
import { AntiBotError, antiBotFetch } from './http.js'
import { WEB_SEARCH_DISABLED_SUMMARY } from './availability.js'
import { toolAbortError, type ToolRuntime, type ToolResult } from './registry.js'
import { htmlToText } from './text.js'

/** 返回条数上限（HTML 模式对应 rn 参数） */
const MAX_RESULTS = 10
/** 回灌模型的结果明细上限（字符） */
const MAX_DETAIL_CHARS = 4_000
/** 百度结果页默认入口（测试可经 runtime 注入本地地址） */
const DEFAULT_HTML_URL = 'https://www.baidu.com/s'
/** HTML 模式响应体上限：百度 SERP 含大量内联脚本（实测约 900KB，超过 antiBotFetch 默认 512KB），
 *  检索场景需容忍；2MB 仍可防止超大响应拖垮内存 */
const HTML_MODE_MAX_BYTES = 2 * 1024 * 1024
/** cookie 预热缓存时长 */
const COOKIE_TTL_MS = 30 * 60_000

export interface SearchItem {
  title: string
  url: string
  summary: string
  site: string
  date: string
}

/** 内联片段净化：去标签 + 解码实体 + 压缩空白 */
function cleanInline(s: string): string {
  return htmlToText(s).replace(/\s+/g, ' ').trim()
}

/** data-tools 属性（转义 JSON）实体解码（&amp; 最后处理，避免二次解码） */
function decodeAttrEntities(s: string): string {
  return s
    .replace(/&quot;/gi, '"')
    .replace(/&#0*34;/g, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#0*39;/g, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** 百度跳转链（www.baidu.com/link?url=...）判定：此类 URL 不可作为展示链接且无站点信息 */
function isBaiduLink(url: string): boolean {
  return /(^|\.)baidu\.com$/i.test(hostOf(url)) && /\/link\?/i.test(url)
}

/** 结果容器判定：class 含 c-container 且含 result / result-* 类 */
function isResultContainer(tag: string): boolean {
  const cls = /class="([^"]*)"/i.exec(tag)?.[1]
  if (!cls) return false
  const parts = cls.split(/\s+/)
  return parts.includes('c-container') && parts.some((p) => p === 'result' || p.startsWith('result-'))
}

/** 单个结果块解析：标题 / 真实 URL / 摘要 / 站点 / 日期（多级回退，容忍结构差异） */
function parseResultBlock(block: string): SearchItem | null {
  const h3 = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(block)?.[1] ?? ''
  const anchor = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(h3)
  const title = cleanInline(anchor?.[2] ?? h3)
  if (!title) return null

  // URL：data-tools JSON（真实 URL）→ mu 属性 → h3 内锚点（百度跳转链）
  let url = ''
  const toolsRaw = /data-tools="([^"]*)"/i.exec(block)?.[1]
  if (toolsRaw) {
    const decoded = decodeAttrEntities(toolsRaw)
    try {
      const parsed = JSON.parse(decoded) as { url?: string }
      if (typeof parsed.url === 'string' && parsed.url) url = parsed.url
    } catch {
      // 转义异常时宽松提取，避免整块丢弃
      url = /"url"\s*:\s*"([^"]+)"/.exec(decoded)?.[1] ?? ''
    }
  }
  if (!url) url = /\bmu="([^"]+)"/i.exec(block)?.[1] ?? ''
  if (!url) url = anchor?.[1] ?? ''

  // 摘要：c-abstract / content-right_* / c-span-last 依次尝试
  const absRaw =
    /<div[^>]*class="[^"]*\bc-abstract\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1] ??
    /<span[^>]*class="[^"]*\bcontent-right_[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1] ??
    /<div[^>]*class="[^"]*\bc-span-last\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1] ??
    ''
  const summary = cleanInline(absRaw)

  // 站点：真实 URL 的 hostname 优先；跳转链/缺失时取灰字（排除日期/快照等噪声）
  let site = url && !isBaiduLink(url) ? hostOf(url) : ''
  if (!site) {
    const grays = block.match(/<span[^>]*class="[^"]*\bc-color-gray\b[^"]*"[^>]*>[\s\S]*?<\/span>/gi) ?? []
    for (const gray of grays) {
      const text = cleanInline(gray)
      if (text && !/^\d/.test(text) && text.length <= 60 && !/快照/.test(text)) {
        site = text
        break
      }
    }
  }

  // 日期：从块纯文本提取（标签已剥离，不会误匹配链接）
  const blockText = htmlToText(block)
  const date = /(\d{4}[-年]\d{1,2}[-月]\d{1,2}日?|\d{1,2}\s*小时前|\d{1,2}\s*分钟前|\d+\s*天前|昨天)/.exec(blockText)?.[1] ?? ''

  return {
    title,
    url,
    summary,
    site: site.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    date,
  }
}

/** 解析百度结果页（SERP）为结构化列表（导出供单测） */
export function parseBaiduSerp(html: string): SearchItem[] {
  const starts: Array<{ index: number; tag: string }> = []
  const divRe = /<div[^>]*>/gi
  for (let m = divRe.exec(html); m; m = divRe.exec(html)) {
    if (isResultContainer(m[0])) starts.push({ index: m.index, tag: m[0] })
  }
  const items: SearchItem[] = []
  const seen = new Set<string>()
  for (let i = 0; i < starts.length; i++) {
    const block = html.slice(starts[i].index, i + 1 < starts.length ? starts[i + 1].index : html.length)
    const item = parseResultBlock(block)
    if (!item) continue
    const key = item.url || item.title
    if (seen.has(key)) continue
    seen.add(key)
    items.push(item)
  }
  return items
}

/** 千帆「百度搜索」API 约束：query ≤ 72 字符（汉字计 2）——超长按权重截断 */
export function clampQuery72(q: string): string {
  const wide =
    /[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u3000-\u303f]/
  let width = 0
  let out = ''
  for (const ch of q) {
    const w = wide.test(ch) ? 2 : 1
    if (width + w > 72) break
    width += w
    out += ch
  }
  return out
}

interface ApiReference {
  title?: string
  url?: string
  content?: string
  website?: string
  date?: string
  type?: string
}

interface ApiSearchResponse {
  code?: number | string
  message?: string
  error_code?: number | string
  error_msg?: string
  references?: ApiReference[]
}

/** BAIDUID cookie 预热缓存（进程内共享；仅为反爬降级，非登录态） */
let cookieCache: { value: string; expiresAt: number } | null = null

/** 测试辅助：清空 cookie 缓存（用例隔离） */
export function resetSearchCookieCache(): void {
  cookieCache = null
}

/** 预热入口页拿 cookie（失败降级为不携带；TTL 内复用） */
async function warmupCookie(ctx: ToolRuntime, base: string): Promise<string> {
  const now = Date.now()
  if (cookieCache && cookieCache.expiresAt > now) return cookieCache.value
  try {
    const res = await antiBotFetch({
      url: `${new URL(base).origin}/`,
      readBody: false,
      signal: ctx.signal,
      userAgent: ctx.httpUserAgent,
      timeoutMs: ctx.httpTimeoutMs,
      minIntervalMs: ctx.httpMinIntervalMs,
      maxRetries: 1,
    })
    const value = res.setCookies
      .map((c) => c.split(';')[0] ?? '')
      .filter((c) => c.length > 0)
      .join('; ')
    if (value) cookieCache = { value, expiresAt: now + COOKIE_TTL_MS }
    return value
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    return ''
  }
}

/** HTML 模式：抓取百度结果页并解析 */
async function searchViaHtml(params: { query: string; count: number }, ctx: ToolRuntime): Promise<ToolResult> {
  const base = ctx.webSearch.htmlUrl.trim() !== '' ? ctx.webSearch.htmlUrl : DEFAULT_HTML_URL
  const cookie = await warmupCookie(ctx, base)
  const endpoint = new URL(base)
  endpoint.searchParams.set('ie', 'utf-8')
  endpoint.searchParams.set('rn', String(params.count))
  endpoint.searchParams.set('wd', params.query)
  const res = await antiBotFetch({
    url: endpoint.toString(),
    signal: ctx.signal,
    userAgent: ctx.httpUserAgent,
    timeoutMs: ctx.httpTimeoutMs,
    minIntervalMs: ctx.httpMinIntervalMs,
    maxBytes: HTML_MODE_MAX_BYTES,
    headers: {
      referer: `${new URL(base).origin}/`,
      ...(cookie ? { cookie } : {}),
    },
  })
  const items = parseBaiduSerp(res.text)
  if (items.length === 0) {
    return {
      ok: false,
      summary: '未解析到搜索结果（百度页面结构变化或轻量风控），请稍后重试，或配置 BAIDU_SEARCH_API_KEY 改用官方 API',
    }
  }
  return formatSearchResult(params.query, items.slice(0, params.count), '网页抓取')
}

/** API 模式：千帆「百度搜索」官方接口 */
async function searchViaApi(params: { query: string; count: number }, ctx: ToolRuntime): Promise<ToolResult> {
  const res = await antiBotFetch({
    url: ctx.webSearch.apiUrl,
    method: 'POST',
    signal: ctx.signal,
    userAgent: ctx.httpUserAgent,
    timeoutMs: ctx.httpTimeoutMs,
    minIntervalMs: ctx.httpMinIntervalMs,
    maxRetries: 2,
    accept: 'application/json',
    headers: {
      authorization: `Bearer ${ctx.webSearch.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: clampQuery72(params.query) }],
      resource_type_filter: [{ type: 'web', top_k: params.count }],
      search_source: 'baidu_search_v2',
    }),
  })
  let json: ApiSearchResponse
  try {
    json = JSON.parse(res.text) as ApiSearchResponse
  } catch {
    return { ok: false, summary: '检索 API 返回内容不是有效 JSON（请检查 BAIDU_SEARCH_API_URL）' }
  }
  const code = json.code ?? json.error_code
  if (code !== undefined && Number(code) !== 0) {
    return { ok: false, summary: `检索 API 错误：${String(json.message ?? json.error_msg ?? code).slice(0, 160)}` }
  }
  const items = (json.references ?? [])
    .filter((r) => (r.type === undefined || r.type === 'web') && typeof r.url === 'string' && r.url.length > 0)
    .map((r) => ({
      title: cleanInline(r.title ?? '') || r.url!,
      url: r.url!,
      summary: cleanInline(r.content ?? ''),
      site: r.website ? cleanInline(r.website) : hostOf(r.url!),
      date: r.date ?? '',
    }))
  if (items.length === 0) {
    return { ok: false, summary: '检索未返回结果（查询词可能无匹配，或 API 额度已用尽）' }
  }
  return formatSearchResult(params.query, items, '官方 API')
}

/** 统一格式化：编号 + 标题 + URL + 摘要 +（站点 · 日期），超长截断 */
function formatSearchResult(query: string, items: SearchItem[], mode: string): ToolResult {
  const blocks = items.map((it, i) => {
    const meta = [it.site, it.date].filter(Boolean).join(' · ')
    const lines = [`${i + 1}. ${it.title}`, `   ${it.url}`]
    if (it.summary) lines.push(`   ${it.summary}`)
    if (meta) lines.push(`   （${meta}）`)
    return lines.join('\n')
  })
  let detail = blocks.join('\n\n')
  if (detail.length > MAX_DETAIL_CHARS) detail = `${detail.slice(0, MAX_DETAIL_CHARS)}\n…（结果过长已截断）`
  return { ok: true, summary: `百度检索「${query}」：${items.length} 条结果（${mode}）`, detail }
}

/** AntiBotError → 模型可读提示（含可操作建议） */
function antiBotMessage(err: AntiBotError): string {
  switch (err.kind) {
    case 'blocked':
      return `检索被风控拦截：${err.message}；建议稍后重试，或配置 BAIDU_SEARCH_API_KEY 改用官方 API`
    case 'rate-limit':
      return '检索失败：请求过于频繁（HTTP 429），请稍后重试'
    case 'timeout':
      return `检索超时（${err.message}）`
    case 'too-large':
      return `检索响应过大，已拒绝（${err.message}）`
    case 'network':
      return `检索网络错误：${err.message}`
    case 'status':
      return `检索失败：HTTP ${err.status ?? '未知'}`
  }
}

const searchSchema = z.object({
  query: z.string().min(1).max(200),
  count: z.number().int().min(1).max(MAX_RESULTS).optional(),
})

export const webSearchTool = {
  name: 'web_search',
  tier: 'deferred' as const,
  readOnly: true,
  description:
    '联网搜索（百度检索）：输入查询词返回标题 / 链接 / 摘要列表，用于获取时效性信息与外部资料。' +
    '配置 BAIDU_SEARCH_API_KEY 时走官方 API（更稳定），否则抓取百度结果页（可能触发风控）。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '查询词（建议简短精准）' },
      count: { type: 'integer', description: `返回结果数（1-${MAX_RESULTS}，默认 8）` },
    },
    required: ['query'],
  },
  schema: searchSchema,
  async execute(args: z.infer<typeof searchSchema>, ctx: ToolRuntime): Promise<ToolResult> {
    if (!ctx.webSearch.enabled) {
      return { ok: false, summary: WEB_SEARCH_DISABLED_SUMMARY }
    }
    const query = args.query.trim()
    if (!query) return { ok: false, summary: '查询词不能为空' }
    const params = { query, count: args.count ?? 8 }
    try {
      return ctx.webSearch.apiKey.trim() !== ''
        ? await searchViaApi(params, ctx)
        : await searchViaHtml(params, ctx)
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw toolAbortError()
      if (err instanceof AntiBotError) return { ok: false, summary: antiBotMessage(err) }
      return { ok: false, summary: `检索出错：${(err as Error).message.slice(0, 160)}` }
    }
  },
}
