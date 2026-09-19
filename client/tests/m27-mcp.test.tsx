/**
 * M27 前端测试：mcp-store（三路加载 / 无会话绑定守卫 / CRUD 回写）、McpConsole（服务器卡 /
 * 零可达警示 / 新建入口 / 工具清单授权矩阵 / 会话绑定）、McpServerEditor（校验与入参 / 清除凭据）、
 * ActivityRail 新增「MCP 管理」导航。mock fetch + 真实 store（mcp-store / session-store / agent-store）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  AgentDefinition,
  McpServerDefinition,
  McpToolDirectoryEntry,
  SessionMcpBinding,
  SessionSummary,
} from '@multi-agent/shared'
import { ActivityRail } from '../src/components/console/ActivityRail'
import { McpConsole } from '../src/components/mcp/McpConsole'
import { McpServerEditor } from '../src/components/mcp/McpServerEditor'
import { TooltipProvider } from '../src/components/ui/tooltip'
import { useAgentStore } from '../src/stores/agent-store'
import { useAuthStore } from '../src/stores/auth-store'
import { useMcpStore } from '../src/stores/mcp-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

const SESSION: SessionSummary = {
  id: 's-1',
  title: '测试会话',
  participantIds: ['pm'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  messageCount: 0,
}

const AGENT: AgentDefinition = {
  id: 'pm',
  name: '产品经理',
  role: '产品经理',
  title: '需求负责人',
  description: '负责需求',
  capabilities: ['需求拆解'],
  avatar: { icon: 'clipboard-list', gradient: ['#6366f1', '#818cf8'] },
  group: 'development',
  handoff: [],
}

const SERVER: McpServerDefinition = {
  id: 'srv-1',
  name: 'echo',
  displayName: '回声服务器',
  transport: 'stdio',
  config: { command: 'node', args: ['echo-mcp.mjs'], approvalPolicy: 'risky', readOnlyOverride: 'auto' },
  secretSet: true,
  enabled: true,
  status: 'ok',
  lastCheckedAt: '2026-01-01T00:00:00.000Z',
  tools: [
    { registeredName: 'mcp__echo__echo', rawName: 'echo', description: '回显文本', readOnly: true },
    { registeredName: 'mcp__echo__write_note', rawName: 'write_note', description: '写入笔记', readOnly: false },
  ],
  source: 'ui',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const TOOLS: McpToolDirectoryEntry[] = [
  {
    registeredName: 'mcp__echo__echo',
    rawName: 'echo',
    server: 'echo',
    serverId: 'srv-1',
    description: '回显文本',
    readOnly: true,
    usedByAgents: ['pm'],
    reachable: true,
  },
  {
    registeredName: 'mcp__echo__write_note',
    rawName: 'write_note',
    server: 'echo',
    serverId: 'srv-1',
    description: '写入笔记',
    readOnly: false,
    usedByAgents: [],
    reachable: false,
  },
]

const BINDING: SessionMcpBinding = { server: SERVER, grantedAt: '2026-01-01T00:01:00.000Z' }

/** 默认 mock：一台已连接服务器 + 工具目录（write_note 零可达）+ 空绑定 */
function defaultFetch(url: string): Response {
  if (url === '/api/mcp/servers') return jsonResponse({ servers: [SERVER] })
  if (url === '/api/mcp/tools') return jsonResponse({ tools: TOOLS })
  if (url === '/api/sessions/s-1/mcp-servers') return jsonResponse({ bindings: [] })
  return jsonResponse({}, 404)
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation((url: string) => Promise.resolve(defaultFetch(url)))
  localStorage.removeItem('ma:appView')
  useUiStore.setState({ appView: 'workspace' })
  useAgentStore.setState({
    agents: [AGENT],
    groups: [],
    presets: [],
    skills: [],
    loaded: true,
    loading: false,
    statuses: {},
  })
  useSessionStore.setState({ sessions: [SESSION], currentId: 's-1' })
  useMcpStore.setState({ servers: [], tools: [], bindings: [], sessionId: undefined, loading: false, busyId: undefined })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('M27：mcp-store', () => {
  it('loadForSession：三路并发加载（服务器 / 工具目录 / 绑定）', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/sessions/s-1/mcp-servers') return Promise.resolve(jsonResponse({ bindings: [BINDING] }))
      return Promise.resolve(defaultFetch(url))
    })
    await useMcpStore.getState().loadForSession('s-1')
    const state = useMcpStore.getState()
    expect(state.sessionId).toBe('s-1')
    expect(state.servers.map((s) => s.name)).toEqual(['echo'])
    expect(state.tools.length).toBe(2)
    expect(state.tools.filter((t) => !t.reachable).map((t) => t.rawName)).toEqual(['write_note'])
    expect(state.bindings.length).toBe(1)
    expect(state.bindings[0]?.server.id).toBe('srv-1')
    expect(state.loading).toBe(false)
  })

  it('bind：无当前会话直接抛错（不发请求）', async () => {
    useMcpStore.setState({ sessionId: undefined })
    await expect(useMcpStore.getState().bind('srv-1')).rejects.toThrow('请先选择会话')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('create：POST 后按 name 排序并入清单', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const created: McpServerDefinition = { ...SERVER, id: 'srv-0', name: 'alpha', displayName: undefined }
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/mcp/servers' && init?.method === 'POST') return Promise.resolve(jsonResponse({ server: created }))
      return Promise.resolve(defaultFetch(url))
    })
    useMcpStore.setState({ servers: [SERVER] })
    const out = await useMcpStore.getState().create({ name: 'alpha', transport: 'stdio', config: { command: 'node' } })
    expect(out.id).toBe('srv-0')
    expect(useMcpStore.getState().servers.map((s) => s.name)).toEqual(['alpha', 'echo'])
  })

  it('test：调用测试接口并回写服务器快照（busyId 复位）', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/mcp/servers/srv-1/test' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            result: { ok: true, latencyMs: 5, toolCount: 2, detail: 'echo-mcp 1.0.0（2 个工具）' },
            server: SERVER,
          }),
        )
      }
      return Promise.resolve(defaultFetch(url))
    })
    useMcpStore.setState({ servers: [{ ...SERVER, status: 'error', lastError: '旧错误' }] })
    const result = await useMcpStore.getState().test('srv-1')
    expect(result.ok).toBe(true)
    expect(result.toolCount).toBe(2)
    const after = useMcpStore.getState()
    expect(after.servers[0]?.status).toBe('ok')
    expect(after.servers[0]?.lastError).toBeUndefined()
    expect(after.busyId).toBeUndefined()
  })

  it('remove：DELETE 后同时清理服务器与相关绑定', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/mcp/servers/srv-1' && init?.method === 'DELETE') return Promise.resolve(jsonResponse({ ok: true }))
      return Promise.resolve(defaultFetch(url))
    })
    useMcpStore.setState({ servers: [SERVER], bindings: [BINDING] })
    await useMcpStore.getState().remove('srv-1')
    expect(useMcpStore.getState().servers).toEqual([])
    expect(useMcpStore.getState().bindings).toEqual([])
  })
})

describe('M27：McpConsole', () => {
  it('渲染服务器卡：状态摘要 / 工具数徽章 / 零可达警示 / 绑定按钮', async () => {
    render(<McpConsole />)
    expect(await screen.findByText('回声服务器')).toBeTruthy()
    expect(screen.getByText('MCP 管理')).toBeTruthy()
    expect(screen.getByText('node echo-mcp.mjs')).toBeTruthy()
    expect(screen.getByText(/工具\s*·\s*2/)).toBeTruthy()
    expect(screen.getByText(/1\s*个工具零可达/)).toBeTruthy()
    // 有当前会话 → 绑定按钮可用
    expect(screen.getByRole('button', { name: '绑定' })).toBeTruthy()
  })

  it('「新建服务器」打开编辑器（标题为新建态）', async () => {
    render(<McpConsole />)
    await userEvent.click(await screen.findByRole('button', { name: /新建服务器/ }))
    expect(await screen.findByText('新建 MCP 服务器')).toBeTruthy()
    expect(screen.getByLabelText('服务器名')).toBeTruthy()
  })

  it('展开工具清单：注册名 / 原始名 / 角色可达性矩阵', async () => {
    render(<McpConsole />)
    await screen.findByText('回声服务器')
    await userEvent.click(screen.getByRole('button', { name: /工具清单/ }))
    expect(await screen.findByText('mcp__echo__echo')).toBeTruthy()
    expect(screen.getByText('mcp__echo__write_note')).toBeTruthy()
    // 原始名在表格内校验（服务器卡同名 'echo' 不干扰）
    const table = screen.getByRole('table')
    expect(within(table).getByText('echo')).toBeTruthy()
    expect(within(table).getByText('write_note')).toBeTruthy()
    // 授权矩阵：echo 命中 pm（显示角色名）；write_note 零角色可达
    expect(screen.getByText('产品经理')).toBeTruthy()
    expect(screen.getByText('零角色可达')).toBeTruthy()
  })

  it('绑定：POST 当前会话绑定接口并回写 bindings', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/sessions/s-1/mcp-servers' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ bindings: [BINDING] }))
      }
      return Promise.resolve(defaultFetch(url))
    })
    render(<McpConsole />)
    await screen.findByText('回声服务器')
    await userEvent.click(screen.getByRole('button', { name: '绑定' }))
    await waitFor(() => {
      const post = calls.find((c) => c.url === '/api/sessions/s-1/mcp-servers' && c.init?.method === 'POST')
      expect(post).toBeTruthy()
      expect(JSON.parse(String(post!.init?.body))).toEqual({ serverId: 'srv-1' })
    })
    await waitFor(() => expect(useMcpStore.getState().bindings.length).toBe(1))
  })
})

describe('M27：McpServerEditor', () => {
  it('非法 slug 内联报错，不发创建请求', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return Promise.resolve(defaultFetch(url))
    })
    render(<McpServerEditor onClose={vi.fn()} />)
    await userEvent.type(screen.getByLabelText('服务器名'), 'Bad Name')
    await userEvent.click(screen.getByRole('button', { name: '创建' }))
    expect(await screen.findByText(/服务器名需为小写 slug/)).toBeTruthy()
    expect(calls.some((c) => c.url === '/api/mcp/servers' && c.init?.method === 'POST')).toBe(false)
  })

  it('stdio 缺 command / 超时越界分别内联报错', async () => {
    render(<McpServerEditor onClose={vi.fn()} />)
    await userEvent.type(screen.getByLabelText('服务器名'), 'fs')
    await userEvent.click(screen.getByRole('button', { name: '创建' }))
    expect(await screen.findByText('stdio 服务器需填写启动命令（command）')).toBeTruthy()

    await userEvent.type(screen.getByLabelText('启动命令'), 'node')
    await userEvent.type(screen.getByLabelText('调用超时'), '500')
    await userEvent.click(screen.getByRole('button', { name: '创建' }))
    expect(await screen.findByText('超时需为 1000–600000 毫秒（1s–600s）')).toBeTruthy()
  })

  it('http 传输缺 url 内联报错', async () => {
    render(<McpServerEditor onClose={vi.fn()} />)
    await userEvent.type(screen.getByLabelText('服务器名'), 'remote')
    await userEvent.click(screen.getByRole('button', { name: 'Streamable HTTP（远程端点）' }))
    await userEvent.click(screen.getByRole('button', { name: '创建' }))
    expect(await screen.findByText(/需填写以 http:\/\/ 或 https:\/\/ 开头的端点/)).toBeTruthy()
  })

  it('stdio 创建：POST body 含 args 数组与 env 凭据（# 注释忽略），onClose 被调用', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const created: McpServerDefinition = { ...SERVER, id: 'srv-9', name: 'fs', displayName: '文件系统' }
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/mcp/servers' && init?.method === 'POST') return Promise.resolve(jsonResponse({ server: created }))
      return Promise.resolve(defaultFetch(url))
    })
    const onClose = vi.fn()
    render(<McpServerEditor onClose={onClose} />)
    await userEvent.type(screen.getByLabelText('服务器名'), 'fs')
    await userEvent.type(screen.getByLabelText('展示名'), '文件系统')
    await userEvent.type(screen.getByLabelText('启动命令'), 'node')
    await userEvent.type(screen.getByLabelText('命令参数'), '-y{enter}/opt/fs.mjs')
    await userEvent.type(screen.getByLabelText('环境变量'), 'API_KEY=abc{enter}# comment')
    await userEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => {
      const post = calls.find((c) => c.url === '/api/mcp/servers' && c.init?.method === 'POST')
      expect(post).toBeTruthy()
      const body = JSON.parse(String(post!.init?.body)) as Record<string, unknown>
      expect(body.name).toBe('fs')
      expect(body.displayName).toBe('文件系统')
      expect(body.transport).toBe('stdio')
      expect(body.enabled).toBe(true)
      expect(body.secret).toEqual({ env: { API_KEY: 'abc' } })
      const config = body.config as Record<string, unknown>
      expect(config.command).toBe('node')
      expect(config.args).toEqual(['-y', '/opt/fs.mjs'])
      expect(config.approvalPolicy).toBe('risky')
      expect(config.readOnlyOverride).toBe('auto')
    })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('编辑模式：预填配置，选「清除凭据」后保存 PUT secret:null', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/mcp/servers/srv-1' && init?.method === 'PUT') {
        return Promise.resolve(jsonResponse({ server: { ...SERVER, secretSet: false } }))
      }
      return Promise.resolve(defaultFetch(url))
    })
    const onClose = vi.fn()
    render(<McpServerEditor server={SERVER} onClose={onClose} />)
    expect(screen.getByText('编辑 MCP 服务器「echo」')).toBeTruthy()
    expect((screen.getByLabelText('服务器名') as HTMLInputElement).value).toBe('echo')
    expect((screen.getByLabelText('启动命令') as HTMLInputElement).value).toBe('node')

    await userEvent.click(screen.getByRole('button', { name: '清除凭据' }))
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      const put = calls.find((c) => c.url === '/api/mcp/servers/srv-1' && c.init?.method === 'PUT')
      expect(put).toBeTruthy()
      const body = JSON.parse(String(put!.init?.body)) as Record<string, unknown>
      expect(body.secret).toBeNull()
      const config = body.config as Record<string, unknown>
      expect(config.command).toBe('node')
      expect(config.args).toEqual(['echo-mcp.mjs'])
    })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})

describe('M27：ActivityRail', () => {
  it('「MCP 管理」入口：切换 appView 并持久化 ma:appView', async () => {
    // M57：MCP 入口仅 admin 可见——本用例验证 admin 视角
    useAuthStore.setState({ isAdmin: true })
    render(
      <TooltipProvider>
        <ActivityRail />
      </TooltipProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'MCP 管理' }))
    expect(useUiStore.getState().appView).toBe('mcp')
    expect(localStorage.getItem('ma:appView')).toBe('mcp')
    expect(screen.getByRole('button', { name: 'MCP 管理' }).getAttribute('aria-current')).toBe('page')
  })
})
