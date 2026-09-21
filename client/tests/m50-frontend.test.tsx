/**
 * M50 前端测试：建会话「组队台」（三栏：来源 / 角色池 / 编制）。
 *
 * 覆盖：
 * - 来源搜索：按名称 / 描述过滤预设与场景，空组隐藏、空态与清空恢复；
 * - 来源切换 = 整体替换编制并清 souls（「已微调」提示随集合差异显隐）；
 * - 编制行：移出按钮（aria-label 不与池卡名二义）/ 清空编制（0 人提示回显）；
 * - 窄屏（matchMedia 命中）：三页签收敛为单面板 + 选来源自动切「编制」页。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentDefinition, AgentGroup, RosterPreset, SoulMeta } from '@multi-agent/shared'
import { SessionList } from '../src/components/sessions/SessionList'
import { useAgentStore } from '../src/stores/agent-store'
import { useAuthStore } from '../src/stores/auth-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'
import { useWsStore } from '../src/stores/ws-store'

// ---------- fixtures ----------

const WILD: SoulMeta = { id: 'wild', name: '狂野', tagline: '嘴上没门，脑洞没边', icon: 'flame', traits: ['话痨'], tone: '热情跳脱' }
const ZEN: SoulMeta = { id: 'zen', name: '禅意', tagline: '静水流深，以问代答', icon: 'moon', traits: ['寡言'], tone: '慢而稳' }

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

const PM = makeAgent({ id: 'pm', name: '费利', role: '产品经理', souls: [WILD, ZEN], defaultSoul: 'wild' })
const ARCHITECT = makeAgent({ id: 'architect', name: '艾达', role: '架构师' })

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
    order: 0,
  },
]

const PRESET: RosterPreset = {
  id: 'launch',
  name: '产品发布',
  description: '需求到发布一条龙',
  icon: 'rocket',
  theme: ['#10b981', '#34d399'],
  members: ['pm'],
  prompt: '',
  order: 1,
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
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

/** 临时替换 matchMedia 为窄屏命中（查询串含 1023）；返回恢复函数 */
function stubNarrowViewport(): () => void {
  const original = window.matchMedia
  window.matchMedia = ((query: string) => ({
    matches: query.includes('1023'),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  return () => {
    window.matchMedia = original
  }
}

/** 打开组队台（无来源） */
async function openBuilder(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  render(<SessionList onSelect={vi.fn()} />)
  await user.click(screen.getByTitle('新建会话'))
}

describe('建会话组队台 CreateSessionDialog（M50）', () => {
  it('来源搜索：按名称 / 描述过滤预设与场景，空组隐藏、空态与清空恢复', async () => {
    const user = userEvent.setup()
    await openBuilder(user)
    const search = screen.getByPlaceholderText('搜索模板 / 场景…')

    // 名称命中：仅保留研发团队（预设组整组隐藏）
    await user.type(search, '研发')
    expect(screen.getByRole('button', { name: '组队来源：研发团队' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '组队来源：产品发布' })).toBeNull()
    expect(screen.queryByText('快速组队')).toBeNull()

    // 描述命中：仅保留产品发布（需求到发布一条龙）
    await user.clear(search)
    await user.type(search, '一条龙')
    expect(screen.getByRole('button', { name: '组队来源：产品发布' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '组队来源：研发团队' })).toBeNull()
    expect(screen.queryByText('按场景组队')).toBeNull()

    // 无命中：空态文案
    await user.clear(search)
    await user.type(search, '不存在的来源')
    expect(screen.getByText('没有匹配的来源')).toBeInTheDocument()

    // 清空搜索：恢复全部来源
    await user.click(screen.getByTitle('清空来源搜索'))
    expect(screen.getByRole('button', { name: '组队来源：研发团队' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '组队来源：产品发布' })).toBeInTheDocument()
  })

  it('来源切换：整体替换编制并清 souls；「已微调」随集合差异显隐', async () => {
    const user = userEvent.setup()
    await openBuilder(user)

    // 选场景 → chain 2 位；移出艾达 → 已微调显形
    await user.click(screen.getByRole('button', { name: '组队来源：研发团队' }))
    expect(screen.getByText('已选 2 位')).toBeInTheDocument()
    expect(screen.queryByText('已微调')).toBeNull()
    await user.click(screen.getByRole('button', { name: /艾达/ }))
    expect(screen.getByText('已选 1 位')).toBeInTheDocument()
    expect(screen.getByText('已微调')).toBeInTheDocument()

    // 编制行给费利设灵魂覆盖（狂野 → 禅意）：多选面板先勾禅意、再取消狂野（回到单人格禅意）
    await user.click(screen.getByRole('button', { name: '狂野' }))
    const soulMenu = screen.getByText('参与性格（可多选）').parentElement as HTMLElement
    await user.click(within(soulMenu).getByRole('button', { name: /^禅意/ }))
    await user.click(within(soulMenu).getByRole('button', { name: /^狂野/ }))
    expect(screen.getByRole('button', { name: '禅意' })).toBeInTheDocument()

    // 重选同一来源 → 整体替换：souls 清空（恢复默认狂野）、已微调消失
    await user.click(screen.getByRole('button', { name: '组队来源：研发团队' }))
    expect(screen.getByText('已选 2 位')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '禅意' })).toBeNull()
    expect(screen.getByRole('button', { name: '狂野' })).toBeInTheDocument()
    expect(screen.queryByText('已微调')).toBeNull()

    // 切预设 → 编制收缩为 1 位（整体替换，不保留追加成员）
    await user.click(screen.getByRole('button', { name: '组队来源：产品发布' }))
    expect(screen.getByText('已选 1 位')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /艾达/ })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByText('已微调')).toBeNull()
  })

  it('编制行移出：aria-label「移出编制」不与池卡名二义', async () => {
    const user = userEvent.setup()
    await openBuilder(user)
    await user.click(screen.getByRole('button', { name: '组队来源：研发团队' }))

    const removes = screen.getAllByRole('button', { name: '移出编制' })
    expect(removes).toHaveLength(2)
    // 移出首位（费利）：计数回落，池卡回可再选态
    await user.click(removes[0])
    expect(screen.getByText('已选 1 位')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '移出编制' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: /费利/ })).toHaveAttribute('aria-pressed', 'false')
  })

  it('清空编制：来源保留（已微调）+ 0 人提示回显', async () => {
    const user = userEvent.setup()
    await openBuilder(user)
    await user.click(screen.getByRole('button', { name: '组队来源：研发团队' }))
    expect(screen.getByText('已选 2 位')).toBeInTheDocument()

    await user.click(screen.getByTitle('清空编制'))
    expect(screen.getByText('已选 0 位')).toBeInTheDocument()
    expect(screen.getByText(/未选成员：首条消息将由平台自动组队并派发任务/)).toBeInTheDocument()
    expect(screen.queryByTitle('清空编制')).toBeNull()
    expect(screen.getByText('已微调')).toBeInTheDocument()
  })

  it('窄屏：三页签收敛单面板；选来源自动切「编制」页', async () => {
    const restore = stubNarrowViewport()
    try {
      const user = userEvent.setup()
      render(<SessionList onSelect={vi.fn()} />)
      await user.click(screen.getByTitle('新建会话'))

      // 初始「来源」页：角色池 / 编制面板未挂载
      expect(screen.getByRole('tab', { name: '来源' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByPlaceholderText('搜索模板 / 场景…')).toBeInTheDocument()
      expect(screen.queryByPlaceholderText('搜索角色 / 能力…')).toBeNull()
      expect(screen.queryByPlaceholderText('会话标题（可选，默认自动生成）')).toBeNull()

      // 切「角色池」页
      await user.click(screen.getByRole('tab', { name: '角色池' }))
      expect(screen.getByPlaceholderText('搜索角色 / 能力…')).toBeInTheDocument()
      expect(screen.queryByPlaceholderText('搜索模板 / 场景…')).toBeNull()

      // 回「来源」选场景 → 自动切「编制」页（标题输入与创建按钮就位）
      await user.click(screen.getByRole('tab', { name: '来源' }))
      await user.click(screen.getByRole('button', { name: '组队来源：研发团队' }))
      expect(screen.getByRole('tab', { name: '编制' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByText('已选 2 位')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('会话标题（可选，默认自动生成）')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /创建并进入（2 位成员）/ })).toBeInTheDocument()
    } finally {
      restore()
    }
  })
})

describe('M79-O：新建会话「协作成员（真人）」一步邀请', () => {
  interface Call { url: string; method: string; body?: unknown }
  function stubSocialFetch(calls: Call[]): void {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url === '/api/friends') return jsonResponse({ friends: [{ userId: 'u_dave', username: 'dave', displayName: 'Dave', online: true }] })
      if (url === '/api/friends/requests') return jsonResponse({ incoming: [], outgoing: [] })
      if (url === '/api/sessions' && method === 'POST') {
        return jsonResponse({ session: { id: 's_new', title: '新会话', participantIds: [], kind: 'team', createdAt: '', updatedAt: '', messageCount: 0 } })
      }
      if (url === '/api/sessions') return jsonResponse({ sessions: [] })
      if (url === '/api/sessions/s_new' && method === 'PATCH') {
        return jsonResponse({ session: { id: 's_new', title: '新会话', participantIds: [], routeMode: 'mention', createdAt: '', updatedAt: '', messageCount: 0 } })
      }
      if (url === '/api/sessions/s_new/shares' && method === 'POST') {
        return jsonResponse({ owner: { userId: 'u_me', username: 'me', displayName: 'Me' }, members: [{ userId: 'u_dave', username: 'dave', displayName: 'Dave', role: 'editor', createdAt: '' }] })
      }
      if (url.startsWith('/api/sessions/')) return jsonResponse({ messages: [], latestRun: null })
      return jsonResponse({})
    })
  }

  beforeEach(() => {
    useAuthStore.setState({
      phase: 'ready',
      user: { id: 'u_me', username: 'me', displayName: 'Me', role: 'member' },
      isAdmin: false,
      status: { needsSetup: false, authRequired: true, multiUser: true },
    })
  })

  it('好友多选 → 创建后自动邀请（editor）；纯真人组合自动置「仅点名唤起」防误触发', async () => {
    const calls: Call[] = []
    stubSocialFetch(calls)
    const user = userEvent.setup()
    await openBuilder(user)

    await user.click(await screen.findByTitle('邀请 Dave 加入'))
    expect(screen.getByText('已选 1 位')).toBeInTheDocument()
    expect(screen.getByText(/将自动设为「仅点名唤起」/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /创建并进入（1 位成员）/ }))
    await waitFor(() => {
      const share = calls.find((c) => c.url === '/api/sessions/s_new/shares' && c.method === 'POST')
      expect(share?.body).toEqual({ username: 'dave', role: 'editor' })
      const patch = calls.find((c) => c.url === '/api/sessions/s_new' && c.method === 'PATCH')
      expect(patch?.body).toEqual({ routeMode: 'mention' })
      const post = calls.find((c) => c.url === '/api/sessions' && c.method === 'POST')
      expect((post?.body as { participantIds: string[] }).participantIds).toEqual([])
    })
  })

  it('有 agent 编制（场景来源）：仅邀请好友，不做 mention 覆盖', async () => {
    const calls: Call[] = []
    stubSocialFetch(calls)
    const user = userEvent.setup()
    await openBuilder(user)

    await user.click(screen.getByRole('button', { name: '组队来源：研发团队' }))
    await user.click(await screen.findByTitle('邀请 Dave 加入'))
    await user.click(screen.getByRole('button', { name: /创建并进入（3 位成员）/ }))
    await waitFor(() => {
      expect(calls.find((c) => c.url === '/api/sessions/s_new/shares' && c.method === 'POST')?.body).toEqual({ username: 'dave', role: 'editor' })
      expect(calls.find((c) => c.url === '/api/sessions/s_new' && c.method === 'PATCH')).toBeUndefined()
    })
  })
})
