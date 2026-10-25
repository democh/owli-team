/**
 * M86：接力控制（前端）。
 * - resolveRelayMode 推导（纯人聊天 / 单助手 = manual；零编制与多成员 = auto）；
 * - 消息菜单「派发下一棒」：列成员、把该消息 handoff 建议的目标置顶、点击调 dispatch；
 * - viewer 不显示派发入口。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentDefinition, ChatMessage, SessionSummary } from '@multi-agent/shared'
import { resolveRelayMode } from '@multi-agent/shared'
import { MessageActions } from '../src/components/chat/MessageActions'
import { useAgentStore } from '../src/stores/agent-store'
import { useRunStore } from '../src/stores/run-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'

const T0 = '2026-06-01T08:00:00.000Z'
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

const MESSAGE: ChatMessage = {
  id: 'm1',
  sessionId: 's1',
  role: 'agent',
  agentId: 'backend',
  memberKey: 'backend',
  content: '这块需要设计先出方案。',
  mentions: [],
  status: 'complete',
  createdAt: T0,
  toolCalls: [
    {
      id: 'c1',
      name: 'handoff',
      args: { target: 'architect', reason: '需要设计' },
      status: 'ok',
      summary: '已记录派发建议 @艾达',
      startedAt: T0,
    },
  ],
}

function setSession(role: SessionSummary['role'] = 'owner'): void {
  const summary = {
    id: 's1',
    title: 'T',
    participantIds: ['backend', 'architect'],
    role,
  } as SessionSummary
  useSessionStore.setState({
    // current 是对账投影（subscribe 会按 sessions 重算）：必须同时放进 sessions
    sessions: [summary],
    currentId: 's1',
    current: summary,
    byId: new Map([['m1', MESSAGE]]),
    order: ['m1'],
  })
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
  // 同一 Run：dispatch 走「只同步队列」分支，避免测试里挂接 SSE
  useRunStore.setState({ runId: 'r1', active: true, queue: ['backend'], approvals: [] })
  useUiStore.setState({})
  setSession()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('M86：resolveRelayMode 推导', () => {
  it('纯人聊天 / 单助手 = manual；零编制与多成员 = auto；显式值优先', () => {
    expect(resolveRelayMode({ participantIds: [], kind: 'group' })).toBe('manual')
    expect(resolveRelayMode({ participantIds: [], kind: 'direct' })).toBe('manual')
    expect(resolveRelayMode({ participantIds: ['backend'] })).toBe('manual')
    expect(resolveRelayMode({ participantIds: [] })).toBe('auto')
    expect(resolveRelayMode({ participantIds: ['backend', 'architect'] })).toBe('auto')
    expect(resolveRelayMode({ participantIds: ['backend'], relay: 'auto' })).toBe('auto')
    expect(resolveRelayMode({ participantIds: ['a', 'b'], relay: 'manual' })).toBe('manual')
  })
})

describe('M86：消息菜单派发下一棒', () => {
  it('展开成员列表，handoff 建议的目标置顶，点击调用 dispatch', async () => {
    const user = userEvent.setup()
    fetchMock.mockImplementation(async (url) => {
      if (String(url) === '/api/sessions/s1/dispatch') return jsonResponse({ runId: 'r1', queue: ['architect'], queued: false })
      return jsonResponse({})
    })
    render(<MessageActions messageId="m1" />)

    await user.click(screen.getByRole('button', { name: '消息操作' }))
    await user.click(screen.getByRole('menuitem', { name: /派发下一棒/ }))

    const memberItems = screen.getAllByRole('menuitem').filter((el) => /艾达|小北/.test(el.textContent ?? ''))
    expect(memberItems[0]?.textContent).toContain('艾达')
    expect(memberItems[0]?.textContent).toContain('建议')

    await user.click(screen.getByRole('menuitem', { name: /艾达 · 建议/ }))
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/sessions/s1/dispatch')).toBe(true),
    )
    const call = fetchMock.mock.calls.find(([url]) => String(url) === '/api/sessions/s1/dispatch')!
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ agentId: 'architect' })
    // 同一 Run：本地队列乐观对齐
    expect(useRunStore.getState().queue).toEqual(['architect'])
  })

  it('viewer：不渲染派发入口', async () => {
    setSession('viewer')
    const user = userEvent.setup()
    render(<MessageActions messageId="m1" />)
    await user.click(screen.getByRole('button', { name: '消息操作' }))
    expect(screen.queryByRole('menuitem', { name: /派发下一棒/ })).toBeNull()
  })
})
