/**
 * M26 前端测试：ActivityRail 切换 appView、AgentConsole 新建向导、AgentEditor 保存语义（三态 null）、
 * SkillEditor 保存、ValidateBanner 徽章与展开清单。mock fetch + 真实 store（console-store / ui-store / agent-store）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentGroup, ConsoleAgentDetail, ConsoleSkillDetail } from '@multi-agent/shared'
import { ActivityRail } from '../src/components/console/ActivityRail'
import { AgentConsole } from '../src/components/console/AgentConsole'
import { AgentEditor } from '../src/components/console/AgentEditor'
import { SkillConsole } from '../src/components/console/SkillConsole'
import { SkillEditor } from '../src/components/console/SkillEditor'
import { ValidateBanner } from '../src/components/console/ValidateBanner'
import { TooltipProvider } from '../src/components/ui/tooltip'
import { useAgentStore } from '../src/stores/agent-store'
import { useAuthStore } from '../src/stores/auth-store'
import { useConsoleStore } from '../src/stores/console-store'
import { useUiStore } from '../src/stores/ui-store'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

const GROUP: AgentGroup = {
  id: 'development',
  name: '研发团队',
  description: '测试场景',
  icon: 'code',
  theme: ['#3b82f6', '#60a5fa'],
  objective: '',
  chain: [],
  defaultSkills: [],
  parallel: false,
  rounds: false,
  order: 10,
}

const AGENT_DETAIL: ConsoleAgentDetail = {
  id: 'pm',
  name: '产品经理',
  role: '产品经理',
  title: '需求负责人',
  description: '负责需求',
  group: 'development',
  avatar: { icon: 'clipboard-list', gradient: ['#6366f1', '#818cf8'] },
  hasAvatar: false,
  skillCount: -1,
  toolCount: -1,
  soulCount: 0,
  handoffCount: 0,
  refCount: 0,
  meta: {
    id: 'pm',
    name: '产品经理',
    role: '产品经理',
    title: '需求负责人',
    description: '负责需求',
    capabilities: ['需求拆解'],
    avatar: { icon: 'clipboard-list', gradient: ['#6366f1', '#818cf8'] },
    group: 'development',
    handoff: [],
  },
  body: '## 职责\n\n测试正文。',
  souls: [],
  refs: { items: [] },
}

const SKILL_DETAIL: ConsoleSkillDetail = {
  name: 'report',
  description: '写周报时使用',
  tags: ['汇报'],
  lineCount: 3,
  usedByAgents: [],
  usedByGroups: [],
  body: '# report\n\n步骤。',
  refs: { items: [] },
}

/** 默认 mock：空列表 + 空校验（各用例按需覆盖特定 URL） */
function defaultFetch(url: string): Response {
  if (url === '/api/agents') return jsonResponse({ agents: [], groups: [], presets: [] })
  if (url === '/api/skills') return jsonResponse({ skills: [] })
  if (url === '/api/console/agents') return jsonResponse({ agents: [] })
  if (url === '/api/console/skills') return jsonResponse({ skills: [] })
  if (url === '/api/console/groups') return jsonResponse({ groups: [] })
  if (url === '/api/console/tools') return jsonResponse({ tools: [] })
  if (url === '/api/console/validate') return jsonResponse({ issues: [] })
  return jsonResponse({}, 404)
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation((url: string) => Promise.resolve(defaultFetch(url)))
  localStorage.removeItem('ma:appView')
  useUiStore.setState({ appView: 'workspace' })
  useAgentStore.setState({ agents: [], groups: [], presets: [], skills: [], loaded: false, loading: false, statuses: {} })
  useConsoleStore.setState({ agents: [], skills: [], groups: [], tools: [], issues: [], loading: false })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('M26：ActivityRail', () => {
  it('点击图标切换 appView（含 localStorage 持久化与 aria-current）', async () => {
    // M57：管理面入口（Agent / Skill / 连接）仅 admin 可见——本用例验证 admin 视角
    useAuthStore.setState({ isAdmin: true })
    render(
      <TooltipProvider>
        <ActivityRail />
      </TooltipProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Agent 管理' }))
    expect(useUiStore.getState().appView).toBe('agents')
    expect(localStorage.getItem('ma:appView')).toBe('agents')
    expect(screen.getByRole('button', { name: 'Agent 管理' }).getAttribute('aria-current')).toBe('page')

    await userEvent.click(screen.getByRole('button', { name: 'Skill 管理' }))
    expect(useUiStore.getState().appView).toBe('skills')

    // M26 延伸：连接管理（自右栏迁入 rail 控制台）
    await userEvent.click(screen.getByRole('button', { name: '连接管理' }))
    expect(useUiStore.getState().appView).toBe('connections')

    await userEvent.click(screen.getByRole('button', { name: '工作台' }))
    expect(useUiStore.getState().appView).toBe('workspace')
  })
})

describe('M26：AgentEditor', () => {
  it('加载详情 → 改名 → 保存：tools/skills/model/temperature 恢复三态（null）', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/console/agents/pm' && init?.method === 'PUT') {
        return Promise.resolve(jsonResponse({ agent: { ...AGENT_DETAIL, name: '产品经理改' } }))
      }
      if (url === '/api/console/agents/pm') return Promise.resolve(jsonResponse({ agent: AGENT_DETAIL }))
      return Promise.resolve(defaultFetch(url))
    })
    const onClose = vi.fn()
    render(<AgentEditor agentId="pm" onClose={onClose} />)

    const nameInput = (await screen.findByLabelText('角色名')) as HTMLInputElement
    expect(nameInput.value).toBe('产品经理')
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, '产品经理改')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      const put = calls.find((c) => c.url === '/api/console/agents/pm' && c.init?.method === 'PUT')
      expect(put).toBeTruthy()
      const body = JSON.parse(String(put!.init?.body)) as Record<string, unknown>
      expect(body.name).toBe('产品经理改')
      expect(body.role).toBe('产品经理')
      expect(body.tools).toBeNull()
      expect(body.skills).toBeNull()
      expect(body.model).toBeNull()
      expect(body.temperature).toBeNull()
      expect(body.soul).toBe('')
      expect(body.body).toBe('## 职责\n\n测试正文。')
    })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})

describe('M26：AgentConsole 新建向导', () => {
  it('选场景 → 基本信息 → 创建：POST 入参正确，创建后打开编辑器', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const created: ConsoleAgentDetail = { ...AGENT_DETAIL, id: 'critic', name: '挑刺官', role: '质量评审' }
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/console/groups') return Promise.resolve(jsonResponse({ groups: [GROUP] }))
      if (url === '/api/console/agents' && init?.method === 'POST') return Promise.resolve(jsonResponse({ agent: created }))
      if (url === '/api/console/agents/critic') return Promise.resolve(jsonResponse({ agent: created }))
      return Promise.resolve(defaultFetch(url))
    })
    render(<AgentConsole />)

    await userEvent.click(await screen.findByRole('button', { name: /新建 Agent/ }))
    // 第 1 步：场景选择
    await userEvent.click(await screen.findByRole('radio', { name: /研发团队/ }))
    await userEvent.click(screen.getByRole('button', { name: '下一步' }))
    // 第 2 步：基本信息
    await userEvent.type(screen.getByLabelText('角色 id'), 'critic')
    await userEvent.type(screen.getByLabelText('角色名'), '挑刺官')
    await userEvent.type(screen.getByLabelText('角色徽标'), '质量评审')
    await userEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => {
      const post = calls.find((c) => c.url === '/api/console/agents' && c.init?.method === 'POST')
      expect(post).toBeTruthy()
      const body = JSON.parse(String(post!.init?.body)) as Record<string, unknown>
      expect(body.id).toBe('critic')
      expect(body.group).toBe('development')
      expect(body.newGroup).toBeUndefined()
      expect(body.name).toBe('挑刺官')
      expect(body.role).toBe('质量评审')
      expect(body.tools).toBeNull()
      expect(body.skills).toBeNull()
      expect(String(body.body).length).toBeGreaterThan(0)
    })
    // 创建成功后进入编辑器（详情 GET 被调用）
    await waitFor(() => {
      expect(calls.some((c) => c.url === '/api/console/agents/critic')).toBe(true)
    })
  })

  it('非法 id 在向导内联报错，不发 POST', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/console/groups') return Promise.resolve(jsonResponse({ groups: [GROUP] }))
      return Promise.resolve(defaultFetch(url))
    })
    render(<AgentConsole />)

    await userEvent.click(await screen.findByRole('button', { name: /新建 Agent/ }))
    await userEvent.click(await screen.findByRole('radio', { name: /研发团队/ }))
    await userEvent.click(screen.getByRole('button', { name: '下一步' }))
    await userEvent.type(screen.getByLabelText('角色 id'), 'Bad Id')
    await userEvent.type(screen.getByLabelText('角色名'), 'x')
    await userEvent.type(screen.getByLabelText('角色徽标'), 'y')
    await userEvent.click(screen.getByRole('button', { name: '创建' }))

    expect(await screen.findByText(/角色 id 需小写字母开头/)).toBeTruthy()
    expect(calls.some((c) => c.url === '/api/console/agents' && c.init?.method === 'POST')).toBe(false)
  })
})

describe('M26：SkillEditor', () => {
  it('加载技能 → 修改 description → 保存 PUT（含 tags / body）', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/console/skills/report' && init?.method === 'PUT') {
        return Promise.resolve(jsonResponse({ skill: { ...SKILL_DETAIL, description: '写周报时使用（新）' } }))
      }
      if (url === '/api/console/skills/report') return Promise.resolve(jsonResponse({ skill: SKILL_DETAIL }))
      return Promise.resolve(defaultFetch(url))
    })
    const onClose = vi.fn()
    render(<SkillEditor name="report" onClose={onClose} />)

    const desc = (await screen.findByLabelText('技能描述')) as HTMLInputElement
    expect(desc.value).toBe('写周报时使用')
    await userEvent.clear(desc)
    await userEvent.type(desc, '写周报时使用（新）')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      const put = calls.find((c) => c.url === '/api/console/skills/report' && c.init?.method === 'PUT')
      expect(put).toBeTruthy()
      const body = JSON.parse(String(put!.init?.body)) as Record<string, unknown>
      expect(body.description).toBe('写周报时使用（新）')
      expect(body.tags).toEqual(['汇报'])
      expect(body.body).toBe('# report\n\n步骤。')
    })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})

describe('M26：ValidateBanner', () => {
  it('问题计数徽章 → 展开清单 → 重新校验后转为通过态', async () => {
    useConsoleStore.setState({
      issues: [
        { level: 'error', path: 'agents/a/AGENT.md', message: 'id 与目录名不一致' },
        { level: 'warning', path: 'skills/report/SKILL.md', message: '正文为空' },
      ],
    })
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/console/validate') return Promise.resolve(jsonResponse({ issues: [] }))
      return Promise.resolve(defaultFetch(url))
    })
    render(<ValidateBanner />)

    await userEvent.click(screen.getByRole('button', { name: /1 个错误 · 1 个警告/ }))
    expect(screen.getByText('id 与目录名不一致')).toBeTruthy()
    expect(screen.getByText('正文为空')).toBeTruthy()
    expect(screen.getByText('agents/a/AGENT.md')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /重新校验/ }))
    await waitFor(() => expect(useConsoleStore.getState().issues).toEqual([]))
    expect(await screen.findByRole('button', { name: /资产校验通过/ })).toBeTruthy()
  })
})

describe('M26+：Agent Studio AI 生成', () => {
  const DRAFT = {
    id: 'bot-x',
    name: '测试角色',
    role: '测试岗',
    title: 'Test Bot',
    description: '一句话职责',
    capabilities: ['能力一'],
    group: 'development',
    avatar: { icon: 'sparkles', gradient: ['#111111', '#222222'] as [string, string] },
    handoff: ['pm'],
    skills: ['prd-authoring'],
    temperature: 0.5,
    body: '## 职责\n\n生成正文。\n\n## 专业判断\n\n生成正文。',
  }

  it('AgentConsole：AI 生成 → 填入新建向导（step2 预填 id / name / 正文）', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/console/generate/agent' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            draft: DRAFT,
            issues: ['「协作接口」段过短（1 字，需 ≥60）'],
            attempts: 2,
            model: 'test-model',
          }),
        )
      }
      if (url === '/api/console/groups') return Promise.resolve(jsonResponse({ groups: [GROUP] }))
      return Promise.resolve(defaultFetch(url))
    })
    render(<AgentConsole />)

    await userEvent.click(screen.getByRole('button', { name: 'AI 生成' }))
    await userEvent.type(screen.getByLabelText('角色描述'), '做一个测试角色')
    await userEvent.click(screen.getByRole('button', { name: '生成' }))

    // 结果区：名称 / issues / 轮次
    expect(await screen.findByText(/已生成/)).toBeTruthy()
    expect(screen.getByText('「协作接口」段过短（1 字，需 ≥60）')).toBeTruthy()
    expect(screen.getByText(/第 2 轮通过/)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '填入新建向导' }))
    // 向导 step2：id / name 已预填
    await waitFor(() => expect(screen.getByDisplayValue('bot-x')).toBeTruthy())
    expect(screen.getByDisplayValue('测试角色')).toBeTruthy()
    // POST 只提交描述（草稿不落盘）
    const post = calls.find((c) => c.url === '/api/console/generate/agent' && c.init?.method === 'POST')
    expect(JSON.parse(String(post!.init!.body))).toEqual({ description: '做一个测试角色' })
  })

  it('SkillConsole：AI 生成 → 直接创建（POST /skills 带生成正文与标签）', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/console/generate/skill' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            draft: {
              name: 'weekly-report',
              description: '周报写作时使用',
              tags: ['writing'],
              body: '# 周报手册\n\n正文。',
            },
            issues: [],
            attempts: 1,
            model: 'test-model',
          }),
        )
      }
      if (url === '/api/console/skills' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ skill: { ...SKILL_DETAIL, name: 'weekly-report' } }))
      }
      return Promise.resolve(defaultFetch(url))
    })
    render(<SkillConsole />)

    await userEvent.click(screen.getByRole('button', { name: '新建 Skill' }))
    await userEvent.type(screen.getByLabelText('技能诉求'), '帮我做一个周报技能')
    await userEvent.click(screen.getByRole('button', { name: 'AI 生成并创建' }))

    await waitFor(() => {
      const post = calls.find((c) => c.url === '/api/console/skills' && c.init?.method === 'POST')
      expect(post).toBeTruthy()
      expect(JSON.parse(String(post!.init!.body))).toEqual({
        name: 'weekly-report',
        description: '周报写作时使用',
        tags: ['writing'],
        body: '# 周报手册\n\n正文。',
      })
    })
  })
})
