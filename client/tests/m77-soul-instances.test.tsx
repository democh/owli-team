/**
 * M77 同角多魂 / 成员分身（前端）：
 * - lib/members：成员实例解析（标签 / 有效灵魂 / 参与性格编解码）；
 * - 建会话组队台：参与性格多选 → 多分身入编（成员键编码）与单人格覆盖（souls）payload；
 * - TeamPanel 成员卡：分身各自成卡（标签 + 「分身」标注）、换装与移除走成员键；
 * - MessageItem：分身作者标签 + 点名 chips（成员键解析）；
 * - Composer：成员条与 @ 候选按实例渲染，插入点名 token（`@名字·灵魂名`）；
 * - run-store：turn 事件 memberKey 归口（消息 / 状态）；
 * - lib/graph：成员键节点与接力边（分身独立节点）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentDefinition, AgentGroup, ChatMessage, SessionSummary, SoulMeta } from '@multi-agent/shared'
import { MessageItem } from '../src/components/chat/MessageItem'
import { Composer } from '../src/components/chat/Composer'
import { MessageActions } from '../src/components/chat/MessageActions'
import { CanvasComposer } from '../src/components/canvas/CanvasComposer'
import { WaveGroup } from '../src/components/chat/WaveGroup'
import { WaveStrip } from '../src/components/chat/WaveStrip'
import { AgentPicker } from '../src/components/agents/AgentPicker'
import { TooltipProvider } from '../src/components/ui/tooltip'
import { SessionList } from '../src/components/sessions/SessionList'
import { TeamPanel } from '../src/components/team/TeamPanel'
import {
  encodeParticipation,
  labelOfMemberKey,
  memberDisplayList,
  memberViews,
  participationOf,
  soulIdOf,
} from '../src/lib/members'
import { buildGraph } from '../src/lib/graph'
import { commentDraft } from '../src/lib/focus-artifact'
import { computeStats } from '../src/components/team/StatsView'
import { useAgentStore } from '../src/stores/agent-store'
import { handleRunEvent, useRunStore } from '../src/stores/run-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'

const T0 = '2026-06-01T08:00:00.000Z'

const WILD: SoulMeta = { id: 'wild', name: '狂野', tagline: '嘴上没门，脑洞没边', icon: 'flame', traits: ['话痨'], tone: '热情跳脱' }
const ZEN: SoulMeta = { id: 'zen', name: '禅意', tagline: '静水流深，以问代答', icon: 'moon', traits: ['寡言'], tone: '慢而稳' }
const SCHOLAR: SoulMeta = { id: 'scholar', name: '考据派', tagline: '凡有断言，必有出处', icon: 'book-open', traits: ['严谨'], tone: '引经据典' }

function makeAgent(overrides: Partial<AgentDefinition> & { id: string; name: string }): AgentDefinition {
  return {
    role: '角色',
    title: '',
    description: '',
    capabilities: [],
    group: 'brainstorm',
    avatar: { gradient: ['#3b82f6', '#f59e0b'], icon: 'user' },
    handoff: [],
    ...overrides,
  }
}

const LUNA = makeAgent({ id: 'luna', name: '卢娜', role: '狂想发散者', souls: [WILD, ZEN, SCHOLAR], defaultSoul: 'wild' })
const PM = makeAgent({ id: 'pm', name: '费利', role: '产品经理', group: 'development' })

const GROUPS: AgentGroup[] = [
  {
    id: 'brainstorm',
    name: '头脑风暴',
    description: '创意发散与点子打磨',
    icon: 'lightbulb',
    theme: ['#f59e0b', '#fbbf24'],
    objective: '',
    chain: ['luna'],
    defaultSkills: [],
    parallel: true,
    rounds: true,
    order: 0,
  },
  {
    id: 'development',
    name: '研发团队',
    description: '端到端接力',
    icon: 'users',
    theme: ['#3b82f6', '#60a5fa'],
    objective: '',
    chain: ['pm'],
    defaultSkills: [],
    parallel: false,
    rounds: false,
    order: 1,
  },
]

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id: 'sa', title: '多魂会话', participantIds: ['luna', 'luna~zen', 'pm'], createdAt: T0, updatedAt: T0, messageCount: 0, ...overrides }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function agentMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    sessionId: 'sa',
    runId: 'r1',
    turnIndex: 0,
    role: 'agent',
    agentId: 'luna',
    content: '禅意点子一枚。',
    mentions: [],
    status: 'complete',
    createdAt: T0,
    ...overrides,
  }
}

const fetchMock = vi.fn()

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/sessions') return jsonResponse({ sessions: [makeSession()] })
    if (url.endsWith('/artifacts')) return jsonResponse({ artifacts: [] })
    if (url.startsWith('/api/sessions/')) return jsonResponse({ messages: [], latestRun: null })
    return jsonResponse({})
  })
  useAgentStore.setState({
    agents: [LUNA, PM],
    groups: GROUPS,
    skills: [],
    loaded: true,
    loading: false,
    statuses: {},
  })
  useSessionStore.setState({
    sessions: [makeSession()],
    currentId: 'sa',
    byId: new Map(),
    order: [],
    latestRun: null,
    loadingSessions: false,
    loadingMessages: false,
    artifactVersion: 0,
  })
  useRunStore.setState({
    active: false,
    runId: undefined,
    sessionId: undefined,
    queued: false,
    queue: [],
    currentWave: [],
    lastEndReason: undefined,
    approvals: [],
    compressionCount: 0,
  })
  useUiStore.setState({ commandOpen: false, quietMode: false, rightView: 'members', inviteOpen: false })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------- lib/members 纯函数 ----------

describe('M77：成员实例解析（lib/members）', () => {
  it('memberViews：多实例标签 = 名字·灵魂名；单实例保持角色名；pinned 标记', () => {
    const multi = makeSession()
    const views = memberViews([LUNA, PM], multi)
    expect(views.map((m) => m.key)).toEqual(['luna', 'luna~zen', 'pm'])
    expect(views.map((m) => m.label)).toEqual(['卢娜·狂野', '卢娜·禅意', '费利'])
    expect(views.map((m) => m.soul?.id)).toEqual(['wild', 'zen', undefined])
    expect(views.map((m) => m.pinned)).toEqual([false, true, false])

    const single = makeSession({ participantIds: ['luna'], memberSouls: { luna: 'zen' } })
    const one = memberViews([LUNA, PM], single)
    expect(one[0].label).toBe('卢娜')
    expect(one[0].soul?.id).toBe('zen')
    expect(soulIdOf(LUNA, 'luna~scholar')).toBe('scholar')
  })

  it('encodeParticipation / participationOf：默认灵魂走经典键（免覆盖）；非默认首人格写覆盖；其余为分身键', () => {
    expect(encodeParticipation(LUNA, [])).toEqual({ keys: ['luna'], soulOverrides: {} })
    expect(encodeParticipation(LUNA, ['wild'])).toEqual({ keys: ['luna'], soulOverrides: {} })
    expect(encodeParticipation(LUNA, ['zen'])).toEqual({ keys: ['luna'], soulOverrides: { luna: 'zen' } })
    // 排序按角色 souls 声明序（wild → zen → scholar），稳定可断言
    expect(encodeParticipation(LUNA, ['zen', 'wild'])).toEqual({ keys: ['luna', 'luna~zen'], soulOverrides: {} })
    expect(encodeParticipation(LUNA, ['scholar', 'zen'])).toEqual({
      keys: ['luna', 'luna~scholar'],
      soulOverrides: { luna: 'zen' },
    })
    expect(participationOf(LUNA, ['luna', 'luna~zen'], {})).toEqual(['wild', 'zen'])
    expect(participationOf(LUNA, ['luna'], { luna: 'scholar' })).toEqual(['scholar'])
  })

  it('labelOfMemberKey 自描述回退：已移除 / 已换键的实例仍还原 `名字·灵魂名`；经典键不补后缀', () => {
    // 在场实例：走成员视图标签
    expect(labelOfMemberKey([LUNA, PM], makeSession(), 'luna~zen')).toBe('卢娜·禅意')
    // 已移除 / 未在场：键内嵌灵魂自描述还原（历史消息、交接署名不丢）
    const withoutInstance = makeSession({ participantIds: ['pm'] })
    expect(labelOfMemberKey([LUNA, PM], withoutInstance, 'luna~zen')).toBe('卢娜·禅意')
    expect(labelOfMemberKey([LUNA, PM], undefined, 'luna~scholar')).toBe('卢娜·考据派')
    // 经典键（无内嵌灵魂）不补默认灵魂后缀
    expect(labelOfMemberKey([LUNA, PM], withoutInstance, 'luna')).toBe('卢娜')
    // 灵魂资产已删 / 未知键的回退
    expect(labelOfMemberKey([LUNA, PM], undefined, 'luna~ghost')).toBe('卢娜')
    expect(labelOfMemberKey([LUNA, PM], undefined, 'ghost~x')).toBe('ghost~x')
  })

  it('memberDisplayList 幽灵补位：已离场的引用键补成可读条目，重复与未知角色跳过', () => {
    const list = memberDisplayList([LUNA, PM], makeSession(), ['luna~zen', 'qa~strict'])
    expect(list.map((m) => m.id)).toEqual(['luna', 'luna~zen', 'pm'])
    expect(list.map((m) => m.name)).toEqual(['卢娜·狂野', '卢娜·禅意', '费利'])
    const ghost = memberDisplayList([LUNA, PM], makeSession({ participantIds: ['pm'] }), ['luna~zen'])
    expect(ghost.map((m) => m.id)).toEqual(['pm', 'luna~zen'])
    expect(ghost[1].name).toBe('卢娜·禅意')
  })
})

// ---------- 建会话组队台 ----------

describe('M77：组队台参与性格多选（建会话）', () => {
  it('勾选两个人格 → 编制 = 分身同台；提交 payload = 成员键数组（分身灵魂内嵌，不带 souls）', async () => {
    const posted: unknown[] = []
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/sessions' && init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)))
        return jsonResponse({ session: makeSession({ id: 's-new', participantIds: ['luna', 'luna~zen'] }) }, 201)
      }
      if (url === '/api/sessions') return jsonResponse({ sessions: [makeSession()] })
      return jsonResponse({})
    })
    const user = userEvent.setup()
    render(<SessionList onSelect={() => undefined} />)

    await user.click(screen.getByTitle('新建会话'))
    await user.click(screen.getByText('自由组合'))
    await user.click(screen.getByRole('button', { name: /卢娜/ }))
    // 打开「参与性格」多选面板：默认已选狂野（角色默认）
    await user.click(screen.getByRole('button', { name: '狂野' }))
    const menu = screen.getByText('参与性格（可多选）').parentElement as HTMLElement
    await user.click(within(menu).getByRole('button', { name: /^禅意/ }))
    // 编制行标注分身同台；触发钮文案 = 狂野+禅意
    expect(screen.getByText('×2 分身同台')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '狂野+禅意' })).toBeInTheDocument()
    expect(screen.getByText('已选 2 位')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /创建并进入/ }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toEqual({ participantIds: ['luna', 'luna~zen'], title: undefined, souls: undefined })
  })
})

// ---------- 会话内成员卡 ----------

describe('M77：成员卡（分身各自成卡；换装 / 移除走成员键）', () => {
  it('双卡标签、分身标注；分身换装 PATCH 成员键；移除 DELETE 成员键', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.startsWith('/api/sessions/sa/members/luna~')) {
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
        if (method === 'DELETE') {
          return jsonResponse({
            session: makeSession({ participantIds: ['luna', 'pm'] }),
            message: { id: 'ev9', sessionId: 'sa', role: 'system', agentId: 'luna', content: '卢娜·禅意 离开了协作', mentions: [], status: 'complete', createdAt: T0 },
          })
        }
        return jsonResponse({
          session: makeSession({ participantIds: ['luna', 'luna~scholar', 'pm'] }),
          message: { id: 'ev8', sessionId: 'sa', role: 'system', agentId: 'luna', content: '卢娜·禅意 换上了『考据派』灵魂', mentions: [], status: 'complete', createdAt: T0 },
        })
      }
      if (url.endsWith('/artifacts')) return jsonResponse({ artifacts: [] })
      return jsonResponse({})
    })
    const user = userEvent.setup()
    render(<TeamPanel />)

    // 双卡（标签带灵魂名）；分身卡有「分身」标注
    const wildCard = screen.getByTitle('查看 卢娜·狂野 的档案')
    const zenCard = screen.getByTitle('查看 卢娜·禅意 的档案')
    expect(within(wildCard).queryByText('卢娜·狂野')).not.toBeNull()
    expect(within(zenCard).getByText('分身')).toBeInTheDocument()

    // 分身换装：禅意 → 考据派（PATCH /members/luna~zen）；换装后键替换 → 卡片标签变为卢娜·考据派
    await user.click(within(zenCard).getByRole('button', { name: '禅意' }))
    await user.click(screen.getByRole('button', { name: /^考据派/ }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true))
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.url).toBe('/api/sessions/sa/members/luna~zen')
    expect(patch.body).toEqual({ soul: 'scholar' })

    // 移出分身：换装后重新取卡（键已替换），移除走 DELETE 成员键
    const renewed = screen.getByTitle('查看 卢娜·考据派 的档案')
    await user.click(within(renewed).getByRole('button', { name: /移出 卢娜·考据派/ }))
    await user.click(within(renewed).getByRole('button', { name: '确认移出' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true))
    expect(calls.find((c) => c.method === 'DELETE')!.url).toBe('/api/sessions/sa/members/luna~scholar')
  })
})

// ---------- 消息气泡 ----------

describe('M77：消息气泡（作者标签与点名 chips）', () => {
  it('分身作者显示「卢娜·禅意」；用户点名 chip 解析成员键（经典实例 = 卢娜·狂野）', () => {
    const reply = agentMsg({ id: 'm1', memberKey: 'luna~zen', mentions: [] })
    const userMsg: ChatMessage = {
      id: 'm0',
      sessionId: 'sa',
      role: 'user',
      content: '@卢娜 你俩都说说',
      mentions: ['luna', 'luna~zen'],
      status: 'complete',
      turnIndex: -1,
      createdAt: T0,
    }
    useSessionStore.setState({
      byId: new Map([
        [reply.id, reply],
        [userMsg.id, userMsg],
      ]),
      order: [reply.id, userMsg.id],
    })
    render(<MessageItem messageId={reply.id} />)
    render(<MessageItem messageId={userMsg.id} />)
    // 作者标签：分身 = 卢娜·禅意（同文本也出现在点名 chip，故用 getAllByText）
    expect(screen.getAllByText('卢娜·禅意').length).toBeGreaterThan(0)
    // 点名 chips：成员键 → 实例标签（同一用户消息内两个实例）
    const chipRow = screen.getByText('点名').parentElement as HTMLElement
    expect(within(chipRow).getByText('卢娜·狂野')).toBeInTheDocument()
    expect(within(chipRow).getByText('卢娜·禅意')).toBeInTheDocument()
  })

  it('单实例会话保持现状（作者 = 角色名，无后缀）', () => {
    useSessionStore.setState({
      sessions: [makeSession({ participantIds: ['luna'], memberSouls: { luna: 'zen' } })],
    })
    const message = agentMsg({ memberKey: 'luna', mentions: [] })
    useSessionStore.setState({ byId: new Map([[message.id, message]]), order: [message.id] })
    render(<MessageItem messageId={message.id} />)
    expect(screen.getByText('卢娜')).toBeInTheDocument()
    expect(screen.queryByText('卢娜·禅意')).toBeNull()
  })
})

// ---------- Composer 成员条与 @ 候选 ----------

describe('M77：Composer（成员条与 @ 候选按实例）', () => {
  it('成员条展示两个分身；点击插入点名 token；@ 候选含实例标签', async () => {
    const user = userEvent.setup()
    render(<Composer />)
    const box = screen.getByRole('textbox')

    // 成员条：两个分身各自一条（标签 = 名字·灵魂名）
    expect(screen.getByTitle(/召唤 卢娜·狂野/)).toBeInTheDocument()
    expect(screen.getByTitle(/召唤 卢娜·禅意/)).toBeInTheDocument()

    // 点击分身 chip → 插入 @卢娜·禅意（点名具体分身）
    await user.click(screen.getByTitle(/召唤 卢娜·禅意/))
    expect(box).toHaveValue('@卢娜·禅意 ')

    // @ 候选也按实例列出
    await user.type(box, '@')
    const menu = screen.getByRole('listbox')
    expect(menu.textContent).toContain('卢娜·狂野')
    expect(menu.textContent).toContain('卢娜·禅意')
  })

  it('@ 候选含「全部 2 位」显式全伞条目：一键插入两个实例 token（裸名 = 主实例）', async () => {
    const user = userEvent.setup()
    render(<Composer />)
    const box = screen.getByRole('textbox')

    await user.type(box, '@')
    const menu = screen.getByRole('listbox')
    expect(menu.textContent).toContain('卢娜（全部 2 位）')
    await user.click(within(menu).getByRole('button', { name: /卢娜（全部 2 位）/ }))
    // 逐一点名：两个实例 token（服务端裸名只召集主实例，全伞须显式）
    expect(box).toHaveValue('@卢娜·狂野 @卢娜·禅意 ')
  })
})

// ---------- run-store 归口 ----------

describe('M77：run-store memberKey 归口', () => {
  it('turn:start 写入消息 memberKey 与实例状态；turn:end 按实例收尾', () => {
    useRunStore.setState({ runId: 'r1', sessionId: 'sa', active: true })
    handleRunEvent({
      type: 'turn:start',
      runId: 'r1',
      agentId: 'luna',
      memberKey: 'luna~zen',
      messageId: 'mx',
      turnIndex: 0,
    })
    const msg = useSessionStore.getState().byId.get('mx')
    expect(msg?.agentId).toBe('luna')
    expect(msg?.memberKey).toBe('luna~zen')
    expect(useAgentStore.getState().statuses['luna~zen']).toBe('speaking')

    handleRunEvent({ type: 'turn:end', messageId: 'mx', agentId: 'luna', memberKey: 'luna~zen', mentions: ['user'], queue: [], status: 'complete' })
    expect(useAgentStore.getState().statuses['luna~zen']).toBe('idle')
  })
})

// ---------- 图谱（纯函数） ----------

describe('M77：图谱节点与接力边（成员键）', () => {
  it('分身独立成节点；接力边 from = 说话成员键', () => {
    const participants = memberViews([LUNA, PM], makeSession()).map((m) => ({ ...m.agent, id: m.key, name: m.label }))
    const model = buildGraph(
      [agentMsg({ memberKey: 'luna~zen', mentions: ['luna'] })],
      participants,
      GROUPS,
    )
    expect(model.nodes.map((n) => n.id)).toEqual(['luna', 'luna~zen', 'pm'])
    expect(model.nodes.find((n) => n.id === 'luna~zen')?.data.agent.name).toBe('卢娜·禅意')
    expect(model.edges.some((e) => e.kind === 'relay' && e.source === 'luna~zen' && e.target === 'luna')).toBe(true)
  })
})

// ---------- AgentPicker 分身菜单 ----------

describe('M77：AgentPicker「+ 分身」菜单（成员键值域）', () => {
  it('菜单仅列出未占用灵魂（狂野已占用被排除）；点击追加 → onChange 携带成员键', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<AgentPicker value={['luna']} onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: '追加分身' }))
    const menu = screen.getByText('以其他性格入编').parentElement as HTMLElement
    // 狂野（默认，经典实例已占用）不在菜单；禅意 / 考据派可选
    expect(within(menu).queryByText('狂野')).toBeNull()
    await user.click(within(menu).getByRole('button', { name: /^禅意/ }))
    expect(onChange).toHaveBeenCalledWith(['luna', 'luna~zen'])
  })

  it('同角已双分身：卡片标注「同角 2 位」，菜单仅剩未占用人格', async () => {
    render(<AgentPicker value={['luna', 'luna~zen']} onChange={() => undefined} />)
    const card = screen.getByRole('button', { name: /卢娜/ })
    expect(within(card).getByText('同角 2 位')).toBeInTheDocument()

    await userEvent.setup().click(within(card).getByRole('button', { name: '追加分身' }))
    const menu = screen.getByText('以其他性格入编').parentElement as HTMLElement
    expect(within(menu).getByText('考据派')).toBeInTheDocument()
    expect(within(menu).queryByText('禅意')).toBeNull()
    expect(within(menu).queryByText('狂野')).toBeNull()
  })
})

// ---------- 战绩实例归口（computeStats） ----------

describe('M77：战绩按成员实例归口（computeStats）', () => {
  it('分身各自计数（发言 / 交付 / 交接 / 被 cue）；存量消息缺省按 agentId', () => {
    const participants = [
      { ...LUNA, id: 'luna', name: '卢娜·狂野' },
      { ...LUNA, id: 'luna~zen', name: '卢娜·禅意' },
      { ...PM, id: 'pm', name: '费利' },
    ]
    const messages: ChatMessage[] = [
      agentMsg({ id: 's1', agentId: 'luna', memberKey: 'luna', mentions: ['luna~zen'], artifacts: ['docs/a.md'] }),
      agentMsg({ id: 's2', agentId: 'luna', memberKey: 'luna~zen', mentions: ['user'] }),
      { id: 'u1', sessionId: 'sa', role: 'user', content: '@卢娜·禅意 补充一下', mentions: ['luna~zen'], status: 'complete', createdAt: T0 },
    ]
    const { stats } = computeStats(participants, messages)
    const byName = new Map(stats.map((s) => [s.agent.name, s]))
    expect(byName.get('卢娜·狂野')).toMatchObject({ messages: 1, artifacts: 1, handoffs: 1, mentioned: 0, first: true })
    expect(byName.get('卢娜·禅意')).toMatchObject({ messages: 1, artifacts: 0, handoffs: 0, mentioned: 2, first: false })
    expect(byName.get('费利')).toMatchObject({ messages: 0, mentioned: 0 })
  })
})

// ---------- 波次 / 列表展示面署名（成员实例） ----------

describe('M77：波次与列表展示面按成员实例署名', () => {
  it('WaveGroup 并行组头：同角双实例显示「卢娜·狂野、卢娜·禅意」（头像取基础角色）', () => {
    const m1 = agentMsg({ id: 'm1', memberKey: 'luna', turnIndex: 0 })
    const m2 = agentMsg({ id: 'm2', memberKey: 'luna~zen', turnIndex: 0 })
    useSessionStore.setState({ byId: new Map([['m1', m1], ['m2', m2]]), order: ['m1', 'm2'] })
    render(<WaveGroup ids={['m1', 'm2']} />)
    expect(screen.getByText('并行协作')).toBeInTheDocument()
    expect(screen.getByText('卢娜·狂野、卢娜·禅意')).toBeInTheDocument()
  })

  it('WaveStrip 悬浮阶段条：署名按实例（同角双实例各自成名字）', () => {
    const m1 = agentMsg({ id: 'm1', memberKey: 'luna', turnIndex: 0 })
    const m2 = agentMsg({ id: 'm2', memberKey: 'luna~zen', turnIndex: 0 })
    useSessionStore.setState({ byId: new Map([['m1', m1], ['m2', m2]]), order: ['m1', 'm2'] })
    render(<WaveStrip info={{ runId: 'r1', turnIndex: 0, memberIds: ['m1', 'm2'] }} onJump={() => undefined} />)
    expect(screen.getByText('第 1 波')).toBeInTheDocument()
    expect(screen.getByText('卢娜·狂野、卢娜·禅意')).toBeInTheDocument()
  })

  it('会话列表预览：lastMessage.memberKey 署名到实例', async () => {
    const summary = makeSession({
      lastMessage: { role: 'agent', agentId: 'luna', memberKey: 'luna~zen', content: '禅意收官。', createdAt: T0 },
    })
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/sessions') return jsonResponse({ sessions: [summary] })
      return jsonResponse({})
    })
    useSessionStore.setState({ sessions: [summary] })
    render(<SessionList onSelect={() => undefined} />)
    expect(await screen.findByText(/卢娜·禅意：/)).toBeInTheDocument()
  })
})

// ---------- 接力链 / 提意见草稿（成员实例） ----------

describe('M77：交付交互按成员实例（接力链 / 提意见）', () => {
  it('接力进度链：同角双实例各自成节点（title = 实例标签 + 状态）', () => {
    useUiStore.setState({ rightView: 'relay' })
    const m1 = agentMsg({ id: 'm1', memberKey: 'luna', status: 'complete' })
    const m2 = agentMsg({ id: 'm2', memberKey: 'luna~zen', status: 'complete' })
    useSessionStore.setState({ byId: new Map([['m1', m1], ['m2', m2]]), order: ['m1', 'm2'] })
    render(<TeamPanel />)
    expect(screen.getByTitle('卢娜·狂野 · 已出手')).toBeInTheDocument()
    expect(screen.getByTitle('卢娜·禅意 · 已出手')).toBeInTheDocument()
  })

  it('提意见草稿：@分身实例标签（同角多实例）', async () => {
    const DOC = 'docs/需求文档.md'
    useSessionStore.setState({
      byId: new Map([
        ['a1', agentMsg({ id: 'a1', memberKey: 'luna~zen', content: '交付需求文档', artifacts: [DOC] })],
      ]),
      order: ['a1'],
    })
    render(
      <TooltipProvider>
        <MessageActions messageId="a1" />
      </TooltipProvider>,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '消息操作' }))
    await user.click(screen.getByRole('menuitem', { name: '提意见（对交付件）' }))
    expect(useUiStore.getState().composerInsert?.text).toBe(commentDraft('卢娜·禅意', DOC))
  })

  it('画布指令条召唤条：同角双实例各自有召唤钮（不回退全体）', () => {
    render(<CanvasComposer />)
    expect(screen.getByTitle('召唤 卢娜·狂野（狂想发散者）')).toBeInTheDocument()
    expect(screen.getByTitle('召唤 卢娜·禅意（狂想发散者）')).toBeInTheDocument()
    expect(screen.getByTitle('召唤 费利（产品经理）')).toBeInTheDocument()
  })
})
