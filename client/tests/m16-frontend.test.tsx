/**
 * M16 前端测试：
 * - 灵魂层：activeSoulOf 优先级（会话覆盖 > 角色默认）、SoulBadge 徽标、SoulPicker 切换 / 恢复默认 / 无灵魂不渲染；
 * - AgentPicker：分组 Tab + 搜索 + 卡片多选 + 已在场禁用 + 选中展开灵魂选择；
 * - 并行协作组 WaveGroup：组头成员 / 完成进度、折叠、组内 MessageItem 复用；
 * - system 事件条：MessageItem 的 role='system' 分支（成员变更居中胶囊）；
 * - session-store 动态成员：addMembers / removeMember / setMemberSoul（URL / body / 会话补丁 / 事件条 / 跨会话守卫）；
 * - run-store 波次归约：wave:start 记录当前波、run:start / run:end 清空；
 * - CommandPalette 新命令：邀请成员组（直达 POST）、邀请成员命令（打开邀请对话框）、浏览名录（hash 路由）；
 * - M21 图谱游戏化：dock（布局切换 / 整理 / 导演镜头）与档案面板（统计 / 工作产出 / 上下游 / 操作按钮）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'
import type { AgentDefinition, AgentGroup, ChatMessage, SessionSummary, SoulMeta } from '@multi-agent/shared'
import { AgentPicker } from '../src/components/agents/AgentPicker'
import { activeSoulOf, SoulBadge, SoulPicker } from '../src/components/agents/SoulPicker'
import { MessageItem } from '../src/components/chat/MessageItem'
import { WaveGroup } from '../src/components/chat/WaveGroup'
import { CommandPalette } from '../src/components/layout/CommandPalette'
import { SessionList } from '../src/components/sessions/SessionList'
import GraphView from '../src/components/team/GraphView'
import { GraphInspector } from '../src/components/team/graph/GraphInspector'
import { useAgentStore } from '../src/stores/agent-store'
import { useLivePanelStore } from '../src/stores/live-panel-store'
import { handleRunEvent, useRunStore } from '../src/stores/run-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'
import { useWsStore } from '../src/stores/ws-store'

// ---------- fixtures ----------

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
    group: 'development',
    avatar: { gradient: ['#3b82f6', '#f59e0b'], icon: 'user' },
    handoff: [],
    ...overrides,
  }
}

const PM = makeAgent({ id: 'pm', name: '费利', role: '产品经理', capabilities: ['需求分析'], description: '需求与验收' })
const ARCHITECT = makeAgent({ id: 'architect', name: '艾达', role: '架构师', capabilities: ['系统设计'] })
const LUNA = makeAgent({
  id: 'luna',
  name: '卢娜',
  role: '狂想发散者',
  group: 'brainstorm',
  capabilities: ['跨界联想'],
  souls: [WILD, ZEN, SCHOLAR],
  defaultSoul: 'wild',
})
const FACILITATOR = makeAgent({ id: 'facilitator', name: '梅森', role: '风暴主持', group: 'brainstorm' })

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
  {
    id: 'brainstorm',
    name: '头脑风暴',
    description: '创意发散与点子打磨',
    icon: 'lightbulb',
    theme: ['#f59e0b', '#fbbf24'],
    objective: '',
    chain: ['facilitator', 'luna'],
    defaultSkills: [],
    parallel: true,
    rounds: true,
    order: 1,
  },
]

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id: 'sa', title: '会话A', participantIds: ['pm'], createdAt: T0, updatedAt: T0, messageCount: 0, ...overrides }
}

const SESSION = makeSession()

function systemMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'ev1',
    sessionId: 'sa',
    role: 'system',
    agentId: 'facilitator',
    content: '梅森 邀请了 卢娜 加入协作',
    mentions: [],
    status: 'complete',
    turnIndex: -1,
    createdAt: T0,
    ...overrides,
  }
}

function agentMsg(id: string, agentId: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    sessionId: 'sa',
    runId: 'r1',
    turnIndex: 0,
    role: 'agent',
    agentId,
    content: '',
    mentions: [],
    status: 'complete',
    createdAt: T0,
    ...overrides,
  }
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
    if (url.endsWith('/artifacts')) return jsonResponse({ artifacts: [] })
    if (url.startsWith('/api/sessions/')) return jsonResponse({ messages: [], latestRun: null })
    return jsonResponse({})
  })
  useAgentStore.setState({
    agents: [PM, ARCHITECT, LUNA, FACILITATOR],
    groups: GROUPS,
    skills: [],
    loaded: true,
    loading: false,
    statuses: {},
  })
  useSessionStore.setState({
    sessions: [SESSION],
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
  useUiStore.setState({
    commandOpen: false,
    quietMode: false,
    rightView: 'relay',
    inviteOpen: false,
    focusRequest: undefined,
    editingMessageId: undefined,
  })
  useWsStore.setState({ unread: {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

// ---------- 灵魂层 ----------

describe('灵魂层解析与徽标（M16）', () => {
  it('activeSoulOf：会话覆盖 > 角色默认；未知覆盖 / 无默认 = 无灵魂', () => {
    expect(activeSoulOf(LUNA)).toEqual(WILD)
    expect(activeSoulOf(LUNA, 'zen')).toEqual(ZEN)
    expect(activeSoulOf(LUNA, 'ghost')).toBeUndefined()
    expect(activeSoulOf(PM)).toBeUndefined()
  })

  it('SoulBadge：渲染灵魂名与 tagline 提示', () => {
    render(<SoulBadge soul={ZEN} />)
    expect(screen.getByText('禅意')).toBeInTheDocument()
    expect(screen.getByTitle('禅意 · 静水流深，以问代答')).toBeInTheDocument()
  })

  it('SoulPicker：无 souls 的角色渲染 null（非必配原则）', () => {
    const { container } = render(<SoulPicker agent={PM} onPick={() => undefined} />)
    expect(container.innerHTML).toBe('')
  })

  it('SoulPicker：显示生效灵魂（覆盖优先），点击默认项 = 恢复默认（null）', async () => {
    const onPick = vi.fn()
    const user = userEvent.setup()
    render(<SoulPicker agent={LUNA} override="zen" onPick={onPick} />)

    // 触发按钮显示覆盖后的生效灵魂
    await user.click(screen.getByRole('button', { name: '禅意' }))
    // 菜单内：默认项带「默认」标注；含「恢复默认（狂野）」
    expect(screen.getByText('默认')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^恢复默认/ })).toBeInTheDocument()

    // 点击默认项（狂野）→ 清除覆盖恢复默认
    await user.click(screen.getByRole('button', { name: /^狂野/ }))
    expect(onPick).toHaveBeenCalledWith(null)
  })

  it('SoulPicker：选择非默认灵魂 → onPick(soulId)；恢复默认入口直达 null', async () => {
    const onPick = vi.fn()
    const user = userEvent.setup()
    render(<SoulPicker agent={LUNA} override="zen" onPick={onPick} />)

    await user.click(screen.getByRole('button', { name: '禅意' }))
    await user.click(screen.getByRole('button', { name: /^考据派/ }))
    expect(onPick).toHaveBeenCalledWith('scholar')

    await user.click(screen.getByRole('button', { name: '禅意' }))
    await user.click(screen.getByRole('button', { name: /^恢复默认/ }))
    expect(onPick).toHaveBeenCalledWith(null)
  })
})

// ---------- AgentPicker ----------

describe('AgentPicker（M16）', () => {
  it('分组 Tab：切到头脑风暴只显示该场景角色，切回全部恢复', () => {
    render(<AgentPicker value={[]} onChange={() => undefined} />)
    expect(screen.getByRole('button', { name: /费利/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /卢娜/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /头脑风暴/ }))
    expect(screen.queryByRole('button', { name: /费利/ })).toBeNull()
    expect(screen.getByRole('button', { name: /卢娜/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /梅森/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /全部/ }))
    expect(screen.getByRole('button', { name: /费利/ })).toBeInTheDocument()
  })

  it('搜索：按能力关键词过滤（跨界联想 → 仅卢娜）', () => {
    render(<AgentPicker value={[]} onChange={() => undefined} />)
    fireEvent.change(screen.getByPlaceholderText('搜索角色 / 能力…'), { target: { value: '跨界联想' } })
    expect(screen.getByRole('button', { name: /卢娜/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /费利/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /梅森/ })).toBeNull()

    fireEvent.change(screen.getByPlaceholderText('搜索角色 / 能力…'), { target: { value: '不存在的角色' } })
    expect(screen.getByText('没有匹配的角色')).toBeInTheDocument()
  })

  it('多选 toggle：点击追加、再点取消（受控回写）', () => {
    function Harness(): React.JSX.Element {
      const [value, setValue] = React.useState<string[]>([])
      return <AgentPicker value={value} onChange={setValue} />
    }
    render(<Harness />)

    const card = screen.getByRole('button', { name: /费利/ })
    expect(card).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(card)
    expect(screen.getByRole('button', { name: /费利/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: /卢娜/ }))
    expect(screen.getByRole('button', { name: /卢娜/ })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: /费利/ }))
    expect(screen.getByRole('button', { name: /费利/ })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: /卢娜/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('已在场禁用：标注「已在场」且点击不触发 onChange', () => {
    const onChange = vi.fn()
    render(<AgentPicker value={[]} onChange={onChange} disabledIds={['pm']} />)
    fireEvent.click(screen.getByRole('button', { name: /费利/ }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText('已在场')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /费利/ })).toHaveAttribute('aria-pressed', 'false')
  })

  it('选中成员展开灵魂选择：默认灵魂展示、切换回写 onSoulChange', async () => {
    const onSoulChange = vi.fn()
    function Harness(): React.JSX.Element {
      const [value, setValue] = React.useState<string[]>([])
      return <AgentPicker value={value} onChange={setValue} souls={{}} onSoulChange={onSoulChange} />
    }
    const user = userEvent.setup()
    render(<Harness />)

    // 未选中不展示灵魂选择器
    expect(screen.queryByRole('button', { name: '狂野' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /卢娜/ }))
    // 选中后展示默认灵魂徽标按钮
    await user.click(screen.getByRole('button', { name: '狂野' }))
    await user.click(screen.getByRole('button', { name: /^考据派/ }))
    expect(onSoulChange).toHaveBeenCalledWith('luna', 'scholar')
  })
})

// ---------- 并行协作组 ----------

describe('WaveGroup 并行协作组（M16）', () => {
  it('组头：∥ 并行协作 + 成员名 + 完成进度；折叠隐藏组内消息', async () => {
    const m1 = agentMsg('m1', 'pm', { content: '甲方案' })
    const m2 = agentMsg('m2', 'architect', { content: '乙方案', status: 'streaming' })
    useSessionStore.setState({ byId: new Map([[m1.id, m1], [m2.id, m2]]), order: ['m1', 'm2'] })
    const user = userEvent.setup()
    render(<WaveGroup ids={['m1', 'm2']} />)

    expect(screen.getByText('并行协作')).toBeInTheDocument()
    expect(screen.getByText('费利、艾达')).toBeInTheDocument()
    expect(screen.getByText('1/2 完成')).toBeInTheDocument()
    expect(screen.getByText('甲方案')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /并行协作/ }))
    expect(screen.queryByText('甲方案')).toBeNull()
    await user.click(screen.getByRole('button', { name: /并行协作/ }))
    expect(screen.getByText('甲方案')).toBeInTheDocument()
  })

  it('全部完成时进度满格展示', () => {
    const m1 = agentMsg('m1', 'pm', { content: '甲方案' })
    const m2 = agentMsg('m2', 'architect', { content: '乙方案' })
    useSessionStore.setState({ byId: new Map([[m1.id, m1], [m2.id, m2]]), order: ['m1', 'm2'] })
    render(<WaveGroup ids={['m1', 'm2']} />)
    expect(screen.getByText('2/2 完成')).toBeInTheDocument()
  })
})

// ---------- system 事件条 ----------

describe('system 事件条渲染（M16）', () => {
  it('role=system：渲染居中成员变更胶囊，不渲染成员气泡与交接条', () => {
    const message = systemMsg()
    useSessionStore.setState({ byId: new Map([[message.id, message]]), order: [message.id] })
    render(<MessageItem messageId={message.id} />)

    expect(screen.getByText('梅森 邀请了 卢娜 加入协作')).toBeInTheDocument()
    // 不渲染成员气泡/交接条专属文案
    expect(screen.queryByText(/链路暂歇|你的回合|正在酝酿/)).toBeNull()
    expect(screen.queryByText('梅森')).toBeNull()
  })

  it('换灵魂事件条正常渲染（头像按 agentId 解析）', () => {
    const message = systemMsg({ id: 'ev9', agentId: 'luna', content: '卢娜 换上了『狂野』灵魂' })
    useSessionStore.setState({ byId: new Map([[message.id, message]]), order: [message.id] })
    render(<MessageItem messageId={message.id} />)
    expect(screen.getByText('卢娜 换上了『狂野』灵魂')).toBeInTheDocument()
  })
})

// ---------- session-store 动态成员 ----------

describe('session-store 动态成员（M16）', () => {
  it('addMembers：POST agentIds+souls → 会话补丁 + 事件条入流', async () => {
    const next = makeSession({ participantIds: ['pm', 'luna'], memberSouls: { luna: 'wild' } })
    const ev = systemMsg({ id: 'ev1', content: '费利 邀请了 卢娜 加入协作' })
    fetchMock.mockImplementation(async () => jsonResponse({ session: next, message: ev }))

    await useSessionStore.getState().addMembers('sa', ['luna'], { luna: 'wild' })

    const call = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(call[0]).toBe('/api/sessions/sa/members')
    expect(call[1].method).toBe('POST')
    expect(bodyOf(call)).toEqual({ agentIds: ['luna'], souls: { luna: 'wild' } })

    const session = useSessionStore.getState().sessions.find((s) => s.id === 'sa')
    expect(session?.participantIds).toEqual(['pm', 'luna'])
    expect(session?.memberSouls).toEqual({ luna: 'wild' })
    expect(useSessionStore.getState().order).toEqual(['ev1'])
    expect(useSessionStore.getState().byId.get('ev1')?.content).toBe('费利 邀请了 卢娜 加入协作')
  })

  it('addMembers：事件条跨会话守卫（会话补丁仍生效）', async () => {
    const next = makeSession({ participantIds: ['pm', 'luna'] })
    fetchMock.mockImplementation(async () =>
      jsonResponse({ session: next, message: systemMsg({ id: 'ev5', sessionId: 'sb' }) }),
    )
    await useSessionStore.getState().addMembers('sa', ['luna'])
    expect(useSessionStore.getState().sessions.find((s) => s.id === 'sa')?.participantIds).toEqual(['pm', 'luna'])
    expect(useSessionStore.getState().byId.has('ev5')).toBe(false)
  })

  it('removeMember：DELETE 成员路径 → 会话补丁 + 离场事件条', async () => {
    const next = makeSession({ participantIds: ['luna'] })
    const ev = systemMsg({ id: 'ev2', content: '费利 离开了协作' })
    fetchMock.mockImplementation(async () => jsonResponse({ session: next, message: ev }))

    await useSessionStore.getState().removeMember('sa', 'pm')

    const call = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(call[0]).toBe('/api/sessions/sa/members/pm')
    expect(call[1].method).toBe('DELETE')
    expect(useSessionStore.getState().sessions.find((s) => s.id === 'sa')?.participantIds).toEqual(['luna'])
    expect(useSessionStore.getState().byId.get('ev2')?.content).toBe('费利 离开了协作')
  })

  it('setMemberSoul：PATCH 灵魂（null = 恢复默认）', async () => {
    const bodies: unknown[] = []
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      if (bodies.length === 1) {
        return jsonResponse({
          session: makeSession({ memberSouls: { facilitator: 'energetic' } }),
          message: systemMsg({ id: 'ev3', content: '梅森 换上了『元气』灵魂' }),
        })
      }
      return jsonResponse({
        session: makeSession(),
        message: systemMsg({ id: 'ev4', content: '梅森 恢复了默认灵魂' }),
      })
    })

    await useSessionStore.getState().setMemberSoul('sa', 'facilitator', 'energetic')
    await useSessionStore.getState().setMemberSoul('sa', 'facilitator', null)

    const calls = fetchMock.mock.calls as [string, RequestInit][]
    expect(calls[0][0]).toBe('/api/sessions/sa/members/facilitator')
    expect(calls[0][1].method).toBe('PATCH')
    expect(bodies).toEqual([{ soul: 'energetic' }, { soul: null }])
    expect(useSessionStore.getState().byId.get('ev4')?.content).toBe('梅森 恢复了默认灵魂')
  })
})

// ---------- run-store 波次归约 ----------

describe('run-store 波次归约（M16）', () => {
  it('wave:start 记录当前波成员（并行多人 / 串行单人均适用）', () => {
    handleRunEvent({ type: 'wave:start', runId: 'r1', sessionId: 'sa', waveIndex: 0, members: ['pm', 'architect'] })
    expect(useRunStore.getState().currentWave).toEqual(['pm', 'architect'])

    handleRunEvent({ type: 'wave:start', runId: 'r1', sessionId: 'sa', waveIndex: 1, members: ['pm'] })
    expect(useRunStore.getState().currentWave).toEqual(['pm'])
  })

  it('run:start 重置波与队列；run:end 清空并落结束原因', () => {
    handleRunEvent({ type: 'wave:start', runId: 'r1', sessionId: 'sa', waveIndex: 0, members: ['pm', 'qa'] })
    handleRunEvent({ type: 'run:start', runId: 'r2', sessionId: 'sa', queue: ['pm', 'qa'] })
    expect(useRunStore.getState().currentWave).toEqual([])
    expect(useRunStore.getState().queue).toEqual(['pm', 'qa'])
    expect(useRunStore.getState().active).toBe(true)

    handleRunEvent({ type: 'wave:start', runId: 'r2', sessionId: 'sa', waveIndex: 0, members: ['pm', 'qa'] })
    handleRunEvent({ type: 'run:end', runId: 'r2', sessionId: 'sa', reason: 'completed' })
    expect(useRunStore.getState().currentWave).toEqual([])
    expect(useRunStore.getState().queue).toEqual([])
    expect(useRunStore.getState().active).toBe(false)
    expect(useRunStore.getState().lastEndReason).toBe('completed')
  })
})

// ---------- CommandPalette 新命令 ----------

describe('CommandPalette 新命令（M16）', () => {
  it('邀请成员组：列出不在场成员，点击直达邀请（POST members），面板关闭且会话即时更新', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/sessions/sa/members' && init?.method === 'POST') {
        return jsonResponse({
          session: makeSession({ participantIds: ['pm', 'luna'] }),
          message: systemMsg({ id: 'ev1', content: '费利 邀请了 卢娜 加入协作' }),
        })
      }
      return jsonResponse({})
    })
    useUiStore.setState({ commandOpen: true })
    const user = userEvent.setup()
    render(<CommandPalette />)

    const heading = screen.getByText('邀请成员加入会话')
    const group = heading.closest('[cmdk-group]') as HTMLElement
    expect(group).toBeTruthy()
    // 已在场的 pm 不出现在邀请组
    expect(within(group).queryByText('费利')).toBeNull()

    await user.click(within(group).getByText('卢娜'))

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([u, i]) => String(u) === '/api/sessions/sa/members' && (i as RequestInit)?.method === 'POST',
      )
      expect(post).toBeTruthy()
      expect(bodyOf(post as [string, RequestInit])).toEqual({ agentIds: ['luna'] })
    })
    expect(useUiStore.getState().commandOpen).toBe(false)
    expect(useSessionStore.getState().sessions.find((s) => s.id === 'sa')?.participantIds).toEqual(['pm', 'luna'])
    expect(useSessionStore.getState().byId.get('ev1')?.content).toBe('费利 邀请了 卢娜 加入协作')
  })

  it('邀请成员命令：打开成员视图与邀请对话框', async () => {
    useUiStore.setState({ commandOpen: true })
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.click(screen.getByText('邀请成员加入当前会话'))
    expect(useUiStore.getState().rightView).toBe('members')
    expect(useUiStore.getState().inviteOpen).toBe(true)
    expect(useUiStore.getState().commandOpen).toBe(false)
  })

  it('邀请成员命令：无当前会话时仅提示不打开对话框', async () => {
    useSessionStore.setState({ currentId: undefined })
    useUiStore.setState({ commandOpen: true })
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.click(screen.getByText('邀请成员加入当前会话'))
    expect(useUiStore.getState().inviteOpen).toBe(false)
  })

  it('浏览名录命令：hash 路由到 #/agents', async () => {
    useUiStore.setState({ commandOpen: true })
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.click(screen.getByText('浏览 Agent 名录'))
    expect(window.location.hash).toBe('#/agents')
  })
})

// ---------- 场景创建器（组队台） ----------

describe('场景创建器 SessionList（M16）', () => {
  it('选场景 → 预选推荐编制 → 微调成员 → 创建并进入', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/sessions' && init?.method === 'POST') {
        return jsonResponse({ session: makeSession({ id: 's-new', title: '新会话', participantIds: ['pm'] }) })
      }
      if (url === '/api/sessions') return jsonResponse({ sessions: [makeSession({ id: 's-new', title: '新会话' })] })
      return jsonResponse({})
    })
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<SessionList onSelect={onSelect} />)

    // 组队台：来源行常驻（三栏同屏）+ 编制计数归零
    await user.click(screen.getByTitle('新建会话'))
    expect(screen.getByRole('button', { name: '组队来源：研发团队' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '组队来源：头脑风暴' })).toBeInTheDocument()
    expect(screen.getByText('自由组合')).toBeInTheDocument()
    expect(screen.getByText('∥ 并行协作 · 2 位推荐')).toBeInTheDocument()
    expect(screen.getByText('已选 0 位')).toBeInTheDocument()

    // 选研发团队 → 编制整体替换为 chain（费利 + 艾达）
    await user.click(screen.getByRole('button', { name: '组队来源：研发团队' }))
    expect(screen.getByText('已选 2 位')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /费利/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /艾达/ })).toHaveAttribute('aria-pressed', 'true')

    // 微调：点池卡移出艾达
    await user.click(screen.getByRole('button', { name: /艾达/ }))
    expect(screen.getByText('已选 1 位')).toBeInTheDocument()

    // 创建：POST 携带最终编制；成功后 onSelect 进入新会话
    await user.click(screen.getByRole('button', { name: /创建并进入/ }))
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([u, i]) => String(u) === '/api/sessions' && (i as RequestInit)?.method === 'POST',
      )
      expect(post).toBeTruthy()
      expect(bodyOf(post as [string, RequestInit])).toEqual({ participantIds: ['pm'] })
      expect(onSelect).toHaveBeenCalledWith('s-new')
    })
  })

  it('自由组合：空选 = 空编制创建（交平台组队）；选中并挑灵魂后 POST 携带 souls', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/sessions' && init?.method === 'POST') {
        return jsonResponse({ session: makeSession({ id: 's-luna', title: '卢娜局', participantIds: ['luna'] }) })
      }
      if (url === '/api/sessions') return jsonResponse({ sessions: [makeSession({ id: 's-luna' })] })
      return jsonResponse({})
    })
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<SessionList onSelect={onSelect} />)

    await user.click(screen.getByTitle('新建会话'))
    await user.click(screen.getByText('自由组合'))
    expect(screen.getByText('已选 0 位')).toBeInTheDocument()
    // M48：空选不再禁用——空编制创建合法（首条消息由平台路由组队）
    expect(screen.getByRole('button', { name: /空编制创建 · 交给平台组队/ })).toBeEnabled()

    // 选中卢娜（默认灵魂狂野）→ 在编制行切换为考据派
    await user.click(screen.getByRole('button', { name: /卢娜/ }))
    await user.click(screen.getByRole('button', { name: '狂野' }))
    await user.click(screen.getByRole('button', { name: /^考据派/ }))
    expect(screen.getByText('已选 1 位')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /创建并进入/ }))
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([u, i]) => String(u) === '/api/sessions' && (i as RequestInit)?.method === 'POST',
      )
      expect(post).toBeTruthy()
      expect(bodyOf(post as [string, RequestInit])).toEqual({
        participantIds: ['luna'],
        souls: { luna: 'scholar' },
      })
      expect(onSelect).toHaveBeenCalledWith('s-luna')
    })
  })
})

// ---------- GraphView 渲染冒烟 ----------

describe('GraphView 渲染冒烟（M17）', () => {
  it('无成员：空态引导 + 编制预览', async () => {
    useSessionStore.setState({ sessions: [makeSession({ participantIds: [] })] })
    render(<GraphView />)
    expect(screen.getByText('会话还没有成员')).toBeInTheDocument()
    expect(screen.getByText(/编制预览/)).toBeInTheDocument()
    // 工作产出请求（/artifacts）的异步回填落在 act 内，避免 act 警告
    await act(async () => undefined)
  })

  it('有成员：渲染画布与图例（接力 / 编制 / 发言 / 排队）', async () => {
    useSessionStore.setState({ sessions: [makeSession({ participantIds: ['pm', 'architect'] })] })
    render(<GraphView />)
    for (const label of ['实际接力', '编制预期', '发言中', '排队中']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    await act(async () => undefined)
  })

  it('游戏化入口（M21）：dock 布局切换 / 整理 / 导演镜头齐备', async () => {
    useSessionStore.setState({ sessions: [makeSession({ participantIds: ['pm', 'architect'] })] })
    render(<GraphView />)
    expect(screen.getByTitle('接力链布局')).toBeInTheDocument()
    expect(screen.getByTitle('圆桌布局')).toBeInTheDocument()
    expect(screen.getByTitle('整理布局')).toBeInTheDocument()
    expect(screen.getByTitle(/导演镜头/)).toBeInTheDocument()
    await act(async () => undefined)
  })
})

// ---------- GraphInspector 档案面板（M21） ----------

describe('GraphInspector 档案面板（M21）', () => {
  const LAST: ChatMessage = {
    id: 'm-inspector',
    sessionId: 's1',
    role: 'agent',
    agentId: 'pm',
    content: '需求已确认，交给艾达设计接口。',
    mentions: [],
    status: 'complete',
    createdAt: T0,
  }

  it('统计 / 上下游 / 状态徽章渲染，操作按钮齐备', () => {
    useAgentStore.setState({ agents: [PM, FACILITATOR], groups: GROUPS })
    render(
      <GraphInspector
        agent={PM}
        upstream={[{ id: 'facilitator', count: 2, lastAt: T0 }]}
        downstream={[{ id: 'architect', count: 1 }]}
        talks={3}
        speaking={false}
        queueIndex={0}
        awaitingUser={false}
        lastMessage={LAST}
        onFocus={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    // 接力战绩三格与状态徽章
    expect(screen.getByText('接手')).toBeInTheDocument()
    expect(screen.getByText('交出')).toBeInTheDocument()
    expect(screen.getByText('发言')).toBeInTheDocument()
    expect(screen.getByText('待命')).toBeInTheDocument()
    // 上下游 chip（名称映射自 agent store；architect 未注册 → 回退 id）
    expect(screen.getByText('梅森')).toBeInTheDocument()
    expect(screen.getByText('architect')).toBeInTheDocument()
    // 最近发言摘要
    expect(screen.getByText(/需求已确认/)).toBeInTheDocument()
    // 操作行
    expect(screen.getByTitle('聚焦该成员（相机居中）')).toBeInTheDocument()
    expect(screen.getByTitle('拍一拍')).toBeInTheDocument()
    expect(screen.getByTitle('@ 召唤')).toBeInTheDocument()
  })

  it('@ 召唤写入 Composer 通道；点最近发言触发消息定位', async () => {
    useAgentStore.setState({ agents: [PM], groups: GROUPS })
    useUiStore.setState({ composerInsert: undefined, focusRequest: undefined })
    const user = userEvent.setup()
    render(
      <GraphInspector
        agent={PM}
        upstream={[]}
        downstream={[]}
        talks={0}
        speaking={false}
        queueIndex={0}
        awaitingUser={false}
        lastMessage={LAST}
        onFocus={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    await user.click(screen.getByTitle('@ 召唤'))
    expect(useUiStore.getState().composerInsert?.text).toBe('@费利 ')
    await user.click(screen.getByTitle('定位到对话区该条发言'))
    expect(useUiStore.getState().focusRequest?.id).toBe('m-inspector')
  })

  it('工作产出：列出该成员交付件（最新在前），点击打开交付件浏览器', async () => {
    useAgentStore.setState({ agents: [PM], groups: GROUPS })
    useUiStore.setState({ requestedArtifactPath: undefined, mainTab: 'chat', rightView: 'members' })
    useLivePanelStore.setState({ face: 'browser', pinnedArtifactPath: undefined, followArtifactPath: undefined, viewLockedRunId: undefined })
    const user = userEvent.setup()
    render(
      <GraphInspector
        agent={PM}
        upstream={[]}
        downstream={[]}
        talks={0}
        speaking={false}
        queueIndex={0}
        awaitingUser={false}
        artifacts={[
          { path: 'docs/older.md', size: 1024, mtime: 1, kind: 'markdown', authorAgentId: 'pm', updatedAt: T0 },
          { path: 'src/newer.ts', size: 2048, mtime: 2, kind: 'code', authorAgentId: 'pm', updatedAt: T0 },
        ]}
        onFocus={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('工作产出')).toBeInTheDocument()
    expect(screen.getByText('2 件')).toBeInTheDocument()
    const rows = screen.getAllByTitle(/^打开交付件：/)
    expect(rows).toHaveLength(2)
    // mtime 降序：最新在前
    expect(rows[0]?.textContent).toContain('newer.ts')
    await user.click(rows[0]!)
    expect(useUiStore.getState().requestedArtifactPath).toBe('src/newer.ts')
    // M49（ADR 0100）：点击产出 → 右栏实况·交付件面钉住（主区不再切「交付件」页签）
    expect(useUiStore.getState().rightView).toBe('live')
    expect(useLivePanelStore.getState().face).toBe('artifacts')
    expect(useLivePanelStore.getState().pinnedArtifactPath).toBe('src/newer.ts')
  })

  it('工作产出：无交付件时显示空态', () => {
    useAgentStore.setState({ agents: [PM], groups: GROUPS })
    render(
      <GraphInspector
        agent={PM}
        upstream={[]}
        downstream={[]}
        talks={0}
        speaking={false}
        queueIndex={0}
        awaitingUser={false}
        onFocus={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('工作产出')).toBeInTheDocument()
    expect(screen.getByText('暂无产出')).toBeInTheDocument()
  })
})
