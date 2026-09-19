/**
 * M13：命令面板扩充命令（CommandPalette）。
 * - 新建会话：空编制 POST（首条消息由平台路由组队），创建后自动切换（selectSession + 订阅）；
 * - 安静模式：一键切换并回显状态；
 * - 运行中 Trace：仅 runId 存在时出现，点击打开抽屉。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentDefinition, Session } from '@multi-agent/shared'
import { CommandPalette } from '../src/components/layout/CommandPalette'
import { useAgentStore } from '../src/stores/agent-store'
import { useRunStore } from '../src/stores/run-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'
import { useWsStore } from '../src/stores/ws-store'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function makeAgent(id: string, name: string): AgentDefinition {
  return {
    id,
    name,
    role: id,
    title: id,
    description: '',
    capabilities: [],
    group: 'development',
    avatar: { gradient: ['#3b82f6', '#f59e0b'], icon: 'user' },
    handoff: [],
  }
}

function makeSession(id: string, title: string): Session {
  return {
    id,
    title,
    participantIds: ['backend', 'architect'],
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  }
}

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  useAgentStore.setState({
    agents: [makeAgent('backend', '小北'), makeAgent('architect', '艾达')],
    skills: [],
    loaded: true,
    loading: false,
    statuses: {},
  })
  useSessionStore.setState({
    sessions: [],
    currentId: undefined,
    byId: new Map(),
    order: [],
    loadingSessions: false,
    loadingMessages: false,
    artifactVersion: 0,
    latestRun: undefined,
  })
  useRunStore.setState({ active: false, runId: undefined, approvals: [] })
  useUiStore.setState({ commandOpen: true, quietMode: false, traceRunId: undefined })
  useWsStore.setState({ unread: {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CommandPalette 扩充命令（M13）', () => {
  it('新建会话：空编制 POST，创建后自动选中并订阅', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === '/api/sessions' && method === 'POST') return jsonResponse({ session: makeSession('s9', '新会话') })
      if (url === '/api/sessions') return jsonResponse({ sessions: [makeSession('s9', '新会话')] })
      if (url === '/api/sessions/s9') return jsonResponse({ messages: [], latestRun: null })
      if (url === '/api/runs/active') return jsonResponse({ runs: [] })
      return jsonResponse({})
    })
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.click(screen.getByText('新建会话'))

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([u, init]) => String(u) === '/api/sessions' && (init as RequestInit)?.method === 'POST',
      )
      expect(post).toBeTruthy()
      const body = JSON.parse(String((post?.[1] as RequestInit).body)) as { participantIds: string[] }
      expect(body.participantIds).toEqual([])
      expect(useSessionStore.getState().currentId).toBe('s9')
    })
  })

  it('安静模式：点击即切换', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)

    expect(screen.getByText('当前：关')).toBeTruthy()
    await user.click(screen.getByText('切换安静模式'))
    expect(useUiStore.getState().quietMode).toBe(true)
  })

  it('运行中 Trace：runId 存在时出现，点击打开抽屉', async () => {
    useRunStore.setState({ runId: 'r1', active: true })
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.click(screen.getByText('查看当前运行 Trace'))
    expect(useUiStore.getState().traceRunId).toBe('r1')
  })
})
