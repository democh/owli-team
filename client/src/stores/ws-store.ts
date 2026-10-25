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
  InboxItem,
  MediaJob,
  NotifyEnvelope,
  NotifyListResponse,
  OpEvent,
  Plan,
  ReactionSummary,
  ReviewRecord,
  ScheduledTask,
  Session,
  SessionPrefs,
} from '@multi-agent/shared'
import { ASSETS_TOPIC, MCP_TOPIC } from '@multi-agent/shared'
import { ApiError, apiGet, apiPost } from '../lib/api'
import { NotifySocket, type WsStatus } from '../lib/ws'
import { useInboxStore } from './inbox-store'
import { useAuthStore } from './auth-store'
import { useAgentStore } from './agent-store'
import { useBrowserStore } from './browser-store'
import { useCanvasStore } from './canvas-store'
import { useConnectionsStore } from './connections-store'
import { useConsoleStore } from './console-store'
import { useFriendsStore } from './friends-store'
import { useShareStore } from './share-store'
import { useLiveDockStore } from './live-dock-store'
import { useLivePanelStore } from './live-panel-store'
import { useMcpStore } from './mcp-store'
import { useMediaStore } from './media-store'
import { usePlanStore } from './plan-store'
import { useRunStore } from './run-store'
import { useOutboxStore } from './outbox-store'
import { useScheduleStore } from './schedule-store'
import { useSessionStore } from './session-store'
import { useSpaceStore } from './space-store'
import { useTaskStore } from './task-store'
import { useUiStore } from './ui-store'

interface WsState {
  status: WsStatus
  /** sessionId → 未读数 */
  unread: Record<string, number>
  /** M79-G：userId → 在线（缺省 = 未知；可见域 = 好友 ∪ 同会话成员——成员弹窗 / @ 候选点） */
  presenceMap: Record<string, boolean>
  /** IM：sessionId → 正在输入的成员（临时态；6s 无新帧自动消失） */
  typing: Record<string, Array<{ userId: string; name?: string }>>
  init: () => void
  /** M8：断线提示条的「重连」按钮 */
  reconnect: () => void
  ensureSubscribed: (sessionId: string) => void
  /** IM：上报正在输入（连接未开 / 非当前会话时静默） */
  sendTyping: (sessionId: string) => void
  markRead: (sessionId: string, visibleSeq: number) => void
}

let socket: NotifySocket | undefined
const subscribed = new Set<string>()
/** 每会话 seq 水位：去重 + 重连补发游标 */
const cursors = new Map<string, number>()
let pollTimer: ReturnType<typeof setInterval> | undefined
let flashTimer: ReturnType<typeof setInterval> | undefined
let flashing = false
let baseTitle = 'Owli Team'
/** 通知降级轮询间隔（M4：由 GET /api/health 下发 NOTIFY_POLL_MS，默认 8s） */
let pollMs = 8000
/** M79-AB：是否曾成功连接（区分首次建连与断线重连——重连需 REST 权威补偿） */
let everConnected = false
/** 审批未读对账：本端因审批挂起加过未读的 approval id 集（resolved 时精确回退） */
const approvalBadgePending = new Set<string>()

/** M79-W：跨会话消息到达触发的列表权威对账（防抖合并：预览 / 排序 / 服务端未读数） */
let sessionsResyncTimer: ReturnType<typeof setTimeout> | undefined
function scheduleSessionsResync(): void {
  if (sessionsResyncTimer) return
  sessionsResyncTimer = setTimeout(() => {
    sessionsResyncTimer = undefined
    void useSessionStore.getState().loadSessions()
  }, 800)
}

/** M79-W：把当前会话列表全部纳入订阅（列表变化 / 首载自动调用；推送与未读覆盖全会话） */
function ensureAllSubscribed(): void {
  const targets = useSessionStore
    .getState()
    .sessions.map((s) => s.id)
    .filter((id) => !subscribed.has(id))
  if (targets.length === 0) return
  for (const id of targets) subscribed.add(id)
  socket?.subscribe(targets)
}

function sessionTitle(sessionId: string): string {
  const s = useSessionStore.getState().sessions.find((x) => x.id === sessionId)
  return s?.title ?? '会话'
}

/** IM：记录正在输入（同一用户 6s 内无新帧自动消失）。 */
function noteTyping(sessionId: string, userId: string, name?: string): void {
  const key = `${sessionId}:${userId}`
  const timer = typingTimers.get(key)
  if (timer) clearTimeout(timer)
  typingTimers.set(
    key,
    setTimeout(() => {
      typingTimers.delete(key)
      useWsStore.setState((s) => ({
        typing: { ...s.typing, [sessionId]: (s.typing[sessionId] ?? []).filter((x) => x.userId !== userId) },
      }))
    }, 6000),
  )
  useWsStore.setState((s) => {
    const list = (s.typing[sessionId] ?? []).filter((x) => x.userId !== userId)
    return { typing: { ...s.typing, [sessionId]: [...list, { userId, ...(name ? { name } : {}) }] } }
  })
}

/** IM：用户已发消息 / 离开时立即清除其输入态。 */
function clearTyping(sessionId: string, userId: string): void {
  const key = `${sessionId}:${userId}`
  const timer = typingTimers.get(key)
  if (timer) clearTimeout(timer)
  typingTimers.delete(key)
  useWsStore.setState((s) => {
    const list = s.typing[sessionId] ?? []
    if (!list.some((x) => x.userId === userId)) return s
    return { typing: { ...s.typing, [sessionId]: list.filter((x) => x.userId !== userId) } }
  })
}

/** IM：免打扰仅抑制普通消息提示，不丢未读、不影响邀请 / 提及等收件箱事件。 */
function sessionMuted(sessionId: string): boolean {
  return !!useSessionStore.getState().sessions.find((x) => x.id === sessionId)?.prefs?.muted
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

// ---------- M79-A：服务端权威未读 / 已读上报（设计 §9.4） ----------

/** 每会话已上报的已读 seq（防重复上报；仅推进时发送） */
const reportedSeq = new Map<string, number>()
const pendingReads = new Map<string, number>()
const reading = new Set<string>()
let readTimer: ReturnType<typeof setTimeout> | undefined
/** IM：typing 过期定时器（`sessionId:userId`） */
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** 服务端快照 → 本地徽章（会话列表每次刷新后调用；缺 unreadCount 字段的条目不动：兼容模式零影响） */
function syncFromSessions(): void {
  const sessions = useSessionStore.getState().sessions
  const current = useWsStore.getState().unread
  let changed = false
  const next = { ...current }
  for (const s of sessions) {
    if (typeof s.unreadCount !== 'number') continue
    if ((next[s.id] ?? 0) !== s.unreadCount) {
      next[s.id] = s.unreadCount
      changed = true
    }
  }
  if (changed) {
    useWsStore.setState({ unread: next })
    syncBadge(next)
  }
}

/** 已读只接受视口提供的水位；REST 确认后才记成功，网络失败保留待重试。 */
function flushReads(): void {
  readTimer = undefined
  const userId = useAuthStore.getState().user?.id ?? ''
  for (const [key, seq] of pendingReads) {
    const [owner, sessionId] = JSON.parse(key) as [string, string]
    if (owner !== userId) { pendingReads.delete(key); continue }
    if (reading.has(key)) continue
    reading.add(key)
    void apiPost<{ lastReadSeq: number }>(`/api/sessions/${sessionId}/read`, { seq })
      .then((res) => {
        if ((useAuthStore.getState().user?.id ?? '') !== owner) return
        if (!Number.isSafeInteger(res.lastReadSeq)) throw new Error('已读确认无效')
        reportedSeq.set(key, Math.max(reportedSeq.get(key) ?? 0, res.lastReadSeq))
        if ((pendingReads.get(key) ?? 0) <= seq) pendingReads.delete(key)
        // 读到本地最新一条即可清除该会话徽章；未读总数仍以服务端对账为权威。
        const state = useSessionStore.getState()
        if (state.currentId === sessionId) {
          const latest = state.order.reduce((max, id) => Math.max(max, state.byId.get(id)?.seq ?? 0), 0)
          if (res.lastReadSeq >= latest) {
            const next = { ...useWsStore.getState().unread, [sessionId]: 0 }
            useWsStore.setState({ unread: next })
            syncBadge(next)
          }
        }
        scheduleSessionsResync()
      })
      .catch((err: unknown) => {
        // 会话已删除 / 无权访问等确定性失败丢弃；网络与 5xx 保留待重试。
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) pendingReads.delete(key)
      })
      .finally(() => {
        reading.delete(key)
        const pending = pendingReads.get(key) ?? 0
        if (pending > seq && !readTimer) readTimer = setTimeout(flushReads, 50)
        else if (pendingReads.size && !readTimer) readTimer = setTimeout(flushReads, 5000)
      })
  }
}

let notifyEpoch: string | undefined
let reconcileTimer: ReturnType<typeof setTimeout> | undefined
let reconciling = false
let reconcileAgain = false
let reconcileFailures = 0

/** 列表并非消息快照：恢复时必须补齐当前正文、编辑、删除以及成员已读。 */
function requestReconcile(delay = 100): void {
  reconcileAgain = true
  if (reconcileTimer || reconciling) return
  reconcileTimer = setTimeout(() => {
    reconcileTimer = undefined
    reconciling = true
    reconcileAgain = false
    void Promise.all([
      useInboxStore.getState().sync(),
      useSessionStore.getState().loadSessions(),
      useSessionStore.getState().refreshMessages(true),
    ]).then(() => { reconcileFailures = 0 }).catch(() => {
      // 流式期间快照会持续被新帧超越；有限次重试后交给下一次重连/缺口事件。
      reconcileFailures += 1
      reconcileAgain = reconcileFailures < 3
    }).finally(() => {
      reconciling = false
      if (reconcileAgain) requestReconcile(3000)
    })
  }, delay)
}

function acceptEpoch(epoch?: string): void {
  if (!epoch || epoch === notifyEpoch) return
  const changed = notifyEpoch !== undefined
  notifyEpoch = epoch
  if (changed) {
    cursors.clear()
    requestReconcile()
    socket?.subscribe([...subscribed])
  }
}

/** 收件箱条目 toast 文案（跨会话个人事件的即时提示；克制口径） */
function toastForInbox(item: InboxItem): string | undefined {
  const actor = item.actorName ?? '成员'
  switch (item.type) {
    case 'friend-request':
      return `${actor} 请求添加你为好友`
    case 'friend-accepted':
      return `${actor} 已同意你的好友申请`
    case 'session-invite':
      return `${actor} 邀请你加入「${item.title}」`
    case 'mention':
      return `${actor} 在「${item.title}」提到了你`
    case 'waiting':
      return `${actor} 在「${item.title}」等你回复`
    default:
      return item.title || undefined
  }
}

/**
 * P4：通知空间化分级——「生活空间」的 inbox 推送在晚间静默（仅入箱，不弹 toast / 系统通知）。
 * 晚间口径：20:00–07:00（本地）；空间未装配 / 会话未知一律不静默（行为与旧版一致）。
 */
export function inboxPushSilenced(item: InboxItem, now: Date = new Date()): boolean {
  if (!item.sessionId) return false
  const session = useSessionStore.getState().sessions.find((s) => s.id === item.sessionId)
  const spaceId = session?.spaceId ?? 'default'
  const space = useSpaceStore.getState().spaces.find((x) => x.id === spaceId)
  if (space?.kind !== 'life') return false
  const hour = now.getHours()
  return hour >= 20 || hour < 7
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
  // M79-A：用户主题帧（`u:` 前缀；收件箱 / 已读 / presence / 好友）不走会话游标去重（seq=0）；
  // 幂等由 inbox item.id / 状态覆盖语义保证
  // 临时帧（typing）不占 seq、不参与去重 / 缺口判断
  if (!env.sessionId.startsWith('u:') && !env.ephemeral) {
    acceptEpoch(env.epoch)
    const last = cursors.get(env.sessionId) ?? 0
    if (env.seq > last + 1) requestReconcile()
    if (env.seq <= last) return // 去重：WS 补发 / 轮询 / 重放交叉
    cursors.set(env.sessionId, env.seq)
  }

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
      // M87：同一 Run 的 SSE `artifact:updated` 已在消费端递增版本，这里去重（防双通道 O(2N) 刷新）
      if (handledBySse) break
      if (sameSession) sessions.bumpArtifacts()
      useUiStore.getState().noteArtifact(String(env.payload.path ?? ''))
      // M49：实况·交付件面软跟随（仅当前会话；面板未停在交付件面时不打扰）
      if (sameSession) useLivePanelStore.getState().noteArtifact(String(env.payload.path ?? ''))
      break
    }

    // M31：画布远端变更（agent canvas_write / 其他标签页保存）——本地空闲立即拉取合流，脏则保存后补拉
    // M31 修订：透传 touched/actor（写入高亮 + 作者徽标）；同会话且不在画布页时累计页签角标
    case 'notify:canvas-changed': {
      const by = String(env.payload.by) === 'agent' ? ('agent' as const) : ('user' as const)
      const rawTouched = env.payload.touched as { added?: unknown; updated?: unknown; removed?: unknown } | undefined
      const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
      const meta = {
        actor: typeof env.payload.actor === 'string' ? env.payload.actor : undefined,
        touched: rawTouched ? { added: arr(rawTouched.added), updated: arr(rawTouched.updated), removed: arr(rawTouched.removed) } : undefined,
      }
      useCanvasStore.getState().handleRemoteChange(env.sessionId, Number(env.payload.version ?? 0), by, meta)
      if (by === 'agent') {
        if (sameSession) {
          // 当前会话：不在画布页时累计页签角标
          if (useUiStore.getState().mainTab !== 'canvas') {
            const n = meta.touched ? meta.touched.added.length + meta.touched.updated.length + meta.touched.removed.length : 1
            useUiStore.getState().noteCanvasWrite(Math.max(1, n))
          }
        } else {
          // M31 修订：其他会话的 agent 写入 → 会话列表小点（切到该会话即清零）
          useUiStore.getState().noteOtherCanvasWrite(env.sessionId)
        }
      }
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
    // 审批是协作链路唯一「永久挂起等人」的状态：非当前会话或页面隐藏时计未读
    // （favicon 角标 + 隐藏标题闪烁由 syncBadge 驱动），resolved 后回退（仅回退本端加过的那笔）
    case 'notify:approval-requested':
    case 'notify:approval-resolved': {
      if (handledBySse) break // 当前可见的流已处理同一事件
      const approval = env.payload.approval as ApprovalRequest | undefined
      if (approval) {
        useRunStore.setState((s) => ({
          approvals: [...s.approvals.filter((a) => a.id !== approval.id), approval].slice(-20),
        }))
        if (env.type === 'notify:approval-requested') {
          toast(`模型请求审批：${approval.action}`)
          if (!visible) systemNotify('模型请求审批', `${sessionTitle(env.sessionId)}：${approval.action}`)
          if ((!sameSession || !visible) && !approvalBadgePending.has(approval.id)) {
            if (approvalBadgePending.size > 50) approvalBadgePending.clear() // 防泄漏兜底
            approvalBadgePending.add(approval.id)
            const next = { ...useWsStore.getState().unread }
            next[env.sessionId] = (next[env.sessionId] ?? 0) + 1
            useWsStore.setState({ unread: next })
            syncBadge(next)
          }
        } else if (approvalBadgePending.delete(approval.id)) {
          const prev = useWsStore.getState().unread
          const count = prev[env.sessionId] ?? 0
          if (count > 0) {
            const next = { ...prev, [env.sessionId]: count - 1 }
            useWsStore.setState({ unread: next })
            syncBadge(next)
          }
        }
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

    case 'notify:turn-end': {
      // M79-D / M79-U / M79-W：消息广播帧（人类消息补播 / agent 回合收尾 / 触发型消息广播）——
      //   群聊式全同步：同会话 upsert；跨会话一律计未读 + 列表行预览即时更新 + 列表权威对账
      //   （不再区分 human / agent；agent 消息不弹 toast，靠未读徽标与列表预览感知）
      const msg = env.payload.message as ChatMessage | undefined
      if (!msg?.id) break
      useOutboxStore.getState().acknowledge(msg)
      if (msg.userId) clearTyping(env.sessionId, msg.userId)
      if (sameSession) {
        sessions.upsertMessage(msg)
        // M79-X：同会话也同步列表行预览（气泡即时 + 列表预览即时的统一口径）
        useSessionStore.getState().noteIncoming(env.sessionId, msg)
        // 撤回会减少服务端未读，需对账（普通消息的未读由消息级计数处理）
        if (msg.recalledAt) scheduleSessionsResync()
        break
      }
      const myUserId = useAuthStore.getState().user?.id
      const ownHuman = msg.role === 'user' && !!msg.userId && msg.userId === myUserId
      // 自己的消息（同账号其他标签页补播）：更新预览但不计未读不提示
      useSessionStore.getState().noteIncoming(env.sessionId, msg)
      // 已撤回消息不产生未读与提示（仍更新预览为「消息已撤回」）；同时对齐权威未读。
      if (msg.recalledAt) scheduleSessionsResync()
      if (!ownHuman && !msg.recalledAt) {
        const next = { ...useWsStore.getState().unread }
        next[env.sessionId] = (next[env.sessionId] ?? 0) + 1
        useWsStore.setState({ unread: next })
        syncBadge(next)
        scheduleSessionsResync()
      }
      if (msg.role === 'user' && !ownHuman && !msg.recalledAt && !sessionMuted(env.sessionId)) {
        const preview = msg.content.replace(/\s+/g, ' ').slice(0, 40)
        toast(`${sessionTitle(env.sessionId)}：${preview}`)
        if (!visible) systemNotify('Owli Team', `${sessionTitle(env.sessionId)}：${preview}`)
      }
      break
    }

    case 'notify:reaction': {
      // M80-B：表情回应全量替换帧——mine 本地推导（广播帧 mine=false；userIds.includes(本人)）
      const messageId = env.payload.messageId as string | undefined
      const list = (env.payload.reactions as ReactionSummary[] | undefined) ?? []
      if (!messageId) break
      const myId = useAuthStore.getState().user?.id
      const projected = list.map((r) => ({ ...r, mine: !!myId && r.userIds.includes(myId) }))
      if (sameSession) useSessionStore.getState().patchMessage(messageId, { reactions: projected })
      break
    }

    case 'notify:read-receipt': {
      // M80-C 对等双向：本人关闭开关 → 不消费他人已读帧（与服务端空投影双保险）
      if (!useAuthStore.getState().readReceiptsOn) break
      // M80-C：成员已读水位推进（会话主题帧；单调推进，仅当前会话落地）
      const uid = env.payload.userId as string | undefined
      const seq = env.payload.lastReadSeq as number | undefined
      if (!uid || typeof seq !== 'number') break
      useSessionStore.getState().applyReadReceipt(env.sessionId, uid, seq)
      break
    }

    // M79-Z：旁观端流式（节流聚合帧）——非本端活跃 Run 时驱动同会话 streaming 气泡；
    //   首帧自动创建占位（成员身份随帧），后续帧累积；收尾 turn-end 完整消息权威覆盖
    case 'notify:message-delta': {
      if (!sameSession) break // 未打开会话不渲染流式（收尾 turn-end 已计未读）
      if (env.runId && env.runId === run.runId) break // 触发者已有 SSE 流（去重）
      const messageId = String(env.payload.messageId ?? '')
      const delta = String(env.payload.delta ?? '')
      if (!messageId || !delta) break
      if (!sessions.byId.get(messageId)) {
        sessions.upsertMessage({
          id: messageId,
          sessionId: env.sessionId,
          seq: 0,
          role: 'agent',
          ...(env.payload.agentId ? { agentId: String(env.payload.agentId) } : {}),
          ...(env.payload.memberKey ? { memberKey: String(env.payload.memberKey) } : {}),
          content: '',
          mentions: [],
          status: 'streaming',
          createdAt: new Date().toISOString(),
        })
      }
      sessions.appendDelta(messageId, delta)
      break
    }

    // M79-Y：指挥台队列重排（触发者之外的其他端 / 成员实时对齐；非活跃 Run 忽略）
    case 'notify:queue-updated': {
      const queue = env.payload.queue as string[] | undefined
      if (!queue || !env.runId || env.runId !== run.runId) break
      useRunStore.setState({ queue })
      break
    }

    // M79-Y：上下文压缩（本端活跃 Run 的压缩计数多端对齐；触发者重附着后不漂移）
    case 'notify:context-compressed': {
      if (!env.runId || env.runId !== run.runId) break
      useRunStore.setState((s) => ({ compressionCount: s.compressionCount + 1 }))
      break
    }

    // M79-X：消息删除（作者 / 属主操作后广播）——同会话即时移除；跨会见列表对账
    case 'notify:message-deleted': {
      const messageId = String(env.payload.messageId ?? '')
      if (!messageId) break
      // 用户主题帧（scope=self）携带真实 sessionId；会话主题帧沿用 env.sessionId
      const target = String(env.payload.sessionId ?? env.sessionId)
      if (useSessionStore.getState().currentId === target) sessions.removeMessage(messageId)
      scheduleSessionsResync()
      break
    }

    // M79-X：会话删除（owner 操作后广播）——列表即时移除；当前会话回到空态并提示
    // M79-AA 群管理补全：payload.kind 区分「群聊已被解散」；toast id 与操作者本地提示合并去重
    case 'notify:session-deleted': {
      useSessionStore.setState((s) => ({ sessions: s.sessions.filter((x) => x.id !== env.sessionId) }))
      if (useSessionStore.getState().currentId === env.sessionId) {
        void useSessionStore.getState().selectSession(undefined)
        toast(env.payload.kind === 'group' ? '群聊已被解散' : '本会话已被删除', {
          id: `session-deleted-${env.sessionId}`,
        })
      }
      break
    }

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

    // M57 P2：会话共享变更（邀请 / 改角色 / 移出 / 自助退出）——刷新会话列表；
    // 当前会话已不可见（被移出 / 已退出）→ 清空当前视图并提示；面板正打开则同步刷新
    case 'notify:share-changed': {
      const payload = env.payload as { userId?: string; action?: string }
      useShareStore.getState().refreshIfOpen(env.sessionId)
      void useSessionStore.getState().loadSessions().then(() => {
        const after = useSessionStore.getState()
        if (after.currentId && !after.sessions.some((x) => x.id === after.currentId)) {
          void after.selectSession(undefined)
          toast.info(payload.action === 'left' ? '你已退出该共享会话' : '你已被移出该共享会话')
        }
      })
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
        if (!visible) systemNotify('Owli Team', text)
        const next = { ...useWsStore.getState().unread }
        next[env.sessionId] = (next[env.sessionId] ?? 0) + 1
        useWsStore.setState({ unread: next })
        syncBadge(next)
      }
      break
    }

    // M79-AF：交还提示只对持球方（targets）∪ 会话属主可见——非持球成员不再被「等待你的指示」打扰；
    // 无 targets（泛指 @用户 / 兼容模式）保持原广播语义零变化
    case 'notify:awaiting-user': {
      useLiveDockStore.getState().finishRun() // 直播窗：3s 后回落胶囊（SSE / WS 双通道均生效）
      if (handledBySse) break // 当前可见的流已处理同一事件
      const rawTargets = Array.isArray(env.payload.targets) ? (env.payload.targets as unknown[]) : []
      const targets = rawTargets.filter((x): x is string => typeof x === 'string')
      if (targets.length > 0) {
        const myUserId = useAuthStore.getState().user?.id
        const session = useSessionStore.getState().sessions.find((x) => x.id === env.sessionId)
        const mine = !!myUserId && targets.includes(myUserId)
        const isOwner = !!myUserId && session?.ownerId === myUserId
        if (!mine && !isOwner) break
      }
      const awaitingText = `${sessionTitle(env.sessionId)}：成员已交还，等待你的指示`
      toast(awaitingText)
      if (!visible) systemNotify('Owli Team', awaitingText)
      scheduleSessionsResync()
      break
    }

    case 'notify:run-error':
    case 'notify:run-completed': {
      useLiveDockStore.getState().finishRun() // 直播窗：3s 后回落胶囊（SSE / WS 双通道均生效）
      if (handledBySse) break // 当前可见的流已处理同一事件
      const title = sessionTitle(env.sessionId)
      const text =
        env.type === 'notify:run-error'
          ? `${title}：运行出错 — ${String(env.payload.error ?? '未知错误')}`
          : `${title}：本轮协作完成`
      if (env.type === 'notify:run-error') toast.error(text)
      else toast(text)
      if (!visible) systemNotify('Owli Team', text)
      // M79-W：未读由消息级（turn-end 单条 +1）计数——此处仅做权威对账兜底（服务端 unreadCount）
      scheduleSessionsResync()
      break
    }

    // M79-A：收件箱实时投递（用户主题）——入箱（幂等 + 缺口补齐）+ 会话订阅 + 即时提示
    case 'notify:inbox': {
      const item = env.payload.item as InboxItem | undefined
      if (!item?.id) break
      useInboxStore.getState().ingest(item)
      if (item.sessionId) {
        useWsStore.getState().ensureSubscribed(item.sessionId)
        // M79-D：被拉入新会话（邀请 / 私聊 / 群聊）→ 会话列表即时刷新
        void useSessionStore.getState().loadSessions()
      }
      const text = toastForInbox(item)
      // P4：生活空间晚间静默（仍入箱并刷新列表；不弹 toast / 系统通知）。
      // IM：会话免打扰只静默普通消息；@提及 / 邀请 / 待回复仍提醒（可行动事件不吞）。
      if (text && !inboxPushSilenced(item)) {
        toast(text)
        if (!visible) systemNotify('Owli Team', text)
      }
      break
    }

    // IM：正在输入（临时帧；同一用户 6s 无新帧自动清除；本人多端不回显）
    case 'notify:typing': {
      const userId = String(env.payload.userId ?? '')
      const myId = useAuthStore.getState().user?.id
      if (!userId || userId === myId) break
      const name = typeof env.payload.name === 'string' ? env.payload.name : undefined
      noteTyping(env.sessionId, userId, name)
      break
    }

    // IM：会话个人偏好（置顶 / 免打扰）多端同步（用户主题帧）
    case 'notify:session-prefs': {
      const sessionId = String(env.payload.sessionId ?? '')
      const prefs = env.payload.prefs as SessionPrefs | undefined
      if (!sessionId || !prefs) break
      useSessionStore.setState((s) => ({
        sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, prefs } : x)),
      }))
      // 标记未读：至少展示 1 条未读（读到最新后由服务端解除并回帧）
      if (prefs.markedUnread) {
        const next = { ...useWsStore.getState().unread }
        next[sessionId] = Math.max(1, next[sessionId] ?? 0)
        useWsStore.setState({ unread: next })
        syncBadge(next)
      }
      break
    }

    // M79-A：本用户其他端已读推进——拉服务端权威值刷新徽章（读事件低频；整表刷新可接受）
    case 'notify:read-state': {
      const sessionId = String(env.payload.sessionId ?? '')
      if (!sessionId) break
      void useSessionStore
        .getState()
        .loadSessions()
        .then(() => syncFromSessions())
      break
    }

    // M79-C：好友关系变化（用户主题）——联系人面板 / 好友列表刷新
    case 'notify:friends-changed': {
      void useFriendsStore.getState().load()
      break
    }

    // M79-K：会话元信息变更（waiting_on 清除/写入 · routeMode · 编制 · 标题）→ 就地归并（服务端权威；单会话粒度）
    // 该帧此前服务端已广播但客户端无消费分支——持球徽章在「他人回复清除」路径不消失的根因
    case 'notify:session-meta': {
      const session = env.payload.session as Session | undefined
      if (session && typeof session.id === 'string') {
        useSessionStore.getState().applySession(session)
      }
      break
    }

    // M79-C/G：在线状态聚合（用户主题；可见域 = 好友 ∪ 同会话成员——好友面走 friends-store，通用面走 presenceMap）
    case 'notify:presence': {
      const raw = Array.isArray(env.payload.users) ? (env.payload.users as unknown[]) : []
      const events = raw
        .map((u) => u as { userId?: unknown; online?: unknown; lastSeenAt?: unknown })
        .filter((u): u is { userId: string; online?: unknown; lastSeenAt?: unknown } => typeof u.userId === 'string')
        .map((u) => ({
          userId: u.userId,
          online: !!u.online,
          ...(typeof u.lastSeenAt === 'string' ? { lastSeenAt: u.lastSeenAt } : {}),
        }))
      if (events.length > 0) {
        useWsStore.setState((s) => {
          const presenceMap = { ...s.presenceMap }
          for (const ev of events) presenceMap[ev.userId] = ev.online
          return { presenceMap }
        })
      }
      useFriendsStore.getState().applyPresence(events)
      break
    }
  }
}

/**
 * M79-AF：降级轮询 URL —— 携带 per-session 游标只拉各会话增量（各会话 seq 独立计数器，
 * 单值 since 无法跨会话表达）；游标序列化超长（会话过多，URL 上限护栏）回退全量。
 */
export function pollUrlOf(cursors: ReadonlyMap<string, number>): string {
  if (cursors.size === 0) return '/api/notifications?since=0'
  const json = JSON.stringify(Object.fromEntries(cursors))
  if (json.length > 1500) return '/api/notifications?since=0'
  return `/api/notifications?since=0&cursors=${encodeURIComponent(json)}`
}

function startPolling(): void {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return
    void apiGet<NotifyListResponse>(pollUrlOf(cursors))
      .then((res) => {
        acceptEpoch(res.epoch)
        if (res.truncated) requestReconcile()
        for (const env of res.notifications) handleNotify(env)
      })
      .catch(() => undefined)
    // M79-AB：降级轮询同步补「用户主题」权威源——收件箱（邀请/提及）与会话列表在 WS 不可用期间不漏
    void useInboxStore.getState().sync()
    void useSessionStore.getState().loadSessions()
  }, pollMs)
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
}

export const useWsStore = create<WsState>((set) => ({
  status: 'connecting',
  unread: {},
  presenceMap: {},
  typing: {},

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
        if (status !== 'open') {
          startPolling()
          return
        }
        stopPolling()
        if (everConnected) {
          // M79-AB：断线窗口的**用户主题帧**（收件箱：邀请 / 提及 / 等待提醒——无游标可补）在
          // 服务重启 / 网络抖动期间会丢失——重连成功后 REST 权威补偿（收件箱快照 + 会话列表）。
          requestReconcile()
          if (pendingReads.size && !readTimer) readTimer = setTimeout(flushReads, 100)
        }
        everConnected = true
      },
      onNotify: handleNotify,
      onEpoch: acceptEpoch,
      getCursors: () => Object.fromEntries(cursors),
      getSubscriptions: () => [...subscribed],
      // M79-A：服务端要求补齐（背压断开前通知）→ REST 快照双保险（重连补发仍会覆盖）
      onResync: () => requestReconcile(),
      // M79-A：连接级策略事件（同账号连接数超限被顶替 / 会话权限变更）
      onPolicyError: (code, message) => {
        if (code === 'conn_evicted') {
          toast.info(message || '同一账号的连接数超限：本页连接已由新连接替代')
        } else if (code === 'acl-changed') {
          void useSessionStore
            .getState()
            .loadSessions()
            .then(() => {
              const after = useSessionStore.getState()
              if (after.currentId && !after.sessions.some((x) => x.id === after.currentId)) {
                void after.selectSession(undefined)
              }
            })
          if (message) toast.info(message)
        }
      },
    })
    // M79-A：收件箱初始化（REST 快照；后续增量由 WS notify:inbox 驱动）
    void useInboxStore.getState().sync()
    // M79-A：服务端权威未读同步（会话列表每次刷新后对账）+ 可见时自动已读上报
    useSessionStore.subscribe((state, prev) => {
      if (state.sessions !== prev.sessions) {
        syncFromSessions()
        // M79-W：列表变化（新共享 / 新会话）自动纳入订阅——不再依赖用户点击
        ensureAllSubscribed()
      }
      // 已读由 ChatArea 的真实视口驱动，加载、预取和后台收消息不代表阅读。
    })
    // M26：固定订阅资产变更保留主题（控制台写盘后的多标签同步；降级轮询天然覆盖）
    subscribed.add(ASSETS_TOPIC)
    socket.subscribe([ASSETS_TOPIC])
    // M27：固定订阅 MCP 变更保留主题（服务器 / 状态 / 工具清单 / 绑定的多标签同步）
    subscribed.add(MCP_TOPIC)
    socket.subscribe([MCP_TOPIC])
    // M79-W：首载即订阅现有列表（登录/刷新后无需点击任一会话）
    ensureAllSubscribed()
    socket.connect()
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission().catch(() => undefined)
    }
    document.addEventListener('visibilitychange', () => {
      syncBadge(useWsStore.getState().unread)
      if (document.visibilityState === 'visible') {
        requestReconcile()
        if (pendingReads.size && !readTimer) readTimer = setTimeout(flushReads, 100)
      }
    })
  },

  ensureSubscribed: (sessionId) => {
    // M79-W：列表全量订阅（未读角标 / 推送覆盖全会话）+ 指定会话（打开时兜底）
    ensureAllSubscribed()
    if (!subscribed.has(sessionId)) {
      subscribed.add(sessionId)
      socket?.subscribe([sessionId])
    }
  },

  reconnect: () => socket?.reconnect(),

  sendTyping: (sessionId) => {
    if (!socket || useWsStore.getState().status !== 'open') return
    socket.typing(sessionId)
  },

  markRead: (sessionId, visibleSeq) => {
    if (document.visibilityState !== 'visible' || useSessionStore.getState().currentId !== sessionId) return
    if (!Number.isSafeInteger(visibleSeq) || visibleSeq <= 0) return
    const key = JSON.stringify([useAuthStore.getState().user?.id ?? '', sessionId])
    if ((reportedSeq.get(key) ?? 0) >= visibleSeq) return
    pendingReads.set(key, Math.max(pendingReads.get(key) ?? 0, visibleSeq))
    if (!readTimer) readTimer = setTimeout(flushReads, 300)
  },
}))
