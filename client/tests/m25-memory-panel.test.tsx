/**
 * M25.3d 前端测试：记忆面板（scope 分段 / owner 解析 / 候选审核 / 语义搜索 / supersede）
 * + 上下文档 L1.5 召回明细。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentDefinition, ContextSnapshot, MemoryItem, RecalledMemory, SessionSummary } from '@multi-agent/shared'
import { ContextBar } from '../src/components/context/ContextBar'
import { MemoryPanel } from '../src/components/team/MemoryPanel'
import { useAgentStore } from '../src/stores/agent-store'
import { useRunStore } from '../src/stores/run-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function makeMemory(overrides: Partial<MemoryItem> = {}): MemoryItem {
  const now = new Date().toISOString()
  return {
    id: 'm1',
    scope: 'session',
    ownerId: 's1',
    kind: 'decision',
    content: '接口错误码统一使用 40001 规范',
    source: 'user',
    importance: 3,
    entities: [],
    status: 'active',
    validFrom: now,
    hits: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

const SESSION_SUMMARY: SessionSummary = {
  id: 's1',
  title: '测试会话',
  participantIds: ['pm', 'architect'],
  projectId: 'p-1',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  messageCount: 3,
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  useSessionStore.setState({ currentId: 's1', sessions: [SESSION_SUMMARY] })
  useAgentStore.setState({
    agents: [
      { id: 'pm', name: '费利' },
      { id: 'architect', name: '艾达' },
    ] as unknown as AgentDefinition[],
  })
  useRunStore.setState({ runId: undefined, active: false, compressionCount: 0 })
  useUiStore.setState({ contextOpen: false })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('M25.3d：记忆面板', () => {
  it('scope 分段：owner 自动解析（会话 → 全局 → 成员 → 项目）且携带 status 过滤', async () => {
    const calls: string[] = []
    fetchMock.mockImplementation((url: string) => {
      calls.push(url)
      return Promise.resolve(jsonResponse({ memory: [] }))
    })
    render(<MemoryPanel />)

    await waitFor(() => expect(calls.some((u) => u.startsWith('/api/memories?'))).toBe(true))
    expect(calls.find((u) => u.startsWith('/api/memories?'))).toContain('scope=session&owner=s1&status=active')

    await userEvent.click(screen.getByRole('button', { name: '全局' }))
    await waitFor(() => expect(calls.some((u) => u.includes('scope=global&owner=global'))).toBe(true))

    await userEvent.click(screen.getByRole('button', { name: '成员' }))
    await waitFor(() => expect(calls.some((u) => u.includes('scope=agent&owner=pm'))).toBe(true))

    await userEvent.click(screen.getByRole('button', { name: '项目' }))
    await waitFor(() => expect(calls.some((u) => u.includes('scope=project&owner=p-1'))).toBe(true))

    // 状态筛选切换 → 携带对应 status 参数
    await userEvent.click(screen.getByRole('button', { name: '候选' }))
    await waitFor(() => expect(calls.some((u) => u.includes('status=candidate'))).toBe(true))
    // 全部 → status 参数消失
    await userEvent.click(screen.getByRole('button', { name: '全部' }))
    await waitFor(() => {
      const last = calls.filter((u) => u.includes('scope=project')).at(-1)
      expect(last).not.toContain('status=')
    })
  })

  it('候选审核：通过 → PATCH status=active；忽略 → archived', async () => {
    const candidate = makeMemory({ id: 'm2', status: 'candidate', content: '候选经验：先跑单测再提交' })
    const calls: Array<{ url: string; init?: RequestInit }> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.startsWith('/api/memories?')) return Promise.resolve(jsonResponse({ memory: [candidate] }))
      if (url === '/api/memories/m2/status') return Promise.resolve(jsonResponse({ item: { ...candidate, status: 'active' } }))
      return Promise.resolve(jsonResponse({}))
    })
    render(<MemoryPanel />)
    expect(await screen.findByText('候选经验：先跑单测再提交')).toBeTruthy()

    await userEvent.click(screen.getByTitle('通过（纳入召回）'))
    await waitFor(() => {
      const patch = calls.find((c) => c.url === '/api/memories/m2/status' && c.init?.method === 'PATCH')
      expect(patch).toBeTruthy()
      expect(JSON.parse(String(patch!.init?.body))).toEqual({ status: 'active' })
    })

    await userEvent.click(screen.getByTitle('忽略（归档）'))
    await waitFor(() => {
      const patches = calls.filter((c) => c.url === '/api/memories/m2/status' && c.init?.method === 'PATCH')
      expect(JSON.parse(String(patches.at(-1)!.init?.body))).toEqual({ status: 'archived' })
    })
  })

  it('语义搜索：POST /api/memories/recall → 展示评分与 scope 徽标', async () => {
    const recalled: RecalledMemory[] = [{ id: 'm3', scope: 'agent', kind: 'fact', content: '发布窗口每周四下午', score: 0.812 }]
    const calls: Array<{ url: string; init?: RequestInit }> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.startsWith('/api/memories?')) return Promise.resolve(jsonResponse({ memory: [] }))
      if (url === '/api/memories/recall') {
        return Promise.resolve(jsonResponse({ outcome: { items: recalled, candidates: 3, rendered: '', tokens: 10 } }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<MemoryPanel />)
    const input = await screen.findByPlaceholderText('语义搜索（回车召回，含评分）')
    await userEvent.type(input, '发布窗口{Enter}')

    const hit = await screen.findByText('发布窗口每周四下午')
    expect(screen.getByText('0.812')).toBeTruthy()
    // scope 徽标限定在结果卡片内（页面另有「成员」分段按钮）
    expect(within(hit.closest('div')!).getByText('成员')).toBeTruthy()

    const post = calls.find((c) => c.url === '/api/memories/recall')
    expect(post).toBeTruthy()
    const body = JSON.parse(String(post!.init?.body)) as Record<string, unknown>
    expect(body.query).toBe('发布窗口')
    expect(body.sessionId).toBe('s1')
    expect(body.agentId).toBe('pm')
    expect(body.projectId).toBe('p-1')
  })

  it('语义搜索：休眠 skipped 提示启用路径', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/memories?')) return Promise.resolve(jsonResponse({ memory: [] }))
      if (url === '/api/memories/recall') {
        return Promise.resolve(jsonResponse({ outcome: { items: [], candidates: 0, skipped: '嵌入服务休眠（未选择嵌入连接）' } }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<MemoryPanel />)
    const input = await screen.findByPlaceholderText('语义搜索（回车召回，含评分）')
    await userEvent.type(input, '任意查询{Enter}')

    expect(await screen.findByText(/嵌入服务休眠/)).toBeTruthy()
    expect(screen.getByText(/在设置 → 向量记忆中选择嵌入连接后启用/)).toBeTruthy()
  })

  it('supersede：active 条目选择替代者 → POST /:id/supersede', async () => {
    const older = makeMemory({ id: 'm1', content: '旧决策：接口用 PUT' })
    const newer = makeMemory({ id: 'm2', content: '新决策：接口改用 POST' })
    const calls: Array<{ url: string; init?: RequestInit }> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.startsWith('/api/memories?')) return Promise.resolve(jsonResponse({ memory: [older, newer] }))
      if (url === '/api/memories/m1/supersede') return Promise.resolve(jsonResponse({ item: { ...older, status: 'superseded' } }))
      return Promise.resolve(jsonResponse({}))
    })
    render(<MemoryPanel />)
    expect(await screen.findByText('旧决策：接口用 PUT')).toBeTruthy()

    await userEvent.click(screen.getAllByTitle('标记取代（被同 scope 另一条替代）')[0]!)
    const select = await screen.findByLabelText('选择替代条目')
    await userEvent.selectOptions(select, 'm2')

    await waitFor(() => {
      const post = calls.find((c) => c.url === '/api/memories/m1/supersede' && c.init?.method === 'POST')
      expect(post).toBeTruthy()
      expect(JSON.parse(String(post!.init?.body))).toEqual({ newId: 'm2' })
    })
  })
})

describe('M25.3d：上下文档（L1.5 召回明细）', () => {
  it('快照含 L1.5 层 → 抽屉显示召回明细（scope / 评分 / 内容）', async () => {
    const snapshot: ContextSnapshot = {
      sessionId: 's1',
      budgetTokens: 60000,
      estimatedTokens: 12000,
      usageRatio: 0.2,
      layers: [
        { key: 'L0', label: '系统提示', tokens: 800 },
        { key: 'L1.5', label: '语义召回', tokens: 120, detail: '召回 1 条（预算内）' },
      ],
      untilSeq: 0,
      degraded: false,
      memory: [],
      recalled: [{ id: 'm1', scope: 'agent', kind: 'constraint', content: '构建产物输出到 workspace/dist', score: 0.834 }],
    }
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/sessions/s1/context') return Promise.resolve(jsonResponse({ context: snapshot }))
      if (url === '/api/runs/r1/usage') {
        return Promise.resolve(jsonResponse({ usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.001 } }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    useRunStore.setState({ runId: 'r1', sessionId: 's1', active: false, compressionCount: 0 })
    useUiStore.setState({ contextOpen: true })
    render(<ContextBar />)

    expect(await screen.findByText('语义召回（L1.5）')).toBeTruthy()
    expect(screen.getByText('召回 1 条（预算内）')).toBeTruthy()
    expect(screen.getByText('构建产物输出到 workspace/dist')).toBeTruthy()
    expect(screen.getByText('0.834')).toBeTruthy()
    expect(screen.getByText('成员')).toBeTruthy()
  })

  it('L1.5 存在但无召回 → 显示「本回合无召回注入」', async () => {
    const snapshot: ContextSnapshot = {
      sessionId: 's1',
      budgetTokens: 60000,
      estimatedTokens: 9000,
      usageRatio: 0.15,
      layers: [{ key: 'L1.5', label: '语义召回', tokens: 0, detail: '本回合无命中' }],
      untilSeq: 0,
      degraded: false,
      memory: [],
    }
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/sessions/s1/context') return Promise.resolve(jsonResponse({ context: snapshot }))
      return Promise.resolve(jsonResponse({}))
    })
    useUiStore.setState({ contextOpen: true })
    render(<ContextBar />)

    expect(await screen.findByText('语义召回（L1.5）')).toBeTruthy()
    expect(screen.getByText('本回合无召回注入')).toBeTruthy()
  })
})
