import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, InboxItem, NotifyEnvelope } from '@multi-agent/shared'
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn(), success: vi.fn() }),
}))
import { toast } from 'sonner'
import { useOutboxStore } from '../src/stores/outbox-store'
import { useAuthStore } from '../src/stores/auth-store'
import { filterSessions, useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'
import { useRunStore } from '../src/stores/run-store'
import { useInboxStore } from '../src/stores/inbox-store'
import { handleNotify, useWsStore } from '../src/stores/ws-store'
import { visibleMessageSeq } from '../src/lib/use-message-read-tracker'

const fetchMock = vi.fn()
const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
const message = (id = 'm1', seq = 1): ChatMessage => ({
  id,
  seq,
  sessionId: 's1',
  userId: 'u1',
  role: 'user',
  content: '你好',
  mentions: [],
  status: 'complete',
  createdAt: '',
})
const tick = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  useAuthStore.setState({ user: { id: 'u1' } as never })
  useSessionStore.setState({
    currentId: 's1',
    selectionVersion: 1,
    sessions: [],
    byId: new Map(),
    order: [],
    loadingMessages: false,
    historyMode: false,
  })
  useOutboxStore.setState({ ownerId: 'u1', items: [] })
  useInboxStore.getState().reset()
  fetchMock.mockReset().mockImplementation((url: string, init?: RequestInit) => {
    if (url.endsWith('/messages') && init?.method === 'POST') {
      const body = JSON.parse(init.body as string)
      return Promise.resolve(
        json({ message: { ...message(), content: body.content, clientMessageId: body.clientMessageId } }),
      )
    }
    if (url === '/api/sessions') return Promise.resolve(json({ sessions: [] }))
    if (url.startsWith('/api/inbox?'))
      return Promise.resolve(json({ items: [], cursor: 0, hasMore: false, unreadCount: 0 }))
    if (url.endsWith('/read'))
      return Promise.resolve(json({ lastReadSeq: JSON.parse(init?.body as string).seq }))
    return Promise.resolve(json({ messages: [], memberReads: [], session: { id: 's1' } }))
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('持久待发箱', () => {
  it('响应丢失后保留原条目；重试使用相同提交标识', async () => {
    fetchMock.mockRejectedValueOnce(new Error('连接断开'))
    useOutboxStore.getState().enqueue('s1', '你好')
    expect(useOutboxStore.getState().items[0]?.status).toBe('sending')
    await tick()
    const item = useOutboxStore.getState().items[0]!
    expect(item.status).toBe('failed')
    expect(localStorage.length).toBe(1)
    useOutboxStore.getState().retry(item.id)
    await tick()
    const submissions = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/messages'))
    expect(submissions).toHaveLength(2)
    expect(JSON.parse(submissions[0][1].body).clientMessageId).toBe(
      JSON.parse(submissions[1][1].body).clientMessageId,
    )
    expect(useOutboxStore.getState().items).toHaveLength(0)
    expect(localStorage.length).toBe(0)
    expect(useSessionStore.getState().byId.get('m1')?.content).toBe('你好')
  })

  it('离线保存；恢复期间发送中的消息保留为待确认', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    useOutboxStore.getState().enqueue('s1', '离线内容')
    expect(fetchMock).not.toHaveBeenCalled()
    const item = useOutboxStore.getState().items[0]!
    const key = localStorage.key(0)!
    localStorage.setItem(key, JSON.stringify({ ...item, status: 'sending' }))
    useOutboxStore.setState({ items: [] })
    useOutboxStore.getState().restore()
    expect(useOutboxStore.getState().items[0]).toMatchObject({
      id: item.id,
      content: '离线内容',
      status: 'failed',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('同一会话前序失败阻止后序越过；重试后按顺序发送', async () => {
    fetchMock.mockRejectedValueOnce(new Error('断网'))
    useOutboxStore.getState().enqueue('s1', '第一条')
    useOutboxStore.getState().enqueue('s1', '第二条')
    await tick()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    useOutboxStore.getState().retry(useOutboxStore.getState().items[0]!.id)
    await tick()
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).content)).toEqual([
      '第一条',
      '第一条',
      '第二条',
    ])
    expect(useOutboxStore.getState().items).toHaveLength(0)
  })

  it('切换账号不展示旧待发箱，旧请求的响应也不能污染新账号', async () => {
    let finish!: (response: Response) => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    useOutboxStore.getState().enqueue('s1', '旧账号消息')
    useAuthStore.setState({ user: { id: 'u2' } as never })
    useOutboxStore.getState().restore()
    finish(json({ message: message() }))
    await tick()
    expect(useOutboxStore.getState().items).toHaveLength(0)
    expect(useSessionStore.getState().byId.size).toBe(0)
    useAuthStore.setState({ user: { id: 'u1' } as never })
    useOutboxStore.getState().restore()
    expect(useOutboxStore.getState().items[0]?.content).toBe('旧账号消息')
  })

  it('WS 先确认时，HTTP 后续失败不会恢复失败条目', async () => {
    let fail!: (reason: Error) => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        }),
    )
    useOutboxStore.getState().enqueue('s1', '先收到广播')
    const item = useOutboxStore.getState().items[0]!
    useOutboxStore.getState().acknowledge({ ...message(), clientMessageId: item.id })
    fail(new Error('响应丢失'))
    await tick()
    expect(useOutboxStore.getState().items).toHaveLength(0)
    expect(localStorage.length).toBe(0)
  })

  it('引用回复随待发箱持久化，重试仍携带同一引用目标', async () => {
    fetchMock.mockRejectedValueOnce(new Error('断网'))
    useOutboxStore.getState().enqueue('s1', '收到', undefined, undefined, 'target_1')
    await tick()
    useOutboxStore.getState().retry(useOutboxStore.getState().items[0]!.id)
    await tick()
    const posts = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/messages'))
    expect(posts.map(([, init]) => JSON.parse(init.body).replyToMessageId)).toEqual(['target_1', 'target_1'])
  })

  it('消息已被删除（410）不堵塞同会话后续消息', async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: '已接收后被删除' }), {
          status: 410,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    useOutboxStore.getState().enqueue('s1', '已删消息')
    await tick()
    expect(useOutboxStore.getState().items).toHaveLength(0)
    expect(localStorage.length).toBe(0)
  })

  it('本页在途请求不被 restore 降级为待确认', async () => {
    let finish!: (response: Response) => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    useOutboxStore.getState().enqueue('s1', '在途消息')
    useOutboxStore.getState().restore()
    expect(useOutboxStore.getState().items[0]?.status).toBe('sending')
    finish(json({ message: { ...message(), clientMessageId: useOutboxStore.getState().items[0]!.id } }))
    await tick()
    expect(useOutboxStore.getState().items).toHaveLength(0)
  })

  it('存储失败不发请求、不吞输入；纯聊天确认后不挂接虚假 Run', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('满了')
    })
    expect(() => useOutboxStore.getState().enqueue('s1', '保留输入')).toThrow('无法保存')
    expect(fetchMock).not.toHaveBeenCalled()
    storage.mockRestore()
    const attach = vi.spyOn(useRunStore.getState(), 'attach')
    await useRunStore.getState().send('纯聊天')
    await tick()
    expect(attach).not.toHaveBeenCalled()
    expect(useOutboxStore.getState().items).toHaveLength(0)
  })
})

describe('正在输入（临时帧）', () => {
  it('本人的多端不回显；发消息立即清除；6s 无新帧自动过期', async () => {
    useAuthStore.setState({ user: { id: 'u1' } as never })
    useWsStore.setState({ typing: {} })
    useSessionStore.setState({ currentId: 's1', byId: new Map(), order: [] })
    const typing = (userId: string, name?: string): void => {
      handleNotify({
        v: 1,
        id: `typing_${userId}`,
        ephemeral: true,
        seq: 0,
        ts: '',
        type: 'notify:typing',
        sessionId: 's1',
        payload: { userId, ...(name ? { name } : {}) },
      })
    }
    typing('u2', 'Bob')
    expect(useWsStore.getState().typing.s1).toEqual([{ userId: 'u2', name: 'Bob' }])
    typing('u1')
    expect(useWsStore.getState().typing.s1).toHaveLength(1)

    handleNotify({
      v: 1,
      id: 'turn_1',
      seq: 1,
      ts: '',
      type: 'notify:turn-end',
      sessionId: 's1',
      payload: { message: { ...message('m1', 1), sessionId: 's1', userId: 'u2' } },
    })
    expect(useWsStore.getState().typing.s1).toEqual([])

    typing('u3', 'Cara')
    await vi.advanceTimersByTimeAsync(6001)
    expect(useWsStore.getState().typing.s1).toEqual([])
  })
})

describe('撤回与自删的本地投影', () => {
  it('撤回帧把同窗口引用快照标为已撤回', () => {
    const target = { ...message('target', 1), sessionId: 's1' }
    const reply = {
      ...message('reply', 2),
      sessionId: 's1',
      replyTo: { messageId: 'target', excerpt: '原文' },
    }
    useSessionStore.setState({ currentId: 's1', order: ['target', 'reply'], byId: new Map([['target', target], ['reply', reply]]) as never })
    useSessionStore.getState().upsertMessage({ ...target, recalledAt: new Date().toISOString() })
    expect(useSessionStore.getState().byId.get('reply')?.replyTo?.recalled).toBe(true)
  })

  it('仅自己删除的用户主题帧也能移除当前会话消息', () => {
    useSessionStore.setState({
      currentId: 's1',
      order: ['m1'],
      byId: new Map([['m1', { ...message('m1'), sessionId: 's1' }]]) as never,
    })
    handleNotify({
      v: 1,
      id: 'n3',
      seq: 0,
      ts: '',
      type: 'notify:message-deleted',
      sessionId: 'u:u1',
      payload: { sessionId: 's1', messageId: 'm1', scope: 'self' },
    })
    expect(useSessionStore.getState().byId.has('m1')).toBe(false)
  })
})

describe('搜索命中的历史直达', () => {
  it('focusMessage 携带 seq；loadAtMessage 按 before=seq+1 直接加载窗口', async () => {
    useUiStore.getState().focusMessage('old', 42)
    expect(useUiStore.getState().focusRequest).toMatchObject({ id: 'old', seq: 42 })
    useUiStore.getState().clearFocus()

    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        json({
          session: { id: 's1' },
          messages: [message('old', 50)],
          hasMore: true,
          totalCount: 200,
        }),
      ),
    )
    await useSessionStore.getState().loadAtMessage(50)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/sessions/s1?limit=100&before=51')
    expect(useSessionStore.getState().order).toEqual(['old'])
    expect(useSessionStore.getState().historyMode).toBe(true)
    expect(useSessionStore.getState().hasMore).toBe(true)
    expect(useSessionStore.getState().totalCount).toBe(200)
  })
})

describe('会话偏好', () => {
  const session = (prefs = { pinned: false, muted: false, archived: false, markedUnread: false }) =>
    ({ id: 's1', title: 'T', participantIds: [], prefs, createdAt: '', updatedAt: '', messageCount: 0 }) as never

  it('乐观更新并适用于置顶排序；失败回滚', async () => {
    useSessionStore.setState({ sessions: [session()] })
    fetchMock.mockImplementationOnce(() =>
          Promise.resolve(json({ prefs: { pinned: true, muted: false, archived: false, markedUnread: false } })),
        )
    await useSessionStore.getState().setSessionPrefs('s1', { pinned: true })
    expect(useSessionStore.getState().sessions[0]?.prefs?.pinned).toBe(true)

    fetchMock.mockImplementationOnce(() => Promise.reject(new Error('网络失败')))
    await expect(useSessionStore.getState().setSessionPrefs('s1', { muted: true })).rejects.toThrow('网络失败')
    expect(useSessionStore.getState().sessions[0]?.prefs).toEqual({
      pinned: true,
      muted: false,
      archived: false,
      markedUnread: false,
    })
  })

  it('归档默认不进主列表；归档视图可单独查看', () => {
    const base = session()
    const archived = {
      ...(base as object),
      id: 'archived',
      prefs: { pinned: false, muted: false, archived: true, markedUnread: false },
    } as never
    const normal = { ...(base as object), id: 'normal' } as never
    expect(filterSessions([archived, normal], 'all').map((s) => s.id)).toEqual(['normal'])
    expect(filterSessions([archived, normal], 'all', { archived: true }).map((s) => s.id)).toEqual(['archived'])
  })

  it('标记未读帧把徽章抬到至少 1', () => {
    useWsStore.setState({ unread: {} })
    handleNotify({
      v: 1,
      id: 'n4',
      seq: 0,
      ts: '',
      type: 'notify:session-prefs',
      sessionId: 'u:u1',
      payload: {
        sessionId: 's2',
        prefs: { pinned: false, muted: false, archived: false, markedUnread: true },
      },
    })
    expect(useWsStore.getState().unread['s2']).toBe(1)
  })

  it('置顶优先排序；多端帧同步偏好；免打扰不弹普通消息提示', async () => {
    useSessionStore.setState({
      // 当前查看 s1：s2 的新消息走跨会话提示路径，才能验证免打扰抑制
      currentId: 's1',
      sessions: [
        session(),
        { ...(session() as object), id: 's2', prefs: { pinned: false, muted: false, archived: false, markedUnread: false } } as never,
      ] as never,
    })
    useSessionStore.setState({
      sessions: [
        session(),
        { ...(session() as object), id: 's2', prefs: { pinned: true, muted: true, archived: false, markedUnread: false } } as never,
      ] as never,
    })
    expect(filterSessions(useSessionStore.getState().sessions, 'all').map((s) => s.id)).toEqual(['s2', 's1'])
    handleNotify({
      v: 1,
      id: 'n1',
      seq: 0,
      ts: '',
      type: 'notify:session-prefs',
      sessionId: 'u:u1',
      payload: { sessionId: 's2', prefs: { pinned: true, muted: true, archived: false, markedUnread: false } },
    })
    expect(useSessionStore.getState().sessions.find((s) => s.id === 's2')?.prefs?.muted).toBe(true)
    const push = vi.mocked(toast)
    push.mockClear()
    handleNotify({
      v: 1,
      id: 'n2',
      seq: 1,
      ts: '',
      type: 'notify:turn-end',
      sessionId: 's2',
      payload: { message: { ...message('m2', 2), sessionId: 's2', userId: 'u2' } },
    })
    expect(push).not.toHaveBeenCalled()
  })
})

describe('权威补齐', () => {
  it('451 条收件箱按 0/200/400 游标取完，不能直接跳到 451', async () => {
    const all: InboxItem[] = Array.from({ length: 451 }, (_, i) => ({
      id: `ib_${i + 1}`,
      seq: i + 1,
      type: 'system',
      title: `${i}`,
      createdAt: '',
    }))
    fetchMock.mockImplementation((url: string) => {
      const since = Number(new URL(url, 'http://localhost').searchParams.get('since'))
      const items = all.filter((i) => i.seq > since).slice(0, 200)
      return Promise.resolve(
        json({
          items,
          cursor: 451,
          nextCursor: items.at(-1)?.seq ?? since,
          hasMore: since < 400,
          unreadCount: 451,
        }),
      )
    })
    await useInboxStore.getState().sync()
    expect(
      fetchMock.mock.calls.map(([url]) => new URL(url, 'http://localhost').searchParams.get('since')),
    ).toEqual(['0', '200', '400'])
    expect(useInboxStore.getState().cursor).toBe(451)
    expect(useInboxStore.getState().items.at(-1)?.seq).toBe(451)
  })

  it('请求途中退出账号，迟到的收件箱不得回填新账号', async () => {
    let finish!: (response: Response) => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    const syncing = useInboxStore.getState().sync()
    useInboxStore.getState().reset()
    finish(json({ items: [{ id: 'old', seq: 1 }], cursor: 1, unreadCount: 1 }))
    await syncing
    expect(useInboxStore.getState().items).toHaveLength(0)
  })

  it('服务重启后序号从 1 开始仍接收，并补齐当前会话正文', async () => {
    const event = (epoch: string, seq: number, id: string): NotifyEnvelope => ({
      v: 1,
      id,
      epoch,
      seq,
      sessionId: 's1',
      ts: '',
      type: 'notify:turn-end',
      payload: { message: message(id, seq) },
    })
    handleNotify(event('before-restart', 80, 'old'))
    handleNotify(event('after-restart', 1, 'new'))
    expect(useSessionStore.getState().byId.has('new')).toBe(true)
    await vi.advanceTimersByTimeAsync(150)
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/sessions/s1')).toBe(true)
  })

  it('迟到快照不能覆盖在途收到的新消息，下一轮补偿再对账', async () => {
    let finish!: (response: Response) => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    const refresh = useSessionStore.getState().refreshMessages(true)
    useSessionStore.getState().upsertMessage(message('newer', 9))
    finish(json({ messages: [message('old', 1)], session: { id: 's1' } }))
    await expect(refresh).rejects.toThrow('稍后重新对账')
    expect(useSessionStore.getState().byId.has('newer')).toBe(true)
  })
})

describe('真实阅读位置', () => {
  it('排除 overscan、视口外消息和未读到末尾的长消息', () => {
    const root = document.createElement('div')
    const rect = (top: number, bottom: number): DOMRect =>
      ({ top, bottom, left: 0, right: 300, width: 300, height: bottom - top }) as DOMRect
    root.getBoundingClientRect = () => rect(0, 500)
    for (const [id, top, bottom] of [
      ['visible', 100, 200],
      ['overscan', 600, 700],
      ['long', 250, 900],
    ] as const) {
      const node = document.createElement('div')
      node.id = `msg-${id}`
      node.getBoundingClientRect = () => rect(top, bottom)
      root.append(node)
    }
    expect(
      visibleMessageSeq(
        root,
        new Map([
          ['visible', message('visible', 3)],
          ['overscan', message('overscan', 9)],
          ['long', message('long', 10)],
        ]),
      ),
    ).toBe(3)
  })

  it('已读失败会重试同一水位，不因最大已加载序号而提前推进', async () => {
    useSessionStore.setState({
      currentId: 'read_retry',
      byId: new Map([['later', { ...message('later', 99), sessionId: 'read_retry' }]]),
    })
    fetchMock.mockRejectedValueOnce(new Error('离线'))
    useWsStore.getState().markRead('read_retry', 3)
    await vi.advanceTimersByTimeAsync(301)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    const reads = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/read'))
    expect(reads).toHaveLength(2)
    expect(reads.map(([, init]) => JSON.parse(init.body).seq)).toEqual([3, 3])
    useWsStore.getState().markRead('read_retry', 2)
    await vi.advanceTimersByTimeAsync(300)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/read'))).toHaveLength(2)
  })

  it('后台页面不产生新的已读上报', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    useWsStore.getState().markRead('s1', 90)
    await vi.advanceTimersByTimeAsync(500)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
