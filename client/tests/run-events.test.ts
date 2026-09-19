/**
 * run-store 事件归约（M8）：审批请求/结果、任务清单更新、上下文压缩计数。
 * M52-D：订阅晚到兜底（attach 收尾路径）——仅 HTTP 非 ok（404）兜底；
 * 「200 流无 run:end 自然结束」保持旧行为（真实链路 run:end 必达；单测锁定该边界）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest, RunEvent, TaskItem } from '@multi-agent/shared'
import { handleRunEvent, useRunStore } from '../src/stores/run-store'
import { useSessionStore } from '../src/stores/session-store'
import { useTaskStore } from '../src/stores/task-store'

function makeApproval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'ap1',
    runId: 'r1',
    sessionId: 's1',
    agentId: 'architect',
    action: 'git_commit',
    detail: 'git commit -m "feat: x"',
    options: ['approve', 'reject'],
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...over,
  }
}

function makeTask(over: Partial<TaskItem> = {}): TaskItem {
  return { id: 't1', sessionId: 's1', content: '搭骨架', status: 'pending', ord: 0, ...over }
}

beforeEach(() => {
  useRunStore.setState({
    runId: 'r1',
    sessionId: 's1',
    active: true,
    queued: false,
    queue: [],
    approvals: [],
    compressionCount: 0,
  })
  useSessionStore.setState({ currentId: 's1', sessions: [], byId: new Map(), order: [] })
  useTaskStore.setState({ sessionId: undefined, tasks: [], loading: false })
})

describe('run-store 审批事件', () => {
  it('approval:requested：追加挂起项', () => {
    handleRunEvent({ type: 'approval:requested', approval: makeApproval() })
    const approvals = useRunStore.getState().approvals
    expect(approvals).toHaveLength(1)
    expect(approvals[0].status).toBe('pending')
  })

  it('同一审批 id 幂等 upsert（重复事件不产生重复卡片）', () => {
    handleRunEvent({ type: 'approval:requested', approval: makeApproval() })
    handleRunEvent({ type: 'approval:requested', approval: makeApproval({ detail: '更新后的命令' }) })
    const approvals = useRunStore.getState().approvals
    expect(approvals).toHaveLength(1)
    expect(approvals[0].detail).toBe('更新后的命令')
  })

  it('approval:resolved：替换为结论（approved + decidedAt）', () => {
    handleRunEvent({ type: 'approval:requested', approval: makeApproval() })
    handleRunEvent({
      type: 'approval:resolved',
      approval: makeApproval({ status: 'approved', decision: 'approve', decidedAt: new Date().toISOString() }),
    })
    const approvals = useRunStore.getState().approvals
    expect(approvals).toHaveLength(1)
    expect(approvals[0].status).toBe('approved')
  })

  it('run:start：重置 approvals（新一轮从空开始）', () => {
    handleRunEvent({ type: 'approval:requested', approval: makeApproval() })
    const event: RunEvent = { type: 'run:start', runId: 'r2', sessionId: 's1', queue: ['pm'] }
    handleRunEvent(event)
    expect(useRunStore.getState().approvals).toEqual([])
    expect(useRunStore.getState().runId).toBe('r2')
  })
})

describe('run-store 回合事件（M52-D）', () => {
  it('turn:start：占位消息落 turnIndex（运行中计分板 / 回合轴 / 侧栏发言流即推进）', () => {
    handleRunEvent({ type: 'turn:start', runId: 'r1', agentId: 'affirmative', messageId: 'm1', turnIndex: 2 })
    const msg = useSessionStore.getState().byId.get('m1')
    expect(msg?.status).toBe('streaming')
    expect(msg?.turnIndex).toBe(2)
  })
})

describe('run-store 任务与压缩事件', () => {
  it('task:updated：转发给 task-store（含状态推进）', () => {
    handleRunEvent({
      type: 'task:updated',
      tasks: [makeTask(), makeTask({ id: 't2', content: '写接口', status: 'in_progress', ord: 1 })],
    })
    const tasks = useTaskStore.getState().tasks
    expect(tasks).toHaveLength(2)
    expect(tasks[1].status).toBe('in_progress')
  })

  it('context:compressed：压缩计数递增', () => {
    const event: RunEvent = {
      type: 'context:compressed',
      sessionId: 's1',
      untilSeq: 10,
      beforeTokens: 90_000,
      afterTokens: 40_000,
      degraded: false,
    }
    handleRunEvent(event)
    handleRunEvent(event)
    expect(useRunStore.getState().compressionCount).toBe(2)
  })

  it('queue:updated（M14）：指挥台重排广播直接对齐队列', () => {
    useRunStore.setState({ queue: ['backend', 'qa'] })
    handleRunEvent({ type: 'queue:updated', runId: 'r1', sessionId: 's1', queue: ['qa', 'backend'] })
    expect(useRunStore.getState().queue).toEqual(['qa', 'backend'])
  })
})

describe('run-store 订阅兜底（M52-D）', () => {
  const origRefresh = useSessionStore.getState().refreshMessages
  const origLoad = useSessionStore.getState().loadSessions
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  let refresh: ReturnType<typeof vi.fn>
  let load: ReturnType<typeof vi.fn>

  const approvalsOk = (url: string | URL): Response | null =>
    String(url).includes('/approvals')
      ? new Response(JSON.stringify({ approvals: [] }), { status: 200 })
      : null

  beforeEach(() => {
    refresh = vi.fn(async () => undefined)
    load = vi.fn(async () => undefined)
    useSessionStore.setState({ refreshMessages: refresh, loadSessions: load })
  })

  afterEach(() => {
    useSessionStore.setState({ refreshMessages: origRefresh, loadSessions: origLoad })
    vi.unstubAllGlobals()
  })

  it('订阅晚到（run 已结束 → stream 404）：事件链缺 run:end，全量刷新兜底且不伪造结束原因', async () => {
    useRunStore.setState({ lastEndReason: 'stopped' })
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL) => {
        const approved = approvalsOk(url)
        if (approved) return Promise.resolve(approved)
        return Promise.resolve(new Response(null, { status: 404 }))
      }),
    )

    useRunStore.getState().attach('r1', 's1')
    await sleep(30)

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledTimes(1)
    expect(useRunStore.getState().active).toBe(false)
    expect(useRunStore.getState().lastEndReason).toBe('stopped')
  })

  it('正常收尾（流内含 run:end）：仅事件路径刷新一次，兜底不追加', async () => {
    const body = 'data: {"type":"run:end","runId":"r1","sessionId":"s1","reason":"completed"}\n\n'
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL) => {
        const approved = approvalsOk(url)
        if (approved) return Promise.resolve(approved)
        return Promise.resolve(new Response(body, { status: 200 }))
      }),
    )

    useRunStore.getState().attach('r1', 's1')
    await sleep(30)

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(useRunStore.getState().active).toBe(false)
    expect(useRunStore.getState().lastEndReason).toBe('completed')
  })

  it('200 流自然结束但无 run:end（异常降级）：保持旧行为不兜底（兜底仅限 HTTP 非 ok）', async () => {
    // mock 测试常以「200 + 非 SSE 体」充当流端点：不能因此触发全量刷新（真实链路 run:end 必达）
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL) => {
        const approved = approvalsOk(url)
        if (approved) return Promise.resolve(approved)
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
    )

    useRunStore.getState().attach('r1', 's1')
    await sleep(30)

    expect(refresh).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
    expect(useRunStore.getState().active).toBe(false)
  })

  it('主动取消（detach → abort）：不触发兜底刷新', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL, init?: RequestInit): Promise<Response> => {
        const approved = approvalsOk(url)
        if (approved) return Promise.resolve(approved)
        // 悬挂流：仅响应 abort（模拟切换会话 / detach）
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
      }),
    )

    useRunStore.getState().attach('r1', 's1')
    await sleep(10)
    useRunStore.getState().detach()
    await sleep(30)

    expect(refresh).not.toHaveBeenCalled()
    expect(useRunStore.getState().active).toBe(false)
  })
})
