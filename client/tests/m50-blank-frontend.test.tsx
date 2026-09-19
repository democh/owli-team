/**
 * M50 前端测试：空场景入口（组队台独立卡 + 场景列表过滤 + 命令面板同源）。
 *
 * 覆盖：
 * - 独立卡：「组队来源：空场景」置顶唯一（「按场景组队」列表过滤 blank 避免双入口）+「单 Agent · 1 位成员」；
 * - 点击 → 编制预选 1 位（通用助手）；提交 → participantIds: ['general']；
 * - 来源搜索：命中独立卡 / 不命中随列表隐藏 / 无命中空态；
 * - CommandPalette：含「新建会话：空场景」→ pendingCreate {scene, blank} → SessionList 消费后预选 1 位。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentDefinition, AgentGroup, SessionSummary } from '@multi-agent/shared'
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

const GENERAL = makeAgent({
  id: 'general',
  name: '通用助手',
  role: '通用助手',
  group: 'blank',
  capabilities: ['对话问答', '任务执行'],
})
const PM = makeAgent({ id: 'pm', name: '费利', role: '产品经理' })

const GROUPS: AgentGroup[] = [
  {
    id: 'blank',
    name: '空场景',
    description: '不引入任何角色，只与一个通用助手直聊——单 Agent 模式，独立完成各类任务',
    icon: 'message-circle',
    theme: ['#64748b', '#94a3b8'],
    objective: '由通用助手独立完成用户需求',
    chain: ['general'],
    defaultSkills: [],
    parallel: false,
    rounds: false,
    order: 1,
  },
  {
    id: 'development',
    name: '研发团队',
    description: '端到端接力完成研发任务',
    icon: 'users',
    theme: ['#3b82f6', '#60a5fa'],
    objective: '',
    chain: ['pm'],
    defaultSkills: [],
    parallel: false,
    rounds: false,
    order: 2,
  },
]

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id: 's-blank', title: '空场景', participantIds: ['general'], createdAt: T0, updatedAt: T0, messageCount: 0, ...overrides }
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
    agents: [GENERAL, PM],
    groups: GROUPS,
    presets: [],
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
    latestRun: undefined,
    loadingSessions: false,
    loadingMessages: false,
    artifactVersion: 0,
  })
  useUiStore.setState({ commandOpen: false, quietMode: false, pendingCreate: undefined, focusRequest: undefined, inviteOpen: false })
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
  return fetchMock.mock.calls.find(([u, i]) => String(u) === '/api/sessions' && (i as RequestInit)?.method === 'POST') as
    | [string, RequestInit]
    | undefined
}

/** 打开组队台（无来源） */
async function openBuilder(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  render(<SessionList onSelect={vi.fn()} />)
  await user.click(screen.getByTitle('新建会话'))
}

describe('空场景入口 · 组队台独立卡（M50）', () => {
  it('独立卡唯一（场景列表已过滤）+ 单 Agent 徽标；点击 → 编制预选 1 位', async () => {
    const user = userEvent.setup()
    await openBuilder(user)

    // 独立卡唯一 = 「按场景组队」列表不含空场景条目（否则同名 aria-label 会匹配到 2 个）
    const cards = screen.getAllByRole('button', { name: '组队来源：空场景' })
    expect(cards).toHaveLength(1)
    expect(screen.getByText('单 Agent · 1 位成员')).toBeInTheDocument()
    expect(screen.getByText('按场景组队')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '组队来源：研发团队' })).toBeInTheDocument()

    // 点击 → 来源选中 + 编制预选 [general]
    await user.click(cards[0])
    expect(screen.getByText('已选 1 位')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '移出编制' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: /通用助手/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('提交 → POST /sessions body participantIds: [general]', async () => {
    mockCreateSession(makeSession())
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<SessionList onSelect={onSelect} />)

    await user.click(screen.getByTitle('新建会话'))
    await user.click(screen.getByRole('button', { name: '组队来源：空场景' }))
    await user.click(screen.getByRole('button', { name: /创建并进入（1 位成员）/ }))
    await waitFor(() => {
      const post = lastSessionPost()
      expect(post).toBeTruthy()
      expect(bodyOf(post)).toEqual({ participantIds: ['general'] })
      expect(onSelect).toHaveBeenCalledWith('s-blank')
    })
  })

  it('来源搜索：命中独立卡 / 不命中随列表隐藏 / 无命中空态', async () => {
    const user = userEvent.setup()
    await openBuilder(user)
    const search = screen.getByPlaceholderText('搜索模板 / 场景…')

    // 命中：仅独立卡保留（场景列表无 blank 重复项）
    await user.type(search, '空场景')
    expect(screen.getAllByRole('button', { name: '组队来源：空场景' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: '组队来源：研发团队' })).toBeNull()

    // 不命中：独立卡随场景列表一并隐藏
    await user.clear(search)
    await user.type(search, '研发')
    expect(screen.queryByRole('button', { name: '组队来源：空场景' })).toBeNull()
    expect(screen.getByRole('button', { name: '组队来源：研发团队' })).toBeInTheDocument()

    // 无命中：空态文案
    await user.clear(search)
    await user.type(search, '不存在的来源')
    expect(screen.getByText('没有匹配的来源')).toBeInTheDocument()
  })
})

describe('空场景入口 · 命令面板（M50）', () => {
  it('含「新建会话：空场景」；点击 → pendingCreate {scene, blank}', async () => {
    useUiStore.setState({ commandOpen: true })
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.click(screen.getByText('新建会话：空场景'))
    expect(useUiStore.getState().pendingCreate).toMatchObject({ kind: 'scene', id: 'blank' })
    expect(useUiStore.getState().commandOpen).toBe(false)
  })

  it('pendingCreate 经 SessionList 消费 → 组队台同源预选 1 位', async () => {
    useUiStore.setState({ pendingCreate: { kind: 'scene', id: 'blank', nonce: 1 } })
    const user = userEvent.setup()
    render(<SessionList onSelect={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('已选 1 位')).toBeInTheDocument()
    })
    expect(useUiStore.getState().pendingCreate).toBeUndefined()
    expect(screen.getByRole('button', { name: '组队来源：空场景' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByRole('button', { name: '移出编制' })).toHaveLength(1)
    // 预选编制可微调：移出后回到 0 位（「已微调」显形）
    await user.click(screen.getAllByRole('button', { name: '移出编制' })[0])
    expect(screen.getByText('已选 0 位')).toBeInTheDocument()
  })
})
