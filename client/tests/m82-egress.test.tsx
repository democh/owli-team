/**
 * M82 前端测试：联网出口（IP 代理 / 隧道）。
 * - 设置「联网与出网」区块：字段渲染（出口模式 / 出口连接 / 跟随通道 / 旁路 / 回退 / 探测地址）
 *   + 出口状态与最近探测展示（GET /api/egress/status）；
 * - 保存载荷：egress* 字段随表单提交（PUT /api/settings）；
 * - 测试出口：「测试出口」经所选连接调用 POST /api/connections/:id/test 并刷新状态；
 * - 连接管理：新建「出口代理」形态表单与提交载荷（config mode/host/port + secret 账号口令）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ConnectionDefinition } from '@multi-agent/shared'
import { ConnectionsConsole } from '../src/components/console/ConnectionsConsole'
import { SettingsView } from '../src/components/settings/SettingsView'
import { useAgentStore } from '../src/stores/agent-store'
import { useConnectionsStore } from '../src/stores/connections-store'
import { useMcpStore } from '../src/stores/mcp-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function makeProxyConnection(overrides: Partial<ConnectionDefinition> = {}): ConnectionDefinition {
  return {
    id: 'conn_proxy',
    name: '公司出口',
    kind: 'proxy',
    config: { mode: 'http', scheme: 'http', host: 'proxy.corp.io', port: 3128 },
    status: 'ok',
    enabled: true,
    secretSet: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

/** 服务端设置（仅出口相关字段；SettingsView 会与 FALLBACK 合并） */
const EGRESS_SETTINGS = {
  egressMode: 'proxy',
  egressConnectionId: 'conn_proxy',
  egressChannels: ['search', 'finance', 'browser'],
  egressNoProxy: ['localhost', '127.0.0.1'],
  egressFallback: 'direct',
  egressProbeUrl: 'https://myip.ipip.net',
}

const EGRESS_STATUS = {
  mode: 'proxy',
  state: 'proxied',
  bindingName: '公司出口',
  channels: ['search', 'finance', 'browser'],
  fails: 0,
  lastOkAt: new Date().toISOString(),
  lastProbe: { at: new Date().toISOString(), ok: true, exitIp: '203.0.113.7', latencyMs: 42 },
}

/** 基础路由桩：设置 / 出口状态 / 连接清单（POST 回显创建结果）；其余（agents / skills / mcp / health）返回 404 由调用方静默处理 */
function stubBase(extra: { connections?: ConnectionDefinition[] } = {}): void {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/api/settings' && init?.method === 'PUT') return Promise.resolve(jsonResponse({ settings: EGRESS_SETTINGS, applied: true }))
    if (url === '/api/settings') return Promise.resolve(jsonResponse({ settings: EGRESS_SETTINGS }))
    if (url === '/api/egress/status') return Promise.resolve(jsonResponse({ status: EGRESS_STATUS }))
    // 创建回显（store 会把返回的 connection 并入清单；缺字段会污染列表渲染）
    if (url === '/api/connections' && init?.method === 'POST') return Promise.resolve(jsonResponse({ connection: makeProxyConnection() }))
    if (url === '/api/connections') return Promise.resolve(jsonResponse({ connections: extra.connections ?? [] }))
    return Promise.resolve(jsonResponse({}, 404))
  })
}

/** 取第 n 次匹配调用（[url, init]） */
function callsOf(url: string, method?: string): Array<[string, RequestInit]> {
  return fetchMock.mock.calls.filter(
    ([called, init]) => called === url && (method === undefined || (init as RequestInit | undefined)?.method === method),
  ) as Array<[string, RequestInit]>
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  localStorage.clear()
  useAgentStore.setState({ agents: [], groups: [], presets: [], skills: [], loaded: false, loading: false, statuses: {} })
  useSessionStore.setState({
    sessions: [],
    currentId: undefined,
    byId: new Map(),
    order: [],
    loadingSessions: false,
    loadingMessages: false,
    artifactVersion: 0,
  })
  useConnectionsStore.setState({
    connections: [],
    bindings: [],
    ops: [],
    sessionId: undefined,
    loading: false,
    busyId: undefined,
    pendingEditId: undefined,
  })
  useMcpStore.setState({ servers: [], tools: [], bindings: [], sessionId: undefined, loading: false })
  useUiStore.setState({ appView: 'workspace' })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('M82：设置「联网与出网」区块', () => {
  it('字段渲染：出口模式 / 出口连接 / 跟随通道 / 旁路 / 回退 / 探测地址 + 出口状态与最近探测', async () => {
    stubBase({ connections: [makeProxyConnection()] })
    render(<SettingsView />)

    // 分组导航与区块标题
    expect((await screen.findAllByText('联网与出网')).length).toBeGreaterThan(0)

    // 出口模式（proxy，来自服务端设置）
    expect(((await screen.findByLabelText(/^出口模式/)) as HTMLSelectElement).value).toBe('proxy')
    // 出口连接（可选到 proxy 连接）
    expect((screen.getByLabelText(/^出口连接/) as HTMLSelectElement).value).toBe('conn_proxy')
    expect(screen.getByRole('option', { name: /公司出口/ })).toBeTruthy()
    // 跟随通道默认勾选 search/finance/browser，未勾选 llm
    expect((screen.getByLabelText('搜索抓取') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('金融数据') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('浏览器') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('模型与嵌入') as HTMLInputElement).checked).toBe(false)
    // 旁路（数组 → 逗号文本）
    expect((screen.getByLabelText(/^直连旁路/) as HTMLInputElement).value).toBe('localhost, 127.0.0.1')
    // 回退与探测地址
    expect((screen.getByLabelText(/^失败回退/) as HTMLSelectElement).value).toBe('direct')
    expect((screen.getByLabelText(/^探测地址/) as HTMLInputElement).value).toBe('https://myip.ipip.net')
    // 出口状态（GET /api/egress/status）：已启用 + 最近探测回显出口 IP
    expect(await screen.findByText(/已启用：公司出口/)).toBeTruthy()
    expect(screen.getByText(/出口 IP 203\.0\.113\.7/)).toBeTruthy()
  })

  it('保存：egress* 字段随表单提交（切换回退为严格失败后保存）', async () => {
    const user = userEvent.setup()
    stubBase({ connections: [makeProxyConnection()] })
    render(<SettingsView />)
    await screen.findByLabelText(/^出口模式/)

    await user.selectOptions(screen.getByLabelText(/^失败回退/), 'fail')
    await user.click(screen.getByRole('button', { name: /保存并生效/ }))

    await waitFor(() => expect(callsOf('/api/settings', 'PUT')).toHaveLength(1))
    const body = JSON.parse(callsOf('/api/settings', 'PUT')[0]![1].body as string) as Record<string, unknown>
    expect(body.egressMode).toBe('proxy')
    expect(body.egressConnectionId).toBe('conn_proxy')
    expect(body.egressChannels).toEqual(['search', 'finance', 'browser'])
    expect(body.egressNoProxy).toEqual(['localhost', '127.0.0.1'])
    expect(body.egressFallback).toBe('fail')
    expect(body.egressProbeUrl).toBe('https://myip.ipip.net')
  })

  it('测试出口：经所选连接调用连接测试接口并刷新出口状态', async () => {
    const user = userEvent.setup()
    stubBase({ connections: [makeProxyConnection()] })
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/connections/conn_proxy/test' && init?.method === 'POST')
        return Promise.resolve(jsonResponse({ result: { ok: true, detail: 'HTTP 200 · 42ms · 出口 IP 203.0.113.7' } }))
      if (url === '/api/settings') return Promise.resolve(jsonResponse({ settings: EGRESS_SETTINGS }))
      if (url === '/api/egress/status') return Promise.resolve(jsonResponse({ status: EGRESS_STATUS }))
      if (url === '/api/connections') return Promise.resolve(jsonResponse({ connections: [makeProxyConnection()] }))
      return Promise.resolve(jsonResponse({}, 404))
    })
    render(<SettingsView />)
    await screen.findByLabelText(/^出口模式/)

    await user.click(screen.getByRole('button', { name: /测试出口/ }))
    await waitFor(() => expect(callsOf('/api/connections/conn_proxy/test', 'POST')).toHaveLength(1))
    // 测试后刷新状态（首屏 1 次 + 测试后 1 次）
    await waitFor(() => expect(callsOf('/api/egress/status').length).toBeGreaterThanOrEqual(2))
  })
})

describe('M82：连接管理「出口代理」', () => {
  it('新建出口代理：形态表单渲染并提交 config/secret 载荷', async () => {
    const user = userEvent.setup()
    stubBase()
    render(<ConnectionsConsole />)

    await user.click(await screen.findByRole('button', { name: /新建连接/ }))
    // 类型 chip：出口代理
    await user.click(screen.getByRole('button', { name: /出口代理/ }))
    expect(screen.getByText('新建出口代理连接')).toBeTruthy()

    await user.type(screen.getByLabelText(/^名称/), '公司出口')
    await user.clear(screen.getByLabelText(/^代理地址/))
    await user.type(screen.getByLabelText(/^代理地址/), 'proxy.corp.io')
    await user.type(screen.getByLabelText(/^端口/), '3128')
    await user.type(screen.getByLabelText(/^用户名/), 'user')
    await user.type(screen.getByLabelText(/^密码/), 'pass')

    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(callsOf('/api/connections', 'POST')).toHaveLength(1))
    const body = JSON.parse(callsOf('/api/connections', 'POST')[0]![1].body as string) as {
      kind: string
      config: Record<string, unknown>
      secret?: Record<string, unknown>
    }
    expect(body.kind).toBe('proxy')
    expect(body.config).toMatchObject({ mode: 'http', scheme: 'http', host: 'proxy.corp.io', port: 3128 })
    expect(body.secret).toMatchObject({ username: 'user', password: 'pass' })
  })
})
