/**
 * 多 Provider 前端测试：
 * - ModelProvidersSection：空态（系统默认说明）/ 新建保存（llm 连接 config + secret）/ 清单与停用标记；
 * - AgentEditor：model 候选来自已启用服务的模型清单（datalist）→ 保存 PUT model。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ConnectionDefinition, ConsoleAgentDetail } from '@multi-agent/shared'
import { AgentEditor } from '../src/components/console/AgentEditor'
import { ModelProvidersSection } from '../src/components/settings/ModelProvidersSection'
import { useAgentStore } from '../src/stores/agent-store'
import { useConnectionsStore } from '../src/stores/connections-store'
import { useConsoleStore } from '../src/stores/console-store'
import { useMcpStore } from '../src/stores/mcp-store'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function makeLlmConnection(overrides: Partial<ConnectionDefinition> = {}): ConnectionDefinition {
  return {
    id: 'conn_llm1',
    name: 'DeepSeek 官方',
    kind: 'llm',
    config: {
      baseUrl: 'https://api.deepseek.com/v1',
      models: ['deepseek-flash', 'deepseek-v4-pro'],
    },
    status: 'ok',
    enabled: true,
    secretSet: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

const AGENT_DETAIL: ConsoleAgentDetail = {
  id: 'pm',
  name: '产品经理',
  role: '产品经理',
  title: '需求负责人',
  description: '负责需求',
  group: 'development',
  avatar: { icon: 'clipboard-list', gradient: ['#6366f1', '#818cf8'] },
  hasAvatar: false,
  skillCount: -1,
  toolCount: -1,
  soulCount: 0,
  handoffCount: 0,
  refCount: 0,
  meta: {
    id: 'pm',
    name: '产品经理',
    role: '产品经理',
    title: '需求负责人',
    description: '负责需求',
    capabilities: ['需求拆解'],
    avatar: { icon: 'clipboard-list', gradient: ['#6366f1', '#818cf8'] },
    group: 'development',
    handoff: [],
  },
  body: '## 职责\n\n测试正文。',
  souls: [],
  refs: { items: [] },
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  useAgentStore.setState({ agents: [], groups: [], presets: [], skills: [], loaded: true, loading: false, statuses: {} })
  useConnectionsStore.setState({
    connections: [],
    bindings: [],
    ops: [],
    sessionId: undefined,
    loading: false,
    busyId: undefined,
    pendingEditId: undefined,
  })
  useConsoleStore.setState({ agents: [], skills: [], groups: [], tools: [], issues: [], loading: false })
  useMcpStore.setState({ servers: [], tools: [], bindings: [], sessionId: undefined, loading: false })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('多 Provider：ModelProvidersSection', () => {
  it('空态说明系统默认；新建保存 POST llm 连接（config + secret）', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/connections' && init?.method === 'POST')
        return Promise.resolve(jsonResponse({ connection: makeLlmConnection({ id: 'conn_new', name: '我的网关' }) }))
      if (url === '/api/connections') return Promise.resolve(jsonResponse({ connections: [] }))
      return Promise.resolve(jsonResponse({}, 404))
    })

    render(<ModelProvidersSection />)
    expect(await screen.findByText(/未配置：全部角色使用系统默认/)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /新建模型服务/ }))
    await userEvent.type(screen.getByLabelText(/^名称/), '我的网关')
    await userEvent.type(screen.getByLabelText(/接入地址/), 'https://gw.example.com/v1')
    await userEvent.type(screen.getByLabelText(/API Key/), 'sk-mine-12345678')
    await userEvent.type(screen.getByLabelText(/模型清单/), 'qwen-max, qwen-turbo')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      const post = calls.find((c) => c.url === '/api/connections' && c.init?.method === 'POST')
      expect(post).toBeTruthy()
      const body = JSON.parse(String(post!.init?.body)) as Record<string, unknown>
      expect(body.kind).toBe('llm')
      expect(body.name).toBe('我的网关')
      expect(body.config).toEqual({ baseUrl: 'https://gw.example.com/v1', models: ['qwen-max', 'qwen-turbo'] })
      expect(body.secret).toEqual({ apiKey: 'sk-mine-12345678' })
    })
  })

  it('清单卡片：baseUrl / 模型数 / 停用标记', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/connections')
        return Promise.resolve(
          jsonResponse({
            connections: [
              makeLlmConnection(),
              makeLlmConnection({ id: 'conn_old', name: '旧网关', enabled: false, status: 'error' }),
            ],
          }),
        )
      return Promise.resolve(jsonResponse({}, 404))
    })

    render(<ModelProvidersSection />)
    expect(await screen.findByText('DeepSeek 官方')).toBeTruthy()
    expect(screen.getByText('已配置 2 个模型服务')).toBeTruthy()
    expect(screen.getByText('旧网关')).toBeTruthy()
    expect(screen.getByText('已停用')).toBeTruthy()
    expect(screen.getAllByText('https://api.deepseek.com/v1').length).toBe(2)
    expect(screen.getAllByText('2 个模型').length).toBe(2)
  })
})

describe('多 Provider：AgentEditor 模型名', () => {
  it('model 候选来自已启用服务清单（datalist）→ 保存 PUT model', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/console/agents/pm' && init?.method === 'PUT')
        return Promise.resolve(jsonResponse({ agent: AGENT_DETAIL }))
      if (url === '/api/console/agents/pm') return Promise.resolve(jsonResponse({ agent: AGENT_DETAIL }))
      if (url === '/api/connections') return Promise.resolve(jsonResponse({ connections: [makeLlmConnection()] }))
      if (url === '/api/console/tools') return Promise.resolve(jsonResponse({ tools: [] }))
      // 写操作收尾 refreshAll（控制台三接口 + 校验 + agent-store 重拉）
      if (url === '/api/console/agents') return Promise.resolve(jsonResponse({ agents: [] }))
      if (url === '/api/console/skills') return Promise.resolve(jsonResponse({ skills: [] }))
      if (url === '/api/console/groups') return Promise.resolve(jsonResponse({ groups: [] }))
      if (url === '/api/console/validate') return Promise.resolve(jsonResponse({ issues: [] }))
      if (url === '/api/agents') return Promise.resolve(jsonResponse({ agents: [], groups: [], presets: [] }))
      if (url === '/api/skills') return Promise.resolve(jsonResponse({ skills: [] }))
      if (url === '/api/mcp/servers') return Promise.resolve(jsonResponse({ servers: [] }))
      if (url === '/api/mcp/tools') return Promise.resolve(jsonResponse({ tools: [] }))
      return Promise.resolve(jsonResponse({}, 404))
    })

    const onClose = vi.fn()
    render(<AgentEditor agentId="pm" onClose={onClose} />)
    await userEvent.click(await screen.findByRole('tab', { name: '高级' }))

    // model 输入：datalist 候选 = 「服务名/模型名」全名（前缀引用）
    const modelInput = (await screen.findByLabelText('模型')) as HTMLInputElement
    expect(modelInput.getAttribute('list')).toBe('llm-model-candidates')
    const candidates = [...document.querySelectorAll('#llm-model-candidates option')].map(
      (o) => (o as HTMLOptionElement).value,
    )
    expect(candidates).toEqual(['DeepSeek 官方/deepseek-flash', 'DeepSeek 官方/deepseek-v4-pro'])

    await userEvent.type(modelInput, 'DeepSeek 官方/deepseek-v4-pro')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      const put = calls.find((c) => c.url === '/api/console/agents/pm' && c.init?.method === 'PUT')
      expect(put).toBeTruthy()
      const body = JSON.parse(String(put!.init?.body)) as Record<string, unknown>
      expect(body.model).toBe('DeepSeek 官方/deepseek-v4-pro')
      expect(body.provider).toBeUndefined()
    })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
