/**
 * M23 前端测试：
 * - 数据库工作台 store：连接过滤 / 分页与排序三态 / 写确认两步流（dryRun → execute）；
 * - 对象树纯函数：过滤与模式分组；
 * - SSH 终端 store：token → WS → ready/exit/error 状态机、二进制输入输出、resize 帧、重连、运行时注入；
 * - 连接管理（控制台）：SSH 完整表单（认证方式切换 / 保存载荷契约 / 「本地（本机）」一键预置回填）与「打开/终端」入口。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ConnectionDefinition } from '@multi-agent/shared'
import { filterTables, groupBySchema } from '../src/components/database/DatabaseWorkbench'
import { ConnectionsConsole } from '../src/components/console/ConnectionsConsole'
import type { TerminalRuntime } from '../src/lib/terminal-runtime'
import { useConnectionsStore } from '../src/stores/connections-store'
import { useDatabaseStore } from '../src/stores/database-store'
import { useSessionStore } from '../src/stores/session-store'
import { __setRuntimeFactory, useTerminalStore } from '../src/stores/terminal-store'
import { useUiStore } from '../src/stores/ui-store'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

/** WebSocket 替身：文本/二进制出站都由调用方断言（SSH 终端协议） */
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

  lastJson(): Record<string, unknown> {
    const last = this.sent[this.sent.length - 1]
    return JSON.parse(String(last ?? '{}')) as Record<string, unknown>
  }
}

/** xterm 替身：记录写出字节 / 提示行 / 订阅与生命周期（不渲染真实终端） */
class FakeRuntime implements TerminalRuntime {
  element = document.createElement('div')
  bytes: Uint8Array[] = []
  notices: string[] = []
  fitted = 0
  focused = 0
  disposed = 0
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

  fit(): void {
    this.fitted += 1
  }

  focus(): void {
    this.focused += 1
  }

  dispose(): void {
    this.disposed += 1
  }

  emitData(data: string): void {
    for (const cb of this.dataCbs) cb(data)
  }

  emitResize(cols: number, rows: number): void {
    for (const cb of this.resizeCbs) cb(cols, rows)
  }
}

function makeConnection(over: Partial<ConnectionDefinition>): ConnectionDefinition {
  return {
    id: 'conn_pg',
    name: '订单库',
    kind: 'postgres',
    config: { host: '127.0.0.1', port: 5432, database: 'orders' },
    status: 'ok',
    enabled: true,
    secretSet: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  }
}

const PG = makeConnection({})
const SSH = makeConnection({
  id: 'conn_ssh',
  name: '远端主机',
  kind: 'ssh',
  config: { host: '10.0.0.8', port: 22, username: 'deploy', authMethod: 'password' },
})
const CHROME = makeConnection({ id: 'conn_chrome', name: '浏览器', kind: 'chrome', config: { backend: 'local' } })

const createdRuntimes: FakeRuntime[] = []

const resetDatabase = (): void =>
  useDatabaseStore.setState({
    connections: [],
    loadingConnections: false,
    selectedId: undefined,
    schemas: {},
    filter: '',
    tabs: [],
    activeTabId: undefined,
    queries: {},
  })

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
  resetDatabase()
  useTerminalStore.setState({ sessions: [], activeId: undefined })
  useUiStore.setState({ mainTab: 'chat', rightView: 'members', deepFrom: undefined })
  useSessionStore.setState({ currentId: undefined, sessions: [] })
  useConnectionsStore.setState({ connections: [], bindings: [], ops: [], sessionId: undefined, loading: false, busyId: undefined })
})

afterEach(() => {
  vi.unstubAllGlobals()
  // 清理终端会话（断开关联的 runtime，避免测试间泄漏）
  for (const session of useTerminalStore.getState().sessions) useTerminalStore.getState().close(session.id)
})

describe('M23：数据库工作台 store', () => {
  it('load 只保留数据库连接并默认选中第一个（自动拉取结构）', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/schema')) return Promise.resolve(jsonResponse({ tables: [], truncated: false }))
      return Promise.resolve(jsonResponse({ connections: [PG, SSH, CHROME] }))
    })
    await useDatabaseStore.getState().load()
    const state = useDatabaseStore.getState()
    expect(state.connections.map((c) => c.id)).toEqual(['conn_pg'])
    expect(state.selectedId).toBe('conn_pg')
    await waitFor(() => expect(useDatabaseStore.getState().schemas.conn_pg?.loadedAt).toBeTruthy())
  })

  it('openTable：开数据页签 + 分页拉取；重复打开只激活；closeTab 激活顺延', async () => {
    const rowCalls: string[] = []
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/tables/users/rows')) {
        rowCalls.push(url)
        return Promise.resolve(jsonResponse({ columns: ['id', 'name'], rows: [{ id: 1, name: 'ann' }], offset: 0, limit: 100, hasMore: true, durationMs: 3 }))
      }
      if (url.includes('/schema')) {
        return Promise.resolve(
          jsonResponse({ tables: [{ schema: 'public', name: 'users', columns: [{ name: 'id', type: 'int4' }] }], truncated: false }),
        )
      }
      return Promise.resolve(jsonResponse({ connections: [PG] }))
    })
    await useDatabaseStore.getState().load()
    await waitFor(() => expect(useDatabaseStore.getState().schemas.conn_pg?.loadedAt).toBeTruthy())
    await useDatabaseStore.getState().openTable('conn_pg', 'users', 'public')
    const id = 't:conn_pg:public.users'
    let state = useDatabaseStore.getState()
    expect(state.tabs.map((t) => t.id)).toEqual([id])
    expect(state.activeTabId).toBe(id)
    expect(state.tabs[0]?.rows).toEqual([{ id: 1, name: 'ann' }])
    expect(state.tabs[0]?.hasMore).toBe(true)
    expect(state.tabs[0]?.columnsMeta?.map((c) => c.name)).toEqual(['id'])
    expect(rowCalls[0]).toContain('offset=0&limit=100')
    expect(rowCalls[0]).toContain('schema=public')

    // 重复打开：不再请求、只激活
    await useDatabaseStore.getState().openTable('conn_pg', 'users', 'public')
    expect(useDatabaseStore.getState().tabs.length).toBe(1)
    expect(rowCalls.length).toBe(1)

    // 第二张表 + 关闭激活页签 → 激活顺延到前一个
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/tables/logs/rows')) {
        return Promise.resolve(jsonResponse({ columns: ['ts'], rows: [], offset: 0, limit: 100, hasMore: false, durationMs: 1 }))
      }
      return Promise.resolve(jsonResponse({ connections: [PG] }))
    })
    await useDatabaseStore.getState().openTable('conn_pg', 'logs')
    useDatabaseStore.getState().closeTab('t:conn_pg:.logs')
    state = useDatabaseStore.getState()
    expect(state.tabs.map((t) => t.id)).toEqual([id])
    expect(state.activeTabId).toBe(id)
  })

  it('列头排序三态循环：ASC → DESC → 取消（均回第 1 页）', async () => {
    const urls: string[] = []
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/tables/users/rows')) {
        urls.push(url)
        return Promise.resolve(jsonResponse({ columns: ['id', 'age'], rows: [], offset: 0, limit: 100, hasMore: false, durationMs: 1 }))
      }
      return Promise.resolve(jsonResponse({ connections: [PG] }))
    })
    await useDatabaseStore.getState().openTable('conn_pg', 'users')
    const id = 't:conn_pg:.users'

    await useDatabaseStore.getState().setSort(id, 'age')
    expect(useDatabaseStore.getState().tabs[0]?.orderBy).toBe('age')
    expect(urls[urls.length - 1]).toContain('orderBy=age&desc=false')
    expect(urls[urls.length - 1]).toContain('offset=0')

    await useDatabaseStore.getState().setSort(id, 'age')
    expect(useDatabaseStore.getState().tabs[0]?.desc).toBe(true)
    expect(urls[urls.length - 1]).toContain('orderBy=age&desc=true')

    await useDatabaseStore.getState().setSort(id, 'age')
    expect(useDatabaseStore.getState().tabs[0]?.orderBy).toBeUndefined()
    expect(urls[urls.length - 1]).not.toContain('orderBy=')
  })

  it('runSql 只读语句：dryRun 分类后直接执行（两次 POST），结果与历史落库', async () => {
    const bodies: Array<Record<string, unknown>> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/connections/conn_pg/sql') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        bodies.push(body)
        if (body.dryRun) return Promise.resolve(jsonResponse({ mode: 'query', dryRun: true }))
        return Promise.resolve(
          jsonResponse({ mode: 'query', result: { columns: ['n'], rows: [{ n: 1 }], rowCount: 1, durationMs: 2 } }),
        )
      }
      return Promise.resolve(jsonResponse({ connections: [PG] }))
    })
    useDatabaseStore.getState().setSql('conn_pg', 'SELECT 1')
    const outcome = await useDatabaseStore.getState().runSql('conn_pg')
    expect(outcome).toEqual({ mode: 'query', needsConfirm: false })
    expect(bodies.length).toBe(2)
    expect(bodies[0]?.dryRun).toBe(true)
    expect(bodies[1]?.dryRun).toBeUndefined()
    const query = useDatabaseStore.getState().queries.conn_pg
    expect(query?.result?.rowCount).toBe(1)
    expect(query?.history).toEqual(['SELECT 1'])
    expect(query?.running).toBe(false)
  })

  it('runSql 写语句两步流：dryRun 返回 execute → needsConfirm；确认后单步直发', async () => {
    const bodies: Array<Record<string, unknown>> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/connections/conn_pg/sql') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        bodies.push(body)
        if (body.dryRun) return Promise.resolve(jsonResponse({ mode: 'execute', dryRun: true }))
        return Promise.resolve(
          jsonResponse({
            mode: 'execute',
            result: { columns: [], rows: [], rowCount: 0, affectedRows: 2, durationMs: 5 },
          }),
        )
      }
      return Promise.resolve(jsonResponse({ connections: [PG] }))
    })
    useDatabaseStore.getState().setSql('conn_pg', 'DELETE FROM users WHERE id = 2')
    const outcome = await useDatabaseStore.getState().runSql('conn_pg')
    expect(outcome).toEqual({ mode: 'execute', needsConfirm: true })
    // 未确认：只发生分类请求，写语句没有下发
    expect(bodies.length).toBe(1)
    expect(useDatabaseStore.getState().queries.conn_pg?.running).toBe(false)

    await useDatabaseStore.getState().runSql('conn_pg', { confirmed: true })
    expect(bodies.length).toBe(2)
    expect(bodies[1]?.dryRun).toBeUndefined()
    expect(useDatabaseStore.getState().queries.conn_pg?.result?.affectedRows).toBe(2)
  })

  it('runSql 空语句与失败：错误就地反馈且不产生请求', async () => {
    fetchMock.mockImplementation((url: string, _init?: RequestInit) => {
      if (url === '/api/connections/conn_pg/sql') return Promise.resolve(jsonResponse({ error: '连接未开启允许写入' }, 403))
      return Promise.resolve(jsonResponse({ connections: [PG] }))
    })
    const empty = await useDatabaseStore.getState().runSql('conn_pg')
    expect(empty.needsConfirm).toBe(false)
    expect(useDatabaseStore.getState().queries.conn_pg?.error).toBe('请输入 SQL 语句')

    useDatabaseStore.getState().setSql('conn_pg', 'INSERT INTO users VALUES (1)')
    await useDatabaseStore.getState().runSql('conn_pg', { confirmed: true })
    expect(useDatabaseStore.getState().queries.conn_pg?.error).toBe('连接未开启允许写入')
  })

  it('对象树纯函数：过滤（表名 / 模式名）与模式分组', () => {
    const tables = [
      { schema: 'public', name: 'users', columns: [] },
      { schema: 'public', name: 'orders', columns: [] },
      { schema: 'audit', name: 'events', columns: [] },
      { name: 'local', columns: [] },
    ]
    expect(filterTables(tables, 'user').map((t) => t.name)).toEqual(['users'])
    expect(filterTables(tables, 'audit').map((t) => t.name)).toEqual(['events'])
    expect(filterTables(tables, '').length).toBe(4)
    const groups = groupBySchema(tables)
    expect(groups.map((g) => [g.schema, g.tables.length])).toEqual([
      ['public', 2],
      ['audit', 1],
      ['', 1],
    ])
  })
})

describe('M23：SSH 终端 store（/ws/ssh 协议）', () => {
  const tokenResponse = { token: 'tk-1', topic: 'ssh:conn_ssh', mode: 'terminal', expiresIn: 300 }

  function mockApi(): void {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/ssh/terminal-token')) return Promise.resolve(jsonResponse(tokenResponse))
      return Promise.resolve(jsonResponse({ connections: [SSH] }))
    })
  }

  it('open 全链路：token → WS（ready 置 open）→ 输入二进制帧 / resize JSON 帧 / 输出回写', async () => {
    mockApi()
    const id = await useTerminalStore.getState().open({ id: 'conn_ssh', name: '远端主机' })
    expect(id).toBeTruthy()
    const runtime = createdRuntimes[0]
    expect(runtime).toBeTruthy()

    const ws = FakeWebSocket.instances[0]
    expect(ws.url).toContain('/ws/ssh?connectionId=conn_ssh&token=tk-1')
    expect(ws.binaryType).toBe('arraybuffer')

    // 打开即上报真实尺寸（替身固定 100x30）
    ws.open()
    expect(ws.lastJson()).toEqual({ type: 'resize', cols: 100, rows: 30 })

    ws.emitText({ type: 'ready', cols: 100, rows: 30 })
    let session = useTerminalStore.getState().sessions[0]
    expect(session?.status).toBe('open')
    expect(runtime.fitted).toBeGreaterThan(0)
    expect(runtime.focused).toBeGreaterThan(0)

    // 键盘输入 → 二进制帧（注意：TextEncoder 输出与测试全局可能不同 realm，用 toStringTag 判定）
    runtime.emitData('ls -la\r')
    const encoded = ws.sent.find((x) => Object.prototype.toString.call(x) === '[object Uint8Array]') as
      | Uint8Array
      | undefined
    expect(encoded).toBeTruthy()
    expect(new TextDecoder().decode(encoded)).toBe('ls -la\r')

    // 手动 resize → JSON 帧 + 会话尺寸同步
    runtime.emitResize(90, 25)
    expect(ws.lastJson()).toEqual({ type: 'resize', cols: 90, rows: 25 })
    session = useTerminalStore.getState().sessions[0]
    expect(session?.size).toEqual({ cols: 90, rows: 25 })

    // 服务端二进制帧 → 终端写出
    ws.emitBinary(new TextEncoder().encode('hi'))
    expect(new TextDecoder().decode(runtime.bytes[0])).toBe('hi')

    // exit 帧 → 提示 + closed
    ws.emitText({ type: 'exit', code: 0 })
    session = useTerminalStore.getState().sessions[0]
    expect(session?.status).toBe('closed')
    expect(runtime.notices.some((n) => n.includes('exit'))).toBe(true)
  })

  it('同连接重复 open 聚焦既有会话；断线 onclose 置 closed；reconnect 复用运行时重连', async () => {
    mockApi()
    const first = await useTerminalStore.getState().open({ id: 'conn_ssh', name: '远端主机' })
    const ws1 = FakeWebSocket.instances[0]
    ws1.open()
    ws1.emitText({ type: 'ready', cols: 100, rows: 30 })

    const second = await useTerminalStore.getState().open({ id: 'conn_ssh', name: '远端主机' })
    expect(second).toBe(first)
    expect(FakeWebSocket.instances.length).toBe(1)
    expect(createdRuntimes.length).toBe(1)

    // 服务端断开（非用户关闭）→ closed + 提示，不自动重连
    ws1.readyState = 3
    ws1.onclose?.()
    const session = useTerminalStore.getState().sessions[0]
    expect(session?.status).toBe('closed')
    expect(createdRuntimes[0]?.notices.some((n) => n.includes('重连'))).toBe(true)
    expect(FakeWebSocket.instances.length).toBe(1)

    // 手动重连：新 WS、复用运行时（画面保留）、再次 ready 后恢复 open
    await useTerminalStore.getState().reconnect(first!)
    expect(FakeWebSocket.instances.length).toBe(2)
    expect(createdRuntimes.length).toBe(1)
    const ws2 = FakeWebSocket.instances[1]
    ws2.open()
    ws2.emitText({ type: 'ready', cols: 100, rows: 30 })
    expect(useTerminalStore.getState().sessions[0]?.status).toBe('open')
  })

  it('close 释放运行时并顺延激活；error 帧置 error 状态', async () => {
    mockApi()
    const id = await useTerminalStore.getState().open({ id: 'conn_ssh', name: '远端主机' })
    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.emitText({ type: 'error', message: '认证失败' })
    expect(useTerminalStore.getState().sessions[0]?.status).toBe('error')
    expect(useTerminalStore.getState().sessions[0]?.message).toBe('认证失败')

    useTerminalStore.getState().close(id!)
    expect(useTerminalStore.getState().sessions).toEqual([])
    expect(useTerminalStore.getState().activeId).toBeUndefined()
    expect(createdRuntimes[0]?.disposed).toBe(1)
  })

  it('token 获取失败：运行时提示并置 error（不建 WS）', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ error: '连接不存在' }, 404)))
    const id = await useTerminalStore.getState().open({ id: 'conn_ssh', name: '远端主机' })
    expect(id).toBeUndefined()
    expect(FakeWebSocket.instances.length).toBe(0)
    const session = useTerminalStore.getState().sessions[0]
    expect(session?.status).toBe('error')
    expect(session?.message).toBe('连接不存在')
    expect(createdRuntimes[0]?.notices.some((n) => n.includes('连接不存在'))).toBe(true)
  })
})

describe('M23：连接管理（SSH 表单与工作台入口）', () => {
  function mockPanel(): void {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/connections' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        return Promise.resolve(
          jsonResponse({
            connection: makeConnection({ id: 'conn_new', name: String(body.name), kind: 'ssh', config: {}, secretSet: true }),
          }),
        )
      }
      if (url.includes('/ssh/terminal-token')) {
        return Promise.resolve(jsonResponse({ token: 'tk-1', topic: 'ssh:conn_ssh', mode: 'terminal', expiresIn: 300 }))
      }
      if (url.includes('/api/audit')) return Promise.resolve(jsonResponse({ entries: [] }))
      // 绑定清单端点必须先于 /api/connections 匹配（两者都包含 '/connections'）
      if (url.includes('/api/sessions/')) return Promise.resolve(jsonResponse({ bindings: [] }))
      if (url.includes('/connections')) return Promise.resolve(jsonResponse({ connections: [SSH] }))
      return Promise.resolve(jsonResponse({}, 404))
    })
  }

  it('SSH 表单：认证方式切换字段（密码 / 私钥 / agent）与「保存并测试」入口', async () => {
    mockPanel()
    render(<ConnectionsConsole />)
    await userEvent.click(screen.getByRole('button', { name: '新建连接' }))
    await userEvent.click(screen.getByRole('button', { name: 'SSH' }))

    expect(screen.getByText('主机')).toBeTruthy()
    expect(screen.getByText('用户名')).toBeTruthy()
    expect(screen.getByText('认证方式')).toBeTruthy()
    expect(screen.getByPlaceholderText('登录密码')).toBeTruthy()
    expect(screen.getByRole('button', { name: /保存并测试/ })).toBeTruthy()
    expect(screen.getByText(/允许 Agent 执行命令/)).toBeTruthy()

    // 私钥模式：路径 + 粘贴 + passphrase
    await userEvent.selectOptions(screen.getByRole('combobox'), 'key')
    expect(screen.getByText('私钥文件路径')).toBeTruthy()
    expect(screen.getByText('私钥内容')).toBeTruthy()
    expect(screen.getByText('密钥口令 Passphrase')).toBeTruthy()

    // agent 模式：可正常切换（字段不变，凭据走本机 ssh-agent）
    await userEvent.selectOptions(screen.getByRole('combobox'), 'agent')
  })

  it('保存 SSH：载荷契约（config/secret 分组，端口缺省 22）', async () => {
    const bodies: Array<Record<string, unknown>> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/connections' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        bodies.push(body)
        return Promise.resolve(
          jsonResponse({
            connection: makeConnection({ id: 'conn_new', name: String(body.name), kind: 'ssh', config: {}, secretSet: true }),
          }),
        )
      }
      if (url.includes('/api/audit')) return Promise.resolve(jsonResponse({ entries: [] }))
      if (url.includes('/api/sessions/')) return Promise.resolve(jsonResponse({ bindings: [] }))
      if (url.includes('/connections')) return Promise.resolve(jsonResponse({ connections: [] }))
      return Promise.resolve(jsonResponse({}, 404))
    })
    render(<ConnectionsConsole />)
    await userEvent.click(screen.getByRole('button', { name: '新建连接' }))
    await userEvent.click(screen.getByRole('button', { name: 'SSH' }))
    await userEvent.type(screen.getByPlaceholderText('如：生产只读库'), '跳板机')
    await userEvent.clear(screen.getByPlaceholderText('10.0.0.8 或 example.com'))
    await userEvent.type(screen.getByPlaceholderText('10.0.0.8 或 example.com'), '10.0.0.8')
    await userEvent.type(screen.getByPlaceholderText('root / deploy'), 'deploy')
    await userEvent.type(screen.getByPlaceholderText('登录密码'), 'p@ss')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(bodies.length).toBe(1))
    expect(bodies[0]).toMatchObject({
      name: '跳板机',
      kind: 'ssh',
      config: { host: '10.0.0.8', port: 22, username: 'deploy', authMethod: 'password', allowExec: false },
      secret: { password: 'p@ss' },
    })
  })

  it('SSH 新建：「本地（本机）」一键预置回填（用户名 / 认证 / 私钥路径）与探测提示；保存载荷契约', async () => {
    const bodies: Array<Record<string, unknown>> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      // /connections/ssh-preset 与 /connections 同前缀：必须先于通配匹配
      if (url === '/api/connections/ssh-preset') {
        return Promise.resolve(
          jsonResponse({
            preset: {
              name: '本地',
              host: '127.0.0.1',
              port: 22,
              username: 'democh',
              authMethod: 'key',
              privateKeyPath: '~/.ssh/id_ed25519',
              agentAvailable: false,
              sshdReachable: false,
            },
          }),
        )
      }
      if (url === '/api/connections' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        bodies.push(body)
        return Promise.resolve(
          jsonResponse({ connection: makeConnection({ id: 'conn_local', name: '本地', kind: 'ssh', config: {}, secretSet: false }) }),
        )
      }
      if (url.includes('/api/audit')) return Promise.resolve(jsonResponse({ entries: [] }))
      // 绑定清单端点必须先于 /api/connections 匹配（两者都包含 '/connections'）
      if (url.includes('/api/sessions/')) return Promise.resolve(jsonResponse({ bindings: [] }))
      if (url.includes('/connections')) return Promise.resolve(jsonResponse({ connections: [] }))
      return Promise.resolve(jsonResponse({}, 404))
    })
    render(<ConnectionsConsole />)
    await userEvent.click(screen.getByRole('button', { name: '新建连接' }))
    await userEvent.click(screen.getByRole('button', { name: 'SSH' }))
    await userEvent.click(screen.getByRole('button', { name: '本地（本机）' }))

    // 回填：名称 / 主机 / 端口 / 用户名 / 认证方式 key + 默认私钥路径
    await waitFor(() =>
      expect((screen.getByPlaceholderText('10.0.0.8 或 example.com') as HTMLInputElement).value).toBe('127.0.0.1'),
    )
    expect((screen.getByPlaceholderText('如：生产只读库') as HTMLInputElement).value).toBe('本地')
    expect((screen.getByPlaceholderText('22') as HTMLInputElement).value).toBe('22')
    expect((screen.getByPlaceholderText('root / deploy') as HTMLInputElement).value).toBe('democh')
    expect((screen.getByPlaceholderText('~/.ssh/id_ed25519') as HTMLInputElement).value).toBe('~/.ssh/id_ed25519')
    // 探测结论提示：22 端口未监听 → 开启系统「远程登录」指引
    expect(screen.getByText(/已填入本机配置：democh@127\.0\.0\.1/)).toBeTruthy()
    expect(screen.getByText(/本机 22 端口未监听/)).toBeTruthy()

    // 保存：config 契约（默认私钥路径随行；allowExec 保持默认关；无凭据不携带 secret）
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(bodies.length).toBe(1))
    expect(bodies[0]).toMatchObject({
      name: '本地',
      kind: 'ssh',
      config: {
        host: '127.0.0.1',
        port: 22,
        username: 'democh',
        authMethod: 'key',
        allowExec: false,
        privateKeyPath: '~/.ssh/id_ed25519',
      },
    })
    expect(bodies[0]?.secret).toBeUndefined()
  })

  it('连接卡片：「打开」展开数据库工作台；「终端」建会话并展开终端（M49 深度工作台）', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/ssh/terminal-token')) {
        return Promise.resolve(jsonResponse({ token: 'tk-1', topic: 'ssh:conn_ssh', mode: 'terminal', expiresIn: 300 }))
      }
      if (url.includes('/api/audit')) return Promise.resolve(jsonResponse({ entries: [] }))
      // 绑定清单端点必须先于 /api/connections 匹配（两者都包含 '/connections'）
      if (url.includes('/api/sessions/')) return Promise.resolve(jsonResponse({ bindings: [] }))
      if (url.includes('/schema')) return Promise.resolve(jsonResponse({ tables: [], truncated: false }))
      if (url.includes('/connections')) return Promise.resolve(jsonResponse({ connections: [PG, SSH] }))
      return Promise.resolve(jsonResponse({}, 404))
    })
    useSessionStore.setState({ currentId: 's1' })
    render(<ConnectionsConsole />)
    await screen.findByText('订单库')

    await userEvent.click(screen.getAllByRole('button', { name: '打开' })[0]!)
    // M49（ADR 0100）：展开为深度工作台（deepFrom 记录返回目标 = 对话）
    expect(useUiStore.getState().mainTab).toBe('database')
    expect(useUiStore.getState().deepFrom).toBe('chat')
    expect(useDatabaseStore.getState().selectedId).toBe('conn_pg')

    await userEvent.click(screen.getByRole('button', { name: '终端' }))
    expect(useUiStore.getState().mainTab).toBe('terminal')
    // 深度工作台间再展开：返回目标保留最初来源
    expect(useUiStore.getState().deepFrom).toBe('chat')
    await waitFor(() => expect(useTerminalStore.getState().sessions.length).toBe(1))
    // SSH 可绑定（ssh_exec 需要会话绑定），不再被 kind 拦截
    expect(screen.getAllByRole('button', { name: /绑定/ }).length).toBeGreaterThan(0)
  })
})
