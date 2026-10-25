/**
 * 场景 / 角色 / 预设目录（展示元数据与「发现 → 启用」）：
 * - 索引口径：场景默认团队取 chain、扩展专家取同场景其余角色；预设关联场景由真实成员推导；
 * - 搜索：名称 / 职责 / id 权重最高，能力与关键词次之，描述 / 资料 / 交付最后；多词取交集；
 * - 目录页：页签数量取真实数据、分类筛选、无效详情空态、预设比较上限 3、使用只预选不建会话。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentDefinition, AgentGroup, RosterPreset } from '@multi-agent/shared'
import { AgentsDirectory } from '../src/pages/AgentsDirectory'
import { buildCatalog, catalogHash, searchCatalog } from '../src/lib/catalog'
import { useAgentStore } from '../src/stores/agent-store'
import { useUiStore } from '../src/stores/ui-store'

function agent(overrides: Partial<AgentDefinition> & { id: string; name: string }): AgentDefinition {
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

function group(overrides: Partial<AgentGroup> & { id: string; name: string }): AgentGroup {
  return {
    description: '',
    objective: '',
    icon: 'briefcase',
    theme: ['#6366f1', '#818cf8'],
    chain: [],
    defaultSkills: [],
    parallel: false,
    rounds: true,
    order: 10,
    ...overrides,
  }
}

const CHIEF = agent({ id: 'chief', name: '柏川', role: '幕僚长', group: 'strategy', description: '把分歧收敛成决策' })
const INSIGHT = agent({
  id: 'insight',
  name: '甄明',
  role: '经营分析师',
  group: 'strategy',
  capabilities: ['指标归因', '经营解释'],
  catalog: { keywords: ['经营复盘'], inputs: ['经营数据'], outputs: ['归因结论'], boundary: '不替代财务核算' },
})
const FINANCE = agent({ id: 'finance', name: '周正', role: '财务管家', group: 'finance' })

const STRATEGY = group({
  id: 'strategy',
  name: '商业战略',
  chain: ['chief'],
  category: 'business',
  catalog: { keywords: ['战略'], inputs: ['背景'], outputs: ['战略路径'] },
})
const FINANCE_SCENE = group({
  id: 'finance',
  name: '财务法务',
  chain: ['finance'],
  order: 20,
  // 未知分类：展示回退「其他」
  category: 'unknown-category',
})

const WEEKLY: RosterPreset = {
  id: 'weekly-review',
  name: '周经营例会',
  description: '财务、增长与经营指标复盘',
  icon: 'calendar-clock',
  theme: ['#6366f1', '#818cf8'],
  members: ['chief', 'finance', 'insight'],
  prompt: '主持本周经营例会：先对口径，再解释指标波动。',
  order: 10,
  category: 'business',
  catalog: { keywords: ['例会'], inputs: ['经营数据'], outputs: ['经营简报'] },
}

const LAUNCH: RosterPreset = {
  id: 'product-launch',
  name: '产品发布',
  description: '需求到上线一条龙',
  icon: 'rocket',
  theme: ['#0ea5e9', '#38bdf8'],
  members: ['chief', 'insight'],
  prompt: '发一轮产品发布。',
  order: 20,
  category: 'business',
}

const CATALOG = buildCatalog([CHIEF, INSIGHT, FINANCE], [STRATEGY, FINANCE_SCENE], [WEEKLY, LAUNCH])

beforeEach(() => {
  useUiStore.setState({ appView: 'workspace', pendingCreate: undefined, mainTab: 'chat' })
  useAgentStore.setState({
    agents: [CHIEF, INSIGHT, FINANCE],
    groups: [STRATEGY, FINANCE_SCENE],
    presets: [WEEKLY, LAUNCH],
    skills: [],
    loaded: true,
    loading: false,
    statuses: {},
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/agents') {
        return new Response(
          JSON.stringify({ agents: [CHIEF, INSIGHT, FINANCE], groups: [STRATEGY, FINANCE_SCENE], presets: [WEEKLY, LAUNCH] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ skills: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  window.history.replaceState(null, '', '#/agents')
})

describe('目录索引：团队、专家与关联场景', () => {
  it('场景默认团队取 chain，扩展专家取同场景其余角色（不隐藏）', () => {
    const scene = CATALOG.find((e) => e.key === 'scene:strategy')!
    expect(scene.members.map((a) => a.id)).toEqual(['chief'])
    expect(scene.experts.map((a) => a.id)).toEqual(['insight'])
    expect(CATALOG.find((e) => e.key === 'agent:insight')!.isDefault).toBe(true)
  })

  it('预设关联场景由真实成员推导；角色分类继承所属场景', () => {
    const preset = CATALOG.find((e) => e.key === 'preset:weekly-review')!
    expect(preset.groups.map((g) => g.id)).toEqual(['strategy', 'finance'])
    expect(preset.category).toBe('business')
    expect(CATALOG.find((e) => e.key === 'agent:chief')!.category).toBe('business')
    // 未知分类回退「其他」
    expect(CATALOG.find((e) => e.key === 'scene:finance')!.category).toBe('other')
  })
})

describe('目录搜索：命中权重与筛选', () => {
  it('名称 / 职责命中排在描述命中之前', () => {
    const hits = searchCatalog(CATALOG, '财务', 'all', 'agent').map((e) => e.id)
    // 周正：姓名「周正」不含财务，但职责「财务管家」命中；柏川描述不含
    expect(hits[0]).toBe('finance')
  })

  it('多词取交集；分类筛选与未知关键词给出空结果', () => {
    expect(searchCatalog(CATALOG, '经营 归因', 'all', 'agent').map((e) => e.id)).toEqual(['insight'])
    expect(searchCatalog(CATALOG, '经营', 'other', 'agent')).toEqual([])
    expect(searchCatalog(CATALOG, '不存在的关键词')).toEqual([])
  })

  it('展示元数据进入搜索文本（资料 / 交付）', () => {
    expect(searchCatalog(CATALOG, '经营简报', 'all', 'preset').map((e) => e.id)).toEqual(['weekly-review'])
    expect(searchCatalog(CATALOG, '归因结论', 'all', 'agent').map((e) => e.id)).toEqual(['insight'])
  })

  it('目录 hash 省略空值', () => {
    expect(catalogHash({ tab: 'preset', q: '', category: undefined, detail: 'preset:x' })).toBe(
      '#/agents?tab=preset&detail=preset%3Ax',
    )
  })
})

describe('目录页：页签、空态与详情', () => {
  it('页签数量取真实资产，搜索无结果可清除筛选', async () => {
    render(<AgentsDirectory />)
    expect(await screen.findByRole('button', { name: /场景 · 2/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /角色 · 3/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /预设 · 2/ })).toBeInTheDocument()

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('搜索场景角色预设'), '不存在的关键词')
    expect(screen.getByText('没有匹配结果，试试其他关键词或分类。')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '清除筛选' }))
    await waitFor(() => expect(screen.getAllByText('商业战略').length).toBeGreaterThan(0))
  })

  it('非法详情 id 给出明确空态', async () => {
    window.history.replaceState(null, '', '#/agents?tab=preset&detail=preset:ghost')
    render(<AgentsDirectory />)
    expect(await screen.findByText('该资产不存在或已下线。请关闭详情后重新选择。')).toBeInTheDocument()
    expect(screen.getByText('资产不存在')).toBeInTheDocument()
  })
})

describe('目录页：预设比较与使用', () => {
  it('最多比较三个预设，第四个只给提示不加入', async () => {
    const extra = { ...LAUNCH, id: 'p3', name: '第三个', order: 30 }
    const extra2 = { ...LAUNCH, id: 'p4', name: '第四个', order: 40 }
    useAgentStore.setState({ presets: [WEEKLY, LAUNCH, extra, extra2] })
    window.history.replaceState(null, '', '#/agents?tab=preset')
    render(<AgentsDirectory />)

    const user = userEvent.setup()
    const next = (): HTMLElement => screen.getAllByRole('button', { name: '加入比较' })[0]
    await user.click((await screen.findAllByRole('button', { name: '加入比较' }))[0])
    await user.click(next())
    await user.click(next())
    expect(screen.getByText('已选 3 / 3 个预设')).toBeInTheDocument()
    await user.click(next())
    expect(screen.getByText('最多比较三个预设，请先移除一个。')).toBeInTheDocument()
  })

  it('使用预设 → 只预选来源并带上草稿，不创建会话', async () => {
    window.history.replaceState(null, '', '#/agents?tab=preset&detail=preset:weekly-review')
    render(<AgentsDirectory />)

    const dialog = await screen.findByRole('dialog')
    const user = userEvent.setup()
    await user.click(within(dialog).getByRole('button', { name: '使用预设' }))

    expect(useUiStore.getState().pendingCreate).toMatchObject({ kind: 'preset', id: 'weekly-review' })
    expect(useUiStore.getState().pendingCreate?.draft).toBe(WEEKLY.prompt)
    expect(useUiStore.getState().appView).toBe('workspace')
    expect(useUiStore.getState().mainTab).toBe('chat')
  })
})
