/**
 * M79-AB：断线重连的权威补偿。
 * - 断线窗口的用户主题帧（收件箱：邀请/提及——无游标可补）与服务重启期间的新会话——
 *   重连成功后 REST 补偿（收件箱快照 + 会话列表对账）；
 * - 首次建连不重复补偿（init 自身已同步）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => {
  const toastFn = vi.fn()
  return { toast: Object.assign(toastFn, { error: vi.fn(), success: vi.fn(), info: vi.fn() }) }
})

import { useWsStore } from '../src/stores/ws-store'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

/** WebSocket 测试替身（同 m79-realtime 先例） */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  readyState = 1
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3
    this.onclose?.()
  }
  open(): void {
    this.onopen?.()
  }
}

const countFetch = (prefix: string): number =>
  fetchMock.mock.calls.filter((c) => String(c[0]).startsWith(prefix)).length

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
  fetchMock.mockReset()
  fetchMock.mockImplementation((url: string) => {
    const u = String(url)
    if (u.startsWith('/api/inbox?')) return Promise.resolve(jsonResponse({ items: [], cursor: 0, unreadCount: 0 }))
    if (u === '/api/sessions') return Promise.resolve(jsonResponse({ sessions: [] }))
    return Promise.resolve(jsonResponse({}))
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  for (const ws of FakeWebSocket.instances) ws.close()
  vi.unstubAllGlobals()
})

describe('M79-AB：断线重连权威补偿', () => {
  it('重连成功后补偿收件箱与会话列表；首次建连不重复补偿', async () => {
    useWsStore.getState().init()
    const ws0 = FakeWebSocket.instances.at(-1)!
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))

    // 首次 open：不触发补偿（init 自身的 inbox sync 不计入此后的增量断言）
    ws0.open()
    const inboxBase = countFetch('/api/inbox?')
    const sessionsBase = countFetch('/api/sessions')
    await new Promise((r) => setTimeout(r, 10))
    expect(countFetch('/api/inbox?')).toBe(inboxBase)
    expect(countFetch('/api/sessions')).toBe(sessionsBase)

    // 断线 → 重连（手动立即重连，跳过退避等待）
    ws0.close()
    useWsStore.getState().reconnect()
    const ws1 = FakeWebSocket.instances.at(-1)!
    ws1.open()

    // 重连补偿：收件箱快照 + 会话列表对账各 +1
    await vi.waitFor(() => expect(countFetch('/api/inbox?')).toBe(inboxBase + 1))
    expect(countFetch('/api/sessions')).toBe(sessionsBase + 1)
  })
})
