/**
 * 联网出口层（M82 P0）：统一解析并执行外网请求的出口——直连 / HTTP(S) 代理 / SOCKS5。
 *
 * 定位：所有 Node 侧抓取（web_search / web_fetch / 财经 Node 源，均经 tools/http.ts 的
 * antiBotFetch）与后续通道（浏览器 / MCP / LLM，见专项设计 §13 P1）的**唯一**出口决策点。
 *
 * 关键语义：
 * - 默认零回归：未配置出口（egressMode=direct）时一律走全局 fetch，行为与历史完全一致；
 * - 按通道路由：仅 cfg.egressChannels 列出的通道跟随全局出口（默认 search/finance/browser），
 *   未列出的通道恒直连（防「为爬虫配了代理，把本地/国内模型端点打挂」）；
 * - 旁路优先：回环（localhost/127.x/::1）恒直连（本地服务安全红线），另按 egressNoProxy +
 *   连接级 bypass 规则（域后缀 / IP / CIDR）跳过代理；
 * - 错误分类隔离：出口层失败（连不上代理 / 407 / CONNECT 失败）包装为 EgressError，
 *   由 antiBotFetch 转 AntiBotError('egress')——**不**计入目标 host 的风控冷却；
 * - 失败回退：egressFallback='direct' 时出口失败即以直连重试一次并标注；连续 2 次失败进入
 *   60s 冷却（冷却期内直接直连，不再重撞代理）；'fail' 模式（合规严格）绝不回退；
 * - 结果标注：每个响应用 WeakMap 附带出口元信息（egressMetaOf），供工具 summary 标注实际出口。
 *
 * 依赖说明（已实测）：npm undici 的 ProxyAgent 与 Node 内置 fetch **不兼容**
 * （UND_ERR_INVALID_ARG: invalid onRequestStart），因此代理路径统一使用同包 undici.fetch，
 * 保证 dispatcher 与实现同版本；直连路径保持全局 fetch（零行为变化）。
 */
import { Pool, ProxyAgent, fetch as undiciFetch } from 'undici'
import type { AppConfig } from '../config.js'
import type { ConnectionStore } from '../store/connections.js'
import { getLogger } from '../logger.js'

/** 出口通道（未列出的通道恒直连；浏览器/子进程接入见 P1） */
export type EgressChannel = 'search' | 'finance' | 'browser' | 'mcp' | 'llm'

export const EGRESS_CHANNELS: readonly EgressChannel[] = ['search', 'finance', 'browser', 'mcp', 'llm']

/** 默认直连旁路（回环另有无条件硬编码，防配置遗漏） */
export const DEFAULT_EGRESS_NO_PROXY: readonly string[] = [
  'localhost',
  '127.0.0.1',
  '::1',
  '*.local',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
]

/** 连续失败升级为「出口降级」的阈值 */
export const EGRESS_FAIL_THRESHOLD = 2
/** 出口降级冷却时长（冷却期内直接直连，到期自动重试代理） */
export const EGRESS_COOLDOWN_MS = 60_000
/** 出口探测默认超时（ms） */
export const EGRESS_PROBE_TIMEOUT_MS = 10_000

/** 出口目标（连接 config + secret 归一后的形态；不含归属信息） */
export interface EgressTarget {
  /** http = HTTP(S) 代理；socks5 = SOCKS5 代理（远端 DNS） */
  mode: 'http' | 'socks5'
  /** mode=http 时到代理本身的协议（https = 代理链路走 TLS） */
  scheme: 'http' | 'https'
  host: string
  port: number
  username?: string
  password?: string
  /** 连接级直连旁路（与全局 egressNoProxy 求并集） */
  bypass: string[]
  /** 连接超时（ms；缺省 = 跟随请求超时） */
  connectTimeoutMs?: number
}

/** 出口绑定 = 目标 + 归属（连接中心条目或 EGRESS_PROXY_URL 后备） */
export interface EgressBinding extends EgressTarget {
  id: string
  name: string
}

/** 直连原因（诊断与标注） */
export type EgressDirectReason = 'unconfigured' | 'channel-off' | 'bypass' | 'degraded' | 'fallback'

export interface EgressRouteInfo {
  kind: 'direct' | 'proxy'
  reason?: EgressDirectReason
  binding?: EgressBinding
}

/** 响应级出口元信息（WeakMap 附加，避免并发串味） */
export interface EgressMeta {
  /** true = 本请求经出口代理发出 */
  used: boolean
  bindingName?: string
  reason?: EgressDirectReason
  /** true = 代理不可用后回退直连 */
  fallback?: boolean
  /** 回退原因（脱敏后的错误摘要） */
  error?: string
}

export interface EgressProbeResult {
  ok: boolean
  /** 出口 IP（探测地址回显可解析时） */
  exitIp?: string
  latencyMs?: number
  /** 探测响应摘要（截断） */
  detail?: string
  error?: string
}

export interface EgressStatus {
  mode: 'direct' | 'proxy'
  state: 'direct' | 'proxied' | 'degraded'
  bindingName?: string
  /** 绑定是否解析失败（连接缺失 / 被禁用 / 配置非法） */
  bindingError?: string
  channels: EgressChannel[]
  fails: number
  coolingUntil?: string
  lastOkAt?: string
  lastError?: string
  lastProbe?: { at: string; ok: boolean; exitIp?: string; latencyMs?: number; error?: string }
}

/** 出口层错误（代理不可达 / 鉴权失败等；由调用方转 AntiBotError('egress')） */
export class EgressError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EgressError'
  }
}

/** 出口请求初始化（窄接口：避免 DOM / undici 两套 RequestInit 类型摩擦） */
export interface EgressFetchInit {
  method?: string
  body?: string
  headers?: Record<string, string>
  signal?: AbortSignal
  redirect?: 'follow' | 'manual' | 'error'
}

// ---------- 纯函数：配置解析与旁路匹配 ----------

/** 连接 config + secret → 出口目标（校验失败给出中文原因，供表单与运行期共用） */
export function parseEgressTarget(
  config: Record<string, unknown>,
  secret?: Record<string, unknown>,
): { ok: true; target: EgressTarget } | { ok: false; error: string } {
  const modeRaw = typeof config.mode === 'string' ? config.mode.trim().toLowerCase() : 'http'
  if (modeRaw === 'ssh') {
    return { ok: false, error: 'SSH 隧道出口将在 P1 提供（当前请使用 HTTP(S) 代理或 SOCKS5）' }
  }
  if (modeRaw !== 'http' && modeRaw !== 'socks5') {
    return { ok: false, error: `出口形态非法：${modeRaw || '(空)'}（需 http / socks5）` }
  }
  const schemeRaw = typeof config.scheme === 'string' ? config.scheme.trim().toLowerCase() : 'http'
  if (modeRaw === 'http' && schemeRaw !== 'http' && schemeRaw !== 'https') {
    return { ok: false, error: `代理协议非法：${schemeRaw}（需 http / https）` }
  }
  const host = typeof config.host === 'string' ? config.host.trim() : ''
  if (!host) return { ok: false, error: '代理地址（host）必填' }
  if (/\s|[/@]/.test(host)) return { ok: false, error: '代理地址不得包含空格、斜杠或 @（只填主机名 / IP）' }
  const port = typeof config.port === 'number' ? config.port : Number(String(config.port ?? '').trim())
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return { ok: false, error: '代理端口非法（需 1–65535）' }
  const bypass = Array.isArray(config.bypass)
    ? config.bypass.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim())
    : []
  const timeoutRaw = typeof config.connectTimeoutMs === 'number' ? config.connectTimeoutMs : Number.NaN
  const connectTimeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.min(timeoutRaw, 120_000) : undefined
  const username =
    typeof secret?.username === 'string' && secret.username.trim().length > 0 ? secret.username.trim() : undefined
  const password = typeof secret?.password === 'string' && secret.password.length > 0 ? secret.password : undefined
  return {
    ok: true,
    target: {
      mode: modeRaw,
      scheme: modeRaw === 'socks5' ? 'http' : schemeRaw === 'https' ? 'https' : 'http',
      host,
      port,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
      bypass,
      ...(connectTimeoutMs ? { connectTimeoutMs } : {}),
    },
  }
}

/** EGRESS_PROXY_URL（env 后备；http(s):// / socks5://，凭据可嵌 userinfo）→ 绑定 */
export function parseEgressProxyUrl(raw: string): { ok: true; binding: EgressBinding } | { ok: false; error: string } {
  const text = raw.trim()
  if (!text) return { ok: false, error: 'EGRESS_PROXY_URL 为空' }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, error: `EGRESS_PROXY_URL 非法（${maskUrl(text)}）` }
  }
  const proto = url.protocol.replace(':', '').toLowerCase()
  const mode: 'http' | 'socks5' | undefined =
    proto === 'socks5' || proto === 'socks' ? 'socks5' : proto === 'http' || proto === 'https' ? 'http' : undefined
  if (!mode) return { ok: false, error: `EGRESS_PROXY_URL 协议不支持：${proto}（需 http / https / socks5）` }
  const port = url.port ? Number(url.port) : mode === 'socks5' ? 1080 : 8080
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return { ok: false, error: 'EGRESS_PROXY_URL 端口非法' }
  return {
    ok: true,
    binding: {
      id: 'env',
      name: 'EGRESS_PROXY_URL',
      mode,
      scheme: mode === 'http' && proto === 'https' ? 'https' : 'http',
      host: url.hostname,
      port,
      ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
      bypass: [],
    },
  }
}

/** 凭据脱敏（日志 / 错误消息用；只保留协议与主机端口） */
export function maskUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return raw.replace(/\/\/[^@/]*@/, '//***@')
  }
}

/** IPv4 字面量 → 32 位整数 */
function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split('.')
  if (parts.length !== 4) return undefined
  let out = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const value = Number(part)
    if (value > 255) return undefined
    out = ((out << 8) | value) >>> 0
  }
  return out
}

/** host 是否命中旁路规则（回环恒命中；支持域后缀 / 裸域名 / IP / IPv4 CIDR） */
export function hostBypassed(hostname: string, rules: readonly string[] = []): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return false
  // 本地服务安全红线：回环恒直连（配置遗漏也不经代理）
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host)) return true
  for (const raw of rules) {
    const rule = raw.trim().toLowerCase()
    if (!rule) continue
    if (rule.startsWith('*.')) {
      if (host.endsWith(rule.slice(1))) return true
      continue
    }
    if (rule.includes('/')) {
      const [netRaw, bitsRaw] = rule.split('/')
      const bits = Number(bitsRaw)
      const net = ipv4ToInt(netRaw ?? '')
      const target = ipv4ToInt(host)
      if (net === undefined || target === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) continue
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
      if (((target & mask) >>> 0) === ((net & mask) >>> 0)) return true
      continue
    }
    if (host === rule || host.endsWith(`.${rule}`)) return true
  }
  return false
}

/** 出口失败 → 中文可读消息（保留底层 cause 摘要，便于排障；绝不含凭据） */
export function egressErrorMessage(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err)
  const cause = (err as { cause?: unknown } | undefined)?.cause
  const causeMsg = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  const detail = causeMsg && !base.includes(causeMsg) ? `${base}: ${causeMsg}` : base
  if (/407/.test(detail)) return '出口代理鉴权失败（HTTP 407）：请检查代理账号口令'
  if (/ECONNREFUSED/i.test(detail)) return '出口代理拒绝连接（ECONNREFUSED）：请检查地址与端口'
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(detail)) return '出口代理域名不可解析（DNS 失败）：请检查代理地址'
  if (/CONNECT_TIMEOUT|ETIMEDOUT|timeout/i.test(detail)) return '出口代理连接超时：请检查网络与代理服务'
  if (/SOCKS|socks/i.test(detail)) return `SOCKS5 出口不可用（${detail.slice(0, 120)}）`
  return `出口请求失败：${detail.slice(0, 160)}`
}

const isAbortLike = (err: unknown): boolean => err instanceof Error && err.name === 'AbortError'

/** 探测响应体上限（防超大页面） */
const PROBE_MAX_CHARS = 8_192

/** 从探测响应解析出口 IP（JSON {ip} / 文本回显均可） */
export function extractExitIp(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      for (const key of ['ip', 'origin', 'query', 'clientIp', 'client_ip']) {
        const value = parsed[key]
        if (typeof value === 'string' && value.trim()) return value.trim().split(',')[0]!.trim()
      }
    } catch {
      // 非 JSON → 继续正则
    }
  }
  const v4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/.exec(trimmed)
  if (v4) return v4[0]
  const v6 = /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/.exec(trimmed)
  return v6?.[0]
}

// ---------- 运行期：出口运行时（进程级单例） ----------

export interface EgressRuntimeDeps {
  cfg: AppConfig
  connections: ConnectionStore
}

/** 响应 → 出口元信息（WeakMap；跨并发安全） */
const metaMap = new WeakMap<object, EgressMeta>()

export class EgressRuntime {
  private readonly agents = new Map<string, ProxyAgent>()
  /** 绑定解析缓存（键 = 连接 id + updatedAt；避免每请求解密凭据） */
  private bindingCache: { key: string; binding?: EgressBinding; error?: string } | undefined
  private fails = 0
  private coolingUntil = 0
  private lastOkAt?: string
  private lastError?: string
  private lastProbe: EgressStatus['lastProbe']
  private warnedKey?: string

  constructor(private readonly deps: EgressRuntimeDeps) {}

  /** 当前绑定（连接中心引用 > EGRESS_PROXY_URL 后备；解析失败给出原因） */
  private binding(): { binding?: EgressBinding; error?: string } {
    const cfg = this.deps.cfg
    if (cfg.egressConnectionId) {
      const connection = this.deps.connections.get(cfg.egressConnectionId)
      const key = `${cfg.egressConnectionId}|${connection?.updatedAt ?? 'missing'}`
      if (this.bindingCache?.key === key) return this.bindingCache
      if (!connection) {
        return this.cacheBinding(key, undefined, `出口连接不存在（${cfg.egressConnectionId}）：请在设置 → 联网与出网中重新选择`)
      }
      if (connection.kind !== 'proxy') {
        return this.cacheBinding(key, undefined, `出口连接「${connection.name}」类型不是 proxy（${connection.kind}）`)
      }
      if (!connection.enabled) {
        return this.cacheBinding(key, undefined, `出口连接「${connection.name}」已禁用`)
      }
      const parsed = parseEgressTarget(connection.config, this.deps.connections.getSecret(connection.id))
      if (!parsed.ok) return this.cacheBinding(key, undefined, `出口连接「${connection.name}」配置非法：${parsed.error}`)
      return this.cacheBinding(key, { id: connection.id, name: connection.name, ...parsed.target })
    }
    if (cfg.egressProxyUrl.trim()) {
      const key = `env|${cfg.egressProxyUrl}`
      if (this.bindingCache?.key === key) return this.bindingCache
      const parsed = parseEgressProxyUrl(cfg.egressProxyUrl)
      if (!parsed.ok) return this.cacheBinding(key, undefined, parsed.error)
      return this.cacheBinding(key, parsed.binding)
    }
    // 未配置：清缓存并返回空（不告警——默认零回归路径）
    this.bindingCache = undefined
    return {}
  }

  private cacheBinding(key: string, binding?: EgressBinding, error?: string): { binding?: EgressBinding; error?: string } {
    this.bindingCache = { key, ...(binding ? { binding } : {}), ...(error ? { error } : {}) }
    return this.bindingCache
  }

  /** 启用守卫：模式 + 通道 + 绑定可用（不含旁路判定） */
  private enabledFor(channel: EgressChannel): { binding?: EgressBinding; error?: string } {
    const cfg = this.deps.cfg
    if (cfg.egressMode !== 'proxy') return {}
    if (!cfg.egressChannels.includes(channel)) return {}
    return this.binding()
  }

  /** 路由解析（旁路 / 降级冷却 / 通道门控后的最终决策） */
  resolveRoute(channel: EgressChannel, url: string): EgressRouteInfo {
    const { binding, error } = this.enabledFor(channel)
    if (!binding) {
      if (error) this.warnOnce(error)
      return { kind: 'direct', reason: 'unconfigured' }
    }
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {
      return { kind: 'direct', reason: 'bypass' }
    }
    if (hostBypassed(host, [...this.deps.cfg.egressNoProxy, ...binding.bypass])) {
      return { kind: 'direct', reason: 'bypass' }
    }
    if (this.coolingUntil > Date.now() && this.deps.cfg.egressFallback === 'direct') {
      return { kind: 'direct', reason: 'degraded', binding }
    }
    return { kind: 'proxy', binding }
  }

  /** 是否处于降级冷却（面板 / 诊断） */
  degraded(): boolean {
    return this.coolingUntil > Date.now()
  }

  private warnOnce(message: string): void {
    if (this.warnedKey === message) return
    this.warnedKey = message
    getLogger().warn({ egress: message }, '出口配置不可用，已回落直连')
  }

  private agentKey(binding: EgressBinding): string {
    const auth = binding.username ? `${binding.username}:${binding.password ?? ''}` : ''
    return `${binding.mode}|${binding.scheme}|${binding.host}:${binding.port}|${auth}`
  }

  /** dispatcher 缓存（同绑定复用连接池；配置变更由 invalidate 关闭重建） */
  private agentFor(binding: EgressBinding): ProxyAgent {
    const key = this.agentKey(binding)
    let agent = this.agents.get(key)
    if (agent) return agent
    const uri = `${binding.mode === 'socks5' ? 'socks5' : binding.scheme}://${binding.host}:${binding.port}`
    // 凭据载体按形态区分（实测）：HTTP(S) 代理 → token（proxy-authorization）；
    // SOCKS5 → username/password 选项（ProxyAgent 转发给 Socks5ProxyAgent 做 RFC 1929 握手，token 对其无效）
    const authOptions: Record<string, string> =
      binding.mode === 'socks5'
        ? binding.username
          ? { username: binding.username, password: binding.password ?? '' }
          : {}
        : binding.username
          ? { token: `Basic ${Buffer.from(`${binding.username}:${binding.password ?? ''}`).toString('base64')}` }
          : {}
    agent = new ProxyAgent({
      uri,
      ...authOptions,
      // 代理连接超时：经由 clientFactory 注入（ProxyAgent 本体不透传 connect 选项）
      ...(binding.connectTimeoutMs
        ? {
            clientFactory: (origin: URL, opts: object) =>
              new Pool(origin, { ...(opts as Pool.Options), connect: { timeout: binding.connectTimeoutMs } }),
          }
        : {}),
    })
    this.agents.set(key, agent)
    return agent
  }

  private onSuccess(): void {
    this.fails = 0
    this.coolingUntil = 0
    this.lastOkAt = new Date().toISOString()
    this.lastError = undefined
  }

  private onFailure(message: string): void {
    this.fails += 1
    this.lastError = message
    if (this.fails >= EGRESS_FAIL_THRESHOLD) this.coolingUntil = Date.now() + EGRESS_COOLDOWN_MS
  }

  /**
   * 出口请求入口：直连（零回归）/ 代理（undici.fetch + ProxyAgent）/ 失败回退。
   * 返回值语义与全局 fetch 一致（Response）；出口元信息经 egressMetaOf(response) 读取。
   */
  async fetch(channel: EgressChannel, url: string, init: EgressFetchInit = {}): Promise<Response> {
    const route = this.resolveRoute(channel, url)
    if (route.kind === 'direct') {
      const res = await fetch(url, this.domInit(init))
      // 降级/旁路等直连原因也标注（供工具层提示「代理不可用已直连」）
      if (route.reason === 'degraded' || route.reason === 'fallback') {
        metaMap.set(res, { used: false, reason: route.reason })
      }
      return res
    }
    const binding = route.binding!
    const agent = this.agentFor(binding)
    try {
      const res = (await undiciFetch(url, {
        method: init.method,
        body: init.body,
        headers: init.headers,
        signal: init.signal,
        redirect: init.redirect,
        dispatcher: agent,
      })) as unknown as Response
      this.onSuccess()
      metaMap.set(res, { used: true, bindingName: binding.name })
      return res
    } catch (err) {
      if (isAbortLike(err)) throw err
      const message = egressErrorMessage(err)
      this.onFailure(message)
      getLogger().debug({ binding: binding.name, err: message }, '出口代理请求失败')
      if (this.deps.cfg.egressFallback === 'direct') {
        // 回退直连（仅一次）；直连也失败则抛原始错误（按普通网络错误处理，保留既有软封锁语义）
        const res = await fetch(url, this.domInit(init))
        metaMap.set(res, { used: false, fallback: true, error: message, reason: 'fallback' })
        return res
      }
      throw new EgressError(message)
    }
  }

  /** 出口元信息（未配置/直连/旁路时可能为空对象 → undefined） */
  metaOf(res: Response): EgressMeta | undefined {
    return metaMap.get(res)
  }

  /** 出口探测：经指定绑定（或当前配置）请求 egressProbeUrl，回显出口 IP 与延迟 */
  async probe(input: { connectionId?: string } = {}): Promise<EgressProbeResult> {
    const cfg = this.deps.cfg
    let binding: EgressBinding | undefined
    if (input.connectionId) {
      const connection = this.deps.connections.get(input.connectionId)
      if (!connection) return { ok: false, error: '连接不存在' }
      if (connection.kind !== 'proxy') return { ok: false, error: `连接「${connection.name}」不是出口代理类型（${connection.kind}）` }
      const parsed = parseEgressTarget(connection.config, this.deps.connections.getSecret(connection.id))
      if (!parsed.ok) return { ok: false, error: parsed.error }
      binding = { id: connection.id, name: connection.name, ...parsed.target }
    } else {
      const resolved = this.binding()
      if (!resolved.binding) return { ok: false, error: resolved.error ?? '未配置出口（设置 → 联网与出网）' }
      binding = resolved.binding
    }
    const probeUrl = cfg.egressProbeUrl.trim()
    if (!probeUrl) return { ok: false, error: '未配置出口探测地址（egressProbeUrl）' }

    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), EGRESS_PROBE_TIMEOUT_MS)
    const started = Date.now()
    try {
      const res = (await undiciFetch(probeUrl, {
        signal: ctl.signal,
        redirect: 'follow',
        dispatcher: this.agentFor(binding),
      })) as unknown as Response
      const raw = await res.text()
      const latencyMs = Date.now() - started
      const exitIp = extractExitIp(raw.slice(0, PROBE_MAX_CHARS))
      const detail = `HTTP ${res.status} · ${latencyMs}ms${exitIp ? ` · 出口 IP ${exitIp}` : ''}`
      if (!res.ok) {
        const result: EgressProbeResult = { ok: false, latencyMs, error: `探测地址返回 HTTP ${res.status}`, detail }
        this.lastProbe = { at: new Date().toISOString(), ok: false, latencyMs, error: result.error }
        return result
      }
      this.onSuccess()
      this.lastProbe = { at: new Date().toISOString(), ok: true, exitIp, latencyMs }
      return { ok: true, latencyMs, ...(exitIp ? { exitIp } : {}), detail }
    } catch (err) {
      const message = isAbortLike(err) ? `出口探测超时（${EGRESS_PROBE_TIMEOUT_MS}ms）` : egressErrorMessage(err)
      this.onFailure(message)
      this.lastProbe = { at: new Date().toISOString(), ok: false, error: message }
      return { ok: false, error: message }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 出口状态（面板 / 诊断） */
  status(): EgressStatus {
    const cfg = this.deps.cfg
    const { binding, error } = this.enabledFor('search')
    const active = cfg.egressMode === 'proxy' ? (binding ?? this.binding().binding) : undefined
    const state: EgressStatus['state'] =
      cfg.egressMode !== 'proxy' ? 'direct' : this.degraded() ? 'degraded' : active ? 'proxied' : 'direct'
    return {
      mode: cfg.egressMode,
      state,
      ...(active ? { bindingName: active.name } : {}),
      ...(error ? { bindingError: error } : {}),
      channels: [...cfg.egressChannels],
      fails: this.fails,
      ...(this.coolingUntil > Date.now() ? { coolingUntil: new Date(this.coolingUntil).toISOString() } : {}),
      ...(this.lastOkAt ? { lastOkAt: this.lastOkAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastProbe ? { lastProbe: this.lastProbe } : {}),
    }
  }

  /** 配置变更失效：关闭连接池并复位失败状态（连接被改/删/停用后调用） */
  async invalidate(connectionId?: string): Promise<void> {
    if (connectionId && this.deps.cfg.egressConnectionId !== connectionId && connectionId !== 'env') return
    const agents = [...this.agents.values()]
    this.agents.clear()
    this.bindingCache = undefined
    this.fails = 0
    this.coolingUntil = 0
    this.lastError = undefined
    this.warnedKey = undefined
    await Promise.all(agents.map((agent) => agent.close().catch(() => undefined)))
  }

  /** 测试辅助：复位全部运行期状态（不关闭连接池以避免异步泄漏告警） */
  reset(): void {
    this.agents.clear()
    this.bindingCache = undefined
    this.fails = 0
    this.coolingUntil = 0
    this.lastOkAt = undefined
    this.lastError = undefined
    this.lastProbe = undefined
    this.warnedKey = undefined
  }

  /** DOM fetch 的窄参数（直连路径；字段与 EgressFetchInit 一一对应） */
  private domInit(init: EgressFetchInit): RequestInit {
    return {
      ...(init.method ? { method: init.method } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.headers ? { headers: init.headers } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
      ...(init.redirect ? { redirect: init.redirect } : {}),
    }
  }
}

// ---------- 进程级单例（http.ts 等无 DI 调用方使用） ----------

let activeRuntime: EgressRuntime | undefined

/** 装配出口层（index.ts 启动时调用；返回实例供路由 / 诊断使用） */
export function configureEgress(deps: EgressRuntimeDeps): EgressRuntime {
  activeRuntime = new EgressRuntime(deps)
  return activeRuntime
}

export function egressRuntime(): EgressRuntime | undefined {
  return activeRuntime
}

/** 出口请求入口（未装配 → 全局 fetch，零回归） */
export function egressFetch(channel: EgressChannel, url: string, init: EgressFetchInit = {}): Promise<Response> {
  return activeRuntime ? activeRuntime.fetch(channel, url, init) : fetch(url, init as RequestInit)
}

/** 响应出口元信息（未装配 / 直连未标注 → undefined） */
export function egressMetaOf(res: Response): EgressMeta | undefined {
  return metaMap.get(res)
}

/** 工具 summary 出口标注（无出口参与时返回空串） */
export function egressNoteOf(meta?: EgressMeta): string {
  if (!meta) return ''
  if (meta.used) return meta.bindingName ? `（出口：${meta.bindingName}）` : '（经出口代理）'
  if (meta.fallback) return '（出口代理不可用，已直连）'
  if (meta.reason === 'degraded') return '（出口代理降级中，已直连）'
  return ''
}
