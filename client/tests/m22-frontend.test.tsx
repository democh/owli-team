/**
 * M22 前端测试：面板注册表一致性 / 帧流协议客户端（StreamSocket）/ 浏览器与连接 store / 面板空态与接管入口。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BrowserSessionInfo, ConnectionDefinition, OpEvent } from '@multi-agent/shared'
import { PANEL_DEFS, PANEL_LABELS, GROUPS } from '../src/components/panels/registry'
import { BrowserPanel } from '../src/components/panels/BrowserPanel'
import { ConnectionsConsole } from '../src/components/console/ConnectionsConsole'
import { StreamSocket, type StreamHandlers } from '../src/lib/stream'
import { screenshotUrlOf, useBrowserStore } from '../src/stores/browser-store'
import { useConnectionsStore } from '../src/stores/connections-store'
import { useSessionStore } from '../src/stores/session-store'
import { RIGHT_GROUPS, RIGHT_VIEWS, groupOf } from '../src/stores/ui-store'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function makeHandlers(): { [K in keyof StreamHandlers]-?: ReturnType<typeof vi.fn> } {
  return {
    onStatus: vi.fn(),
    onSubscribed: vi.fn(),
    onFrame: vi.fn(),
    onState: vi.fn(),
    onStep: vi.fn(),
    onSessionClosed: vi.fn(),
    onError: vi.fn(),
  }
}

/** WebSocket 测试替身：记录实例与出站消息，允许手动触发事件 */
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

  lastSent(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1] ?? '{}') as Record<string, unknown>
  }
}

const SESSION: BrowserSessionInfo = {
  id: 'bs_1',
  sessionId: 's1',
  backend: 'local',
  state: 'ready',
  controller: 'agent',
  headless: true,
  viewport: { width: 1280, height: 800 },
  currentUrl: 'https://example.com',
  createdAt: new Date().toISOString(),
  topic: 'browser:bs_1',
}

function makeConnection(): ConnectionDefinition {
  return {
    id: 'conn_1',
    name: '订单库',
    kind: 'postgres',
    config: { host: '127.0.0.1', port: 5432, database: 'orders' },
    status: 'ok',
    enabled: true,
    secretSet: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

/** 面板测试会临时替换 store 动作（load/start/release）：捕获原引用，供 beforeEach 还原 */
const realActions = {
  load: useBrowserStore.getState().load,
  start: useBrowserStore.getState().start,
  release: useBrowserStore.getState().release,
}

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  useSessionStore.setState({ currentId: undefined, sessions: [] })
  useBrowserStore.setState({
    sessionId: undefined,
    session: null,
    history: [],
    steps: [],
    frame: null,
    streamStatus: 'closed',
    mode: 'watch',
    maxFps: 12,
    loading: false,
    busy: false,
    error: undefined,
    ...realActions,
  })
  useConnectionsStore.setState({ connections: [], bindings: [], ops: [], sessionId: undefined, loading: false, busyId: undefined })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  // detach 会更新 store（streamStatus/frame）：组件尚未卸载，需包 act 避免告警
  act(() => useBrowserStore.getState().detach())
})

describe('M22：右栏面板注册表', () => {
  it('面板清单与 ui-store 的 RightView 一一对应且标签齐备', () => {
    // 变更 RightView 而忘记登记面板（或反之）会在此处失败
    const expected = ['members', 'relay', 'graph', 'stats', 'run', 'tasks', 'memory', 'schedules', 'metrics', 'live']
    const ids = PANEL_DEFS.map((p) => p.id)
    expect(ids).toEqual(expected)
    // M26：右栏白名单与面板清单等价（连接管理已迁 rail 控制台，不再是右栏视图）
    expect(RIGHT_VIEWS).toEqual(expected)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(PANEL_LABELS[id]).toBeTruthy()
      expect(PANEL_DEFS.find((p) => p.id === id)?.label).toBe(PANEL_LABELS[id])
    }
    // M49（ADR 0100）：「浏览器」并入「实况」（browser → live）
    expect(PANEL_LABELS.live).toBe('实况')
    // 整高面板（内部滚动的帧流/时间轴/图谱/任务等）
    expect(PANEL_DEFS.find((p) => p.id === 'live')?.fill).toBe(true)
    expect(PANEL_DEFS.find((p) => p.id === 'members')?.fill).toBeUndefined()
  })

  it('M49：面板分组派生（团队 / 运行 / 实况）与 ui-store 分组同源', () => {
    expect(GROUPS.team.map((p) => p.id)).toEqual(['members', 'relay', 'graph', 'stats'])
    expect(GROUPS.ops.map((p) => p.id)).toEqual(['run', 'tasks', 'memory', 'schedules', 'metrics'])
    expect(GROUPS.live.map((p) => p.id)).toEqual(['live'])
    // 分组覆盖全部面板且不重不漏（single source：ui-store.RIGHT_GROUPS）
    for (const p of PANEL_DEFS) {
      expect(RIGHT_GROUPS[p.group].includes(p.id)).toBe(true)
      expect(groupOf(p.id)).toBe(p.group)
    }
  })
})

describe('M22：帧流客户端（StreamSocket）', () => {
  it('订阅 / 帧 / 步骤 / 状态 / 错误事件按协议分发', () => {
    const handlers = makeHandlers()
    const socket = new StreamSocket(handlers)
    socket.connect()
    const ws = FakeWebSocket.instances[0]
    expect(ws.url).toContain('/ws/stream')
    ws.open()
    expect(handlers.onStatus).toHaveBeenLastCalledWith('open')

    socket.subscribe('browser:bs_1', 'tok-1', 'watch')
    expect(ws.lastSent()).toMatchObject({ type: 'subscribe', topic: 'browser:bs_1', token: 'tok-1' })

    ws.emit({ type: 'hello', clientId: 'sc_1' })
    ws.emit({ type: 'subscribed', topic: 'browser:bs_1', mode: 'takeover', maxFps: 12 })
    expect(handlers.onSubscribed).toHaveBeenCalledWith('browser:bs_1', 'takeover', 12)

    // 订阅后模式已升级：输入与归还走最新模式
    socket.input('browser:bs_1', { kind: 'mouse', type: 'down', x: 10, y: 20 })
    expect(ws.lastSent()).toMatchObject({ type: 'input', topic: 'browser:bs_1' })

    ws.emit({ type: 'frame', topic: 'browser:bs_1', seq: 7, data: 'QUJD', ts: 123, url: 'https://a.test' })
    expect(handlers.onFrame).toHaveBeenCalledWith(
      'browser:bs_1',
      expect.objectContaining({ seq: 7, data: 'QUJD', ts: 123, url: 'https://a.test' }),
    )

    ws.emit({ type: 'step', topic: 'browser:bs_1', step: { seq: 2, actor: 'agent', action: 'click', ok: true, ts: 't' } })
    expect(handlers.onStep).toHaveBeenCalledWith('browser:bs_1', expect.objectContaining({ seq: 2, action: 'click' }))

    ws.emit({ type: 'state', topic: 'browser:bs_1', state: 'human', controller: 'human' })
    expect(handlers.onState).toHaveBeenCalledWith('browser:bs_1', 'human', 'human')

    ws.emit({ type: 'error', topic: 'browser:bs_1', message: '缺少有效的流 token', code: 'token_invalid' })
    expect(handlers.onError).toHaveBeenCalledWith('browser:bs_1', '缺少有效的流 token', 'token_invalid')

    ws.emit({ type: 'closed', topic: 'browser:bs_1', reason: '浏览器已退出' })
    expect(handlers.onSessionClosed).toHaveBeenCalledWith('browser:bs_1', '浏览器已退出')

    socket.close()
  })

  it('断线退避重连后自动重订已登记频道；release 降级为 watch', () => {
    vi.useFakeTimers()
    const handlers = makeHandlers()
    const socket = new StreamSocket(handlers)
    socket.connect()
    const ws = FakeWebSocket.instances[0]
    ws.open()
    socket.subscribe('browser:bs_1', 'tok-1', 'watch')
    socket.subscribe('browser:bs_2', 'tok-2', 'takeover')
    expect(socket.topics().sort()).toEqual(['browser:bs_1', 'browser:bs_2'])

    // 服务端断开（非用户主动关闭）→ 1s 后重连
    ws.readyState = 3
    ws.onclose?.()
    expect(handlers.onStatus).toHaveBeenLastCalledWith('closed')
    vi.advanceTimersByTime(1000)
    const reconnected = FakeWebSocket.instances[1]
    reconnected.open()
    const topics = reconnected.sent.map((raw) => JSON.parse(raw).topic as string)
    expect(topics).toEqual(expect.arrayContaining(['browser:bs_1', 'browser:bs_2']))

    socket.release('browser:bs_1')
    expect(reconnected.lastSent()).toMatchObject({ type: 'release', topic: 'browser:bs_1' })

    socket.close()
    expect(handlers.onStatus).toHaveBeenLastCalledWith('closed')
  })

  it('keepOnly 剪枝：仅保留目标频道并通知服务端退订其余频道', () => {
    const handlers = makeHandlers()
    const socket = new StreamSocket(handlers)
    socket.connect()
    const ws = FakeWebSocket.instances[0]
    ws.open()
    socket.subscribe('browser:bs_1', 'tok-1', 'watch')
    socket.subscribe('browser:bs_2', 'tok-2', 'watch')
    socket.keepOnly('browser:bs_1')
    expect(socket.topics()).toEqual(['browser:bs_1'])
    expect(ws.lastSent()).toMatchObject({ type: 'unsubscribe', topic: 'browser:bs_2' })
    socket.close()
  })
})

describe('M22：浏览器面板', () => {
  it('无会话时给出打开入口（后端选择 + 系统打开）', async () => {
    const load = vi.fn().mockResolvedValue(undefined)
    const start = vi.fn().mockResolvedValue(undefined)
    useBrowserStore.setState({ load, start })
    useSessionStore.setState({ currentId: 's1' })

    render(<BrowserPanel />)
    expect(screen.getByText('未连接浏览器')).toBeTruthy()
    const openButton = screen.getByRole('button', { name: /打开浏览器/ })
    await userEvent.click(openButton)
    expect(start).toHaveBeenCalledWith({ backend: 'local', headless: true })
    expect(screen.getByPlaceholderText('https://example.com')).toBeTruthy()
  })

  it('启动形态可切换：选「打开窗口」后以 headless=false 启动；remote 不透传', async () => {
    const load = vi.fn().mockResolvedValue(undefined)
    const start = vi.fn().mockResolvedValue(undefined)
    useBrowserStore.setState({ load, start })
    useSessionStore.setState({ currentId: 's1' })

    render(<BrowserPanel />)
    await userEvent.click(screen.getByRole('button', { name: '打开窗口' }))
    await userEvent.click(screen.getByRole('button', { name: /打开浏览器/ }))
    expect(start).toHaveBeenLastCalledWith({ backend: 'local', headless: false })

    // remote：形态由对方浏览器决定，不透传 headless
    await userEvent.click(screen.getByRole('button', { name: /remote 远程/ }))
    await userEvent.click(screen.getByRole('button', { name: /打开浏览器/ }))
    expect(start).toHaveBeenLastCalledWith({ backend: 'remote' })
  })

  it('有会话时渲染帧画面、接管/归还状态与步骤时间轴', () => {
    useBrowserStore.setState({
      sessionId: 's1',
      session: SESSION,
      frame: { seq: 3, data: 'QUJD', ts: 1, url: 'https://example.com', width: 1280, height: 800 },
      steps: [
        {
          id: 1,
          browserSessionId: 'bs_1',
          sessionId: 's1',
          seq: 1,
          actor: 'agent',
          action: 'navigate',
          ok: true,
          durationMs: 120,
          ts: new Date().toISOString(),
        },
      ],
      streamStatus: 'open',
      mode: 'watch',
      load: vi.fn().mockResolvedValue(undefined),
    })
    useSessionStore.setState({ currentId: 's1' })

    render(<BrowserPanel />)
    const img = screen.getByAltText('浏览器画面') as HTMLImageElement
    expect(img.src).toBe('data:image/jpeg;base64,QUJD')
    expect(screen.getByText('就绪')).toBeTruthy()
    expect(screen.getByText('local 本机')).toBeTruthy()
    expect(screen.getByText('无头')).toBeTruthy() // 启动形态徽章
    expect(screen.getByRole('button', { name: /人工接管/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /归还给 Agent/ })).toBeNull()
    expect(screen.getByText('navigate')).toBeTruthy()
    expect(screen.getByText('步骤时间轴（1）')).toBeTruthy()
  })

  it('重连中状态与复用实例徽章：区分恢复连接与形态说明', () => {
    useBrowserStore.setState({
      sessionId: 's1',
      session: { ...SESSION, state: 'reconnecting', external: true },
      streamStatus: 'open',
      mode: 'watch',
      load: vi.fn().mockResolvedValue(undefined),
    })
    useSessionStore.setState({ currentId: 's1' })

    render(<BrowserPanel />)
    expect(screen.getByText('重连中')).toBeTruthy()
    expect(screen.getByText('复用实例')).toBeTruthy()
  })

  it('接管态显示归还按钮；截图路径可映射为服务端 URL', async () => {
    const release = vi.fn().mockResolvedValue(undefined)
    useBrowserStore.setState({
      sessionId: 's1',
      session: { ...SESSION, controller: 'human', state: 'human' },
      streamStatus: 'open',
      mode: 'takeover',
      release,
      load: vi.fn().mockResolvedValue(undefined),
    })
    useSessionStore.setState({ currentId: 's1' })

    render(<BrowserPanel />)
    expect(screen.getByText('接管中')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /归还给 Agent/ }))
    expect(release).toHaveBeenCalled()

    expect(screenshotUrlOf({ screenshotPath: '/data/screenshots/bs_1/1712-click.jpg' } as never)).toBe(
      '/api/browser/screenshots/bs_1/1712-click.jpg',
    )
    expect(screenshotUrlOf({ screenshotPath: undefined } as never)).toBeUndefined()
  })
})

describe('M22：连接管理（控制台）与 store', () => {
  it('连接清单渲染（含密文标记与主机信息）并在「操作」页签展示事件流', async () => {
    const connection = makeConnection()
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/connections')) return Promise.resolve(jsonResponse({ connections: [connection] }))
      if (url.includes('/connections')) return Promise.resolve(jsonResponse({ bindings: [] }))
      if (url.includes('/api/audit')) return Promise.resolve(jsonResponse({ entries: [] }))
      return Promise.resolve(jsonResponse({}, 404))
    })
    useSessionStore.setState({ currentId: 's1' })
    useConnectionsStore.setState({
      ops: [
        {
          id: 'op1',
          ts: new Date().toISOString(),
          sessionId: 's1',
          actor: 'analyst',
          kind: 'db',
          action: 'db.query',
          status: 'ok',
          durationMs: 42,
          summary: 'SELECT 1',
        } as OpEvent,
      ],
    })

    render(<ConnectionsConsole />)
    expect(await screen.findByText('订单库')).toBeTruthy()
    expect(screen.getByText('PostgreSQL')).toBeTruthy()
    expect(screen.getByText('127.0.0.1:5432/orders')).toBeTruthy()
    // allowWrites 未开启：不出现「允许写入」标记（queryBy 避免找不到即抛错）
    expect(screen.queryByText('允许写入')).toBeNull()
    expect(screen.getByRole('button', { name: '测试' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /绑定/ })).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '操作' }))
    expect(screen.getByText('db.query')).toBeTruthy()
    expect(screen.getByText('SELECT 1')).toBeTruthy()
  })

  it('store：会话绑定加载（合并历史审计与实时事件、按 id 去重）与解绑', async () => {
    const connection = makeConnection()
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/audit')) {
        return Promise.resolve(
          jsonResponse({
            entries: [
              {
                id: 11,
                ts: '2026-09-16T10:00:00.000Z',
                actor: 'user',
                action: 'connection.bind',
                ok: true,
                sessionId: 's1',
                detail: { name: '订单库' },
              },
            ],
          }),
        )
      }
      if (url.includes('/api/sessions/s1/connections')) {
        return Promise.resolve(jsonResponse({ bindings: [{ connection, grantedAt: '2026-09-16T10:00:00.000Z' }] }))
      }
      return Promise.resolve(jsonResponse({ connections: [connection] }))
    })

    await useConnectionsStore.getState().loadForSession('s1')
    const state = useConnectionsStore.getState()
    expect(state.connections.map((c) => c.id)).toEqual(['conn_1'])
    expect(state.bindings.map((b) => b.connection.id)).toEqual(['conn_1'])
    expect(state.ops.map((o) => o.id)).toEqual(['audit:11'])
    expect(state.ops[0]?.kind).toBe('connection')

    // 实时事件去重 + 最新在前
    const live: OpEvent = {
      id: 'bs_1:3',
      ts: '2026-09-16T10:05:00.000Z',
      sessionId: 's1',
      actor: 'u_analyst',
      kind: 'browser',
      action: 'browser.click',
      status: 'ok',
      summary: '点击登录按钮',
    }
    useConnectionsStore.getState().pushOp(live)
    useConnectionsStore.getState().pushOp(live)
    expect(useConnectionsStore.getState().ops.map((o) => o.id)).toEqual(['bs_1:3', 'audit:11'])

    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ bindings: [] })))
    await useConnectionsStore.getState().unbind('conn_1')
    expect(useConnectionsStore.getState().bindings).toEqual([])
  })

  it('store：加载后浏览器会话与步骤就绪（帧流入口）', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/browser/sessions/bs_1/steps')) {
        return Promise.resolve(
          jsonResponse({
            steps: [{ id: 1, browserSessionId: 'bs_1', sessionId: 's1', seq: 1, actor: 'agent', action: 'navigate', ok: true, ts: 't' }],
          }),
        )
      }
      if (url.includes('/stream-token')) return Promise.resolve(jsonResponse({ token: 'tok', topic: 'browser:bs_1', mode: 'watch', expiresIn: 600 }))
      return Promise.resolve(jsonResponse({ active: SESSION, history: [] }))
    })

    await useBrowserStore.getState().load('s1')
    const state = useBrowserStore.getState()
    expect(state.session?.id).toBe('bs_1')
    expect(state.steps.map((s) => s.seq)).toEqual([1])
    // 订阅已发出（FakeWebSocket 捕获）
    const ws = FakeWebSocket.instances[0]
    expect(ws.sent.some((raw) => raw.includes('"type":"subscribe"'))).toBe(true)
    expect(state.mode).toBe('watch')
  })
})

describe('M22：浏览器 store · 会话失效回源对齐', () => {
  it('当前频道 session_gone：静默回源对齐（会话归零、红条不出现、历史更新）', async () => {
    useBrowserStore.setState({ sessionId: 's1', session: SESSION, error: '旧错误' })
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/stream-token')) {
        return Promise.resolve(jsonResponse({ token: 'tok-1', topic: 'browser:bs_1', mode: 'watch', expiresIn: 600 }))
      }
      if (url.includes('/api/sessions/s1/browser')) {
        return Promise.resolve(jsonResponse({ active: null, history: [{ ...SESSION, state: 'closed' }] }))
      }
      return Promise.resolve(jsonResponse({}, 404))
    })

    await useBrowserStore.getState().watch()
    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.emit({ type: 'error', topic: 'browser:bs_1', message: '浏览器会话不存在或已关闭', code: 'session_gone' })

    await vi.waitFor(() => expect(useBrowserStore.getState().session).toBeNull())
    const state = useBrowserStore.getState()
    expect(state.error).toBeUndefined()
    expect(state.history.map((s) => s.id)).toEqual(['bs_1'])
    expect(state.frame).toBeNull()
  })

  it('非当前频道 session_gone：静默忽略，不触发回源也不打断当前会话', async () => {
    useBrowserStore.setState({ sessionId: 's1', session: SESSION })
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/stream-token')) {
        return Promise.resolve(jsonResponse({ token: 'tok-1', topic: 'browser:bs_1', mode: 'watch', expiresIn: 600 }))
      }
      return Promise.resolve(jsonResponse({}, 404))
    })

    await useBrowserStore.getState().watch()
    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.emit({ type: 'error', topic: 'browser:bs_99', message: '浏览器会话不存在或已关闭', code: 'session_gone' })

    expect(useBrowserStore.getState().session?.id).toBe('bs_1')
    expect(useBrowserStore.getState().error).toBeUndefined()
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/sessions/s1/browser'))).toHaveLength(0)
  })
})
