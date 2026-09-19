/**
 * M35 前端测试：schedule-store（加载 / 排序 / 竞态守卫 / CRUD 回包归约）
 * + ws-store 通知分支（notify:schedule-changed 归约与 fired 挂接 / notify:schedule-reminder 事件条与未读）
 * + 定时面板渲染（任务卡 / 已暂停徽章）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { AgentDefinition, ChatMessage, NotifyEnvelope, ScheduledTask } from '@multi-agent/shared'
import { SchedulePanel } from '../src/components/team/SchedulePanel'
import { useAgentStore } from '../src/stores/agent-store'
import { useRunStore } from '../src/stores/run-store'
import { useScheduleStore } from '../src/stores/schedule-store'
import { useSessionStore } from '../src/stores/session-store'
import { handleNotify, useWsStore } from '../src/stores/ws-store'

vi.mock('sonner', () => {
  const toastFn = vi.fn()
  return { toast: Object.assign(toastFn, { error: vi.fn(), success: vi.fn() }) }
})
import { toast } from 'sonner'

const SID = 's-sched'
const T0 = '2026-09-18T08:00:00.000Z'
/** 通知 seq 全局递增（handleNotify 按会话去重水位：跨用例共享模块级 cursors） */
let seq = 1

function res(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

function mkTask(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 't-1',
    sessionId: SID,
    title: '每日巡检',
    kind: 'run',
    instruction: '巡检进度并简报',
    targetAgentId: 'pm',
    spec: { kind: 'cron', expr: '0 9 * * *' },
    timezone: 'Asia/Shanghai',
    enabled: true,
    createdBy: 'user',
    runCount: 0,
    failStreak: 0,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  }
}

function mkAgent(id: string, name: string): AgentDefinition {
  return {
    id,
    name,
    role: '测试角色',
    title: '测试角色',
    description: '',
    capabilities: [],
    group: 'development',
    avatar: { gradient: ['#3b82f6', '#f59e0b'], icon: 'user' },
    handoff: [],
  }
}

function mkMessage(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-sched-1',
    sessionId: SID,
    role: 'user',
    content: '@pm 巡检进度并简报',
    mentions: ['pm'],
    status: 'complete',
    createdAt: T0,
    scheduleId: 't-1',
    ...over,
  }
}

function env(type: NotifyEnvelope['type'], sessionId: string, payload: Record<string, unknown>, runId?: string): NotifyEnvelope {
  return { v: 1, id: `n-${seq}`, seq: seq++, type, ts: T0, sessionId, payload, runId }
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => res({}))
  vi.stubGlobal('fetch', fetchMock)
  useSessionStore.setState({
    currentId: SID,
    sessions: [{ id: SID, title: '定时测试', participantIds: ['pm'], createdAt: T0, updatedAt: T0, messageCount: 0 }],
    byId: new Map(),
    order: [],
  })
  useAgentStore.setState({ agents: [mkAgent('pm', '费利'), mkAgent('qa', '柯莉')] as unknown as AgentDefinition[] })
  useRunStore.setState({ runId: undefined, sessionId: undefined, active: false })
  useScheduleStore.setState({ sessionId: undefined, tasks: [], loading: false })
  useWsStore.setState({ unread: {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('M35 schedule-store：加载与归约', () => {
  it('load：按 next_run_at 升序归约（无 next 置末）', async () => {
    const late = mkTask({ id: 't-late', nextRunAt: '2026-09-19T01:00:00.000Z' })
    const early = mkTask({ id: 't-early', nextRunAt: '2026-09-18T09:00:00.000Z' })
    const none = mkTask({ id: 't-none', kind: 'remind', spec: { kind: 'once', at: T0 }, enabled: false, nextRunAt: undefined })
    fetchMock.mockImplementation(async (url: RequestInfo | URL) =>
      String(url).includes(`/sessions/${SID}/schedules`) ? res({ schedules: [late, none, early] }) : res({}),
    )
    await useScheduleStore.getState().load(SID)
    expect(useScheduleStore.getState().sessionId).toBe(SID)
    expect(useScheduleStore.getState().tasks.map((t) => t.id)).toEqual(['t-early', 't-late', 't-none'])
  })

  it('load：切换会话竞态守卫（迟到的旧响应被丢弃）', async () => {
    let resolveA: ((v: Response) => void) | undefined
    fetchMock.mockImplementation((url: RequestInfo | URL) => {
      const u = String(url)
      if (u.includes('/sessions/A/schedules')) return new Promise<Response>((resolve) => { resolveA = resolve })
      if (u.includes('/sessions/B/schedules')) return Promise.resolve(res({ schedules: [mkTask({ id: 'tb', sessionId: 'B' })] }))
      return Promise.resolve(res({}))
    })
    const pA = useScheduleStore.getState().load('A')
    const pB = useScheduleStore.getState().load('B')
    await pB
    resolveA!(res({ schedules: [mkTask({ id: 'ta', sessionId: 'A' })] }))
    await pA
    expect(useScheduleStore.getState().sessionId).toBe('B')
    expect(useScheduleStore.getState().tasks.map((t) => t.id)).toEqual(['tb'])
  })

  it('applyTask / dropTask：同 id 覆盖、新 id 追加、删除移除（跨会话守卫）', () => {
    const store = useScheduleStore.getState()
    store.applyTask(mkTask({ id: 't-1', title: '旧标题' }), SID) // 未绑定 → 直接归约
    useScheduleStore.setState({ sessionId: SID })
    store.applyTask(mkTask({ id: 't-1', title: '新标题' }), SID)
    store.applyTask(mkTask({ id: 't-2', title: '第二个' }), SID)
    expect(useScheduleStore.getState().tasks.map((t) => t.title).sort()).toEqual(['新标题', '第二个'].sort())
    store.dropTask('t-1', SID)
    expect(useScheduleStore.getState().tasks.map((t) => t.id)).toEqual(['t-2'])
    // 跨会话守卫：已绑定 SID，来自其他会话的归约被丢弃
    store.applyTask(mkTask({ id: 't-3' }), 's-other')
    expect(useScheduleStore.getState().tasks.map((t) => t.id)).toEqual(['t-2'])
  })
})

describe('M35 schedule-store：CRUD 回包归约', () => {
  it('create / update / setEnabled / runNow / remove 与路径语义', async () => {
    const calls: Array<{ url: string; method: string }> = []
    fetchMock.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      calls.push({ url: u, method: init?.method ?? 'GET' })
      if (u.endsWith(`/sessions/${SID}/schedules`) && init?.method === 'POST') return res({ task: mkTask() })
      if (u === '/api/schedules/t-1' && init?.method === 'PATCH') return res({ task: mkTask({ title: '改名后' }) })
      if (u === '/api/schedules/t-1/pause' && init?.method === 'POST') return res({ task: mkTask({ enabled: false }) })
      if (u === '/api/schedules/t-1/resume' && init?.method === 'POST') return res({ task: mkTask({ enabled: true }) })
      if (u === '/api/schedules/t-1/run' && init?.method === 'POST') return res({ task: mkTask({ runCount: 1 }), runId: 'run_x' })
      if (u === '/api/schedules/t-1' && init?.method === 'DELETE') return res({ ok: true })
      return res({})
    })
    useScheduleStore.setState({ sessionId: SID })

    const created = await useScheduleStore.getState().create({
      title: '每日巡检',
      kind: 'run',
      instruction: '巡检',
      targetAgentId: 'pm',
      spec: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
    })
    expect(created.id).toBe('t-1')
    expect(useScheduleStore.getState().tasks).toHaveLength(1)

    await useScheduleStore.getState().update('t-1', { title: '改名后' })
    expect(useScheduleStore.getState().tasks[0].title).toBe('改名后')

    await useScheduleStore.getState().setEnabled('t-1', false)
    expect(useScheduleStore.getState().tasks[0].enabled).toBe(false)
    await useScheduleStore.getState().setEnabled('t-1', true)
    expect(useScheduleStore.getState().tasks[0].enabled).toBe(true)

    const run = await useScheduleStore.getState().runNow('t-1')
    expect(run.runId).toBe('run_x')
    expect(useScheduleStore.getState().tasks[0].runCount).toBe(1)

    await useScheduleStore.getState().remove('t-1')
    expect(useScheduleStore.getState().tasks).toHaveLength(0)

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST /api/sessions/${SID}/schedules`,
      'PATCH /api/schedules/t-1',
      'POST /api/schedules/t-1/pause',
      'POST /api/schedules/t-1/resume',
      'POST /api/schedules/t-1/run',
      'DELETE /api/schedules/t-1',
    ])
  })
})

describe('M35 ws-store：定时通知分支', () => {
  it('notify:schedule-changed（fired）：消息落定 + 任务归约 + 当前会话自动挂接播放', () => {
    useScheduleStore.setState({ sessionId: SID, tasks: [mkTask()] })
    fetchMock.mockImplementation(async () => res({ approvals: [] }))
    const message = mkMessage()
    handleNotify(
      env('notify:schedule-changed', SID, { action: 'fired', task: mkTask({ runCount: 1, lastRunId: 'run_x' }), message, runId: 'run_x' }),
    )
    expect(useSessionStore.getState().byId.get(message.id)?.scheduleId).toBe('t-1')
    expect(useScheduleStore.getState().tasks[0].runCount).toBe(1)
    expect(useRunStore.getState().runId).toBe('run_x')
    expect(useRunStore.getState().sessionId).toBe(SID)
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('已触发'))
  })

  it('notify:schedule-changed（deleted / paused）：删除移除 / 自动暂停提示', () => {
    useScheduleStore.setState({ sessionId: SID, tasks: [mkTask()] })
    handleNotify(env('notify:schedule-changed', SID, { action: 'paused', task: mkTask({ enabled: false, lastStatus: 'paused', lastError: '连续 3 次触发失败' }) }))
    expect(useScheduleStore.getState().tasks[0].enabled).toBe(false)
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('自动暂停'))
    handleNotify(env('notify:schedule-changed', SID, { action: 'deleted', task: mkTask() }))
    expect(useScheduleStore.getState().tasks).toHaveLength(0)
  })

  it('notify:schedule-reminder：当前会话落事件条；后台会话计未读', () => {
    const message = mkMessage({ id: 'msg-remind', role: 'system', content: '⏰ 定时提醒：站会提醒' })
    handleNotify(env('notify:schedule-reminder', SID, { task: mkTask({ kind: 'remind' }), messageId: message.id, message }))
    expect(useSessionStore.getState().byId.get('msg-remind')).toBeTruthy()
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('定时提醒'))

    const other = mkMessage({ id: 'msg-remind-2', sessionId: 's-other' })
    handleNotify(env('notify:schedule-reminder', 's-other', { task: mkTask({ kind: 'remind', sessionId: 's-other' }), messageId: other.id, message: other }))
    expect(useWsStore.getState().unread['s-other']).toBe(1)
    expect(useSessionStore.getState().byId.get('msg-remind-2')).toBeUndefined()
  })
})

describe('M35 定时面板：渲染', () => {
  it('任务卡呈现标题 / 规格 / 目标成员 / 已暂停徽章', async () => {
    const tasks = [
      mkTask({ id: 't-run', title: '每日巡检', nextRunAt: '2026-09-19T01:00:00.000Z' }),
      mkTask({ id: 't-remind', title: '站会提醒', kind: 'remind', targetAgentId: undefined, enabled: false, lastStatus: 'paused' }),
    ]
    fetchMock.mockImplementation(async (url: RequestInfo | URL) =>
      String(url).includes(`/sessions/${SID}/schedules`) ? res({ schedules: tasks }) : res({}),
    )
    render(<SchedulePanel />)
    await waitFor(() => expect(screen.getByText('每日巡检')).toBeTruthy())
    expect(screen.getByText('站会提醒')).toBeTruthy()
    expect(screen.getAllByText('已暂停').length).toBeGreaterThan(0)
    expect(screen.getByText('运行')).toBeTruthy()
    expect(screen.getByText('提醒')).toBeTruthy()
    // 规格描述（shared.describeScheduleSpec 文案）
    expect(screen.getAllByText('每天 09:00').length).toBeGreaterThan(0)
  })
})
