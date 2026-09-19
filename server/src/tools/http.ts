/**
 * 反爬 HTTP 共享模块（web_search / web_fetch / 财经源共用，§21.3 联网工具）：
 * - 浏览器化请求头：UA 池按 host 粘性选择（同站点会话稳定），Sec-Fetch-* 与浏览器指纹一致；
 * - 会话 Cookie 罐（tough-cookie）：Set-Cookie 自动入库并按域/路径/过期语义回传（降低「无会话脚本」判定）；
 * - 域名级限速：同 host 串行队列 + 最小间隔（HTTP_MIN_INTERVAL_MS），避免密集请求触发风控；
 * - 风控冷却：识别到拦截后对该 host 冷却 60s，冷却期内请求直接拒绝（不加剧封禁）；
 * - 指数退避重试：仅 429 / 5xx / 网络错误（尊重 Retry-After）；外部取消不重试；
 * - 响应体解码：BOM → content-type charset → <meta charset> → utf-8 兜底（GBK 家族归一 gb18030）；
 * - 风控页识别：wappass / 百度安全验证 / Cloudflare 挑战 / 403 → AntiBotError('blocked')；
 * - 流式体积上限：声明超限直接拒绝，未声明兜底流式截断（防超大响应拖垮内存）。
 */
import { CookieJar } from 'tough-cookie'
import { toolAbortError } from './registry.js'

/** 反爬错误分类：blocked=风控拦截（不重试 + host 冷却）；rate-limit=429（退避重试） */
export type AntiBotErrorKind = 'blocked' | 'rate-limit' | 'timeout' | 'network' | 'status' | 'too-large'

export class AntiBotError extends Error {
  readonly kind: AntiBotErrorKind
  /** HTTP 状态码（status / rate-limit / blocked 时可用） */
  readonly status?: number
  /** 服务端声明的响应体大小（too-large 且带 content-length 时可用） */
  readonly bytes?: number
  /** Retry-After 解析值（rate-limit 时可用） */
  readonly retryAfterMs?: number

  constructor(
    kind: AntiBotErrorKind,
    message: string,
    extra: { status?: number; bytes?: number; retryAfterMs?: number } = {},
  ) {
    super(message)
    this.name = 'AntiBotError'
    this.kind = kind
    this.status = extra.status
    this.bytes = extra.bytes
    this.retryAfterMs = extra.retryAfterMs
  }
}

/** 浏览器 UA 与指纹一致性：Safari 不发送 Sec-Fetch-* / upgrade-insecure-requests */
export interface UaProfile {
  ua: string
  /** 是否发送 Sec-Fetch-* 系列头（Chrome/Edge 发送；Safari 不发送） */
  secFetch: boolean
}

/** UA 池（真实主流桌面浏览器；同 host 会话内稳定，跨 host 分散指纹） */
const UA_POOL: readonly UaProfile[] = [
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    secFetch: true,
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    secFetch: true,
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    secFetch: true,
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
    secFetch: false,
  },
]

/** 默认浏览器 UA（Chrome 桌面版；HTTP_USER_AGENT 可覆盖） */
export const DEFAULT_BROWSER_UA = UA_POOL[0].ua

/** 触发风控后的 host 冷却时长 */
const COOLDOWN_MS = 60_000
/** 重试退避基数（第 n 次重试等待 base * 2^(n-1)） */
const RETRY_BASE_MS = 500
/** 单次重试等待上限 */
const RETRY_MAX_WAIT_MS = 10_000

/** 模块级状态：同 host 串行队列 / 限速时间槽 / 风控冷却 / host→UA 指纹（进程内共享，多工具一致） */
const hostQueue = new Map<string, Promise<unknown>>()
const hostNextSlot = new Map<string, number>()
const hostCooldown = new Map<string, number>()
const hostUaProfile = new Map<string, UaProfile>()

/**
 * 会话 Cookie 罐（tough-cookie）：Set-Cookie 自动入库并按域/路径/过期语义在后续请求回传。
 * 反爬价值：东财 / 新浪等站点通过 Set-Cookie 下发访客指纹（如 qgqp_b_id），
 * 自动回传可显著降低被判定为「无会话脚本」的概率（looseMode 容忍非 RFC 严格 Cookie）。
 */
const cookieJar = new CookieJar(undefined, { looseMode: true })

/** host 级 UA 指纹（首次按 host 散列选择，会话内保持稳定——UA 抖动反而可疑） */
function pickUaProfile(host: string): UaProfile {
  let profile = hostUaProfile.get(host)
  if (!profile) {
    let hash = 0
    for (let i = 0; i < host.length; i++) hash = (hash * 31 + host.charCodeAt(i)) >>> 0
    profile = UA_POOL[hash % UA_POOL.length]
    hostUaProfile.set(host, profile)
  }
  return profile
}

/** 测试辅助：重置限速/冷却/队列/UA/会话 Cookie 状态（避免用例相互污染） */
export function resetAntiBotState(): void {
  hostQueue.clear()
  hostNextSlot.clear()
  hostCooldown.clear()
  hostUaProfile.clear()
  cookieJar.removeAllCookiesSync()
}

/** 浏览器化基础请求头（Accept 默认 HTML；JSON 接口用 accept 覆盖；显式 UA 覆盖保持既有行为） */
export function browserHeaders(
  userAgent?: string,
  extra: Record<string, string> = {},
  profile: UaProfile = UA_POOL[0],
): Record<string, string> {
  const ua = userAgent?.trim()
  const headers: Record<string, string> = {
    'user-agent': ua ? ua : profile.ua,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'cache-control': 'no-cache',
  }
  // 显式 UA 覆盖 → 沿既有行为附带 Sec-Fetch-*；否则跟随池内浏览器指纹一致性
  if (ua || profile.secFetch) {
    headers['sec-fetch-dest'] = 'document'
    headers['sec-fetch-mode'] = 'navigate'
    headers['sec-fetch-site'] = 'none'
    headers['upgrade-insecure-requests'] = '1'
  }
  return { ...headers, ...extra }
}

/**
 * 风控/验证页识别（返回匹配原因；null = 正常页面）。
 * 优先判定最终 URL（重定向到验证域），其次标题/正文特征。
 */
export function detectBlockPage(opts: { status: number; finalUrl: string; text: string }): string | null {
  const { status, finalUrl, text } = opts
  if (/wappass\.baidu\.com|verify\.baidu\.com|\/sorry\//i.test(finalUrl)) {
    return '被重定向到百度安全验证页（触发风控）'
  }
  const head = text.slice(0, 4_096)
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]?.trim() ?? ''
  if (/安全验证/.test(title) || /百度安全验证/.test(head)) return '百度安全验证页（触发风控）'
  if (/Just a moment|Attention Required|Checking your browser/i.test(title)) return 'Cloudflare 人机验证页'
  if (/cf-chl-|challenge-platform/.test(head)) return 'Cloudflare 挑战页'
  if (status === 403) return 'HTTP 403（网站拒绝访问，疑似风控）'
  return null
}

/** GBK 家族归一（gb2312/gbk 均为 gb18030 子集，解码后兼容） */
function normalizeCharset(raw: string): string {
  const cs = raw.trim().toLowerCase().replace(/^["']|["']$/g, '')
  if (cs === 'gb2312' || cs === 'gbk' || cs === 'x-gbk' || cs === 'gb18030') return 'gb18030'
  if (cs === 'utf8' || cs === '') return 'utf-8'
  return cs
}

/** 响应体解码：BOM → content-type charset → HTML <meta charset> → utf-8 兜底 */
export function decodeBody(buf: Buffer, contentType: string): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8')
  }
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]
  if (!charset) {
    const head = buf.subarray(0, 4_096).toString('latin1')
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]
  }
  const cs = normalizeCharset(charset ?? 'utf-8')
  if (cs === 'utf-8' || cs === 'ascii') return buf.toString('utf8')
  try {
    return new TextDecoder(cs).decode(buf)
  } catch {
    // 未知/不可用编码（如环境缺 ICU 数据）→ utf-8 兜底
    return buf.toString('utf8')
  }
}

/** 流式读取响应体并限制上限（超限立即中止返回 null，避免整块读入内存） */
export async function readCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks, total)
}

export interface AntiBotRequest {
  url: string
  /** 工具执行信号（外部取消 → 抛 AbortError，不重试） */
  signal?: AbortSignal
  method?: string
  body?: string
  /** 覆盖/追加请求头（referer / cookie / authorization / content-type 等） */
  headers?: Record<string, string>
  /** 覆盖 Accept（JSON 接口传 application/json） */
  accept?: string
  /** 浏览器 UA 覆盖（空 = DEFAULT_BROWSER_UA） */
  userAgent?: string
  /** 整体超时（毫秒，默认 15s；超时 → AntiBotError('timeout')） */
  timeoutMs?: number
  /** 响应体上限（字节，默认 512KB；超限 → AntiBotError('too-large')） */
  maxBytes?: number
  /** 同 host 最小请求间隔（毫秒，默认 1200；0 = 不限速） */
  minIntervalMs?: number
  /** 失败重试次数（仅 429/5xx/网络错误；默认 1） */
  maxRetries?: number
  /** 是否读取响应体（false = 只取响应头/Set-Cookie，如 cookie 预热） */
  readBody?: boolean
}

export interface AntiBotResponse {
  status: number
  /** HTTP 2xx 判定（antiBotFetch 成功返回时恒为 true；调用方防御使用） */
  ok: boolean
  statusText: string
  /** 重定向后的最终 URL */
  finalUrl: string
  headers: Headers
  /** 解码后的响应文本（readBody=false 时为空串） */
  text: string
  /** Set-Cookie 原值列表（cookie 预热用） */
  setCookies: string[]
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const isAbortLike = (err: unknown): boolean => err instanceof Error && err.name === 'AbortError'

/** 同 host 串行（前序失败不阻塞后续；队首任务即刻执行） */
function enqueue<T>(host: string, task: () => Promise<T>): Promise<T> {
  const prev = hostQueue.get(host) ?? Promise.resolve()
  const run = prev.then(
    () => task(),
    () => task(),
  )
  hostQueue.set(
    host,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

function assertNotCooling(host: string): void {
  const until = hostCooldown.get(host) ?? 0
  if (until > Date.now()) {
    throw new AntiBotError('blocked', `${host} 已触发网站风控，冷却 ${Math.ceil((until - Date.now()) / 1_000)}s`)
  }
}

/** 标记 host 触发风控（冷却期内不再发起请求） */
function markBlocked(host: string): void {
  hostCooldown.set(host, Date.now() + COOLDOWN_MS)
}

function parseRetryAfter(res: Response): number | undefined {
  const raw = res.headers.get('retry-after')?.trim()
  if (!raw) return undefined
  const secs = Number(raw)
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1_000, RETRY_MAX_WAIT_MS)
  const at = Date.parse(raw)
  if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), RETRY_MAX_WAIT_MS)
  return undefined
}

function isRetryable(err: AntiBotError): boolean {
  if (err.kind === 'rate-limit' || err.kind === 'network') return true
  return err.kind === 'status' && (err.status ?? 0) >= 500
}

/** 主动关掉未消费的响应体（防连接池占用） */
async function drain(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined)
}

/** 限速等待：距离 host 上一个请求的间隔不足时补齐（同 host 串行下为真实退避） */
async function waitForSlot(host: string, minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return
  const wait = (hostNextSlot.get(host) ?? 0) - Date.now()
  if (wait > 0) await sleep(wait)
}

/** 单次请求（不含重试/排队）：状态分流 + 体积预检 + 解码 + 风控页识别 */
async function fetchOnce(
  req: AntiBotRequest,
  host: string,
  limits: { timeoutMs: number; maxBytes: number },
): Promise<AntiBotResponse> {
  const ctl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctl.abort()
  }, limits.timeoutMs)
  const onParentAbort = (): void => ctl.abort()
  req.signal?.addEventListener('abort', onParentAbort, { once: true })
  try {
    const explicit = { ...req.headers }
    // 会话 Cookie 自动携带（调用方显式 cookie 则优先）
    if (!('cookie' in explicit) && !('Cookie' in explicit)) {
      const jarCookie = cookieJar.getCookieStringSync(req.url)
      if (jarCookie) explicit.cookie = jarCookie
    }
    const res = await fetch(req.url, {
      method: req.method ?? 'GET',
      body: req.body,
      signal: ctl.signal,
      redirect: 'follow',
      headers: browserHeaders(
        req.userAgent,
        {
          ...(req.accept ? { accept: req.accept } : {}),
          ...explicit,
        },
        pickUaProfile(host),
      ),
    })
    const retryAfterMs = parseRetryAfter(res)
    if (res.status === 429) {
      await drain(res)
      throw new AntiBotError('rate-limit', 'HTTP 429（请求过于频繁）', { status: 429, retryAfterMs })
    }
    if (res.status === 403) {
      markBlocked(host)
      await drain(res)
      throw new AntiBotError('blocked', 'HTTP 403（网站拒绝访问，疑似风控）', { status: 403 })
    }
    if (res.status >= 500) {
      await drain(res)
      throw new AntiBotError('status', `HTTP ${res.status} ${res.statusText}`.trim(), {
        status: res.status,
        retryAfterMs,
      })
    }
    // content-length 预检（声明超限直接拒绝，不读流）
    const declared = Number(res.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > limits.maxBytes) {
      await drain(res)
      throw new AntiBotError('too-large', `响应过大（${Math.round(declared / 1024)}KB）`, { bytes: declared })
    }
    let text = ''
    if (req.readBody ?? true) {
      const buf = await readCapped(res, limits.maxBytes)
      if (!buf) {
        throw new AntiBotError('too-large', `响应超过 ${Math.round(limits.maxBytes / 1024)}KB 上限`)
      }
      text = decodeBody(buf, res.headers.get('content-type') ?? '')
    } else {
      await drain(res)
    }
    const finalUrl = res.url
    const blocked = detectBlockPage({ status: res.status, finalUrl, text })
    if (blocked) {
      markBlocked(host)
      throw new AntiBotError('blocked', blocked, { status: res.status })
    }
    if (!res.ok) {
      throw new AntiBotError('status', `HTTP ${res.status} ${res.statusText}`.trim(), { status: res.status })
    }
    const setCookies = (res.headers as { getSetCookie?(): string[] }).getSetCookie?.() ?? []
    // 会话 Cookie 入库（域/路径/过期语义由 tough-cookie 处理；非法 Cookie 忽略，不影响主流程）
    for (const raw of setCookies) {
      try {
        cookieJar.setCookieSync(raw, finalUrl, { ignoreError: true })
      } catch {
        // 极少数非标准 Cookie 解析失败 → 跳过
      }
    }
    return { status: res.status, ok: res.ok, statusText: res.statusText, finalUrl, headers: res.headers, text, setCookies }
  } catch (err) {
    if (err instanceof AntiBotError) throw err
    if (isAbortLike(err)) {
      if (timedOut) throw new AntiBotError('timeout', `请求超时（${limits.timeoutMs}ms）`)
      throw toolAbortError()
    }
    throw new AntiBotError('network', (err as Error).message.slice(0, 160))
  } finally {
    clearTimeout(timer)
    req.signal?.removeEventListener('abort', onParentAbort)
  }
}

/**
 * 反爬请求入口：冷却检查 → 同 host 排队 → 限速 → 请求/退避重试。
 * 成功返回结构化响应（含解码后的 text）；失败抛 AntiBotError（调用方按 kind 转提示）。
 */
export async function antiBotFetch(req: AntiBotRequest): Promise<AntiBotResponse> {
  const host = new URL(req.url).hostname
  const maxRetries = Math.max(0, req.maxRetries ?? 1)
  const limits = {
    timeoutMs: req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs : 15_000,
    maxBytes: req.maxBytes && req.maxBytes > 0 ? req.maxBytes : 512 * 1024,
  }
  const minIntervalMs = Math.max(0, req.minIntervalMs ?? 1_200)

  if (req.signal?.aborted) throw toolAbortError()
  assertNotCooling(host)

  return enqueue(host, async () => {
    // 排队期间同 host 其他请求可能已触发风控 → 出队前复查
    assertNotCooling(host)
    let lastErr: AntiBotError | undefined
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (req.signal?.aborted) throw toolAbortError()
      await waitForSlot(host, minIntervalMs)
      try {
        const res = await fetchOnce(req, host, limits)
        hostNextSlot.set(host, Date.now() + minIntervalMs)
        return res
      } catch (err) {
        hostNextSlot.set(host, Date.now() + minIntervalMs)
        if (!(err instanceof AntiBotError) || !isRetryable(err) || attempt >= maxRetries) throw err
        lastErr = err
        const wait = Math.min(err.retryAfterMs ?? RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_WAIT_MS)
        await sleep(wait)
      }
    }
    // 循环内必 return/throw；兜底仅保证类型收窄
    throw lastErr ?? new AntiBotError('network', '请求失败')
  })
}
