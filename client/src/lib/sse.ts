/**
 * 手写 SSE 解析（§10.3，不用 EventSource 因为需要 POST 携带 body 与自定义取消）：
 * - TextDecoder 流式解码 → 按 \n\n 切事件块 → 聚合 data: 行 → JSON.parse；
 * - 心跳 / 无效块忽略；AbortError 静默转为 onEnd（用户切换会话等主动取消）；
 * - HTTP 订阅未命中（如 run 已结束 404）时 onEnd 携带 httpStatus——调用方据此刷新会话兜底（M52-D）。
 */
import type { RunEvent } from '@multi-agent/shared'

export interface SseHandlers {
  onEvent: (event: RunEvent) => void
  /** 流结束：正常结束 / 主动取消无参；HTTP 订阅未命中携带 httpStatus（如 404 = run 已结束） */
  onEnd: (info?: { httpStatus?: number }) => void
  onError: (error: Error) => void
}

/** 从缓冲区提取完整事件块（纯函数，可单测） */
export function extractSseEvents(buffer: string): { blocks: string[]; rest: string } {
  const blocks: string[] = []
  let rest = buffer
  let idx = rest.indexOf('\n\n')
  while (idx !== -1) {
    blocks.push(rest.slice(0, idx))
    rest = rest.slice(idx + 2)
    idx = rest.indexOf('\n\n')
  }
  return { blocks, rest }
}

/** 从事件块解析 data 载荷（纯函数，可单测） */
export function parseSseBlock(block: string): RunEvent | null {
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    // ':' 开头为注释（心跳），忽略
  }
  if (dataLines.length === 0) return null
  try {
    return JSON.parse(dataLines.join('\n')) as RunEvent
  } catch {
    return null
  }
}

/** 订阅运行流：返回 promise，流结束 resolve（错误走 onError 后也 resolve） */
export async function streamRun(
  url: string,
  handlers: SseHandlers,
  signal: AbortSignal,
): Promise<void> {
  let ended = false
  const endOnce = (info?: { httpStatus?: number }): void => {
    if (!ended) {
      ended = true
      handlers.onEnd(info)
    }
  }
  try {
    const res = await fetch(url, { signal, headers: { Accept: 'text/event-stream' } })
    if (!res.ok || !res.body) {
      // 404（run 已结束）等：携带状态交由调用方刷新会话兜底
      endOnce(!res.ok ? { httpStatus: res.status } : undefined)
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const { blocks, rest } = extractSseEvents(buffer)
      buffer = rest
      for (const block of blocks) {
        const event = parseSseBlock(block)
        if (event) handlers.onEvent(event)
      }
    }
    // 残余缓冲兜底
    const tail = parseSseBlock(buffer)
    if (tail) handlers.onEvent(tail)
    endOnce()
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      endOnce()
      return
    }
    handlers.onError(err as Error)
    endOnce()
  }
}
