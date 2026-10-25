/**
 * 运行管线（§10）：发送 → SSE 订阅 → delta 批缓冲（40ms）→ 消息/状态归约。
 * 运行与连接解耦（§18.2）：切换会话仅断开本地流（服务端继续执行），重附着走 attach()。
 */
import { create } from 'zustand'
import { toast } from 'sonner'
import type {
  ApprovalRequest,
  ChatMessage,
  MessageAttachment,
  RunEndReason,
  RunEvent,
  ToolCallRecord,
  TurnIntent,
  TurnMode,
} from '@multi-agent/shared'
import { apiGet, apiPost } from '../lib/api'
import { streamRun } from '../lib/sse'
import { useAgentStore } from './agent-store'
import { usePlanStore } from './plan-store'
import { useSessionStore } from './session-store'
import { useTaskStore } from './task-store'
import { useUiStore } from './ui-store'

interface SendResponse {
  message: ChatMessage
  runId: string
  queue?: string[]
  queued?: boolean
  /** M3：运行中再发送 = 插话（不新建 Run） */
  injected?: boolean
  position?: number
}

export interface ActiveRunInfo {
  runId: string
  sessionId: string
  state: string
  queue: string[]
}

interface RunState {
  runId?: string
  sessionId?: string
  /** 本地是否正挂接着运行流 */
  active: boolean
  /** 提交后处于排队（并发上限）状态 */
  queued: boolean
  /** 待发言队列（含正在发言者） */
  queue: string[]
  /** M16：当前波成员（wave:start 驱动；串行波长度为 1；空 = 波间空闲） */
  currentWave: string[]
  /** M21：当前波序号（wave:start 驱动，0 起；非运行 = 0，图谱 HUD 显示「第 N 波」） */
  waveIndex: number
  /** 最近一次运行结束原因（庆祝/收尾动画依据） */
  lastEndReason?: RunEndReason
  /** M8：本 Run 的审批列表（pending 渲染审批卡；resolved 保留展示结论） */
  approvals: ApprovalRequest[]
  /** M8：上下文压缩计数（上下文档据此重拉快照） */
  compressionCount: number
  /** M24：mode = Composer 消息级范式（仅本条消息生效；缺省 = 未选择，尊重会话「规划先行」） */
  send: (content: string, mode?: TurnMode, attachments?: MessageAttachment[]) => Promise<void>
  /** M88：本 Run 的编排判定（可解释；Run Board 展示） */
  intent?: TurnIntent
  /** M88：运行期纠偏建议（写扩散 → 建议改用规划；仅提示） */
  planSuggestion?: { writes: number; agents: string[] }
  /** M86：手动派发下一棒（manual 接力；活跃 Run 插队首 / 空闲起新 Run） */
  dispatch: (agentId: string, note?: string) => Promise<void>
  attach: (runId: string, sessionId: string) => void
  stop: () => Promise<void>
  detach: () => void
  /** M8：审批决定（批准 / 拒绝 / 自定义反馈） */
  respondApproval: (approvalId: string, decision: 'approve' | 'reject' | 'custom', feedback?: string) => Promise<void>
  /** M14：指挥台重排队列（乐观更新，失败回滚；服务端 queue:updated 广播对齐） */
  reorderQueue: (agentIds: string[]) => Promise<void>
}

// ---------- M79-V：run 流断流自动重连 ----------
/** 断流自动重附着：退避间隔 / 最大重试次数（耗尽后走刷新兜底并提示一次） */
const STREAM_RETRY_DELAY_MS = 3000
const STREAM_MAX_RETRIES = 2
let retryTimer: ReturnType<typeof setTimeout> | undefined

function clearRetryTimer(): void {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = undefined
  }
}

// ---------- delta 批缓冲（§10.3）：40ms 窗口合并写入 ----------
const DELTA_FLUSH_MS = 40
let pendingDeltas = new Map<string, string>()
let pendingReasonings = new Map<string, string>()
let flushTimer: ReturnType<typeof setTimeout> | undefined
let controller: AbortController | undefined

function flushDeltas(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = undefined
  }
  if (pendingDeltas.size === 0 && pendingReasonings.size === 0) return
  const batches = pendingDeltas
  pendingDeltas = new Map()
  const thoughts = pendingReasonings
  pendingReasonings = new Map()
  const sessions = useSessionStore.getState()
  for (const [messageId, delta] of batches) sessions.appendDelta(messageId, delta)
  for (const [messageId, delta] of thoughts) sessions.appendReasoning(messageId, delta)
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(flushDeltas, DELTA_FLUSH_MS)
}

/** tool:call / tool:result：按 id 插入或覆盖消息的 toolCalls 项 */
function upsertToolCall(messageId: string, call: ToolCallRecord): void {
  const sessions = useSessionStore.getState()
  const message = sessions.byId.get(messageId)
  if (!message) return
  const list = message.toolCalls ?? []
  const idx = list.findIndex((c) => c.id === call.id)
  const next = [...list]
  if (idx === -1) next.push(call)
  else next[idx] = call
  sessions.patchMessage(messageId, { toolCalls: next })
}

/**
 * 运行收尾统一路径（run:end 事件归约 与「订阅晚到（HTTP 非 ok）」兜底共用；幂等）。
 * 兜底场景无真实结束原因：reason 缺省时不动 lastEndReason（不伪造），仅完成状态清理与全量刷新。
 */
function endRunLocally(sessionId: string, reason?: RunEndReason): void {
  const sessions = useSessionStore.getState()
  const agents = useAgentStore.getState()
  flushDeltas()
  useRunStore.setState({
    active: false,
    queued: false,
    queue: [],
    currentWave: [],
    waveIndex: 0,
    ...(reason ? { lastEndReason: reason } : {}),
  })
  for (const [id, status] of Object.entries(agents.statuses)) {
    if (status === 'speaking' || status === 'thinking') agents.setStatus(id, 'idle')
  }
  void sessions.loadSessions()
  if (sessions.currentId === sessionId) void sessions.refreshMessages()
  if (reason === 'stopped') toast.success('已停止本次协作')
  else if (reason === 'turn-limit') toast('达到回合上限，运行已收束，可继续补充指令')
  // M57 P3：配额超限收束（系统条已同时落库；此处仅轻提示）
  else if (reason === 'quota') toast('用量配额已超限，本次运行已收束（详情见系统消息）')
}

/** 运行事件归约（SSE 流与测试共用入口） */
export function handleRunEvent(event: RunEvent): void {
  const run = useRunStore.getState()
  const sessions = useSessionStore.getState()
  const agents = useAgentStore.getState()
  const sessionId = event.type === 'run:start' || event.type === 'run:end' ? event.sessionId : run.sessionId
  const sameSession = !!sessionId && sessionId === sessions.currentId

  switch (event.type) {
    case 'user:message':
      sessions.upsertMessage(event.message)
      break

    // M3：插话在回合边界被消费（幂等 upsert，重复不脏数据）
    case 'user:injected':
      sessions.upsertMessage(event.message)
      break

    case 'run:start':
      useRunStore.setState({
        runId: event.runId,
        sessionId: event.sessionId,
        active: true,
        queue: event.queue,
        currentWave: [],
        approvals: [],
        // M88：编排判定随快照下发（重附着也能拿到）
        intent: event.intent,
        planSuggestion: undefined,
      })
      break

    // M88：PRS 合并后的改判（首波前；携带可解释理由）
    case 'intent:decided':
      useRunStore.setState({ intent: event.intent })
      break

    // M88：运行期纠偏建议（不强制改判，只在 Run Board 提示）
    case 'intent:suggest-plan':
      useRunStore.setState({ planSuggestion: { writes: event.writes, agents: event.agents } })
      break

    // M16：波次启动（串行波也发，members 长度 1）——指挥台/并行组以波为单位归约
    case 'wave:start':
      useRunStore.setState({ currentWave: event.members, waveIndex: event.waveIndex })
      break

    case 'turn:start': {
      if (sameSession) {
        sessions.upsertMessage({
          id: event.messageId,
          sessionId: sessionId!,
          runId: run.runId,
          role: 'agent',
          agentId: event.agentId,
          // M77：说话成员键（分身实例；经典实例 = agentId）
          memberKey: event.memberKey ?? event.agentId,
          // M52-D：运行中即回填回合号（计分板 / 回合轴 / 侧栏发言流随消息推进，不再等 run:end 回填）
          turnIndex: event.turnIndex,
          // M24：本回合范式（规划 / 评审徽章）；execute 缺省不落
          mode: event.mode,
          content: '',
          mentions: [],
          status: 'streaming',
          createdAt: new Date().toISOString(),
          toolCalls: [],
        })
      }
      agents.setStatus(event.memberKey ?? event.agentId, 'speaking')
      break
    }

    case 'message:delta': {
      if (!sameSession) break
      pendingDeltas.set(event.messageId, (pendingDeltas.get(event.messageId) ?? '') + event.delta)
      scheduleFlush()
      break
    }

    case 'reasoning:delta': {
      if (!sameSession) break
      pendingReasonings.set(event.messageId, (pendingReasonings.get(event.messageId) ?? '') + event.delta)
      scheduleFlush()
      break
    }

    case 'tool:call':
    case 'tool:result': {
      if (sameSession) upsertToolCall(event.messageId, event.call)
      break
    }

    case 'artifact:updated':
      if (sameSession) sessions.bumpArtifacts()
      useUiStore.getState().noteArtifact(event.path)
      break

    // M8：审批请求 / 结果（同一 Run 内幂等 upsert）
    case 'approval:requested': {
      const approval = event.approval
      useRunStore.setState((s) => ({
        approvals: [...s.approvals.filter((a) => a.id !== approval.id), approval].slice(-20),
      }))
      toast(`模型请求审批：${approval.action}`)
      break
    }

    case 'approval:resolved': {
      const approval = event.approval
      useRunStore.setState((s) => ({
        approvals: [...s.approvals.filter((a) => a.id !== approval.id), approval].slice(-20),
      }))
      break
    }

    // M8：任务清单更新（右栏「任务」视图）
    case 'task:updated':
      useTaskStore.getState().apply(event.tasks)
      break

    // M24：计划提交 / 变更（计划卡 + 任务面板 2.0；未绑定会话时改为拉取快照，幂等 upsert）
    case 'plan:submitted':
    case 'plan:updated': {
      const plans = usePlanStore.getState()
      if (sessionId && plans.sessionId === sessionId) plans.applyPlan(event.plan, sessionId)
      else if (sessionId) void plans.load(sessionId)
      break
    }

    // M24：评审判定提交（计划卡评审区 / 面板徽章）
    case 'review:submitted': {
      const plans = usePlanStore.getState()
      if (sessionId && plans.sessionId === sessionId) plans.applyReview(event.review, sessionId)
      else if (sessionId) void plans.load(sessionId)
      break
    }

    // M8：上下文压缩（上下文电池/上下文抽屉重拉快照）
    case 'context:compressed': {
      useRunStore.setState((s) => ({ compressionCount: s.compressionCount + 1 }))
      if (sameSession) {
        toast(event.degraded ? '上下文超预算：已降级截断部分历史' : '上下文已压缩：早期历史已折叠为摘要')
      }
      break
    }

    case 'turn:end': {
      if (sameSession) {
        flushDeltas()
        sessions.patchMessage(event.messageId, { mentions: event.mentions, status: event.status })
      }
      useRunStore.setState({ queue: event.queue })
      const message = useSessionStore.getState().byId.get(event.messageId)
      const delivered = message?.toolCalls?.some(
        (c) => c.status === 'ok' && (c.name === 'write_file' || c.name === 'edit_file'),
      )
      agents.setStatus(event.memberKey ?? event.agentId, delivered ? 'done' : 'idle')
      break
    }

    // M14：指挥台重排广播（与本地乐观更新幂等对齐）
    case 'queue:updated':
      useRunStore.setState({ queue: event.queue })
      break

    case 'run:end':
      // 统一收尾（与 attach 的订阅晚到兜底共用，行为与之前逐行等价）
      endRunLocally(event.sessionId, event.reason)
      break

    case 'error':
      toast.error(event.message)
      break
  }
}

export const useRunStore = create<RunState>((set, get) => ({
  active: false,
  queued: false,
  queue: [],
  currentWave: [],
  waveIndex: 0,
  approvals: [],
  compressionCount: 0,

  send: async (content, mode, attachments) => {
    const sessionId = useSessionStore.getState().currentId
    if (!sessionId) return
    // M24：消息级范式随消息提交（plan / review；缺省不传 = 未选择，服务端按「规划先行」→ execute 兜底）
    // M33：附件随消息提交（可空正文 + 附件；服务端校验文件存在性与归属）
    const body: Record<string, unknown> = { content }
    if (mode) body.mode = mode
    if (attachments && attachments.length > 0) body.attachments = attachments
    const res = await apiPost<SendResponse>(`/api/sessions/${sessionId}/messages`, body)
    useSessionStore.getState().upsertMessage(res.message)
    if (res.injected) {
      // M3：运行中再发送 = 插话，团队将在当前回合结束后看到（不新建 Run）
      toast(res.position && res.position > 1 ? `已插话（第 ${res.position} 条）：团队将在当前回合结束后处理` : '已插话：团队将在当前回合结束后处理')
      set({ queued: false })
      if (get().runId !== res.runId) get().attach(res.runId, sessionId)
      return
    }
    if (res.queued) toast.success('已排队：前一轮运行结束后自动开始')
    set({ queued: res.queued ?? false })
    get().attach(res.runId, sessionId)
  },

  dispatch: async (agentId, note) => {
    const sessionId = useSessionStore.getState().currentId
    if (!sessionId) return
    const res = await apiPost<{ runId: string; queue: string[]; queued: boolean }>(
      `/api/sessions/${sessionId}/dispatch`,
      { agentId, ...(note?.trim() ? { note: note.trim() } : {}) },
    )
    set({ queued: res.queued ?? false })
    // 同一 Run：只同步队列（服务端已广播 queue:updated，此处乐观对齐）
    if (get().runId === res.runId) {
      set({ queue: res.queue })
      return
    }
    get().attach(res.runId, sessionId)
  },

  attach: (runId, sessionId) => {
    controller?.abort()
    clearRetryTimer()
    // 局部引用：闭包内判断本流是否被主动取消（模块级 controller 会被后续 attach 覆盖）
    const myController = new AbortController()
    controller = myController
    set({ runId, sessionId, active: true, approvals: [] })
    let sawEnd = false
    let retries = 0

    // M8：重附着时恢复审批卡状态（挂起 + 历史）
    // M79-V：断流重试属“重附着”语义——run:start 快照重发会清空 approvals，每次尝试都要恢复
    const loadApprovals = (): void => {
      void apiGet<{ approvals: ApprovalRequest[] }>(`/api/runs/${runId}/approvals`)
        .then((res) => {
          if (useRunStore.getState().runId === runId) set({ approvals: res.approvals })
        })
        .catch(() => undefined)
    }

    const attempt = (): void => {
      loadApprovals()
      void streamRun(
        `/api/runs/${runId}/stream`,
        {
          onEvent: (event) => {
            // 流来源守卫：attach 被替换（切会话 / 新 attach）或 detach 后，旧流的迟到事件不再改写运行状态
            if (controller !== myController) return
            if (event.type === 'run:end') sawEnd = true
            handleRunEvent(event)
          },
          onEnd: (info) => {
            // 仍是当前运行 + 仍持有本流（runId 相同但被新 attach 替换的场景由 controller 守卫）
            if (useRunStore.getState().runId !== runId || controller !== myController) return
            // 主动取消（切换会话 / detach / 新 attach 先行中止旧流）不兜底不重试
            if (myController.signal.aborted) {
              set({ active: false })
              return
            }
            // 正常收束（run:end 已收）
            if (sawEnd) {
              set({ active: false })
              return
            }
            // M52-D：订阅晚到（短 Run 在 attach 前已结束并出栈 → HTTP 非 ok）→ 刷新兜底（重试无意义）
            if (info?.httpStatus) {
              endRunLocally(sessionId)
              return
            }
            // M79-V：200 流异常自然结束（网络中断等）→ 退避自动重附着（期间保持 active，UI 不闪跳）
            if (retries < STREAM_MAX_RETRIES) {
              retries++
              clearRetryTimer()
              retryTimer = setTimeout(() => {
                retryTimer = undefined
                if (useRunStore.getState().runId !== runId || myController.signal.aborted) return
                attempt()
              }, STREAM_RETRY_DELAY_MS)
              return
            }
            // 重试耗尽：刷新兜底（最终一致）+ 明确提示一次
            toast.error('运行流连接不稳定，已停止重连；最新进展可在会话中查看')
            endRunLocally(sessionId)
          },
          onError: () => {
            // M79-V：不逐次提示——瞬时断流由 onEnd 分支自动重试；最终失败在耗尽分支提示
          },
        },
        myController.signal,
      )
    }
    attempt()
  },

  stop: async () => {
    const runId = get().runId
    if (!runId) return
    try {
      await apiPost(`/api/runs/${runId}/stop`)
    } catch (err) {
      toast.error((err as Error).message)
    }
  },

  respondApproval: async (approvalId, decision, feedback) => {
    const runId = get().runId
    if (!runId) return
    const res = await apiPost<{ approval: ApprovalRequest }>(`/api/runs/${runId}/approvals/${approvalId}`, {
      decision,
      feedback,
    })
    set((s) => ({ approvals: s.approvals.map((a) => (a.id === approvalId ? res.approval : a)) }))
  },

  reorderQueue: async (agentIds) => {
    const { runId, queue: previous } = get()
    if (!runId) return
    set({ queue: agentIds }) // 乐观更新：指挥台点击即时生效
    try {
      const res = await apiPost<{ queue: string[] }>(`/api/runs/${runId}/queue`, { agentIds })
      set({ queue: res.queue })
    } catch (err) {
      set({ queue: previous }) // 回滚（运行已结束 / 校验失败）
      toast.error((err as Error).message)
    }
  },

  detach: () => {
    controller?.abort()
    controller = undefined
    clearRetryTimer()
    flushDeltas()
    // 清 runId / sessionId：断流后 WS 的队列广播（notify:queue-updated 按 runId 匹配）不再改写本地状态
    set({ runId: undefined, sessionId: undefined, active: false, queue: [], currentWave: [], waveIndex: 0 })
  },
}))

/** 会话切换后重附着：查询进行中运行并挂接（§18.2）。无匹配运行 = 断开本地旧流，防跨会话状态残留 */
export async function attachActiveRunFor(sessionId: string): Promise<boolean> {
  const store = useRunStore.getState()
  // 同一会话已挂接着运行流：保持现状（避免重放抖动）
  if (store.active && store.sessionId === sessionId) return true
  // §18.2：切换会话仅断开本地流（服务端继续执行）——先清掉上一个会话的运行进度，
  // 防止旧 Run 的队列 / 下一棒状态残留到新会话 UI（「下一棒」提示、成员条排队序号等）
  store.detach()
  try {
    const res = await apiGet<{ runs: ActiveRunInfo[] }>('/api/runs/active')
    // 竞态守卫：查询期间会话又被切换（快速连点）——迟到响应不覆盖新会话状态
    if (useSessionStore.getState().currentId !== sessionId) return false
    const run = res.runs.find((r) => r.sessionId === sessionId)
    if (!run) return false
    useRunStore.getState().attach(run.runId, sessionId)
    return true
  } catch {
    return false
  }
}
