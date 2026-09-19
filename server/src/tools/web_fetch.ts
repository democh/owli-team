/**
 * web_fetch 工具（M5，反爬增强）：抓取白名单域名的网页并转纯文本（供查阅文档）。
 * - 默认禁用：WEB_FETCH_ALLOWED_DOMAINS 为空时工具不可用（模型会收到明确提示）；
 * - 只读 → 可并行 + 幂等缓存；重定向后的最终域名同样必须命中白名单；
 * - 反爬（tools/http.ts 统一实现）：浏览器头 / 域名限速 / 退避重试 / 超时 /
 *   风控页识别与冷却 / GBK 等字符集解码 / 流式体积上限。
 */
import { z } from 'zod'
import { AntiBotError, antiBotFetch } from './http.js'
import { WEB_FETCH_DISABLED_SUMMARY } from './availability.js'
import { toolAbortError, type ToolRuntime, type ToolResult } from './registry.js'
import { htmlToText } from './text.js'

// 兼容既有引用（实现迁至 ./text.js）
export { htmlToText } from './text.js'

/** 响应体上限（防超大页面拖垮上下文/内存） */
const MAX_BYTES = 512 * 1024
/** 转文本后的回灌上限（字符） */
const MAX_CHARS = 8_000

/** 域名白名单匹配：允许精确域名或子域（白名单项小写、无前导点） */
export function domainAllowed(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase()
  return allowlist.some((d) => {
    const dom = d.toLowerCase().replace(/^\./, '')
    return dom !== '' && (h === dom || h.endsWith(`.${dom}`))
  })
}

/** AntiBotError → 模型可读提示（保留既有文案：响应过大 / 抓取失败） */
function antiBotMessage(err: AntiBotError): string {
  switch (err.kind) {
    case 'blocked':
      return `抓取被网站风控拦截：${err.message}（已暂停对该域名的访问，可稍后重试）`
    case 'rate-limit':
      return '抓取失败：HTTP 429（网站限流，请稍后重试）'
    case 'timeout':
      return `抓取超时（${err.message}）`
    case 'too-large':
      return err.bytes
        ? `响应过大（${Math.round(err.bytes / 1024)}KB，上限 512KB），已拒绝`
        : '响应过大（超过 512KB 上限），已拒绝'
    case 'network':
      return `抓取出错：${err.message}`
    case 'status':
      return `抓取失败：HTTP ${err.status ?? '未知'}`
  }
}

export const webFetchTool = {
  name: 'web_fetch',
  tier: 'deferred' as const,
  readOnly: true,
  description:
    '抓取指定 URL 的网页内容并转为纯文本（仅允许访问配置过的白名单域名）。需要查阅外部文档时使用；默认未配置白名单时不可用，请先请用户开启。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整 URL（http/https）' },
    },
    required: ['url'],
  },
  schema: z.object({ url: z.string().url() }),
  async execute(args: { url: string }, ctx: ToolRuntime): Promise<ToolResult> {
    if (ctx.webFetchAllowedDomains.length === 0) {
      return { ok: false, summary: WEB_FETCH_DISABLED_SUMMARY }
    }
    let parsed: URL
    try {
      parsed = new URL(args.url)
    } catch {
      return { ok: false, summary: `URL 无效：${args.url}` }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, summary: `仅支持 http/https（收到 ${parsed.protocol}）` }
    }
    if (!domainAllowed(parsed.hostname, ctx.webFetchAllowedDomains)) {
      return {
        ok: false,
        summary: `域名不在白名单：${parsed.hostname}（允许：${ctx.webFetchAllowedDomains.join('、')}）`,
      }
    }

    try {
      const res = await antiBotFetch({
        url: args.url,
        signal: ctx.signal,
        userAgent: ctx.httpUserAgent,
        timeoutMs: ctx.httpTimeoutMs,
        minIntervalMs: ctx.httpMinIntervalMs,
        maxBytes: MAX_BYTES,
      })
      // 重定向可能跳到白名单外 → 校验最终地址
      const finalHost = new URL(res.finalUrl).hostname
      if (!domainAllowed(finalHost, ctx.webFetchAllowedDomains)) {
        return { ok: false, summary: `重定向到白名单外域名：${finalHost}，已拒绝返回内容` }
      }
      if (!res.ok) {
        return { ok: false, summary: `抓取失败：HTTP ${res.status} ${res.statusText}`.trim() }
      }
      if (ctx.signal?.aborted) throw toolAbortError()

      const contentType = res.headers.get('content-type') ?? ''
      let text = res.text
      if (contentType.includes('html') || /^\s*<(!doctype|html)/i.test(text)) text = htmlToText(text)
      if (text.trim().length === 0) {
        return { ok: true, summary: `已抓取 ${finalHost}（内容为空）`, detail: '（页面无可读文本内容）' }
      }
      const truncated = text.length > MAX_CHARS
      return {
        ok: true,
        summary: `已抓取 ${finalHost}（${text.length} 字符${truncated ? '，已截断' : ''}）`,
        detail: truncated ? `${text.slice(0, MAX_CHARS)}\n…（内容超长已截断）` : text,
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw toolAbortError()
      if (err instanceof AntiBotError) return { ok: false, summary: antiBotMessage(err) }
      return { ok: false, summary: `抓取出错：${(err as Error).message.slice(0, 160)}` }
    }
  },
}
