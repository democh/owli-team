/**
 * M79-V：run 流断流自动重连（attach 重试语义）。
 * - 断流后自动重附着：无需刷新，最终收束（active 回落）且不打扰（重试期间无提示）；
 * - 重试耗尽：刷新兜底（refreshMessages）+ 一次性提示；
 * - 主动取消（detach）：不重试、不兜底。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => {
  const toastFn = vi.fn()
  return { toast: Object.assign(toastFn, { error: vi.fn(), success: vi.fn(), info: vi.fn() }) }
})

import { toast } from 'sonner'
import { useRunStore } from '../src/stores/run-store'
import { useSessionStore } from '../src/stores/session-store'

const fetchMock = vi.fn()

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/** 200 SSE 流：先下发 events，随后按 mode 断流（error）或正常关闭 */
function streamResponse(events: Array<Record<string, unknown>>, mode: 'error' | 'close'): Response {
  const encoder = new TextEncoder()
  let i = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < events.length) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(events[i++])}\n\n`))
        return
      }
      if (mode === 'error') controller.error(new Error('network down'))
      else controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

/** 挂起流：signal 中止时以 AbortError 结束（模拟真实 fetch 的取消语义） */
function hangingResponse(signal: AbortSignal): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
    },
  })
  return new Response(stream, { status: 200 })
}

const streamCalls = (): number => fetchMock.mock.calls.filter((c) => String(c[0]).includes('/stream')).length
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  useSessionStore.setState({
    currentId: 's_1',
    sessions: [{ id: 's_1', title: 'T' }] as never,
    loadSessions: vi.fn().mockResolvedValue(undefined),
    refreshMessages: vi.fn().mockResolvedValue(undefined),
  } as never)
  useRunStore.setState({ active: false, runId: undefined, sessionId: undefined, approvals: [] })
})

afterEach(() => {
  useRunStore.getState().detach()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('M79-V：run 流断流自动重连', () => {
  it('断流后 3s 自动重附着并正常收束（重试期间无提示打扰）', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ approvals: [] })) // 审批恢复
      .mockResolvedValueOnce(
        streamResponse([{ type: 'run:start', runId: 'r_1', sessionId: 's_1', queue: [] }], 'error'),
      )
      .mockResolvedValueOnce(jsonResponse({ approvals: [] })) // 重试时的审批恢复
      .mockResolvedValueOnce(streamResponse([{ type: 'run:end', sessionId: 's_1', reason: 'completed' }], 'close'))

    useRunStore.getState().attach('r_1', 's_1')
    await flushMicrotasks()
    // 首次流中断 → 进入 3s 退避（尚未重试）
    expect(streamCalls()).toBe(1)
    expect(useRunStore.getState().active).toBe(true)

    await vi.advanceTimersByTimeAsync(3000)
    await flushMicrotasks()
    // 重附着成功 → run:end → 正常收束
    expect(streamCalls()).toBe(2)
    expect(useRunStore.getState().active).toBe(false)
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
    expect(useSessionStore.getState().refreshMessages).toHaveBeenCalled()
  })

  it('重试耗尽（首次 + 2 次重试均断流）：刷新兜底 + 提示一次', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/stream')) return streamResponse([], 'error')
      return jsonResponse({ approvals: [] })
    })
    useRunStore.getState().attach('r_1', 's_1')
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(3000)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(3000)
    await flushMicrotasks()

    expect(streamCalls()).toBe(3) // 首次 + 2 次重试
    expect(useRunStore.getState().active).toBe(false)
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1)
    expect(useSessionStore.getState().refreshMessages).toHaveBeenCalled()
  })

  it('主动取消（detach）：不重试、不兜底、不提示', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/stream')) return hangingResponse(init?.signal as AbortSignal)
      return jsonResponse({ approvals: [] })
    })
    useRunStore.getState().attach('r_1', 's_1')
    await flushMicrotasks()
    expect(useRunStore.getState().active).toBe(true)

    useRunStore.getState().detach()
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(3000)
    await flushMicrotasks()

    expect(streamCalls()).toBe(1)
    expect(useRunStore.getState().active).toBe(false)
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
    expect(useSessionStore.getState().refreshMessages).not.toHaveBeenCalled()
  })
})
