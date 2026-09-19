/**
 * M14：指挥台排队区（RelayQueue）—— 渲染棒次序号 / 下一棒高亮 / 首尾按钮禁用；
 * 点击 ↑↓ 走乐观更新 + POST /runs/:runId/queue，失败回滚。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentDefinition } from '@multi-agent/shared'
import { RelayQueue } from '../src/components/team/TeamPanel'
import { useAgentStore } from '../src/stores/agent-store'
import { useRunStore } from '../src/stores/run-store'

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

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  useAgentStore.setState({
    agents: [makeAgent('backend', '小北'), makeAgent('qa', '诺娃'), makeAgent('devops', '奥托')],
    skills: [],
    loaded: true,
    loading: false,
    statuses: {},
  })
  useRunStore.setState({ runId: 'r1', sessionId: 's1', active: true, queue: ['backend', 'qa', 'devops'] })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('RelayQueue 指挥台排队（M14）', () => {
  it('渲染棒次：下一棒高亮、首尾按钮禁用', () => {
    render(<RelayQueue />)
    expect(screen.getByTitle('下一棒：小北')).toBeTruthy()
    expect(screen.getByTitle('诺娃（第 2 棒）')).toBeTruthy()
    expect(screen.getByTitle('小北 提前一位')).toBeDisabled()
    expect(screen.getByTitle('诺娃 提前一位')).toBeEnabled()
    expect(screen.getByTitle('小北 延后一位')).toBeEnabled()
    expect(screen.getByTitle('奥托 延后一位')).toBeDisabled()
  })

  it('点击「延后一位」：乐观更新 + POST 全量顺序（qa 提前一位场景）', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { agentIds: string[] }
      return jsonResponse({ queue: body.agentIds })
    })
    const user = userEvent.setup()
    render(<RelayQueue />)

    await user.click(screen.getByTitle('诺娃 提前一位'))

    await waitFor(() => {
      expect(useRunStore.getState().queue).toEqual(['qa', 'backend', 'devops'])
      const post = fetchMock.mock.calls.find(([u]) => String(u) === '/api/runs/r1/queue')
      expect(post).toBeTruthy()
      expect(JSON.parse(String((post?.[1] as RequestInit).body)).agentIds).toEqual(['qa', 'backend', 'devops'])
    })
  })

  it('服务端拒绝（运行已结束）→ 回滚原顺序', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: '运行不存在或已结束' }, 400))
    const user = userEvent.setup()
    render(<RelayQueue />)

    await user.click(screen.getByTitle('小北 延后一位'))

    await waitFor(() => {
      expect(useRunStore.getState().queue).toEqual(['backend', 'qa', 'devops'])
    })
  })

  it('非运行中不渲染（active=false）', () => {
    useRunStore.setState({ active: false })
    const { container } = render(<RelayQueue />)
    expect(container.innerHTML).toBe('')
  })
})
