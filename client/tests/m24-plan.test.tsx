/**
 * M24：协作范式（规划 / 执行 / 评审）前端 —— 计划与评审的客户端回归。
 * 覆盖四组：
 * - plan-store：load 绑定与竞态守卫 / applyPlan 归约、排序与迟到回包守卫 / applyReview 幂等 / updatePlan / resolve（launched 挂接执行 Run）；
 * - PlanReviewCard：待批准卡渲染 / 就地改指派保存 / 批准（含 dirty 先保存）/ 驳回带反馈；
 * - TaskView 2.0：无计划清单形态 / 有计划计划板形态 / 按成员分组 / 「规划先行」会话开关；
 * - Composer 范式选择器：默认执行（不传 mode）/ 选「规划」发送携带 mode 并发送后复位 / 运行中禁用 / 规划先行提示。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  AgentDefinition,
  ChatMessage,
  Plan,
  ReviewRecord,
  Session,
  SessionSummary,
  TaskItem,
} from '@multi-agent/shared'
import { Composer } from '../src/components/chat/Composer'
import { PlanReviewCard } from '../src/components/chat/PlanReviewCard'
import { TaskView } from '../src/components/team/TaskView'
import { useAgentStore } from '../src/stores/agent-store'
import { usePlanStore } from '../src/stores/plan-store'
import { useRunStore } from '../src/stores/run-store'
import { useSessionStore } from '../src/stores/session-store'
import { useTaskStore } from '../src/stores/task-store'

const NOW = '2024-01-01T00:00:00.000Z'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

type Route = (init?: RequestInit) => Response | Promise<Response>

/** 路由式 fetch mock：`"METHOD /path"` 精确匹配；未声明的常见端点返回空快照，避免 store 崩溃 */
function mockApi(routes: Record<string, Route> = {}): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const handler = routes[`${method} ${url}`]
    if (handler) return handler(init)
    if (method === 'GET' && /\/plans$/.test(url)) return jsonResponse({ plans: [], reviews: [] })
    if (method === 'GET' && /\/tasks$/.test(url)) return jsonResponse({ tasks: [] })
    if (method === 'GET' && /\/approvals$/.test(url)) return jsonResponse({ approvals: [] })
    // 底栏上下文电池（Composer 内）的取数挂起：本文件不断言快照，避免迟到 setState 触发 act 警告
    if (method === 'GET' && /\/(context|usage)$/.test(url)) return new Promise<Response>(() => {})
    return jsonResponse({})
  })
}

function requestBodies(path: string, method: string): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(
      ([u, init]) =>
        String(u) === path && ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === method,
    )
    .map(([, init]) => JSON.parse(String((init as RequestInit).body ?? '{}')) as Record<string, unknown>)
}

function requestCount(path: string, method: string): number {
  return fetchMock.mock.calls.filter(
    ([u, init]) => String(u) === path && ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === method,
  ).length
}

// ---------- 夹具 ----------

function makeAgent(id: string, name: string, role: string): AgentDefinition {
  return {
    id,
    name,
    role,
    title: role,
    description: '',
    capabilities: [],
    group: 'development',
    avatar: { gradient: ['#3b82f6', '#f59e0b'], icon: 'user' },
    handoff: [],
  }
}

const AGENTS = [makeAgent('architect', '艾达', '架构师'), makeAgent('backend', '小北', '后端'), makeAgent('pm', '费利', '产品经理')]

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: '测试会话',
    participantIds: ['architect', 'backend', 'pm'],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

function summaryOf(session: Session): SessionSummary {
  return { ...session, messageCount: 0 }
}

function makePlan(over: Partial<Plan> = {}): Plan {
  return {
    id: 'p1',
    sessionId: 's1',
    runId: 'r1',
    agentId: 'architect',
    title: '实现登录模块',
    goal: '交付可用的登录与会话保持能力',
    steps: [
      {
        id: 'st1',
        content: '设计接口与数据表',
        ownerAgentId: 'architect',
        mode: 'execute',
        acceptance: '评审通过',
        status: 'pending',
      },
      { id: 'st2', content: '实现后端接口', ownerAgentId: 'backend', mode: 'execute', status: 'pending' },
    ],
    risks: ['外部依赖不稳定'],
    status: 'submitted',
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

function executingPlan(): Plan {
  return makePlan({
    id: 'p2',
    title: '部署流水线',
    goal: '把服务稳定上线',
    status: 'executing',
    version: 2,
    createdAt: '2024-01-02T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
    steps: [
      { id: 'e1', content: '编写部署脚本', ownerAgentId: 'backend', status: 'done' },
      { id: 'e2', content: '灰度发布评审', ownerAgentId: 'pm', mode: 'review', status: 'pending' },
    ],
    risks: [],
  })
}

function makeReview(over: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    id: 'rv1',
    sessionId: 's1',
    agentId: 'pm',
    planId: 'p1',
    target: 'plan:p1',
    verdict: 'pass',
    findings: [],
    evidence: [],
    createdAt: NOW,
    ...over,
  }
}

function makeTask(over: Partial<TaskItem> = {}): TaskItem {
  return { id: 't1', sessionId: 's1', content: '调研竞品', status: 'pending', ownerAgentId: 'pm', ord: 0, ...over }
}

function makeChatMessage(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    sessionId: 's1',
    role: 'user',
    content: '创建登录模块',
    mentions: [],
    status: 'complete',
    createdAt: NOW,
    ...over,
  }
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  localStorage.clear()
  usePlanStore.setState({ sessionId: undefined, plans: [], reviews: [], loading: false })
  useRunStore.setState({
    runId: undefined,
    sessionId: undefined,
    active: false,
    queued: false,
    queue: [],
    currentWave: [],
    waveIndex: 0,
    approvals: [],
    compressionCount: 0,
  })
  useSessionStore.setState({
    sessions: [],
    currentId: undefined,
    byId: new Map(),
    order: [],
    latestRun: null,
    loadingSessions: false,
    loadingMessages: false,
    artifactVersion: 0,
  })
  useTaskStore.setState({ sessionId: undefined, tasks: [], loading: false })
  useAgentStore.setState({ agents: AGENTS, skills: [], loaded: true, loading: false, statuses: {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------- plan-store ----------

describe('plan-store（M24 计划与评审镜像）', () => {
  it('load：绑定会话并拉取 plans / reviews', async () => {
    mockApi({
      'GET /api/sessions/s1/plans': () => jsonResponse({ plans: [makePlan()], reviews: [makeReview()] }),
    })
    await usePlanStore.getState().load('s1')
    const s = usePlanStore.getState()
    expect(s.sessionId).toBe('s1')
    expect(s.plans.map((p) => p.id)).toEqual(['p1'])
    expect(s.reviews.map((r) => r.id)).toEqual(['rv1'])
    expect(s.loading).toBe(false)
  })

  it('applyPlan 同 id 覆盖且新提交置前；applyReview 幂等去重；跨会话事件丢弃', () => {
    const older = makePlan({ id: 'p-old', createdAt: '2024-01-01T00:00:00.000Z' })
    const newer = makePlan({ id: 'p-new', createdAt: '2024-01-03T00:00:00.000Z' })
    usePlanStore.setState({ sessionId: 's1', plans: [older], reviews: [] })

    usePlanStore.getState().applyPlan(newer, 's1')
    expect(usePlanStore.getState().plans.map((p) => p.id)).toEqual(['p-new', 'p-old'])

    // 同 id 覆盖（版本推进），不重复追加
    usePlanStore.getState().applyPlan({ ...older, status: 'approved', updatedAt: '2024-01-04T00:00:00.000Z' }, 's1')
    const plans = usePlanStore.getState().plans
    expect(plans).toHaveLength(2)
    expect(plans.find((p) => p.id === 'p-old')?.status).toBe('approved')

    // 跨会话守卫：非绑定会话的事件被丢弃
    usePlanStore.getState().applyPlan(makePlan({ id: 'p-x' }), 'other')
    expect(usePlanStore.getState().plans.map((p) => p.id)).toEqual(['p-new', 'p-old'])

    // review 幂等去重
    const review = makeReview()
    usePlanStore.getState().applyReview(review, 's1')
    usePlanStore.getState().applyReview(review, 's1')
    expect(usePlanStore.getState().reviews).toHaveLength(1)
  })

  it('applyPlan 迟到回包守卫：旧 updatedAt 快照不覆盖新版本（驳回→v2 重提竞态）', () => {
    usePlanStore.setState({ sessionId: 's1', plans: [makePlan()], reviews: [] })
    // 驳回后引擎立即续跑：v2 修订重提先经 SSE 应用（updatedAt 更新）
    usePlanStore.getState().applyPlan(
      { ...makePlan(), title: '实现登录模块（已按反馈修订）', version: 2, updatedAt: '2024-01-06T00:00:00.000Z' },
      's1',
    )
    // 迟到的 resolve 回包（rejected v1 快照，updatedAt 更早）不得覆盖
    usePlanStore.getState().applyPlan({ ...makePlan(), status: 'rejected', updatedAt: '2024-01-05T00:00:00.000Z' }, 's1')
    let p = usePlanStore.getState().plans[0]
    expect(p.version).toBe(2)
    expect(p.title).toBe('实现登录模块（已按反馈修订）')
    expect(p.status).toBe('submitted')

    // 等值放行与更新覆盖：双通道幂等重放 / 正常推进均不受守卫影响
    usePlanStore.getState().applyPlan({ ...p, updatedAt: '2024-01-06T00:00:00.000Z' }, 's1')
    expect(usePlanStore.getState().plans).toHaveLength(1)
    usePlanStore.getState().applyPlan({ ...p, status: 'approved', updatedAt: '2024-01-07T00:00:00.000Z' }, 's1')
    p = usePlanStore.getState().plans[0]
    expect(p.status).toBe('approved')
  })

  it('updatePlan：PUT 补丁并在本地归约回执', async () => {
    usePlanStore.setState({ sessionId: 's1', plans: [makePlan()], reviews: [] })
    mockApi({
      'PUT /api/sessions/s1/plans/p1': () =>
        jsonResponse({ plan: { ...makePlan(), title: '实现登录模块 v2', updatedAt: '2024-01-05T00:00:00.000Z' } }),
    })
    const updated = await usePlanStore.getState().updatePlan('p1', { title: '实现登录模块 v2' })
    expect(updated.title).toBe('实现登录模块 v2')
    expect(usePlanStore.getState().plans[0].title).toBe('实现登录模块 v2')
    expect(requestBodies('/api/sessions/s1/plans/p1', 'PUT')[0]).toEqual({ title: '实现登录模块 v2' })
  })

  it('resolve：POST 决定；launched 非空时本地挂接执行 Run', async () => {
    usePlanStore.setState({ sessionId: 's1', plans: [makePlan()], reviews: [] })
    mockApi({
      'POST /api/sessions/s1/plans/p1/resolve': () =>
        jsonResponse({
          plan: { ...makePlan(), status: 'approved' },
          launched: { runId: 'r9', queue: ['architect'], queued: false },
        }),
      'GET /api/runs/r9/approvals': () => jsonResponse({ approvals: [] }),
      'GET /api/runs/r9/stream': () => jsonResponse({}),
    })
    const plan = await usePlanStore.getState().resolve('p1', 'approve')
    expect(plan.status).toBe('approved')
    expect(usePlanStore.getState().plans[0].status).toBe('approved')
    expect(useRunStore.getState().runId).toBe('r9')
    expect(requestBodies('/api/sessions/s1/plans/p1/resolve', 'POST')[0]).toEqual({ decision: 'approve' })
  })

  it('load 竞态守卫：切会话后迟到响应被丢弃', async () => {
    let releaseSlow!: (res: Response) => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releaseSlow = resolve
        }),
    )
    mockApi({
      'GET /api/sessions/sB/plans': () =>
        jsonResponse({ plans: [makePlan({ id: 'pb', sessionId: 'sB' })], reviews: [] }),
    })
    const slow = usePlanStore.getState().load('sA')
    await usePlanStore.getState().load('sB')
    releaseSlow(jsonResponse({ plans: [makePlan({ id: 'pa', sessionId: 'sA' })], reviews: [] }))
    await slow
    expect(usePlanStore.getState().sessionId).toBe('sB')
    expect(usePlanStore.getState().plans.map((p) => p.id)).toEqual(['pb'])
  })
})

// ---------- PlanReviewCard（聊天计划卡） ----------

/** 聊天场景公共装配：会话绑定 s1 + plan-store 已绑定 */
function setupChat(over: { plans?: Plan[]; reviews?: ReviewRecord[]; sessionPatch?: Partial<Session> } = {}): void {
  const plans = over.plans ?? [makePlan()]
  const reviews = over.reviews ?? []
  useSessionStore.setState({ sessions: [summaryOf(makeSession(over.sessionPatch))], currentId: 's1' })
  usePlanStore.setState({ sessionId: 's1', plans, reviews })
  mockApi({
    'GET /api/sessions/s1/plans': () => jsonResponse({ plans, reviews }),
  })
}

describe('PlanReviewCard（M24 聊天计划卡）', () => {
  it('待批准计划：渲染标题 / 目标 / 步骤与操作按钮', () => {
    setupChat()
    render(<PlanReviewCard />)
    expect(screen.getByText('待批准')).toBeInTheDocument()
    expect(screen.getByDisplayValue('实现登录模块')).toBeInTheDocument()
    expect(screen.getByText(/交付可用的登录与会话保持能力/)).toBeInTheDocument()
    expect(screen.getAllByPlaceholderText('步骤内容…')).toHaveLength(2)
    expect(screen.getByRole('button', { name: '批准并执行' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '驳回' })).toBeInTheDocument()
  })

  it('就地编辑：改指派 + 保存 → PUT 携带完整步骤（保留 id / 验收）', async () => {
    setupChat()
    const updated = makePlan({
      steps: [
        {
          id: 'st1',
          content: '设计接口与数据表',
          ownerAgentId: 'pm',
          mode: 'execute',
          acceptance: '评审通过',
          status: 'pending',
        },
        { id: 'st2', content: '实现后端接口', ownerAgentId: 'backend', mode: 'execute', status: 'pending' },
      ],
      updatedAt: '2024-01-05T00:00:00.000Z',
    })
    mockApi({
      'GET /api/sessions/s1/plans': () => jsonResponse({ plans: [makePlan()], reviews: [] }),
      'PUT /api/sessions/s1/plans/p1': () => jsonResponse({ plan: updated }),
    })
    const user = userEvent.setup()
    render(<PlanReviewCard />)

    await user.selectOptions(screen.getAllByTitle('步骤负责人（必须为会话成员）')[0], 'pm')
    await user.click(screen.getByRole('button', { name: '保存修改' }))

    await waitFor(() => expect(requestCount('/api/sessions/s1/plans/p1', 'PUT')).toBe(1))
    const body = requestBodies('/api/sessions/s1/plans/p1', 'PUT')[0]
    const steps = body.steps as Array<Record<string, unknown>>
    expect(steps).toHaveLength(2)
    expect(steps[0]).toMatchObject({ id: 'st1', content: '设计接口与数据表', ownerAgentId: 'pm', acceptance: '评审通过' })
    expect(usePlanStore.getState().plans[0].steps[0].ownerAgentId).toBe('pm')
  })

  it('M79-AH：只读共享（viewer）→ 批准 / 驳回 / 保存修改禁用 + 只读提示', async () => {
    setupChat()
    // 注入 viewer 角色（多用户只读共享）
    useSessionStore.setState((s) => ({ sessions: s.sessions.map((x) => ({ ...x, role: 'viewer' as const })) }))
    const user = userEvent.setup()
    render(<PlanReviewCard />)
    expect(screen.getByText(/只读共享（viewer）：无计划操作权限/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '批准并执行' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '驳回' })).toBeDisabled()
    // 编辑草稿（标题）→ dirty →「保存修改」出现且禁用
    const titleInput = screen.getByDisplayValue('实现登录模块')
    await user.clear(titleInput)
    await user.type(titleInput, '改名草稿')
    expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled()
  })

  it('批准（无改动）：POST resolve 且不触发 PUT', async () => {
    setupChat()
    mockApi({
      'GET /api/sessions/s1/plans': () => jsonResponse({ plans: [makePlan()], reviews: [] }),
      'POST /api/sessions/s1/plans/p1/resolve': () =>
        jsonResponse({ plan: { ...makePlan(), status: 'approved' }, launched: null }),
    })
    const user = userEvent.setup()
    render(<PlanReviewCard />)

    await user.click(screen.getByRole('button', { name: '批准并执行' }))
    await waitFor(() => expect(requestCount('/api/sessions/s1/plans/p1/resolve', 'POST')).toBe(1))
    expect(requestBodies('/api/sessions/s1/plans/p1/resolve', 'POST')[0]).toEqual({ decision: 'approve' })
    expect(requestCount('/api/sessions/s1/plans/p1', 'PUT')).toBe(0)
    expect(usePlanStore.getState().plans[0].status).toBe('approved')
  })

  it('批准（有改动）：先保存 PUT 再 resolve POST', async () => {
    setupChat()
    mockApi({
      'GET /api/sessions/s1/plans': () => jsonResponse({ plans: [makePlan()], reviews: [] }),
      'PUT /api/sessions/s1/plans/p1': () =>
        jsonResponse({
          plan: makePlan({
            steps: [
              {
                id: 'st1',
                content: '设计接口与数据表',
                ownerAgentId: 'pm',
                mode: 'execute',
                acceptance: '评审通过',
                status: 'pending',
              },
              { id: 'st2', content: '实现后端接口', ownerAgentId: 'backend', mode: 'execute', status: 'pending' },
            ],
            updatedAt: '2024-01-05T00:00:00.000Z',
          }),
        }),
      'POST /api/sessions/s1/plans/p1/resolve': () =>
        jsonResponse({ plan: { ...makePlan(), status: 'approved' }, launched: null }),
    })
    const user = userEvent.setup()
    render(<PlanReviewCard />)

    await user.selectOptions(screen.getAllByTitle('步骤负责人（必须为会话成员）')[0], 'pm')
    await user.click(screen.getByRole('button', { name: '批准并执行' }))

    await waitFor(() => expect(requestCount('/api/sessions/s1/plans/p1/resolve', 'POST')).toBe(1))
    expect(requestCount('/api/sessions/s1/plans/p1', 'PUT')).toBe(1)
    expect(requestBodies('/api/sessions/s1/plans/p1/resolve', 'POST')[0]).toEqual({ decision: 'approve' })
  })

  it('驳回带反馈：POST resolve（reject + feedback）', async () => {
    setupChat()
    mockApi({
      'GET /api/sessions/s1/plans': () => jsonResponse({ plans: [makePlan()], reviews: [] }),
      'POST /api/sessions/s1/plans/p1/resolve': () =>
        jsonResponse({
          plan: { ...makePlan(), status: 'rejected', feedback: '请补充验收标准' },
          launched: null,
        }),
    })
    const user = userEvent.setup()
    render(<PlanReviewCard />)

    await user.click(screen.getByRole('button', { name: '驳回' }))
    await user.type(screen.getByPlaceholderText(/驳回反馈/), '请补充验收标准')
    await user.click(screen.getByRole('button', { name: '确认驳回' }))

    await waitFor(() => expect(requestCount('/api/sessions/s1/plans/p1/resolve', 'POST')).toBe(1))
    expect(requestBodies('/api/sessions/s1/plans/p1/resolve', 'POST')[0]).toEqual({
      decision: 'reject',
      feedback: '请补充验收标准',
    })
    expect(usePlanStore.getState().plans[0].status).toBe('rejected')
  })

  it('驳回竞态：v2 先到（同批渲染不卸载）后，旧回包不覆盖且表单自动收起', async () => {
    setupChat()
    mockApi({
      'GET /api/sessions/s1/plans': () => jsonResponse({ plans: [makePlan()], reviews: [] }),
      'POST /api/sessions/s1/plans/p1/resolve': () => {
        // 模拟信道竞态：结算后引擎立即续跑，v2 重提经 SSE 先应用（与 rejected 同批到达，卡不卸载）
        usePlanStore.getState().applyPlan(
          { ...makePlan(), title: '实现登录模块（已按反馈修订）', version: 2, updatedAt: '2024-01-06T00:00:00.000Z' },
          's1',
        )
        // 回包仍是 rejected v1 旧快照（body 解析晚于 SSE）
        return jsonResponse({ plan: { ...makePlan(), status: 'rejected' }, launched: null })
      },
    })
    const user = userEvent.setup()
    render(<PlanReviewCard />)

    await user.click(screen.getByRole('button', { name: '驳回' }))
    await user.type(screen.getByPlaceholderText(/驳回反馈/), '请补充验收标准')
    await user.click(screen.getByRole('button', { name: '确认驳回' }))

    // 表单主动收起（不依赖卸载）；v2 卡可继续操作（批准并执行可见）
    await waitFor(() => expect(screen.queryByRole('button', { name: '确认驳回' })).toBeNull())
    expect(screen.getByRole('button', { name: '批准并执行' })).toBeTruthy()
    expect(screen.getByText('v2')).toBeTruthy()
    const p = usePlanStore.getState().plans[0]
    expect(p.status).toBe('submitted')
    expect(p.version).toBe(2)
    expect(p.title).toBe('实现登录模块（已按反馈修订）')
  })
})

// ---------- TaskView 2.0（任务面板双形态） ----------

function setupTaskView(over: { plans?: Plan[]; tasks?: TaskItem[]; sessionPatch?: Partial<Session> } = {}): void {
  const plans = over.plans ?? []
  const tasks = over.tasks ?? []
  useSessionStore.setState({ sessions: [summaryOf(makeSession(over.sessionPatch))], currentId: 's1' })
  useTaskStore.setState({ sessionId: 's1', tasks, loading: false })
  usePlanStore.setState({ sessionId: 's1', plans, reviews: [] })
  mockApi({
    'GET /api/sessions/s1/tasks': () => jsonResponse({ tasks }),
    'GET /api/sessions/s1/plans': () => jsonResponse({ plans, reviews: [] }),
  })
}

describe('TaskView 2.0（M24 计划板 / 待办清单双形态）', () => {
  it('无计划：保持待办清单形态（write_todos 条目 + 自动编排 chip）', () => {
    setupTaskView({ tasks: [makeTask()] })
    render(<TaskView />)
    expect(screen.getByText('任务 0/1')).toBeInTheDocument()
    expect(screen.getByText('调研竞品')).toBeInTheDocument()
    expect(screen.getByText('待办')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '自动编排' })).toBeInTheDocument()
    expect(screen.queryByText(/计划 \d/)).not.toBeInTheDocument()
  })

  it('有计划：切换计划板形态（状态徽章 / 进度 / 批驳操作）', () => {
    setupTaskView({ plans: [makePlan(), executingPlan()] })
    render(<TaskView />)
    expect(screen.getByText('计划 2')).toBeInTheDocument()
    expect(screen.getByText('1 份待批准')).toBeInTheDocument()
    expect(screen.getByText('实现登录模块')).toBeInTheDocument()
    expect(screen.getByText('部署流水线')).toBeInTheDocument()
    expect(screen.getByText('待批准')).toBeInTheDocument()
    expect(screen.getByText('执行中')).toBeInTheDocument()
    expect(screen.getByText('1/2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '批准执行' })).toBeInTheDocument()
    expect(screen.getByText('设计接口与数据表')).toBeInTheDocument()
  })

  it('按成员分组：展示「已规划 · 步骤 x/y」视角并可与按计划互切', async () => {
    setupTaskView({ plans: [makePlan(), executingPlan()] })
    const user = userEvent.setup()
    render(<TaskView />)

    await user.click(screen.getByRole('button', { name: '按成员' }))
    expect(screen.getByText('已规划 · 步骤 1/2')).toBeInTheDocument()
    expect(screen.getAllByText('已规划 · 步骤 0/1')).toHaveLength(2)
    expect(screen.getByText('艾达')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '按计划' }))
    expect(screen.getByRole('button', { name: '批准执行' })).toBeInTheDocument()
  })

  it('「自动编排」开关：循环到规划先行 → PATCH autonomy 并即时更新 chip', async () => {
    setupTaskView({})
    mockApi({
      'GET /api/sessions/s1/tasks': () => jsonResponse({ tasks: [] }),
      'GET /api/sessions/s1/plans': () => jsonResponse({ plans: [], reviews: [] }),
      'PATCH /api/sessions/s1': () => jsonResponse({ session: makeSession({ autonomy: 'always-plan' }) }),
    })
    const user = userEvent.setup()
    render(<TaskView />)

    await user.click(screen.getByRole('button', { name: '自动编排' }))
    await waitFor(() => expect(requestCount('/api/sessions/s1', 'PATCH')).toBe(1))
    expect(requestBodies('/api/sessions/s1', 'PATCH')[0]).toEqual({ autonomy: 'always-plan' })
    expect(await screen.findByRole('button', { name: '规划先行' })).toBeInTheDocument()
  })

  it('待批准计划就地改指派：PUT 步骤数组携带原字段', async () => {
    setupTaskView({ plans: [makePlan()] })
    mockApi({
      'GET /api/sessions/s1/tasks': () => jsonResponse({ tasks: [] }),
      'GET /api/sessions/s1/plans': () => jsonResponse({ plans: [makePlan()], reviews: [] }),
      'PUT /api/sessions/s1/plans/p1': () =>
        jsonResponse({
          plan: makePlan({
            steps: [
              {
                id: 'st1',
                content: '设计接口与数据表',
                ownerAgentId: 'pm',
                mode: 'execute',
                acceptance: '评审通过',
                status: 'pending',
              },
              { id: 'st2', content: '实现后端接口', ownerAgentId: 'backend', mode: 'execute', status: 'pending' },
            ],
            updatedAt: '2024-01-05T00:00:00.000Z',
          }),
        }),
    })
    const user = userEvent.setup()
    render(<TaskView />)

    await user.selectOptions(screen.getAllByTitle('就地改指派（仅「待批准」可编辑）')[0], 'pm')
    await waitFor(() => expect(requestCount('/api/sessions/s1/plans/p1', 'PUT')).toBe(1))
    const steps = requestBodies('/api/sessions/s1/plans/p1', 'PUT')[0].steps as Array<Record<string, unknown>>
    expect(steps[0]).toMatchObject({ id: 'st1', ownerAgentId: 'pm', content: '设计接口与数据表' })
  })
})

// ---------- Composer 范式选择器 ----------

function setupComposer(over: { planFirst?: boolean } = {}): void {
  useAgentStore.setState({ agents: [makeAgent('architect', '艾达', '架构师'), makeAgent('pm', '费利', '产品经理')] })
  useSessionStore.setState({
    sessions: [summaryOf(makeSession({ participantIds: ['architect', 'pm'], planFirst: over.planFirst }))],
    currentId: 's1',
  })
}

describe('Composer 范式选择器（M24）', () => {
  it('默认「执行」；选「规划」后发送携带 mode，发送后自动复位', async () => {
    setupComposer()
    mockApi({
      'POST /api/sessions/s1/messages': () =>
        jsonResponse({ message: makeChatMessage(), runId: 'r1', queue: ['architect'] }),
      'GET /api/runs/r1/approvals': () => jsonResponse({ approvals: [] }),
      'GET /api/runs/r1/stream': () => jsonResponse({}),
    })
    const user = userEvent.setup()
    render(<Composer />)
    const box = screen.getByRole('textbox')

    // 默认执行：无「仅生效一次」提示
    expect(screen.queryByText(/本条以「/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '规划' }))
    expect(screen.getByText('本条以「规划」发送，仅生效一次')).toBeInTheDocument()

    await user.type(box, '创建登录模块')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(requestCount('/api/sessions/s1/messages', 'POST')).toBe(1))
    expect(requestBodies('/api/sessions/s1/messages', 'POST')[0]).toEqual({ content: '创建登录模块', mode: 'plan' })

    // 发送后复位：清空输入、提示消失
    await waitFor(() => expect(box).toHaveValue(''))
    expect(screen.queryByText('本条以「规划」发送，仅生效一次')).not.toBeInTheDocument()

    // 第二条默认执行：body 不携带 mode（尊重会话「规划先行」兜底）
    await user.type(box, '继续完善')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(requestCount('/api/sessions/s1/messages', 'POST')).toBe(2))
    const second = requestBodies('/api/sessions/s1/messages', 'POST')[1]
    expect('mode' in second).toBe(false)
    expect(second.content).toBe('继续完善')
  })

  it('运行中（插话态）：范式 chips 禁用', () => {
    setupComposer()
    mockApi()
    useRunStore.setState({ active: true })
    render(<Composer />)
    expect(screen.getByRole('button', { name: '自动' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '规划' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '评审' })).toBeDisabled()
  })

  it('会话「规划先行」开启：helper 行提示', () => {
    setupComposer({ planFirst: true })
    mockApi()
    render(<Composer />)
    expect(screen.getByText('规划先行')).toBeInTheDocument()
  })
})
