/** HTTP 客户端：错误统一抛出中文 message（服务端 { error } 直通 toast） */

/** 统一 API 错误：携带状态码与 409 引用清单（M26 删除冲突的二次确认） */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly refs?: string[],
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** M57：全局 401 回调（登录态失效 → auth-store 翻转登录页；由 auth-store 注册） */
let unauthorizedHandler: (() => void) | undefined

export function setUnauthorizedHandler(handler: (() => void) | undefined): void {
  unauthorizedHandler = handler
}

export interface RequestOptions {
  signal?: AbortSignal
  /** 0 表示调用方自行控制时限；长任务可显式覆盖。 */
  timeoutMs?: number
}

async function request<T>(path: string, init?: RequestInit, options: RequestOptions = {}): Promise<T> {
  const controller = new AbortController()
  const abort = (): void => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
  const timeoutMs = options.timeoutMs ?? (init?.method && init.method !== 'GET' ? 180_000 : 60_000)
  let timedOut = false
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          controller.abort()
        }, timeoutMs)
      : undefined
  try {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
      signal: controller.signal,
    })
    if (!res.ok) {
      let message = `请求失败（HTTP ${res.status}）`
      let refs: string[] | undefined
      try {
        const data = (await res.json()) as { error?: string; refs?: string[] }
        if (data?.error) message = data.error
        if (Array.isArray(data?.refs)) refs = data.refs
      } catch {
        // 非 JSON 响应保留默认文案
      }
      // M57：401 → 通知全局回调（登录失效）；公开接口（登录失败等）由页面自行处理，回调内部按 phase 判空
      if (res.status === 401) unauthorizedHandler?.()
      throw new ApiError(message, res.status, refs)
    }
    return (await res.json()) as T
  } catch (err) {
    if (timedOut) {
      throw new ApiError(
        init?.method && init.method !== 'GET'
          ? '请求超时，操作可能已执行，请核对状态后再重试'
          : '请求超时，请稍后重试',
        0,
      )
    }
    throw err
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

export const apiGet = <T>(path: string, options?: RequestOptions): Promise<T> =>
  request<T>(path, undefined, options)

export const apiPost = <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }, options)

export const apiPatch = <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
  request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }, options)

export const apiPut = <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
  request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }, options)

export const apiDelete = <T>(path: string, options?: RequestOptions): Promise<T> =>
  request<T>(path, { method: 'DELETE' }, options)

/**
 * M33：原始二进制上传（附件通道）。
 * - 走 XHR 而非 fetch：上传进度事件是进度条的唯一来源；
 * - headers 携带 x-file-name（URL 编码）与 x-file-metadata（JSON）；
 * - 错误统一 ApiError（与服务端 { error } 直通一致）。
 */
export function apiUpload<T>(
  path: string,
  body: Blob,
  headers: Record<string, string>,
  onProgress?: (ratio: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // 信号可能在调用前就已中止（媒体元数据探测期间被取消）：abort 事件不会再触发，直接拒绝
    if (signal?.aborted) {
      reject(new ApiError('上传已取消', 0))
      return
    }
    const xhr = new XMLHttpRequest()
    xhr.open('POST', path)
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.min(1, e.loaded / e.total))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as T)
        } catch {
          reject(new ApiError('上传响应解析失败', xhr.status))
        }
        return
      }
      let message = `上传失败（HTTP ${xhr.status}）`
      try {
        const data = JSON.parse(xhr.responseText) as { error?: string }
        if (data?.error) message = data.error
      } catch {
        // 非 JSON 响应保留默认文案
      }
      reject(new ApiError(message, xhr.status))
    }
    xhr.onerror = () => reject(new ApiError('网络错误：上传失败', 0))
    xhr.onabort = () => reject(new ApiError('上传已取消', 0))
    signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(body)
  })
}
