/**
 * run-store 事件归约（M8）：审批请求/结果、任务清单更新、上下文压缩计数。
 * M52-D：订阅晚到兜底（attach 收尾路径）——仅 HTTP 非 ok（404）兜底；
 * 「200 流无 run:end 异常自然结束」由“立即收束”改为 3s × 2 退避自动重附着（重试期间保持 active），耗尽后刷新兜底 + 提示一次。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest, RunEvent, TaskItem } from '@multi-agent/shared'
import { handleRunEvent, useRunStore, attachActiveRunFor } from '../src/stores/run-store'
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

  it('200 流自然结束但无 run:end（异常降级）：进入 3s 退避重试（重试期间保持 active，不立即兜底）', async () => {
    // M79-V：异常自然结束不再立即收束——退避重试（3s × 2）；耗尽后的刷新兜底+提示
    // 由 m79-stream-retry.test 覆盖；此处锁定「重试窗口内」的中间态与定时器纪律。
    const streamCalls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL) => {
        const approved = approvalsOk(url)
        if (approved) return Promise.resolve(approved)
        streamCalls.push(String(url))
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
    )

    useRunStore.getState().attach('r1', 's1')
    await sleep(30)

    expect(streamCalls).toHaveLength(1) // 首次流已结束，尚未到 3s 重试点
    expect(useRunStore.getState().active).toBe(true) // 重试期间不闪跳
    expect(refresh).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
    // 清理：避免 3s 后重试定时器跨用例触发
    useRunStore.getState().detach()
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

/**
 * 会话切换的运行状态隔离（防「下一棒」等运行状态跨会话串入）：
 * 切换会话必须断开本地旧流并清空队列；同一会话已挂接时短路保持。
 */
describe('attachActiveRunFor：会话切换的运行状态隔离', () => {
  const json = (data: unknown): Response =>
    new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  afterEach(() => {
    useRunStore.getState().detach()
    vi.unstubAllGlobals()
  })

  it('目标会话无进行中运行：断开本地旧流并清空队列 / 运行归属', async () => {
    useRunStore.setState({
      runId: 'r_old',
      sessionId: 's_old',
      active: true,
      queue: ['analyst'],
      currentWave: ['analyst'],
      waveIndex: 2,
    })
    useSessionStore.setState({ currentId: 's_new' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ runs: [] }))))

    const found = await attachActiveRunFor('s_new')

    expect(found).toBe(false)
    const st = useRunStore.getState()
    expect(st.active).toBe(false)
    expect(st.queue).toEqual([])
    expect(st.currentWave).toEqual([])
    expect(st.runId).toBeUndefined()
    expect(st.sessionId).toBeUndefined()
  })

  it('同一会话已挂接运行流：短路保持（不发请求、状态不动）', async () => {
    useRunStore.setState({ runId: 'r1', sessionId: 's1', active: true, queue: ['pm'] })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const found = await attachActiveRunFor('s1')

    expect(found).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(useRunStore.getState().queue).toEqual(['pm'])
    expect(useRunStore.getState().sessionId).toBe('s1')
  })

  it('目标会话有进行中运行：重挂接新流（runId / 会话归属切换）', async () => {
    const encoder = new TextEncoder()
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL, init?: RequestInit): Promise<Response> => {
        const u = String(url)
        if (u.includes('/api/runs/active')) {
          return Promise.resolve(json({ runs: [{ runId: 'r2', sessionId: 's2', state: 'running', queue: ['qa'] }] }))
        }
        if (u.includes('/approvals')) return Promise.resolve(json({ approvals: [] }))
        // 悬挂流：先重放 run:start 快照（带新队列），随后仅响应 abort
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'run:start', runId: 'r2', sessionId: 's2', queue: ['qa'] })}\n\n`),
            )
            init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
          },
        })
        return Promise.resolve(new Response(stream, { status: 200 }))
      }),
    )
    useRunStore.setState({ runId: 'r_old', sessionId: 's_old', active: true, queue: ['analyst'] })
    useSessionStore.setState({ currentId: 's2' })

    const found = await attachActiveRunFor('s2')
    await sleep(10)

    expect(found).toBe(true)
    expect(useRunStore.getState().runId).toBe('r2')
    expect(useRunStore.getState().sessionId).toBe('s2')
    expect(useRunStore.getState().active).toBe(true)
    expect(useRunStore.getState().queue).toEqual(['qa'])
  })
})
