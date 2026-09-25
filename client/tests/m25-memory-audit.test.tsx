/**
 * P2 跨空间记忆审计（work-life P2 收口）：记忆面板「仅看跨域共享」视图——
 * 切换后请求携带 spaceId=shared（仅跨域共享 / 全局记忆），「返回当前空间」恢复；
 * 空间未装配（spaces 空）时不渲染该入口（兼容模式零影响）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentDefinition, MemoryItem, SessionSummary, Space } from '@multi-agent/shared'
import { MemoryPanel } from '../src/components/team/MemoryPanel'
import { useAgentStore } from '../src/stores/agent-store'
import { useRunStore } from '../src/stores/run-store'
import { useSessionStore } from '../src/stores/session-store'
import { useSpaceStore } from '../src/stores/space-store'
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
    kind: 'fact',
    content: '默认记忆条目',
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
  participantIds: ['pm'],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  messageCount: 3,
}

const WORK: Space = {
  id: 'work',
  name: '工作',
  kind: 'work',
  builtin: true,
  sort: 1,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}
const LIFE: Space = { ...WORK, id: 'life', name: '生活', kind: 'life', sort: 2 }

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  useSessionStore.setState({ currentId: 's1', sessions: [SESSION_SUMMARY] })
  useAgentStore.setState({ agents: [{ id: 'pm', name: '费利' }] as unknown as AgentDefinition[] })
  useRunStore.setState({ runId: undefined, active: false, compressionCount: 0 })
  useUiStore.setState({ contextOpen: false })
  useSpaceStore.setState({ spaces: [WORK, LIFE], currentId: 'work', loaded: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('P2：跨空间记忆审计视图', () => {
  it('「仅看跨域共享」→ 请求带 spaceId=shared；「返回当前空间」→ 恢复当前空间', async () => {
    const calls: string[] = []
    const globalItem = makeMemory({ id: 'g1', content: '用户名阿澈（跨域共享）' })
    fetchMock.mockImplementation((url: string) => {
      calls.push(url)
      if (url.includes('spaceId=shared')) return Promise.resolve(jsonResponse({ memory: [globalItem] }))
      return Promise.resolve(jsonResponse({ memory: [] }))
    })
    render(<MemoryPanel />)

    // 初始：随当前空间 work（默认视图）
    await waitFor(() => expect(calls.some((u) => u.includes('spaceId=work'))).toBe(true))
    expect(screen.getByText('空间·工作')).toBeTruthy()

    // 跨空间审计：仅跨域共享
    await userEvent.click(screen.getByRole('button', { name: '仅看跨域共享' }))
    await waitFor(() => expect(calls.some((u) => u.includes('spaceId=shared'))).toBe(true))
    expect(await screen.findByText('用户名阿澈（跨域共享）')).toBeTruthy()
    expect(screen.getByText('空间·跨域共享')).toBeTruthy()

    // 返回当前空间：恢复 spaceId=work 且不再带 shared
    await userEvent.click(screen.getByRole('button', { name: '返回当前空间' }))
    await waitFor(() => {
      const last = calls.at(-1)!
      expect(last).toContain('spaceId=work')
      expect(last).not.toContain('spaceId=shared')
    })
    expect(screen.getByText('空间·工作')).toBeTruthy()
  })

  it('空间未装配（spaces 空）时不渲染审计入口，且请求不带 spaceId（兼容模式零影响）', async () => {
    useSpaceStore.setState({ spaces: [], currentId: 'default', loaded: true })
    const calls: string[] = []
    fetchMock.mockImplementation((url: string) => {
      calls.push(url)
      return Promise.resolve(jsonResponse({ memory: [] }))
    })
    render(<MemoryPanel />)

    await waitFor(() => expect(calls.some((u) => u.startsWith('/api/memories?'))).toBe(true))
    expect(screen.queryByRole('button', { name: '仅看跨域共享' })).toBeNull()
    expect(calls.find((u) => u.startsWith('/api/memories?'))).not.toContain('spaceId=')
  })

  it('提升为跨域共享：POST /memories/:id/elevate 成功后就地重载列表', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const item = makeMemory({ id: 'm9', spaceId: 'work', content: '可提升为全局的记忆' })
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/memories/m9/elevate') {
        return Promise.resolve(jsonResponse({ item: { ...item, spaceId: undefined } }))
      }
      if (url.startsWith('/api/memories?')) return Promise.resolve(jsonResponse({ memory: [item] }))
      return Promise.resolve(jsonResponse({}))
    })
    render(<MemoryPanel />)

    expect(await screen.findByText('可提升为全局的记忆')).toBeTruthy()
    await userEvent.click(screen.getByTitle('提升为跨域共享（全局记忆，全空间可见；留审计）'))
    await waitFor(() => {
      expect(
        calls.some((c) => c.url === '/api/memories/m9/elevate' && c.init?.method === 'POST'),
      ).toBe(true)
    })
    // 提升成功后就地重载（再次拉取列表）
    await waitFor(() => {
      expect(calls.filter((c) => c.url.startsWith('/api/memories?')).length).toBeGreaterThanOrEqual(2)
    })
  })
})
