/**
 * 会话与消息：列表 CRUD + 当前会话消息（服务端为真相；运行中由 run-store 打增量补丁）。
 *
 * M8 性能架构：
 * - 消息存 `byId: Map<id, ChatMessage>` + `order: string[]`（O(1) 按 id 更新、渲染层项级订阅）；
 * - 单条消息变更只替换该条对象引用 → `useSessionStore(s => s.byId.get(id))` 的组件才重渲染；
 * - 所有消息写操作都带「当前会话」守卫，跨会话的流式事件不会污染其他会话的视图；
 * - 非响应式读取（测试 / 存储层）统一走 `messagesOf(state)` 派生函数。
 *
 * 增量派生表（写入时维护，渲染层 O(1) 直读——流式 delta 不再触发 O(n) 重算）：
 * - `structureKey`：消息流结构指纹（role~runId~turnIndex 序列），仅结构变化时替换；
 * - `streamingCount`：流式中消息计数（appendDelta 不动它，upsert/patch 状态跃迁时 ±1）；
 * - `sessionStats`：成员键 → {发言数, 交付数}（分页首载优先取服务端全量 memberStats，
 *   此后插入计数 / artifacts 差分增量维护）；
 * - `completedTick`：非流式消息写时钟（接力 / 战绩面板的「冻结口径」刷新信号）；
 * - `current`：当前会话摘要的引用稳定投影——仅非易变字段（lastMessage / unreadCount 之外）
 *   变化时才替换引用，跨会话预览刷屏不再重渲染所有 `current` 订阅方（useCurrentSession）。
 *
 * 消息分页（2026-09-22）：首载最近一页（MESSAGE_PAGE_SIZE），loadEarlier 按 seq 游标前翻前插；
 * 服务端不带 limit 时回退全量（兼容模式，hasMore 缺省 false）。
 */
import { create } from 'zustand'
import { sanitizeModelText } from '@multi-agent/shared'
import type { UserAvatar, ChatMessage, MemberReadState, RunSnapshot, Session, SessionSummary } from '@multi-agent/shared'
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api'

export interface SessionDetailResponse {
  session: Session
  messages: ChatMessage[]
  /** M3：最近一次运行快照（interrupted 时前端展示「从断点继续」） */
  latestRun?: RunSnapshot | null
  /** M57 P2：共享会话人类署名表（userId → 昵称；兼容模式为空） */
  humanNames?: Record<string, string>
  /** M79-B：人类画像投影（头像 / 头衔；随行返回；缺省 = 无） */
  humanProfiles?: Record<string, HumanProfile>
  /** M80-C：成员已读水位投影（仅开启对外展示的活跃成员；缺省 = 无已读展示） */
  memberReads?: MemberReadState[]
  /** 分页响应（带 limit 时）：是否还有更早消息 */
  hasMore?: boolean
  /** 分页响应：消息总条数（标题栏计数用） */
  totalCount?: number
  /** 分页响应：全量口径成员战绩（前端仅加载最近一页，统计须覆盖全部历史） */
  memberStats?: Record<string, { speaks: number; artifacts: number }>
}

/** 消息分页大小（会话首载 / 上滑加载更早共用） */
const MESSAGE_PAGE_SIZE = 100

/** M79-B：人类成员画像（会话详情随行投影；与 humanNames 并存，前端优先取本表渲染） */
export interface HumanProfile {
  name: string
  /** M79-E：用户名（@ 寻址回退 token；缺省 = 老服务端投影） */
  username?: string
  headline?: string
  avatar?: UserAvatar
}

export interface SessionState {
  sessions: SessionSummary[]
  currentId?: string
  /** M8：消息 Map（O(1) 更新与项级订阅） */
  byId: Map<string, ChatMessage>
  /** M8：消息 id 顺序（仅结构变化时替换引用） */
  order: string[]
  /** M3：当前会话最近一次运行快照 */
  latestRun: RunSnapshot | null
  /** M57 P2：当前会话人类署名表（userId → 昵称；共享会话消息气泡用；兼容模式为空对象） */
  humanNames: Record<string, string>
  /** M79-B：当前会话人类画像表（userId → 画像；头像 / 头衔渲染优先取本表） */
  humanProfiles: Record<string, HumanProfile>
  loadingSessions: boolean
  loadingMessages: boolean
  /** 交付件刷新版本号：artifact:updated 递增，交付件浏览器据此重拉列表 */
  artifactVersion: number
  /** 消息分页：还有更早历史未加载（首载只取最近一页） */
  hasMore: boolean
  /** 消息分页：服务端总条数（缺省 = 已加载条数，兼容全量响应） */
  totalCount: number
  /** 消息分页：更早一页加载中（顶部 spinner / 防重入） */
  loadingEarlier: boolean
  /** 当前会话摘要（引用稳定：仅非易变字段变化才替换；useCurrentSession 直读） */
  current?: SessionSummary
  /** 消息流结构指纹（role~runId~turnIndex 序列 join；仅结构变化时替换） */
  structureKey: string
  /** 流式中消息计数（写入时增量维护，替代渲染层全量扫描） */
  streamingCount: number
  /** 非流式消息写时钟（接力 / 战绩面板冻结口径的刷新信号） */
  completedTick: number
  /** 成员键 → 本会话战绩（发言数 / 交付数；服务端全量口径为底 + 增量差分） */
  sessionStats: Map<string, { speaks: number; artifacts: number }>
  loadSessions: () => Promise<void>
  createSession: (participantIds: string[], title?: string, souls?: Record<string, string>, spaceId?: string) => Promise<Session>
  /** M16：动态邀请成员（运行中允许；可选邀请时即选灵魂） */
  addMembers: (sessionId: string, agentIds: string[], souls?: Record<string, string>) => Promise<Session>
  /** M16：移出成员（正在发言时服务端拒绝，错误直通 toast） */
  removeMember: (sessionId: string, agentId: string) => Promise<Session>
  /** M16：切换成员灵魂（null = 恢复角色默认） */
  setMemberSoul: (sessionId: string, agentId: string, soul: string | null) => Promise<Session>
  /** M16：应用服务端会话补丁（members API / notify:members-changed 共用） */
  applySession: (session: Session) => void
  selectSession: (id?: string) => Promise<void>
  /** 消息分页：加载更早一页并前插（滚动锚定由 ChatArea 负责） */
  loadEarlier: () => Promise<void>
  refreshMessages: () => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  removeSession: (id: string) => Promise<void>
  /** M79-D：隐藏会话（仅本人列表；DM「删除」语义——新消息自动复现） */
  hideSession: (id: string) => Promise<void>
  /** M79-W：跨会话消息到达——即时更新列表行预览（排序 / 权威未读由 loadSessions 对账） */
  noteIncoming: (sessionId: string, message: ChatMessage) => void
  upsertMessage: (message: ChatMessage) => void
  patchMessage: (id: string, patch: Partial<ChatMessage>) => void
  /** M80-C：会话成员已读水位表（当前会话；含本人） */
  memberReads: MemberReadState[]
  /** M80-C：已读回执帧落地（单调推进 max；同会话才生效） */
  applyReadReceipt: (sessionId: string, userId: string, lastReadSeq: number) => void
  appendDelta: (id: string, delta: string) => void
  /** 思考模式（V4）：追加思维链增量 */
  appendReasoning: (id: string, delta: string) => void
  /** M8：删除单条消息（本地移除；服务端由调用方先行删除） */
  removeMessage: (id: string) => void
  bumpArtifacts: () => void
  /** M3：同步最近一次运行快照（继续/恢复后置空） */
  setLatestRun: (run: RunSnapshot | null) => void
}

/** 非响应式派生：order + byId → 消息数组（测试 / 一次性读取用） */
export function messagesOf(state: Pick<SessionState, 'byId' | 'order'>): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const id of state.order) {
    const message = state.byId.get(id)
    if (message) out.push(message)
  }
  return out
}

/**
 * M55（§77 / ADR 0125）：agent 正文展示净化。
 * 服务端已在回合收尾净化新消息；此处兜底「流式过程」与「存量消息（历史回看）」。
 * 净化规则需在全文上求值（仿写块以 [工具调用] 标题行锚定），若对已净化文本增量拼接，
 * 块内后续日志行会失去锚点成为孤行 → 为流式消息保留原始累积缓冲（appendDelta 对
 * 「原始全文」求净化写回 content；upsertMessage 视为权威全文重置缓冲）。
 */
const rawStreams = new Map<string, string>()

/** 净化 agent 正文（未变化时保持原对象引用，避免无谓重渲染） */
function withCleanContent(message: ChatMessage): ChatMessage {
  if (message.role !== 'agent' || !message.content) return message
  const cleaned = sanitizeModelText(message.content)
  return cleaned === message.content ? message : { ...message, content: cleaned }
}

function toStores(
  messages: ChatMessage[],
): Pick<SessionState, 'byId' | 'order' | 'structureKey' | 'streamingCount' | 'sessionStats'> & { completedTick: number } {
  const byId = new Map<string, ChatMessage>()
  const order: string[] = []
  const tokens: string[] = []
  const sessionStats = new Map<string, { speaks: number; artifacts: number }>()
  let streamingCount = 0
  for (const m of messages) {
    const clean = withCleanContent(m)
    byId.set(clean.id, clean)
    order.push(clean.id)
    tokens.push(structTokenOf(clean))
    if (clean.status === 'streaming') streamingCount++
    if (clean.role === 'agent' && clean.agentId) {
      const key = clean.memberKey ?? clean.agentId
      const cur = sessionStats.get(key) ?? { speaks: 0, artifacts: 0 }
      cur.speaks += 1
      cur.artifacts += clean.artifacts?.length ?? 0
      sessionStats.set(key, cur)
    }
  }
  structTokens = tokens
  return { byId, order, structureKey: tokens.join('|'), streamingCount, sessionStats, completedTick: 0 }
}

/** 消息结构指纹单元（与 ChatArea 历史口径一致：role~runId~turnIndex） */
function structTokenOf(m: ChatMessage): string {
  return `${m.role}~${m.runId ?? ''}~${m.turnIndex ?? -1}`
}

/** 与 order 平行的结构 token 序列（增量维护；removeMessage / 整体重载时重建） */
let structTokens: string[] = []

/** 成员战绩增量调整（无变化保持 Map 引用，订阅方不重渲染） */
function statBump(
  stats: Map<string, { speaks: number; artifacts: number }>,
  key: string,
  dSpeaks: number,
  dArtifacts: number,
): Map<string, { speaks: number; artifacts: number }> {
  if (dSpeaks === 0 && dArtifacts === 0) return stats
  const next = new Map(stats)
  const cur = next.get(key) ?? { speaks: 0, artifacts: 0 }
  next.set(key, { speaks: cur.speaks + dSpeaks, artifacts: cur.artifacts + dArtifacts })
  return next
}

/** 会话摘要的易变字段（预览 / 未读角标）：current 投影对这些字段变化保持引用稳定 */
const VOLATILE_SESSION_KEYS = new Set(['lastMessage', 'unreadCount'])

function sameSessionCore(a: SessionSummary, b: SessionSummary): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    if (VOLATILE_SESSION_KEYS.has(k)) continue
    if (!Object.is((a as unknown as Record<string, unknown>)[k], (b as unknown as Record<string, unknown>)[k])) return false
  }
  return true
}

/** 当前会话投影：找到目标会话；与上一投影核心字段一致时复用旧引用（订阅方零重渲染） */
function pickCurrent(
  sessions: SessionSummary[],
  currentId: string | undefined,
  prev: SessionSummary | undefined,
): SessionSummary | undefined {
  if (!currentId) return undefined
  const found = sessions.find((x) => x.id === currentId)
  if (!found) return undefined
  if (prev && prev.id === found.id && sameSessionCore(prev, found)) return prev
  return found
}

/** 当前会话（引用稳定投影）——替代散落的 `s.sessions.find(x => x.id === s.currentId)` 订阅 */
export function useCurrentSession(): SessionSummary | undefined {
  return useSessionStore((s) => s.current)
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  byId: new Map(),
  order: [],
  latestRun: null,
  humanNames: {},
  humanProfiles: {},
  memberReads: [],
  loadingSessions: false,
  loadingMessages: false,
  artifactVersion: 0,
  hasMore: false,
  totalCount: 0,
  loadingEarlier: false,
  current: undefined,
  structureKey: '',
  streamingCount: 0,
  completedTick: 0,
  sessionStats: new Map(),

  loadSessions: async () => {
    set({ loadingSessions: true })
    try {
      const res = await apiGet<{ sessions: SessionSummary[] }>('/api/sessions')
      set((s) => ({ sessions: res.sessions, current: pickCurrent(res.sessions, s.currentId, s.current) }))
    } finally {
      set({ loadingSessions: false })
    }
  },

  createSession: async (participantIds, title, souls, spaceId) => {
    const res = await apiPost<{ session: Session }>('/api/sessions', {
      participantIds,
      title,
      // M16：创建时可选指定灵魂覆盖（校验归属在服务端）
      ...(souls && Object.keys(souls).length > 0 ? { souls } : {}),
      // 空间归属（缺省 = 我的空间）
      ...(spaceId ? { spaceId } : {}),
    })
    await get().loadSessions()
    return res.session
  },

  /**
   * M16：应用服务端会话补丁（members API / notify:members-changed 共用）。
   * M46-2：缺省语义字段显式覆盖——服务端以「键缺失」表示关闭 / 无覆盖（serial / planFirst /
   * memberSouls），浅合并会残留旧值（真实缺陷：串行芯片关闭后仍显示「已开」；保留 summary 字段不整替）。
   */
  applySession: (session: Session) =>
    set((s) => {
      const sessions = s.sessions.map((x) =>
        x.id === session.id
          ? {
              ...x,
              ...session,
              // M79-K：「键缺失 = 空 / 关闭」字段显式归一——waiting_on 清空 / route_mode=auto /
              // 无编制等场景服务端序列化会省略键，浅合并将保留旧值（持球徽章不消失 / 策略开关不复位）
              waitingOn: session.waitingOn ?? [],
              routeMode: session.routeMode,
              planFirst: session.planFirst,
              serial: session.serial,
              memberSouls: session.memberSouls,
            }
          : x,
      )
      return { sessions, current: pickCurrent(sessions, s.currentId, s.current) }
    }),

  addMembers: async (sessionId, agentIds, souls) => {
    const res = await apiPost<{ session: Session; message: ChatMessage }>(`/api/sessions/${sessionId}/members`, {
      agentIds,
      ...(souls && Object.keys(souls).length > 0 ? { souls } : {}),
    })
    get().applySession(res.session)
    get().upsertMessage(res.message)
    return res.session
  },

  removeMember: async (sessionId, agentId) => {
    const res = await apiDelete<{ session: Session; message: ChatMessage }>(
      `/api/sessions/${sessionId}/members/${agentId}`,
    )
    get().applySession(res.session)
    get().upsertMessage(res.message)
    return res.session
  },

  setMemberSoul: async (sessionId, agentId, soul) => {
    const res = await apiPatch<{ session: Session; message: ChatMessage }>(
      `/api/sessions/${sessionId}/members/${agentId}`,
      { soul },
    )
    get().applySession(res.session)
    get().upsertMessage(res.message)
    return res.session
  },

  selectSession: async (id) => {
    // M55：切换会话后旧缓冲失去意义（消息将整体重拉），随视图一并清空
    rawStreams.clear()
    structTokens = []
    set((s) => ({
      currentId: id,
      current: pickCurrent(s.sessions, id, undefined),
      byId: new Map(),
      order: [],
      latestRun: null,
      humanNames: {},
      humanProfiles: {},
      memberReads: [],
      hasMore: false,
      totalCount: 0,
      loadingEarlier: false,
      structureKey: '',
      streamingCount: 0,
      completedTick: 0,
      sessionStats: new Map(),
    }))
    if (!id) return
    set({ loadingMessages: true })
    try {
      // 消息分页：首载只取最近一页（服务端无分页能力时回退全量，hasMore 缺省 false）
      const res = await apiGet<SessionDetailResponse>(`/api/sessions/${id}?limit=${MESSAGE_PAGE_SIZE}`)
      if (get().currentId !== id) return // 切换竞态守卫
      const stores = toStores(res.messages)
      set({
        ...stores,
        // 分页首载：战绩以服务端全量口径为底（页内派生只覆盖最近一页，会缺历史）
        sessionStats: res.memberStats ? new Map(Object.entries(res.memberStats)) : stores.sessionStats,
        latestRun: res.latestRun ?? null,
        humanNames: res.humanNames ?? {},
        humanProfiles: res.humanProfiles ?? {},
        memberReads: res.memberReads ?? [],
        hasMore: res.hasMore ?? false,
        totalCount: res.totalCount ?? res.messages.length,
      })
    } finally {
      if (get().currentId === id) set({ loadingMessages: false })
    }
  },

  loadEarlier: async () => {
    const s = get()
    const id = s.currentId
    if (!id || !s.hasMore || s.loadingEarlier) return
    const oldest = s.order.length > 0 ? s.byId.get(s.order[0]!) : undefined
    const before = oldest?.seq
    if (before === undefined) return
    set({ loadingEarlier: true })
    try {
      const res = await apiGet<SessionDetailResponse>(
        `/api/sessions/${id}?limit=${MESSAGE_PAGE_SIZE}&before=${before}`,
      )
      if (get().currentId !== id) return // 切换竞态守卫
      const priorTokens = structTokens // toStores 会把 structTokens 重置为页内序列——先留档现有序列
      const page = toStores(res.messages)
      const pageTokens = structTokens
      set((cur) => {
        structTokens = [...pageTokens, ...priorTokens]
        return {
          byId: new Map([...page.byId, ...cur.byId]),
          order: [...page.order, ...cur.order],
          structureKey: structTokens.join('|'),
          streamingCount: cur.streamingCount + page.streamingCount,
          hasMore: res.hasMore ?? false,
          totalCount: res.totalCount ?? cur.totalCount,
          loadingEarlier: false,
          completedTick: cur.completedTick + 1,
        }
      })
    } catch (err) {
      set({ loadingEarlier: false })
      throw err
    }
  },

  refreshMessages: async () => {
    const id = get().currentId
    if (!id) return
    // 全量重拉（不带分页参数）：补偿场景需要权威全量；加载后 hasMore 归零
    const res = await apiGet<SessionDetailResponse>(`/api/sessions/${id}`)
    if (get().currentId !== id) return
    set({
      ...toStores(res.messages),
      latestRun: res.latestRun ?? null,
      humanNames: res.humanNames ?? {},
      humanProfiles: res.humanProfiles ?? {},
      hasMore: false,
      totalCount: res.messages.length,
    })
  },

  renameSession: async (id, title) => {
    const res = await apiPatch<{ session: Session }>(`/api/sessions/${id}`, { title })
    set((s) => {
      const sessions = s.sessions.map((x) => (x.id === id ? { ...x, ...res.session } : x))
      return { sessions, current: pickCurrent(sessions, s.currentId, s.current) }
    })
  },

  removeSession: async (id) => {
    await apiDelete(`/api/sessions/${id}`)
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== id)
      const dropping = s.currentId === id
      return {
        sessions,
        current: pickCurrent(sessions, dropping ? undefined : s.currentId, s.current),
        ...(dropping
          ? {
              currentId: undefined,
              byId: new Map(),
              order: [],
              structureKey: '',
              streamingCount: 0,
              sessionStats: new Map(),
            }
          : {}),
      }
    })
  },

  /** M79-D：隐藏会话（仅本人列表；DM「删除」语义——新消息自动复现） */
  hideSession: async (id) => {
    await apiPost(`/api/sessions/${id}/hide`)
    await get().loadSessions()
    if (get().currentId === id) void get().selectSession(undefined)
  },

  noteIncoming: (sessionId, message) =>
    set((s) => {
      const sessions = s.sessions.map((x) =>
        x.id === sessionId
          ? {
              ...x,
              lastMessage: {
                role: message.role,
                ...(message.agentId ? { agentId: message.agentId } : {}),
                ...(message.memberKey ? { memberKey: message.memberKey } : {}),
                content: message.content,
                createdAt: message.createdAt,
                ...(message.userId ? { userId: message.userId } : {}),
              },
            }
          : x,
      )
      // 预览为易变字段：current 投影保持引用，订阅方不随跨会话预览刷屏重渲染
      return { sessions, current: pickCurrent(sessions, s.currentId, s.current) }
    }),

  upsertMessage: (message) =>
    set((s) => {
      if (message.sessionId !== s.currentId) return s // 跨会话流式事件守卫
      const clean = withCleanContent(message)
      // M55：生成开始（turn:start 复用消息 id，如续写 / 重生成）时重置流式原始缓冲
      if (clean.role === 'agent' && clean.status === 'streaming') rawStreams.set(clean.id, clean.content)
      const existing = s.byId.get(message.id)
      const byId = new Map(s.byId)
      const merged = existing ? { ...existing, ...clean } : clean
      byId.set(clean.id, merged)
      // ---- 增量派生维护 ----
      let structureKey = s.structureKey
      let streamingCount = s.streamingCount
      let sessionStats = s.sessionStats
      const token = structTokenOf(merged)
      const memberKey = merged.role === 'agent' && merged.agentId ? (merged.memberKey ?? merged.agentId) : undefined
      if (existing) {
        const idx = s.order.indexOf(message.id)
        if (idx >= 0 && structTokens[idx] !== token) {
          structTokens = [...structTokens]
          structTokens[idx] = token
          structureKey = structTokens.join('|')
        }
        const wasStreaming = existing.status === 'streaming'
        const isStreaming = merged.status === 'streaming'
        if (wasStreaming && !isStreaming) streamingCount--
        else if (!wasStreaming && isStreaming) streamingCount++
        if (memberKey) {
          const dArtifacts = (merged.artifacts?.length ?? 0) - (existing.artifacts?.length ?? 0)
          sessionStats = statBump(sessionStats, memberKey, 0, dArtifacts)
        }
        if (existing.status === 'streaming' && merged.status !== 'streaming') rawStreams.delete(merged.id)
        if (merged.status !== 'streaming') {
          return { byId, structureKey, streamingCount, sessionStats, completedTick: s.completedTick + 1 }
        }
        return { byId, structureKey, streamingCount, sessionStats }
      }
      structTokens.push(token)
      structureKey = structureKey ? `${structureKey}|${token}` : token
      if (merged.status === 'streaming') streamingCount++
      if (memberKey) sessionStats = statBump(sessionStats, memberKey, 1, merged.artifacts?.length ?? 0)
      if (merged.status !== 'streaming') {
        return {
          byId,
          order: [...s.order, message.id],
          structureKey,
          streamingCount,
          sessionStats,
          completedTick: s.completedTick + 1,
        }
      }
      return { byId, order: [...s.order, message.id], structureKey, streamingCount, sessionStats }
    }),

  applyReadReceipt: (sessionId, userId, lastReadSeq) =>
    set((s) => {
      if (s.currentId !== sessionId) return s
      const idx = s.memberReads.findIndex((m) => m.userId === userId)
      if (idx >= 0 && s.memberReads[idx].lastReadSeq >= lastReadSeq) return s // 单调推进，回退忽略
      const next = [...s.memberReads]
      if (idx >= 0) next[idx] = { userId, lastReadSeq }
      else next.push({ userId, lastReadSeq })
      return { memberReads: next }
    }),

  patchMessage: (id, patch) =>
    set((s) => {
      const existing = s.byId.get(id)
      if (!existing) return s
      // M55：回合收尾（置为非 streaming）后释放该消息的流式原始缓冲
      if (patch.status && patch.status !== 'streaming') rawStreams.delete(id)
      const byId = new Map(s.byId)
      const merged = { ...existing, ...patch }
      byId.set(id, merged)
      // ---- 增量派生维护 ----
      let structureKey = s.structureKey
      let streamingCount = s.streamingCount
      let sessionStats = s.sessionStats
      const token = structTokenOf(merged)
      const idx = s.order.indexOf(id)
      if (idx >= 0 && structTokens[idx] !== token) {
        structTokens = [...structTokens]
        structTokens[idx] = token
        structureKey = structTokens.join('|')
      }
      const wasStreaming = existing.status === 'streaming'
      const isStreaming = merged.status === 'streaming'
      if (wasStreaming && !isStreaming) streamingCount--
      else if (!wasStreaming && isStreaming) streamingCount++
      const memberKey = merged.role === 'agent' && merged.agentId ? (merged.memberKey ?? merged.agentId) : undefined
      if (memberKey && patch.artifacts) {
        const dArtifacts = (merged.artifacts?.length ?? 0) - (existing.artifacts?.length ?? 0)
        sessionStats = statBump(sessionStats, memberKey, 0, dArtifacts)
      }
      if (merged.status !== 'streaming') {
        return { byId, structureKey, streamingCount, sessionStats, completedTick: s.completedTick + 1 }
      }
      return { byId, structureKey, streamingCount, sessionStats }
    }),

  appendDelta: (id, delta) =>
    set((s) => {
      const existing = s.byId.get(id)
      if (!existing) return s
      const byId = new Map(s.byId)
      if (existing.role !== 'agent') {
        byId.set(id, { ...existing, content: existing.content + delta })
        return { byId }
      }
      // M55：对原始累积全文求净化（幂等；已净化文本不可作为缓冲续接——块锚点会丢失）
      const raw = (rawStreams.get(id) ?? existing.content) + delta
      rawStreams.set(id, raw)
      byId.set(id, { ...existing, content: sanitizeModelText(raw) })
      return { byId }
    }),

  appendReasoning: (id, delta) =>
    set((s) => {
      const existing = s.byId.get(id)
      if (!existing) return s
      const byId = new Map(s.byId)
      byId.set(id, { ...existing, reasoning: (existing.reasoning ?? '') + delta })
      return { byId }
    }),

  removeMessage: (id) =>
    set((s) => {
      if (!s.byId.has(id)) return s
      const removed = s.byId.get(id)!
      const byId = new Map(s.byId)
      byId.delete(id)
      const idx = s.order.indexOf(id)
      if (idx >= 0) {
        structTokens = [...structTokens]
        structTokens.splice(idx, 1)
      }
      let streamingCount = s.streamingCount
      let sessionStats = s.sessionStats
      if (removed.status === 'streaming') streamingCount--
      if (removed.role === 'agent' && removed.agentId) {
        sessionStats = statBump(sessionStats, removed.memberKey ?? removed.agentId, -1, -(removed.artifacts?.length ?? 0))
      }
      return {
        byId,
        order: s.order.filter((x) => x !== id),
        structureKey: structTokens.join('|'),
        streamingCount,
        sessionStats,
        completedTick: s.completedTick + 1,
      }
    }),

  bumpArtifacts: () => set((s) => ({ artifactVersion: s.artifactVersion + 1 })),

  setLatestRun: (run) => set({ latestRun: run }),
}))

/**
 * `current` 投影对账：action 内已同步维护；此处兜底「直接 setState」的写入路径
 * （测试 / 调试工具 / 未来新 action 漏维护）——next 与 prev 引用一致时不再 set，天然终止。
 */
useSessionStore.subscribe((s) => {
  const next = pickCurrent(s.sessions, s.currentId, s.current)
  if (next !== s.current) useSessionStore.setState({ current: next })
})
