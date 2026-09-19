/**
 * M25 前端测试：连接管理「嵌入模型」kind（表单 / 卡片 / 绑定入口隐藏）+ 设置页「向量记忆」分组。
 * M36：设置面板升级为主区视图（SettingsView），用例同步迁移。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ConnectionDefinition } from '@multi-agent/shared'
import { ConnectionsConsole } from '../src/components/console/ConnectionsConsole'
import { SettingsView } from '../src/components/settings/SettingsView'
import { useConnectionsStore } from '../src/stores/connections-store'
import { useSessionStore } from '../src/stores/session-store'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function makeEmbeddingConnection(overrides: Partial<ConnectionDefinition> = {}): ConnectionDefinition {
  return {
    id: 'conn_emb',
    name: '嵌入端点',
    kind: 'embedding',
    config: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'nomic-embed-text', dim: 768 },
    status: 'ok',
    enabled: true,
    secretSet: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  useSessionStore.setState({ currentId: undefined, sessions: [] })
  useConnectionsStore.setState({
    connections: [],
    bindings: [],
    ops: [],
    sessionId: undefined,
    loading: false,
    busyId: undefined,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('M25：连接管理（embedding kind）', () => {
  it('新建嵌入连接：表单字段齐全，提交 config + 密钥（只写不读）', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/connections' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            connection: makeEmbeddingConnection({
              name: '语义库',
              config: { baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', dim: 1024 },
            }),
          }),
        )
      }
      return Promise.resolve(jsonResponse({ connections: [] }))
    })

    render(<ConnectionsConsole />)
    await userEvent.click(screen.getByRole('button', { name: /新建/ }))
    await userEvent.click(screen.getByRole('button', { name: /嵌入模型/ }))

    // 表单：地址 / 模型 / 维度（留空 = 探测）/ 密钥（不回显）/ 批量 / 超时
    expect(screen.getByPlaceholderText('https://api.openai.com/v1')).toBeTruthy()
    expect(screen.getByPlaceholderText('text-embedding-3-small')).toBeTruthy()
    expect(screen.getByPlaceholderText('自动')).toBeTruthy()
    expect(screen.getByPlaceholderText(/sk-/)).toBeTruthy()
    expect(screen.getByText(/加密存储，不回显/)).toBeTruthy()

    await userEvent.type(screen.getByPlaceholderText('如：生产只读库'), '语义库')
    await userEvent.type(screen.getByPlaceholderText('https://api.openai.com/v1'), 'https://api.openai.com/v1')
    await userEvent.type(screen.getByPlaceholderText('text-embedding-3-small'), 'text-embedding-3-small')
    await userEvent.type(screen.getByPlaceholderText('自动'), '1024')
    await userEvent.type(screen.getByPlaceholderText(/sk-/), 'sk-test')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      const post = calls.find((c) => c.url === '/api/connections' && c.init?.method === 'POST')
      expect(post).toBeTruthy()
      const body = JSON.parse(String(post!.init?.body)) as {
        name: string
        kind: string
        config: Record<string, unknown>
        secret?: Record<string, unknown>
      }
      expect(body.name).toBe('语义库')
      expect(body.kind).toBe('embedding')
      expect(body.config).toEqual({ model: 'text-embedding-3-small', baseUrl: 'https://api.openai.com/v1', dim: 1024 })
      expect(body.secret).toEqual({ apiKey: 'sk-test' })
    })
  })

  it('嵌入连接卡片：显示模型/维度，且不提供会话绑定入口', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/connections')) return Promise.resolve(jsonResponse({ connections: [makeEmbeddingConnection()] }))
      if (url.includes('/connections')) return Promise.resolve(jsonResponse({ bindings: [] }))
      if (url.includes('/api/audit')) return Promise.resolve(jsonResponse({ entries: [] }))
      return Promise.resolve(jsonResponse({}, 404))
    })
    useSessionStore.setState({ currentId: 's1' })

    render(<ConnectionsConsole />)
    expect(await screen.findByText('嵌入端点')).toBeTruthy()
    expect(screen.getByText('nomic-embed-text · 768d')).toBeTruthy()
    expect(screen.getByRole('button', { name: '测试' })).toBeTruthy()
    // 有会话（s1）但嵌入连接不参与绑定：入口隐藏
    expect(screen.queryByRole('button', { name: /绑定/ })).toBeNull()
  })
})

describe('M25：设置面板（向量记忆分组）', () => {
  it('嵌入连接下拉加载连接清单；保存回传 embeddingConnectionId 与召回参数', async () => {
    const conn = makeEmbeddingConnection()
    const settings = {
      llmModel: 'gpt-x',
      summaryModel: '',
      judgeModel: '',
      temperature: 0.3,
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
    }
    const calls: Array<{ url: string; init?: RequestInit }> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/settings' && init?.method === 'PUT') return Promise.resolve(jsonResponse({ settings, applied: true }))
      if (url === '/api/settings') return Promise.resolve(jsonResponse({ settings }))
      if (url === '/api/connections') return Promise.resolve(jsonResponse({ connections: [conn] }))
      return Promise.resolve(jsonResponse({}, 404))
    })

    render(<SettingsView />)

    // 导航与分组标题均含「向量记忆」（主区页左侧分类 + 右侧分组）
    expect((await screen.findAllByText('向量记忆')).length).toBeGreaterThan(0)
    // 下拉：未启用 + 嵌入连接候选
    expect(await screen.findByRole('option', { name: /嵌入端点/ })).toBeTruthy()
    const select = screen.getByLabelText(/^嵌入连接/) as HTMLSelectElement
    await userEvent.selectOptions(select, conn.id)
    expect(select.value).toBe(conn.id)

    // 召回条数改名 → 保存
    const topK = screen.getByLabelText(/召回条数 TopK/) as HTMLInputElement
    await userEvent.clear(topK)
    await userEvent.type(topK, '12')
    await userEvent.click(screen.getByRole('button', { name: /保存并生效/ }))

    await waitFor(() => {
      const put = calls.find((c) => c.url === '/api/settings' && c.init?.method === 'PUT')
      expect(put).toBeTruthy()
      const body = JSON.parse(String(put!.init?.body)) as Record<string, unknown>
      expect(body.embeddingConnectionId).toBe(conn.id)
      expect(body.memoryRecallTopK).toBe(12)
      expect(body.memoryRecallEnabled).toBe(true)
      expect(body.memoryDigestMode).toBe('off')
    })
  })

  it('所选嵌入连接缺失（已删除）时给出休眠提示', async () => {
    const settings = {
      llmModel: 'gpt-x',
      summaryModel: '',
      judgeModel: '',
      temperature: 0.3,
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
      embeddingConnectionId: 'ghost-id',
      memoryRecallEnabled: true,
      memoryRecallTopK: 8,
      memoryRecallMinScore: 0.25,
      memoryRecallBudgetTokens: 600,
      memoryDigestMode: 'off',
    }
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/settings') return Promise.resolve(jsonResponse({ settings }))
      if (url === '/api/connections') return Promise.resolve(jsonResponse({ connections: [] }))
      return Promise.resolve(jsonResponse({}, 404))
    })
    render(<SettingsView />)
    expect(await screen.findByText(/所选嵌入连接不存在/)).toBeTruthy()
  })
})
