/**
 * M21 前端测试（OPC 交互）：
 * - SessionList 快速组队：预设行预选成员（跨场景）→ 来源徽标 → 创建后开场指令预填草稿键；
 * - 场景行保留 E2E 语义：按钮 aria-label / objective 目标行共存；
 * - pendingCreate 通道：命令面板请求自动打开对话框并预选编制；id 失效回退无来源；
 * - CommandPalette 快速组队分组：preset / 场景入口 → requestCreate（nonce 递增）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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
    group: 'strategy',
    avatar: { gradient: ['#6366f1', '#818cf8'], icon: 'briefcase' },
    handoff: [],
    ...overrides,
  }
}

const CHIEF = makeAgent({ id: 'chief', name: '柏川', role: '幕僚长', group: 'strategy' })
const FINANCE = makeAgent({ id: 'finance', name: '周正', role: '财务管家', group: 'finance' })
const GROWTH = makeAgent({ id: 'growth', name: '高扬', role: '增长负责人', group: 'marketing' })

const GROUPS: AgentGroup[] = [
  {
    id: 'strategy',
    name: '商业战略',
    description: '多轮研讨收敛战略方向',
    icon: 'briefcase',
    theme: ['#6366f1', '#818cf8'],
    objective: '验证经营假设并输出战略路径',
    chain: ['chief'],
    defaultSkills: [],
    parallel: false,
    rounds: true,
    order: 5,
  },
  {
    id: 'marketing',
    name: '市场增长',
    description: '目标到日历的完整增长链路',
    icon: 'trending-up',
    theme: ['#f43f5e', '#fb7185'],
    objective: '拉新转化与内容战役推进',
    chain: ['growth'],
    defaultSkills: ['content-marketing'],
    parallel: true,
    parallelMax: 3,
    rounds: false,
    order: 40,
  },
]

const WEEKLY_REVIEW: RosterPreset = {
  id: 'weekly-review',
  name: '周经营例会',
  description: '四方汇报 → 经营简报与优先级',
  icon: 'calendar-clock',
  theme: ['#6366f1', '#818cf8'],
  members: ['chief', 'finance', 'growth'],
  prompt: '@柏川 主持周经营例会，@周正 先给出财务测算，@高扬 汇报增长数据。',
  order: 10,
}

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id: 'sa', title: '会话A', participantIds: [], createdAt: T0, updatedAt: T0, messageCount: 0, ...overrides }
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
    agents: [CHIEF, FINANCE, GROWTH],
    groups: GROUPS,
    presets: [WEEKLY_REVIEW],
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
  useUiStore.setState({
    commandOpen: false,
    quietMode: false,
    pendingCreate: undefined,
    focusRequest: undefined,
    inviteOpen: false,
  })
  useWsStore.setState({ unread: {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------- SessionList 快速组队 ----------

describe('SessionList 快速组队（M21）', () => {
  it('预设卡预选成员 → 来源徽标 → 创建后开场指令预填草稿键', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/sessions' && init?.method === 'POST') {
        return jsonResponse({
          session: makeSession({ id: 's-pr', title: '周经营例会', participantIds: ['chief', 'finance', 'growth'] }),
        })
      }
      if (url === '/api/sessions') return jsonResponse({ sessions: [makeSession({ id: 's-pr', title: '周经营例会' })] })
      return jsonResponse({})
    })
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<SessionList onSelect={onSelect} />)

    await user.click(screen.getByTitle('新建会话'))
    // 组队台：快速组队 + 按场景组队两个分组共存；预设行可点
    expect(screen.getByText('快速组队')).toBeInTheDocument()
    expect(screen.getByText('按场景组队')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '组队来源：周经营例会' })).toBeInTheDocument()
    expect(screen.getByText('3 人')).toBeInTheDocument()

    // 点预设行 → 编制整体预选（跨场景 3 位）
    await user.click(screen.getByRole('button', { name: '组队来源：周经营例会' }))
    expect(screen.getByText('快速组队 · 周经营例会')).toBeInTheDocument()
    expect(screen.getByText('已选 3 位')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /柏川/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /周正/ })).toHaveAttribute('aria-pressed', 'true')
    // 开场指令可折叠预览（details 折叠时内容仍在 DOM）
    expect(screen.getByText('开场指令将预填为草稿（点击预览）')).toBeInTheDocument()
    expect(screen.getByText(WEEKLY_REVIEW.prompt)).toBeInTheDocument()

    // 创建：POST 携带预选编制；草稿键写入（与 Composer.draftKey 一致）
    await user.click(screen.getByRole('button', { name: /创建并进入/ }))
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([u, i]) => String(u) === '/api/sessions' && (i as RequestInit)?.method === 'POST',
      )
      expect(post).toBeTruthy()
      expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
        participantIds: ['chief', 'finance', 'growth'],
      })
      expect(onSelect).toHaveBeenCalledWith('s-pr')
    })
    expect(localStorage.getItem('ma:draft:s-pr')).toBe(WEEKLY_REVIEW.prompt)
  })

  it('场景卡保留按钮语义并显示 objective 目标行', async () => {
    const user = userEvent.setup()
    render(<SessionList onSelect={vi.fn()} />)

    await user.click(screen.getByTitle('新建会话'))
    // E2E 依赖：场景行以 aria-label「组队来源：X」定位（池内 Tab 同名时仍唯一）
    expect(screen.getByRole('button', { name: '组队来源：商业战略' })).toBeInTheDocument()
    expect(screen.getByText('目标：验证经营假设并输出战略路径')).toBeInTheDocument()
    expect(screen.getByText('∥ 并行协作 · 1 位推荐')).toBeInTheDocument()

    // 选场景 → 预选 chain；无 preset 来源时不显示草稿预览
    await user.click(screen.getByRole('button', { name: '组队来源：商业战略' }))
    expect(screen.getByText('已选 1 位')).toBeInTheDocument()
    expect(screen.queryByText('开场指令将预填为草稿（点击预览）')).toBeNull()
  })

  it('无预设数据时快速组队区块隐藏（资产缺失自动降级）', async () => {
    useAgentStore.setState({ presets: [] })
    const user = userEvent.setup()
    render(<SessionList onSelect={vi.fn()} />)

    await user.click(screen.getByTitle('新建会话'))
    expect(screen.getByText('按场景组队')).toBeInTheDocument()
    expect(screen.queryByText('快速组队')).toBeNull()
    expect(screen.getByText('自由组合')).toBeInTheDocument()
  })
})

// ---------- pendingCreate 通道 ----------

describe('pendingCreate 通道（M21）', () => {
  it('命令面板请求（preset）→ 自动打开对话框并预选编制，随后清空请求', async () => {
    useUiStore.setState({ pendingCreate: { kind: 'preset', id: 'weekly-review', nonce: 1 } })
    render(<SessionList onSelect={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('快速组队 · 周经营例会')).toBeInTheDocument()
    })
    expect(screen.getByText('已选 3 位')).toBeInTheDocument()
    expect(useUiStore.getState().pendingCreate).toBeUndefined()
  })

  it('命令面板请求（scene）→ 预选场景推荐编制', async () => {
    useUiStore.setState({ pendingCreate: { kind: 'scene', id: 'marketing', nonce: 1 } })
    render(<SessionList onSelect={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('已选 1 位')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /高扬/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('id 失效时回退无来源（对话框打开且编制为空，不崩溃）', async () => {
    useUiStore.setState({ pendingCreate: { kind: 'preset', id: 'ghost', nonce: 1 } })
    render(<SessionList onSelect={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('已选 0 位')).toBeInTheDocument()
    })
    expect(screen.getByText('按场景组队')).toBeInTheDocument()
    expect(useUiStore.getState().pendingCreate).toBeUndefined()
  })
})

// ---------- CommandPalette 快速组队分组 ----------

describe('CommandPalette 快速组队分组（M21）', () => {
  it('preset 项：点击关闭面板并发出 preset 预选请求', async () => {
    useUiStore.setState({ commandOpen: true })
    const user = userEvent.setup()
    render(<CommandPalette />)

    expect(screen.getByText('快速组队')).toBeInTheDocument()
    await user.click(screen.getByText('新建会话：周经营例会'))

    expect(useUiStore.getState().commandOpen).toBe(false)
    expect(useUiStore.getState().pendingCreate).toEqual({ kind: 'preset', id: 'weekly-review', nonce: 1 })
  })

  it('场景项：点击发出 scene 预选请求（nonce 递增）', async () => {
    useUiStore.setState({ commandOpen: true, pendingCreate: { kind: 'preset', id: 'weekly-review', nonce: 1 } })
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.click(screen.getByText('新建会话：市场增长'))
    expect(useUiStore.getState().pendingCreate).toEqual({ kind: 'scene', id: 'marketing', nonce: 2 })
  })

  it('「新建会话」→ 空编制创建（首条消息由平台路由组队）', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/sessions' && init?.method === 'POST') {
        return jsonResponse({ session: makeSession({ id: 's-all', title: '全员局' }) })
      }
      if (url === '/api/sessions') return jsonResponse({ sessions: [makeSession({ id: 's-all' })] })
      if (url.startsWith('/api/sessions/s-all')) return jsonResponse({ messages: [], latestRun: null })
      if (url === '/api/runs/active') return jsonResponse({ runs: [] })
      return jsonResponse({})
    })
    useUiStore.setState({ commandOpen: true })
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.click(screen.getByText('新建会话'))
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([u, i]) => String(u) === '/api/sessions' && (i as RequestInit)?.method === 'POST',
      )
      expect(post).toBeTruthy()
      expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
        participantIds: [],
      })
    })
    // 直接创建路径不发出 pendingCreate 请求
    expect(useUiStore.getState().pendingCreate).toBeUndefined()
  })
})
