/**
 * web_search 工具：联网检索（免 Key 多引擎降级链 + 官方 API 双模式）。
 * - API 模式（推荐）：配置 BAIDU_SEARCH_API_KEY 时走千帆「百度搜索」官方 API
 *   （结构化结果、每月免费额度、无风控问题）；
 * - 免 Key 模式（默认）：按引擎链抓取结果页并解析——百度 → Bing → 搜狗 → 360，
 *   某引擎被风控/冷却（IP 级封锁时单点客户端伪装不可靠）时自动切换到下一个，
 *   结果标注实际引擎；引擎适配见 tools/search-engines.ts，反爬细节见 tools/http.ts。
 * 只读 → 可并行 + 幂等缓存；全部引擎失败时返回明确提示（不重试不加剧封禁）。
 */
import { z } from 'zod'
import { AntiBotError, antiBotFetch } from './http.js'
import {
  cleanInline,
  DEFAULT_ENGINE_ORDER,
  ENGINE_REGISTRY,
  hostOf,
  type SearchEngine,
  type SearchItem,
} from './search-engines.js'
import { toolAbortError, type ToolRuntime, type ToolResult } from './registry.js'

export { parseBaiduSerp } from './search-engines.js'
export type { SearchItem } from './search-engines.js'

/** 返回条数上限（引擎结果数参数 / 解析后截断共用） */
const MAX_RESULTS = 10
/** 回灌模型的结果明细上限（字符） */
const MAX_DETAIL_CHARS = 4_000
/** 抓取模式响应体上限：SERP 含大量内联脚本（现代站点实测最高约 1MB，超过 antiBotFetch
 *  默认 512KB），检索场景需容忍；2MB 仍可防止超大响应拖垮内存 */
const HTML_MODE_MAX_BYTES = 2 * 1024 * 1024
/** 引擎 Cookie 预热缓存时长 */
const COOKIE_TTL_MS = 30 * 60_000

/** 千帆「百度搜索」API 约束：query ≤ 72 字符（汉字计 2）——超长按权重截断 */
export function clampQuery72(q: string): string {
  const wide = /[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u3000-\u303f]/
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

// ---------- 免 Key 模式：引擎降级链 ----------

/** 引擎 Cookie 预热缓存（进程内共享；仅为反爬降级，非登录态） */
const cookieCache = new Map<string, { value: string; expiresAt: number }>()

/** 测试辅助：清空 cookie 缓存（用例隔离） */
export function resetSearchCookieCache(): void {
  cookieCache.clear()
}

/** 引擎链解析：runtime 覆写（engines / engineUrls / htmlUrl）→ 内置默认；未知 id 忽略 */
function resolveChain(ctx: ToolRuntime): SearchEngine[] {
  const ids: readonly string[] = ctx.webSearch.engines?.length ? ctx.webSearch.engines : DEFAULT_ENGINE_ORDER
  const overrides = ctx.webSearch.engineUrls ?? {}
  const htmlOverride = ctx.webSearch.htmlUrl.trim()
  const chain: SearchEngine[] = []
  for (const raw of ids) {
    const id = raw.trim().toLowerCase()
    const engine = ENGINE_REGISTRY[id]
    if (!engine) continue
    // baidu 兼容历史 htmlUrl 覆写字段（测试与旧配置沿用）
    const override = (overrides[id] ?? (id === 'baidu' ? htmlOverride : '')).trim()
    chain.push(override ? { ...engine, baseUrl: override } : engine)
  }
  return chain.length > 0 ? chain : DEFAULT_ENGINE_ORDER.map((id) => ENGINE_REGISTRY[id])
}

/** 预热入口页拿 cookie（失败降级为不携带；TTL 内按引擎复用） */
async function warmupCookie(engine: SearchEngine, ctx: ToolRuntime): Promise<string> {
  const now = Date.now()
  const hit = cookieCache.get(engine.id)
  if (hit && hit.expiresAt > now) return hit.value
  try {
    const res = await antiBotFetch({
      url: `${new URL(engine.baseUrl).origin}/`,
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
    if (value) cookieCache.set(engine.id, { value, expiresAt: now + COOKIE_TTL_MS })
    return value
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    return ''
  }
}

/** 引擎级失败原因（单行、可读；供降级链汇总） */
function briefError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.slice(0, 160)
}

/** 免 Key 模式：按引擎链依次尝试（被风控/冷却的引擎自动跳过；结果标注实际引擎） */
async function searchViaEngines(
  params: { query: string; count: number },
  ctx: ToolRuntime,
): Promise<ToolResult> {
  const chain = resolveChain(ctx)
  const skips: string[] = []
  for (const engine of chain) {
    try {
      const cookie = engine.warmup ? await warmupCookie(engine, ctx) : ''
      const origin = new URL(engine.baseUrl).origin
      const res = await antiBotFetch({
        url: engine.buildUrl(engine.baseUrl, params.query, params.count),
        signal: ctx.signal,
        userAgent: ctx.httpUserAgent,
        timeoutMs: ctx.httpTimeoutMs,
        minIntervalMs: ctx.httpMinIntervalMs,
        maxBytes: HTML_MODE_MAX_BYTES,
        headers: {
          referer: `${origin}/`,
          ...(cookie ? { cookie } : {}),
        },
      })
      const items = engine.parse(res.text)
      if (items.length === 0) {
        skips.push(`${engine.label}：未解析到搜索结果（页面结构变化或轻量风控）`)
        continue
      }
      const mode = skips.length > 0 ? `网页抓取·${engine.label}（降级）` : `网页抓取·${engine.label}`
      const result = formatSearchResult(params.query, items.slice(0, params.count), mode)
      if (skips.length > 0 && result.detail) {
        result.detail = `（降级跳过 ${skips.join('；')}）\n${result.detail}`
      }
      return result
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      skips.push(`${engine.label}：${briefError(err)}`)
    }
  }
  return {
    ok: false,
    summary:
      `联网检索失败（已尝试 ${chain.length} 个引擎）：${skips.join('；')}` +
      '；建议稍后重试，或配置 BAIDU_SEARCH_API_KEY 改用官方 API',
  }
}

// ---------- API 模式：千帆「百度搜索」官方接口 ----------

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
    return {
      ok: false,
      summary: `检索 API 错误：${String(json.message ?? json.error_msg ?? code).slice(0, 160)}`,
    }
  }
  const items: SearchItem[] = (json.references ?? [])
    .filter(
      (r) => (r.type === undefined || r.type === 'web') && typeof r.url === 'string' && r.url.length > 0,
    )
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
  return { ok: true, summary: `联网检索「${query}」：${items.length} 条结果（${mode}）`, detail }
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
    '联网搜索（多引擎降级链：百度 → Bing → 搜狗 → 360，被风控时自动切换下一个）：' +
    '输入查询词返回标题 / 链接 / 摘要列表，用于获取时效性信息与外部资料。' +
    '配置 BAIDU_SEARCH_API_KEY 时走官方 API（更稳定），否则抓取搜索结果页。',
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
    const query = args.query.trim()
    if (!query) return { ok: false, summary: '查询词不能为空' }
    const params = { query, count: args.count ?? 8 }
    try {
      return ctx.webSearch.apiKey.trim() !== ''
        ? await searchViaApi(params, ctx)
        : await searchViaEngines(params, ctx)
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw toolAbortError()
      if (err instanceof AntiBotError) return { ok: false, summary: `检索被风控拦截：${err.message}` }
      return { ok: false, summary: `检索出错：${(err as Error).message.slice(0, 160)}` }
    }
  },
}
