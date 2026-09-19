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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
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
    throw new ApiError(message, res.status, refs)
  }
  return (await res.json()) as T
}

export const apiGet = <T>(path: string): Promise<T> => request<T>(path)

export const apiPost = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

export const apiPatch = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) })

export const apiPut = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) })

export const apiDelete = <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' })

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
