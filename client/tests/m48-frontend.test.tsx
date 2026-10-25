/**
 * M48 前端测试：零调度官 —— 空编制创建 + 直接开聊（调度上收引擎）。
 *
 * 覆盖：
 * - 建会话组队台：场景 / 预设仅预选推荐编制（不再前置调度官）；自由组合 = 空编制；
 *   0 人提交「空编制创建 · 交给平台组队」→ participantIds: []（首条消息由平台路由组队）；
 * - souls 仅保留最终编制（取消勾选的成员不携带灵魂覆盖）；
 * - CommandPalette 新建会话 → 空编制 []（首条消息由平台路由组队）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentDefinition, AgentGroup, RosterPreset, SessionSummary } from '@multi-agent/shared'
import { CommandPalette } from '../src/components/layout/CommandPalette'
import { SessionList } from '../src/components/sessions/SessionList'
import { useAgentStore } from '../src/stores/agent-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'
import { useWsStore } from '../src/stores/ws-store'

// ---------- fixtures ----------

const T0 = '2026-06-01T08:00:00.000Z'

function makeAgent(overrides: Partial<AgentDefinition> & { id: string; name: string }): AgentDefinition {
  return {
    role: '角色',
    title: '',
    description: '',
    capabilities: [],
    group: 'development',
    avatar: { gradient: ['#3b82f6', '#f59e0b'], icon: 'user' },
    handoff: [],
    ...overrides,
  }
}

const PM = makeAgent({ id: 'pm', name: '费利', role: '产品经理', capabilities: ['需求分析'] })
const ARCHITECT = makeAgent({ id: 'architect', name: '艾达', role: '架构师', capabilities: ['系统设计'] })

const GROUPS: AgentGroup[] = [
  {
    id: 'development',
    name: '研发团队',
    description: '端到端接力完成研发任务',
    icon: 'users',
    theme: ['#3b82f6', '#60a5fa'],
    objective: '',
    chain: ['pm', 'architect'],
    defaultSkills: [],
    parallel: false,
    rounds: false,
    order: 2,
  },
]

const PRESET: RosterPreset = {
  id: 'launch',
  name: '产品发布',
  description: '需求到发布一条龙',
  icon: 'rocket',
  theme: ['#10b981', '#34d399'],
  members: ['pm', 'architect'],
  prompt: '帮我规划一次产品发布：',
  order: 1,
}

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id: 'sa', title: '会话A', participantIds: ['pm'], createdAt: T0, updatedAt: T0, messageCount: 0, ...overrides }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

/** 取一次 fetch 调用的 JSON body */
function bodyOf(call: [unknown, RequestInit?] | undefined): unknown {
  return JSON.parse(String(call?.[1]?.body ?? 'null'))
}

const fetchMock = vi.fn()

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/sessions') return jsonResponse({ sessions: [] })
    if (url.startsWith('/api/sessions/')) return jsonResponse({ messages: [], latestRun: null })
    return jsonResponse({})
  })
  useAgentStore.setState({
    agents: [PM, ARCHITECT],
    groups: GROUPS,
    presets: [PRESET],
    skills: [],
    loaded: true,
    loading: false,
    statuses: {},
  })
  useSessionStore.setState({
    sessions: [
      makeSession({ id: 's-dev', title: '研发局' }),
      makeSession({ id: 's-empty', title: '空编制' }),
    ],
    currentId: 'sa',
    byId: new Map(),
    order: [],
    latestRun: null,
    loadingSessions: false,
    loadingMessages: false,
    artifactVersion: 0,
  })
  useUiStore.setState({ commandOpen: false, pendingCreate: undefined })
  useWsStore.setState({ unread: {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 静默建会话 POST 的 mock（返回给定会话） */
function mockCreateSession(session: SessionSummary): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/sessions' && init?.method === 'POST') return jsonResponse({ session })
    if (url === '/api/sessions') return jsonResponse({ sessions: [session] })
    if (url.startsWith('/api/sessions/')) return jsonResponse({ messages: [], latestRun: null })
    return jsonResponse({})
  })
}

function lastSessionPost(): [string, RequestInit] | undefined {
  return fetchMock.mock.calls.find(
    ([u, i]) => String(u) === '/api/sessions' && (i as RequestInit)?.method === 'POST',
  ) as [string, RequestInit] | undefined
}

// ---------- 建会话组队台 ----------

describe('建会话组队台 · 空编制（M48）', () => {
  it('场景仅预选推荐编制（2 位）；取消一位后按用户选择提交（不回加）', async () => {
    mockCreateSession(makeSession({ id: 's-dev', title: '研发局', participantIds: ['pm'] }))
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<SessionList onSelect={onSelect} />)

    await user.click(screen.getByTitle('新建会话'))
    expect(screen.getByText('已选 0 位')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '组队来源：研发团队' }))
    expect(screen.getByText('已选 2 位')).toBeInTheDocument()
    for (const name of [/费利/, /艾达/]) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true')
    }

    await user.click(screen.getByRole('button', { name: /艾达/ }))
    expect(screen.getByText('已选 1 位')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /创建并进入（1 位成员）/ }))
    await waitFor(() => {
      const post = lastSessionPost()
      expect(post).toBeTruthy()
      expect(bodyOf(post)).toEqual({ participantIds: ['pm'] })
      expect(onSelect).toHaveBeenCalledWith('s-dev')
    })
  })

  it('0 人提交「空编制创建 · 交给平台组队」→ participantIds: []（首条消息由平台路由组队）', async () => {
    mockCreateSession(makeSession({ id: 's-empty', title: '空编制', participantIds: [] }))
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<SessionList onSelect={onSelect} />)

    await user.click(screen.getByTitle('新建会话'))
    await user.click(screen.getByText('自由组合'))
    expect(screen.getByText('已选 0 位')).toBeInTheDocument()
    expect(screen.getByText(/未选成员：首条消息将由平台自动组队并派发任务/)).toBeInTheDocument()
    const submit = screen.getByRole('button', { name: /空编制创建 · 交给平台组队/ })
    expect(submit).toBeEnabled()

    await user.click(submit)
    await waitFor(() => {
      const post = lastSessionPost()
      expect(post).toBeTruthy()
      expect(bodyOf(post)).toEqual({ participantIds: [] })
      expect(onSelect).toHaveBeenCalledWith('s-empty')
    })
  })

  it('快速组队预选预设成员（2 位）；全部取消除 = 0 人提交 []', async () => {
    mockCreateSession(makeSession({ id: 's-launch', title: '产品发布', participantIds: ['pm', 'architect'] }))
    const user = userEvent.setup()
    render(<SessionList onSelect={() => undefined} />)

    await user.click(screen.getByTitle('新建会话'))
    await user.click(screen.getByRole('button', { name: '任务预设' }))
    await user.click(screen.getByRole('button', { name: '组队来源：产品发布' }))
    expect(screen.getByText('快速组队 · 产品发布')).toBeInTheDocument()
    expect(screen.getByText('已选 2 位')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /费利/ }))
    await user.click(screen.getByRole('button', { name: /艾达/ }))
    expect(screen.getByText('已选 0 位')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /空编制创建 · 交给平台组队/ }))
    await waitFor(() => {
      const post = lastSessionPost()
      expect(post).toBeTruthy()
      expect(bodyOf(post)).toEqual({ participantIds: [] })
    })
  })

  it('souls 仅保留最终编制：取消含有灵魂覆盖的成员后不携带其覆盖', async () => {
    const LUNA = makeAgent({
      id: 'luna',
      name: '卢娜',
      role: '狂想发散者',
      souls: [
        { id: 'wild', name: '狂野', tagline: '脑洞没边', icon: 'flame', traits: ['话痨'], tone: '热情跳脱' },
        { id: 'zen', name: '禅意', tagline: '静水流深', icon: 'moon', traits: ['寡言'], tone: '慢而稳' },
      ],
      defaultSoul: 'wild',
    })
    useAgentStore.setState({ agents: [PM, LUNA] })
    mockCreateSession(makeSession({ id: 's-soul', title: '灵魂局', participantIds: ['pm'] }))
    const user = userEvent.setup()
    render(<SessionList onSelect={() => undefined} />)

    // 自由组合：选中卢娜 + 费利 → 给卢娜追加「禅意」人格（参与性格多选）→ 取消卢娜（souls 残留）
    await user.click(screen.getByTitle('新建会话'))
    await user.click(screen.getByText('自由组合'))
    await user.click(screen.getByRole('button', { name: /卢娜/ }))
    await user.click(screen.getByRole('button', { name: /费利/ }))
    await user.click(screen.getByRole('button', { name: '狂野' }))
    const soulMenu = screen.getByText('参与性格（可多选）').parentElement as HTMLElement
    await user.click(within(soulMenu).getByRole('button', { name: /^禅意/ }))
    await user.click(screen.getByRole('button', { name: /卢娜/ }))
    expect(screen.getByText('已选 1 位')).toBeInTheDocument()

    // 提交：souls 残留被剔除（不带 souls 键）
    await user.click(screen.getByRole('button', { name: /创建并进入（1 位成员）/ }))
    await waitFor(() => {
      const post = lastSessionPost()
      expect(post).toBeTruthy()
      expect(bodyOf(post)).toEqual({ participantIds: ['pm'] })
    })
  })
})

// ---------- CommandPalette ----------

describe('CommandPalette · 快捷新建（M48）', () => {
  it('新建会话 → 空编制 []（首条消息由平台路由组队）', async () => {
    mockCreateSession(makeSession({ id: 's-cmd', title: '空编制', participantIds: [] }))
    useUiStore.setState({ commandOpen: true })
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.click(screen.getByText('新建会话'))
    await waitFor(() => {
      const post = lastSessionPost()
      expect(post).toBeTruthy()
      expect(bodyOf(post)).toEqual({ participantIds: [] })
    })
    expect(useUiStore.getState().commandOpen).toBe(false)
  })
})
