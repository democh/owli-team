/**
 * M9 前端：Trace 抽屉（事件时间轴 / 用量汇总 / 开关）、指标面板（窗口切换 / 工具与反馈 / 空态）、
 * 消息反馈（👍 / 👎+原因 → POST /api/feedback）、会话全文搜索（防抖检索 / 命中跳转 / 清空）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  AgentDefinition,
  ChatMessage,
  FeedbackItem,
  MetricsSummary,
  TraceEntry,
} from '@multi-agent/shared'
import { MessageActions } from '../src/components/chat/MessageActions'
import { TraceDrawer } from '../src/components/observability/TraceDrawer'
import { SessionList } from '../src/components/sessions/SessionList'
import { MetricsPanel } from '../src/components/team/MetricsPanel'
import { useAgentStore } from '../src/stores/agent-store'
import { useAuthStore } from '../src/stores/auth-store'
import { useRunStore } from '../src/stores/run-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'
import { useWsStore } from '../src/stores/ws-store'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function makeAgent(id: string, name: string): AgentDefinition {
  return {
    id,
    name,
    role: id,
    title: id,
    description: '',
    capabilities: [],
    group: 'development',
    avatar: { gradient: ['#3b82f6', '#f59e0b'], icon: 'user' },
    handoff: [],
  }
}

const T0 = Date.parse('2026-06-01T00:00:00.000Z')

function entry(
  type: string,
  payload: Record<string, unknown>,
  offsetMs: number,
  turnIndex = 0,
): TraceEntry {
  return {
    id: Math.floor(offsetMs) + type.length,
    runId: 'r1',
    sessionId: 's1',
    turnIndex,
    type,
    payload,
    ts: new Date(T0 + offsetMs).toISOString(),
  }
}

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  useAgentStore.setState({
    agents: [makeAgent('backend', '小北'), makeAgent('architect', '艾达')],
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
    loadingSessions: false,
    loadingMessages: false,
    artifactVersion: 0,
    latestRun: undefined,
  })
  useRunStore.setState({ active: false, approvals: [] })
  useUiStore.setState({ traceRunId: undefined })
  useWsStore.setState({ unread: {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------- Trace 抽屉 ----------

describe('TraceDrawer 全链路时间轴（M9）', () => {
  it('关闭时无内容；打开后按事件类型渲染标题 / 细节 / 相对时间与用量汇总', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        run: { id: 'r1', state: 'done', turnIndex: 1 },
        events: [
          entry('run:start', { queue: ['backend', 'architect'] }, 0),
          entry('turn:start', { agentId: 'backend' }, 1000),
          entry('tool', { name: 'write_file', ok: true, durationMs: 12, summary: 'docs/接口说明.md' }, 1500),
          entry('turn:end', { agentId: 'backend', status: 'complete', durationMs: 300, promptTokens: 1000, completionTokens: 200, queue: ['architect'] }, 1600),
          entry('compression', { untilSeq: 12, beforeTokens: 50000, afterTokens: 20000, degraded: false }, 1700),
          entry('schedule', { agentId: 'backend', accepted: ['architect'], dropped: [{ id: 'qa', reason: 'not-in-room' }], handedToUser: false, source: 'tool' }, 1800),
          entry('routing:dispatched', { source: 'handoff', members: ['backend', 'qa'], reason: '需要开发与验证' }, 1900),
          entry('routing:dispatched', { assignments: [{ agentId: 'architect', task: '继续推进' }], reason: '未 @ 消息首选在场成员' }, 1950),
          entry('routing:dispatched', { fallback: true, error: '结构化输出解析失败' }, 1990),
          entry('run:end', { reason: 'completed', turns: 2 }, 2000),
        ],
        usage: { promptTokens: 1234, completionTokens: 456, costUsd: 0.0123 },
      }),
    )

    render(<TraceDrawer />)
    expect(screen.queryByText('运行轨迹')).not.toBeInTheDocument()

    act(() => useUiStore.setState({ traceRunId: 'r1' }))
    expect(await screen.findByText('运行轨迹')).toBeInTheDocument()

    // 请求 URL 与事件渲染
    expect(fetchMock.mock.calls.some(([u]) => u === '/api/runs/r1/trace')).toBe(true)
    expect(screen.getByText('done')).toBeInTheDocument()
    expect(screen.getByText('运行开始 · 队列：小北 → 艾达')).toBeInTheDocument()
    expect(screen.getByText('回合 1 开始 · 小北')).toBeInTheDocument()
    expect(screen.getByText('工具 write_file · 成功 · 12ms')).toBeInTheDocument()
    expect(screen.getByText('docs/接口说明.md')).toBeInTheDocument()
    expect(screen.getByText('回合 1 结束 · 小北 · 300ms')).toBeInTheDocument()
    expect(screen.getByText(/token 1000\+200 · 下一棒：艾达/)).toBeInTheDocument()
    expect(screen.getByText('上下文压缩 · 50,000 → 20,000 tokens')).toBeInTheDocument()
    expect(screen.getByText(/摘要水位 untilSeq=12/)).toBeInTheDocument()
    expect(screen.getByText('调度 · 小北 → 艾达')).toBeInTheDocument()
    expect(screen.getByText(/来源 handoff 工具 · 丢弃 qa（不在场）/)).toBeInTheDocument()
    expect(screen.getByText('平台召集 · 小北、qa')).toBeInTheDocument()
    expect(screen.getByText('来源 成员转交触发 · 理由：需要开发与验证')).toBeInTheDocument()
    expect(screen.getByText('平台派发 · 艾达')).toBeInTheDocument()
    expect(screen.getByText('理由：未 @ 消息首选在场成员')).toBeInTheDocument()
    expect(screen.getByText('平台路由降级 · 在场成员接手')).toBeInTheDocument()
    expect(screen.getByText('原因：结构化输出解析失败')).toBeInTheDocument()
    expect(screen.getByText('运行结束 · completed · 共 2 回合')).toBeInTheDocument()

    // 相对时间与用量汇总（header description）
    expect(screen.getByText('+1.5s')).toBeInTheDocument()
    expect(screen.getByText(/token 1,234\+456 · 费用 \$0\.0123/)).toBeInTheDocument()
  })

  it('无事件时展示空态；运行错误时展示错误条', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        run: { id: 'r1', state: 'error', error: '模型连续失败' },
        events: [],
        usage: null,
      }),
    )
    render(<TraceDrawer />)
    act(() => useUiStore.setState({ traceRunId: 'r1' }))

    expect(await screen.findByText('暂无轨迹事件（运行开始后逐步产生）')).toBeInTheDocument()
    expect(screen.getByText(/错误：模型连续失败/)).toBeInTheDocument()
    expect(screen.queryByText('运行结束')).not.toBeInTheDocument()
  })

  it('全事件类型中文渲染：波次 / 队列 / 检索 / 记忆 / 净化 / 交付 / 计划；schedule 新载荷与中断态', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        run: { id: 'r2', state: 'running', turnIndex: 1 },
        events: [
          entry('run:start', { queue: ['backend', 'architect'] }, 0),
          entry('wave:start', { members: ['backend', 'architect'], parallel: true }, 100),
          entry('wave:start', { members: ['backend'], mode: 'plan' }, 200),
          entry('queue:updated', { queue: ['architect'] }, 300),
          entry('queue:updated', { queue: [] }, 350),
          entry('tool:search', { agentId: 'backend', query: 'docker logs', activated: ['run_command', 'read_file'] }, 400),
          entry(
            'memory:recall',
            { count: 2, items: [{ id: 'm1', scope: 'session', score: 0.82 }, { id: 'm2', scope: 'global', score: 0.4 }] },
            500,
          ),
          entry('memory:digest', { candidates: 3, added: 2 }, 600),
          entry('memory:embed', { queued: true }, 650),
          entry('content:sanitized', { messageId: 'm9', beforeChars: 320, afterChars: 288 }, 700),
          entry('delivery:unverified', { messageId: 'm9', files: ['docs/a.md', 'docs/b.md'] }, 750),
          entry('plan:submitted', { planId: 'p1', title: '接入登录', version: 2, steps: 5 }, 800),
          entry('plan:dispatched', { planId: 'p1', owners: ['backend', 'architect'] }, 900),
          entry('plan:done', { planId: 'p1', synthesisAgent: 'architect' }, 1000),
          // 新版 schedule 载荷：波末合并的对象数组（acceptedByAgent）；交还用户哨兵 = 'user'
          entry(
            'schedule',
            {
              accepted: [
                { agentId: 'backend', accepted: ['architect'] },
                { agentId: 'architect', accepted: ['user'] },
              ],
              dropped: [{ id: 'qa', reason: 'not-in-room', by: 'backend' }],
            },
            1100,
          ),
          // M47 中断不是失败：工具 aborted / 回合 stopped 单独标注
          entry('tool', { name: 'run_command', ok: false, aborted: true, durationMs: 5, summary: '运行已中断（未计入失败）' }, 1150),
          entry('turn:end', { agentId: 'backend', status: 'stopped', durationMs: 42, promptTokens: 1, completionTokens: 2 }, 1200),
        ],
        usage: null,
      }),
    )
    render(<TraceDrawer />)
    act(() => useUiStore.setState({ traceRunId: 'r2' }))
    expect(await screen.findByText('运行轨迹')).toBeInTheDocument()

    // 波次 / 队列（不再显示 wave:start 原始类型名）
    expect(screen.getByText('波次 1 开始 · 小北、艾达')).toBeInTheDocument()
    expect(screen.getByText('并行')).toBeInTheDocument()
    expect(screen.getByText('波次 1 开始 · 小北')).toBeInTheDocument()
    expect(screen.getByText('模式：规划')).toBeInTheDocument()
    expect(screen.getByText('队列更新 · 艾达')).toBeInTheDocument()
    expect(screen.getByText('队列更新 · 已清空')).toBeInTheDocument()
    expect(screen.queryByText('wave:start')).not.toBeInTheDocument()

    // 工具检索 / 记忆 / 正文净化 / 交付核查
    expect(screen.getByText('工具检索 · 小北「docker logs」')).toBeInTheDocument()
    expect(screen.getByText('激活 run_command、read_file')).toBeInTheDocument()
    expect(screen.getByText('记忆召回 · 2 条')).toBeInTheDocument()
    expect(screen.getByText('最高分 0.82 · 来源 会话、全局')).toBeInTheDocument()
    expect(screen.getByText('记忆沉淀 · 候选 3 · 入库 2')).toBeInTheDocument()
    expect(screen.getByText('记忆入库 · 已排队')).toBeInTheDocument()
    expect(screen.getByText('正文净化 · 320 → 288 字符')).toBeInTheDocument()
    expect(screen.getByText('交付核查 · 2 项落盘声明无对应写入')).toBeInTheDocument()
    expect(screen.getByText('docs/a.md、docs/b.md')).toBeInTheDocument()

    // 计划三行
    expect(screen.getByText('计划提交 · 接入登录')).toBeInTheDocument()
    expect(screen.getByText('v2 · 5 步')).toBeInTheDocument()
    expect(screen.getByText('计划派发 · 小北、艾达')).toBeInTheDocument()
    expect(screen.getByText('计划完成 · 收口回合：艾达')).toBeInTheDocument()

    // schedule 新载荷（对象数组）+ 交还用户哨兵；不再出现 [object Object]
    expect(screen.getByText('调度 · 小北 → 艾达；艾达 → 用户')).toBeInTheDocument()
    expect(screen.getByText(/丢弃 qa（不在场）/)).toBeInTheDocument()
    expect(screen.queryByText(/object Object/)).not.toBeInTheDocument()

    // 中断态：工具 / 回合非失败语义
    expect(screen.getByText('工具 run_command · 已中断 · 5ms')).toBeInTheDocument()
    expect(screen.getByText('回合 1 结束 · 小北 · 42ms · 已中断')).toBeInTheDocument()
  })
})

// ---------- 指标面板 ----------

const metricsSummary: MetricsSummary = {
  runs: 12,
  turns: 34,
  promptTokens: 12000,
  completionTokens: 800,
  costUsd: 0.0456,
  compressions: 2,
  toolCalls: 7,
  toolFailures: 1,
  avgTurnMs: 1234,
}

const metricsBody = {
  summary: metricsSummary,
  byKind: {
    agent: { calls: 34, promptTokens: 11000, completionTokens: 700, costUsd: 0.04 },
    summary: { calls: 2, promptTokens: 800, completionTokens: 100, costUsd: 0.004 },
    judge: { calls: 1, promptTokens: 200, completionTokens: 0, costUsd: 0.0016 },
  },
  tools: [
    { toolName: 'write_file', calls: 3, failures: 0, avgMs: 12 },
    { toolName: 'run_command', calls: 4, failures: 1, avgMs: 2500 },
  ],
  feedback: { total: 3, up: 2, down: 1 },
}

describe('MetricsPanel 指标面板（M9）', () => {
  it('渲染聚合指标 / 工具排行 / 反馈好评率 / 用量拆分', async () => {
    fetchMock.mockResolvedValue(jsonResponse(metricsBody))
    render(<MetricsPanel />)

    expect(await screen.findByText('12')).toBeInTheDocument() // 运行
    expect(screen.getByText('34')).toBeInTheDocument() // 回合
    expect(screen.getByText('1.2s')).toBeInTheDocument() // 平均回合
    expect(screen.getByText('12.0k')).toBeInTheDocument() // 输入 token
    expect(screen.getByText('800')).toBeInTheDocument() // 输出 token
    expect(screen.getByText('$0.0456')).toBeInTheDocument() // 费用

    // 工具调用头部 + 排行
    expect(screen.getByText(/7 次 · 失败率 14.3% · 压缩 2 次/)).toBeInTheDocument()
    expect(screen.getByText('write_file')).toBeInTheDocument()
    expect(screen.getByText('全成功')).toBeInTheDocument()
    expect(screen.getByText('失败 1')).toBeInTheDocument()
    expect(screen.getByText('2.5s')).toBeInTheDocument()

    // 反馈好评率
    expect(screen.getByText(/反馈 3 条 · 👍 2 · 👎 1/)).toBeInTheDocument()
    expect(screen.getByText('好评率 67%')).toBeInTheDocument()

    // 用量拆分（按用途）
    expect(screen.getByText('Agent 回合')).toBeInTheDocument()
    expect(screen.getByText('11.7k tokens')).toBeInTheDocument()
    expect(screen.getByText('压缩摘要')).toBeInTheDocument()
    expect(screen.getByText('评审打分')).toBeInTheDocument()
  })

  it('窗口切换按 24h / 7 天 / 全部 传递 sinceMs（summary + M61 调度同窗）；请求失败保留空态', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(jsonResponse(metricsBody))
    render(<MetricsPanel />)
    await screen.findByText('12')

    const urls = (): string[] => fetchMock.mock.calls.map(([u]) => String(u))
    expect(urls()[0]).toBe('/api/metrics/summary?sinceMs=86400000')

    await user.click(screen.getByRole('button', { name: '7 天' }))
    await waitFor(() => expect(urls()).toContain('/api/metrics/summary?sinceMs=604800000'))
    // M61-D6：调度端点与 summary 同窗并行拉取
    expect(urls()).toContain('/api/metrics/scheduling?sinceMs=604800000')

    await user.click(screen.getByRole('button', { name: '全部' }))
    await waitFor(() => expect(urls()).toContain('/api/metrics/summary'))

    fetchMock.mockReset()
    fetchMock.mockRejectedValue(new Error('断网'))
    render(<MetricsPanel />)
    expect(await screen.findAllByText('暂无指标（发起一次协作后生成）')).not.toHaveLength(0)
  })
})

// ---------- 消息反馈 ----------

function makeMessage(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm2',
    sessionId: 's1',
    role: 'agent',
    agentId: 'backend',
    content: '已实现登录接口：幂等键放在请求头',
    mentions: [],
    status: 'complete',
    createdAt: new Date().toISOString(),
    ...over,
  }
}

/** GET 已存反馈 / POST 覆盖式写入（模拟服务端同消息唯一） */
function mockFeedbackApi(): { getItem: () => FeedbackItem | null } {
  let item: FeedbackItem | null = null
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (String(url).startsWith('/api/feedback?messageId=')) return Promise.resolve(jsonResponse({ item }))
    if (url === '/api/feedback' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as {
        sessionId: string
        messageId: string
        rating: number
        reason?: string
      }
      item = {
        id: 'f1',
        sessionId: body.sessionId,
        messageId: body.messageId,
        rating: body.rating,
        reason: body.reason,
        createdAt: new Date().toISOString(),
      }
      return Promise.resolve(jsonResponse({ item }, 201))
    }
    return Promise.resolve(jsonResponse({}, 404))
  })
  return { getItem: () => item }
}

describe('MessageActions 反馈（M9）', () => {
  beforeEach(() => {
    useSessionStore.setState({
      currentId: 's1',
      byId: new Map([[('m2'), makeMessage()]]),
      order: ['m2'],
    })
  })

  it('👍：POST rating=1；重开菜单展示已标记状态', async () => {
    const user = userEvent.setup()
    const api = mockFeedbackApi()
    render(<MessageActions messageId="m2" />)

    await user.click(screen.getByRole('button', { name: '消息操作' }))
    await user.click(await screen.findByRole('menuitem', { name: /标记有帮助/ }))

    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit)?.method === 'POST')).toBe(true))
    const postCall = fetchMock.mock.calls.find(([, i]) => (i as RequestInit)?.method === 'POST')!
    expect(postCall[0]).toBe('/api/feedback')
    expect(JSON.parse(String((postCall[1] as RequestInit).body))).toEqual({
      sessionId: 's1',
      messageId: 'm2',
      rating: 1,
    })
    expect(api.getItem()?.rating).toBe(1)

    // 菜单提交后关闭；重新打开 → GET 回读 → 展示已标记表达式
    await user.click(screen.getByRole('button', { name: '消息操作' }))
    expect(await screen.findByRole('menuitem', { name: /有帮助（已标记）/ })).toBeInTheDocument()
  })

  it('👎：展开原因输入，提交时携带 reason', async () => {
    const user = userEvent.setup()
    const api = mockFeedbackApi()
    render(<MessageActions messageId="m2" />)

    await user.click(screen.getByRole('button', { name: '消息操作' }))
    await user.click(await screen.findByRole('menuitem', { name: /标记待改进/ }))

    const box = await screen.findByPlaceholderText('哪里需要改进？（可选）')
    await user.type(box, '缺少错误码示例')
    await user.click(screen.getByRole('button', { name: '提交' }))

    await waitFor(() => expect(api.getItem()?.rating).toBe(-1))
    const postCall = fetchMock.mock.calls.find(([, i]) => (i as RequestInit)?.method === 'POST')!
    expect(JSON.parse(String((postCall[1] as RequestInit).body))).toEqual({
      sessionId: 's1',
      messageId: 'm2',
      rating: -1,
      reason: '缺少错误码示例',
    })
  })

  it('👎 跳过原因：rating=-1 且不带 reason', async () => {
    const user = userEvent.setup()
    const api = mockFeedbackApi()
    render(<MessageActions messageId="m2" />)

    await user.click(screen.getByRole('button', { name: '消息操作' }))
    await user.click(await screen.findByRole('menuitem', { name: /标记待改进/ }))
    await user.click(await screen.findByRole('button', { name: '跳过原因' }))

    await waitFor(() => expect(api.getItem()?.rating).toBe(-1))
    const postCall = fetchMock.mock.calls.find(([, i]) => (i as RequestInit)?.method === 'POST')!
    expect(JSON.parse(String((postCall[1] as RequestInit).body))).toEqual({
      sessionId: 's1',
      messageId: 'm2',
      rating: -1,
    })
  })
})

// ---------- M79-AF：写项 gating（服务端口径的展示层对齐） ----------

describe('MessageActions 写项 gating（M79-AF）', () => {
  it('viewer：重生成 / fork / 删除隐藏；读面项保留', async () => {
    const user = userEvent.setup()
    useSessionStore.setState({
      currentId: 's1',
      sessions: [{ id: 's1', title: 'T', role: 'viewer' }] as never,
      byId: new Map([['m2', makeMessage()]]),
      order: ['m2'],
    })
    render(<MessageActions messageId="m2" />)
    await user.click(screen.getByRole('button', { name: '消息操作' }))
    expect(screen.queryByRole('menuitem', { name: /重新生成/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /从这条 fork/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /删除/ })).toBeNull()
    expect(screen.getByRole('menuitem', { name: /复制/ })).toBeInTheDocument()
    useSessionStore.setState({ sessions: [] })
  })

  it('他人人类消息（editor 非属主）：编辑 / 删除隐藏；本人消息两项均显示', async () => {
    const user = userEvent.setup()
    useAuthStore.setState({ user: { id: 'u_me' } } as never)
    useSessionStore.setState({
      currentId: 's1',
      sessions: [{ id: 's1', title: 'T', role: 'editor' }] as never,
      byId: new Map([['m2', makeMessage({ role: 'user', userId: 'u_other' })]]),
      order: ['m2'],
    })
    const first = render(<MessageActions messageId="m2" />)
    await user.click(screen.getByRole('button', { name: '消息操作' }))
    expect(screen.queryByRole('menuitem', { name: /编辑重发/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /删除/ })).toBeNull()
    first.unmount()

    // 本人消息 → 编辑与删除均显示
    useSessionStore.setState({ byId: new Map([['m2', makeMessage({ role: 'user', userId: 'u_me' })]]) })
    render(<MessageActions messageId="m2" />)
    await user.click(screen.getByRole('button', { name: '消息操作' }))
    expect(screen.getByRole('menuitem', { name: /编辑重发/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /删除/ })).toBeInTheDocument()
    useAuthStore.setState({ user: undefined })
    useSessionStore.setState({ sessions: [] })
  })

  it('兼容模式（无角色 / 无 userId）：写项全放行（零回归）', async () => {
    const user = userEvent.setup()
    useSessionStore.setState({
      currentId: 's1',
      sessions: [],
      byId: new Map([['m2', makeMessage({ role: 'user' })]]),
      order: ['m2'],
    })
    render(<MessageActions messageId="m2" />)
    await user.click(screen.getByRole('button', { name: '消息操作' }))
    expect(screen.getByRole('menuitem', { name: /编辑重发/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /删除/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /从这条 fork/ })).toBeInTheDocument()
  })
})

// ---------- 会话全文搜索 ----------

function sessionItem(id: string, title: string): {
  id: string
  title: string
  participantIds: string[]
  createdAt: string
  updatedAt: string
  messageCount: number
} {
  return {
    id,
    title,
    participantIds: ['backend'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: 3,
  }
}

describe('SessionList 全文搜索（M9）', () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessions: [sessionItem('s1', '登录需求讨论'), sessionItem('s2', '交接讨论')],
      currentId: 's1',
    })
  })

  it('输入防抖后请求 FTS；命中展示会话名与片段，点击跳转并恢复列表', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    // 注意：Response body 只能消费一次——须按调用新建实例（SessionList 挂载即拉 /api/spaces，共享实例会被抢先消费）；
    // /api/spaces 显式返空列表（空间切换器隐藏，不干扰搜索断言）
    fetchMock.mockImplementation((url: unknown) =>
      Promise.resolve(
        String(url).startsWith('/api/spaces')
          ? jsonResponse({ spaces: [] })
          : jsonResponse({
              results: [
                { sessionId: 's2', messageId: 'm9', content: '请帮我实现登录功能，注意幂等', sessionTitle: '交接讨论' },
              ],
            }),
      ),
    )
    render(<SessionList onSelect={onSelect} />)

    await user.type(screen.getByPlaceholderText('搜索全部会话消息…'), '登录')
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => u === '/api/search?q=%E7%99%BB%E5%BD%95&limit=30')).toBe(true),
    )

    expect(await screen.findByText('交接讨论')).toBeInTheDocument()
    expect(screen.getByText(/请帮我实现登录功能/)).toBeInTheDocument()

    await user.click(screen.getByText('交接讨论'))
    expect(onSelect).toHaveBeenCalledWith('s2')
    // 查询清空 → 恢复会话列表
    expect(await screen.findByText('登录需求讨论')).toBeInTheDocument()
  })

  it('无命中展示空态；清空按钮恢复列表', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(jsonResponse({ results: [] }))
    render(<SessionList onSelect={vi.fn()} />)

    await user.type(screen.getByPlaceholderText('搜索全部会话消息…'), '不存在xyz')
    expect(await screen.findByText('没有匹配「不存在xyz」的消息')).toBeInTheDocument()

    await user.click(screen.getByTitle('清空搜索'))
    expect(screen.getByText('登录需求讨论')).toBeInTheDocument()
    expect(screen.getByText('交接讨论')).toBeInTheDocument()
  })
})
