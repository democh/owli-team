/**
 * WS 通知接入（§18.5 / §18.6）：
 * - 未读计数（会话列表角标） + toast + 系统通知 + favicon 角标 + 标题闪烁；
 * - event 去重：每会话 seq 水位（同时作为重连补发游标）；
 * - 降级：WS 未连通且页面可见时走 /api/notifications 轮询（同一数据源）。
 */
import { create } from 'zustand'
import { toast } from 'sonner'
import type {
  AgentRunState,
  ApprovalRequest,
  BrowserState,
  ChatMessage,
  MediaJob,
  NotifyEnvelope,
  NotifyListResponse,
  OpEvent,
  Plan,
  ReviewRecord,
  ScheduledTask,
  Session,
} from '@multi-agent/shared'
import { ASSETS_TOPIC, MCP_TOPIC } from '@multi-agent/shared'
import { apiGet } from '../lib/api'
import { NotifySocket, type WsStatus } from '../lib/ws'
import { useAgentStore } from './agent-store'
import { useBrowserStore } from './browser-store'
import { useCanvasStore } from './canvas-store'
import { useConnectionsStore } from './connections-store'
import { useConsoleStore } from './console-store'
import { useLiveDockStore } from './live-dock-store'
import { useLivePanelStore } from './live-panel-store'
import { useMcpStore } from './mcp-store'
import { useMediaStore } from './media-store'
import { usePlanStore } from './plan-store'
import { useRunStore } from './run-store'
import { useScheduleStore } from './schedule-store'
import { useSessionStore } from './session-store'
import { useTaskStore } from './task-store'
import { useUiStore } from './ui-store'

interface WsState {
  status: WsStatus
  /** sessionId → 未读数 */
  unread: Record<string, number>
  init: () => void
  /** M8：断线提示条的「重连」按钮 */
  reconnect: () => void
  ensureSubscribed: (sessionId: string) => void
  markRead: (sessionId: string) => void
}

let socket: NotifySocket | undefined
const subscribed = new Set<string>()
/** 每会话 seq 水位：去重 + 重连补发游标 */
const cursors = new Map<string, number>()
let pollTimer: ReturnType<typeof setInterval> | undefined
let flashTimer: ReturnType<typeof setInterval> | undefined
let flashing = false
let baseTitle = '多 Agent 研发团队'
/** 通知降级轮询间隔（M4：由 GET /api/health 下发 NOTIFY_POLL_MS，默认 8s） */
let pollMs = 8000

function sessionTitle(sessionId: string): string {
  const s = useSessionStore.getState().sessions.find((x) => x.id === sessionId)
  return s?.title ?? '会话'
}

function totalUnread(unread: Record<string, number>): number {
  return Object.values(unread).reduce((a, b) => a + b, 0)
}

function setFavicon(count: number): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (link) link.href = count > 0 ? '/favicon-unread.svg' : '/favicon.svg'
}

function stopFlash(): void {
  if (flashTimer) {
    clearInterval(flashTimer)
    flashTimer = undefined
  }
  if (flashing) {
    document.title = baseTitle
    flashing = false
  }
}

function startFlash(): void {
  if (flashing) return
  flashing = true
  let on = false
  flashTimer = setInterval(() => {
    on = !on
    document.title = on ? '● 有新的协作动态' : baseTitle
  }, 900)
}

/** favicon 角标 + 隐藏时标题闪烁 */
function syncBadge(unread: Record<string, number>): void {
  const total = totalUnread(unread)
  setFavicon(total)
  if (total > 0 && document.visibilityState === 'hidden') startFlash()
  else stopFlash()
}

function systemNotify(title: string, body: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  try {
    new Notification(title, { body })
  } catch {
    // 部分环境禁止构造，忽略
  }
}

/** 通知归约（WS socket 与测试共用入口；按类型分发到各领域 store） */
export function handleNotify(env: NotifyEnvelope): void {
  const last = cursors.get(env.sessionId) ?? 0
  if (env.seq <= last) return // 去重：WS 补发 / 轮询 / 重放交叉
  cursors.set(env.sessionId, env.seq)

  const sessions = useSessionStore.getState()
  const run = useRunStore.getState()
  const sameSession = env.sessionId === sessions.currentId
  const visible = document.visibilityState === 'visible'
  const handledBySse = sameSession && visible && !!env.runId && env.runId === run.runId

  switch (env.type) {
    case 'notify:agent-status': {
      const agentId = String(env.payload.agentId ?? '')
      const status = env.payload.status as AgentRunState | undefined
      if (agentId && status) useAgentStore.getState().setStatus(agentId, status)
      break
    }

    case 'notify:artifact-updated': {
      if (sameSession) sessions.bumpArtifacts()
      useUiStore.getState().noteArtifact(String(env.payload.path ?? ''))
      // M49：实况·交付件面软跟随（仅当前会话；面板未停在交付件面时不打扰）
      if (sameSession) useLivePanelStore.getState().noteArtifact(String(env.payload.path ?? ''))
      break
    }

    // M31：画布远端变更（agent canvas_write / 其他标签页保存）——本地空闲立即拉取合流，脏则保存后补拉
    case 'notify:canvas-changed': {
      useCanvasStore
        .getState()
        .handleRemoteChange(env.sessionId, Number(env.payload.version ?? 0), String(env.payload.by) === 'agent' ? 'agent' : 'user')
      break
    }

    // M31：媒体任务状态（创建 / 进度 / 终态；完成落画布与提示由 media-store 统一收口）
    case 'notify:media-job': {
      const job = env.payload.job as MediaJob | undefined
      if (job?.id) useMediaStore.getState().ingest(job)
      break
    }

    // M8：任务清单变更（SSE 未挂接时由 WS 通知补刷右栏「任务」视图）
    case 'notify:task-updated': {
      if (sameSession) void useTaskStore.getState().load(env.sessionId)
      break
    }

    // M24：计划提交 / 变更 / 评审（SSE 未挂接或非当前 Run 时的兜底；幂等 upsert）
    case 'notify:plan-submitted':
    case 'notify:plan-updated': {
      const plan = env.payload.plan as Plan | undefined
      const review = env.payload.review as ReviewRecord | undefined
      const message = env.payload.message as ChatMessage | undefined
      if (sameSession) {
        if (message) sessions.upsertMessage(message) // 协议违规等系统事件条
        const plans = usePlanStore.getState()
        if (plans.sessionId === env.sessionId) {
          if (plan) plans.applyPlan(plan, env.sessionId)
          if (review) plans.applyReview(review, env.sessionId)
        } else {
          void plans.load(env.sessionId) // 尚未绑定（页面新开 / 刚切会话）→ 拉取权威快照
        }
      } else if (env.type === 'notify:plan-submitted') {
        // 后台会话的新计划（待批准的可操作信号）计未读；步骤进度类更新不打扰
        const next = { ...useWsStore.getState().unread }
        next[env.sessionId] = (next[env.sessionId] ?? 0) + 1
        useWsStore.setState({ unread: next })
        syncBadge(next)
      }
      break
    }

    // M10：审批事件兜底 —— SSE 建立前的 approval:requested 不丢（upsert 幂等）
    case 'notify:approval-requested':
    case 'notify:approval-resolved': {
      if (handledBySse) break // 当前可见的流已处理同一事件
      const approval = env.payload.approval as ApprovalRequest | undefined
      if (approval) {
        useRunStore.setState((s) => ({
          approvals: [...s.approvals.filter((a) => a.id !== approval.id), approval].slice(-20),
        }))
        if (env.type === 'notify:approval-requested') toast(`模型请求审批：${approval.action}`)
      }
      break
    }

    // M22：操作事件（连接 / 数据库 / 浏览器动作的实时可视化）
    case 'notify:op': {
      const op = env.payload as unknown as OpEvent
      if (op?.id) {
        const event = { ...op, sessionId: op.sessionId || env.sessionId }
        // M49：实况面板先执行（可能程序性切视图到实况）→ 直播窗让位判定即时生效
        useLivePanelStore.getState().noteOp(event)
        useConnectionsStore.getState().pushOp(event)
        useLiveDockStore.getState().noteOp(event) // 直播窗：自动滑入 / 静音拦截 / tab 跟随
      }
      break
    }

    // M22：浏览器会话状态（面板未订阅帧流时的下限同步；会话 id 不匹配则忽略）
    case 'notify:browser-status': {
      const browser = useBrowserStore.getState()
      const browserSessionId = String(env.payload.browserSessionId ?? '')
      const nextState = env.payload.state as BrowserState | undefined
      if (browser.session && browserSessionId === browser.session.id && nextState) {
        const controller = env.payload.controller === 'human' ? 'human' : env.payload.controller === 'agent' ? 'agent' : browser.session.controller
        useBrowserStore.setState({ session: { ...browser.session, state: nextState, controller } })
      }
      break
    }

    case 'notify:turn-end':
      // 旁观态轻微信号：不打扰、不计未读（进度已由右栏面板体现）
      break

    // M22+：新 Run 开始 → 重置直播窗的静音与自动弹出标记（新 Run 可再次滑入）
    // M49：同步重置实况面板 Run 级护栏（viewLockedRunId / 面锁 / 暂停跟随）
    case 'notify:run-started':
      useLiveDockStore.getState().beginRun()
      useLivePanelStore.getState().beginRun()
      break

    // M16：会话成员变更（加入 / 移出 / 换灵魂）——当前会话同步事件条与成员表；其他会话计未读
    case 'notify:members-changed': {
      const session = env.payload.session as Session | undefined
      const message = env.payload.message as ChatMessage | undefined
      if (sameSession) {
        if (session) sessions.applySession(session)
        if (message) sessions.upsertMessage(message)
      } else {
        const next = { ...useWsStore.getState().unread }
        next[env.sessionId] = (next[env.sessionId] ?? 0) + 1
        useWsStore.setState({ unread: next })
        syncBadge(next)
      }
      break
    }

    // M26：资产变更（Agent / Skill / 场景；保留主题 __assets__）——多标签页同步，不计未读
    case 'notify:assets-changed': {
      void useConsoleStore.getState().refreshAll() // 内部含 agent-store.reload
      break
    }

    // M27：MCP 变更（服务器 / 状态 / 工具清单 / 绑定；保留主题 __mcp__）——多标签页同步，不计未读
    case 'notify:mcp-changed': {
      void useMcpStore.getState().refreshAll()
      break
    }

    // M35：定时任务变更（创建 / 更新 / 删除 / 触发 / 跳过 / 自动暂停）——当前会话归约列表；
    // fired 携带注入消息与 runId：当前会话自动挂接播放（会话级互斥保证不与现有流冲突）
    case 'notify:schedule-changed': {
      const task = env.payload.task as ScheduledTask | undefined
      const message = env.payload.message as ChatMessage | undefined
      const action = String(env.payload.action ?? '')
      if (sameSession && message) sessions.upsertMessage(message)
      if (task) {
        const schedules = useScheduleStore.getState()
        if (action === 'deleted') schedules.dropTask(task.id, env.sessionId)
        else schedules.applyTask(task, env.sessionId)
      }
      if (action === 'fired') {
        if (sameSession && typeof env.payload.runId === 'string') {
          useRunStore.getState().attach(env.payload.runId, env.sessionId)
        }
        toast(`定时任务「${task?.title ?? ''}」已触发`)
      } else if (action === 'paused') {
        // 失败护栏：连续失败被自动暂停（可操作信号，任何会话都提醒）
        toast.error(`定时任务「${task?.title ?? ''}」已自动暂停：${task?.lastError ?? ''}`)
      }
      break
    }

    // M35：定时提醒触发（remind）——落事件条 + toast；后台会话计未读（提醒必须用户可见）
    case 'notify:schedule-reminder': {
      const task = env.payload.task as ScheduledTask | undefined
      const message = env.payload.message as ChatMessage | undefined
      if (sameSession) {
        if (message) sessions.upsertMessage(message)
        if (task) useScheduleStore.getState().applyTask(task, env.sessionId)
        toast(`⏰ 定时提醒：${task?.title ?? ''}`)
      } else {
        const text = `⏰ ${sessionTitle(env.sessionId)}：${task?.title ?? '定时提醒'}`
        toast(text)
        if (!visible) systemNotify('多 Agent 研发团队', text)
        const next = { ...useWsStore.getState().unread }
        next[env.sessionId] = (next[env.sessionId] ?? 0) + 1
        useWsStore.setState({ unread: next })
        syncBadge(next)
      }
      break
    }

    case 'notify:run-error':
    case 'notify:run-completed':
    case 'notify:awaiting-user': {
      useLiveDockStore.getState().finishRun() // 直播窗：3s 后回落胶囊（SSE / WS 双通道均生效）
      if (handledBySse) break // 当前可见的流已处理同一事件
      const title = sessionTitle(env.sessionId)
      const text =
        env.type === 'notify:awaiting-user'
          ? `${title}：成员已交还，等待你的指示`
          : env.type === 'notify:run-error'
            ? `${title}：运行出错 — ${String(env.payload.error ?? '未知错误')}`
            : `${title}：本轮协作完成`
      if (env.type === 'notify:run-error') toast.error(text)
      else toast(text)
      if (!visible) systemNotify('多 Agent 研发团队', text)
      const next = { ...useWsStore.getState().unread }
      next[env.sessionId] = (next[env.sessionId] ?? 0) + 1
      useWsStore.setState({ unread: next })
      syncBadge(next)
      break
    }
  }
}

function startPolling(): void {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return
    void apiGet<NotifyListResponse>('/api/notifications?since=0')
      .then((res) => {
        for (const env of res.notifications) handleNotify(env)
      })
      .catch(() => undefined)
  }, pollMs)
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
}

export const useWsStore = create<WsState>((set, get) => ({
  status: 'connecting',
  unread: {},

  init: () => {
    if (socket) return
    baseTitle = document.title || baseTitle
    // M4：轮询间隔由服务端下发（代码内硬编码已移除）
    void apiGet<{ notifyPollMs?: number }>('/api/health')
      .then((res) => {
        if (typeof res.notifyPollMs === 'number' && res.notifyPollMs >= 500) pollMs = res.notifyPollMs
      })
      .catch(() => undefined)
    socket = new NotifySocket({
      onStatus: (status) => {
        set({ status })
        if (status === 'open') stopPolling()
        else startPolling()
      },
      onNotify: handleNotify,
      getCursors: () => Object.fromEntries(cursors),
      getSubscriptions: () => [...subscribed],
    })
    // M26：固定订阅资产变更保留主题（控制台写盘后的多标签同步；降级轮询天然覆盖）
    subscribed.add(ASSETS_TOPIC)
    socket.subscribe([ASSETS_TOPIC])
    // M27：固定订阅 MCP 变更保留主题（服务器 / 状态 / 工具清单 / 绑定的多标签同步）
    subscribed.add(MCP_TOPIC)
    socket.subscribe([MCP_TOPIC])
    socket.connect()
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission().catch(() => undefined)
    }
    document.addEventListener('visibilitychange', () => {
      syncBadge(useWsStore.getState().unread)
    })
  },

  ensureSubscribed: (sessionId) => {
    // 顺带把历史会话都订阅上（未读角标覆盖全会话）
    const sessions = useSessionStore.getState().sessions.map((s) => s.id)
    const targets = [...new Set([...sessions, sessionId])].filter((id) => !subscribed.has(id))
    if (targets.length === 0) return
    for (const id of targets) subscribed.add(id)
    socket?.subscribe(targets)
  },

  reconnect: () => socket?.reconnect(),

  markRead: (sessionId) => {
    if ((get().unread[sessionId] ?? 0) === 0) return
    const next = { ...get().unread, [sessionId]: 0 }
    set({ unread: next })
    syncBadge(next)
  },
}))
