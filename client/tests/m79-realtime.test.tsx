/**
 * M79-A 客户端测试：实时通道稳定化（设计 §9.9）。
 *
 * 覆盖：
 * - NotifySocket：退避抖动（首跳 ≤ 基准）/ 无帧探活 / 前台恢复立即重连 /
 *   `resync` 与 `error` 帧回调 / `read` 与 `inbox-ack` 出站帧；
 * - inbox-store：ingest 幂等 + 缺口检测 → REST 补齐；ackAll 清未读并上报；
 * - ws-store：`notify:inbox` 入箱（用户主题不走会话游标去重）/ `notify:read-state` 刷新会话列表 /
 *   markRead 已读上报（WS 帧优先；无连接时 REST 兜底）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotifyEnvelope } from '@multi-agent/shared'

vi.mock('sonner', () => {
  const toastFn = vi.fn()
  return { toast: Object.assign(toastFn, { error: vi.fn(), success: vi.fn(), info: vi.fn() }) }
})

import { toast } from 'sonner'
import { NotifySocket } from '../src/lib/ws'
import { useInboxStore } from '../src/stores/inbox-store'
import { useRunStore } from '../src/stores/run-store'
import { handleNotify, pollUrlOf, useWsStore } from '../src/stores/ws-store'
import { useAuthStore } from '../src/stores/auth-store'
import { useSessionStore } from '../src/stores/session-store'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

/** WebSocket 测试替身（同 m22 先例；含 send 记录与手动事件触发） */
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

  emit(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  lastJson(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1] ?? '{}') as Record<string, unknown>
  }
}

function envelope(partial: Partial<NotifyEnvelope> & { type: NotifyEnvelope['type']; payload: Record<string, unknown> }): NotifyEnvelope {
  return { v: 1, id: `n_${Math.random().toString(36).slice(2, 8)}`, seq: 1, ts: new Date().toISOString(), sessionId: 's1', ...partial }
}

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
  fetchMock.mockReset()
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.startsWith('/api/inbox?') && (!init || (init.method ?? 'GET') === 'GET')) {
      return Promise.resolve(jsonResponse({ items: [], cursor: 0, unreadCount: 0 }))
    }
    if (u === '/api/inbox/read') return Promise.resolve(jsonResponse({ ok: true, changed: 0 }))
    if (u === '/api/sessions') return Promise.resolve(jsonResponse({ sessions: [] }))
    if (u.startsWith('/api/sessions/') && init?.method === 'POST') {
      return Promise.resolve(jsonResponse({ ok: true, lastReadSeq: 1 }))
    }
    return Promise.resolve(jsonResponse({}))
  })
  vi.stubGlobal('fetch', fetchMock)
  useSessionStore.setState({ currentId: undefined, sessions: [], order: [], byId: new Map() })
  useInboxStore.getState().reset()
  useWsStore.setState({ unread: {} })
  ;(toast as unknown as ReturnType<typeof vi.fn>).mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('M79-A：NotifySocket 稳定化', () => {
  it('resync 与 error 帧路由到回调；read / inboxAck 出站帧形状正确', () => {
    const onResync = vi.fn()
    const onPolicyError = vi.fn()
    const socket = new NotifySocket({
      onStatus: vi.fn(),
      onNotify: vi.fn(),
      getCursors: () => ({}),
      getSubscriptions: () => [],
      onResync,
      onPolicyError,
    })
    socket.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ws.emit({ type: 'resync', reason: 'backpressure' })
    expect(onResync).toHaveBeenCalledWith('backpressure')
    ws.emit({ type: 'error', code: 'conn_evicted', message: '连接数超限', sessionId: 's1' })
    expect(onPolicyError).toHaveBeenCalledWith('conn_evicted', '连接数超限', 's1')

    socket.read('s1', 7)
    expect(ws.lastJson()).toEqual({ type: 'read', sessionId: 's1', seq: 7 })
    socket.inboxAck(3)
    expect(ws.lastJson()).toEqual({ type: 'inbox-ack', upTo: 3 })
    socket.close()
  })

  it('断线退避带向下抖动（首跳 ≤ 基准 1s，重连自动恢复）', () => {
    vi.useFakeTimers()
    const handlers = { onStatus: vi.fn(), onNotify: vi.fn(), getCursors: () => ({}), getSubscriptions: () => [] }
    const socket = new NotifySocket(handlers)
    socket.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ws.readyState = 3
    ws.onclose?.()
    expect(handlers.onStatus).toHaveBeenLastCalledWith('closed')
    vi.advanceTimersByTime(1000) // 抖动不超基准：1s 内必重连
    expect(FakeWebSocket.instances.length).toBe(2)
    socket.close()
  })

  it('M79-AC：半开连接（探活无应答 ≥2× 阈值）→ 强制关闭并自动重连', () => {
    vi.useFakeTimers()
    const handlers = { onStatus: vi.fn(), onNotify: vi.fn(), getCursors: () => ({}), getSubscriptions: () => [] }
    const socket = new NotifySocket(handlers)
    socket.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.open()

    // 90s：首个探活 ping（服务端「无应答」——不 emit pong），尚未重连
    vi.advanceTimersByTime(90_000)
    expect(ws.sent.map((raw) => JSON.parse(raw).type)).toContain('ping')
    expect(FakeWebSocket.instances.length).toBe(1)

    // 150s：idle > 2× 阈值 → 判定半开 → 强制关闭（触发 closed）→ 退避重连
    vi.advanceTimersByTime(60_000)
    expect(handlers.onStatus).toHaveBeenLastCalledWith('closed')
    vi.advanceTimersByTime(1000) // 首跳退避（含抖动）≤ 基准 1s
    expect(FakeWebSocket.instances.length).toBe(2)
    socket.close()
  })

  it('无帧 60s 主动探活；前台恢复绕过退避立即重连', () => {
    vi.useFakeTimers()
    const socket = new NotifySocket({ onStatus: vi.fn(), onNotify: vi.fn(), getCursors: () => ({}), getSubscriptions: () => [] })
    socket.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    vi.advanceTimersByTime(90_000) // 30s×3 检查：60s 阈值后发 ping
    expect(ws.sent.map((raw) => JSON.parse(raw).type)).toContain('ping')

    // 断线（待重连退避计时中）→ visibilitychange 可见 → 立即重连（不推进定时器）
    ws.readyState = 3
    ws.onclose?.()
    const before = FakeWebSocket.instances.length
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(FakeWebSocket.instances.length).toBe(before + 1)
    socket.close()
  })
})

describe('M79-A：inbox-store', () => {
  it('ingest 幂等；seq 缺口 → REST 补齐（不吞事件）；ackAll 清未读并上报', async () => {
    const store = useInboxStore.getState()
    store.ingest({ id: 'ib_1', seq: 1, type: 'friend-request', title: 'A 请求添加你为好友', createdAt: new Date().toISOString() })
    store.ingest({ id: 'ib_1', seq: 1, type: 'friend-request', title: 'A 请求添加你为好友', createdAt: new Date().toISOString() })
    expect(useInboxStore.getState().items).toHaveLength(1)
    expect(useInboxStore.getState().unreadCount).toBe(1)

    // 缺口：cursor=1 收到 seq=5 → 触发 REST 同步
    fetchMock.mockImplementation((url: string) => {
      if (String(url).startsWith('/api/inbox?')) return Promise.resolve(jsonResponse({ items: [], cursor: 5, unreadCount: 9 }))
      return Promise.resolve(jsonResponse({ ok: true }))
    })
    store.ingest({ id: 'ib_5', seq: 5, type: 'mention', title: '会话', createdAt: new Date().toISOString() })
    await vi.waitFor(() => expect(useInboxStore.getState().cursor).toBe(5))
    expect(useInboxStore.getState().unreadCount).toBe(9) // 以服务端权威为准

    await useInboxStore.getState().ackAll()
    expect(useInboxStore.getState().unreadCount).toBe(0)
    const posted = fetchMock.mock.calls.find(([u]) => String(u) === '/api/inbox/read')
    expect(posted).toBeTruthy()
    expect(JSON.parse((posted![1] as RequestInit).body as string)).toEqual({ upTo: 5 })
  })
})

describe('M79-A：ws-store 接入', () => {
  it('notify:inbox（用户主题）入箱且不走会话游标去重；notify:read-state 刷新会话列表', async () => {
    const first = envelope({ type: 'notify:inbox', sessionId: 'u:u1', seq: 0, payload: { item: { id: 'ib_a', seq: 1, type: 'friend-request', title: 'A 请求添加你为好友', createdAt: new Date().toISOString() } } })
    const second = envelope({ type: 'notify:inbox', sessionId: 'u:u1', seq: 0, payload: { item: { id: 'ib_b', seq: 2, type: 'session-invite', title: '会话名', createdAt: new Date().toISOString() } } })
    handleNotify(first)
    handleNotify(second) // 同 sessionId u:u1 且 seq 相同 → 若不特判会被游标去重吞掉
    expect(useInboxStore.getState().items.map((i) => i.id)).toEqual(['ib_a', 'ib_b'])
    expect(toast).toHaveBeenCalledTimes(2)

    handleNotify(envelope({ type: 'notify:read-state', sessionId: 'u:u1', seq: 0, payload: { sessionId: 's1', lastReadSeq: 3 } }))
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/sessions')).toBe(true)
    })
  })

  it('M79-G：notify:presence 同步通用 presenceMap（好友 ∪ 同会话成员可见域）', () => {
    handleNotify(
      envelope({
        type: 'notify:presence',
        sessionId: 'u:u2',
        seq: 0,
        payload: { users: [{ userId: 'u_bob', online: true }, { userId: 'u_cara', online: false }] },
      }),
    )
    expect(useWsStore.getState().presenceMap['u_bob']).toBe(true)
    expect(useWsStore.getState().presenceMap['u_cara']).toBe(false)
  })

  it('M79-K：notify:session-meta 帧驱动归并——「键缺失 = 空 / 关闭」字段显式归一（waiting 清空 / routeMode 复位）', () => {
    useSessionStore.setState({
      sessions: [
        {
          id: 's_1',
          title: 'T',
          participantIds: ['pm'],
          kind: 'team',
          routeMode: 'mention',
          waitingOn: ['u_bob'],
          messageCount: 0,
          createdAt: '',
          updatedAt: '',
        },
      ],
      currentId: 's_1',
    } as never)
    // 服务端序列化省略空键（waiting_on 清空 → 键缺失；route_mode=auto → 键缺失）
    handleNotify(
      envelope({
        type: 'notify:session-meta',
        sessionId: 's_1',
        seq: 1,
        payload: { session: { id: 's_1', title: 'T', participantIds: ['pm'] } },
      }),
    )
    const after = useSessionStore.getState().sessions[0]!
    expect(after.waitingOn).toEqual([])
    expect(after.routeMode).toBeUndefined()

    // 反向：写入 waiting / 切 mention 同样就地生效
    handleNotify(
      envelope({
        type: 'notify:session-meta',
        sessionId: 's_1',
        seq: 2,
        payload: { session: { id: 's_1', title: 'T', participantIds: ['pm'], waitingOn: ['u_bob'], routeMode: 'mention' } },
      }),
    )
    const after2 = useSessionStore.getState().sessions[0]!
    expect(after2.waitingOn).toEqual(['u_bob'])
    expect(after2.routeMode).toBe('mention')
  })

  it('M79-U/W：notify:turn-end 携带消息 → 同会话 upsert；跨会话计未读 + 列表行预览即时更新', () => {
    useSessionStore.setState({
      currentId: 's1',
      sessions: [
        { id: 's1', title: 'T1' },
        { id: 's2', title: 'T2', lastMessage: { role: 'user', content: '旧消息', createdAt: '2026-09-19T00:00:00.000Z' } },
      ],
      byId: new Map(),
      order: [],
    } as never)
    const agentMsg = {
      id: 'm_a1',
      sessionId: 's1',
      seq: 9,
      role: 'agent',
      agentId: 'pm',
      content: '方案如下',
      mentions: [],
      status: 'complete',
      createdAt: '2026-09-20T00:00:00.000Z',
    }
    handleNotify(envelope({ type: 'notify:turn-end', sessionId: 's1', seq: 9, payload: { message: agentMsg } }))
    expect(useSessionStore.getState().byId.get('m_a1')).toBeTruthy()
    expect(useSessionStore.getState().order).toContain('m_a1')
    expect(useWsStore.getState().unread['s1']).toBeUndefined() // 同会话不计未读

    // M79-W 跨会话（群聊式全同步）：不 upsert 消息体，但计未读 + 列表行预览即时更新
    const other = { ...agentMsg, id: 'm_a2', sessionId: 's2', memberKey: 'pm', content: '跨会话回复' }
    handleNotify(envelope({ type: 'notify:turn-end', sessionId: 's2', seq: 10, payload: { message: other } }))
    expect(useSessionStore.getState().byId.has('m_a2')).toBe(false)
    expect(useWsStore.getState().unread['s2']).toBe(1)
    const row = useSessionStore.getState().sessions.find((x) => x.id === 's2')
    expect(row?.lastMessage?.content).toBe('跨会话回复')
  })

  it('M79-W：跨会话人类消息 → 未读 + 轻提示；自己的消息（同账号其他标签页）不计未读', () => {
    useAuthStore.setState({ user: { id: 'u_me', username: 'me', displayName: 'Me' } } as never)
    useSessionStore.setState({
      currentId: 's1',
      sessions: [{ id: 's2', title: 'T2' }],
      byId: new Map(),
      order: [],
    } as never)
    const humanMsg = {
      id: 'm_h1',
      sessionId: 's2',
      seq: 11,
      role: 'user',
      userId: 'u_bob',
      content: '大家好',
      mentions: [],
      status: 'complete',
      createdAt: '2026-09-20T00:00:00.000Z',
    }
    handleNotify(envelope({ type: 'notify:turn-end', sessionId: 's2', seq: 11, payload: { message: humanMsg } }))
    expect(useWsStore.getState().unread['s2']).toBe(1)
    expect(vi.mocked(toast)).toHaveBeenCalled()

    // 自己（同账号其他标签页）的消息：预览更新但不计未读
    const mine = { ...humanMsg, id: 'm_h2', userId: 'u_me', seq: 12, content: '我发的' }
    handleNotify(envelope({ type: 'notify:turn-end', sessionId: 's2', seq: 12, payload: { message: mine } }))
    expect(useWsStore.getState().unread['s2']).toBe(1)
    expect(useSessionStore.getState().sessions.find((x) => x.id === 's2')?.lastMessage?.content).toBe('我发的')
  })

  it('M79-W：run-completed 不再本地未读 +1（消息级计数 + 权威对账兜底）', async () => {
    const origLoad = useSessionStore.getState().loadSessions
    const load = vi.fn(async () => undefined)
    useSessionStore.setState({ currentId: 's1', sessions: [{ id: 's1', title: 'T' }], loadSessions: load } as never)
    try {
      handleNotify(envelope({ type: 'notify:run-completed', sessionId: 's1', seq: 3, runId: 'r9', payload: {} }))
      expect(useWsStore.getState().unread['s1']).toBeUndefined()
      // 800ms 防抖对账：loadSessions 被调用（服务端权威未读覆盖本地近似）
      await vi.waitFor(() => expect(load).toHaveBeenCalled(), { timeout: 2000 })
    } finally {
      useSessionStore.setState({ loadSessions: origLoad })
    }
  })

  it('M79-X：message-deleted 同会话即时移除；session-deleted 列表移除 + 当前会话回到空态', async () => {
    useSessionStore.setState({
      currentId: 's1',
      sessions: [{ id: 's1', title: 'T1' }, { id: 's2', title: 'T2' }],
      byId: new Map([
        ['m1', { id: 'm1', sessionId: 's1', seq: 1, role: 'user', content: 'hi', mentions: [], status: 'complete', createdAt: '' }],
      ]),
      order: ['m1'],
    } as never)
    handleNotify(envelope({ type: 'notify:message-deleted', sessionId: 's1', seq: 30, payload: { messageId: 'm1' } }))
    expect(useSessionStore.getState().byId.has('m1')).toBe(false)
    expect(useSessionStore.getState().order).not.toContain('m1')

    handleNotify(envelope({ type: 'notify:session-deleted', sessionId: 's1', seq: 31, payload: {} }))
    expect(useSessionStore.getState().sessions.some((x) => x.id === 's1')).toBe(false)
    await vi.waitFor(() => expect(useSessionStore.getState().currentId).toBeUndefined())
    expect(vi.mocked(toast)).toHaveBeenCalledWith('本会话已被删除', { id: 'session-deleted-s1' })
    // 删除触发的 800ms 权威对账（drain：避免防抖定时器跨用例触发）
    await vi.waitFor(
      () => expect(fetchMock.mock.calls.some((c) => String(c[0]) === '/api/sessions')).toBe(true),
      { timeout: 2500 },
    )
  })

  it('M79-AA：session-deleted payload.kind=group → 「群聊已被解散」文案（当前会话回到空态）', async () => {
    useSessionStore.setState({
      currentId: 'g1',
      sessions: [{ id: 'g1', title: '群', kind: 'group' }],
      byId: new Map(),
      order: [],
    } as never)
    handleNotify(envelope({ type: 'notify:session-deleted', sessionId: 'g1', seq: 50, payload: { kind: 'group' } }))
    expect(useSessionStore.getState().sessions.some((x) => x.id === 'g1')).toBe(false)
    await vi.waitFor(() => expect(useSessionStore.getState().currentId).toBeUndefined())
    expect(vi.mocked(toast)).toHaveBeenCalledWith('群聊已被解散', { id: 'session-deleted-g1' })
  })

  it('M79-Y：queue-updated / context-compressed 仅对本端活跃 Run 生效（非活跃忽略）', () => {
    useRunStore.setState({ runId: 'r1', active: true, queue: ['a'], compressionCount: 0 } as never)
    handleNotify(
      envelope({ type: 'notify:queue-updated', sessionId: 's1', runId: 'r1', seq: 40, payload: { queue: ['b', 'c'] } }),
    )
    expect(useRunStore.getState().queue).toEqual(['b', 'c'])
    handleNotify(envelope({ type: 'notify:context-compressed', sessionId: 's1', runId: 'r1', seq: 41, payload: {} }))
    expect(useRunStore.getState().compressionCount).toBe(1)

    // 非活跃 Run：忽略（不覆盖当前队列 / 不计数）
    handleNotify(
      envelope({ type: 'notify:queue-updated', sessionId: 's1', runId: 'r_other', seq: 42, payload: { queue: ['z'] } }),
    )
    handleNotify(envelope({ type: 'notify:context-compressed', sessionId: 's1', runId: 'r_other', seq: 43, payload: {} }))
    expect(useRunStore.getState().queue).toEqual(['b', 'c'])
    expect(useRunStore.getState().compressionCount).toBe(1)
    useRunStore.setState({ runId: undefined, active: false } as never)
  })

  it('M79-Z：message-delta 非触发者同会话累积（首帧建占位）；触发者 / 跨会话跳过', () => {
    useRunStore.setState({ runId: 'r_other', active: false } as never)
    useSessionStore.setState({
      currentId: 's1',
      sessions: [{ id: 's1', title: 'T' }],
      byId: new Map(),
      order: [],
    } as never)
    // 首帧：创建 streaming 占位（成员身份随帧）
    handleNotify(
      envelope({
        type: 'notify:message-delta',
        sessionId: 's1',
        runId: 'r1',
        seq: 50,
        payload: { messageId: 'm_d1', agentId: 'pm', memberKey: 'pm', delta: '你' },
      }),
    )
    let m = useSessionStore.getState().byId.get('m_d1')
    expect(m?.status).toBe('streaming')
    expect(m?.role).toBe('agent')
    expect(m?.memberKey).toBe('pm')
    expect(m?.content).toBe('你')

    // 第二帧：累积
    handleNotify(
      envelope({
        type: 'notify:message-delta',
        sessionId: 's1',
        runId: 'r1',
        seq: 51,
        payload: { messageId: 'm_d1', delta: '好' },
      }),
    )
    expect(useSessionStore.getState().byId.get('m_d1')?.content).toBe('你好')

    // 触发者（本端活跃 Run 相同）：跳过（SSE 已有流）
    useRunStore.setState({ runId: 'r1', active: true } as never)
    handleNotify(
      envelope({
        type: 'notify:message-delta',
        sessionId: 's1',
        runId: 'r1',
        seq: 52,
        payload: { messageId: 'm_d1', delta: '！' },
      }),
    )
    expect(useSessionStore.getState().byId.get('m_d1')?.content).toBe('你好')

    // 跨会话：忽略
    useRunStore.setState({ runId: undefined, active: false } as never)
    handleNotify(
      envelope({
        type: 'notify:message-delta',
        sessionId: 's2',
        runId: 'r1',
        seq: 53,
        payload: { messageId: 'm_d2', delta: 'x' },
      }),
    )
    expect(useSessionStore.getState().byId.has('m_d2')).toBe(false)
  })

  it('markRead：无连接时 REST 兜底上报当前会话最大 seq', async () => {
    useSessionStore.setState({
      currentId: 's1',
      order: ['m1', 'm2'],
      byId: new Map([
        ['m1', { id: 'm1', sessionId: 's1', seq: 1, role: 'user', content: 'a', mentions: [], status: 'complete', createdAt: '' }],
        ['m2', { id: 'm2', sessionId: 's1', seq: 4, role: 'agent', content: 'b', mentions: [], status: 'complete', createdAt: '' }],
      ]),
    } as never)
    useWsStore.setState({ unread: { s1: 2 } })
    useWsStore.getState().markRead('s1')
    expect(useWsStore.getState().unread['s1']).toBe(0)
    await vi.waitFor(() => {
      const posted = fetchMock.mock.calls.find(([u, i]) => String(u) === '/api/sessions/s1/read' && (i as RequestInit)?.method === 'POST')
      expect(posted).toBeTruthy()
      expect(JSON.parse((posted![1] as RequestInit).body as string)).toEqual({ seq: 4 })
    })
  })

  it('M79-AF：awaiting-user 仅对持球方（targets）∪ 属主提示；无 targets 保持广播语义', () => {
    useSessionStore.setState({
      currentId: undefined,
      sessions: [{ id: 's1', title: 'T', ownerId: 'u_alice' }],
      byId: new Map(),
      order: [],
    } as never)
    // 非 targets / 非属主 → 静默（不打扰）
    useAuthStore.setState({ user: { id: 'u_bob' } } as never)
    handleNotify(
      envelope({ type: 'notify:awaiting-user', sessionId: 's1', seq: 60, payload: { reason: 'completed', targets: ['u_cara'] } }),
    )
    expect(toast).not.toHaveBeenCalled()

    // targets 命中 → 提示
    handleNotify(
      envelope({ type: 'notify:awaiting-user', sessionId: 's1', seq: 61, payload: { reason: 'completed', targets: ['u_bob'] } }),
    )
    expect(vi.mocked(toast)).toHaveBeenCalledWith('T：成员已交还，等待你的指示')

    // 会话属主 → 提示（兜底可见）
    ;(toast as unknown as ReturnType<typeof vi.fn>).mockClear()
    useAuthStore.setState({ user: { id: 'u_alice' } } as never)
    handleNotify(
      envelope({ type: 'notify:awaiting-user', sessionId: 's1', seq: 62, payload: { reason: 'completed', targets: ['u_cara'] } }),
    )
    expect(vi.mocked(toast)).toHaveBeenCalledWith('T：成员已交还，等待你的指示')

    // 无 targets（泛指 @用户 / 兼容模式）→ 保持原广播语义（任何人都收到）
    ;(toast as unknown as ReturnType<typeof vi.fn>).mockClear()
    useAuthStore.setState({ user: { id: 'u_dave' } } as never)
    handleNotify(envelope({ type: 'notify:awaiting-user', sessionId: 's1', seq: 63, payload: { reason: 'completed' } }))
    expect(vi.mocked(toast)).toHaveBeenCalledWith('T：成员已交还，等待你的指示')
  })

  it('M79-AF：降级轮询 URL 携带 per-session 游标只拉增量；超长回退全量', () => {
    // 无游标（首次 / WS 从未连过）：全量语义
    expect(pollUrlOf(new Map())).toBe('/api/notifications?since=0')
    // 有游标：JSON 编码的 {sessionId: seq}（含保留主题 __assets__）
    const url = pollUrlOf(new Map([
      ['s1', 5],
      ['__assets__', 2],
    ]))
    expect(url.startsWith('/api/notifications?since=0&cursors=')).toBe(true)
    const parsed = JSON.parse(decodeURIComponent(new URL(url, 'http://test.local').searchParams.get('cursors')!)) as Record<string, number>
    expect(parsed).toEqual({ s1: 5, __assets__: 2 })
    // 会话过多（序列化超长）：回退全量（URL 上限护栏，正确性优先）
    const big = new Map(Array.from({ length: 200 }, (_, i) => [`s_${i}_long_session_id_name`, i]))
    expect(pollUrlOf(big)).toBe('/api/notifications?since=0')
  })
})
