/**
 * M31：媒体适配器共享 HTTP 工具（零依赖：Node 原生 fetch / FormData / AbortSignal）。
 * - fetchJson / fetchBuffer：统一超时（signal 透传）、非 2xx 抛带摘要错误；
 * - sleep：可中断等待（取消立即退出）；
 * - getPath：点路径取值（模板适配器状态 / 结果提取）；
 * - deepReplaceVars：工作流 / 请求体模板的 {{var}} 深替换（字符串值整体替换时保留原类型）。
 */

/** 可中断等待（signal aborted → 立即 reject AbortError） */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function abortError(): Error {
  const err = new Error('已取消')
  err.name = 'AbortError'
  return err
}

/** 请求头摘要（错误信息定位用；Authorization 等敏感头不记录） */
function describe(res: Response, body: string): string {
  const summary = body.length > 240 ? `${body.slice(0, 240)}…` : body
  return `HTTP ${res.status} ${res.statusText || ''}${summary ? `：${summary}` : ''}`
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  label: string,
): Promise<T> {
  const res = await fetch(url, { ...init, signal })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${label}失败：${describe(res, body)}`)
  }
  return (await res.json()) as T
}

export async function fetchBuffer(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  label: string,
): Promise<Buffer> {
  const res = await fetch(url, { ...init, signal })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${label}失败：${describe(res, body)}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

/** 点路径取值（'data.status' / 'output[0].url' 的简化版：仅 . 与 [n]） */
export function getPath(source: unknown, path: string): unknown {
  if (!path) return undefined
  let current: unknown = source
  for (const rawSegment of path.split('.')) {
    if (current === null || current === undefined) return undefined
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(rawSegment)
    if (!match) return undefined
    const [, key, indexes] = match
    if (key) {
      if (typeof current !== 'object') return undefined
      current = (current as Record<string, unknown>)[key]
    }
    for (const indexMatch of indexes?.matchAll(/\[(\d+)\]/g) ?? []) {
      if (!Array.isArray(current)) return undefined
      current = current[Number(indexMatch[1])]
    }
  }
  return current
}

/**
 * 深替换 {{var}} 占位符：
 * - 字符串值整体为单个占位符时保留变量原类型（number / object）；
 * - 混合字符串内联替换为字符串；
 * - 数组 / 对象递归；未命中的占位符原样保留（便于排查）。
 */
export function deepReplaceVars<T>(value: T, vars: Record<string, unknown>): T {
  if (typeof value === 'string') {
    const full = /^\{\{(\w+)\}\}$/.exec(value)
    if (full) {
      const key = full[1]!
      return (key in vars ? vars[key] : value) as T
    }
    return value.replace(/\{\{(\w+)\}\}/g, (raw, key: string) => {
      const v = vars[key]
      return v === undefined ? raw : String(v)
    }) as T
  }
  if (Array.isArray(value)) return value.map((item) => deepReplaceVars(item, vars)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = deepReplaceVars(item, vars)
    }
    return out as T
  }
  return value
}

/** 规范化 baseUrl（去尾斜杠） */
export function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/** 凭据头（secret.apiKey → Bearer；无凭据返回空对象） */
export function authHeaders(secret: Record<string, unknown>): Record<string, string> {
  const apiKey = typeof secret.apiKey === 'string' ? secret.apiKey.trim() : ''
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
}

/** 文件扩展名 → MIME（上传给远端时的 Content-Type；未知回退 octet-stream） */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
}

export function mimeOf(fileName: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(fileName)
  return (match && MIME_BY_EXT[match[1]!.toLowerCase()]) || 'application/octet-stream'
}
