/**
 * M88：右栏运行面板（Run Board）。
 * 覆盖：阶段条与判定依据、待批准动作条、决策计数、空态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentDefinition, Plan, SessionSummary } from '@multi-agent/shared'
import { RunBoard } from '../src/components/run/RunBoard'
import { useAgentStore } from '../src/stores/agent-store'
import { usePlanStore } from '../src/stores/plan-store'
import { useRunStore } from '../src/stores/run-store'
import { useSessionStore } from '../src/stores/session-store'

const NOW = '2026-06-01T08:00:00.000Z'
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

function makePlan(over: Partial<Plan> = {}): Plan {
  return {
    id: 'p1',
    sessionId: 's1',
    agentId: 'pm',
    title: '登录改造计划',
    goal: '交付可用的登录能力',
    steps: [
      {
        id: 's1',
        content: '设计接口与数据表',
        ownerAgentId: 'pm',
        mode: 'execute',
        acceptance: '评审通过',
        status: 'pending',
      },
      { id: 's2', content: '实现后端接口', ownerAgentId: 'backend', mode: 'execute', status: 'pending' },
    ],
    risks: ['依赖第三方 OAuth'],
    status: 'submitted',
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

function setSession(): SessionSummary {
  const summary = {
    id: 's1',
    title: 'T',
    participantIds: ['pm', 'backend'],
    role: 'owner',
  } as SessionSummary
  useSessionStore.setState({
    sessions: [summary],
    currentId: 's1',
    current: summary,
    byId: new Map(),
    order: [],
  })
  return summary
}

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  useAgentStore.setState({
    agents: [makeAgent('pm', '费利'), makeAgent('backend', '马克斯')],
    skills: [],
    loaded: true,
    loading: false,
    statuses: {},
  })
  useRunStore.setState({
    active: true,
    runId: 'r1',
    intent: {
      needsPlan: true,
      needsReview: true,
      risk: 'medium',
      confidence: 0.82,
      reasons: ['多环节交付', '需先拍板'],
      source: 'router',
    },
    planSuggestion: undefined,
    approvals: [],
  })
  usePlanStore.setState({ sessionId: 's1', plans: [], reviews: [], loading: false })
  setSession()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('M88：运行面板', () => {
  it('渲染阶段条 / 判定依据 / 计划步骤 / 待决策计数', async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url) === '/api/sessions/s1/plans') return jsonResponse({ plans: [makePlan()], reviews: [] })
      return jsonResponse({})
    })
    render(<RunBoard />)

    expect(await screen.findByText('登录改造计划')).toBeInTheDocument()
    expect(screen.getByText('运行')).toBeInTheDocument()
    // 阶段条（「待批准」同时出现在阶段条与状态徽章）
    expect(screen.getAllByText('待批准').length).toBeGreaterThan(0)
    expect(screen.getByText('执行')).toBeInTheDocument()
    // 判定依据（来源 + 理由 + 两道门）
    expect(screen.getByText(/平台判定/)).toBeInTheDocument()
    expect(screen.getByText(/多环节交付/)).toBeInTheDocument()
    expect(screen.getByText('规划门 开')).toBeInTheDocument()
    expect(screen.getByText('评审门 开')).toBeInTheDocument()
    // 步骤与负责人
    expect(screen.getByText('设计接口与数据表')).toBeInTheDocument()
    expect(screen.getByText('实现后端接口')).toBeInTheDocument()
    expect(screen.getAllByText('费利').length).toBeGreaterThan(0)
    expect(screen.getAllByText('马克斯').length).toBeGreaterThan(0)
    // 待决策（1 份待批准）
    expect(screen.getByText('1 项待决策')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /批准并执行/ })).toBeInTheDocument()
  })

  it('批准：调用 resolve 接口并更新计划状态', async () => {
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url) === '/api/sessions/s1/plans') return jsonResponse({ plans: [makePlan()], reviews: [] })
      if (String(url) === '/api/sessions/s1/plans/p1/resolve' && (init as RequestInit)?.method === 'POST') {
        return jsonResponse({ plan: makePlan({ status: 'approved', updatedAt: '2026-06-01T08:05:00.000Z' }), launched: null })
      }
      return jsonResponse({})
    })
    const user = userEvent.setup()
    render(<RunBoard />)
    await screen.findByText('登录改造计划')

    await user.click(screen.getByRole('button', { name: /批准并执行/ }))
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/sessions/s1/plans/p1/resolve')).toBe(true),
    )
    const call = fetchMock.mock.calls.find(([u]) => String(u) === '/api/sessions/s1/plans/p1/resolve')!
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ decision: 'approve', feedback: undefined })
  })

  it('空态：无计划时给出编排说明；运行期纠偏建议可见', async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url) === '/api/sessions/s1/plans') return jsonResponse({ plans: [], reviews: [] })
      return jsonResponse({})
    })
    useRunStore.setState({ planSuggestion: { writes: 4, agents: ['pm', 'backend'] } })
    render(<RunBoard />)

    expect(await screen.findByText('暂无进行中的计划')).toBeInTheDocument()
    expect(screen.getByText(/建议下一条消息先选「规划」/)).toBeInTheDocument()
  })
})
