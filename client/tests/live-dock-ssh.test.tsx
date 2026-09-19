/**
 * 操作直播 · SSH 三合一（M23+）单测：
 * - 镜像纯函数：stripAnsi（CSI/OSC/退格）/ appendMirrorLines（续行、\r 覆盖、限行截断）；
 * - busy 推导：opFaceOfTool 映射 + busyFaceSignature（仅 running、排序去重）；
 * - store 映射：noteOp ssh → 切 ssh tab；connections-store 审计回放放行 ssh. 前缀行；
 * - 终端镜像广播：二进制输出旁路（ANSI 清洗）+ 订阅通知；exit 提示双写；close 后清空；
 * - DockSshView：审批条（pending「远程主机」→ 跳对话页）/ 命令卡 / 执行中提示 / 镜像渲染 / 空态；
 * - LiveDock：SSH tab 切换、窄卡图标化（<380px）、胶囊 SSH 文案与计数徽标。
 */
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest, ChatMessage, OpEvent } from '@multi-agent/shared'
import { MIRROR_MAX_LINE_CHARS, appendMirrorLines, stripAnsi } from '../src/lib/terminal-mirror'
import { busyFaceSignature, opFaceOfTool } from '../src/lib/use-busy-ops'
import type { TerminalRuntime } from '../src/lib/terminal-runtime'
import { DockSshView } from '../src/components/live/DockSshView'
import { LiveDock } from '../src/components/live/LiveDock'
import { useConnectionsStore } from '../src/stores/connections-store'
import { DOCK_DEFAULT_SIZE, useLiveDockStore } from '../src/stores/live-dock-store'
import { useRunStore } from '../src/stores/run-store'
import { useSessionStore } from '../src/stores/session-store'
import { __setRuntimeFactory, mirrorOf, subscribeMirror, useTerminalStore } from '../src/stores/terminal-store'
import { useUiStore } from '../src/stores/ui-store'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

/** WebSocket 替身（复用 m23-frontend 模式）：出站帧由调用方断言 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  readyState = 1
  binaryType = 'blob'
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(data: unknown): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.onclose?.()
  }

  open(): void {
    this.onopen?.()
  }

  emitText(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  emitBinary(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
  }
}

/** xterm 替身：记录写出字节 / 提示行（不渲染真实终端） */
class FakeRuntime implements TerminalRuntime {
  element = document.createElement('div')
  bytes: Uint8Array[] = []
  notices: string[] = []
  private dataCbs = new Set<(data: string) => void>()
  private resizeCbs = new Set<(cols: number, rows: number) => void>()

  writeBytes(bytes: Uint8Array): void {
    this.bytes.push(bytes)
  }

  writeNotice(text: string): void {
    this.notices.push(text)
  }

  onData(cb: (data: string) => void): () => void {
    this.dataCbs.add(cb)
    return () => this.dataCbs.delete(cb)
  }

  onResize(cb: (cols: number, rows: number) => void): () => void {
    this.resizeCbs.add(cb)
    return () => this.resizeCbs.delete(cb)
  }

  size(): { cols: number; rows: number } {
    return { cols: 100, rows: 30 }
  }

  fit(): void {}

  focus(): void {}

  dispose(): void {}

  emitData(data: string): void {
    for (const cb of this.dataCbs) cb(data)
  }

  emitResize(cols: number, rows: number): void {
    for (const cb of this.resizeCbs) cb(cols, rows)
  }
}

const createdRuntimes: FakeRuntime[] = []

function makeOp(over: Partial<OpEvent> = {}): OpEvent {
  return {
    id: 'op1',
    ts: new Date().toISOString(),
    sessionId: 's1',
    runId: 'r1',
    actor: 'analyst',
    kind: 'ssh',
    action: 'ssh.exec',
    status: 'ok',
    ...over,
  }
}

function toolMessage(calls: Array<{ name: string; status: 'running' | 'ok' | 'error' }>): ChatMessage {
  return {
    id: 'm1',
    sessionId: 's1',
    role: 'agent',
    agentId: 'analyst',
    content: '',
    mentions: [],
    status: 'streaming',
    createdAt: new Date().toISOString(),
    toolCalls: calls.map((c, i) => ({
      id: `tc${i}`,
      name: c.name,
      args: {},
      status: c.status,
      startedAt: new Date().toISOString(),
    })),
  }
}

function mapOfMessages(...messages: ChatMessage[]): Map<string, ChatMessage> {
  return new Map(messages.map((m) => [m.id, m]))
}

const PENDING_APPROVAL: ApprovalRequest = {
  id: 'ap1',
  runId: 'r1',
  sessionId: 's1',
  agentId: 'analyst',
  action: 'analyst请求在远程主机执行命令',
  detail: '连接：远端主机\n命令：\nls -la /var/log',
  options: ['approve', 'reject'],
  status: 'pending',
  createdAt: new Date().toISOString(),
}

/** token 接口就位（SSH 终端 open 全链路的前置） */
function mockTokenApi(): void {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/ssh/terminal-token')) {
      return Promise.resolve(jsonResponse({ token: 'tk-1', topic: 'ssh:conn_ssh', mode: 'terminal', expiresIn: 300 }))
    }
    return Promise.resolve(jsonResponse({ connections: [] }))
  })
}

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  createdRuntimes.length = 0
  __setRuntimeFactory(() => {
    const runtime = new FakeRuntime()
    createdRuntimes.push(runtime)
    return runtime
  })
  localStorage.clear()
  useSessionStore.setState({ currentId: 's1', byId: new Map(), sessions: [] })
  useRunStore.setState({ active: false, approvals: [] })
  useLiveDockStore.setState({
    visible: false,
    mode: 'dock',
    tab: 'browser',
    pos: null,
    size: DOCK_DEFAULT_SIZE,
    muted: false,
    autoRunId: undefined,
    tabLockedAt: undefined,
    lastOp: undefined,
  })
  useConnectionsStore.setState({ connections: [], bindings: [], ops: [], sessionId: undefined, busyId: undefined })
  useTerminalStore.setState({ sessions: [], activeId: undefined })
  useUiStore.setState({ mainTab: 'chat', rightView: 'members', appView: 'workspace' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  // 清理终端会话（断开运行时，避免跨测试泄漏）；act 包裹：挂载中的镜像订阅会触发重渲染
  act(() => {
    for (const session of useTerminalStore.getState().sessions) useTerminalStore.getState().close(session.id)
  })
})

describe('终端镜像纯函数（terminal-mirror）', () => {
  it('stripAnsi：CSI 颜色 / OSC 标题 / 响铃退格', () => {
    expect(stripAnsi('\x1b[1;32mok\x1b[0m plain')).toBe('ok plain')
    expect(stripAnsi('\x1b]0;title\x07body')).toBe('body')
    expect(stripAnsi('a\x07b\x08c')).toBe('abc')
    expect(stripAnsi('\x1b[2K\x1b[1A')).toBe('')
  })

  it('appendMirrorLines：半行续接 + 换行分行 + 空行保留', () => {
    let lines = appendMirrorLines([], 'hel')
    expect(lines).toEqual(['hel'])
    lines = appendMirrorLines(lines, 'lo\nworld\n')
    expect(lines).toEqual(['hello', 'world', ''])
  })

  it('appendMirrorLines：\\r 覆盖取末段；限行截断；超长行截断', () => {
    expect(appendMirrorLines([], '10%\r55%\r100%\ndone')).toEqual(['100%', 'done'])
    expect(appendMirrorLines([], 'a\nb\nc\nd\ne\n', 3)).toEqual(['d', 'e', ''])
    const long = appendMirrorLines([], 'x'.repeat(MIRROR_MAX_LINE_CHARS + 200))
    expect(long[0]?.length).toBe(MIRROR_MAX_LINE_CHARS + 1)
    expect(long[0]?.endsWith('…')).toBe(true)
  })
})

describe('运行中操作面推导（use-busy-ops）', () => {
  it('opFaceOfTool：ssh_exec / db_* / browser_* 归一，其他工具忽略', () => {
    expect(opFaceOfTool('ssh_exec')).toBe('ssh')
    expect(opFaceOfTool('db_query')).toBe('db')
    expect(opFaceOfTool('browser_click')).toBe('browser')
    expect(opFaceOfTool('run_command')).toBeUndefined()
  })

  it('busyFaceSignature：仅 running 计入并排序去重；无 → 空串', () => {
    expect(busyFaceSignature(mapOfMessages(toolMessage([{ name: 'ssh_exec', status: 'running' }, { name: 'db_rows', status: 'ok' }])))).toBe('ssh')
    expect(
      busyFaceSignature(
        mapOfMessages(
          toolMessage([
            { name: 'ssh_exec', status: 'running' },
            { name: 'browser_navigate', status: 'running' },
            { name: 'db_query', status: 'running' },
          ]),
        ),
      ),
    ).toBe('browser:db:ssh')
    expect(busyFaceSignature(new Map())).toBe('')
  })
})

describe('store 映射（noteOp / 审计回放）', () => {
  it('noteOp：ssh 操作自动滑入并选中 SSH tab', () => {
    useLiveDockStore.getState().noteOp(makeOp({ kind: 'ssh', action: 'ssh.exec', summary: 'exit 0（12ms）' }))
    const s = useLiveDockStore.getState()
    expect(s.visible).toBe(true)
    expect(s.mode).toBe('dock')
    expect(s.tab).toBe('ssh')
    expect(s.lastOp?.action).toBe('ssh.exec')
  })

  it('connections-store：审计回放放行 ssh. 前缀行（历史过滤修复）', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/audit')) {
        return Promise.resolve(
          jsonResponse({
            entries: [
              { id: 1, ts: '2026-09-17T01:00:00.000Z', actor: 'analyst', action: 'db.query', ok: true, sessionId: 's1' },
              {
                id: 2,
                ts: '2026-09-17T02:00:00.000Z',
                actor: 'analyst',
                action: 'ssh.exec',
                ok: true,
                sessionId: 's1',
                detail: { summary: 'exit 0' },
              },
            ],
          }),
        )
      }
      if (url.includes('/api/sessions/')) return Promise.resolve(jsonResponse({ bindings: [] }))
      return Promise.resolve(jsonResponse({ connections: [] }))
    })
    await useConnectionsStore.getState().loadForSession('s1')
    const ops = useConnectionsStore.getState().ops
    expect(ops.map((o) => o.kind)).toEqual(['ssh', 'db'])
    expect(ops[0]?.action).toBe('ssh.exec')
  })
})

describe('终端输出镜像广播（terminal-store）', () => {
  it('二进制输出：旁路镜像（ANSI 清洗）+ 订阅通知；close 后清空', async () => {
    mockTokenApi()
    const id = await useTerminalStore.getState().open({ id: 'conn_ssh', name: '远端主机' })
    expect(id).toBeTruthy()
    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.emitText({ type: 'ready', cols: 100, rows: 30 })

    const notified = vi.fn()
    const off = subscribeMirror(notified)
    ws.emitBinary(new TextEncoder().encode('\x1b[32m$\x1b[0m ls\nfile.txt\n'))

    expect(notified).toHaveBeenCalledTimes(1)
    expect(mirrorOf(id!)).toEqual(['$ ls', 'file.txt', ''])
    // 镜像为旁路：终端画面仍收到原始字节（含 ANSI）
    expect(new TextDecoder().decode(createdRuntimes[0]?.bytes[0] ?? new Uint8Array())).toContain('\x1b[32m$')

    off()
    useTerminalStore.getState().close(id!)
    expect(mirrorOf(id!)).toEqual([])
  })

  it('exit 帧：xterm 提示与镜像行双写', async () => {
    mockTokenApi()
    const id = await useTerminalStore.getState().open({ id: 'conn_ssh', name: '远端主机' })
    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.emitText({ type: 'ready', cols: 100, rows: 30 })
    ws.emitText({ type: 'exit', code: 3 })

    expect(createdRuntimes[0]?.notices.some((n) => n.includes('exit 3'))).toBe(true)
    expect(mirrorOf(id!).some((line) => line.includes('exit 3'))).toBe(true)
  })
})

describe('DockSshView 组件', () => {
  it('ssh_exec 审批挂起：琥珀条 + 「去处理」跳对话页并折叠', async () => {
    useRunStore.setState({ active: true, approvals: [PENDING_APPROVAL] })
    useConnectionsStore.setState({ sessionId: 's1', ops: [] })
    render(<DockSshView />)
    expect(screen.getByText('analyst请求在远程主机执行命令')).toBeTruthy()
    expect(screen.getByText(/连接：远端主机/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /去处理/ }))
    expect(useUiStore.getState().mainTab).toBe('chat')
    expect(useLiveDockStore.getState().mode).toBe('pill')
  })

  it('命令卡：徽标 / 概要 / 命令详情 / 耗时', () => {
    useConnectionsStore.setState({
      sessionId: 's1',
      ops: [
        makeOp({
          kind: 'ssh',
          action: 'ssh.exec',
          target: 'conn:远端主机',
          summary: 'exit 0（12ms）',
          detail: '$ ls -la\nfile.txt',
          durationMs: 12,
        }),
      ],
    })
    render(<DockSshView />)
    expect(screen.getByText('执行')).toBeTruthy()
    expect(screen.getByText(/exit 0（12ms）/)).toBeTruthy()
    expect(screen.getByText(/\$ ls -la/, { selector: 'pre' })).toBeTruthy()
    expect(screen.getByText('12ms')).toBeTruthy()
  })

  it('执行中：run 活跃 + ssh_exec running → 提示条（无审批时）', () => {
    useRunStore.setState({ active: true })
    useSessionStore.setState({ currentId: 's1', byId: mapOfMessages(toolMessage([{ name: 'ssh_exec', status: 'running' }])) })
    useConnectionsStore.setState({ sessionId: 's1', ops: [] })
    render(<DockSshView />)
    expect(screen.getByText(/Agent 正在远程主机执行命令/)).toBeTruthy()
  })

  it('终端镜像：open 会话输出经清洗渲染；挂载后输出实时拉取', async () => {
    mockTokenApi()
    const id = await useTerminalStore.getState().open({ id: 'conn_ssh', name: '远端主机' })
    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.emitText({ type: 'ready', cols: 100, rows: 30 })
    ws.emitBinary(new TextEncoder().encode('\x1b[32m$\x1b[0m ls\nfile.txt\n'))
    useConnectionsStore.setState({ sessionId: 's1', ops: [] })

    render(<DockSshView />)
    expect(screen.getByText(/只读镜像/)).toBeTruthy()
    expect(screen.getByText('已连接')).toBeTruthy()
    expect(screen.getByText(/\$ ls/)).toBeTruthy()
    expect(id).toBeTruthy()

    // 挂载后新输出 → 通知触发重渲染 → 新行出现
    await act(async () => {
      ws.emitBinary(new TextEncoder().encode('new-line\n'))
    })
    expect(screen.getByText(/new-line/)).toBeTruthy()
  })

  it('空态：无审批 / 命令 / 终端 → 引导连接管理', async () => {
    render(<DockSshView />)
    expect(screen.getByText(/暂无 SSH 操作/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /打开连接管理/ }))
    expect(useUiStore.getState().appView).toBe('connections')
    expect(useLiveDockStore.getState().mode).toBe('pill')
  })
})

describe('LiveDock：SSH 集成', () => {
  it('胶囊：SSH 操作文案 + 点击展开', async () => {
    useLiveDockStore.setState({
      visible: true,
      mode: 'pill',
      lastOp: makeOp({ kind: 'ssh', action: 'ssh.exec', summary: 'exit 0' }),
    })
    render(<LiveDock />)
    const label = screen.getByText('SSH 操作 · exit 0')
    await userEvent.click(label)
    expect(useLiveDockStore.getState().mode).toBe('dock')
  })

  it('胶囊计数徽标：≥2 个操作面执行中', () => {
    useRunStore.setState({ active: true })
    useSessionStore.setState({
      currentId: 's1',
      byId: mapOfMessages(
        toolMessage([
          { name: 'ssh_exec', status: 'running' },
          { name: 'db_query', status: 'running' },
        ]),
      ),
    })
    useLiveDockStore.setState({ visible: true, mode: 'pill', lastOp: makeOp({ kind: 'ssh' }) })
    render(<LiveDock />)
    expect(screen.getByText('2')).toBeTruthy()
  })

  it('卡片三 tab：点击 SSH 切到 SSH 视图', async () => {
    useLiveDockStore.setState({ visible: true, mode: 'dock', tab: 'browser' })
    useConnectionsStore.setState({ sessionId: 's1', ops: [] })
    render(<LiveDock />)
    expect(screen.queryByText(/暂无 SSH 操作/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'SSH' }))
    expect(useLiveDockStore.getState().tab).toBe('ssh')
    expect(screen.getByText(/暂无 SSH 操作/)).toBeTruthy()
  })

  it('窄卡（<380px）tab 图标化；默认宽度显示文字', () => {
    useLiveDockStore.setState({ visible: true, mode: 'dock', tab: 'db', size: { w: 360, h: 300 } })
    useConnectionsStore.setState({ sessionId: 's1', ops: [] })
    const { unmount } = render(<LiveDock />)
    expect(screen.queryByText('数据库')).toBeNull()
    expect(screen.getByTitle('数据库')).toBeTruthy()
    unmount()

    useLiveDockStore.setState({ size: DOCK_DEFAULT_SIZE })
    render(<LiveDock />)
    expect(screen.getByText('数据库')).toBeTruthy()
  })
})
