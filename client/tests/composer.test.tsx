/**
 * Composer 键盘交互：@ 补全菜单（开启 / 过滤 / 键盘选择 / 关闭）+ M11 指挥台成员条
 * + ADR 0135 成员条统一常驻（全场景一致展示，M52-G 席位让位判定已撤销）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentDefinition, AgentGroup } from '@multi-agent/shared'
import { Composer } from '../src/components/chat/Composer'
import { useAgentStore } from '../src/stores/agent-store'
import { useSceneStore } from '../src/stores/scene-store'
import { useSessionStore } from '../src/stores/session-store'

function makeAgent(id: string, name: string, role: string, group = 'development'): AgentDefinition {
  return {
    id,
    name,
    role,
    title: role,
    description: '',
    capabilities: [],
    group,
    avatar: { gradient: ['#3b82f6', '#f59e0b'], icon: 'user' },
    handoff: [],
  }
}

/** M52-G 让位判定用场景构造（chain / defaultSkills 等字段与判定无关） */
function makeGroup(id: string, stage?: AgentGroup['stage']): AgentGroup {
  return {
    id,
    name: id,
    description: '',
    icon: 'users',
    theme: ['#3b82f6', '#f59e0b'],
    objective: '',
    chain: [],
    defaultSkills: [],
    parallel: false,
    rounds: false,
    order: 0,
    ...(stage ? { stage } : {}),
  }
}

/** 替换当前会话编制（成员条场景用例用；M79-M 起支持 kind——人物会话边界用例） */
function setSession(participantIds: string[], kind?: 'team' | 'direct' | 'group'): void {
  useSessionStore.setState({
    sessions: [
      {
        id: 's1',
        title: '测试会话',
        participantIds,
        ...(kind ? { kind } : {}),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 0,
      },
    ],
    currentId: 's1',
  })
}

beforeEach(() => {
  // 底栏上下文电池（ContextBar）挂载即拉取快照：stub 网络为常挂起，避免真实请求与 act 警告
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
  // 草稿持久化（M8）会写 localStorage：清空避免用例间串扰
  localStorage.clear()
  useAgentStore.setState({
    agents: [makeAgent('architect', '艾达', '架构师'), makeAgent('pm', '费利', '产品经理')],
    groups: [],
    skills: [],
    loaded: true,
    loading: false,
    statuses: {},
  })
  useSceneStore.setState({ listMode: false })
  useSessionStore.setState({
    sessions: [
      {
        id: 's1',
        title: '测试会话',
        participantIds: ['architect', 'pm'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 0,
      },
    ],
    currentId: 's1',
    byId: new Map(),
    order: [],
    loadingSessions: false,
    loadingMessages: false,
    artifactVersion: 0,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Composer @ 自动补全', () => {
  it('输入 @ 打开候选菜单，并展示会话成员', async () => {
    const user = userEvent.setup()
    render(<Composer />)
    const box = screen.getByRole('textbox')
    await user.type(box, '@')
    expect(await screen.findByText('召唤成员')).toBeInTheDocument()
    // 候选菜单内的成员（指挥条也含成员名，故限定在 listbox 内断言；匹配高亮会拆分文本节点）
    const menu = screen.getByRole('listbox')
    expect(menu.textContent).toContain('艾达')
    expect(menu.textContent).toContain('费利')
  })

  it('按查询过滤候选，Enter 补全插入 @名字', async () => {
    const user = userEvent.setup()
    render(<Composer />)
    const box = screen.getByRole('textbox')
    await user.type(box, '@艾')
    const menu = screen.getByRole('listbox')
    expect(menu.textContent).toContain('艾达')
    expect(menu.textContent).not.toContain('费利')

    await user.keyboard('{Enter}')
    expect(box).toHaveValue('@艾达 ')
    expect(screen.queryByText('召唤成员')).not.toBeInTheDocument()
  })

  it('ArrowDown 移动高亮，Enter 选中第二项', async () => {
    const user = userEvent.setup()
    render(<Composer />)
    const box = screen.getByRole('textbox')
    await user.type(box, '@')
    await user.keyboard('{ArrowDown}{Enter}')
    expect(box).toHaveValue('@费利 ')
  })

  it('Escape 关闭菜单', async () => {
    const user = userEvent.setup()
    render(<Composer />)
    const box = screen.getByRole('textbox')
    await user.type(box, '@')
    expect(await screen.findByText('召唤成员')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByText('召唤成员')).not.toBeInTheDocument()
  })

  it('@ 前是普通字符（邮箱样式）不触发菜单', async () => {
    const user = userEvent.setup()
    render(<Composer />)
    const box = screen.getByRole('textbox')
    await user.type(box, 'mail@a')
    expect(screen.queryByText('召唤成员')).not.toBeInTheDocument()
    expect(box).toHaveValue('mail@a')
  })

  it('无匹配候选时不展示菜单', async () => {
    const user = userEvent.setup()
    render(<Composer />)
    const box = screen.getByRole('textbox')
    await user.type(box, '@z')
    expect(screen.queryByText('召唤成员')).not.toBeInTheDocument()
  })
})

describe('M11 指挥台与首棒语义提示', () => {
  it('指挥条：点击成员 chip 插入 @名字', async () => {
    const user = userEvent.setup()
    render(<Composer />)
    const chip = screen.getByTitle(/召唤 艾达/)
    await user.click(chip)
    expect(screen.getByRole('textbox')).toHaveValue('@艾达 ')
  })

  it('行首 @ 提示「指定首棒」，行内 @ 提示「仅提及」', async () => {
    const user = userEvent.setup()
    render(<Composer />)
    const box = screen.getByRole('textbox')
    await user.type(box, '@')
    expect(await screen.findByText('行首 @ 指定首棒')).toBeInTheDocument()

    // 行内（前有空格）@：语义提示切换为「仅提及」
    await user.clear(box)
    await user.type(box, '请 x @')
    const menu = screen.getByRole('listbox')
    expect(within(menu).getByText('行内 @ 仅提及')).toBeInTheDocument()
  })
})

describe('ADR 0135 成员条统一常驻（全场景一致展示）', () => {
  /** 谈判桌 arena 编制：谭成（左席）/ 祁弈（右席）+ 苏纵（教练，未入席） */
  function setupArena(participantIds: string[]): void {
    useAgentStore.setState({
      agents: [
        makeAgent('negotiator', '谭成', '谈判手', 'negotiation'),
        makeAgent('counterpart', '祁弈', '对手模拟', 'negotiation'),
        makeAgent('coach', '苏纵', '谈判教练', 'negotiation'),
      ],
      groups: [
        makeGroup('negotiation', { layout: 'arena', seats: { left: ['negotiator'], right: ['counterpart'] } }),
      ],
    })
    setSession(participantIds)
  }

  it('arena 全员入席：成员条照常展示（与席位并存，点击插入 @名字）', async () => {
    setupArena(['negotiator', 'counterpart'])
    render(<Composer />)
    const user = userEvent.setup()
    await user.click(screen.getByTitle(/召唤 谭成/))
    expect(screen.getByRole('textbox')).toHaveValue('@谭成 ')
  })

  it('arena 部分入席：成员条同样展示（全员可见可召唤）', () => {
    setupArena(['negotiator', 'counterpart', 'coach'])
    render(<Composer />)
    expect(screen.getByTitle(/召唤 谭成/)).not.toBeNull()
    expect(screen.getByTitle(/召唤 苏纵/)).not.toBeNull()
  })

  it('roundtable：席位环展示不取代成员条（统一常驻）', () => {
    useAgentStore.setState({
      agents: [makeAgent('facilitator', '梅森', '主持人', 'brainstorm')],
      groups: [makeGroup('brainstorm', { layout: 'roundtable' })],
    })
    setSession(['facilitator'])
    render(<Composer />)
    expect(screen.getByTitle(/召唤 梅森/)).not.toBeNull()
  })

  it('stream：无席位载体，成员条照常展示', () => {
    useAgentStore.setState({ groups: [makeGroup('development')] })
    render(<Composer />)
    expect(screen.getByTitle(/召唤 艾达/)).not.toBeNull()
  })

  it('arena 切回纯列表：成员条照常展示', () => {
    setupArena(['negotiator', 'counterpart'])
    useSceneStore.setState({ listMode: true })
    render(<Composer />)
    expect(screen.getByTitle(/召唤 谭成/)).not.toBeNull()
  })
})

describe('M79-M：人物会话成员条边界（不再展示全量 agent 兜底）', () => {
  it('direct 聊天（无 agent 编制）：不出现任何「召唤 X」agent 条目（纯人聊天 @agent 不触发，防误导）', () => {
    setSession([], 'direct')
    render(<Composer />)
    expect(screen.queryByTitle(/召唤 艾达/)).toBeNull()
    expect(screen.queryByTitle(/召唤 费利/)).toBeNull()
  })

  it('group 聊天（无 agent 编制）：同收口', () => {
    setSession([], 'group')
    render(<Composer />)
    expect(screen.queryByTitle(/召唤 艾达/)).toBeNull()
  })

  it('混编群（agent 入编）：仅展示在编 agent（正常召唤）', () => {
    setSession(['pm'], 'group')
    render(<Composer />)
    expect(screen.getByTitle(/召唤 费利/)).not.toBeNull()
    expect(screen.queryByTitle(/召唤 艾达/)).toBeNull()
  })

  it('team / 场景空编制：保留全量兜底（M48 零选择开场召唤面，回归）', () => {
    setSession([])
    render(<Composer />)
    expect(screen.getByTitle(/召唤 艾达/)).not.toBeNull()
    expect(screen.getByTitle(/召唤 费利/)).not.toBeNull()
  })
})

describe('M79-P：纯人聊天隐藏 AI 状态条（范式 chips / 上下文与费用 / 轨迹）', () => {
  it('direct 无 agent：不渲染范式 chips；快捷键提示仍保留', () => {
    setSession([], 'direct')
    render(<Composer />)
    expect(screen.queryByRole('button', { name: '执行' })).toBeNull()
    expect(screen.queryByRole('button', { name: '规划' })).toBeNull()
    expect(screen.queryByRole('button', { name: '评审' })).toBeNull()
    expect(screen.getByText(/Enter 发送/)).toBeTruthy()
  })

  it('group 无 agent：同收口；混编群（有 agent）：状态条保留', () => {
    setSession([], 'group')
    const first = render(<Composer />)
    expect(screen.queryByRole('button', { name: '执行' })).toBeNull()
    first.unmount()

    setSession(['pm'], 'group')
    render(<Composer />)
    expect(screen.getByRole('button', { name: '执行' })).toBeTruthy()
  })

  it('team / 场景会话（含空编制）：状态条保留（回归）', () => {
    setSession([])
    render(<Composer />)
    expect(screen.getByRole('button', { name: '执行' })).toBeTruthy()
  })
})
