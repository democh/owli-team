/**
 * M36 前端测试：
 * - 设置主区页（SettingsView）：26 项运行期设置全量渲染 / 金融参数保存 / 资源概览直达 / 系统信息；
 * - 画布指令条（CanvasComposer）：Enter 发送、范式 chip、运行中插话与成员快捷 @；
 * - 连接中心「直达编辑」：pendingEditId 在清单就绪后消费并打开编辑表单。
 * - M56：媒体生成迁「设置 → 媒体生成」——分组渲染 + 直达编辑消费（自连接中心迁入）；
 *   连接管理不再呈现媒体连接（计数只计非媒体，新建类型不含媒体）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentDefinition, ConnectionDefinition } from '@multi-agent/shared'
import { CanvasComposer } from '../src/components/canvas/CanvasComposer'
import { ConnectionsConsole } from '../src/components/console/ConnectionsConsole'
import { SettingsView } from '../src/components/settings/SettingsView'
import { useAgentStore } from '../src/stores/agent-store'
import { useCanvasStore } from '../src/stores/canvas-store'
import { useConnectionsStore } from '../src/stores/connections-store'
import { useMcpStore } from '../src/stores/mcp-store'
import { useRunStore } from '../src/stores/run-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'

const fetchMock = vi.fn()
let sendMock: ReturnType<typeof vi.fn>

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function makeAgent(id: string, name: string, role: string): AgentDefinition {
  return {
    id,
    name,
    role,
    title: role,
    description: '',
    capabilities: [],
    group: 'development',
    avatar: { gradient: ['#3b82f6', '#f59e0b'], icon: 'user' },
    handoff: [],
  }
}

function makeMediaConnection(overrides: Partial<ConnectionDefinition> = {}): ConnectionDefinition {
  return {
    id: 'conn_media',
    name: '本地生图',
    kind: 'media',
    config: { provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', capabilities: ['text2image'] },
    status: 'ok',
    enabled: true,
    secretSet: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

/** 全量运行设置（27 项；含 M34 金融投研 4 项） */
const SETTINGS: Record<string, unknown> = {
  llmModel: 'gpt-test',
  summaryModel: '',
  judgeModel: '',
  temperature: 0.3,
  temperatureOverride: false,
  maxTurnsPerRun: 12,
  contextBudgetTokens: 60000,
  keepRecentTurns: 6,
  toolResultMaxTokens: 4000,
  toolDetailKeep: 4,
  toolTimeoutMs: 120000,
  handoffMode: 'auto',
  approvalMode: 'risky',
  approvalTimeoutMs: 60000,
  allowRunCommand: true,
  allowSensitive: false,
  notifyPollMs: 3000,
  embeddingConnectionId: '',
  memoryRecallEnabled: true,
  memoryRecallTopK: 8,
  memoryRecallMinScore: 0.25,
  memoryRecallBudgetTokens: 600,
  memoryDigestMode: 'off',
  financeEnabled: false,
  financeQuoteRefreshMs: 10000,
  financeMinIntervalMs: 0,
  financePyTimeoutMs: 30000,
}

/** 27 项字段标签（顺序与 SettingsView 分组一致） */
const ALL_LABELS = [
  '主模型',
  '摘要模型',
  '评测模型',
  '温度',
  '统一温度',
  '上下文预算（tokens）',
  '保留最近回合数',
  '单条工具结果上限（tokens）',
  '工具明细保留条数',
  '语义召回',
  '嵌入连接',
  '召回条数 TopK',
  '最低分门槛',
  '召回预算（tokens）',
  '自动沉淀',
  '单 Run 回合上限',
  '交接模式',
  '降级轮询间隔（ms）',
  '工具超时（ms）',
  '审批模式',
  '审批超时（ms）',
  '允许 run_command',
  '允许敏感文件读写',
  '启用金融工具',
  '行情刷新间隔（ms）',
  '最小请求间隔（ms）',
  'Python 桥超时（ms）',
]

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stubSettingsFetch(extra: { connections?: ConnectionDefinition[] } = {}): void {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/api/settings' && init?.method === 'PUT') return Promise.resolve(jsonResponse({ settings: SETTINGS, applied: true }))
    if (url === '/api/settings') return Promise.resolve(jsonResponse({ settings: SETTINGS }))
    if (url === '/api/connections') return Promise.resolve(jsonResponse({ connections: extra.connections ?? [] }))
    if (url === '/api/mcp/servers') return Promise.resolve(jsonResponse({ servers: [{ id: 'mcp_a' }, { id: 'mcp_b' }] }))
    if (url === '/api/mcp/tools') return Promise.resolve(jsonResponse({ tools: [{ name: 't1' }, { name: 't2' }, { name: 't3' }] }))
    if (url === '/api/mcp/json-config') return Promise.resolve(jsonResponse({ config: null }))
    if (url === '/api/agents') return Promise.resolve(jsonResponse({ agents: [{ id: 'a1' }, { id: 'a2' }] }))
    if (url === '/api/skills') return Promise.resolve(jsonResponse({ skills: [{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' }] }))
    if (url === '/api/health')
      return Promise.resolve(
        jsonResponse({
          ok: true,
          model: 'gpt-test',
          baseUrl: 'http://127.0.0.1:11434/v1',
          thinking: false,
          notifyPollMs: 3000,
        }),
      )
    return Promise.resolve(jsonResponse({}, 404))
  })
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  localStorage.clear()
  sendMock = vi.fn(async () => undefined)
  useAgentStore.setState({ agents: [], groups: [], presets: [], skills: [], loaded: false, loading: false, statuses: {} })
  useSessionStore.setState({
    sessions: [
      {
        id: 's1',
        title: '画布会话',
        participantIds: ['architect'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 0,
      },
    ],
    currentId: 's1',
    byId: new Map(),
    order: [],
    loadingSessions: false,
    loadingMessages: false,
    artifactVersion: 0,
  })
  useRunStore.setState({ runId: undefined, sessionId: undefined, active: false, queued: false, queue: [], approvals: [], send: sendMock })
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
  useCanvasStore.setState({ doc: null, selectedIds: [], sessionId: undefined, remoteFlash: undefined })
  useUiStore.setState({ appView: 'workspace' })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('M36：设置主区页（SettingsView）', () => {
  it('27 项设置全量渲染（含金融投研 4 项），分组导航齐全', async () => {
    stubSettingsFetch()
    render(<SettingsView />)

    expect(await screen.findByDisplayValue('gpt-test')).toBeTruthy()
    for (const label of ALL_LABELS) {
      expect(screen.getByLabelText(new RegExp(`^${escapeRegExp(label)}`)), `缺少字段：${label}`).toBeTruthy()
    }
    // 分类导航（9 组；M56 新增「媒体生成」）
    for (const group of [
      '模型与生成',
      '媒体生成',
      '上下文',
      '向量记忆',
      '运行控制',
      '工具与安全',
      '金融投研',
      '资源与集成',
      '系统信息',
    ]) {
      expect(screen.getAllByText(group).length).toBeGreaterThan(0)
    }
    // 金融字段回显（服务端值）
    expect((screen.getByLabelText(/^行情刷新间隔/) as HTMLInputElement).value).toBe('10000')
  })

  it('修改金融参数并保存：PUT 携带全量设置；脏标记保存后消失', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/settings' && init?.method === 'PUT') return Promise.resolve(jsonResponse({ settings: SETTINGS, applied: true }))
      if (url === '/api/settings') return Promise.resolve(jsonResponse({ settings: SETTINGS }))
      if (url === '/api/connections') return Promise.resolve(jsonResponse({ connections: [] }))
      if (url === '/api/health') return Promise.resolve(jsonResponse({ ok: true, model: 'gpt-test' }))
      return Promise.resolve(jsonResponse({}, 404))
    })

    render(<SettingsView />)
    const input = (await screen.findByLabelText(/^行情刷新间隔/)) as HTMLInputElement
    expect(screen.queryByText('未保存改动')).toBeNull()

    await userEvent.clear(input)
    await userEvent.type(input, '20000')
    expect(screen.getByText('未保存改动')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /保存并生效/ }))
    await waitFor(() => {
      const put = calls.find((c) => c.url === '/api/settings' && c.init?.method === 'PUT')
      expect(put).toBeTruthy()
      const body = JSON.parse(String(put!.init?.body)) as Record<string, unknown>
      expect(body.financeQuoteRefreshMs).toBe(20000)
      expect(body.llmModel).toBe('gpt-test')
      expect(body.memoryRecallTopK).toBe(8)
    })
    await waitFor(() => expect(screen.queryByText('未保存改动')).toBeNull())
  })

  it('统一温度：开关切换后保存回传 temperatureOverride；提示角色覆盖统计', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/settings' && init?.method === 'PUT') return Promise.resolve(jsonResponse({ settings: SETTINGS, applied: true }))
      if (url === '/api/settings') return Promise.resolve(jsonResponse({ settings: SETTINGS }))
      if (url === '/api/connections') return Promise.resolve(jsonResponse({ connections: [] }))
      if (url === '/api/skills') return Promise.resolve(jsonResponse({ skills: [] }))
      if (url === '/api/health') return Promise.resolve(jsonResponse({ ok: true, model: 'gpt-test' }))
      if (url === '/api/agents')
        return Promise.resolve(
          jsonResponse({
            agents: [{ ...makeAgent('a1', '甲', '角色'), temperature: 0.3 }, makeAgent('a2', '乙', '角色')],
          }),
        )
      return Promise.resolve(jsonResponse({}, 404))
    })

    render(<SettingsView />)
    const box = (await screen.findByRole('checkbox', { name: /统一温度/ })) as HTMLInputElement
    expect(box.checked).toBe(false)
    // 覆盖统计提示：1/2 个角色单独配置了温度
    expect(await screen.findByText(/1\/2 个角色单独配置了温度/)).toBeTruthy()

    await userEvent.click(box)
    expect(screen.getByText('未保存改动')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /保存并生效/ }))
    await waitFor(() => {
      const put = calls.find((c) => c.url === '/api/settings' && c.init?.method === 'PUT')
      expect(put).toBeTruthy()
      const body = JSON.parse(String(put!.init?.body)) as Record<string, unknown>
      expect(body.temperatureOverride).toBe(true)
    })
  })

  it('资源与集成：计数概览（连接 / MCP / 角色 / 技能）与直达入口', async () => {
    stubSettingsFetch({ connections: [makeMediaConnection()] })
    render(<SettingsView />)

    expect(await screen.findByText('1 个连接')).toBeTruthy()
    expect(await screen.findByText('2 台服务器 · 3 个工具')).toBeTruthy()
    expect(await screen.findByText('2 个角色')).toBeTruthy()
    expect(await screen.findByText('4 项技能')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '前往连接管理' }))
    expect(useUiStore.getState().appView).toBe('connections')
  })

  it('系统信息：/api/health 下发参数回显（模型 / 地址 / 健康）', async () => {
    stubSettingsFetch()
    render(<SettingsView />)

    expect(await screen.findByText('运行正常')).toBeTruthy()
    expect(await screen.findByText('gpt-test')).toBeTruthy()
    expect(await screen.findByText('http://127.0.0.1:11434/v1')).toBeTruthy()
  })
})

describe('M36：画布指令条（CanvasComposer）', () => {
  it('Enter 发送进入当前会话，输入框清空', async () => {
    useAgentStore.setState({ agents: [makeAgent('architect', '艾达', '架构师')] })
    render(<CanvasComposer />)

    const box = screen.getByRole('textbox')
    await userEvent.type(box, '画个登录页草图')
    await userEvent.keyboard('{Enter}')

    await waitFor(() => expect(sendMock).toHaveBeenCalledWith('画个登录页草图', undefined))
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(''))
  })

  it('范式 chip「规划」：随下一条消息发送（mode=plan），发送后复位', async () => {
    useAgentStore.setState({ agents: [makeAgent('architect', '艾达', '架构师')] })
    render(<CanvasComposer />)

    const box = screen.getByRole('textbox')
    await userEvent.type(box, '先出方案')
    await userEvent.click(screen.getByRole('button', { name: '规划' }))
    // 点击 chip 后焦点离开输入框：重新聚焦再 Enter 发送
    await userEvent.click(box)
    await userEvent.keyboard('{Enter}')

    await waitFor(() => expect(sendMock).toHaveBeenCalledWith('先出方案', 'plan'))
    // 发送后范式复位执行
    expect(screen.queryByText(/本条以「规划」发送/)).toBeNull()
  })

  it('运行中：发送按钮变「插话」+ 停止按钮 + 成员快捷 @ 插入', async () => {
    useAgentStore.setState({ agents: [makeAgent('architect', '艾达', '架构师')] })
    useRunStore.setState({ active: true })
    render(<CanvasComposer />)

    expect(screen.getByRole('button', { name: /插话/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /停止/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: '规划' })).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: /艾达/ }))
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('@艾达 ')
  })

  it('引用选中（M31 修订）：选中节点时浮现 chip，点击逐行插入引文到输入框', async () => {
    useAgentStore.setState({ agents: [makeAgent('architect', '艾达', '架构师')] })
    useCanvasStore.setState({
      doc: {
        v: 1,
        sessionId: 's1',
        version: 1,
        updatedAt: new Date().toISOString(),
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [
          { id: 'nd_q', type: 'note', position: { x: 0, y: 0 }, data: { text: '待办要点' } },
          { id: 'nd_r', type: 'note', position: { x: 200, y: 0 }, data: { text: '次要' } },
        ],
        edges: [],
      },
      selectedIds: ['nd_q'],
    })
    render(<CanvasComposer />)

    // 未选中不出现；选中 1 个 → chip 显示计数
    const chip = screen.getByRole('button', { name: /引用选中 1/ })
    await userEvent.click(chip)
    const box = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(box.value).toContain('[画布便签]')
    expect(box.value).toContain('待办要点')
    expect(box.value).not.toContain('次要')
  })

  it('引用选中：无选中时 chip 不渲染', () => {
    useAgentStore.setState({ agents: [makeAgent('architect', '艾达', '架构师')] })
    render(<CanvasComposer />)
    expect(screen.queryByRole('button', { name: /引用选中/ })).toBeNull()
  })
})

describe('M56：媒体生成迁入设置（分组 + 直达编辑消费）', () => {
  it('媒体分组渲染 + 直达编辑：pendingEditId 就绪后打开编辑表单并清零请求', async () => {
    stubSettingsFetch({ connections: [makeMediaConnection()] })
    useConnectionsStore.setState({ pendingEditId: 'conn_media' })

    render(<SettingsView />)
    expect(await screen.findByText('编辑媒体生成连接')).toBeTruthy()
    expect(screen.getByDisplayValue('本地生图')).toBeTruthy()
    expect(useConnectionsStore.getState().pendingEditId).toBeUndefined()
  })

  it('直达编辑目标不存在（已删除）：丢弃请求不悬挂，空态引导出现', async () => {
    stubSettingsFetch({ connections: [] })
    useConnectionsStore.setState({ pendingEditId: 'ghost' })

    render(<SettingsView />)
    await waitFor(() => expect(useConnectionsStore.getState().pendingEditId).toBeUndefined())
    expect(screen.queryByText('编辑媒体生成连接')).toBeNull()
    expect(await screen.findByText(/还没有媒体生成连接/)).toBeTruthy()
  })
})

describe('M56：连接管理不再呈现媒体生成', () => {
  it('媒体连接被过滤（计数只计非媒体）+ 新建类型不含媒体', async () => {
    const dbConn = makeMediaConnection({
      id: 'conn_pg',
      name: '生产库',
      kind: 'postgres',
      config: { host: '127.0.0.1', port: 5432, database: 'app', readOnly: true },
    })
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/connections')
        return Promise.resolve(jsonResponse({ connections: [dbConn, makeMediaConnection()] }))
      if (url.includes('/api/sessions/')) return Promise.resolve(jsonResponse({ bindings: [] }))
      if (url.includes('/api/audit')) return Promise.resolve(jsonResponse({ entries: [] }))
      return Promise.resolve(jsonResponse({}, 404))
    })

    render(<ConnectionsConsole />)
    expect(await screen.findByText('生产库')).toBeTruthy()
    expect(screen.queryByText('本地生图')).toBeNull()
    expect(await screen.findByText('1 个连接')).toBeTruthy()

    // 新建 chips：媒体生成不再出现（CREATE_KINDS 过滤）
    await userEvent.click(screen.getByRole('button', { name: /新建连接/ }))
    expect(screen.queryByRole('button', { name: '媒体生成' })).toBeNull()
  })
})
