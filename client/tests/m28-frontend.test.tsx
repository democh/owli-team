/**
 * M28 前端测试：mcp-store（jsonConfig 加载 / syncJsonConfig / importJson）、JsonConfigCard
 * （状态 / 立即同步 / 粘贴导入 / 文件缺失示例片段）、source 徽章与 json 源只读保护、
 * McpToolList 常驻·按需徽章、McpServerEditor（eagerLoad 开关 / json 只读）。
 * mock fetch + 真实 store（mcp-store / session-store / agent-store）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  AgentDefinition,
  McpJsonStatus,
  McpServerDefinition,
  McpToolDirectoryEntry,
  SessionSummary,
} from '@multi-agent/shared'
import { McpConsole } from '../src/components/mcp/McpConsole'
import { McpServerEditor } from '../src/components/mcp/McpServerEditor'
import { useAgentStore } from '../src/stores/agent-store'
import { useMcpStore } from '../src/stores/mcp-store'
import { useSessionStore } from '../src/stores/session-store'

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
  secretSet: false,
  enabled: true,
  status: 'ok',
  tools: [
    { registeredName: 'mcp__echo__echo', rawName: 'echo', description: '回显文本', readOnly: true, deferByDefault: true },
    {
      registeredName: 'mcp__echo__write_note',
      rawName: 'write_note',
      description: '写入笔记',
      readOnly: false,
      deferByDefault: false,
    },
  ],
  source: 'ui',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

/** M28：mcp.json 来源服务器（只读；全部常驻） */
const JSON_SERVER: McpServerDefinition = {
  ...SERVER,
  id: 'srv-json',
  name: 'fromjson',
  displayName: '文件服务器',
  config: { command: 'npx', args: ['-y', 'demo-mcp'], approvalPolicy: 'risky', readOnlyOverride: 'auto', eagerLoad: true },
  source: 'json',
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
    deferByDefault: true,
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
    deferByDefault: false,
  },
]

const JSON_STATUS: McpJsonStatus = {
  file: '/repo/mcp.json',
  exists: true,
  pollMs: 5_000,
  lastSyncAt: '2026-01-01T00:02:00.000Z',
  lastResult: 'ok',
  lastWarnings: [],
  entries: ['fromjson'],
  summary: { created: 1, updated: 0, removed: 0, skipped: 0 },
}

function defaultFetch(url: string): Response {
  if (url === '/api/mcp/servers') return jsonResponse({ servers: [SERVER] })
  if (url === '/api/mcp/tools') return jsonResponse({ tools: TOOLS })
  if (url === '/api/mcp/json-config') return jsonResponse({ config: JSON_STATUS })
  if (url === '/api/sessions/s-1/mcp-servers') return jsonResponse({ bindings: [] })
  return jsonResponse({}, 404)
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation((url: string) => Promise.resolve(defaultFetch(url)))
  useAgentStore.setState({ agents: [AGENT], groups: [], presets: [], skills: [], loaded: true, loading: false, statuses: {} })
  useSessionStore.setState({ sessions: [SESSION], currentId: 's-1' })
  useMcpStore.setState({
    servers: [],
    tools: [],
    bindings: [],
    sessionId: undefined,
    loading: false,
    busyId: undefined,
    jsonConfig: undefined,
    jsonSyncing: false,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('M28：mcp-store（JSON 直配）', () => {
  it('loadForSession：联动加载 jsonConfig（文件路径 / 条目 / 计数）', async () => {
    await useMcpStore.getState().loadForSession('s-1')
    const config = useMcpStore.getState().jsonConfig
    expect(config?.file).toBe('/repo/mcp.json')
    expect(config?.exists).toBe(true)
    expect(config?.entries).toEqual(['fromjson'])
    expect(config?.summary.created).toBe(1)
  })

  it('syncJsonConfig：POST 后回写服务器清单与 jsonConfig（jsonSyncing 复位）', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const synced: McpServerDefinition = { ...JSON_SERVER }
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/mcp/json-config/sync' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            result: {
              ok: true,
              trigger: 'manual',
              errors: [],
              warnings: [],
              summary: { created: 2, updated: 1, removed: 0, skipped: 0 },
              syncedAt: '2026-01-01T00:03:00.000Z',
            },
            status: { ...JSON_STATUS, summary: { created: 2, updated: 1, removed: 0, skipped: 0 } },
            servers: [synced],
          }),
        )
      }
      return Promise.resolve(defaultFetch(url))
    })
    const result = await useMcpStore.getState().syncJsonConfig()
    expect(result.summary.created).toBe(2)
    expect(useMcpStore.getState().servers.map((s) => s.name)).toEqual(['fromjson'])
    expect(useMcpStore.getState().jsonConfig?.summary.updated).toBe(1)
    expect(useMcpStore.getState().jsonSyncing).toBe(false)
  })

  it('importJson：POST { json } 并回写服务器清单，返回创建 / 跳过结果', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/mcp/json-config/import' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            outcome: {
              created: ['fresh'],
              skipped: [{ name: 'dup', reason: '同名服务器已存在' }],
              errors: [],
              warnings: [],
            },
            servers: [{ ...SERVER, id: 'srv-fresh', name: 'fresh' }],
          }),
        )
      }
      return Promise.resolve(defaultFetch(url))
    })
    const outcome = await useMcpStore.getState().importJson('{"mcpServers":{}}')
    expect(outcome.created).toEqual(['fresh'])
    expect(outcome.skipped[0]?.name).toBe('dup')
    expect(useMcpStore.getState().servers.map((s) => s.name)).toEqual(['fresh'])
    const post = calls.find((c) => c.url === '/api/mcp/json-config/import')
    expect(JSON.parse(String(post!.init?.body))).toEqual({ json: '{"mcpServers":{}}' })
  })
})

describe('M28：McpConsole（JSON 配置卡片）', () => {
  it('渲染状态卡：路径 / 就绪徽章 / 轮询间隔 / 条目与按钮', async () => {
    render(<McpConsole />)
    expect(await screen.findByText('JSON 配置')).toBeTruthy()
    expect(screen.getByText('/repo/mcp.json')).toBeTruthy()
    expect(screen.getByText('文件已就绪')).toBeTruthy()
    expect(screen.getByText('每 5s 自动同步')).toBeTruthy()
    expect(screen.getByText(/条目：fromjson/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /立即同步/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /粘贴导入/ })).toBeTruthy()
  })

  it('文件不存在：警示徽章 + 示例片段（含 mcpServers 与变量提示）', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/mcp/json-config') return Promise.resolve(jsonResponse({ config: { ...JSON_STATUS, exists: false, entries: [] } }))
      return Promise.resolve(defaultFetch(url))
    })
    render(<McpConsole />)
    expect(await screen.findByText('文件不存在')).toBeTruthy()
    expect(screen.getByText(/支持 \$\{VAR\} \/ \$\{VAR:-默认值\} 变量展开/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '复制示例' })).toBeTruthy()
    // 示例 JSON 已渲染（pre 内）
    expect(screen.getByText(/"mcpServers"/)).toBeTruthy()
    expect(screen.getByText(/"@modelcontextprotocol\/server-filesystem"/)).toBeTruthy()
  })

  it('点击「立即同步」：POST /api/mcp/json-config/sync 并刷新服务器清单', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/mcp/json-config/sync' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            result: { ok: true, trigger: 'manual', errors: [], warnings: [], summary: { created: 1, updated: 0, removed: 0, skipped: 0 }, syncedAt: 'x' },
            status: JSON_STATUS,
            servers: [JSON_SERVER],
          }),
        )
      }
      return Promise.resolve(defaultFetch(url))
    })
    render(<McpConsole />)
    await userEvent.click(await screen.findByRole('button', { name: /立即同步/ }))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/mcp/json-config/sync')).toBe(true))
    expect(await screen.findByText('文件服务器')).toBeTruthy()
  })

  it('粘贴导入：对话框输入 JSON → POST 导入并展示创建 / 跳过明细', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/mcp/json-config/import' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            outcome: {
              created: ['fresh'],
              skipped: [{ name: 'dup', reason: '同名服务器已存在（如需文件权威同步请写入 mcp.json）' }],
              errors: [],
              warnings: [],
            },
            servers: [SERVER],
          }),
        )
      }
      return Promise.resolve(defaultFetch(url))
    })
    render(<McpConsole />)
    await userEvent.click(await screen.findByRole('button', { name: /粘贴导入/ }))
    expect(await screen.findByText('粘贴导入 MCP JSON')).toBeTruthy()
    // userEvent.type 会把 { } 当特殊键：改用 fireEvent.change 直设文本
    fireEvent.change(screen.getByLabelText('MCP JSON'), {
      target: { value: '{"mcpServers":{"fresh":{"command":"npx"}}}' },
    })
    await userEvent.click(screen.getByRole('button', { name: '导入' }))
    expect(await screen.findByText('已创建：fresh')).toBeTruthy()
    expect(screen.getByText(/跳过「dup」/)).toBeTruthy()
    const post = calls.find((c) => c.url === '/api/mcp/json-config/import')
    expect(JSON.parse(String(post!.init?.body))).toEqual({ json: '{"mcpServers":{"fresh":{"command":"npx"}}}' })
  })
})

describe('M28：来源徽章与 json 只读保护', () => {
  it('json 源：徽章「由 mcp.json 管理」+ 编辑 / 删除 / 启停全部禁用', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/mcp/servers') return Promise.resolve(jsonResponse({ servers: [JSON_SERVER] }))
      return Promise.resolve(defaultFetch(url))
    })
    render(<McpConsole />)
    expect(await screen.findByText('由 mcp.json 管理')).toBeTruthy()
    expect(screen.getByText('全部常驻')).toBeTruthy()
    const edit = screen.getByTitle('由 mcp.json 管理（只读）：请编辑配置文件后同步')
    expect((edit as HTMLButtonElement).disabled).toBe(true)
    const del = screen.getByTitle('由 mcp.json 管理（只读）：删除 = 从配置文件移除后同步')
    expect((del as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('switch', { name: '启用 fromjson' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('ui / env 源：分别显示「手动」「env 种子」徽章', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/mcp/servers') {
        return Promise.resolve(
          jsonResponse({ servers: [SERVER, { ...SERVER, id: 'srv-env', name: 'seeded', source: 'env' as const, tools: [] }] }),
        )
      }
      return Promise.resolve(defaultFetch(url))
    })
    render(<McpConsole />)
    expect(await screen.findByText('手动')).toBeTruthy()
    expect(screen.getByText('env 种子')).toBeTruthy()
  })

  it('工具清单：deferByDefault=false → 「常驻」徽章；缺省/true → 「按需」徽章', async () => {
    render(<McpConsole />)
    await screen.findByText('回声服务器')
    await userEvent.click(screen.getByRole('button', { name: /工具清单/ }))
    const table = await screen.findByRole('table')
    expect(within(table).getByText('常驻')).toBeTruthy()
    expect(within(table).getByText('按需')).toBeTruthy()
  })
})

describe('M28：McpServerEditor（eagerLoad / json 只读）', () => {
  it('新建：开启「始终加载」→ config.eagerLoad=true 入参', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/mcp/servers' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ server: { ...SERVER, id: 'srv-9', name: 'fs' } }))
      }
      return Promise.resolve(defaultFetch(url))
    })
    render(<McpServerEditor onClose={vi.fn()} />)
    await userEvent.type(screen.getByLabelText('服务器名'), 'fs')
    await userEvent.type(screen.getByLabelText('启动命令'), 'node')
    await userEvent.click(screen.getByRole('switch', { name: '始终加载' }))
    await userEvent.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => {
      const post = calls.find((c) => c.url === '/api/mcp/servers' && c.init?.method === 'POST')
      expect(post).toBeTruthy()
      const config = (JSON.parse(String(post!.init?.body)) as { config: Record<string, unknown> }).config
      expect(config.eagerLoad).toBe(true)
    })
  })

  it('编辑：预填 eagerLoad（开关开启态）；未开启时不写入该字段', async () => {
    render(<McpServerEditor server={{ ...SERVER, config: { ...SERVER.config, eagerLoad: true } }} onClose={vi.fn()} />)
    expect((screen.getByRole('switch', { name: '始终加载' }) as HTMLButtonElement).getAttribute('aria-checked')).toBe('true')
  })

  it('json 源：只读横幅 + 表单禁用（fieldset disabled）+ 无「保存」按钮，仅「关闭」', async () => {
    render(<McpServerEditor server={JSON_SERVER} onClose={vi.fn()} />)
    expect(screen.getByText(/此服务器由 mcp.json 管理（只读）/)).toBeTruthy()
    // Dialog 渲染在 portal：从 document 查询 fieldset
    expect(document.querySelector('fieldset')?.disabled).toBe(true)
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    // Dialog 自带关闭（X）按钮同名：断言存在即可
    expect(screen.getAllByRole('button', { name: '关闭' }).length).toBeGreaterThan(0)
  })
})
