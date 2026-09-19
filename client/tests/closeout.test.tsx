/**
 * 收尾交付清单（M37-6 修订；分层默认续修订 / ADR 0123）：
 * - 无交付件：不渲染收尾卡（每轮固定收尾文案已移除）；
 * - 默认只展示最终交付（结论性件按重要度取前 5）：文档 > 图示与页面 > 媒体 > 源码 > 数据；
 * - 过程产物（过程目录下的快照 / 中间态，如 charts/）与溢出项收进「其他」默认折叠，
 *   箭头全展示 / 收起；全为过程产物时「其他」默认展开（卡片不空）；
 * - 整清单可整体折叠（头部左簇即开关 data-delivery-collapse）：收起后仅留概要行与快捷继续，
 *   已展开的「其他」子组随整体隐藏但状态保留，再展开回位；
 * - 行 = 目录 + 名称 + 体积 + 交付者头像；运行中不渲染；
 * - 交付件后补（run:end 快照回填，流式期消息不带 artifacts）：指纹含计数 → 清单随之出现。
 * 元数据（kind / size）经会话级共享缓存补齐：stub fetch 应答 /api/sessions/:id/artifacts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentDefinition, AgentGroup, ChatMessage } from '@multi-agent/shared'
import { CloseoutCard } from '../src/components/chat/CloseoutCard'
import { useArtifactMetaStore } from '../src/lib/use-artifact-meta'
import { useAgentStore } from '../src/stores/agent-store'
import { useLivePanelStore } from '../src/stores/live-panel-store'
import { useRunStore } from '../src/stores/run-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'

const T0 = '2026-09-18T08:00:00.000Z'

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

const PM = makeAgent({ id: 'pm', name: '费利', role: '产品经理' })
const ARCHITECT = makeAgent({ id: 'architect', name: '艾达', role: '架构师' })

const GROUPS: AgentGroup[] = [
  {
    id: 'development',
    name: '研发团队',
    description: '',
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

function agentMsg(id: string, agentId: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    sessionId: 'sa',
    runId: 'r1',
    turnIndex: 0,
    role: 'agent',
    agentId,
    content: '内容',
    mentions: [],
    status: 'complete',
    createdAt: T0,
    ...overrides,
  }
}

/** 交付件元数据接口 stub（kind / size 补齐来源） */
function stubArtifacts(items: Array<{ path: string; kind: string; size: number }>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/artifacts')) {
        const artifacts = items.map((a, i) => ({ ...a, mtime: i, updatedAt: T0 }))
        return new Response(JSON.stringify({ artifacts }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
}

beforeEach(() => {
  useAgentStore.setState({ agents: [PM, ARCHITECT], groups: GROUPS, skills: [], loaded: true, loading: false, statuses: {} })
  useSessionStore.setState({ currentId: 'sa', byId: new Map(), order: [], artifactVersion: 0 })
  useRunStore.setState({ active: false, queue: [] })
  useArtifactMetaStore.setState({ sessionId: undefined, version: -1, byPath: new Map() })
  useUiStore.setState({ requestedArtifactPath: undefined, mainTab: 'chat', deepFrom: undefined, rightView: 'members', quietMode: false })
  // M49：跟随状态归零（交付件行点击 → 实况订阅响应为切实况 + 钉住）
  useLivePanelStore.setState({
    face: 'browser',
    faceLockedAt: undefined,
    viewLockedRunId: undefined,
    lastManualViewAt: undefined,
    followPaused: false,
    pinnedArtifactPath: undefined,
    followArtifactPath: undefined,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('收尾交付清单（CloseoutCard）', () => {
  it('无交付件：不渲染收尾卡（固定收尾文案已移除）', () => {
    stubArtifacts([])
    const tail = agentMsg('m2', 'architect', { turnIndex: 1, mentions: ['user'], content: '本轮到此' })
    useSessionStore.setState({ byId: new Map([[tail.id, tail]]), order: [tail.id] })

    const { container } = render(<CloseoutCard />)
    expect(container.firstChild).toBeNull()
    expect(screen.queryByText('本轮已交还')).toBeNull()
  })

  it('有交付件：渲染完整清单（件数 / 波次 / 明细行 + 交付者），点击行打开交付件面板', async () => {
    stubArtifacts([
      { path: 'docs/需求文档-登录.md', kind: 'markdown', size: 2048 },
      { path: 'src/app.ts', kind: 'code', size: 1024 },
    ])
    const m1 = agentMsg('m1', 'pm', { turnIndex: 0, mentions: ['architect'], artifacts: ['docs/需求文档-登录.md'] })
    const m2 = agentMsg('m2', 'architect', { turnIndex: 1, mentions: ['user'], artifacts: ['src/app.ts'] })
    useSessionStore.setState({ byId: new Map([['m1', m1], ['m2', m2]]), order: ['m1', 'm2'] })

    const { container } = render(<CloseoutCard />)

    expect(screen.getByText('本轮交付')).toBeInTheDocument()
    expect(screen.getByText('2 件')).toBeInTheDocument()
    expect(screen.getByText('收束于第 2 波')).toBeInTheDocument()
    expect(container.querySelectorAll('[data-delivery-row]')).toHaveLength(2)
    // 目录前缀 + 文件名
    expect(screen.getByText('docs/')).toBeInTheDocument()
    expect(screen.getByText('需求文档-登录.md')).toBeInTheDocument()
    // 交付者（按消息归属）
    expect(screen.getByTitle('由 费利 交付')).toBeInTheDocument()
    expect(screen.getByTitle('由 艾达 交付')).toBeInTheDocument()
    // 体积（元数据经共享缓存异步补齐）
    expect(await screen.findByText('2.0KB')).toBeInTheDocument()
    expect(screen.getByText('1.0KB')).toBeInTheDocument()

    // 点击行 → 右栏实况 · 交付件面钉住选中（M49：深度工作台经「展开」进入，主 tab 保持对话）
    await userEvent.click(screen.getByTitle('打开交付件：src/app.ts'))
    expect(useUiStore.getState().requestedArtifactPath).toBe('src/app.ts')
    expect(useUiStore.getState().mainTab).toBe('chat')
    expect(useUiStore.getState().rightView).toBe('live')
    expect(useLivePanelStore.getState().face).toBe('artifacts')
    expect(useLivePanelStore.getState().pinnedArtifactPath).toBe('src/app.ts')
  })

  it('运行中不渲染（与交接条「你的回合」同口径）', () => {
    stubArtifacts([{ path: 'docs/需求文档-登录.md', kind: 'markdown', size: 2048 }])
    const tail = agentMsg('m2', 'architect', { turnIndex: 1, mentions: ['user'], artifacts: ['docs/需求文档-登录.md'] })
    useSessionStore.setState({ byId: new Map([[tail.id, tail]]), order: [tail.id] })
    useRunStore.setState({ active: true })

    const { container } = render(<CloseoutCard />)
    expect(container.firstChild).toBeNull()
  })

  it('分层默认：只展示最终交付（按重要度取前 5），过程产物与溢出收进「其他」折叠、箭头全展示 / 收起', async () => {
    const docs = Array.from({ length: 5 }, (_, i) => `docs/报告-${i}.md`)
    const charts = Array.from({ length: 8 }, (_, i) => `charts/sh600000-day-${i}.json`)
    stubArtifacts([...docs, ...charts].map((p) => ({ path: p, kind: p.endsWith('.md') ? 'markdown' : 'code', size: 1024 })))
    const tail = agentMsg('m1', 'pm', { turnIndex: 0, mentions: ['user'], artifacts: [...docs, ...charts] })
    useSessionStore.setState({ byId: new Map([[tail.id, tail]]), order: [tail.id] })

    const { container } = render(<CloseoutCard />)
    expect(screen.getByText('13 件')).toBeInTheDocument()
    // 默认：5 行最终交付；过程产物不占默认视图
    expect(container.querySelectorAll('[data-delivery-row]')).toHaveLength(5)
    expect(container.querySelectorAll('[data-delivery-group="others"]')).toHaveLength(0)
    expect(screen.getByRole('button', { name: '其他 8 件' })).toHaveAttribute('aria-expanded', 'false')

    // 箭头全展示 → 13 行；再点收起 → 回 5 行
    await userEvent.click(screen.getByRole('button', { name: '其他 8 件' }))
    expect(container.querySelectorAll('[data-delivery-row]')).toHaveLength(13)
    expect(screen.getByRole('button', { name: '其他 8 件' })).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(screen.getByRole('button', { name: '其他 8 件' }))
    expect(container.querySelectorAll('[data-delivery-row]')).toHaveLength(5)
  })

  it('整体折叠：头部开关一键隐藏 / 恢复全部文件行（主区 + 其他组），概要行与快捷继续保留', async () => {
    const docs = Array.from({ length: 3 }, (_, i) => `docs/报告-${i}.md`)
    const charts = ['charts/a.json']
    stubArtifacts([...docs, ...charts].map((p) => ({ path: p, kind: p.endsWith('.md') ? 'markdown' : 'code', size: 1024 })))
    const tail = agentMsg('m1', 'pm', { turnIndex: 0, mentions: ['user'], artifacts: [...docs, ...charts] })
    useSessionStore.setState({ byId: new Map([[tail.id, tail]]), order: [tail.id] })

    const { container } = render(<CloseoutCard />)
    const collapse = screen.getByRole('button', { name: '收起交付清单' })
    expect(container.querySelectorAll('[data-delivery-row]')).toHaveLength(3)
    // 「其他」先展开：验证整体折叠将其暂时隐藏且状态保留
    await userEvent.click(screen.getByRole('button', { name: '其他 1 件' }))
    expect(container.querySelectorAll('[data-delivery-row]')).toHaveLength(4)

    // 整体收起：文件行清零；概要（件数）与快捷继续保留
    await userEvent.click(collapse)
    expect(collapse).toHaveAttribute('aria-expanded', 'false')
    expect(container.querySelectorAll('[data-delivery-row]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-delivery-group]')).toHaveLength(0)
    expect(screen.getByText('4 件')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '继续推进' })).toBeInTheDocument()

    // 再点恢复：整清单回位，「其他」保持展开状态
    await userEvent.click(screen.getByRole('button', { name: '展开交付清单' }))
    expect(container.querySelectorAll('[data-delivery-row]')).toHaveLength(4)
    expect(screen.getByRole('button', { name: '其他 1 件' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('最终交付按重要度排序（文档 > 源码 > 数据），过程目录（charts/）默认折叠', async () => {
    const paths = [
      'charts/sh000688-day-1.json',
      'src/app.ts',
      '回测数据.csv',
      'docs/基本面分析-增长主线.md',
      'docs/技术面分析-增长主线.md',
    ]
    stubArtifacts(paths.map((p, i) => ({ path: p, kind: 'markdown', size: 1024 * (i + 1) })))
    const tail = agentMsg('m1', 'pm', { turnIndex: 0, mentions: ['user'], artifacts: paths })
    useSessionStore.setState({ byId: new Map([[tail.id, tail]]), order: [tail.id] })

    const { container } = render(<CloseoutCard />)
    const rows = [...container.querySelectorAll('[data-delivery-row]')].map((el) => el.getAttribute('data-delivery-row'))
    expect(rows).toEqual(['docs/基本面分析-增长主线.md', 'docs/技术面分析-增长主线.md', 'src/app.ts', '回测数据.csv'])
    // 元数据补齐（kind / size）后体积就位（同时收敛 fetch 异步更新）
    expect(await screen.findByText('2.0KB')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '其他 1 件' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('全为过程产物：主区为空，「其他」默认展开（卡片不空），箭头可收起', async () => {
    const paths = ['charts/a.json', 'charts/b.json']
    stubArtifacts(paths.map((p) => ({ path: p, kind: 'code', size: 1024 })))
    const tail = agentMsg('m1', 'pm', { turnIndex: 0, mentions: ['user'], artifacts: paths })
    useSessionStore.setState({ byId: new Map([[tail.id, tail]]), order: [tail.id] })

    const { container } = render(<CloseoutCard />)
    expect(container.querySelectorAll('[data-delivery-group="primary"]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-delivery-row]')).toHaveLength(2)
    expect(screen.getByRole('button', { name: '其他 2 件' })).toHaveAttribute('aria-expanded', 'true')

    await userEvent.click(screen.getByRole('button', { name: '其他 2 件' }))
    expect(container.querySelectorAll('[data-delivery-row]')).toHaveLength(0)
  })

  it('交付件后补（run:end 快照回填）：指纹含计数 → 清单随补全出现', async () => {
    stubArtifacts([{ path: 'docs/需求文档-登录.md', kind: 'markdown', size: 2048 }])
    // 流式期：尾条已完成 @用户，但消息尚无 artifacts（与服务端事件分工一致）
    const before = agentMsg('m1', 'pm', { turnIndex: 0, mentions: ['user'] })
    useSessionStore.setState({ byId: new Map([['m1', before]]), order: ['m1'] })

    const { container } = render(<CloseoutCard />)
    expect(container.querySelector('[data-delivery-manifest]')).toBeNull()

    // run:end → refreshMessages：同一批消息以新对象回填（id / 状态不变 → 指纹仅计数位变化）
    const after = agentMsg('m1', 'pm', { turnIndex: 0, mentions: ['user'], artifacts: ['docs/需求文档-登录.md'] })
    act(() => {
      useSessionStore.setState({ byId: new Map([['m1', after]]), order: ['m1'] })
    })

    expect(container.querySelector('[data-delivery-manifest]')).not.toBeNull()
    expect(screen.getByText('本轮交付')).toBeInTheDocument()
    expect(await screen.findByText('2.0KB')).toBeInTheDocument()
  })
})
